import { describe, expect, it } from 'vitest';
import { computeFreeSlots, mergeIntervals, type TimeInterval } from '@/lib/calendar/availability';

/**
 * 可用性层纯计算部分的不变量：忙碌区间合并 + 工作时段内 first-fit 找空档。
 * 全部用**本地时间**构造，避免 CI 换时区导致用例飘。
 */

const at = (y: number, m: number, d: number, h = 0, mi = 0): number =>
  new Date(y, m - 1, d, h, mi).getTime();

const MIN = 60_000;

describe('mergeIntervals', () => {
  it('合并重叠与相接的区间（乱序输入亦可）', () => {
    expect(mergeIntervals([
      { startMs: at(2026, 9, 28, 10, 0), endMs: at(2026, 9, 28, 10, 30) },
      { startMs: at(2026, 9, 28, 9, 0), endMs: at(2026, 9, 28, 10, 0) }, // 与上一条相接 → 并成一条
      { startMs: at(2026, 9, 28, 11, 0), endMs: at(2026, 9, 28, 12, 0) }, // 独立
    ])).toEqual([
      { startMs: at(2026, 9, 28, 9, 0), endMs: at(2026, 9, 28, 10, 30) },
      { startMs: at(2026, 9, 28, 11, 0), endMs: at(2026, 9, 28, 12, 0) },
    ]);
  });

  it('丢弃零长 / 负长区间', () => {
    expect(mergeIntervals([
      { startMs: 100, endMs: 100 },
      { startMs: 200, endMs: 150 },
    ])).toEqual([]);
  });
});

describe('computeFreeSlots', () => {
  const day = { fromMs: at(2026, 9, 28, 9, 0), toMs: at(2026, 9, 28, 18, 0) };

  it('绕开忙碌区间给出空档（30 分钟网格、first-fit）', () => {
    const busy: TimeInterval[] = [{ startMs: at(2026, 9, 28, 10, 0), endMs: at(2026, 9, 28, 11, 0) }];
    const free = computeFreeSlots({
      busy, ...day,
      durationMs: 60 * MIN, workStartHour: 9, workEndHour: 18, gapMs: 0, limit: 2,
      notBeforeMs: day.fromMs,
    });
    expect(free).toEqual([
      { startMs: at(2026, 9, 28, 9, 0), endMs: at(2026, 9, 28, 10, 0) },
      { startMs: at(2026, 9, 28, 11, 0), endMs: at(2026, 9, 28, 12, 0) },
    ]);
  });

  it('gap 缓冲：与忙碌区间贴太近的候选被剔除', () => {
    const busy: TimeInterval[] = [{ startMs: at(2026, 9, 28, 10, 0), endMs: at(2026, 9, 28, 11, 0) }];
    const free = computeFreeSlots({
      busy, ...day,
      durationMs: 60 * MIN, workStartHour: 9, workEndHour: 18, gapMs: 30 * MIN, limit: 1,
      notBeforeMs: day.fromMs,
    });
    // 9:00–10:00 与 11:00–12:00 都与忙碌区间贴 0 分钟，不满足 30 分钟缓冲 → 首个可选是 11:30–12:30
    expect(free).toEqual([{ startMs: at(2026, 9, 28, 11, 30), endMs: at(2026, 9, 28, 12, 30) }]);
  });

  it('notBefore：过去的时间不是候选（对齐到网格）', () => {
    const free = computeFreeSlots({
      busy: [], ...day,
      durationMs: 60 * MIN, workStartHour: 9, workEndHour: 18, gapMs: 0, limit: 1,
      notBeforeMs: at(2026, 9, 28, 13, 20),
    });
    expect(free).toEqual([{ startMs: at(2026, 9, 28, 13, 30), endMs: at(2026, 9, 28, 14, 30) }]);
  });

  it('整天被占 → 无空档', () => {
    const free = computeFreeSlots({
      busy: [{ startMs: day.fromMs, endMs: day.toMs }], ...day,
      durationMs: 60 * MIN, workStartHour: 9, workEndHour: 18, gapMs: 0, limit: 3,
      notBeforeMs: day.fromMs,
    });
    expect(free).toEqual([]);
  });

  it('当天排满则顺延到次日', () => {
    const free = computeFreeSlots({
      busy: [{ startMs: day.fromMs, endMs: day.toMs }],
      fromMs: day.fromMs, toMs: at(2026, 9, 29, 18, 0),
      durationMs: 60 * MIN, workStartHour: 9, workEndHour: 18, gapMs: 0, limit: 1,
      notBeforeMs: day.fromMs,
    });
    expect(free).toEqual([{ startMs: at(2026, 9, 29, 9, 0), endMs: at(2026, 9, 29, 10, 0) }]);
  });
});