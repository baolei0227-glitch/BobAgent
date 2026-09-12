/**
 * Hippo Browser 布局纯逻辑（无 electron 依赖，可单测）
 *
 * 负责浏览器的 WebContentsView 定位决策：
 * - 嵌入模式：浏览器作为预览面板 Tab，占满面板内容区（锚点矩形）；
 * - 侧边栏模式：占主窗口右侧 65%（min 480 max 900），隐藏时滑出屏幕。
 *
 * 该文件刻意不 import electron，只导出纯函数与常量，供 hippo-browser.ts（主进程）
 * 与测试共享。HIPPO_TOOLBAR_HEIGHT 与渲染层工具栏高度保持一致。
 */

/** React 工具栏高度（渲染层 HippoBrowser.tsx 与之对齐） */
export const HIPPO_TOOLBAR_HEIGHT = 48;

/** 嵌入模式锚点（预览面板内容区矩形，逻辑坐标） */
export interface HippoAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 浏览器 WebContentsView 应占用的矩形 */
export interface HippoBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 判断未知值是否为合法的锚点矩形（渲染层上报，字段均为有限正数） */
export function isHippoAnchor(v: unknown): v is HippoAnchor {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.x === 'number' && typeof o.y === 'number' &&
    typeof o.width === 'number' && typeof o.height === 'number' &&
    Number.isFinite(o.x) && Number.isFinite(o.y) &&
    Number.isFinite(o.width) && Number.isFinite(o.height) &&
    o.width > 0 && o.height > 0
  );
}

/**
 * 根据窗口尺寸 + 嵌入锚点 + 可见态计算 bounds。
 *
 * 嵌入模式（anchor 非空）：对齐预览面板锚点区（占满面板，优先级最高）；
 * 否则走右侧侧边栏槽：占主窗口 65%（min 480 max 900），y 从工具栏下方开始；
 * 隐藏时滑出屏幕右侧（保留实例，避免销毁重建的白屏闪烁）。
 */
export function computeHippoBounds(
  winWidth: number,
  winHeight: number,
  anchor: HippoAnchor | null,
  visible: boolean,
): HippoBounds {
  if (anchor) {
    return {
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
      width: Math.max(1, Math.round(anchor.width)),
      height: Math.max(1, Math.round(anchor.height)),
    };
  }
  const sidebarWidth = Math.min(900, Math.max(480, Math.round(winWidth * 0.65)));
  // 隐藏 = 滑出屏幕右侧（保留实例，避免销毁重建的开销与白屏闪烁）
  const x = visible ? winWidth - sidebarWidth : winWidth;
  return {
    x,
    y: HIPPO_TOOLBAR_HEIGHT,
    width: sidebarWidth,
    height: Math.max(0, winHeight - HIPPO_TOOLBAR_HEIGHT),
  };
}

/** 计算侧边栏模式（非嵌入）的槽宽：主窗口 65%，min 480 max 900 */
export function computeHippoSlotWidth(winWidth: number): number {
  return Math.min(900, Math.max(480, Math.round(winWidth * 0.65)));
}