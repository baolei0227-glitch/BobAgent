/**
 * Butler Today 聚合（lib/butler/today.ts）
 *
 * 给「Today 页」提供今日快照：今天日程 / 逾期待办 / 未读回执 + 一条建议卡。
 * 日报的 Schedule 页签（buildScheduleSection）直接由本快照派生 —— 两处共用同一份「今日 / 逾期」口径。
 *
 * 设计要点（对齐 Today.ai 的 Chief of Staff 思路）：
 *   - **只读**：不写日历、不写收件箱、不改任何状态；
 *   - **先查后答**：所有数字来自 querySchedule / listInbox 的真实返回，查不到就是查不到；
 *   - **只给一条建议**：主动但克制——宁可不提，也不一次塞五条（见 buildSuggestion 的优先级短路）。
 */
import { querySchedule, type ScheduleEvent } from '@/lib/core/schedule';
import { listInbox, countUnreadInbox } from '@/lib/core/inbox';
import { countUnreadThreads } from '@/lib/butler/threads';

/** Today 派生的最小事件形状：Today 面板与日报 Schedule 页签共用（eventLine / toNoticeItem 只需这些字段）。
 *  抽成具名类型是为了让 lib/core/daily-report.ts 能直接消费本快照 —— Pick 形状无法赋给完整
 *  ScheduleEvent，收窄消费侧参数类型即可（见 daily-report.ts 的 eventLine / toNoticeItem）。 */
export type TodayEvent = Pick<
  ScheduleEvent,
  'event_id' | 'title' | 'start_time' | 'end_time' | 'all_day' | 'status' | 'priority'
>;

/** 单段事件列表随快照下发的上限：只为兜住极端情况（几千条逾期）不至于把 payload 撑爆。
 *  正常量级下 count === events.length，面板据此**整段摊开**，不存在「列不全又打不开」。 */
const EVENT_CAP = 200;

/** 今天日程（含已过期到今天的顺延项算逾期待办） */
export interface TodaySnapshot {
  /** 生成时刻 ISO */
  at: string;
  today: {
    count: number;
    events: TodayEvent[];
  };
  overdue: {
    count: number;
    events: TodayEvent[];
  };
  inbox: {
    /** 未完成（!done）的回执条数：建议卡的「积压」判据用 */
    pending: number;
  };
  /**
   * 未读总数（悬浮球角标 = 它）：
   *   - 好友会话里的未读 assistant 消息（assistant 消息维度）
   *   - + 尚未点开的回执（inbox read = 0）
   * 回执是「普通消息」的一种（微信里的语音/文件消息）：点开卡片才清，与好友头像角标同源。
   */
  chats: {
    unread: number;
  };
  /** 快照是否降级（部分数据源查询失败） */
  degraded: string[];
}

/** 本地某天 00:00 与次日 00:00（UTC ISO） */
function dayRangeISO(now: Date): { start: string; end: string } {
  const s = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
  return { start: s.toISOString(), end: e.toISOString() };
}

function pick<E extends ScheduleEvent, K extends keyof E>(e: E, keys: K[]): Pick<E, K> {
  const out = {} as Pick<E, K>;
  for (const k of keys) out[k] = e[k];
  return out;
}

/**
 * 构建今日快照。
 * @param baseUrl 宿主 origin（如 http://localhost:5000）；schedule 查询内部需拼绝对 URL，
 *                与 executor.runCheckQuery 的传参方式保持一致。缺省时按同源相对路径（部分环境可用）。
 */
export async function buildTodaySnapshot(baseUrl?: string): Promise<TodaySnapshot> {
  const now = new Date();
  const { start, end } = dayRangeISO(now);
  const degraded: string[] = [];

  const [todayRes, overdueRes, inboxAll, chatUnread, inboxUnread] = await Promise.all([
    querySchedule({ label: 'Today', rangeStart: start, rangeEnd: end, scope: 'all' }, baseUrl).catch((e: unknown) => {
      degraded.push(`today: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false as const, reply: '', events: [] as ScheduleEvent[] };
    }),
    querySchedule({ label: 'Overdue', overdue: true, scope: 'all' }, baseUrl).catch((e: unknown) => {
      degraded.push(`overdue: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false as const, reply: '', events: [] as ScheduleEvent[] };
    }),
    listInbox(50).catch(() => {
      degraded.push('inbox: 读取失败');
      return [] as Awaited<ReturnType<typeof listInbox>>;
    }),
    countUnreadThreads().catch(() => {
      degraded.push('chats: 读取失败');
      return 0;
    }),
    countUnreadInbox().catch(() => {
      degraded.push('inbox-unread: 读取失败');
      return 0;
    }),
  ]);

  const pendingRows = inboxAll.filter((r) => !r.done);

  // 逾期剔除「今天开始」的事件：今天已结束但未勾完成的会议/日程会同时出现在 Today 分区，
  // 再算一次逾期就是重复计数。该口径原先只存在于晨报（daily-report.ts），现下沉到这里，
  // 让 Today 面板与晨报共用同一份判定 —— 这也是本次「晨报融合进 Today」要修的分叉。
  const todayStartMs = new Date(start).getTime();
  const overdueOnly = overdueRes.events.filter((ev) => new Date(ev.start_time).getTime() < todayStartMs);

  return {
    at: now.toISOString(),
    today: {
      count: todayRes.events.length,
      events: todayRes.events.slice(0, EVENT_CAP).map((e) =>
        pick(e, ['event_id', 'title', 'start_time', 'end_time', 'all_day', 'status', 'priority'] as const),
      ),
    },
    overdue: {
      // count 用过滤后的真实总数；列表截到 EVENT_CAP 只为兜住极端情况，
      // 面板可把这批数据整个摊开（见 ButlerTodayPanel 的展开器），不再出现「列不全又打不开」。
      count: overdueOnly.length,
      events: overdueOnly.slice(0, EVENT_CAP).map((e) =>
        pick(e, ['event_id', 'title', 'start_time', 'end_time', 'all_day', 'status', 'priority'] as const),
      ),
    },
    inbox: {
      pending: pendingRows.length,
    },
    chats: { unread: chatUnread + inboxUnread },
    degraded,
  };
}

export interface TodaySuggestion {
  /** 一句话建议标题（Today 页的建议卡主文案） */
  title: string;
  /** 为什么给这条建议（让建议可解释、可反驳） */
  reason: string;
  /** 建议类型：面板据此决定要不要给「处理」按钮 */
  kind: 'overdue' | 'overload' | 'inbox' | 'clear';
  /** 关联数量（展示折叠计数用） */
  count: number;
}

/**
 * 由快照推导**最多一条**建议（优先级短路：逾期 > 负荷过高 > 回执积压 > 今天很空）。
 * 刻意保守：没有值得打断用户的事就返回 null —— "知道什么时候该闭嘴"是这套设计的重点。
 */
export function buildSuggestion(snap: TodaySnapshot): TodaySuggestion | null {
  if (snap.overdue.count > 0) {
    return {
      kind: 'overdue',
      count: snap.overdue.count,
      title: `有 ${snap.overdue.count} 项逾期未完成，先处理最紧急的一件`,
      reason: snap.overdue.events[0]?.title
        ? `最早逾期：${snap.overdue.events[0].title}`
        : '逾期待办会持续堆积，越晚处理成本越高',
    };
  }
  // 负荷判定：今天排了 5 件及以上 → 提醒收拢，而不是再加任务
  if (snap.today.count >= 5) {
    return {
      kind: 'overload',
      count: snap.today.count,
      title: `今天排了 ${snap.today.count} 项，建议保留主线、其余顺延`,
      reason: '当日安排偏满，临时插入多半会挤掉既有安排',
    };
  }
  if (snap.inbox.pending >= 5) {
    return {
      kind: 'inbox',
      count: snap.inbox.pending,
      title: `收件箱积压 ${snap.inbox.pending} 条未处理，要不要先清一遍`,
      reason: '未处理的回执堆积后，重要结果容易被埋掉',
    };
  }
  if (snap.today.count === 0 && snap.inbox.pending === 0) {
    return { kind: 'clear', count: 0, title: '今天很空，适合做需要整块时间的事', reason: '今日无安排、无未处理回执' };
  }
  return null;
}
