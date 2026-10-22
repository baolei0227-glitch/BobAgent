import { describe, expect, it } from 'vitest';
import {
  activeSegmentIndex,
  deletePolishedTurn,
  deleteSegment,
  findInsertedSegmentIndex,
  groupSegmentTurns,
  insertPolishedTurnAfter,
  insertSegmentAfter,
  isPolishedTurn,
  isTranscriptPolish,
  normalizeSpeakerName,
  parseTimecode,
  parseTranscriptSidecar,
  segmentsForEditor,
  speakerLabel,
  updatePolishedTurnText,
  updateSegmentSpeakers,
  updateSegmentStart,
  updateSegmentText,
  updateSpeakerName,
  updateSpeakerNames,
  validRange,
  TRANSCRIPT_VERSION,
  type AudioTranscript,
} from '@/lib/audio/transcript';

/**
 * 这组用例守的是**两条会在真实文件上静默失效的边界**（见 transcript.ts 文件头）：
 *   1. 单个切块不写 `[mm:ss]` ⇒ 段解析返回空 ⇒ 必须兜底成一段（否则"转写成功但没内容"）；
 *   2. 正文里的戳**已是全局时间轴**（parseAudio 的 starts 含 baseOffset）⇒ 不得再加范围偏移
 *      （早期设计稿的 offsetSec 是错的，会造成按选区转写时双重偏移）。
 */

/** 造一份 parseAudio 风格的纯正文（段头独占一行） */
function body(parts: Array<{ at: string; speaker?: number; text: string }>): string {
  return parts
    .map((p) => (p.speaker === undefined ? `[${p.at}]\n${p.text}` : `[${p.at}]\n[说话人 ${p.speaker}]\n${p.text}`))
    .join('\n\n');
}

describe('segmentsForEditor', () => {
  it('空文本 → 空数组（不是一段空文本）', () => {
    expect(segmentsForEditor('')).toEqual([]);
    expect(segmentsForEditor('   \n  ')).toEqual([]);
  });

  it('无时间戳但有正文 → 兜底成单段（短音频单块的路径）', () => {
    const out = segmentsForEditor('今天先过一下预算。', { endSec: 42 });
    expect(out).toEqual([{ t: 0, end: 42, speaker: null, text: '今天先过一下预算。' }]);
  });

  it('无时间戳且拿不到时长 → 末段用兜底跨度 30s', () => {
    const out = segmentsForEditor('没有戳的一段话');
    expect(out).toHaveLength(1);
    expect(out[0].end).toBe(30);
  });

  it('多段：end 取下一段 t，末段取 endSec', () => {
    const text = body([
      { at: '00:00', text: '第一段' },
      { at: '00:30', text: '第二段' },
      { at: '01:10', text: '第三段' },
    ]);
    expect(segmentsForEditor(text, { endSec: 90 })).toEqual([
      { t: 0, end: 30, speaker: null, text: '第一段' },
      { t: 30, end: 70, speaker: null, text: '第二段' },
      { t: 70, end: 90, speaker: null, text: '第三段' },
    ]);
  });

  it('抽说话人（0 基），单人录音不带标签时为 null', () => {
    const text = body([
      { at: '00:00', speaker: 1, text: '甲说的话' },
      { at: '00:20', speaker: 2, text: '乙说的话' },
    ]);
    const out = segmentsForEditor(text, { endSec: 40 });
    expect(out.map((s) => s.speaker)).toEqual([0, 1]);
    expect(out[0].text).toBe('甲说的话');
  });

  it('🔴 不做范围偏移：正文里的戳原样取用（双重偏移回归闸门）', () => {
    // 按选区转写（range.start = 300s）时，parseAudio 写出来的戳**已经是** 05:00，
    // 若这里再加一次 offset，会把 300 变成 600。
    const out = segmentsForEditor(body([{ at: '05:00', text: '选区内的话' }]), { endSec: 330 });
    expect(out[0].t).toBe(300);
    expect(out[0].end).toBe(330);
  });

  it('超过 60 分钟的 mm 位不会被截断（非法段戳的兜底）', () => {
    const out = segmentsForEditor(body([{ at: '125:30', text: '很靠后的一段' }]), { endSec: 7600 });
    expect(out[0].t).toBe(125 * 60 + 30);
  });

  it('endSec 非法（null/NaN/≤0）时回退兜底跨度', () => {
    const text = body([{ at: '00:10', text: '一段' }]);
    expect(segmentsForEditor(text, { endSec: null })[0].end).toBe(40);
    expect(segmentsForEditor(text, { endSec: Number.NaN })[0].end).toBe(40);
    expect(segmentsForEditor(text, { endSec: 0 })[0].end).toBe(40);
  });

  it('end 永远严格大于 t（不允许零长度段）', () => {
    const text = body([
      { at: '00:00', text: 'a' },
      { at: '00:00', text: 'b' },
    ]);
    const out = segmentsForEditor(text, { endSec: 0 });
    expect(out.every((s) => s.end > s.t)).toBe(true);
  });
});

describe('activeSegmentIndex', () => {
  const segs = segmentsForEditor(
    body([
      { at: '00:10', text: 'a' },
      { at: '00:20', text: 'b' },
      { at: '00:35', text: 'c' },
    ]),
    { endSec: 60 },
  );

  it('空列表 / 非法时刻 → -1', () => {
    expect(activeSegmentIndex([], 5)).toBe(-1);
    expect(activeSegmentIndex(segs, Number.NaN)).toBe(-1);
  });

  it('第一段之前 → -1（此时不该高亮任何一行）', () => {
    expect(activeSegmentIndex(segs, 9.9)).toBe(-1);
  });

  it('命中起点/段中/段尾之后', () => {
    expect(activeSegmentIndex(segs, 10)).toBe(0);
    expect(activeSegmentIndex(segs, 19.9)).toBe(0);
    expect(activeSegmentIndex(segs, 20)).toBe(1);
    expect(activeSegmentIndex(segs, 100)).toBe(2);
  });

  it('段间隙（推算 end 与下一段 t 之间）仍归属上一段，不闪断', () => {
    // 段 0 的 end=20，段 1 的 t=20 ⇒ 无间隙；此处用 25 落在段 1 内验证"取最后一段 t≤time"
    expect(activeSegmentIndex(segs, 25)).toBe(1);
  });
});

describe('validRange（严格拒绝，不钳位）', () => {
  it('合法区间按 0.1s 取整返回', () => {
    expect(validRange(1.234, 5.678, 10)).toEqual({ start: 1.2, end: 5.7 });
  });

  it('NaN / 倒置 / 负起点 / 跨度不足 → null', () => {
    expect(validRange('abc', 5, 10)).toBeNull();
    expect(validRange(5, 1, 10)).toBeNull();
    expect(validRange(-1, 5, 10)).toBeNull();
    expect(validRange(1, 1.5, 10, 1)).toBeNull();
  });

  it('🔴 超出时长一律拒绝（不做边界钳位），但留 0.5s 测量容差', () => {
    expect(validRange(1, 11, 10)).toBeNull(); // 越界 1s：真错了
    expect(validRange(1, 60, 10, 1)).toBeNull(); // 离谱越界（模型胡说）必拒
    // 边界正好等于时长 → 合法
    expect(validRange(1, 10, 10)).toEqual({ start: 1, end: 10 });
    // 🔴 容差两侧各测一次：ffprobe 与解码器对同一文件差几十毫秒是常态，
    // "按播放器时长截到结尾"（60.0 而服务端测出 59.98）不该被误拒。
    expect(validRange(1, 10.5, 10)).toEqual({ start: 1, end: 10.5 });
    expect(validRange(1, 10.51, 10)).toBeNull();
    // 显式把容差设为 0 → 退回严格语义（供"必须严格"的调用方）
    expect(validRange(1, 10.5, 10, 1, 0)).toBeNull();
  });

  it('时长未知时只校验非负与最短跨度', () => {
    expect(validRange(100, 200, null)).toEqual({ start: 100, end: 200 });
    expect(validRange(100, 200, Number.NaN)).toEqual({ start: 100, end: 200 });
  });
});

describe('parseTranscriptSidecar', () => {
  const good: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [{ t: 0, end: 30, speaker: 0, text: '甲' }, { t: 30, end: 60, speaker: null, text: '乙' }],
    plainText: '甲\n乙',
    durationSec: 60,
    engine: 'Doubao，时长 60s，2 段拼接',
    range: null,
    at: '2026-10-11T00:00:00.000Z',
    source: { size: 1234, mtimeMs: 987654 },
  };

  it('JSON.stringify → parse 往返不丢字段', () => {
    expect(parseTranscriptSidecar(JSON.stringify(good))).toEqual(good);
  });

  it('版本不符 → null（旧 sidecar 不许把 UI 带崩）', () => {
    expect(parseTranscriptSidecar(JSON.stringify({ ...good, version: TRANSCRIPT_VERSION + 1 }))).toBeNull();
    expect(parseTranscriptSidecar(JSON.stringify({ ...good, version: undefined }))).toBeNull();
  });

  it('脏输入 → null（非法 JSON / 非对象 / 无段）', () => {
    expect(parseTranscriptSidecar('{ not json')).toBeNull();
    expect(parseTranscriptSidecar('[]')).toBeNull();
    expect(parseTranscriptSidecar(JSON.stringify({ ...good, segments: [] }))).toBeNull();
    expect(parseTranscriptSidecar(JSON.stringify({ ...good, segments: 'x' }))).toBeNull();
  });

  it('逐段丢弃脏项（负 t / 无正文 / 非对象），但保留其余段', () => {
    const raw = JSON.stringify({
      ...good,
      segments: [
        { t: -5, end: 1, text: '负时间' },
        { t: 10, end: 20 },
        { t: 20, end: 30, text: '留下的' },
        'nonsense',
      ],
    });
    const out = parseTranscriptSidecar(raw);
    expect(out?.segments).toEqual([{ t: 20, end: 30, speaker: null, text: '留下的' }]);
  });

  it('end 非法时回退 t+0.1（保证严格大于 t）', () => {
    const raw = JSON.stringify({ ...good, segments: [{ t: 5, end: 5, text: 'x' }] });
    const out = parseTranscriptSidecar(raw);
    expect(out?.segments[0].end).toBe(5.1);
  });

  it('range/source 缺失或非法 → null（不是抛错）', () => {
    const raw = JSON.stringify({ ...good, range: { start: 'a', end: 3 }, source: { size: 'x' } });
    const out = parseTranscriptSidecar(raw);
    expect(out?.range).toBeNull();
    expect(out?.source).toBeNull();
  });
});

/**
 * 长音频窗口化转写的**中间态**要能原样往返：`partial` 与 `coveredUntilSec` 是"断点续跑"的全部依据，
 * 读回来丢了它们 ⇒ 界面会把半截文稿当完整稿，且下次会从头再转一遍（白花一次钱）。
 * 同时：`partial` 为假时**不写字段**，保证老 sidecar 的形状不变（向前兼容）。
 */
describe('polished sidecar（Hippo / 预览共享）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [{ t: 0, end: 30, speaker: 0, text: '甲' }],
    plainText: '甲',
    durationSec: 30,
    engine: 'Test',
    range: null,
    at: '2026-10-18T00:00:00.000Z',
    source: { size: 1234, mtimeMs: 987654 },
  };
  const polished = {
    at: '2026-10-18T00:01:00.000Z',
    model: 'deepseek-flash',
    turns: [{ speaker: 0, start: 0, end: 30, text: '甲。' }],
  };

  it('合法润色块随 sidecar 往返，且逐轮字段完整', () => {
    const out = parseTranscriptSidecar(JSON.stringify({ ...base, polished }));
    expect(out?.polished).toEqual(polished);
  });

  it('脏润色块被丢弃，但原文稿仍然可读', () => {
    const out = parseTranscriptSidecar(
      JSON.stringify({ ...base, polished: { ...polished, turns: [{ ...polished.turns[0], text: '' }] } }),
    );
    expect(out).not.toBeNull();
    expect(out?.polished).toBeUndefined();
  });

  it('形状校验：空轮 / 非数字时间 / 空文本都拒绝', () => {
    expect(isTranscriptPolish(polished)).toBe(true);
    expect(isPolishedTurn(polished.turns[0])).toBe(true);
    expect(isTranscriptPolish({ ...polished, turns: [] })).toBe(false);
    expect(isPolishedTurn({ speaker: 0, start: 'x', end: 30, text: '甲' })).toBe(false);
    expect(isPolishedTurn({ speaker: 0, start: 0, end: 30, text: '   ' })).toBe(false);
  });
});

describe('parseTranscriptSidecar：partial / coveredUntilSec', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [{ t: 0, end: 30, speaker: null, text: '甲' }],
    plainText: '甲',
    durationSec: 3401,
    engine: 'Doubao',
    range: null,
    at: '2026-10-11T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
  };

  it('中间态往返不丢 partial 与 coveredUntilSec', () => {
    const t: AudioTranscript = { ...base, partial: true, coveredUntilSec: 1200 };
    expect(parseTranscriptSidecar(JSON.stringify(t))).toEqual(t);
  });

  it('🔴 完整稿不写 partial 字段（老 sidecar 形状不变）', () => {
    const raw = JSON.stringify(parseTranscriptSidecar(JSON.stringify({ ...base, partial: false, coveredUntilSec: 3401 })));
    expect(raw).not.toContain('"partial"');
  });

  it('partial 只认严格的 true；脏值当完整稿', () => {
    const dirty = JSON.stringify({ ...base, partial: 'yes', coveredUntilSec: 'x' });
    const out = parseTranscriptSidecar(dirty);
    expect(out?.partial).toBeUndefined();
    expect(out?.coveredUntilSec).toBeUndefined();
  });
});

/**
 * 原地改句（`updateSegmentText`）。
 *
 * 守的是**两类会静默失效**的边界：
 *   1. 时间轴被顺手改掉 ⇒ 已有打点/片段整体错位（用户看不出原因）；
 *   2. 改不动却"看起来改成了" ⇒ 输入被吞（越界 / 空白 / 无变化都必须显式 `null`，不许原样返回）。
 */
describe('updateSegmentText', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 3.2, speaker: 0, text: '甲说第一句' },
      { t: 3.2, end: 9, speaker: 1, text: '乙说第二句' },
    ],
    plainText: '甲说第一句\n乙说第二句',
    durationSec: 9,
    engine: 'Doubao',
    range: null,
    at: '2026-10-17T00:00:00.000Z',
    source: { size: 9, mtimeMs: 9 },
  };

  it('只改 text；t / end / speaker / at / source 一律原样', () => {
    const out = updateSegmentText(base, 1, '乙说：第二句话');
    expect(out).not.toBeNull();
    expect(out!.segments[1]).toEqual({ t: 3.2, end: 9, speaker: 1, text: '乙说：第二句话' });
    expect(out!.at).toBe(base.at);
    expect(out!.source).toEqual(base.source);
    expect(out!.durationSec).toBe(9);
  });

  it('未改动的段保持同一引用（不给整份稿造无谓的新对象）', () => {
    const out = updateSegmentText(base, 1, '乙说：第二句话');
    expect(out!.segments[0]).toBe(base.segments[0]);
  });

  it('plainText 按段重建（AI 精选/片段命名读的是它，不能停在旧句子）', () => {
    const out = updateSegmentText(base, 0, '甲说第一句话');
    expect(out!.plainText).toBe('甲说第一句话\n乙说第二句');
  });

  it('换行规范化：\\r\\n 与 \\r 统一成 \\n，首尾空白去掉', () => {
    const out = updateSegmentText(base, 0, '  第一行\r\n第二行  ');
    expect(out!.segments[0].text).toBe('第一行\n第二行');
  });

  it('🔴 越界 / 非整数 → null（不许 map 一遍原样返回）', () => {
    expect(updateSegmentText(base, -1, 'x')).toBeNull();
    expect(updateSegmentText(base, 2, 'x')).toBeNull();
    expect(updateSegmentText(base, 1.5, 'x')).toBeNull();
    expect(updateSegmentText(base, Number.NaN, 'x')).toBeNull();
  });

  it('空白文本 → null（"清空"是取消编辑，不是把句子从时间轴上抹掉）', () => {
    expect(updateSegmentText(base, 0, '')).toBeNull();
    expect(updateSegmentText(base, 0, '   \n\t ')).toBeNull();
  });

  it('与原文相同（仅首尾空白差异）→ null，调用方据此直接退出编辑态', () => {
    expect(updateSegmentText(base, 0, '甲说第一句')).toBeNull();
    expect(updateSegmentText(base, 0, '  甲说第一句  ')).toBeNull();
  });
});


describe('parseTimecode（手改句首时间的输入解析）', () => {
  it('mm:ss / h:mm:ss / 纯秒数都接受', () => {
    expect(parseTimecode('00:42')).toBe(42);
    expect(parseTimecode('01:10')).toBe(70);
    expect(parseTimecode('1:02:03')).toBe(3723);
    expect(parseTimecode('12.5')).toBe(12.5);
    expect(parseTimecode('0:00.4')).toBe(0.4);
    expect(parseTimecode(' 00:07 ')).toBe(7);
  });

  it('非法输入一律 null（不猜"大概想写几秒"）', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('   ')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:99')).toBeNull(); // 秒位必须 < 60
    expect(parseTimecode('1:2:99')).toBeNull(); // 三段式分钟位也必须 < 60
    expect(parseTimecode('1:2:3:4')).toBeNull();
    expect(parseTimecode('-5')).toBeNull();
  });
});

describe('updateSegmentStart（改一句的起点时间）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 3.2, speaker: 0, text: '甲' },
      { t: 3.2, end: 9, speaker: 1, text: '乙' },
      { t: 9, end: 20, speaker: 1, text: '丙' },
    ],
    plainText: '甲\n乙\n丙',
    durationSec: 20,
    engine: 'Test',
    range: null,
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
  };

  it('改起点：本段 t 更新，上一段的 end 跟着走（段时间首尾相接）', () => {
    const out = updateSegmentStart(base, 1, 5);
    expect(out).not.toBeNull();
    expect(out!.segments[1]).toEqual({ t: 5, end: 9, speaker: 1, text: '乙' });
    expect(out!.segments[0].end).toBe(5);
    // 未被牵动的段保持同一引用
    expect(out!.segments[2]).toBe(base.segments[2]);
  });

  it('首段没有上一段 ⇒ 只改自己的 t（end 不动）', () => {
    const out = updateSegmentStart(base, 0, 1.4);
    expect(out!.segments[0]).toEqual({ t: 1.4, end: 3.2, speaker: 0, text: '甲' });
    expect(out!.segments[1]).toBe(base.segments[1]);
  });

  it('文字 / plainText / durationSec / source 一律不动', () => {
    const out = updateSegmentStart(base, 1, 5)!;
    expect(out.segments.map((s) => s.text)).toEqual(['甲', '乙', '丙']);
    expect(out.plainText).toBe(base.plainText);
    expect(out.durationSec).toBe(20);
    expect(out.at).toBe(base.at);
    expect(out.source).toEqual(base.source);
  });

  it('🔴 越过自己的 end / 越过上一段起点 / 超出总时长 → null', () => {
    expect(updateSegmentStart(base, 1, 9)).toBeNull(); // 顶到 end，段将没有跨度
    expect(updateSegmentStart(base, 1, 8.95)).toBeNull();
    expect(updateSegmentStart(base, 1, 0.02)).toBeNull(); // 越过上一段 t=0（四舍五入后仍不足 0.1s 跨度）
    expect(updateSegmentStart(base, 2, 25)).toBeNull(); // durationSec=20
  });

  it('越界 / 非整数下标 / 非有限数 / 负数 / 无变化 → null', () => {
    expect(updateSegmentStart(base, -1, 1)).toBeNull();
    expect(updateSegmentStart(base, 3, 1)).toBeNull();
    expect(updateSegmentStart(base, 1.5, 1)).toBeNull();
    expect(updateSegmentStart(base, 1, Number.NaN)).toBeNull();
    expect(updateSegmentStart(base, 1, -1)).toBeNull();
    expect(updateSegmentStart(base, 1, 3.2)).toBeNull();
  });

  it('润色稿不丢弃：轮首/上一轮尾恰好等于旧 t 的边界一起挪，其余保持引用', () => {
    const withPolish: AudioTranscript = {
      ...base,
      polished: {
        at: '2026-10-21T00:01:00.000Z',
        model: 'deepseek-flash',
        turns: [
          { speaker: 0, start: 0, end: 3.2, text: '甲。' },
          { speaker: 1, start: 3.2, end: 9, text: '乙。' },
          { speaker: 1, start: 9, end: 20, text: '丙。' },
        ],
      },
    };
    const out = updateSegmentStart(withPolish, 1, 5)!;
    expect(out.polished!.turns[0].end).toBe(5);
    expect(out.polished!.turns[1].start).toBe(5);
    expect(out.polished!.turns[2]).toBe(withPolish.polished!.turns[2]);
  });

  /**
   * 跳转与润色视图的边界一致性：时间戳显示与"跳到这里"读同一个 `t`，
   * 但插入行与上一行同 `start`，按值对账会把用户没点的那一行也一起带走。
   */
  const withInserted: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 10, speaker: 0, text: '甲' },
      { t: 0, end: 10, speaker: 0, text: '补的断句', inserted: true },
      { t: 10, end: 20, speaker: 1, text: '乙' },
    ],
    plainText: '甲\n补的断句\n乙',
    durationSec: 20,
    engine: 'Test',
    range: null,
    polished: {
      at: '2026-10-21T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 10, text: '甲。' },
        { speaker: 0, start: 0, end: 10, text: '补的断句', inserted: true },
        { speaker: 1, start: 10, end: 20, text: '乙。' },
      ],
    },
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
  };

  it('🔴 改插入行的起点：不截短上一段，润色稿只挪它自己那一轮', () => {
    const out = updateSegmentStart(withInserted, 1, 4)!;
    expect(out.segments.map((s) => [s.t, s.end])).toEqual([
      [0, 10],
      [4, 10],
      [10, 20],
    ]);
    expect(out.polished!.turns[0]).toBe(withInserted.polished!.turns[0]);
    expect(out.polished!.turns[1].start).toBe(4);
    expect(out.polished!.turns[2]).toBe(withInserted.polished!.turns[2]);
  });

  it('🔴 改普通段起点：同 start 的插入行与它那一轮都不动', () => {
    const out = updateSegmentStart(withInserted, 0, 1)!;
    expect(out.segments[1].t).toBe(0);
    expect(out.polished!.turns[0].start).toBe(1);
    expect(out.polished!.turns[1]).toBe(withInserted.polished!.turns[1]);
  });

  it('🔴 上一行是插入行时：同步的是最近的普通段 end，插入行 end 保持', () => {
    const out = updateSegmentStart(withInserted, 2, 12)!;
    expect(out.segments[0].end).toBe(12); // 时间轴的上一段 = 甲
    expect(out.segments[1]).toEqual({ t: 0, end: 10, speaker: 0, text: '补的断句', inserted: true });
    expect(out.segments[2].t).toBe(12);
    expect(out.polished!.turns[0].end).toBe(12);
    expect(out.polished!.turns[1]).toBe(withInserted.polished!.turns[1]);
  });

  it('🔴 插入行不钩稽上一行：可挪到后面，按时间归位并重建 plainText', () => {
    const out = updateSegmentStart(withInserted, 1, 12)!;
    // 归位：插入行落到乙之后（段序 = 文稿顺序）
    expect(out.segments.map((s) => [s.text, s.t, s.end])).toEqual([
      ['甲', 0, 10],
      ['乙', 10, 20],
      ['补的断句', 12, 12.1], // 原 end 已不够跨度 ⇒ 延伸到 t+0.1
    ]);
    expect(out.plainText).toBe('甲\n乙\n补的断句');
    // 润色稿只挪它自己那一轮，并按新时间重排
    expect(out.polished!.turns.map((turn) => [turn.text, turn.start, turn.end])).toEqual([
      ['甲。', 0, 10],
      ['乙。', 10, 20],
      ['补的断句', 12, 12.1],
    ]);
    expect(out.polished!.turns[0]).toBe(withInserted.polished!.turns[0]);
    expect(out.polished!.turns[1]).toBe(withInserted.polished!.turns[2]);
  });

  it('插入行原位改时间（不跨行）：段序与 plainText 都不动', () => {
    const out = updateSegmentStart(withInserted, 1, 4)!;
    expect(out.segments.map((s) => s.text)).toEqual(['甲', '补的断句', '乙']);
    expect(out.plainText).toBe(withInserted.plainText);
  });

  it('插入行也不能改到音频末尾之外（至少留 0.1s 跨度）', () => {
    expect(updateSegmentStart(withInserted, 1, 20)).toBeNull();
    expect(updateSegmentStart(withInserted, 1, 19.95)).toBeNull();
  });

  /**
   * 插入后上一行的 `end` 已被收到插入行起点（见 `insertSegmentAfter`）。
   * 这里守"联动"：再改插入行时间，那条边要跟着走。
   */
  const linked: AudioTranscript = {
    ...withInserted,
    segments: [
      { t: 0, end: 4, speaker: 0, text: '甲' },
      { t: 4, end: 10, speaker: 0, text: '补的断句', inserted: true },
      { t: 10, end: 20, speaker: 1, text: '乙' },
    ],
    polished: {
      at: '2026-10-21T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 4, text: '甲。' },
        { speaker: 0, start: 4, end: 10, text: '补的断句', inserted: true },
        { speaker: 1, start: 10, end: 20, text: '乙。' },
      ],
    },
  };

  it('🔴 联动：上一行的 end 跟着插入行新起点走（原文段与润色轮一致）', () => {
    const out = updateSegmentStart(linked, 1, 6)!;
    expect(out.segments.map((s) => [s.text, s.t, s.end])).toEqual([
      ['甲', 0, 6],
      ['补的断句', 6, 10],
      ['乙', 10, 20],
    ]);
    expect(out.segments[2]).toBe(linked.segments[2]); // 后面的行一字不动
    expect(out.polished!.turns[0].end).toBe(6);
    expect(out.polished!.turns[1].start).toBe(6);
    expect(out.polished!.turns[2]).toBe(linked.polished!.turns[2]);
  });

  it('联动：往回挪（仍在上一行下面）时那条边同样跟回来', () => {
    const out = updateSegmentStart(linked, 1, 2)!;
    expect(out.segments[0].end).toBe(2);
    expect(out.segments.map((s) => s.text)).toEqual(['甲', '补的断句', '乙']);
  });

  it('跳到别的行后面 ⇒ 不再动原来那一行（不把无关的行截断）', () => {
    const out = updateSegmentStart(linked, 1, 12)!;
    expect(out.segments.map((s) => [s.text, s.t, s.end])).toEqual([
      ['甲', 0, 4],
      ['乙', 10, 20],
      ['补的断句', 12, 12.1],
    ]);
    expect(out.polished!.turns[0]).toBe(linked.polished!.turns[0]);
    expect(out.polished!.turns[1]).toBe(linked.polished!.turns[2]);
  });
});

describe('updatePolishedTurnText（改润色轮文字）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 2, speaker: 0, text: '甲一' },
      { t: 2, end: 4, speaker: 0, text: '甲二' },
    ],
    plainText: '甲一\n甲二',
    durationSec: 4,
    engine: 'Test',
    range: null,
    at: '2026-10-18T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
    polished: {
      at: '2026-10-18T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 4, text: '甲说了两句。' },
        { speaker: 1, start: 4, end: 6, text: '乙说了一句。' },
      ],
    },
  };

  it('只改目标轮的文字，其余轮与原文（segments/plainText）一字不动', () => {
    const out = updatePolishedTurnText(base, 0, '甲改成了这句。');
    expect(out?.polished?.turns[0].text).toBe('甲改成了这句。');
    expect(out?.polished?.turns[1]).toEqual(base.polished!.turns[1]);
    expect(out?.segments).toEqual(base.segments);
    expect(out?.plainText).toBe(base.plainText);
    // 润色发生时刻不因手工改字而更新
    expect(out?.polished?.at).toBe(base.polished!.at);
  });

  it('首尾空白被归一（与 updateSegmentText 同口径）', () => {
    const out = updatePolishedTurnText(base, 1, '  乙改\r\n了一句。  ');
    expect(out?.polished?.turns[1].text).toBe('乙改\n了一句。');
  });

  it('越界 / 非整数 / 空白 / 无变化 / 没有润色稿 → null', () => {
    expect(updatePolishedTurnText(base, -1, 'x')).toBeNull();
    expect(updatePolishedTurnText(base, 2, 'x')).toBeNull();
    expect(updatePolishedTurnText(base, 0.5, 'x')).toBeNull();
    expect(updatePolishedTurnText(base, Number.NaN, 'x')).toBeNull();
    expect(updatePolishedTurnText(base, 0, '  \n ')).toBeNull();
    expect(updatePolishedTurnText(base, 0, '  甲说了两句。  ')).toBeNull();
    expect(updatePolishedTurnText({ ...base, polished: undefined }, 0, '新文字')).toBeNull();
  });
});


describe('insertSegmentAfter（原文稿插入一行）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 2, speaker: 0, text: '甲一' },
      { t: 2, end: 4, speaker: 0, text: '甲二' },
      { t: 4, end: 6, speaker: 1, text: '乙一' },
    ],
    plainText: '甲一\n甲二\n乙一',
    durationSec: 6,
    engine: 'Test',
    range: null,
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
    polished: {
      at: '2026-10-21T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 4, text: '甲说了两句。' },
        { speaker: 1, start: 4, end: 6, text: '乙说了一句。' },
      ],
    },
  };

  const line = { speaker: 0, t: 0, end: 2, text: '  补一句\r\n  ' };

  it('插在指定行下面：文案归一、时间沿用调用方给的值、plainText 重建', () => {
    const out = insertSegmentAfter(base, 0, line)!;
    expect(out.segments.map((s) => s.text)).toEqual(['甲一', '补一句', '甲二', '乙一']);
    expect(out.segments[1]).toEqual({ speaker: 0, t: 0, end: 2, text: '补一句', inserted: true });
    expect(out.plainText).toBe('甲一\n补一句\n甲二\n乙一');
  });

  it('末行之后插入 = 追加到末尾', () => {
    const out = insertSegmentAfter(base, 2, { ...line, t: 4, end: 6 })!;
    expect(out.segments).toHaveLength(4);
    expect(out.segments[3].text).toBe('补一句');
  });

  it('已有润色稿时同步插入一轮（锚点段所属轮的后面）', () => {
    const out = insertSegmentAfter(base, 0, line)!;
    // 锚点 t=0 ⇒ 最后一轮 start<=0 是第 0 轮 ⇒ 排在它后面
    expect(out.polished?.turns.map((t) => t.text)).toEqual(['甲说了两句。', '补一句', '乙说了一句。']);
    expect(out.polished?.turns[1]).toEqual({ speaker: 0, start: 0, end: 2, text: '补一句', inserted: true });
    // 润色发生时刻不因手工插入而变化
    expect(out.polished?.at).toBe(base.polished!.at);
  });

  it('没有润色稿时只动原文（不凭空造一个 polished）', () => {
    const out = insertSegmentAfter({ ...base, polished: undefined }, 1, line)!;
    expect(out.segments.map((s) => s.text)).toEqual(['甲一', '甲二', '补一句', '乙一']);
    expect(out.polished).toBeUndefined();
  });

  it('越界 / 非整数 / 空文本 / 非法时间 → null（不静默插空行）', () => {
    expect(insertSegmentAfter(base, -1, line)).toBeNull();
    expect(insertSegmentAfter(base, 3, line)).toBeNull();
    expect(insertSegmentAfter(base, 0.5, line)).toBeNull();
    expect(insertSegmentAfter(base, 0, { ...line, text: '  \n ' })).toBeNull();
    expect(insertSegmentAfter(base, 0, { ...line, t: Number.NaN })).toBeNull();
    expect(insertSegmentAfter(base, 0, { ...line, t: -1 })).toBeNull();
    expect(insertSegmentAfter(base, 0, { ...line, speaker: 1e9 })).toBeNull();
  });

  it('end < t 时归一到 t（零时长），不写负长度', () => {
    const out = insertSegmentAfter(base, 0, { ...line, t: 3, end: 1 })!;
    expect(out.segments[1].end).toBe(3);
  });

  it('🔴 上一行的 end 跟着新行起点走，其余行的时间一字不动', () => {
    const out = insertSegmentAfter(base, 1, { speaker: 0, t: 3, end: 3.5, text: '补一句' })!;
    expect(out.segments[1].end).toBe(3); // 甲二 2–4 ⇒ 说到新行开始处
    expect(out.segments[2]).toEqual({ speaker: 0, t: 3, end: 3.5, text: '补一句', inserted: true });
    expect(out.segments[0]).toBe(base.segments[0]);
    expect(out.segments[3]).toBe(base.segments[2]);
    // 锚点段正好是该轮最后一段 ⇒ 润色轮的 end 也对齐
    expect(out.polished!.turns[0].end).toBe(3);
    expect(out.polished!.turns[2]).toBe(base.polished!.turns[1]);
  });

  it('新行起点与上一行起点重合 ⇒ 上一行留 0.1s 最短跨度（不写零长度段）', () => {
    const out = insertSegmentAfter(base, 0, { ...line, t: 0, end: 2 })!;
    expect(out.segments[0].end).toBe(0.1);
  });

  it('锚点不是该轮最后一段时：润色轮不截断（只有原文段的 end 跟走）', () => {
    // 第 0 轮覆盖 seg0(0–2) + seg1(2–4)；锚点是 seg0，截轮会把 seg1 甩出轮外
    const out = insertSegmentAfter(base, 0, { speaker: 0, t: 1, end: 2, text: '补一句' })!;
    expect(out.segments[0].end).toBe(1);
    expect(out.polished!.turns[0]).toBe(base.polished!.turns[0]);
  });
});

describe('insertPolishedTurnAfter（润色稿插入一轮）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 2, speaker: 0, text: '甲一' },
      { t: 2, end: 4, speaker: 0, text: '甲二' },
      { t: 4, end: 6, speaker: 1, text: '乙一' },
    ],
    plainText: '甲一\n甲二\n乙一',
    durationSec: 6,
    engine: 'Test',
    range: null,
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
    polished: {
      at: '2026-10-21T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 4, text: '甲说了两句。' },
        { speaker: 1, start: 4, end: 6, text: '乙说了一句。' },
      ],
    },
  };

  const line = { speaker: 0, t: 0, end: 4, text: '补一轮' };

  it('插在指定轮下面，并落回原文（该轮覆盖段的最后一段之后）', () => {
    const out = insertPolishedTurnAfter(base, 0, line)!;
    expect(out.polished!.turns.map((t) => t.text)).toEqual(['甲说了两句。', '补一轮', '乙说了一句。']);
    // 第 0 轮覆盖 seg0(0)/seg1(2)，end=4 ⇒ 落在 seg1 之后
    expect(out.segments.map((s) => s.text)).toEqual(['甲一', '甲二', '补一轮', '乙一']);
    // 新段 t 被抬到前一段起点（2）：段列表始终按时间非递减（activeSegmentIndex 的二分依赖它）
    expect(out.segments[2]).toEqual({ speaker: 0, t: 2, end: 4, text: '补一轮', inserted: true });
    // 轮与段用同一组时间 ⇒ 删除时能精确配回这一段
    expect(out.polished!.turns[1]).toEqual({ speaker: 0, start: 2, end: 4, text: '补一轮', inserted: true });
    expect(out.plainText).toBe('甲一\n甲二\n补一轮\n乙一');
  });

  it('末轮之后插入 = 两个列表都追加到末尾', () => {
    const out = insertPolishedTurnAfter(base, 1, { ...line, speaker: 1, t: 4, end: 6 })!;
    expect(out.polished!.turns).toHaveLength(3);
    expect(out.segments).toHaveLength(4);
    expect(out.segments[3].text).toBe('补一轮');
  });

  it('越界 / 没有润色稿 / 空文本 → null', () => {
    expect(insertPolishedTurnAfter(base, -1, line)).toBeNull();
    expect(insertPolishedTurnAfter(base, 2, line)).toBeNull();
    expect(insertPolishedTurnAfter(base, 0.5, line)).toBeNull();
    expect(insertPolishedTurnAfter(base, 0, { ...line, text: ' ' })).toBeNull();
    expect(insertPolishedTurnAfter({ ...base, polished: undefined }, 0, line)).toBeNull();
  });

  it('🔴 上一轮与它最后一段的 end 都跟着新行起点走', () => {
    const out = insertPolishedTurnAfter(base, 1, { speaker: 1, t: 5, end: 6, text: '补一轮' })!;
    // 锚点轮 4–6、最后一段 乙一(4–6) ⇒ 都收到 5
    expect(out.polished!.turns[1].end).toBe(5);
    expect(out.segments[2].end).toBe(5);
    expect(out.segments[3]).toEqual({ speaker: 1, t: 5, end: 6, text: '补一轮', inserted: true });
  });

  it('新行起点被抬到该轮末段起点时：上一轮留 0.1s 最短跨度', () => {
    const out = insertPolishedTurnAfter(base, 0, line)!; // t=0 ⇒ 被抬到 seg1 的 2
    expect(out.segments[1].end).toBe(2.1);
    expect(out.polished!.turns[0].end).toBe(2.1);
    expect(out.segments[2].t).toBe(2);
  });
});

describe('deleteSegment（原文稿删一行）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 2, speaker: 0, text: '甲一' },
      { t: 2, end: 4, speaker: 0, text: '甲二' },
      { t: 4, end: 6, speaker: 1, text: '乙一' },
    ],
    plainText: '甲一\n甲二\n乙一',
    durationSec: 6,
    engine: 'Test',
    range: null,
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
    polished: {
      at: '2026-10-21T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 4, text: '甲说了两句。' },
        { speaker: 1, start: 4, end: 6, text: '乙说了一句。' },
      ],
    },
  };

  it('删指定句并重建 plainText；润色改写不受影响', () => {
    const out = deleteSegment(base, 1)!;
    expect(out.segments.map((s) => s.text)).toEqual(['甲一', '乙一']);
    expect(out.plainText).toBe('甲一\n乙一');
    // 与润色轮文案不同 ⇒ 润色稿原样保留（它是改写，不是这一句的副本）
    expect(out.polished?.turns.map((t) => t.text)).toEqual(['甲说了两句。', '乙说了一句。']);
  });

  it('删除插入时同步过去的那一对：润色稿里时间+文字全等的一轮也一并删掉', () => {
    const inserted = insertSegmentAfter(base, 2, { speaker: 1, t: 4, end: 6, text: '补一句' })!;
    expect(inserted.polished!.turns).toHaveLength(3);
    const out = deleteSegment(inserted, 3)!;
    expect(out.segments.map((s) => s.text)).toEqual(['甲一', '甲二', '乙一']);
    expect(out.polished!.turns.map((t) => t.text)).toEqual(['甲说了两句。', '乙说了一句。']);
    expect(out.plainText).toBe('甲一\n甲二\n乙一');
  });

  it('删到只剩一轮润色稿时：turns 清空 ⇒ polished 字段整个移除（空块不合法）', () => {
    const single: AudioTranscript = {
      ...base,
      segments: [{ t: 0, end: 2, speaker: 0, text: '甲一' }, { t: 2, end: 4, speaker: 0, text: '补一句' }],
      polished: {
        at: '2026-10-21T00:01:00.000Z',
        model: 'deepseek-flash',
        turns: [{ speaker: 0, start: 2, end: 4, text: '补一句' }],
      },
    };
    const out = deleteSegment(single, 1)!;
    expect(out.polished).toBeUndefined();
    expect(out.segments).toHaveLength(1);
  });

  it('越界 / 非整数 / 不允许删到 0 段 → null', () => {
    expect(deleteSegment(base, -1)).toBeNull();
    expect(deleteSegment(base, 3)).toBeNull();
    expect(deleteSegment(base, 1.5)).toBeNull();
    expect(deleteSegment({ ...base, segments: [base.segments[0]] }, 0)).toBeNull();
  });
});

describe('deletePolishedTurn（润色稿删一轮）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 2, speaker: 0, text: '甲一' },
      { t: 2, end: 4, speaker: 0, text: '甲二' },
      { t: 4, end: 6, speaker: 1, text: '乙一' },
    ],
    plainText: '甲一\n甲二\n乙一',
    durationSec: 6,
    engine: 'Test',
    range: null,
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
    polished: {
      at: '2026-10-21T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 4, text: '甲说了两句。' },
        { speaker: 1, start: 4, end: 6, text: '乙说了一句。' },
      ],
    },
  };

  it('删一轮不动原文（多句并一轮的改写不等于原文的某一句）', () => {
    const out = deletePolishedTurn(base, 0)!;
    expect(out.polished!.turns.map((t) => t.text)).toEqual(['乙说了一句。']);
    expect(out.segments.map((s) => s.text)).toEqual(['甲一', '甲二', '乙一']);
    expect(out.plainText).toBe('甲一\n甲二\n乙一');
  });

  it('删除插入时同步过去的那一对：原文里时间+文字全等的一段也一并删掉', () => {
    const inserted = insertPolishedTurnAfter(base, 0, { speaker: 0, t: 0, end: 4, text: '补一轮' })!;
    // 落到 seg1 之后、时间被抬到 2 ⇒ 轮与段时间一致
    expect(inserted.segments[2]).toEqual({ speaker: 0, t: 2, end: 4, text: '补一轮', inserted: true });
    const out = deletePolishedTurn(inserted, 1)!;
    expect(out.polished!.turns.map((t) => t.text)).toEqual(['甲说了两句。', '乙说了一句。']);
    expect(out.segments.map((s) => s.text)).toEqual(['甲一', '甲二', '乙一']);
  });

  it('删掉最后一轮 ⇒ polished 移除；原文保留', () => {
    const single: AudioTranscript = {
      ...base,
      polished: { ...base.polished!, turns: [{ speaker: 1, start: 4, end: 6, text: '乙说了一句。' }] },
    };
    const out = deletePolishedTurn(single, 0)!;
    expect(out.polished).toBeUndefined();
    expect(out.segments).toHaveLength(3);
  });

  it('越界 / 非整数 / 没有润色稿 → null', () => {
    expect(deletePolishedTurn(base, -1)).toBeNull();
    expect(deletePolishedTurn(base, 2)).toBeNull();
    expect(deletePolishedTurn(base, 0.5)).toBeNull();
    expect(deletePolishedTurn({ ...base, polished: undefined }, 0)).toBeNull();
  });
});

describe('groupSegmentTurns', () => {
  const seg = (t: number, end: number, speaker: number | null, text: string) => ({ t, end, speaker, text });

  it('连续同说话人合并；换人开新轮，时间沿用首尾', () => {
    const turns = groupSegmentTurns([
      seg(0, 2, 0, '甲一'),
      seg(2, 4, 0, '甲二'),
      seg(4, 6, 1, '乙一'),
      seg(6, 8, 1, '乙二'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ speaker: 0, start: 0, end: 4, text: '甲一\n甲二' });
    expect(turns[1]).toMatchObject({ speaker: 1, start: 4, end: 8, text: '乙一\n乙二' });
  });

  it('无标签稿按 45s / 400 字上限合并，不把 500 段变成 500 轮', () => {
    const turns = groupSegmentTurns([
      seg(0, 20, null, '一'),
      seg(20, 40, null, '二'),
      seg(40, 50, null, '三'), // 距首 50s > 45 ⇒ 新轮
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ speaker: null, start: 0, end: 40, text: '一\n二' });
    expect(turns[1]).toMatchObject({ start: 40, end: 50, text: '三' });
  });

  it('空段列表 → 空轮（不造空 turn）', () => {
    expect(groupSegmentTurns([])).toEqual([]);
  });
});

/**
 * 说话人手工纠正（2026-10-18）：改**一轮归属** / 给某人**改名**。
 *
 * 这组用例守的是三条"静默失效"的边界：
 *   1. 改归属时**只动 `speaker`** —— text / t / end / `at` / `source` 一个都不许动
 *      （打点与片段按时间存，挪了时间轴会让它们集体失位）；
 *   2. 失败一律返回 `null`、**不写盘**（畸形的 `indexes` / `speaker` 绝不能进 sidecar）；
 *   3. 改名是**显示层**的事，`segments` 必须原样（改错了再改一次即可，与归属互不牵连）。
 */
describe('updateSegmentSpeakers（改一轮归属）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 3.2, speaker: 0, text: '甲说第一句' },
      { t: 3.2, end: 6, speaker: 1, text: '乙说第二句' },
      { t: 6, end: 9, speaker: 1, text: '乙说第三句' },
    ],
    plainText: '甲说第一句\n乙说第二句\n乙说第三句',
    durationSec: 9,
    engine: 'Doubao',
    range: null,
    at: '2026-10-18T00:00:00.000Z',
    source: { size: 9, mtimeMs: 9 },
  };

  it('整轮改归：这一批全变，其余段与 text / 时间轴 / at / source 一律原样', () => {
    const out = updateSegmentSpeakers(base, [1, 2], 0);
    expect(out).not.toBeNull();
    expect(out!.segments.map((s) => s.speaker)).toEqual([0, 0, 0]);
    expect(out!.segments[0]).toBe(base.segments[0]); // 未改动的段不给整份稿造无谓的新对象
    expect(out!.segments[1]).toEqual({ t: 3.2, end: 6, speaker: 0, text: '乙说第二句' });
    expect(out!.plainText).toBe(base.plainText); // 说话人不参与正文
    expect(out!.at).toBe(base.at);
    expect(out!.source).toEqual(base.source);
  });

  it('改成 null = 取消归属（分不出人时的那一档）', () => {
    const out = updateSegmentSpeakers(base, [1], null);
    expect(out!.segments[1].speaker).toBeNull();
    expect(out!.segments[2].speaker).toBe(1);
  });

  it('🔴 indexes 非法 → null（空 / 越界 / 非整数 / 重复，先校验再改）', () => {
    expect(updateSegmentSpeakers(base, [], 0)).toBeNull();
    expect(updateSegmentSpeakers(base, [3], 0)).toBeNull();
    expect(updateSegmentSpeakers(base, [-1], 0)).toBeNull();
    expect(updateSegmentSpeakers(base, [1.5], 0)).toBeNull();
    expect(updateSegmentSpeakers(base, [Number.NaN], 0)).toBeNull();
    // 重复下标：不去重后照改 —— 那等于"按 id 落定了却零反馈"
    expect(updateSegmentSpeakers(base, [1, 1], 0)).toBeNull();
  });

  it('🔴 speaker 非法（负数 / 非整数 / 越界 100）→ null', () => {
    expect(updateSegmentSpeakers(base, [1], -1)).toBeNull();
    expect(updateSegmentSpeakers(base, [1], 1.5)).toBeNull();
    expect(updateSegmentSpeakers(base, [1], 100)).toBeNull();
  });

  it('这一批本来就已经全是这个归属 → null（无变化不写盘、也不留编辑态）', () => {
    expect(updateSegmentSpeakers(base, [1, 2], 1)).toBeNull();
  });

  it('🔴 有润色稿时按 `start` 对账刷新它的说话人，但**不丢**润色文本、不重算正文', () => {
    const withPolish: AudioTranscript = {
      ...base,
      polished: {
        model: 'Hippo',
        at: '2026-10-18T00:10:00.000Z',
        turns: [
          { speaker: 0, start: 0, end: 3.2, text: '甲：第一句（润色）' },
          { speaker: 1, start: 3.2, end: 9, text: '乙：第二、三句（润色）' },
        ],
      },
    };
    const out = updateSegmentSpeakers(withPolish, [1, 2], 0);
    expect(out!.polished!.turns[1]).toEqual({ speaker: 0, start: 3.2, end: 9, text: '乙：第二、三句（润色）' });
    expect(out!.polished!.turns[0]).toBe(withPolish.polished!.turns[0]); // 没变的轮不重建
    expect(out!.polished!.at).toBe(withPolish.polished!.at);
  });

  it('对不上的润色轮（转写稿被换过）保留原归属，不猜', () => {
    const withPolish: AudioTranscript = {
      ...base,
      polished: {
        model: 'Hippo',
        at: '2026-10-18T00:10:00.000Z',
        turns: [{ speaker: 1, start: 999, end: 1000, text: '早就不在这个稿子里的轮' }],
      },
    };
    const out = updateSegmentSpeakers(withPolish, [1], 0);
    expect(out!.polished!.turns[0].speaker).toBe(1);
  });

  it('没有润色稿时不凭空造一个', () => {
    expect(updateSegmentSpeakers(base, [1], 0)!.polished).toBeUndefined();
  });
});

describe('updateSpeakerName（给说话人起名）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 3, speaker: 0, text: '甲' },
      { t: 3, end: 6, speaker: 1, text: '乙' },
    ],
    plainText: '甲\n乙',
    durationSec: 6,
    engine: 'Doubao',
    range: null,
    at: '2026-10-18T00:00:00.000Z',
    source: { size: 6, mtimeMs: 6 },
  };

  it('写入名字：折叠空白 + 去首尾；`segments` 一个都不碰', () => {
    const out = updateSpeakerName(base, 1, '  李\u00a0 四  ');
    expect(out!.speakerNames).toEqual({ 1: '李 四' });
    expect(out!.segments).toBe(base.segments);
  });

  it('超长名字截到 40 字（显示名会进 Markdown 标题行，不能把版面顶坏）', () => {
    expect(normalizeSpeakerName('名'.repeat(50))).toHaveLength(40);
  });

  it('空名 = 恢复默认 `Speaker N`（连字段一起收起，老 sidecar 形状不变）', () => {
    const named: AudioTranscript = { ...base, speakerNames: { 0: '张三' } };
    const out = updateSpeakerName(named, 0, '   ');
    expect(out!.speakerNames).toBeUndefined();
  });

  it('🔴 与现有值相同（仅首尾空白差异）→ null，调用方据此不再写盘', () => {
    const named: AudioTranscript = { ...base, speakerNames: { 0: '张三' } };
    expect(updateSpeakerName(named, 0, '张三')).toBeNull();
    expect(updateSpeakerName(named, 0, ' 张三 ')).toBeNull();
    // 连"没起过名却提交空名"也算无变化
    expect(updateSpeakerName(base, 0, '')).toBeNull();
  });

  it('🔴 id 非法（负数 / 非整数 / 越界 100）→ null', () => {
    expect(updateSpeakerName(base, -1, '张三')).toBeNull();
    expect(updateSpeakerName(base, 1.5, '张三')).toBeNull();
    expect(updateSpeakerName(base, 100, '张三')).toBeNull();
  });
});

/**
 * 批量改名（面板"列出所有人 → 一次改完 → 统一保存"）守的是两件事：
 *   - **一次写盘**：多条一起改也只产出一份稿子（前端循环调单条会写 N 次、弹 N 条提示）；
 *   - **脏键不连坐**：一批里混进一个越界/`NaN` 的键时，用户真正想改的那几个照改。
 */
describe('updateSpeakerNames（批量改显示名）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 3, speaker: 0, text: '甲' },
      { t: 3, end: 6, speaker: 1, text: '乙' },
    ],
    plainText: '甲\n乙',
    durationSec: 6,
    engine: 'Doubao',
    range: null,
    at: '2026-10-18T00:00:00.000Z',
    source: { size: 6, mtimeMs: 6 },
  };

  it('一次改多人：两条都落，`segments` 与时间轴一个都不碰', () => {
    const out = updateSpeakerNames(base, [
      { id: 0, name: ' 张三 ' },
      { id: 1, name: '李四' },
    ]);
    expect(out!.speakerNames).toEqual({ 0: '张三', 1: '李四' });
    expect(out!.segments).toBe(base.segments);
    expect(out!.at).toBe(base.at);
    expect(out!.plainText).toBe(base.plainText);
  });

  it('只改其中一个也照常（这里不受"必须全变"约束，父级已把没变的筛掉）', () => {
    const named: AudioTranscript = { ...base, speakerNames: { 0: '张三' } };
    const out = updateSpeakerNames(named, [
      { id: 0, name: '张三' },
      { id: 1, name: '李四' },
    ]);
    expect(out!.speakerNames).toEqual({ 0: '张三', 1: '李四' });
  });

  it('🔴 全都没变（含仅首尾空白差异）→ null，不白写一次盘', () => {
    const named: AudioTranscript = { ...base, speakerNames: { 0: '张三' } };
    expect(updateSpeakerNames(named, [{ id: 0, name: ' 张三 ' }])).toBeNull();
    expect(updateSpeakerNames(base, [{ id: 0, name: '' }])).toBeNull();
  });

  it('🔴 绕回原点（先改名又改回来）→ null（终态与原文一致就不算变化）', () => {
    const named: AudioTranscript = { ...base, speakerNames: { 0: '张三' } };
    expect(
      updateSpeakerNames(named, [
        { id: 0, name: '张三丰' },
        { id: 0, name: '张三' },
      ]),
    ).toBeNull();
  });

  it('空批次 / 非数组 → null', () => {
    expect(updateSpeakerNames(base, [])).toBeNull();
    expect(updateSpeakerNames(base, undefined as unknown as Array<{ id: number; name: string }>)).toBeNull();
  });

  it('🔴 非法条目（NaN / 越界）**跳过**，其余照改（一个脏键不该让整批陪葬）', () => {
    const out = updateSpeakerNames(base, [
      { id: Number.NaN, name: '张三' },
      { id: 100, name: '越界' },
      { id: 1, name: '李四' },
    ]);
    expect(out!.speakerNames).toEqual({ 1: '李四' });
  });

  it('空名删键；全清 ⇒ 整个字段收起（老 sidecar 形状不变）', () => {
    const named: AudioTranscript = { ...base, speakerNames: { 0: '张三', 1: '李四' } };
    expect(updateSpeakerNames(named, [{ id: 0, name: '' }])!.speakerNames).toEqual({ 1: '李四' });
    expect(
      updateSpeakerNames(named, [
        { id: 0, name: '' },
        { id: 1, name: '   ' },
      ])!.speakerNames,
    ).toBeUndefined();
  });
});

describe('speakerLabel（显示名的单一真源）', () => {
  it('默认名 / 自定义名 / 未归属 三态', () => {
    expect(speakerLabel(undefined, 0)).toBe('Speaker 1');
    expect(speakerLabel({ 2: '王五' }, 2)).toBe('王五');
    expect(speakerLabel(undefined, null)).toBe('Unassigned');
  });

  it('空白名字按"没起名"处理（回落到默认名，不显示一片空白）', () => {
    expect(speakerLabel({ 0: '   ' }, 0)).toBe('Speaker 1');
  });
});

describe('parseTranscriptSidecar：speakerNames', () => {
  const good: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [{ t: 0, end: 30, speaker: 0, text: '甲' }],
    plainText: '甲',
    durationSec: 30,
    engine: 'Doubao',
    range: null,
    at: '2026-10-18T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
  };

  it('名字随 sidecar 往返（JSON 键是字符串，读回来仍按数字 id 取用）', () => {
    const withNames: AudioTranscript = { ...good, speakerNames: { 0: '张三', 1: '李四' } };
    const back = parseTranscriptSidecar(JSON.stringify(withNames));
    expect(back).toEqual(withNames);
    expect(back!.speakerNames![1]).toBe('李四');
  });

  it('没起名时不写 `speakerNames` 字段（老 sidecar 形状不变）', () => {
    expect(parseTranscriptSidecar(JSON.stringify(good))).toEqual(good);
  });

  it('🔴 脏项逐条丢弃（坏键 / 非字符串 / 空串），其余名字仍可读', () => {
    const back = parseTranscriptSidecar(
      JSON.stringify({
        ...good,
        speakerNames: { 0: '张三', '-1': '负数键', 1.5: '非整数键', 100: '越界键', 2: 42, 3: '   ' },
      }),
    );
    expect(back!.speakerNames).toEqual({ 0: '张三' });
  });

  it('名字字段是数组 / 字符串之类的畸形值 → 当没起过名（不整份失效）', () => {
    const back = parseTranscriptSidecar(JSON.stringify({ ...good, speakerNames: ['张三'] }));
    expect(back).not.toBeNull();
    expect(back!.speakerNames).toBeUndefined();
  });
});

/**
 * 手工插入行（"断句"）的自成一轮语义。
 *
 * 回归的现场：插入行默认复制上一行的 `speaker` 与 `t`，如果按"相邻同人"合并，
 * 它就成了上一轮的一部分 —— 而改归属的入口在**轮首**，用户只点了一下插入行，
 * 整轮说话人一起被改掉（重开文件后仍是错的，因为这是持久数据）。
 */
describe('groupSegmentTurns：插入行自成一轮', () => {
  const seg = (t: number, end: number, speaker: number | null, text: string, inserted?: true) => ({
    t,
    end,
    speaker,
    text,
    ...(inserted ? { inserted: true as const } : {}),
  });

  it('🔴 与上一行同人同时间也绝不并入：单独一轮，且带 inserted 标记', () => {
    const out = groupSegmentTurns([
      seg(0, 10, 0, '原话'),
      seg(0, 10, 0, '补的断句', true),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('原话');
    expect(out[1]).toMatchObject({ speaker: 0, start: 0, end: 10, text: '补的断句', inserted: true });
  });

  it('🔴 插入行后面的同人段也不许并进插入轮（否则改插入行仍会连带下一句）', () => {
    const out = groupSegmentTurns([
      seg(0, 10, 0, '原话'),
      seg(0, 10, 0, '补的断句', true),
      seg(10, 20, 0, '紧接着的下一句'),
    ]);
    expect(out).toHaveLength(3);
    expect(out[1].text).toBe('补的断句');
    expect(out[2]).toMatchObject({ start: 10, text: '紧接着的下一句' });
  });

  it('普通相邻同人段仍然合并（插入行是唯一例外）', () => {
    const out = groupSegmentTurns([seg(0, 5, 0, 'a'), seg(5, 10, 0, 'b')]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('a\nb');
  });
});

describe('findInsertedSegmentIndex（插入轮 ↔ 插入段的精确配对）', () => {
  const base = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 10, speaker: 0, text: '原话' },
      { t: 0, end: 10, speaker: 0, text: '补的断句', inserted: true as const },
      { t: 0, end: 10, speaker: 1, text: '另一条断句', inserted: true as const },
    ],
    plainText: '原话\n补的断句\n另一条断句',
    durationSec: 10,
    engine: 'Doubao',
    range: null,
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
  };
  const t = base.segments;

  it('时间完全重合时靠文字区分，不误配到邻行', () => {
    expect(findInsertedSegmentIndex(t, { start: 0, end: 10, text: '另一条断句' })).toBe(2);
    expect(findInsertedSegmentIndex(t, { start: 0, end: 10, text: '补的断句' })).toBe(1);
  });

  it('文字对不上时退回唯一时间匹配；有多条同时间则拒绝猜（-1）', () => {
    expect(findInsertedSegmentIndex([t[0]], { start: 0, end: 10, text: '改写过的' })).toBe(-1);
    expect(
      findInsertedSegmentIndex(
        [
          { t: 0, end: 10, speaker: 0, text: '原话' },
          { t: 5, end: 10, speaker: 0, text: '补的断句', inserted: true },
        ],
        { start: 5, end: 10, text: '改写过的' },
      ),
    ).toBe(1);
    expect(findInsertedSegmentIndex(t, { start: 0, end: 10, text: '改写过的' })).toBe(-1);
  });
});

describe('updateSegmentSpeakers：插入行只改自己', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 10, speaker: 0, text: '原话' },
      { t: 0, end: 10, speaker: 0, text: '补的断句', inserted: true },
      { t: 10, end: 20, speaker: 1, text: '下一句' },
    ],
    plainText: '原话\n补的断句\n下一句',
    durationSec: 20,
    engine: 'Doubao',
    range: null,
    polished: {
      at: '2026-10-21T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 10, text: '原话。' },
        { speaker: 0, start: 0, end: 10, text: '补的断句', inserted: true },
        { speaker: 1, start: 10, end: 20, text: '下一句。' },
      ],
    },
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
  };

  it('🔴 改插入行：上一行与润色稿邻轮都不动（改归属不再整轮连坐）', () => {
    const out = updateSegmentSpeakers(base, [1], 2)!;
    expect(out.segments.map((s) => s.speaker)).toEqual([0, 2, 1]);
    expect(out.polished!.turns.map((x) => x.speaker)).toEqual([0, 2, 1]);
  });

  it('🔴 改邻轮：插入行不动（润色稿里时间完全重合也各归各）', () => {
    const out = updateSegmentSpeakers(base, [0], 2)!;
    expect(out.segments.map((s) => s.speaker)).toEqual([2, 0, 1]);
    expect(out.polished!.turns.map((x) => x.speaker)).toEqual([2, 0, 1]);
  });

  it('多条同时间插入行、文字又对不上时，润色稿保留旧值（对不上就不猜）', () => {
    const edited: AudioTranscript = {
      ...base,
      segments: [
        base.segments[0],
        base.segments[1],
        { t: 0, end: 10, speaker: 0, text: '另一条断句', inserted: true },
        base.segments[2],
      ],
      polished: {
        ...base.polished!,
        turns: [
          base.polished!.turns[0],
          { ...base.polished!.turns[1], text: '被改写过的断句' },
          base.polished!.turns[2],
        ],
      },
    };
    const out = updateSegmentSpeakers(edited, [1], 2)!;
    expect(out.segments[1].speaker).toBe(2);
    expect(out.polished!.turns.map((x) => x.speaker)).toEqual([0, 0, 1]);
  });

  it('插入标记随改归属保留（不是重建段，只换个 speaker）', () => {
    const out = updateSegmentSpeakers(base, [1], 2)!;
    expect(out.segments[1].inserted).toBe(true);
    expect(out.polished!.turns[1].inserted).toBe(true);
  });
});

describe('parseTranscriptSidecar：inserted 标记往返', () => {
  const good: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 10, speaker: 0, text: '原话' },
      { t: 0, end: 10, speaker: 0, text: '补的断句', inserted: true },
    ],
    plainText: '原话\n补的断句',
    durationSec: 10,
    engine: 'Doubao',
    range: null,
    polished: {
      at: '2026-10-21T00:01:00.000Z',
      model: 'deepseek-flash',
      turns: [
        { speaker: 0, start: 0, end: 10, text: '原话。' },
        { speaker: 0, start: 0, end: 10, text: '补的断句', inserted: true },
      ],
    },
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
  };

  it('🔴 重启后插入标记仍在（否则下次改说话人又会整轮连坐）', () => {
    const back = parseTranscriptSidecar(JSON.stringify(good));
    expect(back).toEqual(good);
    expect(back!.segments[1].inserted).toBe(true);
    expect(back!.polished!.turns[1].inserted).toBe(true);
  });

  it('只有真值 true 才算插入；非布尔值不直接采信（同区间的仍会按推断认）', () => {
    const raw = JSON.stringify({
      ...good,
      segments: [
        { t: 0, end: 10, speaker: 0, text: '原话' },
        // 时间区间与上一段不同 ⇒ 推断不成立，只看字段本身（'yes' 不是 true）
        { t: 3, end: 10, speaker: 0, text: '补的断句', inserted: 'yes' },
      ],
    });
    const back = parseTranscriptSidecar(raw);
    expect(back!.segments[1].inserted).toBeUndefined();
  });
});

describe('插入 + 分组 + 改归属 端到端（真实按钮路径）', () => {
  const base: AudioTranscript = {
    version: TRANSCRIPT_VERSION,
    segments: [
      { t: 0, end: 10, speaker: 0, text: '甲说的话' },
      { t: 10, end: 20, speaker: 1, text: '乙说的话' },
    ],
    plainText: '甲说的话\n乙说的话',
    durationSec: 20,
    engine: 'Doubao',
    range: null,
    at: '2026-10-21T00:00:00.000Z',
    source: { size: 1, mtimeMs: 1 },
  };

  it('🔴 在甲下面插一句再改它的说话人：甲那一轮原封不动', () => {
    const inserted = insertSegmentAfter(base, 0, {
      speaker: 0,
      t: 0,
      end: 10,
      text: '补一句',
    })!;
    expect(inserted.segments[1]).toMatchObject({ text: '补一句', inserted: true });

    const turns = groupSegmentTurns(inserted.segments);
    // 轮首那个入口改的就是这一轮：只有新插入的那句
    expect(turns).toHaveLength(3);
    expect(turns[1].text).toBe('补一句');

    const out = updateSegmentSpeakers(inserted, [1], 2)!;
    expect(out.segments.map((s) => [s.text, s.speaker])).toEqual([
      ['甲说的话', 0],
      ['补一句', 2],
      ['乙说的话', 1],
    ]);
  });

  it('插入行落盘 → 读回 → 仍不会并回上一轮', () => {
    const inserted = insertSegmentAfter(base, 0, { speaker: 0, t: 0, end: 10, text: '补一句' })!;
    const back = parseTranscriptSidecar(JSON.stringify(inserted))!;
    const turns = groupSegmentTurns(back.segments);
    expect(turns.map((t) => t.text)).toEqual(['甲说的话', '补一句', '乙说的话']);
    expect(turns[1].inserted).toBe(true);
  });
});

/**
 * 老 sidecar 兼容：v0.7.741 及以前插入的断句**没有** `inserted` 字段。
 * 升级后只看标记 ⇒ 老断句仍会被并进邻轮（用户升级后"改说话人还是连带整轮"）。
 * 判据：插入行的时间区间是从上一行原样复制的 ⇒ 与上一段完全相同。
 */
describe('老 sidecar：无 inserted 字段的断句按时间区间推断', () => {
  const legacy = (opts: { polished?: boolean } = {}) =>
    JSON.stringify({
      version: TRANSCRIPT_VERSION,
      segments: [
        { t: 0, end: 10, speaker: 0, text: '原话' },
        { t: 0, end: 10, speaker: 0, text: '补的断句' }, // 老数据：没有 inserted
        { t: 10, end: 20, speaker: 1, text: '下一句' },
      ],
      plainText: '原话\n补的断句\n下一句',
      durationSec: 20,
      engine: 'Doubao',
      range: null,
      ...(opts.polished
        ? {
            polished: {
              at: '2026-10-21T00:01:00.000Z',
              model: 'deepseek-flash',
              turns: [
                { speaker: 0, start: 0, end: 10, text: '原话。' },
                { speaker: 0, start: 0, end: 10, text: '补的断句' },
                { speaker: 1, start: 10, end: 20, text: '下一句。' },
              ],
            },
          }
        : {}),
      at: '2026-10-21T00:00:00.000Z',
      source: { size: 1, mtimeMs: 1 },
    });

  it('🔴 读盘时固化标记：只有那条同区间的段被标成插入行', () => {
    const back = parseTranscriptSidecar(legacy())!;
    expect(back.segments[0].inserted).toBeUndefined();
    expect(back.segments[1].inserted).toBe(true);
    expect(back.segments[2].inserted).toBeUndefined();
  });

  it('🔴 不依赖标记也能断轮：老数据分组后仍是三条独立的轮', () => {
    const raw = [
      { t: 0, end: 10, speaker: 0, text: '原话' },
      { t: 0, end: 10, speaker: 0, text: '补的断句' },
      { t: 10, end: 20, speaker: 0, text: '下一句' },
    ];
    expect(groupSegmentTurns(raw).map((t) => t.text)).toEqual(['原话', '补的断句', '下一句']);
  });

  it('🔴 老数据也能只改插入行：邻轮（原文稿与润色稿）都不动', () => {
    const back = parseTranscriptSidecar(legacy({ polished: true }))!;
    expect(back.polished!.turns[1].inserted).toBe(true);
    expect(back.polished!.turns[0].inserted).toBeUndefined();
    const out = updateSegmentSpeakers(back, [1], 2)!;
    expect(out.segments.map((s) => s.speaker)).toEqual([0, 2, 1]);
    expect(out.polished!.turns.map((t) => t.speaker)).toEqual([0, 2, 1]);
  });

  it('润色轮文字被改过时，用"同区间的后一轮"认出插入轮', () => {
    const raw = JSON.parse(legacy({ polished: true }));
    raw.polished.turns[1].text = '润色后改写的断句';
    const back = parseTranscriptSidecar(JSON.stringify(raw))!;
    expect(back.polished!.turns[1].inserted).toBe(true);
    expect(back.polished!.turns[0].inserted).toBeUndefined();
  });
});
