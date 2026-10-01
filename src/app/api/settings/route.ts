import { NextRequest, NextResponse } from 'next/server';
import { readSettingsFromFile, writeSettingsToFile } from '@/lib/settings-server';
import type { AppSettings } from '@/lib/settings';

/**
 * /api/settings —— 全局设置的服务端读写（浏览器/IDE 内嵌预览专用）
 *
 * 背景：Electron 窗口走 preload 的 `settings:load/save` IPC；**没有 desktopAPI 的宿主**
 * （Trae 内嵌 webview 打开 localhost 预览）过去一律降级到 localStorage，于是「界面里选了
 * 引擎 / 模型」只改了浏览器本地副本，而真正合成的服务端仍在读 ~/BobWork/.settings.json，
 * 表现为"改了不起作用"。这里把同一条链路补上：浏览器端改为读写**服务端同一份文件**。
 *
 * GET  → { success: true, settings }（与 IPC load 一致：返回解密后的设置）
 * PUT  → body = 完整 AppSettings → 落盘（写盘前由 writeSettingsToFile 统一加密/防覆盖保护）
 *        成功 { success: true }；失败 { success: false, error }（不静默）
 *
 * 安全：只接受**本机**请求（Host 为 localhost / 127.0.0.1 / [::1]）。设置里含 API Key，
 * 且写的是宿主机的配置文件，不能让远端浏览器会话覆盖；非本机一律 403，客户端退回 localStorage。
 * （与 /api/butler/meeting、/api/mcp/store 的服务端写设置同源，只是多一道本机闸门。）
 */

/** 请求是否来自本机（Host 头为环回地址；无 Host 头按本机处理） */
function isLoopbackRequest(request: NextRequest): boolean {
  const host = request.headers.get('host') || '';
  if (!host) return true;
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']')) // IPv6 字面量：[::1]:5010
    : host.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export async function GET(request: NextRequest) {
  if (!isLoopbackRequest(request)) {
    return NextResponse.json({ success: false, error: 'settings API is local-only' }, { status: 403 });
  }
  try {
    return NextResponse.json({ success: true, settings: await readSettingsFromFile() });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!isLoopbackRequest(request)) {
    return NextResponse.json({ success: false, error: 'settings API is local-only' }, { status: 403 });
  }
  try {
    const settings = (await request.json()) as AppSettings;
    if (!settings || typeof settings !== 'object') {
      return NextResponse.json({ success: false, error: 'Invalid settings payload' }, { status: 400 });
    }
    await writeSettingsToFile(settings);
    return NextResponse.json({ success: true });
  } catch (e) {
    // 防覆盖保护（version 缺失/为 0）或 I/O 失败：如实回报，客户端据此提示而非静默
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
