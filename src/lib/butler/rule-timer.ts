/**
 * lib/butler/rule-timer.ts —— 定时候选（v6 §9.3 第三路 / §11-19/20）
 *
 * 职责：把「规则的 `trigger.time`（结构同 RecurrenceRule）」翻译成**宿主侧可执行的到期候选**。
 * 这一层只做两件纯判定 + 一次只读反查：
 *   ① 纯计算：`occurrencesInWindow(baseIso, time, now, window)`（复用 lib/calendar/recurrence，无 IO）；
 *   ② 幂等反查：读该规则的 `hits`，凡已有 `occurrence >= 本实例` 的记录即视为**已执行**，
 *      避免同一实例被重复执行（§9.2 配套要求「管家定时任务必须幂等」的等价物）。
 *
 * 它**只写一个「已告知」标记**（见 `missedTimerRules`）：执行与写 hits 仍由 rule-exec 统一负责（不变量 7）。
 *
 * base（起始锚点）：`RecurrenceRule` 无 base 字段（事件用 start_time 作 base，规则没有），
 * 故规则用 **`createdAt`（固化时刻）** 作 baseIso —— 固化时即定、可读、不含占位（计划 D2）。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { occurrencesInWindow, type OccurrenceWindow } from '@/lib/calendar/recurrence';
import { readRuleLog, type HitEntry } from './rule-logs';
import { STATE_DIR, ensureDir } from './storage';
import { atomicWriteFile } from './fs-atomic';
import type { RuleRecord } from './rules-shared';

/** 计算窗口：每次 butler 请求回看最近 T 毫秒内的到期实例（防漏；配合幂等防重复执行） */
export const TIMER_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * 漏触发扫描窗口（2026-10-02 评审 §2.2-7）：定时心跳寄生在渲染进程，
 * 只有 24h 补偿窗口，应用关得久一点，期间到期的实例就**永久不会补跑且无人知道**。
 * 本窗口只用于「找出来告诉用户」，**不用于补跑**（补跑会一次炸出一串历史实例）。
 */
export const MISSED_SCAN_MS = 30 * 24 * 60 * 60 * 1000;

/** 一条到期候选：规则 id + 本次对应的实例时刻（ms） */
export interface DueTimerHit {
  ruleId: string;
  occurrence: number;
}

/** 一条「错过且不会补跑」的定时实例（用于向用户告知，不进入执行） */
export interface MissedTimerHit {
  ruleId: string;
  ruleName: string;
  occurrence: number;
}

/** 已告知标记文件：`<butler>/.state/rule-missed-reported.json`（ruleId → 已告知到的实例时刻） */
function reportedFile(): string {
  return join(STATE_DIR, 'rule-missed-reported.json');
}

async function readReported(): Promise<Record<string, number>> {
  try {
    const raw = await fs.readFile(reportedFile(), 'utf-8');
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, number>;
  } catch { /* 无文件 / 损坏 → 空（宁可多告知一次） */ }
  return {};
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

/**
 * 宿主侧查「错过且不会补跑」的定时实例（只用于**告知**，不进入执行）。
 *
 * 判定：在 `[now - scanMs, now - lookbackMs)` 内存在实例，且该实例没有被任何更新命中覆盖
 * （沿用与 `dueTimerRules` 完全相同的幂等口径，避免两套语义打架）→ 它会永久错过。
 * ⚠️ 逐实例判定，不是逐规则：某条每日规则**今天刚到期**不影响「昨天及更早那些没跑过的实例」被报出来
 * ——它们确实错过了。反过来，只要执行过一次更晚的实例，更早的实例即视为被覆盖（不刷历史）。
 * 同一规则只取**最新一个**漏掉的实例；**每条规则只告知一次**（标记落 `.state/rule-missed-reported.json`，
 * 否则 60s 一次的心跳会反复刷同一条）。返回条数上限 `maxRules`，防止一次刷屏。
 */
export async function missedTimerRules(
  rules: RuleRecord[],
  now: Date,
  lookbackMs: number = TIMER_LOOKBACK_MS,
  scanMs: number = MISSED_SCAN_MS,
  maxRules = 3,
): Promise<MissedTimerHit[]> {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || scanMs <= lookbackMs) return [];
  const cutoff = nowMs - lookbackMs; // 落在这个时刻之前的实例 = 补偿窗口已关，不会补跑
  const window: OccurrenceWindow = { windowBeforeMs: scanMs, windowAfterMs: 0 };
  const reported = await readReported();
  const out: MissedTimerHit[] = [];

  for (const rule of rules) {
    if (out.length >= maxRules) break;
    if (rule.status !== 'active') continue;
    if (rule.kind !== 'rule') continue;
    const time = rule.trigger?.time;
    if (!time || !rule.createdAt) continue;

    const occ = occurrencesInWindow(rule.createdAt, time, nowMs, window);
    if (occ.length === 0) continue;

    const hits = await readRuleLog<HitEntry>('hits', rule.id);
    const executed = hits
      .map((h) => h.occurrence)
      .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));

    const missed = occ.filter((ms) => ms < cutoff && !executed.some((e) => e >= ms));
    if (missed.length === 0) continue;

    const latest = missed[missed.length - 1];
    const already = reported[rule.id];
    if (typeof already === 'number' && Number.isFinite(already) && already >= latest) continue; // 已告知过
    reported[rule.id] = latest;
    out.push({ ruleId: rule.id, ruleName: rule.name, occurrence: latest });
  }

  if (out.length > 0) {
    try {
      await ensureDir(STATE_DIR);
      await atomicWriteFile(reportedFile(), JSON.stringify(reported));
    } catch (e) {
      // 写标记失败只会导致「下次再告知一遍」——比丢掉告知安全，故不抛
      console.warn('[butler/rule-timer] 漏触发已告知标记写入失败:', e instanceof Error ? e.message : String(e));
    }
  }

  return out;
}