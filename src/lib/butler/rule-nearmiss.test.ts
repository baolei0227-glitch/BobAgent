/**
 * rule-nearmiss 回归（2026-10-05 学习机制改造后）：
 *   弱触发映射 / 「一次即记忆」落 draft / 再次命中即印证（不自动转正）/ 负样本压制 / 主动遗忘 sweep。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的模块级常量在 import 时由环境变量确定，
 * 故先设 env 再动态 import（对齐 rule-logs.test.ts）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let nearmiss: typeof import('./rule-nearmiss');
let signals: typeof import('./rule-signals');
let rules: typeof import('./rules');
let forget: typeof import('./rule-forget');
let shared: typeof import('./rules-shared');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-rule-nearmiss-'));
  process.env.BOBWORK_HOME = home;
  nearmiss = await import('./rule-nearmiss');
  signals = await import('./rule-signals');
  rules = await import('./rules');
  forget = await import('./rule-forget');
  shared = await import('./rules-shared');
});

beforeEach(() => {
  // 清空 butler 根（规则 + 计数 + 日志），每个用例从零开始
  rmSync(join(home, 'butler'), { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('weakSignalObjectTypes / weakSignalMatches', () => {
  it('把同域动词映射到对象类型', () => {
    expect(nearmiss.weakSignalObjectTypes('记一下明天的事')).toContain('note');
    expect(nearmiss.weakSignalObjectTypes('开个会吧')).toContain('meeting');
    expect(nearmiss.weakSignalObjectTypes('提醒我买牛奶')).toContain('todo');
  });

  it('一句话可命中多个对象类型，去重', () => {
    const got = nearmiss.weakSignalObjectTypes('把这句话记一下，顺便安排个会议');
    expect(got).toContain('note');
    expect(got).toContain('schedule');
    expect(got).toContain('meeting');
    expect(new Set(got).size).toBe(got.length);
  });

  it('无弱触发词 → 空数组', () => {
    expect(nearmiss.weakSignalObjectTypes('今天天气不错')).toEqual([]);
  });

  it('取出命中的触发词（用作 draft 的语面触发词）', () => {
    expect(nearmiss.weakSignalMatches('提醒我买牛奶')).toEqual([{ type: 'todo', keyword: '提醒我' }]);
  });
});

describe('rememberFromText（一次即记忆）', () => {
  it('首次命中即落一条 draft（静默、带确定性动作与触发词）', async () => {
    const out = await nearmiss.rememberFromText('提醒我买牛奶');
    expect(out).toMatchObject({ action: 'created', objectType: 'todo' });
    const all = await rules.listRules();
    expect(all).toHaveLength(1);
    const r = all[0];
    expect(r.status).toBe('draft');
    expect(r.trigger.keywords).toContain('提醒我');
    expect(r.steps[0]).toMatchObject({ kind: 'deterministic', action: 'create_todo' });
    expect(shared.ruleObjectType(r)).toBe('todo');
  });

  it('再次命中同一 draft → 印证（不新增规则、不自动转正）', async () => {
    await nearmiss.rememberFromText('提醒我买牛奶');
    const out = await nearmiss.rememberFromText('提醒我买面包');
    expect(out).toMatchObject({ action: 'reinforced', objectType: 'todo', seen: 2 });
    const all = await rules.listRules();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('draft'); // 印证不等于转正
  });

  it('已有覆盖 todo 的 active 规则 → 不再学（null）', async () => {
    await rules.createRule({
      name: 'Live todo',
      intentRaw: '提醒我就建待办',
      steps: [{ kind: 'deterministic', text: '建待办', action: 'create_todo' }],
      trigger: { keywords: ['提醒我'] },
    });
    expect(await nearmiss.rememberFromText('提醒我买牛奶')).toBeNull();
    const all = await rules.listRules();
    expect(all.filter((r) => r.status === 'draft')).toHaveLength(0);
  });

  it('not_a_habit 被拉黑 → 不再学（用户说过这不是习惯）', async () => {
    await signals.recordNegativeSample('todo', 'todo', 'blocked', 'not_a_habit');
    expect(await nearmiss.rememberFromText('提醒我买牛奶')).toBeNull();
    expect(await rules.listRules()).toHaveLength(0);
  });

  it('无弱信号 → null（静默）', async () => {
    expect(await nearmiss.rememberFromText('今天天气不错')).toBeNull();
  });
});

describe('两类负样本互不误伤', () => {
  it('signal_mismatch 拉黑不压制 not_a_habit，反之亦然', async () => {
    await signals.recordNegativeSample('note', 'note', 'blocked', 'signal_mismatch');
    expect(await nearmiss.isBlocked('note', 'signal_mismatch')).toBe(true);
    expect(await nearmiss.isBlocked('note', 'not_a_habit')).toBe(false);

    await signals.recordNegativeSample('note', 'note', 'blocked', 'not_a_habit');
    expect(await nearmiss.isBlocked('note', 'signal_mismatch')).toBe(true);
    expect(await nearmiss.isBlocked('note', 'not_a_habit')).toBe(true);
  });

  it('解封某一类（追加 unblocked）不影响另一类', async () => {
    await signals.recordNegativeSample('todo', 'todo', 'blocked', 'signal_mismatch');
    await signals.recordNegativeSample('todo', 'todo', 'blocked', 'not_a_habit');
    await signals.recordNegativeSample('todo', 'todo', 'unblocked', 'signal_mismatch');
    expect(await nearmiss.isBlocked('todo', 'signal_mismatch')).toBe(false);
    expect(await nearmiss.isBlocked('todo', 'not_a_habit')).toBe(true);
  });
});

/** 直接落一个规则文件（用于构造「很久以前创建」的规则，绕过 createdAt 不可改的限制） */
function seedRuleFile(id: string, status: string, createdAt: string): void {
  const root = rules.rulesRoot();
  mkdirSync(root, { recursive: true });
  const md = [
    '---',
    `id: "${id}"`,
    'name: "Seeded"',
    `status: "${status}"`,
    `created_at: "${createdAt}"`,
    'version: 1',
    'trigger_keywords: []',
    '---',
    '',
    '## Intent',
    '',
    '记一下',
    '',
    '## Steps',
    '',
    '- [deterministic:create_todo] 建待办',
    '',
  ].join('\n');
  writeFileSync(join(root, `${id}.md`), md, 'utf-8');
}

describe('主动遗忘', () => {
  it('isDraftExpired / isRuleStale：旧 → 真，新 → 假', () => {
    const old = '2020-01-01 10:00';
    const fresh = new Date().toISOString().slice(0, 16).replace('T', ' ');
    expect(shared.isDraftExpired(old, undefined)).toBe(true);
    expect(shared.isDraftExpired(fresh, undefined)).toBe(false);
    expect(shared.isRuleStale(old, undefined)).toBe(true);
    expect(shared.isRuleStale(fresh, undefined)).toBe(false);
  });

  it('sweepForgottenDrafts：清除超期 draft，保留新鲜 draft 与 active', async () => {
    const oldDraft = 'r-20200101-aaaa';
    const freshId = (await rules.createRule({
      name: 'Fresh draft',
      intentRaw: '提醒我',
      steps: [{ kind: 'deterministic', text: '建待办', action: 'create_todo' }],
      status: 'draft',
    })).id;
    seedRuleFile(oldDraft, 'draft', '2020-01-01 10:00');
    seedRuleFile('r-20200101-bbbb', 'active', '2020-01-01 10:00');

    const forgotten = await forget.sweepForgottenDrafts(new Date('2026-01-01T00:00:00Z'));
    expect(forgotten.map((f) => f.id)).toEqual([oldDraft]);
    const ids = (await rules.listRules()).map((r) => r.id);
    expect(ids).not.toContain(oldDraft); // 超期 draft 被清除
    expect(ids).toContain(freshId); // 新鲜 draft 保留
    expect(ids).toContain('r-20200101-bbbb'); // active 绝不静默删
  });
});
