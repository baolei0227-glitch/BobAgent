/**
 * moveTodoOwnership（todo_update 的归属迁移）回归（方案 A）。
 *
 * 场景：未立项的临时待办先落在全局 Todo Inbox；立项后要把它归入项目（或移回 Inbox）。
 * 迁移是归属改写而非重建，必须：
 *   - 改事件 project_id / scope，并把标题后缀换成目标项目；
 *   - 把便签行从源便签文件迁到目标（保留行文本与事件锚点）、把 source_ref 重指向新行；
 *   - 同归属再迁 → 幂等（不重复成行）。
 *
 * 隔离：db 用内存假实现（vi.mock），便签文件用真实临时目录，项目解析走 mock。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const H = vi.hoisted(() => ({
  appRoot: '',
  projectDir: '',
  row: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    getCalendarDb: async () => ({ prepare: () => ({ get: () => undefined, all: () => [] }) }),
    getEvent: async (_db: unknown, id: string) => (H.row && H.row.event_id === id ? H.row : null),
    updateEvent: async (_db: unknown, id: string, patch: Record<string, unknown>) => {
      if (H.row && H.row.event_id === id) Object.assign(H.row, patch);
    },
    createEvent: async () => 'ev-new',
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

const NOTE_ID = 'sn-inbox';
const PAGE_ID = 'pg-inbox';
const EV_ID = 'ev-1';

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
  if (!existsSync(stickyPath(dir))) return [];
  return (JSON.parse(readFileSync(stickyPath(dir), 'utf-8')) as { notes: Array<Record<string, unknown>> }).notes;
}

/** Inbox 侧：一张带事件锚点的临时待办便签 */
function seedInbox(): void {
  writeSticky(H.appRoot, [
    {
      id: NOTE_ID,
      x: 0,
      y: 0,
      color: 'yellow',
      title: 'Todo Inbox',
      pages: [{ id: PAGE_ID, title: 'P1', content: '- [ ] 临时待办', lineEventIds: [[EV_ID]], lineCalendared: [true] }],
      activePageId: PAGE_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
}

/** 项目侧：一张带事件锚点的便签 */
function seedProject(): void {
  writeSticky(H.projectDir, [
    {
      id: 'sn-proj',
      x: 0,
      y: 0,
      color: 'yellow',
      title: '项目 A',
      pages: [{ id: 'pg-proj', title: 'P1', content: '- [ ] 临时待办', lineEventIds: [[EV_ID]], lineCalendared: [true] }],
      activePageId: 'pg-proj',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
}

beforeAll(() => {
  prevHome = process.env.BOBWORK_HOME;
  root = mkdtempSync(join(tmpdir(), 'todo-move-'));
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
  H.row = null;
});

describe('moveTodoOwnership：Inbox → 项目', () => {
  it('改事件归属 + 迁移便签行（保留文本与事件锚点，重指向 source_ref）', async () => {
    seedInbox();
    H.row = {
      event_id: EV_ID,
      project_id: '__global__',
      scope: 'global',
      title: '临时待办',
      status: 'scheduled',
      source_ref: JSON.stringify({ kind: 'sticky', noteId: NOTE_ID, pageId: PAGE_ID }),
    };
    const { moveTodoOwnership } = await import('@/lib/butler/todo-move');
    const res = await moveTodoOwnership({ eventId: EV_ID, target: '项目 A' });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('项目 A');

    // 事件归属改写
    expect(H.row!.project_id).toBe('projA');
    expect(H.row!.scope).toBe('project');
    expect(H.row!.title).toBe('临时待办_项目 A');

    // 目标便签出现一行且带事件锚点
    const projNotes = readSticky(H.projectDir);
    expect(projNotes).toHaveLength(1);
    const projPage = (projNotes[0].pages as Array<Record<string, unknown>>)[0];
    expect(String(projPage.content)).toContain('临时待办');
    expect(projPage.lineEventIds).toEqual([[EV_ID]]);
    // source_ref 重指向目标便签行
    const ref = JSON.parse(String(H.row!.source_ref)) as { noteId: string; pageId: string };
    expect(ref.noteId).toBe(projNotes[0].id);
    expect(ref.pageId).toBe(projPage.id);

    // Inbox 便签已清空 → 整张移除
    expect(readSticky(H.appRoot)).toEqual([]);
  });

  it('同归属再次迁移 → 幂等（不重复成行）', async () => {
    seedInbox();
    H.row = {
      event_id: EV_ID,
      project_id: '__global__',
      scope: 'global',
      title: '临时待办',
      status: 'scheduled',
      source_ref: JSON.stringify({ kind: 'sticky', noteId: NOTE_ID, pageId: PAGE_ID }),
    };
    const { moveTodoOwnership } = await import('@/lib/butler/todo-move');
    await moveTodoOwnership({ eventId: EV_ID, target: '项目 A' });
    const before = (readSticky(H.projectDir)[0].pages as Array<Record<string, unknown>>).length;
    const res = await moveTodoOwnership({ eventId: EV_ID, target: '项目 A' });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('已属于');
    const after = (readSticky(H.projectDir)[0].pages as Array<Record<string, unknown>>).length;
    expect(after).toBe(before);
  });

  it('项目 → Inbox（"inbox" 别名）：事件回全局、行回 Inbox', async () => {
    seedProject();
    H.row = {
      event_id: EV_ID,
      project_id: 'projA',
      scope: 'project',
      title: '临时待办_项目 A',
      status: 'scheduled',
      source_ref: JSON.stringify({ kind: 'sticky', noteId: 'sn-proj', pageId: 'pg-proj' }),
    };
    const { moveTodoOwnership } = await import('@/lib/butler/todo-move');
    const res = await moveTodoOwnership({ eventId: EV_ID, target: 'inbox' });
    expect(res.ok).toBe(true);
    expect(H.row!.project_id).toBe('__global__');
    expect(H.row!.scope).toBe('global');
    expect(H.row!.title).toBe('临时待办');

    // 行回落到 Inbox 便签
    const inboxNotes = readSticky(H.appRoot);
    expect(inboxNotes.length).toBeGreaterThan(0);
    const inboxPage = (inboxNotes[0].pages as Array<Record<string, unknown>>)[0];
    expect(String(inboxPage.content)).toContain('临时待办');
    // 源项目便签被清空移除
    expect(readSticky(H.projectDir)).toEqual([]);
  });
});
