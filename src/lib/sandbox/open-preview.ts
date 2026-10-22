import { desktop, isDesktop } from '@/lib/desktop-adapter';

export interface OpenSandboxPreviewApp {
  id: string;
  name?: string;
}

/**
 * 在 Hippo Browser 以独立页打开小程序预览。
 *
 * 设计要点：
 * - 小程序桥（lib/sandbox/bridge.ts）在顶层页（无父窗口）走「自托管中继」直连
 *   /api/sandbox/bridge 与 /api/sandbox/chat-stream，因此在 Hippo 独立页可全功能运行。
 * - 桌面环境：先确保 Hippo 已就绪（hippoBrowser.open）再新标签打开，避免覆盖当前标签。
 * - web / 异常回退：window.open 新窗口。
 */
/**
 * 预览 origin：必须与宿主 UI **不同 origin**（2026-10-10 同源隔离 A 方案）。
 * 桌面宿主固定 localhost → 预览改用 127.0.0.1；反向亦然。
 * 非回环主机（Tailscale IP / 隧道域名）无法这样隔离，保持原样（由服务端来源闸与脱敏兜底）。
 */
export function previewOriginFor(currentOrigin: string): string {
  try {
    const u = new URL(currentOrigin);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost') u.hostname = '127.0.0.1';
    else if (h === '127.0.0.1' || h === '::1') u.hostname = 'localhost';
    return u.origin;
  } catch {
    return currentOrigin;
  }
}

export async function openSandboxPreviewInHippo(app: OpenSandboxPreviewApp): Promise<void> {
  const url = previewOriginFor(window.location.origin) + '/api/sandbox/preview/' + app.id;
  if (isDesktop()) {
    try {
      await desktop.hippoBrowser.open();
      await desktop.hippoBrowser.openUrlInNewTab(url);
      return;
    } catch (_) {
      /* 落到 web 回退分支 */
    }
  }
  window.open(url, '_blank');
}
