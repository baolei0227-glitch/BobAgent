/**
 * 管家 SSE 看门狗（2026-10-06）—— 判定「流是不是真的断了」。
 *
 * 与「等待口语」的区别（两者都进那个小状态条，但说的不是一件事）：
 *   - 等待口语看的是**可见正文**停了多久（思考期间照样在涨）→ 只会让文案更安抚；
 *   - 本模块看的是**一个字节都没到**多久 → 到阈值就必须如实说，而不是继续"还在弄"。
 *
 * 为什么阈值是 60s：服务端在长耗时工具期每 **20s** 发一条 tool_call_update 心跳
 * （`app/api/chat/route.ts` 的「长耗时工具 keepalive」），模型流式期间逐块下发
 * reasoning / content —— 60s ≈ 连丢 3 个心跳，正常链路不可能出现；
 * 同时留足余量，避免把「下一轮模型 TTFT 偏慢」误判成断流。
 *
 * 注：画布节点链路另有 90s 空闲超时（ChatNodeKernel 的 armTimeout）且会**直接掐断**；
 * 管家这条**不掐断**（管家任务动辄几分钟，误杀比多等更贵），只如实提示 + 给「重新发送」。
 */

/** 连续多少秒没有收到任何字节 → 判定断流 */
export const SSE_STALL_SEC = 60;

/**
 * 距上次收到字节的秒数 → 断流态秒数：`0` = 正常（含各种异常输入）。
 * @param lastByteAtMs 上次收到任意字节的时刻（毫秒）；0 / 非法 = 尚未开始或未知 → 视为正常
 * @param nowMs 当前时刻（毫秒）
 * @param thresholdSec 阈值（秒），默认 SSE_STALL_SEC
 */
export function stalledSeconds(
  lastByteAtMs: number,
  nowMs: number,
  thresholdSec: number = SSE_STALL_SEC,
): number {
  if (!Number.isFinite(lastByteAtMs) || lastByteAtMs <= 0) return 0;
  if (!Number.isFinite(nowMs) || !Number.isFinite(thresholdSec)) return 0;
  const sec = Math.floor((nowMs - lastByteAtMs) / 1000);
  // 时钟回拨 / 未来时间戳 → 负数，不能当成"断流了 -3 秒"
  if (sec <= 0) return 0;
  return sec >= thresholdSec ? sec : 0;
}
