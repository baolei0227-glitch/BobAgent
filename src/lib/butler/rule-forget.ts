/**
 * lib/butler/rule-forget.ts —— 规则的**主动遗忘**（server-only）
 *
 * 与 rule-nearmiss「一次即记忆」配套：既然不再靠「攒够 N 次」过滤噪声，就必须有遗忘兜底。
 *   - draft ：长期未被确认、也未再命中 → **惰性清除**（静默学来的草稿可自动消失）；
 *   - active：**绝不静默删**——只 `stale` 标记，交给面板产「建议废除」软提示，用户可恢复。
 *
 * 走「拉」不走「推」：不引入常驻调度器（对齐 Butler Tick「桌面端按需调」的既有约定），
 * 由 runtime.butlerTick 顺带惰性 sweep。判据（阈值与时间口径）全部取自 rules-shared，与面板同源。
 *
 * 依赖：rules（读写原语）与 rule-logs（命中时间）；不 import rule-exec / runtime，避免环。
 */
import { listRules, deleteRule } from './rules';
import { readRuleLog, type HitEntry } from './rule-logs';
import { isDraftExpired, isRuleStale, type RuleRecord } from './rules-shared';

/** 一条规则的运行活动度（供面板排序与「建议废除」标记） */
export interface RuleActivity {
  /** 命中次数（含 near-miss 的「印证」；上限见 rule-logs.MAX_LINES_PER_SHARD） */
  hits: number;
  /** 最近一次命中时间（ISO）；从未命中则缺省 */
  lastHitAt?: string;
  /** active 且长期无命中 → 建议废除（软提示，不改状态、不删） */
  stale: boolean;
}

/** 读一条规则的最近命中时刻（无记录 → undefined） */
export async function lastHitAtOf(ruleId: string): Promise<string | undefined> {
  const hits = await readRuleLog<HitEntry>('hits', ruleId);
  return hits.length > 0 ? hits[hits.length - 1].at : undefined;
}

/** 汇总一条规则的活动度（面板列表用；纯读，不改行为） */
export async function ruleActivityOf(rule: RuleRecord, now: Date = new Date()): Promise<RuleActivity> {
  const hits = await readRuleLog<HitEntry>('hits', rule.id);
  const lastHitAt = hits.length > 0 ? hits[hits.length - 1].at : undefined;
  return {
    hits: hits.length,
    ...(lastHitAt ? { lastHitAt } : {}),
    stale: rule.status === 'active' && isRuleStale(rule.createdAt, lastHitAt, now),
  };
}

export interface ForgottenDraft {
  id: string;
  name: string;
}

/**
 * 惰性遗忘：清除超过 DRAFT_FORGET_DAYS 未被确认、也未再命中的 draft。
 * **只删 draft**——active / paused 一律不在此范围（active 只产软提示，见 ruleActivityOf.stale）。
 * 返回被清除的 draft 清单（供调用方记录；无则 []）。
 */
export async function sweepForgottenDrafts(now: Date = new Date()): Promise<ForgottenDraft[]> {
  const drafts = (await listRules()).filter((r) => r.status === 'draft');
  const forgotten: ForgottenDraft[] = [];
  for (const r of drafts) {
    const lastHitAt = await lastHitAtOf(r.id);
    if (!isDraftExpired(r.createdAt, lastHitAt, now)) continue;
    if (await deleteRule(r.id)) forgotten.push({ id: r.id, name: r.name });
  }
  return forgotten;
}
