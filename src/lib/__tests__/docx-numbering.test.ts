import { describe, it, expect } from 'vitest';
import {
  chineseNumbering,
  letterNumbering,
  formatCount,
  substituteLvlText,
  NumberingCounter,
} from '../docx-to-md';
import type { NumberingLevel, NumberingModel } from '../docx-to-md';

describe('chineseNumbering', () => {
  it('小写中文编号', () => {
    expect(chineseNumbering(1)).toBe('一');
    expect(chineseNumbering(9)).toBe('九');
    expect(chineseNumbering(10)).toBe('十');
    expect(chineseNumbering(11)).toBe('十一');
    expect(chineseNumbering(20)).toBe('二十');
    expect(chineseNumbering(105)).toBe('一百零五');
    expect(chineseNumbering(110)).toBe('一百一十');
    expect(chineseNumbering(1000)).toBe('一千');
    expect(chineseNumbering(1005)).toBe('一千零五');
    expect(chineseNumbering(1010)).toBe('一千零一十');
    expect(chineseNumbering(9999)).toBe('九千九百九十九');
  });

  it('大写（法律）编号', () => {
    expect(chineseNumbering(1, true)).toBe('壹');
    expect(chineseNumbering(10, true)).toBe('壹拾');
    expect(chineseNumbering(20, true)).toBe('贰拾');
    expect(chineseNumbering(105, true)).toBe('壹佰零伍');
  });

  it('越界回退十进制', () => {
    expect(chineseNumbering(0)).toBe('0');
    expect(chineseNumbering(10000)).toBe('10000');
  });
});

describe('letterNumbering', () => {
  it('Excel 列号式进位', () => {
    expect(letterNumbering(1)).toBe('a');
    expect(letterNumbering(26)).toBe('z');
    expect(letterNumbering(27)).toBe('aa');
    expect(letterNumbering(28)).toBe('ab');
    expect(letterNumbering(52)).toBe('az');
    expect(letterNumbering(53)).toBe('ba');
  });

  it('大写', () => {
    expect(letterNumbering(1, true)).toBe('A');
    expect(letterNumbering(27, true)).toBe('AA');
  });
});

describe('formatCount', () => {
  it('十进制与补零', () => {
    expect(formatCount('decimal', 7)).toBe('7');
    expect(formatCount('decimalZero', 3)).toBe('03');
  });

  it('字母与罗马', () => {
    expect(formatCount('lowerLetter', 3)).toBe('c');
    expect(formatCount('upperLetter', 3)).toBe('C');
    expect(formatCount('lowerRoman', 9)).toBe('ix');
    expect(formatCount('upperRoman', 14)).toBe('XIV');
  });

  it('中文与未识别格式', () => {
    expect(formatCount('chineseCounting', 12)).toBe('十二');
    expect(formatCount('chineseLegalSimplified', 12)).toBe('壹拾贰');
    expect(formatCount('ideographDigital', 5)).toBe('五');
    expect(formatCount('none', 5)).toBe('');
    expect(formatCount('unknownFmt', 5)).toBe('5');
  });
});

describe('substituteLvlText', () => {
  const levels = new Map<number, NumberingLevel>([
    [0, { numFmt: 'decimal', lvlText: '%1.', start: 5 }],
    [1, { numFmt: 'lowerLetter', lvlText: '%2)', start: 1 }],
  ]);

  it('按计数替换 %N', () => {
    expect(substituteLvlText('%1.%2', [2, 3], levels)).toBe('2.c');
  });

  it('模板中的非 % 字符原样保留', () => {
    expect(substituteLvlText('%1.%2)', [2, 3], levels)).toBe('2.c)');
    const cnLevels = new Map<number, NumberingLevel>([
      [0, { numFmt: 'chineseCounting', lvlText: '%1、', start: 1 }],
    ]);
    expect(substituteLvlText('%1、', [3], cnLevels)).toBe('三、');
  });

  it('缺计数时回退该级 start', () => {
    expect(substituteLvlText('%1', [undefined], levels)).toBe('5');
    expect(substituteLvlText('%1.%2', [4, undefined], levels)).toBe('4.a');
  });
});

describe('NumberingCounter', () => {
  const model: NumberingModel = new Map([
    [
      1,
      new Map<number, NumberingLevel>([
        [0, { numFmt: 'decimal', lvlText: '%1.', start: 1 }],
        [1, { numFmt: 'decimal', lvlText: '%1.%2', start: 1 }],
      ]),
    ],
    [2, new Map<number, NumberingLevel>([[0, { numFmt: 'chineseCounting', lvlText: '%1、', start: 1 }]])],
    [3, new Map<number, NumberingLevel>([[0, { numFmt: 'bullet', lvlText: '•', start: 1 }]])],
  ]);

  it('层级计数与深层重置', () => {
    const counter = new NumberingCounter(model);
    expect(counter.advance(1, 0)).toBe('1.');
    expect(counter.advance(1, 0)).toBe('2.');
    expect(counter.advance(1, 1)).toBe('2.1');
    expect(counter.advance(1, 1)).toBe('2.2');
    // 推进浅层级 → 深层级重新从 start 计数
    expect(counter.advance(1, 0)).toBe('3.');
    expect(counter.advance(1, 1)).toBe('3.1');
  });

  it('计数按 numId 独立', () => {
    const counter = new NumberingCounter(model);
    counter.advance(1, 0);
    counter.advance(1, 0);
    expect(counter.advance(2, 0)).toBe('一、');
    expect(counter.advance(1, 0)).toBe('3.');
  });

  it('bullet 与未知 numId 返回 null（不注入）', () => {
    const counter = new NumberingCounter(model);
    expect(counter.advance(3, 0)).toBeNull();
    expect(counter.advance(99, 0)).toBeNull();
  });
});
