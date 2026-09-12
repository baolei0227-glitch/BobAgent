/**
 * Web 场景工具：网页搜索（web_search，多 provider 降级）与网页抓取（web_fetch）。
 * 从 tools/index.ts 抽出，导入路径保持不变（index.ts 通过 ...webToolDefs 聚合）。
 * 依赖方向单向：./cards（卡片 HTML）+ ./shared（truncate）+ 仅以 import type 依赖 index.ts 的类型。
 */
import type { EnhancedToolResult, Tool } from './index';
import { buildCardListHtml, type CardItem } from './cards';
import { truncate } from './shared';

/** 网页搜索 — 多 provider 降级：Coze SDK → Bing HTTP → DuckDuckGo Lite
 *  方案 B：返回 EnhancedToolResult，text 供 LLM 引用，cardHtml 由宿主渲染为搜索结果卡 */
async function toolWebSearch(args: Record<string, unknown>): Promise<string | EnhancedToolResult> {
  const query = args.query as string;
  if (!query) return 'Error: query required';
  // 安全提取 URL 域名，无效 URL 不抛异常
  const hostOf = (u?: string): string | undefined => {
    if (!u) return undefined;
    try { return new URL(u).hostname; } catch { return undefined; }
  };

  // Provider 1: Coze SDK（需要配置 API Key）
  try {
    const { SearchClient, Config } = await import('coze-coding-dev-sdk');
    const config = new Config();
    if (config.apiKey) {
      const client = new SearchClient(config);
      const response = await client.webSearch(query, 5, true);

      if (response.web_items && response.web_items.length > 0) {
        const items: CardItem[] = response.web_items.map((it) => ({
          title: it.title || 'Untitled',
          badge: 'Web',
          meta: hostOf(it.url),
          body: it.snippet,
          url: it.url,
          btnText: '访问',
        }));
        const parts: string[] = [];
        if (response.summary) parts.push(`Summary: ${response.summary}`);
        parts.push('Search results:');
        for (const it of response.web_items) {
          parts.push(`- ${it.title}${it.url ? ` (${it.url})` : ''}: ${it.snippet}`);
        }
        return { text: parts.join('\n'), cardHtml: buildCardListHtml(items) };
      }
      if (response.summary) {
        return { text: `Summary: ${response.summary}`, cardHtml: '' };
      }
    }
  } catch {
    // SDK 不可用，降级到本地搜索
  }

  // Provider 2 & 3 & 4: 本地 HTTP 抓取（无需 API Key）
  // 百度优先（中文搜索质量最好），Bing 次之，DDG 兜底
  const providers = [
    { name: 'Baidu', search: searchBaiduHttp },
    { name: 'Bing', search: searchBingHttp },
    { name: 'DuckDuckGo', search: searchDuckDuckGoLite },
  ];
  const errors: string[] = [];

  for (const { name, search } of providers) {
    try {
      // 字典/攻略类无关站直接过滤；若该 provider 过滤后无结果则尝试下一个（避免把无关垃圾当有效结果返回）
      const results = filterJunkSearchResults(await search(query, 5));
      if (results.length > 0) {
        const items: CardItem[] = results.map((r) => ({
          title: r.title || 'Untitled',
          badge: name,
          meta: hostOf(r.url),
          body: r.snippet,
          url: r.url,
          btnText: '访问',
        }));
        const parts: string[] = ['Search results:'];
        for (const r of results) {
          parts.push(`- ${r.title}${r.url ? ` (${r.url})` : ''}: ${r.snippet}`);
        }
        return { text: parts.join('\n'), cardHtml: buildCardListHtml(items) };
      }
      errors.push(`${name}: no results`);
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return `Search failed after trying ${providers.length} providers:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\nCheck network and retry.`;
}

/** web_fetch 工具：抓取指定 URL 的文本内容（HTML 自动清洗为纯文本） */
async function toolWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = (args.url as string || '').trim();
  if (!url) return 'Error: url 必填';
  if (!/^https?:\/\//i.test(url)) return 'Error: 请输入合法的 http(s):// URL';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;

    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    const isTextLike =
      ctype.includes('text/') || ctype.includes('html') || ctype.includes('xml') ||
      ctype.includes('json') || ctype.includes('javascript') || ctype.includes('csv') ||
      ctype.includes('markdown');
    if (!isTextLike) {
      return `URL: ${url}\nContent-Type: ${ctype || '未知'}\n（非文本内容，无法直接读取网页正文）`;
    }

    // charset 感知解码：GBK/GB2312 等中文旧站（法院/政府官网常见）直接 utf-8 解码会乱码。
    // 探测顺序：BOM → Content-Type charset → <meta charset>；不可用回退 utf-8。
    const raw = await resp.arrayBuffer();
    const bytes = new Uint8Array(raw);
    let charset = '';
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = 'utf-8';
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = 'utf-16be';
    const headerCharset = ctype.match(/charset=["']?([\w-]+)/i);
    if (!charset && headerCharset) charset = headerCharset[1];
    if (!charset) {
      try {
        const head = new TextDecoder('utf-8').decode(bytes.slice(0, 2048));
        const metaCharset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
        if (metaCharset) charset = metaCharset[1];
      } catch {
        /* 头部探测失败按默认处理 */
      }
    }
    let text: string;
    try {
      // gb2312/gb18030 与 gbk 同族，统一映射到 TextDecoder 的 gbk；不支持时回退 utf-8
      const norm = /^gb2312$|^gb18030$/i.test(charset) ? 'gbk' : (charset || 'utf-8');
      text = new TextDecoder(norm).decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }
    // 二进制/乱码防护：仅保留可见字符比例高的内容
    let visible = 0;
    for (let i = 0; i < Math.min(text.length, 2000); i++) {
      const c = text.charCodeAt(i);
      if ((c >= 32 && c <= 126) || c >= 128 || c === 10 || c === 9) visible++;
    }
    if (visible < Math.min(text.length, 2000) * 0.5) {
      return `URL: ${url}\nContent-Type: ${ctype}\n（内容疑似二进制，无法直接读取）`;
    }

    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';
    const clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
    const body = truncate(clean, 6000);
    return `URL: ${url}\n标题: ${title || '(未识别)'}\n\n${body || '(未提取到正文，可能为 JS 动态渲染页面)'}`;
  } catch (e) {
    return `Error: 抓取失败 ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---- 本地搜索 Provider ----

interface LocalSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** Bing HTTP 抓取 */
async function searchBingHttp(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': SEARCH_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const results: LocalSearchResult[] = [];
  const blockRegex = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) && results.length < maxResults) {
    const block = match[1];
    // 从 <h2> 内提取链接
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const rawUrl = linkMatch[1];
    const title = stripHtml(linkMatch[2]).trim();
    if (!title || rawUrl.startsWith('javascript:')) continue;

    // 摘要：优先 b_caption 内的 <p>
    let snippet = '';
    const snippetMatch =
      block.match(/<div[^>]*class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (snippetMatch) {
      snippet = decodeHtmlEntities(stripHtml(snippetMatch[1])).trim();
    }

    results.push({ title, url: rawUrl, snippet });
  }

  return results;
}

/** 无关结果过滤：纯字词典/攻略站对检索无权威价值，剔除避免污染（百科类正常引用不误杀） */
function filterJunkSearchResults(results: LocalSearchResult[]): LocalSearchResult[] {
  const junkHost = /(^|\.)(gxdq|hgcha|chagushici|hanyuguoxue)\.com$|^jingyan\.baidu\.com$/i;
  return results.filter((r) => {
    try {
      const host = new URL(r.url).hostname.replace(/^www\./i, '');
      return !junkHost.test(host);
    } catch {
      return true; // 无法解析的 URL 保留（可能是跳转链）
    }
  });
}

/** 百度搜索 HTTP 抓取 */
async function searchBaiduHttp(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': SEARCH_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const results: LocalSearchResult[] = [];
  // 百度结果标题在 <h3> > <a> 中，href 为跳转链；h3 的 data-tools JSON / mu 属性携带真实目标 URL。
  // 解析成功则用真实 URL 替代跳转链 → 模型可直接据域名判断权威性，web_fetch 也免二次跳转。
  const h3Regex = /<h3([^>]*)>[\s\S]*?<a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = h3Regex.exec(html)) && results.length < maxResults) {
    const attrs = match[1] || '';
    const rawUrl = match[2];
    const title = decodeHtmlEntities(stripHtml(match[3])).trim();
    if (!title) continue;

    // 真实目标 URL：优先 h3 上 data-tools JSON 的 url（当前百度），其次 mu 属性（历史版式）
    let realUrl = rawUrl;
    const dt = attrs.match(/data-tools='([^']+)'/) || attrs.match(/data-tools="([^"]+)"/);
    if (dt) {
      try {
        const j = JSON.parse(decodeHtmlEntities(dt[1]));
        if (j && typeof j.url === 'string' && /^https?:\/\//i.test(j.url)) realUrl = j.url;
      } catch {
        /* 解析失败保留跳转链 */
      }
    }
    if (realUrl === rawUrl) {
      const mu = attrs.match(/\bmu="(https?:\/\/[^"]+)"/);
      if (mu) realUrl = mu[1];
    }

    // 摘要：取本结果标题到下一个 <h3> 之间的正文区，依次尝试常见摘要容器 class
    const tail = html.slice(h3Regex.lastIndex).replace(/<script[\s\S]*?<\/script>/gi, ' ');
    const nextH3 = tail.search(/<h3[^>]*>/i);
    const win = (nextH3 > -1 ? tail.slice(0, nextH3) : tail).slice(0, 2000);
    let snippet = '';
    for (const sm of [
      win.match(/<span[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i),
      win.match(/class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\//i),
      win.match(/<div[^>]*class="c-span-last[^"]*"[^>]*>([\s\S]*?)<\/div>/i),
    ]) {
      if (sm && sm[1]) {
        snippet = decodeHtmlEntities(stripHtml(sm[1])).trim().replace(/\s+/g, ' ');
        if (snippet) break;
      }
    }

    results.push({ title, url: realUrl, snippet });
  }

  return results;
}

/** DuckDuckGo Lite 抓取 */
async function searchDuckDuckGoLite(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const resp = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'User-Agent': SEARCH_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

  const links: Array<[string, string]> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html))) {
    links.push([m[1], m[2]]);
  }
  while ((m = snippetRegex.exec(html))) {
    snippets.push(m[1]);
  }

  const results: LocalSearchResult[] = [];
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const [rawUrl, rawTitle] = links[i];
    const title = cleanDdgTitle(rawTitle);
    const url = extractDdgUrl(rawUrl);
    const snippet = i < snippets.length ? decodeHtmlEntities(stripHtml(snippets[i])).trim() : '';
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/** 提取 DDG 跳转链接中的真实 URL */
function extractDdgUrl(rawUrl: string): string {
  if (rawUrl.includes('uddg=')) {
    const match = rawUrl.match(/uddg=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  if (rawUrl.startsWith('//')) return 'https:' + rawUrl;
  return rawUrl;
}

/** 清理 DDG Lite 标题中的 URL 残留 */
function cleanDdgTitle(rawTitle: string): string {
  let text = stripHtml(rawTitle).trim();
  // 截断混入的 URL
  text = text.split(/https?:\/\//)[0];
  // 去掉尾部残留域名
  text = text.replace(/\s*\w+\.\w{2,}\s*$/, '').trim();
  return text;
}

/** 移除 HTML 标签 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** 解码常见 HTML 实体 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&nbsp;': ' ', '&ensp;': ' ', '&emsp;': ' ',
    '&#0183;': '·', '&middot;': '·', '&mdash;': '—', '&ndash;': '–',
    '&hellip;': '…', '&ldquo;': '\u201c', '&rdquo;': '\u201d',
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }
  // 数字实体
  text = text.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    return code < 0x10000 ? String.fromCharCode(code) : '';
  });
  // 合并空白
  return text.replace(/\s+/g, ' ').trim();
}

export const webToolDefs: Tool[] = [
  {
    name: 'web_search',
    description:
      'Search the web for latest info, facts, or real-time content (multiple engines, auto-fallback). When several results match, present them as an ai-card list (one .ai-card per result: title/meta/body).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords. e.g. "Next.js 16 standalone mode", "Python asyncio tutorial"',
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
    description: 'Fetch content from a specific URL. Use when the user provides a link (e.g. pasted URL) and you need the webpage content, or to retrieve a known URL directly.',
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
