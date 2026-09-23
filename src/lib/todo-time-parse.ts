/**
 * 待办文本 → 事件时间（本地正则快路径）。
 *
 * 调用方：/api/sticky-notes/parse-time —— 点便签行尾「Add to calendar」时，
 * 先从待办文本里挑出日期/时刻（如「明天下午3点开会」→ 明天 15:00），
 * 命不中再由该接口回退 LLM。
 *
 * 同时产出「主题」：把被识别为时间表达的片段从原文里剔除（「明天下午3点跟张三开会」→「跟张三开会」），
 * 让弹窗 Todo 一栏只留事项本身、时间交给 Date/Time 字段（主题与时间各归其位）。
 *
 * 与 lib/wanted/schedule.ts 的区别：那边解析「查询区间」（整天边界，用于检索），
 * 这里解析「单个事件的开始时刻」（用于建日历事件），语义不同故独立实现。
 */

/** 解析结果：date 为本地日期 YYYY-MM-DD，time 为本地时刻 HH:MM（文本只有日期时为 undefined） */
export interface ParsedTodoTime {
  date: string;
  time?: string;
  /** 原文剔除时间表达后的主题；剔除后为空/无有效内容时缺省（调用方保留原文） */
  topic?: string;
}

const WEEKDAY_CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const WEEKDAY_EN: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** 中文时段前缀（决定 12/24 小时制换算） */
const MERIDIEM_WORDS = '凌晨|清晨|早上|早晨|上午|中午|正午|下午|傍晚|晚上|夜里|晚间';

const pad = (n: number) => String(n).padStart(2, '0');

/** 原文中被判定为「时间表达」的片段区间（用于生成主题） */
type TimeSpan = { start: number; end: number };

/** 记录命中片段（正则需非全局，才有 m.index），供后续从主题里剔除 */
function hit(m: RegExpMatchArray, spans: TimeSpan[]): void {
  const start = m.index ?? 0;
  spans.push({ start, end: start + m[0].length });
}

/** 本地某天 00:00（在 now 基础上加减天数） */
function dayAt(now: Date, diffDays: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffDays);
}

/** 本地本周一 00:00 */
function weekStart(d: Date): Date {
  const day = d.getDay(); // 0 = 周日
  return dayAt(d, day === 0 ? -6 : 1 - day);
}

/** 周几（含周日）→ 本周内的偏移天数（周一 = 0） */
function weekdayOffset(wd: number): number {
  return wd === 0 ? 6 : wd - 1;
}

/** 解析日期表达，返回本地当天 00:00；识别不到返回 null */
function parseDate(s: string, now: Date, spans: TimeSpan[]): Date | null {
  let m: RegExpMatchArray | null;

  // 相对日（「大后天」必须先于「后天」，故按长到短依次判断）
  if ((m = s.match(/大后天/))) {
    hit(m, spans);
    return dayAt(now, 3);
  }
  if ((m = s.match(/后天/))) {
    hit(m, spans);
    return dayAt(now, 2);
  }
  if ((m = s.match(/明天|明日|明晚|明早|明儿/)) || (m = s.match(/\btomorrow\b/i))) {
    hit(m, spans);
    return dayAt(now, 1);
  }
  if ((m = s.match(/今天|今日|今晚|今早/)) || (m = s.match(/\btoday\b|\btonight\b/i))) {
    hit(m, spans);
    return dayAt(now, 0);
  }
  if ((m = s.match(/昨天/))) {
    hit(m, spans);
    return dayAt(now, -1);
  }

  // N 天后 / N 天以后
  m = s.match(/(\d{1,3})\s*天\s*(?:以)?后/);
  if (m) {
    hit(m, spans);
    return dayAt(now, Number(m[1]));
  }

  // 下周X / 下个星期X / 下礼拜X
  m = s.match(/下(?:个)?(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (m) {
    hit(m, spans);
    return dayAt(weekStart(now), 7 + weekdayOffset(WEEKDAY_CN[m[1]]));
  }

  // 本周X / 周X / 星期X / 礼拜X（未来优先：已过去的同一个周几取下周）
  m = s.match(/(?:本|这)?(?:个)?(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (m) {
    hit(m, spans);
    const base = dayAt(weekStart(now), weekdayOffset(WEEKDAY_CN[m[1]]));
    return base.getTime() < dayAt(now, 0).getTime() ? dayAt(base, 7) : base;
  }

  // 完整日期：2026-08-08 / 2026/8/8 / 2026年8月8日
  m = s.match(/(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    hit(m, spans);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  // 月日：8月8日 / 8月8号
  m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    hit(m, spans);
    return new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
  }

  // 8/8（不含年份）
  m = s.match(/(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/);
  if (m) {
    hit(m, spans);
    return new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
  }

  // 英文星期：next monday / mon
  m = s.match(/\b(next\s+)?(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\b/i);
  if (m) {
    hit(m, spans);
    const base = dayAt(weekStart(now), weekdayOffset(WEEKDAY_EN[m[2].toLowerCase()]));
    const d = m[1] ? dayAt(base, 7) : base;
    return d.getTime() < dayAt(now, 0).getTime() ? dayAt(d, 7) : d;
  }

  return null;
}

/** 中文时段前缀 → 12/24 小时制换算方向 */
function meridiemOf(prefix: string | undefined): 'am' | 'pm' | null {
  if (!prefix) return null;
  if (/凌晨|清晨|早上|早晨|上午/.test(prefix)) return 'am';
  if (/下午|傍晚|晚上|夜里|晚间/.test(prefix)) return 'pm';
  return null; // 中午/正午：小时不变
}

/** 解析时刻表达；识别不到返回 null */
function parseTime(s: string, spans: TimeSpan[]): { h: number; m: number } | null {
  let m: RegExpMatchArray | null;

  // 英文：3pm / 3:30 pm
  m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    hit(m, spans);
    const h = Number(m[1]);
    const mer = m[3].toLowerCase();
    return {
      h: mer === 'pm' && h < 12 ? h + 12 : mer === 'am' && h === 12 ? 0 : h,
      m: m[2] ? Number(m[2]) : 0,
    };
  }

  // 中文：下午3点 / 晚上7点半 / 9点15分 / 中午12点
  m = s.match(new RegExp(`(${MERIDIEM_WORDS})?\\s*(\\d{1,2})\\s*[点時时]\\s*(?:(\\d{1,2})\\s*分?|(半))?`));
  if (m) {
    hit(m, spans);
    const h = Number(m[2]);
    const mer = meridiemOf(m[1]);
    return {
      h: mer === 'pm' && h < 12 ? h + 12 : mer === 'am' && h === 12 ? 0 : h,
      m: m[4] ? 30 : m[3] ? Number(m[3]) : 0,
    };
  }

  // HH:MM（可带时段前缀，如「下午3:30」）
  m = s.match(new RegExp(`(?:(${MERIDIEM_WORDS})\\s*)?(?<![\\d:])(\\d{1,2})\\s*[:：]\\s*(\\d{2})(?![\\d:])`));
  if (m) {
    hit(m, spans);
    const h = Number(m[2]);
    const mer = meridiemOf(m[1]);
    return {
      h: mer === 'pm' && h < 12 ? h + 12 : mer === 'am' && h === 12 ? 0 : h,
      m: Number(m[3]),
    };
  }

  return null;
}

/**
 * 从原文里剔除时间片段得到「主题」。
 *  - 紧贴被剔时间之后、且位于主题开头的悬空标记一并剔除（「9月30日前提交答辩状」→「提交答辩状」、
 *    「明天在法院开庭」→「法院开庭」）；(?!台) 防误伤「明天前台签到」这类词
 *  - 顺带清掉残留的独立时段词（「明天下午开会」→「开会」）与首尾标点/空白/助词；
 *  - 剔除后为空（整句都是时间，如「明天下午3点」）→ 返回 undefined，调用方保留原文。
 */
function buildTopic(s: string, spans: TimeSpan[]): string | undefined {
  if (spans.length === 0) return undefined;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const sp of sorted) {
    if (sp.start < cursor) continue; // 重叠片段只剔一次
    out += s.slice(cursor, sp.start);
    cursor = sp.end;
    const gap = s.slice(cursor).match(/^[\s，,、]*(?:之前|以前|前(?!台)|在|于)/);
    if (gap && /^[\s，,。.、;；:：]*$/.test(out + gap[0].slice(0, -1))) cursor += gap[0].length;
  }
  out += s.slice(cursor);
  const topic = out
    .replace(new RegExp(`(?:${MERIDIEM_WORDS})`, 'g'), '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s，,。.、;；:：!！?？\-—的]+/, '')
    .replace(/[\s，,。.、;；:：\-—]+$/, '')
    .trim();
  return topic.length > 0 ? topic : undefined;
}

/**
 * 从一句待办文本里解析出事件时间。
 *  - 日期 + 时刻都有 → 都返回；
 *  - 只有日期 → 只返回 date（时刻由调用方给默认值）；
 *  - 只有时刻 → 日期取今天，若该时刻已过则顺延到明天（待办排期面向未来）；
 *  - 都没有 / 时刻非法（如 25:00）→ null / 仅日期。
 * 另返回 topic（原文去掉时间表达的事项本身），供「Add to calendar」弹窗把主题与时间分开预填。
 */
export function parseTodoTime(text: string, now: Date = new Date()): ParsedTodoTime | null {
  const s = (text || '').trim();
  if (!s) return null;

  const spans: TimeSpan[] = [];
  const rawTime = parseTime(s, spans);
  const time = rawTime && rawTime.h >= 0 && rawTime.h <= 23 && rawTime.m >= 0 && rawTime.m <= 59 ? rawTime : null;
  if (!time) spans.length = 0; // 非法时刻（如 25:00）不算时间表达，不参与主题剔除
  const date = parseDate(s, now, spans);
  if (!date && !time) return null;

  let d = date;
  if (!d) {
    d = dayAt(now, 0);
    const minutesOfDay = time!.h * 60 + time!.m;
    if (minutesOfDay <= now.getHours() * 60 + now.getMinutes()) d = dayAt(now, 1);
  }

  const out: ParsedTodoTime = { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
  if (time) out.time = `${pad(time.h)}:${pad(time.m)}`;
  const topic = buildTopic(s, spans);
  if (topic) out.topic = topic;
  return out;
}
