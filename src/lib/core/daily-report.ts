/**
 * Butler 每日摘要内容源（Report / Schedule / Sticky）+ Notes 维护
 *
 * 2026-09-27 改向：日报**不再由通知助理 Bobby 推送**，整份日报（三个页签 Report / Schedule /
 * Sticky）搬进右栏 Today 面板（见 lib/butler/today.ts 与 components/butler/ButlerTodayPanel.tsx）。
 * 于是本模块的职责从「生成并投递报告」变成「按需产出三段内容」：
 *   - Schedule：今日待办 + 已过期待办 —— 直接由 Today 快照派生（buildScheduleSection，纯函数）
 *   - Sticky：全项目未完成的便签待办 —— 每次请求实算（buildStickySection，数据本身很轻）
 *   - Report：各项目**昨天**的流水归纳 —— LLM 归纳成本高，改为**每日生成一次并缓存**
 *     （generateProgressDigest → state/digest-YYYY-MM-DD.md，Today 的 Report 页签读缓存）
 *
 * 仍然走通知中心（Bobby）的只有 **Notes 知识库每日维护**（每周节奏，不属于日报三页签）。
 *
 * 去重：progress / notes 每个自然日只做一次，标记文件存于 butler/.state/daily-report/ 目录
 * （应用每天首次打开会兜底补做，未到 9:00 则等到 9:00 再发，不重复）。
 */
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { STATE_DIR } from '@/lib/butler/storage';
import { atomicWriteFile } from '@/lib/butler/fs-atomic';
import type { TodaySnapshot, TodayEvent } from '@/lib/butler/today';
import type { ButlerNoticeItem } from '@/lib/bus';

/** 报告内部状态目录：butler/.state/daily-report（去重标记 / pending / error.log / notes-review）。
 *  与用户可见的角色目录分离——这些是内部状态，不该混进 <角色>/<日期>/ 的内容区。 */
const REPORT_DIR = join(STATE_DIR, 'daily-report');
const PENDING_FILE = join(REPORT_DIR, 'pending.json');
/** 报告链路失败留痕文件：睡眠/静默失败场景不再靠猜，关键失败点统一 append 到这里 */
const ERROR_LOG = join(REPORT_DIR, 'error.log');

/** 仍走「每日一次」的两种：progress=各项目昨日进展（给 Today 的 Report 页签缓存内容）
 *  / notes=知识库每日维护（仍由 Bobby 通知）。morning / sticky 已改为 Today 面板实算，不再是一类「报告」。 */
export type DailyReportType = 'progress' | 'notes';

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 短日期标签（英文，如 "Aug 8"）—— 报告标题里的日期显示 */
function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function eventLine(ev: TodayEvent): string {
  const time = ev.all_day
    ? `${fmtDate(ev.start_time)} All-day`
    : `${fmtDateTime(ev.start_time)}${ev.end_time ? ` - ${fmtTime(ev.end_time)}` : ''}`;
  const prio = ev.priority === 'high' ? ' (high)' : ev.priority === 'low' ? ' (low)' : '';
  const mark = ev.status === 'done' ? ' [done]' : ev.status === 'cancelled' ? ' [cancelled]' : '';
  return `- ${time}  ${ev.title}${prio}${mark}`;
}

/* ────────────────────────────────────────────────────────────
 * 待办项 → 结构化通知项
 * ──────────────────────────────────────────────────────────── */

/** 待办事件 → 结构化通知项（供通知中心渲染待办表格）。
 *  source='event'：key 即日历事件 id，点击完成时由 UI 直接 PATCH 事件状态（见 ButlerDrawer.toggleItem），
 *  不再只是翻转通知里的一份快照——日历 / 便签两侧的联动交给既有的日历反向同步。 */
function toNoticeItem(ev: TodayEvent): ButlerNoticeItem {
  const d = new Date(ev.start_time);
  const startMs = Number.isFinite(d.getTime()) ? d.getTime() : 0;
  return {
    // 无 event_id 时只能退化成「时间+标题」的伪 key，点不动日历 → 不带 source，退回本地勾选
    key: ev.event_id || `${ev.start_time}-${ev.title}`,
    title: ev.title,
    time: ev.all_day
      ? `${fmtDate(ev.start_time)} All-day`
      : `${fmtDate(ev.start_time)} ${fmtTime(ev.start_time)}`,
    startMs,
    status: ev.status,
    priority: ev.priority,
    allDay: ev.all_day,
    ...(ev.event_id ? { source: 'event' as const } : {}),
  };
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

/** 正文（text）里每个分区最多列几条：明细清单交给 Today 面板的 items 渲染，正文只要点到位 */
const TEXT_PREVIEW = 10;

/**
 * Schedule 段（Today 的 Schedule 页签）：Today 快照的**纯派生视图** —— 不查库、不发通知。
 *
 * 逾期口径由快照统一（已剔除今天才开始的事件），Today 面板与这段内容不再各算一遍。
 * `items` 用快照给全量（面板可展开、可勾选）；`text` 只列 TEXT_PREVIEW 条要点，
 * 超出时补一行 `… (+N more)`；`degraded` 非空时明示告警，避免「查询失败 = 今天很空」被误读。
 */
export function buildScheduleSection(snap: TodaySnapshot): { text: string; items: ButlerNoticeItem[] } {
  const todayEvents = snap.today.events;
  const overdueEvents = snap.overdue.events;
  const todayCount = snap.today.count;
  const overdueCount = snap.overdue.count;
  // 结构化待办带分区标记：前 todayEvents.length 条 = 今日，其余 = 已过期
  const items: ButlerNoticeItem[] = [...todayEvents, ...overdueEvents].map((ev, i) => ({
    ...toNoticeItem(ev),
    section: i < todayEvents.length ? 'today' : 'overdue',
  }));
  // 正文只列前 TEXT_PREVIEW 条：快照为了「面板能整段摊开」已放开上限（可达数百条），
  // 这段文字若跟着全列会被拉成流水账 —— 它是要点摘要，不是清单。
  const todayPreview = todayEvents.slice(0, TEXT_PREVIEW);
  const overduePreview = overdueEvents.slice(0, TEXT_PREVIEW);
  const lines: string[] = [`🌅 Schedule — ${fmtDateShort(snap.at)}`];
  if (todayCount > 0) {
    lines.push(`\n📋 Today (${todayCount}):`);
    lines.push(...todayPreview.map((ev) => eventLine(ev)));
    if (todayCount > todayPreview.length) lines.push(`- … (+${todayCount - todayPreview.length} more)`);
  } else {
    lines.push('\n📋 Today: no events');
  }
  if (overdueCount > 0) {
    lines.push(`\n⏰ Overdue (${overdueCount}):`);
    lines.push(...overduePreview.map((ev) => eventLine(ev)));
    if (overdueCount > overduePreview.length) lines.push(`- … (+${overdueCount - overduePreview.length} more)`);
  } else {
    lines.push('\n⏰ Overdue: none');
  }
  lines.push(`\n—— ${todayCount} today, ${overdueCount} overdue`);
  if (snap.degraded.length > 0) {
    lines.push(`\n⚠ Partial data unavailable: ${snap.degraded.join('; ')}`);
  }
  return { text: lines.join('\n'), items };
}

/** 当天某类报告的标记文件路径（存在 = 今天已发过） */
function markerPath(type: DailyReportType): string {
  return join(REPORT_DIR, `${todayStr()}.${type}`);
}

/** 进程内并发锁 + 标记文件原子抢占：双进程同时调 sendDailyReport 时仅第一个抢占成功。
 *  抢占顺序：先拿进程内锁 → 再 double-check 标记文件 → 再 fs 原子写入抢占（失败回滚锁）。 */
let _sendLock: Promise<void> | null = null;
async function tryAcquireSendMarker(type: DailyReportType): Promise<boolean> {
  // ① 进程内串行化（避免同进程多次并发调用时 access 结果互相踩空）
  const prev = _sendLock;
  let release: () => void = () => {};
  _sendLock = (async () => {
    if (prev) await prev;
    await new Promise<void>((res) => { release = res; });
  })();
  try {
    // ② double-check：拿锁之后再确认一次，避免"抢占前都判定未发 → 都写 pending"
    if (await alreadySent(type)) return false;
    // ③ 原子抢占：用 wx 标志写 + 独占式原子创建（Node.js fs.writeFile 'wx' = O_EXCL）
    //  抢占失败（文件已存在，EEXIST）= 另一进程/线程已先拿到；标记为已发。
    await mkdir(REPORT_DIR, { recursive: true });
    try {
      const { writeFile } = await import('fs/promises');
      await writeFile(markerPath(type), new Date().toISOString(), { encoding: 'utf-8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && (e.code === 'EEXIST' || e.code === 'EACCES')) return false;
      throw e;
    }
  } finally {
    release();
  }
}

async function alreadySent(type: DailyReportType): Promise<boolean> {
  try {
    await access(markerPath(type));
    return true;
  } catch {
    return false;
  }
}

/** 报告链路失败留痕（error.log，append）：写入/发送失败时落盘具体原因，
 *  下次排查直接看日志文件，不再依赖猜（如本次 pushPending 静默失败导致 Butler 未收到）。 */
async function logReportError(type: DailyReportType, phase: string, err: unknown): Promise<void> {
  try {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    const { appendFile } = await import('fs/promises');
    await mkdir(REPORT_DIR, { recursive: true });
    await appendFile(ERROR_LOG, `[${new Date().toISOString()}] [${type}] ${phase}: ${detail}\n---\n`, 'utf-8');
  } catch { /* 留痕失败静默，不影响主链路 */ }
}

/** 写入待发布通知（通知中心）。
 *  每条写 dedupeKey=type:YYYY-MM-DD，用于前端 POST inbox 时按(kind,title)幂等去重；
 *  pending 项带 kind 字段（morning → daily-report / sticky → inspect），前端轮询时按 kind 分流发布。
 *  用进程内锁 + 原子 rename 保证 pending.json 的读-改-写不被并发打断。 */
let _pendingLock: Promise<void> | null = null;
async function pushPending(
  title: string,
  body: string,
  items: ButlerNoticeItem[],
  type: DailyReportType,
): Promise<void> {
  // 进程内 pending 文件的读写串行化
  const prev = _pendingLock;
  let release: () => void = () => {};
  _pendingLock = (async () => {
    if (prev) await prev;
    await new Promise<void>((res) => { release = res; });
  })();
  try {
    await mkdir(REPORT_DIR, { recursive: true });
    let pending: {
      kind: string;
      title: string;
      body: string;
      time: number;
      items: ButlerNoticeItem[];
      dedupeKey: string;
    }[] = [];
    try {
      const raw = await readFile(PENDING_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) pending = parsed as typeof pending;
    } catch { /* 无文件或损坏则从空开始 */ }
    const dedupeKey = `${type}:${todayStr()}`;
    // 写入前对同 dedupeKey 做一次去重（兜底：如果 sendDailyReport 被外部并发调了两次，
    //  抢占锁理论上已拦住，但这里再做一次 content 级去重，防历史遗留脏 pending）
    if (pending.some((p) => p.dedupeKey === dedupeKey)) {
      console.warn(`[daily-report] pending 已存在 key=${dedupeKey}，跳过重复 push`);
      return;
    }
    pending.push({
      // Notes 维护仍走 SCHEDULES 桶（有未读角标 / 置顶）；日报三页签已不再产生收件箱回执
      kind: 'daily-report',
      title,
      body,
      time: Date.now(),
      items,
      dedupeKey,
    });
    // 原子替换：先写 tmp 再 rename（rename 在 POSIX 是原子的；Windows NTFS 也支持）。
    // tmp 名带随机后缀：旧实现用 pid+Date.now，morning/sticky 并发推送等极端场景下
    // 同名 tmp 相互覆盖 → 后一个 rename 的源已不存在 → ENOENT。随机后缀彻底避免重名。
    // rename 失败自动重试（源可能被并发清理）；仍失败直写兜底，保证报告不丢。
    const data = JSON.stringify(pending.slice(-20));
    const tmp = `${PENDING_FILE}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
    let renamed = false;
    for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
      await writeFile(tmp, data, 'utf-8');
      try {
        const { rename } = await import('fs/promises');
        await rename(tmp, PENDING_FILE);
        renamed = true;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!renamed) {
      await writeFile(PENDING_FILE, data, 'utf-8');
    }

    // 同步落成报告文档（助理「直接发文档」）：邮件负责通知到了，文档负责内容可沉淀、可翻历史。
    // 文档写入失败**不阻断**通知链路——宁可邮件到了没文档，也不能因为落盘失败把报告整个丢掉。
    try {
      const { writeReportDoc } = await import('@/lib/butler/report-doc');
      await writeReportDoc(type, title, body);
    } catch (docErr) {
      console.error(`[daily-report] ${type} 报告文档落盘失败:`, docErr);
      void logReportError(type, 'writeDoc', docErr);
    }
  } catch (e) {
    console.error('[daily-report] 写入通知队列失败:', e);
    void logReportError(type, 'pushPending', e);
  } finally {
    release();
  }
}

/** Sticky 报告可点击待办项上限：正文仍给全量报告，结构化项封顶以免 items_json 无界膨胀 */
const STICKY_ITEM_LIMIT = 100;

/**
 * 全项目未完成便签待办 → Sticky 页签的可点击项（按「项目 → 便签 → 页 → 行」顺序铺平）。
 * 每项带行定位（source='sticky' + sticky 坐标），点击即勾掉便签正文对应行；
 * 该行已入日历的带上事件时间与状态 —— 勾选后事件完成由便签侧前向同步负责（reconcileStickyNoteEvents），
 * 与「日历改状态 → 反向落回便签行」合成双向链路。
 */
async function buildStickyTodoItems(): Promise<ButlerNoticeItem[]> {
  const [{ listProjects }, { listOpenTodoRows }, { getCalendarDb, getEvent }] = await Promise.all([
    import('@/lib/project/project-manager'),
    import('@/lib/sticky-todo'),
    import('@/lib/db'),
  ]);
  const { projects, active_projects } = await listProjects();
  const activeList = active_projects.length > 0 ? active_projects : projects.filter((p) => !p.archived);
  const db = await getCalendarDb();
  const out: ButlerNoticeItem[] = [];
  for (const p of activeList) {
    if (out.length >= STICKY_ITEM_LIMIT) break;
    let rows: Awaited<ReturnType<typeof listOpenTodoRows>>;
    try {
      rows = await listOpenTodoRows(p.path);
    } catch (e) {
      console.warn('[daily-report] 读取便签待办失败:', p.id, e);
      continue;
    }
    const projectName = p.name || p.id;
    // 便签层是否有信息量（与 formatInspectReply 同一折叠口径）：项目内多张便签、或便签标题
    // 与项目名不同 —— 都不成立时「◇ 同名便签」是纯噪声，卡片上就不占那一行
    const noteIds = new Set(rows.map((r) => r.noteId));
    const showNoteLayer =
      noteIds.size > 1 || rows.some((r) => r.noteTitle && r.noteTitle !== projectName);
    for (const row of rows) {
      if (out.length >= STICKY_ITEM_LIMIT) break;
      const ev = row.eventIds.length > 0 ? await getEvent(db, row.eventIds[0]) : null;
      const evStart = ev?.start_time ?? '';
      const startMs = evStart ? new Date(evStart).getTime() : 0;
      out.push({
        key: `sticky:${p.id}:${row.noteId}:${row.pageId}:${row.lineIndex}`,
        title: row.text,
        time: evStart ? fmtDateTime(evStart) : '',
        startMs: Number.isFinite(startMs) ? startMs : 0,
        status: ev?.status === 'done' ? 'done' : 'scheduled',
        source: 'sticky',
        sticky: {
          projectId: p.id,
          noteId: row.noteId,
          pageId: row.pageId,
          lineIndex: row.lineIndex,
          text: row.text,
        },
        group: projectName,
        ...(showNoteLayer ? { subgroup: row.noteTitle || row.noteId } : {}),
      });
    }
  }
  return out;
}

/**
 * Sticky 段（Today 的 Sticky 页签）：全项目未完成便签待办 —— **每次请求实算**，不进通知中心。
 * 正文走 inspect 的三级折叠文案；结构化项带行定位（source='sticky'），Today 页据此渲染可勾选清单。
 * 结构化项构建失败不阻断正文：退回纯文本（只读）。
 */
export async function buildStickySection(): Promise<{
  text: string;
  items: ButlerNoticeItem[];
  totalPending: number;
  projectCount: number;
}> {
  const { inspectStickyTodos, formatInspectReply } = await import('@/lib/core/inspect');
  const result = await inspectStickyTodos('all');
  const text = formatInspectReply(result);
  let items: ButlerNoticeItem[] = [];
  try {
    items = await buildStickyTodoItems();
  } catch (e) {
    console.error('[daily-report] sticky 待办项构建失败:', e);
  }
  return { text, items, totalPending: result.totalPending, projectCount: result.projectCount };
}

/** Today 的 Report 页签缓存文件：每天一份，生成后即被 /api/butler/today 读取 */
function progressDigestPath(): string {
  return join(REPORT_DIR, `digest-${todayStr()}.md`);
}

/** 读当日 Progress 摘要缓存（Today 的 Report 页签数据源）；未生成（还没到 9:00）返回 null */
export async function readProgressDigest(): Promise<{ markdown: string } | null> {
  try {
    const markdown = await readFile(progressDigestPath(), 'utf-8');
    return markdown.trim() ? { markdown } : null;
  } catch {
    return null;
  }
}

/**
 * Today 键红点探针：当日 Report 摘要**是否已生成**（每天 9:00 生成并落缓存）。
 * 只 access 文件、不读内容、不建 Today 快照 —— 红点轮询要的是便宜且无副作用的答案。
 * 「用户看过没有」由客户端自己记（localStorage），服务端不存阅读状态。
 */
export async function readProgressDigestDate(): Promise<string | null> {
  try {
    await access(progressDigestPath());
    return todayStr();
  } catch {
    return null;
  }
}

/**
 * 生成「各项目昨日进展」摘要（Today 的 Report 页签内容）：
 *   1. 原子抢占当天标记（progress:YYYY-MM-DD）
 *   2. 归纳各项目**昨天**的流水（LLM 归纳，失败走结构化兜底，见 lib/project/daily-digest.ts）
 *   3. 落缓存文件供 Today 读 + 落报告文档供归档；**不进通知中心、不推微信**
 *
 * 昨天全项目都无活动时不写缓存（当日标记已占，防重复）——宁缺一条空摘要，也不给 Today 添噪音。
 */
export async function generateProgressDigest(): Promise<{ sent: boolean; reply: string }> {
  const acquired = await tryAcquireSendMarker('progress');
  if (!acquired) return { sent: false, reply: 'already generated today' };
  let digest: { markdown: string; projectCount: number; itemCount: number };
  try {
    const { buildDailyProjectDigest } = await import('@/lib/project/daily-digest');
    digest = await buildDailyProjectDigest(-1);
  } catch (e) {
    console.error('[daily-report] progress 摘要生成失败:', e);
    void logReportError('progress', 'digest', e);
    return { sent: true, reply: 'digest failed' };
  }
  if (!digest.markdown) return { sent: true, reply: 'no project activity yesterday' };
  try {
    await mkdir(REPORT_DIR, { recursive: true });
    await writeFile(progressDigestPath(), digest.markdown, 'utf-8');
  } catch (e) {
    console.error('[daily-report] progress 摘要缓存写入失败:', e);
    void logReportError('progress', 'cache', e);
  }
  try {
    const { writeReportDoc } = await import('@/lib/butler/report-doc');
    await writeReportDoc('progress', `Report — ${todayStr()}`, digest.markdown);
  } catch (e) {
    console.error('[daily-report] progress 文档落盘失败:', e);
  }
  console.log(`[daily-report] progress 摘要已生成（${digest.projectCount} 个项目 / ${digest.itemCount} 条流水）`);
  return { sent: true, reply: digest.markdown };
}

/* ==================== Notes 维护（Karpathy 每日节奏锚点） ==================== */

/** 整库回看（review + lint）的周期：距离上次回看 ≥ N 天执行一次（每周一次） */
const NOTES_REVIEW_INTERVAL_DAYS = 7;
/** 上次整库回看的落盘状态（{ lastReview: 'YYYY-MM-DD' }），独立于当天一次性标记 */
const NOTES_REVIEW_STATE = join(REPORT_DIR, 'notes-review.json');

async function loadNotesLastReview(): Promise<string | null> {
  try {
    const raw = await readFile(NOTES_REVIEW_STATE, 'utf-8');
    const p = JSON.parse(raw) as { lastReview?: string };
    return typeof p.lastReview === 'string' && p.lastReview ? p.lastReview : null;
  } catch {
    return null;
  }
}

async function saveNotesReview(date: string): Promise<void> {
  try {
    await mkdir(REPORT_DIR, { recursive: true });
    await writeFile(NOTES_REVIEW_STATE, JSON.stringify({ lastReview: date }), 'utf-8');
  } catch (e) {
    console.error('[daily-report] 保存 notes-review 状态失败:', e);
  }
}

/** 距某本地日期（YYYY-MM-DD）的天数 */
function daysSinceLocal(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return Infinity;
  const then = new Date(y, m - 1, d).getTime();
  const now = new Date().getTime();
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/**
 * 每日知识库维护（每天 9:00 后由调度器执行一次，Karpathy「固定节奏批处理」落地）：
 *   ① ingest：当日有新素材（pending raw）→ 用插件大脑自动编译进 wiki（无待编译则快速空转）
 *   ② review + lint：距上次整库回看 ≥ NOTES_REVIEW_INTERVAL_DAYS 天时自动执行（rescue/sink + 矛盾自检）
 * 结果以一条 Butler 回执（SCHEDULES 桶）摘要推送；无实质动作时静默。
 * 失败可观测：插件已启用但大脑模型未配置 / ingest-review-lint 调用失败时，发告警而非静默；
 * 插件被主动禁用时静默（用户已知情）。大脑未配置时不推进回看日期，配置好后自动恢复。
 */
export async function sendNotesMaintenance(): Promise<{ sent: boolean; reply: string }> {
  const acquired = await tryAcquireSendMarker('notes');
  if (!acquired) return { sent: false, reply: 'already sent today' };

  const lines: string[] = [];
  const alerts: string[] = [];
  const { callNotes } = await import('@/lib/mcp/notes-bridge');

  // 探测插件 / 大脑状态：插件被禁用 → 静默；启用但未配大脑模型 → 告警
  const probe = await callNotes('config_get', {});
  const pluginDown = !probe.ok || /未启用/i.test(probe.error || '');
  const brainMissing = !pluginDown && !((probe.data || {}).model as unknown);

  // ① 每日 ingest：编译待处理素材（无 pending 时插件快速返回）
  try {
    const r = await callNotes('ingest', {});
    if (r.ok) {
      const d = (r.data ?? {}) as { compiled?: number; entries?: unknown[] };
      const compiled = typeof d.compiled === 'number' ? d.compiled : 0;
      if (compiled > 0) {
        lines.push(`📥 Ingested ${compiled} raw material(s) → ${(d.entries ?? []).length} wiki note(s).`);
      }
    } else if (!pluginDown) {
      alerts.push(`⚠️ Notes ingest failed: ${r.error}`);
    }
  } catch (e) {
    console.error('[daily-report] notes ingest 异常:', e);
  }

  // ② 周期 review + lint（距上次 ≥ N 天；大脑缺失时不推进日期，避免配好后长期漏回看）
  try {
    const last = await loadNotesLastReview();
    const due = !last || daysSinceLocal(last) >= NOTES_REVIEW_INTERVAL_DAYS;
    if (due && !pluginDown) {
      const [rv, li] = await Promise.all([callNotes('review', {}), callNotes('lint', {})]);
      let didRun = false;
      if (rv.ok) {
        const reviewed = typeof rv.data?.reviewed === 'number' ? rv.data.reviewed : 0;
        const rescued = typeof rv.data?.rescued === 'number' ? rv.data.rescued : 0;
        if (reviewed > 0) {
          didRun = true;
          lines.push(
            rescued > 0
              ? `🔁 Review: rescued ${rescued} of ${reviewed} notes (promoted).`
              : `🔁 Reviewed ${reviewed} notes — nothing to rescue.`,
          );
        }
      } else if (!/未配置|未启用/i.test(rv.error || '')) {
        alerts.push(`⚠️ Notes review failed: ${rv.error}`);
      }
      if (li.ok && Array.isArray(li.data?.issues) && (li.data.issues as unknown[]).length > 0) {
        didRun = true;
        const issues = (li.data.issues as string[]).slice(0, 5);
        lines.push(`🔧 Lint found ${(li.data.issues as unknown[]).length} issue(s):`);
        lines.push(...issues.map((s) => `  · ${s}`));
      } else if (!li.ok && !/未配置|未启用/i.test(li.error || '')) {
        alerts.push(`⚠️ Notes lint failed: ${li.error}`);
      }
      if (didRun) await saveNotesReview(todayStr());
    }
  } catch (e) {
    console.error('[daily-report] notes review/lint 异常:', e);
  }

  // 大脑缺失告警（无论回看是否到期都提示一次；配置好前每天一条，提醒尽快修复）
  if (!pluginDown && brainMissing) {
    alerts.push('🧠 笔记大脑模型未配置：编译/回看被跳过。请到 笔记界面 → Model（bob-notes-mcp config.json）配置 provider+model。');
  }

  const body = [...alerts, ...lines].join('\n').trim();
  if (!body) {
    // 今日无待编译、未到回看周期或插件被禁用：静默（当日标记已占，防止重复）
    return { sent: true, reply: 'no maintenance needed' };
  }
  const title = `Notes Maintenance — ${todayStr()}`;
  await pushPending(title, body, [], 'notes');
  console.log(`[daily-report] notes 维护已发送: ${alerts.length > 0 ? '含告警' : ''} ${body.split('\n')[0]} ${body.split('\n').length > 1 ? `(+${body.split('\n').length - 1} 行)` : ''}`);
  return { sent: true, reply: body };
}

/** 拉取待发布通知（前端轮询调用），拉取后清空队列。
 *  用进程内锁串行化；原子替换写空文件，避免"读+清"之间有并发 fetch 各自读到同一条 pending。 */
let _takeLock: Promise<void> | null = null;
export async function takePendingReports(): Promise<
  { kind: string; title: string; body: string; time: number; items: ButlerNoticeItem[]; dedupeKey?: string }[]
> {
  const prev = _takeLock;
  let release: () => void = () => {};
  _takeLock = (async () => {
    if (prev) await prev;
    await new Promise<void>((res) => { release = res; });
  })();
  try {
    const raw = await readFile(PENDING_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // 先原子写空文件（先写 tmp 再 rename），确保消费方只消费一次
    await atomicWriteFile(PENDING_FILE, '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  } finally {
    release();
  }
}

const SCHEDULE_HOUR = 9;
/** 调度检查周期：每 5 分钟检查一次"已到 9:00 且当天未发"，替代单点 setTimeout。
 *  背景：macOS 睡眠/唤醒会冻结定时器（8/17 实测 9:00 的 setTimeout 在唤醒后才补跑，晚发 28 分钟），
 *  短周期轮询保证睡眠唤醒 / 事件循环阻塞 / 错过整点后 ≤5 分钟内补发，不再整天漏发。 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const SCHEDULER_KEY = '__dailyReportSchedulerStarted__';

/**
 * 启动每日任务调度（instrumentation 调用，幂等）：
 *   - 立即检查一次：已过当天 9:00 且当天未做 → 补做（Report 摘要 + Notes 维护，"每天第一次打开软件"兜底）
 *   - 之后每 5 分钟检查续期：已过 9:00 且未做 → 补做；重复调用由原子抢占（标记文件）去重
 *
 * 日报三页签已改为 Today 面板**按需产出**（见 buildScheduleSection / buildStickySection），
 * 不再有「到点推送」这一步 —— 原 B5 免打扰顺延闸门（shouldHoldMorningReport）随之取消：
 * 现在没有任何东西会打扰用户，深夜补做一次 progress 摘要也无妨。
 */

export async function startDailyReportScheduler(): Promise<void> {
  const g = globalThis as unknown as { [SCHEDULER_KEY]?: boolean };
  if (g[SCHEDULER_KEY]) return;
  g[SCHEDULER_KEY] = true;

  const safeRun = async (type: DailyReportType) => {
    try {
      if (type === 'notes') await sendNotesMaintenance();
      else await generateProgressDigest();
    } catch (e) {
      console.error(`[daily-report] ${type} 执行失败:`, e);
      void logReportError(type, 'run', e);
    }
  };

  // 到点判定：已过当天 9:00（未到 9:00 跳过，等下一次检查）；任务内部原子抢占，重复调用天然去重
  const maybeRunDue = async () => {
    if (new Date().getHours() < SCHEDULE_HOUR) return;
    await Promise.all([safeRun('progress'), safeRun('notes')]);
  };

  // 立即检查一次（覆盖"当天首次打开已过 9:00"的兜底）+ 每 5 分钟循环续期
  void maybeRunDue();
  const timer = setInterval(() => void maybeRunDue(), CHECK_INTERVAL_MS);
  timer.unref?.(); // 不阻止进程退出

  console.log(`[daily-report] 每日调度已启动（每天 ${String(SCHEDULE_HOUR).padStart(2, '0')}:00 后每 ${CHECK_INTERVAL_MS / 60000} 分钟检查补做 Report 摘要 + Notes 知识库维护）`);
}
