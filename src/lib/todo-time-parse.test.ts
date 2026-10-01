import { describe, expect, it } from 'vitest';
import { parseTodoTime } from '@/lib/todo-time-parse';

/**
 * 时间短语 → 具体日期/时刻的确定性解析（resolve_datetime 工具的内核）。
 *
 * 该模块是「把时间交给工具算、不让 LLM 心算」的落点，因此用例重点守：
 *   - 相对时刻偏移（10分钟后 / 2小时后 / 半小时后 / 一个半小时后）与跨午夜；
 *   - 既有日期/时刻表达不被这次扩展破坏（回归）；
 *   - 非法/无时间输入返回 null，绝不硬凑一个时间。
 *
 * 全部用固定的 NOW，避免用例随时间飘。
 */

/** 2026-09-27 10:00 本地（周日） */
const NOW = new Date(2026, 8, 27, 10, 0);

describe('parseTodoTime — 相对时刻', () => {
  it('10分钟后 → 同日 10:10，并剔出主题', () => {
    expect(parseTodoTime('10分钟后喝水', NOW)).toEqual({
      date: '2026-09-27',
      time: '10:10',
      topic: '喝水',
    });
  });

  it('2小时后 → 同日 12:00', () => {
    expect(parseTodoTime('2小时后开会', NOW)).toEqual({
      date: '2026-09-27',
      time: '12:00',
      topic: '开会',
    });
  });

  it('半小时后 → 同日 10:30', () => {
    expect(parseTodoTime('半小时后', NOW)).toEqual({ date: '2026-09-27', time: '10:30' });
  });

  it('一个半小时后 → 同日 11:30', () => {
    expect(parseTodoTime('一个半小时后', NOW)).toEqual({ date: '2026-09-27', time: '11:30' });
  });

  it('两小时后（中文数字）→ 同日 12:00', () => {
    expect(parseTodoTime('两小时后开会', NOW)).toEqual({
      date: '2026-09-27',
      time: '12:00',
      topic: '开会',
    });
  });

  it('跨午夜：23:30 的「2小时后」落到次日 01:30', () => {
    expect(parseTodoTime('2小时后', new Date(2026, 8, 27, 23, 30))).toEqual({
      date: '2026-09-28',
      time: '01:30',
    });
  });
});

describe('parseTodoTime — 日期/时刻表达（回归）', () => {
  it('明天下午3点开会', () => {
    expect(parseTodoTime('明天下午3点开会', NOW)).toEqual({
      date: '2026-09-28',
      time: '15:00',
      topic: '开会',
    });
  });

  it('下周五下午3点 → 2026-10-02（周一为一周之始）', () => {
    expect(parseTodoTime('下周五下午3点', NOW)).toEqual({
      date: '2026-10-02',
      time: '15:00',
    });
  });

  it('tomorrow 3pm（英文）', () => {
    expect(parseTodoTime('tomorrow 3pm', NOW)).toEqual({ date: '2026-09-28', time: '15:00' });
  });

  it('只有日期（明天）→ 不带 time', () => {
    expect(parseTodoTime('明天', NOW)).toEqual({ date: '2026-09-28' });
  });

  it('只有时刻且已过（10:00 说「9点」）→ 顺延到明天', () => {
    expect(parseTodoTime('9点开会', NOW)).toEqual({
      date: '2026-09-28',
      time: '09:00',
      topic: '开会',
    });
  });

  it('非法时刻 25:00 / 无时间文本 → null', () => {
    expect(parseTodoTime('25:00', NOW)).toBeNull();
    expect(parseTodoTime('随便聊聊', NOW)).toBeNull();
    expect(parseTodoTime('', NOW)).toBeNull();
  });
});