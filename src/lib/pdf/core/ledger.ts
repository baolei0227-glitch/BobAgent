/**
 * 银行流水/账单表格智能识别（勾稽校验与语义判定）
 *
 * 本模块只做「纯算法」流水表格判定与余额勾稽（基于外部 OCR 产出的文字块/文本），
 * 不再承载任何本地识别引擎：行结构来自 bob-ocr-mcp 的识别结果，
 * 逐行转录 / 图像渲染 / 切片识别等本地链路已随 OCR 收敛到插件而移除。
 *
 * 适用：打印版银行流水、账单、台账等密集数字表格的勾稽校验与语义确认。
 */

import type { OcrPage, OcrBlock, CellVerification } from './layout-score';
import { estimateColumns } from './layout-score';
import { toMinorUnit, formatMinorUnit, reconcile } from '../shared/money';
import type { LedgerValidationReport, LedgerIssue, StatementLedgerRow } from '../shared/types';
import { inferLedgerSemantics, parseMarkdownTable } from '../statement/semantics';
import {
  classifyStatementRows,
  filterReconciliationRows,
  crossPageReconciliation,
  type ClassifiedRow,
  type PageLedgerFragment,
} from '../statement/control-rows';
import {
  verifyLedgerPageCells,
  summarizeFieldQuality,
  preAssessCellPreColor,
  aggregateColor,
  worstColor,
  type VerifyLedgerPageInput,
  type CellColor,
} from '../statement/cell-verification';
import type { LedgerFieldQuality, LedgerSemantics } from '../shared/types';

/** 行聚类阈值：两个文字块 midY 归一化差小于该值视为同一行 */
const ROW_CLUSTER_EPS = 0.012;
/** 单行最小高度（归一化）：低于此值视为异常小块，聚类时忽略 */
const MIN_ROW_BLOCK_H = 0.004;

export interface LedgerBalanceCheck {
  totalRows: number;
  verified: number;
  /** 勾稽不一致行：{ 行号, 期望余额, 实际余额, 差额 } */
  mismatches: { row: number; expected: number; actual: number; diff: number }[];
  /** 因「识别不清」无法参与校验的行号 */
  unverifiableRows: number[];
}

/** 按归一化 midY（Vision 坐标系，原点左下、y 向上）聚类文字块为行，返回自上而下排列的行 */
export function clusterRows(blocks: OcrBlock[]): OcrBlock[][] {
  const sorted = [...blocks]
    .filter((b) => b.h >= MIN_ROW_BLOCK_H)
    .sort((a, b) => (b.y + b.h / 2) - (a.y + a.h / 2));
  const rows: OcrBlock[][] = [];
  for (const block of sorted) {
    const midY = block.y + block.h / 2;
    if (rows.length === 0) {
      rows.push([block]);
      continue;
    }
    const currentTop = rows[rows.length - 1][0];
    const currentMidY = currentTop.y + currentTop.h / 2;
    if (Math.abs(midY - currentMidY) <= ROW_CLUSTER_EPS) {
      rows[rows.length - 1].push(block);
    } else {
      rows.push([block]);
    }
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

/** 判定图片是否为表格型（银行流水/账单）：表格框线 或 多列且行数 ≥3 */
export function isLedgerLike(page: OcrPage): boolean {
  const blocks = page.blocks ?? [];
  if (blocks.length < 4) return false;
  if (page.layout?.hasTableLines) return true;
  if (estimateColumns(blocks) >= 2) {
    return clusterRows(blocks).length >= 3;
  }
  return false;
}

/** 余额勾稽校验：解析 Markdown 表格（日期|摘要|收入|支出|余额），校验余额链。
 *  兼容"交易金额单列"模式（常见于银行流水：表头无独立收入/支出列，金额列以正负号区分收支）：
 *  此时收入/支出列缺失但存在金额列，正值计入收入、负值绝对值计入支出。
 *
 *  P0-4：所有金额比较改为「最小货币单位整数（分）」，去掉 IEEE 754 浮点 0.005 容差。
 *  mismatch 对外仍以 2 位小数数字呈现，不改现有消费者结构。
 */
export function checkLedgerBalance(transcript: string): LedgerBalanceCheck {
  const empty: LedgerBalanceCheck = { totalRows: 0, verified: 0, mismatches: [], unverifiableRows: [] };

  // 先解析 Markdown 表 → 然后做特殊行分类（按 P1-3 controlRowPolicy 过滤）
  const parsed = parseMarkdownTable(transcript);
  if (!parsed) {
    // 兜底：没解析出 Markdown 表时仍跑老的 "| 日期 | 余额 |" 扫法，保持旧行为；此时无控制行排除。
    return checkLedgerBalanceLegacy(transcript);
  }

  const { header, rows } = parsed;
  const semantics = inferLedgerSemantics({ kind: 'structured', header, rows });
  const classified = classifyStatementRows({ header, rows, semantics });
  const filtered = filterReconciliationRows(classified, semantics.controlRowPolicy);

  // 为了兼容旧接口的「mismatch.row = 原 1-based 行号」，我们用 ClassifiedRow.rowNo（已 1-based）。
  const toDisplay = (cent: number): number => parseFloat(formatMinorUnit(cent));

  let prevBalanceCent: number | null = null;
  let verified = 0;
  const mismatches: LedgerBalanceCheck['mismatches'] = [];
  const unverifiableRows: number[] = [];
  let totalRows = 0;

  const findColIdx = (keys: string[]) => {
    for (let i = 0; i < header.length; i++) for (const k of keys) if (header[i].includes(k)) return i;
    return -1;
  };
  const iIncome = findColIdx(['收入', '贷方', '存入', '进账', '转入', '收']);
  const iExpense = findColIdx(['支出', '借方', '支取', '出账', '转出', '付']);
  const iAmount = findColIdx(['金额', '交易金额', '发生额']);
  const amountSingleCol =
    iIncome < 0 && iExpense < 0 && iAmount >= 0 ? true
    : (semantics.amountMode === 'signed_amount' || semantics.amountMode === 'amount_with_direction');

  for (const r of filtered) {
    // opening_balance：直接把 prevBalance 置为该行余额（不参与「inc/exp → bal」勾稽，也不计入 totalRows）
    if (r.kind === 'opening_balance') {
      if (r.balanceCent !== null) prevBalanceCent = r.balanceCent;
      continue;
    }
    // closing_balance：只用于更新 prevBalance（以便后续衔接下一页或后续行）
    if (r.kind === 'closing_balance') {
      if (r.balanceCent !== null) prevBalanceCent = r.balanceCent;
      continue;
    }
    // 只对 transaction 计数；其它保留类在 policy='include' 时可能走到这里，目前也按 tx 处理
    totalRows++;

    const balanceCent = r.balanceCent;
    let incomeCent: number | null;
    let expenseCent: number | null;
    if (amountSingleCol) {
      // 金额单列：优先 cells[iAmount]；如果为 null，再用 incomeCent/expenseCent 回退
      const amt = iAmount >= 0 ? (() => {
        const s = r.cells[iAmount];
        return s === undefined ? null : toMinorUnit(s);
      })() : null;
      if (amt === null) {
        // 回退：看 incomeCent / expenseCent 二选一有值的那个
        incomeCent = r.incomeCent;
        expenseCent = r.expenseCent;
      } else {
        incomeCent = amt > 0 ? amt : 0;
        expenseCent = amt < 0 ? -amt : 0;
      }
    } else {
      incomeCent = r.incomeCent;
      expenseCent = r.expenseCent;
    }

    if (balanceCent === null) {
      unverifiableRows.push(r.rowNo);
      prevBalanceCent = null;
      continue;
    }
    if (incomeCent === null || expenseCent === null) {
      unverifiableRows.push(r.rowNo);
      prevBalanceCent = balanceCent;
      continue;
    }
    if (prevBalanceCent !== null) {
      const diffCent = reconcile(prevBalanceCent, incomeCent, expenseCent, balanceCent);
      if (diffCent !== 0 && diffCent !== null) {
        const expectedCent = prevBalanceCent + incomeCent - expenseCent;
        mismatches.push({
          row: r.rowNo,
          expected: toDisplay(expectedCent),
          actual: toDisplay(balanceCent),
          diff: toDisplay(diffCent),
        });
      } else {
        verified++;
      }
    }
    prevBalanceCent = balanceCent;
  }

  return { totalRows, verified, mismatches, unverifiableRows };
}

/** 兜底老实现：当 transcript 没有 Markdown 表格形态（即只是个 "| 日期 | ... |" 的一两个字符片段）
 *  但仍含日期+余额列头时，用旧式逐行扫描。逻辑与改前 checkLedgerBalance 主体等价，不再做控制行排除。 */
function checkLedgerBalanceLegacy(transcript: string): LedgerBalanceCheck {
  const empty: LedgerBalanceCheck = { totalRows: 0, verified: 0, mismatches: [], unverifiableRows: [] };
  const lines = transcript.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes('日期') && l.includes('余额') && l.includes('|'));
  if (headerIdx < 0) return empty;
  const header = lines[headerIdx].split('|').map((c) => c.trim());
  const colOf = (kw: string) => header.findIndex((h) => h.includes(kw));
  let iDate = colOf('日期');
  let iIncome = colOf('收入');
  let iExpense = colOf('支出');
  const iBalance = colOf('余额');
  const iAmount = colOf('金额');
  const amountSingleCol = iBalance >= 0 && iIncome < 0 && iExpense < 0 && iAmount >= 0;
  if (amountSingleCol) { iIncome = iAmount; iExpense = iAmount; }
  if (iBalance < 0 || (iIncome < 0 && iExpense < 0)) return empty;

  const toDisplay = (cent: number): number => parseFloat(formatMinorUnit(cent));

  let rowNo = 0;
  let prevBalanceCent: number | null = null;
  let verified = 0;
  const mismatches: LedgerBalanceCheck['mismatches'] = [];
  const unverifiableRows: number[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const cell = (idx: number) => (idx >= 0 ? cells[idx] ?? '' : '');
    const nonEmptyCells = cells.filter((c) => c.trim() !== '');
    if (nonEmptyCells.length > 0 && nonEmptyCells.every((c) => /^-+$/.test(c.replace(/\s/g, '')))) continue;
    const dateCell = cell(iDate);
    const balCell = cell(iBalance);
    if (dateCell.includes('日期') || dateCell.includes('摘要') || balCell.includes('余额')) continue;

    rowNo++;
    const balanceCent = toMinorUnit(cell(iBalance));
    let incomeCent: number | null;
    let expenseCent: number | null;
    if (amountSingleCol) {
      const amt = toMinorUnit(cell(iIncome));
      if (amt === null) { incomeCent = null; expenseCent = null; }
      else { incomeCent = amt > 0 ? amt : 0; expenseCent = amt < 0 ? -amt : 0; }
    } else {
      incomeCent = iIncome >= 0 ? toMinorUnit(cell(iIncome)) : 0;
      expenseCent = iExpense >= 0 ? toMinorUnit(cell(iExpense)) : 0;
    }

    if (balanceCent === null) { unverifiableRows.push(rowNo); prevBalanceCent = null; continue; }
    if (incomeCent === null || expenseCent === null) { unverifiableRows.push(rowNo); prevBalanceCent = balanceCent; continue; }
    if (prevBalanceCent !== null) {
      const diffCent = reconcile(prevBalanceCent, incomeCent, expenseCent, balanceCent);
      if (diffCent !== 0 && diffCent !== null) {
        const expectedCent = prevBalanceCent + incomeCent - expenseCent;
        mismatches.push({ row: rowNo, expected: toDisplay(expectedCent), actual: toDisplay(balanceCent), diff: toDisplay(diffCent) });
      } else verified++;
    }
    prevBalanceCent = balanceCent;
  }
  return { totalRows: rowNo, verified, mismatches, unverifiableRows };
}

/**
 * P2-4：基于 page/cellVerification/classified/filtered/markdownRows 把
 * 四/五列文本 + 控制行分类 + 分整数金额/余额 + 绿黄红颜色，组装到 LedgerValidationReport.rowsByKind。
 * 消费方（bob-bank-statement Skill / Excel 导出 / 事实舱写入 / 复核清单）共用同一组 rows，
 * 避免每层重新写行聚类/列检测/控制行分类/准入过滤导致逻辑漂移。
 */
function attachStatementLedgerRows(params: {
  page: OcrPage;
  report: LedgerValidationReport;
  pageIndex0Based: number;
  markdownHeader: string[];
  markdownRows: string[][];
  rowNumbers1Based: number[];
  semantics: LedgerSemantics;
  cols: LedgerCol[];
}): void {
  const { page, report, pageIndex0Based, markdownHeader, markdownRows, rowNumbers1Based, semantics, cols } = params;
  void cols;
  const classified = classifyStatementRows({ header: markdownHeader, rows: markdownRows, semantics });
  const filteredRowNos = new Set(
    filterReconciliationRows(classified, semantics.controlRowPolicy).map((r) => r.rowNo),
  );
  const dualColumn = semantics.amountMode === 'income_expense_columns';

  const cv = page.cellVerification ?? {};
  const parseCentLocal = (raw: unknown): number | null => {
    const s = String(raw ?? '').replace(/[,，¥￥\s]/g, '');
    if (!s || s === '-' || /识别不清|\?|？/.test(s)) return null;
    let neg = false;
    let t = s;
    if (t.startsWith('(') && t.endsWith(')')) { neg = true; t = t.slice(1, -1); }
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return Math.round((neg ? -n : n) * 100);
  };
  const rows: StatementLedgerRow[] = [];
  for (let i = 0; i < markdownRows.length; i++) {
    const rowNo = rowNumbers1Based[i] ?? i + 1;
    const mdRow = markdownRows[i];
    const dateText = mdRow[0] ?? '';
    const summaryText = mdRow[1] ?? '';
    const amountText = mdRow[2] ?? '';
    const balanceText = mdRow[3] ?? '';
    const cRow = classified.find((r) => r.rowNo === rowNo);
    const kind: StatementLedgerRow['kind'] = cRow?.kind ?? 'noise';
    const participatesInReconciliation =
      filteredRowNos.has(rowNo) && kind === 'transaction';
    let incomeText: string | undefined;
    let expenseText: string | undefined;
    if (dualColumn) {
      incomeText = '';
      expenseText = '';
    }
    let finalColor: CellColor | undefined;
    {
      const kinds4: LedgerColKind[] = ['date', 'summary', 'amount', 'balance'];
      const colors: CellColor[] = [];
      for (const k of kinds4) {
        const v = cv[`R${rowNo}_${String(k).toUpperCase()}`];
        if (v) colors.push(aggregateColor(v));
      }
      if (colors.length) finalColor = worstColor(colors);
    }
    const amountCent =
      (cRow?.incomeCent == null && cRow?.expenseCent == null)
        ? parseCentLocal(amountText)
        : null;
    rows.push({
      pageIndex0Based,
      rowPage1Based: rowNo,
      dateText,
      summaryText,
      amountText,
      incomeText,
      expenseText,
      balanceText,
      kind,
      participatesInReconciliation,
      amountCent,
      incomeCent: cRow?.incomeCent ?? null,
      expenseCent: cRow?.expenseCent ?? null,
      balanceCent: cRow?.balanceCent ?? null,
      finalColor,
    });
  }
  report.rowsByKind = rows;
  report.markdownHeader = dualColumn
    ? ['日期', '摘要', '收入', '支出', '余额']
    : ['日期', '摘要', '金额', '余额'];
}

/**
 * 基于 LedgerBalanceCheck 合成专家建议的「勾稽报告」。
 * totalTransactionRows 来自外部（如 ledgerVerificationScore 的行聚类总行数），用于算 coverageRate。
 * semanticsStatus 在 P1 账务语义确认模块落地前默认为 'ambiguous'（即：本报告仅作候选排序信号，不直接生成绿色事实）。
 */
export function buildLedgerValidationReport(
  check: LedgerBalanceCheck,
  opts?: { totalRows?: number; semanticsStatus?: LedgerValidationReport['semanticsStatus'] },
): LedgerValidationReport {
  const { totalRows, semanticsStatus } = opts ?? {};
  const detectedAsLedger = check.totalRows > 0 || (check.verified === 0 && check.mismatches.length === 0 ? true : false);
  const comparableRows = check.verified + check.mismatches.length; // 可读 + 可比较
  const insufficientRows = check.unverifiableRows.length;
  const failedRows = check.mismatches.length;
  const passedRows = check.verified;
  const base = totalRows ?? check.totalRows;
  const coverageRate = base > 0 ? Math.min(1, comparableRows / base) : 0;
  const passRate = comparableRows > 0 ? passedRows / comparableRows : null;

  // longest passing chain：按行号扫一遍，计算「连续 verified」的最长链
  const passedSet = new Set<number>();
  // mismatches 占据明确失败行
  const failedSet = new Set<number>(check.mismatches.map((m) => m.row));
  const unverifSet = new Set<number>(check.unverifiableRows);
  // 参与勾稽通过的行数 = verified，但 check 没给具体行号（且 mismatches 也没给成功集合）。
  // 为避免二义，我们按「1..totalRows 中既未失败也未不可校验」视为 passed 候选（可能高估），
  // 更严谨方式：1..totalRows - failedSet - unverifSet；长度上限不得超过 verified。
  let chain = 0;
  let longest = 0;
  const upTo = Math.max(check.totalRows, base ?? 0);
  let countedPassed = 0;
  for (let r = 1; r <= upTo; r++) {
    if (failedSet.has(r) || unverifSet.has(r)) {
      chain = 0;
      continue;
    }
    if (countedPassed >= passedRows) break;
    chain++;
    countedPassed++;
    passedSet.add(r);
    longest = Math.max(longest, chain);
  }

  const issues: LedgerIssue[] = [
    ...check.mismatches.map<LedgerIssue>((m) => ({
      row: m.row,
      kind: 'mismatch',
      message: `期望余额 ${m.expected.toFixed(2)}，实际 ${m.actual.toFixed(2)}，差额 ${m.diff.toFixed(2)}`,
    })),
    ...check.unverifiableRows.map<LedgerIssue>((row) => ({
      row,
      kind: 'unverifiable',
      message: '收支或余额识别不清，无法参与勾稽',
    })),
  ];

  const report: LedgerValidationReport = {
    detectedAsLedger: check.totalRows > 0,
    comparableRows,
    passedRows,
    failedRows,
    insufficientRows,
    passRate,
    coverageRate,
    longestPassingChain: longest,
    crossPageStatus: 'insufficient_data',
    semanticsStatus: semanticsStatus ?? 'ambiguous',
    issues,
  };
  return report;
}

/**
 * P1-3：把 OcrPage[] 整合成多页勾稽报告（含 crossPageStatus 判定 + 控制行 issue）。
 *  调用方在「多页 PDF 已被判定为流水」或 applyPdfBridge 场景（已知 pages 数组）调用本函数，
 *  替换逐页调用 ledgerValidationReport。返回结构与单页 report 对齐（九元组 + issues[]）。
 */
export function buildMultiPageLedgerReport(pages: OcrPage[]): LedgerValidationReport {
  const empty: LedgerValidationReport = {
    detectedAsLedger: false, comparableRows: 0, passedRows: 0, failedRows: 0, insufficientRows: 0,
    passRate: null, coverageRate: 0, longestPassingChain: 0, crossPageStatus: 'insufficient_data',
    semanticsStatus: 'ambiguous', issues: [],
  };
  if (!pages.length) return empty;

  // 每页：行聚类 + 列检测 + 生成 Markdown + checkLedgerBalance（走 P1-3 控制行排除）
  const perPage = pages.map((p) => ({ page: p, report: ledgerValidationReport(p) }));
  // P2-3d：单页 ledgerValidationReport(page) 已经写了 page.ledgerFieldQuality / ledgerSemantics / ledgerValidationReport，
  // 这里强制同步（不覆盖只是再落一次保险；若 page 没写再补上）。
  perPage.forEach((pr) => {
    if (!pr.page.ledgerFieldQuality && pr.report.fieldQuality) pr.page.ledgerFieldQuality = pr.report.fieldQuality;
    if (!pr.page.ledgerValidationReport) pr.page.ledgerValidationReport = pr.report;
  });
  const aggregate = perPage.reduce<{
    comparableRows: number; passedRows: number; failedRows: number; insufficientRows: number;
    issues: LedgerIssue[]; longest: number;
  }>(
    (acc, pr, i0) => {
      const r = pr.report;
      acc.comparableRows += r.comparableRows;
      acc.passedRows += r.passedRows;
      acc.failedRows += r.failedRows;
      acc.insufficientRows += r.insufficientRows;
      acc.longest = Math.max(acc.longest, r.longestPassingChain);
      // issues 的 row 字段目前是「页内 1-based」——为避免多页混淆，这里追加前缀 "Page X row Y"
      const pn = i0 + 1;
      for (const it of r.issues) {
        acc.issues.push({
          row: it.row,
          kind: it.kind,
          message: `[Page ${pn}] ${it.message}`,
        });
      }
      return acc;
    },
    { comparableRows: 0, passedRows: 0, failedRows: 0, insufficientRows: 0, issues: [], longest: 0 },
  );

  const totalTxBase = perPage.reduce((s, pr) => s + (pr.report.comparableRows + pr.report.insufficientRows), 0);
  const fragments: PageLedgerFragment[] = perPage.map((pr, i) => {
    const p = pr.page;
    const rows = clusterRows(p.blocks ?? []);
    const info = detectLedgerColumns(rows);
    let classified: ClassifiedRow[] = [];
    let openingCent: number | null = null;
    let closingCent: number | null = null;
    let txCount = 0;
    if (info) {
      // 构造 header + rows：同 ledgerValidationReport 流程
      const header = ['日期', '摘要', '金额', '余额'];
      const { headerIdx, cols } = info;
      const dateCol = cols.find((c) => c.kind === 'date');
      const amountCol = cols.find((c) => c.kind === 'amount');
      const balanceCol = cols.find((c) => c.kind === 'balance');
      const summaryCol = cols.find((c) => c.kind === 'summary') ?? null;
      void dateCol; void amountCol; void balanceCol; void summaryCol;
      const dataRows: string[][] = [];
      for (let ri = 0; ri < rows.length; ri++) {
        if (ri === headerIdx) continue;
        const row = rows[ri];
        const cellOf = (kind: 'date' | 'summary' | 'amount' | 'balance') => {
          const col = cols.find((c) => c.kind === kind);
          if (!col) return '';
          return row
            .filter((b) => b.x >= col.x0 && b.x < col.x1)
            .sort((a, b) => a.x - b.x)
            .map((b) => b.text)
            .join(' ')
            .trim();
        };
        dataRows.push([cellOf('date'), cellOf('summary'), cellOf('amount'), cellOf('balance')]);
      }
      classified = classifyStatementRows({ header, rows: dataRows });
      const opening = classified.find((r) => r.kind === 'opening_balance');
      const closing = classified.find((r) => r.kind === 'closing_balance');
      openingCent = opening?.balanceCent ?? null;
      closingCent = closing?.balanceCent ?? null;
      txCount = classified.filter((r) => r.kind === 'transaction').length;
    }
    return { pageIndex: i, classifiedRows: classified, openingCent, closingCent, txCount };
  });

  // P2-3c：把逐页 fieldQuality 传给 crossPageReconciliation，用于失败软化。
  //  注意：fragments[i] 与 perPage[i] 按索引严格对齐（都是 pages.map 的顺序）。
  const fieldQualities = perPage.map((pr) => pr.report.fieldQuality);
  const cross = crossPageReconciliation(fragments, fieldQualities);

  // 跨页失败也作为 issues（kind='cross_page_break'）
  for (const f of cross.failures) {
    const fmt = (c: number | null) => (c === null ? '?' : formatMinorUnit(c));
    aggregate.issues.push({
      row: 0,
      kind: 'cross_page_break',
      message: `跨页勾稽断裂 Page ${f.fromPageIndex + 1}→${f.toPageIndex + 1}：期望尾余额 ${fmt(f.expected)}，实际首余额 ${fmt(f.actual)}，差额 ${f.diffCent ? formatMinorUnit(f.diffCent) : '?'}`,
    });
  }

  // 控制行命中：单独 kind='control_row' issues（仅当语义 status=confirmed 或 inferred 时；否则不放大噪音）
  const firstReport = perPage.find((pr) => pr.report.semanticsStatus !== 'ambiguous');
  if (firstReport) {
    fragments.forEach((f, pn) => {
      for (const r of f.classifiedRows) {
        if (r.kind === 'control_subtotal' || r.kind === 'control_total') {
          aggregate.issues.push({
            row: r.rowNo,
            kind: 'control_row',
            message: `[Page ${pn + 1}] 控制行（${r.matchedTags.join('+') || r.kind}）已排除在勾稽之外，不计入 comparableRows / passedRows`,
          });
        }
      }
    });
  }

  const comparableRows = aggregate.comparableRows;
  const passRate = comparableRows > 0 ? aggregate.passedRows / comparableRows : null;
  const coverageRate = totalTxBase > 0 ? Math.min(1, comparableRows / totalTxBase) : 0;
  const anyDetected = perPage.some((pr) => pr.report.detectedAsLedger);
  const semanticsWorst: LedgerValidationReport['semanticsStatus'] = (() => {
    if (perPage.every((p) => p.report.semanticsStatus === 'confirmed')) return 'confirmed';
    if (perPage.some((p) => p.report.semanticsStatus === 'ambiguous')) return 'ambiguous';
    if (perPage.some((p) => p.report.semanticsStatus === 'inferred')) return 'inferred';
    return 'ambiguous';
  })();

  // P1-2：逐页 cellVerification 合并到多页 report（key 前缀 P{N}_，避免跨页行号冲突）
  const cellVerification: Record<string, CellVerification> = {};
  perPage.forEach((pr, pn) => {
    const per = pr.report.cellVerification ?? pr.page.cellVerification;
    if (!per) return;
    const prefix = `P${pn + 1}_`;
    for (const key of Object.keys(per)) {
      cellVerification[prefix + key] = per[key];
    }
    // 同步写回每个 page（通常 ledgerValidationReport 已写，保险起见不覆盖）
    if (!pr.page.cellVerification) pr.page.cellVerification = per;
  });
  const fieldQuality: LedgerFieldQuality | undefined = (() => {
    const fqs = perPage
      .map((p) => p.report.fieldQuality)
      .filter((v): v is LedgerFieldQuality => !!v);
    if (fqs.length === 0) return undefined;
    const avg = (k: keyof LedgerFieldQuality) => {
      const arr = fqs.map((f) => f[k]).filter((v) => typeof v === 'number') as number[];
      if (!arr.length) return 0;
      return arr.reduce((s, v) => s + v, 0) / arr.length;
    };
    const passRates = fqs.map((f) => f.reconciliationPassRate).filter((v): v is number => typeof v === 'number');
    return {
      coordinateCoverage: avg('coordinateCoverage'),
      headerConfidence: avg('headerConfidence'),
      rowStructureConfidence: avg('rowStructureConfidence'),
      amountParseRate: avg('amountParseRate'),
      balanceParseRate: avg('balanceParseRate'),
      reconciliationCoverage: avg('reconciliationCoverage'),
      reconciliationPassRate: passRates.length ? passRates.reduce((s, v) => s + v, 0) / passRates.length : null,
      ambiguousMoneyCells: fqs.reduce((s, f) => s + f.ambiguousMoneyCells, 0),
      unreadableMoneyCells: fqs.reduce((s, f) => s + f.unreadableMoneyCells, 0),
    };
  })();

  // 合并 perPage 的 rowsByKind：跨页连号 rowGlobal，并选最长 header 做总 markdownHeader
  const mergedRows: StatementLedgerRow[] = [];
  let gNo = 0;
  for (let i0 = 0; i0 < perPage.length; i0++) {
    const pr = perPage[i0];
    const rowsOne = pr.report.rowsByKind ?? [];
    for (const r of rowsOne) {
      gNo++;
      mergedRows.push({ ...r, rowGlobal: gNo });
    }
  }
  let mergedHeader: string[] | undefined;
  for (const pr of perPage) {
    if (!mergedHeader || (pr.report.markdownHeader?.length ?? 0) > mergedHeader.length) {
      mergedHeader = pr.report.markdownHeader;
    }
  }
  const mergedCv: Record<string, CellVerification> = {};
  for (let i0 = 0; i0 < perPage.length; i0++) {
    const pr = perPage[i0];
    const pn = i0 + 1;
    const cv = pr.report.cellVerification ?? {};
    for (const k of Object.keys(cv)) {
      mergedCv[`P${pn}_${k}`] = cv[k];
    }
  }

  return {
    detectedAsLedger: anyDetected,
    comparableRows,
    passedRows: aggregate.passedRows,
    failedRows: aggregate.failedRows + cross.fails,
    insufficientRows: aggregate.insufficientRows,
    passRate,
    coverageRate,
    longestPassingChain: aggregate.longest,
    crossPageStatus: cross.status,
    semanticsStatus: semanticsWorst,
    issues: aggregate.issues,
    cellVerification: Object.keys(mergedCv).length ? mergedCv : undefined,
    fieldQuality,
    rowsByKind: mergedRows.length ? mergedRows : undefined,
    markdownHeader: mergedHeader,
  };
}

/**
 * 勾稽报告：替代「只返回整数 verified」的老接口（P0-3）。
 * 老的 ledgerVerificationScore 仍保留给 ocr-service 择优 V2 等既有调用，避免一次牵动太多。
 */
export function ledgerValidationReport(page: OcrPage): LedgerValidationReport {
  const blocks = page.blocks ?? [];
  if (blocks.length < 4) return buildLedgerValidationReport({ totalRows: 0, verified: 0, mismatches: [], unverifiableRows: [] }, { semanticsStatus: 'ambiguous' });
  const rows = clusterRows(blocks);
  const info = detectLedgerColumns(rows);
  if (!info) {
    return buildLedgerValidationReport(
      { totalRows: 0, verified: 0, mismatches: [], unverifiableRows: [] },
      { semanticsStatus: 'ambiguous' },
    );
  }
  const { headerIdx, cols } = info;
  const dateCol = cols.find((c) => c.kind === 'date');
  const amountCol = cols.find((c) => c.kind === 'amount');
  const balanceCol = cols.find((c) => c.kind === 'balance');
  if (!dateCol || !amountCol || !balanceCol) {
    return buildLedgerValidationReport(
      { totalRows: 0, verified: 0, mismatches: [], unverifiableRows: [] },
      { semanticsStatus: 'ambiguous' },
    );
  }

  // ============================================================
  // P2-3b：先组装 rowsByKind + markdownRows，再做三维准入过滤（不依赖勾稽结果）
  // red 的 AMOUNT/DATE/BALANCE → 从 markdown 行里清空，进入勾稽后该列值自动无效 → 该行被判 unverifiable
  // 不会让错值（如 "1 900 00" 解析成 1900 实际应为 190000）拉偏余额方程
  // ============================================================
  const rowsDataIndices: number[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    if (ri === headerIdx) continue;
    const row = rows[ri];
    const amountColObj = cols.find((c) => c.kind === 'amount');
    if (!amountColObj) continue;
    const amountText = row
      .filter((b) => b.x >= amountColObj.x0 && b.x < amountColObj.x1)
      .map((b) => b.text)
      .join(' ')
      .trim();
    if (!amountText) continue;
    rowsDataIndices.push(ri);
  }
  const markdownHeader = ['日期', '摘要', '金额', '余额'];
  const markdownRows: string[][] = [];
  const rowsByKind: VerifyLedgerPageInput['rowsByKind'] = [];
  const rowNumbers1Based: number[] = [];
  const kindOrder: LedgerColKind[] = ['date', 'summary', 'amount', 'balance'];
  for (let i = 0; i < rowsDataIndices.length; i++) {
    const ri = rowsDataIndices[i];
    const row = rows[ri];
    const byKind: VerifyLedgerPageInput['rowsByKind'][number] = {};
    const mkDataRow: string[] = [];
    for (const kind of kindOrder) {
      const col = cols.find((c) => c.kind === kind);
      const blks = col ? row.filter((b) => b.x >= col.x0 && b.x < col.x1).sort((a, b) => a.x - b.x) : [];
      if (blks.length) byKind[kind] = blks;
      const raw = blks.map((b) => b.text).join(' ').trim();
      // 三维准入：date/amount/balance 三列 red 直接置空（勾稽会跳过该行）
      let text = raw;
      if (kind !== 'summary') {
        const pre = preAssessCellPreColor({ page, cols, colKind: kind, blocks: blks });
        if (pre.preColor === 'red') text = '';
      }
      mkDataRow.push(text);
    }
    rowsByKind.push(byKind);
    markdownRows.push(mkDataRow);
    rowNumbers1Based.push(i + 1);
  }

  // 基于过滤后的 markdownRows 生成 lines，喂给 checkLedgerBalance 做余额勾稽
  const lines: string[] = ['| 日期 | 摘要 | 金额 | 余额 |'];
  for (const rowArr of markdownRows) {
    // amount 列必须非空才算数据行（red cell 过滤后已空的整行会被 continue，和旧 cellOf(amountCol)=='' 行为一致）
    const amount = (rowArr[2] ?? '').trim();
    if (!amount) continue;
    lines.push(`| ${rowArr[0] ?? ''} | ${rowArr[1] ?? ''} | ${amount} | ${rowArr[3] ?? ''} |`);
  }
  const check = checkLedgerBalance(lines.join('\n'));

  // P1-1b：勾稽前确认账务语义；只有 semantics.confidence==='confirmed' 时 report 才能出 confirmed，
  // 否则 ambiguous/inferred 仅作候选排序（防止"余额增减方向搞反 → 算平 → 错误事实进舱"）。
  const semantics: LedgerSemantics = inferLedgerSemantics({ kind: 'markdown', transcript: lines.join('\n') });
  const semanticsStatus = (() => {
    switch (semantics.confidence) {
      case 'confirmed':
        return 'confirmed' as const;
      case 'inferred':
        return 'inferred' as const;
      default:
        return 'ambiguous' as const;
    }
  })();
  const report = buildLedgerValidationReport(check, { totalRows: rows.length - 1, semanticsStatus });

  const reconciliation = {
    passedRows: (() => {
      // check 里 mismatch/unverifiableRows 是原 markdown 解析的行号（从 1 开始），passedRows = 可比较 - 失败
      const failSet = new Set(check.mismatches.map((m) => m.row));
      const unverifSet = new Set(check.unverifiableRows);
      const passed: number[] = [];
      const upTo = Math.max(check.totalRows, ...rowNumbers1Based);
      for (let r = 1; r <= upTo; r++) {
        if (!failSet.has(r) && !unverifSet.has(r)) passed.push(r);
      }
      return passed.slice(0, check.verified);
    })(),
    failedRows: check.mismatches.map((m) => m.row),
    unverifiableRows: check.unverifiableRows,
  };
  const verified = verifyLedgerPageCells({
    page,
    rowsByKind,
    cols,
    rowNumbers: rowNumbers1Based,
    reconciliation,
    semantics,
    markdownHeader,
    markdownRows,
  });
  // 写回 page.cellVerification（证据链保存在 OcrPage 骨架，供事实舱后续消费）
  page.cellVerification = verified.map;
  report.cellVerification = verified.map;
  report.fieldQuality = summarizeFieldQuality(verified.cells);
  // P2-3d：OcrPage.ledgerFieldQuality 同步写入（跨页报告 buildMultiPageLedgerReport 会单页聚合）
  page.ledgerFieldQuality = report.fieldQuality;
  page.ledgerSemantics = semantics;
  page.ledgerValidationReport = report;
  // P2-4：单页报告把结构化流水行和表头挂到 report，消费方共用
  attachStatementLedgerRows({
    page,
    report,
    pageIndex0Based: 0,
    markdownHeader,
    markdownRows,
    rowNumbers1Based,
    semantics,
    cols,
  });
  return report;
}

/** 表头列类型与归一化 x 边界（Vision 坐标系，原点左下、x 向右） */
export type LedgerColKind = 'date' | 'summary' | 'amount' | 'balance';
export interface LedgerCol { kind: LedgerColKind; x0: number; x1: number }
export interface LedgerColumnInfo { headerIdx: number; cols: LedgerCol[] }

/** 识别表头行并定义列边界：表头块按 x 排序，以相邻块中点为列边界。
 *  供余额勾稽（列归属）与列带裁剪（金额/余额列隔离）复用。 */
export function detectLedgerColumns(rows: OcrBlock[][]): LedgerColumnInfo | null {
  if (rows.length < 3) return null;
  // 表头行：同时含 日期 与 余额（或金额）关键词
  const headerIdx = rows.findIndex(
    (row) =>
      row.some((b) => /日期|时间/.test(b.text)) &&
      row.some((b) => /余额|结余/.test(b.text)),
  );
  if (headerIdx < 0) return null;

  const header = [...rows[headerIdx]].sort((a, b) => a.x - b.x);
  const cols: LedgerCol[] = [];
  for (let i = 0; i < header.length; i++) {
    const t = header[i].text;
    let kind: LedgerColKind | null = null;
    if (/日期|时间/.test(t)) kind = 'date';
    else if (/余额|结余/.test(t)) kind = 'balance';
    else if (/金额|发生额|入金|出金|收入|支出/.test(t)) kind = 'amount';
    else if (/摘要|说明|对方|商户/.test(t)) kind = 'summary';
    if (!kind) continue;
    const x1 = i < header.length - 1 ? (header[i + 1].x + header[i].x) / 2 : 1;
    cols.push({ kind, x0: header[i].x, x1 });
  }
  return { headerIdx, cols };
}
