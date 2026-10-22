'use client';

// Markdown 批注 + 修订 右侧栏
// - 批注列表：展示挂载的批注（quote + content），点击定位到正文，可删除
// - 一键修订：统合未解决批注，触发 AI 修订
// - 修订列表：修订后逐条展示（删除/新增），支持逐条 + 整体 接受/拒绝

import { useState } from 'react';
import { MessageSquare, X, Wand2, Loader2, Check, Trash2, CornerDownRight, Plus, Minus, FileDiff, ArrowRight, LocateFixed, Eye, Pencil, ListChecks, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CheckReport } from './CheckReport';
import { summarizeChecks } from '@/lib/md-export/check';
import type { ConsistencyItem } from '@/lib/md-consistency/check';

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
  { id: 'auto', label: 'Auto', prefix: '由 AI 自行判断意见意图并执行' },
  { id: 'polish', label: 'Polish', prefix: '改写润色（保持原意，提升表达质量）' },
  { id: 'shorten', label: 'Shorten', prefix: '精简压缩（删去冗余，保持关键信息）' },
  { id: 'expand', label: 'Expand', prefix: '扩写补充（按意见展开细节，结合上下文）' },
  { id: 'translate', label: 'Translate', prefix: '翻译（按意见指定目标语言）' },
  { id: 'fix', label: 'Fix facts', prefix: '修正事实/表述错误（按意见修正）' },
  { id: 'format', label: 'Format', prefix: '结构化改写（可按需加列表/表格/图表；表格请直接输出 markdown 表格语法：| 列1 | 列2 |\n| --- | --- |）' },
  { id: 'custom', label: 'Custom', prefix: '' },
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
    /** 改动前后的渲染态纯文本指纹（修订卡片点击定位用；oldText/newText 是 markdown 源码，
     *  在渲染纯文本中匹配不到，纯文本指纹才能精确命中含语法的改动） */
    plainOld?: string;
    plainNew?: string;
  };
  /** 来源批注 id（单条「AI 修改」生成的轮次记录对应批注；该轮修订被接受时自动标记批注已解决） */
  annotationId?: string;
  /** 该轮改写【之前】批注的锚点：拒绝该轮修订时用来把批注重新锚回旧文本，
   *  否则批注 quote 停在被还原掉的新文本上，定位失败、看起来「批注消失」 */
  annotationBefore?: {
    quote: string;
    from?: number;
    to?: number;
    prefix?: string;
    suffix?: string;
  };
  /** 「改了什么」的一句话说明（由 old/new 差异确定性生成，不额外调模型；随轮次持久化到 sidecar） */
  note?: string;
  /** 轮次来源：'user' = 人工修订模式下的手工编辑；缺省 = AI 修订 */
  author?: 'ai' | 'user';
}

/** 一轮「按批注修订」的结果回报：改了几条、哪几条失败及原因（失败原因可见，不再静默丢弃） */
export interface ReviseReport {
  /** 本轮参与修订的未解决批注总数 */
  total: number;
  /** 改写成功、已生成修订轮次的批注（annotationId → 对应轮次 id） */
  revised: { annotationId: string; roundId: string }[];
  /** 改写失败的批注与原因 */
  failed: { annotationId: string; quote: string; reason: string }[];
  /** 生成时间（ISO） */
  at: string;
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
  /** 最近一轮「按批注修订」的结果回报（改了几条 / 哪几条失败及原因）；null = 尚未跑过 */
  reviseReport?: ReviseReport | null;
  /** 一致性检查结果（Checks 视图）：编号 / 交叉引用 / 术语 */
  consistencyItems?: ConsistencyItem[];
  /** 一致性检查进行中 */
  checking?: boolean;
  /** 触发一致性检查（仅当前文档） */
  onRunChecks?: () => void;
  /** 点击检查项 → 跳转到正文对应位置 */
  onJumpToCheck?: (item: ConsistencyItem) => void;
  /** 视图模式：annotations=批注列表；revisions=修订视图（修订前 → 修订后）；checks=一致性检查 */
  view: 'annotations' | 'revisions' | 'checks';
  onViewChange: (view: 'annotations' | 'revisions' | 'checks') => void;
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

/** 一轮修订的「逻辑条数」：相邻 delete+insert（同一次替换）合并为 1 条，避免一次改写被计成 2 */
function changeCount(round: RevisionRound): number {
  return round.ops?.length ? pairOps(round.ops).length : pairRevisions(round.revisions).length;
}

/** 一轮中「待处理」的逻辑条数：某条配对里还有 pending 项即计入 1（含部分处理的情况） */
function pendingChangeCount(round: RevisionRound): number {
  const pairs = round.ops?.length ? pairOps(round.ops) : pairRevisions(round.revisions);
  return pairs.filter((p) => p.items.some((i) => i.status === 'pending')).length;
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
  reviseReport,
  onFocusRevision,
  consistencyItems,
  checking,
  onRunChecks,
  onJumpToCheck,
  view,
  onViewChange,
}: MdAnnotationPanelProps) {
  // 批注二次编辑：editingId = 正在编辑的批注 id，editText = 编辑中的内容
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  if (!open) return null;

  const unresolved = annotations.filter((a) => !a.resolved);
  // 全部轮次待处理修订总数（修订 tab 徽章）——按「逻辑条数」计（delete+insert 合并为 1）
  const totalPending = revisionRounds.reduce((sum, r) => sum + pendingChangeCount(r), 0);
  // 批量重写进度：当前重写条在待重写列表中的序号（用于禁用其他卡片按钮 + 卡片呼吸灯）
  const rewriteQueue = annotations.filter((a) => !a.resolved && a.quote.trim() && a.content.trim());
  const rewritingIndex = rewritingId ? rewriteQueue.findIndex((x) => x.id === rewritingId) : -1;
  // 一致性检查汇总（Checks tab 徽章 = fail + warn 数）
  const checkIssues = consistencyItems ? summarizeChecks(consistencyItems).fail + summarizeChecks(consistencyItems).warn : 0;

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
        <div className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5" style={{ backgroundColor: 'var(--paper-hover)', boxShadow: 'inset 0 1px 2px rgba(23,23,23,0.06)' }}>
          <button
            onClick={() => onViewChange('annotations')}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-10 font-medium transition-colors"
            style={{
              backgroundColor: view === 'annotations' ? 'var(--paper)' : 'transparent',
              boxShadow: view === 'annotations' ? '0 1px 2px rgba(23,23,23,0.1)' : 'none',
              color: view === 'annotations' ? 'var(--primary)' : 'var(--ink-muted)',
            }}
            title="Annotations view"
          >
            <MessageSquare className="h-3 w-3" />
            Annotations{unresolved.length > 0 ? ` ${unresolved.length}` : ''}
          </button>
          <button
            onClick={() => onViewChange('revisions')}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-10 font-medium transition-colors"
            style={{
              backgroundColor: view === 'revisions' ? 'var(--paper)' : 'transparent',
              boxShadow: view === 'revisions' ? '0 1px 2px rgba(23,23,23,0.1)' : 'none',
              color: view === 'revisions' ? 'var(--primary)' : 'var(--ink-muted)',
            }}
            title="Revisions view (before → after)"
          >
            <FileDiff className="h-3 w-3" />
            Revisions{totalPending > 0 ? ` ${totalPending}` : ''}
          </button>
          <button
            onClick={() => onViewChange('checks')}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-10 font-medium transition-colors"
            style={{
              backgroundColor: view === 'checks' ? 'var(--paper)' : 'transparent',
              boxShadow: view === 'checks' ? '0 1px 2px rgba(23,23,23,0.1)' : 'none',
              color: view === 'checks' ? 'var(--primary)' : 'var(--ink-muted)',
            }}
            title="Consistency checks (numbering · cross-references · terminology)"
          >
            <ListChecks className="h-3 w-3" />
            Checks{checkIssues > 0 ? ` ${checkIssues}` : ''}
          </button>
        </div>
        <Button
          onClick={onClose}
          variant="ghost"
          tone="neutral"
          size="icon-sm"
          className="ml-auto"
          title="Close annotations"
          aria-label="Close annotations"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 批注视图：批量操作 + 批注列表 */}
      {view === 'annotations' && (
        <>
      {/* 批量操作：按批注修订（统一语义——AI 按批注意见修改，结合上下文，带修订标记可审阅；
          只要还有未解决批注就显示，再次修订会追加新轮，而非覆盖） */}
      {unresolved.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5" style={{ borderColor: 'var(--line)' }}>
          <Button
            onClick={onRevise}
            disabled={revising}
            loading={revising}
            variant="soft"
            tone="neutral"
            size="xs"
            className="flex-1"
            title="Revise all per annotations (AI edits with context; results go to Revisions for review/rollback)"
          >
            {revising ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            {revising ? 'Revising…' : 'Revise all per annotations'}
          </Button>
        </div>
      )}

      {/* 最近一轮「按批注修订」的结果回报：改了几条 / 哪几条失败及原因（失败项可点击跳回该批注） */}
      {reviseReport && (
        <div className="shrink-0 border-b px-2 py-1.5" style={{ borderColor: 'var(--line)' }}>
          <div className="flex items-center gap-1.5 text-10 font-medium">
            <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--success)' }} />
            <span style={{ color: 'var(--success)' }}>{reviseReport.revised.length} revised</span>
            {reviseReport.failed.length > 0 && (
              <span style={{ color: 'var(--danger)' }}>· {reviseReport.failed.length} failed</span>
            )}
            <span className="ml-auto" style={{ color: 'var(--ink-faint)' }}>{reviseReport.total} total</span>
          </div>
          {reviseReport.failed.length > 0 && (
            <div className="mt-1 flex flex-col gap-1">
              {reviseReport.failed.map((f) => {
                const ann = annotations.find((a) => a.id === f.annotationId);
                return (
                  <button
                    key={f.annotationId}
                    onClick={() => ann && onJumpToAnnotation(ann)}
                    className="rounded-md border px-1.5 py-1 text-left transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ borderColor: 'var(--line-soft)' }}
                    title="Click to jump to the annotation"
                  >
                    <span className="block truncate text-10 font-medium" style={{ color: 'var(--danger)' }}>
                      &ldquo;{f.quote.length > 24 ? `${f.quote.slice(0, 24)}…` : f.quote}&rdquo;
                    </span>
                    <span className="block text-10 leading-snug" style={{ color: 'var(--ink-muted)' }}>{f.reason}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 批注列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto ai-canvas-scroll px-2 py-2">
        {annotations.length === 0 && revisionRounds.length === 0 && (
          <div className="px-2 py-3 text-11 leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
            Select text → click the annotation button in the AI Edit panel to attach a comment. Then use &ldquo;AI revise&rdquo; on a card for a single edit, or &ldquo;Revise all per annotations&rdquo; to batch-process them.
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
                  <Button
                    onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                    variant="ghost"
                    tone="neutral"
                    size="micro"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (editText.trim()) onUpdateAnnotation(a.id, editText.trim());
                      setEditingId(null);
                    }}
                    variant="solid"
                    tone="brand"
                    size="micro"
                  >
                    <Check className="h-2.5 w-2.5" />
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-11 leading-relaxed" style={{ color: 'var(--ink)' }}>{a.content}</div>
            )}
            <div className="mt-0.5 flex items-center justify-between">
              <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                {a.resolved ? 'Resolved' : new Date(a.createdAt).toLocaleString()}
              </span>
              <div className="flex items-center gap-0.5">
                {!a.resolved && (
                  <>
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (editingId === a.id) {
                          setEditingId(null);
                        } else {
                          setEditingId(a.id);
                          setEditText(a.content);
                        }
                      }}
                      variant="ghost"
                      tone="neutral"
                      size="icon-xs"
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      title="Edit annotation"
                      aria-label="Edit annotation"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onRewriteAnnotation(a); }}
                      disabled={rewritingIndex >= 0 && a.id !== rewritingId}
                      className={`flex items-center gap-1 rounded px-1 py-0.5 text-10 font-medium transition-opacity hover:bg-[var(--paper-hover)] ${a.id === rewritingId ? '' : 'opacity-0 group-hover:opacity-100'}`}
                      style={{ color: 'var(--primary)' }}
                      title="AI revises this per the annotation (context-aware; result goes to Revisions for review/rollback)"
                    >
                      {a.id === rewritingId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        'AI revise'
                      )}
                    </button>
                  </>
                )}
                <Button
                  onClick={(e) => { e.stopPropagation(); onDeleteAnnotation(a.id); }}
                  variant="ghost"
                  tone="danger"
                  size="icon-xs"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  title="Delete annotation"
                  aria-label="Delete annotation"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
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
              No revisions yet. While this panel is open your own edits are recorded as revision rounds; close it to go back to AI revisions only. Use &ldquo;Revise all per annotations&rdquo; to generate AI revisions. Each round keeps its own history you can revisit anytime.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-10 font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                  History
                </span>
                <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                  {revisionRounds.length} rounds
                </span>
              </div>
              {revisionRounds.map((r, i) => {
                const active = r.id === activeRoundId;
                const roundPairs = r.ops?.length ? pairOps(r.ops) : pairRevisions(r.revisions);
                const pendingCount = pendingChangeCount(r);
                const ts = new Date(r.createdAt);
                const sameDay = ts.toDateString() === new Date().toDateString();
                const timeLabel = sameDay
                  ? `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
                  : `${ts.getMonth() + 1}/${ts.getDate()} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`;
                // 每轮摘要：优先关联批注意见，其次「改了什么」回报（note，由差异确定性生成），
                // 再退到修改内容截断（明确"改的是哪里"，避免 V 序号被误读为同一处迭代）
                const srcAnn = annotations.find((a) => a.id === r.annotationId);
                const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
                const summary = srcAnn?.content
                  ? `${clip(srcAnn.content, 18)}${r.note ? ` · ${r.note}` : ''}`
                  : r.note
                    ? r.note
                    : r.patch
                      ? `Changed "${clip(r.patch.oldText || '', 10)}"${r.patch.newText ? ` → "${clip(r.patch.newText, 10)}"` : ''}`
                      : (() => { const n = changeCount(r); return `${n} edit${n > 1 ? 's' : ''}`; })();
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
                      title={`${ts.toLocaleString()} — click to switch the document to this round`}
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
                          {r.author === 'user' && (
                            <span className="flex items-center gap-0.5 rounded px-1 py-px text-9 font-semibold" style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}>
                              <UserRound className="h-2.5 w-2.5" /> You
                            </span>
                          )}
                          {pendingCount > 0 && (
                            <span className="flex items-center gap-0.5 rounded px-1 py-px text-9 font-semibold" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
                              <span className="h-1 w-1 rounded-full" style={{ backgroundColor: 'var(--danger)' }} />
                              {pendingCount} pending
                            </span>
                          )}
                        </span>
                        <span className="truncate text-10" style={{ color: 'var(--ink-faint)' }} title={summary}>
                          {summary}
                        </span>
                      </span>
                      {active && (
                        <span className="flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-9 font-semibold" style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)', color: 'var(--primary)' }}>
                          <Eye className="h-2.5 w-2.5" /> Viewing
                        </span>
                      )}
                    </button>

                    {/* 轮内容：该轮修订配对，自上而下依次排版 */}
                    <div className="px-2 pb-2">
                      {active && pendingCount > 0 && (
                        <div className="mb-1.5 flex items-center justify-between rounded bg-[var(--paper-soft)] px-2 py-1">
                          <span className="text-10" style={{ color: 'var(--ink-muted)' }}>
                            {pendingCount} pending
                          </span>
                          <div className="flex items-center gap-1">
                            <Button
                              onClick={onAcceptAll}
                              variant="soft"
                              tone="success"
                              size="micro"
                              title="Accept all revisions in this round"
                            >
                              Accept all
                            </Button>
                            <Button
                              onClick={onRejectAll}
                              variant="soft"
                              tone="danger"
                              size="micro"
                              title="Reject all revisions in this round"
                            >
                              Reject all
                            </Button>
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
                            title="Click to jump to the change in the document"
                          >
                            <div className="mb-0.5 flex items-center justify-between">
                              <span className="text-10 font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                                {allRejected ? 'Rejected' : allAccepted ? 'Accepted' : 'Pending'}
                              </span>
                              <span className="flex items-center gap-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
                                <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/revision:opacity-100" style={{ color: 'var(--primary)' }}>
                                  <LocateFixed className="h-2.5 w-2.5" /> Locate
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
                                Before: {pair.oldText.length > 60 ? `${pair.oldText.slice(0, 60)}…` : pair.oldText}
                              </div>
                            )}
                            {pair.newText !== undefined && (
                              <div className="text-11 leading-relaxed" style={{ color: 'var(--success)' }}>
                                After: {pair.newText.length > 60 ? `${pair.newText.slice(0, 60)}…` : pair.newText}
                              </div>
                            )}
                            {active && !allAccepted && !allRejected && (
                              <div className="mt-0.5 flex items-center gap-1">
                                <Button
                                  onClick={(e) => { e.stopPropagation(); pair.items.forEach((r) => onAcceptRevision(keyOf(r))); }}
                                  variant="soft"
                                  tone="success"
                                  size="micro"
                                >
                                  Accept
                                </Button>
                                <Button
                                  onClick={(e) => { e.stopPropagation(); pair.items.forEach((r) => onRejectRevision(keyOf(r))); }}
                                  variant="soft"
                                  tone="danger"
                                  size="micro"
                                >
                                  Reject
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {active && pendingCount === 0 && roundPairs.length > 0 && (
                        <div className="mt-0.5 flex items-center gap-1 px-1 text-10" style={{ color: 'var(--success)' }}>
                          <Check className="h-3 w-3" /> All processed
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

      {/* 一致性检查视图：编号 / 交叉引用 / 术语（仅当前文档） */}
      {view === 'checks' && (
        <>
          <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5" style={{ borderColor: 'var(--line)' }}>
            <Button
              onClick={onRunChecks}
              disabled={checking}
              variant="soft"
              tone="neutral"
              size="micro"
              title="Check numbering, cross-references and terminology in this document"
            >
              {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListChecks className="h-3 w-3" />}
              {checking ? 'Checking…' : 'Run checks'}
            </Button>
            {consistencyItems && consistencyItems.length > 0 && (
              <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                {consistencyItems.length} item{consistencyItems.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto ai-canvas-scroll px-2 py-2">
            {!consistencyItems || consistencyItems.length === 0 ? (
              <div className="text-11 leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                {checking
                  ? 'Scanning this document…'
                  : 'Run checks to find numbering errors, broken cross-references and inconsistent terminology.'}
              </div>
            ) : (
              <CheckReport
                items={consistencyItems}
                onLocate={onJumpToCheck ? (it) => onJumpToCheck(it as ConsistencyItem) : undefined}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
