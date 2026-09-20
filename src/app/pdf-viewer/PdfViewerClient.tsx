'use client';

/**
 * PDF 阅读器（Hippo Browser 专用）客户端实现
 *
 * 复用预览面板 PdfViewer 能力：PDF.js 渲染 + sidecar 批注（高亮/文字框）+ 全文检索（含扫描件 OCR）。
 * 页面零 App 外壳，供 Hippo Browser 独立窗口整页展示。
 * 标签名由同目录 page.tsx 的 generateMetadata 按 ?path= 写入 <title>。
 */

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

const PdfViewer = dynamic(() => import('@/components/canvas/PdfViewer').then((m) => m.PdfViewer), { ssr: false });

function PdfViewerInner() {
  const sp = useSearchParams();
  const path = sp.get('path') || '';
  // 外部深链定位锚点：page=页码（1-based）、q=关键词片段（文档内检索高亮）
  const pageParam = Number(sp.get('page') || '');
  const initialPage = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : undefined;
  const initialQuery = (sp.get('q') || '').trim() || undefined;

  // 字节走统一本地代理（返回 application/pdf），批注 sidecar 按绝对路径读写
  const proxyUrl = path ? `/api/local-files?action=file_proxy&path=${encodeURIComponent(path)}` : '';
  const fileName = useMemo(() => (path.split('/').pop() || 'document.pdf'), [path]);

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#f4f4f5' }}>
      <PdfViewer
        url={proxyUrl}
        fileName={fileName}
        filePath={path || undefined}
        initialPage={initialPage}
        initialQuery={initialQuery}
      />
    </div>
  );
}

export default function PdfViewerClient() {
  return (
    <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#f4f4f5' }} />}>
      <PdfViewerInner />
    </Suspense>
  );
}
