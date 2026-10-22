/**
 * Butler 悬浮球几何（纯函数：不 import DOM / Electron / React）
 *
 * 为什么单独成模块：同一套「球该落在哪」的算术要在三处使用——
 *   ① 渲染层（主窗口内那颗球）：中栏（对话区）左下角 + 用户拖拽偏移
 *   ② 主进程（最小化后的独立置顶球窗）：主窗内容区左下角 / 屏幕可用区左下角
 *   ③ 单元测试（vitest 只收集 `src/**\/*.test.ts`）
 * 放一处，避免三份各写一遍后漂移。本模块必须保持零依赖，才能在 Node 测试环境直接跑。
 *
 * 坐标约定：
 *   - 渲染层：视口坐标（CSS px），锚点 = 中栏可视区左下角 { left, bottom }
 *   - 主进程：屏幕坐标（点），锚点 = 某个矩形（主窗内容区 / 屏幕 workArea）的左下角
 *   - 球点（OrbPoint）= 球体左上角；球窗矩形（OrbRect）= 传给 BrowserWindow 的外框
 */

/** 球体直径（CSS px）。34px：河马矢量脸的眼睛约 1.6 CSS px，低于此眨眼读不出来 */
export const ORB_SIZE = 34;
/** 球相对锚点左下角的内缩留白 */
export const ORB_EDGE_GAP = 16;
/** 距离视口 / 屏幕边缘至少保留的边距（拖到边缘也不整颗贴死） */
export const ORB_MIN_MARGIN = 8;
/** 独立球窗四周的额外内边距：给未读角标（溢出球体 2px）、悬停放大（+5%）与投影留空间。
 *  取值必须 ≥ 独立态投影的最大外扩（4px 偏移 + 约 5px 模糊）否则窗口边缘会把投影切出一条直边。 */
export const ORB_WINDOW_PAD = 10;
/** 独立球窗外框边长 */
export const ORB_WINDOW_SIZE = ORB_SIZE + ORB_WINDOW_PAD * 2;

/** 球体左上角（视口 / 屏幕坐标） */
export interface OrbPoint {
  x: number;
  y: number;
}

/** 屏幕矩形（Electron screen / BrowserWindow.getContentBounds 同形） */
export interface OrbRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 渲染层锚点：中栏可视区左下角（视口坐标） */
export interface OrbAnchor {
  left: number;
  bottom: number;
}

/** 钳制（NaN 视为下界：一次坏测量不该把球永久钉死在 NaN；±Infinity 正常走 Math.min/max） */
export function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/** 视口内钳制：保证整球可见（至少留 ORB_MIN_MARGIN） */
export function clampOrbPoint(
  point: OrbPoint,
  viewport: { width: number; height: number },
  size: number = ORB_SIZE,
  margin: number = ORB_MIN_MARGIN,
): OrbPoint {
  // 视口比球还小时 min > max，clamp 取 min 即可（球贴左上，至少不出现负坐标）
  return {
    x: clamp(point.x, margin, viewport.width - size - margin),
    y: clamp(point.y, margin, viewport.height - size - margin),
  };
}

/** 矩形内钳制（独立球窗用：屏幕 workArea 比球小时同样退化为贴左上） */
export function clampOrbPointInRect(
  point: OrbPoint,
  rect: OrbRect,
  size: number = ORB_SIZE,
  margin: number = ORB_MIN_MARGIN,
): OrbPoint {
  return {
    x: clamp(point.x, rect.x + margin, rect.x + rect.width - size - margin),
    y: clamp(point.y, rect.y + margin, rect.y + rect.height - size - margin),
  };
}

/** 锚点 + 偏移 → 球左上角（偏移 (0,0) 即「家」：锚点左下角内缩 ORB_EDGE_GAP） */
export function orbPointFromOffset(
  anchor: OrbAnchor,
  offset: OrbPoint,
  size: number = ORB_SIZE,
  gap: number = ORB_EDGE_GAP,
): OrbPoint {
  return {
    x: anchor.left + gap + offset.x,
    y: anchor.bottom - size - gap + offset.y,
  };
}

/** 球左上角 → 相对锚点的偏移（orbPointFromOffset 的逆运算；用于拖拽落盘） */
export function orbOffsetFromPoint(
  point: OrbPoint,
  anchor: OrbAnchor,
  size: number = ORB_SIZE,
  gap: number = ORB_EDGE_GAP,
): OrbPoint {
  return {
    x: point.x - anchor.left - gap,
    y: point.y - anchor.bottom + size + gap,
  };
}

/** 矩形左下角的「家」落点（主窗内容区 / 屏幕 workArea 通用） */
export function orbPointAtRectBottomLeft(
  rect: OrbRect,
  size: number = ORB_SIZE,
  gap: number = ORB_EDGE_GAP,
): OrbPoint {
  return { x: rect.x + gap, y: rect.y + rect.height - size - gap };
}

/** 球左上角 → BrowserWindow 外框矩形（去掉四周内边距） */
export function orbWindowBounds(
  point: OrbPoint,
  windowSize: number = ORB_WINDOW_SIZE,
  pad: number = ORB_WINDOW_PAD,
): OrbRect {
  return {
    x: Math.round(point.x - pad),
    y: Math.round(point.y - pad),
    width: windowSize,
    height: windowSize,
  };
}

/** 矩形是否足以容纳一颗球（主窗还没铺开 / 中栏尚未挂载时，别把球贴到 0×0 的角上） */
export function canHostOrb(rect: OrbRect, size: number = ORB_SIZE): boolean {
  return rect.width > size * 3 && rect.height > size * 3;
}

// ===== 独立 Butler 面板（桌面悬浮球就地展开的那块面板）=====

/**
 * 面板默认尺寸。取值由**桌面抽屉**（ButlerDrawer）的自适应口径反推，目标是「与 BobWork 里打开一致」：
 *   - 宽：抽屉三栏合计 = 左轨 84 + 联系人 168 + 中栏 560 + 右栏 280 ≈ 1092，且抽屉自身夹在 90vw 内。
 *         1020 的窗给抽屉 918 可用宽（仍高于 1000 的窄窗阈值判定所依赖的窗口宽度），三栏按流内排布；
 *   - 高：抽屉高 = min(760, 86vh)，它量的是**窗口**高度，880 的窗即得 ≈757（上限 760）。
 */
export const PANEL_DEFAULT_SIZE: OrbSize = { width: 1020, height: 880 };
/** 面板最小尺寸：抽屉自身下限 520×360，加上标题条与边距，再小就只剩一栏了 */
export const PANEL_MIN_SIZE: OrbSize = { width: 560, height: 420 };

export interface OrbSize {
  width: number;
  height: number;
}

/**
 * 面板矩形：以球的**左下角**为锚向上生长，并保证整块落在可用区内。
 *
 * 与 `orbPointFromPanel` 互为逆运算 —— 这是「缩小回球时球停在展开前的位置」能成立的原因：
 *   panelBoundsForOrb(p) 的底边 = 球的底边，故 orbPointFromPanel(panel) === p（未被钳制时严格相等）。
 * 可用区装不下首选尺寸时先压到 minSize；连 minSize 都装不下则退化为贴左上（与 clampOrbPoint 同约定）。
 */
export function panelBoundsForOrb(
  ballPoint: OrbPoint,
  preferred: OrbSize = PANEL_DEFAULT_SIZE,
  workArea: OrbRect,
  minSize: OrbSize = PANEL_MIN_SIZE,
  margin: number = ORB_MIN_MARGIN,
): OrbRect {
  const width = Math.round(Math.max(minSize.width, Math.min(preferred.width, workArea.width - margin * 2)));
  const height = Math.round(Math.max(minSize.height, Math.min(preferred.height, workArea.height - margin * 2)));
  const bottom = ballPoint.y + ORB_SIZE;
  return {
    x: Math.round(clamp(ballPoint.x, workArea.x + margin, workArea.x + workArea.width - width - margin)),
    y: Math.round(clamp(bottom - height, workArea.y + margin, workArea.y + workArea.height - height - margin)),
    width,
    height,
  };
}

/** 面板 → 球点（panelBoundsForOrb 的逆）：球回到面板左下角 */
export function orbPointFromPanel(panel: OrbRect, size: number = ORB_SIZE): OrbPoint {
  return { x: panel.x, y: panel.y + panel.height - size };
}
