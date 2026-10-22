import { describe, expect, it } from 'vitest';
import {
  clampWindowSec,
  DEFAULT_WINDOW_SEC,
  MAX_WINDOW_SEC,
  MIN_WINDOW_SEC,
  mergeSegments,
  planWindows,
  runWindows,
  TAIL_MERGE_SEC,
} from '@/lib/audio/windowed';
import type { TranscriptSegment } from '@/lib/audio/transcript';

/** 造一段（t 秒起，正文可辨） */
const seg = (t: number, text: string, end = t + 10): TranscriptSegment => ({ t, end, speaker: null, text });

describe('clampWindowSec', () => {
  it('夹到 [MIN, MAX]，非法输入取默认', () => {
    expect(clampWindowSec(0)).toBe(DEFAULT_WINDOW_SEC);
    expect(clampWindowSec(-5)).toBe(DEFAULT_WINDOW_SEC);
    expect(clampWindowSec('abc')).toBe(DEFAULT_WINDOW_SEC);
    expect(clampWindowSec(1)).toBe(MIN_WINDOW_SEC);
    expect(clampWindowSec(99_999)).toBe(MAX_WINDOW_SEC);
    expect(clampWindowSec(600)).toBe(600);
  });

  it('🔴 窗口上限必须严格小于 parse 层的 1800s 硬上限（留余量的前提）', () => {
    expect(MAX_WINDOW_SEC).toBeLessThan(1800);
    expect(DEFAULT_WINDOW_SEC).toBeLessThan(1800);
  });
});

describe('planWindows', () => {
  it('短音频 = 单窗（与老路径逐字一致，不引入额外行为）', () => {
    expect(planWindows(12)).toEqual([{ start: 0, end: 12 }]);
    expect(planWindows(1200)).toEqual([{ start: 0, end: 1200 }]);
  });

  it('🔴 用户实际那一例：3401s → 全部落在合法窗口内且无缝无重叠', () => {
    const plan = planWindows(3401);
    expect(plan.length).toBeGreaterThan(1);
    expect(plan[0].start).toBe(0);
    expect(plan[plan.length - 1].end).toBe(3401);
    // 每一窗都严格小于 1800s（parse 层的上限）
    for (const w of plan) expect(w.end - w.start).toBeLessThan(1800);
    // 无缝无重叠
    for (let i = 1; i < plan.length; i++) expect(plan[i].start).toBe(plan[i - 1].end);
  });

  it('末窗过短则并入前一窗（不为几秒尾巴多付一次 STT）', () => {
    const plan = planWindows(2500, 1200); // 1200 + 1200 + 100 ⇒ 末窗 100s < TAIL_MERGE_SEC
    expect(plan).toEqual([
      { start: 0, end: 1200 },
      { start: 1200, end: 2500 },
    ]);
    expect(plan[1].end - plan[1].start).toBe(1300);
  });

  it('末窗够长就独立成窗', () => {
    const plan = planWindows(3000, 1200); // 1200+1200+600
    expect(plan).toHaveLength(3);
    expect(plan[2]).toEqual({ start: 2400, end: 3000 });
    expect(plan[2].end - plan[2].start).toBeGreaterThanOrEqual(TAIL_MERGE_SEC);
  });

  it('断点续跑：从 coveredUntilSec 继续（第一窗即从该点起）', () => {
    expect(planWindows(3401, 1200, 1200)).toEqual([
      { start: 1200, end: 2400 },
      { start: 2400, end: 3401 },
    ]);
  });

  it('无内容可转 → 空数组（不抛错）', () => {
    expect(planWindows(0)).toEqual([]);
    expect(planWindows(-1)).toEqual([]);
    expect(planWindows(Number.NaN)).toEqual([]);
    expect(planWindows(100, 1200, 100)).toEqual([]);
    expect(planWindows(100, 1200, 200)).toEqual([]);
  });
});

describe('mergeSegments', () => {
  it('按 t 升序合并两批（窗口结果拼接）', () => {
    const a = [seg(0, '窗口1-甲'), seg(30, '窗口1-乙')];
    const b = [seg(1205, '窗口2-甲'), seg(1300, '窗口2-乙')];
    expect(mergeSegments(a, b).map((s) => s.t)).toEqual([0, 30, 1205, 1300]);
  });

  it('🔴 同一时刻（0.1s 精度）只留一条 —— 续跑重叠/重复窗口的幂等保护', () => {
    const a = [seg(0, '旧'), seg(10, '保留')];
    const b = [seg(0, '新')];
    const out = mergeSegments(a, b);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.t === 0)?.text).toBe('新');
  });

  it('丢弃空正文的段（不与 parse 层的过滤口径冲突）', () => {
    expect(mergeSegments([seg(0, '  ')], [seg(5, '有效')])).toEqual([seg(5, '有效')]);
  });
});

describe('runWindows', () => {
  it('逐窗串行、累积段、每窗回调一次落盘', () => {
    const plan = planWindows(3401, 1200);
    const calls: number[] = [];
    const saved: number[] = [];
    return runWindows({
      plan,
      transcribeWindow: async (w) => {
        calls.push(w.start);
        return [seg(w.start, `窗 ${w.start}`)];
      },
      onProgress: (p) => {
        saved.push(p.coveredUntilSec);
        expect(p.total).toBe(plan.length);
      },
    }).then((res) => {
      expect(calls).toEqual(plan.map((w) => w.start));
      expect(saved).toEqual(plan.map((w) => w.end)); // 每窗完成后都落了一次盘
      expect(res.done).toBe(plan.length);
      expect(res.coveredUntilSec).toBe(3401);
      expect(res.segments.map((s) => s.t)).toEqual(plan.map((w) => w.start));
    });
  });

  it('🔴 空窗口（这一窗没语音）照常推进，不卡住整段', () => {
    const plan = planWindows(300, 100);
    return runWindows({
      plan,
      transcribeWindow: async (w) => (w.start === 100 ? [] : [seg(w.start, `窗 ${w.start}`)]),
    }).then((res) => {
      expect(res.done).toBe(3);
      expect(res.coveredUntilSec).toBe(300);
      expect(res.segments.map((s) => s.t)).toEqual([0, 200]);
    });
  });

  it('🔴 中途真错误立即抛出，但已完成窗口的进度**已经落盘**（续跑的依据）', async () => {
    const plan = planWindows(300, 100);
    const saved: number[] = [];
    await expect(
      runWindows({
        plan,
        transcribeWindow: async (w) => {
          if (w.start === 200) throw new Error('网络炸了');
          return [seg(w.start, `窗 ${w.start}`)];
        },
        onProgress: (p) => {
          saved.push(p.coveredUntilSec);
        },
      }),
    ).rejects.toThrow('网络炸了');
    expect(saved).toEqual([100, 200]); // 前两窗已落盘 ⇒ 下次从 200 续跑
  });

  it('续跑：传入 existing 段与 from 之后的计划，结果与一次跑完等价', async () => {
    const existing = [seg(0, '窗 0')];
    const res = await runWindows({
      plan: planWindows(300, 100, 100),
      existing,
      transcribeWindow: async (w) => [seg(w.start, `窗 ${w.start}`)],
    });
    expect(res.segments.map((s) => s.t)).toEqual([0, 100, 200]);
    expect(res.coveredUntilSec).toBe(300);
  });
});
