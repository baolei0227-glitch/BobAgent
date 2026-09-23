/**
 * WANTED 每日自动报告（Morning）
 *
 * Morning（每天 9:00 或当天首次打开软件时）：
 *   今日待办 + 已过期待办
 *
 * 发送通道（两者都要）：
 *   1. WANTED 通知中心：报告写入 pending.json，前端轮询 /api/wanted/daily-report
 *      GET 拉取后 publish wanted.notice（浏览器在线的场景即时可见；离线场景下次打开补显）
 *   2. 微信 iLink：已绑定且有最近会话时主动推送微信消息
 *
 * 去重：每个自然日只发一次，标记文件存于 wanted/daily-report/ 目录
 * （应用每天首次打开会兜底发送 morning，未到 9:00 则等到 9:00 再发，不重复）。
 */
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import { querySchedule, type ScheduleQuery, type ScheduleEvent } from '@/lib/wanted/schedule';
import type { WantedNoticeItem } from '@/lib/bus';

const APP_ROOT = resolveAppRoot();
const REPORT_DIR = join(APP_ROOT, 'wanted', 'daily-report');
const PENDING_FILE = join(REPORT_DIR, 'pending.json');
/** 报告链路失败留痕文件：睡眠/静默失败场景不再靠猜，关键失败点统一 append 到这里 */
const ERROR_LOG = join(REPORT_DIR, 'error.log');

/** 报告类型：morning=晨报 / sticky=便签待办 / notes=知识库每日维护（Karpathy 节奏锚点） */
export type DailyReportType = 'morning' | 'sticky' | 'notes';

/** 本地时区某天 00:00 与次日 00:00 的 UTC ISO */
function dayRange(offsetDays: number): { start: string; end: string } {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

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

function eventLine(ev: ScheduleEvent): string {
  const time = ev.all_day
    ? `${fmtDate(ev.start_time)} All-day`
    : `${fmtDateTime(ev.start_time)}${ev.end_time ? ` - ${fmtTime(ev.end_time)}` : ''}`;
  const prio = ev.priority === 'high' ? ' (high)' : ev.priority === 'low' ? ' (low)' : '';
  const mark = ev.status === 'done' ? ' [done]' : ev.status === 'cancelled' ? ' [cancelled]' : '';
  return `- ${time}  ${ev.title}${prio}${mark}`;
}

/** 待办事件 → 结构化通知项（供通知中心渲染待办表格） */
function toNoticeItem(ev: ScheduleEvent): WantedNoticeItem {
  const d = new Date(ev.start_time);
  const startMs = Number.isFinite(d.getTime()) ? d.getTime() : 0;
  return {
    key: ev.event_id || `${ev.start_time}-${ev.title}`,
    title: ev.title,
    time: ev.all_day
      ? `${fmtDate(ev.start_time)} All-day`
      : `${fmtDate(ev.start_time)} ${fmtTime(ev.start_time)}`,
    startMs,
    status: ev.status,
    priority: ev.priority,
    allDay: ev.all_day,
  };
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

/** 查询事件（复用 schedule 的查询+过滤+排序） */
async function fetchEvents(query: ScheduleQuery, baseUrl: string): Promise<ScheduleEvent[]> {
  const res = await querySchedule(query, baseUrl);
  return res.events;
}

/** Morning 报告：文本（今日 + 已过期）与结构化待办（today/overdue 分区） */
async function buildMorningReport(baseUrl: string): Promise<{ text: string; items: WantedNoticeItem[] }> {
  const today = dayRange(0);
  const [todayEvents, overdue] = await Promise.all([
    fetchEvents({ label: 'Today', rangeStart: today.start, rangeEnd: today.end }, baseUrl),
    fetchEvents({ label: 'Overdue', overdue: true }, baseUrl),
  ]);
  const dateLabel = fmtDateShort(today.start);
  // 已过期列表剔除"今天开始"的事件（已结束的今日会议会同时出现在 Today，避免重复）
  const todayStartMs = new Date(today.start).getTime();
  const overdueOnly = overdue.filter((ev) => new Date(ev.start_time).getTime() < todayStartMs);
  const all = [...todayEvents, ...overdueOnly];
  // 结构化待办带分区标记：前 todayEvents.length 条 = 今日，其余 = 已过期
  const items: WantedNoticeItem[] = all.map((ev, i) => ({
    ...toNoticeItem(ev),
    section: i < todayEvents.length ? 'today' : 'overdue',
  }));
  const lines: string[] = [`🌅 Morning Report — ${dateLabel}`];
  if (todayEvents.length > 0) {
    lines.push(`\n📋 Today (${todayEvents.length}):`);
    lines.push(...todayEvents.map((ev) => eventLine(ev)));
  } else {
    lines.push('\n📋 Today: no events');
  }
  if (overdueOnly.length > 0) {
    lines.push(`\n⏰ Overdue (${overdueOnly.length}):`);
    lines.push(...overdueOnly.map((ev) => eventLine(ev)));
  } else {
    lines.push('\n⏰ Overdue: none');
  }
  lines.push(`\n—— ${todayEvents.length} today, ${overdueOnly.length} overdue`);
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
 *  下次排查直接看日志文件，不再依赖猜（如本次 pushPending 静默失败导致 BobMail 未收到）。 */
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
  items: WantedNoticeItem[],
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
      items: WantedNoticeItem[];
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
      // 与 morning 同为 daily-report（SCHEDULES 桶，有未读角标/置顶）；sticky 走 INSPECT
      kind: type === 'sticky' ? 'inspect' : 'daily-report',
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
  } catch (e) {
    console.error('[daily-report] 写入通知队列失败:', e);
    void logReportError(type, 'pushPending', e);
  } finally {
    release();
  }
}

/**
 * 发送一份报告（Morning/Evening）：
 *   1. 原子抢占当天标记 → 抢占失败 = 已发过 → 跳过
 *   2. 进通知中心（pending.json，前端轮询拉取）
 *   3. 微信推送（已绑定且有最近会话时）
 *   （标记已在抢占阶段写入成功，无需再写）
 */
export async function sendDailyReport(
  type: DailyReportType,
  baseUrl: string,
): Promise<{ sent: boolean; reply: string; wechat: boolean }> {
  const acquired = await tryAcquireSendMarker(type);
  if (!acquired) {
    return { sent: false, reply: 'already sent today', wechat: false };
  }
  const report = await buildMorningReport(baseUrl);
  const title = `Morning Report — ${todayStr()}`;
  // ① 通知中心（pending.json 里每条带 type+date dedupeKey，前端入库时据此去重）
  await pushPending(title, report.text, report.items, type);
  // ② 微信（尽力而为，未绑定则跳过）
  let wechat = false;
  try {
    const { wechatBridge } = await import('@/lib/bridge/wechat-bridge');
    wechat = await wechatBridge.pushText(report.text);
  } catch (e) {
    console.error('[daily-report] 微信推送失败:', e);
    void logReportError(type, 'wechat', e);
  }
  console.log(`[daily-report] ${type} 报告已发送（微信:${wechat}）`);
  return { sent: true, reply: report.text, wechat };
}

/**
 * 发送每日 Sticky 报告（仅 BobMail，不推微信）：
 *   1. 原子抢占当天标记（sticky:YYYY-MM-DD，与 morning 互不干扰）
 *   2. 聚合全项目未完成 sticky 待办 → 三级折叠正文
 *   3. 进通知中心（pending.json，kind=inspect，前端落 INBOX 的 INSPECT 分类）
 */
export async function sendStickyReport(
  baseUrl: string,
): Promise<{ sent: boolean; reply: string; wechat: boolean }> {
  const acquired = await tryAcquireSendMarker('sticky');
  if (!acquired) {
    return { sent: false, reply: 'already sent today', wechat: false };
  }
  const { inspectStickyTodos, formatInspectReply } = await import('@/lib/wanted/inspect');
  const result = await inspectStickyTodos('all');
  const text = formatInspectReply(result);
  const title = `Sticky Report — ${todayStr()}`;
  // 仅通知中心（BobMail INSPECT 分类）；不推微信（正文较长，保持体验克制）
  await pushPending(title, text, [], 'sticky');
  console.log(`[daily-report] sticky 报告已发送（${result.totalPending} 项待办 / ${result.projectCount} 个项目）`);
  return { sent: true, reply: text, wechat: false };
}

/* ==================== Notes 维护（Karpathy 每日节奏锚点） ==================== */

/** 整库回看（review + lint）的周期：距离上次回看 ≥ N 天执行一次 */
const NOTES_REVIEW_INTERVAL_DAYS = 3;
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
 * 结果以一条 BobMail 通知（SCHEDULES 桶）摘要推送；无实质动作时静默。
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
  { kind: string; title: string; body: string; time: number; items: WantedNoticeItem[]; dedupeKey?: string }[]
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
    const tmp = `${PENDING_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, '[]', 'utf-8');
    const { rename } = await import('fs/promises');
    await rename(tmp, PENDING_FILE);
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
 * 启动每日报告调度（instrumentation 调用，幂等）：
 *   - 立即检查一次：已过当天 9:00 且当天未发 → 补发（morning + sticky，"每天第一次打开软件"兜底）
 *   - 之后每 5 分钟检查续期：已过 9:00 且未发 → 补发；重复调用由原子抢占（标记文件）去重
 */
export async function startDailyReportScheduler(): Promise<void> {
  const g = globalThis as unknown as { [SCHEDULER_KEY]?: boolean };
  if (g[SCHEDULER_KEY]) return;
  g[SCHEDULER_KEY] = true;

  const base = `http://localhost:${process.env.PORT || '5000'}`;
  const safeSend = async (type: DailyReportType) => {
    try {
      if (type === 'sticky') {
        await sendStickyReport(base);
      } else if (type === 'notes') {
        await sendNotesMaintenance();
      } else {
        await sendDailyReport(type, base);
      }
    } catch (e) {
      console.error(`[daily-report] ${type} 发送失败:`, e);
      void logReportError(type, 'send', e);
    }
  };

  // 到点判定：已过当天 9:00（未到 9:00 跳过，等下一次检查）；send* 内部原子抢占，重复调用天然去重
  const maybeSendDue = async () => {
    if (new Date().getHours() < SCHEDULE_HOUR) return;
    await Promise.all([safeSend('morning'), safeSend('sticky'), safeSend('notes')]);
  };

  // 立即检查一次（覆盖"当天首次打开已过 9:00"的兜底）+ 每 5 分钟循环续期
  void maybeSendDue();
  const timer = setInterval(() => void maybeSendDue(), CHECK_INTERVAL_MS);
  timer.unref?.(); // 不阻止进程退出

  console.log(`[daily-report] 每日调度已启动（每天 ${String(SCHEDULE_HOUR).padStart(2, '0')}:00 后每 ${CHECK_INTERVAL_MS / 60000} 分钟检查补发 Morning + Sticky 报告 + Notes 知识库维护）`);
}
