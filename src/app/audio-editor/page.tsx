'use client';

/**
 * 全页音频编辑器（Hippo 大屏入口）。
 *
 * 为什么单独一条路由：画布预览面板只有 ~600px，波形 + 对话稿上下堆叠后两边都不够用；
 * Hippo 是独立窗口，这里给满宽两栏（左波形/片段，右对话稿/清单）。
 *
 * 参数（由预览面板的启动卡 / 左栏 Audio Editor 入口拼出）：
 *   path = 音频绝对路径（local 口径；项目文件也用绝对路径走 /api/local-files）
 *   name = 展示名（库标题/文件名）
 *   size = 可选字节数，仅用于标题栏显示
 *
 * 不带 path = 空编辑器（Library / Import 入口）。
 * ⚠️ Hippo 的网页 view 是 sandbox:true、没有 preload ⇒ 本页不能依赖 window.api；
 *    所有能力都走同源 HTTP（loopback 免鉴权）。
 */
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AudioViewer } from '@/components/canvas/viewers/AudioViewer';
import type { FileInfo } from '@/lib/files/types';

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

function EditorPage() {
  const params = useSearchParams();
  const path = params.get('path')?.trim() || '';
  const name = params.get('name')?.trim() || 'Audio';
  const size = Number(params.get('size') || 0) || 0;
  const proxyUrl = path
    ? `/api/local-files?action=file_proxy&path=${encodeURIComponent(path)}`
    : null;
  const fileInfo: FileInfo = {
    name,
    type: 'binary',
    size,
    extension: extOf(name),
    full_path: path,
  };

  return (
    <main className="h-screen w-screen overflow-hidden" style={{ backgroundColor: 'var(--paper)' }}>
      <AudioViewer
        wide
        fileInfo={fileInfo}
        proxyUrl={proxyUrl}
        fileName={name}
        source="local"
        onError={(message) => console.error('[audio-editor]', message)}
      />
    </main>
  );
}

export default function AudioEditorPage() {
  return (
    <Suspense
      fallback={
        <main className="flex h-screen w-screen items-center justify-center" style={{ backgroundColor: 'var(--paper)' }}>
          <span className="text-12" style={{ color: 'var(--ink-muted)' }}>Loading audio editor…</span>
        </main>
      }
    >
      <EditorPage />
    </Suspense>
  );
}
