import { describe, expect, it } from 'vitest';
import { parseSherpaStdoutLines } from '@/lib/stt/sherpa';

/**
 * 批量转写输出的**配对**不变量：一行一个文件、顺序与入参一致。
 * 一旦配对错位，就会把某一段的话贴到另一段的标题/说话人上——比少转一段严重得多，
 * 所以行数不符必须抛错（调用方据此退回逐段转写）。
 */
describe('parseSherpaStdoutLines', () => {
  it('逐行解析并**保留位置**（空文本也占一位）', () => {
    const stdout = [
      '{"text": "第一段"}',
      'Some engine log line',
      '{"text": ""}',
      '{"text": "第三段"}',
    ].join('\n');
    expect(parseSherpaStdoutLines(stdout)).toEqual(['第一段', '', '第三段']);
  });

  it('行数与期望不符 → 抛错（拒绝错位）', () => {
    const stdout = '{"text": "只有一段"}';
    expect(() => parseSherpaStdoutLines(stdout, 2)).toThrow(/refusing to misalign/);
  });

  it('行数相符时不抛错', () => {
    expect(parseSherpaStdoutLines('{"text":"a"}\n{"text":"b"}', 2)).toEqual(['a', 'b']);
  });

  it('没有 JSON 行 → 空数组（调用方按「没识别出内容」处理）', () => {
    expect(parseSherpaStdoutLines('config dump\nprogress 50%')).toEqual([]);
  });
});
