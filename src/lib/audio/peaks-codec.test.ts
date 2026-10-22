import { describe, expect, it } from 'vitest';
import { decodeFine, encodeFine, mergeMicrosPairs, sliceFineWindow } from './peaks-codec';

describe('mergeMicrosPairs（10ms 微桶 → 20ms 细桶）', () => {
  it('两两合并取绝对值最大者（保号）', () => {
    expect(mergeMicrosPairs([0.5, -0.9, 0.3, 0.2])).toEqual([-0.9, 0.3]);
  });

  it('奇数长度时尾部单个微桶单独成桶（不丢最后 10ms）', () => {
    expect(mergeMicrosPairs([0.1, 0.2, -0.7])).toEqual([0.2, -0.7]);
  });

  it('空输入 → 空输出', () => {
    expect(mergeMicrosPairs([])).toEqual([]);
  });
});

describe('encodeFine / decodeFine（int8 + base64）', () => {
  it('往返保号且误差 ≤ 1/127', () => {
    const src = [-1, -0.5, 0, 0.25, 1, 0.999];
    const back = Array.from(decodeFine(encodeFine(src)));
    expect(back.length).toBe(src.length);
    src.forEach((v, i) => {
      expect(Math.abs(back[i] / 127 - v)).toBeLessThanOrEqual(1 / 127);
    });
  });

  it('负数不会被写成无符号（int8 符号位是关键）', () => {
    const back = Array.from(decodeFine(encodeFine([-1])));
    expect(back[0]).toBe(-127);
  });

  it('越界与非法值被夹紧/归零（不产生 NaN 字节）', () => {
    const back = Array.from(decodeFine(encodeFine([2, -3, Number.NaN])));
    expect(back).toEqual([127, -127, 0]);
  });

  it('体积压缩：1000 个样本的 base64 长度 < 1400（≈ 4/3 × 1000）', () => {
    const b64 = encodeFine(Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 0.5));
    expect(b64.length).toBeLessThan(1400);
  });
});

describe('sliceFineWindow（窗口切片 + 降采样）', () => {
  const hz = 50; // 20ms 一桶
  // 3 秒数据：每秒 50 桶，值 = 桶序号/149（便于定位）
  const fine = Int8Array.from({ length: 150 }, (_, i) => Math.round((i / 149) * 127));

  it('整段切片：点数 = 请求值；因每点取区间 abs-max ⇒ 单调递增的数据应逐点变大（首点不是 0）', () => {
    const out = sliceFineWindow(fine, hz, 0, 3, 10);
    expect(out.length).toBe(10);
    // 数据是 i/149 递增 ⇒ 每个 15 桶区间的最大值 = 区间末桶 ⇒ 逐点严格变大
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
    expect(out[9]).toBeGreaterThan(0.9);
  });

  it('🔴 窗口偏移：取 [1s, 1.2s) 时读到的是**中间那段**（不是从头开始）', () => {
    const out = sliceFineWindow(fine, hz, 1.0, 0.2, 5);
    expect(out.length).toBe(5);
    // 1.0–1.2s 对应桶 50..60 ⇒ 值域 [50/149, 59/149] ≈ [0.335, 0.396]（/127 后约 0.33–0.40）
    for (const v of out) expect(v).toBeGreaterThan(0.30);
    for (const v of out) expect(v).toBeLessThan(0.45);
  });

  it('每点取区间内 abs-max：负值更"大"时输出为负', () => {
    const spiky = Int8Array.from([10, -100, 20, 30, 40, 50, 60, 70, 80, 90]);
    const out = sliceFineWindow(spiky, 10, 0, 1, 1); // 全段一个点
    expect(out[0]).toBeLessThan(0);
    expect(out[0]).toBeCloseTo(-100 / 127, 3);
  });

  it('窗口超出数据尾部 ⇒ 夹取（拿到的是真实存在的部分，不是补零）', () => {
    const out = sliceFineWindow(fine, hz, 2.5, 10, 8);
    expect(out.length).toBeGreaterThan(0);
    for (const v of out) expect(v).toBeGreaterThan(0.8); // 尾部值都大
  });

  it('完全在数据之外 ⇒ 空数组（调用方降级，不画假波形）', () => {
    expect(sliceFineWindow(fine, hz, 100, 1, 10)).toEqual([]);
    expect(sliceFineWindow(fine, hz, 0, 0, 10)).toEqual([]);
  });

  it('非法输入（点数/时长/频率）一律空数组，不抛', () => {
    expect(sliceFineWindow(fine, hz, 0, 1, 0)).toEqual([]);
    expect(sliceFineWindow(fine, hz, 0, 1, Number.NaN)).toEqual([]);
    expect(sliceFineWindow(fine, 0, 0, 1, 10)).toEqual([]);
    expect(sliceFineWindow(new Int8Array(0), hz, 0, 1, 10)).toEqual([]);
  });

  it('点数多于桶数时按桶数上限返回（不靠重复值凑数）', () => {
    const out = sliceFineWindow(fine, hz, 0, 0.2, 100); // 只有 10 个桶
    expect(out.length).toBe(10);
  });
});
