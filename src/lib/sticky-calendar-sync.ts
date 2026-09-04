/**
 * Sticky 便签待办行 ↔ 日历事件 双向同步（2026-09-03 起）
 *
 * 打通约定（与产品确认）：
 *  - 每个项目便签（CanvasStickyNotes）内的 `- [ ]` 待办行 ≡ 一条项目作用域日历事件，
 *    无需再手动「发送到日历」：便签写盘时增量 reconcile，行文本/勾选/删除自动联动事件。
 *  - 事件行带 source_ref（{"kind":"sticky","noteId":..,"pageId":..}）反向锚点，
 *    日历侧改标题 / 勾选 / 删除 → 反向落回对应便签行（正文内容仍 AI 不可读）。
 *  - 无时间的散活行创建事件时用默认时段（与 /todo 规则一致），事件不设提醒（静默清单项）。
 *
 * 数据面：只操作 events 表（全局日历库）；不负责 CalDAV 推送（由既有同步轮询覆盖）。
 * 便签正文的 JSON 文件 IO 仍由调用方负责（/api/sticky-notes、AI 工具等各自写盘），
 * 本模块只提供「纯内存 reconcile（前向）」与「按事件改便签行（反向）」两类纯函数。
 */
import { join } from 'path';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import {
  getCalendarDb,
  createEvent,
  updateEvent,
  getEvent,
  type EventRow,
} from '@/lib/db';
import type { StickyNote, StickyNotePage } from '@/app/api/sticky-notes/route';

/** 每行解析结果（与前端 CanvasStickyNotes.parseTodoLines 语义一致） */
type TodoLine = { text: string; done: boolean };

function parseTodoLines(content: string): TodoLine[] {
  return String(content ?? '')
    .split('\n')
    .map((l) => {
      const m = l.match(/^-\s*\[( |x)\]\s*(.*)$/);
      if (m) return { text: m[2], done: m[1] === 'x' };
      return { text: l.trim(), done: false };
    });
}

/** 生成 `- [ ]` 前缀行（勾选状态按 done 还原时用，保留文本本身） */
function toChecklistLine(line: { text: string; done: boolean }): string {
  return `- [${line.done ? 'x' : ' '}] ${line.text}`;
}

/** 默认时段（与 /todo 未给时间时的规则一致）：1 小时后整点起、2 小时后整点止；深夜跨天回退当天 09:00-10:00 */
export function stickyTodoDefaultRange(): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const toLocalIso = (d: Date): string => {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  };
  const ceilToHour = (base: Date): Date => {
    const c = new Date(base);
    if (c.getMinutes() > 0 || c.getSeconds() > 0 || c.getMilliseconds() > 0) {
      c.setMinutes(0, 0, 0);
      c.setHours(c.getHours() + 1);
    } else {
      c.setSeconds(0, 0);
    }
    return c;
  };
  const now = new Date();
  const todayKey = now.toDateString();
  const start = ceilToHour(new Date(Date.now() + 3600 * 1000));
  const end = ceilToHour(new Date(Date.now() + 2 * 3600 * 1000));
  if (start.toDateString() === todayKey && end.toDateString() === todayKey) {
    return { start: toLocalIso(start), end: toLocalIso(end) };
  }
  const d9 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
  const d10 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
  return { start: toLocalIso(d9), end: toLocalIso(d10) };
}

/** 便签行反向锚点（事件 source_ref 的 JSON 结构） */
export type StickyEventRef = { kind: 'sticky'; noteId: string; pageId: string };

export function stickyRefOf(noteId: string, pageId: string): string {
  return JSON.stringify({ kind: 'sticky', noteId, pageId } satisfies StickyEventRef);
}

export function parseStickyRef(sourceRef: string | null | undefined): StickyEventRef | null {
  if (!sourceRef) return null;
  try {
    const r = JSON.parse(sourceRef) as StickyEventRef;
    if (r?.kind !== 'sticky' || !r.noteId || !r.pageId) return null;
    return r;
  } catch {
    return null;
  }
}

/** 对齐 pages[].lineEventIds / lineCalendared 到行数（旧数据缺失时补空数组） */
function alignLineMeta(
  page: StickyNotePage,
  count: number,
): { evs: string[][]; cal: boolean[] } {
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

/**
 * 前向 reconcile（纯内存，不写盘）：把一张便签（或其某一页）的待办行状态
 * 同步到日历事件，返回更新过 lineEventIds / lineCalendared 的 note 副本。
 *  - 有事件锚点的行：文本变化 → 改事件标题；勾选变化 → 改事件状态
 *  - 无事件锚点且未完成的非空行：自动建事件（默认时段，无提醒，写 source_ref）
 *  - 旧页里存在但新页已消失的事件（行被删除）→ 置 cancelled
 *  - 已勾选完成但从未入日历的历史行：不建事件（避免完成项产生日历噪音）
 */
export async function reconcileStickyNoteEvents(
  projectId: string,
  note: StickyNote,
  prev?: StickyNote | null,
): Promise<StickyNote> {
  const db = await getCalendarDb();
  const pages = Array.isArray(note.pages) ? note.pages : [];

  const updatedPages = await Promise.all(
    pages.map(async (page) => {
      if (page.kind === 'note') return page;
      const lines = parseTodoLines(page.content);
      const { evs, cal } = alignLineMeta(page, lines.length);
      const prevPage =
        prev && Array.isArray(prev.pages) ? prev.pages.find((p) => p.id === page.id) : undefined;
      const prevLines = prevPage ? parseTodoLines(prevPage.content) : [];
      const prevEvs = Array.isArray(prevPage?.lineEventIds)
        ? prevPage.lineEventIds
        : Array.from({ length: prevLines.length }, () => [] as string[]);

      const kept = new Set<string>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const text = line.text.trim();
        if (!text) {
          evs[i] = [];
          cal[i] = false;
          continue;
        }
        // 沿用当前事件锚点；若客户端丢失（多端写竞争），用旧文件同索引 + 同文本锚点回填
        let lineEvs = evs[i] ?? [];
        if (lineEvs.length === 0 && prevEvs[i] && prevEvs[i].length > 0 && prevLines[i]?.text.trim() === text) {
          lineEvs = prevEvs[i].slice();
        }

        if (lineEvs.length > 0) {
          // 有锚点：逐事件对齐文本/状态；事件已不存在则视为已删除，脱锚
          const valid: string[] = [];
          for (const eid of lineEvs) {
            const row = await getEvent(db, eid);
            if (!row) continue;
            valid.push(eid);
            kept.add(eid);
            const wantStatus: 'scheduled' | 'done' = line.done ? 'done' : 'scheduled';
            if (row.status !== wantStatus || row.title !== text) {
              try {
                if (row.title !== text) await updateEvent(db, eid, { title: text });
                if (row.status !== wantStatus) await updateEvent(db, eid, { status: wantStatus });
              } catch (e) {
                console.error('[sticky-calendar] 事件对齐失败:', e);
              }
            }
          }
          evs[i] = valid;
          cal[i] = valid.length > 0;
          continue;
        }

        // 无锚点：未完成的行自动建事件；已完成的不建（历史完成行不产生日历噪音）
        if (!line.done) {
          try {
            const slot = stickyTodoDefaultRange();
            const eid = await createEvent(db, {
              project_id: projectId,
              title: text,
              start_time: slot.start,
              end_time: slot.end,
              scope: 'project',
              reminder_minutes: [], // 便签清单项静默，不触发提醒
              source_ref: stickyRefOf(note.id, page.id),
            });
            evs[i] = [eid];
            cal[i] = true;
            kept.add(eid);
          } catch (e) {
            console.error('[sticky-calendar] 自动建事件失败:', e);
          }
        } else {
          evs[i] = [];
          cal[i] = false;
        }
      }

      // 旧页有但新页已消失的事件（该行被删除/替换）→ 取消（不在 kept 中）
      if (prevEvs) {
        for (const arr of prevEvs) {
          for (const eid of arr) {
            if (!eid || kept.has(eid)) continue;
            kept.add(eid);
            try {
              await updateEvent(db, eid, { status: 'cancelled' });
            } catch {
              /* 忽略单条取消失败 */
            }
          }
        }
      }

      return { ...page, lineEventIds: evs, lineCalendared: cal } as StickyNotePage;
    }),
  );

  return { ...note, pages: updatedPages, updatedAt: new Date().toISOString() };
}

/** 收集一张便签所有页所有行的日历事件 id（删除便签前用于取消事件） */
export function collectNoteEventIds(note: StickyNote | null | undefined): string[] {
  if (!note || !Array.isArray(note.pages)) return [];
  const ids: string[] = [];
  for (const p of note.pages) {
    if (p.kind === 'note' || !Array.isArray(p.lineEventIds)) continue;
    for (const arr of p.lineEventIds) {
      if (!Array.isArray(arr)) continue;
      for (const eid of arr) if (eid) ids.push(eid);
    }
  }
  return [...new Set(ids)];
}

/** 便签整体删除前：把其全部关联事件置为 cancelled（软删，日历侧即消失） */
export async function cancelNoteEvents(note: StickyNote | null | undefined): Promise<void> {
  const ids = collectNoteEventIds(note);
  if (ids.length === 0) return;
  const db = await getCalendarDb();
  for (const eid of ids) {
    try {
      await updateEvent(db, eid, { status: 'cancelled' });
    } catch {
      /* 忽略 */
    }
  }
}

/* ────────────────────────────────────────────────────────────
 * 反向：日历侧变更 → 便签行
 * ──────────────────────────────────────────────────────────── */

/** 解析便签所在项目目录（事件 project_id → 项目路径） */
async function resolveProjectDirByEvent(projectId: string): Promise<string | null> {
  if (!projectId || projectId === '__global__') return null;
  try {
    const { getProjectById } = await import('@/lib/project/project-manager');
    const p = await getProjectById(projectId);
    return p?.path ?? null;
  } catch {
    return null;
  }
}

export async function readStickyNotesFile(projectDir: string): Promise<StickyNote[]> {
  try {
    const raw = await readFile(join(projectDir, 'sticky-notes', 'sticky-notes.json'), 'utf-8');
    const data = JSON.parse(raw);
    return (Array.isArray(data?.notes) ? data.notes : []) as StickyNote[];
  } catch {
    return [];
  }
}

export async function writeStickyNotesFile(projectDir: string, notes: StickyNote[]): Promise<void> {
  const dir = join(projectDir, 'sticky-notes');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.sticky-notes.json.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.sync.tmp`);
  await writeFile(tmp, JSON.stringify({ notes }, null, 2), 'utf-8');
  await rename(tmp, join(dir, 'sticky-notes.json'));
  try {
    const { writeTodoIndexFile } = await import('@/lib/sticky-todo');
    await writeTodoIndexFile(projectDir, notes as Array<Record<string, unknown>>);
  } catch (e) {
    console.error('[sticky-calendar] 待办索引同步失败:', e);
  }
}

/**
 * 日历事件变更 → 反向落回便签行：
 *  - opts.removeLine=false（默认）：把命中的便签行文本/勾选与事件对齐（标题改、状态勾选），
 *    行已一致时跳过写盘（幂等，避免 sticky 自身前向同步引发的回写抖动）
 *  - opts.removeLine=true：删除该事件对应的便签行（日历侧删除 → 待办一并移除）
 */
export async function pushCalendarEventToSticky(
  event: EventRow,
  opts?: { removeLine?: boolean },
): Promise<{ applied: boolean }> {
  const ref = parseStickyRef(event.source_ref);
  if (!ref) return { applied: false };
  const projectDir = await resolveProjectDirByEvent(event.project_id);
  if (!projectDir) return { applied: false };

  const notes = await readStickyNotesFile(projectDir);
  const noteIdx = notes.findIndex((n) => n.id === ref.noteId);
  if (noteIdx < 0) return { applied: false };
  const note = notes[noteIdx];
  if (!Array.isArray(note.pages)) return { applied: false };
  const pageIdx = note.pages.findIndex((p) => p.id === ref.pageId);
  if (pageIdx < 0) return { applied: false };
  const page = note.pages[pageIdx];
  if (page.kind === 'note') return { applied: false };

  const lines = parseTodoLines(page.content);
  const { evs } = alignLineMeta(page, lines.length);
  const lineIdx = evs.findIndex((arr) => (arr || []).includes(event.event_id));
  if (lineIdx < 0) return { applied: false };

  // parseTodoLines 与原始 content 行序一一对应（不丢行），rawLines 供原位改写
  const rawLines = String(page.content).split('\n');
  const removeLine = opts?.removeLine === true || event.status === 'cancelled';
  let changed = false;

  if (removeLine) {
    // 先摘除该事件锚点；行上还挂着其它事件时保留整行（仍是待办，仅脱锚）
    const remaining = (evs[lineIdx] || []).filter((eid) => eid !== event.event_id);
    if (remaining.length === 0) {
      rawLines.splice(lineIdx, 1);
      evs.splice(lineIdx, 1);
    } else {
      evs[lineIdx] = remaining;
    }
    changed = true;
  } else {
    const line = lines[lineIdx];
    const done = event.status === 'done';
    const newText = event.title ?? line.text;
    if (line.done !== done || line.text !== newText) {
      rawLines[lineIdx] = toChecklistLine({ text: newText, done });
      changed = true;
    }
  }
  if (!changed) return { applied: false };

  const cal = evs.map((arr) => arr.length > 0);
  const nextPage: StickyNotePage = {
    ...page,
    content: rawLines.join('\n'),
    lineEventIds: evs,
    lineCalendared: cal,
  };
  const nextNote: StickyNote = {
    ...note,
    pages: note.pages.map((p, i) => (i === pageIdx ? nextPage : p)),
    updatedAt: new Date().toISOString(),
  };
  const nextNotes = notes.slice();
  nextNotes[noteIdx] = nextNote;
  await writeStickyNotesFile(projectDir, nextNotes);
  return { applied: true };
}
