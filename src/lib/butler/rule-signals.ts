/**
 * lib/butler/rule-signals.ts —— 规则**信号唯一写口**（server-only）
 *
 * 依据：v6 §7（信号闭环）：「`user_dismissed` 定义一次，两处共用（3.4 拉黑 + Q6 修订阈值）」。
 * 把六类信号的写入收敛到一个模块，杜绝「拉黑」与「修订」各写一套、口径漂移。
 *
 * 信号 → 落点（Phase 1）：
 *   hits                执行成功 / 含判断步的规则启动时
 *   output_edited       改动了一个由规则产出的待办（用 findRuleByProducedRef 归因）
 *   rule_violated       约束型规则宿主自检（Phase 1 无场景，只建接口，见计划 D4）
 *   user_dismissed      用户显式否定（rule_dismiss / 规则草案被拒）
 *   conflict-resolution 裁决 need_user 且用户选定后
 *   negative-sample     near-miss 询问被否定 / 模式被拉黑
 *
 * 依赖：rule-logs（存储）与 rules-shared（纯判据）。不 import rules.ts / route，避免环。
 */
import {
  appendRuleLog,
  readRuleLog,
  readHitWindow,
  findRuleByProducedRef,
  type HitEntry,
  type SkillFailureEntry,
  type UserDismissedEntry,
  type NegativeSampleEntry,
  type NegativeSampleClass,
} from './rule-logs';
export type { NegativeSampleClass } from './rule-logs';
import { evaluateRevision, REVISION_WINDOW } from './rules-shared';

/** 命中来源场景标签（宿主侧 detectSceneHints 的场景名，仅供日志可读） */
export type HitScene = string;

/**
 * 负样本的分片键集合（真源，2026-10-02 从 `/api/butler/rules/negative-samples` 上移到这里）：
 * 对象类型（§3.4 Q13）+ Phase 1 遗留的 `'rule'` 分片（只读兼容，不迁移）。
 * 消费方：negative-samples 路由（可见 / 解封）与 memory-audit 聚合（证据视图）。
 */
export const NEGATIVE_OBJECT_TYPES = ['todo', 'schedule', 'note', 'meeting', 'project', 'rule'] as const;

/**
 * 落一条命中（producedRef = 产出对象引用，供 output_edited 归因）。
 * `occurrence` 仅定时候选命中时传（实例时刻 ms），供 rule-timer 幂等去重；语面命中不传。
 */
export async function recordHit(
  ruleId: string,
  ruleVersion: number,
  scene: HitScene,
  producedRef?: string,
  occurrence?: number,
): Promise<void> {
  await appendRuleLog('hits', ruleId, {
    scene,
    rule_version: ruleVersion,
    ...(producedRef ? { producedRef } : {}),
    ...(typeof occurrence === 'number' ? { occurrence } : {}),
  });
}

/** 落一条「产出被改动」（diff 为可读的前后摘要） */
export async function recordOutputEdited(
  ruleId: string,
  ruleVersion: number,
  ref: string,
  before: string,
  after: string,
): Promise<void> {
  await appendRuleLog('output_edited', ruleId, {
    rule_version: ruleVersion,
    diff: `${before} → ${after}`,
    // 产出对象引用：便于详情页把改动与具体待办对上（Phase 1 只记录，不做回链跳转）
    stepFieldMap: { ref },
  });
}

/** 落一条「规则被违反」（Phase 1 无机器可自检的约束型规则 → 只建接口，见计划 D4） */
export async function recordRuleViolated(
  ruleId: string,
  ruleVersion: number,
  detail: string,
): Promise<void> {
  await appendRuleLog('rule_violated', ruleId, { rule_version: ruleVersion, detail });
}

/**
 * 用户显式否定：写 **一条** `user_dismissed`（拉黑与修订阈值两处共读同一条）。
 * 「**否决即拉黑**」（v6 §3.4）：传入该规则覆盖的**对象类型**时，**立即**额外落一条
 * class='signal_mismatch' 的负样本，使该对象类型的 near-miss 询问不再产生候选。
 * 「问过几次」的限流是**另一个计数**（rule-nearmiss.consumeAsk），二者分离（D8）。
 */
export async function recordUserDismissed(
  ruleId: string,
  ruleVersion: number,
  source: string,
  objectType?: string,
): Promise<void> {
  await appendRuleLog('user_dismissed', ruleId, { rule_version: ruleVersion, source });
  if (objectType) {
    await recordNegativeSample(objectType, objectType, 'blocked', 'signal_mismatch');
  }
}

/** 落一条冲突消解记录（两条规则 id 的有序对分片） */
export async function recordConflictResolution(
  a: string,
  b: string,
  inputFeature: string,
  chosen: string,
  versions: [number, number],
): Promise<void> {
  const key = [a, b].sort().join('__');
  await appendRuleLog('conflict-resolution', key, { inputFeature, chosen, versions });
}

/** 负样本的「类」：缺省（Phase 1 旧记录）语义 = signal_mismatch（旧记录正是「否定某条规则」＝召回检查） */
export function normalizeNegativeClass(e: NegativeSampleEntry): NegativeSampleClass {
  return e.class ?? 'signal_mismatch';
}

/** 落一条负样本（objectType 分片；key 与 pattern 均为对象类型——模式键只由对象类型构成，§3.4 Q13） */
export async function recordNegativeSample(
  objectType: string,
  pattern: string,
  action: string,
  cls: NegativeSampleClass = 'signal_mismatch',
): Promise<void> {
  await appendRuleLog('negative-sample', objectType, { pattern, action, class: cls });
}

/**
 * 同一 pattern 的「当前状态」：以**最后一条**记录为准（可按类过滤）。
 * 日志是 append-only，所以解封不删历史，而是追加一条 action='unblocked'；
 * 读侧按 latest-wins 解析出当前是否仍处拉黑态（旧记录保留，仍可审计）。
 */
function latestPerPattern(
  entries: NegativeSampleEntry[],
  cls?: NegativeSampleClass,
): Map<string, NegativeSampleEntry> {
  const m = new Map<string, NegativeSampleEntry>();
  for (const e of entries) {
    if (cls && normalizeNegativeClass(e) !== cls) continue;
    m.set(e.pattern, e); // readRuleLog 为写入顺序（升序）→ 后写覆盖
  }
  return m;
}

/** 某模式当前是否处于拉黑态（以最后一条负样本记录为准，支持解封；可按类过滤） */
export async function isPatternBlocked(
  objectType: string,
  pattern: string,
  cls?: NegativeSampleClass,
): Promise<boolean> {
  const entries = await readRuleLog<NegativeSampleEntry>('negative-sample', objectType);
  return latestPerPattern(entries, cls).get(pattern)?.action === 'blocked';
}

/** 列出某 objectType 下全部负样本（含历史；总览页可读原始记录；可按类过滤） */
export async function listNegativeSamples(
  objectType: string,
  cls?: NegativeSampleClass,
): Promise<NegativeSampleEntry[]> {
  const entries = await readRuleLog<NegativeSampleEntry>('negative-sample', objectType);
  return cls ? entries.filter((e) => normalizeNegativeClass(e) === cls) : entries;
}

/** 列出某 objectType 下**当前仍被拉黑**的模式（latest-wins 过滤；解封后即从该列表消失；可按类过滤） */
export async function listBlockedPatterns(
  objectType: string,
  cls?: NegativeSampleClass,
): Promise<NegativeSampleEntry[]> {
  const entries = await readRuleLog<NegativeSampleEntry>('negative-sample', objectType);
  return [...latestPerPattern(entries, cls).values()].filter((e) => e.action === 'blocked');
}

/**
 * 修订评估：读最近 REVISION_WINDOW 次命中与其中的否定计数 → 纯判据（v6 §3.1 / Q6）。
 * 样本不足 K 时 `active=false`（机制未启用），阈值判定只在样本足够时生效。
 *
 * `currentVersion` 传入时启用「窗口清零」语义（rule_revise 使 version++ 后）：
 * 只统计 `rule_version >= currentVersion` 的命中，旧版本样本不再计入修订判据。
 * 只做**读取侧过滤**、不删日志——符合「无静默截断」不变量（旧记录仍可审计）。
 */
export async function evaluateRuleRevision(
  ruleId: string,
  currentVersion?: number,
): Promise<{ active: boolean; ratio: number; shouldPropose: boolean }> {
  const { hits, dismissed } = await readHitWindow(ruleId, REVISION_WINDOW);
  if (typeof currentVersion === 'number') {
    const fresh = hits.filter((h) => (h.rule_version ?? 0) >= currentVersion);
    const startAt = fresh.length > 0 ? fresh[0].at : null;
    const freshDismissed = startAt ? dismissed.filter((d) => (d.at ?? '') >= startAt) : [];
    return evaluateRevision(fresh.length, freshDismissed.length);
  }
  return evaluateRevision(hits.length, dismissed.length);
}

export { findRuleByProducedRef };

// ==================== 技能信号（Phase 3 §3.8：**复用同一写口**） ====================
// 技能与规则共用 hits / user_dismissed 分片存储，只是分片键换成技能 id（sk-…）。
// 因此修订判据、产出归因、否定计数全部零改动复用；这里只补「失败」这一技能独有的信号。

/**
 * 落一次技能执行结果：成功 → `hits`（与规则同口径）；失败 → `skill_failure`（隔离判据原料）。
 * gating 早退（找不到 / 非 active / 未受审原语）**不算**运行失败，调用方不应在此落账。
 */
export async function recordSkillRun(
  skillId: string,
  skillVersion: number,
  ok: boolean,
  producedRef?: string,
  reason?: string,
): Promise<void> {
  if (ok) {
    await appendRuleLog('hits', skillId, {
      scene: 'skill',
      rule_version: skillVersion,
      ...(producedRef ? { producedRef } : {}),
    });
    return;
  }
  await appendRuleLog('skill_failure', skillId, {
    rule_version: skillVersion,
    ...(reason ? { reason } : {}),
  });
}

/** 技能运行统计（成败信号 = 卡片展示项③：用过几次、成功 / 失败 / 被否） */
export interface SkillRunStats {
  /** 成功执行次数（`hits` 条数） */
  ok: number;
  /** 失败次数（`skill_failure` 条数） */
  failed: number;
  /** 被否次数（`user_dismissed` 条数） */
  dismissed: number;
  /** 连续失败数（隔离判据原料） */
  consecutiveFailures: number;
}

/**
 * 汇总一条技能的运行统计（成功 / 失败 / 被否与连续失败数一次读齐，供治理面一次取全）。
 * 连续失败数：两份日志按 `at` 归并后取尾部连续失败段（append-only、时间升序）。
 * 注：`at` 为毫秒精度——同一毫秒内既成功又失败会按「成功在前」归并；技能单次执行含 fs 写入，
 * 跨毫秒是常态，故生产无虞（测试需跨毫秒写入）。
 */
export async function skillRunStats(skillId: string): Promise<SkillRunStats> {
  const [hits, fails, dismissed] = await Promise.all([
    readRuleLog<HitEntry>('hits', skillId),
    readRuleLog<SkillFailureEntry>('skill_failure', skillId),
    readRuleLog<UserDismissedEntry>('user_dismissed', skillId),
  ]);
  const merged = [
    ...hits.map((h) => ({ at: h.at, ok: true })),
    ...fails.map((f) => ({ at: f.at, ok: false })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let consecutiveFailures = 0;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].ok) break;
    consecutiveFailures++;
  }
  return { ok: hits.length, failed: fails.length, dismissed: dismissed.length, consecutiveFailures };
}

/** 连续失败数（隔离判据；`skillRunStats` 的便捷封装） */
export async function countConsecutiveSkillFailures(skillId: string): Promise<number> {
  return (await skillRunStats(skillId)).consecutiveFailures;
}

/** 技能修订评估（与规则**同判据**，故直接复用；技能版提议修订的读口） */
export async function evaluateSkillRevision(
  skillId: string,
  currentVersion?: number,
): Promise<{ active: boolean; ratio: number; shouldPropose: boolean }> {
  return evaluateRuleRevision(skillId, currentVersion);
}