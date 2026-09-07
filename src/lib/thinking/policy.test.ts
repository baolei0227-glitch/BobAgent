import { describe, expect, it } from 'vitest';
import {
  v4ThinkingModeForLevel,
  executionDowngrade,
  isTrivialPrompt,
  shouldInjectThinkPrompt,
  type ThinkingPolicyConfig,
} from './policy';

const ON: ThinkingPolicyConfig = { downgradeOnExecution: true, trivialPromptOff: true };
const OFF_DOWNGRADE: ThinkingPolicyConfig = { downgradeOnExecution: false, trivialPromptOff: true };
const OFF_TRIVIAL: ThinkingPolicyConfig = { downgradeOnExecution: true, trivialPromptOff: false };

describe('thinking policy: v4ThinkingModeForLevel', () => {
  it('low/medium→thinking、high→thinking_max', () => {
    expect(v4ThinkingModeForLevel('low', ON)).toBe('thinking');
    expect(v4ThinkingModeForLevel('medium', ON)).toBe('thinking');
    expect(v4ThinkingModeForLevel('high', ON)).toBe('thinking_max');
  });
  it('C1 琐碎关思考仅当开关开且非 high', () => {
    expect(v4ThinkingModeForLevel('medium', ON, true)).toBe('non-thinking');
    expect(v4ThinkingModeForLevel('high', ON, true)).toBe('thinking_max'); // 尊重高深度
    expect(v4ThinkingModeForLevel('medium', OFF_TRIVIAL, true)).toBe('thinking'); // 开关关不降
  });
});

describe('thinking policy: executionDowngrade', () => {
  it('规划轮/收尾轮/开关关 → 不降级', () => {
    expect(executionDowngrade(0, false, 'high', true, ON)).toBeNull();
    expect(executionDowngrade(2, true, 'high', true, ON)).toBeNull();
    expect(executionDowngrade(2, false, 'high', true, OFF_DOWNGRADE)).toBeNull();
  });
  it('V4 执行轮降级：thinking→non-thinking、thinking_max→thinking、non-thinking 不动点', () => {
    expect(executionDowngrade(2, false, 'medium', true, ON)?.thinkingMode).toBe('non-thinking');
    expect(executionDowngrade(2, false, 'high', true, ON)?.thinkingMode).toBe('thinking');
    expect(executionDowngrade(2, false, 'medium', true, OFF_TRIVIAL)?.thinkingMode).toBe('non-thinking');
  });
  it('非 V4 执行轮降级：high→medium、medium→low、low→low', () => {
    expect(executionDowngrade(2, false, 'high', false, ON)?.reasoningEffort).toBe('medium');
    expect(executionDowngrade(2, false, 'medium', false, ON)?.reasoningEffort).toBe('low');
    expect(executionDowngrade(2, false, 'low', false, ON)?.reasoningEffort).toBe('low');
  });
});

describe('thinking policy: isTrivialPrompt', () => {
  const msg = (role: string, content: string, tool_calls?: unknown[]) => ({ role, content, tool_calls });
  it('问候/致谢/简单运算 → true', () => {
    expect(isTrivialPrompt([msg('user', '谢谢')])).toBe(true);
    expect(isTrivialPrompt([msg('user', '2+3=')])).toBe(true);
  });
  it('复杂任务/历史带工具/超长 → false', () => {
    expect(isTrivialPrompt([msg('user', '帮我分析一下这份合同的风险点')])).toBe(false);
    expect(isTrivialPrompt([msg('assistant', 'x', [{ id: 't1' }]), msg('user', '继续')])).toBe(false);
    expect(isTrivialPrompt([msg('user', 'x'.repeat(4000))])).toBe(false);
  });
});

describe('thinking policy: shouldInjectThinkPrompt seam', () => {
  it('V4 恒不注入（纯 API 驱动）', () => {
    expect(shouldInjectThinkPrompt(true, true, ON)).toBe(false);
    expect(shouldInjectThinkPrompt(true, false, ON)).toBe(false);
  });
  it('非 V4 推理模型默认注入 think 引导，可经 injectThinkGuide 关闭', () => {
    expect(shouldInjectThinkPrompt(false, true, ON)).toBe(true);
    expect(shouldInjectThinkPrompt(false, true, { ...ON, injectThinkGuide: false })).toBe(false);
  });
  it('非推理模型不注入', () => {
    expect(shouldInjectThinkPrompt(false, false, ON)).toBe(false);
  });
});
