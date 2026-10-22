/**
 * 路由级回归：`GET /api/projects/plans`（计划树只读派生视图，2026-10-18）。
 *
 * 背景：计划树此前只活在管家的写类工具里，界面看不到。本接口把它**只读**暴露给「计划面板」，
 * 本组锁住三条契约：① 默认只列进行中计划（终态需 include_closed 显式带出）；
 * ② 派生字段口径（progress.percent / overdue 逾期天数 / nextDue / stalled）；
 * ③ 项目解析失败如实回 404（无当前项目 NO_PROJECT / 指定 id 不存在 PROJECT_NOT_FOUND）。
 *
 * 隔离：project-manager 被整体 mock，项目盘符指向临时目录，plans.json 由用例自造。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { NextRequest } from 'next/server';

const projectManager = vi.hoisted(() => ({
  getCurrentProject: vi.fn(),
  getProjectById: vi.fn(),
}));

vi.mock('@/lib/project/project-manager', () => projectManager);

import { GET } from '@/app/api/projects/plans/route';

const tmpDirs: string[] = [];

/** 造一个带 .butler/plans.json 的临时项目，返回 route 需要的 ProjectConfig 片段 */
async function makeProject(id: string, name: string, plans: unknown[]): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), 'plans-route-'));
  tmpDirs.push(dir);
  await mkdir(join(dir, '.butler'), { recursive: true });
  await writeFile(join(dir, '.butler', 'plans.json'), JSON.stringify({ plans }, null, 2), 'utf-8');
  return { id, name, path: dir };
}

function planFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1',
    title: '诉讼推进',
    goal: '一审结案',
    status: 'active',
    milestones: [
      {
        id: 'ms-1',
        title: '执行',
        status: 'active',
        steps: [
          { id: 'st-over', title: '逾期步骤', status: 'pending', due: '2020-01-01', owner: '张三' },
          { id: 'st-open', title: '未完成步骤', status: 'pending', due: '2099-01-01' },
          { id: 'st-done', title: '已完成步骤', status: 'done', due: '2020-01-01' },
        ],
      },
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function get(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/projects/plans${query}`);
}

beforeEach(() => {
  projectManager.getCurrentProject.mockReset();
  projectManager.getProjectById.mockReset();
});

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('GET /api/projects/plans', () => {
  it('默认只列进行中计划，终态过滤在外；totals 仍统计全部计划数', async () => {
    const proj = await makeProject('p1', '甲项目', [
      planFixture({ id: 'plan-open', status: 'active' }),
      planFixture({ id: 'plan-done', status: 'done' }),
    ]);
    projectManager.getCurrentProject.mockResolvedValue(proj);

    const res = await GET(get());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.project).toEqual({ id: 'p1', name: '甲项目' });
    expect((body.plans as Array<{ id: string }>).map((p) => p.id)).toEqual(['plan-open']);
    expect(body.totals).toMatchObject({ plans: 2, openPlans: 1, shown: 1 });
  });

  it('include_closed=1 才带出终态计划（done / abandoned）', async () => {
    const proj = await makeProject('p1', '甲项目', [
      planFixture({ id: 'plan-open', status: 'active' }),
      planFixture({ id: 'plan-done', status: 'done' }),
      planFixture({ id: 'plan-abandoned', status: 'abandoned' }),
    ]);
    projectManager.getCurrentProject.mockResolvedValue(proj);

    const res = await GET(get('?include_closed=1'));
    const body = await res.json();
    expect((body.plans as Array<{ id: string }>).map((p) => p.id).sort()).toEqual([
      'plan-abandoned',
      'plan-done',
      'plan-open',
    ]);
    expect(body.include_closed).toBe(true);
    expect(body.totals).toMatchObject({ plans: 3, openPlans: 1, shown: 3 });
  });

  it('派生字段口径：progress 进度百分比 / overdue 逾期天数 / nextDue / stalled', async () => {
    const proj = await makeProject('p1', '甲项目', [planFixture()]);
    projectManager.getCurrentProject.mockResolvedValue(proj);

    const res = await GET(get());
    const body = await res.json();
    const plan = (body.plans as Array<Record<string, unknown>>)[0];

    // 3 步中 1 步完成 → 33%
    expect(plan.progress).toMatchObject({ steps: 3, done: 1, percent: 33 });
    // 只有未完成且已过期的步骤算逾期（已完成步骤虽有 due 不算）
    const overdue = plan.overdue as Array<Record<string, unknown>>;
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ step: '逾期步骤', stepId: 'st-over', milestone: '执行', daysOverdue: expect.any(Number) });
    expect(overdue[0].daysOverdue as number).toBeGreaterThan(0);
    // 下一到期 = 未完成里最早的 due
    expect(plan.nextDue).toBe('2099-01-01');
    // 完整树随包返回（界面渲染细节用）
    const ms = plan.milestones as Array<Record<string, unknown>>;
    expect((ms[0].steps as unknown[])).toHaveLength(3);
    // 刚更新的计划未停滞
    expect(plan.stalled).toBe(false);
  });

  it('project_id 指定项目：走 getProjectById；不存在 → 404 PROJECT_NOT_FOUND', async () => {
    const proj = await makeProject('p2', '乙项目', []);
    projectManager.getProjectById.mockResolvedValue(proj);

    const ok = await GET(get('?project_id=p2'));
    const okBody = await ok.json();
    expect(ok.status).toBe(200);
    expect(okBody.project).toEqual({ id: 'p2', name: '乙项目' });
    expect(projectManager.getProjectById).toHaveBeenCalledWith('p2');

    projectManager.getProjectById.mockRejectedValue(new Error('项目不存在: p2'));
    const missing = await GET(get('?project_id=p2'));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('PROJECT_NOT_FOUND');
  });

  it('无激活项目（NO_PROJECT）→ 404，且不抛给上层', async () => {
    projectManager.getCurrentProject.mockRejectedValue(new Error('NO_PROJECT'));
    const res = await GET(get());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('NO_PROJECT');
  });
});
