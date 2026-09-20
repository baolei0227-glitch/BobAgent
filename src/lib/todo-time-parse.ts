/**
 * 待办文本 → 事件时间（本地正则快路径）。
 *
 * 调用方：/api/sticky-notes/parse-time —— 点便签行尾「Add to calendar」时，
 * 先从待办文本里挑出日期/时刻（如「明天下午3点开会」→ 明天 15:00），
 * 命不中再由该接口回退 LLM。
 *
 * 与 lib/wanted/schedule.ts 的区别：那边解析「查询区间」（整天边界，用于检索），
 * 这里解析「单个事件的开始时刻」（用于建日历事件），语义不同故独立实现。
 */

/** 解析结果：date 为本地日期 YYYY-MM-DD，time 为本地时刻 HH:MM（文本只有日期时为 undefined） */
export interface ParsedTodoTime {
  date: string;
  time?: string;
}

const WEEKDAY_CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const WEEKDAY_EN: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** 中文时段前缀（决定 12/24 小时制换算） */
const MERIDIEM_WORDS = '凌晨|清晨|早上|早晨|上午|中午|正午|下午|傍晚|晚上|夜里|晚间';

const pad = (n: number) => String(n).padStart(2, '0');

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
function parseDate(s: string, now: Date): Date | null {
  let m: RegExpMatchArray | null;

  // 相对日（「大后天」必须先于「后天」，故按长到短依次判断）
  if (/大后天/.test(s)) return dayAt(now, 3);
  if (/后天/.test(s)) return dayAt(now, 2);
  if (/明天|明日|明晚|明早|明儿/.test(s) || /\btomorrow\b/i.test(s)) return dayAt(now, 1);
  if (/今天|今日|今晚|今早/.test(s) || /\btoday\b/i.test(s) || /\btonight\b/i.test(s)) return dayAt(now, 0);
  if (/昨天/.test(s)) return dayAt(now, -1);

  // N 天后 / N 天以后
  m = s.match(/(\d{1,3})\s*天\s*(?:以)?后/);
  if (m) return dayAt(now, Number(m[1]));

  // 下周X / 下个星期X / 下礼拜X
  m = s.match(/下(?:个)?(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (m) return dayAt(weekStart(now), 7 + weekdayOffset(WEEKDAY_CN[m[1]]));

  // 本周X / 周X / 星期X / 礼拜X（未来优先：已过去的同一个周几取下周）
  m = s.match(/(?:本|这)?(?:个)?(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (m) {
    const base = dayAt(weekStart(now), weekdayOffset(WEEKDAY_CN[m[1]]));
    return base.getTime() < dayAt(now, 0).getTime() ? dayAt(base, 7) : base;
  }

  // 完整日期：2026-08-08 / 2026/8/8 / 2026年8月8日
  m = s.match(/(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*[日号]?/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // 月日：8月8日 / 8月8号
  m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) return new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));

  // 8/8（不含年份）
  m = s.match(/(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/);
  if (m) return new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));

  // 英文星期：next monday / mon
  m = s.match(/\b(next\s+)?(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\b/i);
  if (m) {
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
function parseTime(s: string): { h: number; m: number } | null {
  let m: RegExpMatchArray | null;

  // 英文：3pm / 3:30 pm
  m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
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
 * 从一句待办文本里解析出事件时间。
 *  - 日期 + 时刻都有 → 都返回；
 *  - 只有日期 → 只返回 date（时刻由调用方给默认值）；
 *  - 只有时刻 → 日期取今天，若该时刻已过则顺延到明天（待办排期面向未来）；
 *  - 都没有 / 时刻非法（如 25:00）→ null / 仅日期。
 */
export function parseTodoTime(text: string, now: Date = new Date()): ParsedTodoTime | null {
  const s = (text || '').trim();
  if (!s) return null;

  const rawTime = parseTime(s);
  const time = rawTime && rawTime.h >= 0 && rawTime.h <= 23 && rawTime.m >= 0 && rawTime.m <= 59 ? rawTime : null;
  const date = parseDate(s, now);
  if (!date && !time) return null;

  let d = date;
  if (!d) {
    d = dayAt(now, 0);
    const minutesOfDay = time!.h * 60 + time!.m;
    if (minutesOfDay <= now.getHours() * 60 + now.getMinutes()) d = dayAt(now, 1);
  }

  const out: ParsedTodoTime = { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
  if (time) out.time = `${pad(time.h)}:${pad(time.m)}`;
  return out;
}
