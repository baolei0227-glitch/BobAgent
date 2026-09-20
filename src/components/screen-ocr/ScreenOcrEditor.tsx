/**
 * 截图编辑覆盖层（Cmd+Shift+O 编辑阶段，微信截图式交互）
 *
 * 整屏快照下发后，本组件全屏展示：
 *   - 直接在图上拖拽出高亮块（其余区域暗角，类似微信截图）
 *   - 松开鼠标弹出浮动工具条（Select / Mosaic / Undo / Redo / Reset）
 *   - 选区可拖动/缩放手柄微调；Mosaic 涂抹打码；Esc 取消
 *   - 右下角 X 放弃、✓ 确认：按选区裁剪后回传主进程 OCR
 *
 * 实现：内容画布（原图 + 马赛克）用 Canvas；选区高亮/手柄/工具条用 HTML 覆盖层
 * （box-shadow 暗角技巧，无需重绘画布）。无第三方依赖，UI 文案英文，配色走主题变量。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Move, Undo2, Redo2, RotateCcw, Check, X, ScanText, Copy, Loader2, ArrowUpRight, Type, Underline } from 'lucide-react';
import type { ScreenOcrGeometry } from '@/lib/desktop-adapter';

/** 马赛克工具图标：4×4 像素块、对角填充（像素化/模糊语义，lucide 无对应图标故自绘） */
function MosaicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </svg>
  );
}

export interface ScreenOcrEditorProps {
  /** 整屏/选区截图 PNG dataUrl（主进程下发） */
  dataUrl: string;
  /** ✓：复制选区裁剪后图片（父层复制到剪贴板并关闭） */
  onDone: (editedDataUrl: string) => void;
  /** To Text：OCR 选区图片并返回识别文本（弹窗内展示可编辑） */
  onOcr: (dataUrl: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  /** 取消编辑 */
  onCancel: () => void;
  /** 初始选区：'full' = 整图直接全选区（原生 -i 选区已完成，进面板直接标注）；缺省 'none' = 用户自行拖选 */
  initialSelection?: 'full' | 'none';
  /** 截图时刻的窗口几何（整屏链路才有）：用于窗口吸附（hover 高亮 / 点击选中整个窗口 / Tab 轮换） */
  geometry?: ScreenOcrGeometry | null;
  /** 画面属于哪一屏（geometry.screens 下标）。多屏时画面只含该屏，坐标基准必须是这一屏；
   *  null 或 -1 = 全部屏幕并集（兜底），此时沿用并集基准。 */
  screenIndex?: number | null;
}

type Tool = 'select' | 'mosaic' | 'arrow' | 'text' | 'underline';
type Sel = { x: number; y: number; w: number; h: number };

/** 可移动标注对象：文字 / 箭头（对象化：可点选、拖动、删除；渲染在独立覆盖层 canvas） */
type Mark =
  | { kind: 'text'; id: number; x: number; y: number; value: string }
  | { kind: 'arrow'; id: number; x1: number; y1: number; x2: number; y2: number }
  /**
   * 下划线批注：x/y 为横线左端，w 为线长，value 为批注文字。
   * textX = 文字气泡锚点（默认划线结束处，即松手那一端）；缺省时回退到线尾。
   */
  | { kind: 'underline'; id: number; x: number; y: number; w: number; value: string; textX?: number };

/** 文字输入草稿：x/y 为输入框位置；携带 underline 时表示「下划线批注」的待落定横线 */
type TextDraft = { x: number; y: number; value: string; underline?: { x: number; y: number; w: number } };

/** 撤销/重做快照：主画布（原图+马赛克）像素 + 标注对象列表 */
type Snap = { img: ImageData; marks: Mark[] };

/** 标注色（微信电脑版截图标注红） */
const MARK_COLOR = '#FA5151';
/** 批注文字气泡底色：白色实心圆角矩形 + 标注红字（PDF 批注便签观感，红字在白底上最清晰） */
const MARK_TEXT_BG = '#FFFFFF';
/** 箭头尺寸标定基准宽度：典型 Retina 整屏图（3024px）。箭头/文字都按图宽缩放，保证不同 DPR 观感一致 */
const MARK_GEOM_BASE_W = 3024;
/** 下划线批注：最短线长（图像像素），短于此按误触处理，不进入输入 */
const MIN_UNDERLINE = 16;
/** 马赛克块大小（canvas 像素） */
const MOSAIC_BLOCK = 12;
/** 马赛克画笔半径档位（相对基准半径的倍率：细 / 中 / 粗） */
const MOSAIC_BRUSH_STEPS = [0.5, 1, 1.8];
/** 撤销栈最大深度（全图快照内存保护） */
const MAX_HISTORY = 30;
/** 选区最小边长（canvas 像素） */
const MIN_SEL = 18;
/** 浮动工具条宽度（窗口像素） */
const TOOLBAR_W = 236;
/** 选区/裁剪输出圆角半径（图像自然像素） */
const SEL_RADIUS = 10;

/**
 * 画箭头（微信电脑版标注风：粗杆圆头 + 饱满实心三角头）
 *
 * 尺寸一律按图宽标定（旧实现用固定 2.5px 线宽，在 Retina 整屏图 3024px 上缩放显示后
 * 只有约 1.25pt，视觉极其单薄——这是「箭头太普通」的真正原因）。
 * 以 MARK_GEOM_BASE_W 为基准：杆粗约 4pt、头长约 22pt，短箭头按比例收敛。
 */
function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 12) return;
  const k = (ctx.canvas.width || MARK_GEOM_BASE_W) / MARK_GEOM_BASE_W;
  const lineWidth = Math.max(3, 8 * k);                       // 杆粗（视觉约 4pt）
  const headLen = Math.min(len * 0.55, Math.max(22, 44 * k)); // 头长（视觉约 22pt）
  const halfW = headLen * 0.46;                               // 底宽 ≈ 0.92 × 头长：饱满不尖细
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  // 杆终点 = 三角底边中点（实心头占位，衔接无缝）
  const bx = x2 - dx * headLen;
  const by = y2 - dy * headLen;
  const nx = -dy;
  const ny = dx;
  ctx.strokeStyle = MARK_COLOR;
  ctx.fillStyle = MARK_COLOR;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 杆：起点 → 三角底边中点（圆头实线）
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(bx, by);
  ctx.stroke();
  // 实心三角头：尖端 → 两翼端点 → 底边（填充）
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(bx + nx * halfW, by + ny * halfW);
  ctx.lineTo(bx - nx * halfW, by - ny * halfW);
  ctx.closePath();
  ctx.fill();
}

/** 下划线批注：文字相对横线的下移量（按字号比例，保证不同分辨率下间距观感一致） */
function underlineTextOffset(fontSize: number): number {
  return Math.round(fontSize * 0.34);
}

/** 画下划线批注的横线（粗度按图宽标定，视觉约 2.5pt；下划线恒为水平线） */
function drawUnderline(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  const k = (ctx.canvas.width || MARK_GEOM_BASE_W) / MARK_GEOM_BASE_W;
  ctx.strokeStyle = MARK_COLOR;
  ctx.lineWidth = Math.max(2, 5 * k);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
}

/** 点到线段距离（箭头命中检测） */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 标注文字字号（图像像素）：随图像宽度自适应，保证不同分辨率/DPR 截图上视觉大小一致 */
function markFontSize(imgWidth: number): number {
  return Math.max(16, Math.min(56, Math.round(imgWidth / 80)));
}

/** 标注文字字体族（测量 / 绘制 / 输入框共用，避免多处不一致） */
const MARK_FONT_FAMILY =
  '"Times New Roman", Times, "Songti SC", "Source Han Serif SC", "Noto Serif SC", "SimSun", "Liberation Serif", serif';

/** 标注文字 canvas font 串 */
function markFont(imgWidth: number): string {
  return `600 ${markFontSize(imgWidth)}px ${MARK_FONT_FAMILY}`;
}

/** 批注文字气泡内边距（图像像素，按字号比例）——不同分辨率截图上观感一致 */
function textBubblePadding(fontSize: number): { x: number; y: number; radius: number } {
  return {
    x: Math.max(4, Math.round(fontSize * 0.34)),
    y: Math.max(3, Math.round(fontSize * 0.2)),
    radius: Math.max(3, Math.round(fontSize * 0.18)),
  };
}

/** 圆角矩形路径（手工构造，不依赖 ctx.roundRect 的运行时支持） */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 批注文字气泡矩形（图像像素）：命中检测与选中框复用，保证判定范围与视觉一致 */
function textBubbleRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  value: string,
): { x: number; y: number; w: number; h: number } {
  const fs = markFontSize(ctx.canvas.width);
  ctx.font = markFont(ctx.canvas.width);
  const p = textBubblePadding(fs);
  const tw = ctx.measureText(value).width;
  return { x: x - p.x, y: y - p.y, w: tw + p.x * 2, h: fs + p.y * 2 };
}

/**
 * 下划线批注的文字锚点 x（图像像素）。
 * 规则：落在**划线结束处**（松手那一端），缺省回退线尾；
 * 若文字会超出图宽，则整体左移，保证气泡完整可见（不出现半截气泡）。
 */
function underlineTextX(
  ctx: CanvasRenderingContext2D,
  m: Extract<Mark, { kind: 'underline' }>,
  value: string,
): number {
  const raw = m.textX ?? m.x + m.w;
  if (!value) return raw;
  const fs = markFontSize(ctx.canvas.width);
  const p = textBubblePadding(fs);
  ctx.font = markFont(ctx.canvas.width);
  const tw = ctx.measureText(value).width;
  const maxX = ctx.canvas.width - (tw + p.x); // 气泡右边缘不出图
  return Math.max(p.x, Math.min(raw, maxX));
}

/** 画批注文字气泡：白底 + 标注红字，返回气泡矩形（供选中框复用） */
function drawTextBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  value: string,
): { x: number; y: number; w: number; h: number } {
  const fs = markFontSize(ctx.canvas.width);
  const r = textBubbleRect(ctx, x, y, value);
  roundRectPath(ctx, r.x, r.y, r.w, r.h, textBubblePadding(fs).radius);
  ctx.fillStyle = MARK_TEXT_BG;
  ctx.fill();
  ctx.font = markFont(ctx.canvas.width);
  ctx.textBaseline = 'top';
  ctx.fillStyle = MARK_COLOR;
  ctx.fillText(value, x, y);
  return r;
}

/** 命中检测：从后往前（后画的在上），返回命中的标注对象或 null */
function hitTestMark(ctx: CanvasRenderingContext2D, marks: Mark[], px: number, py: number): Mark | null {
  const fs = markFontSize(ctx.canvas.width);
  ctx.font = markFont(ctx.canvas.width);
  ctx.textBaseline = 'top';
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (m.kind === 'text') {
      // 按气泡矩形判定（含内边距），点到底色边缘也能选中
      const r = textBubbleRect(ctx, m.x, m.y, m.value);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return m;
    } else if (m.kind === 'underline') {
      // 命中横线本体（线段）或线下批注文字气泡
      if (distToSegment(px, py, m.x, m.y, m.x + m.w, m.y) <= 8) return m;
      if (m.value) {
        const r = textBubbleRect(ctx, underlineTextX(ctx, m, m.value), m.y + underlineTextOffset(fs), m.value);
        if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return m;
      }
    } else {
      if (distToSegment(px, py, m.x1, m.y1, m.x2, m.y2) <= 8) return m;
    }
  }
  return null;
}

/** 8 向缩放手柄定义 */const HANDLES: { id: string; style: React.CSSProperties }[] = [
  { id: 'nw', style: { left: -4, top: -4, cursor: 'nwse-resize' } },
  { id: 'n', style: { left: '50%', top: -4, marginLeft: -4, cursor: 'ns-resize' } },
  { id: 'ne', style: { right: -4, top: -4, cursor: 'nesw-resize' } },
  { id: 'e', style: { right: -4, top: '50%', marginTop: -4, cursor: 'ew-resize' } },
  { id: 'se', style: { right: -4, bottom: -4, cursor: 'nwse-resize' } },
  { id: 's', style: { left: '50%', bottom: -4, marginLeft: -4, cursor: 'ns-resize' } },
  { id: 'sw', style: { left: -4, bottom: -4, cursor: 'nesw-resize' } },
  { id: 'w', style: { left: -4, top: '50%', marginTop: -4, cursor: 'ew-resize' } },
];

/** 按手柄方向调整选区（最小边长 + 画布边界钳制） */
function resizeSel(s0: Sel, handle: string, pos: { x: number; y: number }, cw: number, ch: number): Sel {
  let { x, y, w, h } = s0;
  if (handle.includes('e')) w = Math.max(MIN_SEL, pos.x - x);
  if (handle.includes('s')) h = Math.max(MIN_SEL, pos.y - y);
  if (handle.includes('w')) {
    const nx = Math.min(pos.x, x + w - MIN_SEL);
    w = x + w - nx;
    x = nx;
  }
  if (handle.includes('n')) {
    const ny = Math.min(pos.y, y + h - MIN_SEL);
    h = y + h - ny;
    y = ny;
  }
  x = Math.max(0, Math.min(x, cw - MIN_SEL));
  y = Math.max(0, Math.min(y, ch - MIN_SEL));
  w = Math.min(w, cw - x);
  h = Math.min(h, ch - y);
  return { x, y, w, h };
}

/** 选区平移并钳制在画布内 */
function clampMove(s: Sel, cw: number, ch: number): Sel {
  return {
    x: Math.max(0, Math.min(s.x, cw - s.w)),
    y: Math.max(0, Math.min(s.y, ch - s.h)),
    w: s.w,
    h: s.h,
  };
}

/** 吸附目标（图像像素坐标）：窗口 / 菜单栏 / Dock */
type SnapTarget = { id: string; label: string; x: number; y: number; w: number; h: number };

export function ScreenOcrEditor({
  dataUrl,
  onDone,
  onOcr,
  onCancel,
  initialSelection = 'none',
  geometry = null,
  screenIndex = null,
}: ScreenOcrEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 标注覆盖层（文字/箭头对象画在此透明 canvas，叠在主画布上） */
  const markCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const originalRef = useRef<HTMLImageElement | null>(null);
  const undoRef = useRef<Snap[]>([]);
  const redoRef = useRef<Snap[]>([]);
  /** 文字/箭头对象列表（ref 与 state 同步，供指针事件内读取） */
  const [marks, setMarks] = useState<Mark[]>([]);
  const marksRef = useRef<Mark[]>([]);
  const markIdRef = useRef(1);
  /** 当前选中的标注对象 id（select 点选；Delete 删除） */
  const [selMarkId, setSelMarkId] = useState<number | null>(null);
  const selMarkIdRef = useRef<number | null>(null);
  const setMarksBoth = useCallback((m: Mark[]) => {
    marksRef.current = m;
    setMarks(m);
  }, []);
  const setSelMarkIdBoth = useCallback((id: number | null) => {
    selMarkIdRef.current = id;
    setSelMarkId(id);
  }, []);
  /** 选区（图像像素坐标）；selRef 与 state 同步，供指针事件内读取 */
  const selRef = useRef<Sel | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  /** 马赛克画笔档位索引（MOSAIC_BRUSH_STEPS） */
  const [mosaicStep, setMosaicStep] = useState(1);
  const [phase, setPhase] = useState<'idle' | 'edit'>('idle');
  const [dragging, setDragging] = useState(false);
  const [dragMode, setDragMode] = useState<null | 'select' | 'move' | 'resize' | 'mosaic' | 'arrow' | 'underline' | 'markMove'>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  /** 马赛克画笔半径（图像像素）：基准随图像宽度自适应，再按档位缩放，保证不同 DPR 截图视觉一致 */
  const mosaicRadius = nat
    ? Math.max(6, Math.round((nat.w / 60) * MOSAIC_BRUSH_STEPS[mosaicStep]))
    : 48;

  /** 画面在屏幕坐标系中的基准矩形（CG 点）。
   *  单屏/已知命中屏时 = 那一屏；未知（null 或 -1）时 = 全部屏幕并集（兜底）。
   *  所有「点 ↔ 图像像素」换算都以此矩形为准——它在多屏下决定画面是否与真实界面对齐。 */
  const viewBase = useMemo(() => {
    const screens = geometry?.screens ?? [];
    if (screens.length === 0) return null;
    if (typeof screenIndex === 'number' && screenIndex >= 0 && screens[screenIndex]) {
      const s = screens[screenIndex];
      return { x: s.x, y: s.y, w: s.w, h: s.h };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of screens) {
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x + s.w);
      maxY = Math.max(maxY, s.y + s.h);
    }
    if (!(maxX > minX) || !(maxY > minY)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }, [geometry, screenIndex]);

  /** 吸附目标：主进程给的窗口/区域是 CG 点坐标，此处换算到图像像素坐标。
   *  基准矩形（点）↔ 整屏图（像素）：kx/ky 即「点 → 图像像素」系数。 */
  const snapTargets = useMemo<SnapTarget[]>(() => {
    if (!geometry || !nat || !viewBase) return [];
    const gw = viewBase.w;
    const gh = viewBase.h;
    if (gw <= 0 || gh <= 0) return [];
    const kx = nat.w / gw;
    const ky = nat.h / gh;
    const out: SnapTarget[] = [];
    // 只保留与本屏相交的目标（多屏时其他屏的窗口/菜单栏不在画面里，不应参与命中）
    const intersects = (x: number, y: number, w: number, h: number) =>
      x < viewBase.x + gw && x + w > viewBase.x && y < viewBase.y + gh && y + h > viewBase.y;
    for (const r of geometry.regions ?? []) {
      if (!intersects(r.x, r.y, r.w, r.h)) continue;
      out.push({
        id: `region:${r.kind}`,
        label: r.kind === 'menubar' ? '菜单栏' : 'Dock 栏',
        x: (r.x - viewBase.x) * kx, y: (r.y - viewBase.y) * ky, w: r.w * kx, h: r.h * ky,
      });
    }
    // 窗口（CGWindowList 返回顺序 front-to-back，命中检测沿用此顺序 = 最前面的窗口优先）
    for (const w of geometry.windows ?? []) {
      if (!intersects(w.x, w.y, w.w, w.h)) continue;
      out.push({
        id: `window:${w.id}`,
        label: w.name || w.owner,
        x: (w.x - viewBase.x) * kx, y: (w.y - viewBase.y) * ky, w: w.w * kx, h: w.h * ky,
      });
    }
    return out;
  }, [geometry, nat, viewBase]);

  /** 当前 hover 命中的吸附目标（引用取自 snapTargets，同目标重复 set 不会触发重渲染） */
  const [hoverTarget, setHoverTarget] = useState<SnapTarget | null>(null);
  const hoverTargetRef = useRef<SnapTarget | null>(null);
  const setHoverTargetBoth = useCallback((t: SnapTarget | null) => {
    hoverTargetRef.current = t;
    setHoverTarget(t);
  }, []);

  /** 命中检测：优先窗口（顺序即层级），其次菜单栏 / Dock */
  const hitTarget = useCallback(
    (px: number, py: number): SnapTarget | null => {
      const inside = (t: SnapTarget) => px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h;
      for (const t of snapTargets) if (t.id.startsWith('window:') && inside(t)) return t;
      for (const t of snapTargets) if (!t.id.startsWith('window:') && inside(t)) return t;
      return null;
    },
    [snapTargets],
  );

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  /** To Text 弹窗：选区裁剪图 + OCR 文本（可编辑）+ 复制/取消 */
  const [ocrPopup, setOcrPopup] = useState<{ dataUrl: string; text: string; loading: boolean; error?: string; copied: boolean } | null>(null);
  /** 文字工具：进行中的输入草稿（图像坐标） */
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  /** 文字输入框最近一次挂载时间戳（挂载初期误失焦保护用） */
  const textMountTs = useRef(0);
  const dragRef = useRef<{
    mode: 'select' | 'move' | 'resize' | 'mosaic' | 'arrow' | 'underline' | 'markMove' | null;
    handle?: string;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    sel0: Sel;
    /** 标注对象拖动：被拖对象 id 与命中时原坐标（用于偏移） */
    markId?: number;
    markFrom?: Mark;
    /** 马赛克涂抹：上一个落笔点（用于相邻点插值，消除快速拖动断层） */
    lastX?: number;
    lastY?: number;
  }>({ mode: null, startX: 0, startY: 0, curX: 0, curY: 0, sel0: { x: 0, y: 0, w: 0, h: 0 } });

  const setSelBoth = useCallback((s: Sel | null) => {
    selRef.current = s;
    setSel(s);
  }, []);

  /** 选中吸附目标（点击 / Tab 轮换）→ 选区直接等于该窗口矩形 */
  const selectTarget = useCallback(
    (t: SnapTarget) => {
      setSelBoth({ x: t.x, y: t.y, w: t.w, h: t.h });
      setPhase('edit');
    },
    [setSelBoth],
  );

  const setTextDraftBoth = useCallback((d: TextDraft | null) => {
    textDraftRef.current = d;
    setTextDraft(d);
  }, []);

  const refreshStates = useCallback(() => {
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  }, []);

  const getCanvas = useCallback(() => canvasRef.current, []);
  const getCtx = useCallback(() => getCanvas()!.getContext('2d')!, [getCanvas]);

  /** 重绘标注覆盖层（文字/箭头对象 + 选中高亮）。主画布不动（只承载原图+马赛克） */
  const redrawMarks = useCallback(() => {
    const mc = markCanvasRef.current;
    const canvas = canvasRef.current;
    if (!mc || !canvas) return;
    mc.width = canvas.width;
    mc.height = canvas.height;
    const ctx = mc.getContext('2d')!;
    ctx.clearRect(0, 0, mc.width, mc.height);
    const fs = markFontSize(mc.width);
    ctx.font = markFont(mc.width);
    ctx.textBaseline = 'top';
    ctx.fillStyle = MARK_COLOR;
    const selId = selMarkIdRef.current;
    for (const m of marksRef.current) {
      if (m.kind === 'text') {
        // 气泡：半透明深底 + 标注红字（PDF 批注气泡观感）
        const box = drawTextBubble(ctx, m.x, m.y, m.value);
        if (m.id === selId) {
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = 'rgba(75,63,227,0.95)';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4);
          ctx.setLineDash([]);
        }
      } else if (m.kind === 'underline') {
        // 下划线批注：横线 + 线下文字气泡（气泡锚在**划线结束处**，整体一个对象，选中框覆盖两者）
        drawUnderline(ctx, m.x, m.y, m.w);
        const box = m.value
          ? drawTextBubble(ctx, underlineTextX(ctx, m, m.value), m.y + underlineTextOffset(fs), m.value)
          : null;
        if (m.id === selId) {
          const left = Math.min(m.x - 3, box ? box.x - 2 : m.x - 3);
          const right = Math.max(m.x + m.w + 3, box ? box.x + box.w + 2 : m.x + m.w + 3);
          const top = Math.min(m.y - 4, box ? box.y - 2 : m.y - 4);
          const bottom = Math.max(m.y + 4, box ? box.y + box.h + 2 : m.y + 4);
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = 'rgba(75,63,227,0.95)';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(left, top, right - left, bottom - top);
          ctx.setLineDash([]);
        }
      } else {
        drawArrow(ctx, m.x1, m.y1, m.x2, m.y2);
        if (m.id === selId) {
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = 'rgba(75,63,227,0.95)';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(
            Math.min(m.x1, m.x2) - 5,
            Math.min(m.y1, m.y2) - 5,
            Math.abs(m.x2 - m.x1) + 10,
            Math.abs(m.y2 - m.y1) + 10,
          );
          ctx.setLineDash([]);
        }
      }
    }
    // 下划线批注草稿：输入期间把「待落定横线」画出来（提交后才成为 mark 对象）
    const draftLine = textDraftRef.current?.underline;
    if (draftLine) drawUnderline(ctx, draftLine.x, draftLine.y, draftLine.w);
  }, []);

  /** 标注对象/选中态变化 → 重绘覆盖层（兜底，防某操作路径漏重绘） */
  useEffect(() => {
    redrawMarks();
  }, [marks, selMarkId, redrawMarks]);

  /** client 坐标 → 图像像素坐标 */
  const toImagePos = useCallback(
    (clientX: number, clientY: number) => {
      const r = boxRef.current!.getBoundingClientRect();
      return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
    },
    [scale],
  );

  // 加载整屏快照并计算适配缩放
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      originalRef.current = img;
      const canvas = getCanvas()!;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      getCtx().drawImage(img, 0, 0);
      // 标注覆盖层同步尺寸（透明，叠主画布上）
      const mc = markCanvasRef.current;
      if (mc) {
        mc.width = img.naturalWidth;
        mc.height = img.naturalHeight;
      }
      setNat({ w: img.naturalWidth, h: img.naturalHeight });
      // 缩放基准：画面 CSS 尺寸 = **屏幕逻辑尺寸**（与真实界面 1:1），而不是窗口尺寸。
      // 窗口若被建成物理尺寸（Electron display.bounds 的单位问题），拿窗口做基准会把画面
      // 缩到屏幕中间并留白——即用户反馈的「蒙版在中间、比真实屏幕小」。
      const dpr = window.devicePixelRatio || 1;
      // 1) 优先：助手给的屏幕点尺寸。**必须是「画面所属那一屏」的尺寸**，不是所有屏幕的并集——
      //    多屏时画面只含一屏（screencapture -D），拿并集做基准会把画面缩到窗口里、与真实界面对不齐。
      let targetW = viewBase?.w ?? 0;
      let targetH = viewBase?.h ?? 0;
      // 2) 回退：window.screen（CSS 逻辑像素，单屏权威）
      if (!(targetW > 0) || !(targetH > 0)) {
        targetW = window.screen?.width || window.innerWidth;
        targetH = window.screen?.height || window.innerHeight;
      }
      const fit = Math.min(targetW / img.naturalWidth, targetH / img.naturalHeight);
      // 小图（region 选区截图，没有窗口几何）不超过 1:1，避免 Retina 下被放大变糊
      const sc = geometry ? fit : Math.min(fit, 1 / dpr);
      setScale(sc);
      // 埋点：尺寸与缩放现场数据（覆盖窗口 console 会转发到 ~/.bobwork-renderer.log，前缀 OCR-WIN）
      console.log(
        `[ocr-perf] nat=${img.naturalWidth}x${img.naturalHeight} inner=${window.innerWidth}x${window.innerHeight} ` +
          `screen=${window.screen?.width ?? 0}x${window.screen?.height ?? 0} target=${Math.round(targetW)}x${Math.round(targetH)} dpr=${dpr} ` +
          `fit=${fit.toFixed(4)} scale=${sc.toFixed(4)} shown=${Math.round(img.naturalWidth * sc)}x${Math.round(img.naturalHeight * sc)} ` +
          `screens=${geometry?.screens?.length ?? 0} screenIndex=${screenIndex ?? 'null'} regions=${geometry?.regions?.length ?? 0} windows=${geometry?.windows?.length ?? 0}`,
      );
      // 原生选区已完成（region 模式）：整图直接全选区，进入编辑态立即出工具条（微信式）
      if (initialSelection === 'full') {
        setSelBoth({ x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight });
        setPhase('edit');
      }
    };
    img.src = dataUrl;
  }, [dataUrl, getCanvas, getCtx, initialSelection, setSelBoth, geometry, viewBase, screenIndex]);

  /** 把当前画面（主画布像素 + 标注对象）压入撤销栈，清空重做栈 */
  const pushUndo = useCallback(() => {
    const canvas = getCanvas()!;
    undoRef.current.push({ img: getCtx().getImageData(0, 0, canvas.width, canvas.height), marks: marksRef.current.slice() });
    if (undoRef.current.length > MAX_HISTORY) undoRef.current.shift();
    redoRef.current = [];
    refreshStates();
  }, [getCanvas, getCtx, refreshStates]);

  /** 恢复一份快照（主画布像素 + 标注对象 → 重绘覆盖层） */
  const restoreSnapshot = useCallback(
    (snap: Snap) => {
      const canvas = getCanvas()!;
      canvas.width = snap.img.width;
      canvas.height = snap.img.height;
      getCtx().putImageData(snap.img, 0, 0);
      setMarksBoth(snap.marks);
      setSelMarkIdBoth(null);
      redrawMarks();
    },
    [getCanvas, getCtx, setMarksBoth, setSelMarkIdBoth, redrawMarks],
  );

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    const canvas = getCanvas()!;
    redoRef.current.push({ img: getCtx().getImageData(0, 0, canvas.width, canvas.height), marks: marksRef.current.slice() });
    restoreSnapshot(prev);
    refreshStates();
  }, [getCanvas, getCtx, restoreSnapshot, refreshStates]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    const canvas = getCanvas()!;
    undoRef.current.push({ img: getCtx().getImageData(0, 0, canvas.width, canvas.height), marks: marksRef.current.slice() });
    restoreSnapshot(next);
    refreshStates();
  }, [getCanvas, getCtx, restoreSnapshot, refreshStates]);

  const reset = useCallback(() => {
    const img = originalRef.current;
    if (!img) return;
    const canvas = getCanvas()!;
    pushUndo();
    redoRef.current = [];
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    getCtx().drawImage(img, 0, 0);
    setMarksBoth([]);
    setSelMarkIdBoth(null);
    redrawMarks();
    refreshStates();
  }, [getCanvas, getCtx, pushUndo, setMarksBoth, setSelMarkIdBoth, redrawMarks, refreshStates]);

  /** 提交文字草稿：把文本画到内容画布（空文本直接丢弃） */
  const commitTextDraft = useCallback(
    (d: TextDraft) => {
      setTextDraftBoth(null);
      const v = d.value.trim();
      // 纯文字工具：空文本直接丢弃；下划线批注：即使没写字也保留横线（只划线不批注是合理用法）
      if (!v && !d.underline) {
        redrawMarks();
        return;
      }
      // 对象化：入标注列表（渲染在覆盖层），可点选/拖动/删除。
      // 携带 underline 时落定为「下划线批注」（横线 + 线下文字 = 一个整体对象）
      pushUndo();
      const id = markIdRef.current++;
      const next: Mark = d.underline
        ? {
            kind: 'underline',
            id,
            x: Math.round(d.underline.x),
            y: Math.round(d.underline.y),
            w: Math.round(d.underline.w),
            value: v,
            // 文字气泡锚点 = 划线结束处（与落定时输入框位置一致）
            textX: Math.round(d.x),
          }
        : { kind: 'text', id, x: Math.round(d.x), y: Math.round(d.y), value: v };
      setMarksBoth([...marksRef.current, next]);
      redrawMarks();
    },
    [setTextDraftBoth, redrawMarks, pushUndo, setMarksBoth],
  );

  /** 切换工具：若有未提交的文字草稿先落定（防残留输入框/状态混乱） */
  const switchTool = useCallback(
    (t: Tool) => {
      if ((tool === 'text' || tool === 'underline') && textDraftRef.current) commitTextDraft(textDraftRef.current);
      setTool(t);
    },
    [tool, commitTextDraft],
  );

  /** 马赛克：把以 (cx,cy) 为圆心、radius 半径内的像素按 MOSAIC_BLOCK 网格块化（每块取平均色） */
  const paintMosaicAt = useCallback(
    (cx: number, cy: number, radius: number) => {
      const canvas = getCanvas()!;
      const ctx = getCtx();
      const { width, height } = canvas;
      // 只读写画笔覆盖区域（局部 getImageData）：整图拷贝会让涂抹滞后于光标、产生偏移感
      const x0 = Math.max(0, Math.floor((cx - radius) / MOSAIC_BLOCK) * MOSAIC_BLOCK);
      const y0 = Math.max(0, Math.floor((cy - radius) / MOSAIC_BLOCK) * MOSAIC_BLOCK);
      const x1 = Math.min(width, Math.ceil((cx + radius) / MOSAIC_BLOCK) * MOSAIC_BLOCK);
      const y1 = Math.min(height, Math.ceil((cy + radius) / MOSAIC_BLOCK) * MOSAIC_BLOCK);
      const rw = x1 - x0;
      const rh = y1 - y0;
      if (rw <= 0 || rh <= 0) return;
      const imgData = ctx.getImageData(x0, y0, rw, rh);
      const d = imgData.data;
      for (let by = 0; by < rh; by += MOSAIC_BLOCK) {
        for (let bx = 0; bx < rw; bx += MOSAIC_BLOCK) {
          // 圆形画笔：块中心超出半径则跳过，不误伤画笔外的像素（涂抹更精准）
          const bcx = x0 + bx + MOSAIC_BLOCK / 2;
          const bcy = y0 + by + MOSAIC_BLOCK / 2;
          if (Math.hypot(bcx - cx, bcy - cy) > radius + MOSAIC_BLOCK / 2) continue;
          const bEndY = Math.min(by + MOSAIC_BLOCK, rh);
          const bEndX = Math.min(bx + MOSAIC_BLOCK, rw);
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let y = by; y < bEndY; y++) {
            for (let x = bx; x < bEndX; x++) {
              const i = (y * rw + x) * 4;
              r += d[i];
              g += d[i + 1];
              b += d[i + 2];
              n++;
            }
          }
          if (n > 0) {
            r /= n;
            g /= n;
            b /= n;
          }
          for (let y = by; y < bEndY; y++) {
            for (let x = bx; x < bEndX; x++) {
              const i = (y * rw + x) * 4;
              d[i] = r;
              d[i + 1] = g;
              d[i + 2] = b;
            }
          }
        }
      }
      ctx.putImageData(imgData, x0, y0);
    },
    [getCanvas, getCtx],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const pos = toImagePos(e.clientX, e.clientY);
      // 临时诊断：文字工具点击是否到达、换算坐标是否有效
      // 文字：提交进行中的草稿（如有）→ 在点击处开新输入框（不进入拖拽）
      if (tool === 'text') {
        if (textDraftRef.current) commitTextDraft(textDraftRef.current);
        setTextDraftBoth({ x: pos.x, y: pos.y, value: '' });
        return;
      }
      // 下划线批注：水平拖拽画横线 → 松开即在横线下方开输入框（线 + 文字一次成型）
      if (tool === 'underline') {
        if (textDraftRef.current) commitTextDraft(textDraftRef.current);
        setSelMarkIdBoth(null);
        dragRef.current = { mode: 'underline', startX: pos.x, startY: pos.y, curX: pos.x, curY: pos.y, sel0: { x: 0, y: 0, w: 0, h: 0 } };
        setDragMode('underline');
        setDragging(true);
        return;
      }
      // 箭头：拖拽预览（画标注层）→ 松开落定（对象化，一次箭头一个撤销步）
      if (tool === 'arrow') {
        setSelMarkIdBoth(null);
        dragRef.current = { mode: 'arrow', startX: pos.x, startY: pos.y, curX: pos.x, curY: pos.y, sel0: { x: 0, y: 0, w: 0, h: 0 } };
        setDragMode('arrow');
        setDragging(true);
        return;
      }
      // 马赛克：直接涂抹（一次笔画一个撤销步）
      if (tool === 'mosaic') {
        dragRef.current = { mode: 'mosaic', startX: pos.x, startY: pos.y, curX: pos.x, curY: pos.y, sel0: selRef.current ?? { x: 0, y: 0, w: 0, h: 0 }, lastX: pos.x, lastY: pos.y };
        setDragMode('mosaic');
        pushUndo();
        paintMosaicAt(pos.x, pos.y, mosaicRadius);
        setDragging(true);
        return;
      }
      // select：优先命中标注对象（文字/箭头）→ 选中并拖动；未命中才走选区逻辑
      if (tool === 'select') {
        const mc = markCanvasRef.current;
        if (mc) {
          const hit = hitTestMark(mc.getContext('2d')!, marksRef.current, pos.x, pos.y);
          if (hit) {
            if (selMarkIdRef.current !== hit.id) setSelMarkIdBoth(hit.id);
            redrawMarks();
            // 拖动前压栈（含对象快照）→ 一次撤销步撤销整段移动
            pushUndo();
            dragRef.current = {
              mode: 'markMove',
              markId: hit.id,
              markFrom: hit,
              startX: pos.x,
              startY: pos.y,
              curX: pos.x,
              curY: pos.y,
              sel0: selRef.current ?? { x: 0, y: 0, w: 0, h: 0 },
            };
            setDragMode('markMove');
            setDragging(true);
            return;
          }
          setSelMarkIdBoth(null);
        }
      }
      // select：点击选区内 → 移动选区；选区外 → 重新拉框
      const s = selRef.current;
      if (phase === 'edit' && s && pos.x >= s.x && pos.x <= s.x + s.w && pos.y >= s.y && pos.y <= s.y + s.h) {
        dragRef.current = { mode: 'move', startX: pos.x, startY: pos.y, curX: pos.x, curY: pos.y, sel0: { ...s } };
        setDragMode('move');
        setDragging(true);
        return;
      }
      dragRef.current = { mode: 'select', startX: pos.x, startY: pos.y, curX: pos.x, curY: pos.y, sel0: { x: pos.x, y: pos.y, w: 0, h: 0 } };
      setDragMode('select');
      setSelBoth({ x: pos.x, y: pos.y, w: 0, h: 0 });
      setDragging(true);
    },
    [toImagePos, tool, phase, mosaicRadius, pushUndo, paintMosaicAt, setSelBoth, commitTextDraft, setTextDraftBoth, redrawMarks, setSelMarkIdBoth],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d.mode) return;
      const pos = toImagePos(e.clientX, e.clientY);
      const canvas = getCanvas()!;
      d.curX = pos.x;
      d.curY = pos.y;
      if (d.mode === 'select') {
        const x = Math.min(d.startX, pos.x);
        const y = Math.min(d.startY, pos.y);
        setSelBoth({ x, y, w: Math.abs(pos.x - d.startX), h: Math.abs(pos.y - d.startY) });
      } else if (d.mode === 'move') {
        const s0 = d.sel0;
        setSelBoth(clampMove({ ...s0, x: s0.x + (pos.x - d.startX), y: s0.y + (pos.y - d.startY) }, canvas.width, canvas.height));
      } else if (d.mode === 'resize') {
        const s0 = d.sel0;
        setSelBoth(resizeSel(s0, d.handle!, pos, canvas.width, canvas.height));
      } else if (d.mode === 'mosaic') {
        // 相邻采样点间插值补点：快速拖动时不留未打码的断层
        const lx = d.lastX ?? pos.x;
        const ly = d.lastY ?? pos.y;
        const dist = Math.hypot(pos.x - lx, pos.y - ly);
        const step = Math.max(1, mosaicRadius * 0.5);
        const n = Math.max(1, Math.ceil(dist / step));
        for (let i = 1; i <= n; i++) {
          paintMosaicAt(lx + (pos.x - lx) * (i / n), ly + (pos.y - ly) * (i / n), mosaicRadius);
        }
        d.lastX = pos.x;
        d.lastY = pos.y;
      } else if (d.mode === 'underline') {
        // 预览：只取水平分量（下划线恒为水平线，y 固定为按下点）
        redrawMarks();
        const mc = markCanvasRef.current;
        if (mc) {
          const x = Math.min(d.startX, pos.x);
          drawUnderline(mc.getContext('2d')!, x, d.startY, Math.abs(pos.x - d.startX));
        }
      } else if (d.mode === 'arrow') {
        // 预览：标注层重绘 marks + 拖拽中的箭头
        redrawMarks();
        const mc = markCanvasRef.current;
        if (mc) drawArrow(mc.getContext('2d')!, d.startX, d.startY, pos.x, pos.y);
      } else if (d.mode === 'markMove') {
        // 拖动标注对象：按命中时原坐标 + 偏移更新
        const from = d.markFrom;
        if (from) {
          const dx = pos.x - d.startX;
          const dy = pos.y - d.startY;
          setMarksBoth(
            marksRef.current.map((m) => {
              if (m.id !== d.markId) return m;
              if (m.kind === 'text' && from.kind === 'text')
                return { ...m, x: Math.max(0, Math.round(from.x + dx)), y: Math.max(0, Math.round(from.y + dy)) };
              // 下划线批注整体移动：横线与文字同步偏移（线长不变，锚点同步偏移）
              if (m.kind === 'underline' && from.kind === 'underline')
                return {
                  ...m,
                  x: Math.max(0, Math.round(from.x + dx)),
                  y: Math.max(0, Math.round(from.y + dy)),
                  textX:
                    from.textX === undefined ? undefined : Math.max(0, Math.round(from.textX + dx)),
                };
              if (m.kind === 'arrow' && from.kind === 'arrow')
                return {
                  ...m,
                  x1: Math.max(0, Math.round(from.x1 + dx)),
                  y1: Math.max(0, Math.round(from.y1 + dy)),
                  x2: Math.max(0, Math.round(from.x2 + dx)),
                  y2: Math.max(0, Math.round(from.y2 + dy)),
                };
              return m;
            }),
          );
          redrawMarks();
        }
      }
    },
    [toImagePos, getCanvas, mosaicRadius, paintMosaicAt, setSelBoth, redrawMarks, setMarksBoth],
  );

  /** 复位拖拽状态（指针取消/丢失兜底，防止 dragging 卡死导致工具条不弹） */
  const resetDrag = useCallback(() => {
    dragRef.current = { mode: null, startX: 0, startY: 0, curX: 0, curY: 0, sel0: { x: 0, y: 0, w: 0, h: 0 } };
    setDragMode(null);
    setDragging(false);
  }, []);

  /** 指针被系统取消（窗口失焦/系统抢占）：复位拖拽；若选区已成型则直接进入编辑态，工具条照常弹出 */
  const onPointerCancel = useCallback(() => {
    const d = dragRef.current;
    if (d.mode === 'select') {
      const s = selRef.current;
      if (s && s.w >= MIN_SEL && s.h >= MIN_SEL) setPhase('edit');
    } else if (d.mode === 'arrow' || d.mode === 'underline' || d.mode === 'markMove') {
      // 取消未落定操作：清预览、恢复原标注层
      redrawMarks();
    }
    resetDrag();
  }, [resetDrag, redrawMarks]);

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (!d.mode) return;
    if (d.mode === 'select') {
      const s = selRef.current;
      const moved = Math.hypot(d.curX - d.startX, d.curY - d.startY);
      // 点击（几乎无位移）且命中吸附目标 → 微信式：一次点击选中整个窗口 / 菜单栏 / Dock
      if (moved < 6 && hoverTargetRef.current) {
        selectTarget(hoverTargetRef.current);
      } else if (s && s.w >= MIN_SEL && s.h >= MIN_SEL) {
        setPhase('edit');
      } else {
        setSelBoth(null);
      }
    } else if (d.mode === 'underline') {
      // 落定横线：达到最短长度 → 自动在横线下方开输入框（先不建 mark，等文字提交后线+文字合成一个对象）
      const x = Math.min(d.startX, d.curX);
      const w = Math.abs(d.curX - d.startX);
      if (w >= MIN_UNDERLINE) {
        const fs = nat ? markFontSize(nat.w) : 24;
        // 输入框锚在**划线结束处**（松手点 d.curX），左往右划则在右端、右往左划则在左端
        setTextDraftBoth({
          x: d.curX,
          y: d.startY + underlineTextOffset(fs),
          value: '',
          underline: { x, y: d.startY, w },
        });
      }
      redrawMarks();
    } else if (d.mode === 'arrow') {
      // 落定箭头（对象化）：有效线段 → 入标注列表 + 一次撤销步；过短则丢弃（清预览）
      if (Math.hypot(d.curX - d.startX, d.curY - d.startY) >= 6) {
        pushUndo();
        setMarksBoth([
          ...marksRef.current,
          { kind: 'arrow', id: markIdRef.current++, x1: Math.round(d.startX), y1: Math.round(d.startY), x2: Math.round(d.curX), y2: Math.round(d.curY) },
        ]);
      }
      redrawMarks();
    } else if (d.mode === 'markMove') {
      // 标注对象拖动结束：pushUndo 已在按下时记录拖动前状态（撤销一次移动）
      setSelMarkIdBoth(d.markId ?? null);
    }
    resetDrag();
  }, [setSelBoth, pushUndo, setMarksBoth, redrawMarks, setSelMarkIdBoth, resetDrag, selectTarget, nat, setTextDraftBoth]);

  /** 未拖拽时的指针移动：窗口吸附 hover 高亮（仅 select 工具 + 有吸附目标时） */
  const onRootPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragRef.current.mode) return; // 拖拽中不改 hover，避免干扰自由框选
      if (tool !== 'select' || snapTargets.length === 0) {
        if (hoverTargetRef.current) setHoverTargetBoth(null);
        return;
      }
      const pos = toImagePos(e.clientX, e.clientY);
      setHoverTargetBoth(hitTarget(pos.x, pos.y));
    },
    [tool, snapTargets.length, hitTarget, toImagePos, setHoverTargetBoth],
  );

  /** 缩放手柄按下（阻止冒泡到画布），捕获指针以便移出元素后继续 */
  const onHandleDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      e.stopPropagation();
      e.preventDefault();
      boxRef.current?.setPointerCapture(e.pointerId);
      const s = selRef.current;
      if (!s) return;
      dragRef.current = { mode: 'resize', handle: id, startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY, sel0: { ...s } };
      setDragMode('resize');
      setDragging(true);
    },
    [],
  );

  // 快捷键：Esc 取消 / Cmd(Ctrl)+Z 撤销 / Cmd(Ctrl)+Shift+Z 或 Cmd(Ctrl)+Y 重做。
  // 用捕获阶段 + stopImmediatePropagation：编辑覆盖层打开时不把按键泄漏给下层画布。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        e.stopImmediatePropagation();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selMarkIdRef.current) {
        // 删除选中的标注对象（文字/箭头）
        e.preventDefault();
        e.stopImmediatePropagation();
        pushUndo();
        setMarksBoth(marksRef.current.filter((m) => m.id !== selMarkIdRef.current));
        setSelMarkIdBoth(null);
        redrawMarks();
      } else if (e.key === 'Tab' && snapTargets.length > 0) {
        // 微信式：Tab 在窗口 / 菜单栏 / Dock 之间轮换吸附选中
        e.preventDefault();
        e.stopImmediatePropagation();
        const cur = hoverTargetRef.current;
        const idx = cur ? snapTargets.findIndex((t) => t.id === cur.id) : -1;
        const next = snapTargets[(idx + 1) % snapTargets.length];
        setHoverTargetBoth(next);
        selectTarget(next);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        // 文字输入中按 Esc：丢弃草稿，留在编辑器
        if (textDraftRef.current) {
          setTextDraftBoth(null);
          redrawMarks(); // 清掉草稿态（含下划线批注的待落定横线预览）
          return;
        }
        // 有选中标注对象：先取消选中（再按 Esc 才退出）
        if (selMarkIdRef.current) {
          setSelMarkIdBoth(null);
          redrawMarks();
          return;
        }
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo, redo, onCancel, setTextDraftBoth, pushUndo, setMarksBoth, setSelMarkIdBoth, redrawMarks, snapTargets, setHoverTargetBoth, selectTarget]);

  /** 按选区裁剪内容画布 → dataUrl（选区无效返回 null；输出带圆角，透明角） */
  const cropToDataUrl = useCallback((): string | null => {
    const s = selRef.current;
    if (!s || s.w < MIN_SEL || s.h < MIN_SEL) return null;
    const canvas = getCanvas()!;
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    const w = Math.round(s.w);
    const h = Math.round(s.h);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d')!;
    // 圆角裁剪：四个角透明，与选区高亮框的圆角一致（r 超界自动收敛）
    const r = Math.max(2, Math.min(SEL_RADIUS, w / 2, h / 2));
    ctx.beginPath();
    // 兼容兜底：极旧 Chromium 无 roundRect 时退化为直角裁剪（避免裁剪抛错导致面板不弹）
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(0, 0, w, h, r);
    } else {
      ctx.rect(0, 0, w, h);
    }
    ctx.clip();
    // 合成：主画布（原图+马赛克）→ 标注覆盖层（文字/箭头）
    ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    const mc = markCanvasRef.current;
    if (mc) {
      // 临时去除选中高亮（虚线框只用于编辑定位，不应进导出/OCR 图）
      const selId = selMarkIdRef.current;
      if (selId != null) {
        selMarkIdRef.current = null;
        redrawMarks();
      }
      ctx.drawImage(mc, x, y, w, h, 0, 0, w, h);
      if (selId != null) {
        selMarkIdRef.current = selId;
        redrawMarks();
      }
    }
    return out.toDataURL('image/png');
  }, [getCanvas, redrawMarks]);

  /** ✓：复制选区图片（父层处理剪贴板） */
  const handleDone = useCallback(() => {
    const d = cropToDataUrl();
    if (d) onDone(d);
  }, [cropToDataUrl, onDone]);

  /** To Text：裁剪选区 → OCR → 弹窗展示可编辑文本 */
  const handleToText = useCallback(() => {
    const d = cropToDataUrl();
    if (!d) return;
    setOcrPopup({ dataUrl: d, text: '', loading: true, copied: false });
    void onOcr(d).then((r) => {
      setOcrPopup((p) =>
        p && p.dataUrl === d
          ? { ...p, text: r.ok ? (r.text ?? '') : p.text, error: r.ok ? undefined : r.error, loading: false }
          : p,
      );
    });
  }, [cropToDataUrl, onOcr]);

  /** 一键复制 OCR 文本 → 关闭编辑器（临时截图由主进程清理） */
  const handleCopyText = useCallback(() => {
    setOcrPopup((p) => (p ? { ...p, copied: true } : p));
    const text = ocrPopup?.text ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      window.setTimeout(onCancel, 500);
    });
  }, [ocrPopup?.text, onCancel]);

  // 浮动工具条位置：选区下方居中，越界翻转到上方，再钳制到窗口内。
  // 图像框在根容器中居中（flex center），窗口坐标可直接由 nat*scale 几何推导，无需读 DOM。
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarW, setToolbarW] = useState(TOOLBAR_W);
  // 工具条实测宽度（内容随工具/撤销态变化：✕✓、OCR 按钮等），渲染后测量更新
  useLayoutEffect(() => {
    if (toolbarRef.current) {
      const w = toolbarRef.current.clientWidth;
      if (w > 0) setToolbarW(w);
    }
  }, [tool, sel, dragging, canUndo, canRedo, phase, textDraft]);
  const barPos = (() => {
    if (!sel || !nat) return { left: 12, top: 12 };
    const boxW = nat.w * scale;
    const boxH = nat.h * scale;
    // 与根容器对齐方式保持一致：整屏链路左上角对齐（偏移 0），小图居中
    const offX = geometry ? 0 : (window.innerWidth - boxW) / 2;
    const offY = geometry ? 0 : (window.innerHeight - boxH) / 2;
    const sx = offX + sel.x * scale;
    const sy = offY + sel.y * scale;
    const sw = sel.w * scale;
    const sh = sel.h * scale;
    const barH = 44;
    const tw = toolbarW;
    let left = sx + sw / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = sy + sh + 14;
    if (top + barH > window.innerHeight - 8) top = sy - 14 - barH;
    if (top < 8) top = 8;
    return { left, top };
  })();

  /** OCR 面板位置：吸附在浮动工具条正下方居中（越界翻到工具条上方），与工具条一体化 */
  const ocrPanelPos = (() => {
    if (!sel || !nat) return { left: 12, top: 12, width: 300 };
    const W = 300;
    const barH = 44;
    let left = barPos.left + toolbarW / 2 - W / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
    let top = barPos.top + barH + 8;
    if (top + 300 > window.innerHeight - 8) top = barPos.top - 8 - 300;
    if (top < 8) top = 8;
    return { left, top, width: W };
  })();

  // 画布光标：文字 → text；马赛克/拉框 → 十字；移动/缩放手柄拖拽 → move
  const canvasCursor =
    tool === 'text'
      ? 'text'
      : tool === 'mosaic'
        ? 'crosshair'
        : dragMode === 'move' || dragMode === 'resize'
          ? 'move'
          : 'crosshair';

  /** 输入草稿框的内边距（图像像素）：与气泡一致，保证打字时所见 = 落定后所见 */
  const draftPad = textBubblePadding(nat ? markFontSize(nat.w) : 24);

  const toolBtn = (active: boolean, disabled = false): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 30,
    borderRadius: 8,
    border: 'none',
    background: active ? 'var(--primary)' : 'transparent',
    color: active ? '#fff' : 'rgba(255,255,255,0.85)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    transition: 'background 0.12s, opacity 0.12s',
  });

  return (
    <div
      data-screen-ocr-editor="true"
      onPointerMove={onRootPointerMove}
      style={{
        position: 'fixed',
        inset: 0,
        // 置顶：高于 WantedNoticeCenter(2147483000) 等所有可见弹层，截图编辑时不被遮挡
        zIndex: 2147483001,
        // 半透明暗色（微信截图式）：透出底层界面，避免 -i 选区小图在纯黑背景下形成"整屏漆黑"
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        // 整屏链路：左上角对齐（画面左上角 = 屏幕左上角，保证与真实界面原位重合）；
        // 小图（region 选区截图）仍居中，避免缩在角落
        alignItems: geometry ? 'flex-start' : 'center',
        justifyContent: geometry ? 'flex-start' : 'center',
        fontFamily: 'var(--font-sans)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        touchAction: 'none',
      }}
    >
      {/* 图像框（内容画布 + 选区覆盖层） */}
      <div
        ref={boxRef}
        style={{
          position: 'relative',
          cursor: canvasCursor,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            width: nat ? nat.w * scale : undefined,
            height: nat ? nat.h * scale : undefined,
          }}
        />
        {/* 标注覆盖层（文字/箭头对象，透明叠主画布上；事件统一走 boxRef 命中检测） */}
        <canvas
          ref={markCanvasRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: nat ? nat.w * scale : undefined,
            height: nat ? nat.h * scale : undefined,
            pointerEvents: 'none',
          }}
        />

        {/* 无选区时：整屏蒙版（微信截图式，进入即变暗，选区出现后由 box-shadow 接管） */}
        {!sel && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(128,128,128,0.55)',
              pointerEvents: 'none',
            }}
          />
        )}

        {/* 窗口吸附 hover 高亮：未形成选区时提示，点击即选中整个窗口 / 菜单栏 / Dock */}
        {hoverTarget && !sel && (
          <div
            style={{
              position: 'absolute',
              left: hoverTarget.x * scale,
              top: hoverTarget.y * scale,
              width: hoverTarget.w * scale,
              height: hoverTarget.h * scale,
              border: '2px solid rgba(75,63,227,0.95)',
              borderRadius: 4,
              background: 'rgba(75,63,227,0.12)',
              pointerEvents: 'none',
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: -22,
                padding: '2px 8px',
                borderRadius: 8,
                background: 'rgba(75,63,227,0.95)',
                color: '#fff',
                fontSize: '0.7rem',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {hoverTarget.label}
            </span>
          </div>
        )}

        {/* 选区高亮块：box-shadow 暗角其余区域（微信截图式） */}
        {sel && (
          <div
            style={{
              position: 'absolute',
              left: sel.x * scale,
              top: sel.y * scale,
              width: sel.w * scale,
              height: sel.h * scale,
              border: '1px solid rgba(255,255,255,0.95)',
              borderRadius: SEL_RADIUS * scale,
              boxShadow: '0 0 0 9999px rgba(128,128,128,0.55)',
              cursor: tool === 'select' && phase === 'edit' ? 'move' : 'default',
            }}
          >
            {/* 尺寸标注（左上角，圆角胶囊） */}
            {sel.w > 0 && sel.h > 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: -26,
                  padding: '3px 10px',
                  borderRadius: 9,
                  background: 'rgba(75,63,227,0.95)',
                  color: '#fff',
                  fontSize: '0.733333rem',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {Math.round(sel.w)} × {Math.round(sel.h)}
              </div>
            )}

            {/* 缩放手柄（仅编辑态且非拖拽中显示） */}
            {phase === 'edit' &&
              !dragging &&
              HANDLES.map((hd) => (
                <div
                  key={hd.id}
                  onPointerDown={(e) => onHandleDown(e, hd.id)}
                  style={{
                    position: 'absolute',
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: '#fff',
                    border: '1px solid rgba(0,0,0,0.35)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                    ...hd.style,
                  }}
                />
              ))}
          </div>
        )}

        {/* 文字工具：输入草稿（点击处输入，Enter/失焦落定） */}
        {textDraft && (
          <textarea
            value={textDraft.value}
            ref={(el) => {
              if (el) {
                textMountTs.current = Date.now();
                // 挂载后聚焦（覆盖窗口可能刚激活，延迟一拍确保成为 key window 后聚焦有效）
                requestAnimationFrame(() => {
                  try {
                    el.focus();
                  } catch { /* ignore */ }
                });
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setTextDraftBoth({ ...textDraft, value: e.target.value })}
            onBlur={() => {
              // 挂载初期误失焦保护：窗口激活竞态导致的瞬失焦不落定（否则输入框刚出现就消失）
              if (Date.now() - textMountTs.current < 400) return;
              if (textDraftRef.current) commitTextDraft(textDraftRef.current);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTextDraft(textDraft);
              }
            }}
            style={{
              position: 'absolute',
              // 输入框外框 = 气泡外框（左/上按内边距外扩、padding 一致），
              // 保证「打字时所见」与「落定后的气泡」位置与观感完全一致
              left: (textDraft.x - draftPad.x) * scale,
              top: (textDraft.y - draftPad.y) * scale,
              width:
                Math.max(60, Math.min(320 * scale, nat ? (nat.w - textDraft.x) * scale : 320 * scale)) +
                draftPad.x * scale * 2,
              padding: `${Math.max(1, draftPad.y * scale)}px ${Math.max(1, draftPad.x * scale)}px`,
              border: `1.5px solid ${MARK_COLOR}`,
              borderRadius: Math.max(3, draftPad.radius * scale),
              background: MARK_TEXT_BG,
              color: MARK_COLOR,
              fontSize: (nat ? markFontSize(nat.w) : 24) * scale,
              fontWeight: 600,
              lineHeight: 1.3,
              fontFamily: MARK_FONT_FAMILY,
              outline: 'none',
              resize: 'none',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
              zIndex: 6,
            }}
          />
        )}

        {/* 浮动工具条（松开鼠标后弹出，选区下方居中） */}
        {phase === 'edit' && sel && !dragging && (
          <div
            ref={toolbarRef}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: barPos.left,
              top: barPos.top,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              padding: 6,
              borderRadius: 12,
              background: 'rgba(28,28,30,0.92)',
              boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
              zIndex: 20,
            }}
          >
            <button style={toolBtn(tool === 'select')} onClick={() => switchTool('select')} title="Select / move (default)">
              <Move className="h-4 w-4" />
            </button>
            <button style={toolBtn(tool === 'mosaic')} onClick={() => switchTool('mosaic')} title="Mosaic: paint to blur">
              <MosaicIcon />
            </button>
            {tool === 'mosaic' && (
              <>
                {MOSAIC_BRUSH_STEPS.map((_, i) => (
                  <button
                    key={i}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      border: 'none',
                      background: mosaicStep === i ? 'rgba(255,255,255,0.22)' : 'transparent',
                      color: mosaicStep === i ? '#fff' : 'rgba(255,255,255,0.75)',
                      cursor: 'pointer',
                    }}
                    onClick={() => setMosaicStep(i)}
                    title={`Brush size: ${['Fine', 'Medium', 'Thick'][i]}`}
                  >
                    <span
                      style={{
                        display: 'block',
                        width: [6, 10, 15][i],
                        height: [6, 10, 15][i],
                        borderRadius: '50%',
                        background: 'currentColor',
                      }}
                    />
                  </button>
                ))}
                <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.18)', margin: '0 4px' }} />
              </>
            )}
            <button style={toolBtn(tool === 'arrow')} onClick={() => switchTool('arrow')} title="Arrow: drag to draw (hand-drawn sketch)">
              <ArrowUpRight className="h-4 w-4" />
            </button>
            <button style={toolBtn(tool === 'text')} onClick={() => switchTool('text')} title="Text: click to add text">
              <Type className="h-4 w-4" />
            </button>
            <button
              style={toolBtn(tool === 'underline')}
              onClick={() => switchTool('underline')}
              title="Underline: drag a line, then type the note right below it"
            >
              <Underline className="h-4 w-4" />
            </button>
            <button
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'rgba(255,255,255,0.9)',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}
              onClick={handleToText}
              title="OCR the selection into editable text"
            >
              <ScanText className="h-4 w-4" />
              OCR
            </button>
            <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.18)', margin: '0 6px' }} />
            <button style={toolBtn(false, !canUndo)} onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
              <Undo2 className="h-4 w-4" />
            </button>
            <button style={toolBtn(false, !canRedo)} onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)">
              <Redo2 className="h-4 w-4" />
            </button>
            <button style={toolBtn(false, !canUndo && !canRedo)} onClick={reset} disabled={!canUndo && !canRedo} title="Reset edits">
              <RotateCcw className="h-4 w-4" />
            </button>
            <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.18)', margin: '0 6px' }} />
            {/* ✕ 放弃 / ✓ 确认复制（随选区工具条，操作就近；不再固定悬浮在屏幕右下角） */}
            <button
              onClick={onCancel}
              title="Cancel (Esc)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 30,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'rgba(255,255,255,0.9)',
                cursor: 'pointer',
                transition: 'background 0.12s',
              }}
              onPointerEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
              onPointerLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <X className="h-4 w-4" />
            </button>
            <button
              onClick={handleDone}
              disabled={!sel || sel.w < MIN_SEL || sel.h < MIN_SEL}
              title="Confirm & copy (✓)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 30,
                borderRadius: 8,
                border: 'none',
                background: '#21c45d',
                color: '#fff',
                cursor: sel && sel.w >= MIN_SEL && sel.h >= MIN_SEL ? 'pointer' : 'not-allowed',
                opacity: sel && sel.w >= MIN_SEL && sel.h >= MIN_SEL ? 1 : 0.45,
                transition: 'opacity 0.12s',
              }}
            >
              <Check className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* OCR 侧面板：吸附在工具条下方，白色面板（可编辑、可复制） */}
      {ocrPopup && (
        <div
          style={{
            position: 'fixed',
            left: ocrPanelPos.left,
            top: ocrPanelPos.top,
            width: ocrPanelPos.width,
            maxHeight: '70vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: '#ffffff',
            color: '#171717',
            borderRadius: 12,
            border: '1px solid rgba(23,23,23,0.1)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
            zIndex: 1400,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              borderBottom: '1px solid rgba(23,23,23,0.08)',
            }}
          >
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#171717' }}>
              {ocrPopup.loading ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Loader2 className="h-3.5 w-3.5" style={{ animation: 'spin 1s linear infinite' }} />
                  OCR…
                </span>
              ) : ocrPopup.error ? (
                <span style={{ color: '#dc2626' }}>OCR failed</span>
              ) : (
                'OCR'
              )}
            </span>
            <button
              onClick={() => setOcrPopup(null)}
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: '#8e8e98',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <textarea
            value={ocrPopup.text}
            onChange={(e) => setOcrPopup((p) => (p ? { ...p, text: e.target.value } : p))}
            placeholder={ocrPopup.error ? 'No text recognized — you can type manually.' : undefined}
            autoFocus
            spellCheck={false}
            style={{
              flex: 1,
              minHeight: 120,
              padding: 10,
              border: 'none',
              background: '#fafafa',
              color: '#171717',
              fontSize: '0.833333rem',
              lineHeight: 1.6,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              outline: 'none',
            }}
          />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
              padding: '10px 12px',
              borderTop: '1px solid rgba(23,23,23,0.08)',
            }}
          >
            <button
              onClick={() => setOcrPopup(null)}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                border: '1px solid rgba(23,23,23,0.15)',
                background: '#f5f5f7',
                color: '#171717',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleCopyText}
              disabled={ocrPopup.loading || !ocrPopup.text.trim() || ocrPopup.copied}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 18px',
                borderRadius: 8,
                border: 'none',
                background: '#4b3fe3',
                color: '#fff',
                cursor: ocrPopup.loading || !ocrPopup.text.trim() || ocrPopup.copied ? 'not-allowed' : 'pointer',
                opacity: ocrPopup.loading || !ocrPopup.text.trim() ? 0.5 : 1,
                fontSize: '0.8rem',
                fontWeight: 700,
              }}
            >
              {ocrPopup.copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {ocrPopup.copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
