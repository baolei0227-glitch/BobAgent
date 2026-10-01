/**
 * 确定性排程器（纯函数，无 IO）
 *
 * 目标：给「未排程的任务」（kind='task' 且 start_time IS NULL）在给定工作时段内找执行块，
 * 满足硬约束、按固定排序做 first-fit 贪心。**同输入必同输出**（无随机、无当前时钟读取，
 * now 由调用方注入），因此结果可断言、可回归。
 *
 * 硬约束：
 *   - 不与 busy（已有日程 + 已锁定块）重叠（可含 buffer）；
 *   - 执行块完整落在工作时段内（工作日 + 起止时刻，按 tz 判定本地时间）；
 *   - 若任务有 due_at，则必须在截止前完成；
 *   - 不越过 horizon（now + horizonDays）；
 *   - block_locked 的任务不参与（调用方应把它们放进 busy）。
 *
 * 软约束（由排序键体现，不做回溯优化）：
 *   - 截止临近优先、优先级高优先、创建早优先、id 稳定兜底。
 */

export interface SchedulableTask {
  event_id: string;
  title: string;
  priority?: string | null;
  due_at?: string | null;
  estimated_minutes?: number | null;
  block_locked?: boolean;
  /** 允许的最早开始（如未来才可做） */
  earliest_start?: string | null;
  created_at?: string | null;
}

export interface BusyBlock {
  start: string;
  end: string;
}

export interface WorkingHours {
  tz: string;
  /** 工作日：0=周日 … 6=周六 */
  days: number[];
  /** 本地时刻 'HH:MM' */
  start: string;
  /** 本地时刻 'HH:MM'（执行块须在此前结束） */
  end: string;
  /** 相邻块之间保留的空隙（分钟） */
  bufferMinutes?: number;
}

export interface SolveInput {
  tasks: SchedulableTask[];
  busy: BusyBlock[];
  workingHours: WorkingHours;
  /** 注入的当前时刻（ISO），保证纯函数可复现 */
  now: string;
  horizonDays?: number;
}

export interface SolveAssignment {
  event_id: string;
  start: string;
  end: string;
}

export interface SolveUnplaced {
  event_id: string;
  reason: string;
}

export interface SolveResult {
  assignments: SolveAssignment[];
  unplaced: SolveUnplaced[];
}

/** 候选起点的对齐步长（分钟）：固定网格 → 结果稳定可复现 */
const STEP_MINUTES = 15;
/** 未提供估时时的默认块长度（分钟） */
const DEFAULT_BLOCK_MINUTES = 30;
const DEFAULT_HORIZON_DAYS = 14;

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  tz: 'Asia/Shanghai',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
  bufferMinutes: 10,
};

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  minutes: number; // 本地时刻的当日分钟数
  dow: number;
}

/** 把 UTC 时刻按 tz 拆成「本地日历分量」（用于工作日/工作时段判定） */
function localParts(iso: string, tz: string): LocalParts {
  const parts = formatterFor(tz).formatToParts(new Date(iso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const hourRaw = get('hour');
  const hour = hourRaw === '24' ? 0 : Number(hourRaw);
  return {
    y: Number(get('year')),
    mo: Number(get('month')),
    d: Number(get('day')),
    minutes: hour * 60 + Number(get('minute')),
    dow: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** 'HH:MM' → 当日分钟数 */
function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function alignUp(ms: number, stepMs: number): number {
  return Math.ceil(ms / stepMs) * stepMs;
}

/**
 * 运行排程。纯函数：不读时钟、不落库、不改入参。
 */
export function solveSchedule(input: SolveInput): SolveResult {
  const wh = input.workingHours;
  const bufferMs = Math.max(0, wh.bufferMinutes ?? 0) * 60_000;
  const stepMs = STEP_MINUTES * 60_000;
  const whStartMin = parseHm(wh.start);
  const whEndMin = parseHm(wh.end);
  const nowMs = Date.parse(input.now);
  const horizonMs = nowMs + (input.horizonDays ?? DEFAULT_HORIZON_DAYS) * 86_400_000;

  // 排序键固定：due asc（无 due 排最后）→ 优先级 → created_at → event_id
  const tasks = input.tasks
    .filter((t) => !t.block_locked)
    .slice()
    .sort((a, b) => {
      const da = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
      const db = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      const pa = PRIORITY_RANK[a.priority ?? 'normal'] ?? 1;
      const pb = PRIORITY_RANK[b.priority ?? 'normal'] ?? 1;
      if (pa !== pb) return pa - pb;
      const ca = a.created_at ?? '';
      const cb = b.created_at ?? '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
    });

  // 忙块：区间 [start, end + buffer)
  const busy = input.busy
    .map((b) => {
      const s = Date.parse(b.start);
      const e = Date.parse(b.end);
      return Number.isFinite(s) && Number.isFinite(e) && e > s ? { s, e: e + bufferMs } : null;
    })
    .filter((x): x is { s: number; e: number } => x !== null);

  const assignments: SolveAssignment[] = [];
  const unplaced: SolveUnplaced[] = [];

  for (const task of tasks) {
    const blockMs = (task.estimated_minutes && task.estimated_minutes > 0
      ? task.estimated_minutes
      : DEFAULT_BLOCK_MINUTES) * 60_000;
    const dueMs = task.due_at ? Date.parse(task.due_at) : Number.POSITIVE_INFINITY;
    const earliestMs = task.earliest_start ? Date.parse(task.earliest_start) : nowMs;
    let cursor = alignUp(Math.max(nowMs, Number.isFinite(earliestMs) ? earliestMs : nowMs), stepMs);

    let placed: { start: number; end: number } | null = null;
    let reason = 'no_slot_in_horizon';

    while (cursor <= horizonMs) {
      const end = cursor + blockMs;
      const lp = localParts(new Date(cursor).toISOString(), wh.tz);
      const localEnd = lp.minutes + blockMs / 60_000;

      if (!wh.days.includes(lp.dow) || lp.minutes < whStartMin || localEnd > whEndMin) {
        // 不在工作时段 → 直接跳到下一个网格点（保持步长网格以维持确定性）
        cursor += stepMs;
        continue;
      }
      if (end > dueMs) {
        reason = 'due_too_earlier';
        break; // 该网格已晚于截止，后续只会更晚
      }
      const conflict = busy.some((b) => cursor < b.e && end > b.s);
      if (conflict) {
        cursor += stepMs;
        continue;
      }
      placed = { start: cursor, end };
      break;
    }

    if (!placed) {
      unplaced.push({ event_id: task.event_id, reason: task.due_at ? 'no_slot_before_due' : reason });
      continue;
    }

    assignments.push({
      event_id: task.event_id,
      start: new Date(placed.start).toISOString(),
      end: new Date(placed.end).toISOString(),
    });
    busy.push({ s: placed.start, e: placed.end + bufferMs });
    busy.sort((a, b) => a.s - b.s);
  }

  // 输出按开始时间排序（与贪心顺序无关的稳定视图）
  assignments.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { assignments, unplaced };
}
