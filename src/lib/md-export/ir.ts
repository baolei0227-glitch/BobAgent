/**
 * DocIR —— md 文档归一化中间层（多端分发管线的唯一解析点）
 *
 * 设计要点（见《md阅读器多端分发方案》）：
 * - 一条解析、多端模板：各平台只消费 DocIR，不再各自写正则剥 markdown；
 * - 基于已依赖的 unified + remark-parse + remark-gfm，不引新依赖；
 * - 与 lib/md-to-docx 各自独立（P0 不动 md-to-docx，避免回归）。
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export type DocInline =
  | { t: 'text'; value: string }
  | { t: 'strong' | 'em' | 'code' | 'del'; value: string }
  | { t: 'link'; value: string; href: string };

export type DocBlock =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { t: 'paragraph'; inline: DocInline[] }
  | { t: 'list'; ordered: boolean; items: DocInline[][] }
  | { t: 'quote'; blocks: DocBlock[] }
  | { t: 'code'; lang: string; lines: string[] }
  | { t: 'table'; header: string[]; rows: string[][] }
  | { t: 'image'; src: string; alt: string }
  | { t: 'hr' };

export type DocSource = 'md-file' | 'node' | 'chat' | 'local' | 'project';

export interface DocIR {
  /** 首个 h1；无则取文件名（去扩展名） */
  title: string;
  /** 封面钩子：首个非空段落截到首个句末标点，≤40 字 */
  hook: string;
  /** 抽取到的关键数字（含单位），用于封面/微博摘要 */
  stats: string[];
  blocks: DocBlock[];
  meta: { source: DocSource; path?: string };
}

// ---------------------------------------------------------------------------
// mdast（宽松表示，够用即可）
// ---------------------------------------------------------------------------

interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
  depth?: number;
  ordered?: boolean;
  lang?: string;
  url?: string;
  alt?: string;
}

const EMPTY_IR: DocIR = {
  title: '',
  hook: '',
  stats: [],
  blocks: [],
  meta: { source: 'md-file' },
};

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** 剥离 YAML frontmatter（与 MdViewer 同规则） */
export function stripFrontmatter(raw: string): string {
  const text = (raw ?? '').replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\s*\n/, '');
}

/** 去掉 HTML 标签，保留文本（raw html 块的兜底） */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * 短哈希（31 进制），用于草稿存储键。
 * 与 XhsCard 既有 `draftKey` 同算法，便于旧草稿继续命中。
 */
export function hashText(text: string): string {
  let h = 0;
  const s = text ?? '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** 取路径中的文件名（去扩展名） */
function baseNameNoExt(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------------------
// 内联转换
// ---------------------------------------------------------------------------

/** 递归收集节点纯文本（含图片 alt） */
function plainText(nodes: MdastNode[]): string {
  let s = '';
  for (const n of nodes) {
    if (n.type === 'text' || n.type === 'inlineCode') s += n.value ?? '';
    else if (n.type === 'image') s += n.alt ?? '';
    else if (n.type === 'break') s += ' ';
    else if (n.type === 'html') s += stripTags(n.value ?? '');
    else if (n.children?.length) s += plainText(n.children);
    else if (n.value) s += n.value;
  }
  return s;
}

/** 合并相邻的纯文本节点，避免碎片化 */
function mergeAdjacentText(items: DocInline[]): DocInline[] {
  const out: DocInline[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (item.t === 'text' && prev?.t === 'text') prev.value += item.value;
    else out.push(item);
  }
  return out;
}

/** mdast phrasing → DocInline[]（嵌套标记按契约压平为单层） */
function inlineOf(nodes: MdastNode[]): DocInline[] {
  const out: DocInline[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        if (n.value) out.push({ t: 'text', value: n.value });
        break;
      case 'strong':
      case 'emphasis':
      case 'delete': {
        const value = plainText(n.children ?? []);
        if (value) {
          out.push({ t: n.type === 'emphasis' ? 'em' : n.type === 'delete' ? 'del' : 'strong', value });
        }
        break;
      }
      case 'inlineCode':
        if (n.value) out.push({ t: 'code', value: n.value });
        break;
      case 'link':
        out.push({ t: 'link', value: plainText(n.children ?? []) || n.url || '', href: n.url ?? '' });
        break;
      case 'break':
        out.push({ t: 'text', value: '\n' });
        break;
      case 'html': {
        const value = stripTags(n.value ?? '');
        if (value) out.push({ t: 'text', value });
        break;
      }
      default:
        // 未知内联节点：递归取子节点，避免内容丢失
        if (n.children?.length) out.push(...inlineOf(n.children));
        else if (n.value) out.push({ t: 'text', value: n.value });
    }
  }
  return mergeAdjacentText(out);
}

/** DocInline[] → 纯文本 */
export function inlineText(inline: DocInline[]): string {
  return inline.map((i) => i.value).join('');
}

// ---------------------------------------------------------------------------
// 纯文本序列化（各端 text/plain 产物共用，避免每个 target 各写一份遍历）
// ---------------------------------------------------------------------------

function blockPlainText(b: DocBlock): string {
  switch (b.t) {
    case 'heading':
      return b.text;
    case 'paragraph':
      return inlineText(b.inline);
    case 'list':
      return b.items.map((it, i) => (b.ordered ? `${i + 1}. ` : '· ') + inlineText(it)).join('\n');
    case 'quote':
      return b.blocks.map(blockPlainText).join('\n');
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

/** DocIR → 纯文本（标题 + 各块，块间空行分隔） */
export function docPlainText(ir: DocIR): string {
  return [(ir.title ?? '').trim(), ...(ir.blocks ?? []).map(blockPlainText)]
    .filter((s) => s && s.trim())
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// 块转换
// ---------------------------------------------------------------------------

function cellsOf(row: MdastNode): string[] {
  return (row.children ?? [])
    .filter((c) => c.type === 'tableCell')
    .map((c) => plainText(c.children ?? []).trim());
}

/** gfm 表格：首行视为表头，数据行补齐到表头列数 */
function tableOf(node: MdastNode): Extract<DocBlock, { t: 'table' }> | null {
  const rows = (node.children ?? []).filter((c) => c.type === 'tableRow');
  if (!rows.length) return null;
  const header = cellsOf(rows[0]);
  if (!header.length) return null;
  const body: string[][] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = cellsOf(rows[i]);
    while (cells.length < header.length) cells.push('');
    cells.length = header.length;
    body.push(cells);
  }
  return { t: 'table', header, rows: body };
}

/**
 * 从 HTML 片段里解析 <img src alt>。
 * 分享卡 / 文档编辑器里被拖拽调整过尺寸的图片，在 Markdown 中是 HTML 形式
 * （`<img src alt width>`，见 components/canvas/extensions/ResizableImage.ts）——
 * 不单独识别就会被 stripTags 当空标签丢掉，导出到公众号/微博/HTML 时整张图消失。
 * 尺寸（width）不进入 IR：多端模板按容器宽度自适应，保持既有版式。
 */
function imgFromHtml(html: string): Extract<DocBlock, { t: 'image' }> | null {
  const tag = /<img\b[^>]*>/i.exec(html)?.[0];
  if (!tag) return null;
  const attr = (name: string) =>
    new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1]
    ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.[1]
    ?? '';
  const src = attr('src');
  return src ? { t: 'image', src, alt: attr('alt') } : null;
}

/** 段落：内嵌图片按契约提升为独立 image 块（DocInline 无图片变体） */
function paragraphBlocks(children: MdastNode[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (const c of children) {
    if (c.type === 'image' && c.url) out.push({ t: 'image', src: c.url, alt: c.alt ?? '' });
    else if (c.type === 'html') {
      const img = imgFromHtml(c.value ?? '');
      if (img) out.push(img);
    }
  }
  const inline = inlineOf(children);
  if (inline.length) out.push({ t: 'paragraph', inline });
  return out;
}

function blocksOf(nodes: MdastNode[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'heading': {
        const text = plainText(n.children ?? []).trim();
        if (text) {
          const level = Math.min(6, Math.max(1, n.depth ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6;
          out.push({ t: 'heading', level, text });
        }
        break;
      }
      case 'paragraph':
        out.push(...paragraphBlocks(n.children ?? []));
        break;
      case 'list': {
        const items = (n.children ?? [])
          .filter((c) => c.type === 'listItem')
          .map((c) => inlineOf(c.children ?? []))
          .filter((arr) => arr.length > 0);
        if (items.length) out.push({ t: 'list', ordered: !!n.ordered, items });
        break;
      }
      case 'blockquote': {
        const inner = blocksOf(n.children ?? []);
        if (inner.length) out.push({ t: 'quote', blocks: inner });
        break;
      }
      case 'code':
        out.push({ t: 'code', lang: n.lang ?? '', lines: (n.value ?? '').split('\n') });
        break;
      case 'table': {
        const table = tableOf(n);
        if (table) out.push(table);
        break;
      }
      case 'image':
        if (n.url) out.push({ t: 'image', src: n.url, alt: n.alt ?? '' });
        break;
      case 'thematicBreak':
        out.push({ t: 'hr' });
        break;
      case 'html': {
        const img = imgFromHtml(n.value ?? '');
        if (img) {
          out.push(img);
          break;
        }
        const text = stripTags(n.value ?? '').trim();
        if (text) out.push({ t: 'paragraph', inline: [{ t: 'text', value: text }] });
        break;
      }
      case 'listItem':
      case 'footnoteDefinition':
      case 'definition':
      case 'footnoteReference':
        break;
      default:
        if (n.children?.length) out.push(...blocksOf(n.children));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// title / hook / stats 抽取
// ---------------------------------------------------------------------------

type HeadingBlock = Extract<DocBlock, { t: 'heading' }>;

function pickTitle(blocks: DocBlock[], path?: string): string {
  const h1 = blocks.find((b): b is HeadingBlock => b.t === 'heading' && b.level === 1);
  if (h1) return h1.text;
  if (path) return baseNameNoExt(path);
  const anyHeading = blocks.find((b): b is HeadingBlock => b.t === 'heading');
  return anyHeading ? anyHeading.text : '';
}

const HOOK_MAX = 40;
const SENTENCE_END = /[。！？!?；;]/;

/** 封面钩子：首个非空段落截到首个句末标点，≤40 字 */
function pickHook(blocks: DocBlock[]): string {
  for (const b of blocks) {
    if (b.t !== 'paragraph') continue;
    const text = inlineText(b.inline).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const m = SENTENCE_END.exec(text);
    const cut = m ? text.slice(0, m.index + 1) : text;
    return cut.length > HOOK_MAX ? cut.slice(0, HOOK_MAX) : cut;
  }
  return '';
}

/** 关键数字：必须带单位，避免把普通序号当成 stats */
const STAT_RE = new RegExp(
  String.raw`(\d[\d,]*(?:\.\d+)?)\s*(%|％|万元|亿元|万美元|美元|元|亿|万|千|天|小时|分钟|秒|年|个月|月|周|日|人|次|个|条|项|篇|页|倍|GB|MB|KB|TB|kg|km|cm|mm|mg|ml|g|m)`,
  'g',
);
const STAT_MAX = 6;

/** 块 → 纯文本片段（用于 stats 扫描，跳过代码块避免噪音） */
function blockTexts(b: DocBlock): string[] {
  switch (b.t) {
    case 'heading':
      return [b.text];
    case 'paragraph':
      return [inlineText(b.inline)];
    case 'list':
      return b.items.map(inlineText);
    case 'quote':
      return b.blocks.flatMap(blockTexts);
    case 'table':
      return [b.header.join(' '), ...b.rows.map((r) => r.join(' '))];
    case 'image':
      return [b.alt];
    case 'code':
    case 'hr':
      return [];
  }
}

function pickStats(blocks: DocBlock[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of blocks.flatMap(blockTexts)) {
    STAT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STAT_RE.exec(text))) {
      const hit = `${m[1]}${m[2]}`;
      if (seen.has(hit)) continue;
      seen.add(hit);
      out.push(hit);
      if (out.length >= STAT_MAX) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

export interface ParseDocOptions {
  source?: DocSource;
  /** 文件绝对/相对路径，用于 title 兜底与来源追溯 */
  path?: string;
}

/**
 * md 字符串 → DocIR。所有分发端（海报/微信/小红书/微博）共用此解析。
 * 解析失败（空内容/异常）时返回空 IR，不抛错。
 */
export function parseDoc(markdown: string, options: ParseDocOptions = {}): DocIR {
  const source: DocSource = options.source ?? 'md-file';
  const body = stripFrontmatter(markdown ?? '').trim();
  if (!body) return { ...EMPTY_IR, meta: { source, path: options.path } };

  let blocks: DocBlock[] = [];
  try {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as unknown as MdastNode;
    blocks = blocksOf(tree.children ?? []);
  } catch {
    blocks = [];
  }

  return {
    title: pickTitle(blocks, options.path),
    hook: pickHook(blocks),
    stats: pickStats(blocks),
    blocks,
    meta: { source, path: options.path },
  };
}

/**
 * 聊天 Q+A → md 字符串适配器。
 * 让聊天路径复用同一条解析管线，避免为卡片另写一套解析。
 */
export function chatToMarkdown(question: string, answer: string): string {
  const q = (question ?? '').trim();
  const a = (answer ?? '').trim();
  if (!q) return a;
  const nl = q.indexOf('\n');
  if (nl < 0) return `# ${q}\n\n${a}`;
  const head = q.slice(0, nl).trim();
  const rest = q.slice(nl + 1).trim();
  return rest ? `# ${head}\n\n${rest}\n\n${a}` : `# ${head}\n\n${a}`;
}
