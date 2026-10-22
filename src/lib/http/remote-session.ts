/**
 * 远程访问会话（2026-10-10 抽取）—— 原先这三段内联在 `src/server.ts` 里，
 * 只有自定义 server 入口能用；现在路由此类需要**复验**身份（见 loopback-guard 的 DNS-rebind 防护），
 * 所以抽成共享模块：server.ts 与 lib/http/loopback-guard.ts 共用同一份实现，避免参数漂移。
 *
 * 凭据模型（与 server.ts 网关一致）：
 *   - `Authorization: Bearer <token>`：Expo 壳 / curl / strict 模式
 *   - `bw_remote` Cookie = HMAC-SHA256(key=token, 'bw-remote-session-v1')：浏览器导航与子请求
 *   两种都可以；token 本体不出现在浏览器 JS 可读范围内（Cookie 是 httpOnly）。
 */

import { createHmac, timingSafeEqual } from 'crypto';

export const REMOTE_COOKIE = 'bw_remote';

/** Cookie 值 = HMAC-SHA256(key=token, 固定盐)；rotate token 即让已下发 Cookie 失效 */
export function expectedCookieValue(token: string): string {
  return createHmac('sha256', token).update('bw-remote-session-v1').digest('hex');
}

/** 从 Cookie 头里取出 bw_remote 的值 */
export function readRemoteCookie(cookieHeader: string | null | undefined): string {
  const raw = cookieHeader ?? '';
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === REMOTE_COOKIE) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/** 会话 Cookie 是否有效（定时安全比较） */
export function hasValidSessionCookie(cookieHeader: string | null | undefined, token: string): boolean {
  const got = readRemoteCookie(cookieHeader);
  if (!got || !token) return false;
  const want = expectedCookieValue(token);
  try {
    return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'));
  } catch {
    return false;
  }
}

/** `Authorization: Bearer <token>` 是否有效 */
export function hasValidBearerAuth(authHeader: string | null | undefined, token: string): boolean {
  const auth = authHeader ?? '';
  if (!auth.startsWith('Bearer ') || !token) return false;
  const got = auth.slice(7);
  try {
    return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(token, 'utf8'));
  } catch {
    return false;
  }
}

/** Bearer 或会话 Cookie 任一有效即通过 */
export function hasValidRemoteAuth(
  headers: { authorization?: string | null; cookie?: string | null },
  token: string,
): boolean {
  if (!token) return false;
  return hasValidBearerAuth(headers.authorization, token) || hasValidSessionCookie(headers.cookie, token);
}
