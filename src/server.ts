import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import { parse } from 'url';
import { readFileSync, watch } from 'fs';
import { networkInterfaces } from 'node:os';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import next from 'next';

// 打包版由 Electron 以 NODE_ENV=production 启动（不设 COZE_PROJECT_ENV）：
// 只判 COZE_PROJECT_ENV 会把打包版误认成 dev，届时 Next 会去现场编译已被打包脚本删掉的 src/。
const dev = process.env.NODE_ENV !== 'production' && process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '5000', 10);

/* ────────────────────────────────────────────────────────────
 * CalDAV 自定义 HTTP 方法支持
 * Next.js App Router 仅支持 GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD，
 * CalDAV 需要 PROPFIND / REPORT / MKCOL / MOVE / COPY / LOCK / UNLOCK。
 * 在原生 HTTP server 层面拦截这些方法，直接交给我们的 CalDAV handler。
 * ──────────────────────────────────────────────────────────── */

const CALDAV_PATH_PREFIX = '/api/dav';
const CALDAV_METHODS = ['PROPFIND', 'REPORT', 'MKCOL', 'MOVE', 'COPY', 'LOCK', 'UNLOCK', 'PATCH'] as const;
type CalDavMethod = typeof CALDAV_METHODS[number];

function isCalDavMethod(method: string): method is CalDavMethod {
  return CALDAV_METHODS.includes(method as CalDavMethod);
}

function isCalDavUrl(url: string): boolean {
  return url.startsWith(CALDAV_PATH_PREFIX);
}

/** 在原生 HTTP server 中处理 CalDAV 自定义方法 */
async function handleCalDavRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!req.method || !isCalDavMethod(req.method)) return false;
  if (!isCalDavUrl(req.url || '')) return false;

  try {
    // 读取请求体
    let body = '';
    if (['PROPFIND', 'REPORT', 'PATCH'].includes(req.method)) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      body = Buffer.concat(chunks).toString('utf-8');
    }

    // 转发到 CalDAV handler
    const { handleDavRequest } = await import('@/lib/calendar/dav-server');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers[key] = Array.isArray(value) ? value[0]! : value;
    }

    const response = await handleDavRequest({
      method: req.method,
      url: req.url || '',
      headers,
      body: body || undefined,
    });

    // 写入响应
    res.statusCode = response.status;
    for (const [key, value] of Object.entries(response.headers)) {
      res.setHeader(key, value);
    }
    if (response.body) {
      res.end(response.body);
    } else {
      res.end();
    }

    return true;
  } catch (err) {
    console.error('[CalDAV] Error handling request:', req.method, req.url, err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('CalDAV server error');
    return true;
  }
}

// 后台日历同步 worker：每 5 分钟遍历所有项目同步启用的日历账户（CalDAV / WebCal）
// 通过全局标记避免 dev 热重载时重复注册多个 interval。
declare global {
  // eslint-disable-next-line no-var
  var __calendarSyncWorkerStarted__: boolean | undefined;
}
async function startCalendarSyncWorker() {
  if (globalThis.__calendarSyncWorkerStarted__) return;
  globalThis.__calendarSyncWorkerStarted__ = true;
  const { syncAllProjects } = await import('@/lib/calendar/sync-runner');
  const run = async () => {
    try {
      const res = await syncAllProjects();
      if (res.length) console.log('[calendar-sync] background sync done:', res);
    } catch (e) {
      console.error('[calendar-sync] background sync error:', e);
    }
  };
  // 启动后先跑一次，之后再每 5 分钟
  await run();
  setInterval(run, 5 * 60 * 1000).unref();
}

// ────────────────────────────────────────────────────────────
// 远程访问鉴权网关
// 手机经私有隧道远程操作本机 BobWork 时，非本机请求必须持 Bearer Token。
// 桌面端（localhost / loopback）默认豁免，确保现有桌面体验不受影响。
// 配置来自 ~/BobWork/.settings.json 的 remoteAccess 字段；文件变更经 fs.watch 热更新。
// ────────────────────────────────────────────────────────────
interface RemoteAccessState {
  enabled: boolean;
  token: string;
  mode: 'loopback-exempt' | 'strict';
}
let remoteAccessCache: RemoteAccessState = { enabled: false, token: '', mode: 'loopback-exempt' };

function loadRemoteAccess(): void {
  try {
    const raw = readFileSync(join(resolveAppRoot(), '.settings.json'), 'utf-8');
    const cfg = JSON.parse(raw) as { remoteAccess?: Partial<RemoteAccessState> };
    const ra = cfg.remoteAccess;
    remoteAccessCache = {
      enabled: !!ra?.enabled,
      token: typeof ra?.token === 'string' ? ra.token : '',
      mode: ra?.mode === 'strict' ? 'strict' : 'loopback-exempt',
    };
  } catch {
    remoteAccessCache = { enabled: false, token: '', mode: 'loopback-exempt' };
  }
}
loadRemoteAccess();
try {
  watch(join(resolveAppRoot(), '.settings.json'), () => loadRemoteAccess());
} catch {
  /* 配置文件尚未创建时不监听 */
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr === 'localhost'
  );
}

/**
 * 本机所有网卡地址（含 Tailscale / 局域网等虚拟网卡）。
 *
 * 为什么需要：远程访问时「手机发起 → Next 路由 → 服务端内部再 fetch /api/chat」这一步，
 * baseUrl 取的是 `new URL(request.url).origin`，即**本机的隧道 IP**（如 100.x）而不是 localhost。
 * 这条自调用的 remoteAddress 因此是本机隧道 IP、过不了 isLoopback，会被自己的网关 401
 * —— 表现为手机端对话提示 unauthorized，而桌面走 localhost 一切正常。
 * 把「本机自有地址」也视同 loopback 放行即可；其他设备（手机的隧道 IP）不在本机网卡列表里，
 * 仍照常鉴权，安全性不受影响。
 */
let selfAddrCache: { at: number; addrs: Set<string> } = { at: 0, addrs: new Set() };
/** 缓存 TTL：网卡地址基本不变，又不能让「应用先起、Tailscale 后连」的隧道 IP 缺席 */
const SELF_ADDR_TTL = 60_000;

function selfAddresses(): Set<string> {
  const now = Date.now();
  if (now - selfAddrCache.at < SELF_ADDR_TTL) return selfAddrCache.addrs;
  const addrs = new Set<string>();
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) if (ni.address) addrs.add(ni.address);
    }
  } catch {
    /* 取不到网卡信息时退化为仅 loopback 豁免 */
  }
  selfAddrCache = { at: now, addrs };
  return addrs;
}

/** 去掉 IPv4-mapped IPv6 前缀（dual-stack socket 上 IPv4 连接会带 `::ffff:`） */
function normalizeAddr(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** 是否为本机自身发起的请求（loopback 或本机任一网卡地址） */
function isSelfRequest(addr: string | undefined): boolean {
  if (!addr) return false;
  if (isLoopback(addr)) return true;
  return selfAddresses().has(normalizeAddr(addr));
}

/* ────────────────────────────────────────────────────────────
 * Cookie 会话（让浏览器 / PWA 也能通过鉴权）
 *
 * 为什么需要：浏览器发起的**导航请求**（window.open / location / <a>）无法
 * 携带 Authorization 头，因此只认 Bearer 会让 Safari、以及「添加到主屏幕」的
 * PWA 直接被挡在 401 —— 而这正是自用最省事的访问方式（无需 Xcode / $99）。
 *
 * 做法：一次性登录页提交 token → 校验通过 → 下发 httpOnly 会话 Cookie。
 * Cookie 值 = HMAC-SHA256(key=token, 'bw-remote-session-v1')，**不落任何服务端会话表**：
 *   · rotate token 会自动让已下发的 Cookie 失效（派生值变了），无需维护黑名单
 *   · httpOnly + SameSite=Lax：token 本身不出现在浏览器 JS 可读范围内
 * ──────────────────────────────────────────────────────────── */
const REMOTE_COOKIE = 'bw_remote';
const LOGIN_PATH = '/remote-login';
const LOGIN_API = '/api/remote-access/login';

function expectedCookieValue(token: string): string {
  return createHmac('sha256', token).update('bw-remote-session-v1').digest('hex');
}

function readRemoteCookie(req: IncomingMessage): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== REMOTE_COOKIE) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/** Cookie 是否有效：与「当前 token 的派生值」一致才算数（rotate 自动失效）。 */
function hasValidSessionCookie(req: IncomingMessage, token: string): boolean {
  const got = readRemoteCookie(req);
  if (!got) return false;
  const want = expectedCookieValue(token);
  try {
    return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'));
  } catch {
    return false;
  }
}

/** 返回 true = 放行；false = 已写响应并结束。 */
function requireRemoteToken(req: IncomingMessage, res: ServerResponse): boolean {
  const ra = remoteAccessCache;
  if (!ra.enabled || !ra.token) return true; // 未启用 → 放行（含桌面本地）
  const needAuth = ra.mode === 'strict' ? true : !isSelfRequest(req.socket?.remoteAddress);
  if (!needAuth) return true; // 本机豁免（loopback + 本机网卡地址：服务端内部自调用经隧道 IP 回环）
  // ① Bearer 头：Expo 壳 / curl / strict 模式下 electron 网络层注入
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ') && auth.slice(7) === ra.token) return true;

  // ② 会话 Cookie：浏览器导航请求带不了 Authorization 头，只能靠它
  if (hasValidSessionCookie(req, ra.token)) return true;

  // ③ 都不过：浏览器文档导航送去登录页（这是 PWA 免安装方式的唯一可行入口），其余返 401
  const url = (req.url || '').split('?')[0];
  if (
    req.method === 'GET' &&
    (req.headers.accept || '').includes('text/html') &&
    url !== LOGIN_PATH
  ) {
    res.statusCode = 302;
    res.setHeader('Location', LOGIN_PATH);
    res.end();
    return false;
  }

  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: false, error: 'unauthorized' }));
  return false;
}

/** 登录页：极简自包含表单，不依赖 Next，便于在鉴权未通过时也能渲染。 */
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>BobWork 远程登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
         background:#f7f7f8; color:#1d1d1f; }
  .card { width:min(360px,88vw); background:#fff; border:1px solid #ececef; border-radius:14px;
          padding:22px; box-shadow:0 6px 24px rgba(0,0,0,.06); }
  h1 { margin:0 0 6px; font-size:19px; }
  p { margin:0 0 16px; color:#6b6b70; font-size:13px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; font-size:15px;
          border:1px solid #d8d8dd; border-radius:9px; background:#fbfbfc; }
  input:focus { outline:2px solid #6c5ce7; outline-offset:1px; }
  button { margin-top:12px; width:100%; padding:11px; font-size:15px; color:#fff;
           background:#6c5ce7; border:0; border-radius:9px; }
  .err { margin-top:10px; color:#c0392b; font-size:13px; min-height:1em; }
</style>
</head>
<body>
  <form class="card" id="f">
    <h1>BobWork 远程访问</h1>
    <p>请输入桌面端「Settings → Remote Access」生成的 Token</p>
    <input id="t" name="token" type="password" placeholder="Access Token"
           autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
    <button type="submit">登录</button>
    <div class="err" id="e"></div>
  </form>
<script>
  document.getElementById('f').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var t = document.getElementById('t').value.trim();
    var e = document.getElementById('e');
    e.textContent = '';
    if (!t) { e.textContent = '请输入 Token'; return; }
    try {
      var r = await fetch('${LOGIN_API}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t })
      });
      if (r.ok) { window.location.replace('/butler'); return; }
      e.textContent = r.status === 401 ? 'Token 不正确' : '登录失败（' + r.status + '）';
    } catch (err) { e.textContent = '网络错误，请检查隧道连接'; }
  });
</script>
</body>
</html>`;

/**
 * 处理 GET /remote-login（登录页）与 POST /api/remote-access/login（换 Cookie）。
 * 必须在鉴权网关之前调用，否则登录入口自身会被 401 拦截形成死循环。
 * 返回 true = 已响应，调用方应 return。
 */
async function handleRemoteLogin(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url || '').split('?')[0];
  if (url !== LOGIN_PATH && url !== LOGIN_API) return false;

  const ra = remoteAccessCache;
  if (!ra.enabled || !ra.token) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('远程访问未启用，或尚未生成 Token（桌面端 Settings → Remote Access 开启）');
    return true;
  }

  if (url === LOGIN_PATH && req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(LOGIN_HTML);
    return true;
  }

  if (url === LOGIN_API && req.method === 'POST') {
    // 读取并限制 body 大小（防御性：避免无界缓冲）
    let raw = '';
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        chunks.push(buf);
        if (size > 8192) break;
      }
      raw = Buffer.concat(chunks).toString('utf-8');
    } catch {
      raw = '';
    }

    let submitted = '';
    try {
      const parsed = JSON.parse(raw) as { token?: string };
      submitted = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    } catch {
      // 也容忍 application/x-www-form-urlencoded
      const m = /(?:^|&)token=([^&]*)/.exec(raw);
      submitted = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() : '';
    }

    if (!submitted || submitted !== ra.token) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'invalid token' }));
      return true;
    }

    res.statusCode = 200;
    // Max-Age：会话 Cookie 在 iOS「添加到主屏幕」的独立 Web App 里会随进程退出被清掉，
    // 每次打开都要重登。这里给 180 天持久化；rotate token 会让派生值失配而等效吊销，无黑名单负担。
    const COOKIE_MAX_AGE = 180 * 24 * 60 * 60;
    res.setHeader(
      'Set-Cookie',
      `${REMOTE_COOKIE}=${expectedCookieValue(ra.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
    );
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  res.statusCode = 405;
  res.setHeader('Allow', url === LOGIN_PATH ? 'GET' : 'POST');
  res.end();
  return true;
}

/* ────────────────────────────────────────────────────────────
 * standalone 配置还原
 *
 * 打包版把本入口放在 next-standalone/server.js 的位置上。Next 官方生成的那个 wrapper
 * 会把构建期配置序列化进 __NEXT_PRIVATE_STANDALONE_CONFIG 再交给 next()；自定义入口必须
 * 做同样的事 —— 打包脚本会删掉 next.config.ts，缺了它 Next 退回默认配置
 * （images.remotePatterns、experimental 等全部丢失）。
 * 非 standalone 布局（dev / 云端部署）读不到该文件，静默跳过。
 * ──────────────────────────────────────────────────────────── */
if (!dev && !process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
  try {
    const required = JSON.parse(
      readFileSync(join(process.cwd(), '.next', 'required-server-files.json'), 'utf-8'),
    ) as { config?: Record<string, unknown> };
    if (required.config) {
      process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(required.config);
    }
  } catch {
    /* 无该文件 = 非 standalone 布局，忽略 */
  }
}

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  startCalendarSyncWorker();
  const server = createServer(async (req, res) => {
    try {
      // 登录端点必须先于网关处理，否则会被自身的 401 拦截，形成无法登录的死循环
      if (await handleRemoteLogin(req, res)) return;
      // 远程访问鉴权网关：非本机 + 启用时要求 Bearer 或会话 Cookie（桌面 localhost 豁免；CalDAV 一并受保护）
      if (!requireRemoteToken(req, res)) return;
      // 优先检查 CalDAV 自定义方法
      if (req.method && isCalDavMethod(req.method) && isCalDavUrl(req.url || '')) {
        const handled = await handleCalDavRequest(req, res);
        if (handled) return;
      }

      // 常规请求交给 Next.js
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
  server.once('error', err => {
    console.error(err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${
        dev ? 'development' : process.env.COZE_PROJECT_ENV
      }`,
    );
    console.log(`> CalDAV server available at http://${hostname}:${port}${CALDAV_PATH_PREFIX}/`);
  });
});
