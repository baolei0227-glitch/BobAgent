/**
 * team-client —— 宿主侧访问 Agent Teams（bob-team-mcp）MCP 的共享信道。
 *
 * 背景：团队的 22 个 mcp__team__* 裸工具**不注入模型**，宿主侧只有两条通路会调用它们：
 *   1) team_run（lib/chat/team-run.ts）——模型发起的一次性协作闭环；
 *   2) 团队工作台（/api/team/*）——用户对已有团队的观测与干预（第一期：只读 + task_retry + msg_send）。
 * 两条通路共用本模块的「就绪性检查 + 调用 + 结果解析」，避免各自维护一份 MCP 细节。
 *
 * 数据口径：team_status（面板）返回成员/任务/邮箱（截断 50 条）/事件流（截断 200 条）；
 * 成员产出**全文**只存在于任务表，需单独走 result_collect（按依赖拓扑序返回）。
 */

import type {
  TeamDetail,
  TeamEventItem,
  TeamMemberView,
  TeamMessageView,
  TeamPlanDraftView,
  TeamSummary,
  TeamTaskView,
} from '@/lib/types';
// 引擎事件 → 群聊流事件的纯映射：与浏览器端（首屏快照）共用同一份实现
import { num, objOf, str, strList } from '@/lib/chat/team-events';

export { mapEngineEvents } from '@/lib/chat/team-events';

export const TEAM_SERVER_ID = 'team';

/** 从 MCP 工具返回中解析 JSON（兼容裸 JSON / {content:[{type:'text',text}]} 两种形态） */
export function parseToolOutput(raw: string): unknown | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  try {
    const outer = JSON.parse(trimmed);
    if (
      Array.isArray(outer?.content) &&
      outer.content[0]?.type === 'text' &&
      typeof outer.content[0].text === 'string'
    ) {
      try {
        return JSON.parse(outer.content[0].text);
      } catch {
        return { output: outer.content[0].text as string };
      }
    }
    return outer;
  } catch {
    return { output: trimmed };
  }
}

/** 确保 Agent Teams MCP 已启用并连接（插件无需开放额外端口） */
export async function ensureTeamReady(): Promise<{ ok: boolean; error?: string }> {
  const { readSettingsFromFile } = await import('@/lib/settings-server');
  const { mcpManager } = await import('@/lib/mcp/manager');
  const settings = await readSettingsFromFile();
  const serverConfig = (settings.mcpServers || []).find((s) => s.id === TEAM_SERVER_ID);
  if (!serverConfig || !serverConfig.enabled) {
    return { ok: false, error: `Agent Teams MCP 未启用：请在「扩展商店 → MCP 与插件」中开启 ${TEAM_SERVER_ID}` };
  }
  await mcpManager.syncServers(settings.mcpServers);
  return { ok: true };
}

/** 调用一个 mcp__team__* 工具并解析结果（工具侧错误以文本 "Error: …" 返回 → 抛异常） */
export async function callTeamTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { mcpManager } = await import('@/lib/mcp/manager');
  const raw = await mcpManager.callTool(`mcp__${TEAM_SERVER_ID}__${tool}`, args);
  const parsed = parseToolOutput(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Agent Teams 返回异常：${String(raw ?? '').slice(0, 200)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const text = typeof obj.output === 'string' ? obj.output : '';
  if (text.startsWith('Error:') || text.startsWith('Error ')) {
    throw new Error(text.slice(0, 300));
  }
  return obj;
}

/**
 * 全部团队的概览（工作台清单）：一次 team_overview 调用取回所有团队的标量与计数。
 *
 * 早先的写法是「team_list 取 id + 逐个 team_status 拉全量面板再 summarize」：清单只要名字与计数，
 * 却把每个团队的成员/邮箱/事件流全读一遍，开销随团队数 × 明细体积放大（单团队事件流可达上百 KB）。
 * 引擎侧的 team_overview 只读 TeamState 抽标量，故清单退化为单次调用、体积恒定。
 */
export async function listTeamOverviews(): Promise<TeamSummary[]> {
  const res = await callTeamTool('team_overview', {});
  const rows = Array.isArray(res.teams) ? (res.teams as unknown[]) : [];
  return rows
    .map((raw) => {
      const t = objOf(raw);
      return {
        teamId: str(t.teamId),
        name: str(t.name),
        goal: str(t.goal),
        status: str(t.status),
        createdAt: num(t.createdAt),
        updatedAt: num(t.updatedAt),
        terminal: t.terminal === true,
        memberCount: num(t.memberCount),
        taskCount: num(t.taskCount),
        doneCount: num(t.doneCount),
        failedCount: num(t.failedCount),
        planDraft: t.planDraft === true,
      };
    })
    .filter((t) => t.teamId)
    // 最近有动静的排前面
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 团队面板（成员/任务/邮箱/事件流/终态判定） */
export async function teamPanel(teamId: string): Promise<Record<string, unknown>> {
  return callTeamTool('team_status', { team_id: teamId });
}

/** 一次「成员产出全文」回收（按依赖拓扑序，只含 done 任务） */
export async function collectTeamResults(
  teamId: string,
  taskId?: string,
): Promise<Array<{ task: string; assignee?: string; result?: unknown; error?: string }>> {
  const res = await callTeamTool('result_collect', { team_id: teamId, task_id: taskId ?? '' });
  return Array.isArray(res.collected)
    ? (res.collected as Array<{ task: string; assignee?: string; result?: unknown; error?: string }>)
    : [];
}

/** result_collect 的输出 → taskId → 产出全文（非字符串结果 JSON 化，保留可读结构） */
export function resultsToMap(
  list: Array<{ task: string; result?: unknown }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of list) {
    const text = typeof c.result === 'string' ? c.result : c.result == null ? '' : JSON.stringify(c.result, null, 2);
    if (c.task) out[c.task] = text;
  }
  return out;
}

/** 给成员（或 'all' 广播）发一条直消息：空闲成员会被调度器即时唤醒（有信就唤醒） */
export async function sendTeamMessage(teamId: string, to: string, text: string): Promise<void> {
  await callTeamTool('msg_send', { team_id: teamId, to, text });
}

/** 代投一条**成员之间**的留言（fromMember = 真实来源成员名）：邮箱正文由引擎加来源前缀，
 *  事件流用 meta.actor 记真实来源，故工作台群聊流里显示的是成员 → 成员而非 captain → 成员 */
export async function relayMemberNote(
  teamId: string,
  fromMember: string,
  to: string,
  text: string,
): Promise<void> {
  await callTeamTool('msg_send', { team_id: teamId, to, text, from_member: fromMember });
}

/** 队长发言写入引擎事件流（纯观测，不唤醒成员）：工作台群聊流据此呈现队长的派发/点评/追问/整合 */
export async function sendCaptainNote(
  teamId: string,
  note: { stage: string; text: string; line?: string; memberId?: string; taskId?: string; targets?: string[] },
): Promise<void> {
  await callTeamTool('captain_note', {
    team_id: teamId,
    stage: note.stage,
    text: note.text,
    ...(note.line ? { line: note.line } : {}),
    ...(note.memberId ? { member_id: note.memberId } : {}),
    ...(note.taskId ? { task_id: note.taskId } : {}),
    ...(note.targets && note.targets.length > 0 ? { targets: note.targets } : {}),
  });
}

/** 重试一个任务（接管在途 attempt 并回 ready 重调度） */
export async function retryTeamTask(teamId: string, taskId: string): Promise<Record<string, unknown>> {
  return callTeamTool('task_retry', { team_id: teamId, task_id: taskId });
}

// ---------------------------------------------------------------------------
// 面板 → 工作台数据模型（引擎返回的是弱类型 Record，此处一次性收敛成确切类型）
// ---------------------------------------------------------------------------

/**
 * 引擎面板 → 工作台详情。
 * withResults：额外回收「成员产出全文」（面板只回摘要，全文在任务表，须单独走 result_collect）——
 * 只在全量拉取时开，SSE 逐帧带全文会让面板帧体积随产出增长。
 */
export async function buildTeamDetail(
  teamId: string,
  opts?: { withResults?: boolean },
): Promise<TeamDetail> {
  const [panel, results] = await Promise.all([
    teamPanel(teamId),
    opts?.withResults ? collectTeamResults(teamId) : Promise.resolve(null),
  ]);

  const members: TeamMemberView[] = (Array.isArray(panel.members) ? panel.members : []).map((raw) => {
    const m = objOf(raw);
    return {
      id: str(m.id),
      name: str(m.name) || str(m.id),
      role: str(m.role),
      status: str(m.status),
      identity: str(m.identity) || undefined,
      modelRef: str(m.modelRef) || undefined,
      currentTaskId: str(m.currentTaskId) || undefined,
      messageCount: num(m.messageCount),
    };
  });

  const tasks: TeamTaskView[] = (Array.isArray(panel.tasks) ? panel.tasks : []).map((raw) => {
    const t = objOf(raw);
    return {
      id: str(t.id),
      subject: str(t.subject),
      assignee: str(t.assignee) || undefined,
      dependencies: strList(t.dependencies),
      status: str(t.status),
      progressText: str(t.progressText) || undefined,
      attempts: typeof t.attempts === 'number' ? t.attempts : undefined,
      lastActivityAt: typeof t.lastActivityAt === 'number' ? t.lastActivityAt : undefined,
      claimedAt: typeof t.claimedAt === 'number' ? t.claimedAt : undefined,
      finishedAt: typeof t.finishedAt === 'number' ? t.finishedAt : undefined,
      blockedBy: strList(t.blockedBy).length > 0 ? strList(t.blockedBy) : undefined,
      error: str(t.error) || undefined,
      qualityStage: str(t.qualityStage) || undefined,
    };
  });

  const messages: TeamMessageView[] = (Array.isArray(panel.messages) ? panel.messages : []).map((raw) => {
    const m = objOf(raw);
    return {
      id: str(m.id),
      from: str(m.from),
      to: str(m.to),
      text: str(m.text),
      kind: str(m.kind),
      delivered: m.delivered === true,
      createdAt: num(m.createdAt),
    };
  });

  const events = (Array.isArray(panel.events) ? panel.events : []).map((raw) => objOf(raw) as unknown as TeamEventItem);

  // 计划草案（审批之前 / 已被丢弃时仍在）：成员与任务此刻未物化，工作台据此渲染计划分工与用户提问
  const draft = objOf(panel.draft);
  const draftMembers = (Array.isArray(draft.members) ? draft.members : []).map((raw) => {
    const m = objOf(raw);
    return { name: str(m.name), role: str(m.role) || undefined, identity: str(m.identity) || undefined };
  });
  const draftTasks = (Array.isArray(draft.tasks) ? draft.tasks : []).map((raw) => {
    const t = objOf(raw);
    return {
      subject: str(t.subject),
      assignee: str(t.assignee) || undefined,
      dependencies: strList(t.dependencies),
    };
  });
  const planDraft: TeamPlanDraftView | undefined =
    draftMembers.length > 0 || draftTasks.length > 0 || str(draft.question)
      ? { question: str(draft.question) || undefined, members: draftMembers, tasks: draftTasks }
      : undefined;

  const resultsMap = resultsToMap(results ?? []);

  return {
    teamId: str(panel.teamId) || teamId,
    name: str(panel.name),
    goal: str(panel.goal),
    status: str(panel.status),
    createdAt: num(panel.createdAt),
    updatedAt: num(panel.updatedAt),
    approvedAt: typeof panel.approvedAt === 'number' ? panel.approvedAt : null,
    ...(planDraft ? { planDraft } : {}),
    terminal: panel.terminal === true,
    ready: strList(panel.ready),
    // 引擎下发的接管阈值（缺失时 UI 侧有兜底默认值）
    staleMs: typeof panel.staleMs === 'number' ? panel.staleMs : undefined,
    members,
    tasks,
    messages,
    ...(events.length > 0 ? { events } : {}),
    ...(results ? { results: resultsMap } : {}),
    cursor: events.length > 0 ? events[events.length - 1].id : null,
  };
}
