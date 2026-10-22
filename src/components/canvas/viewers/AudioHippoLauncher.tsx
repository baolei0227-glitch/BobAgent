'use client';

/**
 * 预览面板里的音频启动卡。
 *
 * 音频编辑器已经移到 Hippo 全页（`/audio-editor`）：
 *   - 打开音频文件时**自动**在 Hippo 里打开，不再在窄面板里渲染波形/对话稿；
 *   - 自动打开失败（Hippo 未就绪 / 非桌面）时，这张卡保留一个手动入口；
 *   - 卡片本身不依赖 window.api，非 Electron 环境退化为新标签打开。
 */
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Music } from 'lucide-react';
import type { ViewerRenderProps } from './types';
import { desktop, isDesktop } from '@/lib/desktop-adapter';
import { audioEditorUrl } from '@/lib/hippo-browser/audio-editor-url';

export function AudioHippoLauncher({ fileInfo, fileName }: ViewerRenderProps) {
  const path = fileInfo.full_path || '';
  const name = fileName || fileInfo.name || 'Audio';
  const [error, setError] = useState<string | null>(null);
  const lastPathRef = useRef('');

  const open = async () => {
    const url = audioEditorUrl({ path, name, size: fileInfo.size });
    if (!isDesktop()) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    try {
      await desktop.hippoBrowser.open();
      const r = await desktop.hippoBrowser.navigate(url);
      if (!r.ok) setError(r.error || 'Could not open Hippo Browser');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open Hippo Browser');
    }
  };

  // 打开音频文件即进 Hippo：同一路径只自动尝试一次；换文件/失败后仍保留手动按钮
  useEffect(() => {
    if (!path || !isDesktop() || lastPathRef.current === path) return;
    lastPathRef.current = path;
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div
        className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl px-6 py-8 text-center"
        style={{ border: '1px solid var(--line)', backgroundColor: 'var(--panel-bg)' }}
      >
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary-strong)' }}
        >
          <Music className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" style={{ color: 'var(--ink)' }}>{name}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
            Audio editing opens in Hippo — full-width waveform and transcript.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void open()}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
          style={{ backgroundColor: 'var(--primary-strong)', color: '#fff' }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open in Hippo
        </button>
        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">{error}</p>
        )}
      </div>
    </div>
  );
}
