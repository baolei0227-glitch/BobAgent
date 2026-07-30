'use client';

import React, { useMemo } from 'react';
import { createRenderer } from 'unified-renderer';
import type { SanitizeWhitelist } from 'unified-renderer';
import 'highlight.js/styles/github.css';

interface HtmlRendererProps {
  content: string;
}

/** sanitize 白名单扩展：允许 AI 输出的交互元素和标注 */
const whitelist: SanitizeWhitelist = {
  tags: ['details', 'summary', 'mark'],
  attributes: {
    mark: ['data-note'],
    a: ['target', 'rel'],
    code: ['class'],
    pre: ['class'],
    span: ['class'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    table: ['class'],
    img: ['class', 'style'],
  },
};

const renderer = createRenderer({
  format: 'markdown',
  gfm: true,
  sanitize: true,
  slug: true,
  highlight: true,
  allowDangerousHtml: true,
  sanitizeWhitelist: whitelist,
});

/** 基于 unified.js 生态的 Markdown/HTML 统一渲染器 */
export function HtmlRenderer({ content }: HtmlRendererProps) {
  const html = useMemo(() => {
    if (!content) return '';

    try {
      const result = renderer.markdownSync(content);
      return result.html;
    } catch {
      // 渲染失败时回退为纯文本
      return `<p>${escapeHtml(content.slice(0, 500))}</p>`;
    }
  }, [content]);

  return (
    <div
      className="html-renderer"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
