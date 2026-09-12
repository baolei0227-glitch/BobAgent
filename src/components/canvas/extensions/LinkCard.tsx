'use client';

// 链接卡片扩展：独占一行的裸链接 → 卡片 NodeView
//
// 判定规则（markdown-it 解析期）：顶层段落内只有一个链接，且链接文字与 href 等价
// （即粘贴裸 URL 生成的 `[url](url)`）→ 渲染为 `div[data-link-card]`，由本扩展反解为卡片节点。
// 行内链接（段落里还夹着其他文字）与「有文字的链接」保持普通链接不变。
//
// - markdown 往返：卡片 ↔ `[url](url)`（标准 Markdown，不引入私有语法，纯文本可移植）；
// - 元数据（标题/描述/图标/缩略图）不写入文档，渲染时经 /api/link-preview 异步抓取并缓存；
// - 抓取失败自动降级为普通链接（与启用卡片前表现一致），不阻断阅读。

import { useEffect, useState } from 'react';
import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { ExternalLink, Globe, Loader2 } from 'lucide-react';

/** 链接预览元数据（由服务端 OG 抓取返回） */
interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
  icon?: string;
  site?: string;
}

/** 预览缓存有效期（7 天） */
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'bob-link-preview:';

/** 同 URL 并发去重：多个卡片共用同一次请求 */
const inflight = new Map<string, Promise<LinkPreview | null>>();

function readCache(url: string): LinkPreview | null {
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + url);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t?: number; d?: LinkPreview };
    if (!parsed?.t || !parsed.d) return null;
    if (Date.now() - parsed.t > CACHE_TTL) return null;
    return parsed.d;
  } catch {
    return null;
  }
}

function writeCache(url: string, data: LinkPreview): void {
  try {
    window.localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ t: Date.now(), d: data }));
  } catch {
    /* 配额不足 / 隐私模式：忽略缓存失败 */
  }
}

/** 拉取链接预览；失败返回 null（调用方降级为普通链接），失败结果不写入缓存以便重试 */
function loadPreview(url: string): Promise<LinkPreview | null> {
  const cached = readCache(url);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(url);
  if (pending) return pending;
  const task = fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { success?: boolean; data?: LinkPreview } | null) => {
      const data = j?.success && j.data ? j.data : null;
      if (data) writeCache(url, data);
      inflight.delete(url);
      return data;
    })
    .catch(() => {
      inflight.delete(url);
      return null;
    });
  inflight.set(url, task);
  return task;
}

/** 域名兜底显示（URL 非法时直接显示原始字符串） */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** 链接卡片 NodeView：抓取中显示域名占位，成功后展示标题/描述/图标，失败降级为普通链接 */
function LinkCardView({ node }: NodeViewProps) {
  const url = (node.attrs.url as string) || '';
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!url) {
      setLoading(false);
      setFailed(true);
      return;
    }
    setLoading(true);
    setFailed(false);
    void loadPreview(url).then((data) => {
      if (!alive) return;
      setLoading(false);
      if (data) setPreview(data);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(url, '_blank', 'noopener');
  };

  const domain = domainOf(url);

  // 抓取失败 / 无 URL：降级为普通链接
  if (failed) {
    return (
      <NodeViewWrapper as="div" className="link-card-fallback" contentEditable={false}>
        <a href={url} target="_blank" rel="noopener noreferrer nofollow" onClick={open}>
          {url}
        </a>
      </NodeViewWrapper>
    );
  }

  const icon = preview?.icon;
  const title = preview?.title?.trim() || domain;
  const desc = preview?.description?.trim() || (loading ? '正在获取链接预览…' : '');

  return (
    <NodeViewWrapper as="div" className={`link-card${loading ? ' is-loading' : ''}`} data-url={url} contentEditable={false}>
      <span className="link-card-main" title={url} onClick={open}>
        <span className="link-card-icon">
          {loading ? (
            <Loader2 className="link-card-spin" />
          ) : icon ? (
            <img
              src={icon}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <Globe className="link-card-globe" />
          )}
        </span>
        <span className="link-card-text">
          <span className="link-card-title">{title}</span>
          {desc ? <span className="link-card-desc">{desc}</span> : null}
          <span className="link-card-site">{domain}</span>
        </span>
        <span className="link-card-open">
          <ExternalLink className="link-card-open-icon" />
        </span>
      </span>
      {!loading && preview?.image ? (
        <span className="link-card-thumb">
          <img
            src={preview.image}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.parentElement?.style.setProperty('display', 'none');
            }}
          />
        </span>
      ) : null}
    </NodeViewWrapper>
  );
}

/** HTML 属性转义（拼接 data-url 时使用） */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 判断「链接文字」是否就是裸 URL（粘贴 URL 生成的 [url](url)） */
function isBareUrlLink(text: string, href: string): boolean {
  const t = text.trim().toLowerCase().replace(/\/+$/, '');
  const h = href.trim().toLowerCase().replace(/\/+$/, '');
  if (!t || !h) return false;
  if (t === h) return true;
  const noScheme = h.replace(/^https?:\/\//, '');
  return t === noScheme || t === noScheme.replace(/^www\./, '');
}

/** markdown-it inline token 的极简结构（仅取判定所需字段） */
interface MdInlineToken {
  type?: string;
  content?: string;
  children?: MdInlineToken[] | null;
  attrs?: Array<[string, string]> | null;
}
interface MdToken {
  type?: string;
  level?: number;
}
interface MdRendererRules {
  [name: string]: ((tokens: MdToken[], idx: number, options: unknown, env: unknown, self: unknown) => string) | undefined;
}
interface MdRenderer {
  rules: MdRendererRules;
  renderToken(tokens: MdToken[], idx: number, options: unknown): string;
}

/** 段落内容若为「唯一一个链接」，返回其文字与 href；否则返回 null */
function soleLinkOf(inline: MdInlineToken | undefined): { text: string; href: string } | null {
  const kids = inline?.children;
  if (!kids || kids.length !== 3) return null;
  const [open, text, close] = kids;
  if (open?.type !== 'link_open' || text?.type !== 'text' || close?.type !== 'link_close') return null;
  const href = open.attrs?.find(([k]) => k === 'href')?.[1] || '';
  if (!href) return null;
  return { text: text.content || '', href };
}

/** 链接卡片节点（block atom：独占一行，内部不可编辑，只能整体选中/删除） */
export const LinkCard = Node.create({
  name: 'linkCard',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-link-card]',
        getAttrs: (el) => ({ url: (el as HTMLElement).getAttribute('data-url') || '' }),
      },
    ];
  },

  renderHTML({ node }) {
    return ['div', { 'data-link-card': 'true', 'data-url': node.attrs.url as string }];
  },

  renderText({ node }) {
    const url = node.attrs.url as string;
    return `[${url}](${url})`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(LinkCardView);
  },

  // tiptap-markdown 双向序列化：卡片 ↔ `[url](url)`
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (text: string) => void; ensureNewLine?: () => void; closeBlock?: (node: unknown) => void },
          node: { attrs: { url: string } },
        ) {
          const url = String(node.attrs.url || '');
          if (!url) return;
          // URL 含空白/括号/尖括号时用 <> 包裹，保证 markdown 合法且可逆
          const href = /[\s()<>]/.test(url) ? `<${url}>` : url;
          state.ensureNewLine?.();
          state.write(`[${url}](${href})`);
          // 必须收尾：否则与下一个块（段落/标题/另一张卡片）之间不会插入空行，
          // markdown 会把它们并进同一段落，重开后卡片丢失
          state.closeBlock?.(node);
        },
        parse: {
          setup(md: { renderer: MdRenderer }) {
            const origOpen = md.renderer.rules.paragraph_open;
            const origClose = md.renderer.rules.paragraph_close;
            // 段落不会嵌套，用闭包标记当前段是否已转为卡片
            let cardOpen = false;
            md.renderer.rules.paragraph_open = (tokens, idx, options, env, self) => {
              const token = tokens[idx];
              // 仅顶层段落（level 0）升级为块级卡片，避免列表项/引用块内出现非法块结构
              if (token?.level === 0) {
                const inline = tokens[idx + 1] as unknown as MdInlineToken;
                const link = soleLinkOf(inline);
                if (link && isBareUrlLink(link.text, link.href)) {
                  cardOpen = true;
                  // markdown-it 的 inline token 不经过 renderer.rules（render 内部直接调 renderInline），
                  // 因此必须在 token 层清空子节点，否则卡片后还会多出一个重复的普通链接
                  if (inline) inline.children = [];
                  return `<div data-link-card="true" data-url="${escapeAttr(link.href)}"></div>`;
                }
              }
              cardOpen = false;
              return typeof origOpen === 'function'
                ? origOpen(tokens, idx, options, env, self)
                : md.renderer.renderToken(tokens, idx, options);
            };
            md.renderer.rules.paragraph_close = (tokens, idx, options, env, self) => {
              if (cardOpen) {
                cardOpen = false;
                return '';
              }
              return typeof origClose === 'function'
                ? origClose(tokens, idx, options, env, self)
                : md.renderer.renderToken(tokens, idx, options);
            };
          },
        },
      },
    };
  },
});
