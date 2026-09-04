'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Trash2, RotateCcw, Loader2, AlertTriangle } from 'lucide-react';

interface TrashItem {
  file: string;
  node_id: string;
  title: string;
  deleted_at: string;
  size: number;
  turns: number;
}

interface TrashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

/** 项目节点回收站：列出删除节点时自动备份到 .trash/nodes/ 的 .md，支持单个恢复与一键清空 */
export function TrashDialog({ open, onOpenChange, projectId }: TrashDialogProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/nodes?action=list_trash&project_id=${encodeURIComponent(projectId)}`);
      const data = await resp.json();
      if (data?.success && Array.isArray(data.items)) {
        setItems(data.items as TrashItem[]);
      } else {
        setError(data?.error || 'Failed to load trash');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const restore = async (file: string) => {
    setBusyFile(file);
    setError(null);
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore_trash', file, project_id: projectId }),
      });
      const data = await resp.json();
      if (data?.success) {
        await load();
        window.dispatchEvent(new CustomEvent('local-files-changed'));
      } else {
        setError(data?.error || 'Restore failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFile(null);
    }
  };

  const emptyTrash = async () => {
    setEmptying(true);
    setError(null);
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'empty_trash', project_id: projectId }),
      });
      const data = await resp.json();
      if (data?.success) {
        setItems([]);
        setConfirmEmpty(false);
      } else {
        setError(data?.error || 'Empty trash failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEmptying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setConfirmEmpty(false); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4" />
            Trash (Recycle Bin)
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {error && (
            <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--ink-muted)' }} />
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center">
              <Trash2 className="mx-auto h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
            </div>
          ) : (
            <div className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
              {items.map((it) => (
                <div
                  key={it.file}
                  className="flex items-center gap-2 rounded-lg border px-3 py-2"
                  style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)' }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{it.title || 'Untitled'}</div>
                    <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {new Date(it.deleted_at).toLocaleString()} · {it.turns} turn{it.turns === 1 ? '' : 's'} · {(it.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busyFile !== null}
                    onClick={() => void restore(it.file)}
                    title="Restore node"
                    className="flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:opacity-80 disabled:opacity-50"
                    style={{ backgroundColor: 'var(--brand)', color: 'var(--brand-on)' }}
                  >
                    {busyFile === it.file ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end border-t pt-3" style={{ borderColor: 'var(--line)' }}>
          {items.length > 0 && (
            confirmEmpty ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={emptying}
                  onClick={() => setConfirmEmpty(false)}
                  className="h-7 rounded-md px-2.5 text-xs transition-colors hover:opacity-80 disabled:opacity-50"
                  style={{ border: '1px solid var(--line)' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={emptying}
                  onClick={() => void emptyTrash()}
                  className="flex h-7 items-center gap-1 rounded-md px-2.5 text-xs text-white transition-colors hover:opacity-80 disabled:opacity-50"
                  style={{ backgroundColor: 'var(--danger)' }}
                >
                  {emptying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Confirm Empty
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmEmpty(true)}
                className="flex h-7 items-center gap-1 rounded-md px-2.5 text-xs transition-colors hover:opacity-80"
                style={{ border: '1px solid var(--danger)', color: 'var(--danger)' }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Empty Trash
              </button>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
