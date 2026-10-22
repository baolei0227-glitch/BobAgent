/**
 * resolveStickyScope —— 便签落点收口（项目 / 全局 Todo Inbox）回归。
 *
 * 归口规则（方案 A：归口 + 聚合，不新增第四套体系）：
 *   有效 project_id → 项目；Inbox 哨兵（__inbox__ / __global__）→ 全局 Inbox；
 *   未指定 → 当前激活项目；无激活项目 → 全局 Inbox（不再抛 NO_PROJECT）。
 * 日历事件口径：Inbox 行 → project_id '__global__' + scope 'global'；项目 → 项目 id + 'project'。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** 可变依赖状态：切换「是否有激活项目」以覆盖 Inbox 兜底分支 */
const H = vi.hoisted(() => ({ hasCurrent: true }));

vi.mock('@/lib/project/project-manager', () => {
  const projA = { id: 'projA', name: '项目 A', path: '/tmp/proj-a' };
  return {
    getProjectById: async (id: string) => {
      if (id === projA.id) return projA;
      throw new Error('NO_PROJECT');
    },
    getCurrentProject: async () => {
      if (!H.hasCurrent) throw new Error('NO_PROJECT');
      return projA;
    },
    listProjects: async () => ({
      projects: [projA],
      active_projects: [projA],
      archived_projects: [],
      trashed_projects: [],
      currentId: projA.id,
    }),
  };
});

import {
  resolveStickyScope,
  isInboxProjectId,
  isInboxRef,
  INBOX_PROJECT_ID,
  GLOBAL_SCOPE_PROJECT_ID,
  TODO_INBOX_NAME,
} from '@/lib/project/sticky-scope';

let prevHome: string | undefined;
beforeAll(() => {
  prevHome = process.env.BOBWORK_HOME;
  process.env.BOBWORK_HOME = '/tmp/bobwork-inbox-root';
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.BOBWORK_HOME;
  else process.env.BOBWORK_HOME = prevHome;
});

describe('resolveStickyScope 落点收口', () => {
  it('有效 project_id → 项目作用域（落点=项目路径，日历归属=项目 id）', async () => {
    const s = await resolveStickyScope('projA');
    expect(s).toEqual({
      root: '/tmp/proj-a',
      projectId: 'projA',
      projectName: '项目 A',
      isInbox: false,
      calendarProjectId: 'projA',
      calendarScope: 'project',
    });
  });

  it('Inbox 哨兵（__inbox__ / __global__）→ 全局 Inbox（app root + 全局日历口径）', async () => {
    for (const sentinel of [INBOX_PROJECT_ID, GLOBAL_SCOPE_PROJECT_ID]) {
      const s = await resolveStickyScope(sentinel);
      expect(s.isInbox).toBe(true);
      expect(s.root).toBe('/tmp/bobwork-inbox-root');
      expect(s.projectId).toBeNull();
      expect(s.projectName).toBe(TODO_INBOX_NAME);
      expect(s.calendarProjectId).toBe(GLOBAL_SCOPE_PROJECT_ID);
      expect(s.calendarScope).toBe('global');
    }
  });

  it('未指定 project_id 且有激活项目 → 当前激活项目', async () => {
    H.hasCurrent = true;
    const s = await resolveStickyScope();
    expect(s.isInbox).toBe(false);
    expect(s.projectId).toBe('projA');
  });

  it('未指定 project_id 且无激活项目 → 全局 Inbox（不再失败）', async () => {
    H.hasCurrent = false;
    const s = await resolveStickyScope();
    expect(s.isInbox).toBe(true);
    expect(s.root).toBe('/tmp/bobwork-inbox-root');
    H.hasCurrent = true;
  });

  it('无效 project_id → 回退当前项目（有激活项目时不抛错）', async () => {
    H.hasCurrent = true;
    const s = await resolveStickyScope('nope');
    expect(s.projectId).toBe('projA');
  });

  it('无效 project_id 且无激活项目 → 全局 Inbox', async () => {
    H.hasCurrent = false;
    const s = await resolveStickyScope('nope');
    expect(s.isInbox).toBe(true);
    H.hasCurrent = true;
  });

  it('isInboxProjectId 仅识别两个哨兵', () => {
    expect(isInboxProjectId(INBOX_PROJECT_ID)).toBe(true);
    expect(isInboxProjectId(GLOBAL_SCOPE_PROJECT_ID)).toBe(true);
    expect(isInboxProjectId('projA')).toBe(false);
    expect(isInboxProjectId(undefined)).toBe(false);
  });

  it('isInboxRef 只认「未立项」显式别名（空串 / 项目名 / 当前项目哨兵都不算）', () => {
    for (const ref of ['inbox', '  Inbox ', 'TODO INBOX', 'todo-inbox', INBOX_PROJECT_ID, GLOBAL_SCOPE_PROJECT_ID, '未立项', '收件箱']) {
      expect(isInboxRef(ref), ref).toBe(true);
    }
    for (const ref of ['', '   ', null, undefined, 'projA', 'current', '当前项目']) {
      expect(isInboxRef(ref), String(ref)).toBe(false);
    }
  });
});
