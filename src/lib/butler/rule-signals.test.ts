/**
 * 规则信号（rule-signals）回归：六类信号唯一写口 + 修订评估「窗口清零」语义。
 *
 * 核心不变量（v6 §7）：`user_dismissed` **只写一条**，被「拉黑」（near-miss 不再询问）与
 * 「修订阈值」（最近窗口否定率）两处共读 —— 杜绝两处各写一套导致口径漂移。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的模块级常量在 import 时由环境变量确定，
 * 故先设 env 再动态 import（对齐 rule-logs.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let signals: typeof import('./rule-signals');
let logs: typeof import('./rule-logs');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-rule-signals-'));
  process.env.BOBWORK_HOME = home;
  signals = await import('./rule-signals');
  logs = await import('./rule-logs');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

const RID = 'r-20260928-sig1';

describe('recordUserDismissed —— 一份记录、两处共读', () => {
  it('每次否定只写一条 user_dismissed', async () => {
    await signals.recordUserDismissed(RID, 1, 'rule_dismiss');
    const dismissed = await logs.readRuleLog('user_dismissed', RID);
    expect(dismissed).toHaveLength(1);
  });

  it('带对象类型 → 否决即拉黑（立即落 signal_mismatch 负样本，不误伤 not_a_habit）', async () => {
    const ot = 'sig-ot-1';
    await expect(signals.isPatternBlocked(ot, ot, 'signal_mismatch')).resolves.toBe(false);
    await signals.recordUserDismissed(RID, 1, 'rule_dismiss', ot);
    await expect(signals.isPatternBlocked(ot, ot, 'signal_mismatch')).resolves.toBe(true);
    const samples = await signals.listNegativeSamples(ot, 'signal_mismatch');
    expect(samples.filter((s) => s.pattern === ot && s.action === 'blocked')).toHaveLength(1);
    await expect(signals.isPatternBlocked(ot, ot, 'not_a_habit')).resolves.toBe(false);
  });

  it('不带对象类型 → 只记 user_dismissed，不落负样本', async () => {
    const ot = 'sig-ot-2';
    await signals.recordUserDismissed('r-20260928-sig-x', 1, 'rule_dismiss');
    await expect(signals.isPatternBlocked(ot, ot, 'signal_mismatch')).resolves.toBe(false);
  });
});

describe('evaluateRuleRevision —— 窗口判据与版本清零', () => {
  const rid = 'r-20260928-rev1';

  it('样本不足 K → active=false（机制未启用）', async () => {
    await signals.recordHit(rid, 1, 'todo');
    const rev = await signals.evaluateRuleRevision(rid);
    expect(rev.active).toBe(false);
  });

  it('窗口内 5 次命中 + 3 次否定（0.6 > 0.4）→ shouldPropose=true', async () => {
    // 已有 1 次命中，补齐到 5
    for (let i = 0; i < 4; i++) await signals.recordHit(rid, 1, 'todo');
    for (let i = 0; i < 3; i++) await signals.recordUserDismissed(rid, 1, 'rule_dismiss');
    const rev = await signals.evaluateRuleRevision(rid);
    expect(rev.active).toBe(true);
    expect(rev.ratio).toBeCloseTo(0.6, 5);
    expect(rev.shouldPropose).toBe(true);
  });

  it('阈值边界：恰好 0.4 不提议（严格大于才提议）', async () => {
    const rid2 = 'r-20260928-rev2';
    for (let i = 0; i < 5; i++) await signals.recordHit(rid2, 1, 'todo');
    await signals.recordUserDismissed(rid2, 1, 'rule_dismiss');
    await signals.recordUserDismissed(rid2, 1, 'rule_dismiss');
    const rev = await signals.evaluateRuleRevision(rid2);
    expect(rev.ratio).toBeCloseTo(0.4, 5);
    expect(rev.shouldPropose).toBe(false);
  });

  it('currentVersion 传新版本 → 旧版本样本不计入（窗口清零）', async () => {
    const rev = await signals.evaluateRuleRevision(rid, 2);
    expect(rev.active).toBe(false);
    expect(rev.ratio).toBe(0);
  });
});

describe('recordConflictResolution —— 冲突消解落盘与读回（#4 后半环）', () => {
  it('按两条规则 id 有序对分片；读回能取到 chosen / inputFeature', async () => {
    const a = 'r-20260928-ca';
    const b = 'r-20260928-cb';
    await signals.recordConflictResolution(a, b, '安排一下', b, [1, 1]);
    const key = [a, b].sort().join('__');
    const rows = await logs.readRuleLog<{
      inputFeature: string;
      chosen: string;
      versions: [number, number];
    }>('conflict-resolution', key);
    expect(rows).toHaveLength(1);
    expect(rows[0].chosen).toBe(b);
    expect(rows[0].inputFeature).toBe('安排一下');
    expect(rows[0].versions).toEqual([1, 1]);
  });

  it('交换 a/b 顺序落到同一分片（排序稳定）', async () => {
    const a = 'r-20260928-db';
    const b = 'r-20260928-da';
    await signals.recordConflictResolution(a, b, 'x', a, [2, 1]);
    const key = [a, b].sort().join('__');
    const rows = await logs.readRuleLog<{ chosen: string }>('conflict-resolution', key);
    expect(rows).toHaveLength(1);
    expect(rows[0].chosen).toBe(a);
  });
});

describe('recordHit / recordOutputEdited —— producedRef 归因', () => {
  it('hits 带 producedRef 时可由 findRuleByProducedRef 反查', async () => {
    const rid = 'r-20260928-att1';
    await signals.recordHit(rid, 1, 'todo', 'evt-xyz');
    await expect(signals.findRuleByProducedRef('evt-xyz')).resolves.toBe(rid);
  });

  it('recordOutputEdited 落一条带 diff 的记录', async () => {
    const rid = 'r-20260928-att2';
    await signals.recordOutputEdited(rid, 1, 'evt-1', 'a', 'b');
    const rows = await logs.readRuleLog<{ diff: string }>('output_edited', rid);
    expect(rows).toHaveLength(1);
    expect(rows[0].diff).toBe('a → b');
  });
});