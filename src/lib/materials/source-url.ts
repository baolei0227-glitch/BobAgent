/**
 * 研究来源 URL 归一化（候选来源清单与正文链接标注**共用同一份实现**）。
 *
 * 必须共用：清单侧用归一化后的键去重，正文侧用归一化后的键去匹配回答里写的链接；
 * 两处若各写一份，规则一漂移就会出现「清单里有、正文里的同一链接却匹配不上」的静默失效。
 *
 * 规则：只认 http/https；去 hash；去跟踪参数；去尾斜杠 —— 同一页面的不同入口只留一条。
 */
export function normalizeSourceUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  for (const k of Array.from(u.searchParams.keys())) {
    if (/^(utm_|fbclid$|gclid$|spm$|ref$|share_|from$)/.test(k)) u.searchParams.delete(k);
  }
  if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}
