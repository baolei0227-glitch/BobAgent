/**
 * 便签行入日历的「归属口径」回归（方案 A）：
 *   - Inbox 行（projectId='__global__'）→ 事件 project_id='__global__' + scope='global'，标题不带项目后缀；
 *   - 项目行 → 事件 project_id=项目 id + scope='project'，标题带 `_项目名` 后缀；
 *   - 全局事件的反向落回 → 指向 Inbox（app root）便签，不再因 project_id='__global__' 而被丢弃。
 *
 * 隔离：db 用内存假实现（vi.mock，只捕获 createEvent 入参 + 桩掉 dedupe 查询）；
 * 便签文件用真实临时目录；项目解析走 mock。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StickyNote } from '@/app/api/sticky-notes/route';

/** 捕获 createEvent 入参 */
const H = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>>, appRoot: '', projectDir: '' }));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    getCalendarDb: async () => ({ prepare: () => ({ get: () => undefined, all: () => [] }) }),
    createEvent: async (_db: unknown, data: Record<string, unknown>) => {
      H.created.push(data);
      return 'ev-new';
    },
    updateEvent: async () => {},
    getEvent: async () => null,
  };
});

vi.mock('@/lib/project/project-manager', () => ({
  getProjectById: async (id: string) => {
    if (id === 'projA') return { id: 'projA', name: '项目 A', path: H.projectDir };
    throw new Error('NO_PROJECT');
  },
  getCurrentProject: async () => ({ id: 'projA', name: '项目 A', path: H.projectDir }),
  listProjects: async () => ({
    projects: [{ id: 'projA', name: '项目 A', path: H.projectDir }],
    active_projects: [{ id: 'projA', name: '项目 A', path: H.projectDir }],
    archived_projects: [],
    trashed_projects: [],
    currentId: 'projA',
  }),
}));

let prevHome: string | undefined;
let root = '';

function stickyPath(dir: string): string {
  return join(dir, 'sticky-notes', 'sticky-notes.json');
}
function writeSticky(dir: string, notes: unknown[]): void {
  mkdirSync(join(dir, 'sticky-notes'), { recursive: true });
  writeFileSync(stickyPath(dir), JSON.stringify({ notes }, null, 2), 'utf-8');
}
function readSticky(dir: string): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(stickyPath(dir), 'utf-8')) as { notes: Array<Record<string, unknown>> }).notes;
}

/** 造一张单页便签（行文本待办） */
function mkNote(id: string, pageId: string, content: string): StickyNote {
  return {
    id,
    x: 0,
    y: 0,
    color: 'yellow',
    pages: [{ id: pageId, title: 'P1', content }],
    activePageId: pageId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeAll(() => {
  prevHome = process.env.BOBWORK_HOME;
  root = mkdtempSync(join(tmpdir(), 'sticky-cal-inbox-'));
  H.appRoot = join(root, 'app');
  H.projectDir = join(root, 'projA');
  mkdirSync(H.appRoot, { recursive: true });
  mkdirSync(H.projectDir, { recursive: true });
  process.env.BOBWORK_HOME = H.appRoot;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.BOBWORK_HOME;
  else process.env.BOBWORK_HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  H.created.length = 0;
});

describe('addStickyLineToCalendar 归属口径', () => {
  it('Inbox 行 → 全局事件（project_id __global__ + scope global，标题无项目后缀）', async () => {
    const { addStickyLineToCalendar } = await import('@/lib/sticky-calendar-sync');
    await addStickyLineToCalendar('__global__', mkNote('sn-i', 'pg-i', '- [ ] 临时待办'), 'pg-i', 0);
    expect(H.created).toHaveLength(1);
    expect(H.created[0].project_id).toBe('__global__');
    expect(H.created[0].scope).toBe('global');
    expect(H.created[0].title).toBe('临时待办');
  });

  it('项目行 → 项目事件（scope project，标题带 _项目名 后缀）', async () => {
    const { addStickyLineToCalendar } = await import('@/lib/sticky-calendar-sync');
    await addStickyLineToCalendar('projA', mkNote('sn-p', 'pg-p', '- [ ] 临时待办'), 'pg-p', 0);
    expect(H.created).toHaveLength(1);
    expect(H.created[0].project_id).toBe('projA');
    expect(H.created[0].scope).toBe('project');
    expect(H.created[0].title).toBe('临时待办_项目 A');
  });
});

describe('pushCalendarEventToSticky：全局事件反向落回 Inbox 便签', () => {
  it('project_id=__global__ 的事件改标题 → 落到 app root 便签行（applied=true）', async () => {
    writeSticky(H.appRoot, [
      {
        id: 'sn-i',
        x: 0,
        y: 0,
        color: 'yellow',
        title: 'Todo Inbox',
        pages: [{ id: 'pg-i', title: 'P1', content: '- [ ] 旧文本', lineEventIds: [['ev-1']], lineCalendared: [true] }],
        activePageId: 'pg-i',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const { pushCalendarEventToSticky } = await import('@/lib/sticky-calendar-sync');
    const res = await pushCalendarEventToSticky({
      event_id: 'ev-1',
      project_id: '__global__',
      scope: 'global',
      title: '新标题',
      status: 'scheduled',
      source_ref: JSON.stringify({ kind: 'sticky', noteId: 'sn-i', pageId: 'pg-i' }),
    } as never);
    expect(res.applied).toBe(true);
    const page = (readSticky(H.appRoot)[0].pages as Array<Record<string, unknown>>)[0];
    expect(String(page.content)).toContain('新标题');
  });
});
