'use client';

/**
 * PDF 阅读器（Hippo Browser 专用）
 *
 * Hippo Browser 打开本地 PDF（file://*.pdf）时，主进程将导航重定向到本页：
 *   http://localhost:<port>/pdf-viewer?path=<绝对路径>
 * 复用预览面板 PdfViewer 能力：PDF.js 渲染 + sidecar 批注（高亮/文字框）+ 全文检索（含扫描件 OCR）。
 * 页面零 App 外壳，供 Hippo Browser 独立窗口整页展示。
 */

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

const PdfViewer = dynamic(() => import('@/components/canvas/PdfViewer').then((m) => m.PdfViewer), { ssr: false });

function PdfViewerInner() {
  const sp = useSearchParams();
  const path = sp.get('path') || '';

  // 字节走统一本地代理（返回 application/pdf），批注 sidecar 按绝对路径读写
  const proxyUrl = path ? `/api/local-files?action=file_proxy&path=${encodeURIComponent(path)}` : '';
  const fileName = useMemo(() => (path.split('/').pop() || 'document.pdf'), [path]);

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#f4f4f5' }}>
      <PdfViewer url={proxyUrl} fileName={fileName} filePath={path || undefined} />
    </div>
  );
}

export default function PdfViewerPage() {
  return (
    <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#f4f4f5' }} />}>
      <PdfViewerInner />
    </Suspense>
  );
}
