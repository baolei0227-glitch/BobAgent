import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProjectPlan, PlanStep } from '@/lib/project/plans';
import {
  PLAN_TODOS_NOTE_TITLE,
  collectPlanTodoRows,
  planTodoRowText,
  syncPlanTodos,
} from '@/lib/project/plan-todo-sync';

/**
 * 计划 → 便签待办 单向同步回归（P0-1(a) 首版）。
 *
 * 背景：计划的 due 只活在 plans.json 与管家对话里，用户日常看的「待办」是画布便签；
 * 本模块把「active 计划中未完成且带 due 的步骤」物料化成一张专用系统便签的行。
 * 关键性质：幂等（重复同步不重复成行）、单向（勾选便签不改计划）、清理（步骤完成/计划收尾即移除）、
 * 豁免用户便签配额、空则移除便签。
 *
 * 用真实临时目录 + 真实 sticky-notes.json 读写验证落盘结果。
 */

const stickyFile = () => join(dir, 'sticky-notes', 'sticky-notes.json');

async function readNotes(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(stickyFile(), 'utf-8');
  return (JSON.parse(raw) as { notes: Array<Record<string, unknown>> }).notes;
}

async function writeNotes(notes: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(join(dir, 'sticky-notes'), { recursive: true });
  await writeFile(stickyFile(), JSON.stringify({ notes }, null, 2), 'utf-8');
}

function step(id: string, title: string, over: Partial<PlanStep> = {}): PlanStep {
  return { id, title, status: 'pending', ...over };
}

function plan(id: string, over: Partial<ProjectPlan> = {}): ProjectPlan {
  return {
    id,
    title: `计划 ${id}`,
    status: 'active',
    milestones: [{ id: `${id}-m1`, title: '执行', status: 'active', steps: [] }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** 取系统便签当前页 */
function sysPage(notes: Array<Record<string, unknown>>) {
  const note = notes.find((n) => n.planTodos === true);
  if (!note) throw new Error('未找到系统「计划待办」便签');
  const pages = note.pages as Array<Record<string, unknown>>;
  const active = pages.find((p) => p.id === note.activePageId) ?? pages[0];
  return active;
}

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plan-todo-sync-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('collectPlanTodoRows', () => {
  it('只收 active 计划中「未完成且带 due」的步骤', () => {
    const rows = collectPlanTodoRows([
      plan('p1', {
        milestones: [
          {
            id: 'm1',
            title: '执行',
            status: 'active',
            steps: [
              step('s1', '带截止', { due: '2026-11-01' }),
              step('s2', '无截止'), // 无 due → 跳过
              step('s3', '已完成', { due: '2026-11-02', status: 'done' }), // done → 跳过
            ],
          },
        ],
      }),
      plan('p2', { status: 'done', milestones: [{ id: 'm2', title: 'x', status: 'done', steps: [step('t1', '收尾计划步骤', { due: '2026-11-03' })] }] }),
      plan('p3', { status: 'abandoned', milestones: [{ id: 'm3', title: 'y', status: 'active', steps: [step('u1', '放弃计划步骤', { due: '2026-11-04' })] }] }),
    ]);
    expect(rows.map((r) => r.ref)).toEqual(['p1/s1']);
    expect(rows[0].text).toBe(planTodoRowText('带截止', '2026-11-01'));
  });
});

describe('syncPlanTodos：创建与幂等', () => {
  it('首次同步建系统便签，每个步骤一行，refs 与行序对齐；重复同步为幂等空操作', async () => {
    const plans = [
      plan('p1', {
        milestones: [
          { id: 'm1', title: '执行', status: 'active', steps: [step('s1', '立案', { due: '2026-11-01' }), step('s2', '取证', { due: '2026-11-05' })] },
        ],
      }),
    ];
    const first = await syncPlanTodos(dir, plans);
    expect(first.created).toBe(2);
    expect(first.changed).toBe(true);

    const notes = await readNotes();
    expect(notes).toHaveLength(1);
    const note = notes[0];
    expect(note.planTodos).toBe(true);
    expect(note.title).toBe(PLAN_TODOS_NOTE_TITLE);
    const page = sysPage(notes);
    expect(String(page.content).split('\n')).toEqual([
      planTodoRowText('立案', '2026-11-01'),
      planTodoRowText('取证', '2026-11-05'),
    ]);
    expect(page.linePlanRefs).toEqual([['p1/s1'], ['p1/s2']]);

    const second = await syncPlanTodos(dir, plans);
    expect(second.changed).toBe(false);
    expect(second.created).toBe(0);
    expect((await readNotes())).toHaveLength(1);
  });

  it('步骤改名 → 未勾选行按计划口径重写；带 due 变化同步反映', async () => {
    await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '旧名', { due: '2026-11-01' })] }] })]);
    await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '新名', { due: '2026-12-09' })] }] })]);
    const page = sysPage(await readNotes());
    expect(String(page.content)).toBe(planTodoRowText('新名', '2026-12-09'));
    expect(page.linePlanRefs).toEqual([['p1/s1']]);
  });
});

describe('syncPlanTodos：清理', () => {
  it('步骤完成 / 计划收尾 / 去掉 due → 对应行移除；全空时整张便签移除', async () => {
    const base = () =>
      plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', 'A', { due: '2026-11-01' }), step('s2', 'B', { due: '2026-11-02' })] }] });
    await syncPlanTodos(dir, [base()]);
    expect(sysPage(await readNotes()).content).toContain('A');

    // s1 完成 → 只移除 s1 行
    const removed = await syncPlanTodos(dir, [
      plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', 'A', { due: '2026-11-01', status: 'done' }), step('s2', 'B', { due: '2026-11-02' })] }] }),
    ]);
    expect(removed.removed).toBe(1);
    const page = sysPage(await readNotes());
    expect(String(page.content)).toBe(planTodoRowText('B', '2026-11-02'));
    expect(page.linePlanRefs).toEqual([['p1/s2']]);

    // 去掉 due → 行消失；最后空 → 整张便签移除
    await syncPlanTodos(dir, [
      plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s2', 'B')] }] }),
    ]);
    expect(await readNotes()).toHaveLength(0);

    // 计划收尾（done）→ 全部行移除
    await syncPlanTodos(dir, [base()]);
    expect(await readNotes()).toHaveLength(1);
    await syncPlanTodos(dir, [plan('p1', { status: 'done', milestones: base().milestones })]);
    expect(await readNotes()).toHaveLength(0);
  });

  it('步骤被删 → 对应行移除，其余行保留', async () => {
    await syncPlanTodos(dir, [
      plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', 'A', { due: '2026-11-01' }), step('s2', 'B', { due: '2026-11-02' })] }] }),
    ]);
    await syncPlanTodos(dir, [
      plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s2', 'B', { due: '2026-11-02' })] }] }),
    ]);
    const page = sysPage(await readNotes());
    expect(String(page.content)).toBe(planTodoRowText('B', '2026-11-02'));
  });
});

describe('syncPlanTodos：认领与用户态', () => {
  it('无 ref 但标题一致的行被认领（不产生重复行）', async () => {
    await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '立案', { due: '2026-11-01' })] }] })]);
    // 模拟客户端结构编辑把行级标记弄丢
    const notes = await readNotes();
    const page = sysPage(notes);
    page.linePlanRefs = [[]];
    await writeNotes(notes);

    const res = await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '立案', { due: '2026-11-01' })] }] })]);
    expect(res.created).toBe(0);
    const after = sysPage(await readNotes());
    expect(String(after.content).split('\n')).toHaveLength(1);
    expect(after.linePlanRefs).toEqual([['p1/s1']]);
  });

  it('用户已勾选的行原样保留（单向：勾选不改计划）', async () => {
    await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '立案', { due: '2026-11-01' })] }] })]);
    const notes = await readNotes();
    const page = sysPage(notes);
    page.content = '- [x] 立案 · due 2026-11-01';
    await writeNotes(notes);

    await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '立案', { due: '2026-11-01' })] }] })]);
    const after = sysPage(await readNotes());
    expect(String(after.content)).toBe('- [x] 立案 · due 2026-11-01');
    expect(after.linePlanRefs).toEqual([['p1/s1']]);
  });

  it('系统便签里的用户手动行（无 ref）不会被清理', async () => {
    await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '立案', { due: '2026-11-01' })] }] })]);
    const notes = await readNotes();
    const page = sysPage(notes);
    page.content = `${page.content}\n- [ ] 我自己的事`;
    page.linePlanRefs = [...(page.linePlanRefs as string[][]), []];
    await writeNotes(notes);

    await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '立案', { due: '2026-11-01' })] }] })]);
    const after = sysPage(await readNotes());
    expect(String(after.content).split('\n')).toEqual([planTodoRowText('立案', '2026-11-01'), '- [ ] 我自己的事']);
  });
});

describe('syncPlanTodos：配额与落点', () => {
  it('已存在 3 张用户便签时，系统便签仍可直写（豁免 MAX_TODO_NOTES）且用蓝色区分', async () => {
    await writeNotes([
      { id: 'u1', x: 0, y: 0, color: 'yellow', title: 'U1', pages: [{ id: 'u1p', title: 'P1', content: '- [ ] a' }], activePageId: 'u1p', createdAt: 'x', updatedAt: 'x' },
      { id: 'u2', x: 0, y: 0, color: 'green', title: 'U2', pages: [{ id: 'u2p', title: 'P1', content: '- [ ] b' }], activePageId: 'u2p', createdAt: 'x', updatedAt: 'x' },
      { id: 'u3', x: 0, y: 0, color: 'pink', title: 'U3', pages: [{ id: 'u3p', title: 'P1', content: '- [ ] c' }], activePageId: 'u3p', createdAt: 'x', updatedAt: 'x' },
    ]);
    const res = await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '立案', { due: '2026-11-01' })] }] })]);
    expect(res.created).toBe(1);
    const notes = await readNotes();
    expect(notes).toHaveLength(4);
    const sys = notes.find((n) => n.planTodos === true)!;
    expect(sys.color).toBe('blue');
    // 用户便签未被改动
    expect(notes.filter((n) => !n.planTodos)).toHaveLength(3);
  });

  it('无任何待物料步骤且无系统便签 → 空操作，不建便签', async () => {
    const res = await syncPlanTodos(dir, [plan('p1', { milestones: [{ id: 'm1', title: 'x', status: 'active', steps: [step('s1', '无截止')] }] })]);
    expect(res.changed).toBe(false);
    await expect(readNotes()).rejects.toBeTruthy();
  });
});
