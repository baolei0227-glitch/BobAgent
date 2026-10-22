/**
 * lib/http/plugin-web-proxy.ts — 插件自带网页的「宿主 origin 稳定反代」（纯 node，server-only）
 *
 * 为什么需要
 * ──────────
 * serve 形态的插件面板端口由宿主**按实例分配**，登记在 `lib/mcp/panel-ports.ts` 的
 * globalThis 表里 —— 宿主一重启端口就变（该表就是为此设计的，见其 §1 注释：避免同机
 * 并存两个宿主时 EADDRINUSE）。但 Hippo 原生书签（`browser-bookmarks.json`）持久的是
 * **一个 URL 字符串**：端口一变，书签就永久失效。
 *
 * 解法：让所有需要长期稳定的消费方（Hippo 书签）只记 **宿主 origin + 固定前缀**，
 * 由本模块把该前缀反代到运行时端口。宿主端口在打包版是常量 8321
 * （electron/main.ts:34-36），于是书签长期有效。
 *
 * 🔴 前缀「逐字透传」不重写
 * ──────────────────────
 * 插件是独立 Next 应用，产物里是绝对路径（`/_next/static/**`、`/api/**`）。挂在子路径下时
 * 只有让**插件自己构建时带 basePath = 本前缀**才成立；宿主侧任何 HTML/JS 内容重写都救不了
 * RSC flight 数据与动态拼串。
 *   ⇒ 所以本模块**原样转发 req.url**（含前缀），并把「插件 next.config 的 basePath」
 *     与「面板声明的 hostPath」的一致性作为一个**跨包不变量**交由
 *     `isDeclaredPluginWebPanel()` 在运行时守住 —— tsc 看不见这种跨包耦合。
 *
 * 为什么不写成 Next route handler
 * ─────────────────────────────
 * 本反代的负载是**大 body 双向流**：上行是视频文件（可达 GB），下行是 ZIP 导出。
 * `http.pipe` 两端都是原生流；换成 route handler 里的 fetch(duplex:'half') +
 * `new Response(stream)` 会引入 undici 的背压不确定性。因此挂在 `src/server.ts`
 * 的原生 HTTP 层（该文件在打包版里会覆盖 next-standalone/server.js，
 * 见 scripts/package-release.sh:340-350）。
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';

/** 插件自带网页的宿主路径前缀（唯一常量；插件侧 next.config 的 basePath 必须等于 前缀+id） */
export const PLUGIN_WEB_PREFIX = '/api/plugin-web/';

/** 插件 id 形状：首字符字母数字，其后允许字母数字与 . _ -（拒绝空段 / 穿越 / 编码绕过） */
const PLUGIN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * 从 pathname 解析插件 id（前缀后的首段）。
 * 无前缀、空前缀段、非法字符一律返回 null（调用方据此放行给 Next，不接管该请求）。
 */
export function pluginWebId(pathname: string): string | null {
  if (!pathname.startsWith(PLUGIN_WEB_PREFIX)) return null;
  const id = pathname.slice(PLUGIN_WEB_PREFIX.length).split('/')[0] ?? '';
  return PLUGIN_ID_RE.test(id) ? id : null;
}

/** 由插件 id 拼出宿主 origin 下的稳定前缀（无结尾斜杠，供书签 URL 使用） */
export function pluginWebBasePath(pluginId: string): string {
  return `${PLUGIN_WEB_PREFIX}${pluginId}`;
}

/**
 * 面板声明是否「合法声明了本反代」。纯函数，便于单测与运行时自守。
 *
 * 两条同时成立才算声明：hostPath 等于前缀+id、id 合法。
 *
 * 🔴 不限定托管形态（mode）：static 面板的 **UI** 由宿主静态托管（零端口），但它的
 * **API** 仍来自插件进程，且只能经本反代访问（插件端口随宿主启动时分配）—— 同样需要活的
 * 上游，故 mode 不能作为门禁。
 *
 * hostPath 必须与 id 严格对应（而不是任意外部前缀），是为了让「宿主前缀」与
 * 「插件 basePath / 挂载前缀」只有**一个**自由度 —— 否则两侧各写一个串，漂移后表现为
 * 页面能开、接口 404，极难定位。
 */
export function isDeclaredPluginWebPanel(
  panel: { mode?: string; hostPath?: string } | undefined,
  pluginId: string,
): boolean {
  if (!panel) return false;
  if (!PLUGIN_ID_RE.test(pluginId)) return false;
  return panel.hostPath === pluginWebBasePath(pluginId);
}

/** 反代目标解析结果（由调用方注入，便于把「查表 + 鉴权」与「管道」分开测） */
export type PluginWebResolution =
  | { kind: 'ok'; port: number; name: string }
  /** 插件声明了本反代但当前无活动实例（宿主重启后未启用 / 刚崩）—— 常态，不是错误 */
  | { kind: 'declared-not-running'; name: string }
  /** 该 id 未声明本反代 —— 返回 404，不暴露「哪些 id 存在」 */
  | { kind: 'not-declared' };

/** RFC 7230 §6.1 hop-by-hop 头：不得跨代理转发 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // host 必须重写（上游是 127.0.0.1:<动态端口>），不能透传宿主 origin
  'host',
]);

/** 过滤出可安全转发的头（保留多值头形态） */
export function filterForwardHeaders(
  headers: IncomingMessage['headers'],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** 插件未运行时的空态页：书签的生命周期长于插件进程，这是常态而非异常，必须可读可操作 */
export function pluginNotRunningHtml(pluginId: string, name?: string): string {
  const label = name || pluginId;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${label} 未运行</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
         background:#f7f7f8; color:#1d1d1f; }
  .card { width:min(420px,88vw); background:#fff; border:1px solid #ececef; border-radius:14px;
          padding:22px; box-shadow:0 6px 24px rgba(0,0,0,.06); }
  h1 { margin:0 0 8px; font-size:17px; }
  p { margin:0 0 6px; color:#5a5a60; }
  code { background:#f2f2f5; border-radius:4px; padding:1px 5px; font-size:13px; }
  ol { margin:8px 0 0; padding-left:20px; color:#5a5a60; }
  @media (prefers-color-scheme: dark) {
    body { background:#1c1c1e; color:#f2f2f7; }
    .card { background:#2c2c2e; border-color:#3a3a3c; box-shadow:none; }
    p, ol { color:#a1a1a6; } code { background:#3a3a3c; }
  }
</style></head>
<body><div class="card">
  <h1>${label} 未运行</h1>
  <p>本页由 BobWork 托管，插件进程当前没有活动实例（端口随宿主启动时分配，宿主重启后需重新启用）。</p>
  <ol>
    <li>回到 BobWork → Market / Installed → Plugins</li>
    <li>启用 <code>${pluginId}</code></li>
    <li>刷新本页</li>
  </ol>
</div></body></html>`;
}

export interface PluginWebProxyOptions {
  /** 解析反代目标（查表 + 声明校验由调用方完成） */
  resolve: (pluginId: string) => Promise<PluginWebResolution> | PluginWebResolution;
  /** 上游主机，默认 127.0.0.1（插件只监听回环） */
  upstreamHost?: string;
  /** 单次请求超时（ms）；0 = 不限（SSE / 长流必需）。默认 0 */
  timeoutMs?: number;
}

/** 写一个 JSON 响应（仅在尚未送出响应头时可用） */
function endJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * 处理插件自带网页反代。返回 true = 本请求已被接管（调用方不得再交给 Next）；
 * false = 路径不归属本反代（放行）。
 *
 * 必须在 Next 的 handle() **之前**调用：该前缀由宿主原生层独占。
 * 建议位置：`src/server.ts` 的 requireRemoteToken / 预览 origin 策略之后 ——
 * 这样反代自动继承远程访问鉴权，不必各写一套。
 */
export async function handlePluginWebProxy(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PluginWebProxyOptions,
): Promise<boolean> {
  const rawUrl = req.url || '/';
  const pathname = rawUrl.split('?')[0] ?? '';
  const pluginId = pluginWebId(pathname);
  if (!pluginId) return false;

  let target: PluginWebResolution;
  try {
    target = await opts.resolve(pluginId);
  } catch (e) {
    endJson(res, 502, { success: false, error: `plugin resolution failed: ${e instanceof Error ? e.message : String(e)}` });
    return true;
  }

  if (target.kind === 'not-declared') {
    endJson(res, 404, { success: false, error: `No plugin web panel declared for "${pluginId}"` });
    return true;
  }
  if (target.kind === 'declared-not-running') {
    if (res.headersSent) {
      res.end();
      return true;
    }
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '3');
    res.end(pluginNotRunningHtml(pluginId, target.name));
    return true;
  }

  const headers = filterForwardHeaders(req.headers);
  // 上游据此可生成正确的外部链接（插件自己不知道宿主 origin 与端口）
  headers['x-forwarded-host'] = String(req.headers.host ?? '');
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-prefix'] = pluginWebBasePath(pluginId);

  // SSE / 长流：两端都不设超时，否则默认的 requestTimeout 会在长连接上截断响应
  req.setTimeout(opts.timeoutMs ?? 0);
  res.setTimeout(opts.timeoutMs ?? 0);

  const upstream = httpRequest(
    {
      host: opts.upstreamHost ?? '127.0.0.1',
      port: target.port,
      method: req.method,
      // 🔴 逐字透传（含前缀）：插件自带 basePath == 本前缀，两侧同源
      path: rawUrl,
      headers,
    },
    (up) => {
      const out = filterForwardHeaders(up.headers);
      if (res.headersSent) {
        up.resume?.();
        return;
      }
      res.writeHead(up.statusCode ?? 502, out);
      // SSE 需要响应头**立即**送达浏览器，否则首个事件前事件源不会进入 open 状态
      res.flushHeaders?.();
      // 单向管道：零拷贝、不缓冲，SSE 天然可用
      up.pipe(res);
    },
  );

  upstream.on('error', (e) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    // 上游端口无监听（插件刚崩 / 自愈中）：与 declared-not-running 同语义 —— 503 引导页，
    // 而非 502 JSON（工单 P0-4：覆盖 resolve 探测缓存 TTL 窗口内的残留 ok）
    if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '3');
      res.end(pluginNotRunningHtml(pluginId, target.name));
      return;
    }
    endJson(res, 502, { success: false, error: `plugin upstream error: ${e.message}` });
  });
  // 浏览器提前关闭（用户切走标签）：立刻掐掉上游，别让插件侧留半截连接
  res.on('close', () => {
    if (!upstream.destroyed) upstream.destroy();
  });

  // 请求体同样是流：大视频上传不会被整体缓冲
  req.pipe(upstream);
  return true;
}
