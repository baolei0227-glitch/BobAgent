import { describe, expect, it } from 'vitest';
import { parseTranscriptSegments, SPEAKER_LABEL_RE } from '@/lib/core/meeting-transcript';

/**
 * 回放分段解析的不变量：戳与说话人标签都是**独占一行**的元信息，绝不能混进正文。
 * 说话人标签是否被正确抽走，直接决定回放能不能显示人名（渲染时才映射，文稿不改）。
 * 这些 `[说话人 N]` 只来自**会后的整段重转**——会议进行中不做说话人识别。
 */
describe('parseTranscriptSegments', () => {
  it('只取最后一个 `## 全文转写` 之后的部分（抬头/纪要正文不参与分段）', () => {
    const md = [
      '# 会议记录 - X',
      '## 纪要',
      '[00:10]',
      '这段是纪要正文，不该被当成转写段',
      '## 全文转写',
      '[00:00]',
      '真正的转写',
    ].join('\n');
    expect(parseTranscriptSegments(md)).toEqual([{ t: 0, speaker: null, text: '真正的转写' }]);
  });

  it('说话人标签抽成 speaker（1 基 → 0 基），不进正文', () => {
    const md = ['## 全文转写', '[00:05]', '[说话人 2]', '你好', '', '[01:05]', '[说话人 1]', '嗯。'].join('\n');
    expect(parseTranscriptSegments(md)).toEqual([
      { t: 5, speaker: 1, text: '你好' },
      { t: 65, speaker: 0, text: '嗯。' },
    ]);
  });

  it('没有标签的旧产物 / 单人录音 → speaker 为 null', () => {
    expect(parseTranscriptSegments('## 全文转写\n[00:00]\n只有正文')).toEqual([
      { t: 0, speaker: null, text: '只有正文' },
    ]);
  });

  it('同一段里多出来的标签行被丢弃（一段只归一个说话人）；夹在正文里的 `[说话人 N]` 不当标签', () => {
    const md = ['## 全文转写', '[00:00]', '[说话人 1]', '[说话人 2]', '他说「[说话人 3]」这三个字'].join('\n');
    expect(parseTranscriptSegments(md)).toEqual([
      { t: 0, speaker: 0, text: '他说「[说话人 3]」这三个字' },
    ]);
  });

  it('多行正文按序拼成一段（保留换行）', () => {
    expect(parseTranscriptSegments('## 全文转写\n[00:00]\n第一行\n第二行')).toEqual([
      { t: 0, speaker: null, text: '第一行\n第二行' },
    ]);
  });

  it('没有戳 → 返回空数组（调用方退化为纯文本展示）', () => {
    expect(parseTranscriptSegments('## 全文转写\n一段没有时间戳的纯文本')).toEqual([]);
  });

  it('空白段（只有戳没有正文）被丢弃', () => {
    expect(parseTranscriptSegments('## 全文转写\n[00:00]\n[01:00]\n有内容')).toEqual([
      { t: 60, speaker: null, text: '有内容' },
    ]);
  });

  it('超过 99 分钟照常进位', () => {
    expect(parseTranscriptSegments('## 全文转写\n[100:30]\n冗长的会')).toEqual([
      { t: 100 * 60 + 30, speaker: null, text: '冗长的会' },
    ]);
  });
});

describe('SPEAKER_LABEL_RE', () => {
  it('只认独占一行的编号标签（名字形式不属于本功能）', () => {
    expect(SPEAKER_LABEL_RE.test('[说话人 1]')).toBe(true);
    expect(SPEAKER_LABEL_RE.test('[说话人 12]')).toBe(true);
    expect(SPEAKER_LABEL_RE.test('[说话人1]')).toBe(true);
    expect(SPEAKER_LABEL_RE.test('[说话人 1] 他说')).toBe(false);
    expect(SPEAKER_LABEL_RE.test('见 [说话人 1]')).toBe(false);
    expect(SPEAKER_LABEL_RE.test('[Speaker 1]')).toBe(false);
    expect(SPEAKER_LABEL_RE.test('[说话人 张三]')).toBe(false);
  });
});
