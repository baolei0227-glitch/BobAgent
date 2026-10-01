/**
 * 日历事件的「周期重复」规则（Butler 周期提醒的数据基座）
 *
 * 背景：改造前 events 只有单一 start_time，Butler 只能替用户订「一次性」时间点提醒；
 * 用户问「每天 9 点提醒我喝水」这类诉求无处安放。本模块给事件补一层**重复规则**，
 * 但**不新建调度器**——重复实例仍在既有的 event-reminder 扫描里「按需展开」：
 * 每次扫描只算出「落在本次扫描窗口内的那几个实例」，避免物料化上百条事件行。
 *
 * 规则是 iCalendar RRULE 的一个**受控子集**（不引第三方库，纯函数、无 IO）：
 *   { freq: 'daily' | 'weekly', interval?, byday?, count?, exdate?, overrides?, tzid?, until? }
 *   - daily ：自 start_time 起，每 interval 天重复（默认 1 天）
 *   - weekly：自 start_time 起，每 interval 周重复（默认 1 周），命中 byday 列出的星期几
 *   - byday ：0=周日 … 6=周六。weekly 缺省 = 起始日的星期几；daily 缺省 = 不筛（每天都算）
 *   - count ：总次数（含首次）。与 until 同时给出时**以 count 为准**
 *   - until ：结束时刻（ISO，**含**该时刻）；缺省 / null = 无限重复
 *   - exdate：跳过这些实例（ISO 的「实例开始时刻」）——DETACH 的「跳过这一次」
 *   - overrides：改写某个实例的开始时刻/标题——DETACH 的「只改这一次」
 *   - tzid  ：IANA 时区（如 Asia/Shanghai）。周期按**该时区的墙钟时间**展开，
 *             跨夏令时仍保持同一钟点；缺省 = 服务端本地时区
 *
 * 存库：events.recurrence_json，NULL = 无重复；否则为上述对象的 JSON。
 *
 * ⚠️ 与 event-reminder 的分工：本模块只做**纯计算**（无 IO、无 DB），
 * 实例是否该提醒、是否已发，仍由 event-reminder 结合 reminder_minutes / reminder_sent 判定。
 */

const DAY_MS = 86_400_000;

export type RecurrenceFreq = 'daily' | 'weekly';

/** 单实例改写（DETACH 的「只改这一次」）：把某个实例挪到别的时间 / 换个标题 */
export interface RecurrenceOverride {
  /** 被改写的实例**原始**开始时刻（ISO，按规则展开出来的那个）——匹配键 */
  instance: string;
  /** 改写后的开始时刻（ISO） */
  start_time: string;
  /** 改写后的标题；缺省 / null 沿用事件标题 */
  title?: string | null;
}

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** 每 N 个周期一次（≥1，默认 1）；weekly 的 N = 每 N 周 */
  interval?: number;
  /** 命中星期几（0=周日 … 6=周六） */
  byday?: number[];
  /** 总次数（含首次）；与 until 同时给出时以本字段为准 */
  count?: number;
  /** 跳过这些实例（ISO 的原始实例开始时刻） */
  exdate?: string[];
  /** 单实例改写 */
  overrides?: RecurrenceOverride[];
  /** IANA 时区（如 Asia/Shanghai）；缺省 / null = 服务端本地时区 */
  tzid?: string | null;
  /** 结束时刻（ISO，**含**该时刻）；缺省 / null = 无限重复 */
  until?: string | null;
}

const isFreq = (v: unknown): v is RecurrenceFreq => v === 'daily' || v === 'weekly';

/** 校验 IANA 时区名（Node 的 Intl 支持）；非法返回 false */
function isValidTzid(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const posInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;

/** 归一化 byday：整数 0-6、去重升序；无有效项 → null */
function normByday(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const days = v
    .map((d) => (typeof d === 'number' && Number.isFinite(d) ? Math.floor(d) : NaN))
    .filter((d) => d >= 0 && d <= 6);
  if (days.length === 0) return null;
  return [...new Set(days)].sort((a, b) => a - b);
}

/** 归一化 ISO 时刻数组（丢非法项）；无有效项 → null */
function normIsoList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const it of v) {
    if (typeof it !== 'string') continue;
    const ms = Date.parse(it);
    if (Number.isFinite(ms)) out.push(new Date(ms).toISOString());
  }
  return out.length > 0 ? out : null;
}

/** 归一化 overrides：丢弃 instance/start_time 非法者 */
function normOverrides(v: unknown): RecurrenceOverride[] | null {
  if (!Array.isArray(v)) return null;
  const out: RecurrenceOverride[] = [];
  for (const it of v) {
    if (!it || typeof it !== 'object') continue;
    const o = it as { instance?: unknown; start_time?: unknown; title?: unknown };
    if (typeof o.instance !== 'string' || typeof o.start_time !== 'string') continue;
    const im = Date.parse(o.instance);
    const sm = Date.parse(o.start_time);
    if (!Number.isFinite(im) || !Number.isFinite(sm)) continue;
    const title = typeof o.title === 'string' && o.title.trim() ? o.title : null;
    out.push({ instance: new Date(im).toISOString(), start_time: new Date(sm).toISOString(), title });
  }
  return out.length > 0 ? out : null;
}

/** 解析存库的 recurrence_json；非法 / 空 → null（视为不重复）。
 *  兼容旧格式（只有 freq / until）：未出现的字段不落到结果里（until 例外，恒存在、可为 null）。 */
export function parseRecurrence(raw: string | null | undefined): RecurrenceRule | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  if (!isFreq(rec.freq)) return null;

  const out: RecurrenceRule = { freq: rec.freq };

  const interval = posInt(rec.interval);
  if (interval !== null && interval > 1) out.interval = interval;

  const byday = normByday(rec.byday);
  if (byday) out.byday = byday;

  const count = posInt(rec.count);
  if (count !== null) out.count = count;

  const exdate = normIsoList(rec.exdate);
  if (exdate) out.exdate = exdate;

  const overrides = normOverrides(rec.overrides);
  if (overrides) out.overrides = overrides;

  if (typeof rec.tzid === 'string' && rec.tzid.trim() && isValidTzid(rec.tzid.trim())) {
    out.tzid = rec.tzid.trim();
  }

  out.until =
    typeof rec.until === 'string' && Number.isFinite(Date.parse(rec.until))
      ? new Date(Date.parse(rec.until)).toISOString()
      : null;

  return out;
}

/** 规则 → 存库字符串；无规则（null）→ null（写 SQL NULL）。
 *  只序列化**有效且有内容**的字段，保持旧格式的最小写法（`{"freq":"daily"}`）。 */
export function serializeRecurrence(rule: RecurrenceRule | null | undefined): string | null {
  if (!rule || !isFreq(rule.freq)) return null; // 非法输入 → 落到「不重复」，绝不错存成脏规则
  const out: Record<string, unknown> = { freq: rule.freq };

  const interval = posInt(rule.interval);
  if (interval !== null && interval > 1) out.interval = interval;

  const byday = normByday(rule.byday);
  if (byday) out.byday = byday;

  const count = posInt(rule.count);
  if (count !== null) out.count = count;

  const exdate = normIsoList(rule.exdate);
  if (exdate) out.exdate = exdate;

  const overrides = normOverrides(rule.overrides);
  if (overrides) out.overrides = overrides;

  if (typeof rule.tzid === 'string' && rule.tzid.trim() && isValidTzid(rule.tzid.trim())) {
    out.tzid = rule.tzid.trim();
  }

  if (rule.until && Number.isFinite(Date.parse(rule.until))) {
    out.until = new Date(Date.parse(rule.until)).toISOString();
  }

  return JSON.stringify(out);
}

/** 把任意输入（已解析对象 / JSON 字符串 / null）归一化为规则；无法识别 → null（= 不重复）。
 *  用于 API 边界（PATCH body 可能是对象，也可能是字符串），最终仍由 serializeRecurrence 落库。 */
export function coerceRecurrence(v: unknown): RecurrenceRule | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return parseRecurrence(v);
  if (typeof v === 'object') return parseRecurrence(JSON.stringify(v));
  return null;
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 星期几集合 → 可读短语（weekdays / weekends / 逗号列表） */
function bydayLabel(days: number[]): string {
  const s = [...new Set(days)].sort((a, b) => a - b);
  if (s.length === 7) return 'every day';
  if (s.length === 5 && s.every((d) => d >= 1 && d <= 5)) return 'weekdays';
  if (s.length === 2 && s.includes(0) && s.includes(6)) return 'weekends';
  return s.map((d) => DOW_SHORT[d]).join(', ');
}

/** 供 UI / 工具文案复用的短标签（英文，与 UI copy 口径一致）。
 *  默认规则刻意保持旧输出（'daily' / 'weekly'），仅在带 interval / byday / count 时才展开描述。 */
export function recurrenceLabel(rule: RecurrenceRule | null | undefined): string | null {
  if (!rule) return null;
  const n = rule.interval && rule.interval > 1 ? Math.floor(rule.interval) : 1;
  const parts: string[] = [];
  if (rule.freq === 'daily') {
    parts.push(n === 1 ? 'daily' : `every ${n} days`);
    if (rule.byday && rule.byday.length > 0 && rule.byday.length < 7) parts.push(bydayLabel(rule.byday));
  } else {
    parts.push(n === 1 ? 'weekly' : `every ${n} weeks`);
    if (rule.byday && rule.byday.length > 0) parts.push(`on ${bydayLabel(rule.byday)}`);
  }
  if (rule.count && rule.count > 0) parts.push(`×${rule.count}`);
  return parts.join(' ');
}

// ─── 时区：墙钟 ↔ UTC instant ────────────────────────────────────────────────

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const _dtfCache = new Map<string, Intl.DateTimeFormat>();

/** 某时刻在指定 IANA 时区的墙钟读数（无 tz 时走服务端本地时区） */
function wallInTz(ms: number, tz: string | null): Wall {
  if (!tz) {
    const d = new Date(ms);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  }
  let dtf = _dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    _dtfCache.set(tz, dtf);
  }
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** 该时刻在 tz 的 UTC 偏移（ms）。用「同一时刻的墙钟读数当作 UTC」与真实时刻相减求得。 */
function tzOffsetMs(ms: number, tz: string): number {
  const w = wallInTz(ms, tz);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 把「tz 时区的墙钟读数」还原成 UTC 时刻（处理夏令时跳变：偏移按修正后的时刻复核一次） */
function wallToMs(w: Wall, tz: string | null): number {
  if (!tz) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, 0).getTime();
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const off1 = tzOffsetMs(guess, tz);
  let ms = guess - off1;
  const off2 = tzOffsetMs(ms, tz);
  if (off2 !== off1) ms = guess - off2;
  return ms;
}

/** 墙钟读数 → 日历日序号（用 UTC 的 Y/M/D 求日差，天然与星期几对齐） */
function dayIndexOfWall(w: Wall): number {
  return Math.floor(Date.UTC(w.y, w.mo - 1, w.d) / DAY_MS);
}

/** 日序号 → 该日星期几（0=周日） */
function dayOfWeek(dayIndex: number): number {
  return new Date(dayIndex * DAY_MS).getUTCDay();
}

/** 日序号 → 所属周的周一序号（周一起算，与 lib/core/schedule.ts 口径一致） */
function mondayOf(dayIndex: number): number {
  return dayIndex - ((dayOfWeek(dayIndex) + 6) % 7);
}

// ─── 实例展开 ───────────────────────────────────────────────────────────────

export interface OccurrenceWindow {
  /** 实例开始时间须 ≥ now - windowBeforeMs（更早的实例其提醒点已过，无需再看） */
  windowBeforeMs: number;
  /** 实例开始时间须 ≤ now + windowAfterMs（= 最大提前量，即最晚可能已到点的实例） */
  windowAfterMs: number;
}

/** 展开出来的一个实例 */
export interface Occurrence {
  /** 生效开始时刻（UTC ms）——已被 override 改写时是改写值 */
  startMs: number;
  /** 规则展开出的**原始**开始时刻（override 的匹配键；无 override 时等于 startMs） */
  originalStartMs: number;
  /** 是否被 override 改写 */
  modified: boolean;
  /** override 指定的标题（无则用事件标题） */
  title?: string;
}

interface GenCtx {
  freq: RecurrenceFreq;
  interval: number;
  /** 命中的星期几；daily 且未指定 byday 时为 null（不筛） */
  byday: Set<number> | null;
  baseDayIndex: number;
  baseWeekMonday: number;
  baseWallTime: { h: number; mi: number; s: number };
}

/** 该日历日是否是规则命中的重复日（interval + byday 语义，按 RRULE 子集口径） */
function isOccurrenceDay(dayIndex: number, ctx: GenCtx): boolean {
  const k = dayIndex - ctx.baseDayIndex;
  if (k < 0) return false;
  const wd = dayOfWeek(dayIndex);
  if (ctx.freq === 'daily') {
    if (k % ctx.interval !== 0) return false;
    return ctx.byday === null || ctx.byday.has(wd);
  }
  // weekly：先按「周」定间隔，再看星期几
  const dw = Math.round((mondayOf(dayIndex) - ctx.baseWeekMonday) / 7);
  if (dw < 0 || dw % ctx.interval !== 0) return false;
  return ctx.byday !== null && ctx.byday.has(wd);
}

/** 该实例是「从首实例起的第几个」（0 起）；limit 用于提前退出（只需判断是否 ≥ count） */
function ordinalOf(dayIndex: number, ctx: GenCtx, limit: number): number {
  let n = -1;
  for (let d = ctx.baseDayIndex; d <= dayIndex; d++) {
    if (isOccurrenceDay(d, ctx)) {
      n += 1;
      if (n >= limit) return n;
    }
  }
  return n;
}

/**
 * 展开「落在扫描窗口内」的重复实例（含 override 改写信息），按生效开始时刻升序。
 *
 * 不做从 start_time 起的长循环：只遍历窗口覆盖的那几天（±1 天余量），逐日判定是否命中
 * （interval / byday 直接算，不靠长步进），再按 until / count / exdate 过滤、按 override 改写。
 * 这与「每次扫描 60s 一次」的调用频率相匹配。
 */
export function occurrencesInWindowDetailed(
  baseIso: string,
  rule: RecurrenceRule,
  now: number,
  window: OccurrenceWindow,
): Occurrence[] {
  const baseMs = Date.parse(baseIso);
  if (!Number.isFinite(now) || !Number.isFinite(baseMs)) return [];

  const tz = rule.tzid && isValidTzid(rule.tzid) ? rule.tzid : null;
  const baseWall = wallInTz(baseMs, tz);
  const baseDayIndex = dayIndexOfWall(baseWall);
  const interval = rule.interval && rule.interval >= 1 ? Math.floor(rule.interval) : 1;

  let byday: Set<number> | null;
  if (rule.byday && rule.byday.length > 0) byday = new Set(rule.byday);
  else if (rule.freq === 'weekly') byday = new Set([dayOfWeek(baseDayIndex)]);
  else byday = null;

  const ctx: GenCtx = {
    freq: rule.freq,
    interval,
    byday,
    baseDayIndex,
    baseWeekMonday: mondayOf(baseDayIndex),
    baseWallTime: { h: baseWall.h, mi: baseWall.mi, s: baseWall.s },
  };

  const lo = now - Math.max(0, window.windowBeforeMs);
  const hi = now + Math.max(0, window.windowAfterMs);
  const loDay = dayIndexOfWall(wallInTz(lo, tz)) - 1;
  const hiDay = dayIndexOfWall(wallInTz(hi, tz)) + 1;

  const untilMs = rule.until ? Date.parse(rule.until) : NaN;
  const count = rule.count && rule.count >= 1 ? Math.floor(rule.count) : null;
  const exSet = new Set<number>(
    (rule.exdate ?? []).map((s) => Date.parse(s)).filter((n) => Number.isFinite(n)),
  );
  const ovMap = new Map<number, RecurrenceOverride>();
  for (const o of rule.overrides ?? []) {
    const im = Date.parse(o.instance);
    if (Number.isFinite(im)) ovMap.set(im, o);
  }

  const out: Occurrence[] = [];
  for (let dayIndex = loDay; dayIndex <= hiDay; dayIndex++) {
    if (!isOccurrenceDay(dayIndex, ctx)) continue;
    const dt = new Date(dayIndex * DAY_MS);
    const occMs = wallToMs(
      { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), ...ctx.baseWallTime },
      tz,
    );
    if (occMs < baseMs) continue; // 不足一个整周期的「首实例之前」日期不算
    if (count !== null && ordinalOf(dayIndex, ctx, count) >= count) continue; // 超出总次数
    if (!count && Number.isFinite(untilMs) && occMs > untilMs) continue; // count 优先于 until
    if (exSet.has(occMs)) continue; // 被 exdate 跳过

    const ov = ovMap.get(occMs);
    const effMs = ov ? Date.parse(ov.start_time) : occMs;
    if (!Number.isFinite(effMs)) continue;
    if (effMs < lo || effMs > hi) continue;

    out.push({
      startMs: effMs,
      originalStartMs: occMs,
      modified: !!ov,
      title: ov?.title ?? undefined,
    });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/** 便捷版：只取实例的开始时刻（升序）。语义与 occurrencesInWindowDetailed 完全一致。 */
export function occurrencesInWindow(
  baseIso: string,
  rule: RecurrenceRule,
  now: number,
  window: OccurrenceWindow,
): number[] {
  return occurrencesInWindowDetailed(baseIso, rule, now, window).map((o) => o.startMs);
}