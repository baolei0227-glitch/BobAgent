/**
 * lib/mcp/panel-ports.ts — 插件面板端口的「宿主侧运行时表」
 *
 * 为什么需要：serve 形态的插件面板端口原本写在预置里（bob-notes 9480 / bob-mind 9482），
 * 是**整机唯一**的固定端口。同一台机器上若并存两个宿主（安装版 App + 源码 dev 服务，
 * 或两个安装版），后启动者的插件实例必然 EADDRINUSE，面板永久打不开且不会自愈
 * （宿主侧回收器刻意不碰「另一个活着宿主」的实例）。
 *
 * 解法：宿主在 spawn 前自己分配一个空闲端口，用 `--serve <port>` 传给插件，
 * 并登记在本表；面板地址、就绪探测、宿主侧直连一律优先读本表 —— 每个宿主各有一份
 * 自己的插件实例与端口，互不干扰。
 *
 * 生命周期语义（2026-10-19 补全，工单《插件面板端口生命周期整改》P0-1）：
 *   - 表项在**卸载/禁用**时由 manager 的 teardown 调 `releasePanelPort` 删除（唯一删除入口）；
 *   - 复用是**条件复用**：登记端口当前无人监听（上次实例已死）才复用——正常崩溃重启
 *     端口不变，面板 iframe 不换地址；端口仍被占（残留进程/另一实例）则换新端口，
 *     新子进程永不被交给一个 EADDRINUSE 的端口；
 *   - 表项只代表「本宿主登记过端口」；**可达性**由 `isPortAcceptingConnections`（TTL 缓存）
 *     在消费侧（反代 resolve）另行保证。
 *
 * 状态挂在 globalThis：Next 每个 route 是独立 chunk，dev 下 HMR 会重建模块实例，
 * 模块级变量可能出现多份；只有 globalThis 才是同进程唯一（仓库既有模式见 src/server.ts）。
 */

import { createServer, connect as tcpConnect } from 'node:net';

declare global {
  // eslint-disable-next-line no-var
  var __bobPluginPanelPorts__: Map<string, number> | undefined;
}

function table(): Map<string, number> {
  if (!globalThis.__bobPluginPanelPorts__) globalThis.__bobPluginPanelPorts__ = new Map();
  return globalThis.__bobPluginPanelPorts__;
}

/** 本宿主为某插件实例登记的运行时面板端口；未登记返回 undefined（调用方回退预置地址） */
export function getPanelPort(serverId: string): number | undefined {
  return table().get(serverId);
}

/** 删除某插件实例的端口登记（禁用/卸载时由 manager teardown 调用；全仓唯一删除入口） */
export function releasePanelPort(serverId: string): void {
  table().delete(serverId);
}

/** 取一个当前空闲的本地端口（listen(0) 拿到即释放，紧接着交给子进程绑定） */
export function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => {
        if (port > 0) resolvePort(port);
        else reject(new Error('no free port available'));
      });
    });
  });
}

/* ─────────────────── 可达性探测（TTL 缓存） ─────────────────── */

/** 探测结果缓存时长：反代 resolve 是热路径，不能每请求裸探测；3s 同时与 503 的 Retry-After 对齐 */
const PROBE_CACHE_TTL_MS = 3_000;

const probeCache = new Map<number, { alive: boolean; at: number }>();

/** 单次 TCP connect 探测：能建立连接 = 有监听者（不追问是谁在监听，判据只服务「端口可用」） */
function probeOnce(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveAlive) => {
    const sock = tcpConnect({ host: '127.0.0.1', port });
    const finish = (alive: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolveAlive(alive);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

/**
 * 端口当前是否有进程监听（带 TTL 缓存，正负结果都缓存）。
 * 供反代 resolve（崩溃窗口内按「未运行」引导，而非对死端口透传出 502）与
 * `ensurePanelPort` 的复用校验共用。
 */
export async function isPortAcceptingConnections(port: number, timeoutMs = 400): Promise<boolean> {
  const hit = probeCache.get(port);
  if (hit && Date.now() - hit.at < PROBE_CACHE_TTL_MS) return hit.alive;
  const alive = await probeOnce(port, timeoutMs);
  probeCache.set(port, { alive, at: Date.now() });
  return alive;
}

/**
 * 真实 spawn 前的端口准备：**空闲才复用**，否则分配并登记新端口。
 * - 登记端口无人监听（上次实例已死）→ 复用：崩溃自愈后端口不变，iframe 不换地址；
 * - 登记端口仍被占（残留进程 / 另一实例）→ 换新：新子进程永不吃 EADDRINUSE
 *   （残留实例的回收由 plugin-panels-server 的回收器另行负责）。
 */
export async function ensurePanelPort(serverId: string): Promise<number> {
  const existing = getPanelPort(serverId);
  if (existing && !(await isPortAcceptingConnections(existing))) return existing;
  const port = await allocateFreePort();
  table().set(serverId, port);
  return port;
}

/** 仅测试用：清空端口表与探测缓存 */
export function __resetPanelPortStateForTests(): void {
  globalThis.__bobPluginPanelPorts__ = undefined;
  probeCache.clear();
}
