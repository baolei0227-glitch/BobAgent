/**
 * Today 数据的组合层（lib/butler/today-advice.ts）
 *
 * GET /api/butler/today（读）与 POST /api/butler/advice/refresh（生成建议）需要**同一组事实**：
 * 快照 + sticky 段 + 项目停滞信号 → 规则建议卡。AI 缓存的键是卡片集合的 hash，
 * 若两个入口各自拼装、口径漂移，hash 就会对不上、缓存永远打不中。故把这份拼装收敛到本模块。
 *
 * 只做组合，不写任何状态；各段的失败降级（sticky 段失败退 null、停滞信号失败跳过）与原先一致。
 */
import { buildTodaySnapshot, type TodaySnapshot } from './today';
import { buildAdvice, type AdviceCard, type AdviceIdleProject } from './advice';
import {
  buildScheduleSection,
  buildStickySection,
  readProgressDigest,
} from '@/lib/core/daily-tasks';
import { listProjects } from '@/lib/project/project-manager';
import { getProjectLastActivityAt } from '@/lib/project/activity';

export interface TodayBundle {
  snapshot: TodaySnapshot;
  /** 便签待办段：构建失败为 null（该页签退化成一行提示） */
  sticky: Awaited<ReturnType<typeof buildStickySection>> | null;
  /** 各项目昨日进展摘要（每日生成一次并缓存）；未生成为 null */
  progress: Awaited<ReturnType<typeof readProgressDigest>> | null;
  /** 今日 / 逾期分区（由快照派生，纯函数） */
  schedule: ReturnType<typeof buildScheduleSection>;
  /** 规则建议卡（未经 AI reason 覆盖，调用方按缓存决定是否覆盖） */
  cards: AdviceCard[];
}

export async function loadTodayBundle(origin: string): Promise<TodayBundle> {
  const snapshot = await buildTodaySnapshot(origin);

  // sticky 段构建失败不拖垮整个 Today：该页签退回空，其余照常（失败已记日志）
  const [sticky, progress] = await Promise.all([
    buildStickySection().catch((e: unknown) => {
      console.error('[core/today] sticky 段构建失败:', e);
      return null;
    }),
    readProgressDigest().catch(() => null),
  ]);

  // 项目停滞信号：有界 mtime 扫描 + 进程内 memo（见 activity.getProjectLastActivityAt）。
  // 失败只丢这一类信号，不影响其余建议 —— 建议引擎对空数组是安全的。
  let idleProjects: AdviceIdleProject[] = [];
  try {
    const { projects, active_projects } = await listProjects();
    const activeList = active_projects.length > 0 ? active_projects : projects.filter((p) => !p.archived);
    idleProjects = await Promise.all(
      activeList.map(async (p) => {
        const last = await getProjectLastActivityAt(p).catch(() => null);
        return { id: p.id, name: p.name || p.id, lastActivityAt: last?.at ?? null };
      }),
    );
  } catch (e) {
    console.error('[core/today] 项目停滞信号构建失败，跳过:', e);
  }

  return {
    snapshot,
    sticky,
    progress,
    schedule: buildScheduleSection(snapshot),
    cards: buildAdvice({ snapshot, sticky, idleProjects }),
  };
}
