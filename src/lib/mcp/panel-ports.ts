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
 * 状态挂在 globalThis：Next 每个 route 是独立 chunk，dev 下 HMR 会重建模块实例，
 * 模块级变量可能出现多份；只有 globalThis 才是同进程唯一（仓库既有模式见 src/server.ts）。
 */

import { createServer } from 'node:net';

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

/** 真实 spawn 前的端口准备：已登记则复用（同一实例重启后端口不变），否则分配并登记 */
export async function ensurePanelPort(serverId: string): Promise<number> {
  const existing = getPanelPort(serverId);
  if (existing) return existing;
  const port = await allocateFreePort();
  table().set(serverId, port);
  return port;
}