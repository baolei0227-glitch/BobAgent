import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { getCurrentProject, getProjectById } from '@/lib/project/project-manager';
import { writeTodoIndexFile, readTodoIndexFile, buildTodoIndex, MAX_TODO_NOTES, pickTodoNoteColor } from '@/lib/sticky-todo';
import { migrateStickyNotePages } from '@/lib/sticky-notes-migrate';
import { reconcileStickyNoteEvents, cancelNoteEvents } from '@/lib/sticky-calendar-sync';

/**
 * 画布便签（Sticky Notes）— 项目级纯私有便利贴
 *
 * 设计约束（与产品确认）：
 *  - 存 <项目根>/sticky-notes/sticky-notes.json（单文件存全部便签数组）
 *  - 不写入任何节点 .md，不接入 intern_search（AI 完全不可见）
 *  - 按项目隔离：project_id 指定项目，否则用当前激活项目
 *  - 2026-08：便签 note 模式（kind='note' 带编号笔记页）已停用，
 *    存量 note 页内容迁移到统一笔记库 wanted/notebook.json（见 lib/sticky-notes-migrate.ts），
 *    便签只保留 todo 勾选清单。笔记与项目完全独立：删除项目前也会兜底迁移。
 */

export type StickyNotePageKind = 'todo' | 'note';

export type StickyNotePage = {
  id: string;
  title: string;
  content: string;
  /** 页模式：todo=勾选清单（默认）/ note=带编号的笔记行 */
  kind?: StickyNotePageKind;
  /** note 模式下的编号前缀模板，默认 "1."（渲染时按序号替换数字）；支持 "1." / "1)" / "(1)" / "一、" 等 */
  numberStyle?: string;
  /** 每行待办是否已添加到日历（与 content 行序对齐；true = 该行按钮显示闹钟图标） */
  lineCalendared?: boolean[];
  /** 每行待办已添加到日历的事件 id 列表（与 content 行序对齐；非空 = 已入日历，完成后按 id 精确标记完成） */
  lineEventIds?: string[][];
};

export type StickyNote = {
  id: string;
  x: number;
  y: number;
  color: string; // 'yellow' | 'blue' | 'green' | 'pink'
  /** @deprecated 便签类型：'note' 仅存于历史数据（系统笔记便签已停用），新数据一律为 todo */
  kind?: 'todo' | 'note';
  title?: string;
  /** @deprecated 兼容老数据：新数据存 pages[i].content 并通过 activePageId 寻址 */
  content?: string;
  pages?: StickyNotePage[];
  activePageId?: string;
  createdAt: string;
  updatedAt: string;
  width?: number;
  height?: number;
  sidebarCollapsed?: boolean;
  /** 置顶层级（越大越靠上；右键置顶时递增并持久化） */
  z?: number;
};

const STICKY_DIR = 'sticky-notes';
const STICKY_FILE = 'sticky-notes.json';

/** 解析目标项目目录：优先 project_id，其次当前激活项目 */
async function resolveProjectDir(projectId?: string): Promise<string> {
  if (projectId) {
    try {
      const p = await getProjectById(projectId);
      return p.path;
    } catch {
      // fallback 到当前项目
    }
  }
  const cur = await getCurrentProject();
  return cur.path;
}

/** 解析项目名（用于默认标题） */
async function resolveProjectName(projectId?: string): Promise<string> {
  try {
    if (projectId) {
      const p = await getProjectById(projectId);
      return p.name;
    }
    const cur = await getCurrentProject();
    return cur.name;
  } catch {
    return 'Untitled';
  }
}

/** 默认标题：项目名（不自动追加创建日期；项目名自带的后缀日期保持原样） */
function defaultTitle(projectName: string): string {
  return projectName;
}

async function readNotes(projectDir: string): Promise<StickyNote[]> {
  const fs = require('fs/promises');
  try {
    const raw = await fs.readFile(join(projectDir, STICKY_DIR, STICKY_FILE), 'utf-8');
    const data = JSON.parse(raw);
    const notes: StickyNote[] = Array.isArray(data?.notes) ? data.notes : [];
    // 内存兼容升级：老 content → pages[0]
    return notes.map(upgradeNotePages);
  } catch {
    return [];
  }
}

/** 原子写入：先写临时文件再 rename，避免半写状态；写完主文档后同步未完成待办索引（todo-index.json，供 /inspect 零全量扫描聚合） */
async function writeNotes(projectDir: string, notes: StickyNote[]): Promise<void> {
  const fs = require('fs/promises');
  const dir = join(projectDir, STICKY_DIR);
  await fs.mkdir(dir, { recursive: true });
  const target = join(dir, STICKY_FILE);
  // 临时文件用唯一名：并发写（面板新增/画布自动保存/AI 工具）共用固定 tmp 名会互相踩踏
  // 导致"写→rename"后执行的写入方 ENOENT 失败（画布表现为"自动保存失败"）
  const tmp = join(dir, `.${STICKY_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ notes }, null, 2), 'utf-8');
  await fs.rename(tmp, target);
  // 索引同步失败不影响主文档写入（/inspect 会回退扫描主文档自愈）
  try {
    await writeTodoIndexFile(projectDir, notes);
  } catch (e) {
    console.error('[sticky-notes] 待办索引同步失败:', e);
  }
}

function newId(): string {
  return `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function newPageId(): string {
  return `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 统一默认的 note 模式编号模板 */
const DEFAULT_NUMBER_STYLE = '1.';

/** 升级一张便签的分页结构：老的 content → pages[0]，确保 pages/activePageId/kind/numberStyle 始终存在。
 *  为兼容存量：仅在内存返回时升级，不立即写盘（避免每次 GET 重写）；create/update 端会自然写回。
 */
export function upgradeNotePages(note: StickyNote): StickyNote {
  const normalizePage = (p: StickyNotePage): StickyNotePage => ({
    ...p,
    kind: p.kind === 'note' ? 'note' : 'todo',
    numberStyle: typeof p.numberStyle === 'string' && p.numberStyle.trim()
      ? p.numberStyle.trim()
      : DEFAULT_NUMBER_STYLE,
  });
  if (!Array.isArray(note.pages) || note.pages.length === 0) {
    const raw = typeof note.content === 'string' ? note.content : '';
    const firstPage: StickyNotePage = normalizePage({
      id: newPageId(),
      title: 'P1',
      content: raw.trim().length === 0 ? '- [ ] ' : raw,
    });
    return {
      ...note,
      pages: [firstPage],
      activePageId: firstPage.id,
      content: undefined,
    };
  }
  // pages 存在但 activePageId 缺失/失效 → 回退到第一个
  const valid = note.activePageId && note.pages.some((p) => p.id === note.activePageId);
  return {
    ...note,
    pages: note.pages.map(normalizePage),
    activePageId: valid ? note.activePageId! : note.pages[0].id,
    content: undefined,
  };
}

/**
 * 存量迁移（幂等）：扫描 <项目根>/notes-memory/*.md 中非空的 `## 便签` 区块，
 * 抽取为画布便签（落点贴在该节点右上方），写入 sticky-notes.json，并清空节点 .md 的便签区块。
 * 迁移后节点便签退场，便签统一由画布层管理（AI 不再可读，见 isReadablePath 排除）。
 */
async function migrateFromNodeMd(projectDir: string): Promise<{ migrated: number }> {
  const fs = require('fs/promises');
  const nodesDir = join(projectDir, 'notes-memory');
  let files: string[];
  try {
    files = await fs.readdir(nodesDir);
  } catch {
    return { migrated: 0 };
  }
  const mds = files.filter((f) => f.endsWith('.md') && f !== 'example_node.md');
  const existing = await readNotes(projectDir);
  let migrated = 0;
  const topZ = existing.reduce((m, n) => Math.max(m, n.z ?? 0), 0);

  for (const f of mds) {
    const fp = join(nodesDir, f);
    let content: string;
    try {
      content = await fs.readFile(fp, 'utf-8');
    } catch {
      continue;
    }
    // 便签区块（与前端 ChatNodeKernel 解析一致）
    const m = content.match(/## 便签\n([\s\S]*?)(?:\n##|\n*$)/);
    if (!m) continue;
    const lines = m[1]
      .split('\n')
      .map((l) => l.replace(/^-\s*/, '').trim())
      .filter(Boolean);
    if (lines.length === 0 || lines.join('') === '（暂无）') continue;

    const now = new Date().toISOString();
    const firstPage: StickyNotePage = {
      id: newPageId(),
      title: 'P1',
      content: lines.join('\n'),
      kind: 'todo',
      numberStyle: DEFAULT_NUMBER_STYLE,
    };
    // 便签已改为屏幕坐标固定，迁移落点放在屏幕可视区左上角附近并按数量错开
    const col = migrated % 4;
    existing.push({
      id: newId(),
      x: Math.round(120 + col * 24),
      y: Math.round(120 + col * 24),
      color: 'yellow',
      pages: [firstPage],
      activePageId: firstPage.id,
      createdAt: now,
      updatedAt: now,
      z: topZ + migrated + 1,
    });
    migrated++;

    // 清空节点 .md 便签区块（替换为"（暂无）"，精确替换不破坏其他区块）
    const updated = content.replace(/## 便签\n[\s\S]*?(?=\n##|\n*$)/, '## 便签\n（暂无）');
    await fs.writeFile(fp, updated, 'utf-8');
  }

  if (migrated > 0) await writeNotes(projectDir, existing);
  return { migrated };
}

/**
 * 迁移便签中的 note 页（kind='note'）到统一笔记库 notebook.json。
 * 实现与启动全量清扫见 src/lib/sticky-notes-migrate.ts（2026-08 便签 note 模式停用）。
 * 迁移入口：GET 惰性迁移（本文件）、deleteProject 删除前兜底、启动 sweepAllStickyNotePages。
 */

/** GET /api/sticky-notes?project_id=xxx → 返回该项目全部便签 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project_id') || undefined;
  const wantTodos = req.nextUrl.searchParams.get('todos') === '1';
  try {
    const dir = await resolveProjectDir(projectId);
    // 待办明细：读取该项目 Sticky 未完成待办索引（notes → pages → items 三级）
    if (wantTodos) {
      let index = await readTodoIndexFile(dir);
      if (!index) {
        // 索引缺失/损坏 → 回退扫描主文档构建（幂等自愈，与 /inspect 一致）
        await migrateStickyNotePages(dir);
        const notes = await readNotes(dir);
        index = buildTodoIndex(notes as Array<Record<string, unknown>>);
        try { await writeTodoIndexFile(dir, notes as Array<Record<string, unknown>>); } catch { /* 自愈写盘失败不阻断 */ }
      }
      return NextResponse.json({ success: true, todos: index });
    }
    // 惰性迁移：停用的便签 note 页 → notebook.json（幂等，无 note 页时零开销）
    await migrateStickyNotePages(dir);
    const notes = await readNotes(dir);
    return NextResponse.json({ success: true, notes });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}

/** POST /api/sticky-notes { action: 'create'|'update'|'delete', project_id?, note?, id? } */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const projectId = typeof body.project_id === 'string' ? body.project_id : undefined;
  const action = String(body.action || '');
  try {
    const dir = await resolveProjectDir(projectId);
    const notes = await readNotes(dir);

    if (action === 'create') {
      const note = (body.note ?? {}) as Partial<StickyNote>;
      // 每项目最多三张待办便签：已满三张时不新建，返回已有便签由前端聚焦（limited=true）
      if (notes.length >= MAX_TODO_NOTES) {
        return NextResponse.json({ success: true, note: upgradeNotePages(notes[0]), limited: true, kind: 'todo' });
      }
      const initialContent = typeof note.content === 'string' && note.content.length > 0
        ? note.content
        : '- [ ] ';
      const now = new Date().toISOString();
      const firstPage: StickyNotePage = {
        id: newPageId(),
        title: 'P1',
        content: initialContent,
        kind: 'todo',
      };
      const projectName = await resolveProjectName(projectId);
      const topZ = notes.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
      const created: StickyNote = {
        id: newId(),
        x: typeof note.x === 'number' ? note.x : 0,
        y: typeof note.y === 'number' ? note.y : 0,
        color: pickTodoNoteColor(notes, note.color),
        kind: 'todo',
        title: typeof note.title === 'string' && note.title.trim() ? note.title : defaultTitle(projectName),
        pages: [firstPage],
        activePageId: firstPage.id,
        createdAt: now,
        updatedAt: now,
        width: typeof note.width === 'number' ? note.width : undefined,
        height: typeof note.height === 'number' ? note.height : undefined,
        sidebarCollapsed:
          typeof note.sidebarCollapsed === 'boolean' ? note.sidebarCollapsed : true,
        z: topZ + 1,
      };
      notes.push(created);
      // 前向打通：新建便签的待办行自动入日历（创建事件并写回 lineEventIds；失败不阻断便签落盘）
      let persisted: StickyNote = created;
      try {
        const effProjectId = projectId || (await getCurrentProject()).id;
        persisted = await reconcileStickyNoteEvents(effProjectId, created);
        notes[notes.length - 1] = persisted;
      } catch (e) {
        console.error('[sticky-notes] create 自动入日历失败:', e);
      }
      await writeNotes(dir, notes);
      return NextResponse.json({ success: true, note: persisted });
    }

    if (action === 'update') {
      const note = (body.note ?? {}) as Partial<StickyNote>;
      if (typeof note.id !== 'string' || !note.id) {
        return NextResponse.json({ success: false, error: 'note.id required' }, { status: 400 });
      }
      const idx = notes.findIndex((n) => n.id === note.id);
      if (idx < 0) {
        return NextResponse.json({ success: false, error: 'note not found' }, { status: 404 });
      }
      const base = notes[idx];
      const updated: StickyNote = {
        ...base,
        ...(typeof note.x === 'number' ? { x: note.x } : {}),
        ...(typeof note.y === 'number' ? { y: note.y } : {}),
        ...(typeof note.color === 'string' ? { color: note.color } : {}),
        ...(typeof note.title === 'string' ? { title: note.title } : {}),
        ...(typeof note.width === 'number' ? { width: note.width } : {}),
        ...(typeof note.height === 'number' ? { height: note.height } : {}),
        ...(typeof note.sidebarCollapsed === 'boolean'
          ? { sidebarCollapsed: note.sidebarCollapsed }
          : {}),
        ...(typeof note.z === 'number' ? { z: note.z } : {}),
        ...(Array.isArray(note.pages) ? { pages: note.pages } : {}),
        ...(typeof note.activePageId === 'string' ? { activePageId: note.activePageId } : {}),
        // 兼容旧 content patch：找到 activePage 把内容写进去
        ...(typeof note.content === 'string' && base.pages && base.activePageId
          ? {
              pages: base.pages.map((p) =>
                p.id === base.activePageId ? { ...p, content: note.content! } : p,
              ),
            }
          : {}),
        content: undefined,
        updatedAt: new Date().toISOString(),
      };
      const prevNote = notes[idx];
      const nextNote = upgradeNotePages(updated);
      // 前向打通：便签行增删改/勾选 → 自动同步日历事件（增量 reconcile；失败不阻断便签落盘）
      let persisted: StickyNote = nextNote;
      try {
        const effProjectId = projectId || (await getCurrentProject()).id;
        persisted = await reconcileStickyNoteEvents(effProjectId, nextNote, prevNote);
      } catch (e) {
        console.error('[sticky-notes] update 自动同步日历失败:', e);
      }
      notes[idx] = persisted;
      await writeNotes(dir, notes);
      return NextResponse.json({ success: true, note: persisted });
    }

    if (action === 'delete') {
      const id = typeof body.id === 'string' ? body.id : (body.note as Partial<StickyNote> | undefined)?.id;
      if (typeof id !== 'string' || !id) {
        return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
      }
      const next = notes.filter((n) => n.id !== id);
      // 删除便签前：取消其全部关联日历事件（双向联动）
      const doomed = notes.find((n) => n.id === id);
      if (doomed) {
        await cancelNoteEvents(doomed).catch((e) =>
          console.error('[sticky-notes] delete 取消关联日历事件失败:', e),
        );
      }
      await writeNotes(dir, next);
      return NextResponse.json({ success: true });
    }

    if (action === 'migrate') {
      const res = await migrateFromNodeMd(dir);
      return NextResponse.json({ success: true, ...res });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
