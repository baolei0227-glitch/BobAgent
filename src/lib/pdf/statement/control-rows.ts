/**
 * P1-3：流水特殊行（控制行/汇总行）识别 + 跨页勾稽链拼接。
 *
 * 解决的两个常见误报来源（专家建议 P1-3 控制行政策 + P0-3 crossPageStatus）：
 *  1) 「本页合计 / 小计 / 本期合计 / 本年累计 / 承上页 / 过次页 / 期初余额 / 期末余额」行
 *     不参与勾稽（它们不是单笔交易），目前会被计入 unverifiable 或 mismatch。
 *  2) PDF 分页导致的「勾稽链断裂」：上一页 lastBalance 必须能衔接下一页 firstBalance
 *     或期初余额行；否则判为跨页失败（黄色级）。
 *
 * 舱内纯算法：不做 I/O，不 throw；统一用 issue/result 表达。
 */

import type { LedgerFieldQuality, LedgerSemantics } from '../shared/types';

export type StatementRowKind =
  | 'transaction'       // 普通交易（参与勾稽）
  | 'control_subtotal'  // 小计/本页合计/本期合计（不参与勾稽）
  | 'control_total'     // 本年累计/总计（不参与勾稽）
  | 'opening_balance'   // 期初余额/承上页：重置 prevBalance，不参与「inc/exp→bal」勾稽
  | 'closing_balance'   // 期末余额/过次页：作为 prevBalance 传递给下一页，不参与 inc/exp 勾稽
  | 'header_repeat'     // 跨页重复表头（跳过）
  | 'separator'         // 纯横线/空行/分隔行
  | 'noise';            // 无法分类的其它噪音行

export interface ClassifiedRow {
  /** 1-based 行号（对齐原 table 序号） */
  rowNo: number;
  /** 原始单元格数组，0-based */
  cells: string[];
  kind: StatementRowKind;
  /** 若 kind 为 opening / closing，解析出的余额（「分」整数，可能 null） */
  balanceCent: number | null;
  /** 若为 transaction，解析出的 inc/exp/amt（「分」整数，可能 null） */
  incomeCent: number | null;
  expenseCent: number | null;
  /** debug 辅助：命中的关键词 */
  matchedTags: string[];
}

/** 控制行关键词（出现在「摘要/日期/任一行所有文字」里都算命中；金额/余额列有数值通常为 subtotal/total） */
const SUBTOTAL_RE = /本页|小计|本页合计|页合计|小记|页小计|本期合计|本月合计/;
const TOTAL_RE = /总计|合计(?!.*本期|.*本月|.*本页)|本年累计|累计|年度累计/;
const OPEN_RE = /期初|承上|期初余额|上期余额|承前页|承上页|余额承前/;
const CLOSE_RE = /期末|过次|期末余额|本期余额|余额过次|过次页/;
const HDR_REPEAT_RE = /日期.*摘要.*余额|日期.*金额.*余额|摘要.*收入.*支出.*余额/;
const SEPARATOR_RE = /^-+$/;

/** 简易整数（分）解析 — 金额模块已做的逻辑在这里纯本地再写一份，避免 statement 对 core 的双向依赖。 */
function parseCent(raw: unknown): number | null {
  const s = String(raw ?? '').replace(/[,，¥￥\s]/g, '');
  if (!s || s === '-' || /识别不清|\?|？/.test(s)) return null;
  let neg = false;
  let t = s;
  if (t.startsWith('(') && t.endsWith(')')) { neg = true; t = t.slice(1, -1); }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100);
}

/** 把「整行所有 cells 合并」用于关键词扫描：优先扫摘要列（iSummary 传入），其次扫全部非空列。 */
function joinedText(cells: string[], iSummary?: number): string {
  if (iSummary !== undefined && iSummary >= 0 && cells[iSummary]) return cells[iSummary];
  return cells.filter((c) => c && c.trim()).join(' ');
}

/** 一行分类：纯关键词 + 余额/金额列模式。
 *  indices 传入列索引（统一 0-based），可缺省。
 */
export function classifyRow(params: {
  rowNo: number;
  cells: string[];
  iBalance?: number;
  iIncome?: number;
  iExpense?: number;
  iAmount?: number;
  iSummary?: number;
}): ClassifiedRow {
  const { rowNo, cells, iBalance, iIncome, iExpense, iAmount, iSummary } = params;
  const text = joinedText(cells, iSummary).trim();
  const allText = cells.join(' ').trim();
  const matchedTags: string[] = [];

  // 1) 纯分隔行
  if (allText.length === 0 || cells.every((c) => SEPARATOR_RE.test(c.trim()))) {
    return { rowNo, cells, kind: 'separator', balanceCent: null, incomeCent: null, expenseCent: null, matchedTags: ['separator'] };
  }
  // 2) 重复表头行（所有非空单元格为表头关键字组合，如 "日期 摘要 余额"）
  if (HDR_REPEAT_RE.test(allText) || /日期.*摘要|摘要.*收入.*支出/.test(allText) && (text.includes('日期') || text.includes('摘要'))) {
    return { rowNo, cells, kind: 'header_repeat', balanceCent: null, incomeCent: null, expenseCent: null, matchedTags: ['header_repeat'] };
  }

  // 3) 特殊行关键词扫描（先扫开闭，后扫合计）
  let kind: StatementRowKind = 'transaction';
  if (OPEN_RE.test(text) || OPEN_RE.test(allText)) { kind = 'opening_balance'; matchedTags.push('opening'); }
  else if (CLOSE_RE.test(text) || CLOSE_RE.test(allText)) { kind = 'closing_balance'; matchedTags.push('closing'); }
  else if (SUBTOTAL_RE.test(text) || SUBTOTAL_RE.test(allText)) { kind = 'control_subtotal'; matchedTags.push('subtotal'); }
  else if (TOTAL_RE.test(text) || TOTAL_RE.test(allText)) { kind = 'control_total'; matchedTags.push('total'); }

  // 4) 控制行补充：摘要只有关键词、且金额/余额列有数字 → 更确信它是合计类
  const hasBalance = iBalance !== undefined ? parseCent(cells[iBalance]) !== null : false;
  const hasAmount =
    (iIncome !== undefined ? parseCent(cells[iIncome]) !== null : false) ||
    (iExpense !== undefined ? parseCent(cells[iExpense]) !== null : false) ||
    (iAmount !== undefined ? parseCent(cells[iAmount]) !== null : false);
  if (kind === 'transaction' && (hasAmount || hasBalance)) {
    if (/合计|累计|小计|总计/.test(text) || /合计|累计|小计|总计/.test(allText)) {
      kind = 'control_subtotal';
      matchedTags.push('subtotal-fallback');
    }
  }

  // 5) opening_balance 特征：日期空/只有"期初"关键字 + 余额列有值 + 金额列空
  const dateEmptyish = cells[0] === undefined || cells[0].trim() === '' || /期初|上期/.test(cells[0]);
  const allAmtEmpty =
    (iIncome === undefined || !parseCent(cells[iIncome])) &&
    (iExpense === undefined || !parseCent(cells[iExpense])) &&
    (iAmount === undefined || !parseCent(cells[iAmount]));
  if (kind === 'transaction' && dateEmptyish && hasBalance && allAmtEmpty) {
    kind = 'opening_balance';
    matchedTags.push('opening-shape');
  }
  // closing_balance 特征：最后一笔，日期空/含"期末"关键字 + 余额列有值 + 金额列空
  if (kind === 'transaction' && cells[0] !== undefined && /期末|本期余额|累计/.test(cells[0]) && hasBalance && allAmtEmpty) {
    kind = 'closing_balance';
    matchedTags.push('closing-shape');
  }

  const balanceCent = iBalance !== undefined ? parseCent(cells[iBalance]) : null;
  const incomeCent = iIncome !== undefined ? parseCent(cells[iIncome]) : null;
  const expenseCent = iExpense !== undefined ? parseCent(cells[iExpense]) : null;

  return { rowNo, cells, kind, balanceCent, incomeCent, expenseCent, matchedTags };
}

/** 将 Markdown 表格的行（仅数据行，不含表头）做一次 classifyRow。
 *  返回 ClassifiedRow[]（1-based rowNo），方便勾稽报告按 controlRowPolicy 过滤 / 或做跨页拼接。
 *  header 用于给 classifyRow 传 i* 索引。
 */
export function classifyStatementRows(params: {
  header: string[];
  /** 数据行：每个 cells 与 header 同长，0-based 顺序（紧跟表头后的第一行即 rows[0]） */
  rows: string[][];
  semantics?: Pick<LedgerSemantics, 'controlRowPolicy'>;
}): ClassifiedRow[] {
  const { header, rows } = params;
  const idx = (keys: string[]) => {
    for (let i = 0; i < header.length; i++) {
      const h = header[i];
      for (const k of keys) if (h.includes(k)) return i;
    }
    return -1;
  };
  const iBalance = idx(['余额', '结余', '账户余额', '可用余额']);
  const iIncome = idx(['收入', '贷方', '存入', '进账', '转入', '收']);
  const iExpense = idx(['支出', '借方', '支取', '出账', '转出', '付']);
  const iAmount = idx(['金额', '交易金额', '发生额']);
  const iSummary = idx(['摘要', '备注', '说明', '交易摘要', '对方']);

  return rows.map((cells, i) => classifyRow({
    rowNo: i + 1,
    cells,
    iBalance: iBalance >= 0 ? iBalance : undefined,
    iIncome: iIncome >= 0 ? iIncome : undefined,
    iExpense: iExpense >= 0 ? iExpense : undefined,
    iAmount: iAmount >= 0 ? iAmount : undefined,
    iSummary: iSummary >= 0 ? iSummary : undefined,
  }));
}

/**
 * 参与勾稽的「交易行」筛选（严格对应 controlRowPolicy）：
 *   exclude          → 只保留 transaction + opening_balance（余额锚点） + closing_balance（尾锚点）
 *   include          → 全部保留（控制行也参与勾稽；仅用于比对/排查）
 *   template_defined → exclude + 额外扣除 subtotal/total（当前 P1-3 的默认最佳）
 */
export function filterReconciliationRows(
  classified: ClassifiedRow[],
  policy: LedgerSemantics['controlRowPolicy'],
): ClassifiedRow[] {
  if (policy === 'include') return classified;
  const keep = new Set<StatementRowKind>(['transaction', 'opening_balance', 'closing_balance']);
  if (policy === 'template_defined') {
    // subtotal/total 直接排除；closing 保留做尾锚（跨页时作为前一页的尾平衡）
  }
  return classified.filter((r) => keep.has(r.kind));
}

// ============================================================
// 跨页拼接：把 OcrPage[] 或逐页的 Markdown 表格合成一条勾稽链
// ============================================================

export interface PageLedgerFragment {
  pageIndex: number; // 0-based
  classifiedRows: ClassifiedRow[];
  /** 解析出的 opening balance（如果存在 opening_balance 行或首行交易前余额） — 分整数 */
  openingCent: number | null;
  /** 解析出的 closing balance — 分整数 */
  closingCent: number | null;
  /** 本页按单页算的 verified / failed / unverifiable 数量（仅 transaction 计数） */
  txCount: number;
}

export interface CrossPageReconciliation {
  /** 能首尾衔接的页数（通过了 crossPageStatus.pass 判定的页面过渡数） */
  passes: number;
  fails: number;
  /** 总页数 ≥ 2 才有效；否则 status = insufficient_data */
  totalFragments: number;
  /** P2-3：needs_review 新增 =「衔接对不平但 fieldQuality 差，先不硬判 fail，等人工复核」 */
  status: 'pass' | 'fail' | 'needs_review' | 'not_checked' | 'insufficient_data';
  /** 衔接失败明细：第 i 页的 closing → 第 i+1 页 opening 的差额（分整数） */
  failures: Array<{ fromPageIndex: number; toPageIndex: number; diffCent: number; expected: number | null; actual: number | null }>;
  /** P2-3：fieldQuality 判定为「差」的页索引集合（调用方可快速定位哪些页导致了软化） */
  poorPageIndices?: number[];
}

/** 从逐页的 fragments 算 crossPageStatus。要求每页都有 classifiedRows，优先用 opening/closing_balance 类行；
 *  没有 opening 行时用第一笔 transaction 的余额作为 opening 代理（会有警告但仍判）；
 *  没有 closing 行时用最后一笔 transaction 的余额作为 closing 代理。
 *
 *  P2-3：fieldQualities 非必传。若传：
 *   - amountParseRate < 0.6 或 balanceParseRate < 0.6 或 rowStructureConfidence < 0.5 → 本页标记 'poor'
 *   - 不是 poor，但 amountParseRate < 0.8 或 balanceParseRate < 0.8 或 rowStructureConfidence < 0.7 → 'mediocre'
 *   - 否则 'good'
 *  最终 status：若 fails>0，且「任一失败衔接对的 from/to 页是 poor」，或「mediocre 覆盖衔接对 ≥ 1/3 且 fails ≤ 2」，
 *  → 不硬判 fail，转 'needs_review'（扫描件糊页导致 OCR 错值属于正常情况，法律证据链上应该标 yellow 需要复核，而非直接否定）。
 */
export function crossPageReconciliation(
  fragments: PageLedgerFragment[],
  fieldQualities?: Array<LedgerFieldQuality | undefined>,
): CrossPageReconciliation {
  const N = fragments.length;
  if (N < 2) return { passes: 0, fails: 0, totalFragments: N, status: 'insufficient_data', failures: [], poorPageIndices: [] };

  // 逐页 field quality 评级
  const ratePage = (idx: number): 'poor' | 'mediocre' | 'good' => {
    const fq = fieldQualities?.[idx];
    if (!fq) return 'good';
    const poor = fq.amountParseRate < 0.6 || fq.balanceParseRate < 0.6 || fq.rowStructureConfidence < 0.5;
    if (poor) return 'poor';
    const mediocre = fq.amountParseRate < 0.8 || fq.balanceParseRate < 0.8 || fq.rowStructureConfidence < 0.7;
    if (mediocre) return 'mediocre';
    return 'good';
  };
  const pageRates: Array<'poor' | 'mediocre' | 'good'> = [];
  const poorPageIndices: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = ratePage(i);
    pageRates.push(r);
    if (r === 'poor') poorPageIndices.push(fragments[i]?.pageIndex ?? i);
  }

  const effectiveOpening = (f: PageLedgerFragment): number | null => {
    if (f.openingCent !== null) return f.openingCent;
    // 代理：第一笔 transaction（或 opening 行形态）的余额
    const firstTx = f.classifiedRows.find((r) => r.kind === 'transaction' && r.balanceCent !== null);
    return firstTx?.balanceCent ?? null;
  };
  const effectiveClosing = (f: PageLedgerFragment): number | null => {
    if (f.closingCent !== null) return f.closingCent;
    // 代理：最后一笔 transaction 的余额
    const lastTx = [...f.classifiedRows].reverse().find((r) => r.kind === 'transaction' && r.balanceCent !== null);
    return lastTx?.balanceCent ?? null;
  };

  let passes = 0;
  let fails = 0;
  const failures: CrossPageReconciliation['failures'] = [];
  const failedPairIndices: number[] = []; // 记录哪几个衔接对失败了（i 表示 cur=i, next=i+1）
  const mediocreOrWorsePairs: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    const cur = fragments[i];
    const next = fragments[i + 1];
    const tail = effectiveClosing(cur);
    const head = effectiveOpening(next);
    if (tail === null || head === null) {
      continue;
    }
    const diff = head - tail;
    if (diff === 0) {
      passes++;
    } else {
      fails++;
      failedPairIndices.push(i);
      failures.push({ fromPageIndex: i, toPageIndex: i + 1, diffCent: diff, expected: tail, actual: head });
    }
    if (pageRates[i] !== 'good' || pageRates[i + 1] !== 'good') mediocreOrWorsePairs.push(i);
  }
  const anyValidated = passes > 0 || fails > 0;
  let status: CrossPageReconciliation['status'] = 'not_checked';
  if (!anyValidated) status = 'insufficient_data';
  else if (fails === 0) status = 'pass';
  else {
    // 软化判定：
    // A) 任一失败衔接对的 from/to 页是 poor → needs_review
    const anyPoorOnFailPair = failedPairIndices.some((p) => pageRates[p] === 'poor' || pageRates[p + 1] === 'poor');
    // B) mediocre+ 衔接对覆盖 ≥ 1/3 的有效衔接对，且失败数 ≤ 2（整体质量一般，少量不平可能只是局部错字）
    const totalPairs = passes + fails;
    const mediocreCoverage = totalPairs > 0 ? mediocreOrWorsePairs.length / totalPairs : 0;
    const mostlyMediocreFewFails = fails <= 2 && mediocreCoverage >= 1 / 3;
    if (anyPoorOnFailPair || mostlyMediocreFewFails) status = 'needs_review';
    else status = 'fail';
  }
  return { passes, fails, totalFragments: N, status, failures, poorPageIndices: poorPageIndices.length ? poorPageIndices : undefined };
}
