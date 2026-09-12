/**
 * 日程查询共享内核（原 WANTED /schedule 指令能力，命令已删除，能力并入 /todo check 与 daily-report）。
 *
 * 调用方：
 *   - /todo check 子命令（⌘F 面板 / 微信桥）→ resolveReadCalendarQuery + querySchedule
 *   - 每日报告 daily-report → querySchedule
 *   - 日程查询统一管线：parseScheduleInput（正则快路径）→ /api/wanted/schedule-parse（LLM 回退）
 *
 * 支持的自然语言（query_text / parseScheduleInput 输入）：
 *   - 无参数 / 今天 / 今日 / today          → 今日待办
 *   - 明天 / 明日 / tomorrow                → 明日待办
 *   - 已过期 / 过期 / 超期 / 逾期 / overdue → 已过期待办（未完成）
 *   - 本周 / 这周 / this week               → 本周（周一 ~ 周日）
 *   - 下周 / next week                      → 下周
 *   - 上周 / last week                      → 上周
 *   - 本月 / 这个月 / this month            → 本月
 *   - 下月 / 下个月 / next month            → 下月
 *   - 所有待办 / 所有过往待办 / 全部历史    → 全部（或全部过往）事件
 *   - 最近待办 / 最近 / 近一周 / 近N天 / 近7天 → 最近 7 天 / 最近 N 天
 *   - 8月1日到8月7日 / 8/1 - 8/7 / 8月1日~8月7日 → 指定区间
 *   - 8月8日 / 8/8 / 2026-08-08 / 周六 / 下周三 → 指定日期/星期
 *   - 其他任意内容（如 华为公司、起草合同）→ 按内容关键词搜索全部历史
 *     （正则无法识别时会回退到 LLM 自然语言解析，见 /api/wanted/schedule-parse）
 *
 * 时间格式说明：
 *   - 所有事件按本地时区显示（MM/DD HH:mm）
 *   - 查询区间用 UTC ISO（与 /api/calendar/events 的 range_start/range_end 约定一致），
 *     返回后在 JS 侧用 Date 精确过滤，规避 SQLite 字符串比较在跨时区偏移下的边缘误差
 */

import { listUncalendaredOpenRows } from '@/lib/sticky-todo';

/** 解析后的查询条件（rangeStart/rangeEnd 为 UTC ISO 字符串；overdue 优先） */
export interface ScheduleQuery {
  /** 展示标签，如 "Today (08/07)"、"8/1 - 8/7"、"Overdue"、"All past todos" */
  label: string;
  rangeStart?: string;
  rangeEnd?: string;
  overdue?: boolean;
  /** 按内容关键词搜索（title/description/tags/location LIKE），可与时间范围组合 */
  keyword?: string;
  /** 关键词搜索是否跨越全部时间（true=只按关键词不过滤时间） */
  allTime?: boolean;
  /** 查询范围：project=仅项目级 | global=仅全局无时间待办 | all=两者（默认 all） */
  scope?: 'project' | 'global' | 'all';
}

export interface ScheduleParseResult {
  ok: boolean;
  error?: string;
  query?: ScheduleQuery;
}

/** 日历事件（/api/calendar/events 返回的子集） */
export interface ScheduleEvent {
  event_id?: string;
  title: string;
  start_time: string;
  end_time?: string | null;
  all_day?: boolean;
  status?: string;
  priority?: string;
  description?: string | null;
  location?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function apiUrl(base: string | undefined, path: string): string {
  return (base ? base.replace(/\/$/, '') : '') + path;
}

/** 本地某天的 00:00 与次日 00:00（UTC ISO） */
function dayRangeISO(d: Date): { start: string; end: string } {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return { start: s.toISOString(), end: e.toISOString() };
}

/** 本周一 00:00（本地） */
function weekStart(d: Date): Date {
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
}

const WEEKDAY_CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/** 解析单个日期表达式（返回本地当天 00:00 的 Date；失败返回 null） */
function parseDateExpr(expr: string, now: Date): Date | null {
  const s = expr.trim();
  if (!s) return null;
  if (/^(今天|今日|today)$/i.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/^(明天|明日|tomorrow)$/i.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (/^后天$/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  if (/^昨天$/.test(s)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  // 完整日期：2026-08-08 / 2026/8/8 / 2026年8月8日
  let m = s.match(/^(\d{4})[年/\-.](\d{1,2})[月/\-.](\d{1,2})日?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  // 月日：8月8日 / 8月8号 / 8/8 / 8-8 / 8.8
  m = s.match(/^(\d{1,2})月(\d{1,2})[日号]?$/) ?? s.match(/^(\d{1,2})[/\-.](\d{1,2})$/);
  if (m) return new Date(now.getFullYear(), +m[1] - 1, +m[2]);

  // 下周三 / 下个星期三
  m = s.match(/^下(?:周|个?星期|礼拜)([一二三四五六日天])$/);
  if (m) {
    const wd = WEEKDAY_CN[m[1]];
    const nextMonday = new Date(weekStart(now).getTime() + 7 * 86400 * 1000);
    return new Date(nextMonday.getFullYear(), nextMonday.getMonth(), nextMonday.getDate() + wd - 1);
  }

  // 本周/周五 / 周五 / 星期三
  m = s.match(/^(?:(?:本|这)周|星期|礼拜|周)([一二三四五六日天])$/);
  if (m) {
    const wd = WEEKDAY_CN[m[1]];
    const cur = now.getDay();
    const diff = wd - cur;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
  }

  return null;
}

/** 主解析入口：把自然语言查询（query_text / /todo check 子命令）转成查询条件 */
export function parseScheduleInput(input: string, now: Date = new Date()): ScheduleParseResult {
  const s = input.trim();

  // 无参数：默认今日
  if (!s) {
    const { start, end } = dayRangeISO(now);
    return { ok: true, query: { label: `Today (${pad(now.getMonth() + 1)}/${pad(now.getDate())})`, rangeStart: start, rangeEnd: end } };
  }

  // 已过期
  if (/(overdue|expired|已过期|过期|超期|逾期|已逾期)/.test(s)) {
    return { ok: true, query: { label: 'Overdue', overdue: true } };
  }

  // 所有待办 / 所有过往待办 / 全部历史（按词段整体匹配，避免误吞普通关键词）
  const allM = s.match(/^(?:查询|查看|查一下)?(?:所有|全部)(?:的)?(?:过往|历史|过去)?(?:的)?(?:待办|日程|事件|任务)?$/);
  if (allM) {
    const past = /(过往|历史|过去)/.test(s);
    return {
      ok: true,
      query: {
        label: past ? 'All past todos' : 'All todos',
        rangeStart: new Date(0).toISOString(),
        rangeEnd: past ? now.toISOString() : new Date(2100, 0, 1).toISOString(),
      },
    };
  }

  // 最近待办 / 最近（过去 7 天含今天）
  if (/^(?:查询|查看|查一下)?最近(?:的)?(?:待办|日程|事件|任务)?$/.test(s)) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    return {
      ok: true,
      query: { label: 'Recent (last 7d)', rangeStart: start.toISOString(), rangeEnd: dayRangeISO(now).end },
    };
  }

  // 近一周 / 最近一周 / 过去一周 / 近7天 / 这周内（含今天往前 7 天）
  if (/(?:近|最近|过去|这)(?:一周|7天|七天)$/.test(s) || /^这周内$/.test(s)) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    return {
      ok: true,
      query: { label: 'Recent (last 7d)', rangeStart: start.toISOString(), rangeEnd: dayRangeISO(now).end },
    };
  }
  // 近N天 / 最近N天 / 过去N天（N = 1..30，含今天）
  const nDaysM = s.match(/^(?:近|最近|过去)(?:的)?(\d{1,2})(?:天|日)$/);
  if (nDaysM) {
    const n = Math.min(30, Math.max(1, +nDaysM[1]));
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
    return {
      ok: true,
      query: { label: `Recent (last ${n}d)`, rangeStart: start.toISOString(), rangeEnd: dayRangeISO(now).end },
    };
  }

  // 区间：A到B / A至B / A~B / A～B / A—B / A - B
  const rangeM = s.match(/^(.+?)(?:到|至|~|～|—|--)\s*(.+)$/) ?? s.match(/^(.+?)\s+-\s+(.+)$/);
  if (rangeM) {
    const a = parseDateExpr(rangeM[1], now);
    const b = parseDateExpr(rangeM[2], now);
    if (a && b) {
      // 交换保证 start <= end（用户可能输入反向区间）
      const [first, second] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
      const aStart = dayRangeISO(first).start;
      const bEnd = dayRangeISO(second).end;
      return {
        ok: true,
        query: { label: `${pad(first.getMonth() + 1)}/${pad(first.getDate())} - ${pad(second.getMonth() + 1)}/${pad(second.getDate())}`, rangeStart: aStart, rangeEnd: bEnd },
      };
    }
  }

  // 单日/星期（自动剥离附带的时刻与时段词，如 "8月8日 14:00"、"下周三下午3点"、"明天晚上8点"、"今天下午"）
  const stripped = s
    .replace(/(?:上午|早上|早晨|中午|下午|傍晚|晚上|晚间|夜间|凌晨)?\s*\d{1,2}(?:[:：]\d{2}|[点时](?:半|一刻|整)?)/g, '')
    .replace(/(上午|早上|早晨|中午|下午|傍晚|晚上|晚间|夜间|凌晨)/g, '')
    .trim();
  const day = parseDateExpr(stripped, now) ?? parseDateExpr(s, now);
  if (day) {
    const { start, end } = dayRangeISO(day);
    const label = /^(今天|今日|today)$/i.test(stripped) ? `Today (${pad(day.getMonth() + 1)}/${pad(day.getDate())})`
      : /^(明天|明日|tomorrow)$/i.test(stripped) ? `Tomorrow (${pad(day.getMonth() + 1)}/${pad(day.getDate())})`
      : `${pad(day.getMonth() + 1)}/${pad(day.getDate())}`;
    return { ok: true, query: { label, rangeStart: start, rangeEnd: end } };
  }

  // 相对周/月
  if (/(本周|这周|this\s*week)/i.test(s)) {
    return { ok: true, query: { label: 'This week', ...weekRange(weekStart(now)) } };
  }
  if (/(下周|next\s*week)/i.test(s)) {
    return { ok: true, query: { label: 'Next week', ...weekRange(new Date(weekStart(now).getTime() + 7 * 86400 * 1000)) } };
  }
  if (/(上周|last\s*week)/i.test(s)) {
    return { ok: true, query: { label: 'Last week', ...weekRange(new Date(weekStart(now).getTime() - 7 * 86400 * 1000)) } };
  }
  if (/(本月|这个月|this\s*month)/i.test(s)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { ok: true, query: { label: `This month (${pad(now.getMonth() + 1)})`, rangeStart: start.toISOString(), rangeEnd: end.toISOString() } };
  }
  if (/(下月|下个月|next\s*month)/i.test(s)) {
    const start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    return { ok: true, query: { label: `Next month (${pad((now.getMonth() + 2) % 12 || 12)})`, rangeStart: start.toISOString(), rangeEnd: end.toISOString() } };
  }

  // 兜底：仅含时刻（如 "下午3点"）→ 查今天
  if (/(上午|中午|下午|傍晚|晚上|凌晨)?\s*\d{1,2}(?:[:：]\d{2}|[点时])/.test(s)) {
    const { start, end } = dayRangeISO(now);
    return { ok: true, query: { label: `Today (${pad(now.getMonth() + 1)}/${pad(now.getDate())})`, rangeStart: start, rangeEnd: end } };
  }

  // 关键词兜底：其余输入按内容关键词搜索全部历史（如 华为公司、起草合同、周报）。
  // 仅当不含明显时间线索时兜底——含时间词/日期格式的表达（如"下周五之前"）仍返回 error，
  // 由调用方回退到 LLM 慢路径解析，避免复杂时间被误当作内容关键词搜索。
  if (!/(今|明|昨|最近|过期|逾期|超期|本周|这周|下周|上周|本月|下月|星期|礼拜|周[一二三四五六日天]|\d{1,4}[年月日号点]|\d{1,2}[/\-.]\d{1,2})/.test(s)) {
    return {
      ok: true,
      query: { label: `"${s}"`, keyword: s, allTime: true },
    };
  }

  return {
    ok: false,
    error:
      `Could not understand "${s}". Query by time (today / tomorrow / this week / 8/8 / 8/1-8/7 / all overdue / recent todos) or search by a content keyword (e.g. a company name).`,
  };
}

/**
 * 日程查询统一解析（/todo check 命令与 query_text 共用同一管线）：
 * 1. query_text 存在时走自然语言解析：正则快路径 → LLM 慢路径（/api/wanted/schedule-parse）
 * 2. 否则走结构化参数（filter/overdue/keyword/range/scope）
 * scope 默认 project，显式 all/global 时按指定（/todo check 固定传 all）。
 */
export async function resolveReadCalendarQuery(
  args: Record<string, unknown>,
  baseUrl?: string,
  now: Date = new Date(),
): Promise<{ query: ScheduleQuery; method: 'structured' | 'regex' | 'llm' }> {
  const scope = args.scope === 'all' || args.scope === 'global'
    ? (args.scope as 'all' | 'global')
    : 'project';
  const queryText = typeof args.query_text === 'string' ? args.query_text.trim() : '';

  if (queryText) {
    // 快路径：正则（确定性，覆盖常见时间表达）
    const parsed = parseScheduleInput(queryText, now);
    if (parsed.ok && parsed.query) {
      return { query: { ...parsed.query, scope }, method: 'regex' };
    }
    // 慢路径：LLM 自然语言解析（与 /schedule 命令同一接口）
    if (baseUrl) {
      try {
        const resp = await fetch(apiUrl(baseUrl, '/api/wanted/schedule-parse'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: queryText }),
        });
        const data = await resp.json();
        if (data?.success && (data.overdue || data.keyword || (data.rangeStart && data.rangeEnd))) {
          let query: ScheduleQuery;
          if (data.overdue) {
            query = { label: data.label || 'Overdue', overdue: true };
          } else if (data.keyword) {
            query = {
              label: data.label || `"${data.keyword}"`,
              keyword: data.keyword,
              rangeStart: data.rangeStart,
              rangeEnd: data.rangeEnd,
              allTime: data.allTime === true || (!data.rangeStart && !data.rangeEnd),
            };
          } else {
            query = { label: data.label || 'Range', rangeStart: data.rangeStart, rangeEnd: data.rangeEnd };
          }
          return { query: { ...query, scope }, method: 'llm' };
        }
      } catch {
        // LLM 解析失败：降级
      }
    }
    // 解析失败：降级为结构化参数（避免工具调用失败）
    return { query: scheduleQueryFromReadCalendarArgs(args), method: 'structured' };
  }

  return { query: scheduleQueryFromReadCalendarArgs(args), method: 'structured' };
}

/** 周范围：week 起（周一 00:00）的 7 天 */
function weekRange(weekMonday: Date): { rangeStart: string; rangeEnd: string } {
  const start = new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { rangeStart: start.toISOString(), rangeEnd: end.toISOString() };
}

/** 查询日历事件并按查询条件精确过滤、排序 */
export async function querySchedule(
  query: ScheduleQuery,
  baseUrl?: string,
): Promise<{ ok: boolean; reply: string; events: ScheduleEvent[] }> {
  let url: string;
  // scope 参数化：querySchedule 默认 all（项目级 + 全局无时间待办）；调用方可按需传 project/global
  const scope = query.scope ?? 'all';
  if (query.overdue) {
    url = `/api/calendar/events?scope=${scope}&range_start=${encodeURIComponent(new Date(0).toISOString())}&range_end=${encodeURIComponent(new Date().toISOString())}`;
  } else if (query.keyword) {
    // 关键词搜索：可带时间范围缩小，否则按全部历史（服务端倒序、最近优先）
    const params = new URLSearchParams({ keyword: query.keyword, scope });
    if (query.rangeStart && query.rangeEnd) {
      params.set('range_start', query.rangeStart);
      params.set('range_end', query.rangeEnd);
    }
    url = `/api/calendar/events?${params.toString()}`;
  } else if (query.rangeStart && query.rangeEnd) {
    url = `/api/calendar/events?scope=${scope}&range_start=${encodeURIComponent(query.rangeStart)}&range_end=${encodeURIComponent(query.rangeEnd)}`;
  } else {
    return { ok: false, reply: 'Missing query parameters', events: [] };
  }

  let data: { success?: boolean; error?: string; events?: ScheduleEvent[] };
  try {
    const resp = await fetch(apiUrl(baseUrl, url));
    data = await resp.json();
  } catch (e) {
    return { ok: false, reply: `Query failed: ${e instanceof Error ? e.message : String(e)}`, events: [] };
  }
  if (!data.success) return { ok: false, reply: data.error || 'Query failed', events: [] };

  let events: ScheduleEvent[] = data.events || [];
  const nowMs = Date.now();
  const today = new Date();
  const todayStartMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (query.overdue) {
    // 已过期：未完成/未取消，且满足——
    //   有结束时间：结束时间已过；无结束时间（如全天事件）：开始时间早于今天 00:00（昨天及更早）
    //   无时间（全局待办 scope=global）：无法判断过期，始终保留展示
    events = events.filter((ev) => {
      if (ev.status === 'done' || ev.status === 'cancelled') return false;
      if (!ev.start_time) return true;
      const t = new Date(ev.start_time).getTime();
      if (ev.end_time) {
        const end = new Date(ev.end_time).getTime();
        return Number.isFinite(end) && end < nowMs;
      }
      return Number.isFinite(t) && t < todayStartMs;
    });
  } else if (query.rangeStart && query.rangeEnd) {
    // JS 侧精确过滤（与 listEventsInRange 语义一致：与范围有交集的事件）。
    // 用 end >= s：全天事件 start 恰等于范围起点（本地当天 00:00 = UTC 前一天 16:00）时不应被排除
    const s = new Date(query.rangeStart).getTime();
    const e = new Date(query.rangeEnd).getTime();
    events = events.filter((ev) => {
      if (!ev.start_time) return true; // 全局无时间待办：始终展示
      const t = new Date(ev.start_time).getTime();
      const end = ev.end_time ? new Date(ev.end_time).getTime() : t;
      return Number.isFinite(t) && Number.isFinite(end) && t < e && end >= s;
    });
  }
  // 关键词全时间搜索：服务端已按最近优先返回，保持原序；其余情况按开始时间正序（无时间项排最前）
  if (!(query.keyword && !query.rangeStart)) {
    events.sort((a, b) => {
      const ta = a.start_time ? new Date(a.start_time).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.start_time ? new Date(b.start_time).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });
  }

  const stickyBlock = await buildOpenStickyBlock(query);
  const reply = formatScheduleReply(query, events);
  return { ok: true, reply: stickyBlock ? `${reply}\n\n${stickyBlock}` : reply, events };
}

/**
 * 结构化参数 → ScheduleQuery（query_text 优先走 resolveReadCalendarQuery）。
 * 共享同一查询内核：filter（today/week/upcoming/all）兜底，
 * overdue / keyword / range_start / range_end / scope 提供精确控制。
 * 默认 scope='project'（历史语义：纯项目级日历），
 * querySchedule 默认 scope='all'（见 querySchedule）。
 */
export function scheduleQueryFromReadCalendarArgs(
  args: Record<string, unknown>,
  now: Date = new Date(),
): ScheduleQuery {
  const filter = (args.filter as string) || 'today';
  const overdue = args.overdue === true;
  const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
  const scope = args.scope === 'all' || args.scope === 'global'
    ? (args.scope as 'all' | 'global')
    : 'project';
  const rangeStart = typeof args.range_start === 'string' && args.range_start.trim()
    ? args.range_start.trim() : undefined;
  const rangeEnd = typeof args.range_end === 'string' && args.range_end.trim()
    ? args.range_end.trim() : undefined;

  if (overdue) {
    return { label: 'Overdue', overdue: true, scope };
  }
  if (keyword) {
    return {
      label: `"${keyword}"`,
      keyword,
      rangeStart,
      rangeEnd,
      allTime: !(rangeStart && rangeEnd),
      scope,
    };
  }
  if (rangeStart && rangeEnd) {
    const fmt = (iso: string) => iso.slice(5, 10).replace('-', '/');
    return { label: `Range ${fmt(rangeStart)} - ${fmt(rangeEnd)}`, rangeStart, rangeEnd, scope };
  }

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (filter) {
    case 'today':
      return {
        label: 'Today',
        rangeStart: todayStart.toISOString(),
        rangeEnd: new Date(todayStart.getTime() + 86400000 - 1).toISOString(),
        scope,
      };
    case 'week': {
      const dayOfWeek = now.getDay();
      const weekStart = new Date(todayStart.getTime() - dayOfWeek * 86400000);
      return {
        label: 'This week',
        rangeStart: weekStart.toISOString(),
        rangeEnd: new Date(weekStart.getTime() + 7 * 86400000 - 1).toISOString(),
        scope,
      };
    }
    case 'upcoming':
      return {
        label: 'Next 30 days',
        rangeStart: now.toISOString(),
        rangeEnd: new Date(todayStart.getTime() + 30 * 86400000 - 1).toISOString(),
        scope,
      };
    default:
      return {
        label: 'All in range',
        rangeStart: new Date(todayStart.getTime() - 30 * 86400000).toISOString(),
        rangeEnd: new Date(todayStart.getTime() + 60 * 86400000 - 1).toISOString(),
        scope,
      };
  }
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 汇总当前激活项目里「未入日历」的未完成便签行（StickyTodo 不自动入日历后，Butler 待办查询仍能看到它们）。
 * overdue / scope=global 不合并（无日期语义 / 非项目便签）。只影响 reply 文本，events 数组保持不变（结构化消费方不受影响）。
 */
async function buildOpenStickyBlock(query: ScheduleQuery): Promise<string | null> {
  if (query.scope === 'global' || query.overdue) return null;
  let project: { path: string };
  try {
    project = await (await import('@/lib/project/project-manager')).getCurrentProject();
  } catch {
    return null;
  }
  let rows: string[];
  try {
    rows = await listUncalendaredOpenRows(project.path);
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const kw = typeof query.keyword === 'string' ? query.keyword.trim().toLowerCase() : '';
  let matched = rows;
  if (kw) {
    matched = rows.filter((t) => t.toLowerCase().includes(kw));
    if (matched.length === 0) return null;
  }
  const MAX = 30;
  const shown = matched.slice(0, MAX);
  const more = matched.length > MAX ? `\n… and ${matched.length - MAX} more` : '';
  const head = kw
    ? '🧷 Sticky matches (not scheduled yet):'
    : '🧷 Sticky to-dos (not scheduled yet):';
  return `${head}\n${shown.map((t) => `- ${t}`).join('\n')}${more}`;
}

/** 组织回复文本（通知中心正文）；超过 30 条截断，避免消息过长 */
function formatScheduleReply(query: ScheduleQuery, events: ScheduleEvent[]): string {
  const header = `📅 Schedule — ${query.label}`;
  if (events.length === 0) return `${header}\nNo events in this range.`;
  const MAX_SHOWN = 30;
  const shown = events.slice(0, MAX_SHOWN);
  const lines = shown.map((ev, i) => {
    const time = !ev.start_time
      ? 'No time'
      : ev.all_day
        ? `${fmtDate(ev.start_time)} All-day`
        : `${fmtDateTime(ev.start_time)}${ev.end_time ? ` - ${fmtTime(ev.end_time)}` : ''}`;
    const prio = ev.priority === 'high' ? ' (high)' : ev.priority === 'low' ? ' (low)' : '';
    const mark = ev.status === 'done' ? ' [done]' : ev.status === 'cancelled' ? ' [cancelled]' : '';
    return `${i + 1}. ${time}  ${ev.title}${prio}${mark}`;
  });
  const more = events.length > MAX_SHOWN ? `\n… and ${events.length - MAX_SHOWN} more` : '';
  return `${header}\n${lines.join('\n')}${more}\n—— ${events.length} event(s)`;
}
