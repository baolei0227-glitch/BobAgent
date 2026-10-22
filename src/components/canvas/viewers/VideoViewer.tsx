'use client';

/**
 * VideoViewer —— 预览面板里的视频查看器（mp4 / m4v / mov 直接内播）。
 *
 * 数据源与音频一致：用调度层给的 proxyUrl。两个 file_proxy 路由（/api/local-files、/api/projects）
 * 都已支持 HTTP Range 单区间（lib/files/range.ts），所以进度条拖动只按需拉片段，不会整份读进内存。
 *
 * 能力边界（2026-10-18 实测 Electron 43.2.0 / Chromium 150，Hippo 内网页视频同一套媒体栈）：
 *   - 可播：H.264 + AAC（mp4 / mov）、AV1、VP8 / VP9；
 *   - 不可播：HEVC / H.265（iPhone 拍的 .mov 常见）、DRM 加密片源、Chromium 不解复用的容器（mkv / avi / wmv）。
 *     这些一律走 `<video>` 的 error 分支——**面板内如实报"放不了"并给"用默认应用打开"的出口**，
 *     不调用 onError（那是调度层的整页错误态，会把播放器整个换掉，反而让用户失去出口）。
 *   - 容器类不注册进 registry（仍由 binary 兜底），避免打开即失败的空壳。
 *
 * `.webm` 归属：lib/files/mime.ts 按容器口径算视频，但 registry 里 audio 分支先命中它
 * （既有行为：webm 音频进音频编辑器），本轮不动，避免把音频编辑入口挪走。
 */
import { useState } from 'react';
import { ExternalLink, Film, Loader2 } from 'lucide-react';
import type { ViewerRenderProps } from './types';
import { desktop } from '@/lib/desktop-adapter';

export function VideoViewer({ fileInfo, proxyUrl, fileName }: ViewerRenderProps) {
  const path = fileInfo.full_path || '';
  const name = fileName || fileInfo.name || 'Video';
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const openExternally = async () => {
    if (!path) return;
    try {
      await desktop.openFile(path);
    } catch {
      /* 外部打开失败不改面板状态（与 BinaryViewer 同口径） */
    }
  };

  const fallback = (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <Film className="h-10 w-10" style={{ color: 'var(--ink-faint)' }} />
      <p className="max-w-sm truncate text-sm" style={{ color: 'var(--ink)' }}>{name}</p>
      <p className="max-w-sm text-xs" style={{ color: 'var(--ink-muted)' }}>
        {failed
          ? 'This video cannot be played here — its codec or container is not supported (HEVC/H.265, DRM-protected, or an unsupported container such as mkv/avi).'
          : 'Video preview is unavailable — the file could not be read.'}
      </p>
      {path && (
        <button
          type="button"
          onClick={() => void openExternally()}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium"
          style={{ backgroundColor: 'var(--info)', color: '#fff' }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open with default program
        </button>
      )}
    </div>
  );

  if (!proxyUrl || failed) return fallback;

  return (
    <div className="relative flex h-full items-center justify-center">
      {!ready && (
        <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--ink-faint)' }} />
      )}
      <video
        src={proxyUrl}
        controls
        preload="metadata"
        playsInline
        className={ready ? 'max-h-full max-w-full' : 'hidden'}
        onLoadedMetadata={() => setReady(true)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
