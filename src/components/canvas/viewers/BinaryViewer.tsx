'use client';

import { File as FileIcon, ExternalLink } from 'lucide-react';
import type { ViewerRenderProps } from './types';
import { desktop } from '@/lib/desktop-adapter';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 二进制渲染器：占位提示 + 用系统默认程序打开 */
export function BinaryViewer({ fileInfo }: ViewerRenderProps) {
  const handleOpen = async () => {
    try {
      if (fileInfo.full_path) {
        await desktop.openFile(fileInfo.full_path);
      }
    } catch { console.error('Failed to open file'); }
  };
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <FileIcon className="h-12 w-12" style={{ color: 'var(--ink-faint)' }} />
      <p className="text-sm" style={{ color: 'var(--ink)' }}>Binary file — cannot preview online</p>
      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>{formatSize(fileInfo?.size || 0)}</p>
      <button onClick={handleOpen} className="mt-2 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-colors"
        style={{ backgroundColor: 'var(--info)', color: '#fff' }}>
        <ExternalLink className="h-3.5 w-3.5" />Open with default program
      </button>
    </div>
  );
}
