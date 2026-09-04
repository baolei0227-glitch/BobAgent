/**
 * 扫描件 PDF -> 主节点直接识别前的「页级属性打标 + 按任务属性归集切段」。
 * 目的：避免按页号连续切分导致流水页与合同/发票/封面页混杂，
 * 改为把所有流水页集中到 1–2 段、合同/发票/封面页集中到另外段（识别统一走 bob-ocr-mcp）。
 */

export type PageTag = 'ledger' | 'contract'; // 疑似流水（要打 VLM） vs 合同/发票/封面（不打 VLM，纯本地）

export interface TaggedPage {
  index: number;       // 1-based
  tag: PageTag;
  score: number;       // looksLikeLedger.score（合同页默认 0）
  headSnippet: string; // 前 120 字（供 debug 日志打印，不进缓存）
}

export interface Segment {
  tag: PageTag;
  /** 1-based 闭区间页号 */
  pageFrom: number;
  pageTo: number;
  /** 该段总页数 */
  size: number;
  /** 段内流水页的数目（用于估算该段 VLM 工作量） */
  ledgerCount: number;
  /** pages 参数格式："3" 或 "3-7" */
  pagesArg: string;
}

/** 切分策略阈值（都非常保守，实际段数受识别任务批次限制） */
export const SCHEDULER = {
  /** 单个识别段的最大页数（避免某段太长又成了串行瓶颈，默认 8 页 = 预热缓存零延迟阈值） */
  maxPagesPerSegment: 8,
  /** 相邻页标签相同 → 合并为同一 run；不同则拆 run；再把 run 归集到段 */
  /** 合同段是否独立成段（默认 true：合同/封面/发票 ≠ 流水 → 分开识别） */
  segregateLedgerAndContract: true,
} as const;

/** 把 1..N 连续页按标签合并成 run（同标签相邻合并为一个 run 闭区间） */
function makeRuns(tags: TaggedPage[]): Array<{ tag: PageTag; from: number; to: number; ledgerCount: number }> {
  const runs: Array<{ tag: PageTag; from: number; to: number; ledgerCount: number }> = [];
  for (const p of tags) {
    const last = runs[runs.length - 1];
    if (last && last.tag === p.tag) {
      last.to = p.index;
      if (p.tag === 'ledger') last.ledgerCount++;
    } else {
      runs.push({ tag: p.tag, from: p.index, to: p.index, ledgerCount: p.tag === 'ledger' ? 1 : 0 });
    }
  }
  return runs;
}

/** 把 run 切分成段（保证每段 ≤ maxPagesPerSegment，并按标签归集） */
function splitRunsIntoSegments(
  runs: Array<{ tag: PageTag; from: number; to: number; ledgerCount: number }>,
  maxSize: number,
): Segment[] {
  const out: Segment[] = [];
  for (const r of runs) {
    // 单个 run 跨很多页（比如流水 15 页）→ 拆成多个 maxSize 段分块识别
    for (let s = r.from; s <= r.to; s += maxSize) {
      const e = Math.min(s + maxSize - 1, r.to);
      // ledgerCount: 整个 run 的 ledgerCount 按长度比例分配（一般 run.tag=ledger → 全段都是 ledger）
      const size = e - s + 1;
      const portion = size / (r.to - r.from + 1);
      const ledgerCount = r.tag === 'ledger' ? size : Math.max(0, Math.round(r.ledgerCount * portion));
      out.push({
        tag: r.tag,
        pageFrom: s,
        pageTo: e,
        size,
        ledgerCount,
        pagesArg: s === e ? `${s}` : `${s}-${e}`,
      });
    }
  }
  return out;
}

/**
 * 主入口：根据每页打标结果 → 生成委派段列表。
 * @param pages 必须按 index 升序（1-based，连续也 OK，中间有缺页会被保护插值成 contract）
 * @returns segments 按页号升序
 */
export function scheduleSegments(
  pages: TaggedPage[],
  opts: Partial<typeof SCHEDULER> = {},
): Segment[] {
  const cfg = { ...SCHEDULER, ...opts };
  if (pages.length === 0) return [];

  // 页码补齐 & 排序（缺页 → 视为 contract，避免中间缺页导致段边界错位）
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const minP = sorted[0].index;
  const maxP = sorted[sorted.length - 1].index;
  const byIndex = new Map(sorted.map((p) => [p.index, p]));
  const filled: TaggedPage[] = [];
  for (let i = minP; i <= maxP; i++) {
    const p = byIndex.get(i);
    filled.push(
      p ?? { index: i, tag: 'contract', score: 0, headSnippet: '(缺页，按合同处理)' },
    );
  }

  const runs = makeRuns(filled);
  // segregateLedgerAndContract=true 就不做额外跨标签合并
  const segments = splitRunsIntoSegments(runs, cfg.maxPagesPerSegment);

  // 最后：极端情况（整本全是 contract）—— 还是切成多段（虽然不打 VLM，但 OCR 本身也可以并行）
  // 已经在 splitRunsIntoSegments 里按 maxSize 切了，所以自然处理

  return segments;
}

/** 兼容旧版按页号连续均分的策略（作为 fallback，looksLikeLedger 全抛错或信息不足时回退） */
export function scheduleUniform(totalPages: number, segCount: number, maxSize = SCHEDULER.maxPagesPerSegment): Segment[] {
  if (totalPages <= 0) return [];
  const size = Math.max(1, Math.min(maxSize, Math.ceil(totalPages / Math.max(1, segCount))));
  const out: Segment[] = [];
  for (let s = 1; s <= totalPages; s += size) {
    const e = Math.min(s + size - 1, totalPages);
    out.push({
      tag: 'contract',
      pageFrom: s, pageTo: e, size: e - s + 1,
      ledgerCount: 0,
      pagesArg: s === e ? `${s}` : `${s}-${e}`,
    });
  }
  return out;
}
