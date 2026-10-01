/**
 * 估时 / 完成率分析（Phase ④）
 *
 * 只读统计层：把「完成时必记」落下的 `actual_minutes` / `completed_at` / `category_path_json`
 * 汇成三条最小查询，并把"按分类的估时偏差"折算成**校准系数**反哺排程器——
 * 让 block 长度按历史真实用时来定，而不是永远相信用户第一次填的估时。
 *
 * 本模块不 import `@/lib/db`（只吃调用方传入的 db 句柄），是叶子模块：
 * 排程器（依赖 db）可以安全地反向依赖它，不产生 import 环。
 * 所有阈值/窗口都由调用方注入，查询本身无时钟、无随机，给定库状态结果稳定。
 */

import type BetterSqlite3 from 'better-sqlite3';

type SqliteDb = BetterSqlite3.Database;

/** 按分类的估时偏差（avg_ratio > 1 = 一贯超估时，< 1 = 一贯提前完成） */
export interface CategoryEstimateBias {
  /** 分类标签（category_path_json 拼成 '工作/开发'；无分类 → 'Uncategorized'） */
  category: string;
  /** 参与统计的已完成样本数 */
  samples: number;
  total_estimated: number;
  total_actual: number;
  /** AVG(actual / estimated)，仅统计两者均 > 0 的行 */
  avg_ratio: number;
}

/** 按周完成率（周桶取自 completed_at → due_at → start_time → created_at） */
export interface WeeklyCompletion {
  /** 'YYYY-Www' */
  week: string;
  total: number;
  done: number;
  rate: number;
}

/** 按分类的时间分配（实际优先，缺则回退估时） */
export interface CategoryTimeAllocation {
  category: string;
  entries: number;
  /** 实际用时合计（分钟） */
  actual_minutes: number;
  /** 估时合计（分钟） */
  estimated_minutes: number;
  /** 分配口径：SUM(actual ?? estimated) */
  minutes: number;
}

/** 分类 → 校准乘子（已 clamp，仅在样本足够时给出） */
export type CalibrationFactors = Map<string, number>;

export interface AnalyticsOptions {
  /** 回溯天数（按 completed_at 过滤；缺省 90 天；传 0 = 不限） */
  sinceDays?: number;
  /** 计算校准系数时的最小样本数（缺省 3） */
  minSamples?: number;
}

const DEFAULT_SINCE_DAYS = 90;
const DEFAULT_MIN_SAMPLES = 3;
/** 乘子上下限：钳住个位数样本的噪声，避免把 block 拉成 10 分钟或 10 小时 */
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 2;

/** category_path_json → 展示标签（['工作','开发'] → '工作/开发'） */
export function categoryLabel(json: string | null | undefined): string {
  if (!json) return 'Uncategorized';
  try {
    const parts = JSON.parse(json) as unknown;
    if (Array.isArray(parts) && parts.length > 0) {
      const joined = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('/');
      return joined || 'Uncategorized';
    }
  } catch {
    // 脏数据按未分类处理
  }
  return 'Uncategorized';
}

/** 回溯过滤片段：限定窗口（sinceDays <= 0 → 不限）。column 可传表达式（如 COALESCE(...)） */
function sinceClause(opts: AnalyticsOptions, column = 'completed_at'): { sql: string; params: unknown[] } {
  const days = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  if (!(days > 0)) return { sql: '', params: [] };
  return {
    sql: ` AND ${column} IS NOT NULL AND ${column} >= ?`,
    params: [new Date(Date.now() - days * 86_400_000).toISOString()],
  };
}

/** 查询 1：按分类的估时偏差 AVG(actual / estimated) */
export function estimateBiasByCategory(
  db: SqliteDb,
  opts: AnalyticsOptions = {},
): CategoryEstimateBias[] {
  const since = sinceClause(opts);
  const rows = db
    .prepare(`
      SELECT category_path_json AS cat,
             COUNT(*) AS samples,
             SUM(estimated_minutes) AS total_estimated,
             SUM(actual_minutes) AS total_actual,
             AVG(CAST(actual_minutes AS REAL) / estimated_minutes) AS avg_ratio
      FROM events
      WHERE status = 'done'
        AND actual_minutes IS NOT NULL AND actual_minutes > 0
        AND estimated_minutes IS NOT NULL AND estimated_minutes > 0
        ${since.sql}
      GROUP BY category_path_json
      ORDER BY samples DESC, cat ASC
    `)
    .all(...since.params) as Array<{
    cat: string | null;
    samples: number;
    total_estimated: number;
    total_actual: number;
    avg_ratio: number;
  }>;
  return rows.map((r) => ({
    category: categoryLabel(r.cat),
    samples: r.samples,
    total_estimated: r.total_estimated,
    total_actual: r.total_actual,
    avg_ratio: r.avg_ratio,
  }));
}

/** 查询 2：按周完成率（周桶取自 completed_at → due_at → start_time → created_at） */
export function weeklyCompletion(
  db: SqliteDb,
  opts: AnalyticsOptions & { weeks?: number } = {},
): WeeklyCompletion[] {
  const limit = opts.weeks && opts.weeks > 0 ? Math.round(opts.weeks) : 8;
  const rows = db
    .prepare(`
      SELECT strftime('%Y-W%W', COALESCE(completed_at, due_at, start_time, created_at)) AS week,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
      FROM events
      WHERE kind = 'task'
      GROUP BY week
      HAVING week IS NOT NULL
      ORDER BY week DESC
      LIMIT ?
    `)
    .all(limit) as Array<{ week: string; total: number; done: number }>;
  return rows.map((r) => ({
    week: r.week,
    total: r.total,
    done: r.done,
    rate: r.total > 0 ? r.done / r.total : 0,
  }));
}

/** 查询 3：按分类的时间分配（实际优先，缺则用估时） */
export function timeAllocationByCategory(
  db: SqliteDb,
  opts: AnalyticsOptions = {},
): CategoryTimeAllocation[] {
  const since = sinceClause(opts, 'COALESCE(completed_at, start_time, created_at)');
  const rows = db
    .prepare(`
      SELECT category_path_json AS cat,
             COUNT(*) AS entries,
             SUM(COALESCE(actual_minutes, 0)) AS actual_minutes,
             SUM(COALESCE(estimated_minutes, 0)) AS estimated_minutes,
             SUM(CASE WHEN actual_minutes IS NOT NULL AND actual_minutes > 0
                      THEN actual_minutes ELSE COALESCE(estimated_minutes, 0) END) AS minutes
      FROM events
      WHERE kind = 'task' AND status <> 'cancelled'
        ${since.sql}
      GROUP BY category_path_json
      ORDER BY minutes DESC, cat ASC
    `)
    .all(...since.params) as Array<{
    cat: string | null;
    entries: number;
    actual_minutes: number;
    estimated_minutes: number;
    minutes: number;
  }>;
  return rows.map((r) => ({
    category: categoryLabel(r.cat),
    entries: r.entries,
    actual_minutes: r.actual_minutes,
    estimated_minutes: r.estimated_minutes,
    minutes: r.minutes,
  }));
}

/**
 * 校准系数：分类 → 估时乘子（来自查询 1 的 avg_ratio，clamp 到 [0.5, 2]）。
 * 样本不足 `minSamples` 的分类不给乘子（宁可用用户估时，也不信单次噪声）。
 */
export function calibrationFactors(
  db: SqliteDb,
  opts: AnalyticsOptions = {},
): CalibrationFactors {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const out: CalibrationFactors = new Map();
  for (const b of estimateBiasByCategory(db, opts)) {
    if (b.samples < minSamples) continue;
    const clamped = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, b.avg_ratio));
    if (Number.isFinite(clamped) && clamped > 0) out.set(b.category, clamped);
  }
  return out;
}

/**
 * 用校准系数换算一个任务的执行块长度（分钟）。
 * `estimated` 为空时返回 null（交给排程器用默认块长）；系数缺失时原值返回。
 * 下限 15 分钟（与排程器网格对齐），避免校准把块压成不可执行的长度。
 */
export function calibrateEstimate(
  estimated: number | null | undefined,
  categoryPathJson: string | null | undefined,
  factors: CalibrationFactors,
): number | null {
  if (estimated === null || estimated === undefined || estimated <= 0) return null;
  const factor = factors.get(categoryLabel(categoryPathJson));
  if (!factor) return estimated;
  return Math.max(15, Math.round(estimated * factor));
}
