'use client';

// Markdown 批注 + 修订 右侧栏
// - 批注列表：展示挂载的批注（quote + content），点击定位到正文，可删除
// - 一键修订：统合未解决批注，触发 AI 修订
// - 修订列表：修订后逐条展示（删除/新增），支持逐条 + 整体 接受/拒绝

import { useState } from 'react';
import { MessageSquare, X, Wand2, Loader2, Check, Trash2, CornerDownRight, Plus, Minus, FileDiff, ArrowRight, LocateFixed, Eye, Pencil } from 'lucide-react';

export interface MdAnnotation {
  id: string;
  /** 选中的文字（用于定位到正文位置） */
  quote: string;
  /** 批注内容 */
  content: string;
  /** 修改意图（结构化批注意见：polish/shorten/expand/translate/fix/format/custom；空 = 未指定） */
  intent?: string;
  /** ProseMirror 位置（可选，辅助定位） */
  from?: number;
  to?: number;
  /** 上下文锚（W3C TextQuoteSelector）：quote 前/后片段，重复文本时用上下文精确定位；
   *  文档编辑后 quote 位置漂移时，自愈锚定仍能找回原处 */
  prefix?: string;
  suffix?: string;
  /** 是否已通过修订解决 */
  resolved?: boolean;
  createdAt: string;
}

/** 修改意图（结构化批注意见）：AI 执行时带意图前缀，前端按意图做达成度校验；
 *  auto = 自动判断（不指定方向，由 AI 自行理解意见意图并执行） */
export type AnnotationIntent = 'auto' | 'polish' | 'shorten' | 'expand' | 'translate' | 'fix' | 'format' | 'custom';

export const ANNOTATION_INTENTS: { id: AnnotationIntent; label: string; prefix: string }[] = [
  { id: 'auto', label: '自动判断', prefix: '由 AI 自行判断意见意图并执行' },
  { id: 'polish', label: '改写润色', prefix: '改写润色（保持原意，提升表达质量）' },
  { id: 'shorten', label: '精简压缩', prefix: '精简压缩（删去冗余，保持关键信息）' },
  { id: 'expand', label: '扩写补充', prefix: '扩写补充（按意见展开细节，结合上下文）' },
  { id: 'translate', label: '翻译', prefix: '翻译（按意见指定目标语言）' },
  { id: 'fix', label: '修正事实', prefix: '修正事实/表述错误（按意见修正）' },
  { id: 'format', label: '格式化', prefix: '结构化改写（可按需加列表/表格/图表；表格请直接输出 markdown 表格语法：| 列1 | 列2 |\n| --- | --- |）' },
  { id: 'custom', label: '自定义', prefix: '' },
];

export interface Revision {
  id: string;
  /** delete = 删除的文字；insert = 新增的文字 */
  type: 'delete' | 'insert';
  text: string;
  status: 'pending' | 'accepted' | 'rejected';
}

/** 修订段（与 DocEditor 的 RevSegment 结构一致，用于轮次快照渲染） */
export interface RevSegment {
  kind: 'text' | 'delete' | 'insert';
  content: string;
  /** 对应 revisions 数组下标（text 段无此字段） */
  revIndex?: number;
}

/** 单条修订操作（mark 轮次模型）：AI 改动的一个 delete/insert 片段 */
export interface RevisionOp {
  changeId: string;
  kind: 'delete' | 'insert';
  text: string;
  status: 'pending' | 'accepted' | 'rejected';
  /** 定位锚（原文片段，重放时在 baseMd 文档中顺序定位）；insert 的锚为插入位置参照 */
  locate?: string;
  /** insert 插在锚之前（默认锚后） */
  insertBefore?: boolean;
}

/** 一轮修订历史：每次「按批注修订」生成一轮，保留该轮的分段快照与逐条状态 */
export interface RevisionRound {
  id: string;
  createdAt: string;
  segments: RevSegment[];
  revisions: Revision[];
  /** mark 轮次模型（新）：该轮「修改前全文」+ 按序 ops（在 baseMd 文本流中定位重放）；
   *  编辑器中的 track-changes mark 是当前活动轮改动的唯一载体 */
  baseMd?: string;
  ops?: RevisionOp[];
  /** 局部替换轮次（AI Edit 面板替换 / 逐条 AI 重写）：记录「修改前全文 + 差异段」，
   *  渲染时按接受/拒绝在 baseMd 中替换；segments 为空。 */
  patch?: {
    baseMd: string;
    oldText: string;
    newText: string;
    /** 差异点前 20 字符，作为定位锚（oldText 可能在全文多处出现） */
    preContext: string;
  };
  /** 来源批注 id（单条「AI 修改」生成的轮次记录对应批注；该轮修订被接受时自动标记批注已解决） */
  annotationId?: string;
}

interface MdAnnotationPanelProps {
  open: boolean;
  annotations: MdAnnotation[];
  /** 修订历史：按轮次保留，每轮含分段快照与逐条状态 */
  revisionRounds: RevisionRound[];
  /** 当前活动轮（文档内容对应的轮次），null = 未修订过 */
  activeRoundId: string | null;
  /** 切换活动轮：点击历史轮次 → 文档切换到该轮应用后的状态 */
  onSelectRound: (id: string) => void;
  revising: boolean;
  onClose: () => void;
  onDeleteAnnotation: (id: string) => void;
  /** 二次编辑批注：更新该条批注的意见内容 */
  onUpdateAnnotation: (id: string, content: string) => void;
  onJumpToAnnotation: (annotation: MdAnnotation) => void;
  onRevise: () => void;
  onAcceptRevision: (id: string) => void;
  onRejectRevision: (id: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  /** 单条批注 AI 重写：针对该条批注的引用文字按批注意见即时改写 */
  onRewriteAnnotation: (annotation: MdAnnotation) => void;
  /** 聚焦某条修订：切换到该轮并定位高亮被修改处（roundId=所属轮，oldText=修订前，newText=修订后） */
  onFocusRevision: (roundId: string, oldText: string, newText: string) => void;
  /** 对所有批注逐条 AI 重写 */
  onRewriteAll: () => void;
  /** 逐条重写进行中（防止重复点击） */
  rewritingAll?: boolean;
  /** 当前正在重写的批注 id：对应卡片显示进度百分比（null = 无进行中） */
  rewritingId?: string | null;
  /** 视图模式：annotations=批注列表；revisions=修订视图（修订前 → 修订后） */
  view: 'annotations' | 'revisions';
  onViewChange: (view: 'annotations' | 'revisions') => void;
}

/** 修订配对展示：相邻 delete+insert 合并为一行「修订前 → 修订后」，其余独立显示 */
function pairRevisions(revisions: Revision[]): { oldText?: string; newText?: string; items: Revision[] }[] {
  const pairs: { oldText?: string; newText?: string; items: Revision[] }[] = [];
  let i = 0;
  while (i < revisions.length) {
    const r = revisions[i];
    if (r.type === 'delete' && revisions[i + 1]?.type === 'insert') {
      pairs.push({ oldText: r.text, newText: revisions[i + 1].text, items: [r, revisions[i + 1]] });
      i += 2;
    } else {
      pairs.push({ oldText: r.type === 'delete' ? r.text : undefined, newText: r.type === 'insert' ? r.text : undefined, items: [r] });
      i += 1;
    }
  }
  return pairs;
}

/** mark 轮次配对：同 changeId 的相邻 delete+insert 合并为「修订前 → 修订后」（替换），其余独立 */
function pairOps(ops: RevisionOp[]): { oldText?: string; newText?: string; items: RevisionOp[] }[] {
  const pairs: { oldText?: string; newText?: string; items: RevisionOp[] }[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    const next = ops[i + 1];
    if (op.kind === 'delete' && next && next.kind === 'insert' && next.changeId === op.changeId) {
      pairs.push({ oldText: op.text, newText: next.text, items: [op, next] });
      i += 2;
    } else {
      pairs.push({
        oldText: op.kind === 'delete' ? op.text : undefined,
        newText: op.kind === 'insert' ? op.text : undefined,
        items: [op],
      });
      i += 1;
    }
  }
  return pairs;
}

export function MdAnnotationPanel({
  open,
  annotations,
  revisionRounds,
  activeRoundId,
  onSelectRound,
  revising,
  onClose,
  onDeleteAnnotation,
  onUpdateAnnotation,
  onJumpToAnnotation,
  onRevise,
  onAcceptRevision,
  onRejectRevision,
  onAcceptAll,
  onRejectAll,
  onRewriteAnnotation,
  onRewriteAll,
  rewritingAll,
  rewritingId,
  onFocusRevision,
  view,
  onViewChange,
}: MdAnnotationPanelProps) {
  // 批注二次编辑：editingId = 正在编辑的批注 id，editText = 编辑中的内容
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  if (!open) return null;

  const unresolved = annotations.filter((a) => !a.resolved);
  // 全部轮次待处理修订总数（修订 tab 徽章）
  const totalPending = revisionRounds.reduce(
    (sum, r) => sum + (r.ops ? r.ops.filter((op) => op.status === 'pending').length : r.revisions.filter((rev) => rev.status === 'pending').length),
    0,
  );
  // 批量重写进度：当前重写条在待重写列表中的序号（用于禁用其他卡片按钮 + 卡片呼吸灯）
  const rewriteQueue = annotations.filter((a) => !a.resolved && a.quote.trim() && a.content.trim());
  const rewritingIndex = rewritingId ? rewriteQueue.findIndex((x) => x.id === rewritingId) : -1;

  return (
    <div
      className="doc-editor-annotations flex w-[260px] shrink-0 flex-col border-l"
      style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}
    >
      {/* 标题栏：视图切换（批注 / 修订）+ 关闭 */}
      <div
        className="flex shrink-0 items-center gap-1 px-3 py-2"
        style={{ borderBottom: '1px solid var(--line)', backgroundColor: 'var(--paper-soft)' }}
      >
        <div className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5" style={{ backgroundColor: 'var(--paper)' }}>
          <button
            onClick={() => onViewChange('annotations')}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-10 font-medium transition-colors"
            style={{
              backgroundColor: view === 'annotations' ? 'var(--paper-hover)' : 'transparent',
              color: view === 'annotations' ? 'var(--primary)' : 'var(--ink-muted)',
            }}
            title="Annotations view"
          >
            <MessageSquare className="h-3 w-3" />
            批注{unresolved.length > 0 ? ` ${unresolved.length}` : ''}
          </button>
          <button
            onClick={() => onViewChange('revisions')}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-10 font-medium transition-colors"
            style={{
              backgroundColor: view === 'revisions' ? 'var(--paper-hover)' : 'transparent',
              color: view === 'revisions' ? 'var(--primary)' : 'var(--ink-muted)',
            }}
            title="Revisions view（修订前 → 修订后）"
          >
            <FileDiff className="h-3 w-3" />
            修订{totalPending > 0 ? ` ${totalPending}` : ''}
          </button>
        </div>
        <button
          onClick={onClose}
          className="ml-auto rounded p-0.5 hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)' }}
          title="Close annotations"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 批注视图：批量操作 + 批注列表 */}
      {view === 'annotations' && (
        <>
      {/* 批量操作：按批注修订（统一语义——AI 按批注意见修改，结合上下文，带修订标记可审阅；
          只要还有未解决批注就显示，再次修订会追加新轮，而非覆盖） */}
      {unresolved.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5" style={{ borderColor: 'var(--line)' }}>
          <button
            onClick={onRevise}
            disabled={revising}
            className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-11 font-semibold transition-colors disabled:opacity-50"
            style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
            title="按批注意见逐条修改（AI 结合上下文修改批注内容，结果进修订面板可回退）"
          >
            {revising ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            {revising ? 'Revising…' : '按批注修订'}
          </button>
        </div>
      )}

      {/* 批注列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto ai-canvas-scroll px-2 py-2">
        {annotations.length === 0 && revisionRounds.length === 0 && (
          <div className="px-2 py-3 text-11 leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
            选中文字 → 点 AI Edit 面板里的批注按钮，挂一条意见。之后点卡片上的「AI 修改」单条处理，或点「按批注修订」批量处理。
          </div>
        )}

        {/* 批注区 */}
        {annotations.map((a) => (
          <div
            key={a.id}
            onClick={() => onJumpToAnnotation(a)}
            className={`group mb-2 cursor-pointer rounded-lg border px-2 py-1.5 transition-colors hover:bg-[var(--paper-hover)] ${a.id === rewritingId ? 'md-annotation-processing' : ''}`}
            style={{
              borderColor: a.resolved ? 'var(--line-soft)' : 'color-mix(in oklab, var(--primary) 30%, transparent)',
              backgroundColor: a.resolved ? 'var(--paper-soft)' : 'var(--paper)',
              opacity: a.resolved ? 0.6 : 1,
            }}
            title="Click to jump to the annotated text"
          >
            <button
              onClick={(e) => { e.stopPropagation(); onJumpToAnnotation(a); }}
              className="mb-0.5 block w-full truncate text-left text-11 font-medium"
              style={{ color: 'var(--primary)' }}
              title={a.quote}
            >
              &ldquo;{a.quote.length > 30 ? `${a.quote.slice(0, 30)}…` : a.quote}&rdquo;
            </button>
            {a.intent && (
              <span className="mb-0.5 inline-flex items-center gap-0.5 rounded px-1 py-px text-9 font-medium" style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}>
                <Wand2 className="h-2 w-2" />
                {ANNOTATION_INTENTS.find((x) => x.id === a.intent)?.label ?? a.intent}
              </span>
            )}
            {editingId === a.id ? (
              /* 编辑态：textarea 二次编辑批注意见 */
              <div className="mt-0.5">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={2}
                  autoFocus
                  className="w-full resize-none rounded border bg-transparent p-1.5 text-11 leading-relaxed outline-none"
                  style={{ borderColor: 'var(--input-border)', color: 'var(--ink)', fontFamily: 'var(--font-sans)' }}
                />
                <div className="mt-0.5 flex items-center justify-end gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                    className="rounded px-1.5 py-0.5 text-10 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    取消
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (editText.trim()) onUpdateAnnotation(a.id, editText.trim());
                      setEditingId(null);
                    }}
                    className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-10 font-medium"
                    style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
                  >
                    <Check className="h-2.5 w-2.5" />
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-11 leading-relaxed" style={{ color: 'var(--ink)' }}>{a.content}</div>
            )}
            <div className="mt-0.5 flex items-center justify-between">
              <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                {a.resolved ? '已解决' : new Date(a.createdAt).toLocaleString()}
              </span>
              <div className="flex items-center gap-0.5">
                {!a.resolved && (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (editingId === a.id) {
                          setEditingId(null);
                        } else {
                          setEditingId(a.id);
                          setEditText(a.content);
                        }
                      }}
                      className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--paper-hover)]"
                      style={{ color: 'var(--ink-muted)' }}
                      title="Edit annotation"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onRewriteAnnotation(a); }}
                      disabled={rewritingIndex >= 0 && a.id !== rewritingId}
                      className={`flex items-center gap-1 rounded px-1 py-0.5 text-10 font-medium transition-opacity hover:bg-[var(--paper-hover)] ${a.id === rewritingId ? '' : 'opacity-0 group-hover:opacity-100'}`}
                      style={{ color: 'var(--primary)' }}
                      title="AI 按批注意见修改该内容（结合上下文），结果进修订面板可审阅/回退"
                    >
                      {a.id === rewritingId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        'AI 修改'
                      )}
                    </button>
                  </>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteAnnotation(a.id); }}
                  className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-muted)' }}
                  title="Delete annotation"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        ))}
        </div>

        </>
      )}

      {/* 修订视图：每一轮自上而下依次排版（轮头点击切换文档状态，轮内为「修订前 → 修订后」配对） */}
      {view === 'revisions' && (
        <div className="min-h-0 flex-1 overflow-y-auto ai-canvas-scroll px-2 py-2">
          {revisionRounds.length === 0 ? (
            <div className="px-2 py-3 text-11 leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              暂无修订。切到批注视图点「按批注修订」生成修订，每次修订保留一轮历史，可随时切换查看。
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-10 font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                  History
                </span>
                <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                  {revisionRounds.length} 轮
                </span>
              </div>
              {revisionRounds.map((r, i) => {
                const active = r.id === activeRoundId;
                const roundPairs = r.ops?.length ? pairOps(r.ops) : pairRevisions(r.revisions);
                const pendingCount = r.ops
                  ? r.ops.filter((op) => op.status === 'pending').length
                  : r.revisions.filter((rev) => rev.status === 'pending').length;
                const ts = new Date(r.createdAt);
                const sameDay = ts.toDateString() === new Date().toDateString();
                const timeLabel = sameDay
                  ? `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
                  : `${ts.getMonth() + 1}/${ts.getDate()} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`;
                // 每轮摘要：优先关联批注意见，其次修改内容（明确"改的是哪里"，避免 V 序号被误读为同一处迭代）
                const srcAnn = annotations.find((a) => a.id === r.annotationId);
                const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
                const summary = srcAnn?.content
                  ? `批注：${clip(srcAnn.content, 18)}`
                  : r.patch
                    ? `改「${clip(r.patch.oldText || '', 10)}」${r.patch.newText ? `→「${clip(r.patch.newText, 10)}」` : ''}`
                    : `${r.ops?.length ?? r.revisions.length} 处修订`;
                return (
                  <div
                    key={r.id}
                    className="overflow-hidden rounded-lg border transition-colors"
                    style={{
                      borderColor: active ? 'color-mix(in oklab, var(--primary) 45%, transparent)' : 'var(--line-soft)',
                      backgroundColor: active ? 'color-mix(in oklab, var(--primary) 5%, transparent)' : 'var(--paper)',
                    }}
                  >
                    {/* 轮头：点击切换文档到该轮状态 */}
                    <button
                      onClick={() => onSelectRound(r.id)}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                      title={`${ts.toLocaleString()} — 点击切换文档到该轮状态`}
                    >
                      <span
                        className="flex h-5 w-7 shrink-0 items-center justify-center rounded text-10 font-bold"
                        style={{
                          backgroundColor: active ? 'var(--primary)' : 'var(--paper-hover)',
                          color: active ? 'var(--primary-foreground)' : 'var(--ink-muted)',
                        }}
                      >
                        V{i + 1}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-1.5 text-11 font-medium" style={{ color: active ? 'var(--primary)' : 'var(--ink)' }}>
                          {timeLabel}
                          {pendingCount > 0 && (
                            <span className="flex items-center gap-0.5 rounded px-1 py-px text-9 font-semibold" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
                              <span className="h-1 w-1 rounded-full" style={{ backgroundColor: 'var(--danger)' }} />
                              {pendingCount} 待处理
                            </span>
                          )}
                        </span>
                        <span className="truncate text-10" style={{ color: 'var(--ink-faint)' }} title={summary}>
                          {summary}
                        </span>
                      </span>
                      {active && (
                        <span className="flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-9 font-semibold" style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)', color: 'var(--primary)' }}>
                          <Eye className="h-2.5 w-2.5" /> 查看中
                        </span>
                      )}
                    </button>

                    {/* 轮内容：该轮修订配对，自上而下依次排版 */}
                    <div className="px-2 pb-2">
                      {active && pendingCount > 0 && (
                        <div className="mb-1.5 flex items-center justify-between rounded bg-[var(--paper-soft)] px-2 py-1">
                          <span className="text-10" style={{ color: 'var(--ink-muted)' }}>
                            {pendingCount} 待处理
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={onAcceptAll}
                              className="rounded px-1.5 py-0.5 text-10 font-medium"
                              style={{ backgroundColor: 'var(--success-soft)', color: 'var(--success)' }}
                              title="Accept all revisions in this round"
                            >
                              全部接受
                            </button>
                            <button
                              onClick={onRejectAll}
                              className="rounded px-1.5 py-0.5 text-10 font-medium"
                              style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}
                              title="Reject all revisions in this round"
                            >
                              全部拒绝
                            </button>
                          </div>
                        </div>
                      )}
                      {roundPairs.map((pair, idx) => {
                        const allAccepted = pair.items.every((r) => r.status === 'accepted');
                        const allRejected = pair.items.every((r) => r.status === 'rejected');
                        const keyOf = (r: unknown): string => (r as { changeId?: string; id?: string }).changeId ?? (r as { id?: string }).id ?? '';
                        return (
                          <div
                            key={idx}
                            onClick={() => onFocusRevision(r.id, pair.oldText ?? '', pair.newText ?? '')}
                            className="group/revision mb-1.5 cursor-pointer rounded-md border px-2 py-1 transition-colors hover:bg-[var(--paper-hover)]"
                            style={{
                              borderColor: 'var(--line-soft)',
                              backgroundColor: allAccepted || allRejected ? 'var(--paper-soft)' : 'var(--paper)',
                              opacity: allAccepted || allRejected ? 0.55 : 1,
                            }}
                            title="点击定位到正文中被修改处"
                          >
                            <div className="mb-0.5 flex items-center justify-between">
                              <span className="text-10 font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                                {allRejected ? 'Rejected' : allAccepted ? 'Accepted' : 'Pending'}
                              </span>
                              <span className="flex items-center gap-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
                                <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/revision:opacity-100" style={{ color: 'var(--primary)' }}>
                                  <LocateFixed className="h-2.5 w-2.5" /> 定位
                                </span>
                                {pair.oldText !== undefined && pair.newText !== undefined && (
                                  <span className="flex items-center gap-0.5">
                                    <Minus className="h-2.5 w-2.5" style={{ color: 'var(--danger)' }} />
                                    <ArrowRight className="h-2.5 w-2.5" />
                                    <Plus className="h-2.5 w-2.5" style={{ color: 'var(--success)' }} />
                                  </span>
                                )}
                              </span>
                            </div>
                            {pair.oldText !== undefined && (
                              <div className="text-11 leading-relaxed" style={{ color: 'var(--danger)', textDecoration: 'line-through' }}>
                                修订前：{pair.oldText.length > 60 ? `${pair.oldText.slice(0, 60)}…` : pair.oldText}
                              </div>
                            )}
                            {pair.newText !== undefined && (
                              <div className="text-11 leading-relaxed" style={{ color: 'var(--success)' }}>
                                修订后：{pair.newText.length > 60 ? `${pair.newText.slice(0, 60)}…` : pair.newText}
                              </div>
                            )}
                            {active && !allAccepted && !allRejected && (
                              <div className="mt-0.5 flex items-center gap-1">
                                <button
                                  onClick={(e) => { e.stopPropagation(); pair.items.forEach((r) => onAcceptRevision(keyOf(r))); }}
                                  className="rounded px-1 py-0.5 text-10 font-medium hover:opacity-80"
                                  style={{ backgroundColor: 'var(--success-soft)', color: 'var(--success)' }}
                                >
                                  接受
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); pair.items.forEach((r) => onRejectRevision(keyOf(r))); }}
                                  className="rounded px-1 py-0.5 text-10 font-medium hover:opacity-80"
                                  style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}
                                >
                                  拒绝
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {active && pendingCount === 0 && roundPairs.length > 0 && (
                        <div className="mt-0.5 flex items-center gap-1 px-1 text-10" style={{ color: 'var(--success)' }}>
                          <Check className="h-3 w-3" /> 全部处理完成
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
