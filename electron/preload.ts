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
  /** 覆盖编辑窗口复用：常驻窗口收到新的待编辑截图（免重建窗口/重载页面） */
  onNewShot: (callback: (payload: ScreenOcrCapturedPayload) => void) => () => void;
  /** 取消编辑（主进程清理临时截图） */
  cancelEdit: () => void;
  /** 编辑完成（✓）：主进程清理暂存截图，避免 shot.png/result.json 残留 */
  finishEdit: () => void;
  /** 复制选区图片到系统剪贴板（编辑面板 ✓） */
  copyImage: (dataUrl: string) => Promise<{ ok: boolean; error?: string }>;
  /** 选区转文字：OCR 选区图片并返回识别文本（编辑面板「To Text」，请求/响应式） */
  ocrRegion: (dataUrl: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  /** 覆盖编辑窗口：拉取当前待编辑截图（页面挂载后调用，避免与 send 的时序竞争） */
  getEditorShot: () => Promise<{ dataUrl: string; mode?: 'region' | 'full' } | null>;
  /** 覆盖编辑窗口：编辑结束，关闭窗口（回到截图前的界面） */
  closeEditor: () => void;
  /** 查询 BobWorkCapture 屏幕录制授权状态（设置面板用） */
  getPermissionStatus: () => Promise<{ status: 'granted' | 'denied' | 'unknown' | 'missing'; error?: string }>;
  /** 一键打开 系统设置 → 屏幕录制（设置面板用） */
  openPermissions: () => Promise<{ success: boolean }>;
}

/** Hippo Browser 侧边栏状态（主进程 'hippo-browser:state' 单向推送） */
export interface HippoBrowserState {
  visible: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 是否处于胶囊态（收起为主窗口胶囊按钮） */
  capsule: boolean;
  /** 是否固定在前端（always-on-top） */
  alwaysOnTop: boolean;
}

/** Hippo Browser 侧边栏（Cmd+Shift+B）API */
export interface HippoBrowserApi {
  open: () => Promise<HippoBrowserState>;
  close: () => Promise<HippoBrowserState>;
  toggle: () => Promise<HippoBrowserState>;
  navigate: (url: string) => Promise<{ ok: boolean; error?: string }>;
  back: () => Promise<{ ok: boolean; error?: string }>;
  forward: () => Promise<{ ok: boolean; error?: string }>;
  reload: () => Promise<{ ok: boolean; error?: string }>;
  stop: () => Promise<{ ok: boolean; error?: string }>;
  /** 页面内查找：高亮所有匹配并返回数量/当前序号 */
  find: (text: string) => Promise<{ ok: boolean; matches?: number; active?: number; error?: string }>;
  /** 页面内查找：跳到下一个/上一个匹配 */
  findNext: (text: string, forward: boolean) => Promise<{ ok: boolean; matches?: number; error?: string }>;
  /** 页面内查找：清除高亮 */
  findStop: () => Promise<{ ok: boolean }>;
  /** 网页内 Ctrl/Cmd+F 时主进程通知工具栏打开查找条 */
  onFindOpen: (callback: () => void) => () => void;
  /** ⌘L 时主进程通知工具栏聚焦并全选地址栏 */
  onFocusAddr: (callback: () => void) => () => void;
  /** DOM → Markdown 骨架（主进程已做 SPA 智能等待） */
  extract: () => Promise<
    { ok: boolean; ready?: boolean; markdown?: string; text?: string; title?: string; url?: string; error?: string }
  >;
  /** 截图：fullPage=true 走整页长截图 */
  capture: (opts?: { fullPage?: boolean }) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  getState: () => Promise<HippoBrowserState>;
  /** 在当前页在系统默认浏览器中打开 */
  openExternal: () => Promise<{ ok: boolean; error?: string }>;
  /** 清除 Hippo Browser 保存的站点数据（Cookies/localStorage/storage），返回清除的 cookie 数 */
  clearCookies: () => Promise<{ ok: boolean; clearedCount?: number; error?: string }>;
  /** 方案 A：上报浏览器锚点矩形（预览面板内容区，占满面板）。null=退出嵌入模式 */
  setAnchor: (anchor: { x: number; y: number; width: number; height: number } | null) => Promise<HippoBrowserState>;
  /** 收起/恢复胶囊态：收起时隐藏窗口、主窗口正中显示呼吸灯胶囊按钮（非关闭） */
  capsuleToggle: () => Promise<HippoBrowserState>;
  /** 查询当前是否处于胶囊态 */
  getCapsule: () => Promise<boolean>;
  /** 主窗口胶囊态变更订阅（true=收起显示胶囊，false=恢复隐藏胶囊） */
  onCapsule: (callback: (capsule: boolean) => void) => () => void;
  /** 切换固定在前端（always-on-top），返回最新状态 */
  toggleTop: () => Promise<HippoBrowserState>;
  onState: (callback: (state: HippoBrowserState) => void) => () => void;
  /** 进入 HTML 编辑：读取当前页源码并隐藏网页视图（返回 filePath 供保存写回原文件） */
  htmlEditStart: () => Promise<{ ok: boolean; source?: string; filePath?: string; error?: string }>;
  /** 退出 HTML 编辑：恢复并重排网页视图 */
  htmlEditExit: () => Promise<{ ok: boolean }>;
  /** 保存 HTML 到当前文件（filePath 由 htmlEditStart 返回） */
  htmlEditSave: (payload: { html: string }) => Promise<{ ok: boolean; error?: string }>;
  /** AI 编辑 HTML（主进程代理 /api/ai-edit/html，结果经 onHtmlAiEdit 推送）；mode=element 时需传 element.{selector,outerHTML} */
  htmlEditAi: (payload: { html: string; instruction: string; mode?: 'document' | 'element'; element?: { selector: string; outerHTML: string } }) =>
    Promise<{ ok: boolean; error?: string }>;
  /** AI 编辑事件订阅（主进程推送，payload 已序列化为 JSON 字符串） */
  onHtmlAiEdit: (callback: (ev: string) => void) => () => void;
  /** 进入就地编辑：注入 inspector，返回当前页文件路径（file: 时可用于保存） */
  inlineStart: () => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  /** 退出就地编辑 */
  inlineExit: () => Promise<{ ok: boolean }>;
  /** 就地 AI 编辑（已选中元素），结果经 applyInlineEdit 就地应用并经 onHtmlAiEdit 推送 */
  inlineEdit: (payload: { instruction: string }) => Promise<{ ok: boolean; error?: string }>;
  /** 就地编辑：网页元素点选事件回调 */
  onInlineSel: (callback: (sel: { selector: string; outerHTML: string }) => void) => () => void;
  /** AI 编辑弹窗：提交指令（就地应用后返回） */
  aiEditGo: (instruction: string) => Promise<{ ok: boolean; error?: string }>;
  /** AI 编辑弹窗：直接替换文字（style: preserve=保留子标签按比例分配，plain=整段替换） */
  aiEditReplace: (instruction: string, style: 'preserve' | 'plain') => Promise<{ ok: boolean; error?: string }>;
  /** AI 编辑弹窗：AI 优化，生成纯文字草稿 */
  aiEditOptimize: (instruction: string) => Promise<{ ok: boolean; html?: string; error?: string }>;
  /** AI 编辑弹窗：取消并退出就地编辑 */
  aiEditCancel: () => Promise<{ ok: boolean }>;
  /** AI 编辑弹窗：选中元素事件回调 */
  onAiEditSel: (callback: (sel: { selector: string; outerHTML: string }) => void) => () => void;
  /** 书签：查询全部书签 */
  bmList: () => Promise<{ ok: boolean; list: Array<{ url: string; title: string; addedAt: number }> }>;
  /** 书签：切换当前页收藏（有则移除，无则添加），返回最新收藏态与列表 */
  bmToggle: (payload: { url: string; title: string }) => Promise<{ ok: boolean; bookmarked: boolean; list: Array<{ url: string; title: string; addedAt: number }> }>;
  /** 书签：移除指定 url */
  bmRemove: (url: string) => Promise<{ ok: boolean; list: Array<{ url: string; title: string; addedAt: number }> }>;
  /** 书签：重命名（只改显示名，url 不变） */
  bmRename: (payload: { url: string; title: string }) => Promise<{ ok: boolean; error?: string; list: Array<{ url: string; title: string; addedAt: number }> }>;
  /** 工具下拉菜单：切换打开/关闭（独立浮层子窗口） */
  toolMenu: () => Promise<void>;
  /** 工具下拉菜单：执行某项动作（转发给工具栏渲染层统一执行） */
  menuExec: (action: string) => Promise<void>;
  /** 工具下拉菜单：主进程转发的命令回调（back/fwd/reload/ext/shot/extopen/edit/pin） */
  onMenuCmd: (callback: (action: string) => void) => () => void;
  /** 上报工具栏 chrome 实际高度（书签栏随内容变化），用于定位网页视图下边 */
  setChromeHeight: (height: number) => Promise<boolean>;
  /** 窗口：最小化 */
  minimize: () => Promise<boolean>;
  /** 窗口：切换最大化/还原 */
  toggleMaximize: () => Promise<boolean>;
  /** 多标签：新建标签 */
  newTab: () => Promise<{ ok: boolean; error?: string }>;
  /** 多标签：激活指定标签 */
  activateTab: (id: number) => Promise<{ ok: boolean }>;
  /** 多标签：关闭指定标签 */
  closeTab: (id: number) => Promise<{ ok: boolean }>;
  /** 多标签：订阅标签列表变化 */
  onTabs: (callback: (data: { active: number; tabs: { id: number; title: string; url: string; favicon?: string }[] }) => void) => () => void;
  /** 下载：查询全部下载记录 */
  downloadsList: () => Promise<{ downloads: HippoDownloadRecord[] }>;
  /** 下载：取消进行中的下载 */
  downloadCancel: (id: number) => Promise<{ ok: boolean }>;
  /** 下载：用系统默认程序打开已完成的文件 */
  downloadOpen: (id: number) => Promise<{ ok: boolean; error?: string }>;
  /** 下载：在访达中定位文件 */
  downloadReveal: (id: number) => Promise<{ ok: boolean }>;
  /** 下载：清除已结束（完成/取消/中断）的记录 */
  downloadClear: () => Promise<{ ok: boolean; downloads: HippoDownloadRecord[] }>;
  /** 下载：订阅列表与进度变化 */
  onDownloads: (callback: (data: { downloads: HippoDownloadRecord[] }) => void) => () => void;
}

/** Hippo Browser 下载项（主进程 will-download 广播） */
export interface HippoDownloadRecord {
  id: number;
  fileName: string;
  url: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  savePath: string;
  startedAt: number;
}

export interface Api {
  update: UpdateApi;
  settings: SettingsApi;
  avatar: AvatarApi;
  getPathForFile: (file: File) => string;
  openDevTools: () => Promise<void>;
  openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  openHtml: (content: string, filename?: string) => Promise<{ success: boolean; error?: string; path?: string; hippo?: boolean }>;
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
  /** Hippo Browser 侧边栏（Cmd+Shift+B） */
  hippoBrowser: HippoBrowserApi;
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
    onNewShot: (callback) => {
      const wrapper = (_e: Electron.IpcRendererEvent, payload: ScreenOcrCapturedPayload) => callback(payload);
      ipcRenderer.on('screen-ocr:new-shot', wrapper);
      return () => ipcRenderer.removeListener('screen-ocr:new-shot', wrapper);
    },
    cancelEdit: () => ipcRenderer.send('screen-ocr:cancel-edit'),
    finishEdit: () => ipcRenderer.send('screen-ocr:finish-edit'),
    copyImage: (dataUrl: string) => ipcRenderer.invoke('screen-ocr:copy-image', { dataUrl }),
    ocrRegion: (dataUrl: string) => ipcRenderer.invoke('screen-ocr:ocr-region', { dataUrl }),
    getEditorShot: () => ipcRenderer.invoke('screen-ocr:get-editor-shot'),
    closeEditor: () => ipcRenderer.send('screen-ocr:close-editor'),
    getPermissionStatus: () => ipcRenderer.invoke('screen-ocr:permission-status'),
    openPermissions: () => ipcRenderer.invoke('screen-ocr:open-permissions'),
  },
  hippoBrowser: {
    open: () => ipcRenderer.invoke('hippo-browser:open'),
    close: () => ipcRenderer.invoke('hippo-browser:close'),
    minimize: () => ipcRenderer.invoke('hippo-browser:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('hippo-browser:toggle-maximize'),
    toggle: () => ipcRenderer.invoke('hippo-browser:toggle'),
    navigate: (url: string) => ipcRenderer.invoke('hippo-browser:navigate', url),
    back: () => ipcRenderer.invoke('hippo-browser:back'),
    forward: () => ipcRenderer.invoke('hippo-browser:forward'),
    reload: () => ipcRenderer.invoke('hippo-browser:reload'),
    stop: () => ipcRenderer.invoke('hippo-browser:stop'),
    find: (text: string) => ipcRenderer.invoke('hippo-browser:find', text),
    findNext: (text: string, forward: boolean) => ipcRenderer.invoke('hippo-browser:find-next', text, forward),
    findStop: () => ipcRenderer.invoke('hippo-browser:find-stop'),
    onFindOpen: (callback: () => void) => {
      const wrapper = () => callback();
      ipcRenderer.on('hippo-browser:open-find', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:open-find', wrapper);
    },
    onFocusAddr: (callback: () => void) => {
      const wrapper = () => callback();
      ipcRenderer.on('hippo-browser:open-focus-addr', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:open-focus-addr', wrapper);
    },
    extract: () => ipcRenderer.invoke('hippo-browser:extract'),
    capture: (opts?: { fullPage?: boolean }) => ipcRenderer.invoke('hippo-browser:capture', opts),
    getState: () => ipcRenderer.invoke('hippo-browser:get-state'),
    openExternal: () => ipcRenderer.invoke('hippo-browser:open-external'),
    clearCookies: () => ipcRenderer.invoke('hippo-browser:clear-cookies'),
    setAnchor: (anchor: { x: number; y: number; width: number; height: number } | null) => ipcRenderer.invoke('hippo-browser:set-anchor', anchor),
    capsuleToggle: () => ipcRenderer.invoke('hippo-browser:capsule-toggle'),
    getCapsule: () => ipcRenderer.invoke('hippo-browser:get-capsule'),
    toggleTop: () => ipcRenderer.invoke('hippo-browser:toggle-top'),
    onCapsule: (callback: (capsule: boolean) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, capsule: boolean) => callback(capsule);
      ipcRenderer.on('hippo-browser:capsule', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:capsule', wrapper);
    },
    onState: (callback: (state: HippoBrowserState) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, state: HippoBrowserState) => callback(state);
      ipcRenderer.on('hippo-browser:state', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:state', wrapper);
    },
    htmlEditStart: () => ipcRenderer.invoke('hippo-browser:html-edit-start'),
    htmlEditExit: () => ipcRenderer.invoke('hippo-browser:html-edit-exit'),
    htmlEditSave: (payload: { html: string }) => ipcRenderer.invoke('hippo-browser:html-edit-save', payload),
    htmlEditAi: (payload: { html: string; instruction: string; mode?: 'document' | 'element'; element?: { selector: string; outerHTML: string } }) => ipcRenderer.invoke('hippo-browser:html-edit-ai', payload),
    onHtmlAiEdit: (callback: (ev: string) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, ev: string) => callback(ev);
      ipcRenderer.on('hippo-browser:html-edit-ai-event', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:html-edit-ai-event', wrapper);
    },
    inlineStart: () => ipcRenderer.invoke('hippo-browser:inline-start'),
    inlineExit: () => ipcRenderer.invoke('hippo-browser:inline-exit'),
    inlineEdit: (payload: { instruction: string }) => ipcRenderer.invoke('hippo-browser:inline-edit', payload),
    onInlineSel: (callback: (sel: { selector: string; outerHTML: string }) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, sel: { selector: string; outerHTML: string }) => callback(sel);
      ipcRenderer.on('hippo-browser:inline-sel', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:inline-sel', wrapper);
    },
    aiEditGo: (instruction: string) => ipcRenderer.invoke('hippo-browser:aiedit-go', { instruction }),
    aiEditReplace: (instruction: string, style: 'preserve' | 'plain') => ipcRenderer.invoke('hippo-browser:aiedit-replace', { instruction, style }),
    aiEditOptimize: (instruction: string) => ipcRenderer.invoke('hippo-browser:aiedit-optimize', { instruction }),
    aiEditCancel: () => ipcRenderer.invoke('hippo-browser:aiedit-cancel'),
    onAiEditSel: (callback: (sel: { selector: string; outerHTML: string }) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, sel: { selector: string; outerHTML: string }) => callback(sel);
      ipcRenderer.on('hippo-browser:aiedit-sel', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:aiedit-sel', wrapper);
    },
    bmList: () => ipcRenderer.invoke('hippo-browser:bm-list'),
    bmToggle: (payload: { url: string; title: string }) => ipcRenderer.invoke('hippo-browser:bm-toggle', payload),
    bmRemove: (url: string) => ipcRenderer.invoke('hippo-browser:bm-remove', url),
    bmRename: (payload: { url: string; title: string }) => ipcRenderer.invoke('hippo-browser:bm-rename', payload),
    setChromeHeight: (height: number) => ipcRenderer.invoke('hippo-browser:set-chrome-height', height),
    toolMenu: () => ipcRenderer.invoke('hippo-browser:tool-menu'),
    menuExec: (action: string) => ipcRenderer.invoke('hippo-browser:menu-exec', action),
    onMenuCmd: (callback: (action: string) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, action: string) => callback(action);
      ipcRenderer.on('hippo-browser:menu-cmd', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:menu-cmd', wrapper);
    },
    newTab: () => ipcRenderer.invoke('hippo-browser:new-tab'),
    activateTab: (id: number) => ipcRenderer.invoke('hippo-browser:activate-tab', id),
    closeTab: (id: number) => ipcRenderer.invoke('hippo-browser:close-tab', id),
    onTabs: (callback: (data: { active: number; tabs: { id: number; title: string; url: string; favicon?: string }[] }) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, data: { active: number; tabs: { id: number; title: string; url: string; favicon?: string }[] }) => callback(data);
      ipcRenderer.on('hippo-browser:tabs', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:tabs', wrapper);
    },
    downloadsList: () => ipcRenderer.invoke('hippo-browser:downloads-list'),
    downloadCancel: (id: number) => ipcRenderer.invoke('hippo-browser:download-cancel', id),
    downloadOpen: (id: number) => ipcRenderer.invoke('hippo-browser:download-open', id),
    downloadReveal: (id: number) => ipcRenderer.invoke('hippo-browser:download-reveal', id),
    downloadClear: () => ipcRenderer.invoke('hippo-browser:download-clear'),
    onDownloads: (callback: (data: { downloads: HippoDownloadRecord[] }) => void) => {
      const wrapper = (_e: Electron.IpcRendererEvent, data: { downloads: HippoDownloadRecord[] }) => callback(data);
      ipcRenderer.on('hippo-browser:downloads', wrapper);
      return () => ipcRenderer.removeListener('hippo-browser:downloads', wrapper);
    },
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