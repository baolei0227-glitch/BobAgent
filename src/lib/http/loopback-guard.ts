/**
 * 本机来源闸（2026-10-10，评估 A3）—— 给「小程序相关」的服务端路由用。
 *
 * 背景：`/api/sandbox/bridge`、`/api/sandbox/chat-stream`、`/api/sandbox`、`/api/sandbox/import`、
 * `/api/sandbox/export` 自身没有任何来源校验，而 dev/packaged 服务监听在所有网卡（`*:8321`）。
 * 只有 `/api/settings` 做了 loopback Host 闸。放开小程序权限后，bridge 直通 `run_command` ——
 * 于是「默认未启用远程访问的安装」= 同网段任何设备可无鉴权 RCE。
 *
 * 本闸的三条规则：
 *   1. `Sec-Fetch-Site: cross-site` 一律拒（浏览器强制信号，挡住普通 CSRF）。
 *   2. `Origin` 必须是本机来源（loopback / 本机网卡地址）；远程访问开启时才额外放行
 *      `Origin === Host`（Tailscale / Cloudflare 隧道域名走这条）。
 *   3. Host 不是本机来源时，必须已启用远程访问（此时 `src/server.ts` 的网关已要求 Bearer/Cookie）——
 *      未启用远程访问的安装一律拒绝，堵住局域网直打。
 *
 * 2026-10-10 二轮：封 DNS-rebind。非本机 Host 一律**在路由层复验** Bearer / 会话 Cookie
 * （DNS rebinding 时 `remoteAddress` 是 loopback，网关会豁免它，所以只能在这里验）：
 *   - 本机桌面（Host = localhost / 127.0.0.1 / 本机网卡 IP）→ 不要求 Token（与网关一致）
 *   - 隧道域名（Host = bob.example.com）→ 必须带有效 Bearer 或会话 Cookie
 * 攻击者页面既拿不到 token，也拿不到 httpOnly Cookie，因此过不了这道闸。
 */

import { networkInterfaces } from 'os';
import type { NextRequest } from 'next/server';
import { readSettingsFromFile } from '@/lib/settings-server';
import { hasValidRemoteAuth } from './remote-session';

export interface SourceCheckInput {
  host: string;
  origin: string;
  secFetchSite: string;
  method: string;
  /** 是否已启用远程访问（启用 = 网关已对非本机来源要求 Token） */
  remoteAccessEnabled: boolean;
  /** 本机所有网卡地址（含 Tailscale 等虚拟网卡） */
  localAddrs: Set<string>;
  /** 远程访问 token（用于非本机 Host 的身份复验）；未启用时为空 */
  remoteToken?: string;
  /** 原始 Authorization / Cookie 头（复验用） */
  authorization?: string | null;
  cookie?: string | null;
  /**
   * 只读预览页专用：允许 GET/HEAD 的 cross-site iframe 导航。
   * 宿主 UI（localhost）与应用内预览（127.0.0.1）故意用两个 hostname 做存储隔离，
   * 浏览器因此把 iframe 入口导航标成 cross-site；该路由只返回小程序 HTML，
   * 且 CSP frame-ancestors 已限制只有回环宿主可嵌入。写操作仍一律拒绝。
   */
  allowCrossSiteRead?: boolean;
}

export interface SourceCheckResult {
  ok: boolean;
  reason?: string;
}

/** 从 Host 头 / Origin / URL 里取出 hostname（小写，去端口） */
export function hostnameOf(value: string | null | undefined): string {
  const v = String(value ?? '').trim();
  if (!v || v === 'null') return '';
  try {
    const url = v.includes('://') ? new URL(v) : new URL(`http://${v}`);
    return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

function isLoopbackName(h: string): boolean {
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.');
}

/** 纯函数：判断请求来源是否可信（抽出来便于单测，避免依赖真实网络环境） */
export function checkRequestSource(input: SourceCheckInput): SourceCheckResult {
  const host = hostnameOf(input.host);
  const hostIsLocal = !host || isLoopbackName(host) || input.localAddrs.has(host);

  // 规则 1：浏览器明确标记跨站
  // 例外：只读预览页的 iframe 入口导航。宿主与预览是两个回环 hostname（localhost ↔ 127.0.0.1），
  // 浏览器按站点定义判 cross-site；该页只读且 CSP frame-ancestors 只允许回环宿主嵌入。
  if (input.secFetchSite.toLowerCase() === 'cross-site') {
    const readOnly = input.method === 'GET' || input.method === 'HEAD';
    if (!(input.allowCrossSiteRead === true && readOnly)) {
      return { ok: false, reason: 'cross-site request (Sec-Fetch-Site)' };
    }
  }

  // 规则 2：Origin 必须是本机来源（或远程访问下的同源隧道域名）
  const rawOrigin = String(input.origin ?? '').trim();
  if (rawOrigin === 'null') {
    // sandboxed iframe / file:// 场景：只读放行，写操作拒绝
    if (input.method !== 'GET' && input.method !== 'HEAD') {
      return { ok: false, reason: 'null origin on a state-changing request' };
    }
  } else if (rawOrigin) {
    const originHost = hostnameOf(rawOrigin);
    if (!originHost) return { ok: false, reason: `untrusted origin: ${rawOrigin}` };
    const originIsLocal = isLoopbackName(originHost) || input.localAddrs.has(originHost);
    const sameAsHostTunnel = input.remoteAccessEnabled && originHost === host;
    if (!originIsLocal && !sameAsHostTunnel) {
      return { ok: false, reason: `untrusted origin: ${originHost}` };
    }
  }

  // 规则 3：非本机 Host —— 必须已启用远程访问，且**在路由层复验** Bearer / 会话 Cookie。
  // 这一步专治 DNS rebinding：攻击者域名解析到 127.0.0.1 时 remoteAddress 是 loopback，
  // server.ts 的网关按"本机豁免"放行，只有这里复验身份才能挡住。
  if (!hostIsLocal) {
    if (!input.remoteAccessEnabled) {
      return { ok: false, reason: `non-local host "${host}" while remote access is disabled` };
    }
    if (!input.remoteToken) {
      return { ok: false, reason: 'remote access token unavailable' };
    }
    if (!hasValidRemoteAuth({ authorization: input.authorization, cookie: input.cookie }, input.remoteToken)) {
      return { ok: false, reason: `non-local host "${host}" without valid remote credentials` };
    }
  }

  return { ok: true };
}

function localAddresses(): Set<string> {
  const out = new Set<string>();
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        if (!ni?.address) continue;
        const addr = ni.address.startsWith('::ffff:') ? ni.address.slice(7) : ni.address;
        out.add(addr.toLowerCase());
      }
    }
  } catch { /* 取不到网卡信息时仅认 loopback */ }
  return out;
}

let cache: { at: number; addrs: Set<string>; remoteAccessEnabled: boolean; remoteToken: string } | null = null;
const TTL_MS = 5_000;

async function envSnapshot(): Promise<{ addrs: Set<string>; remoteAccessEnabled: boolean; remoteToken: string }> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache;
  const settings = await readSettingsFromFile().catch(() => null);
  const ra = settings?.remoteAccess;
  const remoteAccessEnabled = !!(ra?.enabled && ra?.token);
  const value = { at: now, addrs: localAddresses(), remoteAccessEnabled, remoteToken: ra?.token ?? '' };
  cache = value;
  return value;
}

/** 路由用：来源不可信时返回 403 Response，可信返回 null。 */
export async function guardRequestSource(
  request: NextRequest,
  opts?: { allowCrossSiteRead?: boolean },
): Promise<Response | null> {
  const { addrs, remoteAccessEnabled, remoteToken } = await envSnapshot();
  const result = checkRequestSource({
    host: request.headers.get('host') ?? '',
    origin: request.headers.get('origin') ?? '',
    secFetchSite: request.headers.get('sec-fetch-site') ?? '',
    method: request.method || 'GET',
    remoteAccessEnabled,
    localAddrs: addrs,
    remoteToken,
    authorization: request.headers.get('authorization'),
    cookie: request.headers.get('cookie'),
    allowCrossSiteRead: opts?.allowCrossSiteRead === true,
  });
  if (result.ok) return null;
  return Response.json(
    { success: false, error: `forbidden: ${result.reason}` },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  );
}
