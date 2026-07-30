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
    mark: ['data-note', 'class'],
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

/** 为表格包裹横向滚动容器，避免宽表格溢出气泡 */
function wrapTables(html: string): string {
  return html.replace(/<table([\s\S]*?)<\/table>/g, (match) => {
    return `<div class="table-wrapper">${match}</div>`;
  });
}

/** 为 pre 代码块包裹容器 + 复制按钮 */
function wrapCodeBlocks(html: string): string {
  return html.replace(
    /<pre(\s[^>]*)?>([\s\S]*?)<\/pre>/g,
    (_, attrs, inner) =>
      `<div class="code-block-wrapper"><button class="code-copy-btn">复制</button><pre${attrs || ''}>${inner}</pre></div>`,
  );
}

/** 基于 unified.js 生态的 Markdown/HTML 统一渲染器 */
export function HtmlRenderer({ content }: HtmlRendererProps) {
  const html = useMemo(() => {
    if (!content) return '';

    try {
      const result = renderer.markdownSync(content);
      return wrapCodeBlocks(wrapTables(result.html));
    } catch {
      // 渲染失败时回退为纯文本
      return `<p>${escapeHtml(content.slice(0, 500))}</p>`;
    }
  }, [content]);

  const handleClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.code-copy-btn');
    if (!btn) return;
    const code = btn.parentElement?.querySelector('code');
    if (code) {
      navigator.clipboard.writeText(code.textContent || '');
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 2000);
    }
  };

  return (
    <div
      className="html-renderer"
      onClick={handleClick}
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
