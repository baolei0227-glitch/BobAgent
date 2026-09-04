import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import next from 'next';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
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

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  startCalendarSyncWorker();
  const server = createServer(async (req, res) => {
    try {
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
