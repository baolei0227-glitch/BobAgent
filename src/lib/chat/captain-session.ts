/**
 * captain-session —— 队长会话（编排 agent 实体化）
 *
 * 背景：team 模式原先由**主 agent 兼任编排者**——一轮内既理解需求、又生成 members/tasks、
 * 又把各成员产出全文拉进自己的上下文做整合（单条 4000 字、总量 24000 字），上下文被严重挤压；
 * 且 team_run 是一次性闭环，主 agent 在成员执行期间无法介入，「发现矛盾 → 点名成员说明」没有通道。
 *
 * 本模块把编排者剥离成一个**独立会话「队长（captain）」**：
 *   - 主 agent 退化为「用户代理」：只把需求写成清晰 goal，调用一次 team_run，最后如实转述整合稿；
 *   - 队长用**主模型**（team_main_model）跑：负责规划（成员 + 任务 DAG）与复核/追问/整合；
 *   - 全部成员用**次模型**（team_worker_model）跑：一刀切覆盖，见 team-run.ts 的成员 modelRef 覆盖。
 *
 * 驱动方式（与 @/lib/mcp/ledger-compile 的 invokeCompileSession 同一约定）：宿主自调
 * `${selfBaseUrl()}/api/chat`，读尽 SSE 取最终正文。队长**零工具**——所有长耗时动作
 * （审批门禁、approve、轮询、collect、进度外推）都留在外层 runTeam：因为 onConfirm / onProgress
 * 绑定在外层请求上下文（confirm-pending 的模块级 pendingMap + route 注入），嵌套请求拿不到它们。
 * 队长只做「规划 → 复核 → 整合」这类纯文本推理，恰好不需要工具。
 *
 * 前缀缓存红线（硬约束）：/api/chat 的 system 只含字节稳定的 BASE_SYSTEM_PROMPT，队长规则一律作为
 * **user 消息**注入（绝不进 system）；identity 固定 'chat'，与主 agent / 成员共享同一缓存前缀。
 * 两阶段共用同一 messages 数组（append 形成连续前缀），既是「独立会话」的语义，也让第二阶段
 * 能复用第一阶段的缓存前缀。
 */

import type { TeamRunMemberSpec, TeamRunTaskSpec } from './team-run';

/** 服务端自调用绝对 base（Node fetch 不支持相对路径），与 ledger-compile / daily-tasks 同一约定 */
function selfBaseUrl(): string {
  return `http://localhost:${process.env.PORT || '5000'}`;
}

/** 阶段1（规划）单次调用超时：规划是短推理，给足但不拖沓 */
export const CAPTAIN_PLAN_TIMEOUT_MS = 120_000;
/** 阶段2（复核/整合）单次调用超时：要读全部成员产出，给更长 */
export const CAPTAIN_REVIEW_TIMEOUT_MS = 180_000;

/** 队长会话的一条消息（与 /api/chat 的 messages 同形） */
export interface CaptainMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CaptainCallOpts {
  /** 队长模型（provider:modelId）——来自 Team 分栏的「主模型」选择，必填 */
  modelRef: string;
  /** 项目上下文（透传 /api/chat；缺省不指定） */
  projectId?: string;
  /** 外层请求中断信号（客户端断开 → 队长调用一并中止） */
  signal?: AbortSignal;
  /** 单次调用超时（缺省 CAPTAIN_REVIEW_TIMEOUT_MS） */
  timeoutMs?: number;
}

export interface CaptainCallResult {
  /** 聚合的正文输出（content 增量拼接） */
  text: string;
  error?: string;
}

/** 阶段1：队长规划规则（prepend 到 user 消息，绝不进 system） */
export const CAPTAIN_PLAN_RULES = `## 你是团队的队长（captain），现在只做规划
把一个团队目标拆成**成员清单**与**任务 DAG**，输出给宿主去建团队。要求：
1. **成员 2-5 名**，职责互不重叠；每名成员给 name（短名，如「竞品研究员」）与 role（负责什么、以什么视角工作）。
2. **任务 DAG**：每个任务给 subject（任务标题）、assignee（成员 name）、dependencies（必须先完成的任务 subject 数组，无依赖则省略）。
   彼此独立、可并行的部分才拆成不同任务；有强依赖的用 dependencies 串行。不要为了凑人数拆出重复劳动。
   真实的数据流必须通过 dependencies 表达——下游任务会自动拿到上游已完成任务的产出。
3. 若下方给了「本次成员名单」，**优先**使用名单内成员（用 identity 引用其 id）；名单内能覆盖任务时不要另加成员。
   确需名单外角色时克制补充，并在该成员的 role 里写清为什么必须补。
4. **只输出一个 JSON 对象**，不要任何解释文字、不要 Markdown 代码围栏，格式严格如下：
{"members":[{"name":"成员名","role":"职责","identity":"可选：已安装 Agent 的 id"}],"tasks":[{"subject":"任务标题","assignee":"成员名","dependencies":["上游任务标题"]}]}
注意：不要输出 modelRef、effort 之类字段——成员模型由宿主统一指定。`;

/** 阶段2：队长复核/整合规则（prepend 到 user 消息，绝不进 system） */
export const CAPTAIN_REVIEW_RULES = `## 你是团队的队长（captain），现在做复核与整合
你会看到各成员的实际产出。请**逐项对照原始目标**检查：结论是否互相矛盾、是否有明显遗漏、
是否有成员给出了站不住脚的推断。然后输出**一个 JSON 对象**（不要解释文字、不要代码围栏）——
对象里除下面二选一的主体外，**始终带上 notes**：

{"notes":[{"member":"成员名","note":"一句话点评"}], …主体…}
   - notes 是给用户看的**逐成员点评**：这个人的产出是否站得住、与谁冲突、有什么风险或缺口。
   - 只评你实际看过产出的成员；每人一句话，不复述成员原文、不写客套话。

主体二选一：

1) 需要追问时（确有矛盾或关键遗漏，且问清楚就能改进结论）：
{"followups":[{"member":"成员名","question":"要问他的具体问题"}]}
   - 追问要**具体、可回答**（指出与谁矛盾、缺哪一项、需要他确认什么），不要泛泛地问「再详细点」。
   - 只追问真正影响结论的问题；每个成员最多一条，总数不超过 3 条。
   - 追问投递是异步的：成员会在下次被唤醒时读到你的问题并作答，宿主持你的问题转交。

2) 结论已经够用、或没有值得追问的问题时：
{"final":"整合后的完整回答"}

**整合要求**（写 final 时）：
- 融合成一份**统一、无重复、结论明确**的完整回答，直接面向用户。
- 禁止罗列内部编排细节（团队 id、成员调度、消息往来、谁做了哪个任务），也不要逐段复述成员原文。
- **如实交代缺口**：成员任务失败或超时导致某部分缺失时，在回答里如实说明，禁止编造成员未提供的结论。`;

/** 阶段1 消息：规则 + 目标 +（可选）成员名单段 */
export function buildCaptainPlanMessages(
  goal: string,
  rosterSection?: string,
): CaptainMessage[] {
  const parts = [CAPTAIN_PLAN_RULES, `## 团队目标\n${goal}`];
  if (rosterSection && rosterSection.trim()) parts.push(rosterSection.trim());
  return [{ role: 'user', content: parts.join('\n\n') }];
}

/** 阶段2 消息：在阶段1 的会话前缀上追加「复核规则 + 成员产出摘要」 */
export function buildCaptainReviewMessages(
  prev: CaptainMessage[],
  planJson: string,
  digest: string,
): CaptainMessage[] {
  return [
    ...prev,
    { role: 'assistant', content: planJson },
    { role: 'user', content: `${CAPTAIN_REVIEW_RULES}\n\n## 各成员的实际产出\n${digest}` },
  ];
}

/** 追问轮次的消息：在既有会话前缀上追加「上一轮追问 + 成员作答后的新产出」 */
export function buildCaptainFollowupMessages(
  prev: CaptainMessage[],
  askedSummary: string,
  digest: string,
): CaptainMessage[] {
  return [
    ...prev,
    { role: 'user', content: `## 追问进展\n${askedSummary}\n\n## 各成员的实际产出（含追问后的新作答）\n${digest}` },
  ];
}

/**
 * 起一次队长会话（自调 /api/chat，聚合 SSE 取正文）。
 * 任何失败都返回可读 error（不抛异常），由调用方决定降级或收口。
 */
export async function callCaptainOnce(
  messages: CaptainMessage[],
  opts: CaptainCallOpts,
): Promise<CaptainCallResult> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? CAPTAIN_REVIEW_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const resp = await fetch(`${selfBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages,
        providerModelId: opts.modelRef,
        // 与主 agent / 成员共享缓存前缀（队长规则只在 user 消息里，system 仍字节稳定）
        identity: 'chat',
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { text: '', error: `队长会话 HTTP ${resp.status}${body ? `：${body.slice(0, 200)}` : ''}` };
    }
    if (!resp.body) return { text: '', error: '队长会话返回空响应体' };
    return await consumeCaptainSse(resp.body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = e instanceof Error && e.name === 'AbortError';
    if (timedOut && opts.signal?.aborted) return { text: '', error: '队长会话被中断（本轮对话已取消）' };
    return {
      text: '',
      error: timedOut
        ? `队长会话超时（>${Math.round(timeoutMs / 1000)}s）`
        : `调用队长会话失败：${msg}`,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * 消费 SSE：聚合 content 增量、捕获 error 事件（无显式 done 事件，流 close 即结束）。
 * 帧格式与 chat-adapter 的 consumeSse 同源：data: {"content":"<delta>"} / {"error":"..."}
 */
async function consumeCaptainSse(body: ReadableStream<Uint8Array>): Promise<CaptainCallResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let error: string | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const ev = JSON.parse(payload) as Record<string, unknown>;
          if (typeof ev.content === 'string') text += ev.content;
          if (typeof ev.error === 'string') error = ev.error;
        } catch {
          /* 非 JSON data 帧（注释行等）忽略 */
        }
      }
    }
  }
  return error ? { text, error } : { text };
}

/**
 * 从队长输出里解析 JSON 对象（容错：剥离 Markdown 代码围栏、取最外层 {} 片段）。
 * 解析不出返回 null，由调用方决定是否纠正重试。
 */
export function parseCaptainJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  // 剥离 ```json ... ``` / ``` ... ``` 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export interface CaptainPlan {
  members: TeamRunMemberSpec[];
  tasks: TeamRunTaskSpec[];
}

/**
 * 校验队长给出的规划：成员非空且名字唯一、任务非空且 assignee ∈ 成员、依赖指向已存在的任务 subject、依赖无环。
 * 返回 { error } 表示不可用（调用方据此纠正重试或收口）。
 * 注意：**不接受 modelRef**——成员模型一律由宿主按次模型统一覆盖（见 team-run.ts）。
 */
export function validateCaptainPlan(raw: Record<string, unknown>): CaptainPlan | { error: string } {
  const rawMembers = Array.isArray(raw.members) ? raw.members : [];
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (rawMembers.length === 0) return { error: '规划里没有任何成员' };
  if (rawTasks.length === 0) return { error: '规划里没有任何任务' };

  const members: TeamRunMemberSpec[] = [];
  const names = new Set<string>();
  for (const item of rawMembers) {
    const m = (item ?? {}) as Record<string, unknown>;
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (!name) return { error: '存在没有 name 的成员' };
    if (names.has(name)) return { error: `成员名重复：${name}` };
    names.add(name);
    const role = typeof m.role === 'string' ? m.role.trim() : '';
    const identity = typeof m.identity === 'string' ? m.identity.trim() : '';
    members.push({
      name,
      ...(role ? { role } : {}),
      ...(identity ? { identity } : {}),
    });
  }

  const tasks: TeamRunTaskSpec[] = [];
  const subjects = new Set<string>();
  for (const item of rawTasks) {
    const t = (item ?? {}) as Record<string, unknown>;
    const subject = typeof t.subject === 'string' ? t.subject.trim() : '';
    if (!subject) return { error: '存在没有 subject 的任务' };
    if (subjects.has(subject)) return { error: `任务标题重复：${subject}` };
    subjects.add(subject);
    tasks.push({ subject });
  }
  // 第二遍：assignee / dependencies 需要 subjects 全量可见
  for (let i = 0; i < rawTasks.length; i++) {
    const t = (rawTasks[i] ?? {}) as Record<string, unknown>;
    const assignee = typeof t.assignee === 'string' ? t.assignee.trim() : '';
    if (assignee && !names.has(assignee)) {
      return { error: `任务「${tasks[i].subject}」的 assignee「${assignee}」不在成员清单里` };
    }
    if (assignee) tasks[i].assignee = assignee;
    const deps = Array.isArray(t.dependencies)
      ? t.dependencies.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean)
      : [];
    for (const d of deps) {
      if (!subjects.has(d)) return { error: `任务「${tasks[i].subject}」依赖了不存在的任务「${d}」` };
      if (d === tasks[i].subject) return { error: `任务「${tasks[i].subject}」依赖了自己` };
    }
    if (deps.length > 0) tasks[i].dependencies = deps;
  }
  // 依赖环检测（拓扑排序：无法排空即存在环）
  const indeg = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.subject, t.dependencies?.length ?? 0);
    for (const d of t.dependencies ?? []) {
      const list = edges.get(d) ?? [];
      list.push(t.subject);
      edges.set(d, list);
    }
  }
  const queue = tasks.filter((t) => (indeg.get(t.subject) ?? 0) === 0).map((t) => t.subject);
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    visited++;
    for (const next of edges.get(cur) ?? []) {
      const left = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (visited !== tasks.length) return { error: '任务依赖里存在环' };

  return { members, tasks };
}
