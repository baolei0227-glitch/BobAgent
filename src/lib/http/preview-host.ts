/**
 * 预览 origin 策略（2026-10-10 同源隔离 A 方案）—— 纯函数，便于单测；由 `src/server.ts` 调用。
 *
 * 背景：桌面宿主 UI 固定跑在 `http://localhost:PORT`，小程序预览固定跑在 `http://127.0.0.1:PORT`。
 * 两者是**不同 origin**，于是预览页（= 第三方/AI 生成的小程序代码）再也读不到宿主的
 * localStorage / sessionStorage / Cookie。
 *
 * 但两个主机名仍指向同一个进程、同一套路由，所以再补一条「预览 origin 上的路由限制」：
 *   1. deny：宿主"拿到就等于控制整机/密钥"的高危 API（denylist，只列crown jewels，避免误伤日历等集成）；
 *   2. redirect：用 127.0.0.1 打开 UI 的 HTML 导航 → 302 回 localhost（书签友好、自愈）；
 *   3. 其余放行：`/api/sandbox/**`（预览与桥）、`/api/dav/**`（系统日历订阅）、静态资源等。
 */

import { hostnameOf } from './loopback-guard';

/**
 * 预览 origin 上禁止的宿主 API 前缀（denylist）。
 * 判断标准：泄露密钥、可执行任意本地操作、可改全局配置、可驱动宿主 agent。
 * 故意**不**包含 `/api/dav`（用户可能已用 127.0.0.1 订阅系统日历）、`/api/sandbox`（小程序自己的通道）。
 */
export const PREVIEW_HOST_DENIED_PREFIXES: readonly string[] = [
  '/api/settings',       // 全局设置与密钥（已脱敏，但仍可改配置）
  '/api/local-files',    // 任意本地文件读写与目录授权
  '/api/chat',           // 宿主 AI agent（带全套工具）
  '/api/bobby',          // 本机软件操控
  '/api/mcp',            // MCP 服务管理与工具调用
  '/api/extensions',     // 扩展管理
  '/api/plugin-panel',   // 插件面板宿主页
  '/api/plugin-panels',  // 插件面板注册表
  '/api/remote-access',  // 远程访问 token 管理（登录端点也不该在预览 origin 暴露）
  '/api/agents',         // agent 画像与市场包安装
  '/api/skills',         // 技能安装/卸载（会被 agent 加载）
  '/api/setup',          // 首次运行向导（可写配置）
];

/** host 头是否指向"预览 origin"（IPv4/IPv6 回环字面量，不含 localhost） */
export function isPreviewHostname(hostname: string): boolean {
  const h = (hostname || '').toLowerCase();
  return h === '127.0.0.1' || h.startsWith('127.') || h === '::1';
}

/** CalDAV 只读方法：在小程序预览 origin 上放行（日历"拉取"不受影响） */
export const DAV_READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT']);

/**
 * 纯函数：预览 origin 上的 DAV 方法策略。
 * 只读放行；写方法（PUT/DELETE/MKCOL/MOVE/COPY/PROPPATCH/LOCK/POST/PATCH…）默认拒绝 ——
 * 小程序代码不该能改用户的系统日历。宿主 origin（localhost）不受影响。
 */
export function decideDavOnPreviewHost(input: {
  host: string;
  method: string;
  /** 逃生开关（settings.calendarDavWritableOnPreviewHost） */
  allowWrite?: boolean;
}): PreviewHostDecision {
  const hostname = hostnameOf(input.host);
  if (!isPreviewHostname(hostname)) return { action: 'allow' };
  const method = String(input.method || 'GET').toUpperCase();
  if (input.allowWrite) return { action: 'allow' };
  if (DAV_READ_METHODS.has(method)) return { action: 'allow' };
  return {
    action: 'deny',
    message:
      `CalDAV ${method} is disabled on the mini-program preview origin (127.0.0.1). `
      + 'Mini-programs must not modify your calendar. If your calendar client is subscribed via 127.0.0.1, '
      + 're-subscribe using http://localhost:<port>/api/dav/… to restore two-way sync '
      + '(or set calendarDavWritableOnPreviewHost=true in settings.json to allow it again).',
  };
}

let davOverrideCache: { at: number; value: boolean } | null = null;
/** 读取逃生开关（5s 缓存，避免每个 DAV 请求都读设置文件） */
export async function davWriteAllowedOnPreviewHost(): Promise<boolean> {
  const now = Date.now();
  if (davOverrideCache && now - davOverrideCache.at < 5_000) return davOverrideCache.value;
  const { readSettingsFromFile } = await import('@/lib/settings-server');
  const settings = await readSettingsFromFile().catch(() => null);
  const value = settings?.calendarDavWritableOnPreviewHost === true;
  davOverrideCache = { at: now, value };
  return value;
}

export interface PreviewHostDecision {
  action: 'allow' | 'deny' | 'redirect';
  /** deny 时的说明 */
  message?: string;
  /** redirect 时的目标绝对地址 */
  location?: string;
}

/** 纯函数：给定请求（Host / pathname / Accept），决定放行、拒绝还是重定向回宿主 UI */
export function decidePreviewHostRequest(input: {
  host: string;
  pathname: string;
  accept?: string;
  /** 宿主端口（用于拼重定向地址） */
  port?: string;
}): PreviewHostDecision {
  const hostname = hostnameOf(input.host);
  if (!isPreviewHostname(hostname)) return { action: 'allow' };
  const pathname = input.pathname || '/';

  if (PREVIEW_HOST_DENIED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p))) {
    return {
      action: 'deny',
      message:
        `${pathname} is not available on the mini-program preview origin (127.0.0.1). `
        + 'Mini-programs must use the BobWork bridge (BobWork.request / BobWork.host) instead of host APIs. '
        + 'Open the BobWork UI at http://localhost:<port>.',
    };
  }

  // UI 路由的 HTML 导航 → 回 localhost（自愈，不需要用户记端口以外的差异）
  const accept = String(input.accept ?? '');
  if (accept.includes('text/html') && !pathname.startsWith('/api/') && !pathname.startsWith('/_next/')) {
    const port = input.port ? `:${input.port}` : '';
    return { action: 'redirect', location: `http://localhost${port}${pathname}` };
  }

  return { action: 'allow' };
}
