/**
 * HTML → 正文 / 标题 / 出处 —— materials 侧共用的纯函数（不含任何浏览器依赖）
 *
 * 链接导入与 Hippo 一键保存落盘的「原件」是渲染后的整页 HTML（见 link-import.ts），
 * 正文提取统一走本文件：正则预剥噪声 → 主内容容器选择 → turndown 转 Markdown；
 * 文件头的出处注释也一并读回来，索引正文里仍能看见原文链接。
 *
 * 单独成文件的原因：服务端索引（indexer.ts）也要用它，而 link-import 依赖 Hippo 驱动
 * （hippo-driver → app-root）；索引链路不应被拖进浏览器侧依赖。
 */

import TurndownService from 'turndown';

/** 出处注释写在落盘 HTML 的最前面，键名与旧 .md 材料的 `> Source:` / `> Retrieved:` 保持一致 */
const SOURCE_RE = /<!--\s*Source:\s*(\S+?)\s*-->/i;
const RETRIEVED_RE = /<!--\s*Retrieved:\s*(\d{4}-\d{2}-\d{2})\s*-->/i;

/** 只看文件头，避免把正文深处的注释误当出处 */
const HEAD_PROBE_CHARS = 2048;

export interface HtmlProvenance {
  sourceUrl?: string;
  /** YYYY-MM-DD */
  retrievedAt?: string;
}

export interface HtmlTextResult extends HtmlProvenance {
  title: string;
  markdown: string;
}

let turndown: TurndownService | null = null;

export function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    // 页面级噪声：脚本 / 样式 / 导航 / 页脚 / 侧栏 / 表单 一律不进正文
    turndown.remove(['script', 'style', 'noscript', 'iframe', 'template', 'form', 'nav', 'footer', 'aside']);
  }
  return turndown;
}

/** 正则预剥离：turndown 的 remove() 只接受 HTML 标签名，SVG / 注释在此先行去掉 */
export function stripNoise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/** 优先取 <article>/<main> 作为正文容器，内容太短则退回 <body> */
export function pickMainHtml(html: string): string {
  for (const tag of ['article', 'main']) {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
    if (m && m[1].trim().length > 800) return m[1];
  }
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return body ? body[1] : html;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 标题：og:title 优先，其次 <title> */
export function extractTitle(html: string): string {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og && og[1].trim()) return decodeEntities(og[1]).trim();
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t ? decodeEntities(t[1]).trim() : '';
}

/** 解析文件头的出处注释（落盘格式见 link-import.ts 的 writeHtmlMaterial） */
export function parseProvenance(html: string): HtmlProvenance {
  const head = html.slice(0, HEAD_PROBE_CHARS);
  const src = SOURCE_RE.exec(head);
  const ret = RETRIEVED_RE.exec(head);
  return {
    sourceUrl: src ? src[1] : undefined,
    retrievedAt: ret ? ret[1] : undefined,
  };
}

/** 出处注释文本：写在 HTML 最前，浏览器解析时直接跳过，人读时一眼可见 */
export function formatProvenance(sourceUrl: string, retrievedAt: string): string {
  const url = String(sourceUrl).replace(/[\r\n]+/g, '');
  return `<!-- Source: ${url} -->\n<!-- Retrieved: ${retrievedAt} -->`;
}

/** HTML → { 标题, Markdown, 出处 }：.html 原件与链接导入的静态兜底共用 */
export function extractHtmlText(html: string): HtmlTextResult {
  // 出处必须先去读：stripNoise 会把注释一并剥掉
  const prov = parseProvenance(html);
  return {
    title: extractTitle(html),
    markdown: getTurndown().turndown(pickMainHtml(stripNoise(html))).trim(),
    ...prov,
  };
}