/**
 * plugin-web-proxy 单测（Step 0：先证反代通路，再谈插件改造）
 *
 * 为什么用「假上游 + 真 socket」而不是直接起宿主：
 *  1. 与 5379 行的插件改造完全解耦 —— 反代若有问题，本测试失败；反代无辜，本测试通过。
 *     避免拿插件去验反代、再拿反代去验插件（两个候选互比的循环论证）。
 *  2. 判据可以做成**真的能失败**：SSE 那条带一个「缓冲版反代」负对照，若断言对缓冲版
 *     也成立，说明判据平凡为真 ⇒ 整轮作废（本仓已踩过同类坑）。
 *
 * 覆盖：前缀解析 / 声明自守 / 头过滤 / 逐字透传 / 大 body / SSE 不缓冲 / 404 与 503 空态 /
 * 上游端口无监听 ⇒ 503 引导页（工单 P0-4：ECONNREFUSED 与「未运行」同语义）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PLUGIN_WEB_PREFIX,
  pluginWebId,
  pluginWebBasePath,
  isDeclaredPluginWebPanel,
  filterForwardHeaders,
  handlePluginWebProxy,
  type PluginWebResolution,
} from './plugin-web-proxy';

const PLUGIN_ID = 'bob-video-shot-mcp';
const BASE = `${PLUGIN_WEB_PREFIX}${PLUGIN_ID}`;

/** 必须在事件循环里真正 listen(0) 拿端口：写死端口会让测试互相干扰或静默连错进程 */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 被测宿主：只挂反代分支，其余路径标记为放行（模拟 server.ts 交给 Next） */
function startProxy(resolve: (id: string) => PluginWebResolution): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    void handlePluginWebProxy(req, res, { resolve }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('PASSTHROUGH');
      }
    });
  });
  return listen(server).then((port) => ({ server, port }));
}

/** 上一轮上游实际收到的请求路径（断言「逐字透传」用） */
let lastUpstreamPath = '';
/** 上一轮上游实际收到的 body 字节数 */
let lastUpstreamBytes = 0;

/**
 * 假上游：状态端点 / SSE / 大 body 回声 / 简单页面 —— 一次把四条通路都备好。
 *
 * ⚠️ 上游必须**自己剥掉宿主前缀**：宿主是逐字透传的，真实插件之所以能正确路由，
 * 是因为它自带 basePath == 宿主前缀（Next 内部会剥）。假上游若按无前缀路径匹配，
 * 就会 404/落到 fallback —— 那是测试模型的错，不是反代的。
 */
function startFakeUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastUpstreamPath = req.url || ''; // 断言「逐字透传」用完整 url
    const raw = (req.url || '/').split('?')[0] ?? '/';
    const pathname = raw.startsWith(BASE) ? (raw.slice(BASE.length) || '/') : raw;
    let bytes = 0;
    req.on('data', (c: Buffer) => { bytes += c.length; });
    req.on('end', () => {
      lastUpstreamBytes = bytes;
      if (pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, plugin: PLUGIN_ID }));
        return;
      }
      // SSE：首帧立即发，其后每 150ms 一帧，共 4 帧（≈450ms 跨度）
      if (pathname === '/api/sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.flushHeaders?.();
        let n = 0;
        res.write(`data: frame-${++n}\n\n`);
        const timer = setInterval(() => {
          if (++n > 4) { clearInterval(timer); res.end(); return; }
          res.write(`data: frame-${n}\n\n`);
        }, 150);
        // ⚠️ 必须挂在**响应**上：GET 无 body，IncomingMessage 的 'close' 会在请求收完后
        // 立即触发（而非连接断开时），挂 req 会导致只发出首帧就清掉定时器、响应永不结束。
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (pathname === '/api/echo' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bytes }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><h1>fake plugin @ ${req.url}</h1>`);
    });
  });
  return listen(server).then((port) => ({ server, port }));
}

/** 裸 GET，返回 {status, body, contentType, retryAfter} */
function get(url: string): Promise<{ status: number; body: string; contentType: string; retryAfter?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body,
        contentType: String(res.headers['content-type'] ?? ''),
        retryAfter: res.headers['retry-after'] === undefined ? undefined : String(res.headers['retry-after']),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * SSE 客户端：按完整帧（`\n\n` 分隔）记录**每帧到达时刻**。
 * 这是「有没有被缓冲」的唯一可靠判据 —— 只看总字节数无法区分「逐帧到达」与「末尾一次性到达」。
 */
function collectSse(url: string): Promise<{ timesMs: number[] }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timesMs: number[] = [];
    let buf = '';
    const req = httpRequest(url, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          buf = buf.slice(idx + 2);
          timesMs.push(Date.now() - t0);
          idx = buf.indexOf('\n\n');
        }
      });
      res.on('end', () => resolve({ timesMs }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/* ─────────────────────────── 纯函数 ─────────────────────────── */

describe('pluginWebId', () => {
  it('只认前缀后的合法首段', () => {
    expect(pluginWebId(`${BASE}/`)).toBe(PLUGIN_ID);
    expect(pluginWebId(`${BASE}/_next/static/x.js`)).toBe(PLUGIN_ID);
    expect(pluginWebId(`${BASE}`)).toBe(PLUGIN_ID);
    expect(pluginWebId(`${BASE}/api/status?x=1`)).toBe(PLUGIN_ID);
  });

  it('无前缀 / 空段 / 非法字符一律不接管', () => {
    expect(pluginWebId('/api/chat')).toBeNull();
    expect(pluginWebId(PLUGIN_WEB_PREFIX)).toBeNull();
    expect(pluginWebId(`${PLUGIN_WEB_PREFIX}/api/status`)).toBeNull();
    // 穿越与编码绕过
    expect(pluginWebId(`${PLUGIN_WEB_PREFIX}..%2f..%2fetc/passwd`)).toBeNull();
    expect(pluginWebId(`${PLUGIN_WEB_PREFIX}-bad/x`)).toBeNull();
  });

  it('basePath 拼装与 id 严格对应（无结尾斜杠）', () => {
    expect(pluginWebBasePath(PLUGIN_ID)).toBe(BASE);
    expect(pluginWebBasePath(PLUGIN_ID).endsWith('/')).toBe(false);
  });
});

describe('isDeclaredPluginWebPanel（跨包不变量的运行时守卫）', () => {
  it('hostPath 逐字等于 前缀+id 即算声明（托管形态不限）', () => {
    expect(isDeclaredPluginWebPanel({ mode: 'serve', hostPath: BASE }, PLUGIN_ID)).toBe(true);
    // static 面板的 UI 由宿主托管，但 API 仍走本反代 ⇒ 同样算声明
    expect(isDeclaredPluginWebPanel({ mode: 'static', hostPath: BASE }, PLUGIN_ID)).toBe(true);
  });

  it('hostPath 与实际路径不一致 ⇒ 不认（否则插件 basePath 漂移会静默 404）', () => {
    expect(isDeclaredPluginWebPanel({ mode: 'serve', hostPath: '/api/plugin-web/other' }, PLUGIN_ID)).toBe(false);
    expect(isDeclaredPluginWebPanel({ mode: 'serve', hostPath: `${BASE}/` }, PLUGIN_ID)).toBe(false);
    expect(isDeclaredPluginWebPanel({ mode: 'static', hostPath: `${BASE}/` }, PLUGIN_ID)).toBe(false);
    expect(isDeclaredPluginWebPanel({ mode: 'serve' }, PLUGIN_ID)).toBe(false);
    expect(isDeclaredPluginWebPanel({ mode: 'static' }, PLUGIN_ID)).toBe(false);
    expect(isDeclaredPluginWebPanel(undefined, PLUGIN_ID)).toBe(false);
  });
});

describe('filterForwardHeaders', () => {
  it('剔除 hop-by-hop 与 host（host 必须重写成上游地址）', () => {
    const out = filterForwardHeaders({
      host: 'localhost:8321',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      accept: 'text/html',
      'accept-language': 'zh-CN',
    });
    expect(out).not.toHaveProperty('host');
    expect(out).not.toHaveProperty('connection');
    expect(out).not.toHaveProperty('transfer-encoding');
    expect(out).not.toHaveProperty('upgrade');
    expect(out.accept).toBe('text/html');
    expect(out['accept-language']).toBe('zh-CN');
  });
});

/* ─────────────────────── 真实 socket 集成 ─────────────────────── */

describe('handlePluginWebProxy（真 socket）', () => {
  let upstream: Server;
  let upstreamPort: number;
  let proxy: Server;
  let proxyPort: number;

  beforeAll(async () => {
    const up = await startFakeUpstream();
    upstream = up.server;
    upstreamPort = up.port;
    const px = await startProxy((id) =>
      id === PLUGIN_ID ? { kind: 'ok', port: upstreamPort, name: 'Video Shot' } : { kind: 'not-declared' },
    );
    proxy = px.server;
    proxyPort = px.port;
  });

  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  const url = (suffix: string) => `http://127.0.0.1:${proxyPort}${BASE}${suffix}`;

  it('① 根路径与状态端点可通，且路径**逐字透传**（含前缀）', async () => {
    const root = await get(url('/'));
    expect(root.status).toBe(200);
    expect(root.body).toContain('fake plugin');
    expect(lastUpstreamPath).toBe(`${BASE}/`);

    const status = await get(url('/api/status'));
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body).plugin).toBe(PLUGIN_ID);
    // 🔴 上游看到的是带前缀的完整路径：插件自带 basePath == 本前缀才成立
    expect(lastUpstreamPath).toBe(`${BASE}/api/status`);
  });

  it('② 查询串完整保留', async () => {
    await get(url('/api/status?q=%E4%B8%AD%E6%96%87&n=1'));
    expect(lastUpstreamPath).toBe(`${BASE}/api/status?q=%E4%B8%AD%E6%96%87&n=1`);
  });

  it('③ 大 body 请求体是「流」不是缓冲：字节数精确一致', async () => {
    const payload = Buffer.alloc(2_000_000, 7); // 2MB
    const echoed = await new Promise<{ status: number; bytes: number }>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: proxyPort, path: `${BASE}/api/echo`, method: 'POST', headers: { 'content-length': String(payload.length) } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes: JSON.parse(body).bytes }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    expect(echoed.status).toBe(200);
    expect(echoed.bytes).toBe(payload.length);
    expect(lastUpstreamBytes).toBe(payload.length);
  });

  it('④ SSE 逐帧到达（未被缓冲）', async () => {
    const { timesMs } = await collectSse(url('/api/sse'));
    expect(timesMs).toHaveLength(4);
    const span = timesMs[timesMs.length - 1]! - timesMs[0]!;
    // 上游 150ms 一帧 ⇒ 跨度应 ≈450ms；若被缓冲，跨度会塌到几十 ms
    expect(span).toBeGreaterThan(250);
    expect(timesMs[0]!).toBeLessThan(250);
  });

  it('⑤ 负对照：缓冲版反代必须让 ④ 的判据失败（证明判据不是平凡为真）', async () => {
    // 刻意写成「收全再吐」的反代：读尽上游 body 后一次性 write
    const buffered = createServer((req, res) => {
      const up = httpRequest(
        { host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method },
        (ur) => {
          const chunks: Buffer[] = [];
          ur.on('data', (c: Buffer) => chunks.push(c));
          ur.on('end', () => {
            res.writeHead(ur.statusCode ?? 502, { 'Content-Type': 'text/event-stream' });
            res.end(Buffer.concat(chunks));
          });
        },
      );
      req.pipe(up);
    });
    const bufferedPort = await listen(buffered);
    try {
      const { timesMs } = await collectSse(`http://127.0.0.1:${bufferedPort}${BASE}/api/sse`);
      const span = timesMs[timesMs.length - 1]! - timesMs[0]!;
      // 同一组断言：缓冲版**必须**不满足
      expect(span).toBeLessThan(250);
      expect(timesMs.every((t) => t > 250)).toBe(true);
    } finally {
      await close(buffered);
    }
  });

  it('⑥ 未声明的 id ⇒ 404，且不接管（不暴露「哪些 id 存在」）', async () => {
    const res = await get(`http://127.0.0.1:${proxyPort}${PLUGIN_WEB_PREFIX}unknown-plugin/x`);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('PASSTHROUGH');
  });

  it('⑦ 非插件路径放行给下游（handle 返回 false）', async () => {
    const res = await get(`http://127.0.0.1:${proxyPort}/api/chat`);
    expect(res.status).toBe(404);
    expect(res.body).toBe('PASSTHROUGH');
  });

  it('⑧ 上游端口无监听（ECONNREFUSED）⇒ 503 引导页（与「未运行」同语义，而非 502）', async () => {
    // 用「先 listen 拿到端口再立刻 close」造一个确定无监听者的端口 ——
    // 不复用共享上游，避免测试间耦合（关共享上游会等未结束的连接，把本用例挂住）。
    const dead = createServer(() => { /* never reached */ });
    const deadPort = await listen(dead);
    await close(dead);

    const { server, port } = await startProxy(() => ({ kind: 'ok', port: deadPort, name: 'Video Shot' }));
    try {
      const res = await get(`http://127.0.0.1:${port}${BASE}/api/status`);
      // 工单 P0-4：resolve 说 ok 但上游死端口（探测缓存 TTL 窗口内的残留）→
      // 语义必须与 declared-not-running 一致：503 + 引导页 + Retry-After
      expect(res.status).toBe(503);
      expect(res.contentType).toContain('text/html');
      expect(res.body).toContain('未运行');
      expect(res.body).toContain(PLUGIN_ID);
      expect(res.retryAfter).toBe('3');
    } finally {
      await close(server);
    }
  });
});

describe('插件未运行时的空态（书签生命周期长于插件进程，属常态）', () => {
  it('503 + 可读页面 + 插件 id（不是白屏/500）', async () => {
    const { server, port } = await startProxy(() => ({ kind: 'declared-not-running', name: 'Video Shot' }));
    try {
      const res = await get(`http://127.0.0.1:${port}${BASE}/`);
      expect(res.status).toBe(503);
      expect(res.contentType).toContain('text/html');
      expect(res.body).toContain('Video Shot');
      expect(res.body).toContain(PLUGIN_ID);
      expect(res.body).toContain('未运行');
    } finally {
      await close(server);
    }
  });

  it('resolve 抛错 ⇒ 502 且带原因（而不是让异常冒到 server.ts 的兜底 500）', async () => {
    const { server, port } = await startProxy(() => { throw new Error('boom'); });
    try {
      const res = await get(`http://127.0.0.1:${port}${BASE}/`);
      expect(res.status).toBe(502);
      expect(res.body).toContain('boom');
    } finally {
      await close(server);
    }
  });
});
