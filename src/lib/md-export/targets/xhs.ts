/**
 * 小红书 target 契约：平台约束（§5.3）+ 卡片几何。
 *
 * 卡片渲染仍在 XhsCard.tsx（复用既有分页/主题/插画/导出），
 * 这里只把「平台规则」与「几何常量」从组件里提出来，供体检与分页共用，避免散落硬编码。
 */

import type { PlatformSpec } from '../types';

export const XHS_SPEC: PlatformSpec = {
  id: 'xhs',
  label: 'Xiaohongshu',
  limits: {
    titleMax: 20, // 平台硬截断
    bodyMax: 1000,
    imageMin: 1,
    imageMax: 18,
    ratios: ['3:4'],
    unsupported: ['code'],
  },
  formats: ['png', 'text'],
};

/** 3:4 卡片几何：设计尺寸 414×552，导出 pixelRatio 3 → 1242×1656 */
export const XHS_GEOMETRY = {
  width: 414,
  height: 552,
  pad: 24,
  exportRatio: 3,
  /** 正文页内容区高度预算（px，含首尾留白余量）：552 - 上下留白 - 顶栏 - 页脚 */
  bodyCap: 420,
} as const;
