/**
 * Phase ④ 回归：估时偏差 → 校准系数 → 反哺排程（block 长度即时段变化）
 *
 * 用内存库建最小 events 表（只含 analytics 用到的列），验证：
 *  ① 按分类的 AVG(actual/estimated) 正确；
 *  ② 样本足够才给校准系数，且 clamp 到 [0.5, 2]；
 *  ③ 校准后的估时喂进 solveSchedule，同一批任务的时段确实变化（反哺闭环成立）。
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  calibrateEstimate,
  calibrationFactors,
  estimateBiasByCategory,
  timeAllocationByCategory,
  weeklyCompletion,
} from './analytics';
import { solveSchedule, DEFAULT_WORKING_HOURS } from './scheduler/solve';

/** 最小 events 表（analytics 只用这些列） */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'event',
      status TEXT NOT NULL DEFAULT 'scheduled',
      estimated_minutes INTEGER,
      actual_minutes INTEGER,
      start_time TEXT,
      end_time TEXT,
      started_at TEXT,
      completed_at TEXT,
      due_at TEXT,
      category_path_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

interface SeedRow {
  id: string;
  category: string;
  estimated: number;
  actual?: number;
  status?: string;
  /** 显式 null = 无完成时间（未完成行靠 start_time 落桶） */
  completedAt?: string | null;
  startAt?: string | null;
}

function seed(db: Database.Database, rows: SeedRow[]): void {
  const stmt = db.prepare(`
    INSERT INTO events (event_id, kind, status, estimated_minutes, actual_minutes,
                        start_time, completed_at, category_path_json, created_at)
    VALUES (?, 'task', ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z')
  `);
  for (const r of rows) {
    stmt.run(
      r.id,
      r.status ?? 'done',
      r.estimated,
      r.actual ?? null,
      r.startAt ?? null,
      r.completedAt === undefined ? '2026-09-20T10:00:00.000Z' : r.completedAt,
      JSON.stringify(r.category.split('/')),
    );
  }
}

describe('analytics · 估时偏差与校准系数', () => {
  it('按分类统计 AVG(actual/estimated)，分类标签由路径拼成', () => {
    const db = makeDb();
    seed(db, [
      { id: 'a', category: '工作/开发', estimated: 30, actual: 60 }, // 2.0
      { id: 'b', category: '工作/开发', estimated: 30, actual: 45 }, // 1.5
      { id: 'c', category: '生活', estimated: 60, actual: 30 }, // 0.5
      // 无 actual / 无 estimated 的行不参与
      { id: 'd', category: '工作/开发', estimated: 30 },
      { id: 'e', category: '生活', estimated: 0, actual: 30 },
      { id: 'f', category: '生活', estimated: 30, actual: 10, status: 'scheduled' },
    ]);
    const bias = estimateBiasByCategory(db, { sinceDays: 0 });
    expect(bias.map((b) => b.category)).toEqual(['工作/开发', '生活']);
    const work = bias[0];
    expect(work.samples).toBe(2);
    expect(work.avg_ratio).toBeCloseTo(1.75, 5); // (2.0 + 1.5) / 2
    expect(work.total_estimated).toBe(60);
    expect(work.total_actual).toBe(105);
    expect(bias[1].avg_ratio).toBeCloseTo(0.5, 5);
    db.close();
  });

  it('样本不足不给系数；足够时 clamp 到 [0.5, 2]', () => {
    const db = makeDb();
    seed(db, [
      { id: 'a', category: '工作/开发', estimated: 10, actual: 60 }, // 6.0
      { id: 'b', category: '工作/开发', estimated: 10, actual: 60 },
      { id: 'c', category: '工作/开发', estimated: 10, actual: 60 },
      { id: 'd', category: '琐事', estimated: 60, actual: 5 }, // 0.083，仅 1 个样本
    ]);
    const factors = calibrationFactors(db, { sinceDays: 0, minSamples: 3 });
    expect(factors.get('工作/开发')).toBe(2); // clamp 上限
    expect(factors.has('琐事')).toBe(false); // 样本不足
    db.close();
  });

  it('calibrateEstimate：缺估时返回 null，无系数原值返回，有系数按下限 15 分钟折算', () => {
    const factors = new Map([['工作/开发', 2]]);
    expect(calibrateEstimate(null, '["工作/开发"]', factors)).toBeNull();
    expect(calibrateEstimate(0, '["工作/开发"]', factors)).toBeNull();
    expect(calibrateEstimate(30, '["生活"]', factors)).toBe(30);
    expect(calibrateEstimate(30, '["工作","开发"]', factors)).toBe(60);
    expect(calibrateEstimate(5, '["工作","开发"]', factors)).toBe(15);
  });

  it('同一批任务：校准系数把 block 拉长后，重排时段随之变化（反哺闭环）', () => {
    const db = makeDb();
    seed(db, [
      { id: 'a', category: '工作/开发', estimated: 30, actual: 60 },
      { id: 'b', category: '工作/开发', estimated: 30, actual: 60 },
      { id: 'c', category: '工作/开发', estimated: 30, actual: 60 },
    ]);
    const factors = calibrationFactors(db, { sinceDays: 0 });
    const estimate = calibrateEstimate(30, '["工作","开发"]', factors);
    expect(estimate).toBe(60);

    const now = '2026-09-28T00:00:00.000Z'; // 周一 08:00 (+08:00)
    const base = { priority: 'normal', created_at: '2026-09-01T00:00:00.000Z' };
    const before = solveSchedule({
      tasks: [
        { event_id: 't1', title: 'T1', estimated_minutes: 30, ...base },
        { event_id: 't2', title: 'T2', estimated_minutes: 30, ...base },
      ],
      busy: [],
      workingHours: DEFAULT_WORKING_HOURS,
      now,
    });
    const after = solveSchedule({
      tasks: [
        { event_id: 't1', title: 'T1', estimated_minutes: estimate, ...base },
        { event_id: 't2', title: 'T2', estimated_minutes: estimate, ...base },
      ],
      busy: [],
      workingHours: DEFAULT_WORKING_HOURS,
      now,
    });
    const span = (r: typeof before): number =>
      Date.parse(r.assignments[1].start) - Date.parse(r.assignments[0].start);
    // 30min 块 + 10min buffer，但 T2 只能落在 15min 网格上 → 起于 09:45，相距 45 分钟
    expect(span(before)).toBe(45 * 60_000);
    // 60min 块 + 10min buffer → T2 起于 10:15，相距 75 分钟：同一批任务、同一个 now，时段确实变了
    expect(span(after)).toBe(75 * 60_000);
    expect(span(after)).toBeGreaterThan(span(before));
    db.close();
  });
});

describe('analytics · 完成率与时间分配', () => {
  it('按周完成率分组并给出 rate', () => {
    const db = makeDb();
    seed(db, [
      { id: 'a', category: '工作', estimated: 30, actual: 30, completedAt: '2026-09-07T10:00:00.000Z' },
      // 未完成：靠 start_time 落进同一周（2026-09-08）
      { id: 'b', category: '工作', estimated: 30, status: 'scheduled', completedAt: null, startAt: '2026-09-08T09:00:00.000Z' },
      { id: 'c', category: '工作', estimated: 30, actual: 30, completedAt: '2026-09-08T10:00:00.000Z' },
    ]);
    const weeks = weeklyCompletion(db, { weeks: 4 });
    expect(weeks.length).toBeGreaterThan(0);
    // 同一周内 2 条已完成 + 1 条未完成 → rate = 2/3
    const bucket = weeks.find((w) => w.total === 3);
    expect(bucket).toBeDefined();
    expect(bucket!.done).toBe(2);
    expect(bucket!.rate).toBeCloseTo(2 / 3, 5);
    db.close();
  });

  it('按分类的时间分配：实际优先，缺则回退估时', () => {
    const db = makeDb();
    seed(db, [
      { id: 'a', category: '工作/开发', estimated: 30, actual: 45 },
      { id: 'b', category: '工作/开发', estimated: 30, status: 'scheduled' }, // 用估时 30
      { id: 'c', category: '生活', estimated: 20, actual: 10 },
    ]);
    const alloc = timeAllocationByCategory(db, { sinceDays: 0 });
    const dev = alloc.find((a) => a.category === '工作/开发')!;
    expect(dev.entries).toBe(2);
    expect(dev.minutes).toBe(75); // 45 + 30
    expect(dev.actual_minutes).toBe(45);
    expect(dev.estimated_minutes).toBe(60);
    expect(alloc[alloc.length - 1].category).toBe('生活'); // 按 minutes 降序
    db.close();
  });
});
