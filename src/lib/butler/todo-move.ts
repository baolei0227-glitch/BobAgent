/**
 * lib/butler/todo-move.ts —— 待办「归属迁移」（todo_update 的 move 能力，server-only）
 *
 * 场景：未立项的临时待办先落在全局 **Todo Inbox**；之后用户立了项，要把它归入某项目
 * （或反过来把项目待办移出到 Inbox）。迁移是**归属改写**，不是重建：
 *   - 日历事件：改 project_id（目标项目 id / '__global__'）与 scope（'project' / 'global'），
 *     并把标题后缀换成目标项目的 `_项目名`（与便签入日历的标题口径一致）；
 *   - 便签行：从源便签文件迁到目标便签文件——保留行文本与勾选态，并**把事件的 source_ref
 *     重指向新便签行**，让双向联动不断（不新建事件、不丢待办）。
 *
 * 归属口径与写入口径一致（见 lib/project/sticky-scope）：
 *   项目 → root=项目路径, calendarProjectId=项目 id, scope='project'
 *   Inbox → root=resolveAppRoot(), calendarProjectId='__global__', scope='global'
 *
 * 写入顺序：**先写目标（追加行）→ 再写源（移除行）→ 最后改事件**。
 * 目标先写 → 中途失败最坏只是多一行（可人工处理），不会出现「源已删、目标未建」的空洞。
 */
import { resolveAppRoot } from '@/lib/app-root';
import { getProjectById } from '@/lib/project/project-manager';
import type { StickyNote, StickyNotePage } from '@/app/api/sticky-notes/route';
import type { UpdateEventData } from '@/lib/db';

/** 目标归属（项目 或 Inbox），由 project_id / root / scope 三件套描述 */
interface TargetScope {
  root: string;
  name: string;
  calendarProjectId: string;
  calendarScope: 'project' | 'global';
  isInbox: boolean;
}

/** 解析一行待办：`- [x]` 视为已完成；非 checklist 普通行按未完成处理（与前端口径一致） */
function parseLine(line: string): { done: boolean; text: string } {
  const m = String(line ?? '').match(/^-\s*\[( |x)\]\s*(.*)$/);
  if (m) return { done: m[1] === 'x', text: m[2] };
  return { done: false, text: String(line ?? '').trim() };
}

function toLine(text: string, done: boolean): string {
  return `- [${done ? 'x' : ' '}] ${text}`;
}

/** 把行级元数据对齐到行数（补空数组并截断，与 sticky-calendar-sync.alignLineMeta 同口径） */
function alignMeta(page: StickyNotePage, count: number): { evs: string[][]; cal: boolean[] } {
  const evs = Array.isArray(page.lineEventIds)
    ? page.lineEventIds.map((x) => (Array.isArray(x) ? x.filter(Boolean) : []))
    : ([] as string[][]);
  const cal = Array.isArray(page.lineCalendared) ? [...page.lineCalendared] : ([] as boolean[]);
  while (evs.length < count) evs.push([]);
  while (cal.length < count) cal.push(false);
  evs.length = count;
  cal.length = count;
  return { evs, cal };
}

/** 目标侧的便签文件读写（复用 sticky-calendar-sync 的原子写 + 索引同步原语） */
async function readNotes(root: string): Promise<StickyNote[]> {
  const { readStickyNotesFile } = await import('@/lib/sticky-calendar-sync');
  return readStickyNotesFile(root);
}
async function writeNotes(root: string, notes: StickyNote[]): Promise<void> {
  const { writeStickyNotesFile } = await import('@/lib/sticky-calendar-sync');
  await writeStickyNotesFile(root, notes);
}

/** 新建便签的行补上事件锚点（appendStickyTodoNote 建出的行默认无锚点） */
async function setLineAnchor(
  root: string,
  noteId: string,
  pageId: string,
  lineIndex: number,
  eventId: string,
): Promise<void> {
  const notes = await readNotes(root);
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx < 0) return;
  const note = notes[idx];
  const pIdx = (note.pages ?? []).findIndex((p) => p.id === pageId);
  if (pIdx < 0) return;
  const page = note.pages![pIdx];
  const count = String(page.content ?? '').split('\n').length;
  const { evs, cal } = alignMeta(page, count);
  if (lineIndex >= 0 && lineIndex < count) {
    evs[lineIndex] = [eventId];
    cal[lineIndex] = true;
  }
  const nextPage: StickyNotePage = { ...page, lineEventIds: evs, lineCalendared: cal };
  const nextNotes = notes.slice();
  nextNotes[idx] = {
    ...note,
    pages: note.pages!.map((p, i) => (i === pIdx ? nextPage : p)),
    updatedAt: new Date().toISOString(),
  };
  await writeNotes(root, nextNotes);
}

/**
 * 把一行待办追加到目标便签：优先追加到已有的「用户待办便签」（非系统计划便签）的第一张 todo 页；
 * 目标还没有用户便签时新建一张（复用 appendStickyTodoNote 落盘原语，坐标/颜色/结构一致）。
 * 追加后该行挂上事件锚点（lineEventIds / lineCalendared），保持双向联动。
 */
async function appendLineToTarget(
  target: TargetScope,
  text: string,
  done: boolean,
  eventId: string,
): Promise<{ ok: true; noteId: string; pageId: string } | { ok: false; message: string }> {
  const notes = await readNotes(target.root);
  const existing = notes.find(
    (n) => n.planTodos !== true && Array.isArray(n.pages) && n.pages.some((p) => (p.kind ?? 'todo') !== 'note'),
  );

  if (!existing) {
    // 目标无用户便签 → 新建（appendStickyTodoNote 已含 3 张上限校验；此时必未满）
    const { appendStickyTodoNote } = await import('./sticky-write');
    const res = await appendStickyTodoNote({
      projectRoot: target.root,
      projectName: target.name,
      content: toLine(text, done),
    });
    if (!res.ok) return { ok: false, message: res.message ?? '目标便签创建失败。' };
    await setLineAnchor(target.root, res.noteId, res.pageId, res.lineIndex, eventId);
    return { ok: true, noteId: res.noteId, pageId: res.pageId };
  }

  // 追加到已有便签的第一张 todo 页（行序末尾）
  const noteIdx = notes.findIndex((n) => n.id === existing.id);
  const pIdx = existing.pages!.findIndex((p) => (p.kind ?? 'todo') !== 'note');
  const page = existing.pages![pIdx];
  const rawLines = String(page.content ?? '')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  rawLines.push(toLine(text, done));
  const count = rawLines.length;
  const { evs, cal } = alignMeta(page, count);
  evs[count - 1] = [eventId];
  cal[count - 1] = true;
  const nextPage: StickyNotePage = {
    ...page,
    content: rawLines.join('\n'),
    lineEventIds: evs,
    lineCalendared: cal,
  };
  const nextNotes = notes.slice();
  nextNotes[noteIdx] = {
    ...existing,
    pages: existing.pages!.map((p, i) => (i === pIdx ? nextPage : p)),
    updatedAt: new Date().toISOString(),
  };
  await writeNotes(target.root, nextNotes);
  return { ok: true, noteId: existing.id, pageId: page.id };
}

/** 从源便签移除被迁走的行（含行级元数据；便签清空则整张移除） */
async function removeLineFromSource(
  root: string,
  notes: StickyNote[],
  noteId: string,
  pageId: string,
  lineIndex: number,
): Promise<void> {
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx < 0) return;
  const note = notes[idx];
  const pIdx = (note.pages ?? []).findIndex((p) => p.id === pageId);
  if (pIdx < 0) return;
  const page = note.pages![pIdx];
  const rawLines = String(page.content ?? '').split('\n');
  const evs = Array.isArray(page.lineEventIds)
    ? page.lineEventIds.map((x) => (Array.isArray(x) ? x.slice() : []))
    : [];
  const cal = Array.isArray(page.lineCalendared) ? [...page.lineCalendared] : [];
  const planRefs = Array.isArray(page.linePlanRefs)
    ? page.linePlanRefs.map((x) => (Array.isArray(x) ? x.slice() : []))
    : undefined;
  rawLines.splice(lineIndex, 1);
  evs.splice(lineIndex, 1);
  cal.splice(lineIndex, 1);
  if (planRefs) planRefs.splice(lineIndex, 1);

  const hasContent = rawLines.some((l) => parseLine(l).text.trim().length > 0);
  if (!hasContent) {
    // 便签已空 → 整张移除，不占画布
    await writeNotes(root, notes.filter((n) => n.id !== noteId));
    return;
  }
  const nextPage: StickyNotePage = {
    ...page,
    content: rawLines.join('\n'),
    lineEventIds: evs,
    lineCalendared: cal,
    ...(planRefs ? { linePlanRefs: planRefs } : {}),
  };
  const nextNotes = notes.slice();
  nextNotes[idx] = {
    ...note,
    pages: note.pages!.map((p, i) => (i === pIdx ? nextPage : p)),
    updatedAt: new Date().toISOString(),
  };
  await writeNotes(root, nextNotes);
}

/** 由事件当前 project_id 反解源便签根目录（'__global__' → app root；项目已删 → null） */
async function resolveSourceRoot(projectId: string, globalId: string): Promise<string | null> {
  if (!projectId) return null;
  if (projectId === globalId) return resolveAppRoot();
  try {
    const p = await getProjectById(projectId);
    return p?.path ?? null;
  } catch {
    return null;
  }
}

/** 解析目标归属（项目 or Inbox）；失败返回结构化错误文案 */
async function resolveTargetScope(targetRef: string): Promise<{ ok: true; target: TargetScope } | { ok: false; message: string }> {
  const { GLOBAL_SCOPE_PROJECT_ID, TODO_INBOX_NAME, isInboxRef } = await import('@/lib/project/sticky-scope');
  if (isInboxRef(targetRef)) {
    return {
      ok: true,
      target: {
        root: resolveAppRoot(),
        name: TODO_INBOX_NAME,
        calendarProjectId: GLOBAL_SCOPE_PROJECT_ID,
        calendarScope: 'global',
        isInbox: true,
      },
    };
  }
  const { resolveProjectWithFallback } = await import('@/lib/project/resolve-explicit-project');
  const pr = await resolveProjectWithFallback(targetRef);
  if (!pr.ok) {
    let msg = '目标项目无法解析，请让用户确认项目名。';
    try {
      const parsed = JSON.parse(pr.payload) as { message?: string };
      if (parsed?.message) msg = parsed.message;
    } catch {
      /* payload 非 JSON → 用保底文案 */
    }
    return { ok: false, message: msg };
  }
  if (!pr.project) return { ok: false, message: '目标项目无法解析（空引用）。' };
  return {
    ok: true,
    target: {
      root: pr.project.path,
      name: pr.project.name || pr.project.id,
      calendarProjectId: pr.project.id,
      calendarScope: 'project',
      isInbox: false,
    },
  };
}

/**
 * 把一条已有待办（事件 + 其便签行）迁到目标归属。
 * @param eventId 待迁移的事件 id（来自 query_todos）
 * @param target  目标项目名/id，或 'inbox'（含别名义，迁回 Todo Inbox）
 */
export async function moveTodoOwnership(args: {
  eventId: string;
  target: string;
}): Promise<{ ok: boolean; message: string }> {
  const eventId = String(args.eventId ?? '').trim();
  const targetRef = String(args.target ?? '').trim();
  if (!eventId) return { ok: false, message: 'event_id 不能为空。' };
  if (!targetRef) return { ok: false, message: '缺少目标归属（move_to_project）。' };

  const { GLOBAL_SCOPE_PROJECT_ID, TODO_INBOX_NAME } = await import('@/lib/project/sticky-scope');
  const [{ getCalendarDb, getEvent, updateEvent }, { parseStickyRef, stickyRefOf, stickyEventTitle, stripStickyEventTitle }] =
    await Promise.all([
      import('@/lib/db'),
      import('@/lib/sticky-calendar-sync'),
    ]);

  const db = await getCalendarDb();
  const row = await getEvent(db, eventId);
  if (!row) return { ok: false, message: `未找到待办事件 ${eventId}。` };

  const resolved = await resolveTargetScope(targetRef);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const target = resolved.target;
  const targetLabel = target.isInbox ? TODO_INBOX_NAME : target.name;

  // 同归属（同 root）→ 无需迁移。project_id 可能因项目改名而与 root 无关，故以 root 为准。
  const srcRoot = await resolveSourceRoot(row.project_id, GLOBAL_SCOPE_PROJECT_ID);
  const ref = parseStickyRef(row.source_ref);
  if (srcRoot && srcRoot === target.root) {
    return { ok: true, message: `该待办已属于「${targetLabel}」，无需迁移。` };
  }

  // ① 目标侧先追加（保数据）
  let newAnchor: { noteId: string; pageId: string } | null = null;
  let lineNotFound = false;
  let srcNotes: StickyNote[] | null = null;
  let srcLineIdx = -1;
  if (ref && srcRoot) {
    srcNotes = await readNotes(srcRoot);
    const srcNote = srcNotes.find((n) => n.id === ref.noteId);
    const srcPage = srcNote?.pages?.find((p) => p.id === ref.pageId);
    const evs = Array.isArray(srcPage?.lineEventIds) ? srcPage!.lineEventIds! : [];
    const lineIdx = evs.findIndex((arr) => Array.isArray(arr) && arr.includes(eventId));
    if (!srcPage || lineIdx < 0) {
      lineNotFound = true;
    } else {
      srcLineIdx = lineIdx;
      const rawLines = String(srcPage.content ?? '').split('\n');
      const text = parseLine(rawLines[lineIdx] ?? '').text;
      if (!text.trim()) {
        lineNotFound = true;
      } else {
        const appended = await appendLineToTarget(target, text, row.status === 'done', eventId);
        if (!appended.ok) return { ok: false, message: appended.message };
        newAnchor = { noteId: appended.noteId, pageId: appended.pageId };
      }
    }
  }

  // ② 源侧移除（目标已写好，移除失败最坏只是多一行）
  if (newAnchor && srcNotes && ref && srcRoot && srcLineIdx >= 0) {
    await removeLineFromSource(srcRoot, srcNotes, ref.noteId, ref.pageId, srcLineIdx);
  }

  // ③ 事件改归属：project_id / scope / 标题后缀 / source_ref 重指向
  const patch: UpdateEventData = {
    project_id: target.calendarProjectId,
    scope: target.calendarScope,
  };
  if (row.title) {
    const oldName =
      row.project_id === GLOBAL_SCOPE_PROJECT_ID
        ? ''
        : await getProjectById(row.project_id).then((p) => p?.name ?? '').catch(() => '');
    const subject = stripStickyEventTitle(row.title, oldName);
    const newTitle = stickyEventTitle(subject, target.isInbox ? '' : target.name);
    if (newTitle && newTitle !== row.title) patch.title = newTitle;
  }
  if (newAnchor) {
    patch.source_ref = stickyRefOf(newAnchor.noteId, newAnchor.pageId, {
      autoTime: ref?.autoTime,
      aiTitle: ref?.aiTitle,
      autoText: ref?.autoText,
    });
  } else if (ref && srcRoot && lineNotFound) {
    // 源行确实已不在 → 清掉悬空锚点，避免下次反向联动指向不存在的行
    patch.source_ref = null;
  }
  await updateEvent(db, eventId, patch);

  const movedNote = lineNotFound ? '；但原便签行未找到（可能已删除），已清除其关联' : newAnchor ? '（便签行一并迁移）' : '';
  return { ok: true, message: `已把「${row.title || eventId}」迁到「${targetLabel}」${movedNote}。` };
}
