/**
 * WANTED 日历提前提醒（kind='calendar' 通知的生产者）
 *
 * 多通知时间机制（取代旧「到点提醒」）：
 *  - 每个事件可配置多个「提前分钟数」（reminder_minutes_json，如 [30, 1440]）
 *  - 每个提前量到达时间点（start_time - offset）即触发一次提醒，互不干扰
 *  - 默认未配置 → 开始前 30 分钟提醒（DEFAULT_REMINDER_MINUTES）
 *  - reminder_sent_json 记录已触发的提前量，防同一时间点重复推送
 *
 * 调度策略（instrumentation 启动）：
 *  - 启动时立即扫描一次 → 应用关闭期间错过的提前提醒在下次打开时补发
 *  - 之后每 60s 扫描一次 → 运行中事件到点即提醒
 *
 * 与每日报告（daily-report）的分工：
 *  - 每日报告：每天 9:00 汇总"今日待办 + 已过期"- 整体概览
 *  - 本模块：事件提前提醒（粒度更细，kind='calendar'）
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import { getCalendarDb, listScheduledEventsWithTime, markReminderSent } from '@/lib/db';
import type { WantedNoticeItem } from '@/lib/bus';

const APP_ROOT = resolveAppRoot();
const REMINDER_DIR = join(APP_ROOT, 'wanted', 'event-reminders');
const PENDING_FILE = join(REMINDER_DIR, 'pending.json');

const SCAN_INTERVAL_MS = 60_000;

/** 事件开始后仍允许补发提醒的窗口（默认 24 小时）：
 *  应用关闭期间错过提前提醒的，下次打开时若事件已开始但未超过此窗口，仍补发一封。 */
const COMPENSATE_AFTER_START_MS = 24 * 3600 * 1000;

/** 待发布到通知中心的到期提醒（前端轮询 /api/wanted/reminders 拉取，拉取后清空队列） */
export interface PendingReminder {
  title: string;
  body: string;
  time: number;
  items: WantedNoticeItem[];
  /** 去重 key：event_id 级别，防止同一事件被并发扫描多次写入 */
  dedupeKey?: string;
}

/** 进程内互斥锁：扫描 / pending 写入 / pending 读取共享同一把锁，串行化防止竞态 */
let _lock: Promise<void> | null = null;
async function acquire<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _lock ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  _lock = next;
  try {
    await prev;
    return await fn();
  } finally {
    resolve();
    if (_lock === next) _lock = null;
  }
}

/** 写入待发布队列（保留最近 100 条，不拿锁）
 *  - 仅供 scanDueEventReminders 持有全局锁时内部调用（scanProjectReminders）；
 *    若在此处再 acquire 会对同一把锁二次加锁造成死锁（外层锁等内层释放、内层等外层释放）。
 *  - dedupeKey 去重：同一 event_id 在当前队列已存在则跳过（并发扫描时同一事件被 push 两次）
 */
async function pushPendingReminderUnlocked(reminder: PendingReminder): Promise<void> {
  try {
    await mkdir(REMINDER_DIR, { recursive: true });
    let pending: PendingReminder[] = [];
    try {
      const raw = await readFile(PENDING_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) pending = parsed;
    } catch { /* 无文件或损坏则从空开始 */ }
    if (reminder.dedupeKey && pending.some((p) => p.dedupeKey === reminder.dedupeKey)) {
      return; // 同一事件已在队列中，跳过重复写入
    }
    pending.push(reminder);
    await writeFile(PENDING_FILE, JSON.stringify(pending.slice(-100)), 'utf-8');
  } catch (e) {
    console.error('[event-reminder] 写入通知队列失败:', e);
  }
}

/** 拉取待发布的到期提醒（前端轮询调用），拉取后清空队列
 *  - 加锁串行化：读后清空中途如果有另一个并发 fetch，会排队等待本次清空后再读（读到空数组正常）
 */
export async function takePendingReminders(): Promise<PendingReminder[]> {
  return acquire(async () => {
    try {
      const raw = await readFile(PENDING_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      await writeFile(PENDING_FILE, '[]', 'utf-8');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
}

/** 格式化事件时间为提醒正文（本地时区 MM/DD HH:mm） */
function fmtEventTime(startIso: string, endIso: string | null, allDay: boolean): string {
  const d = new Date(startIso);
  if (!Number.isFinite(d.getTime())) return startIso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  if (allDay) return `${date} All-day`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (endIso) {
    const e = new Date(endIso);
    if (Number.isFinite(e.getTime())) {
      return `${date} ${time} - ${pad(e.getHours())}:${pad(e.getMinutes())}`;
    }
  }
  return `${date} ${time}`;
}

/** 默认提前通知：开始前 30 分钟 */
const DEFAULT_REMINDER_MINUTES = [30];

/** 解析 JSON 分钟数组；空/非法 → 返回 fallback（默认 [30]）；字符串 'null' = 明确取消提醒（返回空数组）。去重并按大到小排序（先发更早的提醒） */
function parseReminderMinutes(raw: string | null | undefined, fallback: number[] = DEFAULT_REMINDER_MINUTES): number[] {
  if (!raw) return fallback;
  if (raw === 'null') return []; // 存储语义：明确取消提醒（与「未配置」区分）
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) {
      const nums = arr
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length > 0) return [...new Set(nums)].sort((a, b) => b - a);
    }
  } catch { /* 非法 JSON 走默认 */ }
  return fallback;
}

/** 把提前分钟数格式化为人类可读（"30 min" / "1 h" / "1 day"） */
function fmtReminderOffset(minutes: number): string {
  if (minutes >= 1440) {
    const days = minutes / 1440;
    return days === Math.floor(days) ? `${days} day` : `${days.toFixed(1)} day`;
  }
  if (minutes >= 60) {
    const h = minutes / 60;
    return h === Math.floor(h) ? `${h} h` : `${h.toFixed(1)} h`;
  }
  return `${minutes} min`;
}

/**
 * 主扫描：读取全局日历库（.calendar.db，与项目完全独立）中所有到期待办并生成提醒。
 * 返回本次共生成的提醒数。
 * - 加锁串行化：instrumentation 定时扫描 与 calendar/events 路由主动扫描，
 *   两者并发执行时会排队等待，避免同一批事件被重复处理。
 */
export async function scanDueEventReminders(): Promise<number> {
  return acquire(async () => {
    try {
      const db = await getCalendarDb();
      const events = await listScheduledEventsWithTime(db, null);
      if (events.length === 0) return 0;

      const now = Date.now();
      let count = 0;
      for (const ev of events) {
        if (!ev.start_time) continue;
        const startMs = new Date(ev.start_time).getTime();
        if (!Number.isFinite(startMs)) continue;

        const offsets = parseReminderMinutes(ev.reminder_minutes_json);
        const sent = parseReminderMinutes(ev.reminder_sent_json, []);
        let newSent: number[] | null = null;

        for (const offset of offsets) {
          // 已触发过该提前量 → 跳过（防重复推送）
          if (sent.includes(offset)) continue;
          const remindAt = startMs - offset * 60_000;
          // 提醒时间点已到 且 事件开始后未超过补发窗口 → 触发一次
          // （放宽 now < startMs 限制：应用关闭期间错过的提前提醒，下次打开时仍可补发）
          if (remindAt <= now && now < startMs + COMPENSATE_AFTER_START_MS) {
            const items: WantedNoticeItem[] = [{
              key: ev.event_id,
              title: ev.title,
              time: ev.start_time,
              startMs,
              status: ev.status,
              priority: ev.priority,
              allDay: ev.all_day === 1,
            }];
            const isOverdue = now >= startMs;
            const title = isOverdue ? `⚠️ ${ev.title}` : `⏰ ${ev.title}`;
            const timeInfo = fmtEventTime(ev.start_time, ev.end_time, ev.all_day === 1);
            const body = isOverdue
              ? `${timeInfo} · overdue · ${ev.title}`
              : `${timeInfo} · in ~${fmtReminderOffset(offset)} · ${ev.title}`;
            // 扫描已持有全局锁（scanDueEventReminders 的 acquire），直接走不拿锁的内部写入，
            // 避免对同一把锁二次 acquire 造成死锁
            await pushPendingReminderUnlocked({
              title,
              body,
              time: Date.now(),
              items,
              // 去重 key：event_id + 提前量（同一事件多个通知时间各自独立触发）
              dedupeKey: `evt:${ev.event_id}:${offset}`,
            });
            count += 1;
            if (!newSent) newSent = [...sent];
            newSent.push(offset);
          }
        }
        if (newSent) {
          await markReminderSent(db, ev.event_id, newSent);
        }
      }
      if (count > 0) {
        console.log(`[event-reminder] 本次扫描生成 ${count} 条到期提醒`);
      }
      return count;
    } catch (e) {
      console.error('[event-reminder] 扫描失败:', e);
      return 0;
    }
  });
}

const SCHEDULER_KEY = '__eventReminderSchedulerStarted__';

/**
 * 启动到期提醒调度（instrumentation 调用，幂等）：
 *   - 启动时立即扫描一次（补发应用关闭期间遗漏的到期提醒）
 *   - 之后每 60s 扫描一次（运行中事件到点即提醒）
 */
export async function startEventReminderScheduler(): Promise<void> {
  const g = globalThis as unknown as { [SCHEDULER_KEY]?: boolean };
  if (g[SCHEDULER_KEY]) return;
  g[SCHEDULER_KEY] = true;

  // 启动补发：应用关闭期间错过的到期提醒在下次打开时立即通知
  try {
    await scanDueEventReminders();
  } catch (e) {
    console.error('[event-reminder] 启动补发失败:', e);
  }

  const loop = () => {
    setTimeout(() => {
      void scanDueEventReminders().catch((e) => {
        console.error('[event-reminder] 周期扫描失败:', e);
      });
      loop();
    }, SCAN_INTERVAL_MS);
  };
  loop();

  console.log(`[event-reminder] 到期提醒调度已启动（每 ${SCAN_INTERVAL_MS / 1000}s 扫描一次）`);
}