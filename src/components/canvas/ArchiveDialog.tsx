'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Archive, RotateCcw, Loader2, AlertTriangle, Trash2, SquareCheck, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TagScope } from '@/lib/files/tags';

interface ArchivedItem {
  /** 去掉 .archive 前缀的作用域根相对路径（归档前的原始路径） */
  path: string;
  name: string;
  size: number;
  archivedAt: string;
}

interface ArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 作用域：materials 资料 / homework 作业产物 */
  scope: TagScope;
  /** 恢复 / 永久删除成功后回调（调用方据此刷新文件树与标签表） */
  onChanged?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 归档箱：列出 <作用域根>/.archive/ 下的条目，支持批量恢复与永久删除。
 *  归档目录是点目录，资料树与搜索都不会展示，因此需要这个独立入口。 */
export function ArchiveDialog({ open, onOpenChange, scope, onChanged }: ArchiveDialogProps) {
  const [items, setItems] = useState<ArchivedItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/materials?action=archived&scope=${scope}`);
      const data = await resp.json();
      if (data?.success && Array.isArray(data.items)) {
        setItems(data.items as ArchivedItem[]);
      } else {
        setError(data?.error || 'Failed to load archive');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSelected(new Set());
      setConfirmDelete(false);
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allSelected = items.length > 0 && selected.size === items.length;

  /** 批量恢复：一次请求搬运整批（保留原相对路径；目标同名时服务端自动追加后缀） */
  const restoreSelected = async () => {
    const paths = items.map((it) => it.path).filter((p) => selected.has(p));
    if (paths.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_archived', scope, items: paths, archived: false }),
      });
      const data = await resp.json();
      if (!data?.success) {
        setError(data?.error || 'Restore failed');
        return;
      }
      const failed = Array.isArray(data.failed) ? data.failed.length : 0;
      if (failed > 0) setError(`${failed} item(s) could not be restored`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 永久删除：走 DELETE 接口（path 为 .archive 下的相对路径），逐项执行以便部分失败时仍保留其余项 */
  const deleteSelected = async () => {
    const paths = items.map((it) => it.path).filter((p) => selected.has(p));
    if (paths.length === 0) return;
    setBusy(true);
    setError(null);
    let failed = 0;
    try {
      for (const rel of paths) {
        const resp = await fetch(
          `/api/materials?scope=${scope}&path=${encodeURIComponent(`.archive/${rel}`)}`,
          { method: 'DELETE' },
        );
        const data = await resp.json().catch(() => null);
        if (!data?.success) failed += 1;
      }
      if (failed > 0) setError(`${failed} item(s) could not be deleted`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setConfirmDelete(false); onOpenChange(v); }}>
      <DialogContent className="max-w-md gap-3 p-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-13 font-semibold" style={{ color: 'var(--ink-strong)' }}>
            <Archive className="h-4 w-4" />
            Archive
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {error && (
            <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {items.length > 0 && (
            <div className="flex items-center gap-2 text-11" style={{ color: 'var(--ink-muted)' }}>
              <button
                type="button"
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-[var(--line)]"
                onClick={() => setSelected(allSelected ? new Set() : new Set(items.map((it) => it.path)))}
                disabled={busy}
              >
                {allSelected ? <SquareCheck className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                {allSelected ? 'Clear' : 'Select all'}
              </button>
              <span>{selected.size} / {items.length}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--ink-muted)' }} />
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center">
              <Archive className="mx-auto h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
            </div>
          ) : (
            <div className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
              {items.map((it) => {
                const isChecked = selected.has(it.path);
                return (
                  <button
                    key={it.path}
                    type="button"
                    disabled={busy}
                    onClick={() => toggle(it.path)}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-left"
                    style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}
                  >
                    {isChecked ? (
                      <SquareCheck className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--brand)' }} />
                    ) : (
                      <Square className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-13 font-medium">{it.name}</div>
                      <div className="truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                        {new Date(it.archivedAt).toLocaleDateString()} · {formatSize(it.size)}
                        {it.path.includes('/') ? ` · ${it.path.slice(0, it.path.lastIndexOf('/'))}` : ''}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-1.5 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
          {confirmDelete ? (
            <>
              <Button variant="outline" tone="neutral" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="solid"
                tone="danger"
                size="sm"
                disabled={busy || selected.size === 0}
                loading={busy}
                onClick={() => void deleteSelected()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Confirm Delete
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                tone="danger"
                size="sm"
                disabled={busy || selected.size === 0}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete permanently
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                disabled={busy || selected.size === 0}
                loading={busy}
                onClick={() => void restoreSelected()}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restore
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
