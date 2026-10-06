/**
 * Butler Today 聚合（lib/butler/today.ts）
 *
 * 给「Today 页」提供今日快照：今天日程 / 逾期待办 / 未读回执。
 * 日报的 Schedule 页签（buildScheduleSection）直接由本快照派生 —— 两处共用同一份「今日 / 逾期」口径。
 *
 * 设计要点（对齐 Today.ai 的 Chief of Staff 思路）：
 *   - **只读**：不写日历、不写收件箱、不改任何状态；
 *   - **先查后答**：所有数字来自 querySchedule / listInbox 的真实返回，查不到就是查不到。
 *
 * 建议（「今天该抓什么」）自 2026-10-03 起移到 lib/butler/advice.ts —— 那里是实时 + 纯规则引擎，
 * 与「昨日复盘」（缓存 + LLM）分属两条链路；本模块只负责产出事实快照。
 */
import { querySchedule, type ScheduleEvent } from '@/lib/core/schedule';
import { listInbox, countUnreadInbox } from '@/lib/core/inbox';
import { countUnreadThreads } from '@/lib/butler/threads';

/** Today 派生的最小事件形状：Today 面板与日报 Schedule 页签共用（eventLine / toNoticeItem 只需这些字段）。
 *  抽成具名类型是为了让 lib/core/daily-tasks.ts 能直接消费本快照 —— Pick 形状无法赋给完整
 *  ScheduleEvent，收窄消费侧参数类型即可（见 daily-tasks.ts 的 eventLine / toNoticeItem）。 */
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
  // 再算一次逾期就是重复计数。该口径原先只存在于晨报（daily-tasks.ts），现下沉到这里，
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
