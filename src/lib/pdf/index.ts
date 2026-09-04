/**
 * BobWork OCR / PDF 解析 · 唯一对外入口（太空舱式统一对接端口）。
 *
 * 项目的任何其他模块（chat route、tools.ts、api/ocr、wechat bridge）都应从本文件 import，
 * 不要直接 `import ... from '@/lib/pdf/core/ocr-service'` 或 `from '@/lib/pdf/bridge'`，
 * 避免 pdf/ 内部重排目录时牵一发动全身。
 *
 * 旧路径（`@/lib/pdf/layout-score` 等）仍然可用，是 re-export 到 core/ 的薄壳，
 * 但新代码务必使用 `@/lib/pdf` 单出口。
 */

/* ---------- 基础入口：预热 / OCR 主服务 ---------- */
export {
  applyPdfBridge,
  PREWARM_MAX_PAGES,
} from './core/bridge';

export {
  ocrFile,
  type OcrServiceOptions,
  type OcrUpgrade,
  type OcrPageResult,
  type OcrServiceResult,
} from './core/ocr-service';

/* ---------- 核心计算/判定工具（由舱外其他代码复用）---------- */
export {
  qualityScore,
  invalidChineseRatio,
  hasPathologicalRepetition,
} from './core/quality-scorer';

export {
  extractWithPython,
  extractWithPdfParse,
  type ExtractResult,
} from './core/extractor';

export {
  estimateColumns,
  coverage,
  judgeLayoutComplexity,
  isComplexPage,
} from './core/layout-score';

export type {
  OcrPage,
  OcrBlock,
  CellCandidate,
  CellVerification,
  LayoutComplexity,
  OcrUpgradeChain,
} from './core/layout-score';

export {
  clusterRows,
  isLedgerLike,
  checkLedgerBalance,
  detectLedgerColumns,
} from './core/ledger';

export type {
  LedgerBalanceCheck,
  LedgerCol,
  LedgerColKind,
  LedgerColumnInfo,
} from './core/ledger';

export {
  keyFieldCompleteness,
  type KeyFieldResult as KeyFieldCompleteness,
} from './core/key-fields';

export {
  structuralPostprocess,
} from './core/structural-postprocess';

export {
  scheduleSegments,
  scheduleUniform,
  type TaggedPage,
  type Segment as SegmentPlan,
} from './core/segment-scheduler';

/* ---------- 流水事实舱（P0 预留舱口，P1 启用 parseBankStatement）---------- */
export * as Statement from './statement';

/* ---------- 共享纯协议类型 + 金额定点工具 ---------- */
export * from './shared/money';
export type * from './shared/types';
