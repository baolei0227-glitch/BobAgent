/**
 * 版式复杂度判定（纯本地、零成本）
 *
 * 基于本地 OCR 输出的文字块 boundingBox 几何特征，判断页面是否为"纯文字"版式：
 * - 列数：文字块 x 中心聚类 → 多列（≥2 列）判为复杂（表格 / 分栏常见）
 * - 覆盖率：文字块总面积占页面比例过低 → 页面以图片 / 图表为主，判为复杂
 *
 * 判定结果用于路由：
 *   simple  → 直接使用本地 OCR 文字（零成本）
 *   complex → 交给视觉大模型做带版式 / 图标语义的完整解读
 */

export interface OcrBlock {
  text: string;
  /** 识别置信度 0-1（ocr_vision.swift 输出；低于阈值视为疑似手写） */
  confidence?: number;
  /** 归一化坐标 0-1（Vision 坐标系，原点左下） */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 云端 / 二次 OCR 的候选值：永远只挂在本地坐标骨架之下，不得覆盖骨架本身 */
export interface CellCandidate {
  value: string;
  source: 'mac_vision' | 'online_ocr' | 'glm_ocr' | 'vlm';
  sourceVersion?: string;
  /** 仅当候选来源本身提供了坐标才填；在线/VLM 通常为空 */
  bbox?: { x: number; y: number; w: number; h: number };
  confidence?: number;
  reconciliationStatus?: 'pass' | 'fail' | 'not_tested';
}

/** 逐格五维可信状态（P0 预留结构，P1 启用） */
export interface CellVerification {
  visual: 'confirmed' | 'ambiguous' | 'unreadable';
  structural: 'confirmed' | 'ambiguous' | 'unassigned';
  normalization: 'valid' | 'ambiguous' | 'invalid';
  reconciliation: 'pass' | 'fail' | 'not_applicable' | 'insufficient_data';
  human:
    | 'unreviewed'
    | 'confirmed_from_image'
    | 'confirmed_with_reconciliation'
    | 'rejected'
    | 'unreadable';
}

import type { LedgerSemantics, LedgerValidationReport, PageQualityProfile, OCRExecutionPlan, LedgerFieldQuality, OCRDispatchContext } from '../shared/types';

export type OcrUpgradeChain = 'glm-ocr' | 'online-ocr' | 'vlm-upgrade';

export interface OcrPage {
  index: number;
  text: string;
  /**
   * 本地 Vision 坐标骨架：任何情况下**不得清空**。
   * 云端候选通过 candidates 字段挂在骨架之下，evidence 永远回溯到这组 bbox。
   */
  blocks?: OcrBlock[];
  width?: number;
  height?: number;
  /** 表格方向自适应：true = 该页被判定为旋转 90° 扫描，已转置 bbox（ocr_vision.swift 输出） */
  rotated?: boolean;
  /** 像素级表格线统计（ocr_vision.swift 输出） */
  layout?: {
    hLines: number;
    vLines: number;
    hasTableLines: boolean;
  };
  /** P2-1 辅助 orientation / skewAngle / tableLineInterference（来自 Swift 的直接输出）。qualityProfile 是把这组 + Python analyze_image 合并后的专家建议结构。 */
  orientation?: 0 | 90 | 180 | 270;
  skewAngle?: number | null;
  tableLineInterference?: number;
  /** 云端候选文字与配置：页面级；P0 先保存候选，P1 做逐格归并 */
  candidates?: CellCandidate[];
  /** 已采用的升级链路（保留记录用于报告，不影响 blocks 骨架） */
  adoptedSource?: OcrUpgradeChain;
  adoptedModel?: string;
  /** 真当被采用：用于统计 want/used/adopted（语义等价于原 upgraded=true） */
  upgraded?: boolean;
  /** P1-2 逐格状态：R{row}_{KIND} / R{row} 行汇总 */
  cellVerification?: Record<string, CellVerification>;
  /** P2-1：页面复原质量画像（专家建议结构 12 项全量落） */
  qualityProfile?: PageQualityProfile;
  /** P2-2：OCR 执行上下文（调试/审计） */
  dispatchContext?: OCRDispatchContext;
  /** P1/P2 流水页画像（本页若被判定流水则有） */
  ledgerValidationReport?: LedgerValidationReport;
  ledgerSemantics?: LedgerSemantics;
  ledgerFieldQuality?: LedgerFieldQuality;
}

export type LayoutComplexity = 'simple' | 'complex';

/** 两列中心点之间的归一化间隙超过该值则视为不同列 */
const COLUMN_GAP = 0.18;
/**
 * 文字覆盖率低于该值视为图片 / 图表型页面。
 * 实测纯文字页（多行正文）覆盖率约 3%-15%，纯图片/照片页通常 <1%，
 * 取 0.02 作为分界可避免纯文字页被误判为复杂版式。
 */
const MIN_COVERAGE = 0.02;

/** 估算文字块列数：按 x 中心排序，相邻间隙超过阈值则分列 */
export function estimateColumns(blocks: OcrBlock[]): number {
  if (blocks.length === 0) return 1;
  const centers = blocks.map((b) => b.x + b.w / 2).sort((a, b) => a - b);
  let columns = 1;
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] - centers[i - 1] > COLUMN_GAP) columns += 1;
  }
  return columns;
}

/** 文字覆盖率：文字块归一化面积之和（bbox 已归一化，页面面积为 1） */
export function coverage(blocks: OcrBlock[]): number {
  if (blocks.length === 0) return 0;
  return blocks.reduce((s, b) => s + b.w * b.h, 0);
}

/** 判定一组页面是否为复杂版式（任一页复杂即整体复杂） */
export function judgeLayoutComplexity(pages: OcrPage[]): LayoutComplexity {
  for (const p of pages) {
    // 1. 表格框线：贯穿性横线 ≥2 且 竖线 ≥2（像素级检测，最可靠的表格信号）
    if (p.layout?.hasTableLines) return 'complex';
    const blocks = p.blocks ?? [];
    if (blocks.length === 0) continue;
    // 2. 多列（表格 / 分栏）
    if (estimateColumns(blocks) >= 2) return 'complex';
    // 3. 图片 / 图表型页面（文字占比过低）
    if (coverage(blocks) < MIN_COVERAGE) return 'complex';
  }
  return 'simple';
}

/**
 * 判定单页是否复杂（需要 VLM 整页语义解读）。
 * 用于版式感知混合识别：仅复杂页送 VLM，simple 页保持本地 OCR，全页覆盖不丢页。
 * 判定信号：表格线 / 多列 / 图文低覆盖 / 疑似手写块占比高。
 */
export function isComplexPage(page: OcrPage): boolean {
  // 1. 表格框线（像素级检测，最可靠的表格信号）
  if (page.layout?.hasTableLines) return true;
  const blocks = page.blocks ?? [];
  // 2. 无文字块信息：数据缺失，保守送 VLM（法律文档准确性优先）
  if (blocks.length === 0) return true;
  // 3. 多列（表格 / 分栏）
  if (estimateColumns(blocks) >= 2) return true;
  // 4. 图片 / 图表型页面（文字占比过低）
  if (coverage(blocks) < MIN_COVERAGE) return true;
  // 5. 疑似手写块占比高（置信度低于 0.6）→ 整页 VLM 更准
  const low = blocks.filter((b) => (b.confidence ?? 1) < 0.6);
  if (low.length >= 3 || low.length / blocks.length > 0.3) return true;
  return false;
}
