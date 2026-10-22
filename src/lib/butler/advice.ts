/**
 * Today 建议引擎（lib/butler/advice.ts）
 *
 * 与「昨日复盘」（lib/project/daily-digest.ts，缓存 + LLM，每天生成一次）性质不同：
 * 本模块是**实时 + 纯规则**的 —— 每次 /api/butler/today 请求现算，不落盘、不进模型。
 * 理由是建议讲的都是「今天」：9:00 缓存到下午就过时了（用户上午已经处理掉），
 * 而规则是确定性的、可解释、可点击（对齐仓库既有取向：能声明式表达就走 Rule）。
 *
 * 五类信号（按优先级，最多取 MAX_CARDS 条）：
 *   1. overdue  逾期待办      —— 有未完成且已过期的事件
 *   2. plan     计划逾期/停滞 —— 计划树里登记 due 的步骤已过期，或计划久未推进
 *   3. overload 今日过载      —— 今天排了 OVERLOAD_THRESHOLD 项及以上
 *   4. sticky   便签待办积压  —— 全项目未完成便签行累计 STICKY_BACKLOG_THRESHOLD 及以上
 *   5. stalled  项目停滞      —— 活跃项目最近一次活动距今 >= STALLED_DAYS 天
 *   6. clear    今天很空       —— 上述全空，且快照未降级
 *
 * 两条硬约束：
 *   - **降级不误报**：数据源失败的信号直接跳过（overdue 查询失败时 count 会是 0，
 *     不跳过就会得出「今天很空」的虚假结论）；`clear` 只在完全未降级时给。
 *   - **不了假装能算工作量**：ScheduleEvent 没有 estimated_minutes / due_at，priority 也
 *     多为默认 normal，所以「建议顺延哪几项」退化为可解释的两级排序（低优先级优先、
 *     同级取时间最晚），文案里必须写清判据。
 *
 * 本模块自身零 I/O（不改文件、不发请求），便于 vitest 直接单测。
 */
import type { ButlerNoticeItem } from '@/lib/bus';
import type { TodayEvent, TodaySnapshot } from '@/lib/butler/today';
import { toNoticeItem } from '@/lib/core/daily-tasks';

/** 建议类型 */
export type AdviceKind = 'overdue' | 'plan' | 'overload' | 'sticky' | 'stalled' | 'clear';

/** 一条建议：一句话判断（title）+ 依据（reason）+ 可点击项（items） */
export interface AdviceCard {
  /** 稳定 id（同一判据重复请求保持一致，供前端 key） */
  id: string;
  kind: AdviceKind;
  /** 一句判断 */
  title: string;
  /** 依据：让建议可解释、可反驳 */
  reason: string;
  /** 关联数量（展示用） */
  count: number;
  /** 可点击项：event / sticky 项走勾选，project 项走「切到该项目」 */
  items: ButlerNoticeItem[];
}

/** 便签积压信号：直接用 buildStickySection 的结果，**不要重复计算**（它内部会对每行 getEvent，成本不低） */
export interface AdviceStickyInput {
  items: ButlerNoticeItem[];
  totalPending: number;
  projectCount: number;
}

/** 活跃项目的「最近一次活动」（由 activity.getProjectLastActivityAt 有界求得） */
export interface AdviceIdleProject {
  id: string;
  name: string;
  /** null = 无任何活动记录且无 created_at，无法判断 → 不参与停滞判据 */
  lastActivityAt: string | null;
}

/** 计划信号（由 today-advice 逐项目读 plans.json + summarizePlan 派生）：一个计划一条 */
export interface AdvicePlanSignal {
  projectId: string;
  projectName: string;
  planId: string;
  planTitle: string;
  /** 已过期未完成的步骤数（0 = 无逾期） */
  overdueSteps: number;
  /** 最急的一条逾期步骤（overdueSteps > 0 时应有值） */
  topOverdue?: { step: string; due: string; daysOverdue: number };
  /** 计划久未推进的天数（null = 未达停滞阈值） */
  stalledDays: number | null;
}

export interface AdviceInput {
  snapshot: TodaySnapshot;
  /** null = sticky 段构建失败 → 跳过积压信号 */
  sticky: AdviceStickyInput | null;
  idleProjects: AdviceIdleProject[];
  /** 计划信号（可选：缺省 = 无计划数据，不产出 plan 卡） */
  planSignals?: AdvicePlanSignal[];
  now?: Date;
}

/** 最多给几条建议 */
const MAX_CARDS = 3;
/** 单卡最多列几项（可点击项是「点名」，不是清单） */
const MAX_ITEMS_PER_CARD = 3;
/** 今日过载阈值（沿用 today.ts 既有口径） */
const OVERLOAD_THRESHOLD = 5;
/** 便签待办积压阈值（沿用 today.ts 既有口径） */
const STICKY_BACKLOG_THRESHOLD = 5;
/** 项目停滞天数阈值 */
const STALLED_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function startMsOf(ev: TodayEvent): number {
  const ms = new Date(ev.start_time).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** 「低优先级优先、同级取时间最晚」——可顺延候选的两级排序（判据写进文案，不假装能算工作量） */
function deferCandidates(events: TodayEvent[]): TodayEvent[] {
  const rank = (p?: string) => (p === 'low' ? 0 : p === 'high' ? 2 : 1);
  return [...events].sort((a, b) => {
    const ra = rank(a.priority);
    const rb = rank(b.priority);
    if (ra !== rb) return ra - rb;
    return startMsOf(b) - startMsOf(a);
  });
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 由快照 + 便签积压 + 项目停滞信号推导 2–3 条建议（按优先级排序，宁缺毋滥）。
 * 无任何值得打断用户的事时返回单个 `clear` 卡（快照未降级时）。
 */
export function buildAdvice(input: AdviceInput): AdviceCard[] {
  const { snapshot: snap, sticky, idleProjects } = input;
  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  // 数据源失败的信号直接跳过，避免「查询失败 = 今天很空」的虚假结论
  const degraded = new Set(snap.degraded.map((s) => s.split(':')[0].trim()));
  const overdueOk = !degraded.has('overdue');
  const todayOk = !degraded.has('today');

  const cards: AdviceCard[] = [];
  /** 跨卡去重：低优先级卡跳过已被高点名过的行 */
  const claimed = new Set<string>();

  const take = (events: TodayEvent[], section?: 'today' | 'overdue'): ButlerNoticeItem[] => {
    const out: ButlerNoticeItem[] = [];
    for (const ev of events) {
      const item = toNoticeItem(ev);
      if (claimed.has(item.key)) continue;
      claimed.add(item.key);
      out.push(section ? { ...item, section } : item);
      if (out.length >= MAX_ITEMS_PER_CARD) break;
    }
    return out;
  };

  // 1) 逾期待办（最高优先级）
  if (overdueOk && snap.overdue.count > 0) {
    const earliest = [...snap.overdue.events].sort((a, b) => startMsOf(a) - startMsOf(b));
    const items = take(earliest, 'overdue');
    const first = earliest[0];
    cards.push({
      id: 'overdue',
      kind: 'overdue',
      count: snap.overdue.count,
      title: `有 ${snap.overdue.count} 项已逾期，建议先清最早那件`,
      reason: first ? `最早逾期：${first.title}（${fmtDay(first.start_time)}）` : '逾期会持续堆积，越晚处理成本越高',
      items,
    });
  }

  // 2) 计划逾期 / 停滞（项目治理面）：与日历逾期同属「已过期、越晚越贵」，故紧随其后。
  //    计划信号缺省不存在时整段跳过；数据源失败在 today-advice 侧已降级为空数组（不误报）。
  const planHit = (input.planSignals ?? [])
    .filter((s) => s.overdueSteps > 0 || s.stalledDays !== null)
    .sort((a, b) => b.overdueSteps - a.overdueSteps || (b.stalledDays ?? 0) - (a.stalledDays ?? 0));
  if (planHit.length > 0) {
    const overdueTotal = planHit.reduce((n, s) => n + s.overdueSteps, 0);
    // 可点击项走 source='project'：点击即切到该项目（计划本身没有「勾选完成」的语义）
    const items: ButlerNoticeItem[] = planHit.slice(0, MAX_ITEMS_PER_CARD).map((s) => ({
      key: `plan:${s.planId}`,
      title: `${s.projectName} · ${s.planTitle}`,
      time: s.overdueSteps > 0 ? `${s.overdueSteps} step(s) overdue` : `stalled ${s.stalledDays}d`,
      startMs: 0,
      source: 'project',
      project: { projectId: s.projectId, projectName: s.projectName },
    }));
    const top = planHit[0];
    cards.push({
      id: 'plan',
      kind: 'plan',
      count: overdueTotal,
      title: overdueTotal > 0
        ? `计划里有 ${overdueTotal} 个步骤已逾期（${planHit.length} 个计划）`
        : `有 ${planHit.length} 个计划停滞`,
      reason: top.overdueSteps > 0 && top.topOverdue
        ? `最急：${top.projectName}「${top.planTitle}」的「${top.topOverdue.step}」已逾期 ${top.topOverdue.daysOverdue} 天`
        : `「${top.projectName}」的「${top.planTitle}」已 ${top.stalledDays} 天未推进——建议推进或收尾`,
      items,
    });
  }

  // 3) 今日过载
  if (todayOk && snap.today.count >= OVERLOAD_THRESHOLD) {
    const candidates = deferCandidates(snap.today.events);
    const items = take(candidates, 'today');
    const names = items.map((i) => i.title).join('、');
    const deferable = Math.min(items.length, MAX_ITEMS_PER_CARD);
    cards.push({
      id: 'overload',
      kind: 'overload',
      count: snap.today.count,
      title: `今天排了 ${snap.today.count} 项，建议保留主线、顺延 ${deferable} 项`,
      reason: names
        ? `按「低优先级、时间靠后」挑出可顺延的：${names}`
        : '当日安排偏满，临时插入多半会挤掉既有安排',
      items,
    });
  }

  // 4) 便签待办积压（sticky 段构建失败时跳过：null 不等于 0）
  if (sticky && sticky.totalPending >= STICKY_BACKLOG_THRESHOLD) {
    const items: ButlerNoticeItem[] = [];
    for (const it of sticky.items) {
      if (claimed.has(it.key)) continue;
      claimed.add(it.key);
      items.push(it);
      if (items.length >= MAX_ITEMS_PER_CARD) break;
    }
    cards.push({
      id: 'sticky',
      kind: 'sticky',
      count: sticky.totalPending,
      title: `便签待办积压 ${sticky.totalPending} 项（${sticky.projectCount} 个项目）`,
      reason: '未入日历的便签行最容易被忘掉，挑几条勾掉就能回收注意力',
      items,
    });
  }

  // 5) 项目停滞
  const stalled = idleProjects
    .map((p) => {
      if (!p.lastActivityAt) return null;
      const ms = new Date(p.lastActivityAt).getTime();
      if (!Number.isFinite(ms)) return null;
      return { p, ms, days: Math.floor((nowMs - ms) / DAY_MS), at: p.lastActivityAt };
    })
    .filter((x): x is { p: AdviceIdleProject; ms: number; days: number; at: string } => !!x && x.days >= STALLED_DAYS)
    .sort((a, b) => b.days - a.days);
  if (stalled.length > 0) {
    const items: ButlerNoticeItem[] = stalled.slice(0, MAX_ITEMS_PER_CARD).map(({ p, ms, days }) => ({
      key: `project:${p.id}`,
      title: p.name,
      time: `Last activity ${days}d ago`,
      startMs: ms,
      source: 'project',
      project: { projectId: p.id, projectName: p.name },
    }));
    const top = stalled[0];
    cards.push({
      id: 'stalled',
      kind: 'stalled',
      count: stalled.length,
      title: stalled.length === 1
        ? `「${top.p.name}」已 ${top.days} 天没有新活动`
        : `有 ${stalled.length} 个项目停滞，最久的是「${top.p.name}」（${top.days} 天）`,
      reason: `最近一次活动在 ${fmtDay(top.at)}——建议重启推进或归档收口`,
      items,
    });
  }

  if (cards.length === 0) {
    // 只在完全未降级时才敢说「今天很空」
    if (snap.degraded.length === 0 && snap.today.count === 0 && (!sticky || sticky.totalPending === 0)) {
      cards.push({
        id: 'clear',
        kind: 'clear',
        count: 0,
        title: '今天很空，适合做需要整块时间的事',
        reason: '今日无安排、无积压待办，且所有数据源正常',
        items: [],
      });
    }
    return cards.slice(0, MAX_CARDS);
  }

  return cards.slice(0, MAX_CARDS);
}