'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Loader2, Wand2, Check, X, Plus, Copy, AtSign, Paperclip,
  Square, Paintbrush, Eraser, Square as FillAllIcon, FlipVertical2, CircleOff,
  ChevronDown, ChevronRight, SplitSquareVertical, HelpCircle, ScanSearch, Layers,
} from 'lucide-react';
import { loadSettings, getImageModelCandidates } from '@/lib/settings';
import {
  setImageAiEditKeepAlive,
  isImageAiEditHidden,
  showImageAiEditToast,
} from '@/lib/image-ai-edit-runtime';
import type { RegionRef, TriplotProgress } from '@/lib/types';

/**
 * 图片 AI 编辑覆盖层（与 ImageAnnotator 对称的 z-30 模式）
 *
 *  - 三种 Mask 工具：Rect（矩形框选）/ Brush（笔刷涂抹）/ Eraser（橡皮擦除）+ 反选/全选/清除
 *  - Document Retouch 风格预设 Pill 一键注入专业修复 prompt 前缀 + Negative Prompt 可折叠
 *  - 单一流程：无工作图时文生图；上传/生成图片后自动成为工作底图，输入框直接继续编辑（图生图）
 *  - 指令驱动调用 /api/ai-edit/image（OpenAI 兼容 images.edits）或 /api/ai-generate/image
 *  - 生成结果自动提升为当前工作图，无预览态、无模式切换，可反复迭代
 *  - 底部 Compare 滑块：对比「上一版 vs 当前版」做像素级前后差分，关闭即回到当前图
 *  - 可「另存为副本」：写入同目录新文件，不覆盖原图
 */

interface ImageAiEditorProps {
  /** 当前工作图 dataUrl（作为图生图底图；文生图首次生成前可为空） */
  src?: string;
  fileName: string;
  /** 是否允许文生图（imageGen 节点内嵌时开启；查看器保持纯图生图） */
  allowGenerate?: boolean;
  /** 当前工作图变化回调（上传/继续编辑/新建时通知父级持久化；null=无图=文生图态） */
  onImageChange?: (dataUrl: string | null) => void;
  /**
   * 生成结果（或当前工作图）保存到磁盘的回调。
   * 方案 C+ 下内建 UI 无手动 Save 入口；仅保留外部扩展接口 & 生成成功时通过 onImageChange 落盘
   */
  onSave: (dataUrl: string) => void;
  onSaveAsCopy: (dataUrl: string) => void;
  /** 点击右上角关闭按钮（X）的回调；节点内嵌场景下一般为 no-op。 */
  onCancel: () => void;
  /**
   * 方案 C+：隐藏内建底栏（Prompt 输入栏），底栏挪为节点 Portal 浮条
   *  → true：ImageAiEditor 只负责"图片预览 / 工具栏 / 文生图占位 / 上传图片"，不含输入控件
   *  → false：保留之前的内建底栏（兼容 Viewer 旧用法，默认 false 以不破坏其他调用方）
   */
  hideBottomBar?: boolean;
  /**
   * 方案 B：节点选中态传入——true=展开底部输入框（用户选中该节点=进入工作态）
   * false=纯观赏模式，隐藏输入框（含已生成的图片时），文生图态（无图）仍显示底部输入
   */
  isSelected?: boolean;
  /** 隐藏顶部工具栏的 "?" 帮助按钮（ImageGen 节点内嵌时用，避免与节点自身 UI 重复） */
  hideHelp?: boolean;
  /** VLM 识别结果（Auto-Locate），由父级持久化传入，叠加可点击高亮框 */
  regions?: RegionRef[];
  /** 当前选中的区域 id（点击高亮框 toggle；父级维护） */
  selectedRegions?: string[];
  /** 点击 Detect All 按钮（父级发起全景识别并持久化结果） */
  onDetectAll?: () => void;
  /** 全景识别请求进行中（父级状态） */
  detectAllLoading?: boolean;
  /** 点击高亮框 toggle 选中（父级更新 selectedRegions） */
  onToggleRegion?: (id: string) => void;
  /** 一键清除识别结果（父级清空 regions/selectedRegions） */
  onClearRegions?: () => void;
}

/** 三视图结果：front / side / top 三张图 dataUrl + 对应完整 prompt */
export interface TriplotResult {
  front: { image: string; prompt: string };
  side: { image: string; prompt: string };
  top: { image: string; prompt: string };
}

/**
 * 外部 Prompt Bar 可调用的编辑器 API：只暴露"用外部传入上下文触发生成"的能力。
 */
export interface ImageGenApiRef {
  /** 用外部 Prompt Bar 提供的上下文触发一次文生图或图生图请求（取决当前是否已有 curImg 工作图） */
  runGenerate: (ctx: ImageGenPromptCtx) => Promise<{ ok: boolean; image?: string; error?: string }>;
  /** 三视图生成：串行 3 次调用（front→side→top），side/top 以已生成图为参考保证一致性；
   *  onProgress 每步完成前（当前视角开始生成时）被调用，父级用于显示进度 UI */
  runTriplotGenerate: (ctx: ImageGenPromptCtx, onProgress?: (p: TriplotProgress) => void) => Promise<{ ok: boolean; triplot?: TriplotResult; error?: string }>;
  /** 探活：外部 Prompt Bar 可以据此显示"文生图 / 图生图"占位文字 */
  getWorkingImage: () => string | null;
  /** 把外部 Prompt Bar 上传的附件池同步到编辑器内部（作为图生图的参考图集 references 字段） */
  setAttachments: (attachments: AttachmentImage[]) => void;
  /** 用两张指定图片启动 Compare 滑块对比（复用编辑器已有的 compare slider） */
  startCompare: (imgA: string, imgB: string) => void;
}
export interface ImageGenPromptCtx {
  prompt: string;
  negative?: string;
  size: string;
  model?: string;
  attachments?: AttachmentImage[];
}
export interface AttachmentImage {
  id: string;
  name: string;
  dataUrl: string;
}

interface Selection {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Mode = 'edit' | 'generating';
type MaskTool = 'rect' | 'brush' | 'eraser';

/** 下拉菜单锚点屏幕坐标 */
type DRect = { top: number; left: number; right: number; bottom: number; width: number; height: number };

/** 自定义 Hook：下拉菜单打开时同步锚点 DOM 的屏幕 rect（ResizeObserver + resize + rAF 轮询，阈值 0.5px 防抖） */
function useSyncAnchorRect(
  active: boolean,
  ref: React.RefObject<HTMLElement | null>,
  setter: (r: DRect | ((prev: DRect | null) => DRect | null)) => void,
) {
  useLayoutEffect(() => {
    if (!active) return;
    const compute = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setter((prev: DRect | null) => {
        if (prev &&
          Math.abs(prev.top - r.top) < 0.5 &&
          Math.abs(prev.left - r.left) < 0.5 &&
          Math.abs(prev.width - r.width) < 0.5 &&
          Math.abs(prev.height - r.height) < 0.5) {
          return prev;
        }
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      });
    };
    compute();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    if (ro && ref.current) ro.observe(ref.current);
    window.addEventListener('resize', compute);
    let rafId = 0;
    let lastTime = 0;
    const loop = (t: number) => {
      if (t - lastTime >= 150) { compute(); lastTime = t; }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', compute);
      cancelAnimationFrame(rafId);
    };
  }, [active, ref, setter]);
}

/** 风格预设：点击后把前缀注入指令框。Document Retouch 是法律场景核心预设 */
export const STYLE_PRESETS: Array<{
  id: string;
  label: string;
  /** 以 "tag" — " 作为分隔，后面拼用户指令 */
  prefix: string;
  /** 默认 negative prompt 会自动注入（不展示在输入框内，独立存储） */
  defaultNegative?: string;
  tone: 'brand' | 'accent' | 'warn' | 'ok' | 'neutral';
}> = [
  {
    id: 'doc-retouch',
    label: '📄 Document Retouch',
    prefix:
      '[Document Retouch] Professional document restoration: remove shadows, stains, coffee rings, straighten curved or skewed pages, erase handwritten margin notes, boost typed text contrast, deskew, uniform pure white background. DO NOT alter any typed text, signatures, official seals, or numbers. — ',
    defaultNegative:
      'blurry text, altered characters, missing strokes, watermark, distortion, warped signature, changed numbers, missing text, overexposed seals, color bleed, artifacts',
    tone: 'brand',
  },
  {
    id: 'legal-exhibit',
    label: '⚖️ Clean Exhibit',
    prefix:
      '[Clean Exhibit] Clean up legal exhibit photo: remove glare, remove red-eye, correct white balance, sharpen details, keep all original text and marks readable. DO NOT add or remove any content. — ',
    defaultNegative:
      'added content, removed content, altered text, altered signature, altered seal, watermark, artifacts, oversaturated',
    tone: 'accent',
  },
  {
    id: 'photo-enhance',
    label: '🖼 Photo Enhance',
    prefix:
      '[Photo Enhance] Professional photo refinement: gently improve lighting, fix under/over exposure, improve skin tones naturally, preserve original composition and all objects. — ',
    defaultNegative: 'plastic skin, over-smooth, altered objects, watermark, oversaturated, hdr halo',
    tone: 'warn',
  },
  {
    id: 'custom',
    label: '+ Custom prompt…',
    prefix: '',
    tone: 'neutral',
  },
];

/** 文生图比例预设：label 为输入框内显示的比例标签，size 为对应像素尺寸 */
export const RATIO_PRESETS: Array<{ label: string; size: string }> = [
  { label: '1:1', size: '1024x1024' },
  { label: '4:3', size: '1024x768' },
  { label: '3:4', size: '768x1024' },
  { label: '3:2', size: '1536x1024' },
  { label: '2:3', size: '1024x1536' },
  { label: '16:9', size: '2688x1536' },
  { label: '9:16', size: '1536x2688' },
];

const TONE_STYLES: Record<string, React.CSSProperties> = {
  brand:   { backgroundColor: 'rgba(96,84,241,0.14)', color: '#cfd8ff', borderColor: 'rgba(96,84,241,0.38)' },
  accent:  { backgroundColor: 'rgba(39,210,191,0.12)', color: '#5eead4', borderColor: 'rgba(39,210,191,0.38)' },
  warn:    { backgroundColor: 'rgba(239,170,23,0.14)', color: '#fcd34d', borderColor: 'rgba(239,170,23,0.42)' },
  ok:      { backgroundColor: 'rgba(29,201,129,0.12)', color: '#6ee7b7', borderColor: 'rgba(29,201,129,0.40)' },
  neutral: { backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.75)', borderColor: 'rgba(255,255,255,0.18)' },
};

/** Usage-guide rows for the help panel (all English) */
const HELP_TOOL_ROWS: Array<{ Icon: React.ComponentType<{ className?: string }>; name: string; desc: string }> = [
  { Icon: Square,       name: 'Rect',       desc: 'Click and drag to draw a rectangular edit area.' },
  { Icon: Paintbrush,   name: 'Brush',      desc: 'Paint directly on the image to mark the exact area to edit.' },
  { Icon: Eraser,       name: 'Eraser',     desc: 'Erase parts of the mask you marked by mistake.' },
  { Icon: FillAllIcon,  name: 'Select all', desc: 'Mark the entire image as the edit region.' },
  { Icon: FlipVertical2, name: 'Invert',    desc: 'Swap the edit region and the keep region.' },
  { Icon: CircleOff,    name: 'Clear',      desc: 'Remove all mask markings and start over.' },
];

/** 附件图片：通过「添加附件」从本地任意文件夹上传，作为 @ 的候选与参考图来源。
 *  dataUrl 在读取后恒定存在（无需再异步加载）。 */
interface AttachedImage {
  id: string;
  name: string;
  dataUrl: string;
}

export const ImageAiEditor = forwardRef<ImageGenApiRef, ImageAiEditorProps>(function ImageAiEditor({ src, fileName, allowGenerate, onImageChange, onSave, onSaveAsCopy, onCancel, hideBottomBar = false, isSelected = true, hideHelp = false, regions = [], selectedRegions = [], onDetectAll, detectAllLoading = false, onToggleRegion, onClearRegions }, ref) {
  const imgRef = useRef<HTMLImageElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 从空白态上传一张图作为工作底图（开始图生图） */
  const baseFileInputRef = useRef<HTMLInputElement>(null);

  const [instruction, setInstruction] = useState('');
  /** 区域列表面板展开态（Detect All 识别结果较多时，用列表精确点选） */
  const [regionsOpen, setRegionsOpen] = useState(false);
  /** 当前 hover 的区域 id（列表行 ↔ 图上高亮框双向联动；非 null 时其余框淡化） */
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null);
  /** 遮罩工具（Rect/Brush/Eraser）折叠态：默认收起，Detect All/Regions/Clear 常驻 */
  const [maskToolsOpen, setMaskToolsOpen] = useState(false);
  /** 遮罩工具下拉菜单：锚点按钮 ref + 屏幕坐标（portal 定位用） */
  const maskMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  const [maskMenuRect, setMaskMenuRect] = useState<DRect | null>(null);
  useSyncAnchorRect(maskToolsOpen, maskMenuBtnRef, setMaskMenuRect);
  const portal = useMemo(() => (typeof document === 'undefined' ? null : document.body), []);
  /** 编辑区尺寸变化的 tick：触发高亮框重算（object-fit 内容矩形依赖元素盒尺寸，缩放/展开时需刷新） */
  const [, setBoxTick] = useState(0);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    let raf = 0;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setBoxTick((t) => t + 1));
    }) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); };
  }, []);
  const [negativePrompt, setNegativePrompt] = useState('');
  const [negativeOpen, setNegativeOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /** 当前工作图：null=无图（文生图态）；非 null=图生图底图 */
  const [curImg, setCurImg] = useState<string | null>(src ?? null);
  /** 派生模式：有图=edit（图生图），无图=generate（文生图）——单一流程，文生图与编辑自动衔接 */
  const aiMode: 'edit' | 'generate' = curImg ? 'edit' : 'generate';
  /** 文生图输出尺寸（仅无图、从文本出图时使用） */
  const [genSize, setGenSize] = useState('1024x1024');
  /** 文生图比例标签（驱动 genSize，同时显示在输入框内） */
  const [ratio, setRatio] = useState('1:1');

  /** 选中比例预设：同步比例标签与像素尺寸 */
  const handleRatioSelect = useCallback((label: string, size: string) => {
    setRatio(label);
    setGenSize(size);
  }, []);

  /** 从本地文件设定工作底图（用于空白态“上传图片开始编辑”） */
  const handleBaseImageFile = useCallback((file: File) => {
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setCurImg(reader.result);
        setPrevImg(null);
        setCompareOpen(false);
        setMode('edit');
        onImageChange?.(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }, [onImageChange]);

  // ===== 附件图片 + 参考图片 @ =====
  /** 已添加的附件（本地上传图片池），@ 的候选来源 */
  const [attachments, setAttachments] = useState<AttachedImage[]>([]);
  /** 已 @ 选中的参考图片（标签展示；生成时作为 references 传入） */
  const [refImages, setRefImages] = useState<AttachedImage[]>([]);
  const [refIds, setRefIds] = useState<Set<string>>(new Set());
  /** @ 弹窗状态 */
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionAtPos, setMentionAtPos] = useState(-1);

  // ===== Model selection =====
  /** 下拉候选：Settings 里已选的模型列表；为空则降级为默认模型单选项 */
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  /** 当前编辑器选中的模型（'' = 跟随 Settings 默认） */
  const [currentModel, setCurrentModel] = useState<string>('');

  // 加载并填充 Image Edit 模型下拉候选；Settings 保存后（provider-configs-changed）自动刷新。
  // 共用 getImageModelCandidates：imageEdit 默认/角色池/chips + Model Pool 图像绑定（本地无鉴权厂商兜底）
  const loadImageEditModels = useCallback(() => {
    let cancelled = false;
    loadSettings().then((settings) => {
      if (cancelled) return;
      const candidates = getImageModelCandidates(settings);
      setModelCandidates(candidates);
      setCurrentModel((prev) => {
        if (prev && candidates.includes(prev)) return prev;
        return candidates[0] ?? '';
      });
    }).catch(() => { /* 设置加载失败时静默降级为无候选 */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const cancel = loadImageEditModels();
    const handler = () => loadImageEditModels();
    window.addEventListener('provider-configs-changed', handler);
    window.addEventListener('app-config-changed', handler);
    return () => {
      cancel?.();
      window.removeEventListener('provider-configs-changed', handler);
      window.removeEventListener('app-config-changed', handler);
    };
  }, [loadImageEditModels]);

  // ===== 附件图片：读取上传文件为 dataUrl 后加入附件池 =====
  const addFilesAsAttachments = useCallback((files: File[]) => {
    for (const file of files) {
      if (!/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name) && !/^image\//.test(file.type)) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') return;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setAttachments((prev) => [...prev, { id, name: file.name, dataUrl: reader.result as string }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  /** 移除附件：同时从附件池与参考图（若是 @ 引用）中剔除 */
  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setRefImages((prev) => prev.filter((r) => r.id !== id));
    setRefIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
  }, []);

  // 点击外部关闭 @ 弹窗
  useEffect(() => {
    if (!mentionOpen) return;
    const onDown = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) setMentionOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [mentionOpen]);

  /** 检测指令输入中的 @ 触发词（不要求前导空格：紧跟任意字符输入 @ 也触发） */
  const detectMention = useCallback((value: string) => {
    const m = value.match(/@([^@\s]*)$/);
    if (m && m.index !== undefined) {
      setMentionAtPos(value.lastIndexOf('@'));
      setMentionQuery(m[1]);
      setMentionIndex(0);
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
      setMentionAtPos(-1);
      setMentionQuery('');
    }
  }, []);

  /** 选择 @ 命中的附件：移除输入中的 @查询 文字，加入参考图标签（多选；dataUrl 已就绪） */
  const handleMentionSelect = useCallback((file: AttachedImage) => {
    if (mentionAtPos < 0) return;
    const beforeAt = instruction.slice(0, mentionAtPos);
    const afterQuery = instruction.slice(mentionAtPos + 1 + mentionQuery.length);
    setInstruction(`${beforeAt}${afterQuery}`);
    setMentionOpen(false);
    if (!refIds.has(file.id)) {
      setRefIds((prev) => new Set(prev).add(file.id));
      setRefImages((prev) => [...prev, file]);
    }
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [mentionAtPos, mentionQuery, instruction, refIds]);

  /** 移除参考图标签（仅解除 @ 引用，附件仍保留在池中） */
  const removeRefImage = useCallback((id: string) => {
    setRefImages((prev) => prev.filter((r) => r.id !== id));
    setRefIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
  }, []);

  /** @ 候选列表：按查询词过滤已添加附件 */
  const mentionFiltered = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    return attachments.filter((a) => a.name.toLowerCase().includes(q));
  }, [attachments, mentionQuery]);
  const [maskTool, setMaskTool] = useState<MaskTool>('rect');
  const [brushSize, setBrushSize] = useState(18); // display px
  /** 矩形选区（仅 rect 工具使用） */
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * Brush / eraser 工具使用一张 display 尺寸的 overlay canvas 画笔画痕迹；
   * buildMask 时先全白，再把 overlay 上笔画对应的自然尺寸区域 clear（透明 = 编辑区）；
   * 橡皮擦 = 反向绘制（恢复区域为白色不透明 = 保留）
   */
  const brushOverlayRef = useRef<HTMLCanvasElement | null>(null);
  /** 最近一次笔刷落点，用于画笔连续线段（避免快速移动断成点） */
  const lastBrushPosRef = useRef<{ x: number; y: number } | null>(null);

  // ===== Mode state =====
  const [mode, setMode] = useState<Mode>('edit');
  const [error, setError] = useState<string | null>(null);

  // ===== Previous-version compare =====
  /** 上一版快照：生成成功时缓存旧图，用于「上一版 vs 当前版」滑块对比（不会进入预览态） */
  const [prevImg, setPrevImg] = useState<string | null>(null);
  /** 对比面板开关 */
  const [compareOpen, setCompareOpen] = useState(false);
  /** 分割线位置 0..100 (%)，拖动做前后差分 */
  const [sliderX, setSliderX] = useState(50);
  const sliderDragRef = useRef(false);
  const sliderAreaRef = useRef<HTMLDivElement | null>(null);

  /** 指针位置 → 相对图片显示坐标（含边界夹紧） */
  const getPos = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    const clientX = 'clientX' in e ? e.clientX : 0;
    const clientY = 'clientY' in e ? e.clientY : 0;
    return {
      x: Math.max(0, Math.min(clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(clientY - rect.top, rect.height)),
    };
  }, []);

  /** 事件隔离：防止 pointer 事件冒泡到 yarl zoom / lightbox 或主画布 */
  const stopEvent = (e: React.PointerEvent | React.UIEvent) => {
    e.stopPropagation();
  };

  // ==================================================================
  // Mask: Rect tool handlers (legacy + active when maskTool==='rect')
  // ==================================================================
  const handleRectDown = useCallback((e: React.PointerEvent) => {
    if (mode !== 'edit' || maskTool !== 'rect') return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelection(null);
    setDragStart(getPos(e));
    setDragging(true);
  }, [mode, maskTool, getPos]);

  const handleRectMove = useCallback((e: React.PointerEvent) => {
    if (!dragging || !dragStart || maskTool !== 'rect') return;
    const p = getPos(e);
    setSelection({
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    });
  }, [dragging, dragStart, maskTool, getPos]);

  const endDrag = useCallback(() => {
    setDragging(false);
    setDragStart(null);
    lastBrushPosRef.current = null;
  }, []);

  // ==================================================================
  // Mask: Brush / Eraser — 用 overlay canvas 绘制
  // ==================================================================
  const ensureBrushOverlay = useCallback(() => {
    const img = imgRef.current;
    if (!img) return null;
    let overlay = brushOverlayRef.current;
    const rect = img.getBoundingClientRect();
    // 若 overlay 不存在或尺寸与图片显示尺寸不一致则重建
    if (!overlay
        || Math.abs(overlay.width - Math.round(rect.width)) > 1
        || Math.abs(overlay.height - Math.round(rect.height)) > 1) {
      overlay = document.createElement('canvas');
      overlay.width = Math.round(rect.width);
      overlay.height = Math.round(rect.height);
      const ctx = overlay.getContext('2d');
      if (ctx) { ctx.clearRect(0, 0, overlay.width, overlay.height); }
      brushOverlayRef.current = overlay;
    }
    return overlay;
  }, []);

  /** 在 overlay 上画一笔显示效果（半透明紫 = 编辑区；橡皮擦效果 = 透明 = 去掉编辑区） */
  const drawBrushStroke = useCallback((fromX: number, fromY: number, toX: number, toY: number, tool: MaskTool) => {
    const overlay = ensureBrushOverlay();
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    if (tool === 'brush') {
      // 编辑区：紫色半透明叠加（显示效果）；alpha 低一点让用户看清
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(99, 102, 241, 0.28)';
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.28)';
    } else if (tool === 'eraser') {
      // 橡皮擦：清除 overlay = 用户视觉上看到紫色被擦掉
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      return;
    }
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    // 额外补一个圆头，避免起笔/落笔缺角
    ctx.beginPath();
    ctx.arc(toX, toY, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }, [brushSize, ensureBrushOverlay]);

  const handleBrushDown = useCallback((e: React.PointerEvent) => {
    if (mode !== 'edit' || (maskTool !== 'brush' && maskTool !== 'eraser')) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = getPos(e);
    setDragging(true);
    lastBrushPosRef.current = p;
    drawBrushStroke(p.x, p.y, p.x, p.y, maskTool);
  }, [mode, maskTool, getPos, drawBrushStroke]);

  const handleBrushMove = useCallback((e: React.PointerEvent) => {
    if (!dragging || (maskTool !== 'brush' && maskTool !== 'eraser')) return;
    const p = getPos(e);
    const last = lastBrushPosRef.current ?? p;
    drawBrushStroke(last.x, last.y, p.x, p.y, maskTool);
    lastBrushPosRef.current = p;
    // 触发一次 rerender 以刷新 overlay 像素到 DOM（强制刷新）
    setOverlayTick((t) => t + 1);
  }, [dragging, maskTool, getPos, drawBrushStroke]);

  /** 切换工具时，如果从 rect→brush 矩形视觉上不清除但 mask 以笔刷为主；这里主动清空矩形避免用户混淆 */
  const onSwitchTool = (tool: MaskTool) => {
    if (tool !== 'rect') setSelection(null);
    if (tool !== 'brush' && tool !== 'eraser') {
      // 清空 overlay，用户回切 rect 时不被之前的紫色笔画干扰
      const ov = brushOverlayRef.current;
      if (ov) { const c = ov.getContext('2d'); if (c) c.clearRect(0, 0, ov.width, ov.height); }
    }
    setMaskTool(tool);
  };

  /** 全选 / 反选 / 清除 mask */
  const clearMask = useCallback(() => {
    setSelection(null);
    const ov = brushOverlayRef.current;
    if (ov) { const c = ov.getContext('2d'); if (c) c.clearRect(0, 0, ov.width, ov.height); }
  }, []);

  // ===== External src sync =====
  /** 上次外部传入的 src；History 切换版本 / 外部写回 inputImage 时同步编辑器内部工作图 */
  const prevSrcRef = useRef<string | null>(src ?? null);
  useEffect(() => {
    const next = src ?? null;
    if (prevSrcRef.current === next) return;
    prevSrcRef.current = next;
    // src 真正变化（如 History 切换版本、删除版本后回到文生图态）：
    // 同步 curImg 并清空上一版快照/遮罩/对比面板，避免残留影响新工作图。
    // 生成写回场景（curImg 已等于新 src）不进入此分支，保留上一版 Compare 快照。
    if (curImg !== next) {
      setCurImg(next);
      clearMask();
      setPrevImg(null);
      setCompareOpen(false);
      setSliderX(50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const selectAll = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    clearMask();
    const rect = img.getBoundingClientRect();
    setSelection({ x: 0, y: 0, w: rect.width, h: rect.height });
  }, [clearMask]);
  const invertMask = useCallback(() => {
    // 矩形反选：反选后切换为 brush overlay 方式表达更精确
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const overlay = ensureBrushOverlay();
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    // 先把当前 overlay 的内容读出来备用
    const prev = ctx.getImageData(0, 0, overlay.width, overlay.height);

    // 方案：全部填充紫色，再把"原选区内"擦掉
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(99, 102, 241, 0.28)';
    ctx.fillRect(0, 0, overlay.width, overlay.height);

    // 清除原矩形选区内（= 编辑区以外不透明 → 视觉紫块表示编辑区）
    if (selection) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillRect(selection.x, selection.y, selection.w, selection.h);
    }
    // 清除原 overlay 有紫的部分（= 原笔画区域反色）
    ctx.globalCompositeOperation = 'destination-out';
    // 把 prev 里 alpha > 0 的像素扣到现在的层上（destination-out 会根据 src alpha 擦除 dst）
    ctx.putImageData(prev, 0, 0); // 先放回去（不对，putImageData 会覆盖）→ 换算法
    // 正确反色算法：重放一次
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    // 基础：整图标记为编辑区（全紫）
    ctx.fillStyle = 'rgba(99, 102, 241, 0.28)';
    ctx.fillRect(0, 0, overlay.width, overlay.height);
    // 再对 prev 的 alpha>0 区域做擦除（原笔画区域不再是编辑区）
    const tmp = document.createElement('canvas');
    tmp.width = overlay.width; tmp.height = overlay.height;
    const tctx = tmp.getContext('2d'); if (tctx) tctx.putImageData(prev, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(tmp, 0, 0);
    // 原矩形选区内同样擦除
    if (selection) {
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.fillRect(selection.x, selection.y, selection.w, selection.h);
    }
    ctx.globalCompositeOperation = 'source-over';
    setSelection(null);
    setMaskTool('brush'); // 后续以 brush 方式继续编辑更合理
  }, [selection, ensureBrushOverlay]);

  // ==================================================================
  // Build mask for API (OpenAI images.edits mask semantics: transparent = edit, white = keep)
  // ==================================================================
  const buildMask = useCallback(async (): Promise<string | null> => {
    const img = imgRef.current;
    if (!img) return null;
    const hasRect = selection && selection.w > 4 && selection.h > 4;
    const overlay = brushOverlayRef.current;
    let hasBrush = false;
    if (overlay) {
      const c = overlay.getContext('2d');
      if (c) {
        const d = c.getImageData(0, 0, overlay.width, overlay.height).data;
        for (let i = 3; i < d.length; i += 4) { if (d[i] > 16) { hasBrush = true; break; } }
      }
    }
    if (!hasRect && !hasBrush) {
      // 无手工 mask → 若存在选中的 VLM 区域，仍需要生成区域 mask；否则返回 null（整图编辑）
      if (regions.length === 0 || selectedRegions.length === 0) return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // 全白 = 保留
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 显示盒 ↔ 内容矩形换算：img 是 object-fit: contain，元素盒可能比内容矩形大（留边），
    // 手工 mask（Rect/brush）坐标基于元素盒，需先减 offX/offY 再按 scale 映射到自然像素，
    // 与 VLM 高亮标注（px = offX + n*kx）基准一致，否则虚线框与高亮区错位。
    const imgRect = img.getBoundingClientRect();
    const natW = Math.max(1, img.naturalWidth);
    const natH = Math.max(1, img.naturalHeight);
    const dispScale = Math.min(imgRect.width / natW, imgRect.height / natH);
    const contentW = natW * dispScale;
    const contentH = natH * dispScale;
    const offX = (imgRect.width - contentW) / 2;
    const offY = (imgRect.height - contentH) / 2;

    // 矩形选区：元素盒坐标 → 自然坐标（减留边偏移 ÷ 缩放比）→ clearRect → 透明 = 编辑
    if (hasRect && selection) {
      const nx = (selection.x - offX) / dispScale;
      const ny = (selection.y - offY) / dispScale;
      ctx.clearRect(nx, ny, selection.w / dispScale, selection.h / dispScale);
    }
    // 笔刷 overlay：读取像素（alpha > 阈值 = 用户画过的区域 → 这些地方要做成透明=编辑区）
    if (hasBrush && overlay) {
      const tmp = document.createElement('canvas');
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const tctx = tmp.getContext('2d');
      if (tctx) {
        // overlay 是元素盒尺寸：截取内容矩形（offX/offY → contentW/H）映射到自然 canvas，
        // 否则留边像素会被误当成笔画/编辑区，造成与高亮区错位
        tctx.drawImage(overlay, offX, offY, contentW, contentH, 0, 0, canvas.width, canvas.height);
        const d = tctx.getImageData(0, 0, canvas.width, canvas.height);
        // 构建「目标擦除区域」的 alpha 遮罩：用户有笔画（alpha > 16）的位置 → src alpha = 255，
        // 其他位置 → src alpha = 0。随后用 destination-out 模式把 canvas 对应像素清成透明。
        // 之前的 bug 是反过来把笔画处全清零，导致 destination-out 什么也擦不掉。
        for (let i = 3; i < d.data.length; i += 4) {
          const isBrush = d.data[i] > 16;
          d.data[i - 3] = isBrush ? 255 : 0;
          d.data[i - 2] = isBrush ? 255 : 0;
          d.data[i - 1] = isBrush ? 255 : 0;
          d.data[i]     = isBrush ? 255 : 0;
        }
        tctx.putImageData(d, 0, 0);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(tmp, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // 选中的 VLM 区域：bbox 为自然尺寸坐标，直接 clearRect → 透明 = 编辑
    for (const rid of selectedRegions) {
      const reg = regions.find((r) => r.id === rid);
      if (!reg) continue;
      const [bx1, by1, bx2, by2] = reg.bbox;
      const w = bx2 - bx1;
      const h = by2 - by1;
      if (w > 0 && h > 0) ctx.clearRect(bx1, by1, w, h);
    }
    return canvas.toDataURL('image/png');
  }, [selection, regions, selectedRegions]);

  // ==================================================================
  // Generate: call /api/ai-edit/image
  // ==================================================================
  /**
   * 核心生成函数：接受"覆盖上下文"（可选），缺省回退到编辑器内部 state。
   * 返回结构化结果，方便内部按钮 & 外部 Prompt Bar 两种入口复用。
   */
  const doGenerate = useCallback(async (ctx?: ImageGenPromptCtx): Promise<{ ok: boolean; image?: string; error?: string }> => {
    const promptIn = ctx?.prompt !== undefined ? ctx.prompt : instruction;
    const sizeIn = ctx?.size ?? genSize;
    const modelIn = ctx?.model ?? currentModel;
    const negIn = (ctx?.negative !== undefined ? ctx.negative : negativePrompt).trim();
    const refsIn = ctx?.attachments ?? refImages;
    const text = promptIn.trim();
    if (!text || mode === 'generating') return { ok: false, error: 'prompt is empty or already generating' };

    const useAiMode = curImg ? 'edit' : 'generate';
    setError(null);
    setMode('generating');
    setImageAiEditKeepAlive(true);

    try {
      let image: string | undefined;
      if (useAiMode === 'generate') {
        const body: Record<string, unknown> = { prompt: text, size: sizeIn };
        if (modelIn) body.model = modelIn;
        if (negIn) body.negative_prompt = negIn;
        const resp = await fetch('/api/ai-generate/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Generation failed');
        image = data.image as string;
        // 文生图同样记录上一版快照：已有工作图时先缓存旧图，便于工具栏 Compare 滑块差分
        if (curImg) {
          setPrevImg(curImg);
          setCompareOpen(false);
          setSliderX(50);
        }
        setCurImg(image);
        setInstruction('');
        setMode('edit');
        clearMask();
        onImageChange?.(image);
        showImageAiEditToast(
          isImageAiEditHidden()
            ? 'Image generated (preview collapsed) — expand the panel to see the result.'
            : 'Image generated.',
        );
      } else {
        const img = imgRef.current;
        if (!img) throw new Error('Source image not loaded yet, please try again.');
        // 规则二（Prompt 语义补充）：把选中区域的 #label 记号替换为 VLM 完整描述（object + attributes），
        // 让编辑模型精确理解 #chip 指向的对象（如 #car → red vintage car, chrome bumper），而不只是短标签。
        let editInstruction = text;
        if (selectedRegions.length > 0 && regions.length > 0) {
          const descByLabel = new Map<string, string>();
          for (const rid of selectedRegions) {
            const reg = regions.find((r) => r.id === rid);
            if (!reg) continue;
            const desc = [reg.object, reg.attributes].filter(Boolean).join(', ');
            if (desc) descByLabel.set(`#${reg.label}`, desc);
          }
          // 长标签优先替换，避免短标签被长标签内的子串抢先
          const tokens = [...descByLabel.entries()].sort((a, b) => b[0].length - a[0].length);
          editInstruction = tokens.reduce((acc, [token, desc]) => acc.split(token).join(desc), text);
        }
        const body: Record<string, unknown> = {
          image: curImg ?? '',
          instruction: editInstruction,
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
        if (modelIn) body.model = modelIn;
        if (negIn) body.negative_prompt = negIn;
        const refDataUrls = refsIn.map((r) => r.dataUrl);
        if (refDataUrls.length > 0) body.references = refDataUrls;
        const mask = await buildMask();
        if (mask) body.mask = mask;
        // 选中区域坐标随请求下发：有 mask 通道的模型用 mask；无 mask 通道的模型（doubao SeedEdit/Seedream i2i）
        // 由后端把 bbox 注入 prompt 做区域定位（body.regions 与 mask 并存，后端按 provider 决定用哪个）
        if (selectedRegions.length > 0) {
          body.regions = selectedRegions
            .map((rid) => regions.find((r) => r.id === rid))
            .filter((r): r is RegionRef => !!r)
            .map((r) => ({ bbox: r.bbox, object: r.object, attributes: r.attributes }));
        }
        const resp = await fetch('/api/ai-edit/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Generation failed');
        setPrevImg(curImg);
        setCompareOpen(false);
        setSliderX(50);
        image = data.image as string;
        setCurImg(image);
        setInstruction('');
        setMode('edit');
        clearMask();
        onImageChange?.(image);
        showImageAiEditToast(
          isImageAiEditHidden()
            ? 'AI edit complete (preview collapsed) — expand the panel to see the result.'
            : 'AI edit complete.',
        );
      }
      return { ok: true, image };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setMode('edit');
      showImageAiEditToast(`AI generation failed: ${msg}`, 'error');
      return { ok: false, error: msg };
    }
  }, [instruction, mode, genSize, curImg, negativePrompt, buildMask, currentModel, refImages, regions, selectedRegions, onImageChange, clearMask]);

  /** 内建 Generate 按钮（仅当 hideBottomBar=false 时渲染）调用，保持 viewer 原有行为 */
  const handleGenerate = useCallback(async () => { await doGenerate(); }, [doGenerate]);

  /**
   * 三视图生成（串行 3 步）：
   *   Step 1: POST /api/ai-generate/image → 正面图（无前缀 prompt，无前驱图）
   *   Step 2: POST /api/ai-edit/image     → 侧面图（references=[front_img]）
   *   Step 3: POST /api/ai-edit/image     → 顶部图（references=[front_img]）
   * 进度 onProgress：在每一步开始 fetch 前触发，父级用于更新 status bar。
   */
  const runTriplotGenerate = useCallback(async (
    ctx: ImageGenPromptCtx,
    onProgress?: (p: TriplotProgress) => void,
  ): Promise<{ ok: boolean; triplot?: TriplotResult; error?: string }> => {
    const baseText = ctx.prompt.trim();
    if (!baseText) return { ok: false, error: 'Prompt is empty' };
    const sizeIn = ctx.size || '1024x1024';
    const modelIn = ctx.model;
    const negIn = (ctx.negative ?? '').trim();
    const refsIn = ctx.attachments ?? [];

    // 三视角注入模板：正面不增加修饰；侧面/顶部指定视角 + 明确保持一致性
    const VIEW_SPECS: Array<{
      key: 'front' | 'side' | 'top';
      label: string;
      promptInfix: string;
      mode: 'generate' | 'edit';
      step: 1 | 2 | 3;
    }> = [
      { key: 'front', label: 'Front view', promptInfix: 'front view, full body, centered, clean background, consistent proportions', mode: 'generate', step: 1 },
      { key: 'side', label: 'Side view (profile)', promptInfix: 'side view (profile), same character/object/color/style as the reference image, exact same proportions, clean background', mode: 'edit', step: 2 },
      { key: 'top', label: 'Top view', promptInfix: 'top view (bird\'s eye), same character/object/color/style as the reference image, exact same proportions, clean background', mode: 'edit', step: 3 },
    ];

    const result: Partial<TriplotResult> = {};
    let frontImage: string | null = null;

    for (const spec of VIEW_SPECS) {
      onProgress?.({ step: spec.step, total: 3, current: spec.key });
      const fullPrompt = `${spec.promptInfix} — ${baseText}`;
      try {
        if (spec.mode === 'generate') {
          const body: Record<string, unknown> = { prompt: fullPrompt, size: sizeIn };
          if (modelIn) body.model = modelIn;
          if (negIn) body.negative_prompt = negIn;
          // 用户附件参考图也作为参考带入（若有）
          const refDataUrls = refsIn.map((r) => r.dataUrl);
          if (refDataUrls.length > 0) body.references = refDataUrls;
          const resp = await fetch('/api/ai-generate/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await resp.json();
          if (!data.success) throw new Error(data.error || `[${spec.label}] Generation failed`);
          const img = data.image as string;
          frontImage = img;
          result[spec.key] = { image: img, prompt: fullPrompt };
        } else {
          // side / top：以 front 图为参考（references=[front]），用 edit 路径但不传 instruction 底图
          // （某些 provider 的 edit 路径需要 instruction 图。为兼容，把 front 同时作为 instruction 和 reference。）
          if (!frontImage) throw new Error(`[${spec.label}] Preceding front-view image not ready`);
          const [wStr, hStr] = sizeIn.split('x');
          const w = parseInt(wStr || '1024', 10);
          const h = parseInt(hStr || '1024', 10);
          const body: Record<string, unknown> = {
            image: frontImage,
            instruction: fullPrompt,
            width: w,
            height: h,
          };
          if (modelIn) body.model = modelIn;
          if (negIn) body.negative_prompt = negIn;
          // 用户附件参考图 + 已生成正面图，双参考
          const refDataUrls = [frontImage, ...refsIn.map((r) => r.dataUrl)];
          body.references = refDataUrls;
          const resp = await fetch('/api/ai-edit/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await resp.json();
          if (!data.success) throw new Error(data.error || `[${spec.label}] Generation failed`);
          const img = data.image as string;
          result[spec.key] = { image: img, prompt: fullPrompt };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showImageAiEditToast(`Triplot ${spec.label} failed: ${msg}`, 'error');
        return { ok: false, error: msg };
      }
    }
    return { ok: true, triplot: result as TriplotResult };
  }, []);

  // 暴露 API 给外部 Prompt Bar & 版本历史弹窗
  useImperativeHandle(ref, () => ({
    runGenerate: doGenerate,
    runTriplotGenerate,
    getWorkingImage: () => curImg ?? null,
    setAttachments: (attachments: AttachmentImage[]) => setRefImages(attachments),
    startCompare: (imgA: string, imgB: string) => {
      setPrevImg(imgA);
      setCurImg(imgB);
      setCompareOpen(true);
      setSliderX(50);
    },
  }), [doGenerate, runTriplotGenerate, curImg]);

  // 组件卸载（如关闭标签页）时释放 keep-alive，避免残留隐藏挂载
  useEffect(() => {
    return () => { setImageAiEditKeepAlive(false); };
  }, []);

  // ==================================================================
  // Style preset click
  // ==================================================================
  const applyPreset = (preset: typeof STYLE_PRESETS[number]) => {
    if (preset.id === 'custom') { setNegativeOpen(true); return; }
    // 在原指令前插入前缀（如果已有同前缀则不重复插入）
    setInstruction((prev) => {
      if (prev.startsWith(preset.prefix)) return prev;
      // 尝试识别是否已有任意 [Tag] 前缀 — 有的话替换
      const tagMatch = prev.match(/^\[[^\]]+\][^\u2014]*\u2014\s*/);
      if (tagMatch) return preset.prefix + prev.slice(tagMatch[0].length);
      return preset.prefix + prev;
    });
    setNegativeOpen(true);
    if (preset.defaultNegative) {
      setNegativePrompt((prev) => {
        if (!prev.trim()) return preset.defaultNegative ?? prev;
        // 用户已手动写了 negative，保留并合并（去重）
        const existing = new Set(prev.split(',').map((s) => s.trim()).filter(Boolean));
        (preset.defaultNegative ?? '').split(',').map((s) => s.trim()).filter(Boolean).forEach((w) => existing.add(w));
        return [...existing].join(', ');
      });
    }
  };

  // ===== Previous-version compare slider handlers =====
  const onSliderHandleDown = (e: React.PointerEvent) => {
    if (!compareOpen) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    sliderDragRef.current = true;
  };
  const onSliderAreaMove = (e: React.PointerEvent) => {
    if (!sliderDragRef.current || !compareOpen) return;
    const area = sliderAreaRef.current;
    if (!area) return;
    const r = area.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    setSliderX(pct);
  };
  const onSliderHandleUp = () => { sliderDragRef.current = false; };
  const toggleCompare = () => {
    setCompareOpen((o) => !o);
    setSliderX(50);
  };

  /** overlay 画面一帧强制刷新（笔刷涂抹后保证用户能看到最新紫色笔画） */
  const [overlayTick, setOverlayTick] = useState(0);
  useEffect(() => {
    // 无操作；ticker 驱动重新 render 以重绘 overlay <img src>
  }, [overlayTick]);
  // 注：dragging 过程中，每一次 handleBrushMove 都 setOverlayTick(t => t+1)
  // 足以保证笔画实时显示，不再额外起 RAF 循环浪费 CPU。

  /** 笔刷 overlay dataURL（在笔刷 dragging 时作为紫色笔画即时反馈叠加层显示） */
  const overlayDataUrl = useMemo(() => {
    const ov = brushOverlayRef.current;
    if (!ov) return '';
    return ov.toDataURL();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayTick, mode, maskTool]);

  // ==================================================================
  // Semantic visual overlay: 预合成最终视觉 PNG（不再依赖 CSS mask-image）
  //   · 保留区：深灰遮罩色覆盖 + img 层 backdrop-filter（saturate 降 + 轻微 blur）
  //            → 无论白纸/深色照片，"被盖住的"保留区立刻有灰雾+模糊视觉差
  //   · 编辑区：透明（透出下面原图清晰显示）+ 叠一层极淡的暖色微光
  //            → 法律文档（白底黑字）下也立刻看到"这是 AI 改的选区"
  //   · 语义与 OpenAI images.edits 完全一致：编辑区=无遮罩，保留区=被盖住
  // ==================================================================
  const semanticOverlayDataUrl = useMemo((): string => {
    const img = imgRef.current;
    if (!img) return '';
    const rect = img.getBoundingClientRect();
    const W = Math.round(rect.width);
    const H = Math.round(rect.height);
    if (W < 2 || H < 2) return '';
    const hasRect = selection && selection.w > 4 && selection.h > 4;
    const overlay = brushOverlayRef.current;
    let hasBrush = false;
    if (overlay) {
      const c = overlay.getContext('2d');
      if (c) {
        const d = c.getImageData(0, 0, overlay.width, overlay.height).data;
        for (let i = 3; i < d.length; i += 4) { if (d[i] > 16) { hasBrush = true; break; } }
      }
    }
    if (!hasRect && !hasBrush) return '';

    // Step 1: 构建「编辑区 = alpha=255，其他 = alpha=0」的编辑器形状归一化图
    const shape = document.createElement('canvas');
    shape.width = W;
    shape.height = H;
    const sctx = shape.getContext('2d');
    if (sctx) {
      // Rect 选区
      if (hasRect && selection) {
        sctx.fillStyle = '#fff';
        sctx.fillRect(selection.x, selection.y, selection.w, selection.h);
      }
      // Brush 痕迹
      if (hasBrush && overlay) {
        sctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, 0, 0, W, H);
        const d = sctx.getImageData(0, 0, W, H);
        for (let i = 3; i < d.data.length; i += 4) {
          const isBrush = d.data[i] > 16;
          d.data[i - 3] = 255; d.data[i - 2] = 255; d.data[i - 1] = 255;
          d.data[i] = isBrush ? 255 : 0;
        }
        sctx.putImageData(d, 0, 0);
      }
    }

    // Step 2: 合成最终语义叠层 PNG
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return '';

    // (a) 保留区遮罩：整张覆盖深灰（法律白纸也明显可见差异）
    // 颜色：中性冷灰，alpha=0.46 — 足够的对比度让"未选择区域"明显变暗，
    // 编辑区保持清晰；配合 backdrop-filter 双重感知。
    ctx.fillStyle = 'rgba(15, 18, 26, 0.46)';
    ctx.fillRect(0, 0, W, H);

    // (b) 编辑区挖洞：destination-out，按编辑区形状清透明。
    //      结果：保留区 = 深灰遮罩；编辑区 = 透明（透出下面原图）。
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(shape, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    // (b2) 编辑区描边环：把编辑区形状膨胀一圈再挖掉原形状 → 得到 2px 亮橙色边界环，
    //      让编辑区边界一目了然（尤其白纸/浅色场景下"挖洞"也清晰可见）。
    try {
      const ring = document.createElement('canvas');
      ring.width = W;
      ring.height = H;
      const rctx = ring.getContext('2d');
      if (rctx) {
        const inflate = 2;
        for (let dx = -inflate; dx <= inflate; dx += 1) {
          for (let dy = -inflate; dy <= inflate; dy += 1) {
            if (dx === 0 && dy === 0) continue;
            rctx.drawImage(shape, dx, dy);
          }
        }
        rctx.globalCompositeOperation = 'destination-out';
        rctx.drawImage(shape, 0, 0);
        rctx.globalCompositeOperation = 'source-in';
        rctx.fillStyle = 'rgba(255, 165, 92, 0.95)';
        rctx.fillRect(0, 0, W, H);
        rctx.globalCompositeOperation = 'source-over';
      }
      ctx.drawImage(ring, 0, 0);
    } catch {
      // 描边环失败不影响核心遮罩功能，静默忽略
    }

    // (c) 编辑区暖色微光提示：在编辑区形状内部叠一层淡的主色（BobWork 橙红色系 oklch 0.62 0.17 45 → #ff893a）
    //     即使是白纸场景下"挖洞=没变化"，也有一层肉眼可见的淡橙色提示"这就是编辑区"。
    //     实现：用 shape 图 + source-in 染成暖色填充 → 再 destination-over 贴到合成 canvas 下方（编辑区透明处可见）
    try {
      const glow = document.createElement('canvas');
      glow.width = W;
      glow.height = H;
      const gctx = glow.getContext('2d');
      if (gctx) {
        gctx.drawImage(shape, 0, 0);
        // source-in: 保留现有 alpha 通道，用新颜色覆盖 RGB
        gctx.globalCompositeOperation = 'source-in';
        gctx.fillStyle = 'rgba(255, 137, 58, 0.22)'; // 主色 oklch(0.62 0.17 45) 暖色微光
        gctx.fillRect(0, 0, W, H);
        gctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalCompositeOperation = 'destination-over';
      ctx.drawImage(glow, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    } catch {
      // 微光失败不影响核心遮罩功能，静默忽略
    }

    return cv.toDataURL('image/png');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, overlayTick, mode]);

  // ==================================================================
  // RENDER
  // ==================================================================
  return (
    <div
      className="relative flex h-full w-full flex-col"
      style={{ backgroundColor: 'oklch(0.16 0.02 260)' }}
      onWheel={stopEvent}
    >
      {/* ① 顶部工具栏 */}
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2 select-none"
        style={{ backgroundColor: '#1c1c1e', borderBottom: '1px solid rgba(255,255,255,0.08)' }}
        onPointerDown={stopEvent}
      >
        <span
          className="mr-1 max-w-[200px] truncate text-xs font-medium"
          style={{ color: 'rgba(255,255,255,0.75)' }}
          title={fileName}
        >{fileName}</span>
        <span
          className="flex items-center rounded-md px-1.5 py-1 gap-1"
          title="AI Edit"
          style={{ backgroundColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}
        >
          <Wand2 className="h-3 w-3" />
        </span>

        {/* 遮罩工具（有图即露出生图界面含工具）：点击 Mask 弹出下拉菜单选择 Rect/Brush/Eraser + 全选/反选/清除 + 笔刷大小 */}
        {aiMode === 'edit' && (
          <>
            <span className="mx-1 h-4 w-px shrink-0" style={{ backgroundColor: 'rgba(255,255,255,0.12)' }} />
            {/* Mask 下拉锚点按钮：显示当前工具图标 + Mask 文字 */}
            <button
              ref={maskMenuBtnRef}
              type="button"
              onClick={() => setMaskToolsOpen((v) => !v)}
              title="Mask tools — choose Rect / Brush / Eraser from the dropdown"
              aria-pressed={maskToolsOpen}
              className="flex h-7 items-center gap-1 rounded-md px-1.5 transition-all"
              style={{
                backgroundColor: maskToolsOpen ? 'rgba(96,84,241,0.32)' : 'rgba(255,255,255,0.04)',
                color: maskToolsOpen ? '#e5e7ff' : 'rgba(255,255,255,0.7)',
                border: maskToolsOpen ? '1px solid rgba(96,84,241,0.55)' : '1px solid transparent',
              }}
            >
              {(() => {
                const Cur = maskTool === 'rect' ? Square : maskTool === 'brush' ? Paintbrush : Eraser;
                return <Cur className="h-3.5 w-3.5" />;
              })()}
              <span className="text-10.5 font-semibold">Mask</span>
              {maskToolsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>

            {/* Mask 工具下拉菜单：Portal 挂 body，fixed 定位在按钮下方，脱离 overflow 裁剪 */}
            {maskToolsOpen && portal && maskMenuRect && createPortal(
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMaskToolsOpen(false)} />
                <div
                  style={{
                    position: 'fixed',
                    zIndex: 41,
                    top: maskMenuRect.bottom + 4,
                    left: maskMenuRect.left,
                    width: 240,
                    backgroundColor: 'rgba(20,20,22,0.98)',
                    border: '1px solid rgba(96,84,241,0.40)',
                    boxShadow: '0 14px 32px rgba(0,0,0,0.6)',
                    borderRadius: 8,
                    padding: 4,
                  }}
                  onPointerDown={stopEvent}
                >
                  <div className="px-2 py-1 font-semibold uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.666667rem' }}>
                    Mask tool
                  </div>
                  {([
                    { k: 'rect' as const,   Icon: Square,   label: 'Rect selection', desc: 'Drag to draw a rectangular edit area.' },
                    { k: 'brush' as const,  Icon: Paintbrush, label: 'Brush mask',    desc: 'Paint directly to mark the exact area to edit.' },
                    { k: 'eraser' as const, Icon: Eraser,   label: 'Eraser',         desc: 'Erase parts of the mask you marked by mistake.' },
                  ]).map(({ k, Icon, label, desc }) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => { onSwitchTool(k); setMaskToolsOpen(false); }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[rgba(96,84,241,0.14)]"
                      style={{
                        backgroundColor: maskTool === k ? 'rgba(96,84,241,0.18)' : 'transparent',
                        border: maskTool === k ? '1px solid rgba(96,84,241,0.55)' : '1px solid transparent',
                      }}
                    >
                      <Icon className="h-4 w-4 shrink-0" style={{ color: maskTool === k ? '#C7BEFF' : 'rgba(255,255,255,0.75)' }} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold" style={{ color: maskTool === k ? '#C7BEFF' : 'rgba(255,255,255,0.85)', fontSize: '0.8rem' }}>{label}</span>
                        <span className="block truncate" style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.7rem' }}>{desc}</span>
                      </span>
                      {maskTool === k && <Check className="h-3 w-3 shrink-0" style={{ color: '#6EE7B7' }} />}
                    </button>
                  ))}

                  <div className="my-1 h-px" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }} />

                  <div className="flex items-center justify-around gap-1 px-1 py-1">
                    <button
                      type="button" title="Select entire image as edit region"
                      onClick={selectAll}
                      className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[rgba(96,84,241,0.14)]"
                      style={{ backgroundColor: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.75)' }}
                    >
                      <FillAllIcon className="h-4 w-4" />
                    </button>
                    <button
                      type="button" title="Invert mask"
                      onClick={invertMask}
                      className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[rgba(96,84,241,0.14)]"
                      style={{ backgroundColor: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.75)' }}
                    >
                      <FlipVertical2 className="h-4 w-4" />
                    </button>
                    <button
                      type="button" title="Clear mask"
                      onClick={clearMask}
                      className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[rgba(96,84,241,0.14)]"
                      style={{ backgroundColor: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.75)' }}
                    >
                      <CircleOff className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Brush size: only for brush/eraser */}
                  {(maskTool === 'brush' || maskTool === 'eraser') && (
                    <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
                      <span className="shrink-0 text-10 font-mono" style={{ color: 'rgba(255,255,255,0.55)' }}>{brushSize}px</span>
                      <input
                        type="range"
                        min={4} max={80} step={1}
                        value={brushSize}
                        onChange={(e) => setBrushSize(Number(e.target.value))}
                        className="w-full accent-violet-400"
                        title={`Brush size: ${brushSize}px (display)`}
                      />
                    </div>
                  )}
                </div>
              </>,
              portal,
            )}
            {/* Detect All：VLM 全景识别所有可编辑目标（无需指令） */}
            <span className="mx-1 h-4 w-px shrink-0" style={{ backgroundColor: 'rgba(255,255,255,0.12)' }} />
            <button
              type="button"
              onClick={onDetectAll}
              disabled={!onDetectAll || detectAllLoading}
              title="Detect All — scan the image for all editable objects (people, objects, text, background), click boxes to select"
              className="flex h-7 items-center gap-1.5 rounded-md px-2 transition-all disabled:opacity-40 enabled:hover:scale-[1.03]"
              style={{
                backgroundColor: regions.length > 0 ? 'rgba(96,84,241,0.28)' : 'rgba(255,255,255,0.05)',
                color: regions.length > 0 ? '#e5e7ff' : 'rgba(255,255,255,0.8)',
                border: regions.length > 0 ? '1px solid rgba(96,84,241,0.55)' : '1px solid rgba(255,255,255,0.12)',
              }}
            >
              {detectAllLoading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <ScanSearch className="h-3.5 w-3.5" />}
              <span className="text-11 font-semibold">Detect All</span>
            </button>
            {regions.length > 0 && (
              <button
                type="button"
                onClick={onClearRegions}
                title="Clear all detected regions"
                className="flex h-7 w-7 items-center justify-center rounded-md"
                style={{ backgroundColor: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.7)' }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {/* 区域列表面板：框多交错时用列表精确点选（点击行 = 选中，hover 双向联动） */}
            {regions.length > 0 && (
              <button
                type="button"
                onClick={() => setRegionsOpen((v) => !v)}
                title={`Region list (${regions.length}) — click a row to select, hover to highlight on image`}
                aria-pressed={regionsOpen}
                className="flex h-7 items-center gap-1 rounded-md px-1.5 transition-all"
                style={{
                  backgroundColor: regionsOpen ? 'rgba(96,84,241,0.32)' : 'rgba(255,255,255,0.04)',
                  color: regionsOpen ? '#e5e7ff' : 'rgba(255,255,255,0.7)',
                  border: regionsOpen ? '1px solid rgba(96,84,241,0.55)' : '1px solid transparent',
                }}
              >
                <Layers className="h-3.5 w-3.5" />
                <span className="text-10.5 font-semibold">Regions</span>
                <span
                  className="rounded-sm px-1 text-9.5 font-bold"
                  style={{ backgroundColor: 'rgba(96,84,241,0.35)', color: '#e5e7ff' }}
                >{regions.length}</span>
              </button>
            )}
          </>
        )}
        {/* 上一版 vs 当前版 滑块对比（有上一版快照时；放顶部工具栏，hideBottomBar 场景同样可见） */}
        {aiMode === 'edit' && prevImg && prevImg !== curImg && (
          <>
            <span className="mx-1 h-4 w-px shrink-0" style={{ backgroundColor: 'rgba(255,255,255,0.12)' }} />
            <button
              type="button"
              onClick={toggleCompare}
              title="Compare previous version vs current (drag the slider)"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-opacity hover:opacity-85"
              style={{ backgroundColor: compareOpen ? 'rgba(129,140,248,0.35)' : 'rgba(255,255,255,0.08)', color: compareOpen ? '#e0e7ff' : 'rgba(255,255,255,0.8)' }}
            >
              <SplitSquareVertical className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">Compare</span>
            </button>
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {!hideHelp && (
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              title="AI Edit usage guide"
              className="flex items-center justify-center rounded-md px-1.5 py-1 transition-colors hover:bg-white/10"
              style={{ color: 'rgba(255,255,255,0.7)' }}
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            title="Close"
            className="flex items-center justify-center rounded-md px-1.5 py-1 transition-colors hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.7)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="shrink-0 border-b px-3 py-2 text-xs" style={{ backgroundColor: 'rgba(225,29,72,0.15)', borderColor: 'rgba(225,29,72,0.35)', color: '#fda4af' }}>
          {error}
        </div>
      )}

      {/* ② 主区域 */}
      <div
        ref={areaRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onWheel={stopEvent}
      >
        {aiMode === 'generate' ? (
          /* ============== Generate placeholder: 文生图待生成（无工作图） ============== */
          <div
            className="flex h-full w-full flex-col items-center justify-center gap-3 p-4 select-none"
            style={{ color: 'rgba(255,255,255,0.4)' }}
          >
            <Wand2 className="h-6 w-6" />
            <span className="text-xs">Describe the image below, then click Generate to create it.</span>
            {allowGenerate && (
              <button
                type="button"
                onClick={() => baseFileInputRef.current?.click()}
                title="Upload an image to start editing it"
                className="flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-11 transition-colors hover:bg-white/10"
                style={{ borderColor: 'rgba(255,255,255,0.22)', color: 'rgba(255,255,255,0.6)' }}
              >
                <Paperclip className="h-3 w-3" />
                Upload an image to start editing
              </button>
            )}
            <input
              ref={baseFileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBaseImageFile(f); e.currentTarget.value = ''; }}
            />
          </div>
        ) : (
          /* ============== Edit mode: image + mask tooling ============== */
          <div
            className="relative flex h-full w-full items-center justify-center p-4"
            onPointerDown={stopEvent}
          >
            {/* 主图 + 指针事件转发到具体工具 handler — 父容器用 inline-block：其 border-box 紧贴子图，
                 因此子层 absolute + left/top 就和 img 内部坐标 1:1 对齐 */}
            <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
              <img
                ref={imgRef}
                src={curImg ?? ''}
                alt={fileName}
                draggable={false}
                onPointerDown={(e) => {
                  if (maskTool === 'rect') handleRectDown(e);
                  else handleBrushDown(e);
                }}
                onPointerMove={(e) => {
                  if (maskTool === 'rect') handleRectMove(e);
                  else handleBrushMove(e);
                }}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className="max-h-full max-w-full rounded-lg object-contain shadow-2xl block"
                style={{
                  touchAction: 'none',
                  cursor:
                    mode === 'generating' ? 'wait' :
                    maskTool === 'rect' ? 'crosshair' :
                    maskTool === 'brush' ? 'cell' :
                    'not-allowed',
                }}
              />
              {/* Rect selection visual — 父容器是 inline-block 紧贴图，selection.x/y 相对图左上角
                   新版语义：仅画虚线边框，不填色（填色现在由下方 Semantic white mask 统一承担，
                   实现"编辑区透明、保留区白色遮罩"的 OpenAI 对齐语义） */}
              {selection && mode === 'edit' && (
                <div
                  className="pointer-events-none absolute rounded-sm border-2 border-dashed"
                  style={{
                    left: selection.x,
                    top: selection.y,
                    width: selection.w,
                    height: selection.h,
                    borderColor: 'rgba(255,255,255,0.92)',
                    boxShadow: '0 0 0 1px rgba(99,102,241,0.55)',
                    // 去掉半透明填色 → 编辑区透出原图（视觉透明）
                    backgroundColor: 'transparent',
                  }}
                />
              )}

              {/* VLM 识别标注（Detect All）：圆点 + 折线 + 标签（leader-line 引线标注）
                   bbox 仅用于计算锚点中心；标注不遮挡图片内容，多个对象重叠时更易区分。
                   点击圆点/标签 toggle 选中；hover 高亮 + 其余淡化（与区域列表联动）。 */}
              {mode === 'edit' && regions.length > 0 && (() => {
                const imgEl = imgRef.current;
                if (!imgEl) return null;
                const rect = imgEl.getBoundingClientRect();
                const natW = Math.max(1, imgEl.naturalWidth);
                const natH = Math.max(1, imgEl.naturalHeight);
                // object-fit: contain 内容矩形（相对 img 元素盒）：元素盒可能被容器撑满而留边，
                // 需补偿居中偏移 offX/offY，否则引线会偏位/比例错
                const scale = Math.min(rect.width / natW, rect.height / natH);
                const contentW = natW * scale;
                const contentH = natH * scale;
                const offX = (rect.width - contentW) / 2;
                const offY = (rect.height - contentH) / 2;
                const kx = contentW / natW;
                const ky = contentH / natH;
                const px = (n: number) => offX + n * kx;
                const py = (n: number) => offY + n * ky;

                // 引线布局：圆点 = bbox 中心；标签默认放对象右上（右/上边缘不足则翻转到左/下方）
                const marks = regions.map((r) => {
                  const [x1, y1, x2, y2] = r.bbox;
                  const cx = px((x1 + x2) / 2);
                  const cy = py((y1 + y2) / 2);
                  const dirX = px(x2) + 92 < contentW ? 1 : -1;
                  const dirY = py(y1) - 32 > 10 ? -1 : 1;
                  const lx = cx + dirX * 36;
                  const ly = cy + dirY * 32;
                  const mx = cx + dirX * 15;
                  const my = cy + dirY * 12;
                  return { r, cx, cy, lx, ly, mx, my };
                });
                const anyHover = hoveredRegionId !== null;

                return (
                  <>
                    {/* 引线层（SVG 覆盖整个 img 元素盒，仅视觉，不拦截事件） */}
                    <svg
                      className="pointer-events-none absolute"
                      style={{ left: 0, top: 0, width: rect.width, height: rect.height, overflow: 'visible' }}
                    >
                      {marks.map((m) => {
                        const isSel = selectedRegions.includes(m.r.id);
                        const isHover = hoveredRegionId === m.r.id;
                        const isDimmed = anyHover && !isHover && !isSel;
                        const color = isSel ? 'rgba(96,84,241,0.95)' : isHover ? 'rgba(96,84,241,0.9)' : 'rgba(96,84,241,0.55)';
                        return (
                          <polyline
                            key={m.r.id}
                            points={`${m.cx},${m.cy} ${m.mx},${m.my} ${m.lx},${m.ly}`}
                            fill="none"
                            stroke={color}
                            strokeWidth={isSel ? 2 : 1.4}
                            strokeDasharray={isSel ? 'none' : '3,3'}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity={isDimmed ? 0.2 : 1}
                            style={{ transition: 'opacity var(--dur-fast) var(--ease-fast)' }}
                          />
                        );
                      })}
                    </svg>

                    {/* 圆点 + 标签层（可交互：点击 toggle / hover 高亮） */}
                    {marks.map((m) => {
                      const isSel = selectedRegions.includes(m.r.id);
                      const isHover = hoveredRegionId === m.r.id;
                      const isDimmed = anyHover && !isHover && !isSel;
                      const opacity = isDimmed ? 0.2 : 1;
                      const title = `${m.r.object}${m.r.attributes ? ` — ${m.r.attributes}` : ''}${m.r.confidence ? ` · ${(m.r.confidence * 100).toFixed(0)}%` : ''}`;
                      return (
                        <div key={m.r.id}>
                          {/* 圆点：bbox 中心锚点 */}
                          <div
                            className="absolute z-10"
                            style={{
                              left: m.cx,
                              top: m.cy,
                              transform: 'translate(-50%, -50%)',
                              opacity,
                              transition: 'opacity var(--dur-fast) var(--ease-fast)',
                              cursor: 'pointer',
                            }}
                            onClick={(e) => { e.stopPropagation(); onToggleRegion?.(m.r.id); }}
                            onMouseEnter={() => setHoveredRegionId(m.r.id)}
                            onMouseLeave={() => setHoveredRegionId((cur) => (cur === m.r.id ? null : cur))}
                            title={title}
                          >
                            <div
                              className="rounded-full border-2"
                              style={{
                                width: isSel || isHover ? 14 : 10,
                                height: isSel || isHover ? 14 : 10,
                                borderColor: '#fff',
                                backgroundColor: isSel ? '#6054F1' : isHover ? 'rgba(96,84,241,0.9)' : 'rgba(96,84,241,0.65)',
                                boxShadow: '0 1px 5px rgba(0,0,0,0.55)',
                                transition: 'width var(--dur-fast) var(--ease-fast), height var(--dur-fast) var(--ease-fast)',
                              }}
                            />
                          </div>
                          {/* 标签：#label + 置信度 */}
                          <div
                            className="absolute z-10 flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-10 font-semibold"
                            style={{
                              left: m.lx,
                              top: m.ly,
                              transform: 'translate(-50%, -50%)',
                              opacity,
                              transition: 'opacity var(--dur-fast) var(--ease-fast)',
                              cursor: 'pointer',
                              backgroundColor: isSel ? 'rgba(96,84,241,0.95)' : isHover ? 'rgba(96,84,241,0.78)' : 'rgba(20,20,22,0.92)',
                              color: isSel || isHover ? '#fff' : '#C7BEFF',
                              border: isSel ? '1px solid rgba(96,84,241,0.95)' : isHover ? '1px solid rgba(96,84,241,0.8)' : '1px solid rgba(96,84,241,0.4)',
                              boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                            }}
                            onClick={(e) => { e.stopPropagation(); onToggleRegion?.(m.r.id); }}
                            onMouseEnter={() => setHoveredRegionId(m.r.id)}
                            onMouseLeave={() => setHoveredRegionId((cur) => (cur === m.r.id ? null : cur))}
                            title={title}
                          >
                            <span className="font-bold">#{m.r.label}</span>
                            {m.r.confidence != null && (
                              <span className="font-normal opacity-70">{(m.r.confidence * 100).toFixed(0)}%</span>
                            )}
                            {isSel && <Check className="h-2.5 w-2.5" />}
                          </div>
                        </div>
                      );
                    })}
                  </>
                );
              })()}

              {/* 区域列表面板：识别框交错难点击时，用列表精确点选（点击行 = 选中；hover 行 ↔ 图上框双向联动） */}
              {regionsOpen && regions.length > 0 && (
                <div
                  className="absolute right-3 top-3 z-30 flex max-h-[70%] w-[280px] flex-col overflow-hidden rounded-lg border"
                  style={{
                    backgroundColor: 'rgba(20,20,22,0.97)',
                    borderColor: 'rgba(96,84,241,0.4)',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
                  }}
                  onPointerDown={stopEvent}
                >
                  <div
                    className="flex shrink-0 items-center justify-between px-2.5 py-1.5 text-10.5 font-semibold uppercase tracking-wide"
                    style={{ color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    <span>Regions ({regions.length})</span>
                    <button
                      type="button"
                      onClick={() => setRegionsOpen(false)}
                      title="Close region list"
                      className="flex h-4 w-4 items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-1">
                    {regions.map((r) => {
                      const isSel = selectedRegions.includes(r.id);
                      const isHover = hoveredRegionId === r.id;
                      return (
                        <div
                          key={r.id}
                          onMouseEnter={() => setHoveredRegionId(r.id)}
                          onMouseLeave={() => setHoveredRegionId((cur) => (cur === r.id ? null : cur))}
                          onClick={() => onToggleRegion?.(r.id)}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 transition-colors"
                          style={{
                            backgroundColor: isSel ? 'rgba(96,84,241,0.22)' : isHover ? 'rgba(96,84,241,0.12)' : 'transparent',
                            border: isSel ? '1px solid rgba(96,84,241,0.55)' : '1px solid transparent',
                          }}
                          title={`${r.object}${r.attributes ? ` — ${r.attributes}` : ''}`}
                        >
                          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm" style={{ border: isSel ? '1px solid rgba(96,84,241,0.8)' : '1px dashed rgba(255,255,255,0.3)', backgroundColor: isSel ? 'rgba(96,84,241,0.4)' : 'transparent' }}>
                            {isSel && <Check className="h-2.5 w-2.5" style={{ color: '#fff' }} />}
                          </span>
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-11.5 font-semibold" style={{ color: '#e5e7ff' }}>
                            #{r.label}
                            {r.confidence != null && (
                              <span className="text-10 font-normal" style={{ color: 'rgba(255,255,255,0.45)' }}>
                                {(r.confidence * 100).toFixed(0)}%
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Semantic overlay: 预合成 PNG 直接贴出（不依赖 CSS mask-image，任何浏览器下 100% 生效）
                   · 保留区：深灰遮罩色覆盖 + 本层 img 的 backdrop-filter 在「遮罩不透明区域」对下方原图生效 → 降饱和+轻微模糊
                     → 白纸场景下「灰雾+模糊」= 一眼可见差异；深色照片场景下「灰罩+模糊」= 明确知道被盖住
                   · 编辑区：PNG 透明（透出下面原图清晰锐利）+ 叠一层暖色微光
                     → 白纸场景下挖洞看不到变化？不，有橙色微光立刻圈出编辑区位置 */}
              {semanticOverlayDataUrl && mode === 'edit' && (
                <img
                  src={semanticOverlayDataUrl}
                  alt=""
                  aria-hidden
                  draggable={false}
                  className="pointer-events-none absolute inset-0 rounded-lg block"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    // backdrop-filter 仅在「本层不透明像素」范围内对下方原图生效——
                    // 刚好只影响保留区（深灰不透明），编辑区（透明）不被 filter，
                    // 等于保留区自动"被压下去、变糊"，编辑区"清晰、被高亮"。
                    // 降饱和 0.42 + 模糊 1.6px：未选择区域视觉明显"变暗发灰"，与编辑区形成强对比。
                    backdropFilter: 'saturate(0.42) blur(1.6px) brightness(0.9)',
                    WebkitBackdropFilter: 'saturate(0.42) blur(1.6px) brightness(0.9)',
                  }}
                />
              )}

              {/* Brush overlay visual — 仅在笔刷/橡皮擦正在拖动（dragging）时显示紫色笔画即时反馈。
                   松开鼠标（dragging=false）后，紫色笔画层隐藏，统一由上方 Semantic white mask 承担
                   视觉呈现（编辑区透明、保留区白罩），保证语义与视觉一致。 */}
              {overlayDataUrl && mode === 'edit' && dragging && (maskTool === 'brush' || maskTool === 'eraser') && (
                <img
                  src={overlayDataUrl}
                  alt=""
                  aria-hidden
                  draggable={false}
                  className="pointer-events-none absolute inset-0 rounded-lg block"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              )}
            </div>

            {/* 生成中遮罩：背景明暗呼吸（imagegen-breathe），文字徽章保持清晰 */}
            {mode === 'generating' && (
              <div className="imagegen-breathe absolute inset-0 z-10 flex items-center justify-center">
                <div className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm" style={{ backgroundColor: 'rgba(0,0,0,0.75)', color: '#fff' }}>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating...
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ③ 底部控制栏（方案 C+：hideBottomBar=true 时不显示，由外部 Prompt Bar 浮层接管输入区） */}
      {!hideBottomBar && (
      <div
        className="shrink-0 overflow-hidden"
        style={{
          maxHeight: '520px',
          opacity: 1,
          transform: 'translateY(0)',
        }}
      >
        <div
          className="shrink-0 px-3 py-2.5"
          style={{
            backgroundColor: '#1c1c1e',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
          onPointerDown={stopEvent}
        >
          <div className="flex flex-col gap-2">
            {/* 风格预设 Pills 条 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-11 font-medium shrink-0" style={{ color: 'rgba(255,255,255,0.5)' }}>Presets:</span>
              {STYLE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="rounded-full border px-2 py-0.5 text-11 font-medium transition-opacity hover:opacity-85"
                  style={TONE_STYLES[p.tone]}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* 指令输入 + Negative 折叠 + 按钮 */}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                {/* 附件图片池（「添加附件」上传的本地图片；带 @ 标记表示已被引用） */}
                {aiMode === 'edit' && attachments.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {attachments.map((a) => {
                      const referenced = refIds.has(a.id);
                      return (
                        <span
                          key={a.id}
                          title={a.name}
                          className="group inline-flex items-center gap-1 rounded-md border px-1 py-0.5"
                          style={{
                            borderColor: referenced ? 'rgba(129,140,248,0.5)' : 'rgba(255,255,255,0.16)',
                            backgroundColor: referenced ? 'rgba(129,140,248,0.14)' : 'rgba(255,255,255,0.05)',
                          }}
                        >
                          <img src={a.dataUrl} alt="" className="h-6 w-6 shrink-0 rounded-sm object-cover" />
                          <span className="max-w-[90px] truncate text-11" style={{ color: 'rgba(255,255,255,0.82)' }}>{a.name}</span>
                          {referenced && <AtSign className="h-2.5 w-2.5 shrink-0" style={{ color: '#a5b4fc' }} />}
                          <button
                            type="button"
                            onClick={() => removeAttachment(a.id)}
                            title="Remove attachment"
                            className="ml-0.5 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                            style={{ color: 'rgba(255,255,255,0.6)' }}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="relative">
                  {/* @ 选中的参考图片缩略图：显示在输入框内顶部（作为修改当前预览图的参考素材） */}
                  {aiMode === 'edit' && refImages.length > 0 && (
                    <div className="absolute left-1.5 right-10 top-1.5 z-10 flex flex-wrap items-center gap-1">
                      {refImages.map((r) => (
                        <span
                          key={r.id}
                          title={`@ ${r.name}\n将以这张图为参考，修改当前预览图片`}
                          className="group inline-flex items-center gap-1 rounded-md border px-1 py-0.5"
                          style={{ backgroundColor: 'rgba(129,140,248,0.18)', borderColor: 'rgba(129,140,248,0.45)' }}
                        >
                          <img src={r.dataUrl} alt="" className="h-7 w-7 shrink-0 rounded-sm object-cover" />
                          <span className="max-w-[90px] truncate text-11" style={{ color: '#e0e7ff' }}>{r.name}</span>
                          <button
                            type="button"
                            onClick={() => removeRefImage(r.id)}
                            title="Remove reference image"
                            className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10"
                            style={{ color: 'rgba(255,255,255,0.7)' }}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {/* 文生图：比例标签显示在输入框内顶部 */}
                  {aiMode === 'generate' && (
                    <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1">
                      <span
                        title="Aspect ratio for generation"
                        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-11"
                        style={{ backgroundColor: 'rgba(129,140,248,0.18)', borderColor: 'rgba(129,140,248,0.45)', color: '#a5b4fc' }}
                      >
                        {ratio}
                      </span>
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    value={instruction}
                    onChange={(e) => { setInstruction(e.target.value); detectMention(e.target.value); }}
                    onKeyDown={(e) => {
                      if (mentionOpen) {
                        if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % Math.max(mentionFiltered.length, 1)); return; }
                        if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionFiltered.length) % Math.max(mentionFiltered.length, 1)); return; }
                        if (e.key === 'Enter') { e.preventDefault(); if (mentionFiltered[mentionIndex]) handleMentionSelect(mentionFiltered[mentionIndex]); return; }
                        if (e.key === 'Escape') { setMentionOpen(false); return; }
                      }
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); }
                      if (e.key === 'Escape') onCancel();
                    }}
                    placeholder={aiMode === 'generate' ? 'Describe the image to generate… e.g. a watercolor of an orange tabby with a hat' : 'Describe the edit… e.g. remove the coffee stain on the contract, keep signatures and all text untouched. Type @ to reference one of your uploaded attachment images.'}
                    rows={3}
                    className={`min-w-0 flex-1 w-full resize-none rounded-md border pr-10 text-sm outline-none pb-9 ${refImages.length > 0 ? 'pt-11' : aiMode === 'generate' ? 'pt-7' : 'pt-2'} ${aiMode === 'edit' ? 'pl-9' : 'pl-3'}`}
                    style={{ backgroundColor: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)', color: '#fff' }}
                  />
                  {/* 添加附件按钮：左下角（仅图生图模式） */}
                  {aiMode === 'edit' && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    title="Add attachment image"
                    className="absolute bottom-1.5 left-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-white/10"
                    style={{ color: 'rgba(255,255,255,0.6)' }}
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                  </button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => { addFilesAsAttachments(Array.from(e.target.files ?? [])); e.currentTarget.value = ''; }}
                  />
                  {/* 底部右侧工具栏：比例 → 模型 → Generate（Generate 位于输入框右下角） */}
                  <div className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-1.5">
                    {/* 文生图：比例设置下拉 */}
                    {aiMode === 'generate' && (
                      <select
                        value={ratio}
                        onChange={(e) => {
                          const r = RATIO_PRESETS.find((x) => x.label === e.target.value);
                          if (r) handleRatioSelect(r.label, r.size);
                        }}
                        title="Aspect ratio for generation"
                        className="max-w-[92px] rounded border bg-transparent px-1.5 py-1 text-11 outline-none"
                        style={{ borderColor: 'rgba(129,140,248,0.45)', color: '#a5b4fc' }}
                      >
                        {RATIO_PRESETS.map((r) => (
                          <option key={r.label} value={r.label} className="bg-neutral-900 text-neutral-200">{r.label}</option>
                        ))}
                      </select>
                    )}
                    {/* 模型下拉：候选来自 Settings 的 Image Edit Model；为空时显示占位提示，引导用户去设置配置 */}
                    <select
                      value={currentModel}
                      onChange={(e) => setCurrentModel(e.target.value)}
                      title={modelCandidates.length > 0 ? 'Image edit model' : '未配置模型，请到设置 → 图像编辑模型中添加'}
                      className="max-w-[140px] rounded border bg-transparent px-1.5 py-1 text-11 outline-none"
                      style={{
                        borderColor: modelCandidates.length > 0 ? 'rgba(255,255,255,0.15)' : 'rgba(251,191,36,0.5)',
                        color: modelCandidates.length > 0 ? 'rgba(255,255,255,0.85)' : 'rgba(251,191,36,0.8)',
                      }}
                    >
                      {modelCandidates.length === 0 ? (
                        <option value="" className="bg-neutral-900 text-amber-400">未配置模型</option>
                      ) : (
                        modelCandidates.map((m) => (
                          <option key={m} value={m} className="bg-neutral-900 text-neutral-200">{m}</option>
                        ))
                      )}
                    </select>
                    {/* Generate 按钮 */}
                    <button
                      type="button"
                      onClick={handleGenerate}
                      disabled={!instruction.trim() || mode === 'generating'}
                      title="Generate"
                      className="flex h-6 w-6 items-center justify-center rounded-md transition-opacity disabled:opacity-40"
                      style={{ backgroundColor: '#6366f1', color: '#fff' }}
                    >
                      {mode === 'generating'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Wand2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  {/* @ 参考图片选择弹窗 */}
                  {mentionOpen && (
                    <div
                      ref={mentionRef}
                      className="absolute bottom-full left-0 z-40 mb-1 w-full max-h-52 overflow-y-auto rounded-lg border shadow-2xl"
                      style={{ backgroundColor: '#2a2a2d', borderColor: 'rgba(255,255,255,0.14)' }}
                    >
                      {mentionFiltered.length === 0 ? (
                        <div className="px-3 py-2 text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
                          No attachments yet. Click the paperclip to upload an image first, then @ to reference it.
                        </div>
                      ) : (
                        mentionFiltered.map((f, i) => (
                          <button
                            key={f.id}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); handleMentionSelect(f); }}
                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
                            style={{ backgroundColor: i === mentionIndex ? 'rgba(129,140,248,0.22)' : 'transparent', color: '#fff' }}
                          >
                            <img src={f.dataUrl} alt="" className="h-5 w-5 shrink-0 rounded-sm object-cover" />
                            <AtSign className="h-3 w-3 shrink-0" style={{ color: '#a5b4fc' }} />
                            <span className="truncate">{f.name}</span>
                            {refIds.has(f.id) && <span className="ml-auto shrink-0 text-10" style={{ color: '#a5b4fc' }}>✓ added</span>}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                {/* Negative prompt — 可折叠（预设点击时自动展开 + 填充默认值）；行内右侧放模型下拉 */}
                <div
                  className="rounded-md border overflow-hidden"
                  style={{ backgroundColor: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.12)' }}
                >
                  <div className="flex items-center gap-1.5 pr-2">
                    <button
                      type="button"
                      onClick={() => setNegativeOpen((o) => !o)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left"
                      style={{ color: 'rgba(255,255,255,0.65)' }}
                    >
                      {negativeOpen
                        ? <ChevronDown className="h-3 w-3 shrink-0" />
                        : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <span className="truncate text-11 font-medium">
                        Negative prompt
                        {negativePrompt.trim() && <span style={{ color: 'rgba(251,191,36,0.9)' }}> · {negativePrompt.split(',').filter(Boolean).length} keywords</span>}
                      </span>
                    </button>
                  </div>
                  {negativeOpen && (
                    <textarea
                      value={negativePrompt}
                      onChange={(e) => setNegativePrompt(e.target.value)}
                      placeholder="What NOT to generate, e.g. blurry text, altered characters, watermark, distorted signatures…"
                      rows={2}
                      className="w-full resize-none rounded-none border-0 border-t px-2.5 py-1.5 text-xs outline-none"
                      style={{
                        backgroundColor: 'rgba(0,0,0,0.15)',
                        borderColor: 'rgba(255,255,255,0.1)',
                        color: 'rgba(255,255,255,0.85)',
                      }}
                    />
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {aiMode === 'edit' && (selection || overlayDataUrl) && (
                  <button
                    type="button"
                    onClick={clearMask}
                    title="Clear mask"
                    className="flex items-center justify-center rounded-md px-2 py-1.5 transition-colors hover:bg-white/10"
                    style={{ color: 'rgba(255,255,255,0.6)' }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {/* 手动保存已移除：生成结果在节点内通过 onImageChange 自动写入 homework/ 根目录，无需按钮 */}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* 上一版 vs 当前版 滑块对比面板（不走预览态，关闭即回到当前图） */}
      {compareOpen && prevImg && curImg && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.72)' }}
          onPointerMove={onSliderAreaMove}
          onPointerUp={onSliderHandleUp}
          onPointerCancel={onSliderHandleUp}
          onPointerDown={stopEvent}
          onWheel={stopEvent}
        >
          <div className="flex w-full max-w-3xl flex-col rounded-xl border shadow-2xl" style={{ backgroundColor: '#1c1c1e', borderColor: 'rgba(255,255,255,0.14)' }}>
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <SplitSquareVertical className="h-4 w-4" style={{ color: '#a5b4fc' }} />
              <span className="text-sm font-semibold" style={{ color: '#fff' }}>Compare Previous vs Current</span>
              <button
                type="button"
                onClick={() => setCompareOpen(false)}
                title="Close compare"
                className="ml-auto flex items-center justify-center rounded-md px-1.5 py-1 transition-colors hover:bg-white/10"
                style={{ color: 'rgba(255,255,255,0.7)' }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 select-none">
              <div ref={sliderAreaRef} className="relative max-h-[70vh] max-w-full">
                {/* Current (bottom layer, fully visible on right) */}
                <img
                  src={curImg}
                  alt="Current"
                  className="max-h-[70vh] max-w-full rounded-lg border object-contain block"
                  style={{ borderColor: 'rgba(255,255,255,0.12)', boxShadow: '0 10px 30px rgba(0,0,0,0.4)' }}
                  draggable={false}
                />
                {/* Previous (top layer, clipped to sliderX% on left) */}
                <img
                  src={prevImg}
                  alt="Previous"
                  className="absolute inset-0 max-h-[70vh] max-w-full rounded-lg border object-contain block"
                  style={{
                    borderColor: 'rgba(255,255,255,0)',
                    clipPath: `inset(0 ${100 - sliderX}% 0 0 round 8px)`,
                    WebkitClipPath: `inset(0 ${100 - sliderX}% 0 0 round 8px)`,
                  }}
                  draggable={false}
                />
                {/* 左右标签 */}
                <span
                  className="pointer-events-none absolute left-2 top-2 rounded-md px-2 py-1 text-11 font-bold tracking-wide"
                  style={{ backgroundColor: 'rgba(236,72,153,0.85)', color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}
                >
                  ◀ PREVIOUS
                </span>
                <span
                  className="pointer-events-none absolute right-2 top-2 rounded-md px-2 py-1 text-11 font-bold tracking-wide"
                  style={{ backgroundColor: 'rgba(16,185,129,0.85)', color: '#052e16', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}
                >
                  CURRENT ▶
                </span>

                {/* 滑块分割线：加粗 + 渐变 + 双侧发光 */}
                <div
                  className="pointer-events-none absolute top-0 bottom-0"
                  style={{
                    left: `calc(${sliderX}% - 2px)`,
                    width: '4px',
                    background: 'linear-gradient(180deg, #818CF8 0%, #6054F1 30%, #EC4899 70%, #818CF8 100%)',
                    borderRadius: 4,
                    boxShadow: '0 0 12px rgba(129,140,248,0.7), 0 0 24px rgba(236,72,153,0.35)',
                  }}
                />

                {/* 拖拽手柄：更大 + 箭头图标 + 脉冲光环 */}
                <div
                  onPointerDown={onSliderHandleDown}
                  className="absolute flex items-center justify-center cursor-ew-resize group/slider"
                  title="Drag to compare"
                  style={{
                    top: '50%',
                    left: `calc(${sliderX}% - 22px)`,
                    transform: 'translateY(-50%)',
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, #6054F1 0%, #8B5CF6 50%, #EC4899 100%)',
                    boxShadow: '0 4px 16px rgba(96,84,241,0.5), 0 0 0 4px rgba(255,255,255,0.12), 0 0 24px rgba(236,72,153,0.3)',
                    touchAction: 'none',
                    transition: 'box-shadow var(--dur-base) var(--ease-base)',
                  }}
                >
                  {/* 左箭头 */}
                  <span style={{ color: '#fff', fontSize: '0.933333rem', lineHeight: 1, marginRight: 1, opacity: 0.9, textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>‹</span>
                  {/* 右箭头 */}
                  <span style={{ color: '#fff', fontSize: '0.933333rem', lineHeight: 1, marginLeft: 1, opacity: 0.9, textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>›</span>
                </div>

                {/* 百分比气泡：跟随滑块，带引线 */}
                <div
                  className="pointer-events-none absolute flex flex-col items-center"
                  style={{
                    left: `calc(${sliderX}% - 20px)`,
                    top: 'calc(50% - 52px)',
                  }}
                >
                  <span
                    className="rounded-lg px-2.5 py-1 text-12 font-bold font-mono"
                    style={{
                      backgroundColor: 'rgba(96,84,241,0.92)',
                      color: '#fff',
                      boxShadow: '0 2px 10px rgba(96,84,241,0.4)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {sliderX.toFixed(0)}%
                  </span>
                </div>

                {/* 底部拖拽提示 */}
                <div
                  className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-10 font-medium"
                  style={{ backgroundColor: 'rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(4px)' }}
                >
                  ← Drag the handle to compare →
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Usage guide overlay */}
      {helpOpen && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.62)' }}
          onPointerDown={(e) => { stopEvent(e); setHelpOpen(false); }}
          onWheel={stopEvent}
        >
          <div
            className="flex max-h-[88%] w-full max-w-xl flex-col rounded-xl border shadow-2xl"
            style={{ backgroundColor: '#1c1c1e', borderColor: 'rgba(255,255,255,0.14)' }}
            onPointerDown={stopEvent}
          >
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <Wand2 className="h-4 w-4" style={{ color: '#a5b4fc' }} />
              <span className="text-sm font-semibold" style={{ color: '#fff' }}>AI Edit — Usage Guide</span>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                title="Close"
                className="ml-auto flex items-center justify-center rounded-md px-1.5 py-1 transition-colors hover:bg-white/10"
                style={{ color: 'rgba(255,255,255,0.7)' }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.75)' }}>
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full text-10 font-bold" style={{ backgroundColor: 'rgba(96,84,241,0.35)', color: '#e5e7ff' }}>1</span>
                <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: '#a5b4fc' }}>Mark the edit region</span>
              </div>
              <div className="flex flex-col gap-1.5 pl-1">
                {HELP_TOOL_ROWS.map(({ Icon, name, desc }) => (
                  <div key={name} className="flex items-start gap-2.5">
                    <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: '#c7d2fe' }}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span>
                      <span className="font-semibold" style={{ color: '#fff' }}>{name}</span>
                      {' — '}{desc}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 rounded-md border px-3 py-2" style={{ backgroundColor: 'rgba(96,84,241,0.10)', borderColor: 'rgba(96,84,241,0.32)' }}>
                The marked area is tinted purple — that is where the AI will regenerate. Everything else is dimmed and blurred and will be kept untouched. If you mark nothing, the whole image is edited. The brush size slider appears when Brush or Eraser is active.
              </div>

              <div className="mb-2 mt-4 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full text-10 font-bold" style={{ backgroundColor: 'rgba(96,84,241,0.35)', color: '#e5e7ff' }}>2</span>
                <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: '#a5b4fc' }}>Describe the edit</span>
              </div>
              <ul className="flex list-disc flex-col gap-1.5 pl-6">
                <li><span className="font-semibold" style={{ color: '#fff' }}>Presets</span> — Document Retouch, Clean Exhibit and Photo Enhance inject a professional prompt prefix plus safe default negative prompts. “+ Custom prompt…” just expands the negative prompt field.</li>
                <li><span className="font-semibold" style={{ color: '#fff' }}>Instruction</span> — describe exactly what to change. Press Enter to generate, Shift+Enter for a new line.</li>
                <li><span className="font-semibold" style={{ color: '#fff' }}>Negative prompt</span> — comma-separated keywords of what must NOT appear, e.g. blurry text, watermark, distorted signatures.</li>
                <li><span className="font-semibold" style={{ color: '#fff' }}>Model</span> — pick which image-edit model runs the request. Candidates come from Settings.</li>
              </ul>

              <div className="mb-2 mt-4 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full text-10 font-bold" style={{ backgroundColor: 'rgba(96,84,241,0.35)', color: '#e5e7ff' }}>3</span>
                <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: '#a5b4fc' }}>Generate &amp; iterate</span>
              </div>
              <div className="flex flex-col gap-1.5 pl-1">
                <div className="flex items-start gap-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'rgba(99,102,241,0.28)', color: '#e5e7ff' }}>
                    <Wand2 className="h-3.5 w-3.5" />
                  </span>
                  <span><span className="font-semibold" style={{ color: '#fff' }}>Generate</span> — send the image, mask and prompt to the AI model. The result automatically becomes the current working image.</span>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: '#c7d2fe' }}>
                    <Wand2 className="h-3.5 w-3.5" />
                  </span>
                  <span><span className="font-semibold" style={{ color: '#fff' }}>Iterate</span> — type another instruction in the input box and generate again. No preview step, no mode switching.</span>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: '#c7d2fe' }}>
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                  <span><span className="font-semibold" style={{ color: '#fff' }}>New</span> — clear the working image and start fresh from text or an uploaded image.</span>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: '#c7d2fe' }}>
                    <SplitSquareVertical className="h-3.5 w-3.5" />
                  </span>
                  <span><span className="font-semibold" style={{ color: '#fff' }}>Compare</span> — drag the slider to diff the previous version against the current one at pixel level. Close it to return to the current image.</span>
                </div>
              </div>

              <div className="mb-2 mt-4 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full text-10 font-bold" style={{ backgroundColor: 'rgba(96,84,241,0.35)', color: '#e5e7ff' }}>4</span>
                <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: '#a5b4fc' }}>Save &amp; Persistence</span>
              </div>
              <div className="flex flex-col gap-1.5 pl-1">
                <div className="flex items-start gap-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'rgba(52,211,153,0.18)', color: '#6ee7b7' }}>
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span>Generation results are <span className="font-semibold" style={{ color: '#fff' }}>saved automatically</span> under <code style={{ padding: '1px 4px', borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)', color: '#ddd6fe', fontSize: '0.8rem' }}>homework</code> as soon as the request succeeds, and the result becomes the new working image so you can iterate right away.</span>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: '#c7d2fe' }}>
                    <X className="h-3.5 w-3.5" />
                  </span>
                  <span>Click <span className="font-semibold" style={{ color: '#fff' }}>Close (×)</span> in the top-right corner to collapse the guide. Esc also closes any overlay.</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
