import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('@/lib/project/project-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project/project-manager')>();
  return { ...actual, ...projectManager };
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

describe('管家 create_project：make_current 的界面同步口径', () => {
  beforeEach(() => {
    projectEvents.emitProjectsChanged.mockClear();
    projectEvents.emitProjectSwitched.mockClear();
    projectEvents.hasProjectsChangedListeners.mockClear();
    projectEvents.hasProjectsChangedListeners.mockReturnValue(true);
    projectManager.createProject.mockReset();
    projectManager.createProject.mockResolvedValue(NEW_PROJECT);
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
});
