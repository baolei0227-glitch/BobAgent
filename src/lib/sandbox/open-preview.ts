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
export async function openSandboxPreviewInHippo(app: OpenSandboxPreviewApp): Promise<void> {
  const url = window.location.origin + '/api/sandbox/preview/' + app.id;
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
