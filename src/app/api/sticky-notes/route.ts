import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { promises as fs } from 'fs';
import { resolveStickyScope } from '@/lib/project/sticky-scope';
import { writeTodoIndexFile, readTodoIndexFile, buildTodoIndex, MAX_TODO_NOTES, pickTodoNoteColor, normalizeStickyNote } from '@/lib/sticky-todo';
import { migrateStickyNotePages } from '@/lib/sticky-notes-migrate';
import {
  reconcileStickyNoteEvents,
  cancelNoteEvents,
  addStickyLineToCalendar,
  autoAddStickyLinesToCalendar,
} from '@/lib/sticky-calendar-sync';

/**
 * 画布便签（Sticky Notes）— 项目级纯私有便利贴
 *
 * 设计约束（与产品确认）：
 *  - 存 <项目根>/sticky-notes/sticky-notes.json（单文件存全部便签数组）
 *  - 不写入任何节点 .md，不接入 intern_search（AI 完全不可见）
 *  - 落点由 lib/project/sticky-scope 统一收口：project_id 指定项目，Inbox 哨兵 / 未指定
 *    且无激活项目则落**全局 Inbox**（app root 的 sticky 文件，显示名 'Todo Inbox'）
 *  - 2026-08：便签 note 模式（kind='note' 带编号笔记页）已停用，
 *    存量 note 页内容迁移到统一笔记库 notes/（见 lib/sticky-notes-migrate.ts），
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
  /** 每行的计划来源标记（与 content 行序对齐，语义同 lineEventIds）：`${planId}/${stepId}`；
   *  仅系统「计划待办」便签（note.planTodos）使用，由 lib/project/plan-todo-sync 维护 */
  linePlanRefs?: string[][];
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
  /** 系统「计划待办」便签标记：每项目一张，由 plan → sticky 单向同步维护（lib/project/plan-todo-sync）；
   *  豁免 MAX_TODO_NOTES 上限，且不参与自动入日历 */
  planTodos?: boolean;
};

const STICKY_DIR = 'sticky-notes';
const STICKY_FILE = 'sticky-notes.json';

/** 默认标题：项目名（不自动追加创建日期；项目名自带的后缀日期保持原样） */
function defaultTitle(projectName: string): string {
  return projectName;
}

/** 把 update 类 patch 合并到既有便签（update 与 add_to_calendar 共用同一语义） */
function mergeNotePatch(base: StickyNote, note: Partial<StickyNote>): StickyNote {
  return {
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
}

async function readNotes(projectDir: string): Promise<StickyNote[]> {
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

/** 原子写入：先写临时文件再 rename，避免半写状态；写完主文档后同步未完成待办索引（todo-index.json，供 /inspect 零全量扫描聚合）。
 *  落盘前统一经 normalizeStickyNote 剔除空行（空行不是待办，见 lib/sticky-todo）。 */
async function writeNotes(projectDir: string, notes: StickyNote[]): Promise<void> {
  const dir = join(projectDir, STICKY_DIR);
  await fs.mkdir(dir, { recursive: true });
  const target = join(dir, STICKY_FILE);
  const normalized = notes.map((n) =>
    normalizeStickyNote(n as unknown as Record<string, unknown>) as unknown as StickyNote,
  );
  // 临时文件用唯一名：并发写（面板新增/画布自动保存/AI 工具）共用固定 tmp 名会互相踩踏
  // 导致"写→rename"后执行的写入方 ENOENT 失败（画布表现为"自动保存失败"）
  const tmp = join(dir, `.${STICKY_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ notes: normalized }, null, 2), 'utf-8');
  await fs.rename(tmp, target);
  // 索引同步失败不影响主文档写入（/inspect 会回退扫描主文档自愈）
  try {
    await writeTodoIndexFile(projectDir, normalized);
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
      content: raw.trim().length === 0 ? '' : raw,
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
    // 落点收口：project_id 有效 → 该项目；Inbox 哨兵 / 未指定且无激活项目 → 全局 Inbox
    const dir = (await resolveStickyScope(projectId)).root;
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
    let notes = await readNotes(dir);
    // 存量空行幂等清扫：读取即归一化（剔除空待办行），有变化则落盘一次，之后稳定
    const cleaned = notes.map((n) =>
      normalizeStickyNote(n as unknown as Record<string, unknown>) as unknown as StickyNote,
    );
    if (JSON.stringify(cleaned) !== JSON.stringify(notes)) {
      try {
        await writeNotes(dir, cleaned);
      } catch {
        /* 清扫失败不阻断读取 */
      }
      notes = cleaned;
    }
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
    // 落点 + 归属收口：项目便签 或 全局 Inbox（未立项临时待办）；日历事件归属由 scope.calendarProjectId 决定
    const scope = await resolveStickyScope(projectId);
    const dir = scope.root;
    const notes = await readNotes(dir);

    if (action === 'create') {
      const note = (body.note ?? {}) as Partial<StickyNote>;
      // 每项目最多三张「用户自己的」待办便签：已满三张时不新建，返回已有便签由前端聚焦（limited=true）。
      // 系统「计划待办」便签（planTodos，由 plan→sticky 同步直写）不占用该配额，也不参与配色挑选。
      const userNotes = notes.filter((n) => !n.planTodos);
      if (userNotes.length >= MAX_TODO_NOTES) {
        return NextResponse.json({ success: true, note: upgradeNotePages(userNotes[0]), limited: true, kind: 'todo' });
      }
      const initialContent = typeof note.content === 'string' && note.content.length > 0
        ? note.content
        : '';
      const now = new Date().toISOString();
      const firstPage: StickyNotePage = {
        id: newPageId(),
        title: 'P1',
        content: initialContent,
        kind: 'todo',
      };
      const projectName = scope.projectName;
      const topZ = notes.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
      const created: StickyNote = {
        id: newId(),
        x: typeof note.x === 'number' ? note.x : 0,
        y: typeof note.y === 'number' ? note.y : 0,
        color: pickTodoNoteColor(userNotes, note.color),
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
      // 新建时只落便签文本：行的自动入日历发生在之后的「结算」保存
      // （update 且 settle_auto_calendar !== false，见 autoAddStickyLinesToCalendar）。
      await writeNotes(dir, notes);
      return NextResponse.json({ success: true, note: created });
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
      const prevNote = notes[idx];
      const nextNote = upgradeNotePages(mergeNotePatch(base, note as Partial<StickyNote>));
      // 同步已入日历的行（改文本→改事件标题、勾选→完成、删行→取消）；
      // 未入日历的未完成行自动补建事件只在「结算」时做：客户端打字过程中的防抖落盘带
      // settle_auto_calendar=false（只存内容），避免半截文本被建成事件；失焦/停手 8 秒/结构性操作才结算。
      const settleAuto = body.settle_auto_calendar !== false;
      let persisted: StickyNote = nextNote;
      let autoTouched = 0;
      // 本次结算时自动入日历检测到的重叠（2026-09-25）：详情已写进事件备注，
      // 这里一并回传，供前端提示与排查「为什么这条排到了拥挤的时段」。
      let calendarConflicts: { count: number; titles: string[] } = { count: 0, titles: [] };
      try {
        const effProjectId = scope.calendarProjectId;
        persisted = await reconcileStickyNoteEvents(effProjectId, nextNote, prevNote);
        if (settleAuto) {
          const auto = await autoAddStickyLinesToCalendar(effProjectId, persisted);
          persisted = auto.note;
          autoTouched = auto.created + auto.rescheduled;
          calendarConflicts = { count: auto.conflicts, titles: auto.conflictTitles };
        }
      } catch (e) {
        console.error('[sticky-notes] update 同步日历失败:', e);
      }
      notes[idx] = persisted;
      await writeNotes(dir, notes);
      // 自动入日历确实新建或重排了事件时才即改即推远端日历（与手动 add_to_calendar 一致，免等轮询）
      if (autoTouched > 0) {
        try {
          const { syncAllAccounts } = await import('@/lib/calendar/sync-runner');
          void syncAllAccounts().catch((e) =>
            console.error('[sticky-notes] update 远端同步失败:', e),
          );
        } catch {
          /* 远端同步失败不阻断便签保存 */
        }
      }
      return NextResponse.json({
        success: true,
        note: persisted,
        ...(calendarConflicts.count > 0 ? { calendar_conflicts: calendarConflicts } : {}),
      });
    }

    if (action === 'add_to_calendar') {
      const noteId =
        typeof body.note_id === 'string'
          ? body.note_id
          : (body.note as Partial<StickyNote> | undefined)?.id;
      const pageId = typeof body.page_id === 'string' ? body.page_id : '';
      const lineIndex = Number(body.line_index);
      if (typeof noteId !== 'string' || !noteId || !pageId || !Number.isInteger(lineIndex) || lineIndex < 0) {
        return NextResponse.json({ success: false, error: 'note_id / page_id / line_index required' }, { status: 400 });
      }
      const idx = notes.findIndex((n) => n.id === noteId);
      if (idx < 0) {
        return NextResponse.json({ success: false, error: 'note not found' }, { status: 404 });
      }
      // 手动入日历：先把调用方带来的最新行文本合并进便签（StickyTodoDock 行文本走防抖落盘，
      // 点击时可能尚未保存），再在该行建事件并写回锚点 —— 单事务内完成，避免「先存文本再建事件」竞态
      const merged = upgradeNotePages(
        mergeNotePatch(notes[idx], (body.note ?? {}) as Partial<StickyNote>),
      );
      const effProjectId = scope.calendarProjectId;
      const text = typeof body.text === 'string' ? body.text : undefined;
      const startTime = typeof body.start_time === 'string' && body.start_time.trim() ? body.start_time.trim() : null;
      const endTime = typeof body.end_time === 'string' && body.end_time.trim() ? body.end_time.trim() : null;
      const reminderRaw = body.reminder_minutes;
      const reminderMinutes =
        Array.isArray(reminderRaw) && reminderRaw.every((x) => typeof x === 'number')
          ? (reminderRaw as number[])
          : undefined;
      // 开庭等紧要事项：调用方（C 表单）传 priority='high' → 事件带红色标旗
      const priorityRaw = body.priority;
      const priority =
        priorityRaw === 'high' || priorityRaw === 'normal' || priorityRaw === 'low'
          ? priorityRaw
          : undefined;
      // 地点：显式传入优先（缺省时由 sync 层从行文本尾部「地址：XXX」自动提取）
      const locationRaw = body.location;
      const location = typeof locationRaw === 'string' && locationRaw.trim() ? locationRaw.trim() : null;
      const { note: persisted } = await addStickyLineToCalendar(
        effProjectId,
        merged,
        pageId,
        lineIndex,
        text,
        { start_time: startTime, end_time: endTime, reminder_minutes: reminderMinutes, location, priority },
      );
      notes[idx] = persisted;
      await writeNotes(dir, notes);
      // 即改即推：新事件立即同步到远端日历（与 /api/calendar/events 新建路径一致，免等轮询）
      try {
        const { syncAllAccounts } = await import('@/lib/calendar/sync-runner');
        void syncAllAccounts().catch((e) =>
          console.error('[sticky-notes] add_to_calendar 远端同步失败:', e),
        );
      } catch {
        /* 远端同步失败不阻断手动入日历成功返回 */
      }
      return NextResponse.json({
        success: true,
        note: persisted,
        event_ids: persisted.pages?.find((p) => p.id === pageId)?.lineEventIds?.[lineIndex] ?? [],
      });
    }

    /**
     * 勾选 / 取消勾选某一行便签待办（日报 Sticky 页的「点击完成」走这里）。
     * 只改这一行的 `- [x]` / `- [ ]`，随后跑一次前向 reconcile：该行已入日历 → 事件状态随之
     * done / scheduled（双向链路的便签侧）；日历侧的改动仍由 /api/calendar/events 的 PATCH
     * 反向落回便签行（pushCalendarEventToSticky）。
     * line_index 是报告生成时的行号，用户事后编辑过便签会漂移 → 文本对不上时按文本回退定位。
     */
    if (action === 'toggle_line') {
      const noteId = typeof body.note_id === 'string' ? body.note_id : '';
      const pageId = typeof body.page_id === 'string' ? body.page_id : '';
      const lineIndex = Number(body.line_index);
      const done = body.done === true;
      if (!noteId || !pageId || !Number.isInteger(lineIndex) || lineIndex < 0) {
        return NextResponse.json({ success: false, error: 'note_id / page_id / line_index required' }, { status: 400 });
      }
      const idx = notes.findIndex((n) => n.id === noteId);
      if (idx < 0) {
        return NextResponse.json({ success: false, error: 'note not found' }, { status: 404 });
      }
      const prevNote = notes[idx];
      const page = (prevNote.pages ?? []).find((p) => p.id === pageId);
      if (!page || page.kind === 'note') {
        return NextResponse.json({ success: false, error: 'page not found or not a todo page' }, { status: 404 });
      }
      const rawLines = String(page.content ?? '').split('\n');
      /** 取某行的待办文本（去掉 `- [ ]` 前缀），供行号漂移时按文本比对 */
      const lineText = (i: number): string => {
        const m = (rawLines[i] ?? '').match(/^-\s*\[( |x)\]\s*(.*)$/);
        return (m ? m[2] : (rawLines[i] ?? '')).trim();
      };
      const wantText = typeof body.text === 'string' ? body.text.trim() : '';
      let at = lineIndex < rawLines.length ? lineIndex : -1;
      if (wantText && (at < 0 || lineText(at) !== wantText)) {
        at = rawLines.findIndex((_, i) => lineText(i) === wantText);
      }
      if (at < 0) {
        return NextResponse.json({ success: false, error: 'todo line not found' }, { status: 404 });
      }
      rawLines[at] = `- [${done ? 'x' : ' '}] ${lineText(at)}`;
      const nextNote: StickyNote = {
        ...prevNote,
        pages: (prevNote.pages ?? []).map((p) =>
          p.id === pageId ? { ...p, content: rawLines.join('\n') } : p,
        ),
        updatedAt: new Date().toISOString(),
      };
      const effProjectId = scope.calendarProjectId;
      let persisted: StickyNote = nextNote;
      try {
        persisted = await reconcileStickyNoteEvents(effProjectId, nextNote, prevNote);
      } catch (e) {
        console.error('[sticky-notes] toggle_line 同步日历失败:', e);
      }
      notes[idx] = persisted;
      await writeNotes(dir, notes);
      const eventIds = persisted.pages?.find((p) => p.id === pageId)?.lineEventIds?.[at] ?? [];
      // 勾选影响到了日历事件时才即改即推远端（与 add_to_calendar 一致，免等轮询）
      if (eventIds.length > 0) {
        try {
          const { syncAllAccounts } = await import('@/lib/calendar/sync-runner');
          void syncAllAccounts().catch((e) =>
            console.error('[sticky-notes] toggle_line 远端同步失败:', e),
          );
        } catch {
          /* 远端同步失败不阻断勾选本身 */
        }
      }
      return NextResponse.json({ success: true, note: persisted, line_index: at, event_ids: eventIds });
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
