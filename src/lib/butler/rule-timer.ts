/**
 * lib/butler/rule-timer.ts —— 定时候选（v6 §9.3 第三路 / §11-19/20）
 *
 * 职责：把「规则的 `trigger.time`（结构同 RecurrenceRule）」翻译成**宿主侧可执行的到期候选**。
 * 这一层只做两件纯判定 + 一次只读反查：
 *   ① 纯计算：`occurrencesInWindow(baseIso, time, now, window)`（复用 lib/calendar/recurrence，无 IO）；
 *   ② 幂等反查：读该规则的 `hits`，凡已有 `occurrence >= 本实例` 的记录即视为**已执行**，
 *      避免同一实例被重复执行（§9.2 配套要求「管家定时任务必须幂等」的等价物）。
 *
 * 它**不写任何东西**：执行与写 hits 仍由 rule-exec 的 adjudicateAndExecute 统一负责（不变量 7）。
 *
 * base（起始锚点）：`RecurrenceRule` 无 base 字段（事件用 start_time 作 base，规则没有），
 * 故规则用 **`createdAt`（固化时刻）** 作 baseIso —— 固化时即定、可读、不含占位（计划 D2）。
 */
import { occurrencesInWindow, type OccurrenceWindow } from '@/lib/calendar/recurrence';
import { readRuleLog, type HitEntry } from './rule-logs';
import type { RuleRecord } from './rules-shared';

/** 计算窗口：每次 butler 请求回看最近 T 毫秒内的到期实例（防漏；配合幂等防重复执行） */
export const TIMER_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** 一条到期候选：规则 id + 本次对应的实例时刻（ms） */
export interface DueTimerHit {
  ruleId: string;
  occurrence: number;
}

/**
 * 宿主侧查到期：对每条 active 的**确定性规则**（kind==='rule'）且带时间组者，
 * 若其时间组在 `[now - lookback, now]` 内有实例，且该实例尚未执行过 → 产一条到期候选。
 *
 * 幂等口径：只要 hits 里存在 `occurrence >= 某实例` 的命中，即认为该实例（及其更早的漏跑）都已
 * 被「最近一次执行」覆盖 —— 这既防重复执行，也防服务停机多日后一次补跑出一串历史实例。
 * 同一规则至多产一条候选（取最新的未覆盖实例）。
 */
export async function dueTimerRules(
  rules: RuleRecord[],
  now: Date,
  lookbackMs: number = TIMER_LOOKBACK_MS,
): Promise<DueTimerHit[]> {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];
  const window: OccurrenceWindow = { windowBeforeMs: lookbackMs, windowAfterMs: 0 };
  const out: DueTimerHit[] = [];

  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    if (rule.kind !== 'rule') continue; // 含判断步的流程定时触发走上层模型路径，不在此层
    const time = rule.trigger?.time;
    if (!time) continue;
    const baseIso = rule.createdAt;
    if (!baseIso) continue;

    const occ = occurrencesInWindow(baseIso, time, nowMs, window);
    if (occ.length === 0) continue;

    const hits = await readRuleLog<HitEntry>('hits', rule.id);
    const executed = hits
      .map((h) => h.occurrence)
      .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));

    const pending = occ.filter((ms) => !executed.some((e) => e >= ms));
    if (pending.length === 0) continue;
    out.push({ ruleId: rule.id, occurrence: pending[pending.length - 1] });
  }

  return out;
}