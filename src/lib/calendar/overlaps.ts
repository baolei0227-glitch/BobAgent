/**
 * 日历重叠查询（共享）—— 所有「写入日历」路径的同一套冲突检测。
 *
 * 背景（2026-09-25）：入日历共有三条路径 ——
 *   ① 便签「结算」自动入日历（lib/sticky-calendar-sync.ts → autoAddStickyLinesToCalendar）
 *   ② Butler 排程确认卡（app/api/chat/route.ts → buildButlerCard）
 *   ③ 便签手动「Add to calendar」（lib/sticky-calendar-sync.ts → addStickyLineToCalendar）
 * 此前只有 ② 检查重叠，① 仅按 (project_id, title, start_time) 防重 —— 便签写
 * 「明天 10 点和客户开会」结算即建事件，撞了既有安排也无感。本模块把查询收敛成一个函数供三方共用。
 *
 * 语义：返回与 [startIso, endIso) **有交集**且仍 scheduled 的事件（可排除自身），按开始时间升序。
 * 交集判定下沉到 lib/db.listEventsInRange（datetime() 归一化时区），因此「包住目标时段的长事件」
 * 同样会被命中，不会像「只看 start_time 落在窗口内」那样漏判。
 */

/** 单条重叠事件（when 已按目标日格式化，供卡片/备注直接展示） */
export type EventOverlap = {
  event_id: string;
  title: string;
  /** 原样回传事件的 start/end（可能为 null）；展示用 when */
  start: string | null;
  end: string | null;
  /** 与目标同日 → `09:00–11:00`；跨日 → `09-26 09:00–11:00`；无结束时间 → `09:00` */
  when: string;
};

export type OverlapResult = {
  /** 命中总数（未截断） */
  total: number;
  /** 截断后的明细，最多 limit 条 */
  items: EventOverlap[];
};

const EMPTY: OverlapResult = { total: 0, items: [] };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hm(d: Date | null): string {
  return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
}

function md(d: Date | null): string {
  return d ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '';
}

/**
 * 查与 [startIso, endIso) 重叠的 scheduled 事件。
 * @param endIso 缺省按 startIso + 30 分钟（与 Butler 确认卡口径一致）；仅 startIso 可解析时才查询。
 * @param excludeEventId 排除自身（改期时必传，否则会把旧时刻的自己算成冲突）
 * @param limit 明细上限，默认 5
 */
export async function findEventOverlaps(
  startIso: string | null | undefined,
  endIso?: string | null,
  opts?: { excludeEventId?: string | null; limit?: number },
): Promise<OverlapResult> {
  const start = parse(startIso);
  if (!start) return EMPTY;
  const limit = opts?.limit && opts.limit > 0 ? opts.limit : 5;
  try {
    const { getCalendarDb, listEventsInRange } = await import('@/lib/db');
    const db = await getCalendarDb();
    const startKey = start.toISOString();
    const end = parse(endIso) ?? new Date(start.getTime() + 30 * 60_000);
    const rows = await listEventsInRange(db, null, startKey, end.toISOString());
    const hits = rows.filter(
      (r) => r.status === 'scheduled' && r.event_id !== (opts?.excludeEventId ?? null),
    );
    const items: EventOverlap[] = hits.slice(0, limit).map((r) => {
      const s = parse(r.start_time);
      const e = parse(r.end_time);
      const sameDay = !!s && !!e && md(s) === md(start);
      const span = e ? `${hm(s)}–${hm(e)}` : hm(s);
      return {
        event_id: r.event_id,
        title: r.title,
        start: r.start_time,
        end: r.end_time,
        when: sameDay ? span : `${md(s) || md(start)} ${span}`.trim(),
      };
    });
    return { total: hits.length, items };
  } catch (e) {
    console.error('[calendar-overlaps] 重叠查询失败:', e);
    return EMPTY;
  }
}

/** 冲突备注行的固定前缀：重排时按它识别并替换「我们自己写过的那一行」，
 *  不动用户在日历里手写的事件备注（不会被覆盖或抹掉）。 */
export const OVERLAP_NOTE_PREFIX = '注意 · 与已有安排重叠';

/** 把重叠结果压成一行备注文本（写进事件 description / 回传前端）；无重叠返回空串 */
export function formatOverlapNote(res: OverlapResult, label = OVERLAP_NOTE_PREFIX): string {
  if (res.total === 0) return '';
  const lines = res.items.map((i) => `${i.when} ${i.title}`.trim()).join('；');
  const more = res.total > res.items.length ? `（共 ${res.total} 条，仅列 ${res.items.length} 条）` : '';
  return `${label}：${lines}${more}`;
}

// ==================== 时段风险评估（重叠 / 紧邻 / 异地 / 全天） ====================
//
// 用途（2026-09-27）：Butler 对话式建日程要在**落地前**把「这个时段合不合适」讲清楚。
// findEventOverlaps 只回答「有没有重叠」，而用户真正在意的还有两类**潜在冲突**：
//   ① 紧接上一个日程的结束时间，中间不够转移（默认 < 15 分钟）；
//   ② 相邻事项异地 / 需通勤（上一场有地点、这场地点不同，且间隔 < 60 分钟）。
// 故把三类判定收敛成一个 assessEventSlot，返回分档结果 + 真正空着的替代时段，
// 由 create_scheduled_todo 在执行器内一次调用完成——避免「先查一遍再报告」的多轮仪式。

/** 潜在风险类型：紧邻空档不足 / 相邻异地 / 与全天日程同日 */
export type SlotRiskKind = 'tight_gap' | 'remote_shift' | 'all_day';

/** 单条潜在风险（message 已可直接转述给用户，模型不必自己算） */
export interface SlotRisk {
  kind: SlotRiskKind;
  message: string;
  event_id?: string;
  title?: string;
  /** 相邻事件的展示时段（同日 `09:00–11:00`，跨日带 MM-DD） */
  when?: string;
  gap_minutes?: number;
  location?: string | null;
}

/** 净空替代时段（label 已按今天/明天/日期格式化） */
export interface FreeSlot {
  start: string;
  end: string;
  label: string;
}

/** 时段评估结果：none = 可直接落地；potential = 先确认；hard = 重叠，不许落地 */
export interface SlotAssessment {
  level: 'none' | 'potential' | 'hard';
  total_overlaps: number;
  /** 与目标时段有交集的事件（最多 5 条） */
  overlaps: EventOverlap[];
  risks: SlotRisk[];
  /** 仅在 potential / hard 时给出：工作时段内 1–2 个真正空着的替代时段 */
  alternatives: FreeSlot[];
}

export interface AssessSlotInput {
  startIso: string | null | undefined;
  endIso?: string | null;
  /** 本次事项的地点（用户提到才传；与相邻事项不同才提示异地） */
  location?: string | null;
  allDay?: boolean;
  /** 改期时排除自身 */
  excludeEventId?: string | null;
  /** 紧邻空档阈值（分钟），默认 15 */
  gapMinutes?: number;
  /** 需要通勤考虑的相邻间隔阈值（分钟），默认 60 */
  neighborMinutes?: number;
  /** 替代时段搜索的工作时段（24 制小时），默认 9–18 */
  workStartHour?: number;
  workEndHour?: number;
  /** 替代时段个数上限，默认 2 */
  maxAlternatives?: number;
}

/** 本地同一天 */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** 相对今天的日期标签：今天 / 明天 / MM-DD */
function dayLabel(d: Date, now: Date): string {
  if (isSameLocalDay(d, now)) return '今天';
  if (isSameLocalDay(d, new Date(now.getTime() + 24 * 3600_000))) return '明天';
  return md(d);
}

/** 地点比较：同一场所常有别名/错字/带括号地址（"第十五法庭" vs "第的第十五法庭开法庭（上海市年波路88号）"），
 *  纯字符串比较会误报异地。故：完全一致 / 一方包含另一方 → 同场所；否则按字符二元组 Jaccard ≥ 0.5 判同。
 *  同一栋楼里的不同房间会因此判为同场所——这正是想要的：同建筑内移动不算通勤风险。 */
function samePlace(a: string | null | undefined, b: string | null | undefined): boolean {
  const clean = (s: string | null | undefined) =>
    String(s ?? '')
      .replace(/[\s·、,，.。:：;；\-—/\\（）()【】[\]]/g, '')
      .toLowerCase();
  const x = clean(a);
  const y = clean(b);
  if (!x || !y) return true; // 缺一方就不谈异地（调用处已要求两边非空）
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(x);
  const gb = grams(y);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

/** 地点短名：去掉括号里的地址补充并截断——它要进给用户看的一句话，不能塞整条地址 */
function briefLocation(s: string | null | undefined): string {
  const t = String(s ?? '').replace(/[（(][^）)]*[)）]/g, '').trim();
  return t.length > 14 ? `${t.slice(0, 14)}…` : t;
}

/** 时段是否与任一忙碌区间冲突（含紧邻空档不足） */
function slotIsFree(
  s: Date,
  e: Date,
  busy: { s: Date; e: Date }[],
  gapMs: number,
): boolean {
  for (const b of busy) {
    if (s.getTime() < b.e.getTime() && e.getTime() > b.s.getTime()) return false; // 重叠
    const gap = s.getTime() >= b.e.getTime() ? s.getTime() - b.e.getTime() : b.s.getTime() - e.getTime();
    if (gap < gapMs) return false; // 紧邻空档不足
  }
  return true;
}

/**
 * 评估目标时段：重叠（hard）→ 紧邻 / 异地 / 全天（potential）→ 否则 none。
 * 无 startIso 时返回 none（无时间的待办不参与判定）。
 * 单次 DB 查询取「目标时段 ±1 天」的未取消事件，其后全部在内存计算。
 */
export async function assessEventSlot(input: AssessSlotInput): Promise<SlotAssessment> {
  const EMPTY_ASSESSMENT: SlotAssessment = {
    level: 'none',
    total_overlaps: 0,
    overlaps: [],
    risks: [],
    alternatives: [],
  };
  const start = parse(input.startIso);
  if (!start) return EMPTY_ASSESSMENT;
  const now = new Date();
  const end = parse(input.endIso) ?? new Date(start.getTime() + 30 * 60_000);
  const gapMs = (input.gapMinutes ?? 15) * 60_000;
  const neighborMs = (input.neighborMinutes ?? 60) * 60_000;
  const maxAlt = input.maxAlternatives ?? 2;

  try {
    const { getCalendarDb, listEventsInRange } = await import('@/lib/db');
    const db = await getCalendarDb();
    const rows = (
      await listEventsInRange(
        db,
        null,
        new Date(start.getTime() - 24 * 3600_000).toISOString(),
        new Date(end.getTime() + 48 * 3600_000).toISOString(),
      )
    ).filter((r) => r.status === 'scheduled' && r.event_id !== (input.excludeEventId ?? null));

    // 忙碌区间：无 end_time 按点事件 +30 分钟（与 listEventsInRange 口径一致）
    const busy = rows
      .map((r) => {
        const s = parse(r.start_time);
        if (!s) return null;
        const e = parse(r.end_time) ?? new Date(s.getTime() + 30 * 60_000);
        return { s, e, row: r };
      })
      .filter((x): x is { s: Date; e: Date; row: (typeof rows)[number] } => !!x);

    // ① 重叠 = hard。全天日程（all_day=1）不计入 hard：它表达的是「这一天的基调」（出差/放假），
    //    并不真的占住某个小时，用户仍常在其中安排具体会议——按 potential 提示更合适（见下方 all_day 风险）。
    const overlapHits = busy.filter(
      (b) => b.row.all_day !== 1 && b.s.getTime() < end.getTime() && b.e.getTime() > start.getTime(),
    );
    const overlaps: EventOverlap[] = overlapHits.slice(0, 5).map((b) => {
      const span = `${hm(b.s)}–${hm(b.e)}`;
      return {
        event_id: b.row.event_id,
        title: b.row.title,
        start: b.row.start_time,
        end: b.row.end_time,
        when: isSameLocalDay(b.s, start) ? span : `${md(b.s)} ${span}`.trim(),
      };
    });

    // ② 紧邻 / 异地 / 全天 = potential
    const risks: SlotRisk[] = [];
    const neighbors = busy
      .map((b) => ({
        ...b,
        gapMs:
          b.s.getTime() >= end.getTime()
            ? b.s.getTime() - end.getTime()
            : b.e.getTime() <= start.getTime()
              ? start.getTime() - b.e.getTime()
              : -1,
      }))
      .filter((b) => b.gapMs >= 0);

    for (const n of neighbors) {
      const gapMinutes = Math.round(n.gapMs / 60_000);
      const when = `${isSameLocalDay(n.s, start) ? '' : `${md(n.s)} `}${hm(n.s)}–${hm(n.e)}`.trim();
      if (n.gapMs < gapMs) {
        const before = n.e.getTime() <= start.getTime();
        risks.push({
          kind: 'tight_gap',
          message: before
            ? `紧接「${n.row.title}」（${when}）结束之后，中间只有 ${gapMinutes} 分钟。`
            : `紧接着「${n.row.title}」（${when}）就要开始，中间只有 ${gapMinutes} 分钟。`,
          event_id: n.row.event_id,
          title: n.row.title,
          when,
          gap_minutes: gapMinutes,
          location: n.row.location,
        });
      }
      // 异地：相邻到需要考虑通勤，且两边都有地点且地点不同
      if (
        n.gapMs < neighborMs &&
        String(n.row.location ?? '').trim() &&
        String(input.location ?? '').trim() &&
        !samePlace(n.row.location, input.location)
      ) {
        risks.push({
          kind: 'remote_shift',
          message: `相邻的「${n.row.title}」（${when}，${briefLocation(n.row.location)}）与本次地点（${briefLocation(input.location)}）不同，间隔仅 ${gapMinutes} 分钟，可能赶不上。`,
          event_id: n.row.event_id,
          title: n.row.title,
          when,
          gap_minutes: gapMinutes,
          location: n.row.location,
        });
      }
    }

    // 全天 ↔ 精确时段同日
    if (input.allDay !== true) {
      const allDayHit = busy.find((b) => b.row.all_day === 1 && isSameLocalDay(b.s, start));
      if (allDayHit) {
        risks.push({
          kind: 'all_day',
          message: `当天已有全天日程「${allDayHit.row.title}」。`,
          event_id: allDayHit.row.event_id,
          title: allDayHit.row.title,
          when: dayLabel(allDayHit.s, now),
        });
      }
    } else {
      const timedHit = busy.find((b) => b.row.all_day !== 1 && isSameLocalDay(b.s, start));
      if (timedHit) {
        risks.push({
          kind: 'all_day',
          message: `当天已有定时日程「${timedHit.row.title}」（${hm(timedHit.s)}）。`,
          event_id: timedHit.row.event_id,
          title: timedHit.row.title,
          when: `${hm(timedHit.s)}`,
        });
      }
    }

    const level: SlotAssessment['level'] =
      overlaps.length > 0 ? 'hard' : risks.length > 0 ? 'potential' : 'none';

    // ③ 替代时段：仅在有冲突时给出。顺序上先给「请求时刻之后最近的空档」（用户要的是这个点附近），
    //    再补当日更早的时段，最后才是后续两天；候选之间互不重叠，避免给出两个互相打架的选项。
    const alternatives: FreeSlot[] = [];
    if (level !== 'none' && maxAlt > 0) {
      const durationMs = Math.max(end.getTime() - start.getTime(), 30 * 60_000);
      const workStart = input.workStartHour ?? 9;
      const workEnd = input.workEndHour ?? 18;
      const taken: { s: Date; e: Date }[] = [];
      const dayBounds = (offset: number) => {
        const d = new Date(start);
        d.setDate(d.getDate() + offset);
        return {
          from: new Date(d.getFullYear(), d.getMonth(), d.getDate(), workStart, 0, 0).getTime(),
          to: new Date(d.getFullYear(), d.getMonth(), d.getDate(), workEnd, 0, 0).getTime(),
        };
      };
      const scan = (from: number, to: number) => {
        for (let t = from; t + durationMs <= to && alternatives.length < maxAlt; t += 30 * 60_000) {
          const cs = new Date(t);
          const ce = new Date(t + durationMs);
          if (cs.getTime() <= now.getTime()) continue; // 过去的时间不是候选
          if (!slotIsFree(cs, ce, busy, gapMs)) continue;
          if (!slotIsFree(cs, ce, taken, gapMs)) continue; // 候选之间也不互相打架
          alternatives.push({
            start: cs.toISOString(),
            end: ce.toISOString(),
            label: `${dayLabel(cs, now)} ${hm(cs)}–${hm(ce)}`,
          });
          taken.push({ s: cs, e: ce });
        }
      };
      const today = dayBounds(0);
      const snappedStart = Math.ceil(start.getTime() / (30 * 60_000)) * (30 * 60_000);
      scan(Math.max(today.from, snappedStart), today.to); // 请求时刻之后最近的空档
      scan(today.from, Math.min(snappedStart, today.to)); // 当日更早的时段兜底
      for (let offset = 1; offset <= 2 && alternatives.length < maxAlt; offset++) {
        const b = dayBounds(offset);
        scan(b.from, b.to);
      }
    }

    return { level, total_overlaps: overlapHits.length, overlaps, risks, alternatives };
  } catch (e) {
    console.error('[calendar-overlaps] 时段评估失败:', e);
    return EMPTY_ASSESSMENT;
  }
}

/** 把「上一版冲突备注」从 description 里摘掉（保留其余用户内容），用于重排时刷新提示 */
export function stripOverlapNote(description: string | null | undefined): string {
  return String(description ?? '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith(OVERLAP_NOTE_PREFIX))
    .join('\n')
    .trim();
}
