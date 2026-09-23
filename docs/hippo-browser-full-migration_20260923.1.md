# Hippo Browser 统一方案：AI 浏览器默认通道（Bob Browser 互补）

> 状态：待评审
> 日期：2026-09-23
> 前置结论：**Hippo Browser 成为 BobWork 的 AI 浏览器默认通道**；Bob Browser（bob-browser-mcp）不再作为端内默认依赖，转为「独立对外产物 + 操作用户真实 Chrome 的互补通道」
> 定位：两者互补而非替代 —— 替代的障碍是**浏览身份**（Electron 无法复用 Chrome profile），不是工具数量（见第十一节）
> 技术底座：Electron 43（WebContentsView + CDP）+ Next.js 16
> 关联文档：[hippo-browser-v2.md](./hippo-browser-v2.md)（P0 骨架规约）

---

## 一、结论先行

1. **方向成立，但改判「移植」口径**。不是把 63 个 `browser.*` 复制进主进程，而是抽 **一套工具规格 + 两个 driver**（`chrome` / `hippo`），让能力差异显式化；两者由设置里**一个全局互斥开关**切换（D6），**不做单次调用路由**。
2. **Hippo 侧已是完整浏览器**（标签页 / 下载 / 书签 / 广告拦截 / 页内查找 / 提取 / 整页截图 / 打印 / 就地 AI 编辑 / 搜索 / 胶囊态），缺口集中在 **结构化自动化、数据面、监控面、脚本面、等待语义、对话栏**。工作量比「从零移植」小一个量级。
3. **ChatSidebar 不另写对话内核**，复用 `ChatNodeKernel`：以独立 WebContentsView 加载本地 Next 路由，与页面视图并排。
4. **`bob-browser-mcp` 不删除**：它服务外部 MCP 客户端（TRAE / Claude Desktop / Cursor）且不依赖 BobWork，属于独立分发物。被停用的是「BobWork 内部依赖它」这件事。
5. **不做**：扩展生态（native messaging / token / 端口抢占 / `/setup` 页）、扩展侧 ChatSidebar、录播控制台（**已结案：不做**）、扩展弹窗式登录表单。

---

## 二、现状盘点

### 2.1 Hippo Browser 已有能力（以源码为准，非文档描述）

主进程实现集中在 [hippo-browser.ts](../projects/electron/hippo-browser.ts)（约 290KB），实测能力面：

| 分类 | 已有 | 证据位置 |
|---|---|---|
| 多标签 | 每标签一个 `WebContentsView`，`spawnTab()`；new / activate / close tab | [spawnTab](../projects/electron/hippo-browser.ts#L2505-L2559) |
| 会话隔离 | 页面 `persist:hippo-browser`；工具栏 `persist:bob-toolbar` | [partition](../projects/electron/hippo-browser.ts#L2446-L2447) |
| 导航 | navigate / back / forward / reload / stop / open-link（新标签开关） | [IPC](../projects/electron/hippo-browser.ts#L1742-L1769) |
| 页内查找 | find / find-next / find-stop | [IPC](../projects/electron/hippo-browser.ts#L1747-L1769) |
| 内容能力 | `extract`（DOM→Markdown 骨架）/ `capture`（整页长截图）/ `print` | [能力层](../projects/electron/hippo-browser.ts#L554-L614) |
| 下载 | will-download 钩子 + 列表 / 取消 / 打开 / 定位 / 清空 | [下载](../projects/electron/hippo-browser.ts#L167-L235) |
| 书签 | 本地 JSON 持久化 + 增删改查 / 菜单 | [书签](../projects/electron/hippo-browser.ts#L407-L487) |
| 广告拦截 | `AD_HOSTS` + 请求拦截 + 开关 | [拦截](../projects/electron/hippo-browser.ts#L237-L339) |
| 就地 AI 编辑 | 网页点选 → AI 改写（`aiedit-go/replace/optimize/cancel`）、HTML 文件就地编辑 | [就地编辑](../projects/electron/hippo-browser.ts#L2123-L2273) |
| 搜索 | 内置 Bing 检索（免 API key），`/search` 桥端点 | [搜索](../projects/electron/hippo-browser.ts#L787-L834) |
| 其他 | cookie 清理、胶囊态最小化、置顶、工具浮层子窗口、多格式查看器（图片 / PDF） | [IPC](../projects/electron/hippo-browser.ts#L1678-L2075) |
| Agent 桥 | HTTP loopback + token，写 `.runtime/hippo-bridge.json`，端点 `/navigate` `/extract` `/capture` `/search` | [桥](../projects/electron/hippo-browser.ts#L639-L786) |
| Agent 工具 | 5 个 `hippo_browser_*`（navigate / extract / capture / screenshot / search） | [hippo-browser.ts](../projects/src/app/api/chat/tools/hippo-browser.ts#L135-L205) |

### 2.2 Hippo 缺口（相对 `browser.*`）

| 缺口 | 具体 |
|---|---|
| 结构化页面自动化 | `snapshot` / `pick_element_ref` / `click` / `type` / `fill_form` / `select_option` / `submit` / `press_key` / `hover` / `drag` / `check` / `uncheck` / `mouse_wheel` / `click_coordinates` / `scroll` / `upload_file` |
| 等待语义 | `wait` / `wait_for` / `wait_for_text` / `wait_network_idle` |
| 数据面 | `get_cookies` / `set_cookie` / `clear_cookies` / `get_storage` / `set_storage` / `clear_storage` |
| 监控面 | `network_requests` / `console_logs` / `handle_dialog` |
| 脚本面 | `run_js` / `page_script` / `resize_viewport` / `record_start` / `record_stop` / `playback` |
| 阅读导出 | `read_article` / `read_pdf` / `extract_video_text` / `export_pdf` |
| 登录辅助 | `detect_login` / `login` / `login_fill` |
| 诊断 | `diagnose` |
| 对话栏 | ChatSidebar（完全没有） |

### 2.3 bob-browser-mcp 现状

- 63 个 `browser.*`，规格集中定义在 `BROWSER_TOOL_DEFS` 单一数组，桥按工具名分发 —— **这本身就是共享规格层的天然候选**（[tools.ts](../browser-mcp/src/tools.ts#L11)）。
- 双后端 ChatSidebar（扩展侧）：BobWork `/api/chat` 沙盒问答 或 桥 `/ai/run` 完整 Agent，页面上下文经 content script 多跳汇聚（[sidebar.js](../browser-mcp/assets/extension/sidebar.js#L1234-L1450)）。
- 安全模型：Net 白名单（hybrid / page-only）+ `page_script` 静态 lint + 页内 navGuard。**全部是 host 侧纯逻辑，可直接复用**。
- 独立产物属性：`~/.bob-browser-mcp/` 自持配置、可 `--serve` 常驻、对外提供外部 MCP 客户端接入。

---

## 三、关键决策

### D1：应用内为**主通道**，真 Chrome 为**兜底通道**

| 维度 | 应用内 Hippo | 真 Chrome 通道 |
|---|---|---|
| 定制自由度 | **高一个数量级**（工具栏 / 对话栏 / 证据卡皆为自有 React 组件） | 受扩展 API / CSP / manifest 约束 |
| 与 BobWork 数据面 | **同进程**：DOM 到手即可落 materials / 进账本 / 生成证据卡 | content script → background → WS → 桥 → API，跨 4 跳 |
| 运维复杂度 | 主进程直通，无扩展 / 无 native host / 无端口抢占 | 扩展 + native messaging 注册 + 固定端口抢占 + 桥重启 |
| 站点保真 / 反爬 | 弱（Electron 指纹可识别） | **强**（日常浏览器真实环境） |
| 多标签 / 下载 / 书签 | **已有** | 白送 |
| 证据固证 | **顺**（partition / 权限 / 请求拦截 / 整页截图 / 哈希全在掌控） | 可以但绕 |
| 分发 | 随应用，零安装 | 需装扩展 + 注册宿主 |

**判据**：主场景是「可定制的工作流页面」（法律检索、证据固证、网页→材料/成果块、页面内问答批注、AI 直接改页面）→ 应用内明显更优，且是真 Chrome 结构上给不了的。

### D2：一套规格 + 两个 driver（**不复制 63 工具**）

避免双份实现与规格漂移；新工具一次实现、两处可用；能力差异通过 `supportedTools` 显式声明，模型可降级而非硬失败。

> 本条只约束**实现复用**。驱动由谁选中不由单次调用决定 —— 见 D6。

### D3：`browser-mcp` 保留为独立产物

被退役的是「BobWork 内部依赖它」。外部 MCP 客户端接入仍走它；BobWork 端内不再把它当浏览器来源。

### D4：ChatSidebar 复用 `ChatNodeKernel`

不另写对话内核。以独立 `WebContentsView` 加载本地 Next 路由，获得完整 React + 画布同源的会话内核（agent 画像 / 场景 / 工具 / 技能池全部服务端解析）。

### D5：安全边界沿用并可收紧

Net 白名单 + `page_script` 静态 lint 直接复用；导航拦截为**双层**（字面量导航由 lint 拦、动态拼出的由运行时拦），脚本内导航需对该次调用**显式**传 `allowNav=true`（默认拒）。

### D6：驱动选择是**全局互斥开关**，不是单次调用的参数

设置 → **Hippo Browser** 区块新增 **AI Browser 开关**（英文标签）：

- **开**：任务执行时的浏览器能力**只走 Hippo**；Bob Browser（扩展 / 真 Chrome）通道对模型不可见。
- **关**：只走 Bob Browser 通道；内置 `browser_*` 对模型不可见。
- 二者互斥：**不做 `auto` 判据、不做 per-call `target` 参数** —— 从根上消除「在错误浏览器里执行」的歧义。

**落地位置**

- UI：`Settings → Hippo Browser` 区块，沿用现有「设置行分组容器 + 左标签 / 右控件」行样式（[SettingsModal.tsx](../projects/src/components/canvas/SettingsModal.tsx#L2742-L2787)）。
- 字段：可选对象字段，与 `screenOcr` 同风格（[settings.ts](../projects/src/lib/settings.ts#L313-L320)），例如

```ts
/** AI 浏览器通道：互斥单选。
 *  aiBrowser='hippo'  → 任务执行只走 Hippo，Bob Browser 通道不注入
 *  aiBrowser='chrome' → 任务执行只走 Bob Browser（扩展 / 真 Chrome）
 *  undefined = 'hippo'（默认通道；仅显式写入 'chrome' 才回退 Bob Browser） */
aiBrowser?: 'hippo' | 'chrome';
```

> 渲染为开关（开 = `hippo`）比分段控件更贴合「一个 AI 开关」的直觉；若后续需要更多通道，再升级为单选控件。

**受影响面**

| 面 | 开关开（hippo） | 开关关（chrome） |
|---|---|---|
| 工具注入 | 内置 `browser_*`（HippoDriver） | `mcp__bob-browser-mcp__browser_*` |
| 反向工具可见性 | MCP 浏览器工具**不注入** | 内置 `browser_*` **不注入** |
| 不支持能力 | B / C 档工具**整组不注入**（模型看不到，连「试一下」的机会都没有）：`login` 三件套、`research` / `note`、录播三件套、`diagnose`、`status` / `connect` / `disconnect` / `launch_browser`、`extract_video_text`。措辞按「**通道分工**」如实说明（该能力由 Bob Browser 通道提供），不写成「暂不支持」，也不引导用户为单个能力去切开关；详见第九节 P3 | — |
| ChatSidebar | 存在（Hippo 是它的宿主） | 不出现 |
| 人工兜底 | Hippo 窗口内仍可「在真 Chrome 打开当前页」（**给人用，不给模型用**） | 不适用 |

**关键约束**：工具面在**会话建立时**按开关裁剪，而不是执行时再拦；开关变更后，进行中的会话必须**重建工具面**（详见第十二节）。

---

## 四、目标架构

```
┌ 规格层  @bob/browser-tools ──────────────────────────────────────┐
│  BROWSER_TOOL_DEFS（name / schema / returns / envelope）         │
│  Net 白名单 · page_script 静态 lint · 错误 phase 枚举             │
└───────────────┬───────────────────────────┬─────────────────────┘
                │                           │
   ┌ 驱动层 ─────▼──────────┐   ┌────────────▼─────────────────────┐
   │ ChromeDriver           │   │ HippoDriver                      │
   │ 扩展桥 + chrome.debugger│   │ 主进程 webContents.debugger (CDP) │
   └────────────┬───────────┘   └────────────┬─────────────────────┘
                │                            │
   ┌ 宿主层 ─────▼──────────┐   ┌────────────▼─────────────────────┐
   │ 真 Chrome（外部客户端） │   │ Hippo Browser 窗口                │
   │                        │   │  工具栏层 + 标签页 View(s)        │
   │                        │   │  + ChatSidebar View（新）         │
   └────────────────────────┘   └────────────┬─────────────────────┘
                                             │ 同进程
                                  ┌──────────▼─────────────────────┐
                                  │ /api/chat · 账本 · materials    │
                                  └────────────────────────────────┘
```

**四层职责**

| 层 | 内容 | 变更性质 |
|---|---|---|
| 规格层 | 工具定义、参数 schema、统一返回 envelope、Net/lint 策略 | **新建**（从 browser-mcp 抽出） |
| 驱动层 | `BrowserDriver` 接口 + 两实现 | **新建**（ChromeDriver 包现状；HippoDriver 新增） |
| 宿主层 | Hippo 窗口（已有）+ ChatSidebar View（新） | 增量 |
| 数据面 | `/api/chat`、账本、materials、证据管线 | 复用 |

**工具命名策略**：内置工具统一为 `browser_*`（不带 `mcp__` 前缀）；MCP 注入的仍是 `mcp__bob-browser-mcp__browser_*`。**同一时刻只注入其中一组**，由 `aiBrowser` 开关决定（开 → 内置组；关 → MCP 组），从根本上避免两套同名工具同时进上下文。

---

## 五、能力平移清单（63 → 三档）

### A 档：直接平移（CDP / 原生 API 等价）

| 组 | 工具 | HippoDriver 实现要点 |
|---|---|---|
| 导航（4） | `navigate` `back` `forward` `reload` | 已有原生 API，直接映射 |
| 等待（4） | `wait` `wait_for` `wait_for_text` `wait_network_idle` | `readyState` + 核心容器文本 + CDP `Network` 在途请求计数 |
| 元素交互（16） | `snapshot` `pick_element_ref` `click` `type` `fill_form` `select_option` `submit` `press_key` `hover` `drag` `check` `uncheck` `mouse_wheel` `click_coordinates` `scroll` `upload_file` | `Input.dispatchMouseEvent` / `dispatchKeyEvent`；受控组件用 native setter（复用 `bb.fill` 语义）；`snapshot` 自建 ref→selector 映射表 |
| 内容提取（3） | `extract_text` `get_html` `get_viewport` | `Runtime.evaluate` / `executeJavaScript`（`extract` 已有） |
| 截图导出（2） | `screenshot` `export_pdf` | `capturePage` / CDP 整页截图（已有）/ `printToPDF` |
| 标签页（5） | `list_tabs` `switch_tab` `open_tab` `close_tab` `active_tab` | **已有** new / activate / close，映射即可 |
| 数据（6） | `get_cookies` `set_cookie` `clear_cookies` `get_storage` `set_storage` `clear_storage` | `session.cookies` + `Runtime.evaluate`（已有 `clear-cookies`） |
| 监控（3） | `network_requests` `console_logs` `handle_dialog` | CDP `Network.*` / `Runtime.consoleAPICalled` 事件缓存；`Page.javascriptDialogOpening` + `handleJavaScriptDialog` |
| 脚本（3） | `run_js` `page_script` `resize_viewport` | `page_script` 的 `bb` 运行时是**纯页内 JS**，零改造复用 |
| 阅读（4） | `read_article` `read_pdf` `extract_video_text` `export_pdf` | `read_article` 可平移；`read_pdf` 复用已有 PDF 查看器 / pdfjs；`extract_video_text` 需带 ffmpeg + 字幕模块（打包体积待评） |

> 小计：**50 个**属于 A 档。

### B 档：换实现 / 语义重定义

| 工具 | 处置 |
|---|---|
| `status` `connect` `disconnect` | 语义重定义为「Hippo 会话可用性 / 附加当前活动标签」 |
| `launch_browser` | 重定义为「打开 / 显示 Hippo 窗口」 |
| `search` | **已有**（Bing），保留 |
| `research` | 改接 BobWork 自身模型（不再走桥 `/ai/run` + `models.json`） |
| `note` | 改接 materials / 项目账本（不再走桥内内存存储） |
| `detect_login` `login` `login_fill` | 无扩展弹窗表单；降级为「页内表单识别 + 提示用户在窗口内接管」，`login/login_fill` 收敛为 `fill_form` 封装 |
| `diagnose` | 改为主进程自检 + CDP 能力探测 |
| `record_start` `record_stop` `playback` | 需自建（CDP `Input` 录制/回放），**已结案：不做**（随 P3 一并否决 —— 价值前提是「扩展侧的常驻录制宿主」，Hippo 通道不注入这组工具） |

> 小计：**12 个**属于 B 档。

### C 档：废弃 / 不再随 BobWork 分发

- 扩展生态：native messaging 宿主、扩展绑定 / token 流程、桥 `/setup` 页、扩展 zip 分发路由（[browser-extension-zip](../projects/src/app/api/wanted/browser-extension-zip/route.ts) / [browser-bridge-token](../projects/src/app/api/wanted/browser-bridge-token/route.ts)）。
- 扩展侧 ChatSidebar（被 Hippo ChatSidebar 取代；扩展侧保留给外部客户端）。
- `launch_browser` / `connect` 的「真 Chrome」语义（保留在独立产物内）。

> 小计：**1 个工具的语义 + 一整套扩展装配链路**。

---

## 六、共享规格层设计

### 6.1 位置与形态

抽为 `projects/src/lib/browser-tools/`（Next 侧可直接引用），`browser-mcp` 以 git submodule / 复制同步方式引用同一份定义（若不便共享，退化为「以 BobWork 侧为准 + 版本号对齐」的弱同步，并加规格一致性单测）。

### 6.2 统一返回 envelope

沿用 `page_script` 现有 envelope 并推广到**全部**工具：

```ts
interface Envelope {
  ok: boolean;
  value?: unknown;
  error?: { phase: ErrorPhase; message: string };
  warnings?: string[];
  steps?: Array<{ op: string; ms: number }>;
  stats?: { ops: number; elapsedMs: number; urlEnd?: string };
}

type ErrorPhase =
  | 'syntax' | 'script' | 'timeout' | 'op-limit' | 'nav-denied'
  | 'wait-timeout' | 'inject' | 'driver' | 'unsupported';
```

新增 `driver`（驱动内部异常）与 `unsupported`（该 driver 不支持此工具），供模型据此降级。

### 6.3 Driver 接口

```ts
interface BrowserDriver {
  readonly id: 'chrome' | 'hippo';
  readonly supportedTools: ReadonlySet<string>;
  status(): Promise<DriverStatus>;
  exec(name: string, args: Record<string, unknown>, ctx: DriverCtx): Promise<Envelope>;
}
```

### 6.4 驱动解析（由全局开关决定，无 per-call 参数）

- 读取 Settings 的 `aiBrowser` 开关：`hippo` / 缺省（undefined）→ HippoDriver；显式 `chrome` → ChromeDriver。**一次解析、整轮生效**。
- 工具面在**会话建立时**按开关裁剪（不注入未选中的通道），而非执行时再拦。
- 选中的 driver 不支持该工具 → 返回 `phase='unsupported'` 并附 `hint`（如「该能力仅 Bob Browser 通道支持，请关闭 Hippo AI 开关」），**不静默回退到另一通道**（避免在错误的浏览器里执行破坏性动作）。
- 开关变更后，进行中的会话需显式重建工具面（见第十二节）。

### 6.5 安全策略复用

`Net` 白名单模式与 `page_script` 静态 lint 从 [page-script-policy.ts](../browser-mcp/src/page-script-policy.ts) / [net.ts](../browser-mcp/src/net.ts) 平移至规格层，两个 driver 共用；导航拦截为**双层**（静态 lint 拦字面量、运行时拦动态拼出的 URL），脚本内导航需对该次调用显式传 `allowNav=true`。

---

## 七、HippoDriver 实现要点

1. **CDP 会话**：`webContents.debugger.attach('1.3')` 一次并常驻，按需 `Page.enable` / `DOM.enable` / `Runtime.enable` / `Network.enable`；窗口关闭或标签销毁时 `detach`。整页截图沿用现有「临时 attach → `Page.captureScreenshot` → detach」范式（[hippo-browser-v2.md](./hippo-browser-v2.md#L84-L88)）。
2. **多标签**：已是「每标签一个 View」结构，driver 需维护 `tabId → WebContents` 映射与活动标签指针；CDP 会话按标签独立 attach。
3. **元素 ref**：`snapshot` 生成可交互元素清单 + 稳定 ref；`pick_element_ref` 复用现有就地编辑的点选 overlay（[就地编辑](../projects/electron/hippo-browser.ts#L2123-L2273)）。
4. **等待语义**：`Network.requestWillBeSent` / `loadingFinished` 计数实现 `wait_network_idle`；核心容器文本轮询沿用 `extract` 的智能等待策略。
5. **监控缓存**：主进程内环形缓冲（网络 / console），限制条数，随标签销毁清理。
6. **桥扩展**：现有 `hippo-bridge.json` HTTP 桥新增通用 `POST /exec { name, args }`，保留 `/navigate` `/extract` `/capture` `/search` 兼容旧工具调用。
7. **Agent 工具面**：`tools/` 下 `browser.ts` 以规格层 + driver 路由注册 `browser_*`，`hippo-browser.ts` 的 5 个工具在过渡期作为别名保留，稳定后删除。

---

## 八、ChatSidebar 设计

### 8.1 形态

- **位置**：Hippo Browser 窗口内右侧面板，与页面 View 并排；宽度可拖拽，可折叠（记忆到 localStorage）；默认宽度建议 360–420。
- **实现**：新增一个 `WebContentsView`（`partition: 'persist:bob-browser-chat'`），加载本地 Next 路由 `/browser-chat`。
- **理由**：直接获得完整 React 运行时与 `ChatNodeKernel`，无需第二套对话内核；`partition` 隔离可避免与页面会话互相污染。
- **备选（不选）**：嵌进主窗口画布 —— 与「单焦点会话 + 世界层绝对定位」模型冲突，且窗口切换体感断裂。

### 8.2 会话模型

- 每个浏览器窗口一条独立会话（有独立 `sessionId` 与落盘位置），与画布节点会话同构但互不干扰。
- 提供「投送到画布」动作：把当前对话沉淀为画布节点，便于继续在工作流中使用。

### 8.3 上下文协议（ContextEnvelope）

```ts
interface ContextEnvelope {
  url: string;
  title: string;
  selection?: string;            // 当前选区
  extractedMarkdown?: string;    // 按需提取（默认不提取，省 token）
  screenshotRef?: string;        // 按需截图（落盘路径，非 base64 直塞）
  tabs: Array<{ id: number; url: string; title: string; active: boolean }>;
  meta: { viewport: { w: number; h: number }; ready: boolean };
}
```

- **注入方式**：作为本轮 user 消息的前缀（**不进 system**），遵守前缀缓存红线。
- 选区引用与截图**不自动进入 materials**（符合既有约定）；由用户显式触发「沉淀为材料 / 成果块」。

### 8.4 工具可见性

- ChatSidebar 仅在 **AI Browser 开关开启（`aiBrowser='hippo'`）**时存在 —— Hippo 是它的宿主，开关关闭时不出现。
- 默认挂 `browser` 场景（含 HippoDriver 工具）+ 有激活项目时的只读 `ledger`。
- 文件 / 命令类工具**默认不挂**，需用户显式解锁（避免在浏览页面时误动本地文件）。
- 重活（全量场景）解锁后与画布会话一致。

### 8.5 与既有能力的关系

- **就地 AI 编辑**（`aiedit-*`）与 ChatSidebar 共用同一套 CDP / 注入能力，前者是「点选即改」，后者是「对话驱动」，不重复实现。
- **扩展侧 ChatSidebar**：BobWork 端内不再依赖；扩展侧保留给外部 MCP 客户端。

---

## 九、分期路线与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | 规格层骨架 + `BrowserDriver` 接口 + HippoDriver（CDP 会话 / 标签映射 / 元素 ref / 输入原语）+ 10 个核心工具（`navigate` `snapshot` `click` `type` `fill_form` `press_key` `scroll` `extract_text` `screenshot` `run_js`）+ `/exec` 桥端点 + **AI Browser 开关（设置项 + 会话级工具面裁剪）** | 开关开（含缺省）→ Agent 在 Hippo 内完成「打开页面 → 快照 → 点击 → 填表 → 返回结果」闭环；开关显式关 → 行为与 Bob Browser 现状一致 |
| **P1** | 补齐 A 档剩余工具（等待 / 监控 / 数据 / `page_script` / `export_pdf` / `read_pdf`）+ Net 白名单与 lint 复用 + 标签工具映射 | 63 工具中 A 档 50 个可用；`page_script` lint 拒绝非法导航 |
| **P2** | ChatSidebar（`/browser-chat` 路由 + 并排布局 + `ContextEnvelope` 注入 + 场景收窄 + 投送画布） | 边看边问可用；上下文注入不破坏前缀缓存；重活需显式解锁 |
| **P2.5** | `page_script` 与规格对齐：① `bb.goto` 在 `allowNav=true` 时**可用**（此前被 `netMode='page'` 一票否决，`allowNav` 是死参数）、且**终止脚本**、导航改由**宿主执行**并返回 `{ navigated, url, title }`（页内自跳会销毁执行上下文、连结果一起丢）；② 工具描述与通道规则补「**脚本优先**：只要字段就用 `page_script`，别用 `extract_text` 整页读」与「**跨页姿势**：切页 → 新页面重下发脚本」 | 脚本内导航可用且不丢结果；模型收到的信号是「脚本抽取」而非「整页阅读」 |
| **P2.6** | `bb` 运行时补全（对齐 code-based 范式）：此前脚本只有 `sleep / waitFor / goto`，**只能读和等**，每次点击/填表都要退回工具层再往返一轮。现补齐 `bb.$(refOrSelector)` / `bb.ref(ref)`（直接吃 snapshot 写进 DOM 的 `data-hippo-ref`，脚本可复用快照 ref）、`bb.fill`（与工具层 `fillScript` 同一套原生 setter 语义）、`bb.click` / `bb.press` / `bb.scroll`、`bb.text`、`bb.snapshot`（与 `browser_snapshot` **共用同一份实现**，ref 编号规则一致）、`bb.waitFor` / `bb.waitText`；并给返回值加字符预算（超限转为 `{__truncated, chars, cap, head}` + warning，而不是让外层把 JSON 拦腰切断）。另外把「脚本点到链接导致跳转」从无信息报错识别为 `{ navigated, url, title }` | 同一页面的多步交互可**一个脚本跑完**，不再 N 次往返；返回超预算时模型能读出「该收窄返回值」而不是拿到半截 JSON |
| **P2.7**（本轮） | 脚本的**静默失败**与**失败可续跑**：① **序列化归一化** —— DOM 节点 `JSON.stringify` 只会得到 `{}`（节点无自有可枚举属性），`NodeList` / `Map` / `Set` / `Error` / 循环引用 / 超深结构此前同样变成空对象或乱码；现统一归一化成可读形态（元素 → `{ ref, tag, id, text, href, value, src, aria, disabled… }`，硬上限：深度 5 / 数组 100 / 对象 60 键 / 字符串 2000 字符）；② **假成功前置拦截** —— `bb.fill` 拦 `readonly` / `disabled`（原生 setter 会绕过二者，写完页面不认），`bb.click` 拦 `disabled` / 零尺寸 / `pointer-events:none`（合成事件会「成功但无效果」，且指明应改点外层或退回 `browser_click`）；③ **操作轨迹** —— 每个写操作登记 `__note`，脚本失败时**不再抛错**而是返回 `{ kind:'error', message, steps }`，宿主把轨迹写进 `warnings` 并给出「上述操作已生效，只补跑剩余步骤」的 hint；④ **纪律同步** —— 上述契约写进通道规则（`BROWSER_RULES_HIPPO`：返回值可直接给元素/集合/Map，宿主会归一化；helper 失败是返回 `{ok:false}` 而非抛错，必须判 `ok`；报 `phase=script` 时按轨迹从断点续跑，不重跑整个脚本） | 脚本返回值永远可读（不再出现 `{}`）；假成功变成显式失败并给出替代路径；失败时模型知道「已经做成了什么」，能**续跑**而非重跑 |
| **P3**（已决定不做） | B 档改造（`research` / `note` / `diagnose` / `detect_login` 降级 / `status`·`connect`·`disconnect`·`launch_browser`）—— **不做**。判据：B 档的共同前提是「扩展 / 桥的运行时」（桥 `/ai/run` 推理宿主、桥内内存存储、扩展弹窗表单、「真 Chrome 连接」概念），这些在 Hippo 里要么不存在，要么已被 ChatSidebar 取代：`research` 退化成连调几次 A 档工具（模型自己就是推理宿主）、`note` 由项目账本 / 解锁后的 `write_file` 承担；`launch_browser` 是结构性不可能（`bridgeStart()` 就在 Hippo 窗口创建函数体内，桥随窗口生死 —— 能调它说明窗口已开，需要调它说明桥不通）；登录三件套在可见窗口里无存在理由（用户直接登即可）；录播三件套方案本身即建议搁置 | 无需验收：B 档整组不注入，能力边界按「通道分工」如实说明 |
| **P4** | 停用路径（见第十一节）+ 文档与引导改写 | 端内不再出现「安装浏览器扩展」引导 |

---

## 十、AI 驱动可见性（已落地）

**问题**：Hippo 通道下，AI 在窗口内执行任务时，**工具面、页面、窗口壳三层都没有「AI 在场」的信号** —— 用户看着页面自己滚动、自己填写，却不知道是 AI 在做、做到哪一步、点的是哪一个元素。这与「AI 操作你自己的浏览器」的产品预期不符：**可控的前提是可见**。

**定案**：只加**展示层**，不动工具语义。两条判据：① 不改变模型可调用的能力 —— 不入 `tools` 段、不改 system、不改返回 envelope、不新增工具名，因此前缀缓存与 CacheGuard 指纹不受影响；② 不给主链路引入新失败面 —— 页内脚本失败静默、UI 仅订阅主进程状态。

### 10.1 窗口壳：工具栏 AI 徽标

| 项 | 实现 |
|---|---|
| 状态源 | 主进程 `hippo-browser.ts`：`aiBusy` **计数制** —— 进入 `/exec` 处理（`aiToolBegin`）递增，返回（`aiToolEnd`，`try/finally` 包裹）递减；**全部在途调用结束**后再静默 `AI_IDLE_MS = 1500ms` 才熄灭 |
| 为何计数而非「调用即置真」 | 长耗时工具（`wait_for` / 整页截图）在途期间徽标不能中途熄灭；连续调用之间也不能闪断 |
| 通道 | 单向推送 `hippo-browser:ai-driving`（`{ active, tool }`），preload 暴露 `hippoBrowser.onAiDriving`；内容未变化不发 IPC（与 `state` / `tabs` / `downloads` 同款去抖） |
| UI | 工具栏地址栏右侧紫色 `AI` 胶囊 + 呼吸圆点；缺省 `display:none`（零布局影响），悬停显示当前工具名；`-webkit-app-region:no-drag` |

**挂钩点收敛**：整条通道只有 `/exec` 处理器一处埋点，日后新增工具无需各自埋点。

### 10.2 页面：目标元素瞬时描边

`hippo-cdp.ts` 的 `flashScript(resolver)`：在目标元素上画 2px 紫色框（`#6b5cf0` + 12% 底色），**先 `scrollIntoView` 再量取**（与 `centerScript` / `fillScript` 同姿势），保证框与紧随其后的真实操作落在同一元素上；0.42s 淡出、0.88s 移除；`pointer-events:none` 不拦截点击。

| 项 | 定案 |
|---|---|
| 触发面 | 只列**元素定向的写操作**（`FLASH_TOOLS` = `browser_click` / `browser_hover` / `browser_type` / `browser_check` / `browser_uncheck`），外加 `browser_fill_form` **逐字段**各描一次 |
| 不描边的 | 无目标元素的调用：`navigate` / `wait_for` / `snapshot` / `extract_text` / `screenshot` / `page_script` / `run_js` —— 描边回答「AI 在动哪个元素」，「AI 在工作」由工具栏徽标回答 |
| 失败处理 | 全部 `catch` 静默：描边是锦上添花，任何异常不得影响真实操作 |
| 挂钩点 | 收敛在 `execBrowserTool` 入口一处（`FLASH_TOOLS` 判定 + `resolverExpr(args)` 是否存在），各 case 体未改动 |

### 10.3 与既有高亮的关系（三者语义不重叠）

| 高亮 | 触发者 | 外观 | 归属 |
|---|---|---|---|
| **目标描边** | **AI** 写操作 | 紫色实线 2px，~0.9s 自动消失 | 本节（新增） |
| **点选悬浮框** | **人工**鼠标 | 红色实线 2px，跟随鼠标 | `browser_pick_element_ref`（人工点选） |
| **检选高亮** | 就地 AI 编辑 | 悬浮紫虚线 / 选中红实线 | `aiedit` 窗口的元素级编辑 |

判读规则：**紫 = AI 正在操作，红 = 人在指定元素。**

### 10.4 明确不做

- **不做「暂停 / 接管」按钮**：可见性不等于可控性；窗口本来就归用户（用户可随时直接在页面上操作，Hippo 不做输入互斥）。
- **不做逐步动作日志面板**：动作轨迹已在工具返回值里（`warnings` / `steps`），另有 ChatSidebar 承接「边看边问」，再开一个日志面板属重复。
- **不做系统通知**：窗口可见、徽标就在工具栏，通知属打扰。

---

## 十一、通道定位与停用路径（Hippo 为默认通道，Bob Browser 互补）

**定位（定案）**：**不追求「Hippo 替代 Bob Browser」。** 两者优势不在同一维度 —— Hippo 的优势是**自带宿主**（免装扩展、同进程、对话栏内嵌、规格层共用），Bob Browser 的优势是**操作用户真实 Chrome**（登录态 / 书签 / 密码管理器 / 扩展全在）。要让 Hippo 承担日常浏览，缺的不是 B 档工具，而是**浏览身份**（Electron 无法直接复用 Chrome profile），那是一次浏览器数据迁移工程：成本远超收益，且做完就失去了「轻」。

所以定案为：**Hippo = AI 操作浏览器的默认通道；Bob Browser = 需要真实 Chrome 身份时的通道。AI Browser 开关是持久选择，不是迁移过渡态。** `bob-browser-mcp` 保留为独立外部产物，恰好覆盖身份缺口 —— 两者互补，而非新旧替换。

| 阶段 | 动作 | 破坏面 |
|---|---|---|
| 默认 Hippo（**已落地**） | **AI Browser 开关默认翻转：`undefined` ≡ 开（走 Hippo）**；存量用户在设置里显式关过开关的保持 `aiBrowser='chrome'`（尊重其显式选择，不强行改写），新用户 / 未配置者默认走 Hippo。需要真 Chrome 时由用户手动关开关。**`bob-browser-mcp` 默认不安装**（不在 `SYSTEM_MCP_IDS`，仅 Store 手动安装可用）——不需安装浏览器扩展即可完成日常浏览任务；已装过的用户如需回收，自行从 Store 卸载 | 工具面说明与引导文案需更新 |
| 内置桥下线 | BobWork 不再把扩展桥当作**端内默认依赖**；MCP Store 的 Bob Browser 条目改为「外部客户端用」 | [registry.json](../projects/assets/mcp/registry.json#L60)、[admin.ts](../projects/src/app/api/chat/tools/admin.ts#L134)、[系统提示词.md](../系统提示词.md#L227) |
| 引导改写（**不是**停用扩展） | 扩展**保持可安装可用**（互补的那一半），只把「请安装浏览器扩展」从默认引导改为可选路径；设置项副标题讲清「Hippo 免装扩展 / Bob Browser 操作用户真实 Chrome」 | 两个 API 路由（`browser-extension-zip` / `browser-bridge-token`）**保留**、[McpStorePanel](../projects/src/components/canvas/McpStorePanel.tsx#L409-L453) 文案 |
| 独立产物 | `browser-mcp` 转纯 GitCode 分发，文档明确「供外部 MCP 客户端」—— 不只是退役遗留，而是**互补的另一半** | 无端内影响 |

**兜底入口保留**：Hippo 内保留「在真 Chrome 打开当前页」，用于反爬 / 登录态场景，避免能力断崖。

---

## 十二、风险与边界

1. **Electron 指纹识别**：部分站点对 Electron UA / 指纹降级或拦截。对策：保留「在真 Chrome 打开」兜底；指纹伪装需谨慎（合规与稳定性风险）。
2. **Chromium 版本绑定**：Hippo 内置 Chromium 版本与用户 Chrome 可能不一致，新站点特性可能缺失。需在方案中记录最低 Electron 版本要求。
3. **CDP 域支持差异**：Electron 的 `webContents.debugger` 在部分 CDP 域（如多 target 管理）能力受限，需在 P0 做能力探测并写入 `supportedTools`。
4. **安全面扩大**：把 `Input` / `Runtime` / `Network` 全 CDP + `run_js` 暴露在应用内 View，远超现有只读提取。对策：Net 白名单 + `page_script` 静态 lint + 运行时 `bb.goto` 兜底（**双层**：字面量导航由 lint 拦、动态拼出的由运行时拦），脚本内导航需对该次调用显式传 `allowNav=true`（默认仍拒）；**现有「工具调用无确认弹窗」的模型在应用内需要重新评估**（涉及本地文件上传 `upload_file` 等）。
5. **多标签内存与生命周期**：每标签一个 View，长期开启内存增长；需标签上限与后台回收策略。
6. **原「双 driver 心智负担」已被 D6 消解**（无 `auto` 判据、无 per-call 参数）。残余风险转为两点：
   - **能力差异（已由定位消化，不再是「断崖」）**：开关开启时 B / C 档工具（`login` 三件套、录播等）不可用。定位上已明确这是「两通道分工」而非「Hippo 还没做完」，所以对策是把差异**讲清**而不是补偿：设置项副标题明示取舍、通道规则里如实说明「该能力由 Bob Browser 通道提供」，**不引导用户为单个能力去切开关**。也不再依赖 `unsupported` 提示兜底 —— B 档整组不注入，模型根本看不到那些工具名。
   - **开关切换的一致性**：切换后进行中的会话若未重建工具面，会出现「工具面与实际 driver 不一致」。对策：切换时强制重建工具面并提示。
7. **本地依赖体积**：`read_pdf` / `extract_video_text` 依赖 pdfjs / ffmpeg，需评估打包体积与按需加载。
8. **ChatSidebar 与画布口径一致性**：成果块 / 账本写入规则需与画布会话完全一致，否则出现两套事实来源。

---

## 十三、Spaces（agent 独立工作区）可行性评估

背景：ego-lite 的核心卖点之一是 **Spaces** —— 人在前台浏览、agent 在后台 Space 里跑自动化，互不干扰、可并行。本节只做可行性判定，**已决策不做**（见文末结论）。

**先校准 Space 的语义**：它是**同一浏览器 profile 下的独立工作区**（独立标签组 / 窗口），**共享登录态**。不是独立 profile —— 否则「一键继承 Chrome 数据、免登录」这条价值就不成立了。

| Space 的组成 | Electron 对应物 | 现状 | 判定 |
|---|---|---|---|
| 独立工作区（不抢用户的标签） | 独立 `WebContentsView` + 标签 owner 标记 | [hippo-browser.ts](../projects/electron/hippo-browser.ts#L42) 的 `tabs` + 全局 `activeTabId`，**无 owner 概念**；工具栏渲染全部标签 | 需新增 owner（`'human' \| 'space:<id>'`），工具栏只渲染 human 的；`spawnTab()` 需带归属参数 |
| 共享登录态 | **同一个 partition**（`persist:hippo-browser`） | 已满足 | **关键判据：不能给 Space 单独 partition。** Electron 的 partition 是「存储隔离」单位 —— 独立 partition = 独立 cookie = agent 要在 Space 里重新登录，正好废掉 Space 的意义。所以 Space = **同 partition + 独立标签组**，与人共享一份登录态 |
| 并行不抢鼠标 | CDP `Input.dispatchMouseEvent` 本身就定向到某个 `webContents` | 已满足 | **比 ego-lite 更省事**：Electron 里 agent 的点击/输入不经系统鼠标，天然不会抢 |
| 后台 view 的渲染与节流 | 未挂进 `contentView` 树的 view 仍会执行 JS | **待验证** | 需 `setBackgroundThrottling(false)` 关闭后台节流（`rAF`/定时器）；代价是每个 Space 一个渲染进程，约 100–300MB |
| 驱动指向 | 会话绑定的标签，而非「当前激活标签」 | [ExecHost.activeWebContents()](../projects/electron/hippo-cdp.ts#L23-L24) 返回**全局**活动标签 | **这是真正的工作量**：驱动语义要从「全局当前标签」改为「会话绑定标签」。好在接口很窄（`ExecHost` 8 个方法），且 `webContentsOfTab(id)` 已存在，改造有明确落脚点 |

**代价排序（从小到大）**：① Space 生命周期（创建 / 回收 / 上限）与内存；② 标签 owner 化 + 工具栏过滤；③ 后台 view 的节流与可见性；④ **驱动层语义变更**（`ExecHost` 从「当前标签」→「会话绑定标签」，且 ChatSidebar 要能指定 Space）。

**与 ChatSidebar 的分工**：ChatSidebar 解决「**边看边问**」（同一标签内并排问答），Space 解决「**边看边跑**」（agent 在别的标签里干活）。两者不冲突，但 Space 会引出第二个出口问题：**agent 的标签要不要展示给人、在哪展示** —— 这个产品决策得先有答案。

**结论**：技术上**没有结构性障碍**（共享 partition 即继承登录态；鼠标本就不会被抢），但代价集中在**驱动层语义变更与标签归属模型**，属窗口模型级改动。

**决策（已定）：不做。** 用户裁定**接受「agent 直接接管当前活动标签」**这一语义 —— 即 `browser_navigate`（`newTab=false` 默认）覆盖当前页、`browser_switch_tab` 切走视图、`browser_close_tab`（不传 id）关掉当前标签，均视为**预期行为而非缺陷**。故不引入 Space / owner 模型 / 会话绑定标签，现状即终态。

**若日后改判**（需要「人在前台浏览、agent 在后台跑」的并行）：接缝已勘察完毕，且**接口签名零改动**即可会话化 ——

- `ExecHost` **8 个方法全部**隐式绑全局活动标签（`execBrowserTool` 入口取一次 `wc`，navigate / bb.goto / switch_tab / open_tab / close_tab 共 5 处**重取** `activeWebContents()`；宿主侧 `capture` / `extractContent` 走 `requireView()` 也绑全局）。
- 做法：把 execHost 从**单例常量**改为**按会话惰性创建的工厂** `makeExecHost(sessionId)`，方法内部闭合到该会话自己的标签组与 cursor；全局 `activeTabId` / `view` 保持「人」的语义不动。`capture(wc, opts)` / `extractContent(wc)` 需接受目标 wc（不再走 `requireView()`）。
- 会话标识传递链落脚点已确认：`ToolExecContext += sessionId` → `browserToolDefs.execute(args, ctx)`（现传 `{}`）→ `HippoDriver.exec(name, args, ctx)`（现为未用的 `_ctx`）→ `POST /exec { name, args, session }`（桥现只读 name/args）→ `makeExecHost(session)`。
- **首个前置 spike**：后台标签的 `backgroundThrottling`（非激活标签已被 `removeChildView` 移出树，但 title/favicon 事件仍在更新 ⇒ webContents 存活并跑页内 JS；`rAF`/定时器是否被压制未验证）与内存实测（每标签一个渲染进程，约 100–300MB）。
- 这是比「独立 Space」更轻的 **S1（不含 owner 模型与展示 UI）**，已能解决「抢视图 / 覆盖当前页 / 误关人的标签」三个真问题。

---

## 十四、待确认项

1. **多标签驱动细节**：driver 是按标签独立 CDP attach，还是复用一个 attach + `Target` 切换？（需 P0 能力探测后定）
2. **工具命名收敛**：`hippo_browser_*` 别名保留多久？（建议 P2 后删除）
3. ~~ChatSidebar 落盘位置~~ **（已定）**：复用画布节点存储（`/api/nodes`、`node_type='browser'`）；画布侧按 `node_type` 过滤不渲染，投送时才落成画布 chat 节点。
4. ~~录播（`record_start/stop/playback`）~~ **（已结案：不做）**：随 P3 一并否决 —— 其价值前提是「扩展侧的常驻录制宿主」，Hippo 通道不注入这组工具。
5. **`bob-browser-mcp` 独立产物的长期维护责任**：是否持续与端内规格对齐，还是分叉维护？
6. **开关作用域**：全局（Settings 顶层）还是项目级？（D6 暂定全局；若某项目需固定通道再议）
7. ~~开关默认值~~ **（已定：翻转为 `hippo`）**：`undefined ≡ 'hippo'`（默认通道），仅**显式写入** `'chrome'` 才回退 Bob Browser —— 存量用户在设置里显式关过开关的保持其选择，新用户 / 未配置者默认走 Hippo。连带定案：`bob-browser-mcp` **默认不安装**（不在 `SYSTEM_MCP_IDS`，仅 Store 手动添加），已安装过的用户如需回收**自行卸载**，端内不做自动卸载 / 迁移清理。
8. **开关关闭时的保底行为**：MCP 未连接 / 扩展未安装时，是硬报错，还是一次性降级到 Hippo？
9. **人工兜底入口去留**：Hippo 内「在真 Chrome 打开」保留（仅给人用，模型不可见）—— 确认。
10. **开关标签文案**：`AI Browser` 还是 `Use Hippo for AI tasks`？