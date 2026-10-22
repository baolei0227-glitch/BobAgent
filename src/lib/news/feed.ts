/**
 * Daily News —— 发现层：新闻源（RSS / Atom）拉取与解析（server-only）
 *
 * 为什么需要它：原先的发现层只有关键词搜索（早期 web.ts 的本地多引擎抓取，现为 DeepSeek Search），
 * 抓回来的常是列表页 / 二手转载页。策展几个稳定的官方 feed 直接拉最新条目，
 * 命中率与时效性都更好，也省一次搜索。
 *
 * 实测边界（2026-10-04，境内网络）：
 *   - Google News RSS / BBC / RSSHub 全部不可达；Bing 的 `format=RSS` 已失效（302 回 HTML 首页）。
 *   - 可用：ifanr / ithome / sspai（科技）、chinanews 各分区（财经 / 综合 / 时政 / 社会）。
 *   - **法律类没有任何可用 feed** —— 该类主题没有策展源，由调用方回退关键词搜索。
 *
 * 解析层 `parseFeedXml` 是纯函数（不碰网络），便于单测；`searchNewsRss` 只负责抓取与合并。
 */
import { XMLParser } from 'fast-xml-parser';

/** 一条 feed 条目 */
export interface FeedItem {
  title: string;
  url: string;
  /** 摘要（已去标签 / 解码实体 / 合并空白；可能为空） */
  snippet: string;
  /** 发布时间（ms；解析不到为 0） */
  dateMs: number;
}

/** 与 web.ts 的 LocalSearchResult 结构一致，便于调用方互换 */
export interface FeedHit {
  title: string;
  url: string;
  snippet: string;
}

/** 摘要截断长度 / 标题截断长度 */
const SNIPPET_MAX = 200;
const TITLE_MAX = 300;
/** 单个 feed 的抓取超时 */
const FEED_TIMEOUT_MS = 15_000;
const FEED_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

/** 把 fast-xml-parser 的节点（string / number / 带属性的对象 / 数组）统一取成字符串 */
function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return asText(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o['#text'] != null) return String(o['#text']);
    if (o['#cdata'] != null) return String(o['#cdata']);
  }
  return '';
}

/** 统一成数组（XML 单个元素不会产生数组） */
function asArray(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 解码常见 HTML 实体（含数字实体） */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&ldquo;/gi, '\u201c')
    .replace(/&rdquo;/gi, '\u201d')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return code < 0x10000 ? String.fromCharCode(code) : '';
    });
}

/** 去标签 + 解码实体 + 合并空白 + 截断（先解码再去标签：兼容「实体转义过的 HTML 摘要」） */
function cleanText(raw: string, max: number): string {
  const t = decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Atom 的 <link> 是对象数组（rel/href），RSS 的是纯文本 —— 统一取 alternate 或首个 href */
function linkOf(node: unknown): string {
  for (const l of asArray(node)) {
    if (typeof l === 'string') {
      if (/^https?:\/\//i.test(l.trim())) return l.trim();
      continue;
    }
    if (l && typeof l === 'object') {
      const o = l as Record<string, unknown>;
      const href = typeof o['@_href'] === 'string' ? o['@_href'].trim() : '';
      const rel = typeof o['@_rel'] === 'string' ? o['@_rel'] : '';
      if (href && (rel === '' || rel === 'alternate')) return href;
    }
  }
  return '';
}

/** 解析时间字段为 ms（解析不到为 0） */
function dateOf(node: unknown): number {
  const s = asText(node);
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 解析一个 RSS 2.0 / Atom / RDF 文档为条目数组（保持文档内顺序）。
 * 结构异常 / 非 feed 内容一律返回空数组，不抛异常。
 */
export function parseFeedXml(xml: string): FeedItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const rss = doc.rss as Record<string, unknown> | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;
  const rdf = doc['rdf:RDF'] as Record<string, unknown> | undefined;
  const nodes = rss
    ? asArray((rss.channel as Record<string, unknown> | undefined)?.item)
    : atom
      ? asArray(atom.entry)
      : rdf
        ? asArray(rdf.item)
        : [];

  const items: FeedItem[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    const url = linkOf(o.link) || asText(o.guid) || asText(o['@_rdf:about']) || asText(o.id);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const rawDesc = asText(o.description) || asText(o.summary) || asText(o['content:encoded']) || asText(o.content);
    items.push({
      title: cleanText(asText(o.title), TITLE_MAX) || '(untitled)',
      url,
      snippet: cleanText(rawDesc, SNIPPET_MAX),
      dateMs: dateOf(o.pubDate) || dateOf(o.published) || dateOf(o.updated) || dateOf(o['dc:date']),
    });
  }
  return items;
}

/**
 * 把各 feed 的条目按「源间有界轮转（round-robin）」合并成命中列表。
 *
 * 每轮从每个源各取一条（源内先按时间新→旧排好），按 URL 去重，直到取满 maxResults 或全部取尽。
 * 为什么不用全局按时间排序：更新最勤的源会刷满名额 —— 实测纯排序时 Tech 的 4 条全部来自 ithome，
 * ifanr / sspai 一条都进不来。轮转保证每个可用源都有发言权，同时源内仍是最新的在前。
 */
export function interleaveFeeds(perFeed: FeedItem[][], maxResults: number): FeedHit[] {
  const queues = perFeed.map((items) => [...items].sort((a, b) => b.dateMs - a.dateMs));
  const seen = new Set<string>();
  const hits: FeedHit[] = [];
  let drained = false;
  while (hits.length < maxResults && !drained) {
    drained = true;
    for (const q of queues) {
      if (hits.length >= maxResults) break;
      const it = q.shift();
      if (!it) continue;
      drained = false;
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      hits.push({ title: it.title, url: it.url, snippet: it.snippet });
    }
  }
  return hits;
}

/**
 * 抓一批 feed，按源间轮转合并（见 interleaveFeeds）、取前 maxResults 条。
 * 单个 feed 失败只记进 errors（不影响其余），**永不抛异常** —— 调用方据 hits 是否为空决定回退。
 */
export async function searchNewsRss(
  feeds: string[],
  maxResults: number,
): Promise<{ hits: FeedHit[]; errors: string[] }> {
  const errors: string[] = [];
  const perFeed = await Promise.all(
    feeds.map(async (feed) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
        let resp: Response;
        try {
          resp = await fetch(feed, {
            headers: {
              'User-Agent': FEED_UA,
              Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            },
            redirect: 'follow',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return parseFeedXml(await resp.text());
      } catch (e) {
        errors.push(`${feed}: ${e instanceof Error ? e.message : String(e)}`);
        return [] as FeedItem[];
      }
    }),
  );

  return { hits: interleaveFeeds(perFeed, maxResults), errors };
}
