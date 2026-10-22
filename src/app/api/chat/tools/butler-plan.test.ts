import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 计划树回归（2026-10-18 补齐闭环）。
 *
 * 背景：计划树此前只有 start / view / add_steps / step_status 四件 ——
 *   计划只能创建与推进，**没有收尾**：一件事做完了 / 不做了，plans.json 里仍挂着 active，
 *   于是「项目里还有什么没完」只能越看越糊；同一件事重复调 start 还会堆出一串同义计划。
 * 本次补：① start 同项目同名 active 去重（返回已有 id，不重复建）；
 *   ② step 支持可选 due / owner / artifact（向后兼容旧数据，无迁移）；
 *   ③ 计划终态（done / abandoned）与 project_plan_close（关闭/重开）、project_plan_delete。
 *
 * 用真实临时目录 + 真实 plans.json 读写验证落盘结果；只把「项目解析」替成固定 temp root
 * （否则会写到本机真实的 BobWork 项目目录）。
 */
const hoisted = vi.hoisted(() => ({ projectRoot: '' }));

vi.mock('@/lib/project/resolve-explicit-project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project/resolve-explicit-project')>();
  return {
    ...actual,
    resolveProjectWithFallback: vi.fn(async () => ({
      ok: true,
      project: { id: 'p1', name: 'TestProject', path: hoisted.projectRoot },
      source: 'current_fallback',
    })),
  };
});

import { butlerToolDefs } from '@/app/api/chat/tools/butler';

function tool(name: string) {
  const def = butlerToolDefs.find((d) => d.name === name);
  if (!def) throw new Error(`未找到工具：${name}`);
  return def;
}

async function runText(name: string, args: Record<string, unknown>): Promise<string> {
  const out = await tool(name).execute(args);
  return typeof out === 'string' ? out : out.text;
}

async function runJson(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(await runText(name, args)) as Record<string, unknown>;
}

interface PersistedPlan {
  id: string;
  title: string;
  goal?: string;
  status: string;
  milestones: Array<{ id: string; title: string; status: string; steps: Array<Record<string, unknown>> }>;
}

async function readPersisted(): Promise<PersistedPlan[]> {
  // 落盘结构是 { plans: ProjectPlan[] }（见 butler.ts writePlans）
  const raw = await readFile(join(hoisted.projectRoot, '.butler', 'plans.json'), 'utf-8');
  return (JSON.parse(raw) as { plans: PersistedPlan[] }).plans;
}

/** 读计划同步出来的系统「计划待办」便签（无文件 → 空数组） */
async function readStickyNotes(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(join(hoisted.projectRoot, 'sticky-notes', 'sticky-notes.json'), 'utf-8');
    return (JSON.parse(raw) as { notes: Array<Record<string, unknown>> }).notes;
  } catch {
    return [];
  }
}

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'butler-plan-'));
  hoisted.projectRoot = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('计划树：创建与去重', () => {
  it('start：落盘标题/步骤，步骤对象里的 due / owner / artifact 一并持久化并入渲染', async () => {
    const text = await runText('project_plan_start', {
      title: '诉讼推进',
      goal: '一审结案',
      steps: [
        { title: '立案', due: '2026-11-01', owner: '张律师', artifact: 'homework/立案材料.docx' },
        '取证',
      ],
    });
    expect(text).toContain('Plan created');

    const plans = await readPersisted();
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('诉讼推进');
    expect(plans[0].goal).toBe('一审结案');
    expect(plans[0].status).toBe('active');
    const steps = plans[0].milestones[0].steps;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ title: '立案', due: '2026-11-01', owner: '张律师', artifact: 'homework/立案材料.docx', status: 'pending' });
    expect(steps[1]).toMatchObject({ title: '取证', status: 'pending' });
    // 渲染里应能看见登记项，否则模型看不见 due/owner
    expect(text).toContain('due:2026-11-01');
    expect(text).toContain('owner:张律师');
  });

  it('start：同项目同名 active 计划 → 去重，返回已有 id 且不再新建', async () => {
    const first = await runText('project_plan_start', { title: '诉讼推进', steps: ['立案'] });
    const second = await runText('project_plan_start', { title: '诉讼推进', steps: ['立案'] });

    expect(first).toContain('Plan created');
    expect(second).toContain('Plan already exists');
    const plans = await readPersisted();
    expect(plans).toHaveLength(1);

    const id = plans[0].id;
    expect(first).toContain(id);
    expect(second).toContain(id);
  });

  it('start：旧格式（纯字符串步骤）仍可用 → 向后兼容', async () => {
    await runText('project_plan_start', { title: '兼容', steps: ['一', '二'] });
    const plans = await readPersisted();
    expect(plans[0].milestones[0].steps.map((s) => s.title)).toEqual(['一', '二']);
    expect(plans[0].milestones[0].steps[0].due).toBeUndefined();
  });
});

describe('计划树：终态与收尾', () => {
  it('close(done/abandoned)：置终态；该状态下不许改步骤；reopen 后才能继续', async () => {
    await runText('project_plan_start', { title: '待收尾', steps: ['A'] });
    let plans = await readPersisted();
    const planId = plans[0].id;
    const stepId = plans[0].milestones[0].steps[0].id as string;

    const closed = await runText('project_plan_close', { plan_id: planId, status: 'done' });
    expect(closed).toContain('closed as done');
    plans = await readPersisted();
    expect(plans[0].status).toBe('done');

    // 终态下改步骤 → 结构化拒绝（并指路重开）
    const blocked = await runJson('project_plan_step_status', { plan_id: planId, step_id: stepId, status: 'in_progress' });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error)).toContain('已关闭');
    const blockedAdd = await runJson('project_plan_add_steps', { plan_id: planId, steps: ['B'] });
    expect(blockedAdd.ok).toBe(false);
    expect(String(blockedAdd.error)).toContain('已关闭');
    // 拒绝即不落盘：状态仍是 done、步骤没被改
    plans = await readPersisted();
    expect(plans[0].status).toBe('done');

    // reopen → 按步骤现状自动定级（此处仍有未完成步骤 → active）
    const reopened = await runText('project_plan_close', { plan_id: planId, status: 'active' });
    expect(reopened).toContain('reopened');
    plans = await readPersisted();
    expect(plans[0].status).toBe('active');

    // 重开后步骤可变（成功路径返回的是可读文本，非 JSON）
    const advanced = await runText('project_plan_step_status', { plan_id: planId, step_id: stepId, status: 'in_progress' });
    expect(advanced).toContain('in_progress');
    plans = await readPersisted();
    expect(plans[0].milestones[0].steps[0].status).toBe('in_progress');
  });

  it('close：abandoned 后即使步骤全完成也不自动翻回 done（终态不自动回退）', async () => {
    await runText('project_plan_start', { title: '放弃的计划', steps: [{ title: 'A' }] });
    let plans = await readPersisted();
    const planId = plans[0].id;
    await runText('project_plan_close', { plan_id: planId, status: 'abandoned' });
    plans = await readPersisted();
    expect(plans[0].status).toBe('abandoned');
    // 放弃后不能推进 → 也就不会因「全完成」被 recalc 翻成 done
    const blocked = await runJson('project_plan_step_status', { plan_id: planId, step_id: plans[0].milestones[0].steps[0].id as string, status: 'done' });
    expect(blocked.ok).toBe(false);
    plans = await readPersisted();
    expect(plans[0].status).toBe('abandoned');
  });

  it('view：列表带终态标记（abandoned 显示 ⛔）', async () => {
    await runText('project_plan_start', { title: 'A 计划', steps: ['x'] });
    await runText('project_plan_start', { title: 'B 计划', steps: ['y'] });
    const plans = await readPersisted();
    const b = plans.find((p) => p.title === 'B 计划');
    await runText('project_plan_close', { plan_id: b!.id, status: 'abandoned' });

    const view = await runText('project_plan_view', {});
    expect(view).toContain('⛔');
    expect(view).toContain('abandoned');
    expect(view).toContain('▶');
  });

  it('delete：移除计划；再删同 id → 计划不存在', async () => {
    await runText('project_plan_start', { title: '要删的计划', steps: ['x'] });
    const plans = await readPersisted();
    const planId = plans[0].id;

    const deleted = await runText('project_plan_delete', { plan_id: planId });
    expect(deleted).toContain('Deleted plan');
    expect(await readPersisted()).toHaveLength(0);

    const again = await runJson('project_plan_delete', { plan_id: planId });
    expect(again.ok).toBe(false);
    expect(String(again.error)).toContain('计划不存在');
  });

  it('close / delete：非法或缺失 plan_id 与非法 status → 结构化报错', async () => {
    const badStatus = await runJson('project_plan_close', { plan_id: 'plan-x', status: 'closed' });
    expect(badStatus.ok).toBe(false);
    expect(String(badStatus.error)).toContain('非法状态');

    const noPlan = await runJson('project_plan_close', { status: 'done' });
    expect(noPlan.ok).toBe(false);
    expect(String(noPlan.error)).toContain('plan_id');

    const missing = await runJson('project_plan_delete', { plan_id: 'plan-none' });
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain('计划不存在');
  });
});

describe('计划 → 便签待办 单向同步（P0-1(a)）', () => {
  it('start 带 due 的步骤 → 自动建系统「计划待办」便签并落行；步骤完成 → 行移除', async () => {
    await runText('project_plan_start', {
      title: '诉讼推进',
      steps: [{ title: '立案', due: '2026-11-01' }, '取证'],
    });

    const notes = await readStickyNotes();
    const sys = notes.find((n) => n.planTodos === true);
    expect(sys).toBeTruthy();
    const page = (sys!.pages as Array<Record<string, unknown>>)[0];
    expect(String(page.content)).toContain('立案');
    // 无 due 的步骤不物料化
    expect(String(page.content)).not.toContain('取证');
    expect(page.linePlanRefs).toHaveLength(1);

    const plans = await readPersisted();
    const planId = plans[0].id;
    const stepId = plans[0].milestones[0].steps[0].id as string;
    // pending 不能直接 → done，先 in_progress（与状态机一致）
    await runText('project_plan_step_status', { plan_id: planId, step_id: stepId, status: 'in_progress' });
    await runText('project_plan_step_status', { plan_id: planId, step_id: stepId, status: 'done' });
    // 唯一带 due 的步骤已完成 → 系统便签清空移除
    expect(await readStickyNotes()).toHaveLength(0);
  });

  it('计划收尾（done）→ 系统便签行全部移除；先有 3 张用户便签也不占用其配额', async () => {
    // 预置 3 张用户待办便签（占满用户配额），验证系统便签仍可直写
    const { mkdir, writeFile: wf } = await import('fs/promises');
    await mkdir(join(hoisted.projectRoot, 'sticky-notes'), { recursive: true });
    await wf(
      join(hoisted.projectRoot, 'sticky-notes', 'sticky-notes.json'),
      JSON.stringify({
        notes: [1, 2, 3].map((i) => ({
          id: `u${i}`, x: 0, y: 0, color: 'yellow', title: `U${i}`,
          pages: [{ id: `u${i}p`, title: 'P1', content: `- [ ] 用户待办${i}` }],
          activePageId: `u${i}p`, createdAt: 'x', updatedAt: 'x',
        })),
      }),
      'utf-8',
    );

    await runText('project_plan_start', { title: '配额豁免验证', steps: [{ title: 'A', due: '2026-12-01' }] });
    let notes = await readStickyNotes();
    expect(notes).toHaveLength(4);
    expect(notes.filter((n) => n.planTodos === true)).toHaveLength(1);

    const plans = await readPersisted();
    await runText('project_plan_close', { plan_id: plans[0].id, status: 'done' });
    notes = await readStickyNotes();
    // 系统便签移除，用户的 3 张完好
    expect(notes.filter((n) => n.planTodos === true)).toHaveLength(0);
    expect(notes).toHaveLength(3);
  });
});
