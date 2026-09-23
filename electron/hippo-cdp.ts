/**
 * Hippo Browser — 应用内浏览器自动化后端（主进程）
 *
 * 桥 POST /exec { name, args } 的落点：把规格层的 browser_* 工具调用映射到
 * 当前活动标签的 WebContents（CDP `webContents.debugger` + 页内脚本），
 * 统一返回 Envelope（ok / value / error{phase}），与 Next 侧 HippoDriver 的契约一致。
 *
 * 为什么必须放在主进程：CDP 需要 `webContents.debugger`，只能同进程持有；
 * Next 侧（Agent 工具）经 loopback 桥转发，不直接接触 Electron API。
 *
 * 实现边界：
 *   - 元素定位：snapshot 在页内登记 ref→元素（`window.__hippoRefs`）并同时写 `data-hippo-ref` 属性，
 *     click/type 复用；ref 带作用域前缀（`e3` 主文档 light DOM / `s1-e2` shadow root / `f1-e4` 子帧），
 *     跨 shadow root 与跨 frame 不再撞号，且能看到就能操作到；
 *   - 输入原语：点击/悬停/拖拽/滚轮走 CDP Input 真实事件；填写走原生 setter + input/change；
 *   - CDP 会话按标签一次性 attach 后常驻（标签销毁时自动 detach），整页截图沿用「用完即 detach」范式；
 *   - 遥测（网络 / console / 对话框）在主进程内做环形缓存，随 webContents 回收（WeakMap）；
 *   - page_script 注入前经规格层静态 lint（Net 模式 / 白名单），非法导航直接拒绝。
 */

import type { WebContents, WebFrameMain } from 'electron';
import { navGateError, lintPageScript, renderLintIssues } from '../src/lib/browser-tools/policy';

/** 宿主能力（由 hippo-browser.ts 注入，避免本模块依赖窗口/标签内部状态） */
export interface ExecHost {
  /** 当前活动标签的 webContents；Hippo 未就绪返回 null */
  activeWebContents(): WebContents | null;
  /** 指定标签的 webContents（后台标签等待加载用）；不存在或已销毁返回 null */
  webContentsOfTab(id: number): WebContents | null;
  /** 打开 URL（内部完成协议白名单校验与本地文档查看页重定向）；newTab=true 时新开标签并激活 */
  navigate(url: string, newTab: boolean): Promise<void>;
  /** 截图（视口 / 整页），返回 dataURL */
  capture(opts: { fullPage?: boolean }): Promise<string>;
  /** 提取正文（复用已有智能等待 + 主内容识别）；
   *  note/kind = 正文不可用时的成因与下一步（PDF / 登录墙 / 空壳未渲染），缺省表示正文正常 */
  extract(): Promise<{
    ready: boolean; markdown: string; text: string; title: string; url: string;
    note?: string; kind?: 'pdf' | 'login' | 'empty';
  }>;
  /** 标签列表（含活动标记） */
  listTabs(): Array<{ id: number; title: string; url: string; active: boolean }>;
  /** 激活指定标签；标签不存在返回 false */
  activateTab(id: number): boolean;
  /** 关闭指定标签（窗口始终保留至少一个标签），返回关闭后的活动标签 id */
  closeTab(id: number): { ok: boolean; activeId: number };
  /** 新开标签打开 URL */
  openTab(url: string, activate?: boolean): { ok: boolean; id?: number; error?: string };
}

export interface Envelope {
  ok: boolean;
  value?: unknown;
  error?: { phase: string; message: string; hint?: string };
  warnings?: string[];
  stats?: { ops: number; elapsedMs: number; urlEnd?: string };
}

const LOAD_TIMEOUT_MS = 20000;
const CLICK_SETTLE_MS = 350;
const SNAPSHOT_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 120;
const RING_CAP = 300;
const DIALOG_GRACE_MS = 4000;
/** 快照的跨帧预算：子帧数量与嵌套深度上限（页面塞几十个 iframe 时不能让一次快照退化成分分钟级） */
const SNAPSHOT_FRAME_CAP = 12;
const SNAPSHOT_FRAME_DEPTH = 3;

// ============ CDP 会话 ============

/** 已 attach 的标签 → 已 enable 的 CDP 域（标签销毁时整体丢弃，随 webContents 一起回收） */
const sessionDomains = new WeakMap<WebContents, Set<string>>();

function isAlive(wc: WebContents | null): wc is WebContents {
  return !!wc && !wc.isDestroyed();
}

/**
 * 确保 CDP 会话可用并 enable 指定域。
 * 常驻语义：首次 attach 后不主动 detach（标签销毁时由 destroyed 钩子回收）；
 * 若期间被别处（整页截图 / 打印）detach 过，域集合会失效 → 重新初始化，避免「以为 enable 过」。
 */
type CdpDomain = 'Page' | 'Runtime' | 'DOM' | 'Network';

async function ensureDomain(wc: WebContents, domain: CdpDomain): Promise<void> {
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach('1.3');
    const fresh = new Set<string>();
    sessionDomains.set(wc, fresh);
    wc.once('destroyed', () => {
      try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* 已销毁 */ }
    });
  }
  let domains = sessionDomains.get(wc);
  if (!domains) {
    domains = new Set<string>();
    sessionDomains.set(wc, domains);
  }
  if (!domains.has(domain)) {
    await wc.debugger.sendCommand(`${domain}.enable`);
    domains.add(domain);
  }
}

/** 等待页面加载结束（未在加载则立即返回；超时按 wait-timeout 报出，不硬失败） */
function waitForLoad(wc: WebContents, timeoutMs: number): Promise<boolean> {
  if (!wc.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', onStop);
      wc.removeListener('did-fail-load', onFail);
      resolve(ok);
    };
    const onStop = (): void => finish(true);
    const onFail = (): void => finish(true); // 加载失败也算「结束」，页面现状由后续快照呈现
    const timer = setTimeout(() => finish(false), timeoutMs);
    wc.once('did-stop-loading', onStop);
    wc.once('did-fail-load', onFail);
  });
}

// ============ 遥测（网络 / console / 对话框）============

interface NetEntry {
  method: string;
  url: string;
  status: number;
  type: string;
  ms: number;
  failed: boolean;
}

interface LogEntry {
  level: string;
  text: string;
  ts: number;
}

interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt: string;
}

interface Telemetry {
  bound: boolean;
  inflight: Map<string, { method: string; url: string; type: string; startedAt: number; status: number }>;
  net: NetEntry[];
  logs: LogEntry[];
  dialog: DialogInfo | null;
  dialogTimer: NodeJS.Timeout | null;
}

const telemetryMap = new WeakMap<WebContents, Telemetry>();

function telemetryOf(wc: WebContents): Telemetry {
  let t = telemetryMap.get(wc);
  if (!t) {
    t = { bound: false, inflight: new Map(), net: [], logs: [], dialog: null, dialogTimer: null };
    telemetryMap.set(wc, t);
  }
  return t;
}

function pushRing<T>(ring: T[], item: T): void {
  ring.push(item);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
}

/** 绑定 CDP 事件 → 遥测缓存（每个 webContents 仅一次），并 enable Network / Runtime / Page */
async function ensureTelemetry(wc: WebContents): Promise<Telemetry> {
  const t = telemetryOf(wc);
  if (!t.bound) {
    t.bound = true;
    wc.debugger.on('message', (_event, method, params) => {
      const p = (params ?? {}) as Record<string, any>;
      switch (method) {
        case 'Network.requestWillBeSent':
          t.inflight.set(String(p.requestId), {
            method: String(p.request?.method ?? ''),
            url: String(p.request?.url ?? ''),
            type: String(p.type ?? ''),
            startedAt: Date.now(),
            status: 0,
          });
          break;
        case 'Network.responseReceived': {
          const rec = t.inflight.get(String(p.requestId));
          if (rec) rec.status = Number(p.response?.status ?? 0);
          break;
        }
        case 'Network.loadingFinished': {
          const id = String(p.requestId);
          const rec = t.inflight.get(id);
          if (rec) {
            t.inflight.delete(id);
            pushRing(t.net, {
              method: rec.method,
              url: rec.url.slice(0, 300),
              status: rec.status,
              type: rec.type,
              ms: Date.now() - rec.startedAt,
              failed: false,
            });
          }
          break;
        }
        case 'Network.loadingFailed': {
          const id = String(p.requestId);
          const rec = t.inflight.get(id);
          t.inflight.delete(id);
          if (rec) {
            pushRing(t.net, {
              method: rec.method,
              url: rec.url.slice(0, 300),
              status: rec.status,
              type: rec.type,
              ms: Date.now() - rec.startedAt,
              failed: true,
            });
          }
          break;
        }
        case 'Runtime.consoleAPICalled': {
          const args = Array.isArray(p.args) ? p.args : [];
          const text = args
            .map((a: Record<string, unknown>) => {
              if (a && typeof a === 'object' && 'value' in a) return String((a as { value?: unknown }).value ?? '');
              return String((a as { description?: string })?.description ?? '');
            })
            .join(' ');
          pushRing(t.logs, { level: String(p.type ?? 'log'), text: text.slice(0, 600), ts: Number(p.timestamp ?? Date.now()) });
          break;
        }
        case 'Runtime.exceptionThrown': {
          const d = (p.exceptionDetails ?? {}) as Record<string, any>;
          const text = String(d.exception?.description || d.text || 'uncaught exception');
          pushRing(t.logs, { level: 'error', text: text.slice(0, 600), ts: Number(d.timestamp ?? Date.now()) });
          break;
        }
        case 'Page.javascriptDialogOpening': {
          t.dialog = {
            type: String(p.type ?? 'alert'),
            message: String(p.message ?? ''),
            defaultPrompt: String(p.defaultPrompt ?? ''),
          };
          // 兜底：模型没来得及调 browser_handle_dialog 时自动放行，避免页面永久阻塞
          if (t.dialogTimer) clearTimeout(t.dialogTimer);
          t.dialogTimer = setTimeout(() => {
            if (!t.dialog) return;
            t.dialog = null;
            try {
              wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
            } catch { /* 已 detach */ }
          }, DIALOG_GRACE_MS);
          break;
        }
        default:
          break;
      }
    });
  }
  await ensureDomain(wc, 'Runtime');
  await ensureDomain(wc, 'Network');
  return t;
}

/**
 * 幂等绑定遥测（网络 / console / 对话框）。
 *
 * 必须在「页面/标签刚就绪」时就调用：CDP 不回放历史事件，若等到模型首次调用
 * browser_console_logs / browser_network_requests 才 enable，环形缓冲必然是空的
 * （模型要先调一次「空结果」再调一次才有数据）。
 */
async function bindTelemetry(target: WebContents | null): Promise<void> {
  if (!isAlive(target)) return;
  try {
    await ensureTelemetry(target);
  } catch {
    /* 遥测不可用不阻断工具本体 */
  }
}

// ============ 工具实现 ============

function ok(value: unknown, startedAt: number, wc: WebContents | null): Envelope {
  return {
    ok: true,
    value,
    stats: { ops: 1, elapsedMs: Date.now() - startedAt, urlEnd: isAlive(wc) ? wc.getURL() : undefined },
  };
}

function fail(phase: string, message: string, hint?: string): Envelope {
  return { ok: false, error: { phase, message, hint } };
}

/**
 * 在页内执行脚本；传 frame 时在该子帧上下文执行。
 * 跨域子帧在页内（主文档 JS）不可访问，只有主进程的 WebFrameMain 能对它执行脚本 ——
 * 这是跨帧能力必须落在宿主侧、而不是页内运行时的根本原因。
 */
async function run<T>(wc: WebContents, script: string, frame?: WebFrameMain | null): Promise<T> {
  if (frame) {
    if (frame.isDestroyed() || frame.detached) throw new Error('子帧已不可用（页面可能已跳转）');
    return (await frame.executeJavaScript(script, true)) as T;
  }
  return (await wc.executeJavaScript(script, true)) as T;
}

// ============ 跨帧（iframe）寻址 ============

/**
 * 子帧路径命名：主文档为 ''，其第 k 个直接子帧为 `f{k}`，孙帧为 `f{k}-f{m}`。
 * 快照 ref 前缀与之一致（`f1-e3` / `f1-s2-e5`），所以「看得到的 ref」与「点得到的帧」是同一条路径。
 *
 * 为什么走 WebFrameMain.frames 树而不是页内 document.querySelectorAll('iframe')：
 * 跨域 iframe 的 contentDocument 在页内取不到，无法在页内递归；而 frames 树对任何帧都可执行脚本。
 * 代价是这里的序号（同一父帧下的直接子帧顺序）必须在「快照」与「操作」两次调用间保持一致 ——
 * frames 顺序由帧树维护，页面未发生帧增删时稳定；一旦不一致，元素解析会失败并提示重新快照。
 */
interface FrameSlot {
  frame: WebFrameMain;
  path: string;
}

/** 展开子帧树（深度优先、带帧数与深度上限） */
function childFrames(wc: WebContents): FrameSlot[] {
  const out: FrameSlot[] = [];
  if (wc.isDestroyed()) return out;
  const walk = (parent: WebFrameMain, prefix: string, depth: number): void => {
    if (depth >= SNAPSHOT_FRAME_DEPTH || out.length >= SNAPSHOT_FRAME_CAP) return;
    let kids: WebFrameMain[];
    try {
      kids = parent.frames;
    } catch {
      return; // 帧正在卸载：跳过，不阻断主文档
    }
    for (let i = 0; i < kids.length; i += 1) {
      if (out.length >= SNAPSHOT_FRAME_CAP) return;
      const child = kids[i];
      if (!child || child.isDestroyed() || child.detached) continue;
      const path = prefix ? `${prefix}-f${i + 1}` : `f${i + 1}`;
      out.push({ frame: child, path });
      walk(child, path, depth + 1);
    }
  };
  walk(wc.mainFrame, '', 0);
  return out;
}

/** 按路径取帧；'' 表示主文档 */
function frameByPath(wc: WebContents, path: string): WebFrameMain | null {
  if (!path) return wc.isDestroyed() ? null : wc.mainFrame;
  return childFrames(wc).find((s) => s.path === path)?.frame ?? null;
}

/**
 * 从 ref 前缀取帧路径（`f1-s2-e5` → `f1`）。
 * 非本命名空间的 ref（如手工点选的 `p1abc`）与纯 CSS 选择器一律视为主文档 → ''。
 */
function framePathOfRef(ref: string): string {
  const parts = ref.split('-');
  const last = parts.pop() ?? '';
  if (!/^e\d+$/.test(last)) return '';
  const frames: string[] = [];
  let i = 0;
  while (i < parts.length && /^f\d+$/.test(parts[i])) {
    frames.push(parts[i]);
    i += 1;
  }
  for (let j = i; j < parts.length; j += 1) {
    if (!/^s\d+$/.test(parts[j])) return '';
  }
  return frames.join('-');
}

/** 目标 ref 落在哪一帧：frame=null 且 path 非空 ⇒ 声明了子帧但该帧已不在了 */
function targetFrame(wc: WebContents, args: Record<string, unknown>): { frame: WebFrameMain | null; path: string } {
  const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
  const path = ref ? framePathOfRef(ref) : '';
  if (!path) return { frame: null, path: '' };
  return { frame: frameByPath(wc, path), path };
}

/** 子帧 ref 指向的帧已消失时的统一报错（null = 可用） */
function staleFrameError(t: { frame: WebFrameMain | null; path: string }): string | null {
  return t.path && !t.frame ? `目标位于子帧 ${t.path}，但该帧已不可用（页面可能已跳转，请重新 browser_snapshot）` : null;
}

/**
 * 页内定位助手（自包含表达式：立即安装并返回 resolve 函数，顺带挂到 `window.__hippoResolve`）。
 *
 * 两条路径：
 * - ref（`e3` / `s1-e2` / `f1-e4`）：先查快照注册表 `window.__hippoRefs` ——
 *   这是取到 shadow root **内部**元素的唯一办法（document.querySelector 不穿透 shadow 边界）；
 *   注册表未命中时回退 `[data-hippo-ref="…"]` 属性（页面重载前的旧快照、手工点选的 pXXXX ref）。
 * - CSS 选择器：先 `document.querySelector`，未命中再递归穿透 open shadow root。
 *   closed shadow root 自 JS 不可见，无法穿透（需 CDP DOM.getDocument({pierce:true})，本期不做）。
 */
const PAGE_RESOLVER_HELPER = `(function () {
  const byRef = (r) => {
    const reg = window.__hippoRefs;
    if (reg && reg[r]) return reg[r];
    return document.querySelector('[data-hippo-ref="' + r + '"]');
  };
  const deepQuery = (sel, root, budget) => {
    let hit = null;
    try { hit = root.querySelector(sel); } catch (e) { return null; }
    if (hit) return hit;
    if (budget.left <= 0) return null;
    let hosts;
    try { hosts = root.querySelectorAll('*'); } catch (e) { return null; }
    for (let i = 0; i < hosts.length; i += 1) {
      budget.left -= 1;
      if (budget.left <= 0) return null;
      const sr = hosts[i].shadowRoot;
      if (!sr) continue;
      const inner = deepQuery(sel, sr, budget);
      if (inner) return inner;
    }
    return null;
  };
  const resolve = (t) => {
    if (t && t.nodeType === 1) return t;
    const s = String(t === undefined || t === null ? '' : t).trim();
    if (!s) return null;
    const reg = window.__hippoRefs;
    if ((reg && reg[s]) || /^((f\\d+-)*(s\\d+-)*)e\\d+$/.test(s)) return byRef(s);
    return deepQuery(s, document, { left: 20000 });
  };
  window.__hippoResolve = resolve;
  return resolve;
})()`;

/** 元素定位表达式：ref（快照登记的 ref，可带帧 / shadow 前缀）优先，其次 CSS selector */
function resolverExpr(args: Record<string, unknown>): string | null {
  const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  const target = ref || selector;
  if (!target) return null;
  return `(${PAGE_RESOLVER_HELPER})(${JSON.stringify(target)})`;
}

/** 元素定位的 CSS 选择器写法（upload_file / DOM.querySelector 用） */
function selectorOf(args: Record<string, unknown>): string | null {
  const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  if (ref) return `[data-hippo-ref="${ref}"]`;
  if (selector) return selector;
  return null;
}

/** 目标元素瞬时描边（视觉反馈层）：AI 在操作哪一个元素，用户就看见哪一个被框住。
 *  纯展示 —— pointer-events:none 不拦截随后的真实点击；先淡出再移除（<1s 自愈）；
 *  失败静默，绝不影响主链路。与 centerScript / fillScript 同姿势：先 scrollIntoView 再量取，
 *  保证框的位置与紧随其后的真实操作落在同一元素上。 */
function flashScript(resolver: string): string {
  return `(() => {
  const el = ${resolver};
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    document.querySelectorAll('[data-hippo-flash]').forEach((e) => e.remove());
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.setAttribute('data-hippo-flash', '1');
    box.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;z-index:2147483647;'
      + 'border:2px solid #6b5cf0;background:rgba(107,92,240,.14);border-radius:3px;'
      + 'transition:opacity .4s ease-out;left:' + r.left + 'px;top:' + r.top + 'px;'
      + 'width:' + r.width + 'px;height:' + r.height + 'px;';
    document.documentElement.appendChild(box);
    setTimeout(() => { box.style.opacity = '0'; }, 420);
    setTimeout(() => { try { box.remove(); } catch (e) {} }, 880);
    return true;
  } catch (e) { return false; }
})()`;
}

/** 描边适用范围：元素定向的写操作（无 ref/selector 的调用不倒框，如 navigate / wait / snapshot） */
const FLASH_TOOLS = new Set([
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_check',
  'browser_uncheck',
]);

/** 元素中心点脚本（返回 null 表示未找到） */
function centerScript(resolver: string): string {
  return `(() => {
  const el = ${resolver};
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const desc = (el.tagName || '').toLowerCase()
    + (el.getAttribute && el.getAttribute('type') ? '[type=' + el.getAttribute('type') + ']' : '')
    + (el.innerText ? ' "' + String(el.innerText).replace(/\\s+/g, ' ').trim().slice(0, 40) + '"' : '');
  return { desc, x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;
}

/** 点选目标（drag 用）：ref/selector 或显式 x+y */
async function resolvePoint(wc: WebContents, spec: Record<string, unknown>): Promise<{ x: number; y: number; desc: string } | null> {
  const hasXY = Number.isFinite(Number(spec.x)) && Number.isFinite(Number(spec.y));
  if (hasXY) return { x: Number(spec.x), y: Number(spec.y), desc: `${Number(spec.x)},${Number(spec.y)}` };
  const resolver = resolverExpr(spec);
  if (!resolver) return null;
  return run<{ x: number; y: number; desc: string } | null>(wc, centerScript(resolver));
}

/** CDP 鼠标事件序列 */
async function mouseClick(wc: WebContents, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
  await ensureDomain(wc, 'Page');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : button,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }
}

// ---- 子帧内交互（坐标不可靠时的退化路径）----

/**
 * 子帧内的点击。
 *
 * 为什么不在子帧上走 CDP 真实鼠标：`Input.dispatchMouseEvent` 的坐标是**顶层视口**系，
 * 而子帧内元素的 getBoundingClientRect 是**该帧视口**系；两系之间要靠「iframe 元素在上层文档中的位置」
 * 换算，而 WebFrameMain 与它对应的 iframe 元素之间没有公开映射（Electron 不暴露 CDP frameId），
 * 猜错就会点到别处 —— 比合成点击更糟。因此子帧目标一律帧内合成点击，并在结果里以 `via: 'in-frame'` 明示。
 * 保留 bb.click 同款可交互性前置校验：disabled / 零尺寸 / pointer-events:none 直接报错，
 * 而不是「点成功但页面毫无反应」的静默失败。
 */
function frameClickScript(resolver: string): string {
  return `(() => {
  const el = ${resolver};
  if (!el) return { ok: false, error: 'element not found' };
  if (el.disabled === true) return { ok: false, error: 'target is disabled' };
  let r; try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
  if (!r || r.width <= 1 || r.height <= 1) return { ok: false, error: 'target has no visible box (hidden or zero-size)' };
  try { if (getComputedStyle(el).pointerEvents === 'none') return { ok: false, error: 'target has pointer-events:none — a real click would land on the element underneath' }; } catch (e) {}
  const desc = (el.tagName || '').toLowerCase() + (el.innerText ? ' "' + String(el.innerText).replace(/\\s+/g, ' ').trim().slice(0, 40) + '"' : '');
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  try { if (el.focus) el.focus(); } catch (e) {}
  const before = location.href;
  el.click();
  return { ok: true, desc, url: location.href, redirected: location.href !== before };
})()`;
}

/** 子帧内的悬停：理由同 frameClickScript，改用帧内 mouse 事件（mouseenter 不冒泡，单独发） */
function frameHoverScript(resolver: string): string {
  return `(() => {
  const el = ${resolver};
  if (!el) return { ok: false, error: 'element not found' };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  const desc = (el.tagName || '').toLowerCase() + (el.innerText ? ' "' + String(el.innerText).replace(/\\s+/g, ' ').trim().slice(0, 40) + '"' : '');
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
  try { if (el.focus) el.focus(); } catch (e) {}
  return { ok: true, desc };
})()`;
}

/** 子帧内的勾选：读状态 → 必要时点击 → 回读真实结果 */
function frameCheckScript(resolver: string, want: boolean): string {
  return `(() => {
  const el = ${resolver};
  if (!el) return { ok: false, error: 'element not found' };
  const before = !!el.checked;
  if (before === ${want ? 'true' : 'false'}) return { ok: true, checked: before, changed: false };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  try { if (el.focus) el.focus(); } catch (e) {}
  el.click();
  return { ok: true, checked: !!el.checked, changed: true, before };
})()`;
}

const SNAPSHOT_SELECTOR =
  'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],' +
  '[role="tab"],[role="menuitem"],[contenteditable="true"],[onclick]';

/**
 * 快照核心（页内 IIFE 源码）：上限与帧路径由调用方在页内以 `__snapMax` / `__snapFramePath` 提供。
 *
 * `browser_snapshot` 工具与脚本内 `bb.snapshot()` 共用这一份，避免两处逻辑漂移 ——
 * 脚本里拿到的 ref 与工具层登记的 ref 必须是同一套编号规则。
 *
 * 作用域遍历（本次升级的核心）：以「文档 light DOM → 各 open shadow root」为作用域队列做 BFS，
 * 每个作用域内独立编号，ref 前缀即作用域路径（`e3` / `s1-e2` / `s1-s2-e5`）。
 * 为什么必须这样：shadow root 内部元素 `document.querySelector` 取不到、`[data-hippo-ref]` 属性扫描也扫不到，
 * 只有把元素放进注册表 `window.__hippoRefs` 才可能被后续 click/type 拿到；
 * 而一个文档里若有多个 shadow root，共用一个编号序列会互相撞号 —— 前缀把命名空间分开。
 * 子帧同理由调用方传入 `__snapFramePath`（宿主侧按 frames 树逐帧调用本函数）。
 */
const SNAPSHOT_BODY = `(() => {
  const MAX = Math.max(1, Math.min(300, Number(__snapMax) || 80));
  const PATH = typeof __snapFramePath === 'string' ? __snapFramePath : '';
  const SEL = ${JSON.stringify(SNAPSHOT_SELECTOR)};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const scopes = [{ root: document, prefix: '' }];
  const registry = {};
  const out = [];
  for (let si = 0; si < scopes.length && out.length < MAX; si += 1) {
    const scope = scopes[si];
    // 先清掉本作用域上一轮的 ref 属性，避免上一轮的幽灵 ref 仍能被 [data-hippo-ref] 命中
    scope.root.querySelectorAll('[data-hippo-ref]').forEach((e) => e.removeAttribute('data-hippo-ref'));
    let n = 0;
    for (const el of Array.from(scope.root.querySelectorAll(SEL))) {
      if (out.length >= MAX) break;
      if (!visible(el)) continue;
      const ref = PATH + scope.prefix + 'e' + (++n);
      registry[ref] = el;
      el.setAttribute('data-hippo-ref', ref);
      const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title')
        || el.innerText || (typeof el.value === 'string' ? el.value : '') || '';
      out.push({
        ref,
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        name: String(raw).replace(/\\s+/g, ' ').trim().slice(0, 80),
        value: (typeof el.value === 'string' && el.value) ? el.value.slice(0, 60) : '',
        href: el.getAttribute('href') || '',
        disabled: !!el.disabled,
        ...(PATH ? { frame: PATH } : {}),
        ...(scope.prefix ? { shadow: scope.prefix.slice(0, -1) } : {}),
      });
    }
    // shadow host 本身不一定命中 SEL（如承载整块 UI 的 <my-widget>），所以必须对全部元素扫一遍
    for (const host of Array.from(scope.root.querySelectorAll('*'))) {
      if (scopes.length >= 200) break;
      const sr = host.shadowRoot;
      if (sr) scopes.push({ root: sr, prefix: scope.prefix + 's' + scopes.length + '-' });
    }
  }
  // 注册表是 ref → 元素的唯一真相（document.querySelector 无法穿透 shadow 边界）；
  // data-hippo-ref 属性同时保留：既是可调试痕迹，也兼容旧脚本的 [data-hippo-ref] 写法。
  window.__hippoRefs = registry;
  return { ready: document.readyState === 'complete', url: location.href, title: document.title, frame: PATH, elements: out };
})()`;

/** 工具层入口：把 max 与帧路径作为页内变量注入后执行 SNAPSHOT_BODY */
function snapshotScript(max: number, framePath: string): string {
  return `(() => { const __snapMax = ${max}; const __snapFramePath = ${JSON.stringify(framePath)}; return ${SNAPSHOT_BODY}; })()`;
}

/**
 * 逐帧快照：主文档 + 各子帧各跑一次 SNAPSHOT_BODY，元素合并成一张表（子帧元素带 `frame` 字段）。
 * 子帧不再以 `<iframe>` 元素的形式出现，而是被「打开」成它自己的元素列表 —— iframe 里能点的东西
 * 因此第一次真正可点（旧实现只能看见一个 iframe 元素，模型只能猜里面有什么）。
 * 子帧预算更小（≤30）：iframe 通常是登录框 / 支付组件 / 客服挂件，不该把主文档的 ref 挤出上下文。
 */
async function runSnapshot(wc: WebContents, max: number): Promise<Record<string, unknown>> {
  const main = await run<Record<string, unknown>>(wc, snapshotScript(max, ''));
  const elements: unknown[] = Array.isArray(main.elements) ? [...(main.elements as unknown[])] : [];
  const frames: Array<{ frame: string; url: string; elements: number }> = [];
  const subMax = Math.max(10, Math.min(30, max));
  for (const slot of childFrames(wc)) {
    let r: Record<string, unknown> | null = null;
    try {
      r = await run<Record<string, unknown>>(wc, snapshotScript(subMax, slot.path), slot.frame);
    } catch {
      continue; // 正在卸载 / 已失效的帧：跳过，不阻断主文档结果
    }
    if (!r) continue;
    const els = Array.isArray(r.elements) ? (r.elements as unknown[]) : [];
    elements.push(...els);
    frames.push({ frame: slot.path, url: String(r.url ?? ''), elements: els.length });
  }
  const value: Record<string, unknown> = { ...main, elements };
  if (frames.length) value.frames = frames; // 有子帧才带这一节，避免平白占上下文
  return value;
}

/** 原生 setter 填写：兼容 input / textarea / contenteditable（受控组件靠 input+change 事件同步） */
function fillScript(resolver: string, text: string, clear: boolean): string {
  const nextValue = clear ? 'TEXT' : "((el.textContent || '') + TEXT)";
  const nextInputValue = clear ? 'TEXT' : "((el.value || '') + TEXT)";
  return `(() => {
  const el = ${resolver};
  if (!el) return { ok: false, error: 'element not found' };
  const TEXT = ${JSON.stringify(text)};
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  const isCE = el.isContentEditable === true;
  if (isCE) {
    el.textContent = ${nextValue};
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const next = ${nextInputValue};
    if (desc && desc.set) desc.set.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { ok: true, value: isCE ? (el.textContent || '') : String(el.value ?? '') };
})()`;
}

// ---- 按键：CDP Input.dispatchKeyEvent 的键表 ----

interface KeyStroke {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyStroke> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/** 解析按键写法（'Enter' / 'Meta+A' / 'Shift+Enter'）→ CDP 键位 + 修饰位掩码（Alt1 Ctrl2 Meta4 Shift8） */
function parseKeyStroke(spec: string): { stroke: KeyStroke; modifiers: number } {
  const parts = spec.split('+').map((s) => s.trim()).filter(Boolean);
  const mainRaw = parts.pop() || '';
  let modifiers = 0;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'meta' || l === 'cmd' || l === 'command') modifiers |= 4;
    else if (l === 'ctrl' || l === 'control') modifiers |= 2;
    else if (l === 'alt' || l === 'option') modifiers |= 1;
    else if (l === 'shift') modifiers |= 8;
  }
  const named = NAMED_KEYS[mainRaw] || NAMED_KEYS[mainRaw.charAt(0).toUpperCase() + mainRaw.slice(1)];
  if (named) return { stroke: named, modifiers };
  const ch = mainRaw;
  const upper = ch.toUpperCase();
  const code = /^[a-z]$/i.test(ch) ? `Key${upper}` : /^[0-9]$/.test(ch) ? `Digit${ch}` : '';
  return {
    stroke: { key: ch, code, keyCode: upper.charCodeAt(0) || 0, text: modifiers ? undefined : ch },
    modifiers,
  };
}

/** 页内轮询等待（主进程侧驱动，避免页内长任务阻塞）；frame 非空时在子帧内探测 */
async function pollUntil(
  wc: WebContents,
  probe: string,
  timeoutMs: number,
  frame?: WebFrameMain | null,
): Promise<{ hit: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    const hit = await run<boolean>(wc, probe, frame).catch(() => false);
    if (hit) return { hit: true, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) return { hit: false, elapsedMs: Date.now() - startedAt };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/** 脚本返回的字符预算：超出即转成可读的截断信封，而不是让外层把 JSON 拦腰切断。
 *  应 ≤ specs 里 browser_page_script 的 maxOutput（8000）。 */
const PAGE_SCRIPT_RETURN_CAP = 8000;

/**
 * page_script 的 bb 运行时（纯页内 JS）。
 *
 * 设计原则：**把已有能力搬进页内，而不是另造一套** ——
 * - 定位：`bb.$` / `bb.ref` 直接吃 browser_snapshot 写进 DOM 的 `data-hippo-ref`，
 *   脚本因此能复用快照 ref（工具层 resolverExpr 用的是同一个属性）；
 * - 写操作：`bb.fill` 与工具层 fillScript 同一套原生 setter 语义（受控组件靠 input/change 同步）；
 * - 读操作：`bb.text` / `bb.snapshot` 与工具层同源，避免「脚本里看到的」与「工具层看到的」不一致。
 *
 * 为什么要有这组 helper：只有 sleep / waitFor / goto 时，脚本只能「读和等」，
 * 每一次点击、填表都得退回工具层再往返一轮 —— 那正是 code-based 方案要消除的开销。
 *
 * `bb.click` 用页内合成事件（el.click()），覆盖绝大多数按钮与链接；页面若依赖真实坐标
 * 点击或 isTrusted 校验（少数），退回 browser_click 走 CDP 真实鼠标。click 若触发导航，
 * 执行上下文随之销毁 —— 宿主会把它识别成「页面已跳转」并返回确定结果，而不是无信息报错。
 *
 * `bb.goto` 语义对齐 Bob Browser 原版：**终止脚本**（其后语句不再执行），
 * 导航由**宿主**执行而不是页内 location.assign（页内自跳会销毁执行上下文、连结果一起丢）。
 * allowNav 在运行时再校验一次（静态 lint 之外的纵深防御）：动态拼出的 URL 静态检查看不到。
 *
 * 脚本失败**不抛**，而是返回 `{ kind:'error', message, steps }`：脚本一次跑多步，
 * 失败时必须把「已经做成了什么」带回宿主，模型才能只补跑剩余步骤，而不是重跑整个脚本。
 */
function pageScriptWrapper(script: string, timeoutMs: number, allowNav: boolean): string {
  return `(async () => {
  const __budget = ${timeoutMs};
  const __allowNav = ${allowNav ? 'true' : 'false'};
  const __cap = ${PAGE_SCRIPT_RETURN_CAP};
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(Number(ms) || 0, __budget))));

  // 定位助手与工具层共用同一份实现：ref 走快照注册表（可命中 shadow root 内部元素），
  // CSS 选择器先直查、未命中再穿透 open shadow root。
  // 边界：bb 脚本运行在**主文档**上下文，只能解析主文档与主文档内 shadow root 的 ref；
  // 子帧 ref（f1-e3）在页内不可达，请用工具层（browser_click / browser_type）操作。
  const __resolve = (${PAGE_RESOLVER_HELPER})();
  const __desc = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const txt = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    return (el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : '') + (txt ? ' "' + txt + '"' : '');
  };

  // 操作轨迹：脚本一次跑多步，失败时必须让模型知道「已经做成了什么」——
  // 否则它只能重跑整个脚本，把已完成的点击/提交再做一遍。
  const __steps = [];
  const __note = (op, target) => {
    if (__steps.length >= 40) return;
    const t = (target === undefined || target === null || target === '') ? '' : '(' + String(target).slice(0, 60) + ')';
    __steps.push(op + t);
  };
  const __trace = () => __steps.join(' → ');
  /** 可交互性前置校验：合成事件对 disabled / 零尺寸 / pointer-events:none 会「成功但无效果」 */
  const __blocked = (el) => {
    if (el.disabled === true) return 'target is disabled';
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || r.width <= 1 || r.height <= 1) return 'target has no visible box (hidden or zero-size)';
    try { if (getComputedStyle(el).pointerEvents === 'none') return 'target has pointer-events:none — a real click would land on the element underneath'; } catch (e) {}
    return '';
  };

  const waitFor = async (cond, opts) => {
    const timeout = Number(opts && opts.timeoutMs) || __budget;
    const interval = Number(opts && opts.intervalMs) || 100;
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = typeof cond === 'function' ? await cond() : __resolve(cond); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 >= timeout) throw new Error('bb.waitFor timeout after ' + timeout + 'ms');
      await sleep(interval);
    }
  };

  const waitText = async (needle, opts) => {
    const o = opts || {};
    const want = String(needle === undefined || needle === null ? '' : needle);
    if (!want) throw new Error('bb.waitText requires a non-empty string');
    const timeout = Number(o.timeoutMs) || __budget;
    const interval = Number(o.intervalMs) || 120;
    const root = o.root ? (__resolve(o.root) || document.body) : document.body;
    const t0 = Date.now();
    for (;;) {
      if (String(root.innerText || root.textContent || '').indexOf(want) !== -1) return true;
      if (Date.now() - t0 >= timeout) throw new Error('bb.waitText timeout after ' + timeout + 'ms (not found: "' + want + '")');
      await sleep(interval);
    }
  };

  /** 按 ref（snapshot 建的 e1/e2…，含 s1-e2 这类 shadow 作用域 ref）或 CSS 选择器取元素 */
  const $ = (t) => __resolve(t);
  const ref = (r) => {
    const s = String(r === undefined || r === null ? '' : r).trim();
    if (!s) return null;
    return __resolve(s);
  };

  const text = (t, opts) => {
    const o = opts || {};
    const el = (t === undefined || t === null) ? document.body : __resolve(t);
    if (!el) return null;
    const raw = o.html ? el.innerHTML : (el.innerText || el.textContent || '');
    const s = String(raw).replace(/\\s+/g, ' ').trim();
    const cap = Number(o.maxChars) > 0 ? Number(o.maxChars) : 4000;
    return s.length > cap ? s.slice(0, cap) + '…[+' + (s.length - cap) + ']' : s;
  };

  const fill = (t, value, opts) => {
    const el = __resolve(t);
    if (!el) return { ok: false, error: 'target not found' };
    // 原生 setter 会绕过 readonly/disabled：不拦就会「写成功但页面不认」，属于最坏的一类静默失败
    if (el.disabled === true || el.readOnly === true) {
      return { ok: false, error: el.disabled ? 'target is disabled' : 'target is read-only (the page will ignore the value)', target: __desc(el) };
    }
    const clear = !(opts && opts.clear === false);
    const VAL = String(value === undefined || value === null ? '' : value);
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); el.focus(); } catch (e) {}
    const isCE = el.isContentEditable === true;
    if (isCE) {
      el.textContent = clear ? VAL : ((el.textContent || '') + VAL);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      const next = clear ? VAL : ((el.value || '') + VAL);
      if (d && d.set) d.set.call(el, next); else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    __note('fill', t);
    return { ok: true, value: isCE ? (el.textContent || '') : String(el.value === undefined || el.value === null ? '' : el.value) };
  };

  const click = (t) => {
    const el = __resolve(t);
    if (!el) return { ok: false, error: 'target not found' };
    const blocked = __blocked(el);
    if (blocked) return { ok: false, error: blocked, target: __desc(el), hint: 'click the wrapper/ancestor instead, or use browser_click' };
    const before = location.href;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    try { if (el.focus) el.focus(); } catch (e) {}
    el.click();
    __note('click', t);
    return { ok: true, clicked: __desc(el), url: location.href, redirected: location.href !== before };
  };

  const press = (key, t) => {
    const el = (t === undefined || t === null) ? (document.activeElement || document.body) : __resolve(t);
    if (!el) return { ok: false, error: 'target not found' };
    const K = String(key === undefined || key === null ? '' : key);
    if (!K) return { ok: false, error: 'key is required' };
    const NAMED = { Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'],
      Delete: [46, 'Delete'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'],
      ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'] };
    const named = NAMED[K];
    const keyCode = named ? named[0] : (K.toUpperCase().charCodeAt(0) || 0);
    const init = { key: K, code: named ? named[1] : (/^[a-z]$/i.test(K) ? 'Key' + K.toUpperCase() : (/^[0-9]$/.test(K) ? 'Digit' + K : '')), keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
    const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    let submitted = false;
    if (K === 'Enter' && notCancelled) {
      const form = el.form || (el.closest ? el.closest('form') : null);
      if (form) { try { if (form.requestSubmit) form.requestSubmit(); else form.submit(); submitted = true; } catch (e) {} }
    }
    __note('press', K);
    return { ok: true, key: K, submitted };
  };

  const scroll = (t, opts) => {
    const o = opts || {};
    if (t !== undefined && t !== null) {
      const el = __resolve(t);
      if (!el) return { ok: false, error: 'target not found' };
      el.scrollIntoView({ block: o.block || 'center', inline: 'nearest' });
      __note('scroll', t);
      return { ok: true, scrolledTo: __desc(el), y: Math.round(window.scrollY) };
    }
    if (Number.isFinite(Number(o.to))) window.scrollTo(0, Number(o.to));
    else window.scrollBy(0, Number(o.by) || Math.round(window.innerHeight * 0.9));
    __note('scroll', Number.isFinite(Number(o.to)) ? 'to ' + o.to : 'by ' + (o.by || 'page'));
    return { ok: true, y: Math.round(window.scrollY) };
  };

  /** 页内快照：与工具层 browser_snapshot 同一份实现，ref 编号规则一致（含 shadow root 作用域前缀）。
   *  边界：页内脚本跨不到子帧，所以这里只有主文档（含其 shadow root）；要连子帧一起看，用 browser_snapshot 工具。 */
  const snapshot = (opts) => { const __snapMax = (opts && Number(opts.max)) || 80; const __snapFramePath = ''; return ${SNAPSHOT_BODY}; };

  const goto = (url) => {
    const u = String(url || '').trim();
    if (!__allowNav) throw new Error('bb.goto requires allowNav=true on browser_page_script');
    if (!/^https?:\\/\\//i.test(u)) throw new Error('bb.goto only accepts absolute http(s) URLs, got: "' + u + '"');
    __note('goto', u);
    const nav = new Error('bb.goto → ' + u);
    nav.__bbNav = u;
    throw nav; // 终止脚本：其后语句不会执行（导航交宿主完成）
  };

  // 序列化归一化：DOM 节点直接 JSON.stringify 会得到 "{}"（节点没有自有可枚举属性），
  // 模型拿到空对象后只能猜 —— 这是最坏的一类静默失败。这里把节点/集合/错误统一成可读形态。
  const __el = (el) => {
    const o = {};
    const put = (k, v) => { if (v !== undefined && v !== null && v !== '') o[k] = v; };
    try {
      const ref = el.getAttribute ? el.getAttribute('data-hippo-ref') : null;
      put('ref', ref || undefined);
      put('tag', String(el.tagName || '').toLowerCase() || undefined);
      put('id', el.id || undefined);
      put('text', String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) || undefined);
      put('href', el.href || undefined);
      put('value', el.value === undefined ? undefined : String(el.value).slice(0, 200));
      put('src', el.src || undefined);
      put('aria', el.getAttribute ? (el.getAttribute('aria-label') || undefined) : undefined);
      if (el.disabled === true) o.disabled = true;
      if (el.checked === true) o.checked = true;
    } catch (e) {}
    return o;
  };
  const __ser = (v, depth, seen) => {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…[+' + (v.length - 2000) + ']' : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'bigint' || t === 'symbol') return String(v);
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Map) return __ser(Array.from(v.entries()), depth + 1, seen);
    if (v instanceof Set) return __ser(Array.from(v.values()), depth + 1, seen);
    if (typeof Node !== 'undefined' && v instanceof Node) {
      if (v.nodeType === 1) return __el(v);
      if (v.nodeType === 3) return String(v.nodeValue || '').slice(0, 2000);
      return '[' + (v.nodeName || 'node') + ']';
    }
    const isColl = (typeof NodeList !== 'undefined' && v instanceof NodeList) || (typeof HTMLCollection !== 'undefined' && v instanceof HTMLCollection);
    if (isColl) {
      const n = Math.min(v.length, 100);
      const arr = [];
      for (let i = 0; i < n; i += 1) arr.push(__ser(v[i], depth + 1, seen));
      if (v.length > n) arr.push('[+' + (v.length - n) + ' more]');
      return arr;
    }
    if (depth >= 5) return '[depth limit]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    let out;
    if (Array.isArray(v)) {
      const n = Math.min(v.length, 100);
      out = [];
      for (let i = 0; i < n; i += 1) out.push(__ser(v[i], depth + 1, seen));
      if (v.length > n) out.push('[+' + (v.length - n) + ' more]');
    } else {
      out = {};
      const keys = Object.keys(v);
      const n = Math.min(keys.length, 60);
      for (let i = 0; i < n; i += 1) {
        try { out[keys[i]] = __ser(v[keys[i]], depth + 1, seen); } catch (e) { out[keys[i]] = '[unreadable]'; }
      }
      if (keys.length > n) out.__more = '+' + (keys.length - n) + ' keys';
    }
    seen.delete(v);
    return out;
  };
  // 超预算时给可读的截断信封，而不是让外层把 JSON 拦腰切断（模型能据此改写脚本、收窄返回值）
  const __flat = (v) => {
    const norm = __ser(v, 0, new WeakSet());
    let s;
    try { s = JSON.stringify(norm); } catch (e) { s = String(norm); }
    if (s === undefined) s = String(norm);
    if (s.length <= __cap) return norm;
    return { __truncated: true, chars: s.length, cap: __cap, head: s.slice(0, Math.max(200, __cap - 400)) };
  };

  const bb = { sleep, waitFor, waitText, $, ref, text, fill, click, press, scroll, snapshot, goto };
  try {
    const __out = await (async () => { ${script}
    })();
    return { kind: 'value', value: __out === undefined ? null : __flat(__out) };
  } catch (e) {
    if (e && e.__bbNav) return { kind: 'nav', url: e.__bbNav, steps: __trace() };
    // 不 throw：失败也要把「已经做成了什么」带回去 —— 否则模型只能重跑整个脚本，把已完成的点击/提交再做一遍
    return { kind: 'error', message: e && e.message ? String(e.message) : String(e), steps: __trace() };
  }
})()`;
}

/** 交互点选脚本：悬浮高亮 + 点击取元素 + Esc 取消（返回选择器信息或 null） */
function pickScript(timeoutMs: number): string {
  return `(() => new Promise((resolve) => {
  const TIMEOUT = ${timeoutMs};
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #e5484d;background:rgba(229,72,77,.12);border-radius:2px;transition:all .05s;';
  document.documentElement.appendChild(box);
  let cur = null;
  const done = (val) => {
    try { box.remove(); } catch (e) {}
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
    resolve(val);
  };
  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  };
  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === cur) return;
    cur = el;
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  };
  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    if (!el) return done(null);
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '';
    done({
      selector: cssPath(el),
      tag: (el.tagName || '').toLowerCase(),
      role: el.getAttribute('role') || '',
      name: String(raw).replace(/\\s+/g, ' ').trim().slice(0, 80),
    });
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  const timer = setTimeout(() => done(null), TIMEOUT);
})())`;
}

/** 单次工具调用分发 */
export async function execBrowserTool(
  name: string,
  args: Record<string, unknown>,
  host: ExecHost,
): Promise<Envelope> {
  const startedAt = Date.now();
  const wc = host.activeWebContents();
  if (!isAlive(wc)) {
    return fail('driver', 'Hippo Browser 未就绪', '请先打开 BobWork 的 Hippo Browser 窗口');
  }
  // 任何工具调用都先把遥测绑上（幂等、仅首次有开销），保证监控面从页面打开起就在记录
  await bindTelemetry(wc);

  // 目标元素瞬时描边（纯视觉反馈，失败静默）：让用户看见 AI 正在操作哪一个元素。
  // 仅元素定向的写操作不倒框（见 FLASH_TOOLS）；先于真实操作执行，框落在同一元素上。
  if (FLASH_TOOLS.has(name)) {
    const resolver = resolverExpr(args);
    const flashTarget = targetFrame(wc, args);
    if (resolver && !staleFrameError(flashTarget)) {
      // 描边在目标元素**所在帧**内绘制：子帧内的 position:fixed 覆盖层正好落在该帧视口上，视觉仍对齐
      await run<boolean>(wc, flashScript(resolver), flashTarget.frame).catch(() => false);
    }
  }

  try {
    switch (name) {
      // ---- 导航 ----
      case 'browser_navigate': {
        const url = String(args.url ?? '').trim();
        if (!url) return fail('syntax', 'url 必填');
        const denied = navGateError(url, 'browser_navigate');
        if (denied) return fail('nav-denied', denied);
        await host.navigate(url, args.newTab === true);
        const target = host.activeWebContents();
        if (isAlive(target)) {
          await bindTelemetry(target); // 先绑再等加载：本次导航自身的请求也进缓冲
          const loaded = await waitForLoad(target, LOAD_TIMEOUT_MS);
          const value = { url: target.getURL(), title: target.getTitle() };
          if (!loaded) {
            return { ...ok(value, startedAt, target), warnings: ['页面加载超时，结果为当前状态'] };
          }
          return ok(value, startedAt, target);
        }
        return ok({ url }, startedAt, wc);
      }

      case 'browser_back': {
        const nh = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; goBack(): void } }).navigationHistory;
        if (nh && typeof nh.goBack === 'function') {
          if (!nh.canGoBack()) return fail('inject', '没有可回退的历史记录');
          nh.goBack();
        } else {
          if (!wc.canGoBack()) return fail('inject', '没有可回退的历史记录');
          wc.goBack();
        }
        await waitForLoad(wc, LOAD_TIMEOUT_MS);
        return ok({ url: wc.getURL(), title: wc.getTitle() }, startedAt, wc);
      }

      case 'browser_forward': {
        const nh = (wc as unknown as { navigationHistory?: { canGoForward(): boolean; goForward(): void } }).navigationHistory;
        if (nh && typeof nh.goForward === 'function') {
          if (!nh.canGoForward()) return fail('inject', '没有可前进的历史记录');
          nh.goForward();
        } else {
          if (!wc.canGoForward()) return fail('inject', '没有可前进的历史记录');
          wc.goForward();
        }
        await waitForLoad(wc, LOAD_TIMEOUT_MS);
        return ok({ url: wc.getURL(), title: wc.getTitle() }, startedAt, wc);
      }

      case 'browser_reload': {
        if (args.ignoreCache === true) wc.reloadIgnoringCache();
        else wc.reload();
        await waitForLoad(wc, LOAD_TIMEOUT_MS);
        return ok({ url: wc.getURL(), title: wc.getTitle() }, startedAt, wc);
      }

      // ---- 等待 ----
      case 'browser_wait': {
        const ms = Math.min(30000, Math.max(0, Number(args.ms) || 1000));
        await new Promise((r) => setTimeout(r, ms));
        const ready = await run<boolean>(wc, 'document.readyState === "complete"').catch(() => false);
        return ok({ waitedMs: ms, ready, url: wc.getURL() }, startedAt, wc);
      }

      case 'browser_wait_for': {
        const resolver = resolverExpr(args);
        if (!resolver) return fail('syntax', '需要 ref 或 selector 之一');
        const waitTarget = targetFrame(wc, args);
        const waitStale = staleFrameError(waitTarget);
        if (waitStale) return fail('inject', waitStale);
        const timeoutMs = Math.min(60000, Math.max(100, Number(args.timeoutMs) || 10000));
        const wantVisible = args.visible !== false;
        const probe = wantVisible
          ? `(() => { const el = ${resolver}; if (!el) return false; const r = el.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; })()`
          : `!!(${resolver})`;
        const { hit, elapsedMs } = await pollUntil(wc, probe, timeoutMs, waitTarget.frame);
        const value: Record<string, unknown> = { found: hit, elapsedMs, selector: String(args.ref || args.selector || '') };
        if (waitTarget.path) value.frame = waitTarget.path;
        if (!hit) {
          return { ok: false, error: { phase: 'wait-timeout', message: `等待元素超时（${timeoutMs}ms）` }, value };
        }
        return ok(value, startedAt, wc);
      }

      case 'browser_wait_for_text': {
        const text = String(args.text ?? '');
        if (!text) return fail('syntax', 'text 必填');
        const timeoutMs = Math.min(60000, Math.max(100, Number(args.timeoutMs) || 10000));
        const probe = `(document.body ? document.body.innerText : '').includes(${JSON.stringify(text)})`;
        const { hit, elapsedMs } = await pollUntil(wc, probe, timeoutMs);
        if (!hit) {
          return {
            ok: false,
            error: { phase: 'wait-timeout', message: `等待文本超时（${timeoutMs}ms）: ${text.slice(0, 80)}` },
            value: { found: false, elapsedMs },
          };
        }
        return ok({ found: true, elapsedMs }, startedAt, wc);
      }

      case 'browser_wait_network_idle': {
        const idleMs = Math.min(5000, Math.max(100, Number(args.idleMs) || 500));
        const timeoutMs = Math.min(60000, Math.max(500, Number(args.timeoutMs) || 15000));
        const t = await ensureTelemetry(wc);
        const t0 = Date.now();
        let quietSince = Date.now();
        for (;;) {
          if (t.inflight.size === 0) {
            if (Date.now() - quietSince >= idleMs) {
              return ok({ idle: true, inflight: 0, elapsedMs: Date.now() - t0 }, startedAt, wc);
            }
          } else {
            quietSince = Date.now();
          }
          if (Date.now() - t0 >= timeoutMs) {
            return ok({ idle: false, inflight: t.inflight.size, elapsedMs: Date.now() - t0 }, startedAt, wc);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // ---- 元素交互 ----
      case 'browser_snapshot': {
        const max = Math.min(300, Math.max(1, Number(args.max) || 80));
        await waitForLoad(wc, SNAPSHOT_TIMEOUT_MS);
        const value = await runSnapshot(wc, max);
        return ok(value, startedAt, wc);
      }

      case 'browser_pick_element_ref': {
        const timeoutMs = Math.min(180000, Math.max(1000, Number(args.timeoutMs) || 60000));
        const picked = await run<{ selector: string; tag: string; role: string; name: string } | null>(
          wc,
          pickScript(timeoutMs),
        );
        if (!picked) return fail('timeout', `用户未在 ${timeoutMs}ms 内点选元素（或按 Esc 取消）`);
        const ref = 'p' + Date.now().toString(36).slice(-4);
        await run<boolean>(
          wc,
          `(() => { const el = document.querySelector(${JSON.stringify(picked.selector)}); if (!el) return false; el.setAttribute('data-hippo-ref', ${JSON.stringify(ref)}); return true; })()`,
        );
        return ok({ picked: true, ref, ...picked }, startedAt, wc);
      }

      case 'browser_click': {
        const resolver = resolverExpr(args);
        if (!resolver) return fail('syntax', '需要 ref 或 selector 之一');
        const clickTarget = targetFrame(wc, args);
        const clickStale = staleFrameError(clickTarget);
        if (clickStale) return fail('inject', clickStale);
        const before = wc.getURL();
        if (clickTarget.frame) {
          // 子帧目标：帧内合成点击（跨帧坐标换算不可靠，见 frameClickScript 注释）
          const r = await run<{ ok: boolean; error?: string; desc?: string }>(wc, frameClickScript(resolver), clickTarget.frame);
          if (!r?.ok) return fail('inject', r?.error || '未找到目标元素（页面可能已变化，请重新 browser_snapshot）');
          await new Promise((res) => setTimeout(res, CLICK_SETTLE_MS));
          const after = wc.getURL();
          return ok({ clicked: r.desc, frame: clickTarget.path, via: 'in-frame', url: after, title: wc.getTitle(), redirected: after !== before }, startedAt, wc);
        }
        const box = await run<{ desc: string; x: number; y: number } | null>(wc, centerScript(resolver));
        if (!box) return fail('inject', '未找到目标元素（页面可能已变化，请重新 browser_snapshot）');
        await mouseClick(wc, box.x, box.y);
        await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS));
        const afterUrl = wc.getURL();
        return ok({ clicked: box.desc, url: afterUrl, title: wc.getTitle(), redirected: afterUrl !== before }, startedAt, wc);
      }

      case 'browser_click_coordinates': {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('syntax', 'x / y 必填');
        const button = (['left', 'right', 'middle'] as const).find((b) => b === args.button) || 'left';
        const before = wc.getURL();
        await mouseClick(wc, x, y, button);
        await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS));
        const after = wc.getURL();
        return ok({ clicked: true, x, y, url: after, title: wc.getTitle(), redirected: after !== before }, startedAt, wc);
      }

      case 'browser_hover': {
        const resolver = resolverExpr(args);
        if (!resolver) return fail('syntax', '需要 ref 或 selector 之一');
        const hoverTarget = targetFrame(wc, args);
        const hoverStale = staleFrameError(hoverTarget);
        if (hoverStale) return fail('inject', hoverStale);
        if (hoverTarget.frame) {
          const r = await run<{ ok: boolean; error?: string; desc?: string }>(wc, frameHoverScript(resolver), hoverTarget.frame);
          if (!r?.ok) return fail('inject', r?.error || '未找到目标元素');
          return ok({ hovered: r.desc, frame: hoverTarget.path, via: 'in-frame' }, startedAt, wc);
        }
        const box = await run<{ desc: string; x: number; y: number } | null>(wc, centerScript(resolver));
        if (!box) return fail('inject', '未找到目标元素');
        await ensureDomain(wc, 'Page');
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
        return ok({ hovered: box.desc }, startedAt, wc);
      }

      case 'browser_drag': {
        const from = await resolvePoint(wc, (args.from ?? {}) as Record<string, unknown>);
        const to = await resolvePoint(wc, (args.to ?? {}) as Record<string, unknown>);
        if (!from) return fail('inject', '拖拽起点未找到');
        if (!to) return fail('inject', '拖拽终点未找到');
        await ensureDomain(wc, 'Page');
        const send = (type: string, x: number, y: number, button: string): Promise<unknown> =>
          wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1 });
        await send('mouseMoved', from.x, from.y, 'none');
        await send('mousePressed', from.x, from.y, 'left');
        // 中间位移不逐帧等 ack：CDP 通道有序，事件仍按序投递；
        // 窗口不可见（最小化/遮挡）时 renderer 不给 ack，逐帧 await 会让一次拖拽退化成数十秒。
        for (let i = 1; i <= 10; i++) {
          const rx = from.x + ((to.x - from.x) * i) / 10;
          const ry = from.y + ((to.y - from.y) * i) / 10;
          void send('mouseMoved', rx, ry, 'left').catch(() => undefined);
          await new Promise((r) => setTimeout(r, 15));
        }
        await send('mouseReleased', to.x, to.y, 'left');
        await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS));
        return ok({ dragged: true, from: from.desc, to: to.desc }, startedAt, wc);
      }

      case 'browser_check':
      case 'browser_uncheck': {
        const want = name === 'browser_check';
        const resolver = resolverExpr(args);
        if (!resolver) return fail('syntax', '需要 ref 或 selector 之一');
        const checkTarget = targetFrame(wc, args);
        const checkStale = staleFrameError(checkTarget);
        if (checkStale) return fail('inject', checkStale);
        if (checkTarget.frame) {
          const r = await run<{ ok: boolean; error?: string; checked?: boolean; changed?: boolean }>(
            wc,
            frameCheckScript(resolver, want),
            checkTarget.frame,
          );
          if (!r?.ok) return fail('inject', r?.error || '未找到目标元素');
          return ok({ checked: !!r.checked, changed: !!r.changed, frame: checkTarget.path, via: 'in-frame' }, startedAt, wc);
        }
        const state = await run<{ found: boolean; checked: boolean; x: number; y: number }>(
          wc,
          `(() => { const el = ${resolver}; if (!el) return { found: false, checked: false, x: 0, y: 0 };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { found: true, checked: !!el.checked, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        if (!state.found) return fail('inject', '未找到目标元素');
        if (state.checked === want) return ok({ checked: state.checked, changed: false }, startedAt, wc);
        await mouseClick(wc, state.x, state.y);
        await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS));
        const after = await run<boolean>(wc, `(() => { const el = ${resolver}; return !!(el && el.checked); })()`).catch(() => want);
        return ok({ checked: after, changed: true }, startedAt, wc);
      }

      case 'browser_select_option': {
        const resolver = resolverExpr(args);
        if (!resolver) return fail('syntax', '需要 ref 或 selector 之一');
        const selectTarget = targetFrame(wc, args);
        const selectStale = staleFrameError(selectTarget);
        if (selectStale) return fail('inject', selectStale);
        const r = await run<{ ok: boolean; error?: string; value?: string; text?: string }>(
          wc,
          `(() => {
  const el = ${resolver};
  if (!el) return { ok: false, error: 'element not found' };
  if (!(el instanceof HTMLSelectElement)) return { ok: false, error: 'element is not a <select>' };
  const opts = Array.from(el.options);
  let target = null;
  const value = ${JSON.stringify(args.value !== undefined ? String(args.value) : null)};
  const label = ${JSON.stringify(args.label !== undefined ? String(args.label) : null)};
  const index = ${Number.isFinite(Number(args.index)) ? Number(args.index) : 'null'};
  if (value !== null) target = opts.find((o) => o.value === value);
  else if (label !== null) target = opts.find((o) => (o.label || o.text || '').trim() === label);
  else if (index !== null) target = opts[index];
  if (!target) return { ok: false, error: 'option not found' };
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (desc && desc.set) desc.set.call(el, target.value); else el.value = target.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: el.value, text: (target.label || target.text || '').trim() };
})()`,
          selectTarget.frame,
        );
        if (!r?.ok) return fail('inject', r?.error || '选择失败');
        return ok({ selected: true, value: r.value ?? '', text: r.text ?? '' }, startedAt, wc);
      }

      case 'browser_submit': {
        const resolver = resolverExpr(args);
        if (!resolver) return fail('syntax', '需要 ref 或 selector 之一');
        const submitTarget = targetFrame(wc, args);
        const submitStale = staleFrameError(submitTarget);
        if (submitStale) return fail('inject', submitStale);
        const r = await run<{ ok: boolean; error?: string }>(
          wc,
          `(() => { const el = ${resolver}; if (!el) return { ok: false, error: 'element not found' };
  const form = el.form || (el.closest ? el.closest('form') : null);
  if (!form) return { ok: false, error: 'no owning form' };
  if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
  return { ok: true }; })()`,
          submitTarget.frame,
        );
        if (!r?.ok) return fail('inject', r?.error || '提交失败');
        await waitForLoad(wc, LOAD_TIMEOUT_MS);
        return ok({ submitted: true, url: wc.getURL(), title: wc.getTitle() }, startedAt, wc);
      }

      case 'browser_mouse_wheel': {
        const deltaY = Number.isFinite(Number(args.deltaY)) ? Number(args.deltaY) : 400;
        const deltaX = Number.isFinite(Number(args.deltaX)) ? Number(args.deltaX) : 0;
        const pos = await run<{ x: number; y: number }>(
          wc,
          `(() => ({ x: ${Number.isFinite(Number(args.x)) ? Number(args.x) : 'window.innerWidth / 2'}, y: ${Number.isFinite(Number(args.y)) ? Number(args.y) : 'window.innerHeight / 2'} }))()`,
        );
        await ensureDomain(wc, 'Page');
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: pos.x,
          y: pos.y,
          deltaX,
          deltaY,
          button: 'none',
        });
        await new Promise((r) => setTimeout(r, 250));
        const value = await run<Record<string, unknown>>(
          wc,
          `(() => { const h = document.documentElement.scrollHeight; const vh = window.innerHeight;
  return { scrollY: Math.round(window.scrollY), pageHeight: h, viewportHeight: vh, atBottom: window.scrollY + vh >= h - 2 }; })()`,
        );
        return ok(value, startedAt, wc);
      }

      case 'browser_upload_file': {
        const files = Array.isArray(args.files) ? (args.files as unknown[]).map((f) => String(f)).filter(Boolean) : [];
        if (!files.length) return fail('syntax', 'files 不能为空');
        const selector = selectorOf(args);
        if (!selector) return fail('syntax', '需要 ref 或 selector 之一');
        // CDP 的 DOM.querySelector 固定在主文档根上，跨不到子帧/ shadow root —— 这类 ref 必须先说明白，
        // 而不是让 DOM 查询「找不到元素」把模型引向错误结论
        const uploadRef = typeof args.ref === 'string' ? args.ref.trim() : '';
        if (uploadRef && framePathOfRef(uploadRef)) {
          return fail('unsupported', `upload_file 暂不支持子帧内的 ref（${uploadRef}）`, '请改用主文档内的 file input，或用 browser_page_script 在子帧内设置文件');
        }
        await ensureDomain(wc, 'DOM');
        const doc = (await wc.debugger.sendCommand('DOM.getDocument', { depth: -1 })) as { root: { nodeId: number } };
        const found = (await wc.debugger.sendCommand('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector,
        })) as { nodeId: number };
        if (!found?.nodeId) return fail('inject', '未找到 file input 元素');
        await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: found.nodeId, files });
        await run<boolean>(wc, `(() => { const el = ${resolverExpr(args)}; if (!el) return false; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`).catch(() => false);
        return ok({ uploaded: true, count: files.length, files }, startedAt, wc);
      }

      case 'browser_type': {
        const text = String(args.text ?? '');
        const resolver = resolverExpr(args);
        if (!resolver) return fail('syntax', '需要 ref 或 selector 之一');
        const typeTarget = targetFrame(wc, args);
        const typeStale = staleFrameError(typeTarget);
        if (typeStale) return fail('inject', typeStale);
        const r = await run<{ ok: boolean; value?: string; error?: string }>(
          wc,
          fillScript(resolver, text, args.clear !== false),
          typeTarget.frame,
        );
        if (!r?.ok) return fail('inject', r?.error || '元素不可填写');
        return ok({ filled: String(args.ref || args.selector || ''), value: r.value ?? '' }, startedAt, wc);
      }

      case 'browser_fill_form': {
        const fields = Array.isArray(args.fields) ? (args.fields as Array<Record<string, unknown>>) : [];
        if (!fields.length) return fail('syntax', 'fields 不能为空');
        const filled: Array<{ target: string; value: string; ok: boolean }> = [];
        const failed: Array<{ target: string; error: string }> = [];
        for (const f of fields) {
          const resolver = resolverExpr(f);
          const target = String(f.ref || f.selector || '');
          if (!resolver) {
            failed.push({ target, error: '缺少 ref / selector' });
            continue;
          }
          const fieldTarget = targetFrame(wc, f);
          const fieldStale = staleFrameError(fieldTarget);
          if (fieldStale) {
            failed.push({ target, error: fieldStale });
            continue;
          }
          const text = String(f.value ?? '');
          // 多字段表单：逐格描边，用户能看到 AI 正在填哪一格
          await run<boolean>(wc, flashScript(resolver), fieldTarget.frame).catch(() => false);
          const r = await run<{ ok: boolean; value?: string; error?: string }>(
            wc,
            fillScript(resolver, text, true),
            fieldTarget.frame,
          );
          if (r?.ok) filled.push({ target, value: r.value ?? '', ok: true });
          else failed.push({ target, error: r?.error || '写入失败' });
        }
        return ok({ filled, failed }, startedAt, wc);
      }

      case 'browser_press_key': {
        const spec = String(args.key ?? '').trim();
        if (!spec) return fail('syntax', 'key 必填');
        const { stroke, modifiers } = parseKeyStroke(spec);
        await ensureDomain(wc, 'Page');
        const withMods = (extra: Record<string, unknown>): Record<string, unknown> => ({
          key: stroke.key,
          code: stroke.code,
          windowsVirtualKeyCode: stroke.keyCode,
          nativeVirtualKeyCode: stroke.keyCode,
          modifiers,
          ...extra,
        });
        if (stroke.text && modifiers === 0) {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', withMods({ type: 'keyDown', text: stroke.text }));
        } else {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', withMods({ type: 'rawKeyDown' }));
        }
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', withMods({ type: 'keyUp' }));
        return ok({ key: spec }, startedAt, wc);
      }

      case 'browser_scroll': {
        const direction = String(args.direction ?? 'down');
        const amount = Number(args.amount) || 0;
        const value = await run<Record<string, unknown>>(
          wc,
          `(() => {
  const dir = ${JSON.stringify(direction)};
  const amt = ${JSON.stringify(amount)} || window.innerHeight * 0.85;
  const h = document.documentElement.scrollHeight;
  const vh = window.innerHeight;
  const cur = window.scrollY;
  let y = cur;
  if (dir === 'top') y = 0;
  else if (dir === 'bottom') y = h;
  else if (dir === 'up') y = Math.max(0, cur - amt);
  else y = Math.min(h, cur + amt);
  window.scrollTo(0, y);
  return { scrollY: Math.round(window.scrollY), pageHeight: h, viewportHeight: vh, atBottom: window.scrollY + vh >= h - 2 };
})()`,
        );
        return ok(value, startedAt, wc);
      }

      // ---- 内容提取 ----
      case 'browser_extract_text': {
        const ext = await host.extract();
        // note/kind 随文本一起透传：PDF / 登录墙 / 空壳页面拿不到正文时，
        // 模型需要这个信号决定「换 browser_read_pdf」还是「如实说明读不到」，而不是把空文本当成页面无内容
        return ok({ url: ext.url, title: ext.title, ready: ext.ready, text: ext.text, markdown: ext.markdown, note: ext.note, kind: ext.kind }, startedAt, wc);
      }

      case 'browser_read_article': {
        const maxChars = Math.max(500, Number(args.maxChars) || 20000);
        const ext = await host.extract();
        const markdown = (ext.markdown || ext.text || '').slice(0, maxChars);
        return ok({ title: ext.title, url: ext.url, markdown }, startedAt, wc);
      }

      case 'browser_get_html': {
        const maxChars = Math.min(100000, Math.max(500, Number(args.maxChars) || 20000));
        const outer = args.outer === true;
        const html = await run<string>(
          wc,
          `(() => { const h = ${outer ? 'document.documentElement.outerHTML' : '(document.body ? document.body.innerHTML : "")'}; return h || ''; })()`,
        );
        const truncated = html.length > maxChars;
        return ok({ html: html.slice(0, maxChars), truncated, bytes: html.length }, startedAt, wc);
      }

      case 'browser_get_viewport': {
        const value = await run<Record<string, unknown>>(
          wc,
          `(() => ({ width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(window.scrollX),
  scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight, devicePixelRatio: window.devicePixelRatio }))()`,
        );
        return ok(value, startedAt, wc);
      }

      // ---- 截图 / 导出 ----
      case 'browser_screenshot': {
        const fullPage = args.fullPage === true;
        const dataUrl = await host.capture({ fullPage });
        return ok({ dataUrl, fullPage }, startedAt, wc);
      }

      case 'browser_export_pdf': {
        const pageSize = (['A4', 'A3', 'Letter', 'Legal', 'Tabloid'] as const).find((s) => s === args.pageSize) || 'A4';
        const buf = await wc.printToPDF({
          landscape: args.landscape === true,
          printBackground: args.printBackground !== false,
          pageSize,
        });
        const dataUrl = 'data:application/pdf;base64,' + buf.toString('base64');
        return ok({ dataUrl, bytes: buf.length, pageSize, title: wc.getTitle(), url: wc.getURL() }, startedAt, wc);
      }

      // ---- 标签页 ----
      case 'browser_list_tabs': {
        const list = host.listTabs();
        const active = list.find((t) => t.active)?.id ?? 0;
        return ok({ active, tabs: list }, startedAt, wc);
      }

      case 'browser_active_tab': {
        const t = host.listTabs().find((x) => x.active);
        if (!t) return fail('driver', '没有活动标签');
        return ok({ id: t.id, title: t.title, url: t.url }, startedAt, wc);
      }

      case 'browser_switch_tab': {
        const id = Number(args.id);
        if (!Number.isFinite(id)) return fail('syntax', 'id 必填');
        if (!host.activateTab(id)) return fail('inject', `标签 ${id} 不存在`);
        await new Promise((r) => setTimeout(r, 150));
        await bindTelemetry(host.activeWebContents()); // 切过去的标签也纳入遥测
        const t = host.listTabs().find((x) => x.id === id);
        return ok({ id, title: t?.title ?? '', url: t?.url ?? '' }, startedAt, host.activeWebContents());
      }

      case 'browser_open_tab': {
        const url = String(args.url ?? '').trim();
        if (!url) return fail('syntax', 'url 必填');
        const denied = navGateError(url, 'browser_open_tab');
        if (denied) return fail('nav-denied', denied);
        const r = host.openTab(url, args.activate !== false);
        if (!r.ok) return fail('inject', r.error || '打开标签失败');
        // 等待「新标签自身」加载完：activate:false 时活动标签仍是旧标签，
        // 若等旧标签会立刻返回，新标签的 url/title 还是空白页占位值。
        const target = (r.id !== undefined ? host.webContentsOfTab(r.id) : null) ?? host.activeWebContents();
        await bindTelemetry(target); // 新标签一开就记遥测
        if (isAlive(target)) await waitForLoad(target, LOAD_TIMEOUT_MS);
        const t = host.listTabs().find((x) => x.id === r.id);
        return ok({ id: r.id, url: t?.url || url, title: t?.title || '' }, startedAt, host.activeWebContents());
      }

      case 'browser_close_tab': {
        const list = host.listTabs();
        const id = Number.isFinite(Number(args.id)) ? Number(args.id) : list.find((t) => t.active)?.id;
        if (id === undefined) return fail('driver', '没有可关闭的标签');
        if (!list.some((t) => t.id === id)) return fail('inject', `标签 ${id} 不存在`);
        const r = host.closeTab(id);
        return ok({ closed: true, id, activeId: r.activeId }, startedAt, host.activeWebContents());
      }

      // ---- 数据面 ----
      case 'browser_get_cookies': {
        const url = String(args.url || wc.getURL() || '');
        const cookies = await wc.session.cookies.get(url ? { url } : {});
        const list = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expires: c.expirationDate ?? 0,
        }));
        return ok({ cookies: list, count: list.length }, startedAt, wc);
      }

      case 'browser_set_cookie': {
        const url = String(args.url ?? '').trim();
        const cookieName = String(args.name ?? '').trim();
        if (!url || !cookieName) return fail('syntax', 'url / name 必填');
        await wc.session.cookies.set({
          url,
          name: cookieName,
          value: String(args.value ?? ''),
          domain: args.domain ? String(args.domain) : undefined,
          path: args.path ? String(args.path) : '/',
          secure: args.secure === true,
          httpOnly: args.httpOnly === true,
          expirationDate: Number.isFinite(Number(args.expirationDate)) ? Number(args.expirationDate) : undefined,
        });
        return ok({ set: true, name: cookieName, url }, startedAt, wc);
      }

      case 'browser_clear_cookies': {
        const url = String(args.url || '').trim();
        if (url) {
          const cookies = await wc.session.cookies.get({ url });
          for (const c of cookies) {
            await wc.session.cookies.remove(url, c.name).catch(() => {});
          }
          return ok({ cleared: true, url, count: cookies.length }, startedAt, wc);
        }
        await wc.session.clearStorageData({ storages: ['cookies'] });
        return ok({ cleared: true, url: '' }, startedAt, wc);
      }

      case 'browser_get_storage': {
        const type = args.type === 'session' ? 'sessionStorage' : 'localStorage';
        const maxItems = Math.max(1, Number(args.maxItems) || 200);
        const items = await run<Array<{ key: string; value: string }>>(
          wc,
          `(() => { const s = window.${type}; const out = [];
  for (let i = 0; i < s.length && out.length < ${maxItems}; i++) { const k = s.key(i); out.push({ key: k, value: String(s.getItem(k) ?? '') }); }
  return out; })()`,
        );
        return ok({ type: type === 'sessionStorage' ? 'session' : 'local', items, count: items.length }, startedAt, wc);
      }

      case 'browser_set_storage': {
        const key = String(args.key ?? '');
        if (!key) return fail('syntax', 'key 必填');
        const type = args.type === 'session' ? 'sessionStorage' : 'localStorage';
        const value = String(args.value ?? '');
        await run<boolean>(
          wc,
          `(() => { window.${type}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; })()`,
        );
        return ok({ type: type === 'sessionStorage' ? 'session' : 'local', key, value }, startedAt, wc);
      }

      case 'browser_clear_storage': {
        const want = String(args.type ?? 'both');
        const areas = want === 'local' ? ['localStorage'] : want === 'session' ? ['sessionStorage'] : ['localStorage', 'sessionStorage'];
        await run<boolean>(
          wc,
          `(() => { ${areas.map((a) => `try { window.${a}.clear(); } catch (e) {}`).join(' ')} return true; })()`,
        );
        return ok({ type: want, cleared: true }, startedAt, wc);
      }

      // ---- 监控面 ----
      case 'browser_network_requests': {
        const limit = Math.min(300, Math.max(1, Number(args.limit) || 100));
        const t = await ensureTelemetry(wc);
        const list = t.net.slice(-limit);
        if (args.clear !== false) t.net = [];
        return ok({ requests: list, count: list.length, inflight: t.inflight.size }, startedAt, wc);
      }

      case 'browser_console_logs': {
        const limit = Math.min(300, Math.max(1, Number(args.limit) || 100));
        const level = String(args.level ?? 'all');
        const t = await ensureTelemetry(wc);
        const filtered = level === 'all' ? t.logs : t.logs.filter((l) => l.level === level);
        const list = filtered.slice(-limit);
        if (args.clear !== false) t.logs = [];
        return ok({ logs: list, count: list.length }, startedAt, wc);
      }

      case 'browser_handle_dialog': {
        const t = await ensureTelemetry(wc);
        await ensureDomain(wc, 'Page');
        const info = t.dialog;
        if (!info) return ok({ handled: false, reason: '当前没有待处理的对话框' }, startedAt, wc);
        const accept = args.accept !== false;
        if (t.dialogTimer) clearTimeout(t.dialogTimer);
        t.dialogTimer = null;
        t.dialog = null;
        await wc.debugger.sendCommand('Page.handleJavaScriptDialog', {
          accept,
          promptText: args.promptText !== undefined ? String(args.promptText) : undefined,
        });
        return ok({ handled: true, type: info.type, message: info.message, accepted: accept }, startedAt, wc);
      }

      // ---- 脚本面 ----
      case 'browser_page_script': {
        const script = String(args.script ?? '');
        if (!script.trim()) return fail('syntax', 'script 必填');
        const allowNav = args.allowNav === true;
        // netMode='hybrid'：脚本内导航改由 allowNav 决定放行（字面量由静态 lint 拦、动态值由运行时兜底）。
        // 此前用 'page' 一票否决，导致 allowNav 在 Hippo 通道下是死参数、bb.goto 永远不可用。
        const lint = lintPageScript(script, { allowNav, netMode: 'hybrid', allowlist: [] });
        if (!lint.ok) {
          const errors = lint.issues.filter((i) => i.severity === 'error');
          const navRelated = errors.some((i) =>
            ['nav-denied', 'net-page-mode', 'url-not-allowlisted'].includes(i.code),
          );
          return {
            ok: false,
            error: {
              phase: navRelated ? 'nav-denied' : 'syntax',
              message: `page_script 静态检查未通过：${renderLintIssues(errors).join('; ')}`,
              hint: navRelated
                ? '脚本内导航默认被拒绝；请改用 browser_navigate 工具（跨页面的推荐做法），或对本次调用显式传 allowNav=true'
                : undefined,
            },
          };
        }
        const timeoutMs = Math.min(60000, Math.max(1000, Number(args.timeoutMs) || 15000));
        await ensureDomain(wc, 'Runtime');
        const urlBefore = wc.getURL();
        type ScriptOut = { kind?: string; value?: unknown; url?: string; message?: string; steps?: string };
        let out: ScriptOut | null = null;
        let runError: Error | null = null;
        try {
          out = await Promise.race([
            run<ScriptOut>(wc, pageScriptWrapper(script, timeoutMs, allowNav)),
            new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`page_script 超时（${timeoutMs}ms）`)), timeoutMs + 2000)),
          ]);
        } catch (e) {
          runError = e instanceof Error ? e : new Error(String(e));
        }
        const warnings = lint.issues.filter((i) => i.severity === 'warning').map((i) => `L${i.line} ${i.code}: ${i.message}`);

        // 脚本未声明的导航（bb.click 点到了链接）：执行上下文已销毁，run 会以无信息错误收尾。
        // 这里按 URL 是否变化把它识别成「页面已跳转」，返回确定结果而不是把噪音抛给模型。
        const failed = runError !== null || (out !== null && out.kind === 'error');
        if (failed && wc.getURL() !== urlBefore) {
          warnings.push('脚本因页面跳转中断：跳转后的语句未执行，页面已跳转；继续操作前请重新 browser_snapshot');
          if (out && out.steps) warnings.push(`跳转前已完成的操作：${out.steps}`);
          const loaded = await waitForLoad(wc, LOAD_TIMEOUT_MS);
          if (!loaded) warnings.push('页面加载超时，结果为当前状态');
          return {
            ...ok({ navigated: wc.getURL(), url: wc.getURL(), title: wc.getTitle() }, startedAt, wc),
            warnings,
          };
        }
        if (runError) throw runError;

        // 脚本自身失败：把操作轨迹一并交回，模型据此补跑剩余步骤，而不是重跑整个脚本
        if (out && out.kind === 'error') {
          if (out.steps) warnings.push(`失败前已完成的操作：${out.steps}`);
          return {
            ...fail(
              'script',
              out.message || '脚本执行异常（未提供错误信息）',
              out.steps ? '上述操作已生效，请只补跑剩余步骤，不要重跑整个脚本' : undefined,
            ),
            warnings,
          };
        }

        // bb.goto：脚本已终止，导航由宿主完成（页内自跳会销毁执行上下文、连结果一起丢掉）
        if (out && out.kind === 'nav' && out.url) {
          warnings.push('bb.goto 终止了脚本：其后的语句未执行，页面已跳转；继续操作前请重新 browser_snapshot');
          if (out.steps) warnings.push(`跳转前已完成的操作：${out.steps}`);
          await host.navigate(out.url, false);
          const target = host.activeWebContents();
          if (isAlive(target)) {
            await bindTelemetry(target);
            const loaded = await waitForLoad(target, LOAD_TIMEOUT_MS);
            if (!loaded) warnings.push('页面加载超时，结果为当前状态');
            return {
              ...ok({ navigated: out.url, url: target.getURL(), title: target.getTitle() }, startedAt, target),
              warnings,
            };
          }
          return { ...ok({ navigated: out.url }, startedAt, wc), warnings };
        }
        const value = out ? out.value : null;
        if (value && typeof value === 'object' && (value as { __truncated?: boolean }).__truncated) {
          warnings.push(`返回值超出 ${PAGE_SCRIPT_RETURN_CAP} 字符预算已截断：请改写脚本只返回需要的字段`);
        }
        return { ...ok({ result: value }, startedAt, wc), warnings };
      }

      case 'browser_resize_viewport': {
        const width = Number(args.width);
        const height = Number(args.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return fail('syntax', 'width / height 必填且为正数');
        }
        const deviceScaleFactor = Number.isFinite(Number(args.deviceScaleFactor)) ? Number(args.deviceScaleFactor) : 1;
        const mobile = args.mobile === true;
        await ensureDomain(wc, 'Page');
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: Math.round(width),
          height: Math.round(height),
          deviceScaleFactor,
          mobile,
        });
        return ok({ width: Math.round(width), height: Math.round(height), deviceScaleFactor, mobile }, startedAt, wc);
      }

      case 'browser_run_js': {
        const script = String(args.script ?? '').trim();
        if (!script) return fail('syntax', 'script 必填');
        await ensureDomain(wc, 'Runtime');
        // 双形态容错：先按「表达式 / IIFE」（参考实现契约）求值；
        // 若因脚本是语句体（含顶层 return）而语法失败，再按「函数体」内联执行。
        const result = await run<unknown>(
          wc,
          `(async () => {
  let v;
  try {
    v = await eval(${JSON.stringify(script)});
  } catch (e) {
    if (!(e instanceof SyntaxError) && !(e instanceof EvalError)) throw e;
    v = await (async () => { ${script}
    })();
  }
  if (v === undefined) return null;
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
})()`,
        );
        return ok({ result }, startedAt, wc);
      }

      default:
        return fail('unsupported', `Hippo 通道暂不支持 ${name}`, '该能力仅 Bob Browser 通道支持，请关闭 AI Browser 开关后重试');
    }
  } catch (e) {
    return fail('script', e instanceof Error ? e.message : String(e));
  }
}