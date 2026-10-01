/**
 * lib/butler/rule-decision.ts —— 规则裁决**纯函数**（v6 §9.3 ②③）
 *
 * 为什么纯：§9.3 要求裁决「可复现、可解释、可追责」。把候选生成与查表做成**无 I/O 纯函数**，
 * 宿主只负责喂数据与落日志，裁决本身可被单测穷举。
 *
 * 三段式（§9.3）：
 *   ① 场景判定      —— 宿主侧 detectSceneHints（不在本模块）
 *   ② 候选生成      —— generateCandidates（硬 / 软 / 定时三通道，只产候选不产决策）
 *   ③ 宿主侧裁决    —— decide（确定性查表：execute / ask / silent / need_user）
 *
 * 零 Node 依赖：只依赖 rules-shared（纯类型）与 preferences-shared 的 similarity（纯函数）。
 */
import { similarity } from '@/lib/core/preferences-shared';
import type { RuleRecord } from './rules-shared';

/** 候选通道：硬（关键词原样命中）/ 软（近似）/ 定时（Phase 2 接入 recurrence） */
export type CandidateChannel = 'hard' | 'soft' | 'timer';

/** 一条候选（只描述「可能该跑这条规则」，不含优先级判断） */
export interface RuleCandidate {
  ruleId: string;
  /** 硬 / 定时 = 1.0；软 < 1.0（永不直接执行） */
  confidence: number;
  channel: CandidateChannel;
}

/** 软通道相似度门限（v6 §3.4 / D9）：阈值应**放宽**，不是收紧——限流已把「多问」封顶成常数，
 * 而「漏问」的代价是永久静默；有上限兜底时宁可多产候选。0.4 为初值，待实测调整（§12.3 L10） */
export const SOFT_SIMILARITY_THRESHOLD = 0.4;

/** 冲突消解历史记录（与 `.logs/conflict-resolution` 条目同构；key 为有序对 `a__b`） */
export interface ConflictResolution {
  /** 有序对键：两条规则 id 升序连接 `a__b` */
  key: string;
  /** 输入特征（触发文本 / 场景），用于说明「为何在比较」 */
  inputFeature: string;
  /** 用户选定：规则 id */
  chosen: string;
  /** 两条规则当时的版本 */
  versions: [number, number];
  /** 记录时刻（ISO；用于取「最近一条」） */
  at?: string;
}

/** ③ 裁决输出（确定性、可枚举） */
export type Decision =
  | { kind: 'execute'; ruleId: string; version: number }
  | { kind: 'ask'; ruleId: string }
  | { kind: 'silent' }
  | { kind: 'need_user'; options: string[]; conflictKey: string };

/** 候选生成入参 */
export interface GenerateCandidatesInput {
  /** 本轮用户话 */
  text: string;
  /** 调用方已过滤 status==='active' 的规则 */
  rules: RuleRecord[];
  /** 当前时刻（Phase 2 定时匹配用；Phase 1 未用） */
  now: Date;
  /** 定时候选规则 id（Phase 2 接入 recurrence；Phase 1 传空数组） */
  timerHits?: string[];
}

/** 裁决入参 */
export interface DecideInput {
  candidates: RuleCandidate[];
  /** 与 generateCandidates 同一批规则（用于取 priority / scope / version） */
  rules: RuleRecord[];
  /** 该候选对上的历史裁决（取最近一条） */
  resolutions: ConflictResolution[];
  /** 当前活动项目 id（用于 project 作用域具体度判定） */
  activeProjectId?: string;
}

/** 软通道：由相似度映射到 0.5~0.9 的置信度（永不达 1.0，故永不直接执行） */
function softConfidence(sim: number): number {
  const c = 0.5 + (sim - SOFT_SIMILARITY_THRESHOLD) * 0.8;
  return Math.min(0.9, Math.max(0.5, c));
}

/**
 * ② 候选生成层。
 *   - 硬通道：`trigger.keywords` 任一在 text 中**原样包含** → confidence 1.0；
 *   - 软通道：硬通道未命中，但关键词与 text 相似度 ≥ 0.5，或规则 name 出现在 text → confidence 0.5~0.9；
 *   - 定时候选：`timerHits` 命中 → confidence 1.0（Phase 1 传空）。
 * 同一条规则至多产出一个候选（定时 > 硬 > 软，短路取高者）。
 */
export function generateCandidates(input: GenerateCandidatesInput): RuleCandidate[] {
  const { text, rules, timerHits = [] } = input;
  const timerSet = new Set(timerHits);
  const candidates: RuleCandidate[] = [];

  for (const rule of rules) {
    if (timerSet.has(rule.id)) {
      candidates.push({ ruleId: rule.id, confidence: 1, channel: 'timer' });
      continue;
    }
    const keywords = (rule.trigger?.keywords ?? []).filter((k) => typeof k === 'string' && k);
    if (keywords.some((k) => text.includes(k))) {
      candidates.push({ ruleId: rule.id, confidence: 1, channel: 'hard' });
      continue;
    }
    const sim = keywords.reduce((m, k) => Math.max(m, similarity(k, text)), 0);
    if (sim >= SOFT_SIMILARITY_THRESHOLD) {
      candidates.push({ ruleId: rule.id, confidence: softConfidence(sim), channel: 'soft' });
      continue;
    }
    if (rule.name && text.includes(rule.name)) {
      candidates.push({ ruleId: rule.id, confidence: 0.9, channel: 'soft' });
    }
  }
  return candidates;
}

/** 作用域具体度：命中当前项目的 project 规则 = 2；global = 1；不适用 = 0 */
function specificity(rule: RuleRecord, activeProjectId?: string): number {
  if (rule.scope === 'project') {
    return rule.scopeTarget && activeProjectId && rule.scopeTarget === activeProjectId ? 2 : 0;
  }
  return 1;
}

/** 是否适用于当前上下文：project 规则需 scopeTarget 命中 activeProjectId，否则不适用 */
function isApplicable(rule: RuleRecord, activeProjectId?: string): boolean {
  if (rule.scope === 'project') {
    return !!rule.scopeTarget && !!activeProjectId && rule.scopeTarget === activeProjectId;
  }
  return true;
}

/** 有序对键：规则 id 升序连接 `__`（与 conflict-resolution 日志分片键同口径） */
export function conflictKeyOf(ruleIds: string[]): string {
  return [...ruleIds].sort().join('__');
}

/** 取该有序对上最近一条消解记录（无 → null） */
function findLatestResolution(
  resolutions: ConflictResolution[],
  key: string,
): ConflictResolution | null {
  let best: ConflictResolution | null = null;
  for (const r of resolutions) {
    if (r.key !== key) continue;
    if (!best || (r.at ?? '') >= (best.at ?? '')) best = r;
  }
  return best;
}

interface Ranked {
  candidate: RuleCandidate;
  rule: RuleRecord;
  specificity: number;
  priority: number;
}

/** 排序：作用域具体度降序 → priority 降序 → confidence 降序 → id 升序（保证确定性） */
function rank(a: Ranked, b: Ranked): number {
  return (
    b.specificity - a.specificity ||
    b.priority - a.priority ||
    b.candidate.confidence - a.candidate.confidence ||
    a.rule.id.localeCompare(b.rule.id)
  );
}

/**
 * ③ 宿主侧裁决层（确定性查表，v6 §9.3）：
 *   1. 无适用候选 → silent；
 *   2. 有硬 / 定时候选（confidence 1）→ 走 execute 分支；仅软候选 → ask；
 *   3. 硬候选中按 具体度 → priority 排序取首；若首名存在**同分并列**：
 *        查 resolutions 该有序对最近一条 → 有则按其选择 execute，无则 need_user（并列选项）。
 */
export function decide(input: DecideInput): Decision {
  const { candidates, rules, resolutions, activeProjectId } = input;
  const byId = new Map(rules.map((r) => [r.id, r]));

  const ranked: Ranked[] = [];
  for (const c of candidates) {
    const rule = byId.get(c.ruleId);
    if (!rule) continue;
    if (!isApplicable(rule, activeProjectId)) continue;
    ranked.push({ candidate: c, rule, specificity: specificity(rule, activeProjectId), priority: rule.priority });
  }
  if (ranked.length === 0) return { kind: 'silent' };

  const hard = ranked.filter((r) => r.candidate.channel === 'hard' || r.candidate.channel === 'timer');
  if (hard.length === 0) {
    // 仅软通道候选：只问一句，永不直接执行
    const top = [...ranked].sort(rank)[0];
    return { kind: 'ask', ruleId: top.rule.id };
  }

  const sorted = [...hard].sort(rank);
  const top = sorted[0];
  const tied = sorted.filter((r) => r.specificity === top.specificity && r.priority === top.priority);

  if (tied.length === 1) {
    return { kind: 'execute', ruleId: top.rule.id, version: top.rule.version };
  }

  // 同分并列：查历史消解
  const ids = tied.map((r) => r.rule.id);
  const key = conflictKeyOf(ids);
  const res = findLatestResolution(resolutions, key);
  if (res) {
    const chosen = tied.find((r) => r.rule.id === res.chosen);
    if (chosen) return { kind: 'execute', ruleId: chosen.rule.id, version: chosen.rule.version };
  }
  return { kind: 'need_user', options: ids, conflictKey: key };
}