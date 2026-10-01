/**
 * 规则从属日志（rule-logs）回归：JSONL 追加 / 读取 / 坏行跳过 / 截断上限 / 反查归因。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的模块级常量在 import 时由环境变量确定，
 * 故先设 env 再动态 import（对齐 rules.test.ts / preferences.guard.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { appendFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let logs: typeof import('./rule-logs');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-rule-logs-'));
  process.env.BOBWORK_HOME = home;
  logs = await import('./rule-logs');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

const RID = 'r-20260928-aaaa';
const hitsFile = (key = RID) => join(home, 'butler', '.rules', '.logs', 'hits', `${key}.jsonl`);

describe('appendRuleLog / readRuleLog', () => {
  it('追加一行并读回，自动补 at 时间戳', async () => {
    await logs.appendRuleLog('hits', RID, { scene: 'todo', rule_version: 1 });
    const got = await logs.readRuleLog<{ at: string; scene: string; rule_version: number }>('hits', RID);
    expect(got).toHaveLength(1);
    expect(got[0].scene).toBe('todo');
    expect(got[0].rule_version).toBe(1);
    expect(typeof got[0].at).toBe('string');
    expect(got[0].at.length).toBeGreaterThan(0);
  });

  it('保留调用方显式给出的 at', async () => {
    await logs.appendRuleLog('hits', 'r-20260928-keep', { at: '2026-01-01T00:00:00.000Z', scene: 's' });
    const got = await logs.readRuleLog<{ at: string }>('hits', 'r-20260928-keep');
    expect(got[0].at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('limit 返回最近 N 条（仍按写入顺序升序）', async () => {
    const key = 'r-20260928-lim';
    for (let i = 1; i <= 4; i++) await logs.appendRuleLog('hits', key, { i });
    const got = await logs.readRuleLog<{ i: number }>('hits', key, 2);
    expect(got.map((e) => e.i)).toEqual([3, 4]);
  });

  it('坏行跳过、不阻断读取', async () => {
    const key = 'r-20260928-bad';
    await logs.appendRuleLog('hits', key, { i: 1 });
    await appendFile(hitsFile(key), '{ not json\n\n', 'utf-8');
    await logs.appendRuleLog('hits', key, { i: 2 });
    const got = await logs.readRuleLog<{ i: number }>('hits', key);
    expect(got.map((e) => e.i)).toEqual([1, 2]);
  });

  it('不存在 / 非法 key → 空数组，不抛错', async () => {
    expect(await logs.readRuleLog('hits', 'r-20260928-none')).toEqual([]);
    expect(await logs.readRuleLog('hits', '')).toEqual([]);
  });
});

describe('key 白名单清洗（防目录穿越）', () => {
  it('非法字符被清洗，落点仍在 .logs 内', async () => {
    await logs.appendRuleLog('hits', '../evil', { i: 1 });
    // '../evil' → '___evil'（点点斜杠均替换为 _）
    expect(existsSync(hitsFile('___evil'))).toBe(true);
    // 未逃逸到父目录
    expect(existsSync(join(home, 'butler', '.rules', 'evil.jsonl'))).toBe(false);
  });

  it('空 key 追加抛错', async () => {
    await expect(logs.appendRuleLog('hits', '', { i: 1 })).rejects.toThrow();
  });
});

describe('截断上限：每片保留最近 200 行', () => {
  it('写入超过 200 行后只留最近 200 行', async () => {
    const key = 'r-20260928-cap';
    for (let i = 1; i <= 205; i++) await logs.appendRuleLog('hits', key, { i });
    const got = await logs.readRuleLog<{ i: number }>('hits', key);
    expect(got).toHaveLength(200);
    expect(got[0].i).toBe(6);
    expect(got[199].i).toBe(205);
    const raw = await readFile(hitsFile(key), 'utf-8');
    expect(raw.trimEnd().split('\n')).toHaveLength(200);
  });
});

describe('listRuleLogKeys', () => {
  it('列出该类型下全部分片键（升序）', async () => {
    const keys = await logs.listRuleLogKeys('hits');
    expect(keys).toContain(RID);
    expect(keys).toEqual([...keys].sort());
    // 不含扩展名
    expect(keys.every((k) => !k.endsWith('.jsonl'))).toBe(true);
  });

  it('类型目录不存在 → 空数组', async () => {
    expect(await logs.listRuleLogKeys('rule_violated')).toEqual([]);
  });
});

describe('readHitWindow：窗口内命中与否定', () => {
  it('否定条目仅计入窗口起点（最早命中）之后的', async () => {
    const key = 'r-20260928-win';
    const T = (n: number) => `2026-09-28T00:00:0${n}.000Z`;
    for (let i = 1; i <= 5; i++) await logs.appendRuleLog('hits', key, { at: T(i), scene: 'todo', rule_version: 1 });
    await logs.appendRuleLog('user_dismissed', key, { at: T(1), rule_version: 1, source: 'x' }); // 窗口前 → 排除
    await logs.appendRuleLog('user_dismissed', key, { at: T(3), rule_version: 1, source: 'x' });
    await logs.appendRuleLog('user_dismissed', key, { at: T(6), rule_version: 1, source: 'x' });

    const { hits, dismissed } = await logs.readHitWindow(key, 3);
    expect(hits.map((h) => h.at)).toEqual([T(3), T(4), T(5)]);
    expect(dismissed.map((d) => d.at)).toEqual([T(3), T(6)]);
  });

  it('无命中 → 空窗口', async () => {
    const { hits, dismissed } = await logs.readHitWindow('r-20260928-empty', 5);
    expect(hits).toEqual([]);
    expect(dismissed).toEqual([]);
  });
});

describe('findRuleByProducedRef：反查产出归因', () => {
  it('按 producedRef 命中对应规则，取最近一条', async () => {
    await logs.appendRuleLog('hits', 'r-20260928-prod1', { at: '2026-09-28T01:00:00.000Z', scene: 'todo', rule_version: 1, producedRef: 'evt-1' });
    await logs.appendRuleLog('hits', 'r-20260928-prod2', { at: '2026-09-28T02:00:00.000Z', scene: 'todo', rule_version: 1, producedRef: 'evt-1' });
    expect(await logs.findRuleByProducedRef('evt-1')).toBe('r-20260928-prod2');
  });

  it('无匹配 / 空 ref → null', async () => {
    expect(await logs.findRuleByProducedRef('evt-none')).toBeNull();
    expect(await logs.findRuleByProducedRef('')).toBeNull();
  });
});

describe('HitEntry.occurrence：定时候选实例时刻读写', () => {
  it('写入 occurrence 后可原样读回（幂等去重的数据面）', async () => {
    await logs.appendRuleLog('hits', 'r-20260928-occ', { at: '2026-09-28T01:00:00.000Z', scene: 'timer', rule_version: 1, occurrence: 1750000000000 });
    const got = await logs.readRuleLog<{ scene: string; occurrence?: number }>('hits', 'r-20260928-occ');
    expect(got[0].occurrence).toBe(1750000000000);
  });

  it('语面命中不带 occurrence（缺省）', async () => {
    await logs.appendRuleLog('hits', 'r-20260928-plain', { at: '2026-09-28T01:00:00.000Z', scene: 'todo', rule_version: 1 });
    const got = await logs.readRuleLog<{ occurrence?: number }>('hits', 'r-20260928-plain');
    expect(got[0].occurrence).toBeUndefined();
  });
});

describe('NegativeSampleEntry.class：两类负样本 + 旧记录兼容', () => {
  it('写入 class 后原样读回', async () => {
    await logs.appendRuleLog('negative-sample', 'note', { at: '2026-09-28T01:00:00.000Z', pattern: 'note', action: 'blocked', class: 'not_a_habit' });
    const got = await logs.readRuleLog<{ class?: string }>('negative-sample', 'note');
    expect(got[0].class).toBe('not_a_habit');
  });

  it('Phase 1 旧记录无 class 字段（不迁移，读侧兼容）', async () => {
    await logs.appendRuleLog('negative-sample', 'rule', { at: '2026-09-28T01:00:00.000Z', pattern: 'r-old', action: 'blocked' });
    const got = await logs.readRuleLog<{ class?: string }>('negative-sample', 'rule');
    expect(got[0].class).toBeUndefined();
  });
});