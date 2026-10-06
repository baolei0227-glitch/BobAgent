import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_PUSH_LIMIT,
  compareUrgency,
  countsTowardDailyLimit,
  disabledNotifyPolicy,
  evaluatePush,
  foldNoticeItems,
  isInQuietWindow,
  localDayKey,
  localMinutes,
  nextQuietWindowEnd,
  parseHm,
  resolveNotifyPolicy,
  type ResolvedNotifyPolicy,
} from '@/lib/core/quiet-hours';
import type { ButlerNoticeItem } from '@/lib/bus';

/**
 * B5 克制策略（免打扰 / 单日上限 / 折叠）—— 纯逻辑不变量。
 *
 * 背景：改造前全应用「有推必推」，没有任何免打扰或负荷策略。本用例锁住三条口径：
 *   1. 用户**自己订的**时间点提醒（kind='reminder'）永不被静默 —— 免打扰窗口与单日上限
 *      **双豁免**、也不计入当日配额（2026-10-06 决定：上限是防「助理刷屏」，不是防「闹钟」）。
 *      静默别人替你定的闹钟是失信行为，这是本模块最容易被后人改错的一条；
 *   2. 策略**缺省即开启**（开箱即克制），只有显式 `enabled:false` 才回滚到「有推必推」；
 *      **例外**：设置读取失败时必须回落 `disabledNotifyPolicy()`（放行）——策略层故障不得吞推送；
 *   3. 折叠只收敛**条数**，且最紧急者必须是「高优先级 > 已逾期 > 更早」。
 *
 * 若日后要放开 reminder 静默或改默认开关，请先改 `lib/core/quiet-hours.ts` 的注释口径，
 * 再来改这个用例。
 */

const POLICY_ON: ResolvedNotifyPolicy = {
  enabled: true,
  quietStartMin: 22 * 60,
  quietEndMin: 8 * 60,
  dailyPushLimit: 6,
};

/** 本地时间构造（时区无关，避免 CI 换时区导致用例飘） */
const at = (h: number, m = 0) => new Date(2026, 8, 25, h, m);

function item(partial: Partial<ButlerNoticeItem> & { title: string }): ButlerNoticeItem {
  return { key: partial.title, time: '', startMs: 0, ...partial };
}

describe('parseHm / resolveNotifyPolicy', () => {
  it('解析 HH:mm，非法值返回 null', () => {
    expect(parseHm('22:00')).toBe(1320);
    expect(parseHm('8:05')).toBe(485);
    expect(parseHm('00:00')).toBe(0);
    for (const bad of ['24:00', '22:60', '22', '', 'abc', undefined, null]) {
      expect(parseHm(bad as string | undefined | null), String(bad)).toBeNull();
    }
  });

  it('缺省项走默认值（22:00 → 08:00，上限 6），且默认**开启**（开箱即克制）', () => {
    const p = resolveNotifyPolicy(undefined);
    expect(p).toEqual({
      enabled: true,
      quietStartMin: 1320,
      quietEndMin: 480,
      dailyPushLimit: DEFAULT_DAILY_PUSH_LIMIT,
    });
  });

  it('只有显式 `enabled:false` 才关闭；空对象仍是开启', () => {
    expect(resolveNotifyPolicy({}).enabled).toBe(true);
    expect(resolveNotifyPolicy({ quietStart: '01:00' }).enabled).toBe(true);
    expect(resolveNotifyPolicy({ enabled: false }).enabled).toBe(false);
    expect(resolveNotifyPolicy({ enabled: true }).enabled).toBe(true);
  });

  it('`disabledNotifyPolicy()` = 恒放行兜底（设置读取失败时用，绝不吞推送）', () => {
    const off = disabledNotifyPolicy();
    expect(off.enabled).toBe(false);
    for (const kind of ['report', 'reminder', 'meeting', 'other'] as const) {
      expect(evaluatePush(off, 0, kind, at(23, 30)).allow, kind).toBe(true);
    }
  });

  it('自定义项覆盖默认；非法 HH:mm / 负数上限回落默认', () => {
    const p = resolveNotifyPolicy({ enabled: true, quietStart: '23:30', quietEnd: '07:00', dailyPushLimit: 3 });
    expect(p).toEqual({ enabled: true, quietStartMin: 1410, quietEndMin: 420, dailyPushLimit: 3 });

    const fallback = resolveNotifyPolicy({ enabled: true, quietStart: '99:99', quietEnd: 'x', dailyPushLimit: -1 });
    expect(fallback.quietStartMin).toBe(1320);
    expect(fallback.quietEndMin).toBe(480);
    expect(fallback.dailyPushLimit).toBe(DEFAULT_DAILY_PUSH_LIMIT);
  });

  it('上限 0 = 不限（合法的显式选择，不能被当成缺省）', () => {
    expect(resolveNotifyPolicy({ dailyPushLimit: 0 }).dailyPushLimit).toBe(0);
  });
});

describe('isInQuietWindow / nextQuietWindowEnd', () => {
  const S = 22 * 60;
  const E = 8 * 60;

  it('跨夜窗口：含起点、不含终点', () => {
    expect(isInQuietWindow(22 * 60, S, E)).toBe(true); // 22:00 起点 → 静默
    expect(isInQuietWindow(23 * 60 + 59, S, E)).toBe(true);
    expect(isInQuietWindow(0, S, E)).toBe(true);
    expect(isInQuietWindow(7 * 60 + 59, S, E)).toBe(true);
    expect(isInQuietWindow(8 * 60, S, E)).toBe(false); // 08:00 终点 → 放行
    expect(isInQuietWindow(12 * 60, S, E)).toBe(false);
    expect(isInQuietWindow(21 * 60 + 59, S, E)).toBe(false);
  });

  it('非跨夜窗口按常规区间判断', () => {
    expect(isInQuietWindow(13 * 60, 12 * 60, 14 * 60)).toBe(true);
    expect(isInQuietWindow(11 * 60, 12 * 60, 14 * 60)).toBe(false);
    expect(isInQuietWindow(15 * 60, 12 * 60, 14 * 60)).toBe(false);
  });

  it('起点 === 终点 ⇒ 零长度窗口 = 不静默（危险的「全天静默」默认被挡住）', () => {
    expect(isInQuietWindow(0, 480, 480)).toBe(false);
    expect(isInQuietWindow(720, 480, 480)).toBe(false);
  });

  it('顺延时刻：深夜落在窗口内 → 次日早上；凌晨落在窗口内 → 当天早上', () => {
    const deepNight = nextQuietWindowEnd(at(23, 30), S, E);
    expect(localDayKey(new Date(deepNight))).toBe('2026-09-26');
    expect(localMinutes(new Date(deepNight))).toBe(E);

    const earlyMorning = nextQuietWindowEnd(at(3, 0), S, E);
    expect(localDayKey(new Date(earlyMorning))).toBe('2026-09-25');
    expect(localMinutes(new Date(earlyMorning))).toBe(E);
  });
});

describe('evaluatePush —— 裁决口径', () => {
  it('显式关闭策略（回滚口径）时一律放行，与改造前行为一致', () => {
    const off: ResolvedNotifyPolicy = { ...POLICY_ON, enabled: false };
    for (const kind of ['report', 'reminder', 'meeting', 'other'] as const) {
      const d = evaluatePush(off, 999, kind, at(23, 30));
      expect(d.allow, kind).toBe(true);
      expect(d.reason).toBe('disabled');
    }
  });

  it('主动汇报在免打扰时段内静默，并给出顺延时刻（不丢内容，由调用方顺延）', () => {
    const d = evaluatePush(POLICY_ON, 0, 'report', at(23, 30));
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('quiet-hours');
    expect(d.resumeAt).toBeDefined();
    expect(localMinutes(new Date(d.resumeAt!))).toBe(POLICY_ON.quietEndMin);
  });

  it('🔴 用户自订的时间点提醒：免打扰窗口内不被静默', () => {
    const d = evaluatePush(POLICY_ON, 0, 'reminder', at(23, 30));
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('ok');
  });

  it('免打扰时段外放行', () => {
    const d = evaluatePush(POLICY_ON, 0, 'report', at(10, 0));
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('ok');
  });

  it('达单日上限后静默「助理主动汇报」，但用户自订提醒双豁免（闹钟必达）', () => {
    // 主动汇报到顶 → 拦
    for (const kind of ['report', 'meeting', 'other'] as const) {
      const d = evaluatePush(POLICY_ON, 6, kind, at(10, 0));
      expect(d.allow, kind).toBe(false);
      expect(d.reason, kind).toBe('daily-limit');
    }
    // 用户自订的日历提醒：配额早已用尽也照推（窗口 + 上限双豁免）
    const cal = evaluatePush(POLICY_ON, 999, 'reminder', at(10, 0));
    expect(cal.allow).toBe(true);
    expect(cal.reason).toBe('ok');
  });

  it('countsTowardDailyLimit：只有 reminder 不计入配额（与上限豁免同源）', () => {
    expect(countsTowardDailyLimit('reminder')).toBe(false);
    for (const kind of ['report', 'meeting', 'other'] as const) {
      expect(countsTowardDailyLimit(kind), kind).toBe(true);
    }
  });

  it('上限 0 = 不限，永不受条数静默', () => {
    const unlimited: ResolvedNotifyPolicy = { ...POLICY_ON, dailyPushLimit: 0 };
    const d = evaluatePush(unlimited, 10_000, 'report', at(10, 0));
    expect(d.allow).toBe(true);
  });
});

describe('foldNoticeItems —— 折叠（只推最紧急的一件 + 计数）', () => {
  const now = at(10, 0).getTime();

  it('条数不超过上限时不折叠（note 为空）', () => {
    const r = foldNoticeItems([item({ title: 'A' })], now, 1);
    expect(r.kept.map((i) => i.title)).toEqual(['A']);
    expect(r.foldedCount).toBe(0);
    expect(r.note).toBe('');
    expect(foldNoticeItems([], now, 1)).toEqual({ kept: [], foldedCount: 0, note: '' });
  });

  it('多件时只留最紧急一件 + 未展示计数', () => {
    const items = [
      item({ title: '晚', startMs: now + 3 * 3600_000 }),
      item({ title: '早', startMs: now + 1 * 3600_000 }),
      item({ title: '高', startMs: now + 5 * 3600_000, priority: 'high' }),
    ];
    const r = foldNoticeItems(items, now, 1);
    expect(r.kept.map((i) => i.title)).toEqual(['高']); // 高优先级胜出
    expect(r.foldedCount).toBe(2);
    expect(r.note).toContain('2');
  });

  it('同优先级时：已逾期 > 未到点；都未逾期则开始时间早者优先', () => {
    const overdue = item({ title: 'overdue', startMs: now - 60_000 });
    const future = item({ title: 'future', startMs: now + 60_000 });
    expect(compareUrgency(overdue, future, now)).toBeLessThan(0);

    const early = item({ title: 'early', startMs: now + 60_000 });
    const late = item({ title: 'late', startMs: now + 120_000 });
    expect(compareUrgency(early, late, now)).toBeLessThan(0);
  });

  it('优先级高于逾期：高优先级未到点仍排在普通逾期之前', () => {
    const p = [
      item({ title: '普通逾期', startMs: now - 3600_000 }),
      item({ title: '高优先', startMs: now + 3600_000, priority: 'high' }),
    ];
    expect(foldNoticeItems(p, now, 1).kept[0]!.title).toBe('高优先');
  });

  it('未知 priority 按 normal 处理（不因脏数据把某条永久置顶/沉底）', () => {
    const a = item({ title: 'unknown', priority: 'weird', startMs: now + 60_000 });
    const b = item({ title: 'normal', priority: 'normal', startMs: now + 120_000 });
    expect(compareUrgency(a, b, now)).toBeLessThan(0);
  });
});
