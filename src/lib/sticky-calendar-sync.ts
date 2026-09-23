/**
 * Sticky 便签待办行 ↔ 日历事件 双向同步（2026-09-03 起；2026-09-08 语义收紧）
 *
 * 产品约定（2026-09-21 更新）：
 *  - StickyTodo 行**自动入日历**：便签「结算」保存（/api/sticky-notes action=update 且
 *    settle_auto_calendar !== false）时，未入日历且未完成的待办行会自动建成项目事件
 *    （见 autoAddStickyLinesToCalendar）。解析口径与 /todo 完全统一：逐行调
 *    /api/tasks/summarize 内核（single=true，模型返回 title/start_time），模型不可用
 *    或失败时退回正则（parseTodoTime）→ 默认时段。手动「加入日历」（可指定精确时间）与
 *    Butler 排程仍可用。
 *  - 已入日历的行保留双向联动：改文本→改事件标题、勾选→事件完成、删行→取消事件；
 *    日历侧改标题 / 勾选 / 删除 → 反向落回对应便签行（正文内容仍 AI 不可读，落回时剥掉标题的
 *    `_项目名` 后缀，见 stripStickyEventTitle）。
 *  - 事件标题口径（2026-09-21）：`主题_项目名`，项目名去掉创建时追加的 `_YYYYMMDD`，不再带时间后缀。
 *  - 事件不额外设提醒（静默清单项），默认时段与 /todo 规则一致。
 *
 * 数据面：只操作 events 表（全局日历库）；不负责 CalDAV 推送（由既有同步轮询覆盖）。
 * 便签正文的 JSON 文件 IO 仍由调用方负责（/api/sticky-notes、AI 工具等各自写盘），
 * 本模块只提供「锚点行 reconcile（前向对齐）」「自动/手动入日历（加锚点）」
 * 与「按事件改便签行（反向）」等纯函数。
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
import { parseTodoTime } from '@/lib/todo-time-parse';
import { resolveTaskModel } from '@/lib/wanted/task-model';
import { parseTasksWithModel } from '@/lib/wanted/task-summarize';
import { getProjectById } from '@/lib/project/project-manager';

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

/**
 * 行文本拆出尾部地址（开庭 C 表单写入的「…开庭。地址：XXX」等）：
 * 地址属于地点，不属于主题，标题里不再保留（2026-09-21）。
 * 返回 subject = 去掉地址后的主题，address = 剥离出的地点（无则 undefined）。
 */
export function splitStickyAddress(text: string): { subject: string; address?: string } {
  const raw = String(text ?? '').trim();
  const m = raw.match(/(?:。|；|;|，|,)?\s*(?:地址|地点)\s*[:：]\s*([^。；;]*)$/);
  if (!m || m.index === undefined) return { subject: raw };
  const subject = raw.slice(0, m.index).trim().replace(/[。；;，,]\s*$/, '').trim();
  const address = (m[1] ?? '').trim();
  return { subject: subject || raw, address: address || undefined };
}

/**
 * 便签行 → 事件标题（主题）：去掉行内时间表达与尾部地址，只留事项名（2026-09-21）。
 * 例：「下周一 10 点开标」→「开标」；开庭行「合同纠纷一审开庭 在浦东法院的第20法庭开庭。地址：XXX」
 * →「合同纠纷一审开庭」（法院/法庭/地址归事件地点 location，不再堆进标题）。
 * 前向（建事件/改标题）与反向（日历改回便签行）都用它做口径，避免把行内时间表达写没。
 */
export function stickyLineEventTitle(text: string): string {
  let raw = splitStickyAddress(text).subject;
  if (!raw) return raw;
  // 开庭 C 表单生成的「{事项} 在{法院}的第{法庭}法庭开庭」→ 主题只留事项（法院/法庭/地址归地点）
  const m = raw.match(/^(.*?)\s*在([^。；;]*?)开庭/);
  if (m) raw = m[1].trim() || `${m[2].trim()}开庭`;
  try {
    return parseTodoTime(raw)?.topic?.trim() || raw;
  } catch {
    return raw;
  }
}

/**
 * 项目名 → 标题后缀用的名称（去掉项目创建时统一追加的 `_YYYYMMDD` 日期后缀，2026-09-21）。
 * 例：「某某案件_20260914」→「某某案件」；无日期后缀则原样返回。
 */
export function projectTitleName(projectName?: string | null): string {
  const raw = String(projectName ?? '').trim();
  if (!raw) return '';
  const base = raw.replace(/_\d{8}$/, '').trim();
  return base || raw;
}

/**
 * 事件标题统一口径（2026-09-21）：`主题_项目名`（项目名去日期后缀，如「开标_某某案件」）。
 * 主题由调用方先算好（模型 title / stickyLineEventTitle 去时间表达后的原始行文本）。
 * 项目名缺失时退化为主题本身，保证旧数据与无项目场景不受影响。
 */
export function stickyEventTitle(subject: string, projectName?: string | null): string {
  const base = String(subject ?? '').trim();
  const pn = projectTitleName(projectName);
  if (!base) return pn;
  return pn ? `${base}_${pn}` : base;
}

/** 去掉标题末尾的 `_项目名` 后缀（反向同步用），返回纯主题 */
export function stripStickyEventTitle(title: string, projectName?: string | null): string {
  const t = String(title ?? '').trim();
  const pn = projectTitleName(projectName);
  if (!pn) return t;
  const suffix = `_${pn}`;
  return t.endsWith(suffix) ? t.slice(0, -suffix.length).trim() : t;
}

/** 标题是否符合便签口径：主题原样，或「主题_项目名」（兼容历史未带后缀的事件，避免被批量改写） */
function stickyTitleMatches(
  current: string | null | undefined,
  subject: string,
  withSuffix: string,
): boolean {
  const c = String(current ?? '');
  return c === subject || c === withSuffix;
}

/** 取项目显示名（失败时返回空串，调用方退化为不带后缀的标题） */
async function projectNameOf(projectId: string): Promise<string> {
  if (!projectId) return '';
  try {
    const p = await getProjectById(projectId);
    return p?.name ?? '';
  } catch {
    return '';
  }
}

/** 便签行反向锚点（事件 source_ref 的 JSON 结构）。
 *  autoTime=true 表示事件时间由系统推断（模型/正则/默认时段），非用户在日历里手动指定
 *    → 行内时间表达被改写时跟随重排；用户手动改过时间的事件不带此标记，永不被覆盖。
 *  aiTitle=true 表示标题/时间由模型（与 /todo 同一套 /api/tasks/summarize 口径）产出
 *    → 标题归模型所有，前向 reconcile 不再用正则改写，改文本由模型重排（见 autoAddStickyLinesToCalendar）。 */
export type StickyEventRef = {
  kind: 'sticky';
  noteId: string;
  pageId: string;
  autoTime?: boolean;
  aiTitle?: boolean;
  /** 最近一次内容解析（建事件/重排）所用的行文本原文：与当前行文本不同才重新解析，
   *  避免「防抖落盘 + 结算落盘」两次写导致同一内容反复调模型，也确保后续补写日期能被识别 */
  autoText?: string;
};

export function stickyRefOf(
  noteId: string,
  pageId: string,
  opts?: { autoTime?: boolean; aiTitle?: boolean; autoText?: string },
): string {
  return JSON.stringify({
    kind: 'sticky',
    noteId,
    pageId,
    ...(opts?.autoTime ? { autoTime: true } : {}),
    ...(opts?.aiTitle ? { aiTitle: true } : {}),
    ...(opts?.autoText ? { autoText: opts.autoText } : {}),
  } satisfies StickyEventRef);
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
 * 前向 reconcile（纯内存，不写盘）：把一张便签（或其某一页）的**已入日历**待办行状态
 * 同步到日历事件，返回更新过 lineEventIds / lineCalendared 的 note 副本。
 *  - 有事件锚点的行：文本变化 → 改事件标题；勾选变化 → 改事件状态
 *  - 无事件锚点的行：**不自动建事件**（2026-09-08 起 StickyTodo 不自动入日历；
 *    事件只由手动「加入日历」或 Butler 排程产生），保持无锚点
 *  - 旧页里存在但新页已消失的事件（行被删除/替换）→ 置 cancelled
 */
export async function reconcileStickyNoteEvents(
  projectId: string,
  note: StickyNote,
  prev?: StickyNote | null,
): Promise<StickyNote> {
  const db = await getCalendarDb();
  const projectName = await projectNameOf(projectId);
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
            const ref = parseStickyRef(row.source_ref);
            // 标题口径：「主题_项目名」；历史未带后缀的事件同样视为一致，不强制改名
            const wantSubject = stickyLineEventTitle(text);
            const wantTitle = stickyEventTitle(wantSubject, projectName);
            // 行文本改写 → 时间由系统推断的事件（source_ref.autoTime）跟随重排：
            // 新文本能解析出时间就按其更新；解析不出则保持原时间不动（避免默认时段每次漂移）
            let wantTime: { start_time: string; end_time: string } | null = null;
            if (prevLines[i]?.text.trim() !== text && ref?.autoTime) {
              const parsed = parseTodoTime(text);
              if (parsed?.date) {
                const s = new Date(`${parsed.date}T${parsed.time ?? '09:00'}:00`);
                wantTime = {
                  start_time: toLocalIso(s),
                  end_time: toLocalIso(new Date(s.getTime() + 3600 * 1000)),
                };
              }
            }
            // 模型排期的事件（aiTitle）：标题与时间归模型所有，改文本由 autoAddStickyLinesToCalendar 重新解析，
            // 这里只对齐状态，避免正则口径把模型标题/时间覆盖掉
            if (ref?.aiTitle) {
              if (row.status !== wantStatus) {
                try {
                  await updateEvent(db, eid, { status: wantStatus });
                } catch (e) {
                  console.error('[sticky-calendar] 事件状态对齐失败:', e);
                }
              }
              continue;
            }
            const titleOk = stickyTitleMatches(row.title, wantSubject, wantTitle);
            if (
              row.status !== wantStatus ||
              !titleOk ||
              (wantTime && (row.start_time !== wantTime.start_time || row.end_time !== wantTime.end_time))
            ) {
              try {
                if (!titleOk) await updateEvent(db, eid, { title: wantTitle });
                if (row.status !== wantStatus) await updateEvent(db, eid, { status: wantStatus });
                if (wantTime) await updateEvent(db, eid, wantTime);
              } catch (e) {
                console.error('[sticky-calendar] 事件对齐失败:', e);
              }
            }
          }
          evs[i] = valid;
          cal[i] = valid.length > 0;
          continue;
        }

        // 无锚点：本函数只做「已入日历行」的前向对齐，不在此建事件；
        // 未入日历的未完成行由 autoAddStickyLinesToCalendar 在保存时补建（见该函数）
        evs[i] = [];
        cal[i] = false;
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

/**
 * 手动把某一行便签待办加入日历（StickyTodoDock「Add to calendar」按钮 / 开庭 C 表单 / 语义等价路径）。
 *  - 默认用默认时段（stickyTodoDefaultRange，与 /todo 规则一致）建项目作用域事件，无提醒，写 source_ref 锚点；
 *  - 传入 opts.start_time（如开庭 C 选的日期/时间）→ 按指定时间建事件，end 缺省 +1h，提醒默认 [30]；
 *  - 传入 opts.priority='high'（开庭等紧要事项）→ 事件带高优先级，日历侧显示红色标旗；
 *  - 幂等：该行已有事件锚点 → 直接复用返回，不重复建；
 *  - 事件建在 (project_id, title, start_time) 已存在同文本 scheduled 事件时复用（与 /api/calendar/events 防重一致）；
 *  - text 提供时同步把该行文本落为 text（覆盖调用方页内容里待保存的最新文本），并返回更新过的 note 副本
 *    （lineEventIds / lineCalendared / content 已对齐）。文件写盘由调用方负责。
 */
export async function addStickyLineToCalendar(
  projectId: string,
  note: StickyNote,
  pageId: string,
  lineIndex: number,
  text?: string,
  opts?: {
    start_time?: string | null;
    end_time?: string | null;
    reminder_minutes?: number[];
    /** 事件地点：显式传入优先，缺省时自动取行文本尾部「地址：XXX」 */
    location?: string | null;
    /** 事件优先级：开庭等重要事项由调用方传 'high' → 日历侧显示红色标旗 */
    priority?: 'high' | 'normal' | 'low';
  },
): Promise<{ note: StickyNote; eventIds: string[]; created: boolean }> {
  const pages = Array.isArray(note.pages) ? note.pages : [];
  const page = pages.find((p) => p.id === pageId);
  if (!page || page.kind === 'note') {
    throw new Error('page not found or not a todo page');
  }
  const lines = parseTodoLines(page.content);
  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error('line_index out of range');
  }
  const finalText = (text ?? lines[lineIndex].text).trim();
  if (!finalText) throw new Error('todo text is empty');

  const { evs, cal } = alignLineMeta(page, lines.length);
  const existing = (evs[lineIndex] ?? []).filter(Boolean);
  if (existing.length > 0) {
    // 已入日历：无需重建，直接沿用（仅当调用方给了新文本时顺带更新行文本）
    if (finalText !== lines[lineIndex].text.trim()) {
      const rawLines = String(page.content ?? '').split('\n');
      rawLines[lineIndex] = toChecklistLine({ text: finalText, done: false });
      return {
        note: {
          ...note,
          pages: pages.map((p) =>
            p.id === pageId ? { ...p, content: rawLines.join('\n') } : p,
          ),
          updatedAt: new Date().toISOString(),
        },
        eventIds: existing,
        created: false,
      };
    }
    return { note, eventIds: existing, created: false };
  }

  const db = await getCalendarDb();
  // 时段：显式给了 start_time（开庭 C 等精确排程）→ 按它来，end 缺省 +1h；
  // 否则沿用默认时段（stickyTodoDefaultRange）。提醒：显式传入生效，缺省 [30]（手动快速加入时传 [] 静默）
  const def = stickyTodoDefaultRange();
  const start = opts?.start_time || def.start;
  const end =
    opts?.end_time ||
    (opts?.start_time
      ? new Date(new Date(start).getTime() + 3600_000).toISOString()
      : def.end);
  const reminderMinutes = opts?.reminder_minutes ?? (opts?.start_time ? [30] : []);
  // 主题/地点分离：标题用「去时间表达与尾部地址的事项名_项目名」，地址落进事件地点（行文本仍按 finalText 落盘）
  const projectName = await projectNameOf(projectId);
  const title = stickyEventTitle(stickyLineEventTitle(finalText), projectName);
  const location = opts?.location?.trim() || splitStickyAddress(finalText).address;
  const dedupe = db
    .prepare(
      `SELECT event_id FROM events
       WHERE project_id = ? AND status = 'scheduled' AND title = ? AND start_time = ?
       LIMIT 1`,
    )
    .get(projectId, title, start) as { event_id: string } | undefined;

  let eventId: string;
  if (dedupe) {
    eventId = dedupe.event_id;
  } else {
    eventId = await createEvent(db, {
      project_id: projectId,
      title,
      ...(location ? { location } : {}),
      start_time: start,
      end_time: end,
      scope: 'project',
      reminder_minutes: reminderMinutes,
      ...(opts?.priority ? { priority: opts.priority } : {}),
      // 手动入日历：显式传来了开始时间 → 时间归用户，不带 autoTime（后续改行文本不重排时间）
      source_ref: stickyRefOf(note.id, page.id, { autoTime: !opts?.start_time }),
    });
  }

  const rawLines = String(page.content ?? '').split('\n');
  rawLines[lineIndex] = toChecklistLine({ text: finalText, done: false });
  evs[lineIndex] = [eventId];
  cal[lineIndex] = true;

  const nextPage: StickyNotePage = {
    ...page,
    content: rawLines.join('\n'),
    lineEventIds: evs,
    lineCalendared: cal,
  };
  return {
    note: {
      ...note,
      pages: pages.map((p) => (p.id === pageId ? nextPage : p)),
      updatedAt: new Date().toISOString(),
    },
    eventIds: [eventId],
    created: !dedupe,
  };
}

/** 文本里是否含显式日期线索（年/月日/斜杠日期/相对日）——用于兜住「模型漏读日期」的情况 */
const DATE_HINT_RE =
  /(\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|[今明后]\s*天|大?后\s*天|下?周[一二三四五六日天])/;

/**
 * 事件时间是否等于「模型判定无时间线索」的默认值（当前时间 + 1 小时，见 single 提示词第 1 条）。
 * 用于兜住模型漏读日期：只有落在该默认值上的事件才允许被重新解析纠正。
 */
function isNoTimeFallback(startIso: string | null | undefined): boolean {
  if (!startIso) return false;
  const t = new Date(startIso).getTime();
  if (!Number.isFinite(t)) return false;
  return Math.abs(t - (Date.now() + 3600_000)) < 5 * 60_000;
}

/** 本地时区 ISO（与 stickyTodoDefaultRange 同格式），供按行内解析时间建事件时使用 */
function toLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * 自动入日历（2026-09-21 起与 /todo 统一口径）：便签「结算」保存时，把**未入日历且未完成**的待办行
 * 排期成项目作用域事件；行文本被改写的模型排期行也在此重排。
 *
 * 解析：逐个目标行调 `parseTasksWithModel(text, single=true)` —— 与 /todo 完全同一套
 *  （resolveTaskModel + /api/tasks/summarize 的内核），一行 = 一次 single 调用 = 恰好一个任务，
 *  因此「一行 ↔ 一个事件」一一对应，无需按文本反查映射；也顺带获得语义理解
 *  （「下周三跟客户过方案」这类无显式时刻的行不再落到默认时段）。
 *  模型不可用 / 调用失败 / 无任务返回 → 该行退回正则：parseTodoTime 命中按解析结果排期
 *  （只有日期则 09:00），未命中用默认时段 stickyTodoDefaultRange。
 *  - 提醒只由正则能否识别出时间决定（模型不决定提醒）：有时间表达 → [30]；纯清单项 → [] 静默；
 *  - 事件标题统一为「主题_项目名」（项目名去掉创建时追加的 _YYYYMMDD，不含时间后缀与地址）；
 *    行文本尾部的「地址：XXX」自动落到事件地点（location），主题/地点分离；
 *  - 不去改写行文本（只写 lineEventIds / lineCalendared）；
 *  - 防重口径 (project_id, title, start_time)：命中已存在 scheduled 事件则复用并只补锚点；
 *  - 已入日历且归模型排期（source_ref.aiTitle + autoTime）的行：行文本与 source_ref.autoText 不一致
 *    （或上次漏读日期、时间落在「无时间线索」默认值上）时**原地重排**同一事件（标题/时间/地点），不新建；
 *  - 已勾选行、空行、kind='note' 页不参与；无目标行时不调模型（零成本）。
 */
export async function autoAddStickyLinesToCalendar(
  projectId: string,
  note: StickyNote,
): Promise<{ note: StickyNote; created: number; rescheduled: number }> {
  const pages = Array.isArray(note.pages) ? note.pages : [];
  const db = await getCalendarDb();
  const projectName = await projectNameOf(projectId);

  /** 行级可变元数据（逐页准备一次，最后统一写回） */
  type Prepared = { page: StickyNotePage; lines: TodoLine[]; evs: string[][]; cal: boolean[] };
  type Target = { prep: Prepared; index: number; text: string; rescheduleId?: string; curStart?: string | null };

  const prepared: Prepared[] = [];
  const targets: Target[] = [];
  for (const page of pages) {
    if (page.kind === 'note') continue;
    const lines = parseTodoLines(page.content);
    const { evs, cal } = alignLineMeta(page, lines.length);
    const prep: Prepared = { page, lines, evs, cal };
    prepared.push(prep);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].text.trim();
      if (!text || lines[i].done) continue;
      const anchored = (evs[i] ?? []).filter(Boolean);
      if (anchored.length === 0) {
        targets.push({ prep, index: i, text });
        continue;
      }
      // 已有锚点：只有「事件归模型排期」的行才重新解析（其余交给 reconcile 做状态/标题对齐）。
      // 重新解析的判据用 source_ref.autoText（上次解析所用文本），而非与上一份便签做 diff ——
      // 防抖落盘已先把新文本写进文件，等到结算时 diff 恒为空，会漏掉「事后补写日期」这类修改。
      const row = await getEvent(db, anchored[0]);
      const ref = row ? parseStickyRef(row.source_ref) : null;
      if (!ref?.aiTitle || !ref.autoTime) continue;
      const textUnparsed = (ref.autoText ?? '') !== text;
      // 兜底：上次解析把带日期的文本判成「无时间线索」（时间落在默认值上）→ 重试一次
      const missedDate = isNoTimeFallback(row?.start_time) && DATE_HINT_RE.test(text);
      if (textUnparsed || missedDate) {
        targets.push({
          prep,
          index: i,
          text,
          rescheduleId: anchored[0],
          curStart: row?.start_time ?? null,
        });
      }
    }
  }
  if (targets.length === 0) return { note, created: 0, rescheduled: 0 };

  // 模型解析（并行，一行一次 single 调用）；模型不可用或单行失败 → 该行退回正则+默认时段
  const cfg = await resolveTaskModel().catch(() => null);
  const plans = await Promise.all(
    targets.map(async (t) => {
      if (!cfg) return null;
      try {
        const { tasks } = await parseTasksWithModel(cfg, t.text, true);
        return tasks[0] ?? null;
      } catch (e) {
        console.warn('[sticky-calendar] 模型解析失败，该行退回正则:', e);
        return null;
      }
    }),
  );

  let created = 0;
  let rescheduled = 0;
  for (let k = 0; k < targets.length; k++) {
    const t = targets[k];
    const plan = plans[k];
    const parsed = parseTodoTime(t.text);
    let subject: string;
    let start: string;
    let end: string;
    let allDay: boolean | undefined;
    let aiTitle = false;
    let location: string | undefined;
    // 模型解析出的其余日历字段（正则回退路径没有这些，保持 undefined 不动原值）
    let priority: 'high' | 'normal' | 'low' | undefined;
    let categoryPath: string[] | undefined;
    let description: string | undefined;
    let reminderFromModel: number[] | undefined;
    if (plan) {
      subject = splitStickyAddress(plan.title).subject;
      start = plan.start_time;
      end = plan.end_time || toLocalIso(new Date(new Date(plan.start_time).getTime() + 3600_000));
      allDay = plan.all_day === true;
      location = plan.location?.trim() || splitStickyAddress(t.text).address;
      priority = plan.priority;
      categoryPath = plan.category_path;
      description = plan.description?.trim() || undefined;
      reminderFromModel = plan.reminder_minutes;
      aiTitle = true;
    } else if (parsed) {
      const s = new Date(`${parsed.date}T${parsed.time ?? '09:00'}:00`);
      subject = stickyLineEventTitle(t.text);
      start = toLocalIso(s);
      end = toLocalIso(new Date(s.getTime() + 3600_000));
      location = splitStickyAddress(t.text).address;
    } else {
      const def = stickyTodoDefaultRange();
      subject = splitStickyAddress(t.text).subject;
      start = def.start;
      end = def.end;
      location = splitStickyAddress(t.text).address;
    }
    // 标题统一口径：主题_项目名（项目名去日期后缀），与手动「加入日历」一致
    const title = stickyEventTitle(subject, projectName);
    // 提前提醒：模型解析出的优先（支持「提前 3 天提醒」）；否则解析到时间就给系统默认 30 分钟，
    // 完全没解析出时间则保持「不提醒」（空数组 = 明确关闭，与 DB 的默认语义区分）
    const reminder = reminderFromModel?.length ? reminderFromModel : (plan || parsed ? [30] : []);
    const sourceRef = stickyRefOf(note.id, t.prep.page.id, {
      autoTime: true,
      ...(aiTitle ? { aiTitle: true } : {}),
      autoText: t.text,
    });
    // 重排保护：新解析结果落在「无时间线索」默认值上、而事件原本是一个明确时间时，保留原时间（只更新标题/地点）
    const keepTime = !!t.rescheduleId && isNoTimeFallback(start) && !isNoTimeFallback(t.curStart);

    try {
      if (t.rescheduleId) {
        await updateEvent(db, t.rescheduleId, {
          title,
          ...(location ? { location } : {}),
          ...(description ? { description } : {}),
          ...(categoryPath?.length ? { category_path: categoryPath } : {}),
          reminder_minutes: reminder,
          ...(keepTime ? {} : { start_time: start, end_time: end, all_day: allDay ?? false }),
          source_ref: sourceRef,
        });
        rescheduled += 1;
      } else {
        const dedupe = db
          .prepare(
            `SELECT event_id FROM events
             WHERE project_id = ? AND status = 'scheduled' AND title = ? AND start_time = ?
             LIMIT 1`,
          )
          .get(projectId, title, start) as { event_id: string } | undefined;
        const eventId =
          dedupe?.event_id ??
          (await createEvent(db, {
            project_id: projectId,
            title,
            ...(location ? { location } : {}),
            ...(description ? { description } : {}),
            ...(priority ? { priority } : {}),
            ...(categoryPath?.length ? { category_path: categoryPath } : {}),
            start_time: start,
            end_time: end,
            ...(allDay ? { all_day: true } : {}),
            scope: 'project',
            reminder_minutes: reminder,
            source_ref: sourceRef,
          }));
        t.prep.evs[t.index] = [eventId];
        t.prep.cal[t.index] = true;
        if (!dedupe) created += 1;
      }
    } catch (e) {
      console.error('[sticky-calendar] 自动入日历失败:', e);
    }
  }

  const updatedPages: StickyNotePage[] = pages.map((page) => {
    const prep = prepared.find((x) => x.page.id === page.id);
    if (!prep) return page;
    return {
      ...page,
      lineEventIds: prep.evs,
      lineCalendared: prep.cal,
    } as StickyNotePage;
  });

  return {
    note: { ...note, pages: updatedPages, updatedAt: new Date().toISOString() },
    created,
    rescheduled,
  };
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
  const projectName = await projectNameOf(String(event.project_id ?? ''));

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
    // 事件标题带有「_项目名」后缀，反向落回便签行时先剥掉，避免后缀被写进待办正文
    const rawTitle = event.title ?? '';
    const newText = rawTitle ? stripStickyEventTitle(rawTitle, projectName) : line.text;
    // 标题比对用「去时间表达后的事项名」口径：行内时间表达不算差异，
    // 否则日历侧任一改动（改状态/颜色）都会把行内「明天 10 点」洗掉
    const titleDiffers = stickyLineEventTitle(line.text) !== newText;
    if (line.done !== done || titleDiffers) {
      // 仅勾选状态变化时保留原行文本（含时间表达）；标题被真实改动才落回新标题
      rawLines[lineIdx] = toChecklistLine({ text: titleDiffers ? newText : line.text, done });
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
