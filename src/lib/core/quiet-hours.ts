/**
 * Butler 主动推送的「克制」策略（B5）
 *
 * 背景（Today.ai 最反直觉的一层）：助理的价值不只是"提醒得更多"，而是**知道什么时候该闭嘴**。
 * 本项目此前的现状是"有推必推"——Morning 报告、Sticky 报告、到期提醒都会直接落到
 * 微信 / Butler 通知中心，全应用**没有任何免打扰或负荷策略**（B5 证据）。
 *
 * 本模块是**唯一**的推送裁决点，规则三档（按「谁定的」区分，而不是按内容长度）：
 *   1. `reminder` —— 用户自己在日历上订的时间点，**永不被免打扰静默**（静默别人替你定的闹钟
 *      是失信行为）。它只受「单日上限」约束，且逾期项视为必做。
 *   2. `report` / `meeting` / `other` —— 助理**主动发起**的汇报，免打扰时段内一律静默：
 *      微信推送直接跳过（内容仍进抽屉收件箱，不丢内容）。
 *      （2026-09-27 起日报三页签已移交 Today 面板、不再推送，`report` 档位实际已无来自日报的调用；
 *      规则保留，供会议纪要等其它主动汇报复用。）裁决结果带 `resumeAt` 供调用方说明顺延时刻。
 *   3. 单日上限 —— 到顶后主动推送一律静默（含 reminder），避免"刷屏式关心"。
 *
 * 折叠（对齐 Today 的克制原则）：一次要推多条待办时，**只推最紧急的一件** + 未展示计数，
 * 而不是把 20 条待办一次性倒给用户。紧急度排序 = 高优先级 > 已逾期 > 开始时间更早。
 *
 * 开关：`settings.butlerNotify.enabled` **默认 true**（2026-09-25 用户拍板「开箱即克制」）。
 * 只有**显式写 `enabled:false`** 才关闭；关闭时 `evaluatePush` 恒 `allow`，行为与改造前一致。
 * ⚠️ 例外：**读设置失败时按「策略未开启」放行**（见 `loadNotifyPolicy`）——策略层自身故障
 * 绝不能吞掉推送，否则一次 settings.json 读取抖动就会静默掉全部提醒。
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import type { ButlerNoticeItem } from '@/lib/bus';
import type { ButlerNotifySettings } from '@/lib/settings';

/* ==================== 默认值与类型 ==================== */

/** 默认免打扰窗口：22:00 → 次日 08:00（跨夜） */
export const DEFAULT_QUIET_START = '22:00';
export const DEFAULT_QUIET_END = '08:00';
/** 默认单日主动推送上限（0 = 不限） */
export const DEFAULT_DAILY_PUSH_LIMIT = 6;

/**
 * 推送类别。语义差别决定它是否可被免打扰静默：
 *  - `reminder`：用户自订的时间点提醒（日历提前提醒）→ **不静默**
 *  - `report`  ：助理主动汇报（Morning / Sticky / 笔记维护）
 *  - `meeting` ：会议纪要等衍生通知
 *  - `other`   ：兜底（未知来源），按主动推送处理（静默）
 */
export type PushKind = 'report' | 'reminder' | 'meeting' | 'other';

export type PushBlockReason = 'ok' | 'disabled' | 'quiet-hours' | 'daily-limit';

/** 解析后的策略（分钟数便于比较；避免每次推送重复解析字符串） */
export interface ResolvedNotifyPolicy {
  enabled: boolean;
  quietStartMin: number;
  quietEndMin: number;
  dailyPushLimit: number;
}

export interface PushDecision {
  /** 是否允许推送 */
  allow: boolean;
  /** 裁决依据：ok=放行 / disabled=策略未开启 / quiet-hours=免打扰 / daily-limit=达上限 */
  reason: PushBlockReason;
  /** 被静默时的顺延时刻（窗口结束或次日 0 点的 ms 时间戳）；放行时无 */
  resumeAt?: number;
  /** 当日已推条数 */
  used: number;
  /** 当日上限（0 = 不限） */
  limit: number;
}

/* ==================== 纯函数（可测、无 IO） ==================== */

/** 'HH:mm' / 'H:m' → 当日分钟数；非法返回 null */
export function parseHm(raw: string | undefined | null): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 把设置解析成策略；缺省项走默认值，非法 'HH:mm' 回落默认。
 *  `enabled` **缺省视为开启**（只有显式 `false` 才关）——2026-09-25 拍板「开箱即克制」。 */
export function resolveNotifyPolicy(s?: ButlerNotifySettings | null): ResolvedNotifyPolicy {
  const start = parseHm(s?.quietStart);
  const end = parseHm(s?.quietEnd);
  const limit = s?.dailyPushLimit;
  return {
    enabled: s?.enabled !== false,
    quietStartMin: start ?? parseHm(DEFAULT_QUIET_START)!,
    quietEndMin: end ?? parseHm(DEFAULT_QUIET_END)!,
    dailyPushLimit:
      typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
        ? Math.floor(limit)
        : DEFAULT_DAILY_PUSH_LIMIT,
  };
}

/** 策略「未开启」形态（恒放行）。用于：① 用户显式关闭；② **设置读取失败**兜底
 *  —— 策略层故障绝不能吞推送，宁可多推一次也不静默掉全部提醒。 */
export function disabledNotifyPolicy(): ResolvedNotifyPolicy {
  return {
    enabled: false,
    quietStartMin: parseHm(DEFAULT_QUIET_START)!,
    quietEndMin: parseHm(DEFAULT_QUIET_END)!,
    dailyPushLimit: DEFAULT_DAILY_PUSH_LIMIT,
  };
}

/**
 * 当前分钟数是否落在免打扰窗口内。
 * 支持跨夜（start > end，如 22:00→08:00）；start === end 视为**零长度窗口 = 不静默**
 * （否则会把全天判成静默，是危险默认）。
 */
export function isInQuietWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  // 跨夜：≥ start（今晚） 或 < end（明早）
  return nowMin >= startMin || nowMin < endMin;
}

/** 本地时区的当日分钟数（0..1439） */
export function localMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** 本地时区的日期键 'YYYY-MM-DD'（用于按天归零计数） */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 免打扰窗口的结束时刻（从 `from` 起算的**下一次**窗口结束 ms）。
 *  - 窗口已过（now < start，同日窗口还没到）→ 返回今天 endMin
 *  - 跨夜且在窗口内（now >= start）→ 返回**明天** endMin
 *  - 非跨夜且在窗口内 → 返回今天 endMin
 * 供调用方把被静默的推送顺延到窗口结束。
 */
export function nextQuietWindowEnd(from: Date, startMin: number, endMin: number): number {
  const nowMin = localMinutes(from);
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const atEndOfToday = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, endMin).getTime();
  if (startMin > endMin) {
    // 跨夜：窗口横跨午夜
    if (nowMin >= startMin) return atEndOfToday + 24 * 3600_000; // 已在今晚的窗口里 → 明早
    if (nowMin < endMin) return atEndOfToday; // 还在昨夜延续下来的窗口里 → 今早
    return atEndOfToday; // 不在窗口（白天）→ 今早的窗口已过；调用方一般不会用到
  }
  if (nowMin >= startMin && nowMin < endMin) return atEndOfToday;
  return atEndOfToday + (nowMin >= endMin ? 24 * 3600_000 : 0);
}

/** 优先级权重：high > normal > low，未知按 normal */
export function priorityWeight(p?: string): number {
  if (p === 'high') return 2;
  if (p === 'low') return 0;
  return 1;
}

/**
 * 紧急度比较器（升序 = 更紧急在前）：
 *   1. 优先级高者优先
 *   2. 同优先级：已逾期者优先
 *   3. 同档：开始时间更早者优先
 */
export function compareUrgency(a: ButlerNoticeItem, b: ButlerNoticeItem, now: number): number {
  const pw = priorityWeight(b.priority) - priorityWeight(a.priority);
  if (pw !== 0) return pw;
  const av = a.startMs > 0 ? a.startMs : Number.MAX_SAFE_INTEGER;
  const bv = b.startMs > 0 ? b.startMs : Number.MAX_SAFE_INTEGER;
  const aOverdue = av <= now ? 0 : 1;
  const bOverdue = bv <= now ? 0 : 1;
  if (aOverdue !== bOverdue) return aOverdue - bOverdue;
  return av - bv;
}

/**
 * 折叠：只留最紧急的 `max` 件，其余折成一句计数。
 * 返回 `kept`（展示用）、`foldedCount`、`note`（折叠说明，无折叠时为 ''）。
 */
export function foldNoticeItems(
  items: ButlerNoticeItem[],
  now: number = Date.now(),
  max = 1,
): { kept: ButlerNoticeItem[]; foldedCount: number; note: string } {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return { kept: [], foldedCount: 0, note: '' };
  const keepN = Math.max(1, Math.floor(max));
  if (list.length <= keepN) return { kept: list, foldedCount: 0, note: '' };
  const sorted = [...list].sort((a, b) => compareUrgency(a, b, now));
  const kept = sorted.slice(0, keepN);
  const foldedCount = sorted.length - kept.length;
  return { kept, foldedCount, note: `…另有 ${foldedCount} 项未展示（已折叠，避免刷屏）` };
}

/**
 * 纯裁决：给定策略 + 当日已推条数 + 类别 + 当前时间 → 是否放行。
 * 不做任何 IO，便于单测覆盖边界。
 */
export function evaluatePush(
  policy: ResolvedNotifyPolicy,
  used: number,
  kind: PushKind,
  now: Date,
): PushDecision {
  const limit = policy.dailyPushLimit;
  if (!policy.enabled) {
    return { allow: true, reason: 'disabled', used, limit };
  }
  // 用户自订的时间点提醒不受免打扰静默（只受单日上限）
  const mutableKind = kind !== 'reminder';
  if (mutableKind && isInQuietWindow(localMinutes(now), policy.quietStartMin, policy.quietEndMin)) {
    return {
      allow: false,
      reason: 'quiet-hours',
      resumeAt: nextQuietWindowEnd(now, policy.quietStartMin, policy.quietEndMin),
      used,
      limit,
    };
  }
  if (limit > 0 && used >= limit) {
    return { allow: false, reason: 'daily-limit', used, limit };
  }
  return { allow: true, reason: 'ok', used, limit };
}

/* ==================== 状态落盘（当日计数） ==================== */

/**
 * 计数状态文件路径。**惰性求值**：不在模块加载时调用 resolveAppRoot()，
 * 避免该模块被前端/单测间接 import 时受 BOBWORK_HOME 配置影响而抛错。
 */
function stateFilePath(): string {
  return join(resolveAppRoot(), 'butler', 'notify-state.json');
}

interface NotifyState {
  day: string;
  count: number;
}

/** 读当日已推条数；跨日自动归零（不写盘，写盘交给 recordPush） */
export async function readPushCount(now: Date = new Date()): Promise<number> {
  try {
    const raw = await readFile(stateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<NotifyState>;
    if (parsed?.day === localDayKey(now) && typeof parsed.count === 'number' && parsed.count >= 0) {
      return Math.floor(parsed.count);
    }
    return 0;
  } catch {
    return 0; // 无文件 / 损坏 → 视为 0（宁可多推的窗口期，也不因状态坏掉卡死推送）
  }
}

/** 记一次推送（+1 并落盘），返回累计条数。落盘失败不抛错（推送本身已完成） */
export async function recordPush(now: Date = new Date()): Promise<number> {
  const next = (await readPushCount(now)) + 1;
  try {
    const file = stateFilePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ day: localDayKey(now), count: next }), 'utf-8');
  } catch (e) {
    console.warn('[quiet-hours] 计数落盘失败（不影响推送）:', e instanceof Error ? e.message : String(e));
  }
  return next;
}

/* ==================== 对外主入口 ==================== */

/**
 * 读设置并解析策略。设置读取失败 → 回落 `disabledNotifyPolicy()`（**恒放行**），
 * 保证策略层自身的故障不会吞掉推送。
 */
export async function loadNotifyPolicy(): Promise<ResolvedNotifyPolicy> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    return resolveNotifyPolicy(settings?.butlerNotify);
  } catch (e) {
    console.warn('[quiet-hours] 读取设置失败，按策略未开启放行:', e instanceof Error ? e.message : String(e));
    return disabledNotifyPolicy();
  }
}

/**
 * 裁决一次主动推送。读策略 + 当日计数后走纯函数 `evaluatePush`。
 */
export async function decidePush(kind: PushKind, now: Date = new Date()): Promise<PushDecision> {
  const policy = await loadNotifyPolicy();
  const used = await readPushCount(now);
  return evaluatePush(policy, used, kind, now);
}
