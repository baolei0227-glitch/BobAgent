/**
 * BobWork 内置「获取 Bob Browser MCP 绑定链接 / Token」端点
 *
 * 场景：Bob Browser MCP 的桥（127.0.0.1:9473）运行时，从 /setup/status 直接取
 * token / mcpUrl（新版 native-host 架构返回这些字段，已无旧 WS 时代的 bindingUrl）；
 * 桥离线时回退读本机 ~/.bob-browser-mcp/token.json 拼 ws 链接（兼容老版本）。
 *
 * 优先级：
 *   ① 桥在线：转发 /setup/status 的 mcpUrl/token/bindingUrl（端口以实际监听为准）
 *   ② 桥离线：读 token.json + 默认端口 9473（或 BOB_BRIDGE_PORT）拼链接
 */
import { NextRequest } from 'next/server';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

export const runtime = 'nodejs';

const DEFAULT_PORT = 9473;

/** 从环境变量或默认值解析桥端口 */
function bridgePort(): number {
  const p = Number(process.env.BOB_BRIDGE_PORT);
  return Number.isFinite(p) && p > 0 ? p : DEFAULT_PORT;
}

interface BridgeStatus {
  port?: number;
  token?: string;
  mcpUrl?: string;
  bindingUrl?: string;
}

/** 探测桥是否在线并返回其 /setup/status（超时 2s；失败返回 null） */
async function probeBridgeStatus(): Promise<BridgeStatus | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(`http://127.0.0.1:${bridgePort()}/setup/status`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = (await resp.json().catch(() => null)) as BridgeStatus | null;
    if (!data) return null;
    return {
      port: Number(data.port) || bridgePort(),
      token: typeof data.token === 'string' && data.token ? data.token : undefined,
      mcpUrl: typeof data.mcpUrl === 'string' && data.mcpUrl ? data.mcpUrl : undefined,
      bindingUrl: typeof data.bindingUrl === 'string' && data.bindingUrl ? data.bindingUrl : undefined,
    };
  } catch {
    return null;
  }
}

/** 从本机 token.json 读取 token（旧 WS 时代离线兜底） */
function readLocalToken(): string | null {
  try {
    const p = join(homedir(), '.bob-browser-mcp', 'token.json');
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return typeof raw?.token === 'string' && raw.token ? raw.token : null;
  } catch {
    return null;
  }
}

export async function GET(_req: NextRequest) {
  // ① 桥在线：用桥上报的 mcpUrl / token（新 native-host 架构）；旧字段 bindingUrl 兼容保留
  const status = await probeBridgeStatus();
  if (status) {
    // Copy Token / 复制绑定链接的统一可用地址：mcpUrl（自带 token）> 旧 bindingUrl > ws 派生
    const bindingUrl = status.mcpUrl
      || status.bindingUrl
      || (status.token ? `ws://127.0.0.1:${status.port ?? bridgePort()}?token=${encodeURIComponent(status.token)}` : '');
    return Response.json({
      online: true,
      bindingUrl,
      token: status.token || '',
      port: status.port ?? bridgePort(),
    });
  }

  // ② 桥离线：读本地 token 拼链接
  const token = readLocalToken();
  if (!token) {
    return Response.json(
      {
        online: false,
        bindingUrl: '',
        token: '',
        error:
          'Browser bridge is offline and no local token was found (~/.bob-browser-mcp/token.json). Start bob-browser-mcp once to generate one, or make sure the package is installed globally.',
      },
      { status: 404 },
    );
  }
  const port = bridgePort();
  const bindingUrl = `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`;
  return Response.json({ online: false, bindingUrl, token });
}
