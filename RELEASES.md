# BobWork 版本发布记录

> 每次构建前请先在此文档记录变更，并确认版本号未与已发布版本重复。
> 构建命令：`SKIP_DMG=1 pnpm package:release`（仅生成 ARM / Apple Silicon 架构）
> 发布产物：仅 ZIP + latest-mac.yml（自动更新源），不再生成/上传 DMG（2026-09-01 起）；DMG 仅在明确要求时提供。
> 产物自动上传到 GitCode Release（国内 CDN），需设置 GITCODE\_TOKEN。

> 📌 发布规则（2026-08 起）：仅生成 ARM（Apple Silicon）架构安装包，不再发布 x64。
> 打包脚本已固定为 arm64，传入 both / x64 参数会自动忽略并按 arm64 构建。

> 📌 版本线切换（2026-08-15）：版本号重新设计，从 **0.5.13** 起算，此后常规递增（0.5.13 → 0.5.14 → …）。
> 旧 1.x 系列发布记录已清理，不再保留。注意：0.x < 1.3.x，已安装旧版本的用户将收不到自动更新（视为降级），此为有意的产品线重开。


***


## v0.7.622 (2026-09-23)

### 新增
- **网页内划词浮层（Copy / Ask Bob / Page text）**（改 `electron/hippo-browser.ts` / `electron/preload.ts` /
  `src/components/hippo-browser/BrowserChatPanel.tsx`）：Hippo 打开的第三方文档与面板页面不同源，React 渲染不进去，
  故改为向网页注入 DOM 浮层。两处刻意写法：
  - 样式全走 CSSOM 赋值（`el.style.cssText`），不用 `<style>`、不用 style 属性，以躲开站点 CSP 的 inline style 限制；
  - 回传走 `window.open` 哨兵地址 `https://bob-hippo-sel.invalid/`（`.invalid` 是保留域名，永不解析），
    由主进程 `setWindowOpenHandler` 前置拦截消费并 `{ action: 'deny' }` —— 不产生新窗口、不留历史记录，
    也不用往第三方页面挂 preload、不暴露页面可触碰的接口。原读选区 IPC `hippo-browser:selection` 随之下线。
  - 三个动作：`Copy`（主进程写剪贴板，页面回执把按钮切成 `Copied` 900ms）、`Ask Bob`（把选区文本挂成本轮上下文）、
    `Page text`（挂整页正文）；后两个动作投递前先幂等展开对话栏，否则收起态下投进去用户看不到。
  - 注入幂等（`window.__bobSelBubbleBound`），每次 `dom-ready` 重注，不随文档切换失效；浮层贴选区下沿并做视口钳制
    （下方放不下翻到上方）；`Escape` / `scroll` / `resize` / 页面 `mousedown` 均收起；富文本编辑器（Google Docs
    一类虚拟光标）不弹；`mousedown` 上 `preventDefault + stopPropagation` 保住页面选区。
  - **抽取正文与截图前先移掉浮层**（`clearSelectionBubble`，幂等）：否则刚划完词就抽取/截图，浮层会被当成页面内容
    写进 markdown、或被一起拍进截图。
- **对话栏上下文挂载收敛为「每轮自动 + 划词手动」两条线**（改 `src/components/canvas/ChatNodeKernel.tsx` /
  `BrowserChatPanel.tsx`）：
  - 新增 `ambientContext`：Hippo 侧边栏把「用户此刻在看哪一页」的 URL / 标题每轮自动前置进模型侧内容。只进
    `effectiveContent`，不进气泡正文、不落盘、发送后不清除，与 `referenceTag` 的单槽位引用语义互不干扰；
    拼接位置放在引用标签 / 资料引用之后，避免被后续赋值覆盖。
  - 删除「首轮自动挂上下文」（`autoAttachedRef` / `attachPageContext` / `attachSelection`）与工具栏的选区挂载按钮；
    整页正文按钮收敛为**只在 Ask 档出现**（该档模型没有 `browser_*` 工具，是它读到正文的唯一通道），
    与之配套的 `attaching` 在途标记只服务这个按钮；页头区块由 `<button>` 改为 `<div>`（只展示）。
- **对话会话删除**（改 `src/components/hippo-browser/BrowserChatPanel.tsx`）：会话菜单新增删除，两步内联确认
  （垃圾桶 → 红色 `Delete`）。先摘本地索引立即生效，再删落盘节点（软删进 `.trash/nodes`，404 视为删除成功）；
  删的是当前会话则切到下一条，一条不剩则新建；落盘失败时留一句
  `Chat removed from the list, but its archived node could not be deleted`。


***


## v0.7.621 (2026-09-23)

### 修复与优化
- **修复 Hippo 对话栏冷启动白屏**（`electron/hippo-browser.ts`）：对话栏视图首帧 `loadURL` 的失败此前被静默吞掉，
  而创建函数对已存在的视图直接 `return`（复用、不再重载），于是冷启动时 app 内 Next 服务尚未就绪的那一次失败，
  会让对话栏那块区域**永久白**。现改为按 `did-fail-load` 退避重试：`CHAT_LOAD_MAX_RETRY = 3`，
  退避间隔 400ms × 已试次数，次数用尽才 `warn` 留痕；`-3`（ERR_ABORTED，被新导航打断/主动取消）不计入重试，
  `did-finish-load` 后计数归零。


***

## v0.7.620 (2026-09-23)

### 新增
- **PDF 正文读取打通（模型侧工具与对话栏共用一条提取管线）**（新增 `src/lib/pdf/page-source.ts`、
  `src/app/api/pdf-text/route.ts`；改 `src/app/api/chat/tools/browser.ts`）：
  - 抽出 `pdfPathFromUrl` / `downloadToTemp` 到 `lib/pdf/page-source.ts`，把三种地址形态归一：
    本地查看页（`/pdf-viewer?path=`）/ `file:` / `http(s)`（Hippo 打开 PDF 时地址栏保持原始 URL，不指向查看器）；
    模型侧 `browser_read_pdf` 与对话栏「内容」按钮**共用同一份**，不再各存一份。
  - 新增 `POST /api/pdf-text`：对话栏面板在渲染进程里调不到模型侧工具，改由宿主路由复用 Python →
    `pdf-parse` 两级提取管线（Python 结果 ≤20 字回退 `pdf-parse`），上限 40000 字符 / 500 页。
  - 对话栏「内容」按钮在 PDF 页上分流：DOM 里没有正文时改由该路由取真实文本，取不到才退回成因提示。
- **`browser_extract_text` 增加正文可读性诊断（`note` + `kind`）**（改 `electron/hippo-browser.ts` /
  `electron/preload.ts` / `electron/hippo-cdp.ts` / `src/lib/browser-tools/specs.ts` /
  `src/app/api/chat/tools/browser.ts` / `src/app/api/chat/route.ts`）：
  - 主进程先判 PDF 页：命中 Chromium 内置查看器扩展 id（`mhjfbmdgcfjbbpaeojofohoefgiehjai`）或地址以 `.pdf`
    收尾即返回 `kind: 'pdf'`（抽取脚本要等正文渲染最长 6 秒，PDF 查看器页永远等不到，故先判掉）；
    再按「登录墙关键词 + 正文长度」分类：<1200 字且命中 `sign in / log in / subscribe / paywall / 登录 /
    订阅` 等 = `login`，<300 字 = `empty`（可能未渲染完或内容在 iframe / shadow DOM）。
  - `note` 给出成因与下一步，`kind` 供机器分流；Envelope 与工具返回一并透传，正文回注时加
    `[PDF]` / `[LOGIN]` / `[EMPTY]` 前缀。
  - 规则层同步：新增「**PDF 页换工具，不要判空**」（改用 `browser_read_pdf`，不因提取为空断言页面无内容）
    与「`browser_extract_text` 带 `note` 时按它执行」；Research 规则「读全文而非片段」改为按页面类型分流。
- **Team 计划草案（未批准 / 已丢弃）可读**（改 `src/lib/types.ts`、`src/lib/chat/team-client.ts`、
  `src/components/canvas/TeamWorkbench.tsx` / `TeamChatStream.tsx`）：
  - 新增 `TeamPlanDraftView`：宿主从 panel 的 `draft` 投影出「计划中的成员与任务」与用户原始提问
    （`question`）。approve 之前成员 / 任务尚未物化，此前工作台只能渲染空壳。
  - 工作台据草案渲染计划分工（灰点 + `role`、`CircleDashed` + `Planned · assignee · after deps`），
    Members / Tasks 计数改用「已物化优先、否则计划」的口径并标注 `· planned`；`planning` / `discarded`
    时在主列顶部给出单行说明（等待批准 / 计划已丢弃）。
  - `TeamChatStream` 新增 `question` 回退：审批前没有 `team_start` 事件，时间线不再开天窗（`team_start`
    存在时仍以它为准，重载后一致）；无任何事件时显示 `No collaboration events yet`，而不是复用
    「该成员无事件」那行。

### 修复与优化
- **建队即绑定 teamId**（`src/lib/chat/team-run.ts`）：`team_create` 成功后立刻把 `teamId` 写进上下文并
  补发一帧 —— 只认面板带回的话，「待批准 → 拒绝 / 超时」的 run 永远到不了 approve 那一步，团队会永远
  绑不上节点，用户看到的就是「协作明明发了，团队面板却还停在发起界面」。
- **DOM → Markdown 抽取质量**（`electron/hippo-browser.ts`）：跳过已被已输出祖先覆盖的嵌套节点（去重复行）；
  `tr` 输出补表格分隔线并转义单元格内的 `|`。
- **工具栏对话按钮图标**（`electron/hippo-browser.ts`）：改用 bot 图标，并把 `#chatBtn svg` 由默认 13px
  放大到 15px，与相邻 AI 编辑图标对齐（bot 图标笔画密、视觉偏小）。


***

## v0.7.619 (2026-09-23)

### 新增
- **Hippo Browser 全量迁移落地（默认通道翻转为 hippo）**（新增 `electron/hippo-cdp.ts`、`lib/browser-tools/*`、
  `components/hippo-browser/BrowserChatPanel.tsx`、`app/browser-chat/`、`app/api/chat/tools/browser.ts`，
  改 `electron/hippo-browser.ts` / `electron/main.ts` / `electron/preload.ts` / `lib/runtime/tools.ts` /
  `lib/agents/profiles.ts` / `lib/settings.ts` / `app/api/chat/route.ts`）：
  - 抽出一套**工具规格 + 两个 driver** 的浏览器工具层（`lib/browser-tools/`：`specs` 规格、`types` 接口、
    `policy` 策略与页内脚本 lint、`index` 通道解析、`hippo-driver` Hippo 侧实现），
    `chrome` 通道继续走 Bob Browser，`hippo` 通道走应用内浏览器；开关为**全局互斥**的 `settings.aiBrowser`，
    不做单次调用路由。
  - **默认通道翻转**：`aiBrowser` 缺省（undefined）即 `hippo`——仅显式写入 `'chrome'` 才回退 Bob Browser；
    `runtime/tools.ts`、`app/api/chat/route.ts`、`settings.ts`、`SettingsModal` 的判据同步由 `=== 'hippo'` 改为 `!== 'chrome'`。
  - 新增 `electron/hippo-cdp.ts`（主进程自动化后端）：把规格层 `browser_*` 调用映射到当前活动标签的
    `WebContents`（`webContents.debugger` + CDP + 页内脚本），统一返回 Envelope（`ok` / `value` / `error.phase`）；
    ref 作用域前缀（`e3` / `s1-e2` / `f1-e4`），CDP 会话按标签常驻，遥测走 WeakMap 环形缓存。
  - 新增右侧**浏览器对话栏** `BrowserChatPanel`（直挂 `ChatNodeKernel`，`node_type='browser'`），新增
    `browser` / `browserAsk` / `browserResearch` 三个身份：`browser` 为 `hidden` 固定场景身份
    （scenes `browser` + `ledger`，剔除 read_file / write_file / run_command 等文件与命令类内核），
    `browserResearch` 追加**调研作业纪律**规则（先取证据再下结论、结论需回链页面）。
  - `bob-browser-mcp` 由「出厂默认开启」改为「非出厂默认项，仅市场手动添加」；Bob Browser 降级为**互补通道**。
  - 迁移结论见 `docs/hippo-browser-full-migration_20260923.1.md`（抽规格层 + 双 driver，开关互斥切换）。
- **Team 视图主列改造为「工作汇报群」时间线**（改 `bob-team-mcp/`：`engine/team`、`engine/scheduler`、`store`、
  `tools`、`mcp-server`、`prompt/guidance`；宿主 `lib/chat/team-events.ts` / `team-client.ts` /
  `components/canvas/TeamChatStream.tsx` / `TeamWorkbench.tsx` / `lib/types.ts`）：
  - 引擎新增 `kind: 'captain'` 事件（`meta.stage`：`dispatch` / `review` / `followup` / `synthesis`）与
    `captain_note` 工具 + `captainNote()` 方法（`CAPTAIN_NOTE_CAP = 2000`）：队长开群派活、逐人点评、
    点名追问、收口合并均以「群内发言」形式落进同一条时间线。
  - `msg_send` 增可选 `from_member`：邮箱层不变、事件层 `meta.actor` 记真实成员名，宿主 `relay` 的 `from`
    改读 `meta.actor`，成员互留言显示真实来源→目标。
  - 成员 `member_done` 增 `say`（群聊发言行）与 `steps`（工具调用步数），并透传**产出文件卡片**
    （`TeamArtifactItem`：path / name / size / kind / source，只放行有 path 的条目）；成员会话带 `projectId`，
    产出直接落进对应项目的 `homework/`。
  - 新增 `team_overview` 引擎工具（team_id 列表）+ `store.listTeamSummaries()`（只读抽标量、跳过坏文件），
    团队列表由「逐个 `team_status` + `summarizeTeam`」改为单次调用；宿主新增 `listTeamOverviews()`。
  - 引擎工具数 21 → **22**；事件窗口 `readTeamEvents(50)` → `200`；`TeamChatStream` 新增 `CaptainRow`，
    增量 `panel` 帧省略 `events` 字段以降带宽；`team_plan` 增 `question`，随 `team_start` meta 落盘。
  - 右栏 Members / Tasks 矩阵保持不变。
- **md 编辑器 AI-native 三块能力**（新增 `app/api/md-navigate/`、`app/api/md-consistency/`、
  `lib/md-consistency/check.ts`、`components/canvas/MdSemanticNav.tsx` / `CheckReport.tsx` / `MdAnnotationPanel.tsx`、
  `lib/ai/resolve-model-config.ts`，改 `app/api/ai-edit/markdown/route.ts`）：
  - **批注驱动编辑**：修订轮次带 `note`、产出 `ReviseReport` 与汇总块，按批注逐条落地。
  - **语义导航**：LLM 单次分块定位 + 服务端 `indexOf` 回校，跳转不落空。
  - **一致性检查**：术语 / 编号 / 引用一致性核查，报告复用批注样式。
  - `resolveModelConfig` 抽到 `lib/ai/resolve-model-config.ts`，`ai-edit` 与 `markdown` 共用。
  - 硬约束不变：markdown 是唯一真相源；新增界面文案一律英文。
- **出厂网页快捷指令**：`settings.ts` 预置 5 条 `category: '网页'` 快捷指令（总结此页 / 提取要点 / 翻译此页 /
  追问问答 / 事实核查），`settings-server.ts` 对缺失项**出厂补全到末尾**、不覆盖用户已有项。
- **Hippo「Send to canvas」接线**（`CanvasFlow.tsx`）：接收主进程 `onCanvasFocusNode` 回调，将页面内容挂成
  画布节点并置焦点。
- **legal-drafter skill 微调**（`assets/skills/legal-drafter/`）：资源读取仅保留 `references/xxx.md`；
  「独立使用模式」产出由 `.docx` 改为 `.md`。

### 修复
- **团队审批门禁偶发挂死到超时**（`lib/chat/confirm-pending.ts`、`app/api/chat/confirm/route.ts`、
  `components/canvas/ChatNodeKernel.tsx`）：
  - 挂起确认项新增 `signal?: AbortSignal`，`settle()` 成为唯一收口出口（清定时器 / 摘挂起表 / 摘监听 / resolve 幂等），
    **连接断开即按超时收口**，不再让审批项悬空到 10 分钟。
  - `/api/chat/confirm` 缺 `confirmId` 回 **400**；挂起项不存在回 **409**（并 `console.warn('[chat/confirm] 挂起项不存在…')`），
    此前一律回 200 导致内核误认为审批已生效、静默挂死。
  - `ChatNodeKernel` 对非 ok 响应置 `setTeamPlanDiscarded(true)` 并告警，界面明确显示「审批未生效」。
- **项目配置与侧栏列表并发丢更新**（`lib/project/project-manager.ts`、`components/canvas/Sidebar.tsx`、
  `CanvasFlow.tsx`）：
  - `project-manager` 新增配置读写**串行队列** `withConfigLock()`，`createProject` / `switchProject` /
    `archiveProject` / `unarchiveProject` 全部改走 `*Locked` 临界区，消除并发读改写互相覆盖导致的配置丢失。
  - `Sidebar` 增 `loadProjectsSeqRef`、`CanvasFlow` 增 `loadProjectDataSeqRef`：过期响应（序号不匹配）直接丢弃，
    避免旧请求晚到覆盖新列表 / 新画布数据。
- **团队列表接口放大调用**（`app/api/team/list/route.ts`）：改走引擎 `team_overview` 单次调用，
  不再逐个 `team_status` + `summarizeTeam`，列表显著变快。
- **成员产出与发言丢失**：`bob-team-mcp` 成员会话落 `cleanText`、`extractSay` 抽发言行；
  `chat-adapter` SSE 帧读取 `ev.output_files` 并在返回值透传，产出文件不再丢。


## v0.7.618 (2026-09-23)

### 修复
- **插件面板端口冲突导致「打不开」**（新增 `lib/mcp/panel-ports.ts`，改 `lib/mcp/manager.ts` / `lib/plugin-panels-server.ts` / `app/api/chat/route.ts`）：
  - serve 形态插件面板（Bob Notes 9480 / Bob-Mind 9482）原为**整机唯一**的固定端口，同一台机器上并存两个宿主
    （安装版 App + 源码 dev，或两个安装版）时，后启动者的插件实例必然 `EADDRINUSE`；面板永久打不开且不会自愈
    —— 宿主侧回收器刻意不碰「另一个活着宿主」的实例。
  - 新增 `lib/mcp/panel-ports.ts`：宿主侧运行时端口表，`node:net` `listen(0)` 取空闲端口；状态挂 `globalThis`
    （Next 每个 route 独立 chunk、dev HMR 会重建模块实例，模块级变量会出多份），仅依赖 `node:net`，无反向依赖。
  - `manager.ts`：`createConnection` 新增 `registerPanelPort` 选项，仅对 `mode === 'serve'` 的插件分配端口（已登记则复用），
    用**解析后 args 副本**把裸 `--serve` 改写为 `--serve <port>`（配置里已写死数字端口则原样保留），并注入 env `BOB_PANEL_PORT`；
    **不就地改写 `config.args`**（`configChanged` 逐字比较会导致反复重连、iframe src 抖动）；`testConnection` 路径
    只分配临时空闲端口、**不登记**，避免测试端口覆盖真实实例端口。
  - `plugin-panels-server.ts`：serve 条目端口优先级改为 **运行时表 > 实例配置 > 预置地址**；出条目前幂等触发
    `syncServers` 确保 serve 插件已连接（否则只能回退固定端口，iframe 指向另一个宿主的实例、静默串台）；
    新增 `trustedConflict()` 归属校验——冲突标记落在插件共享数据根、不分宿主，本宿主已分配运行端口时只认指向该端口的标记，
    避免误杀另一个宿主的健在实例。
  - `app/api/chat/route.ts`：`MIND_PANEL_URL` 由模块级常量改为 `mindPanelUrl()` 函数内动态解析（运行时表优先，
    回退预置地址），使面板改动回看注入指向本实例。
  - 插件侧 `EADDRINUSE` 重试与冲突标记、宿主 `reapStaleHolder` 回收**保留不动**，作为安全网。
- **Hippo Browser 下载面板 Clear / Close 点击无效**（`electron/hippo-browser.ts`）：
  - 下载面板原排在 `.bar` / `.tabbar` / `.bmtabs` 等拖拽区（`-webkit-app-region: drag`）之前，Chromium 按文档顺序
    累加拖拽区，后出现的 drag 元素会重新盖住先前声明的 no-drag 区域；面板头部（Clear / Close，y≈52~76）
    正落在标签条 / 书签栏的拖拽带内，点击被当作拖动窗口吞掉，而面板下半部分仍可点。
  - 将面板 DOM 移至全部拖拽区之后（`position: fixed`，移动位置不影响布局），并为 `.dlHead` / `.fbtn` 补 `-webkit-app-region: no-drag`。

### 优化
- **文件列表 tooltip 收敛**（`components/canvas/Sidebar.tsx`）：非目录项不再挂 `title`（文件名已在行内完整可见，
  悬停气泡遮挡相邻项），目录项保留路径 tooltip。


## v0.7.617 (2026-09-23)

### 修复
- **全文搜索高亮定位不准**（`components/canvas/DocEditor.tsx`）：
  - 原 `computeFindMatches` 用 `textBetween(0, size, '\n')` 的字符串索引 `+1` 换算 doc 位置，
    但块分隔符在文本里占 1 个字符、在文档位置中并不存在，导致第 k 个文本块内的匹配被低估 k 个位置，
    越靠后的段落偏移越大——这正是「搜索高亮文字不准确」的根因。
  - 改为遍历文档节点一次性建立「字符偏移 → doc 位置」映射：文本节点内部位置连续（跨 mark 也能命中）；
    块边界与行内叶节点（硬换行 / 行内图片）写入 `-1` 占位，跨越占位符的匹配直接丢弃，
    避免拼出假匹配或横跨换行 / 图片的高亮。
- **标题段落对齐「点了没反应」**（`components/canvas/extensions/CollapsibleHeading.ts`）：
  - 折叠标题的 NodeView 接管渲染后不会自动带上 `HTMLAttributes`，`TextAlign` 写入的 `textAlign`
    属性未能落到 DOM，表现为对齐命令确实生效却看不到任何变化。
  - 新增 `applyAlign()`，手动将 `attrs.textAlign` 落到 `content`（h1–h6）的 `style.textAlign`，
    并在 `update()` 中同步应用；落在 `content` 而非 `wrapper`，因 wrapper 是 flex 容器、
    `text-align` 对 flex 子项不生效。
  - 同步在 `components/canvas/extensions/AnnotationBubble.tsx` 补充说明该限制：Markdown 无段落对齐语法，
    `tiptap-markdown` 的 paragraph / heading 序列化器会丢弃 `textAlign`，故段落对齐仅在本次编辑会话内生效，
    保存重开后还原为左对齐（与表格单元格 L/C/R 的既有行为一致）。


## v0.7.616 (2026-09-23)

### 新增
- **团队工作台：任务时序与接管能力**（`components/canvas/TeamWorkbench.tsx` / `lib/team/*`）：
  - `TeamTaskView` 新增 `claimedAt`（认领时写入）与 `finishedAt`（进入终态时写入），引擎随任务下发 `staleMs`（`STALE_MS`）。
  - 工作台据此显示「No progress for Xs · takeover in Ys / takeover due」倒计时；旧引擎缺少 `staleMs` 时回落 `FALLBACK_STALE_MS`（6 分钟）。
  - 新增 **Take over** 按钮（复用 `retryTask`），可立即接管疑似停滞的任务；原「Possibly stalled …」静态提示文案移除。
- **团队工作台：依赖失败传播与停摆提示**（`TeamWorkbench.tsx` / `lib/team/*`）：
  - `TeamTaskView.blockedBy: string[]` 由引擎在任务进入终态时传播产出（权威判定），UI 不再自行按「deps 含 failed」推断。
  - 新增停摆横幅「N tasks stalled by failed upstream」，可点击 `#tN` 定位并高亮上游任务。
  - 失败任务仅在「自身失败」时显示 Retry，被上游阻塞导致的失败不再出现误导性重试入口。
- **团队工作台：分配矩阵与时间线**（`TeamWorkbench.tsx` / **新增** `components/canvas/TeamTimeline.tsx`）：
  - 成员行升级为「分配单元」：状态点 + 名称 + `done/assigned` 徽标 + 累计耗时 + 完成率进度条。
  - 侧栏支持折叠（`sidebarOpen`），折叠后收为 28px 计数条。
  - 新增甘特/泳道式时间线视图：任务条按 `claimedAt..finishedAt` 定位，未开跑任务归入 **Queued** 清单；由顶部 **Timeline** 按钮打开。

### 变更
- **Auto 模式选模逻辑大幅简化**（`lib/model-matcher.ts` / `lib/wanted/task-model.ts` / `lib/bridge/settings.ts` / `components/canvas/ChatNodeKernel.tsx` / `components/canvas/SettingsModal.tsx`）：
  - 删除整套任务类型分析选路逻辑：`TaskType` / `TaskAnalysis`、关键词表、`analyzeTask()`、`selectBestModel()`、`inferThinkingLevel()`、`generateModelSpec()`。
  - 新 Auto 语义：① 取候选池有序首项（`settings.chatModel.pool[0]`）；② 带图且 `autoVisionOnImage !== false` 时改为选取池中首个视觉模型。
  - 移除设置项 `chatModel.auto`（开关随之下线）；`autoVisionOnImage` 文案更新为「When the model is Auto… pick a vision-capable model from the pool」。
  - 服务端解析链简化为 `resolveAgentRoleModel` → `resolveTaskModel`；删除 `resolveAutoTaskModel()` / `rankPoolForTaskType()`。
  - `thinkingLevel` 语义注释变更：「auto 按任务难度推断」→「跟随节点设置，与模型无关」。
  - 资产文档 `assets/skills/user-guide/SKILL.md` 同步更正 Auto 模式说明。
- **文档编辑器：查找替换新入口与段落对齐**（`components/canvas/DocEditor.tsx` / `components/canvas/extensions/AnnotationBubble.tsx`）：
  - ⌘⇧F 查找替换抽为统一 `openFind`；右键菜单与命令面板 Tools 组新增 **Find（⌘⇧F）**，右上角 TOC 图标旁新增 Search 图标按钮。
  - 划词气泡工具栏新增 **段落对齐下拉（左 / 中 / 右）**，调用 `setTextAlign`；工具栏由 3 组扩为 4 组。

### 重构
- **全量 TypeScript 类型加固（无行为变化）**：
  - 全库 `catch (e: any)` → `catch (e)` + `e instanceof Error`；内联 `require('fs' | 'fs/promises' | 'path')` 提升为顶层 `import`；`any` → 具名类型。
  - `lib/db/index.ts`（432 行 diff）：`db: any` → `db: SqliteDb`、`params: any[]` → `unknown[]`，**未新增表 / 列 / 迁移**。
  - `electron/main.ts`：`info: any` → `UpdateInfo`，Proxy 相关类型收紧。
  - `e2e/settings-simulate.spec.ts`：`(window as any)` → `MockAvatar` / `MockAvatarApi` 接口。
- **项目路径读取收敛**（**新增** `lib/project/project-config.ts`）：
  - 新增 `readProjectRefs()` / `getCurrentProjectRef()`，只读 `<APP_ROOT>/.projects.json`。
  - `md-annotations-cleanup.ts` 改用 `readProjectRefs()`；`mcp/manager.ts` 改用 `getCurrentProjectRef()`。
  - `sticky-notes-migrate.ts` 改用 `readProjectRefs()`，消除与 `project-manager` 的循环依赖。
- **工程化**：`eslint.config.mjs` 新增忽略 `**/.next/**`、`**/*.cjs`、`public/pdf.worker.min.mjs`、`assets/skills/**/scripts/**`、`release/**`、`release-dist/**`、`electron/dist/**`；新增 `types/global.d.ts` 与 3 个单元测试（`docx-numbering`、`node-markdown`、`pdf/text-search`）。

### 修复
- **微信桥接**（`lib/bridge/wechat-adapter.ts`）：扫码状态未知值回落为 `waiting`。
- **媒体解析**：媒体 item 需 `type` 为数字才解析，避免异常项被误判。


## v0.7.615 (2026-09-21)

### 新增
- **提前提醒可被模型解析（「提前 N 天 / 一周提醒」）**（`lib/wanted/task-summarize.ts` / `lib/wanted/executor.ts`）：
  - 双通道 prompt（批量 / `single`）新增 `reminder_minutes` 字段与规则 8：把「提前 3 天提醒」「提前一周」「提前半小时」换算成分钟填数组（1 天 = 1440 / 1 小时 = 60 / 1 周 = 10080），多个提前量填多个；
  - 明确强调这是**提醒时间点、不是事件开始时间** —— 不要因为「提前 3 天提醒」就把 `start_time` 往前挪 3 天；
  - 未提及提醒时**不输出该字段**（与「输出空数组 = 明确关闭」区分）；落到事件前做规范化：只接受正整数分钟、去重降序、上限 30 天（30×1440），空数组 → `undefined` 走系统默认；
  - prompt 另补一段说明：解析结果会直接写进日历事件，字段（标题 / 开始 / 结束 / 全天 / 优先级 / 提前提醒 / 地点 / 分类 / 描述）各有归属，用户提到的信息要落到对应字段、不要一股脑塞进标题。
- **「明确关闭提醒」与「未配置」的语义区分**（`app/api/calendar/events/route.ts` / `components/canvas/CalendarPanel.tsx`）：事件接口新增返回 `reminder_disabled`（`reminder_minutes_json === 'null'` 即为 true）—— `'null'` = 明确关闭提醒，`'[]'` = 未配置、扫描时按默认 30 分钟。前端据此回显「无提醒」；否则打开事件即触发自动保存，会把「已关闭」悄悄改回 30 分钟。
- **便签行入日历同步补全其余日历字段**（`lib/sticky-calendar-sync.ts`）：除标题 / 时间 / 地点外，把模型解析出的 `description` / `category_path`（重排与新建路径）与 `priority`（仅新建）一并落库；提醒口径为「模型解析出的优先（支持提前 N 天 / 一周），否则解析到时间就给系统默认 `[30]`，完全没解析出时间则 `[]` 表示不提醒」；正则回退路径不带这些字段，保持 `undefined` 不动原值。

### 优化
- **提前提醒改为多档 chips**（`components/canvas/CalendarPanel.tsx`）：
  - 由「单选下拉（预设 + Custom…）」改为**可添加多个提醒**：已选用 chips 展示（可逐个 × 删除），下拉变为 `Add reminder…` 只用于追加；
  - 预设新增 `3 days`(4320) / `1 week`(10080)，避免模型解析出的常用档位落进 Custom 显示成裸分钟数；
  - 新增 `fmtReminderLabel()`：预设用其文案，其余按天 / 小时 / 分钟就近取整（`4320 → 3 days`、`45 → 45 min`）；
  - 自定义分钟支持 Enter 提交与 `Add` 按钮；提醒状态改为数组，写入前去重降序；打开事件时 `reminder_disabled → []`、未配置 → `[30]`。
- **月视图更紧凑**（`components/canvas/CalendarPanel.tsx`）：事件条与日期数字字号统一到 `11px`（小竖棒 / 红旗 2.5 → 2）；月视图网格由 `gap-1 + p-1` 收紧为 `gap-px`（去外圈内边距、行间 1px 发丝线），容量算法随之从 18n−1 调为 15n−1、内部扣除 32 → 28；今日圆底 20 → 16px，并移除选中日的额外边框环（改由格子边框表达）。

### 说明
- 本版 **5 个文件改动**（`src/app/api/calendar/events/route.ts` 20 行 / `src/components/canvas/CalendarPanel.tsx` 303 行 / `src/lib/sticky-calendar-sync.ts` 60 行 / `src/lib/wanted/executor.ts` 20 行 / `src/lib/wanted/task-summarize.ts` 96 行）；Electron / screenshot-plugin / MCP server 无改动。
- 取证：`.next/standalone/src/**` 源码快照基线有效（`BUILD_ID` 17:34 = v0.7.614 构建，`standalone/package.json` 版本 0.7.614），与 mtime 全仓扫描两法完全吻合（均只 5 个文件）。

## v0.7.614 (2026-09-21)

### 优化
- **便签行入日历「重排判据」修正**（`lib/sticky-calendar-sync.ts` / `app/api/sticky-notes/route.ts`）：
  - `source_ref` 新增 `autoText`（**上次解析所用的行文本原文**）；重排判据由「与上一份便签 `prevNote` 做 diff」改为「与 `source_ref.autoText` 比对」。原判据失效的原因：打字防抖落盘已先把新文本写进文件，等到结算时再与上一份便签比对**恒为空**，会漏掉「事后补写日期」这类修改；改用 `autoText` 后判据只认「相对上次解析是否变过」。
  - 新增**漏读日期兜底**：`DATE_HINT_RE`（年 / 月日 / 斜杠日期 / 相对日）+ `isNoTimeFallback()`（时间落在「当前 + 1 小时」默认值 ±5 分钟内，即模型判定「无时间线索」的默认值）。上次解析把带日期的文本判成无时间线索时，重试一次重新解析。
  - 新增**重排保护** `keepTime`：新解析结果落在「无时间线索」默认值上、而事件原本是一个明确时间时，保留原时间，只更新标题 / 地点，避免一次无效重排把已排好的时间打回默认。
  - `autoAddStickyLinesToCalendar` 去掉 `prevNote` 入参（不再依赖与上一份便签的比对）。
- **月视图 `+N more` 浮层化 + 事件条数自适应**（`components/canvas/CalendarPanel.tsx`）：
  - 格子内事件条数由硬编码 3 条改为**按格子实际高度实测自适应**（`useLayoutEffect` + `ResizeObserver`，容量 1–8 条），随面板尺寸变化重算；溢出时固定留一行给 `+N more`。
  - `+N more` 由静态文本升级为**可点浮层**：列出该日全部事件、可滚动（隐藏滚动条）、点条目直接进编辑；浮层坐标取自被点格子并做视口边界钳制，切换月份自动关闭。
  - 抽出 `MonthEventRow` 组件（小竖棒 + 时刻 / 标题 + 红旗），格子内与浮层共用同一套渲染。

### 说明
- 本版 **3 个文件改动**（`src/app/api/sticky-notes/route.ts` 2 行 / `src/lib/sticky-calendar-sync.ts` 54 行 / `src/components/canvas/CalendarPanel.tsx` 161 行）；Electron / screenshot-plugin / MCP server 无改动。
- 取证：`.next/standalone/src/**` 源码快照基线有效（`BUILD_ID` 15:16 = v0.7.613 构建，`standalone/package.json` 版本 0.7.613），`diff -rq` 仅 3 个 `Files … differ`。

## v0.7.613 (2026-09-21)

### 新增
- **便签待办行自动入日历（与 `/todo` 统一口径）**（`lib/sticky-calendar-sync.ts` / `app/api/sticky-notes/route.ts` / `components/canvas/StickyTodoDock.tsx` / `components/canvas/CanvasStickyNotes.tsx`）：
  - 便签「结算」保存时，把**未入日历且未完成**的待办行自动排期为项目作用域事件（新增 `autoAddStickyLinesToCalendar`）；解析逐行调 `/api/tasks/summarize` 内核（`single=true`，一行 = 一任务，故「一行 ↔ 一个事件」天然一一对应），模型不可用 / 失败 / 无任务则退回正则 `parseTodoTime`（只有日期按 09:00），再退默认时段；
  - 结算时机重新设计：打字过程中的防抖落盘带 `settle_auto_calendar=false`（只存内容，避免半截文本被建成事件）；仅在**行输入框失焦**、**停手 8 秒兜底**、**关闭便签卡**（把未落盘脏数据连同结算一起冲盘）时才真正结算；
  - 事件标题统一口径 `主题_项目名`（项目名去掉创建时追加的 `_YYYYMMDD`）；`source_ref` 新增 `autoTime` / `aiTitle` 标记 —— 系统推断时间的事件在行文本改写时跟随重排，用户在日历手动指定时间、或由模型排期的事件不被正则口径覆盖；
  - 反向同步（日历 → 便签行）先剥掉标题的 `_项目名` 后缀再落回行文本，且行内时间表达不计入差异，避免日历侧改状态/颜色把行内「明天 10 点」洗掉。
- **待办文本「时间 / 主题」双通道解析**（`lib/todo-time-parse.ts` / `app/api/sticky-notes/parse-time/route.ts` / `components/canvas/StickyTodoDock.tsx`）：`parseTodoTime` 与模型 prompt 新增产出 `topic`（原文剔除日期/时刻表达后的事项本身，「明天下午3点跟张三开会」→「跟张三开会」），识别命中时时间写进 Date/Time 字段、主题写进 Todo 栏（各自独立判定用户是否已手改）；提示文案改为 `Time & topic taken from text — edit to override`。
- **项目面板新增「图标墙」视图**（`components/canvas/ProjectBoardView.tsx` / `app/globals.css`）：
  - 视图模式由 `grid | list` 扩为三种，新增 `Icon view`；磁贴底色按项目 id 哈希出稳定色相、字形取中文首字 / 英文首字母缩写，**无需素材与数据迁移**；
  - 磁贴内含 hover 入口（`Open project` / 归档态 `Restore to open`）、未完成待办红点角标、开庭标签（开庭前 3 天起与卡片同款呼吸灯）；
  - 头部新增图标 KPI 条 `Projects` / `Hearings` / `Open todos` / `Nodes`，全部由既有字段推导，不引入额外请求。
- **开庭排期事件化补全**（`components/canvas/ProjectBoardView.tsx` / `components/canvas/StickyTodoDock.tsx`）：法庭号做规范化（去掉用户自带的「第 / 法庭 / 庭」，避免拼出「第二十法庭法庭」）；建事件时新增 `location`（地点 = 法院 + 法庭（+ 地址），主题只留事项）与 `priority='high'`（自动红色标旗）。

### 优化
- **日历面板改版为 macOS 日历范式**（`components/canvas/CalendarPanel.tsx`）：
  - 事件弹窗由「表单 + Save/Create 按钮」改为**自动保存**（600ms 防抖；非法输入静默保留最后落盘版本，不再弹校验提示；ESC / 点遮罩关闭前先冲刷未落盘改动），新建成功后自动转为编辑态走 PATCH，避免重复创建；
  - 新增左侧 260px 待办栏（`Today` / `Selected` 表头 + 状态切换 + 红旗 + 地点行），删除原底部固定高度待办卡片；
  - 面板默认占满屏宽（仅左边缘拖拽后变固定像素宽度），月视图网格改为固定行高，避免 6 行月份（如 8 月）在矮面板下撑破外框；
  - 优先级下拉改为**红旗开关**（`FLAG_PRIORITY = 'high'`），月视图标签 / 时间轴块 / 左栏列表统一显示小红旗；
  - 提醒设置由多选胶囊改为**单选下拉**（预设之外走 `Custom…`，非预设的既有值可正确回填）；
  - 事件标签视觉由「通高左边框色条 + 半透明底色」改为 macOS 风格「标题前小竖棒」，默认隐藏已完成事件（改中性灰眼睛图标）；
  - 便签来源事件（`source_ref.kind === 'sticky'`）以暖黄与普通分类色区分。
- **任务解析内核抽离**（新增 `lib/wanted/task-summarize.ts` / `app/api/tasks/summarize/route.ts`）：`/api/tasks/summarize` 的模型解析内核抽为共享模块，路由退化为薄封装；便签自动入日历复用同一套 prompt 与 `single` 口径，避免两处漂移。
- **样式与联动**（`app/globals.css` / `app/api/calendar/events/route.ts` / `components/canvas/*`）：项目面板磁贴底色与阴影移入样式表（避免内联样式压掉 `:hover`）；日历面板恢复文字选中高亮；日历事件接口返回 `source_ref`；便签保存与项目面板保存后广播 `calendar-events-changed`，自动入日历确实建/改事件时即推远端日历，免等轮询。

### 说明
- 本版 **12 个文件改动 + 1 个新增**（`src/lib/wanted/task-summarize.ts`）；另有 `next-env.d.ts` 生成物噪声（dev server 改写指向 `.next/dev/types/`，构建时会被覆盖）。Electron / screenshot-plugin / MCP server 无改动。
- 取证：`.next/standalone/src/**` 源码快照基线有效（`BUILD_ID` 23:24 = v0.7.612 构建），与 `git status` 交叉吻合（11 个源文件 `Files … differ` + 1 个新增）。

## v0.7.612 (2026-09-20)

### 优化
- **分享卡署名行微调**（`components/canvas/ShareCard.tsx`）：底部水印的「Bob × {model}」不再对模型名单独加粗高亮，整体同字重同色（与左侧品牌水印视觉一致）；时间戳去掉 `Generated` 英文前缀，仅保留日期时间（如 `2026/09/20 23:19`）。

### 说明
- 本版仅 1 个文件改动（`src/components/canvas/ShareCard.tsx`），Electron / screenshot-plugin / MCP server 无改动。
- 取证：`.next/standalone/src/**` 源码快照基线有效（`BUILD_ID` 20:05 = 上一次发布构建），与 mtime 全仓扫描两法吻合（1 文件一致）。

## v0.7.611 (2026-09-20)

### 优化
- **分享卡改版：模型徽章移到署名行**（`components/canvas/ShareCard.tsx`）：
  - 品牌头回归极简（logo + BobWork），移除头部右侧的模型徽章（连同 `BrandCard` 的 `levelLetter` 参数一并删除，两处调用点同步清理）；
  - 底部水印由 `Share via BobWork` 改为协作署名 **「Bob × {model}」**（模型名加粗高亮），无模型信息时回退原水印文案，时间戳保留在右侧。
- **小红书卡纸质底色精简**（`components/canvas/XhsCard.tsx`）：色板由 7 种收敛为 4 种，移除 `Blush` / `Mint` / `Lemon`，保留 `Cream` / `White` / `Kraft` / `Sky`（历史卡片数据经 `resolvePaper` 回退不受影响）。
- **聊天节点渲染性能修复**（`components/canvas/ChatNodeKernel.tsx`）：
  - 浮层定位：新增上一帧坐标镜像 `lastPosRef`，坐标未变时跳过 `setPos`，避免 rAF 每帧用新对象触发一次重渲染；
  - 配置类工具广播去重：改为按「消息 id + 工具序号 + 工具名」记忆已广播项（`broadcastConfigToolsRef`）。此前只看「是否存在已完成的配置工具」，流式期间 messages 每来一个 chunk 就广播一次 `provider-configs-changed`，订阅方（本组件 / Sidebar / 其他节点）反复全量 `loadSettings` 并重渲染整个画布；
  - `availableModels` 改用 `useMemo` 按 `providerConfigs` 记忆：`getAvailableModels` 每次调用返回新数组，内联会让下游 effect / `useMemo` 依赖（`dropdownModels`、`teamModelOptions` 等）每渲染必变，引发「每渲染必跑 effect」的放大。

### 说明
- 本版 3 个文件改动（均在 `src/components/canvas/`），Electron / screenshot-plugin / MCP server 无改动。
- 取证：`.next/standalone/src/**` 源码快照基线有效（`BUILD_ID` 20:36 = 上一次发布构建），与 mtime 全仓扫描两法完全吻合（3 文件一致）。

## v0.7.610 (2026-09-19)

### 新增
- **长扫描件 OCR 异步化：索引三态可见（已索引 / 识别中 / 识别失败可重试）**（`lib/materials/indexer.ts` / `app/api/materials/route.ts` / `components/canvas/Sidebar.tsx` / `lib/parse/ocr-task-manager.ts`）：
  - **根因修复**：整份识别的长扫描件（页数 ≥ 15 或体积 ≥ 5MB）此前走同步 OCR，撞 MCP 客户端 300s 超时 → 返回 `no-text`，既不写 manifest 也不登记账本，上传侧又 fire-and-forget，材料被**静默丢弃**（目录里有文件却不算资料）。现改为转交后台异步任务，不再白等超时。
  - `indexer.ts`：manifest 顶层新增 `pending` / `failed` 两张登记表（**不进 `entries`**，避免库存检索把无正文的文件误报为已索引）；新增 `queueScannedOcr` / `commitOcrResult` / `commitIndexEntry`（同步与异步两条链路共用落库 + 账本登记口径）；新增 `listMaterialIndexStatus()`（三态只读投影）与 `retryMaterialIndex()`；`reconcileMaterialIndexStatus()` 自愈陈旧 pending（进程内无任务且超 5 分钟 → 落 failed，避免重启后永远转圈），且删除 / 重命名时三张表一并清理迁移。
  - `api/materials/route.ts`：`index_status` 由「只返回 indexed」改为返回 `{indexed, pending, failed}` 三态；新增 `retry_index` action 供失败态显式重试。
  - `Sidebar.tsx`：文件行失败时显示 `AlertTriangle + Retry` 入口（tooltip 带失败原因）；切换项目先拉一次状态（否则重开后「识别中 / 识别失败」不显示）；后台识别中的行不再按 deadline 兜底清除。
  - `ocr-task-manager.ts`：单回调 `onDone` 改为多订阅 `onDoneHooks` / `onFailHooks`（同一任务 chat 附件与 materials 各挂一个订阅），且单个订阅方抛错不牵连其他订阅方、也不再把识别本身判为失败。
- **账本：单侧缺口「显式标注」即视为已声明；后台编译任务允许写对照条目**（`lib/mcp/ledger.ts` / `lib/mcp/ledger-compile.ts` / `lib/agents/profiles.ts`）：
  - `ledger.ts`：`ledger_lint` 的「仅单侧依据、缺对照」检查认账——条目正文已写「仅单侧依据，缺对照」即不再重复告警（此前提示让用户显式标注、却不认这句标注，告警无法通过遵守提示消除）；判定仍只在单侧时执行，不存在靠一句话掩盖双侧条目的可能。
  - `ledger-compile.ts` / `profiles.ts`：宿主下发的**后台账本编译任务**成为「判断类条目只由用户明确要求才写」的唯一例外——可写 `comparison`，但须同时满足「同一焦点两侧材料都已读到或已登记」「两侧各至少一条 `materials/` 真实出处」「正文只并列不裁决」；`issue` / `analysis` 仍不写。单侧材料条目须在正文显式写「仅单侧依据，缺对照」。

### 说明
- 本版 7 个文件改动（`src/app/api/materials/route.ts`、`src/components/canvas/Sidebar.tsx`、`src/lib/agents/profiles.ts`、`src/lib/materials/indexer.ts`、`src/lib/mcp/ledger-compile.ts`、`src/lib/mcp/ledger.ts`、`src/lib/parse/ocr-task-manager.ts`），Electron / screenshot-plugin / MCP server 无改动。
- 取证：`.next/standalone/src/**` 源码快照基线有效（`BUILD_ID` 19:49 = 上一次发布构建），与 mtime 全仓扫描两法完全吻合（7 文件一致）。

## v0.7.609 (2026-09-19)

### 新增
- **Team 两档模型（队长主模型 / 成员次模型）**：Team 分栏新增 `Main model` / `Worker model` 两个下拉，队长（captain）用主模型跑规划与复核整合，全部成员一刀切用次模型；两档均持久化在节点 frontmatter（`team_main_model` / `team_worker_model`），**与节点自身 chat 模型完全隔离、互不写回**。
  - `types.ts` / `node-markdown.ts` / `CanvasFlow.tsx`：`teamMainModel` / `teamWorkerModel` 字段定义、frontmatter 读写（未选择时不写字段，回落默认）与节点数据序列化。
  - `TeamWorkbench.tsx`：启动输入下方新增两个模型下拉（复用节点 chat 模型菜单的模型池），新增 `mainModel` / `workerModel` / `modelOptions` 与 `onSelectMainModel` / `onSelectWorkerModel`。
  - `ChatNodeKernel.tsx` / `nodes/route.ts`：选择状态回写与落盘。
  - `api/chat/route.ts` / `api/chat/tools/index.ts`：请求体新增 `teamMainModel` / `teamWorkerModel`，宿主注入 `team_run` 执行上下文，只读模型池与 frontmatter。
  - `lib/chat/team-run.ts` / `lib/chat/captain-session.ts`：`captainModelRef` 缺失时明确报错；队长会话用主模型、成员 `modelRef` 用次模型一刀切覆盖。

### 说明
- 本版 10 个文件改动（`src/app/api/**`、`src/lib/**`、`src/components/canvas/**`），Electron / screenshot-plugin / MCP server 无改动。
- 取证备注：本轮 `.next` 曾于 18:36 被重新构建（`BUILD_ID` 时间戳晚于上一次发布构建），源码快照基线失效，改用 mtime 全仓扫描 + 新字面量（`team_main_model` / `team_worker_model`）在旧包中为零的方式交叉确认改动面。

## v0.7.608 (2026-09-19)

### 新增
- **品牌 logo 自定义贯通侧边栏**（`canvasHooks.ts` / `CanvasFlow.tsx` / `SettingsModal.tsx` / `ShareCard.tsx`）：
  - 新增 `useBrandLogo()` hook：读 `settings.brandLogo`（头像池 id）→ 解析出对应 `dataUrl`；未设置 / 条目失效（删除或换机）/ 非桌面环境一律回落默认 `hippo-icon.png`，不出现空白图标。
  - 新增 `brand-logo-changed` 广播事件与 `notifyBrandLogoChanged()`：设置面板保存后、分享卡应用 logo 后均发出，侧边栏底部图标**即时跟随**（无需重启或重挂载）。
  - `CanvasFlow` 侧栏底部两处品牌图标（Settings 入口 / 工具条）改用 `brandLogo.src`：默认图标继续用 `mixBlendMode: multiply` 融掉不透明白底，自定义头像自带 alpha 则直接叠加。

### 说明
- 本版仅 4 个文件改动（均在 `src/components/canvas/`），Electron / screenshot-plugin / MCP server 无改动。

## v0.7.607 (2026-09-19)

### 优化
- **BobMail 详情头部改为「QQ 邮箱式」布局**（`WantedNoticeCenter.tsx`）：
  - 第一行：⭐ + 主题大字（字重 900 → 800）+ 右侧动作工具栏（Focus / 邮件动作集中一处）；
  - 第二行：分类徽章 · 发件人 <邮箱> · 时间 · 线程数 · 已归档，由多行堆叠压缩为单行元信息（`·` 分隔，超出自动换行）；
  - 移除独立头像（`avatarEl`）与信封头两栏结构，头部更紧凑。
- **用户指南全面更新**（`assets/skills/user-guide/SKILL.md`）：
  - 新增章节：项目账本（Project Ledger）、Agent Teams 团队协作、思维导图（Buzan）；
  - 左栏说明重写为「入口列表」（搜索框 / Project board / Local files / Browser / 插件面板 / Templates / Markdown / BobMail / Settings），补充折叠为窄图标栏；
  - 会话列表改为按创建时间降序，行尾 `⋯` 菜单（重命名 / 删除）；
  - 会话类型表更正：内置仅 Chat / Coding，其余（Kar / Butler / Buzan / Archivist / Legal Intern / Legal Reviewer）需在 Extensions Store 安装；
  - MANDATORY TRIGGERS 扩充（项目账本、档案员、团队协作、Agent Teams、思维导图、快捷键）。

### 说明
- 本版仅 2 个文件改动，Electron / screenshot-plugin / MCP server 无改动。

## v0.7.606 (2026-09-18)

### 优化

* **下划线批注的文字气泡锚到「划线结束处」，越界自动左移（`components/screen-ocr/ScreenOcrEditor.tsx`）**：此前气泡固定左对齐在**横线左端**，从左往右划时气泡落在线的起点而非松手位置，与输入时所见不一致。
  * `Mark` 的 `underline` 变体新增可选字段 `textX`（文字气泡锚点，图像像素）；新增 `underlineTextX(ctx, m, value)` 统一计算锚点——取 `m.textX`，缺省回退 `m.x + m.w`（线尾）；有文字时把结果夹在 `[左内边距, 图宽 − 气泡宽 − 右内边距]` 之间，保证气泡**右边缘不出图**、不出现半截气泡。
  * **落定**：新建下划线批注时写入 `textX = Math.round(d.x)`（即松手点），与落定前输入框位置一致。
  * **输入框**：下划线松手后输入框的 x 由「横线左端」改为 `d.curX`——左往右划锚在右端、右往左划锚在左端，即松手那一端。
  * **绘制与命中**：`renderMarks` 与 `hitTestMark` 均改用 `underlineTextX(...)` 定位气泡，命中范围与视觉保持一致；整体拖动时 `textX` 随 `x` / `y` 同步偏移（`from.textX === undefined` 时保持 `undefined`，历史数据仍回退线尾）。
  * 顺带把 `drawTextBubble` 的 JSDoc 由「半透明深底」更正为「白底」（上一版误留的旧描述）。

### 说明

* 本次仅 `components/screen-ocr/ScreenOcrEditor.tsx` 一个文件改动（源码快照 `diff` 与全仓 mtime 双向交叉验证一致），Electron / screenshot-plugin / MCP 包 / 依赖均未变动。

***

## v0.7.605 (2026-09-18)

### 优化

* **截图编辑器批注文字改为「白底红字气泡」，命中 / 选中 / 输入三处几何统一（`components/screen-ocr/ScreenOcrEditor.tsx`）**：批注文字（`text` 标注与下划线标注的文字）由「裸文字」改为「白色实心圆角矩形 + 标注红字」的气泡，贴近 PDF 批注便签观感，红字在白底上最清晰。
  * 新增常量 `MARK_TEXT_BG = '#FFFFFF'` 与四个几何辅助：`textBubblePadding(fontSize)`（内边距 / 圆角按字号比例缩放，最小 4 / 3 / 3 px，保证不同分辨率截图观感一致）、`roundRectPath(...)`（手写圆角矩形，不依赖 `ctx.roundRect` 的运行时支持）、`textBubbleRect(...)` 与 `drawTextBubble(...)`（气泡矩形计算与绘制，返回矩形供选中框复用）。
  * **命中检测**：`text` 与 `underline` 的文字命中范围由「文字外扩 3px 的粗略矩形」改为按气泡矩形判定，点到底色边缘也能选中；下划线标注在 `m.value` 为空时不再做无意义的文字命中判定。
  * **选中框**：`text` 直接复用气泡矩形并外扩 2px；`underline` 由「横线宽与文字宽取最大」改为「横线范围与气泡矩形的并集」，横线较长或文字很窄时不再被裁切。
  * **输入草稿框**：`left` / `top` 按内边距外扩、`width` 加上左右内边距、`padding` 与气泡一致、圆角与底色同步（`rgba(255,255,255,0.92)` → 实心白），新增 `draftPad` 一处计算供渲染复用——保证「打字时所见 = 落定后所见」。

### 说明

* 本次仅 `components/screen-ocr/ScreenOcrEditor.tsx` 一个文件改动（源码快照 `diff` 与全仓 mtime 双向交叉验证一致），Electron / screenshot-plugin / MCP 包 / 依赖均未变动。

***

## v0.7.604 (2026-09-18)

### 说明

* **无代码变更的重发版本（内容与 v0.7.603 一致）**：构建前取证确认自 v0.7.603 产出（2026-09-18 16:02）以来工作区**零改动**——`diff -rq .next/standalone/src src` 无 `Files differ`；`electron/` 与包内基线逐文件比对无差异；全仓 `find -newermt <v0.7.603 ZIP>`（排除 `node_modules` / `.next*` / `release-dist`）命中 **0 个文件**。本次按用户要求原样重打一版，代码与 v0.7.603 完全相同，仅递增版本号以保持发布序列连续。

***

## v0.7.603 (2026-09-18)

### 新增

* **账本自检前移到索引刷新路径：索引头直接带「⚠️ 自检」摘要（`lib/mcp/ledger.ts` / `app/api/chat/tools/ledger.ts`）**：机械自检（lint）由「等 AI 想起来手动跑 `ledger_lint`」改为「每次索引刷新顺带跑」，结果摘要写进 `index.md` 头并随 `read_ledger` 索引形态一起返回，读取方第一眼就能看见账本问题。修账本的是 AI（它才有账本工具），不能指望人记得手动跑自检。
  * `lib/mcp/ledger.ts`：`refreshLedgerIndex` 返回类型 `void` → `string[]`（返回本次自检的问题行）；新增索引摘要行前缀常量 `LINT_SUMMARY_PREFIX = '⚠️ 自检'`；索引头在有问题时插入一行 `${LINT_SUMMARY_PREFIX} N 项待处理：<前 2 项，每项截 48 字符>；…（ledger_lint 看全部）`，无问题则不插入；`readLedgerIndex` 返回值新增 `lint: string[]` 字段。**属事件驱动**（写入 / 材料登记都会刷新索引），不引入定时器、不增加 token 开销。
  * 自检函数拆分以避开循环依赖：原 `lintLedger` 主体改为内部 `collectLintIssues`（**不含**「索引与文件一致性」检查）；新的 `lintLedger` = `collectLintIssues` + 索引一致性比对。原因是索引头要写自检摘要 → `refreshLedgerIndex` 必须调用自检函数，若自检函数再回调 `refreshLedgerIndex` 即死循环，故该项留在 `lintLedger`。索引一致性比对时按 `LINT_SUMMARY_PREFIX` **整行剔除**自检摘要行，避免「问题数变化」被误判为「有人手改索引」。
  * `app/api/chat/tools/ledger.ts`：`read_ledger` 索引形态输出新增 `lintLine`——有账本问题时在索引头下方追加 `⚠️ 自检 N 项待处理：<前 3 项，每项截 60 字符>[ 等 N 项]（机械检查结果，跑 ledger_lint 看全部并修正）`；`ledger_lint` 的工具注释补充「同一套检查在每次索引刷新时也会跑，本工具用于看全部明细」。

### 优化

* **Archivist 准则 8 调整为「不做定期巡检」（`lib/agents/profiles.ts`）**：原「定期 `ledger_lint` 自检并修正它报出的问题」改为「**不做定期巡检**」——理由是项目资料量小、变更低频，定期跑属空转；改为「材料更新后的下一次任务里顺手看一眼索引标注即可（待编译 / 需复核在索引行上就写着）」。与上条配套：自检结果现在**常驻索引**，无需 AI 主动调度。

### 说明

* 自检摘要行只在**有问题时**写入索引，无问题的账本索引字节不变，不会引入 write-on-read 或额外写盘竞争。
* 无新增 API 路由；无依赖变更。
* 固有问题（本轮未清理，留待后续）：`lib/mcp/ledger.ts` 文件末尾无换行；`BobbyAuthHost` 授权成功分支未清理 `promptedRef`；`ChatNodeKernel` 流式中会丢弃 `bobby:granted` 且 `pendingGrantTargetRef` 已被清空；`ScreenOcrEditor` 保留（并扩充了）`[ocr-perf]` 埋点 `console.log`；`lib/mcp/ledger.ts` 的 `listLedgerHistory` / `restoreLedgerEntry` 尚无调用方；`app/api/nodes/route.ts` 中描述附件落盘的注释与新 `attachments/` 行为不一致；`electron/main.ts` 保留 `[ocr-geom]` 诊断日志；`screenshot-plugin/build-helper.sh` 的 plist 版本仍硬编码 `1.0.0`，与 `main.ts` 的 `1.0.9` 双轨不一致。
* 本轮共 3 个文件修改（`lib/mcp/ledger.ts` / `app/api/chat/tools/ledger.ts` / `lib/agents/profiles.ts`），无新增 / 删除文件；Electron / Swift 侧无改动。

***

## v0.7.602 (2026-09-18)

### 新增

* **账本体系重构：新增 Archivist（档案员）Agent 接管项目账本（`lib/agents/profiles.ts` / `lib/agents/official-packages.ts` / `lib/agents/market-server.ts` / `app/api/chat/tools/registry.ts` / `lib/mcp/ledger-compile.ts` / `components/canvas/CanvasFlow.tsx` / `components/canvas/AgentStorePanel.tsx`）**：账本从「Butler 兼管」升级为专职场景，Butler 账本能力降为只读并引导用户转向 Archivist。
  * `profiles.ts`：新增 `ARCHIVIST_CORE_EXCLUSIONS`（剔除 `read_file` / `write_file` / `edit_code` / `rename_file` / `delete_file` / `list_directory` / `search_files` / `run_command` / `execute_script` / `web_search` / `web_fetch`）；新增超长 `ARCHIVIST_BASE_SYSTEM_PROMPT`（档案员定位、事实分级与来龙去脉记录纪律、观点体检职责、越界引导）；`BUTLER_BASE_SYSTEM_PROMPT` 改写——账本改为只读，遇账本诉求引导用户转 Archivist。
  * `official-packages.ts`：新增官方市场包 `id: 'archivist'`、`name: 'Archivist'`、`version: '1.0.0'`、`fixedScenes: ['general', 'node', 'ledger', 'ledger-keeper']`、`coreExclusions: [...ARCHIVIST_CORE_EXCLUSIONS]`、`prompt: ARCHIVIST_BASE_SYSTEM_PROMPT`；Butler 的 `fixedScenes` 由 `[..., 'ledger-keeper']` 收为 `['general', 'node', 'butler', 'ledger']`。
  * `market-server.ts`：同步注释（`ledger-keeper` 场景改标注「仅档案员」）。
  * `ledger-compile.ts`：账本自动编译的署名身份由硬编码 `'butler'` 改为动态 `resolveCompileIdentity()`——解析实际安装的档案员身份；未安装 `archivist` 包时整轮编译跳过且只告警一次。
  * `CanvasFlow.tsx`：右键菜单新增 `archivist` 项——图标 `Archive` + `var(--teal)`，`AGENT_LABELS.archivist = 'Archivist'`；删除遗留的 `bobby:trigger` 监听。
  * `AgentStorePanel.tsx`：`SCENE_FILTERS` 新增 `{ key: 'ledger', label: 'Ledger' }`。

* **新工具 `ledger_challenge`（观点体检）与账本条目增强（`app/api/chat/tools/ledger.ts` / `app/api/chat/tools/registry.ts` / `lib/mcp/ledger.ts`）**：账本从「记录事实」扩展到「双面取证 + 结论保鲜」。
  * `ledger.ts`（工具层，+254 行）：新增 `ledger_challenge`——对指定观点做确定性双侧检索（`extractClaimKeywords` 抽关键词，`CHALLENGE_MATERIAL_MAX = 20` 条材料、`CHALLENGE_SNIPPET_MAX_CHARS = 200` 字符摘录），并按 `SIDE_FALLBACK_LABEL`（`ours` = 我方 / `theirs` = 对方 / `neutral` = 中立）对称呈现，倾向性结论会标注需复核。`ledger_record` 扩参 `origin` / `statedBy` / `statedAt` / `type`；输出新增 `· 需复核` 与 `⚠️ 需复核：…` 标记。
  * `registry.ts`：`ledger_challenge` 仅开放给 `ledger-keeper` 场景（即 Archivist）。
  * `lib/mcp/ledger.ts`（+548 行）：新增类型 `LedgerSide = 'ours' | 'theirs' | 'neutral'`、`FactOrigin = 'material' | 'user' | 'external'`、`LedgerTypeDef` 与内置类型 `BUILTIN_LEDGER_TYPES`（`fact` / `entity` / `issue` / `comparison` / `analysis` / `note`）；`LedgerItem` 新增 `side` / `origin` / `statedBy` / `statedAt` / `type` / `stale` / `staleReason`；新增版本快照（`HISTORY_MAX = 20`、`snapshotEntry`、tmp + rename 原子写、`listLedgerHistory` / `restoreLedgerEntry`）；新增结论过期标记 `markStaleByRaw`；SCHEMA 幂等迁移「当事人与材料分区」「条目类型」；`lintLedger` 新增检查 8–13。

* **截图编辑器：下划线批注 + 多屏几何透传与吸附（`components/screen-ocr/ScreenOcrEditor.tsx` / `components/screen-ocr/ScreenOcrHost.tsx` / `app/ocr-editor/page.tsx` / `lib/desktop-adapter.ts`）**：截图批注新增「划线 + 就近写备注」的标注方式，并让编辑器坐标基准精确对应到截图命中的那块屏。
  * `ScreenOcrEditor.tsx`（+174 行）：新增下划线批注——工具枚举 `Tool` 增加 `'underline'`、标注 `Mark` 增加 `{ kind: 'underline', … }`、新增 `TextDraft`（划线后就近输入文字）、`MIN_UNDERLINE = 16`（短于阈值的不落笔）、`drawUnderline` 绘制；工具条按钮 tooltip 为 `Underline: drag a line, then type the note right below it`。新增多屏基准 `viewBase`——按 `screenIndex` 取单屏几何，缺失时退回全屏并集；缩放基准随之重写。
  * `desktop-adapter.ts` / `app/ocr-editor/page.tsx` / `ScreenOcrHost.tsx`：三条路径（首屏拉取、常驻窗口新截图、页面渲染）统一新增 `screenIndex?: number | null` 透传。

* **截图链路：窗口几何缓存与按屏定位（`electron/main.ts` / `electron/preload.ts` / `screenshot-plugin/ScreenshotHelper.swift`）**：主进程向 Swift 助手索取屏幕 / 窗口几何并缓存，截图后按命中屏定位编辑窗。
  * `ScreenshotHelper.swift`：新增 `windows` action——输出 `screens`（各屏几何）、`regions`（`menubar` / `dock`）与 `windows`（`CGWindowList` front-to-back）；`fullscreen` 改用 `screencapture -x -o -t jpg -D <targetIdx + 1>` 抓取单屏（`-D` 为 1-based 屏序号），并把命中屏回写为 `screen`（`-1` 表示并集）；`skipOwners` **移除 BobWork 自身**（现为 `["BobWorkCapture", "BobWork Capture", "BobWork Capture Dev", "Window Server", "Dock"]`）。
  * `main.ts`（+144 行）：新增 `screenGeometryCache` 与 `fetchScreenGeometry`（向助手写 `request.json = {"action":"windows"}` 拉取几何）；`createOcrEditorWindow` / `openScreenOcrEditorWindow` 改用 `ocrEditorBoundsFromGeometry(screenGeometryCache, shot.screenIndex)` 按命中屏定位；建窗新增 `enableLargerThanScreen: true`；**截图期间主窗口不再 `setOpacity(0)` 隐藏**；`CaptureHelperResult` 新增 `screenIndex`，`parseResult` 读取 `result.json` 的 `screen` 字段；`CAPTURE_HELPER_VERSION` 由 `'1.0.6'` 升至 `'1.0.9'`。
  * `preload.ts`（+4 行）：`ScreenOcrCapturedPayload` 与 `getEditorShot` 的返回值新增 `screenIndex?`。**未新增 IPC 通道。**

* **分享卡 / 文档图片可拖拽改尺寸（`components/canvas/extensions/ResizableImage.ts`（新增） / `components/canvas/DocEditor.tsx` / `components/canvas/ShareCard.tsx` / `app/globals.css` / `lib/sanitize-whitelist.ts` / `lib/md-export/ir.ts`）**：图片从固定宽度变为可拖拽缩放，并保证 Markdown 与导出链路兼容。
  * `ResizableImage.ts`（新增）：基于 `Image.extend({ addStorage() { return { markdown: { serialize } } } })` 实现自定义序列化——尺寸为 0 时输出标准 `![alt](src "title")`，有尺寸时输出 `<img src alt width>`；`createResizableImage()` 配置 `resize: { directions: ['left', 'right'], minWidth: 60, alwaysPreserveAspectRatio: true }`。
  * `DocEditor.tsx` / `ShareCard.tsx`：图片节点由 `Image` 换成 `createResizableImage()`；`ShareCard` 容器新增 `className="bw-share-card"`。
  * `globals.css`：拆分 `.html-renderer img` 规则；新增分享卡 / 文档图片的拖拽手柄样式（`[data-resize-handle]` 左右手柄、`ew-resize` 光标、只读态隐藏）。
  * `sanitize-whitelist.ts`：`img` 标签放行 `width` 属性。`lib/md-export/ir.ts`：新增 `imgFromHtml`（只取 `src` / `alt`，不取 `width`，保证导出排版不被内联尺寸干扰）。

* **图片粘贴落盘分流：新增 `attachments/` 存储位（`components/canvas/composer/useComposer.ts` / `app/api/attachments/route.ts` / `lib/types.ts`）**：整批粘贴的截图与主动上传的素材分开存放。
  * `lib/types.ts`：新增 `export type AttachmentStore = 'materials' | 'attachments';`。
  * `useComposer.ts`：`uploadAttachment(nodeId, nodeTitle, file, store: AttachmentStore = 'materials')` 与 `handleFileSelect(files, opts?: { store?: AttachmentStore })` 新增存储位参数；**粘贴整批图片时以 `store: 'attachments'` 落盘**，其余保持 `materials`。
  * `attachments/route.ts`：JSON 分支读取 `store`（`'attachments'` / 默认 `'materials'`），落盘目录随之变化。

* **Bobby 授权宿主全局化（`components/bobby/BobbyAuthHost.tsx`（新增） / `app/layout.tsx` / `components/canvas/BobbyNode.tsx` / `components/canvas/ChatNodeKernel.tsx`）**：Bobby 的授权 / 权限 / 急停交互从画布节点迁出，改为全局浮层宿主，节点关闭后授权流程不再中断。
  * `BobbyAuthHost.tsx`（新增）：全局授权宿主——轮询 `/api/bobby`（已启用 5s / 未启用 30s）；`TEMP_ALLOW_MS = 30 * 60 * 1000`（临时放行 30 分钟）、`REJECT_COOLDOWN_MS = 60 * 1000`（拒绝后 60 秒冷却）；授权成功后广播 `bobby:granted`。
  * `app/layout.tsx`：挂载 `<BobbyAuthHost />`。
  * `BobbyNode.tsx`：删除节点内的自动授权弹窗 effect 与 `promptedRef` / `askChoices`。
  * `ChatNodeKernel.tsx`：`grant_required` 分支新增广播 `bobby:grant-required`；新增 `archivist` 身份图标；`handleSaveAsAttachment`（落盘 `materials/note-*.txt`）改为 `handleQuoteSelection`（仅引用选中内容，不再落盘）。

* **XhsCard 清洗链剔除残留图片标签（`components/canvas/XhsCard.tsx`）**：清洗链新增 `.replace(/<img\b[^>]*>/gi, '')`，避免内联 `<img>` 在小红书卡片文本里露成源码。

* **AI 修订后视口停留改动处（`components/canvas/DocEditor.tsx`）**：新增 `posAtTextIndex()`（文本下标 → 文档位置）与 `justAppliedAnchorRef`，AI 应用修订后把视口滚动定位到实际改动处，不再跳回文首。

### 修复

* **截图编辑器坐标基准纠正（`components/screen-ocr/ScreenOcrEditor.tsx`）**：多屏环境下编辑器此前按「全屏并集」换算，命中单屏时标注与吸附位置整体偏移；本轮改为按 `screenIndex` 取单屏几何作 `viewBase`，并重写缩放基准，修掉单屏截图的坐标错位。
* **主窗口截图中断操作（`electron/main.ts`）**：截图期间不再 `setOpacity(0)` 隐藏主窗口，用户在多屏场景下可参照主窗口内容完成标注。

### 说明

* **破坏性变更：Butler 失去账本写权限**（`lib/agents/profiles.ts` / `lib/agents/official-packages.ts`）：账本读写归 Archivist（`ledger-keeper` 场景），Butler 的 `fixedScenes` 不再含 `ledger-keeper`，其系统提示改为只读并引导用户转向 Archivist。**已在用 Butler 管账本的用户，需在 Extensions Store 安装 Archivist 才能继续写入账本。**
* **行为级变更：未安装 Archivist 时账本自动编译静默停止**（`lib/mcp/ledger-compile.ts`）：编译身份改为动态解析，解析不到档案员时整轮跳过、仅告警一次（不再回退到 Butler 署名），旧环境可能观察到账本不再自动更新。
* **行为级变更：截图画面现在包含 BobWork 自身**（`screenshot-plugin/ScreenshotHelper.swift`）：`skipOwners` 移除了 BobWork 相关 owner，整屏截图中 BobWork 窗口不再被系统排除。
* **行为级变更：覆盖窗口几何语义变化，可能触发助手重装 / 重索权限**：`CAPTURE_HELPER_VERSION` 由 `'1.0.6'` 升至 `'1.0.9'`，首次启动会重新编译 / 替换截图助手；macOS 可能再次弹出屏幕录制权限请求，属预期行为。
* 新增 `attachments/` 存储位为独立目录；旧数据仍留在 `materials/`，不做迁移。
* 无依赖变更。
* 固有问题（本轮未清理，留待后续）：`BobbyAuthHost` 授权成功分支未清理 `promptedRef`，同一 target 二次授权可能静默卡住；`ChatNodeKernel` 流式中会丢弃 `bobby:granted` 且 `pendingGrantTargetRef` 已被清空，与上条叠加存在死锁风险；`ScreenOcrEditor` 保留（并扩充了）`[ocr-perf]` 埋点 `console.log`；`lib/mcp/ledger.ts` 的 `listLedgerHistory` / `restoreLedgerEntry` 尚无调用方（功能未接线）；`app/api/nodes/route.ts` 中描述附件落盘的注释与新 `attachments/` 行为不一致；`attachments/route.ts` 的 `store` 参数仅在 JSON 分支生效，`formData` 分支仍固定落 `materials`；`electron/main.ts` 保留 `[ocr-geom]` 诊断日志，且 `fetchScreenGeometry` 与用户快捷键存在竞态；`screenshot-plugin/build-helper.sh` 的 plist 版本仍硬编码 `1.0.0`，与 `main.ts` 的 `1.0.9` 双轨不一致；`app/api/chat/tools/ledger.ts` 文件末尾无换行。
* 本轮共 29 个文件修改、2 个文件新增（`components/bobby/BobbyAuthHost.tsx`、`components/canvas/extensions/ResizableImage.ts`），另有 `electron/main.ts`、`electron/preload.ts`、`screenshot-plugin/ScreenshotHelper.swift` 三个 Electron / Swift 侧文件修改；`types/global.d.ts` 为上一版构建快照未追踪的旧文件，非本轮新增。

***

## v0.7.601 (2026-09-18)

### 新增

* **Bob-Mind（Buzan）专职化：思维导图能力独立成节点（`lib/agents/profiles.ts` / `lib/agents/official-packages.ts` / `lib/agents/market-server.ts` / `app/api/chat/tools/index.ts` / `components/canvas/CanvasFlow.tsx`）**：mind 能力从「随 general 常驻注入」改为专属场景，与 Kar（notebook）同款治理，普通对话不再背 mind 工具。
  * `profiles.ts`：`AgentId` 新增 `mind: 'mind'`；新增 `MIND_CORE_EXCLUSIONS`（剔除 `read_file` / `write_file` / `edit_code` / `rename_file` / `delete_file` / `list_directory` / `search_files` / `run_command` / `execute_script` / `web_search` / `web_fetch`）；新增 `MIND_BASE_SYSTEM_PROMPT`——Buzan 的专项系统提示（定位「捕获 · 组织 · 回忆」、伙伴立场而非被动速记、工具清单与面板/AI 分工边界、8 条行为准则：有话直说 / 意见与数据分离 / 先摸底知主题 / 先查后写 / 结构纪律 / 删除须明确指示 / 以工具真实返回为准 / 越界引导）。
  * `official-packages.ts`：新增官方市场包 `id: 'mind'`、`name: 'Buzan'`、`version: '1.0.0'`、`fixedScenes: ['general', 'node', 'mind']`、`coreExclusions: [...MIND_CORE_EXCLUSIONS]`、`prompt: MIND_BASE_SYSTEM_PROMPT`（安装时物化为 `agents/mind/agent.json`）。
  * `market-server.ts`：`ALLOWED_AGENT_SCENES` 在 `'notebook'` 后新增 `'mind'`。
  * `tools/index.ts`：`ToolScene` 末尾新增 `'mind'`；`'bob-mind-mcp'` 的场景由 `['general']` 改为 **`['mind']`**——这 8 个 mind 工具只给 Buzan 画像注入。
  * `CanvasFlow.tsx`：右键菜单新增 `mind` 项——图标 `Network` + `var(--purple)` / `var(--purple-soft)`，`AGENT_MENU_LABELS.mind = 'Buzan'`。

* **Bob-Mind 面板改动回流：Buzan 能看见你在面板里改过什么（`app/api/chat/route.ts` / `components/canvas/PluginPanelFrame.tsx` / `components/canvas/ChatNodeKernel.tsx` / `lib/wanted/node-chat.ts`）**：面板是回合制的，用户在插件面板手改导图不会推送；本轮打通「面板 → 宿主 → Buzan」的单向回流与未回看角标。
  * `route.ts`：新增 `MIND_PANEL_URL`（从 `MCP_PRESETS` 取 `bob-mind-mcp` 的 `panel.url`）与 `buildMindChangesInjection(agentId)`——仅当本轮是 mind agent 时 `GET <panel>/api/changes?consume=1`（2s 超时、`cache: no-store`），取最后 12 条渲染为 `- added / edited / deleted / moved / starred: <title>`（`title` 截 60 字符），整块超 800 字符截断加 `…`；非空才 `prependDynamicContext` 注入本轮 user 消息（不进 system，保持缓存头字节稳定）；插件未运行 / 非 2xx / 超时一律静默返回空串，绝不阻塞对话。system prompt 能力表新增「想法/灵感/思维导图」引导行。
  * `PluginPanelFrame.tsx`：新增 `iframeRef` 与 `message` 监听（校验 `event.source === frame.contentWindow`），把插件面板发来的 `bob_mind_ask` / `bob_mind_changes` 转成宿主窗口事件 `bob-mind-ask` / `bob-mind-changes`，插件拿不到宿主内部对象。
  * `ChatNodeKernel.tsx`：`identity === 'mind'` 时监听这两个事件——`bob-mind-changes` 取 `detail.count` 更新角标；`bob-mind-ask` 在非流式时经 `sendTextRef` 自动发一轮「（系统自动）我在 Bob-Mind 面板刚改过导图，请先 mind_query 看最新状态，再就我的改动表态（赞同/反对 + 理由）」。头部新增 Bob-Mind 角标（`Pencil` 图标 + 计数，`> 9` 显示 `9+`，tooltip 为 `Bob-Mind was edited N time(s) and Buzan hasn't reviewed it yet`）。
  * `node-chat.ts`：临时问答提示词补 mind 能力说明——自 2026-09-17 起收归画布「Mind（Buzan）节点」专职承载，本临时问答不注入 `mind_*`，引导用户打开 Mind 节点（需先在 Extensions Store 安装 Buzan 并启用 `bob-mind-mcp`）。

* **截图 OCR：窗口吸附（`components/screen-ocr/ScreenOcrEditor.tsx` / `components/screen-ocr/ScreenOcrHost.tsx` / `app/ocr-editor/page.tsx` / `lib/desktop-adapter.ts`）**：整屏截图链路上，鼠标悬停即高亮窗口 / 菜单栏 / Dock，单击或 Tab 直接选中整个窗口（微信电脑版式）。
  * `desktop-adapter.ts`：新增 `ScreenOcrScreenRect` / `ScreenOcrRegionRect` / `ScreenOcrWindowRect` / `ScreenOcrGeometry` 类型与 `ScreenOcrShotPayload`（`dataUrl` + `mode?` + `geometry?`）；`onCaptured` / `onNewShot` / `getEditorShot` 的签名改用该载荷。
  * `ScreenOcrHost.tsx` / `app/ocr-editor/page.tsx`：新增 `geometry` state 并透传给 `ScreenOcrEditor`（三条路径：首屏拉取、常驻窗口新截图、页面渲染）。
  * `ScreenOcrEditor.tsx`：新增 `SnapTarget` 与 `snapTargets`（`useMemo`）——主进程给的窗口 / 区域是 CG 点坐标，按「屏幕并集 ↔ 整屏图」的 `kx/ky` 系数换算为图像像素；窗口顺序沿用 `CGWindowList` 的 front-to-back，命中检测窗口优先、其次菜单栏 / Dock。新增 `hoverTarget` / `hitTarget` / `selectTarget`；`onPointerUp` 增加 `moved < 6` 的点击选中（一次点击选中整个目标）；新增 `onRootPointerMove` 做 hover 高亮（仅 `select` 工具且未拖拽时）；键盘新增 **Tab 轮换吸附**（在窗口 / 菜单栏 / Dock 间循环并即时选中）。缩放基准放宽为 `likeFull = !!geometry || 图宽 ≥ 窗口宽 || 图高 ≥ 窗口高`，避免单位不一致时画面被强制缩半。标注色 `MARK_COLOR` 由 `#ff5252` 改为微信电脑版的 `#FA5151`；`drawArrow` 按图宽标定重写（`MARK_GEOM_BASE_W = 3024`；杆粗 `max(3, 8k)`、头长 `min(len × 0.55, max(22, 44k))`、底宽 `0.46 × 头长`），修掉 Retina 整屏图上箭头过细的问题。文案：`菜单栏` / `Dock 栏`。

* **打印排版：改为中文出版惯例（`components/canvas/DocEditor.tsx` / `app/globals.css`）**：导出的纸张输出从网页式排版改为可交付的文档排版。
  * `globals.css`：新增 `@page { size: A4; margin: 25.4mm 25mm 25.4mm 30mm }`（上下 25.4mm、右 25mm、左 30mm 留装订边）。
  * `DocEditor.tsx`：打印 CSS 重写——`#doc-print-root` 内边距归零（避免与 `@page` 叠加）、正文纯黑（`#111` → `#000`）；正文改为五号（`10.5pt`）/ 1.5 倍行距 / 两端对齐 / `orphans`·`widows: 2` / 段首缩进 `2em`（列表、引用、表格、脚注、图注内清零）；`h1`~`h4` 改用无衬线黑体族（三号 16pt / 四号 14pt / 小四 12pt）并加 `break-after: avoid-page`（标题不落单在页底）；表格改为三线表（9pt、顶线/底线 `1.2pt`、表头下线 `0.8pt`、去灰底/隔行底色/竖线）；块级 `break-inside: avoid` 分页保护。

* **新增单元测试与全局类型声明（`lib/__tests__/docx-numbering.test.ts` / `lib/__tests__/node-markdown.test.ts` / `lib/pdf/__tests__/text-search.test.ts` / `types/global.d.ts`）**：
  * `docx-numbering.test.ts`：DOCX 编号模型回归——`chineseNumbering` / `letterNumbering` / `formatCount` / `substituteLvlText` / `NumberingCounter`。
  * `node-markdown.test.ts`：节点 Markdown 解析与追加回归——`question` 块开头的 META / ATTACHMENTS 注释必须完整剥净且与顺序无关（旧 bug：解析按相反顺序各剥一次，导致 ATTACHMENTS 注释残留、前端以纯文本渲染时露出 JSON / 文件路径）。
  * `pdf/__tests__/text-search.test.ts`：PDF 文本检索——`buildPageText` / `buildOcrPageIndex` / `findMatches` / `matchToRects` / `contextAround` / `excerptAround` / `searchOcrPages` / `searchPageIndexes` / `splitOcrPagesFromText` / `looksLikeScannedPdf`（含 scale=1、rotation=0 的 pdfjs 视口 y 翻转基准）。
  * `types/global.d.ts`：声明 `Window.api`（`parse` / `update` / `settings` / `screenOcr` / `hippoBrowser` / `getPathForFile` / `openFile` / `openHtml` …）与三个事件缓冲 `__pendingNodeAttachments` / `__pendingNodeReference` / `__pendingNodeTasks`。

### 修复

* **插件面板残留进程回收收紧，修掉「面板变 unreachable」的误杀（`lib/plugin-panels-server.ts`）**：原逻辑只要冲突标记的写入者存活就回收占用者，会把另一个仍在运行的合法宿主（同时开着的打包版 App / 另一个 dev 服务）杀掉，两个宿主互相抢杀导致面板来回失效。本轮新增 `processParentPid`（`ps -o ppid= -p <pid>`，2s 超时）与 `isReapableStaleHolder`——只回收 `ppid === 本进程 pid`（本宿主重复 spawn 留下的旧一代）与 `ppid === 1`（宿主崩溃后 reparent 到 launchd 的孤儿），不认识的占用者一律不碰。同时收紧冲突判定：要求 `holderPid` 可查且 `holderPid !== conflict.pid`，自指标记（插件回收上一代并重绑成功后残留的脏标记）不再被信任，退回直连探测。
* **bobby MCP 断链修复（`lib/mcp/types.ts`）**：`args` 由硬编码 `/Users/baolei/Desktop/BobAgent/bobby-mcp/dist/cli.js` 改为 `['{BUNDLED}:bobby-mcp/dist/cli.js']`，交由 server 端 `bundledPluginPath` 按运行环境解析（安装版 `<cwd>/bobby-mcp/dist/cli.js`，dev 模式仓库根 `<root>/bobby-mcp/dist/cli.js`）——原绝对路径指向的工作区已迁移为 BobWork，永久失效。同处更新 `bob-mind-mcp` 工具清单注释（新增 `save_tree` / `export`）。
* **BobMail 收件箱布局修复（`components/canvas/WantedNoticeCenter.tsx`）**：标题栏删除 `· N pending` 计数，并在有详情时内嵌 `Previous (K)` / `Next (J)` / `Collapse detail (Esc)` 三枚无边框按钮与竖分隔线；左栏把「搜索栏 / INBOX 分区栏 / 类别筛选栏」三行合并为一行（搜索 placeholder 由 `Search title / body / tag…` 改为 `Search…`，类别 pills 不换行、超出横向滚动，`All` 兼作收件箱总数 `inboxVisibleCount`）；`CollapsibleSection` 移除 `tagBar` prop，收件箱列表不再包分区（仅 ARCHIVE 仍可折叠）；右栏删除独立详情顶栏、删除空态插画与快捷键胶囊（`Select a message to preview` / `Choose a conversation from the left inbox.` / `Chat threads are preserved forever — no 15-minute TTL.` / `J / K`、`E`、`S` 提示），详情缺失时右栏留空。

### 说明

* **破坏性变更：文件自动整理「置信度下限（Confidence Threshold）」整项下线**（`lib/settings.ts` / `components/canvas/SettingsModal.tsx` / `lib/file-organizer/watcher.ts`）：删除 `DEFAULT_MIN_CONFIDENCE`（0.6）、`normalizeMinConfidence()` 与 `FileOrganizeSettings.minConfidence`；设置面板移除该下拉及说明文案（`Confidence Threshold` / `Files the AI rates below this go to the pending folder for manual filing.` / `NN% (default)`）；watcher 不再传 `minConfidence`，运行日志由 `（置信度 N%）` 改为 `（判定：<确定 / 存疑 / 无法判断> · <note>）`（改用 `tools/organize/model` 的 `VERDICT_LABEL`）。**旧 `settings.json` 中残留的 `minConfidence` 字段会被忽略，不影响启动。**
* 无新增 API 路由；`/api/chat` 的 mind 改动注入仅在「mind agent + 插件运行中」时有内容，走 `prependDynamicContext` 注入 user 消息（不进 system，缓存头字节稳定）。
* 无依赖变更。
* 固有问题（本轮未清理，留待后续）：`ScreenOcrEditor` 保留了 `[ocr-perf]` 尺寸/缩放埋点 `console.log`；`app/globals.css` 文件末尾无换行；`ChatNodeKernel` 的 Bob-Mind 角标注释称「说话或点 Ask Buzan 后消失」，但实际未在发送时清零计数。
* 本轮共 21 个文件修改、4 个文件新增（含 3 个测试文件）。

***

## v0.7.6 (2026-09-17)

### 新增

* **账本项目页：`p-` 前缀的「要产出的事」（`lib/mcp/ledger.ts` / `app/api/chat/tools/ledger.ts` / `app/api/ledger/document/route.ts` / `components/canvas/LedgerDocPanel.tsx` / `app/api/chat/tools/registry.ts` / `app/api/chat/tools/index.ts` / `lib/agents/profiles.ts` / `lib/runtime/project-brief.ts`）**：账本在既有的 wiki（`w-`）/ raw（`r-`）之外新增第三类条目——**项目页**，用于承载「要产出的事」，形成 idea → outline → draft → done 的创作闭环。
  * **数据层**：新增 `ProjectStage = 'idea' | 'outline' | 'draft' | 'done'`、`PROJECT_STAGES`、`asStage` 与 `ProjectPage` 类型；`nextId` 的 id 前缀由 `'w' | 'r'` 扩为 `'w' | 'r' | 'p'`，`listDir` 的 kind 由 `'wiki' | 'raw'` 扩为 `'wiki' | 'raw' | 'project'`；新增 `projectBodyTemplate`（正文五节：目标 / 知识引用 / 知识缺口 / 工作流 / 产出与回编）、`projectSummary`、`listProjectPages`、`readProjectPage`、`createProjectPage`、`updateProjectPage`。`readLedgerIndex` 返回值新增 `projects`；`readLedgerEntry` 的 id 校验正则由 `^[wr]-` 放宽为 `^[wrp]-`。
  * **校验与工具**：`lintLedger` 新增第 7 类检查「项目页引用断链」；补充条款重新编号（新增第 7 条「项目页」，原第 7/8 条顺延为第 8/9 条），标题改为「对存量账本同样生效」。`ledger` 工具集新增 **`ledger_project`**（`action` 枚举 `list | read | create | update`），并在 `registry.ts` 中归属 `ledger-keeper`；`read_ledger` 的空态判定加上 `index.projects.length === 0`，文本输出新增 `【项目页 wiki/p-…（要产出的事）】` 区块与 `项目页 N 项` 计数。
  * **展示层**：`GET /api/ledger/document` 响应新增 `projects: ProjectPage[]` 与 `projectCount: number`（其余字段不变，`empty` 仍只按 `entries` 判定）；`LedgerDocPanel` 新增 `STAGE_META`（label 为 `Idea` / `Outline` / `Draft` / `Done`），目录与正文改为 `Project pages` / `Compiled knowledge` 两组，状态栏加 `N project page(s)`，空态文案为 `No project pages yet — the Butler opens one per deliverable and moves it idea → outline → draft → done.`。`project-brief.ts` 的空态短路同步加上 `index.projects.length === 0`，简报新增项目页区块（compact 单行；非 compact 逐行输出 `- [stage] title (id)`，最多 8 行）；keeper 的规则新增第 6 条「项目页 = 创作闭环」。

* **笔记页面类型注册表：由 SCHEMA.md 驱动（`lib/mcp/notes-types.ts` / `lib/mcp/notes-bridge.ts` / `app/api/notebook/route.ts` / `app/api/chat/tools/notebook.ts` / `lib/agents/profiles.ts`）**：笔记的页面类型不再由宿主硬编码白名单约束，改由仓库内 SCHEMA.md 注册表定义，新增类型无需改代码。
  * `notes-types.ts` 新增 `NoteTypeDef { key, label, template? }`；`WikiEntryType` 扩入 `'entity'` 与 `'synthesis'`；`WikiEntry.type` 与 `EntryFilter.type` 由枚举放宽为 `string`。
  * `notes-bridge.ts` 的 `NotesBridgeAction` 新增 `'types'`（映射工具 `notes_types`）；`GET /api/notebook?action=types` 新增分支（优先于检索参数解析），成功返回 `{ success: true, ...r.data }`、失败返回 `500 { success: false, error }`。
  * `write_notebook_answer` 删除宿主内置的 4 类白名单校验，`type` 缺省值由 `note` 改为 **`synthesis`**，参数 schema **移除 `enum`**；工具描述补充 `[[note title]]` 合并语义与 SCHEMA.md 页面类型说明。keeper 的笔记分类同步由 4 类扩为 6 类（新增 `entity` / `synthesis`），并新增 `[[笔记标题]]` 双链语法约定。

* **研究结论自动回流：把研究型轮次沉淀为笔记（`lib/nodes/note-ingest-auto.ts`（新建） / `lib/nodes/note-ingest-generate.ts`（新建） / `app/api/nodes/route.ts` / `lib/node-markdown.ts` / `lib/nodes/outcome-generate.ts`）**：节点里发生过检索/读材料的轮次，其结论会被后台自动提炼成 bob-notes 条目，无需手动「写笔记」。
  * **触发器**（`note-ingest-auto.ts`，58 行）：`notifyResearchNoteIngest(filePath, projectRoot)` 挂在节点 append 成功之后（`app/api/nodes/route.ts`），后台异步执行。与既有的 `outcome-auto.ts` 同构（静默窗 + 单飞 + 写盘幂等），两处刻意不同：**不做陈旧上限兜底**，且任务排在 `'compile'` 优先级。静默窗 `QUIET_MS = 15_000`，同一文件重复触发会重置计时器（`timer.unref()` 不阻塞进程退出）。
  * **生成器**（`note-ingest-generate.ts`，262 行）：`generateNotesFromResearch(filePath)` 把「研究型轮次」的结论提炼为条目。**研究型轮次**的判据看落盘 `toolCalls`——命中 `RESEARCH_TOOLS = { web_search, web_fetch, search_materials, read_attachment }`，或本轮 `questionReferences` 携带 `materials/` 路径。**三重去重**：① frontmatter 游标 `note_ingest_turns`（无新轮次直接返回，**零模型调用、零写盘**）；② 模型输出可带 `merge_into`，或标题精确命中既有条目则归并；③ 无研究轮直接返回。
  * 常量：`ANSWER_CAP = 4000` / `BATCH_MAX_TURNS = 10` / `ENTRIES_MAX = 3` / `MATERIAL_WHITELIST_MAX = 40` / `WEB_WHITELIST_MAX = 30` / `TITLE_LIST_MAX = 80`。预检先 `notes('query', { mode: 'index' })` 取既有标题、`notes('types', {})` 取页面类型清单（失败回落 `BUILTIN_NOTE_TYPES` 六类，缺省类型 `synthesis`），再要求模型输出严格 JSON `{"entries":[...]}`，逐条 `notes('backfill', ...)` 落盘后由 `advanceCursor` 推进游标（**不动 `updated_at`**）。提示词 `NOTE_EXTRACT_SYSTEM` 内含 `## 摘要` / `## 要点` / `## 详情` 正文骨架、`[来源: 材料:…]` / `[来源: 网络:URL]` / `[来源: 本节点]` 三种来源标记与 `[[名称]]` 双链约定。
  * 配套：`lib/node-markdown.ts` 的 frontmatter 新增 `note_ingest_turns?: number`（条件写出）；`lib/nodes/outcome-generate.ts` 的 `collectMaterialSourceWhitelist` 由私有改为导出，供生成器复用来源白名单。

### 修复

* **分享卡改为就地编辑 + AI 配图升级（`components/canvas/ShareCard.tsx` / `components/canvas/XhsCard.tsx` / `app/api/ai-generate/illust-prompt/route.ts`）**：分享卡编辑态改为在 `BrandCard` 内直接挂 tiptap 所见即所得编辑器（新增 `ShareAnswerEditor` / `createShareAnswerExtensions` 与 `questionSlot` / `answerSlot` 插槽），**下线原「问题」「答案」两个 textarea**；AI 配图弹框改用 Radix Dialog，修复其 z-index 被卡片遮挡的问题；新增风格下拉、提示词优化按钮与 `negative_prompt` 支持。`XhsCard.tsx` 的 `ILLUST_STYLES` 改为导出以复用；`illust-prompt` 接口新增 `scene?: 'cover' | 'inline'` 参数。
* **打印 / 另存 PDF 修复（`components/canvas/DocEditor.tsx` / `components/canvas/viewers/MdViewer.tsx` / `app/globals.css`）**：打印页眉补全；打印文件名由临时名改为原名 `标题_v1_日期`（`printFileName()`），并临时替换 `document.title`、等待 logo `decode()` 完成、在 `afterprint` 中清理还原；新增 `docTitle` prop 由 `MdViewer` 透传。`globals.css` 新增 `#doc-print-root { display: none }` 与 `@media print { html, body { background: #fff !important } }`。
* **编辑器右键菜单改版 + 导出菜单精简（`components/canvas/DocEditor.tsx` / `components/canvas/ExportMenu.tsx`）**：右键菜单重做为「顶行 4 个图标 + 竖向文字条目」，新增 `Divider` / `Word` 条目，label 压缩为单词；导出菜单下线 `Word (DOCX)` 与 `PDF (print)` 两项及对应的 `onExportDocx` / `onPrint` props。
* **界面文案英文化（`components/canvas/DocEditor.tsx` / `ExportMenu.tsx` / `extensions/AnnotationBubble.tsx` / `MdAnnotationPanel.tsx` / `extensions/MdEmbed.tsx` / `ChatNodeKernel.tsx`）**：段落下拉按钮由 `h` 改为 `T`、删除「分隔线」项，label 与 tooltip 全面改为英文；气泡宽度由固定 `352px` 改为 `w-80`。**注**：`MdAnnotationPanel` 的可见按钮「修订」/「按批注修订」与 `MdEmbed` 的「嵌入文档 · 点击展开预览」**仍为中文，本版未改完**。
* **插件面板端口残留自愈（`lib/plugin-panels-server.ts` / `components/canvas/PluginPanelFrame.tsx`）**：新增 `portHolderPid` / `isOwnPluginOnPort` / `reapStaleHolder` / `waitPanelReady`，用 `lsof` 定位端口占用者，并以 `/api/status` 判定其是否为本插件的残留进程，是则 `SIGTERM` → `SIGKILL` 回收，返回值新增 `reaped`；前端就绪超时由 4000ms 放宽到 8000ms，收到 `reaped: true` 后每 1800ms 自动重探、最多 4 次。
* **交互细节微调（`components/canvas/ChatNodeKernel.tsx` / `components/canvas/CanvasFlow.tsx`）**：划词菜单的「保存为附件材料」改为**同时把选中文字挂为输入框引用标签并聚焦输入框**（不再加入待发附件），title 改为 `将选中文字挂为输入框引用标签（同时留档到 materials/）`；`CanvasFlow.tsx` 移除侧栏「新增会话」按钮的 Tooltip 与 `Add session` 文案。

### 说明

* 本版号由 `0.7.5` 提升为 `0.7.6`。
* 源码改动面 **31 个文件**（**29 个修改 + 2 个新建**），跨「账本子系统 / 笔记与节点运行时 / 画布 UI」三大区域，累计 diff 约 2982 行（+1720 / -1262 量级）。**无新增 API 路由**（`GET /api/ledger/document` 与 `GET /api/notebook?action=types` 均为既有路由的响应/分支扩展），**无依赖与构建配置变更**（`package.json` 仅版本号）。
* 新建文件 2 个，均属研究结论回流：`src/lib/nodes/note-ingest-auto.ts`（触发器，2606 B）、`src/lib/nodes/note-ingest-generate.ts`（生成器，13587 B）。本版**无删除文件**。
* **对账本既有行为的兼容**：`readLedgerEntry` 正则放宽后 `p-` 前缀条目可被正常读取；`lintLedger` 新增的项目页断链检查会对手写/历史账本同样生效（与原第 6 条口径一致，本版将该条标题明确为「对存量账本同样生效」）。
* 未确证项：项目页的 `stage` 流转**目前完全依赖 keeper agent 按规则调用 `ledger_project`**，无 UI 侧手动改状态入口，也未做「跳过中间阶段」的拦截；`note-ingest` 三条常量上限（`ANSWER_CAP = 4000` / `ENTRIES_MAX = 3` / `BATCH_MAX_TURNS = 10`）为**经验值**，长研究轮次的结论可能被截断；回流任务的**去重依赖标题精确匹配**，同一结论换措辞重述仍可能产生重复条目；回流的实际观感与成本（每次触发的 token 消耗）未做实测统计。

## v0.7.5 (2026-09-17)

### 新增

* **节点地图「一键排序」按钮与 ⌘R 快捷键（`NodeMap.tsx` / `SettingsModal.tsx`）**：标题栏工具区新增 `Orbit` 图标按钮（`Auto arrange (⌘R)`），点击即**丢弃手动拖拽产生的位置覆盖，回到自动排版结果**（自动排版本身是确定性纯函数，故「排序」= 清空 `manualPositions` 并复位拖拽/悬停态）；折叠态下触发会**顺手展开面板**，保证结果可见。绑定 **⌘R / Ctrl+R**（`preventDefault` 始终拦截，避免 Electron/Chromium 的整页刷新把动作吞掉）。设置面板的快捷键表中，`⌘R` 的说明同步由 `Fit canvas & arrange sticky notes`（React Flow 时代的旧处理器，早已下线）更正为 **`Auto arrange nodes (Node Map)`**。

### 修复

* **节点地图排版换成「中心星射 + 多点散开」（`lib/graph/nodemap-layout.ts`，重写）**：v0.7.1 引入的「主父层级骨架 + 叶子数比例扇区」版下线，原因有二——它**以「最早连线的父」为根，根常落在图的边缘**，导致整个结构偏在一侧；且**扇区按叶子数分配**时，窄支会在外圈挤成一坨。新算法四步：
  * **中心**：每个连通分量取**簇内度数最大者**居中（并列取 id 小者）——「被连线最多」的点即视觉中心；
  * **分层**：以中心为源做 **BFS**，一跳邻居落近圈、二跳落外圈（父 = 先发现它的邻居，邻居按 id 定序保证确定性）；
  * **散开**：父把扇区按**下辖子树的「同层最大宽度」**分给子（宽支占角大），每圈半径取 `max(上一圈 + 环间距, 最小扇区所需弧距)`，即**同圈弧距恒 ≥ spacing**；
  * **孤立**：无任何连线的点不进分量，绕主结构外圈均匀散布（保持孤立，不假装有关系），其余较小分量同样落外圈、放不下则按环递增半径。
  随之删除：`growthAngle`（生长轴）及其 `nearlySameAngle` / `hitsGrowthAxis` 回避逻辑、`placeCluster` 的旋转参数、对 `chain-utils` 的依赖。确定性约束不变（同输入必同输出，供 `useMemo` 防抖动）。
* **节点地图连线由「左右锚点贝塞尔」改为「径向辐条」（`NodeMap.tsx`）**：原实现按两卡片中心的横向方位取 `Left`/`Right` 锚点（近乎垂直重叠时退化为上→下），在径向布局下会让线**互相绕圈**。现改为**端点各取「圆心 → 对方圆心」方向上的圆缘点、控制点沿同方向等距内推**（`radialEdgePath`），四点共线 → 观感是一条干净的直线辐条；含两处退化保护（两圆心几乎重合时退化为极短直线避免除零；两圆点相交导致锚点越过对方圆心时回落到圆心连线，避免端点反向）。`Position` 常量、`bezierControl()` 与 `smoothBezierPath()` 一并删除；**连线几何与命中把手（`edgeGeom`）共用同一套 `radialEdgePath`**，中点仍取三次贝塞尔 `t=0.5`。

### 说明

* 本版号由 `0.7.4` 提升为 `0.7.5`。
* 源码改动面 **3 个文件**，均在「节点地图 / 设置」内：`lib/graph/nodemap-layout.ts`（`+126 / -155`，331 → 302 行）、`components/canvas/NodeMap.tsx`（`+67 / -87`）、`components/canvas/SettingsModal.tsx`（`+1 / -1`，仅快捷键说明文案）。**无 API、依赖与构建配置变更**（`package.json` 仅版本号）；三文件 TS 诊断均为空。
* **`src/lib/graph/chain-utils.ts` 现已完全无引用**：本版移除 `nodemap-layout.ts` 对它的最后依赖后，全仓已无任何文件 `import` 该模块（其导出的 `buildChains` 自 v0.7.2 起即无调用方）。**文件本体保留未删**，属已知的孤儿模块，本版未做清理以免扩大改动面。
* 未确证项：新排版的**大图（数十至数百节点）实测观感与圈数**未验证；`FIRST_RING_MAX = 12`、`RING_GAP = 1.15`、`ARC_SAFE = 1.35` 仍为**经验值**；「一键排序」**会丢弃用户手动拖拽的位置**且**不做二次确认**，属刻意设计（自动排版确定性可复现）；`⌘R` 为**全局监听**（未限定面板聚焦），其它界面下也会被拦截并触发地图排序。

## v0.7.4 (2026-09-17)

### 新增

* **侧栏会话关系符号改为自绘悬停浮层（`CanvasFlow.tsx`）**：`RailRelationMarks` 的两个角标不再使用原生 `title`，改为 **`createPortal` 到 `body` 的自绘浮层**（`position: fixed`、`z-[1500]`、透明底 + 灰色外框 + 轻投影）。原因有二：**按钮元素内的原生 `title` 在 Chromium 下不弹出**；且侧栏列表是 `overflow-y-auto` 容器，原生/内联浮层会被**裁切**。浮层结构为「标题行（如 `Upstream sessions (1 level) · 2`）+ 逐条会话标题（单行截断，`max-w-[224px]`）」，并按锚点矩形自动决定**向上或向下弹出**；列表滚动（捕获阶段）或窗口 `resize` 时直接收起，锚点失效不会残留。浮层 `pointer-events-none`，不拦截点击。

### 修复

* **关系符号由「行首」移至「标题右侧」（`CanvasFlow.tsx`）**：原实现把角标放在会话行最左侧（Agent 身份图标之前），与「时间序列表」的主线（身份图标 + 标题）抢首位视觉；现移到**标题之后**，身份图标与标题回到行首连续排布。**编辑态（内联重命名输入框）与常态（列表按钮）两条渲染路径同步调整**。
* **上游 / 下游图标语义对调（`CanvasFlow.tsx`）**：上游由 `GitMerge` 改为 **`GitFork`**（贴合「从上层分出」），下游由 `GitFork` 改为 **`GitMerge`**（贴合「向下汇聚」）；数量与浮层文案（`Upstream sessions (1 level)` / `Branches to (1 level)`）不变，仅图标语义与代码注释同步订正。
* **复制按钮反馈由 toast 改为图标态（`extensions/AnnotationBubble.tsx`）**：点击「复制选中文字」成功后，**图标由 `Copy` 短暂变为 `Check` 并转为 `--primary` 色**（1.2s 后还原，`title` 同步由「复制选中文字」变为 `Copied`），不再是整屏 toast；定时器在组件卸载时清理（`copyTimerRef`），连点会重置计时而不叠加。该文件因此移除 `showImageAiEditToast` 依赖（`image-ai-edit-runtime` 本身仍被其余 6 个模块使用）。

### 说明

* 本版号由 `0.7.3` 提升为 `0.7.4`。
* 源码改动面 **2 个文件**，均在「画布 / 侧栏」内：`components/canvas/CanvasFlow.tsx`（`+56 / -12`）、`components/canvas/extensions/AnnotationBubble.tsx`（`+17 / -7`）。**无 API、依赖与构建配置变更**（`package.json` 仅版本号）；两文件 TS 诊断均为空。`createPortal` 在 `CanvasFlow.tsx` 中此前已因 `mdDialog` 引入，本版未新增导入来源。
* **对上版说明的更正**：v0.7.3 的 RELEASES 条目曾记「复制成功提示 `Copied`、失败提示 `Copy failed`（复用 `showImageAiEditToast`）」——该口径自本版起改为**图标态反馈**；复制**失败时不再有任何显式提示**（保持原图标），此处如实更新。
* 未确证项：浮层上下翻转的判据 `锚点.bottom + 84 > innerHeight` 中 **84px 为经验值**（未按浮层实际高度测量，会话很多导致浮层较高时可能仍溢出视口）；浮层**仅响应鼠标 hover**，键盘 Tab 聚焦角标不触发，无障碍可达性未处理；复制失败静默**存在被误读为成功的可能**，属刻意的极简反馈取舍。

## v0.7.3 (2026-09-17)

### 新增

* **划词批注气泡顶部新增排版工具栏（`extensions/AnnotationBubble.tsx`）**：批注气泡由「意见输入框 + 底部按钮」扩为三段式——顶部排版工具栏、中部意见输入框、底部 AI 修订与添加批注。工具栏共 **4 组、组间以竖线分隔**：
  * **段落样式下拉**（`H`）：标题 1 / 标题 2 / 标题 3 / 正文，当前生效项高亮（`--primary`）；
  * **字符格式平铺 7 项**：加粗（⌘B）/ 斜体（⌘I）/ 删除线 / 引用 / 代码块 / 分隔线 / 行内代码；
  * **列表下拉**：无序 / 有序 / 任务（当前生效项高亮）；
  * **复制选中文字 + 发送到当前会话**（`Copy` / `Bot`）。
  全部按钮以 `onMouseDown preventDefault` 保选区，避免点击后正文选区与临时高亮丢失；下拉展开期间点击工具栏以外（含正文与输入框）自动收起。气泡宽度按工具栏单行排布取定，由 `300px` 调至 `352px`，并**移除 `overflow-hidden`** 以便下拉浮层越出气泡边界。
* **「复制选中文字」（`AnnotationBubble.tsx`）**：与发送/添加同用**锁定的选区**（`lastSelRef`）取文本，规避编辑器失焦后 `selection` 漂移；成功提示 `Copied`、失败提示 `Copy failed`（复用 `showImageAiEditToast`）。
* **跨组件活跃节点广播 `active-node-changed`（`CanvasFlow.tsx` / `DocEditor.tsx`）**：`CanvasFlow` 在焦点节点变化时除写入 `lastActiveNodeIdRef` 外，**同时广播 `active-node-changed`**，并复用既有的 `node-selected-request` 作为**握手重播**事件（新挂载的订阅方主动请求一次当前状态，避免错过挂载前的广播）。

### 修复

* **「发送到当前会话」在点进输入框后恒为禁用（`DocEditor.tsx`）**：用户点进节点输入框或打开文档面板后，React Flow 的选中态会丢失，仅靠 `node-selected` 会让按钮永久置灰。现以**三级兜底**取投递目标：**本文档所属节点 → 画布 live 选中（`activeNodeId`）→ 中间区域可见会话（`activeSessionNodeId`，来自新增的 `active-node-changed`）**，与文件面板「发送到当前节点」口径统一；`canAskCurrent` 同步放行。气泡按钮悬停提示文案相应改为「无当前会话 — 请先在画布打开一个节点」。
* **订阅方挂载竞态（`DocEditor.tsx`）**：原先注册 `node-selected` 后立即派发 `node-selected-request`，新增的第二个监听器来不及就位。现改为**两个监听器都注册完成后再请求重播**，`activeNodeId` 与 `activeSessionNodeId` 一并拿到初始状态。
* **文档正文右键菜单瘦身（`DocEditor.tsx`）**：命令分组由 **Format / Block / Insert / Tools 四类、三行图标** 收敛为 **Format / Insert / Tools 三类、两行**——第一行为「撤销 / 重做 ｜ 导出 · 打印 · 分享」（历史与文件工具间补一条竖线分隔），第二行为「插入 + 格式化 · 批注」。菜单宽度 `w-72`（288px）→ `w-[13rem]`（208px），视口右侧夹紧偏移同步由 `296` 改为 `224`，与收窄后的宽度对齐。

### 说明

* 本版号由 `0.7.2` 提升为 `0.7.3`。
* 源码改动面 **3 个文件**，全部在「画布 / 文档」内：`components/canvas/extensions/AnnotationBubble.tsx`（`+214 / -54`，263 → 423 行）、`components/canvas/DocEditor.tsx`（`+56 / -59`）、`components/canvas/CanvasFlow.tsx`（`+10 / -1`）。**无 API、依赖与构建配置变更**（`package.json` 仅版本号）；三文件 TS 诊断均为空。
* 正文右键菜单中被移除的格式命令（标题 1-3 / 正文 / 加粗 / 斜体 / 删除线 / 行内代码 / 无序 · 有序 · 任务列表 / 引用 / 代码块 / 分隔线）**是「移动」而非「能力删除」**：同一批命令已在划词气泡顶部工具栏提供；**撤销 / 重做保留在右键菜单第一行**（气泡工具栏不提供历史操作）。`commandGlyph()` 未改动。
* **划词气泡的「风格快捷选择」随本版下线**：气泡底部的两排 `ANNOTATION_INTENTS` 快捷按钮（自动 / 自定义除外）与气泡内的 `intent` state 一并移除，气泡调用 `onAdd` / `onDirectRevise` 时 **`intent` 恒传空串**。`addAnnotation` 的 `intent` 形参与 `ANNOTATION_INTENTS` 常量**均保留**（`MdAnnotationPanel` 仍用于渲染已有批注的意图标签，`DocEditor` 的 `intentUnmet()` 校验逻辑未动），**历史批注的意图显示不受影响**；但经气泡新添加的批注**不再带风格标记**——`intent` 写入链路现状为本版起**仅剩读取**，属已知的设计收缩。
* 未确证项：气泡宽度由 `300px` 增至 `352px` 后，在**窄面板 / 小窗**下是否与正文或面板边界发生遮挡未做实测；工具栏按「4 组 + 3 条竖线不换行」取定宽度，未做自适应折行。

## v0.7.2 (2026-09-17)

### 新增

* **侧栏会话列表改为「纯时间序 + 关系符号」（`CanvasFlow.tsx`）**：左侧会话列表**取消链分组**，不再嵌套父子、不再把节点按「归入哪条链」折叠，改为**平坦列表**——所有会话按创建时间降序排列，新建的会话始终在最上面（`created_at` 兜底为 +∞，本地新建未落盘的节点即时置顶）。节点间关系改由每行左侧的关系符号承担：`RailLinkChips` → **`RailRelationMarks`**，只表达**一层直接连线**（`GitMerge` + 上游数量，悬停列出 `Upstream sessions (1 level): …`；`GitFork` + 下游数量，悬停列出 `Branches to (1 level): …`），**不做传递推理**（祖先/后代不再折算进计数），也不影响按时间的排序。行间距由「组间 14px」收敛为统一 4px，列表视觉更紧凑。
* **节点地图「显示名称」开关（`NodeMap.tsx`）**：标题栏新增 `Tags` 按钮（`Show node names` / `Hide node names`），打开后**所有圆点常驻显示名称浮层**，不必再逐个悬停确认。标签为**透明底 + 灰框**（`1px solid var(--line)`），默认落在圆点**下方**（避让左右两侧的拖拽建边把手），越界自动翻面并夹紧在面板可视区内；名称过长单行截断（`max-w-[132px] truncate`）。标签尺寸经**实测回调**（`measureLabelRef` + `data-label-node`，仅在尺寸变化时写入 state，避免渲染循环）后再完成居中，因此不受字体与缩放影响。

### 修复

* **悬停标题浮层与常驻标签口径统一（`NodeMap.tsx`）**：原先悬停浮层自算一套定位（居中于圆点、默认落在上方、顶部放不下翻到下方），与新增的常驻标签是两份平行数学，会随改动漂移；现抽出共享的 **`labelBox()`**（`prefer: 'above' | 'below'` + 越界翻面 + 四向夹紧），悬停浮层（`prefer='above'`）与常驻标签（`prefer='below'`）共用同一套坐标计算，只剩「偏好侧」一处差异。
* **悬停浮层配色与标签拉齐（`NodeMap.tsx`）**：由「深色底 + 白字」（`var(--ink)` / `#fff`）改为**透明底 + 灰框 + 常规字色**，与常驻名称标签同款；全量标签显示时（`showAllLabels`）**不再叠一层悬停浮层**，同时该状态下**移除圆点的原生 `title`**，避免同一名称在浮层与浏览器 tooltip 里重复出现。

### 说明

* 本版号由 `0.7.1` 提升为 `0.7.2`。
* 源码改动面 **2 个文件**，均在「画布 / 导航」内：`components/canvas/CanvasFlow.tsx`（`+68 / -271`，净减 203 行）、`components/canvas/NodeMap.tsx`（`+98 / -19`）。**无 API、依赖与构建配置变更**（`package.json` 仅版本号）。
* 侧栏「跨归属出边」角标（`ArrowUpRight` + 点击跳转，v0.7.1 引入）随链分组一并**下线**——该角标的语义是「本会话的下游被归入别人的链」，链分组取消后「别人的链」不再存在，故不再有表达对象；`ArrowUpRight` 导入同步移除。
* `chain-utils.ts` 的 `buildChains()` 目前**暂无调用方**（本次仅移除 `CanvasFlow.tsx` 的使用）。**函数本体保留未删**，与 `buildEdgeHierarchy` / `pickPrimaryParent`（仍被 `nodemap-layout.ts` 消费）同处一个模块，属已知的待清理死代码，本版未做清理以免扩大改动面。
* 侧栏列表项类型 `Dot` 同步瘦身：移除本版起不再使用的 `isNote` 与 `sandboxAppId` 字段。
* 未确证项：常驻名称标签在**节点很多**（标签同屏数十个）时的视觉拥挤程度未做实测；`Show node names` 开关为**组件内 state，不持久化**，刷新/重开画布后回到关闭态。

## v0.7.1 (2026-09-17)

### 新增

* **侧栏链行关系角标（`CanvasFlow.tsx`）**：会话链侧栏每一行新增 `RailLinkChips` 组件，用三个**中性灰阶**角标表达「连线」关系（只做描述，**不改变分组与归属**）：① **扇入** `GitMerge`——本会话由 ≥2 个上游汇入（多对一），hover 列出全部上游标题；② **扇出** `GitFork`——本会话分出 ≥2 个下游（一对多），hover 列出全部下游标题；③ **跨归属出边** `ArrowUpRight`——本会话连出的下游**主父是别人**（故在侧栏归入别人的链、不出现在本组），hover 列出标题、**点击直接跳转**到该下游。角标只统计会在侧栏出现的会话节点（`isFocusableResearch` 过滤），Bobby / 附件类连线不计入数量，跳转目标也保证在 rail 内。链首行原先的纯数字子节点计数（`group.dots.length - 1`）随之下线，改由 `GitFork` 角标承担语义。
* **地图与侧栏「主父」口径统一（`lib/graph/chain-utils.ts` / `CanvasFlow.tsx`）**：节点地图的层级骨架与左侧会话区分组共用同一套判定——`buildEdgeHierarchy` + `pickPrimaryParent`（**最早连线即主父**），保证「谁归入哪条链」在两处一致。为此依赖方向反转为 `nodemap-layout → chain-utils`：`chain-utils` 不再导入 `nodemap-layout` 的 `groupComponentsByConnectivity`（消除反向依赖），后者改为引用前者的层级工具。
* **节点地图改用径向轨道排版（`lib/graph/nodemap-layout.ts`★ 重写 / `components/canvas/NodeMap.tsx`）**：`computeForceLayout`（稳定落定式力导向 + 分量垂直堆叠）整体下线，改为 `computeRadialLayout`：① 以主父层级为骨架，**根节点居中、子节点按深度落到同心环**；② 子树**扇区按叶子数比例**分配（分支越大占角越宽），角度取扇区中位角，于是「从哪个节点分出来」一眼可读；③ 同环节点数多时按弧距 ≥ `spacing` 自动外扩环半径（容量按 `ARC_SAFE` 折算），跨环保持 `RING_GAP` 径向间距；④ **未连线的孤立节点不再纵向堆叠成一条竖线**，改为绕主结构外圈均布（小规模尽量单环装下，`FIRST_RING_MAX = 12`，超出再增圈）；⑤ 多根（一个节点被多个根指向）时根落在内环均布。排版仍是**纯函数 + 确定性**（同输入必同输出，仅靠排序与扇区分配，无随机数），故 `NodeMap` 直接用 `useMemo` 缓存。
* **避免「整图退化成一根长线」的两处几何处理（`nodemap-layout.ts`）**：① 槽位的起始偏移按环奇偶交替半格；若仍有槽位落在主结构的**生长轴**上（`growthAngle`，即单根且只有单支时该支的方位，纯链就是这条放射轴）再偏半格；② 落在生长轴上的簇自身再旋转 90°（`nearlySameAngle` 按 ±20° 判定），破开「同轴叠成一根线」的观感。对称情形无法完全避开时保持原偏移。
* **地图缩放防归零（`NodeMap.tsx`）**：径向排版下「一条纯链」会沿单轴放射展开，原 `scale = min(mapW / bw, mapH / bh)` 在某一轴跨度为 0 时会把比例算成 0、**整图压成一个点**；现分轴计算 `scaleX` / `scaleY`，用有跨度的那一轴定比例，只有两轴都无跨度（单节点）才回落 0（居中显示）。
* **分组视图可折叠（`Sidebar.tsx`）**：materials 与 homework 的分组视图下，分组标题由「纯展示」改为**点击折叠 / 展开**（不加折叠符号，靠 hover 底色提示可点），折叠态仅记在本次会话内（`collapsedWsGroups`，键形如 `<项目id>|m:<目录>` / `<项目id>|h:<会话键>`）；`Delete group` 按钮移出标题按钮、独立成右侧按钮，保证点击区不冲突。

### 修复

* **删除「锚定增量排版」缓存（`NodeMap.tsx` / `nodemap-layout.ts`）**：原实现以「节点结构签名」为键缓存上次落定位置，并在拖拽落定时把新坐标回写该缓存，用于「拉线后位置不跳动」。径向排版本身**以边为排版依据**——增删连线**必须**重新分环、分扇区才可读，二者目标冲突，故整套锚点缓存与 `previousPositions` 选项、`anchoredLayout` / `separate` / `separateAnchored` / `hashString` 等辅助函数一并移除；**手动拖拽定位仍然优先**，拖动后不回弹。
* **子节点身份图标配色（`CanvasFlow.tsx`）**：侧栏子节点身份图标由统一绿色改为中性灰阶（`var(--success)` → `var(--ink-muted)`，编辑态与展示态两处），**绿色只保留给运行 / 未读状态点**，避免「链内成员」与「正在运行」两种语义抢同一颜色。

### 说明

* 本版号由 `0.7.0` 提升为 `0.7.1`。
* 源码改动面 **5 个文件**，全部集中在「画布 / 导航」这一块：`lib/graph/nodemap-layout.ts`（重写，`-393 / +231`）、`components/canvas/CanvasFlow.tsx`（`+142 / -18`）、`components/canvas/Sidebar.tsx`（`+37 / -15`）、`components/canvas/NodeMap.tsx`（`+11 / -34`）、`lib/graph/chain-utils.ts`（仅删 1 行导入）。**无 API、依赖与构建配置变更**（`package.json` 仅版本号）。
* `groupComponentsByConnectivity`（连通分量 / 孤立节点划分）**保留**并继续被径向排版与分组逻辑消费；本轮只下线力导向与本 N 版新增的锚定增量排版。
* 排版与角标均为纯函数 + 确定性（无 `Math.random`、无时间戳），同输入必同输出。
* 未确证项：径向排版在**超大图**（数百节点 / 多环）下的实际观感与性能未做实测标定，`FIRST_RING_MAX = 12`、`ARC_SAFE = 1.35`、`RING_GAP = 1.15` 均为经验值。

## v0.7.0 (2026-09-17)

### 新增

* **项目账本子系统 `.ledger/`（`lib/mcp/ledger.ts`★ / `lib/mcp/ledger-compile.ts` / `api/chat/tools/ledger.ts` / `api/ledger/document/route.ts` / `components/canvas/LedgerDocPanel.tsx`，均为新增文件）**：项目获得一层**宿主原生文件层**账本，随项目落在 `<项目根>/.ledger/` 下，**不启动任何 MCP 实例，无子进程 / 端口 / 模型配置**。① `LEDGER_DIRNAME = '.ledger'`，`layout()` 固定 `SCHEMA.md` / `index.md` / `log.md` / `raw/` / `wiki/` / `locks.md`；② `LEDGER_SCHEMA_SEED` 给出账本自述规范，`LOCK_TAPE_SEED` 初始化锁定流水带；③ `refreshLedgerIndex()` 重建 `index.md`、`appendLog()` 追加流水、`lintLedger()` 做体检；④ `recordLedgerEntry()` / `registerLedgerMaterial()` / `recycleLedgerMaterial()` / `renameLedgerMaterial()` 覆盖登记、回收与改名；⑤ `LEDGER_RULES_APPENDIX` 对存量项目注入增量条款 7 / 8，使老项目也能遵守账本约定。账本由管家（Butler）维护，全体 agent 的取资料姿势统一为「**先读档案，再取原文**」。
* **账本四工具与只读编译文稿面板**：新增 `read_ledger`（路由器）/ `ledger_record` / `ledger_pending` / `ledger_lint` 四个工具；面板侧 `GET /api/ledger/document` + `LedgerDocPanel.tsx` 把 `.ledger/wiki` 在线汇编成可读文稿，界面明示 `Assembled on the fly from .ledger/wiki — no file is written.`（只读、不落盘），侧栏以 `BookOpen` 按钮打开。
* **项目级后台调度器（`lib/runtime/project-scheduler.ts`，新增文件）**：让后台任务与用户轮互不抢占——`RANK = { outcome: 0, compile: 1 }` 定优先级，`enterUserTurn()` 在用户轮进入时让路、`runBackground()` / `pump()` 只在空闲时推进；`/api/chat/route.ts` 的进入与 `finally` 释放成对出现，确保异常路径下也能交还调度权。
* **材料到达即触发账本编译（`lib/mcp/ledger-compile.ts`）**：`notifyLedgerMaterialRegistered()` 在材料登记后起后台 butler 会话（不传 `nodeId`，与用户会话隔离）；静默窗 `QUIET_MS = 30_000`、单次上限 `MAX_PER_RUN = 8`、会话超时 `SESSION_TIMEOUT_MS = 10 * 60 * 1000`，避免碎片化重复编译。
* **项目档案预取与入口指标（`lib/runtime/project-brief.ts` / `lib/runtime/entrypoint-metrics.ts`，均为新增文件）**：① `buildProjectArchiveBrief()` 在用户轮开始前预取账本与材料清单，预算 `LEDGER_MAX_ITEMS = 30` / `MATERIAL_LIST_MAX = 50` / `BRIEF_MAX_CHARS = 2400`，压缩档 `BRIEF_COMPACT_MAX_CHARS = 800` / `LEDGER_COMPACT_ITEMS = 6` / `MATERIAL_DIR_MAX = 8`；② 入口指标以 `ENTRY_TOOLS = ['read_ledger','search_materials','read_attachment']` 定义「入口工具」，`deriveTurnTrace()` 输出 `turn=N … | fetch=… | trunc=…` 单行跟踪，便于事后核对一轮对话的资料取用轨迹。
* **成果块锁定升级为可追溯签字链（`lib/nodes/outcome.ts` / `lib/node-markdown.ts`★ / `app/api/nodes/route.ts` / `components/canvas/OutcomeEditor.tsx`）**：把「锁定 = 有个时间戳」升级为「**签署人 + 内容哈希 + 追加式历史 + 项目级外部锚点**」。① frontmatter 新增 `outcome_locked_by` / `outcome_content_hash` / `outcome_lock_history` / `outcome_stale_reason` 四个字段并同步序列化；② `localOperatorName()` 记录签署人，`outcomeContentHash()` 取 `SHA-256(renderOutcome())` 前 32 位十六进制；③ 每次锁定 / 解锁向 `.ledger/locks.md` 追加锚点记录（`appendLockRecord()` / `latestLockOf()` / `readLockTape()`），nodes raw 响应新增 `lock_history` / `lock_anchored`；④ **解锁不再抹掉签署证据**，历史可追溯。UI 侧 `OutcomeEditor.tsx` 新增签署留痕行、`Lock history (N)` 折叠区，并如实标注 `Local record only · not a cryptographic signature`（仅本地记录，非密码学签名）与 `No external anchor · signature chain unverified`（无外部锚点时签链不可验证）——**不把本地留痕包装成密码学保证**。
* **成果块失效级联与原因链（`lib/nodes/stale.ts`，新增文件 + `app/api/edges/route.ts`）**：失效传播从「单级标红」升级为「**带起因的向下游级联**」。`markStaleCascade()` 沿下游传播，`StaleCause = 'edge-disconnected' | 'relocked' | 'unlocked'` 三种起因分别对应文案 `连线已断开` / `成果块已重新锁定（版本变更）` / `上游已解锁（成果块可能被修改）`；`edges/route.ts` 新增 `markDownstreamStale()`，删边即触发下游失效。原因经 `outcome_stale_reason` 写入 frontmatter，并经新增的 `node-outcome` SSE 通道广播到画布（`ChatNodeKernel.tsx` / `UnifiedViewer.tsx` / `Sidebar.tsx` 的 `outcomeStaleReason`），用户可直接从按钮 `title` 看到「为什么失效」。
* **成果块页码与来源真实性校验（`lib/nodes/outcome-source-check.ts` / `outcome-generate.ts`，新增文件）**：① `PAGE_UNVERIFIED = '页码待核实'` 常量 + `SOURCE_RE` 覆盖三种来源写法；② `checkOutcomeSourcePages()` 对越界页码、无索引页码一律降级标记为待核实，不再放任模型编造页号；③ `collectMaterialSourceWhitelist()`（`WHITELIST_MAX = 40`）只把**工具命中过的来源**列入白名单，生成端的出处必须照抄白名单，从源头掐断「凭记忆写出处」。
* **成果块静默窗自动提炼（`lib/nodes/outcome-auto.ts`，新增文件）**：节点对话追加后 `notifyNodeConversationAppended()` 起 15 秒静默窗（`QUIET_MS = 15_000`），期间持续有新轮次则顺延、累积上限 `MAX_PENDING_TURNS = 8`；静默达成后自动提炼成果块并 `emitNodeOutcomeChanged()` 广播，避免「对话聊完却忘了沉淀结论」。
* **结论档渲染与记忆源权威顺序（`lib/nodes/outcome.ts`）**：新增 `renderOutcomeBrief()` 输出精简结论档；`MEMORY_AUTHORITY_RULE` / `MEMORY_AUTHORITY_BRIEF` 明确多来源记忆的**权威顺序**，减少新旧结论互相污染。
* **资料检索形成三级跳：`read_ledger`（路由器）→ `search_materials`（定位器）→ `read_attachment`（取件）**：新增 `search_materials` 工具（`app/api/chat/tools/materials.ts`，新增文件，`maxOutput: 6000`），输出分「清单态」与「命中态」两种，命中行前置 `[来源: 材料:${projectPath}#p${h.page}]`，使模型能直接引用可核验的定位，而不是凭印象描述文件。
* **Office 文档纳入索引（`lib/materials/indexer.ts`★ / `lib/parse/office-text.ts`，后者为新增文件）**：① `OFFICE_EXTS = new Set(['.docx', '.xlsx'])`；② 新增 `extractDocx()` / `extractXlsx()` 抽取正文，`unwrapXlsx()` 专门修掉 xlsx 解析器在 CJS 下**静默失败**（返回空结果却不报错）的问题；③ 解析逻辑抽成共享模块 `office-text.ts`：`docxHtmlToText()` / `docxXmlFallbackText()`（HTML 路径失败时回退裸 XML）/ `xlsxRowsToLines()` / `collapseMarkedLines()`，索引与工具共用同一套文本化规则。
* **材料与账本双向随动（`lib/materials/indexer.ts`）**：① 索引 meta 新增 `ledgerAt` 记录入账时间；② `registerMaterialToLedger()` 索引完成后自动登记账本条目；③ `kickMaterialsBackfill()` 为历史材料补做回填，老项目也能补齐账本；④ `listMaterialsInventory()` 提供材料清单供档案预取使用。
* **`read_attachment` 取件范围与预算控制（`app/api/chat/tools/attachment.ts`★）**：新增 `scope = context | exact | full` 三档，**默认 `context` 即「命中页 ±1」**（`readCapForContext()`），兼顾阅读连贯与上下文节省；超限处显式追加 `[truncated]` 标记，让模型知道内容被截断而非文本本来如此。
* **资料 chip 可点直达（`components/canvas/ChatNodeKernel.tsx`）**：附件 chip 与 `@引用` chip 变为可点击（`openChipPath()` / 引用 chip 点击），点击即打开对应文件 / 目录，省去在侧栏翻找。
* **分享卡接入 AI 文生图与更顺手的编辑体验（`components/canvas/ShareCard.tsx`★）**：① 新增 `POST /api/ai-generate/image` 调用与文生图弹框（`aiImgOpen` / `handleAiGenerate()`）；② 编辑框聚焦字段记忆（`activeFieldRef`），切字段不丢焦点；③ `handlePaste` 支持把粘贴的截图以占位符方式替换为 `![image](data:image/...)`；④ 新增 `uploadImage()` 与 `nodeId` 入参。
* **文件整理置信度阈值可配（`components/canvas/SettingsModal.tsx` / `lib/settings.ts` / `tools/organize/`）**：① 设置面板新增 `Confidence Threshold` 选项（`MIN_CONFIDENCE_OPTIONS = [0.3 … 0.9]`），字段 `fileOrgMinConfidence`，默认值不落盘（保持配置精简）；② `settings.ts` 新增 `DEFAULT_MIN_CONFIDENCE = 0.6` 与 `normalizeMinConfidence()` 做越界归一；③ `tools/organize/` 接入 `minConfidence`，低于阈值的自动归类不再执行。
* **内联图片放行（`lib/sanitize-whitelist.ts`）**：`img` 标签白名单放开 `className` / `src` / `alt`，并新增 `protocols: { src: ['data'] }`，使 data URL 内联图片（如分享卡粘贴的截图）能正常渲染。
* **管家（Butler）人格与场景扩展（`lib/agents/profiles.ts` / `market-server.ts` / `official-packages.ts`）**：① Butler 新增【项目账本 · 你是 keeper】5 条规则（含账本维护职责），【材料核验】流程改为**先 `read_ledger` 查档案**；② `ALLOWED_AGENT_SCENES` 新增 `'ledger'` / `'ledger-keeper'`，`official-packages.ts` 的 `fixedScenes` 同步扩展。
* **`node-outcome` 实时通道（`lib/project/project-events.ts` / `app/api/projects/events/route.ts`）**：新增 `NodeOutcomeListener` / `onNodeOutcomeChanged()` / `emitNodeOutcomeChanged()`，SSE 下发 `event: node-outcome`，画布侧转为窗口事件 `node-outcome-refresh`——成果块状态变化（锁定、失效、自动提炼）无需刷新即可同步到 UI。

### 修复

* **续读提示被截断吞掉（`app/api/chat/tools/attachment.ts`）**：`[truncated]` 标记此前可能落在截断线之外而不被输出，模型因此误以为已读全文；现于截断处就近输出该标记。
* **路径不存在时模型凭记忆复述（`app/api/chat/tools/attachment.ts`）**：文件不存在时不再返回空内容，改为硬错误 `Error: 路径不存在 —— ${path}（已按项目相对路径解析）。禁止按记忆复述该文件内容…`，从提示层直接阻断「文件读不到就编」。
* **xlsx 解析静默失败（`lib/materials/indexer.ts` / `lib/parse/office-text.ts`）**：`unwrapXlsx()` 处理 CJS 互操作差异，xlsx 不再「解析成功但内容为空」。
* **账本漏登 / 断链 / 改名失联（`lib/mcp/ledger.ts` / `lib/materials/indexer.ts`）**：以 `registerLedgerMaterial()` / `recycleLedgerMaterial()` / `renameLedgerMaterial()` 补齐材料在账本中的生命周期，删文件、改文件名后账本不再留下指向不存在文件的死链。
* **工具输出与累计预算过松（`lib/context-limits.ts`）**：`TOOL_OUTPUT_RATIO` 由 `0.15` 收紧至 `0.05`（单个工具输出不得吃掉过多上下文）；新增 `TASK_TOOL_OUTPUT_RATIO = 0.15` 约束**子任务累计**输出、`BRIEF_MAX_CHARS_PER_UPSTREAM = 1800` 限制单上游 brief 长度，避免多路汇总时上下文被单一来源挤爆。
* **工具放行判据统一与调用上限（`app/api/chat/route.ts`★）**：把散落的工具放行判断收敛为统一判据，并新增 `callCap` 限制单轮工具调用次数；同时以 `LEDGER_HINT` 软指针引导模型优先查账本，R-14 回退路径由方案 C 改回方案 A，P0-a 侧改为双重校验——减少「该查没查」与「不该放行却放行」两类偏差。

### 说明

* 本版号由 `0.6.1` 提升为 `0.7.0`（minor）：本轮新增完整「项目账本」子系统、成果块 P0 整改与资料索引三级跳，属跨模块能力扩展，非普通补丁。
* 源码改动面：**28 个既有源文件被修改**（净增约 +1132 行），改动量最大者为 `lib/materials/indexer.ts`（+229）、`components/canvas/ShareCard.tsx`（+200）、`app/api/chat/route.ts`（+164）、`lib/nodes/outcome.ts`（+113）、`components/canvas/OutcomeEditor.tsx`（+112）。新增文件包括 `lib/mcp/ledger.ts`、`lib/mcp/ledger-compile.ts`、`api/chat/tools/ledger.ts`、`api/ledger/document/route.ts`、`components/canvas/LedgerDocPanel.tsx`、`lib/runtime/project-scheduler.ts`、`lib/runtime/project-brief.ts`、`lib/runtime/entrypoint-metrics.ts`、`lib/nodes/outcome-auto.ts`、`lib/nodes/outcome-generate.ts`、`lib/nodes/outcome-source-check.ts`、`lib/nodes/stale.ts`、`lib/parse/office-text.ts`、`api/chat/tools/materials.ts` 与 `e2e/export-targets.spec.ts`。无依赖与构建配置变更（`package.json` 仅版本号）。
* **未确证项如实标注**：① `protocols.src = ['data']` 放行内联图片的完整安全影响未做评估（当前仅放开 `img` 的 `data:`）；② `BRIEF_MAX_CHARS_PER_UPSTREAM = 1800` 与 `TASK_TOOL_OUTPUT_RATIO = 0.15` 是否经实测标定未确证，目前按经验值设定；③ 128k 窗口下 `T_turn` 的注释写 `6400`，而实现为 `Math.max(8000, …)`（实际取 8000），注释与实现不一致，未在本版修改；④ 独立插件 `bob-ocr-mcp`（OCR 常驻服务）不在本应用包分发范围，其改动不计入本版。
* 项目账本为**宿主原生文件层**，随项目目录落盘，可被用户在 Finder 中直接查看与版本管理，不引入任何常驻进程。

## v0.6.1 (2026-09-16)

### 新增

* **`@引用` 快照随对话落盘（`types.ts` / `node-markdown.ts` / `/api/nodes` / `ChatNodeKernel.tsx` / `CanvasFlow.tsx`）**：本轮提问携带的资料 / 本地文件 / 链接 / 操作目录（`@` 引用）现在会随节点 `.md` 一起持久化——① `types.ts` 新增 `MessageReference` 接口（`kind: 'material' | 'file' | 'link' | 'folder'`），`ChatMessage` 新增 `references?: MessageReference[]`；② `node-markdown.ts` 在 question 块开头写入 `<!-- REFERENCES: [...] -->` 注释（书写顺序 `META` → `REFERENCES` → `ATTACHMENTS` → 正文），重新解析时剥离并还原为 `questionReferences`，JSON 损坏则仅剥注释、丢弃引用记录；③ `/api/nodes` 的 append 分支接收并透传 `question_references`；④ `ChatNodeKernel.tsx` 新增 `ReferenceChips` 组件（虚线边框胶囊，按 `kind` 分流 `Link2` / `Folder` / `AtSign` 图标，超长名 `truncate` 到 64px）与 `buildTurnReferences()` 聚合函数，用户气泡内渲染本轮引用 chips；⑤ `CanvasFlow.tsx` 从落盘数据恢复 user 消息时一并回填 `references`，**跨会话重开节点后 chips 不再丢失**。
* **重试保真（`ChatNodeKernel.tsx`）**：重试上一轮问答时，重新发送的原始问题会带回该轮的 `attachments` 与 `references` 快照，避免重试后气泡内的附件与引用 chips 消失。
* **分享卡编辑框支持粘贴截图（`ShareCard.tsx`）**：问题 / 回答编辑框新增 `onPaste` 处理——剪贴板中的图片转 base64 data URL 后在光标处插入 `![image](data:image/...)` Markdown，无需先存文件。
* **OCR 插件缓存命中透传（`ocr-client.ts` / `ocr-service.ts` / `api/chat/tools/ocr.ts`）**：识别结果新增 `cached?: boolean` / `cachedAt?: string` 字段，工具输出在缓存命中时明确标注 `，插件缓存命中·本次未重新识别`，避免历史结果被误当作「本次刚识别」而触发重复识别。
* **节点 Markdown 单元测试（`src/lib/__tests__/node-markdown.test.ts`，新增文件）**：覆盖三条注释（`META` + `REFERENCES` + `ATTACHMENTS`）全部剥净、以及带 `@引用` 追加后重新解析的引用快照完整性。

### 修复

* **整份识别的真实页数与落盘分块数分离（`materials/indexer.ts`★ / `api/chat/tools/attachment.ts` / `api/ocr/route.ts` / `pdf/core/bridge.ts`）**：修复「多页文档被记成 1 页」——上游只回整份连续文本（无分页结构）时 `pages.length` 恒为 1，旧逻辑把 `pageCount` 写成 `pages.length = 1`，`read_attachment` 便回 `1/1 pages`，模型据此误判「识别被截断」并反复重跑 OCR。现于索引 meta 中把两者分开：`pageCount` 记上游声明的真实页数、`textPageCount` 记 `pages/` 下实际落盘的文本分块数；`readExistingIndex` 按 `textPageCount` 读文件但对外返回真实 `pageCount`；旧索引无 `textPageCount` 时回退取 `pageCount`（向后兼容）。同时在 `read_attachment` 输出中对 `textPageCount < pageCount` 的情况追加显式说明 `(整份识别·无分页结构，正文为连续文本)`，避免再次误判。

### 说明

* 本版为常规递增 `0.6.0` → `0.6.1`。
* 源码改动面 15 个文件，三条主线：OCR / PDF 索引链路（真实页数与落盘分块数分离、缓存命中透传）、节点 Markdown `@引用` 落盘链路、画布节点前端（引用 chips、重试保真、分享卡粘贴截图）；无依赖与构建配置变更。
* 独立插件 `bob-ocr-mcp`（OCR 常驻服务，不随本应用包分发）的 `src/recognize-cache.ts`（识别结果本地缓存，含 200 文件上限与 in-flight 去重）本轮亦有改动时间戳，但其实现此前已存在于插件构建产物中，是否属本版新增未经确证，故不计入本版变更说明。

## v0.6.0 (2026-09-16)

### 变更

* **通知中心右栏顶栏极简化（`WantedNoticeCenter.tsx`）**：顶栏不再抢正文视觉——① 删除 `MESSAGE` / `INBOX` 状态徽章（连同带 `var(--primary-soft)` 底色 + 描边的胶囊容器），左侧只保留一个 12px、`var(--ink-faint)` 的弱化 `Mail` 图标；② `Prev` / `Next` 按钮去掉文字标签与 `1px solid var(--line)` 边框，改为纯 `ChevronLeft` / `ChevronRight` 图标（13 → 14），内边距 `4px 8px` → `3px 5px`，可用态颜色 `var(--ink)` → `var(--ink-muted)`；③ 关闭按钮颜色 `var(--ink-muted)` → `var(--ink-faint)`，内边距 `2px 4px` → `3px 5px`；④ 顶栏底色由 `var(--paper-soft)` 改为 `transparent`，内边距 `10px 14px` → `6px 10px`、元素间隙 `8` → `6`；⑤ 阅读进度计数由 `n / N` 改为 `n/N`，字号 `0.733333rem` → `0.7rem`、颜色转 `var(--ink-faint)`，并启用 `fontVariantNumeric: 'tabular-nums'` 防跳位。

### 说明

* 本版号由 `0.5.436` 提升为 `0.6.0`（minor）。
* 源码改动面仅 1 个文件、1 处界面（通知中心右栏顶栏），无 API、依赖、构建配置变更；收件箱分区（`INBOX` / `ARCHIVE`）、类别筛选、右侧详情等功能行为不变。

## v0.5.436 (2026-09-16)

### 新增

* **素材按文件夹分组（`Sidebar.tsx`）**：material 侧栏新增「分组视图」——按 `materials/` 下的子目录把条目折叠成组，未分组的条目归入恒排最后的 `Root` 组；分组开关按项目持久化（`bob.workspace.materials-grouped.<projectId>`，键前缀常量 `WS_MATERIALS_GROUPED_LS_PREFIX`），组内排序用 `localeCompare(..., 'zh')`。
* **拖拽把条目移入分组（`Sidebar.tsx` + `/api/materials`）**：行内拖拽（自定义 MIME `application/x-bobwork-ws-row`，常量 `WS_ROW_DRAG_MIME`）落到分组头上即把该条目移入该组，落点高亮（`dragOverGroup`），后端走 `/api/materials` 新增的 `action: 'move'`。
* **新建文件夹（`Sidebar.tsx`）**：行内重命名弹层复用为「新建文件夹」（`renaming.kind: 'rename' | 'newFolder'`，标题随态切换 `Rename` / `New folder`），提交走 `/api/materials` 的 `action: 'create_folder'`；入口为目录 ⋮ 菜单新增的 `New folder` 项。
* **解散分组（`Sidebar.tsx` + `/api/materials`）**：分组头上的 `Trash` 按钮调用 `/api/materials` 新增的 `action: 'dissolve_group'`——把该分组目录下的直属条目全部搬回 `materials/` 根（回到未分组）、再删掉已空的目录；**文件不删除，子目录整体搬迁、内部结构不变**，归档目录（`archive`）拒绝解散（`Cannot dissolve the archive folder`）。
* **⋮ 菜单新增 `Group by folder`（`Sidebar.tsx`）**：与上一版的 `Group by conversation` 并列，`Folder` 图标按当前状态着 `var(--primary)`。
* **批量标签弹层勾选态（`Sidebar.tsx`）**：标签项由单选 `Check` 改为 `Check`（全选该标签）/ `Minus`（部分选中）/ `Tag`（未选中）三态。

### 修复

* **禁止把文件夹移入自身（`/api/local-files`）**：目标路径等于源路径、或位于源路径之下时直接拒绝（`Cannot move a folder into itself`，HTTP 400），避免拖拽把自己的父目录塞进自己。
* **单文件标签弹层残留（`Sidebar.tsx`）**：`startSelection`（开始批量框选）时关掉单文件标签弹层并清空草稿（`setTagEditor(null)` / `setTagDraft('')`）——否则它会残留并盖在批量标签弹层上，导致点击落错目标。

### 变更

* **模型输出「声明真实性」校验（`/api/chat/route.ts`，本版最大改动）**：补上三类「幻觉式完成」死角——① **写文件声明**：模型在正文里声称"已写入文件 xxx.md"但工具记录中并没有成功的 `write_file`（此前只校验「被调用的工具是否成功」，没调用就无人校验）；② **PDF 读取完整性**（新增 `verifyPdfReadCompleteness`）：分页读取未读全却声称"已完整读取/分析整份 PDF"时，按硬标记 `⚠ INCOMPLETE: page 1 of N` / `pages a-b of N` 判定并纠偏（`请先分页续读完整内容…`）；③ **笔记引用声明**：模型声称"根据笔记/库里/你记录的回答"，但工具记录中从未成功调用 `read_notebook` / `read_note` / `read_raw_inbox`。纠偏次数上限 `MAX_CLAIM_MISMATCH_CORRECTIONS = 2`。
* **`chat/route.ts` 其余收敛**：company 场景触发词补充 `信用代码`（覆盖"社会信用代码 / 统一社会信用代码"，无需"查 / 工商"这类动词）；新增管家卡片工具集合 `BUTLER_CARD_TOOLS`（`create_scheduled_todo` / `todo_update` / `todo_delete`）；MCP 工具计数改为只保留「场景过滤后实际有工具被注入」的 server（`mcpToolCountsMap`）；V4 家族声明判据与显示名标准化（`family: 'deepseek-v4'`）；Vision Bridge 的「正在识别图片」进度改到流内（工具循环前）发送，不再阻塞首字节。
* **思考档位文案改为命名常量（`src/lib/types.ts`）**：三段注入文案抽成 `THINK_GUIDE_TEXT: Record<'low' | 'deliberation' | 'retrospection', string>`；`high` 承接原中档（`Deliberation`）、`max` 承接原深档（`Retrospection`），原三档 `medium` 保留为 legacy，`off` 恒空。
* **轨迹导出补全工具步骤 `phase` 生命周期（`src/lib/trajectory/export.ts`）**：步骤预填 `phase: 'pending'`，工具轮结算时置 `done`，SSE `tool_call_update` 可覆盖，`tool_result` 分支同步；测试同步更新（`src/lib/trajectory/export.test.ts`）。
* **附件/文档工具整理（`/api/chat/tools/attachment.ts`）**：`read_material`（及旧 `readIndexedMaterial`）合并进统一的 `read_attachment`；Excel 指定 `sheet` 未命中时回显可用 sheet 列表（`可用 sheet：…。请用 sheet 参数指定其一，或不传 sheet 读取全部。`）；PDF 增加「未指定页码」快路径；图片优先读已索引的 OCR 结果（`getIndexedOcrPagesByHash`）。
* **OCR 增加升级策略参数（`/api/chat/tools/ocr.ts` + `/api/ocr`）**：`ocr_document` 新增 `upgrade` 参数（`off` / `auto` / `always`，仅这三个合法，缺省或非法一律回退 `auto`），透传给 `ocrFile`。
* **Agent 打包工具场景约束（`/api/chat/tools/agent-package.ts`）**：场景允许列表移除 `team`（`Scene "team" is NOT allowed (multi-agent is switch-only).`），并补充「与 `write_file` 同轮输出的正文不会被保留为答复，需在工具后消息里复述结论」的提示。
* **团队视图运行状态呈现（`TeamChatStream.tsx` / `TeamWorkbench.tsx` / `lib/chat/team-events.ts`）**：补充成员分支卡片、当前状态快照、"看起来卡住了"、任务起始时间等呈现文案与字段映射。

### 说明

* 本版共改动 21 个源文件，改动面为近期最大，集中在三条线：① 工作区侧栏的素材分组管理（`Sidebar.tsx` + `/api/materials` + `/api/local-files`）；② 主对话服务端的「声明真实性」校验（`/api/chat/route.ts`）；③ 工具层（`attachment.ts` / `ocr.ts` / `ocr/route.ts` / `agent-package.ts`）。
* 另有 7 个文件为配套整理、无新增文案或接口变化：`/api/chat/tools/audio.ts`、`office.ts`、`/api/attachments/route.ts`、`lib/files/sources.ts`、`composer/ComposerChips.tsx`、`composer/MentionMenu.tsx`、`lib/chat/approval.test.ts`。

## v0.5.435 (2026-09-16)

### 变更

* **工作区侧栏滚动结构重排（`Sidebar.tsx`）**：标签栏固定在顶部、多选条紧随其下，二者**移出滚动区**，不再随文件清单滚动；文件清单成为唯一滚动区（`flex min-h-0 flex-1 flex-col overflow-y-auto hide-scrollbar`，隐藏滚动条但仍可滚动）。
* **多选条重做（`Sidebar.tsx`）**：取消背景与边框，仅以一条分隔线与列表相隔；操作按钮重排为 `{n} selected` 计数 + `All` / `Clear`（作用域内全选、清空）+ `Tag` + `Archive` + `Copy` + `Download` + `Delete`（危险色）+ `Cancel`，各项按选中数量置灰（`disabled`）。
* **标签栏继续收边（`Sidebar.tsx`）**：外框 `rounded-lg p-0.5` → `rounded-md p-px`，标签单元与按钮改 `rounded` / `px-1.5 py-0.5`，非选中态才挂 hover 底色；选中态操作区改为**绝对贴右**（`absolute right-0 top-0 h-full gap-0.5 pr-0.5`），不参与标签标题居中计算，切栏时标题位置不再跳动。
* **「按来源会话分组」收敛进 ⋮ 菜单（`Sidebar.tsx`）**：移除作业根行与标签栏上的 `MessagesSquare` 独立图标按钮（`groupToggleButton`），改为在 `⋮ More actions` 菜单中新增 `Group by conversation` 项（仅 homework 根目录 / 根作用域出现），图标按当前状态着 `var(--primary)`。
* **交互细节收口（`Sidebar.tsx`）**：行内 `⋮` 菜单任意项点击后立即收起（含 Delete 等未自行关闭的项），避免菜单悬留；单文件标签弹层打上 / 取消标签后立即收起，与批量标签弹层行为一致；行菜单 `Copy` 文案明确为就地复制（`Duplicate this item in place`）；移除行菜单与 materials 菜单中的 `Paste` 项（粘贴入口连同 `handlePaste` / `ClipboardPaste` / `clipboardLabel` 一并下线）；侧栏右缘调宽把手去掉 hover 高亮，改为无可见视觉的拖动热区。
* **面板拖拽把手隐形化 + 项目图标配色（`CanvasFlow.tsx`）**：右侧面板左缘把手由「hover 变宽变蓝」改为固定 4px 隐形热区（`w-1` + `backgroundColor: transparent`，移除 hover 拉伸与 `transition`），仍可拖动调宽；侧栏「当前项目文件夹」按钮的 `Folder` 图标固定为紫色 `var(--primary)`，与展开态项目行的 Folder 图标一致。

### 说明

* 本版改动两个文件：`src/components/canvas/Sidebar.tsx`（侧栏结构与多选条）+ `src/components/canvas/CanvasFlow.tsx`（面板把手与图标配色）。

## v0.5.434 (2026-09-16)

### 变更

* **根目录标签栏两栏改为等宽平分（`Sidebar.tsx`）**：标签栏单元由「选中项才 `flex-1`、未选中项按内容宽」改为**两栏恒 `flex-1`**，选中态只改变底色 / 阴影，不再让两栏宽度随选中项跳动。
* **标签内边距收紧**：切换按钮由 `gap-1.5 pl-2` + `pr-1`/`pr-2` 调整为 `gap-1 pl-1.5` + `pr-1`/`pr-1.5`，两栏等宽后留白更紧凑。

### 说明

* 本版仅此一处改动（`src/components/canvas/Sidebar.tsx`），是在 v0.5.433 标签栏基础上的纯样式微调，无行为与数据变化。

## v0.5.433 (2026-09-16)

### 变更

* **工作区根目录标签栏升级为「目录级操作入口」（`Sidebar.tsx`）**：把两栏的目录级操作统一收拢到**选中标签**上并常显——标签筛选（`tagFilterButton`）、作业视图的分组切换（`groupToggleButton`，按来源会话分组 ↔ 扁平清单）、以及 `⋮ More actions` 菜单；标签栏上的 `⋮` 不再依赖 hover 渐显（`dirMenuButton(rel, scope, alwaysVisible = false)` 新增第三参数，标签栏传 `true`）。标签栏单元由单个 `<button>` 改为 `<div>` 包裹「切换按钮 + 选中态操作区」。
* **两栏项目下移除 materials / homework 根行**：`renderMaterialsRoot` / `renderHomeworkRoot` 改为仅在单栏项目（无标签栏）时渲染；两栏项目下名称与计数完全由标签承担、列表恒展开，`materialsExpanded` / `homeworkExpanded` 不再参与渲染。
* 随之取消「点击标签时自动展开该栏」的补偿逻辑：两栏项目下根行已移除、列表恒展开，不再存在点完标签只见一行标题的情况。

### 说明

* 本版仅此一处改动（`src/components/canvas/Sidebar.tsx`），是对 v0.5.432 标签栏的交互收口；**单栏项目行为与改动前一致**（筛选 / 计数 / 分组切换 / ⋮ 仍留在根行，`⋮` 仍为 hover 渐显）。

## v0.5.432 (2026-09-16)

### 新增

* **工作区根目录「Materials / Homework」标签栏（`Sidebar.tsx`）**：当工作区同时存在 `materials` 与 `homework` 两个根目录时，在目录树顶部新增一条分段标签栏，一次只渲染其中一栏，其余根目录仍在下方顺排；标签各自带上条目数（取 `materialRows.length` / `homeworkRows.length`）。只有其中一个根目录时标签栏隐藏，按存在的那一栏直接渲染（`activeRootTab` 回退）。当前选中栏为纯会话内状态（`wsRootTab`，不落盘）；若目标栏此前处于折叠态，切换时会自动展开（复用既有的 `bob.workspace.expanded.` 持久化展开集），避免点完标签只看到一行标题。

### 说明

* 本版仅此一处改动（`src/components/canvas/Sidebar.tsx`），回归面集中在工作区侧栏的根目录渲染；tag 过滤、多选批量打标签、归档箱等既有行为不受影响。

## v0.5.431 (2026-09-16)

### 新增

* **md 多端分发内核 `src/lib/md-export/`（DocIR + ExportTarget 两层契约）**：把「markdown → 各平台产物」从散落在各组件里的实现收敛为可复用内核，新增 5 个文件：
  * `types.ts` —— 契约层：`ExportFormat`（`png` / `clipboard-html` / `text` / `docx` / `pdf`）、`ExportRatio`、`PlatformSpec { id, label, limits, formats }`、`ExportArtifact`（`images` / `clipboard-html` / `text` / `file` 四型联合）。
  * `ir.ts` —— DocIR 归一化，唯一解析点 `parseDoc(markdown, { source, path })`；另有 `chatToMarkdown(question, answer)`、`stripFrontmatter`、`hashText`（31 进制短哈希）、`inlineText`，以及启发式 `pickTitle` / `pickHook`（`HOOK_MAX = 40`）/ `pickStats`（`STAT_MAX = 6`）。
  * `check.ts` —— 平台约束体检：`checkDoc(ir, spec)` / `summarizeChecks(items)`，产出 `CheckItem { key, level, msg, fix? }`；阈值 `PARA_CHAR_WARN = 110`、`SHORT_PARA_RATIO = 0.4`、`SHORT_PARA_CHARS = 12`、`TABLE_COL_WARN = 4`。
  * `targets/xhs.ts` —— `XHS_SPEC`（`titleMax 20` / `bodyMax 1000` / `imageMax 18` / `ratios ['3:4']` / `unsupported ['code']`）与 `XHS_GEOMETRY { width:414, height:552, pad:24, exportRatio:3, bodyCap:420 }`。卡片渲染仍在既有 `XhsCard.tsx`，此处只抽出规则与几何常量。
  * `targets/wechat.ts` —— `WECHAT_SPEC`（`titleMax 64` / `bodyMax 20000` / `ratios ['2.35:1','1:1']` / `unsupported ['code']`）与 `renderWechatArticle(ir)`：产出**全内联样式**的 `<section>` 结构（列表超 10 项或单项超 100 字退化为 `<p>· xxx</p>`；表格、代码块降级为灰底 section），仅 `mp.weixin.qq.com` 域名保留 `<a>`。
* **统一导出入口 `ExportMenu`**：md 阅读器右键菜单由单一「DOCX」升级为分组菜单——Image（小红书卡片 / 品牌分享卡）、Article（微信文章）、Document（Word (DOCX) / PDF 打印），入口提示由 `DOCX` 改为 `Card/DOCX/PDF`；卡片类面板改为点击时才惰性取快照，草稿身份用 `docKey || hashText(markdown)`（优先文件路径、其次节点 id），同一节点反复导出不再串稿。
* **微信文章导出弹窗 `WeChatArticleDialog`**：`parseDoc` → `renderWechatArticle` → `checkDoc(doc, WECHAT_SPEC)` 三步；左侧 375px 预览、右侧体检报告；底部 `Copy plain text` / `Copy for WeChat`——后者以 `ClipboardItem({ 'text/html', 'text/plain' })` 双格式写剪贴板，适配公众号编辑器剥离 `<style>`/class、只认 inline style 的行为。
* **导出前平台体检 `CheckReport`**：`Pre-flight check` 面板按 `fail` / `warn` / `pass` 分级着色，汇总 `N blocking issue(s) · M warning(s)` / `All checks passed`；**`fail` 只提示、不硬阻断导出**。
* **文件归档箱**：新增 `ArchiveDialog`（列表 `GET /api/materials?action=archived`、批量恢复 `POST action=set_archived`、逐项永久删除 `DELETE`），侧栏行菜单新增 `Move to the archive`，底部新增 `View archived items` 入口；归档目录 `.archive/`，同名自动追加 ` (1)`，不参与标签候选。
* **标签体系作用域化与批量**：`lib/files/tags.ts` 新增 `TAG_SCOPES`（白名单，防路径穿越）、`MAX_TAGS_PER_FILE = 12`、`MAX_TAG_LENGTH = 24`、`normalizeTag` / `normalizeTags` 与 `setFileTagsBulk`（一次读 + 一次落盘，多选批量打标签不再互相覆盖）；`api/materials` 新增 `action=set_tags_bulk`；`api/local-files` 在 `rename` / `paste` / `delete` / `delete_homework` 上接入标签键迁移（`transferFileTagsRename` / `transferFileTagsRemove`），重命名、移动、删除后不再残留旧键。
* **团队流停滞观测**：`TeamChatStream` 新增 `useStallHints` / `StallTrackItem` / `fmtDuration`，成员长时间无进展时渲染 `Possibly stalled · no progress for …`；`TeamWorkbench` 复用同一套工具，并抽出 `MarkdownBody` 统一流内 markdown 渲染。
* **团队审批门禁补齐「成员缺失」分支**：`team-run.ts` 新增 `droppedMemberIds`（预置成员中已卸载 agent 的差集），与「额外成员」同样触发审批；`api/chat` 的 `team_confirm` 帧把其映射为 `droppedMemberNames` 下发，确认卡可展示具体缺失哪些成员。

### 变更

* **输入框内核抽取 `components/canvas/composer/`**：`useComposer.ts`（含 `uploadAttachment` / `buildContextBlocks` / `ComposerContext` 等）、`ComposerChips.tsx`、`MentionMenu.tsx` 从 `ChatNodeKernel` / `TeamWorkbench` 中抽出，对话与团队两个输入框改为共用同一内核（组件对外行为不变）。
* **`XhsCard` / `ShareCard` 改为消费 md-export 内核**：几何与上限由 `XHS_GEOMETRY` 派生、解析统一走 `parseDoc`、体检走 `checkDoc`，两组件新增 `docKey` prop；`ShareCard` 一并改用 `stripFrontmatter`。
* **`api/materials` 契约扩展**：GET 新增 `archived` / `tags`，POST 新增 `set_archived` / `set_tags_bulk`，DELETE 变为作用域感知（`.archive/` 下永久删除）。
* `EVENT_TEXT_CAP = 600` 由硬编码 `t.slice(0, 600)` 具名化（行为等价）。

### 说明

* 设计依据：《md 阅读器多端分发方案》中 P0（小红书卡片、品牌分享卡）与 P1-1（微信文章）已落地；**微博与独立的「设计稿海报」target 未实现**，`PlatformSpec.id` 中的 `'poster' | 'weibo'` 目前仅为预留联合成员。
* 团队侧改动（审批门禁、停滞观测、composer 抽取）与 md 多端分发为两条独立线，互不影响；回归面集中在 md 阅读器与资料面板。

## v0.5.430 (2026-09-16)

### 变更

* **多智能体协作：团队视图新增发起口，`Multi-agent mode` 按钮暂留（双入口并存）**：团队视图从「观测面」升格为**可发起口**——空态直接给出「需求输入 + 选择成员 + 发起协作」，已有团队时顶部提供可展开的「新建协作」行。
  * **对话输入框下方的 `Multi-agent mode` 按钮（原「开关 + 弹窗选成员」入口）本次不删除**：团队视图仍在开发中，两个入口暂时并存；待团队视图成熟后再收口为唯一入口。恢复该按钮的落点为 composer 底部工具行左侧（`Users` 图标，开启态高亮；点击唤起 `TeamMemberPickerDialog`，弹窗内 `Turn off` 关闭）。
  * 发起不新起链路：需求文本交给宿主节点作为**同一轮** `/api/chat` 消息发出（新增 `launchTeamRun` → `doSend(text, { multiAgent: true })`），请求体显式带 `multiAgentMode` 而不依赖 state 提交时序；发起后自动切到团队视图，成员分工 / 任务进展 / 协作过程就地可见。
  * `TeamWorkbench` 新增 `LaunchPanel`（需求 textarea + 选成员 + 发起，Enter 发起 / Shift+Enter 换行），成员名单仍由节点持有（`TeamMemberPickerDialog`，仅会话内、每次重选）；**主 agent 整合的最终回答仍回落到对话流**，不被吞进团队视图。
  * 视图分栏控件 `[Chat | Trace | 团队]` 改为**常驻渲染**（原先需已有消息或团队才显示），空会话节点也能直接进入团队视图发起协作。

### 说明

* **能力不受影响（已逐项取证）**：团队视图与 `Multi-agent mode` 按钮走的是**同一套引擎链路**（`team_run` → `team_create/plan/approve` → 引擎 `pump()`），差别只在交互形态；两个入口共享同一份节点状态（`multiAgentMode` / `presetAgentIds`），唤起的是同一个 `TeamMemberPickerDialog`。原担心的两处「真打折点」均已排除：
  * **`team_confirm` 批准卡**：`useConfirm().render` 是 `createPortal(..., document.body)` 且挂在节点根渲染树内（`{confirmRender}` 位于 pane 三元分支**之外**），与切到哪个分栏无关；团队视图下输入框不渲染 → `inputAnchor()` 返回 `null` → 卡片按 [ConfirmDialog.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ConfirmDialog.tsx#L91) 的锚点缺省路径**视口居中**弹出（带遮罩），依然可见可点。
  * **成员选择器**：`TeamMemberPickerDialog` 同为 portal + `z-[90]`，发起区「选择成员」按钮直接唤起，名单状态仍由节点 `presetAgentIds` 持有，与原先弹窗完全同源。
  * 成员间留言互通（宿主全代理 relay）不受入口变化影响：机制在 `team-run.ts` 内，与 UI 入口无关。
* **对话区去冗余（不改变数据层）**：移除对话视图里对多智能体过程的重复呈现——`TraceProcessSummary` 的成员分支卡片 / 群聊流切换（含 `agentView` / `agentOpen` 状态）与 `TeamChatStream` 内联块一并删除，`estimateProcessRows` 与 `hasInlineTrace` 同步去掉成员维度。`TeamChatStream.tsx` 组件本身保留（`TeamWorkbench` 主区仍在用）。SSE `subagent_update` 的摄取与落盘链路**未动**：`rememberTeamId(panel.teamId)` 仍是节点 ↔ 团队绑定的唯一来源，`subagents` 快照仍随回答写入节点 RMETA 作为运行记录。
* **零回归**：`tsc --noEmit` exit 0；`TeamWorkbench.tsx` eslint 零问题，`ChatNodeKernel.tsx` 与改动前同为 31 problems / 8 errors（均为存量 `any` / `prefer-const`，逐项核对非本次引入）；`vitest run` 16 文件 / 253 用例全绿。

## v0.5.429 (2026-09-16)

### 新增

* **团队工作台视图（节点内「多 Agent 群聊」形态）**：`ChatNodeKernel` 顶部新增 `[对话 | Trace | 团队]` 分段控件，**同节点内切换视图**（不新增页面/路由）；`团队` 面板为 `TeamWorkbench`：
  * 主区沿用 `TeamChatStream`（`fill` 模式撑满高度）呈现群聊式协作时间线（建队 / 开工 / 完成发言 / 成员间留言 / 收口）；
  * 副栏 `w-[184px]` 列成员状态与任务 DAG（状态、assignee、依赖）；
  * 底部插话行：`msg_send` 投递，支持「全体成员」广播与按成员定向，Enter 发送；
  * 失败任务可就地 `task_retry` 重试；
  * 产出区支持全文阅读态（`result_collect`）。
* **宿主侧团队数据层**（全部经 MCP 读取，宿主不直连引擎数据目录）：
  * `GET /api/team/list` —— 团队清单（`team_list`）；
  * `GET /api/team/<id>` —— 团队面板 + 产出（`team_status` + `result_collect`）；
  * `GET /api/team/<id>/stream` —— **SSE 增量流**（首帧全量 `panel` 快照 + 事件增量 + 产出增量 + 终态 `panel`；1.5s 轮询，连续 3 次失败断开，25s keepalive 心跳）；
  * `POST /api/team/<id>/control` —— 干预（`msg_send` / `task_retry`）。
* **`lib/chat/team-client.ts`（服务端 MCP 客户端）+ `lib/chat/team-events.ts`（纯映射，两端共用）**：工具调用口径（`parseToolOutput` 兼容裸 JSON 与 `content[]` 文本）、`ensureTeamReady` 伺服器就绪、`Error:` 前缀抛异常；映射函数无 MCP / Node 依赖，可被客户端组件直接引用。
* **节点 ↔ 团队绑定持久化**：`team_run` 后自动把 `teamId` 登记进节点 frontmatter `team_ids`（`node-markdown.ts` / `api/nodes` / `CanvasFlow` 透传），节点重开即可回到团队面板。

### 变更

* **`bob-team-mcp` 引擎侧三项修正（`0.1.1 → 0.1.2`）**：
  1. **事件真相源下沉**：新增 `<teamId>.events.jsonl`（append-only，与 `TeamState` 同目录），`store.ts` 提供 `eventsPath()` / `emitTeamEvent()` / `readTeamEvents(limit)`。在团队锁内 `await` 落盘，保证事件顺序与状态快照一致；落盘失败静默（观测数据不得阻塞调度）；`.jsonl` 后缀不会被 `listTeams()` 误收为团队。`panelStatus()` 随面板暴露 `events`（最近 50 条），故 `team_status` 自动携带。
  2. **冷恢复**：`cli.ts` 的 `main()` 内 `void recoverTeams()`，对 `approved | running` 且非全终态的团队补一次 `pump(id, { coldRecover: true })`；`recoverStalled(forceAll)` 忽略心跳时间，把上个进程遗留的 `claimed / running` 认领一律视为僵尸直接接管回 `ready`（否则重启后 15 分钟内不会有任何调度），并把「消息唤醒占位」的 `busy` 成员复位 `idle`。
  3. **`pump()` 加「有信就唤醒」**：空闲成员手上还有未读直消息（含广播）时，即使无 `ready` 任务也占 `busy` 并锁外 `wakeForMessages()` 唤醒一次。成员一次发言 = 一次一次性 HTTP 请求、未读消息只在唤醒瞬间注入 prompt，缺此分支时「给空闲成员 `msg_send`（尤其在团队已无 ready 任务时）」= 石沉大海，用户插话机制不成立。
  * 另：`pump()` 终态判定新增一次 `team_done` 事件（去重标记 `TeamState.doneAnnounced` 随团队落盘，团队回到非终态时复位，允许再次终结——详见下方说明）。
* **SSE 路由连接清理修正**：`cancel()` 回调收到的是 `reason` 而拿不到 `controller`，原按 `WeakMap<Controller>` 反查清理函数永不命中，客户端断开后轮询与心跳定时器不会停止（每开一次团队视图泄漏两个定时器）。改为请求级 `dispose` 闭包，`start` 内登记、`cancel` 内调用，模块级状态已删净。

### 说明

* **真相源在引擎侧**：宿主不直接访问 `~/.bob-team-mcp/.team/`，事件与产出全部经 MCP 工具读取；SSE 只是对 `team_status` 面板的增量差分推送（`panelKey()` 指纹判变）。
* **本期干预能力边界**：只读 + `task_retry` + `msg_send`；团队级暂停/终止、改派 assignee 留待下一期。
* **零回归**：宿主 `tsc --noEmit` exit 0；`eslint` 改动文件无新增（`ChatNodeKernel.tsx` 与 `git HEAD` 同为 32 problems / 8 errors，逐项对账一致）；`vitest run` 16 文件 / 253 用例全绿；`bob-team-mcp` 重建 dist 并独立脚本验证通过（22 passed / 0 failed）。
* **跨进程契约取证**：以 MCP SDK 直连 `bob-team-mcp/dist/cli.js`，核对 5 个工具的入参名、面板字段形状、`result_collect.collected[]` 回收、未知团队返回 `Error:` 前缀——46 项通过；5 项为**终态团队选填字段缺省**的预期差异（`currentTaskId` / `progressText` / `attempts` / `error` / `qualityStage` 在为空时引擎省略键），非契约不符。
* **实盘验证（团队 `59e0e844`「事件流验证组」，2 成员 / 2 任务带依赖）**：`m1` 先做卖点、`m2` 依赖其产出压标语，约 26s 跑完全终态，`<teamId>.events.jsonl` 落盘 7 条（`system` 计划生成 → `team_start` → `member_start`×2 → `member_done`×2 → `team_done`）。宿主侧同一条链路复核：`GET /api/team/list` 与 `GET /api/team/<id>` 正常（事件映射 7 条、产出按键 `t1`/`t2` 回收、`cursor` 为末条事件 id）；SSE 首帧 `panel` 携带全量事件；随后经 `POST /api/team/<id>/control` 发一条 `msg_send` 给空闲的 `m1`，流上收到 `events` 增量帧（`relay` 投递行 + `member_start`）、成员状态 `idle → busy → idle`、再收 `member_done` 增量帧——「有信就唤醒」与事件流增量推送端到端成立。
* **`team_done` 播报去重改为落盘标记**：原用进程内 `Set`（`terminalEmitted`）去重，引擎重启后失效——对已终态团队再 `pump`（如插话唤醒）会重复补播一条「团队已终结」。改为 `TeamState.doneAnnounced`：`pump()` 每次按 `emitDone = terminal && !team.doneAnnounced` 判定并回写 `team.doneAnnounced = terminal`，团队回到非终态时随之下次 `pump` 复位、允许再次终结。实盘验证（团队 `59e0e844`）：首轮新进程补播 1 次并落标记（历史团队无标记，一次性），**再起新进程触发 `pump` 时不再重复**；契约脚本仍 46 passed / 5 failed。
* **`task_retry` 语义确认**：仅接受 `failed` 任务，对 `done` 任务返回 `Error: Task t2 is done — nothing to retry`；宿主 [TeamWorkbench.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/TeamWorkbench.tsx#L349) 的重试按钮本就只在 `t.status === 'failed'` 渲染，两侧口径一致。

## v0.5.428 (2026-09-15)

### 修复

* **依赖产出注入改由引擎在唤醒瞬间完成（根治 v0.5.427 宿主 relay 的结构性失败）**：日志取证证实宿主侧 relay 不可行——轮询粒度（2s）永远慢于引擎的认领瞬间。实测团队 `f17ae851` 中 `t1` 于 `…741672` 完成，`t3` 在 `…741676`（4ms 后）即被认领并快照任务书，宿主 `msgmu2u7alk5`（依赖产出·风险清单）与 `msgmu2u7c5o9`（依赖产出·产品定义）落入 `m3` 邮箱时下游**早已被唤醒**，两条均停在 `delivered: false`，从未被读到。故下线宿主代投，改由 `bob-team-mcp` 引擎在 `pump()` 认领后、构造成员任务书的瞬间直接从 `task.result` 注入。
* **`pump()` 补齐 assignee 指名语义（A1，`bob-team-mcp/src/engine/scheduler.ts`）**：原实现按 `idle × ready` 顺序配对，完全不看 `assignee`——实测 `t3.assignee = "m3"` 却被 `m1` 执行（`msgmu2u8lo1a` 的 from 为 `m1`，且 `m3` 无 session 文件、`messageCount: 0` 从未被唤醒），分工形同虚设。现改为**两轮认领**：先消化 `assignee` 指向在世成员的任务（指名优先），再让本轮未获任务的空闲成员兜底认领无主任务（`assignee` 空缺 / 指向已不存在成员，覆盖 `removeMember` 退回 ready 但保留 assignee 的情形），用 `taken` 集合防重复认领。此即 dsh 上游 `nextReadyTask` 的语义，属移植丢失代码的收敛。
* **`buildMemberUserPrompt()` 注入已完成上游依赖产出（A2）**：新增 `collectDependencyOutputs()`（拓扑收集全部已完成祖先，三色标记防环）与 `formatDependencyOutputs()`（单条 2000 / 合计 12000 字符上限，超限从最旧开始丢弃、保底保留最后一条），在任务书 `[团队任务 #id] …` 之后插入 `[已完成的上游依赖产出]` 段并以「以上是你所负责任务的上游产出，作为输入材料承接，不要忽略」收口，对齐 dsh 原版 `collectCompletedDependencyOutputs` + `formatDependencyOutputs`。产出正文先剥离 `[[msg to=…]]…[[/msg]]` 留言协议块与 `<think>` 推理块，防协议噪音污染下游任务书。**时机无竞态**：认领即读，ready 门槛已保证上游全 `done`。

### 变更

* **下线宿主侧依赖产出转投全套**：删除 `lib/chat/team-run.ts` 的 `relayDependencyOutputs()`、`TERMINAL_STATUS`、`DEP_OUTPUT_CAP`、`handoffCount` / `relayedOutputs`、轮询 tick 内的调用块、汇总文本「依赖产出：已向…转投 N 条」一行；`MEMBER_MSG_PROTOCOL` 相应改为说明「依赖产出由引擎注入任务书，无需宿主转投」。`team_run` 工具描述（`tools/index.ts`）的 `tasks` 项同步改为「引擎在成员被唤醒时把已完成依赖结果注入下游任务书」。
* **成员间留言中转保留不动**：留言仍走宿主 `msg_send`（引擎无「成员→成员」工具），该链路不依赖时序，实测有效。

### 说明

* `bob-team-mcp` 版本 `0.1.0 → 0.1.1`（本次为首次改动引擎侧；`files: ["dist"]` 只约束 `npm publish`，本项目无发布流程，不影响本地加载）。
* **零回归**：`bob-team-mcp` `npm run build`（tsc + esbuild）通过且 `dist/cli.js` 已含新逻辑；宿主 `tsc --noEmit` 通过；`eslint` 改动文件无新增错误（`tools/index.ts` 两处为既有问题）；`vitest run` 16 文件 / 253 用例全绿。
* **回退基线**：`~/.bobwork-backup/bob-team-mcp-20260915-235259`（src + dist + package.json）。

## v0.5.427 (2026-09-15)

### 新增

* **上游产出注入下游（依赖产出转投，宿主侧验证版）**：本移植版的 `dependencies` 只作 ready 准入门槛，下游成员的任务书里看不到上游产出（dsh 原始版有 `collectCompletedDependencyOutputs` + 把「已完成依赖结果」段注入任务书，移植时未带过来）。现在由宿主侧补齐这段语义——`lib/chat/team-run.ts` 新增 `relayDependencyOutputs`：轮询 tick 里发现刚 `done` 的任务，就把它剥离留言块后的正文经 `msg_send` 投递给每个下游任务的 `assignee` 邮箱（下游成员下次被唤醒时读到），正文前缀 `〔依赖产出 · 任务「Y」（由成员「X」完成）〕` 并以「请作为输入材料承接，不要忽略」收口（对齐 dsh 原版 `formatDependencyOutputs` 的语义）。
  * **bob-team-mcp 零改动**：全部建立在既有 `team_status` / `result_collect` / `msg_send` 之上，不重编 `dist`、不动打包链。
  * **去重自持**：键为 `上游taskId:上游attempts:下游taskId`（`relayedOutputs`），上游因质量链/自动修复重跑（attempts 递增）时允许再投一次，同一次尝试内不重复投递。
  * **投放范围**：只投给「有明确 `assignee`（成员 id）且未终态（非 done/failed）」的下游任务——自由认领的任务没有确定收件人，跳过。
  * **单条截断**：`DEP_OUTPUT_CAP = 2000`（对齐 dsh 原版单条上限），防止个别长产出挤爆下游成员上下文。
  * `MEMBER_MSG_PROTOCOL` 补一句：前缀为「〔依赖产出 · …〕」的直消息是宿主自动转投的上游依赖产出，直接当输入材料用，不要在产出里复述。
  * `team_run` 工具描述（`tools/index.ts`）的 `tasks` 项补一句「已完成任务的结果会自动投递给其下游任务的成员，因此请用 dependencies 表达真实数据流」，便于主 agent 把 DAG 编成数据流而非仅串行约束。
  * 群聊流：转投明细复用既有 `relay` 事件（`from` = 上游成员名、`to` = 下游成员名），前端零改动即可看到「上游 → 下游 〔依赖产出 …〕」行。

### 说明

* **与 dsh 的已知差异（验证版语义）**：宿主 relay 绕开引擎 attempt 记账（引擎不知道这次投递），且投递时机受轮询粒度限制——若下游成员在产出到达前已被唤醒、或下游任务已终态，该次投递不会被读到。此差异即验证版「够用即可」的边界，若实测收益明显，再议是否正式上收进 MCP 并同步 dsh 上游。
  * ⚠️ **已于 v0.5.428 废弃**：实测该差异为结构性失败（轮询永远慢于引擎认领瞬间，产出从未被读到），宿主 relay 已整体下线，改由引擎侧注入。
* **汇总文本**：新增一行「依赖产出：已向上游任务的下游成员转投 N 条产出」，投递异常并入既有「投递异常」行。
* **零回归**：`tsc --noEmit` 通过；`vitest run` 16 个测试文件 / 253 个用例全绿。

## v0.5.426 (2026-09-15)

### 新增

* **多智能体协作过程「群聊流」视图**：把 `team_run` 的编排过程从「分支卡片快照」之外，再外推成一条**按时间累积的对话式时间线**（谁建了队、谁开工、谁完成说了什么、谁给谁留了言、最终收口），过程区左上角可切换 `群聊流 / 分支卡片` 两种形态，默认群聊流。
  * 共享类型：`lib/types.ts` 新增 `TeamChatEvent` 联合类型（`team_start` / `member_start` / `member_done` / `member_failed` / `relay` / `team_done`），并给 `ChatMessage` 增加可选字段 `subagents`（面板快照）与 `subagentEvents`（时间线）。
  * 编排侧：`lib/chat/team-run.ts` 的 `onProgress` 回调签名扩展为 `(p, events?)`——`p` 仍是**逐帧全量快照**（供分支卡片），`events` 是**本帧新增**的增量事件（可能为空）。事件来源三处：成员状态迁移 diff（`diffMemberEvents`，附带刚 collect 到的产出摘要，正文按 `EVENT_TEXT_CAP = 600` 截断，完整产出仍在汇总文本里）、成员间留言投递明细（`relayMemberMessages` 新增返回 `delivered[]`）、以及建队 `team_start` 与收口 `team_done`。因建队与收口不在轮询帧上，编排侧引入事件缓冲（`pendingEvents` + `flushEvents`），把非快照时点的叙述搭在随后的一帧上下发。
  * 通道：`/api/chat` 与 `ToolExecContext.onTeamProgress` 透传，SSE 帧 `subagent_update` 旁新增同帧 `subagent_events`（只含本次新增）。
  * 前端：`ChatNodeKernel.tsx` 收帧累积事件到会话内存并随消息更新；新增呈现组件 `components/canvas/TeamChatStream.tsx`（纯呈现、零新依赖）——系统行居中细线、成员行圆形首字头像 + 呼吸点/✓/✕、留言行缩进加 `from → to`，流式中自动贴底滚动。

### 变更

* **`team_run` 审批卡改为精简版（常规卡与「推荐补充成员」卡都适用）**：原先审批卡把「目标 + 全部成员 + 全部任务 DAG」一次性铺在主文案里，成员与任务一多正文即 20 行上下（约 540px），而卡片锚定在输入框上方向上生长且无高度上限，顶部会被顶出视口（表现为「溢出容器」）。现在主文案只留概述——常规卡为 `Goal` + `Members: N · Tasks: M`，「推荐补充成员」卡为 `+ 新增成员名` 列表；成员清单与任务 DAG 一律折叠进 `details`，点 `View details` 才展开。
  * `ConfirmDialog` 的 `ConfirmDialogOptions` 新增可选 `details`：默认折叠、展开区 `max-h-[40vh]` 内部滚动 + `break-words`，每张新卡片重置为收起；不传 `details` 的既有调用方行为一字未改。

### 说明

* **单 agent 路径零影响**：`subagent_events` 只在 `runTeam` 执行期间的 `onTeamProgress` 里产生，前端所有分支仍 gate 在 `subagents?.members?.length`，单 agent 时事件数组恒为空、连 DOM 节点都不产生。
* **事件不落盘 + 重启降级**：`subagentEvents` 只活在会话内存（不写 frontmatter / 节点 data），重启后事件为空时 `TeamChatStream` 由 `subagents.members` 快照合成等效时间线（`queued` 跳过、`running`→开工、`done`→完成+摘要、`failed`→失败），视图不空但精确度降级。
* **零回归**：`tsc --noEmit` 通过；`vitest run` 16 个测试文件 / 253 个用例全绿（新字段均可选且不参与 RMETA 序列化）。

## v0.5.425 (2026-09-15)

### 新增

* **项目资料标签体系**：新增 `<项目>/materials/.tags.json`（`MATERIAL_TAGS_FILE`）持久化「资料相对路径 → 标签数组」映射，配套服务端 `GET /api/materials?action=tags`（读取全表）与 `POST action=set_tags`（写入单条，经 `normalizeTags` 归一化：去空、去重、保序）。
  * 侧边栏资料面板新增标签编辑（行内标签按钮 → 弹出输入）与标签筛选栏：多选为「同时具备」（`every` 匹配），`Untagged` 只筛未打标签项且与具体标签互斥，另提供 `Clear` 一键清空；全部已知标签取「各资料标签并集 + 当前筛选值」去重排序后成列。
  * 资料重命名 / 移动时同步迁移标签表键（`renameMaterialTags`）与可检索索引条目（`renameMaterialsIndex`）；`resolveMaterialsRename` 限定源与目标须同处一个 `<项目>/materials` 根内，跨出 `materials` 根则不动附属数据。

### 变更

* **资料面板改为扁平清单**：`materials` 子树经 `flattenMaterials` 摊平为「以文件为单位」的单列清单（`MaterialRow`：`rel` / `name` / `parent`），目录仅用于定位、嵌套层级降级为文件名旁的归属路径提示；随之取消树内拖拽分组——界面不再按目录分组，改用自定义标签筛选组织资料；资料根行不再可折叠，保留上传 / 授权入口与文件计数。

### 说明

* 本版本同时包含 v0.5.421–v0.5.424 四条已记录但此前未发布的改动（成员间消息通道 / 协作审批门禁 / 移除名册 / 成员预设名单 + AI 临时补充审批）——0.5.420 之后源码的全部变更随本版本一次性发布；GitCode 上不会出现 v0.5.421–v0.5.424 的独立 tag。

## v0.5.424 (2026-09-15)

### 新增

* **多智能体协作成员改为「用户预设名单 + AI 临时补充（须批准）」**：名册移除后补齐成员来源的两端——用户为本次执行挑人，AI 判断人手不够时推荐补充但必须经用户批准。
  * 前端：新增 `TeamMemberPickerDialog`（成员选择弹窗）——点击 `Multi-agent mode` 按钮弹出，候选为已安装的 Agent 包（`GET /api/agents`，滤掉内置画像与已禁用项，与画布 `＋ Add session` 菜单同口径），勾选后作为**本次执行**的成员名单；确认即开启开关（开关本身仍持久化 frontmatter `multi_agent_mode`），弹窗内 `Turn off` 可关闭模式。名单**只存会话内不落盘**，每次点按钮重新选（`presetAgentIds` 仅随当次 `/api/chat` 请求发送）。
  * 服务端注入：`/api/chat` 接收 `presetAgentIds`，生成「本次成员名单」段落（名单非空 = 列出 `label（identity: id）` 并要求优先使用、克制补充；名单为空 = 说明由主 agent 自行编排但需用户批准），与 `MULTI_AGENT_RULES` 拼接后经 `prependDynamicContext` 注入最后一条 user 消息（不进 system，守前缀缓存红线）。
  * 强制审批门禁：`runTeam` 新增 `presetAgentIds` 判定——凡成员 `identity` 不在名单内（含未指定 identity 的默认成员）即视为「AI 临时补充」，即便策略档位为 `allow_scope` 也强制走确认卡（`TeamRunDraft.extraMemberNames` 携带补充成员名字）；`presetAgentIds` 为 `undefined` 的非 route 路径（单测）保持既有行为逐位不变。
  * 确认卡点名：`team_confirm` 帧新增 `extraMemberNames`；前端收帧后，若为 AI 推荐补充触发的审批，卡片标题改为 `Approve extra members?` 并单独列出建议补充的成员（`+ 成员名`）与「须批准后才运行」说明。

### 说明

* 名单不落盘：不写 frontmatter、不进节点 data、不进 `persistAgentState`；关闭模式时清空名单。
* 审批通道复用既有 `onTeamConfirm → createPendingConfirm → confirmAsk → POST /api/chat/confirm`，未新增通道。

## v0.5.423 (2026-09-15)

### 变更

* **移除「多智能体名册」（Multi-agent mode roster）功能**：彻底删除节点级成员清单配置的前后端全链路，多智能体协作的成员改由主 agent 在每次 `team_run` 调用中按任务临时编排给出。
  * 前端：删除 `TeamRosterDialog`（成员挑选 / 绑定 Agent 身份 / 写职责 / Automatic 选项 / 逐位 Turn off）及其 `teamMembers` / `teamRosterOpen` 状态；`Multi-agent mode` 开关改为**直接开关模式**（点击即开/关，不再先弹名册弹窗），按钮去掉成员数角标与 roster 提示文案；`persistAgentState`、节点 data 与节点 memo 快速比较的 `extraKeys` 同步去掉 `teamMembers`；顺带清理仅供名册弹窗「+ New Agent」使用的 `new-agent-request` 事件监听。
  * 服务端：删除 `normalizeTeamMembers`（请求体归一化）与 `buildRosterRules`（「## 指定成员名册（Roster）」编排规则注入），`/api/chat` 不再接收 `teamMembers`，`MULTI_AGENT_RULES` 恒为唯一注入内容；`ToolExecContext.teamMembers` 与 `team_run` 执行器的 `roster` 透传一并移除。
  * 宿主侧：删除 `enforceRoster` 收敛逻辑（以名册为准的补齐/剔除/identity 校验）与仅供其使用的 `installedAgentIds`；`TeamRunOptions.roster` 选项删除，`runTeam` 直接采用主 agent 传入的 `members` / `tasks`。
  * 持久化：`TeamMemberConfig` 类型、`AiChatNodeData.teamMembers`、frontmatter `team_members`（读写两向）、`/api/nodes` 的 `update_agent_state` 落盘分支与节点列表回填字段全部删除。

### 说明

* **无回归**：`enforceRoster` 原本在名册为空时即原样放行（返回主 agent 成员），即「自动编排」路径从不经过收敛逻辑；删除名册后该路径行为逐位一致，未削弱既有自动编排能力。
* 节点 frontmatter 中历史遗留的 `team_members` 字段不再被读取，也不会再写出（重开旧项目时该字段被自然忽略）。
* 多智能体协作的成员来源改为「预设 Agent + 主 agent 按任务临时编排」，具体的「AI 临时补充成员」开关与裁决路径另行设计，本次仅完成名册功能的移除。

## v0.5.422 (2026-09-15)

### 新增

* 多智能体协作审批门禁（**策略档位驱动**）：新增第二个审批咨询点 `decideTeamApproval`（`lib/chat/approval.ts`），与既有的单次工具调用裁决（`decideToolApproval`）并列——同源策略、不同时机。`team_run` 既不在 `confirmTools` 名单、也非写类工具（spawn 出的成员各自再走自己的工具轮），故不复用第 1 点，单列一档：
  * `allow_scope`（默认）→ 不打断用户，宿主持草案直接 approve & run（与既有行为逐位一致）；
  * `ask` → `team_plan` 完成、`team_approve` **之前**挂起，宿主把草案（目标 + 成员名册 + 任务 DAG）以 `team_confirm` 帧推给前端弹出审阅卡（Approve & Run / Discard），用户批准后才真正 approve & run 启动调度器——`team_approve` 本身的契约就是「用户确认方案后再调用」，此前由宿主直接代为调用；
  * `never` → 入口直接拒绝：不建团队、不 plan，零 MCP 副作用（团队记录都不产生），回灌 `ok:false` 文案让主 agent 如实告知用户。
* 档位取值单一来源：`route.ts` 按「identity 级 `approval.perAgent` 覆盖 > 全局 `approval.defaultStrategy` > `allow_scope`」算一次 `effectiveApprovalStrategy`，同一次工具轮里同时喂给 tool_confirm 接管与 `team_run`（`executeTool` ctx）——两处裁决不冲突、不叠加双卡。
* 门禁复用既有「工具确认挂起」基础设施：`createPendingConfirm` 生成 confirmId + Promise，前端回传走既有的 `POST /api/chat/confirm`，前端复用既有 `ConfirmDialog`（含并发 FIFO 排队）——零新增端点、零新增组件。
* `ask` 档下拒绝 / 超时一律作废草案：`team_discard` 清掉已 plan 的团队（否则团队停在 `planning` 态、成员与任务永不物化，留下僵尸团队），返回 `ok:false` + 区分「用户明确拒绝」与「等待审批超时（用户可能不在场）」的可读文案回灌主 agent。
* 等待审批期间不新增心跳：本轮工具的 20s `tool_call_update(running)` keepalive 已覆盖整个 `team_run` 执行窗口，门禁挂起落在其中，前端 90s 空闲超时不会误杀。

### 修复

* 团队执行预算起点后移到「用户批准之后」：此前 deadline 在门禁之前就已计算，用户在审阅卡上思考几分钟会直接吃掉团队的 `budgetMs`（极端情况批准即超时、零产出）；现在审批耗时不计入执行预算（仅 `ask` 档存在该等待窗口）。

### 说明

* **编排链形态由审批策略档位决定**：`team-run.ts` 模块头的设计约束条、`runTeam` 的步骤注释（③ 协议入箱 → ④ 门禁 → ⑤ approve）已同步改写为策略驱动。默认档 `allow_scope` 下对外形态与既有（无门禁）逐位一致；`ask` 档变为「建团队 → 规划 → **等用户确认** → 派任务 → 轮询 → 回收」。
* 零 MCP 改动：门禁完全落在宿主侧，不改 `bob-team-mcp`、不重编 dist、不触碰 `/api/chat` 前缀缓存红线；`team_run` 工具描述同步改为策略条件式（明示 `ask` 档下用户批准方案后才运行、`never` 档下直接拒绝调用）。
* `ask` 档下非交互调用路径（`onConfirm` 未注入，如单测 / 脚本）仍视为自动批准，不阻断非交互流程。

## v0.5.421 (2026-09-15)

### 新增

* 成员间消息通道（宿主中转）：多智能体协作的成员可在产出末尾用 `[[msg to=<同伴名|m1|all>]]内容[[/msg]]` 给同伴留话（可写多条、多个目标逗号分隔），宿主在轮询中解析并投递到目标成员邮箱，对方**下次被唤醒**时以「[来自团队的直消息]」读到——语义与引擎原生的唤醒边界投递一致（异步、非实时）。
* 留言协议在 `team_approve` 之前以一条广播（`to:'all'`）入箱：approve 拿到锁即 `void pump()` 异步调度，协议晚一步就可能赶不上成员的首个任务（而多数成员只有一个任务）；广播不被标记送达，恰好让成员每次唤醒都重申一遍协议。
* 成员留言里的 `all` 由宿主展开为逐条单发：引擎只对 `to === memberId` 的直消息标记送达，广播会在成员每次唤醒时重复注入——这对「协议」是优点，对「成员之间的留言」则是骚扰，故投递前展开成逐成员单发。

### 优化

* 留言不污染回答：留言块在回灌主 agent 前被剥离（正文产出照常汇总，协议噪音不进上下文），投递条数与解析/投递异常在汇总中如实交代，由主 agent 决定是否提及。

### 说明

* 零 MCP 改动：不改 `bob-team-mcp`、不重编 dist、不触碰 `/api/chat` 前缀缓存红线；成员仍是普通 `/api/chat` 会话，两端（协议下发 + 产出解析投递）全部由宿主经现有 `mcp__team__*` 工具代理。代投消息的 `from` 被引擎硬编码为 captain，故正文统一加「〔成员「X」留言〕」前缀标明真实来源。

## v0.5.420 (2026-09-15)

### 新增

* 多智能体名册（Multi-agent mode roster）：点击 chat 节点的 Multi-agent mode 开关即打开名册弹窗，可从已安装的 Agent 中挑选成员加入协作（重名自动追加序号，保证 `team_plan` 的任务认领键唯一），每个成员可改显示名、绑定 Agent 身份（identity）、写一句职责（role）；保留「Automatic」选项，空名册 = 保持原行为，由主 agent 按任务自行编排
* 名册双保险：名册随请求 `teamMembers` 下发，服务端在编排规则后追加「指定成员名册」约束（要求 `team_run` 的 members 与之一致、不增删不改名），宿主执行 `team_run` 时再按名册校验/补齐——补齐模型漏配的成员、剔除模型自行新增的成员、identity 未安装则回退默认 chat agent 并在汇总中如实交代，避免出现「绑了专属 Agent 实际跑通用 agent」的空壳成员
* 名册内「New Agent」入口：不在弹窗内建包，关闭弹窗后复用画布既有 AI Coding 创建流程并直接落在 Sub-Agent 档（创建对话框新增 `initialKind` 档位）

### 优化

* 开关即名册：点击 Multi-agent mode 开关先确保模式开启、再打开名册弹窗；开关提示随名册变化（`Multi-agent mode on — N member(s) in roster` / `— roster: automatic`），已配置名册时按钮带成员数角标；弹窗内可一键 Turn off 关闭模式并清空名册
* 名册随节点持久化：`multi_agent_mode` 与 `team_members` 写入节点 frontmatter（与 `subagents` 分支面板同一套落盘/回读链路），重开项目后名册与成员数角标照旧，之后每轮请求照旧带上名册
* `team_run` 工具卡片文案改为「多智能体协作：<目标>（N 名成员）」，折叠时即可看出本轮编排的实质内容

## v0.5.419 (2026-09-15)

### 新增

* 多智能体协作（Multi-agent mode）：chat 节点新增开关，打开后主 agent 作为编排者调用内置工具 `team_run` 一次性发起协作——成员名册（可指定 Agent 身份 / 推理强度 / provider:modelId）+ 任务 DAG（按 dependencies 串行、无依赖并行，默认 8 分钟预算）；宿主闭环完成建团队 → 调度 → 轮询至终态 → 回收，各成员产出汇总为一条回答
* 协作过程可视化：成员实时状态经 SSE 推送到 chat 节点，过程条显示「N/M agents」，回答下方可展开 Show agent details 查看每个成员的角色、任务与进度；分支面板随回答一并写入 `.md`，重开项目仍可回看

### 优化

* 多智能体入口唯一化：退役画布 Agent Teams 节点与团队面板（`/api/team` 路由、`mcp__team__*` 裸工具、`team_trigger` 事件一并移除），模型侧只保留 `team_run` 一个入口；`team` 场景改为随开关按轮次生效、不再落 sticky，关掉开关后没有第二条旁路；`bob-team-mcp` 改为默认启用，coding 画像与 Agent 包不再能自行声明 team 场景
* 附件物理归入「资料」：新附件统一写入 `materials/`（历史附件留在 `attachments/`，更早的 `assets/` 自动映射回读），读取侧 `read_attachment` 同时覆盖附件与资料，原 `read_material` 工具下线；资料目录读取改为返回「资料列表」，只给路径清单，正文与 OCR 结果按索引按需返回，不再整篇灌入上下文
* 资料目录管理：materials 接口新增移动与索引状态查询，重名自动追加 ` (1)` / ` (2)` 后缀，禁止移动到自身；侧栏资料树支持树内拖拽归组、拖入系统文件上传到指定分组，上传后按索引状态显示「解析中」
* DeepSeek 模型家族显式声明：预设中 6 个模型补 `family: 'deepseek-v4'`，解析侧新增 `isDeclaredV4Model()`，不再靠模型名猜家族

### 修复与优化

* 流式超时改为空闲超时：90 秒内没有新帧才判定超时（原为固定总时长 90 秒，工具链较长的轮次会被中途掐断）
* 便签「加入日历」弹窗细化：以行内实时文本预填，关闭弹窗即作废在途识别请求、过期响应直接丢弃；新增「不提醒」选项
* chat 节点删除时只清理符合附件命名规则（`{nodeId 前 4 位}_{标题}`）的 materials 目录，用户自建分组不再被误删


***

## v0.5.418 (2026-09-15)

### 新增

* 便签待办新增「加入日历」：未完成且未加入过日历的待办行可直接建日历事件，弹窗自动从文本识别日期与时刻（正则快路径，未命中再交给模型），识别结果可手动覆盖；可设提前 5 / 15 / 30 分钟或 1 小时提醒，默认持续 1 小时
* 分享页支持内联组件渲染：Markdown 中的 mermaid / widget:svg / widget:html / widget:chart 代码块在服务端预渲染为静态 SVG 与 HTML，分享链接（纯 SSR、无客户端脚本）也能看到图表与图形，不再退化为源码块

### 优化

* 技能资源读取重构：`resources/` 与 `references/` 两种目录命名都作为资源根，并支持一层子目录（scripts/、templates/ 等）；未命中时返回可用资源清单，按清单重试即可，避免模型拼技能目录绝对路径被拒
* Widget 主题与配色收敛为唯一数据源，编辑器、分享卡与分享页共用同一套色板与 Mermaid 主题；Markdown 渲染白名单抽出为共享模块，三处渲染同源
* 分享卡宽表自适应：预览与导出共用同一缩放逻辑，按卡片可用宽度等比缩小，宽表不再被裁切；卡内内联渲染 widget，与编辑器同源解析
* 流式过程新增阶段状态机：依次显示「分析任务 / 正在调用的工具及目的 / 撰写回答」，未完成的 widget 代码块在流式中显示骨架占位

### 修复与优化

* 命令工具健壮性：超时提示按安装类 / 搜索类分别给出可操作建议（换镜像源、缩小搜索范围）；Python 脚本落盘前去除 BOM、拦截损坏字符并自动补编码声明，避免整轮执行因编码报错而白跑
* DocEditor 指针统一：可编辑区统一为 I 形文本光标（图片保持放大镜），修复列宽拖拽时不显示 col-resize 的问题；标题字号收紧为 h1 24px / h2 19px / h3 16px


***

## v0.5.417 (2026-09-15)

### 新增

* Hippo Browser 新增「打印当前页」：Tools 菜单 → Print… 调用系统打印面板（`silent: false` + 打印背景），打印前先显示并聚焦浏览器窗口，用户取消面板不算失败

### 优化

* 指针统一，消除「箭头 ↔ I 形」闪烁：Hippo Browser 各内置界面（标签栏 / 书签栏 / 工具栏 / 元素检查器 / Tools 菜单）统一为箭头指针，仅输入域保留 I 形；DocEditor 可编辑面显式声明 I 形文本光标（图片保持放大镜），不再因命中测试在文字与非文字位置间来回切换而闪烁
* 图片 / PDF 查看页拆分为服务端 page + 客户端组件，改由 `generateMetadata` 在服务端按 `?path=` 推导文件名写入 `<title>`，Hippo 标签名不再被根布局标题覆盖


***

## v0.5.416 (2026-09-14)

### 新增

* 项目面板新增列表视图：标题栏「网格 / 列表」切换，偏好写入 `bobwork.board-view` 持久化；列表行信息与卡片对齐，当前 / 选中 / 归档 / 回收站态以行内左侧色条表达
* 侧栏标题栏新增搜索框，随视图切换目标：Files 搜文件名（全树扁平匹配，命中以「文件名 + 所在路径」呈现），Log 搜活动条目（匹配标题与描述）；两视图关键词各自保留，带清除按钮
* 分享卡新增正文字体选择：内置 8 款 macOS 自带中文字体（默认无衬线 / 宋体 / 楷体 / 行楷 / 手写体 / 娃娃体 / 圆体 / 隶书），下拉自绘以逐项预览字形，选择持久化到 `settings.shareFont`
* 内置技能新增 `hand-drawn-map`（手绘地图），资源随包分发，并注册到场景图标表

### 优化

* 项目活动日志：新增搜索过滤（标题 + 描述，仅过滤已加载条目），移除工具条冗余刷新按钮，类型标签与日期头改为英文（Today / Yesterday / Mon, Sep 14, 2026）
* 侧栏折叠 rail：BobMail 上移、品牌（Settings 入口）下移，BobMail 图标统一为 13px，未读角标锚定按钮容器、不随图标缩放
* 内置浏览器标签页标题：图片 / PDF 查看页以文件名覆盖 `document.title`，标签名不再沿用根布局标题
* 文件操作与项目活动文案统一为英文（Protected system directory / Rename failed / `xxx copy` 等）


***

## v0.5.415 (2026-09-14)

### 修复与优化

* 回退 materials 内容索引自动回填：不再在打开项目、刷新文件树或全局检索时后台触发存量扫描与 OCR，恢复为仅在上传与附件读取时建立索引，避免打开项目即触发批量解析
* 回退 GLM-OCR 整份解析的逐页还原：整份文本不再按页锚点插值与切分，缺失结构化页时以单页兜底，避免锚点不足时页码落位错乱
* 全局搜索「素材内容」条目收敛：检索不再触发回填，文件名命中与内容命中各自独立呈现，文件名命中的条目不再被内容页码 / 片段改写


***

## v0.5.414 (2026-09-14)

### 新增

* materials 内容索引自动回填：打开项目时后台为已有素材 / 附件补齐内容索引（按内容 hash 寻址、幂等、5 分钟节流），历史素材无需逐份重新解析即可被检索命中
* 全局搜索新增「素材内容」检索：命中素材正文或 OCR 页时在结果中直接给出页码与片段，并标注来源「素材内容」，检索过程不调用模型
* 附件与素材读取优先复用内容索引：命中已索引内容时直接返回（PDF 文本层 / OCR 缓存），免去重复 OCR；OCR 完成后回写内容索引，并在结果中提示页级质量（平均置信度、低置信页、含扫描页）

### 优化

* 分享卡底部生成时间改由卡片自身维护：导出时刷新为当前时间，预览与导出共用同一时间戳状态，对话流不再向 ShareCard 透传消息时间戳
* 素材内容检索与文件名命中合并去重：文件名已命中时改为补充页码与片段，不再重复列出同一条目


## v0.5.413 (2026-09-14)

### 新增

* 分享卡新增纸张底色选择：底部工具栏提供纸色圆点，与 3:4 分享卡共用同一套纸张样式，选择随设置落盘（settings.xhsPaper），下次打开自动沿用
* 分享卡导出宽表自适应：表格自然宽度超出容器时整表等比缩放，导出与预览所见一致，修复 html-to-image 只按可视宽度取景导致的宽表右侧被裁切
* 欢迎面板品牌图标可点击轮换：在 BobWork 图标 / Hippo 图标 / 品牌 Logo 间切换（仅本次会话有效，不持久化）

### 优化

* 分享卡移除底部「Generated 时间戳」水印行，底部仅保留 Share via BobWork 品牌行
* 侧栏 Workspace 标题栏与对话流项目名悬停信息（分类 / 标签 / 备注）的配色与排版收敛

***

## v0.5.412 (2026-09-14)

### 新增

* Hippo Browser 新增「打开链接方式」开关：工具菜单可在「新标签 / 当前标签」间切换，页面内链接点击按当前模式接管，切换即时生效（仅本次会话有效，不落盘）

### 优化

* 文件自动整理新增「AI 自动新建分类文件夹」（Auto-create Categories）开关：清单分类均不匹配时允许模型自创分类名并直接建目录，默认关闭（严格限定在清单内）
* 本地文件浏览器：目录「授权 / 撤销授权 AI 访问」入口从常驻按钮收进右键菜单，目录行更简洁
* materials 面板操作收敛进行尾 ⋮ 菜单（授权、上传、新建子文件夹、重命名、删除），并支持拖拽文件 / 目录上传（保留目录层级）、索引解析中显示 Parsing 提示
* 对话流移除顶部 Phase 阶段胶囊，实时当前动作条移至过程区末尾，流式状态更轻量
* 打开本地文件定位到具体页 / 关键词：PDF 查看页透传 page 与检索片段锚点；左栏悬停高亮修复；折叠态侧栏底部新增品牌入口与 BobMail 未读角标

***

## v0.5.411 (2026-09-14)

### 优化

* 文档编辑器 Markdown 标题字号收敛：h1 28px → 24px、h2 22px → 19px、h3 17px → 16px，标题与正文的字号层级更协调，长文阅读不再头重脚轻

***

## v0.5.410 (2026-09-14)

### 优化

* materials 索引随文件重命名自动迁移：重命名项目 materials 内的文件或目录时，改写内容索引 manifest 中的键路径（目录按前缀迁移整棵子树）；索引按内容 hash 寻址，无需搬迁索引文件，重命名后仍可直接命中既有正文与行级骨架，免重复 OCR

***

## v0.5.409 (2026-09-14)

### 新增

* OCR 识别默认策略改为质量优先：`upgrade` 缺省由 off 改为 auto，识别质量分偏低 / 文本为空时自动升级 VLM 复核（识别引擎仍由 bob-ocr-mcp 插件配置决定）
* OCR 结果回写项目内容索引：预览 OCR 与对话桥接预热完成后把识别结果写入 `.materials-index/<内容hash>/`，同一份字节之后上传 / 读取到 materials 时直接复用，不再重复识别
* 附件索引回收：删除节点 / 目录时登记其内容哈希并回收附件独享的索引，避免 `.materials-index/` 无限膨胀

### 优化

* PDF 预览 OCR 状态新增两级零 token 兜底：按内容 hash 直达 `.materials-index/<hash>/`（含行级骨架）与 `.cache/parse/<hash>.json`，不再依赖文件是否位于 materials / attachments 目录；命中即显示「已识别」并复用逐页正文，免二次 OCR
* PDF 预览 OCR 状态改单一事实源：过程状态 / 持久标记 / 逐页正文统一更新，修复读取持久化标记与文档加载的时序竞争导致的「已识别」状态被清空；预置目标页尺寸修复跨页跳转落点偏移
* 对话流移除流式阶段胶囊进度条，简化长任务流式状态渲染
* 服务端类型收紧：`nodes` 接口去除 `any`、清理未使用的项目上下文注入

***

## v0.5.408 (2026-09-13)

### 新增

* materials 内容索引：上传后异步建立内容索引（文本层走本地提取器、扫描件/图片走本地 Vision OCR，全程零 token），落盘 `.materials-index/`（manifest + 页级 meta + 行级 blocks）；上传 / 删除材料时联动建立与回收索引
* 文件树上传后显示「Parsing」提示：轮询只读 manifest（零开销），索引就绪即消失，5 分钟 deadline 兜底避免解析失败时永久转圈
* `read_material` 工具优先命中内容索引：重复读取 PDF / 图片不再重跑 OCR，header 附带页级质量提示（平均分 / 低置信页 / 含扫描页）
* ⌘F 检索新增 materials 正文内容命中：命中返回 `matchType='content'` 与上下文片段、页码（文件名命中优先，不重复插入）

### 优化

* PDF 预览 OCR 状态两级零 token 兜底：sidecar 缺失时先复用 materials 索引的本地 OCR 行级骨架，其次复用对话阶段已写入的 `.cache/parse/<内容hash>.json`，使扫描件在预览中直接显示「已识别 + 命中高亮」，免二次 OCR
* PDF 深链定位：`file://` hash（`#page=N&q=关键词`）经主进程解析后转查询串透传，`/pdf-viewer` 支持打开即跳页并在文档内检索高亮；搜索命中与文件打开事件可携带定位锚点（HTML 不追加锚点，避免误触发页内锚点）
* 分享卡宽表自适应：导出前把超出卡片宽度的表格等比缩放（预览与导出共用同一函数），修复 html-to-image 取景宽度导致的宽表右侧裁切；品牌卡纸张底色与 3:4 卡共用 `settings.xhsPaper` 偏好
* Wanted 通知中心精简：移除 To: 我 收件人行、星标按钮与占位 More… 按钮；底部操作栏仅在日历类邮件渲染，不再出现空操作条
* hippo 浏览器本地文档查看页 URL 解析改用 URL 对象（修正带 query 的扩展名识别），并透传 PDF 定位锚点
* UI 文案：文件树「解析中」提示改为英文 Parsing

***

## v0.5.407 (2026-09-13)

### 优化

* 查看舱标签页关闭按钮改为悬浮覆盖：关闭按钮绝对定位浮在标签右上角，不再占用标签宽度；标签宽度估算上限同步由 140 收到 112，等宽标签栏能容纳更多标签
* 本地文件浏览器面板精简：行尾 ⋯ 操作按钮改为悬浮覆盖渐显（带渐变底，不再挤占文件名）；移除「Added directories (N)」分组标题；右键菜单去掉分组小标题与彩色图标，移除 Open in viewer / Open with system app（统一走 Finder）；「Send to current node」「Send to new node」分别改名为「Current chat」「New node」
* 本地目录读取性能优化：先过滤隐藏文件并按目录优先排序，再用 `Promise.all` 并发 `stat`，替代原先逐条 `await` 的串行系统调用 —— 打开文件较多的大目录不再卡顿
* 新建 Markdown 文档接口加固：目标目录缺失时兜底创建，文件名 / 子目录继续做路径穿越与重名校验

***

## v0.5.406 (2026-09-13)

### 新增与优化

* 截图 OCR 编辑器马赛克重做：新增细 / 中 / 粗三档画笔（Fine / Medium / Thick），笔刷半径随图像分辨率自适应，落点改为圆形（不再误伤笔刷外像素）；改用局部区域读写 + 快速拖动插值补点，涂抹更跟手、不再出现断层
* 截图 OCR 编辑器标注文字字号随图像宽度自适应，不同分辨率 / DPR 截图上视觉大小一致
* 截图 OCR 编辑器缩放基准修正：整屏截图按窗口尺寸铺满（与真实屏幕 1:1），修复用户反馈的「蒙版比真实界面小」
* 截图 OCR 编辑窗口改为常驻复用：移除每次截图后的整页 reload（Next 重新水合），快捷键唤起编辑画面不再迟滞 / 白闪
* 新建 Markdown 文档弹窗：⌘F 面板点 Markdown 时可自定义文件名并选择 homework 内目标文件夹，重名 / 非法字符即时提示；`/api/nodes` 创建接口同步支持 `file_name` / `target_dir`，并做路径穿越与重名校验
* 本地文件浏览器新建 md 同样改为弹窗命名 + 重名校验，弹窗期间面板不自动收起
* 查看舱标签页关闭按钮修复：标签本身是 button，内部再嵌 button 属非法 HTML，会被 SSR 提前闭合导致悬停不显示关闭按钮 —— 改用 `span[role=button]`，并收紧标签尺寸
* 模板填充面板「Bob Items」改为可折叠下拉列表：支持 Select all / Invert 批量勾选与逐项复选框
* warm 主题画布底色微调（#e4e4ea → #e8e8e8）

***

## v0.5.405 (2026-09-13)

### 修复与优化

* 插件面板端口加固：Bob-Mind 面板端口被残留旧进程占用时不再静默加载旧界面 —— 插件侧写入端口冲突标记，并每 10 秒重试绑定端口，占用进程退出后自动接管（无需重启宿主）
* 新增宿主统一探测接口 `/api/plugin-panel-probe/<pluginId>`：面板挂载前由宿主判定就绪态，能识别「端口被残留旧进程占用」并回报占用进程 PID，避免直连插件端点命中旧进程、误判就绪
* 面板未就绪提示细化：区分「端口被占用」与「插件未运行」两种情况，均提供 Retry

***

## v0.5.404 (2026-09-13)

### 优化

* 内置浏览器（Hippo）界面文案全面英文化：工具栏（Back / Forward / Reload / Search or enter address / Bookmark this page / Always on top）、书签右键菜单（Rename / Delete Bookmark）、窗口按钮（Close / Minimize / Zoom）与错误提示（Missing URL / Bookmark not found / Only http/https/file links are supported）
* 各查看器与编辑器文案英文化：PDF 查看器（拖动选中提示、Failed to load PDF、保存结果、OCR 与检索状态）、图片查看器（Rotate 90° / Annotate / AI edit / 全屏与关闭提示）、图片标注器（Arrow / Rectangle / Text / Mosaic、颜色、字号、Undo / Clear all annotations / Cancel / Save）、AI 图像编辑器（No model configured 与参考图说明）、独立 image-viewer 页面加载与保存报错
* ⌘F 面板标星小程序快捷图标行放大（18px → 28px 圆角方块，字号同步提升），补上悬停高亮；点击功能按钮或标星图标后自动收起面板
* Extensions Store 图标由 Sparkles 换为 Blocks

***

## v0.5.403 (2026-09-13)

### 修复与优化

* WANTED /chat 对话不再进入 BobMail：下线 /api/wanted/mail-reply 接口与邮件式线程回复逻辑（askFromMail / aggregateSse 一并移除），统一改为面板 toast 浮层展示，保持轻量交互
* 会话存储统一由服务端 chat-sessions 管理：panel 会话长期保留供多轮复用，wechat 会话 24 小时过期自动清理；/chat out 不再删除临时文件，解绑线程标记后仅退出 node 模式
* bus.ts 事件模型精简：移除 chat kind 与 threadId 必填约束，对话历史字段改为可选会话线程 ID（DB 保留字段，供未来会话式通知归组使用）

***

## v0.5.402 (2026-09-12)

### 修复

* 文档编辑器分栏内无法输入：ProseMirror 的 toDOM 缺少末尾「内容孔洞」占位符 0 时，renderSpec 会返回 contentDOM=undefined，该 div 被设为 contenteditable=false 且不挂内容孔洞，导致栏内既无法输入也不渲染子块；现为 .bob-column / .bob-columns 补回 0 占位符，并更正注释说明（Tiptap v3 会在 .bob-columns-body 内再注入一层 contentDOM，分栏 layout 样式作用于该注入层）
* 文件树列式浏览 ⋮ 菜单的 Share 入口对非 Markdown 文件置灰禁用并提示 Only Markdown documents can be shared，与 /api/share 仅接受 .md 的服务端约束保持一致

***

## v0.5.401 (2026-09-12)

### 优化

* 模型选择器中 DeepSeek V4 Flash 的显示名统一改为 deepseek-flash（三处 preset 保持一致）
* ⌘F 命令面板的功能图标行补上标星小程序快捷入口：与功能按钮同排展示、中间以竖线分隔，点击直接打开预览（功能入口自左侧栏迁回面板时遗漏此项）

***

## v0.5.400 (2026-09-12)

### 新功能

* 文档编辑器新增「链接卡片」：独占一行的裸链接渲染为卡片，异步抓取 og / twitter 元数据后展示站点图标、标题、描述与缩略图，抓取中显示域名占位、失败降级为普通链接；Markdown 源码仍为 [url](url)，不污染文档。新增 /api/link-preview 抓取接口（favicon 优先普通 icon 再 apple-touch-icon，og:image 绝对化，带超时与体积上限）

### 优化

* 全局字体改为衬线字体栈：--font-sans / --font-display 由 Apple 无衬线栈改为 Times New Roman 起头、宋体系（Songti SC / Source Han Serif SC / Noto Serif SC / SimSun）回落；分享页、Widget 渲染、屏幕 OCR 编辑器（含 canvas 文字）三处独立字体声明同步对齐。西文取 Times New Roman 而非 Georgia：后者默认旧式数字且不含 tnum，会让全 UI 的 tabular-nums 等宽对齐失效
* 功能入口（Actions / Library / Tools / Mini Programs）自左侧栏迁回 ⌘F 面板，排在输入框下方，仅显图标、悬停提示名称；左侧栏移除按钮组与分割线，标星小程序并入该行
* 文件自动整理命名默认形态改为「主题 + 版本号 + 日期」（如 房屋租赁合同v01_2026-09-12.pdf）；设置界面字段顺序由「六种全排列下拉」改为三个位置各自独立下拉，选中已占用字段时与其原位置互换，始终保证三字段各出现一次，标签改用英文（Field Order / Separator / Version）

### 修复

* 移除 globals.css 中写死的 body font-size: 14px：该裸样式输出顺序晚于 @layer base 的 html/body 字号，会把 body 钉死，导致界面文字不随字号档位缩放
* 文件树保护系统目录：项目一级默认目录（homework / materials / attachments）与 homework 内系统目录（template、doc/sheet/slide/… 及旧版 Image 等）不再提供重命名 / 复制 / 删除，避免破坏产物结构
* 重命名 homework 内文件或目录时同步迁移 homework/.ownership.json 归属清册（relFrom → relTo，目录按前缀整体迁移），归属不再因改名丢失
* 文件树重命名失败改为显式提示（原为静默忽略，用户看不到失败原因）
* 修正多栏扩展注释说明：Tiptap v3 会在 .bob-columns-body 内再注入一层 contentDOM，分栏 layout 样式作用于该注入层

***

## v0.5.399 (2026-09-12)

### 新功能与优化

* 文件自动整理命名规则可配置：新增 naming-rule.ts（纯函数、零依赖，设置界面与 organize CLI 共用同一实现），支持字段顺序（版本号 / 主题 / 日期）× 分隔符（下划线 / 连字符 / 空格 / 无）× 版本号补零位数；拼名与反解共用同一规则，改规则后版本累加仍有效
* 字号类名全量统一为 Tailwind 短类（text-9 / text-10 / text-11，新增 text-31 刻度），`text-[Npx]` 任意值写法清零，覆盖 20 余个组件；样式不变，但类名可被 Tailwind 正常生成与排序
* Draft 全局草稿改「做旧稿纸」配色：极淡暖米底 #f8f4e8 + 152° 微弱做旧渐变 + 暖褐描边，替代原冷灰底，在冷灰画布上透出一张旧稿纸
* 分享卡改为无边框样式：去掉品牌色细边框、圆角、阴影与顶部横幅，只保留品牌头 + 问答 + 水印
* 小红书卡移除批量保存下拉菜单，保存收敛到单一入口
* 欢迎窗口图标资源更新

### 修复

* 修复本地文件面板「发送到当前节点」始终无目标：活跃节点 ref 改由 CanvasFlow 统一下发，与右侧文件面板共用同一份，并随焦点变化同步写入；原实现仅在画布点击时赋值，而点进节点输入栏的 click 被 stopPropagation 拦截，导致该功能不可用

***

## v0.5.398 (2026-09-12)

### 新功能与优化

* 模型计费支持用户覆盖价：新增 get_model_price / set_model_price 两个管家工具（对话即可维护单价，支持 cacheHit/offPeak/currency/note），覆盖率优先于内置价格表，改价只影响此后新产生的用量；计费链路 30s TTL 缓存并在写盘后立即失效
* 「计费 / 单价 / 调价 / 改价 / 定价 / 按量计费」等表述纳入管家场景自动识别；Agent 规则明确单价必须由用户提供或经核实，禁止编造
* 设置面板改为「改动即自动保存」：移除 Save 按钮与脏标记，改动后 debounce 500ms 落盘，写盘期间单飞 + 补写队列以防并发覆盖同一 settings.json；回填期间抑制自动保存，字体缩放并入该链路
* 欢迎窗口品牌图标固定为 public/welcome-icon.png（不再每次启动随机取南瓜头像），图标圆角 24px（原 50% 圆形）；新增 public/ai-icon.png，AI 回复品牌头同步换图
* 日历面板新增「隐藏已完成」开关（仅影响日历展示，不改动数据）；日历同步状态条收进 ⋯ 菜单，主视觉只保留状态文案
* 左栏会话列表按创建时间（frontmatter created_at）「最新在上」排序
* 插件面板标签常驻标签栏（打开过即保留，切到其它标签也不消失，iframe 不重建）；Templates 与置顶插件（Bob-Mind）固定排在标签栏最前

### 修复

* Markdown 正文导航圆点滚动联动改用 getBoundingClientRect + rAF 节流，修复父级多包一层布局时高亮失准的问题，并随窗口尺寸变化重新校准
* DOCX 预览改为平铺面板：页面宽度撑满面板（覆盖 docx-preview 写死的 Word 固定页宽），左右内边距归零，页面上边距压到 32px 与 Markdown 正文对齐；「适应宽度」恢复为等价 100% 缩放，修复反复点击不断缩小
* 侧栏工作区浮层：浮层内部列表自身滚动不再误关浮层，仅外部容器滚动才关闭

***

## v0.5.397 (2026-09-12)

### 新功能与修复

* 新增「项目流水账」面板：侧栏工作区浮层加「文件 / 日志」切换，日志从磁盘事实源派生聚合项目创建/归档/回收站、任务执行、附件添加、文档生成，按日期分组，支持升降序、类型过滤与游标分页（新增 src/lib/project/activity.ts、/api/projects/activity、ProjectActivityLog.tsx）
* 文件自动整理命名规则反转：{日期}_{版本号}_{主题} → {版本号}{主题}_{日期}（如 v01房屋租赁合同_2026-09-12.pdf）
* 整理日志文件名加隐藏前缀（_整理日志.json → .整理日志.json），兼容读取旧日志并在合并落盘后清除旧文件，文件夹内不再露出日志
* 自动整理模型输出上限 300 → 2000 tokens，修复思考型模型 reasoning 占满额度导致正文被挤空、静默落入 _待处理的问题；输出被截断时明确报错
* 插件面板宽度统一为 800（移除竖屏/横屏窄宽切换档位），并重置旧持久化宽值使其生效
* Templates 与置顶插件（Bob-Mind）标签固定在标签栏最前，不再被会话/文件标签挤到末尾
* Markdown 编辑器「行内代码」按钮移至第二行「代码块」右侧；修正多栏节点结构，恢复 .bob-columns-body 直接子元素样式命中

***

## v0.5.396 (2026-09-12)

### 修复与优化

* 画布底色回调加深为冷中性灰（--canvas-bg #f7f7f8 → #e4e4ea），与白色面板/会话卡片拉开层次，主题默认画布色同步为 #e4e4ea
* Markdown 目录浮层底色改为灰色（--paper-soft），与白色正文区区分
* 点击目录项不再收起浮层（保持展开，便于连续翻阅章节），仅在点击浮层/按钮以外区域时收起
* 若干注释中的硬编码色值改为引用变量，无行为变化

***

## v0.5.395 (2026-09-12)

### 修复与优化

* 画布底色改为与中间输入区同款浅灰（--canvas-bg #e6e6ec → #f7f7f8），统一整体底噪，节点层次改由边框/阴影区分
* Markdown 编辑器目录由左侧常驻栏改为右上角 Show outline 浮层：固定于右上角、不随正文滚动也不被裁剪，点击浮层外自动关闭
* 目录项跳转由平滑滚动改为硬切瞬时定位，长文档翻章更利落
* DOCX 查看器 inspect 模式不再自动弹出右侧修订面板，改由工具栏「修订面板」按钮手动展开
* DOCX 正文顶部留白压缩（容器上内边距 24px → 8px），正文更贴近工具栏

***

## v0.5.394 (2026-09-12)

### 修复与优化

* Hippo Browser 书签支持右键原生菜单（重命名 / 删除），菜单浮于网页视图之上，动作经 menu-cmd 回传工具栏执行
* 切换面板标签或项目时自动将置顶的 Hippo Browser 收起为胶囊，避免遮住新页面
* 设置面板改为左侧分组导航 + 搜索（按关键词过滤，无结果给空态），替代原先的长滚动布局
* 日历面板「选中日期待办」改为固定高度卡片（高度不随待办数量变化，内容过多时卡片内滚动），不再挤压日历网格

***

## v0.5.393 (2026-09-12)

### 修复与优化

* 文件自动整理新增常驻监听：开启后投递箱目录放入文件即自动改名并归入分类子目录（watcher 接入 instrumentation，开关/目录变更周期对账）
* 整理逻辑抽离为 tools/organize/core.ts，CLI 仅保留入口
* 画布面板底色统一为纯白（预览 / 本地文件 / 会话卡片），与灰色画布底拉开层级
* 标签选中态改为背景 + 边框高亮，去掉底部下划线指示条

***

## v0.5.392 (2026-09-12)

### 修复与优化

* 新增「文件自动整理」投递箱设置（目录 / 开关 / 分类清单，设置面板 File Organizer 区块）
* 全局截图 OCR 引擎可选（auto / 仅 MCP / 仅本地 Swift Vision）
* Auto 模式带图片附件时优先视觉模型的开关

***

## v0.5.391 (2026-09-12)

### 修复与优化

* 内置浏览器 IPC 通道扩展（标签 / 书签 / 下载 / AI 编辑 / HTML 编辑 / 截图）
* 屏幕 OCR 编辑器截屏与关闭通道
* 画布便签、WANTED 排程与设置面板调整

***

## v0.5.390 (2026-09-12)

### 修复与优化

* 更新打包发布

***

## v0.5.389 (2026-09-11)

### 修复与优化

* 更新打包发布

***

## v0.5.388 (2026-09-11)

### 修复与优化

* 更新打包发布

***

## v0.5.387 (2026-09-11)

### 修复与优化

* 更新打包发布

***

## v0.5.386 (2026-09-11)

### 修复与优化

* 更新打包发布

***

## v0.5.385 (2026-09-11)

### 修复与优化

* 更新打包发布

***

## v0.5.384 (2026-09-11)

### 修复与优化

* 更新打包发布

***

## v0.5.383 (2026-09-10)

### 修复与优化

* 更新打包发布

***

## v0.5.382 (2026-09-10)

### 修复与优化

* 更新打包发布

## v0.5.381 (2026-09-10)

### 修复与优化

* 更新打包发布

***

## v0.5.380 (2026-09-10)

### 修复与优化

* 更新打包发布

***

***

## v0.5.379 (2026-09-10)

### 修复与优化

* 更新打包发布

***

***

***

## v0.5.378 (2026-09-10)

### 修复与优化

* 更新打包发布

***

***

***

## v0.5.377 (2026-09-10)

### 修复与优化

* 更新打包发布

***

***

***

## v0.5.376 (2026-09-10)

### 修复与优化

* 恢复 DMG 发布，用户双击 DMG 即可弹出 Gatekeeper 确认打开窗口
* 更新打包发布

***

***

***

## v0.5.375 (2026-09-10)

### 修复与优化

* 更新打包发布

***

***

***

## v0.5.374 (2026-09-10)

### 修复与优化

* 更新过渡效果：下载中箭头闪烁替代圆点；下载完成版本号闪烁提示安装
* 更新打包发布

***

***

***

## v0.5.373 (2026-09-10)

### 修复与优化

* 更新打包发布

***

***

***

## v0.5.372 (2026-09-10)

### 修复与优化

* 更新过渡效果优化：下载中新版本号随进度渐亮（去除圆环）；下载中新增品牌蓝呼吸点
* 画布与各面板优化
* 更新打包发布

***

***

***

## v0.5.371 (2026-09-09)

### 修复与优化

* 文档编辑器、批注面板/气泡与 Md 嵌入优化
* 画布交互优化
* 更新打包发布

***

***

***

## v0.5.370 (2026-09-09)

### 修复与优化

* 画布交互优化
* 更新打包发布

***

***

***

## v0.5.369 (2026-09-09)

### 修复与优化

* 更新下载中新增品牌蓝呼吸点，强化下载进行中感知
* 画布与批注气泡优化
* 更新打包发布

***

***

***

## v0.5.368 (2026-09-09)

### 修复与优化

* Docx 模板面板、模板填充对话框、画布与设置界面优化
* 更新打包发布

***

***

***

## v0.5.367 (2026-09-09)

### 修复与优化

* 更新过渡：发现新版本起即「旧亮新暗」，与下载中起点一致避免跳跃
* 模型能力/模型接口、聊天链路、DocEditor、项目看板与全局样式更新
* 更新打包发布

***

***

***

## v0.5.366 (2026-09-09)

### 修复与优化

* 运行时工具层与聊天工具集更新
* Electron 主进程、聊天节点、画布与技能/Sandbox/Agent Teams 面板优化
* 更新打包发布

***

***

***

## v0.5.365 (2026-09-09)

### 修复与优化

* Electron 主进程/preload 与桌面适配层更新
* 屏幕 OCR、OCR 页面与各画布面板（项目看板/技能/Sandbox/Agent Teams）优化
* 更新打包发布

***

***

***

## v0.5.364 (2026-09-09)

### 修复与优化

* 更新过渡效果优化：下载中新版本号随进度渐亮（去除圆环）；无新版不再显示 Up to date
* 法律技能守卫、聊天链路、屏幕 OCR、MCP Store 与画布优化
* 更新打包发布

***

***

***

## v0.5.363 (2026-09-09)

### 修复与优化

* MCP 类型定义、聊天链路与打包脚本更新
* 更新打包发布

***

***

***

## v0.5.362 (2026-09-09)

### 新功能

* 新增插件面板（PluginPanel）框架与渲染

### 修复与优化

* Electron 主进程/preload 与打包脚本更新
* 问答环节、画布节点、便签/待办、项目接口与全局样式批量优化
* 更新打包发布

***

***

***

## v0.5.361 (2026-09-08)

### 新功能

* 更新入口收口到左下角品牌区版本号：移除独立更新按钮；发现新版本/下载中展示「旧 → 新」过渡与闭环进度圆环；下载完成显示新版本号 + 绿色呼吸灯
* 新增导航搜索框（NavSearchBox）

### 修复与优化

* 画布、聊天节点、设置、待办 Dock、项目看板、本地文件与项目接口等优化
* 更新打包发布

***

***

***

## v0.5.360 (2026-09-08)

### 修复与优化

* 修复打包体积回归：standalone 内 .next.old-*/.next.bak-*/release 构建残留再次误入安装包，已清理并扩展打包防护
* 重新发布（同 0.5.359 功能）

***

## v0.5.359 (2026-09-08)

### 修复与优化

* 画布、本地文件面板与聊天链路优化
* 更新打包发布

***

***

***

## v0.5.358 (2026-09-08)

### 修复与优化

* 安装包瘦身：清理误入 standalone 的 .next 备份残留（约 460M），并加打包防护避免复发
* 更新打包发布

***

***

***

## v0.5.357 (2026-09-08)

### 修复与优化

* 节点压缩源/上下文限制、问答弹窗与聊天链路更新
* 便签/待办与日历同步、规划确认界面更新
* Electron 主进程/preload 与 OCR 截图编辑器、桌面适配更新
* 各画布面板与项目接口优化
* 更新打包发布

***

***

***

## v0.5.356 (2026-09-08)

### 修复与优化

* 轨迹（trajectory）重构：读写/渲染/导出/展示与事件日志
* 运行时（runtime）重构：工具、会话与上下文管理
* 节点压缩、审批、工具流水线、思考策略更新
* 画布节点、BobMind、UnifiedPalette、DocxViewer 与接口更新
* 更新打包发布

***

***

***

## v0.5.355 (2026-09-07)

### 修复与优化

* 图谱桥接/网关与沙箱桥更新
* 画布节点（Agent Teams / Bobby / ImageGen / Annotation）、节点宿主与聊天链路优化
* 更新打包发布

***

***

***

## v0.5.354 (2026-09-07)

### 修复与优化

* 新增问答（Questions）对话环节与弹窗
* 画布节点、Agent Teams、Sandbox、BobMind 与聊天节点批量更新
* 各接口（nodes/edges/agents/skills/notebook/sticky-notes/chat）与全局样式更新
* 更新打包发布

***

***

***

## v0.5.353 (2026-09-07)

### 修复与优化

* 便签/待办、项目看板、画布与 DocEditor 更新
* 聊天链路、工具集、Agent 画像与聊天节点优化
* 更新打包发布

***

***

***

## v0.5.352 (2026-09-07)

### 修复与优化

* 便签/待办数据层与接口、项目看板视图更新
* Agent 画像、聊天工具集、聊天节点与聊天链路优化
* 更新打包发布

***

***

***

## v0.5.351 (2026-09-07)

### 修复与优化

* Agent 市场/注册表与官方包、技能路由更新
* 聊天链路、AICoding、节点会话与设置界面更新
* DocEditor 多栏、侧边栏与画布交互优化
* 更新打包发布

***

***

***

## v0.5.350 (2026-09-06)

### 修复与优化

* 聊天工具集、数据库与项目管理器更新
* UnifiedPalette、聊天节点、侧边栏、节点地图与画布优化
* 更新打包发布

***

***

***

## v0.5.349 (2026-09-06)

### 修复与优化

* 聊天链路、工具集与轨迹时间线更新
* 待办 Dock、便签、通知中心与本地文件面板优化
* DocEditor、节点地图、侧边栏与画布交互优化
* 更新打包发布

***

***

***

## v0.5.348 (2026-09-06)

### 修复与优化

* 待办任务模型、节点接口与全局样式更新
* 图谱网关、节点地图布局与画布/节点地图优化
* AICoding 创建、聊天节点与设置界面更新
* 更新打包发布

***

***

***

## v0.5.347 (2026-09-06)

### 修复与优化

* 聊天链路与轨迹时间线更新
* 图谱网关、节点地图布局、本地文件与节点接口更新
* BobMind、便签/待办 Dock、画布与聊天节点优化
* 更新打包发布

***

***

***

## v0.5.346 (2026-09-05)

### 修复与优化

* 聊天链路、MCP 工具注册与扩展仓库接口更新
* BobMind、聊天节点、DocEditor、Annotation 批注与画布边线优化
* 节点/边/笔记本接口、发布脚本更新
* 更新打包发布

***

***

***

## v0.5.345 (2026-09-05)

### 修复与优化

* 轨迹时间线、画布节点（Agent Teams / Bobby / ImageGen）与节点地图更新
* 图谱网关（graph-gateway）、画布与聊天节点优化
* 更新打包发布

***

***

***

## v0.5.344 (2026-09-05)

### 修复与优化

* 轨迹时间线（TraceTimeline）、画布与聊天节点优化
* 更新打包发布

***

***

***

## v0.5.343 (2026-09-04)

### 修复与优化

* 模板库/模板填充、模板应用与分享导出界面更新
* 画布节点、Agent Teams、日历、聊天节点批量优化
* 轨迹时间线、UnifiedPalette、MCP Store、节点/页面接口更新
* 更新打包发布

***

***

***

## v0.5.342 (2026-09-04)

### 修复与优化

* 聊天轨迹时间线（TraceTimeline）与事件日志更新
* ChatNode、DocEditor、DocxViewer 优化
* 节点/项目/本地文件接口与 ScreenOcr 更新
* 更新打包发布

***

***

***

## v0.5.341 (2026-09-04)

### 修复与优化

* UnifiedPalette、NotesPanel 与设置界面优化
* 全局样式与设置项更新
* 更新打包发布

***

***

***

## v0.5.340 (2026-09-04)

### 修复与优化

* 节点地图（NodeMap）优化
* 更新打包发布

***

***

***

## v0.5.339 (2026-09-04)

### 修复与优化

* 用量统计（Usage）服务端与面板更新

* Word OOXML 修订、DocxViewer 优化

* 项目、本地文件接口与设置界面更新

* 节点地图（NodeMap）更新

* 更新打包发布

***

***

***

## v0.5.338 (2026-09-04)

### 修复与优化

* Word OOXML 修订（ooxml-revise）支持

* DocxViewer 与 UnifiedPalette 优化

* 本地文件、项目接口更新

* 更新打包发布

***

***

***

## v0.5.337 (2026-09-04)

### 修复与优化

* 用量统计（Usage）逻辑与面板更新

* 文档编辑器（DocEditor）优化

* 更新打包发布

***

***

***

## v0.5.336 (2026-09-04)

### 修复与优化

* Word 导入导出（docx ⇄ md）与编号处理更新

* 用量统计面板（Usage）新增

* 文档编辑器、PDF 查看与任务汇总链路优化

* 更新打包发布

***

***

***

## v0.5.335 (2026-09-04)

### 修复与优化

* 新增用量统计（usage 接口）

* 画布节点、对话框与全局样式批量更新

* 聊天链路与数据库层优化

* 更新打包发布

***

***

***

## v0.5.334 (2026-09-04)

### 修复与优化

* 文档注释清理 / 转 Word 导出链路更新

* 本地文件、材料与节点接口更新

* 聊天工具、通知中心、日历面板与画布交互优化

* 更新打包发布

***

***

***

## v0.5.333 (2026-09-04)

### 修复与优化

* 画布交互修复与校验脚本更新

* 更新打包发布

***

***

***

## v0.5.332 (2026-09-04)

### 修复与优化

* 聊天工具集与节点交互更新

* MCP Store / 扩展仓库 / 技能管理 / 快捷启动接口更新

* 画布组件与设置界面优化

* 更新打包发布

***

***

***

## v0.5.331 (2026-09-04)

### 修复与优化

* MCP Store / 扩展仓库 / 技能管理相关接口与面板更新

* 聊天工具集、UnifiedPalette、画布节点与设置界面优化

* 更新打包发布

***

***

***

## v0.5.330 (2026-09-04)

### 修复与优化

* 重新打包发布

***

## v0.5.329 (2026-09-04)

### 修复与优化

* 优化聊天节点

***

## v0.5.328 (2026-09-04)

### 修复与优化

* 优化聊天节点与文档编辑器

***

## v0.5.327 (2026-09-04)

### 修复与优化

* 优化聊天接口与聊天工具、扩展索引接口、MCP 商店接口、快速启动接口、技能接口与浏览器桥接令牌接口

* 优化 MCP 商店面板、Agent 设置、画布流程、聊天节点、节点地图、设置面板、侧边栏、技能管理、开关、回收站、统一命令面板与扩展图标

* 优化 MCP 管理器与 MCP 类型、PDF 插件配置与设置

* 更新扩展数据与索引服务、技能安装/加载服务

* 更新 bob-notes-mcp 插件源码并随包重构建

***

## v0.5.326 (2026-09-04)

### 修复与优化

* 新增快速启动接口，优化聊天接口与聊天工具、扩展索引接口、MCP 商店接口、技能接口

* 优化 MCP 商店面板、Agent 设置、画布流程、聊天节点、节点地图、笔记面板、项目看板

* 优化设置面板、侧边栏、技能管理、开关、回收站、统一命令面板与扩展图标

* 优化 MCP 管理器、OCR 客户端与 MCP 类型、PDF 插件配置与设置

* 更新扩展数据与索引服务、技能安装/加载服务

* 更新 bob-notes-mcp 插件源码并随包重构建

***

## v0.5.325 (2026-09-03)

### 修复与优化

* 优化聊天接口与聊天工具、扩展索引接口、MCP 商店接口

* 新增 MCP 商店面板，优化 MCP 设置、项目看板、设置面板、技能管理、统一命令面板

* 优化聊天节点与 MCP 管理器

* 更新扩展数据与索引服务、MCP 类型、PDF 插件配置与设置

* 更新 bob-notes-mcp 插件源码并随包重构建

***

## v0.5.324 (2026-09-03)

### 修复与优化

* 更新技能加载服务

***

## v0.5.323 (2026-09-03)

### 修复与优化

* 优化设置面板

***

## v0.5.322 (2026-09-03)

### 修复与优化

* 优化技能管理弹窗与回收站弹窗

***

## v0.5.321 (2026-09-03)

### 修复与优化

* 优化聊天接口与聊天工具、技能接口

* 优化画布流程、聊天节点、节点地图、设置面板、侧边栏、技能管理、统一命令面板

* 更新技能安装/加载服务

***

## v0.5.320 (2026-09-03)

### 修复与优化

* 优化聊天接口与聊天工具、技能接口

* 优化画布流程、聊天节点、节点地图、设置面板、侧边栏、技能管理、统一命令面板

* 更新技能安装/加载服务

***

## v0.5.319 (2026-09-03)

### 修复与优化

* 更新 Agent 配置

***

## v0.5.318 (2026-09-03)

### 修复与优化

* 优化画布流程

***

## v0.5.317 (2026-09-03)

### 修复与优化

* 新增计划确认弹窗与聊天确认流程

* 优化聊天接口、确认接口与聊天工具

* 优化聊天节点与 Agent 配置

* 更新 Electron 主进程

***

## v0.5.316 (2026-09-03)

### 修复与优化

* 优化聊天接口与聊天工具、笔记接口、技能接口

* 更新 bob-notes-mcp 插件源码并随包重构建

* 优化聊天节点、笔记面板、设置面板、侧边栏、技能管理、统一命令面板

* 更新 Agent 配置、MCP 管理器与技能安装/加载服务

***

## v0.5.315 (2026-09-03)

### 修复与优化

* 优化日历接口、聊天接口与聊天工具

* 优化项目事件接口与便签接口

* 优化日历面板、画布流程、便签、聊天节点与计划节点

* 优化侧边栏与 Agent 配置

* 新增便签-日历同步，更新数据库、项目事件与项目监视器

***

## v0.5.314 (2026-09-03)

### 修复与优化

* 更新 Electron 主进程与 preload

* 更新 bob-notes-mcp 插件源码（新增检索扩展）并随包重构建

* 优化材料接口与项目接口

* 优化 Agent Teams 面板、便签、聊天节点、HTML 渲染器、文件资源管理器、侧边栏、通知中心

* 更新桌面适配层与类型定义

* 更新打包脚本

***

## v0.5.313 (2026-09-03)

### 修复与优化

* 更新 bob-notes-mcp 插件源码并随包重构建

* 优化聊天工具与 Agent 配置

***

## v0.5.310 (2026-09-02)

### 修复与优化

* 更新 bob-notes-mcp 插件源码并随包重构建

* 优化聊天工具、笔记接口、Wanted 日报与节点会话

* 优化 AI 编程创建弹窗、Agent 设置、日历面板、画布流程

* 优化便签、聊天节点、文档编辑器、MCP 设置、节点卡片头部

* 优化便签节点、笔记面板、设置面板、侧边栏、统一命令面板、通知中心

* 优化微信绑定与沙箱桥接

* 更新 Agent 配置、事件总线、笔记桥接与类型

* 更新便签迁移、Wanted 会话/节点模式/调度/任务模型

* 更新部署与打包脚本

***

## v0.5.308 (2026-09-02)

### 修复与优化

* 优化聊天工具、笔记接口与项目接口

* 优化 Wanted 日报、节点会话、会话与会议会话模块

* 优化 AI 编程创建弹窗、Agent 设置、日历面板、画布流程

* 优化便签、聊天节点、文档编辑器、Docx 模板面板

* 优化 MCP 设置、节点卡片头部、便签节点、笔记面板

* 优化设置面板、侧边栏、统一命令面板、通知中心

* 优化微信绑定、Docx 查看器、屏幕 OCR 编辑器

* 更新 Agent 配置、事件总线、笔记 MCP 桥接、沙箱桥接

* 更新便签迁移、Wanted 指令/执行器/调度/任务模型

***

## v0.5.307 (2026-09-02)

### 修复与优化

* 优化 HTML 渲染器

***

## v0.5.306 (2026-09-02)

### 修复与优化

* 优化聊天工具、笔记接口与笔记 MCP 桥接

* 优化 AI 编程创建弹窗、画布流程、聊天节点、文档编辑器

* 优化便签节点、笔记面板、分享卡片与小红书卡片

* 优化设置面板、统一命令面板、Agent 配置

* 更新 Wanted 指令、执行器、任务模型与便签迁移

* 更新沙箱桥接与 MCP 类型

***

## v0.5.305 (2026-09-02)

### 修复与优化

* 修复打包签名：移出 iCloud 同步目录后在 /tmp 签名，规避 fileprovider 受保护属性

***

## v0.5.304 (2026-09-02)

### 修复与优化

* 修复打包签名：ditto --noextattr 剥离 iCloud fileprovider 等扩展属性，固定证书签名成功

***

## v0.5.303 (2026-09-02)

### 修复与优化

* 修复打包签名：彻底清除 FinderInfo / fileprovider 等扩展属性，固定证书签名成功

***

## v0.5.302 (2026-09-02)

### 修复与优化

* 调试打包签名问题（附加属性诊断）

***

## v0.5.301 (2026-09-02)

### 修复与优化

* 修复打包签名：用 ditto --norsrc 重建应用剥离 resource fork，确保固定证书签名成功（屏幕录制授权跨版本保留）

***

## v0.5.300 (2026-09-02)

### 修复与优化

* 修复打包签名：逐项清理扩展属性（xattr -cr 遇深层 symlink 会中断），确保固定证书签名成功

***

## v0.5.299 (2026-09-02)

### 修复与优化

* 修复打包签名问题：清理 resource fork 后使用固定证书签名（保证屏幕录制授权跨版本保留）

***

## v0.5.298 (2026-09-02)

### 修复与优化

* 更新 Electron 主进程与 preload 脚本

* 优化笔记系统（自然语言查询、操作、接口）

* 优化材料接口与项目接口

* 优化画布组件群：Agent Teams 面板、便签、聊天节点、HTML 渲染器、文件资源管理器、节点地图、笔记面板、设置面板、侧边栏、通知中心

* 更新桌面适配层与类型定义

***

## v0.5.297 (2026-09-02)

### 修复与优化

* 修复 macOS 系统更新后应用提示"已损坏或不完整"的问题（可执行文件名与 Info.plist 声明不一致）

* 打包脚本新增 CFBundleExecutable 一致性自检

***

## v0.5.296 (2026-09-02)

### 修复与优化

* 更新 Electron 主进程

* 优化聊天接口与聊天工具

* 优化笔记系统（接口、存储、网页抓取）

* 新增分享链接接口与分享页

* 优化画布组件群：画布流程、聊天节点、文档编辑器、节点地图、便签节点、侧边栏、统一命令面板、通知中心

* 优化 Wanted 指令、执行器与任务模型

* 优化 PDF 提取与 OCR 服务、沙箱桥接、Agent 配置与 MCP 类型

* 优化屏幕 OCR 编辑器与设置面板

***

## v0.5.287 (2026-09-01)

### 修复与优化

* 优化画布流程、统一命令面板与侧边栏

* 优化节点地图

***

## v0.5.286 (2026-09-01)

### 修复与优化

* 优化屏幕 OCR 编辑器、分享卡片与小红书卡片

* 优化聊天节点内核、模板填写弹窗与侧边栏

***

## v0.5.292 (2026-09-01)

### 修复与优化

* 优化聊天接口、节点接口与项目接口

* 优化画布流程、聊天节点、节点地图与侧边栏

* 优化统一命令面板、通知中心与图片生成节点

* 新增图片生成提示栏与 AI 图片编辑器细节

* 更新事件总线、作业分类与本地文件接口

***

## v0.5.291 (2026-09-01)

### 修复与优化

* 优化聊天接口、节点接口与项目接口

* 优化画布流程、聊天节点、节点地图与侧边栏

* 优化通知中心、统一命令面板与图片生成节点

* 更新事件总线与作业分类

***

## v0.5.290 (2026-09-01)

### 修复与优化

* 大幅更新 Electron 主进程与 preload 脚本

* 更新项目接口与材料接口

* 更新类型定义与 API 路由

***

## v0.5.289 (2026-09-01)

### 修复与优化

* 优化通知中心、画布流程与统一命令面板

* 优化侧边栏、节点地图与事件总线

***

## v0.5.288 (2026-09-01)

### 修复与优化

* 优化 UI 基础组件（弹窗、按钮、输入框）

* 优化画布面板：通知中心、沙箱、项目看板、欢迎屏、问卷、技能管理、便签等

* 优化分享卡片、聊天节点与事件总线

* 更新统一命令面板与 Agent 设置

***

## v0.5.284 (2026-09-01)

### 修复与优化

* 新增图片查看器与日历面板

* 优化统一命令面板、侧边栏、文档编辑器与 Docx 查看器

* 更新全局样式、文件读写接口与 bob-ui 技能资源

* 更新 Electron 主进程

***

## v0.5.283 (2026-09-01)

### 新功能

* 新增 Agent 设置弹窗与 Agents 接口/存储

* 更新 bob-ui 技能资源（组件示例、设计原则等）

### 修复与优化

* 优化画布组件群：侧边栏、画布流程、编码节点、聊天节点、PDF/Docx 查看器、文档编辑器、统一命令面板

* 更新聊天、材料、搜索、文件读写与 PDF OCR 状态接口

* 更新 Electron 主进程与打包脚本

***

## v0.5.282 (2026-08-31)

### 新功能

* 新增统一命令面板（UnifiedPalette）

### 修复与优化

* 更新 Wanted 执行器与命令

* 优化画布流程、聊天接口与屏幕 OCR

* 更新 Electron 主进程与打包脚本

***

## v0.5.281 (2026-08-31)

### 修复与优化

* 优化屏幕 OCR 编辑器与宿主组件

* 优化聊天接口与工具、画布流程

* 更新应用布局、MD 转 DOCX 与 Electron 主进程

***

## v0.5.280 (2026-08-31)

### 修复与优化

* 优化屏幕 OCR 编辑器与聊天节点内核细节

***

## v0.5.279 (2026-08-31)

### 修复与优化

* 优化 HTML 渲染器与 Docx 查看器/文档编辑器

* 优化全局搜索、文件读写与聊天接口

* 更新 Electron 主进程

***

## v0.5.278 (2026-08-31)

### 修复与优化

* 优化全局搜索与搜索结果展示

* 新增/优化节点回收站与删除流程

* 优化画布流程、聊天节点与侧边栏

* 更新文档编辑器与 Electron 主进程

***

## v0.5.277 (2026-08-31)

### 修复与优化

* 优化屏幕 OCR 编辑器与捕获流程

* 优化分享卡片细节

* 更新 Electron 主进程

***

## v0.5.276 (2026-08-31)

### 修复与优化

* 优化屏幕 OCR 编辑器、设置面板与捕获流程

* 优化聊天节点与画布交互

* 更新 Electron 主进程与桌面适配层

***

## v0.5.275 (2026-08-31)

### 新功能

* 新增屏幕 OCR 编辑器组件（截图识别结果直接编辑）

### 修复与优化

* 优化屏幕 OCR 设置、捕获流程与权限预检

* 更新聊天工具与聊天节点

* 优化画布、小红书卡片与设置面板

* 更新 Electron 主进程、preload 与桌面适配层

***

## v0.5.274 (2026-08-31)

### 修复与优化

* 优化屏幕 OCR：权限预检、捕获流程与设置面板

* 更新 DOCX 修订引擎与文档编辑器（Docx 查看器细节）

* 优化画布流程、聊天节点、小红书卡片与设置面板

* 更新 Electron 主进程、preload 与桌面适配层

***

## v0.5.273 (2026-08-30)

### 修复与优化

* 修复小红书卡片导出与配图细节

***

## v0.5.272 (2026-08-30)

### 新功能

* 新增 Markdown 划词批注气泡：批注模式下划词即弹出气泡，可直接添加批注、划词引用到当前/新建节点、划词创建便签卡片

### 修复与优化

* 优化文档编辑器与 Docx 查看器（修订渲染、修订模式与保存细节）

* 更新 DOCX 修订引擎脚本（OOXML track changes）

* 优化画布流程、任务面板与小红书卡片交互

* 更新 Electron 主进程与打包脚本

***

## v0.5.271 (2026-08-30)

### 修复与优化

* 优化聊天节点、节点地图与文档编辑器

* 修复 Docx 查看器、DOCX 导出与小红书卡片细节

***

## v0.5.270 (2026-08-30)

### 修复与优化

* 优化屏幕 OCR 捕获、权限与前端面板

* 修复画布流程、聊天节点与 Docx 查看器细节

* 更新 electron 主进程与桌面适配层

***

## v0.5.269 (2026-08-30)

### 修复与优化

* 优化 DOCX 修订处理、Docx 查看器与聊天工具/接口

***

## v0.5.268 (2026-08-30)

### 修复与优化

* 新增 DOCX 修订审计接口，优化修订处理与 Docx 查看器

* 优化屏幕 OCR 捕获与权限处理

* 修复本地文件接口、聊天工具、聊天节点与画布流程细节

***

## v0.5.267 (2026-08-30)

### 修复与优化

* 优化 Docx 查看器交互与显示细节

***

## v0.5.266 (2026-08-30)

### 修复与优化

* 优化聊天工具与 Docx 查看器细节

***

## v0.5.265 (2026-08-30)

### 修复与优化

* 优化 DOCX 修订接口、Docx 查看器与侧边栏细节

***

## v0.5.264 (2026-08-30)

### 修复与优化

* 新增 DOCX 修订接口与 OOXML 修订处理

* 优化文档编辑器、Docx 查看器与侧边栏细节

***

## v0.5.263 (2026-08-30)

### 修复与优化

* 重新打包发布（v0.5.262 上传中断且获取上传地址失败，产物不完整）

* 新增屏幕 OCR 编辑器与结果面板

* 优化屏幕捕获、聊天节点、画布流程与桌面适配层

***

## v0.5.262 (2026-08-30)

### 修复与优化

* 新增屏幕 OCR 编辑器与结果面板

* 优化屏幕捕获、聊天节点、画布流程与桌面适配层

***

## v0.5.261 (2026-08-30)

### 修复与优化

* 优化文档编辑器、项目接口与聊天接口细节

***

## v0.5.260 (2026-08-30)

### 修复与优化

* 优化待办面板、文档编辑器、节点地图与批注节点

* 修复画布流程、思维便签与聊天节点细节

* 新增 AI 插画提示词接口，优化小红书卡片与设置逻辑

***

## v0.5.259 (2026-08-29)

### 修复与优化

* 优化小红书分享卡片展示细节

***

## v0.5.258 (2026-08-29)

### 修复与优化

* 优化小红书 doodle 接口、分享卡片与设置逻辑

* 修复聊天接口相关细节

***

## v0.5.257 (2026-08-29)

### 修复与优化

* 新增小红书图文 doodle 接口与卡片优化

* 修复 Agent Teams 面板、连线与设置相关细节

***

## v0.5.256 (2026-08-29)

### 修复与优化

* 优化 DOCX 导出弹窗与 Markdown 转 DOCX 逻辑

***

## v0.5.255 (2026-08-29)

### 修复与优化

* 优化文档编辑器与 Docx 查看器

* 修复便签、待办、项目看板与小红书卡片细节

***

## v0.5.254 (2026-08-29)

### 修复与优化

* 新增小红书分享卡片（XhsCard）

* 优化分享卡片与设置相关逻辑

***

## v0.5.253 (2026-08-29)

### 修复与优化

* 优化聊天节点内核与交互细节

***

## v0.5.252 (2026-08-29)

### 修复与优化

* 优化分享卡片生成与展示细节

***

## v0.5.251 (2026-08-29)

### 修复与优化

* 优化便签与待办清单逻辑

* 修复聊天节点、项目看板与画布流程细节

***

## v0.5.250 (2026-08-29)

### 修复与优化

* 优化节点 Markdown 解析与节点接口

* 修复批注气泡、文档编辑器、思维便签与画布流程细节

***

## v0.5.249 (2026-08-29)

### 修复与优化

* 新增屏幕 OCR 识别能力（截图识别文字）

* 优化图网关、AI HTML 编辑、HTML 预览与捕获逻辑

* 修复聊天节点、画布流程、批注气泡与文档编辑器细节

* 更新 electron 主进程与桌面适配层

***

## v0.5.248 (2026-08-29)

### 修复与优化

* 优化 BobMail 通知中心与待办面板交互细节

***

## v0.5.247 (2026-08-29)

### 修复与优化

* 优化分享卡片生成与展示细节

***

## v0.5.246 (2026-08-29)

### 修复与优化

* 优化 HTML AI 编辑接口与预览查看器

***

## v0.5.245 (2026-08-29)

### 修复与优化

* 重新打包发布（v0.5.244 版本名被 GitCode 平台拦截，无法创建 Release）

* 优化画布流程与聊天节点交互细节

***

## v0.5.244 (2026-08-29)

### 修复与优化

* 优化画布流程与聊天节点交互细节

***

## v0.5.243 (2026-08-29)

### 修复与优化

* 修复项目看板与 Agent Teams 面板相关细节

***

## v0.5.242 (2026-08-29)

### 修复与优化

* 优化模板面板与聊天节点交互细节

* 修复画布流程与 Agent Teams 面板问题

* 优化全局样式

***

## v0.5.241 (2026-08-28)

### 修复与优化

* 优化 PDF 查看器交互与显示细节

***

## v0.5.240 (2026-08-28)

### 修复与优化

* 优化节点地图与画布流程交互细节

* 修复项目看板相关界面问题

***

## v0.5.239 (2026-08-28)

### 修复与优化

* 新增/优化批注节点（AnnotationNode）与节点地图交互

* 优化节点 Markdown 解析与节点接口

* 修复画布流程、思维便签节点与设置面板细节

***

## v0.5.238 (2026-08-28)

### 修复与优化

* 重新打包发布（v0.5.237 上传中断，产物不完整）

* 优化思维便签节点交互细节

***

## v0.5.237 (2026-08-28)

### 修复与优化

* 优化思维便签节点交互细节

***

## v0.5.236 (2026-08-28)

### 修复与优化

* 修复 Agent Teams 面板在团队运行中缺失字段时导致的应用崩溃（status.members/tasks/messages 空值保护）

***

## v0.5.235 (2026-08-28)

### 修复与优化

* 优化思维便签节点交互与组件渲染细节

***

## v0.5.234 (2026-08-28)

### 修复与优化

* 优化节点与边接口、节点 Markdown 解析

* 修复画布流程与思维便签节点交互细节

* 优化聊天节点、侧边栏与设置服务

***

## v0.5.233 (2026-08-28)

### 修复与优化

* 优化画布子节点布局与流程逻辑

* 修复设置面板与聊天节点细节

* 优化全局样式与设置服务

***

## v0.5.232 (2026-08-28)

### 修复与优化

* 优化技能管理、自定义工具与模板库弹窗交互

* 修复微信绑定、MCP 设置弹窗细节

* 优化聊天节点、画布流程与设置面板

***

## v0.5.231 (2026-08-28)

### 修复与优化

* 优化聊天节点内核与思维便签节点交互

* 修复设置面板与全局样式细节

***

## v0.5.230 (2026-08-28)

### 修复与优化

* 优化设置面板交互与界面细节

***

## v0.5.229 (2026-08-28)

### 修复与优化

* 优化日历事件与 ICS 订阅逻辑

* 修复 Agent Teams 面板与图像生成节点交互细节

* 优化 MCP 连接、OCR 任务管理与设置服务

* 修复聊天节点与画布流程相关细节

***

## v0.5.228 (2026-08-28)

### 修复与优化

* 优化画布流程与思维便签节点交互细节

***

## v0.5.227 (2026-08-28)

### 修复与优化

* 优化 OCR 识别、PDF 文本搜索与图片解析缓存

* 修复便签、WANTED 笔记语义与执行逻辑

* 优化节点 Markdown 解析与画布流程

* 修复轨迹记录、本地文件面板与聊天节点细节

***

## v0.5.226 (2026-08-27)

### 修复与优化

* 优化 MCP 连接管理与测试逻辑

* 修复 Agent Teams 面板与聊天节点细节

* 优化设置服务与全局样式

***

## v0.5.225 (2026-08-27)

### 修复与优化

* 优化 OCR 客户端与识别任务管理逻辑

* 新增/优化 Agent Teams 相关面板与流程

* 优化 Mermaid 图表渲染与文档导出

* 修复聊天节点、画布流程与 electron 主进程细节

***

## v0.5.224 (2026-08-27)

### 修复与优化

* 优化日历事件与 ICS 订阅相关逻辑

* 修复图像生成节点与历史记录面板交互细节

* 优化 PDF 查看器、聊天节点与画布流程

* 优化模板填充、侧边栏与全局样式

***

## v0.5.223 (2026-08-27)

### 修复与优化

* 优化聊天节点内核与交互细节

* 修复白板面板相关问题

* 优化全局样式与界面表现

***

## v0.5.222 (2026-08-27)

### 修复与优化

* 优化文档编辑器与批注气泡交互体验

* 修复聊天节点内核与画布流程相关细节问题

* 优化设置面板样式与界面细节

***

## v0.5.221 (2026-08-27)

### 修复与优化

* 优化 OCR、PDF 文本搜索与本地文件面板相关逻辑

* 修复 Bobby、日历、画布、白板、图像生成节点等面板交互细节问题

* 优化聊天、便签、WANTED 指令与 MCP 相关逻辑

***

## v0.5.220 (2026-08-27)

### 修复与优化

* 修复 AI 编辑、MD 标注、文档编辑器、画布、项目看板等面板交互细节问题

* 优化聊天、便签、本地文件面板与查看器相关逻辑

***

## v0.5.219 (2026-08-27)

### 修复与优化

* 优化笔记语义检索与 WANTED 指令执行逻辑

* 修复 MD 标注与文档编辑器相关细节问题

***

## v0.5.218 (2026-08-26)

### 修复与优化

* 修复 MD 标注与文档编辑器相关细节问题

* 优化 Electron 主进程与 preload 相关逻辑

***

## v0.5.217 (2026-08-26)

### 修复与优化

* 修复 MD 标注、文档编辑器、标注气泡与 AI 编辑相关细节问题

***

## v0.5.216 (2026-08-26)

### 修复与优化

* 修复 MD 标注、文档编辑器与标注气泡相关细节问题

***

## v0.5.215 (2026-08-26)

### 修复与优化

* 修复 AI 编辑、MD 标注、文档编辑器、画布、项目看板等面板交互细节问题

* 优化聊天、便签、节点图与查看器相关逻辑

***

## v0.5.214 (2026-08-26)

### 修复与优化

* 修复 MD 编辑、MD 标注、文档编辑器与标注气泡相关细节问题

***

## v0.5.213 (2026-08-26)

### 修复与优化

* 修复文档编辑器与标注气泡相关细节问题

***

## v0.5.212 (2026-08-26)

### 修复与优化

* 修复日历、画布、便签、图像生成节点、HTML 查看器、沙箱、MD 标注、文档编辑器等面板交互细节问题

* 优化聊天、Bobby、WANTED 指令与 MCP 相关逻辑

***

## v0.5.211 (2026-08-26)

### 修复与优化

* 修复 MD 编辑面板相关细节问题

***

## v0.5.210 (2026-08-26)

### 修复与优化

* 优化节点 Markdown 渲染逻辑

***

## v0.5.209 (2026-08-26)

### 修复与优化

* 修复聊天节点、画布相关细节问题

* 优化节点 Markdown 渲染与节点列表逻辑

***

## v0.5.208 (2026-08-26)

### 修复与优化

* 修复 MD 编辑、MD 标注、文档编辑器相关细节问题

* 优化 AI 编辑相关逻辑

***

## v0.5.207 (2026-08-26)

### 修复与优化

* 优化聊天相关逻辑

***

## v0.5.206 (2026-08-26)

### 修复与优化

* 修复日历、画布、图像生成节点、模板填充、项目看板、文档编辑器等面板交互细节问题

* 优化聊天与内容渲染相关逻辑

***

## v0.5.205 (2026-08-26)

### 修复与优化

* 修复日历、画布、图像生成节点、模板填充、项目看板等面板交互细节问题

* 优化聊天与内容渲染相关逻辑

***

## v0.5.204 (2026-08-26)

### 修复与优化

* 修复 AI 编辑、MD 标注、文档编辑器、画布、项目看板等面板交互细节问题

* 优化聊天、便签、节点图与网页搜索相关逻辑

***

## v0.5.203 (2026-08-26)

### 修复与优化

* 修复 AI 编辑、MD 标注、文档编辑器、画布、项目看板等面板交互细节问题

* 优化聊天、便签、节点图与网页搜索相关逻辑

***

## v0.5.202 (2026-08-26)

### 修复与优化

* 修复日历、画布、图像生成节点、AI 编辑、文档编辑器等面板交互细节问题

* 优化聊天与模板填充相关逻辑

***

## v0.5.201 (2026-08-26)

### 修复与优化

* 修复 AI 编辑、MD 标注、文档编辑器、项目看板等面板交互细节问题

* 优化聊天、便签、节点图与网页搜索相关逻辑

***

## v0.5.200 (2026-08-26)

### 修复与优化

* 修复 AI 编辑、文档编辑器、项目看板相关细节问题

* 优化聊天与 MD 编辑面板相关逻辑

***

## v0.5.199 (2026-08-26)

### 修复与优化

* 修复 AI 编辑、MD 标注、文档编辑器相关细节问题

* 优化节点图、设置弹窗与 Bobby 相关逻辑

***

## v0.5.198 (2026-08-26)

### 修复与优化

* 修复画布便签、聊天节点相关细节问题

* 优化每日报告与聊天相关逻辑

***

## v0.5.197 (2026-08-26)

### 修复与优化

* 修复 Bobby 节点、MCP 设置弹窗、内容渲染相关细节问题

* 优化聊天与全局样式相关逻辑

***

## v0.5.196 (2026-08-26)

### 修复与优化

* 修复 Bobby 节点、日历、画布、图像生成节点等面板交互细节问题

* 优化聊天、MCP 与内容渲染相关逻辑

***

## v0.5.195 (2026-08-26)

### 修复与优化

* 修复图像生成节点、画布、便签、日历、项目看板等面板交互细节问题

* 优化聊天、WANTED 指令与 MCP 相关逻辑

***

## v0.5.194 (2026-08-26)

### 修复与优化

* 修复日历面板、画布、便签相关细节问题

* 优化聊天节点与日历事件相关逻辑

***

## v0.5.193 (2026-08-26)

### 修复与优化

* 修复画布、便签、日历、项目看板、执行轨迹等面板交互细节问题

* 优化聊天、WANTED 指令、Bobby 节点与 MCP 相关逻辑

***

## v0.5.192 (2026-08-25)

### 修复与优化

* 修复聊天、Bobby 节点相关细节问题

* 优化 MCP 类型相关逻辑

***

## v0.5.191 (2026-08-25)

### 修复与优化

* 修复画布连线、Bobby 节点相关细节问题

* 优化聊天与 MCP 类型相关逻辑

***

## v0.5.190 (2026-08-25)

### 修复与优化

* 修复聊天、Bobby 节点、项目看板相关细节问题

* 优化 MCP 类型与画布相关逻辑

***

## v0.5.189 (2026-08-25)

### 修复与优化

* 修复聊天、节点与 Bobby 节点相关细节问题

* 优化 MCP 类型与节点 Markdown 渲染逻辑

***

## v0.5.188 (2026-08-25)

### 修复与优化

* 修复聊天节点、设置弹窗、内容渲染相关细节问题

* 优化解析缓存与应用初始化逻辑

***

## v0.5.187 (2026-08-25)

### 修复与优化

* 修复通知中心、画布、便签、项目看板等面板交互细节问题

* 优化聊天节点、设置弹窗与侧边栏相关逻辑

***

## v0.5.186 (2026-08-25)

### 修复与优化

* 修复聊天节点与侧边栏相关细节问题

* 优化聊天相关逻辑

***

## v0.5.185 (2026-08-25)

### 修复与优化

* 修复侧边栏相关细节问题

* 优化 AI 工具调用相关逻辑

***

## v0.5.184 (2026-08-25)

### 修复与优化

* 优化聊天与解析缓存相关逻辑

* 修复 OCR / 视觉识别 / 图片解析相关细节问题

***

## v0.5.183 (2026-08-25)

### 修复与优化

* 修复设置弹窗与聊天节点相关细节问题

* 优化应用设置相关逻辑

***

## v0.5.182 (2026-08-25)

### 修复与优化

* 修复执行轨迹、聊天节点、侧边栏相关细节问题

* 优化节点、轨迹事件日志相关逻辑

***

## v0.5.181 (2026-08-25)

### 修复与优化

* 修复 CalDAV 日历同步相关细节问题

***

## v0.5.180 (2026-08-25)

### 修复与优化

* 修复项目看板相关细节问题

* 优化全局样式细节

***

## v0.5.179 (2026-08-25)

### 修复与优化

* 修复设置弹窗相关细节问题

* 修复聊天节点相关细节问题

***

## v0.5.178 (2026-08-25)

### 修复与优化

* 修复画布、便签、项目看板、执行轨迹等面板交互细节问题

* 修复 WANTED 指令执行与节点图相关细节问题

* 优化项目文件列表与工具调用相关逻辑

***

## v0.5.177 (2026-08-25)

### 修复与优化

* 修复聊天节点相关细节问题

* 修复 Md 编辑面板相关细节问题

***

## v0.5.176 (2026-08-25)

### 修复与优化

* 修复画布便签、项目看板、执行轨迹等面板交互细节问题

* 修复聊天节点与项目文件列表相关细节问题

* 优化便签迁移、待办索引与项目相关逻辑

***

## v0.5.175 (2026-08-25)

### 修复与优化

* 修复画布便签相关细节问题

* 修复项目看板相关细节问题

***

## v0.5.174 (2026-08-25)

### 修复与优化

* 修复画布便签、项目看板、执行轨迹等面板交互细节问题

* 修复聊天节点与全局样式细节问题

* 优化思考解析、待办索引与项目文件列表相关逻辑

***

## v0.5.173 (2026-08-24)

### 修复

* 修复便签笔记迁移的并发写入冲突与删除项目时笔记丢失问题

* 修复 WANTED 指令执行链路多项健壮性问题

* 修复本地文件面板、项目看板、执行轨迹面板细节问题

***

## v0.5.172 (2026-08-24)

### 新增

* Output Files 卡片新增「打开所在文件夹」按钮：在 Finder/资源管理器中定位并选中文件（本地文件面板右键菜单同步新增 Reveal in Finder）

* 左侧边栏 Workspace 标题栏新增项目图标：点击即可切换项目（原项目行 ▾ 下拉移除）

* 左侧边栏 Workspace 标题栏新增刷新按钮：一键刷新当前项目文件列表

* 项目标题行新增「在 Finder 中打开」「保存为模板」图标按钮（纯图标，无文字）

* materials 支持上传文件夹：保留完整目录结构

* 右侧本地文件面板新增「一键打开文件夹」按钮（系统文件管理器中打开当前目录）

* chat 输入框 @ 弹窗：选择文件后自动关闭；点击弹窗外部 / 按 Esc 自动关闭

### 优化

* BobMail 弹层点击外部任意位置自动收起

* 项目卡片归档/删除按钮从 ⋮ 菜单移至底部「打开本地文件」按钮旁

* sticky todo 模板标签新增删除按钮，支持删除模板

* AI 回复内容图片增加高度限制（max-height 60vh），过长图片自动等比缩小，不再撑出滚动条

* notes-memory 目录加入隐藏列表（与 sticky-notes/wanted 一致，文件树不再显示）

* 移除项目 ⋮ 菜单（Collapse file tree / Edit project info），菜单内操作已全部迁出

* 右侧本地文件面板：

  * 目录行去掉电脑/硬盘图标，仅保留文件夹图标（展开/收起态区分）

  * 目录名下方路径不再显示

  * Up 按钮移至顶部工具栏；移除展开区导航条路径

  * 面板宽度调整为与左侧边栏一致（322）

***

## v0.5.171 (2026-08-24)

### 说明

* 与 v0.5.170 内容一致，版本号递增重发

***

## v0.5.170 (2026-08-24)

### 说明

* 与 v0.5.169 内容一致，版本号递增重发

***

## v0.5.169 (2026-08-24)

### 说明

* 与 v0.5.168 内容一致，版本号递增重发

***

## v0.5.168 (2026-08-24)

### 说明

* BobMail 日历提醒标题精简：去除 "Upcoming —" / "Overdue —" 英文前缀文字，仅保留 ⏰/⚠️ 图标 + 事件标题（左侧列表与正文标题同步生效）

***

## v0.5.167 (2026-08-24)

### 说明

* 与 v0.5.166 内容一致，版本号递增重发

***

## v0.5.166 (2026-08-24)

### 说明

* 与 v0.5.165 内容一致，版本号递增重发

***

## v0.5.165 (2026-08-24)

### 说明

* 与 v0.5.164 内容一致，版本号递增重发

***

## v0.5.164 (2026-08-24)

### 说明

* 与 v0.5.163 内容一致，版本号递增重发

***

## v0.5.163 (2026-08-24)

### 说明

* 与 v0.5.162 内容一致，版本号递增重发

***

## v0.5.162 (2026-08-24)

### 说明

* 与 v0.5.161 内容一致，版本号递增重发

***

## v0.5.161 (2026-08-24)

### 说明

* 与 v0.5.160 内容一致，版本号递增重发

***

## v0.5.160 (2026-08-24)

### 说明

* 与 v0.5.159 内容一致，版本号递增重发

***

## v0.5.159 (2026-08-24)

### 说明

* 与 v0.5.158 内容一致，版本号递增重发

***

## v0.5.158 (2026-08-24)

### 说明

* 与 v0.5.157 内容一致，版本号递增重发

***

## v0.5.157 (2026-08-24)

### 说明

* 与 v0.5.156 内容一致，版本号递增重发

***

## v0.5.156 (2026-08-24)

### 说明

* 与 v0.5.155 内容一致，版本号递增重发

***

## v0.5.155 (2026-08-24)

### 说明

* 与 v0.5.154 内容一致，版本号递增重发

***

## v0.5.154 (2026-08-24)

### 说明

* 与 v0.5.153 内容一致，版本号递增重发

***

## v0.5.153 (2026-08-23)

### 说明

* 与 v0.5.152 内容一致，版本号递增重发

***

## v0.5.152 (2026-08-23)

### 说明

* 与 v0.5.151 内容一致，版本号递增重发

***

## v0.5.151 (2026-08-23)

### 说明

* 与 v0.5.150 内容一致，版本号递增重发

***

## v0.5.150 (2026-08-23)

### 说明

* 与 v0.5.149 内容一致，版本号递增重发

***

## v0.5.149 (2026-08-23)

### 说明

* 与 v0.5.148 内容一致，版本号递增重发

***

## v0.5.148 (2026-08-23)

### 说明

* 与 v0.5.147 内容一致，版本号递增重发

***

## v0.5.147 (2026-08-23)

### 说明

* 与 v0.5.146 内容一致，版本号递增重发

***

## v0.5.146 (2026-08-23)

### 说明

* 与 v0.5.145 内容一致，版本号递增重发

***

## v0.5.145 (2026-08-23)

### 说明

* 与 v0.5.144 内容一致，版本号递增重发

***

## v0.5.144 (2026-08-23)

### 说明

* 与 v0.5.143 内容一致，版本号递增重发

***

## v0.5.143 (2026-08-23)

### 说明

* 与 v0.5.142 内容一致，版本号递增重发

***

## v0.5.142 (2026-08-23)

### 说明

* 与 v0.5.141 内容一致，版本号递增重发

***

## v0.5.141 (2026-08-23)

### 说明

* 与 v0.5.140 内容一致，版本号递增重发

***

## v0.5.140 (2026-08-22)

### 说明

* 与 v0.5.139 内容一致，版本号递增重发

***

## v0.5.139 (2026-08-22)

### 说明

* 与 v0.5.138 内容一致，版本号递增重发

***

## v0.5.138 (2026-08-22)

### 说明

* 与 v0.5.137 内容一致，版本号递增重发

***

## v0.5.137 (2026-08-22)

### 说明

* 与 v0.5.136 内容一致，版本号递增重发

***

## v0.5.136 (2026-08-22)

### 说明

* 与 v0.5.135 内容一致，版本号递增重发

***

## v0.5.135 (2026-08-22)

### 说明

* 与 v0.5.134 内容一致，版本号递增重发

***

## v0.5.134 (2026-08-22)

### 说明

* 与 v0.5.133 内容一致，版本号递增重发

***

## v0.5.133 (2026-08-22)

### 说明

* 与 v0.5.132 内容一致，版本号递增重发

***

## v0.5.132 (2026-08-22)

### 说明

* 与 v0.5.131 内容一致，版本号递增重发

***

## v0.5.131 (2026-08-22)

### 说明

* 与 v0.5.130 内容一致，版本号递增重发

***

## v0.5.130 (2026-08-22)

### 说明

* 与 v0.5.129 内容一致，版本号递增重发

***

## v0.5.129 (2026-08-22)

### 说明

* 与 v0.5.128 内容一致，版本号递增重发

***

## v0.5.128 (2026-08-22)

### 说明

* 与 v0.5.127 内容一致，版本号递增重发

***

## v0.5.127 (2026-08-22)

### 新增

* 便签一键找回（修复 AI 创建的便签坐标越界不可见）：顶部标题栏右上角新增「便签色块坞」，显示项目内所有便签色块（颜色 = 便签颜色，hover 显示标题）；点击色块将该便签重新定位到可视区中心（级联偏移防重叠、置顶、品牌紫脉冲高亮），离屏便签不再"凭空消失"

* create\_sticky\_note 工具根因修复：移除模型自编 x/y 坐标参数，改为服务端级联分配可视位置，从源头避免便签落在窗口外

### 优化

* 前缀缓存稳定性（deepseek-harness C8 思路落地）：用户偏好目录、思考深度指令从 system 移出改为 prepend 到当前轮 user 消息；工具循环内每轮携带 tools（收尾轮不再去掉）；新增缓存头指纹诊断（head 哈希，前缀失效时黄色告警徽标），首轮前下发 context\_meter、done 附 stats/contextMeter

* 系统提示词审查修复：ai-card 渲染恢复、工具清单补全 10 类、浏览器命名说明、配色精简、附件合并、输出结构合并

* 工具清理：移除 draw 工具、过滤 ocr.recognize 重复工具、关闭 sequential-thinking 与 github MCP（settings.json），内置工具 48 个

***

## v0.5.126 (2026-08-21)

### 说明

* 与 v0.5.125 内容一致，版本号递增重发

***

## v0.5.125 (2026-08-21)

### 说明

* 与 v0.5.124 内容一致，版本号递增重发

***

## v0.5.124 (2026-08-21)

### 说明

* 与 v0.5.123 内容一致，版本号递增重发

***

## v0.5.123 (2026-08-21)

### 说明

* 与 v0.5.122 内容一致，版本号递增重发

***

## v0.5.122 (2026-08-21)

### 说明

* 与 v0.5.121 内容一致，版本号递增重发

***

## v0.5.121 (2026-08-21)

### 说明

* 与 v0.5.120 内容一致，版本号递增重发

***

## v0.5.120 (2026-08-21)

### 说明

* 与 v0.5.119 内容一致，版本号递增重发

***

## v0.5.119 (2026-08-21)

### 说明

* 与 v0.5.118 内容一致，版本号递增重发

***

## v0.5.118 (2026-08-21)

### 说明

* 与 v0.5.117 内容一致，版本号递增重发

***

## v0.5.117 (2026-08-21)

### 说明

* 与 v0.5.116 内容一致，版本号递增重发

***

## v0.5.116 (2026-08-21)

### 说明

* 与 v0.5.115 内容一致，版本号递增重发

***

## v0.5.115 (2026-08-21)

### 说明

* 与 v0.5.114 内容一致，版本号递增重发

***

## v0.5.114 (2026-08-21)

### 说明

* 与 v0.5.113 内容一致，版本号递增重发

***

## v0.5.113 (2026-08-21)

### 说明

* 与 v0.5.112 内容一致，版本号递增重发

***

## v0.5.112 (2026-08-21)

### 说明

* 与 v0.5.111 内容一致，版本号递增重发

***

## v0.5.111 (2026-08-21)

### 说明

* 与 v0.5.110 内容一致，版本号递增重发

***

## v0.5.110 (2026-08-21)

### 说明

* 与 v0.5.109 内容一致，版本号递增重发

***

## v0.5.109 (2026-08-21)

### 说明

* 修复画布聚焦高亮引发的 React #185 无限更新循环（highlightedNodeIds 按内容签名缓存 Set 实例）

***

## v0.5.108 (2026-08-21)

### 说明

* 与 v0.5.107 内容一致，版本号递增重发

***

## v0.5.107 (2026-08-21)

### 说明

* 与 v0.5.106 内容一致，版本号递增重发

***

## v0.5.106 (2026-08-21)

### 说明

* 与 v0.5.105 内容一致，版本号递增重发

***

## v0.5.105 (2026-08-21)

### 说明

* 与 v0.5.104 内容一致，版本号递增重发

***

## v0.5.104 (2026-08-20)

### 说明

* 与 v0.5.103 内容一致，版本号递增重发

***

## v0.5.103 (2026-08-20)

### 说明

* 与 v0.5.102 内容一致，版本号递增重发

***

## v0.5.102 (2026-08-20)

### 说明

* 与 v0.5.101 内容一致，版本号递增重发

***

## v0.5.101 (2026-08-20)

### 说明

* 与 v0.5.100 内容一致，版本号递增重发

***

## v0.5.100 (2026-08-20)

### 说明

* 与 v0.5.99 内容一致，版本号递增重发

***

## v0.5.99 (2026-08-20)

### 说明

* 与 v0.5.98 内容一致，版本号递增重发

***

## v0.5.98 (2026-08-20)

### 说明

* 与 v0.5.97 内容一致，版本号递增重发

***

## v0.5.97 (2026-08-20)

### 说明

* 与 v0.5.96 内容一致，版本号递增重发

***

## v0.5.96 (2026-08-20)

### 说明

* 与 v0.5.95 内容一致，版本号递增重发

***

## v0.5.95 (2026-08-20)

### 说明

* 与 v0.5.94 内容一致，版本号递增重发

***

## v0.5.94 (2026-08-20)

### 说明

* 与 v0.5.93 内容一致，版本号递增重发

***

## v0.5.93 (2026-08-20)

### 说明

* 与 v0.5.92 内容一致，版本号递增重发

***

## v0.5.92 (2026-08-20)

### 说明

* 与 v0.5.91 内容一致，版本号递增重发

***

## v0.5.91 (2026-08-20)

### 说明

* 与 v0.5.90 内容一致，版本号递增重发

***

## v0.5.90 (2026-08-20)

### 说明

* 与 v0.5.89 内容一致，版本号递增重发

***

## v0.5.89 (2026-08-20)

### 说明

* 与 v0.5.88 内容一致，版本号递增重发

***

## v0.5.88 (2026-08-20)

### 说明

* 与 v0.5.87 内容一致，版本号递增重发

***

## v0.5.87 (2026-08-20)

### 说明

* 与 v0.5.86 内容一致，版本号递增重发

***

## v0.5.86 (2026-08-19)

### 说明

* 与 v0.5.85 内容一致，版本号递增重发

***

## v0.5.85 (2026-08-19)

### 说明

* 与 v0.5.84 内容一致，版本号递增重发

***

## v0.5.84 (2026-08-19)

### 说明

* 与 v0.5.83 内容一致，版本号递增重发

***

## v0.5.83 (2026-08-19)

### 说明

* 与 v0.5.82 内容一致，版本号递增重发

***

## v0.5.82 (2026-08-19)

### 说明

* 与 v0.5.81 内容一致，版本号递增重发

***

## v0.5.81 (2026-08-19)

### 说明

* 与 v0.5.80 内容一致，版本号递增重发

***

## v0.5.80 (2026-08-19)

### 说明

* 与 v0.5.79 内容一致，版本号递增重发

***

## v0.5.79 (2026-08-19)

### 说明

* 与 v0.5.78 内容一致，版本号递增重发

***

## v0.5.78 (2026-08-19)

### 说明

* 与 v0.5.77 内容一致，版本号递增重发

***

## v0.5.77 (2026-08-19)

### 说明

* 与 v0.5.76 内容一致，版本号递增重发

***

## v0.5.76 (2026-08-19)

### 说明

* 与 v0.5.75 内容一致，版本号递增重发

***

## v0.5.75 (2026-08-19)

### 说明

* 与 v0.5.74 内容一致，版本号递增重发

***

## v0.5.74 (2026-08-18)

### 说明

* 与 v0.5.73 内容一致，版本号递增重发

***

## v0.5.73 (2026-08-18)

### 说明

* 修复安装时选错安装包版本的关键 bug：缓存中存在多个版本 zip 时（如 0.5.70/0.5.71/0.5.72），原先按字母序取第一个会装回最旧版本导致永远无法升级；现在改为始终安装版本号最高的安装包

* 前端增加下载状态兜底看门狗：下载中 3 分钟无进度自动回到可下载状态，防止异常时 UI 永久转圈

***

## v0.5.72 (2026-08-18)

### 说明

* 修复自动更新下载完成后复检同版本时 UI 卡在"下载中"转圈的问题：下载已完成且校验通过时补发 `update:downloaded` 事件

* 自动清理已安装版本的完整安装包缓存（仅保留高于当前版本的 zip），避免缓存累积占用磁盘

***

## v0.5.71 (2026-08-18)

### 说明

* 与 v0.5.70 内容一致，版本号递增重发

***

## v0.5.70 (2026-08-18)

### 说明

* 与 v0.5.69 内容一致，版本号递增重发

***

## v0.5.69 (2026-08-18)

### 说明

* 自动更新升级为自研断点续传下载器：下载中断（断网/杀进程/重启）后保留 `.partial` 断点，下次检查自动从断点继续而非全量重下；含 3 次指数退避自动重试、sha512 校验、磁盘空间预检、302 重定向跟随；electron-updater 仅负责版本检查

***

## v0.5.68 (2026-08-18)

### 说明

* 修复自动更新下载中断（如断网）后无法继续下载的问题：新增中断缓存清理逻辑（清理 `*.partial` 残留与陈旧 `update-info.json`），检查更新前与下载出错后自动清理；`update:clear-cache` 补充清理 `~/Library/Caches/bob-updater` 目录

***

## v0.5.67 (2026-08-18)

### 说明

* 与 v0.5.66 内容一致，版本号递增重发

***

## v0.5.66 (2026-08-18)

### 说明

* 与 v0.5.65 内容一致，版本号递增重发

***

## v0.5.65 (2026-08-18)

### 说明

* 与 v0.5.64 内容一致，版本号递增重发

***

## v0.5.64 (2026-08-17)

### 说明

* 与 v0.5.63 内容一致，版本号递增重发

***

## v0.5.63 (2026-08-17)

### 说明

* 与 v0.5.62 内容一致，版本号递增重发

***

## v0.5.62 (2026-08-17)

### 说明

* 与 v0.5.61 内容一致，版本号递增重发

***

## v0.5.61 (2026-08-17)

### 说明

* 与 v0.5.60 内容一致，版本号递增重发

***

## v0.5.60 (2026-08-17)

### 说明

* 与 v0.5.59 内容一致，版本号递增重发

***

## v0.5.59 (2026-08-17)

### 说明

* 与 v0.5.58 内容一致，版本号递增重发

***

## v0.5.58 (2026-08-17)

### 说明

* 与 v0.5.57 内容一致，版本号递增重发

***

## v0.5.57 (2026-08-17)

### 说明

* 与 v0.5.56 内容一致，版本号递增重发

***

## v0.5.56 (2026-08-17)

### 说明

* 与 v0.5.55 内容一致，版本号递增重发

***

## v0.5.55 (2026-08-17)

### 说明

* 与 v0.5.54 内容一致，版本号递增重发

***

## v0.5.54 (2026-08-17)

### 说明

* 与 v0.5.53 内容一致，版本号递增重发

***

## v0.5.53 (2026-08-17)

### 说明

* 与 v0.5.52 内容一致，版本号递增重发

***

## v0.5.52 (2026-08-17)

### 说明

* 与 v0.5.51 内容一致，版本号递增重发

***

## v0.5.51 (2026-08-17)

### 说明

* 与 v0.5.50 内容一致，版本号递增重发

***

## v0.5.50 (2026-08-17)

### 说明

* 与 v0.5.49 内容一致，版本号递增重发

***

## v0.5.49 (2026-08-17)

### 说明

* 与 v0.5.48 内容一致，版本号递增重发

***

## v0.5.48 (2026-08-17)

### 说明

* 与 v0.5.47 内容一致，版本号递增重发

***

## v0.5.47 (2026-08-16)

### 说明

* 与 v0.5.46 内容一致，版本号递增重发

***

## v0.5.46 (2026-08-16)

### 说明

* 与 v0.5.45 内容一致，版本号递增重发

***

## v0.5.45 (2026-08-16)

### 说明

* 与 v0.5.44 内容一致，版本号递增重发

***

## v0.5.44 (2026-08-16)

### 说明

* 与 v0.5.43 内容一致，版本号递增重发

***

## v0.5.43 (2026-08-16)

### 说明

* 与 v0.5.42 内容一致，版本号递增重发

***

## v0.5.42 (2026-08-16)

### 说明

* 与 v0.5.41 内容一致，版本号递增重发

***

## v0.5.41 (2026-08-16)

### 说明

* 与 v0.5.40 内容一致，版本号递增重发

***

## v0.5.40 (2026-08-16)

### 说明

* 与 v0.5.39 内容一致，版本号递增重发

***

## v0.5.39 (2026-08-16)

### 说明

* 与 v0.5.38 内容一致，版本号递增重发

***

## v0.5.38 (2026-08-16)

### 说明

* 与 v0.5.37 内容一致，版本号递增重发

***

## v0.5.37 (2026-08-16)

### 说明

* 与 v0.5.36 内容一致，版本号递增重发

***

## v0.5.36 (2026-08-16)

### 说明

* 与 v0.5.35 内容一致，版本号递增重发

***

## v0.5.35 (2026-08-16)

### 说明

* 与 v0.5.34 内容一致，版本号递增重发

***

## v0.5.34 (2026-08-16)

### 说明

* 与 v0.5.33 内容一致，版本号递增重发

***

## v0.5.33 (2026-08-16)

### 说明

* 与 v0.5.32 内容一致，版本号递增重发

***

## v0.5.32 (2026-08-16)

### 说明

* 与 v0.5.31 内容一致，版本号递增重发

***

## v0.5.31 (2026-08-16)

### 说明

* 与 v0.5.30 内容一致，版本号递增重发

***

## v0.5.30 (2026-08-15)

### 说明

* 与 v0.5.29 内容一致，版本号递增重发

***

## v0.5.29 (2026-08-15)

### 说明

* 与 v0.5.28 内容一致，版本号递增重发

***

## v0.5.28 (2026-08-15)

### 说明

* 与 v0.5.27 内容一致，版本号递增重发

***

## v0.5.27 (2026-08-15)

### 说明

* 与 v0.5.26 内容一致，版本号递增重发

***

## v0.5.26 (2026-08-15)

### 说明

* 与 v0.5.25 内容一致，版本号递增重发

***

## v0.5.25 (2026-08-15)

### 说明

* 与 v0.5.24 内容一致，版本号递增重发

***

## v0.5.24 (2026-08-15)

### 说明

* 与 v0.5.23 内容一致，版本号递增重发

***

## v0.5.23 (2026-08-15)

### 说明

* 与 v0.5.22 内容一致，版本号递增重发

***

## v0.5.22 (2026-08-15)

### 说明

* 与 v0.5.21 内容一致，版本号递增重发

***

## v0.5.21 (2026-08-15)

### 新增

* DMG 安装说明方法 1（终端命令）：新增「复制」按钮一键复制 xattr 命令，带成功/失败状态反馈（已复制/复制失败，1.6s 自动恢复）

***

## v0.5.20 (2026-08-15)

### 说明

* 与 v0.5.19 内容一致，版本号递增重发

***

## v0.5.19 (2026-08-15)

### 修复

* 应用图标缺失：改名 BobWork 后 LOGO\_SRC 指向不存在的 assets/BobWork\_logo.png，改回 assets/BobAgent\_logo.png（package-release.sh / build-electron.sh）

* 前端品牌 logo 缺失：public/bobwork-logo.png 不存在，已从 bobagent-logo.png 补齐（Sidebar / WelcomeScreen / SettingsModal 引用）

***

## v0.5.18 (2026-08-15)

### 说明

* 与 v0.5.17 内容一致，版本号递增重发

***

## v0.5.17 (2026-08-15)

### 说明

* 与 v0.5.16 内容一致，版本号递增重发

***

## v0.5.16 (2026-08-15)

### 修复

* 更新安装失败（RangeError: Maximum call stack size exceeded）：startNextServer 返回的 Proxy 其 get trap 引用全局 nextServerProc（即 Proxy 自身）导致无限递归，改为直接引用 target 原始子进程，点击 Install 不再崩溃

* 设置面板标题栏右侧新增常驻 Check for updates 手动检查入口（显示 Checking… / 新版本 / Up to date / Check failed 状态）

***

## v0.5.15 (2026-08-15)

### 说明

* 与 v0.5.14 内容一致，版本号递增重发

***

## v0.5.14 (2026-08-15)

### 说明

* 与 v0.5.13 内容一致，版本号递增重发

***

## v0.5.13 (2026-08-15)

### 说明

* 版本号重新设计，首个新版本线版本；内容与旧版 v1.3.81 一致
