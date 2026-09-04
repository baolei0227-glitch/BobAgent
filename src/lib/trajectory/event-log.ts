/**
 * Trajectory 事件日志（P0：append-only 事件日志）
 *
 * 对齐 DeepSeek Harness 的 SessionEvent 设计：服务端把每次 SSE 事件按发生顺序
 * 追加为一条带序号/时间戳/类型/payload 的记录，形成单一事实源的事件日志。
 *
 * P0 阶段职责（UI 零变化）：
 *   - send() 时同步记录事件（type 取 payload 首个 key；流式 reasoning/content 不逐块记录，
 *     避免一轮数千块的 token 级日志爆炸——它们已通过 /api/nodes 的 reasoning/answer 字段持久化）
 *   - 工具调用生成稳定 spanId + 真实 startAt/endAt（为 P1 前端稳定 id 与真实耗时铺路）
 *   - 任务结束时把完整日志持久化为 JSONL（为 P2 历史恢复提供数据基础）
 *
 * 前端在 P0 完全不消费本日志；P1 才改为直连事件流渲染。
 */

import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** 单个轨迹事件（append-only 事件日志的最小单元） */
export interface TrajectoryEvent {
  /** 事件序号（0 起，append-only） */
  seq: number;
  /** 事件类型：tool_call / tool_call_update / tool_result / matchedSkills / done ... */
  type: string;
  /** 事件发生时间戳 ms */
  ts: number;
  /** 关联的 span id（工具调用等结构化 span） */
  spanId?: string;
  /** span 开始时间戳 ms（tool_call 时生成） */
  startAt?: number;
  /** span 结束时间戳 ms（tool_result 时生成） */
  endAt?: number;
  /** 原始 SSE payload（含 nodeId 等） */
  payload: Record<string, unknown>;
}

/** 生成 span/task 唯一 id（Node crypto.randomUUID） */
export function genSpanId(): string {
  return randomUUID();
}

/** 生成任务 id（用于轨迹日志文件命名） */
export function genTaskId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** 流式内容事件类型：不逐块记录（避免 token 级日志爆炸），由 /api/nodes 持久化完整文本 */
const STREAM_CONTENT_TYPES = new Set(['reasoning', 'content']);

/** mark 单源事件：已有结构化 mark（含真实时间戳/全文），send 的 record 版本纯冗余 → 跳过避免双写 */
const MARK_SOURCED_TYPES = new Set(['model_turn', 'thinking_span']);

/** append-only 事件日志：内存累积 + finalize 导出 */
export class EventLog {
  private events: TrajectoryEvent[] = [];
  private seq = 0;

  /**
   * 记录一个 SSE 事件。
   * type 取 payload 首个 key；流式 reasoning/content 块跳过（最终文本已由持久化链路保存）。
   */
  record(data: Record<string, unknown>): void {
    const type = Object.keys(data)[0] ?? 'unknown';
    if (STREAM_CONTENT_TYPES.has(type)) return;
    if (MARK_SOURCED_TYPES.has(type)) return;
    this.events.push({ seq: this.seq++, type, ts: Date.now(), payload: data });
  }

  /** 记录一个带 spanId/时间戳的结构化 span 标记（工具 start/end） */
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
