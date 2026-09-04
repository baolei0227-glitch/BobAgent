'use client';

import dynamic from 'next/dynamic';
import type { ViewerRenderProps } from './types';

const PdfViewer = dynamic(() => import('../PdfViewer').then((m) => m.PdfViewer), { ssr: false });

/** PDF 渲染器：直接使用统一 PdfViewer 组件（命名加 Canvas 后缀以区别上层 PdfViewer） */
export function PdfCanvasViewer({ proxyUrl, fileName, fileInfo }: ViewerRenderProps) {
  // full_path 为 PDF 绝对路径，PdfViewer 用它读写同目录 sidecar 批注（.annotations.json）
  return <PdfViewer url={proxyUrl || ''} fileName={fileName || 'document.pdf'} filePath={fileInfo?.full_path} />;
}
