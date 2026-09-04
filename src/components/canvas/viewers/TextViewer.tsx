'use client';

import type { ViewerRenderProps } from './types';

/** 纯文本渲染器（兜底） */
export function TextViewer({ fileInfo }: ViewerRenderProps) {
  return (
    <pre className="px-6 py-4 text-xs leading-relaxed whitespace-pre-wrap flex-1 overflow-y-auto ai-canvas-scroll"
      style={{ color: 'var(--ink)', fontFamily: "var(--font-mono)" }}>
      {fileInfo.content}
    </pre>
  );
}
