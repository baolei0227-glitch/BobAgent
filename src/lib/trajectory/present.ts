/**
 * P5a-1 事件窗口 schema（渲染未切换，行为不变）
 *
 * 目的：把 ChatNodeKernel SSE 解析区（约 3557-4011）对
 * tool_call / tool_call_update / tool_result / reasoning / content / matchedSkills /
 * context_meter / done / error 各帧的「累积 + upsert」语义固化为一台可单测的
 * 有限状态机（TraceWindowState），供 P5a-2 把轨迹渲染从 messages 派生
 * （conversationTrajectoryItems / assembleTraceSpans）切换到本窗口。P5a-1 仅落地 schema
 * （旁路接入只喂不读）；P5a-2 渲染切换消费（render.ts）。
 *
 * P5a-2 渲染等价补充：span 增加 arguments/success/systemChange/changeSummary、
 * meta 增加 skillDetails —— 均为同帧透传字段（对齐 ChatNodeKernel 对 tool_call /
 * tool_result / matchedSkills / done 各帧的 ToolCallRecord 累积语义），
 * 供 render.ts 派生与「消息快照派生」等价的 ConversationTrajectory 输入。
 *
 * P5b-1 历史 replay（events→窗口），默认行为不变：
 * - eventsToTraceWindow：把落盘事件日志（含 core 结算事件 + SSE 帧）逐条喂入同一窗口，
 *   「查看原始轨迹」= 事件回放 → 复用 windowToTrajectoryItems 渲染到 Trace 分栏。
 * - pushWindowFrame 扩展吸收 core 结算事件（turn/start、user/message、step/start、
 *   assistant/attempt、assistant/message、tool/result、compaction、turn/end）——只在
 *   core 类型上叠加；既有 SSE 帧（tool_call/…/done）行为不变。
 * - 幂等去重：SSE 帧 spanId(uuid) 与 core tool_call_id(call_xxx) 是两个 id 命名空间，
 *   span 用内部别名 toolCallId 桥接，帧/core 先到后到均不重复建 span。
 *
 * 本模块为纯函数：无 React、无 I/O、无全局状态；pushWindowFrame 返回新 state
 * （或基于拷贝原地更新），便于 vitest 直接单测。
 *
 * 与 ChatNodeKernel 现有 upsert 语义的核对（P5 盘点已核，行号以实读为准）：
 * - tool_call        → 建 pending span；无 spanId 用 tool_call_id/id，再兜底 name+seq（3618-3628 push）
 * - tool_call_update → 仅更新 phase/startAt/spanId（running 幂等；heartbeat 重复不虚挂）；
 *                      优先 spanId 精确匹配，fallback 同名最后一个（3715-3745）
 * - tool_result      → 结算 result/durationMs/endAt/phase/kind/summary/cardHtml；
 *                      优先 spanId，fallback 同名未结算 span（3746-3772）
 * - done             → meta.taskId/usage/contextMeter/matchedSkills/doneAt（3892-3933）
 * - error            → 标记（3934-3945）
 * - reasoning/content→ 连续 token 帧不产独立事件，累积到 currentRound 的 reasoningAccum/contentAccum
 * - finishWindow     → 流末把 pending/running 收口 done（等价 4003-4011）
 */

/** 事件窗口内的 span 阶段（贴近 ToolCallRecord.phase / TraceSpan.phase） */
export type TraceWindowPhase = 'pending' | 'running' | 'done' | 'error' | 'skipped';

/**
 * 事件窗口 span：结构贴近 ToolCallRecord + TraceSpan 的必要字段子集。
 * - 工具类 span：toolName/phase/startAt/endAt/durationMs/result/kind/cardHtml/purpose/summary
 * - spanId：服务端下发的稳定 id；无 spanId 时由 tool_call 帧兜底生成（tool_call_id/id/name#seq），保证渲染 key 稳定
 * - status：phase 的展示镜像（均为同串阶段值，供渲染层直接读），与 phase 同步更新
 */
export interface TraceWindowSpan {
  spanId?: string;
  toolName?: string;
  /** 非工具类 span 的展示名（预留；工具 span 通常只填 toolName） */
  name?: string;
  phase: TraceWindowPhase;
  /** phase 的展示镜像（同值），渲染文案层可选 */
  status?: string;
  startAt?: number;
  endAt?: number;
  durationMs?: number;
  result?: string;
  summary?: string;
  /** 工具类别：tool / mcp / skill（tool_result 帧下发） */
  kind?: string;
  cardHtml?: string;
  purpose?: string;
  /** P5a-2 渲染等价：tool_call 帧透传的工具参数（assembleTraceSpans 标题 / 系统变更分类依赖） */
  arguments?: Record<string, unknown>;
  /** P5a-2 渲染等价：与 ToolCallRecord.success 同语义（tool_call 建 span 默认 true，tool_result 覆盖） */
  success?: boolean;
  /** P5a-2 渲染等价：系统变更标记 / 摘要（tool_result 帧透传；写文件 / 装包等轨迹突出行） */
  systemChange?: boolean;
  changeSummary?: string;
  /**
   * P5b-1 幂等去重：core 事件的 tool_call_id（OpenAI call_xxx）与 SSE 帧 spanId(uuid)
   * 是两个 id 命名空间；core attempt 建 span 时以 tool_call_id 为初始 spanId 并保留本别名，
   * SSE tool_call 帧后到则并入（吸收 uuid spanId）——保证「帧建过 core 又来」不双建、
   * core tool/result 可经本别名精确命中结算。
   */
  toolCallId?: string;
  /** P5d 读端：该工具结果被后端压缩（tool_compact 帧命中 → true，渲染"结果已压缩"提示） */
  compacted?: boolean;
}

/** 窗口 meta：整轮任务级信息（done / matchedSkills / context_meter 帧汇聚） */
export interface TraceWindowMeta {
  taskId?: string;
  matchedSkills?: unknown[];
  /** P5a-2 渲染等价：同帧下发的 skillDetails（matchedSkills / done 帧；供 skill_load 行派生） */
  skillDetails?: unknown[];
  usage?: unknown;
  contextMeter?: unknown;
  doneAt?: number;
  /** 交互帧保留（type → 帧值）：coding_phase / questions_request / butler_confirm /
   *  tool_confirm / login_required / grant_required —— 独立保留，供 P5a-2 渲染"待确认/待提问"标记 */
  interactions?: Record<string, unknown>;
  /** P5b-1 历史 replay：用户提问原文（user/message.content；turn/start.userInput 兜底） */
  userText?: string;
  /** P5b-1 历史 replay：compaction 事件原文数组（压缩记忆的 summaryGoal/shadowedTurns/reason…） */
  compactions?: unknown[];
  /** P5d 读端：纠偏/自检帧记录（completion_check / claim_mismatch 帧值，供审计展示） */
  corrections?: unknown[];
  /** P5d 读端：output_files 帧文件卡（最终一次覆盖；供产物展示） */
  outputFiles?: unknown[];
}

/** 事件窗口状态：纯数据，供渲染层 P5a-2 消费 */
export interface TraceWindowState {
  /** 本轮已建工具 span（顺序 = 创建顺序） */
  spans: TraceWindowSpan[];
  meta: TraceWindowMeta;
  /** 当前轮（0 起）。ChatNodeKernel 旁路每轮 doSend 重置窗口 → 恒为 0；为未来多轮窗口预留 */
  currentRound: number;
  /** 当前轮累积的 reasoning token 文本（连续 reasoning 帧拼接） */
  reasoningAccum?: string;
  /** 当前轮累积的正文 token 文本（连续 content 帧拼接；等价 ChatNodeKernel assistantContent） */
  contentAccum?: string;
  /** error 帧标记（值为 payload.error 文本） */
  error?: string;
  /** 内部帧计数：每推入一帧自增 1（帧序分配器）；用于无 spanId 工具兜底 id（name#seq）与帧序诊断 */
  frameCount: number;
}

/** 归一后的窗口事件：一条 SSE 帧（或已归一 TrajectoryEvent 形态）进入状态机前的最小表示 */
export interface TraceWindowEvent {
  /** 事件序号（归一/构造方赋值；normalize 阶段为 0，由 state.frameCount 语义的帧序兜底） */
  seq: number;
  /** 事件类型：SSE 顶层 key（tool_call / tool_result / done ...）或显式 type 字段 */
  type: string;
  /** 事件时间戳 ms（normalize 用 Date.now()；测试可显式传 >0 的 ts 覆盖） */
  ts: number;
  /** 帧载荷：SSE 原帧（首 key=type 的形态）或 {type,payload} 归一形态的 payload */
  payload: Record<string, unknown>;
}

/* ==================== 内部工具 ==================== */

const SPAN_PHASES = new Set<string>(['pending', 'running', 'done', 'error', 'skipped']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function firstKey(rec: Record<string, unknown>): string {
  return Object.keys(rec)[0] ?? '';
}

/** 归一阶段值；非法/缺失 → 回退 fallback */
function normPhase(v: unknown, fallback: TraceWindowPhase): TraceWindowPhase {
  const s = typeof v === 'string' ? v : '';
  return (SPAN_PHASES.has(s) ? s : fallback) as TraceWindowPhase;
}

/** 取帧内嵌套载荷（frame.payload.tool_call / frame.tool_call 两种形态都支持） */
function sub(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = payload[key];
  return isObj(v) ? v : undefined;
}

/* ==================== 归一 ==================== */

/**
 * 把一条 SSE JSON 帧归一为窗口事件。
 * - type 提取：显式 type 字段优先；否则取 payload 首 key（与 eventLog.record 同规则）。
 *   支持三种输入形态：原始 SSE 帧 { tool_call: {...}, nodeId }、
 *   包裹形态 { data: { tool_call: {...} } }、已归一事件形态 { type, payload }。
 * - reasoning/content 连续 token 帧不在此丢弃（产生 type=reasoning/content 的累积标记事件），
 *   由 pushWindowFrame 负责累积——与 eventLog.record 跳过它们不同，窗口需要正文。
 * - 空对象 / 非对象 → null（安全忽略）。
 */
export function normalizeSseFrame(
  frame: { type?: string; data?: unknown } | Record<string, unknown> | null | undefined,
): TraceWindowEvent | null {
  if (!isObj(frame)) return null;
  const rec = frame as Record<string, unknown>;
  const ts = Date.now();
  // 已归一事件形态：type 字段优先，载荷取 payload（否则退回整帧）
  const typeField = str(rec.type);
  if (typeField) {
    const payload = isObj(rec.payload) ? (rec.payload as Record<string, unknown>) : rec;
    return { seq: 0, ts, type: typeField, payload };
  }
  // 包裹形态：{ data: { ... } }
  if (isObj(rec.data)) {
    const inner = rec.data as Record<string, unknown>;
    const t = firstKey(inner);
    if (!t) return null;
    return { seq: 0, ts, type: t, payload: inner };
  }
  // 原始 SSE 帧：首 key = 事件类型，整帧为载荷
  const t = firstKey(rec);
  if (!t) return null;
  return { seq: 0, ts, type: t, payload: rec };
}

/* ==================== 状态机 ==================== */

/** 创建一个空窗口（每轮 doSend 旁路重置入口） */
export function createTraceWindow(): TraceWindowState {
  return { spans: [], meta: {}, currentRound: 0, frameCount: 0 };
}

/**
 * 把一条窗口事件推入状态机（返回新 state；spans/meta/交互桶均浅拷贝后更新，不改原 state）。
 * 语义对齐 ChatNodeKernel SSE 解析区；未识别帧安全忽略（不产 span、不改 meta）。
 */
export function pushWindowFrame(state: TraceWindowState, ev: TraceWindowEvent | null | undefined): TraceWindowState {
  if (!ev || typeof ev.type !== 'string' || !ev.type) return state;
  const payload = isObj(ev.payload) ? ev.payload : {};
  const ts = ev.ts && ev.ts > 0 ? ev.ts : Date.now();
  // 基础拷贝：spans / meta / interactions 各自浅拷贝，各分支就地改这些新对象
  const next: TraceWindowState = {
    ...state,
    frameCount: state.frameCount + 1,
    spans: state.spans.slice(),
    meta: { ...state.meta, interactions: state.meta.interactions ? { ...state.meta.interactions } : undefined },
  };
  // 事件帧序：frameCount 自增（本次进入帧的序号即自增前的 state.frameCount），
  // 由 onToolCall 无 spanId 兜底 id 使用；TraceWindowEvent.seq 保持调用方赋值（旁路场景由 normalize 置 0）

  switch (ev.type) {
    case 'reasoning': {
      const txt = str(payload.reasoning);
      if (txt) next.reasoningAccum = (next.reasoningAccum ?? '') + txt;
      return next;
    }
    case 'content': {
      const txt = str(payload.content);
      if (txt) next.contentAccum = (next.contentAccum ?? '') + txt;
      return next;
    }
    case 'tool_call':
      return onToolCall(next, payload, state.frameCount);
    case 'tool_call_update':
      return onToolCallUpdate(next, payload);
    case 'tool_result':
      return onToolResult(next, payload);
    case 'done':
      return onDone(next, payload, ts);
    case 'error': {
      const msg = str(payload.error);
      if (msg) next.error = msg;
      return next;
    }
    // ---- P5b-1 历史 replay：core 结算事件吸收（与 SSE 帧同窗口喂入，幂等去重） ----
    case 'turn/start': {
      // 兜底：部分日志无 user/message 时以 userInput 呈现用户原文（user/message 后到会覆盖）
      if (str(next.meta.userText) === undefined) {
        const ui = str(payload.userInput);
        if (ui) next.meta.userText = ui;
      }
      return next;
    }
    case 'user/message': {
      const c = str(payload.content);
      if (c !== undefined) next.meta.userText = c;
      return next;
    }
    case 'step/start': {
      // currentRound = 本轮 round（多轮任务的每轮模型请求）；reasoning/content 跨轮继续累积
      const r = payload.round;
      if (typeof r === 'number' && Number.isInteger(r) && r >= 0) next.currentRound = r;
      return next;
    }
    case 'assistant/attempt':
      // 非终答轮：文本（content/reasoning）累积 + toolCalls 建 pending span（与 tool_call 帧互补防双建）
      return onCoreAttempt(next, payload, state.frameCount);
    case 'assistant/message':
      // 终答文本收口：reasoning/content 最终文本入 accum（reasoning 供 think 渲染）
      return onCoreAssistantMessage(next, payload);
    case 'tool/result':
      // core 全文结算：按 tool_call_id/name 结算已建 span 或建完结 span（全文 result=content）
      return onCoreToolResult(next, payload, state.frameCount);
    case 'compaction': {
      const arr = Array.isArray(next.meta.compactions) ? next.meta.compactions.slice() : [];
      arr.push(payload);
      next.meta.compactions = arr;
      return next;
    }
    case 'turn/end':
      // 轮末触发 finishWindow 语义（pending/running span 收口 done；此前无 done 也收口）
      return finishWindow(next);
    case 'matchedSkills': {
      if (Array.isArray(payload.matchedSkills)) next.meta.matchedSkills = payload.matchedSkills;
      // P5a-2 渲染等价：同帧 skillDetails 一并保留（对齐 ChatNodeKernel 3582 的桶写入）
      if (Array.isArray(payload.skillDetails)) next.meta.skillDetails = payload.skillDetails;
      return next;
    }
    case 'context_meter': {
      const v = payload.context_meter;
      if (isObj(v)) next.meta.contextMeter = v;
      return next;
    }
    case 'coding_phase':
    case 'questions_request':
    case 'butler_confirm':
    case 'tool_confirm':
    case 'login_required':
    case 'grant_required': {
      // 记 meta（作为独立交互载荷保留，type → 帧值）
      const val = payload[ev.type];
      if (val !== undefined) {
        const bucket = next.meta.interactions ?? {};
        bucket[ev.type] = val;
        next.meta.interactions = bucket;
      }
      return next;
    }
    // ---- P5d 读端：把其余有帧事件纳入窗口（供审计/产物展示；不影响 spans/渲染等价） ----
    case 'tool_compact': {
      // 结果压缩标记：命中 name 对应最近未结算 span → compacted=true（不新建 span）
      const d = sub(payload, 'tool_compact');
      const cName = str(d?.name) ?? str(payload.name);
      if (cName) {
        for (let i = next.spans.length - 1; i >= 0; i--) {
          const s = next.spans[i];
          if (s.toolName === cName && s.phase !== 'done' && s.phase !== 'error') {
            next.spans[i] = { ...s, compacted: true };
            break;
          }
        }
      }
      return next;
    }
    case 'completion_check':
    case 'claim_mismatch': {
      const val = payload[ev.type] ?? payload;
      const arr = Array.isArray(next.meta.corrections) ? next.meta.corrections.slice() : [];
      arr.push({ type: ev.type, ...(isObj(val) ? (val as Record<string, unknown>) : { value: val }) });
      next.meta.corrections = arr;
      return next;
    }
    case 'output_files': {
      const files = sub(payload, 'output_files') ?? payload;
      const list = Array.isArray(files.files) ? files.files : undefined;
      if (Array.isArray(list)) next.meta.outputFiles = list;
      return next;
    }
    default:
      // 未识别帧 / 已知但窗口不建模的帧（content_truncated / vision_progress / tool_summary /
      // claim_mismatch / completion_check / output_files / bobby_trigger ...）→ 安全忽略
      return next;
  }
}

/* ---------- tool_call：建 pending span（ChatNodeKernel 3618-3628 push 语义） ---------- */

/**
 * P5b-1 幂等去重：core attempt 先建、SSE tool_call 后到时并入同一 span。
 * 匹配顺序：
 * 1. 精确别名：frame spanId/tool_call_id === 既有 span.spanId/toolCallId（帧重复/回流 → 更新不双建）；
 * 2. core 建 span（spanId===toolCallId 或仅 toolCallId 无 spanId）且同名仍 pending/running → 并入
 *    （吸收真实 spanId(uuid)、startAt/purpose/arguments）；
 * 3. 否则新建（原行为）。同名并行（同轮同工具多次）靠「只并入未绑定真实 spanId 的 core span」区分。
 */
function onToolCall(state: TraceWindowState, payload: Record<string, unknown>, seq: number): TraceWindowState {
  const d = sub(payload, 'tool_call');
  const toolName = str(d?.name);
  if (!toolName) return state; // 无法识别工具名 → 忽略
  // 无 spanId 兜底：tool_call_id → id → name#seq（保证并行同名/无 spanId 时渲染 key 稳定）
  const serverSpanId = str(d?.spanId) ?? str(d?.tool_call_id) ?? str(d?.id);
  let idx = -1;
  if (serverSpanId) {
    idx = state.spans.findIndex((s) => s.spanId === serverSpanId || s.toolCallId === serverSpanId);
  }
  if (idx < 0) {
    // core attempt 先建（spanId===toolCallId 或仅 toolCallId）、SSE 帧后到 → 并入吸收真实 spanId
    idx = state.spans.findIndex(
      (s) => s.toolName === toolName
        && (s.phase === 'pending' || s.phase === 'running')
        && !!s.toolCallId
        && (!s.spanId || s.spanId === s.toolCallId),
    );
  }
  if (idx >= 0) {
    const span = state.spans[idx];
    const phase = normPhase(d?.phase, span.phase);
    const updated: TraceWindowSpan = { ...span, phase, status: phase };
    if (serverSpanId) updated.spanId = serverSpanId;
    const startAt = num(d?.startAt);
    if (startAt !== undefined) updated.startAt = startAt;
    const purpose = str(d?.purpose);
    if (purpose) updated.purpose = purpose;
    if (isObj(d?.arguments)) updated.arguments = d.arguments as Record<string, unknown>;
    state.spans[idx] = updated;
    return state;
  }
  const phase = normPhase(d?.phase, 'pending');
  state.spans.push({
    spanId: serverSpanId || `${toolName}#${seq}`,
    toolName,
    phase,
    status: phase,
    startAt: num(d?.startAt),
    purpose: str(d?.purpose),
    // P5a-2 渲染等价：透传工具参数 + 初始 success=true（对齐 ChatNodeKernel tool_call push 语义）
    arguments: isObj(d?.arguments) ? (d.arguments as Record<string, unknown>) : undefined,
    success: true,
  });
  return state;
}

/* ---------- tool_call_update：仅更新 phase/startAt/spanId（ChatNodeKernel 3715-3745） ---------- */

function onToolCallUpdate(state: TraceWindowState, payload: Record<string, unknown>): TraceWindowState {
  const d = sub(payload, 'tool_call_update');
  const toolName = str(d?.name);
  // 优先 spanId 精确匹配；fallback 同名最后一个（历史消息/无 spanId 兜底）
  let idx = -1;
  const upSpanId = str(d?.spanId);
  if (upSpanId) idx = state.spans.findIndex((s) => s.spanId === upSpanId);
  if (idx < 0 && toolName) {
    for (let i = state.spans.length - 1; i >= 0; i--) {
      if (state.spans[i].toolName === toolName) { idx = i; break; }
    }
  }
  if (idx < 0) return state; // 找不到目标 → 安全忽略（不虚挂）
  const span = state.spans[idx];
  // running 幂等：重复 heartbeat 只是把 phase 再次置 running，不建新 span、不结算
  const phase = normPhase(d?.phase, span.phase);
  const updated: TraceWindowSpan = { ...span, phase, status: phase };
  const startAt = num(d?.startAt);
  if (startAt !== undefined) updated.startAt = startAt;
  if (upSpanId) updated.spanId = upSpanId; // 无 spanId 创建的 span 在此吸收真实 spanId
  state.spans[idx] = updated;
  return state;
}

/* ---------- tool_result：结算（ChatNodeKernel 3746-3772） ---------- */

function onToolResult(state: TraceWindowState, payload: Record<string, unknown>): TraceWindowState {
  const d = sub(payload, 'tool_result');
  const toolName = str(d?.name);
  // 优先 spanId 精确匹配；fallback 同名「未结算」（pending/running，等价 ChatNodeKernel 的 result==='...'）
  let idx = -1;
  const trSpanId = str(d?.spanId);
  if (trSpanId) idx = state.spans.findIndex((s) => s.spanId === trSpanId);
  if (idx < 0 && toolName) {
    idx = state.spans.findIndex(
      (s) => s.toolName === toolName && (s.phase === 'pending' || s.phase === 'running'),
    );
  }
  if (idx < 0) return state; // 找不到目标 → 安全忽略
  const span = state.spans[idx];
  // phase 缺省回退与 ChatNodeKernel 3746-3772 同规则：tr.phase ?? (tr.success ? 'done' : 'error')
  //（success 缺省视为 falsy → error，服务端 tool_result 恒带 phase+success，此回退仅防缺帧）
  const phase = normPhase(d?.phase, d?.success ? 'done' : 'error');
  const updated: TraceWindowSpan = {
    ...span,
    phase,
    status: phase,
    result: str(d?.result) ?? span.result,
    durationMs: num(d?.durationMs) ?? span.durationMs,
    startAt: num(d?.startAt) ?? span.startAt,
    endAt: num(d?.endAt) ?? span.endAt,
    kind: str(d?.kind) ?? span.kind,
    summary: str(d?.summary) ?? span.summary,
    cardHtml: str(d?.cardHtml) ?? span.cardHtml,
    purpose: str(d?.purpose) ?? span.purpose,
    // P5a-2 渲染等价：success / 系统变更透传（对齐 ChatNodeKernel 3774-3788 tool_result upsert）
    success: typeof d?.success === 'boolean' ? d.success : span.success,
    systemChange: typeof d?.systemChange === 'boolean' ? d.systemChange : span.systemChange,
    changeSummary: str(d?.changeSummary) ?? span.changeSummary,
    spanId: trSpanId ?? span.spanId,
  };
  state.spans[idx] = updated;
  return state;
}

/* ---------- done：收任务级 meta（ChatNodeKernel 3892-3933） ---------- */

function onDone(state: TraceWindowState, payload: Record<string, unknown>, ts: number): TraceWindowState {
  const meta = state.meta;
  const taskId = str(payload.taskId);
  if (taskId) meta.taskId = taskId;
  if (Array.isArray(payload.matchedSkills)) meta.matchedSkills = payload.matchedSkills;
  // P5a-2 渲染等价：done 帧同帧 skillDetails 一并保留（对齐 ChatNodeKernel 3901-3908）
  if (Array.isArray(payload.skillDetails)) meta.skillDetails = payload.skillDetails;
  if (isObj(payload.usage)) meta.usage = payload.usage;
  if (isObj(payload.contextMeter)) meta.contextMeter = payload.contextMeter;
  meta.doneAt = ts;
  return state;
}

/**
 * 流末收口：把仍处于 pending/running 的 span 收口为 done（并补 endAt/durationMs）。
 * 等价 ChatNodeKernel 4003-4011 的 toolCallRecords 收口（success 默认 true → done），
 * 用于后端漏发 tool_call_update done/error 或 abort 事件在途丢失时避免"永远 Running"。
 * 无待收口 span 时原样返回 state（无变更）。
 */
export function finishWindow(state: TraceWindowState): TraceWindowState {
  const now = Date.now();
  let changed = false;
  const spans = state.spans.map((s) => {
    if (s.phase === 'pending' || s.phase === 'running') {
      changed = true;
      const endAt = s.endAt ?? now;
      return {
        ...s,
        phase: 'done' as const,
        status: 'done' as const,
        endAt,
        durationMs: s.durationMs ?? (typeof s.startAt === 'number' ? now - s.startAt : 0),
      };
    }
    return s;
  });
  if (!changed) return state;
  return { ...state, spans };
}

/* ==================== P5b-1 历史 replay（events → 窗口） ==================== */

/** core attempt toolCalls.arguments：string JSON 或对象都归一为 Record（容错：坏 JSON → undefined） */
function parseToolArgs(raw: unknown): Record<string, unknown> | undefined {
  if (isObj(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return isObj(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 历史 replay 入口：把落盘事件数组（TrajectoryEvent 同构：core 结算事件 + SSE 帧）逐条喂入
 * 一个新建窗口（与 live 同一 TraceWindowState 形态）。normalizeSseFrame 已同时识别
 * {type,payload} 归一形态与原始 SSE 帧形态；这里仅用事件的 seq/ts 覆盖归一默认值。
 * 轮末若有 turn/end 由其内部触发 finishWindow 语义；日志缺 turn/end 时调用方自行 finishWindow。
 */
export function eventsToTraceWindow(events: ReadonlyArray<unknown>): TraceWindowState {
  let win = createTraceWindow();
  for (const item of events) {
    if (!isObj(item)) continue;
    const rec = item as Record<string, unknown>;
    const ev = normalizeSseFrame(rec);
    if (!ev) continue;
    const ts = num(rec.ts) ?? Date.now();
    const seq = num(rec.seq) ?? 0;
    win = pushWindowFrame(win, { ...ev, ts, seq });
  }
  return win;
}

/* ---------- core 结算事件吸收 ---------- */

/**
 * assistant/attempt（非终答轮，route.ts 在模型输出工具调用轮结算点写入）：
 * - 文本：content/reasoning 作为该轮最终文本累积（reasoning 优先进 reasoningAccum 供 think 渲染；
 *   非 deepseek 时 reasoning 缺失，reasoning 由 content 内 <think> 前缀承载，contentAccum 剥标签兜底）；
 * - toolCalls：以 tool_call_id 为 spanId 建 pending span；与 SSE tool_call 帧互补——
 *   幂等去重：帧先建（SSE span 无 toolCallId）→ 绑别名；core 先建 → 帧后到并入（onToolCall 侧处理）。
 */
function onCoreAttempt(state: TraceWindowState, payload: Record<string, unknown>, seq: number): TraceWindowState {
  const content = str(payload.content);
  const reasoning = str(payload.reasoning);
  if (reasoning && reasoning.trim()) state.reasoningAccum = (state.reasoningAccum ?? '') + reasoning;
  if (content && content.trim()) state.contentAccum = (state.contentAccum ?? '') + content;
  const toolCalls = payload.toolCalls;
  if (!Array.isArray(toolCalls)) return state;
  for (const raw of toolCalls) {
    if (!isObj(raw)) continue;
    const name = str(raw.name);
    if (!name) continue;
    const id = str(raw.id) ?? str(raw.tool_call_id);
    // 1) 精确别名命中（既有 span 已带同 id / toolCallId —— 帧先建或重复事件 → 不双建）
    let idx = -1;
    if (id) idx = state.spans.findIndex((s) => s.spanId === id || s.toolCallId === id);
    // 2) SSE 帧先建（同名 pending/running 且未绑 toolCallId）→ 绑别名并入（幂等）
    if (idx < 0) {
      idx = state.spans.findIndex(
        (s) => s.toolName === name && (s.phase === 'pending' || s.phase === 'running') && !s.toolCallId,
      );
    }
    if (idx >= 0) {
      const span = state.spans[idx];
      const updated: TraceWindowSpan = { ...span };
      if (id && !updated.toolCallId) updated.toolCallId = id;
      if (!updated.spanId || updated.spanId.startsWith(`${name}#`)) updated.spanId = id ?? updated.spanId;
      const args = parseToolArgs(raw.arguments);
      if (args && !updated.arguments) updated.arguments = args;
      state.spans[idx] = updated;
      continue;
    }
    const args = parseToolArgs(raw.arguments);
    state.spans.push({
      spanId: id ?? `${name}#${seq}`,
      toolCallId: id,
      toolName: name,
      phase: 'pending',
      status: 'pending',
      success: true,
      arguments: args,
    });
  }
  return state;
}

/** assistant/message：终答文本收口（reasoning/content 最终文本入 accum；toolCalls 在日志恒为 []，不重复建 span） */
function onCoreAssistantMessage(state: TraceWindowState, payload: Record<string, unknown>): TraceWindowState {
  const content = str(payload.content);
  const reasoning = str(payload.reasoning);
  if (reasoning && reasoning.trim()) state.reasoningAccum = (state.reasoningAccum ?? '') + reasoning;
  if (content && content.trim()) state.contentAccum = (state.contentAccum ?? '') + content;
  return state;
}

/**
 * tool/result（core 全文结算事件）：按 tool_call_id/name 结算已建 span 或建完结 span。
 * - 精确别名（spanId/toolCallId === tool_call_id）命中 → 回补全文 result；
 *   仍 pending/running 的顺带收口 done（SSE tool_result 帧已结算的 phase/success/durationMs 不改写）；
 * - 无 tool_call_id → 唯一同名 span 兜底（绑别名回补）；多个同名 → 收口首个未结算同名 span；
 * - 均未命中 → 建完结 span（core 全文是唯一事实源，防 SSE 帧缺失丢步骤）。
 */
function onCoreToolResult(state: TraceWindowState, payload: Record<string, unknown>, seq: number): TraceWindowState {
  const name = str(payload.name);
  const callId = str(payload.tool_call_id) ?? str(payload.id);
  const content = str(payload.content) ?? str(payload.result);
  let idx = -1;
  if (callId) idx = state.spans.findIndex((s) => s.spanId === callId || s.toolCallId === callId);
  if (idx < 0 && name) {
    const sameName = state.spans.filter((s) => s.toolName === name);
    if (sameName.length === 1) {
      idx = state.spans.indexOf(sameName[0]);
    } else if (sameName.length > 1) {
      idx = state.spans.findIndex((s) => s.toolName === name && (s.phase === 'pending' || s.phase === 'running'));
    }
  }
  if (idx >= 0) {
    const span = state.spans[idx];
    const updated: TraceWindowSpan = { ...span };
    if (callId && !updated.toolCallId) updated.toolCallId = callId;
    if (!updated.spanId && callId) updated.spanId = callId;
    // 全文回补：core content 是未截断完整结果，优先更长文本（SSE 截断 '…' / 占位会被覆盖）
    if (content && (!updated.result || content.length >= updated.result.length)) updated.result = content;
    if (updated.phase === 'pending' || updated.phase === 'running') {
      const endAt = num(payload.endAt) ?? num(payload.ts);
      updated.phase = 'done';
      updated.status = 'done';
      updated.success = payload.success === false ? false : true;
      if (endAt !== undefined) updated.endAt = endAt;
      updated.durationMs = updated.durationMs ?? (typeof updated.startAt === 'number' && endAt !== undefined ? endAt - updated.startAt : updated.durationMs);
    }
    state.spans[idx] = updated;
    return state;
  }
  if (!name && !callId) return state; // 既无工具名也无 id → 安全忽略
  state.spans.push({
    spanId: callId ?? `${name}#${seq}`,
    toolCallId: callId,
    toolName: name,
    phase: 'done',
    status: 'done',
    success: true,
    result: content || undefined,
  });
  return state;
}
