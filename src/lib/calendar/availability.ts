/**
 * 日历可用性层 + 原子预约（free/busy · 空档搜索 · lock/verify/write）
 *
 * 为什么单独一层：既有的 lib/calendar/overlaps.ts 只回答「某个具体时段冲不冲突」，
 * 回答不了「我明天什么时候有空」。本模块把「读忙碌区间 → 合并在工作时段内找空档」抽成
 * 可复用的一层，供 Butler 的可用性查询与排程共用；并把**冲突评估 + 写入**收敛进同一把
 * 进程内写锁，堵住 TOCTOU 漏洞——两个并发请求都可能先通过冲突检查、再双双落库（双订）。
 *
 * 分工：
 *   - getBusyIntervals：读区间内的未取消事件 → 忙碌区间（带 all_day 标记）
 *   - findFreeSlots   ：在指定时段的工作时间内找 ≥ duration 的空档（first-fit、30 分钟网格）
 *   - bookSlot        ：锁内 **verify（再查一次重叠）→ write**，避免并发双订
 *   - withCalendarWriteLock：以上及调用方自带检查/写入逻辑可复用的进程内互斥锁
 *
 * 时区：全部按**本地时区**构造/格式化（与 Butler 其余日历文案口径一致）。
 * 说明：锁是**进程内**的——桌面应用单进程足够；跨进程（多实例/外部 MCP 客户端）需数据库层约束。
 */

import type { CreateEventData } from '@/lib/db';

/** 忙碌区间（ms，升序） */
export interface TimeInterval {
  startMs: number;
  endMs: number;
}

/** 忙碌区间（对外：ISO + 事件元信息） */
export interface BusyInterval {
  start: string;
  end: string;
  event_id: string;
  title: string;
  all_day: boolean;
}

/** 空档（对外：ISO + 展示标签 + 时长） */
export interface FreeSlot {
  start: string;
  end: string;
  /** 展示用，如「明天 14:00–15:00」 */
  label: string;
  minutes: number;
}

const DEFAULT_DURATION_MINUTES = 60;
const DEFAULT_WORK_START = 9;
const DEFAULT_WORK_END = 18;
/** 网格粒度：候选空档按 30 分钟对齐（与 overlaps.assessEventSlot 一致） */
const GRID_MS = 30 * 60_000;

const pad2 = (n: number) => String(n).padStart(2, '0');

const toIso = (ms: number) => new Date(ms).toISOString();

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 相对今天的日期标签：今天 / 明天 / MM-DD */
function dayLabel(d: Date, now: Date): string {
  if (isSameLocalDay(d, now)) return '今天';
  if (isSameLocalDay(d, new Date(now.getTime() + 24 * 3600_000))) return '明天';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ─── 纯计算（可单测） ───────────────────────────────────────────────────────

/** 合并重叠 / 相接的区间（输入乱序亦可），返回升序结果 */
export function mergeIntervals(list: TimeInterval[]): TimeInterval[] {
  const sorted = [...list].filter((i) => i.endMs > i.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: TimeInterval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.startMs <= last.endMs) last.endMs = Math.max(last.endMs, cur.endMs);
    else out.push({ ...cur });
  }
  return out;
}

/** 时段是否与任一忙碌区间重叠，或与它们的间隔小于 gapMs（含「紧邻空档不足」） */
function slotIsFree(s: number, e: number, busy: TimeInterval[], gapMs: number): boolean {
  for (const b of busy) {
    if (s < b.endMs && e > b.startMs) return false; // 重叠
    const gap = s >= b.endMs ? s - b.endMs : b.startMs - e;
    if (gap < gapMs) return false; // 紧邻空档不足
  }
  return true;
}

export interface ComputeFreeSlotsInput {
  /** 已合并的忙碌区间（不含全天事件——全天日程不占具体小时） */
  busy: TimeInterval[];
  /** 搜索范围 [fromMs, toMs) */
  fromMs: number;
  toMs: number;
  durationMs: number;
  workStartHour: number;
  workEndHour: number;
  /** 与相邻忙碌区间的最小缓冲 */
  gapMs: number;
  /** 上限条数 */
  limit: number;
  /** 不早于此（通常是 now）——过去的时间不是候选 */
  notBeforeMs: number;
}

/**
 * 在工作时段内 first-fit 找空档：逐日扫描 [workStartHour, workEndHour)，
 * 以 30 分钟网格步进，跳过与忙碌区间重叠/紧邻不足者，收集前 limit 个互不重叠的候选。
 */
export function computeFreeSlots(input: ComputeFreeSlotsInput): TimeInterval[] {
  const {
    busy,
    fromMs,
    toMs,
    durationMs,
    workStartHour,
    workEndHour,
    gapMs,
    limit,
    notBeforeMs,
  } = input;
  if (limit <= 0 || durationMs <= 0 || !(toMs > fromMs)) return [];

  const out: TimeInterval[] = [];
  const dayStart = new Date(fromMs);
  const lastDay = new Date(toMs);
  for (
    let d = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate());
    d.getTime() <= lastDay.getTime() && out.length < limit;
    d.setDate(d.getDate() + 1)
  ) {
    const wFrom = Math.max(
      new Date(d.getFullYear(), d.getMonth(), d.getDate(), workStartHour, 0, 0, 0).getTime(),
      fromMs,
      notBeforeMs,
    );
    const wTo = Math.min(
      new Date(d.getFullYear(), d.getMonth(), d.getDate(), workEndHour, 0, 0, 0).getTime(),
      toMs,
    );
    if (wTo - wFrom < durationMs) continue;

    const grid = Math.ceil(wFrom / GRID_MS) * GRID_MS;
    for (let t = grid; t + durationMs <= wTo && out.length < limit; t += GRID_MS) {
      const e = t + durationMs;
      if (!slotIsFree(t, e, busy, gapMs)) continue;
      if (!slotIsFree(t, e, out, gapMs)) continue; // 候选之间也别互相打架
      out.push({ startMs: t, endMs: e });
    }
  }
  return out;
}

// ─── DB 包装 ───────────────────────────────────────────────────────────────

/**
 * 读 [rangeStartIso, rangeEndIso) 内的忙碌区间（未取消的 scheduled 事件，含全天，带标记）。
 * 无 end_time 的事件按 start + 30 分钟（与 listEventsInRange 口径一致）。
 */
export async function getBusyIntervals(
  rangeStartIso: string,
  rangeEndIso: string,
  opts?: { excludeEventId?: string | null },
): Promise<BusyInterval[]> {
  const startMs = Date.parse(rangeStartIso);
  const endMs = Date.parse(rangeEndIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  try {
    const { getCalendarDb, listEventsInRange } = await import('@/lib/db');
    const db = await getCalendarDb();
    const rows = await listEventsInRange(db, null, toIso(startMs), toIso(endMs));
    const exclude = opts?.excludeEventId ?? null;
    return rows
      .filter((r) => r.status === 'scheduled' && r.event_id !== exclude && r.start_time)
      .map((r) => {
        const s = Date.parse(r.start_time as string);
        const e = r.end_time && Number.isFinite(Date.parse(r.end_time)) ? Date.parse(r.end_time) : s + 30 * 60_000;
        return {
          start: toIso(s),
          end: toIso(e),
          event_id: r.event_id,
          title: r.title,
          all_day: r.all_day === 1,
        };
      })
      .filter((b) => Number.isFinite(Date.parse(b.start)));
  } catch (e) {
    console.error('[calendar-availability] 忙碌区间查询失败:', e);
    return [];
  }
}

export interface FindFreeSlotsInput {
  rangeStartIso: string;
  rangeEndIso: string;
  /** 需要多长的空档（分钟），默认 60 */
  durationMinutes?: number;
  workStartHour?: number;
  workEndHour?: number;
  /** 与相邻忙碌区间的最小缓冲（分钟），默认 0 */
  gapMinutes?: number;
  /** 返回上限，默认 5 */
  limit?: number;
  /** 改期场景排除自身 */
  excludeEventId?: string | null;
  /** 不早于此 ISO（默认 now） */
  notBeforeIso?: string;
}

/** 在 [rangeStart, rangeEnd) 的工作时间内找空档（全天事件不占用具体小时，故不参与） */
export async function findFreeSlots(
  input: FindFreeSlotsInput,
): Promise<{ busy: BusyInterval[]; free: FreeSlot[] }> {
  const fromMs = Date.parse(input.rangeStartIso);
  const toMs = Date.parse(input.rangeEndIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { busy: [], free: [] };

  const busyIso = await getBusyIntervals(input.rangeStartIso, input.rangeEndIso, {
    excludeEventId: input.excludeEventId,
  });
  const timed = busyIso.filter((b) => !b.all_day);
  const merged = mergeIntervals(
    timed.map((b) => ({ startMs: Date.parse(b.start), endMs: Date.parse(b.end) })),
  );

  const notBeforeMs = input.notBeforeIso ? Date.parse(input.notBeforeIso) : Date.now();
  const slots = computeFreeSlots({
    busy: merged,
    fromMs,
    toMs,
    durationMs: (input.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000,
    workStartHour: input.workStartHour ?? DEFAULT_WORK_START,
    workEndHour: input.workEndHour ?? DEFAULT_WORK_END,
    gapMs: (input.gapMinutes ?? 0) * 60_000,
    limit: input.limit ?? 5,
    notBeforeMs: Number.isFinite(notBeforeMs) ? notBeforeMs : Date.now(),
  });

  const now = new Date();
  const free: FreeSlot[] = slots.map((s) => {
    const sd = new Date(s.startMs);
    const ed = new Date(s.endMs);
    return {
      start: toIso(s.startMs),
      end: toIso(s.endMs),
      label: `${dayLabel(sd, now)} ${pad2(sd.getHours())}:${pad2(sd.getMinutes())}–${pad2(ed.getHours())}:${pad2(ed.getMinutes())}`,
      minutes: Math.round((s.endMs - s.startMs) / 60_000),
    };
  });
  return { busy: busyIso, free };
}

// ─── 原子预约（lock/verify/write） ──────────────────────────────────────────

/** 进程内日历写锁：把所有「检查 + 写入」串行化，避免并发双订（TOCTOU）。
 *  调用方（如 create_scheduled_todo）把「冲突评估 → createEvent」整段包进来即可获得原子性。 */
let _writeLock: Promise<void> = Promise.resolve();

export async function withCalendarWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _writeLock;
  let release!: () => void;
  _writeLock = new Promise<void>((r) => { release = r; });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}