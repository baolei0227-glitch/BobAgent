/**
 * Butler 公众号检索 · 离线评测（纯逻辑：无 fs、无网络、无副作用）
 *
 * 为什么需要它：这条链路（搜狗召回 → LLM 精选 3 篇 → 读正文 → 综述 → CoVe）在此之前
 * **一个指标都没有**，任何 prompt / 模型的改动都只能靠感觉判断"好像好一点了"。
 * 本模块只做一件事：把「一轮检索」和「人工标注」变成可比较的数字。
 *
 * 三条口径（三条都是刻意的，改动前先想清楚）：
 *
 *   ① **召回只能在 pool 内测**。没有"整个微信"的 oracle，所以"召回了 80%"这种话
 *      在没有 pool 的前提下是无意义的。诚实的口径只有一条：人工**确认真实存在**的文章
 *      （标签 `asserted: true`）里，有多少真的进了召回。未标 asserted 的标签只用于评价
 *      精选（precision / 误杀），不参与召回分母 —— 否则"我随手写的期望"会被算成"系统漏召"。
 *
 *   ② **误杀率（falseDropRate）是这条链路的头号危害**。精选上游是 12 篇的窄召回，
 *      判掉一篇人工认为相关的，用户可能永远看不到它 —— 所以"被判掉的候选中，有多大比例
 *      其实相关"要和 precision 同等看待，甚至更重。
 *
 *   ③ **nDCG 只在 `ranked: true` 时才有值**。落库的账本（`ChatMessage.searchTrace`）按
 *      **召回下标**排列，模型给出的相关度顺序在 `buildTrace` 时被丢掉了；只有 capture 时
 *      直接接住 `curated` 帧才有真实排序。不可算时报 null，不拿"召回序"冒充相关度序。
 *
 * 与生产链路的关系：本模块**不参与**任何线上路径，只被 scripts/eval-wechat-search.ts
 * 与单测引用。
 */
import type { WechatSearchTrace, WechatSearchTraceItem } from '@/lib/bus';
import { candidateDedupeKey } from '@/lib/butler/wechat-dedupe';

// ==================== 数据模型 ====================

/** 标签按候选的哪个字段匹配 */
export type LabelField = 'title' | 'url' | 'account';

/**
 * 一条人工标注。
 *
 * `value` 默认按**大小写不敏感子串**匹配（标题里带不带书名号、全半角都还能命中）；
 * 以 `/` 包起来则按正则（如 `/诉讼费|垫付/`）。
 */
export interface EvalLabel {
  /** 匹配字段，缺省 title */
  by?: LabelField;
  /** 子串，或 `/正则/flags` */
  value: string;
  /**
   * 相关性等级：
   *   3 = 必找（一手来源 / 权威通知 / 判决要旨）
   *   2 = 相关（切题、可引用）
   *   1 = 边缘（同域但没回答问题）
   *   0 = 无关（负例：明确不该被选中的软文 / 标题党）
   *   null = 未标注（不参与任何计算，报告里单独计数）
   */
  grade: number | null;
  /**
   * 人工确认真实存在且**应当被搜到**（用于测通道召回）。
   * 只对 grade >= 2 有意义；未标 asserted 的标签不参与召回分母（口径 ①）。
   */
  asserted?: boolean;
  note?: string;
}

/** 一个 golden 条目 = 一个真实问题 + 它的人工标注 */
export interface EvalGoldenItem {
  id: string;
  query: string;
  /** 规划出的用户意图（若有） */
  intent?: string;
  /** 规划出的检索方向（若有）—— triage 与人工复盘都要看它 */
  queries?: string[];
  labels: EvalLabel[];
  note?: string;
}

export interface EvalGoldenSet {
  version: 1;
  description?: string;
  items: EvalGoldenItem[];
}

/** 一轮检索里的一个候选（召回 + 判定） */
export interface EvalCandidate {
  /** 召回下标（= 生产链路 curated 帧的 id） */
  id: number;
  title: string;
  url: string;
  account?: string;
  snippet?: string;
  verdict: 'kept' | 'dropped' | 'pending';
  /** 入选理由（kept） */
  reason?: string;
  /**
   * 模型给出的相关度名次（kept；0 = 最相关）。
   * 来自 `WechatSearchTraceItem.rank`（2026-10-01 新增字段）—— 有它才算得出 nDCG。
   */
  rank?: number;
  summary?: string;
  keypoint?: string;
  /** 正文是否读到（kept；undefined = 该轮根本没读正文，例如纯召回 pool） */
  readOk?: boolean;
}

/** 一轮检索的完整记录（评测的输入单位） */
export interface EvalRound {
  roundId: string;
  query: string;
  /**
   * 归属到哪个 golden 条目的 query。
   *
   * 为什么需要它：建 pool 时会把同一个问题**拆成几个检索方向各抓一次**，
   * 那些 run 的 `query` 是子方向（"破产 劣后债权 清偿顺序"），而 golden 条目挂的是原句 ——
   * 不看这个字段，pool run 会因为 query 匹配不上被算成"孤儿轮次"，pool 就白建了。
   * 缺省（null/undefined）= 用 `query` 自己对齐。
   */
  itemQuery?: string | null;
  intent?: string | null;
  /** 规划出的检索方向；落库账本里没有这个字段 → null */
  planQueries?: string[] | null;
  candidates: EvalCandidate[];
  /** kept 是否按模型相关度排序（只有 capture 接住 curated 帧才为 true） */
  ranked: boolean;
  source: 'stored-trace' | 'capture-server' | 'capture-bridge';
  runAt?: number;
  meta?: Record<string, unknown>;
}

// ==================== 指标结果 ====================

/** 比值：同时带分子分母，报告里能写「2/3」而不只是「0.667」 */
export interface Ratio {
  num: number;
  den: number;
  value: number;
}

export interface RoundMetrics {
  roundId: string;
  query: string;
  source: EvalRound['source'];
  ranked: boolean;
  counts: {
    recalled: number;
    kept: number;
    dropped: number;
    pending: number;
    /** 有非 null 标注的候选数 */
    judged: number;
    /** 没被任何标签命中的候选数（既不算相关也不算误杀） */
    unjudged: number;
    /** kept 里已判定的篇数 —— precision@k 的分母（未判定的不进分母，否则"没标注"会误报 0%） */
    keptJudged: number;
    /** dropped 里已判定的篇数 —— 误杀率的分母 */
    droppedJudged: number;
    /** 召回里被判为相关（>=2）的候选数 */
    relevantRecalled: number;
    /** 召回里 grade=3 的候选数 */
    mustRecalled: number;
    /** 标注里标了 asserted 的条数 */
    asserted: number;
    /** asserted 且本轮召回到的 */
    assertedRecalled: number;
    /** asserted 且整个 pool 都没有（通道漏召 or 人工判断有误） */
    assertedOutsidePool: number;
  };
  metrics: {
    /** 通道层召回率（asserted 口径）；asserted=0 时为 null */
    channelRecall: Ratio | null;
    /** 精选层：kept 中**已判定**为相关的比例（未判定的 kept 不进分母，见 counts.keptJudged） */
    precisionAtK: Ratio | null;
    /** 精选层：召回到的 grade=3 里，有多少被 kept */
    mustKeepRecall: Ratio | null;
    /** 危害指标：被判掉的候选中，人工认为相关的比例 */
    falseDropRate: Ratio | null;
    /** 仅 ranked=true 时有值 */
    ndcgAtK: Ratio | null;
    /** kept 中正文读到率；readOk 未记录的不计入分母 */
    readOkRate: Ratio | null;
    /** 本轮召回篇数 / pool 篇数 —— **零标注也能算**，用来量化"召回窄" */
    poolCoverage: Ratio | null;
    /**
     * 相关文章召回率：本轮召回里的相关篇数 / pool 里的相关篇数。
     *
     * 与 `channelRecall` 的区别（两个都在测"召回"，但测的是不同的东西）：
     *   - `channelRecall` 的分母是**人工标了 asserted 的标签**，衡量"通道有没有搜到你点名的文章"；
     *   - 这一条的分母是**pool 里所有被判为相关的文章**，衡量"12 篇的预算把多少相关文章挡在门外"。
     * 后者才是"召回窄"真正的代价：分母里每一篇都是通道真的搜到过、却没能进精选的相关文章。
     */
    relevantPoolRecall: Ratio | null;
  };
  /** 误杀明细（报告要能直接列出"这几篇被判错了"） */
  falseDrops: Array<{ title: string; url: string; grade: number }>;
}

export interface ItemEvaluation {
  itemId: string;
  query: string;
  /** pool 去重后的候选数（= 该问题下所有 run 见过的并集） */
  poolSize: number;
  /** pool 里有几个 run */
  runCount: number;
  runs: RoundMetrics[];
  pool: {
    /** pool 中人工判为相关的候选数 */
    relevant: number;
    /** 去重**前**的候选条数（含同一篇文章的多次出现） */
    rawCandidates: number;
    assertedTotal: number;
    assertedRecalled: number;
    /** asserted 但 pool 里没有的标签（通道漏召候选） */
    assertedMissing: Array<{ value: string; grade: number | null; note?: string }>;
  };
  warnings: string[];
}

export interface EvalReport {
  generatedAt: number;
  items: ItemEvaluation[];
  /** 有 run 但对不上任何 golden 条目（query 不匹配） */
  unmatchedRounds: string[];
  warnings: string[];
}

// ==================== 标签匹配 ====================

const REGEX_FORM = /^\/(.*)\/([gimsuy]*)$/;

/** 把标签的 value 编译成匹配器；正则非法时降级为子串（不让一条写错的标注炸掉整轮评测） */
function compileMatcher(value: string): { test: (s: string) => boolean; kind: 'regex' | 'substring' } {
  const m = REGEX_FORM.exec(value.trim());
  if (m) {
    try {
      const re = new RegExp(m[1], m[2] || 'i');
      return { test: (s) => re.test(s), kind: 'regex' };
    } catch {
      /* 降级为子串 */
    }
  }
  const needle = value.trim().toLowerCase();
  return { test: (s) => s.toLowerCase().includes(needle), kind: 'substring' };
}

/** 标签是否命中该候选 */
export function matchLabel(label: EvalLabel, cand: EvalCandidate): boolean {
  const field = label.by ?? 'title';
  const raw = field === 'url' ? cand.url : field === 'account' ? (cand.account ?? '') : cand.title;
  if (!raw) return false;
  return compileMatcher(label.value).test(raw);
}

/** 等级收敛到 0..3 的整数；非法 / 未填 → null（未标注） */
export function normalizeGrade(grade: number | null | undefined): number | null {
  if (grade === null || grade === undefined) return null;
  if (!Number.isFinite(grade)) return null;
  return Math.max(0, Math.min(3, Math.round(grade)));
}

export interface CandidateGrade {
  grade: number | null;
  /** 命中的全部标签（含 grade=null 的），用于报告里解释「为什么给这个等级」 */
  matched: EvalLabel[];
}

/** 候选的人工等级 = 命中标签里**最高**的那个（同一篇可能既被「破产」又被「诉讼费」命中） */
export function gradeCandidate(cand: EvalCandidate, labels: EvalLabel[]): CandidateGrade {
  const matched = labels.filter((l) => matchLabel(l, cand));
  let grade: number | null = null;
  for (const l of matched) {
    const g = normalizeGrade(l.grade);
    if (g === null) continue;
    grade = grade === null ? g : Math.max(grade, g);
  }
  return { grade, matched };
}

// ==================== 从生产数据结构转换 ====================

/**
 * 落库账本（WechatSearchTrace）→ 评测用的一轮。
 *
 * `ranked` 由**账本里有没有 rank** 推断（2026-10-01 起账本会写）：
 *   - 有 → 这一轮的 kept 是模型按相关度排过序的，nDCG 可算；
 *   - 没有 → 两种可能：① 字段引入之前的历史轮次；② 本轮走的是兜底（模型不可用，
 *     取召回前 3 篇，"顺序"其实是召回顺序）。两种都不该算 nDCG —— 宁可不报，不报假的。
 */
export function roundFromTrace(roundId: string, trace: WechatSearchTrace, runAt?: number): EvalRound {
  const candidates: EvalCandidate[] = trace.items.map((it: WechatSearchTraceItem) => {
    const c: EvalCandidate = { id: it.id, title: it.title, url: it.url, verdict: it.verdict };
    if (it.account) c.account = it.account;
    if (it.snippet) c.snippet = it.snippet;
    if (it.reason) c.reason = it.reason;
    if (typeof it.rank === 'number') c.rank = it.rank;
    if (it.summary) c.summary = it.summary;
    if (it.keypoint) c.keypoint = it.keypoint;
    if (typeof it.readOk === 'boolean') c.readOk = it.readOk;
    return c;
  });
  const kept = candidates.filter((c) => c.verdict === 'kept');
  const ranked = kept.length > 0 && kept.every((c) => typeof c.rank === 'number');
  return {
    roundId,
    query: trace.query,
    // 检索方向与意图：2026-10-01 起账本会带（更早的轮次没有 → null）。
    // 有了它，"召回为什么差"才能归因到"规划器方向不好"还是"搜狗排序不好"。
    intent: trace.intent ?? null,
    planQueries: trace.queries ?? null,
    candidates,
    ranked,
    source: 'stored-trace',
    ...(runAt !== undefined ? { runAt } : {}),
  };
}

/**
 * 候选去重键 —— **直接委托给生产链路同一份实现**（`lib/butler/wechat-dedupe.ts`）。
 *
 * 为什么不留一份本地实现：口径一旦分叉，就会出现"评测说去重好了、线上还是重复"。
 * 那边有完整的原因说明（搜狗 `/link?url=` 是加密跳转链，同一篇每次 token 都不同）。
 */
export function candidateKey(c: EvalCandidate): string {
  return candidateDedupeKey(c);
}

/** 多轮候选合并成 pool（去重；保留先出现的判定） */
export function poolCandidates(rounds: EvalRound[]): EvalCandidate[] {
  const seen = new Set<string>();
  const out: EvalCandidate[] = [];
  for (const r of rounds) {
    for (const c of r.candidates) {
      const k = candidateKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

// ==================== 指标 ====================

function ratio(num: number, den: number): Ratio | null {
  if (den <= 0) return null;
  return { num, den, value: num / den };
}

/** 增益：2^grade - 1（等级越高，靠前位置的收益越大） */
function gain(grade: number): number {
  return Math.pow(2, grade) - 1;
}

function dcg(gains: number[]): number {
  return gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
}

/**
 * nDCG@k。理想序列取自**人工标注的 pool**，而不是「本轮 kept 自己」—— 否则永远 1.0，等于没测。
 *
 * ⚠ `idealGrades` **必须在这里降序**，不能指望调用方排好（2026-10-01 修）：
 *   `scoreRound` 传进来的是 pool 的**原始顺序**（召回序），不排就会把 IDCG 算小，
 *   于是 nDCG 虚高甚至 **> 1**（实测出现过 144.9%）。现在的实现自己兜住这一点，
 *   并保证返回值 ≤ 1。
 */
export function ndcgAtK(orderedGrades: number[], idealGrades: number[], k: number): Ratio | null {
  const ideal = [...idealGrades].sort((a, b) => b - a);
  const g = dcg(orderedGrades.slice(0, k).map(gain));
  const id = dcg(ideal.slice(0, k).map(gain));
  if (id <= 0) return null;
  return { num: g, den: id, value: g / id };
}

/**
 * 给一轮检索打分。
 *
 * @param round 待评的一轮
 * @param item  它对应的 golden 条目（提供人工标注）
 * @param pool  同一问题的**全部** run 的候选并集（口径 ①：召回只能在 pool 内测）
 */
export function scoreRound(round: EvalRound, item: EvalGoldenItem, pool: EvalCandidate[]): RoundMetrics {
  const labels = item.labels;
  const graded = labels.filter((l) => normalizeGrade(l.grade) !== null);

  // ---- 候选侧 ----
  let judged = 0;
  let unjudged = 0;
  let relevantRecalled = 0;
  let mustRecalled = 0;
  let keptRelevant = 0;
  let mustKept = 0;
  let readOkNum = 0;
  let readOkDen = 0;
  let keptJudged = 0;
  let droppedJudged = 0;
  const falseDrops: RoundMetrics['falseDrops'] = [];
  const keptGrades: number[] = [];
  /** 带模型名次的 kept（rank → grade）：nDCG 必须按它排，不能按落库的召回序（口径 ③） */
  const keptRankedGrades: Array<{ rank: number; grade: number }> = [];
  let keptWithRank = 0;

  for (const c of round.candidates) {
    const { grade } = gradeCandidate(c, labels);
    if (grade === null) unjudged += 1;
    else judged += 1;
    if (grade !== null && grade >= 2) relevantRecalled += 1;
    if (grade === 3) mustRecalled += 1;
    if (c.verdict === 'kept') {
      if (typeof c.rank === 'number') keptWithRank += 1;
      if (grade !== null) {
        keptGrades.push(grade);
        keptJudged += 1;
        if (typeof c.rank === 'number') keptRankedGrades.push({ rank: c.rank, grade });
      }
      if (grade !== null && grade >= 2) keptRelevant += 1;
      if (grade === 3) mustKept += 1;
      if (typeof c.readOk === 'boolean') {
        readOkDen += 1;
        if (c.readOk) readOkNum += 1;
      }
    } else if (c.verdict === 'dropped') {
      if (grade !== null) droppedJudged += 1;
      if (grade !== null && grade >= 2) {
        falseDrops.push({ title: c.title, url: c.url, grade });
      }
    }
  }

  // ---- 标注侧（asserted / pool 覆盖）----
  const assertedLabels = graded.filter((l) => l.asserted && (normalizeGrade(l.grade) ?? -1) >= 2);
  const assertedRecalled = assertedLabels.filter((l) => pool.some((c) => matchLabel(l, c))).length;

  const poolGrades = pool
    .map((c) => gradeCandidate(c, labels).grade)
    .filter((g): g is number => g !== null);

  const counts = {
    recalled: round.candidates.length,
    kept: round.candidates.filter((c) => c.verdict === 'kept').length,
    dropped: round.candidates.filter((c) => c.verdict === 'dropped').length,
    pending: round.candidates.filter((c) => c.verdict === 'pending').length,
    judged,
    unjudged,
    /** kept 里已判定的篇数 —— precision@k 的分母（未判定的不进分母，否则没标注会误报 0%） */
    keptJudged,
    /** dropped 里已判定的篇数 —— 误杀率的分母 */
    droppedJudged,
    relevantRecalled,
    mustRecalled,
    asserted: assertedLabels.length,
    assertedRecalled,
    assertedOutsidePool: assertedLabels.length - assertedRecalled,
  };

  const keptCount = counts.kept;
  // nDCG 的输入必须是**模型的相关度序**：
  //   - 每个 kept 都带 rank → 按 rank 升序（这才是模型的排序）；
  //   - 否则（历史轮次 / 兜底路径 / 只标了部分）→ 不报，绝不用落库的召回序冒充（口径 ③）。
  const allKeptRanked = keptCount > 0 && keptWithRank === keptCount;
  const orderedKeptGrades = [...keptRankedGrades].sort((a, b) => a.rank - b.rank).map((x) => x.grade);
  const canNdcg = round.ranked && allKeptRanked;

  const metrics = {
    channelRecall: ratio(assertedRecalled, assertedLabels.length),
    precisionAtK: ratio(keptRelevant, keptJudged),
    mustKeepRecall: ratio(mustKept, mustRecalled),
    falseDropRate: ratio(falseDrops.length, droppedJudged),
    ndcgAtK: canNdcg ? ndcgAtK(orderedKeptGrades, poolGrades, Math.max(keptCount, 1)) : null,
    readOkRate: ratio(readOkNum, readOkDen),
    // pool 覆盖：本轮 12 篇的预算吃下了 pool 的多少。**零标注也能算** ——
    // 它直接量化"召回窄"：1/3 就说明通道见过的文章里有 2/3 连进精选的资格都没有。
    poolCoverage: ratio(round.candidates.length, pool.length),
    // 相关文章召回率：分母是 pool 里所有相关文章（通道搜到过、但可能没进 12 篇预算的那些）
    relevantPoolRecall: ratio(relevantRecalled, poolGrades.filter((g) => g >= 2).length),
  };

  return {
    roundId: round.roundId,
    query: round.query,
    source: round.source,
    ranked: round.ranked,
    counts,
    metrics,
    falseDrops,
  };
}

// ==================== 查询匹配 / 报告 ====================

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 把一轮检索对到 golden 条目：优先用 `itemQuery`（pool run 的归属），
 * 否则用 `query` 自己 —— 先精确（归一化后），再双向包含（短串至少 6 字，避免误配）。
 */
export function findItemForRound(round: EvalRound, items: EvalGoldenItem[]): EvalGoldenItem | null {
  const q = normalizeQuery(round.itemQuery || round.query);
  if (!q) return null;
  const exact = items.find((it) => normalizeQuery(it.query) === q);
  if (exact) return exact;
  return (
    items.find((it) => {
      const iq = normalizeQuery(it.query);
      if (iq.length >= 6 && q.includes(iq)) return true;
      if (q.length >= 6 && iq.includes(q)) return true;
      return false;
    }) ?? null
  );
}

/** 全部打分：按 golden 条目归并 rounds，pool 跨 run 合并（口径 ①） */
export function evaluate(rounds: EvalRound[], golden: EvalGoldenSet): EvalReport {
  const byItem = new Map<string, EvalRound[]>();
  const unmatchedRounds: string[] = [];

  for (const r of rounds) {
    const item = findItemForRound(r, golden.items);
    if (!item) {
      unmatchedRounds.push(r.roundId);
      continue;
    }
    const list = byItem.get(item.id) ?? [];
    list.push(r);
    byItem.set(item.id, list);
  }

  const items: ItemEvaluation[] = [];
  for (const item of golden.items) {
    const rs = byItem.get(item.id) ?? [];
    const pool = poolCandidates(rs);
    const warnings: string[] = [];

    const gradedLabels = item.labels.filter((l) => normalizeGrade(l.grade) !== null);
    if (gradedLabels.length === 0) warnings.push('该条目还没有任何非空 grade：所有指标都会是 N/A');
    if (!gradedLabels.some((l) => l.asserted && (normalizeGrade(l.grade) ?? -1) >= 2)) {
      warnings.push('没有 asserted 标签：通道召回率无法计算（口径 ①）');
    }
    if (rs.length <= 1) {
      warnings.push('pool 只有 1 个 run：此时"召回率"等于通道对本文的覆盖，不能代表真实召回能力');
    }
    if (rs.length > 0 && rs.every((r) => !r.ranked)) {
      warnings.push('该轮记录没有模型排序（落库账本按召回序）：nDCG 不可算（口径 ③）');
    }
    const unclaimed = gradedLabels.filter(
      (l) => !l.asserted && !pool.some((c) => matchLabel(l, c)),
    );
    if (unclaimed.length > 0) {
      warnings.push(
        `有 ${unclaimed.length} 条已标注标签既不在 pool 里、也没标 asserted：它们不进任何分母（要测漏召请标 asserted）`,
      );
    }

    const assertedLabels = gradedLabels.filter((l) => l.asserted && (normalizeGrade(l.grade) ?? -1) >= 2);
    const assertedMissing = assertedLabels
      .filter((l) => !pool.some((c) => matchLabel(l, c)))
      .map((l) => {
        const out: { value: string; grade: number | null; note?: string } = {
          value: l.value,
          grade: normalizeGrade(l.grade),
        };
        if (l.note) out.note = l.note;
        return out;
      });

    items.push({
      itemId: item.id,
      query: item.query,
      poolSize: pool.length,
      runCount: rs.length,
      runs: rs.map((r) => scoreRound(r, item, pool)),
      pool: {
        relevant: pool.filter((c) => {
          const g = gradeCandidate(c, item.labels).grade;
          return g !== null && g >= 2;
        }).length,
        rawCandidates: rs.reduce((sum, r) => sum + r.candidates.length, 0),
        assertedTotal: assertedLabels.length,
        assertedRecalled: assertedLabels.length - assertedMissing.length,
        assertedMissing,
      },
      warnings,
    });
  }

  const warnings: string[] = [];
  if (unmatchedRounds.length > 0) {
    warnings.push(
      `${unmatchedRounds.length} 个 run 没对上任何 golden 条目（query 不匹配）：${unmatchedRounds.join(', ')}`,
    );
  }

  return { generatedAt: Date.now(), items, unmatchedRounds, warnings };
}

// ==================== 人工标注辅助（triage） ====================

/** 字符 bigram 集合：中文不分词也能做粗略的"同域"判断（纯启发式，不当结论用） */
export function charBigrams(text: string): Set<string> {
  const norm = text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ').trim();
  const out = new Set<string>();
  for (const token of norm.split(' ')) {
    if (!token) continue;
    if (token.length === 1) {
      out.add(token);
      continue;
    }
    for (let i = 0; i < token.length - 1; i += 1) out.add(token.slice(i, i + 2));
  }
  return out;
}

/** Jaccard 相似度；任一为空 → 0 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 挑出「可疑被误杀」的候选：把每个 dropped 的标题+摘要与（原句 + 各检索方向）做
 * 字符 bigram 相似度，从高到低排。
 *
 * 它是**给人看的复查队列**，不是判定：分数高只说明"字面同域"，
 * 而精选判掉它的理由可能是内容层面的（软文 / 只讲别的侧面），那正是人要去读的。
 */
export function triageDropped(
  round: EvalRound,
  extraQueries: string[] = [],
): Array<{ candidate: EvalCandidate; score: number }> {
  const q = charBigrams([round.query, ...(round.planQueries ?? []), ...extraQueries].join(' '));
  return round.candidates
    .filter((c) => c.verdict === 'dropped')
    .map((c) => ({ candidate: c, score: jaccard(charBigrams(`${c.title} ${c.snippet ?? ''}`), q) }))
    .sort((a, b) => b.score - a.score);
}

// ==================== 报告渲染 ====================

function fmtRatio(r: Ratio | null): string {
  if (!r) return 'N/A';
  return `${(r.value * 100).toFixed(1)}%（${r.num}/${r.den}）`;
}

/** 渲染成 markdown（可直接贴进工单 / 交给模型继续分析） */
export function renderReport(report: EvalReport, title = 'Butler 公众号检索 · 评测报告'): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`生成时间：${new Date(report.generatedAt).toISOString()}`);
  lines.push('');
  if (report.warnings.length > 0) {
    lines.push('## 口径警告');
    lines.push('');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  for (const it of report.items) {
    lines.push(`## ${it.itemId}`);
    lines.push('');
    lines.push(`- 检索词：${it.query}`);
    lines.push(`- pool：${it.poolSize} 篇唯一 / ${it.pool.rawCandidates} 条候选 / ${it.runCount} 个 run`);
    lines.push(`- pool 内相关（grade≥2）：${it.pool.relevant} 篇`);
    lines.push(
      `- asserted（人工确认真实存在）：${it.pool.assertedRecalled}/${it.pool.assertedTotal}`,
    );
    if (it.pool.assertedMissing.length > 0) {
      lines.push('');
      lines.push('**asserted 但整个 pool 都没有（通道漏召候选）：**');
      lines.push('');
      for (const m of it.pool.assertedMissing) lines.push(`- [grade ${m.grade ?? '?'}] ${m.value}${m.note ? ` — ${m.note}` : ''}`);
    }
    for (const w of it.warnings) lines.push(`- ⚠ ${w}`);
    lines.push('');

    if (it.runs.length === 0) {
      lines.push('_该条目还没有 run_');
      lines.push('');
      continue;
    }

    lines.push('| run | 来源 | 召回 | 留下 | 判掉 | pool 覆盖 | 相关召回 | 判定覆盖 | 通道召回 | precision@k | 必找保持 | 误杀率 | nDCG | 正文读到 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of it.runs) {
      lines.push(
        [
          `| ${r.roundId}`,
          r.source,
          String(r.counts.recalled),
          String(r.counts.kept),
          String(r.counts.dropped),
          // pool 覆盖：零标注也能算，"召回窄"到底窄到什么程度一眼可见
          fmtRatio(r.metrics.poolCoverage),
          // 相关召回：pool 里的相关文章有多少进了本轮（这才是召回窄的真正代价）
          fmtRatio(r.metrics.relevantPoolRecall),
          // 判定覆盖：没标注时这里一眼看出全部 N/A 是"没数据"而不是"表现差"
          `留 ${r.counts.keptJudged}/${r.counts.kept} · 判 ${r.counts.droppedJudged}/${r.counts.dropped}`,
          fmtRatio(r.metrics.channelRecall),
          fmtRatio(r.metrics.precisionAtK),
          fmtRatio(r.metrics.mustKeepRecall),
          fmtRatio(r.metrics.falseDropRate),
          fmtRatio(r.metrics.ndcgAtK),
          `${fmtRatio(r.metrics.readOkRate)} |`,
        ].join(' | '),
      );
    }
    lines.push('');

    const withDrops = it.runs.filter((r) => r.falseDrops.length > 0);
    if (withDrops.length > 0) {
      lines.push('**被判掉但人工认为相关（误杀明细，按 run）：**');
      lines.push('');
      for (const r of withDrops) {
        for (const d of r.falseDrops) lines.push(`- [${r.roundId}] grade ${d.grade} · ${d.title}`);
      }
      lines.push('');
    }
  }

  lines.push('## 指标口径');
  lines.push('');
  lines.push('- **通道召回**：asserted 标签中，真的进了召回的占比（分母只含人工确认真实存在的）');
  lines.push('- **precision@k**：kept 中**已判定**为 grade≥2 的占比（未判定的 kept 不进分母）');
  lines.push('- **必找保持**：召回到的 grade=3 里被 kept 的占比（召回没拿到的篇目不进分母）');
  lines.push('- **误杀率**：dropped 中 grade≥2 的占比 —— 这条链路最该盯的数字');
  lines.push('- **pool 覆盖**：本轮召回篇数 / pool 篇数（零标注也能算，用来量化"召回窄"）');
  lines.push('- **相关召回**：本轮召回里的相关篇数 / pool 里的相关篇数 —— 12 篇预算把多少相关文章挡在门外');
  lines.push('- **nDCG**：只在有模型排序（ranked）时计算，理想序取自人工标注的 pool');
  lines.push('');
  return lines.join('\n');
}
