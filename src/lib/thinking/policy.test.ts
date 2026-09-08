import { describe, expect, it } from 'vitest';
import {
  effortForLevel,
  executionDowngrade,
  isTrivialPrompt,
  shouldInjectThinkPrompt,
  type ThinkingPolicyConfig,
} from './policy';

/** 旧业务插件路径（harnessPure=false）：执行轮降级 + C1 全开 */
const LEGACY_ON: ThinkingPolicyConfig = { harnessPure: false, downgradeOnExecution: true, trivialPromptOff: true };
/** 纯 DSH 固定档（S2a 默认）：不降级、不 C1 */
const PURE: ThinkingPolicyConfig = { harnessPure: true, downgradeOnExecution: true, trivialPromptOff: true };
const LEGACY_OFF_DOWNGRADE: ThinkingPolicyConfig = { harnessPure: false, downgradeOnExecution: false, trivialPromptOff: true };
const LEGACY_OFF_TRIVIAL: ThinkingPolicyConfig = { harnessPure: false, downgradeOnExecution: true, trivialPromptOff: false };

describe('thinking policy: effortForLevel（S2b 四档统一 reasoning_effort 词表）', () => {
  it('UI 档位映射：low→low、medium(legacy)→high、high→high、max→max', () => {
    expect(effortForLevel('low', PURE)).toBe('low');
    expect(effortForLevel('medium', PURE)).toBe('high');
    expect(effortForLevel('high', PURE)).toBe('high');
    expect(effortForLevel('max', PURE)).toBe('max');
  });
  it('off 显式 → none', () => {
    expect(effortForLevel('off', PURE)).toBe('none');
    expect(effortForLevel('off', LEGACY_ON, true)).toBe('none');
  });
  it('C1 琐碎关思考 = reasoning_effort: none（仅 harnessPure=false && trivialPromptOff && 非 high/max）', () => {
    expect(effortForLevel('medium', LEGACY_ON, true)).toBe('none');
    expect(effortForLevel('low', LEGACY_ON, true)).toBe('none');
    expect(effortForLevel('high', LEGACY_ON, true)).toBe('high'); // 尊重用户高档，不 C1
    expect(effortForLevel('max', LEGACY_ON, true)).toBe('max'); // 尊重用户 max，不 C1
    expect(effortForLevel('medium', LEGACY_OFF_TRIVIAL, true)).toBe('high'); // trivialPromptOff 关闭不降
  });
  it('harnessPure=true（纯固定档）忽略 trivial，不 C1 关思考', () => {
    expect(effortForLevel('medium', PURE, true)).toBe('high');
    expect(effortForLevel('low', PURE, true)).toBe('low');
    expect(effortForLevel('high', PURE, true)).toBe('high');
    expect(effortForLevel('max', PURE, true)).toBe('max');
  });
});

describe('thinking policy: executionDowngrade（effort 降级表，仅 harnessPure=false）', () => {
  it('纯固定档（harnessPure=true）任何执行轮都不降级', () => {
    expect(executionDowngrade(2, false, 'high', PURE)).toBeNull();
    expect(executionDowngrade(2, false, 'medium', PURE)).toBeNull();
    expect(executionDowngrade(2, false, 'low', PURE)).toBeNull();
    expect(executionDowngrade(2, false, 'max', PURE)).toBeNull();
  });
  it('规划轮/收尾轮/开关关 → 不降级（legacy）', () => {
    expect(executionDowngrade(0, false, 'high', LEGACY_ON)).toBeNull();
    expect(executionDowngrade(2, true, 'high', LEGACY_ON)).toBeNull();
    expect(executionDowngrade(2, false, 'high', LEGACY_OFF_DOWNGRADE)).toBeNull();
  });
  it('legacy 执行轮降级（按 effort 降级表）：low→none、medium→low、high→low、max→high', () => {
    // 基点 = effortForLevel：low→low→降 none；medium→high→降 low；high→high→降 low；max→max→降 high
    expect(executionDowngrade(2, false, 'low', LEGACY_ON)?.reasoningEffort).toBe('none');
    expect(executionDowngrade(2, false, 'medium', LEGACY_ON)?.reasoningEffort).toBe('low');
    expect(executionDowngrade(2, false, 'high', LEGACY_ON)?.reasoningEffort).toBe('low');
    expect(executionDowngrade(2, false, 'max', LEGACY_ON)?.reasoningEffort).toBe('high');
  });
  it('legacy 执行轮 + trivialPromptOff 关闭：仍按档位基点降级（C1 属 effortForLevel 层，不影响降级表）', () => {
    expect(executionDowngrade(2, false, 'medium', LEGACY_OFF_TRIVIAL)?.reasoningEffort).toBe('low');
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
    expect(shouldInjectThinkPrompt(true, true, LEGACY_ON)).toBe(false);
    expect(shouldInjectThinkPrompt(true, false, LEGACY_ON)).toBe(false);
  });
  it('非 V4 推理模型默认注入 think 引导，可经 injectThinkGuide 关闭', () => {
    expect(shouldInjectThinkPrompt(false, true, LEGACY_ON)).toBe(true);
    expect(shouldInjectThinkPrompt(false, true, { ...LEGACY_ON, injectThinkGuide: false })).toBe(false);
  });
  it('非推理模型不注入', () => {
    expect(shouldInjectThinkPrompt(false, false, LEGACY_ON)).toBe(false);
  });
});
