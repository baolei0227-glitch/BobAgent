/**
 * 转写时间戳平移的回归测试（shiftTranscriptStamps）。
 *
 * 为什么值得测：超限录音被切片转写后，各片戳必须平移到合并音频时间轴，
 * 否则回放字幕整体错位——且错位是"静默"的（文件能打开、只是点哪都跳不准）。
 */
import { describe, expect, it } from 'vitest';
import { shiftTranscriptStamps } from './meeting-session';

const S = (mm: string, ss: string) => `[${mm}:${ss}]`;

describe('shiftTranscriptStamps', () => {
  it('平移独占行的戳，正文与 [说话人 N] 不动', () => {
    const text = `${S('00', '05')}\n[说话人 1]\n你好\n\n${S('01', '30')}\n再见`;
    expect(shiftTranscriptStamps(text, 600)).toBe(
      `${S('10', '05')}\n[说话人 1]\n你好\n\n${S('11', '30')}\n再见`,
    );
  });

  it('秒进位到分（60 秒不进位成 60）', () => {
    expect(shiftTranscriptStamps(`${S('00', '50')}\n甲`, 20)).toBe(`${S('01', '10')}\n甲`);
    expect(shiftTranscriptStamps(`${S('59', '30')}\n甲`, 45)).toBe(`${S('60', '15')}\n甲`);
  });

  it('跨 100 分钟自然成三位分钟', () => {
    expect(shiftTranscriptStamps(`${S('99', '00')}\n甲`, 120)).toBe(`${S('101', '00')}\n甲`);
  });

  it('offset <= 0 原样返回（含 0 与负数）', () => {
    const text = `${S('00', '05')}\n甲`;
    expect(shiftTranscriptStamps(text, 0)).toBe(text);
    expect(shiftTranscriptStamps(text, -10)).toBe(text);
  });

  it('行内方括号与非法戳不动', () => {
    const text = `他说 [00:05] 了\n${S('1', '5')}\n甲\n[说话人 2]`;
    expect(shiftTranscriptStamps(text, 60)).toBe(`他说 [00:05] 了\n${S('1', '5')}\n甲\n[说话人 2]`);
  });

  it('保留正文里的空行结构（不压行）', () => {
    expect(shiftTranscriptStamps(`${S('00', '00')}\n甲\n\n${S('00', '30')}\n乙`, 30)).toBe(
      `${S('00', '30')}\n甲\n\n${S('01', '00')}\n乙`,
    );
  });
});