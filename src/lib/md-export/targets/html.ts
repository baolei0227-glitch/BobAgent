/**
 * 自包含 HTML 文档 target —— DocIR → 单文件 `.html`（P2-3）。
 *
 * 与公众号 target 的定位差异（方案 §4.2 / §5.2）：
 * - 公众号产物是**内联样式片段**（贴进编辑器，不许有 `<style>` / class）；
 * - 这里是**完整独立文档**（`<!DOCTYPE html>` + `<head><style>`），
 *   用于归档、发邮件、丢进任意浏览器/阅读器打开，不必依赖任何外部资源。
 *
 * 内容不做降噪：HTML 是"无损"载体，所有 block 原样还原（代码块保留全文，
 * 宽表保留完整表格），与小红的切图化、海报的降噪规则相反。
 *
 * 不引新依赖：只做字符串序列化。
 */

import type { DocBlock, DocIR, DocInline } from '../ir';
import type { ExportArtifact, PlatformSpec } from '../types';

/** HTML 文档无平台硬约束（自包含、无损），体检恒过 */
export const HTML_SPEC: PlatformSpec = {
  id: 'html',
  label: 'HTML document',
  limits: {},
  formats: ['html'],
};

/** 正文排版惯例：与库里正文一致（15px / 行高 1.75 / #3f3f3f / 段间距 1.5em / 不首行缩进） */
const DOC_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 40px 20px 64px;
    background: #f6f6f7;
    color: #3f3f3f;
    font-family: 'PingFang SC', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }
  .doc {
    max-width: 720px;
    margin: 0 auto;
    padding: 48px 52px;
    background: #ffffff;
    border: 1px solid #e8e8ea;
    border-radius: 10px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    word-break: break-word;
  }
  .doc-title {
    margin: 0 0 1.4em;
    font-size: 28px;
    line-height: 1.35;
    font-weight: 700;
    color: #111111;
  }
  h2, h3, h4, h5, h6 { color: #1f1f1f; line-height: 1.4; margin: 1.6em 0 0.7em; }
  h2 { font-size: 21px; }
  h3 { font-size: 18px; }
  h4 { font-size: 16px; }
  h5, h6 { font-size: 15px; }
  p { margin: 0 0 1.5em; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { font-weight: 700; color: #111111; }
  del { color: #9a9a9a; }
  code {
    padding: 1px 5px;
    border-radius: 4px;
    background: #f4f4f5;
    color: #b3261e;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.92em;
  }
  pre {
    margin: 0 0 1.5em;
    padding: 14px 16px;
    border-radius: 8px;
    background: #f7f7f8;
    border: 1px solid #ececee;
    overflow-x: auto;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.7;
  }
  pre code { padding: 0; background: none; color: #3f3f3f; font-size: inherit; }
  ul, ol { margin: 0 0 1.5em; padding-left: 1.5em; }
  li { margin: 0 0 0.4em; }
  blockquote {
    margin: 0 0 1.5em;
    padding: 2px 0 2px 14px;
    border-left: 3px solid #dcdce0;
    color: #6b6b6b;
  }
  blockquote > :last-child { margin-bottom: 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1.5em; font-size: 14px; line-height: 1.6; }
  th, td { border: 1px solid #e4e4e7; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f7f7f8; font-weight: 600; }
  figure { margin: 0 0 1.5em; text-align: center; }
  figure img { max-width: 100%; height: auto; border-radius: 6px; }
  figcaption { margin-top: 8px; color: #8a8a8a; font-size: 13px; }
  hr { border: 0; border-top: 1px solid #eaeaea; margin: 2em 0; }
  @media print {
    body { padding: 0; background: #ffffff; }
    .doc { max-width: none; padding: 0; border: 0; border-radius: 0; box-shadow: none; }
    pre, blockquote, table, figure { break-inside: avoid; }
    h2, h3, h4 { break-after: avoid; }
  }
`.trim();

// ---------------------------------------------------------------------------
// 转义
// ---------------------------------------------------------------------------

/** 文本 / 属性值统一转义（产物是完整 HTML 文档，任何拼接都要过这里） */
function esc(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 代码块 / 段落内换行：完整文档可用 CSS 换行语义，这里仅需转义 */
function escBlock(s: string): string {
  return esc(s);
}

// ---------------------------------------------------------------------------
// 内联
// ---------------------------------------------------------------------------

/** 允许保留的链接协议（避免序列化出 `javascript:` 之类可执行地址） */
function safeHref(href: string): string {
  return /^(https?:|mailto:|tel:|#|\.{0,2}\/)/i.test(href ?? '') ? href : '';
}

function inlineHtml(items: DocInline[]): string {
  return (items ?? [])
    .map((i) => {
      switch (i.t) {
        case 'text':
          return escBlock(i.value);
        case 'strong':
          return `<strong>${escBlock(i.value)}</strong>`;
        case 'em':
          return `<em>${escBlock(i.value)}</em>`;
        case 'del':
          return `<del>${escBlock(i.value)}</del>`;
        case 'code':
          return `<code>${esc(i.value)}</code>`;
        case 'link': {
          const href = safeHref(i.href);
          return href
            ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${escBlock(i.value)}</a>`
            : escBlock(i.value);
        }
      }
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 块
// ---------------------------------------------------------------------------

/** 标题层级 → 标签（h1 已由文档标题占据，正文标题整体下沉一级） */
function headingTag(level: number): string {
  return `h${Math.min(6, Math.max(2, level + 1))}`;
}

function listHtml(b: Extract<DocBlock, { t: 'list' }>): string {
  const tag = b.ordered ? 'ol' : 'ul';
  const items = b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join('');
  return `<${tag}>${items}</${tag}>`;
}

function tableHtml(b: Extract<DocBlock, { t: 'table' }>): string {
  const head = b.header.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = b.rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function codeHtml(b: Extract<DocBlock, { t: 'code' }>): string {
  const lang = b.lang ? ` class="language-${esc(b.lang)}"` : '';
  const text = b.lines.join('\n');
  return `<pre><code${lang}>${esc(text)}</code></pre>`;
}

function imageHtml(b: Extract<DocBlock, { t: 'image' }>): string {
  if (!b.src) {
    return `<p><em>〔图片${b.alt ? `：${esc(b.alt)}` : ''}〕</em></p>`;
  }
  const caption = b.alt ? `<figcaption>${esc(b.alt)}</figcaption>` : '';
  return `<figure><img src="${esc(b.src)}" alt="${esc(b.alt)}" loading="lazy" />${caption}</figure>`;
}

function blockHtml(b: DocBlock): string {
  switch (b.t) {
    case 'heading':
      return `<${headingTag(b.level)}>${esc(b.text)}</${headingTag(b.level)}>`;
    case 'paragraph':
      return `<p>${inlineHtml(b.inline)}</p>`;
    case 'list':
      return listHtml(b);
    case 'quote':
      return `<blockquote>${b.blocks.map(blockHtml).join('')}</blockquote>`;
    case 'table':
      return tableHtml(b);
    case 'code':
      return codeHtml(b);
    case 'image':
      return imageHtml(b);
    case 'hr':
      return '<hr />';
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/** 文件名：标题（已含文件名兜底）→ 去掉非法字符 → 追加日期 */
export function htmlFileName(ir: DocIR, date: Date = new Date()): string {
  const raw = (ir.title ?? '').trim() || 'document';
  const safe = raw.replace(/[\\/:*?"<>|\n\r\t]/g, '-').replace(/\s+/g, ' ').slice(0, 60).trim() || 'document';
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `${safe}-${stamp}.html`;
}

/**
 * DocIR → 完整自包含 HTML 文档。
 * 首个 h1 与文档标题同源时跳过，避免标题重复一次。
 */
export function renderHtmlDocument(ir: DocIR): string {
  const title = (ir.title ?? '').trim();
  const blocks = ir.blocks ?? [];

  let titlePending = !!title;
  const body: string[] = [];
  for (const b of blocks) {
    if (titlePending && b.t === 'heading' && b.level === 1 && b.text.trim() === title) {
      titlePending = false;
      continue;
    }
    body.push(blockHtml(b));
  }

  const head = title ? `<h1 class="doc-title">${esc(title)}</h1>` : '';
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${esc(title || 'Document')}</title>`,
    '<style>',
    DOC_CSS,
    '</style>',
    '</head>',
    '<body>',
    `<article class="doc">${head}${body.join('')}</article>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** DocIR → 文件产物（Blob），文件名带日期；下载动作由调用方（ExportMenu）负责 */
export function renderHtmlArtifact(ir: DocIR): Extract<ExportArtifact, { kind: 'file' }> {
  const blob = new Blob([renderHtmlDocument(ir)], { type: 'text/html;charset=utf-8' });
  return { kind: 'file', name: htmlFileName(ir), blob };
}
