import { describe, expect, it } from 'vitest';
import {
  AUTO_MARK_LABEL_MAX,
  AUTO_MARK_MIN_GAP_SEC,
  dropAutoMarks,
  markLabelFromText,
  marksFromRanges,
  anchorSelectionEdge,
  packMarkLabels,
  ruleHighlights,
  snapToMark,
  snapToRefs,
  splitRangesAtMarks,
} from '@/lib/audio/mark-ops';
import type { AudioMark } from '@/lib/audio/marks';
import type { TranscriptSegment } from '@/lib/audio/transcript';

describe('markLabelFromText', () => {
  it('压平空白并去首尾', () => {
    expect(markLabelFromText('  今天\n先过  一下预算 ')).toBe('今天 先过 一下预算');
  });

  it('空/纯空白 → undefined（不写空标签）', () => {
    expect(markLabelFromText('')).toBeUndefined();
    expect(markLabelFromText('  \n\t ')).toBeUndefined();
  });

  it('超长按码点截断并加省略号（不切坏代理对）', () => {
    const long = '🎧'.repeat(30);
    const out = markLabelFromText(long, 5);
    expect(out).toBe('🎧🎧🎧🎧🎧…');
    expect([...(out ?? '')].length).toBe(6);
  });
});

describe('marksFromRanges（把选中的建议落成点）', () => {
  const ranges = [
    { start: 0, label: '开场白' },
    { start: 30, label: '预算分配' },
    { start: 70, label: '排期问题' },
  ];

  it('每个区间落一个点，带标题标签与 auto 位', () => {
    const { marks, added, skipped } = marksFromRanges(ranges, []);
    expect(added).toBe(3);
    expect(skipped).toBe(0);
    expect(marks).toEqual([
      { t: 0, label: '开场白', auto: true },
      { t: 30, label: '预算分配', auto: true },
      { t: 70, label: '排期问题', auto: true },
    ]);
  });

  it('🔴 绝不改动手打点：已有的点（含标签）原样保留，只追加', () => {
    const existing: AudioMark[] = [{ t: 0.2, label: '我自己打的点' }];
    const { marks, added, skipped } = marksFromRanges(ranges, existing);
    expect(marks).toContainEqual({ t: 0.2, label: '我自己打的点' });
    expect(marks.some((m) => m.t === 0.2 && m.auto)).toBe(false);
    // 0.2 与 0 相距 0.2 < 0.5 ⇒ 第一条被跳过
    expect(added).toBe(2);
    expect(skipped).toBe(1);
  });

  it('🔴 幂等：同一批建议落两次，第二次 added=0（不堆点）', () => {
    const first = marksFromRanges(ranges, []);
    const second = marksFromRanges(ranges, first.marks);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.marks).toEqual(first.marks);
  });

  it('去重阈值边界：正好 0.5s 不跳过、0.4s 跳过（防阈值判据平凡为真）', () => {
    const near = marksFromRanges([{ start: 0.4, label: 'a' }], [{ t: 0 }]);
    expect(near.added).toBe(0);
    const far = marksFromRanges([{ start: 0.5, label: 'a' }], [{ t: 0 }]);
    expect(far.added).toBe(1);
    expect(AUTO_MARK_MIN_GAP_SEC).toBe(0.5);
  });

  it('🔴 没有标题的建议不落点（无名点看不出是什么），起点非法也跳过', () => {
    const out = marksFromRanges(
      [
        { start: 0, label: '' },
        { start: 30, label: '   ' },
        { start: Number.NaN, label: 'x' },
        { start: -1, label: 'y' },
        { start: 70, label: '有效' },
      ],
      [],
    );
    expect(out.added).toBe(1);
    expect(out.skipped).toBe(4);
    expect(out.marks[0].label).toBe('有效');
  });

  it('标签沿用 markLabelFromText：压平空白 + 截断（超长 AI 标题不撑爆名字层）', () => {
    const { marks } = marksFromRanges([{ start: 0, label: '  很长的标题 '.repeat(6) }], []);
    expect([...(marks[0].label ?? '')].length).toBe(AUTO_MARK_LABEL_MAX + 1);
    expect(marks[0].label?.endsWith('…')).toBe(true);
  });

  it('不改动传入的 existing 数组（纯函数）', () => {
    const existing: AudioMark[] = [{ t: 0 }];
    marksFromRanges(ranges, existing);
    expect(existing).toEqual([{ t: 0 }]);
  });

  it('结果恒按 t 升序', () => {
    const shuffled = [
      { start: 70, label: 'c' },
      { start: 0, label: 'a' },
      { start: 30, label: 'b' },
    ];
    const { marks } = marksFromRanges(shuffled, [{ t: 50, label: '手打' }]);
    expect(marks.map((m) => m.t)).toEqual([0, 30, 50, 70]);
  });
});

describe('dropAutoMarks', () => {
  it('只删自动点，手打点全留（含无标签的手打点）', () => {
    const marks: AudioMark[] = [{ t: 1, auto: true }, { t: 2 }, { t: 3, label: '手打' }, { t: 4, auto: true }];
    expect(dropAutoMarks(marks)).toEqual([{ t: 2 }, { t: 3, label: '手打' }]);
  });
});

describe('snapToMark', () => {
  const marks: AudioMark[] = [{ t: 10 }, { t: 20, label: 'x' }, { t: 30 }];

  it('阈值内吸附到最近点', () => {
    expect(snapToMark(10.29, marks)).toBe(10);
    expect(snapToMark(19.8, marks)).toBe(20);
    expect(snapToMark(29.7, marks)).toBe(30);
  });

  it('阈值外原样返回（0.1s 取整）', () => {
    expect(snapToMark(10.31, marks)).toBe(10.3);
    expect(snapToMark(15, marks)).toBe(15);
  });

  it('无打点 / 非法输入原样返回（绝不把 NaN 变成某个点）', () => {
    expect(snapToMark(5, [])).toBe(5);
    expect(Number.isNaN(snapToMark(Number.NaN, marks))).toBe(true);
  });

  it('等距时取更近的语义仍成立（两侧等距 → 有一个被选中且距离 ≤ 阈值）', () => {
    const out = snapToMark(15, [{ t: 14.7 }, { t: 15.3 }], 0.3);
    expect([14.7, 15.3]).toContain(out);
  });
});

describe('splitRangesAtMarks', () => {
  it('按打点切成 N+1 段，首尾补齐', () => {
    expect(splitRangesAtMarks([{ t: 10 }, { t: 25 }], 60)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 25 },
      { start: 25, end: 60 },
    ]);
  });

  it('无打点 → 整段一段', () => {
    expect(splitRangesAtMarks([], 60)).toEqual([{ start: 0, end: 60 }]);
  });

  it('时长未知 → 空数组（不生成"到 0 秒"的空片段）', () => {
    expect(splitRangesAtMarks([{ t: 10 }], 0)).toEqual([]);
    expect(splitRangesAtMarks([{ t: 10 }], Number.NaN)).toEqual([]);
    expect(splitRangesAtMarks([{ t: 10 }], null)).toEqual([]);
  });

  it('越界与过近的打点被丢弃（0 与 duration 处的点不该产生零长段）', () => {
    expect(splitRangesAtMarks([{ t: 0 }, { t: 60 }, { t: 59.99 }], 60)).toEqual([{ start: 0, end: 60 }]);
    expect(splitRangesAtMarks([{ t: 0.05 }, { t: 30 }], 60)).toEqual([
      { start: 0, end: 30 },
      { start: 30, end: 60 },
    ]);
  });

  it('尾部不足一段并入前一段', () => {
    expect(splitRangesAtMarks([{ t: 30 }, { t: 59.97 }], 60)).toEqual([
      { start: 0, end: 30 },
      { start: 30, end: 60 },
    ]);
  });
});

/**
 * 纯规则降级（AI 不可用时的兜底）。判据重点是"**降级路径本身必须可用**"：
 * 首版规则会把 <20s 的块全丢掉 ⇒ 12s 的短录音一条建议都给不出（降级 = 什么都不给），
 * 故这里显式给短音频一条正向用例。
 */
describe('ruleHighlights', () => {
  const seg = (t: number, text: string, speaker: number | null = null, end = t + 10): TranscriptSegment => ({
    t, end, speaker, text,
  });

  it('长音频按约 60s 聚合，标题取块内首段前 12 字', () => {
    const segs = [
      seg(0, '开场与背景介绍'), seg(30, '接着讲背景'), seg(65, '预算分配方案'), seg(95, '排期风险'),
    ];
    const out = ruleHighlights(segs, 120);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].start).toBe(0);
    expect(out[0].title).toBe('开场与背景介绍');
    expect(out[0].end).toBeLessThanOrEqual(120);
    expect(out.every((h) => h.end > h.start && h.end <= 120)).toBe(true);
  });

  it('🔴 短音频（12s）必须给得出建议（降级路径不能自己把自己关掉）', () => {
    const out = ruleHighlights([seg(0, '短录音的一段话', null, 12)], 12);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      start: 0, end: 12, title: '短录音的一段话', reason: '规则切分（未用模型）：按说话人切换 / 约 60s 聚合',
    });
  });

  it('多说话人在切换处切块；单人录音不按段切', () => {
    const duo = [seg(0, '甲说', 0, 10), seg(10, '乙说', 1, 20), seg(20, '甲又说', 0, 30)];
    expect(ruleHighlights(duo, 30).map((h) => h.start)).toEqual([0, 10, 20]);
    const single = [seg(0, 'a', 0, 10), seg(10, 'b', 0, 20)];
    expect(ruleHighlights(single, 20)).toHaveLength(1);
  });

  it('空段/非法时长 → 空数组（不抛错）', () => {
    expect(ruleHighlights([], 100)).toEqual([]);
    expect(ruleHighlights([seg(0, '   ')], 100)).toEqual([]);
    expect(ruleHighlights([seg(0, 'x', null, 0)], 0)).toEqual([]);
  });

  it('条数受 max 限制，且区间不越界', () => {
    const many = Array.from({ length: 40 }, (_, i) => seg(i * 10, `第 ${i} 段`, null, i * 10 + 10));
    const out = ruleHighlights(many, 400, 3);
    expect(out).toHaveLength(3);
    expect(out.every((h) => h.start >= 0 && h.end <= 400)).toBe(true);
  });
});

/**
 * `snapToRefs`：磁吸的统一实现（打点 + 刻度格线）。判据重点是**两侧边界**与**优先级**，
 * 否则"吸没吸上"这件事很容易写成平凡为真。
 */
describe('snapToRefs', () => {
  it('阈值内吸最近的刻度；阈值外原样（0.1s 取整）', () => {
    const ticks = [0, 2, 4, 6];
    expect(snapToRefs(2.1, { ticks, tolSec: 0.3 })).toEqual({ t: 2, snapped: 'tick' });
    expect(snapToRefs(2.5, { ticks, tolSec: 0.3 })).toEqual({ t: 2.5, snapped: null });
  });

  it('🔴 打点优先于刻度：即使刻度更近也吸打点（用户数据 > 系统网格）', () => {
    // 打点在 10.0（距 0.25），刻度在 10.28（距 0.03，更近）——仍应吸打点
    const out = snapToRefs(10.25, { marks: [10.0], ticks: [10.28], tolSec: 0.3 });
    expect(out).toEqual({ t: 10, snapped: 'mark' });
  });

  it('打点不在阈值内时退回刻度', () => {
    const out = snapToRefs(10.25, { marks: [5], ticks: [10.28], tolSec: 0.3 });
    expect(out).toEqual({ t: 10.28, snapped: 'tick' });
  });

  it('🔴 边界含容差：tol=0.3 时 0.299 吸、0.301 不吸（浮点边界两侧各测一次）', () => {
    const ticks = [30];
    expect(snapToRefs(29.7, { ticks, tolSec: 0.3 }).snapped).toBe('tick'); // |30-29.7| 在 IEEE754 下 > 0.3，靠 1e-9 容差接住
    expect(snapToRefs(29.701, { ticks, tolSec: 0.3 }).snapped).toBe('tick'); // 距 0.299
    expect(snapToRefs(29.699, { ticks, tolSec: 0.3 }).snapped).toBe(null); // 距 0.301
  });

  it('两类都没有 → 原样返回且 snapped=null；空数组同样安全', () => {
    expect(snapToRefs(3.14, { tolSec: 0.3 })).toEqual({ t: 3.1, snapped: null });
    expect(snapToRefs(3.14, { marks: [], ticks: [], tolSec: 0.3 })).toEqual({ t: 3.1, snapped: null });
  });

  it('非法输入：t=NaN 原样返回；tol 非法当 0（不吸）', () => {
    expect(snapToRefs(Number.NaN, { ticks: [1], tolSec: 0.3 }).snapped).toBe(null);
    expect(snapToRefs(1.05, { ticks: [1], tolSec: Number.NaN })).toEqual({ t: 1.1, snapped: null });
    expect(snapToRefs(1.05, { ticks: [1], tolSec: -1 })).toEqual({ t: 1.1, snapped: null });
  });

  it('候选里的脏值（NaN/undefined）被跳过', () => {
    expect(snapToRefs(5.05, { ticks: [Number.NaN, 5], tolSec: 0.2 })).toEqual({ t: 5, snapped: 'tick' });
  });

  it('snapToMark 仍等价于 marks-only 的 snapToRefs（转发后行为不变）', () => {
    const marks = [{ t: 10 }, { t: 20, label: 'x' }, { t: 30 }];
    for (const probe of [10.29, 10.31, 19.8, 29.7, 15, 0]) {
      expect(snapToMark(probe, marks)).toBe(snapToRefs(probe, { marks: [10, 20, 30], tolSec: 0.3 }).t);
    }
  });
});

/**
 * 播放头作为吸附参照（2026-10-11 十二轮）：**只在暂停时**由调用方传入。
 * 判据重点是**优先级**（打点 > 播放头 > 刻度）与 null 的处理。
 */
describe('snapToRefs：播放头参照', () => {
  it('播放头在阈值内 ⇒ 吸播放头（即使刻度更近）', () => {
    const out = snapToRefs(10.25, { playhead: 10.0, ticks: [10.28], tolSec: 0.3 });
    expect(out).toEqual({ t: 10, snapped: 'playhead' });
  });

  it('🔴 打点优先于播放头（用户数据 > 刚刚定位到的地方）', () => {
    const out = snapToRefs(10.1, { marks: [10.0], playhead: 10.2, tolSec: 0.3 });
    expect(out).toEqual({ t: 10, snapped: 'mark' });
  });

  it('播放头不在阈值内 ⇒ 退回刻度；都没有 ⇒ 不吸', () => {
    expect(snapToRefs(10.25, { playhead: 5, ticks: [10.28], tolSec: 0.3 })).toEqual({ t: 10.28, snapped: 'tick' });
    expect(snapToRefs(10.25, { playhead: 5, tolSec: 0.3 })).toEqual({ t: 10.3, snapped: null });
  });

  it('播放头为 null / undefined（播放中）⇒ 当作不存在，不抛', () => {
    expect(snapToRefs(10.25, { playhead: null, ticks: [10.28], tolSec: 0.3 }).snapped).toBe('tick');
    expect(snapToRefs(10.25, { playhead: undefined, tolSec: 0.3 }).snapped).toBe(null);
    expect(snapToRefs(10.25, { playhead: Number.NaN, tolSec: 0.3 }).snapped).toBe(null);
  });

  it('播放头为 0 也算有效参照（0 是合法时刻，不能被 falsy 判掉）', () => {
    expect(snapToRefs(0.2, { playhead: 0, tolSec: 0.3 })).toEqual({ t: 0, snapped: 'playhead' });
  });
});

/**
 * "拖拽起点锚定"的**纯逻辑**部分（十二轮）：给定锚点与选区两端，判断该把哪一端钉回锚点。
 * 抽成纯函数是因为"方向判定"最容易写错（往左拖时该钉 end 而不是 start），而它完全可单测。
 */
describe('anchorSelectionEdge（把离锚更近的一端钉回锚点）', () => {
  const MIN = 0.2;

  it('往右拖、start 还没钉上（锚在左）⇒ 钉 start 到锚点', () => {
    // 锚 5.0，选区当前 [5.3, 9.0]：显然 start 该被拉回 5.0
    expect(anchorSelectionEdge({ start: 5.3, end: 9.0 }, 5.0, MIN)).toEqual({ edge: 'start', value: 5.0 });
  });

  it('往左拖、end 还没钉上（锚在右）⇒ 钉 end 到锚点（**不是**钉 start）', () => {
    // 锚 5.0，选区当前 [2.0, 5.4]：dEnd=0.4 < dStart=3.0 ⇒ 钉 end
    expect(anchorSelectionEdge({ start: 2.0, end: 5.4 }, 5.0, MIN)).toEqual({ edge: 'end', value: 5.0 });
  });

  it('🔴 已钉住（差 < 1ms）⇒ 返回 null（幂等守卫：否则 setOptions → region-updated 自激）', () => {
    expect(anchorSelectionEdge({ start: 5.0, end: 9.0 }, 5.0, MIN)).toBeNull();
    expect(anchorSelectionEdge({ start: 2.0, end: 5.0 }, 5.0, MIN)).toBeNull();
    expect(anchorSelectionEdge({ start: 5.0002, end: 9.0 }, 5.0, MIN)).toBeNull();
  });

  it('选区整体在锚点右侧 ⇒ 仍钉 start（把 start 一路拉到锚点，选区因此向左延伸）', () => {
    expect(anchorSelectionEdge({ start: 7.0, end: 9.0 }, 5.0, MIN)).toEqual({ edge: 'start', value: 5.0 });
  });

  it('选区整体在锚点左侧 ⇒ 钉 end（end 拉到锚点，选区向右延伸）', () => {
    expect(anchorSelectionEdge({ start: 1.0, end: 3.0 }, 5.0, MIN)).toEqual({ edge: 'end', value: 5.0 });
  });

  it('🔴 最小宽度守卫：锚点会与另一端重合时，保留 minSpan（零宽在插件里 = 取消选择）', () => {
    // 锚 5.0、end 只有 5.1 ⇒ 若钉 start=5.0 仍有 0.1 宽，不足 MIN ⇒ 应钉到 5.0（start）且不小于 end-MIN？
    // 语义：把 start 拉到锚点但不得越过 end - minSpan
    const out = anchorSelectionEdge({ start: 5.05, end: 5.15 }, 5.0, MIN);
    // dStart=0.05 < dEnd=0.15 ⇒ 钉 start；value = min(5.0, 5.15-0.2=4.95) = 4.95
    expect(out).toEqual({ edge: 'start', value: 4.95 });
    expect(out!.value).toBeLessThanOrEqual(5.15 - MIN + 1e-9);
  });
});

/** 造一个"锚点 → 盒"的辅助：left = anchor（不翻转），宽度给定 */
const boxAt = (anchor: number, w: number) => ({ left: anchor, right: anchor + w });

describe('packMarkLabels（打点名字分行）', () => {
  it('互不相撞 ⇒ 全部第 0 行、无隐藏', () => {
    const { lanes, hidden } = packMarkLabels({
      boxes: [boxAt(0, 40), boxAt(200, 40), boxAt(400, 40)],
      order: [2, 1, 0],
      maxLanes: 4,
      minGapPx: 4,
    });
    expect(hidden.size).toBe(0);
    expect([...lanes.values()]).toEqual([0, 0, 0]);
  });

  it('🔴 用户实际那条 57 分钟录音：3 点相距 ~31px（名字 135/90/36px）⇒ 三个名字都还在（修复前只剩 1 个）', () => {
    // 实测几何：打点带 747px 宽，3401s 音频 ⇒ 317.8 / 459.2 / 582.6s 三点相距 ~31px
    const boxes = [boxAt(0, 135), boxAt(31, 90), boxAt(62, 36)];
    const { lanes, hidden } = packMarkLabels({ boxes, order: [2, 1, 0], maxLanes: 4, minGapPx: 4 });
    expect(hidden.size).toBe(0);
    expect(lanes.get(2)).toBe(0); // 最新的排第 0 行
    expect(lanes.get(1)).toBe(1);
    expect(lanes.get(0)).toBe(2);
  });

  it('同一行放得下就**不**换行（不要为了好看而浪费行）', () => {
    // 两点相距 60px、名字各 40px ⇒ 第 0 行放得下两个
    const { lanes, hidden } = packMarkLabels({
      boxes: [boxAt(0, 40), boxAt(60, 40)],
      order: [1, 0],
      maxLanes: 4,
      minGapPx: 4,
    });
    expect(hidden.size).toBe(0);
    expect(lanes.get(0)).toBe(0);
    expect(lanes.get(1)).toBe(0);
  });

  it('行数用尽 ⇒ 藏的是**优先级最低**的（order 靠后的），不是随便一个', () => {
    // 6 个密排点（宽 40px、相距 8px）：4 行只能放 4 个 ⇒ 最老的 2 个被藏
    const boxes = [0, 1, 2, 3, 4, 5].map((i) => boxAt(i * 8, 40));
    const { lanes, hidden } = packMarkLabels({ boxes, order: [5, 4, 3, 2, 1, 0], maxLanes: 4, minGapPx: 4 });
    expect([...hidden].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(lanes.size).toBe(4);
    expect(lanes.get(5)).toBe(0); // 优先级最高的拿第 0 行
  });

  it('maxLanes=1（老行为：只有一行）⇒ 相撞的都进 hidden', () => {
    const boxes = [boxAt(0, 135), boxAt(31, 90), boxAt(62, 36)];
    const { lanes, hidden } = packMarkLabels({ boxes, order: [2, 1, 0], maxLanes: 1, minGapPx: 4 });
    expect(lanes.get(2)).toBe(0);
    expect([...hidden].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('间隙口径：恰好贴合（right == left）在 gap=0 时不算撞，gap>0 时算撞', () => {
    const boxes = [boxAt(0, 40), boxAt(40, 40)]; // 第二个 left=40 == 第一个 right=40
    expect(packMarkLabels({ boxes, order: [1, 0], maxLanes: 1, minGapPx: 0 }).hidden.size).toBe(0);
    const gapped = packMarkLabels({ boxes, order: [1, 0], maxLanes: 1, minGapPx: 4 });
    expect([...gapped.hidden]).toEqual([0]); // 后放的那个（优先级低）被挤掉
  });

  it('量不到宽度/不画名字的点（null）被跳过：不占行、也不进 hidden', () => {
    const { lanes, hidden } = packMarkLabels({
      boxes: [boxAt(0, 40), null, boxAt(31, 40)],
      order: [2, 1, 0],
      maxLanes: 4,
      minGapPx: 4,
    });
    expect(hidden.size).toBe(0);
    expect(lanes.has(1)).toBe(false);
    expect(lanes.get(2)).toBe(0);
    expect(lanes.get(0)).toBe(1);
  });

  it('空输入 ⇒ 空结果（组件首帧：还没量到宽度）', () => {
    const { lanes, hidden } = packMarkLabels({ boxes: [], order: [], maxLanes: 4, minGapPx: 4 });
    expect(lanes.size).toBe(0);
    expect(hidden.size).toBe(0);
  });
});
