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
import { buildAdvice, type AdviceCard, type AdviceIdleProject, type AdvicePlanSignal } from './advice';
import { readProjectPlans, summarizePlan, PLAN_STALLED_DAYS } from '@/lib/project/plans';
import {
  buildScheduleSection,
  buildStickySection,
  readProgressDigest,
} from '@/lib/core/daily-tasks';
import { listInbox } from '@/lib/core/inbox';
import { listProjects } from '@/lib/project/project-manager';
import { getProjectLastActivityAt } from '@/lib/project/activity';

/** 当日收件箱增量里「值得回顾」的一条（② 神经：感知源写进来的东西） */
export interface InboxHighlight {
  title: string;
  detail: string;
  at: number;
}

export interface TodayBundle {
  snapshot: TodaySnapshot;
  /** 便签待办段：构建失败为 null（该页签退化成一行提示） */
  sticky: Awaited<ReturnType<typeof buildStickySection>> | null;
  /** 各项目昨日进展摘要（每日生成一次并缓存）；未生成为 null */
  progress: Awaited<ReturnType<typeof readProgressDigest>> | null;
  /** 今日 / 逾期分区（由快照派生，纯函数） */
  schedule: ReturnType<typeof buildScheduleSection>;
  /** 计划信号（进行中计划的逾期步骤 / 停滞天数）；数据源失败降级为空数组 */
  planSignals: AdvicePlanSignal[];
  /** 规则建议卡（未经 AI reason 覆盖，调用方按缓存决定是否覆盖） */
  cards: AdviceCard[];
  /** 当日收件箱增量（感知源写进来的条目，供晚间回顾汇总；失败为空数组） */
  inboxHighlights: InboxHighlight[];
}

/** 本地当日 00:00 的毫秒时间戳 */
function localDayStart(d = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 当日收件箱增量里「值得回顾」的条目（2026-10-10 ② 神经）。
 *
 * 口径只认**感知源**产出（当前为 `kind='mail'`）—— 排除定时报告与系统回执，否则晚间回顾
 * 会把自己（`kind='report'`）也算成「今天注意到的事」，造成自我指涉的重复。失败降级为空数组，
 * 不拖垮 Today 与晚间回顾（与 sticky 段同一条纪律）。
 */
export async function loadTodayInboxHighlights(now = new Date()): Promise<InboxHighlight[]> {
  try {
    const dayStart = localDayStart(now);
    const recs = await listInbox(200);
    return recs
      .filter((r) => r.kind === 'mail' && r.time >= dayStart)
      .map((r) => ({ title: r.title, detail: r.body, at: r.time }));
  } catch (e) {
    console.error('[today-advice] 收件箱增量装载失败，跳过:', e);
    return [];
  }
}

export async function loadTodayBundle(origin: string): Promise<TodayBundle> {
  const snapshot = await buildTodaySnapshot(origin);

  // sticky 段构建失败不拖垮整个 Today：该页签退回空，其余照常（失败已记日志）
  const [sticky, progress, inboxHighlights] = await Promise.all([
    buildStickySection().catch((e: unknown) => {
      console.error('[core/today] sticky 段构建失败:', e);
      return null;
    }),
    readProgressDigest().catch(() => null),
    loadTodayInboxHighlights().catch(() => [] as InboxHighlight[]),
  ]);

  // 项目停滞信号：有界 mtime 扫描 + 进程内 memo（见 activity.getProjectLastActivityAt）。
  // 失败只丢这一类信号，不影响其余建议 —— 建议引擎对空数组是安全的。
  let idleProjects: AdviceIdleProject[] = [];
  let planSignals: AdvicePlanSignal[] = [];
  try {
    const { projects, active_projects } = await listProjects();
    const activeList = active_projects.length > 0 ? active_projects : projects.filter((p) => !p.archived);
    idleProjects = await Promise.all(
      activeList.map(async (p) => {
        const last = await getProjectLastActivityAt(p).catch(() => null);
        return { id: p.id, name: p.name || p.id, lastActivityAt: last?.at ?? null };
      }),
    );
    // 计划信号：逐项目读 .butler/plans.json（只取进行中计划），派生「逾期步骤 / 停滞天数」。
    // 读失败在 readProjectPlans 内部已退化为空数组，故这里不会因单个项目拖垮整段。
    const perProject = await Promise.all(
      activeList.map(async (p) =>
        readProjectPlans(p.path)
          .then((plans) =>
            plans
              .filter((plan) => plan.status === 'active')
              .map((plan): AdvicePlanSignal => {
                const s = summarizePlan(plan);
                const top = s.overdue[0]; // summarizePlan 的 overdue 已按逾期天数降序
                return {
                  projectId: p.id,
                  projectName: p.name || p.id,
                  planId: plan.id,
                  planTitle: plan.title,
                  overdueSteps: s.overdue.length,
                  topOverdue: top ? { step: top.step, due: top.due, daysOverdue: top.daysOverdue } : undefined,
                  stalledDays:
                    s.updatedDaysAgo !== null && s.updatedDaysAgo >= PLAN_STALLED_DAYS ? s.updatedDaysAgo : null,
                };
              }),
          )
          .catch(() => [] as AdvicePlanSignal[]),
      ),
    );
    planSignals = perProject.flat();
  } catch (e) {
    console.error('[core/today] 项目停滞 / 计划信号构建失败，跳过:', e);
  }

  return {
    snapshot,
    sticky,
    progress,
    schedule: buildScheduleSection(snapshot),
    planSignals,
    cards: buildAdvice({ snapshot, sticky, idleProjects, planSignals }),
    inboxHighlights,
  };
}
