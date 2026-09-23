/**
 * 流水事实舱（statement/）与核心 OCR（core/）共用的数据类型。
 * 避免双向 import：所有舱内外共享的协议接口放这里，core 和 statement 都从 shared/types.ts 拿。
 *
 * 注：OcrPage / OcrBlock / CellCandidate / CellVerification 当前仍然实现在
 *     core/layout-score.ts 中（因为 core 有 17 个历史文件已经 import 了它），
 *     这里放的是「新增或独立于版式判定的纯协议类型」，等 P1 稳定后再把 OcrPage 一族也迁过来。
 */

import type { CellVerification } from '../core/layout-score';

/**
 * 流水行分类（T1-1 前实现在 statement/control-rows.ts；statement/ 死代码清除后内联至此，
 * 定义逐字照搬，仅供 StatementLedgerRow.kind 使用）。
 */
export type StatementRowKind =
  | 'transaction'       // 普通交易（参与勾稽）
  | 'control_subtotal'  // 小计/本页合计/本期合计（不参与勾稽）
  | 'control_total'     // 本年累计/总计（不参与勾稽）
  | 'opening_balance'   // 期初余额/承上页：重置 prevBalance，不参与「inc/exp→bal」勾稽
  | 'closing_balance'   // 期末余额/过次页：作为 prevBalance 传递给下一页，不参与 inc/exp 勾稽
  | 'header_repeat'     // 跨页重复表头（跳过）
  | 'separator'         // 纯横线/空行/分隔行
  | 'noise';            // 无法分类的其它噪音行

export type PageRoute = 'coordinate_text' | 'ocr' | 'hybrid' | 'failed';

/** P2-4：流水导出用的结构化行（勾稽后已按行分类 + 金额解析 + 颜色准入）。
 *  算证舱生成后挂在 LedgerValidationReport.rowsByKind 上，消费方（bob-bank-statement
 *  Skill / Excel 导出 / 事实舱写入 / 人工复核清单生成）共用同一组 rows，避免每层
 *  重新写「行聚类 + 列检测 + 控制行分类 + 准入过滤」导致逻辑漂移（Experience 303991）。
 */
export interface StatementLedgerRow {
  /** 全局流水序号（跨页单调递增，1-based）；跨页汇总时有，单页报告可能省略。 */
  rowGlobal?: number;
  /** 所属页 0-based；单页报告恒 0 */
  pageIndex0Based: number;
  /** 页内 1-based 行号；对齐 classifyStatementRows / verifyLedgerPageCells 的 rowNo。 */
  rowPage1Based: number;
  /** 原始文本：经准入过滤（red cell date/amount/balance 已空）后给人看的四/五列文字 */
  dateText: string;
  summaryText: string;
  /** 单列金额模式：对应金额列原文；双列模式时为空字符串。 */
  amountText: string;
  /** 双列收入支出模式：收入列原文；单列模式为空字符串。 */
  incomeText?: string;
  /** 双列收入支出模式：支出列原文；单列模式为空字符串。 */
  expenseText?: string;
  balanceText: string;
  /** 控制行分类（transaction/opening/closing/subtotal/total/header_repeat/separator/noise） */
  kind: StatementRowKind;
  /** 是否被 filterReconciliationRows(semantics.controlRowPolicy) 纳入余额勾稽方程。
   *  transaction 行才可能为 true；其他（控制行/表头重复/噪音）恒 false。 */
  participatesInReconciliation: boolean;
  /** 金额（分整数，仅单列模式有值，正值/负值表达方向）；无法解析为 null。 */
  amountCent: number | null;
  /** 收入列（分整数，双列模式）；仅 amountMode=income_expense_columns 时有值。 */
  incomeCent: number | null;
  /** 支出列（分整数，双列模式）；仅 amountMode=income_expense_columns 时有值。 */
  expenseCent: number | null;
  /** 余额（分整数） */
  balanceCent: number | null;
  /** 准入前/准入后颜色：P2-3b 三维准入（green/yellow/red）+ 五维最终色。
   *  消费方写 Excel 着色/红绿灯直接读。 */
  preColor?: 'green' | 'yellow' | 'red';
  finalColor?: 'green' | 'yellow' | 'red';
}

/** 专家建议的账务语义确认：勾稽前必须先确定；ambiguous 时勾稽只作候选排序，不出绿色 */
export interface LedgerSemantics {
  order: 'ascending' | 'descending';
  balancePosition: 'after_transaction' | 'before_transaction' | 'unknown';
  amountMode: 'income_expense_columns' | 'signed_amount' | 'amount_with_direction';
  debitEffect: 'increase' | 'decrease' | 'unknown';
  creditEffect: 'increase' | 'decrease' | 'unknown';
  controlRowPolicy: 'exclude' | 'include' | 'template_defined';
  source: 'bank_template' | 'header_mapping' | 'equation_inferred' | 'human_confirmed';
  confidence: 'confirmed' | 'inferred' | 'ambiguous';
}

/** 专家建议的勾稽报告：替代整数 verified 计数 */
export interface LedgerIssue {
  row: number;
  kind: 'mismatch' | 'unverifiable' | 'missing_amount' | 'control_row' | 'cross_page_break';
  message: string;
}

export interface LedgerValidationReport {
  detectedAsLedger: boolean;
  comparableRows: number;
  passedRows: number;
  failedRows: number;
  insufficientRows: number;
  passRate: number | null;
  /** comparableRows / totalRows：覆盖度越近 1 越可信 */
  coverageRate: number;
  /** 最长连续勾稽通过链（长度越长越能排除"偶然算平"假阳性） */
  longestPassingChain: number;
  /** P2-3：跨页余额衔接状态。
   *   - pass            所有有数据的衔接对都平
   *   - fail            至少一个衔接对不平（数据可信）
   *   - needs_review    衔接对不平，但参与页 amountParseRate / balanceParseRate / rowStructureConfidence 很差，
   *                     可能是 OCR 错值而非事实冲突，需人工复核（避免扫描件糊页被硬判 fail）
   *   - insufficient_data 有页面没有 opening/closing 或 transaction 余额（扫描空白 / red cell 过滤后无值）
   *   - not_checked     页面数 < 2
   */
  crossPageStatus: 'pass' | 'fail' | 'needs_review' | 'not_checked' | 'insufficient_data';
  semanticsStatus: 'confirmed' | 'inferred' | 'ambiguous';
  issues: LedgerIssue[];
  /** P1-2：逐格状态（key=R{row}_{KIND} 或 R{row} 行汇总），单页报告有；多页报告为每篇合并 map */
  cellVerification?: Record<string, CellVerification>;
  /** P1-2：字段级质量画像，P2 首版指标已落一部分 */
  fieldQuality?: LedgerFieldQuality;
  /** P2-4：结构化流水行（四/五列文本 + 控制行分类 + 金额分整数 + 绿黄红颜色）。
   *  跨页报告 rowGlobal 已连号；单页报告 rowGlobal 省略（= rowPage1Based）。
   *  消费方（Excel / CSV / 事实舱写入 / 复核清单）共用这一组 rows，不要重复解析。 */
  rowsByKind?: StatementLedgerRow[];
  /** 流水表头：当前固定为 ["日期","摘要","金额","余额"] 或 （amountMode=双列时扩展）["日期","摘要","收入","支出","余额"] */
  markdownHeader?: string[];
}

/** 专家建议的流水事实质量画像：独立于通用文档 qualityScore */
export interface LedgerFieldQuality {
  coordinateCoverage: number;
  headerConfidence: number;
  rowStructureConfidence: number;
  amountParseRate: number;
  balanceParseRate: number;
  reconciliationCoverage: number;
  reconciliationPassRate: number | null;
  ambiguousMoneyCells: number;
  unreadableMoneyCells: number;
}

/** 专家建议的页面级复原质量画像：P2 首版先定义结构，暂缓实现 */
export interface PageQualityProfile {
  orientation: 0 | 90 | 180 | 270;
  skewAngle: number | null;
  blurLevel: number;
  illuminationUnevenness: number;
  shadowLevel: number;
  contrast: number;
  noiseLevel: number;
  jpegArtifactLevel: number;
  clippedHighlights: boolean;
  clippedShadows: boolean;
  tableLineInterference: number;
}

/** 在线引擎执行计划：消除文档中 priority 与执行顺序不一致 */
export type OcrEngineKind = 'mac_vision' | 'glm_ocr' | 'online_ocr' | 'vlm';
export type OcrStopPolicy = 'first_non_empty' | 'first_qualified' | 'collect_candidates';
export interface OCRExecutionPlan {
  engines: OcrEngineKind[];
  stopPolicy: OcrStopPolicy;
}

/** 专家建议的「执行上下文」——把 plan + 页级上下文包在一起，算证舱调度纯函数化。
 *  P2-2 先定义结构，ocr-service 把所有在线升级的调用都落到这个 ctx 上执行；
 *  后续 P3 可以直接把 ctx 传给 statement/ 舱内的「择优+绿色准入」纯函数，消除调度散落在 ocrImages 的 if/else。 */
export interface OCRDispatchContext {
  docType?: unknown;
  ocrPlan: OCRExecutionPlan;
  perPageHints: Array<{ index: number; needsEnhance?: boolean; force?: boolean }>;
}
export type { OCRExecutionPlan as OCRPlan }; // 别名：算证舱对外简写
