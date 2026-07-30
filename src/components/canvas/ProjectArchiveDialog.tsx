'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Archive, Loader2 } from 'lucide-react';

interface ProjectArchiveDialogProps {
  open: boolean;
  projectId: string;
  projectName: string;
  isArchived: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

interface Stats {
  nodeCount: number;
  dbSizeKB: number;
  createdDaysAgo: number;
}

export function ProjectArchiveDialog({
  open,
  projectId,
  projectName,
  isArchived,
  onOpenChange,
  onDone,
}: ProjectArchiveDialogProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !projectId) return;
    setStats(null);
    setError('');
    fetch(`/api/projects?action=stats&project_id=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setStats(d.stats);
      })
      .catch(() => {});
  }, [open, projectId]);

  const handleConfirm = async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: isArchived ? 'unarchive' : 'archive',
          project_id: projectId,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        onOpenChange(false);
        onDone?.();
        window.location.reload();
      } else {
        setError(data.error || '操作失败');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={() => !loading && onOpenChange(false)}
    >
      <div
        className="rounded-xl p-6 shadow-2xl"
        style={{
          backgroundColor: 'oklch(0.97 0.015 80)',
          border: '1px solid oklch(0.80 0.03 60 / 0.4)',
          width: '400px',
          fontFamily: "'Noto Serif SC', serif",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{
                backgroundColor: isArchived
                  ? 'oklch(0.55 0.15 45 / 0.12)'
                  : 'oklch(0.50 0.02 50 / 0.1)',
              }}
            >
              <Archive
                className="h-4 w-4"
                style={{
                  color: isArchived ? 'oklch(0.55 0.15 45)' : 'oklch(0.50 0.02 50)',
                }}
              />
            </div>
            <div>
              <h3 className="text-base font-semibold" style={{ color: 'oklch(0.30 0.015 50)' }}>
                {isArchived ? '取消归档' : '确认归档'}
              </h3>
              <p className="text-[11px] mt-0.5" style={{ color: 'oklch(0.55 0.02 50)' }}>
                {isArchived ? '将项目恢复到活跃列表' : '将项目从活跃列表移除'}
              </p>
            </div>
          </div>
          <button
            onClick={() => !loading && onOpenChange(false)}
            className="rounded-md p-1 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
            style={{ color: 'oklch(0.50 0.02 50)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          className="rounded-lg border px-4 py-3 space-y-2"
          style={{
            borderColor: 'oklch(0.80 0.03 60 / 0.4)',
            backgroundColor: 'oklch(1 0 0 / 0.4)',
          }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
              项目
            </span>
            <span className="text-[12px] font-medium" style={{ color: 'oklch(0.35 0.02 50)' }}>
              {projectName}
            </span>
          </div>
          {stats && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  节点数
                </span>
                <span className="text-[12px]" style={{ color: 'oklch(0.40 0.02 50)' }}>
                  {stats.nodeCount}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  数据库
                </span>
                <span className="text-[12px]" style={{ color: 'oklch(0.40 0.02 50)' }}>
                  {stats.dbSizeKB < 1024
                    ? `${stats.dbSizeKB} KB`
                    : `${(stats.dbSizeKB / 1024).toFixed(1)} MB`}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  天龄
                </span>
                <span className="text-[12px]" style={{ color: 'oklch(0.40 0.02 50)' }}>
                  {stats.createdDaysAgo} 天
                </span>
              </div>
            </>
          )}
        </div>

        {isArchived ? (
          <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'oklch(0.50 0.02 50)' }}>
            取消归档后，该项目将重新出现在活跃项目列表中，可正常切换和编辑。
          </p>
        ) : (
          <div
            className="mt-3 rounded-lg px-3 py-2.5 space-y-1.5"
            style={{
              backgroundColor: 'oklch(0.62 0.17 45 / 0.06)',
              border: '1px solid oklch(0.62 0.17 45 / 0.15)',
            }}
          >
            <p className="text-[11px] leading-relaxed" style={{ color: 'oklch(0.55 0.15 45)' }}>
              归档后：
            </p>
            <ul className="text-[11px] leading-relaxed pl-4" style={{ color: 'oklch(0.50 0.02 50)' }}>
              <li>· 不再出现在活跃项目列表中</li>
              <li>· 无法切换为当前项目</li>
              <li>· 数据文件保留，随时可恢复</li>
            </ul>
          </div>
        )}

        {error && (
          <div
            className="mt-3 rounded-md px-3 py-2 text-[11px]"
            style={{
              backgroundColor: 'oklch(0.55 0.18 27 / 0.08)',
              color: 'oklch(0.55 0.18 27)',
            }}
          >
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            disabled={loading}
            className="rounded-md px-3 py-1.5 text-xs transition-colors hover:bg-[rgba(0,0,0,0.04)] disabled:opacity-50"
            style={{ color: 'oklch(0.50 0.02 50)' }}
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              backgroundColor: isArchived ? 'oklch(0.55 0.15 45)' : 'oklch(0.50 0.02 50)',
              color: 'white',
            }}
          >
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            {isArchived ? '取消归档' : '确认归档'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
