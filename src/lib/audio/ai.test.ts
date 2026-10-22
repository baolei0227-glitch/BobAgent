import { describe, expect, it } from 'vitest';
import {
  cleanClipName,
  extractJsonArray,
  MAX_CLIP_NAME_CHARS,
  MAX_HIGHLIGHTS,
  normalizeHighlights,
  transcriptForPrompt,
} from '@/lib/audio/ai';
import type { TranscriptSegment } from '@/lib/audio/transcript';

/**
 * 这一层全部是"模型输出 → 可信数据"的纯函数，所以用例的重点不是"正常路径能跑"，
 * 而是**负面路径**：模型会返回代码块、会带解释、会返回越界区间、会给重复项。
 * 判据必须能真的失败 —— 见每个 `🔴` 用例。
 */

describe('extractJsonArray', () => {
  it('纯数组', () => {
    expect(extractJsonArray('[{"start":1,"end":2}]')).toEqual([{ start: 1, end: 2 }]);
  });

  it('包在 ```json 代码块里', () => {
    const raw = '```json\n[{"start":1,"end":2}]\n```';
    expect(extractJsonArray(raw)).toEqual([{ start: 1, end: 2 }]);
  });

  it('前面带一句解释（取首个 [ 到末个 ]）', () => {
    const raw = '好的，以下是我挑选的片段：\n[{"start":1,"end":2}]\n希望有用。';
    expect(extractJsonArray(raw)).toEqual([{ start: 1, end: 2 }]);
  });

  it('外面套一层 {"highlights": [...]}', () => {
    const raw = '{"highlights":[{"start":5,"end":9}]}';
    expect(extractJsonArray(raw)).toEqual([{ start: 5, end: 9 }]);
  });

  it('🔴 解析不出来返回 null（不是抛错、不是空数组）', () => {
    expect(extractJsonArray('我觉得这段挺好的')).toBeNull();
    expect(extractJsonArray('[{"start":1,')).toBeNull();
    expect(extractJsonArray('')).toBeNull();
    expect(extractJsonArray('{"a":1}')).toBeNull();
  });
});

describe('cleanClipName', () => {
  it('取第一行、剥引号、去结尾标点、压空白', () => {
    expect(cleanClipName('  “预算分配方案”。  ')).toBe('预算分配方案');
    expect(cleanClipName('标题：预算分配\n理由：随便')).toBe('标题：预算分配');
  });

  it('剥掉文件名非法字符（这个结果会进文件名）', () => {
    expect(cleanClipName('预算/排期:方案*')).toBe('预算 排期 方案');
  });

  it('超长按码点截断到 12 字', () => {
    const long = '这是一个特别特别长的标题需要被截断掉';
    const out = cleanClipName(long);
    expect([...out].length).toBeLessThanOrEqual(MAX_CLIP_NAME_CHARS);
  });

  it('🔴 空/纯无效输出 → 空串（调用方据此报错，而不是拿到 "undefined" 之类的假名）', () => {
    expect(cleanClipName('')).toBe('');
    expect(cleanClipName('   \n  ')).toBe('');
    expect(cleanClipName('```json\n```')).toBe('');
  });
});

describe('normalizeHighlights', () => {
  const dur = 100;

  it('正常条目按原样通过', () => {
    expect(normalizeHighlights([{ start: 10, end: 40, title: '预算', reason: '三个口径' }], dur)).toEqual([
      { start: 10, end: 40, title: '预算', reason: '三个口径' },
    ]);
  });

  it('标题为空 → 用理由前 12 字兜底', () => {
    const out = normalizeHighlights([{ start: 10, end: 40, title: '  ', reason: '给出了三个可选口径供拍板' }], dur);
    expect(out[0].title).toBe('给出了三个可选口径供拍板'.slice(0, 12));
  });

  it('🔴 越界 / 倒置 / NaN / 非对象 一律丢弃（不做边界钳位）', () => {
    const out = normalizeHighlights(
      [
        { start: 10, end: 40, title: '好的一条' },
        { start: 10, end: 400, title: '越界' },
        { start: 40, end: 10, title: '倒置' },
        { start: 'abc', end: 40, title: 'NaN' },
        { start: 50, end: 50.5, title: '太短' },
        'nonsense',
        null,
      ],
      dur,
    );
    expect(out.map((h) => h.title)).toEqual(['好的一条']);
  });

  it('同 start 去重 + 截到上限', () => {
    const dup = normalizeHighlights([{ start: 10, end: 40, title: 'a' }, { start: 10, end: 60, title: 'b' }], dur);
    expect(dup).toHaveLength(1);
    const many = Array.from({ length: 20 }, (_, i) => ({ start: i * 4, end: i * 4 + 3, title: `t${i}` }));
    expect(normalizeHighlights(many, dur)).toHaveLength(MAX_HIGHLIGHTS);
  });

  it('接受 {highlights:[...]} 形态；非数组 → 空', () => {
    expect(normalizeHighlights({ highlights: [{ start: 1, end: 5, title: 'x' }] }, dur)).toHaveLength(1);
    expect(normalizeHighlights('nope', dur)).toEqual([]);
  });

  it('时长未知（null）时只校验跨度，不校验上界', () => {
    expect(normalizeHighlights([{ start: 10, end: 40, title: 'x' }], null)).toHaveLength(1);
  });
});

describe('transcriptForPrompt', () => {
  const seg = (t: number, text: string, speaker: number | null = null): TranscriptSegment => ({
    t,
    end: t + 10,
    speaker,
    text,
  });

  it('每行 [mm:ss] + 可选说话人 + 压平空白', () => {
    const out = transcriptForPrompt([seg(0, '开场\n白'), seg(65, '第二段', 1)]);
    expect(out).toBe('[00:00] 开场 白\n[01:05] [说话人 2] 第二段');
  });

  it('超长截断并留痕（不让 prompt 失控）', () => {
    const segs = Array.from({ length: 50 }, (_, i) => seg(i * 10, 'x'.repeat(100)));
    const out = transcriptForPrompt(segs, 300);
    expect(out.length).toBeLessThan(400);
    expect(out).toContain('已省略');
  });
});
