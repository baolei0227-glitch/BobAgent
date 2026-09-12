'use client';

// 独立批注气泡：批注模式下选中文字时弹出，输入批注意见并添加（不经过 AI Edit 面板）

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Loader2, MessageSquareText, Bot, Sparkles } from 'lucide-react';
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
  /** AI 直接修订：把选中文字按意见+风格直接改写进稿（不挂批注，可回退）。返回 null=成功，否则为失败原因。 */
  onDirectRevise?: (quote: string, content: string, from: number, to: number, intent: AnnotationIntent | '') => Promise<string | null>;
  /** 是否存在当前活跃节点（无则「Ask current」禁用置灰） */
  canAskCurrent?: boolean;
}

export function AnnotationBubble({ editor, onAdd, onAsk, onDirectRevise, canAskCurrent = false }: AnnotationBubbleProps) {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState<AnnotationIntent | ''>('');
  const [submitting, setSubmitting] = useState(false);
  // AI 直接修订进行中（独立于添加批注的 submitting，各自按钮显示自己的 spinner）
  const [directing, setDirecting] = useState(false);
  // AI 直接修订失败提示（模型未配置/网络/跑偏校验不过等）
  const [editError, setEditError] = useState<string | null>(null);
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
      setIntent('');
      setEditError(null);
    }
    lastSelRef.current = { from, to };
    const set = DecorationSet.create(editor.state.doc, [Decoration.inline(from, to, { class: 'md-annotation-sel-temp' })]);
    editor.view.dispatch(editor.state.tr.setMeta(mdSelTempKey, set));
  }, [editor]);

  // 气泡保持显示期间重新划选另一段文字 → 同步刷新临时高亮。
  // 否则新选区的临时高亮缺失，点击风格/输入框（编辑器失焦、原生选区高亮消失）时正文高亮就"不见了"。
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

  /** 气泡隐藏：清除未提交输入 + 移除临时高亮（批注黄高亮由批注 Decoration 持续） */
  const hideTempHighlight = useCallback(() => {
    setText('');
    setIntent('');
    setEditError(null);
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

  /** AI 直接修订：把选中文字按意见+风格直接改写进稿（不挂批注）；成功则清空输入并收起气泡，失败保留输入可重试 */
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
      const err = await onDirectRevise(quote, text.trim(), from, to, intent);
      if (err === null) {
        setText('');
        setIntent('');
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
    >
      <div
        className="w-[300px] overflow-hidden rounded-xl border"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'var(--line)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
        }}
      >
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
            placeholder="批注意见…（Enter 添加）"
            rows={2}
            autoFocus
            className="w-full resize-none bg-transparent text-xs leading-relaxed outline-none"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-sans)' }}
          />
        </div>

        {/* 底部操作栏：划词引用 / 添加批注 */}
        <div className="flex items-center gap-2 px-3 pb-1.5 pt-0.5">
          <span style={{ flex: 1 }} />
          {onAsk && (
            <button
              onClick={() => askNow('current')}
              disabled={!canAskCurrent}
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed"
              style={{
                color: canAskCurrent ? 'var(--primary)' : 'var(--ink-faint)',
                opacity: canAskCurrent ? 1 : 0.55,
              }}
              title={canAskCurrent ? '发送到当前会话' : '无当前会话 — 请先在画布选中节点'}
            >
              <Bot className="h-[15px] w-[15px]" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void directRevise()}
            disabled={!onDirectRevise || !text.trim() || submitting || directing}
            className="flex h-6 items-center justify-center rounded-md px-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              color: onDirectRevise && text.trim() && !submitting && !directing ? 'var(--primary)' : 'var(--ink-muted)',
            }}
            title="AI 直接修订（不挂批注，按意见直接改稿，可回退）"
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
            title="添加批注"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquareText className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* AI 修订失败提示 */}
        {editError && (
          <div className="px-3 pb-1.5 text-10" style={{ color: 'var(--danger)' }}>{editError}</div>
        )}

        {/* 风格快捷选择：两排网格横排展示在功能按钮下方，点击即选中 / 再点取消 */}
        <div className="grid grid-cols-3 gap-1 border-t px-3 pb-2 pt-1.5" style={{ borderColor: 'var(--line-soft)' }}>
          {ANNOTATION_INTENTS.filter((it) => it.id !== 'auto' && it.id !== 'custom').map((it) => {
            const on = intent === it.id;
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => setIntent((cur) => (cur === it.id ? '' : it.id))}
                title={it.prefix || it.label}
                className="flex h-5 items-center justify-center whitespace-nowrap rounded px-1 text-10 transition-colors"
                style={{
                  backgroundColor: on ? 'var(--primary)' : 'var(--paper-hover)',
                  color: on ? 'var(--primary-foreground)' : 'var(--ink-muted)',
                }}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      </div>
    </BubbleMenu>
  );
}
