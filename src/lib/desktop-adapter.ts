/**
 * 桌面壳适配层（Step 0.5b）
 *
 * 统一包装 window.api（Electron IPC），消除组件中散落的 typeof window.api?.xxx 判断。
 * 好处：
 * - 未来 web 版可提供 mock 实现（此文件已是 mock 的天然位置）
 * - e2e 测试可注入假实现，不必依赖真实 Electron
 * - 与架构演进的"桌面壳边界"衔接
 */

/** 更新事件回调类型 */
type CheckingCb = (info: { manual: boolean }) => void;
type AvailableCb = (info: { version: string; releaseNotes: string; releaseDate: string }) => void;
type NotAvailableCb = (info: { manual: boolean }) => void;
type DownloadProgressCb = (progress: { percent: number; bytesPerSecond: number; downloaded: number; total: number }) => void;
type DownloadedCb = (info: { version?: string }) => void;
type InstallProgressCb = (progress: { stage: string; message: string; percent?: number }) => void;
type ErrorCb = (info: { message: string; manual: boolean }) => void;

/** 截图 OCR 事件回调类型 */
type ScreenOcrErrorCb = (payload: { message: string }) => void;

/** 获取原始 window.api（Electron 环境下存在，web 环境下为 undefined） */
function raw(): typeof window.api | undefined {
  return typeof window !== 'undefined' ? window.api : undefined;
}

/** 当前是否运行在 Electron 桌面环境 */
export function isDesktop(): boolean {
  return !!raw();
}

export const desktop = {
  // ---- 顶层方法 ----

  /** 用系统默认程序打开文件 */
  openFile(filePath: string): Promise<{ success: boolean; error?: string }> {
    return raw()?.openFile?.(filePath) ?? Promise.resolve({ success: false, error: 'Not in desktop environment' });
  },

  /** 将 HTML 内容写入系统临时目录并用默认浏览器打开 */
  openHtml(content: string, filename?: string): Promise<{ success: boolean; error?: string; path?: string }> {
    return raw()?.openHtml?.(content, filename) ?? Promise.resolve({ success: false, error: 'Not in desktop environment' });
  },

  /** 在系统文件管理器中显示并选中指定文件（macOS：Finder「在访达中显示」） */
  showItemInFolder(filePath: string): Promise<{ success: boolean; error?: string }> {
    return raw()?.showItemInFolder?.(filePath) ?? Promise.resolve({ success: false, error: 'Not in desktop environment' });
  },

  /** 弹出目录选择对话框 */
  selectDirectory(): Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }> {
    return raw()?.selectDirectory?.() ?? Promise.resolve({ success: false, error: 'Not in desktop environment' });
  },

  /** 获取用户主目录（用于 ~ 展开） */
  getHomeDir(): string {
    return raw()?.getHomeDir?.() ?? '';
  },

  /** 打开开发者工具 */
  openDevTools(): Promise<void> {
    return raw()?.openDevTools?.() ?? Promise.resolve();
  },

  /** 从 File 对象获取文件系统路径（拖拽场景） */
  getPathForFile(file: File): string {
    return raw()?.getPathForFile?.(file) ?? '';
  },

  // ---- update 子模块 ----

  update: {
    /** 检查更新 */
    check(): Promise<{ success: boolean; error?: string }> {
      return raw()?.update?.check?.() ?? Promise.resolve({ success: false, error: 'Not in desktop environment' });
    },
    /** 下载更新 */
    download(): Promise<{ success: boolean; error?: string }> {
      return raw()?.update?.download?.() ?? Promise.resolve({ success: false, error: 'Not in desktop environment' });
    },
    /** 安装更新 */
    install(): Promise<{ success: boolean; cancelled?: boolean; error?: string }> {
      return raw()?.update?.install?.() ?? Promise.resolve({ success: false, error: 'Not in desktop environment' });
    },
    /** 清除更新缓存 */
    clearCache(): Promise<{ success: boolean; deletedCount: number; freedMB: number }> {
      return raw()?.update?.clearCache?.() ?? Promise.resolve({ success: false, deletedCount: 0, freedMB: 0 });
    },
    /** 发送系统通知 */
    notify(title: string, body: string): Promise<boolean> {
      return raw()?.update?.notify?.(title, body) ?? Promise.resolve(false);
    },
    /** 获取应用版本号 */
    getVersion(): Promise<string> {
      return raw()?.update?.getVersion?.() ?? Promise.resolve('');
    },
    /** 监听：正在检查更新 */
    onChecking(callback: CheckingCb): () => void {
      const unsub = raw()?.update?.onChecking?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：发现新版本 */
    onAvailable(callback: AvailableCb): () => void {
      const unsub = raw()?.update?.onAvailable?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：已是最新版本 */
    onNotAvailable(callback: NotAvailableCb): () => void {
      const unsub = raw()?.update?.onNotAvailable?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：下载进度 */
    onDownloadProgress(callback: DownloadProgressCb): () => void {
      const unsub = raw()?.update?.onDownloadProgress?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：下载完成 */
    onDownloaded(callback: DownloadedCb): () => void {
      const unsub = raw()?.update?.onDownloaded?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：安装进度 */
    onInstallProgress(callback: InstallProgressCb): () => void {
      const unsub = raw()?.update?.onInstallProgress?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：更新错误 */
    onError(callback: ErrorCb): () => void {
      const unsub = raw()?.update?.onError?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
  },

  // ---- screenOcr 子模块（全局截图 OCR：Cmd+Shift+O）----

  screenOcr: {
    /** 监听：选区开始（系统已弹出截图交互层） */
    onStart(callback: () => void): () => void {
      const unsub = raw()?.screenOcr?.onStart?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：OCR 失败（message 为失败原因） */
    onError(callback: ScreenOcrErrorCb): () => void {
      const unsub = raw()?.screenOcr?.onError?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：用户按 Esc 取消选区（静默，无需提示） */
    onCanceled(callback: () => void): () => void {
      const unsub = raw()?.screenOcr?.onCanceled?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 监听：截图完成（dataUrl 为截图 PNG，渲染层弹编辑面板；mode 标注选区来源） */
    onCaptured(callback: (payload: { dataUrl: string; mode?: 'region' | 'full' }) => void): () => void {
      const unsub = raw()?.screenOcr?.onCaptured?.(callback);
      return typeof unsub === 'function' ? unsub : () => {};
    },
    /** 取消编辑（主进程清理临时截图） */
    cancelEdit(): void {
      raw()?.screenOcr?.cancelEdit?.();
    },
    /** 编辑完成（主进程清理暂存截图，避免残留） */
    finishEdit(): void {
      raw()?.screenOcr?.finishEdit?.();
    },
    /** 复制选区图片到系统剪贴板（编辑面板 ✓） */
    copyImage(dataUrl: string): Promise<{ ok: boolean; error?: string }> {
      return raw()?.screenOcr?.copyImage?.(dataUrl) ?? Promise.resolve({ ok: false, error: '非桌面环境' });
    },
    /** 选区转文字：OCR 选区图片并返回识别文本（编辑面板「To Text」，请求/响应式） */
    ocrRegion(dataUrl: string): Promise<{ ok: boolean; text?: string; error?: string }> {
      return raw()?.screenOcr?.ocrRegion?.(dataUrl) ?? Promise.resolve({ ok: false, error: '非桌面环境' });
    },
    /** 查询 BobWorkCapture 屏幕录制授权状态（设置面板用；非桌面环境返回 missing） */
    getPermissionStatus(): Promise<{ status: 'granted' | 'denied' | 'unknown' | 'missing'; error?: string }> {
      return raw()?.screenOcr?.getPermissionStatus?.() ?? Promise.resolve({ status: 'missing' });
    },
    /** 一键打开 系统设置 → 屏幕录制（设置面板用） */
    openPermissions(): Promise<{ success: boolean }> {
      return raw()?.screenOcr?.openPermissions?.() ?? Promise.resolve({ success: false });
    },
  },
};
