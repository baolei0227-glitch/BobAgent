'use client';

/**
 * ButlerOutboxPanel —— Butler 右栏「Outbox」分区。
 *
 * 入口：Butler 左栏的 Inbox 键（由 ButlerDrawer 渲染）。
 * 背景：管家派发的会话，交付物不再直接落「当前项目」的 homework/，而是先暂存在
 *      <appRoot>/outbox/<批次>/；待用户在本分区归口到某个项目（或让管家 outbox_assign）后再搬入。
 * 数据源：GET /api/outbox（批次 + 剩余天数）；动作：POST /api/outbox（assign / keep / discard）。
 * 布局：嵌入态（右栏分区），标题由 ButlerDrawer 的右栏顶部条承载，本面板只渲染工具栏 + 列表。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Inbox,
  Clock,
  FileText,
  FileSpreadsheet,
  Presentation,
  Image as ImageIcon,
  Code2,
  Trash,
  X,
  RefreshCw,
  Loader2,
  Check,
  ArrowRight,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/canvas/ConfirmDialog';

/** 一批产物内的单个文件（GET /api/outbox 下发形状） */
interface OutboxFile {
  rel: string;
  name: string;
  size: number;
  kind: string;
}

/** Outbox 批次行（面板展示用；仅 pending / kept 会被后端下发） */
interface OutboxBatchRow {
  batch_id: string;
  /** 批次状态：待归口 / 用户保留 */
  status: 'pending' | 'kept';
  /** 来源会话标题（会话回填，可为空） */
  label: string;
  created_at: string;
  /** 距自动清理的剩余天数（不可解析时为 null） */
  days_left: number | null;
  files: OutboxFile[];
  /** 归口过程中的异常说明（同名跳过等） */
  note: string | null;
}

/** 可归口的项目选项（来自 /api/projects 的 active_projects） */
interface ProjectOption {
  id: string;
  name: string;
}

/** 临期提醒窗口（天）：与后端 OUTBOX_WARN_BEFORE_DAYS 同口径；后端已算好 days_left，此处只做阈值展示 */
const WARN_BEFORE_DAYS = 7;

/** kind → 列表项图标（doc/other 回退 FileText） */
function kindIcon(kind: string) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (kind) {
    case 'sheet':
      return <FileSpreadsheet className={cls} style={{ color: 'var(--ink-muted)' }} />;
    case 'slide':
      return <Presentation className={cls} style={{ color: 'var(--ink-muted)' }} />;
    case 'image':
      return <ImageIcon className={cls} style={{ color: 'var(--ink-muted)' }} />;
    case 'code':
      return <Code2 className={cls} style={{ color: 'var(--ink-muted)' }} />;
    default:
      return <FileText className={cls} style={{ color: 'var(--ink-muted)' }} />;
  }
}

/** 文件大小（KB 取整；<1KB 显示字节） */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 创建时间本地化展示（不可解析时回退原串） */
function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

export function ButlerOutboxPanel() {
  const [batches, setBatches] = useState<OutboxBatchRow[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(false);
  /** 正在执行动作的批次 id（禁用该批按钮，避免重复提交） */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 每批选中的归口项目 id（batchId → projectId） */
  const [assignTarget, setAssignTarget] = useState<Record<string, string>>({});
  /** 一条内联结果提示（成功/失败） */
  const [msg, setMsg] = useState<string | null>(null);
  const [msgError, setMsgError] = useState(false);
  const { ask: askConfirm, render: confirmRender } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [outboxResp, projectsResp] = await Promise.all([
        fetch('/api/outbox'),
        fetch('/api/projects'),
      ]);
      // 先解析项目列表：归口下拉默认指向第一个项目，需要拿到最新 id
      const pd = await projectsResp.json().catch(() => null);
      const active = (pd?.active_projects as ProjectOption[]) || [];
      const nextProjects = active.map((p) => ({ id: p.id, name: p.name || p.id }));
      setProjects(nextProjects);
      const outbox = await outboxResp.json();
      if (outbox?.ok) {
        const list = (outbox.batches as OutboxBatchRow[]) || [];
        setBatches(list);
        // 归口选择默认指向第一个项目（用户仍可改）
        setAssignTarget((prev) => {
          const next = { ...prev };
          for (const b of list) {
            if (!next[b.batch_id] && nextProjects[0]?.id) next[b.batch_id] = nextProjects[0].id;
          }
          return next;
        });
      } else {
        setBatches([]);
      }
    } catch {
      setBatches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 提交一个动作（keep / discard / assign），完成后刷新列表 */
  const act = useCallback(
    async (action: 'keep' | 'discard' | 'assign', batchId: string, project?: string) => {
      setBusyId(batchId);
      setMsg(null);
      try {
        const resp = await fetch('/api/outbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, batch_id: batchId, ...(project ? { project } : {}) }),
        });
        const data = await resp.json().catch(() => ({}));
        if (data?.ok) {
          setMsg(data.message || 'Done.');
          setMsgError(false);
        } else {
          setMsg(data?.message || data?.error || 'Action failed.');
          setMsgError(true);
        }
      } catch {
        setMsg('Action failed — network error.');
        setMsgError(true);
      } finally {
        setBusyId(null);
        void load();
      }
    },
    [load],
  );

  const handleDiscard = useCallback(
    async (batch: OutboxBatchRow) => {
      const ok = await askConfirm({
        title: 'Discard staged outputs',
        message:
          `This permanently deletes batch "${batch.label || batch.batch_id}" and all of its ${batch.files.length} staged file(s).\n\nThis cannot be undone.`,
        confirmLabel: 'Discard',
        cancelLabel: 'Cancel',
      });
      if (ok) await act('discard', batch.batch_id);
    },
    [askConfirm, act],
  );

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/* 工具栏：批次数 + 刷新（标题由 ButlerDrawer 右栏顶部条承载，不在此重复） */}
        <div
          className="flex shrink-0 items-center gap-2 px-3 py-2"
          style={{ borderBottom: '1px solid var(--line-soft)' }}
        >
          <Inbox className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
          <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {batches.length} batch{batches.length === 1 ? '' : 'es'}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              tone="neutral"
              size="icon"
              onClick={() => void load()}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* 操作结果提示：一条内联条，可手动关闭 */}
        {msg && (
          <div
            className="flex shrink-0 items-start gap-2 px-3 py-2 text-xs"
            style={{
              borderBottom: '1px solid var(--line-soft)',
              backgroundColor: msgError
                ? 'color-mix(in oklab, var(--danger) 6%, transparent)'
                : 'color-mix(in oklab, var(--success) 6%, transparent)',
              color: msgError ? 'var(--danger)' : 'var(--success)',
            }}
          >
            {msgError ? (
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            ) : (
              <Check className="mt-px h-3.5 w-3.5 shrink-0" />
            )}
            <span className="flex-1 leading-relaxed">{msg}</span>
            <button
              type="button"
              onClick={() => setMsg(null)}
              className="shrink-0 rounded px-1 text-11 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              aria-label="Dismiss notice"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* 批次列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {loading && batches.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--primary)' }} />
            </div>
          ) : batches.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center">
              <Inbox className="h-8 w-8" style={{ color: 'var(--ink-muted)' }} />
              <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>No staged outputs</p>
              <p className="text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                Deliverables from Butler-dispatched sessions appear here until you file them into a project.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {batches.map((b) => {
                const daysLeft = b.days_left;
                const isWarn = typeof daysLeft === 'number' && daysLeft <= WARN_BEFORE_DAYS && b.status !== 'kept';
                const busy = busyId === b.batch_id;
                const selected = assignTarget[b.batch_id] || projects[0]?.id || '';
                return (
                  <div
                    key={b.batch_id}
                    className="rounded-xl border p-3"
                    style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}
                  >
                    {/* 批次头：来源会话 + 状态/临期徽标 + 时间（同排，不再另起一行；不显示文件数） */}
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                            {b.label || 'Untitled session'}
                          </span>
                          {b.status === 'kept' ? (
                            <span
                              className="rounded-full px-2 py-0.5 text-11 font-semibold"
                              style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}
                            >
                              Kept
                            </span>
                          ) : (
                            <span
                              className="rounded-full px-2 py-0.5 text-11 font-semibold"
                              style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}
                            >
                              Pending
                            </span>
                          )}
                          {isWarn && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-semibold"
                              style={{
                                backgroundColor: 'color-mix(in oklab, var(--warn) 14%, transparent)',
                                color: 'var(--warn)',
                              }}
                              title="Auto-cleanup window is nearly over"
                            >
                              <AlertTriangle className="h-3 w-3" />
                              {daysLeft} day{daysLeft === 1 ? '' : 's'} until cleanup
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                            <Clock className="h-3 w-3 shrink-0" />
                            {formatTime(b.created_at)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* 文件清单 */}
                    {b.files.length > 0 ? (
                      <ul className="mt-3 space-y-1">
                        {b.files.map((f) => (
                          <li key={f.rel} className="flex items-center gap-2">
                            {kindIcon(f.kind)}
                            <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink)' }}>
                              {f.rel}
                            </span>
                            <span className="shrink-0 text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                              {formatSize(f.size)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                        No files yet — the session may still be running.
                      </p>
                    )}

                    {/* 归口异常说明（同名跳过 / 复制失败） */}
                    {b.note && (
                      <p className="mt-2 text-xs" style={{ color: 'var(--warn)' }}>
                        {b.note}
                      </p>
                    )}

                    {/* 动作区：Assign（项目下拉） / Keep / Discard */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <div
                        className="flex items-center gap-1 rounded-md border px-1.5"
                        style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}
                      >
                        <select
                          value={selected}
                          onChange={(e) => setAssignTarget((prev) => ({ ...prev, [b.batch_id]: e.target.value }))}
                          disabled={busy || projects.length === 0}
                          className="max-w-[140px] bg-transparent py-1 text-xs outline-none"
                          style={{ color: 'var(--ink)' }}
                        >
                          {projects.length === 0 ? (
                            <option value="">No projects</option>
                          ) : (
                            projects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                      <Button
                        variant="solid"
                        tone="brand"
                        size="sm"
                        disabled={busy || projects.length === 0 || !selected}
                        onClick={() => void act('assign', b.batch_id, selected)}
                      >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                        Assign
                      </Button>
                      <Button
                        variant="outline"
                        tone="neutral"
                        size="sm"
                        disabled={busy || b.status === 'kept'}
                        onClick={() => void act('keep', b.batch_id)}
                        title={b.status === 'kept' ? 'Already kept' : 'Keep this batch (exempt from auto-cleanup)'}
                      >
                        Keep
                      </Button>
                      <Button
                        variant="ghost"
                        tone="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleDiscard(b)}
                        title="Discard this batch and all its staged files"
                      >
                        <Trash className="h-3.5 w-3.5" />
                        Discard
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {confirmRender}
    </>
  );
}
