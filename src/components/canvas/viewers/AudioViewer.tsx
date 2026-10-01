'use client';

import { useEffect, useRef, useState } from 'react';
import { Music, ExternalLink } from 'lucide-react';
import type { ViewerRenderProps } from './types';
import { desktop } from '@/lib/desktop-adapter';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 音频渲染器：用代理 URL 直接播放（会议录音等）；代理不可用时回退"用默认程序打开"。 */
export function AudioViewer({ fileInfo, proxyUrl, fileName, onError }: ViewerRenderProps) {
  const name = fileName || fileInfo?.name || 'Audio';
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [failed, setFailed] = useState(false);

  // 换文件时重置失败态，避免上一首的报错残留到下一首
  useEffect(() => { setFailed(false); }, [proxyUrl, name]);

  const handleOpen = async () => {
    try {
      if (fileInfo?.full_path) await desktop.openFile(fileInfo.full_path);
    } catch { console.error('Failed to open file'); }
  };

  const canPlay = !!proxyUrl && !failed;

  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-16">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-full"
        style={{ backgroundColor: 'var(--info-soft)' }}
      >
        <Music className="h-7 w-7" style={{ color: 'var(--info)' }} />
      </div>

      <div className="max-w-full text-center">
        <p className="truncate text-sm font-medium" style={{ color: 'var(--ink)' }}>{name}</p>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>{formatSize(fileInfo?.size || 0)}</p>
      </div>

      {canPlay ? (
        <audio
          ref={audioRef}
          src={proxyUrl}
          controls
          className="w-full max-w-md"
          onError={() => {
            setFailed(true);
            onError('Failed to load audio');
          }}
        />
      ) : (
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          {failed ? 'Playback failed — try opening with the default program' : 'Audio preview unavailable'}
        </p>
      )}

      {!!fileInfo?.full_path && (
        <button
          onClick={handleOpen}
          className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-colors"
          style={{ backgroundColor: 'var(--info)', color: '#fff' }}
        >
          <ExternalLink className="h-3.5 w-3.5" />Open with default program
        </button>
      )}
    </div>
  );
}