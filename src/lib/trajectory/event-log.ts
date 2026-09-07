/**
 * Trajectory 事件日志（P1：append-only 事件日志 = 任务事实源）
 *
 * 对齐 DeepSeek Harness 的 SessionEvent 设计：服务端把每次 SSE 事件按发生顺序
 * 追加为一条带序号/时间戳/类型/payload 的记录，形成单一事实源的事件日志。
 *
 * P1 阶段目标（UI/持久化零变化，双写验证期）：
 *   - 保留 P0 链路：send() 内 record 每条 SSE 帧；流式 reasoning/content 块仍不逐块记录
 *     （避免 token 级日志爆炸），改为在结算点以「聚合事件」记录完整正文；
 *   - 新增 DSH 语义 core 事件（turn/step/user/assistant/tool）：由 route.ts 在结算点
 *     eventLog.mark(CORE_EVENT.x, ...) 写入「模型可见的完整事实」（含最终回复正文、
 *     完整工具结果文本），使该任务可从日志重建对话主干；
 *   - 提供 deriveMessages()/buildRenderMessages()：从事件投影出消息序列，供
 *     P2「按 taskId 恢复历史」与 Trace 直连事件流消费。
 *
 * 前端在 P1 仍不消费本日志；P2 才改为直连事件流渲染。
 */

import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** 单个轨迹事件（append-only 事件日志的最小单元） */
export interface TrajectoryEvent {
  /** 事件序号（0 起，append-only） */
  seq: number;
  /** 事件类型：SSE 顶层 key（tool_call / tool_result / done ...）或 CORE_EVENT 语义类型 */
  type: string;
  /** 事件发生时间戳 ms */
  ts: number;
  /** 关联的 span/step id（工具调用、单步模型请求等结构化标识） */
  spanId?: string;
  /** span 开始时间戳 ms（tool_call 时生成） */
  startAt?: number;
  /** span 结束时间戳 ms（tool_result 时生成） */
  endAt?: number;
  /** 原始 SSE payload 或结构化事件载荷 */
  payload: Record<string, unknown>;
}

/** DSH 语义 core 事件类型（P1：由结算点显式写入，可重建任务消息主干） */
export const CORE_EVENT = {
  TURN_START: 'turn/start',
  TURN_END: 'turn/end',
  STEP_START: 'step/start',
  STEP_END: 'step/end',
  USER_MESSAGE: 'user/message',
  ASSISTANT_MESSAGE: 'assistant/message',
  ASSISTANT_ATTEMPT: 'assistant/attempt',
  TOOL_RESULT: 'tool/result',
  // P4c-1 压缩事件化：记忆压缩（R-14-C 缓存感知 / nodes 增量压缩）发生后由结算点写入，
  // payload 承载 shadowedTurns/{from,to}、hardFacts 摘要、summaryGoal、compactedUntil、reason
  COMPACTION: 'compaction',
} as const;
export type CoreEventType = (typeof CORE_EVENT)[keyof typeof CORE_EVENT];

/** 生成 span/task 唯一 id（Node crypto.randomUUID） */
export function genSpanId(): string {
  return randomUUID();
}

/** 生成任务 id（用于轨迹日志文件命名） */
export function genTaskId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** 流式内容事件类型：不逐块记录（避免 token 级日志爆炸），由「聚合事件」承载完整正文 */
const STREAM_CONTENT_TYPES = new Set(['reasoning', 'content']);

/** append-only 事件日志：内存累积 + finalize 导出 */
export class EventLog {
  private events: TrajectoryEvent[] = [];
  private seq = 0;

  /**
   * 记录一个 SSE 事件。
   * type 取 payload 首个 key；流式 reasoning/content 块跳过（最终文本由结算点聚合事件保存）。
   */
  record(data: Record<string, unknown>): void {
    const type = Object.keys(data)[0] ?? 'unknown';
    if (STREAM_CONTENT_TYPES.has(type)) return;
    this.events.push({ seq: this.seq++, type, ts: Date.now(), payload: data });
  }

  /** 记录一个带 spanId/时间戳的结构化 span/聚合 标记（core 事件与工具 start/end 共用） */
  mark(type: string, spanId: string, payload: Record<string, unknown>, startAt?: number, endAt?: number): void {
    this.events.push({ seq: this.seq++, type, ts: Date.now(), spanId, startAt, endAt, payload });
  }

  /** 导出完整事件日志（数组） */
  finalize(): TrajectoryEvent[] {
    return this.events;
  }
}

/** 把事件日志持久化为 JSONL（每行一个事件）；失败仅告警，不影响主流程 */
export function persistEventLog(filePath: string, events: TrajectoryEvent[]): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const lines = events.map((e) => JSON.stringify(e));
    writeFileSync(filePath, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf-8');
  } catch (err) {
    console.warn('[trajectory] 事件日志持久化失败:', err instanceof Error ? err.message : String(err));
  }
}

/** 读取某任务的事件日志（JSONL → 事件数组）；文件缺失/坏行容错（P2 历史恢复用） */
export function readEventLog(filePath: string): TrajectoryEvent[] {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const events: TrajectoryEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as TrajectoryEvent;
        if (typeof e?.type === 'string') events.push(e);
      } catch { /* 坏行忽略 */ }
    }
    return events;
  } catch {
    return [];
  }
}

/* ==================== 派生投影（从事件重建消息主干） ==================== */

/** 事件派生的消息（贴近前端 ChatMessage 的渲染子集，不引用前端类型避免耦合） */
export interface DerivedMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ id?: string; name?: string; arguments?: string; result?: string; status?: string }>;
  /** tool 消息：关联的 assistant 工具调用 id（并入 toolCalls 用） */
  tool_call_id?: string;
  /** assistant/attempt：非终答（其后接工具执行），区别于 assistant/message 终答 */
  attempt?: boolean;
  /** 事件时间戳 */
  ts?: number;
}

const CORE_SET = new Set<CoreEventType>(Object.values(CORE_EVENT));

/** 从事件日志按序投影出消息主干（user/assistant 完整正文 + tool 结果），供重建/对照 */
export function deriveMessages(events: TrajectoryEvent[]): DerivedMessage[] {
  const out: DerivedMessage[] = [];
  for (const e of events) {
    if (!CORE_SET.has(e.type as CoreEventType)) continue;
    const p = e.payload;
    if (e.type === CORE_EVENT.USER_MESSAGE) {
      out.push({ role: 'user', content: str(p.content), ts: e.ts });
    } else if (e.type === CORE_EVENT.ASSISTANT_MESSAGE || e.type === CORE_EVENT.ASSISTANT_ATTEMPT) {
      const isAttempt = e.type === CORE_EVENT.ASSISTANT_ATTEMPT;
      const msg: DerivedMessage = {
        role: 'assistant',
        content: str(p.content),
        reasoning: str(p.reasoning),
        toolCalls: Array.isArray(p.toolCalls) ? p.toolCalls as DerivedMessage['toolCalls'] : undefined,
        ts: e.ts,
      };
      if (isAttempt) msg.attempt = true;
      out.push(msg);
    } else if (e.type === CORE_EVENT.TOOL_RESULT) {
      out.push({ role: 'tool', content: str(p.content), tool_call_id: str(p.tool_call_id), ts: e.ts });
    }
  }
  return out;
}

/**
 * 生成可直接渲染的消息序列：把 tool/result 并入前一条 assistant/attempt 的
 * toolCalls 对应项（按 tool_call_id === toolCalls[].id），无匹配时保持单列 tool 消息。
 * 产出 = 前端「一条 assistant 轮（含工具结果）+ 最终终答」语义。
 */
export function buildRenderMessages(events: TrajectoryEvent[]): DerivedMessage[] {
  const derived = deriveMessages(events);
  const out: DerivedMessage[] = [];
  let lastAssistantIdx = -1;
  for (const m of derived) {
    if (m.role === 'assistant') {
      out.push(m);
      lastAssistantIdx = out.length - 1;
    } else if (m.role === 'tool') {
      const prev = lastAssistantIdx >= 0 ? out[lastAssistantIdx] : undefined;
      const target = prev?.toolCalls?.find((tc) => tc.id && tc.id === m.tool_call_id);
      if (prev && target && m.content !== undefined) {
        target.result = m.content;
        if (m.ts) (target as Record<string, unknown>)._ts = m.ts;
      } else {
        out.push(m);
      }
    } else {
      out.push(m);
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
