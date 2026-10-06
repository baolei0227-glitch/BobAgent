'use client';

/**
 * docx 真编辑内核（S1 ② 阶段 3 · Tiptap 编辑面）
 *
 * 职责：把 docx 字节 → `parseDocx` → `blocksToDoc`（适配器 A）→ Tiptap 编辑 →
 * `docToBlocks`（适配器 B）→ `buildSaveBlocks`（passthrough 路由）→ `saveDocx` →
 * 字节 → `POST /api/local-files` 写回原稿。
 *
 * 与宿主层（`app/docx-editor/DocxEditorClient.tsx`）的契约：
 *   接收同一份 `ViewerRenderProps`（proxyUrl / fileInfo / fileName / onError），
 *   沿用 docx 编辑器的 `file_proxy`（X-File-Mtime 哨兵）+ `save_to_original`
 *   （锁文件 / mtime 哨兵 / 会话首次备份）写回机制。宿主层与路由完全不动。
 *
 * 脏块追踪：以 `docxIndex` 为稳定锚（非顶层下标，因编辑会移位），每个事务把被触及块的
 *   docxIndex 并入脏集；保存时把脏集换算回 `newBlocks` 数组下标交给 `buildSaveBlocks`。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import type { ViewerRenderProps } from '@/components/canvas/viewers/types';
import type { ParsedDocFull } from '@/lib/docx-engine';
import { blocksToDoc } from '@/lib/docx-editor/blocks-to-tiptap';
import { docToBlocks } from '@/lib/docx-editor/tiptap-to-blocks';
import { touchedTopLevelIndices } from '@/lib/docx-editor/dirty-blocks';
import { DocDirtyTracker } from '@/lib/docx-editor/doc-dirty';
import { buildSaveBlocks } from '@/lib/docx-editor/save-blocks'
import { docxRenderDirty } from '@/lib/docx-editor/render-dirty';
import { redoDepth, undoDepth } from '@tiptap/pm/history';
import { docxExtensions } from './docx-tiptap-extensions';
import { DocxPagination, docxPaginationKey, paginationBreaksRef, setPaginationBreaks, measurePageBreaks, DEFAULT_GEOMETRY, docxPaperCss, geometryFromSection, pageFooterTopAt, pageGeometry, paperBoxStyle, setPageGeometry, type PageGeometry } from './docx-pagination';import { DocxSearch, searchKey, DOCX_SEARCH_NAV_META } from './docx-search';
import { desktop, isDesktop } from '@/lib/desktop-adapter';
import { bus, BusEvents } from '@/lib/bus';
import { convertDocxToMarkdown } from '@/lib/docx-to-md';
import {
  ChevronDown,
  ChevronUp,
  Info,
  Maximize2,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Plus,
  Ruler,
  Redo2,
  Save,
  Search,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  commandsOfGroup,
  commandsOfToolSection,
  type DocxCmdApi,
  type DocxCommand,
  type DocxGroup,
  type DocxToolSection,
} from './docx-commands';

/** Uint8Array → base64（写回原稿用，content 为不含 data: 前缀的 base64） */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** 修订稿文件名（homework 兜底通道：每次会话首次写回前备份一次，避免覆盖原稿） */
function makeRevisedName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '.docx';
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${base}-修订${stamp}${ext}`;
}

/* ---------------- AI 修订 / Track Changes / 接受拒绝 相关类型 ---------------- */

type ViewMode = 'markup' | 'all' | 'none' | 'original';

/** 单条修订（后端 /api/docx/revise inspect/apply/resolve 返回） */
interface RevisionItem {
  id: string;
  kind: string; // insert | delete | insert-mark | delete-mark
  text: string;
  author?: string;
  date?: string;
}

/** 后端 /api/docx/revise 响应 */
interface ReviseResponse {
  ok: boolean;
  docxBase64?: string;
  ins?: number;
  del?: number;
  total?: number;
  revisions?: RevisionItem[];
  results?: Array<{ ok: boolean; label: string; error?: string }>;
  accepted?: number;
  rejected?: number;
  error?: string;
}

/** chatnode / audit-revise 提交的修订计划 op */
interface PlanOp {
  type: string;
  locate: Record<string, unknown>;
  new: string;
  label?: string;
}

interface PlanFile {
  version: number;
  ops: PlanOp[];
  trackChanges?: boolean;
  docxPath?: string;
}

/** 计划应用进度（顶部提示条） */
interface PlanProgress {
  version: number;
  total: number;
  done: number;
  failed: string[];
}

interface RevisionDecision {
  id: string;
  accept: boolean;
}

/** 编辑器内选中文字浮层坐标（viewport 固定定位） */
interface AiSel {
  quote: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

export function DocxTiptapEditor({ proxyUrl, fileInfo, fileName, onError }: ViewerRenderProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [converting, setConverting] = useState(false);

  // ---- 页眉页脚编辑状态 ----
  const [hfEdit, setHfEdit] = useState(false);
  const [headerText, setHeaderText] = useState('');
  const [footerText, setFooterText] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- 标尺（水平 + 垂直同一开关）：面板里默认收起，把垂直空间让给正文 ----
  const [showRuler, setShowRuler] = useState(false);

  // ---- ⋯ 溢出菜单（面板模式下次要命令的唯一入口） ----
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    /** 点击菜单外部即收起（菜单内点击不触发，因为 target 在 menuRef 内） */
    const onDocDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [menuOpen]);

  // ---- 面板宽度观测：驱动工具条自适应折叠 + 自动适配缩放 ----
  // 用 callback ref 而不是 useRef + useEffect([])：根节点在 loading 结束前不存在，
  // 空依赖的 effect 只跑一次会拿到 null，之后永远不再观测（自动适配会静默失效）。
  const [panelW, setPanelW] = useState(0);
  const [autoFit, setAutoFit] = useState(true);
  const roRef = useRef<ResizeObserver | null>(null);
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    setPanelW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number' && w > 0) setPanelW(w);
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  // ---- 根字号（rem 基准）观测 ----
  // 工具条宽度按 rem 换算（w-6 / gap-1 / px-2 全是 rem），而本项目的 html 字号 = --fs-md
  // 会随「字号档位」在 15/17/19px 间切换 ⇒ 档位一变，同一块工具条的实际宽度就变了。
  // 不观测就会出现「切到大字号后按钮被 overflow-hidden 剪掉」这种只在特定档位出现的故障。
  const [remPx, setRemPx] = useState(16);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => {
      const v = parseFloat(getComputedStyle(el).fontSize);
      if (Number.isFinite(v) && v > 0) setRemPx(v);
    };
    read();
    // 档位走 :root[data-fontscale] 属性切换，font-size 变化未必触发 ResizeObserver，用 MutationObserver 兜住
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ['style', 'data-fontscale'] });
    return () => mo.disconnect();
  }, []);

  // ---- 视觉分页 / 缩放 / 状态栏（S1 · Word chrome） ----
  const [zoom, setZoom] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  /**
   * 当前**节几何**（P4）：纸宽 / 纸高 / 边距 / 灰缝 / 页脚距。
   * 渲染侧的唯一真源；模块级的 `pageGeometry()` 供纯函数 `measurePageBreaks` 读取，
   * 两者由 `applyParsed` 在同一处写入（React 靠这份 state 重渲染）。
   */
  const [geom, setGeom] = useState<PageGeometry>(DEFAULT_GEOMETRY);
  const [paperHeightPx, setPaperHeightPx] = useState(DEFAULT_GEOMETRY.h);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const scalerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pageTopsRef = useRef<number[]>([DEFAULT_GEOMETRY.marginY]);
  const measureRafRef = useRef<number | null>(null);
  // 「布局未就绪 → 延时重测」的重试定时器与计数：
  // 测量若早于布局完成，块高会全部读成 0 ⇒ breaks 为空 ⇒ 页数被钉死在 1，
  // 而状态量默认就是 pageCount=1 / paperHeightPx=PAGE_H，界面上完全看不出测量失败。
  const measureRetryRef = useRef<number | null>(null);
  const measureTriesRef = useRef(0);
  // 自递归入口（measurePagination 内部重试时不能直接引用自身，否则触发 exhaustive-deps 告警）
  const measurePaginationRef = useRef<() => boolean>(() => true);
  // applyParsed（定义在 scheduleMeasure 之前）需要「装入后立即重测」，用 ref 打通
  const scheduleMeasureRef = useRef<() => void>(() => {});
  // 装入后的多趟重测定时器（下次装入 / 卸载时清理）
  const loadMeasureTimersRef = useRef<number[]>([]);

  // ---- 查找 / 替换（⌘F） ----
  const [findOpen, setFindOpen] = useState(false);
  const [searchTerm, setSearchTermState] = useState('');
  const [replaceTerm, setReplaceTerm] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [matchIndex, setMatchIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;

  const parsedRef = useRef<ParsedDocFull | null>(null);
  const originalMtimeRef = useRef<number | null>(null);
  const wroteOriginalRef = useRef(false);
  const dirtyTracker = useRef<DocDirtyTracker | null>(null);
  if (!dirtyTracker.current) dirtyTracker.current = new DocDirtyTracker();
  const loadingRef = useRef(true);

  // ---- 修订（AI 修订 / Track Changes / 接受拒绝）状态 ----
  const [revisions, setRevisions] = useState<RevisionItem[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [revising, setRevising] = useState(false);
  const [trackMode, setTrackMode] = useState(true);
  const [hideRev, setHideRev] = useState(false);
  const [planProgress, setPlanProgress] = useState<PlanProgress | null>(null);
  const [aiSel, setAiSel] = useState<AiSel | null>(null);
  const [aiInstruction, setAiInstruction] = useState('');
  const [reportList, setReportList] = useState<Array<{ name: string; path: string; mtime: number }>>([]);
  const [reportPickerOpen, setReportPickerOpen] = useState(false);

  /** 撤销 / 重做可用性（undoDepth / redoDepth 是纯读，避免 can() 在每事务上跑命令） */
  const [hist, setHist] = useState({ undo: false, redo: false });

  const revisionsRef = useRef<RevisionItem[]>([]);
  const loadedBytesRef = useRef<Uint8Array | null>(null);
  const mdTextRef = useRef<string>('');
  const applyingPlanRef = useRef(false);

  useEffect(() => { revisionsRef.current = revisions; }, [revisions]);

  const editor = useEditor({
    extensions: [...docxExtensions, DocxPagination, DocxSearch],
    content: '',
    editable: true,
    onTransaction: ({ transaction }) => {
      if (transaction.getMeta(docxPaginationKey)) return; // 分页装饰重算，不计脏
      if (transaction.getMeta(DOCX_SEARCH_NAV_META)) return; // 查找导航（选中/高亮），不计脏
      if (loadingRef.current) return; // 加载期的 setContent 不计入脏
      const tracker = dirtyTracker.current!;
      const touched = touchedTopLevelIndices(transaction);
      if (!touched) {
        // 未知 step → 全量保守：标记所有原始块为脏
        const parsed = parsedRef.current;
        if (parsed) tracker.markAll(parsed.blocks);
        setDirty(true);
        return;
      }
      transaction.doc.forEach((node, _offset, index) => {
        if (touched.has(index)) tracker.markTouched((node.attrs.docxIndex as number | null) ?? null);
      });
      setDirty(true);
    },
  });

  // 历史栈深度变化 → 同步按钮可用性。值不变时 setState 传回同一对象，React 直接 bail out，
  // 因此打字过程中不会为这两个按钮额外触发重渲染。
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const next = { undo: undoDepth(editor.state) > 0, redo: redoDepth(editor.state) > 0 };
      setHist((prev) => (prev.undo === next.undo && prev.redo === next.redo ? prev : next));
    };
    sync();
    editor.on('transaction', sync);
    return () => {
      editor.off('transaction', sync);
    };
  }, [editor]);

  // ---- 修订相关底层 helper（在 load 之前定义，供加载与修订流程复用） ----
  /** base64 → Uint8Array（与 uint8ToBase64 互逆） */
  const base64ToUint8 = useCallback((b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }, []);

  /** 把 docx 字节解析为 ParsedDocFull（懒加载引擎） */
  const parseBytes = useCallback(async (bytes: Uint8Array): Promise<ParsedDocFull> => {
    const engine = await import('@/lib/docx-engine');
    return engine.parseDocx(bytes);
  }, []);

  /** 重新载入当前文档的修订清单（inspect 模式） */
  const inspectFromBytes = useCallback(async (bytes: Uint8Array) => {
    try {
      const resp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'inspect', docxBase64: uint8ToBase64(bytes) }),
      });
      const data = (await resp.json()) as ReviseResponse;
      if (data.ok && data.revisions) {
        setRevisions(data.revisions);
        revisionsRef.current = data.revisions;
      }
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * 把一份已解析文档装入编辑器（加载 / 修订重解析共用）。
   * 重置脏追踪、修订清单，并重新拉取修订清单（若文档已含 w:ins/w:del）。
   */
  const applyParsed = useCallback(async (parsed: ParsedDocFull) => {
    parsedRef.current = parsed;
    dirtyTracker.current!.clear();
    setDirty(false);
    setSavedNote(null);
    setHeaderText(parsed.headerText ?? '');
    setFooterText(parsed.footerText ?? '');
    setHfEdit(false);
    setRevisions([]);
    revisionsRef.current = [];

    // ── 节几何（P4）：页面尺寸 / 边距 / 页脚距从文档自己的 `w:sectPr` 取 ──
    // ⚠️ 只有文档**确实声明了 sectPr** 时才切换几何；读不到就**复位**为 A4 默认。
    //    不能拿引擎的 `DEFAULT_SECTION` 兜底：它是 **US Letter**（12240×15840 twips），
    //    会让「无 sectPr 的文档」平白从 A4 变 Letter —— 这是视觉回归，不是修 bug。
    // 引擎走动态 import（见 parseBytes）：静态 import 会把整个引擎拖进组件 chunk。
    const { readSections } = await import('@/lib/docx-engine');
    const sec = readSections(parsed)[0]?.settings;
    const nextGeom = sec ? geometryFromSection(sec) : null;
    setPageGeometry(nextGeom);
    setGeom(nextGeom ? { ...DEFAULT_GEOMETRY, ...nextGeom } : DEFAULT_GEOMETRY);

    const pmDoc = blocksToDoc(parsed.blocks);
    const json = pmDoc.toJSON() as JSONContent;
    loadingRef.current = true;
    // setMeta('addToHistory', false) 与 setContent 同链 ⇒ 落在同一事务上，
    // 装载文档不进撤销栈（否则 ⌘Z 会把文档退回装载前的空文档）
    editor?.chain().setContent(json).setMeta('addToHistory', false).run();
    loadingRef.current = false;
    // 装入后**必须**重测分页：分页状态量（pageCount / paperHeightPx）默认停在 1 / PAGE_H，
    // 一旦漏测，多页文档就被渲染成一页高的白纸，正文直接溢出到画布灰上。
    // 多趟重测以覆盖字体 / 图片异步布局（首次测量可能早于最终布局）。
    for (const t of loadMeasureTimersRef.current) window.clearTimeout(t);
    scheduleMeasureRef.current();
    loadMeasureTimersRef.current = [80, 260, 700].map((delay) =>
      window.setTimeout(() => scheduleMeasureRef.current(), delay),
    );
    const bytes = loadedBytesRef.current;
    if (bytes) await inspectFromBytes(bytes);
  }, [editor]);

  // ---- 视觉分页测量（S1 · 离散 A4 页面，启发式换页） ----
  // 遍历顶层块 DOM 累加高度；当累计超过单页可用区（PAGE_USABLE_H）时记一处换页，
  // 并记录把上一页补足到满页所需的 padTop —— 装饰层据此把间隙拆成「白 → 灰缝 → 白」，
  // 使每一页都是等高的完整 A4（内容不足则页底留白），而不是只有第 1 页像纸。
  //
  // P1（2026-10-03）：块放不下时**优先在块内按行断页**（= Word 的段落跨页行为）——
  // 用 `view.coordsAtPos` 二分定位「哪一行是下页首行」，得到段内断点的文档位置。
  // 只有「剩余空间不足以留下 2 行」或「该块不是文本块（表格/图片/占位）」时才退化为整块下移。
  //
  // 测量算法本身已下沉为 `docx-pagination.ts` 的纯函数 `measurePageBreaks(view, opts)`；
  // 本函数只负责「就绪判定（未就绪则延时重测且**不写状态**）」与「把结果落盘 + 触发装饰重算」。
  const measurePagination = useCallback((): boolean => {
    // 视图 / 布局尚未就绪：**不写状态**，延时重测（有上限，不会无限重试）
    const notReady = (): boolean => {
      if (measureTriesRef.current < 8 && measureRetryRef.current == null) {
        measureTriesRef.current += 1;
        measureRetryRef.current = window.setTimeout(() => {
          measureRetryRef.current = null;
          measurePaginationRef.current();
        }, 120);
      }
      return false;
    };
    const ed = editor;
    // 纸面容器：`paperRef` 语义上指白纸卡片。⚠️ 守卫若挂在**从未 ref 挂载**的 ref 上，
    // 会「永远从这里返回 ⇒ 分页一次都没算过」，而 pageCount/paperHeightPx 又恰好停在
    // useState 初值（1 / PAGE_H），界面上完全看不出失效。故回落链兜住这种静默故障。
    const root = paperRef.current ?? scalerRef.current ?? canvasRef.current;
    if (!ed || !root) return notReady();
    const pm = root.querySelector('.ProseMirror') as HTMLElement | null;
    if (!pm) return notReady();
    const doc = ed.state.doc;
    // 顶层块取高：优先 `view.nodeDOM(offset)`（索引与 doc 天然对齐）；拿不到元素时回落到
    // `.ProseMirror` 的直接子元素，且**仅在数量一致时**启用（尾随 hack 节点会导致错位）。
    const domKids = Array.from(pm.children) as HTMLElement[];
    const alignable = domKids.length === doc.childCount;
    // 段内断点用 display:block 的行内插入，须把实测的额外撑高（随字号变）扣掉
    const fontSizePx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 15;

    const blockEls: Array<HTMLElement | null> = [];
    doc.forEach((_node, offset) => {
      const fromView = ed.view.nodeDOM(offset) as HTMLElement | null;
      const fallback: HTMLElement | null = alignable ? (domKids[blockEls.length] ?? null) : null;
      blockEls.push(fromView && fromView.nodeType === 1 ? fromView : fallback);
    });

    const res = measurePageBreaks(ed.view, { blockEls, fontSizePx });
    // 有内容却一个块高都没读到 ⇒ 布局未就绪。此时**绝不能**写入状态：breaks=[] 会让
    // pageCount 停在 1、paperHeightPx 停在 PAGE_H，多页文档就渲染成一页高的白纸，
    // 正文直接溢出到画布灰上（表现为「只有第一页是白的，其他页全是灰底」）。
    if (res.measuredTotal <= 0 && doc.childCount > 0) return notReady();
    const prev = paginationBreaksRef.current;
    const changed =
      prev.length !== res.breaks.length ||
      res.breaks.some(
        (b, i) =>
          prev[i]?.index !== b.index ||
          prev[i]?.manual !== b.manual ||
          prev[i]?.padTop !== b.padTop ||
          prev[i]?.inlinePos !== b.inlinePos,
      );
    if (changed) {
      setPaginationBreaks(res.breaks);
      // 触发 ProseMirror 装饰重算（decorations 读取 paginationBreaksRef.current）
      ed.view.dispatch(ed.state.tr.setMeta(docxPaginationKey, Date.now()));
    }
    pageTopsRef.current = res.pageTops;
    // 下限取当前纸高（而不是 A4 常量）：页脚距 / 纸高都可能被节属性改掉。
    // 这里读模块几何而不是闭包里的 `geom`，避免给 useCallback 增加依赖（几何在测量前已写好）。
    setPaperHeightPx(Math.max(pageGeometry().h, Math.round(res.paperHeightPx)));
    setPageCount(res.pages);
    measureTriesRef.current = 0;
    return true;
  }, [editor]);

  measurePaginationRef.current = measurePagination;

  const scheduleMeasure = useCallback(() => {
    if (measureRafRef.current != null) return;
    // 每次显式请求都重新给足重试预算（否则上一轮的失败计数会「烧掉」后续重试机会）
    measureTriesRef.current = 0;
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = null;
      measurePagination();
    });
  }, [measurePagination]);

  scheduleMeasureRef.current = scheduleMeasure;

  // 编辑内容变化 → 重新测量换页
  useEffect(() => {
    if (!editor) return;
    const run = () => scheduleMeasure();
    editor.on('update', run);
    return () => {
      editor.off('update', run);
    };
  }, [editor, scheduleMeasure]);

  // 首次装入 / 缩放变化 / 窗口尺寸变化 → 重新测量（多趟以覆盖图片/字体异步布局）
  useEffect(() => {
    const t1 = setTimeout(() => scheduleMeasure(), 80);
    const t2 = setTimeout(() => scheduleMeasure(), 600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [editor, scheduleMeasure]);

  useEffect(() => {
    scheduleMeasure();
  }, [zoom, scheduleMeasure]);

  useEffect(() => {
    const onResize = () => scheduleMeasure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [scheduleMeasure]);

  // 卸载时清理「布局未就绪重试」与「装入后多趟重测」的定时器
  useEffect(
    () => () => {
      if (measureRetryRef.current != null) window.clearTimeout(measureRetryRef.current);
      for (const t of loadMeasureTimersRef.current) window.clearTimeout(t);
      loadMeasureTimersRef.current = [];
    },
    [],
  );

  // 自动适配：面板宽度 / 标尺显隐变化时重算缩放；用户手改缩放或点放大缩小后停止自动适配
  useEffect(() => {
    if (!autoFit || panelW <= 0) return;
    const contentW = geom.w + (showRuler ? V_RULER_W : 0);
    const avail = panelW - 2 * PANEL_CANVAS_PAD;
    setZoom(Math.max(0.4, Math.min(1, Math.round((avail / contentW) * 100) / 100)));
  }, [autoFit, panelW, showRuler, geom]);

  // 缩放
  const zoomIn = useCallback(() => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 100) / 100)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 100) / 100)), []);

  // 滚动时更新当前页（基于每页起始内容偏移）
  const onCanvasScroll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const unscaledScroll = (canvas.scrollTop - CANVAS_PAD) / zoom;
    const tops = pageTopsRef.current;
    let cur = 1;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] <= unscaledScroll + 120 / zoom) cur = i + 1;
    }
    setCurrentPage(cur);
    setPageInput(String(cur));
  }, [zoom]);

  // 跳转到指定页
  const goToPage = useCallback(
    (n: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const idx = Math.max(1, Math.min(pageCount, n)) - 1;
      const top = pageTopsRef.current[idx] ?? 0;
      canvas.scrollTo({ top: CANVAS_PAD + top * zoom - 8, behavior: 'smooth' });
    },
    [pageCount, zoom],
  );

  // ---- 查找 / 替换（⌘F） ----
  const refreshSearchStatus = useCallback(() => {
    if (!editor) return;
    const s = searchKey.getState(editor.state);
    if (s) {
      setMatchCount(s.matches.length);
      setMatchIndex(s.active + 1);
    }
  }, [editor]);

  const applySearch = useCallback(() => {
    if (!editor) return;
    editor.commands.setSearchTerm(searchTerm, { matchCase, wholeWord });
    refreshSearchStatus();
  }, [editor, searchTerm, matchCase, wholeWord, refreshSearchStatus]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    setTimeout(() => findInputRef.current?.focus(), 30);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    editor?.commands.clearSearch();
    setMatchCount(0);
    setMatchIndex(0);
  }, [editor]);

  const handleFindNext = useCallback(() => {
    if (!editor) return;
    if (editor.commands.findNext()) {
      editor.commands.scrollIntoView();
      refreshSearchStatus();
    }
  }, [editor, refreshSearchStatus]);

  const handleFindPrev = useCallback(() => {
    if (!editor) return;
    if (editor.commands.findPrev()) {
      editor.commands.scrollIntoView();
      refreshSearchStatus();
    }
  }, [editor, refreshSearchStatus]);

  const handleReplace = useCallback(() => {
    if (!editor) return;
    if (editor.commands.replaceCurrent(replaceTerm)) refreshSearchStatus();
  }, [editor, replaceTerm, refreshSearchStatus]);

  const handleReplaceAll = useCallback(() => {
    if (!editor) return;
    if (editor.commands.replaceAll(replaceTerm)) refreshSearchStatus();
  }, [editor, replaceTerm, refreshSearchStatus]);

  // 查找条件变化 → 重算高亮与计数
  useEffect(() => {
    if (findOpen && editor) applySearch();
  }, [findOpen, applySearch, editor]);

  // 文档被编辑且查找面板打开时 → 刷新计数
  useEffect(() => {
    if (!editor) return;
    const run = () => {
      if (findOpenRef.current) refreshSearchStatus();
    };
    editor.on('update', run);
    return () => {
      editor.off('update', run);
    };
  }, [editor, refreshSearchStatus]);

  // 全局 ⌘F / Ctrl+F 唤起查找面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openFind();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openFind]);

  // 当前选区对齐 / 列表态：判据已随「对齐 / 列表还原为按钮」一并迁入命令表
  // （docx-commands.tsx 的 alignActive / liKindOf），宿主不再各存一份，避免两处漂移。
  const rfAttrs = editor?.getAttributes('runFormat');
  const rfFont = (rfAttrs?.font as string) || '';
  const rfSize = rfAttrs?.sizeHalfPoints as number | undefined;
  const rfColor = (rfAttrs?.color as string) || '';
  const wordCount = editor ? editor.getText().replace(/\s/g, '').length : 0;

  // 当前光标所在段落/标题的属性（驱动 段间距/缩进/分页符 控件显示）
  const curParaAttrs = (() => {
    if (!editor) return ({} as Record<string, unknown>);
    const { $from } = editor.state.selection;
    const node = $from.node($from.depth);
    if (node.type.name === 'paragraph' || node.type.name === 'heading') return node.attrs as Record<string, unknown>;
    return {};
  })();
  const twToPt = (v: unknown) => Math.round(((typeof v === 'number' ? v : 0) ?? 0) / 20);
  const curIndentLeftPt = twToPt(curParaAttrs.indentLeft);
  const curFirstLinePt = twToPt(curParaAttrs.indentFirstLine);
  const curSpaceBeforePt = twToPt(curParaAttrs.spaceBefore);
  const curSpaceAfterPt = twToPt(curParaAttrs.spaceAfter);
  const curPageBreak = Boolean(curParaAttrs.pageBreakBefore);
  const curLineSpacing = curParaAttrs.lineSpacing != null ? Number(curParaAttrs.lineSpacing) : null;

  /**
   * 标尺手柄拖拽提交：pt → twips（×20）写回段落属性。
   * 不调用 focus()：拖拽期间抢焦点会让画布跟着选区滚动；selection 未变，命令一样作用在当前段落上。
   */
  const handleRulerCommit = useCallback(
    (kind: 'first' | 'left', pt: number) => {
      editor
        ?.chain()
        .setParaFormat(kind === 'first' ? { indentFirstLine: pt * 20 } : { indentLeft: pt * 20 })
        .run();
    },
    [editor],
  );

  // ⚠️ onError 是父层传入的回调，而 `UnifiedViewer.tsx:677` 传的是**内联箭头函数**
  //    ⇒ 父组件每渲染一次就换一个新身份。一旦把它放进装载 effect 的依赖数组，父层的
  //    **任何一次重渲染**都会重跑装载：setLoading(true) → 整块面板（含标题栏/工具条）
  //    被换成一页「正在加载文档…」占位 ⇒ 观感就是「打开 docx 后整个面板反复闪烁」。
  //    故用 ref 固定最新回调，使其不参与依赖比较。
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // 打开文档：fetch proxyUrl → parseDocx → 适配为 PM 文档 → 装入编辑器
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!proxyUrl) return;
      setLoading(true);
      setError(null);
      try {
        const resp = await fetch(proxyUrl, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`加载失败（HTTP ${resp.status}）`);
        const mtimeHeader = resp.headers.get('X-File-Mtime');
        const buf = new Uint8Array(await resp.arrayBuffer());
        const engine = await import('@/lib/docx-engine');
        const parsed = await engine.parseDocx(buf);
        if (cancelled) return;

        loadedBytesRef.current = buf;
        try {
          const md = await convertDocxToMarkdown(buf.slice().buffer);
          mdTextRef.current = md;
        } catch {
          mdTextRef.current = '';
        }
        originalMtimeRef.current = mtimeHeader ? Number(mtimeHeader) : null;
        wroteOriginalRef.current = false;
        await applyParsed(parsed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Word 文档加载失败';
        if (!cancelled) {
          setError(msg);
          onErrorRef.current?.(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // 依赖只保留「真正改变要重新装载的输入」：文档地址 / 编辑器实例 / 装入实现。
    // onError 刻意排除（见上），否则父层每次重渲染都会引发一次整篇重装载。
    // editor 实例就绪后也会触发一次加载（首帧 editor 为 null）
  }, [proxyUrl, editor, applyParsed]);

  /**
   * 构造当前文档的 docx 字节（不走写回）。供「保存」与「一键转 MD」复用：
   * 把编辑器文档 → docToBlocks → 脏集换算下标 → buildSaveBlocks → saveDocx。
   * 无编辑器/未加载时返回 null。
   */
  const buildCurrentBytes = useCallback(async (): Promise<Uint8Array | null> => {
    const parsed = parsedRef.current;
    const ed = editor;
    if (!parsed || !ed) return null;
    const newBlocks = docToBlocks(ed.state.doc, parsed.blocks);
    const dirtyIndices = dirtyTracker.current!.toArrayIndexSet(newBlocks);
    const finalBlocks = buildSaveBlocks(newBlocks, dirtyIndices, docxRenderDirty);
    const engine = await import('@/lib/docx-engine');
    // 页眉/页脚只要与原文不同（即便已收起编辑面板），都视作需写回，避免只改页眉页脚却无法保存/被静默丢弃
    const hfChanged =
      hfEdit ||
      headerText !== (parsed?.headerText ?? '') ||
      footerText !== (parsed?.footerText ?? '');
    const options: Record<string, unknown> = {};
    if (hfChanged) {
      options.header = { text: headerText };
      options.footer = { text: footerText };
    }
    return engine.saveDocx(parsed, finalBlocks, options as never);
  }, [editor, hfEdit, headerText, footerText]);

  const handleSave = useCallback(async () => {
    const parsed = parsedRef.current;
    const ed = editor;
    if (!parsed || !ed || saving) return;
    setSaving(true);
    try {
      const bytes = await buildCurrentBytes();
      if (!bytes) return;
      const base64 = uint8ToBase64(bytes);

      const path = fileInfo.full_path;
      const expectedMtime = originalMtimeRef.current;
      const canWriteOriginal = Boolean(path) && expectedMtime !== null;

      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: canWriteOriginal ? 'save_to_original' : 'save_to_homework',
          path,
          filename: canWriteOriginal ? undefined : makeRevisedName(fileInfo.name || fileName || 'document.docx'),
          content: base64,
          expectedMtime,
          backup: !wroteOriginalRef.current,
          encoding: 'base64',
        }),
      });
      const data = (await resp.json()) as {
        success?: boolean;
        conflict?: 'locked' | 'modified';
        error?: string;
        mtime?: number;
      };
      if (!data.success) {
        const msg =
          data.conflict === 'locked'
            ? '检测到 Word/WPS 锁文件，原稿可能正被打开，本次未写回（改动仍保留在页面中）。请关闭后点「保存」重试。'
            : data.conflict === 'modified'
              ? '原稿在打开后已被外部程序修改，为防覆盖已拒绝写回。如需采用磁盘最新版，请重载恢复。'
              : data.error || '写回原稿失败';
        setError(msg);
        window.alert(msg);
        return;
      }
      wroteOriginalRef.current = true;
      dirtyTracker.current!.clear();
      setDirty(false);
      if (data.mtime != null) originalMtimeRef.current = data.mtime;
      setSavedNote(canWriteOriginal ? '已保存到原稿' : '已保存到修订稿');
      setError(null);
      window.dispatchEvent(new CustomEvent('local-files-changed'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '保存失败';
      setError(msg);
      onError?.(msg);
    } finally {
      setSaving(false);
    }
  }, [editor, saving, fileInfo, fileName, onError]);

  const handleReload = useCallback(() => {
    dirtyTracker.current!.clear();
    setDirty(false);
    setSavedNote(null);
    setAiSel(null);
    setPanelOpen(false);
    void (async () => {
      if (!proxyUrl) return;
      setLoading(true);
      try {
        const resp = await fetch(proxyUrl, { cache: 'no-store' });
        const mtimeHeader = resp.headers.get('X-File-Mtime');
        const buf = new Uint8Array(await resp.arrayBuffer());
        const engine = await import('@/lib/docx-engine');
        const parsed = await engine.parseDocx(buf);
        loadedBytesRef.current = buf;
        try {
          const md = await convertDocxToMarkdown(buf.slice().buffer);
          mdTextRef.current = md;
        } catch {
          mdTextRef.current = '';
        }
        originalMtimeRef.current = mtimeHeader ? Number(mtimeHeader) : null;
        wroteOriginalRef.current = false;
        await applyParsed(parsed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '重载失败';
        setError(msg);
        onError?.(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, [proxyUrl, editor, onError, applyParsed]);

  // ---- 外部打开：把当前字节落盘后复制临时副本，交系统程序打开 ----
  // 内置页（Hippo guest，无 window.api）下 isDesktop() 为 false，`desktop.openFile`
  // 会静默返回失败，这里直接降级提示，避免无意义的网络请求/崩溃（S1 ④ 降级点 1）。
  const handleOpenExternal = useCallback(async () => {
    const path = fileInfo.full_path;
    if (!path) {
      setError('当前环境无本地文件路径，无法使用「外部打开」');
      return;
    }
    if (!isDesktop()) {
      const msg = '当前为内置预览页，无系统打开能力；请在桌面客户端中打开此文档以使用「外部打开」。';
      setError(msg);
      window.alert(msg);
      return;
    }
    setLoading(true);
    try {
      // 有未保存改动先落盘，确保外部打开的是最新内容
      if (dirty && !saving) await handleSave();
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open_external_copy', path }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string; tempPath?: string; mtime?: number };
      if (!data.success || !data.tempPath) throw new Error(data.error || '打开失败');
      const opened = await desktop.openFile(data.tempPath);
      if (!opened?.success) throw new Error(opened?.error || '打开失败');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '外部打开失败';
      setError(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  }, [fileInfo.full_path, dirty, saving, handleSave, onError]);

  /**
   * 打印 / 导出 PDF（P4）。
   *
   * 与 MD 编辑器（`DocEditor.tsx:2294-2330` 的 `handlePrint`）的关键差异：docx **不克隆 DOM**。
   * 原因：纸面本身就是按「打印成品」排的 —— 页高 / 页边距 / 页脚纵坐标 / 页间灰缝都已在
   * 几何里定死，克隆一份出去反而要重建整套坐标。打印期只靠 CSS 把编辑态剥掉：
   *   · 隐藏 chrome（`.docx-print-hide`）、解除缩放与滚动约束（`.docx-print-*`）
   *   · spacer 高度减去灰缝（`--docx-h − --docx-page-gap`）⇒ 第 k 页不再整体下移 (k−1)·24
   *   · 纸面 `min-height` 归零 ⇒ 元素高度恰好是 `pages × 纸高`，不多出空白末页
   *   · `@page docx-page { margin: 0; size: 纸型 }` 与纸面同尺寸（见 `docxStyleSheet`）
   */
  const handlePrint = useCallback(async () => {
    // 打印前重测一次：确保 padTop / 页数是最新的（脏内容没重测会让页尾多出一张空白纸）
    measurePaginationRef.current();
    // 等两帧：装饰层（页间灰缝）落进 DOM 之后再呼出打印面板
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    const prevTitle = document.title;
    // 打印面板/「存储为 PDF」默认取 document.title 作文件名
    document.title = (fileName || fileInfo.name || 'document').replace(/\.docx$/i, '');
    try {
      const api = (window as unknown as { api?: { print?: () => Promise<{ success?: boolean; error?: string }> } }).api;
      if (api?.print) {
        const res = await api.print();
        if (res && res.success === false) {
          // 主进程打印面板失败（如 macOS OOP printing 异常）→ 兜底走 Chromium 原生打印
          alert(res.error || '打印失败');
          window.print();
        }
      } else {
        window.print();
      }
    } catch (e) {
      alert(`打印失败：${e instanceof Error ? e.message : String(e)}`);
      window.print();
    } finally {
      document.title = prevTitle;
    }
  }, [fileName, fileInfo.name]);

  // ---- 一键转 Markdown：把当前文档（含未保存改动）转成 .md 存入 homework，
  //      并发布 file.open 在 md 编辑器中打开 ----
  // 内置页下 `bus.publish(fileOpen)` 无订阅者，不会自动打开（S1 ④ 降级点 2）；
  // 但 .md 已落盘 homework，文件仍可在资源管理器/桌面客户端打开，属可接受的降级。
  const handleConvertToMd = useCallback(async () => {
    if (converting) return;
    const name = fileInfo.name || fileName || 'document.docx';
    setConverting(true);
    try {
      const bytes = await buildCurrentBytes();
      if (!bytes) throw new Error('无内容可转换');
      const md = await convertDocxToMarkdown(bytes.slice().buffer);
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const mdName = `${base}-转MD${stamp}.md`;
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_to_homework', filename: mdName, content: md, encoding: 'utf-8' }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string; path?: string };
      if (!data.success || !data.path) throw new Error(data.error || '转换失败');
      window.dispatchEvent(new CustomEvent('local-files-changed'));
      bus.publish(BusEvents.fileOpen, { source: 'local', path: data.path, name: mdName });
      setSavedNote('已生成 Markdown');
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '转换失败';
      setError(msg);
      onError?.(msg);
    } finally {
      setConverting(false);
    }
  }, [converting, fileInfo.name, fileName, buildCurrentBytes, onError]);

  // ---- Phase 3：插入与表格结构命令 ----
  const inTable = Boolean(
    editor?.isActive('docxTableCell') || editor?.isActive('docxTableRow') || editor?.isActive('docxTable'),
  )

  // 页眉/页脚是否相对原文有改动（驱动保存按钮可用态，避免只改页眉页脚却无法保存）
  const hfChanged =
    hfEdit ||
    headerText !== (parsedRef.current?.headerText ?? '') ||
    footerText !== (parsedRef.current?.footerText ?? '')

  const handleInsertTable = useCallback(() => {
    editor?.chain().focus().insertDocxTable(3, 2).run()
  }, [editor])

  const handleInsertImageClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleImageFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new Image()
      img.onload = () => {
        editor?.chain().focus().insertContent({
          type: 'docxImage',
          attrs: {
            docxIndex: null,
            imageDataUrl: dataUrl,
            imageWidthPx: img.width,
            imageHeightPx: img.height,
            imageAlign: 'left',
            label: file.name,
          },
        }).run()
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }, [editor])

  // ---- 修订：编辑器内选中文字浮层（mousedown/mouseup 驱动） ----
  const onEditorMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    const ed = editor;
    if (!ed) return;
    const dom = ed.view.dom as HTMLElement;
    if (!dom.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setAiSel({ quote: text, top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    setAiInstruction('');
    sel.removeAllRanges();
  }, [editor]);

  const onEditorMouseDown = useCallback(() => {
    setAiSel(null);
  }, []);

  // ---- 修订核心：落修订（del 选中文字 + ins 新文，走 /api/docx/revise apply） ----
  const applyRevise = useCallback(async (newText: string): Promise<boolean> => {
    if (!aiSel || aiBusy) return false;
    const clean = newText.trim();
    const isDelete = !clean;
    const pendingQuote = aiSel.quote;
    setAiBusy(true);
    try {
      const bytes = await buildCurrentBytes();
      if (!bytes) throw new Error('无内容可修订');
      const reviseResp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'apply',
          docxBase64: uint8ToBase64(bytes),
          author: 'BobWork',
          ops: [{
            type: trackMode ? 'replace_text' : 'replace_text_plain',
            label: isDelete ? (trackMode ? '纯删除' : '删除') : (trackMode ? 'AI 修订' : 'AI 修改（普通）'),
            locate: { anchor: pendingQuote, old: pendingQuote },
            new: clean,
          }],
        }),
      });
      const data = (await reviseResp.json()) as ReviseResponse;
      if (!data.ok || !data.docxBase64) throw new Error(data.error || '修订生成失败');
      const result = data.results?.[0];
      if (result && !result.ok) throw new Error(result.error || '修订定位失败');
      const newBytes = base64ToUint8(data.docxBase64);
      loadedBytesRef.current = newBytes;
      const parsed = await parseBytes(newBytes);
      await applyParsed(parsed);
      setDirty(true);
      setRevisions(data.revisions || []);
      revisionsRef.current = data.revisions || [];
      setPanelOpen(true);
      setAiSel(null);
      setAiInstruction('');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 修订失败');
      return false;
    } finally {
      setAiBusy(false);
    }
  }, [aiSel, aiBusy, trackMode, buildCurrentBytes, applyParsed, parseBytes]);

  // 按 Track Changes 开关映射 op 类型（修订 ↔ 直接改）
  const toPlainType = useCallback((type: string): string => {
    const map: Record<string, string> = {
      replace_text: 'replace_text_plain',
      replace_paragraph: 'replace_paragraph_plain',
      insert_paragraph_after: 'insert_paragraph_after_plain',
      replace_table_cell: 'replace_table_cell_plain',
    };
    return trackMode ? (map[type] ? type : type.replace(/_plain$/, '')) : (map[type] || type);
  }, [trackMode]);

  // 应用单条计划 op（复用 /api/docx/revise apply）
  const applyPlanOp = useCallback(async (op: PlanOp): Promise<boolean> => {
    const bytes = loadedBytesRef.current;
    if (!bytes) return false;
    try {
      const resp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'apply',
          docxBase64: uint8ToBase64(bytes),
          author: 'BobWork',
          ops: [{ ...op, type: toPlainType(op.type) }],
        }),
      });
      const data = (await resp.json()) as ReviseResponse;
      if (!data.ok || !data.docxBase64) throw new Error(data.error || 'apply failed');
      const result = data.results?.[0];
      if (result && !result.ok) throw new Error(result.error || '定位失败');
      const newBytes = base64ToUint8(data.docxBase64);
      loadedBytesRef.current = newBytes;
      setRevisions(data.revisions || []);
      revisionsRef.current = data.revisions || [];
      setDirty(true);
      return true;
    } catch {
      return false;
    }
  }, [toPlainType]);

  // 逐条应用整个计划（自动执行；每条应用后更新进度，末尾统一重解析进编辑器）
  const runPlan = useCallback(async (plan: PlanFile) => {
    if (applyingPlanRef.current) return;
    applyingPlanRef.current = true;
    setPlanProgress({ version: plan.version, total: plan.ops.length, done: 0, failed: [] });
    const failed: string[] = [];
    for (let i = 0; i < plan.ops.length; i++) {
      const op = plan.ops[i];
      const ok = await applyPlanOp(op);
      if (!ok) failed.push(op.label || `op #${i + 1}`);
      setPlanProgress((s) => (s ? { ...s, done: i + 1, failed } : s));
      await new Promise((r) => setTimeout(r, 600));
    }
    applyingPlanRef.current = false;
    const finalBytes = loadedBytesRef.current;
    if (finalBytes) {
      const parsed = await parseBytes(finalBytes);
      await applyParsed(parsed);
      setDirty(true);
    }
    setTimeout(() => setPlanProgress(null), 6000);
  }, [applyPlanOp, applyParsed, parseBytes]);

  // 拉取 homework 下的审核报告列表
  const fetchReports = useCallback(async () => {
    try {
      const resp = await fetch('/api/docx/audit-revise?action=reports');
      const data = await resp.json();
      const list = (data.reports || []) as Array<{ name: string; path: string; mtime: number }>;
      setReportList(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  // 选定审核报告 → 读文本 → AI 解析成 ops → 构造计划逐条应用
  const pickReport = useCallback(async (reportPath: string) => {
    if (applyingPlanRef.current || auditBusy) return;
    setAuditBusy(true);
    setPanelOpen(true);
    setPlanProgress({ version: 0, total: 0, done: 0, failed: [] });
    try {
      const rResp = await fetch(`/api/local-files?action=read_file&path=${encodeURIComponent(reportPath)}`);
      if (!rResp.ok) throw new Error('读取审核报告失败');
      const rData = await rResp.json();
      const reportText = String(rData.content ?? '');
      if (!reportText.trim()) throw new Error('审核报告为空');
      setPlanProgress((s) => (s ? { ...s, total: -1 } : s)); // -1 = 解析中
      const aResp = await fetch('/api/docx/audit-revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docText: mdTextRef.current || '', reportText, trackChanges: trackMode }),
      });
      const aData = await aResp.json();
      if (!aData.ok) throw new Error(aData.error || 'AI 解析审核报告失败');
      const ops = Array.isArray(aData.ops) ? aData.ops : [];
      if (ops.length === 0) throw new Error('AI 未生成任何修订操作');
      const plan = {
        docxPath: fileInfo.full_path,
        version: Date.now(),
        trackChanges: trackMode,
        createdAt: new Date().toISOString(),
        ops,
      } as PlanFile;
      setAuditBusy(false);
      await runPlan(plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlanProgress(null);
      setAuditBusy(false);
    } finally {
      setAuditBusy(false);
    }
  }, [auditBusy, trackMode, fileInfo.full_path, runPlan]);

  // 接受/拒绝修订（decisions 为空 + acceptAll → 全部）
  const resolveRevisions = useCallback(async (decisions: RevisionDecision[], acceptAll?: boolean) => {
    const bytes = loadedBytesRef.current;
    if (!bytes || revising) return;
    setRevising(true);
    try {
      let payload = decisions;
      if (acceptAll !== undefined) {
        payload = (revisionsRef.current.length ? revisionsRef.current : []).map((r) => ({ id: r.id, accept: acceptAll }));
      }
      const resp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'resolve', docxBase64: uint8ToBase64(bytes), decisions: payload }),
      });
      const data = (await resp.json()) as ReviseResponse;
      if (!data.ok || !data.docxBase64) throw new Error(data.error || '接受/拒绝失败');
      const newBytes = base64ToUint8(data.docxBase64);
      loadedBytesRef.current = newBytes;
      const parsed = await parseBytes(newBytes);
      await applyParsed(parsed);
      setRevisions(data.revisions || []);
      revisionsRef.current = data.revisions || [];
      setDirty(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '修订处理失败');
    } finally {
      setRevising(false);
    }
  }, [revising, applyParsed, parseBytes]);

  // 一键「接受全部修订并立即更新原稿」（复用 resolve + save_to_original 严格冲突防护）
  const handleAcceptAllToOriginal = useCallback(async () => {
    const bytes = loadedBytesRef.current;
    const path = fileInfo.full_path;
    if (!bytes || revising || saving) return;
    if (!path || originalMtimeRef.current === null) {
      setError('未获取到原稿路径或打开时刻，无法写回原稿');
      return;
    }
    if (revisionsRef.current.length === 0) {
      window.alert('当前没有待处理的修订。');
      return;
    }
    if (!window.confirm(`将接受全部 ${revisionsRef.current.length} 处修订，并立即更新原稿：\n${path}\n\n是否继续？`)) return;
    setRevising(true);
    try {
      const decisions = revisionsRef.current.map((r) => ({ id: r.id, accept: true }));
      const resp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'resolve', docxBase64: uint8ToBase64(bytes), decisions }),
      });
      const data = (await resp.json()) as ReviseResponse;
      if (!data.ok || !data.docxBase64) throw new Error(data.error || '接受修订失败');
      const wResp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_to_original',
          path,
          content: data.docxBase64,
          expectedMtime: originalMtimeRef.current,
          backup: !wroteOriginalRef.current,
        }),
      });
      const wData = (await wResp.json()) as {
        success?: boolean; conflict?: 'locked' | 'modified'; error?: string; path?: string; mtime?: number; backup?: string | null;
      };
      if (!wData.success) {
        if (wData.conflict === 'locked') {
          window.alert('检测到 Word/WPS 的锁文件，文档可能正被 Office 程序打开，本次未写回。\n\n请先在 WPS/Word 中关闭该文档，再回到这里重试。');
          return;
        }
        if (wData.conflict === 'modified') {
          const restore = window.confirm('原稿在打开后已被外部程序修改过，为防覆盖外部修改，本次未写回。\n\n「确定」= 放弃当前修订，重新加载磁盘上的最新原稿\n「取消」= 保留当前修订在页面中（不写入磁盘）');
          if (restore) void handleReload();
          return;
        }
        throw new Error(wData.error || '更新原稿失败');
      }
      const newBytes = base64ToUint8(data.docxBase64);
      loadedBytesRef.current = newBytes;
      const parsed = await parseBytes(newBytes);
      await applyParsed(parsed);
      setRevisions(data.revisions || []);
      revisionsRef.current = data.revisions || [];
      setDirty(false);
      wroteOriginalRef.current = true;
      if (wData.mtime != null) originalMtimeRef.current = wData.mtime;
      setSavedNote('已接受全部修订并更新原稿');
      window.dispatchEvent(new CustomEvent('local-files-changed'));
      if (wData.backup) window.alert(`原稿已更新，写回前备份：\n${wData.backup}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新原稿失败');
    } finally {
      setRevising(false);
    }
  }, [revising, saving, fileInfo.full_path, applyParsed, parseBytes, handleReload]);

  // 直接替换：输入框内容原样作为新文本落修订（不调 AI）
  const replaceDirect = useCallback(async () => {
    if (!aiSel || aiBusy) return;
    await applyRevise(aiInstruction);
  }, [aiSel, aiInstruction, aiBusy, applyRevise]);

  // 提交：直接替换/删除选区（整文档报告驱动走 pickReport，此处不挂载报告 chip）
  const submitInstruction = useCallback(async () => {
    await replaceDirect();
  }, [replaceDirect]);

  // 按钮 · AI 改写：AI 按指令生成文本 → 直接落修订
  const runAiDirect = useCallback(async () => {
    const instruction = aiInstruction.trim();
    if (!aiSel || !instruction || aiBusy) return;
    setAiBusy(true);
    try {
      const editResp = await fetch('/api/ai-edit/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md: mdTextRef.current || '', instruction, mode: 'inline', selection: { text: aiSel.quote } }),
      });
      const reader = editResp.body?.getReader();
      if (!reader) throw new Error('AI 编辑响应不可读');
      let text = '';
      const decoder = new TextDecoder();
      const doneRe = /event: done\ndata: ([^\n]+)/g;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const m of chunk.matchAll(doneRe)) {
          try {
            const parsed = JSON.parse(m[1]) as { text?: string };
            if (parsed.text) text = parsed.text;
          } catch { /* ignore */ }
        }
      }
      if (!text.trim()) throw new Error('AI 未返回改写结果');
      setAiBusy(false);
      await applyRevise(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 修改失败');
      setAiBusy(false);
    }
  }, [aiSel, aiInstruction, aiBusy, applyRevise]);

  // 只在「还没有任何内容」时整块替换成占位符（= 真正的首次打开）。
  // 一旦装入过一次（parsedRef 有值），后续任何 loading 过渡都保留面板结构 ——
  // 否则每触发一次重装，标题栏 / 工具条 / 画布就被一起换掉，观感正是「整个面板反复闪烁」。
  if (loading && !parsedRef.current) {
    return (
      <div style={centerStyle}>
        <div style={{ fontSize: 13, opacity: 0.7 }}>正在加载文档…</div>
      </div>
    );
  }

  if (error && !editor) {
    return (
      <div style={centerStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>文档打开失败</div>
        <div style={{ fontSize: 13, opacity: 0.72, maxWidth: 520, textAlign: 'center' }}>{error}</div>
      </div>
    );
  }

  /** 是否存在待写回的改动（正文脏块 或 页眉页脚改动） */
  const unsaved = dirty || hfChanged;
  /** 竖标尺宽度（隐藏时为 0，内容列随之收窄） */
  const rulerW = showRuler ? V_RULER_W : 0;
  /** 内容列宽度 = 标尺 / 白纸共用真值（缩放联动） */
  const contentWidth = (geom.w + rulerW) * zoom;
  /**
   * 工具条自适应折叠（Word 式优先级溢出）：
   * 按面板可用宽度贪心淘汰最不重要的槽位，装不下的整组下沉到 ⋯ 菜单（功能始终可达）。
   * 取代了此前的二元宽窄档（`panelW >= 700`）—— 那个阈值要么全给要么全收，
   * 在默认面板宽度上表现为「字体 / 样式的下拉忽然消失」，观感是功能被藏了。
   * 宽度按实测根字号换算（见 `toolMetrics`），故字号档位切换后不会剪掉按钮。
   */
  const toolM = toolMetrics(remPx);
  const toolbarPlan = panelW > 0 ? fitToolbar(panelW - toolM.padX - TOOLBAR_SLACK, toolM) : toolbarSlots(toolM);
  /** 某分区是否已被工具条收录（未收录则在 ⋯ 菜单里补位） */
  const inToolbar = (key: string) => toolbarPlan.some((s) => s.key === key);
  /** 工具条未收录的 primary 命令（按分区取，保持声明顺序） */
  const overflowCmds = (section: DocxToolSection) => (inToolbar(section) ? [] : commandsOfToolSection(section));
  /** 修订侧栏：够宽推开画布，否则浮层 */
  const revDocked = panelW >= REV_DOCK_MIN;
  /** 当前段落样式（正文 / 标题 1-3） */
  const styleValue = editor?.isActive('heading') ? `h${editor?.getAttributes('heading').level ?? 1}` : 'p';

  /* ================================================================
   * 工具条 / ⋯ 菜单渲染器（2026-10-01 去重 → 2026-10-02 自适应折叠）
   *
   * 单一真源：按钮命令一律取自 docx-commands.tsx 的 DOCX_COMMANDS，由 renderCmd 按
   *   tier 渲染成「工具条外观」或「菜单外观」——同一功能不再在两处各写一份 JSX。
   * 落点规则（结构上互斥，同屏绝不重复）：
   *   · tier='primary' → 候选常驻。由 TOOL_SECTIONS 按可用宽度贪心填充；
   *     装得下的在工具条，装不下的整组下沉到 ⋯ 菜单（overflowCmds 补位）。
   *   · tier='menu'    → 永不上工具条，只在 ⋯ 菜单里出现。
   * 下拉类控件（字体 / 字号 / 样式）同一时刻只渲染一份：inToolbar 命中则在工具条，否则在 ⋯。
   * ================================================================ */

  /** 命令执行所需的外部能力（宿主闭包），供 docx-commands.tsx 的 run / disabled 使用 */
  const cmdApi: DocxCmdApi = {
    loading,
    converting,
    hasPath: Boolean(fileInfo.full_path),
    hfEdit,
    pageBreakBefore: curPageBreak,
    insertTable: handleInsertTable,
    insertImage: handleInsertImageClick,
    clearFormat: () =>
      editor
        ?.chain()
        .focus()
        .unsetAllMarks()
        .setParaFormat({
          align: null,
          spaceBefore: null,
          spaceAfter: null,
          indentLeft: null,
          indentFirstLine: null,
          lineSpacing: null,
          pageBreakBefore: null,
        })
        .run(),
    toggleHfEdit: () => setHfEdit((v) => !v),
    openExternal: () => void handleOpenExternal(),
    convertMd: () => void handleConvertToMd(),
    reload: handleReload,
    printDoc: () => void handlePrint(),
  };

  /**
   * 唯一的命令按钮渲染器。
   * as='tool' → 工具条图标按钮（无文字）；as='menu' → ⋯ 菜单「图标 + 文字」按钮，点击后收起菜单。
   */
  const renderCmd = (cmd: DocxCommand, as: 'tool' | 'menu') => {
    const active = cmd.isActive?.(editor, cmdApi) ?? false;
    const disabled = cmd.disabled?.(cmdApi) ?? false;
    const fire = () => {
      cmd.run(editor, cmdApi);
      if (as === 'menu') setMenuOpen(false);
    };
    const inner = cmd.glyph ? (
      <span className={cn('text-12 leading-none', cmd.glyphClass)}>{cmd.glyph}</span>
    ) : (
      cmd.icon
    );
    if (as === 'tool') {
      return (
        <ToolBtn key={cmd.id} title={cmd.title} active={active} disabled={disabled} onClick={fire}>
          {inner}
        </ToolBtn>
      );
    }
    return (
      <MenuBtn key={cmd.id} wide title={cmd.title} active={active} disabled={disabled} onClick={fire}>
        {inner}
        {cmd.label ? <span>{cmd.label}</span> : null}
      </MenuBtn>
    );
  };

  /** 字体下拉（唯一实现：宽档进工具条，窄档下沉 ⋯ 菜单） */
  const renderFontSelect = (width = '104px') => (
    <PanelSelect
      key="sel-font"
      width={width}
      title="字体"
      value={FONT_OPTIONS.includes(rfFont) ? rfFont : FONT_OPTIONS[0]}
      onChange={(e) => editor?.chain().focus().setRunFormat({ font: e.target.value }).run()}
    >
      {FONT_OPTIONS.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </PanelSelect>
  );

  /** 字号下拉（唯一实现：宽档进工具条，窄档下沉 ⋯ 菜单） */
  const renderSizeSelect = (width = '58px') => (
    <PanelSelect
      key="sel-size"
      width={width}
      title="字号"
      value={rfSize ? Number(rfSize) / 2 : 12}
      onChange={(e) => editor?.chain().focus().setRunFormat({ sizeHalfPoints: Number(e.target.value) * 2 }).run()}
    >
      {FONT_SIZES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </PanelSelect>
  );

  /** 段落样式下拉（唯一实现：宽档进工具条，窄档下沉 ⋯ 菜单） */
  const renderStyleSelect = (width = '78px') => (
    <PanelSelect
      key="sel-style"
      width={width}
      title="段落样式"
      value={styleValue}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'p') editor?.chain().focus().setParagraph().run();
        else editor?.chain().focus().toggleHeading({ level: Number(v.slice(1)) }).run();
      }}
    >
      <option value="p">正文</option>
      <option value="h1">标题 1</option>
      <option value="h2">标题 2</option>
      <option value="h3">标题 3</option>
    </PanelSelect>
  );

  /* 对齐 / 列表已还原为独立按钮（2026-10-02）——
   * 原来的 renderAlignSelect / renderListSelect 两个下拉已删除：
   * 宽度核算显示 4 个对齐按钮 + 2 个列表按钮（160px）比两个下拉（164px）**更窄**，
   * 「合并以省空间」的前提不成立，反而牺牲了 Word 的所见即所得。
   * 两种渲染现在都由命令表的 renderCmd 承担，判据（alignActive / liKindOf）也随之下沉。 */

  /** 字体颜色（唯一实现，落在 ⋯ 菜单字体区；低频不上工具条） */
  const renderColorInput = () => (
    <label
      key="color"
      className="relative inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
      title="字体颜色"
    >
      <span
        className="text-12 font-semibold leading-none"
        style={{
          color: rfColor ? `#${rfColor}` : 'var(--ink)',
          boxShadow: `inset 0 -2px 0 0 ${rfColor ? `#${rfColor}` : 'var(--ink)'}`,
        }}
      >
        A
      </span>
      <input
        type="color"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        value={rfColor ? `#${rfColor}` : '#000000'}
        onChange={(e) =>
          editor?.chain().focus().setRunFormat({ color: e.target.value.replace('#', '').toUpperCase() }).run()
        }
      />
    </label>
  );

  /** 段落度量字段（缩进 / 段间距 / 行距）—— 低频，只住 ⋯ 菜单 */
  const renderParaFields = () => (
    <>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <ParaField label="左缩进 (pt)">
          <input
            className={NUM_INPUT_CLS}
            type="number"
            min={0}
            step={1}
            value={curIndentLeftPt || ''}
            onChange={(e) =>
              editor?.chain().focus().setParaFormat({ indentLeft: e.target.value === '' ? null : Number(e.target.value) * 20 }).run()
            }
          />
        </ParaField>
        <ParaField label="首行 (pt，负值悬挂)">
          <input
            className={NUM_INPUT_CLS}
            type="number"
            step={1}
            value={curFirstLinePt || ''}
            onChange={(e) =>
              editor?.chain().focus().setParaFormat({ indentFirstLine: e.target.value === '' ? null : Number(e.target.value) * 20 }).run()
            }
          />
        </ParaField>
        <ParaField label="段前 (pt)">
          <input
            className={NUM_INPUT_CLS}
            type="number"
            min={0}
            step={1}
            value={curSpaceBeforePt || ''}
            onChange={(e) =>
              editor?.chain().focus().setParaFormat({ spaceBefore: e.target.value === '' ? null : Number(e.target.value) * 20 }).run()
            }
          />
        </ParaField>
        <ParaField label="段后 (pt)">
          <input
            className={NUM_INPUT_CLS}
            type="number"
            min={0}
            step={1}
            value={curSpaceAfterPt || ''}
            onChange={(e) =>
              editor?.chain().focus().setParaFormat({ spaceAfter: e.target.value === '' ? null : Number(e.target.value) * 20 }).run()
            }
          />
        </ParaField>
      </div>
      <div className="mt-2">
        <ParaField label="行距">
          <PanelSelect
            full
            title="行距"
            value={curLineSpacing != null ? String(curLineSpacing) : ''}
            onChange={(e) =>
              editor?.chain().focus().setParaFormat({ lineSpacing: e.target.value === '' ? null : Number(e.target.value) }).run()
            }
          >
            <option value="">默认</option>
            <option value="1">单倍</option>
            <option value="1.15">1.15</option>
            <option value="1.5">1.5 倍</option>
            <option value="2">2 倍</option>
            <option value="2.5">2.5 倍</option>
            <option value="3">3 倍</option>
          </PanelSelect>
        </ParaField>
      </div>
    </>
  );

  /** ⋯ 菜单：把 menu 级命令按分区 + 行号拆成多行渲染 */
  const renderMenuRows = (group: DocxGroup) => {
    const cmds = commandsOfGroup(group);
    const rows = Array.from(new Set(cmds.map((c) => c.row ?? 1))).sort((a, b) => a - b);
    return rows.map((r) => (
      <MenuRow key={`${group}-${r}`}>{cmds.filter((c) => (c.row ?? 1) === r).map((c) => renderCmd(c, 'menu'))}</MenuRow>
    ));
  };

  /**
   * ⋯ 菜单里给「被工具条挤出的 primary 命令」补位。
   * 与 renderMenuRows 的区别：数据源按 toolSection 取，且工具条已收录该分区时返回 null ——
   * 这条互斥关系是「同屏不重复」的结构性保证。
   */
  const renderOverflowRow = (section: DocxToolSection) => {
    const cmds = overflowCmds(section);
    if (!cmds.length) return null;
    return <MenuRow key={`ov-${section}`}>{cmds.map((c) => renderCmd(c, 'menu'))}</MenuRow>;
  };

  return (
    <div ref={attachRoot} style={rootStyle} className={cn('docx-print-frame', hideRev && 'docx-hide-rev')}>
      {/* ============ 面板标题栏（32px）：身份 + 保存态 + 全局动作 ============ */}
      <div className="docx-print-hide flex shrink-0 items-center gap-1.5 border-b border-[var(--line-soft)] bg-white px-2" style={headerStyle}>
        <span
          className="grid h-4 w-4 shrink-0 place-items-center rounded text-9 font-bold"
          style={{ background: 'var(--brand-soft-strong)', color: 'var(--brand-strong)' }}
          aria-hidden
        >
          W
        </span>
        <span className="min-w-0 truncate text-12 font-semibold" title={fileInfo.full_path || fileName}>
          {fileName || fileInfo.name}
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-10 font-medium"
          style={
            unsaved
              ? { background: 'var(--warn-soft)', color: '#8a5a00' }
              : { background: 'var(--success-soft)', color: '#0f7a4d' }
          }
          title={unsaved ? '存在未写回磁盘的改动' : '已与磁盘同步'}
        >
          <i className="h-1 w-1 shrink-0 rounded-full bg-current" aria-hidden />
          {unsaved ? '未保存' : '已同步'}
        </span>
        {savedNote ? (
          <span className="min-w-0 truncate text-10" style={{ color: 'var(--success)' }} title={savedNote}>
            {savedNote}
          </span>
        ) : null}

        <div className="flex-1" />

        <Button
          variant="ghost"
          tone="neutral"
          size="icon-xs"
          title="撤销（⌘Z）"
          disabled={!hist.undo}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          tone="neutral"
          size="icon-xs"
          title="重做（⇧⌘Z）"
          disabled={!hist.redo}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" tone="neutral" size="icon-xs" title="查找 / 替换（⌘F）" onClick={openFind}>
          <Search className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant={panelOpen ? 'soft' : 'ghost'}
          tone={panelOpen ? 'brand' : 'neutral'}
          size="icon-xs"
          title={panelOpen ? '隐藏修订面板' : '显示修订面板'}
          onClick={() => setPanelOpen((v) => !v)}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant="solid"
          tone="brand"
          size="xs"
          className="ml-0.5"
          title="保存并写回原稿（⌘S）"
          disabled={saving || !unsaved}
          onClick={() => void handleSave()}
        >
          <Save className="h-3 w-3" />
          {saving ? '保存中' : '保存'}
        </Button>

        {/* ⋯ 溢出菜单：面板模式下所有次要命令的唯一入口 */}
        <div className="relative" ref={menuRef}>
          <Button
            variant={menuOpen ? 'soft' : 'ghost'}
            tone={menuOpen ? 'brand' : 'neutral'}
            size="icon-xs"
            title="更多命令"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
          {menuOpen ? (
            <div
              className="docx-pop absolute right-0 top-[26px] z-50 w-[268px] overflow-auto rounded-xl border border-[var(--line)] bg-white p-2"
              style={{ maxHeight: '68vh', boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.16))' }}
            >
              {/* 插入分区没有 menu 级命令（表格/图片已升为 primary），此处只做工具条溢出补位 */}
              {overflowCmds('insert').length ? (
                <MenuSection label="插入">{renderOverflowRow('insert')}</MenuSection>
              ) : null}

              <MenuSection label="字体">
                {/* 字体 / 字号下拉：工具条装不下时才下沉到这里（同一时刻只渲染一份） */}
                {inToolbar('font') && inToolbar('size') ? null : (
                  <MenuRow>
                    {inToolbar('font') ? null : renderFontSelect()}
                    {inToolbar('size') ? null : renderSizeSelect('58px')}
                  </MenuRow>
                )}
                {renderOverflowRow('script')}
                <MenuRow>{renderColorInput()}</MenuRow>
              </MenuSection>

              <MenuSection label="段落">
                {inToolbar('style') ? null : <MenuRow>{renderStyleSelect()}</MenuRow>}
                {renderOverflowRow('align')}
                {renderOverflowRow('list')}
                {renderParaFields()}
                {renderOverflowRow('paraIndent')}
                {renderOverflowRow('paraMisc')}
              </MenuSection>

              {inTable ? <MenuSection label="表格">{renderMenuRows('table')}</MenuSection> : null}

              <MenuSection label="剪贴板">{renderMenuRows('clipboard')}</MenuSection>

              <MenuSection label="视图">{renderMenuRows('view')}</MenuSection>

              <MenuSection label="文件">{renderMenuRows('file')}</MenuSection>

              <div className="mt-1 flex items-start gap-1.5 rounded-md px-1.5 py-1 text-10" style={{ color: 'var(--ink-faint)' }}>
                <Info className="mt-px h-3 w-3 shrink-0" />
                目录 / 脚注 / 题注 / 交叉引用尚未实现
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ============ 单行工具条（36px）：按可用宽度自适应，装不下的整组下沉 ⋯ 菜单 ============ */}
      <div
        className="docx-print-hide flex shrink-0 items-center gap-1 overflow-hidden border-b border-[var(--line-soft)] bg-white px-2"
        style={toolbarStyle}
      >
        {toolbarPlan.map((slot, i) => (
          <Fragment key={slot.key}>
            {i > 0 && slot.sepBefore ? <ToolSep /> : null}
            {slot.section
              ? commandsOfToolSection(slot.section).map((c) => renderCmd(c, 'tool'))
              : slot.widget === 'font'
                ? renderFontSelect(`${slot.width}px`)
                : slot.widget === 'size'
                  ? renderSizeSelect(`${slot.width}px`)
                  : renderStyleSelect(`${slot.width}px`)}
          </Fragment>
        ))}
      </div>

      {/* 查找 / 替换面板（⌘F） */}
      {findOpen ? (
        <div className="docx-print-hide" style={findBarStyle}>
          <input
            ref={findInputRef}
            style={findInputStyle}
            placeholder="查找"
            value={searchTerm}
            onChange={(e) => setSearchTermState(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) handleFindPrev();
                else handleFindNext();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFind();
              }
            }}
          />
          <label style={findOptStyle}>
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
            区分大小写
          </label>
          <Button variant="ghost" tone="neutral" size="icon-xs" title="上一个" onClick={handleFindPrev}>
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" tone="neutral" size="icon-xs" title="下一个" onClick={handleFindNext}>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <span style={findCountStyle}>{matchCount ? `${matchIndex}/${matchCount}` : '0/0'}</span>
          <span style={findSepStyle} />
          <input
            style={findInputStyle}
            placeholder="替换为"
            value={replaceTerm}
            onChange={(e) => setReplaceTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleReplace();
              }
            }}
          />
          <Button variant="outline" tone="neutral" size="xs" onClick={handleReplace}>
            替换
          </Button>
          <Button variant="outline" tone="neutral" size="xs" onClick={handleReplaceAll}>
            全部替换
          </Button>
          <Button variant="ghost" tone="neutral" size="icon-xs" title="关闭" onClick={closeFind}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}

      {/* ============ 编辑区（+ 修订侧栏：宽面板推开、窄面板浮层） ============ */}
      <div className="docx-print-area relative flex min-h-0 flex-1">
        <div
          style={canvasStyle}
          ref={canvasRef}
          onScroll={() => {
            setAiSel(null);
            onCanvasScroll();
          }}
        >
          <div className="docx-print-col" style={{ width: contentWidth, margin: '0 auto' }}>
            {hfEdit ? (
              <div className="docx-print-hide" style={{ marginLeft: rulerW, width: geom.w }}>
                <div style={hfPanelStyleOf(geom)}>
                  <div style={hfLabelStyle}>页眉</div>
                  <textarea
                    style={hfTextareaStyle}
                    value={headerText}
                    onChange={(e) => setHeaderText(e.target.value)}
                  />
                  <div style={hfLabelStyle}>页脚</div>
                  <textarea
                    style={hfTextareaStyle}
                    value={footerText}
                    onChange={(e) => setFooterText(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
            {showRuler ? (
              <div className="docx-print-hide" style={rulerStickyStyle}>
                <DocxRuler
                  zoom={zoom}
                  vrW={rulerW}
                  geom={geom}
                  firstLinePt={curFirstLinePt}
                  leftIndentPt={curIndentLeftPt}
                  onCommit={handleRulerCommit}
                />
              </div>
            ) : null}
            <div
              className="docx-paper-scaler"
              style={{ ...scalerStyle, width: contentWidth, height: paperHeightPx * zoom }}
              ref={scalerRef}
            >
              <div
                className="docx-paper-wrap"
                style={{
                  ...paperWrapperStyle,
                  transform: `scale(${zoom})`,
                  width: geom.w + rulerW,
                  height: paperHeightPx,
                }}
              >
                {showRuler ? <DocxVRuler height={paperHeightPx} geom={geom} /> : null}
                <div
                  className="docx-paper"
                  ref={paperRef}
                  style={{ ...pageStyleOf(geom), minHeight: paperHeightPx }}
                  onMouseUp={onEditorMouseUp}
                  onMouseDown={onEditorMouseDown}
                >
                  <EditorContent editor={editor} style={{ height: '100%' }} />
                  {/*
                    每页页脚（P4）：页码常住在这里，**不再画在页间灰缝里**。
                    灰缝方案的两个硬伤：① spacer 只在断点处生成 ⇒ 末页永远没有页码；
                    ② 页码单调性靠「闭包先取值 + widget key」维持，P1 就栽在这上面。
                    改由宿主按 `pageCount` 渲染后：序号 = `i + 1` 由构造保证单调，整类缺陷消失。
                    纵坐标走纯函数 `pageFooterTopAt`（可单测，不依赖靶场），绝对定位在纸内
                    ⇒ 不参与文档流、不进 `getJSON`，因此**不影响 docx 字节保真**。
                  */}
                  {Array.from({ length: pageCount }, (_, i) => (
                    <div
                      key={`foot-${i}`}
                      className="docx-page-footer"
                      style={{
                        top: pageFooterTopAt(i, DOCX_FOOTER_LINE_H, geom),
                        left: geom.marginX,
                        right: geom.marginX,
                        lineHeight: `${DOCX_FOOTER_LINE_H}px`,
                      }}
                    >
                      {footerLineText(i + 1, pageCount, footerText)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 修订面板：面板够宽就推开画布，太窄就浮层（320px 面板里推开会把纸挤成 0 宽） */}
        {panelOpen ? (
          <aside
            className="docx-slide docx-print-hide"
            style={revDocked ? revPanelDockedStyle : revPanelOverlayStyle}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={revPanelHeadStyle}>
              <span className="text-12 font-semibold">修订{revisions.length ? `（${revisions.length}）` : ''}</span>
              <Button variant="ghost" tone="neutral" size="icon-xs" title="关闭修订面板" onClick={() => setPanelOpen(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="shrink-0 border-b border-[var(--line-soft)] px-2.5 py-2">
              <label className="flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                <input type="checkbox" checked={trackMode} onChange={(e) => setTrackMode(e.target.checked)} />
                Track Changes（落修订标记）
              </label>
              <label className="mt-1 flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                <input type="checkbox" checked={hideRev} onChange={(e) => setHideRev(e.target.checked)} />
                隐藏修订标记（显示最终文本）
              </label>
              <Button
                variant="outline"
                tone="neutral"
                size="xs"
                className="mt-1.5 w-full"
                disabled={auditBusy}
                onClick={() => {
                  setReportPickerOpen((v) => {
                    const n = !v;
                    if (n && reportList.length === 0) void fetchReports();
                    return n;
                  });
                }}
              >
                {auditBusy ? '解析中…' : 'AI 整文档修订…'}
              </Button>
              {reportPickerOpen ? (
                <div style={revPickerStyle}>
                  {reportList.length === 0 ? (
                    <div className="p-2 text-11" style={{ color: 'var(--ink-faint)' }}>
                      无可用审核报告
                    </div>
                  ) : (
                    reportList.map((r) => (
                      <div
                        key={r.path}
                        style={revPickerItemStyle}
                        onClick={() => {
                          setReportPickerOpen(false);
                          void pickReport(r.path);
                        }}
                      >
                        {r.name}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2">
              {revisions.length === 0 ? (
                <div className="text-11 leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                  暂无修订。选中文字可发起 AI 修订，或用「AI 整文档修订」。
                </div>
              ) : (
                revisions.map((rev, i) => (
                  <div key={`${rev.id}-${i}`} style={revItemStyle}>
                    <div style={revItemTextStyle}>
                      <span
                        className="mr-1.5 rounded px-1 py-px text-10 font-semibold"
                        style={
                          rev.kind === 'delete' || rev.kind === 'delete-mark'
                            ? { background: 'var(--danger-soft)', color: 'var(--danger)' }
                            : { background: 'var(--success-soft)', color: '#0f7a4d' }
                        }
                      >
                        {rev.kind === 'delete' || rev.kind === 'delete-mark' ? '删除' : '插入'}
                      </span>
                      {rev.text || '（空）'}
                      {rev.author ? (
                        <span className="ml-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
                          — {rev.author}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex gap-1">
                      <Button variant="soft" tone="success" size="xs" onClick={() => void resolveRevisions([{ id: rev.id, accept: true }])}>
                        接受
                      </Button>
                      <Button variant="ghost" tone="danger" size="xs" onClick={() => void resolveRevisions([{ id: rev.id, accept: false }])}>
                        拒绝
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="flex shrink-0 flex-wrap gap-1.5 border-t border-[var(--line-soft)] px-2.5 py-2">
              <Button variant="outline" tone="neutral" size="xs" disabled={revising || revisions.length === 0} onClick={() => void resolveRevisions([], true)}>
                全部接受
              </Button>
              <Button variant="outline" tone="neutral" size="xs" disabled={revising || revisions.length === 0} onClick={() => void resolveRevisions([], false)}>
                全部拒绝
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="xs"
                disabled={revising || revisions.length === 0 || !fileInfo.full_path}
                onClick={() => void handleAcceptAllToOriginal()}
              >
                接受并写回原稿
              </Button>
            </div>
          </aside>
        ) : null}
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageFile} />

      {error ? (
        <div className="shrink-0 px-3 py-1.5 text-11" style={{ color: '#b42318', background: 'var(--danger-soft)' }}>
          {error}
        </div>
      ) : null}

      {/* 计划应用进度（悬浮提示条） */}
      {planProgress ? (
        <div className="docx-pop" style={planBannerStyle}>
          {planProgress.total < 0
            ? 'AI 正在解析审核报告…'
            : `AI 应用修订计划：${planProgress.done}/${planProgress.total}${
                planProgress.failed.length ? `（失败 ${planProgress.failed.length}）` : ''
              }`}
        </div>
      ) : null}

      {/* 选中文字浮层：AI 改写 / 直接替换 / 删除 */}
      {aiSel ? (
        <div className="docx-pop" style={aiPanelStyle(aiSel)} onMouseDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              placeholder="用文字指示，或留空删除选中"
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitInstruction();
                }
              }}
              style={aiInputStyle}
            />
            <Button variant="ghost" tone="neutral" size="icon-xs" title="关闭" onClick={() => setAiSel(null)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button variant="solid" tone="brand" size="xs" disabled={aiBusy} onClick={() => void runAiDirect()}>
              AI 改写
            </Button>
            <Button variant="outline" tone="neutral" size="xs" disabled={aiBusy} onClick={() => void replaceDirect()}>
              直接替换
            </Button>
            <Button variant="ghost" tone="danger" size="xs" disabled={aiBusy} onClick={() => void applyRevise('')}>
              删除
            </Button>
          </div>
          {aiBusy ? (
            <div className="mt-1.5 text-11" style={{ color: 'var(--ink-faint)' }}>
              处理中…
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ============ 状态栏（24px）：页码 / 字数 / 标尺 / 缩放 ============ */}
      <div className="docx-print-hide" style={statusBarStyle}>
        <span>第 {currentPage} / {pageCount} 页</span>
        <span style={{ color: 'var(--line)' }}>·</span>
        <span>字数 {wordCount}</span>
        <div className="flex-1" />
        <Button
          variant={showRuler ? 'soft' : 'ghost'}
          tone={showRuler ? 'brand' : 'neutral'}
          size="icon-xs"
          title="显示 / 隐藏标尺"
          onClick={() => setShowRuler((v) => !v)}
        >
          <Ruler className="h-3.5 w-3.5" />
        </Button>
        <span className="mx-0.5 h-3.5 w-px" style={{ background: 'var(--line-soft)' }} />
        <Button
          variant="ghost"
          tone="neutral"
          size="icon-xs"
          title="缩小"
          onClick={() => {
            setAutoFit(false);
            zoomOut();
          }}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[34px] text-center text-10" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          tone="neutral"
          size="icon-xs"
          title="放大"
          onClick={() => {
            setAutoFit(false);
            zoomIn();
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant={autoFit ? 'soft' : 'ghost'}
          tone={autoFit ? 'brand' : 'neutral'}
          size="icon-xs"
          title="按面板宽度自动适配"
          onClick={() => setAutoFit(true)}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <style>{docxStyleSheet(geom)}</style>
    </div>
  );
}

/* ================================================================
 * 面板模式 UI 常量
 *
 * 为什么不是把整页 chrome 等比缩小：
 *   整页 chrome = 44(标题) + 100(Ribbon) + 22(标尺) + 28(状态) = 194px，
 *   且 Ribbon 5 个分组需要 ≥1140px 宽才不换行 —— 而预览面板默认 800px（可拖到 320）。
 *   所以面板模式换一套 chrome：32 + 36 + 24 = 92px，宽度靠「宽档/窄档 + ⋯ 溢出菜单」自适应。
 *
 * 表面层次：chrome = #fff，画布 = var(--canvas-bg)，白纸 = #fff + 阴影。
 * ================================================================ */

/** 面板标题栏高度 */
const PANEL_HEADER_H = 32;
/** 单行工具条高度 */
const PANEL_TOOLBAR_H = 36;
/** 状态栏高度 */
const PANEL_STATUS_H = 24;
/** 画布左右留白（面板内比整页更紧） */
const PANEL_CANVAS_PAD = 12;
/**
 * 修订侧栏改为推开画布的最小面板宽度。
 * 之所以门槛要高：推开后画布只剩 panelW-288，A4 纸会被自动适配压到 0.6 以下就不可读了；
 * 低于此宽度时改用浮层（临时阅览，关掉即回到全宽）。
 */
const REV_DOCK_MIN = 1100;

const CANVAS_PAD = PANEL_CANVAS_PAD;
/** 竖标尺宽度：对齐 Word 的窄标尺（原 44px 过宽，整条白长带翼得笨重） */
const V_RULER_W = 20;

const FONT_OPTIONS = ['宋体', '黑体', '微软雅黑', 'Calibri', 'Arial', 'Times New Roman', 'Cambria', '仿宋', '楷体', 'Consolas'];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72];
/* ================================================================
 * 工具条自适应折叠（Word 式优先级溢出）—— 2026-10-02
 *
 * 取代此前的二元宽窄档（`WIDE_TOOLBAR_MIN = 700`）：二元档要么全给要么全收，
 * 在默认面板宽度上表现为「字体/样式的下拉忽然消失」，用户观感是功能被藏了。
 * 现在改为按可用宽度**逐个槽位**淘汰，填满可用空间，且永不出现横向滚动条。
 *
 * ⚠️ 宽度**不能写死 px**：本项目的 `html, body { font-size: var(--fs-md) }`
 *    会随「字号档位」（`html[data-fontscale]`）在 15 / 17 / 19px 间切换，而工具条的
 *    尺寸类全是 rem 单位 ⇒ 按 16px 基准估算会在「大字号」档位下低估宽度、把按钮剪掉。
 *    故统一从**实测根字号**换算（见 `toolMetrics`），并在档位切换时重算。
 *
 * 与渲染实现的对应关系（Tailwind v4，`--spacing` = 0.25rem）：
 *   · ToolBtn      `h-6 w-6`        → 1.5rem
 *   · 容器         `gap-1`          → 0.25rem
 *   · ToolSep      `mx-0.5 w-px`    → 0.125rem×2 + 1px
 *   · 容器         `px-2`           → 0.5rem×2（左右合计 1rem）
 *   · 三个下拉     `style={{width}}` → 固定 px（不随字号档位变）
 * ================================================================ */

/** 折叠安全余量：估算已按实测根字号换算，这里只兜住亚像素舍入，宁可少放一个也不溢出 */
const TOOLBAR_SLACK = 8;

/** 字体 / 字号 / 样式三个下拉的宽度（内联 px，不随字号档位变） */
const FONT_SEL_W = 104;
const SIZE_SEL_W = 56;
const STYLE_SEL_W = 78;

/** 工具条尺寸度量：全部由实测根字号换算 */
interface ToolMetrics {
  /** 图标按钮宽（ToolBtn：w-6） */
  btn: number;
  /** 相邻控件间距（容器 gap-1） */
  gap: number;
  /** 分隔线宽含两侧 margin（ToolSep：mx-0.5 w-px） */
  sep: number;
  /** 容器左右内边距合计（px-2） */
  padX: number;
}

function toolMetrics(rem: number): ToolMetrics {
  return { btn: 1.5 * rem, gap: 0.25 * rem, sep: 0.25 * rem + 1, padX: rem };
}

/** 工具条上的一个槽位：一个下拉控件，或一组同分区命令按钮 */
interface ToolSlot {
  /** 稳定标识（React key）；命令分区槽位与 DocxToolSection 同名 */
  key: string;
  /** 命令分区（下拉控件槽位为 undefined） */
  section?: DocxToolSection;
  /** 下拉控件槽位（命令分区槽位为 undefined） */
  widget?: 'font' | 'size' | 'style';
  /** 内容宽度，不含相邻 gap 与分隔线 */
  width: number;
  /** 非首位渲染时前面插一条分隔线（视觉分组） */
  sepBefore: boolean;
  /** 淘汰次序：数字越大越先被挤出工具条；0 = 永不淘汰 */
  evictRank: number;
}

/** 一组命令按钮的宽度：n 个按钮 + (n-1) 个间距（分区空则为 0） */
function groupWidth(section: DocxToolSection, m: ToolMetrics): number {
  const n = commandsOfToolSection(section).length;
  return n > 0 ? n * m.btn + (n - 1) * m.gap : 0;
}

/**
 * 工具条槽位表 —— **数组顺序即工具条展示顺序**，`evictRank` 决定「先牺牲谁」。
 * 顺序对齐 Word「开始」选项卡：字体 → 字形 → 段落 → 样式 → 低频项。
 * 分区宽度由 `groupWidth` 从命令表算出，避免宽度常量与命令表分头维护导致漂移。
 */
function toolbarSlots(m: ToolMetrics): ToolSlot[] {
  return [
    { key: 'font', widget: 'font', width: FONT_SEL_W, sepBefore: false, evictRank: 1 },
    { key: 'size', widget: 'size', width: SIZE_SEL_W, sepBefore: false, evictRank: 2 },
    { key: 'inline', section: 'inline', width: groupWidth('inline', m), sepBefore: true, evictRank: 0 },
    { key: 'script', section: 'script', width: groupWidth('script', m), sepBefore: false, evictRank: 3 },
    { key: 'align', section: 'align', width: groupWidth('align', m), sepBefore: true, evictRank: 4 },
    { key: 'list', section: 'list', width: groupWidth('list', m), sepBefore: false, evictRank: 5 },
    { key: 'style', widget: 'style', width: STYLE_SEL_W, sepBefore: true, evictRank: 6 },
    { key: 'paraIndent', section: 'paraIndent', width: groupWidth('paraIndent', m), sepBefore: true, evictRank: 7 },
    { key: 'paraMisc', section: 'paraMisc', width: groupWidth('paraMisc', m), sepBefore: false, evictRank: 8 },
    { key: 'insert', section: 'insert', width: groupWidth('insert', m), sepBefore: true, evictRank: 9 },
  ];
}

/** 一组槽位渲染后的估算总宽（含 flex gap 与分隔线），与工具条 JSX 的插槽逻辑一一对应 */
function slotsWidth(slots: ToolSlot[], m: ToolMetrics): number {
  let w = 0;
  slots.forEach((s, i) => {
    if (i > 0) {
      w += m.gap;
      if (s.sepBefore) w += m.sep + m.gap;
    }
    w += s.width;
  });
  return w;
}

/**
 * 按可用宽度贪心淘汰：从最不重要的槽位开始丢，丢到装得下为止。
 * 对标 Word ribbon 的自适应折叠；被丢掉的槽位由 ⋯ 菜单按分区补位，功能始终可达。
 */
function fitToolbar(avail: number, m: ToolMetrics): ToolSlot[] {
  let keep = toolbarSlots(m);
  const evictOrder = keep.filter((s) => s.evictRank > 0).sort((a, b) => b.evictRank - a.evictRank);
  for (const s of evictOrder) {
    if (slotsWidth(keep, m) <= avail) break;
    keep = keep.filter((k) => k.key !== s.key);
  }
  return keep;
}

/** 下拉框统一样式（与 Button xs 同高同圆角） */
const SELECT_CLS =
  'h-6 rounded-md border border-[var(--line)] bg-white px-1 text-11 text-foreground outline-none transition-colors hover:bg-[var(--paper-soft)]';
/** 浮层内数值输入框统一样式 */
const NUM_INPUT_CLS =
  'h-6 w-full rounded-md border border-[var(--line)] bg-white px-1.5 text-11 text-foreground outline-none transition-colors hover:bg-[var(--paper-soft)]';

/* ---------------- 标尺（水平）几何常量 ---------------- */

const RULER_H = 20;
/** 1 英寸 @96dpi（与 PAGE_W/PAGE_H 同一坐标系） */
const INCH = 96;
/** 拖拽吸附粒度（pt） */
const INDENT_SNAP_PT = 4;
/** 首行悬挂上限（pt，≈ 左页边距 96px = 72pt） */
const MIN_FIRST_LINE_PT = -72;

/**
 * 标尺条：sticky 顶在滚动容器内、与白纸同宽同居中，
 * 因此横向滚动 / 出现滚动条 / 改缩放都不会与纸面失准。
 */
const rulerStickyStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 10,
  height: RULER_H,
  /** 页边距区灰（--paper #f7f7f8 与白只差 3%，分段会糊底，故用对比约 9% 的 --paper-hover） */
  background: 'var(--paper-hover)',
  borderBottom: '1px solid var(--line-soft)',
  overflow: 'hidden',
};
/** 标尺上的「文本区」（白）—— 页边距区保留标尺底色灰，形成 Word 那种「灰-白-灰」分段 */
const rulerTextZoneStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  background: '#fff',
};
const rulerMinorStyle: React.CSSProperties = {
  position: 'absolute',
  top: RULER_H - 4,
  width: 1,
  height: 4,
  background: 'var(--line)',
};
const rulerMajorStyle: React.CSSProperties = {
  position: 'absolute',
  top: RULER_H - 8,
  width: 1,
  height: 8,
  background: 'var(--ink-faint)',
};
const rulerLabelStyle: React.CSSProperties = {
  position: 'absolute',
  left: 3,
  top: -11,
  fontSize: 9,
  fontWeight: 500,
  color: 'var(--ink-muted)',
};
const rulerPageEdgeStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 1,
  background: 'var(--ink-faint)',
  opacity: 0.35,
};
/** 缩进手柄热区（热区比三角形大，便于抓取） */
const rulerHandleStyle: React.CSSProperties = {
  position: 'absolute',
  width: 15,
  height: 11,
  transform: 'translateX(-50%)',
  cursor: 'ew-resize',
  touchAction: 'none',
  display: 'grid',
  placeItems: 'center',
};
const rulerTriDown: React.CSSProperties = {
  width: 0,
  height: 0,
  borderLeft: '5px solid transparent',
  borderRight: '5px solid transparent',
  borderTop: '7px solid var(--brand)',
};
const rulerTriUp: React.CSSProperties = {
  width: 0,
  height: 0,
  borderLeft: '5px solid transparent',
  borderRight: '5px solid transparent',
  borderBottom: '7px solid var(--brand)',
};

const centerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 24,
  background: '#fff',
  color: 'var(--ink)',
};

const scalerStyle: React.CSSProperties = { position: 'relative', margin: '0 auto' };
const paperWrapperStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  transformOrigin: 'top left',
  display: 'flex',
  alignItems: 'stretch',
};

/* ---------------- chrome 布局 ---------------- */

const headerStyle: React.CSSProperties = { height: PANEL_HEADER_H };
const toolbarStyle: React.CSSProperties = { height: PANEL_TOOLBAR_H };

const rootStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: '#fff',
  color: 'var(--ink)',
};

const canvasStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'auto',
  background: 'var(--canvas-bg)',
  padding: `${CANVAS_PAD}px 0`,
};

/* ---------------- 每页页脚（P4） ---------------- */

/**
 * 页脚行高（px）—— 同一时刻是 `.docx-page-footer` 的 `line-height` 与
 * `pageFooterTopAt(i, lineH, g)` 的 `lineH`。**两者必须同源**：页脚底边距纸底恒为
 * `footerDist` 这条不变量，是靠「顶 = 纸底 − footerDist − 行高」推出来的。
 */
const DOCX_FOOTER_LINE_H = 16;

/** 引擎对 `w:fldSimple PAGE` / `NUMPAGES` 的占位符（同源：lib/docx-engine/types.ts:852-854） */
const PAGE_FIELD_MARK = '\uE001';
const TOTAL_PAGES_FIELD_MARK = '\uE000';

/**
 * 第 n 页（1-based）的页脚文字。
 * 文档自带页脚文本时以它为准，并把引擎的字段占位符换成真实页码 / 总页数；
 * 文档没有页脚时退回「只有页码」—— 这正是 P4 之前完全缺失的**末页页码**。
 */
function footerLineText(n: number, total: number, text: string | null | undefined): string {
  const raw = (text ?? '').trim();
  if (!raw) return String(n);
  return raw.split(PAGE_FIELD_MARK).join(String(n)).split(TOTAL_PAGES_FIELD_MARK).join(String(total));
}

/**
 * 白纸几何：**数值**全部来自 `paperBoxStyle(geom)`（`docx-pagination` 的几何唯一真源），
 * 宿主只补视觉部分（底色 / 阴影），避免 794 / 1123 / 96 出现第二份定义。
 *
 * P4：`position: relative` 是新增的 —— 每页页脚由 `pageFooterTopAt` 算出的纵坐标
 * **绝对定位在纸内**（页脚住在纸的下边距带里，不参与文档流，所以不污染 docx 字节）。
 */
const pageStyleOf = (g: PageGeometry): React.CSSProperties => ({
  position: 'relative',
  background: '#fff',
  boxShadow: '0 1px 2px rgba(0,0,0,0.10), 0 8px 24px rgba(0,0,0,0.13)',
  boxSizing: 'border-box',
  ...paperBoxStyle(g),
});

/* ---------------- 查找 / 替换 ---------------- */

const findBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderBottom: '1px solid var(--line-soft)',
  background: '#fff',
  flexWrap: 'wrap',
};
const findInputStyle: React.CSSProperties = {
  fontSize: 12,
  height: 24,
  minWidth: 120,
  padding: '0 7px',
  borderRadius: 6,
  border: '1px solid var(--line)',
  background: '#fff',
  color: 'var(--ink)',
  fontFamily: 'inherit',
};
const findOptStyle: React.CSSProperties = {
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  color: 'var(--ink-muted)',
  userSelect: 'none',
  cursor: 'pointer',
};
const findCountStyle: React.CSSProperties = { fontSize: 11, minWidth: 40, textAlign: 'center', color: 'var(--ink-muted)' };
const findSepStyle: React.CSSProperties = { width: 1, height: 16, background: 'var(--line-soft)' };

/* ---------------- 页眉页脚编辑面板 ---------------- */

const hfPanelStyleOf = (g: PageGeometry): React.CSSProperties => ({
  width: g.w,
  margin: `0 auto ${CANVAS_PAD / 2}px`,
  background: '#fff',
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: 12,
  boxSizing: 'border-box',
});

const hfLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ink-muted)',
  margin: '4px 0',
};

const hfTextareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 44,
  fontSize: 13,
  borderRadius: 8,
  border: '1px solid var(--line)',
  padding: '6px 8px',
  boxSizing: 'border-box',
  resize: 'vertical',
  fontFamily: 'inherit',
  background: '#fff',
  color: 'var(--ink)',
};

/* ---------------- 文档内容样式（编辑面 / 修订标记 / 查找高亮） ---------------- */

/**
 * 编辑器样式表 = **几何层皮肤**（`docxPaperCss`：纸面 / 间隙 / 页脚 / `@page` / 打印规则）
 *              + 编辑面专属规则（占位符 / 表格 / 图片 / 修订 / 查找高亮 / 进场动画）。
 *
 * ⚠️ P4 起它从模块级常量变成**函数**：几何层的两条规则含节几何（负 margin 必须等于 `marginX`，
 * `@page` 纸尺寸必须等于 `w`/`h`）。写成常量的话，非 A4 文档的白带就顶不到纸张边缘。
 * 纸面/间隙/页脚/打印这些**几何皮肤**刻意不写在这里 —— 它们归 `docxPaperCss`，
 * 这样 Electron 靶场能 import 同一份（打印规则只在真实打印时生效，靶场是唯一验证途径）。
 */
const docxStyleSheet = (g: PageGeometry): string => `${docxPaperCss(g)}

.docx-placeholder {
  display: block;
  margin: 8px 0;
  padding: 14px 16px;
  border: 1px dashed var(--line, #c7c7cc);
  border-radius: 10px;
  background: var(--paper-soft, #efeff2);
  color: var(--ink-muted, #52525b);
  font-size: 13px;
  text-align: center;
  user-select: none;
}
.docx-placeholder[data-kind="table"] { border-style: solid; }
.ProseMirror { outline: none; }
.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3 { margin: 6px 0; line-height: 1.6; }
/* 标题字号（Word 风格） */
.ProseMirror h1 { font-size: 24pt; font-weight: 700; }
.ProseMirror h2 { font-size: 19pt; font-weight: 700; }
.ProseMirror h3 { font-size: 15pt; font-weight: 600; }
/* 表格真实 WYSIWYG 渲染 */
.docx-table { border-collapse: collapse; width: 100%; table-layout: fixed; }
.docx-table, .docx-tcell { border: 1px solid var(--line); }
.docx-tcell { padding: 5px 7px; vertical-align: top; font-size: 13px; line-height: 1.5; }
.docx-tcell-continue { border: none; }
/* 图片真实渲染 */
.docx-image-frame { border: 1px solid var(--line); border-radius: 2px; max-width: 100%; }
.docx-image-missing .docx-image-frame { padding: 16px; background: var(--paper-soft, #efeff2); color: var(--ink-muted, #52525b); }
/* 列表项 */
.docx-li { display: flex; gap: 6px; align-items: flex-start; margin: 2px 0; }
.docx-li-marker { min-width: 18px; text-align: right; user-select: none; flex: 0 0 auto; }
.docx-li-body { flex: 1 1 auto; }
/* 修订标记：插入（绿）/ 删除（红删除线），语义色走 Token */
.docx-rev-ins { color: var(--success); background: var(--success-soft); text-decoration: none; border-bottom: 1px solid color-mix(in oklab, var(--success) 55%, transparent); }
.docx-rev-del { color: var(--danger); background: var(--danger-soft); text-decoration: line-through; }
/* 隐藏修订标记：显示最终文本（接受态预览） */
.docx-hide-rev .docx-rev-ins { color: inherit; background: none; border-bottom: none; }
.docx-hide-rev .docx-rev-del { color: inherit; background: none; text-decoration: none; }
/* 视觉分页 / 页脚规则见 docxPaperCss（几何层皮肤，与靶场共用同一份） */
/* 左侧竖标尺：窄条（20px），底色与横标尺同为浅灰，刻度线只贴右边缘向左伸 5px（不遮数字） */
.docx-vruler {
  background-color: var(--paper-hover);
  border-right: 1px solid var(--line-soft);
  background-image:
    repeating-linear-gradient(0deg, var(--line) 0, var(--line) 1px, transparent 1px, transparent 24px),
    repeating-linear-gradient(0deg, var(--ink-faint) 0, var(--ink-faint) 1px, transparent 1px, transparent 96px);
  background-size: 5px 100%, 9px 100%;
  background-position: right top, right top;
  background-repeat: no-repeat, no-repeat;
}
/* 查找高亮：普通命中（黄）/ 当前命中（橙） */
.docx-search-hit { background: rgba(255, 214, 10, 0.42); border-radius: 2px; }
.docx-search-active { background: rgba(255, 149, 0, 0.62); color: #1c1c1e; }
/* 浮层 / 侧栏进场（只动 opacity + transform，不触发布局） */
@keyframes docx-pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes docx-slide-in { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
.docx-pop { animation: docx-pop-in 130ms cubic-bezier(0.2, 0, 0, 1); }
.docx-slide { animation: docx-slide-in 150ms cubic-bezier(0.2, 0, 0, 1); }
@media (prefers-reduced-motion: reduce) { .docx-pop, .docx-slide { animation: none; } }
`;

/* ---------------- AI 修订浮层 / 进度条 ---------------- */

const planBannerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: PANEL_STATUS_H + 10,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 30,
  fontSize: 12,
  padding: '5px 12px',
  borderRadius: 999,
  background: 'rgba(28,28,30,0.85)',
  color: '#fff',
  boxShadow: 'var(--shadow-lg, 0 4px 14px rgba(0,0,0,0.25))',
  pointerEvents: 'none',
};

const aiPanelStyle = (sel: AiSel): React.CSSProperties => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const width = Math.min(300, vw - 16);
  const left = Math.min(Math.max(sel.left, 8), Math.max(8, vw - width - 8));
  // 选区下方放不下就翻到上方，避免浮层被面板底边裁掉
  const flip = vh - (sel.top + sel.height) - 8 < 140;
  return {
    position: 'fixed',
    ...(flip ? { bottom: vh - sel.top + 8 } : { top: sel.top + sel.height + 8 }),
    left,
    zIndex: 40,
    width,
    padding: 10,
    borderRadius: 12,
    border: '1px solid var(--line)',
    background: '#fff',
    boxShadow: 'var(--shadow-lg, 0 8px 28px rgba(0,0,0,0.18))',
  };
};

const aiInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  height: 24,
  padding: '0 7px',
  borderRadius: 6,
  border: '1px solid var(--line)',
  background: '#fff',
  color: 'var(--ink)',
  fontFamily: 'inherit',
};

/* ---------------- 修订面板 ---------------- */

/** 宽面板：与画布并排，推开画布（不遮挡正文） */
const revPanelDockedStyle: React.CSSProperties = {
  width: 288,
  flex: '0 0 auto',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderLeft: '1px solid var(--line-soft)',
  background: '#fff',
};

/** 窄面板：浮层覆盖（推开会把 A4 纸挤到 0 宽） */
const revPanelOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  width: 'min(288px, 100%)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderLeft: '1px solid var(--line-soft)',
  background: '#fff',
  boxShadow: '-6px 0 20px rgba(0,0,0,0.10)',
  zIndex: 20,
};

const revPanelHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flex: '0 0 auto',
  height: 32,
  padding: '0 6px 0 10px',
  borderBottom: '1px solid var(--line-soft)',
};

const revPickerStyle: React.CSSProperties = {
  marginTop: 6,
  border: '1px solid var(--line)',
  borderRadius: 8,
  maxHeight: 200,
  overflow: 'auto',
  background: '#fff',
};

const revPickerItemStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '6px 9px',
  cursor: 'pointer',
  borderBottom: '1px solid var(--line-soft)',
};

const revItemStyle: React.CSSProperties = {
  padding: '7px 9px',
  marginBottom: 6,
  borderRadius: 8,
  border: '1px solid var(--line-soft)',
  background: '#fff',
};

const revItemTextStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--ink)',
  wordBreak: 'break-word',
};

/* ---------------- 底部状态栏 ---------------- */

const statusBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
  height: PANEL_STATUS_H,
  padding: '0 8px',
  fontSize: 10,
  color: 'var(--ink-muted)',
  borderTop: '1px solid var(--line-soft)',
  background: '#fff',
};

/* ================================================================
 * 局部组件
 * ================================================================ */

/** 工具条 / 菜单里的图标按钮 */
function ToolBtn({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        active ? 'bg-[var(--brand-soft-strong)]' : 'hover:bg-[var(--paper-hover)]',
      )}
      style={{ color: active ? 'var(--brand)' : 'var(--ink)' }}
    >
      {children}
    </button>
  );
}

/** 组内竖分隔线 */
function ToolSep() {
  return <span className="mx-0.5 h-4 w-px shrink-0" style={{ background: 'var(--line-soft)' }} aria-hidden />;
}

/** ⋯ 菜单里的图标 + 文字按钮（wide 时带标签） */
function MenuBtn({
  title,
  active,
  disabled,
  wide,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  wide?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md text-11 transition-colors',
        wide ? 'px-1.5' : 'w-6',
        'disabled:pointer-events-none disabled:opacity-40',
        active ? 'bg-[var(--brand-soft-strong)]' : 'hover:bg-[var(--paper-hover)]',
      )}
      style={{ color: active ? 'var(--brand)' : 'var(--ink)' }}
    >
      {children}
    </button>
  );
}

/** 菜单分区：小标题 + 内容 */
function MenuSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 border-b border-[var(--line-soft)] pb-1.5 last:mb-0 last:border-b-0 last:pb-0">
      <div className="px-0.5 pb-1 text-10" style={{ color: 'var(--ink-faint)' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

/** 菜单内一行控件 */
function MenuRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1">{children}</div>;
}

/** 菜单内的「标签 + 控件」竖排字段 */
function ParaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * 下拉：原生 select + 自绘箭头。
 * 原生 select 的箭头不可样式化，与相邻自绘按钮风格割裂，这里 appearance-none 后自行贴一个 ChevronDown。
 */
function PanelSelect({
  value,
  onChange,
  title,
  width,
  full,
  children,
}: {
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  title: string;
  width?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={cn('relative items-center', full ? 'flex w-full' : 'inline-flex shrink-0')}>
      <select
        className={cn(SELECT_CLS, 'cursor-pointer appearance-none pr-4', full && 'w-full')}
        style={full ? undefined : { width }}
        value={value}
        onChange={onChange}
        title={title}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1 h-3 w-3" style={{ color: 'var(--ink-faint)' }} />
    </span>
  );
}

/**
 * 水平标尺：与白纸同宽同居中（父层已保证），刻度 1/4 英寸、整英寸带数字，
 * 页边距虚线 + 首行/左缩进手柄（可拖拽，4pt 吸附）。
 *
 * 只在落点变化时提交事务：拖拽期间不调用 focus()，避免画布跟随选区滚动；
 * 也不做 rAF 节流 —— 4pt 吸附本身已把提交频率压到每 ~5px 一次。
 */
function DocxRuler({
  zoom,
  vrW,
  geom,
  firstLinePt,
  leftIndentPt,
  onCommit,
}: {
  zoom: number;
  vrW: number;
  geom: PageGeometry;
  firstLinePt: number;
  leftIndentPt: number;
  onCommit: (kind: 'first' | 'left', pt: number) => void;
}) {
  const drag = useRef<{ kind: 'first' | 'left'; startX: number; basePt: number; lastPt: number } | null>(null);

  const pageLeft = vrW * zoom;
  const textLeft = pageLeft + geom.marginX * zoom;
  const textRight = pageLeft + (geom.w - geom.marginX) * zoom;
  /** pt → 屏幕 px（1pt = 4/3px @96dpi） */
  const pxPerPt = (4 / 3) * zoom;

  const ticks: React.ReactNode[] = [];
  // 细刻度：铺满整页（含左右页边距区），1/4 英寸
  for (let x = pageLeft; x <= pageLeft + geom.w * zoom - 0.5; x += (INCH / 4) * zoom) {
    ticks.push(<span key={`n${Math.round(x)}`} style={{ ...rulerMinorStyle, left: x }} />);
  }
  // 粗刻度 + 数字：只铺正文区，0 起于左页边距
  for (let i = 0; textLeft + i * INCH * zoom <= textRight + 0.5; i++) {
    const x = textLeft + i * INCH * zoom;
    ticks.push(
      <span key={`M${i}`} style={{ ...rulerMajorStyle, left: x }}>
        <b style={rulerLabelStyle}>{i}</b>
      </span>,
    );
  }

  /** 按下手柄开始拖拽（pointer capture 保证移出标尺也不丢事件） */
  const begin = (kind: 'first' | 'left') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const basePt = kind === 'first' ? firstLinePt : leftIndentPt;
    drag.current = { kind, startX: e.clientX, basePt, lastPt: basePt };
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = d.basePt + ((e.clientX - d.startX) / zoom) * 0.75;
    const snapped = Math.round(raw / INDENT_SNAP_PT) * INDENT_SNAP_PT;
    const next = d.kind === 'left' ? Math.max(0, snapped) : Math.max(MIN_FIRST_LINE_PT, snapped);
    if (next === d.lastPt) return;
    d.lastPt = next;
    onCommit(d.kind, next);
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const dragProps = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };

  return (
    <div className="docx-ruler" style={{ position: 'relative', height: RULER_H }} aria-hidden>
      {/* 文本区白底（页边距区保留标尺底色灰）—— 置于刻度之下 */}
      <span
        style={{
          ...rulerTextZoneStyle,
          left: textLeft,
          width: (geom.w - 2 * geom.marginX) * zoom,
        }}
      />
      {ticks}
      <span style={{ ...rulerPageEdgeStyle, left: pageLeft }} />
      <span style={{ ...rulerPageEdgeStyle, left: pageLeft + geom.w * zoom }} />
      <div
        style={{ ...rulerHandleStyle, top: 0, left: textLeft + firstLinePt * pxPerPt }}
        title="首行缩进（拖拽调整）"
        onPointerDown={begin('first')}
        {...dragProps}
      >
        <span style={rulerTriDown} />
      </div>
      <div
        style={{ ...rulerHandleStyle, bottom: 0, left: textLeft + leftIndentPt * pxPerPt }}
        title="左缩进（拖拽调整）"
        onPointerDown={begin('left')}
        {...dragProps}
      >
        <span style={rulerTriUp} />
      </div>
    </div>
  );
}

/**
 * 左侧竖标尺：与水平标尺同一套几何（正文顶 = PAGE_MARGIN_Y），每英寸一个数字。
 *
 * 高度由父级 flex（`paperWrapperStyle` 的 `alignItems: stretch`）决定，即 `paperHeightPx`
 * 的**未缩放**值；因此这里只需按高度生成数字即可。刻度线由 `.docx-vruler` 的
 * background 贴右边缘向左伸 5px 绘制，数字故右对齐并留 6px 空档，两者不重叠。
 */
function DocxVRuler({ height, geom }: { height: number; geom: PageGeometry }) {
  const labels: React.ReactNode[] = [];
  for (let i = 0; geom.marginY + i * INCH <= height - 10; i++) {
    labels.push(
      <span
        key={i}
        style={{
          position: 'absolute',
          top: geom.marginY + i * INCH - 5,
          left: 0,
          right: 6,
          textAlign: 'right',
          fontSize: 9,
          lineHeight: '10px',
          color: 'var(--ink-muted)',
          userSelect: 'none',
        }}
      >
        {i}
      </span>,
    );
  }
  return (
    <div
      className="docx-vruler docx-print-hide"
      style={{ width: V_RULER_W, flex: '0 0 auto', position: 'relative' }}
      aria-hidden
    >
      {labels}
    </div>
  );
}
