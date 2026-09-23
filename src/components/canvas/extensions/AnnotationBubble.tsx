'use client';

// 独立批注气泡：批注模式下选中文字时弹出，输入批注意见并添加（不经过 AI Edit 面板）
// 顶部为作用于选中文字的排版工具栏（段落样式 / 字符格式 / 对齐 / 列表 / 复制 · 划词引用），
// 中部为意见输入框，底部为 AI 修订与添加批注。

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  Loader2,
  MessageSquareText,
  Bot,
  Sparkles,
  Bold,
  Italic,
  Strikethrough,
  Quote,
  Code2,
  Code,
  List,
  ListOrdered,
  CheckSquare,
  Copy,
  Check,
} from 'lucide-react';
import type { AnnotationIntent } from '../MdAnnotationPanel';

/** 临时选区高亮 key：气泡编辑期间（编辑器失焦、原生选区高亮消失）用 Decoration 保持文字高亮；
 *  气泡隐藏时由 onHide 移除，不占用批注持久高亮（mdAnnotationSelKey）。 */
export const mdSelTempKey = new PluginKey<DecorationSet>('mdAnnotationSelTemp');

/** 顶部工具栏 · 第 1 组：段落样式下拉（H1/H2/H3 = 标题 1-3，T = 正文 Text） */
const BLOCK_OPTIONS: { label: string; active: (editor: Editor) => boolean; run: (editor: Editor) => void }[] = [
  { label: 'H1', active: (e) => e.isActive('heading', { level: 1 }), run: (e) => { e.chain().focus().toggleHeading({ level: 1 }).run(); } },
  { label: 'H2', active: (e) => e.isActive('heading', { level: 2 }), run: (e) => { e.chain().focus().toggleHeading({ level: 2 }).run(); } },
  { label: 'H3', active: (e) => e.isActive('heading', { level: 3 }), run: (e) => { e.chain().focus().toggleHeading({ level: 3 }).run(); } },
  { label: 'T', active: (e) => e.isActive('paragraph'), run: (e) => { e.chain().focus().setParagraph().run(); } },
];

/** 顶部工具栏 · 第 2 组：平铺（加粗 / 斜体 / 删除线 / 引用 / 代码块 / 行内代码）；label 为 hover tooltip 文案 */
const CHAR_OPTIONS: { label: string; hint: string; icon: ReactNode; run: (editor: Editor) => void }[] = [
  { label: 'Bold', hint: '⌘B', icon: <Bold className="h-3.5 w-3.5" />, run: (e) => { e.chain().focus().toggleBold().run(); } },
  { label: 'Italic', hint: '⌘I', icon: <Italic className="h-3.5 w-3.5" />, run: (e) => { e.chain().focus().toggleItalic().run(); } },
  { label: 'Strikethrough', hint: '', icon: <Strikethrough className="h-3.5 w-3.5" />, run: (e) => { e.chain().focus().toggleStrike().run(); } },
  { label: 'Quote', hint: '', icon: <Quote className="h-3.5 w-3.5" />, run: (e) => { e.chain().focus().toggleBlockquote().run(); } },
  { label: 'Code block', hint: '', icon: <Code2 className="h-3.5 w-3.5" />, run: (e) => { e.chain().focus().toggleCodeBlock().run(); } },
  { label: 'Inline code', hint: '', icon: <Code className="h-3.5 w-3.5" />, run: (e) => { e.chain().focus().toggleCode().run(); } },
];

/** 顶部工具栏 · 第 3 组：列表下拉（无序 / 有序 / 任务） */
const LIST_OPTIONS: { label: string; icon: ReactNode; active: (editor: Editor) => boolean; run: (editor: Editor) => void }[] = [
  { label: 'Bullet list', icon: <List className="h-3.5 w-3.5" />, active: (e) => e.isActive('bulletList'), run: (e) => { e.chain().focus().toggleBulletList().run(); } },
  { label: 'Numbered list', icon: <ListOrdered className="h-3.5 w-3.5" />, active: (e) => e.isActive('orderedList'), run: (e) => { e.chain().focus().toggleOrderedList().run(); } },
  { label: 'Task list', icon: <CheckSquare className="h-3.5 w-3.5" />, active: (e) => e.isActive('taskList'), run: (e) => { e.chain().focus().toggleTaskList().run(); } },
];

/** 下拉浮层样式（与气泡同款外观） */
const MENU_STYLE: CSSProperties = {
  backgroundColor: 'var(--popover)',
  borderColor: 'var(--line)',
  boxShadow: '0 10px 24px -6px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.06)',
};

/** 下拉条目统一样式：26px 行高 + 圆角 hover 药丸，当前生效项以品牌色淡底 + 品牌色文字区分 */
const DROP_ITEM = 'flex h-[26px] w-full items-center rounded-md text-11 transition-colors hover:bg-[var(--paper-hover)]';
const activeItemStyle = (on: boolean): CSSProperties =>
  on
    ? { color: 'var(--primary)', backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)' }
    : { color: 'var(--ink)' };

/** 工具栏组间竖线分隔 */
function GroupDivider() {
  return <span className="mx-0.5 h-4 w-px shrink-0" style={{ backgroundColor: 'var(--line)' }} />;
}

interface AnnotationBubbleProps {
  editor: Editor;
  /** 添加批注：quote = 选中文字，content = 批注意见，from/to = 选中位置，intent = 修改意图 */
  onAdd: (quote: string, content: string, from: number, to: number, intent: AnnotationIntent | '') => void;
  /** 划词引用：把选中段落挂到目标节点输入框上方引用标签（target: current=当前活跃节点 / new=新建节点），等用户补写问题后发送 */
  onAsk?: (quote: string, target: 'current' | 'new') => void;
  /** AI 直接修订：把选中文字按意见直接改写进稿（不挂批注，可回退）。返回 null=成功，否则为失败原因。 */
  onDirectRevise?: (quote: string, content: string, from: number, to: number, intent: AnnotationIntent | '') => Promise<string | null>;
  /** 是否存在当前活跃节点（无则「Ask current」禁用置灰） */
  canAskCurrent?: boolean;
}

export function AnnotationBubble({ editor, onAdd, onAsk, onDirectRevise, canAskCurrent = false }: AnnotationBubbleProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // AI 直接修订进行中（独立于添加批注的 submitting，各自按钮显示自己的 spinner）
  const [directing, setDirecting] = useState(false);
  // AI 直接修订失败提示（模型未配置/网络/跑偏校验不过等）
  const [editError, setEditError] = useState<string | null>(null);
  // 顶部工具栏当前展开的下拉（段落样式 / 列表）
  const [openMenu, setOpenMenu] = useState<'block' | 'list' | null>(null);
  // 复制按钮反馈：成功后图标短暂变为勾（1.2s 后还原），不弹 toast
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  // 工具栏容器：点击其外部（含正文、输入框）时收起下拉
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // 记录上次气泡定位的选区：选区变化 → 重置未提交输入（用户改选新文字时清空旧批注意见）
  const lastSelRef = useRef<{ from: number; to: number } | null>(null);

  /** 气泡显示：临时高亮当前选区（textarea autoFocus 使编辑器失焦，原生选区高亮会消失） */
  const showTempHighlight = useCallback(() => {
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const q = editor.state.doc.textBetween(from, to, '\n').trim();
    if (!q) return;
    // 选区变了（用户划了另一段文字）：清空上次未提交的输入
    if (!lastSelRef.current || lastSelRef.current.from !== from || lastSelRef.current.to !== to) {
      setText('');
      setEditError(null);
    }
    lastSelRef.current = { from, to };
    const set = DecorationSet.create(editor.state.doc, [Decoration.inline(from, to, { class: 'md-annotation-sel-temp' })]);
    editor.view.dispatch(editor.state.tr.setMeta(mdSelTempKey, set));
  }, [editor]);

  // 气泡保持显示期间重新划选另一段文字 → 同步刷新临时高亮。
  // 否则新选区的临时高亮缺失，点击输入框/按钮（编辑器失焦、原生选区高亮消失）时正文高亮就"不见了"。
  useEffect(() => {
    if (!editor) return;
    const onSelectionUpdate = () => {
      const { empty } = editor.state.selection;
      if (empty) return;
      showTempHighlight();
    };
    editor.on('selectionUpdate', onSelectionUpdate);
    return () => {
      editor.off('selectionUpdate', onSelectionUpdate);
    };
  }, [editor, showTempHighlight]);

  // 下拉展开期间：点击工具栏以外区域（含正文、输入框）收起下拉
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!toolbarRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  /** 气泡隐藏：清除未提交输入 + 移除临时高亮（批注黄高亮由批注 Decoration 持续） */
  const hideTempHighlight = useCallback(() => {
    setText('');
    setEditError(null);
    setOpenMenu(null);
    lastSelRef.current = null;
    editor.view.dispatch(editor.state.tr.setMeta(mdSelTempKey, DecorationSet.empty));
  }, [editor]);

  /** 提交批注：添加后收起气泡（批注黄高亮由批注 Decoration 持续保持，不依赖选区） */
  const submit = () => {
    if (!text.trim() || submitting || directing) return;
    // 用气泡显示时锁定的选区（lastSel），而非当前 selection——textarea autoFocus 使编辑器
    // 失焦，当前 selection 可能已收缩/偏移（"划词 5 字变 3 字"的根因）。quote 与 from/to 同源，
    // 保证批注卡片显示的文字与高亮/定位范围一致。
    const locked = lastSelRef.current;
    if (!locked) return;
    const from = locked.from;
    const to = locked.to;
    const quote = editor.state.doc.textBetween(from, to, '\n').trim();
    if (!quote) return;
    setSubmitting(true);
    onAdd(quote, text.trim(), from, to, '');
    setText('');
    // 折叠选区 → 气泡收起
    editor.chain().focus().setTextSelection(from).run();
    setSubmitting(false);
  };

  /** 引用到节点：把选中段落挂为目标节点输入框的引用标签（不自动发送）；不收起气泡，可回来继续批注 */
  const askNow = (target: 'current' | 'new') => {
    if (!onAsk) return;
    // 同 submit：用锁定选区，避免失焦后 selection 漂移导致引用文字残缺
    const locked = lastSelRef.current;
    if (!locked) return;
    const { from, to } = locked;
    const quoteText = editor.state.doc.textBetween(from, to, '\n').trim();
    if (!quoteText) return;
    onAsk(quoteText, target);
  };

  /** 复制选中文字（工具栏第 4 组左侧）：同 submit/askNow 用锁定选区，避免失焦后 selection 漂移。
   *  反馈只有按钮图标短暂变勾，不弹 toast；失败时不显示勾（保持原图标即隐含失败）。 */
  const copySelection = () => {
    const locked = lastSelRef.current;
    if (!locked) return;
    const quoteText = editor.state.doc.textBetween(locked.from, locked.to, '\n').trim();
    if (!quoteText) return;
    navigator.clipboard
      .writeText(quoteText)
      .then(() => {
        setCopied(true);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  /** AI 直接修订：把选中文字按意见直接改写进稿（不挂批注）；成功则清空输入并收起气泡，失败保留输入可重试 */
  const directRevise = async () => {
    if (!onDirectRevise || !text.trim() || submitting || directing) return;
    const locked = lastSelRef.current;
    if (!locked) return;
    const { from, to } = locked;
    const quote = editor.state.doc.textBetween(from, to, '\n').trim();
    if (!quote) return;
    setDirecting(true);
    setEditError(null);
    try {
      const err = await onDirectRevise(quote, text.trim(), from, to, '');
      if (err === null) {
        setText('');
        editor.chain().focus().setTextSelection(from).run();
      } else {
        // 失败原因直接展示（模型未配置 / 网络 / 跑偏校验 / 定位失败等）
        setEditError(err || 'AI 修订失败，请重试');
      }
    } finally {
      setDirecting(false);
    }
  };

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: e, state }) => {
        const { empty } = state.selection;
        if (empty) return false;
        const quote = e.state.doc.textBetween(state.selection.from, state.selection.to, '\n');
        return !!quote.trim();
      }}
      options={{
        placement: 'bottom',
        offset: 10,
        // 禁用自动翻转：始终显示在选中文字下方，不翻到上方遮挡选中文字
        flip: false,
        // 底部空间不足时平移保持在视口内（不向上翻转）
        shift: { padding: 8 },
        onShow: showTempHighlight,
        onHide: hideTempHighlight,
      }}
      // 层级：气泡元素由 Tiptap 挂到 view.dom.parentElement，与块级拖拽把手（z-index:30）同层，
      // 自身不设 z-index 时是 auto，会被把手压住，故显式抬到 40。
      style={{ zIndex: 40 }}
    >
      {/* 宽度按工具栏单行排布取定（11 个按钮 + 3 条竖线 ≈ 317px，w-80=320px 留少量余量，不换行）；
          不加 overflow-hidden：下拉浮层需越出气泡边界 */}
      <div
        className="w-80 rounded-xl border"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'var(--line)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
        }}
      >
        {/* 顶部排版工具栏：四组（段落样式下拉 | 字符格式 | 对齐 + 列表下拉 | 复制 · 划词引用），组间竖线分隔 */}
        <div
          ref={toolbarRef}
          className="flex items-center gap-0.5 border-b px-1.5 py-1"
          style={{ borderColor: 'var(--line-soft)' }}
        >
          {/* 1. 段落样式下拉（H）：标题 1-3 / 正文 */}
          <div className="relative">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpenMenu((cur) => (cur === 'block' ? null : 'block'))}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: openMenu === 'block' ? 'var(--primary)' : 'var(--ink-muted)' }}
              title="Paragraph style (H1 / H2 / H3 / body)"
            >
              <span className="text-14 font-semibold leading-none">H</span>
            </button>
            {openMenu === 'block' && (
              <div className="absolute left-0 top-full z-20 mt-1 w-14 rounded-lg border p-1" style={MENU_STYLE}>
                {BLOCK_OPTIONS.map((op) => (
                  <button
                    key={op.label}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { op.run(editor); setOpenMenu(null); }}
                    className={`${DROP_ITEM} justify-center font-medium`}
                    style={activeItemStyle(op.active(editor))}
                  >
                    {op.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <GroupDivider />

          {/* 2. 平铺：加粗 / 斜体 / 删除线 / 引用 / 代码块 / 行内代码（分隔线已移至右键菜单） */}
          {CHAR_OPTIONS.map((op) => (
            <button
              key={op.label}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => op.run(editor)}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              title={op.hint ? `${op.label} (${op.hint})` : op.label}
            >
              {op.icon}
            </button>
          ))}

          <GroupDivider />

          {/* 3. 列表下拉：无序 / 有序 / 任务 */}
          <div className="relative">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpenMenu((cur) => (cur === 'list' ? null : 'list'))}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: openMenu === 'list' ? 'var(--primary)' : 'var(--ink-muted)' }}
              title="List (bullet / numbered / task)"
            >
              <List className="h-3.5 w-3.5" />
            </button>
            {openMenu === 'list' && (
              <div className="absolute left-0 top-full z-20 mt-1 w-[7.5rem] rounded-lg border p-1" style={MENU_STYLE}>
                {LIST_OPTIONS.map((op) => (
                  <button
                    key={op.label}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { op.run(editor); setOpenMenu(null); }}
                    className={`${DROP_ITEM} gap-1.5 px-2`}
                    style={activeItemStyle(op.active(editor))}
                  >
                    {op.icon}
                    <span className="truncate">{op.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <GroupDivider />

          {/* 5. 复制选中文字 + 发送到当前会话 */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={copySelection}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: copied ? 'var(--primary)' : 'var(--ink-muted)' }}
            title={copied ? 'Copied' : 'Copy selection'}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          {onAsk && (
            <button
              onClick={() => askNow('current')}
              disabled={!canAskCurrent}
              onMouseDown={(e) => e.preventDefault()}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed"
              style={{
                color: canAskCurrent ? 'var(--primary)' : 'var(--ink-faint)',
                opacity: canAskCurrent ? 1 : 0.55,
              }}
              title={canAskCurrent ? 'Send to current chat' : 'No active chat — open a node on the canvas first'}
            >
              <Bot className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* 输入区 */}
        <div className="px-3 pt-2">
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setEditError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                // Esc 取消：清空输入并把选区折叠为光标（气泡随选区变空而收起）
                e.preventDefault();
                setText('');
                const { from } = editor.state.selection;
                editor.chain().focus().setTextSelection(from).run();
              }
            }}
            placeholder="Annotation note… (Enter to add)"
            rows={2}
            autoFocus
            className="w-full resize-none bg-transparent text-xs leading-relaxed outline-none"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-sans)' }}
          />
        </div>

        {/* 底部操作栏：AI 修订 / 添加批注（划词引用、复制已上移至顶部工具栏第 4 组） */}
        <div className="flex items-center gap-2 px-3 pb-2 pt-0.5">
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => void directRevise()}
            disabled={!onDirectRevise || !text.trim() || submitting || directing}
            className="flex h-6 items-center justify-center rounded-md px-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              color: onDirectRevise && text.trim() && !submitting && !directing ? 'var(--primary)' : 'var(--ink-muted)',
            }}
            title="AI direct revise (applies the note to the text, undoable)"
          >
            {directing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          </button>
          <button
            disabled={!text.trim() || submitting || directing}
            onClick={submit}
            className="flex h-6 items-center justify-center rounded-md px-2 transition-colors disabled:opacity-40"
            style={{
              color: text.trim() && !submitting && !directing ? 'var(--primary)' : 'var(--ink-muted)',
            }}
            title="Add annotation"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquareText className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* AI 修订失败提示 */}
        {editError && (
          <div className="px-3 pb-2 text-10" style={{ color: 'var(--danger)' }}>{editError}</div>
        )}
      </div>
    </BubbleMenu>
  );
}
