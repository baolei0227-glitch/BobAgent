/**
 * 浏览器工具规格层 — HippoDriver
 *
 * 应用内通道：Agent 工具在 Next 侧，实现落在 Electron 主进程（CDP 需要 webContents.debugger，
 * 只能同进程持有），两侧经既有 HTTP loopback 桥（.runtime/hippo-bridge.json）通信：
 *   Next ── POST /exec { name, args } ──▶ 主进程 CDP 自动化 ──▶ Envelope
 *
 * 本文件只做「桥客户端 + envelope 归一」，不含任何浏览器逻辑；
 * 桥不可用（未启动桌面端 / Hippo 未初始化）统一归为 phase='driver'。
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import { BROWSER_TOOL_NAMES } from './specs';
import type { BrowserDriver, DriverCtx, DriverStatus, Envelope } from './types';

const HIPPO_BRIDGE_REL = join('.runtime', 'hippo-bridge.json');

interface BridgeInfo {
  url: string;
  token: string;
}

/** 读桥文件（主进程启动时写入；dev / 打包同构） */
async function readBridge(): Promise<BridgeInfo> {
  const raw = await readFile(join(resolveAppRoot(), HIPPO_BRIDGE_REL), 'utf-8');
  const parsed = JSON.parse(raw) as { url?: string; token?: string };
  if (!parsed || !parsed.url) throw new Error('桥文件缺 url');
  return { url: parsed.url, token: parsed.token || '' };
}

async function bridgeCall<T>(action: string, body?: unknown): Promise<T> {
  const bridge = await readBridge();
  const base = (bridge.url || 'http://127.0.0.1/').replace(/\/+$/, '');
  const url = `${base}${action}?token=${encodeURIComponent(bridge.token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Hippo Browser 桥异常 (HTTP ${res.status})`);
  return (await res.json()) as T;
}

/** 只读路由（/health、/state）在桥侧仅接受 GET；其余动作一律 POST（见 hippo-browser.ts 路由表） */
async function bridgeGet<T>(action: string): Promise<T> {
  const bridge = await readBridge();
  const base = (bridge.url || 'http://127.0.0.1/').replace(/\/+$/, '');
  const url = `${base}${action}?token=${encodeURIComponent(bridge.token)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`Hippo Browser 桥异常 (HTTP ${res.status})`);
  return (await res.json()) as T;
}

const BRIDGE_DOWN_HINT = 'Hippo Browser 未运行：请先启动 BobWork 桌面端并打开 Hippo Browser 窗口';

export class HippoDriver implements BrowserDriver {
  readonly id = 'hippo' as const;
  readonly supportedTools: ReadonlySet<string> = BROWSER_TOOL_NAMES;

  async status(): Promise<DriverStatus> {
    try {
      const r = await bridgeGet<{ ok: boolean; ready?: boolean }>('/health');
      return { ready: !!r.ready };
    } catch (e) {
      return { ready: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async exec(name: string, args: Record<string, unknown>, _ctx: DriverCtx): Promise<Envelope> {
    if (!this.supportedTools.has(name)) {
      return {
        ok: false,
        error: {
          phase: 'unsupported',
          message: `Hippo 通道暂不支持 ${name}`,
          hint: '该能力仅 Bob Browser 通道支持，请关闭设置中的 AI Browser 开关后重试',
        },
      };
    }
    try {
      const env = await bridgeCall<Envelope>('/exec', { name, args });
      if (!env || typeof env.ok !== 'boolean') {
        return { ok: false, error: { phase: 'driver', message: '桥返回格式异常' } };
      }
      return env;
    } catch (e) {
      return {
        ok: false,
        error: {
          phase: 'driver',
          message: e instanceof Error ? e.message : String(e),
          hint: BRIDGE_DOWN_HINT,
        },
      };
    }
  }
}

let shared: HippoDriver | null = null;

/** 单例：driver 无状态（连接信息每调用从桥文件读取，随主进程重启自动跟随） */
export function getHippoDriver(): HippoDriver {
  if (!shared) shared = new HippoDriver();
  return shared;
}

/**
 * 当前活动标签的页面 URL（等价 Bob Browser 通道的 browser_active_tab）。
 *
 * 用途：宿主侧「浏览器工具去重」的页面指纹刷新（见 route.ts fetchCurrentPageUrl）——
 * 页面跳转后同一参数的工具调用不应被判为重复。Hippo 通道没有 active_tab 工具，
 * 改走桥的 /state 路由（只读当前标签状态）。
 *
 * 桥不可用 / Hippo 未就绪 / 非页面 URL（如新建标签页）统一返回 null，调用方按「指纹不变」处理。
 */
export async function getHippoPageUrl(): Promise<string | null> {
  try {
    const r = await bridgeGet<{ ok?: boolean; url?: string }>('/state');
    const url = typeof r?.url === 'string' ? r.url : '';
    return /^(https?|file):\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}