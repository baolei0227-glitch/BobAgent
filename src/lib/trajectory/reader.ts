/**
 * Trajectory 读取器（P2 基础）：按 nodeId+taskId 从项目 .trajectory 恢复一次任务事件，
 * 并投影出可渲染消息主干（derive/buildRenderMessages）。
 *
 * 只读、无副作用；路径段做安全校验（防穿越）。供 /api/trajectory 与未来前端 Trace/恢复消费。
 */

import { join } from 'path';
import {
  readEventLog,
  deriveMessages,
  buildRenderMessages,
  type DerivedMessage,
  type TrajectoryEvent,
} from './event-log';

/** 路径段安全校验：仅允许字母数字与 . _ - :（nodeId=uuid、taskId=genTaskId 格式均覆盖） */
function isSafeSegment(seg: string | undefined | null): seg is string {
  return typeof seg === 'string' && seg.length > 0 && seg.length <= 96 && /^[A-Za-z0-9._:-]+$/.test(seg);
}

export interface TrajectoryReadResult {
  taskId: string;
  nodeId: string;
  /** 事件总数（全部类型） */
  eventCount: number;
  /** core 事件（可重建消息主干）条数 */
  coreCount: number;
  /** 事件类型清单（按序去重，便于诊断） */
  types: string[];
  /** 主干投影（含 tool/result 单列） */
  messages: DerivedMessage[];
  /** 可直接渲染序列（tool/result 并入 assistant.toolCalls） */
  rendered: DerivedMessage[];
  /** P5b-1 历史 replay：readEventLog 原数组（core 结算事件 + SSE 帧），供 eventsToTraceWindow 重建窗口 */
  events: TrajectoryEvent[];
}

/**
 * 读取某任务的轨迹并投影消息。
 * @param projectPath 项目绝对路径（BobWorkspace/<proj>）
 * @param nodeId 节点 id（uuid）
 * @param taskId 任务 id（genTaskId 产出；亦接受 .jsonl 文件名等价形式）
 * @returns 找不到文件/非法段返回 null
 */
export function readTrajectoryMessages(
  projectPath: string,
  nodeId: string,
  taskId: string,
): TrajectoryReadResult | null {
  if (!projectPath) return null;
  if (!isSafeSegment(nodeId) || !isSafeSegment(taskId)) return null;

  // 兼容调用方传入 taskId.jsonl 形态
  const taskFile = taskId.endsWith('.jsonl') ? taskId : `${taskId}.jsonl`;
  const file = join(projectPath, '.trajectory', nodeId, taskFile);

  const events: TrajectoryEvent[] = readEventLog(file);
  if (events.length === 0) return null;

  const messages = deriveMessages(events);
  const coreSet = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message', 'assistant/attempt', 'tool/result']);
  const types: string[] = [];
  for (const e of events) if (!types.includes(e.type)) types.push(e.type);

  return {
    taskId,
    nodeId,
    eventCount: events.length,
    coreCount: events.filter((e) => coreSet.has(e.type)).length,
    types,
    messages,
    rendered: buildRenderMessages(events),
    events,
  };
}
