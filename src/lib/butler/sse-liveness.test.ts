import { describe, expect, it } from 'vitest';
import { SSE_STALL_SEC, stalledSeconds } from '@/lib/butler/sse-liveness';

/**
 * 看门狗阈值语义回归（2026-10-06）。
 *
 * 锁定三件事，因为它们在 UI 上意味着完全不同的两句话：
 *   ① 只有**到阈值**才算断流（差 1 秒不算）——阈值以上必须给出真实秒数，用户才知道等了多久；
 *   ② 说话期间（字节刚到）必须是 0——否则正常的流式回复会一直挂着"连接可能断了"；
 *   ③ 时钟回拨 / 未开始 / 非法输入一律 0——不能出现"断了 -3 秒"或 NaN 秒这种界面。
 */
describe('SSE 看门狗：断流判定', () => {
  const T0 = 1_800_000_000_000;

  it('阈值下方不算断流，阈值（含）起给真实秒数', () => {
    expect(stalledSeconds(T0, T0)).toBe(0);
    expect(stalledSeconds(T0, T0 + 59_000)).toBe(0);
    expect(stalledSeconds(T0, T0 + 60_000)).toBe(60);
    expect(stalledSeconds(T0, T0 + 74_500)).toBe(74);
  });

  it('阈值可由调用方下压（便于测试与将来按链路调参）', () => {
    expect(stalledSeconds(T0, T0 + 3_000, 3)).toBe(3);
    expect(stalledSeconds(T0, T0 + 2_000, 3)).toBe(0);
  });

  it('未开始 / 非法输入 / 时钟回拨 → 0（不误报、不出现负数秒）', () => {
    expect(stalledSeconds(0, T0)).toBe(0);
    expect(stalledSeconds(Number.NaN, T0)).toBe(0);
    expect(stalledSeconds(T0, Number.NaN)).toBe(0);
    expect(stalledSeconds(T0, T0 - 5_000)).toBe(0);
    expect(stalledSeconds(T0, T0, Number.NaN)).toBe(0);
  });

  it('默认阈值是 60s（服务端长工具心跳 20s 的三倍，留足 TTFT 余量）', () => {
    expect(SSE_STALL_SEC).toBe(60);
    expect(SSE_STALL_SEC).toBeGreaterThanOrEqual(20 * 3);
  });
});
