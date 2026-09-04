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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Move, Undo2, Redo2, RotateCcw, Check, X, ScanText, Copy, Loader2, ArrowUpRight, Type } from 'lucide-react';

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
}

type Tool = 'select' | 'mosaic' | 'arrow' | 'text';
type Sel = { x: number; y: number; w: number; h: number };

/** 标注色（微信截图箭头/文字默认红） */
const MARK_COLOR = '#ff5252';
/** 马赛克块大小（canvas 像素） */
const MOSAIC_BLOCK = 12;
/** 马赛克画笔半径（canvas 像素） */
const MOSAIC_RADIUS = 48;
/** 撤销栈最大深度（全图快照内存保护） */
const MAX_HISTORY = 30;
/** 选区最小边长（canvas 像素） */
const MIN_SEL = 18;
/** 浮动工具条宽度（窗口像素） */
const TOOLBAR_W = 236;
/** 选区/裁剪输出圆角半径（图像自然像素） */
const SEL_RADIUS = 10;

/** 画箭头（微信/QQ 标注风：圆头实线 + 实心三角头，醒目通用） */
function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 12) return;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  // 实心头：长度与翼半宽（比例收敛，视觉协调）
  const headLen = Math.min(26, len * 0.3);
  const halfW = headLen * 0.42;
  // 杆终点 = 头底边中点（实心头占位）
  const bx = x2 - dx * headLen;
  const by = y2 - dy * headLen;
  const nx = -dy;
  const ny = dx;
  ctx.strokeStyle = MARK_COLOR;
  ctx.fillStyle = MARK_COLOR;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 杆：起点 → 头底边中点（圆头实线）
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

/** 8 向缩放手柄定义 */
const HANDLES: { id: string; style: React.CSSProperties }[] = [
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

export function ScreenOcrEditor({ dataUrl, onDone, onOcr, onCancel, initialSelection = 'none' }: ScreenOcrEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const originalRef = useRef<HTMLImageElement | null>(null);
  const undoRef = useRef<ImageData[]>([]);
  const redoRef = useRef<ImageData[]>([]);
  /** 选区（图像像素坐标）；selRef 与 state 同步，供指针事件内读取 */
  const selRef = useRef<Sel | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [phase, setPhase] = useState<'idle' | 'edit'>('idle');
  const [dragging, setDragging] = useState(false);
  const [dragMode, setDragMode] = useState<null | 'select' | 'move' | 'resize' | 'mosaic' | 'arrow'>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  /** To Text 弹窗：选区裁剪图 + OCR 文本（可编辑）+ 复制/取消 */
  const [ocrPopup, setOcrPopup] = useState<{ dataUrl: string; text: string; loading: boolean; error?: string; copied: boolean } | null>(null);
  /** 文字工具：进行中的输入草稿（图像坐标） */
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const textDraftRef = useRef<{ x: number; y: number; value: string } | null>(null);
  const dragRef = useRef<{
    mode: 'select' | 'move' | 'resize' | 'mosaic' | 'arrow' | null;
    handle?: string;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    sel0: Sel;
  }>({ mode: null, startX: 0, startY: 0, curX: 0, curY: 0, sel0: { x: 0, y: 0, w: 0, h: 0 } });
  /** 箭头拖拽预览用的画面快照 */
  const arrowSnapRef = useRef<HTMLCanvasElement | null>(null);

  const setSelBoth = useCallback((s: Sel | null) => {
    selRef.current = s;
    setSel(s);
  }, []);

  const setTextDraftBoth = useCallback((d: { x: number; y: number; value: string } | null) => {
    textDraftRef.current = d;
    setTextDraft(d);
  }, []);

  const refreshStates = useCallback(() => {
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  }, []);

  const getCanvas = useCallback(() => canvasRef.current, []);
  const getCtx = useCallback(() => getCanvas()!.getContext('2d')!, [getCanvas]);

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
      setNat({ w: img.naturalWidth, h: img.naturalHeight });
      // fit 缩放：铺满窗口（不预留边距，消除 Retina 下四周黑边；工具条/按钮均 fixed 浮动覆盖）
      const sc = Math.min(
        window.innerWidth / img.naturalWidth,
        window.innerHeight / img.naturalHeight,
        1,
      );
      setScale(sc);
      // 原生选区已完成（region 模式）：整图直接全选区，进入编辑态立即出工具条（微信式）
      if (initialSelection === 'full') {
        setSelBoth({ x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight });
        setPhase('edit');
      }
    };
    img.src = dataUrl;
  }, [dataUrl, getCanvas, getCtx, initialSelection, setSelBoth]);

  /** 把当前画面压入撤销栈（操作前调用），清空重做栈 */
  const pushUndo = useCallback(() => {
    const canvas = getCanvas()!;
    undoRef.current.push(getCtx().getImageData(0, 0, canvas.width, canvas.height));
    if (undoRef.current.length > MAX_HISTORY) undoRef.current.shift();
    redoRef.current = [];
    refreshStates();
  }, [getCanvas, getCtx, refreshStates]);

  /** 恢复一份快照（需先按快照尺寸重置 canvas） */
  const restoreSnapshot = useCallback(
    (snap: ImageData) => {
      const canvas = getCanvas()!;
      canvas.width = snap.width;
      canvas.height = snap.height;
      getCtx().putImageData(snap, 0, 0);
    },
    [getCanvas, getCtx],
  );

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    const canvas = getCanvas()!;
    redoRef.current.push(getCtx().getImageData(0, 0, canvas.width, canvas.height));
    restoreSnapshot(prev);
    refreshStates();
  }, [getCanvas, getCtx, restoreSnapshot, refreshStates]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    const canvas = getCanvas()!;
    undoRef.current.push(getCtx().getImageData(0, 0, canvas.width, canvas.height));
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
    refreshStates();
  }, [getCanvas, getCtx, pushUndo, refreshStates]);

  /** 提交文字草稿：把文本画到内容画布（空文本直接丢弃） */
  const commitTextDraft = useCallback(
    (d: { x: number; y: number; value: string }) => {
      setTextDraftBoth(null);
      const v = d.value.trim();
      if (!v) return;
      pushUndo();
      const ctx = getCtx();
      ctx.save();
      ctx.font = '600 16px -apple-system, "PingFang SC", sans-serif';
      ctx.fillStyle = MARK_COLOR;
      ctx.textBaseline = 'top';
      ctx.fillText(v, d.x, d.y);
      ctx.restore();
    },
    [setTextDraftBoth, pushUndo, getCtx],
  );

  /** 切换工具：若有未提交的文字草稿先落定（防残留输入框/状态混乱） */
  const switchTool = useCallback(
    (t: Tool) => {
      if (tool === 'text' && textDraftRef.current) commitTextDraft(textDraftRef.current);
      setTool(t);
    },
    [tool, commitTextDraft],
  );

  /** 马赛克：把以 (cx,cy) 为圆心、radius 半径内的像素按 blockSize 网格块化（每块取平均色） */
  const paintMosaicAt = useCallback(
    (cx: number, cy: number) => {
      const canvas = getCanvas()!;
      const ctx = getCtx();
      const { width, height } = canvas;
      const imgData = ctx.getImageData(0, 0, width, height);
      const d = imgData.data;
      const x0 = Math.max(0, Math.floor((cx - MOSAIC_RADIUS) / MOSAIC_BLOCK) * MOSAIC_BLOCK);
      const y0 = Math.max(0, Math.floor((cy - MOSAIC_RADIUS) / MOSAIC_BLOCK) * MOSAIC_BLOCK);
      const x1 = Math.min(width, Math.ceil((cx + MOSAIC_RADIUS) / MOSAIC_BLOCK) * MOSAIC_BLOCK);
      const y1 = Math.min(height, Math.ceil((cy + MOSAIC_RADIUS) / MOSAIC_BLOCK) * MOSAIC_BLOCK);
      for (let by = y0; by < y1; by += MOSAIC_BLOCK) {
        for (let bx = x0; bx < x1; bx += MOSAIC_BLOCK) {
          const bEndY = Math.min(by + MOSAIC_BLOCK, height);
          const bEndX = Math.min(bx + MOSAIC_BLOCK, width);
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let y = by; y < bEndY; y++) {
            for (let x = bx; x < bEndX; x++) {
              const i = (y * width + x) * 4;
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
              const i = (y * width + x) * 4;
              d[i] = r;
              d[i + 1] = g;
              d[i + 2] = b;
            }
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
    },
    [getCanvas, getCtx],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const pos = toImagePos(e.clientX, e.clientY);
      // 文字：提交进行中的草稿（如有）→ 在点击处开新输入框（不进入拖拽）
      if (tool === 'text') {
        if (textDraftRef.current) commitTextDraft(textDraftRef.current);
        setTextDraftBoth({ x: pos.x, y: pos.y, value: '' });
        return;
      }
      // 箭头：快照画面 → 拖拽预览 → 松开落定（一次箭头一个撤销步）
      if (tool === 'arrow') {
        const canvas = getCanvas()!;
        const snap = document.createElement('canvas');
        snap.width = canvas.width;
        snap.height = canvas.height;
        snap.getContext('2d')!.drawImage(canvas, 0, 0);
        arrowSnapRef.current = snap;
        dragRef.current = { mode: 'arrow', startX: pos.x, startY: pos.y, curX: pos.x, curY: pos.y, sel0: { x: 0, y: 0, w: 0, h: 0 } };
        setDragMode('arrow');
        pushUndo();
        setDragging(true);
        return;
      }
      // 马赛克：直接涂抹（一次笔画一个撤销步）
      if (tool === 'mosaic') {
        dragRef.current = { mode: 'mosaic', startX: pos.x, startY: pos.y, curX: pos.x, curY: pos.y, sel0: selRef.current ?? { x: 0, y: 0, w: 0, h: 0 } };
        setDragMode('mosaic');
        pushUndo();
        paintMosaicAt(pos.x, pos.y);
        setDragging(true);
        return;
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
    [toImagePos, tool, phase, pushUndo, paintMosaicAt, setSelBoth, commitTextDraft, setTextDraftBoth, getCanvas],
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
        paintMosaicAt(pos.x, pos.y);
      } else if (d.mode === 'arrow') {
        // 预览：快照 + 当前箭头
        const snap = arrowSnapRef.current;
        if (!snap) return;
        const ctx = getCtx();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(snap, 0, 0);
        drawArrow(ctx, d.startX, d.startY, pos.x, pos.y);
      }
    },
    [toImagePos, getCanvas, getCtx, paintMosaicAt, setSelBoth],
  );

  /** 复位拖拽状态（指针取消/丢失兜底，防止 dragging 卡死导致工具条不弹） */
  const resetDrag = useCallback(() => {
    dragRef.current = { mode: null, startX: 0, startY: 0, curX: 0, curY: 0, sel0: { x: 0, y: 0, w: 0, h: 0 } };
    arrowSnapRef.current = null;
    setDragMode(null);
    setDragging(false);
  }, []);

  /** 指针被系统取消（窗口失焦/系统抢占）：复位拖拽；若选区已成型则直接进入编辑态，工具条照常弹出 */
  const onPointerCancel = useCallback(() => {
    const d = dragRef.current;
    if (d.mode === 'select') {
      const s = selRef.current;
      if (s && s.w >= MIN_SEL && s.h >= MIN_SEL) setPhase('edit');
    }
    resetDrag();
  }, [resetDrag]);

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (!d.mode) return;
    if (d.mode === 'select') {
      const s = selRef.current;
      if (s && s.w >= MIN_SEL && s.h >= MIN_SEL) {
        setPhase('edit');
      } else {
        setSelBoth(null);
      }
    } else if (d.mode === 'arrow') {
      // 落定箭头：未形成有效线段则恢复快照（撤销这次 pushUndo 的效果由快照覆盖）
      const snap = arrowSnapRef.current;
      arrowSnapRef.current = null;
      if (snap && Math.hypot(d.curX - d.startX, d.curY - d.startY) < 6) {
        const canvas = getCanvas()!;
        const ctx = getCtx();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(snap, 0, 0);
      }
    }
    resetDrag();
  }, [setSelBoth, getCanvas, getCtx, resetDrag]);

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
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        // 文字输入中按 Esc：丢弃草稿，留在编辑器
        if (textDraftRef.current) {
          setTextDraftBoth(null);
          return;
        }
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo, redo, onCancel, setTextDraftBoth]);

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
    ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    return out.toDataURL('image/png');
  }, [getCanvas]);

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
  const barPos = (() => {
    if (!sel || !nat) return { left: 12, top: 12 };
    const boxW = nat.w * scale;
    const boxH = nat.h * scale;
    const sx = (window.innerWidth - boxW) / 2 + sel.x * scale;
    const sy = (window.innerHeight - boxH) / 2 + sel.y * scale;
    const sw = sel.w * scale;
    const sh = sel.h * scale;
    const barH = 44;
    let left = sx + sw / 2 - TOOLBAR_W / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - TOOLBAR_W - 8));
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
    let left = barPos.left + TOOLBAR_W / 2 - W / 2;
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
      style={{
        position: 'fixed',
        inset: 0,
        // 置顶：高于 WantedNoticeCenter(2147483000) 等所有可见弹层，截图编辑时不被遮挡
        zIndex: 2147483001,
        // 半透明暗色（微信截图式）：透出底层界面，避免 -i 选区小图在纯黑背景下形成"整屏漆黑"
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-sans)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        touchAction: 'none',
      }}
    >
      {/* 顶部引导条：明确当前是截图编辑模式（防误以为界面卡死）；pointerEvents none 不挡操作 */}
      <div
        style={{
          position: 'fixed',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 30,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 18px',
          borderRadius: 999,
          background: 'rgba(28,28,30,0.9)',
          color: '#fff',
          fontSize: '0.866667rem',
          fontWeight: 500,
          boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#ffd60a',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        截图编辑中 · 拖选/调整选区 → ✓ 复制 ｜ To Text 识别 ｜ Esc 或 ✕ 退出
      </div>

      {/* 工具模式提示（选中非 select 工具时，明确当前模式与下一步） */}
      {tool !== 'select' && (
        <div
          style={{
            position: 'fixed',
            top: 58,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 30,
            padding: '6px 14px',
            borderRadius: 999,
            background: 'rgba(75,63,227,0.92)',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 500,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {tool === 'text'
            ? '文字模式：点击图像放置文字（Enter 落定）'
            : tool === 'mosaic'
              ? '马赛克：按住涂抹要打码的区域'
              : '箭头：按住拖拽画箭头（指向标注）'}
        </div>
      )}

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
            autoFocus
            value={textDraft.value}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setTextDraftBoth({ ...textDraft, value: e.target.value })}
            onBlur={() => {
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
              left: textDraft.x * scale,
              top: textDraft.y * scale,
              width: Math.max(60, Math.min(320 * scale, nat ? (nat.w - textDraft.x) * scale : 320 * scale)),
              padding: '2px 6px',
              border: `1.5px solid ${MARK_COLOR}`,
              borderRadius: 4,
              background: 'rgba(255,255,255,0.92)',
              color: MARK_COLOR,
              fontSize: 16 * scale,
              fontWeight: 600,
              lineHeight: 1.3,
              fontFamily: '-apple-system, "PingFang SC", sans-serif',
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
            <button style={toolBtn(tool === 'arrow')} onClick={() => switchTool('arrow')} title="Arrow: drag to draw (hand-drawn sketch)">
              <ArrowUpRight className="h-4 w-4" />
            </button>
            <button style={toolBtn(tool === 'text')} onClick={() => switchTool('text')} title="Text: click to add text">
              <Type className="h-4 w-4" />
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
          </div>
        )}
      </div>

      {/* 右下角：X 放弃 / ✓ 确认（微信截图式）——阻止 pointer 冒泡，避免触发下方选区拖选 */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{ position: 'fixed', right: 24, bottom: 24, display: 'flex', gap: 10, zIndex: 20 }}
      >
        <button
          onClick={onCancel}
          title="Cancel (Esc)"
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(28,28,30,0.92)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
          }}
        >
          <X className="h-5 w-5" />
        </button>
        <button
          onClick={handleDone}
          disabled={!sel || sel.w < MIN_SEL || sel.h < MIN_SEL}
          title="Confirm & OCR"
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            border: 'none',
            background: '#21c45d',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: sel && sel.w >= MIN_SEL && sel.h >= MIN_SEL ? 'pointer' : 'not-allowed',
            opacity: sel && sel.w >= MIN_SEL && sel.h >= MIN_SEL ? 1 : 0.45,
            boxShadow: '0 8px 30px rgba(33,196,93,0.35)',
          }}
        >
          <Check className="h-5 w-5" />
        </button>
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
