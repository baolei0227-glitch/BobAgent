/**
 * 排程器入口（IO 层）：读任务/忙块 → 调纯函数 solveSchedule → 落库。
 *
 * 候选任务（两类）：
 *   ① 未排程：kind='task'、status='scheduled'、无 start_time，且有 due_at 或 estimated_minutes
 *      —— 没有时间约束的散活不强行占用日历；
 *   ② 已排但可动：scheduled_by='scheduler'、未锁定、开始时刻仍在未来 —— 重排时可整体重算
 *      （已过去的块视为历史，不再移动）。
 * 用户手工排的块（scheduled_by='user'）与锁定块（block_locked=1）永不被移动，只作为忙块避开。
 *
 * 工作时段来自 AppSettings.calendarWorkingHours（可缺省，缺省用 DEFAULT_WORKING_HOURS）。
 */

// 本模块静态依赖 db（读候选任务 / 落排程结果），而 db 在写入时以**动态 import** 反向调用
// 本模块的 scheduleReplan() 触发去抖重排 —— 该环是有意的，且运行时安全：db 从不静态依赖
// 本模块，故不存在「先加载谁」的初始化顺序问题（详见 db/index.ts 同处注解）。
// eslint-disable-next-line import/no-cycle -- 见上：有意的环打断，运行时安全
import { getCalendarDb, updateEvent, getScheduleMeta, setSchedulePlanOk, type EventRow } from '@/lib/db';
import {
  solveSchedule,
  DEFAULT_WORKING_HOURS,
  type BusyBlock,
  type SchedulableTask,
  type WorkingHours,
} from './solve';
import { calibrateEstimate, calibrationFactors } from '../analytics';

export interface RunScheduleResult {
  placed: number;
  unplaced: number;
  assignments: Array<{ event_id: string; title: string; start: string; end: string }>;
  unplaced_tasks: Array<{ event_id: string; title: string; reason: string }>;
}

/** 排程状态（供只读工具 / 面板展示） */
export interface ScheduleStatus {
  /** 'ok' 计划最新 | 'stale' 变更未重排（3s 内会自动重排） */
  status: string;
  version: number;
  dirty_at: string | null;
  last_planned_at: string | null;
  /** 已被排程器安排时段的任务数 */
  scheduled_count: number;
  /** 计划已过期（待重排）的任务数 */
  stale_count: number;
  /** 尚无时段、等待安排的任务 */
  unscheduled_tasks: Array<{
    event_id: string;
    title: string;
    due_at: string | null;
    estimated_minutes: number | null;
  }>;
}

/** 读取工作时段配置（未配置 → 默认工作日 09:00–18:00 / Asia/Shanghai / 10min buffer） */
export async function loadWorkingHours(): Promise<WorkingHours> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    const configured = (settings as unknown as { calendarWorkingHours?: Partial<WorkingHours> })
      .calendarWorkingHours;
    if (configured && typeof configured === 'object') {
      return {
        ...DEFAULT_WORKING_HOURS,
        ...configured,
        days:
          Array.isArray(configured.days) && configured.days.length > 0
            ? configured.days
            : DEFAULT_WORKING_HOURS.days,
      };
    }
  } catch {
    // 设置读取失败不影响排程：退回默认工作时段
  }
  return DEFAULT_WORKING_HOURS;
}

/** 未排程的任务（kind='task' 且无 start_time，且有 due_at 或 est） */
export async function listUnscheduledTasks(
  db: Awaited<ReturnType<typeof getCalendarDb>>,
): Promise<EventRow[]> {
  return db
    .prepare(`
      SELECT * FROM events
      WHERE kind = 'task'
        AND status = 'scheduled'
        AND (start_time IS NULL OR TRIM(start_time) = '')
        AND (due_at IS NOT NULL OR estimated_minutes IS NOT NULL)
      ORDER BY COALESCE(due_at, '9999') ASC
    `)
    .all() as EventRow[];
}

/**
 * 排程候选：未排程任务 + 仍可移动的已排任务（排程器排的、未锁定、开始时刻在未来）。
 * `now` 参与判定，保证「已过去/进行中的块」不被重排抹掉。
 */
async function listSchedulableTasks(
  db: Awaited<ReturnType<typeof getCalendarDb>>,
  now: string,
): Promise<EventRow[]> {
  return db
    .prepare(`
      SELECT * FROM events
      WHERE kind = 'task'
        AND status = 'scheduled'
        AND (due_at IS NOT NULL OR estimated_minutes IS NOT NULL)
        AND (
          (start_time IS NULL OR TRIM(start_time) = '')
          OR (
            scheduled_by = 'scheduler'
            AND COALESCE(block_locked, 0) = 0
            AND datetime(start_time) >= datetime(?)
          )
        )
      ORDER BY COALESCE(due_at, '9999') ASC
    `)
    .all(now) as EventRow[];
}

/**
 * 运行一次排程并落库。
 * @param opts.horizonDays 排程视野（默认 14 天）
 * @param opts.now 注入当前时刻（测试可复现）
 * @param opts.dryRun true = 只算不写（同时不动 schedule_meta，避免把 stale 洗成 ok）
 */
export async function runScheduler(
  opts: { horizonDays?: number; now?: string; dryRun?: boolean } = {},
): Promise<RunScheduleResult> {
  const db = await getCalendarDb();
  const now = opts.now ?? new Date().toISOString();
  const horizonDays = opts.horizonDays ?? 14;
  const horizonEnd = new Date(Date.parse(now) + horizonDays * 86_400_000).toISOString();

  const taskRows = await listSchedulableTasks(db, now);
  const candidateIds = new Set(taskRows.map((r) => r.event_id));

  // 忙块：视野内所有非 log 的已排时段（含用户锁定块）；候选自身排除，否则会挡住自己的重排。
  // 无 end_time 的按 +30min 点事件处理。
  const busyRows = db
    .prepare(`
      SELECT event_id, start_time, end_time FROM events
      WHERE COALESCE(kind, 'event') <> 'log'
        AND status != 'cancelled'
        AND start_time IS NOT NULL AND TRIM(start_time) <> ''
        AND datetime(start_time) < datetime(?)
    `)
    .all(horizonEnd) as Array<{ event_id: string; start_time: string; end_time: string | null }>;

  const busy: BusyBlock[] = busyRows
    .filter((r) => !candidateIds.has(r.event_id))
    .map((r) => ({
      start: r.start_time,
      end:
        r.end_time && r.end_time.trim()
          ? r.end_time
          : new Date(Date.parse(r.start_time) + 30 * 60_000).toISOString(),
    }));

  // 估时反哺（Phase ④）：按分类的历史估时偏差得到校准系数，在**入口处**乘到 block 长度上
  // （排程器自身保持纯函数）；任务行存的 estimated_minutes 不动，只影响这次排出来的时段。
  const factors = calibrationFactors(db);
  const tasks: SchedulableTask[] = taskRows.map((r) => ({
    event_id: r.event_id,
    title: r.title,
    priority: r.priority,
    due_at: r.due_at,
    estimated_minutes: calibrateEstimate(r.estimated_minutes, r.category_path_json, factors),
    block_locked: r.block_locked === 1,
    created_at: r.created_at,
  }));

  const workingHours = await loadWorkingHours();
  const result = solveSchedule({ tasks, busy, workingHours, now, horizonDays });

  const titleOf = new Map(taskRows.map((r) => [r.event_id, r.title]));

  if (!opts.dryRun) {
    // 排程器自身写入一律 markStale:false —— 否则会立刻把刚写好的 'ok' 打回 'stale'（自激）
    for (const a of result.assignments) {
      await updateEvent(
        db,
        a.event_id,
        { start_time: a.start, end_time: a.end, schedule_status: 'ok', scheduled_by: 'scheduler' },
        { markStale: false },
      );
    }
    // 落不下的任务退回未排程（清掉旧块，避免留下「已过期但占用日历」的僵尸时段）
    for (const u of result.unplaced) {
      await updateEvent(
        db,
        u.event_id,
        { start_time: null, end_time: null, schedule_status: 'unscheduled', scheduled_by: 'scheduler' },
        { markStale: false },
      );
    }
    setSchedulePlanOk(db, now);
  }

  return {
    placed: result.assignments.length,
    unplaced: result.unplaced.length,
    assignments: result.assignments.map((a) => ({
      event_id: a.event_id,
      title: titleOf.get(a.event_id) ?? '',
      start: a.start,
      end: a.end,
    })),
    unplaced_tasks: result.unplaced.map((u) => ({
      event_id: u.event_id,
      title: titleOf.get(u.event_id) ?? '',
      reason: u.reason,
    })),
  };
}

/** 读排程状态（元状态 + 计数 + 待安排任务），供只读工具与面板展示 */
export async function queryScheduleStatus(): Promise<ScheduleStatus> {
  const db = await getCalendarDb();
  const meta = getScheduleMeta(db);
  const count = (sql: string): number =>
    (db.prepare(sql).get() as { c?: number } | undefined)?.c ?? 0;
  const unscheduled = (
    db
      .prepare(`
        SELECT event_id, title, due_at, estimated_minutes FROM events
        WHERE kind = 'task' AND status = 'scheduled'
          AND (start_time IS NULL OR TRIM(start_time) = '')
        ORDER BY COALESCE(due_at, '9999') ASC
        LIMIT 50
      `)
      .all() as Array<{
      event_id: string;
      title: string;
      due_at: string | null;
      estimated_minutes: number | null;
    }>
  );
  return {
    status: meta.status,
    version: meta.version,
    dirty_at: meta.dirty_at,
    last_planned_at: meta.last_planned_at,
    scheduled_count: count(
      `SELECT count(*) AS c FROM events WHERE kind = 'task' AND status = 'scheduled' AND start_time IS NOT NULL AND TRIM(start_time) <> ''`,
    ),
    stale_count: count(`SELECT count(*) AS c FROM events WHERE schedule_status = 'stale'`),
    unscheduled_tasks: unscheduled,
  };
}

/** 去抖重排句柄（进程内单例，挂在 globalThis 上以跨模块热更新保持一致） */
const REPLAN_TIMER_KEY = '__calendarReplanTimer__';
const REPLAN_DEBOUNCE_MS = 3000;

/**
 * 请求一次重排（去抖 3s）：日历变更常成批发生（同步一批事件、批量排程），
 * 合并到一次求解，避免每个写入都触发完整重算。
 */
export function scheduleReplan(delayMs: number = REPLAN_DEBOUNCE_MS): void {
  const g = globalThis as unknown as { [REPLAN_TIMER_KEY]?: ReturnType<typeof setTimeout> };
  if (g[REPLAN_TIMER_KEY]) clearTimeout(g[REPLAN_TIMER_KEY]);
  const timer = setTimeout(() => {
    g[REPLAN_TIMER_KEY] = undefined;
    void runScheduler().catch((e) => {
      console.error('[scheduler] 去抖重排失败（计划保持 stale，可手动重排）:', e);
    });
  }, delayMs);
  // 定时器不阻止进程退出（Node 环境）
  (timer as unknown as { unref?: () => void }).unref?.();
  g[REPLAN_TIMER_KEY] = timer;
}

