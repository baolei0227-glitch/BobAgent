'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Share2, Check, X, Loader2, ImageDown, Copy, Pencil, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toPng } from 'html-to-image';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { createResizableImage } from './extensions/ResizableImage';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import { XhsPanel, PAPER_STYLES, ILLUST_STYLES, resolvePaper } from './XhsCard';
import { loadSettings, saveSettings } from '@/lib/settings';
import { notifyBrandLogoChanged } from './canvasHooks';

/** 小红薯图标：红色土豆 + 顶部嫩芽（小红书分享卡入口） */
function XhsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* 土豆身 */}
      <path
        d="M6.6 9.6 C 6 4.6, 18 4.6, 17.4 9.6 C 21 11, 21.4 18, 17.4 20 C 13.4 22, 10.6 22, 6.6 20 C 2.6 18, 3 11, 6.6 9.6 Z"
        fill="#FF2442"
      />
      {/* 嫩芽叶 */}
      <path d="M12 4.9 C 11.1 3.1, 9.4 2.4, 8 2.9 C 9.7 2.4, 11.4 3.3, 12 4.9 Z" fill="#4CAF50" />
      <path d="M12 4.9 C 12.9 3.1, 14.6 2.4, 16 2.9 C 14.3 2.4, 12.6 3.3, 12 4.9 Z" fill="#66BB6A" />
      {/* 高光 */}
      <ellipse cx="9.4" cy="11.2" rx="2.2" ry="1.5" fill="#fff" opacity="0.35" transform="rotate(-18 9.4 11.2)" />
    </svg>
  );
}
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { HtmlRenderer } from './HtmlRenderer';
import { WidgetRenderer } from './WidgetRenderer';
import { parseWidgetBlocks } from '@/lib/widget-blocks';
import { parseDoc, stripFrontmatter } from '@/lib/md-export/ir';

/* ============ 卡片字体 ============ */
export interface ShareFontStyle {
  key: string;
  /** 下拉显示名（仅字体名，不带风格描述） */
  label: string;
  /** CSS font-family 栈 */
  stack: string;
}

/**
 * 分享卡艺术字体：全部使用 macOS 自带中文字体。
 * 选型理由 —— 导出走 html-to-image 在本地栅格化，本地字体无需内嵌 @font-face、
 * 离线可用、不增加包体；缺字时按栈尾回落到宋体/衬线，不会渲染成方框。
 */
export const SHARE_FONTS: ShareFontStyle[] = [
  { key: 'sans', label: 'Sans', stack: "ui-sans-serif, system-ui, 'SF Pro', 'PingFang SC', 'Hiragino Sans GB', sans-serif" },
  { key: 'songti', label: 'Songti', stack: "'Songti SC', 'Source Han Serif SC', 'Noto Serif SC', serif" },
  { key: 'kaiti', label: 'Kaiti', stack: "'Kaiti SC', 'STKaiti', 'KaiTi', 'BiauKai', 'Songti SC', serif" },
  { key: 'xingkai', label: 'Xingkai', stack: "'Xingkai SC', 'STXingkai', 'Kaiti SC', serif" },
  { key: 'hanzipen', label: 'Hanzipen', stack: "'Hanzipen SC', 'HanziPen SC', 'Hannotate SC', 'Kaiti SC', cursive" },
  { key: 'wawati', label: 'Wawati', stack: "'Wawati SC', 'Yuppy SC', 'Yuanti SC', cursive" },
  { key: 'yuanti', label: 'Yuanti', stack: "'Yuanti SC', 'Hiragino Maru Gothic ProN', 'PingFang SC', sans-serif" },
  { key: 'libian', label: 'Libian', stack: "'Libian SC', 'STLibian', 'Baoli SC', serif" },
];

export function resolveShareFont(key: string | undefined): ShareFontStyle {
  return SHARE_FONTS.find((f) => f.key === key) ?? SHARE_FONTS[0];
}

/** 操作栏下拉统一样式（纸张 / 字体 / 头像共用）：无底色、无外框 */
const toolbarSelectStyle: CSSProperties = {
  backgroundColor: 'transparent',
  border: 'none',
  borderRadius: 8,
  padding: '4px 6px',
  fontSize: '0.8rem',
  color: 'var(--ink)',
  outline: 'none',
  cursor: 'pointer',
};

/** 自绘下拉的选项 */
interface ToolbarOption {
  key: string;
  /** 选项文案：仅缩略图/色块模式下不渲染，仍作 title/aria-label 提示用 */
  label?: string;
  /** 选项左侧色块（纸张用） */
  swatch?: string;
  /** 选项左侧缩略图（头像用） */
  image?: string;
  /** 无缩略图时的占位图标（头像下拉的「上传」项用） */
  icon?: 'plus' | 'spinner';
  /** 选项本身的字体栈（字体预览用） */
  fontFamily?: string;
}

/** 头像下拉的两个特殊选项：默认 Logo 与「上传新头像」，key 不与头像池 id 冲突 */
const LOGO_DEFAULT_KEY = '__logo_default__';
const LOGO_UPLOAD_KEY = '__logo_upload__';

/** 头像池条目（与 preload 的 AvatarItem 对齐，仅取渲染所需字段） */
interface AvatarOption {
  id: string;
  name: string;
  dataUrl: string;
}

/** 渲染层可用的头像 IPC（Electron 环境；浏览器预览时缺失，需按可选处理） */
interface AvatarApi {
  list: () => Promise<AvatarOption[]>;
  add: () => Promise<{ success: boolean; avatars?: AvatarOption[]; canceled?: boolean }>;
}

function getAvatarApi(): AvatarApi | undefined {
  return (window as unknown as { api?: { avatar?: AvatarApi } }).api?.avatar;
}

/**
 * 操作栏自绘下拉。
 * 原生 <select> 无法为 <option> 指定 font-family（Chromium 忽略该属性），
 * 字体下拉必须自绘才能逐项预览字形；纸张下拉复用同一控件以保持外观一致。
 * 菜单向上弹出（操作栏在弹窗底部），Escape 关闭并阻止冒泡，避免连带关闭外层 Dialog。
 */
function ToolbarDropdown({
  value,
  options,
  onSelect,
  title,
  ariaLabel,
  swatchOnly = false,
  imageOnly = false,
}: {
  value: string;
  options: ToolbarOption[];
  onSelect: (key: string) => void;
  title: string;
  ariaLabel: string;
  /** 只展示色块、不展示文案（纸张色用），菜单改为网格排布 */
  swatchOnly?: boolean;
  /** 只展示缩略图、不展示文案（头像用），菜单改为网格排布 */
  imageOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.key === value) ?? options[0];
  /** 紧缩模式：仅渲染图形（色块或缩略图），文案只作提示 */
  const compact = swatchOnly || imageOnly;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center gap-1.5"
        style={toolbarSelectStyle}
      >
        <span className="flex min-w-0 items-center gap-1.5" style={{ fontFamily: current.fontFamily }}>
          {current.image && (
            <img
              src={current.image}
              alt=""
              className={
                swatchOnly
                  ? 'h-4 w-4 shrink-0 rounded-sm'
                  : imageOnly
                    ? 'h-5 w-5 shrink-0 rounded-sm'
                    : 'h-4 w-4 shrink-0 rounded'
              }
              style={{ objectFit: 'contain' }}
            />
          )}
          {current.swatch && (
            <span
              className={swatchOnly ? 'h-4 w-4 shrink-0 rounded-full' : 'h-3 w-3 shrink-0 rounded-full'}
              style={{ backgroundColor: current.swatch, border: '1px solid color-mix(in oklab, var(--line) 70%, transparent)' }}
            />
          )}
          {!imageOnly && current.label && <span className="truncate">{current.label}</span>}
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          className={
            /* w-max：网格菜单是 absolute 且未定宽时，浏览器会把它「收缩拟合」到触发器宽度
               （纸张触发器仅约 46px），4 列各被压到 3px，而 shrink-0 的色块/缩略图不缩，
               相邻项互相压叠、选中底色被压成一条紫色竖线；显式按内容定宽即可避免 */
            compact
              ? 'absolute bottom-full left-0 z-50 mb-1.5 grid w-max grid-cols-4 gap-1.5 rounded-lg p-2'
              : 'absolute bottom-full left-0 z-50 mb-1.5 flex max-h-[260px] flex-col overflow-y-auto rounded-lg p-1'
          }
          style={{
            minWidth: compact ? undefined : '100%',
            backgroundColor: 'var(--panel-bg)',
            border: '1px solid color-mix(in oklab, var(--line) 60%, transparent)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
          }}
        >
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="option"
              aria-selected={o.key === value}
              aria-label={o.label ?? o.key}
              title={o.label ?? o.key}
              onClick={() => {
                onSelect(o.key);
                setOpen(false);
              }}
              className={
                compact
                  ? 'flex items-center justify-center rounded-md p-1 transition-transform hover:scale-110'
                  : 'flex items-center gap-2 rounded-md px-2 py-1.5 text-left whitespace-nowrap transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_10%,transparent)]'
              }
              style={
                compact
                  ? { backgroundColor: o.key === value ? 'color-mix(in oklab, var(--primary) 14%, transparent)' : undefined }
                  : {
                      fontSize: '0.8rem',
                      color: o.key === value ? 'var(--primary)' : 'var(--ink)',
                      fontFamily: o.fontFamily,
                      backgroundColor: o.key === value ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : undefined,
                    }
              }
            >
              {o.image && (
                <img
                  src={o.image}
                  alt=""
                  className={compact ? 'h-5 w-5 shrink-0 rounded-sm' : 'h-5 w-5 shrink-0 rounded'}
                  style={{ objectFit: 'contain' }}
                />
              )}
              {o.icon === 'plus' && <Plus className="h-5 w-5 shrink-0" style={{ opacity: 0.7 }} />}
              {o.icon === 'spinner' && <Loader2 className="h-5 w-5 shrink-0 animate-spin" style={{ opacity: 0.7 }} />}
              {o.swatch && (
                <span
                  className={compact ? 'h-5 w-5 shrink-0 rounded-full' : 'h-3.5 w-3.5 shrink-0 rounded-full'}
                  style={{ backgroundColor: o.swatch, border: '1px solid color-mix(in oklab, var(--line) 70%, transparent)' }}
                />
              )}
              {!imageOnly && o.label && <span className="truncate">{o.label}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ShareCard — 将当次 Q+A 以 Markdown 渲染预览的形式展示，支持一键复制文本 / 复制图片，
 * 并可将卡片导出为带 BobWork 品牌标识 + 时间戳水印的 PNG 图片（走 html-to-image 的
 * toPng 克隆序列化；分享模式下的 widget 已由 WidgetRenderer 提供静态 DOM 供导出）。
 * 与聊天气泡渲染对齐：含 widget（```widget:svg / mermaid / chart / antv）时
 * 拆分为文本 + 非交互 widget 渲染，纯 Markdown 走 HtmlRenderer。
 */

export interface ShareCardProps {
  /** 用户问题文本（纯文本或 Markdown）；md 阅读器路径可省略 */
  question?: string;
  /** AI 回答内容（Markdown）；md 阅读器路径可省略 */
  answer?: string;
  /** 新增：任意 md 字符串（md 阅读器路径）。提供时优先于 question/answer */
  markdown?: string;
  /** 新增：草稿身份（md 场景传文件路径等稳定标识，向小红书卡透传） */
  docKey?: string;
  /** 模型标签（如 "doubao-seed"） */
  modelLabel?: string;
  /** 思考等级字母（L / M / H） */
  levelLetter?: string;
  /** 节点 ID：用于粘贴截图上传到节点附件目录（聊天场景必传，md 场景可省略） */
  nodeId?: string;
  /** 弹窗 open 状态 */
  open: boolean;
  onClose: () => void;
}

/**
 * md 文档 → 品牌卡 Question / Answer 映射（md 阅读器路径）。
 * 文档标题进 Question，其余正文进 Answer；无标题时 Answer 保留原文。
 */
function mdToQA(markdown: string): { question: string; answer: string } {
  const src = stripFrontmatter(markdown);
  const ir = parseDoc(src);
  const body = src.replace(/^\s*#{1,6}[ \t]+.*(?:\r?\n|$)/, '').trim();
  return { question: ir.title, answer: body || src.trim() };
}

/** 分享内容渲染：widget 分块 + 纯 Markdown */
function ShareContent({ content }: { content: string }) {
  const blocks = useMemo(() => parseWidgetBlocks(content), [content]);
  const widgetCount = useMemo(
    () => blocks.filter((b) => b.kind === 'widget').length,
    [blocks],
  );

  if (widgetCount === 0) {
    return <HtmlRenderer content={content} />;
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {blocks.map((block, i) =>
        block.kind === 'text' ? (
          <HtmlRenderer key={i} content={block.content} />
        ) : (
          <WidgetRenderer key={i} widget={block.widget} interactive={false} />
        ),
      )}
    </div>
  );
}

/* ==================== AI 配图 prompt ==================== */

/**
 * 由风格 + 用户需求拼出正文配图 prompt（风格库与 3:4 卡封面共用 ILLUST_STYLES）。
 * 需求留空时退回问题/答案首段作主题，即「只选风格也能出图」。
 * 与封面插画（buildIllustPrompt）的差别在构图描述：封面是横向装饰条，正文配图要独立完整的画面。
 */
function buildShareImagePrompt(styleKey: string, requirement: string, fallbackTopic: string): string {
  const style = ILLUST_STYLES.find((s) => s.key === styleKey) ?? ILLUST_STYLES[0];
  const topic = requirement.trim() || fallbackTopic.trim().slice(0, 60) || 'AI 问答';
  return `一幅${style.prompt}的插画，主题：${topic}。主体居中、构图完整、画面干净，适合作为图文正文中的配图。`;
}

/* ==================== 就地编辑：Answer 所见即所得 ==================== */

/** tiptap-markdown 在 editor.storage 上注入的 markdown 对象（取法与 DocEditor 同源） */
interface ShareMarkdownStorage {
  markdown?: { getMarkdown: () => string };
}

/** 从编辑器 storage 取 Markdown 字符串（tiptap-markdown 注入；缺失时回退空串） */
function getEditorMarkdown(editor: Editor): string {
  return (editor.storage as unknown as ShareMarkdownStorage).markdown?.getMarkdown() ?? '';
}

/**
 * 分享卡就地编辑器的扩展集：与 DocEditor 共用同一套 md 往返口径（tiptap-markdown），
 * 但只保留正文富文本能力（StarterKit + 链接/图片/表格/任务列表），
 * 不挂批注、修订、查找高亮等文档专属扩展。
 * 必须是工厂函数：同一个扩展实例不能同时注册到多个编辑器。
 * 注：自定义块（```widget、![[嵌入]]、:::分栏）在此按代码块/纯文本往返，
 * Markdown 原文不丢，编辑态不做富渲染（与 DocEditor 对问卷块的处理同策略）。
 */
function createShareAnswerExtensions() {
  return [
    // StarterKit v3 自带 link：关掉，改用显式配置的 Link（避免同名重复注册）
    StarterKit.configure({ link: false }),
    Link.configure({ openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } }),
    // 图片：左右手柄拖拽改尺寸（等比），尺寸落进 Markdown；样式见 globals.css
    createResizableImage(),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({
      html: true,
      tightLists: true,
      linkify: false,
      breaks: false,
      transformPastedText: true,
    }),
  ];
}

/**
 * 分享卡 Answer 的就地编辑器（内容即 Markdown：PM 文档 ↔ md 双向往返）。
 * 排版样式由外层 .html-renderer 容器复用正文全局样式，与导出侧 HtmlRenderer 同源，
 * 避免「编辑时一个样、导出另一个样」。
 * 外部写入（AI 生图插入等）经 value 比对后 setContent 回灌（emitUpdate: false），
 * 不会与 onUpdate 形成回环。
 */
function ShareAnswerEditor({
  value,
  onChange,
  onFocus,
  onEditorReady,
  uploadImage,
}: {
  value: string;
  onChange: (md: string) => void;
  onFocus: () => void;
  onEditorReady: (editor: Editor | null) => void;
  uploadImage: (file: Blob) => Promise<string>;
}) {
  /** 最近一次由编辑器自身产出的 md：用于区分「外部写入」与「自己打的字」 */
  const lastMdRef = useRef(value);
  const editorRef = useRef<Editor | null>(null);
  const uploadRef = useRef(uploadImage);
  uploadRef.current = uploadImage;

  const editor = useEditor({
    extensions: createShareAnswerExtensions(),
    content: value,
    editorProps: {
      attributes: {
        class: 'share-answer-editor',
        'aria-label': 'Answer',
        // cursor:text —— 画布覆盖层统一箭头光标，编辑面显式声明 I 形光标
        style: 'outline: none; cursor: text; user-select: text; overflow-x: auto; min-height: 120px;',
      },
      // 截图/图片粘贴：上传到节点附件目录后插入图片节点（与编辑框粘贴行为一致）
      handlePaste: (_view, event) => {
        const item = Array.from(event.clipboardData?.items ?? []).find((it) =>
          it.type.startsWith('image/'),
        );
        const file = item?.getAsFile();
        if (!file) return false;
        event.preventDefault();
        void uploadRef.current(file).then((src) => {
          editorRef.current?.chain().focus().insertContent({ type: 'image', attrs: { src } }).run();
        });
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = getEditorMarkdown(ed);
      lastMdRef.current = md;
      onChange(md);
    },
    onFocus,
  });

  // 向父级暴露实例（AI 生图插入时按光标位置插图片节点）
  useEffect(() => {
    editorRef.current = editor;
    onEditorReady(editor);
    return () => {
      editorRef.current = null;
      onEditorReady(null);
    };
  }, [editor, onEditorReady]);

  // 外部写入回灌：仅在 value 与「编辑器自己产出的 md」不一致时 setContent
  useEffect(() => {
    if (!editor) return;
    if (value === lastMdRef.current) return;
    lastMdRef.current = value;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [value, editor]);

  if (!editor) return null;
  return <EditorContent editor={editor} />;
}

/**
 * BrandCard — 无边框分享卡（预览与导出共用同一结构）：
 * 品牌头（logo + BobWork）+ Question / Answer
 * + 底部协作署名「Bob × {model}」+ 时间戳（无模型信息时回退 "Share via BobWork"）。
 */
function BrandCard({
  brandLogo,
  modelLabel,
  question,
  answer,
  stamp,
  width,
  paperBg,
  fontFamily,
  questionSlot,
  answerSlot,
}: {
  brandLogo: string;
  modelLabel?: string;
  question: string;
  answer: string;
  stamp: Date;
  width?: number | string;
  /** 纸张底色（与 3:4 卡同一套 PAPER_STYLES）；不传则沿用主题面板底色 */
  paperBg?: string;
  /** 正文（Question / Answer）字体栈；不传则沿用默认无衬线。品牌头/水印不受影响 */
  fontFamily?: string;
  /** 就地编辑态：替换 Question 块的只读文本（导出/预览不传，保持纯渲染） */
  questionSlot?: ReactNode;
  /** 就地编辑态：替换 Answer 块的只读渲染（导出/预览不传，保持纯渲染） */
  answerSlot?: ReactNode;
}) {
  return (
    <div
      style={{
        width,
        backgroundColor: paperBg ?? 'var(--panel-bg)',
        color: 'var(--ink-strong)',
        fontFamily: "ui-sans-serif, system-ui, 'SF Pro', 'PingFang SC', sans-serif",
      }}
    >
      <div style={{ padding: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img
              src={brandLogo}
              alt="BobWork"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                objectFit: 'contain',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: '1.066667rem', fontWeight: 700, letterSpacing: 0.2 }}>BobWork</span>
          </div>
        </div>

        {(question || questionSlot) && (
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                marginBottom: 6,
                fontSize: '0.666667rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 1,
                color: 'var(--primary)',
              }}
            >
              Question
            </div>
            <div
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                borderRadius: 10,
                padding: 12,
                fontSize: '0.933333rem',
                lineHeight: 1.7,
                color: 'var(--ink)',
                backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                fontFamily,
              }}
            >
              {questionSlot ?? question}
            </div>
          </div>
        )}

        <div>
          <div
            style={{
              marginBottom: 6,
              fontSize: '0.666667rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 1,
              color: 'var(--primary)',
            }}
          >
            Answer
          </div>
          {/* 就地编辑态给容器挂 .html-renderer：Answer 编辑器复用正文全局排版（标题/列表/表格/代码） */}
          <div
            className={answerSlot ? 'html-renderer' : undefined}
            style={{ fontSize: '0.933333rem', lineHeight: 1.7, color: 'var(--ink)', fontFamily }}
          >
            {answerSlot ?? <ShareContent content={answer} />}
          </div>
        </div>

        {/* 底部品牌水印行 */}
        <div
          style={{
            marginTop: 20,
            paddingTop: 12,
            borderTop: '1px solid color-mix(in oklab, var(--line) 40%, transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.733333rem',
            color: 'var(--ink-muted)',
          }}
        >
          {/* 模型协作署名：有模型信息时显示「Bob × {model}」，无则回退品牌水印 */}
          <span style={{ minWidth: 0 }}>
            {modelLabel ? `Bob × ${modelLabel}` : 'Share via BobWork'}
          </span>
          <span>
            {stamp.toLocaleString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * 宽表自适应：把自然宽度超过容器可用宽度的表格整表等比缩放到可用宽度。
 * 必要原因 —— html-to-image 取景宽度 = 节点 clientWidth（html-to-image/lib/util.js getNodeWidth），
 * 滚动容器（.table-wrapper 为 overflow-x:auto）里超出可视区的部分不会进入克隆体 → 宽表右侧被裁；
 * 预览与导出共用本函数，保证「所见即所得」。
 * 幂等：每次先复位上次的内联样式，再按当前宽度重算（内容/宽度变化后不会残留旧缩放）。
 */
function fitWideTables(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.table-wrapper').forEach((wrapper) => {
    const table = wrapper.querySelector<HTMLElement>('table');
    if (!table) return;
    table.style.transform = '';
    table.style.transformOrigin = '';
    wrapper.style.height = '';
    wrapper.style.overflow = '';
    const avail = wrapper.clientWidth;
    const natural = table.scrollWidth;
    if (avail <= 0 || natural <= avail) return;
    const scale = avail / natural;
    table.style.transform = `scale(${scale})`;
    table.style.transformOrigin = 'top left';
    wrapper.style.overflow = 'hidden'; // 消化取整误差，避免缩放后仍露出滚动裁切边
    wrapper.style.height = `${Math.ceil(table.offsetHeight * scale)}px`; // transform 不改变布局高度，需显式回填
  });
}

/** 清除 fitWideTables 写入的内联缩放样式（导出后复原离屏卡，避免残留缩放态） */
function resetTableFit(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.table-wrapper').forEach((wrapper) => {
    const table = wrapper.querySelector<HTMLElement>('table');
    if (table) {
      table.style.transform = '';
      table.style.transformOrigin = '';
    }
    wrapper.style.height = '';
    wrapper.style.overflow = '';
  });
}

export function ShareCard({ question = '', answer = '', markdown, docKey, modelLabel, levelLetter, nodeId, open, onClose }: ShareCardProps) {
  const [exporting, setExporting] = useState(false);
  const [copyingImage, setCopyingImage] = useState(false);
  const [copiedImg, setCopiedImg] = useState(false);
  const [xhsOpen, setXhsOpen] = useState(false);
  const [stamp, setStamp] = useState(() => new Date());
  const [brandLogo, setBrandLogo] = useState('/hippo-line.png');
  /** 当前品牌标识对应的头像池 id；undefined = 默认 /hippo-line.png（与侧边栏共用 settings.brandLogo） */
  const [brandLogoId, setBrandLogoId] = useState<string | undefined>(undefined);
  /** 头像池（内置 + 自定义），供工具栏的替换下拉列出 */
  const [avatarList, setAvatarList] = useState<AvatarOption[]>([]);
  /** 头像上传中（系统文件选择框为模态，期间禁用下拉重复触发） */
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [mounted, setMounted] = useState(false);
  /** AI 生图弹框 */
  const [aiImgOpen, setAiImgOpen] = useState(false);
  const [aiImgPrompt, setAiImgPrompt] = useState('');
  /** 配图风格（与 3:4 卡封面共用 ILLUST_STYLES）；需求留空时按此风格 + 问题出图 */
  const [aiImgStyle, setAiImgStyle] = useState(ILLUST_STYLES[0].key);
  /** 提示词优化中（/api/ai-generate/illust-prompt，用对话模型写需求） */
  const [aiPromptLoading, setAiPromptLoading] = useState(false);
  const [aiImgLoading, setAiImgLoading] = useState(false);
  /** 当前编辑焦点字段：'q' | 'a'，AI 生图插入到此字段光标处 */
  const activeFieldRef = useRef<'q' | 'a'>('a');
  const exportCardRef = useRef<HTMLDivElement>(null);
  /** 弹窗内预览卡容器（宽表缩放的作用域，CSS 宽度随弹窗自适应，故需在宽度变化时重算） */
  const previewCardRef = useRef<HTMLDivElement>(null);
  /** Answer 就地编辑器实例（AI 生图按光标位置插图片节点） */
  const answerEditorRef = useRef<Editor | null>(null);
  /** Question 就地文本域（插 Markdown 图片 / 自适应高度） */
  const questionTaRef = useRef<HTMLTextAreaElement>(null);
  /** 编辑态：点击铅笔后进入，弹窗内卡片即为编辑面（Question 文本域 + Answer 所见即所得），预览/复制/导出均用编辑后内容 */
  const [editing, setEditing] = useState(false);
  /** md 阅读器路径：提供非空 markdown 时优先于 question/answer（聊天侧行为不变） */
  const markdownSource = typeof markdown === 'string' && markdown.trim() !== '' ? markdown : null;
  const autoQA = useMemo(() => (markdownSource ? mdToQA(markdownSource) : null), [markdownSource]);
  const baseQ = autoQA ? autoQA.question : question;
  const baseA = autoQA ? autoQA.answer : answer;
  const [editQ, setEditQ] = useState(baseQ);
  const [editA, setEditA] = useState(baseA);

  /**
   * 上传图片到节点附件目录，返回可插入的 src。
   * - 有 nodeId：POST /api/attachments → /api/attachments?path=...
   * - 无 nodeId：兜底 data URL（保证截图粘贴始终可用）
   */
  const uploadImage = useCallback(
    async (file: Blob): Promise<string> => {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const ext = (file.type || 'image/png').split('/')[1]?.split('+')[0] || 'png';
      const fileName = `paste-${Date.now()}.${ext}`;
      if (nodeId) {
        try {
          const resp = await fetch('/api/attachments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nodeId,
              nodeTitle: '',
              fileName,
              fileType: file.type || 'application/octet-stream',
              data: base64,
            }),
          });
          const data = await resp.json();
          if (data.success && data.attachment) {
            return '/api/attachments?path=' + encodeURIComponent(data.attachment.path);
          }
        } catch {
          /* fall through to data URL */
        }
      }
      // 兜底：data URL 内嵌
      return `data:${file.type || 'image/png'};base64,${base64}`;
    },
    [nodeId],
  );

  /**
   * 编辑框粘贴截图：从剪贴板提取图片 → 上传到节点附件目录 → 在光标处插入 Markdown 图片语法。
   * 仅拦截图片项，文本粘贴走浏览器默认行为。
   */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>, setter: React.Dispatch<React.SetStateAction<string>>, current: string) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItem = Array.from(items).find((it) => it.type.startsWith('image/'));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart ?? current.length;
      const end = ta.selectionEnd ?? current.length;
      // 先插入占位符，上传完成后替换为真实 URL
      const placeholder = `\n![image](uploading…)\n`;
      const next = current.slice(0, start) + placeholder + current.slice(end);
      setter(next);
      const cursorPos = start + placeholder.length;
      void uploadImage(file).then((src) => {
        const md = `\n![image](${src})\n`;
        setter((prev) => prev.replace(placeholder, md));
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + md.length;
        });
      });
    },
    [uploadImage],
  );

  /** dataURL → Blob */
  const dataUrlToBlob = (dataUrl: string): Blob | null => {
    const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!m) return null;
    const mime = m[1] || 'image/png';
    const raw = m[3];
    const bytes = m[2]
      ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(raw));
    return new Blob([bytes], { type: mime });
  };

  /** 稳定回调：Answer 编辑器的实例交接（避免暴露 effect 因引用变化反复触发） */
  const handleAnswerEditorReady = useCallback((ed: Editor | null) => {
    answerEditorRef.current = ed;
  }, []);

  /** Question 就地文本域自适应高度（行内编辑不出现滚动条，卡片版式随内容增长） */
  useLayoutEffect(() => {
    const ta = questionTaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [editing, editQ]);

  /** 在指定字段光标处插入图片：Answer 走就地编辑器的图片节点，Question 走文本域插入 Markdown */
  const insertImageToField = useCallback(
    (field: 'q' | 'a', src: string) => {
      if (field === 'a') {
        const ed = answerEditorRef.current;
        if (ed) {
          ed.chain().focus().insertContent({ type: 'image', attrs: { src } }).run();
          return;
        }
        setEditA((prev) => `${prev}\n\n![image](${src})\n`);
        return;
      }
      const ta = questionTaRef.current;
      const start = ta?.selectionStart ?? editQ.length;
      const end = ta?.selectionEnd ?? editQ.length;
      const md = `\n![image](${src})\n`;
      setEditQ((prev) => prev.slice(0, start) + md + prev.slice(end));
      requestAnimationFrame(() => {
        if (ta) ta.selectionStart = ta.selectionEnd = start + md.length;
      });
    },
    [editQ],
  );

  /** AI 文生图：调用 /api/ai-generate/image → 上传 → 插入当前编辑字段 */
  const handleAiGenerate = useCallback(async () => {
    if (aiImgLoading) return;
    // 需求可留空：仅选风格时按「风格 + 问题」出图
    const prompt = buildShareImagePrompt(aiImgStyle, aiImgPrompt, editQ || editA);
    setAiImgLoading(true);
    try {
      const resp = await fetch('/api/ai-generate/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          size: '2048x2048',
          negative_prompt: '文字, 水印, logo, 复杂背景, 写实照片, 恐怖, 血腥',
        }),
      });
      const data = await resp.json();
      if (!data.success || !data.image) {
        alert(data.error || 'AI image generation failed');
        return;
      }
      const blob = dataUrlToBlob(data.image);
      if (!blob) {
        alert('Invalid image data');
        return;
      }
      const src = await uploadImage(blob);
      insertImageToField(activeFieldRef.current, src);
      setAiImgOpen(false);
      setAiImgPrompt('');
    } catch (err) {
      alert('AI image generation error: ' + (err as Error).message);
    } finally {
      setAiImgLoading(false);
    }
  }, [aiImgStyle, aiImgPrompt, editQ, editA, aiImgLoading, uploadImage, insertImageToField]);

  /**
   * 提示词优化：把「卡片内容 + 当前风格」交给对话模型写一版配图需求，填入输入框供继续编辑。
   * 复用 /api/ai-generate/illust-prompt（与 3:4 卡封面同一接口），scene=inline 让其按正文配图给构图，
   * 而不是封面那种「底部装饰条」构图。
   */
  const handleOptimizePrompt = useCallback(async () => {
    if (aiPromptLoading) return;
    setAiPromptLoading(true);
    try {
      const resp = await fetch('/api/ai-generate/illust-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: editQ,
          answer: editA,
          styleLabel: ILLUST_STYLES.find((s) => s.key === aiImgStyle)?.label ?? '',
          scene: 'inline',
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data?.success || !data.prompt) {
        alert(data?.error || 'Failed to generate prompt');
        return;
      }
      setAiImgPrompt(data.prompt);
    } catch (err) {
      alert('Failed to generate prompt: ' + (err as Error).message);
    } finally {
      setAiPromptLoading(false);
    }
  }, [aiPromptLoading, editQ, editA, aiImgStyle]);

  // 打开弹窗时重置编辑内容，默认预览态（点铅笔进入编辑）
  useEffect(() => {
    if (open) {
      setEditQ(baseQ);
      setEditA(baseA);
      setEditing(false);
    }
  }, [open, baseQ, baseA]);

  // 导出卡通过 portal 挂到 document.body（避开祖先 transform 对 position:fixed 的干扰）
  useEffect(() => {
    setMounted(true);
  }, []);

  /** 品牌标识：默认 /hippo-line.png；设置自定义 brandLogo 时从头像池匹配 dataUrl（与 Sidebar 一致）。
   *  同时缓存整份头像池，供工具栏「替换头像」下拉直接列出，无需再次 IPC。 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const api = (window as unknown as { api?: { settings?: { load: () => Promise<{ brandLogo?: string } | null> } } }).api;
        const s = await api?.settings?.load();
        if (cancelled) return;
        const brandId = s?.brandLogo;
        const avatarApi = getAvatarApi();
        const list = avatarApi ? await avatarApi.list() : [];
        if (cancelled) return;
        setAvatarList(list);
        if (!brandId || !list.some((x) => x.id === brandId)) {
          setBrandLogoId(undefined);
          setBrandLogo('/hippo-line.png');
          return;
        }
        setBrandLogoId(brandId);
        setBrandLogo(list.find((x) => x.id === brandId)?.dataUrl ?? '/hippo-line.png');
      } catch {
        if (!cancelled) setBrandLogo('/hippo-line.png');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** 纸张底色：与 3:4 卡共用 settings.xhsPaper（同一「分享纸张」偏好，两处输出保持一致） */
  const [paperKey, setPaperKey] = useState<string | undefined>(undefined);
  const paper = useMemo(() => resolvePaper(paperKey), [paperKey]);

  /** 正文字体：仅分享卡使用，持久化到 settings.shareFont */
  const [fontKey, setFontKey] = useState<string | undefined>(undefined);
  const font = useMemo(() => resolveShareFont(fontKey), [fontKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await loadSettings();
        if (cancelled) return;
        if (s.xhsPaper) setPaperKey(s.xhsPaper);
        if (s.shareFont) setFontKey(s.shareFont);
      } catch { /* 读取失败时用默认纸张/字体 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  /** 选择纸张并持久化（保存失败不阻断本地生效，与 XhsCard 行为一致） */
  const handleSelectPaper = useCallback(async (key: string) => {
    setPaperKey(key);
    try {
      const s = await loadSettings();
      s.xhsPaper = key;
      await saveSettings(s);
    } catch { /* 保存失败不阻断本地生效 */ }
  }, []);

  /** 选择正文字体并持久化（同上，保存失败不阻断本地生效） */
  const handleSelectFont = useCallback(async (key: string) => {
    setFontKey(key);
    try {
      const s = await loadSettings();
      s.shareFont = key;
      await saveSettings(s);
    } catch { /* 保存失败不阻断本地生效 */ }
  }, []);

  /** 应用品牌头像并持久化到 settings.brandLogo（与侧边栏共用同一偏好；id 为空 = 默认 Logo） */
  const applyLogo = useCallback(async (id: string | undefined, src: string) => {
    setBrandLogoId(id);
    setBrandLogo(src);
    // 与设置面板同源：品牌 logo 变更后广播，侧边栏底部图标即时跟随
    notifyBrandLogoChanged();
    try {
      const s = await loadSettings();
      s.brandLogo = id;
      await saveSettings(s);
    } catch { /* 保存失败不阻断本地生效 */ }
  }, []);

  /** 替换品牌头像：默认 Logo / 头像池任选 / 上传新头像（选图走系统对话框，成功后自动选中新头像） */
  const handleSelectLogo = useCallback(async (key: string) => {
    if (key === LOGO_DEFAULT_KEY) {
      await applyLogo(undefined, '/hippo-line.png');
      return;
    }
    if (key === LOGO_UPLOAD_KEY) {
      const avatarApi = getAvatarApi();
      if (!avatarApi || avatarUploading) return;
      setAvatarUploading(true);
      try {
        const prevIds = new Set(avatarList.map((a) => a.id));
        const res = await avatarApi.add();
        if (!res.success || !res.avatars) return;
        setAvatarList(res.avatars);
        const added = res.avatars.find((a) => !prevIds.has(a.id));
        if (added) await applyLogo(added.id, added.dataUrl);
      } catch { /* 上传失败保持原头像 */ } finally {
        setAvatarUploading(false);
      }
      return;
    }
    const item = avatarList.find((a) => a.id === key);
    if (item) await applyLogo(item.id, item.dataUrl);
  }, [applyLogo, avatarList, avatarUploading]);

  /** 捕获品牌卡 PNG：刷新水印时间 → 等待 React 重渲染 → html-to-image 序列化导出卡。
   *  实测教训：html-to-image 会把原节点（fixed left:-9999 离屏容器）的定位样式复制到克隆体，
   *  克隆体进入 SVG foreignObject 后仍被定位在画布外 → 整张 PNG 全空白；
   *  仅靠 style 覆盖为 position:fixed/absolute 也无效（foreignObject 里 positioned 根节点不绘制）。
   *  因此直接捕获内部静态 BrandCard（自然文档流），克隆体自 foreignObject 原点排布，内容完整可见；
   *  真实节点始终留在屏幕外，无闪烁。 */
  const capturePng = useCallback(async (): Promise<string | null> => {
    const wrapper = exportCardRef.current;
    const node = (wrapper?.firstElementChild ?? wrapper) as HTMLElement | null;
    if (!node) return null;
    setStamp(new Date());
    await new Promise((r) => setTimeout(r, 120));
    await (document.fonts?.ready ?? Promise.resolve());
    fitWideTables(node); // 宽表先缩到卡片宽度，避免导出后被裁
    try {
      // 不传 backgroundColor，导出 PNG 四角透明（圆角外无底色残留）
      return await toPng(node, {
        pixelRatio: 2,
        cacheBust: true,
      });
    } finally {
      resetTableFit(node);
    }
  }, []);

  /** 预览卡宽表自适应：预览与导出共用 fitWideTables，保证「所见即所得」。
   *  依赖编辑内容与字体就绪重算；ResizeObserver 仅在宽度变化时重算，
   *  避免高度回填再次触发观察导致自激。 */
  useLayoutEffect(() => {
    if (!open || editing) return;
    const root = previewCardRef.current;
    if (!root) return;
    fitWideTables(root);
    let lastWidth = root.clientWidth;
    let cancelled = false;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? root.clientWidth;
      if (Math.abs(w - lastWidth) < 1) return;
      lastWidth = w;
      fitWideTables(root);
    });
    ro.observe(root);
    (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (!cancelled) fitWideTables(root);
    });
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [open, editing, editA, editQ, font.key]);

  /** 导出品牌化 PNG 并触发下载 */
  const handleDownloadImage = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = `bobwork-share-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.warn('[ShareCard] 导出分享图片失败:', err);
    } finally {
      setExporting(false);
    }
  }, [capturePng, exporting]);

  /** 复制品牌化 PNG 到剪贴板（ClipboardItem，便于直接粘贴到聊天/文档） */
  const handleCopyImage = useCallback(async () => {
    if (copyingImage) return;
    setCopyingImage(true);
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopiedImg(true);
      setTimeout(() => setCopiedImg(false), 1500);
    } catch (err) {
      console.warn('[ShareCard] 复制分享图片失败:', err);
    } finally {
      setCopyingImage(false);
    }
  }, [capturePng, copyingImage]);

  return (
    <>
      {/* 导出用品牌卡：portal 到 document.body 离屏渲染，供 html-to-image 序列化为 PNG。
          真实节点始终留在屏幕外（fixed left:-9999，无闪烁）；导出时捕获内部静态 BrandCard，
          克隆体在 foreignObject 原点自然排布（离屏定位根节点会被 html-to-image 复制导致全空白）。 */}
      {mounted &&
        createPortal(
          <div
            ref={exportCardRef}
            aria-hidden
            className="bw-share-card"
            style={{ position: 'fixed', left: -9999, top: 0, zIndex: 2147483647 }}
          >
            <BrandCard
              brandLogo={brandLogo}
              modelLabel={modelLabel}
              question={editQ}
              answer={editA}
              stamp={stamp}
              width={800}
              paperBg={paper.bg}
              fontFamily={font.stack}
            />
          </div>,
          document.body,
        )}

    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[620px] max-h-[85vh] p-0 flex flex-col" showCloseButton={false}>
        {/* Header — 固定不滚动 */}
        <DialogHeader className="px-5 py-3 flex flex-row items-center justify-between gap-2 shrink-0" style={{ borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}>
          <div className="flex min-w-0 items-center gap-2">
            <Share2 className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--primary)' }} />
            <DialogTitle className="text-sm font-semibold leading-none" style={{ color: 'var(--ink-strong)' }}>
              Share
            </DialogTitle>
            {modelLabel && (
              <span
                className="flex-shrink-0 rounded-full px-2 py-0.5 text-10 font-medium"
                style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
              >
                {modelLabel}
                {levelLetter ? ` · ${levelLetter}` : ''}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* Edit toggle：编辑/完成双态，置于标题栏右侧 */}
            {baseA && (
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                title={editing ? 'Done editing' : 'Edit content'}
                aria-label={editing ? 'Done editing' : 'Edit content'}
                className="flex items-center justify-center rounded-md p-2 transition-colors hover:opacity-90"
                style={{
                  border: 'none',
                  color: editing ? 'var(--primary)' : 'var(--ink-strong)',
                }}
              >
                {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
              </button>
            )}
            <Button
              type="button"
              onClick={onClose}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              className="flex-shrink-0"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>
        <DialogDescription className="sr-only">Share content preview</DialogDescription>

        {/* 就地编辑器的结构化样式补齐：ProseMirror 的输出不走 HtmlRenderer 的后处理
            （任务列表类名、表格包裹容器类名不同），这两处全局样式作用域对不上，
            此处按 DocEditor 同款补回，保证编辑态与导出态版式一致 */}
        {editing && (
          <style>{`
            .share-answer-editor ul[data-type="taskList"] { list-style: none; padding: 0; }
            .share-answer-editor ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
            .share-answer-editor ul[data-type="taskList"] li > label { flex-shrink: 0; margin-top: 5px; user-select: none; }
            .share-answer-editor ul[data-type="taskList"] li > div { flex: 1; min-width: 0; }
            .share-answer-editor ul[data-type="taskList"] li > label input[type="checkbox"] {
              appearance: none; width: 15px; height: 15px; border-radius: 4px;
              border: 1.5px solid var(--line); background: var(--paper);
              cursor: pointer; display: grid; place-items: center;
            }
            .share-answer-editor ul[data-type="taskList"] li > label input[type="checkbox"]:checked {
              background: var(--primary); border-color: var(--primary);
            }
            .share-answer-editor ul[data-type="taskList"] li > label input[type="checkbox"]:checked::after {
              content: ''; width: 5px; height: 8px;
              border: solid #fff; border-width: 0 1.5px 1.5px 0;
              transform: rotate(45deg) translate(-0.5px, -0.5px);
            }
            .share-answer-editor ul[data-type="taskList"] li[data-checked="true"] > div {
              text-decoration: line-through; color: var(--ink-muted);
            }
            .share-answer-editor .tableWrapper { overflow-x: auto; margin: 8px 0; }
            .share-answer-editor .tableWrapper table {
              width: max-content; min-width: 100%; border-collapse: collapse;
              font-size: 12px; line-height: 1.6; margin: 0; border: none;
            }
          `}</style>
        )}

        {/* Body — 独立滚动；就地编辑态只把 Question / Answer 换成可编辑面，卡片版式不变（与导出 PNG 同结构） */}
        <div className="flex flex-1 flex-col overflow-y-auto p-5" style={{ backgroundColor: 'var(--paper-soft)' }}>
          <div ref={previewCardRef} className="bw-share-card">
            <BrandCard
              brandLogo={brandLogo}
              modelLabel={modelLabel}
              question={editQ}
              answer={editA}
              stamp={stamp}
              width="100%"
              paperBg={paper.bg}
              fontFamily={font.stack}
              questionSlot={
                editing ? (
                  <textarea
                    ref={questionTaRef}
                    value={editQ}
                    onChange={(e) => setEditQ(e.target.value)}
                    onPaste={(e) => handlePaste(e, setEditQ, editQ)}
                    onFocus={() => { activeFieldRef.current = 'q'; }}
                    rows={1}
                    placeholder="Question…"
                    className="block w-full resize-none border-none bg-transparent p-0 outline-none"
                    style={{
                      color: 'inherit',
                      font: 'inherit',
                      lineHeight: 'inherit',
                      whiteSpace: 'pre-wrap',
                      overflow: 'hidden',
                    }}
                  />
                ) : undefined
              }
              answerSlot={
                editing ? (
                  <ShareAnswerEditor
                    value={editA}
                    onChange={setEditA}
                    onFocus={() => { activeFieldRef.current = 'a'; }}
                    onEditorReady={handleAnswerEditorReady}
                    uploadImage={uploadImage}
                  />
                ) : undefined
              }
            />
          </div>
        </div>

        {/* 操作按钮栏 — 固定不滚动（仅图标 + tooltip） */}
        {baseA && (
          <div className="flex shrink-0 items-center justify-between gap-2 px-5 py-3" style={{
            borderTop: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'var(--panel-bg)',
          }}>
            {/* 纸张 / 字体 / 头像：纸张与 3:4 卡共用 PAPER_STYLES / settings.xhsPaper（仅色块，无文案），
                字体为分享卡专属 settings.shareFont，头像与侧边栏共用 settings.brandLogo
                （三者均为自绘下拉，字体可逐项预览字形） */}
            <div className="flex min-w-0 items-center gap-2">
              <ToolbarDropdown
                value={paper.key}
                options={PAPER_STYLES.map((p) => ({ key: p.key, swatch: p.bg }))}
                onSelect={handleSelectPaper}
                title="Paper"
                ariaLabel="Paper"
                swatchOnly
              />
              <ToolbarDropdown
                value={font.key}
                options={SHARE_FONTS.map((f) => ({ key: f.key, label: f.label, fontFamily: f.stack }))}
                onSelect={handleSelectFont}
                title="Font"
                ariaLabel="Font"
              />
              {/* 头像替换：默认 Logo / 头像池任选 / 上传新头像；与侧边栏共用 settings.brandLogo。
                  imageOnly：下拉只展示缩略图，文案仅作悬停/读屏提示 */}
              <ToolbarDropdown
                value={brandLogoId ?? LOGO_DEFAULT_KEY}
                options={[
                  { key: LOGO_DEFAULT_KEY, label: 'Default Logo', image: '/hippo-line.png' },
                  ...avatarList.map((a) => ({ key: a.id, label: a.name, image: a.dataUrl })),
                  {
                    key: LOGO_UPLOAD_KEY,
                    label: avatarUploading ? 'Uploading…' : 'Upload new avatar',
                    icon: avatarUploading ? 'spinner' : 'plus',
                  },
                ]}
                onSelect={handleSelectLogo}
                title="Avatar"
                ariaLabel="Replace avatar"
                imageOnly
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
            {/* 插图：AI 生图（就地编辑态出现，插入到当前光标处；截图粘贴同效，见卡片内粘贴处理） */}
            {editing && (
              <Button
                type="button"
                onClick={() => setAiImgOpen(true)}
                disabled={aiImgLoading}
                title="AI image (or paste a screenshot)"
                aria-label="AI image"
                variant="outline"
                tone="brand"
                size="icon-lg"
              >
                {aiImgLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              </Button>
            )}
            <Button
              type="button"
              onClick={handleDownloadImage}
              disabled={exporting}
              title={exporting ? 'Exporting…' : 'Save image'}
              variant="outline"
              tone="brand"
              size="icon-lg"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageDown className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              onClick={handleCopyImage}
              disabled={copyingImage}
              title={copyingImage ? 'Copying…' : copiedImg ? 'Image copied' : 'Copy image'}
              variant="outline"
              tone="brand"
              size="icon-lg"
            >
              {copyingImage ? <Loader2 className="h-4 w-4 animate-spin" /> : copiedImg ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              onClick={() => setXhsOpen(true)}
              title="3:4 post card"
              variant="outline"
              tone="brand"
              size="icon-lg"
              className="h-10 w-10"
            >
              <XhsIcon size={24} />
            </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>

    {/* AI 文生图弹框：必须走 Radix Dialog（portal 到 body，z-[2000]）——
        节点卡片是 relative z-[1] 的层叠上下文，原先内联的 fixed z-[100] 弹框逃不出该上下文，
        会被 Share 弹框连同遮罩一起盖住，表现为「点了 AI image 啥也没有」。
        用 Dialog 而非裸 div：嵌套 dialog 的点击不会被上层判定为「外部点击」而误关 Share。
        生成中不响应关闭（onOpenChange 兜住），避免请求被静默丢弃。 */}
    <Dialog open={aiImgOpen} onOpenChange={(v) => { if (!v && !aiImgLoading) setAiImgOpen(false); }}>
      <DialogContent className="sm:max-w-[420px] p-0" showCloseButton={false}>
        <DialogDescription className="sr-only">Generate an image from a prompt and insert it into the share content</DialogDescription>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-sm font-bold" style={{ color: 'var(--ink)' }}>AI generate image</DialogTitle>
            <button
              type="button"
              onClick={() => setAiImgOpen(false)}
              className="rounded-md p-1 hover:bg-black/5"
              style={{ color: 'var(--ink-muted)' }}
              disabled={aiImgLoading}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* 风格：与 3:4 卡封面共用风格库（ILLUST_STYLES）；需求留空也能出图（按风格 + 问题） */}
          <select
            value={aiImgStyle}
            onChange={(e) => setAiImgStyle(e.target.value)}
            aria-label="Style"
            className="w-full rounded-lg p-2 text-sm outline-none"
            style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink)', border: '1px solid color-mix(in oklab, var(--line) 50%, transparent)' }}
          >
            {ILLUST_STYLES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <textarea
            value={aiImgPrompt}
            onChange={(e) => setAiImgPrompt(e.target.value)}
            rows={3}
            placeholder="Optional: describe the subject or extra requirements…"
            className="w-full resize-none rounded-lg p-3 text-sm outline-none"
            style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink)', border: '1px solid color-mix(in oklab, var(--line) 50%, transparent)' }}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleAiGenerate();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            {/* 提示词优化：按当前卡片内容 + 所选风格让对话模型写一版需求（写入输入框，可继续改） */}
            <Button
              type="button"
              variant="ghost"
              tone="brand"
              size="sm"
              onClick={() => void handleOptimizePrompt()}
              disabled={aiImgLoading || aiPromptLoading}
              title="Write the requirement from the card content"
              className="flex items-center gap-1.5"
            >
              {aiPromptLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {aiPromptLoading ? 'Optimizing…' : 'Optimize'}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => setAiImgOpen(false)}
                disabled={aiImgLoading}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="solid"
                tone="brand"
                size="sm"
                onClick={() => void handleAiGenerate()}
                disabled={aiImgLoading}
                className="flex items-center gap-1.5"
              >
                {aiImgLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {aiImgLoading ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* 3:4 竖版小红书风格分享卡 */}
    {xhsOpen && (
      <XhsPanel
        question={editQ}
        answer={editA}
        docKey={docKey}
        open={xhsOpen}
        onClose={() => setXhsOpen(false)}
      />
    )}
    </>
  );
}

/** Share 按钮（供父组件直接渲染） */
export function ShareButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      variant="ghost"
      tone="neutral"
      size="icon-sm"
      title="Share"
    >
      <Share2 className="h-3.5 w-3.5" />
    </Button>
  );
}