'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ExternalLink, Loader2, Wand2, Sparkles, Replace, Save, Check, X, FileDiff, Eye, GitCompareArrows, ZoomIn, ZoomOut, Maximize, Frame, FileText,
} from 'lucide-react';
import type { ViewerRenderProps } from './types';
import { desktop } from '@/lib/desktop-adapter';
import { Button } from '@/components/ui/button';
import { bus, BusEvents } from '@/lib/bus';
import { convertDocxToMarkdown } from '@/lib/docx-to-md';

type DocxUnsupportedKind = 'legacy-doc' | 'corrupted';

/** 修订视图模式 */
type ViewMode = 'markup' | 'all' | 'none' | 'original';

/** 单条修订（后端 inspect/apply/resolve 返回） */
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

/** chatnode 提交的修订计划（<docx同名>.revisions.json） */
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

const VIEW_LABELS: Record<ViewMode, string> = {
  markup: 'Show Markup',
  all: 'All Markup',
  none: 'No Markup',
  original: 'Original',
};

/** 时间戳后缀：YYYYMMDD-HHmm（修订版 / 转 MD 文件名共用） */
function makeStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 修订版保存文件名：原名-修订YYYYMMDD-HHmm.docx（时间戳避免与原文同名，防 WPS 打开后原地覆盖丢失修订） */
function makeRevisedName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-修订${makeStamp()}${name.slice(dot)}` : `${name}-修订${makeStamp()}`;
}

/** 转出 Markdown 文件名：原名-转MDYYYYMMDD-HHmm.md（每次转换生成新文件，不覆盖既有文档） */
function makeMdName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}-转MD${makeStamp()}.md`;
}

/**
 * Word 文档编辑器（路线 1：OOXML 原生 + docx-preview 渲染）
 * - docx-preview 直接渲染 OOXML，真实排版还原（含修订标记显示）
 * - AI 编辑：圈选文字 → 改写 → /api/docx/revise 生成 w:ins/w:del 原生修订
 * - 修订面板：逐条/全部接受拒绝；视图切换（标记/全部/无标记/原始）
 * - 保存：本地原稿（有 full_path + 打开时刻 mtime 哨兵）直接写回原文件，不生成修订稿（会话首次写回前自动备份）；
 *   非本地原稿退回 homework 时间戳修订稿通道；外部打开走临时副本，防 WPS 写回覆盖
 * - 更新原稿：接受全部修订后一键立即写回原文件（Word/WPS 锁文件 + mtime 哨兵双重冲突防护）
 * - 一键转 MD：mammoth 转出 Markdown（等价接受全部修订）存入 homework，发布 file.open 在 md 编辑器打开编辑
 */
export function DocxViewer({ proxyUrl, fileInfo, fileName, onError }: ViewerRenderProps) {
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState<DocxUnsupportedKind | null>(null);
  const [docxBase64, setDocxBase64] = useState<string | null>(null); // 当前（可能含修订）docx
  const [mdText, setMdText] = useState<string | null>(null); // mammoth 转 md（AI 改写上下文）
  const [revisions, setRevisions] = useState<RevisionItem[]>([]);
  const [view, setView] = useState<ViewMode>('markup');
  const [panelOpen, setPanelOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** 最近一次保存落盘的绝对路径（直写模式=原稿路径；兜底模式=homework 修订稿路径；null=未保存） */
  const [savedPath, setSavedPath] = useState<string | null>(null);
  /** 修订版落盘后的 mtime：外部打开前与磁盘当前值比对，检测文件是否被 WPS 等外部程序改写 */
  const [savedMtime, setSavedMtime] = useState<number | null>(null);
  /** 原稿打开时刻的 mtime（file_proxy 响应头 X-File-Mtime）：写回前与磁盘比对，防覆盖外部修改 */
  const [originalMtime, setOriginalMtime] = useState<number | null>(null);
  /** 写回原稿被阻止的原因（非 null = 自动直写已暂停；关闭 WPS 后点「保存」重试成功即清除） */
  const [writeBlocked, setWriteBlocked] = useState<string | null>(null);
  /** 本会话是否已写过原稿：「仅会话首次备份」策略——首次写回前备份一次，之后不再重复备份 */
  const wroteOriginalRef = useRef(false);
  /** 本会话修订版文件名：首次保存生成时间戳名，自动保存复用同名（防覆盖原文，也防副本泛滥） */
  const revisedNameRef = useRef<string | null>(null);
  /** 修订模式：true = 修改以 w:ins/w:del 修订标记呈现；false = 直接改原文（无修订标记） */
  const [trackMode, setTrackMode] = useState(true);

  // AI 编辑态：选中文字后即弹出编辑浮层
  const [aiSel, setAiSel] = useState<{
    quote: string; top: number; left: number; crossPara: boolean;
    hlRects: Array<{ top: number; left: number; width: number; height: number }>;
  } | null>(null);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [revising, setRevising] = useState(false);

  // @审核报告：选 homework 下的审核报告 → AI 解析成 ops → 逐条修订
  const [auditBusy, setAuditBusy] = useState(false);
  const [reportList, setReportList] = useState<Array<{ name: string; path: string; mtime: number }>>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attachedReport, setAttachedReport] = useState<{ name: string; path: string } | null>(null);
  /** 整篇 AI 修订：工具栏按钮弹报告选择下拉（不依赖选中文字，直接按报告整篇修订） */
  const [reportPickerOpen, setReportPickerOpen] = useState(false);
  const reportPickerRef = useRef<HTMLDivElement>(null);
  /** 下拉内已选中的报告：先选中高亮，再点「执行整篇修订」确认，增加仪式感 */
  const [selectedReport, setSelectedReport] = useState<{ name: string; path: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  // 转 Markdown 进行中（一键转 MD 按钮）
  const [converting, setConverting] = useState(false);
  /** 外部程序打开进行中（Open 图标按钮 loading 反馈） */
  const [opening, setOpening] = useState(false);

  // 修订计划（chatnode 提交 → 轮询 → 自动逐条应用）
  const appliedVersionRef = useRef(0);
  const applyingPlanRef = useRef(false);
  const [planProgress, setPlanProgress] = useState<PlanProgress | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // ---- 缩放与页码（CSS zoom 缩放布局尺寸，滚动条自动适配；页码用 IntersectionObserver 统计当前页） ----
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const changeZoom = useCallback((z: number) => {
    const clamped = Math.min(2, Math.max(0.5, Math.round(z * 100) / 100));
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);

  /** 适应宽度：页面宽度已由 CSS 强制撑满面板（section width:100%），没有固定页宽需要对齐，
   *  等价于恢复 100% 缩放（避免按旧公式反复点击不断缩小） */
  const fitWidth = useCallback(() => {
    changeZoom(1);
  }, [changeZoom]);

  /** 适应整页：宽/高两个方向都塞进可视区 */
  const fitPage = useCallback(() => {
    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (!scroller || !container) return;
    const z = zoomRef.current;
    const page = container.querySelector('section.docx');
    const baseW = page
      ? page.getBoundingClientRect().width / z
      : container.scrollWidth / Math.max(z, 0.01);
    const baseH = page
      ? page.getBoundingClientRect().height / z
      : container.scrollHeight / Math.max(z, 0.01);
    if (baseW <= 0 || baseH <= 0) return;
    changeZoom(Math.min((scroller.clientWidth - 72) / baseW, (scroller.clientHeight - 72) / baseH));
  }, [changeZoom]);

  // 渲染完成后数页数；分页变化时重建当前页监听
  useEffect(() => {
    if (totalPages < 2) return;
    const scroller = scrollRef.current;
    const pages = containerRef.current?.querySelectorAll<HTMLElement>('section.docx');
    if (!scroller || !pages || pages.length === 0) return;
    setCurrentPage(1);
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const idx = Array.prototype.indexOf.call(pages, e.target);
          if (idx >= 0) setCurrentPage(idx + 1);
        }
      }
    }, { root: scroller, threshold: [0.05, 0.4, 0.7] });
    pages.forEach((p) => io.observe(p));
    return () => io.disconnect();
  }, [totalPages, docxBase64]);

  // ---- 正文修订处 ↔ 侧边栏双向联动 ----
  const [activeRevId, setActiveRevId] = useState<string | null>(null);
  /** revision id → 正文中对应 <ins>/<del> DOM 节点（docx-preview 渲染后按文本+类型匹配重建） */
  const revisionDomMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const revisionsRef = useRef<RevisionItem[]>(revisions);
  useEffect(() => { revisionsRef.current = revisions; }, [revisions]);
  const panelListRef = useRef<HTMLDivElement>(null);

  /** 命令式高亮正文某个修订节点（清除旧高亮后加 class） */
  const highlightDocNode = useCallback((el: HTMLElement) => {
    revisionDomMapRef.current.forEach((n) => n.classList.remove('rev-active'));
    el.classList.add('rev-active');
  }, []);

  /** 渲染后重建 id→DOM 映射：按文档顺序扫描 ins/del，与非 mark 修订按文本+类型匹配 */
  const buildRevisionDomMap = useCallback(() => {
    const container = containerRef.current;
    const map = new Map<string, HTMLElement>();
    if (container) {
      const nodes = Array.from(container.querySelectorAll<HTMLElement>('ins, del'));
      const usable = revisionsRef.current.filter((r) => !r.kind.includes('mark'));
      let ni = 0;
      for (const r of usable) {
        const wantIns = r.kind.startsWith('insert');
        while (ni < nodes.length) {
          const el = nodes[ni];
          if ((el.tagName === 'INS') === wantIns) {
            const t = (el.textContent || '').trim();
            const rt = (r.text || '').trim();
            // 文本可能被 docx-preview 拆分/合并，做包含匹配兜底
            if (!rt || t === rt || (rt && (t.includes(rt) || rt.includes(t)))) {
              map.set(r.id, el);
              ni += 1;
              break;
            }
          }
          ni += 1;
        }
      }
    }
    revisionDomMapRef.current = map;
  }, []);

  /** 点击正文修订处 → 高亮 + 联动侧边栏滚动到对应条目 */
  const onDocClick = useCallback((e: React.MouseEvent) => {
    // 拖选文字时不联动（避免与 AI 浮层抢占）
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>('ins, del');
    if (!target) { setActiveRevId(null); return; }
    const map = revisionDomMapRef.current;
    let matched: string | null = null;
    map.forEach((el, id) => { if (el === target) matched = id; });
    if (!matched) return;
    highlightDocNode(target);
    setActiveRevId(matched);
    const itemEl = panelListRef.current?.querySelector(`[data-rev-id="${matched}"]`);
    itemEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlightDocNode]);

  /** 点击侧边栏条目 → 正文滚动到对应修订处 + 高亮 */
  const jumpToRevision = useCallback((id: string) => {
    const el = revisionDomMapRef.current.get(id);
    setActiveRevId(id);
    if (el) {
      highlightDocNode(el);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlightDocNode]);

  /** 快捷动作：一键指令（英文 UI，交给模型执行对应改写） */
  const QUICK_ACTIONS: Array<{ id: string; label: string; instruction: string }> = [
    { id: 'polish', label: 'Polish', instruction: '润色改写（保持原意，提升表达质量，使表述更专业流畅）' },
    { id: 'shorten', label: 'Shorten', instruction: '精简压缩（删去冗余，保留关键信息，保持原意）' },
    { id: 'expand', label: 'Expand', instruction: '扩写补充（结合上下文展开细节，保持原意与语气）' },
    { id: 'translate', label: 'Translate', instruction: '翻译成英文（保持原意，专业正式语气）' },
    { id: 'fix', label: 'Fix', instruction: '修正错别字与事实表述错误（结合上下文修正，保持原意）' },
  ];

  /** 用 docx base64 渲染到容器 */
  const renderDocx = useCallback(async (base64: string) => {
    const container = containerRef.current;
    if (!container) return;
    const scroller = scrollRef.current;
    // 保存滚动位置：渲染后恢复，避免 AI 修改重渲染后跳回第一页
    const savedScrollTop = scroller?.scrollTop ?? 0;
    // 备份旧渲染：失败时恢复，避免文档区空白（AI 修改生成的 docx 偶发不可渲染时仍保留上一次内容）
    const backup = container.innerHTML;
    container.innerHTML = '';
    try {
      const { renderAsync } = await import('docx-preview');
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await renderAsync(new Blob([bytes]), container, styleRef.current as HTMLElement, {
        className: 'docx',
        inWrapper: true,
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: true,
        // 渲染修订标记（w:ins → <ins>，w:del → <del>）；默认 false 会把插入当普通文本、删除内容直接吞掉
        renderChanges: true,
      });
      // 渲染成功：恢复滚动位置（rAF 等布局落定后再设，避免被重排重置）
      if (scroller) requestAnimationFrame(() => { scroller.scrollTop = savedScrollTop; });
      // 重建修订映射，供正文↔侧边栏双向联动
      buildRevisionDomMap();
      // 统计页数（docx-preview 分页模式下每页一个 section.docx）
      const pageCount = container.querySelectorAll('section.docx').length;
      setTotalPages(pageCount);
      setCurrentPage(pageCount > 0 ? 1 : 0);
    } catch (e) {
      // 渲染失败：恢复旧 DOM 与滚动位置，避免空白/跳顶；并提示错误
      container.innerHTML = backup;
      if (scroller) scroller.scrollTop = savedScrollTop;
      onErrorRef.current(e instanceof Error ? e.message : 'Word 渲染失败');
    }
  }, [buildRevisionDomMap]);

  /** 打开文件：fetch → 解析 → docx-preview 渲染 + mammoth 转 md + inspect 修订 */
  const openDoc = useCallback(async () => {
    if (!proxyUrl) return;
    setLoading(true);
    setUnsupported(null);
    try {
      const resp = await fetch(proxyUrl, { cache: 'no-store' });
      const mtimeHeader = resp.headers.get('X-File-Mtime');
      const buf = await resp.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 8));
      const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
      if (!isZip) {
        const isOle = head.length >= 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
        setUnsupported(isOle ? 'legacy-doc' : 'corrupted');
        setLoading(false);
        return;
      }
      const base64 = arrayBufferToBase64(buf);
      setDocxBase64(base64);
      setOriginalMtime(mtimeHeader ? Number(mtimeHeader) : null);
      setDirty(false);
      setSavedPath(null);
      setWriteBlocked(null);
      wroteOriginalRef.current = false;
      // docx → md（AI 改写上下文；含 Word 真实多级编号注入，失败自动回退原始转换）
      try {
        const md = await convertDocxToMarkdown(buf);
        setMdText(md);
      } catch { setMdText(null); }
      await renderDocx(base64);
      // inspect：已有修订的文档 → 载入修订列表（2026-09-12 不再自动弹出右侧修订面板，需用户点工具栏「修订面板」按钮手动展开）
      try {
        const r = await fetch('/api/docx/revise', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'inspect', docxBase64: base64 }),
        });
        const data = (await r.json()) as ReviseResponse;
        if (data.ok && data.revisions) {
          setRevisions(data.revisions);
        }
      } catch { /* ignore */ }
    } catch (e) {
      onErrorRef.current(e instanceof Error ? e.message : 'Word 文档加载失败');
    } finally {
      setLoading(false);
    }
  }, [proxyUrl, renderDocx]);

  useEffect(() => { void openDoc(); }, [openDoc]);

  // ---- AI 编辑：选中文字即弹出浮层 ----
  const onContainerMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    const container = containerRef.current;
    const scroller = scrollRef.current;
    if (!container || !scroller || !container.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const crossPara = text.includes('\n');
    // 高亮层按选区逐行 client rects 生成：跨行时外接矩形会盖住整行，逐行拆分才精确贴合
    const hlRects = Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({
        top: r.top - scrollerRect.top + scroller.scrollTop,
        left: r.left - scrollerRect.left + scroller.scrollLeft,
        width: r.width,
        height: r.height,
      }));
    // 浮层用 clamp 后的坐标（防右/下出界）
    const rawLeft = rect.left - scrollerRect.left + scroller.scrollLeft;
    setAiSel({
      quote: crossPara ? text.replace(/\s+/g, ' ') : text,
      top: Math.min(rect.bottom - scrollerRect.top + scroller.scrollTop + 8, scroller.scrollHeight - 48),
      left: Math.min(rawLeft, scroller.clientWidth - 340),
      hlRects,
      crossPara,
    });
    setAiInstruction('');
    // 清除原生选区：高亮视觉由持久层接管（同色无缝过渡），避免浮层聚焦后原生选区失焦变灰、或与持久层叠加导致两态不一致
    sel.removeAllRanges();
  }, []);

  /** 点击容器空白处关闭浮层（浮层内 mousedown 已 stopPropagation） */
  const onContainerMouseDown = useCallback(() => {
    setAiSel(null);
  }, []);

  /** 滚动时关闭浮层（位置不再跟随） */
  const onContainerScroll = useCallback(() => {
    setAiSel(null);
  }, []);

  /** 核心落修订：把 newText 作为修订（del 选中文字 + ins 新文） */
  const applyRevise = useCallback(async (newText: string) => {
    // 允许空文本：留空即纯删除（new="" → 后端只生成 w:del，不生成 w:ins）
    if (!aiSel || aiSel.crossPara || !docxBase64 || aiBusy) return false;
    const clean = newText.trim();
    const isDelete = !clean;
    const pendingQuote = aiSel.quote;
    setAiBusy(true);
    try {
      const reviseResp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'apply',
          docxBase64,
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
      setDocxBase64(data.docxBase64);
      setRevisions(data.revisions || []);
      setActiveRevId(null);
      setDirty(true);
      setPanelOpen(true);
      setAiSel(null);
      setAiInstruction('');
      await renderDocx(data.docxBase64);
      return true;
    } catch (e) {
      onErrorRef.current(e instanceof Error ? e.message : 'AI 修订失败');
      return false;
    } finally {
      setAiBusy(false);
    }
  }, [aiSel, docxBase64, aiBusy, trackMode, renderDocx]);

  // ===== 修订计划（chatnode → 编辑器自动逐条应用） =====
  /** 按编辑器 Track Changes 开关映射 op 类型（修订 ↔ 直接改） */
  const toPlainType = useCallback((type: string): string => {
    const map: Record<string, string> = {
      replace_text: 'replace_text_plain',
      replace_paragraph: 'replace_paragraph_plain',
      insert_paragraph_after: 'insert_paragraph_after_plain',
      replace_table_cell: 'replace_table_cell_plain',
    };
    return trackMode ? (map[type] ? type : type.replace(/_plain$/, '')) : (map[type] || type);
  }, [trackMode]);

  /** 应用单条计划 op：调 /api/docx/revise → 更新 docx + 重渲染 + 修订面板；返回是否成功 */
  const applyPlanOp = useCallback(async (op: PlanOp): Promise<boolean> => {
    if (!docxBase64) return false;
    try {
      const resp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'apply',
          docxBase64,
          author: 'BobWork',
          ops: [{ ...op, type: toPlainType(op.type) }],
        }),
      });
      const data = (await resp.json()) as ReviseResponse;
      if (!data.ok || !data.docxBase64) throw new Error(data.error || 'apply failed');
      const result = data.results?.[0];
      if (result && !result.ok) throw new Error(result.error || '定位失败');
      setDocxBase64(data.docxBase64);
      setRevisions(data.revisions || []);
      setDirty(true);
      await renderDocx(data.docxBase64);
      return true;
    } catch {
      return false; // 失败静默进 failed 列表，不打断整体
    }
  }, [docxBase64, toPlainType, renderDocx]);

  /** 逐条应用整个计划（自动执行，每条应用后重渲染并短暂停顿突出"AI 在改"） */
  const runPlan = useCallback(async (plan: PlanFile) => {
    if (applyingPlanRef.current) return;
    applyingPlanRef.current = true;
    appliedVersionRef.current = plan.version;
    setPlanProgress({ version: plan.version, total: plan.ops.length, done: 0, failed: [] });
    const failed: string[] = [];
    for (let i = 0; i < plan.ops.length; i++) {
      const op = plan.ops[i];
      const ok = await applyPlanOp(op);
      if (!ok) failed.push(op.label || `op #${i + 1}`);
      setPlanProgress((s) => (s ? { ...s, done: i + 1, failed } : s));
      // 逐条渲染节奏：停顿让用户看到每处修订出现
      await new Promise((r) => setTimeout(r, 600));
    }
    applyingPlanRef.current = false;
    setTimeout(() => setPlanProgress(null), 6000);
  }, [applyPlanOp]);

  /** 拉取 homework 下的审核报告列表（按时间倒序） */
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

  /** 选定审核报告 → 读报告文本 → 调 AI 解析成 ops → 构造计划逐条应用 */
  const pickReport = useCallback(async (reportPath: string) => {
    if (applyingPlanRef.current || auditBusy) return;
    setAuditBusy(true);
    setPanelOpen(true);
    setPlanProgress({ version: 0, total: 0, done: 0, failed: [] });
    try {
      // 1. 读报告文本
      const rResp = await fetch(`/api/local-files?action=read_file&path=${encodeURIComponent(reportPath)}`);
      if (!rResp.ok) throw new Error('读取审核报告失败');
      const rData = await rResp.json();
      const reportText = String(rData.content ?? '');
      if (!reportText.trim()) throw new Error('审核报告为空');

      // 2. AI 解析成 ops（docText 用 mammoth md，供 AI 定位 anchor）
      setPlanProgress((s) => s ? { ...s, total: -1 } : s); // -1 表示解析中
      const aResp = await fetch('/api/docx/audit-revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docText: mdText || '', reportText, trackChanges: trackMode }),
      });
      const aData = await aResp.json();
      if (!aData.ok) throw new Error(aData.error || 'AI 解析审核报告失败');
      const ops = Array.isArray(aData.ops) ? aData.ops : [];
      if (ops.length === 0) throw new Error('AI 未生成任何修订操作');

      // 3. 构造计划逐条应用（复用 runPlan）
      const plan = { docxPath: fileInfo.full_path, version: Date.now(), trackChanges: trackMode, createdAt: new Date().toISOString(), ops } as PlanFile;
      setAuditBusy(false);
      await runPlan(plan);
    } catch (e) {
      onErrorRef.current(e instanceof Error ? e.message : String(e));
      setPlanProgress(null);
    } finally {
      setAuditBusy(false);
    }
  }, [mdText, trackMode, fileInfo.full_path, runPlan, auditBusy]);

  /** 打开整篇修订报告选择器（懒加载报告列表，打开时重置选中） */
  const toggleReportPicker = useCallback(() => {
    setReportPickerOpen((v) => {
      const next = !v;
      if (next) {
        if (reportList.length === 0) void fetchReports();
        setSelectedReport(null);
      }
      return next;
    });
  }, [reportList.length, fetchReports]);

  /** 确认执行：选中的报告 → 整篇修订（复用 pickReport，不依赖选中文字） */
  const confirmRunReport = useCallback(() => {
    if (!selectedReport) return;
    setReportPickerOpen(false);
    setSelectedReport(null);
    void pickReport(selectedReport.path);
  }, [selectedReport, pickReport]);

  // 点击外部关闭报告选择下拉（同时清空选中）
  useEffect(() => {
    if (!reportPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (reportPickerRef.current && !reportPickerRef.current.contains(e.target as Node)) {
        setReportPickerOpen(false);
        setSelectedReport(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [reportPickerOpen]);

  /** 按钮 1 · 直接替换：输入框内容原样作为新文本落修订（不调 AI） */
  const replaceDirect = useCallback(async () => {
    // 留空 + Enter = 纯删除选中文字
    if (!aiSel || aiSel.crossPara || aiBusy) return;
    await applyRevise(aiInstruction);
  }, [aiSel, aiInstruction, aiBusy, applyRevise]);

  /** 输入框 @ 唤起报告提及：检测光标前 @query，打开下拉并按需拉取报告列表 */
  const onInstructionChange = useCallback((v: string) => {
    setAiInstruction(v);
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/@([^\s@]*)$/);
    if (m) {
      setMentionOpen(true);
      setMentionQuery(m[1]);
      setMentionIndex(0);
      if (reportList.length === 0) void fetchReports();
    } else {
      setMentionOpen(false);
    }
  }, [fetchReports, reportList.length]);

  /** 选中提及的报告 → 移除 @query 文本，挂载报告 chip */
  const selectMention = useCallback((r: { name: string; path: string }) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? aiInstruction.length;
    const before = aiInstruction.slice(0, caret);
    const m = before.match(/@([^\s@]*)$/);
    const stripped = m ? before.slice(0, m.index) : before;
    setAiInstruction((stripped + aiInstruction.slice(caret)).trim());
    setAttachedReport({ name: r.name, path: r.path });
    setMentionOpen(false);
  }, [aiInstruction]);

  /** 提交：挂了报告 chip → 按报告驱动整篇修订；否则直接替换/删除选区 */
  const submitInstruction = useCallback(async () => {
    if (attachedReport) {
      const p = attachedReport.path;
      setAttachedReport(null);
      setAiSel(null);
      setAiInstruction('');
      await pickReport(p);
      return;
    }
    await replaceDirect();
  }, [attachedReport, pickReport, replaceDirect]);

  /** 按钮 2 · AI 修改：AI 按指令生成文本 → 直接落修订（无需确认） */
  const runAiDirect = useCallback(async (instructionOverride?: string) => {
    const instruction = (instructionOverride ?? aiInstruction).trim();
    if (!aiSel || aiSel.crossPara || !instruction || aiBusy) return;
    setAiBusy(true);
    try {
      const editResp = await fetch('/api/ai-edit/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md: mdText || '', instruction, mode: 'inline', selection: { text: aiSel.quote } }),
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
      onErrorRef.current(e instanceof Error ? e.message : 'AI 修改失败');
      setAiBusy(false);
    }
  }, [aiSel, aiInstruction, mdText, aiBusy, applyRevise]);

  /** 按钮 3 · 生成草稿到输入框：AI 按指令生成 → 回填输入框，用户可改后 Enter 落修订 */
  const runAiDraftToInput = useCallback(async () => {
    const instruction = aiInstruction.trim();
    if (!aiSel || aiSel.crossPara || !instruction || aiBusy) return;
    setAiBusy(true);
    try {
      const editResp = await fetch('/api/ai-edit/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md: mdText || '', instruction, mode: 'inline', selection: { text: aiSel.quote } }),
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
      // 回填输入框（替换指令文本），用户可直接 Enter 或修改后 Enter
      setAiInstruction(text.trim());
    } catch (e) {
      onErrorRef.current(e instanceof Error ? e.message : 'AI 草稿生成失败');
    } finally {
      setAiBusy(false);
    }
  }, [aiSel, aiInstruction, mdText, aiBusy]);

  /** 快捷动作：填入预设指令到输入框（不自动执行，由用户点击 AI edit 触发） */
  const runQuickAction = useCallback((instruction: string) => {
    if (!aiSel || aiSel.crossPara) return;
    setAiInstruction(instruction);
  }, [aiSel]);

  /** 接受/拒绝修订（decisions 空 = 全部） */
  const resolveRevisions = useCallback(async (decisions: Array<{ id: string; accept: boolean }>, acceptAll?: boolean) => {
    if (!docxBase64 || revising) return;
    setRevising(true);
    try {
      let decisionsPayload = decisions;
      if (acceptAll !== undefined) {
        decisionsPayload = (revisions.length ? revisions : []).map((r) => ({ id: r.id, accept: acceptAll }));
      }
      const resp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'resolve', docxBase64, decisions: decisionsPayload }),
      });
      const data = (await resp.json()) as ReviseResponse;
      if (!data.ok || !data.docxBase64) throw new Error(data.error || '接受/拒绝失败');
      setDocxBase64(data.docxBase64);
      setRevisions(data.revisions || []);
      setDirty(true);
      await renderDocx(data.docxBase64);
    } catch (e) {
      onErrorRef.current(e instanceof Error ? e.message : '修订处理失败');
    } finally {
      setRevising(false);
    }
  }, [docxBase64, revisions, revising, renderDocx]);

  /** 保存：本地原稿（有 full_path 与打开时刻 mtime 哨兵）→ 直接写回原稿，不生成修订稿；仅会话首次写回前在 homework 备份。
   *  冲突（WPS/Word 锁文件、原稿被外部修改等）→ 可见提示并暂停自动直写（writeBlocked），修订保留在页面不丢失。
   *  非本地原稿（无路径/无 mtime 哨兵）→ 退回 homework 时间戳修订稿通道（会话内复用同名）。
   *  silent=true 为自动保存 */
  const handleSave = useCallback(async (silent = false): Promise<{ path: string | null; mtime: number | null } | null> => {
    if (!docxBase64 || saving) return null;
    const name = fileInfo.name || fileInfo.full_path?.split('/').pop();
    if (!name) {
      if (!silent) onErrorRef.current('无文件名，无法保存');
      return null;
    }
    const writeOriginal = Boolean(fileInfo.full_path) && originalMtime !== null;
    setSaving(true);
    try {
      if (writeOriginal && fileInfo.full_path) {
        const resp = await fetch('/api/local-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save_to_original', path: fileInfo.full_path, content: docxBase64,
            expectedMtime: originalMtime, backup: !wroteOriginalRef.current,
          }),
        });
        const data = (await resp.json()) as {
          success?: boolean; conflict?: 'locked' | 'modified'; currentMtime?: number;
          error?: string; path?: string; mtime?: number; backup?: string | null;
        };
        if (!data.success) {
          // 直写失败一律可见提示（不静默丢失）；置 writeBlocked 暂停自动重试，待用户处理
          const msg = data.conflict === 'locked'
            ? '检测到 Word/WPS 的锁文件，原稿可能正被 Office 打开，本次未写回（修订仍保留在页面中，不会丢失）。\n\n请先关闭 WPS/Word 中的该文档，再点「保存」重试。'
            : data.conflict === 'modified'
              ? '原稿在打开后已被外部程序修改，为防覆盖外部修改，本次未写回（修订仍保留在页面中）。\n\n如需采用磁盘上的最新版，请点「Reload」恢复（将放弃当前修订）。'
              : (data.error || '写回原稿失败');
          setWriteBlocked(msg);
          window.alert(msg);
          return null;
        }
        // 成功：哨兵 mtime 同步为写回后的值，解除冲突暂停态
        setWriteBlocked(null);
        wroteOriginalRef.current = true;
        setDirty(false);
        const result = { path: data.path ?? fileInfo.full_path, mtime: data.mtime ?? null };
        setSavedPath(result.path);
        setSavedMtime(result.mtime);
        setOriginalMtime(result.mtime);
        window.dispatchEvent(new CustomEvent('local-files-changed'));
        return result;
      }
      // 兜底：非本地原稿（无绝对路径/无 mtime 哨兵）→ homework 修订稿通道（保持旧行为）
      if (!revisedNameRef.current) revisedNameRef.current = makeRevisedName(name);
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_to_homework', filename: revisedNameRef.current, content: docxBase64, encoding: 'base64' }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string; path?: string; mtime?: number };
      if (!data.success) throw new Error(data.error || '保存失败');
      setDirty(false);
      const result = { path: data.path ?? null, mtime: data.mtime ?? null };
      setSavedPath(result.path);
      setSavedMtime(result.mtime);
      window.dispatchEvent(new CustomEvent('local-files-changed'));
      return result;
    } catch (e) {
      if (!silent) onErrorRef.current(e instanceof Error ? e.message : '保存失败');
      return null;
    } finally {
      setSaving(false);
    }
  }, [docxBase64, saving, fileInfo.name, fileInfo.full_path, originalMtime]);

  const reloadOriginal = useCallback(() => {
    setDirty(false);
    setRevisions([]);
    setSavedPath(null);
    setSavedMtime(null);
    revisedNameRef.current = null;
    void openDoc();
  }, [openDoc]);

  /** 一键「接受全部修订并立即更新原稿」：内存全部接受 → save_to_original 严格冲突防护写回（锁文件/mtime 哨兵/首次备份/原子写）。
   *  与「保存」走同一直写通道；区别在于本按钮一次性接受全部修订并立即写回（不走 2.5s 自动保存防抖） */
  const handleAcceptAllToOriginal = useCallback(async () => {
    if (!docxBase64 || revising || saving) return;
    const targetPath = fileInfo.full_path;
    if (!targetPath || originalMtime === null) {
      onErrorRef.current('未获取到原稿路径或打开时刻（可能不是本地原稿），无法写回原稿');
      return;
    }
    if (revisions.length === 0) {
      window.alert('当前没有待处理的修订。');
      return;
    }
    if (!window.confirm(`将接受全部 ${revisions.length} 处修订，并立即更新原稿：\n${targetPath}\n\n${wroteOriginalRef.current ? '本会话首次写回前已自动备份，本次不再重复备份。' : '写回前会自动在 homework 目录留一份「回写前备份」（每会话仅首次）。'}是否继续？`)) return;
    setRevising(true);
    try {
      // 第一步：内存中全部接受（复用 resolve 通道，拿到定稿 docx 与刷新后的修订清单）
      const decisions = revisions.map((r) => ({ id: r.id, accept: true }));
      const resp = await fetch('/api/docx/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'resolve', docxBase64, decisions }),
      });
      const data = (await resp.json()) as ReviseResponse;
      if (!data.ok || !data.docxBase64) throw new Error(data.error || '接受修订失败');
      // 第二步：冲突防护写回原稿（expectedMtime 为打开时刻哨兵；仅会话首次写回前备份）
      const wResp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_to_original', path: targetPath, content: data.docxBase64, expectedMtime: originalMtime, backup: !wroteOriginalRef.current }),
      });
      const wData = (await wResp.json()) as {
        success?: boolean; conflict?: 'locked' | 'modified'; currentMtime?: number;
        error?: string; path?: string; mtime?: number; backup?: string | null;
      };
      if (!wData.success) {
        if (wData.conflict === 'locked') {
          window.alert('检测到 Word/WPS 的锁文件，文档可能正被 Office 程序打开，本次未写回。\n\n请先在 WPS/Word 中关闭该文档，再回到这里重试。\n（若确认没有程序在使用，可手动删除原稿同目录下以 ~$ 开头的临时文件）');
          return;
        }
        if (wData.conflict === 'modified') {
          const restore = window.confirm(`原稿在打开后已被外部程序修改过（可能是 WPS 保存过），为防覆盖外部修改，本次未写回。\n\n「确定」= 放弃当前修订，重新加载磁盘上的最新原稿\n「取消」= 保留当前修订在页面中（不写入磁盘）`);
          if (restore) reloadOriginal();
          return;
        }
        throw new Error(wData.error || '更新原稿失败');
      }
      // 成功：界面同步为原稿定稿态；不置 dirty，避免自动保存再写回一次相同内容
      setDocxBase64(data.docxBase64);
      setRevisions(data.revisions || []);
      setDirty(false);
      wroteOriginalRef.current = true;
      setWriteBlocked(null);
      setSavedPath(wData.path ?? targetPath);
      setSavedMtime(wData.mtime ?? null);
      setOriginalMtime(wData.mtime ?? null);
      window.dispatchEvent(new CustomEvent('local-files-changed'));
      window.alert(wData.backup ? `原稿已更新，写回前备份：\n${wData.backup}` : '原稿已更新。');
    } catch (e) {
      onErrorRef.current(e instanceof Error ? e.message : '更新原稿失败');
    } finally {
      setRevising(false);
    }
  }, [docxBase64, revisions, revising, saving, fileInfo.full_path, originalMtime, reloadOriginal]);

  // ---- 外部打开：先把最新修订落盘，再复制临时副本交系统程序打开 ----
  // WPS/Word 的保存/自动备份只会写到临时副本，物理隔离防止改写 homework 修订版或附件原文；
  // 打开前比对 mtime：文件在保存后被外部程序改写过（修订标记可能已被剥掉）则先确认
  const handleOpenExternal = useCallback(async () => {
    if (!savedPath && !fileInfo.full_path) return;
    if (opening) return;
    setOpening(true);
    try {
      // 本会话尚未保存过：直接以原稿路径为打开对象（磁盘原文即当前内容，无需落盘）
      let target = savedPath;
      let baseMtime = savedMtime;
      if (!target && fileInfo.full_path) {
        target = fileInfo.full_path;
        baseMtime = originalMtime;
      }
      // 存在未保存修订：先落盘再打开（保存被冲突阻止时中断，避免打开过时副本）
      if (dirty && !saving) {
        const saved = await handleSave();
        if (!saved?.path) return;
        target = saved.path;
        baseMtime = saved.mtime;
      }
      if (!target) {
        onErrorRef.current('无法用外部程序打开：没有可打开的本地文件路径');
        return;
      }
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open_external_copy', path: target }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string; tempPath?: string; mtime?: number };
      if (!data.success || !data.tempPath) throw new Error(data.error || '打开失败');
      if (baseMtime && data.mtime && Math.abs(data.mtime - baseMtime) > 1000) {
        if (!window.confirm('该文件在保存后已被外部程序（可能是 WPS）修改过，修订标记可能已丢失。仍要打开副本查看吗？')) return;
      }
      const opened = await desktop.openFile(data.tempPath);
      if (!opened?.success) throw new Error(opened?.error || '打开失败');
    } catch (e) {
      onErrorRef.current(e instanceof Error ? e.message : '打开失败');
    } finally {
      setOpening(false);
    }
  }, [dirty, saving, handleSave, savedPath, savedMtime, originalMtime, fileInfo.full_path, opening]);

  // ---- 一键转 Markdown：把当前文档（含已应用的修订）转成 .md 存入 homework，并发布 file.open 在 md 编辑器中打开 ----
  // mammoth 对 w:ins 内正文照常输出、忽略 w:del 的 delText，转出内容等价于「接受全部修订」后的文本；
  // 每次点击都从当前 docx 重新转换（mdText 是打开时的旧快照，不含后续修订）
  const handleConvertToMd = useCallback(async () => {
    if (!docxBase64 || converting) return;
    const name = fileInfo.name || fileInfo.full_path?.split('/').pop();
    if (!name) {
      onErrorRef.current('无文件名，无法转换');
      return;
    }
    setConverting(true);
    try {
      const res = await convertDocxToMarkdown(base64ToArrayBuffer(docxBase64));
      const mdName = makeMdName(name);
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_to_homework', filename: mdName, content: res, encoding: 'utf-8' }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string; path?: string };
      if (!data.success || !data.path) throw new Error(data.error || '转换失败');
      window.dispatchEvent(new CustomEvent('local-files-changed'));
      // 发布 file.open：CanvasFlow 开标签 → UnifiedViewer 按 md 分发到 DocEditor（source=local 可编辑可保存）
      bus.publish(BusEvents.fileOpen, { source: 'local', path: data.path, name: mdName });
    } catch (e) {
      onErrorRef.current(e instanceof Error ? e.message : '转换失败');
    } finally {
      setConverting(false);
    }
  }, [docxBase64, converting, fileInfo.name, fileInfo.full_path]);

  // ---- 自动保存：dirty 变 true 后 debounce 2.5s 自动写回（本地原稿直写 / homework 兜底）；
  //      写回被冲突阻止（writeBlocked）后暂停自动重试，避免弹窗循环，待用户处理后手动「保存」恢复 ----
  useEffect(() => {
    if (!dirty || writeBlocked) return;
    const timer = setTimeout(() => { void handleSave(true); }, 2500);
    return () => clearTimeout(timer);
  }, [dirty, writeBlocked, handleSave]);

  // ---- 视图切换 CSS ----
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;
    const styleId = 'docx-view-style';
    let style = container.querySelector<HTMLStyleElement>(`#${styleId}`);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      container.appendChild(style);
    }
    const css = `
      .docx, .docx * { -webkit-user-select: text !important; user-select: text !important; }
      /* 选区高亮统一色：拖选（::selection）与编辑面板弹出后的持久层（.ai-sel-hl）共用同一半透明品牌紫，保证两态视觉一致 */
      .docx *::selection { background-color: color-mix(in oklab, var(--primary) 25%, transparent) !important; }
      .docx *::-moz-selection { background-color: color-mix(in oklab, var(--primary) 25%, transparent) !important; }
      .ai-sel-hl { background-color: color-mix(in oklab, var(--primary) 25%, transparent); border-radius: 2px; }
      /* 页面视觉：覆盖 docx-preview 默认灰色背景/厚重阴影，浅色衬托 + 柔和纸感阴影（多页纵向留白） */
      /* 2026-09-12 与 md 正文顶部留白对齐：每页上边距压到 32px（原为 Word 页边距，约 96px），wrapper 上内边距归零 */
      /* 2026-09-12 平铺预览面板：wrapper 左右内边距归零；页面宽度覆盖 docx-preview 写死的 inline width（Word 固定页宽），
         改为撑满面板宽度，左右留白由 section 自身的页边距（padding-left/right）承担 */
      .docx-wrapper { background: transparent !important; padding: 0 0 4px !important; }
      .docx-wrapper > section.docx { width: 100% !important; max-width: 100% !important; padding-top: 32px !important; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 4px 16px rgba(0, 0, 0, 0.07) !important; border-radius: 2px !important; margin-bottom: 26px !important; }
      /* 修订标记：docx-preview 渲染为原生 <ins>/<del> 标签（renderChanges:true） */
      .docx ins { border-bottom: 2px solid #4b3fe3; color: #4b3fe3; text-decoration: none; }
      .docx del { color: #c00000; text-decoration: line-through; }
      /* 联动高亮：点击正文修订处/侧边栏条目时标记当前修订 */
      .docx .rev-active { outline: 2px solid var(--primary); outline-offset: 1px; background-color: color-mix(in oklab, var(--primary) 15%, transparent); border-radius: 2px; }
      ${view === 'none' ? `.docx del { display: none; } .docx ins { border-bottom: none; color: inherit; text-decoration: none; }` : ''}
      ${view === 'original' ? `.docx ins { display: none; } .docx del { text-decoration: none; color: inherit; }` : ''}
    `;
    style.textContent = css;
  }, [view]);

  const docName = fileName || fileInfo.name;

  // ---- 工具栏 ----
  const toolbar = (
    <div
      className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b px-4 py-2"
      style={{ borderColor: 'var(--line)', backgroundColor: '#fff' }}
    >
      <span className="truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>{docName}</span>
      <span className="truncate text-xs" style={{ color: 'var(--ink-muted)' }} title={writeBlocked ?? savedPath ?? undefined}>
        {writeBlocked
          ? 'Write blocked'
          : dirty
            ? (saving ? (originalMtime !== null ? 'Auto-saving to original…' : 'Auto-saving to homework…') : 'Unsaved revisions')
            : savedPath
              ? (originalMtime !== null ? 'Saved to original' : 'Saved to homework')
              : revisions.length > 0 ? `${revisions.length} revision(s)` : 'Read-only preview'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {/* 视图切换 */}
        <div className="relative inline-flex items-center">
          <Eye className="pointer-events-none absolute left-2 h-3 w-3" style={{ color: 'var(--ink-muted)' }} />
          <select
            value={view}
            onChange={(e) => setView(e.target.value as ViewMode)}
            className="appearance-none rounded-md border py-1.5 pl-7 pr-6 text-xs font-medium"
            style={{ borderColor: 'var(--line)', color: 'var(--ink)', backgroundColor: 'var(--popover)' }}
            title="Revision view mode"
          >
            {(Object.keys(VIEW_LABELS) as ViewMode[]).map((v) => (
              <option key={v} value={v}>{VIEW_LABELS[v]}</option>
            ))}
          </select>
        </div>
        {/* 修订模式开关：on=修改以修订标记呈现；off=直接改原文 */}
        <button
          onClick={() => setTrackMode(!trackMode)}
          aria-pressed={trackMode}
          aria-label={trackMode ? 'Turn track changes off' : 'Turn track changes on'}
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          style={trackMode
            ? { backgroundColor: 'var(--primary)', color: '#fff' }
            : { backgroundColor: 'color-mix(in oklab, var(--popover) 92%, transparent)', color: 'var(--ink-muted)', border: '1px solid var(--line)' }}
          title={trackMode ? 'Track Changes ON — edits become revisions (w:ins/w:del)' : 'Track Changes OFF — edits modify the text directly'}
        >
          <GitCompareArrows className="h-3.5 w-3.5" />
        </button>
        {/* 整篇 AI 修订：选报告 → 全篇按报告逐条落修订（不依赖选中文字） */}
        <div ref={reportPickerRef} className="relative">
          <button
            onClick={toggleReportPicker}
            disabled={auditBusy}
            aria-label="AI whole-document revision"
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-50"
            style={reportPickerOpen
              ? { backgroundColor: 'var(--primary)', color: '#fff' }
              : { backgroundColor: 'color-mix(in oklab, var(--popover) 92%, transparent)', color: 'var(--primary-strong)', border: '1px solid color-mix(in oklab, var(--primary) 35%, transparent)' }}
            title="AI whole-document revision — pick an audit report; AI applies every item to the whole document"
          >
            {auditBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          </button>
          {reportPickerOpen && (
            <div
              className="absolute right-0 top-full z-30 mt-1 w-[280px] overflow-hidden rounded-md border shadow-lg"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--popover)' }}
            >
              <div className="max-h-[240px] overflow-y-auto ai-canvas-scroll py-1">
                {reportList.length === 0 ? (
                  <p className="px-3 py-3 text-xs" style={{ color: 'var(--ink-muted)' }}>暂无审核报告（homework 下无报告 .md）</p>
                ) : (
                  reportList.map((r) => {
                    const active = selectedReport?.path === r.path;
                    return (
                      <button
                        key={r.path}
                        onClick={() => setSelectedReport(r)}
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_10%,transparent)]"
                        style={{ backgroundColor: active ? 'color-mix(in oklab, var(--primary) 12%, transparent)' : 'transparent' }}
                      >
                        <FileDiff className="h-3 w-3 shrink-0" style={{ color: 'var(--primary)' }} />
                        <span className="min-w-0 flex-1 truncate text-11 font-medium" style={{ color: 'var(--ink)' }}>{r.name}</span>
                        {active && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--primary-strong)' }} />}
                        <span className="shrink-0 text-9" style={{ color: 'var(--ink-muted)' }}>
                          {new Date(r.mtime).toLocaleDateString()}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              {/* 确认执行（仪式感）：选中报告后出现执行按钮 */}
              <div className="border-t px-2 py-2" style={{ borderColor: 'var(--line)' }}>
                <button
                  onClick={confirmRunReport}
                  disabled={!selectedReport}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-40"
                  style={{ backgroundColor: 'var(--primary)' }}
                >
                  <Sparkles className="h-3 w-3" /> 执行整篇修订
                </button>
              </div>
            </div>
          )}
        </div>
        {/* 页码 */}
        {totalPages > 1 && (
          <span className="text-xs tabular-nums" style={{ color: 'var(--ink-muted)' }}>
            {currentPage} / {totalPages}
          </span>
        )}
        {/* 缩放：缩小 / 百分比(点击归 100%) / 放大 / 适应宽度 / 适应整页 */}
          <div className="flex items-center gap-0.5 rounded-md border" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--popover)' }}>
            <Button
              onClick={() => changeZoom(zoom - 0.1)}
              disabled={zoom <= 0.5}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <button
              onClick={() => changeZoom(1)}
              className="min-w-10 px-1 text-center text-11 font-medium tabular-nums hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]"
              style={{ color: 'var(--ink)' }}
              title="Reset to 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              onClick={() => changeZoom(zoom + 0.1)}
              disabled={zoom >= 2}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
            <Button
              onClick={fitWidth}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Fit width"
              aria-label="Fit width"
            >
              <Maximize className="h-3.5 w-3.5" />
            </Button>
            <Button
              onClick={fitPage}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Fit whole page"
              aria-label="Fit whole page"
            >
              <Frame className="h-3.5 w-3.5" />
            </Button>
          </div>
        {/* 修订面板 */}
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          aria-pressed={panelOpen}
          aria-label="Toggle revision panel"
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          style={panelOpen
            ? { backgroundColor: 'var(--primary)', color: '#fff' }
            : { backgroundColor: 'color-mix(in oklab, var(--popover) 92%, transparent)', color: 'var(--ink)', border: '1px solid var(--line)' }}
          title={`Revisions${revisions.length > 0 ? ` (${revisions.length})` : ''} — show/hide revision panel`}
        >
          <FileDiff className="h-3.5 w-3.5" />
        </button>
        {/* 保存 */}
        <button
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          aria-label="Save revisions"
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-50"
          style={{ backgroundColor: dirty ? 'var(--primary)' : 'var(--line)', color: dirty ? '#fff' : 'var(--ink-muted)' }}
          title="Save revisions to homework (auto-saved on changes)"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        </button>
        {(fileInfo.full_path || savedPath) && (
          <Button
            onClick={() => void handleOpenExternal()}
            disabled={opening}
            variant="outline"
            tone="info"
            size="icon"
            aria-label="Open in external program"
            title="Open a temp copy with local default program (WPS saves won't touch the revised file)"
          >
            {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
          </Button>
        )}
        <Button
          onClick={() => void handleConvertToMd()}
          disabled={!docxBase64 || converting}
          loading={converting}
          variant="outline"
          tone="success"
          size="icon"
          aria-label="Convert to Markdown"
          title="Convert to Markdown (with applied revisions), save to homework and open in the MD editor"
        >
          {converting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
        </Button>
        {/* 放弃当前修订并重新载入原稿（破坏性，置于操作末尾防误触） */}
        <Button
          onClick={reloadOriginal}
          variant="ghost"
          tone="neutral"
          size="icon"
          aria-label="Reload original file"
          title="Reload original file (discard unsaved revisions)"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );

  // ---- 修订面板 ----
  const revisionPanel = panelOpen && (
    <div
      className="flex w-72 shrink-0 flex-col border-l"
      style={{ borderColor: 'var(--line)', backgroundColor: 'var(--popover)' }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>Revisions ({revisions.length})</span>
        <div className="flex items-center gap-1">
          {revisions.length > 0 && (
            <Button
              onClick={handleAcceptAllToOriginal}
              disabled={revising || saving}
              loading={revising}
              variant="solid"
              tone="brand"
              size="xs"
              title="接受全部修订并立即写回原稿（会话首次写回前自动备份；检测到 WPS/Word 打开或原稿被外部修改时会阻止）"
            >
              {revising ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} 更新原稿
            </Button>
          )}
          <Button onClick={() => setPanelOpen(false)} variant="ghost" tone="neutral" size="icon-sm" aria-label="Close panel">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div ref={panelListRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2 ai-canvas-scroll">
        {revisions.length === 0 && (
          <p className="px-2 py-3 text-xs" style={{ color: 'var(--ink-muted)' }}>No revisions yet. Use AI Edit to create tracked changes.</p>
        )}
        {revisions.map((r) => {
          // 字段规范化：后端某条 revision 若 kind/text/author 缺失，避免 .startsWith 渲染期抛错白屏
          const kind = String(r.kind ?? '');
          const text = String(r.text ?? '');
          const author = String(r.author ?? '');
          const isIns = kind.startsWith('insert');
          const isMark = kind.includes('mark');
          const active = activeRevId === r.id;
          return (
          <div
            key={r.id}
            data-rev-id={r.id}
            onClick={() => jumpToRevision(r.id)}
            className="mb-1.5 cursor-pointer rounded-md border px-2.5 py-2 transition-colors"
            style={{
              borderColor: active ? 'var(--primary)' : 'var(--line)',
              backgroundColor: active ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : undefined,
              boxShadow: active ? '0 0 0 1px var(--primary)' : undefined,
            }}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <span
                className="rounded px-1 py-px text-10 font-semibold uppercase"
                style={{
                  backgroundColor: isIns ? 'color-mix(in oklab, var(--primary) 14%, transparent)' : 'color-mix(in oklab, #c00000 12%, transparent)',
                  color: isIns ? 'var(--primary-strong)' : '#c00000',
                }}
              >
                {isIns ? (isMark ? 'Insert ¶' : 'Insert') : (isMark ? 'Delete ¶' : 'Delete')}
              </span>
              <span className="truncate text-10" style={{ color: 'var(--ink-muted)' }}>{author}</span>
            </div>
            <p
              className="mb-1.5 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed"
              style={{
                color: isIns ? 'var(--ink)' : '#c00000',
                textDecoration: kind.startsWith('delete') ? 'line-through' : 'underline',
              }}
            >
              {text || '（新增段落）'}
            </p>
            <div className="flex gap-1">
              <Button
                onClick={() => void resolveRevisions([{ id: r.id, accept: true }])}
                variant="outline"
                tone="neutral"
                size="xs"
                className="flex-1"
              >
                <Check className="h-3 w-3" /> Accept
              </Button>
              <Button
                onClick={() => void resolveRevisions([{ id: r.id, accept: false }])}
                variant="outline"
                tone="neutral"
                size="xs"
                className="flex-1"
              >
                <X className="h-3 w-3" /> Reject
              </Button>
            </div>
          </div>
          );
        })}
      </div>
      {revisions.length > 0 && (
        <div className="flex gap-1.5 border-t px-2 py-2" style={{ borderColor: 'var(--line)' }}>
          <Button
            onClick={() => void resolveRevisions([], true)}
            disabled={revising}
            variant="solid"
            tone="brand"
            size="sm"
            className="flex-1"
          >
            Accept All
          </Button>
          <Button
            onClick={() => void resolveRevisions([], false)}
            disabled={revising}
            variant="outline"
            tone="neutral"
            size="sm"
            className="flex-1"
          >
            Reject All
          </Button>
        </div>
      )}
    </div>
  );

  // ---- AI 编辑浮层（选中文字即弹出） ----
  const mentionList = reportList.filter((r) => r.name.toLowerCase().includes(mentionQuery.toLowerCase()));
  const aiPanel = aiSel && (
    <div
      className="absolute z-20 w-[340px] rounded-lg border px-3 py-2"
      style={{
        top: aiSel.top,
        left: aiSel.left,
        borderColor: 'var(--primary)',
        backgroundColor: 'var(--popover)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Wand2 className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary-strong)' }} />
        <span className="shrink-0 text-11 font-semibold" style={{ color: 'var(--primary-strong)' }}>AI Edit</span>
        <span className="truncate text-11" style={{ color: 'var(--ink-muted)' }}>“{aiSel.quote.slice(0, 30)}{aiSel.quote.length > 30 ? '…' : ''}”</span>
        <button
          onClick={() => { setAiSel(null); setAiInstruction(''); }}
          className="ml-auto shrink-0 rounded p-0.5 hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]"
          style={{ color: 'var(--ink-muted)' }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {aiSel.crossPara ? (
        <p className="text-11" style={{ color: '#c00000' }}>Selection spans multiple paragraphs; please select text within a single paragraph.</p>
      ) : (
        <>
          {/* 快捷动作：填入预设指令（不自动执行）；末位 Draft = AI 改写输入框内提示词 */}
          <div className="mb-1.5 flex flex-wrap gap-1">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.id}
                onClick={() => runQuickAction(a.instruction)}
                disabled={aiBusy}
                className="rounded-full border px-2 py-0.5 text-11 font-medium transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] disabled:opacity-50"
                style={{ borderColor: 'color-mix(in oklab, var(--primary) 35%, transparent)', color: 'var(--primary-strong)' }}
              >
                {a.label}
              </button>
            ))}
            <button
              onClick={() => void runAiDraftToInput()}
              disabled={aiBusy || !aiInstruction.trim()}
              className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-11 font-medium transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] disabled:opacity-50"
              style={{ borderColor: 'color-mix(in oklab, var(--primary) 35%, transparent)', color: 'var(--primary-strong)' }}
              title="AI draft — rewrite result into the input, then Enter (or edit) to apply"
            >
              <Wand2 className="h-3 w-3" />
              Draft
            </button>
          </div>
          {/* 已挂载的审核报告 chip（类 chatnode 附件） */}
          {attachedReport && (
            <div className="mb-1.5 flex items-center gap-1.5">
              <span
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-11 font-medium"
                style={{
                  borderColor: 'color-mix(in oklab, var(--primary) 35%, transparent)',
                  color: 'var(--primary-strong)',
                  backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                }}
              >
                <FileDiff className="h-3 w-3" />
                <span className="max-w-[200px] truncate">{attachedReport.name}</span>
                <button onClick={() => setAttachedReport(null)} className="ml-0.5 rounded-full hover:opacity-70" title="移除报告">
                  <X className="h-3 w-3" />
                </button>
              </span>
              <span className="text-10" style={{ color: 'var(--ink-muted)' }}>Enter = apply revisions from this report</span>
            </div>
          )}
          {/* 输入框（两行） */}
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={aiInstruction}
              onChange={(e) => onInstructionChange(e.target.value)}
              onKeyDown={(e) => {
                const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                if (mentionOpen && mentionList.length > 0) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionList.length); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionList.length) % mentionList.length); return; }
                  if ((e.key === 'Enter' || e.key === 'Tab') && !composing) { e.preventDefault(); selectMention(mentionList[Math.min(mentionIndex, mentionList.length - 1)]); return; }
                  if (e.key === 'Escape') { setMentionOpen(false); return; }
                }
                if (e.key === 'Enter' && !e.shiftKey && !composing) { e.preventDefault(); void submitInstruction(); }
              }}
              placeholder="Type replacement text…"
              rows={2}
              className="w-full resize-none rounded-md border py-1.5 pl-2 pr-2 text-xs leading-relaxed outline-none"
              style={{ borderColor: 'var(--line)', color: 'var(--ink)', backgroundColor: 'var(--paper)' }}
              autoFocus
            />
            {/* @ 提及下拉：homework 审核报告列表，↑↓ 导航 / Enter 选中 / Esc 关闭 */}
            {mentionOpen && mentionList.length > 0 && (
              <div
                className="absolute left-0 top-full z-30 mt-1 max-h-[180px] w-[280px] overflow-y-auto rounded-md border py-1 shadow-lg ai-canvas-scroll"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--popover)' }}
              >
                {mentionList.map((r, i) => (
                  <button
                    key={r.path}
                    onMouseDown={(e) => { e.preventDefault(); selectMention(r); }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
                    style={{ backgroundColor: i === mentionIndex ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent' }}
                  >
                    <FileDiff className="h-3 w-3 shrink-0" style={{ color: 'var(--primary)' }} />
                    <span className="min-w-0 flex-1 truncate text-11 font-medium" style={{ color: 'var(--ink)' }}>{r.name}</span>
                    <span className="shrink-0 text-9" style={{ color: 'var(--ink-muted)' }}>
                      {new Date(r.mtime).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 操作按钮：输入框下方一行 */}
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              onClick={() => void replaceDirect()}
              disabled={aiBusy}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40"
              style={{ backgroundColor: !aiBusy ? 'var(--primary)' : 'var(--line)', color: !aiBusy ? '#fff' : 'var(--ink-muted)' }}
              title="Direct replace / delete — Enter to apply (empty input = delete selection)"
            >
              <Replace className="h-3 w-3" />
            </button>
            <button
              onClick={() => void runAiDirect()}
              disabled={aiBusy || !aiInstruction.trim()}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40"
              style={{ backgroundColor: aiInstruction.trim() && !aiBusy ? 'var(--primary)' : 'var(--line)', color: aiInstruction.trim() && !aiBusy ? '#fff' : 'var(--ink-muted)' }}
              title="AI edit — rewrite with AI per instruction, apply directly"
            >
              {aiBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {toolbar}
      {/* 修订计划应用进度（chatnode 提交 → 自动逐条应用） */}
      {planProgress && (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
          style={{ borderColor: 'var(--line)', backgroundColor: 'color-mix(in oklab, var(--primary) 8%, var(--paper))' }}
        >
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: 'var(--primary)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>
            {planProgress.total === -1
              ? 'Analyzing audit report…'
              : planProgress.total === 0
                ? 'Reading audit report…'
                : `AI applying revision plan: ${planProgress.done}/${planProgress.total}`}
          </span>
          {planProgress.failed.length > 0 && (
            <span className="min-w-0 truncate text-11" style={{ color: '#c00000' }}>
              Failed: {planProgress.failed.join(', ')}
            </span>
          )}
          {planProgress.total > 0 && planProgress.done === planProgress.total && planProgress.failed.length === 0 && (
            <span className="shrink-0 text-11 font-medium" style={{ color: 'var(--success)' }}>
              All revisions applied — review & save
            </span>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="relative min-w-0 flex-1 overflow-auto ai-canvas-scroll hide-scrollbar"
          onMouseUp={onContainerMouseUp}
          onMouseDown={onContainerMouseDown}
          onScroll={onContainerScroll}
          style={{ backgroundColor: '#fff' }}
        >
          {/* 不限宽：页面宽度已由上方 CSS 撑满面板，无横向滚动；wrapper 自带居中 */}
          {/* 2026-09-12 与 md 正文顶部留白对齐：顶部内边距归零，使「滚动区顶 → 首行文字」= wrapper 0 + 此处 0 + 页面上边距 32px */}
          {/* 2026-09-12 平铺预览面板：去掉左右内边距，页面左右边缘与面板对齐 */}
          <div className="pb-1">
            {loading && (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: 'var(--info)' }} />
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Rendering Word document...</span>
              </div>
            )}
            {unsupported && (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <p className="text-sm" style={{ color: 'var(--ink)' }}>
                  {unsupported === 'legacy-doc' ? 'This is a legacy .doc file (Word 97-2003), inline preview is not supported' : 'File is corrupted or not a valid Word document'}
                </p>
                {fileInfo.full_path && (
                  <button
                    onClick={() => desktop.openFile(fileInfo.full_path!)}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-colors"
                    style={{ backgroundColor: 'var(--info)', color: '#fff' }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open with default program
                  </button>
                )}
              </div>
            )}
            <div ref={containerRef} onClick={onDocClick} style={{ zoom }} />
            <div ref={styleRef} className="hidden" />
          </div>
          {/* 持久高亮层：按选区逐行 rects 渲染，独立于浏览器选区，浮层在则持续高亮选中文字 */}
          {aiSel && aiSel.hlRects.map((r, i) => (
            <div
              key={i}
              className="ai-sel-hl pointer-events-none absolute z-10"
              style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
            />
          ))}
          {aiPanel}
        </div>
        {revisionPanel}
      </div>
    </div>
  );
}

/** ArrayBuffer → base64 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → ArrayBuffer（一键转 MD：把当前 docxBase64 还原给 mammoth 转换） */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
