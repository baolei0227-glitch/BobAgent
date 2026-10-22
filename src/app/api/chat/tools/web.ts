/**
 * Web 场景工具：网页搜索（web_search）与网页抓取（web_fetch）。
 *
 * 本文件只做参数校验与结果呈现；provider 选择/鉴权/传输/错误码在 @/lib/web。
 * 因此换成任何聊天模型都不影响这两个工具的可用性——执行侧用自己的 provider。
 */
import type { EnhancedToolResult, Tool, ToolExecContext } from './index';
import { buildCardListHtml, type CardItem } from './cards';
import { truncate } from './shared';
import { webService } from '@/lib/web';
import { formatWebError } from '@/lib/web/service';
import type { WebBillingContext, WebFetchResult, WebSearchResult } from '@/lib/web/types';

/** 单条结果给模型看的摘要上限：5 条 × 700 字仍能压进 web_search 的 5000 字预算 */
const SEARCH_MODEL_SUMMARY_MAX = 700;
/** 卡片正文上限：优先用前端短摘要 snippet；只有 summary 时截断，避免整页正文塞进卡片 */
const SEARCH_CARD_BODY_MAX = 320;

/** 安全提取 URL 域名，无效 URL 不抛异常 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** RFC 3339 → YYYY-MM-DD（卡片/引用只需要日期；解析失败返回空串） */
function formatDate(date: string | null): string {
  if (!date) return '';
  const matched = date.match(/^\d{4}-\d{2}-\d{2}/);
  return matched ? matched[0] : '';
}

/** 截断并补省略号（保留原文可读性，不引入额外标注） */
function clip(text: string, max: number): string {
  const value = text.trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 计费归属：让按次计费的 provider 把本次调用记到当前项目 / 节点；无项目时不传（记全局） */
function billingContext(ctx?: ToolExecContext): WebBillingContext | undefined {
  if (!ctx) return undefined;
  return ctx.projectRoot || ctx.projectId
    ? { projectRoot: ctx.projectRoot, projectId: ctx.projectId }
    : undefined;
}

/** provider id → 展示名（卡片/标题用） */
function providerLabel(id: string): string {
  if (id === 'deepseek-search-api') return 'DeepSeek';
  return id;
}

/** 网页搜索 — 结构化结果（站点 / 日期 / 权威性），支持 site:/after:/before: 等语法
 *  方案 B：返回 EnhancedToolResult，text 供 LLM 引用，cardHtml 由宿主渲染为搜索结果卡 */
async function toolWebSearch(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string | EnhancedToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return 'Error: query required';

  let result: WebSearchResult;
  try {
    result = await webService.search({ query, count: 5, billing: billingContext(ctx) });
  } catch (e) {
    return formatWebError(e);
  }

  const sources = result.sources;
  if (sources.length === 0) {
    return `No results: ${providerLabel(result.provider)} 未返回与「${query}」相关的结果。可尝试更换关键词，或放宽 site:/after:/before: 等限定。`;
  }

  const items: CardItem[] = sources.map((r) => {
    const source = r.siteName || hostOf(r.url) || 'Web';
    const date = formatDate(r.publishedAt);
    return {
      title: r.title,
      badge: r.authority >= 3 ? `权威 ${r.authority}` : 'Web',
      badgeColor: r.authority >= 3 ? 'green' : 'default',
      meta: [source, date].filter(Boolean).join(' · '),
      body: clip(r.snippet || r.summary, SEARCH_CARD_BODY_MAX),
      url: r.url,
      btnText: '访问',
    };
  });

  const lines: string[] = [`Search results (${providerLabel(result.provider)}):`];
  sources.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   URL: ${r.url}`);
    const meta = [
      r.siteName || hostOf(r.url),
      formatDate(r.publishedAt),
      r.authority >= 0 ? `权威性 ${r.authority}/4` : '',
    ].filter(Boolean).join(' · ');
    if (meta) lines.push(`   来源: ${meta}`);
    const body = clip(r.summary || r.snippet, SEARCH_MODEL_SUMMARY_MAX);
    if (body) lines.push(`   摘要: ${body}`);
  });

  return { text: lines.join('\n'), cardHtml: buildCardListHtml(items) };
}

/** web_fetch 工具 — 返回页面 Markdown 正文（provider 决定是 DeepSeek Fetch 还是本地 HTTP） */
async function toolWebFetch(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) return 'Error: url 必填';
  if (!/^https?:\/\//i.test(url)) return 'Error: 请输入合法的 http(s):// URL';

  let result: WebFetchResult;
  try {
    result = await webService.fetch({ url, billing: billingContext(ctx) });
  } catch (e) {
    return formatWebError(e);
  }

  if (!result.markdown.trim()) {
    return `Error: [WEB_PROVIDER_ERROR] HTTP ${result.statusCode}，未取到可用正文。可改用 browser_navigate + browser_extract_text 打开页面。`;
  }

  const header = [`URL: ${result.finalUrl || url}`, `标题: ${result.title || '(未识别)'}`];
  if (result.statusCode !== 200) header.push(`HTTP: ${result.statusCode}`);
  return truncate(`${header.join('\n')}\n\n${result.markdown}`, 7600);
}

export const webToolDefs: Tool[] = [
  {
    name: 'web_search',
    description:
      'Search the web (DeepSeek Search by default; provider is configured independently of the chat model). Real-time structured results with site/date/authority. Query supports search syntax: site:example.com, -site:, "exact phrase", -word, lang:zh,en, after:2025, before:2026-06. When several results match, present them as an ai-card list (one .ai-card per result: title/meta/body).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords, optionally with DeepSeek search syntax (site:, lang:, after:, before:, "..." exact phrase). e.g. "民法典 第577条 site:court.gov.cn after:2025"',
        },
      },
      required: ['query'],
    },
    category: '网络',
    execute: toolWebSearch,
    maxOutput: 5000,
  },
  {
    name: 'web_fetch',
    description: 'Fetch a specific URL and return the page main content as Markdown. Use when the user provides a link (e.g. pasted URL) or you need the full text of a known URL. For sites that block crawlers (Zhihu, WeChat, court document sites), fall back to browser_* tools.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to fetch, e.g. https://example.com/page',
        },
      },
      required: ['url'],
    },
    category: '网络',
    execute: toolWebFetch,
    maxOutput: 8000,
  },
];
