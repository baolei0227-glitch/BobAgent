/**
 * panel-ports 单测 —— 端口表生命周期语义（工单《插件面板端口生命周期整改》P0-1）
 *
 * 覆盖：
 *   - ensurePanelPort「空闲才复用」：无人监听 ⇒ 复用（崩溃重启端口不变，iframe 不换地址）；
 *     端口被占 ⇒ 换新端口并更新表（新子进程永不吃 EADDRINUSE）
 *   - releasePanelPort 删除表项（禁用/卸载即失效）
 *   - isPortAcceptingConnections 可达性探测 + TTL 缓存语义
 *
 * 全部用真 socket（真 listen / 真 TCP connect）：端口语义必须实测，mock 掉 net
 * 等于用「实现自己证明自己」。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ensurePanelPort,
  getPanelPort,
  releasePanelPort,
  isPortAcceptingConnections,
  __resetPanelPortStateForTests,
} from './panel-ports';

const SERVER_ID = 'bob-test-mcp';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** 占住指定端口（模拟残留进程 / 另一实例） */
function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

afterEach(() => {
  __resetPanelPortStateForTests();
  vi.useRealTimers();
});

describe('ensurePanelPort（空闲才复用）', () => {
  it('首次调用：分配端口并登记', async () => {
    const port = await ensurePanelPort(SERVER_ID);
    expect(port).toBeGreaterThan(0);
    expect(getPanelPort(SERVER_ID)).toBe(port);
  });

  it('登记端口无人监听 ⇒ 复用（崩溃自愈后端口不变）', async () => {
    const p1 = await ensurePanelPort(SERVER_ID);
    const p2 = await ensurePanelPort(SERVER_ID);
    expect(p2).toBe(p1);
  });

  it('登记端口被占 ⇒ 分配新端口并更新表项（新子进程永不吃 EADDRINUSE）', async () => {
    const p1 = await ensurePanelPort(SERVER_ID);
    // 模拟残留进程占住 p1（上一代未退干净 / 僵尸）
    const squatter = createServer(() => { /* 只占口，不应答业务 */ });
    await listenOn(squatter, p1);
    try {
      const p2 = await ensurePanelPort(SERVER_ID);
      expect(p2).not.toBe(p1);
      expect(getPanelPort(SERVER_ID)).toBe(p2);
    } finally {
      await close(squatter);
    }
  });
});

describe('releasePanelPort', () => {
  it('删除表项：getPanelPort 返回 undefined', async () => {
    await ensurePanelPort(SERVER_ID);
    releasePanelPort(SERVER_ID);
    expect(getPanelPort(SERVER_ID)).toBeUndefined();
  });

  it('删除后重新登记会走全新分配（不残留旧值）', async () => {
    const p1 = await ensurePanelPort(SERVER_ID);
    releasePanelPort(SERVER_ID);
    const p2 = await ensurePanelPort(SERVER_ID);
    // 旧端口大概率空闲，可能被复用为同一个数——判据是「表项确实经过了删除重建」：
    // 用「删除瞬间表为空」而非端口号数值来断言语义
    releasePanelPort(SERVER_ID);
    expect(getPanelPort(SERVER_ID)).toBeUndefined();
    expect(p2).toBeGreaterThan(0);
    void p1;
  });
});

describe('isPortAcceptingConnections（TTL 缓存）', () => {
  it('有监听者 ⇒ true；无监听者 ⇒ false', async () => {
    const srv = createServer(() => { /* no-op */ });
    const port = await listen(srv);
    try {
      await expect(isPortAcceptingConnections(port)).resolves.toBe(true);
    } finally {
      await close(srv);
    }
    // 第一次探测已写入 TTL 缓存（true）；这里要验证的是**真实探测**语义，清缓存后重问。
    // 「缓存窗口内状态变化不生效」由下一条 TTL 用例单独覆盖。
    __resetPanelPortStateForTests();
    await expect(isPortAcceptingConnections(port)).resolves.toBe(false);
  });

  it('3s TTL 内命中缓存：状态变化不立即生效；TTL 过后反映新状态', async () => {
    // 只 fake Date：探测缓存的时间判据可控，socket 超时仍走真实定时器
    vi.useFakeTimers({ toFake: ['Date'] });

    const srv = createServer(() => { /* no-op */ });
    const port = await listen(srv);
    expect(await isPortAcceptingConnections(port)).toBe(true);

    // 关掉监听后立刻再问：命中缓存，仍是 true
    await close(srv);
    expect(await isPortAcceptingConnections(port)).toBe(true);

    // 时间前进 3.5s ⇒ 缓存过期 ⇒ 重新探测，反映真实状态
    vi.setSystemTime(Date.now() + 3_500);
    expect(await isPortAcceptingConnections(port)).toBe(false);
  });
});
