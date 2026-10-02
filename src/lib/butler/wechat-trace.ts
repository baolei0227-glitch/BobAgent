/**
 * 检索实况账本（`ChatMessage.searchTrace`）的组装 —— 纯逻辑，无 fs / 无网络。
 *
 * 为什么从 enrich 路由里搬出来：这段是**账本 schema 的唯一边界** ——
 * 落库之后前端的「查看检索实况」、评测 CLI 的 nDCG 全都读它写出来的字段。
 * 字段一错（尤其 `rank`），错的是"可回看的历史"，事后没法补。
 * 放这里就能用单测钉住，而路由只留编排。
 *
 * 顺序口径：数组按**召回的原始下标**（i = 候选在本次召回里的位置）排列，
 * 前端按 id 分组后仍与原顺序对得上号；**模型的相关度顺序只记在 `rank` 里**，不改数组顺序。
 */
import type { WechatSearchTraceItem } from '@/lib/bus';

/** 账本只关心候选的这三个字段（生产链路的 Hit 满足） */
export interface TraceHit {
  title: string;
  url: string;
  account?: string;
  snippet?: string;
}

/** 入选项：候选下标 + 入选理由；**数组顺序即模型给出的相关度顺序** */
export interface TracePick {
  index: number;
  reason: string;
}

/** 单篇正文读取结果 */
export interface TraceReadResult {
  id: number;
  ok: boolean;
  title: string;
  account: string;
}

export interface BuildTraceOptions {
  /**
   * `picks` 是否来自模型（true）还是兜底（false）。
   *
   * true 才写 `rank`：兜底那几篇（"取召回前 3 篇"）是**召回顺序**，不是相关度判断，
   * 给它标上 0/1/2 就等于凭空造了一份模型排序，nDCG 会因此虚高 —— 宁可不写。
   */
  ranked: boolean;
}

/**
 * 组装实况账本（逐篇：召回 → 判定）。
 *
 * 为什么由服务端组装：落库这一刻信息全在这里（候选全量、入选与理由、正文读取结果、逐篇摘要），
 * 前端只从 SSE 拿过一部分帧 —— 尤其是「被判定掉的那十几篇」，只有服务端手里是完整的。
 */
export function buildTrace(
  hits: TraceHit[],
  picks: TracePick[],
  readResults: TraceReadResult[],
  summaries: Map<number, { summary: string; keypoint: string }>,
  options: BuildTraceOptions,
): WechatSearchTraceItem[] {
  const reasonOf = new Map(picks.map((p) => [p.index, p.reason]));
  // rank = 在 picks 里的位置（picks 已按模型给出的相关度从高到低排序）
  const rankOf = new Map(picks.map((p, i) => [p.index, i]));
  const readOf = new Map(readResults.map((r) => [r.id, r]));
  return hits.map((h, i) => {
    const item: WechatSearchTraceItem = {
      id: i,
      title: h.title,
      url: h.url,
      verdict: reasonOf.has(i) ? 'kept' : 'dropped',
    };
    if (h.account) item.account = h.account;
    if (h.snippet) item.snippet = h.snippet.slice(0, 160);
    if (item.verdict !== 'kept') return item;
    // 入选项：正文读到过就用正文里的标题 / 公众号（更准），并记下是否真读到了正文
    const r = readOf.get(i);
    if (r) {
      if (r.title) item.title = r.title;
      if (r.account) item.account = r.account;
      item.readOk = r.ok;
    }
    const reason = reasonOf.get(i);
    if (reason) item.reason = reason;
    const s = summaries.get(i);
    if (s?.summary) item.summary = s.summary;
    if (s?.keypoint) item.keypoint = s.keypoint;
    if (options.ranked) {
      const rank = rankOf.get(i);
      if (typeof rank === 'number') item.rank = rank;
    }
    return item;
  });
}

/**
 * 精编不可用 / 中途失败时的账本：卡片只留了前几篇 → 账本照此标注，别让右栏空着。
 * `ranked: false`（见 BuildTraceOptions）—— 这几篇是召回顺序，不是模型排序。
 */
export function fallbackTrace(hits: TraceHit[], maxPick: number): WechatSearchTraceItem[] {
  return buildTrace(
    hits,
    hits.slice(0, maxPick).map((_, i) => ({ index: i, reason: '' })),
    [],
    new Map(),
    { ranked: false },
  );
}
