/**
 * 技能沙箱（skill-sandbox）回归：权限边界 + 静态拦截 + 执行前门禁（Phase 3 §3.7）。
 *
 * 本批（3c）只做 `compose`（受审原语编排），故这里验证的正是那几件事：
 *   1) `checkGrantsCover`：未声明一律拒绝（默认最小权限）——fs / net / process 三档；
 *   2) `planSkill`：非 compose、无步骤、超步数上限、未受审原语 一律拒；
 *   3) `runSkill` 执行前门禁：找不到 / 非 active 生命周期 / 非法技能 一律拒，且**不触达执行器**。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的模块级常量在 import 时由环境变量确定，
 * 所以必须先设 env 再动态 import（对齐 skills.test.ts 的做法）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkGrantsCover, MAX_SKILL_STEPS, planSkill } from './skill-sandbox';

let home = '';
let skills: typeof import('./skills');
let sandbox: typeof import('./skill-sandbox');
let signals: typeof import('./rule-signals');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-skill-sandbox-'));
  process.env.BOBWORK_HOME = home;
  skills = await import('./skills');
  sandbox = await import('./skill-sandbox');
  signals = await import('./rule-signals');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('checkGrantsCover：未声明即拒绝（默认最小权限）', () => {
  it('无能力需求时恒通过（含空声明）', () => {
    expect(checkGrantsCover(undefined, [])).toBe(true);
    expect(checkGrantsCover({}, [])).toBe(true);
  });

  it('fs 需非空路径白名单', () => {
    expect(checkGrantsCover(undefined, ['fs'])).toBe(false);
    expect(checkGrantsCover({ fs: [] }, ['fs'])).toBe(false);
    expect(checkGrantsCover({ fs: ['butler/'] }, ['fs'])).toBe(true);
  });

  it('net / process 需显式 true', () => {
    expect(checkGrantsCover(undefined, ['net'])).toBe(false);
    expect(checkGrantsCover({ net: false }, ['net'])).toBe(false);
    expect(checkGrantsCover({ net: true }, ['net'])).toBe(true);
    expect(checkGrantsCover({ process: true }, ['process'])).toBe(true);
    expect(checkGrantsCover({ net: true }, ['process'])).toBe(false);
  });
});

describe('planSkill：静态拦截（只放受审原语）', () => {
  async function make(input: Parameters<typeof skills.createSkill>[0]) {
    return skills.createSkill(input);
  }

  it('合法 compose 技能 → 通过，步骤计划与声明一致', async () => {
    const skill = await make({
      name: 'Daily digest',
      description: 'schedule a digest block',
      when: { keywords: ['digest'] },
      steps: [{ primitive: 'create_scheduled_todo', params: { when: '2026-09-28T09:00:00.000Z' }, text: 'digest' }],
    });
    const plan = planSkill(skill);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.plans.length).toBe(1);
      expect(plan.plans[0].primitive).toBe('create_scheduled_todo');
    }
  });

  it('script 形态 → 拒（3c 仅支持 compose）', async () => {
    const skill = await make({
      name: 'Scripted',
      description: 'x',
      when: { keywords: ['k'] },
      runtime: 'script',
      steps: [{ primitive: 'create_todo' }],
    });
    const plan = planSkill(skill);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain('script');
  });

  it('无步骤 → 拒', async () => {
    const skill = await make({ name: 'Empty', description: 'x', when: { keywords: ['k'] } });
    const plan = planSkill(skill);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain('没有可执行');
  });

  it('步骤数超上限 → 拒', async () => {
    const steps = Array.from({ length: MAX_SKILL_STEPS + 1 }, () => ({ primitive: 'create_todo' }));
    const skill = await make({ name: 'TooLong', description: 'x', when: { keywords: ['k'] }, steps });
    const plan = planSkill(skill);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain('超上限');
  });

  it('未受审原语 → 拒', async () => {
    const skill = await make({
      name: 'UnknownPrimitive',
      description: 'x',
      when: { keywords: ['k'] },
      steps: [{ primitive: 'run_arbitrary_shell' }],
    });
    const plan = planSkill(skill);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain('未受审');
  });
});

describe('runSkill：执行前门禁（不触达执行器）', () => {
  it('找不到技能 → 拒', async () => {
    const res = await sandbox.runSkill({ skillId: 'sk-20260928-dead', text: 'x', anchor: {} });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('找不到技能');
  });

  it('非 active 生命周期（quarantine）→ 拒，不执行', async () => {
    const skill = await skills.createSkill({
      name: 'Quarantined',
      description: 'x',
      when: { keywords: ['k'] },
      steps: [{ primitive: 'create_todo' }],
    });
    await skills.writeSkill({ ...skill, lifecycle: 'quarantine' });
    const res = await sandbox.runSkill({ skillId: skill.id, text: 'x', anchor: {} });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('不自动执行');
  });

  it('非法技能（未受审原语）→ 拒，不执行', async () => {
    const skill = await skills.createSkill({
      name: 'Bad',
      description: 'x',
      when: { keywords: ['k'] },
      steps: [{ primitive: 'delete_everything' }],
    });
    const res = await sandbox.runSkill({ skillId: skill.id, text: 'x', anchor: {} });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('未受审');
  });
});

describe('技能信号（Phase 3 §3.8：复用规则信号写口）', () => {
  it('recordSkillRun：成功落 hits；失败落 skill_failure', async () => {
    const skill = await skills.createSkill({ name: 'Sig', description: 'x', when: { keywords: ['k'] } });
    await signals.recordSkillRun(skill.id, 1, true, 'evt-1');
    await signals.recordSkillRun(skill.id, 1, false, undefined, 'boom');
    const { promises: fs } = await import('fs');
    const { join: j } = await import('path');
    const logsRoot = j(home, 'butler', '.rules', '.logs');
    const hitLines = (await fs.readFile(j(logsRoot, 'hits', `${skill.id}.jsonl`), 'utf-8')).trim().split('\n');
    const failLines = (await fs.readFile(j(logsRoot, 'skill_failure', `${skill.id}.jsonl`), 'utf-8')).trim().split('\n');
    expect(hitLines.length).toBe(1);
    expect(JSON.parse(hitLines[0]).producedRef).toBe('evt-1');
    expect(failLines.length).toBe(1);
    expect(JSON.parse(failLines[0]).reason).toBe('boom');
  });

  it('countConsecutiveSkillFailures：只数最近一次成功之后的连续失败', async () => {
    const skill = await skills.createSkill({ name: 'Consec', description: 'x', when: { keywords: ['k'] } });
    const tick = () => new Promise((r) => setTimeout(r, 3)); // 跨毫秒，规避 at 同刻歧义
    await signals.recordSkillRun(skill.id, 1, false);
    await tick();
    await signals.recordSkillRun(skill.id, 1, false);
    expect(await signals.countConsecutiveSkillFailures(skill.id)).toBe(2);
    // 一次成功清零
    await tick();
    await signals.recordSkillRun(skill.id, 1, true);
    expect(await signals.countConsecutiveSkillFailures(skill.id)).toBe(0);
    await tick();
    await signals.recordSkillRun(skill.id, 1, false);
    expect(await signals.countConsecutiveSkillFailures(skill.id)).toBe(1);
  });

  it('evaluateSkillRevision：样本不足 K 时不启用（与规则同判据）', async () => {
    const skill = await skills.createSkill({ name: 'Rev', description: 'x', when: { keywords: ['k'] } });
    const r = await signals.evaluateSkillRevision(skill.id, 1);
    expect(r.active).toBe(false);
    expect(r.shouldPropose).toBe(false);
  });
});