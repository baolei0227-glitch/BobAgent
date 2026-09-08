/**
 * src/lib/nodes/compact-source.ts
 * T2 折叠「输入源切换」的共享实现（chat route 的 R-14-C / 预算前瞻 与 nodes append 的 R-25/26
 * 双轨共用同一派生函数，避免两处各自实现造成行为分叉）。
 *
 * 设计依据：docs/DSH-T2长会话投影-设计评审-20260908.md §3.2-2/3 ——
 *   折叠/压缩输入源从「被裁 .md/request 文本」切换为 .trajectory 事件日志派生
 *   （appendPayloadFromEvents：question/answer/reasoning/toolNames，**不含工具结果全文**，
 *   防压缩模型输入爆炸 R4）；日志缺失/晚落盘/被 GC → 该轮回退 .md 文本（行为 = 现网）。
 *
 * 游标滞后 gap 修复的落点不在本模块：route（R-14-C/预算前瞻）折叠写回 .md 时置一次性标记
 * frontmatter.memory_compacted_pending_echo = true（随折叠同一次写回落盘）；同轮 append 读到后
 * 把真实游标随响应 compacted 回传前端并清除。用落盘标记而非进程内 Map：chat 与 nodes 是 Next
 * 独立 route bundle，进程内模块状态不可跨路由共享。
 */

import { join } from 'path';
import type { ConversationTurn } from '@/lib/node-markdown';
import { readEventLog } from '@/lib/trajectory/event-log';
import { appendPayloadFromEvents, type AppendDerivedPayload } from '@/lib/trajectory/export';

/** 路径段安全校验（与 nodes append derive 分支 / trajectory reader 同口径，防穿越） */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._:-]{1,96}$/;

/**
 * 由一轮 .trajectory 派生的 payload 生成「压缩输入轮次」：
 *  - question = 首条 user 原文；answer = 终答文本；
 *  - reasoning（think 全文回填的历史大头）以 [推理过程] 附于答后，使 R-27 硬事实抽取与
 *    压缩模型都可见思考内容；toolNames 仅留名单（R4：不取 tool result 全文）。
 *  - 日志无任何可用文本 → 原样回退 fallback（.md 轮次，现网语义零漂移）。
 */
export function compactionTurnFromDerivedPayload(
  payload: AppendDerivedPayload,
  fallback: ConversationTurn,
): ConversationTurn {
  const question = (payload.question ?? '').trim();
  const answer = (payload.answer ?? '').trim();
  const reasoning = (payload.reasoning ?? '').trim();
  const tools = Array.isArray(payload.toolNames)
    ? payload.toolNames.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  if (!question && !answer && !reasoning && tools.length === 0) return fallback;

  const parts: string[] = [];
  const base = answer || fallback.answer;
  if (base) parts.push(base);
  if (reasoning) parts.push(`[推理过程] ${reasoning}`);
  if (tools.length > 0) parts.push(`[本轮工具] ${tools.join('、')}`);

  return {
    question: question || fallback.question,
    answer: parts.length > 0 ? parts.join('\n') : fallback.answer,
    questionTime: fallback.questionTime,
    answerTime: fallback.answerTime,
  };
}

/**
 * 读取某一轮的任务日志并派生压缩输入轮次。
 * 单次直读（不做 0/250/700ms 短重试）：折叠对象是「历史已落盘轮次」，其日志在 chat 结算时
 * 已持久化（晚落盘只影响 append 对本轮 derive 的分支，折叠范围不覆盖未落盘轮）。
 * @returns 派生轮次；日志缺失/为空/路径非法 → null（调用方回退 .md 文本）
 */
export function readLogDerivedCompactionTurn(
  projectPath: string,
  nodeId: string,
  turn: ConversationTurn,
): ConversationTurn | null {
  const taskId = turn.taskId;
  if (!projectPath || !nodeId || !taskId) return null;
  if (!SAFE_SEGMENT_RE.test(taskId) || !SAFE_SEGMENT_RE.test(nodeId)) return null;
  const events = readEventLog(join(projectPath, '.trajectory', nodeId, `${taskId}.jsonl`));
  if (events.length === 0) return null;
  return compactionTurnFromDerivedPayload(appendPayloadFromEvents(events), turn);
}

/**
 * 批量：把将折叠的 .md 轮次逐一切换为 .trajectory 事件日志派生的压缩输入（D：折叠源切日志派生）。
 * 某轮日志缺失/晚落盘/被 GC → 该轮保留 .md 文本（回退安全，行为 = 现网）。
 */
export function deriveCompactionTurnsFromLogs(
  turns: ConversationTurn[],
  projectPath: string,
  nodeId: string,
): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const t of turns) {
    const derived = readLogDerivedCompactionTurn(projectPath, nodeId, t);
    out.push(derived ?? t);
  }
  return out;
}
