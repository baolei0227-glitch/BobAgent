'use client';

/**
 * 图片查看/编辑（Hippo Browser 专用）客户端实现
 *
 * 复用预览面板能力：yarl 画廊（缩放/旋转/下载/全屏）+ ImageAnnotator 标注（写回原文件）
 * + ImageAiEditor 图生图 AI 编辑（自然语言指令，自动保存原文件 / 另存副本）。
 * 页面零 App 外壳，供 Hippo Browser 独立窗口整页展示。
 * 标签名由同目录 page.tsx 的 generateMetadata 按 ?path= 写入 <title>。
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

const ImageViewer = dynamic(
  () => import('@/components/canvas/viewers/ImageViewer').then((m) => m.ImageViewer),
  { ssr: false },
);
const ImageAiEditor = dynamic(
  () => import('@/components/canvas/viewers/ImageAiEditor').then((m) => m.ImageAiEditor),
  { ssr: false },
);

function ImageViewerInner() {
  const sp = useSearchParams();
  const path = sp.get('path') || '';
  const fileName = useMemo(() => decodeURIComponent(path.split('/').pop() || 'image.png'), [path]);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [aiEdit, setAiEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 字节走统一本地代理 → dataURL（标注/AI 编辑都基于 dataURL 工作）
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/local-files?action=file_proxy&path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(`Failed to load, HTTP ${res.status}`);
        const blob = await res.blob();
        const url = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error('Failed to read the image'));
          r.readAsDataURL(blob);
        });
        if (!cancelled) setDataUrl(url);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  /** base64 dataURL 写回磁盘（同一通道，绝对路径不受项目根限制） */
  const saveTo = useCallback(async (targetPath: string, durl: string) => {
    const base64 = durl.split(',')[1] || '';
    const res = await fetch('/api/local-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'write', path: targetPath, content: base64, encoding: 'base64' }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Save failed');
  }, []);

  const fileInfo = useMemo(
    () =>
      dataUrl
        ? {
            name: fileName,
            type: 'image' as const,
            size: 0,
            extension: (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || 'png').toLowerCase(),
            full_path: path,
            content: dataUrl,
          }
        : null,
    [dataUrl, fileName, path],
  );

  if (error) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', fontFamily: 'system-ui, sans-serif' }}>
        {error}
      </div>
    );
  }
  if (!fileInfo) {
    return <div style={{ position: 'fixed', inset: 0, background: '#f4f4f5' }} />;
  }

  // 另存副本：同目录 <原名>-ai-edit.<ext>
  const ext = fileInfo.extension;
  const copyPath = path.replace(new RegExp(`\\.${ext}$`, 'i'), `-ai-edit.${ext}`);

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#f4f4f5' }}>
      <ImageViewer
        fileInfo={fileInfo}
        proxyUrl={null}
        onError={(m) => setError(m)}
        slides={[{ src: dataUrl!, alt: fileName, path }]}
        initialIndex={0}
        source="local"
        projectId=""
        onAiEditOverride={() => setAiEdit(true)}
      />
      {aiEdit && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40 }}>
          <ImageAiEditor
            src={dataUrl || undefined}
            fileName={fileName}
            allowGenerate={false}
            onImageChange={(d) => {
              if (!d) return;
              void saveTo(path, d)
                .then(() => setDataUrl(d))
                .catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}
            onSave={(d) => {
              void saveTo(path, d)
                .then(() => setDataUrl(d))
                .catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}
            onSaveAsCopy={(d) => {
              void saveTo(copyPath, d)
                .then(() => {
                  window.location.href = `/image-viewer?path=${encodeURIComponent(copyPath)}`;
                })
                .catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}
            onCancel={() => setAiEdit(false)}
          />
        </div>
      )}
    </div>
  );
}

export default function ImageViewerClient() {
  return (
    <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#f4f4f5' }} />}>
      <ImageViewerInner />
    </Suspense>
  );
}
