/**
 * /api/butler/rules/signals —— 规则信号详情（「我的定制」总览页 Signals 段）
 *
 * 依据：Butler Phase 1 计划 §3.9 / D10。**纯增量子路径**——既有 /api/butler/rules
 * 的 GET/POST/PATCH/DELETE 契约被集成测试锁定，改签名会破契约，故新增此子路由承载
 * 「信号查询 / 修订评估」，不动既有签名。
 *
 *   GET ?id=r-…&version=n → 单规则的信号详情：
 *       hits            命中时间线（{at, scene, rule_version, producedRef?}）
 *       outputEdited    产出被改动（{at, rule_version, diff, stepFieldMap}）
 *       ruleViolated    规则被违反（Phase 1 无写点，返回空数组，见计划 D4）
 *       userDismissed   用户否定（{at, rule_version, source}）
 *       conflicts       与该规则相关的冲突消解记录（分片键为两规则 id 的有序对）
 *       revision        修订评估（{active, ratio, shouldPropose}，active=false 表示样本不足未启用）
 *   GET（无 id）           → { revisions: { [ruleId]: 修订评估 } }，供 Rules 列表的「修订建议」标记
 *                            一次性取全量，避免列表逐规则 N 次请求。
 *
 * `version` 传入时启用「窗口清零」语义（rule_revise 使 version++ 后，旧版本命中不计入修订判据）。
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  readRuleLog,
  listRuleLogKeys,
  type HitEntry,
  type OutputEditedEntry,
  type RuleViolatedEntry,
  type UserDismissedEntry,
  type ConflictResolutionEntry,
} from '@/lib/butler/rule-logs';
import { evaluateRuleRevision } from '@/lib/butler/rule-signals';
import { listRules } from '@/lib/butler/rules';
import { ruleActivityOf, type RuleActivity } from '@/lib/butler/rule-forget';

/** 每类信号返回的最近条数上限（页面是「最近发生了什么」的视图，不需要全量） */
const DETAIL_LIMIT = 50;

/** 修订评估结果（与 rules-shared.evaluateRevision 同形） */
interface Revision {
  active: boolean;
  ratio: number;
  shouldPropose: boolean;
}

/**
 * 读取与某规则相关的冲突消解记录。
 * 分片键是两条规则 id 的有序对（`a__b`，见 rule-signals.recordConflictResolution）；
 * 规则 id 形如 `r-<date>-<hex>`，不含 `__`，故按 `__` 切分即可精确归属。
 */
async function readConflicts(ruleId: string): Promise<Array<ConflictResolutionEntry & { key: string }>> {
  const keys = await listRuleLogKeys('conflict-resolution');
  const mine = keys.filter((k) => k.split('__').includes(ruleId));
  const out: Array<ConflictResolutionEntry & { key: string }> = [];
  for (const k of mine) {
    const entries = await readRuleLog<ConflictResolutionEntry>('conflict-resolution', k, DETAIL_LIMIT);
    for (const e of entries) out.push({ ...e, key: k });
  }
  // 最近的排前面（列表读起来更顺）
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out;
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  try {
    // 无 id：批量修订评估（Rules 列表的「修订建议」标记）
    if (!id) {
      const rules = await listRules();
      const pairs = await Promise.all(
        rules.map(async (r) => [r.id, await evaluateRuleRevision(r.id, r.version)] as const),
      );
      const revisions: Record<string, Revision> = {};
      for (const [rid, rev] of pairs) revisions[rid] = rev;
      // 活动度（命中次数 / 最近命中 / 是否陈旧）：draft 的「已印证」与 active 的「建议废除」都由此派生
      const activityPairs = await Promise.all(
        rules.map(async (r) => [r.id, await ruleActivityOf(r)] as const),
      );
      const activity: Record<string, RuleActivity> = {};
      for (const [rid, a] of activityPairs) activity[rid] = a;
      return NextResponse.json({ success: true, revisions, activity });
    }

    // 有 id：该规则的信号详情
    const versionRaw = request.nextUrl.searchParams.get('version');
    const parsed = versionRaw === null ? NaN : Number(versionRaw);
    const currentVersion = Number.isFinite(parsed) ? parsed : undefined;
    const [hits, outputEdited, ruleViolated, userDismissed, conflicts, revision] = await Promise.all([
      readRuleLog<HitEntry>('hits', id, DETAIL_LIMIT),
      readRuleLog<OutputEditedEntry>('output_edited', id, DETAIL_LIMIT),
      readRuleLog<RuleViolatedEntry>('rule_violated', id, DETAIL_LIMIT),
      readRuleLog<UserDismissedEntry>('user_dismissed', id, DETAIL_LIMIT),
      readConflicts(id),
      evaluateRuleRevision(id, currentVersion),
    ]);
    return NextResponse.json({
      success: true,
      id,
      hits,
      outputEdited,
      ruleViolated,
      userDismissed,
      conflicts,
      revision,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/rules/signals] 拉取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}