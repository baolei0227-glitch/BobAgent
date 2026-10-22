'use client';

/**
 * 独立 Markdown 阅读器（Hippo 里由音频稿的「Open as Markdown」打开）。
 *
 * 为什么单独一条路由：Hippo 的网页 view 没有 preload，不能发布画布内的 `file.open`；
 * 这里用同源 HTTP 读文件，再复用应用自己的 Markdown 阅读器（MdViewer / DocEditor）。
 *
 * 参数：path = .md 绝对路径；name = 展示名。
 */
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MdViewer } from '@/components/canvas/viewers/MdViewer';
import type { FileInfo } from '@/lib/files/types';

function MarkdownPage() {
  const params = useSearchParams();
  const path = params.get('path')?.trim() || '';
  const name = params.get('name')?.trim() || path.split('/').pop() || 'Transcript.md';
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setError('Missing file path');
      return;
    }
    let cancelled = false;
    setContent(null);
    setError(null);
    fetch(`/api/local-files?action=read_file&path=${encodeURIComponent(path)}`)
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => null) }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok || !data?.success || typeof data.content !== 'string') {
          setError(String(data?.error || 'Could not read this Markdown file'));
          return;
        }
        setContent(data.content);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read this Markdown file');
      });
    return () => { cancelled = true; };
  }, [path]);

  if (error) {
    return (
      <main className="flex h-screen w-screen items-center justify-center px-8" style={{ backgroundColor: 'var(--paper)' }}>
        <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
      </main>
    );
  }
  if (content === null) {
    return (
      <main className="flex h-screen w-screen items-center justify-center" style={{ backgroundColor: 'var(--paper)' }}>
        <span className="text-12" style={{ color: 'var(--ink-muted)' }}>Loading Markdown…</span>
      </main>
    );
  }

  const fileInfo: FileInfo = {
    name,
    type: 'text',
    content,
    size: content.length,
    extension: '.md',
    full_path: path,
  };

  return (
    <main className="h-screen w-screen overflow-hidden" style={{ backgroundColor: 'var(--paper)' }}>
      <MdViewer
        fileInfo={fileInfo}
        source="local"
        filePath={path}
        fileName={name}
        proxyUrl={null}
        onError={(message) => setError(message)}
      />
    </main>
  );
}

export default function MarkdownViewPage() {
  return (
    <Suspense
      fallback={
        <main className="flex h-screen w-screen items-center justify-center" style={{ backgroundColor: 'var(--paper)' }}>
          <span className="text-12" style={{ color: 'var(--ink-muted)' }}>Loading Markdown…</span>
        </main>
      }
    >
      <MarkdownPage />
    </Suspense>
  );
}
