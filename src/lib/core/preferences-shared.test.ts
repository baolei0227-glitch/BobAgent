/**
 * 常驻档安全阀（selectResidentTypes）回归 —— 纯函数，无需落盘。
 *
 * 背景（2026-10-02 改）：此前是**整体退化**——`身份画像 + 偏好习惯` 合计超 `ALWAYS_INJECTED_MAX`
 * 时，连身份画像也一起掉进目录档，用户会突然觉得「它不记得我了」，而这正是常驻档存在的理由。
 * 本组锁住四条：
 *   ① 未超限 → 两个常驻类型都在；
 *   ② 超限时**先丢低优先级**（偏好习惯走目录档，身份画像仍在正文）；
 *   ③ 高优先级自己就超限 → 它也保不住（总量仍被 max 封顶，不能无限注入）；
 *   ④ 空/未知类型不影响结果（缺失即 0）。
 */
import { describe, expect, it } from 'vitest';
import { ALWAYS_INJECTED_MAX, ALWAYS_INJECTED_TYPES, selectResidentTypes } from './preferences-shared';

describe('selectResidentTypes —— 常驻档安全阀', () => {
  it('未超上限：身份画像与偏好习惯都保常驻', () => {
    expect(selectResidentTypes({ 身份画像: 3, 偏好习惯: 2 })).toEqual(['身份画像', '偏好习惯']);
    expect(ALWAYS_INJECTED_TYPES[0]).toBe('身份画像'); // 优先级约定：靠前更该保
  });

  it('合计超上限：先丢低优先级（偏好习惯转目录档），身份画像仍在正文', () => {
    // 3 + 25 = 28 > 20 → 偏好习惯整体退回目录档；身份画像（3）保留
    expect(selectResidentTypes({ 身份画像: 3, 偏好习惯: 25 })).toEqual(['身份画像']);
  });

  it('高优先级自己就超上限：它也保不住，且不跳过它去纳低优先级（取优先级前缀）', () => {
    // 22 > 20：身份画像放不下 → 就此打住；**不能**出现「偏好习惯在常驻、身份画像在目录」的倒挂
    expect(selectResidentTypes({ 身份画像: ALWAYS_INJECTED_MAX + 2, 偏好习惯: 1 })).toEqual([]);
  });

  it('恰好等于上限 → 保留；空表 / 未知类型 → 忽略（缺失即 0）', () => {
    expect(selectResidentTypes({ 身份画像: 5, 偏好习惯: ALWAYS_INJECTED_MAX - 5 })).toEqual([
      '身份画像',
      '偏好习惯',
    ]);
    expect(selectResidentTypes({})).toEqual([]);
    expect(selectResidentTypes({ 工作上下文: 99 })).toEqual([]);
  });
});
