import { describe, expect, it } from 'vitest';
import {
  coerceRecurrence,
  occurrencesInWindow,
  occurrencesInWindowDetailed,
  parseRecurrence,
  recurrenceLabel,
  serializeRecurrence,
  type RecurrenceRule,
} from '@/lib/calendar/recurrence';

/**
 * 周期重复规则与「扫描窗口内实例展开」的纯逻辑不变量。
 *
 * 这套用例守的是 event-reminder 周期提醒最容易出错的两处：
 *   1. 实例展开必须**按窗口**取（不再是「事件只有一个 start_time」）；
 *      一次性事件窗口退化为自身，周期事件才逐实例展开，且不做长循环；
 *   2. 窗口边界：实例开始 ∈ (now - 补发窗口, now + 最大提前量]。
 *      —— 今天 9:00 已过但仍在 24h 补发窗口内 → **仍要提醒**；
 *      —— 24h 之外的更早实例 → 不再提醒（否则每天会补一堆旧账）。
 *
 * 时区安全：全部用本地时间构造 Date，避免 CI 换时区导致用例飘。
 */

/** 本地时间 → ms */
const at = (y: number, m: number, d: number, h = 0, mi = 0, s = 0): number =>
  new Date(y, m - 1, d, h, mi, s).getTime();

const H = 3_600_000;
const DAY = 24 * H;
/** event-reminder 的扫描窗口：补发 24h + 最大提前量 30min */
const WINDOW = { windowBeforeMs: DAY, windowAfterMs: 30 * 60_000 };

describe('parseRecurrence / serializeRecurrence', () => {
  it('解析合法规则（daily / weekly，含 until）', () => {
    expect(parseRecurrence('{"freq":"daily"}')).toEqual({ freq: 'daily', until: null });
    expect(parseRecurrence('{"freq":"weekly","until":"2026-12-31T00:00:00.000Z"}')).toEqual({
      freq: 'weekly',
      until: '2026-12-31T00:00:00.000Z',
    });
  });

  it('非法 / 缺失输入 → null（视为不重复）', () => {
    for (const bad of [null, undefined, '', '{}', '{"freq":"monthly"}', 'garbage', '[]', '"daily"']) {
      expect(parseRecurrence(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });

  it('序列化：无规则 → null；非法 freq → null；非法 until 丢弃', () => {
    expect(serializeRecurrence(null)).toBeNull();
    expect(serializeRecurrence(undefined)).toBeNull();
    expect(serializeRecurrence({ freq: 'monthly' } as unknown as RecurrenceRule)).toBeNull();
    expect(serializeRecurrence({ freq: 'daily' })).toBe('{"freq":"daily"}');
    expect(serializeRecurrence({ freq: 'weekly', until: 'not-a-date' })).toBe('{"freq":"weekly"}');
    expect(serializeRecurrence({ freq: 'weekly', until: '2026-12-31T00:00:00.000Z' })).toBe(
      '{"freq":"weekly","until":"2026-12-31T00:00:00.000Z"}',
    );
  });

  it('coerceRecurrence：对象 / JSON 字符串 / null 归一化一致', () => {
    expect(coerceRecurrence({ freq: 'daily' })).toEqual({ freq: 'daily', until: null });
    expect(coerceRecurrence('{"freq":"weekly"}')).toEqual({ freq: 'weekly', until: null });
    expect(coerceRecurrence(null)).toBeNull();
    expect(coerceRecurrence(42)).toBeNull();
  });

  it('recurrenceLabel 输出英文短标签', () => {
    expect(recurrenceLabel({ freq: 'daily' })).toBe('daily');
    expect(recurrenceLabel({ freq: 'weekly' })).toBe('weekly');
    expect(recurrenceLabel(null)).toBeNull();
  });
});

describe('occurrencesInWindow — daily', () => {
  const base = at(2026, 9, 25, 9, 0); // 9/25 09:00
  const rule: RecurrenceRule = { freq: 'daily' };

  it('今天 9:00 已过但在 24h 补发窗口内 → 仍展开今天实例（不含更早的同刻实例）', () => {
    // now = 10/10 10:00 → 窗口 (10/9 10:00, 10/10 10:30]，只有 10/10 09:00
    expect(occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 10, 10, 10, 0), WINDOW)).toEqual([
      at(2026, 10, 10, 9, 0),
    ]);
  });

  it('跨补发窗口边界：昨天 9:00 与今天 9:00 都在窗口内时两条都返回（升序）', () => {
    // now = 10/10 08:45 → 窗口 (10/9 08:45, 10/10 09:15] → 10/9 09:00 与 10/10 09:00
    expect(occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 10, 10, 8, 45), WINDOW)).toEqual([
      at(2026, 10, 9, 9, 0),
      at(2026, 10, 10, 9, 0),
    ]);
  });

  it('提醒尚未到点（今天 9:00 在窗口 forward 之外）→ 不返回', () => {
    // now = 10/10 08:00 → 窗口 (10/9 08:00, 10/10 08:30] → 今天 09:00 超出 hi；昨天 09:00 在窗口内
    expect(occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 10, 10, 8, 0), WINDOW)).toEqual([
      at(2026, 10, 9, 9, 0),
    ]);
  });

  it('保留本地墙钟时间（长期跳周期后仍是 09:00）', () => {
    const occ = occurrencesInWindow(new Date(base).toISOString(), rule, at(2027, 3, 8, 9, 0), {
      windowBeforeMs: 0,
      windowAfterMs: 30 * 60_000,
    });
    expect(occ).toEqual([at(2027, 3, 8, 9, 0)]);
  });

  it('首实例晚于「现在+窗口」→ 不返回（未来事件不该提前补发）', () => {
    const future = at(2026, 9, 30, 9, 0);
    expect(
      occurrencesInWindow(new Date(future).toISOString(), rule, at(2026, 9, 25, 9, 0), WINDOW),
    ).toEqual([]);
  });
});

describe('occurrencesInWindow — weekly', () => {
  const base = at(2026, 9, 25, 9, 0); // 周五 09:00
  const rule: RecurrenceRule = { freq: 'weekly' };

  it('只在同一星期几命中（隔天不产生实例）', () => {
    // now = 10/9（周五）08:45 → 窗口含 10/9 09:00
    expect(occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 10, 9, 8, 45), WINDOW)).toEqual([
      at(2026, 10, 9, 9, 0),
    ]);
    // now = 10/8（周四）09:00 → 附近无周五实例
    expect(occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 10, 8, 9, 0), WINDOW)).toEqual([]);
  });
});

describe('occurrencesInWindow — until', () => {
  const base = at(2026, 9, 25, 9, 0);

  it('超过 until 的实例不再展开', () => {
    const until = new Date(at(2026, 10, 5, 23, 59, 59)).toISOString();
    expect(
      occurrencesInWindow(
        new Date(base).toISOString(),
        { freq: 'daily', until },
        at(2026, 10, 10, 9, 0),
        WINDOW,
      ),
    ).toEqual([]);
  });

  it('until 含当天：恰为 until 时刻的实例仍展开（同窗口内更早实例也照常给出）', () => {
    const until = new Date(at(2026, 10, 10, 9, 0)).toISOString();
    expect(
      occurrencesInWindow(
        new Date(base).toISOString(),
        { freq: 'daily', until },
        at(2026, 10, 10, 9, 0),
        WINDOW,
      ),
    ).toEqual([at(2026, 10, 9, 9, 0), at(2026, 10, 10, 9, 0)]);
  });
});

describe('parseRecurrence / serializeRecurrence — RRULE 子集', () => {
  it('解析扩展字段（interval / byday / count / exdate / tzid）', () => {
    const raw = JSON.stringify({
      freq: 'weekly',
      interval: 2,
      byday: [3, 1, 3, 9], // 9 非法丢弃、3 去重
      count: 5,
      exdate: ['2026-10-05T01:00:00.000Z', 'garbage'],
      tzid: 'Asia/Shanghai',
    });
    expect(parseRecurrence(raw)).toEqual({
      freq: 'weekly',
      interval: 2,
      byday: [1, 3],
      count: 5,
      exdate: ['2026-10-05T01:00:00.000Z'],
      tzid: 'Asia/Shanghai',
      until: null,
    });
  });

  it('interval=1 视为默认（不落到结果里）；非法 tzid 丢弃', () => {
    expect(parseRecurrence('{"freq":"daily","interval":1}')).toEqual({ freq: 'daily', until: null });
    expect(parseRecurrence('{"freq":"daily","tzid":"Not/AZone"}')).toEqual({ freq: 'daily', until: null });
  });

  it('序列化扩展字段并按固定键序输出（until 恒在末位）', () => {
    expect(
      serializeRecurrence({
        freq: 'weekly',
        interval: 2,
        byday: [3, 1],
        count: 5,
        until: '2026-12-31T00:00:00.000Z',
      }),
    ).toBe(
      '{"freq":"weekly","interval":2,"byday":[1,3],"count":5,"until":"2026-12-31T00:00:00.000Z"}',
    );
  });

  it('overrides 归一化：非法项丢弃、title 空串 → null', () => {
    const raw = JSON.stringify({
      freq: 'daily',
      overrides: [
        { instance: '2026-10-05T01:00:00.000Z', start_time: '2026-10-05T06:00:00.000Z', title: '' },
        { instance: 'bad', start_time: '2026-10-06T06:00:00.000Z' },
      ],
    });
    expect(parseRecurrence(raw)).toEqual({
      freq: 'daily',
      overrides: [
        { instance: '2026-10-05T01:00:00.000Z', start_time: '2026-10-05T06:00:00.000Z', title: null },
      ],
      until: null,
    });
  });
});

describe('occurrencesInWindow — interval / byday / count / exdate', () => {
  const base = at(2026, 9, 25, 9, 0); // 周五 09:00

  it('daily interval=2：隔天才有实例', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 2 };
    // now = 9/28（周一，k=3 奇数）→ 无实例；9/27（周日，k=2）与 9/25（k=0）才是
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 9, 28, 9, 0), WINDOW),
    ).toEqual([at(2026, 9, 27, 9, 0)]);
  });

  it('weekly interval=2：隔一周命中（+1 周那天不算）', () => {
    const rule: RecurrenceRule = { freq: 'weekly', interval: 2 };
    // +1 周 = 10/2（周五）→ 不在序列里
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 10, 2, 9, 0), WINDOW),
    ).toEqual([]);
    // +2 周 = 10/9（周五）→ 命中
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 10, 9, 9, 0), WINDOW),
    ).toEqual([at(2026, 10, 9, 9, 0)]);
  });

  it('weekly byday=[Mon,Wed]：非起始星期几也命中（起始周内早于 base 的忽略）', () => {
    const rule: RecurrenceRule = { freq: 'weekly', byday: [1, 3] };
    // 9/28 是周一（下一周）→ 命中
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 9, 28, 9, 0), WINDOW),
    ).toEqual([at(2026, 9, 28, 9, 0)]);
    // 9/23（上周三）早于 base（9/25）→ 不展开
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 9, 23, 9, 0), WINDOW),
    ).toEqual([]);
  });

  it('daily byday=[weekdays]：周末不命中', () => {
    const rule: RecurrenceRule = { freq: 'daily', byday: [1, 2, 3, 4, 5] };
    // 9/26 是周六 → 仅 9/25（周五）在窗口内
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 9, 26, 9, 0), WINDOW),
    ).toEqual([at(2026, 9, 25, 9, 0)]);
  });

  it('count：达到总次数后不再展开', () => {
    const rule: RecurrenceRule = { freq: 'daily', count: 3 }; // 9/25, 9/26, 9/27
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 9, 27, 9, 0), WINDOW),
    ).toEqual([at(2026, 9, 26, 9, 0), at(2026, 9, 27, 9, 0)]);
    // 9/29 时最后一条（9/27）也超出 24h 补发窗口、且 9/28/9/29 已超过 count → 空
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 9, 29, 9, 0), WINDOW),
    ).toEqual([]);
  });

  it('exdate：跳过指定实例（DETACH 跳过这一次）', () => {
    const rule: RecurrenceRule = { freq: 'daily', exdate: [new Date(at(2026, 9, 27, 9, 0)).toISOString()] };
    expect(
      occurrencesInWindow(new Date(base).toISOString(), rule, at(2026, 9, 27, 9, 0), WINDOW),
    ).toEqual([at(2026, 9, 26, 9, 0)]);
  });
});

describe('occurrencesInWindowDetailed — overrides（DETACH 只改这一次）', () => {
  const base = at(2026, 9, 25, 9, 0);

  it('被改写的实例用新开始时刻参与窗口判定，并带上新标题', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      overrides: [{
        instance: new Date(at(2026, 9, 27, 9, 0)).toISOString(),
        start_time: new Date(at(2026, 9, 27, 15, 0)).toISOString(),
        title: '改到下午'
      }],
    };
    const occ = occurrencesInWindowDetailed(new Date(base).toISOString(), rule, at(2026, 9, 27, 15, 0), {
      windowBeforeMs: 0,
      windowAfterMs: 30 * 60_000,
    });
    expect(occ).toEqual([{
      startMs: at(2026, 9, 27, 15, 0),
      originalStartMs: at(2026, 9, 27, 9, 0),
      modified: true,
      title: '改到下午',
    }]);
  });
});

describe('occurrencesInWindow — tzid（跨夏令时保持墙钟）', () => {
  it('America/New_York：DST 之后仍是本地 09:00（= 13:00Z，而非 14:00Z）', () => {
    // 2026-03-01T14:00:00Z 在纽约为 09:00 EST（UTC-5）；2026-03-08 起进入 EDT（UTC-4）
    const baseIso = '2026-03-01T14:00:00.000Z';
    const rule: RecurrenceRule = { freq: 'daily', tzid: 'America/New_York' };
    const occ = occurrencesInWindow(baseIso, rule, Date.parse('2026-03-09T13:00:00.000Z'), {
      windowBeforeMs: 0,
      windowAfterMs: 30 * 60_000,
    });
    expect(occ).toEqual([Date.parse('2026-03-09T13:00:00.000Z')]);
  });
});

describe('recurrenceLabel — 扩展描述', () => {
  it('默认规则保持旧输出', () => {
    expect(recurrenceLabel({ freq: 'daily' })).toBe('daily');
    expect(recurrenceLabel({ freq: 'weekly' })).toBe('weekly');
  });

  it('interval / byday / count 展开为可读短语', () => {
    expect(recurrenceLabel({ freq: 'daily', interval: 2 })).toBe('every 2 days');
    expect(recurrenceLabel({ freq: 'weekly', byday: [1, 3] })).toBe('weekly on Mon, Wed');
    expect(recurrenceLabel({ freq: 'daily', byday: [1, 2, 3, 4, 5] })).toBe('daily weekdays');
    expect(recurrenceLabel({ freq: 'daily', count: 10 })).toBe('daily ×10');
  });
});