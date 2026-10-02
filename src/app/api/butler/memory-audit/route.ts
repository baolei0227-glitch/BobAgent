/**
 * /api/butler/memory-audit —— Memory 台「证据视图」的**只读聚合**端点
 *
 * 背景（《Butler-Memory设计_20261002.md》§4 / M3）：记忆台的 Evidence 段要回答
 * 「Butler 凭什么这么记、这么学」——这些数据此前**分散在四类落点且没有任何读口**：
 *   - 被拉黑模式（负样本）      `butler/.rules/.logs/negative-sample/<objectType>.jsonl`
 *   - near-miss 询问额度        `butler/.state/rule-nearmiss.json`
 *   - 每会话主动冒头预算        `butler/.state/rule-budget/<threadId>.json`
 *   - 规则产出引用（去了哪）    `butler/.rules/.logs/hits/<ruleId>.jsonl` 的 `producedRef`
 * 外加「最近记忆活动」时间线（记忆 / 规则 / 技能的新建时间）与**真源绝对路径**（供用户自行备份）。
 *
 * 纪律：
 *   - **只读**，不写任何文件、不新增存储、不新增真源（不变量 2）；
 *   - 纯聚合，不改动任何既有端点或行为；负样本的**解封**仍走既有
 *     `DELETE /api/butler/rules/negative-samples`（本端点只负责看）。
 *   - 各段独立容错：某一类读失败只让该段为空，不让整个视图 500（脏数据不阻断）。
 */
import { NextResponse } from 'next/server';
import { butlerRoot, STATE_DIR } from '@/lib/butler/storage';
import { listRules } from '@/lib/butler/rules';
import { listSkills } from '@/lib/butler/skills';
import { listRuleLogKeys, readRuleLog, type HitEntry } from '@/lib/butler/rule-logs';
import {
  listBlockedPatterns,
  listNegativeSamples,
  normalizeNegativeClass,
  NEGATIVE_OBJECT_TYPES,
  type NegativeSampleClass,
} from '@/lib/butler/rule-signals';
import { readAskCounts } from '@/lib/butler/rule-nearmiss';
import { listRuleBudgets, RULE_ASK_BUDGET } from '@/lib/butler/rule-exec';
import { NEAR_MISS_ASK_LIMIT } from '@/lib/butler/rules-shared';
import { listPreferences } from '@/lib/core/preferences';
import { join } from 'path';

/** 最近活动时间线取多少条（记忆 / 规则 / 技能合并后倒序截断） */
const RECENT_MAX = 12;

/** 带分片键与「类」的负样本条目（与 negative-samples 路由同一形状，便于前端复用渲染） */
type TaggedNegative = {
  at: string;
  pattern?: string;
  action?: string;
  objectType: string;
  class: NegativeSampleClass;
};

/** 一条「最近发生的记忆活动」 */
interface RecentActivity {
  kind: 'memory' | 'rule' | 'skill';
  title: string;
  at: string;
}

export async function GET() {
  try {
    const [rules, skills, prefs, askCounts, budgets] = await Promise.all([
      listRules().catch(() => []),
      listSkills().catch(() => []),
      listPreferences().catch(() => []),
      readAskCounts().catch(() => ({}) as Record<string, number>),
      listRuleBudgets().catch(() => [] as { threadId: string; asks: number }[]),
    ]);

    // ① 负样本（两类分开）：只读，解封走既有端点
    const blocked: TaggedNegative[] = [];
    const samples: TaggedNegative[] = [];
    for (const objectType of NEGATIVE_OBJECT_TYPES) {
      const [s, b] = await Promise.all([
        listNegativeSamples(objectType).catch(() => []),
        listBlockedPatterns(objectType).catch(() => []),
      ]);
      for (const e of s) samples.push({ at: e.at, pattern: e.pattern, action: e.action, objectType, class: normalizeNegativeClass(e) });
      for (const e of b) blocked.push({ at: e.at, pattern: e.pattern, action: e.action, objectType, class: normalizeNegativeClass(e) });
    }
    const byAt = (a: TaggedNegative, b: TaggedNegative) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    blocked.sort(byAt);
    samples.sort(byAt);
    const grouped = {
      signal_mismatch: blocked.filter((e) => e.class === 'signal_mismatch'),
      not_a_habit: blocked.filter((e) => e.class === 'not_a_habit'),
    };

    // ② near-miss 询问额度（每个对象类型）：used >= limit 即不再问
    const askQuota = Object.entries(askCounts)
      .map(([objectType, used]) => ({ objectType, used, limit: NEAR_MISS_ASK_LIMIT }))
      .sort((a, b) => b.used - a.used);

    // ③ 每会话主动冒头预算
    const budget = budgets.map((b) => ({ ...b, limit: RULE_ASK_BUDGET }));

    // ④ 规则产出引用：每条规则最近一次带 producedRef 的命中（「它到底做了什么」）
    const productions: { ruleId: string; ruleName: string; producedRef: string; at: string }[] = [];
    try {
      const hitKeys = new Set(await listRuleLogKeys('hits'));
      for (const rule of rules) {
        if (!hitKeys.has(rule.id)) continue;
        const hits = await readRuleLog<HitEntry>('hits', rule.id);
        for (let i = hits.length - 1; i >= 0; i--) {
          const ref = hits[i]?.producedRef;
          if (typeof ref === 'string' && ref) {
            productions.push({ ruleId: rule.id, ruleName: rule.name, producedRef: ref, at: hits[i].at });
            break;
          }
        }
      }
      productions.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    } catch { /* 产出段读失败 → 空数组，不影响其它段 */ }

    // ⑤ 最近活动时间线：三类实体按创建时间合并倒序（记忆只有 created_at 字符串，统一按字符串比较）
    const recent: RecentActivity[] = [
      ...prefs
        .filter((p) => p.createdAt)
        .map((p): RecentActivity => ({ kind: 'memory', title: p.content, at: p.createdAt })),
      ...rules
        .filter((r) => r.createdAt)
        .map((r): RecentActivity => ({ kind: 'rule', title: r.name, at: r.createdAt })),
      ...skills
        .filter((s) => s.createdAt)
        .map((s): RecentActivity => ({ kind: 'skill', title: s.name, at: s.createdAt })),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, RECENT_MAX);

    // ⑥ 真源绝对路径（给用户自行备份用；不是新存储，只是把既有落点说出来）
    const root = butlerRoot();
    const paths = {
      root,
      preferences: join(root, 'preferences.md'),
      rules: join(root, '.rules'),
      ruleLogs: join(root, '.rules', '.logs'),
      skills: join(root, '.skills'),
      threads: join(root, '.state', 'threads'),
      state: STATE_DIR,
    };

    return NextResponse.json({
      success: true,
      paths,
      recent,
      negative: { blocked, samples, grouped, classes: ['signal_mismatch', 'not_a_habit'] as NegativeSampleClass[] },
      askQuota,
      budget,
      productions,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/memory-audit] 聚合失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
