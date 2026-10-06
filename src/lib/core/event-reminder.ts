/**
 * Butler 日历提前提醒（kind='calendar' 通知的生产者）
 *
 * 多通知时间机制（取代旧「到点提醒」）：
 *  - 每个事件可配置多个「提前分钟数」（reminder_minutes_json，如 [30, 1440]）
 *  - 每个提前量到达时间点（start_time - offset）即触发一次提醒，互不干扰
 *  - 默认未配置 → 开始前 30 分钟提醒（DEFAULT_REMINDER_MINUTES）
 *  - reminder_sent_json 记录已触发的提前量，防同一时间点重复推送
 *
 * 周期提醒（recurrence_json，规则见 lib/calendar/recurrence.ts）：
 *  - 事件带 daily/weekly 规则时，扫描**按需展开**落在本次扫描窗口内的实例
 *    （不物料化事件行、不新建调度器），每个实例各自算 (实例开始 - 提前量) 是否到点；
 *  - reminder_sent_json 因此改成「实例开始ms:提前分钟」**复合键**——否则「昨天 9:00 已发 30 分钟提醒」
 *    会被误读成「今天 9:00 也发过了」，周期提醒从第二天起静默失效。
 *    历史遗留的纯数字偏移在读取时按本事件 start_time 归一化，行为与改造前一致。
 *
 * 调度策略（instrumentation 启动）：
 *  - 启动时立即扫描一次 → 应用关闭期间错过的提前提醒在下次打开时补发
 *  - 之后每 60s 扫描一次 → 运行中事件到点即提醒
 *
 * 与每日任务（daily-tasks）的分工：
 *  - 每日任务：每天 9:00 生成 Report 摘要（Today 面板）+ 知识库维护 + News 简报，不做即时提醒
 *  - 本模块：事件提前提醒（粒度更细，kind='calendar'）
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import { getCalendarDb, listScheduledEventsWithTime, markReminderSent } from '@/lib/db';
import { compareUrgency, loadNotifyPolicy } from '@/lib/core/quiet-hours';
import { occurrencesInWindowDetailed, parseRecurrence, recurrenceLabel } from '@/lib/calendar/recurrence';
import type { ButlerNoticeItem } from '@/lib/bus';

const APP_ROOT = resolveAppRoot();
const REMINDER_DIR = join(APP_ROOT, 'butler', 'event-reminders');
const PENDING_FILE = join(REMINDER_DIR, 'pending.json');

const SCAN_INTERVAL_MS = 60_000;

/** 事件开始后仍允许补发提醒的窗口（默认 24 小时）：
 *  应用关闭期间错过提前提醒的，下次打开时若事件已开始但未超过此窗口，仍补发一封。 */
const COMPENSATE_AFTER_START_MS = 24 * 3600 * 1000;

/** 待发布到通知中心的到期提醒（前端轮询 /api/butler/reminders 拉取，拉取后清空队列） */
export interface PendingReminder {
  title: string;
  body: string;
  time: number;
  items: ButlerNoticeItem[];
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

/**
 * 折叠一批到期提醒（B5 克制策略）：一次扫描产出多条时，通知中心只落一条
 * 「最紧急的一件 + 折叠计数」，避免同一时刻连推 N 条把用户淹没。
 *
 * 数据**不丢**：折叠条目仍整批带在 `items` 里 —— 抽屉 Today / 日历面板照常完整展示；
 * 这里收敛的只是**文案条数**（去重 key 沿用队首事件，其余事件的 reminder_sent 已落库，
 * 不会因折叠而重复补发）。
 *
 * 未开启策略（`butlerNotify.enabled` 默认 false）时原样返回 ⇒ 行为与改造前完全一致。
 */
async function foldReminderBatch(produced: PendingReminder[]): Promise<PendingReminder[]> {
  if (produced.length <= 1) return produced;
  const policy = await loadNotifyPolicy();
  if (!policy.enabled) return produced;
  const now = Date.now();
  const sorted = [...produced].sort((a, b) => {
    const ai = a.items[0];
    const bi = b.items[0];
    if (!ai || !bi) return 0;
    return compareUrgency(ai, bi, now);
  });
  const head = sorted[0];
  const rest = sorted.length - 1;
  return [{
    ...head,
    title: `${head.title}（+${rest}）`,
    body: `${head.body}\n…另有 ${rest} 项到期提醒（已折叠，避免刷屏）`,
    items: sorted.flatMap((p) => p.items),
  }];
}

/**
 * 服务端直推外部通道：日程提醒产出时并行推一条到微信与飞书（BobWork 后台运行时手机端也能收到）。
 * 两个桥未绑定 / 未运行（pushText 内部判断）时静默 no-op —— 桌面队列仍照常投递，不影响原链路。
 * 用 allSettled 保证任一通道失败既不影响另一通道，也不影响原链路。
 * 用动态 import 避免与桥形成模块初始化环（桥反向上游走 node-chat）。
 */
async function pushReminderToBridges(reminder: PendingReminder): Promise<void> {
  const text = reminder.body ? `${reminder.title}\n${reminder.body}` : reminder.title;
  const tasks = [
    import('@/lib/bridge/wechat-bridge').then(({ wechatBridge }) => wechatBridge.pushText(text)),
    import('@/lib/bridge/feishu-bridge').then(({ feishuBridge }) => feishuBridge.pushText(text)),
  ];
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn('[event-reminder] 通道推送失败:', r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
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

/** 已发提醒的复合键：`<实例开始ms>:<提前分钟>`（周期事件按实例区分，一次性事件实例恒为 start_time） */
function sentKey(instanceStartMs: number, offsetMinutes: number): string {
  return `${instanceStartMs}:${offsetMinutes}`;
}

/** 解析 reminder_sent_json → 已发键集合；兼容历史纯数字偏移（按本事件实例开始时间归一化） */
function parseSentKeys(raw: string | null | undefined, instanceStartMs: number): Set<string> {
  const keys = new Set<string>();
  if (!raw) return keys;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return keys;
    for (const it of arr) {
      if (typeof it === 'number' && Number.isFinite(it)) keys.add(sentKey(instanceStartMs, it));
      else if (typeof it === 'string' && /^\d+:\d+$/.test(it)) keys.add(it);
    }
  } catch { /* 非法 JSON → 视为未发过 */ }
  return keys;
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
      /** 本轮扫描产出的提醒（先收集、后投递：B5 折叠需要看到整批才知道该不该收敛条数） */
      const produced: PendingReminder[] = [];
      for (const ev of events) {
        if (!ev.start_time) continue;
        const startMs = new Date(ev.start_time).getTime();
        if (!Number.isFinite(startMs)) continue;

        const offsets = parseReminderMinutes(ev.reminder_minutes_json);
        if (offsets.length === 0) continue; // 明确取消提醒（reminder_minutes_json='null'）
        const maxOffsetMs = Math.max(...offsets) * 60_000;
        const rule = parseRecurrence(ev.recurrence_json);
        // 周期事件：只展开「落在本次扫描窗口内」的实例（开始时间 ∈ (now-补发窗口, now+最大提前量]）；
        // 一次性事件：实例恒为自身 start_time（行为与改造前完全一致）。
        // 用 Detailed 版是为了拿到 DETACH 改写后的「生效开始 + 覆盖标题」。
        const instances = rule
          ? occurrencesInWindowDetailed(ev.start_time, rule, now, {
              windowBeforeMs: COMPENSATE_AFTER_START_MS,
              windowAfterMs: maxOffsetMs,
            })
          : [{ startMs, originalStartMs: startMs, modified: false }];
        if (instances.length === 0) continue;

        const repeatLabel = rule ? recurrenceLabel(rule) : null;
        const repeatTag = repeatLabel ? ` · repeats ${repeatLabel}` : '';
        // 实例时长沿用原始 start→end 的跨度（周期实例的 end 相对实例开始平移）
        const durationMs =
          ev.end_time && Number.isFinite(Date.parse(ev.end_time)) ? Date.parse(ev.end_time) - startMs : 0;
        const sentKeys = parseSentKeys(ev.reminder_sent_json, startMs);
        let changed = false;

        for (const occ of instances) {
          const occMs = occ.startMs;
          // 该实例若被 DETACH 改写，标题取改写值（否则沿用事件标题）
          const occTitle = occ.title ?? ev.title;
          const occIso = new Date(occMs).toISOString();
          const occEndIso = durationMs > 0 ? new Date(occMs + durationMs).toISOString() : null;
          for (const offset of offsets) {
            const key = sentKey(occMs, offset);
            // 该实例的该提前量已发过 → 跳过（防重复推送；周期事件按实例区分，跨天不会误判）
            if (sentKeys.has(key)) continue;
            const remindAt = occMs - offset * 60_000;
            // 提醒时间点已到 且 实例开始后未超过补发窗口 → 触发一次
            // （放宽 now < occMs 限制：应用关闭期间错过的提前提醒，下次打开时仍可补发）
            if (remindAt <= now && now < occMs + COMPENSATE_AFTER_START_MS) {
              const items: ButlerNoticeItem[] = [{
                key: ev.event_id,
                title: occTitle,
                time: occIso,
                startMs: occMs,
                status: ev.status,
                priority: ev.priority,
                allDay: ev.all_day === 1,
                // 接真实链路：key = 日历事件 id → 勾选完成时 PATCH 事件状态（scheduled ⇄ done），
                // 日历面板 / 便签层随之联动。缺这个字段时 toggleItem 只翻转通知内的本地勾选，
                // 日历不会变（2026-09-27 修：日程提醒点完成后日历不显示完成）。
                source: 'event',
              }];
              const isOverdue = now >= occMs;
              // 标题不再带 ⏰ 前缀：抽屉卡片的类型图标（CalendarClock）已经表达了「这是日程」，
              // 前面再来一个闹钟就是同一个意思说两遍。⚠️ 保留——它表达的是「已过期」，图标里没有这层信息。
              const title = isOverdue ? `⚠️ ${occTitle}` : occTitle;
              const timeInfo = fmtEventTime(occIso, occEndIso, ev.all_day === 1);
              const body = isOverdue
                ? `${timeInfo} · overdue${repeatTag} · ${occTitle}`
                : `${timeInfo} · in ~${fmtReminderOffset(offset)}${repeatTag} · ${occTitle}`;
              produced.push({
                title,
                body,
                time: Date.now(),
                items,
                // 去重 key：event_id + 实例开始 + 提前量（周期实例彼此独立触发）
                dedupeKey: `evt:${ev.event_id}:${occMs}:${offset}`,
              });
              count += 1;
              sentKeys.add(key);
              changed = true;
            }
          }
        }
        if (changed) {
          // 只保留「仍可能再触发」的键：实例开始 ≥ now - 补发窗口（更早的实例其提醒点与补发窗口
          // 均已关闭，留着也不会再触发）。否则无限重复的每日提醒会让 reminder_sent_json 按天线性膨胀。
          const keepFrom = now - COMPENSATE_AFTER_START_MS;
          const pruned = [...sentKeys].filter((k) => {
            const ms = Number(k.slice(0, k.indexOf(':')));
            return Number.isFinite(ms) && ms >= keepFrom;
          });
          await markReminderSent(db, ev.event_id, pruned);
        }
      }

      // 投递（扫描已持有全局锁，直接走不拿锁的内部写入，避免对同一把锁二次 acquire 造成死锁）
      for (const r of await foldReminderBatch(produced)) {
        await pushPendingReminderUnlocked(r);
        // 并行直推外部通道（微信 + 飞书）：网络投递与桌面队列解耦，不阻塞扫描（失败仅在内部记日志）
        void pushReminderToBridges(r);
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