/**
 * 空轮（既无正文也无工具调用）的收尾策略：输出触顶（finish_reason=length）按可恢复故障处理。
 *
 * 背景（2026-10-08 事故 · 济星-20261008「从甲方角度对本协提出修改意见」）：
 *   thinkingLevel=high 时每轮 max_tokens=16384（只有 max 档才放宽到 32k），reasoning 把整轮输出预算
 *   吃满 → 模型整轮只产出思考、被 max_tokens 截断，正文与工具调用双双为空。实测证据：
 *   - 链路日志：两轮各耗时 73s / 74s，任务均速 216 tok/s ≈ 16k tokens/轮，正好是当轮预算上限；
 *   - 轨迹：`content_truncated` 出现 2 次，7 轮里 6 轮正文长度为 0（contentLen ≈ reasoningLen + 16，
 *     16 = `<think></think>\n` 固定开销）。
 *   旧逻辑把这类空轮一律当成「模型假完成」：第一次补问、第二次强制收尾；强制收尾时把空正文原样落盘
 *   → 节点正文只剩「⏳ Completion check」+「⚠️ Output reached the model limit」两条系统提示，
 *   用户侧表现就是「没有结果就暂停了」。
 *
 * 本模块提供两个纯函数：
 *  - planTruncationRetry：截断空轮 → 定向重试（加输出预算 / 第 2 次起再降一档思考）的决策；
 *  - buildEmptyAnswerFallback：整轮没有任何可读正文时的兜底正文（保证空答案永远不落盘）。
 */

/** 截断重试预算：第 1 次重试加输出预算，第 2 次起同时降一档思考；再撞顶才回到「假完成」判定 */
export const TRUNCATION_RETRY_LIMIT = 2;

export interface TruncationRetryPlan {
  /** 本次是第几次重试（1-based），同时作为「已用次数」写回 */
  attempt: number;
  maxAttempts: number;
  /** 放宽本轮输出预算（调用方负责判档位是否支持放大，低档位放大可能 400） */
  boostOutputBudget: boolean;
  /** 再降一档思考（first attempt 不动，留一档余量给第二次） */
  downgradeEffort: boolean;
}

/**
 * 空轮 + 输出触顶 → 重试计划；返回 null 表示不走截断重试（沿用既有「假完成」判定）。
 * 判据刻意只看「本轮是否 finish_reason=length」，不看是否调用过工具：
 * 纯问答首轮被截断同样需要一个重试机会，否则会静默收尾成空答案。
 */
export function planTruncationRetry(input: {
  truncated: boolean;
  retriesUsed: number;
}): TruncationRetryPlan | null {
  if (!input.truncated) return null;
  const used = Number.isFinite(input.retriesUsed) ? Math.max(0, Math.trunc(input.retriesUsed)) : 0;
  if (used >= TRUNCATION_RETRY_LIMIT) return null;
  const attempt = used + 1;
  return {
    attempt,
    maxAttempts: TRUNCATION_RETRY_LIMIT,
    boostOutputBudget: true,
    // 第一次先只加预算（最贴近故障原因、改动最小）；仍撞顶说明思考本身就要吃掉这么多，
    // 第二次再降一档思考。降档会影响回答质量，故不放在第一次。
    downgradeEffort: attempt >= 2,
  };
}

/** 截断重试时注入给模型的用户消息（要求它换一种输出策略，而不是原地重撞同一面墙） */
export function buildTruncationRetryNudge(plan: TruncationRetryPlan): string {
  return (
    `上一轮生成被输出长度上限截断：思考（reasoning）占满了整轮输出预算，正文和工具调用都没能输出。` +
    `这是第 ${plan.attempt}/${plan.maxAttempts} 次重试，本轮已放宽输出预算` +
    `${plan.downgradeEffort ? '并降低思考深度' : ''}。请调整策略后继续：\n` +
    `1. 若用已有结果就能成文，请**直接输出最终答案**：先给结论与要点，长文分段给，不要在一次输出里写完整篇。\n` +
    `2. 若仍需调用工具，请把长内容拆小：先 write_file 写第一段并在末尾留 <!-- MORE --> 占位，再用 edit_code 分段替换；` +
    `不要把长文塞进一次调用的参数里。\n` +
    `3. 不要在思考里反复推演同一问题——想清楚就直接落笔。`
  );
}

export interface EmptyAnswerFallbackInput {
  /** 本任务发生 finish_reason=length 的轮数（0 = 不是截断导致的空答案） */
  truncatedRounds: number;
  /** 本轮成功执行的工具调用数（用于说明「工具跑了但没成文」） */
  toolCallCount: number;
  /** 本轮产出的成果文件（相对项目路径），有则列出，避免用户以为白跑一趟 */
  producedFiles?: string[];
}

/**
 * 整轮没有任何可读正文时的兜底正文。
 * 目标：① 用户知道发生了什么、下一步做什么；② 节点正文永远不为空——不再出现「只剩系统提示」的答案。
 * 刻意不搬 reasoning 正文：思考已随 RMETA / 思考面板落盘，再抄一遍只会把 .md 撑成噪声。
 */
export function buildEmptyAnswerFallback(input: EmptyAnswerFallbackInput): string {
  const truncatedRounds = Math.max(0, Math.trunc(input.truncatedRounds || 0));
  const toolCallCount = Math.max(0, Math.trunc(input.toolCallCount || 0));
  const files = (input.producedFiles ?? []).filter((p) => typeof p === 'string' && p.trim().length > 0);

  const cause =
    truncatedRounds > 0
      ? `模型把整轮输出预算用在了思考上并被长度上限截断（${truncatedRounds} 轮），没能输出正文` +
        `${toolCallCount > 0 ? '（工具已执行，但结果没有汇总成文）' : '，也没有调用工具'}`
      : `模型本轮既没有输出正文${toolCallCount > 0 ? '（工具已执行，但结果没有汇总成文）' : '，也没有调用工具'}`;

  const lines: string[] = [
    `> ⚠️ **本轮没有产出正文。** ${cause}，任务已中止。`,
    ``,
    `**你可以这样做**`,
    `- 直接重发刚才那条消息（或点「继续」）——上下文已保留，不用从头再来。`,
    `- 若反复出现：把思考档位从 high/max 调到 low，或把任务拆小（例如一次只审一份合同 / 一章）。`,
    `- 需要长文交付时，让模型分段写文件，而不是一次输出到底。`,
  ];

  if (files.length > 0) {
    lines.push(``, `**本轮已产出的文件**`, ...files.map((p) => `- ${p}`));
  }

  return lines.join('\n');
}
