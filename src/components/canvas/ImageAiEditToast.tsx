'use client';

import { useEffect, useState } from 'react';
import {
  onImageAiEditToastChange,
  getImageAiEditToasts,
  type ImageAiEditToast,
} from '@/lib/image-ai-edit-runtime';

/**
 * ImageAiEditor 生成完成/失败 的全局轻量提示。
 * 需挂在预览面板之外（折叠面板时 ImageAiEditor 为 display:none，其内部提示不可见）。
 */
export function ImageAiEditToast() {
  const [toasts, setToasts] = useState<ImageAiEditToast[]>(() => getImageAiEditToasts());

  useEffect(() => onImageAiEditToastChange(() => setToasts(getImageAiEditToasts())), []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 top-[60px] z-[300] flex flex-col gap-2"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-xl"
          style={{
            width: 336,
            backgroundColor: 'var(--paper)',
            borderColor: t.kind === 'error' ? 'var(--danger)' : 'var(--success)',
            color: 'var(--ink)',
            fontFamily: "var(--font-sans)",
          }}
        >
          <span className="mt-0.5 text-base leading-none">{t.kind === 'error' ? '⚠️' : '✅'}</span>
          <span className="flex-1 leading-snug">{t.message}</span>
        </div>
      ))}
    </div>
  );
}