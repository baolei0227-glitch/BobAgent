import { describe, expect, it } from 'vitest';
import {
  TICK_LABEL_FALLBACK_PX,
  clampSeekTime,
  clampViewStart,
  tickStopsForWindow,
  TICK_LABEL_GAP_PX,
  TICK_MAX_LABELS,
  mmss2,
  tickLabelRightAligned,
  tickLabelsForWidth,
  tickStops,
} from './timeline';

describe('mmss2（时间线两位小数）', () => {
  it('常规格式化：补零到 mm:ss.cc', () => {
    expect(mmss2(0)).toBe('00:00.00');
    expect(mmss2(2)).toBe('00:02.00');
    expect(mmss2(61.5)).toBe('01:01.50');
    expect(mmss2(3599.99)).toBe('59:59.99');
  });

  it('🔴 厘秒进位不产生非法时间（59.995 → 01:00.00，而不是 00:60.00）', () => {
    expect(mmss2(59.995)).toBe('01:00.00');
    expect(mmss2(119.999)).toBe('02:00.00');
  });

  it('非法输入回落占位符（不抛、不显示 NaN）', () => {
    expect(mmss2(Number.NaN)).toBe('--:--.--');
    expect(mmss2(-1)).toBe('--:--.--');
  });
});

describe('tickLabelsForWidth（按可用宽度决定刻度个数）', () => {
  it('没量到宽度时按上限（首帧不闪空）', () => {
    expect(tickLabelsForWidth(0)).toBe(TICK_MAX_LABELS);
    expect(tickLabelsForWidth(Number.NaN)).toBe(TICK_MAX_LABELS);
  });

  it('🔴 272px 面板（内容宽 188）：必须收敛到 3 个，否则 8 字符标签会叠字', () => {
    expect(tickLabelsForWidth(188)).toBe(3);
    // 叠字是可算出来的：6 个标签需要 6*48 + 5*8 = 328px > 188（默认档实测标签宽 48px）
    expect(6 * TICK_LABEL_FALLBACK_PX + 5 * TICK_LABEL_GAP_PX).toBeGreaterThan(188);
  });

  it('420px 面板（内容宽 356）：回到上限 6 个', () => {
    expect(tickLabelsForWidth(356)).toBe(TICK_MAX_LABELS);
  });

  it('极窄时保底 2 个（不出现 0/1 个这种读不出刻度的状态）', () => {
    expect(tickLabelsForWidth(40)).toBe(2);
    expect(tickLabelsForWidth(1)).toBe(2);
  });

  it('🔴 性质：宽度足够时，渲染出的标签总宽 + 间隙不超过可用宽度（不会叠字）', () => {
    // 下界取 104px = 2 个标签刚好放下的宽度（2*48 + 8）。比这更窄连 2 个都放不下，
    // 而面板最小宽 272（内容宽 188）远大于它 ⇒ 现实不可达，函数在此之下**保底 2 个**不再继续减。
    for (let w = 104; w <= 800; w += 3) {
      const n = tickLabelsForWidth(w);
      const total = n * TICK_LABEL_FALLBACK_PX + (n - 1) * TICK_LABEL_GAP_PX;
      // 实测标签宽 + 间隙必须装得下（字号档位放大由"实测回灌"覆盖，这里用默认档实测值）
      expect(total).toBeLessThanOrEqual(w + 1);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(TICK_MAX_LABELS);
    }
    // 保底：比 2 个标签还窄时不再继续减（否则会出现"一个刻度都没有"这种读不出时间的状态）
    expect(tickLabelsForWidth(103)).toBe(2);
    expect(tickLabelsForWidth(20)).toBe(2);
  });
});

describe('tickStops（步长选择）', () => {
  it('12s 音频：6 个上限 → 每 2s 一个；3 个上限 → 每 5s 一个', () => {
    expect(tickStops(12, 6)).toEqual([0, 2, 4, 6, 8, 10]);
    // ⚠️ 末尾**半格内不放标签**（避免贴边），故 10s 那个点被刻意排除 ⇒ [0, 5]
    expect(tickStops(12, 3)).toEqual([0, 5]);
  });

  it('3401s 长音频：长音频自动稀疏（6 个上限 → 每 10 分钟；3 个上限 → 每 30 分钟）', () => {
    // 步长取"第一个让 3401/step ≤ 上限"的候选：上限 6 → 600s（正好 6 个）
    expect(tickStops(3401, 6)).toEqual([0, 600, 1200, 1800, 2400, 3000]);
    expect(tickStops(3401, 3)).toEqual([0, 1800]);
  });

  it('时长非法 → 空数组（不生成到 0 秒的假刻度）', () => {
    expect(tickStops(0, 6)).toEqual([]);
    expect(tickStops(Number.NaN, 6)).toEqual([]);
    expect(tickStops(-5, 6)).toEqual([]);
  });

  it('末尾不生成越界刻度（最后一个是 ≤ duration 的步长点）', () => {
    const out = tickStops(10, 6);
    expect(out.every((t) => t < 10)).toBe(true);
  });
});

describe('tickLabelRightAligned（右缘溢出安全网）', () => {
  it('靠右（>88%）才右对齐；中间与开头不翻转', () => {
    expect(tickLabelRightAligned(9.5, 10)).toBe(true);
    expect(tickLabelRightAligned(5, 10)).toBe(false);
    expect(tickLabelRightAligned(0, 10)).toBe(false);
    expect(tickLabelRightAligned(1, 0)).toBe(false);
  });
});

describe('clampViewStart（窗口起点夹取）', () => {
  it('常规：夹进 [0, total − sec]', () => {
    expect(clampViewStart(50, 20, 100)).toBe(50);
    expect(clampViewStart(-5, 20, 100)).toBe(0);
    expect(clampViewStart(95, 20, 100)).toBe(80);
  });

  it('窗口比总时长还长 ⇒ 起点只能是 0（不出现负的 maxStart）', () => {
    expect(clampViewStart(10, 500, 100)).toBe(0);
  });

  it('非法输入回落 0 / 不抛', () => {
    expect(clampViewStart(Number.NaN, 20, 100)).toBe(0);
    expect(clampViewStart(10, 20, Number.NaN)).toBe(0);
    expect(clampViewStart(10, 20, 0)).toBe(0);
  });
});

describe('clampSeekTime（播放头定位夹取：←/→ 的 ±3 秒、句柄 seek）', () => {
  it('常规：夹进 [0, 总时长]（**可以**一直走到 total 本身，与 clampViewStart 不同）', () => {
    expect(clampSeekTime(5, 10)).toBe(5);
    expect(clampSeekTime(10, 10)).toBe(10); // 走到末尾合法
    expect(clampSeekTime(-3, 10)).toBe(0); // 从头往回退 ⇒ 停在 0
    expect(clampSeekTime(12.4, 10)).toBe(10); // 越过末尾 ⇒ 停在 total
  });

  it('总时长未知（0 / NaN，波形未就绪）⇒ 只保证非负，不把"前进 3 秒"夹成 0', () => {
    expect(clampSeekTime(7, 0)).toBe(7);
    expect(clampSeekTime(7, Number.NaN)).toBe(7);
    expect(clampSeekTime(-7, 0)).toBe(0);
  });

  it('🔴 t 非法（NaN / ±Infinity）⇒ 0：绝不把 NaN 交给播放库（否则播放轴整条坏掉）', () => {
    expect(clampSeekTime(Number.NaN, 10)).toBe(0);
    expect(clampSeekTime(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(clampSeekTime(Number.NEGATIVE_INFINITY, 10)).toBe(0);
  });
});

describe('tickStopsForWindow（缩放后的窗口刻度）', () => {
  it('🔴 刻度对齐到步长整数倍（缩放/平移时不会整体漂移）', () => {
    // 窗口 [7.3, 27.3)：步长命中 5s 档（20/5 = 4 ≤ 6）⇒ 刻度落在 5 的整数倍上
    const out = tickStopsForWindow(7.3, 20, 6);
    // ⚠️ 25 被"尾部半格内不放"规则排除（27.3 − 2.5 = 24.8 < 25），与整段模式同规则
    expect(out).toEqual([10, 15, 20]);
    for (const t of out) expect(t % 5).toBe(0);
  });

  it('窗口越窄刻度越密（2s 窗口用 0.5s 以下步长不可得 ⇒ 至少给出 1s 档）', () => {
    const wide = tickStopsForWindow(0, 600, 6);
    const narrow = tickStopsForWindow(100, 2, 6);
    expect(wide.length).toBeGreaterThan(0);
    expect(narrow.length).toBeGreaterThan(0);
    // 窄窗口的步长必须更小：相邻刻度间距
    const gapWide = wide.length > 1 ? wide[1] - wide[0] : Infinity;
    const gapNarrow = narrow.length > 1 ? narrow[1] - narrow[0] : Infinity;
    expect(gapNarrow).toBeLessThan(gapWide);
  });

  it('窗口比一个步长还窄 ⇒ 至少给一个刻度（不出现空刻度行）', () => {
    const out = tickStopsForWindow(12.5, 0.2, 6);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it('尾部半格内不放刻度（与整段模式同规则）', () => {
    const out = tickStopsForWindow(0, 12, 6);
    expect(out).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('非法输入 → 空数组', () => {
    expect(tickStopsForWindow(0, 0)).toEqual([]);
    expect(tickStopsForWindow(Number.NaN, 10)).toEqual([]);
  });
});
