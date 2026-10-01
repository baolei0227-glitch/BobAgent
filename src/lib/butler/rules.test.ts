/**
 * 规则（Rules）回归：三值承诺派生 + 存储 CRUD/乐观锁 + ⑧ 否定式路由。
 *
 * Phase 0 只做「存放与可见」（v6 §10.2）：这里验证的正是那几件事——
 *   1) commitment 三值由 steps 构成**可解释地**派生（全确定性 / 附属判断 / 主体判断）；
 *   2) 一条规则一个文件、读写往返不丢字段、version 乐观锁能挡住并发覆盖；
 *   3) 否定式表达**不落偏好层**，改由 createRuleFromNegation 落成规则（偏好给偏好，规则给承诺）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的模块级常量在 import 时由环境变量确定，
 * 所以必须先设 env 再动态 import（对齐 preferences.guard.test.ts 的做法）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deriveCommitment, deriveKind, type RuleStep } from './rules-shared';
import { detectNegation } from '../core/preferences-shared';

let home = '';
let rules: typeof import('./rules');
let prefs: typeof import('../core/preferences');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-rules-'));
  process.env.BOBWORK_HOME = home;
  rules = await import('./rules');
  prefs = await import('../core/preferences');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('deriveCommitment / deriveKind 三值映射', () => {
  it('全确定性步 → 必做到 / rule', () => {
    const steps: RuleStep[] = [{ kind: 'deterministic', text: '不要用感叹号' }];
    expect(deriveCommitment(steps)).toBe('必做到');
    expect(deriveKind(steps)).toBe('rule');
  });

  it('确定性为主 + 附属判断步 → 基本做到 / rule', () => {
    const steps: RuleStep[] = [
      { kind: 'deterministic', text: '先给结论' },
      { kind: 'judgment', text: '酌情补充背景', annex: true },
    ];
    expect(deriveCommitment(steps)).toBe('基本做到');
    expect(deriveKind(steps)).toBe('rule');
  });

  it('含主体判断步 → 会启动并尽力 / flow', () => {
    const steps: RuleStep[] = [
      { kind: 'deterministic', text: '读完当天邮件' },
      { kind: 'judgment', text: '判断哪些需要回复' },
    ];
    expect(deriveCommitment(steps)).toBe('会启动并尽力');
    expect(deriveKind(steps)).toBe('flow');
  });
});

describe('detectNegation 判据落在「能否确定执行」而非语气强弱', () => {
  it('显式否定标记命中', () => {
    for (const s of ['回复里不要用感叹号', '禁止使用 emoji', '不得外传附件', '别用 emoji 回复']) {
      expect(detectNegation(s), s).toBe(true);
    }
  });

  it('倾向表达与常见非否定词不误判', () => {
    for (const s of ['我不太喜欢很长的回复', '喜欢简洁的输出', '特别关注这个项目', '别人的意见可以参考', '识别图片里的文字', '']) {
      expect(detectNegation(s), s).toBe(false);
    }
  });
});

describe('规则存储 CRUD 与乐观锁', () => {
  let id = '';

  it('createRule 生成 id/version 并落盘', async () => {
    const rule = await rules.createRule({
      name: 'No coriander',
      intentRaw: '不要放香菜',
      steps: [{ kind: 'deterministic', text: '不要放香菜' }],
      trigger: { keywords: ['coriander', '香菜'] },
    });
    id = rule.id;
    expect(rule.id).toMatch(/^r-\d{8}-[0-9a-f]{4}$/);
    expect(rule.version).toBe(1);
    expect(rule.status).toBe('active');
    expect(rule.commitment).toBe('必做到');
    expect(rule.kind).toBe('rule');
    expect(existsSync(join(home, 'butler', '.rules', `${rule.id}.md`))).toBe(true);
  });

  it('读回往返不丢字段（steps / intent / keywords）', async () => {
    const got = await rules.readRule(id);
    expect(got).not.toBeNull();
    expect(got?.name).toBe('No coriander');
    expect(got?.intentRaw).toBe('不要放香菜');
    expect(got?.steps).toEqual([{ kind: 'deterministic', text: '不要放香菜' }]);
    expect(got?.trigger.keywords).toEqual(['coriander', '香菜']);

    const list = await rules.listRules();
    expect(list.map((r) => r.id)).toContain(id);
  });

  it('expectedVersion 不符 → conflict，不改盘', async () => {
    const res = await rules.updateRule(id, { name: 'Changed' }, 999);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflict).toBe(true);
    expect((await rules.readRule(id))?.name).toBe('No coriander');
  });

  it('改 steps 后 commitment/kind 重派生、version 自增', async () => {
    const res = await rules.updateRule(
      id,
      { steps: [{ kind: 'deterministic', text: '先给结论' }, { kind: 'judgment', text: '判断是否展开' }] },
      1,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rule.version).toBe(2);
      expect(res.rule.commitment).toBe('会启动并尽力');
      expect(res.rule.kind).toBe('flow');
    }
  });

  it('setRuleStatus 持久化 pause', async () => {
    const res = await rules.setRuleStatus(id, 'paused');
    expect(res.ok).toBe(true);
    expect((await rules.readRule(id))?.status).toBe('paused');
  });

  it('deleteRule 删本体且不再出现在列表', async () => {
    expect(await rules.deleteRule(id)).toBe(true);
    expect(existsSync(join(home, 'butler', '.rules', `${id}.md`))).toBe(false);
    expect(await rules.listRules()).toHaveLength(0);
  });
});

describe('createRuleFromNegation ⑧ 路由', () => {
  it('否定式 → kind=rule、承诺=必做到、语面触发词留空', async () => {
    const rule = await rules.createRuleFromNegation('回复里不要用感叹号');
    expect(rule.kind).toBe('rule');
    expect(rule.commitment).toBe('必做到');
    expect(rule.intentRaw).toBe('回复里不要用感叹号');
    expect(rule.trigger.keywords).toEqual([]);
  });
});

describe('偏好层 ⑧ 拒收：否定式不落盘，返回 routed 信号', () => {
  it('addPreference 命中否定式 → routed 且不写入', async () => {
    const before = (await prefs.listPreferences()).length;
    const res = await prefs.addPreference('不要用 emoji 回复');
    expect(res.added).toBe(false);
    expect(res.routed?.content).toBe('不要用 emoji 回复');
    expect((await prefs.listPreferences()).length).toBe(before);

    const raw = await readFile(join(home, 'butler', 'preferences.md'), 'utf-8');
    expect(raw).not.toContain('emoji');
  });

  it('updatePreference 改成否定式 → routed 且不改盘；普通内容仍可改', async () => {
    await prefs.addPreference('输出尽量简洁', { type: '偏好习惯' });
    const list = await prefs.listPreferences();
    const target = list.find((p) => p.content === '输出尽量简洁');
    expect(target).toBeTruthy();

    const blocked = await prefs.updatePreference(target!.index, { content: '禁止写长段落' });
    expect(blocked.updated).toBe(false);
    expect(blocked.routed?.content).toBe('禁止写长段落');
    expect((await prefs.listPreferences()).find((p) => p.content === '禁止写长段落')).toBeUndefined();

    const ok = await prefs.updatePreference(target!.index, { content: '输出保持简短' });
    expect(ok.updated).toBe(true);
    expect((await prefs.listPreferences()).find((p) => p.content === '输出保持简短')).toBeTruthy();
  });
});