/**
 * ocr-bridge 单测：宿主托管 Bob OCR 常驻桥的判据
 *
 * 覆盖三件事（每件都能真的失败，不做平凡断言）：
 *   1. probeOcrBridge —— 在线/离线/异常响应的判定；
 *   2. 已有在线桥（用户自装 launchd daemon、或另一宿主拉起的）→ ensure 必须**复用**，
 *      不得另起进程（否则会抢 9478 端口、把可用环境搞成 EADDRINUSE）；
 *   3. 无在线桥 → ensure 用随包副本 `--serve` 拉起，并能从 /setup/status 拿到就绪；
 *      stopOcrBridge 收尾后必须真的下线（不留下孤儿进程）。
 *
 * 说明：用例 3 起的是**真插件子进程**（dist/cli.js），数据根/端口全部指向临时目录与临时端口，
 * 不碰用户真实的 ~/BobWork 与 9478；随包副本未构建（dist 缺失）时跳过该用例。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureOcrBridge,
  ocrBridgePort,
  probeOcrBridge,
  stopOcrBridge,
} from './ocr-bridge';

/** 监听 0 端口拿一个真实空闲端口（写死端口会让用例互相干扰或连错进程） */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 假桥：只实现 /setup/status */
function fakeBridge(status: number, body: unknown): Server {
  return createServer((req, res) => {
    if ((req.url || '').split('?')[0] !== '/setup/status') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}

const ORIGINAL_ENV = {
  port: process.env.BOB_OCR_MCP_PORT,
  home: process.env.BOBWORK_HOME,
};

/** 临时数据根：放在仓库内（沙箱允许写），用例结束清理 */
const TEST_ROOT = join(process.cwd(), '.tmp-ocr-bridge-test');

beforeEach(() => {
  // 每个用例从干净的宿主托管状态开始（状态挂在 globalThis，见 ocr-bridge.ts）
  stopOcrBridge();
  globalThis.__bobOcrBridgeState__ = undefined;
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  process.env.BOBWORK_HOME = TEST_ROOT;
});

afterEach(() => {
  stopOcrBridge();
  globalThis.__bobOcrBridgeState__ = undefined;
  if (ORIGINAL_ENV.port === undefined) delete process.env.BOB_OCR_MCP_PORT;
  else process.env.BOB_OCR_MCP_PORT = ORIGINAL_ENV.port;
  if (ORIGINAL_ENV.home === undefined) delete process.env.BOBWORK_HOME;
  else process.env.BOBWORK_HOME = ORIGINAL_ENV.home;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('probeOcrBridge', () => {
  it('在线：返回 token 与 settingsUrl', async () => {
    const server = fakeBridge(200, {
      token: 'tok-123',
      settingsUrl: 'http://127.0.0.1:1/settings?token=tok-123',
      connected: true,
    });
    const port = await listen(server);
    process.env.BOB_OCR_MCP_PORT = String(port);
    try {
      expect(ocrBridgePort()).toBe(port);
      const probe = await probeOcrBridge();
      expect(probe.online).toBe(true);
      expect(probe.token).toBe('tok-123');
      expect(probe.settingsUrl).toContain('/settings?token=tok-123');
    } finally {
      await close(server);
    }
  });

  it('离线：端口没有监听者 → online=false（附原因）', async () => {
    // 先占一个端口再释放，确保这个端口短期内无人监听
    const tmp = createServer();
    const port = await listen(tmp);
    await close(tmp);
    process.env.BOB_OCR_MCP_PORT = String(port);
    const probe = await probeOcrBridge(300);
    expect(probe.online).toBe(false);
    expect(probe.token).toBeUndefined();
    expect(probe.error).toBeTruthy();
  });

  it('异常响应：HTTP 503 → online=false 且带状态码（不当成在线）', async () => {
    const server = fakeBridge(503, { error: 'starting' });
    const port = await listen(server);
    process.env.BOB_OCR_MCP_PORT = String(port);
    try {
      const probe = await probeOcrBridge();
      expect(probe.online).toBe(false);
      expect(probe.error).toContain('503');
    } finally {
      await close(server);
    }
  });
});

describe('ensureOcrBridge', () => {
  it('已有在线桥：直接复用，不重复拉起进程', async () => {
    const server = fakeBridge(200, { token: 'external', settingsUrl: 'http://127.0.0.1:1/settings?token=external' });
    const port = await listen(server);
    process.env.BOB_OCR_MCP_PORT = String(port);
    try {
      const r = await ensureOcrBridge({ waitMs: 500 });
      expect(r.ok).toBe(true);
      expect(r.online).toBe(true);
      expect(r.spawned).toBe(false); // 关键：没有抢进程
      // 假桥仍在服务（没被我们 kill）
      const probe = await probeOcrBridge();
      expect(probe.online).toBe(true);
      expect(probe.token).toBe('external');
    } finally {
      await close(server);
    }
  });

  it('无在线桥：用随包副本拉起，就绪后可停止', async () => {
    const entry = join(process.cwd(), '..', 'bob-ocr-mcp', 'dist', 'cli.js');
    if (!existsSync(entry)) {
      // 随包副本未构建（干净 checkout 且未 npm run build）→ 跳过而不是假装通过
      expect(existsSync(entry)).toBe(false);
      return;
    }
    const tmp = createServer();
    const port = await listen(tmp);
    await close(tmp);
    process.env.BOB_OCR_MCP_PORT = String(port);

    const r = await ensureOcrBridge({ waitMs: 15_000 });
    expect(r.ok).toBe(true);
    expect(r.spawned).toBe(true);

    const probe = await probeOcrBridge();
    expect(probe.online).toBe(true);
    expect(probe.token).toBeTruthy();
    expect(probe.settingsUrl).toContain(`127.0.0.1:${port}`);

    // 收尾：stopOcrBridge 后端口应无人应答（不遗留孤儿进程）
    stopOcrBridge();
    let offline = false;
    for (let i = 0; i < 40 && !offline; i++) {
      offline = !(await probeOcrBridge(200)).online;
      if (!offline) await new Promise((res) => setTimeout(res, 100));
    }
    expect(offline).toBe(true);
  }, 30_000);

  it('端口被占（子进程秒退 EADDRINUSE）：首次失败后果断冷却，不重复白等就绪超时', async () => {
    const entry = join(process.cwd(), '..', 'bob-ocr-mcp', 'dist', 'cli.js');
    if (!existsSync(entry)) {
      expect(existsSync(entry)).toBe(false);
      return;
    }
    // 占住端口，且对 /setup/status 只回 404（探不到在线）→ 随包桥 listen 必然 EADDRINUSE 秒退
    const squatter = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const port = await listen(squatter);
    process.env.BOB_OCR_MCP_PORT = String(port);
    try {
      const t0 = Date.now();
      const first = await ensureOcrBridge({ waitMs: 8000 });
      const firstElapsed = Date.now() - t0;
      expect(first.ok).toBe(false);
      expect(first.spawned).toBe(true);
      expect(first.error).toBeTruthy();
      // 子进程秒退必须能被及时识别，不能白等满就绪超时（历史缺陷：退出后 state().child 被清空 → 漏判）
      expect(firstElapsed).toBeLessThan(3000);

      // 第二次：命中失败冷却 → 不再 spawn，且立刻返回（不重跑「等就绪」）
      const t1 = Date.now();
      const second = await ensureOcrBridge({ waitMs: 8000 });
      const elapsed = Date.now() - t1;
      expect(second.ok).toBe(false);
      expect(second.spawned).toBe(false); // 关键：没有反复 spawn
      expect(elapsed).toBeLessThan(1000);
      expect(second.error).toBe(first.error);
    } finally {
      await close(squatter);
    }
  }, 30_000);
});
