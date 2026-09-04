/**
 * P1-2：逐格 CellVerification 五维评估（法律证据链每格可追溯）
 *
 * 设计：
 *  - 每个可识别金额/余额/日期/摘要格 → 唯一 key `R{1-based row}_C{colKind}` 或 `R{row}_C{0-based col}`
 *    → CellVerification 写入 `OcrPage.cellVerification`（Record<string, CellVerification>）
 *  - 五个维度分别打级：
 *      visual       「骨架候选一致性」：有 Vision blocks.confidence 高 + 若存在云端 candidate 一致 → confirmed
 *      structural   「列归属」：该行该列能稳定落入 layout cols 的 x 范围，不越界 → confirmed
 *      normalization「格式/数值」：日期/金额/余额能被标准解析器解析且结果唯一 → valid（金额：能转成整数分；日期：能转成 YYYY-MM-DD）
 *      reconciliation「勾稽结果」：若这格值参与勾稽并确实算平 → pass；参与但算错 → fail；不参与（摘要列等）→ not_applicable
 *      human        「人工复核」：P1 默认 unreviewed（仅做结构定义 + 将来工具写）
 *  - 最终 aggregate：通过五维合成 green / yellow / red。green 允许进绿色事实舱；yellow 候选；red 需复核。
 *
 * 放 statement/ 舱内（纯算，不做 I/O，不 throw）；调用方由 core/ledger.ts 在勾稽后写入 OcrPage。
 */

import type { OcrPage, OcrBlock, CellVerification, CellCandidate } from '../core/layout-score';
import { cleanMoneyRaw, toMinorUnit } from '../shared/money';
import type { LedgerCol, LedgerColKind } from '../core/ledger';
import {
  classifyStatementRows,
  filterReconciliationRows,
  type ClassifiedRow,
  type StatementRowKind,
} from './control-rows';
import type { LedgerSemantics } from '../shared/types';

export type CellColor = 'green' | 'yellow' | 'red';

export interface VerifiedCell {
  key: string;
  row1Based: number;
  colKind: LedgerColKind | 'unknown';
  raw: string;
  normalizedText?: string;
  block?: OcrBlock;
  candidate?: CellCandidate;
  verification: CellVerification;
  color: CellColor;
}

// ============================================================
// 单个维度的评估（三维准入可单独调用，不依赖 reconciliation 结果）
// ============================================================

export function assessVisual(opts: {
  block?: OcrBlock;
  candidate?: CellCandidate;
  raw: string;
}): CellVerification['visual'] {
  const { block, candidate, raw } = opts;
  // Vision 置信度：Vision 没给出 conf 时默认 0.85 中性
  const visionConf = block?.confidence ?? (block ? 0.85 : 0.4);
  let hasOnlineConsensus = true;
  if (candidate) {
    const cv = cleanTextForCompare(candidate.value);
    const rv = cleanTextForCompare(raw);
    hasOnlineConsensus = cv === rv;
    if (!hasOnlineConsensus && candidate.confidence !== undefined) {
      // 在线候选值也有问题，即使 Vision 有也判 ambiguous
    }
  }
  if (visionConf >= 0.9 && (!candidate || hasOnlineConsensus)) return 'confirmed';
  if (visionConf >= 0.55) return 'ambiguous';
  return 'unreadable';
}

export function cleanTextForCompare(s: string): string {
  return String(s ?? '')
    .replace(/[,，¥￥\s]/g, '')
    .replace(/O/g, '0')
    .replace(/l/g, '1')
    .replace(/I/g, '1')
    .trim();
}

export function assessStructural(opts: {
  block?: OcrBlock;
  cols: LedgerCol[];
  colKind: LedgerColKind;
}): CellVerification['structural'] {
  if (!opts.block) return 'unassigned';
  const col = opts.cols.find((c) => c.kind === opts.colKind);
  if (!col) return 'unassigned';
  const x = opts.block.x;
  const center = x + opts.block.w / 2;
  const inside = x >= col.x0 && x + opts.block.w <= col.x1 + 1e-6; // 允许微小浮点容差
  const centerInside = center >= col.x0 && center <= col.x1;
  if (inside || centerInside) return 'confirmed';
  // 边缘贴着列边界（相邻列冲突）判 ambiguous
  const gap = Math.min(Math.abs(center - col.x0), Math.abs(center - col.x1));
  if (gap < 0.02) return 'ambiguous';
  return 'unassigned';
}

export function assessNormalization(opts: {
  raw: string;
  colKind: LedgerColKind;
}): { status: CellVerification['normalization']; normalizedText?: string; valueCent?: number; dateISO?: string } {
  const raw = (opts.raw ?? '').trim();
  if (!raw) return { status: 'invalid' };
  switch (opts.colKind) {
    case 'date':
      return dateAssessment(raw);
    case 'amount':
    case 'balance':
    case 'income' as LedgerColKind:
    case 'expense' as LedgerColKind: {
      const cleaned = cleanMoneyRaw(raw);
      const cent = toMinorUnit(raw);
      if (cleaned === null || cent === null) return { status: 'invalid' };
      // 检查是否含非货币字符混进（金额列出现日期字符）
      if (/\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(raw)) return { status: 'ambiguous', normalizedText: cleaned, valueCent: cent };
      return { status: 'valid', normalizedText: cleaned, valueCent: cent };
    }
    case 'summary':
      // 摘要列没有归一化形态要求，非空即可
      if (raw.length === 0) return { status: 'invalid' };
      // 摘要里混进全金额/全日期字符，极可能列错位 → ambiguous
      if (/^[¥￥]?\s*\d[\d,，.]*$/.test(raw) || /^\d{4}[-./年]\d{1,2}[-./月]\d{1,2}/.test(raw)) {
        return { status: 'ambiguous', normalizedText: raw };
      }
      return { status: 'valid', normalizedText: raw };
    default:
      return { status: 'ambiguous', normalizedText: raw };
  }
}

function dateAssessment(raw: string): {
  status: CellVerification['normalization'];
  normalizedText?: string;
  dateISO?: string;
} {
  const s = raw.trim();
  // 常见中文格式：YYYY年M月D日 / YYYY.MM.DD / YYYY/MM/DD / YYYY-MM-DD / YYYYMMDD
  const variants: Array<{ re: RegExp; fmt: (m: RegExpMatchArray) => string | null }> = [
    {
      re: /^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/,
      fmt: (m) => iso(m[1], m[2], m[3]),
    },
    {
      re: /^(\d{4})(\d{2})(\d{2})$/,
      fmt: (m) => iso(m[1], m[2], m[3]),
    },
    {
      re: /^(\d{1,2})[-./月](\d{1,2})[日]?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?$/,
      fmt: (m) => {
        // 缺少年份 → 没法唯一化 → ambiguous
        const y = new Date().getFullYear().toString();
        return iso(y, m[1], m[2]) ?? null; // ambiguous 由 caller 在无年份时再设
      },
    },
  ];
  for (const { re, fmt } of variants) {
    const m = s.match(re);
    if (m) {
      const isoStr = fmt(m);
      if (!isoStr) return { status: 'ambiguous', normalizedText: s };
      // 缺少年份（第 3 个正则）→ 归一化 ambiguous
      if (/^(\d{1,2})[-./月]/.test(s) && !/\d{4}/.test(s)) {
        return { status: 'ambiguous', normalizedText: s, dateISO: isoStr };
      }
      return { status: 'valid', normalizedText: isoStr, dateISO: isoStr };
    }
  }
  return { status: 'invalid' };
}

function iso(y: string, mo: string, d: string): string | null {
  const yy = Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(yy, mm - 1, dd);
  if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${yy}-${pad(mm)}-${pad(dd)}`;
}

export function pickBestBlock(blocks?: OcrBlock[]): { block?: OcrBlock; raw: string } {
  if (!blocks || blocks.length === 0) return { raw: '' };
  // 选置信度最高的 block 作为代表（若 conf 都没值），再把所有 blocks 文本拼起来做 raw（多格组成的金额字串）
  const all = blocks
    .slice()
    .sort((a, b) => a.x - b.x)
    .map((b) => b.text)
    .join(' ')
    .trim();
  const bestBlock = blocks.reduce<OcrBlock | undefined>((acc, b) => {
    if (!acc) return b;
    const bc = b.confidence ?? 0.6;
    const ac = acc.confidence ?? 0.6;
    return bc > ac ? b : acc;
  }, undefined);
  return { block: bestBlock, raw: all };
}

export function candidateForBlocks(page: OcrPage, blocks: OcrBlock[]): CellCandidate | undefined {
  // 简单策略：若 page.candidates 存在且只一条，即整页级候选；不做逐格 candidate 匹配（P2 再做）
  void blocks;
  if (!page.candidates || page.candidates.length === 0) return undefined;
  return page.candidates[0];
}

/** 三维准入预评估（visual + structural + normalization）——勾稽方程前即可用：
 *  green  ：三维均 confirmed/confirmed/valid → 允许作为事实进方程，置信度高
 *  yellow ：至少一项 ambiguous，无最差档 → 参与勾稽，但 fieldQuality 中算作 ambiguousMoneyCells（crossPage 会软化）
 *  red    ：至少一项处于最差档（unreadable/unassigned/invalid）→ 勾稽前置空，不进方程，避免错值把勾稽拉偏
 */
export function preAssessCellPreColor(opts: {
  page: OcrPage;
  cols: LedgerCol[];
  colKind: LedgerColKind;
  blocks?: OcrBlock[];
}): {
  visual: CellVerification['visual'];
  structural: CellVerification['structural'];
  normalization: CellVerification['normalization'];
  normalizedText?: string;
  raw: string;
  block?: OcrBlock;
  candidate?: CellCandidate;
  preColor: CellColor;
} {
  const { block, raw } = pickBestBlock(opts.blocks);
  const candidate = candidateForBlocks(opts.page, opts.blocks ?? []);
  const visual = assessVisual({ block, candidate, raw });
  const structural = assessStructural({ block, cols: opts.cols, colKind: opts.colKind });
  const norm = assessNormalization({ raw, colKind: opts.colKind });
  // 三维聚合：等价于 aggregateColor({reconciliation:'not_applicable', human:'unreviewed'})
  const redTriggers: boolean[] = [
    visual === 'unreadable',
    structural === 'unassigned',
    norm.status === 'invalid',
  ];
  const yellowTriggers: boolean[] = [
    visual === 'ambiguous',
    structural === 'ambiguous',
    norm.status === 'ambiguous',
  ];
  const preColor: CellColor = redTriggers.some(Boolean) ? 'red' : (yellowTriggers.some(Boolean) ? 'yellow' : 'green');
  return {
    visual,
    structural,
    normalization: norm.status,
    normalizedText: norm.normalizedText,
    raw,
    block,
    candidate,
    preColor,
  };
}

// ============================================================
// 主入口：给单页 OcrPage 生成逐格 CellVerification Map（可直接写入 page.cellVerification）
// ============================================================

export interface VerifyLedgerPageResult {
  /** 直接可塞进 OcrPage.cellVerification */
  map: Record<string, CellVerification>;
  cells: VerifiedCell[];
  /** 参与勾稽成功的行集合（1-based）→ 传入用于 reconciliation 维度 */
  reconciliationPassRows: Set<number>;
  reconciliationFailRows: Set<number>;
  reconciliationUnverifiableRows: Set<number>;
}

/** 行级数据结构（由调用方基于行聚类 + 列检测后组装）：
 *  rows[i][kind] = 对应的 OcrBlock 列表（属于该行该 kind 的所有 block 按 x 排序）。 */
type RowBlocks = Partial<Record<LedgerColKind, OcrBlock[]>>;

export interface VerifyLedgerPageInput {
  page: OcrPage;
  /** 行级 blocks：rows[i] 是该行的 { date/summary/amount/balance → blocks[] }；i=0 对应第一行数据（不含表头行） */
  rowsByKind: RowBlocks[];
  /** 列定义：传给 structural 评估用 */
  cols: LedgerCol[];
  /** 行对应的 1-based 行号（如果与 rowsByKind 的索引+1 不同则显式传） */
  rowNumbers?: number[];
  /** 勾稽结果：用于 reconciliation 维度；可从 checkLedgerBalance 结果传入 */
  reconciliation: {
    passedRows: number[];
    failedRows: number[];
    unverifiableRows: number[];
  };
  /** 行分类：若已做过 classifyStatementRows 传入可减少重复；否则本函数内部生成 */
  classified?: ClassifiedRow[];
  semantics: Pick<LedgerSemantics, 'controlRowPolicy'>;
  /** 调用方生成的 Markdown 数据行（用于分类） */
  markdownHeader: string[];
  markdownRows: string[][];
}

function rowKey(row: number) { return `R${row}`; }
function cellKey(row: number, kind: LedgerColKind | string) { return `R${row}_${String(kind).toUpperCase()}`; }

export function verifyLedgerPageCells(input: VerifyLedgerPageInput): VerifyLedgerPageResult {
  const { page, rowsByKind, cols, semantics, markdownHeader, markdownRows } = input;
  const rowNumbers = input.rowNumbers ?? rowsByKind.map((_, i) => i + 1);
  const classified = input.classified ?? classifyStatementRows({
    header: markdownHeader,
    rows: markdownRows,
    semantics,
  });
  const filtered = new Map<number, ClassifiedRow>();
  for (const r of filterReconciliationRows(classified, semantics.controlRowPolicy)) {
    filtered.set(r.rowNo, r);
  }
  const passRows = new Set(input.reconciliation.passedRows);
  const failRows = new Set(input.reconciliation.failedRows);
  const unverifRows = new Set(input.reconciliation.unverifiableRows);

  const cells: VerifiedCell[] = [];
  const map: Record<string, CellVerification> = {};

  const kinds: LedgerColKind[] = ['date', 'summary', 'amount', 'balance'];
  for (let i = 0; i < rowsByKind.length; i++) {
    const row = rowsByKind[i];
    const rowNo = rowNumbers[i];
    const classifiedRow = classified.find((r) => r.rowNo === rowNo);
    const rowClass = classifiedRow?.kind ?? 'transaction';
    // 参与勾稽的行（filtered 有）+ non-tx 控制行仍然填五维，但 reconciliation = not_applicable
    const participatesInReconciliation =
      filtered.has(rowNo) && rowClass === 'transaction';
    for (const kind of kinds) {
      const blocks = row[kind];
      const { block, raw } = pickBestBlock(blocks);
      const candidate = candidateForBlocks(page, blocks ?? []);

      const visual = assessVisual({ block, candidate, raw });
      const structural = assessStructural({ block, cols, colKind: kind });
      const norm = assessNormalization({ raw, colKind: kind });
      let reconciliation: CellVerification['reconciliation'] = 'not_applicable';
      if (participatesInReconciliation) {
        if (kind === 'amount' || kind === 'balance') {
          if (passRows.has(rowNo)) reconciliation = 'pass';
          else if (failRows.has(rowNo)) reconciliation = 'fail';
          else if (unverifRows.has(rowNo)) reconciliation = 'insufficient_data';
          else reconciliation = 'not_applicable';
        } else if (kind === 'date') {
          // 日期列不参与勾稽公式本身，但如果行算平就算 pass（间接佐证日期有效）
          if (passRows.has(rowNo)) reconciliation = 'pass';
          else if (failRows.has(rowNo)) reconciliation = 'fail';
          else reconciliation = 'not_applicable';
        }
      } else {
        // opening/closing 等控制行的余额列 → 只算 insufficient_data（参与锚点不参与公式）
        if (rowClass === 'opening_balance' || rowClass === 'closing_balance') {
          if (kind === 'balance') reconciliation = 'insufficient_data';
        }
      }
      const human: CellVerification['human'] = 'unreviewed';

      const verification: CellVerification = {
        visual,
        structural,
        normalization: norm.status,
        reconciliation,
        human,
      };
      const color = aggregateColor(verification);
      const key = cellKey(rowNo, kind);
      cells.push({
        key,
        row1Based: rowNo,
        colKind: kind,
        raw,
        normalizedText: norm.normalizedText,
        block,
        candidate,
        verification,
        color,
      });
      map[key] = verification;
    }
    // 行级 key：R{row} → 合成一个行的「最差色」summary（方便前端快速按行着色）
    const rowCells = cells.slice(-kinds.length);
    const worst = worstColor(rowCells.map((c) => c.color));
    map[rowKey(rowNo)] = {
      visual: worst === 'red' ? 'unreadable' : worst === 'yellow' ? 'ambiguous' : 'confirmed',
      structural: worst === 'red' ? 'unassigned' : worst === 'yellow' ? 'ambiguous' : 'confirmed',
      normalization: worst === 'red' ? 'invalid' : worst === 'yellow' ? 'ambiguous' : 'valid',
      reconciliation: worst === 'red' ? 'fail' : (passRows.has(rowNo) ? 'pass' : (failRows.has(rowNo) ? 'fail' : 'not_applicable')),
      human: 'unreviewed',
    };
    void rowClass;
  }

  return {
    map,
    cells,
    reconciliationPassRows: passRows,
    reconciliationFailRows: failRows,
    reconciliationUnverifiableRows: unverifRows,
  };
}

export function aggregateColor(v: CellVerification): CellColor {
  // 五个维度的「红化门槛」：任何一维处于最差档 → 有 red 风险
  const redTriggers: boolean[] = [
    v.visual === 'unreadable',
    v.structural === 'unassigned',
    v.normalization === 'invalid',
    v.reconciliation === 'fail',
    v.human === 'rejected' || v.human === 'unreadable',
  ];
  const yellowTriggers: boolean[] = [
    v.visual === 'ambiguous',
    v.structural === 'ambiguous',
    v.normalization === 'ambiguous',
    v.reconciliation === 'insufficient_data',
    v.human === 'unreviewed' || v.human === 'confirmed_from_image',
  ];
  if (redTriggers.some(Boolean)) return 'red';
  if (yellowTriggers.some(Boolean)) return 'yellow';
  return 'green';
}

export function worstColor(colors: CellColor[]): CellColor {
  if (colors.some((c) => c === 'red')) return 'red';
  if (colors.some((c) => c === 'yellow')) return 'yellow';
  return 'green';
}

// ============================================================
// 便捷：把 VerifiedCell[]（按 ledger 分类）汇总成 LedgerFieldQuality（专家建议 P2 画像结构，
// P1 先落地基本项，P2 再扩展 PageQualityProfile 的视觉维度）
// ============================================================
export function summarizeFieldQuality(cells: VerifiedCell[]): {
  coordinateCoverage: number;
  headerConfidence: number;
  rowStructureConfidence: number;
  amountParseRate: number;
  balanceParseRate: number;
  reconciliationCoverage: number;
  reconciliationPassRate: number | null;
  ambiguousMoneyCells: number;
  unreadableMoneyCells: number;
} {
  const pick = (kind: LedgerColKind) => cells.filter((c) => c.colKind === kind);
  const amounts = pick('amount');
  const balances = pick('balance');
  const dates = pick('date');
  const all = cells.length;
  const coordOk = cells.filter((c) => (c.block?.confidence ?? 0) >= 0.55).length;
  const structOk = cells.filter((c) => c.verification.structural === 'confirmed').length;
  const normOk = (cs: VerifiedCell[]) => cs.filter((c) => c.verification.normalization === 'valid').length;
  const recoApp = cells.filter((c) => c.verification.reconciliation !== 'not_applicable' && c.verification.reconciliation !== 'insufficient_data');
  const recoPass = recoApp.filter((c) => c.verification.reconciliation === 'pass').length;
  const money = [...amounts, ...balances];
  return {
    coordinateCoverage: all > 0 ? coordOk / all : 0,
    headerConfidence: dates.length > 0 && amounts.length > 0 && balances.length > 0 ? 1 : 0.5,
    rowStructureConfidence: all > 0 ? structOk / all : 0,
    amountParseRate: amounts.length > 0 ? normOk(amounts) / amounts.length : 0,
    balanceParseRate: balances.length > 0 ? normOk(balances) / balances.length : 0,
    reconciliationCoverage: recoApp.length / Math.max(1, amounts.length + balances.length),
    reconciliationPassRate: recoApp.length > 0 ? recoPass / recoApp.length : null,
    ambiguousMoneyCells: money.filter((c) => c.color === 'yellow').length,
    unreadableMoneyCells: money.filter((c) => c.color === 'red').length,
  };
}

export type { StatementRowKind };
