'use client';

// 独立批注气泡：批注模式下选中文字时弹出，输入批注意见并添加（不经过 AI Edit 面板）

import { useCallback, useRef, useState } from 'react';
import { type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { MessageSquarePlus, Loader2, Wand2, MessageSquareText, MessageSquare, X, Target } from 'lucide-react';
import { ANNOTATION_INTENTS, type AnnotationIntent } from '../MdAnnotationPanel';

/** 临时选区高亮 key：气泡编辑期间（编辑器失焦、原生选区高亮消失）用 Decoration 保持文字高亮；
 *  气泡隐藏时由 onHide 移除，不占用批注持久高亮（mdAnnotationSelKey）。 */
export const mdSelTempKey = new PluginKey<DecorationSet>('mdAnnotationSelTemp');

interface AnnotationBubbleProps {
  editor: Editor;
  /** 添加批注：quote = 选中文字，content = 批注意见，from/to = 选中位置，intent = 修改意图 */
  onAdd: (quote: string, content: string, from: number, to: number, intent: AnnotationIntent | '') => void;
  /** 划词引用：把选中段落挂到目标节点输入框上方引用标签（target: current=当前活跃节点 / new=新建节点），等用户补写问题后发送 */
  onAsk?: (quote: string, target: 'current' | 'new') => void;
  /** 是否存在当前活跃节点（无则「Ask current」禁用置灰） */
  canAskCurrent?: boolean;
  /** 划词创建 note：用选中文字生成画布 note 卡片（ctx 带选区前后上下文，供文档反向定位消歧） */
  onCreateNote?: (quote: string, ctx: { prefix?: string; suffix?: string }) => void;
}

export function AnnotationBubble({ editor, onAdd, onAsk, canAskCurrent = false, onCreateNote }: AnnotationBubbleProps) {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState<AnnotationIntent | ''>('');
  const [quote, setQuote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 记录上次气泡定位的选区：选区变化 → 重置未提交输入（用户改选新文字时清空旧批注意见）
  const lastSelRef = useRef<{ from: number; to: number } | null>(null);

  /** 气泡显示：记录引用文字 + 临时高亮当前选区（textarea autoFocus 使编辑器失焦，原生选区高亮会消失） */
  const showTempHighlight = useCallback(() => {
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const q = editor.state.doc.textBetween(from, to, '\n').trim();
    if (!q) return;
    setQuote(q);
    // 选区变了（用户划了另一段文字）：清空上次未提交的输入
    if (!lastSelRef.current || lastSelRef.current.from !== from || lastSelRef.current.to !== to) {
      setText('');
      setIntent('');
    }
    lastSelRef.current = { from, to };
    const set = DecorationSet.create(editor.state.doc, [Decoration.inline(from, to, { class: 'md-annotation-sel-temp' })]);
    editor.view.dispatch(editor.state.tr.setMeta(mdSelTempKey, set));
  }, [editor]);

  /** 气泡隐藏：清除引用与未提交输入 + 移除临时高亮（批注黄高亮由批注 Decoration 持续） */
  const hideTempHighlight = useCallback(() => {
    setQuote('');
    setText('');
    setIntent('');
    lastSelRef.current = null;
    editor.view.dispatch(editor.state.tr.setMeta(mdSelTempKey, DecorationSet.empty));
  }, [editor]);

  /** 手动关闭气泡：清空输入并折叠选区（气泡随选区变空而收起） */
  const closeBubble = () => {
    setText('');
    setIntent('');
    const { from } = editor.state.selection;
    editor.chain().focus().setTextSelection(from).run();
  };

  /** 提交批注：添加后收起气泡（批注黄高亮由批注 Decoration 持续保持，不依赖选区） */
  const submit = () => {
    if (!text.trim() || submitting) return;
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
    onAdd(quote, text.trim(), from, to, intent);
    setText('');
    setIntent('');
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

  /** 创建 note：用锁定选区文字生成画布 note 卡片（不收起气泡，可继续批注）；
   *  附带选区前后 32 字符上下文，供文档反向定位消歧（与批注 findQuoteWithContext 同口径） */
  const createNoteNow = () => {
    if (!onCreateNote) return;
    const locked = lastSelRef.current;
    if (!locked) return;
    const { from, to } = locked;
    const quoteText = editor.state.doc.textBetween(from, to, '\n').trim();
    if (!quoteText) return;
    const ctxLen = 32;
    const docText = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
    const prefix = docText.slice(Math.max(0, from - 1 - ctxLen), from - 1);
    const suffix = docText.slice(to - 1, to - 1 + ctxLen);
    onCreateNote(quoteText, { prefix, suffix });
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
        offset: 8,
        onShow: showTempHighlight,
        onHide: hideTempHighlight,
      }}
    >
      <div
        className="w-[300px] overflow-hidden rounded-xl border"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'var(--line)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
        }}
      >
        {/* 引用预览：被选中的文字 */}
        {quote && (
          <div
            className="flex items-start gap-2 border-b px-3 py-2"
            style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper-soft)' }}
          >
            <span
              className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded"
              style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)' }}
            >
              <MessageSquarePlus className="h-2.5 w-2.5" style={{ color: 'var(--primary)' }} />
            </span>
            <p
              className="m-0 flex-1 text-11 leading-relaxed"
              style={{
                color: 'var(--ink-muted)',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
              title={quote}
            >
              &ldquo;{quote}&rdquo;
            </p>
            <button
              onClick={closeBubble}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-faint)' }}
              title="关闭气泡（可重新划词批注）"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* 输入区 */}
        <div className="px-3 pt-2">
          {/* 修改意图 chips：结构化批注意见，AI 按意图执行 + 前端按意图校验达成度 */}
          <div className="mb-1.5 flex flex-wrap gap-1">
            {ANNOTATION_INTENTS.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setIntent((cur) => (cur === it.id ? '' : it.id))}
                className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-9 font-medium transition-colors"
                style={{
                  backgroundColor: intent === it.id ? 'var(--primary)' : 'var(--paper-hover)',
                  color: intent === it.id ? 'var(--primary-foreground)' : 'var(--ink-muted)',
                }}
                title={it.prefix}
              >
                {intent === it.id && <Wand2 className="h-2 w-2" />}
                {it.label}
              </button>
            ))}
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
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
            placeholder="批注意见…（Enter 添加）"
            rows={2}
            autoFocus
            className="w-full resize-none bg-transparent text-xs leading-relaxed outline-none"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-sans)' }}
          />
        </div>

        {/* 底部操作栏：字数 + 划词引用/添加批注 按钮 */}
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
          <span
            className="text-10 tabular-nums"
            style={{ color: text.length > 0 ? 'var(--ink-muted)' : 'var(--ink-faint)' }}
          >
            {text.length}
          </span>
          <span style={{ flex: 1 }} />
          {onAsk && (
            <>
              <button
                onClick={() => askNow('current')}
                disabled={!canAskCurrent}
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed"
                style={{
                  color: canAskCurrent ? 'var(--primary)' : 'var(--ink-faint)',
                  opacity: canAskCurrent ? 1 : 0.55,
                }}
                title={canAskCurrent ? '引用到当前节点提问' : 'No active node — click a node on the canvas first'}
              >
                <MessageSquare className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => askNow('new')}
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--primary)' }}
                title="引用到新建节点提问"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {onCreateNote && (
            <button
              onClick={createNoteNow}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: '#B8860B' }}
              title="用选中文字创建画布 note 卡片"
            >
              <Target className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            disabled={!text.trim() || submitting}
            onClick={submit}
            className="flex h-6 items-center justify-center rounded-md px-2 transition-all disabled:opacity-40"
            style={{
              backgroundColor: text.trim() && !submitting ? 'var(--primary)' : 'var(--paper-hover)',
              color: text.trim() && !submitting ? 'var(--primary-foreground)' : 'var(--ink-muted)',
              boxShadow: text.trim() && !submitting ? '0 2px 8px color-mix(in oklab, var(--primary) 35%, transparent)' : 'none',
            }}
            title="添加批注"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquareText className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </BubbleMenu>
  );
}
