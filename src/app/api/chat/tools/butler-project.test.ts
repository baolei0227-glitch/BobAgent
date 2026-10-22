import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 管家 create_project 的界面同步契约回归（2026-10-09）。
 *
 * 事故：管家用 `create_project(name, make_current=true)` 建完项目后，服务端已把当前项目切成新项目，
 * 但工具只广播了 `projects-changed`（侧边栏刷新列表）——画布与会话列表仍停在旧项目，而用户点侧边栏
 * 里那条已高亮的新项目时又被「已是 current，无需切换」短路，表现为「第一次点不动 / 项目看着切了、
 * 会话还是上一个项目的」。修法：make_current=true 时按 switch_project 的同口径补广播
 * `project-switched`，前端（Sidebar SSE 桥）转成 `bobagent:project-switched` 让画布无刷新重载。
 *
 * 这里锁两条：① 建完即切必须广播 project-switched（否则画布不会跟）；② 没要求 make_current 时
 * 绝不切当前项目、绝不广播切换（只会误动用户画布）。
 */
const projectEvents = vi.hoisted(() => ({
  emitProjectsChanged: vi.fn(),
  emitProjectSwitched: vi.fn(),
  emitSessionRequest: vi.fn(),
  hasProjectsChangedListeners: vi.fn(() => true),
}));

vi.mock('@/lib/project/project-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project/project-events')>();
  return { ...actual, ...projectEvents };
});

const projectManager = vi.hoisted(() => ({
  createProject: vi.fn(),
  switchProject: vi.fn(),
  getCurrentProject: vi.fn(),
  // 项目治理（2026-10-18）：分类/标签/备注、重命名、归档/取消归档
  listProjects: vi.fn(),
  updateProjectMeta: vi.fn(),
  renameProject: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
}));

vi.mock('@/lib/project/project-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project/project-manager')>();
  return { ...actual, ...projectManager };
});

/** 跨项目计划总览会扫「项目最近活动」——测试里替换掉，避免真的去扫临时目录之外的路径 */
const activityMock = vi.hoisted(() => ({ getProjectLastActivityAt: vi.fn() }));

vi.mock('@/lib/project/activity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project/activity')>();
  return { ...actual, ...activityMock };
});

import { butlerToolDefs } from '@/app/api/chat/tools/butler';

function tool(name: string) {
  const def = butlerToolDefs.find((d) => d.name === name);
  if (!def) throw new Error(`未找到工具：${name}`);
  return def;
}

async function run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await tool(name).execute(args);
  const text = typeof out === 'string' ? out : out.text;
  return JSON.parse(text) as Record<string, unknown>;
}

const NEW_PROJECT = {
  id: '昆明鲸红王钧案-20261009',
  name: '昆明鲸红王钧案_20261009',
  path: '/tmp/BobWorkspace/昆明鲸红王钧案-20261009',
  created_at: '2026-10-09T09:47:08.527Z',
  last_accessed_at: '2026-10-09T09:47:08.527Z',
};

/** 治理用例的项目池：一个活跃（当前）+ 一个已归档 —— 归档项目也要能按名字被治理工具找到 */
const PROJ_ACTIVE = {
  id: 'proj-active',
  name: '余靖潘案_20261001',
  path: '/tmp/BobWorkspace/余靖潘案_20261001',
  created_at: '2026-10-01T00:00:00.000Z',
  last_accessed_at: '2026-10-01T00:00:00.000Z',
};
const PROJ_ARCHIVED = {
  id: 'proj-arch',
  name: '旧案_20260101',
  path: '/tmp/BobWorkspace/旧案_20260101',
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  archived: true,
};
const PROJ_OTHER = {
  id: 'proj-other',
  name: '别的项目_20260102',
  path: '/tmp/BobWorkspace/别的项目_20260102',
  created_at: '2026-01-02T00:00:00.000Z',
  last_accessed_at: '2026-01-02T00:00:00.000Z',
};

function resetProjectManagerMocks() {
  projectManager.createProject.mockReset();
  projectManager.createProject.mockResolvedValue(NEW_PROJECT);
  projectManager.listProjects.mockReset();
  projectManager.listProjects.mockResolvedValue({
    projects: [PROJ_ACTIVE, PROJ_ARCHIVED],
    active_projects: [PROJ_ACTIVE],
    archived_projects: [PROJ_ARCHIVED],
    trashed_projects: [],
    currentId: PROJ_ACTIVE.id,
  });
  for (const fn of ['updateProjectMeta', 'renameProject', 'archiveProject', 'unarchiveProject'] as const) {
    projectManager[fn].mockReset();
  }
  projectManager.getCurrentProject.mockReset();
}

describe('管家 create_project：make_current 的界面同步口径', () => {
  beforeEach(() => {
    projectEvents.emitProjectsChanged.mockClear();
    projectEvents.emitProjectSwitched.mockClear();
    projectEvents.hasProjectsChangedListeners.mockClear();
    projectEvents.hasProjectsChangedListeners.mockReturnValue(true);
    resetProjectManagerMocks();
  });

  it('make_current=true：建完即切 → 广播 project-switched（画布才会重载到新项目）', async () => {
    const parsed = await run('create_project', { name: '昆明鲸红王钧案', make_current: true });
    expect(parsed.ok).toBe(true);
    expect(parsed.is_current).toBe(true);
    expect(parsed.ui_synced).toBe(true);
    expect(projectManager.createProject).toHaveBeenCalledWith('昆明鲸红王钧案', { makeCurrent: true });
    // 列表刷新 + 切换广播，两条都要有：少后者就是本次事故
    expect(projectEvents.emitProjectsChanged).toHaveBeenCalledTimes(1);
    expect(projectEvents.emitProjectSwitched).toHaveBeenCalledWith(NEW_PROJECT.id);
  });

  it('未要求 make_current：只刷新列表，绝不切当前项目（不动用户画布）', async () => {
    const parsed = await run('create_project', { name: '昆明鲸红王钧案' });
    expect(parsed.ok).toBe(true);
    expect(parsed.is_current).toBe(false);
    expect(parsed.ui_synced).toBe(false);
    expect(projectManager.createProject).toHaveBeenCalledWith('昆明鲸红王钧案', { makeCurrent: false });
    expect(projectEvents.emitProjectsChanged).toHaveBeenCalledTimes(1);
    expect(projectEvents.emitProjectSwitched).not.toHaveBeenCalled();
  });

  it('界面没开（无 SSE 订阅者）：切换仍生效，但回执如实说 ui_synced=false', async () => {
    projectEvents.hasProjectsChangedListeners.mockReturnValue(false);
    const parsed = await run('create_project', { name: '昆明鲸红王钧案', make_current: true });
    expect(parsed.is_current).toBe(true);
    expect(parsed.ui_synced).toBe(false);
    expect(String(parsed.message)).toContain('界面当前未打开');
  });

  // 防重复新建（2026-10-19 事故）：管家在「往某个已存在的项目里写待办」时误调 create_project，
  // 会在别的项目下凭空多出一个同名（仅日期后缀不同）的重复项目。已有同名项目时必须拒绝并指回它。
  it('点名项目已存在（仅差日期后缀）：拒绝新建，回报 project_already_exists 并指回既有项目', async () => {
    const parsed = await run('create_project', { name: '余靖潘案' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('project_already_exists');
    expect(projectManager.createProject).not.toHaveBeenCalled();
    expect(projectEvents.emitProjectsChanged).not.toHaveBeenCalled();
    const existing = parsed.existing as Array<{ id: string }>;
    expect(existing[0].id).toBe(PROJ_ACTIVE.id);
  });

  it('点名项目不存在：正常新建（放行）', async () => {
    const parsed = await run('create_project', { name: '全新案子' });
    expect(parsed.ok).toBe(true);
    expect(projectManager.createProject).toHaveBeenCalledWith('全新案子', { makeCurrent: false });
  });
});

/**
 * 项目治理工具回归（2026-10-18 补齐）：
 *   project_update_meta / project_rename / project_archive / project_unarchive。
 * 此前管家侧只有 create_project / switch_project ——「把 X 项目归类 / 改名 / 归档」只能靠用户去侧边栏手点。
 * 这里锁三条口径：① 分类必须落在预设六类内（否则回结构化 invalid_category + candidates，不自造）；
 * ② 目标项目必须**点名**（找不到就回 project_not_found，绝不猜别的项目）；
 * ③ 写后必须广播 projects-changed，归档当前项目还要补 project-switched 让画布跟上。
 */
describe('管家项目治理：分类/标签/备注、改名、归档', () => {
  beforeEach(() => {
    projectEvents.emitProjectsChanged.mockClear();
    projectEvents.emitProjectSwitched.mockClear();
    projectEvents.hasProjectsChangedListeners.mockClear();
    projectEvents.hasProjectsChangedListeners.mockReturnValue(true);
    resetProjectManagerMocks();
  });

  it('update_meta：合法分类 → 落到 updateProjectMeta 并广播 projects-changed', async () => {
    projectManager.updateProjectMeta.mockResolvedValue({ ...PROJ_ACTIVE, category: '诉讼', tags: ['紧急'], note: '重点' });
    const parsed = await run('project_update_meta', { project: '余靖潘案_20261001', category: '诉讼', tags: ['紧急'], note: '重点' });
    expect(parsed.ok).toBe(true);
    expect(parsed.category).toBe('诉讼');
    expect(parsed.ui_synced).toBe(true);
    expect(projectManager.updateProjectMeta).toHaveBeenCalledWith('proj-active', { category: '诉讼', tags: ['紧急'], note: '重点' });
    expect(projectEvents.emitProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it('update_meta：预设外的分类 → 结构化报错，不自造分类、不写盘', async () => {
    const parsed = await run('project_update_meta', { project: '余靖潘案_20261001', category: '刑事' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('invalid_category');
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(String(parsed.message)).toContain('诉讼');
    expect(projectManager.updateProjectMeta).not.toHaveBeenCalled();
  });

  it('update_meta：三个字段都没给 → nothing_to_update（避免空写）', async () => {
    const parsed = await run('project_update_meta', { project: '余靖潘案_20261001' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('nothing_to_update');
    expect(projectManager.updateProjectMeta).not.toHaveBeenCalled();
  });

  it('update_meta：项目名找不到 → project_not_found（绝不猜别的项目）', async () => {
    const parsed = await run('project_update_meta', { project: '并不存在的项目', category: '诉讼' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('project_not_found');
    expect(projectManager.updateProjectMeta).not.toHaveBeenCalled();
  });

  it('rename：改名成功 → 回执带旧名/新名且路径不变，并广播', async () => {
    projectManager.renameProject.mockResolvedValue({ ...PROJ_ACTIVE, name: '余靖潘案_改名后' });
    const parsed = await run('project_rename', { project: '余靖潘案_20261001', new_name: '余靖潘案_改名后' });
    expect(parsed.ok).toBe(true);
    expect(parsed.previous_name).toBe('余靖潘案_20261001');
    expect(parsed.name).toBe('余靖潘案_改名后');
    expect(parsed.path).toBe(PROJ_ACTIVE.path);
    expect(projectManager.renameProject).toHaveBeenCalledWith('proj-active', '余靖潘案_改名后');
    expect(projectEvents.emitProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it('rename：缺 new_name → 直接报错，不调用底层', async () => {
    const parsed = await run('project_rename', { project: '余靖潘案_20261001' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('new_name is required');
    expect(projectManager.renameProject).not.toHaveBeenCalled();
  });

  it('archive：目标不是当前项目 → 只广播 projects-changed，不切画布', async () => {
    projectManager.getCurrentProject.mockResolvedValue(PROJ_OTHER);
    projectManager.archiveProject.mockResolvedValue({ ...PROJ_ACTIVE, archived: true });
    const parsed = await run('project_archive', { project: '余靖潘案_20261001' });
    expect(parsed.ok).toBe(true);
    expect(parsed.archived).toBe(true);
    expect(parsed.switched_away).toBe(false);
    expect(projectManager.archiveProject).toHaveBeenCalledWith('proj-active');
    expect(projectEvents.emitProjectsChanged).toHaveBeenCalledTimes(1);
    expect(projectEvents.emitProjectSwitched).not.toHaveBeenCalled();
  });

  it('archive：归档的是当前项目 → 自动切走并补 project-switched', async () => {
    projectManager.getCurrentProject
      .mockResolvedValueOnce(PROJ_ACTIVE) // 归档前：目标是当前项目
      .mockResolvedValueOnce(PROJ_OTHER); // 归档后：服务端已切到别的项目
    projectManager.archiveProject.mockResolvedValue({ ...PROJ_ACTIVE, archived: true });
    const parsed = await run('project_archive', { project: '余靖潘案_20261001' });
    expect(parsed.ok).toBe(true);
    expect(parsed.switched_away).toBe(true);
    expect(parsed.current_project).toEqual({ id: PROJ_OTHER.id, name: PROJ_OTHER.name });
    expect(projectEvents.emitProjectsChanged).toHaveBeenCalledTimes(1);
    expect(projectEvents.emitProjectSwitched).toHaveBeenCalledWith(PROJ_OTHER.id);
  });

  it('unarchive：已归档项目按名字可被找到并恢复（活跃池里找不到也不影响）', async () => {
    projectManager.unarchiveProject.mockResolvedValue({ ...PROJ_ARCHIVED, archived: false });
    const parsed = await run('project_unarchive', { project: '旧案_20260101' });
    expect(parsed.ok).toBe(true);
    expect(parsed.archived).toBe(false);
    expect(projectManager.unarchiveProject).toHaveBeenCalledWith('proj-arch');
    expect(projectEvents.emitProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it('unarchive：未归档项目 → 幂等回执，不调用底层', async () => {
    const parsed = await run('project_unarchive', { project: '余靖潘案_20261001' });
    expect(parsed.ok).toBe(true);
    expect(parsed.already_active).toBe(true);
    expect(projectManager.unarchiveProject).not.toHaveBeenCalled();
  });
});

/**
 * 跨项目计划总览回归（2026-10-18）：project_plans_overview（只读）。
 * 缺口：计划此前只能在**单个项目内**按 plan_id 查看，「哪个项目的计划停滞了 / 哪些步骤逾期了」
 * 这类跨项目问题答不了。本用例锁：① 横向汇总各项目计划进度与逾期步骤；
 * ② onlyAttention 只留有症候的项目；③ includeClosed 才带出终态计划；
 * ④ 点名项目即收窄范围；⑤ 项目停滞阈值判定。
 */
const tmpDirs: string[] = [];

/** 造一个带 .butler/plans.json 的临时项目，路径即本工具要扫的 root */
async function makeProject(id: string, name: string, plans: unknown[]): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-overview-'));
  tmpDirs.push(dir);
  await mkdir(join(dir, '.butler'), { recursive: true });
  await writeFile(join(dir, '.butler', 'plans.json'), JSON.stringify({ plans }, null, 2), 'utf-8');
  return { id, name, path: dir, created_at: '2026-10-01T00:00:00.000Z', last_accessed_at: '2026-10-01T00:00:00.000Z' };
}

function planFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-fix',
    title: '诉讼推进',
    status: 'active',
    milestones: [
      {
        id: 'ms-fix',
        title: '执行',
        status: 'active',
        steps: [
          { id: 'st-over', title: '逾期步骤', status: 'pending', due: '2020-01-01' },
          { id: 'st-open', title: '未完成步骤', status: 'pending' },
          { id: 'st-done', title: '已完成步骤', status: 'done', due: '2020-01-01' },
        ],
      },
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

describe('跨项目计划总览：project_plans_overview', () => {
  beforeEach(() => {
    projectEvents.emitProjectsChanged.mockClear();
    projectEvents.emitProjectSwitched.mockClear();
    resetProjectManagerMocks();
    activityMock.getProjectLastActivityAt.mockReset();
    activityMock.getProjectLastActivityAt.mockResolvedValue(null);
  });

  afterEach(async () => {
    for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('横向汇总：各项目计划进度 + 逾期步骤（已完成步骤虽有 due 不算逾期）', async () => {
    const a = await makeProject('proj-a', 'A 项目', [planFixture()]);
    const b = await makeProject('proj-b', 'B 项目', []);
    projectManager.listProjects.mockResolvedValue({
      projects: [a, b],
      active_projects: [a, b],
      archived_projects: [],
      trashed_projects: [],
      currentId: 'proj-a',
    });

    const parsed = await run('project_plans_overview', {});
    expect(parsed.totals).toMatchObject({ projects: 2, openPlans: 1, overdueSteps: 1 });
    const projects = parsed.projects as Array<Record<string, unknown>>;
    const pa = projects.find((p) => p.id === 'proj-a')!;
    const pb = projects.find((p) => p.id === 'proj-b')!;
    expect(pa.overdueSteps).toBe(1);
    expect(pa.openPlans).toBe(1);
    const plan = (pa.plans as Array<Record<string, unknown>>)[0];
    expect(plan).toMatchObject({ steps: 3, done: 1, title: '诉讼推进' });
    expect((plan.overdue as Array<Record<string, unknown>>)[0]).toMatchObject({ step: '逾期步骤', daysOverdue: expect.any(Number) });
    // 无计划的项目也要出现（否则「哪些项目没有计划」看不见）
    expect(pb.planCount).toBe(0);
    expect(pb.plans).toBe('no-plans');
  });

  it('includeClosed：默认只算进行中；带该参数才列出终态计划', async () => {
    const a = await makeProject('proj-a', 'A 项目', [
      planFixture({ id: 'plan-open', title: '进行中的', status: 'active' }),
      planFixture({ id: 'plan-done', title: '已完成的', status: 'done' }),
    ]);
    projectManager.listProjects.mockResolvedValue({
      projects: [a], active_projects: [a], archived_projects: [], trashed_projects: [], currentId: 'proj-a',
    });

    const defaultParsed = await run('project_plans_overview', {});
    const openOnly = (defaultParsed.projects as Array<Record<string, unknown>>)[0].plans as Array<Record<string, unknown>>;
    expect(openOnly.map((p) => p.id)).toEqual(['plan-open']);

    const all = await run('project_plans_overview', { includeClosed: true });
    const shown = (all.projects as Array<Record<string, unknown>>)[0].plans as Array<Record<string, unknown>>;
    expect(shown.map((p) => p.id).sort()).toEqual(['plan-done', 'plan-open']);
  });

  it('onlyAttention：只留有逾期或停滞的项目', async () => {
    const quiet = await makeProject('proj-quiet', '安静项目', [planFixture({ id: 'plan-ok', milestones: [{ id: 'ms', title: 'M', status: 'active', steps: [{ id: 's', title: '无期限', status: 'pending' }] }] })]);
    const loud = await makeProject('proj-loud', '警报项目', [planFixture({ id: 'plan-over' })]);
    projectManager.listProjects.mockResolvedValue({
      projects: [quiet, loud], active_projects: [quiet, loud], archived_projects: [], trashed_projects: [], currentId: 'proj-quiet',
    });

    const parsed = await run('project_plans_overview', { onlyAttention: true });
    const ids = (parsed.projects as Array<Record<string, unknown>>).map((p) => p.id);
    expect(ids).toEqual(['proj-loud']);
    expect(parsed.totals).toMatchObject({ projects: 2, projectsNeedingAttention: 1 });
  });

  it('stalled：项目最近活动早于阈值 → stalledDays 记录且纳入 needsAttention', async () => {
    const a = await makeProject('proj-a', 'A 项目', []);
    projectManager.listProjects.mockResolvedValue({
      projects: [a], active_projects: [a], archived_projects: [], trashed_projects: [], currentId: 'proj-a',
    });
    activityMock.getProjectLastActivityAt.mockResolvedValue({ at: '2026-09-01T00:00:00.000Z', kind: 'note' });

    const parsed = await run('project_plans_overview', { stalledDays: 14 });
    const pa = (parsed.projects as Array<Record<string, unknown>>)[0];
    expect(pa.needsAttention).toBe(true);
    expect(pa.stalledDays as number).toBeGreaterThanOrEqual(14);
  });

  it('点名项目：收窄为单个项目；找不到 → project_not_found', async () => {
    const a = await makeProject('proj-a', 'A 项目', [planFixture()]);
    const b = await makeProject('proj-b', 'B 项目', []);
    projectManager.listProjects.mockResolvedValue({
      projects: [a, b], active_projects: [a, b], archived_projects: [], trashed_projects: [], currentId: 'proj-a',
    });

    const scoped = await run('project_plans_overview', { project: 'B 项目' });
    expect((scoped.projects as Array<Record<string, unknown>>).map((p) => p.id)).toEqual(['proj-b']);
    expect(scoped.totals).toMatchObject({ projects: 1, openPlans: 0 });

    const missing = await run('project_plans_overview', { project: '查无此项目' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe('project_not_found');
  });
});
