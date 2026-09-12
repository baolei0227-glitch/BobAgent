# BobWork Hippo Browser 实施方案 v2

> 状态：定稿规约（已评审 96/100，3 个微观雷区对策已并入）
> 技术底座：Electron 43（WebContentsView）+ Next.js 16
> 分期：P0 骨架 → P1 桥接与证据 → P2 高级特性

---

## 一、定位

一个由 **Electron WebContentsView** 承载的应用内「通用导航型浏览器」：

- 与现有 iframe 预览体系**并存分工**，收编「跳出应用」的 HTML 预览；
- 承担法律检索 / 证据采集 / 人机协同登录验证码的桌面级入口；
- 与 bob-browser-mcp（真实 Chrome 通道）**并列共存**；Bob Preview 在 BobWork 内部**被取代**。

## 二、总体架构（四层）

```
渲染层 React  ──IPC──▶  主进程 Electron  ──HTTP loopback──▶  Agent 工具（Next 服务）
HippoBrowser.tsx      WebContentsView + partition         hippo_browser_*
（工具栏）              executeJavaScript / capturePage      tools.ts
```

**关键决策**：

1. 用 `WebContentsView`（Electron 30+ 官方推荐），不用 `<webview>` 标签（规避白屏 / crash / 内存泄漏）。
2. 核心闭环**免 CDP**：导航走 webContents 原生 API，提取走 `executeJavaScript`，截图走 `capturePage()`；debugger 仅在**整页长截图**与 P2 console/network 采集时临时 attach。
3. **工具栏放 React 壳，页面区放原生 View**：侧边栏 = 顶部 48px React 工具栏（地址栏 / 导航 / 提取 / 捕获）+ 其下 WebContentsView 页面区。绝不往任意第三方站点注入工具栏（避免与站点 UI / CSP 冲突）。主进程持有 visible 状态，经 `hippo-browser:state` 事件单向推给渲染层。
4. **Agent→主进程桥走「桥描述文件」而非 env**：dev 模式下 Next 由 `scripts/dev.sh` 另起，读不到 main 动态 env。主进程起 `http://127.0.0.1:<随机端口>?token=<随机>`，把地址写 `~/BobWork/.runtime/hippo-bridge.json`，Agent 工具运行时读文件再 fetch——dev 与打包版逻辑同构。

## 三、与现有体系的并存分工矩阵

| 现有能力 | 处置 | 说明 |
|---|---|---|
| 插件面板 iframe（Bob Notes / Bob Mind / Sandbox） | **保留不动** + P2 新增「在浏览器中打开」入口 | 刷新联动 / console 上报 / 元素检选依赖 iframe postMessage，独立引擎无法迁移 |
| `shell:openHtml`（HtmlViewer 跳系统浏览器） | **P0 收编** | 落点改为侧边栏 `loadURL(file://...)`，系统浏览器降级为备用 |
| bob-preview-mcp（headless 截图服务） | **BobWork 内部取代** | 其渲染+eval+console 能力被可见可交互侧边栏覆盖；插件保留给外部 MCP 客户端 |
| bob-browser-mcp（真实 Chrome 桥） | **并列共存** | `browser.*`（真 Chrome）vs `hippo_browser_*`（应用内），互不接管 |
| PDF 导出 / 打印 | 不动 | — |

## 四、微观雷区对策（评审并入）

### 雷区 1：覆盖式滑出 vs 窗口重绘闪烁（macOS Bounds 约束）

- **风险**：WebContentsView 盖在画布渲染层上方，窗口 `resize` / 全屏切换瞬间出现黑边跳动或图层穿透。
- **对策**：bounds 重算走 **16ms 防抖**（`setTimeout`），主窗口 `resize` / `resized` 事件统一入口；隐藏态直接滑出屏幕外（`x = width`）保留实例，不做销毁重建。

### 雷区 2：「提取 Markdown」的注入时机（SPA 陷阱）

- **风险**：天眼查等客户端渲染站点返回 200 但 JS 未渲染完，立即 `extract` 抓到空骨架。
- **对策**：`extract` 内置**智能等待**——`document.readyState === 'complete'` 且核心容器 `innerText.trim().length > 100`，否则 200ms 轮询，上限 6s；超时仍返回当前骨架并在 `ready` 字段标注是否就绪。核心容器选择器：`main / article / #content / .content / .article / #main`。

### 雷区 3：证据抓取整页长截图

- **风险**：裁判文书 / 长篇合同几千像素高，普通截图只截第一屏。
- **对策**：`capture({ fullPage: true })` 临时 attach debugger，走 `Page.captureScreenshot({ format:'png', captureBeyondViewport:true })` 原生整页截图，用完即 detach；视口截图仍走 `capturePage()` 免 CDP。法律证据固证刚需。

## 五、分步实施

### Step 1｜主进程：WebContentsView + 独立 session

新文件 `projects/electron/hippo-browser.ts`（main.ts 已 2588 行，不往里堆）：

- `setupHippoBrowser(win)`：创建 WebContentsView，`partition: 'persist:hippo-browser'`（cookie 与主窗口隔离、登录态持久化落盘），`contextIsolation: true, sandbox: true`；
- `win.contentView.addChildView(view)`，右侧覆盖式滑出，宽度 380，默认隐藏（滑出屏幕外）；
- 挂钩 `win.on('resize')`（16ms 防抖）重算 bounds；
- 侧边栏 webContents：`setWindowOpenHandler`（window.open → 同视图导航 + deny 新窗口）、`will-navigate` 白名单（http/https/file）、状态事件转发；
- partition session：`setPermissionRequestHandler` 默认拒绝 camera/mic/geolocation/notification；`will-download` 放默认保存；
- 快捷键：`before-input-event`（主窗口 + 侧边栏视图）捕获 Cmd+Shift+B → toggle。

### Step 2｜能力层（导航 / 提取 / 截图 / 状态）

```ts
// 导航：webContents 原生 API
view.webContents.loadURL(url); goBack(); goForward(); reload(); stop();

// DOM→Markdown 骨架（注入清洗脚本 + 雷区 2 的智能等待轮询）
const { markdown, text, title, url, ready } = await view.webContents.executeJavaScript(`(${extract.toString()})()`);

// 视口截图（免 CDP）
const dataUrl = (await view.webContents.capturePage()).toDataURL();

// 整页长截图（雷区 3：临时 attach debugger，用完 detach）
view.webContents.debugger.attach('1.3');
const { data } = await view.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
view.webContents.debugger.detach();
```

### Step 3｜IPC 与 preload

`preload.ts` 按现有 `screenOcr` 写法扩展 `hippoBrowser` 块：

```ts
hippoBrowser: {
  open:     () => ipcRenderer.invoke('hippo-browser:open'),
  close:    () => ipcRenderer.invoke('hippo-browser:close'),
  toggle:   () => ipcRenderer.invoke('hippo-browser:toggle'),
  navigate: (url: string) => ipcRenderer.invoke('hippo-browser:navigate', url),
  back/forward/reload/stop,
  extract:  () => ipcRenderer.invoke('hippo-browser:extract'),
  capture:  (opts?: { fullPage?: boolean }) => ipcRenderer.invoke('hippo-browser:capture', opts),
  getState: () => ipcRenderer.invoke('hippo-browser:get-state'),
  openExternal: () => ipcRenderer.invoke('hippo-browser:open-external'),
  onState:  (cb) => { /* 'hippo-browser:state' 事件订阅，返回取消函数 */ },
}
```

渲染层经 `desktop-adapter.ts` 的 `desktop.hippoBrowser.*` 包装调用（web 环境安全降级）。

### Step 4｜渲染层：HippoBrowser 组件

新文件 `projects/src/components/browser/HippoBrowser.tsx`（`'use client'`）：

- 顶部 48px 工具栏：地址栏（Enter 导航，失焦时回同步当前 URL）、后退 / 前进 / 刷新 / 停止、「在真 Chrome 打开」、关闭；
- 「提取 Markdown」（结果复制到剪贴板 + toast，P1 起回填对话）、「捕获」（整页截图复制 / 保存）；
- 折叠态记忆 localStorage；Cmd+Shift+B 由主进程全局兜底；
- 挂载到 `projects/src/app/layout.tsx`（与 `<ScreenOcrHost />` 并列）。

### Step 5｜openHtml 收编

`main.ts` 的 `shell:openHtml` handler：写临时文件后，侧边栏存在 → `loadURL(file://路径)` + 显示侧边栏，返回 `{ success, path, hippo: true }`；否则退回 `shell.openPath`。跨目录静态资源受限时（P1）改注册自定义协议 `bob-preview://`。

### Step 6｜Agent 工具（P1）

`src/app/api/chat/tools.ts` 注册，挂已有 `browser` scene：

```ts
hippo_browser_navigate / hippo_browser_extract / hippo_browser_capture / hippo_browser_screenshot
```

经 Step 3 的 HTTP 桥调用主进程；模型拿 Markdown 骨架省 token，截图按需调用。

### Step 7｜证据闭环（P1，法律场景）

登录态持久化在 partition（扫码一次长期复用）→ 侧边栏可见可点（验证码 / 滑块人机协同）→ `capture({ fullPage: true })` PNG + `extract` Markdown 落 `homework/.evidence/raw-web-<ts>.png|.md`，复用现有证据管线生成证据卡，连线到起草节点。

### Step 8｜安全与验证

- 侧边栏 session：权限默认拒绝、仅 http/https/file、桥 token 随机 + 仅 loopback；
- 构建：`pnpm compile:electron`（P0 无 guest preload，无需新增 tsup entry）；
- 验证一律 `projects/scripts/dev.sh`，**不部署安装版**；发布走 `SKIP_DMG=1 scripts/package-release.sh`。

## 六、分期路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | WebContentsView 骨架 + 导航 / 提取 / 截图 / 状态 + 工具栏 + `openHtml` 收编 + Cmd+Shift+B | 侧边栏可浏览任意 URL、可提取 Markdown、可整页截图、HTML 预览不再跳系统浏览器 |
| **P1** | HTTP 桥 + `hippo_browser_*` 工具 + 证据落盘 + 自定义协议 | Agent 可导航 / 提取 / 截图，证据卡入 `homework/.evidence/` |
| **P2** | 插件面板「在浏览器中打开」入口、dock 形态、console/network 采集 | 统一入口体验、可选高级能力 |

## 七、风险与边界

1. iframe 联动不可迁移（Sandbox 预览的缓存破除 / console 上报 / 元素检选不搬）；
2. file:// 跨目录资源受限 → 自定义协议兜底（P1）；
3. 桥安全：描述文件仅 loopback + token；
4. cookie 隔离是特性：侧边栏登录态不污染宿主会话。
