/**
 * Hippo Browser — 独立窗口（主进程）
 *
 * 方案：把原来"嵌主窗口的 WebContentsView 侧边栏"彻底重构为「独立 BrowserWindow」。
 *   - 独立窗口 frame:false（自绘工具栏），webContents 加载一个内联工具栏页面；
 *   - 窗口 contentView 下部叠 WebContentsView（persist:hippo-browser 持久化分区）承载网页；
 *   - 窗口与主窗口互不影响，可自由拖动/缩放/关闭。
 *
 * 能力层（导航/前进后退/提取/整页截图/清除 Cookies）与 HTTP loopback 桥原样保留，
 * 供 Agent 工具（hippo_browser_*）与工具栏 UI 共同调用。
 *
 * 工具栏页面：内联 HTML（data: URL），preload 复用主进程 preload（window.api.hippoBrowser），
 * 不依赖打包资源，dev/打包一致。
 */

import { WebContentsView, BrowserWindow, Menu, session, ipcMain, shell, clipboard, nativeImage, app, type MenuItemConstructorOptions } from 'electron';
import { pathToFileURL, fileURLToPath } from 'url';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import { HIPPO_TOOLBAR_HEIGHT } from '../src/lib/hippo-browser/layout';

/** 独立浏览器窗口默认尺寸 */
const WIN_MIN_WIDTH = 560;
const WIN_MIN_HEIGHT = 420;
const WIN_DEFAULT_WIDTH = 1080;
const WIN_DEFAULT_HEIGHT = 760;

let win: BrowserWindow | null = null;

/** 一个网页标签 */
interface BrowserTab {
  id: number;
  /** 承载 persist:hippo-browser 网页的 WebContentsView（位于工具栏下方） */
  view: WebContentsView;
}
/** 全部标签；仅当前激活标签的 view 会加入 contentView 并显示 */
let tabs: BrowserTab[] = [];
let activeTabId = 0;
let nextTabId = 1;
/** 指向当前激活标签的 view（保持与其他代码里的 `view` 引用一致） */
let view: WebContentsView | null = null;
/** 是否处于"胶囊态"：窗口已收起隐藏，主窗口正中显示呼吸灯胶囊按钮 */
let capsuleMode = false;
/** 工具栏 webContents 在窗口内实际占用的 chrome 高度（含地址栏 + 书签栏），决定网页 view 的上边界 */
let chromeTop = HIPPO_TOOLBAR_HEIGHT;
/** 最近关闭的标签（⌘⇧T 逐个恢复），最多保留 20 条 */
const closedTabs: Array<{ url: string; title: string }> = [];
/** 各标签的 favicon（page-favicon-updated 事件写入，供标签条渲染） */
const faviconMap = new Map<number, string>();

/** 一个下载项（工具栏下载面板据此渲染） */
interface HippoDownload {
  id: number;
  fileName: string;
  url: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  savePath: string;
  startedAt: number;
}
/** 全部下载记录（含已完成，供面板展示与"清除已结束"） */
const downloadMap = new Map<number, HippoDownload>();
/** 进行中的下载项句柄（结束后移除），用于取消 */
const downloadItems = new Map<number, Electron.DownloadItem>();
let nextDownloadId = 1;
/** will-download 钩子是否已挂载（会话级，仅挂一次） */
let downloadHookReady = false;

/** Next.js 服务地址（与 main.ts 一致）：AI HTML 编辑走主进程代理，避免渲染页 CORS */
const aiServerPort = existsSync(join(process.resourcesPath, 'next-standalone'))
  ? 8321
  : (Number(process.env.BOB_DEV_PORT || process.env.PORT) || 3000);
const aiServerUrl = `http://localhost:${aiServerPort}`;
/** 主窗口渲染层胶囊态通知回调（由 main.ts 注入，转发到主窗口 webContents） */
let mainWindowCapsuleListener: ((capsule: boolean) => void) | null = null;

export interface HippoBrowserState {
  visible: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 兼容旧渲染层字段，窗口模式下恒 0（无主窗口预留槽） */
  sidebarWidth: number;
  /** 是否处于胶囊态（收起为居中呼吸灯胶囊，非关闭） */
  capsule: boolean;
  /** 是否固定在前端（always-on-top，工具栏置顶按钮） */
  alwaysOnTop: boolean;
}

export interface HippoExtractResult {
  ready: boolean;
  markdown: string;
  text: string;
  title: string;
  url: string;
}

// ============ 状态 ============

function currentState(): HippoBrowserState {
  const wc = view?.webContents;
  if (!win || win.isDestroyed() || !wc || wc.isDestroyed()) {
    return { visible: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, sidebarWidth: 0, capsule: capsuleMode, alwaysOnTop: false };
  }
  const nh = wc.navigationHistory;
  return {
    visible: !win.isMinimized(),
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: nh && typeof nh.canGoBack === 'function' ? nh.canGoBack() : wc.canGoBack(),
    canGoForward: nh && typeof nh.canGoForward === 'function' ? nh.canGoForward() : wc.canGoForward(),
    sidebarWidth: 0,
    capsule: capsuleMode,
    alwaysOnTop: win.isAlwaysOnTop(),
  };
}



// 上次广播的内容快照：内容未变化时跳过 IPC，避免导航事件高频触发导致的工具栏重渲染
let lastStateJson = '';
let lastTabsJson = '';

/** 广播状态给工具栏 webContents（窗口 webContents） */
function broadcastState(): void {
  if (!win || win.isDestroyed()) return;
  const s = currentState();
  const json = JSON.stringify(s);
  if (json === lastStateJson) return;
  lastStateJson = json;
  win.webContents.send('hippo-browser:state', s);
}

/** 广播标签列表给工具栏（标签条据此渲染） */
function broadcastTabs(): void {
  if (!win || win.isDestroyed()) return;
  const payload = {
    active: activeTabId,
    tabs: tabs.filter((t) => !t.view.webContents.isDestroyed()).map((t) => {
      const wc = t.view.webContents;
      const u = wc.getURL();
      let title = wc.getTitle();
      if (!title || u.startsWith('data:text/html')) title = 'New Tab';
      return { id: t.id, title, url: u, favicon: faviconMap.get(t.id) || '' };
    }),
  };
  const json = JSON.stringify(payload);
  if (json === lastTabsJson) return;
  lastTabsJson = json;
  win.webContents.send('hippo-browser:tabs', payload);
}

function requireView(): Electron.WebContents {
  if (!view || view.webContents.isDestroyed()) {
    throw new Error('Hippo Browser is not initialized');
  }
  return view.webContents;
}

// ============ 下载（会话级 will-download → 工具栏下载面板） ============

/** 下载列表（按开始时间倒序） */
function downloadsToJson(): HippoDownload[] {
  return Array.from(downloadMap.values()).sort((a, b) => b.startedAt - a.startedAt);
}

function broadcastDownloads(): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('hippo-browser:downloads', { downloads: downloadsToJson() });
}

/** 默认存入系统"下载"目录；重名时追加 " (n)" 后缀，避免覆盖已有文件 */
function uniqueDownloadPath(fileName: string): string {
  const dir = app.getPath('downloads');
  const safe = basename(fileName || '') || 'download';
  const ext = extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let p = join(dir, safe);
  let n = 1;
  while (existsSync(p)) p = join(dir, `${stem} (${n++})${ext}`);
  return p;
}

/** 挂载 will-download（每个会话仅一次）：接管保存路径并广播进度 */
function ensureDownloadHook(): void {
  if (downloadHookReady) return;
  downloadHookReady = true;
  const ses = session.fromPartition('persist:hippo-browser');
  ses.on('will-download', (_e, item) => {
    const id = nextDownloadId++;
    const rec: HippoDownload = {
      id,
      fileName: item.getFilename(),
      url: item.getURL(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing',
      savePath: '',
      startedAt: Date.now(),
    };
    // 显式指定保存路径，避免每次下载都弹系统"另存为"对话框（与真实浏览器一致）
    try { item.setSavePath(uniqueDownloadPath(rec.fileName)); } catch { /* 保留系统默认 */ }
    rec.savePath = item.getSavePath() || rec.savePath;
    downloadMap.set(id, rec);
    downloadItems.set(id, item);
    broadcastDownloads();
    // 进度节流：至少间隔 400ms 广播一次，避免高频 IPC
    let lastAt = 0;
    item.on('updated', (_ev, state) => {
      rec.receivedBytes = item.getReceivedBytes();
      rec.totalBytes = item.getTotalBytes();
      rec.savePath = item.getSavePath() || rec.savePath;
      if (state === 'interrupted') rec.state = 'interrupted';
      const now = Date.now();
      if (now - lastAt < 400) return;
      lastAt = now;
      broadcastDownloads();
    });
    item.once('done', (_ev, state) => {
      rec.receivedBytes = item.getReceivedBytes();
      rec.savePath = item.getSavePath() || rec.savePath;
      rec.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      downloadItems.delete(id);
      broadcastDownloads();
      logHippo(`Download ${rec.state}: ${rec.fileName} → ${rec.savePath}`);
    });
  });
}

// ================= 广告 / 跟踪脚本拦截 =================
/**
 * 会话级广告/跟踪拦截：命中域名黑名单的子资源请求直接 cancel。
 *
 * 设计取舍：
 *   - 只拦子资源（script/xhr/image/frame/font 等），放行 mainFrame —— 用户手动访问某广告域名时仍可正常打开；
 *   - 只按「主机名后缀」匹配（O(域名段数)），不做路径正则，避免误伤正常内容请求；
 *   - 放行 localhost / 127.0.0.1（内置 PDF、图片查看页与 bridge 走本机端口）。
 *   - Hippo 无扩展系统（Electron 无 chrome://extensions），故用 webRequest 实现，成本十行级。
 */
const AD_HOSTS = new Set<string>([
  // Google 广告 / 分析
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.com', '2mdn.net',
  // 广告交易 / 投放网络
  'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com',
  'criteo.com', 'criteo.net', 'outbrain.com', 'taboola.com', 'taboolanews.com', '33across.com',
  'bidswitch.net', 'sharethrough.com', 'smartadserver.com', 'teads.tv', 'media.net', 'contextweb.com',
  'sovrn.com', 'gumgum.com', 'adform.net', '1rx.io', 'agkn.com', 'mathtag.com', 'turn.com',
  'tapad.com', 'exelator.com', 'krxd.net', 'zeotap.com', 'liadm.com', 'adsymptotic.com',
  'tribalfusion.com', 'indexexchange.com', 'districtm.io', 'dmxleo.com', 'loopme.me', 'adroll.com',
  'crwdcntrl.net', 'bluekai.com', 'owneriq.net', 'rlcdn.com', 'pippio.com', 'amazon-adsystem.com',
  'assoc-amazon.com', 'weborama.com', 'smartclip.net', 'springserve.com', 'spotxchange.com',
  'beachfront.com', 'rhythmone.com', 'zedo.com', 'yieldmo.com', 'sonobi.com', 'pulsepoint.com',
  'emxdgt.com', 'tremorhub.com', 'conversantmedia.com', 'dotomi.com', 'adition.com',
  // 移动广告 SDK
  'adcolony.com', 'startapp.com', 'tapjoy.com', 'applovin.com', 'inmobi.com', 'mopub.com',
  'chartboost.com', 'ironsrc.com', 'supersonicads.com', 'vungle.com', 'flurry.com',
  // 广告可见性 / 第三方验证
  'adsafeprotected.com', 'moatads.com', 'moatpixel.com', 'doubleverify.com', 'integralads.com',
  // 统计 / 行为追踪
  'scorecardresearch.com', 'quantserve.com', 'comscore.com', 'imrworldwide.com',
  'hotjar.com', 'hotjar.io', 'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com',
  'fullstory.com', 'mouseflow.com', 'smartlook.com', 'luckyorange.com', 'inspectlet.com',
  'crazyegg.com', 'clicktale.net', 'clarity.ms', 'bat.bing.com',
  'analytics.twitter.com', 'static.ads-twitter.com', 'ads.pinterest.com',
  'ads.linkedin.com', 'px.ads.linkedin.com', 'connect.facebook.net',
  // Adobe 分析 / DMP
  'demdex.net', 'omtrdc.net', '2o7.net', 'everesttech.net',
  // 国内广告 / 统计
  'cnzz.com', 'umeng.com', 'umengcloud.com', 'hm.baidu.com', 'tongji.baidu.com', 'pos.baidu.com',
  'cpro.baidu.com', '51.la', '51yes.com', 'tapdb.net', 'alimama.com', 'tanx.com', 'mmstat.com',
  'miaozhen.com', 'admaster.com.cn', 'ipinyou.com',
  // Yahoo
  'ads.yahoo.com', 'ad.yieldmanager.com',
]);

let adBlockReady = false;
let adBlockEnabled = true;
let adBlockCount = 0;

/** 主机名后缀命中黑名单（含子域） */
function isAdHost(host: string): boolean {
  const parts = host.toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (AD_HOSTS.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/** 仅对 http(s) 且非本机的请求判定为广告/跟踪 */
function isBlockedRequest(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return isAdHost(host);
  } catch {
    return false;
  }
}

/** 安装拦截钩子（每个会话仅一次） */
function ensureAdBlock(): void {
  if (adBlockReady) return;
  adBlockReady = true;
  const ses = session.fromPartition('persist:hippo-browser');
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    // 放行主框架导航，避免直接访问广告域名时白屏
    if (!adBlockEnabled || details.resourceType === 'mainFrame' || !isBlockedRequest(details.url)) {
      callback({});
      return;
    }
    adBlockCount++;
    callback({ cancel: true });
  });
  logHippo('Ad/tracker block installed (host list)');
}

/** 开关广告拦截（工具菜单调用） */
function toggleAdBlock(): boolean {
  adBlockEnabled = !adBlockEnabled;
  logHippo(`Ad/tracker block ${adBlockEnabled ? 'ON' : 'OFF'} (blocked ${adBlockCount})`);
  return adBlockEnabled;
}

/**
 * 打开方式：true=新开标签（默认），false=覆盖当前标签。
 * 仅本次会话有效（不落盘），作用于书签点击、页面内链接点击与 target=_blank/window.open。
 */
let openLinkInNewTab = true;

/** 切换「打开链接」方式（工具菜单调用） */
function toggleOpenLinkInNewTab(): boolean {
  openLinkInNewTab = !openLinkInNewTab;
  logHippo(`Open links in ${openLinkInNewTab ? 'new tab' : 'current tab'}`);
  applyLinkModeToTabs();
  return openLinkInNewTab;
}

/** 当前激活标签（无有效标签时返回 null） */
function activeTab(): BrowserTab | null {
  const wc = view;
  if (!wc || wc.webContents.isDestroyed()) return null;
  return tabs.find((t) => t.id === activeTabId && !t.view.webContents.isDestroyed()) ?? null;
}

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:';
  } catch {
    return false;
  }
}

/** 本地文档扩展名 → 内置查看页：pdf → 批注阅读器 /pdf-viewer；图片 → 查看/标注/AI 编辑 /image-viewer */
const VIEWER_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
/** 从 file:// 的 hash（#page=3&q=xx）或查询串解析查看页定位锚点（hash 优先） */
function parseFileAnchor(u: URL): URLSearchParams {
  const raw = (u.hash.startsWith('#') ? u.hash.slice(1) : u.hash) || u.search.replace(/^\?/, '');
  return new URLSearchParams(raw);
}
function localFileToViewerUrl(target: string): string | null {
  if (!/^file:\/\//i.test(target)) return null;
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  const m = u.pathname.match(/\.([a-z0-9]+)$/i);
  const ext = m ? m[1].toLowerCase() : '';
  if (ext !== 'pdf' && !VIEWER_IMAGE_EXTS.includes(ext)) return null;
  try {
    const fp = fileURLToPath(u);
    if (ext !== 'pdf') {
      return `${aiServerUrl}/image-viewer?path=${encodeURIComponent(fp)}`;
    }
    // PDF 查看页透传定位锚点：&page=N（跳页）/ &q=<片段>（文档内检索高亮）
    const a = parseFileAnchor(u);
    const page = Number(a.get('page') || '');
    if (Number.isFinite(page) && page > 0) u.searchParams.set('page', String(Math.floor(page)));
    const q = (a.get('q') || '').trim();
    if (q) u.searchParams.set('q', q);
    const anchor = u.searchParams.toString();
    return `${aiServerUrl}/pdf-viewer?path=${encodeURIComponent(fp)}${anchor ? `&${anchor}` : ''}`;
  } catch {
    return null;
  }
}

/** 修正渲染层未展开的 ~ 路径：file://~/x → file://<home>/x（沙箱输出常见形态） */
function normalizeFileUrl(raw: string): string {
  if (raw.startsWith('file://~/')) return 'file://' + join(homedir(), raw.slice('file://~'.length));
  if (raw === 'file://~') return 'file://' + homedir();
  return raw;
}

// ============ 书签（本地 JSON 持久化） ============
// 书签结构：{ url, title, favicon, addedAt }，存于用户数据目录 browser-bookmarks.json
// favicon 仅新收藏的条目有值；老书签缺该字段，渲染时退回站点根 favicon.ico
type HippoBookmark = { url: string; title: string; favicon?: string; addedAt: number };
let bmCache: HippoBookmark[] | null = null;
function bmFile(): string {
  return join(app.getPath('userData'), 'browser-bookmarks.json');
}
function bmSave(): void {
  try {
    writeFileSync(bmFile(), JSON.stringify(bmCache ?? []), 'utf8');
  } catch { /* 忽略持久化失败 */ }
}
function bmLoad(): HippoBookmark[] {
  if (bmCache) return bmCache;
  try {
    if (existsSync(bmFile())) {
      const raw = JSON.parse(readFileSync(bmFile(), 'utf8'));
      bmCache = Array.isArray(raw) ? raw : [];
    } else {
      bmCache = [];
    }
  } catch { bmCache = []; }
  return bmCache ?? [];
}
function registerBookmarkHandlers(): void {
  ipcMain.handle('hippo-browser:bm-list', () => ({ ok: true, list: bmLoad() }));
  ipcMain.handle('hippo-browser:bm-toggle', (_e, payload: { url?: string; title?: string; favicon?: string }) => {
    const url = (payload?.url ?? '').trim();
    if (!url) return { ok: false, error: 'Missing URL' };
    const list = bmLoad();
    const exists = list.findIndex((b) => b.url === url);
    let bookmarked: boolean;
    if (exists >= 0) {
      list.splice(exists, 1);
      bookmarked = false;
    } else {
      // favicon 随收藏一并落盘，供书签栏渲染品牌图标（老书签无此字段，渲染时退回站点根 favicon.ico）
      list.push({ url, title: (payload?.title ?? '').trim() || url, favicon: (payload?.favicon ?? '').trim(), addedAt: Date.now() });
      bookmarked = true;
    }
    bmCache = list;
    bmSave();
    return { ok: true, bookmarked, list };
  });
  ipcMain.handle('hippo-browser:bm-remove', (_e, url: string) => {
    const list = bmLoad().filter((b) => b.url !== url);
    bmCache = list;
    bmSave();
    return { ok: true, list };
  });
  // 重命名：只改 title，url 作为唯一键不变
  ipcMain.handle('hippo-browser:bm-rename', (_e, payload: { url?: string; title?: string }) => {
    const url = (payload?.url ?? '').trim();
    const title = (payload?.title ?? '').trim();
    if (!url) return { ok: false, error: 'Missing URL' };
    const list = bmLoad();
    const target = list.find((b) => b.url === url);
    if (!target) return { ok: false, error: 'Bookmark not found' };
    target.title = title || url;
    bmCache = list;
    bmSave();
    return { ok: true, list };
  });
  // 书签右键菜单：主进程弹原生菜单（浮在网页 view 之上），动作经 menu-cmd 回传工具栏执行
  ipcMain.handle('hippo-browser:bm-menu', (_e, payload: { url?: string }) => {
    const url = (payload?.url ?? '').trim();
    if (!url) return;
    const bmCmd = (action: string) => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('hippo-browser:menu-cmd', `bm:${action}:${url}`);
      }
    };
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: 'Rename', click: () => bmCmd('rename') },
      { type: 'separator' },
      { label: 'Delete Bookmark', click: () => bmCmd('remove') },
    ];
    Menu.buildFromTemplate(items).popup(win && !win.isDestroyed() ? { window: win } : undefined);
  });
}

// ============ 能力层 ============

/** DOM → Markdown 骨架提取（注入页面执行，SPA 智能等待） */
const EXTRACT_SCRIPT = `
(() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAIN_SELECTORS = ['main', 'article', '#content', '.content', '.article', '.main', '#main'];
  const pickMain = () => {
    for (const sel of MAIN_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').trim().length > 200) return el;
    }
    return document.body;
  };
  const clean = (root) => {
    const REMOVE = 'script,style,noscript,iframe,svg,canvas,nav,footer,header,aside,[class*="ad"],[id*="ad"],[class*="banner"],[class*="modal"],[class*="popup"],[class*="cookie"],[class*="consent"],[aria-hidden="true"]';
    for (const n of root.querySelectorAll(REMOVE)) n.remove();
  };
  const toMarkdown = (root) => {
    const lines = [];
    const nodes = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,tr,hr');
    for (const n of nodes) {
      const text = (n.innerText || '').trim();
      if (!text) continue;
      const tag = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        lines.push('\\n' + '#'.repeat(level) + ' ' + text + '\\n');
      } else if (tag === 'li') {
        lines.push('- ' + text);
      } else if (tag === 'pre') {
        lines.push('\`\`\`\\n' + text + '\\n\`\`\`');
      } else if (tag === 'blockquote') {
        lines.push('> ' + text);
      } else if (tag === 'tr') {
        lines.push('| ' + Array.from(n.children).map((c) => (c.innerText || '').trim().replace(/\\|/g, '\\\\|')).join(' | ') + ' |');
      } else if (tag === 'hr') {
        lines.push('---');
      } else {
        lines.push(text);
      }
    }
    return lines.join('\\n').replace(/\\n{3,}/g, '\\n\\n');
  };
  return new Promise(async (resolve) => {
    const deadline = Date.now() + 6000;
    let ready = document.readyState === 'complete';
    while (Date.now() < deadline) {
      if (document.readyState === 'complete') {
        if ((pickMain().innerText || '').trim().length > 100) { ready = true; break; }
      }
      await wait(200);
    }
    if (!document.body) {
      resolve({ ready, markdown: '', text: '', title: document.title, url: location.href });
      return;
    }
    clean(document.body);
    const mainEl = pickMain();
    const markdown = toMarkdown(mainEl);
    resolve({ ready, markdown, text: (mainEl.innerText || '').trim(), title: document.title, url: location.href });
  });
})()
`;

async function extractContent(): Promise<HippoExtractResult> {
  const wc = requireView();
  const result = (await wc.executeJavaScript(EXTRACT_SCRIPT, true)) as HippoExtractResult;
  return {
    ready: !!result.ready,
    markdown: result.markdown ?? '',
    text: result.text ?? '',
    title: result.title ?? wc.getTitle(),
    url: result.url ?? wc.getURL(),
  };
}

/** 截图：视口走 capturePage()（免 CDP）；fullPage 走 debugger 整页长截图（用完即 detach） */
async function capture(opts: { fullPage?: boolean } = {}): Promise<string> {
  const wc = requireView();
  if (opts.fullPage) {
    const wasAttached = wc.debugger.isAttached();
    if (!wasAttached) wc.debugger.attach('1.3');
    try {
      const res = (await wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      })) as { data: string };
      const data = 'data:image/png;base64,' + res.data;
      copyDataUrlToClipboard(data);
      return data;
    } finally {
      if (!wasAttached && wc.debugger.isAttached()) wc.debugger.detach();
    }
  }
  const img = await wc.capturePage();
  const data = img.toDataURL();
  copyDataUrlToClipboard(data);
  return data;
}

/**
 * 打印当前页：调用系统打印面板（silent:false，走系统打印机选择）。
 * macOS 打印面板依附于前台窗口：先显示并聚焦浏览器窗口，避免点了没反应。
 */
async function printPage(): Promise<{ ok: boolean; error?: string }> {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Not initialized' };
  try {
    reveal();
    await new Promise((r) => setTimeout(r, 150));
    const res = (await wc.print({ silent: false, printBackground: true })) as
      | { success: boolean; failureReason?: string }
      | undefined;
    if (res && res.success === false) {
      // 用户取消打印面板：正常结束，不算失败
      if (res.failureReason === 'cancelled') return { ok: true };
      return { ok: false, error: res.failureReason || 'Print failed (system)' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 把截图 dataURL 拷贝到系统剪贴板（截图给人"可用"，先落剪贴板最直观） */
function copyDataUrlToClipboard(dataUrl: string): boolean {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (!img.isEmpty()) {
      clipboard.writeImage(img);
      return true;
    }
  } catch { /* 忽略 */ }
  return false;
}

function back(): void {
  const wc = requireView();
  const nh = wc.navigationHistory;
  if (nh && typeof nh.goBack === 'function') nh.goBack();
  else wc.goBack();
}
function forward(): void {
  const wc = requireView();
  const nh = wc.navigationHistory;
  if (nh && typeof nh.goForward === 'function') nh.goForward();
  else wc.goForward();
}

// ============ HTTP loopback 桥（Agent 工具 ⇄ 主进程） ============

let bridgeServer: Server | null = null;
let bridgeToken = '';

function bridgeAppRoot(): string {
  const env = (process.env.BOBWORK_HOME || '').trim();
  if (env && env.startsWith('/')) return env;
  return join(homedir(), 'BobWork');
}

function bridgeBridgeFile(): string {
  return join(bridgeAppRoot(), '.runtime', 'hippo-bridge.json');
}

function bridgeAuthed(url: URL, req: IncomingMessage): boolean {
  if (!bridgeToken) return false;
  if (url.searchParams.get('token') === bridgeToken) return true;
  const auth = (req.headers.authorization || '') as string;
  return auth === `Bearer ${bridgeToken}`;
}

function bridgeWriteFile(): void {
  if (!bridgeServer) return;
  const addr = bridgeServer.address();
  if (!addr || typeof addr === 'string') return;
  const payload = {
    version: 1,
    url: `http://127.0.0.1:${addr.port}/`,
    port: addr.port,
    token: bridgeToken,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  const file = bridgeBridgeFile();
  try {
    mkdirSync(join(bridgeAppRoot(), '.runtime'), { recursive: true });
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    /* 写失败不阻断浏览器本体 */
  }
}

async function bridgeSend(res: ServerResponse, status: number, body: unknown): Promise<void> {
  const json = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function bridgeStart(): void {
  if (bridgeServer) return;
  bridgeToken = randomBytes(16).toString('hex');
  bridgeServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (!bridgeAuthed(url, req)) {
        await bridgeSend(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const p = url.pathname;
      if (req.method === 'GET' && p === '/health') {
        await bridgeSend(res, 200, { ok: true, ready: isHippoReady() });
        return;
      }
      if (req.method === 'GET' && p === '/state') {
        await bridgeSend(res, 200, { ok: true, ...currentState() });
        return;
      }
      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        const raw = await (async () => {
          let d = '';
          for await (const chunk of req) d += chunk;
          return d;
        })();
        if (raw) { try { body = JSON.parse(raw); } catch { /* 忽略 */ } }
      }
      if (p === '/navigate') {
        let target = typeof body.url === 'string' ? body.url.trim() : '';
        // 本地文档（PDF/图片）：重定向到内置查看页（批注阅读器 / 图片查看标注编辑）
        const viewerUrl = localFileToViewerUrl(normalizeFileUrl(target));
        if (viewerUrl) target = viewerUrl;
        if (!target || !isAllowedUrl(target)) {
          await bridgeSend(res, 400, { ok: false, error: 'Only http/https/file links are supported' });
          return;
        }
        // 本地查看页（PDF/图片）及本地 file: 文件（含 HTML）在新标签打开，普通网页在当前标签
        if (isLocalViewer(target) || /^file:\/\//i.test(target)) openInNewTab(target);
        else { requireView().loadURL(target).catch(() => {}); reveal(); }
        await bridgeSend(res, 200, { ok: true, url: target });
        return;
      }
      if (p === '/back') { back(); await bridgeSend(res, 200, { ok: true }); return; }
      if (p === '/forward') { forward(); await bridgeSend(res, 200, { ok: true }); return; }
      if (p === '/reload') { const wc = requireView(); wc.reload(); await bridgeSend(res, 200, { ok: true }); return; }
      if (p === '/stop') { const wc = requireView(); wc.stop(); await bridgeSend(res, 200, { ok: true }); return; }
      if (p === '/extract') {
        try {
          const ext = await extractContent();
          await bridgeSend(res, 200, { ok: true, ...ext });
        } catch (e) {
          await bridgeSend(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (p === '/capture') {
        try {
          const fullPage = !!(body as { fullPage?: boolean }).fullPage;
          const dataUrl = await capture({ fullPage });
          await bridgeSend(res, 200, { ok: true, dataUrl });
        } catch (e) {
          await bridgeSend(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (p === '/search') {
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        const maxResults = Math.min(10, Math.max(1, Number(body.maxResults) || 5));
        if (!query) {
          await bridgeSend(res, 400, { ok: false, error: 'Missing search keyword (query)' });
          return;
        }
        try {
          const r = await searchWeb(query, maxResults);
          await bridgeSend(res, 200, { ok: true, ...r });
        } catch (e) {
          await bridgeSend(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      await bridgeSend(res, 404, { ok: false, error: `unknown action: ${p}` });
    } catch (e) {
      await bridgeSend(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  bridgeServer.listen(0, '127.0.0.1', () => bridgeWriteFile());
  logHippo('Hippo browser HTTP bridge started');
}

function bridgeStop(): void {
  if (bridgeServer) {
    try { bridgeServer.close(); } catch { /* ignore */ }
    bridgeServer = null;
    bridgeToken = '';
  }
  try { if (existsSync(bridgeBridgeFile())) unlinkSync(bridgeBridgeFile()); } catch { /* ignore */ }
}

// ============ 网页搜索（AI 检索入口，免 API key） ============
// 抓取 Bing 结果页并解析成结构化列表，供 hippo_browser_search 工具使用；
// 不改变 Hippo Browser 当前页面，仅在桥内完成网络请求。

interface SearchResultItem { title: string; url: string; snippet: string; }

async function searchWeb(
  query: string,
  maxResults: number,
): Promise<{ engine: string; query: string; results: SearchResultItem[] }> {
  const q = encodeURIComponent(query);
  const res = await fetch(`https://www.bing.com/search?q=${q}&mkt=zh-CN`, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`Search service returned HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResultItem[] = [];
  const itemRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  const strip = (s: string): string =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(html)) !== null && results.length < maxResults) {
    const block = m[0];
    const href = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"/);
    const title = block.match(/<h2[^>]*>(?:<a[^>]*>)?([\s\S]*?)<\/a>/);
    const snip = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (href && title) {
      results.push({
        url: href[1],
        title: strip(title[1]),
        snippet: snip ? strip(snip[1]) : '',
      });
    }
  }
  return { engine: 'bing', query, results };
}

// ============ 窗口显隐 ============

function reveal(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (capsuleMode) {
      capsuleMode = false;
      emitCapsule();
    }
    broadcastState();
  }
}

/** 收起为胶囊：隐藏窗口，通知主窗口正中显示呼吸灯胶囊按钮（非关闭） */
function collapseToCapsule(): void {
  if (win && !win.isDestroyed()) {
    capsuleMode = true;
    win.hide();
    emitCapsule();
    broadcastState();
  }
}

/** 主窗口渲染层胶囊态通知（main.ts 注入） */
export function setMainWindowCapsuleListener(fn: ((capsule: boolean) => void) | null): void {
  mainWindowCapsuleListener = fn;
}

function emitCapsule(): void {
  try {
    mainWindowCapsuleListener?.(capsuleMode);
  } catch { /* 忽略 */ }
}

// ============ 工具栏页面（自绘 UI，内联 HTML） ============

/**
 * 独立窗口 webContents 加载的内联工具栏页面。
 * 通过 window.api.hippoBrowser 控制导航/提取/截图/关闭；主进程广播状态刷新地址栏与按钮可用态。
 * 不依赖打包资源，data: URL 直载。
 */
function toolbarHtml(): string {
  return `<!DOCTYPE html><html>
<head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { height: 100%; overflow: hidden; width:100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  /* body 固定为 48px 顶栏：网页 WebContentsView 从 y=48 盖住下方，
     若把 body 设 height:100% + align-items:center 会把按钮垂直居中到整窗中部，
     被不透明 view 完全盖住 → 只见灰条白屏、看不到工具栏。 */
  /* body 从 48px 顶栏改成 100% 纵向布局：bar(48px) + 编辑器面板(flex:1)，
     正常浏览时编辑器面板隐藏、下方被不透明 WebContentsView 盖住；
     进入 HTML 编辑态时主进程隐藏 view，body 自带编辑器面板铺满窗口。 */
  body { display: flex; flex-direction: column; align-items: stretch; height: 100%; overflow: hidden;
    background: #f7f7fb; font-size: 13px; color: #222; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 48px; flex: none; width: 100%;
    border-bottom: 1px solid #e4e4ec;
    /* frame:false 自绘窗口：整条工具栏作为可拖拽区，实现自由拖动 */
    -webkit-app-region: drag; }
  .btn { width: 30px; height: 30px; border: none; border-radius: 6px; background: transparent;
    color: #555; font-size: 16px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    transition: background .15s; flex: none; font-family: inherit; -webkit-app-region: no-drag; }
  .btn:hover { background: #ececf4; }
  .btn:disabled { opacity: .3; cursor: default; }
  .addr { flex: 1; height: 30px; border: 1px solid #d9d9e6; border-radius: 15px; padding: 0 14px;
    font-size: 13px; color: #222; outline: none; background: #fff; -webkit-app-region: no-drag; }
  .addr:focus { border-color: #7c6cf0; }
  .btn.active { background: rgba(75,63,227,.14); color:#4b3fe3; }
  .btn svg { width: 13px; height: 13px; }
  .btn#reload svg { width: 12px; height: 12px; }
  /* ===== macOS 原生红绿灯（Yosemite/Big Sur 质感） ===== */
  .tl { display: grid; grid-auto-flow: column; gap: 8px; padding: 0 8px 0 6px; align-items: center; }
  .tl button { width: 12px; height: 12px; border-radius: 50%; border: none; padding: 0; cursor: pointer;
    -webkit-app-region: no-drag; display: inline-flex; align-items: center; justify-content: center;
    /* 内侧 1px 描边 + 顶部高光 + 底部微投影，营造原生玻璃金属质感 */
    box-shadow: inset 0 0 0 0.5px rgba(0,0,0,.22), inset 0 1px 1px rgba(0,0,0,.16), inset 0 -1px 1px rgba(255,255,255,.18); }
  /* 图标用矢量描边/填充，不用 Unicode 字形（小字号发虚、字形不统一）；
     默认隐藏，鼠标移入整组红绿灯才浮现，与 macOS 原生一致 */
  .tl button svg { width: 8px; height: 8px; opacity: 0; transition: opacity .12s; }
  .tl:hover button svg { opacity: 1; }
  .tl button:active { filter: brightness(.92); }
  .tl button:hover { color: rgba(0,0,0,.62); }
  .tl .r { background: linear-gradient(#ff6a64, #ff5146); }
  .tl .y { background: linear-gradient(#ffd64b, #ffbd22); }
  .tl .g { background: linear-gradient(#3dd860, #22c23a); }
  /* ===== 地址框（书签星内嵌） ===== */
  .addrbox { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; -webkit-app-region: no-drag; }
  .addrbox .addr { flex: 1; padding: 0 34px 0 14px; }
  .addrbox .addr:focus { border-color: #7c6cf0; }
  .addrStar { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 26px; height: 26px; border: none;
    background: transparent; color: #b9b9c8; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px; -webkit-app-region: no-drag; }
  .addrStar:hover { background: #ececf4; }
  .addrStar.on { color: #f5b301; }
  /* ===== 书签标签栏（标星的网址，位于地址栏下方） ===== */
  .bmtabs { display: flex; align-items: center; gap: 5px; padding: 3px 8px; min-height: 28px; flex: none; width: 100%;
    border-bottom: 1px solid #e4e4ec; background: #fbfbfe; overflow-x: auto; -webkit-app-region: drag; }
  .bmtab { display: inline-flex; align-items: center; gap: 4px; max-width: 150px; height: 20px; padding: 0 7px; border-radius: 10px;
    background: #eef0f8; color: #444; font-size: 11px; cursor: pointer; flex: none; -webkit-app-region: no-drag; }
  .bmtab:hover { background: #e4e7f2; }
  .bmtab .fav { flex: none; width: 12px; height: 12px; border-radius: 3px; object-fit: contain; }
  .bmtab .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bmEdit { flex: none; width: 110px; height: 20px; padding: 0 5px; border: 1px solid #6b5cf0; border-radius: 4px;
    font-size: 12px; color: #222; background: #fff; outline: none; -webkit-app-region: no-drag; }
  .bmEmpty { padding: 2px 8px; color: #b0b0c0; font-size: 11.5px; -webkit-app-region: no-drag; }
  /* ===== 浏览器标签条（多标签） ===== */
  .tabbar { display: flex; align-items: flex-end; gap: 4px; padding: 4px 8px 0; flex: none; width: 100%;
    background: #f6f6fb; overflow-x: auto; -webkit-app-region: drag; box-sizing: border-box; }
  .tbtab { display: inline-flex; align-items: center; gap: 5px; max-width: 190px; height: 28px; padding: 0 6px 0 10px; border-radius: 8px 8px 0 0;
    background: #eceef7; color: #555; font-size: 12px; cursor: pointer; flex: none; -webkit-app-region: no-drag;
    border: 1px solid #eceef7; border-bottom: none; }
  .tbtab:hover { background: #e2e5f2; }
  .tbtab.cur { background: #fff; color: #1c1c24; font-weight: 600; border-color: #dedeec; }
  .tbtab.active-toggle {}
  .tbtab .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tbtab .x { flex: none; width: 16px; height: 16px; border: none; background: transparent; color: inherit; font-size: 13px; line-height: 1;
    cursor: pointer; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }
  .tbtab .x:hover { background: rgba(0,0,0,.14); }
  .tbadd { flex: none; width: 26px; height: 28px; margin-left: 2px; border: none; background: transparent; color: #8a8aa0;
    font-size: 18px; cursor: pointer; border-radius: 8px 8px 0 0; -webkit-app-region: no-drag; }
  .tbadd:hover { background: #e2e5f2; color: #333; }
  .tbtab .fav { width: 13px; height: 13px; border-radius: 3px; flex: none; object-fit: contain; }
  /* ===== 顶部加载进度条（loading 驱动：加载中缓慢爬升，完成时冲到 100% 再淡出） ===== */
  .progbar { position: fixed; top: 0; left: 0; height: 2px; width: 0; z-index: 999; opacity: 0; pointer-events: none;
    background: linear-gradient(90deg, #6b5cf0, #9d8cff); transition: width .18s ease-out, opacity .3s ease; }
  .progbar.on { opacity: 1; }
  /* ===== 页面内查找条（Ctrl/Cmd+F） ===== */
  .findbar { display: none; align-items: center; gap: 6px; padding: 4px 8px; flex: none; width: 100%;
    border-bottom: 1px solid #e4e4ec; background: #fbfbfe; -webkit-app-region: no-drag; }
  .findbar.show { display: flex; }
  .findbar input { flex: 1; min-width: 0; height: 26px; border: 1px solid #d9d9e6; border-radius: 6px; padding: 0 10px;
    font-size: 12.5px; color: #222; outline: none; background: #fff; }
  .findbar input:focus { border-color: #7c6cf0; }
  .findbar .cnt { font-size: 12px; color: #888; flex: none; min-width: 54px; text-align: center; }
  .findbar .fbtn { flex: none; height: 26px; min-width: 30px; padding: 0 8px; border: none; border-radius: 6px;
    background: #e4e4ec; color: #444; font-size: 13px; cursor: pointer; -webkit-app-region: no-drag; }
  .findbar .fbtn:hover { background: #d6d6e0; }
  .findbar .fbtn.close { background: transparent; color: #888; }
  /* ===== 工具下拉菜单 ===== */
  .menuWrap { position: relative; -webkit-app-region: no-drag; }
  .toolMenu { position: fixed; top: 44px; right: 10px; width: 210px; background: #fff; border: 1px solid #e0e0ea; border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,.12); z-index: 998; padding: 6px; display: none; }
  .toolMenu.show { display: block; }
  .mi { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; color: #333; }
  .mi:hover { background: #f2f2f8; }
  .mi:disabled { opacity: .35; cursor: default; }
  .mi:disabled:hover { background: transparent; }
  .mi svg { flex: none; }
  .mi .lbl { flex: 1; }
  /* ===== 下载按钮 + 下载面板 ===== */
  .dlWrap { position: relative; -webkit-app-region: no-drag; }
  .dlBadge { position: absolute; top: 1px; right: 0; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
    background: #6b5cf0; color: #fff; font-size: 9.5px; line-height: 14px; text-align: center; display: none; }
  .dlBadge.show { display: block; }
  .dlPanel { position: fixed; top: 44px; right: 10px; width: 340px; max-height: 62vh; background: #fff; border: 1px solid #e0e0ea;
    border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.12); z-index: 998; display: none; flex-direction: column;
    overflow: hidden; -webkit-app-region: no-drag; }
  .dlPanel.show { display: flex; }
  .dlHead { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #eeeef6; flex: none; }
  .dlHead .dlTitle { flex: 1; font-size: 13px; font-weight: 600; color: #333; }
  .dlHead .fbtn { flex: none; height: 24px; min-width: 24px; padding: 0 6px; border: none; border-radius: 6px;
    background: transparent; color: #888; font-size: 14px; cursor: pointer; }
  .dlHead .fbtn:hover { background: #f2f2f8; }
  .dlList { overflow-y: auto; padding: 6px; }
  .dlItem { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 8px; }
  .dlItem:hover { background: #f6f6fb; }
  .dlItem .dlMain { flex: 1; min-width: 0; }
  .dlItem .dlName { font-size: 12.5px; color: #222; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dlItem .dlMeta { font-size: 11px; color: #999; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dlItem .dlAct { flex: none; display: flex; gap: 4px; }
  .dlItem .dlAb { height: 24px; padding: 0 8px; border: none; border-radius: 6px; background: #eef0f8; color: #555;
    font-size: 12px; cursor: pointer; font-family: inherit; }
  .dlItem .dlAb:hover { background: #e2e5f2; }
  .dlItem .dlAb.primary { background: #6b5cf0; color: #fff; }
  .dlItem .dlAb.primary:hover { background: #5a4be0; }
  .dlProg { height: 3px; border-radius: 2px; background: #ececf4; margin-top: 5px; overflow: hidden; }
  .dlProg > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #6b5cf0, #9d8cff); transition: width .2s; }
  .dlEmpty { padding: 18px 10px; text-align: center; color: #b0b0c0; font-size: 12px; }
  /* ===== HTML 编辑器面板（默认隐藏，进入编辑态 body.editing 时显示） ===== */
  .editor { display: none; flex-direction: column; flex: 1; min-height: 0; background: #fff; }
  body.editing .editor { display: flex; }
  .edTool { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #e4e4ec; background: #f2f2f8; flex: none; }
  .edTool input { flex: 1; height: 26px; border: 1px solid #d9d9e6; border-radius: 6px; padding: 0 10px; font-size: 12.5px; color:#222; outline:none; background:#fff; }
  .edTool input:focus { border-color:#7c6cf0; }
  .edBtn { height: 26px; padding: 0 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12.5px; font-family: inherit;
    background: #e4e4ec; color: #333; transition: background .15s; flex: none; }
  .edBtn:hover { background: #d6d6e0; }
  .edBtn.primary { background: #6b5cf0; color: #fff; }
  .edBtn.primary:hover { background: #5a48e6; }
  .edBtn.danger { background: #ffe3e6; color: #c0392b; }
  .edBtn.danger:hover { background: #ffd2d8; }
  #edStatus { font-size: 12px; color: #888; flex: none; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #edSrc { flex: 1; min-height: 0; border: none; resize: none; padding: 10px 12px; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 12px;
    line-height: 1.6; color: #222; background: #fff; outline: none; white-space: pre; }
  #edPreviewPane { flex: 1; min-height: 0; display: none; }
  #edPreviewPane.on { display: flex; }
  #edFrame { flex: 1; border: none; }
  #edElem { font-size: 11px; color: #555; flex: none; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    background: #e9e9f1; border-radius: 4px; padding: 2px 6px; }
  #edInsp.active { background: #6b5cf0; color: #fff; }
  /* iframe 内元素级编辑：悬停/选中高亮 */
  .bob-insp-hover { outline: 2px dashed #6b5cf0 !important; outline-offset: -2px; background: rgba(107,92,240,.12) !important; cursor: pointer; }
  .bob-insp-selected { outline: 2px solid #e0483d !important; outline-offset: -1px; background: rgba(224,72,61,.12) !important; cursor: pointer; }
  /* ===== 指针统一：本窗口只用箭头指针，不用手型 pointer =====
     工具栏/书签栏/标签栏是 -webkit-app-region: drag 的窗口拖拽区，其内的
     no-drag 按钮若声明 cursor: pointer，鼠标在「拖拽区 ↔ 按钮」之间移动时
     Chromium 命中测试来回切换，指针在箭头/手型间反复变化，产生闪烁感；
     统一为箭头即可消除。文本输入域保留 I 形光标。 */
  html * { cursor: default !important; }
  input, textarea { cursor: auto !important; }
</style></head>
<body>
<div class="progbar" id="progbar"></div>
<div class="bar">
  <span class="tl">
    <button class="r" id="winClose" title="Close" aria-label="Close"><svg viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" aria-hidden="true"><path d="M1.9 1.9 6.1 6.1"></path><path d="M6.1 1.9 1.9 6.1"></path></svg></button>
    <button class="y" id="winMin" title="Minimize" aria-label="Minimize"><svg viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" aria-hidden="true"><path d="M1.7 4h4.6"></path></svg></button>
    <button class="g" id="winMax" title="Zoom" aria-label="Zoom"><svg viewBox="0 0 8 8" aria-hidden="true"><path d="M4.5 1.2h2.3v2.3z" fill="currentColor"></path><path d="M3.5 6.8H1.2V4.5z" fill="currentColor"></path></svg></button>
  </span>
  <button class="btn" id="back" title="Back">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"></path><path d="M12 19l-7-7 7-7"></path></svg>
  </button>
  <button class="btn" id="fwd" title="Forward">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5l7 7-7 7"></path></svg>
  </button>
  <button class="btn" id="reload" title="Reload">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2v6h-6"></path><path d="M21 13A9 9 0 1 1 3 13a9 9 0 0 1 15-6.2L21 8"></path></svg>
  </button>
  <span class="addrbox">
    <input class="addr" id="addr" placeholder="Search or enter address" spellcheck="false" />
    <button class="addrStar" id="bm" title="Bookmark this page"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.5 6.8L12 16.9 5.9 20.3l1.5-6.8L2.2 8.9l6.9-.6z"></path></svg></button>
  </span>
  <button class="btn" id="pinBtn" title="Always on top">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"></path></svg>
  </button>
  <button class="btn" id="aiEd" title="In-place AI edit (click a page element directly)">
    <img src="data:image/png;base64,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" alt="AI Edit" style="width:15px;height:15px;pointer-events:none;-webkit-user-select:none" draggable="false" />

  <span class="dlWrap">
    <button class="btn" id="dlBtn" title="Downloads">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path></svg>
      <span class="dlBadge" id="dlBadge"></span>
    </button>
  </span>
  <span class="menuWrap">
    <button class="btn" id="menuBtn" title="Tools" style="width:30px;padding:0;">⋯</button>
  </span>
</div>
<div class="dlPanel" id="dlPanel">
  <div class="dlHead">
    <span class="dlTitle">Downloads</span>
    <button class="fbtn" id="dlClear" title="Clear finished downloads">Clear</button>
    <button class="fbtn" id="dlClose" title="Close">×</button>
  </div>
  <div class="dlList" id="dlList"></div>
</div>
<div class="tabbar" id="tabbar"></div>
<div class="findbar" id="findbar">
  <input id="findInput" placeholder="Find in page…" spellcheck="false" />
  <span class="cnt" id="findCnt"></span>
  <button class="fbtn" id="findPrev" title="Previous (Shift+Enter)">↑</button>
  <button class="fbtn" id="findNextBtn" title="Next (Enter)">↓</button>
  <button class="fbtn close" id="findClose" title="Close (Esc)">×</button>
</div>
<div class="bmtabs" id="bmtabs"></div>
<div class="editor">
  <div class="edTool">
    <button class="edBtn" id="edPreview">Preview</button>
    <button class="edBtn" id="edInsp" title="Pick an element for AI editing">Select</button>
    <span id="edElem" title=""></span>
    <input id="edInst" placeholder="AI edit instruction, e.g. make the page title blue" spellcheck="false" />
    <button class="edBtn primary" id="edAi">AI Edit</button>
    <button class="edBtn" id="edSave">Save</button>
    <button class="edBtn danger" id="edClose">Exit</button>
    <span id="edStatus"></span>
  </div>
  <textarea id="edSrc" spellcheck="false" wrap="off"></textarea>
  <div id="edPreviewPane"><iframe id="edFrame" sandbox="allow-scripts allow-same-origin"></iframe></div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  // 注意：不能用局部变量名 api——preload 通过 contextBridge 暴露的全局 api 对象，
  // 在工具窗口的渲染环境里 const api 会与它冲突触发 "Identifier 'api' has already been declared"，
  // 导致整段脚本 SyntaxError、全部按钮绑定失效、窗口下方 view 停驻 about:blank 呈空白。
  const BAPI = window.api && window.api.hippoBrowser;
  // 工具下拉菜单：由主进程打开独立浮层子窗口（避免被网页 view 遮挡）；动作经 menu-cmd 回传本层统一执行
  $('menuBtn').onclick = (e) => { e.stopPropagation(); BAPI && BAPI.toolMenu(); };
  const act = {
    back: () => BAPI && BAPI.back(),
    fwd: () => BAPI && BAPI.forward(),
    reload: () => { const st = current; if (st && st.loading) BAPI.stop(); else BAPI.reload(); },
    ext: async () => { if (!BAPI) return; const r = await BAPI.extract();
      alert(r && r.markdown ? (r.ready ? 'Markdown copied to clipboard' : 'Page may not be fully loaded; copied the current skeleton') : (r && r.error || 'Nothing extracted')); },
    shot: async () => { if (!BAPI) return; const r = await BAPI.capture({ fullPage: true });
      alert(r && r.ok ? 'Full-page screenshot captured (copied to clipboard)' : (r && r.error || 'Screenshot failed')); },
    print: async () => { if (!BAPI) return; const r = await BAPI.print();
      if (r && !r.ok) alert(r.error || 'Print failed'); },
    extopen: () => BAPI && BAPI.openExternal(),
    edit: () => enterEdit(),
    adblockOn: () => alert('Ad / tracker blocking enabled'),
    adblockOff: () => alert('Ad / tracker blocking disabled'),
    linkNewTab: () => alert('Links will open in new tabs'),
    linkCurrentTab: () => alert('Links will open in the current tab'),
  };
  // 主进程回传的菜单动作：工具有 act 表；书签右键菜单用 bm: 前缀单独分发
  if (BAPI && BAPI.onMenuCmd) BAPI.onMenuCmd((a) => {
    if (typeof a === 'string' && a.indexOf('bm:') === 0) { onBmMenuCmd(a); return; }
    const f = act[a]; if (f) f();
  });
  $('winClose').onclick = () => BAPI && BAPI.close();
  $('winMin').onclick = () => BAPI && BAPI.minimize();
  $('winMax').onclick = () => BAPI && BAPI.toggleMaximize();
  $('pinBtn').onclick = () => BAPI && BAPI.toggleTop();
  $('back').onclick = () => BAPI && BAPI.back();
  $('fwd').onclick = () => BAPI && BAPI.forward();
  $('reload').onclick = () => { const st = current; if (st && st.loading) BAPI.stop(); else BAPI.reload(); };
  $('addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goSmart($('addr').value.trim());
    }
  });
  // 地址栏智能识别：像 URL 就打开，本地路径自动补 file://，否则转 Bing 搜索
  function looksLikeUrl(raw) {
    // 模板字面量中正则须用双反斜杠（\\d 等），否则转义被外层模板吃掉导致脚本 SyntaxError
    if (/^[a-z][a-z0-9+.-]*:\\/\\//i.test(raw)) return true;
    if (/^(localhost|127(\\.\\d{1,3}){3}|\\[[0-9a-f:]+\\])(:\\d+)?(\\/|$)/i.test(raw)) return true;
    if (/^[\\w-]+(\\.[\\w-]+)+(:\\d+)?(\\/[^\\s]*)?$/i.test(raw)) return true;
    return false;
  }
  function looksLikeLocalPath(raw) {
    if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('~/')) return true;
    // 带常见本地文件扩展名且含路径分隔符（排除纯文件名被误判成域名）
    if (raw.includes('/') && /\\.(pdf|html?|md|txt|png|jpe?g|gif|webp|svg|json|csv|xlsx?|docx?|pptx?)$/i.test(raw)) return true;
    return false;
  }
  function goSmart(raw) {
    if (!raw) return;
    if (looksLikeUrl(raw)) {
      if (!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(raw)) raw = 'https://' + raw;
      BAPI && BAPI.navigate(raw);
    } else if (looksLikeLocalPath(raw)) {
      // 本地路径：主进程 navigate 负责补全 file:// 前缀（含 ~ 展开）
      BAPI && BAPI.navigate(raw);
    } else {
      BAPI && BAPI.navigate('https://www.bing.com/search?q=' + encodeURIComponent(raw) + '&mkt=zh-CN');
    }
  }
  /* ===== 顶部加载进度条（由主进程广播的 loading 状态驱动） ===== */
  const pb = $('progbar');
  let pbTimer = null;
  let pbVal = 0;
  function progStart() {
    if (!pb || pbTimer) return;
    pbVal = 0;
    pb.classList.add('on');
    pb.style.width = '0%';
    // 页面不提供真实进度，用"越接近 90% 爬升越慢"模拟，等 loading 结束再收尾
    pbTimer = setInterval(() => {
      pbVal += Math.max(0.5, (90 - pbVal) * 0.06);
      if (pbVal > 90) pbVal = 90;
      pb.style.width = pbVal.toFixed(1) + '%';
    }, 120);
  }
  function progDone() {
    if (!pb) return;
    clearInterval(pbTimer); pbTimer = null;
    pb.style.width = '100%';
    setTimeout(() => {
      pb.classList.remove('on');
      setTimeout(() => { if (!pbTimer) pb.style.width = '0%'; }, 320);
    }, 180);
  }
  let current = null;
  let curFavicon = ''; // 当前激活标签的 favicon，收藏时随书签一起落盘
  let lastStateUrl = null;
  const applyState = (s) => {
    current = s;
    if (s.loading) progStart(); else progDone();
    $('back').disabled = !s.canGoBack;
    $('fwd').disabled = !s.canGoForward;
    // 起始页（data: 新建标签页）时地址栏留空，只显示占位文案，不展示那串 data: URL
    const isNewTab = (s.url || '').startsWith('data:text/html');
    if (document.activeElement !== $('addr')) $('addr').value = isNewTab ? '' : (s.url || '');
    document.title = 'Hippo Browser';
    $('pinBtn').classList.toggle('active', !!s.alwaysOnTop);
    $('pinBtn').title = s.alwaysOnTop ? 'Turn off always-on-top' : 'Always on top';
    // 状态广播很频繁：仅 URL 变化时才拉取书签并重建书签栏 DOM，其余只更新 ★ 高亮状态
    const u = s.url || '';
    if (u !== lastStateUrl) { lastStateUrl = u; refreshBmStar(); }
    else refreshStar();
  };
  if (BAPI) {
    BAPI.onState(applyState);
    BAPI.getState().then((s) => { if (s) applyState(s); });
  }

  /* ===== 书签（标签栏 = 标星的网址） ===== */
  let bmAry = [];
  let bmEditing = false; // 重命名进行中：暂停书签栏重建，避免状态广播把输入框冲掉
  function isNewTabUrl(u) { return (u || '').startsWith('data:text/html'); }
  function renderBmTabs() {
    const tabs = $('bmtabs'); if (!tabs) return;
    if (bmEditing) return;
    tabs.innerHTML = '';
    if (!bmAry || !bmAry.length) {
      const empty = document.createElement('span'); empty.className = 'bmEmpty';
      empty.textContent = 'No bookmarks — click ★ in the address bar to bookmark this page'; tabs.appendChild(empty); return;
    }
    bmAry.forEach((b) => {
      // 不加当前页高亮：当前浏览位置已由上方标签条（.tbtab.cur）标示，书签栏重复高亮反而误导
      const tab = document.createElement('span'); tab.className = 'bmtab';
      tab.title = b.url;
      const fav = document.createElement('img'); fav.className = 'fav'; fav.alt = '';
      let favSrc = b.favicon || '';
      if (!favSrc) {
        // 老书签没存图标：退回站点根 favicon.ico，加载失败（onerror）再隐藏，不留破图
        try { const o = new URL(b.url).origin; if (o && o !== 'null') favSrc = o + '/favicon.ico'; } catch (_) { /* 非标准 URL 忽略 */ }
      }
      if (favSrc) { fav.src = favSrc; fav.onerror = () => { fav.style.visibility = 'hidden'; }; }
      else fav.style.visibility = 'hidden';
      const t = document.createElement('span'); t.className = 't'; t.textContent = b.title || b.url;
      tab.appendChild(fav); tab.appendChild(t);
      // 按工具菜单的「打开方式」开关：默认新标签，切到当前标签时覆盖本页
      tab.addEventListener('click', () => { if (BAPI) BAPI.openLink(b.url); });
      // 重命名 / 删除改由右键原生菜单触发（主进程弹菜单，动作经 menu-cmd 回传）
      tab.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (BAPI && BAPI.bmMenu) BAPI.bmMenu({ url: b.url });
      });
      tabs.appendChild(tab);
    });
  }

  /** 书签：重命名（把标题替换成输入框，回车保存 / Esc 取消） */
  function startRename(b, chip) {
    if (!BAPI || !chip) return;
    bmEditing = true;
    const t = chip.querySelector('.t');
    if (!t) return;
    const input = document.createElement('input');
    input.className = 'bmEdit'; input.value = b.title || b.url; input.spellcheck = false;
    let done = false;
    const commit = async (save) => {
      if (done) return; done = true;
      const val = input.value.trim();
      if (save && val && val !== (b.title || b.url)) {
        try { const r = await BAPI.bmRename({ url: b.url, title: val }); if (r && r.ok) bmAry = r.list; } catch (_) { /* 忽略 */ }
      }
      bmEditing = false;
      renderBmTabs(); refreshStar();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    t.style.display = 'none';
    chip.insertBefore(input, t);
    input.focus(); input.select();
  }

  /** 书签：删除并重建书签栏 */
  async function removeBm(url) {
    if (!BAPI) return;
    const r = await BAPI.bmRemove(url);
    if (r && r.ok) { bmAry = r.list; renderBmTabs(); refreshStar(); }
  }

  /** 书签右键菜单动作回传：形如 bm:rename:https://... —— url 自带冒号，只按首个冒号切分 */
  function onBmMenuCmd(s) {
    const rest = s.slice(3);
    const i = rest.indexOf(':');
    if (i < 0) return;
    const action = rest.slice(0, i);
    const url = rest.slice(i + 1);
    if (action === 'remove') { void removeBm(url); return; }
    if (action === 'rename') {
      const idx = bmAry.findIndex((x) => x.url === url);
      const bar = $('bmtabs');
      if (idx >= 0 && bar) startRename(bmAry[idx], bar.children[idx]);
    }
  }
  function refreshStar() {
    const cu = current ? (current.url || '') : '';
    const marked = !isNewTabUrl(cu) && bmAry.some((b) => b.url === cu);
    $('bm').classList.toggle('on', marked);
    $('bm').title = marked ? 'Remove bookmark' : 'Bookmark this page';
  }
  // 上报工具栏 chrome 实际高度（地址栏 + 标签条 + 书签栏），主进程据此把网页 view 下移到 chrome 之下
  let chromeSent = 0;
  function syncChromeTop() {
    const tb = $('tabbar'); const bm = $('bmtabs'); const fb = $('findbar');
    const a = tb ? Math.ceil(tb.getBoundingClientRect().bottom) : 0;
    const b = bm ? Math.ceil(bm.getBoundingClientRect().bottom) : 0;
    let h = Math.max(a, b, 48);
    if (fb && fb.classList.contains('show')) h = Math.max(h, Math.ceil(fb.getBoundingClientRect().bottom));
    // 下载面板展开时同样下移网页 view，避免面板被不透明 view 盖住
    const dp = $('dlPanel');
    if (dp && dp.classList.contains('show')) h = Math.max(h, Math.ceil(dp.getBoundingClientRect().bottom) + 6);
    if (h !== chromeSent && BAPI) { chromeSent = h; BAPI.setChromeHeight(h); }
  }
  window.addEventListener('resize', syncChromeTop);
  async function refreshBmStar() {
    if (!BAPI) return;
    try { const r = await BAPI.bmList(); if (r && r.ok) { bmAry = r.list; } } catch { return; }
    refreshStar();
    renderBmTabs();
    syncChromeTop();
  }
  $('bm').onclick = async () => {
    if (!BAPI) return;
    const cu = current ? (current.url || '') : '';
    if (!cu || isNewTabUrl(cu)) return;
    const title = (current && current.title) ? current.title : cu;
    const r = await BAPI.bmToggle({ url: cu, title, favicon: curFavicon });
    if (r && r.ok) { bmAry = r.list; refreshStar(); renderBmTabs(); }
  };

  /* ===== 页面查找条（Ctrl/Cmd+F 打开，Enter/Shift+Enter 上下切换，Esc 关闭） ===== */
  function openFind() {
    $('findbar').classList.add('show');
    $('findInput').value = '';
    $('findCnt').textContent = '';
    $('findInput').focus();
    syncChromeTop();
  }
  function closeFind() {
    $('findbar').classList.remove('show');
    $('findCnt').textContent = '';
    if (BAPI) BAPI.findStop();
    syncChromeTop();
  }
  function doFind(dir) {
    const q = $('findInput').value;
    if (!q) { $('findCnt').textContent = ''; return; }
    if (dir === true) { if (BAPI) BAPI.findNext(q, true); }
    else if (dir === false) { if (BAPI) BAPI.findNext(q, false); }
    else if (BAPI) {
      BAPI.find(q).then((r) => {
        $('findCnt').textContent = r && r.ok && r.matches ? ((r.active || 1) + '/' + r.matches) : 'No results';
      });
    }
  }
  let findTimer = null;
  $('findInput').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => doFind(), 200); });
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey ? false : true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('findPrev').onclick = () => doFind(false);
  $('findNextBtn').onclick = () => doFind(true);
  $('findClose').onclick = () => closeFind();
  // 工具栏聚焦时的 Ctrl/Cmd+F；网页内 Ctrl/Cmd+F 由主进程经 onFindOpen 转发
  // 只认单个修饰键（meta XOR ctrl）：避免 Ctrl+Cmd+F（macOS 全屏）被误命中弹出查找条
  const isFindChord = (e) => (e.metaKey !== e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f';
  document.addEventListener('keydown', (e) => {
    if (isFindChord(e)) {
      e.preventDefault(); openFind();
    } else if (e.key === 'Escape' && $('findbar').classList.contains('show')) {
      e.preventDefault(); closeFind();
    }
  });
  if (BAPI && BAPI.onFindOpen) BAPI.onFindOpen(openFind);
  // ⌘L：主进程转发，聚焦并全选地址栏
  if (BAPI && BAPI.onFocusAddr) BAPI.onFocusAddr(() => { $('addr').focus(); $('addr').select(); });

  /* ===== 多标签条 ===== */
  function renderTabs(data) {
    const bar = $('tabbar'); if (!bar) return;
    bar.innerHTML = '';
    const list = (data && data.tabs) || [];
    curFavicon = '';
    list.forEach((t) => {
      const chip = document.createElement('span'); chip.className = 'tbtab' + (t.id === data.active ? ' cur' : '');
      chip.title = t.url || 'New Tab';
      if (t.id === data.active) curFavicon = t.favicon || '';
      const fav = document.createElement('img'); fav.className = 'fav'; fav.alt = '';
      if (t.favicon) fav.src = t.favicon; else fav.style.visibility = 'hidden';
      const lab = document.createElement('span'); lab.className = 't'; lab.textContent = t.title || 'New Tab';
      const x = document.createElement('button'); x.className = 'x'; x.title = 'Close tab'; x.textContent = '\u00d7';
      x.onclick = async (e) => { e.stopPropagation(); if (BAPI) await BAPI.closeTab(t.id); };
      chip.appendChild(fav); chip.appendChild(lab); chip.appendChild(x);
      chip.addEventListener('click', () => { if (BAPI) BAPI.activateTab(t.id); });
      bar.appendChild(chip);
    });
    const add = document.createElement('button'); add.className = 'tbadd'; add.title = 'New tab'; add.textContent = '+';
    add.onclick = () => { if (BAPI) BAPI.newTab(); };
    bar.appendChild(add);
    syncChromeTop();
  }
  if (BAPI && BAPI.onTabs) BAPI.onTabs(renderTabs);

  /* ===== 下载面板（面板展开时同步抬高 chrome，网页 view 自动下移让位） ===== */
  let downloads = [];
  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return 'Unknown size';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }
  function dlMetaText(d) {
    if (d.state === 'progressing') {
      if (d.totalBytes > 0) return Math.round((d.receivedBytes / d.totalBytes) * 100) + '% · ' + fmtBytes(d.receivedBytes) + ' / ' + fmtBytes(d.totalBytes);
      return fmtBytes(d.receivedBytes) + ' / unknown size';
    }
    if (d.state === 'completed') return 'Done · ' + fmtBytes(d.totalBytes || d.receivedBytes);
    if (d.state === 'cancelled') return 'Cancelled';
    return 'Interrupted';
  }
  function renderDownloads() {
    const list = $('dlList'); if (!list) return;
    const running = downloads.filter((d) => d.state === 'progressing').length;
    const badge = $('dlBadge');
    if (badge) { badge.textContent = String(running); badge.classList.toggle('show', running > 0); }
    list.innerHTML = '';
    if (!downloads.length) {
      const empty = document.createElement('div'); empty.className = 'dlEmpty'; empty.textContent = 'No downloads';
      list.appendChild(empty); syncChromeTop(); return;
    }
    downloads.forEach((d) => {
      const item = document.createElement('div'); item.className = 'dlItem';
      const main = document.createElement('div'); main.className = 'dlMain';
      const name = document.createElement('div'); name.className = 'dlName';
      name.textContent = d.fileName || d.url; name.title = d.savePath || d.url;
      const meta = document.createElement('div'); meta.className = 'dlMeta'; meta.textContent = dlMetaText(d);
      main.appendChild(name); main.appendChild(meta);
      if (d.state === 'progressing' && d.totalBytes > 0) {
        const pg = document.createElement('div'); pg.className = 'dlProg';
        const fill = document.createElement('i');
        fill.style.width = Math.max(2, Math.min(100, (d.receivedBytes / d.totalBytes) * 100)) + '%';
        pg.appendChild(fill); main.appendChild(pg);
      }
      item.appendChild(main);
      const acts = document.createElement('div'); acts.className = 'dlAct';
      if (d.state === 'progressing') {
        const c = document.createElement('button'); c.className = 'dlAb'; c.textContent = 'Cancel';
        c.onclick = (e) => { e.stopPropagation(); if (BAPI) BAPI.downloadCancel(d.id); };
        acts.appendChild(c);
      } else {
        const o = document.createElement('button'); o.className = 'dlAb primary'; o.textContent = 'Open';
        o.onclick = (e) => {
          e.stopPropagation();
          if (BAPI) BAPI.downloadOpen(d.id).then((r) => { if (r && !r.ok && r.error) alert(r.error); }).catch(() => {});
        };
        acts.appendChild(o);
        if (d.state === 'completed') {
          const rv = document.createElement('button'); rv.className = 'dlAb'; rv.textContent = 'Reveal';
          rv.onclick = (e) => { e.stopPropagation(); if (BAPI) BAPI.downloadReveal(d.id); };
          acts.appendChild(rv);
        }
      }
      item.appendChild(acts);
      list.appendChild(item);
    });
    syncChromeTop();
  }
  function setDlPanel(show) {
    const p = $('dlPanel'); if (!p) return;
    p.classList.toggle('show', show);
    syncChromeTop();
    if (show && BAPI) {
      BAPI.downloadsList().then((r) => { if (r && r.downloads) { downloads = r.downloads; renderDownloads(); } }).catch(() => {});
    }
  }
  $('dlBtn').onclick = (e) => { e.stopPropagation(); setDlPanel(!$('dlPanel').classList.contains('show')); };
  $('dlClose').onclick = (e) => { e.stopPropagation(); setDlPanel(false); };
  $('dlClear').onclick = (e) => {
    e.stopPropagation();
    if (!BAPI) return;
    BAPI.downloadClear().then((r) => { if (r && r.downloads) { downloads = r.downloads; renderDownloads(); } }).catch(() => {});
  };
  // 点击面板/按钮之外收起（网页区域由 WebContentsView 覆盖，不触发本层事件，用 Esc 兜底）
  document.addEventListener('click', (e) => {
    const p = $('dlPanel'); if (!p || !p.classList.contains('show')) return;
    const t = e.target;
    if (t && t.closest && (t.closest('.dlWrap') || t.closest('.dlPanel'))) return;
    setDlPanel(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('dlPanel').classList.contains('show')) { e.preventDefault(); setDlPanel(false); }
  });
  if (BAPI && BAPI.onDownloads) BAPI.onDownloads((data) => { downloads = (data && data.downloads) || []; renderDownloads(); });

  /* ===== HTML 编辑器 ===== */
  let editing = false;
  let edFilePath = '';
  const $ed = (id) => document.getElementById(id);
  async function enterEdit() {
    console.log('enterEdit called');
    if (!BAPI) return;
    const r = await BAPI.htmlEditStart();
    if (!r || !r.ok) { alert((r && r.error) || 'Unable to read page HTML'); return; }
    edFilePath = r.filePath || '';
    $ed('edSrc').value = r.source || '';
    $ed('edInst').value = '';
    $ed('edStatus').textContent = r.filePath ? 'Source loaded (saving writes back to the original file)' : 'Source loaded (no local file; saving is preview-only)';
    setPreview(false);
    document.body.classList.add('editing');
    editing = true;
  }
  function setPreview(on) {
    if (on) { $ed('edFrame').srcdoc = $ed('edSrc').value; $ed('edPreviewPane').classList.add('on'); $ed('edSrc').style.display = 'none'; $ed('edPreview').textContent = 'Back to code'; }
    else { $ed('edPreviewPane').classList.remove('on'); $ed('edSrc').style.display = ''; $ed('edPreview').textContent = 'Preview'; }
    // 切预览：清空已选元素与高亮
    try { const doc = $ed('edFrame').contentDocument; if (doc && doc.querySelectorAll) doc.querySelectorAll('.bob-insp-hover,.bob-insp-selected').forEach((n) => n.classList.remove('bob-insp-hover', 'bob-insp-selected')); } catch {}
    selElem = null; inspHc = null; $ed('edElem').textContent = '';
  }
  function exitEdit() {
    if (!editing) return;
    editing = false;
    document.body.classList.remove('editing');
    BAPI && BAPI.htmlEditExit();
  }
  $ed('edClose').onclick = () => { if (!editing || confirm('Exit the editor? Unsaved changes will be lost.')) exitEdit(); };
  $ed('edPreview').onclick = () => setPreview(!$ed('edPreviewPane').classList.contains('on'));
  $ed('edSave').onclick = async () => {
    if (!editing) return;
    $ed('edStatus').textContent = 'Saving…';
    const r = await BAPI.htmlEditSave({ html: $ed('edSrc').value });
    $ed('edStatus').textContent = (r && r.ok) ? 'Saved' : ((r && r.error) || 'Save failed');
  };

  /* ===== 元素级 AI 编辑：预览 iframe 内悬停高亮 + 点选元素（与预览面板 HtmlViewer 一致） ===== */
  let insp = false;
  let selElem = null;
  let inspHc = null;
  function cssSel(v) { return String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function nodeSel(el) {
    const parts = []; let n = el;
    while (n && n.nodeType === 1 && n !== el.ownerDocument.body) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += '#' + cssSel(n.id);
      else {
        const p = n.parentElement;
        if (p) { const same = Array.prototype.slice.call(p.children).filter((c) => c.tagName === n.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
      }
      parts.unshift(s); if (n.id) break; n = n.parentElement;
    }
    return parts.join(' > ');
  }
  function bindInspector() {
    try {
      const fr = $ed('edFrame');
      const doc = fr.contentDocument; if (!doc) return;
      const clean = () => { if (inspHc && inspHc.className) { inspHc.classList.remove('bob-insp-hover'); inspHc = null; } };
      fr.contentWindow.addEventListener('mouseover', (e) => { if (!insp) return; clean(); const t = e.target; if (t && t.nodeType === 1) { t.classList.add('bob-insp-hover'); inspHc = t; } }, false);
      fr.contentWindow.addEventListener('mouseout', () => { if (insp) clean(); }, false);
      fr.contentWindow.addEventListener('click', (e) => {
        if (!insp) return; e.preventDefault(); e.stopPropagation(); clean();
        const t = e.target; if (!t || t.nodeType !== 1) return;
        if (t.ownerDocument && t.ownerDocument.querySelectorAll) t.ownerDocument.querySelectorAll('.bob-insp-selected').forEach((n) => n.classList.remove('bob-insp-selected'));
        t.classList.add('bob-insp-selected');
        selElem = { selector: nodeSel(t), outerHTML: t.outerHTML };
        const tag = t.tagName.toLowerCase();
        $ed('edElem').textContent = 'Selected ' + tag + ' ' + (selElem.selector.length > 30 ? selElem.selector.slice(0, 30) + '…' : selElem.selector);
        $ed('edElem').title = selElem.outerHTML.slice(0, 400);
        $ed('edStatus').textContent = 'Element selected — enter an instruction and click "AI Edit" to modify only it';
      }, false);
    } catch { /* 不同源则忽略（当前 srcdoc 与工具栏同源，正常可达） */ }
  }
  $ed('edFrame').addEventListener('load', () => { if (insp) bindInspector(); });
  $ed('edInsp').onclick = () => {
    insp = !insp; $ed('edInsp').classList.toggle('active', insp);
    if (!insp) {
      selElem = null;
      try { const doc = $ed('edFrame').contentDocument; if (doc && doc.querySelectorAll) doc.querySelectorAll('.bob-insp-hover,.bob-insp-selected').forEach((n) => n.classList.remove('bob-insp-hover', 'bob-insp-selected')); } catch {}
      $ed('edElem').textContent = '';
      $ed('edStatus').textContent = 'Element selection exited (AI edit will apply to the whole page)';
    } else {
      $ed('edStatus').textContent = $ed('edPreviewPane').classList.contains('on') ? 'Click an element in the preview' : 'Click "Preview" first, then pick an element';
      if ($ed('edPreviewPane').classList.contains('on')) bindInspector();
    }
  };

  $ed('edAi').onclick = async () => {
    const inst = $ed('edInst').value.trim();
    if (!inst) { $ed('edStatus').textContent = 'Enter an AI edit instruction first'; return; }
    const html = $ed('edSrc').value;
    const elementMode = insp && selElem;
    const payload = elementMode
      ? { html, instruction: inst, mode: 'element', element: selElem }
      : { html, instruction: inst };
    $ed('edStatus').textContent = elementMode ? 'AI editing selected element…' : 'AI editing…';
    $ed('edAi').disabled = true;
    await BAPI.htmlEditAi(payload);
  };
  /* ===== 就地 AI 编辑：✨ 开启后在网页上点选元素，由主进程弹出 AI 编辑弹窗 ===== */
  let inline = false;
  $ed('aiEd').onclick = async () => {
    inline = !inline;
    console.log('aiEd toggled ->', inline);
    if (inline) {
      const r = await BAPI.inlineStart();
      if (!r || !r.ok) { inline = false; alert((r && r.error) || 'Unable to start in-place editing'); return; }
      $ed('aiEd').classList.add('active');
    } else {
      await BAPI.inlineExit();
      $ed('aiEd').classList.remove('active');
    }
  };

  if (BAPI) {
    BAPI.onHtmlAiEdit((base) => {
      const ev = (typeof base === 'string') ? JSON.parse(base) : base;
      if (ev.type === 'done') {
        $ed('edAi').disabled = false;
        if (ev.html) { $ed('edSrc').value = ev.html; $ed('edStatus').textContent = 'AI edit complete'; }
        else $ed('edStatus').textContent = ev.error || 'AI edit failed';
      } else if (ev.type === 'error') {
        $ed('edAi').disabled = false;
        $ed('edStatus').textContent = ev.message || 'AI edit error';
      }
    });
  }
</script>
</body></html>`;
}

/**
 * 新建标签页默认页（data: URL）。
 * 让浏览器打开即显示一个干净的空状态，而不是停在 about:blank 白屏。
 * 导航统一走顶部工具栏的地址栏，页面内不再放重复的输入框。
 */
function newTabDataUrl(): string {
  const hippo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAAGQCAYAAACAvzbMAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAUGVYSWZNTQAqAAAACAACARIAAwAAAAEAAQAAh2kABAAAAAEAAAAmAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAAGQoAMABAAAAAEAAAGQAAAAAAnsQdIAAAI0aVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIgogICAgICAgICAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyI+CiAgICAgICAgIDxleGlmOlBpeGVsWURpbWVuc2lvbj4yMDQ4PC9leGlmOlBpeGVsWURpbWVuc2lvbj4KICAgICAgICAgPGV4aWY6UGl4ZWxYRGltZW5zaW9uPjIwNDg8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpDb2xvclNwYWNlPjE8L2V4aWY6Q29sb3JTcGFjZT4KICAgICAgICAgPHRpZmY6T3JpZW50YXRpb24+MTwvdGlmZjpPcmllbnRhdGlvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+Cv9RK5kAAEAASURBVHgB7H0HoBbF1fa85fbC5dJ7R0CagAJWooLBAjZIjDFYIiYmJrEk+aN+UdNM0cSWojFGky8x0STmM/ZKFEWlWEBUOlKkt8vl1vfd/3nOmdnd9wJ24KIz9+7u7MyZc86cffc503bXGB+8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAW8BbwFvAXejwUS74fI0+w7CwRBwGuUuO2221L//ve/k9Rk4cKFolCfPsb07j3eTJkyJTt8+PAMEoNEIhFIpt/tNQvYa2TMNJO6+V83px5e9HAoe6FZaHCZcKH6mPF9xpuLLrqI1ymLzV8r2sWH/doC3oE008tHUDr++OPzp0+fXlZbW9s5k8mMhKpt6UGy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';
  const html = `<!DOCTYPE html><html>
<head><meta charset="utf-8" /><title>New Tab</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  html,body { height:100%; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:linear-gradient(160deg,#f7f7fb 0%,#eeeeff 100%); display:flex; align-items:center; justify-content:center; }
  .bg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
  .bg img { width:min(40vw,320px); height:auto; opacity:.94; pointer-events:none; }
</style></head>
<body><div class="bg"><img src="${hippo}" alt="" /></div></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ============ IPC（模块加载时注册一次） ============

ipcMain.handle('hippo-browser:get-state', () => currentState());
ipcMain.handle('hippo-browser:open', () => { reveal(); return currentState(); });
ipcMain.handle('hippo-browser:close', () => { if (win && !win.isDestroyed()) win.hide(); broadcastState(); return currentState(); });
ipcMain.handle('hippo-browser:capsule-toggle', () => {
  if (win && !win.isDestroyed()) {
    if (capsuleMode) reveal();
    else collapseToCapsule();
  }
  return currentState();
});
// 切页自动收起：渲染层在 BobWork 切换页面时调用（幂等）。
// 仅当窗口可见、未收起、且没有被用户操作（无焦点）时才收起，
// 避免误伤：用户已关闭窗口 / 正在浏览器里输入 时都不动它。
ipcMain.handle('hippo-browser:collapse', () => {
  if (win && !win.isDestroyed() && !capsuleMode && win.isVisible() && !win.isFocused()) {
    collapseToCapsule();
  }
  return currentState();
});
ipcMain.handle('hippo-browser:get-capsule', () => capsuleMode);
ipcMain.handle('hippo-browser:toggle-top', () => {
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(!win.isAlwaysOnTop());
    broadcastState();
  }
  return currentState();
});
ipcMain.handle('hippo-browser:toggle', () => {
  if (win && !win.isDestroyed()) {
    if (win.isVisible()) win.hide();
    else reveal();
  }
  broadcastState();
  return currentState();
});
ipcMain.handle('hippo-browser:navigate', (_e, url: string) => {
  let target = typeof url === 'string' ? url.trim() : '';
  if (!target) return { ok: false, error: 'Address cannot be empty' };
  // 本地路径自动补全 file:// 前缀：~/x → <home>/x；/绝对路径与含扩展名的相对路径按主目录解析
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    if (target === '~' || target.startsWith('~/')) {
      target = 'file://' + join(homedir(), target.slice(1));
    } else if (target.startsWith('/')) {
      target = pathToFileURL(target).href;
    } else if (target.includes('/') && /\.(pdf|html?|md|txt|png|jpe?g|gif|webp|svg|json|csv|xlsx?|docx?|pptx?)$/i.test(target)) {
      target = pathToFileURL(join(homedir(), target)).href;
    }
  }
  // 本地文档（PDF/图片）：重定向到内置查看页（批注阅读器 / 图片查看标注编辑）
  const viewerUrl = localFileToViewerUrl(normalizeFileUrl(target));
  if (viewerUrl) target = viewerUrl;
  if (!isAllowedUrl(target)) return { ok: false, error: 'Only http/https/file links are supported' };
  // PDF/图片等本地文档查看页及本地 file: 文件（含 HTML）在新标签打开，普通网页仍在当前标签
  if (isLocalViewer(target) || /^file:\/\//i.test(target)) {
    openInNewTab(target);
  } else {
    requireView().loadURL(target).catch(() => {});
    reveal();
  }
  return { ok: true };
});
// 书签栏点击：按「打开方式」开关决定新标签还是覆盖当前标签（地址栏仍走 navigate 覆盖当前标签）
ipcMain.handle('hippo-browser:open-link', (_e, url: string) => openLinkByMode(url));
ipcMain.handle('hippo-browser:back', () => { back(); return { ok: true }; });
ipcMain.handle('hippo-browser:forward', () => { forward(); return { ok: true }; });
ipcMain.handle('hippo-browser:reload', () => { requireView().reload(); return { ok: true }; });
ipcMain.handle('hippo-browser:stop', () => { requireView().stop(); return { ok: true }; });
ipcMain.handle('hippo-browser:find', (_e, text: string) => {
  const wc = requireView();
  const q = String(text ?? '');
  if (!q) { wc.stopFindInPage('clearSelection'); return { ok: true, matches: 0 }; }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wc.removeListener('found-in-page', onFound); resolve({ ok: true, matches: 0, stale: true }); }, 3000);
    const onFound = (_ev: Electron.Event, r: Electron.FoundInPageResult) => {
      clearTimeout(timer);
      wc.removeListener('found-in-page', onFound);
      resolve({ ok: true, matches: r.matches, active: r.activeMatchOrdinal });
    };
    wc.on('found-in-page', onFound);
    wc.findInPage(q, { findNext: false });
  });
});
ipcMain.handle('hippo-browser:find-next', (_e, text: string, forward: boolean) => {
  const wc = requireView();
  const q = String(text ?? '');
  if (!q) return { ok: true, matches: 0 };
  wc.findInPage(q, { findNext: true, forward });
  return { ok: true };
});
ipcMain.handle('hippo-browser:find-stop', () => { requireView().stopFindInPage('clearSelection'); return { ok: true }; });
ipcMain.handle('hippo-browser:extract', async () => {
  try { return { ok: true, ...(await extractContent()) }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
});
ipcMain.handle('hippo-browser:capture', async (_e, opts?: { fullPage?: boolean }) => {
  try { return { ok: true, dataUrl: await capture(opts ?? {}) }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
});
ipcMain.handle('hippo-browser:print', () => printPage());
ipcMain.handle('hippo-browser:html-edit-start', async () => {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Hippo Browser is not initialized' };
  const url = wc.getURL();
  let source = '';
  let filePath = '';
  try {
    if (url.startsWith('file:')) {
      filePath = fileURLToPath(url);
      if (!existsSync(filePath)) return { ok: false, error: 'File not found' };
      source = readFileSync(filePath, 'utf8');
    } else if (url.startsWith('data:text/html')) {
      source = decodeURIComponent(url.replace(/^data:text\/html(?:;charset[^,]*)?,/, ''));
    } else {
      source = await wc.executeJavaScript('document.documentElement.outerHTML');
    }
  } catch (err) {
    return { ok: false, error: 'Failed to read page HTML: ' + (err instanceof Error ? err.message : String(err)) };
  }
  setViewVisible(false);
  return { ok: true, source, filePath };
});
ipcMain.handle('hippo-browser:html-edit-exit', () => {
  setViewVisible(true);
  return { ok: true };
});
ipcMain.handle('hippo-browser:html-edit-save', (_e, payload: { html?: string; filePath?: string }) => {
  try {
    const fp = payload?.filePath;
    if (!fp || typeof fp !== 'string') return { ok: false, error: 'No local file for this page; cannot save' };
    if (!existsSync(fp)) return { ok: false, error: 'Target file not found' };
    writeFileSync(fp, payload.html ?? '', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Save failed: ' + (err instanceof Error ? err.message : String(err)) };
  }
});
ipcMain.handle('hippo-browser:html-edit-ai', async (_e, payload: { html?: string; instruction?: string; mode?: string; element?: { selector: string; outerHTML: string } }) => {
  const wc = win?.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Window not ready' };
  const html = payload?.html ?? '';
  const instruction = payload?.instruction ?? '';
  if (!html || !instruction) return { ok: false, error: 'Missing html or instruction' };
  const mode = payload?.mode === 'element' ? 'element' : 'document';
  const element = mode === 'element' ? payload?.element : undefined;
  if (mode === 'element' && (!element?.selector || !element?.outerHTML)) return { ok: false, error: 'Element mode requires a selected element' };
  const send = (ev: Record<string, unknown>) => { try { wc.send('hippo-browser:html-edit-ai-event', JSON.stringify(ev)); } catch { /* 忽略 */ } };
  send({ type: 'start' });
  try {
    const res = await fetch(aiServerUrl + '/api/ai-edit/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, instruction, mode, element }),
    }).catch((e) => { throw new Error('Cannot reach the AI service: ' + e.message); });
    if (!res.ok || !res.body) { send({ type: 'error', message: 'AI service error, HTTP ' + res.status }); return { ok: true }; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalHtml = '';
    let finalError = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let ev: { type?: string; success?: boolean; html?: string; error?: string; message?: string };
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'done' || ev.success === true) { if (ev.html) finalHtml = ev.html; if (ev.error) finalError = ev.error; }
        else if (ev.type === 'error' || ev.success === false) { finalError = ev.message || ev.error || 'AI edit failed'; }
      }
    }
    if (finalHtml) { send({ type: 'done', html: finalHtml }); }
    else send({ type: 'done', error: finalError || 'AI returned no valid result' });
    return { ok: true };
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return { ok: true };
  }
});
ipcMain.handle('hippo-browser:inline-start', async () => {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Hippo Browser is not initialized' };
  const url = wc.getURL();
  inlineSel = null;
  inlineFile = '';
  inlineSource = '';
  if (url.startsWith('file:')) {
    inlineFile = fileURLToPath(url);
    inlineSource = existsSync(inlineFile) ? readFileSync(inlineFile, 'utf8') : '';
  } else if (url.startsWith('data:text/html')) {
    inlineSource = decodeURIComponent(url.replace(/^data:text\/html(?:;charset[^,]*)?,/, ''));
  } else {
    try { inlineSource = await wc.executeJavaScript('document.documentElement.outerHTML', true); } catch { inlineSource = ''; }
  }
  try { await wc.executeJavaScript(INLINE_SCRIPT, true); } catch { /* 忽略 */ }
  inlineMode = true;
  return { ok: true, filePath: inlineFile };
});
ipcMain.handle('hippo-browser:inline-exit', () => {
  if (view?.webContents && !view.webContents.isDestroyed()) {
    try { view.webContents.executeJavaScript('window.__bobInspecting=false;window.__bobSel=null;', true); } catch { /* 忽略 */ }
  }
  closeAiEditPopup();
  inlineMode = false; inlineSel = null; inlineSource = ''; inlineFile = '';
  return { ok: true };
});
ipcMain.handle('hippo-browser:inline-edit', async (_e, payload: { instruction?: string }) => runInlineAiEdit(payload?.instruction));
ipcMain.handle('hippo-browser:aiedit-go', async (_e, payload: { instruction?: string }) => {
  const r = await runInlineAiEdit(payload?.instruction);
  if (aieditWin && !aieditWin.isDestroyed() && !aieditWin.webContents.isDestroyed()) {
    aieditWin.webContents.send('hippo-browser:aiedit-done', { ok: r.ok, html: r.html, error: r.error });
  }
  return r;
});
/** 就地编辑成功后，把更新后的整页自动写回本地 file:// 原文稿（自动保存）。
 *  写前临时清除就地检选高亮的内联样式，避免污染文件；写后恢复选中高亮。 */
async function persistInlineHtml(wc: Electron.WebContents): Promise<boolean> {
  const fp = inlineFile;
  if (!fp || !existsSync(fp)) return false;
  const sel = JSON.stringify(inlineSel?.selector);
  try {
    await wc.executeJavaScript(`(()=>{
      try {
        document.querySelectorAll('*').forEach(function(e){
          var o = e.style && e.style.outline, b = e.style && e.style.background;
          if (o && /2px dashed rgb\\(107, 92, 240\\)/.test(o)) { e.style.outline=''; }
          if (b && b.indexOf('rgba(107, 92, 240, 0.12)') > -1) { e.style.background=''; }
          if (o === '2px solid rgb(224, 72, 61)') { e.style.outline=''; }
          if (b && b.indexOf('rgba(224, 72, 61, 0.12)') > -1) { e.style.background=''; }
        });
        return true;
      } catch(e){ return false; }
    })()`, true);
    const html = await wc.executeJavaScript('document.documentElement.outerHTML', true);
    writeFileSync(fp, html, 'utf8');
    if (inlineSel?.selector) {
      await wc.executeJavaScript(`(()=>{ try { var e = document.querySelector(${sel}); if (e) { e.style.outline='2px solid #e0483d'; e.style.outlineOffset='-1px'; e.style.background='rgba(224,72,61,.12)'; } return true; } catch(e){ return true; } })()`, true);
    }
    return true;
  } catch { return false; }
}
/** 直替：就地替换元素文字（preserve=保留子标签按比例分配；plain=整段替换） */
ipcMain.handle('hippo-browser:aiedit-replace', async (_e, payload: { instruction?: string; style?: string }) => {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Not initialized' };
  if (!inlineSel) return { ok: false, error: 'Select an element on the page first' };
  const instruction = (payload?.instruction ?? '').trim();
  const plain = payload?.style === 'plain';
  const sel = JSON.stringify(inlineSel.selector);
  const text = JSON.stringify(instruction);
  const js = `(()=>{
    const el = document.querySelector(${sel});
    if (!el) return false;
    const text = ${text};
    const dist = (n) => {
      const nodes = []; const walk = (c) => { c.childNodes.forEach((x) => {
        if (x.nodeType === 3) { if ((x.textContent || '').trim()) nodes.push(x); }
        else if (x.nodeType === 1) { const t = x.tagName.toUpperCase(); if (t !== 'SCRIPT' && t !== 'STYLE') walk(x); }
      }); };
      walk(n);
      if (!nodes.length) { n.textContent = text; return; }
      const total = nodes.reduce((s, x) => s + (x.textContent || '').length, 0);
      let start = 0;
      for (let i = 0, L = nodes.length; i < L; i++) {
        const len = (nodes[i].textContent || '').length;
        const last = i === L - 1;
        const take = last ? Math.max(0, text.length - start) : Math.round((len / total) * text.length);
        nodes[i].textContent = text.slice(start, start + take); start += take;
      }
    };
    ${plain ? 'el.textContent = text;' : 'dist(el);'}
    return true;
  })()`;
  try {
    await wc.executeJavaScript(js, true);
    const saved = await persistInlineHtml(wc);
    return { ok: true, saved };
  }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
/** AI 优化：请求 text 模式生成纯文字草稿（回填弹窗后可按直替确认） */
ipcMain.handle('hippo-browser:aiedit-optimize', async (_e, payload: { instruction?: string }) => {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Not initialized' };
  if (!inlineSel) return { ok: false, error: 'Select an element on the page first' };
  const instruction = (payload?.instruction ?? '').trim();
  if (!instruction) return { ok: false, error: 'Missing instruction' };
  try {
    const html = inlineSource || await wc.executeJavaScript('document.documentElement.outerHTML', true).catch(() => '');
    const res = await fetch(aiServerUrl + '/api/ai-edit/html', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, instruction, mode: 'text', element: inlineSel }),
    }).catch((e) => { throw new Error('Cannot reach the AI service: ' + e.message); });
    if (!res.ok || !res.body) return { ok: false, error: 'AI service error, HTTP ' + res.status };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; let finalHtml = ''; let finalError = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let ev: { type?: string; success?: boolean; html?: string; error?: string; message?: string };
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'done' || ev.success === true) { if (ev.html) finalHtml = ev.html; if (ev.error) finalError = ev.error; }
        else if (ev.type === 'error' || ev.success === false) { finalError = ev.message || ev.error || 'AI edit failed'; }
      }
    }
    if (finalHtml.trim()) return { ok: true, html: finalHtml.trim() };
    return { ok: false, error: finalError || 'AI generated no draft' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle('hippo-browser:aiedit-cancel', () => {
  closeAiEditPopup();
  if (view?.webContents && !view.webContents.isDestroyed()) {
    try { view.webContents.executeJavaScript('window.__bobInspecting=false;window.__bobSel=null;', true); } catch { /* 忽略 */ }
  }
  inlineMode = false; inlineSel = null; inlineSource = ''; inlineFile = '';
  return { ok: true };
});
ipcMain.handle('hippo-browser:open-external', () => {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Hippo Browser is not initialized' };
  const url = wc.getURL();
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) shell.openExternal(url).catch(() => {});
  return { ok: true };
});
ipcMain.handle('hippo-browser:clear-cookies', async () => {
  try {
    const ses = session.fromPartition('persist:hippo-browser');
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'],
    });
    const cs = ses.cookies;
    const all = await cs.get({});
    const domains = new Set(all.map((c) => c.domain).filter((d): d is string => !!d));
    let clearedCount = 0;
    for (const domain of domains) {
      try { await cs.remove(domain, '*'); clearedCount += 1; } catch { /* 忽略 */ }
    }
    return { ok: true, clearedCount };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle('hippo-browser:set-anchor', () => currentState());

// ============ 多标签 ============
ipcMain.handle('hippo-browser:new-tab', () => {
  if (!win || win.isDestroyed()) return { ok: false, error: 'Not initialized' };
  const t = spawnTab();
  activateTabById(t.id);
  relayoutView();
  reveal();
  return { ok: true };
});
ipcMain.handle('hippo-browser:activate-tab', (_e, id: number) => {
  activateTabById(id);
  return { ok: true };
});
ipcMain.handle('hippo-browser:close-tab', (_e, id: number) => {
  closeTabById(id);
  return { ok: true };
});

// ============ 下载 ============
ipcMain.handle('hippo-browser:downloads-list', () => ({ downloads: downloadsToJson() }));
ipcMain.handle('hippo-browser:download-cancel', (_e, id: number) => {
  downloadItems.get(id)?.cancel();
  return { ok: true };
});
ipcMain.handle('hippo-browser:download-open', async (_e, id: number) => {
  const rec = downloadMap.get(id);
  if (!rec || rec.state !== 'completed' || !rec.savePath) return { ok: false, error: 'Download has not finished yet' };
  const err = await shell.openPath(rec.savePath);
  return err ? { ok: false, error: err } : { ok: true };
});
ipcMain.handle('hippo-browser:download-reveal', (_e, id: number) => {
  const rec = downloadMap.get(id);
  if (rec && rec.savePath) shell.showItemInFolder(rec.savePath);
  return { ok: true };
});
ipcMain.handle('hippo-browser:download-clear', () => {
  for (const [id, rec] of downloadMap) {
    if (rec.state !== 'progressing') downloadMap.delete(id);
  }
  broadcastDownloads();
  return { ok: true, downloads: downloadsToJson() };
});

// ============ 生命周期 ============

/** 收编 shell:openHtml：在独立浏览器窗口打开临时 HTML 文件（成功 true，否则退回系统浏览器） */
export function openHtmlInHippo(filePath: string): boolean {
  if (!view || !win || win.isDestroyed()) return false;
  requireView().loadURL(pathToFileURL(filePath).href).catch(() => {});
  reveal();
  return true;
}

export function isHippoReady(): boolean {
  return !!win && !win.isDestroyed() && !!view && !view.webContents.isDestroyed();
}

/** 收编应用内外部链接（http/https）：在内置浏览器打开（新标签，首开时复用初始空标签）。
 *  Hippo 不可用或非法 URL 返回 false，调用方退回系统默认浏览器。 */
export function openUrlInHippo(url: string): boolean {
  if (!isHippoReady() || !isAllowedUrl(url)) return false;
  openInNewTab(url);
  return true;
}

/** 网页区跟随窗口尺寸：始终占工具栏(chromeTop)下方全部区域 */
function relayoutView(): void {
  if (!win || win.isDestroyed() || !view) return;
  const { width, height } = win.getContentBounds();
  const top = Math.max(HIPPO_TOOLBAR_HEIGHT, chromeTop);
  view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
}
/** 合并连续的窗口尺寸变化：一帧内最多做一次布局，避免拖拽缩放时重复 setBounds */
let relayoutScheduled = false;
function scheduleRelayout(): void {
  if (relayoutScheduled) return;
  relayoutScheduled = true;
  setTimeout(() => { relayoutScheduled = false; relayoutView(); }, 16);
}
/** 编辑 HTML 时隐藏/显示底层网页视图（隐藏后工具栏自带编辑器面板铺满可视区域） */
function setViewVisible(v: boolean): void {
  if (view) view.setVisible(v);
  if (v) relayoutView();
}

// ================= 就地 AI 编辑（不进场码编辑器，直接在网页上点选→AI 改写） =================
/** 就地编辑状态 */
let inlineMode = false;      // 是否处于就地选择/编辑模式
let inlineSource = '';       // 进入时整页源码（作为 AI 上下文）
let inlineFile = '';         // 当前页文件路径（file: 时用于保存）
let inlineSel: { selector: string; outerHTML: string; rect?: { left: number; top: number; width: number; height: number } | null } | null = null; // 最近一次点选的元素

/** 注入网页的 inspector：悬停高亮 + 点选记录（信号通过改 document.title 传回主进程） */
const INLINE_SCRIPT = `
(() => {
  if (window.__bobInspInstalled) { window.__bobInspecting = true; return; }
  try {
    let hc = null, cur = null;
    const esc = (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    const selOf = (el) => { const parts=[]; let n=el; while(n && n.nodeType===1 && n!==document.body){ let s=n.tagName.toLowerCase(); if(n.id){s+='#'+esc(n.id);} else { const p=n.parentElement; if(p){ const same=Array.prototype.slice.call(p.children).filter(c=>c.tagName===n.tagName); if(same.length>1) s+=':nth-of-type('+(same.indexOf(n)+1)+')'; } } parts.unshift(s); if(n.id) break; n=n.parentElement; } return parts.join(' > '); };
    document.addEventListener('mouseover', (e) => { if (!window.__bobInspecting) return; const t=e.target; if (!t || t.nodeType!==1) return; if (t===cur) { if (hc) { hc.style.outline=''; hc.style.background=''; hc=null; } return; } if (hc && hc!==t) { hc.style.outline=''; hc.style.background=''; } t.style.outline='2px dashed #6b5cf0'; t.style.outlineOffset='-2px'; t.style.background='rgba(107,92,240,.12)'; hc=t; }, false);
    document.addEventListener('mouseout', () => { if (!hc) return; if (hc!==cur) { hc.style.outline=''; hc.style.background=''; } hc=null; }, false);
    document.addEventListener('click', (e) => { if (!window.__bobInspecting) return; e.preventDefault(); e.stopPropagation(); if (cur) { cur.style.outline=''; cur.style.background=''; } const t=e.target; if (!t || t.nodeType!==1) return; t.style.outline='2px solid #e0483d'; t.style.outlineOffset='-1px'; t.style.background='rgba(224,72,61,.12)'; cur=t; var _r=t.getBoundingClientRect(); window.__bobSel={ selector: selOf(t), outerHTML: t.outerHTML, rect:{ left:_r.left, top:_r.top, width:_r.width, height:_r.height } }; window.__bobSeq=(window.__bobSeq||0)+1; document.title='\\u2318BOB\\u2318'+window.__bobSeq; }, true);
    window.__bobInspecting = false;
    window.__bobInspInstalled = true;
    window.__bobInspecting = true;
  } catch (e) {}
})();`;

function forwardInlineSel(sel: { selector: string; outerHTML: string; rect?: { left: number; top: number; width: number; height: number } | null }): void {
  void openAiEditPopup(sel);
}
/** 就地 AI 编辑弹窗（独立小窗，浮在网页上方，不藏进工具栏 WebContents） */
let aieditWin: BrowserWindow | null = null;
const AIEDIT_HTML = `
<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html,body { height:100%; margin:0; font-family:-apple-system,"PingFang SC",sans-serif; }
  body { display:flex; flex-direction:column; overflow:hidden; border:1px solid rgba(0,0,0,.1); border-radius:12px; background:#fff; }
  .top { -webkit-app-region: drag; height:34px; display:flex; align-items:center; gap:8px; padding:0 12px; background:#f4f4f6; color:#888; font-size:12px; }
  .dot { width:8px; height:8px; border-radius:50%; background:#6b5cf0; -webkit-app-region:no-drag; animation:pl 1.6s ease-in-out infinite; }
  @keyframes pl { 0%,100%{opacity:1} 50%{opacity:.3} }
  .sel { -webkit-app-region: no-drag; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:#666; }
  .x { -webkit-app-region:no-drag; border:0; background:transparent; color:#888; font-size:16px; cursor:pointer; line-height:1; padding:0 2px; }
  .wrap { padding:10px 12px 10px; display:flex; flex-direction:column; gap:8px; flex:1; min-height:0; }
  textarea { width:100%; flex:1; resize:none; border:1px solid #d9d9e6; border-radius:8px; padding:8px 10px; font-size:13px; outline:none; font-family:inherit; line-height:1.4; min-height:56px; background:#fff; }
  textarea:focus { border-color:#7c6cf0; }
  .modes { display:flex; gap:6px; align-items:center; }
  .modes .gap { flex:1; }
  button { -webkit-app-region:no-drag; height:30px; border-radius:8px; border:1px solid #ddd; background:#fff; font-size:13px; padding:0 12px; cursor:pointer; color:#444; }
  button.primary { background:#6b5cf0; color:#fff; border-color:#6b5cf0; }
  button.danger { color:#e0483d; }
  button:disabled { opacity:.5; cursor:default; }
  .st { min-height:16px; font-size:11px; color:#6b5cf0; }
  .st.err { color:#e0483d; }
  .st.ok { color:#2e9e5b; }
  /* 指针统一为箭头：顶栏是 -webkit-app-region: drag 拖拽区，其内按钮若用
     cursor: pointer，鼠标在拖拽区与按钮间移动时会因命中测试切换而闪烁 */
  html * { cursor: default !important; }
  textarea { cursor: auto !important; }
</style></head><body>
  <div class="top"><span class="dot"></span><span class="sel" id="sel">Click a page element to select…</span><button class="x" id="deselect" title="Clear selection">×</button></div>
  <div class="wrap">
    <textarea id="inst" placeholder="Enter replacement text or an AI edit instruction…" spellcheck="false"></textarea>
    <div class="st" id="st"></div>
    <div class="modes">
      <button id="m1" title="Replace — replace text in place, keeping child tag structure">Replace</button>
      <button id="m2" title="AI Draft — generate a new draft you can edit before applying">AI Draft</button>
      <button id="m3" class="primary" title="Fully rewrite the element with AI">Full Rewrite</button>
      <span class="gap"></span>
      <button id="cancel" class="danger">Cancel</button>
    </div>
  </div>
  <script>
    const BAPI = window.api && window.api.hippoBrowser;
    const $ = (id) => document.getElementById(id);
    let draft = false;
    const st = (t, c) => { const s = $('st'); s.className = 'st ' + (c || ''); s.textContent = t || ''; };
    const busy = (b) => { $('m1').disabled = b; $('m2').disabled = b; $('m3').disabled = b; };
    if (BAPI) BAPI.onAiEditSel((sel) => {
      $('sel').textContent = 'Selected: ' + (sel.selector.length > 52 ? sel.selector.slice(0, 52) + '…' : sel.selector);
      draft = false; busy(false); st(''); $('m2').textContent = 'AI Draft';
    });
    $('deselect').onclick = async () => { $('inst').value = ''; st(''); draft = false; await BAPI.aiEditCancel(); };
    $('cancel').onclick = async () => { await BAPI.aiEditCancel(); };
    $('m1').onclick = async () => {
      try {
        if (!BAPI) { st('window.api.hippoBrowser unavailable', 'err'); return; }
        const v = $('inst').value.trim();
        busy(true); st('Please wait…');
        const r = await BAPI.aiEditReplace(v, draft ? 'plain' : 'preserve');
        draft = false; $('m2').textContent = 'AI Draft'; busy(false);
        if (r && r.ok) st((v ? 'Replaced in place' : 'Text removed') + (r && r.saved ? ', saved ✓' : ' ✓'), 'ok'); else st((r && r.error) || 'Replace failed', 'err');
      } catch (e) { busy(false); st('Error: ' + (e && e.message ? e.message : e), 'err'); } };
    $('m2').onclick = async () => {
      try {
        if (draft) { $('m1').onclick(); return; }
        if (!BAPI) { st('window.api.hippoBrowser unavailable', 'err'); return; }
        const v = $('inst').value.trim(); if (!v) return $('inst').focus();
        busy(true); st('Generating draft…');
        const r = await BAPI.aiEditOptimize(v); busy(false);
        if (r && r.ok && r.html) { $('inst').value = r.html; draft = true; $('m2').textContent = '✓'; st('Draft generated — edit it, then click "Replace" to apply', 'ok'); }
        else st((r && r.error) || 'Draft generation failed', 'err');
      } catch (e) { busy(false); st('Error: ' + (e && e.message ? e.message : e), 'err'); } };
    $('m3').onclick = async () => {
      try {
        const v = $('inst').value.trim(); if (!v) return $('inst').focus();
        if (!BAPI) { st('window.api.hippoBrowser unavailable', 'err'); return; }
        busy(true); $('m3').textContent = '…'; st('AI rewriting…');
        const r = await BAPI.aiEditGo(v); busy(false); $('m3').textContent = 'Full Rewrite'; draft = false;
        if (r && r.ok) st('Full rewrite done ✓', 'ok'); else st((r && r.error) || 'Failed', 'err');
      } catch (e) { busy(false); $('m3').textContent = 'Full Rewrite'; st('Error: ' + (e && e.message ? e.message : e), 'err'); } };
    $('inst').addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (e.metaKey || e.ctrlKey) { e.preventDefault(); $('m1').onclick(); } } });
    $('inst').focus();
  </script>
</body></html>`;
function openAiEditPopup(sel: { selector: string; outerHTML: string; rect?: { left: number; top: number; width: number; height: number } | null }): void {
  const bw = win;
  if (!bw || bw.isDestroyed()) return;
  if (!aieditWin || aieditWin.isDestroyed()) {
    aieditWin = new BrowserWindow({
      width: 500, height: 252, frame: false, resizable: true, show: false,
      alwaysOnTop: true, skipTaskbar: true, parent: bw, visualEffectState: 'active',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: join(__dirname, 'preload.js') },
    });
    aieditWin.setAlwaysOnTop(true, 'floating');
    aieditWin.loadURL(AIEditHtmlUrl());
    aieditWin.on('closed', () => { aieditWin = null; });
  }
  const cb = bw.getContentBounds();               // 窗口内容区（屏幕坐标）
  const vb = view?.getBounds() ?? { x: 0, y: HIPPO_TOOLBAR_HEIGHT, width: 0, height: 0 }; // view 在窗口内的偏移
  const zoom = view?.webContents.getZoomFactor() ?? 1; // 页面缩放，把 CSS 像素换算成屏幕像素
  const r = sel.rect;
  // 选中元素中心的屏幕坐标
  const elCX = cb.x + vb.x + (r ? (r.left + r.width / 2) * zoom : cb.width / 2);
  const elCY = cb.y + vb.y + (r ? (r.top + r.height / 2) * zoom : cb.height / 2);
  const PW = 500, PH = 252, GAP = 8;
  const minY = cb.y + 4;
  const maxBottomY = cb.y + cb.height - 4;
  // 优先放元素正下方；若放不下则翻到上方
  let py = Math.round(elCY + (r ? (r.height / 2) * zoom : 0) + GAP);
  if (py + PH > maxBottomY) py = Math.max(minY, Math.round(elCY - (r ? (r.height / 2) * zoom : 0) - GAP - PH));
  // 水平居中于元素，并收拢到窗口内
  let px = Math.round(elCX - PW / 2);
  px = Math.max(cb.x, Math.min(cb.x + cb.width - PW, px));
  aieditWin.setBounds({ x: px, y: py, width: PW, height: PH });
  const push = () => { if (aieditWin && !aieditWin.isDestroyed() && !aieditWin.webContents.isDestroyed()) aieditWin.webContents.send('hippo-browser:aiedit-sel', sel); };
  if (aieditWin.webContents.isLoading()) aieditWin.webContents.once('did-finish-load', push);
  else push();
  aieditWin.show(); aieditWin.focus();
}
function AIEditHtmlUrl(): string { return 'data:text/html;charset=utf-8,' + encodeURIComponent(AIEditHtml()); }
function AIEditHtml(): string { return AIEDIT_HTML; }
function closeAiEditPopup(): void { if (aieditWin && !aieditWin.isDestroyed()) aieditWin.destroy(); aieditWin = null; }

// ================= 工具下拉菜单（独立浮层子窗口，避免被网页 WebContentsView 遮挡） =================
let toolMenuWin: BrowserWindow | null = null;
const TOOLMENU_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,'PingFang SC',sans-serif; background:#fff; padding:6px; }
  .mi { display:flex; align-items:center; gap:9px; padding:7px 10px; border-radius:7px; cursor:pointer; font-size:13px; color:#333; }
  .mi:hover { background:#f2f2f8; }
  .mi svg { flex:none; }
  .mi .lbl { flex:1; }
  .sep { height:1px; background:#f0f0f6; margin:5px 6px; }
  .tt { padding:4px 10px 6px; font-size:11px; color:#9a9aac; }
  /* 指针统一为箭头，与本窗口其余界面一致 */
  html * { cursor: default !important; }
</style></head><body>
  <div class="tt">Tools</div>
  <div class="mi" data-a="ext"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path></svg><span class="lbl">Extract Markdown</span></div>
  <div class="mi" data-a="shot"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg><span class="lbl">Full-page Screenshot</span></div>
  <div class="mi" data-a="print"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg><span class="lbl">Print…</span></div>
  <div class="mi" data-a="extopen"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg><span class="lbl">Open in System Browser</span></div>
  <div class="mi" data-a="edit"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"></path></svg><span class="lbl">Edit HTML</span></div>
  <div class="sep"></div>
  <div class="mi" data-a="linkmode"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="13" height="13" rx="2"></rect><path d="M8 21h11a2 2 0 0 0 2-2V8"></path></svg><span class="lbl">__OPENLINK__</span></div>
  <div class="mi" data-a="adblock"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg><span class="lbl">__ADBLOCK__</span></div>
  <script>
    const BAPI = window.api && window.api.hippoBrowser;
    document.querySelectorAll('.mi').forEach((el) => el.addEventListener('click', () => {
      const a = el.getAttribute('data-a');
      if (BAPI) BAPI.menuExec(a);
    }));
  </script>
</body></html>`;
function openToolMenu(): void {
  const bw = win;
  if (!bw || bw.isDestroyed()) return;
  if (toolMenuWin && !toolMenuWin.isDestroyed()) { closeToolMenu(); return; }
  toolMenuWin = new BrowserWindow({
    width: 210, height: 300, frame: false, resizable: false, show: false,
    alwaysOnTop: true, skipTaskbar: true, parent: bw, visualEffectState: 'active',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: join(__dirname, 'preload.js') },
  });
  toolMenuWin.setAlwaysOnTop(true, 'floating');
  const adLabel = `Block Ads/Trackers: ${adBlockEnabled ? 'ON' : 'OFF'}${adBlockCount ? ` (${adBlockCount} blocked)` : ''}`;
  const openLabel = `Open Links: ${openLinkInNewTab ? 'New Tab' : 'Current Tab'}`;
  toolMenuWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    TOOLMENU_HTML.replace('__ADBLOCK__', adLabel).replace('__OPENLINK__', openLabel)));
  const cb = bw.getContentBounds();
  const H = Math.min(300, Math.max(200, cb.height - 64));
  toolMenuWin.setBounds({ x: cb.x + cb.width - 218, y: cb.y + chromeTop, width: 210, height: H });
  toolMenuWin.once('ready-to-show', () => toolMenuWin?.show());
  toolMenuWin.on('blur', () => closeToolMenu());
  toolMenuWin.on('closed', () => { toolMenuWin = null; });
}
function closeToolMenu(): void { if (toolMenuWin && !toolMenuWin.isDestroyed()) toolMenuWin.close(); toolMenuWin = null; }
/** 执行一次元素级就地 AI 编辑并应用，返回结果（供 inline-edit 与 aiedit-go 复用） */
async function runInlineAiEdit(instruction: string | undefined): Promise<{ ok: boolean; html?: string; error?: string }> {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'Not initialized' };
  if (!instruction) return { ok: false, error: 'Missing instruction' };
  if (!inlineSel) return { ok: false, error: 'Select an element on the page first' };
  try {
    const html = inlineSource || await wc.executeJavaScript('document.documentElement.outerHTML', true).catch(() => '');
    const res = await fetch(aiServerUrl + '/api/ai-edit/html', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, instruction, mode: 'element', element: inlineSel }),
    }).catch((e) => { throw new Error('Cannot reach the AI service: ' + e.message); });
    if (!res.ok || !res.body) return { ok: false, error: 'AI service error, HTTP ' + res.status };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; let finalHtml = ''; let finalError = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let ev: { type?: string; success?: boolean; html?: string; error?: string; message?: string };
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'done' || ev.success === true) { if (ev.html) finalHtml = ev.html; if (ev.error) finalError = ev.error; }
        else if (ev.type === 'error' || ev.success === false) { finalError = ev.message || ev.error || 'AI edit failed'; }
      }
    }
    if (finalHtml) { await applyInlineEdit(finalHtml, 'element', inlineSel.selector); await persistInlineHtml(wc); return { ok: true, html: finalHtml }; }
    return { ok: false, error: finalError || 'AI returned no valid result' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** 监听网页 title 信号（点选时改为 \u2318BOB\u2318），读取选中的元素并转发给工具栏 */
function captureInlineSelection(): void {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed() || !inlineMode) return;
  const t = wc.getTitle();
  if (!t || !t.includes('\u2318BOB\u2318')) return;
  wc.executeJavaScript('window.__bobSel', true)
    .then((sel: { selector?: string; outerHTML?: string; rect?: { left: number; top: number; width: number; height: number } } | undefined | null) => {
      if (sel && sel.selector && sel.outerHTML) { inlineSel = { selector: sel.selector, outerHTML: sel.outerHTML, rect: sel.rect ?? null }; forwardInlineSel(inlineSel); }
    })
    .catch(() => { /* 忽略 */ });
}
/** 就地应用 AI 结果：element 模式替换所选节点，其余忽略 */
async function applyInlineEdit(newHtml: string, mode: string, selector: string | null): Promise<void> {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (mode === 'element' && selector) {
    await wc.executeJavaScript(`(()=>{ try { const el=document.querySelector(${JSON.stringify(selector)}); if(el){ el.outerHTML=${JSON.stringify(newHtml)}; return true; } return false; } catch(e){ return false; } })()`, true);
  }
}

/** 创建独立浏览器窗口 */
export function setupHippoBrowser(): void {
  teardownHippoBrowser();
  registerBookmarkHandlers();
  ipcMain.handle('hippo-browser:set-chrome-height', (_e, h: number) => {
    const v = Math.max(HIPPO_TOOLBAR_HEIGHT, Math.round(Number(h) || HIPPO_TOOLBAR_HEIGHT));
    if (Math.abs(chromeTop - v) > 1) { chromeTop = v; relayoutView(); }
    return true;
  });
  ipcMain.handle('hippo-browser:tool-menu', () => { openToolMenu(); return true; });
  ipcMain.handle('hippo-browser:menu-exec', (_e, action: string) => {
    closeToolMenu();
    // 广告拦截开关在主进程侧生效，无需转发到渲染层
    if (action === 'adblock') {
      const on = toggleAdBlock();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('hippo-browser:menu-cmd', on ? 'adblockOn' : 'adblockOff');
      }
      return true;
    }
    // 打开方式开关同样在主进程侧生效（书签 / 页面内链接 / window.open 均在主进程收口）
    if (action === 'linkmode') {
      const on = toggleOpenLinkInNewTab();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('hippo-browser:menu-cmd', on ? 'linkNewTab' : 'linkCurrentTab');
      }
      return true;
    }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('hippo-browser:menu-cmd', action);
    }
    return true;
  });
  // 缩小 = 收起为胶囊（隐藏窗口 + 主窗口正中显示呼吸灯胶囊），非关闭
  ipcMain.handle('hippo-browser:minimize', () => { if (win && !win.isDestroyed()) collapseToCapsule(); return true; });
  ipcMain.handle('hippo-browser:toggle-maximize', () => {
    if (win && !win.isDestroyed()) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    return true;
  });

  const ses = session.fromPartition('persist:hippo-browser');
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['clipboard-sanitized-write'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ['clipboard-sanitized-write'].includes(permission));

  win = new BrowserWindow({
    width: WIN_DEFAULT_WIDTH,
    height: WIN_DEFAULT_HEIGHT,
    minWidth: WIN_MIN_WIDTH,
    minHeight: WIN_MIN_HEIGHT,
    frame: false,
    title: 'Hippo Browser',
    show: false,
    backgroundColor: '#f7f7fb',
    webPreferences: {
      partition: 'persist:bob-toolbar',
      contextIsolation: true,
      nodeIntegration: false,
      // 必须与主窗口一致使用 sandbox:false：工具栏 webContents 挂着主进程 preload.js，
      // 而该 preload 调用了 require('os')（homedir）。沙箱化 preload 无法加载 Node 内置模块，
      // 会导致 preload 崩溃 → window.api 缺失 → 工具栏按钮全部失效 / 窗口空白。
      sandbox: false,
      preload: join(__dirname, 'preload.js'),
    },
  });
  // 本函数内窗口已创建且不会再被替换，抓取非空引用避免在闭包中触发 win-is-null 误报
  const bw = win;
  // 默认固定在前端（起订后置顶，用户可随时用工具栏 📌 取消）
  bw.setAlwaysOnTop(true);
  // 跨全屏空间显示：macOS 全屏会独占一个 space，仅 setAlwaysOnTop 无法盖住全屏窗口，
  // 需 visibleOnFullScreen:true 让浏览器弹窗在 App 进入全屏后仍可见/置顶
  bw.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bw.setMenuBarVisibility(false);

  // 顶部工具栏：窗口 webContents 加载内联页面
  bw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(toolbarHtml())).catch(() => {});
  bw.webContents.on('did-finish-load', () => { broadcastState(); broadcastTabs(); });
  bw.webContents.on('before-input-event', (event, input) => {
    // 焦点在工具栏（含地址栏）时同样响应浏览器快捷键
    if (handleBrowserShortcut(event, input)) return;
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'b' && input.meta && input.shift) {
      hideWindow();
    }
  });

  // 会话级下载钩子：捕获下载项并推送到工具栏下载面板
  ensureDownloadHook();
  // 会话级广告/跟踪拦截（工具菜单可开关）
  ensureAdBlock();

  // 网页区：每个标签一个 WebContentsView 叠在工具栏下方；默认创建一个新建标签页（避免白屏）。
  const tab = spawnTab();
  activateTabById(tab.id);

  win.on('resize', scheduleRelayout);
  win.on('resized', scheduleRelayout);
  relayoutView();

  win.on('show', broadcastState);
  win.on('hide', broadcastState);
  win.on('closed', () => {
    win = null;
    view = null;
    tabs = [];
    activeTabId = 0;
    faviconMap.clear();
    lastStateJson = '';
    lastTabsJson = '';
  });

  bridgeStart();
  logHippo('Hippo browser window ready');
}

/** 新建一个标签（创建 WebContentsView 并挂导航事件），不自动激活 */
function spawnTab(): BrowserTab {
  const v = new WebContentsView({
    webPreferences: {
      partition: 'persist:hippo-browser',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 默认载入本机新建标签页（避免白屏）；data: URL 不触发 will-navigate/window-open，无网络依赖
  v.webContents.loadURL(newTabDataUrl()).catch(() => {});
  // 新窗口（target=_blank / window.open，含页面内链接拦截后的转发）：
  // 打开方式 = 新标签 → 新开标签；= 当前标签 → 收编为本标签导航；本地文档（PDF/图片）重定向到内置查看页
  v.webContents.setWindowOpenHandler(({ url }) => {
    const target = localFileToViewerUrl(url) || (isAllowedUrl(url) ? url : '');
    if (!target) return { action: 'deny' };
    if (openLinkInNewTab) openInNewTab(target);
    else v.webContents.loadURL(target).catch(() => {});
    return { action: 'deny' };
  });
  v.webContents.on('will-navigate', (e, url) => {
    const viewerUrl = localFileToViewerUrl(url);
    if (viewerUrl) { e.preventDefault(); v.webContents.loadURL(viewerUrl).catch(() => {}); return; }
    if (!isAllowedUrl(url)) e.preventDefault();
  });
  // 每次文档加载完成后注入页面内链接点击拦截（打开方式为「新标签」时生效）
  v.webContents.on('dom-ready', () => applyLinkModeTo(v.webContents));
  // 状态事件转发（工具栏据此刷新）
  const wc = v.webContents;
  // 先拿到 id，供 favicon / 右键菜单等事件回调引用
  const t: BrowserTab = { id: nextTabId++, view: v };
  wc.on('did-start-loading', broadcastState);
  wc.on('did-stop-loading', broadcastState);
  wc.on('did-fail-load', broadcastState);
  wc.on('did-navigate', broadcastState);
  wc.on('did-navigate-in-page', () => { broadcastState(); broadcastTabs(); });
  wc.on('page-title-updated', () => { broadcastState(); broadcastTabs(); captureInlineSelection(); });
  // 站点图标更新 → 记入映射并刷新标签条
  wc.on('page-favicon-updated', (_e, favicons) => {
    faviconMap.set(t.id, favicons[0] || '');
    broadcastTabs();
  });
  // 网页右键 → 主进程弹原生菜单
  wc.on('context-menu', (_e, params) => popupPageContextMenu(wc, params));
  // 浏览器级快捷键优先于页面自身处理；网页内 Ctrl/Cmd+F 仍单独转发给工具栏
  // 只认单个修饰键（meta XOR ctrl），避免 Ctrl+Cmd+F（macOS 全屏）被误命中
  wc.on('before-input-event', (event, input) => {
    if (handleBrowserShortcut(event, input)) return;
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'f' && (input.control !== input.meta) && !input.shift && !input.alt) {
      if (win && !win.isDestroyed()) win.webContents.send('hippo-browser:open-find');
    }
  });
  tabs.push(t);
  return t;
}

/** 激活指定标签（把它的 view 设为显示并把模块级 view 指针切过去） */
function activateTabById(id: number): BrowserTab | null {
  const t = tabs.find((x) => x.id === id && !x.view.webContents.isDestroyed());
  if (!t) return null;
  // 已是当前标签：无需重挂视图与重新布局，直接返回
  if (activeTabId === id && view === t.view) {
    if (win && !win.isDestroyed()) t.view.setVisible(true);
    return t;
  }
  if (activeTabId !== id) {
    // 隐藏旧标签视图，解绑，再挂上新标签
    const old = tabs.find((x) => x.id === activeTabId);
    if (old && win && !win.isDestroyed()) {
      try { win.contentView.removeChildView(old.view); } catch { /* 已移除 */ }
    }
  }
  activeTabId = id;
  view = t.view;
  if (win && !win.isDestroyed()) {
    // 确保新标签视图已加入 contentView（第一次激活时添加）
    try { win.contentView.addChildView(t.view); } catch { /* 已添加 */ }
    t.view.setVisible(true);
    relayoutView();
  }
  // 新标签状态可能未广播（spawn 后直接激活）
  broadcastState();
  broadcastTabs();
  return t;
}

/** target 是否为本地查看页 URL（本机 next-standalone 提供的 pdf/image viewer） */
function isLocalViewer(target: string): boolean {
  try {
    const u = new URL(target);
    const host = u.hostname;
    const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === aiServerUrl.split('//')[1].split(':')[0];
    return !!localHost && /^\/(pdf-viewer|image-viewer)(\?|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

/** 打开本地查看页（PDF/图片）时新标签打开；若当前唯一标签还是初始空页则复用覆盖，避免首开多一个空标签 */
function openInNewTab(url: string): void {
  // 当前仅一个标签且仍是初始空页（新标签页 data:）时，直接在当前标签覆盖，不新增
  const only = tabs.filter((t) => !t.view.webContents.isDestroyed());
  if (only.length === 1) {
    const cur = only[0].view.webContents.getURL();
    if (!cur || cur.startsWith('data:text/html')) {
      only[0].view.webContents.loadURL(url).catch(() => {});
      reveal();
      return;
    }
  }
  const tab = spawnTab();
  activateTabById(tab.id);
  tab.view.webContents.loadURL(url).catch(() => {});
  reveal();
}

/** 按「打开方式」开关打开链接：新标签模式 → openInNewTab；当前标签模式 → 覆盖当前标签 */
function openLinkByMode(rawUrl: string): { ok: boolean; error?: string } {
  const target = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!isAllowedUrl(target)) return { ok: false, error: 'Only http/https/file links are supported' };
  if (openLinkInNewTab) {
    openInNewTab(target);
  } else {
    requireView().loadURL(target).catch(() => {});
    reveal();
  }
  return { ok: true };
}

/**
 * 页面内链接点击的拦截脚本（注入到每个网页的主世界）。
 * 只在「打开方式 = 新标签」时拦截：被页面脚本接管（defaultPrevented）、带修饰键、
 * target≠_self、download、同页锚点等一律放行。拦截后用 window.open 交给
 * setWindowOpenHandler 收编为新标签 —— 不改动 will-navigate，避免表单 POST / JS 跳转
 * 被误判成链接点击。
 */
function linkModeScript(on: boolean): string {
  return `(() => { try {
  window.__bobHippoLinkNewTab = ${on ? 'true' : 'false'};
  if (window.__bobHippoLinkBound) return true;
  window.__bobHippoLinkBound = true;
  document.addEventListener('click', (e) => { try {
    if (!window.__bobHippoLinkNewTab) return;
    if (window.top !== window) return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    const tgt = (a.getAttribute('target') || '').toLowerCase();
    if (tgt && tgt !== '_self') return;
    let u; try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return;
    if (u.href === location.href) return;
    e.preventDefault();
    window.open(u.href, '_blank');
  } catch (_) { /* 忽略 */ } });
  return true;
} catch (_) { return false; } })()`;
}

/** 把当前「打开方式」注入指定网页（每次文档加载后都需重新注入） */
function applyLinkModeTo(wc: Electron.WebContents): void {
  if (!wc || wc.isDestroyed()) return;
  wc.executeJavaScript(linkModeScript(openLinkInNewTab), false).catch(() => {});
}

/** 把当前「打开方式」注入全部标签（切换开关时调用） */
function applyLinkModeToTabs(): void {
  for (const t of tabs) applyLinkModeTo(t.view.webContents);
}

/**
 * 统一的浏览器级快捷键处理（工具栏与网页两个 webContents 共用）。
 * 命中时消费按键（preventDefault）并返回 true；否则返回 false 交由页面自行处理。
 */
function handleBrowserShortcut(event: Electron.Event, input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false;
  const key = input.key.toLowerCase();

  // ⌃⇥ / ⌃⇧⇥：循环切换标签（macOS 习惯为 Control+Tab，不带 ⌘）
  if (input.control && !input.meta && input.key === 'Tab') {
    cycleTab(input.shift ? -1 : 1);
    event.preventDefault();
    return true;
  }
  // 其余快捷键统一要求 ⌘（macOS）/ Ctrl，且不带 Alt
  if (!(input.meta || input.control) || input.alt) return false;

  // ⌘⇧T：恢复最近关闭的标签
  if (input.shift && key === 't') {
    reopenClosedTab();
    event.preventDefault();
    return true;
  }
  if (input.shift) return false;

  // ⌘1-9：切到第 n 个标签（⌘9 为最后一个）
  if (/^[1-9]$/.test(key)) {
    const alive = tabs.filter((t) => !t.view.webContents.isDestroyed());
    const target = key === '9' ? alive[alive.length - 1] : alive[Number(key) - 1];
    if (target) activateTabById(target.id);
    event.preventDefault();
    return true;
  }

  switch (key) {
    case 't': {
      if (!win || win.isDestroyed()) return false;
      const t = spawnTab();
      activateTabById(t.id);
      relayoutView();
      reveal();
      event.preventDefault();
      return true;
    }
    case 'w': {
      if (!activeTabId) return false;
      closeTabById(activeTabId);
      event.preventDefault();
      return true;
    }
    case 'l': {
      if (!win || win.isDestroyed()) return false;
      reveal();
      win.webContents.send('hippo-browser:open-focus-addr');
      event.preventDefault();
      return true;
    }
    case 'r': {
      if (!view || view.webContents.isDestroyed()) return false;
      view.webContents.reload();
      event.preventDefault();
      return true;
    }
    case 'p': {
      if (!view || view.webContents.isDestroyed()) return false;
      void printPage();
      event.preventDefault();
      return true;
    }
    default:
      return false;
  }
}

/** 按 delta 在标签列表中循环切换（⌃⇥ / ⌃⇧⇥） */
function cycleTab(delta: number): void {
  const alive = tabs.filter((t) => !t.view.webContents.isDestroyed());
  if (alive.length < 2) return;
  const idx = alive.findIndex((t) => t.id === activeTabId);
  const base = idx < 0 ? 0 : idx;
  const next = alive[(base + delta + alive.length) % alive.length];
  if (next && next.id !== activeTabId) activateTabById(next.id);
}

/** ⌘⇧T：恢复最近关闭的标签（无记录时不做事） */
function reopenClosedTab(): void {
  const last = closedTabs.pop();
  if (!last) return;
  openInNewTab(last.url);
}

/**
 * 网页右键菜单（原生 Menu），内容随命中目标变化：
 * 链接 → 新标签/系统浏览器打开/复制链接；图片 → 复制图片/图片地址；
 * 编辑区 → 撤销/剪切/粘贴…；选中文字 → 复制/搜索；空白处 → 导航与工具项。
 */
function popupPageContextMenu(wc: Electron.WebContents, params: Electron.ContextMenuParams): void {
  const items: MenuItemConstructorOptions[] = [];
  const sel = (params.selectionText || '').trim();
  const sep = () => { if (items.length) items.push({ type: 'separator' }); };

  if (params.linkURL) {
    if (isAllowedUrl(params.linkURL)) {
      items.push({ label: 'Open Link in New Tab', click: () => openInNewTab(params.linkURL) });
    }
    items.push({ label: 'Open in System Browser', click: () => void shell.openExternal(params.linkURL) });
    items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    sep();
    items.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
    items.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
  }
  if (params.isEditable) {
    sep();
    items.push(
      { role: 'undo', label: 'Undo' },
      { role: 'redo', label: 'Redo' },
      { type: 'separator' },
      { role: 'cut', label: 'Cut' },
      { role: 'copy', label: 'Copy' },
      { role: 'paste', label: 'Paste' },
      { role: 'selectAll', label: 'Select All' },
    );
  } else if (sel) {
    sep();
    items.push({ role: 'copy', label: 'Copy' });
    const short = sel.length > 18 ? sel.slice(0, 18) + '…' : sel;
    items.push({
      label: `Search Bing for "${short}"`,
      click: () => openInNewTab('https://www.bing.com/search?q=' + encodeURIComponent(sel) + '&mkt=zh-CN'),
    });
  }

  sep();
  items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => back() });
  items.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => forward() });
  items.push({ label: 'Reload', click: () => wc.reload() });
  sep();
  items.push({ label: 'Extract Markdown (copy to clipboard)', click: () => void copyExtractedMarkdown() });
  items.push({ label: 'Full-page Screenshot (copy to clipboard)', click: () => void capture({ fullPage: true }).catch(() => {}) });
  items.push({ label: 'Print…', click: () => void printPage().catch(() => {}) });
  sep();
  items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) });

  Menu.buildFromTemplate(items).popup(win && !win.isDestroyed() ? { window: win } : undefined);
}

/** 提取当前页 Markdown 并写入剪贴板（右键菜单用，失败静默） */
async function copyExtractedMarkdown(): Promise<void> {
  try {
    const r = await extractContent();
    if (r.markdown) clipboard.writeText(r.markdown);
  } catch { /* 忽略 */ }
}

/** 关闭标签：先清空其视图，若关的是当前激活，切到相邻标签 */
function closeTabById(id: number): BrowserTab | null {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const [removed] = tabs.splice(idx, 1);
  // 记录可恢复信息（⌘⇧T）：忽略空白新标签页，最多保留 20 条
  try {
    const wc = removed.view.webContents;
    const u = wc.getURL();
    if (u && !u.startsWith('data:text/html')) {
      closedTabs.push({ url: u, title: wc.getTitle() || u });
      if (closedTabs.length > 20) closedTabs.shift();
    }
  } catch { /* 忽略 */ }
  faviconMap.delete(removed.id);
  if (win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(removed.view); } catch { /* 已移除 */ }
  }
  try { removed.view.webContents.close(); } catch { /* 忽略 */ }
  if (id === activeTabId) {
    activeTabId = 0;
    view = null;
    if (tabs.length) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      activateTabById(next.id);
    } else {
      // 关闭最后一个标签时自动新建一个空白标签，保证始终至少有一个标签可加载网址
      const t = spawnTab();
      activateTabById(t.id);
    }
  }
  broadcastTabs();
  broadcastState();
  return removed;
}

function hideWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide();
    broadcastState();
  }
}

/** 开合浏览器窗口（主窗口 Cmd+Shift+B 全局快捷键调用） */
export function toggleWindow(): void {
  if (win && !win.isDestroyed()) {
    if (win.isVisible()) hideWindow();
    else reveal();
  } else {
    setupHippoBrowser();
  }
  broadcastState();
}

export function teardownHippoBrowser(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  view = null;
  capsuleMode = false;
  bridgeStop();
}

function logHippo(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}