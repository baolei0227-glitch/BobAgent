/**
 * team-run —— chat 内置「多智能体协作」编排器（宿主侧闭环）。
 *
 * 背景：Agent Teams（bob-team-mcp）已提供团队/成员/任务/质量门禁的完整编排原语，但入口是
 * 22 个 mcp__team__* 工具——主 agent 要自己串「建团队 → 规划 → 等用户确认 → 派任务 → 轮询 →
 * 回收」。这些裸工具现已**不再注入模型**，team_run 是模型侧的唯一入口（画布团队面板/观察节点已退役）。
 *
 * 本模块把这条链收敛为**一次工具调用**：主 agent 负责编排（给出 goal + 成员清单 + 任务 DAG），
 * 宿主负责执行闭环（create → plan → 用户审批 → approve → 轮询至终态 → collect），过程中把每个
 * 成员的实时进度以 onProgress 回调外推（route 转 SSE subagent_update 帧），最终把各成员产出汇总成一段
 * 文本作为工具结果回灌主 agent，由主 agent 整合成一条回答 —— 与 Grok 多 agent 的对外形态一致
 * （用户只看到一条回答 + 可展开的分支过程），但实现是外部编排（N 个独立 /api/chat 会话）。
 *
 * 成员间消息（宿主中转）：成员各自是 /api/chat 会话、拿不到 mcp__team__* 工具，两端都由宿主代理——
 * 启动时用一条广播把「留言协议」写进成员邮箱（approve 前入箱，成员每次唤醒都会读到），成员在产出里用
 * [[msg to=<成员名|m1|all>]]…[[/msg]] 声明留言，宿主轮询时解析并 msg_send 给目标成员邮箱，
 * 对方下次被唤醒时读到。语义与本引擎原生的「唤醒边界投递」一致（异步、非实时）。
 *
 * 上游产出注入下游（引擎侧闭环）：依赖结果随上游 done 落 task.result，下游任务被认领唤醒时由引擎
 * 直接把「已完成祖先产出」注入成员任务书（[已完成的上游依赖产出] 段，对齐 dsh 原版
 * collectCompletedDependencyOutputs + formatDependencyOutputs）。宿主**不再代投**依赖产出——
 * 轮询粒度永远慢于引擎的认领瞬间，代投必然发生在下游已被唤醒之后（验证版曾据此丢失产出）。
 *
 * 设计约束：
 *   - 成员间留言走宿主中转（引擎无「成员→成员」工具）：投递经 msg_send——其 from 固定为
 *     captain，故正文统一加「〔成员「X」留言〕」前缀标明真实来源。
 *   - 人类审批门禁（策略档位驱动）：团队规划完成（成员清单 + 任务 DAG 已 plan）、approve 之前，按
 *     approvalStrategy 经 decideTeamApproval 裁决（见 approval.ts）——ask 档把草案交宿主弹窗等用户
 *     批准，approved 才 approve & run，denied/timeout 一律 team_discard 作废草案并收口（不启动调度
 *     器、不留下 planning 态僵尸团队）；never 档在入口直接拒绝（不建团队）；allow_scope 档（默认）
 *     不打断用户，宿主持草案直接 approve，与既有行为一致。ask 档下 onConfirm 未注入（非 route 工具
 *     轮调用，如单测/脚本）视为自动批准，不阻断非交互路径。
 *   - 主 agent 负责编排：成员的 name/role/identity 与任务的 assignee/dependencies 由主 agent
 *     在 team_run 入参里给出，宿主不做二次 LLM 规划（成本可控、行为可预期）。
 */

/** 成员分支/面板结构与前端共用（前端收敛分支卡片 + .md RMETA 持久化都读同一份定义） */
import type { SubagentBranch, SubagentPanel, TeamChatEvent } from '@/lib/types';
/** 团队 MCP 信道（就绪性检查 / 调用 / 解析）：与团队工作台 /api/team/* 共用同一份实现 */
import { callTeamTool, ensureTeamReady, relayMemberNote, sendCaptainNote } from '@/lib/chat/team-client';
/** 门禁裁决类型（与工具确认挂起容器同源：approved / denied / timeout 三分） */
import type { ConfirmVerdict } from '@/lib/chat/confirm-pending';
/** 多智能体门禁的过程级裁决 + 策略档位（与 tool_confirm 咨询点同源，见 approval.ts） */
import { decideTeamApproval } from '@/lib/chat/approval';
import type { ApprovalStrategy } from '@/lib/chat/approval';
/** 队长会话（编排 agent 实体化）：宿主自调 /api/chat 驱动规划与复核/整合，零工具 */
import {
  CAPTAIN_PLAN_TIMEOUT_MS,
  CAPTAIN_REVIEW_TIMEOUT_MS,
  buildCaptainFollowupMessages,
  buildCaptainPlanMessages,
  buildCaptainReviewMessages,
  callCaptainOnce,
  parseCaptainJson,
  validateCaptainPlan,
} from '@/lib/chat/captain-session';
import type { CaptainMessage } from '@/lib/chat/captain-session';

/** 单个成员的条目（对齐 team_plan 的 members 入参） */
export interface TeamRunMemberSpec {
  name: string;
  role?: string;
  /** BobWork Agent identity（已安装的 market agent id）；省略 = 作为默认 chat agent 运行 */
  identity?: string;
  effort?: 'low' | 'medium' | 'high';
  modelRef?: string;
}

/** 单个任务条目（对齐 team_plan 的 tasks 入参） */
export interface TeamRunTaskSpec {
  subject: string;
  /** 成员 name（非 id）；省略则由空闲成员自由认领 */
  assignee?: string;
  /** 依赖的任务 subject（必须先完成） */
  dependencies?: string[];
}

/** 成员级进度（外推给前端的分支卡片数据）——结构即前端渲染/持久化共用的 SubagentBranch */
export type TeamRunMemberProgress = SubagentBranch;

/** 一次进度快照（route 转 SSE subagent_update）——结构即前端折叠面板共用的 SubagentPanel */
export type TeamRunProgress = SubagentPanel;

/** 待审批的团队草案（门禁展示用：团队已 plan、尚未 approve；members/tasks 为最终清单） */
export interface TeamRunDraft {
  teamId: string;
  goal: string;
  members: TeamRunMemberSpec[];
  tasks: TeamRunTaskSpec[];
  /** 名单外补充成员的名字（用户在弹窗选定的成员名单之外的成员）：非空即表示这是「AI 推荐补充」
   *  触发的审批，前端据此在确认卡上单独点名 */
  extraMemberNames?: string[];
  /** 用户名单里被弃用的成员 id（AI 的最终方案没有指派他们）：非空即表示 AI 改动了用户选定的名单，
   *  前端据此在确认卡上点名「弃用」，避免用户以为名单被原样采纳 */
  droppedMemberIds?: string[];
}

export interface TeamRunOptions {
  goal: string;
  /** 触发本次协作的**用户原始提问**（宿主从本轮对话里取，原样不加工）：随 team_plan 落进 draft →
   *  approve 时写进 team_start 事件 meta，工作台的群聊流据此渲染右侧「我的发言」气泡。
   *  刻意用原文而不是 goal：goal 是主 agent 转述过的目标，且已显示在 Run started 行里 */
  questionText?: string;
  /** 兼容路径：显式给出的成员清单（单测/脚本直调）。与 tasks 同时非空时**跳过队长规划**，
   *  行为与既有逐位一致；正常 route 路径留空，成员由队长（captain）规划产出 */
  members?: TeamRunMemberSpec[];
  /** 兼容路径：显式给出的任务 DAG（单测/脚本直调）。见 members */
  tasks?: TeamRunTaskSpec[];
  /** 队长模型（provider:modelId）：Team 分栏「Main model」显式选择，负责规划与复核/整合 */
  captainModelRef?: string;
  /** 成员模型（provider:modelId）：Team 分栏「Worker model」显式选择，**一刀切覆盖**全部成员 */
  workerModelRef?: string;
  /** 项目上下文（透传队长会话的 /api/chat） */
  projectId?: string;
  /** 本次成员名单段（route 已算好的 multiAgentRosterSection 文本，交给队长参考；可省略） */
  rosterSection?: string;
  /** 总预算（毫秒）：超时即以当前已完成产出收口，不再等待剩余任务。起点是**用户批准之后**，
   *  用户思考/审批耗时不计入团队执行预算 */
  budgetMs?: number;
  /** 轮询间隔（毫秒） */
  pollMs?: number;
  /** 进度外推回调（route 转 SSE）：p 为逐帧全量快照（分支卡片），events 为**本次新增**的
   *  「群聊流」增量事件（可能为空数组）——两者同帧下发，前端各自累积渲染 */
  onProgress?: (p: TeamRunProgress, events?: TeamChatEvent[]) => void;
  /** 审批策略档位（route 按 identity 级覆盖 > 全局默认 注入，与 tool_confirm 咨询点同一取值）：
   *  allow_scope（缺省）= 不打断用户直接 approve & run；ask = 挂起等用户批准；never = 入口直接拒绝 */
  approvalStrategy?: ApprovalStrategy;
  /** 本次执行的成员名单（用户在 chat 节点「Multi-agent mode」弹窗选定的已安装 agent id，不落盘）：
   *  非 undefined 时启用「名单外补充成员必须用户批准」——成员里凡 identity 不在名单内（含未指定
   *  identity 的默认 chat 成员）都视为 AI 临时补充，即便策略档位是 allow_scope 也要先弹卡请用户裁决。
   *  undefined（非 route 交互路径、单测）= 不做此判定，行为与既有逐位一致 */
  presetAgentIds?: string[];
  /** 人类审批门禁：ask 档在团队规划完成、approve 之前调用，宿主在此弹确认卡等用户裁决（route 转
   *  SSE team_confirm 帧，回传走 POST /api/chat/confirm）。返回 approved 才 approve & run；
   *  denied/timeout 一律作废草案收口。未注入 = 自动批准（非交互调用路径） */
  onConfirm?: (draft: TeamRunDraft) => Promise<ConfirmVerdict>;
  /** 请求中断信号（客户端断开即停止轮询） */
  signal?: AbortSignal;
}

export interface TeamRunOutcome {
  ok: boolean;
  /** 回灌主 agent 的汇总文本（成功/失败/超时均有可读文案） */
  summary: string;
  /** 最后一次进度快照（route 可用于收口前端卡片） */
  progress: TeamRunProgress | null;
}

const DEFAULT_BUDGET_MS = 8 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;
/** 单个成员产出写入汇总的字符上限（防个别成员长文挤爆主 agent 上下文） */
const PER_RESULT_CAP = 4000;
/** 汇总总字符上限 */
const TOTAL_CAP = 24000;
/** 「群聊流」事件里的正文上限（成员产出摘要 / 成员间留言）：只作过程叙述，完整产出仍在汇总文本里 */
const EVENT_TEXT_CAP = 600;
/** 队长条目（点评 / 整合稿）的正文上限：比成员摘要长一些（要放得下整合稿），引擎侧另有 2000 硬上限 */
const CAPTAIN_NOTE_TEXT_CAP = 1500;
/** 队长条目「群里那句话」上限：一行口语，长了就不像人话（引擎侧另有 200 硬上限） */
const CAPTAIN_LINE_CAP = 200;
/** 队长追问复核的最大轮次（防无限对质烧上下文）：每轮 = 投递追问 → 等成员作答 → 再复核 */
const MAX_FOLLOWUP_ROUNDS = 2;
/** 单轮追问等待成员作答的上限（毫秒）：成员被消息唤醒后通常数十秒内回应 */
const FOLLOWUP_WAIT_MS = 2 * 60 * 1000;
/** 队长在 subagent 面板里的固定分支 id（前端按此渲染「队长」轨迹卡片） */
const CAPTAIN_BRANCH_ID = 'captain';

/** 成员产出里的留言标记：[[msg to=m2]]内容[[/msg]]（to 支持成员名 / m1 式成员 id / all，逗号分隔） */
const MEMBER_MSG_RE = /\[\[msg\s+to=([^\]]+)\]\]([\s\S]*?)\[\[\/msg\]\]/gi;

/** 下发给成员的留言协议：一条广播（to:'all'）入箱，approve 前投递。宿主不改 bob-team-mcp，
 *  直消息是唯一能进入成员 prompt 的通道；广播不会被标记送达 → 每个任务唤醒都会重申本协议。 */
const MEMBER_MSG_PROTOCOL = `[团队协作协议 · 成员间留言]
你可以给同伴留话，宿主会自动投递。用法：
1) 在回答末尾写留言块（可写多条）：[[msg to=<目标>]]留言内容[[/msg]]
2) <目标> 填同伴的成员名或成员 id（如 m2），多个用英文逗号分隔；填 all = 广播给全体同伴。
3) 投递是异步的：留言先进对方邮箱，对方**下次被唤醒**时才读到（对方正在执行任务时不会被实时打断）。
4) 只写对同伴有用的硬信息：结论、接口/数据格式约定、必须遵守的约束、发现的风险、需要对方承接的输入。
   不要用它汇报自己的进度、不要客套、不要复述任务背景。
5) 你的正文产出照常写在留言块之外，留言块不算任务产出。
另外：你在任务开头如果看到「[来自团队的直消息]」段落，那就是同伴给你的留言。宿主代投的消息
显示为 (captain)，真实来源看正文的「〔成员「X」留言〕」前缀。
依赖产出无需你操心：若你的任务有上游依赖，任务书里会直接带「[已完成的上游依赖产出]」段，
那是引擎注入的上游成果，当作输入材料承接即可，不要在产出里复述它。`;

/** 留言块解析结果：messages 为声明的留言（已从正文剥离），output 为剥离后的正文 */
interface MemberMessages {
  messages: Array<{ targets: string[]; text: string }>;
  output: string;
}

/** 从成员产出中挖出留言块并剥离（正文回灌主 agent 时不含协议噪音）。
 *  标记：[[msg to=m2]]内容[[/msg]]（to 支持成员名 / m1 式成员 id / all，逗号分隔） */
function extractMemberMessages(raw: unknown): MemberMessages {
  const text = typeof raw === 'string' ? raw : '';
  const messages: Array<{ targets: string[]; text: string }> = [];
  MEMBER_MSG_RE.lastIndex = 0;
  for (const m of text.matchAll(MEMBER_MSG_RE)) {
    const targets = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const body = m[2].trim();
    if (targets.length > 0 && body) messages.push({ targets, text: body });
  }
  const output = text.replace(MEMBER_MSG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { messages, output };
}

/** 留言目标 → 合法成员 id：支持成员名、m1 式 id、all。all 由宿主展开为逐条单发——广播 to:'all'
 *  不会被调度器标记送达（bob-team-mcp 只标记 to === memberId），会在成员每次唤醒时重复注入。
 *  未知目标与发给自己的留言一律丢弃（返回空数组 = 无人可投）。 */
function resolveTargets(raw: string[], nameToId: Map<string, string>, selfId: string): string[] {
  const ids = new Set(nameToId.values());
  const out = new Set<string>();
  for (const t of raw) {
    const key = t.trim();
    if (!key) continue;
    if (key.toLowerCase() === 'all') {
      for (const id of ids) if (id !== selfId) out.add(id);
      continue;
    }
    const id = nameToId.get(key) ?? (ids.has(key) ? key : '');
    if (!id || id === selfId) continue;
    out.add(id);
  }
  return [...out];
}

/** 成员名 ↔ id 映射。team_plan 的 draft.assignee 用成员名，approve 物化后 Task.assignee 是成员 id，
 *  而 result_collect 又把 assignee 回写成成员名——中转两端都需要这张表做解析。 */
function memberMaps(panel: Record<string, unknown>): {
  nameToId: Map<string, string>;
  idToName: Map<string, string>;
} {
  const list = Array.isArray(panel.members) ? (panel.members as Array<Record<string, unknown>>) : [];
  const nameToId = new Map<string, string>();
  const idToName = new Map<string, string>();
  for (const m of list) {
    const id = String(m.id ?? '');
    const nm = String(m.name ?? '');
    if (!id) continue;
    if (nm) nameToId.set(nm, id);
    idToName.set(id, nm || id);
  }
  return { nameToId, idToName };
}

/** 宿主中转：把成员产出里声明的留言投递到目标成员邮箱（fresh = 本轮新完成的任务 id）。
 *  成员是独立 /api/chat 会话、拿不到 mcp__team__* 工具，故「声明 → 解析 → 投递」两端都由宿主代理；
 *  投递走 msg_send + from_member——引擎按它写邮箱来源前缀（成员侧语义不变），并在事件流里把真实来源
 *  记进 meta.actor（from 仍为 captain），故工作台群聊流显示的是成员 → 成员。
 *  返回 delivered 为**成功投递**的明细（真实来源成员名 → 目标成员名 + 留言原文），
 *  供会话内「群聊流」事件外推（from 用真实来源而非 captain）。 */
async function relayMemberMessages(
  teamId: string,
  collected: Array<{ task: string; assignee?: string; result?: unknown }>,
  fresh: Set<string>,
  nameToId: Map<string, string>,
  idToName: Map<string, string>,
): Promise<{
  relayed: number;
  warnings: string[];
  delivered: Array<{ from: string; to: string; text: string }>;
}> {
  let relayed = 0;
  const warnings: string[] = [];
  const delivered: Array<{ from: string; to: string; text: string }> = [];
  for (const c of collected) {
    if (!fresh.has(c.task)) continue;
    const { messages } = extractMemberMessages(c.result);
    if (messages.length === 0) continue;
    const selfId = c.assignee ? (nameToId.get(c.assignee) ?? '') : '';
    const selfName = (selfId ? idToName.get(selfId) : '') || c.assignee || '成员';
    for (const msg of messages) {
      const targets = resolveTargets(msg.targets, nameToId, selfId);
      if (targets.length === 0) {
        warnings.push(`成员「${selfName}」的留言目标无法解析（${msg.targets.join('、')}），已丢弃`);
        continue;
      }
      for (const to of targets) {
        try {
          // 引擎侧按 from_member 自行写来源前缀（邮箱正文不变），事件流则记真实来源（meta.actor）——
          // 故宿主这里不再手写「〔成员「X」留言〕」，工作台群聊流才能显示「X → Y」而非「captain → Y」。
          await relayMemberNote(teamId, selfName, to, msg.text);
          relayed++;
          delivered.push({ from: selfName, to: idToName.get(to) ?? to, text: msg.text });
        } catch (e) {
          warnings.push(`转发成员「${selfName}」的留言失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  return { relayed, warnings, delivered };
}

/** 面板状态 → 进度快照（成员×任务按 assignee/currentTaskId 关联，成员视角展示分支卡片）。
 *  队长的过程轨迹作为**面板首行**一并展示（复用同一 SubagentBranch 结构，无 taskId）。 */
function toProgress(
  panel: Record<string, unknown>,
  ctx: TeamRunCtx,
): TeamRunProgress {
  const tasks = Array.isArray(panel.tasks) ? (panel.tasks as Array<Record<string, unknown>>) : [];
  const members = Array.isArray(panel.members) ? (panel.members as Array<Record<string, unknown>>) : [];
  const taskById = new Map(tasks.map((t) => [String(t.id), t]));
  const now = Date.now();
  const rows: TeamRunMemberProgress[] = members.map((m) => {
    const currentTaskId = m.currentTaskId ? String(m.currentTaskId) : undefined;
    // 成员当前任务优先；空闲成员回落到名下最近一个任务（保持卡片有内容且稳定）
    const task =
      (currentTaskId ? taskById.get(currentTaskId) : undefined) ??
      tasks.find((t) => String(t.assignee ?? '') === String(m.id));
    const tStatus = task ? String(task.status ?? '') : '';
    let state: TeamRunMemberProgress['state'] = 'queued';
    if (tStatus === 'done') state = 'done';
    else if (tStatus === 'failed') state = 'failed';
    else if (tStatus === 'running' || tStatus === 'claimed') state = 'running';
    const taskId = task ? String(task.id) : undefined;
    let startAt: number | undefined;
    let endAt: number | undefined;
    if (taskId && state === 'running' && !ctx.startedAt.has(taskId)) ctx.startedAt.set(taskId, now);
    if (taskId) startAt = ctx.startedAt.get(taskId);
    if (taskId && (state === 'done' || state === 'failed')) {
      endAt = typeof task?.lastActivityAt === 'number' ? (task.lastActivityAt as number) : now;
      if (!startAt) startAt = endAt;
    }
    return {
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      role: String(m.role ?? ''),
      state,
      taskId,
      subject: task ? String(task.subject ?? '') : undefined,
      progressText: task?.progressText ? String(task.progressText) : undefined,
      startAt,
      endAt,
      durationMs: startAt && endAt ? Math.max(0, endAt - startAt) : undefined,
      error: task?.error ? String(task.error) : undefined,
    };
  });
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const all = ctx.withCaptain ? [captainBranch(ctx), ...rows] : rows;
  return {
    teamId: String(panel.teamId ?? '') || ctx.teamId,
    goal: ctx.goal,
    done,
    total: tasks.length,
    failed,
    members: all,
  };
}

/** 队长分支（面板首行）：反映「规划 → 等成员 → 复核/追问 → 整合」的进行态 */
function captainBranch(ctx: TeamRunCtx): TeamRunMemberProgress {
  return {
    id: CAPTAIN_BRANCH_ID,
    name: 'Captain',
    role: 'Planning · review · synthesis',
    state: ctx.captainState,
    subject: ctx.captainSubject,
    ...(ctx.captainError ? { error: ctx.captainError } : {}),
  };
}

/** 「群聊流」事件 diff：把逐帧全量快照转成增量时间线（形态 A 呈现层）。
 *  只观测成员状态迁移（queued → running → done/failed）——这是宿主在轮询期唯一能可靠看到的变化；
 *  产出摘要与留言投递在同一轮询tick 由 result_collect / 中转环节补充进同一批事件。 */
function diffMemberEvents(
  panel: TeamRunProgress,
  seen: Map<string, SubagentBranch['state']>,
  summaries?: Map<string, string>,
): TeamChatEvent[] {
  const out: TeamChatEvent[] = [];
  const at = Date.now();
  for (const m of panel.members) {
    // 队长分支只在面板展示（分支卡片首行），不进入「群聊流」时间线，避免首帧冒出 captain 的 member_start 噪音
    if (m.id === CAPTAIN_BRANCH_ID) continue;
    const prev = seen.get(m.id);
    if (prev === m.state) continue;
    seen.set(m.id, m.state);
    // 首次见到即 queued（尚未开工）不算一次发言；其余迁移各产出对应事件
    if (prev === undefined && m.state === 'queued') continue;
    if (m.state === 'running') {
      out.push({ kind: 'member_start', at, memberId: m.id, name: m.name, subject: m.subject });
    } else if (m.state === 'done') {
      out.push({
        kind: 'member_done',
        at,
        memberId: m.id,
        name: m.name,
        subject: m.subject,
        summary: summaries?.get(m.name),
      });
    } else if (m.state === 'failed') {
      out.push({ kind: 'member_failed', at, memberId: m.id, name: m.name, subject: m.subject, error: m.error });
    }
  }
  return out;
}

/** 宿主侧共享上下文：把 emit / 事件缓冲 / 去重表等跨阶段状态收进一个对象，供 openTeam / awaitTeam 复用 */
interface TeamRunCtx {
  goal: string;
  budgetMs: number;
  pollMs: number;
  /** 执行预算截止时刻（用户批准后赋值；0 = 尚未批准） */
  deadline: number;
  /** 是否展示队长分支（兼容路径 = false：无队长参与，面板只列成员） */
  withCaptain: boolean;
  startedAt: Map<string, number>;
  pendingEvents: TeamChatEvent[];
  seenStates: Map<string, SubagentBranch['state']>;
  relayedTasks: Set<string>;
  freshTasks: Set<string>;
  relayedCount: number;
  relayWarnings: string[];
  maps: ReturnType<typeof memberMaps>;
  /** 最近一次引擎面板（重发快照 / 追问基线时无需再查一次 team_status） */
  lastPanel: Record<string, unknown>;
  /**
   * 本次 run 的团队 id：建队成功即赋值（早于 approve）。
   * 面板要等 approve 后才有 teamId（建队时的面板快照里没有这个字段），若只认面板，那么
   * 「待批准 → 未批准收口」的 run **永远不会**把团队绑到节点上 —— 前端一直停在发起界面，
   * 用户看到的就是「协作明明发了，团队面板却还是空的」。故在 openTeam 建队成功后立刻写入本字段并补发一帧。
   */
  teamId: string;
  last: TeamRunProgress | null;
  captainState: SubagentBranch['state'];
  captainSubject: string;
  captainError?: string;
  emit: (p: TeamRunProgress) => void;
  flushEvents: () => void;
}

function createTeamRunCtx(
  opts: TeamRunOptions,
  goal: string,
  budgetMs: number,
  pollMs: number,
  withCaptain: boolean,
): TeamRunCtx {
  const ctx: TeamRunCtx = {
    goal,
    budgetMs,
    pollMs,
    deadline: 0,
    withCaptain,
    startedAt: new Map(),
    pendingEvents: [],
    seenStates: new Map(),
    relayedTasks: new Set(),
    freshTasks: new Set(),
    relayedCount: 0,
    relayWarnings: [],
    maps: { nameToId: new Map(), idToName: new Map() },
    lastPanel: {},
    teamId: '',
    last: null,
    captainState: 'running',
    captainSubject: 'Planning',
    emit: () => {},
    flushEvents: () => {},
  };
  ctx.emit = (p) => {
    ctx.last = p;
    const events =
      ctx.pendingEvents.length > 0 ? ctx.pendingEvents.splice(0, ctx.pendingEvents.length) : undefined;
    try {
      opts.onProgress?.(p, events);
    } catch {
      /* 进度外推失败不影响编排主流程 */
    }
  };
  /** 收口（循环外产生的事件）单独补发一帧：复用最后一份快照，前端按快照覆盖 + 事件累积各自处理 */
  ctx.flushEvents = () => {
    if (ctx.pendingEvents.length === 0 || !ctx.last) return;
    const events = ctx.pendingEvents.splice(0, ctx.pendingEvents.length);
    try {
      opts.onProgress?.(ctx.last, events);
    } catch {
      /* 同上 */
    }
  };
  return ctx;
}

/** 用最近一次面板重发一帧快照（队长状态变化时刷新分支卡片） */
function emitCurrent(ctx: TeamRunCtx): void {
  ctx.emit(toProgress(ctx.lastPanel, ctx));
}

/** 面板事件流（截断最近 50 条） */
function panelEvents(panel: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(panel.events) ? (panel.events as Array<Record<string, unknown>>) : [];
}

/** 一轮轮询的「产出回收 + 成员间留言中转」：返回本轮新完成成员的产出摘要（供 member_done 事件） */
async function collectTick(
  teamId: string,
  panel: Record<string, unknown>,
  ctx: TeamRunCtx,
): Promise<{ summaries: Map<string, string>; tickEvents: TeamChatEvent[] }> {
  const panelTaskList = Array.isArray(panel.tasks) ? (panel.tasks as Array<Record<string, unknown>>) : [];
  for (const t of panelTaskList) {
    if (String(t.status ?? '') !== 'done') continue;
    const taskId = String(t.id ?? '');
    const key = `${taskId}:${String(t.attempts ?? 0)}`;
    if (ctx.relayedTasks.has(key)) continue;
    ctx.relayedTasks.add(key);
    ctx.freshTasks.add(taskId);
  }
  const summaries = new Map<string, string>();
  const tickEvents: TeamChatEvent[] = [];
  if (ctx.freshTasks.size > 0) {
    try {
      const res = await callTeamTool('result_collect', { team_id: teamId, task_id: '' });
      if (Array.isArray(res.collected)) {
        const items = res.collected as Array<{ task: string; assignee?: string; result?: unknown }>;
        for (const c of items) {
          if (!c.assignee || !ctx.freshTasks.has(c.task)) continue;
          const body = extractMemberMessages(c.result).output;
          if (body) summaries.set(c.assignee, body.slice(0, EVENT_TEXT_CAP));
        }
        const relayed = await relayMemberMessages(
          teamId,
          items,
          ctx.freshTasks,
          ctx.maps.nameToId,
          ctx.maps.idToName,
        );
        ctx.relayedCount += relayed.relayed;
        ctx.relayWarnings.push(...relayed.warnings);
        // 投递成功的留言 → from 用真实来源成员名（msg_send 的 from 被 MCP 固定为 captain）
        for (const d of relayed.delivered) {
          tickEvents.push({
            kind: 'relay',
            at: Date.now(),
            from: d.from,
            to: d.to,
            text: d.text.slice(0, EVENT_TEXT_CAP),
          });
        }
        // 依赖产出注入由引擎在成员唤醒瞬间完成（不再由宿主代投，见文件头注释）
      }
    } catch {
      /* 中转失败不阻断编排：留言通道本轮降级，成员产出仍照常回收 */
    }
    ctx.freshTasks.clear();
  }
  return { summaries, tickEvents };
}

/** 回收各成员产出（result_collect 已按依赖拓扑顺序返回） */
async function collectAll(
  teamId: string,
): Promise<Array<{ task: string; assignee?: string; result?: unknown; error?: string }>> {
  try {
    const res = await callTeamTool('result_collect', { team_id: teamId, task_id: '' });
    if (Array.isArray(res.collected)) {
      return res.collected as Array<{ task: string; assignee?: string; result?: unknown; error?: string }>;
    }
  } catch {
    /* 回收失败不致命：至少回灌进度快照 */
  }
  return [];
}

/** 成员产出 → 队长复核用的摘要文本（按依赖序拼接；留言块剥离；单条/总量双上限） */
function buildMemberDigest(
  collected: Array<{ task: string; assignee?: string; result?: unknown }>,
  followupAnswers?: Array<{ name: string; text: string }>,
): string {
  const blocks: string[] = [];
  let totalLen = 0;
  const push = (block: string): boolean => {
    if (totalLen + block.length > TOTAL_CAP) return false;
    totalLen += block.length;
    blocks.push(block);
    return true;
  };
  for (const c of collected) {
    // 留言块已在轮询中转时投递，此处剥离后再回灌（协议噪音不进队长上下文）
    const body =
      typeof c.result === 'string'
        ? extractMemberMessages(c.result).output
        : c.result === undefined || c.result === null
          ? ''
          : JSON.stringify(c.result, null, 2);
    const trimmed =
      body.length > PER_RESULT_CAP ? `${body.slice(0, PER_RESULT_CAP)}\n…（产出过长已截断）` : body;
    if (!push(`### 任务 ${c.task}${c.assignee ? ` · 成员 ${c.assignee}` : ''}\n${trimmed || '（无产出文本）'}`)) break;
  }
  for (const a of followupAnswers ?? []) {
    const trimmed =
      a.text.length > PER_RESULT_CAP ? `${a.text.slice(0, PER_RESULT_CAP)}\n…（作答过长已截断）` : a.text;
    if (!push(`### 成员 ${a.name} 的追问作答\n${trimmed || '（无输出）'}`)) break;
  }
  return blocks.length > 0 ? blocks.join('\n\n') : '（未回收到任何已完成任务的产出。）';
}

/** 队长的「派发」条目正文：谁做什么、依赖什么（成员名与任务标题保持原样，固定文案用英文） */
function buildDispatchText(members: TeamRunMemberSpec[], tasks: TeamRunTaskSpec[]): string {
  const lines = [
    `Dispatched ${tasks.length} task${tasks.length === 1 ? '' : 's'} to ${members.length} member${
      members.length === 1 ? '' : 's'
    }:`,
  ];
  for (const t of tasks) {
    const who = t.assignee ? `${t.assignee} — ` : '';
    const deps = t.dependencies && t.dependencies.length > 0 ? ` (after: ${t.dependencies.join(', ')})` : '';
    lines.push(`- ${who}${t.subject}${deps}`);
  }
  return lines.join('\n');
}

/** 取「一句话」（压平空白、截到第一个句末标点）：队长口语行与前端回退共用同一口径 */
function oneLiner(text: string): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const m = flat.match(/^[^。！？.!?]*[。！？.!?]/);
  const sentence = (m ? m[0] : flat).trim();
  return sentence.length > CAPTAIN_LINE_CAP ? `${sentence.slice(0, CAPTAIN_LINE_CAP - 1)}…` : sentence;
}

/** 队长条目落地：写引擎事件流（落盘，刷新/重启后仍在）+ 同步外推进本轮会话流（chat 侧分支卡片）。
 *  观测写入失败一律静默 —— 少一条队长条目，协作照常。
 *  line = 群里那句「人话」（队长说了什么），text 仍是完整正文（展开可见）。 */
async function emitCaptainNote(
  ctx: TeamRunCtx,
  teamId: string,
  note: { stage: string; text: string; line?: string; memberId?: string; taskId?: string; targets?: string[] },
): Promise<void> {
  const text = note.text.slice(0, CAPTAIN_NOTE_TEXT_CAP);
  const line = (note.line ?? '').trim().slice(0, CAPTAIN_LINE_CAP);
  try {
    await sendCaptainNote(teamId, { ...note, text, ...(line ? { line } : {}) });
  } catch {
    /* 观测写入失败不阻断编排 */
  }
  ctx.pendingEvents.push({
    kind: 'captain',
    at: Date.now(),
    stage: note.stage,
    text,
    ...(line ? { line } : {}),
    ...(note.memberId ? { memberId: note.memberId } : {}),
    ...(note.taskId ? { taskId: note.taskId } : {}),
    ...(note.targets && note.targets.length > 0 ? { targets: note.targets } : {}),
  });
}

/** 队长逐成员点评（复核轮的 notes 字段）→ 每条一个 captain 条目，挂到对应成员 */
async function emitCaptainReviewNotes(
  ctx: TeamRunCtx,
  teamId: string,
  raw: Record<string, unknown> | null,
): Promise<void> {
  for (const n of parseCaptainNotes(raw)) {
    const memberId = ctx.maps.nameToId.get(n.member) ?? '';
    await emitCaptainNote(ctx, teamId, {
      stage: 'review',
      text: n.note,
      line: `Reviewed ${n.member} — ${oneLiner(n.note)}`,
      ...(memberId ? { memberId } : {}),
      targets: [n.member],
    });
  }
}

interface CaptainPlanOutcome {
  ok: boolean;
  error?: string;
  members: TeamRunMemberSpec[];
  tasks: TeamRunTaskSpec[];
  /** 规划阶段的完整会话（含纠正重试轮），供复核阶段复用缓存前缀 */
  messages: CaptainMessage[];
  /** 队长最后一次的原始输出（作为复核会话的 assistant 轮，保持前缀一致） */
  planText: string;
}

/** 阶段①：队长规划（成员 + 任务 DAG）。JSON 解析/校验失败追加一条 user 纠正消息重试 1 次。 */
async function planWithCaptain(
  opts: TeamRunOptions,
  ctx: TeamRunCtx,
  captainModelRef: string,
): Promise<CaptainPlanOutcome> {
  const messages = buildCaptainPlanMessages(ctx.goal, opts.rosterSection);
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callCaptainOnce(messages, {
      modelRef: captainModelRef,
      projectId: opts.projectId,
      signal: opts.signal,
      timeoutMs: CAPTAIN_PLAN_TIMEOUT_MS,
    });
    if (res.error) {
      lastError = res.error;
      messages.push({ role: 'user', content: `上一次调用失败：${res.error}。请直接输出规划 JSON。` });
      continue;
    }
    const raw = parseCaptainJson(res.text);
    if (!raw) {
      lastError = '队长输出不是合法 JSON';
      messages.push(
        { role: 'assistant', content: res.text },
        {
          role: 'user',
          content:
            '你的输出不是合法 JSON。请只输出一个 JSON 对象（members/tasks），不要任何解释文字或代码围栏。',
        },
      );
      continue;
    }
    const plan = validateCaptainPlan(raw);
    if ('error' in plan) {
      lastError = plan.error;
      messages.push(
        { role: 'assistant', content: res.text },
        { role: 'user', content: `规划不合法：${plan.error}。请修正后只输出 JSON。` },
      );
      continue;
    }
    return { ok: true, members: plan.members, tasks: plan.tasks, messages, planText: res.text };
  }
  return {
    ok: false,
    error: lastError || '队长未能在 2 次尝试内给出合法规划',
    members: [],
    tasks: [],
    messages,
    planText: '',
  };
}

/** 阶段②：建团队 → 规划 → 下发留言协议 → 人类审批门禁 → 批准启动。
 *  返回 ok:false 时 summary 为可读收口文案（不抛异常）；批准后把成员名↔id 映射写进 ctx。 */
async function openTeam(
  opts: TeamRunOptions,
  ctx: TeamRunCtx,
  members: TeamRunMemberSpec[],
  tasks: TeamRunTaskSpec[],
  teamApproval: ReturnType<typeof decideTeamApproval>,
  presetIds: string[] | null,
): Promise<{ ok: boolean; summary?: string; teamId?: string }> {
  const goal = ctx.goal;
  const ready = await ensureTeamReady();
  if (!ready.ok) return { ok: false, summary: ready.error ?? 'Agent Teams 不可用。' };

  // 名单外补充成员（AI 临时补人）：用户弹窗选定的名单 presetAgentIds 之外的成员——包含 identity
  // 不属于名单的，以及未指定 identity（默认 chat 画像）的。名单存在（含空名单）时，只要有补充成员，
  // 即便策略档位是 allow_scope 也强制走审批门禁：临时成员必须用户放行，不允许静默扩编。
  const extraMembers = presetIds
    ? members.filter((m) => !m.identity || !presetIds.includes(m.identity))
    : [];
  // 被弃用的名单成员（最终方案没有指派他们）：名单是软约束——允许只用名单内的一部分成员，
  // 但**名单一旦被改动就必须让用户看见**，故与补充成员一样触发审批门禁，由确认卡点名「弃用/补充」。
  const droppedMemberIds = presetIds
    ? presetIds.filter((id) => !members.some((m) => m.identity === id))
    : [];

  const name = goal.length > 24 ? `${goal.slice(0, 24)}…` : goal;
  // 兜底作废凭据：建队之后、approve 成功之前，任何异常退出都必须把草案作废（见 catch）。
  // 少了这层，任何一处意外抛出都会在引擎里留下永不推进的 planning 团队：成员/任务不物化，
  // 工作台只剩一个空壳（「只有队长第一步、后续全空」即由此而来），且它会一直被面板订阅空转。
  let createdTeamId: string | null = null;
  let approved = false;
  try {
    // ① 建团队
    // project_id（本节点所属项目）：随团队落盘 → 成员会话带项目上下文执行，产物落进项目
    // homework/（群聊流的文件卡片即可用 project 方式打开，也能在项目侧栏看到）
    const created = await callTeamTool('team_create', {
      name,
      goal,
      ...(opts.projectId ? { project_id: opts.projectId } : {}),
    });
    const teamId = String(created.team_id ?? '');
    if (!teamId) throw new Error('team_create 未返回 team_id');
    createdTeamId = teamId;
    // 建队即绑定：立刻把 teamId 写进上下文并补发一帧，前端据此把团队登记到本节点。
    // 不能等 approve 后由面板带回 —— 「待批准 → 拒绝/超时」的 run 到不了那一步，团队会永远绑不上节点，
    // 团队面板就停在发起界面（协作已经发出，面板却看不到任何东西）。
    ctx.teamId = teamId;
    emitCurrent(ctx);
    // ② 规划（成员清单 + 任务 DAG 由队长阶段① 给出，宿主不做二次规划）
    await callTeamTool('team_plan', {
      team_id: teamId,
      goal,
      members,
      tasks,
      // 用户原始提问随 draft 走（approve 时进 team_start meta）：回看历史 run 也不会错位
      ...(opts.questionText ? { question: opts.questionText } : {}),
    });
    // ③ 下发「成员间留言」协议（用广播 to:'all'，且必须在 approve 之前入箱）
    //    - approve 拿到锁后立即 `void pump()` 异步调度，协议晚于 approve 就可能赶不上成员首个任务
    //      （而多数团队成员只有一个任务）→ 故先入箱；
    //    - 广播匹配每名成员却不会被标记送达，因此每个任务唤醒都会重申协议——对「协议」是优点
    //      （成员每轮都记得可以留话），对「成员之间的留言」则相反（故中转时把 all 展开为逐条单发）。
    try {
      await callTeamTool('msg_send', { team_id: teamId, to: 'all', text: MEMBER_MSG_PROTOCOL });
    } catch {
      /* 协议下发失败不阻断编排：留言通道降级为不可用，成员产出照常汇总 */
    }
    // ④ 人类审批门禁（策略档位驱动，见 approval.ts decideTeamApproval；另有「名单改动」强制触发）：
    //    草案（成员清单 + 任务 DAG）已 plan 好，需审批时交用户裁决后才 approve
    //    - approved → 落到 ⑤ 真正启动调度器；
    //    - denied / timeout → 不启动：先 team_discard 作废草案（否则团队停在 planning 态、成员与任务
    //      永不物化，留下僵尸团队），再返回 ok:false + 区分「拒绝」与「超时未操作」的可读文案；
    //    - onConfirm 未注入（非 route 工具轮调用）→ 自动批准，不阻断非交互路径。
    //    门禁通道异常按未批准收口（不放行未经确认的团队）。
    const needApproval =
      teamApproval === 'request' || extraMembers.length > 0 || droppedMemberIds.length > 0;
    if (needApproval && opts.onConfirm) {
      let verdict: ConfirmVerdict = 'denied';
      try {
        verdict = await opts.onConfirm({
          teamId,
          goal,
          members,
          tasks,
          extraMemberNames: extraMembers.map((m) => m.name),
          droppedMemberIds,
        });
      } catch {
        /* 门禁通道异常 → 保持 denied */
      }
      if (verdict !== 'approved') {
        try {
          await callTeamTool('team_discard', { team_id: teamId });
        } catch (e) {
          // 作废失败不阻断收口，但必须留痕：否则引擎里留一个 planning 僵尸团队，
          // 现象是「工作台只有一个空壳团队、面板一直空转」，排查时无从下手。
          console.warn('[team-run] team_discard 失败，草案可能残留在 planning:', e);
        }
        return {
          ok: false,
          summary:
            verdict === 'timeout'
              ? '多智能体协作未启动：等待用户审批团队方案超时（用户可能不在场）。请如实告知用户该方案尚未执行，并询问是否需要重新发起。'
              : '多智能体协作未启动：用户未批准该团队方案（草案已作废，未创建任何成员或任务）。请询问用户希望如何调整团队成员或任务分工后重新发起。',
        };
      }
    }
    // ⑤ 批准并启动——approve 会物化成员/任务并启动调度器（异步推进）
    // 队长「派发」条目**必须在 approve 之前**落盘：approve 内部会 void pump() 唤醒成员，
    // 而 pump 与随后的 await 之间存在竞态——实测成员开工事件会抢在派发之前几毫秒（群聊流读成
    // 「成员已开工 → 队长才派活」）。此处门禁已放行（denied/timeout 在上文已 return），
    // 故「已批准 → 队长派发 → 协作启动 → 成员开工」顺序成立。观测写入失败静默，不阻断协作。
    await emitCaptainNote(ctx, teamId, {
      stage: 'dispatch',
      text: buildDispatchText(members, tasks),
      line: `Split the work into ${tasks.length} task${tasks.length === 1 ? '' : 's'} across ${members.length} member${
        members.length === 1 ? '' : 's'
      }.`,
      targets: members.map((m) => m.name),
    });
    await callTeamTool('team_approve', { team_id: teamId });
    approved = true; // 已 approve：此后不再走兜底作废（作废会打断正在推进的调度器）
    ctx.deadline = Date.now() + ctx.budgetMs;
    // ⑥ 取面板拿到 成员名↔id 映射（approve 只回计数；成员 id 是中转投递与追问的落点键）
    ctx.lastPanel = await callTeamTool('team_status', { team_id: teamId });
    ctx.maps = memberMaps(ctx.lastPanel);
    // 调度器已启动：先播报「协作启动」（成员清单 + 任务数），随下一次轮询帧一并送达前端
    ctx.pendingEvents.push({
      kind: 'team_start',
      at: Date.now(),
      goal,
      memberNames: members.map((m) => m.name),
      taskCount: tasks.length,
    });
    return { ok: true, teamId };
  } catch (e) {
    // 兜底作废：建了队但还没 approve 就异常退出（门禁通道异常、上游抛错、超时等），
    // 一律作废草案 —— 未 approve 的草案不会启动调度器，作废它零副作用，却能保证引擎里
    // 不留 planning 僵尸团队（否则工作台会一直列出/订阅一个永远不会产出内容的空壳）。
    if (createdTeamId && !approved) {
      try {
        await callTeamTool('team_discard', { team_id: createdTeamId });
      } catch (e2) {
        console.warn('[team-run] 异常收口时 team_discard 失败，草案可能残留在 planning:', e2);
      }
    }
    return { ok: false, summary: `多智能体协作启动失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 阶段③：轮询至全部任务终态（done/failed）或超预算 / 客户端断开。期间逐帧外推进度与群聊流事件。 */
async function awaitTeam(
  opts: TeamRunOptions,
  ctx: TeamRunCtx,
  teamId: string,
): Promise<{ ok: boolean; summary?: string; timedOut: boolean }> {
  let timedOut = false;
  for (;;) {
    if (opts.signal?.aborted) {
      return {
        ok: false,
        summary: '多智能体协作被中断（本轮对话已取消），已停止等待成员产出。',
        timedOut: false,
      };
    }
    let panel: Record<string, unknown>;
    try {
      panel = await callTeamTool('team_status', { team_id: teamId });
    } catch (e) {
      return {
        ok: false,
        summary: `多智能体协作状态查询失败：${e instanceof Error ? e.message : String(e)}`,
        timedOut: false,
      };
    }
    ctx.lastPanel = panel;
    // 成员间留言中转：本轮新完成的任务 → 回收产出 → 解析 [[msg]] → 逐条投递给目标成员邮箱
    // （放在 emit 之前：同一 tick 内先拿到产出，才能给「成员完成」事件附上产出摘要）
    const { summaries, tickEvents } = await collectTick(teamId, panel, ctx);
    // 本帧进度外推：成员状态迁移（含刚拿到的产出摘要）与留言投递事件同批下发
    const snapshot = toProgress(panel, ctx);
    ctx.pendingEvents.push(...diffMemberEvents(snapshot, ctx.seenStates, summaries), ...tickEvents);
    ctx.emit(snapshot);

    if (panel.terminal === true) break;
    if (Date.now() >= ctx.deadline) {
      timedOut = true;
      break;
    }
    await new Promise((r) => setTimeout(r, ctx.pollMs));
  }
  return { ok: true, timedOut };
}

/** 从队长复核输出里取出追问清单（member + question，最多 3 条） */
function parseCaptainFollowups(
  raw: Record<string, unknown> | null,
): Array<{ member: string; question: string }> {
  if (!raw || !Array.isArray(raw.followups)) return [];
  const out: Array<{ member: string; question: string }> = [];
  for (const item of raw.followups) {
    const o = (item ?? {}) as Record<string, unknown>;
    const member = typeof o.member === 'string' ? o.member.trim() : '';
    const question = typeof o.question === 'string' ? o.question.trim() : '';
    if (member && question) out.push({ member, question });
  }
  return out.slice(0, 3);
}

/** 从队长复核输出里取出逐成员点评（notes: member + note）；模型偶尔不给则返回空数组（不阻断复核） */
function parseCaptainNotes(
  raw: Record<string, unknown> | null,
): Array<{ member: string; note: string }> {
  if (!raw || !Array.isArray(raw.notes)) return [];
  const out: Array<{ member: string; note: string }> = [];
  for (const item of raw.notes) {
    const o = (item ?? {}) as Record<string, unknown>;
    const member = typeof o.member === 'string' ? o.member.trim() : '';
    const note = typeof o.note === 'string' ? o.note.trim() : '';
    if (member && note) out.push({ member, note });
  }
  return out;
}

/** 把队长的追问投递到目标成员邮箱（成员名 → 成员 id），并外推 relay 事件。
 *  baseline = 投递前已有的事件 id 集合：追问作答只认之后新出现的事件。 */
async function askFollowups(
  teamId: string,
  followups: Array<{ member: string; question: string }>,
  ctx: TeamRunCtx,
): Promise<{ targetIds: Set<string>; summary: string; baseline: Set<string> }> {
  const baseline = new Set<string>();
  for (const e of panelEvents(ctx.lastPanel)) {
    const id = typeof e.id === 'string' ? e.id : '';
    if (id) baseline.add(id);
  }
  const targetIds = new Set<string>();
  const lines: string[] = [];
  for (const f of followups) {
    const id = ctx.maps.nameToId.get(f.member) ?? '';
    if (!id) {
      ctx.relayWarnings.push(`追问对象「${f.member}」无法解析为成员，已跳过`);
      continue;
    }
    try {
      // 发送方已是 captain：不再手写「〔队长追问〕」前缀（事件流按 from=Captain 显示，前缀只是噪音）
      await callTeamTool('msg_send', { team_id: teamId, to: id, text: f.question });
      targetIds.add(id);
      lines.push(`- 已追问 ${f.member}：${f.question}`);
      ctx.pendingEvents.push({
        kind: 'relay',
        at: Date.now(),
        from: 'Captain',
        to: f.member,
        text: f.question.slice(0, EVENT_TEXT_CAP),
      });
    } catch (e) {
      ctx.relayWarnings.push(
        `向成员「${f.member}」投递追问失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { targetIds, summary: lines.join('\n'), baseline };
}

/** 等待被追问的成员作答。成员「消息唤醒」的作答**不进 result_collect**（邮箱不回填），
 *  唯一通道是事件流里 meta.wake='message' 的 member_done / member_failed（正文已按 4000 字截断）。 */
async function awaitFollowupAnswers(
  teamId: string,
  targetIds: Set<string>,
  baseline: Set<string>,
  ctx: TeamRunCtx,
  signal?: AbortSignal,
): Promise<Map<string, { name: string; text?: string; error?: string }>> {
  const answers = new Map<string, { name: string; text?: string; error?: string }>();
  const deadline = Date.now() + FOLLOWUP_WAIT_MS;
  for (;;) {
    if (signal?.aborted) break;
    let panel: Record<string, unknown>;
    try {
      panel = await callTeamTool('team_status', { team_id: teamId });
    } catch {
      break;
    }
    ctx.lastPanel = panel;
    for (const e of panelEvents(panel)) {
      const id = typeof e.id === 'string' ? e.id : '';
      if (id) {
        if (baseline.has(id)) continue;
        baseline.add(id);
      }
      const kind = String(e.kind ?? '');
      if (kind !== 'member_done' && kind !== 'member_failed') continue;
      const meta = e.meta && typeof e.meta === 'object' ? (e.meta as Record<string, unknown>) : {};
      if (String(meta.wake ?? '') !== 'message') continue;
      const memberId = String(e.memberId ?? '');
      if (!memberId || !targetIds.has(memberId) || answers.has(memberId)) continue;
      const name = String(e.memberName ?? memberId);
      const text = String(e.text ?? '');
      answers.set(memberId, kind === 'member_failed' ? { name, error: text } : { name, text });
      ctx.pendingEvents.push(
        kind === 'member_failed'
          ? { kind: 'member_failed', at: Date.now(), memberId, name, error: text }
          : {
              kind: 'member_done',
              at: Date.now(),
              memberId,
              name,
              summary: text.slice(0, EVENT_TEXT_CAP),
            },
      );
    }
    if (answers.size >= targetIds.size) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, ctx.pollMs));
  }
  return answers;
}

/**
 * 执行一次完整的多智能体协作闭环（队长编排）：
 *   阶段① 队长规划（成员 + 任务 DAG）→ 阶段② 建团队/审批/启动 → 阶段③ 轮询收口
 *   → 阶段④ 队长复核（有界追问循环）→ 整合稿作为工具结果回灌主 agent。
 * 任何一步失败都返回 ok:false + 可读文案（不抛异常），由调用方作为工具结果回灌主 agent。
 */
export async function runTeam(opts: TeamRunOptions): Promise<TeamRunOutcome> {
  const goal = String(opts.goal ?? '').trim();
  if (!goal) return { ok: false, summary: '缺少 goal（团队目标），未启动协作。', progress: null };

  const budgetMs = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : DEFAULT_BUDGET_MS;
  const pollMs = opts.pollMs && opts.pollMs > 0 ? opts.pollMs : DEFAULT_POLL_MS;
  const captainModelRef = String(opts.captainModelRef ?? '').trim();
  const workerModelRef = String(opts.workerModelRef ?? '').trim();

  // 兼容路径：显式给出 members + tasks（单测/脚本直调）→ 跳过队长规划，行为与既有逐位一致
  const presetMembers = Array.isArray(opts.members) ? opts.members : [];
  const presetTasks = Array.isArray(opts.tasks) ? opts.tasks : [];
  const usePreset = presetMembers.length > 0 && presetTasks.length > 0;

  // 一主一次两个模型（Team 分栏显式选择；只读模型池与自身 frontmatter，绝不回写节点模型）
  if (!usePreset && !captainModelRef) {
    return {
      ok: false,
      summary:
        '多智能体协作未启动：未指定队长模型（Main model）。请先在 Team 分栏选择「Main model」后重试。',
      progress: null,
    };
  }
  if (!workerModelRef) {
    return {
      ok: false,
      summary:
        '多智能体协作未启动：未指定成员模型（Worker model）。请先在 Team 分栏选择「Worker model」后重试。',
      progress: null,
    };
  }

  // 审批策略（route 按 identity 级覆盖 > 全局默认 注入，缺省 allow_scope）决定门禁形态：
  //   allow → 不打断用户，宿主持草案直接 approve & run（默认档，行为与既有逐位一致）；
  //   request → approve 之前把草案（成员清单 + 任务 DAG）交用户审批；
  //   deny → 入口收口：不建团队、不 plan，零 MCP 副作用（团队记录都不产生）。
  const teamApproval = decideTeamApproval(opts.approvalStrategy ?? 'allow_scope');
  if (teamApproval === 'deny') {
    return {
      ok: false,
      summary:
        '多智能体协作未启动：当前审批策略为 never（禁止自动执行写类/编排类操作），team_run 被拒绝，未创建任何团队与任务。请如实告知用户；若确需运行，需由用户调整审批策略（设置 → 审批策略）。',
      progress: null,
    };
  }

  const presetIds = Array.isArray(opts.presetAgentIds) ? opts.presetAgentIds : null;
  const ctx = createTeamRunCtx(opts, goal, budgetMs, pollMs, !usePreset);
  /** 成员模型一刀切：队长 schema 不含 modelRef，规划出的成员统一覆盖为次模型 */
  const applyWorkerModel = (list: TeamRunMemberSpec[]): TeamRunMemberSpec[] =>
    list.map((m) => ({ ...m, modelRef: workerModelRef }));

  // 阶段①：队长规划（队长分支先亮起）
  let members: TeamRunMemberSpec[];
  let tasks: TeamRunTaskSpec[];
  let planMessages: CaptainMessage[] = [];
  let planText = '';
  if (usePreset) {
    members = applyWorkerModel(presetMembers);
    tasks = presetTasks;
  } else {
    emitCurrent(ctx);
    const planned = await planWithCaptain(opts, ctx, captainModelRef);
    if (!planned.ok) {
      ctx.captainState = 'failed';
      ctx.captainSubject = 'Planning failed';
      ctx.captainError = planned.error ?? '队长规划失败';
      emitCurrent(ctx);
      ctx.flushEvents();
      return {
        ok: false,
        summary: `多智能体协作未启动：${planned.error ?? '队长规划失败'}。未创建任何团队与任务。`,
        progress: ctx.last,
      };
    }
    members = applyWorkerModel(planned.members);
    tasks = planned.tasks;
    planMessages = planned.messages;
    planText = planned.planText;
  }

  // 阶段②：建团队 → 审批门禁 → 启动
  ctx.captainSubject = 'Awaiting members';
  const opened = await openTeam(opts, ctx, members, tasks, teamApproval, presetIds);
  if (!opened.ok || !opened.teamId) {
    ctx.captainState = 'failed';
    ctx.captainSubject = 'Team setup failed';
    if (opened.summary) ctx.captainError = opened.summary;
    emitCurrent(ctx);
    ctx.flushEvents();
    return { ok: false, summary: opened.summary ?? '多智能体协作启动失败。', progress: ctx.last };
  }
  const teamId = opened.teamId;

  // 阶段③：轮询至终态（或超预算/中断）
  const awaited = await awaitTeam(opts, ctx, teamId);
  if (!awaited.ok) {
    ctx.captainState = 'failed';
    ctx.captainSubject = 'Interrupted';
    if (awaited.summary) ctx.captainError = awaited.summary;
    emitCurrent(ctx);
    ctx.flushEvents();
    return { ok: false, summary: awaited.summary ?? '多智能体协作中断。', progress: ctx.last };
  }
  const timedOut = awaited.timedOut;

  // 回收各成员产出（按依赖拓扑顺序）
  const collected = await collectAll(teamId);

  // 阶段④：队长复核（有界追问循环，上限 MAX_FOLLOWUP_ROUNDS 轮）
  ctx.captainSubject = 'Reviewing';
  emitCurrent(ctx);
  let finalText = '';
  let reviewError = '';
  if (!usePreset) {
    let digest = buildMemberDigest(collected);
    let captainMsgs = buildCaptainReviewMessages(planMessages, planText, digest);
    let askedSummary = '';
    for (let round = 0; round <= MAX_FOLLOWUP_ROUNDS; round++) {
      const res = await callCaptainOnce(captainMsgs, {
        modelRef: captainModelRef,
        projectId: opts.projectId,
        signal: opts.signal,
        timeoutMs: CAPTAIN_REVIEW_TIMEOUT_MS,
      });
      if (res.error) {
        reviewError = res.error;
        break;
      }
      const raw = parseCaptainJson(res.text);
      // 队长逐成员点评：无论本轮走追问还是收尾，先把点评落进事件流（工作台群聊流里「队长评价了谁」）
      await emitCaptainReviewNotes(ctx, teamId, raw);
      const final = raw && typeof raw.final === 'string' ? raw.final.trim() : '';
      if (final) {
        finalText = final;
        break;
      }
      const followups = parseCaptainFollowups(raw);
      if (followups.length === 0) {
        reviewError = '队长未给出整合稿，也未给出可执行的追问';
        break;
      }
      if (round >= MAX_FOLLOWUP_ROUNDS) {
        reviewError = '追问轮次已达上限，队长仍未给出整合稿';
        break;
      }
      const asked = await askFollowups(teamId, followups, ctx);
      if (asked.targetIds.size === 0) {
        reviewError = '队长指定的追问对象无法解析为成员';
        break;
      }
      ctx.captainSubject = `Awaiting follow-up (${round + 1}/${MAX_FOLLOWUP_ROUNDS})`;
      emitCurrent(ctx);
      const answers = await awaitFollowupAnswers(teamId, asked.targetIds, asked.baseline, ctx, opts.signal);
      const extra: Array<{ name: string; text: string }> = [];
      for (const a of answers.values()) {
        extra.push({ name: a.name, text: a.text ?? (a.error ? `[失败] ${a.error}` : '（无输出）') });
      }
      askedSummary += (askedSummary ? '\n' : '') + asked.summary;
      digest = buildMemberDigest(collected, extra);
      ctx.captainSubject = 'Reviewing';
      captainMsgs = buildCaptainFollowupMessages(
        [...captainMsgs, { role: 'assistant', content: res.text }],
        askedSummary,
        digest,
      );
      emitCurrent(ctx);
    }
  }

  // 队长整合稿：与 team_done 同为收口条目，但必须排在它**之前**——否则主列里「Run finished」
  // 会出现在队长总结上方，读起来像协作先结束、队长后补话。
  if (finalText) {
    await emitCaptainNote(ctx, teamId, {
      stage: 'synthesis',
      text: finalText,
      line: `Wrapped up — merged ${collected.length} member output${collected.length === 1 ? '' : 's'} into the final answer.`,
    });
  }

  // 「群聊流」收口事件：任务终态统计（前端据此在流末尾渲染协作结束）
  ctx.pendingEvents.push({
    kind: 'team_done',
    at: Date.now(),
    done: ctx.last?.done ?? 0,
    total: ctx.last?.total ?? tasks.length,
    failed: ctx.last?.failed ?? 0,
    timedOut,
  });

  if (finalText) {
    ctx.captainState = 'done';
    ctx.captainSubject = 'Synthesis complete';
    emitCurrent(ctx);
    ctx.flushEvents();
    return { ok: true, summary: finalText, progress: ctx.last };
  }

  // 降级：队长整合不可用（兼容路径 / 复核失败）→ 回灌成员产出原文，由主 agent 收口
  ctx.captainState = usePreset ? 'done' : 'failed';
  ctx.captainSubject = usePreset ? 'Synthesis complete' : 'Review failed';
  if (!usePreset && reviewError) ctx.captainError = reviewError;
  emitCurrent(ctx);
  ctx.flushEvents();

  const head =
    `多智能体协作${timedOut ? '（超出时间预算，提前收口）' : '已完成'}：team ${teamId}，` +
    `成员 ${members.length} 名，任务 ${ctx.last?.total ?? tasks.length} 个，` +
    `成功 ${ctx.last?.done ?? 0} 个，失败 ${ctx.last?.failed ?? 0} 个。`;
  const parts = [head];
  if (ctx.relayedCount > 0) {
    parts.push(`成员间留言：本轮已投递 ${ctx.relayedCount} 条（对方下次被唤醒时读取，属内部协作细节）。`);
  }
  if (ctx.relayWarnings.length > 0) {
    parts.push(`投递异常：${ctx.relayWarnings.join('；')}。`);
  }
  parts.push('以下为各成员的实际产出（按依赖顺序）：', buildMemberDigest(collected));
  if (timedOut) {
    parts.push('注意：部分任务在时间预算内未完成，其产出未包含在上方。');
  }
  const panelMembers = ctx.last?.members.filter((m) => m.id !== CAPTAIN_BRANCH_ID) ?? [];
  const pending = panelMembers.filter((m) => m.state === 'queued' || m.state === 'running');
  if (pending.length > 0) {
    parts.push(
      `仍在进行/未开始的成员：${pending.map((m) => `${m.name}${m.subject ? `（${m.subject}）` : ''}`).join('、')}`,
    );
  }
  for (const f of panelMembers.filter((m) => m.state === 'failed')) {
    parts.push(`成员 ${f.name} 的任务失败：${f.error ?? '未提供错误信息'}`);
  }
  if (!usePreset && reviewError) {
    parts.push(`队长复核未完成（${reviewError}），以下为成员产出原文。`);
  }
  parts.push('请基于以上成员产出整合成一条完整回答直接回复用户（不要罗列内部编排细节）。');

  return { ok: true, summary: parts.join('\n\n'), progress: ctx.last };
}
