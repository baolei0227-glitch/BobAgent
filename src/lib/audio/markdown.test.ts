import { describe, expect, it } from 'vitest';
import { hasPolishedTranscript, hasTranscriptInRange, transcriptToMarkdown } from '@/lib/audio/markdown';
import { TRANSCRIPT_VERSION, type AudioTranscript } from '@/lib/audio/transcript';

const base: AudioTranscript = {
  version: TRANSCRIPT_VERSION,
  segments: [
    { t: 0, end: 3, speaker: 0, text: '原文甲' },
    { t: 3, end: 7, speaker: null, text: '原文乙' },
  ],
  plainText: '原文甲\n原文乙',
  durationSec: 7,
  engine: 'Test',
  range: null,
  at: '2026-10-18T00:00:00.000Z',
  source: { size: 1, mtimeMs: 1 },
};

describe('transcriptToMarkdown', () => {
  it('raw：保留说话人与时间戳，标记 ASR 原文', () => {
    const md = transcriptToMarkdown(base, { title: '测试录音', variant: 'raw', generatedAt: new Date('2026-10-18T00:00:00Z') });
    expect(md).toContain('# 测试录音 — 对话稿');
    expect(md).toContain('版本：ASR 原文');
    expect(md).toContain('### Speaker 1 · 00:00–00:03');
    expect(md).toContain('### 未标注说话人 · 00:03–00:07');
    expect(md).toContain('原文甲');
  });

  it('polished：用润色轮，模型写进元信息', () => {
    const t: AudioTranscript = {
      ...base,
      polished: {
        at: '2026-10-18T00:01:00.000Z',
        model: 'deepseek-flash',
        turns: [
          { speaker: 0, start: 0, end: 3, text: '润色甲。' },
          { speaker: null, start: 3, end: 7, text: '润色乙。' },
        ],
      },
    };
    expect(hasPolishedTranscript(t)).toBe(true);
    const md = transcriptToMarkdown(t, { title: '测试录音', variant: 'polished' });
    expect(md).toContain('版本：DeepSeek 润色（deepseek-flash）');
    expect(md).toContain('润色甲。');
    expect(md).not.toContain('原文甲');
  });

  it('🔴 起过名的说话人在导出件里也叫这个名字（否则"面板改了、导出没改"看着像没保存）', () => {
    const named: AudioTranscript = { ...base, speakerNames: { 0: '张三' } };
    expect(transcriptToMarkdown(named, { title: '测试录音', variant: 'raw' })).toContain(
      '### 张三 · 00:00–00:03',
    );
  });

  it('只有名字、没归属的轮仍写「未标注说话人」（两者不是一回事）', () => {
    const named: AudioTranscript = { ...base, speakerNames: { 0: '张三' } };
    expect(transcriptToMarkdown(named, { title: '测试录音', variant: 'raw' })).toContain(
      '### 未标注说话人 · 00:03–00:07',
    );
  });

  it('片段区间：只保留重叠轮，时间改成片段内相对时间，并写明源区间', () => {
    const md = transcriptToMarkdown(base, {
      title: '片段一',
      variant: 'raw',
      range: { start: 2, end: 6 },
    });
    expect(md).toContain('源区间：00:02–00:06');
    expect(md).toContain('片段时长：00:04');
    expect(md).toContain('### Speaker 1 · 00:00–00:01');
    expect(md).toContain('### 未标注说话人 · 00:01–00:04');
    // 跨边界的句子整句保留（不做半句截断）
    expect(md).toContain('原文甲');
  });

  it('片段区间：完全在区间外的句子被过滤', () => {
    const md = transcriptToMarkdown(base, {
      title: '片段二',
      variant: 'raw',
      range: { start: 4, end: 6 },
    });
    expect(md).not.toContain('原文甲');
    expect(md).toContain('原文乙');
    expect(md).toContain('### 未标注说话人 · 00:00–00:02');
  });

  it('区间内没有句子 → hasTranscriptInRange=false（导出前可挡住空稿）', () => {
    expect(hasTranscriptInRange(base, { start: 100, end: 120 })).toBe(false);
    expect(hasTranscriptInRange(base, { start: 0, end: 1 })).toBe(true);
  });

  it('没有润色块时 polished 自动退回 raw，不产生空文档', () => {
    const md = transcriptToMarkdown(base, { title: '测试录音', variant: 'polished' });
    expect(md).toContain('版本：ASR 原文');
    expect(md).toContain('原文甲');
  });
});
