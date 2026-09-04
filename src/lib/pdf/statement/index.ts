/**
 * 流水事实舱（Ledger Facts Capsule）
 *
 * P0 阶段：占位舱口 + 重新导出核心 ledger 工具，给未来 P1 新增的 5 个模块预留单一入口。
 * P1 阶段：在这里 export { parseBankStatement } 等顶级 API，供主链路在「检测为流水页」时对接。
 *
 * 设计约定（太空舱边界）：
 * 1) 本目录**不得直接 import** 任何宿主项目内部类型（如 settings、model-tags、egress-audit 等）；
 *    所有外部依赖通过调用方传入的 `StatementDeps` 注入。
 * 2) 本目录只做「算与证」（结构恢复、金额定点、勾稽、逐格状态合成），不做「读」（不直接 Vision、
 *    不直接 fetch 在线 OCR、不 exec Swift/Python）——读的结果由 core/ 层作为纯数据传入。
 * 3) 舱内算法错误不允许抛 throw 返回结果失败：统一用 report.issues 呈现。舱外调用方负责写入日志与告警。
 */

export type {
  LedgerSemantics,
  LedgerValidationReport,
  LedgerIssue,
  LedgerFieldQuality,
  OCRExecutionPlan,
  OcrEngineKind,
  OcrStopPolicy,
  PageRoute,
  PageQualityProfile,
} from '../shared/types';
export { toMinorUnit, cleanMoneyRaw, reconcile, formatMinorUnit } from '../shared/money';

// P1-1a：账务语义确认（事实舱算证层的入口 API）
export { inferLedgerSemantics, parseMarkdownTable, inferLedgerSemanticsFromRows } from './semantics';
export type { SemanticsInput } from './semantics';

// P1-2：逐格 CellVerification（五维状态 + green/yellow/red 聚合）
export {
  verifyLedgerPageCells,
  aggregateColor,
  worstColor,
  summarizeFieldQuality,
  // 三维准入（勾稽方程前就可用，green/yellow/red → red 不进方程，yellow 参与但 crossPage 判定软化）
  preAssessCellPreColor,
  assessVisual,
  assessStructural,
  assessNormalization,
  pickBestBlock,
  candidateForBlocks,
  cleanTextForCompare,
} from './cell-verification';
export type {
  CellColor,
  VerifiedCell,
  VerifyLedgerPageResult,
  VerifyLedgerPageInput,
} from './cell-verification';

export {
  classifyRow,
  classifyStatementRows,
  filterReconciliationRows,
  crossPageReconciliation,
} from './control-rows';
export type {
  StatementRowKind,
  ClassifiedRow,
  PageLedgerFragment,
  CrossPageReconciliation,
} from './control-rows';

// 把 core/ 内已经可复用的纯计算工具也通过舱口统一透出，方便 statement-detector/layout/... 新文件调用：
export {
  clusterRows,
  isLedgerLike,
  detectLedgerColumns,
  checkLedgerBalance,
  ledgerValidationReport,
  buildLedgerValidationReport,
  buildMultiPageLedgerReport,
} from '../core/ledger';
export type { LedgerBalanceCheck, LedgerCol, LedgerColKind, LedgerColumnInfo } from '../core/ledger';
export { estimateColumns, coverage, judgeLayoutComplexity, isComplexPage } from '../core/layout-score';
export type { OcrPage, OcrBlock, CellCandidate, CellVerification, OcrUpgradeChain } from '../core/layout-score';
