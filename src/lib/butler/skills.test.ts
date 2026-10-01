/**
 * 技能账本（Skills）回归：存储模型往返 + 权限最小化 + 生命周期默认值（Phase 3 §3.4）。
 *
 * 本批（3b）**只做只读 + 固化**，故这里验证的正是那几件事：
 *   1) 一条技能一个文件、写读往返不丢字段（when 四组 / steps 参数 / grants / effects / description）；
 *   2) id 白名单 `sk-<8位日期>-<hex>` 能挡住非法 id（读写两侧）；
 *   3) grants 默认空 = 最小权限（normalizeGrants / isGrantsEmpty / describeEffects）；
 *   4) lifecycle 缺省 active、origin 缺省 ai、runtime 缺省 compose；坏文件不阻断列表。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的模块级常量在 import 时由环境变量确定，
 * 所以必须先设 env 再动态 import（对齐 rules.test.ts 的做法）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describeEffects, isGrantsEmpty, normalizeGrants } from './skills-shared';

let home = '';
let skills: typeof import('./skills');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-skills-'));
  process.env.BOBWORK_HOME = home;
  skills = await import('./skills');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('grants 最小权限（默认空）', () => {
  it('缺省 / 非法一律收敛为空声明', () => {
    expect(normalizeGrants(undefined)).toEqual({});
    expect(normalizeGrants(null)).toEqual({});
    expect(normalizeGrants({ fs: [], net: false, process: false })).toEqual({});
    expect(isGrantsEmpty(undefined)).toBe(true);
    expect(isGrantsEmpty({ net: true })).toBe(false);
  });

  it('describeEffects 由 grants 派生可读副作用；空声明显示 No side effects declared', () => {
    expect(describeEffects(undefined)).toEqual(['No side effects declared']);
    const eff = describeEffects({ fs: ['out/'], net: true, process: true });
    expect(eff.some((e) => e.includes('Writes files'))).toBe(true);
    expect(eff.some((e) => e.includes('network'))).toBe(true);
    expect(eff.some((e) => e.includes('subprocess'))).toBe(true);
  });
});

describe('技能存储 CRUD', () => {
  let id = '';

  it('createSkill 生成 sk- id / version=1 / lifecycle=active / origin=ai 并落盘', async () => {
    const skill = await skills.createSkill({
      name: 'Daily digest to calendar',
      description: 'Collect the day\'s notes and schedule a digest block.',
      when: {
        keywords: ['digest', '汇总'],
        scenes: ['butler'],
        objectTypes: ['schedule'],
        preconditions: ['project active'],
      },
      steps: [
        { primitive: 'create_scheduled_todo', params: { when: '2026-09-28T09:00:00.000Z' }, text: 'schedule digest' },
      ],
      grants: { fs: ['butler/'] },
      effects: ['Enters calendar'],
    });
    id = skill.id;
    expect(id).toMatch(/^sk-\d{8}-[0-9a-f]{4,}$/);
    expect(skill.version).toBe(1);
    expect(skill.lifecycle).toBe('active');
    expect(skill.origin).toBe('ai');
    expect(skill.runtime).toBe('compose');
    expect(existsSync(skills.skillFilePath(id))).toBe(true);
  });

  it('readSkill 往返不丢字段', async () => {
    const s = await skills.readSkill(id);
    expect(s).not.toBeNull();
    expect(s?.name).toBe('Daily digest to calendar');
    expect(s?.description).toContain('digest block');
    expect(s?.when.keywords).toEqual(['digest', '汇总']);
    expect(s?.when.scenes).toEqual(['butler']);
    expect(s?.when.objectTypes).toEqual(['schedule']);
    expect(s?.when.preconditions).toEqual(['project active']);
    expect(s?.steps[0].primitive).toBe('create_scheduled_todo');
    expect(s?.steps[0].params).toEqual({ when: '2026-09-28T09:00:00.000Z' });
    expect(s?.grants).toEqual({ fs: ['butler/'] });
    expect(s?.effects).toEqual(['Enters calendar']);
  });

  it('serializeSkill / parseSkill 纯往返一致', async () => {
    const s = await skills.readSkill(id);
    if (!s) throw new Error('missing skill');
    const again = skills.parseSkill(skills.serializeSkill(s));
    expect(again).toEqual(s);
  });

  it('listSkills 列出并过滤非法文件', async () => {
    // 造一个名字不合法的 .md：应被过滤，不阻断列表
    const { promises: fs } = await import('fs');
    await fs.mkdir(skills.skillsRoot(), { recursive: true });
    await fs.writeFile(join(skills.skillsRoot(), 'not-a-skill.md'), 'garbage', 'utf-8');
    const list = await skills.listSkills();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
  });

  it('readSkill 拒绝非法 id；writeSkill 对非法 id 抛错', async () => {
    expect(await skills.readSkill('../../etc/passwd')).toBeNull();
    expect(await skills.readSkill('sk-bad')).toBeNull();
    await expect(
      skills.writeSkill({ ...(await skills.readSkill(id))!, id: 'evil' }),
    ).rejects.toThrow();
  });

  it('parseSkill 对坏内容返回 null', () => {
    expect(skills.parseSkill('not a frontmatter doc')).toBeNull();
    expect(skills.parseSkill('---\nname: x\n---\nno id')).toBeNull();
  });

  it('deleteSkill 删除本体', async () => {
    expect(await skills.deleteSkill(id)).toBe(true);
    expect(await skills.readSkill(id)).toBeNull();
    expect(await skills.deleteSkill('sk-bad')).toBe(false);
  });
});

describe('技能文件形态', () => {
  it('frontmatter 五要素齐全（when / origin+version+时间 / signals 由日志派生 / revisions / lifecycle）', async () => {
    const skill = await skills.createSkill({
      name: 'Roundtrip',
      description: 'desc',
      when: { keywords: ['k'] },
    });
    const raw = await readFile(skills.skillFilePath(skill.id), 'utf-8');
    for (const key of ['when_keywords', 'origin', 'version', 'created_at', 'updated_at', 'revisions', 'lifecycle', 'runtime', 'grants', 'steps']) {
      expect(raw, key).toContain(`${key}:`);
    }
    expect(raw).toContain('## Description');
  });
});