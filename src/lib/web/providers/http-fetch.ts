/**
 * 本地 HTTP(S) 抓取 provider —— `http`。
 *
 * 无 Key 的兜底抓取：自己发请求、限制目标为公网地址、跟随有界重定向、限制响应大小，
 * 再把 HTML 转成 Markdown（复用 materials 侧同一套 turndown 规则）。
 *
 * 安全边界（本地桌面工具可接受的最小 SSRF 防护）：
 *   - 只接受 http/https，禁止内嵌用户名密码，URL ≤ 2048；
 *   - 拒绝 localhost / *.local / *.internal；
 *   - DNS 解析后所有地址必须是公网单播（拒绝环回、私网、链路本地、组播、保留段）；
 *   - 每一跳重定向都重新校验；最多 5 跳；
 *   - 响应 ≤ 5MB，正文 ≤ 100k 字符，超时 20s。
 * 已知限制：DNS 校验与实际连接之间存在 rebinding 窗口；需要更强保证时用 DeepSeek Fetch。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { extractHtmlText } from '@/lib/materials/html-text';
import { WebError, type WebFetchProvider, type WebFetchRequest, type WebFetchResult } from '../types';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_MARKDOWN_CHARS = 100_000;
const MAX_URL_CHARS = 2_048;

const USER_AGENT = 'BobWork/1.0 (+web_fetch)';

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast / reserved / broadcast
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === '::' || addr === '::1') return false;
  if (addr.startsWith('fc') || addr.startsWith('fd')) return false; // ULA fc00::/7
  if (/^fe[89ab]/.test(addr)) return false; // link-local fe80::/10
  if (addr.startsWith('ff')) return false; // multicast
  if (addr.startsWith('2001:db8')) return false; // documentation
  if (addr.startsWith('::ffff:')) return isPublicIpv4(addr.slice('::ffff:'.length));
  if (addr.startsWith('64:ff9b::')) {
    // NAT64 转换地址：最后 32 位是 IPv4，十六进制点分两种写法都检查
    const tail = addr.slice('64:ff9b::'.length);
    const dotted = tail.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) return isPublicIpv4(dotted[1]);
    const hex = tail.split(':').filter(Boolean);
    if (hex.length === 2) {
      const hi = parseInt(hex[0], 16);
      const lo = parseInt(hex[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPublicIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
    }
  }
  return true;
}

export function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

/** 校验并解析一个公网 URL；失败抛 WebError（可路由的 code） */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebError('WEB_INVALID_URL', `Invalid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError('WEB_INVALID_URL', 'Only http(s) URLs are supported.');
  }
  if (url.username || url.password) {
    throw new WebError('WEB_INVALID_URL', 'URLs with embedded credentials are not allowed.');
  }
  if (url.href.length > MAX_URL_CHARS) {
    throw new WebError('WEB_INVALID_URL', `URL exceeds ${MAX_URL_CHARS} characters.`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new WebError('WEB_INVALID_URL', 'URL has no hostname.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new WebError('WEB_BLOCKED_URL', `Blocked non-public host: ${host}`);
  }

  if (isIP(host)) {
    if (!isPublicIp(host)) throw new WebError('WEB_BLOCKED_URL', `Blocked non-public address: ${host}`);
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new WebError('WEB_PROVIDER_ERROR', `DNS lookup failed for ${host}`);
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new WebError('WEB_BLOCKED_URL', `Host ${host} resolves to a non-public address.`);
  }
  return url;
}

/** 有界读取响应体，超限直接中止 */
async function readLimited(resp: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(resp.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebError('WEB_FETCH_TOO_LARGE', `Response exceeds ${maxBytes} bytes.`);
  }
  if (!resp.body) {
    const buffer = new Uint8Array(await resp.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new WebError('WEB_FETCH_TOO_LARGE', `Response exceeds ${maxBytes} bytes.`);
    return buffer;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new WebError('WEB_FETCH_TOO_LARGE', `Response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 探测 charset：BOM → Content-Type → <meta charset>；GB2312/GB18030 统一按 GBK 解码 */
function detectCharset(bytes: Uint8Array, contentType: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';

  const header = /charset=["']?([\w-]+)/i.exec(contentType);
  if (header) return header[1];

  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2_048));
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return meta ? meta[1] : 'utf-8';
}

function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    const normalized = /^gb2312$|^gb18030$/i.test(charset) ? 'gbk' : charset;
    return new TextDecoder(normalized).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function isTextContentType(contentType: string): boolean {
  return (
    contentType.includes('text/') ||
    contentType.includes('html') ||
    contentType.includes('xml') ||
    contentType.includes('json') ||
    contentType.includes('markdown')
  );
}

function isHtmlContent(contentType: string, body: string): boolean {
  return contentType.includes('html') || /^\s*<!doctype html|^\s*<html[\s>]/i.test(body);
}

/** HTML → 标题 + Markdown；抽不到正文时退回整页去标签，保证不返回空壳 */
function htmlToMarkdown(html: string): { title: string; markdown: string } {
  const extracted = extractHtmlText(html);
  const fallback = html
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
  return { title: extracted.title, markdown: extracted.markdown.trim() || fallback };
}

export const httpFetchProvider: WebFetchProvider = {
  id: 'http',

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const requested = request.url.trim();
    let current = await assertPublicUrl(requested);
    const requestedUrl = current.href;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const combined = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

      let resp: Response;
      try {
        resp = await fetch(current, {
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          signal: combined,
        });
      } catch (e) {
        if (request.signal?.aborted) throw new WebError('WEB_ABORTED', 'Web fetch aborted.');
        if (combined.aborted) throw new WebError('WEB_FETCH_TIMEOUT', `Fetch timed out after ${FETCH_TIMEOUT_MS}ms.`);
        throw new WebError(
          'WEB_PROVIDER_ERROR',
          `HTTP fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const location = resp.headers.get('location');
        if (!location) throw new WebError('WEB_REDIRECT_BLOCKED', 'Redirect without Location header.');
        if (hop === MAX_REDIRECTS) {
          throw new WebError('WEB_REDIRECT_BLOCKED', `Exceeded ${MAX_REDIRECTS} redirects.`);
        }
        current = await assertPublicUrl(new URL(location, current).href);
        continue;
      }

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      if (!isTextContentType(contentType)) {
        throw new WebError('WEB_UNSUPPORTED_CONTENT_TYPE', `Unsupported content type: ${contentType || 'unknown'}`);
      }

      const bytes = await readLimited(resp, MAX_RESPONSE_BYTES);
      const text = decodeBody(bytes, detectCharset(bytes, contentType));
      const isHtml = isHtmlContent(contentType, text);

      let title = '';
      let markdown: string;
      if (isHtml) {
        const converted = htmlToMarkdown(text);
        title = converted.title;
        markdown = converted.markdown;
      } else {
        markdown = text.trim();
        const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
        title = titleMatch ? titleMatch[1].trim() : '';
      }

      const truncated = markdown.length > MAX_MARKDOWN_CHARS;
      return {
        provider: 'http',
        requestedUrl,
        finalUrl: current.href,
        statusCode: resp.status,
        title,
        markdown: truncated ? markdown.slice(0, MAX_MARKDOWN_CHARS) : markdown,
        truncated,
      };
    }

    throw new WebError('WEB_REDIRECT_BLOCKED', `Exceeded ${MAX_REDIRECTS} redirects.`);
  },
};
