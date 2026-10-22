/**
 * Today 建议引擎（advice）回归。
 *
 * 覆盖三条硬约束：
 *   - 优先级与卡数上限（overdue > plan > overload > sticky > stalled，最多 3 张）；
 *   - 降级不误报（数据源失败时跳过该信号，且不给 clear）；
 *   - 跨卡去重（低优先级卡不重复点名高点名过的行）。
 *
 * 隔离：advice → daily-tasks → storage 的 STATE_DIR 在 import 时由 BOBWORK_HOME 决定，
 * 故先设 env 再动态 import（对齐 rule-signals.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TodayEvent, TodaySnapshot } from './today';
import type { AdviceInput } from './advice';

let home = '';
let buildAdvice: typeof import('./advice').buildAdvice;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-advice-'));
  process.env.BOBWORK_HOME = home;
  ({ buildAdvice } = await import('./advice'));
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** 本地时间 ISO（不带 Z，确保 fmtDay / 排序按本地口径，与 today.ts 的日界一致） */
function ev(
  id: string,
  title: string,
  start: string,
  priority: 'low' | 'normal' | 'high' = 'normal',
  status = 'scheduled',
): TodayEvent {
  return { event_id: id, title, start_time: start, end_time: null, all_day: false, status, priority };
}

function snap(opts: { today?: TodayEvent[]; overdue?: TodayEvent[]; degraded?: string[] }): TodaySnapshot {
  const today = opts.today ?? [];
  const overdue = opts.overdue ?? [];
  return {
    at: '2026-10-03T12:00:00',
    today: { count: today.length, events: today },
    overdue: { count: overdue.length, events: overdue },
    inbox: { pending: 0 },
    chats: { unread: 0 },
    degraded: opts.degraded ?? [],
  };
}

function inputOf(partial: Partial<AdviceInput> & { snapshot: TodaySnapshot }): AdviceInput {
  return { sticky: null, idleProjects: [], now: new Date('2026-10-03T12:00:00'), ...partial };
}

describe('buildAdvice —— 空态与 clear', () => {
  it('全空且未降级 → 单张 clear 卡', () => {
    const cards = buildAdvice(inputOf({ snapshot: snap({}) }));
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('clear');
    expect(cards[0].items).toHaveLength(0);
  });

  it('有积压便签待办 → 不给 clear，给出 sticky 卡', () => {
    const cards = buildAdvice(
      inputOf({
        snapshot: snap({}),
        sticky: {
          totalPending: 6,
          projectCount: 2,
          items: [{ key: 'sticky:1', title: '买菜', time: '', startMs: 0 }],
        },
      }),
    );
    expect(cards.map((c) => c.kind)).toEqual(['sticky']);
    expect(cards[0].count).toBe(6);
  });
});

describe('buildAdvice —— 降级不误报', () => {
  it('overdue 降级 → 不产出 overdue 卡，也不得出 clear', () => {
    const cards = buildAdvice(inputOf({ snapshot: snap({ degraded: ['overdue: boom'] }) }));
    expect(cards).toHaveLength(0);
  });

  it('today 降级且今天无安排 → 不给 clear', () => {
    const cards = buildAdvice(inputOf({ snapshot: snap({ degraded: ['today: boom'] }) }));
    expect(cards).toHaveLength(0);
  });
});

describe('buildAdvice —— 逾期待办', () => {
  it('按开始时间最早排序，items 带 section=overdue 与 source=event', () => {
    const cards = buildAdvice(
      inputOf({
        snapshot: snap({
          overdue: [
            ev('e2', '晚的', '2026-09-28T09:00:00'),
            ev('e1', '早的', '2026-09-20T09:00:00'),
          ],
        }),
      }),
    );
    expect(cards[0].kind).toBe('overdue');
    expect(cards[0].count).toBe(2);
    expect(cards[0].items.map((i) => i.title)).toEqual(['早的', '晚的']);
    expect(cards[0].items[0]).toMatchObject({ section: 'overdue', source: 'event', key: 'e1' });
  });
});

describe('buildAdvice —— 今日过载', () => {
  it('低于阈值不提示', () => {
    const today = [ev('e1', 'A', '2026-10-03T09:00:00'), ev('e2', 'B', '2026-10-03T10:00:00')];
    const cards = buildAdvice(inputOf({ snapshot: snap({ today }) }));
    expect(cards.map((c) => c.kind)).not.toContain('overload');
  });

  it('达阈值 → 按「低优先级优先、同级时间最晚」挑可顺延项', () => {
    const today = [
      ev('a', 'A', '2026-10-03T09:00:00', 'normal'),
      ev('b', 'B', '2026-10-03T08:00:00', 'low'),
      ev('c', 'C', '2026-10-03T07:00:00', 'high'),
      ev('d', 'D', '2026-10-03T11:00:00', 'normal'),
      ev('e', 'E', '2026-10-03T10:00:00', 'low'),
    ];
    const cards = buildAdvice(inputOf({ snapshot: snap({ today }) }));
    const overload = cards.find((c) => c.kind === 'overload');
    expect(overload).toBeDefined();
    // low 里时间最晚的 E → low 里次晚的 B → normal 里时间最晚的 D
    expect(overload!.items.map((i) => i.title)).toEqual(['E', 'B', 'D']);
    expect(overload!.items[0].section).toBe('today');
    // 判据必须写进文案，建议才可解释、可反驳
    expect(overload!.reason).toContain('低优先级');
  });
});

describe('buildAdvice —— 项目停滞', () => {
  it('仅 >= 7 天进候选，按天数降序，items 为可跳转的 project 行', () => {
    const cards = buildAdvice(
      inputOf({
        snapshot: snap({}),
        idleProjects: [
          { id: 'p1', name: '老项目', lastActivityAt: '2026-09-20T12:00:00' }, // 13 天
          { id: 'p2', name: '新项目', lastActivityAt: '2026-09-29T12:00:00' }, // 4 天
          { id: 'p3', name: '未知', lastActivityAt: null },
        ],
      }),
    );
    expect(cards.map((c) => c.kind)).toEqual(['stalled']);
    const card = cards[0];
    expect(card.count).toBe(1);
    expect(card.items).toHaveLength(1);
    expect(card.items[0]).toMatchObject({
      key: 'project:p1',
      source: 'project',
      project: { projectId: 'p1', projectName: '老项目' },
    });
    expect(card.title).toContain('老项目');
  });
});

describe('buildAdvice —— 计划逾期 / 停滞', () => {
  const signal = (over: Partial<import('./advice').AdvicePlanSignal> = {}) => ({
    projectId: 'p1',
    projectName: '甲项目',
    planId: 'plan-1',
    planTitle: '诉讼推进',
    overdueSteps: 0,
    stalledDays: null as number | null,
    ...over,
  });

  it('无逾期且未停滞的信号不产出 plan 卡', () => {
    const cards = buildAdvice(inputOf({ snapshot: snap({}), planSignals: [signal()] }));
    expect(cards.map((c) => c.kind)).not.toContain('plan');
  });

  it('有逾期步骤 → count 为逾期总数，items 为可跳转的 project 行，reason 点名最急项', () => {
    const cards = buildAdvice(
      inputOf({
        snapshot: snap({}),
        planSignals: [
          signal({ overdueSteps: 2, topOverdue: { step: '取证', due: '2026-09-01', daysOverdue: 32 } }),
          signal({ planId: 'plan-2', planTitle: '调解', projectId: 'p2', projectName: '乙项目', overdueSteps: 1, topOverdue: { step: '送达', due: '2026-09-30', daysOverdue: 3 } }),
        ],
      }),
    );
    expect(cards.map((c) => c.kind)).toEqual(['plan']);
    const card = cards[0];
    expect(card.count).toBe(3);
    // 逾期多的计划排前面（items 取前 MAX_ITEMS_PER_CARD 条）
    expect(card.items.map((i) => i.key)).toEqual(['plan:plan-1', 'plan:plan-2']);
    expect(card.items[0]).toMatchObject({
      source: 'project',
      project: { projectId: 'p1', projectName: '甲项目' },
    });
    expect(card.title).toContain('3 个步骤已逾期');
    expect(card.reason).toContain('已逾期 32 天');
  });

  it('仅停滞（无逾期）→ 标题走停滞文案，items 展示停滞天数', () => {
    const cards = buildAdvice(inputOf({ snapshot: snap({}), planSignals: [signal({ stalledDays: 21 })] }));
    expect(cards.map((c) => c.kind)).toEqual(['plan']);
    expect(cards[0].count).toBe(0);
    expect(cards[0].title).toContain('停滞');
    expect(cards[0].reason).toContain('21 天未推进');
    expect(cards[0].items[0].time).toBe('stalled 21d');
  });

  it('优先级：plan 紧随 overdue，排在 overload 之前（仍受 3 张上限约束）', () => {
    const today = [
      ev('o1', '逾期且今天也在', '2026-09-20T09:00:00'),
      ev('t2', 'T2', '2026-10-03T08:00:00'),
      ev('t3', 'T3', '2026-10-03T09:00:00'),
      ev('t4', 'T4', '2026-10-03T10:00:00'),
      ev('t5', 'T5', '2026-10-03T11:00:00'),
    ];
    const cards = buildAdvice(
      inputOf({
        snapshot: snap({ today, overdue: [ev('o1', '逾期且今天也在', '2026-09-20T09:00:00')] }),
        sticky: { totalPending: 9, projectCount: 3, items: [{ key: 'sticky:1', title: '买菜', time: '', startMs: 0 }] },
        planSignals: [signal({ overdueSteps: 1, topOverdue: { step: '取证', due: '2026-09-01', daysOverdue: 32 } })],
      }),
    );
    expect(cards.map((c) => c.kind)).toEqual(['overdue', 'plan', 'overload']);
  });
});

describe('buildAdvice —— 优先级、卡数上限与跨卡去重', () => {
  it('四类信号齐发只取前 3 张，顺序为 overdue > overload > sticky', () => {
    const today = [
      ev('o1', '逾期且今天也在', '2026-09-20T09:00:00'),
      ev('t2', 'T2', '2026-10-03T08:00:00'),
      ev('t3', 'T3', '2026-10-03T09:00:00'),
      ev('t4', 'T4', '2026-10-03T10:00:00'),
      ev('t5', 'T5', '2026-10-03T11:00:00'),
    ];
    const cards = buildAdvice(
      inputOf({
        snapshot: snap({ today, overdue: [ev('o1', '逾期且今天也在', '2026-09-20T09:00:00')] }),
        sticky: {
          totalPending: 9,
          projectCount: 3,
          items: [{ key: 'sticky:1', title: '买菜', time: '', startMs: 0 }],
        },
        idleProjects: [{ id: 'p1', name: '老项目', lastActivityAt: '2026-08-01T12:00:00' }],
      }),
    );
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.kind)).toEqual(['overdue', 'overload', 'sticky']);
  });

  it('overdue 已点名的行不在 overload 里重复出现', () => {
    const today = [
      ev('o1', '逾期且今天也在', '2026-09-20T09:00:00'),
      ev('t2', 'T2', '2026-10-03T08:00:00'),
      ev('t3', 'T3', '2026-10-03T09:00:00'),
      ev('t4', 'T4', '2026-10-03T10:00:00'),
      ev('t5', 'T5', '2026-10-03T11:00:00'),
    ];
    const cards = buildAdvice(
      inputOf({
        snapshot: snap({ today, overdue: [ev('o1', '逾期且今天也在', '2026-09-20T09:00:00')] }),
      }),
    );
    const overload = cards.find((c) => c.kind === 'overload');
    expect(overload!.items.map((i) => i.key)).not.toContain('o1');
  });
});