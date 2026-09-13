'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight, Square, Type, Grid3x3, Undo2, Trash, X, Check, Loader2,
} from 'lucide-react';

/**
 * 图片标注编辑器（Phase 1）
 *
 * 在 Canvas 上叠加箭头 / 矩形 / 文字 / 马赛克标注，导出合成 PNG。
 *  - Canvas 内部尺寸 = 图片原始尺寸，CSS 等比缩放适配容器；坐标按 rect 比例换算
 *  - 标注以对象数组保存（每帧重绘），支持撤销/清空，不破坏原图
 *  - 马赛克 = 区域块状模糊（离屏小图放大采样）
 */

type Tool = 'arrow' | 'rect' | 'text' | 'mosaic';

interface AnnoBase {
  type: Tool;
  color: string;
  lineWidth: number;
}
interface ArrowAnno extends AnnoBase { type: 'arrow'; x1: number; y1: number; x2: number; y2: number; }
interface RectAnno extends AnnoBase { type: 'rect'; x1: number; y1: number; x2: number; y2: number; }
interface TextAnno extends AnnoBase { type: 'text'; x: number; y: number; text: string; fontSize: number; }
interface MosaicAnno extends AnnoBase { type: 'mosaic'; x1: number; y1: number; x2: number; y2: number; }
type Anno = ArrowAnno | RectAnno | TextAnno | MosaicAnno;

const COLORS = ['#e11d48', '#eab308', '#2563eb', '#16a34a', '#111827', '#ffffff'];
const TOOLS: Array<{ key: Tool; label: string; icon: typeof Square }> = [
  { key: 'arrow', label: 'Arrow', icon: ArrowUpRight },
  { key: 'rect', label: 'Rectangle', icon: Square },
  { key: 'text', label: 'Text', icon: Type },
  { key: 'mosaic', label: 'Mosaic', icon: Grid3x3 },
];
/** 文字标注可选字号 */
const FONT_SIZES = [12, 16, 20, 24, 32, 40, 48, 64];
/** 取最接近的字号选项 */
const nearestFontSize = (v: number): number =>
  FONT_SIZES.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), FONT_SIZES[0]);

interface Props {
  src: string;
  fileName: string;
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
}

export function ImageAnnotator({ src, fileName, onSave, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const objectsRef = useRef<Anno[]>([]);
  const drawingRef = useRef<Anno | null>(null);

  const [tool, setTool] = useState<Tool>('arrow');
  const [color, setColor] = useState(COLORS[0]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 文字工具：点击定位后显示内联输入浮层（不用 window.prompt——Electron 不支持）
  const [textDraft, setTextDraft] = useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = useState('');
  // 文字字号（按画布宽度自动推导，写入标注用）
  const [textFontSize, setTextFontSize] = useState(24);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 文字输入浮层的 input ref（自动聚焦）
  const textInputRef = useRef<HTMLInputElement>(null);
  // 拖拽调整后的输入框尺寸（null = 随内容自动缩放）
  const [boxSize, setBoxSize] = useState<{ w: number; h: number } | null>(null);
  const resizeRef = useRef<{ sx: number; sy: number; w: number; h: number } | null>(null);
  // 实时预览：输入时在画布上即时绘制待确认文字（所见即所得）
  const previewRef = useRef<{ x: number; y: number; text: string; fontSize: number; color: string } | null>(null);

  /** 绘制一帧：清空 → 原图 → 全部标注（含进行中） */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!canvas || !base) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);

    const drawMosaic = (m: MosaicAnno) => {
      const x = Math.min(m.x1, m.x2), y = Math.min(m.y1, m.y2);
      const w = Math.abs(m.x2 - m.x1), h = Math.abs(m.y2 - m.y1);
      if (w < 2 || h < 2) return;
      const block = 14;
      // 区域缩到小图再平滑放大回原尺寸 → 块状模糊
      const off = document.createElement('canvas');
      off.width = Math.round(w); off.height = Math.round(h);
      const octx = off.getContext('2d')!;
      octx.drawImage(base, x, y, w, h, 0, 0, off.width, off.height);
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(w / block));
      small.height = Math.max(1, Math.round(h / block));
      const sctx = small.getContext('2d')!;
      sctx.imageSmoothingEnabled = false;
      sctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
      ctx.imageSmoothingEnabled = true;
    };

    const drawShape = (o: Anno) => {
      ctx.strokeStyle = o.color;
      ctx.fillStyle = o.color;
      ctx.lineWidth = o.lineWidth;
      // 重置线帽/连接（箭头分支内用圆角，避免污染矩形等形状）
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      if (o.type === 'arrow') {
        // 圆角线帽/连接：线身与箭头头衔接自然
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
        if (len < 2) return;
        // 白描边底（先画外圈白线，提高复杂背景上的对比度）
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = o.lineWidth + 2.5;
        ctx.beginPath();
        ctx.moveTo(o.x1, o.y1);
        ctx.lineTo(o.x2, o.y2);
        ctx.stroke();
        // 彩色主线
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.lineWidth;
        ctx.beginPath();
        ctx.moveTo(o.x1, o.y1);
        ctx.lineTo(o.x2, o.y2);
        ctx.stroke();
        // 飞镖形箭头头：长度随箭头总长自适应（防短箭头头过大/长箭头头过小），张开角更锋利
        const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
        const head = Math.min(Math.max(14, o.lineWidth * 4.5), len * 0.5);
        const spread = head * 0.5;
        const bx = o.x2 - head * Math.cos(ang);
        const by = o.y2 - head * Math.sin(ang);
        // 白色外扩箭头头（描边效果）
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.moveTo(o.x2, o.y2);
        ctx.lineTo(bx + spread * Math.sin(ang), by - spread * Math.cos(ang));
        ctx.lineTo(bx - spread * Math.sin(ang), by + spread * Math.cos(ang));
        ctx.closePath();
        ctx.fill();
        // 彩色内箭头头
        ctx.fillStyle = o.color;
        ctx.beginPath();
        ctx.moveTo(o.x2, o.y2);
        ctx.lineTo(bx + spread * 0.72 * Math.sin(ang), by - spread * 0.72 * Math.cos(ang));
        ctx.lineTo(bx - spread * 0.72 * Math.sin(ang), by + spread * 0.72 * Math.cos(ang));
        ctx.closePath();
        ctx.fill();
      } else if (o.type === 'rect') {
        ctx.strokeRect(Math.min(o.x1, o.x2), Math.min(o.y1, o.y2), Math.abs(o.x2 - o.x1), Math.abs(o.y2 - o.y1));
      } else if (o.type === 'text') {
        ctx.font = `600 ${o.fontSize}px sans-serif`;
        // 多行文本逐行绘制（text 中可含 \n）
        o.text.split('\n').forEach((line, i) => {
          ctx.fillText(line, o.x, o.y + i * o.fontSize * 1.25);
        });
      } else {
        drawMosaic(o);
      }
    };

    objectsRef.current.forEach(drawShape);
    if (drawingRef.current) drawShape(drawingRef.current);

    // 文字实时预览（输入中）：在点击位置即时绘制待确认文字（支持多行）
    const p = previewRef.current;
    if (p && p.text) {
      ctx.font = `600 ${p.fontSize}px sans-serif`;
      ctx.fillStyle = p.color;
      p.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, p.x, p.y + i * p.fontSize * 1.25);
      });
    }
  }, []);

  // 加载原图 → 离屏 base canvas（canvas DOM 在 !loading 后才挂载，不能在此依赖 canvasRef）
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const base = document.createElement('canvas');
      base.width = img.naturalWidth;
      base.height = img.naturalHeight;
      base.getContext('2d')!.drawImage(img, 0, 0);
      baseRef.current = base;
      setLoading(false);
    };
    img.onerror = () => setLoading(false);
    img.src = src;
  }, [src]);

  // canvas 挂载后：同步尺寸并绘制首帧
  useEffect(() => {
    if (loading) return;
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!canvas || !base) return;
    canvas.width = base.width;
    canvas.height = base.height;
    draw();
  }, [loading, draw]);

  /** 事件坐标 → canvas 内部坐标（按显示比例换算） */
  const toCanvas = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const handleDown = useCallback((e: React.PointerEvent) => {
    if (loading || tool === 'text') return;
    const { x, y } = toCanvas(e);
    drawingRef.current = { type: tool, color, lineWidth: 4, x1: x, y1: y, x2: x, y2: y } as Anno;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [tool, color, loading, toCanvas]);

  const handleMove = useCallback((e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (!d || d.type === 'text') return;
    const { x, y } = toCanvas(e);
    (d as ArrowAnno | RectAnno | MosaicAnno).x2 = x;
    (d as ArrowAnno | RectAnno | MosaicAnno).y2 = y;
    draw();
  }, [draw, toCanvas]);

  const handleUp = useCallback(() => {
    const d = drawingRef.current;
    if (d && d.type !== 'text') {
      const dd = d as ArrowAnno | RectAnno | MosaicAnno;
      if (Math.abs(dd.x2 - dd.x1) + Math.abs(dd.y2 - dd.y1) > 4) {
        objectsRef.current.push({ ...d });
      }
    }
    drawingRef.current = null;
  }, []);

  // 文字工具：点击定位 → 显示内联输入浮层
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (loading || tool !== 'text') return;
    const { x, y } = toCanvas(e);
    const fontSize = nearestFontSize(Math.max(20, Math.round(canvasRef.current!.width / 40)));
    setTextFontSize(fontSize);
    setTextDraft({ x, y });
    setTextValue('');
    previewRef.current = { x, y, text: '', fontSize, color };
  }, [tool, color, loading, toCanvas]);

  // 输入变化：更新预览并重绘（所见即所得）
  const handleTextChange = useCallback((v: string) => {
    setTextValue(v);
    if (textDraft) {
      previewRef.current = { ...previewRef.current!, text: v };
      draw();
    }
  }, [textDraft, draw]);

  // 选择字号：更新预览并重绘
  const handleFontSizeChange = useCallback((v: number) => {
    setTextFontSize(v);
    if (textDraft) {
      previewRef.current = { ...previewRef.current!, fontSize: v };
      draw();
    }
  }, [textDraft, draw]);

  // 拖拽调整输入框尺寸：按下时记录起始
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const ta = textareaRef.current;
    const w = boxSize?.w ?? ta?.getBoundingClientRect().width ?? 120;
    const h = boxSize?.h ?? ta?.getBoundingClientRect().height ?? 24;
    resizeRef.current = { sx: e.clientX, sy: e.clientY, w, h };
  }, [boxSize]);

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    setBoxSize({
      w: Math.max(48, r.w + (e.clientX - r.sx)),
      h: Math.max(24, r.h + (e.clientY - r.sy)),
    });
  }, []);

  const handleResizeEnd = useCallback(() => { resizeRef.current = null; }, []);

  // 确认文字：写入标注并关闭浮层
  const confirmText = useCallback(() => {
    const text = textValue.trim();
    if (text && textDraft) {
      objectsRef.current.push({ type: 'text', color, lineWidth: 4, x: textDraft.x, y: textDraft.y, text, fontSize: textFontSize });
      draw();
    }
    setTextDraft(null);
    setTextValue('');
    setBoxSize(null);
    previewRef.current = null;
  }, [textValue, textDraft, color, textFontSize, draw]);

  // 取消文字输入
  const cancelText = useCallback(() => {
    setTextDraft(null);
    setTextValue('');
    setBoxSize(null);
    previewRef.current = null;
    draw();
  }, [draw]);

  const undo = useCallback(() => { objectsRef.current.pop(); draw(); }, [draw]);
  const clear = useCallback(() => { objectsRef.current = []; drawingRef.current = null; draw(); }, [draw]);

  const save = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    try {
      onSave(canvas.toDataURL('image/png'));
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  return (
    <div className="flex h-full w-full flex-col" style={{ backgroundColor: 'oklch(0.16 0.02 260)' }}>
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2" style={{ backgroundColor: '#1c1c1e', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <span className="mr-1 max-w-[180px] truncate text-xs font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>
          {fileName}
        </span>
        <div className="flex items-center gap-0.5 rounded-lg px-1 py-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
          {TOOLS.map(t => {
            const Icon = t.icon;
            const active = tool === t.key;
            return (
              <button
                key={t.key}
                type="button"
                title={t.label}
                onClick={() => { setTool(t.key); cancelText(); }}
                className="flex items-center justify-center rounded-md px-1.5 py-1 transition-colors"
                style={{
                  color: active ? '#fff' : 'rgba(255,255,255,0.55)',
                  backgroundColor: active ? 'rgba(255,255,255,0.14)' : 'transparent',
                }}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          {COLORS.map(c => (
            <button
              key={c}
              type="button"
              title="Annotation color"
              onClick={() => setColor(c)}
              className="h-4 w-4 rounded-full transition-transform"
              style={{
                backgroundColor: c,
                boxShadow: color === c ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : '0 0 0 1px rgba(255,255,255,0.3)',
                transform: color === c ? 'scale(1.15)' : 'scale(1)',
              }}
            />
          ))}
        </div>
        {/* 字号选择：仅文字工具激活时显示 */}
        {tool === 'text' && (
          <div className="flex items-center gap-1 rounded-md px-1.5 py-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
            <span className="text-xs" style={{ color: 'rgba(255,255,255,0.55)' }}>Size</span>
            <select
              value={textFontSize}
              onChange={(e) => handleFontSizeChange(Number(e.target.value))}
              title="Annotation font size"
              className="rounded border-none bg-transparent px-1 py-0.5 text-xs outline-none"
              style={{ color: '#fff', backgroundColor: 'rgba(255,255,255,0.14)', fontFamily: "var(--font-sans)", cursor: 'pointer' }}
            >
              {FONT_SIZES.map((s) => (
                <option key={s} value={s} style={{ color: '#000' }}>{s}px</option>
              ))}
            </select>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={undo}
            title="Undo"
            className="flex items-center justify-center rounded-md px-1.5 py-1 transition-colors hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.7)' }}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={clear}
            title="Clear all annotations"
            className="flex items-center justify-center rounded-md px-1.5 py-1 transition-colors hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.7)' }}
          >
            <Trash className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onCancel}
            title="Cancel"
            className="flex items-center justify-center rounded-md px-2 py-1 transition-colors hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.75)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            title={saving ? 'Saving…' : 'Save'}
            className="flex items-center justify-center rounded-md px-2 py-1 transition-opacity disabled:opacity-50"
            style={{ backgroundColor: '#34c759', color: '#fff' }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* 画布区 */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-4" style={{ backgroundColor: 'oklch(0.92 0.005 260)', cursor: tool === 'text' ? 'text' : 'crosshair' }}>
        {loading ? (
          <div className="flex flex-col items-center gap-2">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: 'var(--info)' }} />
            <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Loading image…</span>
          </div>
        ) : (
          <div className="relative" style={{ lineHeight: 0 }}>
            <canvas
              ref={canvasRef}
              className="max-h-full max-w-full rounded-lg shadow-2xl"
              style={{ touchAction: 'none' }}
              onPointerDown={handleDown}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              onClick={handleCanvasClick}
            />
            {/* 文字输入浮层：透明无框、宽度随内容缩放、可拖拽调整大小、所见即所得 */}
            {textDraft && (() => {
              const lineCount = Math.max(1, textValue.split('\n').length);
              const maxLineLen = textValue.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
              return (
                <div
                  className="absolute z-10 flex items-start gap-1"
                  style={{
                    left: textDraft.x * (canvasRef.current!.getBoundingClientRect().width / canvasRef.current!.width),
                    top: textDraft.y * (canvasRef.current!.getBoundingClientRect().height / canvasRef.current!.height),
                    lineHeight: 'normal',
                  }}
                >
                  <div className="relative">
                    <textarea
                      ref={textareaRef}
                      autoFocus
                      value={textValue}
                      onChange={(e) => handleTextChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmText(); }
                        if (e.key === 'Escape') cancelText();
                      }}
                      placeholder="Enter annotation text"
                      rows={lineCount}
                      spellCheck={false}
                      className="resize-none border-none bg-transparent p-0 outline-none"
                      style={{
                        width: boxSize ? boxSize.w : `${Math.max(8, maxLineLen * 1.2 + 2)}ch`,
                        height: boxSize ? boxSize.h : 'auto',
                        overflow: 'hidden',
                        fontSize: textFontSize,
                        fontWeight: 600,
                        lineHeight: 1.25,
                        color,
                        fontFamily: "var(--font-sans)",
                      }}
                    />
                    {/* 右下角拖拽手柄：自由调整输入框大小 */}
                    <div
                      className="absolute -bottom-1 -right-1 cursor-nwse-resize"
                      style={{
                        width: 14,
                        height: 14,
                        background: 'rgba(255,255,255,0.35)',
                        clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
                        borderBottomRightRadius: 4,
                      }}
                      title="Drag to resize"
                      onPointerDown={handleResizeStart}
                      onPointerMove={handleResizeMove}
                      onPointerUp={handleResizeEnd}
                      onPointerCancel={handleResizeEnd}
                    />
                  </div>
                  {/* 确认/取消（按钮组带半透明底，不遮输入框本身） */}
                  <span className="flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5" style={{ backgroundColor: 'rgba(0,0,0,0.35)', color: '#fff' }}>
                    <button
                      type="button"
                      onClick={confirmText}
                      disabled={!textValue.trim()}
                      title="Confirm"
                      className="rounded p-0.5 transition-colors hover:bg-white/20 disabled:opacity-40"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelText}
                      title="Cancel"
                      className="rounded p-0.5 transition-colors hover:bg-white/20"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
