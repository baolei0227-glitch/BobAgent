import { NextRequest, NextResponse } from 'next/server';

/**
 * 链接预览（unfurl）：抓取目标网页的 OG / meta 元数据，供编辑器链接卡片展示。
 *
 * 安全与稳定性约束：
 * - 仅允许 http/https；拒绝 localhost / 内网 / 链路本地地址（基础 SSRF 防护）；
 * - 手动跟随重定向（每跳重新校验目标），最多 3 跳；
 * - 6s 超时；响应体最多读取 512KB（元数据都在 <head>，无需读完整个页面）。
 */

const TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 BobWork/1.0';

/** 内网 / 本机地址判定（含 IPv4 私有段、IPv6 本机与 ULA） */
function isBlockedHost(hostname: string): boolean {
  const h = (hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // IPv6 字面量（URL.hostname 会带方括号）
  if (h.startsWith('[')) {
    const bare = h.replace(/^\[|\]$/g, '');
    if (bare === '::1' || bare === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  }
  return false;
}

/** 基础 HTML 实体解码（元数据里最常见的几种） */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#0*160;/g, ' ')
    .replace(/&amp;/gi, '&');
}

/** 取标签内某属性的值（兼容单/双引号与无引号） */
function attrOf(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim();
}

function normalizeText(s: string, max = 400): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 汇总所有 <meta> 标签为 name/property → content 映射（先出现者优先） */
function collectMeta(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<meta\s+[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const key = attrOf(tag, 'property') || attrOf(tag, 'name') || attrOf(tag, 'itemprop');
    const content = attrOf(tag, 'content');
    if (!key || !content) continue;
    const k = key.toLowerCase();
    if (!map.has(k)) map.set(k, content);
  }
  return map;
}

/** <title> 兜底 */
function titleTag(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? normalizeText(m[1], 300) : '';
}

/** favicon：优先普通 icon，其次 apple-touch-icon */
function findIcon(html: string): string {
  const re = /<link\s+[^>]*>/gi;
  let m: RegExpExecArray | null;
  let fallback = '';
  while ((m = re.exec(html)) !== null) {
    const rel = attrOf(m[0], 'rel').toLowerCase();
    if (!rel.includes('icon')) continue;
    const href = attrOf(m[0], 'href');
    if (!href) continue;
    if (rel.includes('apple-touch')) {
      if (!fallback) fallback = href;
      continue;
    }
    return href;
  }
  return fallback;
}

/** 相对地址补全，并只接受 http/https（过滤 data: 等） */
function absolutize(url: string, base: string): string {
  if (!url) return '';
  try {
    const abs = new URL(url, base);
    return abs.protocol === 'http:' || abs.protocol === 'https:' ? abs.toString() : '';
  } catch {
    return '';
  }
}

/** 带体积上限的响应体读取（只需要 <head>，不必读完整个页面） */
async function readBodyCapped(resp: Response, max: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= max) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    out += decoder.decode();
  } catch {
    /* 读取中断：返回已获取部分 */
  }
  return out;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url') || '';
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ success: false, error: 'URL 非法' }, { status: 400 });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return NextResponse.json({ success: false, error: '仅支持 http/https' }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let current = target;
    let resp: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (isBlockedHost(current.hostname)) {
        return NextResponse.json({ success: false, error: '目标地址不允许访问' }, { status: 400 });
      }
      resp = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      });
      const location = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && location) {
        current = new URL(location, current);
        continue;
      }
      break;
    }

    if (!resp) {
      return NextResponse.json({ success: false, error: '请求失败' }, { status: 502 });
    }
    if (!resp.ok) {
      const msg = resp.status >= 300 && resp.status < 400 ? '重定向过多' : `目标返回 HTTP ${resp.status}`;
      return NextResponse.json({ success: false, error: msg }, { status: 502 });
    }
    const ctype = resp.headers.get('content-type') || '';
    if (ctype && !/text\/html|application\/xhtml\+xml/i.test(ctype)) {
      return NextResponse.json({ success: false, error: '目标不是网页' }, { status: 415 });
    }

    const html = await readBodyCapped(resp, MAX_BYTES);
    const meta = collectMeta(html);
    const finalUrl = current.toString();
    const title = normalizeText(meta.get('og:title') || meta.get('twitter:title') || '') || titleTag(html);
    const description = normalizeText(
      meta.get('og:description') || meta.get('twitter:description') || meta.get('description') || '',
    );
    const image = absolutize(meta.get('og:image') || meta.get('twitter:image') || '', finalUrl);
    const icon = absolutize(findIcon(html), finalUrl);
    const site = normalizeText(meta.get('og:site_name') || '', 100) || current.hostname.replace(/^www\./, '');

    return NextResponse.json({
      success: true,
      data: { url: finalUrl, title, description, image, icon, site },
    });
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? '抓取超时' : '抓取失败';
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
