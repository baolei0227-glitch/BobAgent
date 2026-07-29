'use client';

import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';

interface HtmlRendererProps {
  content: string;
}

/** 将 AI 输出的 markdown 文本转为 HTML 后安全渲染 */
export function HtmlRenderer({ content }: HtmlRendererProps) {
  const html = useMemo(() => {
    if (!content) return '';

    let text = content;

    // 1. 保护 HTML 代码块（完整 HTML 片段，不做任何处理直接保留）
    const htmlBlocks: string[] = [];
    text = text.replace(/```html\n([\s\S]*?)```/g, (_, code) => {
      const idx = htmlBlocks.length;
      htmlBlocks.push(`<pre class="code-block" data-lang="html"><code>${escapeHtml(code.trim())}</code></pre>`);
      return `__HTML_BLOCK_${idx}__`;
    });

    // 2. 保护其他代码块
    const codeBlocks: string[] = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      const langAttr = lang ? ` data-lang="${lang}"` : '';
      codeBlocks.push(`<pre class="code-block"${langAttr}><code>${escapeHtml(code.trim())}</code></pre>`);
      return `__CODE_BLOCK_${idx}__`;
    });

    // 3. 保护行内代码
    const inlineCodes: string[] = [];
    text = text.replace(/`([^`]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
      return `__INLINE_CODE_${idx}__`;
    });

    // 5. 恢复代码块和行内代码
    text = text.replace(/__HTML_BLOCK_(\d+)__/g, (_, idx) => htmlBlocks[+idx]);
    text = text.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => codeBlocks[+idx]);
    text = text.replace(/__INLINE_CODE_(\d+)__/g, (_, idx) => inlineCodes[+idx]);

    // 6. Markdown → HTML 转换（对非 HTML 内容进行转换，已有的 HTML 标签直接保留）
    // 标题
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // 粗体 / 斜体
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 链接
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // 图片
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');

    // 分割线
    text = text.replace(/^---$/gm, '<hr>');

    // 无序列表（连续行）
    text = text.replace(/((?:^- .+\n?)+)/gm, (match) => {
      const items = match.trim().split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    });

    // 有序列表
    text = text.replace(/((?:^\d+\. .+\n?)+)/gm, (match) => {
      const items = match.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
      return `<ol>${items}</ol>`;
    });

    // 引用
    text = text.replace(/((?:^&gt; .+\n?)+)/gm, (match) => {
      const content = match.trim().split('\n').map(l => l.replace(/^&gt; /, '')).join('<br>');
      return `<blockquote>${content}</blockquote>`;
    });

    // 表格（简单支持）
    text = text.replace(/((?:^\|.+\|\n?)+)/gm, (match) => {
      const lines = match.trim().split('\n').filter(l => l.includes('|'));
      if (lines.length < 2) return match;
      const rows = lines.filter(l => !l.match(/^\|[\s\-:]+\|$/));
      const cells = rows.map(row =>
        `<tr>${row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('')}</tr>`
      ).join('');
      return `<table class="md-table">${cells}</table>`;
    });

    // 段落（连续非空行）
    text = text.replace(/\n\n+/g, '</p><p>');
    text = `<p>${text}</p>`;
    text = text.replace(/<p>\s*<\/p>/g, '');

    // 7. DOMPurify 安全过滤（去除危险标签/属性，保留安全 HTML）
    return DOMPurify.sanitize(text, {
      ADD_ATTR: ['target', 'data-lang'],
      ADD_TAGS: ['details', 'summary'],
    });
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
