/**
 * team-client —— 宿主侧访问 Agent Teams（bob-team-mcp）MCP 的共享信道。
 *
 * 背景：团队的 21 个 mcp__team__* 裸工具**不注入模型**，宿主侧只有两条通路会调用它们：
 *   1) team_run（lib/chat/team-run.ts）——模型发起的一次性协作闭环；
 *   2) 团队工作台（/api/team/*）——用户对已有团队的观测与干预（第一期：只读 + task_retry + msg_send）。
 * 两条通路共用本模块的「就绪性检查 + 调用 + 结果解析」，避免各自维护一份 MCP 细节。
 *
 * 数据口径：team_status（面板）返回成员/任务/邮箱（截断 50 条）/事件流（截断 50 条）；
 * 成员产出**全文**只存在于任务表，需单独走 result_collect（按依赖拓扑序返回）。
 */

import type {
  TeamDetail,
  TeamEventItem,
  TeamMemberView,
  TeamMessageView,
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

/** 团队 id 清单（引擎按目录扫描，含 planning/已终态团队；归档团队不在其中） */
export async function listTeamIds(): Promise<string[]> {
  const res = await callTeamTool('team_list', {});
  return Array.isArray(res.teams) ? (res.teams as unknown[]).map((x) => String(x)) : [];
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

  const resultsMap = resultsToMap(results ?? []);

  return {
    teamId: str(panel.teamId) || teamId,
    name: str(panel.name),
    goal: str(panel.goal),
    status: str(panel.status),
    createdAt: num(panel.createdAt),
    updatedAt: num(panel.updatedAt),
    approvedAt: typeof panel.approvedAt === 'number' ? panel.approvedAt : null,
    terminal: panel.terminal === true,
    ready: strList(panel.ready),
    members,
    tasks,
    messages,
    ...(events.length > 0 ? { events } : {}),
    ...(results ? { results: resultsMap } : {}),
    cursor: events.length > 0 ? events[events.length - 1].id : null,
  };
}

/** 详情 → 列表概览（团队清单只展示计数，不传成员/任务明细） */
export function summarizeTeam(detail: TeamDetail): TeamSummary {
  const doneCount = detail.tasks.filter((t) => t.status === 'done').length;
  const failedCount = detail.tasks.filter((t) => t.status === 'failed').length;
  return {
    teamId: detail.teamId,
    name: detail.name,
    goal: detail.goal,
    status: detail.status,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    terminal: detail.terminal,
    memberCount: detail.members.length,
    taskCount: detail.tasks.length,
    doneCount,
    failedCount,
  };
}
