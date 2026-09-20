'use client';

// PDF 查看器：基于 PDF.js，支持页码导航、缩放、批注（高亮 + 文字框，sidecar 存储）、
// 全文检索（文本层精确高亮 + 扫描件 BOB OCR 页级兜底）
//
// 批注设计（方案 A）：
// - 批注存独立 sidecar JSON（<pdf路径>.annotations.json），PDF 原文件不动
// - 坐标一律为「页面归一化坐标」（0~1 相对页面宽高），渲染时 × 当前 CSS 像素尺寸即可
// - 高亮：拖选矩形区域生成半透明色块；文字框：点击/拖选生成，双击编辑文本，均可拖动、改色、删除
//
// 检索设计：
// - 侧栏搜索：优先用 pdfjs getTextContent 构建文本层索引（命中回投归一化矩形，复用批注坐标管线画高亮）
// - 文本层缺失（扫描件）时，一键 ⚡BOB OCR（POST /api/ocr），命中降级为页级跳转 + 上下文摘录

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronUp,
  ZoomIn,
  ZoomOut,
  Highlighter,
  Type,
  Save,
  Trash,
  Search,
  X,
  Zap,
  Loader2,
  LayoutGrid,
  Check,
  Eye,
  StickyNote,
} from 'lucide-react';
import type { PdfAnnotation } from '@/app/api/pdf-annotations/route';
import {
  buildPageText,
  looksLikeScannedPdf,
  searchOcrPages,
  searchPageIndexes,
  splitOcrPagesFromText,
} from '@/lib/pdf/text-search';
import type {
  OcrBlockGeom,
  OcrPageText,
  PageTextIndexEntry,
  SearchHit,
  TextItemGeom,
  ViewportMeta,
} from '@/lib/pdf/text-search';
import type { OcrStatusMeta } from '@/app/api/pdf-ocr-status/route';

/** 文本层可视化块（归一化 0~1，已翻转为左上原点） */
interface TextLayerBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

interface PdfViewerProps {
  url: string;
  fileName: string;
  /** PDF 绝对路径（sidecar 批注读写用；为空时禁用批注功能） */
  filePath?: string;
  /** 外部深链：打开后跳转到指定页（1-based） */
  initialPage?: number;
  /** 外部深链：打开后自动检索并高亮的定位关键词 */
  initialQuery?: string;
}

type AnnotationMode = 'none' | 'highlight' | 'textbox';

/** OCR 单一事实源：status（过程）/ meta（持久标记）/ pages（逐页正文）永远一起更新 */
interface OcrState {
  status: 'idle' | 'running' | 'done' | 'error';
  meta: OcrStatusMeta | null;
  pages: OcrPageText[] | null;
}

/** pdfjs-dist 按需使用的最小接口（动态导入包未带精细类型声明） */
interface PdfjsPage {
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: Array<Record<string, unknown>> }>;
  render(params: Record<string, unknown>): { promise: Promise<void>; cancel?: () => void };
}
interface PdfjsDocument {
  numPages: number;
  getPage(pageNum: number): Promise<PdfjsPage>;
}
interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocument>;
  destroy?: () => void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragState =
  | { kind: 'create'; startX: number; startY: number }
  | { kind: 'move'; id: string; lastX: number; lastY: number }
  | { kind: 'resize'; id: string; startX: number; startY: number; startW: number; startH: number }
  | null;

const PRESET_COLORS = ['#ffd54d', '#a5d6a7', '#90caf9', '#f48fb1', '#ffb74d'];

/** 文字批注可选字号（px），缺省 12 */
const FONT_SIZES = [10, 12, 14, 16, 20, 24, 32];

/** 页面缩略图固定宽度（px），高度按页面比例自适应 */
const THUMB_W = 100;

/** 页面渲染最大宽度（px）：与 MD 预览「居中纸张卡片」排版一致，宽面板下限制页面拉伸过宽 */
const MAX_PAGE_W = 960;

function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** 文字框双击进入的可编辑层（不受控，失焦/回车提交，Esc 取消） */
function EditableText({
  initial,
  onCommit,
  onCancel,
  style,
}: {
  initial: string;
  onCommit: (t: string) => void;
  onCancel: () => void;
  style: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initial;
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      sel.selectAllChildren(el);
      sel.collapseToEnd();
    }
  }, []);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      className="absolute"
      style={{
        ...style,
        width: 'auto',
        minWidth: 80,
        backgroundColor: 'transparent',
        border: 'none',
        boxShadow: 'none',
        borderRadius: 0,
        lineHeight: 1.5,
        color: 'var(--ink)',
        padding: 0,
        outline: 'none',
        overflow: 'visible',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        cursor: 'text',
      }}
      onBlur={() => onCommit(ref.current?.textContent ?? '')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') onCancel();
      }}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

/**
 * 单页渲染单元（纵向连续滚动模式）：canvas 懒渲染 + 批注层 + 检索高亮。
 * - IntersectionObserver 进入视口（含 300px 预加载余量）时渲染 canvas，缩放变化自动重渲染
 * - 批注/检索坐标为归一化（0~1），按本页实际 CSS 尺寸换算定位
 */
function PdfPageView({
  pageNo,
  doc,
  scale,
  annotations,
  mode,
  selectedId,
  editingId,
  fontSizePref,
  searchRects,
  textLayer,
  onAdd,
  onUpdate,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  registerRef,
}: {
  pageNo: number;
  doc: PdfjsDocument;
  scale: number;
  annotations: PdfAnnotation[];
  mode: AnnotationMode;
  selectedId: string | null;
  editingId: string | null;
  fontSizePref: number;
  searchRects: { x: number; y: number; w: number; h: number; current: boolean }[];
  /** OCR 识别文字层（归一化 0~1，左上原点） */
  textLayer: TextLayerBlock[];
  onAdd: (a: PdfAnnotation) => void;
  onUpdate: (id: string, patch: Partial<PdfAnnotation>) => void;
  onSelect: (id: string | null) => void;
  onStartEdit: (id: string) => void;
  onCommitEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
  registerRef: (pageNo: number, el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageSize, setPageSize] = useState<{ w: number; h: number } | null>(null);
  const [selRect, setSelRect] = useState<Rect | null>(null);
  const dragRef = useRef<DragState>(null);
  const renderTaskRef = useRef<{ promise: Promise<void>; cancel?: () => void } | null>(null);
  const renderedScaleRef = useRef(0);
  const isVisibleRef = useRef(false);

  const pageAnns = annotations.filter((a) => a.page === pageNo);

  /** 渲染本页 canvas（仅可见时执行；缩放变化自动重渲染） */
  const renderPage = useCallback(async () => {
    if (!isVisibleRef.current || renderedScaleRef.current === scale) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    try {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // 高分辨率渲染（与缩放比例正交，只提升清晰度）
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      // 同步页面 CSS 像素尺寸，供批注层定位
      wrap.style.width = `${Math.floor(viewport.width)}px`;
      wrap.style.height = `${Math.floor(viewport.height)}px`;
      setPageSize((prev) => {
        const w = Math.floor(viewport.width);
        const h = Math.floor(viewport.height);
        return prev && prev.w === w && prev.h === h ? prev : { w, h };
      });
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
      renderTaskRef.current?.cancel?.();
      renderTaskRef.current = page.render({ canvasContext: ctx, viewport, transform });
      await renderTaskRef.current.promise;
      renderedScaleRef.current = scale;
    } catch { /* 页面渲染失败忽略（保持占位） */ }
  }, [doc, pageNo, scale]);

  // 注册页面元素（供父级跳页 / 滚动跟踪当前页）
  useEffect(() => {
    registerRef(pageNo, wrapRef.current);
    return () => registerRef(pageNo, null);
  }, [pageNo, registerRef]);

  // 预置页面尺寸（只量尺寸、不渲染 canvas）：连续滚动下所有页需具备真实高度，
  // 否则未进入视口的页仅有 100px 占位，跨页跳转（深链 page=N）会落到错误位置
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNo);
        const vp = page.getViewport({ scale });
        if (cancelled) return;
        const w = Math.floor(vp.width);
        const h = Math.floor(vp.height);
        setPageSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      } catch { /* 页面元数据不可用时保持占位尺寸 */ }
    })();
    return () => { cancelled = true; };
  }, [doc, pageNo, scale]);

  // 可见性观察：进入视口时渲染；缩放/文档变化时可见页自动重渲染
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            isVisibleRef.current = true;
            void renderPage();
          } else {
            isVisibleRef.current = false;
          }
        }
      },
      { root: null, rootMargin: '300px 0px' },
    );
    io.observe(wrap);
    return () => io.disconnect();
  }, [renderPage]);

  // 卸载时取消在途渲染
  useEffect(() => () => { renderTaskRef.current?.cancel?.(); }, []);

  // ---- 批注交互（本页坐标系）----
  const handleAnnMouseDown = (e: React.MouseEvent, a: PdfAnnotation) => {
    e.stopPropagation();
    onSelect(a.id);
    if (e.button !== 0 || !wrapRef.current || !pageSize) return;
    const rect = wrapRef.current.getBoundingClientRect();
    dragRef.current = { kind: 'move', id: a.id, lastX: e.clientX - rect.left, lastY: e.clientY - rect.top };
  };

  /** 右下角手柄：自由调整文字框大小（记录起点与初始尺寸，move 时按位移更新） */
  const handleResizeMouseDown = (e: React.MouseEvent, a: PdfAnnotation) => {
    e.stopPropagation();
    onSelect(a.id);
    if (e.button !== 0 || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    dragRef.current = {
      kind: 'resize',
      id: a.id,
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      startW: a.width,
      startH: a.height,
    };
  };

  const onWrapMouseDown = (e: React.MouseEvent) => {
    if (mode === 'none' || e.button !== 0 || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;
    dragRef.current = { kind: 'create', startX, startY };
    setSelRect({ x: startX, y: startY, w: 0, h: 0 });
  };

  const onWrapMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag || !pageSize || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (drag.kind === 'create') {
      setSelRect(normRect(drag.startX, drag.startY, x, y));
      return;
    }

    if (drag.kind === 'resize') {
      // 调整文字框大小：从起点按位移增减归一化宽高，保留最小尺寸
      const nw = Math.max(0.03, clamp01(drag.startW + (x - drag.startX) / pageSize.w));
      const nh = Math.max(0.02, clamp01(drag.startH + (y - drag.startY) / pageSize.h));
      if (nw === drag.startW && nh === drag.startH) return;
      onUpdate(drag.id, { width: nw, height: nh });
      return;
    }

    // 移动已有批注（以最新批注坐标为准累加位移）
    const cur = annotations.find((it) => it.id === drag.id);
    if (!cur) return;
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    drag.lastX = x;
    drag.lastY = y;
    if (dx === 0 && dy === 0) return;
    onUpdate(drag.id, {
      x: clamp01(cur.x + dx / pageSize.w),
      y: clamp01(cur.y + dy / pageSize.h),
    });
  };

  const onWrapMouseUp = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setSelRect(null);
    if (!drag || drag.kind !== 'create' || !pageSize || !wrapRef.current) return;

    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const r = normRect(drag.startX, drag.startY, x, y);
    const now = new Date().toISOString();

    if (mode === 'highlight') {
      if (r.w < 2 || r.h < 2) return; // 视为误点
      onAdd({
        id: genId(),
        type: 'highlight',
        page: pageNo,
        x: clamp01(r.x / pageSize.w),
        y: clamp01(r.y / pageSize.h),
        width: clamp01(r.w / pageSize.w),
        height: clamp01(r.h / pageSize.h),
        color: '#ffd54d',
        createdAt: now,
        updatedAt: now,
      });
    } else if (mode === 'textbox') {
      let nx: number, ny: number, nw: number, nh: number;
      if (r.w < 4 && r.h < 4) {
        // 点击：以点击点为中心生成默认尺寸文字框
        nw = 0.22;
        nh = 0.07;
        nx = clamp01(r.x / pageSize.w - nw / 2);
        ny = clamp01(r.y / pageSize.h - nh / 2);
      } else {
        nw = clamp01(r.w / pageSize.w);
        nh = clamp01(r.h / pageSize.h);
        nx = clamp01(r.x / pageSize.w);
        ny = clamp01(r.y / pageSize.h);
      }
      const id = genId();
      onAdd({
        id,
        type: 'textbox',
        page: pageNo,
        x: nx,
        y: ny,
        width: Math.max(nw, 0.03),
        height: Math.max(nh, 0.02),
        color: '#ffffff',
        text: '',
        fontSize: fontSizePref,
        createdAt: now,
        updatedAt: now,
      });
      onSelect(id);
      onStartEdit(id); // 新文字框直接进入编辑
    }
  };

  const onWrapMouseLeave = () => {
    if (dragRef.current?.kind === 'create') {
      dragRef.current = null;
      setSelRect(null);
    }
  };

  const pw = pageSize?.w ?? 0;
  const ph = pageSize?.h ?? 0;

  return (
    <div
      ref={wrapRef}
      data-page={pageNo}
      className="relative"
      style={{
        width: pageSize?.w ?? '100%',
        height: pageSize?.h ?? 100,
        cursor: mode !== 'none' ? 'crosshair' : 'default',
        // 与 MD 预览「纸张卡片」一致的柔和投影/圆角
        borderRadius: 10,
        boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 10px 30px rgba(0,0,0,0.06)',
      }}
      onMouseDown={onWrapMouseDown}
      onMouseMove={onWrapMouseMove}
      onMouseUp={onWrapMouseUp}
      onMouseLeave={onWrapMouseLeave}
    >
      <canvas ref={canvasRef} className="absolute left-0 top-0 rounded-[10px]" />

      {/* 搜索命中高亮（归一化矩形 × 页面像素；当前命中用橙色强调） */}
      {searchRects.map((r, ri) => (
        <div
          key={ri}
          className="pointer-events-none absolute rounded-[2px]"
          style={{
            left: r.x * pw,
            top: r.y * ph,
            width: Math.max(2, r.w * pw),
            height: Math.max(2, r.h * ph),
            backgroundColor: r.current ? 'rgba(255,112,67,0.5)' : 'rgba(255,213,77,0.38)',
            border: r.current ? '1.5px solid #ff7043' : 'none',
            mixBlendMode: 'multiply',
          }}
        />
      ))}

      {/* OCR 识别文字层（可视化感知：半透明文字叠在页面上） */}
      {textLayer.map((b, i) => (
        <div
          key={i}
          className="pointer-events-none absolute overflow-hidden whitespace-nowrap"
          style={{
            left: b.x * pw,
            top: b.y * ph,
            width: b.w * pw,
            height: b.h * ph,
            fontSize: Math.max(7, b.h * ph * 0.85),
            lineHeight: 1,
            color: 'rgba(59,130,246,0.8)',
            backgroundColor: 'rgba(59,130,246,0.10)',
            textOverflow: 'ellipsis',
          }}
          title={b.text}
        >
          {b.text}
        </div>
      ))}

      {/* 拖选预览框 */}
      {selRect && mode !== 'none' && (
        <div
          className="pointer-events-none absolute border border-dashed"
          style={{
            left: selRect.x,
            top: selRect.y,
            width: selRect.w,
            height: selRect.h,
            borderColor: mode === 'highlight' ? '#ffd54d' : '#90caf9',
            backgroundColor: mode === 'highlight' ? 'rgba(255,213,77,0.15)' : 'rgba(144,202,249,0.08)',
          }}
        />
      )}

      {/* 本页批注 */}
      {pageAnns.map((a) => {
        const left = a.x * pw;
        const top = a.y * ph;
        const width = Math.max(2, a.width * pw);
        const height = Math.max(2, a.height * ph);
        const isSel = selectedId === a.id;

        if (a.type === 'highlight') {
          return (
            <div
              key={a.id}
              className="absolute rounded-[2px]"
              style={{
                left,
                top,
                width,
                height,
                backgroundColor: hexWithAlpha(a.color, isSel ? 0.5 : 0.32),
                border: isSel ? `1.5px solid ${a.color}` : '1.5px solid transparent',
                mixBlendMode: 'multiply',
                cursor: 'move',
              }}
              onMouseDown={(e) => handleAnnMouseDown(e, a)}
              onClick={(e) => { e.stopPropagation(); onSelect(a.id); }}
              title="Drag to move, click to select"
            />
          );
        }

        // textbox
        if (editingId === a.id) {
          return (
            <EditableText
              key={a.id}
              initial={a.text || ''}
              onCommit={(t) => onCommitEdit(a.id, t)}
              onCancel={onCancelEdit}
              style={{ left, top, width, height, fontSize: a.fontSize ?? 12 }}
            />
          );
        }

        return (
          <div
            key={a.id}
            className={`absolute ${isSel ? 'outline-2 outline-solid' : 'hover:outline-1 hover:outline-dashed'}`}
            style={{
              left,
              top,
              // 随文字数量缩放：auto 尺寸贴合内容，存储的宽高作为最小尺寸（手动调整大小仍生效）
              width: 'auto',
              minWidth: Math.max(80, width),
              minHeight: height,
              backgroundColor: 'transparent',
              border: 'none',
              boxShadow: 'none',
              borderRadius: 0,
              padding: 0,
              fontSize: a.fontSize ?? 12,
              lineHeight: 1.5,
              color: 'var(--ink)',
              outlineColor: isSel ? 'var(--info)' : 'var(--line)',
              overflow: 'visible',
              cursor: 'move',
            }}
            onMouseDown={(e) => handleAnnMouseDown(e, a)}
            onClick={(e) => { e.stopPropagation(); onSelect(a.id); }}
            onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(a.id); }}
            title="Drag to move, double-click to edit, resize with the bottom-right handle"
          >
            <div className="whitespace-pre-wrap break-words">
              {a.text || <span style={{ color: 'var(--ink-faint)' }}>Double-click to enter text</span>}
            </div>
            {/* 右下角调整大小手柄（选中时显示） */}
            {isSel && (
              <div
                className="absolute"
                style={{
                  right: -4,
                  bottom: -4,
                  width: 10,
                  height: 10,
                  cursor: 'nwse-resize',
                  borderRight: '2px solid var(--info)',
                  borderBottom: '2px solid var(--info)',
                }}
                onMouseDown={(e) => handleResizeMouseDown(e, a)}
                onDoubleClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PdfViewer({ url, fileName, filePath, initialPage, initialQuery }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PdfjsDocument | null>(null);
  /** 已加载的 pdfjs 文档（渲染经 props 分发给各页子组件 PdfPageView） */
  const [pdfDoc, setPdfDoc] = useState<PdfjsDocument | null>(null);
  // pdfjs v6：PDFDocumentProxy 没有 destroy()，销毁必须走 loadingTask（卸载/换文件时调用）
  const loadingTaskRef = useRef<PdfjsLoadingTask | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 用户手动缩放后停止自动适配（fit-width 只在首屏与容器尺寸变化时生效）
  const userScaledRef = useRef(false);

  // ---- 批注状态 ----
  const [mode, setMode] = useState<AnnotationMode>('none');
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // 文字批注字号偏好（新建文字框默认字号；选中文字框时调整会同步写入批注）
  const [fontSizePref, setFontSizePref] = useState(12);
  /** 批注列表侧栏开关（全文档批注一览 + 点击跳转） */
  const [annotsOpen, setAnnotsOpen] = useState(false);
  const dirtyRef = useRef(false);

  // ---- 全文检索状态 ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(-1); // 当前命中下标，-1 表示无
  const [indexing, setIndexing] = useState(false); // 文本层索引构建中
  const [isScanned, setIsScanned] = useState(false); // 疑似扫描件（文本层缺失）
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  // ---- OCR 单一事实源：入口提示 / 过程反馈 / 持久标记 / 文本层都从 ocrState 派生 ----
  const [ocrState, setOcrState] = useState<OcrState>({ status: 'idle', meta: null, pages: null });
  /** 本次会话 OCR 完成浮层是否展示过（自动消失 + 手动关闭） */
  const [ocrResultShown, setOcrResultShown] = useState(false);
  const [scanBannerDismissed, setScanBannerDismissed] = useState(false);
  const [showTextLayer, setShowTextLayer] = useState(false);
  /** 过程阶段反馈：模拟页码滚动 + 已用秒数（OCR API 为一次性阻塞任务，无真实进度） */
  const [ocrSimPage, setOcrSimPage] = useState(0);
  const [ocrElapsedSec, setOcrElapsedSec] = useState(0);
  const ocrStartRef = useRef(0);
  const ocrSimTimerRef = useRef<number | null>(null);
  // 文本层索引不参与渲染，用 ref 持有（归一化坐标对缩放不变，一次构建全档复用）
  const pageIndexRef = useRef<{ entries: PageTextIndexEntry[]; viewports: Array<ViewportMeta | undefined> } | null>(null);
  /** 外部深链锚点已应用标记（文档加载完成后仅生效一次，避免检索/滚动过程反复触发） */
  const initialPageAppliedRef = useRef(false);
  const initialQueryAppliedRef = useRef(false);

  // ---- 页面缩略图侧栏 ----
  const [thumbsOpen, setThumbsOpen] = useState(false);
  /** 缩略图 dataURL（1 基索引；未渲染页为 undefined） */
  const [thumbUrls, setThumbUrls] = useState<(string | undefined)[]>([]);
  /** 已渲染完成的页码集合（切换侧栏开关时跳过重渲染） */
  const renderedThumbsRef = useRef<Set<number>>(new Set());
  const thumbListRef = useRef<HTMLDivElement>(null);

  // ---- hover 长上下文预览（浮层挂 body：不受侧栏滚动裁剪，定位一次固定，无拖尾）----
  const [preview, setPreview] = useState<{ hit: SearchHit; anchor: DOMRect } | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  /** 进入条目：延迟展开，快速划过列表时不闪现 */
  const openPreview = useCallback((hit: SearchHit, el: HTMLElement) => {
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => {
      setPreview({ hit, anchor: el.getBoundingClientRect() });
    }, 140);
  }, []);

  /** 离开条目：延迟收起，给指针滑入浮层留过渡窗口 */
  const schedulePreviewClose = useCallback(() => {
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null; }
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setPreview(null), 160);
  }, []);

  const cancelPreviewClose = useCallback(() => {
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  }, []);

  // 重跑检索后旧预览立即作废；卸载收尾清理定时器；Escape 快捷关闭
  useEffect(() => { setPreview(null); }, [hits]);
  useEffect(() => () => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);
  useEffect(() => {
    if (!preview) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  const markDirty = useCallback(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirty(true);
    }
  }, []);

  const addAnnotation = useCallback((a: PdfAnnotation) => {
    setAnnotations((prev) => [...prev, a]);
    markDirty();
  }, [markDirty]);

  const updateAnnotation = useCallback((id: string, patch: Partial<PdfAnnotation>) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: new Date().toISOString() } : a)),
    );
    markDirty();
  }, [markDirty]);

  // ---- 纵向连续滚动：页面元素注册 / 跳页 / 滚动时跟踪当前页 ----
  const pageElsRef = useRef<(HTMLDivElement | null)[]>([]);
  const registerPageEl = useCallback((pageNo: number, el: HTMLDivElement | null) => {
    pageElsRef.current[pageNo] = el;
  }, []);

  /** 跳转到指定页：滚动到该页顶部并同步当前页状态 */
  const scrollToPage = useCallback((p: number) => {
    setPageNum(p);
    const el = pageElsRef.current[p];
    el?.scrollIntoView({ block: 'start' });
  }, []);

  // 滚动时按「页面中心距视口中心最近」跟踪当前页（rAF 节流，避免滚动每帧触发 setState）
  const scrollRafRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const c = containerRef.current;
      if (!c) return;
      const containerTop = c.getBoundingClientRect().top;
      const mid = c.clientHeight / 2;
      let best = 0;
      let bestDist = Infinity;
      for (let p = 1; p <= totalPages; p++) {
        const el = pageElsRef.current[p];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const dist = Math.abs(r.top + r.height / 2 - containerTop - mid);
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      if (best !== 0) setPageNum((prev) => (prev === best ? prev : best));
    });
  }, [totalPages]);
  // 卸载时取消在途滚动节流
  useEffect(() => () => {
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
  }, []);

  /** 按容器可用宽度计算缩放：页面宽度铺满容器（高度按比例，纵向可滚动阅读）。
   *  若按高度适配，页面会被压缩到恰好填满视口，任何滚动都无溢出可滚（体验像"卡死"），
   *  故默认按宽度适配 —— 纵向页面（绝大多数法律文档）自然向下滚动，符合常规 PDF 阅读器习惯 */
  const fitScaleToContainer = useCallback(async () => {
    if (!pdfDocRef.current || !containerRef.current) return;
    try {
      // 连续滚动模式所有页共享同一缩放，以第 1 页宽度为基准铺满容器
      const page = await pdfDocRef.current.getPage(1);
      const container = containerRef.current;
      // p-4 = 上下/左右各 16px；限宽 MAX_PAGE_W，对齐 MD 预览「居中纸张」排版
      const availW = Math.min(container.clientWidth - 32, MAX_PAGE_W);
      if (availW <= 0) return;
      const vp = page.getViewport({ scale: 1 });
      setScale(Math.max(0.3, availW / vp.width));
    } catch { /* 页面尚未就绪时忽略 */ }
  }, []);

  // 加载 PDF 文档
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // 动态导入 pdfjs-dist，使用本地 worker（public/ 静态文件，版本一致、离线可用）
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        const loadingTask = pdfjsLib.getDocument({ url });
        loadingTaskRef.current = loadingTask;
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        pdfDocRef.current = pdf;
        setPdfDoc(pdf);
        setTotalPages(pdf.numPages);
        setPageNum(1);
        setLoading(false);

        // 换文件后清空上一份的检索状态
        setQuery('');
        setHits([]);
        setCursor(-1);
        setIsScanned(false);
        pageIndexRef.current = null;
        // 换文件后重置深链锚点应用标记（新文档允许再次定位）
        initialPageAppliedRef.current = false;
        initialQueryAppliedRef.current = false;
        // 注：OCR 状态（ocrState）由下方「读取 OCR 持久化标记」effect 负责重置，
        // 此处不得清除 —— 本 effect 的 await 晚于状态读取返回，在此重置会把「已识别」状态清掉，
        // 导致已解析的扫描件重开仍提示要解析。
        // 换文件后清空缩略图缓存
        renderedThumbsRef.current = new Set();
        setThumbUrls([]);

        // 异步构建全页文本层索引（scale=1 视口；归一化命中矩形对均匀缩放不变）
        try {
          setIndexing(true);
          const entries: PageTextIndexEntry[] = [];
          const viewports: Array<ViewportMeta | undefined> = [];
          for (let p = 1; p <= pdf.numPages; p++) {
            if (cancelled) return;
            const pg = await pdf.getPage(p);
            const vp1 = pg.getViewport({ scale: 1 });
            let entry: PageTextIndexEntry = { text: '', segments: [], items: [] };
            try {
              const tc = await pg.getTextContent();
              entry = buildPageText(tc.items as unknown as TextItemGeom[]);
            } catch { /* 个别页文本层读取失败按空白页处理 */ }
            entries.push(entry);
            viewports.push({ transform: vp1.transform, scale: 1, w: vp1.width, h: vp1.height });
          }
          if (cancelled) return;
          pageIndexRef.current = { entries, viewports };
          setIsScanned(looksLikeScannedPdf(entries));
        } catch { /* 索引构建失败时仅剩 OCR 兜底 */ } finally {
          if (!cancelled) setIndexing(false);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load PDF');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // 通过 loadingTask 销毁文档（pdfjs v6 的 PDFDocumentProxy 没有 destroy()）
      try {
        loadingTaskRef.current?.destroy?.();
      } catch { /* 文档已销毁或加载失败时忽略 */ }
      loadingTaskRef.current = null;
      pdfDocRef.current = null;
      setPdfDoc(null);
    };
  }, [url]);

  // 加载 sidecar 批注（切文件时重新读取）
  useEffect(() => {
    let cancelled = false;
    setAnnotations([]);
    setSelectedId(null);
    setEditingId(null);
    setDirty(false);
    dirtyRef.current = false;
    if (!filePath) return;
    (async () => {
      try {
        const resp = await fetch(`/api/pdf-annotations?path=${encodeURIComponent(filePath)}`);
        const data = await resp.json();
        if (!cancelled && data.success) {
          setAnnotations(data.annotations || []);
        }
      } catch { /* 读取失败视为无批注 */ }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  // 读取 OCR 持久化标记（<pdf>.ocr.json）：已识别过的扫描件重开即显示「已识别」，并恢复检索 / 文本层
  useEffect(() => {
    let cancelled = false;
    // 换文件 → 先清空 OCR 状态（此处是唯一重置点，避免与文档加载流程的时序竞争）
    setOcrState({ status: 'idle', meta: null, pages: null });
    setOcrResultShown(false);
    setScanBannerDismissed(false);
    setShowTextLayer(false);
    setOcrSimPage(0);
    setOcrElapsedSec(0);
    setOcrMsg(null);
    if (!filePath) return;
    (async () => {
      try {
        const resp = await fetch(`/api/pdf-ocr-status?path=${encodeURIComponent(filePath)}`);
        const data = await resp.json();
        if (!cancelled && data.success && data.meta?.done && Array.isArray(data.pages) && data.pages.length > 0) {
          setOcrState({ status: 'done', meta: data.meta as OcrStatusMeta, pages: data.pages as OcrPageText[] });
        }
      } catch { /* 读取失败视为未识别过 */ }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  // 卸载时清理 OCR 模拟进度定时器
  useEffect(() => () => {
    if (ocrSimTimerRef.current !== null) window.clearInterval(ocrSimTimerRef.current);
  }, []);

  // OCR 完成浮层：自动消失（6s），也可手动关闭
  useEffect(() => {
    if (!ocrResultShown) return;
    const t = window.setTimeout(() => setOcrResultShown(false), 6000);
    return () => window.clearTimeout(t);
  }, [ocrResultShown]);


  // 文档加载完成（totalPages 就绪）后，按容器高度自适应；切页且未手动缩放时同样适配新页
  useEffect(() => {
    if (totalPages > 0 && !userScaledRef.current) {
      fitScaleToContainer();
    }
  }, [totalPages, fitScaleToContainer]);

  // 容器尺寸变化（面板宽/高调整）且未手动缩放时，重新适配填满容器
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!userScaledRef.current) fitScaleToContainer();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitScaleToContainer]);

  // ---- 缩略图渲染：侧栏打开时逐页后台渲染（已渲染页跳过），换文档/关闭时取消 ----
  useEffect(() => {
    const doc = pdfDocRef.current;
    if (!doc || !thumbsOpen) return;
    let cancelled = false;
    (async () => {
      for (let p = 1; p <= doc.numPages; p++) {
        if (cancelled) return;
        if (renderedThumbsRef.current.has(p)) continue;
        try {
          const page = await doc.getPage(p);
          if (cancelled) return;
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: THUMB_W / vp1.width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(vp.width);
          canvas.height = Math.floor(vp.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          if (cancelled) return;
          const dataUrl = canvas.toDataURL('image/png');
          renderedThumbsRef.current.add(p);
          setThumbUrls((prev) => {
            const next = prev.slice();
            next[p] = dataUrl;
            return next;
          });
        } catch { /* 单页缩略图失败跳过，保持占位 */ }
      }
    })();
    return () => { cancelled = true; };
  }, [thumbsOpen, url]);

  // 当前页变化时，缩略图列表滚动到对应条目（nearest 仅在可见区外时滚动）
  useEffect(() => {
    if (!thumbsOpen) return;
    const list = thumbListRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-page="${pageNum}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [thumbsOpen, pageNum]);

  // 键盘导航 + Delete 删除选中批注
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // ⌘⇧F / Ctrl+Shift+F：PDF 内查找（⌘F 已专属全局搜索）
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key === 'Escape' && searchOpen && !editingId) {
        setSearchOpen(false);
        return;
      }
      // 输入框（检索关键词等）内移动光标时不触发翻页
      const inInput = e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT');
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && !inInput && pageNum > 1) {
        scrollToPage(pageNum - 1);
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowDown') && !inInput && pageNum < totalPages) {
        scrollToPage(pageNum + 1);
      } else if ((e.key === 'Delete') && selectedId) {
        e.preventDefault();
        setAnnotations((prev) => prev.filter((a) => a.id !== selectedId));
        setSelectedId(null);
        markDirty();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [pageNum, totalPages, selectedId, editingId, searchOpen, markDirty, scrollToPage]);

  // ---- 批注编辑态回调（实际交互分发到各页子组件 PdfPageView）----
  const handleStartEdit = useCallback((id: string) => setEditingId(id), []);
  const handleCommitEdit = useCallback((id: string, text: string) => {
    updateAnnotation(id, { text });
    setEditingId(null);
  }, [updateAnnotation]);
  const handleCancelEdit = useCallback(() => setEditingId(null), []);

  const handleSave = async () => {
    if (!filePath) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const resp = await fetch('/api/pdf-annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, annotations }),
      });
      const data = await resp.json();
      if (data.success) {
        dirtyRef.current = false;
        setDirty(false);
        setSaveMsg('Saved');
        setTimeout(() => setSaveMsg(null), 2000);
      } else {
        setSaveMsg(`Save failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      setSaveMsg(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSelected = () => {
    if (!selectedId) return;
    setAnnotations((prev) => prev.filter((a) => a.id !== selectedId));
    setSelectedId(null);
    markDirty();
  };

  /** 调整文字字号：记住偏好（新建文字框用）；选中文字框时同步写入该批注 */
  const handleFontSizeChange = (v: number) => {
    setFontSizePref(v);
    if (selectedId) {
      const target = annotations.find((a) => a.id === selectedId);
      if (target?.type === 'textbox') {
        updateAnnotation(selectedId, { fontSize: v });
      }
    }
  };

  // ---- 全文检索 ----
  const runSearch = useCallback((q: string, ocrPagesOverride?: OcrPageText[] | null) => {
    const trimmed = q.trim();
    setCursor(-1);
    if (!trimmed) { setHits([]); return; }
    const idx = pageIndexRef.current;
    let found: SearchHit[] = [];
    // 原生文本层优先（带高亮矩形）；文本层缺失或 0 命中时降级 OCR 检索。
    // 注意不能在这里短路 return：带水印文本层的扫描件（isScanned 误判为 false）
    // 文本层搜不到任何内容，必须继续用 OCR 结果兜底，否则"OCR 完成后仍无法检索"
    if (!isScanned && idx) {
      found = searchPageIndexes(idx.entries, trimmed, { viewports: idx.viewports });
    }
    if (found.length === 0) {
      // OCR 刚写入时 state 尚未提交，调用方可显式传入刚拿到的 pages（见 handleRunOcr）
      const pages = ocrPagesOverride ?? ocrState.pages;
      if (pages && pages.length > 0) {
        found = searchOcrPages(pages, trimmed);
      }
    }
    setHits(found);
    if (found.length > 0) setCursor(0);
  }, [isScanned, ocrState.pages]);

  /** 上/下一条命中（Enter=下一条、Shift+Enter=上一条），循环绕回 */
  const jumpToOffset = (delta: number) => {
    const n = hits.length;
    if (n === 0) return;
    setCursor((c) => ((Math.max(c, 0) + delta) % n + n) % n);
  };

  // 命中所在页变化时自动滚动到目标页锁定位置。
  // 仅当「游标命中的目标页」发生变化（Enter 上下条 / 点击命中列表 / 新检索）时才跟随；
  // 用户滚动 / 方向键手动翻页不会触发，避免检索打开时无法切换页面、甚至连环回跳崩溃
  const currentHitPage = cursor >= 0 ? hits[cursor]?.page : undefined;
  const lastAutoNavPageRef = useRef<number | null>(null);
  useEffect(() => {
    if (currentHitPage === undefined) { lastAutoNavPageRef.current = null; return; }
    if (currentHitPage !== lastAutoNavPageRef.current) {
      lastAutoNavPageRef.current = currentHitPage;
      if (currentHitPage !== pageNum) scrollToPage(currentHitPage);
    }
  }, [currentHitPage, pageNum, scrollToPage]);

  // 外部深链锚点①：文档就绪后跳转到 initialPage。
  // 各页初始为 100px 占位、缩放又由容器宽度异步计算，故需等目标页具备稳定真实高度
  // （连续 2 帧尺寸不变）后再滚动，否则 scrollIntoView 会落在错误的页。
  useEffect(() => {
    if (!initialPage || totalPages <= 0 || initialPageAppliedRef.current) return;
    if (initialPage < 1 || initialPage > totalPages) return;
    initialPageAppliedRef.current = true;
    let raf = 0;
    let frames = 0;
    let lastH = -1;
    let stable = 0;
    const tick = () => {
      frames += 1;
      const el = pageElsRef.current[initialPage];
      const h = el?.offsetHeight ?? 0;
      stable = el && h > 150 && h === lastH ? stable + 1 : 0;
      lastH = h;
      // 布局稳定（或超时兜底）后再滚动
      if (stable >= 2 || frames > 120) {
        scrollToPage(initialPage);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [initialPage, totalPages, scrollToPage]);

  // 外部深链锚点②：文本层索引就绪后按 initialQuery 自动检索并高亮（命中即经上面的跟随逻辑跳页）
  useEffect(() => {
    const q = (initialQuery || '').trim();
    if (!q || !pdfDoc || indexing) return;
    if (initialQueryAppliedRef.current) {
      // 已应用过：仅当此前 0 命中且扫描件 OCR 结果刚到（ocrState.meta 变化）时补跑一次
      if (hits.length > 0 || !ocrState.meta) return;
    }
    initialQueryAppliedRef.current = true;
    setSearchOpen(true);
    setQuery(q);
    runSearch(q);
  }, [initialQuery, pdfDoc, indexing, ocrState.meta, hits.length, runSearch]);

  /** 一键 BOB OCR：识别全文后写入 ocrState，持久化「已识别」标记，并自动重跑当前关键词 */
  const handleRunOcr = async () => {
    if (!filePath || ocrState.status === 'running') return;
    setOcrMsg(null);
    setOcrState((s) => ({ ...s, status: 'running' }));
    setOcrResultShown(false);
    setOcrSimPage(0);
    setOcrElapsedSec(0);
    ocrStartRef.current = Date.now();
    // 过程阶段反馈：模拟页码滚动 + 已用秒数（OCR API 为一次性阻塞任务，无真实进度接口）
    ocrSimTimerRef.current = window.setInterval(() => {
      const sec = Math.floor((Date.now() - ocrStartRef.current) / 1000);
      setOcrElapsedSec(sec);
      setOcrSimPage((p) => Math.min(totalPages, Math.max(p, Math.floor(sec / 1.5))));
    }, 500);
    try {
      const resp = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await resp.json();
      if (data.success) {
        let pages: OcrPageText[] = Array.isArray(data.pages) && data.pages.length > 0
          ? (data.pages as Array<Record<string, unknown>>).map((p, i) => ({
              page: Number(p.index ?? p.page ?? i + 1),
              text: String(p.text ?? ''),
              // 行级坐标骨架（本地 Vision 引擎才有）：检索命中可画精确高亮框
              blocks: Array.isArray(p.blocks)
                ? (p.blocks as unknown as OcrBlockGeom[]).filter(
                    (b) => b && typeof b.text === 'string' && [b.x, b.y, b.w, b.h].every((n) => typeof n === 'number' && Number.isFinite(n)),
                  )
                : undefined,
            }))
          : splitOcrPagesFromText(String(data.text || ''));
        // 兜底：有全文但无 pages[] 且无 [Page N] 标记（如 GLM-OCR 聚合输出）时按单页处理，
        // 保证 OCR 结果始终可检索，而不是误报"未识别到文本"
        if (pages.length === 0 && String(data.text || '').trim()) {
          pages = [{ page: 1, text: String(data.text).trim() }];
        }
        if (pages.length === 0) {
          setOcrMsg('OCR found no text');
          setOcrState((s) => ({ ...s, status: 'error' }));
        } else {
          const meta: OcrStatusMeta = {
            done: true,
            pageCount: pages.length,
            upgradedCount: Number(data.upgradedCount ?? 0),
            elapsedMs: Date.now() - ocrStartRef.current,
            ocrAt: new Date().toISOString(),
          };
          setOcrState({ status: 'done', meta, pages });
          setOcrResultShown(true);
          setOcrSimPage(totalPages);
          setOcrMsg(`OCR finished (${pages.length} pages)`);
          // state 尚未提交，显式把刚识别出的 pages 交给检索，避免用旧值搜
          if (query.trim()) runSearch(query, pages);
          // 持久化 sidecar：重开该 PDF 直接恢复「已识别」+ 检索 + 文本层，无需二次 OCR
          void fetch('/api/pdf-ocr-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, meta, pages }),
          }).catch(() => {});
        }
      } else {
        setOcrMsg(`OCR failed: ${data.error || 'Unknown error'}`);
        setOcrState((s) => ({ ...s, status: 'error' }));
      }
    } catch (err) {
      setOcrMsg(`OCR failed: ${err instanceof Error ? err.message : String(err)}`);
      setOcrState((s) => ({ ...s, status: 'error' }));
    } finally {
      if (ocrSimTimerRef.current !== null) { window.clearInterval(ocrSimTimerRef.current); ocrSimTimerRef.current = null; }
    }
  };

  // 工具栏字号下拉的当前值：选中文字框 → 其字号；否则 → 默认偏好
  const selectedAnn = selectedId ? annotations.find((a) => a.id === selectedId) : undefined;
  const selectedTextFontSize = selectedAnn?.type === 'textbox' ? (selectedAnn.fontSize ?? 12) : fontSizePref;

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: 'var(--info)' }} />
        <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Loading PDF...</span>
      </div>
    );
  }

  if (error) {
    // 回退到 iframe
    return (
      <div className="flex-1">
        <iframe src={url} className="h-full w-full border-0" title={fileName} />
      </div>
    );
  }

  const selectedColor = annotations.find((a) => a.id === selectedId)?.color;

  // 检索命中矩形（归一化 0~1）按页分组，交各页子组件按自身页面尺寸渲染
  const pageHitRects = new Map<number, { x: number; y: number; w: number; h: number; current: boolean }[]>();
  hits.forEach((h, hi) => {
    if (h.rects.length === 0) return;
    const arr = pageHitRects.get(h.page) ?? [];
    for (const r of h.rects) arr.push({ x: r.x, y: r.y, w: r.w, h: r.h, current: hi === cursor });
    pageHitRects.set(h.page, arr);
  });

  const ocrPages = ocrState.pages;
  const hasOcrPages = !!(ocrPages && ocrPages.length > 0);
  const scanNeedsOcr = isScanned && !hasOcrPages;
  // 批注列表导航：按页码 + 页内纵向位置排序（点击跳转到所在页并选中该条）
  const sortedAnns = [...annotations].sort((a, b) => a.page - b.page || a.y - b.y);
  // 文本层可能只有水印/页脚（如工商内档）：搜不到时也给 OCR 出口，不依赖 isScanned 判定
  const noHitNeedsOcr = !hasOcrPages && !indexing && !!query.trim() && hits.length === 0;

  const ocrDone = ocrState.status === 'done' || !!ocrState.meta;
  const ocrRunning = ocrState.status === 'running';
  // 扫描件 OCR 提示条：检测到扫描件且未识别过且未手动关闭时显示 CTA（识别中转为进度条）
  const showScanBanner = !!filePath && isScanned && !ocrDone && !scanBannerDismissed;
  // 文本层可视化：OCR 行级骨架（归一化 0~1，Vision 左下原点 → 翻转为左上原点）
  const textLayerByPage = new Map<number, TextLayerBlock[]>();
  if (showTextLayer && ocrPages) {
    for (const pg of ocrPages) {
      const blocks = pg.blocks;
      if (!blocks || blocks.length === 0) continue;
      textLayerByPage.set(pg.page, blocks.map((b) => ({ x: b.x, y: 1 - b.y - b.h, w: b.w, h: b.h, text: b.text })));
    }
  }

  // 侧栏状态行文案
  let searchStatus: string;
  if (indexing) searchStatus = 'Building text index…';
  else if (!query.trim()) searchStatus = scanNeedsOcr ? 'Looks like a scan — run OCR first' : 'Type a keyword to search';
  else if (hits.length === 0) searchStatus = scanNeedsOcr ? 'No matches (scans need OCR first)' : noHitNeedsOcr ? 'No matches (if this is a scan, run OCR first)' : 'No matches';
  else searchStatus = `Match ${cursor + 1} / ${hits.length}`;

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏（对齐 MD 预览：--line 底边、paper-soft 底、按钮 ink-muted 常态 / 品牌色激活） */}
      <div className="flex items-center gap-1 px-4 py-1.5 shrink-0"
        style={{ borderBottom: '1px solid var(--line)', backgroundColor: 'var(--paper-soft)' }}>
        <span className="text-xs whitespace-nowrap tabular-nums" style={{ color: 'var(--ink-muted)' }}>
          {pageNum} / {totalPages}
        </span>
        <div className="w-px h-4 bg-[var(--line)] mx-1" />
        <button
          onClick={() => { userScaledRef.current = true; setScale((s) => Math.max(0.5, s - 0.2)); }}
          className="rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)' }}
          title="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="text-xs w-10 text-center tabular-nums" style={{ color: 'var(--ink-muted)' }}>
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => { userScaledRef.current = true; setScale((s) => Math.min(3, s + 0.2)); }}
          className="rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)' }}
          title="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </button>

        {/* 页面缩略图开关 */}
        <div className="w-px h-4 bg-[var(--line)] mx-1" />
        <button
          onClick={() => setThumbsOpen((o) => !o)}
          className="rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
          style={{
            color: thumbsOpen ? 'var(--primary)' : 'var(--ink-muted)',
            backgroundColor: thumbsOpen ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent',
          }}
          title="Page thumbnails"
        >
          <LayoutGrid className="h-4 w-4" />
        </button>

        {/* 全文检索 + 扫描件 OCR */}
        <div className="w-px h-4 bg-[var(--line)] mx-1" />
        <button
          onClick={() => setSearchOpen((o) => !o)}
          className="rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
          style={{
            color: searchOpen ? 'var(--warn)' : 'var(--ink-muted)',
            backgroundColor: searchOpen ? 'color-mix(in oklab, var(--warn) 10%, transparent)' : 'transparent',
          }}
          title={indexing ? 'Building text index…' : 'Search in document (Ctrl/Cmd+Shift+F)'}
        >
          {indexing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </button>
        {filePath && (
          <>
            <button
              onClick={handleRunOcr}
              disabled={ocrRunning}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-60"
              style={{
                color: ocrDone ? 'var(--success)' : isScanned ? 'var(--warn)' : 'var(--ink-muted)',
                backgroundColor: isScanned && !ocrDone ? 'color-mix(in oklab, var(--warn) 10%, transparent)' : 'transparent',
              }}
              title={ocrDone ? 'Already OCR\u2019d (click to re-run)' : isScanned ? 'Scan detected — click to OCR so the text becomes searchable' : 'BOB OCR full-text recognition (makes scans searchable)'}
            >
              {ocrRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : ocrDone ? <Check className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
              <span>{ocrRunning ? 'OCR…' : ocrDone ? 'OCR done' : 'OCR'}</span>
            </button>
            {/* 文本层可视化：OCR 完成后可切换显示识别文字覆盖层 */}
            {ocrDone && (
              <button
                onClick={() => setShowTextLayer((v) => !v)}
                className="rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
                style={{
                  color: showTextLayer ? 'var(--primary)' : 'var(--ink-muted)',
                  backgroundColor: showTextLayer ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent',
                }}
                title="Show/hide the OCR text layer"
              >
                <Eye className="h-4 w-4" />
              </button>
            )}
          </>
        )}

        {/* 批注工具：高亮 / 文字 */}
        {filePath && (
          <>
            <div className="w-px h-4 bg-[var(--line)] mx-1" />
            <button
              onClick={() => setMode(mode === 'highlight' ? 'none' : 'highlight')}
              className="rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: mode === 'highlight' ? 'var(--warn)' : 'var(--ink-muted)', backgroundColor: mode === 'highlight' ? 'color-mix(in oklab, var(--warn) 10%, transparent)' : 'transparent' }}
              title="Highlight (drag to select an area)"
            >
              <Highlighter className="h-4 w-4" />
            </button>
            <button
              onClick={() => setMode(mode === 'textbox' ? 'none' : 'textbox')}
              className="rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: mode === 'textbox' ? 'var(--warn)' : 'var(--ink-muted)', backgroundColor: mode === 'textbox' ? 'color-mix(in oklab, var(--warn) 10%, transparent)' : 'transparent' }}
              title="Text note (click/drag to place, double-click to edit)"
            >
              <Type className="h-4 w-4" />
            </button>
            <select
              value={selectedTextFontSize}
              onChange={(e) => handleFontSizeChange(Number(e.target.value))}
              className="rounded-md border border-[var(--line)] bg-[var(--popover)] px-1 py-1 text-xs outline-none transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink)' }}
              title="Text size (applies to the selected text box; otherwise the default for new ones)"
            >
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>{s}px</option>
              ))}
            </select>

            {/* 批注列表开关：一览全文档批注，点击可跳回所在页 */}
            <div className="w-px h-4 bg-[var(--line)] mx-1" />
            <button
              onClick={() => setAnnotsOpen((o) => !o)}
              className="relative rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
              style={{
                color: annotsOpen ? 'var(--primary)' : 'var(--ink-muted)',
                backgroundColor: annotsOpen ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent',
              }}
              title={`Annotations (${annotations.length}) — jump back to any highlight or note`}
            >
              <StickyNote className="h-4 w-4" />
              {annotations.length > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 rounded-full px-1 tabular-nums"
                  style={{ fontSize: 9, lineHeight: 1.5, backgroundColor: 'var(--warn)', color: '#fff' }}
                >
                  {annotations.length}
                </span>
              )}
            </button>

            {/* 选中批注：删除 + 颜色 */}
            {selectedId && (
              <>
                <button
                  onClick={handleDeleteSelected}
                  className="rounded-md p-1.5 transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--danger)' }}
                  title="Delete annotation (Del)"
                >
                  <Trash className="h-4 w-4" />
                </button>
                <div className="flex items-center gap-1 ml-1">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => updateAnnotation(selectedId, { color: c })}
                      className="h-3.5 w-3.5 rounded-full border border-[var(--line)] transition-transform hover:scale-110"
                      style={{
                        backgroundColor: c,
                        outline: selectedColor === c ? '2px solid var(--info)' : 'none',
                        outlineOffset: 1,
                      }}
                      title={c}
                    />
                  ))}
                </div>
              </>
            )}

            <div className="flex-1" />
            {saveMsg && (
              <span className="text-xs whitespace-nowrap" style={{ color: /fail/i.test(saveMsg) ? 'var(--danger)' : 'var(--success)' }}>
                {saveMsg}
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              title={dirty ? 'Save annotations' : 'No changes'}
              className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed"
              style={{
                backgroundColor: dirty ? 'var(--warn)' : 'var(--paper-soft)',
                color: dirty ? '#fff' : 'var(--ink-muted)',
              }}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>

      {/* 扫描件 OCR 提示条（入口感知）：未识别时显示 CTA；识别中转为进度反馈 */}
      {(showScanBanner || ocrRunning) && (
        <div
          className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs"
          style={{
            borderBottom: '1px solid var(--line-soft)',
            backgroundColor: ocrRunning
              ? 'color-mix(in oklab, var(--info) 8%, var(--paper))'
              : 'color-mix(in oklab, var(--warn) 8%, var(--paper))',
            color: 'var(--ink)',
          }}
        >
          {ocrRunning ? (
            <>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: 'var(--info)' }} />
              <span className="min-w-0 flex-1 truncate">
                OCR running <span className="tabular-nums">{Math.min(ocrSimPage, totalPages)} / {totalPages}</span> pages…
              </span>
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--ink-muted)' }}>{ocrElapsedSec}s</span>
              <div className="h-1 w-28 shrink-0 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--paper-hover)' }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${totalPages > 0 ? (Math.min(ocrSimPage, totalPages) / totalPages) * 100 : 0}%`,
                    backgroundColor: 'var(--info)',
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <Zap className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--warn)' }} />
              <span className="min-w-0 flex-1 truncate">Scanned PDF detected (no text layer) — run OCR to search and copy text</span>
              <button
                onClick={handleRunOcr}
                className="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors hover:opacity-90"
                style={{ backgroundColor: 'var(--warn)', color: '#fff' }}
              >
                <Zap className="h-3 w-3" />
                {totalPages > 0 ? `OCR ${totalPages} pages` : 'Start OCR'}
              </button>
              <button
                onClick={() => setScanBannerDismissed(true)}
                className="shrink-0 rounded p-1 transition-colors hover:bg-[color-mix(in_oklab,var(--ink)_10%,transparent)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {/* 主体：PDF 页面区（左）+ 检索侧栏（右） */}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {/* PDF 页面区：所有页面按序纵向堆叠，连续滚动（每页懒渲染 canvas + 批注层） */}
        <div ref={containerRef} onScroll={handleScroll} className="flex-1 min-w-0 overflow-auto ai-canvas-scroll"
          style={{ backgroundColor: 'var(--paper-soft)' }}>
          <div className="flex flex-col items-center gap-4 p-4">
            {pdfDoc &&
              Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <PdfPageView
                  key={p}
                  pageNo={p}
                  doc={pdfDoc}
                  scale={scale}
                  annotations={annotations}
                  mode={mode}
                  selectedId={selectedId}
                  editingId={editingId}
                  fontSizePref={fontSizePref}
                  searchRects={pageHitRects.get(p) ?? []}
                  textLayer={textLayerByPage.get(p) ?? []}
                  onAdd={addAnnotation}
                  onUpdate={updateAnnotation}
                  onSelect={setSelectedId}
                  onStartEdit={handleStartEdit}
                  onCommitEdit={handleCommitEdit}
                  onCancelEdit={handleCancelEdit}
                  registerRef={registerPageEl}
                />
              ))}
          </div>
        </div>

        {/* 页面缩略图侧栏：点击跳页、当前页高亮、自动跟随滚动 */}
        {thumbsOpen && (
          <aside className="flex w-36 shrink-0 flex-col border-r" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)' }}>
            <div className="flex shrink-0 items-center justify-between px-2.5 py-1.5 text-11 font-medium"
              style={{ color: 'var(--ink-muted)', borderBottom: '1px solid var(--line-soft)' }}>
              <span>Pages</span>
              <button
                onClick={() => setThumbsOpen(false)}
                className="rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Close thumbnails"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div ref={thumbListRef} className="ai-canvas-scroll min-h-0 flex-1 overflow-y-auto p-2">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
                const active = p === pageNum;
                return (
                  <button
                    key={p}
                    data-page={p}
                    onClick={() => scrollToPage(p)}
                    className="mb-1.5 block w-full overflow-hidden rounded-md p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                    style={{
                      border: active ? '1.5px solid var(--info)' : '1px solid var(--line)',
                      backgroundColor: active ? 'color-mix(in oklab, var(--info) 8%, transparent)' : 'transparent',
                    }}
                    title={`Go to page ${p}`}
                  >
                    {thumbUrls[p] ? (
                      <img src={thumbUrls[p]} alt={`Page ${p}`} className="block w-full" draggable={false} />
                    ) : (
                      <div className="flex h-28 w-full items-center justify-center text-10"
                        style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-faint)' }}>
                        P{p}
                      </div>
                    )}
                    <span className="block text-center text-10" style={{ color: active ? 'var(--info)' : 'var(--ink-muted)' }}>
                      {p}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        {/* 检索侧栏：关键词输入、命中列表、上下条导航 */}
        {searchOpen && (
          <aside className="flex w-72 shrink-0 flex-col border-l"
            style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)' }}>
            {/* 关键词输入行 */}
            <div className="flex items-center gap-2 px-3 py-2 shrink-0"
              style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
              <input
                autoFocus
                value={query}
                onChange={(e) => { setQuery(e.target.value); runSearch(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    jumpToOffset(e.shiftKey ? -1 : 1);
                  }
                }}
                placeholder={isScanned ? 'Run OCR before searching scans' : 'Search the full text'}
                className="min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none transition-colors focus:border-[var(--info)]"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink)' }}
              />
              <button
                onClick={() => setSearchOpen(false)}
                className="rounded-md p-1 transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Close search (Esc)"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* 状态 / 上下条导航 */}
            <div className="flex items-center gap-1 px-3 py-1.5 text-xs shrink-0" style={{ color: 'var(--ink-muted)' }}>
              <span className="flex-1 truncate">{searchStatus}</span>
              <button
                onClick={() => jumpToOffset(-1)}
                disabled={hits.length === 0}
                className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-30"
                style={{ color: 'var(--ink)' }}
                title="Previous match (Shift+Enter)"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => jumpToOffset(1)}
                disabled={hits.length === 0}
                className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-30"
                style={{ color: 'var(--ink)' }}
                title="Next match (Enter)"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* 扫描件 OCR 引导 / 结果提示 */}
            {(ocrMsg || scanNeedsOcr || noHitNeedsOcr) && (
              <div className="px-3 pb-1.5 text-11 leading-relaxed">
                {ocrMsg && (
                  <p style={{
                    color: /fail|no text/i.test(ocrMsg) ? 'var(--danger)' : 'var(--success)',
                  }}>
                    {ocrMsg}
                  </p>
                )}
                {(scanNeedsOcr || noHitNeedsOcr) && (
                  <button
                    onClick={handleRunOcr}
                    disabled={ocrRunning}
                    className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
                    style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}
                  >
                    {ocrRunning
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Zap className="h-3.5 w-3.5" style={{ color: 'var(--warn)' }} />}
                    {ocrRunning ? 'Running BOB OCR…' : scanNeedsOcr ? 'Run BOB OCR to enable search' : 'No matches? Run BOB OCR, then search again'}
                  </button>
                )}
              </div>
            )}

            {/* 命中列表（点击跳转锁定位置；当前项高亮；hover 展示长上下文） */}
            <div className="min-h-0 flex-1 overflow-y-auto ai-canvas-scroll px-2 py-1" onScrollCapture={schedulePreviewClose}>
              {hits.map((h, i) => {
                const active = i === cursor;
                return (
                  <button
                    key={`${h.page}-${h.matchPos}-${i}`}
                    onClick={() => { setCursor(i); setPreview(null); }}
                    onMouseEnter={(e) => openPreview(h, e.currentTarget)}
                    onMouseLeave={schedulePreviewClose}
                    onFocus={(e) => openPreview(h, e.currentTarget)}
                    onBlur={schedulePreviewClose}
                    className="mb-1 block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                    style={{
                      backgroundColor: active ? 'color-mix(in oklab, var(--info) 12%, transparent)' : 'transparent',
                      outline: active ? '1px solid var(--info)' : 'none',
                    }}
                  >
                    <span className="mr-1.5 inline-block rounded px-1 align-middle text-10 font-medium"
                      style={{ backgroundColor: 'var(--paper-soft)', color: active ? 'var(--info)' : 'var(--ink-muted)' }}>
                      P{h.page}
                    </span>
                    <span className="align-middle text-xs leading-snug break-all" style={{ color: 'var(--ink)' }}>
                      {h.context}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* hover 长上下文预览浮层（portal 渲染到 body） */}
            {createPortal(
              preview
                ? <HitContextPreview data={preview} keepAlive={cancelPreviewClose} dismiss={schedulePreviewClose} />
                : null,
              document.body,
            )}
          </aside>
        )}

        {/* 批注列表侧栏：一览全文档高亮/文字框，点击跳转到所在页并选中该条 */}
        {annotsOpen && filePath && (
          <aside className="flex w-64 shrink-0 flex-col border-l"
            style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)' }}>
            <div className="flex shrink-0 items-center justify-between px-2.5 py-1.5 text-11 font-medium"
              style={{ color: 'var(--ink-muted)', borderBottom: '1px solid var(--line-soft)' }}>
              <span>Annotations · {annotations.length}</span>
              <button
                onClick={() => setAnnotsOpen(false)}
                className="rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Close annotations"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="ai-canvas-scroll min-h-0 flex-1 overflow-y-auto px-2 py-1">
              {sortedAnns.length === 0 ? (
                <p className="px-1 py-3 text-11 leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                  No annotations yet. Highlight or add a note, then click an entry here to jump back to it.
                </p>
              ) : (
                sortedAnns.map((a) => {
                  const active = a.id === selectedId;
                  const isText = a.type === 'textbox';
                  const label = isText ? (a.text?.trim() || 'Empty text note') : 'Highlight';
                  return (
                    <button
                      key={a.id}
                      onClick={() => { scrollToPage(a.page); setSelectedId(a.id); }}
                      className="mb-1 flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                      style={{
                        backgroundColor: active ? 'color-mix(in oklab, var(--info) 12%, transparent)' : 'transparent',
                        outline: active ? '1px solid var(--info)' : 'none',
                      }}
                      title={`Go to page ${a.page}`}
                    >
                      <span className="mt-0.5 inline-block shrink-0 rounded px-1 text-10 font-medium tabular-nums"
                        style={{ backgroundColor: 'var(--paper-soft)', color: active ? 'var(--info)' : 'var(--ink-muted)' }}>
                        P{a.page}
                      </span>
                      <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border"
                        style={{ backgroundColor: a.color, borderColor: 'var(--line)' }} />
                      <span className="min-w-0 flex-1 text-xs leading-snug break-words"
                        style={{ color: isText && a.text?.trim() ? 'var(--ink)' : 'var(--ink-muted)' }}>
                        {label}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>
        )}

        {/* OCR 完成浮层（结果感知）：识别页数 / 耗时 / 升级页数，引导检索与文本层 */}
        {ocrResultShown && ocrState.meta && (
          <div
            className="absolute bottom-4 right-4 z-20 flex items-start gap-3 rounded-xl border p-3.5 text-xs shadow-xl"
            style={{ maxWidth: 380, borderColor: 'var(--line)', backgroundColor: 'var(--popover)' }}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: 'color-mix(in oklab, var(--success) 15%, transparent)' }}>
              <Check className="h-4 w-4" style={{ color: 'var(--success)' }} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>OCR complete</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: 'var(--ink-muted)' }}>
                <span className="tabular-nums">{ocrState.meta.pageCount} pages</span>
                {ocrState.meta.upgradedCount > 0 && <span>{ocrState.meta.upgradedCount} pages upgraded to the vision model</span>}
                <span className="tabular-nums">{(ocrState.meta.elapsedMs / 1000).toFixed(1)}s</span>
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                <button
                  onClick={() => { setShowTextLayer(true); setOcrResultShown(false); }}
                  className="font-medium underline-offset-2 hover:underline"
                  style={{ color: 'var(--primary)' }}
                >
                  Show recognized text
                </button>
                <span style={{ color: 'var(--ink-faint)' }}>Full-text search is now available (Ctrl/Cmd+Shift+F)</span>
              </div>
            </div>
            <button
              onClick={() => setOcrResultShown(false)}
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 侧栏命中的长上下文预览卡：定位到条目左侧画布上方，越界自动收敛（仅客户端 hover 后挂载） */
function HitContextPreview({ data, keepAlive, dismiss }: {
  data: { hit: SearchHit; anchor: DOMRect };
  keepAlive: () => void;
  dismiss: () => void;
}) {
  const { hit, anchor } = data;
  const W = 340;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 侧栏右停靠 → 浮层向左展开；左右两端都夹在视口内，垂直跟随条目并预留视口下缘
  const left = Math.max(8, Math.min(anchor.left - W - 10, vw - W - 8));
  const top = Math.max(8, Math.min(anchor.top - 44, vh - 260));
  const ex = hit.excerpt;
  const markOk = !!ex && ex.matchStart >= 0 && ex.matchEnd > ex.matchStart && ex.matchEnd <= ex.text.length;
  return (
    <div
      role="tooltip"
      onMouseEnter={keepAlive}
      onMouseLeave={dismiss}
      className="fixed select-none rounded-lg border ai-canvas-scroll"
      style={{
        left,
        top,
        width: W,
        maxHeight: Math.max(140, vh - top - 12),
        overflowY: 'auto',
        zIndex: 80,
        padding: '12px',
        borderColor: 'var(--line)',
        backgroundColor: 'var(--card)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          className="rounded px-1 text-10 font-medium"
          style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--info)' }}
        >
          P{hit.page}
        </span>
        <span className="text-10" style={{ color: 'var(--ink-muted)' }}>Context preview</span>
      </div>
      <p className="break-all text-xs leading-relaxed" style={{ color: 'var(--ink)' }}>
        {markOk && ex ? (
          <>
            {ex.text.slice(0, ex.matchStart)}
            <mark
              className="rounded-sm px-0.5"
              style={{
                backgroundColor: 'color-mix(in oklab, var(--warn) 32%, transparent)',
                color: 'var(--ink)',
              }}
            >
              {ex.text.slice(ex.matchStart, ex.matchEnd)}
            </mark>
            {ex.text.slice(ex.matchEnd)}
          </>
        ) : (
          hit.context
        )}
      </p>
      <p className="mt-1.5 text-10" style={{ color: 'var(--ink-muted)' }}>Click a result to jump to it on the page</p>
    </div>
  );
}
