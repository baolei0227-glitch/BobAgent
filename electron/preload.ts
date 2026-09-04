import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { homedir } from 'os';

export interface UpdateApi {
  check: () => Promise<{ success: boolean; error?: string }>;
  download: () => Promise<{ success: boolean; error?: string }>;
  install: () => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
  clearCache: () => Promise<{ success: boolean; deletedCount: number; freedMB: number }>;
  notify: (title: string, body: string) => Promise<boolean>;
  getVersion: () => Promise<string>;
  onChecking: (callback: (info: { manual: boolean }) => void) => void;
  onAvailable: (callback: (info: { version: string; releaseNotes: string; releaseDate: string }) => void) => void;
  onNotAvailable: (callback: (info: { manual: boolean }) => void) => void;
  onDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; downloaded: number; total: number }) => void) => void;
  onDownloaded: (callback: (info: { version?: string }) => void) => () => void;
  onInstallProgress: (callback: (progress: { stage: string; message: string; percent?: number }) => void) => () => void;
  onError: (callback: (info: { message: string; manual: boolean }) => void) => void;
}

export interface SettingsApi {
  load: () => Promise<unknown>;
  save: (settings: unknown) => Promise<void>;
  exists: () => Promise<boolean>;
}

export interface AvatarItem {
  id: string;
  name: string;
  dataUrl: string;
  builtin: boolean;
}

export interface AvatarApi {
  list: () => Promise<AvatarItem[]>;
  add: () => Promise<{ success: boolean; avatars?: AvatarItem[]; error?: string; canceled?: boolean }>;
  delete: (id: string) => Promise<{ success: boolean; avatars?: AvatarItem[]; error?: string }>;
}

/** 截图完成载荷（进入编辑阶段，dataUrl 为截图 PNG；mode 标注选区来源） */
export interface ScreenOcrCapturedPayload {
  dataUrl: string;
  /** region = 助手 -i 原生选区已完成；full = 内置链路整屏截图（待前端拖选） */
  mode?: 'region' | 'full';
}

/** 全局截图 OCR（Cmd+Shift+O）事件订阅 */
export interface ScreenOcrApi {
  onStart: (callback: () => void) => () => void;
  onError: (callback: (payload: { message: string }) => void) => () => void;
  onCanceled: (callback: () => void) => () => void;
  /** 截图完成（进入编辑阶段）：渲染层弹编辑面板 */
  onCaptured: (callback: (payload: ScreenOcrCapturedPayload) => void) => () => void;
  /** 取消编辑（主进程清理临时截图） */
  cancelEdit: () => void;
  /** 编辑完成（✓）：主进程清理暂存截图，避免 shot.png/result.json 残留 */
  finishEdit: () => void;
  /** 复制选区图片到系统剪贴板（编辑面板 ✓） */
  copyImage: (dataUrl: string) => Promise<{ ok: boolean; error?: string }>;
  /** 选区转文字：OCR 选区图片并返回识别文本（编辑面板「To Text」，请求/响应式） */
  ocrRegion: (dataUrl: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  /** 查询 BobWorkCapture 屏幕录制授权状态（设置面板用） */
  getPermissionStatus: () => Promise<{ status: 'granted' | 'denied' | 'unknown' | 'missing'; error?: string }>;
  /** 一键打开 系统设置 → 屏幕录制（设置面板用） */
  openPermissions: () => Promise<{ success: boolean }>;
}

export interface Api {
  update: UpdateApi;
  settings: SettingsApi;
  avatar: AvatarApi;
  getPathForFile: (file: File) => string;
  openDevTools: () => Promise<void>;
  openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  openHtml: (content: string, filename?: string) => Promise<{ success: boolean; error?: string; path?: string }>;
  showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  /** 批量保存图片：files = 弹目录逐张写盘；zip = 弹保存对话框打包 zip（绕过浏览器多下载拦截） */
  saveImages: (payload: { format?: 'files' | 'zip'; name?: string; images: Array<{ name: string; dataUrl: string }> }) =>
    Promise<{ success: boolean; dir?: string; path?: string; count?: number; format?: string; error?: string; canceled?: boolean }>;
  selectDirectory: () => Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>;
  getHomeDir: () => string;
  /** 打印：主进程调用 webContents.print 弹系统打印面板（渲染层 @media print 只输出文档正文） */
  print: () => Promise<{ success: boolean; error?: string }>;
  /** PDF 导出：主进程 printToPDF → base64 数据（渲染层转 Blob 下载） */
  exportPdf: () => Promise<{ success: boolean; data?: string; error?: string }>;
  /** 全局截图 OCR（Cmd+Shift+O）事件 */
  screenOcr: ScreenOcrApi;
}

const api: Api = {
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    clearCache: () => ipcRenderer.invoke('update:clear-cache'),
    notify: (title: string, body: string) => ipcRenderer.invoke('notify', title, body),
    getVersion: () => ipcRenderer.invoke('update:get-version'),
    onChecking: (callback) => {
      const wrapper = (_e: Electron.IpcRendererEvent, info: { manual: boolean }) => callback(info);
      ipcRenderer.on('update:checking', wrapper);
      return () => ipcRenderer.removeListener('update:checking', wrapper);
    },
    onAvailable: (callback) => {
      const wrapper = (_e: Electron.IpcRendererEvent, info: { version: string; releaseNotes: string; releaseDate: string }) => callback(info);
      ipcRenderer.on('update:available', wrapper);
      return () => ipcRenderer.removeListener('update:available', wrapper);
    },
    onNotAvailable: (callback) => {
      const wrapper = (_e: Electron.IpcRendererEvent, info: { manual: boolean }) => callback(info);
      ipcRenderer.on('update:not-available', wrapper);
      return () => ipcRenderer.removeListener('update:not-available', wrapper);
    },
    onDownloadProgress: (callback) => {
      const wrapper = (_e: Electron.IpcRendererEvent, progress: { percent: number; bytesPerSecond: number; downloaded: number; total: number }) => callback(progress);
      ipcRenderer.on('update:download-progress', wrapper);
      return () => ipcRenderer.removeListener('update:download-progress', wrapper);
    },
    onDownloaded: (callback: (info: { version?: string }) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, info: { version?: string }) => callback(info);
      ipcRenderer.on('update:downloaded', wrapper);
      return () => ipcRenderer.removeListener('update:downloaded', wrapper);
    },
    onInstallProgress: (callback: (progress: { stage: string; message: string; percent?: number }) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, progress: { stage: string; message: string; percent?: number }) => callback(progress);
      ipcRenderer.on('update:install-progress', wrapper);
      return () => ipcRenderer.removeListener('update:install-progress', wrapper);
    },
    onError: (callback) => {
      const wrapper = (_e: Electron.IpcRendererEvent, info: { message: string; manual: boolean }) => callback(info);
      ipcRenderer.on('update:error', wrapper);
      return () => ipcRenderer.removeListener('update:error', wrapper);
    },
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
    exists: () => ipcRenderer.invoke('settings:exists'),
  },
  avatar: {
    list: () => ipcRenderer.invoke('avatar:list'),
    add: () => ipcRenderer.invoke('avatar:add'),
    delete: (id: string) => ipcRenderer.invoke('avatar:delete', id),
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openDevTools: () => ipcRenderer.invoke('devtools:open'),
  openFile: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  openHtml: (content: string, filename?: string) => ipcRenderer.invoke('shell:openHtml', content, filename),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  saveImages: (payload: { format?: 'files' | 'zip'; name?: string; images: Array<{ name: string; dataUrl: string }> }) => ipcRenderer.invoke('shell:saveImages', payload),
  selectDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  getHomeDir: () => homedir(),
  print: () => ipcRenderer.invoke('print:open'),
  exportPdf: () => ipcRenderer.invoke('pdf:export'),
  screenOcr: {
    onStart: (callback) => {
      const wrapper = () => callback();
      ipcRenderer.on('screen-ocr:start', wrapper);
      return () => ipcRenderer.removeListener('screen-ocr:start', wrapper);
    },
    onError: (callback) => {
      const wrapper = (_e: Electron.IpcRendererEvent, payload: { message: string }) => callback(payload);
      ipcRenderer.on('screen-ocr:error', wrapper);
      return () => ipcRenderer.removeListener('screen-ocr:error', wrapper);
    },
    onCanceled: (callback) => {
      const wrapper = () => callback();
      ipcRenderer.on('screen-ocr:canceled', wrapper);
      return () => ipcRenderer.removeListener('screen-ocr:canceled', wrapper);
    },
    onCaptured: (callback) => {
      const wrapper = (_e: Electron.IpcRendererEvent, payload: ScreenOcrCapturedPayload) => callback(payload);
      ipcRenderer.on('screen-ocr:captured', wrapper);
      return () => ipcRenderer.removeListener('screen-ocr:captured', wrapper);
    },
    cancelEdit: () => ipcRenderer.send('screen-ocr:cancel-edit'),
    finishEdit: () => ipcRenderer.send('screen-ocr:finish-edit'),
    copyImage: (dataUrl: string) => ipcRenderer.invoke('screen-ocr:copy-image', { dataUrl }),
    ocrRegion: (dataUrl: string) => ipcRenderer.invoke('screen-ocr:ocr-region', { dataUrl }),
    getPermissionStatus: () => ipcRenderer.invoke('screen-ocr:permission-status'),
    openPermissions: () => ipcRenderer.invoke('screen-ocr:open-permissions'),
  },
};

contextBridge.exposeInMainWorld('api', api);

contextBridge.exposeInMainWorld('desktopAPI', {
  platform: process.platform,
  isElectron: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});