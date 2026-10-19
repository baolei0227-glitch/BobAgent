/**
 * unified-renderer — 统一渲染 HTML 和 Markdown 的本地包（基于 Unified.js 生态）
 *
 * 供项目内部 HtmlRenderer 使用。提供 createRenderer({...}) 工厂：
 *   const renderer = createRenderer({ format: 'markdown', gfm, sanitize, slug, highlight, allowDangerousHtml, sanitizeWhitelist });
 *   const { html } = renderer.markdownSync(content);
 *
 * 管线（markdown）：remark-parse → remark-gfm → remark-rehype → rehype-raw → rehype-sanitize → rehype-slug → rehype-highlight → rehype-autolink-headings → rehype-stringify
 * 管线（html）：   rehype-parse → rehype-raw → rehype-sanitize → rehype-slug → rehype-highlight → rehype-autolink-headings → rehype-stringify
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeParse from 'rehype-parse';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeStringify from 'rehype-stringify';

/** sanitize 白名单结构（允许额外放行的标签 / 属性 / 协议） */
export interface SanitizeWhitelist {
  tags?: string[];
  attributes?: Record<string, string[]>;
  /** 放行的 URL 协议（按属性名分组），例如 `{ src: ['data'] }` 允许 img src 用 data: URL */
  protocols?: Record<string, string[]>;
}

/** createRenderer 配置项 */
export interface RendererOptions {
  /** 输入格式：'markdown'（默认）| 'html' */
  format?: 'markdown' | 'html';
  /** 启用 GFM 支持（表格、删除线、任务列表等） */
  gfm?: boolean;
  /** 启用 XSS 安全过滤（默认 true） */
  sanitize?: boolean;
  /** 为标题自动生成 slug 锚点（默认 false） */
  slug?: boolean;
  /** 代码块语法高亮（默认 false） */
  highlight?: boolean;
  /** 允许原始 HTML 透传（配合 sanitize 过滤危险标签） */
  allowDangerousHtml?: boolean;
  /** sanitize 额外放行的标签 / 属性 */
  sanitizeWhitelist?: SanitizeWhitelist;
}

export interface RenderResult {
  html: string;
}

export interface Renderer {
  markdownSync: (content: string) => RenderResult;
}

/**
 * 合并 sanitize schema：defaultSchema 基础上合并自定义白名单（保留默认安全配置）。
 * 手动实现（hast-util-sanitize v5 已移除 extendSchema）：
 *   - tagNames：并集
 *   - attributes：同标签属性名数组取并集，新标签直接并入
 */
function mergeSchema(
  base: Record<string, unknown>,
  custom: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  if (Array.isArray(custom.tagNames)) {
    const merged = new Set<string>((base.tagNames as string[] | undefined) ?? []);
    for (const t of custom.tagNames as string[]) merged.add(t);
    out.tagNames = [...merged];
  }
  if (custom.attributes && typeof custom.attributes === 'object') {
    const baseAttrs = (base.attributes ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...baseAttrs };
    for (const [tag, attrs] of Object.entries(custom.attributes as Record<string, unknown>)) {
      const existing = merged[tag];
      if (Array.isArray(existing) && Array.isArray(attrs)) {
        merged[tag] = [...new Set([...existing, ...(attrs as string[])])];
      } else {
        merged[tag] = attrs;
      }
    }
    out.attributes = merged;
  }
  if (custom.protocols && typeof custom.protocols === 'object') {
    const baseProto = (base.protocols ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...baseProto };
    for (const [attr, protos] of Object.entries(custom.protocols as Record<string, unknown>)) {
      const existing = merged[attr];
      if (Array.isArray(existing) && Array.isArray(protos)) {
        merged[attr] = [...new Set([...existing, ...(protos as string[])])];
      } else {
        merged[attr] = protos;
      }
    }
    out.protocols = merged;
  }
  return out;
}

/** 构建 sanitize schema：默认 schema 基础上合并自定义白名单（保留默认安全配置） */
function buildSchema(whitelist?: SanitizeWhitelist): unknown {
  if (!whitelist) return undefined;
  const custom: Record<string, unknown> = {};
  if (whitelist.tags && whitelist.tags.length) {
    custom.tagNames = whitelist.tags;
  }
  if (whitelist.attributes && Object.keys(whitelist.attributes).length) {
    custom.attributes = whitelist.attributes;
  }
  if (whitelist.protocols && Object.keys(whitelist.protocols).length) {
    custom.protocols = whitelist.protocols;
  }
  if (Object.keys(custom).length === 0) return undefined;
  return mergeSchema(defaultSchema as unknown as Record<string, unknown>, custom);
}

/**
 * 创建渲染器。markdownSync 同步返回 { html }。
 */
export function createRenderer(options: RendererOptions = {}): Renderer {
  const {
    gfm = false,
    sanitize = true,
    slug = false,
    highlight = false,
    allowDangerousHtml = false,
    sanitizeWhitelist,
  } = options;

  const markdownSync = (content: string): RenderResult => {
    const processor = unified().use(remarkParse);

    if (gfm) processor.use(remarkGfm);

    processor.use(remarkRehype, {
      allowDangerousHtml: allowDangerousHtml && sanitize,
    });

    // 原始 HTML 透传：仅当允许且会做 sanitize 时启用 rehype-raw
    if (allowDangerousHtml) processor.use(rehypeRaw);

    if (sanitize) {
      const schema = buildSchema(sanitizeWhitelist);
      processor.use(rehypeSanitize, schema || undefined);
    }

    if (slug) processor.use(rehypeSlug);
    if (highlight) processor.use(rehypeHighlight);
    if (slug) processor.use(rehypeAutolinkHeadings);

    processor.use(rehypeStringify);

    const file = processor.processSync(content);
    return { html: String(file) };
  };

  return { markdownSync };
}

// 兼容未导出的 html 渲染入口（保留，供未来使用）
export function renderHtmlSync(content: string, options: RendererOptions = {}): RenderResult {
  const processor = unified().use(rehypeParse, { fragment: true });

  if (options.allowDangerousHtml) processor.use(rehypeRaw);

  if (options.sanitize !== false) {
    const schema = buildSchema(options.sanitizeWhitelist);
    processor.use(rehypeSanitize, schema || undefined);
  }

  if (options.slug) processor.use(rehypeSlug);
  if (options.highlight) processor.use(rehypeHighlight);
  if (options.slug) processor.use(rehypeAutolinkHeadings);

  processor.use(rehypeStringify);

  const file = processor.processSync(content);
  return { html: String(file) };
}

export default { createRenderer, renderHtmlSync };
