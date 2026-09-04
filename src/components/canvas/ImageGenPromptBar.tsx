'use client';

/**
 * ImageGen Prompt Bar —— 方案 C+ 独立底栏
 *
 *  作为 React Portal 挂在 document.body，显示在 viewport 底部中央。
 *  仅在当前 ImageGenNode selected=true 时渲染；切换节点/点空白自动消失。
 *
 *  包含：Style Presets | Prompt 输入区（含 @附件引用） | Ratio 选择器 | Model 选择器
 *        | Negative（折叠展开） | @附件上传 | Generate 按钮
 *
 *  @引用系统：
 *   · 附件池由父组件 ImageGenNode 管理（attmchments / onAttachmentsChange）
 *   · 在 textarea 输入 @ → 弹出附件列表（键盘 ↑↓ + Enter 选择）
 *   · 选中后插入 @文件名 到文本 + 加入 refIds
 *   · 生成时：只有 @ 引用的附件作为 references 传给 API；未引用的不传
 *   · 参考图标签可单独移除（× → 解除引用，附件仍留在池中）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Wand2, ChevronDown, ChevronRight, Paperclip, X, Sparkles, Check, List, Layers, Upload, Box as Cube } from 'lucide-react';
import { loadSettings, saveSettings, getImageModelCandidates, type NegativeTemplate } from '@/lib/settings';
import type { MutableRefObject } from 'react';
import type { ImageGenNodeData, RegionRef } from '@/lib/types';

/**
 * 使用本地 state 缓冲 prompt 文本，避免每次 onChange 都 onPatch 回写节点 →
 * 节点重渲染 → textarea DOM 重建 → IME（中文输入法）composition 被打断。
 * 仅在 blur / generate / composition end 时同步回节点 data。
 */
import {
  STYLE_PRESETS,
  RATIO_PRESETS,
  type ImageGenApiRef,
  type AttachmentImage,
  type TriplotResult,
} from './viewers/ImageAiEditor';

export interface ImageGenPromptBarProps {
  /** 节点标题（只用于按钮 title 和 placeholder hint） */
  nodeTitle: string;
  /** 节点数据，Prompt Bar 直接从中读 prompt/negative/size/model 显示 */
  data: ImageGenNodeData;
  /** 把局部字段写回节点 store（会持久化） */
  onPatch: (partial: Partial<ImageGenNodeData>) => void;
  /** ImageAiEditor 暴露的 ref：调用 runGenerate 触发生成；同步 attachments 到编辑器内部 refImages 池 */
  editorRef: MutableRefObject<ImageGenApiRef | null>;
  /** 生成成功时节点层要做的事情（保存到 homework/ 根目录等）；image 为 dataUrl 或 null（若 onImageChange 已写回 inputImage） */
  onGenerated: (image: string | null) => void;
  /** 三视图生成成功时回调：返回 3 个视角的图 + prompt，父级负责保存到版本组 */
  onTriplotGenerated?: (triplot: TriplotResult) => void;
  /** 附件池（由父组件 ImageGenNode 管理，共享给 HistoryModal） */
  attachments: AttachmentImage[];
  /** 附件池变更回调 */
  onAttachmentsChange: (a: AttachmentImage[]) => void;
  /** 点击 #chip 移除引用（与图上高亮框选中态双向同步） */
  onToggleRegion?: (id: string) => void;
}

/** 风格 chip 不同 tone 的配色（沿用 ImageAiEditor 的 PRESET_TONE 调色板） */
const PRESET_TONE: Record<
  'brand' | 'accent' | 'warn' | 'ok' | 'neutral',
  { backgroundColor: string; color: string; borderColor: string }
> = {
  brand: { backgroundColor: 'rgba(96,84,241,0.18)', color: '#C7BEFF', borderColor: 'rgba(96,84,241,0.45)' },
  accent: { backgroundColor: 'rgba(236,72,153,0.12)', color: '#F9A8D4', borderColor: 'rgba(236,72,153,0.35)' },
  warn: { backgroundColor: 'rgba(245,158,11,0.12)', color: '#FCD34D', borderColor: 'rgba(245,158,11,0.32)' },
  ok: { backgroundColor: 'rgba(16,185,129,0.12)', color: '#6EE7B7', borderColor: 'rgba(16,185,129,0.32)' },
  neutral: { backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.75)', borderColor: 'rgba(255,255,255,0.18)' },
};

/** 常用 negative 提示词模板：点击后整体替换当前 negative 内容 */
const NEGATIVE_TEMPLATES: { id: string; label: string; keywords: string }[] = [
  {
    id: 'cleanup',
    label: 'Cleanup',
    keywords: 'text, watermark, signature, border, blurry, low quality',
  },
  {
    id: 'person',
    label: 'Fix Person',
    keywords: 'deformed hands, extra fingers, missing fingers, distorted face, asymmetrical eyes',
  },
  {
    id: 'product',
    label: 'Clean Product',
    keywords: 'text, watermark, background clutter, harsh shadows, reflections, noise',
  },
  {
    id: 'illustration',
    label: 'Illustration Style',
    keywords: 'photorealistic, realistic skin texture, text, logo',
  },
  {
    id: 'scene',
    label: 'Clean Scene',
    keywords: 'people, text, watermark, vehicles, power lines, trash',
  },
];

/** Triplot 默认提示词模板：点击 Triplot 开关开启三视图且输入框为空时注入（用户可修改后再点 Generate）。
 *  描述主体对象即可——runTriplotGenerate 会自动拼接 front/side/top 各视角指令。 */
const TRIPLOT_DEFAULT_PROMPT =
  'a minimalist ceramic coffee mug, matte finish, ergonomic handle, solid color, studio product photography, clean white background, soft even lighting';

/** 从 imageEdit + Model Pool 构造模型候选（共用 getImageModelCandidates：角色池 / chips / Model Pool 图像绑定）。
 *  任何来源的模型都可见，本地无鉴权厂商（BobMultimodal/Ollama）在 Model Pool 绑定后无需再进角色池。 */
function readModelCandidates(settings: Awaited<ReturnType<typeof loadSettings>>): string[] {
  return getImageModelCandidates(settings);
}

/** 以 RATIO_PRESETS 反查 size → label */
function sizeToRatioLabel(size: string): string {
  const hit = RATIO_PRESETS.find((r) => r.size === size);
  return hit?.label ?? 'Custom';
}

/** 把本地文件读为 dataUrl（供 @附件上传） */
function fileToDataUrl(file: File): Promise<AttachmentImage> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error('Failed to read file'));
    fr.onload = () => resolve({
      id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      dataUrl: String(fr.result ?? ''),
    });
    fr.readAsDataURL(file);
  });
}

/** 屏幕 rect：供下拉弹窗 Portal fixed 定位使用 */
type DRect = { top: number; left: number; right: number; bottom: number; width: number; height: number };

/** 自定义 Hook：打开下拉时同步锚点 DOM 的屏幕 rect（ResizeObserver + resize + rAF 轮询）。
 *  含阈值检查：位置变化 < 0.5px 时不更新 state，避免无谓重渲染导致输入框闪烁。 */
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
          return prev; // 位置未变（< 0.5px），跳过更新
        }
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      });
    };
    compute();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    if (ro && ref.current) ro.observe(ref.current);
    window.addEventListener('resize', compute);
    // rAF 轮询：比 setInterval 更平滑，且页面隐藏时自动暂停
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

/** offset 是否落在 chip（@附件 / #区域）的标签文本内部。
 *  chips 是 contentEditable=false 的 span，其 label 文本（如 @logo.png）会被计入 textContent，
 *  若光标恰好停在 chip 之后，去掉「@ 须有前导空格」的限制后会误把 chip 标签当作新输入的 @，这里需排除。 */
function isInsideChipLabel(el: HTMLElement, offset: number): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let acc = 0;
  // eslint-disable-next-line no-cond-assign
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (offset < acc + len) {
      const parent = node.parentElement;
      if (parent && (parent.dataset.attachment || parent.dataset.region)) return true;
      return false;
    }
    acc += len;
  }
  return false;
}

/** 检测 contentEditable 中光标前是否有 @ 触发 mention。
 *  不要求前导空格：紧跟任意字符输入 @（如 cat@）也会弹出——修复「已输入文字后输入 @ 不弹窗」。
 *  若匹配到的 @ 落在已有 chip 标签内部则忽略（见 isInsideChipLabel）。 */
function detectMention(el: HTMLElement, text: string, cursorPos: number): { open: boolean; query: string; startIndex: number } {
  const beforeCursor = text.slice(0, cursorPos);
  const match = beforeCursor.match(/@([^\s@]*)$/);
  if (!match) return { open: false, query: '', startIndex: -1 };
  const atIndex = match.index ?? 0;
  if (isInsideChipLabel(el, atIndex)) return { open: false, query: '', startIndex: -1 };
  return { open: true, query: match[1], startIndex: atIndex };
}

/** 检测 contentEditable 中光标前是否有 # 触发区域引用（与 @ mention 对称，不要求前导空格；
 *  允许中英文/数字标签，空格/@/# 前停止；若 # 落在已有 chip 标签内部则忽略） */
function detectRegionTag(el: HTMLElement, text: string, cursorPos: number): { open: boolean; query: string; startIndex: number } {
  const beforeCursor = text.slice(0, cursorPos);
  // 之后只允许非空白/非@/非#字符——避免 @#、## 或 中间空格
  const match = beforeCursor.match(/#([^\s#@]*)$/);
  if (!match) return { open: false, query: '', startIndex: -1 };
  const atIndex = match.index ?? 0;
  if (isInsideChipLabel(el, atIndex)) return { open: false, query: '', startIndex: -1 };
  return { open: true, query: match[1], startIndex: atIndex };
}

/** 获取 contentEditable 中光标相对 textContent 的偏移（无光标/不在元素内 → 末尾） */
function getTextCursorOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return el.textContent?.length ?? 0;
  const range = sel.getRangeAt(0).cloneRange();
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

/** 在 contentEditable 中按 textContent 偏移 [start, end) 构建选区（供替换/插入用） */
function selectRangeByOffsets(el: Node, start: number, end: number): Range | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Node | null = null;
  let startOff = 0;
  let endNode: Node | null = null;
  let endOff = 0;
  let node: Node | null;
  // eslint-disable-next-line no-cond-assign
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (!startNode && offset + len >= start) {
      startNode = node;
      startOff = Math.max(0, start - offset);
    }
    if (!endNode && offset + len >= end) {
      endNode = node;
      endOff = Math.max(0, end - offset);
      break;
    }
    offset += len;
  }
  if (!startNode || !endNode) return null;
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

/** 创建 #region chip span（contentEditable=false 整块删除，含标签 + × 移除按钮） */
function createRegionChip(reg: RegionRef, onRemove: (id: string) => void): HTMLSpanElement {
  const span = document.createElement('span');
  span.dataset.region = reg.id;
  span.contentEditable = 'false';
  span.setAttribute('class', 'region-chip');
  const label = document.createElement('span');
  label.textContent = `#${reg.label}`;
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '×';
  del.title = `Remove ${reg.label} reference`;
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    span.remove();
    onRemove(reg.id);
  });
  span.appendChild(label);
  span.appendChild(del);
  return span;
}

/** 创建 @附件 chip span（contentEditable=false 整块删除，含标签 + × 移除按钮）。
 *  与 #region chip 视觉统一；textContent 为 @文件名，保证与 localPrompt 文本镜像一致。 */
function createAttachmentChip(att: AttachmentImage, onRemove: (id: string) => void): HTMLSpanElement {
  const span = document.createElement('span');
  span.dataset.attachment = att.id;
  span.contentEditable = 'false';
  span.setAttribute('class', 'region-chip');
  const label = document.createElement('span');
  label.textContent = `@${att.name}`;
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '×';
  del.title = `Remove ${att.name} reference`;
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    span.remove();
    onRemove(att.id);
  });
  span.appendChild(label);
  span.appendChild(del);
  return span;
}

export function ImageGenPromptBar(props: ImageGenPromptBarProps) {
  return <ImageGenPromptBarInner {...props} />;
}

/** React.memo 隔离：父组件 ImageGenNode 因 120ms 位置轮询导致 promptBarScreen 变化而重渲染时，
 *  只要 data / onPatch / onGenerated 等 props 引用未变，PromptBar 不重渲染——
 *  避免 contentEditable DOM 被无谓重建导致输入框闪烁。 */
const ImageGenPromptBarInner = React.memo(function ImageGenPromptBarInner({
  nodeTitle,
  data,
  onPatch,
  editorRef,
  onGenerated,
  onTriplotGenerated,
  attachments,
  onAttachmentsChange,
  onToggleRegion,
}: ImageGenPromptBarProps) {
  const {
    prompt = '',
    negativePrompt = '',
    size = '1024x1024',
    model: modelSel = '',
    mode: nodeMode = 'generate',
    inputImage,
    regions = [],
    selectedRegions = [],
  } = data;

  const textareaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 记录上一次已同步到 DOM 的选中区域 id，避免 effect 循环 */
  const syncedRegionIdsRef = useRef<Set<string>>(new Set());

  // Portal 挂载点：始终挂 document.body，彻底脱离父级 overflow:hidden 裁剪域
  const portal = useMemo<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null;
    return document.body;
  }, []);

  // 5 个下拉的触发锚点
  const presetBtnRef = useRef<HTMLButtonElement>(null);
  const ratioBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const negativeWrapRef = useRef<HTMLDivElement>(null); // negative 展开区（template 下拉锚点）
  const mentionAnchorRef = useRef<HTMLDivElement>(null); // mention 锚点：行 2 容器

  const [presetRect, setPresetRect] = useState<DRect | null>(null);
  const [ratioRect, setRatioRect] = useState<DRect | null>(null);
  const [modelRect, setModelRect] = useState<DRect | null>(null);
  const [templateRect, setTemplateRect] = useState<DRect | null>(null);
  const [mentionRect, setMentionRect] = useState<DRect | null>(null);
  const [regionTagRect, setRegionTagRect] = useState<DRect | null>(null);

  const [negativeOpen, setNegativeOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [customTemplates, setCustomTemplates] = useState<NegativeTemplate[]>([]);
  const [templateLabel, setTemplateLabel] = useState('');
  const [ratioOpen, setRatioOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // @ 引用相关状态
  const [refIds, setRefIds] = useState<Set<string>>(new Set());
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionQuery, setMentionQuery] = useState('');

  // # 区域引用相关状态（主动输入通道，与 @ mention 对称）
  const [regionTagOpen, setRegionTagOpen] = useState(false);
  const [regionTagIdx, setRegionTagIdx] = useState(0);
  const [regionTagQuery, setRegionTagQuery] = useState('');

  /** fs(px) → 像素字符串。ImageGen 不单独提供字号调整：字号固定为 15px 系基准
   *  （主输入 = 15px，跟随全局 M 档 --fs-md: 15px），全局字号由
   *  Settings → Theme & Appearance → Font Size 统一控制（CSS 变量 --fs-*）。 */
  const fs = useCallback((px: number) => `${Math.round(px * (15 / 13) * 10) / 10}px`, []);

  // 下拉锚点矩形同步（portal 定位依赖这些 state，须在声明之后调用）
  useSyncAnchorRect(presetOpen, presetBtnRef, setPresetRect);
  useSyncAnchorRect(ratioOpen, ratioBtnRef, setRatioRect);
  useSyncAnchorRect(modelOpen, modelBtnRef, setModelRect);
  useSyncAnchorRect(templateOpen, negativeWrapRef, setTemplateRect);

  // ── IME 本地缓冲：防止 onPatch 回写节点导致 textarea 重渲染、焦点丢失 ──
  const [localPrompt, setLocalPrompt] = useState(prompt);
  const isComposingRef = useRef(false);
  // 当外部 prompt 被清空（generate 成功后 onPatch({prompt:''})) 时同步本地
  useEffect(() => {
    if (!isComposingRef.current && prompt !== localPrompt) {
      setLocalPrompt(prompt);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);

  // ── #chip 双向同步：selectedRegions（node 层） ↔ contentEditable DOM ──
  // 图上点击高亮框 → selectedRegions 变化 → 插入/移除 DOM chip；
  // 用户删除 chip → onToggleRegion → node 更新 → 本 effect 检测 DOM 已无该 chip，不重复。
  const syncRegionChips = useCallback((el: HTMLDivElement | null, targetIds: string[]) => {
    if (!el) return;
    const existing = new Set<string>();
    el.querySelectorAll<HTMLSpanElement>('span[data-region]').forEach((s) => {
      const rid = s.dataset.region;
      if (rid) existing.add(rid);
    });
    const target = new Set(targetIds);
    // 移除多余的 chip（用户删除或图上取消）
    el.querySelectorAll<HTMLSpanElement>('span[data-region]').forEach((s) => {
      const rid = s.dataset.region;
      if (rid && !target.has(rid)) s.remove();
    });
    // 插入缺失的 chip（图上新增选中）
    for (const rid of targetIds) {
      if (existing.has(rid) || syncedRegionIdsRef.current.has(rid)) continue;
      const reg = regions.find((r) => r.id === rid);
      if (!reg) continue;
      const span = createRegionChip(reg, (id) => {
        syncedRegionIdsRef.current.delete(id);
        onToggleRegion?.(id);
      });
      // 插入到光标处（无光标/不在本元素内则追加到末尾）
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        range.insertNode(span);
        // 光标移到 chip 之后
        range.setStartAfter(span);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(document.createTextNode(' '));
        el.appendChild(span);
        el.appendChild(document.createTextNode(' '));
      }
      syncedRegionIdsRef.current.add(rid);
    }
    setLocalPrompt(el.textContent ?? '');
  }, [regions, onToggleRegion]);

  // 值比较 ref：防止 selectedRegions 引用变了但值没变时无谓跑 syncRegionChips → 重建 DOM → 闪烁
  const lastSelectedRegionsKey = useRef('');
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const selIds = selectedRegions ?? [];
    const key = selIds.join(',');
    if (key === lastSelectedRegionsKey.current) return; // 值未变，跳过
    lastSelectedRegionsKey.current = key;
    syncRegionChips(el, selIds);
    // 记录本次同步状态
    const current = new Set(selIds);
    syncedRegionIdsRef.current = new Set([...syncedRegionIdsRef.current].filter((x) => current.has(x)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRegions, regions]);

  // ── 文本镜像 → DOM 渲染：外部修改 localPrompt（预设前缀 / 移除@引用 / 生成清空 / 外部 prompt 变化）
  //    时，把 plain text 重建进 contentEditable —— 其中命中了选中区域的 #label 记号渲染为 chip span，
  //    保证 DOM 文本与 localPrompt 始终一致且 chip 不丢失。
  const renderPromptToDom = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const text = localPrompt;
    const selIds = new Set(selectedRegions ?? []);
    const refIdSet = new Set(refIds);
    el.innerHTML = '';
    // 候选合并：区域 #chip + @附件 chip，按 label 长度降序，优先匹配长标签，避免「car」被「scar」内短标签抢先
    const candidates: Array<{ type: 'region' | 'attachment'; id: string; label: string }> = [
      ...(regions ?? [])
        .filter((r) => selIds.has(r.id))
        .map((r) => ({ type: 'region' as const, id: r.id, label: `#${r.label}` })),
      ...attachments
        .filter((a) => refIdSet.has(a.id))
        .map((a) => ({ type: 'attachment' as const, id: a.id, label: `@${a.name}` })),
    ].sort((a, b) => b.label.length - a.label.length);
    let rest = text;
    while (rest.length > 0) {
      let matched: typeof candidates[number] | null = null;
      let matchIdx = -1;
      for (const c of candidates) {
        const idx = rest.indexOf(c.label);
        if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
          matched = c;
          matchIdx = idx;
        }
      }
      if (!matched) break;
      if (matchIdx > 0) el.appendChild(document.createTextNode(rest.slice(0, matchIdx)));
      if (matched.type === 'region') {
        const reg = regions?.find((r) => r.id === matched!.id);
        if (reg) {
          el.appendChild(createRegionChip(reg, (id) => {
            syncedRegionIdsRef.current.delete(id);
            onToggleRegion?.(id);
          }));
        } else {
          el.appendChild(document.createTextNode(matched.label));
        }
      } else {
        const att = attachments.find((a) => a.id === matched!.id);
        if (att) {
          el.appendChild(createAttachmentChip(att, (id) => {
            // 彻底删除：从 attachments 池 + refIds 移除，同步镜像与节点
            onAttachmentsChange(attachments.filter((x) => x.id !== id));
            setRefIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
            const after = textareaRef.current?.textContent ?? '';
            setLocalPrompt(after);
            onPatch({ prompt: after });
          }));
        } else {
          el.appendChild(document.createTextNode(matched.label));
        }
      }
      rest = rest.slice(matchIdx + matched.label.length);
    }
    if (rest.length > 0) el.appendChild(document.createTextNode(rest));
    syncedRegionIdsRef.current = new Set(selIds);
    // 光标移到末尾
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [localPrompt, regions, selectedRegions, refIds, attachments, onToggleRegion, onPatch]);

  // 文本镜像变化 → 重建 DOM（跳过 IME 组合中，避免打断中文输入）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (isComposingRef.current) return;
    if ((el.textContent ?? '') !== localPrompt) {
      renderPromptToDom();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPrompt]);

  // ① 读取模型候选 + 自定义 negative 模板（首次 mount + settings 变更事件刷新）
  const reloadModels = useCallback(async () => {
    try {
      const s = await loadSettings();
      setModelCandidates(readModelCandidates(s));
      setCustomTemplates(s.imageEdit?.negativeTemplates ?? []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    reloadModels();
    const handler = () => reloadModels();
    window.addEventListener('provider-configs-changed', handler);
    return () => window.removeEventListener('provider-configs-changed', handler);
  }, [reloadModels]);

  // ② 初始化默认模型：若 model 空且 candidates 非空，把第一个写回节点（保证下拉选中态）
  useEffect(() => {
    if (!modelSel && modelCandidates[0]) {
      onPatch({ model: modelCandidates[0] });
    }
  }, [modelCandidates, modelSel, onPatch]);

  // ③ 只把 @ 引用的附件同步给编辑器内部 refImages（作为图生图 references）
  const referencedAttachments = useMemo(
    () => attachments.filter((a) => refIds.has(a.id)),
    [attachments, refIds],
  );
  useEffect(() => {
    editorRef.current?.setAttachments(referencedAttachments);
  }, [referencedAttachments, editorRef]);

  // ④ 自动聚焦：弹窗出来就聚焦到输入框
  useEffect(() => {
    const t = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  // ———————— 辅助：应用风格预设 ————————
  const applyPreset = useCallback((preset: typeof STYLE_PRESETS[number]) => {
    const p = `${preset.prefix}${localPrompt}`;
    const np = preset.defaultNegative && !negativePrompt ? preset.defaultNegative : negativePrompt;
    setLocalPrompt(p);
    onPatch({ prompt: p, negativePrompt: np });
  }, [localPrompt, negativePrompt, onPatch]);

  // ———————— 自定义 negative 模板：保存当前 negative 为新模板 ————————
  const saveCustomTemplate = useCallback(async (label: string) => {
    const text = negativePrompt.trim();
    if (!text) return;
    const tpl: NegativeTemplate = {
      id: `neg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: label.trim() || `Custom ${customTemplates.length + 1}`,
      keywords: text,
    };
    try {
      const s = await loadSettings();
      const next = [...(s.imageEdit?.negativeTemplates ?? []), tpl];
      await saveSettings({ ...s, imageEdit: { ...s.imageEdit, negativeTemplates: next } });
      setCustomTemplates(next);
      setTemplateLabel('');
      setTemplateOpen(false);
    } catch { /* ignore */ }
  }, [negativePrompt, customTemplates.length]);

  // ———————— 自定义 negative 模板：删除 ————————
  const deleteCustomTemplate = useCallback(async (id: string) => {
    const next = customTemplates.filter((t) => t.id !== id);
    try {
      const s = await loadSettings();
      await saveSettings({ ...s, imageEdit: { ...s.imageEdit, negativeTemplates: next } });
      setCustomTemplates(next);
    } catch { /* ignore */ }
  }, [customTemplates]);

  // ———————— 辅助：尺寸切换 ————————
  const pickSize = useCallback((s: string) => {
    onPatch({ size: s });
    setRatioOpen(false);
  }, [onPatch]);

  // ———————— 辅助：模型切换 ————————
  const pickModel = useCallback((m: string) => {
    onPatch({ model: m });
    setModelOpen(false);
  }, [onPatch]);

  // ———————— @ Mention：选择附件作为参考图 ————————
  const filteredMentions = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.toLowerCase();
    return attachments.filter((a) => a.name.toLowerCase().includes(q));
  }, [mentionOpen, mentionQuery, attachments]);

  // mention 下拉位置同步：依赖 mentionOpen（附件为空时也需锚点，显示空状态提示）
  useSyncAnchorRect(mentionOpen, mentionAnchorRef, setMentionRect);

  // ———————— # Region：选择区域引用 ————————
  const filteredRegions = useMemo(() => {
    if (!regionTagOpen) return [];
    const q = regionTagQuery.toLowerCase();
    const selIds = new Set(selectedRegions ?? []);
    // 候选：所有 regions（包括已选，避免 # 输入找不到；显示 REF badge 区分）
    return (regions ?? []).filter((r) =>
      !q || r.label.toLowerCase().includes(q) || (r.object ?? '').toLowerCase().includes(q),
    );
  }, [regionTagOpen, regionTagQuery, regions, selectedRegions]);

  // region 下拉位置同步：复用 mentionAnchorRef（行 2 容器），与 @ 弹出同样的锚点
  useSyncAnchorRect(regionTagOpen && filteredRegions.length > 0, mentionAnchorRef, setRegionTagRect);

  const selectMention = useCallback((attachment: AttachmentImage) => {
    const el = textareaRef.current;
    if (!el) return;
    // 直接从 DOM 读文本（localPrompt 是 state 快照，键盘连打时可能滞后一帧）
    const newText = el.textContent ?? '';
    const cursorPos = getTextCursorOffset(el);
    const mention = detectMention(el, newText, cursorPos);
    if (!mention.open) return;

    // 选中 @query 文本并替换为 @附件 chip（contentEditable=false 整块，可一键 × 删除）
    const chip = createAttachmentChip(attachment, (id) => {
      // × 删除：chip 已被 del click 从 DOM 移除 → 彻底删除（从 attachments 池 + refIds + 同步镜像）
      const afterEl = textareaRef.current;
      onAttachmentsChange(attachments.filter((x) => x.id !== id));
      setRefIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      const after = afterEl?.textContent ?? '';
      setLocalPrompt(after);
      onPatch({ prompt: after });
    });
    const range = selectRangeByOffsets(el, mention.startIndex, cursorPos);
    const sel = window.getSelection();
    if (range) {
      range.deleteContents();
      range.insertNode(chip);
      // 光标移到 chip 之后
      range.setStartAfter(chip);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else {
      // 兜底：向末尾追加
      el.appendChild(document.createTextNode(' '));
      el.appendChild(chip);
      el.appendChild(document.createTextNode(' '));
    }

    // 替换后 DOM 已更新：重新读取最终文本作为本地镜像与节点。
    // 必须用替换后的文本（而非开头读取的 newText），否则本地镜像与 DOM 失配，
    // 会被文本镜像 effect 用旧值重建而抹掉刚插入的 @附件 chip。
    const finalText = el.textContent ?? '';
    setLocalPrompt(finalText);
    onPatch({ prompt: finalText });

    // Add to refIds
    setRefIds((prev) => new Set(prev).add(attachment.id));

    // Close mention
    setMentionOpen(false);
    setMentionQuery('');
    setMentionIdx(0);
    el.focus();
  }, [onPatch]);

  // ———————— 辅助：附件上传 ————————
  const onFilesChosen = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const pending: Promise<AttachmentImage>[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const f = list.item(i);
      if (f) pending.push(fileToDataUrl(f));
    }
    const items = await Promise.all(pending);
    const next = [...attachments, ...items];
    onAttachmentsChange(next);
    // @ mention 弹窗打开时：上传完成后自动把第一个新附件插入 prompt（弹窗内直接插入）
    if (mentionOpen && items[0]) {
      selectMention(items[0]);
    }
  }, [attachments, onAttachmentsChange, mentionOpen, selectMention]);

  // ———————— # Tag：选择区域插入 #chip ————————
  const selectRegion = useCallback((reg: RegionRef) => {
    const el = textareaRef.current;
    if (!el) return;
    // 如果该区域尚未选中，先把它推入 selectedRegions（与 图上点击框行为一致）
    if (!selectedRegions?.includes(reg.id)) onToggleRegion?.(reg.id);

    const newText = el.textContent ?? '';
    const cursorPos = getTextCursorOffset(el);
    const tag = detectRegionTag(el, newText, cursorPos);

    const chip = createRegionChip(reg, (id) => {
      syncedRegionIdsRef.current.delete(id);
      onToggleRegion?.(id);
    });

    if (tag.open) {
      const range = selectRangeByOffsets(el, tag.startIndex, cursorPos);
      const sel = window.getSelection();
      if (range) {
        range.deleteContents();
        range.insertNode(chip);
        range.setStartAfter(chip);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
      } else {
        el.appendChild(document.createTextNode(' '));
        el.appendChild(chip);
        el.appendChild(document.createTextNode(' '));
      }
    } else {
      // 兜底：无 # 触发 → 在光标处插入空格 + chip
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        // 光标前若不是空白，补一个空格（避免 chip 与前面文字粘连）
        const textBefore = newText.slice(0, getTextCursorOffset(el));
        if (textBefore.length > 0 && !/\s$/.test(textBefore)) {
          range.insertNode(document.createTextNode(' '));
          range.setStartAfter(range.endContainer);
        }
        range.insertNode(chip);
        range.insertNode(document.createTextNode(' '));
        range.setStartAfter(chip);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(document.createTextNode(' '));
        el.appendChild(chip);
        el.appendChild(document.createTextNode(' '));
      }
    }

    syncedRegionIdsRef.current.add(reg.id);
    const finalText = el.textContent ?? '';
    setLocalPrompt(finalText);
    onPatch({ prompt: finalText });

    setRegionTagOpen(false);
    setRegionTagQuery('');
    setRegionTagIdx(0);
    el.focus();
  }, [onToggleRegion, selectedRegions, onPatch]);

  // ———————— textarea onChange：检测 @ mention + # region tag + 键盘删除 chip ————————
  const onTextareaChange = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const newText = el.textContent ?? '';
    setLocalPrompt(newText);
    // 键盘（Backspace/Delete）删掉 chip → 该区域从 DOM 消失 → 取消 node 层选中，保持双向一致
    if (onToggleRegion && selectedRegions.length > 0) {
      const chipIds = new Set<string>();
      el.querySelectorAll<HTMLSpanElement>('span[data-region]').forEach((s) => {
        const rid = s.dataset.region;
        if (rid) chipIds.add(rid);
      });
      for (const rid of selectedRegions) {
        if (!chipIds.has(rid)) onToggleRegion(rid);
      }
    }
    // 键盘删掉 @附件 chip → 从 DOM 消失 → 移除对应 refIds（本地镜像已由上面 newText 同步）
    setRefIds((prev) => {
      const attIds = new Set<string>();
      el.querySelectorAll<HTMLSpanElement>('span[data-attachment]').forEach((s) => {
        const id = s.dataset.attachment;
        if (id) attIds.add(id);
      });
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (!attIds.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
    const cursorPos = getTextCursorOffset(el);
    // @ mention（优先）
    const mention = detectMention(el, newText, cursorPos);
    setMentionOpen(mention.open);
    setMentionQuery(mention.query);
    setMentionIdx(0);
    // # region tag（仅在 @ mention 关闭时触发，避免两者同时开）
    if (!mention.open) {
      const rtag = detectRegionTag(el, newText, cursorPos);
      setRegionTagOpen(rtag.open);
      setRegionTagQuery(rtag.query);
      setRegionTagIdx(0);
    } else {
      setRegionTagOpen(false);
    }
  }, [selectedRegions, onToggleRegion]);

  // composition 事件：IME 输入开始/结束
  const onCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);
  const onCompositionEnd = useCallback((e: React.CompositionEvent<HTMLDivElement>) => {
    isComposingRef.current = false;
    // composition 结束后同步回节点（此时 IME 已确认，不会打断）；同时校正 localPrompt，
    // 避免浏览器在组合中未触发 input 事件时本地镜像与 DOM 失配、被文本镜像 effect 错误重建
    const txt = (e.target as HTMLDivElement).textContent ?? '';
    setLocalPrompt(txt);
    onPatch({ prompt: txt });
  }, [onPatch]);

  // blur 时同步回节点（确保节点 data 与本地一致）
  const onTextareaBlur = useCallback(() => {
    onPatch({ prompt: localPrompt });
  }, [localPrompt, onPatch]);

  // ———————— 主流程：生成 ————————
  const handleGenerate = useCallback(async () => {
    const text = localPrompt.trim();
    if (!text || isGenerating) return;
    setErrMsg(null);
    setIsGenerating(true);
    try {
      onPatch({ prompt: localPrompt });
      if (nodeMode === 'triplot') {
        // 三视图：串行 3 步，走 runTriplotGenerate，每步通过 onPatch 更新 triplotProgress
        const res = await editorRef.current?.runTriplotGenerate(
          {
            prompt: localPrompt,
            negative: negativePrompt,
            size,
            model: modelSel || undefined,
            attachments: referencedAttachments,
          },
          (p) => onPatch({ triplotProgress: p }),
        );
        if (!res) {
          setErrMsg('Editor not ready');
        } else if (!res.ok || !res.triplot) {
          setErrMsg(res.error || 'Triplot generation failed');
          onPatch({ triplotProgress: undefined });
        } else {
          onTriplotGenerated?.(res.triplot);
          setLocalPrompt('');
          onPatch({ prompt: '', selectedRegions: [], triplotProgress: undefined });
          if (textareaRef.current) textareaRef.current.textContent = '';
        }
      } else {
        // generate / edit：原有单图路径
        const res = await editorRef.current?.runGenerate({
          prompt: localPrompt,
          negative: negativePrompt,
          size,
          model: modelSel || undefined,
          attachments: referencedAttachments,
        });
        if (!res) {
          setErrMsg('Editor not ready');
        } else if (!res.ok) {
          setErrMsg(res.error || 'Generation failed');
        } else {
          onGenerated(res.image ?? null);
          setLocalPrompt('');
          onPatch({ prompt: '', selectedRegions: [] });
          if (textareaRef.current) textareaRef.current.textContent = '';
        }
      }
    } finally {
      setIsGenerating(false);
    }
  }, [localPrompt, isGenerating, nodeMode, editorRef, negativePrompt, size, modelSel, referencedAttachments, onGenerated, onTriplotGenerated, onPatch]);

  // ———————— Enter 快捷键：⌘/Ctrl+Enter = 生成；Enter = 换行 ————————
  const onTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // @ Mention 键盘导航（优先级 1，因为 @ mention 先检查）
    if (mentionOpen && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => Math.min(filteredMentions.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(filteredMentions[mentionIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    // # Region 键盘导航（@mention 未开时才响应，避免冲突）
    if (regionTagOpen && filteredRegions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setRegionTagIdx((i) => Math.min(filteredRegions.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setRegionTagIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectRegion(filteredRegions[regionTagIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setRegionTagOpen(false);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleGenerate();
    }
  }, [
    mentionOpen, filteredMentions, mentionIdx, selectMention,
    regionTagOpen, filteredRegions, regionTagIdx, selectRegion,
    handleGenerate,
  ]);

  // 当前模式：编辑器里已有 inputImage = 图生图；否则 = 文生图
  const inEditMode = Boolean(inputImage);
  const placeholder = inEditMode
    ? `Describe edits to apply on the image… (⌘+Enter to generate. Type @ to reference images, # for detected regions)`
    : `Describe the image you want to generate… (⌘+Enter to generate. Type @ to reference images, # for detected regions)`;

  return (
    <div
      className="pointer-events-auto w-full rounded-2xl shadow-2xl animate-[float-up_160ms_ease-out]"
      style={{
        backgroundColor: 'rgba(24,24,27,0.92)',
        backdropFilter: 'blur(10px) saturate(140%)',
        WebkitBackdropFilter: 'blur(10px) saturate(140%)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 14px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(96,84,241,0.12)',
      }}
    >
        {/* ── 行 1：比例选择 + 系统预设提示词按钮 + Negative Presets + 模式徽章 ── */}
        <div
          className="flex shrink-0 items-center gap-1.5"
          style={{
            padding: '8px 10px 4px 10px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {/* Ratio selector（移到行 1，Style Presets 左侧） */}
          <div className="shrink-0">
            <button
              ref={ratioBtnRef}
              type="button"
              onClick={() => { setRatioOpen((v) => !v); setModelOpen(false); setNegativeOpen(false); setPresetOpen(false); }}
              className="flex items-center gap-1 rounded-md border px-2 py-1 transition-all"
              style={{
                borderColor: 'rgba(255,255,255,0.10)',
                backgroundColor: 'rgba(255,255,255,0.04)',
                color: 'rgba(255,255,255,0.78)',
                fontSize: fs(11.5),
              }}
              title="Output aspect ratio"
            >
              <span className="font-semibold">{sizeToRatioLabel(size)}</span>
              <span className="opacity-60">· {size}</span>
              {ratioOpen ? <ChevronDown className="h-3 w-3 opacity-70" /> : <ChevronRight className="h-3 w-3 opacity-70" />}
            </button>
            {/* Ratio 下拉：Portal 挂 body，fixed 定位在按钮下方，脱离输入卡 overflow:hidden 裁剪 */}
            {ratioOpen && portal && ratioRect && createPortal(
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setRatioOpen(false)} />
                <div
                  style={{
                    position: 'fixed',
                    zIndex: 41,
                    top: ratioRect.bottom + 4,
                    left: ratioRect.left,
                    width: 140,
                    backgroundColor: 'rgba(20,20,22,0.98)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    boxShadow: '0 10px 26px rgba(0,0,0,0.45)',
                    borderRadius: 8,
                    padding: 4,
                  }}
                >
                  {RATIO_PRESETS.map((r) => {
                    const active = r.size === size;
                    return (
                      <button
                        key={r.size}
                        type="button"
                        onClick={() => pickSize(r.size)}
                        className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left"
                        style={{
                          backgroundColor: active ? 'rgba(96,84,241,0.18)' : 'transparent',
                          color: active ? '#C7BEFF' : 'rgba(255,255,255,0.82)',
                          fontSize: fs(12),
                        }}
                      >
                        <span className="font-semibold">{r.label}</span>
                        <span className="opacity-60">{r.size}</span>
                      </button>
                    );
                  })}
                </div>
              </>,
              portal,
            )}
          </div>

          <div className="relative">
            {/* 预设按钮：点击弹出选择列表 */}
            <button
              ref={presetBtnRef}
              type="button"
              onClick={() => { setPresetOpen((v) => !v); setRatioOpen(false); setNegativeOpen(false); setModelOpen(false); }}
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium transition-all"
              style={{
                borderColor: presetOpen ? 'rgba(96,84,241,0.50)' : 'rgba(255,255,255,0.10)',
                backgroundColor: presetOpen ? 'rgba(96,84,241,0.18)' : 'rgba(255,255,255,0.04)',
                color: presetOpen ? '#C7BEFF' : 'rgba(255,255,255,0.78)',
                fontSize: fs(11.5),
              }}
              title="System style presets — click to pick one"
            >
              <Sparkles className="h-3 w-3 opacity-80" />
              Style
              {presetOpen ? <ChevronDown className="h-3 w-3 opacity-70" /> : <ChevronRight className="h-3 w-3 opacity-70" />}
            </button>

            {/* 预设弹窗：Portal 挂 body，fixed 定位在按钮左下方，彻底脱离 overflow-hidden 裁剪 */}
            {presetOpen && portal && presetRect && createPortal(
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setPresetOpen(false)} />
                <div
                  style={{
                    position: 'fixed',
                    zIndex: 41,
                    top: presetRect.bottom + 4,
                    left: presetRect.left,
                    width: 260,
                    backgroundColor: 'rgba(20,20,22,0.98)',
                    border: '1px solid rgba(96,84,241,0.40)',
                    boxShadow: '0 14px 32px rgba(0,0,0,0.6)',
                    borderRadius: 8,
                    padding: 4,
                  }}
                >
                  <div className="px-2 py-1 font-semibold uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.4)', fontSize: fs(10) }}>
                    Style presets
                  </div>
                  {STYLE_PRESETS.map((p) => {
                    const active = localPrompt.indexOf(p.prefix) === 0;
                    const tone = PRESET_TONE[p.tone];
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { applyPreset(p); setPresetOpen(false); }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[rgba(96,84,241,0.14)]"
                      >
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tone.color }} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold" style={{ color: tone.color, fontSize: fs(12) }}>{p.label}</span>
                          <span className="block truncate" style={{ color: 'rgba(255,255,255,0.45)', fontSize: fs(10.5) }}>{p.prefix}</span>
                        </span>
                        {active && <Check className="h-3 w-3 shrink-0" style={{ color: '#6EE7B7' }} />}
                      </button>
                    );
                  })}
                </div>
              </>,
              portal,
            )}
          </div>

          {/* Negative Presets 按钮：与 Style Presets 并排，切换 negative 输入区展开 */}
          <button
            type="button"
            onClick={() => { setNegativeOpen((v) => !v); setRatioOpen(false); setModelOpen(false); }}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium transition-all"
            style={{
              borderColor: negativeOpen || negativePrompt ? 'rgba(236,72,153,0.45)' : 'rgba(255,255,255,0.10)',
              backgroundColor: negativeOpen || negativePrompt ? 'rgba(236,72,153,0.14)' : 'rgba(255,255,255,0.04)',
              color: negativeOpen || negativePrompt ? '#F9A8D4' : 'rgba(255,255,255,0.78)',
              fontSize: fs(11.5),
            }}
            title="Negative presets — what to avoid in the output"
          >
            Negative
            {negativePrompt && (
              <span
                className="rounded-sm px-1 font-semibold"
                style={{ backgroundColor: 'rgba(236,72,153,0.30)', color: '#FBCFE8', fontSize: fs(10) }}
              >
                {negativePrompt.length}
              </span>
            )}
            {negativeOpen ? <ChevronDown className="h-3 w-3 opacity-70" /> : <ChevronRight className="h-3 w-3 opacity-70" />}
          </button>

          {/* Triplot 三视图模式按钮：开关切换 mode；开启后 Generate 按钮触发 3 次串行调用 */}
          <button
            type="button"
            onClick={() => {
              const turningOn = nodeMode !== 'triplot';
              onPatch({ mode: turningOn ? (inputImage ? 'edit' : 'generate') : 'triplot' });
              // 首次开启三视图且输入框为空：注入默认提示词模板，用户可修改后再点 Generate
              if (turningOn && !localPrompt.trim()) {
                setLocalPrompt(TRIPLOT_DEFAULT_PROMPT);
                onPatch({ prompt: TRIPLOT_DEFAULT_PROMPT });
              }
            }}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium transition-all"
            style={{
              borderColor: nodeMode === 'triplot' ? 'rgba(250,204,21,0.55)' : 'rgba(255,255,255,0.10)',
              backgroundColor: nodeMode === 'triplot' ? 'rgba(250,204,21,0.16)' : 'rgba(255,255,255,0.04)',
              color: nodeMode === 'triplot' ? '#FDE68A' : 'rgba(255,255,255,0.78)',
              fontSize: fs(11.5),
            }}
            title="Triplot mode — generate Front / Side / Top views in one run (3 sequential calls with reference consistency)"
          >
            <Cube className="h-3 w-3 opacity-80" />
            Triplot
            {nodeMode === 'triplot' && <Check className="h-3 w-3 opacity-80" />}
          </button>

          {/* 生成中进度徽章（仅 triplot 模式且生成中显示） */}
          {nodeMode === 'triplot' && data.triplotProgress && (
            <div
              className="flex items-center gap-1.5 rounded-md border px-2 py-1"
              style={{
                borderColor: 'rgba(96,165,250,0.45)',
                backgroundColor: 'rgba(96,165,250,0.14)',
                color: '#BFDBFE',
                fontSize: fs(10.5),
              }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="font-semibold capitalize">{data.triplotProgress.current}</span>
              <span style={{ color: 'rgba(255,255,255,0.45)' }}>
                {data.triplotProgress.step}/{data.triplotProgress.total}
              </span>
            </div>
          )}

          <div className="flex-1" />
        </div>

        {/* ── 行 2：Prompt textarea + actions row ── */}
        <div ref={mentionAnchorRef} className="relative" style={{ padding: '10px 12px 12px 12px' }}>
          {/* @ Mention 下拉：Portal 挂 body，fixed 定位在行 2 顶边上方（与原 absolute bottom:calc(100%-2px) 视觉一致），脱离输入卡 overflow:hidden 裁剪 */}
          {mentionOpen && portal && mentionRect && createPortal(
            <div
              style={{
                position: 'fixed',
                zIndex: 42,
                left: mentionRect.left + 12,
                right: mentionRect.right - 12,
                minWidth: 300,
                maxWidth: 420,
                bottom: window.innerHeight - (mentionRect.top - 2), // 元素底部贴到锚点顶边上方 2px
                backgroundColor: 'rgba(20,20,22,0.98)',
                border: '1px solid rgba(96,84,241,0.35)',
                boxShadow: '0 10px 26px rgba(0,0,0,0.5)',
                maxHeight: 240,
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-y',
                overscrollBehavior: 'contain',
                scrollbarWidth: 'thin',
                borderRadius: 8,
                padding: 4,
              }}
            >
              <div className="px-1.5 py-1 font-semibold uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.4)', fontSize: fs(10) }}>
                Reference an image
              </div>
              {filteredMentions.length === 0 && (
                <div className="px-2.5 py-2" style={{ color: 'rgba(255,255,255,0.48)', fontSize: fs(11.5) }}>
                  <div className="leading-relaxed">
                    No attachments yet. Upload one below, it will be inserted into the prompt automatically.
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded px-2.5 py-1.5 font-semibold transition-colors hover:brightness-110"
                    style={{ backgroundColor: 'rgba(96,84,241,0.22)', color: '#C7BEFF', fontSize: fs(11.5) }}
                  >
                    <Upload className="h-3 w-3" />
                    Upload image &amp; insert
                  </button>
                </div>
              )}
              {filteredMentions.map((a, idx) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => selectMention(a)}
                  onMouseEnter={() => setMentionIdx(idx)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors"
                  style={{
                    backgroundColor: idx === mentionIdx ? 'rgba(96,84,241,0.18)' : 'transparent',
                  }}
                >
                  <img src={a.dataUrl} alt={a.name} className="h-7 w-7 shrink-0 rounded object-cover" />
                  <span
                    className="flex-1 truncate"
                    style={{ color: idx === mentionIdx ? '#C7BEFF' : 'rgba(255,255,255,0.82)', fontSize: fs(12) }}
                  >
                    {a.name}
                  </span>
                  {refIds.has(a.id) && (
                    <span className="shrink-0 rounded px-1 font-bold" style={{ backgroundColor: 'rgba(16,185,129,0.2)', color: '#6EE7B7', fontSize: fs(9) }}>
                      <Check className="inline h-2.5 w-2.5" /> REF
                    </span>
                  )}
                </button>
              ))}
              {/* 底部：上传入口（有附件列表时也可直接传新图） */}
              {filteredMentions.length > 0 && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-0.5 flex w-full items-center justify-center gap-1.5 rounded border-t px-2 py-1.5 font-semibold transition-colors hover:brightness-110"
                  style={{ borderColor: 'rgba(255,255,255,0.08)', color: 'rgba(199,190,255,0.85)', fontSize: fs(11) }}
                >
                  <Upload className="h-3 w-3" />
                  Upload another image
                </button>
              )}
            </div>,
            portal,
          )}

          {/* # Region 下拉：与 @ mention 对称，Portal + fixed 定位在行 2 顶边上方 */}
          {regionTagOpen && filteredRegions.length > 0 && portal && regionTagRect && createPortal(
            <div
              style={{
                position: 'fixed',
                zIndex: 42,
                left: regionTagRect.left + 12,
                right: regionTagRect.right - 12,
                minWidth: 320,
                maxWidth: 460,
                bottom: window.innerHeight - (regionTagRect.top - 2),
                backgroundColor: 'rgba(20,20,22,0.98)',
                border: '1px solid rgba(16,185,129,0.35)',
                boxShadow: '0 10px 26px rgba(0,0,0,0.5)',
                maxHeight: 320,
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-y',
                overscrollBehavior: 'contain',
                scrollbarWidth: 'thin',
                borderRadius: 8,
                padding: 4,
              }}
            >
              <div className="px-1.5 py-1 font-semibold uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.4)', fontSize: fs(10) }}>
                Reference a detected region
              </div>
              {filteredRegions.length === 0 && (
                <div className="px-2.5 py-2" style={{ color: 'rgba(255,255,255,0.48)', fontSize: fs(11.5) }}>
                  No regions yet — click Detect All on the image first.
                </div>
              )}
              {filteredRegions.map((r, idx) => {
                const sel = (selectedRegions ?? []).includes(r.id);
                const conf = typeof r.confidence === 'number' ? Math.round(r.confidence * 100) : null;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => selectRegion(r)}
                    onMouseEnter={() => setRegionTagIdx(idx)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors"
                    style={{
                      backgroundColor: idx === regionTagIdx ? 'rgba(16,185,129,0.18)' : 'transparent',
                    }}
                  >
                    <Layers className="h-4 w-4 shrink-0 opacity-70" style={{ color: idx === regionTagIdx ? '#6EE7B7' : '#a1a1aa' }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" style={{ color: idx === regionTagIdx ? '#6EE7B7' : 'rgba(255,255,255,0.82)', fontSize: fs(12) }}>
                        #{r.label}
                      </span>
                      {(r.object || conf !== null) && (
                        <span className="block truncate" style={{ color: 'rgba(255,255,255,0.42)', fontSize: fs(10) }} title={r.object || ''}>
                          {r.object ? r.object : ''}{r.object && conf !== null ? ' · ' : ''}{conf !== null ? `${conf}% match` : ''}
                        </span>
                      )}
                    </span>
                    {sel && (
                      <span className="shrink-0 rounded px-1 font-bold" style={{ backgroundColor: 'rgba(96,84,241,0.22)', color: '#C7BEFF', fontSize: fs(9) }}>
                        <Check className="inline h-2.5 w-2.5" /> REF
                      </span>
                    )}
                  </button>
                );
              })}
            </div>,
            portal,
          )}

          <div
            className="rounded-lg overflow-hidden"
            style={{
              border: '1px solid rgba(255,255,255,0.08)',
              backgroundColor: 'rgba(10,10,12,0.55)',
            }}
          >
            {/* 附件区域：输入框上方，从左往右排列（paperclip 按钮 + 缩略图 chips）；支持双指水平滚动 + snap，附件多时不换行 */}
            {attachments.length > 0 && (
              <div
                className="flex items-center gap-1.5"
                style={{
                  padding: '6px 8px 4px 8px',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  flexWrap: 'nowrap',
                  overflowX: 'auto',
                  overflowY: 'hidden',
                  WebkitOverflowScrolling: 'touch',
                  scrollSnapType: 'x proximity',
                  touchAction: 'pan-x',
                  scrollbarWidth: 'thin',
                }}
              >
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="relative shrink-0 rounded overflow-hidden"
                    style={{
                      width: 32, height: 32,
                      scrollSnapAlign: 'start',
                      border: refIds.has(a.id)
                        ? '2px solid rgba(96,84,241,0.6)'
                        : '1px solid rgba(255,255,255,0.10)',
                      backgroundColor: 'rgba(255,255,255,0.04)',
                    }}
                    title={a.name + (refIds.has(a.id) ? ' (referenced)' : ' (not referenced)')}
                  >
                    <img src={a.dataUrl} alt={a.name} className="h-full w-full object-cover" draggable={false} />
                    <button
                      type="button"
                      onClick={() => onAttachmentsChange(attachments.filter((x) => x.id !== a.id))}
                      className="absolute top-0 right-0 h-3.5 w-3.5 flex items-center justify-center"
                      style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
                    >
                      <X className="h-2.5 w-2.5" style={{ color: '#fff' }} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* contentEditable 富文本输入框：支持内嵌 #region chip（#chip 由图上点击生成，@ 引用走 mention）；
                滚动容器启用惯性滚动（-webkit-overflow-scrolling: touch）+ 双指 pan-y，触控板双指滑动流畅 */}
            <div
              ref={textareaRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              data-placeholder={placeholder}
              onInput={onTextareaChange}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onBlur={onTextareaBlur}
              onKeyDown={onTextareaKeyDown}
              className="region-input block w-full outline-none"
              style={{
                padding: '9px 10px 6px 10px',
                fontSize: fs(13),
                lineHeight: 1.55,
                minHeight: '40px',
                maxHeight: '130px',
                overflowY: 'auto',
                overflowX: 'hidden',
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-y',
                overscrollBehavior: 'contain',
                scrollbarWidth: 'thin',
                backgroundColor: 'transparent',
                color: '#fff',
                caretColor: '#C7BEFF',
                wordBreak: 'break-word',
              }}
            />

            {/* 底部条：模型选择 / 附件按钮 / 生成 */}
            <div
              className="flex flex-wrap items-center gap-1.5"
              style={{
                padding: '6px 8px 8px 8px',
                borderTop: '1px solid rgba(255,255,255,0.05)',
                backgroundColor: 'rgba(255,255,255,0.015)',
              }}
            >
              {/* Model selector */}
              <div className="shrink-0">
                <button
                  ref={modelBtnRef}
                  type="button"
                  onClick={() => { setModelOpen((v) => !v); setRatioOpen(false); setNegativeOpen(false); setPresetOpen(false); }}
                  className="flex items-center gap-1 rounded-md border px-2 py-1 transition-all"
                  style={{
                    borderColor: 'rgba(255,255,255,0.10)',
                    backgroundColor: 'rgba(255,255,255,0.04)',
                    color: 'rgba(255,255,255,0.78)',
                    maxWidth: '260px',
                    fontSize: fs(11.5),
                  }}
                  title="Generation model (set in Settings → Providers → Image Edit)"
                >
                  <Sparkles className="h-3 w-3 opacity-70" />
                  <span className="truncate">
                    {modelSel || modelCandidates[0] || 'Configure model…'}
                  </span>
                  {modelOpen ? <ChevronDown className="h-3 w-3 opacity-70 shrink-0" /> : <ChevronRight className="h-3 w-3 opacity-70 shrink-0" />}
                </button>
                {/* Model 下拉：Portal 挂 body，fixed 定位在按钮上方（原 bottom:100%），脱离输入卡 overflow:hidden 裁剪 */}
                {modelOpen && portal && modelRect && createPortal(
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setModelOpen(false)} />
                    <div
                      style={{
                        position: 'fixed',
                        zIndex: 41,
                        bottom: window.innerHeight - modelRect.top, // 弹窗底部贴按钮顶边
                        left: modelRect.left,
                        minWidth: Math.max(260, modelRect.width),
                        maxWidth: 360,
                        backgroundColor: 'rgba(20,20,22,0.98)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        boxShadow: '0 10px 26px rgba(0,0,0,0.45)',
                        borderRadius: 8,
                        padding: 4,
                      }}
                    >
                      {modelCandidates.length === 0 && (
                        <div className="px-2.5 py-2" style={{ color: 'rgba(255,255,255,0.48)', fontSize: fs(11.5) }}>
                          No models configured yet. Open Settings → Providers → Image Edit to add at least one.
                        </div>
                      )}
                      {modelCandidates.map((m) => {
                        const active = m === (modelSel || modelCandidates[0]);
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => pickModel(m)}
                            className="block w-full truncate rounded px-2 py-1.5 text-left"
                            style={{
                              backgroundColor: active ? 'rgba(96,84,241,0.18)' : 'transparent',
                              color: active ? '#C7BEFF' : 'rgba(255,255,255,0.82)',
                              fontSize: fs(12),
                            }}
                            title={m}
                          >
                            {m}
                          </button>
                        );
                      })}
                    </div>
                  </>,
                  portal,
                )}
              </div>

              {/* Attachments：paperclip 按钮（只显示回形针图标） */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="ml-auto flex shrink-0 items-center justify-center rounded-md border p-1.5 transition-all hover:scale-[1.02]"
                style={{
                  borderColor: attachments.length ? 'rgba(96,84,241,0.42)' : 'rgba(255,255,255,0.10)',
                  backgroundColor: attachments.length ? 'rgba(96,84,241,0.10)' : 'rgba(255,255,255,0.04)',
                  color: attachments.length ? '#C7BEFF' : 'rgba(255,255,255,0.78)',
                }}
                title="Attach reference images (type @ in prompt to reference them)"
              >
                <Paperclip className="h-3.5 w-3.5 opacity-80" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => onFilesChosen(e.target.files)}
              />

              {/* Generate 按钮 */}
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={!localPrompt.trim() || isGenerating}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 font-semibold transition-all disabled:opacity-40 enabled:hover:scale-[1.02] enabled:active:scale-[0.98]"
                style={{
                  background: 'linear-gradient(135deg, #6054F1 0%, #8B5CF6 50%, #EC4899 100%)',
                  color: '#fff',
                  boxShadow: '0 4px 14px rgba(96,84,241,0.45)',
                  fontSize: fs(12),
                }}
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    <Wand2 className="h-3.5 w-3.5" />
                    Generate
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Negative prompt 展开区（挂载 ref 供 template 下拉锚点定位） */}
          {negativeOpen && (
            <div ref={negativeWrapRef} className="relative mt-2">
              {/* Template 弹窗：Portal 挂 body，fixed 定位到展开区左上角下方 28px（对应原 absolute+top:0+mt-7），脱离输入卡 overflow:hidden 裁剪 */}
              {templateOpen && portal && templateRect && createPortal(
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setTemplateOpen(false)} />
                  <div
                    style={{
                      position: 'fixed',
                      zIndex: 41,
                      top: templateRect.top + 28,
                      left: templateRect.left,
                      width: 280,
                      maxHeight: 300,
                      overflowY: 'auto',
                      WebkitOverflowScrolling: 'touch',
                      touchAction: 'pan-y',
                      overscrollBehavior: 'contain',
                      scrollbarWidth: 'thin',
                      backgroundColor: 'rgba(20,20,22,0.98)',
                      border: '1px solid rgba(236,72,153,0.40)',
                      boxShadow: '0 14px 32px rgba(0,0,0,0.6)',
                      borderRadius: 8,
                      padding: 4,
                    }}
                  >
                    <div className="px-2 py-1 font-semibold uppercase tracking-wide" style={{ color: 'rgba(255,255,255,0.4)', fontSize: fs(10) }}>
                      Negative templates
                    </div>
                    {[...NEGATIVE_TEMPLATES, ...customTemplates].map((t) => {
                      const isCustom = customTemplates.some((c) => c.id === t.id);
                      return (
                        <div
                          key={t.id}
                          className="group flex w-full items-center rounded px-2 py-1.5 text-left transition-colors hover:bg-[rgba(236,72,153,0.14)]"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              onPatch({ negativePrompt: t.keywords });
                              setTemplateOpen(false);
                            }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <span className="block truncate font-semibold" style={{ color: '#F9A8D4', fontSize: fs(12) }}>{t.label}</span>
                            <span className="block truncate" style={{ color: 'rgba(255,255,255,0.5)', fontSize: fs(10.5) }}>{t.keywords}</span>
                          </button>
                          {isCustom && (
                            <button
                              type="button"
                              onClick={() => void deleteCustomTemplate(t.id)}
                              className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100"
                              title="Delete template"
                              style={{ color: 'rgba(255,255,255,0.5)' }}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {/* 保存当前 negative 为自定义模板 */}
                    <div
                      className="mt-1 flex items-center gap-1 border-t px-1 pt-1.5 pb-0.5"
                      style={{ borderColor: 'rgba(255,255,255,0.08)' }}
                    >
                      <input
                        value={templateLabel}
                        onChange={(e) => setTemplateLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.stopPropagation();
                            void saveCustomTemplate(templateLabel);
                          }
                        }}
                        placeholder="Template name (optional)"
                        className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 outline-none"
                        style={{ borderColor: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: fs(11) }}
                      />
                      <button
                        type="button"
                        onClick={() => void saveCustomTemplate(templateLabel)}
                        disabled={!negativePrompt.trim()}
                        className="shrink-0 rounded px-2 py-1 font-semibold transition-all disabled:opacity-40 enabled:hover:scale-[1.02]"
                        style={{ backgroundColor: 'rgba(236,72,153,0.25)', color: '#F9A8D4', fontSize: fs(11) }}
                        title="Save current negative prompt as a template"
                      >
                        + Save
                      </button>
                    </div>
                  </div>
                </>,
                portal,
              )}

              {/* 左上角模板按钮（位于输入框内部） */}
              <button
                type="button"
                onClick={() => setTemplateOpen((v) => !v)}
                className="absolute left-1.5 top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded transition-colors"
                style={{
                  backgroundColor: templateOpen ? 'rgba(236,72,153,0.25)' : 'rgba(255,255,255,0.06)',
                  color: '#F9A8D4',
                }}
                title="Insert negative prompt template"
              >
                <List className="h-3 w-3" />
              </button>

              <textarea
                value={negativePrompt}
                onChange={(e) => onPatch({ negativePrompt: e.target.value })}
                placeholder="Negative prompt — what to avoid in the output, e.g. blurry, watermark, warped text…"
                rows={2}
                className="block w-full resize-none rounded-lg border outline-none"
                style={{
                  padding: '8px 10px 8px 28px',
                  fontSize: fs(12.5),
                  lineHeight: 1.5,
                  backgroundColor: 'rgba(10,10,12,0.55)',
                  borderColor: 'rgba(236,72,153,0.35)',
                  color: '#F9A8D4',
                  maxHeight: 180,
                  overflowY: 'auto',
                  WebkitOverflowScrolling: 'touch',
                  touchAction: 'pan-y',
                  overscrollBehavior: 'contain',
                  scrollbarWidth: 'thin',
                }}
              />
            </div>
          )}

          {/* 错误提示条 */}
          {errMsg && (
            <div
              className="mt-2 rounded-md px-2.5 py-1.5"
              style={{ backgroundColor: 'rgba(239,68,68,0.12)', color: '#FCA5A5', border: '1px solid rgba(239,68,68,0.28)', fontSize: fs(11.5) }}
            >
              {errMsg}
            </div>
          )}
        </div>
      </div>
  );
});
