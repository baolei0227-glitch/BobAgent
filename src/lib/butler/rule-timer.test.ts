/**
 * 定时候选（rule-timer）回归：到期判定 + 幂等去重。
 *
 * 隔离：BOBWORK_HOME 指向临时目录（读 hits 需 storage 的模块级常量在 import 时确定），
 * 故先设 env 再动态 import（对齐 rule-signals.test.ts）。
 * 时区：规则显式带 tzid='UTC'，避免测试受运行机本地时区影响。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RuleRecord } from './rules-shared';

let home = '';
let timer: typeof import('./rule-timer');
let signals: typeof import('./rule-signals');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-rule-timer-'));
  process.env.BOBWORK_HOME = home;
  timer = await import('./rule-timer');
  signals = await import('./rule-signals');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

function mkRule(partial: Partial<RuleRecord> & { id: string }): RuleRecord {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    kind: partial.kind ?? 'rule',
    intentRaw: partial.intentRaw ?? '',
    trigger: partial.trigger ?? { keywords: [] },
    steps: partial.steps ?? [{ kind: 'deterministic', text: 'x', action: 'create_todo' }],
    commitment: partial.commitment ?? '必做到',
    scope: partial.scope ?? 'global',
    ...(partial.scopeTarget ? { scopeTarget: partial.scopeTarget } : {}),
    priority: partial.priority ?? 50,
    status: partial.status ?? 'active',
    version: partial.version ?? 1,
    createdAt: partial.createdAt ?? '2026-09-28T09:00:00.000Z',
  };
}

describe('dueTimerRules —— 到期判定', () => {
  it('weekly(Fri) 规则：窗口内命中金曜日实例 → 产候选（实例时刻正确）', async () => {
    const rule = mkRule({
      id: 'r-20260928-tim1',
      createdAt: '2026-09-28T09:00:00.000Z', // 周一
      trigger: { keywords: [], time: { freq: 'weekly', byday: [5], tzid: 'UTC' } },
    });
    const now = new Date('2026-10-02T09:00:00.000Z'); // 周五
    const due = await timer.dueTimerRules([rule], now);
    expect(due).toHaveLength(1);
    expect(due[0].ruleId).toBe(rule.id);
    expect(due[0].occurrence).toBe(Date.parse('2026-10-02T09:00:00.000Z'));
  });

  it('窗口内无实例 → 不产候选', async () => {
    const rule = mkRule({
      id: 'r-20260928-tim2',
      createdAt: '2026-09-28T09:00:00.000Z',
      trigger: { keywords: [], time: { freq: 'weekly', byday: [5], tzid: 'UTC' } },
    });
    const now = new Date('2026-09-30T09:00:00.000Z'); // 周三
    expect(await timer.dueTimerRules([rule], now)).toEqual([]);
  });

  it('无时间组 / 非 active / 流程(kind=flow) 均不参与', async () => {
    const noTime = mkRule({ id: 'r-20260928-tim3', trigger: { keywords: ['记一下'] } });
    const paused = mkRule({
      id: 'r-20260928-tim4',
      status: 'paused',
      trigger: { keywords: [], time: { freq: 'daily', tzid: 'UTC' } },
    });
    const flow = mkRule({
      id: 'r-20260928-tim5',
      kind: 'flow',
      trigger: { keywords: [], time: { freq: 'daily', tzid: 'UTC' } },
    });
    const now = new Date('2026-09-28T09:30:00.000Z');
    expect(await timer.dueTimerRules([noTime, paused, flow], now)).toEqual([]);
  });
});

describe('dueTimerRules —— 幂等去重', () => {
  const RID = 'r-20260928-tim6';
  const rule = mkRule({
    id: RID,
    createdAt: '2026-09-28T09:00:00.000Z', // 周一
    trigger: { keywords: [], time: { freq: 'weekly', byday: [5], tzid: 'UTC' } },
  });
  const occMs = Date.parse('2026-10-02T09:00:00.000Z');

  it('首次到期：产候选', async () => {
    const now = new Date('2026-10-02T09:05:00.000Z');
    const due = await timer.dueTimerRules([rule], now);
    expect(due).toHaveLength(1);
    expect(due[0].occurrence).toBe(occMs);
  });

  it('同一实例已执行（hits 带同 occurrence）→ 不再产候选', async () => {
    await signals.recordHit(RID, 1, 'timer', undefined, occMs);
    const now = new Date('2026-10-02T09:10:00.000Z');
    expect(await timer.dueTimerRules([rule], now)).toEqual([]);
  });

  it('更晚实例已执行 → 更早的漏跑实例也被覆盖（不补跑历史）', async () => {
    const rid2 = 'r-20260928-tim7';
    const daily = mkRule({
      id: rid2,
      createdAt: '2026-09-28T09:00:00.000Z',
      trigger: { keywords: [], time: { freq: 'daily', tzid: 'UTC' } },
    });
    // 今天已跑过（occurrence = 今天 09:00）
    const todayMs = Date.parse('2026-09-28T09:00:00.000Z');
    await signals.recordHit(rid2, 1, 'timer', undefined, todayMs);
    // now 在窗口内还能看到昨天 09:00 的实例，但已被更晚的命中覆盖 → 不补跑
    const now = new Date('2026-09-28T09:30:00.000Z');
    expect(await timer.dueTimerRules([daily], now)).toEqual([]);
  });
});

/**
 * 漏触发告知（2026-10-02 评审 §2.2-7）：定时心跳寄生渲染进程 + 只回看 24h，
 * 应用关得久一点，期间到期的实例就永久不补跑且无人知道。本组锁住：
 *  ① 补偿窗口**之外**且有实例、无命中 → 报一条（取最新的漏掉实例）；
 *  ② **每条规则只报一次**（否则 60s 心跳会反复刷同一句）；
 *  ③ 已被命中覆盖的实例不算漏触发。
 */
describe('missedTimerRules —— 漏触发告知', () => {
  const RID = 'r-20260928-miss1';
  const rule = mkRule({
    id: RID,
    name: '每天九点提醒',
    createdAt: '2026-09-20T09:00:00.000Z',
    trigger: { keywords: [], time: { freq: 'daily', tzid: 'UTC' } },
  });

  it('应用关了 5 天：报出最新漏掉的实例，且只取一条', async () => {
    const now = new Date('2026-09-28T12:00:00.000Z'); // 最后一次实例 = 09-28 09:00，但已过 24h 窗口（12:00-24h=09-27 12:00）
    const missed = await timer.missedTimerRules([rule], now, timer.TIMER_LOOKBACK_MS, timer.MISSED_SCAN_MS, 3);
    expect(missed).toHaveLength(1);
    expect(missed[0].ruleId).toBe(RID);
    expect(missed[0].ruleName).toBe('每天九点提醒');
    // 漏掉的是窗口外的最新实例（09-27 09:00），不是更早的
    expect(missed[0].occurrence).toBe(Date.parse('2026-09-27T09:00:00.000Z'));
  });

  it('同一条规则第二次调用不再重复告知（标记已落盘）', async () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    expect(await timer.missedTimerRules([rule], now, timer.TIMER_LOOKBACK_MS, timer.MISSED_SCAN_MS, 3)).toEqual([]);
  });

  it('唯一待办实例在补偿窗口内（还能补跑）→ 不算漏触发', async () => {
    const rid2 = 'r-20260928-miss2';
    // base 取 09-27 12:00（而非更早）：这样唯一待办实例就是 09-27 12:00，
    // 落在 [now-24h, now] = [09-27 10:00, 09-28 10:00] 内 → 应由 dueTimerRules 补跑，不进 missed。
    // ⚠️ 语义提醒：若 base 更早（如 09-20），则更早的未执行实例**本就超出补偿窗口**，仍会被如实报为
    //    漏触发——这不是 bug：那些实例确实永久错过了。
    const fresh = mkRule({
      id: rid2,
      name: '刚刚到期',
      createdAt: '2026-09-27T12:00:00.000Z',
      trigger: { keywords: [], time: { freq: 'daily', tzid: 'UTC' } },
    });
    const now = new Date('2026-09-28T10:00:00.000Z');
    const missed = await timer.missedTimerRules([fresh], now, timer.TIMER_LOOKBACK_MS, timer.MISSED_SCAN_MS, 3);
    expect(missed.filter((m) => m.ruleId === rid2)).toEqual([]);
  });
});