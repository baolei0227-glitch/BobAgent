/**
 * 微信公众号文章 target —— DocIR → 公众号安全 HTML + 纯文本。
 *
 * 硬约束（方案 §5.2）：公众号编辑器会剥离 `<style>` 与 class，只认 **inline style**，
 * 且不支持 `flex` / `grid` / `position`。因此这里只输出白名单标签 + 全内联样式，
 * 不写任何 `<style>` 块、class 或布局属性，产物交给剪贴板双格式写入（text/html + text/plain）。
 *
 * 惯例参数固化：正文 15px / 行高 1.75 / 字色 #3f3f3f / 段间距 1.5em / 不首行缩进。
 */

import type { DocBlock, DocIR, DocInline } from '../ir';
import type { ExportArtifact, PlatformSpec } from '../types';

/** 正文惯例参数（方案 §5.2 固化值） */
export const WECHAT_STYLE = {
  fontSize: 15,
  lineHeight: 1.75,
  color: '#3f3f3f',
  paragraphMargin: '0 0 1.5em',
} as const;

/** 公众号平台约束：标题上限 64 字、正文上限 20000 字；封面 2.35:1 头图 + 1:1 小图；不支持代码高亮 */
export const WECHAT_SPEC: PlatformSpec = {
  id: 'wechat',
  label: 'WeChat article',
  limits: {
    titleMax: 64,
    bodyMax: 20000,
    imageMax: 100,
    ratios: ['2.35:1', '1:1'],
    unsupported: ['code'],
  },
  formats: ['clipboard-html', 'text'],
};

/** 正文基础样式片段 */
const BODY = `font-size:${WECHAT_STYLE.fontSize}px;line-height:${WECHAT_STYLE.lineHeight};color:${WECHAT_STYLE.color};`;
const P_STYLE = `${BODY}margin:${WECHAT_STYLE.paragraphMargin};`;

/** HTML 转义（所有文本 / 属性值都必须过这里，产物会被原样插入编辑器） */
function esc(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 正文内的换行 → `<br>`（公众号不认 white-space: pre-wrap 之外的换行语义） */
function escMultiline(s: string): string {
  return esc(s).replace(/\n/g, '<br>');
}

/** 微信自有域名：只有这类链接能保留 `<a>`，其余外链会被编辑器清掉 */
function isWechatHost(href: string): boolean {
  return /^https?:\/\/mp\.weixin\.qq\.com\//i.test(href) || /^https?:\/\/mp\.weixin\.qq\.com$/i.test(href);
}

// ---------------------------------------------------------------------------
// 内联
// ---------------------------------------------------------------------------

function inlineHtml(items: DocInline[]): string {
  return items
    .map((i) => {
      switch (i.t) {
        case 'text':
          return escMultiline(i.value);
        case 'strong':
          return `<strong>${escMultiline(i.value)}</strong>`;
        case 'em':
          return `<em>${escMultiline(i.value)}</em>`;
        case 'del':
          return `<span style="text-decoration:line-through">${escMultiline(i.value)}</span>`;
        case 'code':
          return `<span style="background:#f2f2f2;border-radius:3px;padding:1px 5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#c7254e">${esc(i.value)}</span>`;
        case 'link':
          return isWechatHost(i.href)
            ? `<a href="${esc(i.href)}" style="color:#576b95;text-decoration:none">${esc(i.value)}</a>`
            // 外链在公众号正文不可点：保留样式化文本，并把 URL 附在括号里供读者手动复制
            : `<span style="color:#576b95">${esc(i.value)}</span><span style="color:#a0a0a0;font-size:13px">（${esc(i.href)}）</span>`;
      }
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 块
// ---------------------------------------------------------------------------

/** 标题级别 → 字号（公众号正文里 h3 以下不再分级，统一 15px 加粗） */
const HEADING_SIZE: Record<number, number> = { 1: 20, 2: 18, 3: 16, 4: 15, 5: 15, 6: 15 };

/** 列表项过长或过多时退化为 `<p>· xxx</p>`（公众号对复杂列表支持有限） */
const LIST_ITEM_MAX = 100;
const LIST_COUNT_MAX = 10;

function listHtml(b: Extract<DocBlock, { t: 'list' }>, quote: boolean): string {
  const texts = b.items.map((it) => inlineHtml(it));
  const plain = b.items.map((it) => it.map((i) => i.value).join(''));
  const complex = b.items.length > LIST_COUNT_MAX || plain.some((t) => t.length > LIST_ITEM_MAX);
  const margin = quote ? '0 0 0.6em' : `margin:${WECHAT_STYLE.paragraphMargin}`;

  if (complex) {
    return texts
      .map((t, i) => `<p style="${BODY}${margin}">${b.ordered ? `${i + 1}. ` : '· '}${t}</p>`)
      .join('');
  }
  const tag = b.ordered ? 'ol' : 'ul';
  const items = texts.map((t) => `<li style="margin:0 0 0.5em">${t}</li>`).join('');
  return `<${tag} style="${BODY}${margin};padding-left:1.4em;list-style-type:${b.ordered ? 'decimal' : 'disc'}">${items}</${tag}>`;
}

function tableHtml(b: Extract<DocBlock, { t: 'table' }>): string {
  const cell = 'border:1px solid #e0e0e0;padding:6px 8px;text-align:left;vertical-align:top';
  const head = b.header.map((c) => `<th style="${cell};background:#f7f7f7;font-weight:bold">${esc(c)}</th>`).join('');
  const body = b.rows
    .map((r) => `<tr>${r.map((c) => `<td style="${cell}">${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table style="border-collapse:collapse;width:100%;margin:${WECHAT_STYLE.paragraphMargin};font-size:14px;line-height:1.6;color:${WECHAT_STYLE.color}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** 代码块：无语法高亮支持 → 灰底 section + 逐行 `<p>` */
function codeHtml(b: Extract<DocBlock, { t: 'code' }>): string {
  const lines = b.lines
    .map((l) => `<p style="margin:0;white-space:pre-wrap;word-break:break-word">${l ? esc(l) : '<br>'}</p>`)
    .join('');
  return `<section style="background:#f7f7f7;border-radius:4px;padding:12px;margin:${WECHAT_STYLE.paragraphMargin};font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.7;color:${WECHAT_STYLE.color}">${lines}</section>`;
}

/** 外链图在公众号不显示，仅做提示（首版由用户手动上传替换，方案 §9） */
function imageHtml(b: Extract<DocBlock, { t: 'image' }>): string {
  if (!b.src) {
    return `<p style="${BODY}margin:${WECHAT_STYLE.paragraphMargin};color:#a0a0a0">〔图片${b.alt ? `：${esc(b.alt)}` : ''}〕</p>`;
  }
  return `<p style="text-align:center;margin:${WECHAT_STYLE.paragraphMargin}"><img src="${esc(b.src)}" alt="${esc(b.alt)}" style="max-width:100%;height:auto;display:block;margin:0 auto" /></p>`;
}

function blockHtml(b: DocBlock, quote = false): string {
  switch (b.t) {
    case 'heading': {
      const size = HEADING_SIZE[b.level] ?? WECHAT_STYLE.fontSize;
      return `<p style="font-size:${size}px;line-height:1.5;font-weight:bold;color:#2b2b2b;margin:1.6em 0 0.8em">${esc(b.text)}</p>`;
    }
    case 'paragraph':
      return `<p style="${BODY}margin:${quote ? '0 0 0.6em' : WECHAT_STYLE.paragraphMargin}${quote ? ';color:#666' : ''}">${inlineHtml(b.inline)}</p>`;
    case 'list':
      return listHtml(b, quote);
    case 'quote': {
      const inner = b.blocks.map((x) => blockHtml(x, true)).join('');
      return `<section style="border-left:3px solid #ddd;padding-left:12px;margin:${WECHAT_STYLE.paragraphMargin}">${inner}</section>`;
    }
    case 'table':
      return tableHtml(b);
    case 'code':
      return codeHtml(b);
    case 'image':
      return imageHtml(b);
    case 'hr':
      return `<section style="border-top:1px solid #eaeaea;margin:1.8em 0;height:0;overflow:hidden"></section>`;
  }
}

// ---------------------------------------------------------------------------
// 纯文本（text/plain 兜底格式，粘到不支持 HTML 的地方仍可读）
// ---------------------------------------------------------------------------

function inlinePlain(items: DocInline[]): string {
  return items.map((i) => i.value).join('');
}

function blockPlain(b: DocBlock): string {
  switch (b.t) {
    case 'heading':
      return b.text;
    case 'paragraph':
      return inlinePlain(b.inline);
    case 'list':
      return b.items.map((it, i) => (b.ordered ? `${i + 1}. ` : '· ') + inlinePlain(it)).join('\n');
    case 'quote':
      return b.blocks.map(blockPlain).join('\n');
    case 'table':
      return [b.header.join(' | '), ...b.rows.map((r) => r.join(' | '))].join('\n');
    case 'code':
      return b.lines.join('\n');
    case 'image':
      return `〔图片${b.alt ? `：${b.alt}` : ''}〕`;
    case 'hr':
      return '---';
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * DocIR → 公众号安全产物：`html` 用于 `ClipboardItem['text/html']`，
 * `text` 用于 `text/plain` 兜底（含标题，正文块间空行分隔）。
 */
export function renderWechatArticle(ir: DocIR): Extract<ExportArtifact, { kind: 'clipboard-html' }> {
  const blocks = ir.blocks ?? [];
  const head = ir.title
    ? `<p style="font-size:20px;line-height:1.5;font-weight:bold;color:#2b2b2b;margin:0 0 1em">${esc(ir.title)}</p>`
    : '';
  const body = blocks.map((b) => blockHtml(b)).join('');
  const html = `<section style="${BODY}word-break:break-word">${head}${body}</section>`;

  const text = [ir.title, ...blocks.map(blockPlain)].filter((s) => s && s.trim()).join('\n\n');
  return { kind: 'clipboard-html', html, text };
}
