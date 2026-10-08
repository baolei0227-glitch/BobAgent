/**
 * 空轮收尾策略单测（2026-10-08 事故回归）：
 * 事故现场（济星-20261008 /「从甲方角度对本协提出修改意见」）的可观测事实作为用例输入：
 *  - 两轮 finish_reason=length（content_truncated ×2，各 73s/74s ≈ 16384 输出预算）；
 *  - 两轮均无正文、无工具调用 → 旧逻辑记「假完成」，补问一次后强制收尾，落盘答案正文为空；
 *  - 用户侧最终只看到「⏳ Completion check」+「⚠️ Output reached the model limit」两条系统提示。
 * 本文件锁死两件事：① 截断空轮必须给重试预算而不是记「假完成」；② 空答案必须有可读兜底正文。
 */
import { describe, expect, it } from 'vitest';
import {
  TRUNCATION_RETRY_LIMIT,
  buildEmptyAnswerFallback,
  buildTruncationRetryNudge,
  planTruncationRetry,
} from './empty-round';

describe('planTruncationRetry 截断空轮重试决策', () => {
  it('未截断的空轮 → 不走截断重试（沿用既有「假完成」判定）', () => {
    expect(planTruncationRetry({ truncated: false, retriesUsed: 0 })).toBeNull();
    expect(planTruncationRetry({ truncated: false, retriesUsed: 1 })).toBeNull();
  });

  it('事故现场：首轮截断 → 第 1 次重试只放宽输出预算、不动思考档', () => {
    expect(planTruncationRetry({ truncated: true, retriesUsed: 0 })).toEqual({
      attempt: 1,
      maxAttempts: TRUNCATION_RETRY_LIMIT,
      boostOutputBudget: true,
      downgradeEffort: false,
    });
  });

  it('加预算后仍截断 → 第 2 次重试同时降一档思考', () => {
    expect(planTruncationRetry({ truncated: true, retriesUsed: 1 })).toEqual({
      attempt: 2,
      maxAttempts: TRUNCATION_RETRY_LIMIT,
      boostOutputBudget: true,
      downgradeEffort: true,
    });
  });

  it('预算用尽（含脏值）→ 返回 null，交回「假完成」判定收尾', () => {
    expect(planTruncationRetry({ truncated: true, retriesUsed: TRUNCATION_RETRY_LIMIT })).toBeNull();
    expect(planTruncationRetry({ truncated: true, retriesUsed: 99 })).toBeNull();
    // 脏值防护：负数/非数按「未用过」处理，不会绕过预算上限
    expect(planTruncationRetry({ truncated: true, retriesUsed: -5 })?.attempt).toBe(1);
    expect(planTruncationRetry({ truncated: true, retriesUsed: Number.NaN })?.attempt).toBe(1);
  });

  it('重试次数单调递增且不超过上限（防死循环）', () => {
    const attempts: number[] = [];
    let used = 0;
    for (let i = 0; i < 10; i++) {
      const plan = planTruncationRetry({ truncated: true, retriesUsed: used });
      if (!plan) break;
      attempts.push(plan.attempt);
      used = plan.attempt;
    }
    expect(attempts).toEqual([1, 2]);
    expect(attempts.length).toBeLessThanOrEqual(TRUNCATION_RETRY_LIMIT);
  });
});

describe('buildTruncationRetryNudge 重试注入指令', () => {
  it('要求换策略：直接成文 / 拆小工具参数 / 停止空转思考', () => {
    const nudge = buildTruncationRetryNudge({
      attempt: 1,
      maxAttempts: 2,
      boostOutputBudget: true,
      downgradeEffort: false,
    });
    expect(nudge).toContain('1/2');
    expect(nudge).toContain('直接输出最终答案');
    expect(nudge).toContain('write_file');
    expect(nudge).toContain('edit_code');
    // 第一次不含「降低思考深度」（尚未降档，不能对模型说谎）
    expect(nudge).not.toContain('降低思考深度');
  });

  it('第 2 次如实告知已降思考档', () => {
    const nudge = buildTruncationRetryNudge({
      attempt: 2,
      maxAttempts: 2,
      boostOutputBudget: true,
      downgradeEffort: true,
    });
    expect(nudge).toContain('2/2');
    expect(nudge).toContain('降低思考深度');
  });
});

describe('buildEmptyAnswerFallback 空答案兜底正文', () => {
  it('事故现场：截断 2 轮 + 工具已跑 → 说明成因且正文非空', () => {
    const text = buildEmptyAnswerFallback({ truncatedRounds: 2, toolCallCount: 12 });
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain('本轮没有产出正文');
    expect(text).toContain('2 轮');
    expect(text).toContain('工具已执行');
    // 必须给出可执行的下一步，而不是只报错
    expect(text).toContain('继续');
    expect(text).toContain('思考档位');
  });

  it('非截断的空轮（模型摆烂）不谎称长度截断', () => {
    const text = buildEmptyAnswerFallback({ truncatedRounds: 0, toolCallCount: 0 });
    expect(text).toContain('本轮没有产出正文');
    expect(text).not.toContain('截断');
  });

  it('本轮有产物时列出文件，避免用户以为白跑', () => {
    const text = buildEmptyAnswerFallback({
      truncatedRounds: 1,
      toolCallCount: 3,
      producedFiles: ['homework/挂靠协议-甲方审核意见.md', 'homework/修订版.docx'],
    });
    expect(text).toContain('本轮已产出的文件');
    expect(text).toContain('homework/挂靠协议-甲方审核意见.md');
    expect(text).toContain('homework/修订版.docx');
  });

  it('产物列表为空/含脏值时不留空条目', () => {
    const text = buildEmptyAnswerFallback({
      truncatedRounds: 0,
      toolCallCount: 0,
      producedFiles: ['', '   '],
    });
    expect(text).not.toContain('本轮已产出的文件');
    expect(text).not.toMatch(/^- *$/m);
  });

  it('脏值（负数/NaN）不产生 NaN 文案', () => {
    const text = buildEmptyAnswerFallback({ truncatedRounds: Number.NaN, toolCallCount: -3 });
    expect(text).not.toContain('NaN');
    expect(text).toContain('本轮没有产出正文');
  });
});
