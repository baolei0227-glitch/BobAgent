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

## v0.7.747 (2026-10-26)

> Windows 版发布链路打通（构建 / 自动更新 / 随包运行时），并把 Butler 的模型凭据改为客户端解密后透传 —— 修掉 Windows 上服务端子进程解不开设置密钥时「模型未配置」的问题。

### 新增

* **Windows 构建与自动更新**：新增 [electron-builder.win.yml](file:///Users/baolei/Desktop/BobWork/projects/electron-builder.win.yml) 与 [after-pack-win-slim.cjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/after-pack-win-slim.cjs)，打通下载 / 安装 / 重启闭环；随包 ffmpeg、Python 与本地语音引擎；发布走 GitCode Release（CI 在 Linux job 发布，绕开 Windows runner 的 429/404）。

### 修复与优化

* **Butler 模型凭据透传**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) · [threads/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/threads/route.ts) · [entry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/entry.ts)）：渲染进程经 Electron IPC 拿到**已解密**的 `apiKey / baseUrl / providerModelId`，随本轮请求透传；服务端不再依赖"主进程与服务端子进程派生同一把机器密钥"。浏览器模式（只见掩码）仍回退服务端解析。
* **清理**：移除 95 个 Finder 复制产生的「 2」重复文件（逐一校验与原名内容一致），避免重复编译与误纳入构建。

***

## v0.7.746 (2026-10-22)

> 跨平台基础层落地：把散落在 20+ 文件的 `process.platform` 判断与 POSIX 路径假设收敛到 `lib/platform`，为 Windows 支持铺路；macOS 行为保持不变。

### 修复与优化

* **新增平台层**（[runtime.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/runtime.ts) · [binaries.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/binaries.ts) · [index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/index.ts)）：统一平台标识、PATH 分隔符与大小写语义、可执行文件候选探测（`.exe`）与共享库环境变量，缺能力时显式抛错而不是静默降级。
* **本地语音引擎接入**：sherpa 转写、标点服务、流式服务、说话人嵌入与声纹分离（[src/lib/stt](file:///Users/baolei/Desktop/BobWork/projects/src/lib/stt) · [sherpa-local.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/tts/sherpa-local.ts)）统一按平台解析二进制与库路径；不支持的平台给出明确错误，不再出现"功能悄悄消失"。
* **Electron 主进程**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts)）：ffmpeg 路径统一走 `exeName`，随包 Python 路径按平台解析。
* **清理**：移除 `punct-server.ts` 未使用的导入，ESLint 零错误。

***

## v0.7.745 (2026-10-22)

> Hippo 浏览器「胶囊态」交互补完：收起后的小胶囊现在可以拖到顺手的位置，并记住落点。

### 修复与优化

* **胶囊可拖拽、记忆位置**（[HippoCapsule.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/hippo-browser/HippoCapsule.tsx) · [globals.css](file:///Users/baolei/Desktop/BobWork/projects/src/app/globals.css)）：按住胶囊可拖动（相对默认顶部居中的偏移），松手落盘到 `localStorage`，下次收起回到同一处；位移超过阈值判定为拖拽并吞掉随后的 click，不会误触恢复窗口。拖到视口边缘保留 8px 内缩，避免贴边抓不住。
* **主进程配合**（[hippo-browser.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-browser.ts)）：切页自动收起的幂等处理仅在窗口可见、未收起且无焦点时生效，避免打断正在浏览器里输入的用户。
* **视觉**：胶囊拖拽态去掉过渡与 hover 放大、切换抓取光标，呼吸灯与阴影细节同步。

***

## v0.7.744 (2026-10-22)

> Audio 转写继续补完「可编辑时间轴」与「人与 AI 协作改稿」：插入断句的时间改为自由调整并按时间自动归位；润色视图也能调轮起点；每行新增行级 AI 润色，修改先以修订对照呈现，确认后才落盘。

### 新增

* **行级 AI 润色**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx) · [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：每行常驻半透明的 `✦`，只把**这一行此刻的文字**（含未落盘草稿）交给模型润色，不动时间轴与其他行。结果先以 Word 式修订对照展示（删除线 + 高亮），`Accept` 才落盘，`Discard` / `Esc` 原样退回。
* **润色视图调时间**：轮首时间戳右侧新增时钟按钮，保存成功后直接把播放头 seek 到新时间（只定位，不改播放状态）。
* **插入行默认时间取播放头**：新断句的时间默认取当前播放头（夹在本行起点与下一行起点之间），落盘后上一行的 `end` 自动收到新行起点。

### 修复与优化

* **插入断句时间自由调整**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts)）：可落在音频内任意位置，改完按时间**自动归位**（段序、正文与润色轮一起重排），不截短任何邻段；`activeSegmentIndex` 的二分始终依赖有序段列。
* **测试**（[transcript.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.test.ts)）：新增插入行归位/重排、润色轮时间对齐等用例，单测共 124 条全绿。

***

## v0.7.743 (2026-10-21)

> v0.7.742 的断句修复只对**新插入**的行生效：旧 sidecar 里没有 `inserted` 字段的老断句，升级后仍会被并进邻轮，表现为"改说话人还是连带整轮"。本版补上老数据兼容。

### 修复与优化

* **老断句自动识别**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts)）：新增 `isInsertedSegment`，按"与上一段时间区间完全一致"推断手工插入行（ASR 段首尾相接、严格递增，相邻同区间只可能是插入行）。读盘时直接固化成 `inserted` 标记，之后写回即持久。
* **老润色稿同步识别**：插入轮紧随锚点轮且区间一致，按"时间 + 文字全等"与"同区间的后一轮"两条判据补标记；对不上不猜。
* **前端分轮防御**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：轮分组与润色视图映射统一走 `isInsertedSegment`，不再只看字段。
* **测试**（[transcript.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.test.ts)）：新增老 sidecar 兼容用例（读盘固化、无标记断轮、只改插入行、润色文字被改写时仍能识别），单测共 113 条全绿。

***

## v0.7.742 (2026-10-21)

> 本轮聚焦 **Audio 转写的可编辑时间轴**：支持双击改句子起点时间，并修掉手工断句（插入行）在「改说话人 / 改时间」时牵连邻轮的两个持久化缺陷。共 **5 个文件改动**（含 1 个测试文件）。

### 修复与优化

* **转写时间戳可编辑**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx) · [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) · [audio/clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：双击时间戳即可改句子起点（支持 `mm:ss` 或纯秒数，Enter 保存 / Esc 取消），乐观上屏、串行落盘、失败精确回滚。改完后点击时间戳直接跳到新时刻；播放高亮与润色视图边界同步更新。
* **修复手工断句改说话人连带整轮**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts)）：插入行新增持久标记 `inserted`，自成一轮且不并入邻段；润色视图改按「时间 + 文字」精确配对，只改它自己。标记随 sidecar 往返，重启后不再复发。
* **修复改时间时的时间轴缩水**：改插入行起点不再截短上一段的 `end`；普通段改起点只同步最近一段普通行，并跳过同 `start` 的插入轮，避免误伤。
* **测试**（[transcript.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.test.ts)）：新增断句隔离、时间跳转一致性、sidecar 往返等用例，单测共 109 条全绿。

***

## v0.7.741 (2026-10-21)

> 承接 v0.7.740 之后继续完成的改动，仍在 **Audio 转写**链路上迭代：转写处理、片段接口、播放器与转写面板。共 **5 个文件改动**（含 1 个测试文件）。

### 修复与优化

* **转写文本处理**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts) · [transcript.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.test.ts)）：转写文本处理的又一轮修正，测试同步更新。
* **音频片段接口**（[audio/clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：片段生成接口的后续调整。
* **Audio 播放器**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：播放与转写联动的后续修正。
* **转写面板**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：转写内容展示与操作的后续修正。

***

## v0.7.740 (2026-10-21)

> 承接 v0.7.739 之后继续完成的改动，仍在 **Audio 转写**链路上迭代：转写处理、片段接口、播放器与转写面板。共 **5 个文件改动**（含 1 个测试文件）。

### 修复与优化

* **转写文本处理**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts) · [transcript.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.test.ts)）：转写文本处理的又一轮修正，测试同步更新。
* **音频片段接口**（[audio/clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：片段生成接口的后续调整。
* **Audio 播放器**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：播放与转写联动的后续修正。
* **转写面板**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：转写内容展示与操作的后续修正。

***

## v0.7.739 (2026-10-21)

> 承接 v0.7.738 之后完成的改动，集中在 **Audio 转写**链路：转写文本处理、音频片段接口、播放器与转写面板的联动。共 **5 个文件改动**（含 1 个测试文件）。

### 修复与优化

* **转写文本处理**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts) · [transcript.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.test.ts)）：转写文本的清洗与分段逻辑修正，并补充对应测试。
* **音频片段接口**（[audio/clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：片段生成接口的配套调整。
* **Audio 播放器**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：播放与转写联动的后续修正。
* **转写面板**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：转写内容展示与操作的后续修正。

***

## v0.7.738 (2026-10-21)

> 承接 v0.7.737 之后继续完成的改动：**Hippo 搜索**接口与页面的又一轮修正。共 **2 个源文件改动**。

### 修复与优化

* **Hippo 搜索**（[hippo-search/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/hippo-search/route.ts) · [hippo-search/page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/hippo-search/page.tsx)）：搜索接口与页面的后续修正。

***

## v0.7.737 (2026-10-20)

> 承接 v0.7.736 之后继续完成的改动，仍集中在 **Hippo 搜索**与 **Outbox 面板**：搜索接口与页面、主进程浏览器模块的后续调整，并新增 Butler 侧的 Outbox 面板组件。共 **4 个源文件改动**。

### 新增功能

* **Butler Outbox 面板**（[ButlerOutboxPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerOutboxPanel.tsx)）：管家侧「产物暂存区」的展示与归口操作面板。

### 修复与优化

* **Hippo 搜索**（[hippo-search/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/hippo-search/route.ts) · [hippo-search/page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/hippo-search/page.tsx)）：搜索接口与页面的后续修正。
* **Hippo 浏览器模块**（[hippo-browser.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-browser.ts)）：主进程浏览器模块的配套调整。

***

## v0.7.736 (2026-10-20)

> 承接 v0.7.735 之后继续完成的改动，集中在 **Hippo 搜索页**、**Butler 面板**与 **Outbox 产物映射**三块：新增/调整 Hippo 搜索路由与页面、Butler 面板页，preload 桥接同步扩面；Outbox 存储与 `/api/outbox` 路由、管家产物文件清单与 `files/sources` 一并调整，并补充对应测试。共 **14 个源文件改动**（含 2 个测试文件）。

### 新增功能

* **Hippo 搜索页**（[hippo-search/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/hippo-search/route.ts) · [hippo-search/page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/hippo-search/page.tsx)）：搜索接口与页面的后续建设。

### 修复与优化

* **Butler 面板与抽屉**（[butler-panel/page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/butler-panel/page.tsx) · [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：面板页与抽屉的配套调整。
* **Outbox 产物映射**（[outbox/store.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/outbox/store.ts) · [outbox/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/outbox/route.ts) · [butler/output-files.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/output-files.ts) · [files/sources.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/files/sources.ts)）：批次存储、接口路由、管家产物文件清单与文件来源解析的一致性修正；新增 [output-files.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/output-files.test.ts) / [store.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/outbox/store.test.ts)。
* **Hippo 浏览器与 preload 桥接**（[hippo-browser.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-browser.ts) · [preload.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/preload.ts)）：主进程浏览器模块与渲染层桥接面的同步调整。
* **会话路由与工具装配**（[chat/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts) · [tools/index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/index.ts)）：对话路由与工具集合的配套调整。

***

## v0.7.735 (2026-10-20)

> 承接 v0.7.734（Dock 多余 `exec` 图标热修）之后继续完成的改动。本版为 **Butler 抽屉与 AI 编码沙箱桥接**的收口：抽屉交互细节、sandbox 侧「对话桥 / 主桥 / 编码文档注入」三处的后续调整，以及管家 `admin` 工具与「更新重启」确认弹窗的文案精简。共 **6 个源文件改动**（`electron/main.ts`、`ButlerDrawer.tsx`、`sandbox/bridge.ts`、`sandbox/chat-bridge.ts`、`sandbox/coding-docs.ts`、`chat/tools/admin.ts`）。

### 修复与优化

* **更新重启弹窗精简**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts#L2427-L2440)）：文案压缩为一句 `BobWork will reopen automatically. Your data is safe.`，按钮保持 `Restart Now` / `Later`，减少更新完成时的信息量。
* **Butler 抽屉交互调整**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：抽屉侧的后续交互细节修正。
* **AI 编码沙箱桥接调整**（[bridge.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/bridge.ts) · [chat-bridge.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/chat-bridge.ts) · [coding-docs.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/coding-docs.ts)）：沙箱主桥、对话桥与编码文档注入三处的后续修正。
* **管家 admin 工具调整**（[admin.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/admin.ts)）：管家管理类工具的后续调整。

***

## v0.7.734 (2026-10-20)

> 热修：**消除 macOS Dock 里多出的无图标 `exec` 图标** —— Next.js 服务子进程原先用 App 包内的裸可执行文件（`Contents/MacOS/BobWork`）以 `ELECTRON_RUN_AS_NODE=1` 启动，从 GUI 主进程拉起时会被 macOS 登记成**第二个前台应用实例**；裸 Mach-O 没有应用图标，Dock 里于是多出一颗通用可执行图标（悬停名字即 `BobWork`），每次启动必现。现改由包内 Frameworks 下带 `LSUIElement=true` 的 helper 启动（与 Chromium 自家 GPU / Renderer / Plugin helper 同款，天生不进 Dock）；运行时仍是同一份 Electron，Node 版本 / ABI 与 `process.resourcesPath` 均与原先完全一致。

### 修复与优化

* **Dock 不再出现多余 `exec` 图标**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts#L193-L224) · [main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts#L296-L298)）：新增 `resolveNodeRuntimeExecPath()` —— macOS 打包版在 `Contents/Frameworks/*Helper.app` 中解析可用 helper 二进制（排除 GPU / Renderer / Plugin 专用壳），找不到则**回退 `process.execPath`**（服务照常启动，绝不因此起不来）；Windows / Linux 行为完全不变。


***

## v0.7.733 (2026-10-20)

> 本版两条主线：**管家产物「Outbox 暂存区」** —— 管家派发会话的交付物不再默认污染「当前项目」，先落 `<appRoot>/outbox/<批次>/`（每批自包含一份 `manifest.json`，删目录即整批消失），再由新的 **Outbox 面板**（或管家 `outbox_assign`）指定归口项目后搬入（搬入**先写目标、校验后再删源**）；以及**插件启动层与平台边界的一致性收口** —— MCP 子进程的启动环境抽成共用件 [child-env.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/child-env.ts)（`buildChildPath` / `nodeRuntimeSpawn`，与主进程同口径），新增**平台边界探针** [check-platform-bounds.mjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/check-platform-bounds.mjs)（棘轮制，把平台嗅探焊死在 `lib/platform/**` 一层），机器指纹取值收进平台层 [platform/identity.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/identity.ts)。另含管家「防重复建项目」事故修复、Butler 抽屉交互调整、随包插件面板声明对齐出厂预置与中间产物定期清扫。共 **40 个文件改动**（新增 11，含 3 个测试文件）。

### 新增功能

* **Outbox 产物暂存区**（[store.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/outbox/store.ts) · [outbox/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/outbox/route.ts) · [OutboxPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/OutboxPanel.tsx) · [app-root.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/app-root.ts)）：管家 `create_session` 派发的会话默认 `output_mode='outbox'` —— 交付物写 `<appRoot>/outbox/<批次>/homework/`、中间产物写 `<批次>/.ai-workspace/`，**对项目目录零写入**。批次自包含（`manifest.json` + 文件清单 + 状态 `pending` / `assigned` / `kept` / `discarded`），单批写入失败不影响其他批，**删除目录即整批消失、不留孤儿索引**。
* **改道对模型透明**（[chat/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts) · [tools/index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/index.ts)）：会话带 `outbox_batch_id` 后，`write_file` / `edit_code` 对 `homework/` 的写入会被**自动改道**到批次目录，脚本直写项目的产物也由系统搬正；这些产物不进「当前项目输出卡片」，只在 Outbox 面板呈现。
* **平台边界探针（棘轮）**（[check-platform-bounds.mjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/check-platform-bounds.mjs)）：`src/` 下**除 `lib/platform/**` 外**禁止出现 `process.platform` / `process.arch` / `os.platform()`；历史 3 处嗅探（secrets / sherpa / bridge）当天全部迁进平台层，故表已清空、此后一律零容忍。已接入 `pnpm validate` 与 CI。

### 修复与优化

* **MCP 子进程启动环境统一**（[child-env.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/child-env.ts#L24-L57)）：`buildChildPath()` 合并 Homebrew / nvm / volta / npm global 与当前 PATH；`nodeRuntimeSpawn()` 一律用 `process.execPath + ELECTRON_RUN_AS_NODE=1`，**不再 spawn 系统 PATH 里的 node** —— 用户机器可能没装 node、或装的是 x64 / 版本不符（历史事故：随包原生模块 ABI 不匹配 → SIGSEGV）。OCR 常驻桥（[ocr-bridge.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/ocr-bridge.ts)）与 [manager.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/manager.ts) 一并改走该层。
* **机器指纹取值收进平台层**（[platform/identity.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/identity.ts)）：macOS `IOPlatformUUID` / Windows 注册表 `MachineGuid` / Linux `/etc/machine-id`，**不退回主机名**（DHCP 把主机名改成 IP、或用户改名，都会让已落盘密文全部解不开）；拼接格式仍留在 [secrets.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/secrets.ts)（数据契约，动了老密文就解不开）。
* **管家「防重复建项目」**（[butler.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler.ts#L2486-L2490)）：管家在「往已存在项目写待办 / 便签」时误调 `create_project`，会凭空多出一个同名（仅日期后缀不同）的重复项目 —— 现在**已有同名项目必须拒绝并指回它**。
* **Butler 抽屉交互**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx#L4354-L4356)）：点击抽屉外任意处**不再**收起（收起只保留用户手动「缩小至悬浮球」），避免误触丢失上下文。
* **随包插件面板声明对齐出厂预置**（[settings-server.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/settings-server.ts#L221-L223)）：出厂升级迁移 —— 系统随包插件的面板声明与出厂预置对齐。
* **中间产物定期清扫**（[intermediate-cleanup.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/cleanup/intermediate-cleanup.ts)）：`homework/.ai-workspace/` 超过保留期（7 天）的中间文件定期清理（每 6 小时 + 启动兜底一次），且**绝不触碰 `homework/` 其他目录**（交付物所在）。

### 验证

* 全仓 `pnpm test` **153 文件 / 1838 例全绿**（较 v0.7.732 的 151 / 1821 增加 2 文件 / 17 例）；`tsc -p tsconfig.json` 通过；`pnpm check:platform-bounds` 无越界。
* 打包流程 5b-assert 必须打印 `✅ main.js 外部依赖齐全: adm-zip, electron-updater`；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致。
* 内置插件完整性：构建日志须逐个出现「已内置」标记（bob-team / bob-preview / bob-notes / bob-mind / coze / bobby / bob-video-shot / bob-ocr 共 8 个），缺任一即为构建失败告警。


## v0.7.732 (2026-10-19)

> 紧急修复 **v0.7.731 的启动崩溃**：打包版双击后主进程直接弹 `A JavaScript error occurred in the main process — Cannot find module 'adm-zip'`，应用起不来。根因是 [electron/main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts#L19) 在上一批新增了**静态** `import AdmZip from 'adm-zip'`（tsup 会把它原样外置成 `require('adm-zip')`，在**主进程 load 期**就求值），而 [package-release.sh](file:///Users/baolei/Desktop/BobWork/projects/scripts/package-release.sh#L204-L226) 为 `Resources/app` 装依赖用的是一份**手抄清单**、只写了 `electron-updater` —— 于是随包 `app/node_modules` 里没有 `adm-zip`，启动即崩（Windows 侧早已吃过同一个亏，故其流水线里本就有一道 `adm-zip` / `electron-updater` 存在性断言，mac 侧此前只靠手抄清单）。共 **2 个文件改动**（0 新增文件，0 测试改动）。

### 修复与优化

* **补上主进程缺失的运行时依赖**（[package-release.sh](file:///Users/baolei/Desktop/BobWork/projects/scripts/package-release.sh#L204-L226)）：`app/` 的最小依赖清单加入 `adm-zip`（版本取自根 [package.json](file:///Users/baolei/Desktop/BobWork/projects/package.json) 的 `dependencies`，与 `electron-updater` 同一写法）。
* **新增一道断言，杜绝同类回归**（[package-release.sh](file:///Users/baolei/Desktop/BobWork/projects/scripts/package-release.sh#L228-L251) 新增 5b-assert）：装完依赖后**扫描 `app/main.js` 里实际 `require` 的外部模块**（剔除相对路径、`node:` 内建与 `electron`），逐个断言能在 `app/node_modules` 解析到 `package.json`；缺任何一个即**构建失败**（脚本为 `set -Eeuo pipefail`）。手抄清单从此不再是唯一防线 —— 与 [windows-build.yml](file:///Users/baolei/Desktop/BobWork/projects/.github/workflows/windows-build.yml) 的同名断言同源。

### 验证

* 全仓 `pnpm test` **151 文件 / 1821 例全绿**；`tsc -p tsconfig.json` 通过（`TSC_EXIT=0`）。
* 打包流程新增的 5b-assert 必须打印 `✅ main.js 外部依赖齐全: adm-zip, electron-updater`（否则构建中断，不放行上传）；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致。
* 回归验证点：解包后 `BobWork.app/Contents/Resources/app/node_modules/adm-zip` 必须存在，且 `.../app/main.js` 中 `require("adm-zip")` 可解析。


## v0.7.731 (2026-10-19)

> 本版主线是**跨平台（Windows）底座**：新增**平台适配层 `lib/platform`** —— 把长期散落在 **21 个文件**里的 `process.platform` 分支与 POSIX 硬编码（`/usr/bin/python3`、`/usr/sbin/lsof`、`PATH.split(':')`、`SIGKILL`…）收拢到**唯一一层**；补齐 **Windows 命令安全边界**（`del` / `rd` / `Remove-Item` / `format` / `diskpart` / `bcdedit` / `shutdown` 等原先整片处在放行侧）；新增 **Python 失败诊断层**（把 `ModuleNotFoundError` / `'python' is not recognized` / GBK 编码错翻译成可照做的处置）；并落地 **Windows 打包流水线**（跨平台编译 / 包管理器守卫 / standalone 组装与自检 / NSIS x64 出包）。另有一组**插件面板稳定性**改造：**端口生命周期整改**（表项唯一删除入口 + 条件复用 + 可达性探针）与**宿主 origin 稳定反代**（`/api/plugin-web/` 前缀，让 Hippo 书签不再随端口变化失效）。共 **59 个文件改动**（src 45 / scripts 10 / assets 3 / electron 1，含 9 个测试文件）。

### 新增功能

* **平台适配层（唯一允许出现平台差异的地方）**（[runtime.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/runtime.ts) · [binaries.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/binaries.ts) · [process.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/process.ts) · [index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/platform/index.ts)）：`PLATFORM` / `IS_WIN` / `pathKey` / `fsPathKey` / `splitPathList` / `exeName` / `windowsBinDirs` 等平台语义；外部可执行文件（`curl` / `tar` / `python3` / `ffmpeg`）的**解析与能力探测**（`requireCapability` 让「缺能力」显式抛错而非静默降级，结果按进程缓存）；进程查询 / 终止的跨平台语义（`lsof` → `netstat` / CIM、`ps` → CIM、`process.kill(SIGKILL)` → `taskkill /T`、父 pid **三态**判定使「查不到」不再掩盖「通道坏了」）。约定：业务代码不得直接写 `process.platform`。
* **Windows 命令安全边界**（[command-guard.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/shell/command-guard.ts)）：从 5500 行的 [tools/index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/index.ts) 抽出为**可被单测直接打靶**的独立模块 —— POSIX 规则**一字不改**保留（保证 mac 行为零变更，同时挡住 Windows git-bash 里的 `rm -rf /`），Windows 侧改用「**破坏性动词 × 灾难目标**」两段式判定，把 `del /f /s /q C:\*`、`rd /s /q`、`Remove-Item -Recurse -Force`、`format`、`diskpart`、`bcdedit`、`shutdown /s`、`wevtutil cl` 全部从放行侧收回；个人目录守卫补上 `C:\Users\…`。
* **Python 失败诊断层**（[diagnostics.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/python/diagnostics.ts)）：把三类「用户看到的原文与真因完全是两件事」的报错翻译成可照做的处置 —— `ModuleNotFoundError: No module named 'docx'`（BobWork 的 Python 依赖没装 / 装到了另一个解释器）、`'python' is not recognized…`（这台机器没有 Python）、`UnicodeEncodeError: 'gbk' codec…`（Windows 控制台代码页 936）。
* **插件面板端口生命周期 + 宿主 origin 稳定反代**（[panel-ports.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/panel-ports.ts) · [plugin-web.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/plugin-web.ts) · [plugin-web-proxy.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/http/plugin-web-proxy.ts)）：表项增加**唯一删除入口** `releasePanelPort`（卸载 / 禁用时由 manager teardown 调用）、**条件复用**（端口当前无人监听才复用 —— 正常崩溃重启端口不变、面板 iframe 不换地址；仍被占则换新端口，不让子进程被交给一个 `EADDRINUSE` 的端口）、`isPortAcceptingConnections` 可达性探针（TTL 缓存）；新增 `/api/plugin-web/` 前缀**逐字透传**反代，挂在 [server.ts](file:///Users/baolei/Desktop/BobWork/projects/src/server.ts) 的原生 HTTP 层（负载是 GB 级大 body 双向流，故不用 route handler），Hippo 原生书签只记「宿主 origin + 固定前缀」即可长期有效。
* **小程序 Bridge 文档按需读取**（[coding-docs.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/coding-docs.ts)）：原先整段注入的 Bridge API 文档拆成 `read_bridge_docs` 工具，核心 prompt 只留一页索引 + 接入策略，模型真正需要存储 / 宿主资源 / 画布 / AI / hostTool 时再读对应分区。

### 修复与优化

* **平台化迁移**（[office.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/office.ts) · [ocr.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/ocr.ts) · [tools/index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/index.ts) · [admin.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/admin.ts) · [local-files/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/local-files/route.ts) · [docx/revise/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/docx/revise/route.ts) · [skills/templates/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/skills/templates/route.ts) · [skills/templates/fill/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/skills/templates/fill/route.ts) · [download.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/net/download.ts) · [secrets.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/secrets.ts) · [app-root.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/app-root.ts) · [plugin-panels-server.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/plugin-panels-server.ts) · [main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts)）：把硬编码 `/usr/bin/python3`（8 处）、`/usr/bin/curl`、`/usr/bin/tar`、`/usr/sbin/lsof`、拿不到 `.exe` 的 `ffmpeg`、`PATH.split(':')` 等 POSIX 假设改走平台层；`local-files` 路由改用 `fsPathKey` 与新的 `range` / `mime` 工具；`secrets.ts` 的机器指纹采集不再依赖 `sysctl`。
* **Butler 写类工具的「项目归属」收口**（[resolve-explicit-project.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/resolve-explicit-project.ts)）：`create_scheduled_todo` / `create_sticky_note` / `project_plan_*` 改为「**显式优先 + 兜底可见**」—— 用户点名项目就按名解析，没点名则落当前激活项目但**必须在回执里回显 `project_source`**，模型与用户都能立刻看出写偏，不再静默猜测导致「建→撤→建」；便签作用域与待办归属迁移同步打磨（[sticky-scope.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/sticky-scope.ts) · [todo-move.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/todo-move.ts) · [ProjectBoardView.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ProjectBoardView.tsx)）。
* **工程化：Windows 打包流水线**（[compile-desktop.mjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/compile-desktop.mjs) · [check-pm.mjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/check-pm.mjs) · [stage-standalone.mjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/stage-standalone.mjs) · [assemble-win-resources.mjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/assemble-win-resources.mjs) · [fix-win-node-modules.mjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/fix-win-node-modules.mjs) · [verify-standalone-native.mjs](file:///Users/baolei/Desktop/BobWork/projects/scripts/verify-standalone-native.mjs) · [pack-win.sh](file:///Users/baolei/Desktop/BobWork/projects/scripts/pack-win.sh) · [platform-doctor.ts](file:///Users/baolei/Desktop/BobWork/projects/scripts/platform-doctor.ts) · [platform-selftest.ts](file:///Users/baolei/Desktop/BobWork/projects/scripts/platform-selftest.ts) · [build-electron.sh](file:///Users/baolei/Desktop/BobWork/projects/scripts/build-electron.sh)）：编译改走跨平台脚本（去 bash / 去 npx，直接 `node node_modules/tsup/dist/cli-default.js`，避免联网取到非本仓库版本导致构建静默漂移）；`preinstall` 不再 `npx only-allow pnpm`（改为本地 `check-pm.mjs`）；standalone 组装统一换成**自定义 `server.js` 入口**（补回远程登录 Token 网关与 CalDAV，工单 W-4）并兼容 **Next 16 standalone 落在子目录**的情形；Windows 侧补齐 nft 追踪漏掉的包、把 `.pnpm` 扁平化以规避 260 字符路径上限；**实测推翻**「随包原生模块必须重建」的假设（`better-sqlite3` 走 N-API，ABI 稳定）；新增 `pnpm doctor:platform` 能力自检与真机断言脚本。
* **模块拆分**：`tools/index.ts` 里的 admin / ocr / office / butler 场景工具抽成独立文件（依赖方向单向，仅以 `import type` 依赖 index.ts，不产生运行时循环依赖）。
* **技能文档**（[legal-drafter/SKILL.md](file:///Users/baolei/Desktop/BobWork/projects/assets/skills/legal-drafter/SKILL.md) · [document-templates.md](file:///Users/baolei/Desktop/BobWork/projects/assets/skills/legal-drafter/references/document-templates.md) · [export-format-rules.md](file:///Users/baolei/Desktop/BobWork/projects/assets/skills/legal-drafter/references/export-format-rules.md)）：文书模板库 / 导出格式规范 / SKILL 正文更新（含「修改已有文书时改用 `read_file` + `edit_code` 精确替换」的例外规则）。

### 新增单测

* 本批改动触及 **9 个测试文件**：`command-guard` / `platform` / `process` / `diagnostics` / `panel-ports` / `plugin-web-proxy` 的模块级测试，以及 `resolve-explicit-project` / `sticky-scope` / `butler-project` 既有测试的更新；全仓测试规模由上一版 v0.7.730 的 **146 文件 / 1705 例** 增至 **151 文件 / 1821 例**（**+5 文件 / +116 例**）。平台层的单元测试全部由**手写 Windows 输出样例**驱动（可在 mac 上真实驱动 Windows 分支），另配 `platform-selftest.ts` 用真实进程取证。

### 验证

* 全仓 `pnpm test` **151 文件 / 1821 例全绿**（较上一版 v0.7.730 的 146 文件 / 1705 例 **+5 文件 / +116 例**）；`tsc -p tsconfig.json` 通过（`TSC_EXIT=0`）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。
* **对 macOS 用户的可见面**：插件面板端口复用 / 稳定反代（Hippo 书签不再失效）、Python 报错文案可照做、Butler 写类工具回显 `project_source`、便签作用域与待办迁移打磨、小程序 Bridge 文档按需读取；**平台层 / 命令守卫 / Windows 打包流水线对 mac 行为无影响**（POSIX 命令规则刻意「一字不改」冻结，`lib/platform` 在 mac 上退化为恒等映射）。


## v0.7.730 (2026-10-19)

> 本版在管家（Butler）左栏的**悬浮球下方新增一个「Chats」会话键**：无论当前在 Today / Memories / Calendar 哪个分区，点一下即可**收起右栏、露出联系人列并聚焦输入框**，一键回到「好友列表 + 对话」这个默认视图；该键在**正常聊天态点亮**，一旦打开某个分区即熄灭。共 **1 个文件改动**（0 新增文件，0 测试改动）。

### 新增功能

* **左栏「Chats」会话键**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx#L4440-L4454)）：位于助理标（悬浮球河马线稿）正下方、`Buddy` 键上方，图标 `MessagesSquare`（两只并排气泡 = 一场会话），与 `Buddy` 的 `UsersRound`（两人并排 = 一段关系）同属一套视觉语言。
  * 点击行为 = **`closeRight()` 收起右栏** + **`setContactsOpen(true)` 露出联系人列**（窄窗下联系人列是覆盖层）+ **`inputRef.current?.focus()` 聚焦输入框**，等于从任何右栏分区一键回到聊天。
  * 点亮条件 `active={!rightVisible}`：**右栏未开**（正常聊天态）时点亮；一旦点开 Today / Memories / Calendar 等分区即熄灭。

### 验证

* 全仓 `pnpm test` **146 文件 / 1705 例全绿**；`tsc -p tsconfig.json` 通过（`TSC_EXIT=0`）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。
* 本批新增 UI 文案仅 `Chats` 一处（v0.7.729 编译产物中该字面量命中 0 文件，v0.7.730 命中 2 文件），其余同批源内改动（头部注释精简等）为**注释级**、未进入产物，故不计为可见变更。


## v0.7.729 (2026-10-19)

> 本版是**管家（Butler）「计划树 + 待办归口」的一轮闭环**：计划可收尾 / 重开 / 删除 / 重命名 / 改分类标签备注 / 归档恢复，步骤支持 due / owner / artifact / note；新增**跨项目计划总览**、**只读计划树接口**与项目侧栏计划视图；Today 建议并入「计划逾期 / 停滞」信号；计划步骤可**单向镜像为系统「Plan Todos」便签**；并落地**待办归口方案 A（Todo Inbox）**——按「有无项目 × 有无时间」四类收口，全局日历事件用 `__global__`，另提供待办在项目与 Inbox 之间的迁移工具。共 **34 个文件改动**（含 9 个新增单测文件）。

### 新增功能

* **计划树闭环与项目治理**（[butler.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler.ts) · [plans.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/plans.ts)）：管家工具可**收尾（`done`）/ 重开（`abandoned`→重开）计划、删除计划、重命名、改分类 / 标签 / 备注、归档 / 恢复**；计划步骤支持 `due` / `owner` / `artifact` / `note`；并支持**按名找到已归档项目**。
* **跨项目计划总览**（[registry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/registry.ts) · [butler.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler.ts)）：一处看清各项目**计划进度、逾期步骤、停滞天数**，支持「按项目 / 含终态 / 仅需关注 / 停滞阈值」过滤。
* **计划树共享数据层 + 只读接口**（[plans.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/plans.ts) · [route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/projects/plans/route.ts)）：计划类型 / 读写 / 派生统计收拢到 `plans.ts`（`summarizePlan`、`PLAN_STALLED_DAYS = 14`），新增只读 `GET /api/projects/plans`。
* **项目详情侧栏「Plans」只读计划树**（[ProjectBoardView.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ProjectBoardView.tsx)）：**手风琴折叠**，里程碑 → 步骤，含状态点、完成划线、`due` 逾期标红；无数据时静默显示 `No active plans`。
* **Today 建议新增「计划」信号**（[advice.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/advice.ts) · [today-advice.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/today-advice.ts) · [ButlerTodayPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerTodayPanel.tsx)）：计划的**逾期 / 停滞**并入今日建议卡，面板展示并支持刷新 AI reason。
* **计划步骤 → 系统「Plan Todos」便签单向同步**（[plan-todo-sync.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/plan-todo-sync.ts) · [sticky-calendar-sync.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sticky-calendar-sync.ts)）：带 `due` 的未完成步骤自动**镜像成蓝色系统便签**（`PLAN_TODOS_NOTE_TITLE`），行级幂等；勾选便签**不回写**计划、不自动入日历、豁免便签数量上限。

### 修复与优化

* **待办归口方案 A（Todo Inbox）**（[sticky-scope.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/sticky-scope.ts) · [sticky-notes/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sticky-notes/route.ts) · [sticky-todo.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sticky-todo.ts) · [inspect.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/inspect.ts) · [daily-tasks.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/daily-tasks.ts)）：按「**有无项目 × 有无时间**」四类落点收口；无激活项目时临时待办落入 app root 的 **Todo Inbox**（`INBOX_PROJECT_ID='__inbox__'`、`TODO_INBOX_NAME='Todo Inbox'`），**不再报 `NO_PROJECT`**；全局日历事件统一用 `GLOBAL_SCOPE_PROJECT_ID='__global__'`。
* **待办归属迁移**（[todo-move.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/todo-move.ts) · [rule-exec.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/rule-exec.ts)）：`todo_update.move_to_project` 可把待办（**事件 + 便签行**）在项目与 Inbox 之间迁移，保留文本 / 勾选状态 / 事件锚点。
* **支撑性改动**（[StickyTodoDock.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/StickyTodoDock.tsx) · [CanvasStickyNotes.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasStickyNotes.tsx) · [db/index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/db/index.ts) · [profiles.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/agents/profiles.ts) · [console.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/console.ts) · [VideoViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/VideoViewer.tsx)）为上述功能的配套编辑（events 增加 scope 列等）。

### 新增单测

* [butler-plan.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler-plan.test.ts) · [butler-project.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler-project.test.ts) · [route.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/projects/plans/route.test.ts) · [plan-todo-sync.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/plan-todo-sync.test.ts) · [sticky-scope.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/sticky-scope.test.ts) · [sticky-calendar-sync.inbox.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sticky-calendar-sync.inbox.test.ts) · [todo-move.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/todo-move.test.ts) · [advice.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/advice.test.ts) · [registry.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/registry.test.ts)

### 验证

* 全仓 `pnpm test` **146 文件 / 1705 例全绿**（较上一版 v0.7.728 的 140 文件 / 1644 例 **+6 文件 / +61 例**）；`tsc -p tsconfig.json` 通过（`TSC_EXIT=0`）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。


## v0.7.728 (2026-10-18)

> 本版修复「对话稿」面板的两处滚动跟随问题：**列表滑到底不再被拽回当前播放行（消除下滑自动回弹）**，且**润色稿视图的自动跟随恢复可用**，并支持**点击任意一行重新接上跟随**。共 **1 个文件改动**（0 新增文件，0 测试改动）。

### 修复与优化

* **对话稿滚动跟随修复**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：
  * 移除 `onListScroll` 中「滚到列表底部就重新接上自动跟随」的错误规则 —— 该规则会在播放时把用户刚翻到底的列表又拽回当前播放行，表现为「下滑后自动回弹到最上面」。
  * 改用「列表到跟播目标的距离是否变大」区分**用户滚动**与**程序滚动**（程序滚动由跟随目标自身引起，距离不会变大），据此决定暂停 / 恢复跟随。
  * 为**润色稿行**补齐 DOM `ref`（原先仅原文行挂了 ref），使润色稿视图的自动跟随能取到目标行、恢复生效。
  * 支持**点击任意一行**重新接上自动跟随。
  * 以打包版真机复现根因，并用 Playwright 验证：下滑回弹消失、润色稿自动跟随恢复。

### 验证

* 全仓 `pnpm test` **140 文件 / 1644 例全绿**；`tsc -p tsconfig.json` 通过（`TSC_EXIT=0`）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。
* 本批**未引入新的 UI 文案**（v0.7.727 / v0.7.728 编译产物字符串集等量，改动为滚动 / 跟随逻辑）。


## v0.7.727 (2026-10-18)

> 本版补完 Markdown「批注 + 修订」闭环的最后一环：**拒绝（单条 / 整轮）AI 修订后，来源批注自动回锚到改写前的旧文本**，不再出现「拒绝完批注就『消失』、点不回原文」。根因是批注的 `quote` / 选区仍停在被还原掉的新文本上；本版让每轮改写额外记一份「改写前的批注锚点」`annotationBefore`，拒绝时按旧锚点还原并重绘高亮。共 **2 个文件改动**（0 新增文件，0 测试改动）。

### 修复与优化

* **拒绝 AI 修订后批注回锚（不再「批注消失」）**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx) + [MdAnnotationPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/MdAnnotationPanel.tsx)）：
  * `RevisionRound` 新增可选 **`annotationBefore`**（改写前的批注锚点，字段同 `MdAnnotation` 的 `quote` / `from` / `to` / `prefix` / `suffix`）；`addPatchRound` 新增第 9 个参数 `annotationBefore`，在生成补丁轮次时随 `patch` / `annotationId` 一并落盘（仅在存在时写入，避免多余字段）。
  * **逐条 AI 改写（按批注）** 在调用 `addPatchRound` 时传入改写前的批注锚点快照（`{ quote, from, to, prefix, suffix }`）；拒绝该轮即可把批注锚回旧文本。
  * 新增 **`restoreAnnotationAnchor(round)`**：按 `annotationBefore` 把来源批注还原（用旧锚点覆盖 `quote` / 选区 / 上下文）并置回 `resolved: false`，再在 **`requestAnimationFrame`** 里重绘批注高亮 —— 等「整篇重建回旧内容」的状态更新先落定，再用旧锚点找位置，规避时序错位。
  * `rejectRevision`（单条拒绝）与 `rejectAllRevisions`（整轮拒绝）在回滚修订后**均调用** `restoreAnnotationAnchor`；配对 `delete + insert` 会各调一次，**重复恢复幂等**，不产生副作用。
* **错误文案收敛（源内，未逐字确证）**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：`选中范围已失效（文档已变化），请重新选择文字后再试` 目前仅留在气泡侧 [AnnotationBubble.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/extensions/AnnotationBubble.tsx)；严格定位失败统一报 `文档在 AI 改写期间发生了变化（选区已失效），请重新选择文字后再试`。该两串字面量在 v0.7.726 / v0.7.727 编译产物中的命中文件数一致（均 2），**本文件内的增删无法逐字确证**，故仅在此说明为源内收敛。

### 验证

* 全仓 `pnpm test` **140 文件 / 1644 例全绿**；`tsc -p tsconfig.json` 通过（`TSC_EXIT=0`）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。
* 标记（本版新增，已比对编译产物）：`annotationBefore` 在 v0.7.727 命中 2 个 chunk、v0.7.726 命中 0 个；v0.7.727 的 DocEditor chunk 内含 `restoreAnnotationAnchor` 的压缩实现（`a.annotationBefore` → 覆盖批注 + `requestAnimationFrame` 重绘），`rejectRevision` / `rejectAllRevisions` 均调用之。本批**未引入任何新的英文 UI 字面量**（v0.7.726 vs v0.7.727 编译产物字符串集等量，差异仅为本处逻辑与压缩改名）。


## v0.7.726 (2026-10-18)

> 本版三块：① **小程序预览改为「内联」** —— 右侧预览面板里的 Mini App 不再盖住全屏（`fixed inset-0 z-[340]` 弹层），改为在面板内 `embedded` 铺满；配套一个**只在开发期生效的布局守卫**（包裹层高度 < 50px 就告警）。② **商店卡片 `Open` 直接开 Hippo** —— 商店 / 普通用户点 Open 走 Hippo 顶层页（最稳），Coding 节点调试仍走应用内 Preview。③ **AI 改写不再改错段落** —— 文档在 AI 请求期间被重建 / 外部重载时选区 `from/to` 会漂移，旧逻辑回退「全文第一处相同文本」⇒ 改写落到另一个重复段落（表现为「视图跳到别的行、原来的选却没变」）；现在改为严格定位 + 请求期间暂停外部变更轮询 + sidecar 异步返回时不抢活动轮。共 **7 个文件改动**（0 新增文件，0 测试改动）。

### 新增功能

* **小程序预览内联（`embedded`）**（[SandboxPreviewFrame.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPreviewFrame.tsx) + [CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx)）：`SandboxPreviewFrame` 新增可选 `embedded?: boolean`（默认 `false`）—— 内联时外层由 `fixed inset-0 z-[340] flex items-center justify-center bg-black/40 p-4` 改为 `flex h-full w-full overflow-hidden`，内框由 `h-[86vh] w-[1100px] … rounded-xl border shadow-2xl` 改为 `flex h-full w-full flex-col overflow-hidden`，并且**不接管 Esc**（`if (embedded) return`，键盘关闭交给宿主）。`CanvasFlow` 的预览页签（`activePanelTab.type === 'preview'`）改为 `<SandboxPreviewFrame embedded … />`，于是预览落在右侧面板内、不再遮挡全屏。Coding 节点里的预览（`ChatNodeKernel`）**仍是旧的弹层行为**（其 `Preview inside BobWork (sandboxed)` 按钮与 `sandbox-preview-open` 事件都在上一版已存在）。

* **商店卡片 `Open` 改开 Hippo**（[SandboxPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPanel.tsx)）：卡片主按钮文案仍是 `Open`，但行为改为 `openSandboxPreviewInHippo({ id, name })`，tooltip `Open this mini-app in the browser (Hippo)`（上一版为应用内预览）。代码注释写明口径：**商店 / 普通用户直接开 Hippo（顶层页，最稳）；Coding 节点调试仍走应用内 Preview**；点开时同时 `markAppOpened` 刷新「最近打开」。

### 修复与优化

* **AI 改写落到错误段落（重复文本时）**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)，+50/−6）—— 三处协作修掉同一个根因：**AI 请求期间文档被整篇重建 / 外部重载，选区坐标失效**。
  * **严格定位** `resolveAnnotationPosStrict()`：只接受「当前位置取出的文字仍与 `quote` 一致」的选区（精确 / 去空白 / 包含三种判定）。批注卡片（带 `prefix` / `suffix` 上下文）仍允许按上下文唯一锚定；**气泡直改（无上下文）不再回退**到 `findQuoteWithContext` 的「全文第一处」—— 否则改写会落到另一个重复段落上。定位失败时明确报错：`文档在 AI 改写期间发生了变化（选区已失效），请重新选择文字后再试`，宁可不改也不改错地方。
  * **请求期间暂停外部变更轮询** `aiEditInFlightRef`：`fetchAiEditSse` 前置真、`.finally` 清掉；轮询 `tick()` 见到该标记就跳过本轮 —— 否则请求期间磁盘 mtime 一变（自动保存 / 其他进程 / 同步）就会静默 `setContent` 整篇重载，把 `from/to` 冲掉。
  * **sidecar 异步返回不再抢活动轮** `latestRoundIdRef`：加载期若已产生新轮次（AI 改写或人工编辑），只**补齐历史轮**、不 `setActiveRoundId(旧轮)` —— 否则重建 effect 会把刚应用的改动还原回旧内容。
* **预览面板布局守卫（仅开发期）**（[CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx)）：预览面板包裹层新增 `data-reader-panel-wrapper` 标记，并加一个 `NODE_ENV !== 'production'` 才跑的自检 —— 展开状态下面板高度 `< 50px` 时 `console.warn('[CanvasFlow] 预览面板高度异常 (<50px)，请检查 self-stretch / h-full 是否缺失')`。这是给「内联预览后布局塌陷」这一类问题提前报警，**生产构建不会执行**。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **140 文件 / 1644 例全绿**（与 v0.7.725 相同）；`tsc -p tsconfig.json` 通过（含 `electron/`）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `latest-mac.yml` 的 `version` / `sha512` 与本地一致后放行上传。

### 已知待确认

* **[ChatNodeKernel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ChatNodeKernel.tsx) / [CalendarPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CalendarPanel.tsx) / [global.d.ts](file:///Users/baolei/Desktop/BobWork/projects/src/types/global.d.ts) 本批也有改动，但无法逐字确证**：三者都没有新增的用户可见文案（探针显示 `appleid.apple.com`、`No mini programs match`、`Preview inside BobWork (sandboxed)`、`sandbox-preview-open` 等在上一版均已存在），推断为配套调整与类型补全（`global.d.ts` 是纯类型声明，无运行时影响）。若其中含行为变更，本版记录未覆盖。
* **内联预览的滚动 / 尺寸**：预览改为面板内 `h-full` 后，其高度完全取决于宿主容器；本版只加了开发期告警，没有做「面板过窄时自动回退弹层」的兜底。
* **商店 Open 与 Coding 节点预览口径不同**（一个走 Hippo、一个走应用内弹层），用户可能觉得两侧行为不一致；这是有意取舍（Coding 需要就地调试）。

## v0.7.725 (2026-10-18)

> 本版是一次**小程序（Mini App）预览体验整批打磨**：① **Layer-1 本地存储代理** —— 预览 iframe 是 opaque origin、`localStorage` 不可用，改为把 `BobStorage` 键值镜像到 app 私有的 `.state/local-storage.json`，刷新 / 重开预览不再丢数据；② **预览就绪握手 + 友好错误页** —— 预览失败不再甩 `{"success":false,…}` 与堆栈，而是给一句人话 + `Try again`；子页主动上报 `bob_ready`，宿主据此判定加载成功、并有超时兜底；③ **预览 console 错误胶囊** —— 右上角 `Issue` 面板可直接 `Ask AI to fix` / `Try stronger model`；④ 小程序卡片新增 **`Details & history`** 入口。共 **13 个文件改动**（含 3 个测试文件）。

### 新增功能

* **小程序预览的本地存储代理（Layer-1）**（[apps.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/apps.ts) + [bridge.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/bridge.ts) + [iframe-bridge-host.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/iframe-bridge-host.ts) + [SandboxPreviewFrame.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPreviewFrame.tsx) + [preview/[id]/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/preview/[id]/route.ts) + [sandbox/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/route.ts)）：预览 iframe 带 `sandbox` 属性、不带 `allow-same-origin`，因此子页 `localStorage` 是 opaque origin、读写会被浏览器拒绝。现在把 `BobStorage.set/get` 的键值落到小程序自己的 `.state/local-storage.json`：预览路由把快照内联成 `window.__BOB_LOCAL_SNAPSHOT__`（`<script data-bob-local-storage>`）供子页同步读取；写入走 postMessage `bob_local_storage_set` 交宿主，宿主去抖后批量 `save_local_storage` 落盘。刷新 / 重开预览数据不丢。
* **预览「就绪握手」+ 友好错误页**（新增 [preview-error.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/preview-error.ts) + [SandboxPreviewFrame.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPreviewFrame.tsx) + [preview/[id]/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/preview/[id]/route.ts)）：新增 `previewErrorHtml()` —— 预览失败时若请求 `accept: text/html`，返回一张**人话错误页**（带 `bob-preview-error` meta、`Try again` 重试链接、"If it keeps happening, go back and ask AI to check this mini-app."），不再把 JSON / 堆栈直接摊在 iframe 里给非程序员看。子页 bridge 会多次上报 `bob_ready`，宿主收到才判定「加载成功」，据此驱动加载态 / 错误态，并有超时兜底；宿主侧同步主动广播 `bob_host_ready`。
* **预览 console 错误胶囊 → Fix with AI**（[SandboxPreviewFrame.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPreviewFrame.tsx)）：预览右上角新增 `Issue` 按钮与错误面板，把子页 console 错误聚合成卡片，可直接 `Ask AI to fix`（动作 `sandbox-fix-errors`）或 `Try stronger model`（动作 `sandbox-escalate-model`）交给 AI 修。（底层 console 采集是旧代码，本版新增的是这层 UI。）
* **小程序卡片新增「Details & history」**（[SandboxPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPanel.tsx)）：卡片溢出菜单新增 `<Pencil/> Details & history`，打开元数据与版本历史弹窗。（历史弹窗本体是旧代码。）

### 修复与优化

* **预览静态 / 导出路由随之调整**（[preview/[id]/[...path]/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/preview/[id]/[...path]/route.ts) + [export/[id]/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/export/[id]/route.ts)）：配合上面的内联快照注入（`bob-local-storage`）与 `.state/.history` 目录排除做了复用 / 收敛。此两文件的特征字面量在上一版已存在、无计数差，**具体改动无法逐字确证**，故只在此说明为配套微调。

### 新增单测

* [preview-error.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/preview-error.test.ts)（**新文件，2 例**）：`renders a human page, never raw JSON`、`escapes title/message instead of injecting HTML`。
* [apps.local-storage.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/apps.local-storage.test.ts)（**新文件，2 例**）：`writes, reads and removes keys that survive a reload`、`rejects invalid app ids / keys and drops oversized values`。
* [iframe-bridge-host.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/iframe-bridge-host.test.ts)（**+2 例**）：`bob_ready → onReady（宿主用于加载态/错误态判定）`、`bob_local_storage_set → onLocalStorage（value=null 表示删除）`。

### 验证

* 全仓 `pnpm test` **140 文件 / 1644 例全绿**（本批前为 138 文件 / 1638 例）；`tsc -p tsconfig.json` 通过（`TSC_EXIT=0`，`.next/types` 本轮干净、无同名「 2」副本）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。
* 标记（均已确认为本版新增）：服务端 / 桥接 `__BOB_LOCAL_SNAPSHOT__`、`HOST_LOCAL_SNAPSHOT`、`bob_local_storage_set`、`bob_ready`、`bob-preview-error`；客户端 `Try again`、`Ask AI to fix`、`Try stronger model`、`Details & history`。

## v0.7.724 (2026-10-18)

> 本版三处修复 + 一条来源闸加固：① **音频库按「入库时间」倒序** —— 新收录的录音排在最上面（此前按目录 mtime，写一次打点 / 存一个片段就把条目顶上去，越用越乱）；② **点击文稿对话只定位、不改播放状态** —— 暂停时点了就停在目标处，播放中则从目标处接着播，不再强行自动播放；③ **AI 直改不再静默失败** —— 选区坐标失效 / 定位失败 / 未预期异常都给可见错误文案，正文不再「转圈结束、毫无反应」；④ **沙箱预览路由接入来源闸**，新增 `allowCrossSiteRead` 只读跨站例外（只放开 GET/HEAD 的 iframe 入口导航，写操作仍 403）。共 **11 个文件改动**（含 2 个测试文件）。

### 修复与优化

* **音频库按入库时间倒序**（[library.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.ts) + [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：`LibraryEntry` 新增 `mtimeMs`，`listLibrary()` 与库面板统一改按 `b.mtimeMs - a.mtimeMs || a.dir.localeCompare(b.dir)` 排序（时间相同以目录名兜底，避免刷新一次换个位置）。**取「源文件 mtime」而不是「目录 mtime」** —— 目录 mtime 会在写入打点 / 峰值 / 片段时被刷新，不代表「什么时候收进来的」；而 `source.<ext>` 只在入库那一刻写一次，后续产物都是另起 sidecar、不碰源文件，所以源 mtime 才是稳定的添加时间。
* **点击文稿对话只定位、不改播放状态**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) + [TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：点某句 / 点轮首由「seek + play」改为**纯 `seek`**；`onSeek` 契约注释同步改为「**不改播放/暂停状态**：暂停则停在跳转处，播放中则从跳转处接着播」。`AudioMarkTrack` 的 `seekTo` 本就用 wavesurfer `setTime` 实现、不改播放状态，所以一处收敛即覆盖所有点击入口。
* **AI 直改不再静默失败**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx) + [AnnotationBubble.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/extensions/AnnotationBubble.tsx)）：气泡侧为 `directRevise` 加 try/catch 兜底，并校验锁定选区坐标 —— 选区随文档变化失效时报 `选中范围已失效（文档已变化），请重新选择文字后再试`，未预期异常报 `AI 修订失败：…`（此前异常发生在 `addPatchRound` 之前，无 catch，表现为毫无反馈）；主流程侧定位失败打 `[ai-revise] locate failed` 并回显 `无法定位选中的文字（可能已被改动）`，改写抛错打 `[ai-revise] rewriteSingle threw`、回显 `AI 编辑异常：…`。失败原因一律回显到气泡，可复核、可重试。
* **沙箱预览路由接入来源闸**（[loopback-guard.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/http/loopback-guard.ts) + [preview/[id]/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/preview/[id]/route.ts) + [preview/[id]/[...path]/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/preview/[id]/[...path]/route.ts) + [bridge.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/bridge.ts)）：来源闸新增 `allowCrossSiteRead` —— 宿主 UI 与预览页故意用两个回环 hostname（`localhost` ↔ `127.0.0.1`）做存储隔离，浏览器会把该 iframe 的入口导航判成 `cross-site`；现在**只放开只读方法（GET/HEAD）**，写操作仍一律 403。两个预览路由均以 `guardRequestSource(request, { allowCrossSiteRead: true })` 接入。

### 新增单测

* [library.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.test.ts) **+1 例**（`按加入库时间从新到旧排序（新的在最上面）`）。
* [source-guard.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/source-guard.test.ts) **+1 例**（`只读预览页例外：GET cross-site 允许，写操作仍拒绝`）。

### 验证

* 全仓 `pnpm test` **138 文件 / 1638 例全绿**（本批前为 1636 例）；`tsc -p tsconfig.json` 通过（`TSC_EXIT=0`）。
* 前置修了一处**构建副产物**导致的假报错：`.next/types/` 下遗留了 `routes.d 2.ts` / `validator 2.ts`（同名「 2」副本，上一轮打包拷贝的副产物），会让 tsc 报 `Duplicate identifier 'LayoutProps'`；清掉后类型检查即通过（`.next` 每次打包都会全量重建，不影响产物）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记：`选中范围已失效`、`AI 修订失败：`、`Jump to `；服务端标记：`allowCrossSiteRead`、`guardRequestSource`。

## v0.7.723 (2026-10-18)

> 本版一个小功能 + 两处修复：① **音频库分组** —— 库浏览面板新增「用户自建文件夹」：可新建 / 重命名 / 删除分组，条目**整行拖拽**归组或拖回 `Ungrouped`；删组只解散组织、**不动音频文件**；状态落 `.audio-library/.groups.json`，服务端 5 个新 action。② **DocEditor AI 修订「空操作」体验** —— 短句跳过覆盖率校验、无差异时给可见错误文案、还原时恢复视口滚动位。共 **5 个文件改动**（2 个新增）。

### 新增功能

* **音频库分组（自建文件夹 + 拖拽归组）**（[groups.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/groups.ts) 新增 + [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) + [clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：库面板从平铺列表升级为**分组视图** —— 仅当库里存在分组时才启用分区块，否则维持原平铺（不打扰旧用户）。用户可新建 / 重命名 / 删除分组；条目**整行拖拽**到区块头归组，拖到 `Ungrouped` 区块即移出。新 UI 文案 `New group` / `Ungrouped` / `Drag audio here` / `Empty` / `Group name`，新 `data-role` 值 `library-group` / `library-ungrouped`，伪组 id `__ungrouped__`；tooltip `Rename group` / `Delete group — the group is removed, your audio files stay`（**删组不动音频文件**）。新模块 `groups.ts` 导出 `AudioGroup{id,name}` / `GroupState{groups,assign}` 及 `readGroupState()`（读 `.groups.json`、脏数据规范化、绝不抛错）、`createGroup()` / `renameGroup()`（改名不改 id）/ `deleteGroup()`（删组并抹除指向它的归属）/ `assignEntry(dirAbs, groupId)`（空串 = 移出；护栏：须为正式库条目、目标组须存在，否则抛 `not a library entry`）/ `forgetEntry(dirAbs)`（条目删除时清归属）。归属键取目录 basename（`<源名>-<指纹>`），跨机器稳定；状态文件落在 `.audio-library/.groups.json`（hidden，随库存在、不进 workspace）。服务端新增 5 个 action `list_groups`（无参）/ `create_group`（`name`）/ `rename_group`（`id`,`name`）/ `delete_group`（`id`）/ `assign_group`（`dir`,`group`，`group` 空串 = 移出，缺 `dir` 报 `dir is required`），均返回**写盘后的完整状态**（`groups` + `assign`）；删除条目路径新增 `forgetEntry(abs)`。

### 修复与优化

* **DocEditor AI 修订「空操作」**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：短句（< 12 字）**跳过「跑偏」覆盖率校验**，避免对话稿单行被误判还原（此前表现为「转圈结束、正文毫无变化」）；无差异时返回可见错误文案 `AI 未产生改动（结果与原文相同），请把意见写得更具体后重试`，不再静默收起；还原时恢复视口滚动位置，避免视图跳走。

### 验证

* 本批**含测试改动**：[groups.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/groups.test.ts) 新增 **10 例**（读状态含空 / 脏数据规范化、建 / 改名 / 删组含空名与未知组抛错、`assignEntry` 移入移出与非库条目 / 缺组护栏、`forgetEntry`；用 `BOBWORK_HOME` 指向临时目录隔离）；全仓 `pnpm test` **138 文件 / 1636 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记：`library-group`、`library-ungrouped`、`New group`、`Drag audio here`、`__ungrouped__`、`AI 未产生改动（结果与原文相同）`；服务端标记：`list_groups`、`assign_group`、`.groups.json`、`not a library entry`。

## v0.7.722 (2026-10-18)

> 本版两块：① **长音频说话人分离** —— 整段 pyannote 在 1 小时以上会逼近 30 分钟超时且没有中间进度，现在 **>20 分钟自动按 10 分钟分段、段间用声纹质心对齐到同一套全局 speaker id**；配套新增 **`re_diarize`：只重跑分离、不重跑 ASR**（62 分钟录音点「Retry as 2 people」不再重跑一遍转写），前端另开 `diarize_status` 轮询显示百分比。② **小程序图标** —— 12 个模板各带默认 emoji（新建即写入 manifest），App details 弹窗新增 30 个 emoji 快选与 **AI 一键生成**（名称+描述 → 一个最贴切的 emoji）。另：修掉「连续两个新建会话排序颠倒」、把一批确认弹窗的吓人长句精简、Butler Report 页分区头改静态。共 **19 个文件改动**（1 个新增路由，19 个里含 1 个测试文件改动）。

### 新增功能

* **长音频分段说话人分离**（[diarize.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/stt/diarize.ts)，+290 行）：超过 `LONG_DIAR_THRESHOLD_SEC = 20min` 就按 `LONG_DIAR_CHUNK_SEC = 10min` 切开，**4 段并行、每段 2 线程**（`LONG_DIAR_CONCURRENCY = 4` / `LONG_DIAR_THREADS = 2` —— 注释说明 4 段 × 2 线程比 2 段 × 4 线程更快）；段内照常聚类，**段间用声纹质心对齐**（`LONG_DIAR_MATCH_SIM = 0.5`）到同一套全局 speaker id，再合并成一份 turns。`auto` 模式跨段人数上限 `LONG_DIAR_MAX_SPEAKERS = 8`；**duo 有 2 人硬上限** —— 已存在两个全局人时直接比较「直配 / 交换」两种分配取相似度和更大的，段内多出的簇归到最像的那个而**不新增第三个人**。短音频仍整段跑一次（更稳、少一次切段开销）。
  * 为什么必须这样：整段 pyannote 在 1 小时以上会逼近 30 分钟超时且无中间进度；但各段**独立编号**会让「第 2 段的说话人 1」与「第 1 段的说话人 1」变成两个人 —— 故段内聚类 + 跨段质心对齐。
  * 配套：`runDiarization` 新增 `threadsOverride`；缓存键新增区间后缀 `-r{start}-{end}`；新增导出 **`speakerForRange(chunks, start, end)`**（取与区间重叠最长的切块说话人，完全没重叠返回 `null`，不硬塞说话人）。
* **`re_diarize`：只重跑说话人分离，不重跑 STT**（[clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts) +115 + [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) +48）：旧实现点 `Retry as 2 people` 是 `refresh` 整段转写 —— 62 分钟录音要重新跑一遍 ASR。现在复用已有 `segments`，只把 duo/group 分离结果按时间重叠回填 `speaker`，**成本只剩分离本身**；并且**只分离「稿子实际覆盖的区间」**（3.6 小时录音若只转了前 62 分钟，不必分离整段）。进度写 `.cache/diar-jobs/<jobId>.json`（`pct`/`stage`，按整数百分比去抖），另开 **`diarize_status`** 轮询（因为 `re_diarize` 的 HTTP 请求会阻塞）；前端每 1.5s 轮询显示 `Separating speakers… N%`，成功后提示 `Separated N speakers without re-transcribing. Polishing…` 并自动重新润色。`maxDuration` 由 1800 提到 **3600**。
  * 说话人变了 ⇒ 旧润色稿的 speaker 不再可信，写回时 `delete polished`（保留原文，让用户重新润色）。
  * 错误口径：`no transcript for this audio — transcribe it first`（绝不凭空重建）、`ffmpeg is unavailable`、`Speaker separation produced no segments — the audio may be too noisy or overlapped`、`Still one speaker after separation — the recording may be a single voice, or the voices overlap too much`（分离后仍只有 1 人则明确报错，不糊弄成「已修复」）。
* **模板默认图标**（[templates.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/templates.ts) +18 + [apps.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/apps.ts)）：新增 `SANDBOX_TEMPLATE_ICONS`，12 个模板各有默认 emoji（`blank` ✨ / `ai-chat` 🤖 / `calculator` 🧮 / `todo` ✅ / `habit` 🌱 / `pomodoro` 🍅 / `contact-form` 📋 / `data-table` 📊 / `portfolio` 👤 / `landing` 🚀 / `reader` 📖 / `converter` 🔁），`createApp` 直接写进 manifest —— 商店卡片与侧栏不再退回通用图标或名称首字母。
* **AI 一键生成小程序图标**（[icon-suggest/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/icon-suggest/route.ts) **新增** + [SandboxPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPanel.tsx) +95）：新路由把「名称 + 描述」交给任务模型挑**一个** emoji（`TIMEOUT_MS = 10000`，非流式单轮）。清洗严格：去掉代码围栏/引号/空白 → 用 `Intl.Segmenter('zh')` 取**第一个字素**（无该 API 时退化按码点）→ **只接受 emoji / 图形符号**（`\p{Extended_Pictographic}` 或 `\u{2600}-\u{27BF}`），模型若回普通文字则视为无效、由前端兜底。弹窗侧新增 `ICON_CHOICES` 30 个常见 emoji 快选（点一下填入、仍可手改）+ `Sparkles` 生成按钮（生成中禁用、失败就地内联报错不弹窗、可反复重生成）。

### 修复与优化

* **连续两个新建会话排序颠倒**（[CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx)）：本次运行内新建的节点还没有 `createdAt`（frontmatter 未重载），原先统一按 `+∞` 处理 ⇒ 比较时 `∞ - ∞ = NaN`，稳定排序保留数组顺序 ⇒ **先建的反而排在后面**。现额外记录数组下标 `orderIndex`（新节点恒追加在末尾），时间无结论（`NaN` 或 `0`）时改用下标倒序，保证新建会话仍即时置顶。
* **确认弹窗去掉吓人长句**（[CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx) + [Sidebar.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/Sidebar.tsx) + [ProjectBoardView.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ProjectBoardView.tsx) + [BobbyNode.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/BobbyNode.tsx) + [UsagePanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/UsagePanel.tsx) + [StickyTodoDock.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/StickyTodoDock.tsx) + [LocalTtsPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/LocalTtsPanel.tsx) + [LocalSttPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/LocalSttPanel.tsx) + [LocalFileExplorer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/LocalFileExplorer.tsx)）：删除节点的弹窗从「会永久删除 .md 文档、附件、homework/ 输出文件、N 条连线…此操作不可撤销」精简为 `Its files and connections will be removed.` + 必要时的 `Breaks links to N downstream node(s).`；删批注改为 `Cards inside are not affected.`；删分组 / 文件 / 待办 / 本地模型 / 清空用量等一律去掉 `\nThis cannot be undone.` / `This frees disk space.` 这类冗句；标题统一句式（`Delete node?` / `Delete "${title}"?`）。信息量保留在必要处，重复的「不可撤销」不再占三行。
* **Butler Report 页分区头改静态**（[ButlerTodayPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerTodayPanel.tsx)）：`SectionHead` 新增 `variant: 'sticky' | 'static'`；Report 页的 `Yesterday` 与 `Today's advice` 用 `static` —— 因为 `Today's advice` 是该页最后一个分区，吸顶头后面没有别的分区头顶走它，会一路钉在滚动区顶部干扰阅读（其余负边距/内边距/底色与吸顶版完全一致，排版口径不变）。
* **测试夹具：三处「首次重加载」移入 `beforeAll`**（[edit-round-trip.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/docx-editor/edit-round-trip.test.ts) + [app-lifecycle.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/app-lifecycle.test.ts) + [app-token.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/app-token.test.ts)）：这三个用例都在 `it()` 体内做一次性重初始化（docx 引擎加载约 5.5s；沙盒 `bridge` 导入约 6.8–7.7s），稳定撞上默认 5s 预算而超时 —— **功能本身是通的**（给足超时 15/15 全绿），属测试夹具成本。现预热到 `beforeAll`（显式 60s，既给冷启动留余量、又能抓住真挂死），断言仍受默认 5s 约束。

### 界面细节

* **App details 的图标区**：由「Name 与 Icon 并排、Icon 只有 88px 输入框」改为「Name 整行 + 图标专属一块」——48px 居中输入框 + emoji 快选 30 格 + AI 生成按钮，错误就地显示在 `Icon` 标签旁。
* **`Retry as 2 people` 的 title**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：由 `Re-transcribe with two speaker clusters (runs separation again; may take a few minutes)` 改为 `Separate the existing transcript again as 2 people (no re-transcription; may take a few minutes)` —— 与新行为一致。

### 新增单测

* [diarize.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/stt/diarize.test.ts) **+2 例**（`speakerForRange`：取重叠最长的切块 / 完全没重叠返回 `null`）。
* 全仓 `pnpm test` **137 文件 / 1626 例全绿**（本批前为 1624 例）；`tsc -p tsconfig.json` 通过（含 `electron/`）。

### 验证

* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `latest-mac.yml` 的 `version` / `sha512` 与本地一致后放行上传。
* 本批**首次用上了真正的源码基线**：`.next/standalone/src` 恰好是 0.7.721 构建（12:40）的快照，19 个文件逐一做了 `diff -u`（合计 +642 / −81），不再是字符串探针反推。

### 已知待确认

* **分段分离的段边界**：10 分钟硬切，若一段对话恰好跨在切点上，两个半段的声纹质心会略有差异；`LONG_DIAR_MATCH_SIM = 0.5` 是否足够稳，还需要更多真实长录音验证。
* **`re_diarize` 只覆盖「稿子实际覆盖的区间」**：若稿子只转了前 62 分钟，后段分离结果不会回填（这是有意的省算力取舍），用户看到的是「未覆盖区间仍无标签」。
* **`diarize_status` 依赖项目内 `.cache/diar-jobs/`**：换项目/切项目时 jobId 不复用，属于「进度只是体验层」的取舍（写失败不影响分离）。
* **图标生成依赖任务模型**：未配置模型或调用失败时前端只给内联错误，不会自动退回模板图标（需用户手点快选或自己输入）。
* **三处测试夹具改动**未改变任何产品行为，但把「慢初始化」从断言预算里摘出去了；若以后 `beforeAll` 也逼近 60s，说明该模块的导入链需要单独治理。

## v0.7.721 (2026-10-18)

> 本版围绕**音频转写的人工纠错闭环**与**几处界面精简**：① **说话人可手工纠正** —— 转写稿新增「改归属 / 改名字 / 批量改名单」三类入口（侧车新增 `speakerNames`，只影响显示、不动 `segments`），配合服务端 3 个新 action。② **AI 精选建议可手动落成音轨点**（`Mark {n}`），自动打点改青色空心环，并删掉旧的整稿 `Generate marks`。③ **Hippo 的 `Open as Markdown` 收编回画布** —— 不再开浏览器标签，直接转发主窗口在右侧预览面板打开。④ **DocEditor 修订侧栏重构**：上一版的 `Track-Changes` 右键开关被移除，人工修订模式改为「打开修订侧栏即记录」。⑤ **AI Coding 创建对话框精简**（默认只留愿望框 + 两个 Build 按钮，其余收进 `More options`）。⑥ **Butler 今日面板改为固定页签头 + 独立滚动区**。共 **20 个文件改动**（含 3 个测试文件）。

### 新增功能

* **转写「说话人手工纠正」**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts) + [TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx) + [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) + [markdown.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/markdown.ts) + [clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：侧车新增 `speakerNames`（**只影响显示，不改动 `segments`**），新增纯函数 `speakerLabel()`（显示名单一真源）、`normalizeSpeakerName()`、`updateSegmentSpeakers()`、`updateSpeakerName()`、`updateSpeakerNames()`，常量 `MAX_SPEAKER_ID = 99` / `MAX_SPEAKER_NAMES = 20`。面板三处入口：轮首 hover 小箭头→就地展开一排人**改整轮归属**；点轮首名字→就地输入框**改名**（Enter 保存 / Esc 取消 / 失焦保存）；⋯ 菜单新增 **`Rename speakers`**（`Users` 图标）批量面板（`data-role="speaker-names-editor"`、标题 `Speaker names`、`Save N` / `Saving…`）。`AudioViewer` 接上 `onUpdateSpeaker` / `onRenameSpeaker` / `onRenameSpeakers`（乐观上屏 + 失败精确回滚）；`markdown.ts` 导出件标题改用显示名。服务端新增 3 个 action：`assign_speaker`（`indexes[]` + `speaker`，上限 `MAX_TURN_SEGMENTS = 2000`）、`rename_speaker`（`id` + `name`）、`rename_speakers`（`entries[]`，一次读改写）。
* **AI 精选建议「手动落点」**（[mark-ops.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/mark-ops.ts) + [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) + [globals.css](file:///Users/baolei/Desktop/BobWork/projects/src/app/globals.css) + [AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：`marksFromSegments` → `marksFromRanges`（入参改为 `{start,label}`）；`AudioViewer` 新增 `Bookmark` 图标按钮 **`Mark {n}`**（把勾选的 AI 精选建议落成音轨打点）。`globals.css` 新增 `--mark-line-ai: #0f8a7c` / `--mark-line-ai-soft`（青绿），自动打点改画**青色空心环**；同时**删除**旧的整稿 `Generate marks` 动作及其 `onGenerateMarks` prop。
* **Hippo「Open as Markdown」收编回画布**（[hippo-browser.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-browser.ts) + [preload.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/preload.ts) + [desktop-adapter.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/desktop-adapter.ts) + [CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx)）：新增 `handoffMarkdownToCanvas(url)` 拦截本机 `/markdown-view` 地址 —— 不再开浏览器标签，而是收编 Hippo 并转发主窗口；新增 IPC 通道 `hippo-browser:open-local-file` 与 `onOpenLocalFile`，`CanvasFlow` 新增 `useEffect` 调 `openFileTab('local', …)` 落在右侧预览面板。

### 修复与优化

* **DocEditor 修订侧栏重构**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx) + [MdAnnotationPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/MdAnnotationPanel.tsx)）：移除上一版的 `manualReviseMode` 状态、`Track-Changes` 右键开关与工具栏指示按钮 —— **人工修订模式 = 打开修订侧边栏**（`annotationPanelOpen`）；右键菜单项由 `annotations` + `revise` 改为 **`Annotations` / `Revisions`**（`openPanelTo`）。新增 `justAppliedScrollRef`（就地应用修订后**恢复原视口滚动位**，防「改完页面滑走」）与 `revisionRoundsLoadedRef` 锁（切文档不再覆盖 sidecar）。
* **AI Coding 创建对话框精简**（[AICodingCreateDialog.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/AICodingCreateDialog.tsx)）：默认视图只留愿望输入 + **`Build (Fast)`** / `Build Mini App` 两个按钮；预设、名称、参考文件、Fast build 开关收进可折叠 **`More options`**（副标题 `preset · name · file · Fast build`）；预设改为下拉且默认 **Blank**；删除灵感卡片网格与可编辑 Fast build 简报（`BriefDraft` / `INSPIRATIONS` / `buildBriefDraft`）。
* **Butler 今日面板布局**（[ButlerTodayPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerTodayPanel.tsx)）：改为「固定页签头 `tabHeader` + 独立内容滚动区 `contentScroll`」（面板不再自带滚动与 padding，滚动只发生在内容区）；页签顺序调整为 Report / Schedule / Sticky / **News（末位）**；一行式今日概览（`Today N · Overdue N · N suggestion(s)`）从「页签之上」移入 **Report 页内**；数据源降级提示固定在内容区外底部。

### 验证

* 本批**含测试改动**：`transcript.test.ts` 新增约 **25 例**（改归属 8 / 改名单条 5 / 批量 6 / `speakerLabel` 2 / sidecar 4）、`markdown.test.ts` 新增 2 例（导出用显示名、未归属措辞区分）、`mark-ops.test.ts` 重命名 describe 并新增约 2 例（无标题不落点、标签按 `AUTO_MARK_LABEL_MAX` 截断）；全仓 `pnpm test` **137 文件 / 1624 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记：`Rename speakers`、`Speaker names`、`speaker-names-editor`、`--mark-line-ai`、`More options`、`Build (Fast)`、`Revisions`；Electron 标记：`hippo-browser:open-local-file`、`handoffMarkdownToCanvas`；服务端标记：`assign_speaker`、`rename_speaker`、`rename_speakers`。

## v0.7.720 (2026-10-18)

> 本版两条主线：① **Butler 可换头像** —— 联系人（persona）新增「Auto / 10 张内置原型 / 上传自定义图」三档，系统身份（Bobby / 小微）钉死不可覆盖；自定义图经附件接口落盘、由新 `GET /api/butler/avatar` 回读（仅限 `<APP_ROOT>/butler/` 内图片）。② **文档「人工修订模式」Track-Changes** —— [DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx) 右键菜单新增开关，开启后用户**手工编辑**按 900ms 空闲 burst 合并成修订轮次，配合批注面板的 `You` 徽标。另有：音频打点配色（琥珀色，与播放头 / 选区区分）+ 放大时打点溢出边框的修复、音频片段行动作收进 `⋮` 菜单、Butler Today 面板概览行与 Yesterday 默认折叠、Mini Apps 面板改为 iOS 桌面式图标网格（可拖拽排序 + 星标 badge）。共 **15 个文件改动 + 1 个新增**（新增 `GET /api/butler/avatar` 路由）。

### 新增功能

* **Butler 可换头像**（[PersonaDialog.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/PersonaDialog.tsx) + [avatar.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/avatar.ts) + [avatar/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/avatar/route.ts) 新增 + [threads-shared.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/threads-shared.ts) + [storage.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/storage.ts) + [session/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/threads/session/route.ts) + [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：新增 `resolveAvatarId`（优先级 = **系统身份钉死 > 用户选定 > 按性格 / 名字派生**）与 `isPersonaAvatarId`；`fixedName`（Bobby / 小微）时整块头像选择器不渲染，保证系统身份永不被覆盖。persona 新增字段 `avatar` / `avatarImage`（路径上限 `AVATAR_IMAGE_PATH_MAX = 1024`）；`storage.ts` 新增 `isInButlerRoot` 防目录越界；`session/route.ts` 的 POST body 新增 `avatar` / `avatarImage` 清洗。自定义图先经 `/api/butler/attachments` 落盘取得绝对路径，再由新接口回读：`GET /api/butler/avatar?path=<绝对路径>`，**只服务 `<APP_ROOT>/butler/` 内图片**，仅允许 png/jpg/jpeg/webp/gif/bmp/avif/ico（**拒 svg**），上限 8MB，响应 `Cache-Control: private, max-age=31536000, immutable`；错误文案 `invalid path` / `unsupported image type` / `image too large` / `not found`。渲染侧 `ButlerDrawer` 的 `ContactAvatar` 由只传 `personality` 改为传整份 `persona`，头像覆盖据此生效。
* **文档「人工修订模式」Track-Changes**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx) + [MdAnnotationPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/MdAnnotationPanel.tsx)）：右键菜单新增开关 `Track-Changes`（`FileDiff` 图标）；开启后把用户的**手工编辑**按 900ms 空闲「burst」合并成修订轮次（与 AI 修订同轨），工具栏出现可点击指示 `Track-Changes: on — click to turn off`，并自动切到修订视图；批注面板给人工轮次打 `You` 徽标（`UserRound` 图标），空态文案改为 `No revisions yet. Turn on Track-Changes…`。

### 修复与优化

* **音频打点配色 + 放大溢出修复**（[globals.css](file:///Users/baolei/Desktop/BobWork/projects/src/app/globals.css) + [AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：新增 CSS 变量 `--mark-line: #b06a06`（琥珀色，与播放头 / 选区的紫色区分）与 `--mark-line-auto`；打点圆点与波形竖线改用打点色，悬停「吸附到打点」时同步切换。修复**音轨放大时打点溢出边框** —— 新增 `visibleMarks` 按当前窗口百分比过滤（`<0` / `>100` 的点不渲染）。
* **音频片段行动作收进 `⋮` 菜单**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：片段行原先平铺的 7 个图标（播放 / 视图 / 文稿 / 改名 / 导出 / fork / 删除）收进一个 `⋮`（`MoreVertical`）菜单（`ClipMenuAction`，`fixed` 定位、视口夹取 / 上翻），菜单项 `Play excerpt` / `Zoom to clip` / `Transcript` / `Rename` / `Export` / `Make separate audio` / `Delete`，`aria-label` 为 `{name} actions`。
* **Butler Today 面板信息密度**（[ButlerTodayPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerTodayPanel.tsx)）：News 页签移到末位；页签上方新增一行式概览 `Today N · Overdue N · N suggestion(s)`；Yesterday 复盘默认折叠约 6 行并加 `Show full digest` / `Show less`；日期改用 `en-US`；字号与吸顶分区头等视觉调整。
* **Mini Apps 面板改为图标网格**（[ButlerMiniAppsPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerMiniAppsPanel.tsx) + [sandbox-starred.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox-starred.ts) + [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：由列表改为 iOS 桌面式图标网格，支持**拖拽排序**（`sandbox-starred.ts` 新增 `reorderStarredApps`）；图标右上角星标 badge 承接「取消标星」（`Unstar`）；顶部 `Starred mini-apps · N` + `Browse store`；空态 `No starred mini-apps yet…`。仍挂在 Butler 右栏 rail 项 `Mini Apps`（`section === 'miniapps'`）。

### 验证

* 本批**含测试改动**（[avatar.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/avatar.test.ts)：新增 `resolveAvatarId` 优先级 / `isPersonaAvatarId` 用例组）；全仓 `pnpm test` **137 文件 / 1596 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记：`--mark-line`、`Play excerpt`、`Make separate audio`、`Track-Changes`、`Starred mini-apps · `、`Show full digest`；服务端标记：`unsupported image type`、`image too large`、`/api/butler/avatar`。

## v0.7.719 (2026-10-18)

> 本版是一次较大的功能版本，四条主线：① **小程序 / AI Coding** 从「先建模板、再答 6 问」改成**先许愿（可选 Fast build 简报）**，并补上生成之后的运维闭环 —— 改码即刷新、Console 错误一键 / 自动修复、失败切强模型、详情弹窗改名 / 复制 / 版本回滚；同时把 Bridge 文档改为**按需读取**（`read_bridge_docs`）、新增 **AI Chat 模板**与统一 `smoke-test.js`、coding **遥测 JSONL** 与**质量基准 CLI**。② **音频编辑器搬到 Hippo 全页 `/audio-editor`**（左波形 / 右对话稿两栏），片段重构为「**命名区间**」（拖两端只改清单、导出才现渲染，要独立编辑须 **fork 成新主音频**），转写后**自动 DeepSeek 润色**、可**逐句原地改字**、可导出 **Markdown** 并在新 **`/markdown-view`** 阅读器打开；本地 STT 新增 **Zipformer CTC**，说话人分离修掉「同性别两人被并成一个」。③ **Web 检索改为 provider seam**（新增 DeepSeek Search/Fetch 直连 provider + 本地 http 兜底带 SSRF 防护），结果结构化带**来源 / 日期 / 权威性**；用量接入**按次计费**与 **Year 视图**；Daily News 检索降本。④ **Hippo 浏览器能真正把网页文件拿下来**（下载四件套 + 落进项目 `materials/`），浏览器工具面收窄成 **Core / Full 档位**，子 Agent 创建独立成框，标星小程序入口迁到 **Butler 左栏 Mini Apps**。共 **97 个文件改动**（29 个新增：19 个源码 / 组件 + 10 个测试文件）。

### 新增功能

* **许愿编程（wish-first）+ Fast build 简报**（[AICodingCreateDialog.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/AICodingCreateDialog.tsx) + [context.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.ts)）：新建小程序首屏改为 `What do you want to build?` 愿望框（`⌘/Ctrl + Enter` 直接建、计数器 `/800`、写入 `sandbox_spec.wish` 时截 600 字）；名称可空（`deriveAppName` 取愿望首行、超 24 字加 `…`）；模板可空；12 张灵感卡新增 `AI Chat`。**Fast build 默认关**，开启后进入可编辑简报（Function / Audience / Interaction / Persistence / Style / AI 六项，空字段交 AI 推断）。服务端判定 `specReady = fast_build === true && (wish || category || interaction || persistence)`：**6 问仍是默认质量门禁**，Fast build 只跳过「用户显式确认过简报」的场景；已有实现的新节点直接进修改模式。
* **小程序详情弹窗：改名 / 图标 / 描述 / 复制 / 版本回滚**（[SandboxPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPanel.tsx) + [apps.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/apps.ts) + [sandbox/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/sandbox/route.ts)）：商城卡片新增铅笔按钮，弹窗 `App details` 提供 Name（80）/ Icon（8）/ Description（300）与 `Save` / `Duplicate` / `Version history`。新 action `update_meta` / `duplicate` / `history` / `restore_version`。`duplicateApp` 在**根层**跳过 `data/`、`.history/`、`.trash/`、`manifest.json`（子目录同名资源保留）、**保留 `origin`**（imported 不因复制洗白）、缺 `smoke-test.js` 时补一份；`restoreAppHistory` 先校验 stamp（`^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$`）与 `safeChildPath`，写回走 `writeAppFileAtomic`，且**回滚前再备份当前版本**。
* **预览 Console 捕获 + Fix with AI + Stronger model（有界自动修复）**（[iframe-bridge-host.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/iframe-bridge-host.ts) + [SandboxPreviewFrame.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPreviewFrame.tsx) + [ChatNodeKernel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ChatNodeKernel.tsx)）：宿主桥新增 `bob_console` 分支（只归一化不执行：`level` 截 20 字、`text` 截 500 字、最多 50 条）；预览浮层新增 Console 面板（`Fix with AI` / `Stronger model` / `Clear`），`error` 级去抖 300ms 派发 `sandbox-console-errors`。**自动修复预算 1 次 / 每用户轮**（只保留最近一次待修错误、最多 8 条、收尾后 80ms 尝试发送并另设 1200ms 兜底；若正在流式 / 持久化 / 输入框非空则跳过，避免抢用户下一句）。`Stronger model` 按 `deepseek + pro` → 任意 `pro` 选择本会话模型后重发。
* **`read_bridge_docs`：Bridge 文档按需读取**（[coding-docs.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/coding-docs.ts) 新增 + [context.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.ts)）：原先每轮整段注入的 Bridge API 文档拆成 `storage` / `host` / `graph` / `chat` / `hostTool` 五个分区，core prompt 只留一页索引 + AI 接入策略（A 用户明确要求 → 直接接；B 功能天然依赖 → 先问一句；C 纯工具 → 不接不问；D 用户明确禁止 → 绝不接）；工具 `scenes:['coding']`、`maxOutput: 16000`、标 `ondemand`（避免落入常驻段作废前缀缓存）。这同时消掉了「为了亲儿子主动加集成」的诱导。
* **AI Chat 模板 + 统一冒烟脚本**（[templates.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/templates.ts) + [apps.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/apps.ts)）：新增第 12 个模板 `ai-chat`（流式 AI 对话 + 模型选择 + 错误兜底：`#model` 下拉、`listConfiguredModels` 填充、`BobStorage` 记住选择、`BobWork.chatStream` 逐字输出）；新增通用 `SMOKE_TEST_JS`（写 `window.__testResult`，步骤 `body-rendered` + `primary-interaction`，按 `steps.every(ok)` 汇总），`createApp` / `duplicateApp` 在模板未自带时自动补一份。
* **Butler 左栏「Mini Apps」+ 小程序工具**（[ButlerMiniAppsPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerMiniAppsPanel.tsx) 新增 + [butler.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler.ts)）：新增右栏面板（数据源为标星小程序，与商城同一份 localStorage；同时拉 `GET /api/sandbox` 补名称 / 描述 / 更新时间，并回收已删 app 的死标星），点卡片在 Hippo 打开、可取消标星、`Browse store` 收抽屉进商城。Butler 新增 `list_mini_apps`（只读）与 `create_mini_app`（模板 12 选 1，可带 task；创建后派发 `session-request`、agent 固定 `coding`）；`create_session` 新增 `sandbox_app_id`（正则 + 存在性校验 + **强制 agent=coding**）。
* **Coding 遥测 JSONL**（[telemetry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/telemetry.ts) 新增 + [api/telemetry/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/telemetry/route.ts) 新增）：每轮 coding 会话收尾追加一行到 `{appRoot}/bob-sandbox/telemetry.jsonl`，字段固定 `at / appId / modelId / durationMs / firstCodeMs / firstPreviewMs / toolCalls / toolErrors / autoRepair / consoleErrors` —— **只收数值与短 id，不记愿望、代码、模型输出或个人信息**；单行 ≤2048 字符，写盘失败静默（不影响主流程）。端点走 `guardRequestSource` 回环校验。
* **Coding 质量基准 CLI**（[benchmark.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/benchmark.ts) 新增 + [coding-benchmark.ts](file:///Users/baolei/Desktop/BobWork/projects/scripts/coding-benchmark.ts) 新增）：7 个 case（`todo` / `calculator` / `form` / `dashboard` / `ai-chat` / `graph` / `host-tool`），通用门禁 4 项（入口非空、`<!DOCTYPE html>`、viewport meta、无 `alert()`）+ 可要求 smoke 含 `__testResult`；`pnpm coding:benchmark --list` / `--app <appId> --case <caseId>`，退出码 0 通过 / 1 失败 / 2 参数错误，可直接接 CI。
* **音频编辑器搬到 Hippo 全页 `/audio-editor`**（[page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/audio-editor/page.tsx) 新增 + [audio-editor-url.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/hippo-browser/audio-editor-url.ts) 新增 + [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：画布预览只有 ~600px，波形与对话稿堆叠后都不够用；新路由给满宽两栏（`wide`：左波形 + `Excerpts` 常驻清单，右 `Transcript` / `Suggested`，窄屏回落单列）。`audioEditorUrl()` 集中拼 `?path=&name=&size=` 并**刻意把 `127.0.0.1` 换成 `localhost`** —— 服务端会把预览 origin 302 回 localhost，而 302 会丢 query（实测 `/audio-editor?path=…` 会变成 `/audio-editor`）。
* **音频预览改为 Hippo 启动卡**（[AudioHippoLauncher.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioHippoLauncher.tsx) 新增 + [registry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/registry.ts)）：打开音频文件即在 Hippo **自动**打开一次（同路径去重），失败保留手动入口；音频扩展名补 `webm`。
* **片段重构为「命名区间」：`update_clip_range`**（[clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts) + [AudioClipTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioClipTrack.tsx)）：拖两端**只写 `.clips.json` 的 start/end**，不跑 ffmpeg、不覆写文件（`reclip` 收窄为「导出前现渲染」，导出时再 `&v=timestamp` 绕缓存）；`onExtend` 改名 `onRangeChange(clip, start, end)`；术语全面改称 `Excerpt`（`Save excerpt` / `Excerpts` 页签 / `Excerpt name`）。
* **`fork_clip`：把片段复制成独立主音频**（[clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts) + [origin.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/origin.ts) 新增）：从源音频 + 当前区间渲到同卷 `.fork-XXXXXX` 临时目录 → 走 `importFileToLibrary()`（流式 sha1 前 10 位作目录后缀、同内容复用）→ 写 `.origin.json`（`AudioOrigin{source, sourcePath, sourceName, start, end, createdAt}`）。前端出面包屑 `‹ 原录音 · from mm:ss–mm:ss · [separate copy]` 与标题徽标 `Source audio` / `Excerpt copy`。
* **转写后自动 DeepSeek 润色对话稿**（[ai.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/ai.ts) + [ai/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/ai/route.ts) + [transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts)）：新 action `polish_turns`（每批 ≤40 轮、40s 超时、`temperature 0.3`、抠 JSON、防御性剥掉模型自加的 `[说话人 N]` 前缀）与 `save_polished`（≤500 轮）；前端按每批 20 轮、最多 240 轮分批跑，进度 `Polishing {done}/{total}`；转写成功且非半截稿即**自动**润色（状态条 `Transcribed in Ns. Polishing…`）。sidecar 新增 `polished?: TranscriptPolish{at, model, turns}`，脏块丢弃但原文仍可读。
* **转写稿逐句原地编辑**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts) + [clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts) + [TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：纯函数 `updateSegmentText` 只改 `text`；服务端 `save_transcript` 要求 sidecar **存在且与当前音频指纹相符**（绝不凭空新建）、单句 ≤5000 字、回传整份 transcript。前端行内 `textarea`（Enter 保存 / Shift+Enter 换行 / Esc 取消 / 失焦保存、**IME 守卫**、写入串行化防「读-改-写回」互相覆盖、乐观上屏且失败只回滚这一句）。
* **对话稿导出 Markdown + 独立阅读器 `/markdown-view`**（[markdown.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/markdown.ts) 新增 + [page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/markdown-view/page.tsx) 新增）：`transcriptToMarkdown` 支持 `raw`（ASR 原文）/ `polished`（润色对话轮，无润色块时自动退回 raw）；新 action `export_markdown` 优先落 `项目/materials/`，无项目落 `~/BobWork/.cache/transcripts`；`/markdown-view` 用 `/api/local-files` 读文件后复用 `MdViewer`。片段稿只保留区间内句子（跨边界整句保留、时间改相对区间）；区间内无句子时导出前挡住（`No transcript text in this clip`）。
* **本地 STT 新增 Zipformer CTC（中文 2025-07-03）**（[sherpa.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/stt/sherpa.ts) + [audio-parser.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/parse/audio-parser.ts)）：新模型 `zipformer-ctc-zh-2025-07-03`，**只作可选引擎、不设默认**（与 SenseVoice 在电话录音上互有胜负）；新增能力位 `needsPunctuation`（只出裸字 ⇒ 逐段补标点，失败原样返回不阻断）与 `supportsBatchFiles`（CTC 传多文件会报错 ⇒ 直接逐段跑）。
* **「没有分出说话人」提示 + 二人重试**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx) + [transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts)）：sidecar 新增 `diarize` 字段（老 sidecar 从 `engine` 文案推断）；「请求过分离却一段标签都没有」时出提示 + `Retry as 2 people`（强制 duo、`refresh:true`，并**沿用原 `range`**，不会把整段长音频重跑一遍）。
* **Web 检索 provider seam**（[web/service.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/web/service.ts) 新增 + [web/types.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/web/types.ts) 新增 + [web/index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/web/index.ts) 新增）：`WebService` 只做选择 / 执行 / 错误归一；`registerSearchProvider` / `registerFetchProvider` 重复 id 抛错；13 个 `WEB_*` 错误码；选择规则 = 显式 id（缺失 / 不可用分别报）→ 未配置走默认 → `auto` 先默认再唯一可用（多个可用报 AMBIGUOUS）；`WebError` 原样透传，`formatWebError` 渲染 `Error: [CODE] msg`。**检索不再绑定聊天模型。**
* **DeepSeek Search / Fetch 直连 provider**（[deepseek-api.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/web/providers/deepseek-api.ts) 新增）：`POST {base}/v1/tools/search|fetch`，一次操作一次请求、不消耗辅助模型轮次；Search 可一次带回摘要 / 正文（`need_content`）；Key 取设置里 DeepSeek 厂商同一把，回退 `DEEPSEEK_API_KEY`；25s 超时；Search / Fetch 两条独立队列 210ms（≈5 QPS）；`count` 夹取 1–50（默认 5）；**按成功计费**（Search 结果非空一次、Fetch 正文非空一次；失败 / 空 / 超时 / 429 不计费）。
* **本地 http 抓取 provider（无 Key 兜底）**（[http-fetch.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/web/providers/http-fetch.ts) 新增）：`assertPublicUrl` / `isPublicIp` 防 SSRF（禁内嵌凭据、URL ≤2048、拒 localhost / `.local` / `.internal`、DNS 全部地址须公网；IPv4 私网 / CGNAT / 链路本地 / TEST-NET / 组播，IPv6 ULA / LL / NAT64 / `::ffff:` 一律拒）；manual 跟随 5 跳且**每跳复验**；20s、响应 ≤5MB 流式累计、正文 ≤100k 标 truncated；charset 按 BOM → header → meta，GB2312 / GB18030 归到 GBK；HTML 经 `extractHtmlText` 转 Markdown；**不计费**。
* **Daily News 采集降本**（[generate.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/generate.ts)）：权威站从「每站一次检索」压成 `site:a OR site:B` 的 1–2 次（按 120 字符切块，DeepSeek 上限 128），正文由 Search 的 `need_content` 带回，**删掉「候选 14 条 × 逐条 Fetch」**；新增站点公平性（`groupByHost` + `interleaveHits`，URL 去重）。注释口径：约 ¥6/月 → ¥1–2/月。
* **Hippo 下载四件套**（[specs.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/browser-tools/specs.ts) + [hippo-cdp.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-cdp.ts) + [hippo-browser.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-browser.ts) + [browser.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/browser.ts)）：新增 `browser_find_downloads` / `browser_download` / `browser_downloads` / `browser_save_download`（工具规格 48 → 52 条）。CDP 侧新增 `FIND_DOWNLOADS_SCRIPT`（扫链接 / 按钮、扩展名白名单、文案与 class/id 命中 `下载|附件|导出|保存|download|export|save`、可见性校验、最多 20 个候选）；主进程补齐 `DownloadWaiter` 队列、桥 `/download` `/downloads`、`revealDownload` 三态报错（`Download not found` / `has not finished yet` / `File not found on disk`）；`browser_save_download` **要求有激活项目**否则明确报错，落 `materials/<folder>`（文件夹名净化、重名递增 `stem (n).ext`）。
* **侧栏工具面 Core / Full 档位**（[profiles.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/agents/profiles.ts) + [settings.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/settings.ts)）：`AgentProfile` 新增 `toolAllowlist` / `toolAllowlistBypassOnFull`；新增 `BROWSER_CORE_TOOLS`（**31 条**，全量 52 条中被挡在 Core 外 21 条，如 cookies / storage / network / console / drag / coordinate / resize 等），默认只注入 Core，设置 `browserToolset: 'core' | 'full'` 可切 Full（`undefined` = core）—— 目的就是**缩小上下文、加快首 token**。
* **专属子 Agent 创建框独立**（[AgentCreateDialog.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/AgentCreateDialog.tsx) 新增）：`＋ Add session → New Agent…` 打开 520px 弹窗（`New Agent` / `Existing Agent` 两档）；新建走 `create_agent_package`、改造走 `update_agent_package`，首轮消息要求模型先用 `ask_user_questions` 确认 scenes / exclusions / skillPool。
* **截图自检「原生视觉优先」**（[vision-model.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/providers/vision-model.ts) 新增）：当前 coding 模型声明 vision 时**直接看图**（OpenAI 兼容 `chat.completions` + `image_url`，`max_tokens 800`、60s、`maxRetries 0`），失败静默回退 `bob-ocr-mcp`；自带五条视觉检查清单（布局 / 间距溢出 / 颜色排版 / 可见控件状态 / 渲染缺陷）。

### 修复与优化

* **AI 改码后预览不再停在旧版本**（[SandboxPreviewFrame.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SandboxPreviewFrame.tsx) + [ChatNodeKernel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ChatNodeKernel.tsx)）：预览订阅 `sandbox-changed`（按 `appId` 过滤、150ms 去抖、刷新时清空 console 消息）；变更广播正则由 `write_file|delete_file|rename_file` 扩到含 **`edit_code`** 与 `sandbox_rollback` —— 此前 `edit_code` 不广播，预览会长期停留在旧版本。
* **说话人分离把同性别两人并成一个**（[diarize.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/stt/diarize.ts)）：`DIAR_VERSION` **4 → 5**；`planClusterMerge` 只在 `mode === 'auto'` 时调用 —— **duo / group 不再做声纹合并**（0.5 余弦阈值会把同性别 / 同电话音色的两位真人并成一个，用户选了「2 人」却仍拿到无标签稿）。
* **播放收束到选中片段**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx) + [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：播放边界优先级改为**选区 > 聚光区间 > 播到底**；选中时出 `Excerpt · mm:ss–mm:ss` 芯片（可一键清除），并新增句柄 `playRange` / `zoomToRange`（片段一键放大到界面宽度）。
* **转写入口收敛为「一次点击 = 对话稿」**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：`transcribe()` 固定带 `diarize:'auto'`（`Separate speakers` 勾选移除），失败时接管服务端已落盘的**半截稿**、转写中每 4s 轮询 `load_transcript` 显示逐窗进度。
* **图片放大后没有明显变大**（[ImagePreviewLightbox.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ImagePreviewLightbox.tsx) 新增 + [HtmlRenderer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/HtmlRenderer.tsx)）：抽成共享组件，用 `carousel.imageProps` 覆盖 yarl 的「最小(自然尺寸, 视口)」内联尺寸（`width/height:100%` + `objectFit:contain`）⇒ 小图等比放大 2–3 倍、大图仍 contain 不裁切；`HtmlRenderer` 由内联 `Lightbox + Zoom` 改为复用该组件。
* **Butler 线程裁剪改为滞回**（[threads-shared.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/threads-shared.ts)）：新增 `THREAD_KEEP_ROUNDS = 14`，`trimThreadMessages` 由「超 40 条裁到 40」改为「超 40 条裁到 `14*2 = 28` 条」（向偶数对齐、开头是 assistant 再前进一步、保留末尾未答复的单条 user）。注释带缓存回测：`butler-notify` 卡在 40 条时 prompt ≈100k tokens、逐轮命中率仅 22–27%，「>90k 上下文的管家首调」占全部 miss 的 16.7%；滞回后窗口在 14↔20 轮阶梯变化、裁剪后连续约 6 轮可复用前缀，预估该类 miss 降约 5 倍。顺带把「未读条数」抽成可测的 `countUnreadAssistant()`。
* **浏览器等待语义收敛**（[hippo-cdp.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-cdp.ts) + [hippo-browser.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-browser.ts)）：`browser_snapshot` 由等满 15s 改为只等 **1.5s 落定**；`browser_open_tab` 由等满 20s 改为 **3s**；`browser_read_article` 在「正文已出现（`innerText > 100`）但 `readyState` 未 complete」时再给 **600ms** 就返回，不再死等 6s。
* **下载不被误判重复调用 + 计入页面交互**（[route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts)）：新增 `isPollingTool()`（`browser_downloads` 同参重复调用属正常轮询，跳过去重）；`PAGE_INTERACTION_TOOLS` 补 `browser_download`（下载会改变页面状态，需重置内容读取缓存）。
* **团队模式按画像门控**（[profiles.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/agents/profiles.ts) + [route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts)）：新增 `supportsTeamCollab(profile)`，`teamModeOn = supportsTeamCollab(profile) && multiAgentMode === true` —— 修复 fixed 画像（coding / 市场 agent）因旧节点残留 `multi_agent_mode=true` 被注入 `MULTI_AGENT_RULES` 却没有 `team_run`。
* **审批层把下载算作写类**（[approval.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/chat/approval.ts)）：`BROWSER_WRITE_ACTIONS` 增 `download` / `save_download`（`ask` 档弹确认、`never` 档直接拒）；写类判定抽成导出的 `isWriteKindTool(name)`，兼容 `mcp__{server}__browser_click` / `browser.click` / 裸 `browser_click` 三种形态。
* **模型拉取报错可操作化**（[SettingsModal.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SettingsModal.tsx)）：401/403 按厂商给出具体出路（火山方舟 / 百炼 / OpenAI / 硅基流动…），兜底 `Check that the API Key is correct…`；Base URL 含非 ASCII 直接拦下；30s 超时给明确文案。
* **空账本判定**（[usage/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/usage/route.ts)）：`meta.empty` 改为 `tasks === 0 && webTools.length === 0`；**小额成本不再抹零**（`fmtCost` 按量级 2–5 位小数去尾随 0，¥0.005 不再显示成 ¥0.01）；裸关键词检索失败不再抛（与单级失败只丢该级口径一致）；Daily News 站点公平性（`interleaveHits`）。

### 改进

* **用量接入按次计费 + Year 视图**（[usage.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/usage.ts) + [route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/usage/route.ts) + [UsagePanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/UsagePanel.tsx)）：新增 `source='web'` 与 `WEB_TOOL_UNIT_PRICE_CNY = { search: 0.005, fetch: 0.005 }`（¥5/千次），`recordWebToolUsage` 写 0 token / 1 call；`UsageSummary` 增 `webTools`、`UsageWindow` 增 `sources` / `excludeSources`；面板新增 **Web tools** 区块（`N calls · billed per successful request`）与 **Year** 视图（当月 + 往前 11 个自然月，只留月度折线）。
* **`web_search` / `web_fetch` 切新 seam**（[web.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/web.ts)）：`web_search` 结果结构化 —— `Search results (DeepSeek):` + 每条 `来源: 站点 · YYYY-MM-DD · 权威性 N/4` + 摘要 ≤700（旧实现是 Bing / 百度 / DDG 抓取 + Readability + Volcengine 兜底、`Summary:` 整段）；`web_fetch` 默认 DeepSeek Fetch、正文上限 6000 → **7600**，非 200 会带 `HTTP: n`；权威性 ≥3 的条目出卡片。
* **工具面收窄的配套提示词与设置**：浏览器提示词补「等待语义」与「下载文件」两段（明确 `ready:false` / 空标题 / `[!] 页面可能未加载完` 都是正常信号，应改用 `browser_wait_for_text` / `wait_network_idle` 而不是重复 snapshot；下载给出完整闭环与四个「不要」）；设置新增 `Web Search` 段（Search / Fetch provider 下拉，`DeepSeek providers reuse the DeepSeek key from Models. Changes apply from the next tool call.`）与 `Browse toolset` Core / Full 开关。
* **crawler 提示词与纪律**（[context.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.ts)）：coding prompt 新增【范围纪律】（只实现愿望需要的集成，不为「亲儿子」主动加 AI / 日历 / 项目集成）、【高权限】（hostTool 与 graph 只在功能需要时用，破坏性命令先说明）、【交付底线】（`<!DOCTYPE html>`、viewport meta、无 `alert()`、空态不显示 NaN/undefined/0、复杂交互写 smoke-test）。
* **用户指南同步**（[SKILL.md](file:///Users/baolei/Desktop/BobWork/assets/skills/user-guide/SKILL.md)）：新增 Mini Apps 入口、Coding 章节（AI Chat 模板、`smoke-test.js`、铅笔按钮三项能力、Console 修复链路、Butler `list_mini_apps` / `create_mini_app`、`telemetry.jsonl`），以及 Bob OCR 随包内置说明。

### 界面细节

* **许愿编程首屏**：愿望框（占位示例「加班费计算器」）、`⌘/Ctrl + Enter to build · clearer wish = fewer questions`、`/800` 计数；名称标 `(optional — auto from your wish)`；模板下拉 + 12 张灵感卡；Fast build 开关 `skip the 6 questions and confirm a short build brief instead. Off by default`；简报标题 `Build brief — edit anything the AI should not guess`；主按钮在 Fast build 下为 `Build with brief`、否则 `Build Mini App`；支持附参考图 / 文件（`image/*,.pdf`）。
* **App details 弹窗**：`No versions yet — a version is saved automatically before each AI write.`、`Duplicate copies code only (no private data or version history).`；每条版本 `stamp · N KB` + `Restore`；`Version history` 加载后变 `Refresh versions`。
* **预览 Console 面板**：`Console {n} err` 按钮、`Console · captured from the preview (latest N)`、`Clear` / `Fix with AI` / `Stronger model`（无错误时后两者 disabled）、空态 `No console messages.`。
* **Mini Apps 面板**：`Starred mini-apps · N`、`Browse store`、空态 `No starred mini-apps yet. Star apps in the Mini Programs store, then they show up here.`；卡片 `Unstar` / `Open in Hippo`。⌘F 面板**删除**了标星小程序前 5 个图标与 `+N` 入口（入口迁到 Butler 左栏）。
* **音频 `excerpt` 化与 fork 来源**：`Excerpts · N` + `ranges of this recording`、锁图标说明 `Excerpts are ranges of this recording. The master audio is never modified.`；面包屑 `‹ {sourceName} · from mm:ss–mm:ss · [separate copy]`；标题徽标 `Source audio` / `Excerpt copy`；转写面板头部动作收进 `⋯`（`Transcribe selection` / `Polish with DeepSeek` / `View polished` / `Open as Markdown`）。
* **润色与编辑态**：`Polishing {done}/{total}`；polished 视图每轮一条说话人色竖条 + `Speaker N` + 时间范围；编辑行用 `--surface` 底 + 左侧主色竖条（与选区同口径），`Enter to save · Esc to cancel` / `Saving…`。
* **下载卡片与提示**：`ai-card ai-card-download`（标题 `已下载：<name>`、`<进度> · 保存到系统下载目录`、正文 `savePath`，列表最多 3 张）；侧栏提示统一走窗口工具栏 toast（`bob-hippo-toast`），面板不再自建浮层。
* **设置项**：`Web Search` 导航段（Globe 图标，关键词含 `联网 / 搜索 / 抓取 / 网页`）；`Browse toolset` 行（仅 Hippo 通道开启时出现，`Core` / `Full` + ToggleSwitch，说明随档位切换）；`＋ Add session` 菜单在市场画像列表后新增分隔线 + `New Agent…`（Bot 图标）。

### 新增单测

* 新增 10 个测试文件（**共 44 例**）：`sandbox/benchmark.test.ts`（4）、`sandbox/coding-docs.test.ts`（3）、`sandbox/telemetry.test.ts`（2）、`audio/markdown.test.ts`（6）、`web/service.test.ts`（10）、`web/providers/http-fetch.test.ts`（9，含 IP 白名单 14 行 `it.each`）、`chat/tools/web.deepseek.test.ts`（6）、`news/generate.test.ts`（8）、`agents/profiles.test.ts`（5）、`providers/vision-model.test.ts`（3）。
* 扩展：`audio/transcript.test.ts` **+13 例**（polished sidecar 3 / `updateSegmentText` 7 / `groupSegmentTurns` 3，文件共 39 例）；`__tests__/node-markdown.test.ts` **+2 例**（`sandbox_spec` 限长与只认严格 `fast_build:true`、YAML 往返）；`sandbox/iframe-bridge-host.test.ts` **+1 例**（`bob_console` 归一化且不执行业务请求，共 13 例）；`sandbox/prompt-consistency.test.ts` 增 `read_bridge_docs` 分流断言（共 6 例）；`butler/threads.test.ts` 29 例（新增未读 3 例 + 滞回 2 例）；`chat/approval.test.ts` 10 个 it 块 / 86 例（新增 `isWriteKindTool` 三组）。
* 全仓 `pnpm test` **137 文件 / 1591 例全绿**；`tsc -p tsconfig.json` 通过（含 `electron/`）。

### 已知待确认 / 迁移缺口

* **改一行即丢整份润色稿**：`save_transcript` 写回前会 `delete next.polished`（有意避免过期对话），但**无提示、不保留旧结果** ⇒ 用户编辑任意一句后必须重新润色（多一次模型调用）。
* **`DIAR_VERSION` 4→5 使分离缓存全部失效**：缓存键带版本，项目 `.cache/diar/` 里旧条目**不命中也不会被清理**；旧录音首次打开会重跑一次分离（分钟级）。
* **片段文件与区间短暂不一致**：拖两端只改 `.clips.json`，磁盘片段文件仍是旧区间内容，直到导出时现渲染 —— 有意设计（不悄悄替换用户已导出/分享的文件），但「文件是缓存、区间是真源」对用户不可见。
* **Markdown 导出无项目时落缓存目录**（`~/BobWork/.cache/transcripts`，不进项目 / 资料索引），且文件名时间戳取 `toISOString()` ⇒ **UTC 而非本地时间**；同名同秒两次导出可能覆盖。
* **Year 视图在「只有 Web 调用」时可能整块空白**（`byMonth` 排除 web，而 Year 又隐藏 Web tools）。
* **Daily News 检索未传 billing** ⇒ 这部分费用 `project_id` 为 NULL，Project 作用域看不到。
* **Core 档位挡掉 21 个浏览器工具**（cookies / storage / network / console / 拖拽 / 坐标 / 视口等）：需要这些能力时必须到设置切 Full，否则模型会「看不到」这些工具。
* **`chunkSiteQueries` 注释与测试不一致**：注释说 tech 会拆 2 次，实测 115 字符、测试断言 1 次（以测试为准，注释待改）。
* **`transcript` 编辑与润色均为「单份 sidecar」**：按选区转写会整份覆盖局部稿（v0.7.697 起的既有语义），本版未改。
* **`audio-editor` 页面在 Hippo 里没有 preload** ⇒ 全部能力走同源 HTTP；`CanvasFlow` 里旧的 `LazyAudioViewer` 空态是否已成死路径待确认。

## v0.7.718 (2026-10-17)

> 本版三块：① **Butler 录音导入改「NDJSON 流式进度」** —— 说话人分离（diarize）过程中实时回传百分比，前端显示 `Analyzing speakers… N%`，不再是一次性等待。② **OCR 批注气泡可单独拖动** —— 新增 `dragMode 'textMove'`，气泡独立于标记本体拖动（clamp 到画布），并抽出 `markTextPos` / `markTextBubbleRect` 统一「命中 / 拖气泡 / 选中框」三处口径。③ **音频片段轨「点空白退出选中」** —— 点空白既跳转又清除选中，新增 `onClearSelect` 回调。另：说话人分离线程数按 CPU 自适应。共 7 个文件改动（0 新增文件，1 测试改动）。

### 新增功能

* **Butler 录音导入流式进度**（[route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/meeting/route.ts) + [MeetingStart.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/MeetingStart.tsx)）：`import_probe` 由一次性 JSON 改为 **NDJSON 流**（响应头 `Content-Type: application/x-ndjson; charset=utf-8`、`Cache-Control: no-store`），每行 `{t:'progress', phase:'diarize', pct}`、收尾 `{t:'done', durationSec}` 或 `{t:'error', error}`；`ensureDiarization` 新增 `onProgress` 回调（按整数百分比变化才发，`lastPct` 去抖）。前端新增 `probeImport(audioPath, onProgress)` 读流，映射为 `{done, total:100, phase:'speakers'}`，文案 `Analyzing speakers… N%`（无 total 时回退 `Analyzing speakers…`）。错误文案 `Could not read the recording (HTTP ${resp.status})`。
* **OCR 批注气泡可单独拖动**（[ScreenOcrEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/screen-ocr/ScreenOcrEditor.tsx)）：新增 **export** `markTextPos(ctx, m)` 与内部 `markTextBubbleRect(ctx, m)`（命中 / 拖气泡 / 选中框三处共用）；`dragMode` 新增 `'textMove'`，拖拽状态新增 `textFrom`；拖动分支新增 `textMove`（**仅改 `textX` / `textY`**，clamp 到画布）；新增 `overLabel` hover 光标提示。非 mosaic 工具下气泡均可单独拖动，本体拖动仍限 `select` / `text` / `underline`。
* **片段轨「点空白退出选中」**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) + [AudioClipTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioClipTrack.tsx)）：新增 `clearClipSelection` / `handleSelectionChange`（选区变化镜像 `highlightRange`，`sel === null` 时 `setActiveClipPath(null)`）；`AudioClipTrack` 新增可选 prop `onClearSelect`，点空白处与 `onSeek` 同时调用。

### 修复与优化

* **说话人分离线程数自适应**（[diarize.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/stt/diarize.ts)）：`runDiarization` 新增 `onProgress?` 形参；线程数由硬编码 2 改为 `Math.max(2, Math.min(4, (os.cpus()?.length ?? 4) - 1))`，CLI 参数改为 `--segmentation.num-threads=` / `--embedding.num-threads=`；新增行缓冲 `errBuf` + `noteProgress`，用正则 `/progress\s+(\d+(?:\.\d+)?)%/` 从 stderr 解析进度并透传到 `ensureDiarization`。

### 验证

* 本批**含测试改动**（`rect-geometry.test.ts` 新增「批注气泡：可点中 + 可单独拖动」用例组：缺省位置 / 气泡命中 / 空白不命中 / `textX`·`textY` 锚点 / 无批注无气泡）；全仓 `pnpm test` **127 文件 / 1502 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记：`textMove`、`Analyzing speakers`、`并退出选中`；服务端标记：`application/x-ndjson`、`audioPath is required`、`--segmentation.num-threads=`。

## v0.7.717 (2026-10-17)

> 本版把扫描 OCR 的**框选矩形**升级为**可带文字批注**的一等标注（与下划线 / 箭头同构）：矩形新增可选 `value` / `textX` / `textY`，落定后在框**左下角外侧**挂「+ 添加批注」按钮，补虚线引线（引线起点 = 框边界最近点）、支持气泡拖拽与 Delete / 撤销重建，命中测试改为同时计入气泡框。新增测试块钉住引线锚点语义。共 2 个文件改动（0 新增文件，1 测试改动）。

### 新增功能

* **矩形标注可带文字批注**（[ScreenOcrEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/screen-ocr/ScreenOcrEditor.tsx)）：`Mark` 的 `rect` 变体新增可选 `value?` / `textX?` / `textY?`（空 = 纯框）；`Draft` 新增 `rect?` / `rectId?`，`AnchorPending.kind` 增 `'rect'`。新增 **export** `leaderAnchorOnRect(x, y, w, h, box)`（**引线起点 = 框边界最近点**，气泡中心落在框内时取最近边的垂足，避免退化成 0 长引线）与内部 helper `rectTextY()` / `rectTextX()`（缺省气泡在框下方外侧、贴底时翻上方、与框左边对齐且过长左移防出图）。复用既有批注路径：命中测试同时算气泡框、绘制补虚线引线、拖框时同步偏移 `textX` / `textY`、删除误删后按 `rect` 几何重建、落定后在框左下角外侧挂「+ 添加批注」按钮。

### 修复与优化

* **Rect 工具按钮 title 扩写**（[ScreenOcrEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/screen-ocr/ScreenOcrEditor.tsx)）：由 *Rect: drag to box a region* 改为 *Rect: drag to box a region, then drag the + button to add a note*，交代「框选后可加批注」的第二段操作。

### 验证

* 本批**含测试改动**（扩展 `rect-geometry.test.ts`，新增 `leaderAnchorOnRect` 引线锚点用例：气泡在框外 → clamp 到边界 / 正右 / 正上 / 对角到框角；气泡中心在框内 → 取最近边垂足）；全仓 `pnpm test` **127 文件 / 1497 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记校验：`then drag the + button to add a note`、`data-screen-ocr-editor="true"`。

## v0.7.716 (2026-10-17)

> 本版三块：① **扫描 OCR 新增「框选矩形」标注** —— 一等对象（可选中 / 拖动 / Delete / 撤销），矩形**只命中四条边**（内部不拦截点击，便于圈住文字；容差 8px），马赛克笔刷档位收敛为 `[0.25, 0.5, 1]`。② **音频详情区页签回到 3 个**（`Transcript` / `Suggested` / `Clips`，`Clips` 与下轨为同源两视图），**说话人分离默认开启**；`TranscriptPanel` 由「逐行操作面」改造为**纯阅读的对话稿**（连续同一 speaker 并为「轮」，点轮首跳转）。③ **说话人分离加「声纹簇合并」**（`planClusterMerge`，质心相似度 ≥0.5 的簇合并，减少假说话人；`DIAR_VERSION` 3→4）；片段轨引入**分层错位**解决重叠遮挡。共 8 个文件改动（1 新增，2 测试改动）。

### 新增功能

* **扫描 OCR 框选矩形标注**（[ScreenOcrEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/screen-ocr/ScreenOcrEditor.tsx)）：新增一等工具 `Tool='rect'` 与标注类型 `{kind:'rect'; x; y; w; h}`、`MIN_RECT=12`、`drawRectMark()`、`dragMode 'rect'`，工具栏新增 `Square` 图标（title *Rect: drag to box a region*）。几何口径收敛为两个 **export** 函数：`rectFromDrag(sx, sy, cx, cy, cw?, ch?)`（两端各自钳进 `[0, 边界]`，`w`/`h` 恒正，正反向拖拽归一化结果一致）与 `hitTestMark`（矩形**只命中四条边**、容差 8px，内部不拦截 —— 保证「空心框能圈住内部文字而不抢点击」）。`Mark` 同步 export 供单测。另：马赛克档位常量 `MOSAIC_BRUSH_STEPS` 由 `[0.5, 1, 1.8]` 收敛为 `[0.25, 0.5, 1]`（圆点直径同比缩放），工具栏宽 `TOOLBAR_W` 236→268，箭头气泡锚点语义改为**箭尾（起点）外侧**。
* **音频详情区 3 页签 + `Clips` 视图回归**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：`DetailTab` 增加 `'clips'`（`tabAvailable.clips=true`，`data-role="clips-section"`；页签 `Clips` / `Clips · {n}`），导出片段后自动 `setDetailTab('clips')`；`diarize` 默认值 `false`→`true`（说话人分离默认开）；`TranscriptPanel` 不再接收 `onAddMark/onClipLine/onClipBatch`，改传 `defaultOpen`。空态文案 *No clips yet — drag a range and press Clip*。
* **说话人分离「声纹簇合并」**（[diarize.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/stt/diarize.ts)）：新增 export `planClusterMerge(clusters, allSpeakers, durationOf, threshold=0.5): ClusterMergePlan`（`{ remap: Map<number, number>; clusters: ClusterCentroid[]; merged: boolean }`）与常量 `VOICEPRINT_MERGE_SIM=0.5`；分离流程内先算质心 → `planClusterMerge` → 若 `merged` 则重映射 speaker、重建 chunks 并过滤幽灵簇。`DIAR_VERSION` 3→4，`THRESHOLD_AUTO` 0.9→0.95。

### 修复与优化

* **`TranscriptPanel` 改造为纯阅读对话稿**（[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：撤掉勾选框 / `toggleSelect` / `selectedRanges` / 顶部 `Clip N` / 逐行 `＋``✂` / `TEXT_LINES` 行截断；新增 `turns` useMemo（连续同一 speaker 并成一「轮」，仅多说话人时启用）、`renderRow()`（整行可点按钮）、`mmss()`。轮首显示 `Unassigned` / `Speaker {n}`（title *Jump to where this speaker starts*），整行 title `Jump to {mmss}`。
* **片段轨分层错位**（[AudioClipTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioClipTrack.tsx)）：新增 `LANE_H=40` / `BLOCK_H=32` / `LANE_GAP=4`、`laneTop()` / `laneTrackHeight()` / `assignLanes(clips)`（贪心最少层，按**已提交**区间计算，拖拽中不跳层），解决重叠片段互相遮挡。属性：`data-lanes={laneCount}`、`data-clip-lane={lane}`。
* **`AudioMarkTrack` 移除「按句截取」句柄**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：删除 `requestClip()` 及 `suggestRef` 兜底逻辑，仅保留 `getSelection()`（该路径已由详情区页签 + 片段轨取代）。

### 验证

* 本批**含测试改动**（新增 `rect-geometry.test.ts` 覆盖 `rectFromDrag` / `hitTestMark` 边命中语义；扩展 `diarize.test.ts` 覆盖 `parseDiarizationOutput` / `buildSpeakerChunks` / `clipChunks` / `diarModeOf` / `planClusterMerge`）；全仓 `pnpm test` **127 文件 / 1490 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记校验：`data-role="clips-section"`、`data-clip-lane`、`Rect: drag to box a region`、`Jump to where this speaker starts`；服务端标记：`[diarize] 声纹合并后：簇 `。

## v0.7.715 (2026-10-17)

> 本版是 **音频「双轨编辑器」的可视化打磨（纯视觉层）**：把上轨（波形打点）与下轨（片段）包进同一条 `relative` 时间轴容器，新增一条**贯穿两轨的虚线引导线** —— 拖动片段轨两端手柄时，把草稿区间**实时投影**到上方波形；上轨同时对选中 / 拖拽区间**聚光**、其余整段压暗。无新文案、无服务端改动。共 3 个文件改动（0 新增，0 测试改动）。

### 修复与优化

* **双轨容器 + 跨轨拖拽引导线**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：把 `AudioMarkTrack` / `AudioClipTrack` 包进 `<div className="relative flex flex-col gap-2" data-role="tracks">`；新增 `clipDrag` 状态接住下轨拖拽草稿（`ClipDragReport`），派生 `spotlight`（草稿区间 ?? 选中片段区间 ?? null）、`guideTime`、`guideX`（复用 `trackView.view.start/sec`，与两轨同源映射）；当 `guideX != null` 渲染贯穿虚线 `data-role="drag-guide"`（`data-guide-t={guideTime ?? ''}`，`pointer-events-none absolute inset-y-0 border-l border-dashed`）。
* **波形聚光高亮**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：新增可选 prop `spotlight?: { start: number; end: number } | null`；给定区间时用两片 `data-role="spotlight"` 底色遮罩把区间外压暗（`color-mix(in oklab, var(--surface-muted) 68%, transparent)`）、区间内保持高亮；`b <= a` 或时长未知时不绘制，未传 prop 时观感与旧版一致。
* **片段轨上报拖拽草稿**（[AudioClipTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioClipTrack.tsx)）：`DragState` 导出为 `ClipDragReport`（内部保留 `type DragState = ClipDragReport` 别名）；新增 `onDragGuide?: (d: ClipDragReport | null) => void`，按下 / 移动即上报草稿、松手上报 `null`；`endDrag(commit)` 区分提交与取消，事件改为 `onPointerUp={() => endDrag(true)}` / `onPointerCancel={() => endDrag(false)}`（两端手柄各一处）。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记校验：`data-role="tracks"`、`data-role="drag-guide"`、`data-role="spotlight"`。

## v0.7.714 (2026-10-17)

> 本版是 **音频「双轨编辑器」第一步 + OCR 箭头批注可带文字**：① 音频详情区由「分区堆叠」改为**页签**（仅 `Transcript` / `Suggested`），撤掉 `Source` / `Clips` 分区，新增底部**片段轨**（新组件 `AudioClipTrack`）—— 已导出的片段按其在源音频里的区间，与上轨**同一时间轴、同一播放头**摆放，选中后**拖两端即改 start / end**（拖拽期只画本地草稿，松手才调一次 ffmpeg）。② 服务端 `POST /api/audio/clip` 新增 **`reclip`** 动作，专做「就地重切已存在的片段」，与 `clip`（新建）分工。③ 扫描 OCR 的**箭头标注也能带文字批注**（与下划线批注同构）。④ 波形微调按钮**不再显示 `0.3` 数字**。共 5 个文件改动（1 新增，0 测试改动）。

### 新增功能

* **音频片段轨 `AudioClipTrack`（新增组件）**（[AudioClipTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioClipTrack.tsx)）：双轨编辑器的下轨。把 `clips` 按**相对源音频的区间**摆在与上轨**同一条时间轴**（同时间窗、同播放头）上，渲染为可点选块（`data-role="clip-track"` / `data-clip-block`）；选中块两端出拖拽手柄（`data-clip-handle="start"|"end"`，title *Drag to change where this clip starts / ends*）；**拖拽期用本地草稿区间绘制**（不每帧请求服务端），松手回调 `onExtend` → 父级调 `reclip` —— **只在松手时花一次 ffmpeg**。props：`clips / durationSec / view / playhead / activePath / onSelect / onSeek / onExtend / busy`。空态文案 *No clips yet — drag a range and press Clip*。仅被 `AudioViewer.tsx` 引用。
* **`reclip`：就地重切已存在的片段**（[route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：POST 体 `action:"reclip" | source | path | clipPath | startSec | endSec`。流程：校验参数 → `resolveAudio` 取 `sourceDir`（**限定在该音频库目录内**，防越权覆写）→ `probeAudioDurationSec` + `validRange`（≥0.1s，越界报错）→ `clipAudio` **覆写同一路径** → `upsertClipRef` / `writeClips` 更新 `.clips.json` 的 start / end。与既有 `clip` 的分工：`clip` **新建**片段，`reclip` **就地重切**一个已存在的片段（双轨编辑器里「拖两端改长度」的落地点）。**路由路径未变**，仅扩展 POST 分支。
* **音频详情区改页签 + 接入片段轨**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：详情区由「分区堆叠」改为**页签**（`data-role="detail-tabs"`，仅 `Transcript` / `Suggested`），撤掉 `Source` 与 `Clips` 两分区；底部挂上 `AudioClipTrack`，新增 `activeClipPath` 选中态与 `reclipClip`（调 `reclip`）接线；重切成功 toast *Updated ${clip.name} · …*。
* **OCR 箭头标注可带文字批注**（[ScreenOcrEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/screen-ocr/ScreenOcrEditor.tsx)）：`arrow` mark 新增 `value` / `textX` / `textY`，与下划线批注**同构**；「+ 添加批注」的待定状态由 `UnderlinePending` 泛化为 `AnchorPending`（带 `kind: 'underline' | 'arrow'`）；引线锚点统一到 `leaderAnchorOnSegment`（**线段最近点投影**），并新增 `arrowDefaultTextAnchor` / `arrowTextX` / `arrowTextY`。

### 修复与优化

* **波形微调按钮去掉数字徽标**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：撤掉 `↺` / `↻` 按钮上的 `0.3` 徽标（仅留图标），步长改由 `title` / `aria-label` 交代（`Back 0.3 seconds` / `Forward 0.3 seconds`）。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。客户端标记校验：`data-role="clip-track"`、`data-clip-handle`、`data-role="detail-tabs"`；服务端标记：`'reclip'`。

## v0.7.713 (2026-10-16)

> 本版两块：① **找到并修掉「项目面板顶部点不动」的真正根因** —— 不是热区大小问题，而是全屏覆盖层**没有声明 `no-drag`**：Electron 的 `app-region` 命中**不遵循普通 `z-index`**，上层未声明 `no-drag` 时，下层（CanvasFlow 顶部拖拽条 + 左栏窗口控制区）的 drag 区仍会吃掉点击，于是面板顶部（含 `Open on launch` 开关）**只有越出 drag 区、靠下的部分能点到**。② **Butler 气泡支持 widget 可视化** —— 此前气泡正文只走 `StreamingMarkdown`，` ```widget:* ` 围栏会退化成裸代码块；现改走 widget 感知渲染（与画布对话节点同源），含 widget 的气泡不套气泡壳、满宽展示。共 2 个文件改动（0 新增，0 测试改动）。

### 修复与优化

* **项目面板顶部点不动：全屏覆盖层补 `no-drag`**（[ProjectBoardView.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ProjectBoardView.tsx)）：给项目面板的全屏覆盖层 style 补 `WebkitAppRegion: 'no-drag'`（并把内联对象断言为 `CSSProperties`，新增 `import type { CSSProperties } from 'react'` 支持 `WebkitAppRegion` 这类非标准属性）。**根因说明**：窗口顶部有 drag 拖拽热区（`CanvasFlow` 顶部拖拽条 + 左栏窗口控制区），而 Electron 的 `app-region` 命中**不按普通 `z-index` 走层级** —— 上层不显式声明 `no-drag`，下层的 drag 区照样吃掉点击。这解释了 v0.7.710 / v0.7.711 两轮「改热区大小」都治不好：真正被吃掉的不是开关的命中面积，而是**面板顶部整条被 drag 区覆盖**。
* **Butler 气泡支持 widget 可视化**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：新增 `ButlerMarkdown` —— 无 widget 时保持原行为（整段交给 `StreamingMarkdown`），有 widget 时按 `parseWidgetBlocks` 分块，`kind === 'text'` 走 `StreamingMarkdown`、其余交 `WidgetRenderer`；流式期间未闭合围栏（`hasOpenWidgetFence`）用 `WidgetSkeleton` 占位。`hasWidgetBlocks(bodyContent)` 为真时**不套气泡壳**、外层 `max-w-[80%]` 放宽为 `flex-1`（与画布对话节点 `ChatNodeKernel` 同口径），并同步应用到「批注详情」（`selectedNotice.body`）的渲染。导入 `WidgetRenderer` / `WidgetSkeleton` 与 `@/lib/widget-blocks` 的 `hasWidgetBlocks` / `hasOpenWidgetFence` / `parseWidgetBlocks`。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.712 (2026-10-16)

> 本版修 **v0.7.710 引入的「等待三点一直闪」回归**，并把 `Open on launch` 的命中热区改为**以开关为中心对称外扩**：① v0.7.710 的折叠补追用「服务端条数 ≥ 折叠快照条数」判本轮是否落库，但服务端 `trimThreadMessages` 只保留最近 N 轮 ⇒ 返回的列表可能比折叠快照还短，`len >= baseline` **恒假**，轮询永不采纳、界面停在「只有提问、等待点一直闪」；改为按「线程 `updatedAt` > 发出时刻 + 末尾是助手气泡 + 末尾那轮的 user 正文对得上本轮提问」**三条同时成立**才认落地。② `Open on launch` 热区不再用「整行可点」，改为开关自身 `::before` 向四周对称扩 10px（48×36），**文案不参与点击**，避免命中重心偏离按钮。③ 修 **OCR 文字批注框「真失焦时草稿既不落定也不清理」** 与 **中文输入法「上屏」回车提前提交**。共 3 个文件改动（0 新增，0 测试改动）。

### 修复与优化

* **`turnLanded` 判定重做：不再用条数比大小**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：`DialogState` 新增 `updatedAt`（服务端线程最后写入时刻，来自 `threads.ts` 的 `upsertThread`；置已读刻意不写它）；`pendingTurn` 增加 `baselineAt`。判定三条：① `updatedAt > baselineAt` —— 且 `baselineAt` 取**本轮发出时刻**（`turnSentAtRef`）而非折叠时刻，以覆盖「服务端在折叠前就已写完这轮」的情形；② 服务端末条是助手（`entry.ts` 的 `finally` 恒按「提问 + 回复」成对落库）；③ 末条之前的最后一条 user 正文与本轮提问**互含**（挡掉别的轮次稍后落库被误认；纯附件轮正文被 `stripInjectedBlocks` 剥空时认它落地，否则永远判不落地）。轮询到**上限仍未落地**则作罢并**清掉还在闪的空白占位气泡**（保留提问气泡、停掉流式光标）——这轮服务端确实没写库（上游整轮失败时 `entry.ts` 只在 `combined.trim()` 非空才写），别留一个空气泡一直闪。
* **`Open on launch` 命中热区对称外扩**（[ProjectBoardView.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ProjectBoardView.tsx)）：外层恢复为布局 `div`；开关自身用 `before:absolute before:-inset-2.5 before:content-['']` 生成**以开关为中心对称**的热区（四周各扩 10px ⇒ 48×36），加 `cursor-pointer`；开关尺寸与工具栏布局均不变，`Open on launch` 文案**不参与点击** —— 整行热区会让命中重心偏离按钮本身，表现为「触发的落点没有正对开关」。
* **OCR 文字批注框：真失焦时草稿不落定 / 中文输入法回车提前提交**（[ScreenOcrEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/screen-ocr/ScreenOcrEditor.tsx)）：① 文字框的 `ref` 由内联箭头函数改为**稳定引用** `focusTextInput`（`useCallback`）—— 内联箭头每次重渲染都换身份，React 会重新调用它，`textMountTs` 被持续刷新，导致 `onBlur` 里 `Date.now() - textMountTs < 400` 的「挂载初期防误失焦」保护**恒为真** ⇒ 真正的失焦既不落定草稿也不清理，表现为「点走之后草稿还在飘」；② `onKeyDown` 补 IME 守卫（`e.nativeEvent.isComposing || e.keyCode === 229`）—— 中文输入法「上屏」那一下也会发 Enter，不拦会在成文之前就提交半截甚至空草稿（本仓库其他 Enter 提交点均有此守卫）；③ 提交改为从 `textDraftRef.current ?? textDraft` 取草稿，避免 state 滞后于输入框 DOM 的实际内容。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.711 (2026-10-16)

> 本版是 **上一版「`Open on launch` 热区」的手感微调**：把「整行可点」附带的多余视觉干预去掉 —— 不再给按钮加 `hover` 底色与圆角（会在鼠标掠过时「莫名亮一下」），只保留 `cursor-pointer` 与更大的命中范围，点击区域依旧覆盖「轨道 + 文案」。**无任何底色，仅扩大光标命中范围**。1 个文件改动（0 新增，0 测试改动）。

### 修复与优化

* **`Open on launch` 热区去掉底色、只留命中范围**（[ProjectBoardView.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ProjectBoardView.tsx)）：`className` 由 `ml-1 -my-1 … rounded-md px-2 py-1 transition-colors hover:bg-[var(--paper-hover)]` 改为 `ml-1 -my-1.5 … px-2 py-1.5` —— 去掉 `hover` 底色、圆角与过渡，内边距略放大（`py-1.5`）补偿去掉的视觉反馈，`-my-1.5` 同步负外边距保持工具栏高度不变；`<button role="switch">` 包住轨道 + 文案的结构不变，命中面积仍为整行。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.710 (2026-10-16)

> 本版修两处**交互可用性**问题：① **「正在回答的时候缩小会丢失会话」** —— Butler 抽屉在流式中途折叠后重开，服务端要到流结束才**整轮落库**，此前的实现会直接回填「还没有本轮提问」的旧状态，把整轮问答抹掉；现在折叠瞬间留一份气泡快照，重开先用它显示对话，再轮询到回复落地才切回服务端状态。② **项目面板 `Open on launch` 开关「点不动」** —— 原先只有 28×16 的轨道可点（命中面积过小、无指针提示），现在**整行（轨道 + 文案）都是点击热区**并带 hover 反馈。共 2 个文件改动（0 新增，0 测试改动）。

### 修复与优化

* **正在回答时折叠不再丢会话**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：新增模块级 `pendingTurn = { threadId, messages }`（跨「卸载 → 重挂载」存活）。折叠 cleanup 里，`messagesRef` 取当下最新气泡存入快照（cleanup 闭包拿不到最新 `messages`，故用 ref 保真）——因为服务端要等流结束（`entry.ts` 的 `finally`）才整轮写库，abort 之后服务端状态里**还没有本轮提问**。重开同一会话时（`openChatSession`）：若 `turnLanded()`（服务端条数 ≥ 快照条数且末条为助理）判否，则**先用折叠快照把对话显示出来**，并启动 `startLandingPoll` 轮询（5s 一次、最多 180s）到回复落地才切回服务端状态、顺带标记已读；否则走原正常回填。配套：`send` 发出新一轮时作废同会话的补追标记（否则补追采纳落地回复会盖掉刚发的这轮）、`destroySession` 清空标记、会话列表兜底改为**优先保留「尚未落库」的 `pendingTurn` 会话**（原实现会退到 `list[0]` 切到别的会话，用户就以为会话丢了）、`stopLandingPoll` 保证同一时刻只有一条轮询。
* **`Open on launch` 开关命中面积**（[ProjectBoardView.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ProjectBoardView.tsx)）：原先 28×16 的开关轨道单独成按钮，外围 `div` 只做布局 ⇒ 点到文案/空隙无效、无指针提示，表现为「经常点不动」。改为外层 `<button role="switch" aria-checked>` 包住轨道 + `Open on launch` 文案，整行都可点；加 `cursor-pointer`、`hover:bg-[var(--paper-hover)]`、`rounded-md` 与 `-my-1 px-2 py-1`（负外边距保证工具栏高度不变）。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.709 (2026-10-15)

> 本版是 **试听进度可视化 + 一处图标语义修正版**：① 试听选区（点浮条 `Play` / 带选区按空格）时，波形上铺一层主色**轨道播放进度**，一眼看出试听走到哪了；② 画布顶部工具栏「添加」按钮的图标由 `MessageCircle` 换成 `MessageCirclePlus`（表达「新建对话」而非「一个对话」）。共 2 个文件改动（0 新增，0 测试改动）。

### 新增功能

* **试听选区的轨道播放进度**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：`sel && playing && now ∈ [sel.start, sel.end]` 时渲染 `data-role="sel-progress"` 覆盖层 —— 从选区起点铺到当前时刻，底色 `color-mix(in oklab, var(--primary-strong) 22%, transparent)`，让「试听走到哪了」在波形上直接可见。层次刻意安排：`z-10` 高于选区插件自身的高亮层（其内部用 `z-index` 2 / 5）、低于打点名字层（`z-20`）与浮条（`z-40`）；`pointer-events-none` 保证仍可在波形上悬停 / 拖拽；用 `pctOf` 定位（与打点竖线、投影标签同一套映射），窗口外的部分夹到 0 / 100 —— 缩放跑到选区外也不画出界。播到终点由 `playUntilRef` 自动停、`playing` 转 false，这层随之消失。

### 修复与优化

* **「添加」按钮图标语义**（[CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx)）：`lucide-react` 的 `MessageCircle` 改为 `MessageCirclePlus`（import 与使用处同步），让「新建对话」这一动作的图标带上 `+`。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.708 (2026-10-15)

> 本版是 **音频编辑器「精修 + 选区联动」版**：① 前进/后退步长由 3 秒改为 **0.3 秒**（`Shift` + `←`/`→` 走 3 秒粗调）；② 修掉**波形选区两端拖不动** —— 拖拽收尾的归位会把用户刚调好的选区整体覆盖回「锚点 → 松手点」；③ 波形选区**实时联动转写面板**：落在选区内的句子（时间上有交叠）高亮；④ `Library` / `Transcript` 等六个分区小标签字重由 `font-medium` 加粗为 `font-semibold`。共 3 个文件改动（0 新增，0 测试改动）。

### 修复与优化

* **波形选区两端拖不动**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：选区插件把两端渲染成 `ew-resize` 拖拽手柄、并允许整体平移，但它**不拦 pointerdown** ⇒ 按下事件冒泡到波形容器触发 `seekFromPointer`，把选择锚点钉在这一刻；拖拽收尾的 `onUpCapture` 再按「锚点 → 松手点」重写选区，于是用户刚调好的大小/位置被**整体覆盖** —— 表现就是「选区两端根本拖不动」。新增 `pressInSelection()`（含两端各 6px 的手柄带，与插件 `addResizeHandles` 宽度一致）：按在已有选区上时**不钉锚、不跳播放头**，并压掉随后 300ms 的 click（否则插件「点击即清除」会把选区一并删掉，误触手柄也会中招），把手势整体让给插件。
* **前进/后退步长 3s → 0.3s**（同上）：`NUDGE_SEC` 由 `3` 改为 `0.3`（控制行按钮随之显示 `↺0.3` / `↻0.3`），新增 `NUDGE_COARSE_SEC = 3` 供 `Shift` + `←`/`→` 粗调；两个定位按钮的 `title` 与波形区提示 `title` 同步补上 `Shift for 3s`。理由：这一屏的主要工作是**卡选区边界 / 找打点落点**，3 秒一步会跳过句内的气口；0.3 秒是「一个字的量级」，够精修又不至于连点十几次。跨句/跨段交给粗调与打点跳转 `[` / `]`。

### 新增功能

* **波形选区实时联动转写面板高亮**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)、[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)、[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：波形轨道新增 `onSelectionChange` —— 拖拽中随 `region-updated` **实时**上报绝对秒选区（`null` = 无选区），接线方式与既有 `onViewChange` 同款（放 `cbRef`、`?.` 短路、不接则组件行为逐字节不变）；`AudioViewer` 新增 `selRange` 镜像把选区转给 `TranscriptPanel` 的新 prop `highlightRange`。转写面板按**时间交叠**判定（`1e-6` 容差：正好贴边/零长不算，免得「挨着」也被点亮）：落在选区内的句子底色用 `color-mix(in oklab, var(--primary-strong) 12%, transparent)`，另加一条 `inset 2px 0 0 var(--primary-strong)` 的**左侧竖条**。与「正在播放」档**刻意分开**：播放高亮表达「当前读到这里」、选区高亮表达「你圈定的范围」；两者同时命中同一行时底色随播放档、竖条仍标出选区。
* **分区标签字重加粗**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：`Library` / `Unmanaged artifacts` / `Transcript` / `Suggested clips` / `Source` / `Clips` 六处小号大写分区标签由 `font-medium` 改为 `font-semibold`。

### 验证

* 本批**无测试改动**（`timeline.test.ts` 等保持 1474 例）；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（EXIT=0）。
* 打包以「构建新鲜度守卫」确认编译 / 组装期间无源文件改动；产物核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.707 (2026-10-12)

> 本版是 **v0.7.706 之后的小修 + 打点编辑补齐版**：① 修掉「更新后出现白色置顶小方块 / 白屏」—— 安装更新走 `app.exit(0)`，它**不触发** `before-quit`，而 `disposeButlerOrb()` 只写在 `before-quit` 里，于是退出时主窗 `closed` 又把球窗显示出来，而那一刻服务已被杀 ⇒ 球窗加载 `/butler-orb` 失败，在桌面上留下一块 **54×54 白色置顶小方块**；现在安装路径补上与 `before-quit` 同款的收尾（先 `disposeButlerOrb()`、再让主窗消失、最后才杀服务）。② 打点支持**直接改时刻**。③ 新增**「每个打点停一下」**播放开关。④ 新增**从片段 / 转写填充打点标签**。共 3 个文件改动（0 新增，0 测试改动）。

### 修复与优化

* **更新安装后出现白色置顶小方块 / 白屏**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts)）：安装路径的收尾顺序改为 `appQuitting = true` → `disposeButlerOrb()` → `mainWindow.hide()` → `killNextServer()` → 500ms 后 `app.exit(0)`。
  * **根因**：`before-quit`（同文件 2950-2954 行）里本来就有这段，注释原文写着「销毁 Butler 独立球窗：否则退出时主窗 closed → 又会把球窗显示出来」—— 这个缺陷早已被认识到并在**正常退出**路径上处理过；但安装路径走的是 `app.exit(0)`，它**不触发 `before-quit`**（2331 行注释也点明了这点），所以那个 `disposeButlerOrb()` 在安装时从未执行。`killNextServer()` 之所以没事，正是因为它在安装路径上被**显式补调**过，`disposeButlerOrb()` 漏了同一份待遇。
  * **实测证据**（主进程日志，UTC）：`13:07:25.188Z Next.js server exited: signal=SIGTERM` → `13:07:25.749Z [butler-orb] 独立球窗已创建（54×54，置顶 / 全桌面可见）` —— 服务被杀 **0.56 秒后**球窗才被创建，它去加载已经死掉的服务，于是渲染成白块；同时主窗仍在屏幕上等 `app.exit(0)`，渲染层所有 API 都取不到（渲染日志里 **139 次** `加载项目列表失败: TypeError: Failed to fetch`），表现为整片白。
  * **顺序约束**（已写进注释）：必须在 `hide()` **之前** `dispose` —— `hide` 会触发 `win.on('hide')` → `showOrbFree()`。
  * ⚠️ **这条修复只对「从 v0.7.707 起」的更新生效**：白方块是**旧版本**执行安装时产生的，因此从 0.7.706 升到 0.7.707 这一次仍会看到一次白方块，之后再更新就不会了。

### 新增功能

* **打点可直接改时刻**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：打点编辑器里新增 56px 宽的时刻输入框（`title="Mark time — mm:ss(.d) or seconds"`、`aria-label="Mark time"`），吃 `mm:ss(.d)` 或纯秒，失焦/回车提交（`applyMarkTime`）。名字框仍是 `autoFocus` 目标，并保留「焦点在编辑器内部搬家不提交」的守卫（否则点名字框会立刻提交时刻、把编辑器关掉，名字就改不了）。

* **「每个打点停一下」播放开关**（同上）：新增 `stopAtMarks`（默认关）。语义是三条收口 —— 只在**连续推进**时判定（`prev < markT ≤ abs` 且步长 < 2s）、必须正在播放、且不在「只播选区」（`playUntilRef` 为空）时；浮点噪声按 `1e-6` 容差排除。**拖动播放头 / 跳转不算**（一次会跨过好几个打点，那种情况不该「啪」地停住）。文案按状态给：`Stop at each mark` / 无打点时禁用并提示 `add a mark first` / 悬浮说明 `playback pauses on every mark` / 开启后 `Stopping at each mark (click to turn off)`。

* **从片段 / 转写填充打点标签**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：对**没有标签**的打点（`auto` 的不动），依次尝试 ① 该时刻导出过的**片段名**、② 覆盖该时刻的**转写段**（取不到则退到起点落在 `[t-0.2, t+6]` 内的最近一段），经 `markLabelFromText` 生成标签后整批 `applyMarks`；结果报 `Filled N mark label(s)`。一处都填不出来时给明确指引：`Nothing to fill from — transcribe this audio or export a clip at that mark first.`

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过（含 `electron/`）。
* 安装路径改动另做了打包级验证：tsup 打包 `electron/main.ts` 成功，并从产物里确认调用顺序为 `disposeButlerOrb() → hide() → killNextServer() → app.exit(0)`。

## v0.7.706 (2026-10-12)

> 本版是 **v0.7.705 之后的音频查看器版式版**：给画布音频查看器做一次分区（方案 A）—— 把**常驻**的播放器部分（波形 / 状态条 / 打点工具）收进一张带描边的卡片（`data-role="player-stage"`），转写区独立成 `data-role="transcript-section"` 并配一个小号大写 `Transcript` 标签，排在舞台之后、紧贴卡片下边缘（不另加分隔线，卡片描边就是那条边界）；同时把 `mm:ss` 格式化从组件下沉到 [timeline.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/timeline.ts)（`mmss()`），让播放器与查看器共用同一实现，并给播放键补上 `title` / `aria-label`。共 3 个文件改动（0 新增，0 测试改动）。

### 改进

* **音频查看器分区（方案 A）：播放器舞台卡片 + TRANSCRIPT 分区**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：播放器部分（`AudioMarkTrack` + 状态条 + 打点工具）包进 `flex flex-col gap-2 rounded-lg px-1.5 py-2` + `data-role="player-stage"` + `1px solid var(--line)` 描边的卡片；转写区改为 `flex flex-col gap-1` + `data-role="transcript-section"` + 小号大写 `Transcript` 标签（`px-2.5 text-11 font-medium uppercase tracking-wide`），排在舞台之后并紧贴卡片下边缘 —— 不再另加分隔线，卡片的描边就是那条边界。**位移口径不变**：卡片只包住**常驻**行（波形 / 状态条 / 打点工具）；后两类（选区 / 命名态 / 打点草稿）本来就是「出现 / 消失允许推动」的那批。
* **`mm:ss` 格式化下沉到 `timeline.ts`**（[timeline.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/timeline.ts) 新增 `mmss()`）：原先播放器与查看器各写一份，现在共用一处；`sec` 非有限数或为负时回 `--:--`（绝不显示 `NaN`）。`AudioViewer.tsx` 与 `AudioMarkTrack.tsx` 均改为从 timeline 引入。与 `mmss2()`（厘秒，只用于时间刻度与悬停投影标签）分工不变；组件内的 `mmssPrecise()`（可编辑输入框用）保留。
* **播放键补可访问性标签**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：`title` 按状态给出 `Pause` / `Play selection only (mm:ss–mm:ss) · Space` / `Play (Space)`，并补 `aria-label="Play or pause"`。

### 验证

* 本批**无测试改动**；全仓 `pnpm test` **126 文件 / 1474 例全绿**（与 v0.7.705 相同）；`tsc -p tsconfig.json` 通过。

## v0.7.705 (2026-10-12)

> 本版是 **v0.7.704 之后的小修版**，两条都是画布音频编辑器上「看得见却点不到 / 定位越界」这类手感缺陷：① 打点带缺一个 `z-index`，悬浮气泡被波形容器整个盖住 —— 点 ✕/✎ 实际落在波形上（还会把播放头跳走），用户根本删不掉打点；② 播放头定位（←/→ 的 ±3 秒、句柄 `seek`）新增纯函数 `clampSeekTime()`，把越界值挡在播放库之外（`NaN` 绝不交给库，否则整条播放轴坏掉）。共 3 个文件改动（0 新增；`timeline.test.ts` 21 → 24 例）。

### 修复与优化

* **打点删不掉：悬浮气泡被波形容器盖住**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：圆点外层那个 `-translate-x-1/2`（`transform`）会**创建层叠上下文**，于是气泡里的 `z-20` 只在那只小盒子里生效 —— 气泡虽然画在波形之上（覆在波形上），却被后面的兄弟 `[data-role="wave-wrap"]`（`z-index: auto` 的定位元素）整个盖住：`elementFromPoint` 命中的是波形容器，点 ✕/✎ 实际落到波形上（顺带把播放头跳走），表现就是用户问的「打点支持删除吗？」。现给打点带加 `relative z-30`（`data-role="mark-band"`），把它变成层叠上下文，整棵子树（圆点 + 气泡 + 名字）一起抬到波形之上。**⚠️ 刻意不加 `overflow-hidden`**：气泡必须能溢出到带外（它挂在圆点下方、覆在波形上）。同时按标签行数动态给带高（`data-lanes` + `calc(1.5rem + (lanes-1) × MARK_LABEL_LANE_PITCH_PX)`）。
* **播放头定位新增夹取纯函数**（[timeline.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/timeline.ts) 新增 `clampSeekTime()`；`AudioMarkTrack.tsx` 的定位路径改用它）：夹进 `[0, 总时长]`，**可以**走到 `total` 本身（与 `clampViewStart` 的 `[0, total − sec]` 语义不同）；总时长未知（波形未就绪，`0`/`NaN`）时**只保证非负** —— 不把「前进 3 秒」夹成 0（否则未就绪时按 → 会原地不动）；`t` 非法（`NaN`/`±Infinity`）恒回 `0`，**绝不把 `NaN` 交给播放库**（否则播放轴整条坏掉）。

### 新增单测

* [timeline.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/timeline.test.ts) **21 → 24 例（+3）**：新增 `describe('clampSeekTime（播放头定位夹取：←/→ 的 ±3 秒、句柄 seek）')` —— 常规夹取且可走到 `total` 本身 / 总时长未知时只保证非负（不把前进夹成 0）/ `NaN` 与 `±Infinity` 恒回 `0`。
* 全仓 `pnpm test` **126 文件 / 1474 例全绿**；`tsc -p tsconfig.json` 通过。

## v0.7.704 (2026-10-12)

> 本版修的是**普通用户装完 BobWork 用不了 Bob OCR**：Extensions Store 的 Bob OCR 卡片只会弹「Bob OCR plugin is offline or not configured. Start it with: bob-ocr-mcp --install-daemon」——识别能力在独立常驻桥（`bob-ocr-mcp --serve`，127.0.0.1:9478）里，而发布包**没有**随包分发它，那句终端命令对没装 node、不会 launchd 的用户等于死路。现在桥随包分发（`next-standalone/bob-ocr-mcp`），由宿主 [ocr-bridge.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/ocr-bridge.ts) 托管拉起：已有在线桥（用户自装 daemon / 另一宿主）**直接复用不抢进程**，未在线则用随包副本以 **Electron 内置 Node 运行时** `--serve`（用户机器不需要装 node）并注入端口/数据根；Bob OCR 同时进入 `SYSTEM_MCP_IDS` 出厂默认启用。共 17 个文件（新增 3）。

### 新增

- **宿主托管 Bob OCR 常驻桥**（[ocr-bridge.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/ocr-bridge.ts)，新增）：探测 `/setup/status` → 在线即复用；未在线则用随包副本 spawn `--serve`（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`，见新增的 [child-env.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/child-env.ts)）；就绪轮询（默认 8s、MCP 装配路径 3s，防拖慢首个请求）＋ 拉起冷却 15s ＋ 失败冷却 30s（秒退的桥不再让每次 OCR 调用白等一轮）＋ 并发合流；子进程日志落 `<数据根>/host-bridge.log`；`exit` 收尾 + `SIGINT/SIGTERM` 收尾后**重发信号交回默认语义**（不吞掉 SIGTERM、不改宿主既有退出时序），且只 kill 自己拉起的子进程，不碰用户自装 daemon。
- **随包分发 bob-ocr-mcp**（[package-release.sh](file:///Users/baolei/Desktop/BobWork/projects/scripts/package-release.sh)）：tsc + esbuild 构建 → 复制 `dist/` + `assets/` + `package.json` → `npm install --omit=dev`（`pdf-parse` / `@modelcontextprotocol/sdk` / `openai` 是 external，必须自带 node_modules）→ **安装后校验依赖真的落地**（npm 缓存权限异常会让 install 静默失败，缺 node_modules 的随包副本在用户机器上直接 MODULE_NOT_FOUND）。
- **首启自动导入识别配置**（bob-ocr-mcp `--import-if-empty`，[cli.ts](file:///Users/baolei/Desktop/BobWork/bob-ocr-mcp/src/cli.ts)）：桥自身 vision / OCR 两模块**全空**时，从 BobWork `.settings.json` 导入一次模型与 Key（已有任一配置则跳过，绝不覆盖）；有 Xcode CLT 的机器本地 Vision 直接可用，没装的机器走导入来的线上引擎。
- `--serve [port]` 端口参数真正生效（等价 `BOB_OCR_MCP_PORT`），文档与实现对齐。

### 修复与优化

- **Bob OCR 出厂默认启用**（[types.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/types.ts) `SYSTEM_MCP_IDS` + [registry.json](file:///Users/baolei/Desktop/BobWork/projects/assets/mcp/registry.json) `group: download → bundled`）：既有用户升级后由 settings 读取路径自动补齐缺失的系统插件条目（不覆盖已有配置），市场卡片从「需自行安装 daemon」变成系统内置（Installed · Plugins，带 Configure）。
- **失败原因可诊断**（[ocr-client.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/ocr-client.ts) `getOcrSetupStatus` + [McpStorePanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/McpStorePanel.tsx)）：离线时返回宿主侧原因（条目被禁用 / 随包入口缺失 / 进程退出码 / 端口被占 / 日志路径），不再只丢一句终端命令。
- **MCP 装配先确保桥在线**（[manager.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/manager.ts) `syncServers`）：桥刚拉起时强制刷新一次 token 探测，避免首个 sync 拿占位 token 连接 401；托管失败只记日志、不阻塞主流程。
- **OCR 不可用文案统一**（[ocr-service.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/pdf/core/ocr-service.ts) / [attachment.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/attachment.ts) / [capture.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/screen-ocr/capture.ts)）：改为「确认 Bob OCR 已启用 + 查看 host-bridge.log」，不再引导 `--install-daemon`。
- 数据根登记（[bundled-data-home.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/extensions/bundled-data-home.ts)）：`bob-ocr-mcp → BOB_OCR_MCP_HOME`，与用户自装 daemon 的既有数据（`~/BobWork/extensions/bob-ocr-mcp`）无缝复用。

### 同批：音频编辑器收尾与用户指南

- **打点标签多行排布，避免「后打的点把先打的名字顶掉」**（[AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：新增全高覆盖层（`pointer-events-none absolute inset-x-0 top-0 z-20 h-full`）承载打点标签；同一行放不下的名字由判定 effect **换到下一行**（`labelLanes`，最多 `MARK_LABEL_MAX_LANES` 行 —— 第 0 行在带内、其余覆在波形顶部），只有超出行数上限的才由 `hiddenLabels` 只藏视觉（`MARK_LABEL_MIN_GAP_PX`）；被藏的点仍有圆点 + 悬浮气泡（气泡含 ✎/✕），功能不丢。
- **自动打点默认不显名字**（同上，P2-4）：AI 一次能生成 30+ 个点，全显名字时打点带会被占满、碰撞逻辑只能靠「藏」，结果是「谁的名字都看不全」；现在只有**正在编辑**的那个自动点例外，手打点（用户真正反复看的锚点）照常显示，自动点的名字仍可悬浮圆点得到。
- **厘秒时间输入与读数**（同上）：新增 `mmssPrecise()`（`mm:ss.d`）与配套解析（接受 `mm:ss(.d)` / `hh:mm:ss` / 纯秒，非法输入回退原值）；选区起止输入框与跨度读数（`x.x s`）改用它。
- **吸附规则只写一份**（[mark-ops.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/mark-ops.ts)）：`snapToMark` 改为**转发到** `snapToRefs`（marks-only），把「打点优先 / 边界含容差」的规则收敛到一处（两处各写一遍必然漂移）；[mark-ops.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/mark-ops.test.ts) 同步。
- **用户指南补一句**（[SKILL.md](file:///Users/baolei/Desktop/BobWork/projects/assets/skills/user-guide/SKILL.md)，+2 行）：Bob OCR（图片 / 扫描件转文字）随 BobWork 内置，**不需要单独安装** —— 设置 → Extensions Store → Plugins → Bob OCR 保持启用即可，本地常驻桥由应用自动拉起，首次启动会自动从已有配置导入视觉 / OCR 模型；要换视觉模型或 OCR 引擎，点卡片上的 **Configure** 维护。

### 验证

- 新增 [ocr-bridge.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/ocr-bridge.test.ts)（6 例）：在线探测 / 离线 / HTTP 503 判定；**已有在线桥必须复用且不抢进程**（假桥仍在服务）；无在线桥时用随包副本拉起→`/setup/status` 就绪→`stopOcrBridge()` 后确实下线（不留孤儿进程）；端口被占导致子进程秒退时**及时识别退出**（不白等满就绪超时，实测由 6.1s 降到 <0.6s）并进入失败冷却，第二次调用不再重复 spawn（<1s 返回）。
- **打包布局实跑**（临时数据根 + 临时端口）：按打包脚本复制 `dist/`+`assets/`+`package.json` 并安装依赖 → `dist/cli.js --serve --import-if-empty` 启动 → `/setup/status` 在线 → `ocr.diagnose` 四个脚本全部命中（assets 与 dist 同级）→ `ocr.recognize` 真识别成功（`method=vision-ocr`，1.2s）→ 空配置下从假 `.settings.json` 导入 `vision, glmOcr, providers(1)` 且 `configImported=true`（第二次启动跳过导入）。
- **真桥复用**：本机 9478 已有 launchd daemon 时 `getOcrSetupStatus()` 返回 `{ mcpOnline: true, settingsUrl: …9478/settings?token=… }`，且未另起进程。
- **退出时序未被改变**（实跑）：宿主进程收到 SIGTERM 后 **0.15s** 退出（信号处理收尾子进程后重发信号，交回默认动作 —— 不会吞掉 SIGTERM 触发 Electron 的 800ms SIGKILL 兜底），且桥子进程随之退出、端口释放（无孤儿）。
- `tsc -p tsconfig.json --noEmit` → EXIT=0；`vitest run` → 126 文件 / 1471 例全部通过。

## v0.7.703 (2026-10-12)

> 本版是 **自动更新「安装 → 替换 → 重启」链路的加固**：修复旧实例在升级时**不退出**、从而一直占着单实例锁把新版本挡在门外的问题 —— 用户现场表现为「更新后还是打不开新版 / 无法升级」，以及「右键 Dock Quit 没反应、⌘Q 退不掉」。安装脚本改为 **SIGKILL + 轮询确认旧进程真的消失** 之后再替换 app；退出流程在杀 Next.js 服务前先置 `appQuitting`，防看门狗复活服务；启动失败错误页的日志路径改为运行时动态拼接。仅 [main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts) 一处改动（3 处编辑）。

### 修复与优化

- **安装脚本先 SIGKILL 再确认进程退出**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts#L2301-L2310)）：原脚本只发一次 `pkill`（SIGTERM）就 `rm -rf` + `ditto` 替换 app。旧主进程若不退，macOS 的 `open` 只会「激活」这个仍在运行的旧实例，新版被 `requestSingleInstanceLock` 挡下（日志 `Another BobWork instance is already running — quitting this instance`），用户表现为「升级后仍是旧版」。改为 `pkill -9`，并在替换 app 前用 `for` 轮询（最多 10s）确认旧主进程真的消失再 `rm/ditto/open`。（用户现场实测：v0.7.700 实例运行 3 小时未退出，两次安装均未生效。）
- **退出前先置 `appQuitting`**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts#L2330-L2336)）：`update:install` 在 `killNextServer()` 之前置 `appQuitting = true`，防止 `server-watchdog` 在退出过程中把刚被杀掉的 Next.js 服务又拉起来（实测日志：`[server-watchdog] …restarting Next.js server…` → `Next.js server up in 883ms`）。
- **错误页日志路径动态化**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts#L2924)）：启动失败页原先写死 `~/Library/Logs/BobWork/bob-work.log`，实际日志（`app.getPath('logs')`，取自打包后 `app/package.json` 的 `name`）位于 `~/Library/Logs/bob-desktop-runtime/bob-work.log`，用户照错误页找不到文件。改为运行时 `${app.getPath('logs')}/bob-work.log`。

### 验证

- 仅 [main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts) 一处改动（3 处编辑），无新增单测。
- 执行验证：`tsc --noEmit -p tsconfig.json` → EXIT=0；安装脚本片段 `bash -n` → 语法通过。
- 打包时以「构建新鲜度守卫」确保编译 / 组装期间无源文件改动；产物内核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.702 (2026-10-12)

> 本版是 **Markdown 批注 / 修订工作流的一轮打磨 + 用户说明书更新**：修订面板文案英文化，并把「待处理」条数改为按**逻辑条数**计（一次替换的 `delete + insert` 合并为 1 条）；修订卡片点击定位改用**渲染态纯文本指纹**、就地应用后**跳过整篇重建**（不再重置选区 / 视口）并把视口停回改动处；Settings 空间站布局扩容（Command Core 加宽、新增 Buzan / Archivist 乘员与 Meeting Deck / Media Bay 舱段）；用户说明书同步到新版 Butler 抽屉与音频 / 会议 / AI 修图等新能力。共 4 个文件。

### 修复与优化

- **修订面板文案英文化**（[MdAnnotationPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/MdAnnotationPanel.tsx)）：修订意图标签与按钮 / 提示统一为英文（Auto / Polish / Shorten / Expand / Translate / Fix facts / Format / Custom；Annotations / Revisions；Accept all / Reject all / Locate / Before / After…），与项目「界面文案一律英文」的口径一致。
- **「待处理」条数按逻辑条数计**（[MdAnnotationPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/MdAnnotationPanel.tsx#L201-L213)）：新增 `changeCount` / `pendingChangeCount`，把**相邻的 `delete + insert`（同一次替换）合并为 1 条**，避免一次改写被计成 2；修订 tab 徽章与每轮「N pending」均改用它，计数不再虚高。
- **修订卡片定位改用渲染态纯文本指纹**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx#L411-L422)）：`patch` 新增 `plainOld` / `plainNew`（改动前 / 后的**渲染态纯文本**指纹）。原实现拿 `oldText/newText`（markdown 源码，含 `##` / `**` / 表格语法）到渲染纯文本里 `indexOf`，含语法的改动**匹配不到** → 点击卡片定位失败；现优先用纯文本指纹，源码文本作兜底。
- **就地应用后跳过整篇重建**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx#L1046-L1051)）：新增 `skipRebuildRoundRef`（刚就地应用的那一轮内容已是文档现值 → 激活时跳过整篇重建，避免重建重置选区 / 视口）与 `justAppliedPosRef`（以改动起点文档坐标为滚动锚点，不依赖文本匹配），`addPatchRound` 相应新增 `appliedFrom / plainOld / plainNew` 参数。
- **Settings 空间站布局扩容**（[SettingsModal.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SettingsModal.tsx#L2201-L2245)）：画布 920 → 1100 宽、Command Core 舱段随之加宽（`x:66/w:788` → `x:30/w:1040`），乘员间距 150 → 180；新增乘员 **Buzan**、**Archivist**，新增舱段 **Meeting Deck**、**Media Bay**，既有舱段重排为更宽的网格。
- **用户说明书更新**（[SKILL.md](file:///Users/baolei/Desktop/BobWork/projects/assets/skills/user-guide/SKILL.md)）：`BobMail 通知中心` 章节改写为 `Butler 抽屉（通知中心 / 助理）`（含微信式布局、已读与角标、Today 日报、Memories 记忆台、Calendar / Meeting、报告类回执、自动送达的通知）；新增「音频查看器与音频编辑器（Audio Editor）」「视频截图工具（bob-video-shot 插件）」「会议记录（Meeting）」「图像 AI 编辑（AI 修图）」四章；FAQ 补充 BobMail 去向、消息 / 会话删除、Today 面板、Templates、音频打点截取、视频多图、会议记录回放、AI 修图、微信 / 飞书绑定、邮箱感知、手机远程等条目。

### 验证

- 本轮为 UI 文案 / 交互定位打磨与文档更新，无新增单测。
- 执行验证：`tsc --noEmit -p tsconfig.json` → EXIT=0；`vitest run` → 全量通过。
- 打包时以「构建新鲜度守卫」确保编译 / 组装期间无源文件改动；产物内核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.701 (2026-10-12)

> 本版是 **Next.js 服务启动的运行时修复**：服务进程不再依赖用户机器上系统 `PATH` 里的 `node`，改用 **Electron 自带的 Node 运行时**（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`）启动。修复其他用户安装后应用起不来、报 `Next.js server failed to start after 2 attempts (last exit code=null, signal=SIGSEGV)` 的问题。仅 [main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts) 一处改动。

### 修复与优化

- **服务进程改用 Electron 内置 Node 运行时**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts#L236-L258)）：原实现 `spawn('node', ['--max-old-space-size=1024', serverPath], …)` 会在用户机器上按 `PATH` 找系统 `node` —— 用户可能根本没装 node、或装的是 x64 / 版本不符的 node。安装包内只随包分发**一份 arm64** 的原生模块（`better-sqlite3` 的 `prebuilds/darwin-arm64.node`、`@img/sharp-darwin-arm64` 等），用架构/ABI 不匹配的外部 node 加载时会直接崩溃（用户现场实测 `signal=SIGSEGV`，进程还没进入 Node 事件循环就被杀）。现改为 `spawn(process.execPath, ['--max-old-space-size=1024', serverPath], { env: { …, ELECTRON_RUN_AS_NODE: '1' } })`：Electron 主可执行文件以「Node 模式」运行服务入口，其内置运行时与随包发布的原生模块架构 / ABI **必然一致**，从根上消除 「用户 node 环境」 这一外部变量。
- **新增一行运行时可诊断日志**：`Next.js server runtime: <path> (Electron as node)`，服务启动日志中可一眼确认实际使用的运行时，便于后续排障。
- `--max-old-space-size=1024` 堆上限与既有 jetsam 防护保持不变（历史崩溃：长时间运行后 Footprint 膨胀到 1.49GB+ 触发 macOS jetsam 杀进程）。

### 验证

- 仅一处 `spawn` 目标与一处 `env` 注入 + 一行日志，无新增单测。
- 执行验证：`tsc --noEmit -p tsconfig.json` → EXIT=0；`vitest run` → 全量通过。
- 打包时以「构建新鲜度守卫」确保编译/组装期间无源文件改动；产物内核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.700 (2026-10-12)

> 本版是 **v0.7.699 之后的一处左栏入口收敛**：把 Video Shot（`bob-video-shot-mcp`）从左侧导航的插件快捷工具条中移除。它的网页入口已由 MCP 市场的「Open in Hippo」承载（宿主反代 `/api/plugin-web/<id>` + Hippo 书签），侧边栏再挂一条只是同一页面的第二个入口。插件本身仍在注册表内、`panel` 声明保留，经市场 / 预览面板打开的运行路径逐字不变。仅 1 个文件改动。

### 修复与优化

- **左栏插件工具条不再重复展示 Video Shot**（[CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx)）：`pluginQuickTools` 的过滤条件在原有的 `bob-notes-mcp` 之外再排除 `bob-video-shot-mcp`（`pluginPanels.filter(p => p.pluginId !== 'bob-notes-mcp' && p.pluginId !== 'bob-video-shot-mcp')`）。二者不进侧边栏的原因不同 —— `bob-notes` 经侧栏 `Bob Notes` 打开；`bob-video-shot` 的网页入口由 MCP 市场「Open in Hippo」承载（宿主反代 + Hippo 书签），侧边栏再放一条只是同一页面的第二个入口。该过滤只作用于**侧栏快捷入口**这一条渲染路径，`pluginPanels` 注册表、预览面板标签页、Hippo 反代入口均不受影响（插件未从 `MCP_PRESETS` / `registry.json` 中删除，仍是默认 `enabled:false` 的可选项）。

### 验证

- 本轮为纯 UI 接线（一处过滤条件 + 注释），无新增单测。
- 执行验证：`tsc --noEmit -p tsconfig.json` → EXIT=0；`vitest run` → 125 文件 / 1457 例全部通过。
- 打包时以「构建新鲜度守卫」确保编译/组装期间无源文件改动；产物内核对 `Info.plist` 版本号与 `latest-mac.yml` 的 sha512 / size 一致后放行上传。

## v0.7.699 (2026-10-12)

> 本版是「左栏音频编辑器入口」版：在 v0.7.698 的波形时间轴与音频库之上，把画布音频编辑器**从「必须先在文件里打开一个音频」解放出来** —— 左侧导航 Bob-Mind 之下新增 `Audio Editor` 入口，点开即在右侧预览面板得到一个**空态**音频编辑器，导入本地音频或从应用音频库选一条即可开始编辑（波形 / 打点 / 截取 / 转写）。实现上不新造载体：预览面板新增一种**非文件型单例标签**（对齐既有 Templates 单例），空态直接复用查看器自身已具备的 `Import` / `Library` 分支，仅补一条「无源音频」守卫，避免旧实现在空路径下的永久转圈与误报失败。

### 新增功能

- **左栏 `Audio Editor` 入口**。真源是左栏快捷工具清单 `quickTools`（展开态与折叠窄栏共用同一份），入口被显式插在 **Bob-Mind 条目之后**（而非整个插件列表末尾）—— Bob-Mind 之后可能还有别的插件，追加到末尾会让本入口离它越来越远，与「Bob-Mind 下方」不符。见 [CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx) 的 `AUDIO_QUICK_TOOL` / `pluginQuickTools` / `mindIdx`，点击派发 `open-audio-editor` 事件。
- **预览面板新增非文件型单例标签 `type:'audio'`**。面板标签联合类型扩展 `'audio'`，标签栏置顶组加入 `Audio Editor`；挂载策略与 Templates / 插件面板同款（**惰性挂载 + `display` 显隐切换**），切走标签不卸载、已导入的音频与打点不丢；关闭走 `closeAudioTab`（切回最后一个文件/会话标签，无则收起面板）。
- **空态音频编辑器**。以**无 `full_path` 的占位 FileInfo** 复用画布音频查看器（`source: 'local'`），落其自身空态：`Import audio`（复制进应用音频库 `<APP_ROOT>/.audio-library/` 并立即载入编辑）与 `Library`（库内音频浏览 / 载入）。**音频与产物一律不落 workspace 的 materials / homework**，与既有口径一致。
- **查看器惰性加载**。单例标签里的 `AudioViewer` 走 `React.lazy` + `Suspense` 动态 import，WaveSurfer 依赖**不进画布主包**（与 `viewerRegistry` 同一策略）。

### 修复与优化

- **空路径不再永久转圈 / 误报失败**。加载 effect 顶部补守卫 `if (!key) { setPlayUrl(''); setPrecomputed(null); setLoading(false); return; }`。旧实现在 `target.path === ''` 时会先把 `loading` 置真，随后异步分支要么在「等代理就绪」处**直接早退而不落 `loading=false`**（界面永远停在 `Loading audio…`），要么拿空路径去请求而抛错、误报 `Playback failed` —— 空态因此根本渲染不到。见 [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)。
- **空态文案分流**。`!playUrl` 分支按 `target.path` 分流：无源音频时标题显示 `Audio Editor` + 引导语（「Import an audio file, or pick one from your library, to start editing.」），不再显示占位名与 `0 B`；**两行结构与失败态严格一致 ⇒ 切换时高度不漂**。有文件但加载失败的旧行为（文件名 + 大小 + `Open with default program`）不变。
- **传入查看器的 `onError` 必须是模块级常量**（`IGNORE_AUDIO_VIEWER_ERROR`），不得写成内联箭头：该回调在加载 effect 的依赖数组里（`AudioViewer.tsx` 加载 effect 末尾），内联箭头每次渲染换身份 ⇒ 父级任何一次重渲染都会重跑该 effect，而 effect 顶部会 `setMarks([])` / `setNote(null)` ⇒ **打点与状态条被反复清空**。

### 新增与增补的单测

- **本轮无新增单测**，原因如实说明：改动为纯 UI 接线（一处入口清单 + 一种单例标签 + 一条空态守卫 + 一句文案分流），而仓库现有测试**全部是无 DOM 的纯函数用例**（`src/**/*.test.ts`，无任何 `.test.tsx`）。为一条三元判断引入 jsdom / testing-library 测试栈不划算，故不新造基础设施。
- **本轮实际执行的验证**（可回溯）：① `tsc -p tsconfig.typecheck.json` → **EXIT=0**，日志 0 字节；② 以**临时故意类型错误**做负对照（`EXIT=2` + `error TS2322`，探针用后即删）⇒ 确认该判据**非平凡**；③ 构建产物内 grep 新代码独有串 `open-audio-editor`，**命中后才放行打包与部署**（未命中即中止，避免再产出「源码改了但包里没变」的包）。

## v0.7.698 (2026-10-11)

> 本版是「音频时间轴缩放 + 插件自带网页反代 + Daily News 权威站」版：在 v0.7.697 的窗口化转写与断点续跑之上，把画布音频编辑器的波形从「整段一屏」升级为**可缩放/可平移的时间轴**（新增 peaks v2 细分辨率 + 按窗口取切片，刻度细化到厘秒），为 MCP 插件自带的网页面板补上一条**稳定反代**（`/api/plugin-web/<id>`，解决 Hippo 书签端口漂移），并让 Daily News 支持按主题配置**权威站域名**（RSS → 定向站点检索 → 裸关键词的三级采集降级）。共 30 个文件改动（6 新增：源码 + 测试；其余为修改），测试净增 +79 例。

### 新增功能

- **波形时间轴缩放与平移**。此前画布音频查看器只能「整段塞进一屏」：长录音缩成一团、秒级细节根本看不清，且引用了 peaks 后 WaveSurfer 的缩放能力并未被启用。本轮把真源放回库自身（`zoom(minPxPerSec)` + `setScroll/getScroll`），组件只用一条几何式 `pxOf(t) = t × minPxPerSec − scroll` 把绝对秒映射到像素，覆盖层（打点、选区、刻度、悬停线）全部复用同一坐标，彻底避免「整段坐标系 vs 窗口坐标系打架」（实测坑：按下 50% 曾落到 16.98%，拖选得到「整段 20–60% + 窗口偏移」）。交互上支持滚轮以指针为锚点缩放、`+`/`−` 按钮按中心缩放、`◂`/`▸` 半窗平移、`⤢` 缩放到选区、点窗口时长按钮一键 `fitAll`、`✛` 跟随播放头；小文件（非 peaks 路径）不显示这簇控件。实现见 [AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)（`zoomAt` / `panBy` / `zoomToSelection` / `fitAll` / `visibleWindow`）。
- **peaks v2：细分辨率峰值编码**。粗桶（2000 点）放大后全是马赛克，故新增 20ms 分辨率（50Hz）的 `fine` 通道。为控体积，微桶以 int8（-127..127）+ base64 量化，误差 ≤ 1/127；另有 10ms「微桶」两两合并取 abs-max 保号的降采样。编解码纯函数落在新增的 [peaks-codec.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/peaks-codec.ts)（`FINE_HZ=50`、`MICRO_SAMPLES_10MS=80`、`encodeFine`/`decodeFine`、`mergeMicrosPairs`、`sliceFineWindow`）。
- **按窗口取峰值切片**。整段细分辨率点数太多（传不动），改为按可见窗口请求。`peaks` 路由新增 `action: 'peaks_window'`，返回窗口内 `sliceFineWindow` 的结果，请求点数上限从 4000 放宽到 **200000**；查看器侧 [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) 的 `requestWindowPeaks` 只声明「我需要窗口峰值」，API 口径（source/path）留在组件层，取不到即返回 null 让本次缩放降级、保持旧波形。版本升级见 [peaks.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/peaks.ts)（`PEAKS_VERSION` 1→2，保留 `PEAKS_VERSION_COARSE_ONLY=1` 兼容旧缓存，新增 `ensureFinePeaks()` 在 v1 缓存或缺 fine 时重生成补齐）。
- **插件自带网页反代（`/api/plugin-web/<id>`）**。插件（如 Video Shot）自带的网页面板此前要用「运行时端口」直连，而端口会漂移，Hippo 里存的书签随之失效。本轮在原生 HTTP 层 [server.ts](file:///Users/baolei/Desktop/BobWork/projects/src/server.ts) 挂载反代中间件，把 `/api/plugin-web/<id>/**` 逐字透传到插件运行时端口：大 body 用 `req.pipe` 双向流、SSE 用 `flushHeaders` 逐帧下发，跨包不变量「`hostPath` 必须逐字等于前缀 + id」由 `isDeclaredPluginWebPanel` 校验。核心在新增的 [plugin-web-proxy.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/http/plugin-web-proxy.ts)（`PLUGIN_WEB_PREFIX`、`HOP_BY_HOP` 过滤、`pluginNotRunningHtml` 503 空态页、`handlePluginWebProxy`），插件「是否在跑」由新增的 [plugin-web.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/plugin-web.ts) 的 `resolvePluginWebPanel()` 用 `getPanelPort` 有无判定。
- **市场条目「Open in Hippo」与 Video Shot 插件**。[MCP_PRESETS](file:///Users/baolei/Desktop/BobWork/projects/src/lib/mcp/types.ts) 新增 `bob-video-shot-mcp`（`{BUNDLED}:.../cli.js --serve`，panel 端口 9484，`hostPath: /api/plugin-web/bob-video-shot-mcp`，默认 `enabled:false`），`PluginPanelDecl` 增加 `hostPath?`；市场清单 [registry.json](file:///Users/baolei/Desktop/BobWork/projects/assets/mcp/registry.json) 补登该条目（group `download`）；[store/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/mcp/store/route.ts) 的 GET 从预置**派生** `hostPath`（不写进 registry.json，避免两处漂移）；[McpStorePanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/McpStorePanel.tsx) 的 Installed 卡据此渲染「Open in Hippo」按钮——先 `bmList` 查重再 `bmToggle` 加书签（`bm-toggle` 是**切换**语义，不查重会误删已有书签），随后在 Hippo 新标签打开该地址。桌面适配层 [desktop-adapter.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/desktop-adapter.ts) 相应补出 `hippoBrowser.bmList()` / `bmToggle(payload)`；[bundled-data-home.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/extensions/bundled-data-home.ts) 登记该插件的数据根注入。
- **Daily News 权威站（三级采集降级）**。[news/types.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/types.ts) 给 `NewsTopic` 增加 `sites?: string[]`，并提供内置的 `CURATED_TOPIC_SITES`（tech/finance/legal 各数条权威域名）、`sitesForTopic()`、`TOPIC_SOURCE_MAX=6`、`normalizeSites()`（剥协议/路径/`www.` 成裸域名）。[news/generate.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/generate.ts) 的采集改为**三级降级**：`feeds`（RSS）有结果即返回 → 否则对 `sites` 逐站做 `site:<domain> <query>` 定向检索（`SITE_SEARCH_CONCURRENCY=3` 并发、`interleaveHits` 交错合并）→ 再兜到裸关键词 `searchLocalProviders`。用户可在 Butler 的 Today 面板按主题编辑这三项（见下条修复）。
- **音频库「未管理产物」入口**。当音频在库外被编辑时，会在影子目录（`.audio-library/<源名>-<路径指纹>`）留下转写/片段产物，此前界面上无从清理。新增 [library.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.ts) 的 `ShadowEntry`、`SOURCE_REF_NAME='.source-ref.json'`、`rememberSourceRef()`、`listShadowDirs()`、`deleteShadowDir()`（两条护栏：路径须在库根内、不得删正式条目），并在 `sourceDir(srcAbs, true)` 时写来源 ref。路由新增 `list_shadows` / `delete_shadow`，[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) 在库面板底部列出这些产物，逐条标注源是否仍在（`source present` / `source gone` / `unknown`），删除前二次确认且明示「绝不动你的音频文件」。

### 修复与优化

- **厘秒刻度进位越界**。时间刻度从 `mm:ss` 细化到 `mm:ss.cc`（秒后两位）后，用 `toFixed(2)` 在 `59.995` 这类值上会进位成非法的 `00:60.00`。新增 [timeline.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/timeline.ts) 的 `mmss2()`：先 `Math.round(s*100)` 再拆分秒/厘秒，保证合法；同文件下沉了刻度纯函数（`TICK_STEPS`、`tickStops`、`tickStopsForWindow`、`tickLabelRightAligned`、`VIEW_MIN_SEC=2`、`clampViewStart`）。
- **刻度标签过密/溢出**。标签从 `mm:ss`（5 字符）变成 `mm:ss.cc`（8 字符）后，原先 6–12 个标签会糊成一团、且靠右的标签会伸出面板被裁。故标签个数目标下调到 4–6（`TICK_MAX_LABELS`），并**按容器宽度反推**（`tickLabelsForWidth`，272px 面板→3、420px→6，极窄保底 2）；右缘标签自动右对齐防溢出。刻度宽度还做了**实测回灌**（`tickLabelPx` 用 `ResizeObserver`/字号档变化后实测），避免估算偏小。
- **打点磁吸新增「播放头」参照**。原吸附只在打点与刻度间选，用户直觉常是「从播放头所在的那一刻拉」。`SnapKind` 增加 `'playhead'`，`SnapRefsOptions` 增加 `playhead`，`snapToRefs` 优先级定为 **打点 > 播放头 > 刻度**（含 1e-9 浮点容差），见 [mark-ops.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/mark-ops.ts)。
- **拖拽选区锚定端**。选区插件按指针裸坐标 + 3px 阈值算边界，导致「起点最多偏几个像素」。新增 `anchorSelectionEdge(sel, anchor, minSpan)`：按下时把**吸附结果**记作固定锚点，拖拽过程中该端不动、另一端跟手；含幂等守卫避免重复写入。AudioMarkTrack 侧配套 `pressAnchorRef` 与「用户定位序号」`seekSeqRef`——切窗 `load()` 会复位播放头，恢复动作必须比对序号，若期间用户已重新定位就放弃恢复（实测坑：缩放后按下落点被拉回旧位置差 67s）。
- **波形柱对比度不足**。波形柱原先复用 `--line-soft`，实测对比度仅 1.83:1，低于 3:1 的可读下限。新增专用色 `--wave-bar`（`color-mix(in oklab, var(--ink) 55%, transparent)`）；同时新增 `.thumb-scroll` 纯滑块滚动条（轨道/按钮/角落全透明），见 [globals.css](file:///Users/baolei/Desktop/BobWork/projects/src/app/globals.css)。
- **转写面板默认折叠 + 半截稿明示**。[TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx) 改为 `defaultOpen=false`——窄面板（最小 272px）下自动展开会把片段清单挤出首屏；折叠态只留一行 `▸ Transcript (N)`。跟随播放改为手算 `scrollTop` 只滚本面板内部列表（`scrollIntoView` 会连带滚动祖先，而画布面板壳是 `overflow:hidden`，会把内容顶走）。抬头额外显式标注 `partial coveredUntilSec/durationSec min`：长音频走窗口化转写，半截稿是常态中间态，不明说会让用户把这半份当完整稿。区间终点 `clampEnd` 钳到 `transcript.durationSec`——ffprobe 与播放器对同一文件时长读数差几十毫秒，不钳则「截最后一句」可能被服务端越界判据拒掉。
- **Butler Today 面板按主题编辑源**。[ButlerTodayPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerTodayPanel.tsx) 的主题 chip 改为可点，点开就地展开「源编辑」面板：`Query` 单行输入、`RSS sources` 与 `Authoritative sites` 两组标签（回车新增、`×` 移除）。前端只做「非空 + 去重 + 条数封顶（`TOPIC_SOURCE_MAX`）」三道显式校验，**格式归一化交给后端**（`normalizeFeeds`/`normalizeSites` 剥协议/路径/`www.`），保存后 `setNewsConfig(d.config)` 把归一化结果回填，前端随即与后端对齐。清空源后仍落空数组——后端归一化时摘掉该键，语义即「回到内置默认源」。
- **多文件并行编辑一致性**（工程侧）：本批对同文件的相邻改动严格串行落盘，避免基于旧快照互相覆盖（历史教训：`mcp-server.ts` 的 import 行曾被并行编辑覆盖）。

### 新增与增补的单测

- **[timeline.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/timeline.test.ts)**（新增）：`mmss2` 厘秒进位/边界、`tickStops` 步长选择、`tickStopsForWindow` 防漂移、`tickLabelsForWidth` 宽度反推、`tickLabelRightAligned` 右缘判定 —— **21 例**（新增）。
- **[peaks-codec.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/peaks-codec.test.ts)**（新增）：`encodeFine`/`decodeFine` 往返误差 ≤ 1/127、`mergeMicrosPairs` 保号、`sliceFineWindow` 越界夹取 —— **14 例**（新增）。
- **[plugin-web-proxy.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/http/plugin-web-proxy.test.ts)**（新增）：逐字透传含前缀、SSE 逐帧到达（含缓冲版负对照）、2MB body 流式、插件未运行时 503 空态、非面板路径放行、上游 502 透传 —— **16 例**（新增）。
- **[news/generate.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/generate.test.ts)**（新增）：用 `vi.mock` 覆盖三级采集降级的先后与负对照 —— **4 例**（新增）。
- **[mark-ops.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/mark-ops.test.ts)**：**34 → 45 例，+11**（新增播放头吸附优先级、`anchorSelectionEdge` 锚定与幂等）。
- **[library.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.test.ts)**：**37 → 43 例，+6**（影子目录列举、来源 ref 读写、删除护栏）。
- **[news/types.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/types.test.ts)**：**9 → 16 例，+7**（新增「topic sites（权威站）」describe：`normalizeSites`、`sitesForTopic`、空值不落键）。
- 其余：`peaks.integration.test.ts` 维持 1 例（无变化）。

测试净增合计 **+79 例**（新增文件 21+14+16+4=55；既有文件 +11+6+7=24）。

## v0.7.697 (2026-10-11)

> 本版是 **v0.7.696 之后的「长录音也能整段转写」版**：v0.7.696 把「听得懂」接进了画布音频编辑器，但只覆盖 ≤30 分钟、或「只转选区」——整段超 30 分钟的录音会被 `parseAudio` 直接拒绝（`MAX_DURATION_SEC = 30*60`），界面上等于「这段音频转不了」。本版补上这条缺口：新增 [windowed.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/windowed.ts)（纯逻辑 + 注入式调用，可单测），把整段按默认 20 分钟切成**无缝无重叠**的窗口逐窗跑；把 `AudioTranscript` 扩成可承载**中间态**（`partial` + `coveredUntilSec`），`transcribe` action 每完成一窗就**增量写 sidecar**，请求被平台掐断也能从断点续跑（已转窗口命中 parse 层内容哈希缓存，**不重复付费**）；并把「某一窗没语音」类型化为 `NoSpeechError` 后由窗口化路径吞掉继续下一窗（长录音里整段静音是常态，否则会在同一静音窗上永远卡住）。用户实际那一例 3401s（57 分钟）⇒ 3 窗。顺带把波形吸附统一成 `snapToRefs`（打点 + 刻度格线，打点优先），并修掉 `parseProjectRoot()` 兜底写死 `~/BobWork` 导致隔离 dev 把缓存写进真实根的 EPERM 事故。共 12 个文件改动（2 新增：1 源码 + 1 测试；10 修改：8 源码 + 2 测试），测试净增 **+26 例**。

### 新增功能

* **长音频窗口化转写骨架**（新增 [windowed.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/windowed.ts)，149 行）：纯逻辑、注入式（无 `node:fs` / 无 ffmpeg / 无网络 ⇒ 可单测）。常量 `DEFAULT_WINDOW_SEC = 20*60`（对上 parse 层 30 分钟上限留 10 分钟余量）、`MIN_WINDOW_SEC = 60`、`MAX_WINDOW_SEC = 25*60`（刻意留 5 分钟余量）、`TAIL_MERGE_SEC = 2*60`。
  * `clampWindowSec(sec)`：夹到 `[MIN, MAX]`，非法输入取默认。
  * `planWindows(durationSec, windowSec?, startSec = 0)`：把 `[start, duration)` 切成**无缝无重叠**的窗口；总长 ≤ 一窗 → 单个窗口（**短音频与引入窗口化之前逐字节一致**，不引入额外行为）；末窗不足阈值 → 并入前一窗（不为几秒尾巴多付一次 STT）；`startSec` 即**断点续跑**入口（已覆盖到哪就从哪继续，窗口边界与上次不同也无妨 —— 段戳来自 parse 层写的全局 `[mm:ss]`，与怎么切窗口无关）。
  * `mergeSegments(a, b)`：按 `t` 升序合并两批；`t` 相同（0.1s 精度）只留一条（续跑重叠 / 重复窗口的幂等保护），并丢弃正文为空的段。
  * `runWindows({ plan, existing?, transcribeWindow, onProgress? })`：**串行**逐窗跑（云端 STT 按段计费限流，并发更易触发限流且进度算不清）；每完成一窗回调 `onProgress`（由调用方落盘）；**空窗口照常推进** `coveredUntilSec`；真错误**立即抛出**，但已完成窗口的进度在 `onProgress` 里**已经落盘** —— 这就是「断点续跑」的全部依据。返回值刻意**不含** `complete` 布尔（那种「恒为 true」的字段最容易让判据退化成平凡为真）。
* **`AudioTranscript` 承载中间态：`partial` + `coveredUntilSec`**（[transcript.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.ts)）：`partial?: boolean`（**尚未转完**，语义是「可用但不完整」，UI 要如实标注）、`coveredUntilSec?: number`（已覆盖到的秒数，断点续跑的**唯一依据**）。`parseTranscriptSidecar` 读 / 写这两个字段：**只在 `partial === true` 时写**（`false` 不写字段 ⇒ 老 sidecar 的字段形状不变，向前兼容），`coveredUntilSec` 有限且 ≥0 才写。
* **`transcribe` action 编排窗口化 + 断点续跑，`maxDuration = 1800`**（[clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：这是路由里唯一的**分钟级**动作，窗口化后更久（57 分钟 ⇒ 3 窗，云端 STT 逐个跑），故给 1800s。流程：算指纹 → 读 sidecar（完整稿直接返回 `cached:true`；`partial` 且**同一次请求的形状**〈范围一致〉才谈续跑，否则从头）→ 探总时长 → 按 `planWindows` 切窗。**单窗路径**（短音频 / 选区）走一次调用、`swallowNoSpeech:false`，与窗口化引入之前逐字节等价；**长音频路径**走 `runWindows`，`onProgress` 里把 `{ partial, coveredUntilSec }` 写进 sidecar（`done < total` 才带 `partial`）；完成回传 `windows: 1 | N`。半途失败的 catch 会读出已落盘的半截稿，如实回 `已保存 N/M 分钟的转写，再点一次「继续转写」会从断点接着跑`。`windowSec = clampWindowSec(body.windowSec)`（仅测试 / 调优用）。任何失败（未配引擎 / 静音 / 超限 / 网络）仍是 **200 + `{success:false,error}`**。
* **`NoSpeechError`：把「这段范围没有可转写语音」类型化**（[audio-parser.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/parse/audio-parser.ts)）：新增 `export class NoSpeechError extends Error`（`name='NoSpeechError'`，`message` 与历史抛出的**逐字一致**），在静音（`'No speech detected — the recording is silent (input level too low).'`）与空稿（`'Empty transcript — no speech detected.'`）两处抛出。有类型之后窗口化路径才能明确地「跳过这一窗、继续下一窗」—— 否则调用方只能靠 `message` 字符串分辨，会把「某窗静音」当成致命错误、整段卡在这一窗反复失败、永远到不了后面。
* **画布音频编辑器的长音频进度 UI**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) / [TranscriptPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/TranscriptPanel.tsx)）：转写按钮按状态切换 —— 半截稿 ⇒ `Continue transcribing`（不传 `refresh`，服务端从 `coveredUntilSec` 续跑，`title` 明说「已完成部分有缓存、不额外花钱」）；完整稿 ⇒ `Re-transcribe`（`refresh:true`）。长音频首跑的 `title` 预告 `This recording is N min — it will be transcribed in M parts and may take several minutes`。转写中每 4s 轮询 `load_transcript` 把**逐窗落盘**的真实进度显示出来（请求被掐断时已转部分**不回退**）；完成后状态条报 `Transcribed in N parts in Ns.`。转写面板与工具行都显示 `· partial X/Y min` / `X/Y min transcribed`（读数不可点，`text-10`）。

### 修复与优化

* **`parseProjectRoot()` 兜底写死 `~/BobWork` 会把隔离环境的缓存写进真实数据根**（[project-root.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/parse/project-root.ts)）：改用 `resolveAppRoot()`（认 `BOBWORK_HOME`）+ `SANDBOX_DIRNAME`。实测（2026-10-11 长音频端到端探针）：用 `BOBWORK_HOME=/tmp/…` 起隔离 dev 时 `getCurrentProject()` 抛错 ⇒ 兜底落到**用户的真实数据根** `~/BobWork/.sandbox/.cache/parse/…`，被文件沙盒拒绝（`EPERM: operation not permitted, open '/Users/…/BobWork/.sandbox/…'`）。症状极具误导性：**转写把 20 个分片都跑完了**（STT 调用数可证），最后一步存缓存时 EPERM，用户看到的是「转写失败」，而根因是缓存路径不属于当前环境。
* **窗口化末窗合并阈值必须随窗口缩放**（[windowed.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/windowed.ts)）：首版把 `TAIL_MERGE_SEC`(120s) 写死，窗口被调到 100s（测试 / 将来更细切分）时「不足 120s 就合并」会把**每个**末窗都并掉、甚至改掉已经合法的窗口结构（首版正是这里被单测抓到：预期 3 窗实得 2 窗）⇒ 语义统一成「末窗不足**半窗**就并进前一窗」（`Math.min(TAIL_MERGE_SEC, win/2)`）。
* **单窗路径刻意不吞 `NoSpeechError`**（[clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：`runWindow` 的 `swallowNoSpeech` 默认 `true`（窗口化必须吞），但单窗路径（整段短音频 / 选区）显式传 `false` —— 那里「没语音」就是要原样报给用户的原因，「录音是静音 / 输入电平太低」比笼统的 `Empty transcript` 可操作得多，不能因引入窗口化而回退。
* **文件大小上限改按「要转的范围」判定**（[audio-parser.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/parse/audio-parser.ts)）：`MAX_FILE_BYTES = 100MB` 的整文件判据加 `!range` 前置 ⇒ 108MB 的 57 分钟录音不再被整份大小拦下（真正的成本上界是**范围时长**，由 `duration > MAX_DURATION_SEC` 单独把关）；这也正是长音频能走窗口化的**必要条件**（每条注释已写明）。
* **波形吸附规则收敛成 `snapToRefs`（打点 + 刻度格线）**（[mark-ops.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/mark-ops.ts) / [AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：新增 `snapToRefs(t, { marks?, ticks?, tolSec }) → { t, snapped: SnapKind|null }`，语义三条 —— 只在阈值内吸附（含边界，带 `1e-9` 容差，防浮点边界两侧行为不一致）、**打点优先于刻度**（用户数据 > 系统网格）、`t` 非法原样返回（绝不把 `NaN` 变成某个点的时刻）。`snapToMark()` 改为转发 `snapToRefs` 的 marks-only 分支，吸附规则只留一处实现；`AudioMarkTrack` 的 `snapPoint()` 用「像素阈值 `SNAP_PX = 6` 换算成秒」（`px/宽度 × 时长`）吸附到打点或刻度格线，并用 `data-snap={hover.snapped ?? 'free'}` + tooltip（`Snapped to a mark` / `Snapped to a tick`）给出「吸到了什么」的视觉提示。

### 新增与增补的单测

* 新增 [windowed.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/windowed.test.ts)（**15 例** / 4 describe）：短音频 = 单窗（与老路径逐字一致）/ 🔴 用户实际那一例 3401s 全落在合法窗口内且无缝无重叠 / 末窗合并（且随窗口缩放：100s 窗口不再被全部并掉）/ 断点续跑从 `coveredUntilSec` 续 / `mergeSegments` 0.1s 精度幂等去重 / `runWindows` 串行逐窗落盘 / 🔴 **空窗口照常推进** / 🔴 **中途真错误抛出但进度已落盘** / 续跑结果与一次跑完等价。
* 增补 [mark-ops.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/mark-ops.test.ts)（**26 → 34 例，+8**）：`snapToRefs` 阈值两侧 / 🔴 **打点优先于刻度（即使刻度更近）** / 🔴 边界 `1e-9` 容差两侧各测一次 / 非法输入与脏候选（`NaN` / `undefined`）被跳过 / `snapToMark` 转发后行为不变。
* 增补 [transcript.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/transcript.test.ts)（**23 → 26 例，+3**）：`partial` / `coveredUntilSec` 往返不丢 / 🔴 **完整稿不写 `partial` 字段**（老 sidecar 形状不变）/ `partial` 只认严格的 `true`（脏值当完整稿）。
* 计数口径 `grep -cE "^\s*(it|test)\("`，这三个文件里 `it.each` / `it.skip` / `it.only` 均为 0 ⇒ 无少算。本批测试净增 **+26 例**。

## v0.7.696 (2026-10-11)

> 本版是 **v0.7.695 之后的「音频编辑器看懂内容」版**：v0.7.695 解决的是「长录音放得动」，本版解决「听得懂」—— 给画布音频查看器接上**转写（STT）**，再围绕它把**打点与截取**做成按内容操作的流程。链路是一条：`Understand this audio` → 转写 sidecar `<主名>.transcript.json` → 转写面板（点句跳转 / 播放高亮 / 行内打点与按句截取）→ ① `Generate marks` 按段生成打点（追加、幂等、带 `auto` 位，可一键只清自动点）；② 行内 `✂` 按句截取；③ 多选 / `Split at N marks` / AI 精选统一汇到新 action `clip_many`（一次请求导出多个、逐条回执不静默）；④ 片段默认名取区间转写文本前 12 字，`✦` 可让模型给 ≤12 字标题。新增 `/api/audio/ai` 独立路由（模型任务与文件操作的失败语义、超时量级都不同），AI 只给建议（越界即丢弃、勾选后才落盘），**没配模型时自动降级为纯规则切分**并如实说明。同时把「编辑器侧转写」做成**派生数据**：与打点 / 波形同落在应用自有音频库（含库外音频的影子目录），**绝不进 workspace**。共 18 个文件改动（9 新增：6 源码 + 3 测试；9 修改：7 源码 + 2 测试），测试净增 **+78 例**。

### ⚠️ 迁移缺口与新增暴露（请先读这条）

* **新增的付费 / AI 动作都没有来源闸**（安全与成本，建议尽快补）：`/api/audio/clip` 的 `transcribe`（花 STT 费用）、`clip_many`（写 `.audio-library`）、`save_marks`，以及新增的 `/api/audio/ai`（消耗用户模型额度）**都没有** `guardRequestSource()`；而 `/api/audio/*` **不在** v0.7.692 的 preview-origin denylist 12 项内（`src/lib/http/preview-host.ts:21-34`）。从预览 origin 的 Hippo **全窗口**路径（同源、无预检）小程序可发起。沙盒 iframe 承载时因 opaque origin 会触发预检，风险面较小。denylist 的设计口径是「拿到就等于控制整机 / 密钥的 crown jewels」，音频这些属**付费**而非控权，是否纳入待你决定。
* **片段改名不迁移转写 sidecar**（`src/lib/audio/library.ts` 的 `renameClip()`）：只同步同名 `.marks.json`（`library.ts:290-292`），本版新增的 `<base>.transcript.json` **原地不动** ⇒ 改过名的片段转写**读不回来**，旧文件成为孤儿（`listLibrary` 只认 `source.<音频扩展名>`，不会列出也不会报错）。
* **片段删除不清理转写（和 peaks）sidecar**（`deleteClip()`）：只删片段文件 + `.marks.json`（`library.ts:315-318`）⇒ `<base>.transcript.json` / `<base>.peaks.json` 残留为孤儿。**转写是花了 STT 钱与时间的结果**，比 peaks 缓存残留更值得知道；`deleteEntry()` 是整目录删，无此问题。
* **`Selection only` 会命中旧 sidecar（实际没跑选区转写）**：`AudioViewer.transcribeSelection()` → `transcribe({ range: sel })` **不带 `refresh`**（`AudioViewer.tsx:688`），而 `transcribe` action 在 `body.refresh !== true` 时**先查 sidecar 且不比对 range 是否一致** ⇒ 只要该音频已有转写，点 `Selection only` 会直接返回旧稿，界面却显示 `Transcribed the selection in Ns.`。要真跑选区，目前只能先让 sidecar 失效。
* **转写 sidecar 是单一文件、按选区转写整份覆盖**：没有多份 / 合并机制；`range` 会持久化并在面板标注 `· 30–60s`，但下一次整段 `refresh` 会直接覆盖局部稿（反之亦然）——「只转这一截」是临时入口，不是多稿管理。
* **多选超过 20 句会被整批拒绝**：`TranscriptPanel` 的 `Clip N` 不设上限，而路由 `MAX_CLIP_BATCH = 20` 直接返回 `too many ranges (max 20 per request)`，**整批一条都不导出**，且无前置提示。
* **确定性文件名 + `clipAudio` 用 `-y` ⇒ 重复执行会静默覆盖**：`Split at N marks` 命名 `<标题> - 01/02…`、AI 精选用 `h.title`（`normalizeHighlights` 只按 `start` 去重，**同名标题不排除**）、多选截取用段文本前 12 字 —— 同名时后一次覆盖前一次（`.clips.json` 按 path 去重，不留两条，所以覆盖得毫无痕迹）。
* **指纹失效是静默的**：音频被替换 / `touch` / 改名后 `load_transcript` 返回 `null`，界面按「没转过」处理（设计如此，避免展示过期文稿），但用户会以为转写丢了。另外库外音频影子目录的 key = `sha1(绝对路径)[:12]` ⇒ 移动 / 改名源文件时打点与转写一起失联（既有设计，加上转写后代价变大）。

### 新增功能

* **转写 sidecar：`<主名>.transcript.json` + 指纹对账**（`src/lib/audio/library.ts`，+63 行）：新增 `transcriptFileFor()`（库内音频就地放、库外音频进影子目录，与打点 / peaks 同处）、`readTranscriptFile(transcriptAbs, current)`、`writeTranscriptFile()`。失效判据 = sidecar 记的 `{size, mtimeMs}` 与当前音频指纹**逐字段不等** ⇒ 返回 `null`（宁可不展示，也不让用户拿旧稿去打点）；sidecar **没记**指纹（手工放进来的）则放行。`writeTranscriptFile` 自己 `mkdir -p`（库外影子目录此前不存在，直接 write 会 ENOENT —— `writeMarksFile` 踩过的同一个坑），且写失败**抛出**（转写是花钱的结果，与 peaks 的「失败静默」相反）。
* **转写纯函数层（客户端也能值引入，无 `node:fs`）**（新增 `src/lib/audio/transcript.ts`，250 行）：`AudioTranscript = { version, segments, plainText, durationSec, engine, range, at, source }`、`TranscriptSegment = { t, end, speaker|null, text }`、`TRANSCRIPT_VERSION = 1`（版本不符即丢弃旧 sidecar，不让旧数据把 UI 带崩）。
  * `segmentsForEditor(plainText, { endSec, fallbackSpanSec })`：逐段补 `end`（= 下一段 `t`；末段取 `endSec` 或兜底 `DEFAULT_LAST_SPAN_SEC = 30`），最短段 `MIN_SEGMENT_SPAN_SEC = 0.1`，0.1s 取整。**无戳兜底**：`parseAudio` 只在 `segCount > 1` 时写 `[mm:ss]`，短音频（<60s 单块）会被解析成空数组 ⇒ 无戳但有正文时兜底成**单段**，否则界面会把「转写成功」显示成「没有内容」。
  * **刻意不做范围偏移**：段戳已是全局时间轴（`baseOffset = range.start` 已并入），本文件不提供 offset 参数，并留了回归用例守卫（早期设计稿那句「offsetSec = range.start」会造成按选区转写时双重偏移）。
  * `activeSegmentIndex(segments, time)`：语义 = 最后一段 `t ≤ time` 的二分（用推算的 `end` 做右开区间会在段间隔里把高亮闪掉），`-1` = 还没到第一段；入参只要求 `{ t: number }`（会议回放的段没有 `end` 字段）。
  * `validRange(start, end, durationSec, minSpanSec = 1, endToleranceSec = 0.5)`：**严格拒绝、不做边界钳位**（倒置 / 负起点 / NaN / 越界一律 `null`）；上界留 **0.5s 测量容差**（ffprobe 与浏览器解码是两个测法，同一文件差几十毫秒是常态，严格判据会把「按播放器时长截到结尾」误判成越界）。
  * `parseTranscriptSidecar(raw)`：宽松解析，脏段逐条丢弃（`t` 非有限数 / 负、正文为空、非对象），`end` 非法回退 `t + 0.1`，无有效段 → `null`。
* **`/api/audio/clip` 三个新 action + `maxDuration = 300`**（`src/app/api/audio/clip/route.ts`，+236/−13）：这是该路由里唯一的分钟级动作，不给显式上限长音频会被平台掐断而客户端只看到一个没有原因的失败。
  * `transcribe`：请求 `{ source, path, refresh?, rangeStartSec?, rangeEndSec?, diarize? }`，`diarize ∈ {auto, duo, group}`；不带 `refresh` 且指纹相符 → `{ success:true, transcript, cached:true }`（**不重复花钱**）；`refresh:true` 忽略 sidecar 重跑。引擎抬头用 `/^音频转写（([^）]*)）/` 从 `extracted_text` 抠出（唯一真源在 `audio-parser.ts:822` 的抬头行）。整段 >30 分钟由 `parseAudio` 拦下（`MAX_DURATION_SEC = 30*60`），**按范围转写只校验所选范围的长度** ⇒ 长音频的正解是带 range 分段。任何失败（未配引擎 / 静音 / 超限 / 网络）都转成 **200 + `{success:false,error}`**，且失败**不留半截 sidecar**。
  * `load_transcript`：三态 —— 有稿且指纹相符 / `null`（没转过、已失效、数据损坏）/ `success:false`（路径非法）。组件挂载即可直接问，不必先猜「转过没有」。
  * `clip_many`：请求 `{ source, path, ranges: [{ startSec, endSec, name }] }`，`MAX_CLIP_BATCH = 20`、`MIN_CLIP_SPAN_SEC = 0.1`；**逐条 ffmpeg、逐条回执** `results: [{ ok, name?, start?, end?, error? }]`，响应 `{ success, exported, failed, clips, results }`，只有全部失败才 `success:false`（越界 / 倒置直接拒绝并带原因，**绝不静默跳过**）。边界校验与 AI 精选**共用同一个纯函数** `validRange`。抽 `exportOneClip()` 供 `clip` / `clip_many` 共用（批量导出不再变成 N 次读改写同一份 `.clips.json`，清单只在末尾写一次）；单条 `clip` 的响应也补了 `clips`（少一次往返）。
* **AI 路由 `/api/audio/ai`（`maxDuration = 60`）**（新增 `src/app/api/audio/ai/route.ts` + `src/lib/audio/ai.ts`，81 + 281 行）：`action: 'highlights' | 'suggest_clip_name'`，模型侧一切失败一律 **200 + `{success:false,error}`**（没配模型 / 超时 / 返回不可解析都不该是 500）。独立成路由而非并进 `clip`：那里是「文件操作」（I/O 或参数失败）、这里是「模型任务」，两类失败与两个超时量级不该纠缠。路由侧 `sanitizeSegments()` 把脏段逐条丢弃（不假设调用方是自家 UI，避免 `s.text.replace` 抛 TypeError 变 500）。
  * 常量：`MAX_HIGHLIGHTS = 8`、`MIN_HIGHLIGHT_SPAN_SEC = 1`、`MAX_PROMPT_CHARS = 12000`、`MAX_CLIP_NAME_CHARS = 12`（比 `suggest-title` 的 20 短：文件名要能一眼扫过）、精选超时 20s、命名超时 10s、`temperature 0.3`；请求 `max` 用 `Math.min(max, MAX_HIGHLIGHTS)` 封顶。
  * 可单测的纯函数：`extractJsonArray()`（剥 ``` 围栏、取首个 `[` 到末个 `]`、退一步支持 `{highlights|items|segments|clips|result:[...]}` 包一层；抠不出来返回 `null`）、`cleanClipName()`（取第一行、剥文件名非法字符 `/ \ : * ? " < > |`、**交替剥首尾引号与结尾标点最多 3 轮直到稳定**、压空白、按码点截 12 字）、`normalizeHighlights()`（逐条走 `validRange` 硬校验，越界 / 倒置 / NaN 丢弃、同 `start` 去重、标题为空时用理由前 12 字兜底）、`transcriptForPrompt()`（`[mm:ss] [说话人 N] 正文`，超 12000 字截断并插入「…（转写过长，后续内容已省略）」）。
  * 未配模型文案：`尚未配置任何模型，请在【设置 → Models】中配置后再使用智能精选。`。`generateHighlights()` 在转写为空 / 拿不到时长时也返回 `{ok:false,error}`，调用方据此回退纯规则路径。
* **`AudioMark.auto` 位 + 两侧序列化收敛**（`src/lib/audio/marks.ts`，+51/−31）：`auto?: true` 只表示「按转写自动生成」，用途是让「清除自动生成的点」只删自动点、手打点毫发无伤，并给「生成打点」这个动作一个原子撤销粒度。**手打点恒不写该字段 ⇒ 旧数据（无该字段）语义正好等于手打点，无需迁移**。同时把原先在 md 注释行与 sidecar JSON 两条路径里**各自展开写**的遍历收敛成 `serializeMark()` / `normalizeMarks()` 各一份 —— 可选字段漏读一处就是「写进去、读出来没了」的静默丢字段，tsc 与 eslint 都抓不到。字段顺序固定 `t → label → auto`，`label` 为空不写该键（有逐字节断言保护）。
* **打点纯操作层**（新增 `src/lib/audio/mark-ops.ts`，263 行）：与 `marks.ts` 的分工是「运算 vs 持久化」，全部纯函数（仓库无 jsdom，组件测不了，放 lib 层才能单测）。
  * `marksFromSegments(segments, existing, { speakerPrefix?, minGapSec? })`：**追加**语义 —— 原样保留传入的手打点（含标签）只往里加；与 `existing`（以及本次已生成的）距离 < `AUTO_MARK_MIN_GAP_SEC = 0.5` 的段跳过 ⇒ **幂等**，反复点「生成打点」第二次 `added = 0`（界面会说出来）；生成的点一律 `auto: true`；标签 = 段正文压平空白后按码点截 `AUTO_MARK_LABEL_MAX = 24` 字（空正文返回 `undefined`，不写空标签），并**仅当转写里出现 ≥2 位说话人**才加 `Speaker N · ` 前缀（否则同一人录音逐段标「说话人 1」纯属噪音）。返回 `{ marks, added, skipped }`，不改传入数组。
  * `dropAutoMarks()` = `filter(m => !m.auto)`；`snapToMark(t, marks, tol = SNAP_TOLERANCE_SEC = 0.3)` 把当前时刻吸到最近打点（**含边界**，故带 `1e-9` 容差：实测 `|30 − 29.7| = 0.30000000000000027 > 0.3`，不加容差会出现「恰好 0.3s 时吸、换个等价写法就不吸」；阈值外原样返回并按 0.1s 取整，`NaN` 绝不变成某个点的时刻）。
  * `splitRangesAtMarks(marks, durationSec, minSpanSec = 0.1)`：按打点把 `[0, duration]` 切成 N+1 段，相邻切点间距不足的后者丢弃、首尾补齐 `0` 与 `duration`、尾部不足一段并入前一段、`duration` 未知返回 `[]`（宁可什么都不做，也不生成「到 0 秒」的空片段）。
  * `ruleHighlights(segments, durationSec, max = 8)`：**不调模型**的确定性降级路径。说话人切换处必切（仅 ≥2 人）、否则每跨过 `RULE_BLOCK_TARGET_SEC = 60` 收一块、短于下限的块丢弃（`RULE_BLOCK_MIN_SEC = 20`；**多人录音一律用更短的 `RULE_SPEAKER_MIN_SEC = 5`** —— 访谈一问一答常只有 5~10s，用 20s 会把轮次块全丢光；音频本身很短时再按 `total/2` 放宽），标题取块内首段正文前 12 字，**最后还有一道「绝不返回空」的兜底**（退化成整段一条）。
* **转写面板 `TranscriptPanel`**（新增 `src/components/audio/TranscriptPanel.tsx`，283 行）：定位是「为打点与截取服务的操作面，不是阅读器」。`defaultOpen = false`（折叠态只留 `▸ Transcript (42)`，占位与普通行等高 —— 窄面板最小 272px 下自动展开会把片段清单挤出首屏）；点行 = 跳转并播放，行内 `＋` 在该段起点落手打点（标签 = 段文本前 24 字），`✂` 按句截取（进 `AudioMarkTrack` 的**命名态**，与手动拖选同一条路）；多选后 `Clip N` 批量导出（默认名取段文本前 12 字，跨度 < 0.1s 的丢弃）；8 色说话人色板、正文 `line-clamp: 2`、列表 `max-h-56` 自带滚动；播放高亮 + 自动跟随**手算 `scrollTop` 只滚本面板**（`scrollIntoView` 会连带滚动祖先容器，而画布面板壳是 `overflow:hidden`，会把内容莫名顶走），用户上滑（距底 > 40px）即解除跟随；`onHighlights` 不传则不渲染按钮。
* **`parseProjectRoot()` 抽取**（新增 `src/lib/parse/project-root.ts`，27 行，只导出这一个函数）：解析类任务的缓存根 = `<projectPath>/.cache/parse/` 的第二个入参。有激活项目用项目根，否则回退 `<home>/BobWork/.sandbox`。两份实现各写一遍的后果很隐蔽：同一份音频的转写会落到两个缓存目录，缓存命中率凭空腰斩，而症状只是「有时候快、有时候慢」。⚠️ 仅用于缓存目录，不参与任何路径安全判断。

### 修复与优化

* **波形刻度出现成对重复标签**（`src/components/audio/AudioMarkTrack.tsx`）：`TICK_STEPS` 去掉 `< 1s` 的步长（`[0.5,1,2,…]` → `[1,2,5,10,15,30,60,120,300,600,900,1800]`）。标签走 `mmss()` 只印到秒 ⇒ 0.5s 步长会把每个整秒印两遍，实测 4s 音频刻度行 = `00:00 00:00 00:01 00:01 00:02 00:02 00:03 00:03`。影响面只有 ≤6s 的音频会因此变稀疏；文件里同时写下约束：将来若要亚秒刻度，必须把标签一起换成带小数的 `mmssPrecise`。
* **一键生成打点会撑爆首屏**：新增 `MARK_CHIP_LIMIT = 6`，`marks.length > 6` 时只渲染前 6 片 + `+N more`，展开后是 `max-h-20 overflow-y-auto` 定高容器（`Show less` 收起）。原由：按转写一键生成动辄 30+ 个点，chips 行本就 `flex-wrap`，窄面板 320px / 默认档下每行只放得下 2 片 ⇒ 30 个点 = 15 行 ≈ 470px，会把转写面板与片段清单整块挤出首屏。取 6 是**为了让默认场景逐字节不变**（≤6 时渲染路径与加这个特性之前完全一致）。折叠用 `slice(0, n)` 而非过滤 / 排序 ⇒ 下标与 `marks` 对齐，不会删错点。
* **窄面板下波形控制行被面板壳裁掉（按钮点不到）**：控制行加 `flex-wrap`。实测（面板 320，两个独立见证：几何在裁剪区内 + 中心点 `elementFromPoint`）：m 档 `Play range` 可见宽 45.22/75.36（中心仍在内 ⇒ 可点）；L 档可见宽 **8.62/85.41**（中心已在裁剪区外 ⇒ 实际点不到）；XL 档可见宽 **0**（完全不可见），`Clip` 也被裁到 38.54/57.06。溢出量还随时长增长（读数变长），折行是唯一不随数据恶化的解；折行后最坏只多占一行（≈63px @ L）。
* **交互会把打点列表整块推走**：行序口径定为 **`{marks}` → `{sel}` → `{clipDraft}` → `{draft}`**。`{sel}` 的 0↔1 完全跟随一次拖选手势 ⇒ 属临时编辑面；原先排在 `{marks}` 之前，拖选会把打点列表 + 下方状态条 / 片段清单整块下推 **30.38 / 33.62 / 36.87px @ m/l/xl**（XL 档 + 面板最小宽 272px 时折两行 ⇒ **63.00px**）。四类行行高相同、列间距 `0.375rem` ⇒ 换位不产生额外几何差异，只改变哪个块在动。
* **打点改动只有一个落盘口 + 可撤销**（`src/components/canvas/viewers/AudioViewer.tsx`）：手打点 / 删点 / 改批注 / 按转写生成 / 一键清自动点全部改走 `applyMarks(next, { history })` —— ① 乐观上屏（交互不等网络）；② 压一份完整快照进撤销栈（`markHistory`，`slice(-19)` 保留最近 20 步；**基线删点是「立即落盘且不可撤销」的破坏性操作**）；③ await 落盘结果并**说出来**（基线 `void postAudio(…)` 发完不管，失败时打点看着已存、刷新后消失）。新增 `Undo marks`（整份回写，撤销自身不压栈）。生成打点的结果也必须讲清楚「新增 N 个、跳过 M 个」。
* **批量截取绝不静默跳过**：`clipMany()` 把「成功几条 / 失败几条 / 第一条失败原因」如实写进状态条（`Saved 3 clips — 2 failed`）。逐条 ffmpeg、逐条回执，只要有一条成功就算成功。
* **实现期被单测抓到的两个真 bug（新代码内部，已修）**：① `snapToMark` 阈值边界浮点问题（加 `1e-9`）；② `cleanClipName` 对模型输出 `“预算分配方案”。` 只剥一遍会先去掉句号、留下孤立的右引号（得到 `预算分配方案”`）⇒ 改为交替剥首尾引号 / 括号与结尾标点、反复到稳定（最多 3 轮，必然收敛）。

### 改进

* **会议回放与音频编辑器共用同一个「当前段」二分**（`src/components/butler/MeetingReplay.tsx`）：`onPlaybackTime` 里内联的二分换成 `lib/audio/transcript.ts` 的 `activeSegmentIndex`（两处各写一份的结果必然是「一处改了另一处没改」）。唯一语义差异是 `t` 早于首段起点时由「高亮首段」变「不高亮」（`-1`）。
* **模型侧与文件侧共用一个响应契约**（`AudioViewer.tsx`）：新增 `postAi()`（走 `/api/audio/ai`），与 `postAudio()` 完全一致（永不抛、永不返回 `null`，都过 `readApiResult`）⇒ 调用点不必区分两套错误形态。
* **AI 只给建议，且模型不可用时不把用户堵死**（`AudioViewer.tsx`）：`runHighlights()` 拿到建议后**默认全选、勾选后点 `Export N` 才落盘**（绝不自动导出），导出后清空卡片；失败时自动落到 `ruleHighlights()` 并如实说明这批是规则给的（`AI unavailable (<原因>) Showing N rule-based suggestions.`）。`✦` 智能命名失败时**保持用户手上的草稿不动** —— 输入框绝不能被一次失败的模型调用清空。
* **实时时长 / 播放时刻回调改成 `useCallback`**：`handleDuration` / `handleTimeUpdate` 会被 `AudioMarkTrack` 收进 `cbRef`，内联箭头每次换身份会让那个 effect 空转。
* **`requestClip` / `getSelection` 两个新句柄**（`AudioMarkTrack.tsx`）：按句截取复用组件自己的选区与命名态（不长出第二条导出路径），「只转写这一截」从组件问出选区（不为它单开回调）；命名相关 props 放 `suggestRef`，让 `useImperativeHandle` 依赖数组保持 `[]`（句柄身份必须稳定，直接闭包 props 会永远读到首次渲染的值）。
* **片段命名默认名改为内容相关**：`suggestClipName(start, end)` 由父级从转写文本里取（取不到回退既有的 `片段 - 标题 - 时间戳`，即「没有转写也照常能用」）；`✦` 的 `onRequestClipName` 只在拿到非空结果时覆盖草稿。
* **片段清单区显示条件放宽**：`clips.length > 0 || !atRoot || marks.length >= 2` ⇒ 只有打点、还没导出过片段时也能看到 `Split at N marks`。

### 界面细节

* **转写入口整行常驻**（`AudioViewer.tsx`）：`Understand this audio` / 转写中 `Transcribing…`（`Loader2` 转圈）/ 已有稿时 `Re-transcribe`（`refresh:true`）；`Selection only`（只转选区，长音频入口）；`Separate speakers` 勾选框**默认关**（它要对整段音频跑一次声纹，很慢，不替用户决定）。文案：`Drag on the waveform to select a range first.` / `Transcribed in Ns.` / `Transcribed the selection in Ns.`
* **打点工具行只在有东西可操作时出现**：`Undo marks`（有撤销栈时）、`Clear N auto`（有自动点时才出现，`title` 明说手打点会保留），其余时候零占用；刻意排在 `{marks}` 之后。
* **AI 精选建议卡片**：标题 `Suggested clips` + `Export N` + `Dismiss`；每条一个勾选框、时间 `mm:ss–mm:ss` 可点跳转、标题一行截断（完整理由在 `title` 里）。
* **`Split at N marks` 放在片段区标题行**（`title` 说明会导出 `N+1` 个片段），不放波形控制行 —— 那里在窄面板下已经会折行，再塞按钮只会更早折行；放片段区语义也更贴。
* **纪律写进文件头**：新 UI 一律排在 `{marks}` 之后且自带滚动或高度有界，否则会重现「持久列表被交互推走」的老缺陷。

### 新增与增补的单测

* 新增 `src/lib/audio/transcript.test.ts`（**23 例** / 4 describe）：无戳兜底单段 / 末段兜底 30s / 🔴 **不做范围偏移的回归闸门** / `activeSegmentIndex` 段间隙不闪断 / `validRange` 越界拒绝但留 0.5s 容差 / 版本不符与脏 sidecar → `null`。
* 新增 `src/lib/audio/mark-ops.test.ts`（**26 例** / 6 describe）：🔴 绝不改动手打点 / 🔴 幂等第二次 `added=0` / 去重阈值 0.5s 与 0.4s 两侧 / `snapToMark` 边界 / `splitRangesAtMarks` 尾部并入 / 🔴 **12s 短音频必须给得出建议**。
* 新增 `src/lib/audio/ai.test.ts`（**17 例** / 4 describe）：``` 代码块与 `{"highlights":[…]}` 两种包裹 / 🔴 不可解析返回 `null` / 剥文件名非法字符 / 🔴 越界·倒置·NaN 一律丢弃 / 同 `start` 去重截上限 / prompt 超长截断留痕。
* 增补 `src/lib/audio/library.test.ts`（**29 → 37 例，+8**）：转写 sidecar 的落点（库内就地 / 库外影子目录）/ 父目录不存在也能写 / 🔴 **指纹不符 → `null`** / 没记指纹放行 / 非法 JSON → `null`。
* 增补 `src/lib/audio/marks.test.ts`（**21 → 25 例，+4**）：`auto` 仅在 `true` 时写出且排在 `label` 之后；md 与 sidecar **两条路径各测一次**往返；手打点恒不写 `auto`。
* 计数口径 `grep -cE "^\s*(it|test)\("`，这 5 个文件里 `it.each` / `it.skip` / `it.only` 均为 0 ⇒ 无少算。本批测试净增 **+78 例**；全仓 `pnpm test` **120 文件 / 1352 例全绿**，`tsc -p tsconfig.json` 通过。

### 无实质变化 / 待确认（单列）

* **`src/app/api/transcribe/route.ts` —— 纯重构，行为不变**（净 −10 行）：删掉本地 `projectRootPath()`，改用 `@/lib/parse/project-root` 的 `parseProjectRoot()`；`maxDuration = 120`、入出参与 422 `No speech recognized` 口径均未动。
* **`src/lib/audio/marks.ts` —— 对旧数据逐字节等价**：`serializeMark` 字段顺序与「`label` 空不写键」保持不变，无 `auto` 字段的旧 marks 读写往返不变 ⇒ **不需要迁移**。
* **本批没有新增或改动任何 localStorage 键**（18 个文件全量 grep：0 命中）。
* **`src/app/api/ocr/route.ts` 里仍有一份同款 `projectRootPath()`**（`route.ts:21-28`，`homedir()/BobWork/.sandbox` 回退）—— 本批只抽了 `/api/transcribe` 与音频侧，OCR 这份未纳入；是否合并待定。
* **`listLibrary` 的 `durationSec` / `marksCount` / `hasTranscript` 字段未实现**：库浏览面板仍没有「这份音频转过没有」的线索。
* **会显著改变行为的候选后续**：长音频**窗口化全量转写**（本轮只做「转写当前选区」；真实 STT 调用刻意未跑，避免花用户 API Key 的钱）。

## v0.7.695 (2026-10-11)

> 本版是 **v0.7.694 之后的音频回放链路提速版**：v0.7.692–0.7.694 的主题都在悬浮球 / 面板窗，本版转回音频 —— 对长录音做一次**彻底的省内存改造**。核心是**服务端预计算波形峰值（peaks）**：新增 `lib/audio/peaks.ts`（用 ffmpeg 解码成 8kHz 单声道 PCM，流式按桶取绝对值最大，落 `.peaks.json` sidecar 缓存），并在 `/api/audio/clip` 新增 `peaks` action；前端拿到 `peaks + duration` 后，WaveSurfer **既不整份 fetch 也不 `decodeAudioData` 全量解码**，播放交给 `<audio src=代理URL>` 走 **HTTP Range 按需分段拉取** —— 实测 3401s 的录音原先要解码出 ≈600MB PCM（常驻原生内存、`performance.memory` 看不到），现在只剩硬盘上一个几 KB 的缓存。为此给两个 `file_proxy` 路由（`/api/local-files`、`/api/projects`）接入 **HTTP Range（206 / 416）**，并把两处逐字重复的 mimeMap 抽成共用的 `lib/files/mime.ts`（顺带补齐音视频类型）。同时新增 `readApiResult` 统一 `/api/audio/*` 的响应解析（响应体不是 JSON 时不再静默丢数据），并修掉给库外音频打第一个点时的 sidecar ENOENT。共 17 个源文件改动（3 改 + 14 新增）。

### 新增功能

* **波形峰值（peaks）服务端预计算 + sidecar 缓存**（[peaks.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/peaks.ts) / [clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts) / [library.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.ts)）：为什么必须做 —— WaveSurfer 在「没有 peaks」时有两条昂贵隐藏路径（`:471` 把整份音频 fetch 成 Blob；`:539-548` 用 `decodeAudioData` **全量解码**成 AudioBuffer，常驻原生内存），只要喂上 `peaks + duration` 两条路径**同时消失**（`:147-151` 播放改走 `<audio src>` 的 HTTP Range；`:536-538` 有 channelData 就直接建 buffer、不再解码）。做法：`PEAKS_SAMPLE_RATE=8000`（单声道 s16le，流量可预测 16KB/s）、`PEAKS_BUCKETS=2000`、`PEAKS_MIN_BYTES=1MB`（更小的文件走 Blob 更划算）、`PEAKS_VERSION=1`；`PeaksAccumulator` 流式吃 PCM，先按 **10ms 微桶**取 abs-max（**保号**，与 WaveSurfer `exportPeaks` 同口径，10ms 让最短的大文件也能凑满桶数），**收尾再按总样本数合并成 2000 个等宽桶**（单趟、恒定小内存，且与等宽切分等价），并**接住跨块的半样本**（管道分块边界任意）。`generatePeaks()` 以 `-vn -map a:0 -ac 1 -ar 8000 -f s16le -` 拉 stdout，失败一律返回 null（降级不报错）。缓存判据 = `v + srcMtimeMs + srcSize + buckets`，任一不符即当未命中重算；`peaksFileFor()`（library.ts 新增）把缓存与打点同款就地/影子落盘。新 action `peaks` **三态返回**：`{peaks,duration}`（走 Range 直连）/ `{small:true}`（太小，退 Blob）/ `{success:false}`（分析不出来，退 Blob）。
* **HTTP Range 分段响应 + MIME 统一**（[range.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/files/range.ts) / [mime.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/files/mime.ts) / [local-files/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/local-files/route.ts) / [projects/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/projects/route.ts)）：两个 `file_proxy` 原先**整份 `fs.readFile` 进内存**，长音频无法按需拉取。现在接入只支持**单区间**的 `parseRange()` 纯函数（RFC 9110 §14.2 口径）：畸形 / 非 `bytes` 单位 / 多区间 → **忽略退 200**（不误报 416）；合法但越界 → **416**（`Content-Range: bytes */size`）；合法 → **206** 并用 `createReadStream({start,end})` 只送该区间（suffix 区间 `bytes=-N`、开区间 `bytes=N-` 均支持）。200 / 206 / 416 三分支共用 `baseHeaders`（`Content-Type` 取自 `fileMime`、`X-File-Mtime` 哨兵、`Accept-Ranges: bytes`、`Cache-Control`）。`mime.ts` 消掉两处逐字相同的 mimeMap 并补齐音频 / 视频（旧表完全没有音视频，`.m4a` 一律以 `application/octet-stream` 下发）；文件头记录实测口径：Chromium 播放**只靠内容嗅探、忽略 Content-Type**，本文件的价值是**消重 + 语义正确 + 代理 URL 被直接打开时按类型渲染**，不是修播放；`.webm` 按容器口径归 `video/webm`。
* **`readApiResult` 统一 `/api/audio/*` 响应解析**（[api-result.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/api-result.ts)）：旧写法 `return await resp.json()` 在响应体**不是 JSON**（框架 / 代理级错误的 HTML 错误页、`204` 空体、连接被截断）时抛 → 被外层 catch 吞成 `null` ⇒ 调用方 `d?.error` 永远拿不到原因 ⇒ 失败对用户完全不可见（打点已乐观写进组件 state、刷新后消失 = **静默丢数据**）。`readApiResult(resp)` 保证**无论响应体是什么形态都返回对象**，失败时带可读 `error`（`HTTP <status> <statusText>`）；AudioViewer 的 `postAudio` 已改用它（网络层不可达仍单独兜）。服务端侧 `/api/audio/clip` 的 `POST` 也补了统一 try/catch（写入类 I/O 错误不再冒到框架层变成 HTML 错误页）。

### 修复与优化

* **给库外音频打第一个点不再 ENOENT**（[marks.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/marks.ts)）：`writeMarksFile` 现在自己 `mkdir -p` 父目录（放在空数组分支**之后**，删除语义不产生建目录副作用）。库外音频（项目 materials / 任意本地路径）的打点落在**影子目录**里，而该目录只有「导出过片段」或「算过波形缓存」才会被创建 ⇒ 给这种音频打第一个点必然 `fs.writeFile` ENOENT ⇒ 路由 500。症状的不对称：**删光打点不报错（unlink 包了 try/catch）、加一个打点才 500**。理由与 `writePeaksCache` 完全相同，那处已修、这里补上。注意与波形缓存不同 —— 打点是**用户数据**，建目录 / 写盘失败必须抛出。
* **画布音频查看器：加载态 / 试听选区 / 打点落盘失败可见**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) / [AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：① 新增 **Loading audio…** 加载态（大文件首次打开要先算波形峰值、可能几秒，此前看不出在加载，会误显示成失败 / 空态）；② 波形选区新增 **Play range** 试听（跳到起点播放、播到终点由 `timeupdate` 自动停，`playUntilRef` 只停这一档）；③ 打点写入由「`void postAudio` 发完不管」改为 **await 结果**：失败 → 状态条显示原因（与 clip / rename / delete 同款口径），成功 → 清残留提示；④ 波形走 `precomputed` 快路径时不再整份下载 / 全量解码（见上），加载结果按 path 缓存，切换 Source↔片段不重复拉取。

### 新增单测

* [range.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/files/range.test.ts)：`parseRange` / `rangeHeaders` / `unsatisfiableHeaders` 全覆盖 —— 无 Range / 非 bytes 单位 / 畸形 / 倒置 / 多区间 → null（200）；开区间、后缀区间、终点钳位；`start >= size` 与空文件 → `'unsatisfiable'`（416）；206 头 `Content-Range` / `Content-Length` 口径一致。
* [mime.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/files/mime.test.ts)：音频全部有正确 MIME（不落默认值）、大小写 / 带点与否均可取、`.webm` 按容器归 `video/webm`、未收录 / 空输入回退 `application/octet-stream`、原有条目（html / pdf / png / svg）回归保护。
* [api-result.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/api-result.test.ts)：合法 JSON 成功 / 失败体原样透传；**HTML 错误页、空体、标量 JSON、截断 JSON** 一律转成 `{success:false, error}`；不变式断言 —— 一切失败形态都满足「非 null + `success===false` + `error` 为非空字符串」，且**不把整页 HTML 当文案**丢给界面。
* [peaks.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/peaks.test.ts)：`PeaksAccumulator` 的流式正确性 —— 块边界切在样本中间（奇数块长）结果不变（跨块半样本拼回）、桶内取**保号** abs-max、全静音 → 全 0 / 满量程 → ±1、无样本 → null、时长由总样本数换算与桶数无关、桶数符合请求且覆盖到最后一个样本、短音频桶数超微桶时按实际数量产出。
* [peaks.integration.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/peaks.integration.test.ts)：**真值对照** —— ffmpeg 合成已知包络（300Hz 载波 × 23s 调幅）的 FLAC，字节数钉死「单声道 / 8kHz / s16le」口径，再用「整份 PCM 落盘后朴素全量分桶」作**第二见证**与流式微桶合并逐桶对账，并贴合已知包络公式。
* [marks.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/marks.test.ts)：`parseMarks` / `serializeMarks` / `upsertMarkHint` / `MARK_HINT_RE` / `parseClips` / `serializeClips` / `upsertClipRef` 的容错与往返；以及 `writeMarksFile` 的落盘 —— **父目录不存在时也能写成功**（先断言父目录确实不存在，避免退化成平凡为真）、空数组不抛错且**不建目录**、目录已存在时正常覆盖写。

## v0.7.694 (2026-10-10)

> 本版是 v0.7.693 之后的**面板窗与悬浮球收尾版**：上一版把面板窗内容换成桌面版 Butler 抽屉、并让抽屉左栏的黄 / 红键去「最小化整个 BobWork」，本版把这条语义**收回** —— 抽屉的三色键**不再动 BobWork 窗口本身**（最小化窗口是用户的事）：红键 = 收起抽屉 + 把悬浮球送回中栏左下角，黄键 = 收起抽屉（球留在原地），并**删掉 `butler-orb:minimize-app` IPC 与 `skipOrbOnNextMinimize` 标志**（`ButlerOrbApi` 由 7 键回退到 6 键），改用渲染层事件 `BUTLER_ORB_HOME_EVENT`。同时把面板窗从「灰底 + 30px 标题条」整改为**纯透明的一整张抽屉卡**（撤掉与抽屉三色键重复的标题条按钮），拖动改由左轨 / 顶部隐形拖动带承担；并修掉 Hippo 重复注册 ipcMain handler 导致主窗口不显示的问题。共 9 个源文件改动（7 改 + 2 新增）。

### 修复与优化

* **面板窗整改成「纯卡片」**（[butler-panel/page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/butler-panel/page.tsx) / [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：撤掉上一版给窗口铺的 `--background` 灰底与 30px 白色标题条 —— 那张标题条上「缩小 / 关闭」两颗按钮与抽屉左轨三色键**完全重复**，灰底还会在卡片四周露出一整圈「背景面板」。现在窗口全透明（`html/body` 也 `background: transparent`），只留抽屉那一张卡，窗口比卡片大一圈仅是为卡片的 CSS 投影留出空间。拖动改由两处抓手承担：左轨 `nav`（拖轨即拖窗，轨上按钮与链接 `no-drag`）与顶部一条 14px 隐形拖动带 `.bwp-drag`；抽屉的**联系人列首 / 对话框标题栏也兼作拖动抓手**（按住空白处拖整个抽屉）。三个出口全部走抽屉自己的三色键，页面不改抽屉实现：黄键 / 点卡片外空白 → `panelMinimize()`（收成球，球停在面板当前所在位置）；红键 → `panelClose()`（球与面板一起从桌面消失）。
* **抽屉三色键不再动 BobWork 窗口**（[ButlerHost.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerHost.tsx) / [butlerEvents.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/butlerEvents.ts) / [preload.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/preload.ts) / [butler-orb.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/butler-orb.ts)）：新增 `BUTLER_ORB_HOME_EVENT`（`butler:orb-home`，无 detail）。BobWork 里打开的抽屉：**红键** = 收起抽屉 + 派一次 orb-home（球回中栏左下角、丢弃用户拖拽过的位置，等价于「点抽屉外空白 + 归位」，并清 `activeThreadId`）；**黄键** = 只收起抽屉（球留在原地，不清 `activeThreadId`）；两者都**不再最小化窗口**。主进程侧**删除** `butler-orb:minimize-app` 通道与 `skipOrbOnNextMinimize` 标志（0.7.693 用它把「红键关闭」做成「连同 BobWork 一起收走且不留球」），`preload.ts` 的 `ButlerOrbApi` 由 7 键回退到 6 键（`onWindowState` / `onOpenInbox` / `dragStart` / `dragEnd` / `panelMinimize` / `panelClose`）。桌面板窗的两个出口不变。
* **球的「归位」信号在渲染层统一**（[ButlerOrb.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerOrb.tsx)）：主窗口内的悬浮球原先只监听主进程的 `butler-orb:window-state`（最大化 / 还原 / 进出全屏 → 偏移清零、弹回中栏左下角）；现新增一条 `BUTLER_ORB_HOME_EVENT` 监听 —— 抽屉红键「关闭」时同样把偏移清零并落盘。两条路径共用同一句处理，球无论在哪种触发下都回到「家」（中栏对话区左下角内缩 `ORB_EDGE_GAP`）。
* **Hippo 重复注册 ipcMain handler 导致主窗口不显示**（[hippo-browser.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/hippo-browser.ts) / [main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts)）：`setupHippoBrowser()` 会在应用启动、以及主窗口关闭后重新唤起（`activate` / `second-instance`，含自动更新后的重启）时被**多次调用**，而 `teardownHippoBrowser()` 只销毁窗口、**不注销** `ipcMain.handle`，重复注册会抛 `Attempted to register a second handler for 'hippo-browser:bm-list'` —— 该异常会中断 `openMainWindow` 里后续的 `loadURL` / `show`，**窗口永远不显示**。现把 handler 注册抽成幂等的 `registerHippoIpcHandlers()`（一次性标志，仅首次生效），`setupHippoBrowser()` 先 `teardown` 再注册；`main.ts` 另把 Hippo 初始化包进 `try/catch` + 记日志，Hippo 起不来也不再阻断主窗口显示。

## v0.7.693 (2026-10-10)

> 本版是 **v0.7.692 之后的悬浮球面板重做版**：把桌面悬浮球就地展开的那块「Butler 面板窗」从**复用移动端单栏 Butler 页**（420×640）换成**与 BobWork 里点球打开完全一致的桌面版 Butler 抽屉**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)，1020×880、最小 560×420），面板几何随之改写；并把面板窗与抽屉左栏打通成一条 IPC —— 新增 `butler-orb:minimize-app`（黄键「缩小到球」`keepOrb=true` / 红键「关闭并彻底收起」`keepOrb=false`，主进程据此**精确吃掉一次落球**），`ButlerOrbApi` 由 6 键增至 7 键。音频侧补齐**片段删除**。共 11 个源文件改动（4 改 + 7 新增）。

### 新增功能

* **桌面 Butler 面板改用桌面版抽屉**（[butler-panel/page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/butler-panel/page.tsx)）：原先「复用移动端单栏 Butler 页」的做法**废弃**（功能齐但形态不同），面板内容改为**同一个 `ButlerDrawer`**（左轨功能键 / 好友栏 / 中栏会话 / 右栏详情三栏布局），真正做到「和在 BobWork 中打开一致」。该页只补抽屉给不了的三件事：① 自己的 **30px 标题条**（整条 `-webkit-app-region: drag` 拖动区 + 「缩小」「关闭」两键，`z-index` 抬到抽屉透明挡板 1299 与面板本体 1320 之上，否则点击会被挡板当成「点空白收起」）；② **主题 / 字号跟随桌面端设置**（这个窗口没有主窗那套 Sidebar bootstrap，不自己拉一次会退回默认主题）；③ **收件箱保鲜**（30s 只读重拉 `/api/butler/inbox`，消费型轮询仍归主窗 ButlerNoticeHost，避免双消费竞态）。抽屉在 `mounted` 后再渲染 —— 抽屉按窗口尺寸算窄窗档位，SSR 首帧属性与客户端不一致会报 hydration mismatch（实测）。
* **面板几何按抽屉三栏反推改写**（[orb-geometry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/orb-geometry.ts)）：`PANEL_DEFAULT_SIZE {420,640} → {1020,880}`、`PANEL_MIN_SIZE {320,380} → {560,420}` —— 取值由桌面抽屉三栏合计（左轨 84 + 联系人 168 + 中栏 560 + 右栏 280 ≈ 1092）与其自适应高（`min(760, 86vh)`）反推，低于 1020 宽抽屉会切成窄窗版。`panelBoundsForOrb()` 签名泛化为 `(ballPoint, preferred, workArea, minSize, margin)`：仍**面板底边贴球底边**（看起来从球里长出来），可用区装不下首选尺寸先压到 `minSize`、连 `minSize` 都装不下退化为贴左上；`orbPointFromPanel(panelBoundsForOrb(p)) === p` 在未被钳制时仍严格成立（「缩小回原位」据此）。
* **左栏三色键 + `butler-orb:minimize-app`**（[preload.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/preload.ts) / [butler-orb.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/butler-orb.ts) / [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) / [ButlerHost.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerHost.tsx)）：抽屉左栏窗口键由「红关闭 + 绿缩放」补回**黄键「缩小」**，与 macOS 三色键同序同色 —— 红 = 收起抽屉 + 把 BobWork 一起收走、桌面**不留球**（`onCloseAll`，并清 `activeThreadId`）；黄 = 收起抽屉 + 收走 BobWork、桌面**留**球（`onMinimizeToOrb`，**不清** `activeThreadId`，回头点球仍回原会话）；绿 = 放大 / 还原。宿主各自实现（BobWork 侧 / 桌面面板窗），未接新语义的宿主黄键不渲染、红键维持「只收起抽屉」。新 IPC `butler-orb:minimize-app { keepOrb }`：`keepOrb=false` 时主进程立 `skipOrbOnNextMinimize` 标志，把**紧接着那一次 minimize 事件的落球吃掉**（用「标志 + 事件消费」而非直接 `hideOrb`，后者会被随后的 minimize 事件立刻覆盖、球又出来）；`keepOrb=true` 走常规最小化照常落球。`ButlerOrbApi` 由 6 键增至 7 键（+ `minimizeApp`），通道 `butler-orb:minimize-app`。桌面板窗的标题条两键仍映射到 `panelMinimize`（收成球，球停在面板当前所在位置）/ `panelClose`（球与面板一起从桌面消失）。
* **音频片段删除**（[library.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.ts) / [clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts) / [AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx)）：新增 `deleteClip(srcAbs, clipAbs)` 与新 action `delete_clip` —— 删磁盘文件 + 它的 marks sidecar + 从 `.clips.json` 移除该条（源音频本身不在此删，那走 `deleteEntry`）；两道闸：片段必须落在**当前源目录内**、必须**在该源清单里**（防借一个路径删任意文件）。画布音频查看器的片段行补上一颗 Trash 删除键（源音频行不提供删除）。

### 新增单测

* [orb-geometry.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/orb-geometry.test.ts) 的面板用例随新尺寸改写：新增「首尺寸按桌面抽屉三栏反推」断言（宽 ≥ 1000 —— 低于此抽屉会切成窄窗版；高 `× 0.86` ≥ 750，贴近抽屉上限 760），并把往返 / 钳制用例改用 1020×880 首尺寸与 560×420 最小尺寸重算（含「可用区 873 高放不下 880 → 压到 857、缩回时球落面板左下角、偏移在个位数像素」一档）。
* [library.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.test.ts) 新增 `deleteClip` 系列用例：删文件并从清单移除、连同它的 marks sidecar 一起删、只删指定片段（同源其它片段保留）、片段不在源目录 / 不在清单里 → 抛错。

## v0.7.692 (2026-10-10)

> 本版是 **v0.7.691 之后的安全加固版**：v0.7.691 放开了小程序权限（完全信任默认开 + `hostTool` 直通宿主全部工具），本版把由此引入的**两个严重暴露**逐一关闭 —— ① 沙盒相关路由原本**没有任何来源校验**、而服务监听在 `*:8321`，`bridge` 直通 `run_command`，等于**「未开启远程访问的安装」在局域网内可被无鉴权 RCE**；② `_appId` 由页面脚本自报，**导入的第三方小程序把 `_appId` 填成任意 built 小程序的 id 即可重新拿到 `run_command` 全量工具，还能写别人的私有数据目录**。同时修掉三个 P0（`DELETE /api/sandbox` 的 id 直传可 `../../` 递归删 `~/BobWork`、`manifest.entry` 未校验可越界读写、删除小程序后已打开的预览页仍可执行并把目录复活成幽灵目录），并把小程序预览搬进**站内 sandbox iframe**（不给 `allow-same-origin`）与**同源隔离**（宿主 `localhost` vs 预览 `127.0.0.1`）。此外悬浮球升级为**就地展开独立 Butler 面板窗**、音频片段支持**改名**、AI Coding 任务加**硬预算**。共 59 个文件改动（44 改 + 15 新增，含 7 个新增测试文件）。

### ⚠️ 安全：本版关闭的暴露，以及一处权限入口回退

* **① 同网段无鉴权 RCE → 新增本机来源闸**（新增 `src/lib/http/loopback-guard.ts`，`checkRequestSource()` / `guardRequestSource()` / `hostnameOf()`）：`/api/sandbox/bridge`、`/api/sandbox/chat-stream`、`/api/sandbox`、`/api/sandbox/import`、`/api/sandbox/export` 此前**自身没有任何来源校验**，而 dev/packaged 服务监听在所有网卡（`*:8321`）；只有 `/api/settings` 做了 loopback Host 闸。放开小程序权限后 `bridge` 直通 `run_command`，于是「默认未启用远程访问的安装 = 同网段任何设备可无鉴权 RCE」。三条规则：`Sec-Fetch-Site: cross-site` 一律拒；`Origin` 必须本机（远程访问开启时才额外放行 `Origin === Host`，供 Tailscale / Cloudflare 隧道域名）；Host 非本机时必须已启用远程访问（此时网关已要求 Bearer/Cookie）。**二轮封 DNS-rebind**：非本机 Host 一律**在路由层复验** Bearer / 会话 Cookie（rebind 时 `remoteAddress` 是 loopback，网关会豁免它，只能在这里验）。已接入 8 个沙盒路由（source-guard.test.ts 有 16 例断言）。
* **② 自报 `_appId` 提权 → 改为 HMAC 签名令牌**（新增 `src/lib/sandbox/app-token.ts`）：令牌格式 `v1.<appId>.<exp>.<sig>`，`sig = HMAC-SHA256('v1|<appId>|<exp>')` 的 base64url，密钥取 `settings.json` 的 `sandboxBridgeSecret`（缺失则随机生成 32 字节并写回）；有效期 `APP_TOKEN_TTL_MS = 12 小时`。预览路由签发并注入 `<meta name="bob-app-token">`，桥对每个请求带 `data._appToken`。校验用 `timingSafeEqual`，失败原因可区分（`malformed token` / `token expired (reload the preview page)` / `bad token signature` / `missing app token`）。**权威身份永远取自令牌**，自报值只在与之不符时记为冒充信号（`mismatch`）并写审计。
  * 桥 / 流式路由加**身份闸 + 存在性闸**：无令牌或无效 → **401**；令牌有效但 manifest 读不到 → **410** `mini-program not found or deleted`。`saveAppData` 等全部改用令牌解出的 appId —— **冒充者写不进被冒充者的私有 `data/` 目录**。
* **③ 权限入口回退（与 v0.7.691 的说明相反，请以此为准）**：v0.7.691 说「可在 Bob Sandbox 面板把完全信任关掉」，本版**移除了面板上的 `Full trust: ON/OFF` 开关**（`handleToggleFullTrust`、`ShieldCheck` 按钮、三级授权弹窗、`updateSandboxFullTrust` 写入口全部删除，`fullTrust` 变只读）。**现在撤回模型调用授权只能改 `settings.json`**（`sandboxChatPermissions["<appId>"] = "none"`，或删该表项配合 `sandboxFullTrust: false`），面板 tooltip 与错误文案都指明了这一点。
* **④ 站内预览与宿主不同 origin**（新增 `src/lib/http/preview-host.ts`）：宿主 UI 固定跑 `http://localhost:PORT`，小程序预览固定跑 `http://127.0.0.1:PORT` —— 两者是**不同 origin**，预览页（第三方 / AI 生成代码）再也读不到宿主的 localStorage / sessionStorage / Cookie；预览 origin 上再叠一层路由限制：**denylist 12 项**（`/api/settings`、`/api/local-files`、`/api/chat`、`/api/bobby`、`/api/mcp`、`/api/extensions`、`/api/plugin-panel`、`/api/plugin-panels`、`/api/remote-access`、`/api/agents`、`/api/skills`、`/api/setup`）拒；用 `127.0.0.1` 打开 UI 的 HTML 导航 302 回 `localhost`；`/api/sandbox/**`、`/api/dav/**`、静态资源放行。**CalDAV 在预览 origin 上只读**（`DAV_READ_METHODS = { GET, HEAD, OPTIONS, PROPFIND, REPORT }`）。
  * 注意：`previewOriginFor()` 对**非回环主机**（Tailscale IP / 隧道域名）原样返回 —— 这些场景没有这层同源隔离，只由来源闸 + 令牌兜底（测试已锁该行为）。

### 新增功能

* **应用内 sandbox iframe 预览（方案 B）**（新增 `src/lib/sandbox/iframe-bridge-host.ts`、新增 `src/components/canvas/SandboxPreviewFrame.tsx`）：iframe 用 `sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"`，**刻意不给 `allow-same-origin`** —— 文档 origin 变 opaque，读不到宿主存储、跨源 fetch 需预检，小程序的一切宿主调用只能走 postMessage，**宿主成为唯一裁判**。
  * 宿主桥只接受 `event.source === iframe.contentWindow`（sandbox iframe 的 origin 是 `'null'`，source 才是可靠判据），只处理 `bob_` 前缀消息；`bob_request` → `bob_response`、`bob_chat_stream` → `bob_chat_delta`* + `bob_chat_done`/`bob_chat_error`、`bob_chat_cancel` → `abort()`；并发流上限 `MAX_STREAMS = 4`。
  * `graph*` 动作**不走 HTTP 中继**：由注入的执行器在宿主渲染进程内跑（画布状态在渲染进程）；未注入时给出明确指引（`open this mini-program via "Preview" inside BobWork (not the Hippo window)`）。这条同时解释了 `executeGraphBridgeAction` 此前**一直没有调用方**。
  * 接线上 Preview 按钮派 `sandbox-preview-open`，由 `CanvasFlow.tsx` 监听并渲染 `SandboxPreviewFrame`；`CanvasFlow.tsx` 新增 `previewApp` state 与 `graphExecutor`（`requestPermission` 在 `resolveSandboxGraphPermission(...)==='control'` 时直接落盘，显式收紧后走 `confirmAsk` 确认框）。
* **导入包信任分级 + 宿主工具白名单**（`src/lib/sandbox/host-tools.ts`、`apps.ts`、`import/route.ts`）：`SandboxApp.origin?: 'built' | 'imported'`。`evaluateHostToolAccess()`（纯函数）：**NEVER 名单 9 个工具两种来源都禁**（`team_run` / `finish_task` / `todo_write` / `ask_user_questions` / `search_capabilities` / `update_provider_config` / `manage_mcp_server` / `manage_quick_launch` / `set_app_icon`）；`built` 其余全放行；**`imported` 只放行 `read_file` / `list_directory` / `search_files`，且路径归一后必须落在 `bob-sandbox/apps/<appId>` 自身或其后代内**。`SELF_ONLY_APPID_TOOLS = ['sandbox_rollback','sandbox_export']` 只能指向自己；并发闸 `MAX_CONCURRENT_PER_APP = 4`；所有拒绝都是 `success:false` + `BLOCKED: ` 前缀（不抛错）。manifest 缺 `origin` 一律按 `'built'`，只有 import 路由写死 `'imported'`。
* **删除级联 + 回收站**（新增 `src/lib/sandbox/app-lifecycle.ts`）：删除不再是 `rm -rf`，而是移入 `bob-sandbox/.trash/<appId>__<ts36>/` 并写 sidecar `trash-meta.json`；`deleteAppCascade()` = 入回收站 + 清该 app 的授权表项 + **解绑所有项目（含归档/回收站）`notes-memory/*.md` 里的 `sandbox_app_id:` 行（节点本体保留）**；`restoreApp()` 同名已存在则拒绝（不覆盖），`purgeTrashItem()` 彻底删；`listGhostAppDirs()` 巡出幽灵目录（只提示、**不自动删**）。
* **小程序文件配额与 `schemaVersion`**（`apps.ts`）：`APP_FILE_MAX_BYTES = 10MB`、`APP_TOTAL_QUOTA_BYTES = 50MB`、`APP_SCHEMA_VERSION = 1`；`checkAppQuota()` **覆盖写按 delta 计算**（不是简单累加）。此前只有 BobStorage 的 `data/` 有配额，入口 HTML / 资产可写满磁盘。
* **远程访问会话抽成共享模块**（新增 `src/lib/http/remote-session.ts`）：`REMOTE_COOKIE = 'bw_remote'`，Cookie 值 = `HMAC-SHA256(key=token, 'bw-remote-session-v1')`（httpOnly，token 本体不进浏览器 JS 可读范围），另有 `Authorization: Bearer <token>` 供 Expo 壳 / curl / strict 模式。原先这三段内联在 `src/server.ts`，因路由侧现在也要复验身份，抽成 `server.ts` 与 `loopback-guard.ts` 共用的同一份实现（避免参数漂移）—— **纯重构，行为不变**。
* **悬浮球就地展开独立 Butler 面板窗**（`electron/butler-orb.ts` / 新增 `src/app/butler-panel/page.tsx` / `electron/preload.ts`）：点桌面球不再把主窗从后台拽回来开收件箱，而是**就地长出一块 420×640 的独立面板窗**（新路由 `/butler-panel`，复用移动端完整 Butler 页），`BobWork` 保持最小化。
  * 新 IPC：`butler-orb:panel-minimize`（缩小 → 球回到**面板当前所在位置**）/ `butler-orb:panel-close`（关闭 → 球与面板一起从桌面消失，`dismissed` 期间不再出球，直到主窗回到前台）；`preload.ts` 的 `ButlerOrbApi` 由 4 键增到 6 键。⌘W / 系统关面板按「缩小」处理。
  * 面板窗只 `hide` 不 `destroy`（移动端页的会议控制台常驻挂载，卸载即停录）；面板刻意不预热（`prewarmButlerOrb()` 只预热球窗）。
  * **位置语义（以代码为准）**：球与面板**都不做贴边吸附、都不落盘**；球只在模块级 `freePoint`（内存态，按落点所在屏 `getDisplayNearestPoint` 钳制以支持跨屏），面板只在 `lastPanelBounds`（内存态），`collapseDesktop()`（`show`/`focus`/`restore`/`maximize` 触发）一并作废。`hideOrbWindow()` 不再清 `freePoint`（否则「缩小回原位」无从谈起）。
* **面板几何抽进纯函数**（`src/lib/butler/orb-geometry.ts`）：新增 `PANEL_DEFAULT_SIZE = {420, 640}`、`PANEL_MIN_SIZE = {320, 380}`、`panelBoundsForOrb()`（**面板底边 = 球底边**，按 workArea 压到最小尺寸后取整）、`orbPointFromPanel()`；`orbPointFromPanel(panelBoundsForOrb(p)) === p` 严格成立。
* **音频片段改名**（`src/lib/audio/library.ts` 的 `renameClip()`、`api/audio/clip/route.ts` 新 action `rename_clip`、`AudioViewer.tsx` 内联输入框）：磁盘文件名 + `.clips.json` + 打点 sidecar **三处同步**；扩展名沿用原片段；四道闸（必须在源目录 / 必须在清单里 / 名字非空 / 目标名不得已存在，不覆盖）。
* **Butler 抽屉栏宽可拖拽**（`ButlerDrawer.tsx`）：好友栏与对话栏右缘各加一条隐形热区（`cursor:ew-resize`），`CONTACTS_MIN_W = 140` / `CONTACTS_MAX_W = 320` / `CHAT_MIN_W = 300`，过 `DRAG_THRESHOLD` 才冻结基准、真拖过才落盘；新增落盘键 `butler.drawer.contactsW.v1`。拖好友栏只加在好友栏、对话栏宽度不变（基准取「实测宽 − rightWidth」，右栏是增量）。

### 修复与优化

* **P0 · `DELETE /api/sandbox` 的 id 直传 = 一条请求删掉 `~/BobWork`**（`apps.ts` 新增 `sanitizeAppId`，`route.ts` 三处接入）：基线把 `body.id` 直接交给 `join(appsRoot, id)` + `rm(recursive, force)`，`id:"../../"` 即用户全部数据。现在只放行 `^[A-Za-z0-9_-]+$` 且长度 ≤ 64，非法返 400；白名单铺到 `removeApp` / `readAppEntry` / `readAppFile` / `updateAppEntry` / `touchAppUpdatedAt` / `hasAppImplementation` / `writeAppFile`。
* **P0 · `manifest.entry` 是不可信字段 → 任意文件读 + 任意文本覆写**（`apps.ts` 新增 `safeChildPath`）：用 `resolve` 做包含性判定（必须等于 base 或在 `base + sep` 之下），拒空值 / `\0`；无论绝对路径、`..` 还是 Windows 分隔符都出不去。`readAppEntry` / `hasAppImplementation` / `updateAppEntry` / `readAppFile` / `writeAppFile` 全改走它。导入侧追加：entry 必须指向目录内**真实存在**的文件，否则回滚 + 400。
* **P0 · 删除后已打开的预览页仍能执行（还复活幽灵目录）**（`bridge.ts` 在 **schema 解析之前**加 `appExists`，`chat-bridge.ts` 第 0 步同步）：读不到 manifest 即抛 `mini-program not found or deleted`，`saveAppData` 不再把已删目录重建出来。
* **`_appId` 一整类隐藏故障被通用化修掉**（`bridge.ts`）：v0.7.691 只给 4 个 appData schema 补了 `_appId`，而客户端对**每个**请求都注入它，`.strict()` 下 `listNodes` / `getTheme` 这类「零字段」schema 仍不可用。现在在解析前显式剥离（`const { _appId, _appToken, ...payloadForSchema } = data` → `safeParse(payloadForSchema)` → 回填 `_appId: requestAppId` 让 handler 仍可按老写法读）。**这一步同时关掉了 v0.7.691 发布说明里「已知待确认」的整类问题**（当时列了 `readNode` / `writeWanted` / `searchSkills` / `listNodes` 等十余个未声明 `_appId` 的 `.strict()` schema）。
* **画布音频的打点不再落进 workspace**（`audio/library.ts` / `audio/marks.ts` / `clip/route.ts`）：v0.7.691 会在 `materials/` 里的音频旁就地生成 `materials/录音.marks.json`，等于应用产物污染资料树。现在 `sidecarPath()` 退化为纯命名函数、读写改为接绝对路径的 `readMarksFile` / `writeMarksFile`，并新增 `marksFileFor()`：**库内音频就地、库外音频进 `.audio-library/<源名>-<路径指纹>/` 影子目录**。
* **小程序路径判据 `.sandbox/` → `bob-sandbox/`（旧判据从不命中）**（`ChatNodeKernel.tsx` 三处）：真实目录是 `bob-sandbox/apps/`，所以「小程序文件改动后商城自动刷新」与文件卡的 `isSandboxApp` 此前**从来没生效过**。
* **AI Coding（绑定小程序）任务加硬预算**（`api/chat/route.ts`）：`CODING_TASK_MAX_ROUNDS = 25`、`CODING_TASK_MAX_MS = 10 分钟`；超限时注入一条收尾指令（要求用【未完成项】如实列出，不得声称完成未经预览验证的改动）、发 `task_budget_exceeded` 帧、置 `forceFinalRound`，**只触发一次**。动机：小程序迭代是「改码 → 预览截图 → 再改」的交替调用，单工具收敛/停滞保护难触发，叠加「失败被误判成功」可无限烧 token。
* **工具「失败」判定补上 MCP 原文前缀**（`api/chat/tools/index.ts` 抽出 `TOOL_ERROR_PREFIXES`，14 项，新增 `'Error from server'` 与 `'BLOCKED:'`）：MCP 服务端错误原文 `Error from server: …` 此前被判 `success=true`，依赖 `t.success` 的停滞保护永不触发。
* **截图结果：视觉描述前置 + base64 脱敏**（同上，新增 `redactImagePayload()`）：`capture_preview` 返回的完整 PNG base64（100KB+）会让 `maxOutput` 只保留前 N 字符，**描述追加在 base64 之后永远被截掉**，「每轮必做视觉自检」退化成模型凭空声称已自检。现在 `[截图视觉解读]` / `[视觉描述]` **挪到返回值最前面**，base64 替换为 `(omitted — saved to disk)`。
* **`sandbox_export` 相对资源内联判据修掉字符类陷阱**（`api/chat/tools/admin.ts`，新增 `isRelativeAssetPath()`）：原 `[^"'http]` 会把 `theme.css` / `print.css` / `tailwind.css` 这类**以 h/t/p 开头**的相对文件名一并跳过 → 导出页缺样式。现先宽松捕获 `href`/`src` 再判定（非 `//`、非 `/` 开头、非 `scheme:` 才内联）。
* **`sandbox_rollback` 的历史版本匹配与写回**（`admin.ts`）：`endsWith(basename)` → `parseHistoryName()`（同目录 `my-app.js` 的备份不再被算成 `app.js` 的版本）；写回改用 `writeAppFileAtomic()`（回滚前内容也进 `.history`、同步 `updatedAt`，失败时明确报错）。
* **审计日志从「单文件覆盖式裁剪」改为「按天 + 保留期」**（`bridge.ts`）：改到 `<APP_ROOT>/.logs/sandbox/audit-YYYY-MM-DD.jsonl`（原来在 `bob-sandbox/audit.log`，与小程序自己的目录混在一起、可被 `run_command` 顺手删掉，且 5MB 覆盖式裁剪会丢前半段历史），目录 `mode 0700`、文件 `0600`，按 `AUDIT_KEEP_DAYS = 30` 删过期文件。危险命令拦截表也补上抹日志的模式（`rm|mv|truncate|shred … .logs`、`> … .logs/`）。
* **`chat` 的超时预算不再落回 10s / 30s**（`bridge.ts` 新增 `CHAT_TIMEOUT = 120000`）：一次正常生成本就 20–60s，此前会被误判失败。
* **原子写的临时文件撞名与残留**（`apps.ts`）：原来 tmp 落在 app 根、只用 pid，并发写 `css/style.css` 与 `js/style.css` 会撞名互相覆盖，写失败还残留 tmp（被静态路由当资源返回、并被打进导出包）。现在 tmp 放**目标同目录** + `randomUUID().slice(0,8)`，`try/finally` 无条件清理。
* **导入 ZIP 的边界与半成品回滚**（`import/route.ts`）：`MAX_ZIP_BYTES = 50MB`、`MAX_ENTRIES = 5000`、`MAX_UNCOMPRESSED_BYTES = 200MB`；条目落盘改走 `safeChildPath`（原来只查 `includes('..')`）；解包失败即删目录并回 400（原来只返 500，留下不可见、白占磁盘的半成品）。
* **来源闸补齐到两个预览路由**：基线这两处**没有** `guardRequestSource`（注释写「此前这一处漏了」）。
* **导出包排除 `.history`**；**小程序列表 DTO 瘦身**（模板只回 `{id,label,description,entry}` —— 完整模板含源码与 `promptSeed`，实测每次列表 51KB）。
* **`chat-stream` 权限闸错误文案改为可执行指引**（`chat-bridge.ts`）：明说「无应用内开关，改 `settings.json` 的 `sandboxChatPermissions` 后重启」。
* **预览页 AI 徽标整段撤除**（`preview/[id]/route.ts` −155 行）：删掉 `buildAiBadgeInjection()` 与 `injectIntoBodyStart()`；`SandboxApp.aiBadge` 标 `@deprecated`。
* **预览页缺 `<title>`**：无自带 title 时注入 `<title>${app.name} · BobWork</title>`（做 HTML 转义），Hippo 标签栏可辨。
* **标星表死图标回收**（`sandbox-starred.ts` 新增 `pruneStarredApps()`）：删除/改名后按当前清单过滤，有变化才写盘并派事件。
* **权限 chip 的起点与持久化语义**（`SandboxPanel.tsx`）：基线点击从 `?? 'none'` 起算、显示却按 `?? (fullTrust ? 'control' : 'none')` —— 会把显示为 Control 的项一键降成 Read、且 None 永不可见；现起点与显示一致，并改**显式写入**（含 `'none'`），不再 `delete permissions[appId]`。
* **Esc 分层**（`SandboxPanel.tsx`）：原来子弹窗里按 Esc 会直接关掉整个商城、填了一半的表单全丢；现在按 `starDialog → confirmDelete → trashOpen → apiDocsOpen → createOpen → onClose` 只关最上层。

### 改进

* **iframe 模式下的 `targetOrigin` 与消息来源判定**（`bridge.ts`）：新增 `IN_IFRAME` 与 `HOST_TARGET_ORIGIN = IN_IFRAME ? '*' : resolveTargetOrigin()` —— sandbox iframe 读不到 `parent.location.origin`，对父窗口只能用 `'*'`，安全性由「宿主校验 `event.source === iframe.contentWindow`」+「入口页 CSP 不允许第三方嵌入」两侧共同保证。接收侧新增 `isFromParent(event)`，桥响应与 `chatStream` 两个监听都先过这层。
* **opaque origin 下的存储退路**（`bridge.ts` 新增 `LS` 门面 + `memoryStore`）：sandbox iframe 里访问 `localStorage` 会抛 `SecurityError`，`LS.*` 捕获后退化为**内存存储**；`BobStorage.*` 与软刷新快照全部改走 `LS`。
* **审计可定位「谁写了什么 / 跑了什么」**（`bridge.ts` 新增导出 `summarizeHostToolCall()`）：产出如 `read_file path=homework/a.md`、`run_command cmd=ls -la`、`write_file path=… (12B content)` —— 路径截 160 字符、命令截 120 字符，`content`/`script` **只记字节数、绝不记正文**；`AuditEntry` 新增 `detail` / `claimedAppId` / `spoofSuspected`。
* **预览路由的 CSP 与 iframe 准入**：`frame-ancestors 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*`，并**移除 `X-Frame-Options: SAMEORIGIN`**（它会把跨 origin 的宿主内嵌一并拦掉，`frame-ancestors` 已能做同样的事且能精确到回环白名单）。
* **波形打点从「零宽 region 小旗标」改为波形上方圆点**（`AudioMarkTrack.tsx`）：圆点由 `marks` + `duration` 直接派生（悬浮显示标签或 `mm:ss`、点击跳转）；选区补两个出口（零宽 region 自动移除、点空白退出、旁加 ✕ 清除），并用 `suppressClickUntilRef`（+300ms）抑制拖拽收尾的 click。
* **`sandbox_rollback` / `sandbox_export` 对 coding agent 开放**（`tools/registry.ts`）：`['admin']` → `['admin','coding']` —— 唯一会写坏小程序的 agent 必须能回滚/导出。
* **小程序运行时提示词大面积改写**（`lib/runtime/context.ts` 6 处）：`aiBadge` 标为已废弃（宿主不再注入任何 AI 状态徽章）；`BobStorage` 补第 3 层 `writeWanted` 与「`set` 超 500KB 或序列化失败**静默返回 false**，写入前应判返回值」；`graph*` 改为**运行位置决定能力**；`hostTool` 把 `rollback_sandbox_file` 换成 `sandbox_rollback { appId, file, action }`，并把护栏细化为「只保护 `butler/` 下 `preferences.md`、`roles.json`、`notify-state.json` 等**根文件**，不是全局安全边界」；模型调用段改「`chatStream` 一律优先（`chat` 非流式、客户端 120s 超时）」；CSS 变量 44 → **61 个**。
* **小程序查看入口说明改到 ⌘F 面板**（`api/chat/route.ts`）：入口已不在左侧边栏。
* **画布 Coding 节点 ▶ 改为站内沙箱预览**（`ChatNodeKernel.tsx`）：**Alt 或 Shift+点击**才走 Hippo 全窗口。

### 界面细节

* **商城可用性**（`SandboxPanel.tsx`）：新增搜索框（匹配 `name + description + id`，不区分大小写）与排序下拉（`Recently updated` / `Recently opened` / `Name`，名称用 `localeCompare('zh-Hans-CN')`）；「最近打开」持久化在 `localStorage['bobwork.recent-sandbox-apps']`，卡片显示 `· Opened <时间>`；无匹配时给出 `No mini programs match "<query>"` + `Clear search`（与「一个小程序都没有」的空态区分）。
* **回收站弹窗 + 内联操作提示**：标题栏 `Trash (n)`（仅有内容时出现）打开 `Recycle Bin`，逐条 `Restore` / `Delete forever`，并提示「另有 n 个无 manifest 的孤儿目录…需要时手动删除」（**不自动删**）；操作结果用顶部可关闭的内联提示呈现（基线是静默 `catch {}`）。
* **`Imported` 徽章与 AI 权限 chip 降为只读**：`origin === 'imported'` 加徽章（tooltip 说明「三方代码：宿主工具只读且限自己目录」）；模型调用 chip 从按钮变 `<span>`，只有 `AI: on` / `AI: off`，tooltip 指明改 `settings.json`。
* **预览入口一分为二**：新增 `Preview`（品牌色 `Play`，站内 sandboxed iframe），`Hippo` 降为 `outline` + `Globe`（全窗口、走 HTTP 中继）。
* **顶部去掉「完全信任」开关**：`fullTrust` 变只读，API 文档区文案改为 `Full trust is ON/OFF (global, set via settings.json → sandboxFullTrust; no in-app switch)`。
* **预览浮层带标题栏与自证来源**（新增 `SandboxPreviewFrame.tsx`）：`h-[86vh] w-[1100px]` 模态卡片，标题栏显示 app 名 + `sandboxed preview` 徽章 + `<appId> · <预览 origin>`，右侧 `Reload` / `Hippo` / 关闭（Esc 可关）；未拿到 origin 前先渲染 `Loading…`（避免 iframe 用宿主 origin 起跳）。
* **面板窗标题条**（`butler-panel/page.tsx`）：30px 高、整条可拖（`-webkit-app-region: drag`），两个 26×22 按钮（`Minus` 缩小 / `X` 关闭，关闭键 hover 用 `--danger` 底色），均带中文 `title`/`aria-label`。
* **纯滑块滚动条 `.thumb-scroll`**（`globals.css`）：`scrollbar-width: thin` + `color-mix(...)` 半透明滑块、轨道/按钮全透明；当前应用点是 Butler 对话消息区。
* **日历面板改为悬浮圆角卡片**（`CalendarPanel.tsx`）：`top-0 h-full` → `top-2 bottom-2` + `rounded-2xl` + 四边描边，`maxWidth` 收到 `calc(100vw - 16px)`。

### 新增单测

* 新增 **7 个测试文件 / 60 例**：`src/lib/sandbox/source-guard.test.ts`（16 例，来源闸 + 信任分级 + 同源隔离 + 脱敏）、`iframe-bridge-host.test.ts`（12 例，含**源码级守卫**：`sandbox` 属性含 `allow-scripts`、**不含** `allow-same-origin`/`allow-top-navigation`）、`security-hardening.test.ts`（7 例，DNS-rebind + 远程会话助手 + 设置脱敏）、`app-token.test.ts`（7 例，含「imported 冒充 built 时 `run_command` 仍 BLOCKED、`saveAppData` 写进真实调用者目录」）、`data-hygiene.test.ts`（6 例，配额 delta / 历史文件名 / 审计不记正文）、`prompt-consistency.test.ts`（6 例，提示词与实现一致性）、`app-lifecycle.test.ts`（6 例，`sanitizeAppId` / `safeChildPath` / 级联删除与恢复全链路）。
* 已有测试文件增补：`audio/library.test.ts`（+7 例：`marksFileFor`、`renameClip`）、`butler/orb-geometry.test.ts`（+8 例：面板展开/缩小往返与副屏偏移）、`sandbox/full-trust.test.ts`（用例数不变，补齐存在性闸所需的前置目录）。
* 全仓 `pnpm test` **112 文件 / 1235 例全绿**（较 v0.7.691 的 1160 例 **+75 例**）；`tsc -p tsconfig.json` 通过。

### 已知待确认（不在本版修复范围）

* **`sandboxBridgeSecret` 未被脱敏**（`settings-server.ts`）：`SECRET_FIELD_RE = /^(apikey|password|token|accesstoken|apisecret|clientsecret|secret)$/i` 是**整名匹配**，实测 `sandboxBridgeSecret` **不命中**，因此 `GET /api/settings` 仍会**明文返回这个 appId 令牌签名密钥** —— 而设置文件本身是加密落盘的，等于绕过了磁盘密文那层。预览 origin 已被 denylist 挡住 `/api/settings`，风险面限于本机其他进程 / 回环客户端。
* **已配置密钥无法再通过 API/UI 清空**（`preserveStoredSecrets()`）：提交空串会保留旧值，只能手改 `settings.json`。
* **`rotateSandboxBridgeSecret()` 全仓无调用点、无 UI**：用户无法主动使已签发令牌失效。另外 `settings.json` 的两个新字段（`sandboxBridgeSecret` / `calendarDavWritableOnPreviewHost`）**都没有设置面板入口**。
* **打点 sidecar 无迁移**：v0.7.690/691 期间写在项目里的 `*.marks.json`（旧位置）升级后**读不回来**，也没有清理逻辑。
* **`butler-orb:open-inbox` 已无发送方**（v0.7.691 由被删的 `activateFromOrb()` 发），但 `ButlerHost.tsx` 的监听仍在。
* **`NEVER_BRIDGE_TOOLS` 头注释漏列一项**：注释写成 4+4=8 个，数组实际 9 个（多 `search_capabilities`），行为以数组为准。
* **配额口径**：`writeAppFile` 的 `dirSizeBytes()` 递归整个小程序目录，**包含 `data/` 与 `.history`** —— 文件写入配额与存储/历史快照共用同一份 50MB 预算。
* **非回环主机没有同源隔离**（`previewOriginFor` 对 Tailscale / 隧道域名原样返回），只由来源闸 + 令牌兜底（测试已锁该行为）。
* **`task_budget_exceeded` 帧在 `src/` 内无消费方**（与既有 `tool_convergence` 同款）。
* v0.7.691「已知待确认」里的 **graph 权限读取**（`getSandboxGraphPermissionServer()` 无调用点、仍走 `lib/graph/graph-bridge.ts`）本版**未闭环**。

## v0.7.691 (2026-10-10)

> 本版是 **v0.7.690 之后的增量**，两条主线：其一，**小程序（沙盒）权限放开** —— 新增「完全信任」开关并**默认开启**，小程序由此可直接调用宿主工具注册表里的**全部工具**（新增 `hostTool` / `listHostTools`，与画布 AI Agent 同权），模型调用 / 画布对接 / 写盘确认**都不再弹窗**（要收回权限必须显式关闭开关或逐项 Revoke）；其二，**Butler 悬浮球独立成真窗口** —— 主窗口最小化 / 关闭后球仍留在桌面（新增 `electron/butler-orb.ts` + `/butler-orb` 页），主窗口内那颗球的位置语义也从「视口绝对坐标」改为「相对中栏左下角的偏移」。顺带修掉三处隐蔽故障：BobStorage 磁盘层全量失败（历史 203 次 `loadAppData` / 36 次 `saveAppData`）、`chatRequestPermission` 服务端**根本没实现**、预览页 AI 徽标恒显「已授权」。共 23 个文件改动（15 改 + 8 新增）。

### ⚠️ 权限姿态变化（请先读这条）

* **小程序默认获得宿主工具的全量能力**（`src/lib/settings.ts` 新增 `sandboxFullTrust`，`DEFAULT_SANDBOX_FULL_TRUST = true`）：`undefined` 视作**开启**，即新装 / 未配置的用户**默认处于完全信任**。开启时小程序可 `BobWork.host(name, args)` 调用**任意**宿主工具 —— `read_file` / `write_file` / `list_directory` / `run_command` / `execute_script` / `butler_*` / `create_project` / `notes_*` / `mcp__*` 等，与画布里的 AI Agent **同一注册表、同一权限**；画布对接解析为 `'control'`（可读可写画布）、模型调用解析为 `'permanent'`。
* **确认框被跳过**（`src/lib/sandbox/bridge.ts`）：桥脚本收到 `buildBridgeClientScript(id, { fullTrust: true })` 后 `manual = !FULL_TRUST && …` 恒为假，`MANUAL_CONFIRM_ACTIONS` 里的人工确认型动作（写盘、执行命令等）**不再弹确认**。代码注释明确保留的边界是「服务端仍有写盘护栏与审计」。
* **只认显式拒绝**：`isSandboxFullTrust()` 的实现是 `settings.sandboxFullTrust !== false`；逐项授权表里的**显式表项优先**（含显式 `'none'` = 用户在面板点过 Revoke），无表项才回落到完全信任开关。因此**要收回权限必须显式关闭开关或逐项 Revoke**，「没配过」= 放开。
* 配套：逐项拒绝不再靠删键 —— `updateSandboxChatPermission(appId,'none')` / `updateSandboxGraphPermission(appId,'none')` 由 `delete permissions[appId]` 改为写入**显式 `'none'`**（默认放开下「删键 = 回到默认 permanent/control」，面板 Revoke 会形同虚设）。
* 若不希望默认放开，发布后应在 Bob Sandbox 面板把完全信任关掉（写入 `sandboxFullTrust: false`）。

### 新增功能

* **小程序「完全信任」开关（默认开）+ 权限解析纯函数**（`src/lib/settings.ts` / `src/lib/settings-server.ts`）：新增 `AppSettings.sandboxFullTrust?: boolean`、`DEFAULT_SANDBOX_FULL_TRUST = true`、`isSandboxFullTrust(settings) = settings.sandboxFullTrust !== false`（`undefined` = 开）。
  * 新增 `resolveSandboxChatPermission()` / `resolveSandboxGraphPermission()`：**显式表项优先**（含显式 `'none'`），无表项才回落开关 → `'permanent'` / `'control'`；旧版 boolean 兼容（`true` → `'permanent'`，`false` → `'none'`）。`SandboxChatPermission = 'none' | 'per_call' | 'permanent'`。
  * 服务端侧新增 `getSandboxChatPermissionServer()` / `getSandboxGraphPermissionServer()` / `isSandboxFullTrustServer()`（均走 `readSettingsFromFile()`）；客户端侧新增 `getSandboxFullTrust()` / `updateSandboxFullTrust()`。
  * 设置入口在 `src/components/canvas/SandboxPanel.tsx`（`ShieldCheck` + `Full trust: ON/OFF`）；每张应用卡的有效级别改为 `permissions[id] ?? (fullTrust ? 'control' : 'none')` / `chatPermissions[id] ?? (fullTrust ? 'permanent' : 'none')`，并新增 `AI Full` 标签区分「无显式表项、由完全信任授予」与旧 `AI On`（显式 permanent）。

* **小程序直通宿主工具：`hostTool` / `listHostTools`**（新增 `src/lib/sandbox/host-tools.ts`）：`runHostTool(name, args)` 调 `executeTool()`、`listHostTools()` 调 `listAllToolDefs()`（name / description / category / scenes），返回 `{ success, result, durationMs }`；未知工具名走注册表自身的失败返回，**不抛错**。桥客户端新增 `window.BobWork.host(name, args)` 与 `BobWork.listHostTools()`；`hostTool` 走独立的 `HOST_TOOL_TIMEOUT = 600000`（10 分钟，`run_command` / `execute_script` 可能跑很久），其余动作仍是页内 10s / 中继 30s / 人工确认型 `MANUAL_CONFIRM_TIMEOUT = 120000`。
  * 该落地层**必须静态 import** 工具注册表（原因写在文件头注释）：最初在路由处理函数里 `await import('@/app/api/chat/tools')`，实测会让 dev server 整体挂死 —— hostTool 请求永不返回，随后同进程**所有**路由（含 `/api/sandbox`、`/api/tools`）一起超时；改为静态 import 后与 `/api/tools` 同款依赖图，编译一次、请求正常。

* **Butler 悬浮球独立置顶窗**（新增 `electron/butler-orb.ts` / `src/app/butler-orb/page.tsx` / `src/components/butler/ButlerOrbVisual.tsx`）：
  * 主窗口 `minimize` / `hide` / `closed`（macOS 关窗不退出）→ 显示球窗，落在**主窗所在屏幕 `workArea` 左下角**；`restore` / `show` / `focus` / `maximize` → 收球。`⌘H`（`app.isHidden()`）**不出球**（「全藏」不等于「最小化」）。
  * 窗口：`frame:false` + `transparent:true` + `alwaysOnTop('floating')`、`showInactive()` 显示；`focusable:false` + `acceptFirstMouse:true`（不偷主窗输入焦点、首击仍可收）；`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen:true, skipTransformProcessType:true })`（不带 `skipTransformProcessType` 会把进程转成 UIElement、**Dock 图标消失**）；刻意不用 `parent: mainWindow`（macOS 子窗会跟父窗一起最小化）。
  * 拖拽在主进程做：`butler-orb:drag-start` 收到指针在窗内的抓取偏移后，每 `DRAG_INTERVAL_MS = 16`（≈60fps）用 `screen.getCursorScreenPoint()` + `setBounds()` 跟手，并按**光标所在屏** `workArea` 用 `clampOrbPointInRect()` 钳制（可跨屏、不会拖丢）。**独立球窗不做贴边吸附，也不落盘记忆位置** —— 拖动只记在模块级 `freePoint`（内存态），收球时（`hideOrb()`）即作废，下次最小化重新落回桌面左下角。
  * `butler-orb:drag-end` 的 `moved=false` 视作点击 → `ensureMainWindow()` 恢复 / 重建并聚焦主窗，再发 `butler-orb:open-inbox`；主窗内容未加载完时按 `did-finish-load` + 600ms + 1600ms 补发三次。点击球经 `ButlerHost.tsx` 新增的 `window.api.butlerOrb.onOpenInbox` 派 `BUTLER_INBOX_EVENT`（`detail.toggle=false` = **幂等打开**收件箱，不 toggle 关闭）。
  * `/butler-orb` 页的未读角标自己轮询（`REFRESH_MS = 30_000`），因为该路由刻意不挂宿主。球窗尺寸 `ORB_WINDOW_SIZE = ORB_SIZE(34) + ORB_WINDOW_PAD(10) × 2 = 54`。

* **球的几何算术抽成零依赖纯模块**（新增 `src/lib/butler/orb-geometry.ts`）：`ORB_SIZE = 34`、`ORB_EDGE_GAP = 16`、`ORB_MIN_MARGIN = 8`、`ORB_WINDOW_PAD = 10`、`ORB_WINDOW_SIZE = 54`；导出 `clamp` / `clampOrbPoint` / `clampOrbPointInRect` / `orbPointFromOffset` / `orbOffsetFromPoint` / `orbPointAtRectBottomLeft` / `orbWindowBounds` / `canHostOrb(rect)`（`width/height > ORB_SIZE * 3` 才算可用锚点）。渲染层、主进程球窗、单测三处共用一份，避免各写一遍漂移。

* **应用级宿主收拢到 `AppHosts`**（新增 `src/components/AppHosts.tsx`，`src/app/layout.tsx` 改为挂它）：根 layout 原直接挂 `ScreenOcrHost` / `BobbyAuthHost` / `ButlerHost`，而根 layout 是所有窗口共用的 —— 独立球窗也会继承，于是 54px 球窗里会重复跑通知轮询（主窗最小化期间重复弹桌面通知）、在球上渲染截图编辑蒙版。现收进 `AppHosts`，`BARE_ROUTES = ['/butler-orb']` 直接 `return null`。

### 修复与优化

* **BobStorage 磁盘层全量失败（历史 203 次 `loadAppData` / 36 次 `saveAppData`）**（`src/lib/sandbox/bridge.ts`）：客户端桥对**每个**请求都自动注入 `data._appId = APP_ID`，而 `ActionSchemas` 里 `saveAppData` / `loadAppData` / `listAppDataKeys` / `deleteAppData` 都是 `.strict()` 且未声明 `_appId` → 每次被判 `Unrecognized key`。四个 schema 现补 `_appId: z.string().max(64).optional()`。
* **`chatRequestPermission` 从「Unknown action」补成真实现**（`src/lib/sandbox/bridge.ts`）：基线里它只出现在 `BRIDGE_ACTIONS` 元数据、zod schema 与 `MANUAL_CONFIRM_ACTIONS`，`switch` 里**没有 case**；现返回 `{ granted: level !== 'none', level }`，完全信任下 `granted:true / level:'permanent'`，不弹任何确认框。
* **预览页 AI 徽标恒显「已授权」**（`src/app/api/sandbox/preview/[id]/route.ts`）：旧代码对**字符串**取布尔（`!!g`，`'none'` 也是真值）→ `data-granted` 永远 `"true"`（绿点 + tooltip "granted"），点徽标只提示 "AI on · toggle off in left panel"，无法用来申请授权。现改为 `g !== 'none'`。
* **服务端权限读取退化为空配置（「每次都要问一次」的根因之一）**（`src/lib/settings-server.ts` / `src/lib/sandbox/chat-bridge.ts` / `bridge.ts` / 两个 preview 路由）：`lib/settings.ts` 的 `loadSettings()` 在 Node 端没有 window / Electron IPC，会退化为 `defaultSettings()`，于是桥里 `chatGetPermission`、预览页徽标永远读到「未授权」。现新增 `getSandboxChatPermissionServer()` 走 `readSettingsFromFile()`，`handleBridgeRequest` 的 `chatGetPermission` / `chatRequestPermission`、两个 preview 路由、`executeSandboxChat` 的权限闸全部改走服务端读取。
* **模型调用权限闸改为「显式拒绝才拦」**（`src/lib/sandbox/chat-bridge.ts`）：`permGranted`（要求显式 `true` / `permanent` / `per_call`）改为 `resolveSandboxChatPermission(settings, appId) === 'none'`；错误文案从「请先调用 chatRequestPermission」改为「该小程序被显式撤销（explicit deny），请在 Bob Sandbox 面板重新开启或设 `sandboxFullTrust=true`」。
* **主窗口内悬浮球的两处行为缺陷**（`src/components/butler/ButlerOrb.tsx`）：① 拖拽 / 点击判定旧代码用「新旧位置之差 > 0」（依赖异步 state，判定不可靠），改用按下点位移 `Math.hypot(...) > DRAG_THRESHOLD(4)`，并补 `pointercancel` 收尾；② 位置键语义作废 —— `butler.orb.pos.v2`（视口绝对坐标）→ `butler.orb.offset.v1`（相对中栏左下角的偏移），并加 `Number.isFinite` 校验（旧值当偏移用会把球直接甩到视口外）。

### 改进

* **球的位置改为「锚点 + 偏移」，锚点一动球跟着动**（`src/components/butler/ButlerOrb.tsx`）：旧实现存视口绝对坐标，左侧栏 / 导航折叠、右栏显隐、窗口缩放时球杵在原地。现在 `measureAnchor()` 测 `[data-host-canvas]` 的 `{ left, bottom }`（`canHostOrb` 不满足则退回视口左下角），落盘的是偏移，刷新后能还原。三层锚点跟踪：`ResizeObserver` 观察中栏**及其父元素**（并覆盖「切项目整块重挂」，观察对象变了换绑）+ `ANCHOR_RECONCILE_MS = 500` 兜底重测 + `resize`；中栏未挂载时 rAF 等，上限 `HOST_WAIT_FRAMES = 120` 帧（≈2s）。亚像素抖动（< 0.5px）不触发重渲染。未测到锚点前不渲染（避免先落在视口角上跳一次）；渲染点 = 家 + 偏移后再 `clampOrbPoint` 钳回视口。主进程在 `maximize / unmaximize / enter-full-screen / leave-full-screen / restore` 派 `butler-orb:window-state`，渲染层收到即**清零偏移并落盘**（弹回中栏左下角）；`SKIP_ROUTES = ['/browser-chat', '/butler', '/butler-orb']` 上不显示。
* **主窗口生命周期收口，三处唤起共用一条路径**（`electron/main.ts`）：新增 `createMainWindow()`（= `createWindow()` + `bindButlerOrbMainWindow(win)`）与 `openMainWindow()`（存在则 `restore + show + focus`，不存在则重建 + `loadURL` + `ready-to-show` 后 show）。`second-instance`、`activate`、点击桌面球三处统一走 `openMainWindow()`；`app.isReady()` 未就绪时等 `whenReady` 再走一遍。每次重建主窗都重新绑球窗监听（否则重建后最小化不再出球）。
* **球窗预热与退出销毁**（`electron/main.ts` / `electron/butler-orb.ts`）：服务就绪后 `prewarmButlerOrb()` 提前建窗加载 `/butler-orb` 并保持隐藏（消除首次最小化「先空窗再出球」的迟滞）；`before-quit` 调 `disposeButlerOrb()`，否则退出时主窗 `closed` 又会把球窗显示出来。`setupButlerOrb({ enabled: process.platform === 'darwin' })`，非 macOS 整个模块退化为空操作。
* **两个 preview 路由把信任级别透传给桥脚本**（`src/app/api/sandbox/preview/[id]/route.ts` + `[id]/[...path]/route.ts`）：改为 `buildBridgeClientScript(id, { fullTrust: await isSandboxFullTrustServer().catch(() => true) })` —— 读取设置失败时 `catch(() => true)` 按**信任**兜底，避免一次读配置异常把小程序打回「处处要授权」。`buildBridgeClientScript(appId, opts?)` 签名扩参，缺省 `fullTrust = opts?.fullTrust !== false`（不传即开）。
* **切换完全信任后广播权限变更**（`src/components/canvas/SandboxPanel.tsx`）：派 `sandbox-chat-permission-changed`（`appId:'__global__'`、`level: permanent|none`），写盘失败则回滚开关状态。
* **小程序提示词随权限模型改写**（`src/lib/runtime/context.ts`）：「画布对接 API」标题去掉「需要对接画布时主动申请授权」；原「使用前调用 `graphRequestPermission` 申请授权、未授权会 reject」改为「**完全信任模式下默认已授权**（`graphGetPermission` 返回 `level:'control'`，不再弹确认框），可直接调用」；并新增「宿主全能力直通（hostTool）」整段（发现能力 / 调用写法 / 常用工具名 / 硬护栏：`butler/` 真源不可覆盖、破坏性命令先说明、每次调用落 `bob-sandbox/audit.log`）。

### 界面细节

* **设置弹窗底部条只在有保存反馈时出现**（`src/components/canvas/SettingsModal.tsx`，**与沙盒设置无关**）：底部 `border-t` 条整体包进 `{(saveError || saveStatus === 'saved' || saveStatus === 'saving') && …}`，正常浏览时不再占一条横向栏位；同时删掉条内的 `Close` 按钮（标题栏已有 X）、`mr-auto` / `justify-end` 一并去掉。右侧面板容器加 `hide-scrollbar`(容器仍可滚动、不显示滚动条)。
* **Sandbox 面板的完全信任入口与文案**（`src/components/canvas/SandboxPanel.tsx`）：标题栏加 `ShieldCheck` + `Full trust: ON/OFF`（tooltip 说明开关语义）；`BRIDGE_ACTIONS` 补 `hostTool` / `listHostTools`，`chatRequestPermission` 描述改为「不再弹窗（显式撤销才拒）」、returns 补 `level`；帮助文本追加 `BobWork.host(name, args)` 与 `listHostTools` / `read_file` / `write_file` / `list_directory` / `run_command` / `create_project` 示例；给已 Revoke 的小程序追加「全局完全信任已开，下面选择只对该应用生效」。
* **独立球窗的皮肤加厚与透明底**（`src/components/butler/ButlerOrbVisual.tsx` / `src/app/butler-orb/page.tsx`）：透明 BrowserWindow 的 `backdrop-filter` 拿不到窗口背后的桌面像素 → 独立态 `.butler-orb.standalone .ball` 去掉无效的 `backdrop-filter`、加重中心晕与边缘暗化补回体积；投影换成小半径（窗外框只有 `ORB_WINDOW_PAD = 10px` 内边距，主窗那套 `0 9px 24px` 会被窗口边缘切出直边）；该内边距同时要容下未读角标（溢出球体 2px）与 hover `scale(1.05)`。页面用 `<style>` + 内联样式双保险抹掉 `globals.css` 给 `body` 上的底色（否则透明窗糊一层灰底），并加 `user-select:none`。
* **球体外观抽成一份，两个宿主共用**（`src/components/butler/ButlerOrbVisual.tsx`）：`OrbGlassStyle()`（玻璃皮肤 / `has-unread` 暖琥珀变量 / 河马脸 `inset:13.25%`）与 `OrbFace({ unread, tiltDeg, dragging })`；`ButlerOrb.tsx` 里原来内联的整段 `<style>` 与角标 JSX 全部搬走 —— 交互两边各自实现，外观只留一份。
* **IPC / 类型面**（`electron/preload.ts` / `src/types/global.d.ts`）：`ButlerOrbWindowState = 'maximize' | 'unmaximize' | 'enter-full-screen' | 'leave-full-screen' | 'restore'`，`ButlerOrbApi { onWindowState, onOpenInbox, dragStart, dragEnd }`，通道名 `butler-orb:window-state` / `butler-orb:open-inbox` / `butler-orb:drag-start` / `butler-orb:drag-end`。

### 新增单测

* 新增 `src/lib/butler/orb-geometry.test.ts`（6 个 describe / **13 例**）：`clamp` 的区间与 NaN / ±Infinity 边界、「视口比球还窄时 min > max 取 min」、偏移 ↔ 落点互逆（拖拽落盘再读回不漂移）、侧栏折叠时同一偏移跟着锚点平移、`clampOrbPoint` 四向贴边保留 `ORB_MIN_MARGIN`、主窗内容区与屏幕 `workArea`（含 Dock / 菜单栏 / 副屏正偏移）左下角落点、独立态在 `workArea` 内钳制、`orbWindowBounds` 取整与内边距、`canHostOrb` 的 3 倍尺寸门槛。
* 新增 `src/lib/sandbox/full-trust.test.ts`（3 个 describe / **10 例**）：默认完全信任（`undefined` = 放开）与显式 `false` 回落、无表项 = `permanent` / `control`、显式 `'none'` 压过开关且不波及其他 appId、显式 `per_call` / `read` 照常生效；桥脚本含 `var FULL_TRUST = true;` / `!FULL_TRUST && MANUAL_CONFIRM_ACTIONS` / `HOST_TOOL_TIMEOUT` 且暴露 `host: function(name, args)`、`request('hostTool'`、`request('listHostTools'`；服务端侧用 `BOBWORK_HOME` 指向 `mkdtempSync` 临时根隔离，断言 `chatRequestPermission` 返回 `granted:true / level:'permanent'`，appData 四动作接受自动注入的 `_appId`。
* 全仓 `pnpm test` **105 文件 / 1160 例全绿**；`tsc -p tsconfig.json` 通过。

### 已知待确认（不在本版修复范围）

* `src/lib/sandbox/bridge.ts` 里仍有若干 `.strict()` schema 未声明自动注入的 `_appId`（`readNode` / `writeWanted` / `searchSkills`，以及 `listNodes` / `getProjectInfo` / `getTheme` / `listActions` / `readWanted*` / `getNodeAncestorChain` / `getNodeManifest` / `listConfiguredModels` / `listProjects` / `getAppConfig` / `listCalendarEvents`）。客户端对**每个**请求都注入 `_appId`，这些动作可能仍被判 `Unrecognized key`（本版只修了 4 个 appData schema），待实测确认。
* `getSandboxGraphPermissionServer()` 目前**无调用点**（graph 权限仍走 `src/lib/graph/graph-bridge.ts` → `lib/settings.getSandboxGraphPermission()`，其在 Node 端是否同样退化未验证）；因默认 `fullTrust=true` 解析为 `'control'`，默认行为不受影响，**关闭开关后**的表现待确认。

## v0.7.690 (2026-10-10)

> 本版是 **v0.7.689 之后的增量**，两条主线：其一，把**音频编辑**做进应用 —— 会议回放与画布音频查看器统一换成一套**波形打点轨**（在真实播放时刻打点 / 拖拽选区用 ffmpeg 截片段），并新增一份**不进 workspace 的应用自有音频库**（导入、浏览、删除、片段血缘）；其二，**File Organizer 分类智能化整改**（提取管线、目录与主题稳定、内容指纹幂等、设置里的 Activity 面板）。此外修了联系人列表预览的 **Markdown 外露**、给悬浮球河马补上**扇耳 / 拖拽歪头**、主窗口改为**铺满屏幕**。共 28 个源文件改动（16 改 + 12 新增），并在 package.json 引入 wavesurfer.js。

### 新增功能

* **波形打点轨：一套组件，会议与画布共用**（新增 [AudioMarkTrack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/audio/AudioMarkTrack.tsx)）：基于 wavesurfer.js 的波形播放器，把**打点**（Add mark 先**冻结**当前播放时刻再展开批注框，Enter / 失焦确认后才入库，批注可空）与**片段选取**（波形上拖出区间 → Clip 先展开命名输入、确认才导出；刻意不绑 `onBlur` —— 误触发一次 ffmpeg 导出太贵）合成一条轨。放在中性的 `components/audio/`，谁先接谁后接都不落进某一方目录。只认 **Blob URL**（项目文件代理不支持 HTTP Range，回放链路统一先抓成 Blob 再播，天然可任意 seek）；波形解码失败时退回原生 `<audio controls>` —— 打点用不了，但**播放不丢**，绝不让回放整屏报错。

* **会议回放：打点与截取进 History**（[MeetingReplay.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/MeetingReplay.tsx) + [route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/meeting/route.ts)）：老播放器（原生 `<audio>` + 越界 seek 逼算时长）整条换成波形轨，MediaRecorder 产物「无时长元数据」的老问题在解码层自然解决。打点**挂在转写 md 的一行注释** `<!-- bob-marks: … -->` 上（`upsertMarkHint` 只动这一行、其余一字不改，脏数据容忍见 [marks.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/marks.ts)），新增 `save_marks` / `clip_audio` 两个 action；片段产物落**录音同目录**（`片段 - <标题> - <起-止>.<ext>`），与会议产物同一套 History 口径，可直接点开回放。

* **应用自有音频库：导入 / 浏览 / 删除**（新增 [import/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/import/route.ts) + [library.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.ts)）：从本地选中的音频**复制**进 `<APP_ROOT>/.audio-library/<源名>-<内容指纹>/`（点前缀隐藏目录，与 `.stt` / `.tts` 同款，**不进** workspace 的 materials / homework）。指纹 = `sha1(文件内容) 前 10 位` —— 同一份音频重复导入**命中同一个目录**，既不堆重复副本，也让此前在它上面打的点 / 截的片段自动接上。库浏览（`list_library`）、删除（`delete_library`，收口为只能删库内目录）一并提供。

* **片段截取：输出容器跟随源**（新增 [clip.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/clip.ts) + [clip/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/audio/clip/route.ts)）：与会议路由的 concat 同款「**流拷贝优先、失败才重编码**」，但输出扩展名**跟随源容器** —— 此前一律写 `.webm`，mp3 / m4a 源往 webm 容器 copy 必失败、每次都落到 opus 重编码（把已有损的音频再压一遍，更慢更糊），现在 copy 直接成功。片段**不进 workspace**，与源音频同居一处，归属靠源目录的 `.clips.json`（lineage）而非文件名前缀 —— 片段可自由改名，改名也不丢归属；打点则存同名 `.marks.json` sidecar；命名（[naming.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/naming.ts)）是**纯字符串**，服务端导出与客户端预填共用一份，故与带 `node:fs` 的持久化层分开。

* **画布音频查看器重做**（[AudioViewer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/AudioViewer.tsx) + [registry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/viewers/registry.ts)）：从「代理 URL 直接播放」升级为**波形 + 打点 + 截取 + 导入 + 库浏览**一体的编辑器；打开源音频即在波形下方列出它的全部片段（首行固定「Source audio」用于切回），点某条进「二次编辑」、每条可**下载**另存到用户自己的位置。registry 把 **webm** 也纳入音频白名单（截出来的片段就是 webm，否则会被当成 binary）。

### 修复与优化

* **File Organizer · PDF 提取不再自建渲染链路，改走项目既有管线**（[extract.ts](file:///Users/baolei/Desktop/BobWork/projects/tools/organize/extract.ts)）：旧实现直接用 `pdf-parse` 的 `getScreenshot()` 渲染扫描件首页，而 `pdf-parse` 未列入 `serverExternalPackages`，打包版把**浏览器构建**整份 bundle 进 chunk，里面靠运行时 `require("@napi-rs/canvas")` 打 `DOMMatrix` 补丁 —— standalone 里既没有该包也没有任何原生 `.node`，补丁静默失败后渲染必抛 `DOMMatrix is not defined`，**所有扫描件与无文字层 PDF 全部落 `_待处理`、从不进模型**（历史日志 91 条记录有 63 条即 69% 落待处理）。现改为：Python（pypdf/pdfplumber，打包版随包 `scripts/pdf_extractor.py`）取第 1 页 → 首页稀疏再看 3 页 → 扫不出字或质量分 < 0.35 交 `bob-ocr-mcp` 识别 → OCR 也不可用才返回明确失败原因。实测「开庭通知 / 上诉表决票 / 仲裁费预缴通知书」三份旧实现必失败的扫描件现在都能出字并正确判定为「法律文书」。

* **File Organizer · 图片/扫描件优先走 OCR 取字**（同上）：旧实现把图片直接交视觉模型，而视觉模型是靠模型名正则 `VISION_HINT` 猜的，本机已配的 deepseek-flash / glm-5.3 / kimi-k3 全部未命中，实际落回**纯文本任务模型**。现在先 `bob-ocr-mcp` 取文字（可判类型），取不到才退回原图 + 视觉模型。实测两张真实 PNG 均能正确分类与命名。

* **File Organizer · 新增旧版 `.doc` 支持**（同上）：走系统 `textutil -convert txt`（macOS 自带），不再直接判「暂不支持的格式」。实测「办公设备购销合同.doc」现在能正确归入既有「合同协议」。

* **File Organizer · 思考额度 2000 → 6000，截断自动重试一次**（[model.ts](file:///Users/baolei/Desktop/BobWork/projects/tools/organize/model.ts)）：思考型模型的 reasoning 也吃 `max_tokens`，实测同一输入 2000 时 `finish_reason=length`、正文 0 字，4000/6000 正常，**失败是概率性的**（同文件重跑又能过）。现在被思考占满时改用「紧凑提示词 + 12000 额度」再试一次，两次都截断才算失败，并把 token 用量与重试次数写进整理日志与状态。

* **File Organizer · 既有目录与已用主题注入提示词**（[model.ts](file:///Users/baolei/Desktop/BobWork/projects/tools/organize/model.ts) + [core.ts](file:///Users/baolei/Desktop/BobWork/projects/tools/organize/core.ts)）：旧提示词只给内置枚举，模型看不到投递箱里**已经建好的归档结构**，也不知自己上次怎么判，于是每次重新发明分类体系。现在把「既有目录」列为最高优先级、要求沿用其措辞且不得新建同义目录，并把各分类目录里**已用过的主题**一并列出要求逐字沿用。

* **File Organizer · 自创分类加同义合并闸门**（[model.ts](file:///Users/baolei/Desktop/BobWork/projects/tools/organize/model.ts)）：新增 `matchExistingCategory`，归一后（剥掉「文件/文档/资料/材料」等尾部通用词）互相包含即复用既有目录，避免长出「法律文书 / 法律文件 / 法律资料」。

* **File Organizer · 主题稳定化与版本累加归一**（[naming.ts](file:///Users/baolei/Desktop/BobWork/projects/tools/organize/naming.ts)）：实测同一份 docx 两次判定给出「主播合作保密协议」与「商业秘密保密协议」，而版本累加依赖主题**逐字相等**，于是每份都从 v01 起算。现在分三层：提示词注入已用主题 → 落盘前 `reuseExistingTopic` 在目标目录做近似匹配（互为前缀或 LCS ≥ 0.85 即沿用既有措辞）→ `resolveVersionIndex` 在精确匹配落空时退一步按近似主题取最大版本号。

* **File Organizer · 内容指纹幂等 + 失败短路**（新增 [state.ts](file:///Users/baolei/Desktop/BobWork/projects/tools/organize/state.ts)）：新增 `<投递箱>/.整理状态.json`（隐藏），按「文件大小 + 头部 512KB 哈希」记账。同一份内容再次投递直接复用上次的分类/主题/版本，**不调模型**（实测改个文件名重投，得到同主题 v02 而非重新判定）；判定失败且**提取方式未变**时连模型都不调（提取能力升级后旧失败会自动失效）。watcher 每轮全量扫描不再反复重判同一个文件。

* **File Organizer · 设置面板新增 Activity 分区**（[SettingsModal.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SettingsModal.tsx) + 新增 [route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/core/file-organizer/route.ts)）：`_待处理` 清单直接列出**失败原因 / 判过几次 / 提取方式**，支持单项 Retry 与 Retry all（把文件搬回投递箱根部并清掉失败指纹，下一轮重新判定）；下方列出最近整理记录（时间 / 分类 / 主题 / 重试标记 / token），并在顶部展示「Categories in use」让用户一眼看出是否在长同义目录。

* **联系人列表预览去 Markdown**（[threads-shared.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/threads-shared.ts)）：联系人列的标题与副标题只有一行、渲染不了 Markdown，原来的 `**`、`-`、`|`、`![](…)` 会原样露出来。改为复用 TTS 的净化器 `toSpeakableText`（同一套「**只去格式、不丢正文**」口径）再压行截断，不另写一份 Markdown 剥离逻辑，免得两处口径漂移。

* **悬浮球河马：扇耳 + 拖拽歪头**（[HippoFace.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/HippoFace.tsx) + [ButlerOrb.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerOrb.tsx)）：在眨眼之外再补两层只动 `transform` 的动效 —— **扇耳**（JS 随机 3.5~8s 三拍「外扇 → 回正 → 内收」，耳根以弦中点钉轴、外扇 ≤ 8°，免得耳根露缝）与**拖拽歪头**（拖球速度经 rAF 按半衰期 110ms 衰减映射成倾斜角，松手弹簧回正；拖动中呼吸 / 摇铃暂停，免得各动效打架）。未读时玻璃球整体换**暖琥珀色**（`has-unread` 变量染色边缘与内晕，高光弧保持纯白 —— 真玻璃的高光永远是光源色）。

* **Memory 台两处收口**（[ButlerMemoryConsole.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerMemoryConsole.tsx)）：脑图指针落在入口卡上时**冻结视差** —— 整张图随鼠标反向位移会让卡片从指针底下滑走再滑回，命中判定在「卡片（手形）/ 空白（箭头）」之间反复切换，表现为光标不停闪烁；标题条**去重**（抽屉顶栏 / 移动分区栈已写 Memories，本栏不再重复标题，只在有「← All」或浮窗关闭键时才出）。

* **便利贴删除键图标更明确**（[StickyTodoDock.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/StickyTodoDock.tsx)）：卡片右上角删除键由 `X` 换成 `Trash2`。

* **主窗口铺满主屏**（[main.ts](file:///Users/baolei/Desktop/BobWork/projects/electron/main.ts)）：默认窗口从固定 width 1400 / height 900 改为**铺满主屏可用区域**（x / y / width / height 全取 `screen.getPrimaryDisplay().workArea`），宽屏上不再左右留白、底部不满。

### 新增单测

* 新增 [naming.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/naming.test.ts) / [marks.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/marks.test.ts) / [library.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/audio/library.test.ts)：锁命名纯字符串的三条不变式（文件名不含冒号等非法字符、用户改名不产生 `x.mp3.mp3`、起止都进名）、打点的**脏数据完全免疫**与「只动一行、其余不动」的往返、以及库目录结构（指纹幂等 / 外部源影子目录 / 空清单删文件 / 删除整目录）。

* [threads.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/threads.test.ts) 补一条：标题与副标题都去 Markdown（`##` / `-` / `**` / 链接只留文字）。

***

## v0.7.689 (2026-10-10)

> 本版是 **v0.7.688 之后的增量**：Butler 补齐**感知面的第一块 —— 邮箱**（通用 IMAP 只读接入，把「别人主动来找你」这一最大集合接进助理视野），同时落下**事件驱动主动性的骨架**（把「从事件到出站」收敛到一处折叠层），并把**当日收件箱增量**接进今日视图与晚间回顾；另有一条，管家悬浮球里的河马补上**呼吸 / 摇铃**两层动效、玻璃质感加强。共 19 个源文件改动（12 改 + 7 新增），并在 package.json 引入 imapflow。

### 新增功能

* **邮箱感知：通用 IMAP 只读接入**（感知面 ①，[mail-poll.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/bridge/mail-poll.ts) + [mail-adapter.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/bridge/mail-adapter.ts) + [route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/mail/route.ts) + [MailBindModal.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/MailBindModal.tsx)）：任何支持 IMAP 的邮箱都能接（手填凭证，**不锁厂商、不走 OAuth**）；后台每 120s 增量拉未读、复用同一条 IMAP 连接（163 / QQ 等对频繁登录会限流），过滤掉营销 / 退信 / 自动回复后写入 Butler 收件箱。设置里新增 **Email Inbox** 分区（[SettingsModal.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/SettingsModal.tsx)），只保留地址 / 密码（应用专用密码）/ IMAP 主机三项必填，端口默认 993 不进表单；密码在 [secrets.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/secrets.ts) 按敏感项脱敏。

* **隐私边界：只读、只看信封**（[mail-poll.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/bridge/mail-poll.ts)）：只取**信封级字段**（发件人 / 主题 / 时间 / 三个判定用头），**不下载正文、不写回邮箱、不设置 `\Seen`**；本期不含 SMTP（对外代发属「手」，产品定位未拍板前不做）。幂等与水位线两道保险：`dedupeKey = mail:<Message-ID>` 保证重复投递不产生第二条；状态文件 `butler/.state/mail-poll.json` 记 `{ uidValidity, lastUid }` 水位线，避免同一封未读邮件每轮重复外发。**首次运行 / UIDVALIDITY 变化只做基线**（记下当前最大 UID、不播报存量），防止把邮箱里几百封历史未读一次性倒给用户。未配置凭证时每轮静默 idle（不建连、不报错），用户填好即自动开始工作，无需重启（由 [instrumentation.ts](file:///Users/baolei/Desktop/BobWork/projects/src/instrumentation.ts) 启动调度）。

* **邮箱接入状态进入可见源**（[sources.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/sources.ts) + [context.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.ts)）：与微信 / 飞书同款口径 —— 未接入提示「可引导用户去设置填写」，已接入则报运行态与最近一轮未读数，让 Butler 清楚自己「有没有眼睛、看到了什么」。

* **事件驱动主动性骨架：事件折叠 → 统一出站**（② 神经，[push-policy.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/push-policy.ts)）：生产者只描述「发生了什么」（`ButlerEvent`），**不自己决定推不推、推几条**；同组事件在 60s 窗口内折叠成**一条**带计数的 digest，再经唯一出站口 `push-out.ts` 投递（避免「一秒来 10 封邮件 → 手机震 10 下」）。三条硬约束：**折叠而非丢内容**（细节仍留在各自收件箱条目里）、**fail-open**（折叠层自身抛错时退化为逐行原文照推，策略故障绝不吞推送）、**窗口内合并**。免打扰窗口 / 单日上限仍只在出站口一处裁决，本层绝不绕开它直投桥。

* **当日收件箱增量接入今日视图与晚间回顾**（[today-advice.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/today-advice.ts) + [evening-report.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/evening-report.ts)）：今日视图装载当日 `kind='mail'` 的收件箱增量；晚间回顾的「闭嘴」判据从「今天 / 逾期两项皆 0」扩为「**今天 / 逾期 / 当日收件箱增量三者皆 0**」，有感知增量时在汇总里追加一段「📧 Noticed today」。

### 修复与优化

* **悬浮球河马动效分层 + 玻璃质感加强**（[HippoFace.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/HippoFace.tsx) + [ButlerOrb.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerOrb.tsx)）：在原有**眨眼**之外补两层只动 `transform` 的动效 —— **呼吸**（整只河马 3.6s 上下浮 + 微缩放，常驻，像在水里悬浮）与**摇铃**（悬浮球有未读时左右轻摇 1.8s 一轮，像在喊人看消息）；`prefers-reduced-motion` 下全部停用。球径从 28px 放回 **34px** —— 河马改矢量版后要看眨眼，28px 下眼睛只有约 1.6 CSS px、眨眼读不出来。液态玻璃加强：`saturate` 提到 230%（透过球看到的画布更浓、玻璃感立现且几乎零开销），并补一道**下缘反射亮弧**，一主一反两道镜面弧是玻璃球（而非水珠 / 气泡）最经典的视觉特征。


## v0.7.688 (2026-10-09)

> 本版是 **v0.7.687 之后的增量**：一条线是**移除「Recorder」会议记录员常驻联系人**（连同它专属的两枚会议工具与整条专用链路），另一条线是**管家抽屉的中栏宽度恒定** —— 打开右侧预览不再把中间对话框挤窄、关掉也不再弹回。共 23 个源文件改动（21 改 + 2 删）。

### 移除与清理

* **移除常驻联系人「Recorder」（会议记录员）**：这个身份 2026-09-27 上线，钉在 Butler 抽屉联系人列「Bobby」下方，靠专属画像 [profiles.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/agents/profiles.ts) 把工具面收口到会议场景（`meeting_search` / `meeting_summarize`），实现见 [butler-recorder.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/butler-recorder.ts)（已删）。它与 Bobby / 小微在能力上高度重叠，且占着一整条 `meeting` 场景与专属系统提示，维护成本高于收益 —— 本次整条撤掉：删除常驻会话模块与画像、`meeting` 场景（[index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/index.ts) / [registry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/registry.ts)）、两枚专属工具（[meeting-archive.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/meeting-archive.ts) 已删）、会议归档检索/阅读两个 action（[butler/meeting/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/meeting/route.ts)）、系统身份头像与角色目录映射（[avatar.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/avatar.ts) / [storage.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/storage.ts)）。

* **联系人列与权限口径同步收口**：列表接口不再合成置顶摘要，「常驻线程不可删」与「系统身份不可改人设」两条守卫去掉 recorder 分支（只留 Bobby / 小微），会话身份分支 [entry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/entry.ts) 恒为 `butler`（不再是 `threadId === 'butler-recorder' ? 'recorder' : 'butler'`），前端 [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) 去掉「Recorder 不显示人设入口」的特例。

* **升级后清掉历史残留线程**（[threads.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/threads.ts) + [instrumentation.ts](file:///Users/baolei/Desktop/BobWork/projects/src/instrumentation.ts)）：旧线程 `butler-recorder` 曾被列表接口在每次读取时幂等创建，升级后几乎必然存在；不清掉它会以「未命名角色」的幽灵联系人重新出现在联系人列。故新增一次性、幂等的退役清理 `purgeRetiredRecorderThread()`，启动时执行。**角色目录 `butler/Recorder/` 刻意不删** —— 那里面是用户已生成的会议产物；被清掉的只是角色指针（`pruneOrphanRoles` 的两条常驻豁免也从三个 id 收回两个）。

### 修复与优化

* **管家抽屉：中栏宽度恒定，右栏改为纯增量**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：此前右栏宽度是「先按中栏保持 560 反推余量」算出来的，于是**手动拖过抽屉**（本地存了几何）之后，打开右侧预览会把中栏压窄、关掉又弹回 —— 用户侧表现就是「打开右侧预览，关闭后中间对话框会展开」；安装版与 dev 版表现不一致也源于此（安装版 localStorage 背着旧几何，dev 是干净 origin）。改为：**中栏宽度与右栏显隐完全解耦**（有手动几何取拖定的中栏宽、从未拖动则用自适应宽），右栏只吃中栏之外的余量，余量不足最小可读宽度时退回**覆盖层**（宁可盖住中栏，也不改写中栏宽度），面板宽度在用户拖定的基础上叠加右栏增量、关掉即收回。


## v0.7.687 (2026-10-09)

> 本版是 **v0.7.686 之后的增量**：管家悬浮球里的河马线稿从**位图换成矢量版，眼睛可以眨** —— 位图没法只靠 CSS 让眼睛闭合。共 2 个源文件改动（1 改 + 1 新增）。

### 修复与优化

* **管家悬浮球：河马线稿改矢量，能眨眼**（新增 [HippoFace.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/HippoFace.tsx)，[ButlerOrb.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerOrb.tsx) 接入）：把 `public/butler-orb.png` 的线稿描出轮廓、导出为路径（与原图 **IoU 0.948**，差异仅为 1px 抗锯齿边界；路径由脚本追踪生成，**请勿手改**），面部（头 / 耳 / 眉线 / 嘴）合成一条路径，**左右眼各自成组**，眨眼时对这两组做 `scaleY` 收缩（`transform-box: fill-box` + `transform-origin: center`，`scaleY(0.06)` 闭合）。眨眼节奏由 JS **随机调度**（2.2~6.2s 一次，约 28% 概率连眨两下、间隔 130ms），比固定周期更接近真实节奏；命中 `prefers-reduced-motion: reduce` 时保持睁眼、不闪，组件卸载时清掉全部定时器。（位图仍留作 Butler 抽屉里 20px 的小头像 —— 那个尺寸看不出眨眼，无需换。）

* **外观与定位零改动**（[ButlerOrb.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerOrb.tsx)）：球体直径、定位与钳制逻辑一概未动；`inset: 9% / width: 82%` 的作用对象从位图 `<img>`（`object-fit: contain`）换成 SVG 自身的等比缩放，视觉上仍叠在玻璃球里（不投影），保持「球里」而不是「球上」的观感；`aria-hidden` 由组件自带，视觉装饰语义不变。


## v0.7.686 (2026-10-09)

> 本版是 **v0.7.685 之后的增量**：两条线都是 2026-10-09 当天的事故/报障 —— ① P0 修**「消息已落库，刷新也永远转圈」**。管家 18:23 回答「我在哪里可以看到计划」时，模型在**正文通道**里又起了一个 ` thinking` 且忘记闭合（落库内容出现「2 个开标签 / 1 个闭标签」），正式回答写在它后面；旧实现 `.replace(/ thinking[\s\S]*$/i, '')` 把「开标签 → 结尾」整段剥掉，**连正式回答一起吞了** → 气泡正文变空串，UI 落进「三个跳动点」的空态，而消息已经落库，刷新也永远转圈；同一函数还供会话预览 / 微信·飞书回执 / 轨迹导出，全都变成空串（新增 [bus.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/bus.ts) 无损口径 + 逐帧/收尾两套语义）。② 修**「第一次点不动，第二次项目看着切了、会话还是上一个项目的」**。管家 `create_project(make_current=true)` 建完即切，服务端当前项目已改，但工具只广播了 `projects-changed`（刷新列表）→ 侧边栏高亮跟上了，画布与会话列表却仍停在旧项目；此时用户去点那条**已高亮**的新项目，又会被「已是 current，无需切换」短路挡掉 —— 死结（新增 [current-project.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/current-project.ts) 对账判定 + Sidebar 补发无刷新切换）。共 11 个源文件改动（8 改 + 3 新增）。

### 修复与优化

* **未闭合 `think` 不再吞掉正式回答**（[bus.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/bus.ts)）：新增 `unwrapUnclosedThinkTags` —— 用标签栈配对，**只脱掉未配对的开标签本身、标签内的文字保留**，已配对的块原样不动；`stripThinkTags` 增加 `opts.streaming` 区分两套语义：逐帧渲染（思考还在长）时未闭合的 `think` 视为「正在思考」，其中内容先不显示；**完成态（历史回读 / 收尾落值 / 会话预览 / 微信·飞书回执 / 轨迹导出）改走无损口径** —— 万一正文里有个未闭合的 `think`，宁可把那段文字显示出来，也绝不把回答吞成空串（空串会让气泡落进空态，消息已落库、刷新也永远转圈）。兜底只在「正常剥离会得到空串」时才会走到，因此正常闭合的思考块照旧剥干净、不引入噪声。

* **逐帧调用点与画布侧兜底同口径**（[page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/butler/page.tsx)，[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)，[chatNodeKernelUtils.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/chatNodeKernelUtils.ts)）：管家页与 Butler 抽屉的逐帧渲染改传 `{ streaming: true }`，收尾那次不带该标记（走无损口径）；画布侧的解析兜底同步改成「只脱标签、保留文字」，并**一并去掉未配对的开标签本身**，否则正文里会裸露一个 ` thinking` 标记。四处调用语义与 lib/bus 对齐，避免同一个未闭合标签在气泡、预览、回执、导出里表现不一致。

* **管家建完即切：补广播「无刷新切换」**（[butler.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler.ts)）：`create_project` 的语义边界补一条例外 —— 默认仍**只创建、不切换**；但 `make_current=true`（同一次请求还要紧接着往新项目里写东西）时，服务端当前项目已被切走，这就**等价于一次管家侧发起的项目切换**，同步口径必须与 `switch_project` 一致：`projects-changed` 刷新列表（让新项目先出现在列表里）+ `project-switched` 让画布无刷新重载。返回体新增 `ui_synced`，回执按**是否有界面订阅者**如实措辞（界面没开时说「切换已生效，下次打开即为该项目」，而不是谎称界面已同步）。

* **侧边栏对账 + 画布落位去竞态**（[Sidebar.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/Sidebar.tsx)，[current-project.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/current-project.ts)，[CanvasFlow.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/CanvasFlow.tsx)）：`current_project_id` 的真源在服务端 `.projects.json`，服务端还有若干**单方面改写**路径（管家建完即切、旧当前项目被归档/清空后的自动回退……），这些路径只广播 `projects-changed`，于是高亮与画布分叉。现侧边栏**每次拿到服务端快照都对一次账**：`canvasLagsServerProject(canvas, server)` 判定画布是否落后（**两边都有值且不一致**才算 —— 画布还没报到（启动瞬间 store 为空）不拿空值当「落后」，服务端没有当前项目时也无从跟随），落后才补发一次切换广播。CanvasFlow 侧在收到切换事件时**同步**写入「画布要落到哪个项目」，不等下面那个 effect —— 否则 Sidebar 的 loadProjects 会在竞态窗口里读到旧值、再补发一次，画布白重载一遍。

### 新增单测

* 新增 [bus.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/bus.test.ts)：以事故原文（2 开标签 / 1 闭标签、正式回答在后面）为输入，锁两条 —— 完成态**永远不把回答吞成空串**（回答必须还在、未配对的开标签不裸露、已配对的思考块照旧剥掉），且「只有思考没有正文」时不伪造正文；逐帧（`streaming: true`）仍保持「未闭合的思考先不显示」。另覆盖 `unwrapUnclosedThinkTags` 的配对/未配对/双未配对/多余闭标签四种形态与空输入原样返回。

* 新增 [current-project.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/current-project.test.ts)：覆盖对账判定的三条边界 —— 不一致才落后；一致不落后（点当前项目不该白重载）；画布未报到 / 服务端无当前项目都不作落后依据。

* 新增 [butler-project.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler-project.test.ts)：以管家建项目的报障现场为用例，锁两条契约 —— `make_current=true` 必须**两条广播都有**（少 `project-switched` 就是本次事故）且 `ui_synced=true`；未要求 `make_current` 时**绝不切当前项目、绝不广播切换**（不动用户画布）；界面无订阅者时切换仍生效但回执如实说 `ui_synced=false`。


## v0.7.685 (2026-10-08)

> 本版是 **v0.7.684 之后的增量**：两条线 —— ① P0 修**「没有结果就暂停了」**。2026-10-08 事故（济星-20261008 /「从甲方角度对本协提出修改意见」）中，`thinkingLevel=high` 时每轮 `max_tokens=16384` 被 reasoning 吃满 → 连续两轮 `finish_reason=length`、正文与工具调用双双为空（两轮各 73s/74s ≈ 216 tok/s × 16k）；旧逻辑把这类空轮一律当「模型假完成」：补问一次后强制收尾，并把空正文原样落盘，节点里只剩「⏳ Completion check」+「⚠️ Output reached the model limit」两条系统提示。现把**输出触顶当可恢复故障**：加输出预算（第 2 次起再降一档思考）定向重试，并给整轮无正文的收尾路径补**可读兜底正文**，任何收尾路径都不再落空答案（新增 [empty-round.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/chat/empty-round.ts)）。② 收**场景 sticky 的单调膨胀**：2026-10-02 把 sticky 落盘解决了跨重启漂移，却顺手拿掉了「重启即衰减」这个天然复位阀 —— 一周回测工具数中位 79、最大 130（工具段 150KB），而首调 miss 随工具段增大 4.4 倍（≤40KB 时 5.4k → >120KB 时 23.7k），>80KB 的首调吃掉全部 miss 的 38%。现给 sticky 加 **TTL(24h) + 每会话 6 个上限**，只有「被本轮意图重新命中 / 中途显式激活」才续命。共 8 个源文件改动（6 改 + 2 新增）。

### 修复与优化

* **空轮收尾：输出触顶按可恢复故障重试**（新增 [empty-round.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/chat/empty-round.ts)，[route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts) 接入）：新模块提供两个纯函数 —— `planTruncationRetry` 只看「本轮是否 `finish_reason=length`」（**刻意不看是否调用过工具**：纯问答首轮被截断同样需要一个重试机会，否则会静默收尾成空答案），第 1 次重试只放宽输出预算（最贴近故障原因、改动最小），第 2 次起再降一档思考（思考本身就要吃掉这么多，降档会影响质量故不放在第一次），连续两次仍撞顶才回到原「假完成」判定；`buildTruncationRetryNudge` 注入定向指令，要求模型换策略（直接成文 / 长文拆段写文件 / 别再空转思考）而非原地重撞同一面墙。route 侧配套：`TRUNCATION_RETRY_MAX_TOKENS=32768` 与 max 档同款，**只对 `baseMaxTokens ≥ 16384` 的档位放大**（低档位放大可能超模型支持上限触发 API 400）；`kctx` 新增 `truncationRetries / truncatedRounds / finalAnswerText`；流末 `finish_reason=length` 置 `roundTruncated` 并累计 `truncatedRounds`；截断重试分支 `continue` 重跑该轮，前端收 `truncation_retry` 事件；`downgradeEffortOnce` 的定向降档在 `harnessPure=true` 下也生效（这是对**本任务已观测故障**的纠偏，不是常态执行轮降级）。

* **空答案兜底：任何收尾路径都不再落空答案**（[route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts)）：`buildEmptyAnswerFallback` 在一整轮没有任何可读正文时生成兜底正文（说明成因 + 可执行的下一步 + 本轮已产出的文件），按**最后一轮**而非「是否曾输出过」判定（中间轮的过程性叙述不构成最终答案）；同时把四处 `ASSISTANT_MESSAGE ... :final` 事件全部改为**正文非空才落**（强制收尾 / 收尾轮 / 假完成第二次 / 纯问答空正文），避免轨迹与落盘出现无语义的空 assistant 答案；整轮结束时若 `finalAnswerText` 仍为空 → `send({ content: fallback })` + `send({ empty_answer_fallback: true })` 并补落 `:fallback` 事件。扣档位也给了用户出口：反复出现时调低思考档或拆小任务。**刻意不搬 reasoning 正文**：思考已随 RMETA / 思考面板落盘，再抄一遍只会把 `.md` 撑成噪声。

* **前端轻提示 + 定向降档纯函数**（[ChatNodeKernel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/ChatNodeKernel.tsx)，[policy.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/thinking/policy.ts)）：前端识别 `truncation_retry` 事件，追加一行「🔁 Output hit the length limit … Retrying with a larger output budget (n/2)」轻提示，避免用户在这段重跑时间里以为「卡住了」；policy 侧新增 `downgradeEffortOnce`（与 `EXECUTION_DOWNGRADE` 同表：max→high、high→low、low→none、none→none），与 `executionDowngrade` 的区别是**不受 `harnessPure / round / downgradeOnExecution` 开关约束**，专供这类已观测故障的定向纠偏。

* **场景 sticky 衰减：TTL(24h) + 每会话 6 个上限**（[session.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/session.ts)，[tools.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/tools.ts)）：落盘格式升级到 **v2**（`nodeId → { 场景: lastActivatedAt }`），v1 数组格式**平滑迁移**（无时间戳 → 统一按文件 `updatedAt` 打戳，解析不出就用 now，等价给一轮完整 TTL 的宽限）；`liveScenes` 按 TTL 过滤，`capByRecency` 按最近激活保留前 6 个。`mergeStickyScenes` 的关键顺序：**先**摘出本轮真正命中的 fresh 场景（读回 sticky 之前取快照，否则读回的旧场景会被误当成「本轮命中」，TTL 与上限同时失效——这正是本方法最容易写错的一步），**再**读回未过期 sticky 并入 `activeScenes`（保留原时间戳 = **不续命**，能按 TTL 自然脱落），**最后**只给 fresh 刷时间戳。`addStickyScene`（search_capabilities / load_skill 中途显式激活）同样按「此刻」续命。语义边界：衰减只影响「工具面是否常驻」，不影响正确性 —— 模型需要时仍可经 `search_capabilities` 重新激活（一次额外往返 ≈1–2k tokens，远小于每次冷启动 ~18k 的全价读）。两条约束都**不碰 system 提示词**，因此不触发全局重新预热。

### 新增单测

* 新增 [empty-round.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/chat/empty-round.test.ts)：以事故现场的可观测事实为用例输入，锁死两件事 —— ① 截断空轮必须给重试预算而不是记「假完成」（未截断返回 null；首轮截断只加预算不动思考档；第 2 次同时降档；预算用尽/脏值（负数、NaN）不绕过上限；重试次数单调递增不超上限）；② 空答案必须有可读兜底正文（截断 2 轮 + 工具已跑 → 说明成因且正文非空、给出可执行下一步；非截断空轮不谎称长度截断；有产物时列出文件；产物脏值不留空条目；脏值不产生 NaN 文案）。

* 扩写 [session.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/session.test.ts)：覆盖四件事 —— 原有语义（同会话聚合、`team`/`general`/`coding` 永不落表）、跨重启落盘、**TTL 衰减**（24h 未重新命中 → 过期脱落；被本轮意图重新命中会续命；`addStickyScene` 中途显式激活同样续命）、**每会话 6 个上限**（超出按最近激活淘汰，新命中必须保留）；另补 v1 旧格式平滑迁移与 v2 落盘结构断言（场景 → 时间戳）。TTL 用 vitest 假时钟（`vi.setSystemTime`）推进，不动真实时间。


## v0.7.684 (2026-10-06)

> 本版是 **v0.7.683 之后的增量**：补齐 Butler「主动播报」这条缺失的链路 —— ① P0 修**外部通道绕过裁决**：`event-reminder` 此前直接调微信 / 飞书桥的 `pushText`，从不经过 `decidePush`；而唯一守闸的 `/api/butler/push-gate` 跑在浏览器里（弹 toast 前问一次），**管不到服务端直推** ⇒ 免打扰窗口与单日上限对**手机端完全不生效**。现把「裁决 → 投递 → 计数」收敛到新模块 `push-out.ts`，成为服务端出站的**唯一路径**。② 同时重划**单日上限的适用范围**：`reminder`（用户自订闹钟）由「只豁免窗口」改为**窗口 + 上限双豁免、且不吃配额** —— 上限的立法目的是约束**助理主动汇报**的频度，把用户自订的闹钟算进去会让「报告配额」把晚上的闹钟挤掉（上限是防刷屏，不是防提醒）。③ P1 新增**晚间回顾**（每天 20:00）：Butler 目前**唯一会推外部通道**的「助理主动汇报」，复用 Today 同一份事实、不调模型、今天与逾期都为空时彻底闭嘴；内容同时落收件箱与文档（**被静默 ≠ 丢内容**）。共 11 个源文件改动（8 改 + 3 新增）。

### 修复与优化

* **外部通道统一出站口**（新增 [push-out.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/push-out.ts)，[event-reminder.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/event-reminder.ts) 改为经它投递）：入口 `pushToBridges(text, kind, deps?)` 把三件事收敛到一处 —— 裁决（`decidePush`）、投递（并行 `wechatBridge.pushText` / `feishuBridge.pushText`，`allSettled` 保证一通道失败不影响另一条）、计数（放行**且**计入配额**且**确实投出才 `recordPush()` +1）。与 `push-gate` 的分工：那个管**桌面侧**（toast / 系统通知），本模块管**外部通道**；两者共用同一份策略（`quiet-hours`）与同一份计数状态（`butler/notify-state.json`），所以档位口径必须同源。三条硬约束：**失败即放行**（策略层抛错 → 不吞推送，宁可多打扰一次）、**被静默 ≠ 丢内容**（本模块只回答「要不要打扰手机」，内容该由调用方落进抽屉收件箱）、**放行才计数**。另补一处留痕：`pushText` 在「未绑定 / 无收件人 / 未运行 / 发送失败」时一律返回 `false` 且不抛错，此前**完全静默** —— 「飞书从未私聊过机器人 ⇒ 所有提醒丢推」这类冷启动问题永远不可见，现由出站口统一打 warn。

* **单日上限重新划界：reminder 双豁免且不吃配额**（[quiet-hours.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/quiet-hours.ts) 新增 `countsTowardDailyLimit`，[push-gate/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/push-gate/route.ts) 改为「只有计入配额的档位才 +1」）：`evaluatePush` 的上限判据加 `mutableKind`（`kind !== 'reminder'`），与既有的窗口豁免同源。**改一处必须改另一处**：`evaluatePush` 决定「拦不拦」、`countsTowardDailyLimit` 决定「放行后要不要 +1」，只改一边会出现「不计入却仍被拦」或「计入却从不触发」这类**静默错配**——注释里用 🔴 标死。

* **晚间回顾：每天 20:00 一条助理主动汇报**（新增 [evening-report.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/evening-report.ts)，[instrumentation.ts](file:///Users/baolei/Desktop/BobWork/projects/src/instrumentation.ts) 启动调度）：三条设计取舍 —— ① **内容复用 Today 的同一份事实**（`loadTodayBundle`），面板与推送不许各算一遍口径（与 `today-advice.ts` 存在的理由同源）；② **不调模型**，建议文案直接用规则引擎的 `title` / `reason` 原文（AI 润色留给用户主动打开面板时按需生成）；③ **知道什么时候该闭嘴** —— 今天与逾期都为空 → `composeEveningText` 返回 `null`，连「你今天很空」都不推。投递三条链路**互不阻塞**：桌面收件箱（`insertInbox`，**不弹 toast** —— 晚间回顾是「回来再看」，不是打断）、归档成文档、外部通道 `pushToBridges(text, 'report')`（档位用 `report`，所以它才真正受免打扰窗口与单日上限约束）。幂等靠 `butler/.state/evening-report/<YYYY-MM-DD>.done` 的 `wx` 独占创建（与 `daily-tasks` 的 `tryAcquireSendMarker` 同手法）。**调度器自带、不挂进 `daily-tasks`**：后者被 `lib/butler/today-advice.ts` 静态依赖，而晚间回顾要用 today-advice；反向引用即形成 core ↔ butler 的 import 环（`eslint import/no-cycle` 连动态 `import()` 也算），形态与 `event-reminder` 一致。时间点 20:00 落在默认免打扰窗口（22:00–08:00）之外，正常会送达；用户若把窗口调宽盖住 20:00，则出站口静默外部通道、内容仍进收件箱。

* **调度注释修订**（[daily-tasks.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/daily-tasks.ts)）：明确本调度器**不推任何外部通道**（深夜补做一次 progress 摘要也无妨），并说明「会推手机的晚间回顾不在本调度器内」及其模块方向原因。

### 新增单测

* 新增 [push-out.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/push-out.test.ts)（**7 例**）：守出站四条不变量 —— 窗口内 `report` **压根没尝试投递**（断言两个桥的 spy `not.toHaveBeenCalled`，而不是「投了没送达」），同刻 `reminder` 照投（对照组）；达单日上限后 `report` 被拦、`reminder` 照投**且看计数不吃配额**；放行且送达才 +1（每条推送一次，不按通道数累加）；**策略层抛错 → fail-open 仍投递且不计数**；通道返回 `false` → `pushed=false` 且不计数、不抛错；一通道失败不影响另一条；空文本 → 直接返回。

* 新增 [evening-report.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/evening-report.test.ts)（**9 例**）：A 段守纯函数 `composeEveningText` —— **空快照必须返回 `null`**（闭嘴判据，且即便有 clear 卡也不改变）、逾期 / 今日分段与「今日为空显式写 none」、超预览补折叠计数行（计数用真实总数）、建议卡「标题 — 依据」渲染、数据源降级必须明示（避免「查询失败 = 今天很空」被误读）；B 段守 `runEveningReport` —— 首跑落收件箱 + 走外部通道且**档位必须是 `report`**、同日再跑 `already-run` 且不再落库 / 不再推送（幂等）、无可播报内容 `nothing-to-report` 且不落库 / 不推送、**外部通道被静默时收件箱仍要落库**（被静默 ≠ 丢内容）。

* 扩写 [quiet-hours.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/quiet-hours.test.ts) 与 [route.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/push-gate/route.test.ts)：前者把「达上限后一律静默」改为「静默主动汇报、`reminder` 双豁免」，并新增 `countsTowardDailyLimit` 的档位口径用例；后者在配额打满后补**对照组** —— 连推 3 条日历提醒后，主动汇报读到的 `used` 必须仍是 2（若 `calendar` 误吃配额会读到 5）。⚠️ 特意不只断言「仍被拦」：配额被吃空时也照样被拦，那是**平凡为真**的判据，抓不到本 bug。本批合计 **+17 例**；`tsc --noEmit` 与 `vitest run` 全绿。


## v0.7.683 (2026-10-06)

> 本版是 **v0.7.682 之后的增量**：管家两处「久等」体验与一处长文交付修复 —— ① 长文写入被输出长度截断导致工具调用失败时，不再只让模型「重新调用」（等于再撞同一面墙），而对写文件类工具直接给出**分段写**的可执行路径，工具描述同步补 LONG DOCUMENTS；② 等待口语从 ButlerDrawer 抽成纯函数模块并**扩写约一倍**，分档改按「距上次可见输出」的静默时长（吐字即归零），三条文案规矩由单测守；③ 新增 **SSE 看门狗**，连续 60s 一个字节都没到就如实提示断流并给「重新发送」（管家不掐断）。共 5 个源文件改动（3 改 + 2 新增）。

### 修复与优化

* **长文写入：截断后给可执行的分段路径**（[route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts) + [tools/index.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/index.ts)）：实测事故（2026-10-06）—— 管家把整份协议塞进 `write_file` 的 content，22604 字输出被长度上限截断 → arguments JSON 解析失败 → 自动修复也没救回。原来的提示只说「重新调用、确保 JSON 完整」，等于让模型再撞同一面墙。现对 `write_file` / `edit_code` 长出 `longWriteHint`：先只写第一段、末尾留占位标记（`<!-- MORE -->`），再用 `edit_code` 逐段把标记替换成后续内容（可多次），最后删掉标记行。同时给 `write_file` / `edit_code` 的工具描述补上 `LONG DOCUMENTS` 段（超过约 3000 字就分段写）。

* **等待口语抽成模块 + 扩写 + 静默分档**（新增 [wait-lines.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/wait-lines.ts)，[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) 改为 import）：文案有三条硬规矩（句式不重样 / 只写永远成立的话 / 句尾不写省略号），此前靠注释提醒、扩写必然漂移；抽成纯函数模块后由 `wait-lines.test.ts` 逐条守住。文案量从 24 句扩到 **50+ 句**，档位从三档改**四档**（0-5 / 5-25 / 25-60 / 60+）。关键改动：分档口径由「整轮总时长」改为**「距上次可见输出」的静默时长** —— 一旦又吐字，计时归零、回到第一档（实测事故：一轮 74 秒无新字，三个跳动点早已随首个字退场，却还在说「马上好」）。状态条另设 **8s 静默**才出场（比第一档上界 5s 略大），避开正常顿挫时的闪烁。

* **新增 SSE 看门狗：60s 无字节即如实提示断流**（新增 [sse-liveness.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/sse-liveness.ts)，[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) 接入）：与等待口语说的不是一件事 —— 等待口语看**可见正文**停了多久（思考期间照样在涨，只会让文案更安抚）；看门狗看**一个字节都没到**多久，到阈值就必须如实说。阈值 60s ≈ 服务端长耗时工具 **20s 心跳**连丢 3 个（[route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts) 的「长耗时工具 keepalive」），正常链路不可能出现，同时留足模型 TTFT 余量。管家这条**不掐断**（管家任务动辄几分钟，误杀比多等更贵），只如实提示 + 给「重新发送」；画布节点链路的 90s 硬超时不受影响。

### 新增单测

* 新增 [wait-lines.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/wait-lines.test.ts)（**11 例**）与 [sse-liveness.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/sse-liveness.test.ts)（**4 例**）：前者把三条规矩钉成闸门（每档 ≥4 句、不含具体动作 / 进度词、句尾无省略号、话风内不重样、合计 ≥50 句）、分档与 5 秒轮换口径、称呼只拼在温和档第一档、状态条阈值 8s；后者守断流判定边界（阈值下方不算断流、阈值可下压、非法输入 / 时钟回拨返 0、默认阈值 60s）。本批合计 **+15 例**；`tsc --noEmit` 与 `vitest run` 全绿。


## v0.7.682 (2026-10-06)

> 本版是 **v0.7.681 之后的增量**：修一处**管家派单事故** —— 用户以「新建会话，<任务>」开头说话时，管家此前把这句读成「本次对话的背景说明」，**0 次调用 create_session**、自己在管家线程里把活干完了。现由**宿主按用户原文判定**「以『新建会话』开头 = 派单」，命中才注入当轮意图指令，并同步收紧工具描述与管家提示词；边界（句中提到「会话」、对已建会话的追问）一律零注入，不劫持普通对话。另把 v0.7.681 引入的 MD 编辑器正文字号**从固定 16px 改为跟随全局字号档位**（M/L/XL）。共 6 个源文件改动。

### 修复与优化

* **「新建会话」开头即派单，由宿主判定并注入**（新增 [context.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.ts) 的 `buildButlerNewSessionInjection` + [route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts) 接入动态通道）：实测事故（2026-10-06 16:31）—— 用户对管家说「新建会话，涉及一份合作模式，甲方是十三幺公司…」，管家把这句话读成了本次对话的背景说明，**0 次调用 create_session**，自己在管家线程里把协议写完了：既没建成会话，也违背「你是调度者，不是执行者」。工具的可用性没问题（cacheguard 证明 `create_session` 当时在册），卡点是「一句话两种读法」的判定。**为什么走动态注入而不是改提示词**：管家提示词已被物化为 `<APP_ROOT>/agents/butler/agent.json`（本机实况 2026-09-28 物化，源码里后补的说明一个字都没进去），改 [profiles.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/agents/profiles.ts) 对**已装用户不生效**；而这条判定必须立刻对所有人生效，故由宿主判定、命中才以当前轮 user 消息注入（system / 工具 / 历史前缀字节不变）。判定正则 `NEW_SESSION_INTENT_RE` 只认**开头**（可带「帮我 / 请 / 麻烦」前缀），且用 `NEW_SESSION_FOLLOWUP_RE` 否决「新建会话**那边**怎么样了 / **的**任务做完了吗」这类对已建会话的追问；「新建会话，X」带分隔符 → 永远算派单。

* **注入文案给足执行要素**（[context.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.ts)）：指明 `project` 不传（用当前项目）、`task` 原样带上「新建会话」之后的任务描述（自包含：当事人 / 交付物 / 约束 / 参考材料）、`agent` 按任务性质选已装身份、`title` 用几个字概括；并明确「不要自己在管家线程里把这项工作做完」，以及工具返回 `ui_not_open` 时如实回报、不谎称已建。

* **工具描述补 TRIGGER 段**（[butler.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler.ts)）：`create_session` 描述开头新增 —— 用户消息**以** 新建会话 / 新建一个会话 / 新开一个会话 / 开个会话 / 建个新会话 **开头**并跟任务描述时，那**就是**建会话并派单的指令（imperative，非 context），不要读成本次对话的背景、也不要自己在管家线程里做。

* **管家提示词同步收紧**（[profiles.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/agents/profiles.ts)）：【专属意图优先】段补一条 —— 「以『新建会话 / 开个会话』开头并跟任务描述 → create_session 把任务派给新会话（这是派单，不是本次对话的背景说明；不要自己在管家线程里把活做完）」。

* **MD 编辑器正文字号跟随全局字号档位**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：v0.7.681 把正文钉在 16px，但全局字号档位 M/L/XL 是给 UI 的、编辑器正文此前不跟随；现改为 `font-size: var(--fs-md)`（M/L/XL = 15/17/19px），行高仍用无单位 1.75（随字号等比缩放，无需再维护 `--lh-*` 那套偏紧的 UI 行高）。标题梯度由固定 26/20/17px 改为 `1.625em / 1.25em / 1.0625em`，锚定「16px 正文下的 26/20/17」这套比例，**随正文字号等比缩放**，档位切换时标题与正文的相对关系恒定、不会出现 h3 被正文追平。

* **修字号失效：行内代码被更高权重规则盖掉**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：globals 的 `.html-renderer :not(pre) > code { font-size: 12px }` 是 (0,1,2) 权重，比原来的 `.doc-editor-content code` (0,1,1) 更具体 —— v0.7.681 里写的 14px **一直不生效、实测仍是 12px**。现改用同权重的 `.doc-editor-content :not(pre) > code { font-size: 0.875em }`；代码块 NodeView（contentDOM 是 `div.code-block-content`，非 `code` 元素）同理用 `.doc-editor-content pre .code-block-content` 接管。表格文字亦改为 `0.875em`，随档位等比缩放。

* **打印 / 导出产物仍逐字不变**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：屏幕态新增的 `0.875em` 与 globals 原规则同权重又后置，会一并漏进打印克隆；在 `#doc-print-root` 内按原有有效值（均为 12px）显式钉回 `code` 与 `.code-block-content`。

### 新增单测

* **增补 [context.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.test.ts)（+5 例，新增一个 describe）**：① 事故原文（以「新建会话，」开头）→ 注入「本轮意图：新建会话」并点明不要自己做、须交代 `ui_not_open` 口径；② 各种派单式说法（含帮我 / 请前缀、口语变体）均命中；③ 句中提到「会话」及空串 / 纯空白 → 零注入（不劫持普通对话）；④ 只说「新建会话」没给任务 → 仍注入但提示不传 task；⑤ 已建会话的追问（「新建会话那边怎么样了」等）零注入，并附无反例对照「开个会话把这件事办了」仍命中。本批合计 **+5 例**；`tsc --noEmit` 与 `vitest run` 全绿。


## v0.7.681 (2026-10-06)

> 本版是 **v0.7.680 之后的增量**：重做画布 **MD 编辑器正文的屏幕阅读版式** —— 正文列限宽居中、字号改为跟随全局字号档位（`var(--fs-md)`：M/L/XL = 15/17/19px）、行高 1.75、并由衬线栈（Times New Roman → 宋体）换成无衬线栈（系统字体 → 苹方）；标题梯度、行内 code / 代码块、表格文字随正文等比缩放。打印 / 导出的产物**逐字保持不变**（打印态对新增声明显式对账）。共 2 个源文件改动。

### 优化

* **正文改无衬线 + 限宽居中**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：`.doc-editor-content` 此前是 `width:100%` + 仅 40px 内边距，面板一宽一行就是 100+ 汉字，眼睛回行时找不到下一行开头（阅读度量失控）。现限宽 `max-width:800px`（736px 正文 + 2×32px 内边距）并 `margin:0 auto` 居中，行长落回 40~50 汉字（L 档约 43 字）；字号由硬编码 `14px` 改为跟随全局档位 `var(--fs-md)`（M/L/XL = 15/17/19px），顺带修掉「设置 → 字号档位对 MD 编辑器正文无效、该面板永远比全 UI 小 3px」这个既有一致性问题；行高 1.8→1.75 且用**无单位**值，换档时按比例自动跟随（不引 `--lh-md`，那套是配 UI 文本的≈1.35，长文偏紧）；字族由 `--font-sans`（衬线）换成新增的 `--font-reading`（无衬线）—— 整段正文用衬线时，屏幕小字号宋体笔画细、字面小、灰度低，长段落发暗发灰、回行吃力。

* **新增阅读字体令牌 `--font-reading`**（[globals.css](file:///Users/baolei/Desktop/BobWork/projects/src/app/globals.css)）：`-apple-system → BlinkMacSystemFont → PingFang SC → …`，与 UI 基调的 `--font-sans` 衬线栈刻意分离，**仅** `.doc-editor-content` 使用，全局 UI 与标题字体不受影响。

* **标题梯度随正文字号等比缩放**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：原 24 / 19 / 16px 是按 14px 正文配的，正文改为跟随档位（L 档 17px）后会与 h3 同号、层级塌掉 → 改为 `1.625 / 1.25 / 1.0625em`（锚定原 26 / 20 / 17px @16px 正文的比例，L 档实渲 27.6 / 21.3 / 18.1px）。用 `em` 而非 `--fs-*` 令牌，是为了让「标题 ↔ 正文」的相对关系在任何档位下恒定（若用令牌，XL 档正文 19px、h3 会顶到 20px，层级几乎被追平）。字重由 700 / 680 / 650 改为 700 / 600 / 600：中文无衬线（苹方）只有 Medium / Semibold 两档，原 680 / 650 会被浏览器吸附到 700，导致三级标题全变 Bold、只剩字号一个维度。`letter-spacing` 回到 `normal`（原 -0.02em / -0.015em 是西文大标题的收紧技巧，中文字面本就顶格，负字距只会让标题挤在一起）。

* **行高显式钉在 `p` / `li` 上**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：globals 的 `.html-renderer` 给 `p` 写了 `line-height:1.7`、给 `li` 写了 `1.6`，与 `.doc-editor-content p/li` 同权重且直接命中元素（覆盖继承），只靠容器上的 `line-height` 压不住 —— 故正文段落实际行高从此处取（`p`/`li` 均 1.75）。

* **行内 code / 代码块 / 表格文字改为随正文等比缩放**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：行内 `code` 与代码块此前的字号声明**实际从未生效** —— globals 的 `.html-renderer :not(pre) > code`（行内码）与 `.html-renderer pre .code-block-content`（代码块 NodeView 的真实 contentDOM）都是 **(0,1,2)** 权重，压过 (0,1,1) 的 `.doc-editor-content code`，二者一直停在 12px、且不随正文变化。本次改用**同权重选择器 + 后置顺序**接管，并按 `0.875em` 随正文字号缩放（L 档 14.9px）。表格表头（`th` 与首行 `td`）由 globals 钉的 12px 与表体一并统一到 `0.875em`（较正文小一档），避免表头比表体小一截、整张表看着断裂。

* **打印 / 导出产物逐字不变（打印态对账）**（[DocEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/DocEditor.tsx)）：屏幕态给 `.doc-editor-content` 及其子元素新增 / 修改的直接声明会命中打印克隆里的同名元素，而打印块多数是在**父级**（容器 / `table`）上设值，继承永远输给直接声明，于是会漏进打印产物。故在 `#doc-print-root` 内显式钉回改动前的取值 —— 正文 `font-family` 钉回宋体（保住「正文宋体 / 标题黑体」的字族对比）、`ul/ol` margin 14px、`li` 行高 1.6、表格 9pt、`pre code` 13px、代码块 / 行内码 12px、h1/h2 字距回到 -0.02em / -0.015em。**既有打印与导出结果不变**（已用 19 个元素 × 22 个属性的 computed style 快照逐项对账：改前 vs 改后 0 处差异）。


## v0.7.680 (2026-10-06)

> 本版是 **v0.7.679 之后的增量**：把移动端 `/butler` 从「只有一个对话」补成**完整 Butler** —— 会话为主，分区（Today / Memories / Preferences / Calendar / Meeting / 检索实况 / 回执）从左侧导航滑入、全屏成栈，面板直接复用桌面组件。为此把桌面抽屉里四处能力抽成**共享模块**（检索实况面板 / 公众号检索链路 / 回执动作层 / 回执格式层），两端共用一份真源。另修两处：产物文件卡片**读不出来时把 `OutputFile:` 行还原回正文**（管家切过项目后，早先发出的相对路径卡片会指到别的项目而打不开，路径不该凭空消失）；远端会话 Cookie 收敛成单一真源，并在 Bearer 校验通过时**顺带下发 Cookie**（修 WebView 子资源 401 白屏）。共 14 个源文件改动（7 改 + 7 新增）。

### 新增

* **移动端 `/butler` 升级为「完整 Butler · 分区栈」**（[page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/butler/page.tsx) 重写）：此前手机上只有一个「列表 ↔ 对话」两屏，其余功能一概没有。现改为**栈式导航** —— 首屏仍是会话，分区从右侧全屏滑入（返回即回），入口是左缘滑出的导航（[SectionRail.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/mobile/SectionRail.tsx)）或对话里的就地入口。为什么不用桌面那套四栏抽屉：它是「居中模态框 + 全屏透明挡板」，在 390px 视口里既压不住内容、点任意处还会误关；更糟的是若 localStorage 里存有桌面拖拽几何，面板宽度会被钳到 520px 硬塞进手机 → 横向溢出（见 [SectionStack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/mobile/SectionStack.tsx) 文件头）。

* **分区栈容器与导航**（新增 [SectionStack.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/mobile/SectionStack.tsx) / [SectionRail.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/mobile/SectionRail.tsx)）：前者只做容器（标题栏 / 转场 / 安全区 / 滚动归属，不含业务），样式走 `bws-` 前缀；后者是左缘 24px 内向右拖 > 56px 打开的滑出导航（条目：Today / Memories / Preferences / Calendar / Meeting / Search Live / Notifications，带未读红点与会议「进行中」绿点），样式走 `bwr-` 前缀。

* **分区内容直接复用桌面组件**（[page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/butler/page.tsx)）：`ButlerTodayPanel` / `ButlerMemoryConsole` / `ButlerCalendarPanel` / `MeetingStart` + `MeetingConsole` / `ButlerSearchTrace` 原样挂载，不建副本。两处刻意的形态差异：① 会议视图不用栈 —— `MeetingConsole` 卸载即停录，故常驻挂载、只用 `display:none` 收起；② 会议轮询按需启停（只在「有会议在跑 / 正看会议分区 / 导航已展开」时轮询），避免常驻轮询净耗电。工作区 / 人设 / 模型选型未上移动端（依赖桌面目录选择器或属重度设置面）。

* **移动端回执面板**（新增 [ButlerNoticePanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/mobile/ButlerNoticePanel.tsx)）：桌面那份回执详情内联在抽屉右栏、读的是中栏时间线的 `selectedNotice`，**不是受控组件**、无法被另一页挂载，故此处只重建**视图层**（列表 + 详情两级，扁平倒序，不做桌面那套分组 / 过滤），行为与桌面完全同源（共用 `noticeActions` 落库链路 + `noticeFormat` 格式口径）。样式走 `bwn-` 前缀。

* **四处能力从桌面抽屉抽出为共享模块**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) 相应删除内联实现、改为 import；抽出时实现逐字不变，桌面零回归）：
  - [ButlerSearchTrace.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerSearchTrace.tsx)（原 `WechatSearchTrace`，完全受控，两端共用）；
  - [useWechatSearch.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/useWechatSearch.ts)（「公众号检索」整条链路 hook，约 230 行内联抽出 —— 逐篇判定按下标 + url 双键匹配，复制一份必然漂移出两份真源）；
  - [noticeActions.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/noticeActions.ts)（回执动作层：待办勾选的三条联动链路 / 删除 / 下载 .md / 复制分享链接）；
  - [noticeFormat.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/noticeFormat.ts)（回执详情的展示格式层：`formatTime` / `ScheduleDetail` / `fmtEventWhen` / `fmtReminderMinutes`）。

* **事件总线在移动端就近接住**（[page.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/app/butler/page.tsx)）：与桌面 `ButlerHost` 同源监听 `BUTLER_DOC_EVENT` / `BUTLER_TODAY_EVENT` / `BUTLER_PREFERENCES_EVENT` / `BUTLER_RULES_EVENT` / `BUTLER_FOCUS_NOTICE_EVENT` —— 面板内部（今日 / 记忆 / 回执正文）发出的「打开文档 / 跳到某分区」请求，在移动端不再是点了没反应。文档栈叠在分区栈之上，关掉文档即回到原分区。

### 修复与优化

* **产物文件卡片读不出来时，`OutputFile:` 行还原回正文**（[output-files.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/output-files.ts) 新增 `restoreOutputFileLines` + [ButlerDocPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDocPanel.tsx) 新增 `onLoadResult` + [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) 接 `failedPaths`）：产物行在渲染时会被剥离、改由卡片承载；卡片一旦点不开，那一行已不在正文里，用户连路径都看不到、文件等于凭空消失（实测：管家切过项目后，早先发出的相对路径卡片会解析到别的项目而打不开）。现由 `ButlerDocPanel` 把读取结果回调出去，读失败的路径**还原回正文末尾**（保证路径始终可见、可复制）。

* **交付纪律收紧为「必须写绝对路径」**（[profiles.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/agents/profiles.ts)）：`OutputFile:` 行由「路径原样照抄工具返回」改为**必须写绝对路径**（自己写的产物用 `<当前项目路径>/homework/<文件名>`；工具返回相对路径时前置当前项目路径）。原因：卡片按路径定位文件，项目相对路径在点击时按「那一刻的当前项目」解析 —— 管家中途 `switch_project` 切过项目后，此前发出的卡片就会指到别的项目里去、用户打不开。

* **远端会话 Cookie 单一真源 + Bearer 顺带下发**（[server.ts](file:///Users/baolei/Desktop/BobWork/projects/src/server.ts)）：抽出 `sessionCookieHeader`（值 = HMAC(token)，HttpOnly + SameSite=Lax，Max-Age 180 天），登录页换 Cookie 与新增的「Bearer 校验通过时顺带 `Set-Cookie`」两处共用，避免参数漂移。为什么要在 Bearer 通过时也下发：WebView 的 `Authorization` 头只作用于**主文档**，页面内引用的 `/_next/static/**` 与 `fetch` 子请求不带它、会各自吃 401 → 主文档能开但 JS 加载失败、白屏；一旦种下 Cookie，同源子请求自动携带，主链路与所有子资源一并放行。

### 新增单测

* **增补 [output-files.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/output-files.test.ts)（+4 例）**：读失败的路径还原回正文末尾（可见可复制）；无失败项时正文原样返回（不引入多余空行）；纯文件消息（正文为空）只给还原行、不留前导空行；多个失败项按给定顺序逐行还原。本批合计 **+4 例**；`tsc --noEmit` 与 `vitest run` 全绿。


## v0.7.679 (2026-10-05)

> 本版是 **v0.7.678 之后的增量**：给管家补上「动手开界面」的两枚工具 —— `switch_project`（打开 / 切换当前项目）与 `create_session`（在指定项目新建会话、可选立刻后台跑一个任务），并新开 `project-switched` / `session-request` 两条 SSE 通道，由侧边栏翻译成画布既有的窗口事件落地（服务端只做解析 + 授权 + 广播，节点本体仍由画布创建，避免两套建节点语义漂移）。同时把 Butler 正文的 `OutputFile:` 解析抽成独立模块并放开**绝对路径**（跨项目交付），把 `search_materials` 扩成**跨项目检索**（其它项目一律回绝对路径与项目名限定的来源串），并修掉跨项目文件在抽屉里打不开。共 11 个源文件改动（含 1 个新增模块）、6 个测试文件（5 新增 + 1 增补）。

### 新增

* **管家可以打开 / 切换当前项目（`switch_project`）**（`src/app/api/chat/tools/butler.ts` 新增 `toolSwitchProject`）：此前 Butler 只有 `create_project` 且语义是「只建不切」——用户说「打开余靖潘案」时无工具可用。新工具与 `create_project` 分工互补：入参 `project` 必填，**只认显式引用**（项目名 / id / `current`），走 `resolveExplicitProject`，同名多命中或未找到时原样回传交模型澄清，**绝不猜项目**（缺参回 `{ok:false,error:'project is required'}` + hint）。已是当前项目 → 回 `already_current: true` 且不重复切换；否则 `switchProject(id)` 后 `emitProjectSwitched(project.id)`。回执带 `via`（解析来源）与 `ui_synced`（= `hasProjectsChangedListeners()`）：界面开着就说「界面已同步切换」，没开则说明「切换已生效，下次打开即为该项目」。工具描述显式禁止「为了写数据去切项目」，`maxOutput: 800`。

* **管家可以新建会话并顺手把活派下去（`create_session`）**（同文件新增 `toolCreateSession`）：把「打开项目 → 建会话 → 跑任务」合成一次调用，入参 `project` / `agent` / `title` / `task`（均非必填）。语义边界：**节点本体由前端画布创建**，服务端只做「解析项目 + 解析 agent + 必要时切项目 + 广播 `session-request`」。三条硬约束：① 界面在线性检查放在最前，`hasProjectsChangedListeners()` 为假直接回 `ui_not_open`（不静默失败、不留半状态）；② 无激活项目回 `no_active_project`；③ agent 经 `listSessionAgents()`（`listAgents()` + `loadInstalledAgentProfiles()`，按 `readAgentsState()` 的 `disabled` / `hiddenMenu` 过滤、按 id 去重）解析，空取 `chat`，未命中回 `agent_not_available` + `candidates`（**不静默换身份**）。`title` 取 `args.title || agent.label` 并 `.slice(0, 40)`；目标项目不是当前项目时先 `switchProject` + `emitProjectSwitched`（回执 `switched: true`），切换失败回 `switch_failed` 且不建会话；最后 `emitSessionRequest({project_id,label,agent,prompt,auto: task.length>0})`。`maxOutput: 1200`。

* **服务端 → 前端新增两条「界面动作」通道**（`src/lib/project/project-events.ts` 新增 `onProjectSwitched` / `emitProjectSwitched` / `onSessionRequest` / `emitSessionRequest` 与 `SessionRequestPayload`；`src/app/api/projects/events/route.ts` 新增 `event: project-switched` 与 `event: session-request`）：`SessionRequestPayload = { project_id, label, agent, prompt, auto }`。两条通道都用 `Set` 存订阅者、广播时 `[...listeners]` 快照 + 逐个 `try/catch` 隔离；SSE 路由在原有 `unsubProjects` / `unsubFiles` / `unsubOutcome` 之后补 `unsubSwitched()` / `unsubSession()`。注释写明取舍：**不让工具直接写节点文件**——会话节点是画布状态，创建要经过节点定位、agent 壳、后台自动执行缓冲 `window.__pendingNodeTasks`。

### 修复与优化

* **`search_materials` 支持跨项目检索**（`src/app/api/chat/tools/materials.ts` 新增 `project` 参数与 `resolveTargetProject`）：此前只认当前激活项目（`currentProjectRoot()`）。现按 `mode: 'current' | 'foreign'` 分流，两种模式只差回执路径形态：当前项目仍给项目相对路径；其它项目一律给**绝对路径**（相对路径会被解析到当前项目根，必然读错文件）。未点名 → `getCurrentProject()`（无 → `NO_PROJECT`，文案改为「未点名项目时材料检索只在打开的项目的画布下可用。要查别的项目，用 project 参数点名」）；点名 → `resolveExplicitProject`，失败时附「候选：名称（id）、…」。跨项目时先 `isReadablePath(join(projectRoot,'materials'))` 探原文可读性，不可读就在回执最前加 `⚠ …索引结果可用，但 read_attachment 读不到原文`。`limit` 默认 20 / 上限 50、`SNIPPET_MAX_CHARS = 200` 未变。

* **跨项目来源串带项目名限定**（同文件新增导出 `materialSourceTag` / `materialPathToken` / 公开 `renderInventory`）：跨项目命中行改为 `- [来源: 材料:余靖潘案:materials/被告/合同.pdf#p3] /abs/余靖潘案_20260927/materials/被告/合同.pdf（第 3/12 页 · 文字层 · 项目「余靖潘案」）`，读取提示改为按**绝对路径**调 `read_attachment`；绝对路径拼接先去尾斜杠，避免双斜杠。

* **跨项目清单不再分组、逐条给绝对路径**（同文件 `renderInventory`）：标题变为 `项目「X」材料清单（已建索引 N 份；未建索引 / 不支持索引的文件用 list_directory "<项目绝对路径>/materials" 查看）`；**当前项目模式逐字节不变**（不传 `target` 即旧口径，显式传 `mode:'current'` 输出一致）。

* **抽屉里的跨项目文件不再打不开**（`src/components/butler/ButlerDocPanel.tsx`）：绝对路径此前无条件走 `/api/butler/report-doc?action=read`，跨项目文件必然 `success:false` 报错。现两段式：先走服务端只读通道（保留目录越界校验与 2MB 上限），`data.success` 才采用；失败回落 `getSource('local').read(path)`（人类 UI 通道，可读任意路径）+ `src.proxy(path).catch(() => null)`；两路都失败才回显服务端第一个错误。客户端**刻意不做路径猜测**（不知道 `APP_ROOT`，猜错会丢掉服务端校验）；AI 工具侧 `isReadablePath` 授权不受影响。

* **`OutputFile:` 行放开绝对路径**（新增 `src/lib/butler/output-files.ts`，`src/components/butler/ButlerDrawer.tsx` 改为引入）：管家是跨项目助手，`search_materials project=…` 给的是绝对路径，而此前内联前缀只认 `homework/ | materials/ | attachments/ | .sandbox/ | ~/`，绝对路径被丢弃 —— 表现为「管家说发了文件，对话里什么都没有」。现抽出纯字符串模块，新增导出 `isDeliverablePath`（判可交付形态，**不判存在性**）+ `extractOutputFiles`（保序去重、命中行从正文剥离）。行尾换行一并吃掉、Windows 反斜杠归一化，`foo.md` / `tmp/x.md` / `../outside.md` / `https://…` 明确不做卡片，行为与旧实现一致；与画布 `ChatNodeKernel.extractOutputFileBlocks` 的口径差异（画布只认项目相对路径）刻意保留并写入注释。

### 改进

* **两枚新工具只归 butler、并入写类收口名单**（`src/app/api/chat/tools/registry.ts`、`src/lib/runtime/tools.ts`）：场景归属都只挂 `['butler']`（普通 chat 不注入，避免随口一句「建个会话」派生无人看守的后台任务）；`SANDBOX_BLOCKED_TOOLS`（沙盒 / 编排链路不得移动用户眼前的画布与项目指针）与 `WECHAT_ALLOWED_WRITES`（微信是用户本人手机入口，「打开 X 项目，建个会话把这件事跑了」是典型指令，故放行）同时补齐。

* **管家系统提示词补上调用时机与交付纪律**（`src/lib/agents/profiles.ts`）：①「应用结构」一行由 `create_project` 单条扩成三条（create_project 只建不切、用户要进去就用 switch_project；switch_project 在用户明确说打开 / 进入 / 切到 X 时**直接切**、**不要为了写数据去切项目**；create_session 传 `project + agent + task` 一次办完，传了 task 会后台无人看守执行，`ui_not_open` 要如实告知）。②【输出纪律 · 分端】新增「**把文件交给用户**」：正文末尾**单独一行** `OutputFile: <路径>`，路径原样照抄工具返回；只写「文件在 xxx 目录」用户拿不到文件，没有真实路径不要编。

* **`search_materials` 工具描述同步重写**（`src/app/api/chat/tools/materials.ts`）：清单态描述去掉「project-relative」限定；新增 `OTHER PROJECTS` 段（结果带绝对路径、来源串带项目名前缀、**不要为了搜索去切项目**）与 `TO HAND A FILE TO THE USER` 段；`parameters.project` 描述明确「省略 = 当前激活项目，绝不猜名字」。

### 界面细节

* **跨项目新建会话要等画布重载完成再落节点**（`src/components/canvas/Sidebar.tsx`）：SSE 两条新事件翻译成画布既有链路 —— `project-switched` → `bobagent:project-switched`（`detail.projectId`，与点侧边栏切换同一条无刷新链）、`session-request` → `quick-launch-open`（`detail = { label, agent, prompt, auto, projectId }`，label 空兜底 `'Quick'`、agent 空兜底 `'chat'`、auto 需严格 `=== true`）。新增 `currentIdRef` 与 `canvasReadyProjectRef`（监听 `bobagent:project-canvas-ready`）；目标项目 == 当前项目或画布已在该项目就绪 → 立即落节点，跨项目则等 `project-canvas-ready`（projectId 不符继续等），否则新节点会被随后到达的重载结果（`setNodes` 整表替换）冲掉；另有 **5000ms 超时兜底**不吞请求；订阅与 `removeEventListener` 成对补齐。

### 新增单测

* **`src/lib/butler/output-files.test.ts`（6 例）**：项目相对路径解析并剥离正文；绝对路径；`~/` home 路径与反斜杠归一化；同路径只出一张卡 + 多行保序；非交付形态（裸文件名 / `tmp/x.md` / URL / `../outside.md`）不做卡片并配反例；无产物行时正文原样返回（含空串）。
* **`src/lib/project/project-events.test.ts`（4 例）**：project-switched 送达 + 取消后不再收到；session-request 契约原样送达；单订阅者抛异常不影响其他订阅者与后续广播；`hasProjectsChangedListeners()` 作为「界面是否在线」判据的三态断言。
* **`src/app/api/projects/events/route.test.ts`（3 例）**：真读 SSE 流 —— 负载键必须是 `project_id`（把「字段名写成 camelCase 就真机全无反应」钉成断言）、session-request 含 `auto` 原样送达、取消后停止订阅不泄漏。
* **`src/app/api/chat/tools/butler-session.test.ts`（3 例）**：switch_project 缺引用（`{}` / `''` / 纯空白）恒回 `project is required` 且 hint 要求确认项目名；create_session 无 SSE 订阅者时回 `ui_not_open`（不切项目、不建会话）；两枚工具都在 butler 工具表里。
* **`src/app/api/chat/tools/materials-format.test.ts`（6 例）**：当前 / 跨项目路径 token；来源串两态；**当前项目清单输出与改造前逐字节一致**（不传 target 与显式 `mode:'current'` 比对同一份字面量）；跨项目清单绝对路径 + 不再分组 + 截断提示。
* **增补 `src/lib/runtime/sandbox-blocked.test.ts`（+1 例）**：两工具必须同时命中 `SANDBOX_BLOCKED_TOOLS` 与 `WECHAT_ALLOWED_WRITES`，并反向断言 `list_projects` / `list_nodes` / `get_app_status` 不得误拦。
* 本批测试合计 **5 个新增测试文件 / 22 例 + 1 例增补**；`pnpm test` 全仓 **990 例全绿**，`tsc -p tsconfig.json` 通过。

## v0.7.678 (2026-10-05)

> 本版是 **v0.7.677 之后的增量**：把 Butler 文件卡片的图标重做 —— 去掉 36px 的灰底方块，改为占满图标槽的无底色折角纸，纸面印上类型字标（MD / DOC / PDF / XLS / PPT）。共 1 个源文件改动。

### 优化

* **文件卡片图标去掉灰底方块、改为折角纸印字标**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：v0.7.677 的卡片图标是「36px 灰底方块里塞一张 20px 白纸」，纸被压得太小、折角与描边全糊在一起。本次去掉灰底方块，让折角纸 glyph **直接放大到 34px 贴着图标槽**，细节看得清、长列表里也更好认；纸面按类型印上中性灰字标（`Markdown`→MD、`Word`→DOC、`PDF`→PDF、`Excel`→XLS、`PowerPoint`→PPT），图片与未知类型留空（纯折角纸）。字标与描边统一用 `var(--ink-muted)`，颜色仍交给文件名与大小承载，图标本身不抢戏。


## v0.7.677 (2026-10-05)

> 本版是 **v0.7.676 之后的增量**：Butler 正文里的产物文件从一行干巴巴的 `OutputFile: …` 升级为**微信式文件卡片**（折角文档图标 + 文件名 / 类型 · 大小，整卡可点）；卡片点开在抽屉右栏预览后，还能在标题栏按「Edit」把 Markdown 产物**转交画布右侧的 md 编辑器**继续改。共 2 个源文件改动。

### 优化

* **产物文件改为微信式文件卡片**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：正文里的 `OutputFile: <path>` 行（只认项目内相对路径 `homework/` `materials/` `attachments/` `.sandbox/` `~/`）不再以纯文本出现，改由**文件卡片**承载 —— 左侧中性灰折角文档 glyph（自绘 SVG，不随类型变色），右侧两行「文件名 / 类型 · 大小」，整卡可点。解析**只在回复完成后**进行（流式期间路径可能还是半行，先做卡会闪出一张坏卡），命中后把标记行从显示正文里剥离；文件大小异步 `stat` 得到，拿不到就不显示、不影响打开。

* **产物文档可在画布编辑器里继续编辑**（[ButlerDocPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDocPanel.tsx) 新增 `onEdit` + [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) 的 `handleEditDoc`）：抽屉的文档预览栏此前是**纯只读**，产物 md 想改却没入口。现按路径形态放开 —— 项目内的 Markdown 产物（`.md` / `.markdown`）在标题栏显示「Edit」；点击先 `openFileByProjectRelPath` 让画布挂上文件标签、再收起抽屉（并清掉右栏 `docPath`），用户直接落到画布右侧预览面板的 md 编辑器（抽屉是居中浮层会盖住画布，所以必须先撤）。Butler 报告文档（绝对路径的只读沉淀）不提供编辑入口。

* **文档栏标题精简**：移除「重新载入」按钮与文件名下的「· 只读」副标题（只留文件名），`aria-label` 统一为英文（Edit / Close）。

* **聊天列表隐藏原生滚动条**（`hide-scrollbar` 工具类）：侧边栏靠窗口左边缘，原生滚动条会压在联系人列表最左一列文字上；改为隐藏滚动条（仍可滚动）。


## v0.7.676 (2026-10-05)

> 本版是 **v0.7.675 之后的增量**：把已名不副实的 `daily-report` 模块**正名**为 `daily-tasks`（模块 / 路由 / 类型 / 调度器 / 状态目录 / 通知 kind 一并改，旧状态目录与历史收件箱行都做幂等迁移）；Butler 正文里的文件链接改为**开在抽屉自己的右栏**（覆盖式浮层下 `file.open` 会被遮住，表现为点了没反应）；修掉正文文件链接的**括号截断**。共 33 个源文件改动，含 3 个改名 / 删除。

### 修复与优化

* **日报模块正名为 `daily-tasks`**（[daily-tasks.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/daily-tasks.ts)、[route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/daily-tasks/route.ts)）：日报三页签（Report / Schedule / Sticky）早已整体移交 Today 面板，模块里只剩「progress 摘要 + Notes 知识库维护」两类每日任务 —— 名字却还叫 `daily-report`。本次把**模块、路由、类型、调度器**一并正名：`lib/core/daily-report.ts` → `daily-tasks.ts`、`/api/butler/daily-report` → `/api/butler/daily-tasks`、`DailyReportType` → `DailyTaskType`、`startDailyReportScheduler` → `startDailyTaskScheduler`。所有引用方（`instrumentation.ts`、`butler/today-advice.ts`、`butler/advice.ts`、`api/butler/today/route.ts` 等）同步切换。

* **状态目录带一次性幂等迁移**（`ensureTaskDir`）：内部状态目录由 `butler/.state/daily-report/` 搬到 `daily-tasks/`，首次访问时若新目录不存在才把旧目录整体 `rename` 过去（已有新目录则不动），保证升级后去重标记 / notes-review 状态不丢、当天不重复执行。

* **通知 kind 正名为 `notes-maintenance`**（[inbox.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/inbox.ts)）：`kind='daily-report'` 那句在日报退役后已是空壳，现正名为 `'notes-maintenance'`（该 kind 只剩知识库每日维护一种来源）。DB 里对历史行做幂等迁移 `UPDATE inbox SET kind='notes-maintenance' WHERE kind='daily-report'`（迁完即无匹配行）；`push-gate` 的 `toPushKind`、`butler-notify` / `ButlerDrawer` 的 `NOTIFY_KINDS`、`bus.ts` 的 `ButlerNoticePayload.kind` 联合类型与 `report-share.ts` 的可分享 kind 清单一并同步。

* **退役 `inspect` 桶**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx)）：跨项目 sticky 检查改由 Today 的 Sticky 页签承载后，抽屉里单独的 `INSPECT` 分区已无新来源 —— 删除其 `BucketKey`、`BUCKET_LABEL` 与 `NOTIFY_KINDS` 中的 `inspect`，避免「Bobby 没有未读项却亮着角标」。

* **Butler 正文文件链接开在抽屉自己的右栏**（[HtmlRenderer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/HtmlRenderer.tsx) 新增 `onOpenDoc` + [ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) 的 `openDocInDrawer`）：点开 Butler 正文里的 `homework/…` / `materials/…` 链接时，**不能走 `file.open`** —— 抽屉是覆盖式浮层（z-1320），画布右侧预览面板会被它整块遮住，表现为「点了没反应」。现由渲染器透传一个 `onOpenDoc(path): boolean` 接管回调（返回 `true` = 调用方已处理），抽屉把它开在自己的右栏 `ButlerDocPanel`（复用画布的 md 阅读器）；正文、流式消息、通知 body 三处渲染全部接上。

* **`ButlerDocPanel` 从「只读报告文档」扩展为「也读对话产物」**（[ButlerDocPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDocPanel.tsx)）：此前只支持**绝对路径**的 Butler 报告文档（走服务端目录越界校验的只读通道）。现在按路径形态分流 —— 绝对路径仍走 `/api/butler/report-doc`；**项目相对路径**（对话产物）改走项目来源 `getSource('project')` 读取与 proxy，与画布查看器同口径；标题相应显示 `Butler 报告文档 · 只读` 或 `项目文档 · 只读`。

* **修正文文件链接的括号截断**（[HtmlRenderer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/HtmlRenderer.tsx) 新增 `trimUnbalancedClosers`）：原正则把中英文括号一律排除，导致「xx（孵化模式）条款大纲.md」被截断成「xx」→ 点到不存在的路径（静默失败）；全不排除则会把句读的 `）` 吃进路径。改为**按配对判定**：逐字符剥离末尾收尾括号，只要该括号在本串里已有配对开括号（说明括号属于文件名）就停手；被剔除的句读原样还回正文，不吞字。

* **路由测试随名迁移，回归全绿**：`src/app/api/butler/daily-report/route.test.ts` → `src/app/api/butler/daily-tasks/route.test.ts`（打扰闸用例随模块正名迁移，断言不变）；`push-gate` / `advice` 两处 co-located 测试同步更新 kind 口径。本版无新增测试文件，`tsc --noEmit` 与 `vitest run` 全绿（85 文件 / 967 用例）。


## v0.7.675 (2026-10-05)

> 本版是 **v0.7.674 之后的增量**：把「习惯学习」从「攒够次数才提议」改成**一次即记忆 + 主动遗忘**兜底；给 Butler 的记忆路由补上**先判层再落库**的纪律；把散在四处的「可见源」硬编码收敛成**单一注册表**并加漂移护栏；规则被废除 / 删除时落负样本，防止静默学回。共 20 个源文件改动，含 3 个新增文件。

### 修复与优化

* **习惯学习改为「一次即记忆 + 主动遗忘」**（重写 [rule-nearmiss.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/rule-nearmiss.ts)）：此前是「攒够 N 次（`NEAR_MISS_BEHAVIOR_N=3`）才提议固化，再问用户 `NEAR_MISS_ASK_LIMIT=2` 次」——攒次数的窗口既要额外落 `rule-behavior.json` 计数、又让「说一次就该记住」的偏好被拖延。现改为：命中弱信号**一次**就静默落一条 `draft` 规则（用户不会被弹窗打断），再次命中只记一次印证（`reinforced`）但**不自动转正**——转正与否由用户在 Pending 收件箱里裁决。`noteBehavior` / `consumeAsk` / `readAskCounts` / `proposeForText` 与两个计数存储根一并移除，不再产生行为计数文件。

* **新建习惯只对可执行的动作建 draft**（`rememberFromText`）：弱触发词能表达的是「类别」，但宿主执行器只认 `create_todo` / `create_scheduled_todo`。排期需要确定时刻、弱触发词给不了；note / meeting / project 没有确定性动作 ⇒ 这些类别 `ruleObjectType` 为 null，只做记忆不落规则。已有 active 规则覆盖该 todo 时直接跳过；已有 draft 时只记印证不重复建。

* **主动遗忘：draft 超期自动清除，active 只给软提示**（新增 [rule-forget.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/rule-forget.ts)）：`sweepForgottenDrafts` 惰性清除「30 天未确认」的 draft（记 `lastHitAt`，命中即续命），active 规则**绝不静默删**——只在 90 天无命中时产出 `stale` 软提示，交由用户决定是否废除。走「拉」不走「推」：由 [runtime.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/runtime.ts) 的 `butlerTick` 顺带 sweep，不引入常驻调度器。`ButlerTickResult` 相应新增 `learned` / `forgotten` 两字段。

* **两项超期阈值落进 `rules-shared`**（[rules-shared.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/rules-shared.ts)）：新增 `DRAFT_FORGET_DAYS=30` / `ACTIVE_STALE_DAYS=90` 与纯函数 `ruleLastActivityMs` / `isDraftExpired` / `isRuleStale`；移除 `NEAR_MISS_ASK_LIMIT` 与 `NEAR_MISS_BEHAVIOR_N`。同时 `CreateRuleInput` 新增 `status?`，让 [rules.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/rules.ts) 的 `createRule` 不再写死 `'active'`，而是落盘调用方指定的 `draft`。

* **Butler 记忆路由纪律：先判层，再落库**（[profiles.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/agents/profiles.ts) 新增 `BUTLER_MEMORY_ROUTING`）：把「人与分工 / 口径与标准 / 节奏 / 授权接源」四类信息配三条铁律（可执行的习惯落规则、纯陈述事实记偏好、多步编排才走技能），明确「同一句话先判断属于哪一层，再决定写 Memory 还是 Rules」。以 `${BUTLER_MEMORY_ROUTING}` 插值进 `BUTLER_BASE_SYSTEM_PROMPT`，并新增 `BUTLER_ROUTING_HINT` 一句短语，供空态文案与记忆段尾句复用（文案同源）。

* **记忆路由走双通道幂等注入**（[context.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.ts) 新增 `buildMemoryRoutingInjection`）：与既有排期纪律同款做法——既进系统提示词、又作为注入段下发，且在注入段做**幂等去重**（已在 base prompt 里出现则不再重复），避免双通道把同一段喂两遍。用户记忆段尾句追加 `；${BUTLER_ROUTING_HINT}。`，调用点在 [chat/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/route.ts)。

* **可见源收敛为单一注册表**（新增 [sources.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/sources.ts)）：微信桥 / 飞书桥 / 文件 / 资料 / 台账 / 笔记 / 会议 / Butler 事务域这八类源的「存在性 / 可见性 / 检索方式 / 渲染文案」此前散在 `registry.ts` / `official-packages.ts` / `route.ts` / `context.ts` 四处硬编码，任何一处改口径都会漂移。现以 `SOURCES` 表做唯一真源（纯数据 + 纯渲染，不持有 IO），由 `SourceStatus` 派生可见行、能力边界与检索面。`context.ts` 的 `buildVisibleSourcesInjection` 改为从注册表按场景派生（IO 采集逐项容错，全空返回 `''`），桥接文案与改造前逐字节一致。

* **可见源与工具面同判据**（[tools.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/tools.ts) 抽出 `resolveEffectiveScenes`）：把「沙箱 / 固定 profile / 动态」三态下有效场景集合的判定抽成独立纯函数，`computeActiveToolDefs` 与可见源注入**共用同一份场景判定**，杜绝「工具放出来了但源没声明可见」这类错位。

* **注册表漂移护栏测试**（新增 [sources.registry.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/sources.registry.test.ts)）：以真实工具面 `getToolDefinitions` 为基准做四组断言 —— 注册表引用的工具必须存在、场景归属一致、`excludedTools` 有效、反向一致性（工具面里不该有源外的漏网场景）。注册表与工具定义一旦分叉，测试即红。

* **规则废除 / 删除时落负样本，防静默学回**（[rules/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/rules/route.ts) 新增 `blockReProposal`）：用户把一条习惯规则 `retired` 或直接 `DELETE`，意味着「这不是习惯」——但近邻学习可能下次又把它学回来。现在这两条路径都落 `not_a_habit` 负样本（`recordNegativeSample`），`rememberFromText` 命中黑名单即跳过，用户否决过的行为不会被静默重新提议。

* **Pending 收件箱 + 陈旧提示落地 UI**（[ButlerMemoryConsole.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerMemoryConsole.tsx)）：`draft` 规则单独归入 Pending 收件箱，按印证次数（`hits`）降序，`hits >= 2` 显示 `Seen N times`，提供 Keep / Edit / Discard（二次确认）三个动作；主列表只展示非 draft 规则；`stale && !isRetired` 的行附 `No hits for a while — consider retiring`。同步移除了 askQuota 相关 UI 与 Proactive budget 里的 Ask quota 文案。

* **signals 端点下发活动度**（[rules/signals/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/rules/signals/route.ts)）：无 id 分支响应新增 `activity` 映射，由 `ruleActivityOf` 逐条派生 `hits` / `lastHitAt` / `stale`，供前端排序与陈旧提示消费。

* **移除 askQuota 审计段**（[memory-audit/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/memory-audit/route.ts) 与 [其测试](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/memory-audit/route.test.ts)）：`readAskCounts` / `NEAR_MISS_ASK_LIMIT` / askQuota 断言随机制一并下线。

* **read_rules 空态文案同源**（[tools/butler.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler.ts)）：改用 `BUTLER_ROUTING_HINT`，并补充「判断标准（口径）写成规则的 judgment 步骤，只有多步编排才走 skill_draft」。

* **测试补齐**：[rule-nearmiss.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/rule-nearmiss.test.ts) 重写为「一次即记忆 / 印证不转正 / active 覆盖不学 / not_a_habit 压制 / 主动遗忘 sweep」五组场景（含手写规则文件绕过 `createdAt` 不可改）；[context.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.test.ts) 新增 `buildMemoryRoutingInjection` 幂等去重 3 例与 `buildVisibleSourcesInjection` 注册表派生 3 例（`vi.mock` 打掉微信桥 / 飞书桥 / 授权目录）。


## v0.7.674 (2026-10-04)

> 本版是 **v0.7.673 之后的增量**：把 Butler 的**三层（Memory / Rules / Skills）真正接起来** —— 规则可以调用已固化技能、技能有了内容修订写口；记忆台的 Memories 段正名为 Preferences；Daily News 增加策展新闻源（RSS）并按读者长期记忆挑选；docx 分页推进到 **P4 节几何动态化 + 页码归位 + 打印/导出 PDF**。共 21 个源文件改动，含 3 个新增文件。

### 修复与优化

* **规则可调用已固化技能（`action: 'skill'`）**（[rules/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/rules/route.ts) / [tools/butler.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/butler.ts)）：确定性步此前只能绑两种宿主执行器（`create_todo` / `create_scheduled_todo`），Skills 虽已能固化却**没有任何调用入口**——三层里最外面那层是断的。现补上第三类 `action='skill'`，用 `action_params.skillId` 绑定 `sk-…`：规则命中时由宿主执行该技能。两端（面板写入与 MCP 工具侧）共用同一份动作白名单，且**`skill` 动作必须带 `skillId`，否则视为非法入参直接拒绝** —— 允许一个永远跑不起来的规则写进盘里，比报错更难排查。

* **新增只读工具 `read_skills`**（[registry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/registry.ts)）：模型要绑定技能就得先知道有哪些 id。工具按行列出「id｜名（生命周期·版本·来源·原语链）+ 触发词」，可选 `lifecycle` 过滤；并在回执里写清「技能只能通过规则的确定性步调用、仅 active 可执行、起草新技能走 skill_draft」—— 把「读」与「写」的边界一并交代给模型，避免它误用只读工具去创建。归入 `butler` 场景，与 `skill_draft` 同组。

* **规则编辑器补齐动作绑定 UI**（[ButlerMemoryConsole.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerMemoryConsole.tsx)）：每个确定性步新增动作下拉（Describe only / Create todo / Scheduled todo / Run skill），选 `Run skill` 时展开技能选择器（显示 `名 · 生命周期`，已失效的旧 id 标 `not found` 而不是静默丢失），选 `Scheduled todo` 时展开时刻输入。提交前本地校验「Run skill 必须选到技能」，并把草稿转成 wire 形态（`action_params`）—— 面板与路由、工具三者同一口径，杜绝「面板存了一份、路由解析不了」的分叉。Rules 段现在也预载技能列表（此前只在 Skills 段加载）。

* **技能有了内容修订写口 `revise`**（[skills/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/skills/route.ts) / [skills.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/skills.ts)）：技能此前只有生命周期治理（停用 / 解封），**改不了内容** —— 用户想调一个参数只能重走草案卡。现补上 `POST { action:'revise', revision_kind:'param'|'flow', note?, name?, description?, when?, steps?, grants?, effects?, expected_version? }`：改内容一律 `version++` 并**追加一条 revision（新的在前）**，与规则的修订语义对齐；`expected_version` 走乐观锁，冲突返回 `conflict:true`。`id` / `created_at` / `origin` / `lifecycle` **不在可修订字段内**（生命周期仍走 `setSkillLifecycle`）；新建技能仍只能走草案卡审固。修订**不放宽执行边界**：`runtime='compose'` 的步骤照样受静态拦截。适用条件新增 `normalizeWhen`，未传字段沿用原值、`objectTypes` 走白名单。

* **记忆台的 Memories 段正名为 Preferences**（[ButlerDrawer.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerDrawer.tsx) / [butlerEvents.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/butlerEvents.ts) / [ButlerHost.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerHost.tsx) / [ButlerMemoryConsole.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerMemoryConsole.tsx)）：整个记忆台叫 Memories，里面却有一段也叫 Memories（用户长期记忆），读起来是「记忆里的记忆」。现把该段改名为 **Preferences**（类型 `'memories'` → `'preferences'`、左栏 rail 标签 `Memory` → `Memories`、脑图节点 `MEMORIES` → `PREFERENCES`、事件 `BUTLER_MEMORIES_EVENT` → `BUTLER_PREFERENCES_EVENT`），新增 `openButlerPreferences()`，旧函数名 `openButlerMemories()` **保留为 deprecated 别名**（等价调用），外部调用方零改动。

* **抓网页正文改用 Mozilla Readability**（[web.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/chat/tools/web.ts)）：原先的正文字段是 `replace(/<[^>]+>/g,' ')`—— 把导航 / 侧栏 / 页脚 / 广告和正文一视同仁。现引入 Firefox 阅读模式同款 `@mozilla/readability`（配 `linkedom` 提供 DOM），**按语义定位正文容器**；抽出的正文短于 200 字视为「没抽到」（列表页 / JS 渲染页常如此），**回退到旧的启发式清洗** —— 换抽取器也保证任何页面不会退化成空。两个依赖用**动态 import**：`web.ts` 同时导出工具定义，需防被前端引用时把 DOM 库拖进客户端 bundle。

* **Daily News 增加策展新闻源（RSS）**（新增 [feed.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/feed.ts) / [types.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/types.ts) / [generate.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/generate.ts)）：发现层此前只有关键词搜索，抓回来的常是列表页 / 二手转载。现新增 RSS/Atom 拉取：`parseFeedXml` 是**纯函数**（不碰网络，RSS2.0/Atom/RDF 三形态归一，含 CDATA / 实体解码 / Atom 的 `link@href`），`searchNewsRss` 逐个抓取且**单个源失败不影响其余、永不抛异常**。内置策展表只收**实测可用**的源（Tech：ifanr / ithome / sspai；Finance：中新网财经）—— Google News / BBC / RSSHub 在境内不可达、Bing 的 RSS 已失效、法律类无任何可用源，故**没有源的主题自然回退关键词搜索**。表按主题 **id** 索引，老 config.json（无 `feeds` 字段）也能直接吃到。合并用**源间轮转**而非全局按时间排序：实测纯排序时 Tech 的 4 条全来自 ithome，另外两家一条都进不来；轮转保证每个可用源都有发言权，源内仍是最新在前。主题新增可选 `feeds`（归一化：只留 http(s)、去重、上限 6 条）。

* **新闻按读者长期记忆挑选（方案 A）**：归纳这一步额外喂入读者长期记忆（`butler/preferences.md`，上限 30 条），用来**在既定主题范围内挑更贴读者的条目并说明 why**；**记忆不参与检索** —— 候选集合完全由 topics 决定，prompt 明确禁止据此新增条目或编造 id。记忆为空 / 读失败即整段略去，prompt 与加记忆前**逐字一致**，因此**记忆变化不触发当日重算**（当天那份仍由「缓存即标记 + Refresh now」决定，与改主题同口径）。

* **docx 分页推进到 P4：节几何动态化**（[docx-pagination.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/docx-editor/docx-pagination.ts)）：P1–P3 把 794 / 1123 / 96 / 24 写成了模块级常量，等于「所有 docx 都是 A4 + 1in 边距」，而真源在文档自己的 `w:sectPr`（单位 twips）。现引入 `PageGeometry`（纸宽/高、左右与上下边距、灰缝、页脚距）与 `geometryFromSection`（twips→px），宿主从 `readSections(parsed)[0].settings` 取节属性并 `setPageGeometry`。两处刻意取舍：① 只暴露**左右一个、上下一个**的对称边距（纸面容器用 `padding: marginY marginX`，非对称表达不出来），取**上下均值**——`2·均值 = 上下之和`，故 `h − 2·marginY` **精确等于**真实可用高，换页精度不受损；② 几何住在**模块级可变单例**里而非 React state —— `measurePageBreaks` 是纯函数、被靶场直接驱动，必须能在没有 React 时读到几何；宿主另存一份 state 用于渲染，两者在 `applyParsed` 同点写入。**只有文档确实声明了 sectPr 才切换几何，读不到就复位为 A4 默认** —— 不能拿引擎的 `DEFAULT_SECTION` 兜底（它是 **US Letter**，会让「无 sectPr 的文档」平白从 A4 变 Letter，那是视觉回归不是修 bug）。

* **页码从「页间灰缝」迁到「每页页脚」**：旧方案把页码画在页间灰缝正中，有两个硬伤 —— ① spacer 只在断点处生成 ⇒ **末页永远没有页码**；② 页码单调性靠「闭包先取值 + widget key」维持，P1 就栽在这上面。现改为宿主持有 `pageCount` 后按纯函数 `pageFooterTopAt` 渲染每页页脚，序号 `i+1` **由构造保证单调**，末页页码自然存在；页脚**绝对定位在纸内**（不参与文档流、不进 `getJSON`，因此不影响 docx 字节保真）。`pageFooterTopAt` 的口径相对工单草案做过修正：草案写 `pageTopAt(i) + …`，而 `pageTopAt` 含 `marginY`（正文区偏移），照算 i=0 会得到 1171 > 纸高 1123、**掉到纸外**；实现改为从 `i·stride` 起算，并把「页脚必须落在正文区之下」写成断言由测试守住。文档自带页脚文本时以它为准，并把引擎的 `PAGE` / `NUMPAGES` 字段占位符换成真实值。

* **docx 支持打印 / 导出 PDF**（[DocxTiptapEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/docx-editor/DocxTiptapEditor.tsx) / [docx-commands.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/docx-editor/docx-commands.tsx) / [globals.css](file:///Users/baolei/Desktop/BobWork/projects/src/app/globals.css)）：新增「打印 / PDF」菜单项，走系统打印面板（`api.print()`，失败兜底 `window.print()`）。与 MD 编辑器的关键差异：**docx 不克隆 DOM** —— 纸面本身就是按「打印成品」排的（页高/边距/页脚纵坐标/灰缝都已在几何里定死），克隆一份反而要重建整套坐标；打印期只靠 CSS 剥掉编辑态。三条打印要点写进 `docxPaperCss`：① 灰缝不占高（spacer 内联 height 只能用 `!important` + `calc()` 覆盖，故暴露 `--docx-h` / `--docx-page-gap` 两个 CSS 变量，否则第 k 页整体下移 `(k−1)·gap`）；② 纸面 `min-height` 归零（内联值含 `(pages−1)·gap`，不归零会多打一张空白纸）；③ **`@page` 是全局单例、无法用选择器限定作用域**，docx 要 `margin:0` 而 MD 依赖全局 `@page` 的 25.4/25/25.4/30mm 版心 —— 两者共用一份规则会互相破坏，故给 docx 起**命名页 `docx-page`**，并让纸型跟着节几何走（非 A4 文档也能按自己的纸型打印）。样式表 `docxPaperCss` 刻意与产出类名的代码同址，让 Electron 靶场能 import 同一份做真打印验证。

* **顺带修掉的两处静默缺陷**：① `pageSpacerKey` 去掉 `manual` 维度（灰缝内已无页码，`manual` 不影响 DOM，少一次无谓重建）；② 编辑器样式表从**模块级常量变成函数** `docxStyleSheet(geom)` —— 几何层的两条规则含节几何（负 margin 必须等于 `marginX`、`@page` 纸尺寸必须等于 `w`/`h`），写成常量的话非 A4 文档的白带就顶不到纸张边缘。标尺（横/竖）、页眉页脚编辑面板、自动适配缩放也一并改为按 `geom` 取值。

* **P4 纯函数单测**（新增 [pagination-p4.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/docx-editor/pagination-p4.test.ts) / [feed.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/feed.test.ts)）：页脚几何（「页脚落在正文区之下」）与节几何切换用断言直接钉死，不依赖 Electron 靶场（`docx-pagination.ts` 刻意用结构化类型入参、不 import 引擎，因此不受冷启动 9–15s 影响）；RSS 解析覆盖 RSS2.0 / Atom / RDF、CDATA、实体、时间缺失等边界，以及**源间轮转**的合并顺序。


## v0.7.673 (2026-10-04)

> 本版是 **v0.7.672 之后的增量**：Today 页的「建议卡」从 Today 聚合里拆出来，做成**规则引擎 + AI 只写依据**的三层结构，并新增第 4 个页签 **Daily News**；沙箱桥补上「小程序不得覆盖 Butler 真源」的护栏；docx 分页推进到 **P1 段落跨页**（Word 化）。共 36 个源文件改动，含 14 个新增文件。

### 修复与优化

* **建议卡改为「规则引擎 + AI 只写依据」三层结构**（新增 [advice.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/advice.ts) / [advice-ai.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/advice-ai.ts) / [today-advice.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/today-advice.ts)）：此前建议与日程聚在一起（`today.ts` 的 `buildSuggestion`），既算不快也说不清。现在拆成三层，分工互不越界 —— ① `advice.ts` 是**实时纯规则**引擎（零 I/O、不落盘、不进模型）：四类信号 `overdue` / `overload` / `sticky` / `stalled`，按优先级最多出 3 张卡，每张卡带可点击条目；② `advice-ai.ts` **只做一件事** —— 给已产出的卡片各写一句 `reason`，**AI 不产出、不增删卡片与条目**（id 必须来自输入卡片，多出的 id 一律丢弃，模型幻觉伤不到「可点、可勾、可跳」的结构），且输入**必须带 Memory / Rules**，否则只会产出「建议你优先处理重要的事」这类正确的废话；③ `today-advice.ts` 是组合层，让「读」与「生成」用同一份事实拼装 —— 缓存键是**卡片集合 hash**，两个入口各自拼装会让口径漂移、缓存永远打不中。

* **建议的 AI 判断走缓存，首屏绝不因等模型而卡住**（新增 [advice/refresh/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/advice/refresh/route.ts)）：`GET /api/butler/today` **只读缓存**（秒开），命中就用 AI 的 reason 覆盖规则文案；未命中返回规则文案并置 `adviceStale: true`，由前端在后台打 `POST /api/butler/advice/refresh` 生成并落缓存（`butler/.state/advice/<日期>-<hash>.json`，跨天自然失效）。模型不可用 / 超时 / 解析失败一律返回 `null`，调用方**保留规则文案，绝不半截覆盖**。

* **两条「不误报」硬约束**（写在 `advice.ts` 里，非事后补丁）：① **降级不误报** —— 数据源失败的信号直接跳过（`overdue` 查询失败时 count 是 0，不跳过就会得出「今天很空」的虚假结论），`clear` 卡只在**完全未降级**时才给；② **不假装能算工作量** —— `ScheduleEvent` 没有 `estimated_minutes` / `due_at`、`priority` 也多为默认值，所以「建议顺延哪几项」退化为可解释的两级排序（低优先级优先、同级取时间最晚），并把判据**写进文案**，让建议可解释、可反驳。

* **Today 面板建议区落地为可点击清单**（[ButlerTodayPanel.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/ButlerTodayPanel.tsx)）：移除了顶部那张蓝色建议卡，建议回归 Report 页签顶部、做成结构化可点清单；「项目停滞」项新增行动入口 `openProjectById`（[butlerEvents.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/butler/butlerEvents.ts)），与 NavSearchBox / Sidebar **走同一条切换链路**（`POST /api/projects` switch → 广播 `bobagent:project-switched`），避免出现「只切了一半」。

* **新增 Daily News：Today 面板第 4 个页签**（新增 [types.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/types.ts) / [store.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/store.ts) / [generate.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/news/generate.ts) / [news/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/news/route.ts)）：主题是**结构化**的（每个主题自带检索词 / 条数 / 语言，软上限 8），**刻意不复用 Memories**（后者是自由文本、每轮注入耗 token，且否定式会被拦成规则）。采集**复用** web 搜索链路 —— 从 `web.ts` 拆出 `searchLocalProviders`（多源降级：百度 → Bing → DDG）与 `fetchReadableText`（charset 感知解码 + 正文清洗）供新闻复用，同一套降级与垃圾结果过滤。归纳**必须基于抓到的正文**（先 `web_fetch` 再归纳，禁止只拿 search snippet 脑补），且**标题 / 链接 / 来源一律由代码从检索结果带过来，模型只回 id + summary + why，不产生 URL**（防幻觉链接）。降级时退成纯链接列表并置 `summarized=false`，界面标注 "Not summarized" —— **绝不留半截空壳**。

* **新闻主题支持对话与界面双入口**（新增 `news_topics` 工具）：与界面 chips **写同一份 config**（`butler/.state/news/config.json`），「别再推体育了」自然落成 `action=remove`。工具只改主题列表，**不触发**简报重算（重算走界面 Refresh now 或每日调度），并明确告知用户这一点。

* **沙箱桥护栏：小程序不得覆盖 Butler 真源**（新增 [bridge-guards.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/sandbox/bridge-guards.ts)）：`bridge.ts` 的 `writeWanted` 此前只做文件名清洗（够挡目录穿越），却**没有区分文件归属** —— `preferences.md`（用户记忆真源，所有联系人共享）、`roles.json`、`notify-state.json`、`profile.md` 全在射程内，且写的是 `fs.writeFile` **全量覆盖**：一次笼统的「是否允许」就能清空用户的全部记忆。现对 `butler/` 根下的平铺真源加硬护栏（`isProtectedButlerFile`，大小写不敏感），拒绝写入并说明原因；同时把**目标文件名**带进确认文案，让用户在按下确认前看得到会覆盖什么。

* **编排链路的「不对外部状态产生副作用」契约补齐**（[tools.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/tools.ts)）：`SANDBOX_BLOCKED_TOOLS` 补入 `remember_preference` / `update_preference` / `delete_preference` —— 它们改的是**跨会话、跨联系人共享**的全局记忆，此前名单外的空档等于给着写接口。只读的 `read_preferences` 不拦。（`set_model_price` 仍**不拦**：它写的是应用数据而非用户记忆，是否要拦是另一个决定，此处显式记录以免被当成漏改。）

* **docx 分页推进到 P1：段落可以跨页断开**（[docx-pagination.ts](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/docx-editor/docx-pagination.ts)，+415 行）：此前只有块级断点（间隙插在**顶层块之前**，整块下移），段落永远不劈开。现新增**段内断点**（`inlinePos`）—— 用 `view.coordsAtPos` 定位「哪一行是下页首行」，间隙插在**段落内部的文档位置**，段落因此能在页底断开、下半段从下页页首继续，与 Word 的跨页行为一致；只有「剩余空间不足以留下 2 行」或「该块不是文本块（表格 / 图片 / 占位）」时才退化为整块下移。分页仍是**纯视觉层**（装饰不进文档模型，`getJSON` 逐字节不变、分页 meta 不压撤销栈）。

* **段内断点的两个实测坑**（都写进了代码注释）：① 段内间隙必须 `display:block` 才能断行（`inline-block` 实测**无效**，只撑高当前行）；而 `display:block` 插进行内会让浏览器多生成一个匿名行盒 ⇒ 实际推进量 = 设定高度 + 一个恒定碎屑（15px→+3.0 / 17px→+3.2 / 19px→+3.9，**与设定高度无关**），故新增 `inlineBreakExtra()` 按实测点做**分段线性插值**（字号档位会变，不能写死常数）。② 取行几何只能走 `SHOW_TEXT` 遍历 —— 段内 spacer 就住在段落内部，若用 `range.selectNodeContents().getClientRects()`，那条数百 px 的 spacer 会被当成「一行」计进去；落在 spacer 上的那条缝隙也不能按差值扣减，直接归一为一个正常行距。

* **分页测量下沉为纯函数 + 修两处静默缺陷**：测量算法抽成 `measurePageBreaks(view, opts)`（输出纯数据，无 DOM 副作用），宿主只负责「就绪判定」与「落盘 + 触发装饰重算」。顺带修掉两处 —— ① spacer 的装饰 key **必须涵盖一切影响 DOM 的量**（`prosemirror-view` 的 `WidgetType.eq` 在 `spec.key` 相同时直接判定相等并**复用旧 DOM**，于是「padTop 变了但高度不更新」会静默发生）；② 段间白带左右用负 margin 顶到纸张边缘，让白带与灰缝**铺满整张 A4**（此前只铺正文列 602px）。

* **修「打开 docx 后整个面板反复闪烁」**（[DocxTiptapEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/docx-editor/DocxTiptapEditor.tsx)）：`onError` 是父层传入的**内联箭头函数**（`UnifiedViewer.tsx`），父组件每渲染一次就换一个新身份；它一旦进了装载 effect 的依赖数组，父层的**任何一次重渲染**都会重跑装载（`setLoading(true)` → 整块面板含标题栏 / 工具条被换成一页「正在加载文档…」占位）。现用 `onErrorRef` 固定最新回调使其不参与依赖比较，并把占位符改为**只在还没有任何内容时**才整块替换（`loading && !parsedRef.current`），一旦装入过一次就保留面板结构。

* **P2 保真属性往返单测抓到真缺陷**（新增 [pagination-fidelity-roundtrip.test.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/docx-editor/pagination-fidelity-roundtrip.test.ts)）：`keepNext` / `keepLines` / `widowControl` 的分页消费侧此前由 Electron 靶场验证，但靶场是**手工构造 JSON + `setContent`** 灌进编辑器的，**绕过了适配器 A**。补上「引擎 `Block[]` → `blocksToDoc` → JSON → 编辑器」的完整链路验证后，本文件第一版是**红的** —— 它抓到 `docx-schema.ts` 的 paragraph / heading **未声明**这三个属性，而 `NodeType.createChecked` 走 `computeAttrs`（只遍历 schema 声明的属性）⇒ **未声明属性被静默丢弃**，适配器 A 那条写入形同虚设。修法：在 `docx-schema.ts` 与 `docx-tiptap-extensions.ts` **同名同形**地声明这三项。

* **项目日报补「昨日待办对账」**（[daily-digest.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/daily-digest.ts)）：输入里多一份按 `status` 分「完成 / 遗留」的对账（另以确定性的 `#### ⏱ 昨日待办对账` 小节落在明细之后，**模型路径与兜底路径共用同一份，不靠模型转述**），让小结能给出**判断**（完成情况、遗留了什么、今天该先接手什么）而不是复述流水。对账**直连 DB 而非 `querySchedule`** —— 本函数由日报调度器调用时没有 baseUrl，相对 URL 在 Node 下 fetch 会失败；区间用本地日界，与 `localDateKey` / `today.ts` / `schedule.ts` 三处同口径。已知口径限制（不额外补接口）：`listEventsInRange` 硬排除 `cancelled`，故只分完成 / 遗留两类。

* **项目停滞信号有界求得**（[activity.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/project/activity.ts) 新增 `getProjectLastActivityAt`）：新增有界 mtime 扫描 + 进程内 memo，为建议引擎提供「最近一次活动」；失败只丢这一类信号、不影响其余建议（建议引擎对空数组是安全的）。


## v0.7.672 (2026-10-02)

> 本版是 **v0.7.671 之后的增量**：给记忆补上**用户手写入口**（此前唯一的写入者是模型），并把「这条记忆是哪次对话记的」真正做成可溯；另把记忆真源的并发写保护补齐，常驻档安全阀从「整体退化」改为「按优先级逐级退化」。编辑器侧把 docx 工具条的二元宽窄档换成 Word 式自适应折叠，并把一期误合并的对齐 / 列表下拉还原为按钮。共 13 个源文件改动，含 2 个新增测试文件。

### 修复与优化

* **记忆面板补上「用户手写」入口**（[preferences/route.ts](file:///Users/baolei/Desktop/BobWork/projects/src/app/api/butler/preferences/route.ts) 新增 `POST`）：此前记忆的**唯一写入者是模型**（对话里的 `remember_preference`），用户想「记住这个」没有任何兜底。现在 Memory 面板有 `+ New memory`（内容 + 类型），而 POST 与 `remember_preference` **复用同一套四道闸** —— ① 敏感信息拒写、② 否定式表达转规则、③ 精确重复拒写、④ 同类型高相似倒逼更新 —— 回执按原因分流（`blocked` / `routed` / `duplicate` / `conflict`），敏感与冲突都**不回显原文**。`conflict` 额外在界面上给出 **`Update #N instead`** 出口（走 `PATCH` 更新既有条目，正是那道硬闸想让人做的事）。手写来源记 `source: 'panel'`，与模型抽取区分，用户能看出「这条是我自己写的」。

* **记忆来源可溯到「哪次对话」**（[entry.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/butler/entry.ts) → `/api/chat` → `ToolExecContext.threadId`）：Butler 链路此前只传 `nodeId`，而那是**占位符**（`BUTLER_PLACEHOLDER_NODE_ID`）—— 等于**同一把钥匙开所有会话的锁**。现在 `entry.ts` 的两处调用都带上真正的 `threadId`，route 解析出 `butlerThreadId` 后注入工具执行上下文；`remember_preference` 据此把来源写成 **`chat:<threadId>`**（长度收敛到 120 字符，异常超长的 id 不该把元数据行撑爆），Memory 台里就能看出「这条是哪次对话记的」；规则预算（`.state/rule-budget`）也随之分片到**真实会话**，不再所有会话共用一个桶。**非 Butler 链路不传该字段 → 全部退化为原行为**。

* **记忆真源补上并发写保护**（[preferences.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/preferences.ts)）：`addPreference` / `updatePreference` / `removePreference` 此前都是裸的 `readFile → writeFile`（无锁、无 tmp+rename）。记忆是**单文件真源**（`preferences.md`），而写入方有两条独立链路（抽屉会话 + 微信 / 飞书桥，后者是**另一个进程**），并发读改写会**整条丢记忆**。现统一到 `createLock` + `atomicWriteFile`（`lib/butler/fs-atomic`），首建 `preferences.md` 也走原子写 —— 这是 rules / skills / threads / rule-logs / storage 之后补齐的最后一个落点。⚠️ 锁**不嵌进** `ensurePreferencesFile`：它也会被只读的 `listPreferences` 调用，而三个写函数在持锁期间会调它，同锁二次 acquire 会死锁。

* **常驻档安全阀由「整体退化」改为「按优先级逐级退化」**（[preferences-shared.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/core/preferences-shared.ts) 新增纯函数 `selectResidentTypes`）：此前只要「身份画像 + 偏好习惯」**合计**超过 20 条，就整体退化为只注入目录 —— 连**身份画像**也一起掉出常驻档，用户会突然感觉「它不记得我了」，而这恰恰是常驻档存在的理由。现在按优先级**前缀**从高到低逐级纳入，某一级放不下就**到此为止**（不跳过它去纳更低优先级，否则会出现「低优先级的还在常驻档、高的反而掉进目录档」的倒挂）；空条数的类型不占额度、也不打断前缀；退化粒度是**整类型**（同类型一起进退，口径才好解释）。[context.ts](file:///Users/baolei/Desktop/BobWork/projects/src/lib/runtime/context.ts) 的注入标题随之写实际驻留的类型，而非写死名单。

* **docx 工具条：二元宽窄档 → Word 式自适应折叠**（[DocxTiptapEditor.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/docx-editor/DocxTiptapEditor.tsx)）：原来的 `WIDE_TOOLBAR_MIN = 700` 是二元档，**要么全给要么全收**，在默认面板宽度上就表现为「字体 / 样式的下拉忽然消失」，用户观感是功能被藏了。现改为宿主持一张 `toolbarSlots()` 槽位表（展示顺序 + `evictRank` 淘汰优先级 + 宽度估算），由 `fitToolbar()` **按可用宽度逐个槽位贪心淘汰**，被挤出的整组由 `renderOverflowRow` 在 ⋯ 菜单里补位（功能始终可达），容器由 `overflow-x-auto` 改成 `overflow-hidden`（永不出现横向滚动条）。**宽度不写死 px**：工具条尺寸类全是 rem，而本项目 `html` 字号随「字号档位」在 15 / 17 / 19px 间切换，按 16px 基准估算会在**大字号档位下低估宽度、把按钮剪掉** —— 故新增 `remPx` 实测根字号 + `toolMetrics` 换算；因档位走 `:root[data-fontscale]` 属性切换、`font-size` 变化未必触发 ResizeObserver，另用 MutationObserver 兜住。

* **对齐 / 列表由下拉还原为按钮**（[docx-commands.tsx](file:///Users/baolei/Desktop/BobWork/projects/src/components/canvas/docx-editor/docx-commands.tsx)）：一期把 4 个对齐 + 2 个列表并成 2 个下拉，理由是「省空间」；实际宽度核算显示 **6 个按钮（160px）比 2 个下拉（164px）还窄** —— 前提根本不成立，却牺牲了 Word 的所见即所得，属误判，已还原为 6 个独立按钮（新增 `alignLeft` / `alignCenter` / `alignRight` / `alignJustify`、`bulletList` / `orderedList`），判据 `alignActive` / `liKindOf` 一并下沉到命令表，宿主不再各存一份。同时命令表引入 **`toolSection`** 分区（`inline` / `script` / `align` / `list` / `paraIndent` / `paraMisc` / `insert`），上标 / 下标 / 缩进 / 分页符 / 清除格式 / 表格 / 图片由 `menu` 升为 `primary`（候选常驻、可被挤出），`commandsOfToolSection()` 成为工具条的唯一取数入口，`commandsOfTier()` 退为 ⋯ 菜单入口。新增 `preferences-shared.test.ts` 与 `preferences/route.test.ts` 锁住上述闸门与退化优先级。


## v0.7.671 (2026-10-02)

> 本版是 **v0.7.670 之后的增量**：把 Butler 的「定制总览页 Customize」正式改名并扩为**记忆台 Memory**（四段 → 六段），为此新增一个只读聚合端点把此前**分散在四类落点、且没有任何读口**的记忆证据收进视图。共 14 个源文件改动，含 2 个新增实现/测试文件与 1 处文件改名。

### 修复与优化

* **「定制总览页」改名并扩为记忆台**（`ButlerRulesPanel.tsx` → `ButlerMemoryConsole.tsx`）：这个面管的是**「Butler 记得什么、学到什么、凭什么」**，不是外观定制，故名字统一为 Memory —— 左栏 RailItem、顶栏标题、`aria-label` 三处同字（图标沿用原 Memories 的 `Brain`）。**只改 UI 文案，事件名与函数名一概不动**（`openButlerMemories()` / `BUTLER_MEMORIES_EVENT` 保持原样，落到 `section='memories'`），避免打断既有调用方。面板由**四段扩为六段**：Memories（内嵌 `ButlerMemoryPanel`，增改删全功能）、Rules、Skills 三个实体段，外加 **Threads**（会话上下文，只读锚点）与 **Knowledge**（项目账本 `.ledger/`，只读锚点）两类此前缺位的实体，SIGNALS 则从「与实体并列的入口」降级为 **Evidence 视图**。

* **新增只读聚合端点 `/api/butler/memory-audit`**（新增 `app/api/butler/memory-audit/route.ts`）：记忆台的 Evidence 段要回答「Butler 凭什么这么记、这么学」，而这些数据此前**分散在四类落点且没有任何读口** —— 被拉黑模式（`butler/.rules/.logs/negative-sample/<objectType>.jsonl`）、near-miss 询问额度（`.state/rule-nearmiss.json`）、每会话主动冒头预算（`.state/rule-budget/<threadId>.json`）、规则产出引用（`hits/<ruleId>.jsonl` 的 `producedRef`）。新端点把这四类**纯聚合**读出（**只读，不写任何文件、不新增存储、不新增真源**），外加「最近记忆活动」时间线（记忆 / 规则 / 技能按创建时间合并倒序）与**真源绝对路径**（给用户自行备份用）。**各段独立容错**：某一类读失败只让该段为空，不让整个视图 500（脏数据不阻断）；负样本的**解封**仍走既有 `DELETE /api/butler/rules/negative-samples`，本端点只负责看。新增 `route.test.ts` 锁三条不变量：空态是安全输入（各段空数组、不 500）、各段聚合正确（负样本两类 / 额度 / 预算 / 产出引用 / 最近活动）、坏 JSON 只让该段为空。

* **脑图落点由四节点扩为六节点**（`ButlerMemoryConsole.tsx`）：进入 Memory 先落在脑图，点节点才进对应分区页，分区页不再保留横向标签，只留左上角 `← All` 返回。六节点的语义分组是**左列 = Butler 自己的记忆（三实体）**、**右列 = 上下文 / 证据 / 外部锚点**。几何是**算出来的、不是估的**：平面坐标系固定 720×400，脑与卡片位置全用百分比；突触终点取脑轮廓三次贝塞尔上的实点（**反解坐标**），因此连线端点必然贴在皮层上；脑、连线、卡片必须同处**一个 z 平面**（加一层 `translateZ` 就会因透视额外放大位移、端点脱离皮层 —— 这里踩过一次坑）。脑图下方另置两条常驻信息：**最近记忆活动**（记忆是自动抽取的，用户没说「记住」也会被记，故必须有个就近出口）与 **Where is this stored?**（四个落点都是明文文件，把绝对路径说出来，用户才有「我的记忆在哪、能不能搬走」的兜底）。

* **服务端补三个只读辅助 + 一处真源上移**：`rule-nearmiss.ts` 新增 `readAskCounts()`（与 `consumeAsk` 读同一份文件、只读路径不含锁）；`rule-exec.ts` 新增 `listRuleBudgets()` 并把预算目录抽成 `budgetDir()`（供证据视图展示「这个会话还能主动问几次」，**不改行为**）；`rule-signals.ts` 新增 `NEGATIVE_OBJECT_TYPES` 常量作**唯一真源**（原先内联在 negative-samples 路由里），由可见 / 解封路由与 memory-audit 聚合共用，避免两处漂移。

* **线程摘要带出常驻工作区**（`threads-shared.ts`）：`ButlerThreadSummary` 补 `workspaceFolder` 字段（真源是线程文件的 `workspaceFolder`，非绝对路径一律归一为 `null`），`summarizeThread` 同步补映射 —— Memory 台 Threads 段要显示每个会话的常驻工作区；与联系人列一样**只带路径与展示名，不复制内容**。`threads.test.ts` 增一条用例锁「随摘要带出 / 无则 null」。

* **记忆面板补两条知情信息**（`ButlerMemoryPanel.tsx`）：记忆条目显示**来源** `via <source>`（记忆是自动抽取的，用户有权知道「这条是怎么来的」，`source` 目前是通道标记）；删除档显示**后果明示**（删除是真删 —— 整块从 `preferences.md` 移除，且影响**所有**联系人、不可撤销），把「档 2（不可逆）」说在按下之前。


## v0.7.670 (2026-10-02)

> 本版是 **v0.7.669 之后的增量**：落地 2026-10-02 Butler 架构评审的一轮加固（并发写原语收敛、打扰闸接线、漏触发告知、孤儿角色回收）。共 30 个源文件改动，含 3 个新增实现文件与 5 个测试文件。

### 修复与优化

* **并发写原语收敛为唯一真源**（新增 `lib/butler/fs-atomic.ts`）：同一套并发控制此前有 **5 份副本**（`rules.ts` / `skills.ts` / `rule-logs.ts` / `storage.ts` 各一份模块级串行锁，`threads.ts` 一份分键锁），另有 **8 处** `${pid}.${Date.now()}.tmp` 临时文件名 —— 同毫秒并发会互相覆盖，先完成的 rename 把 tmp 移走后，另一个 rename 直接 ENOENT。现统一为 `createLock()` / `createKeyedLock()` / `atomicWriteFile()`（随机后缀 + rename 重试 3 次 + 失败清 tmp），并迁移 rules / skills / rule-logs / storage / threads / sticky-write / daily-report / rule-nearmiss 的全部落盘点。
  * **修掉两个真实失效**：`consumeBudget`（会话预算）与 `noteBehavior` / `consumeAsk`（近失询问额度、行为计数）此前是**无锁**读-改-写，同毫秒并发会互相覆盖 → 预算与额度都能被绕过。预算文件按 threadId 分片，故改用**分键锁**（不同会话互不阻塞，同一会话串行）。

* **B5 打扰闸正式接线**（新增 `app/api/butler/push-gate/route.ts`）：`lib/core/quiet-hours.ts` 里的免打扰窗口 / 单日上限策略早已实现，但 `decidePush` / `recordPush` **全仓零调用方**（策略从未生效），而设置界面已把它呈现为「Butler Notify / Stay quiet」。新路由把通知 kind 映射为策略类别并裁决（**失败即放行**，宁可多打扰一次也不静默掉通知）；日报出口 `GET /api/butler/daily-report` 就地过闸 —— 窗口内**不取走 pending**（报告留在队列、窗口结束由下一轮轮询续发，**不丢数据**），放行时逐条计数，让「单日上限」成为真上限。客户端 `ButlerNoticeHost` 弹 toast / 系统通知前问一次；`bus.ts` 的 `ButlerNoticePayload` 新增 `interrupt: 'gate' | 'always'`，义务性通知（规则执行回执、错过的定时执行、用户自订日历提醒）与**服务端已裁决过**的日报都标 `always`，避免双重计数。

* **漏触发「明说一句」**（评审 §2.2-7）：定时心跳寄生在渲染进程，只有 24h 补偿窗口 —— 应用关得久一点，期间到期的实例就**永久不会补跑且无人知道**。`rule-timer.ts` 新增 `missedTimerRules()`（扫描窗口 30 天；逐实例判定、每条规则只取最新一个漏掉的实例、**每条规则只告知一次**、一次最多 3 条，标记落 `.state/rule-missed-reported.json`），`butlerTick` 返回 `missed` 并经 tick 路由透传，客户端弹一条「有定时规则错过的执行」。**只告知不补跑**（补跑会一次炸出一串历史实例）。

* **孤儿角色条目回收 + tmp 残骸清扫**（评审 P2-⑯/⑮）：`roles.json` 是只增不删的注册表，线程被删（过期清扫 / 删除联系人）后条目仍留着（实测 10 条角色 vs 3 个活线程）。`storage.ts` 新增 `pruneOrphanRoles()`，`sweepThreads()` 顺带调用，并清理 1 小时前的 `.tmp` 残骸（实测残留 4 个、两个各约 150KB）。**只清指针，绝不动角色目录**（附件与文档仍在）。

* **定时链路补上预算锚点**（评审 P2-⑱）：`consumeBudget` 依赖 threadId，缺省时直接视为有额度，而 60s 心跳此前不带 threadId → 定时链路永不扣预算。`butler-active-thread` 的 localStorage 读写从 `ButlerDrawer` 外移到新增的 `components/butler/butlerSession.ts`，供心跳读取并随 tick 上报。

* **排期纪律注入幂等**（`lib/runtime/context.ts`）：`buildScheduleDisciplineInjection(basePrompt?)` 在 system 已逐字包含同一常量时返回空串 —— 新装用户的 `agent.json` 本就由当前源码物化、已含最新口径，再注入一遍是每轮约 950 字符的逐字重复，还会给模型制造「新旧两版挑一个」的伪冲突；已装老用户的 `agent.json` 是旧文本，仍照常注入覆盖。传 `undefined`（老调用点）行为不变。

* **杂项收敛**：`PREVIEW_MAX` 真源收进 `threads-shared.ts`（此前 `butler-search` 60 / `butler-recorder` 64 两份副本）；`report-doc.ts` 的 `NOTIFY_THREAD_ID` 改从 `./storage` 取，去掉对 `butler-notify` 的引用；docx 编辑器给纸面容器补上 `ref`，并把分页守卫改为 `paperRef → scalerRef → canvasRef` 回落链 —— 守卫挂在**从未挂载**的 ref 上会「永远从这里返回 ⇒ 分页一次都没算过」，而 `pageCount` / `paperHeightPx` 恰好停在 `useState` 初值（1 / PAGE_H），界面上完全看不出失效。


## v0.7.669 (2026-10-02)

> 本版是 **v0.7.668 之后的增量**，只改了 1 个文件（DocxTiptapEditor.tsx）。

### 修复与优化

* **修复 docx 多页文档被渲染成「一页白纸 + 满屏灰底」**（`components/canvas/docx-editor/DocxTiptapEditor.tsx`）：分页测量的状态量默认停在 `pageCount=1` / `paperHeightPx=PAGE_H`，当测量早于布局完成（块高全读成 0）时 `breaks` 为空却照写状态，页数被钉死在 1 —— 界面表现为只有第一页是白的、正文溢出到画布灰上，且**看不出测量失败**。本版把测量改为「未就绪就不写状态」：视图 / 布局未就绪，或有内容却一个块高都读不到时，延时重测（120ms × 最多 8 次，有上限不空转）；并在装入文档后立即重测 + 多趟补测（80 / 260 / 700ms），覆盖字体与图片的异步布局。
  * 块高测量增加回落：`view.nodeDOM(offset)` 拿不到元素时，改用 `.ProseMirror` 的直接子元素，且**仅在两处数量一致时**启用（尾随 hack 节点会导致错位）。
  * 组件卸载时清理「重试」与「多趟补测」定时器，避免卸载后继续测量。


## v0.7.668 (2026-10-02)

> 本版是 **v0.7.667 之后的增量**，仅含一项修复，无其它源文件改动。

### 修复与优化

* **修复打包版自定义 server 无法加载 `better-sqlite3`**：`src/server.ts` 经 tsup 打包为独立的鉴权网关 `server.js`，其中以裸名 `import("better-sqlite3")` 动态加载原生模块；而 Next standalone 只在 `.next/node_modules/` 下以**哈希别名**（如 `better-sqlite3-<16hex>`）暴露 `serverExternalPackages`，根 `node_modules/` 缺少裸名入口，导致日历后台同步在运行时抛 `Cannot find package 'better-sqlite3'`。打包脚本现将已有的哈希别名镜像为根 `node_modules/<pkg>` 裸名符号链接，日历 DB 同步恢复。


## v0.7.667 (2026-10-02)

> 本版是 **v0.7.666 之后的增量**。666 于 10-01 20:10 构建并已发布；本批 **23 个文件**的改动全部发生在 666 构建之后（微信检索口径、系统提示注入、运行时前缀缓存、docx 编辑），不在 666 包内。

### 新增

* **检索质量离线评测体系**（`lib/butler/search-eval.ts`、`lib/ai/rerank.ts`）：公众号检索链路此前**没有任何量化指标**，只能靠肉眼翻账本；本版补上召回 / 精选 / 误杀 / nDCG 四类指标 + golden 标注与报告渲染，把「这轮搜得准不准」变成可复算的数字。
  * 配套的 `rerank` 模块落的是**探测结论而非功能**：智谱 preset 里的 `rerank-3` 实际不存在（调用直接 HTTP 400），且 `rerank` 模型分数几乎无区分度（实测 51 篇**全为 1.0**）。故提供 `isDegenerateScores()`，让调用方把这种「无重排能力」当降级处理，而不是拿一堆 1.0 当真排序。

* **运行时缓存遥测**（`lib/runtime/cache-telemetry.ts`）：新增 `cache-telemetry.jsonl`，按**调用级**记录三段（system / tools / messages）指纹与漂移标记，把此前要靠人工 join 两套日志才能归因的「到底哪个前缀段变了」，做成一条自解释记录。

* **微信检索「去重 + 追踪」抽出独立模块**（`lib/butler/wechat-dedupe.ts`、`lib/butler/wechat-trace.ts`）：去重口径与账本组装从路由里抽成可测模块，各自带单测；账本新增 `rank`（仅在模型**真的排过序**时才写，防止 nDCG 虚高）与 `queries` / `intent`，可直接归因「是规划差还是搜狗排序差」。

### 修复与优化

* **DeepSeek V4 系统提示（base system prompt）未下发**（`api/chat/route.ts`）：base 提示与「思考引导」原先耦合在同一个三元守卫里，而 V4 的 `shouldInjectThinkPrompt` 恒为 `false`——于是 `BASE_SYSTEM_PROMPT` 及各画像专属 base **整段没有下发**，system 里只剩前端那截短提示。现拆成 `ensureBaseSystemPrompt`（无条件注入）与 `injectThinkingGuidance`（受守卫控制），V4 恢复完整系统提示。

* **微信检索按 url 去重失效**（`api/butler/wechat-search/route.ts`、`api/butler/wechat-search/enrich/route.ts`、`lib/bus.ts`、`lib/core/butler-search.ts`）：搜狗的 `/link?url=` 是加密跳转链，**每次 token 都不同**，按 url 判定等于没去重；改为**标题归一化去重** + 跨方向轮转 + 上限卡唯一条数（实测同一轮 62 条收敛为 51 篇唯一）。规划 prompt 同时新增「至少一个方向按法律文书正式名称搜」并优先一手来源（法院 / 政府原文）。

* **前缀缓存跨重启 / 跨状态漂移**（`lib/runtime/session.ts`、`api/chat/tools/index.ts`、`lib/runtime/tools.ts`）：sticky 场景表由纯内存改为**落盘** `.runtime/sticky-scenes.json`（LRU 上限 500、仅变化时写盘），修复应用重启后工具集从「常驻全集」塌回子集、导致首个请求缓存全废（CacheGuard 一月记 63 次 cross-restart-drift）；MCP 工具快照兜底从「仅 browser」推广到**全部 server**，并加 `expectedServerIds` 白名单护栏——用户禁用 / 删除服务立即生效，桥抖动不再整段作废前缀。

* **docx 编辑器：分页视觉保真 + 命令单一真源**（`components/canvas/docx-editor/docx-pagination.ts`、新增 `docx-commands.tsx`、`DocxTiptapEditor.tsx`）：
  * 修复「只有第 1 页像纸」——换页间隙改为**白 → 灰缝 → 白**三段构造，每页都是等高完整 A4；并修正页起点累加漏算 spacer 导致的滚动 / 页码偏移。
  * 工具栏与 ⋯ 菜单的命令合并到 `docx-commands.tsx` **单一真源**，按 `tier` / 宽度条件渲染，消除同屏副本与「改一处漏一处」；对齐 / 列表压缩为下拉。

* **检索实况入口去重**（`components/butler/ButlerDrawer.tsx`）：有账本时只保留「打开右侧检索实况」单入口，去掉卡片里的重复副本。


## v0.7.666 (2026-10-01)

> 本版是 **v0.7.665 之后的增量**。665 的构建标记为 09:00:58 并已发布；本批改动全部发生在 **16:11–16:53**（11 个文件：会话工作区、注入块剥离、检索实况落库），不在 665 包内。

### 新增

* **Butler 会话级「工作区」（锁定操作范围）**（`lib/butler/threads-shared.ts`、`lib/butler/threads.ts`、`api/butler/threads/session/route.ts`、`components/butler/ButlerDrawer.tsx`）：一个目录 = 一条会话的操作范围，**常驻**而非一次性的「发送目录」——选定后每轮对话都随消息注入「锁定操作范围」，发送后不清、切联系人各自保留（与画布「操作目录」同一语义，区别只在这份会记住）。
  * **存储挂在会话上**：`ButlerThread.workspaceFolder`（`{ path, name }`）随线程文件存活 / 删除；**唯一写入口是 `setThreadWorkspace`**，消息链路（`upsertThread`）只沿用文件里的旧值、不参与它的变更——工作区是「读者行为」，不该被发消息顺带改写。与 `setThreadModelSettings` 同口径：**不动 `updatedAt`**，换个工作区不该把会话顶到联系人列最前。
  * **入口是 PATCH，即选即存**：`PATCH /api/butler/threads/session` 新增 `{ workspace: { path, name } | null }`（`null` = 清除），不等下一条消息；任何线程都可改（含 Recorder / 通知助理），与选型同属读者行为。线程查询回填 `workspaceFolder`，切联系人时还原 pill。
  * **清洗口径**：`parseWorkspaceFolder` 只认**绝对路径**（非绝对、或超 `WORKSPACE_PATH_MAX` = 1024 字符，一律视为「未指定」→ `null`）；`name` 缺省取路径末节兜底——pill 要显示名字，缺了不该整个工作区失效。新建会话默认不带工作区。
  * **展示**：pill 超长前端截断，悬停给全名 + 路径。

* **检索实况「落库」——账本随综述消息一起存活**（`lib/bus.ts`、`lib/core/butler-search.ts`、`api/butler/wechat-search/enrich/route.ts`、`components/butler/ButlerDrawer.tsx`）：v0.7.665 的右栏实况只管**这一次**（关掉就没了）；本版把账本写进综述消息——**消息在则账本在，删掉消息账本一并消失**。
  * **新增 `WechatSearchTrace` / `WechatSearchTraceItem`**，挂到 `ChatMessage.searchTrace`；服务端线程存储逐字段透传（`parseThread`），与「卡片」同源。
  * **为什么由服务端组装（`buildTrace`）**：落库那一刻信息全在服务端手里（候选全量、入选与理由、正文读取结果、逐篇摘要），前端只从 SSE 拿过一部分帧——**尤其是被判定掉的那十几篇，只有服务端是完整的**。顺序按召回的原始下标，前端分组后仍与原顺序对得上号。
  * **失败也有账**：精编不可用 / 中途抛错时走 `fallbackTrace`（前 `MAX_PICK` 篇标为入选），右栏不留空。
  * **入口随时可重开**：气泡下方的「查看检索实况」据此重开右栏——抽屉关过、应用重启过都还能点开，不再是一条时灵时不灵的死链。

### 修复与优化

* **剥离正文尾部的「注入块」**（`lib/butler/threads-shared.ts`、`lib/butler/transcript.ts`）：附件列表与会话工作区是**发给模型的上下文**，随正文一起上送并原样落库；重新打开会话会连块一起读回，于是用户气泡与 `butler/<角色>/<日期>/chat/*.md` 里冒出 `--- Attachments ---` / `--- 工作区（用户指定 · 锁定操作范围） ---` 这类机器文案，而刚发出那条气泡用的是干净原文——两条路径显示不一致。
  * **标记集中定义**（`ATTACHMENTS_BLOCK_HEAD` / `WORKSPACE_BLOCK_HEAD` / `INJECTED_BLOCK_HEADS`），让「拼接」与「剥离」同源，改标记时不会漏改另一处。
  * `stripInjectedBlocks` 按**首个**命中标记截断（块恒追加在尾部）；调用方只在 user 消息上用——转录记录（给人看的那份）与气泡同口径。
  * **不在发给模型的正文上调用**：块由客户端每轮重新注入，历史里有没有都不缺上下文。



## v0.7.665 (2026-10-01)

> 本版是 **v0.7.664 之后的增量**。664 构建于 08:12–08:13，因上传脚本踩到 Xcode 许可问题漏发，已于 08:56 用修复后的脚本补传并校验（远端 `latest` 已指向 664）；本批改动是 **08:13 之后**对 `components/butler/ButlerDrawer.tsx` 的重写，不在 664 包内。

### 新增

* **Butler 右栏「检索实况」（Search Live）—— 本轮公众号检索的逐篇账本**（`components/butler/ButlerDrawer.tsx`）：中栏只呈现**结果**（小微落库的综述 + 精选卡片），右栏呈现**过程判定** —— 召回的全部文章、哪几篇被留下、哪几篇被判掉。
  * **为什么把「判掉的」也留着**：AI 一次只精读 3 篇，剩下十几篇是**被判掉而不是没搜到**；用户被蒙在鼓里就无从判断这轮检索靠不靠谱。判掉的照样能点开，只标一枚拇指向下，说明「模型看过它、没选它」。
  * **分三段**：留下 / 判定中（检索结束则显示「未判定」）/ 去除；段内保持召回原顺序（序即检索排序，不重排以免对不上号）。判定语言统一为拇指：`ThumbsUp` = 留下（已精读）、`ThumbsDown` = 去除（灰）、`Loader2` 转圈 = 待判定。
  * **起搜即切右栏**：点下去那一刻就把右栏切到实况并清空上一轮账本（先写「正在检索…」），候选一到就逐篇入账，不必等综述写完；若文档预览正占着右栏会先收掉，否则实况被它挡住。
  * **过程态临时、不落库**：`curated` / `article` / `summary` 三类帧**只用于判定展示**（哪篇留下、正文是否读到、逐篇一句摘要），记的是判定过程而非结果内容，故不算镜像真源；`digest` 帧仍刻意不接（综述是结果态，中栏已有落库的那一份）。精选未入选的按下标 / url 双键置为 `dropped`；精编中断时把仍 `pending` 的一律落定为 `dropped`，免得留一排永远转圈的「判定中」。
  * 附带信息：正文未读到时标「正文未读到」（说明只有搜索摘要可用）；`keypoint` 以主色小标签展示。
  * **入口刻意不占左栏键**：实况是**这次检索的附属视图**而不是独立去处——检索在联系人列顶部发起，回看也在那里；左栏管的是右栏分区（Today / Calendar / Meeting 这类常驻去处），两条轴各管一段。

### 修复与优化

* **点击抽屉外任意处收起 Butler 抽屉**（`components/butler/ButlerDrawer.tsx`）：用一层铺满视口的**透明挡板**（`z-1299`）承接点击，而不是给 `document` 挂 `mousedown` 监听。
  * **语义要的是「吞掉」这次点击**：被点中的画布节点 / 侧栏 / 树节点不该同时响应；监听器只能决定「收不收抽屉」，拦不住外部元素自己的动作，一层挡板天然吞掉。
  * **层级取 1299 的两头考量**：高于全部常规页面内容（画布 UI `z-40`、旧面板 `z-1200/1250`）而**低于悬浮球 `z-1300`** —— 贴着抽屉取值会把球一起盖住（点不动、拖不动、hover 也没了）。高于抽屉的浮层（toast `1350` / 排程确认卡与 PersonaDialog `1400` / 画布侧栏弹窗 `1600` / ConfirmDialog `9999`）都在挡板之上，点击不受影响，也就不必为「有弹窗时不要收起」逐项加判断。
  * 不做可见遮罩（抽屉刻意「无遮罩」，这里只挡事件、不压暗画面）；只认主键，右键（`button !== 0`）放行，画布右键菜单照常。
* **修复上传脚本漏发：`python3` 换成 `node`**（`scripts/upload-to-gitcode.sh`）：macOS 的 `/usr/bin/python3` 是 Xcode 垫片，未同意 Xcode 许可协议时会直接抛 `You have not agreed to the Xcode license agreements` 并以 69 退出 —— 整个上传**还没发出任何请求就失败**，而调用点只 `warn` 不中断，于是「构建成功」的假象下产物从未上线（v0.7.664 实测：远端 `latest-mac.yml` 仍停在 0.7.663）。提取 Release Notes 改用 node（脚本本就依赖 node 取版本号），语义与原 python 版本一致。

## v0.7.664 (2026-10-01)

> 本版是 **v0.7.663 之后的增量**。663 构建于 07:04–07:07 并于 07:07 发布；本批改动全部发生在 **07:56–08:07**（会议 / 播客相关 5 个文件），不在 663 包内。

### 修复与优化

* **删除会议产物时一并回收本地音频 —— 不再留孤儿文件**（`app/api/butler/meeting/route.ts`）：此前 `DELETE` 只删那一份 md，录音分片与播客音频原样留在磁盘上。
  * **只认两类来源，其余一律不碰**：① md 首行音频指针 `<!-- bob-audio: … -->` 指到的那批（Live 的录音分片 / 合并件与播客音频 `local:podcast/*.wav` 都挂在这条指针上，通配正好覆盖 `part-*`）；② 指针落空时的同目录兜底 `录音 - <标题> - part-*.webm` 与 `录音 - <标题>.webm`（老产物可能没指针）。
  * **明确排除用户的原始材料**：指针落在 `materials/` 下时（导入录音指向的就是原件）不删 —— 那是资料不是产物。
  * **顺序有讲究**：音频清单必须在删 md **之前**算好（指针就在它的首行）；逐个删除、单个失败不阻断其余（例如已被手工清理过）。响应体新增 `removed` 字段回报实际删掉的文件名。
  * 代价（用户拍板接受）：删任一份产物都会一并回收该场次的录音，同场次另一份产物的 ▶ 回放入口随之消失。
* **播客来源支持行内删除**（`components/butler/MeetingStart.tsx`）：来源列表每行右侧新增删除按钮，点击后**就地替换成确认行**（与 History 删除同款，不弹原生对话框）；确认后走 `DELETE /api/materials?scope=materials&path=…` —— 与文件管理器**同一个接口**，删的是 `materials/` 下的真实文件（连带回收内容索引 / 标签 / 标注 sidecar），不是只把这一行藏起来。删掉的正好是当前选中项时清空选择，避免把已不存在的路径提交给生成。
* **BobMultimodal 的 TTS 音色改为固定枚举下拉**（`lib/core/podcast.ts` / `components/canvas/SettingsModal.tsx` / `lib/core/podcast.test.ts`）：该厂商（Qwen3-TTS CustomVoice）的 `voice` 是服务端固定枚举，**传枚举外的值直接 500**。
  * 音色名单取自本地 MLX 服务 `GET /api/tts/voices`，共九条（`vivian` / `serena` / `uncle_fu` / `ryan` / `aiden` / `ono_anna` / `sohee` / `eric` / `dylan`），首项 `vivian` 与 `TTS_PROVIDER_PRESETS` 的默认音色一致。
  * 设置面板在该厂商下把音色输入框换成下拉限定，**其余厂商仍为自由输入**（未核实的音色不编造）；播客页的音色候选同步列出九条，自动配对为 `vivian` / `serena`。
  * 新增单测覆盖九枚举与自动配对。

## v0.7.663 (2026-10-01)

> 本版是 **v0.7.662 之后的增量**。662 构建于 01:40–01:43 并于 01:43 发布；本批改动全部发生在 **02:24–02:35**（13 个文件，含 4 个新增文件），不在 662 包内。

### 新增

* **飞书（Feishu / Lark）机器人桥 —— 与微信桥同构的第二条外部通道**（新增 `lib/bridge/feishu-adapter.ts` / `lib/bridge/feishu-bridge.ts` / `app/api/feishu/route.ts` / `components/canvas/FeishuBindModal.tsx`，依赖 `@larksuiteoapi/node-sdk`）：
  * **分层与微信桥一致**：`feishu-adapter.ts` 只做协议与凭证（SDK 细节封死在文件内），`feishu-bridge.ts` 只做编排，上层只看得到 `verifyCredentials` / `sendText` / `normalizeInbound` 三个动作。
  * **传输只走官方 SDK 长连接（WebSocket）**：桌面端没有公网地址，Webhook 方案不可用；飞书长连接**仅支持企业自建应用**。凭证落在 `<appRoot>/.feishu-credentials.json`（0600，tmp→rename 原子写），只有 App ID / App Secret 两项，无需扫码。
  * **启动即校验**：App ID 先按 `cli_` + 16 位十六进制预校验（SDK 内部同规则，不匹配会**静默不建连**，故提前拦截给明确提示）；再用一次 `tenant_access_token` 做真实连通性校验，失败原样抛出 code / msg。握手设 15s 超时（SDK 缺省不设，卡住的 DNS / 代理会让连接永久悬挂）。
  * **入站**：`im.message.receive_v1` 事件归一化并过滤（非真人、非私聊直接丢弃）→ 交给**统一会话层** `/api/butler/threads`（线程层 SSOT）→ 回复。出站 `im.message.reply` / `im.message.create`，超长按 4000 字符分段续发。
  * **首版刻意裁剪**（对齐微信桥的能力裁剪）：媒体下载与识别（图片 / 文件 / 语音一律回「暂不支持，请发文字」）、「B5 中途改」打断重跑与 90s 进度提示、`/meeting` 与会议进行中分支。
  * **设置面板新增「Feishu Bot」段**（`SettingsModal.tsx` + `FeishuBindModal`，支持 embedded 模式内嵌右栏）；`GET /api/feishu?action=status` 带**冷恢复**（有凭证但连接未跑时自动拉起），避免前端查到僵尸绑定态。
  * **通道语义打通**：`channel` 联合类型扩为 `'panel' | 'wechat' | 'feishu'`（`api/butler/threads/route.ts` / `lib/butler/entry.ts` / `lib/chat/tool-pipeline.ts` / `api/chat/route.ts`）；`lib/runtime/tools.ts` 抽出 `isBridgeWriteAllowed()`，微信与飞书**共用同一写类白名单**，其余聚合通道（`panel`）维持只读。
  * **日程提醒并行直推两条通道**（`lib/core/event-reminder.ts`）：原 `pushReminderToWechat` 改为 `pushReminderToBridges`，用 `Promise.allSettled` 保证任一通道失败既不影响另一通道、也不影响桌面队列原链路。
  * **随包依赖**：`package.json` 增加 `@larksuiteoapi/node-sdk@^1.74.0`。

### 修复与优化

* **Butler 托盘支持挂载本地文件夹**（`components/butler/ButlerDrawer.tsx`）：回形针右侧新增「本地文件夹」按钮，走 `desktop.selectDirectory()` 选择目录。
  * **不上传、不复制**：只带绝对路径引用（一个目录可能有成千上万个文件，复制进 Butler 存储空间既不划算、也会在用户不知情时吃掉磁盘）；选中后调 `/api/local-files?action=add_root` 登记一次，复用画布 `LocalFileExplorer` 的**同一端点、同一份 browseRoots**，避免「Butler 侧选了目录、画布侧却不认」。端点幂等，重复选同一目录不叠加。
  * **附件提示区分目录与文件**：目录类附件只有路径没有正文，`read_attachment` 直读会 `EISDIR`，故提示改为「标 Folder 的是目录，先用 `list_directory` 看内容，再对具体文件 `read_file`，不要对目录路径调 `read_attachment`」；混发（文件 + 目录）时只出目录版提示（它同时覆盖文件的取法）。
  * 附件标签显示「folder」而非体积（目录 `size` 恒 0，写 0 B 会让模型误判为空文件），并给完整路径的悬停提示；浏览器 dev 下无目录选择器时给可见提示，而不是点了没反应。

## v0.7.662 (2026-10-01)

> 本版是 **v0.7.661 之后的增量**。661 构建于 01:08–01:13 并于 01:13 发布；本批改动全部发生在 **01:33–01:34**（`app/butler/page.tsx`、`server.ts`），不在 661 包内。

### 修复与优化

* **远程访问：手机经隧道访问时报 unauthorized —— 服务端内部自调用被自家网关拦下**（`server.ts`）：手机发起对话时，「Next 路由 → 服务端内部再 fetch `/api/chat`」这一步的 `baseUrl` 取 `new URL(request.url).origin`，即**本机的隧道 IP**（如 Tailscale 的 `100.x`）而非 `localhost`；这条自调用的 `remoteAddress` 因此不是 loopback、过不了 `isLoopback`，被自身鉴权网关判成外部请求返回 401 —— 表现为**手机端对话提示 unauthorized，而桌面走 localhost 一切正常**。
  * **修法**：新增 `selfAddresses()` 取本机全部网卡地址（含 Tailscale / 局域网等虚拟网卡，TTL 60s 缓存，兼顾「应用先起、隧道后连」），把「本机自有地址」也视同 loopback 放行（`isSelfRequest`）。其他设备（手机的隧道 IP）不在本机网卡列表里，仍照常鉴权，安全性不受影响。
  * 顺带处理 dual-stack socket 上 IPv4 连接带 `::ffff:` 前缀的情况（`normalizeAddr`）。
* **`/butler` 移动端页视觉重做**（`app/butler/page.tsx`）：从「能用」推到「像原生 App」——
  * **顶栏改磨砂玻璃**（`color-mix` + `backdrop-filter`），保留刘海安全区；会话视图顶栏换成「头像 + 标题 + 状态点（Ready / Replying…）」，列表视图换成品牌标记 + New 胶囊按钮。
  * **图标改为 `lucide-react`**（`Menu` / `Plus` / `Sparkles` / `ArrowUp` / `Loader2`），替掉原先的字符图标（`☰`、`↑`）；发送中显示旋转指示。
  * **列表行重构**：标题与时间同行、预览与未读角标同行，未读角标加大加粗。
  * **空态补齐**：列表与对话各有独立空态（图标 + 标题 + 提示）。
  * **观感微调**：气泡圆角与渐变（用户侧渐变 + 投影）、输入框胶囊化并加聚焦光环、发送键圆形渐变、列表与气泡入场动画（`bwm-in` / `bwm-pop`）。

## v0.7.661 (2026-10-01)

> 本版是 **v0.7.660 之后的增量**。660 构建于 00:44–00:48 并于 00:48 发布；本批改动全部发生在 **01:01–01:08**，不在 660 包内。

### 新增

* **`/butler` 移动端单栏页 —— PWA 的主入口**（新增 `app/butler/page.tsx`）：iPhone「添加到主屏幕」后 `start_url` 指向本路由，而桌面工作台（`/`）是「无限画布 + Butler 默认关闭的抽屉」，在手机上只剩一个空画布。
  * **单栏、全屏、无画布**：把桌面的「联系人列 → 会话」压成「列表视图 ↔ 对话视图」两屏，用汉堡键切换。
  * **不复制生成链路**：数据面复用既有契约（`GET /api/butler/threads` 列表 / 单线程全文、`POST /api/butler/threads` 的 `stream:true` → SSE、`POST /api/butler/threads/session` 新建）；正文复用画布的 `StreamingMarkdown`，结构化提问复用 `QuestionPopup`（docked 模式），排程确认复用 `ButlerConfirmModal` —— **三类挂起帧必须接住**，否则服务端会空等 600s（与 `ButlerDrawer` 同款处理，口径见 `lib/butler/entry.ts`）。
  * 气泡模型是页内专用的极简结构（不复用桌面抽屉那套带删除 / 多选的 `ChatMessage`），并保留「模型只吐思考没吐正文时也给一句交代」的兜底。

### 修复与优化

* **移动端「启动」与「登录成功」都落到 `/butler`**（`app/manifest.ts` / `server.ts`）：`start_url` 由 `/` 改为 `/butler`；远程访问登录成功后由 `window.location.replace('/')` 改为 `'/butler'`。
* **maskable 图标改用专用图**（`app/manifest.ts` + 新增 `public/icon-maskable-512.png`）：此前 maskable 直接复用 `icon-512.png`，而河马造型接近满幅，会被圆形蒙版裁掉鼻子与尾巴；新图留了安全区。
* **`/butler` 不渲染 Butler 悬浮球**（`components/butler/ButlerOrb.tsx`）：页面本身就是 Butler，再挂一个「打开桌面抽屉」的球是多余入口（与 `/browser-chat` 同款处理，两处判定各加一个路由）。
* **应用图标重做**（`app/apple-icon.png` / `public/icon-192.png` / `public/icon-512.png`）：四张图统一替换，体积显著下降（icon-512 374KB → 139KB）。

## v0.7.660 (2026-10-01)

> 本版是 **v0.7.659 之后的增量**。659 的包构建于 00:22–00:30 并于 00:26 发布，只含 659 条目所列改动；本版修掉一个**长期存在的释包管线缺陷**：打包版从不运行自定义 server。

### 修复

* **打包版从不运行自定义 server —— 远程访问鉴权网关与 CalDAV 自定义方法全部失效**（`scripts/package-release.sh` / `src/server.ts` / `electron/main.ts`）：
  * **取证**：v0.7.659 整包搜索 `remote-login` / `requireRemoteToken` 命中 0；包内 `next-standalone/server.js` 仅 **3,299 字节**，是 Next 生成的「原生 standalone wrapper」（只有 `startServer`，`PROPFIND` 命中 0）。而 Electron 启动的正是这个文件（`electron/main.ts` 的 `serverPath`），并非 `src/server.ts` 编译出的那份。安装版 0.7.658 同一情形 —— 这是长期存在的缺陷，不是 659 引入的。
  * **根因**：`package-release.sh` 全文只有一处 tsup，只编译 Electron 主进程；`src/server.ts` 从未被该脚本编译。包里那份 `next-standalone/dist/server.js` 是 **09-28 17:59** 的陈旧产物，且无任何代码引用它（`electron/main.ts` 里 `dist/server.js` 命中 0）。
  * **修复**：打包时用 tsup 编译 `src/server.ts`，产物**覆盖** `next-standalone/server.js`（同时刷新 `next-standalone/dist/server.js`，不再往包里塞陈旧副本）。效果：远程访问 Token / Cookie 网关重新生效，CalDAV 的 `PROPFIND` / `REPORT` / `MKCOL` 等方法恢复可用，后台日历同步 worker 也随之启动。
  * **两处配套**（缺一即坏）：
    * `src/server.ts` 的 `dev` 判定改为 `NODE_ENV !== 'production' && COZE_PROJECT_ENV !== 'PROD'`。打包版由 Electron 以 `NODE_ENV=production` 启动、不设 `COZE_PROJECT_ENV`，只判后者会把打包版误认成 dev —— 那时 Next 会去现场编译已被打包脚本删掉的 `src/`。
    * `src/server.ts` 补 `__NEXT_PRIVATE_STANDALONE_CONFIG` 注入（读 `.next/required-server-files.json` 的 `config`）。打包脚本会删掉 `next.config.ts`，Next 官方 wrapper 靠这个环境变量还原构建期配置，自定义入口必须做同样的事，否则 `images.remotePatterns`、`experimental` 等静默丢失（远端图片优化会直接 400）。
    * `electron/main.ts` 的启动探针接受 `401`：strict 模式下该探针不带 Token，会被自家网关挡下，此时能返回 401 恰恰说明 HTTP 服务已经可用。
  * **实测**（就地跑编译产物 + 隔离 `BOBWORK_HOME`，模拟打包版已删 `next.config.ts` 的布局）：`/` 200 且标题正确、`/manifest.webmanifest` 200、`PROPFIND /api/dav` **200**（原生 wrapper 下是 405）、`_next/image` 远端 URL **200**（证明配置注入生效）。开启 strict + token 后：无凭据 **401**、`Accept: text/html` **302** → `/remote-login`、登录页 200、错误 token 401、正确 token 200 并下发 `bw_remote=…; HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000`、带 Cookie 200、带 Bearer 200、坏 Cookie 401；rotate token 后旧 Cookie 立即失效、关闭开关后无凭据放行。

## v0.7.659 (2026-10-01)

> 本版是 **v0.7.658 之后的增量**。658 的安装包构建于 09-30 22:47 并已于 22:50 发布；下列改动全部发生在 23:03 之后，**不在 658 包内**（658 条目中已随包出货的"会议记录按停顿切句群"，不在此重复计入）。

### 新增

* **远程访问支持浏览器 / PWA 登录（Cookie 会话）**（`server.ts` / `app/manifest.ts` / `app/apple-icon.png` / `app/layout.tsx` / `public/icon-192.png` / `public/icon-512.png`）：此前远程访问只认 `Authorization: Bearer`，而**浏览器发起的导航请求带不了这个头** —— Safari、以及「添加到主屏幕」后的 PWA 一律被挡在 401，偏偏这正是自用最省事的访问方式（不需要 Xcode / $99）。
  * 新增自包含登录页 `GET /remote-login` 与换票接口 `POST /api/remote-access/login`：提交 token 校验通过 → 下发 httpOnly 会话 Cookie。登录端点**必须先于鉴权网关**处理，否则会被自身的 401 拦截、形成无法登录的死循环。
  * Cookie 值 = `HMAC-SHA256(key=token, 'bw-remote-session-v1')`，**不落任何服务端会话表**：rotate token 后派生值随之改变，已下发的 Cookie 自动失效，无需维护黑名单。属性 `HttpOnly; SameSite=Lax; Max-Age=180天`（iOS 独立 Web App 退出进程会清掉会话 Cookie，不给长有效期就得每次打开重登）。
  * 鉴权三道闸：① `Bearer` 头（Expo 壳 / curl / strict 模式下 Electron 网络层注入）→ ② 会话 Cookie → ③ 浏览器文档导航 302 跳登录页，其余仍 401；loopback 豁免与 strict 语义不变。
  * PWA 化：`app/manifest.ts` 输出 `/manifest.webmanifest`（`standalone` / `portrait` / 主题色 `#6a5acd`）+ 192/512 图标（含 `maskable`）；`layout.tsx` 补 iOS `appleWebApp`（独立启动、标题 BobWork）与 `viewport-fit=cover`。

### 修复与优化

* **实时会议字幕每 45 秒卡一次、期间说的话直接丢字**（`components/butler/MeetingConsole.tsx` / `api/stt/stream` / `lib/stt/voice-providers.ts`）：转写通道原先每 `SEGMENT_MS = 45s` 主动 `finish(false)` 换块，而 `finish` 会 `detachWorklet()` + `teardown()`（关掉采集用的 16k AudioContext），之后还要等服务端 `is_eof`、等整段标点、再 `start()` 重建（新建 AudioContext → `/api/stt/stream` → `addModule` → 新 WebSocket）——这段空窗里麦克风音频**没有任何人在采**，是彻底丢字（实测 0.5~1.5s / 45s），字幕草稿同时被清空。现在**整场会议只开一条转写会话**（录音分片仍按 45s 一块，与字幕无关）。
  * 伴生两条兜底（一条会话就是唯一命脉，必须自愈）：`/api/stt/stream` 新增 `action: 'keepalive'`（复用同一实例、只续期空闲回收计时，由实时 provider 每 60s 自发一次，否则常驻引擎会在开录 3 分钟后被空闲回收杀掉）；`voice-providers.ts` 新增 `onSessionLost` + **卡死看门狗**（连续 8s 收不到任何下行即主动断链，实测服务端每帧都会回消息、静音里也有），控制台据此收尾当前轮并自动重开，不再"字幕一直不动到会议结束"。
  * 顺带修掉：`emitSegments` 不再把空段回调给调用方（rule1 可在纯静音上定稿，空段会白白吃掉一个句首时刻锚点并在字幕里落空行）。

* **下线「会议进行中识别说话人」**（删除 `lib/stt/live-diar.ts` / `lib/stt/audio-gate.ts` / `components/butler/usePcmTap.ts` 及各自单测；`api/butler/meeting` 去掉 `diar_window` 动作与 `diarAvailable`；`diarize.ts` 去掉 `diarizeWindow()` / `liveClusteringArgs()` / `livePartition()` / `niceLow()`；`meeting-session.ts` 去掉 `labelMeetingVoiceMessages()`；`settings.ts` 去掉 `liveSpeakers`）。理由：十几秒滚动窗口的聚类天然不稳（同一人的话会被劈成两簇、窗口末尾静音会被算给上一位说话人），且每 4~6 秒就要起一整个分离 CLI（实测 12s 窗口 ≈1s CPU，另有 ffmpeg 与声纹进程），与流式转写抢 CPU 的表现就是"说话人乱跳 + 字幕卡"。
  * **口径**：会议进行中字幕不带说话人，也不再有「Live speaker labels」开关；`[说话人 N]` 一律来自**会后的整段重转**（`retranscribe` → `parseAudio` + `ensureDiarization`，对整段音频只分离一次，编号全局一致）。旧配置里残留的 `liveSpeakers` 字段会被忽略。
  * 一并回退为它配套加的间接层：`formatTimestampedTranscript` 的 `labels` 选项、`speakerLabelText()`、`TranscriptSegment.name` 与名字形式的 `[说话人 张三]` 解析、实时字幕按说话人成段的 `groupCaptionsBySpeaker()` / `joinCaptionText()`。

* **「自动换段落」在实时字幕上实际是「每 20 秒硬切一刀」**（`lib/stt/sherpa.ts`）：原先 `rule1/rule2 = 3.0s` + rule3 默认 20s，正常对话里几乎不会静默满 3 秒，于是段落实际由 rule3 决定——实测 44.9s 真实录音只产出 3 段，切点正好落在 20.3s / 40.5s，全是句子中间的硬切。现在 `rule1 = rule2 = 1.5s`（自然句末 / 轮次停顿）、`rule3 = 10s` 且**要求 0.5s 停顿**才切：同一段录音 → 5~6 段，切点落在小停顿上。

* **公众号检索：文章卡片与检索进度并入「小微」对话**（`lib/bus.ts` / `lib/core/butler-search.ts` / `api/butler/wechat-search/enrich/route.ts` / `components/butler/ButlerDrawer.tsx`）：此前综述经 `recordSearchExchange()` 落库、以真实气泡呈现，而**文章卡片与阶段进度只活在临时面板里**（`WechatResultInline`，关掉即失、刷新更无）——用户看到综述却看不到"检索了哪些文章"，检索过程中也没有任何反馈。
  * **结果态落库**：`ChatMessage` 新增 `cards` 字段（`title / url / account / summary / keypoint`），`recordSearchExchange(query, md, cards)` 把卡片挂在综述那条 assistant 消息上一并落库 → 每篇文章成为会话历史的一部分，刷新后仍在、整卡点击在 Hippo 打开原文。
  * **过程态临时**：`WechatResultInline` → `WechatSearchLive`（只剩"已拆为 N 个检索方向" chips + 阶段文案 + 三态兜底），门控收敛为 `还在跑 / 要验证 / 有兜底说明`，跑完即卸载不留残影；同时删掉前端对内容的镜像状态（`WechatAIState` 的 `picks / articles / digest / points` 已无人读，收敛为 `WechatPhase` + `wechatFailed`）。
  * **两条兜底落库**（原先整轮静默消失）：① 模型不可用（`resolveModelConfig` 返回空）② 精编中途抛错——两种情形都用 `fallbackCards(hits)` 把候选落库，用户至少能看到"检索了哪些文章" + 一句说明。
  * **修 `searchQ` 一词两用**：搜索栏那串字对小微是**检索关键词**而非过滤器，`isSearchContact` 时中栏不再按它过滤消息、联系人列也永不筛掉小微（否则起搜后刚落库的综述与卡片会被滤成 "No matching content"）。起搜改为 `focusSearchThread()`：先加载小微真源消息再切会话，收尾再重载一次；"滚到底部"的依赖补上 `wechatBusy / wechatPlan / wechatNotice / wechatCaptcha`，空态 `h-full` 块加 `!wechatLiveOpen` 门控。
  * `AssistantBubble` 渲染卡片列表；朗读与操作条分开判定，只有卡片没有正文时仍可删除 / 复制（复制退化为标题列表）。

* **系统身份头像调整**（`lib/butler/avatar.ts` / `components/butler/PersonaAvatar.tsx`）：
  * **Bobby 与小微互换**两个条目的形象与底色（一起走，否则绿色卫衣失去呼应）——小微接管原 Bobby 的专用件 `wechat`（微信绿卫衣 + 胸前对话气泡）+ 微信绿底 `hue 149`；Bobby 的底色**保持** `hue 210`（蓝）。
  * **Bobby 补一张专用件 `bell`**（第 12 张美术件，深色短发呆毛 + 蓝制服 + 胸前铃铛/回执母题）：互换后 Bobby 一度借用性格原型 `rigorous`，会与"严谨"人设的普通好友同形，而系统身份的设计目标是"一眼分得开"。`SYSTEM_AVATAR_IDS` 变为 `['wechat', 'bell']`，两张各钉一个身份、均不入名字散列兜底池。同一张钉死表驱动联系人列与中栏工具行，故只需改数据。

* **新增单测**：`lib/butler/avatar.test.ts`（钉死映射 Bobby=bell/210°、小微=wechat/149°、Recorder=kuudere/32°；三者两两可辨、不受人设影响、专用件不被名字散列抽给普通好友）、`lib/core/butler-search.test.ts`（4 例，锁住落库往返契约）。

## v0.7.658 (2026-09-30)

### 修复与优化

* **实时会议：字幕每 45 秒卡一次、期间说的话直接丢字**（`components/butler/MeetingConsole.tsx`）。转写通道原先每 `SEGMENT_MS = 45s` 主动 `finish(false)` 换块，而 `finish` 一进来就 `detachWorklet()` + `teardown()`（关掉采集用的 16k AudioContext），之后还要等服务端 `is_eof`、等整段标点、再重新 `start()`（新建 AudioContext → `/api/stt/stream` → `addModule` → 新 WebSocket）——这段空窗里麦克风音频**没有任何人在采**，是彻底丢字（实测 0.5~1.5s/45s），字幕草稿同时被清空、冒出 Transcribing…。现在**整场会议只开一条会话**：换块原本只为绕开 provider 的单次录音上限（`FINALIZE_MAX_SAMPLES` 10 分钟），而会议模式走 `skipFinalizeRefine` 根本不累积 PCM，该上限不适用；转写会话只在暂停 / 结束时收尾（录音分片仍按 45s 一块，与字幕无关）。
  * 伴生两条兜底（一条会话就是唯一命脉，必须自愈）：`/api/stt/stream` 新增 `action: 'keepalive'`（按需复用同一实例、只续期空闲回收计时），由实时 provider 自己每 60s 发一次——否则常驻引擎会在开录 3 分钟后被空闲回收杀掉（心跳放在 provider 里：它是会话持有者，只有真的走实时链路时才续期）；`voice-providers.ts` 新增 `onSessionLost` + **卡死看门狗**（连续 8s 收不到任何下行即主动断链，实测服务端每帧都会回消息、静音里也有），由控制台收尾当前轮并自动重开一轮，不再「字幕一直不动到会议结束」。
  * 顺带清掉两个小坑：`emitSegments` 链路不再把空段回调给调用方（rule1 可在纯静音上定稿，空段会白白吃掉一个「句首时刻」锚点并在字幕里落空行）。

* **下线「会议进行中识别说话人」**（删除 `lib/stt/live-diar.ts` / `lib/stt/audio-gate.ts` / `components/butler/usePcmTap.ts` 及各自单测；`api/butler/meeting` 去掉 `diar_window` 动作与 `diarAvailable`；`diarize.ts` 去掉 `diarizeWindow()` / `liveClusteringArgs()` / `livePartition()` / `niceLow()`；`meeting-session.ts` 去掉 `labelMeetingVoiceMessages()`；`settings.ts` 去掉 `liveSpeakers`）。理由：十几秒滚动窗口的聚类天然不稳（同一个人的话会被劈成两簇、窗口末尾静音会被算给上一位说话人），而且每 4~6 秒就要起一整个分离 CLI（实测 12s 窗口 ≈1s CPU，另有 ffmpeg 与声纹进程），与流式转写抢 CPU 的表现就是「说话人乱跳 + 字幕卡」。
  * **口径**：会议进行中字幕不带说话人、不再有「Live speaker labels」开关；`[说话人 N]` 一律来自**会后的整段重转**（`retranscribe` → `parseAudio` + `ensureDiarization`，那条链路对**整段**音频只分离一次，编号全局一致）。旧配置里残留的 `liveSpeakers` 字段会被忽略。
  * 一并回退为它配套加的间接层：`formatTimestampedTranscript` 的 `labels` 选项、`speakerLabelText()`、`TranscriptSegment.name` 与名字形式的 `[说话人 张三]` 解析、实时字幕按说话人成段的 `groupCaptionsBySpeaker()` / `joinCaptionText()`。

* **「自动换段落」在实时字幕上实际是「每 20 秒硬切一刀」**（`lib/stt/sherpa.ts`）。原先 `rule1/rule2 = 3.0s` + rule3 默认 20s：正常对话里几乎不会静默满 3 秒，于是段落实际由 rule3 决定——实测 44.9s 真实录音只产出 3 段，切点正好落在 20.3s / 40.5s，全是句子中间的硬切。现在 `rule1 = rule2 = 1.5s`（自然句末 / 轮次停顿）、`rule3 = 10s` 且**要求 0.5s 停顿**才切：同一段录音 → 5~6 段，切点落在小停顿上。

* **会议记录变成「一整坨没有段落、没有时间轴」的正文**（新增 `lib/parse/audio-chunking.ts`；`lib/parse/audio-parser.ts` / `lib/stt/sherpa.ts`）。这是「自动换段落不好用」在**落盘产物**上的根因，比实时字幕那一条更直接：无多说话人标签时整段转写退回**固定 60 秒网格**，而时间戳只在 `segCount > 1` 时才写——于是短于 60 秒的录音只切出一块 → **一个 `[mm:ss]` 都没有**，文稿是一整坨无段落正文，回放也失去「点一句跳到那一刻」（实测用户最近一份 `会议记录 - 会议 09-30 21-35.md`：668 字节，戳行数 0，全文一段）。
  * 现在没有多说话人标签时按**停顿**切「句群」：新增纯函数 `parseSilenceDetect()` / `planChunkCuts()`（ffmpeg silencedetect 找 ≥0.8s 的停顿，切在**停顿中点**——两侧留余量，避免切口落在音节边缘把字吃掉；实测切在 `silence_end` 会出现「这个会议识别功能我。/ 做了好久」，「也」被边界吞掉），单段上限 20s、下限 3s，切点过多则退回原网格。同一段 44.9s 录音：**0 段 → 7 段**，段首时间戳落在句末处。
  * 切碎不会成倍加载模型：`sherpa.ts` 新增 `sherpaTranscribeMany()`（**一次 CLI 调用转多个文件**，实测 SenseVoice small：1 个文件 1.68s、3 个文件 1.77s——每多一个文件只多 ~0.03s 推理），按 32 个一批分批；输出行数与入参不符直接抛错（`parseSherpaStdoutLines` 的配对守卫），调用方退回逐段转写。云端 STT 仍走固定网格（按段计费/计延迟，切碎不划算）。
  * 切块口径进了缓存键（`CHUNK_VERSION`）：否则老录音会一直命中旧缓存，用户看不到任何变化。

* **新增单测**：`lib/parse/audio-chunking.test.ts`（10 例）、`lib/stt/sherpa-parse.test.ts`（4 例）。`pnpm test` **755 例全绿**，`tsc -p tsconfig.typecheck.json` 通过。

* **公众号检索：文章卡片与检索进度并入「小微」对话**（`lib/bus.ts` / `lib/core/butler-search.ts` / `api/butler/wechat-search/enrich/route.ts` / `components/butler/ButlerDrawer.tsx`）。此前综述经 `recordSearchExchange()` 落库、以真实气泡呈现，而**文章卡片与阶段进度只活在临时面板里**（`WechatResultInline`，关掉即失、刷新更无）——用户看到综述却看不到「检索了哪些文章」，检索过程中也没有任何反馈。
  * **结果态落库**：`ChatMessage` 新增 `cards` 字段（`title / url / account / summary / keypoint`），`recordSearchExchange(query, md, cards)` 把卡片挂在综述那条 assistant 消息上一并落库 → 每篇文章成为会话历史的一部分，刷新后仍在、整卡点击在 Hippo 打开原文。
  * **过程态临时**：`WechatResultInline` → `WechatSearchLive`（只剩「已拆为 N 个检索方向」chips + 阶段文案 + 三态兜底），门控收敛为 `还在跑 / 要验证 / 有兜底说明`，跑完即卸载不留残影；同时删除前端对内容的镜像状态（`WechatAIState` 的 `picks / articles / digest / points` 已无人读，收敛为 `WechatPhase` + `wechatFailed`，`applyEnrichEvent` 只接 `captcha / phase / error / done` 四帧）。
  * **两条兜底落库**（原先整轮静默消失）：① 模型不可用（`resolveModelConfig` 返回空）② 精编中途抛错（`chatText` 在 HTTP 非 2xx 时 `throw`、`chatJson` 不吞）——两种情形都用 `fallbackCards(hits)` 把候选落库，用户至少能看到「检索了哪些文章」+ 一句说明。
  * **修 `searchQ` 一词两用**：搜索栏那串字对小微是**检索关键词**而非过滤器，`isSearchContact` 时中栏不再按它过滤消息、联系人列也永不筛掉小微（否则起搜后刚落库的综述与卡片会被滤成「No matching content」）。
  * **修「过程中无感知」**：过程块挂在会话流末尾，起搜时消息条数不变 → 把 `wechatBusy / wechatPlan / wechatNotice / wechatCaptcha` 计入「滚到底部」的依赖；空态 `h-full` 块加 `!wechatLiveOpen` 门控（此前会把它顶出可视区），小微另写空态文案。起搜改为 `focusSearchThread()`：先加载小微真源消息再切会话（原先只切 ID，中栏残留上一个会话），收尾再重载一次。
  * `AssistantBubble` 渲染卡片列表；朗读与操作条分开判定，只有卡片没有正文时仍可删除 / 复制（复制退化为标题列表）。
  * 新增 `lib/core/butler-search.test.ts`（4 例）锁住落库往返契约。`tsc -p tsconfig.typecheck.json` 通过。

* **系统身份头像调整**（`lib/butler/avatar.ts` / `components/butler/PersonaAvatar.tsx`）：
  * **Bobby 与小微互换**两个条目的形象与底色（一起走，否则绿色卫衣失去呼应）——小微接管原 Bobby 的专用件 `wechat`（微信绿卫衣 + 胸前对话气泡）+ 微信绿底 `hue 149`；Bobby 的底色**保持** `hue 210`（蓝）。
  * **Bobby 补一张专用件 `bell`**（第 12 张美术件，深色短发呆毛 + 蓝制服 + 胸前铃铛/回执母题）：互换后 Bobby 一度借用性格原型 `rigorous`，会与「严谨」人设的普通好友同形，而系统身份的设计目标是「一眼分得开」，故补上；`SYSTEM_AVATAR_IDS` 变为 `['wechat', 'bell']`，两张各钉一个身份、均不入名字散列兜底池。同一张钉死表驱动联系人列与中栏工具行，故只需改数据。
  * 新增 `lib/butler/avatar.test.ts`：钉死映射（Bobby=bell/210°、小微=wechat/149°、Recorder=kuudere/32°）、三者两两可辨、不受人设影响、**专用件不被名字散列抽给普通好友**。

***

## v0.7.657 (2026-09-30)

### 新增

* **Butler 常驻联系人「小微」（搜索与资料整理助手）**：公众号搜索结果不再住右侧浮层，而是作为小微的回复内联在中栏，搜索终于有了归属会话。
  * 新增 `src/lib/core/butler-search.ts`：`ensureSearchThread()` 幂等创建常驻线程（`SEARCH_THREAD_ID = 'butler-search'`，真源在 `lib/butler/storage.ts`）并写入默认人设（`personality: 严谨、干练、信息密度高`）；`buildSearchSummary()` 产出 `pinned: true` + `systemRole: 'search'` 的摘要行（预览取最后一条 assistant 回复，剥 think 后按 `PREVIEW_MAX = 60` 截断）；`recordSearchExchange()` 把一次搜索作为一轮对话落库。
  * `GET /api/butler/threads` 置顶顺序变为 **Bobby → Recorder → 小微 → 普通线程**，并在列表过滤中剥离常驻 id；`DELETE` 拒绝删除常驻身份（400 `resident thread cannot be deleted`）。
  * `lib/butler/storage.ts` 新增 `SEARCH_THREAD_ID` / `SEARCH_TITLE = '小微'`，并把小微的角色目录固定为 `sanitizeRoleName('小微')`，保证其附件 / 产物落点稳定；`lib/butler/avatar.ts` 小微复用 `rigorous` 原型头像、`hue: 210`（蓝），与 Bobby 微信绿、Recorder 琥珀橙区分；`lib/butler/threads-shared.ts` 的 `systemRole` 联合类型新增 `'search'`。
  * `lib/butler/threads.ts` 新增 `appendThreadMessages()`：向已有线程**尾部追加**消息（不覆盖历史），与 `upsertThread` 同锁、同 `trimThreadMessages` 裁剪、同 transcript 落盘口径。
  * `ButlerDrawer.tsx`：起搜即把中栏切到小微；人设弹窗对常驻身份（Bobby / 小微）锁名并隐藏删除入口。

* **公众号检索前 query 规划（问题拆解 / 关键词改写）**：`GET /api/butler/wechat-search` 先让模型把用户输入规划成 1–3 个搜狗微信关键词串，再顺序扇出检索、按 URL 去重合并。
  * 新增 `PLAN_SYSTEM` / `planQueries()`（`temperature 0.2`，`chatJson` 失败重试 1 次）；模型不可用或规划失败 → **降级原句直搜**（与改动前行为一致，零回归）；响应新增 `decomposed` / `intent` / `queries` 字段。
  * 扇出参数：合并上限 `MERGE_CAP = 12`；单条检索 `maxResults = 6`，多条时取 `max(4, ceil(12 / N))`；命中验证码（`captcha`）立即中断，按 `url` 去重。
  * `ButlerDrawer.tsx` 新增 `wechatPlan` 状态，以 chips 明示「已拆为 N 个检索方向（意图）」；新组件 `WechatResultInline` 把综述渲染成对话气泡（头像 + `StreamingMarkdown`），精选 / 候选文章每篇一张卡片、点击在 Hippo 打开原文（卡片右侧 `Hippo ↗`）；loading / 验证码 / 无结果三态各自兜底。
  * `wechat-search/enrich/route.ts` 请求体新增 `intent` / `queries`，`SYNTH_SYSTEM` / `VERIFY_SYSTEM` 提示词加入「检索方向」（综述与要点需覆盖这些方向、校验时一并确认）；digest 完成后调用 `recordSearchExchange()`，把「用户提问 + 综述（要点带来源标题）」写进小微常驻线程。

* **小程序（Sandbox）预览搬到 Hippo Browser 独立页（含桥的自托管中继）**：
  * 新增 `src/lib/sandbox/open-preview.ts`：`openSandboxPreviewInHippo()` → 先确保 Hippo 就绪（`desktop.hippoBrowser.open()`）再 `openUrlInNewTab(origin + '/api/sandbox/preview/<id>')`，避免覆盖当前标签；非桌面 / 异常回退 `window.open`。
  * 新增 IPC `hippo-browser:open-url-new-tab`（`electron/hippo-browser.ts`）：空 URL / 非 http(s)|file / Hippo 未就绪分别返回错误，实际打开复用既有 `openInNewTab()`（首个仍是空标签页时直接覆盖，不新增标签）；`electron/preload.ts` 暴露 `openUrlInNewTab`，`src/lib/desktop-adapter.ts` 加同名透传。
  * `src/lib/sandbox/bridge.ts` 新增自托管模式：顶层页（`window.parent === window`）时 `IS_STANDALONE` 分支直连服务端 —— 普通动作走 `relayRequest` → `POST /api/sandbox/bridge`（人工确认型动作超时 `MANUAL_CONFIRM_TIMEOUT`，其余 30s），流式调用走 `relayChatStream` → `POST /api/sandbox/chat-stream` 并解析 SSE `delta/done/error`；画布对接类 `graph*` 动作在独立页明确拒绝（"当前为独立页面（Hippo），不支持画布对接操作"），人工确认型动作退化为页内 `window.confirm`（服务端权限闸仍生效）。
  * `SandboxPanel.tsx` / `UnifiedPalette.tsx` / `ChatNodeKernel.tsx`：预览入口统一改调 `openSandboxPreviewInHippo`，图标 Play → Globe，按钮文案 Preview → Hippo（title: Open in Hippo Browser）。

* **Word 编辑器：A4 视觉分页**（新增 `docx-pagination.ts`）：A4 @96dpi 白纸 794×1123px、页边距 96px、页间灰隙 24px，换页 spacer 高 `PAGE_SPACER = 2×96 + 24 = 216px`；用 ProseMirror widget 装饰插入不可编辑的 `.docx-page-spacer` + 页码角标 `.docx-page-num`（手动分页符显示「第 N 页 · 分页符」）。
  * 换页是**纯视觉层**（装饰不进文档模型，`getJSON` / `docToBlocks` 不带 spacer，docx 字节保真不受影响）；`measurePagination()` 遍历顶层块 DOM 累加高度，超过单页可用区（1123 − 2×96 = 931px）或该段 `pageBreakBefore === true` 即作为新页首块，经 `requestAnimationFrame` 防抖 + 装载后 80ms / 600ms 两趟复测覆盖图片与字体异步布局。

* **Word 编辑器：查找 / 替换（⌘F）**（新增 `docx-search.ts`）：`DocxSearch` 扩展 + `docxSearch` 插件，命令 `setSearchTerm / findNext / findPrev / replaceCurrent / replaceAll / clearSearch`；支持区分大小写与全词，命中用 inline 装饰高亮（`.docx-search-hit` / 当前命中 `.docx-search-active`），全部替换从后往前执行避免位移；导航类事务打 `DOCX_SEARCH_NAV_META` 标记，**不计入脏块**。首版匹配限定在单个文本节点内（跨 mark 拆分的词不合并），已在源码注释中标注为取舍。

* **Word 编辑器：字符 / 段落格式与 Ribbon 扩充**（`docx-tiptap-extensions.ts` / `docx-schema.ts` / `DocxTiptapEditor.tsx`）：新增命令 `setTextAlign` / `setPageBreak` / `setParaFormat` / `setRunFormat` / `setVertAlign` / `toggleBulletList` / `toggleNumberedList` / `increaseListLevel` / `decreaseListLevel`。
  * 开始页签补齐：剪贴板（复制 / 剪切 / 粘贴）、字体（宋体 / 黑体 / 微软雅黑 / Calibri / Arial / Times New Roman / Cambria / 仿宋 / 楷体 / Consolas）、字号（8–72pt）、字体颜色、样式库（正文 / H1–H3）、左中右两端对齐、项目符号与编号列表（列表缩进 ±1，`ilvl` 上限 8）、左缩进 / 首行缩进 / 段前 / 段后（界面单位 pt，落库 twips ×20）、行距（1 / 1.15 / 1.5 / 2 / 2.5 / 3 倍）、上标 x² / 下标 x₂、清除格式、分页符。
  * 新增「引用 / 审阅 / 视图」三个 Ribbon 页签（目录 / 脚注 / 题注 / 交叉引用 / 批注 / 导航窗格为 disabled 的「即将支持」占位；视图页签内含缩放与页眉页脚入口）。
  * 段落级 `pageBreakBefore / spaceBefore / spaceAfter / indentLeft / indentFirstLine / lineSpacing` 与 `align` 全部进入 ProseMirror schema 与双向适配器；`runFormat` mark 新增 `vertAlign`（DOM `data-va`，渲染 `vertical-align: super/sub`）。

### 修复与优化

* **段落对齐（w:jc）此前既不回显也不落盘**：双向适配器把对齐写在 `Block` 顶层的 `block.align`，而引擎只认 `Block.format.align`（`parse.ts` 从 `w:jc` 写入、`generate.ts` 读取并生成 `w:jc`），顶层字段无人消费 —— 后果是文档原有对齐在编辑区看不出来、在编辑器里设的对齐保存后丢失。现在读写统一经 `format`：`blocks-to-tiptap` 读 `fmt.align`，`tiptap-to-blocks` 经 `mergeFmt('align', …)` 回写，原有对齐可回显、编辑器改动可落盘。
* **`setParaFormat` 命令声明类型补齐 `pageBreakBefore`**：运行时实现本就把 attrs 展开进节点属性（扩展的 `addAttributes` 已声明该字段），但 `docxParagraph` / `docxHeading` 的命令签名漏列该字段，导致「清除格式」传 `pageBreakBefore: null` 时构建期类型检查报「多余属性」而中断发布。现补齐签名，运行行为不变。
* **字符格式合并设置，避免「设字体清掉字号 / 颜色」**：`setRunFormat` 改为合并式 —— 先把选区（或光标处）已有的 `color / sizeHalfPoints / font / vertAlign` 收进来，再叠加本次传入字段，全为 null 时直接返回 false；此前 `setMark` 走默认值会把同域其它字段一并清空。
* **输入框右侧 70px 死区**：`ButlerDrawer.tsx` 输入框去掉 `pr-[70px]`（改为 `pr-3`）。该内边距是「`pl-8` → `pl-3`」改造漏掉的对称项，导致每行右侧 70px 打不进字（源码注释注明「2026-09-30 修，见 e2e 实测」）。
* **独立页里的小程序请求不再无声失败**：桥在无父窗口时过去只能 `postMessage` 给不存在的宿主，现在直连服务端中继；`graph*` 动作给出明确中文报错而不是挂起。
* **检索链路全程可降级**：模型不可用 / 规划失败 → 原句直搜；桥离线 → 前端静默不显示公众号内容；`VERIFY_SYSTEM` 保留「只依据给定材料、不得编造」约束。
* **列表项按层级缩进**（`docx-nodeviews.tsx`）：`ListItemNodeView` 读 `ilvl` 并以 `marginLeft = ilvl × 1.4em` 呈现，多级列表在编辑区可读。

### 改进

* **常驻会话排序与删除口径统一**：`GET /api/butler/threads` 的 `sessions` 固定为 `[notify, recorder, search, ...threads]`，并在过滤里剥掉这三个常驻 id（否则用户在常驻线程里追问过之后，它们会以普通线程身份再次出现在列表里）；`DELETE` 对三个常驻 id 一律 400。
* **搜索综述与问题对齐**：enrich 的综述 / 校验提示词统一前置 `用户意图：… / 检索方向：…`，让要点覆盖问题的主要侧面而不是复述材料顺序。
* **Butler 模型选型 Auto 下线**：模型下拉移除 Auto 项（`currentModelLabel` 由 `'Auto'` 改为 `'Select model'`）；新增迁移 effect —— 候选池就绪后把空值 / 已失效标签落成具体模型（优先 `settings.chatModel.pool` 的有序首选，池空取下拉首项），即改即存（`persistModelSettings`），切回该联系人仍是同一模型；一个对话模型都没配时保持空串、发送留 `null` 交服务端兜底（与画布对话节点同口径）。
* **Run / 段落格式字节保真**：`tiptap-to-blocks.ts` 回写时以 `orig.format` 为基底叠加编辑器节点属性（`mergeFmt` 逐字段），未触碰字段（如 `shading`）原样保留；`align` 亦纳入该口径。
* **标题字号与版式**（`DocxTiptapEditor.tsx`）：`.ProseMirror h1/h2/h3` 设为 24pt / 19pt / 15pt（Word 风格）；编辑区去掉 `min-height: 60vh` 与白页 `margin: 0 auto`，改由分页容器与左侧竖标尺（`.docx-vruler`）承载版式。

### 界面细节

* Word 编辑器右侧新增缩放控件（40%–200%，步进 10%）与底部**状态栏**：`第 X / Y 页`、`字数 N`（非空白字符数）、上一页 / 下一页 + 页码输入框跳转（`goToPage`，平滑滚动到该页内容偏移）。
* Ribbon 页签由 3 个（开始 / 插入 / 布局）扩到 6 个（+ 引用 / 审阅 / 视图）。
* 查找面板：查找输入框 + 区分大小写 / 全词两个勾选 + ↑↓ + `x/y` 计数 + 替换为 + 替换 / 全部替换 / 关闭；`Esc` 关闭、`Enter` 下一个（`Shift+Enter` 上一个）。
* 小程序相关文案与图标全面改口：Sandbox 面板按钮 `Preview`(Play) → `Hippo`(Globe)，`title` 改为 `Open in Hippo Browser`。
* Butler 抽屉输入框底部按钮带重排：思考档位 + 模型移到**右侧**紧邻麦克风（`right-16`，弹层右对齐向左展开），回形针独占左下角；**录音 / 转写期间整簇隐藏**，把槽位让给录音条。
* 小微头像为蓝色（`rigorous` 原型、`hue: 210`），与 Bobby 微信绿、Recorder 琥珀橙区分。

***

## v0.7.656 (2026-09-30)

### 修复与优化

* **docx 保存时 body 尾部重复追加 `w:sectPr`（每存一次多一个）**：`parseDocx` 把 body 末尾的 `<w:sectPr>` 输出为 `hidden: true` 的 passthrough 块，但适配器 A（`blocksToDoc`）忽略了该标记，把它也建成编辑器节点；适配器 B 回灌时又丢掉了 `hidden`，于是 `saveDocx` 的「跳过 hidden 块」约束失效 —— 该 `sectPr` 被当正文写进 body，同时引擎又自行追加了一份尾部 `sectPr`。
  * 现在 `blocksToDoc` 跳过 `hidden` 块、不为其建节点，尾部 `sectPr` 完全交由 `saveDocx` 追加。
  * 附带：编辑器里不再出现多余的 "Section properties" 占位条。

### 其他

* `src/lib/docx-engine/VENDOR.md`：记录引擎目录下那份临时 `node_modules/` 已移除（顶层 pnpm 布局已具备完整依赖闭包，裸 import 正常解析），并加醒目警示 —— Turbopack 会优先命中该嵌套树而遮蔽 pnpm 布局，直接导致构建期 `Module not found`（v0.7.654 首次构建即栽在此处）。
* 测试：修正 `passthrough` / `docx-fidelity` / `edit-round-trip` 三个用例，使其与 09-30 的编辑器升级一致（图片改为真实 `docxImage` 节点、`tableMeta` 按结构比较、单可见块文档命中「过半即全量」而合法返回 `null`）。

## v0.7.655 (2026-09-30)

### 修复与优化

* **原生 C 源随包分发（常驻标点服务 + 声纹提取）**：`punct_server.c` 与 `spk_embed.c` 靠 `outputFileTracingIncludes` 追踪，落点却在 `next-standalone/src/` 树下 —— 而打包收尾会整棵删掉 `src`，源码随之丢失。后果是**安装版静默退化**：常驻标点服务退回「每段 spawn 一次 CLI」（每次重载约 75 MB 模型），声纹提取不可用。
  * 现在由 `package-release.sh` 显式复制两份 C 源到 `next-standalone/scripts/`（与 `ooxml-revise.py`、`pdf_extractor.py` 等同款落法）。
  * 运行时查找顺序改为 `cwd/scripts/*.c` → `cwd/src/lib/stt/native/*.c` → `__dirname/native/*.c`，同时覆盖 **打包版 / 开发 / 就地跑 `.next/standalone`** 三种场景。
  * `next.config.ts` 的追踪配置保留（服务「就地跑 standalone」），注释改为如实说明它不足以支撑打包版。

### 新增

* **Word 编辑器第二轮：Ribbon 工具条 + 表格/图片/列表 + 页眉页脚**：上一版只能改文字，本版补齐结构编辑。
  * 新增 Ribbon 工具条（开始 / 插入 / 布局三段）：插入表格、插入图片、表格增删行列、页眉页脚编辑；编辑区改为白页 + 标尺的所见即所得版式。
  * 新增 NodeView 渲染层（`docx-nodeviews.tsx`）：表格按 `colgroup` 还原列宽与 `colSpan`/`rowSpan`（`vMerge=continue` 的延续单元格按 Word 语义隐藏）、图片按 data URL 显示（缺失时显示占位）、列表项渲染 marker 前缀且正文可编辑。
  * 适配器升级：非文本块由「只读占位」变为**可编辑真实节点** —— 表格整模型存入 `tableMeta`、图片为原子节点、列表项按 `ilvl`/`numId` 计数；回写时单元格内容取编辑器、其余字段（列宽/边框/对齐等）从 `tableMeta` 合并，保持保真。
  * 新增渲染脏块路由器（`render-dirty.ts`）：表格 → 重新生成 XML；已有图片与 passthrough 块 → 原样字节；新插入图片 → `NewImage`（仅 png / jpeg / gif，其它格式明确报错）。

* **Word 编辑器 AI 修订（Track Changes）**：
  * 选区浮层可对选中文本发起 AI 改写，结果以 `w:ins` / `w:del` 修订形式落入文档（Track Changes 开关控制）。
  * 右侧新增修订面板：单条或全部接受 / 拒绝；「接受并写回原稿」复用既有 `save_to_original` 冲突防护。
  * 新增**整文档修订**：取 `/api/docx/audit-revise` 的审计报告 → AI 逐条生成操作 → 依次 apply，顶部显示进度条。
  * 旧 `DocxViewer`（docx-preview 只读渲染）已删除，AI 修订等能力并入编辑器；`isPreviewable('docx')` 变为 false，docx 一律走 `/docx-editor`。

* **会议实时说话人标注（Live speaker labels）**：会议进行中的字幕现在会实时标出说话人，不再只在回放里才有名字。
  * 新增 `usePcmTap`：旁挂一路 16k AudioContext 采样（复用既有 AudioWorklet），滚动保留近 60 秒 PCM 并记录每段墙钟时刻；Pause → 停止采样，Resume → 恢复。
  * 新增 `live-diar.ts`：客户端每 6 秒送最近 12 秒音频到新的 `diar_window` action，服务端跑一次离线分离（复用 `diarizeWindow`），把结果换算成绝对时间回填到尚未贴标签的字幕；跨窗口靠声纹质心 + 本场内存花名册稳定编号，**只读**项目声纹库、不写库。
  * 新增会议设置 **`liveSpeakers`**（默认开启）：仅在 live 视图且本地分离模型就绪时露出该开关。
  * 字幕标签改为「只在换人处标一次」，避免每行重复人名。

### 改进

* **端点判停放宽**：新增 `--rule1-min-trailing-silence=3.0` 与 `--rule2-min-trailing-silence=3.0`（默认 rule2 为 1.2 秒，导致字幕切得过碎；rule1 需同步抬高）。
* **窗口分离新入口**：`diarize.ts` 新增 `diarizeWindow()`，专供实时窗口使用 —— 不走缓存（窗口键零命中且会挤掉 LRU），只做分区还原与同人相邻合并，不做极小簇归并和 60 秒网格兜底；原整段流程不变。
* **说话人回填收口**：`meeting-session.ts` 新增 `labelMeetingVoiceMessages()`，仅给 `type === 'voice'` 且尚无标签的消息写入说话人，并返回写入条数。
* 三处 route 的注释文案随 `DocxViewer` 删除同步更新为 `DocxTiptapEditor`。

***

## v0.7.654 (2026-09-29)

### 新增

* **Word 文档编辑器（DOCX 引擎正式接入运行时）**：上一版引擎已 vendor 入库但只有单测引用、未进安装包；本版真正接进 `/docx-editor`——打开本地 `.docx` 从只读预览升级为**可编辑**，编辑后写回原文件。
  * 新增 docx 模型 ↔ ProseMirror 双向适配器（`blocks-to-tiptap.ts` / `tiptap-to-blocks.ts`）：一条 Run 对应一个 mark 文本节点，段落/标题挂 `docxIndex` 锚点，非文本块以只读占位呈现；回写时按 `docxIndex` 从 `originalBlocks` 回带 `rawPPr`/`format`/`styleId`，未被碰过的格式原样保留。
  * 新增 docx 形 ProseMirror schema 与同名 Tiptap 扩展集（`docx-schema.ts` / `docx-tiptap-extensions.ts`）、编辑内核（`DocxTiptapEditor.tsx`）：`parseDocx → blocksToDoc → 编辑 → docToBlocks → buildSaveBlocks → saveDocx → POST /api/local-files` 全链路。
  * 新增块级脏追踪 `DocDirtyTracker`（`doc-dirty.ts`）：脏集锚定持久身份 `docxIndex`（非顶层下标），再换算回数组下标——插入/删除不会让标记错位。
  * 非文本块（table / image / listItem / passthrough）即使被标脏也强制按 `original` 原样保留（`save-blocks.ts`），避免重新生成导致表格、图片、编号损坏。
  * TIFF 解码由顶部静态 import 改为按需动态 import `utif2`（`tiff.ts`），`decodeTiff` / `tiffToDataUrl` 转 async，功能与保存结果不变。

* **本地说话人身份（声纹库）**：说话人分离从「只有簇号」升级为「跨录音认人」。
  * 新增原生批量声纹 CLI `native/spk_embed.c`：dlopen sherpa-onnx C API 批量提取声纹，首次按 `clang -O2` 编到 `.stt/bin/spk-embed`（按 mtime 幂等），复用已下载的 diarize 3dSpeaker 模型，**无需新模型**。
  * 新增 `speaker-embed.ts`（16k 单声道 wav → 512 维向量、余弦/归一化/质心纯函数）与 `speaker-lib.ts`（项目级声纹库 `<project>/.speakers/lib.json`，余弦阈值 0.5，同名质心按次数加权）。
  * 会议回放字幕段首直接显示人名（按色板着色），播放器下方名单可**改名**并写回声纹库；旧录音无声纹缓存时显示 **Identify speakers** 按钮补跑分离。
  * 声纹是增强项：模型/引擎缺失时静默跳过，不阻断切块转写。

* **Butler 会话级模型选型**：每个会话（线程）可独立指定模型与思考档位（`modelId` / `thinkingLevel`），设置随线程落盘、切换联系人时回填；未指定或指定失效时静默回退自动选型。线程会话接口（`POST`/`PATCH /api/butler/threads/session`）与消息接口同步支持。

* **Customize 脑图首屏**：规则面板新增 `BrainMap` 入口（中枢 + 四分区节点），点击进入对应分区，`← All` 返回。

### 改进

* **会议字幕「一行一句」**：不再按固定 45s 换行——说话人停顿即定稿交稿，收尾只交余量。`SEGMENT_MS` 现在只决定换块、不决定换行；配套新增句首时刻 FIFO、串行落库队列，字幕与最终转写逐句对齐。
* **说话人分离算法调优**：聚类阈值放宽（0.6/0.45 → 0.9/0.8）、`--min-duration-on` 由 0 → 0.3、DIAR_VERSION 1 → 3；新增重叠段按说话人还原为分区（`partitionBySpeaker`）、不足主说话人 5% 的假簇并入相邻簇（`mergeTinyClusters`）、置信度解析与 `compute-confidence`；每簇声纹质心写入分离缓存作为身份层。
* **History 按会议聚合**：由「扁平产物行」改为按 `source:目录:标题` 聚合成会议行，默认折叠、点父行展开，子行按 Minutes / Transcript / Podcast 排序显示本场落了几份；回放入口只挂会议行（优先带音频的 transcript）。仅一份产物的会议不聚合，行为同前。
* **对话模型选型收口**：新增 `isChatModel()`，把 vision / embedding / rerank / audio 类模型排除出对话选型。
* **主窗口宽度自适应**：由固定 1400 改为跟随主显示器工作区宽度。

### 界面细节

* Butler 左栏 Memories 键移除并并入 Customize（换 Brain 图标），Meeting 键 Mic → Video 图标；标题栏「批量多选」入口移除。
* 规则面板四段调整：原 Preferences 段取消（偏好聚合并入 Memories 段），负样本 **Blocked patterns** 迁入 Rules 段。
* 输入框底部新增会话级选型控件：思考档位（月相图标）+ 模型下拉（含 Auto）。

***

## v0.7.653 (2026-09-29)

### 修复与优化

* **一段空碎片不再毁掉整段转写**：说话人分离的边界抖动会切出几十毫秒的空块（实测 34ms = 1166 字节），云端 STT 对这类无内容音频直接返回 HTTP 422（"转写结果为空" / "Cannot compute mel spectrogram of empty audio"），**一块碎片就足以让整段录音的转写全部失败**。两处收口（`lib/parse/audio-parser.ts`）：
  * 新增微碎片下限 `MIN_CHUNK_WAV_BYTES`（0.2s，按 16k 单声道 s16le 折算 6400 字节），低于该值的切片直接丢弃不送 STT；丢弃时保留原下标，说话人标签仍按原下标对齐，时间戳与「N 段拼接」计数改用实际送转写的段数。
  * 422 按「本段无语音」处理并继续转写其余段，不再当作致命错误；全段皆空时仍由既有 `!extracted` 兜底报错，401/403 等鉴权类错误照旧致命。

***

## v0.7.652 (2026-09-29)

### 修复与优化

* **打包链路加固**：构建前 `rm -rf .next` 强制全量编译（消除 Next 增量缓存复用旧 chunk 导致「源码改动未进包」），并新增构建新鲜度守卫——打包前校验编译/组装期间 `src`/`electron`/`public`/`assets` 无源文件改动，有则中止且不产出、不上传。
* **空音频文件明确报错**：音频转写前先拦 0 字节文件（`lib/parse/audio-parser.ts`）。此前空文件会被 ffmpeg 以「Format mp3 detected only with low score / Invalid argument」的原始报错兜出，看不出根因，容易被误判成「格式不支持」；现在直接提示文件为空、需重录或换有效文件。

***

## v0.7.651 (2026-09-29)

### 修复与优化

* 更新打包发布（本版无源码改动，仅重出安装包）

***

## v0.7.650 (2026-09-29)

### 新增

* **本地 TTS 引擎 BobMultimodal（Qwen3-TTS）**：`lib/tts` 接入 BobMultimodal 的 OpenAI 兼容端点（本地 MLX 服务，默认 `http://127.0.0.1:8080/v1`，模型 `Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit`）。该端点有两处与 OpenAI 不同的行为，已分别收口：
  * **恒返 WAV**：`response_format` 被忽略，强制以 `wav` 落盘，避免 WAV 字节被写成 `.mp3` 导致播放失败；
  * **支持 `language` 参数**：按文本含 CJK 汉字与否粗判 Chinese / English（缺省 English 会把中文当英文合成）；`voice` 为固定枚举，预设服务端默认 `vivian`（沿用 `alloy` 会 500）。

### 修复与优化

* **TTS 与 STT 从同一分类中拆开**：`/api/models` 的 audio 正则把「识别」与「合成」混为一类，导致 TTS 模型混进 STT 角色候选池（反之亦然）。新增 `TTS_MODEL_PATTERN` / `isTtsModel()`（覆盖 tts / fishaudio / cosyvoice / melotts / vits / kokoro / zipvoice / f5-tts / index-tts 等），audio 分类按模型名二分；模型池新增 **TTS** 用途标签，TTS 角色候选池改按 `tts` 过滤（原先误用 `stt`）。

***

## v0.7.649 (2026-09-29)

### 新增

* **DOCX 内核（vendor 入库）**：引入完整 Word 文档读写内核 `src/lib/docx-engine/`（45 个模块 / 约 3 万行），取自上游 `genspark-ai/genoffice` 的 `packages/docx-engine`（Apache-2.0，未发布 npm，快照 commit `05b4bd6`）。本地仅两处改动：`parse.ts` 的 `@genoffice/pptx-engine/custgeom` 引用改指 `./vendor/pptx/custgeom`；`vendor/pptx/types.ts` 裁剪为仅保留 `CustomGeometry`，避免经类型位置动态 import 牵入 6 文件 / 3,366 行的 chart 闭包。运行期依赖 `jszip` / `fast-xml-parser`（≥5.3.4）/ `utif2` 已在 package.json 显式声明。
  * 已验证：零改动往返逐字节一致；单块替换时 20 个 zip 条目中 18 项保持字节不变；保存幂等；10 KB 文档 `parseDocx` ≈ 46–60 ms、零改动 `saveDocx` ≈ 2 ms。
* **Word 编辑器页面 `/docx-editor`**：Hippo Browser 打开本地 `file://*.docx` 时，主进程将其重定向到 `http://localhost:<port>/docx-editor?path=<绝对路径>`，与 `/pdf-viewer` 同一契约（零 App 外壳、标签名由服务端 `generateMetadata` 按 `?path=` 写入）。支持渲染、修订四视图、AI 改写与保存写回。
* **远程访问鉴权**：新增 `/api/remote-access` 路由（启用 / 关闭 / 旋转 token / 模式切换）与 `server.ts` 的 `requireRemoteToken()` 网关——默认 `loopback-exempt`（仅回环免鉴权），严格模式或非本地请求强制 `Bearer` 校验；Electron 主进程在严格模式下自动补 token。
* **`console` 场景只读工具**：`list_agents` / `list_projects` / `list_nodes` / `get_app_status` / `read_inbox`。

### 重构

* **Butler 线程化**：会话存储从 `chat_sessions` 表迁移为「一线程一文件」，落 `<APP_ROOT>/butler/.state/threads/<threadId>.json`（新 id 前缀 `b-`，历史 id 原样保留）。新增 `lib/butler/threads.ts` / `threads-shared.ts` / `threads-migrate.ts` 与 4 个 REST 路由（threads / session / messages / search）；启动期自动完成幂等迁移与过期线程清理。
* **Butler 抽屉 IA 重写**：改为微信式四栏（联系人列 / 当前会话 / 详情分区 / Today·规则·日历·会议），数据源切到 `/api/butler/threads`；通知卡「普通消息化」（未读红点、类型图标、待办进度徽标）；消息卡新增复制 / 删除 / 多选 / 朗读等控件。
* **画布文件打开分流**：HTML / PDF / DOCX / 图片不再进入预览面板，直接交由 Hippo Browser 打开；`registry.ts` 注册 `docx/doc` viewer 作为非桌面环境兜底。

### 修复与优化

* 新增 `node-executing` 执行状态广播与发送队列 `pendingSendRef`（流式生成 / 持久化期间新消息入队），避免并发写同一节点文件。
* `HtmlRenderer.tsx` 正文中的项目相对路径引用统一改为发布 `file.open` 事件。

### 界面细节

* 设置面板新增「远程访问鉴权」区块（启用 / 关闭 / 旋转 token、模式选择）。

***

## v0.7.648 (2026-09-28)

### 新增

* **Butler 技能账本（Skills，Phase 3）**：新增 `lib/butler/skills.ts` —— 技能一条一个文件，落 `<APP_ROOT>/butler/.skills/<id>.md`（id 白名单 `sk-<8 位日期>-<hex>`），全局存储，复用规则那套并发与乐观锁；frontmatter 承载 `id / name / description / when / runtime / steps / grants / effects / lifecycle / version / createdAt / updatedAt / revisions`。新增 `skills-shared.ts` 定义类型：`SkillOrigin = ai | user`、`SkillLifecycle = active | quarantine | retired`、`SkillRuntime = compose | script`、适用条件 `SkillWhen`（keywords / scenes / objectTypes / preconditions）、权限声明 `SkillGrants`（fs / net / process 白名单）、失败隔离阈值 `SKILL_FAIL_QUARANTINE = 3` 与 `LIFECYCLE_LABELS` / `ORIGIN_LABELS` / `RUNTIME_LABELS`。当前**只支持 `compose`（受审原语编排）**，`script` 需真沙箱、明确不支持。
* **技能沙箱**：新增 `lib/butler/skill-sandbox.ts` —— `planSkill()` 执行前静态拦截（拒绝 `script`、空步骤、超步骤数、未受审原语、权限不足；**默认最小权限**，fs / net / process 未显式声明即拒绝），`runSkill()` 执行（读技能 → 校验 lifecycle 为 active → 生成步骤计划 → 逐步调用 `executeDeterministicRule` → 记成功 / 失败 / 超时）。
* **Butler 心跳与统一运行时**：新增 `lib/butler/runtime.ts` —— `ButlerTrigger` 新增 `skill-match`（与 timer / speech / scene 共用同一套能力匹配与执行内核），`butlerTick()` 作为唯一门面；新增 `POST /api/butler/tick`：**独立触发端点、不依赖对话**（定时唤醒 Butler），可选 `projectId` / `threadId` 作运行锚点，返回 decision / notice / producedRef，幂等复用 hits 去重。
* **技能 REST 与治理**：新增 `/api/butler/skills` —— `GET` 返回技能列表 + 成败信号（`revision` 与 `runs: { ok, failed, dismissed, consecutiveFailures }`）；`POST` **只承载生命周期治理**（`retire` / `unquarantine`，带 `expected_version` 冲突检测），不提供内容编辑。
* **`skill_draft` 工具（`butler` 场景，本版唯一新增工具）**：AI 起草一条技能（程序化能力），经**可编辑草案卡**审固后落 `.skills/<id>.md`；复用规则草案卡的三段链路（弹卡 → 等确认 → 落盘），`/api/chat` 新增 `BUTLER_SKILL_DRAFT_TOOLS`，卡片可改 Name / What it does / Trigger keywords，未操作则按时超时。
* **常驻标点服务（原生 C，免去每次加载 75MB 模型）**：新增 `lib/stt/native/punct_server.c`（直接调 sherpa-onnx C API，`dlopen` 载入 `libsherpa-onnx-c-api`；模型**只加载一次**、每段推理约 3ms）与 `lib/stt/punct-server.ts`（按需用 `clang -O2` 现场编译到 `.stt/bin/punct-server`，幂等缓存、失败回退；stdin/stdout 单行协议 `READY` / `OK` / `ERR` 并做双向转义；空闲回收 `PUNCT_IDLE_MS`、就绪超时 `PUNCT_READY_TIMEOUT_MS`、单条请求超时 `PUNCT_REQUEST_TIMEOUT_MS`）。`punctuateText()` 优先走常驻服务、失败回退单次 CLI，未就绪 / 空文本 / 失败一律**原样返回**，绝不影响语音输入链路。`next.config.ts` 新增 `outputFileTracingIncludes`，把 `src/lib/stt/native/**/*` 显式带进 standalone——否则打包版会**静默**退化成每段 spawn CLI 的慢路径。
* **常驻进程管理器抽公共层**：新增 `lib/stt/resident-process.ts` —— `createResidentManager` / `ResidentInstance` / `ResidentRequest` / `ResidentStopReason = reaped | replaced | crashed` / `LOG_TAIL_MAX = 40`，把「复用、空闲回收、孤儿清理、失败回收」统一到一处。
* **测试**：新增 `lib/butler/skills.test.ts`（`sk-` id 生成、落盘默认值 `version=1` + `lifecycle=active` + `origin=ai` + `runtime=compose`、非法 id、删除、成功写 hits 与失败写 `skill_failure` 及连续失败计数）与 `lib/butler/skill-sandbox.test.ts`（权限边界默认最小权限、静态拦截 `script` / 空步骤 / 超上限 / 未受审原语、执行前门禁）。

### 重构

* **规则动作枚举接入技能**：`RuleStep.action` 由 `create_todo | create_scheduled_todo` 扩为 `create_todo | create_scheduled_todo | skill`（新增 `actionParams.skillId`）；`rules.ts` 把 `'skill'` 加入确定性动作白名单并从 frontmatter 回填 `skillId`；`rule-exec.ts` 遇 `action === 'skill'` 交给 `runSkill` —— 技能是**规则动作枚举的动态扩展**，不是平行执行路径。
* **裁决调用收敛到 `butlerTick`**：`/api/chat` 改调 `butlerTick`（`speech` 触发），与 `/api/butler/tick`（`timer` 触发）共用同一入口，规则与技能走同一套裁决。
* **`stream-server.ts` 改为复用常驻管理器**：自身只留它特有的三件事——端口分配（`listen(0)` 取号 + spawn 后 TCP 探测确认真在听）、就绪判定（失败时回读 stderr 尾巴给原因）、启动参数；`waitForPort` 支持 `AbortSignal`，子进程已退出 / 报错时**立即**返回，不再干等满超时。
* **会议链路的模型编辑开关一拆二**：`voice-providers.ts` 把原来的 `deferRefine` 拆成 `skipSegmentPunctuation`（每段定稿不做标点，字幕保持引擎原文）与 `skipFinalizeRefine`（收尾不做离线重转定稿，且**不再累积整段 PCM，省最多 38MB 内存**），缺省都开 = 原行为。**会议模式只关后者**：45s 一段时重转只会拖慢分段且无必要，但标点必须留着——字幕要像飞书那样带句读。`useVoiceInput` 的参数随之由 `deferRefine` 改为 `skipFinalizeRefine`。
* **播客配对改为「同模型一男一女优先」**：`podcast.ts` 新增 `modelHasPair` / `preferredPairModel` —— Host A 优先在同模型内成对，Host B 优先同模型内相反性别，取不到才回落跨模型（v0.7.647 是纯跨模型配对）。
* **本地 TTS 模型表调整**：`sherpa-local.ts` 移除 `matcha-zh-baker` 单音色模型，改以 `vits-zh-ll` 作为中文男女双声预置（`gunian` 男 + `fushiyu` 女）；零样本通用参考音的女声来源也从 matcha 改为 `vits-zh-ll` 的 `fushiyu`（新增 `GenericRefSource` 类型，按 `preset` / `clone` 分支合成参考音）。
* **播客音频拼接改为纯 PCM 合并**：`meeting/route.ts` 由 ffmpeg concat 滤镜转码 `.m4a` 改为**直接解析 WAV 头 + 按 PCM 字节追加**（新增 `parseWav` 与格式一致性校验），输出 `.wav`，不再依赖 ffmpeg 编解码。

### 界面细节

* **规则面板扩为四段总览页**：`ButlerRulesPanel.tsx` 由三段（rules / signals / preferences）扩为四段，新增 **Skills** 分区 —— 技能列表（适用条件 / 版本 / 来源 / 成败 / 生命周期）+ 详情（步骤 / 副作用 / 修订历史）+ 治理动作（Retire 停用 / Unquarantine 解封），数据源 `/api/butler/skills`；新增 `describeWhen()` / `describeEffects()` 把适用条件与副作用转成一行可读英文。
* **搜索栏 AI 摘要卡升级**：`ButlerDrawer.tsx` 的综合综述由「`· ` 前缀散列要点」改为 **AI Summary 卡**（白底 + 左侧 3px 主色边条 + `Sparkles` 图标 + AI 标签，与下方来源行拉开层级），校验通过时右侧显示 `Grounded` 勾选徽标。

## v0.7.647 (2026-09-28)

### 新增

* **播客双主播跨模型配对（本地离线）**：本地 TTS 引擎新增音色性别标注 —— `sherpa-local.ts` 新增 `LocalVoiceGender = 'male' | 'female'`（可标在模型级或音色级，音色级缺省回落模型级）、`LocalPresetVoice`（`id` 单音色模型 = 模型 id、多音色模型 = `<模型 id>:<音色 id>`，含 `label` / `modelId` / `voiceId?` / `gender?`）与 `listPodcastVoices`（只列**已就绪**的本地预置音色、可跨模型；未下载完成的列不出来「配了也合成不出」，零样本模型走参考音那一支故不参与）。`podcast.ts` 据此把本地预置从「同一模型内找两条音色」改为**跨模型配对**、默认一男一女：Host A 取「UI 指定 > 用户已选 > 首选女声 > 首条」，Host B 取另一性别，`presetSettings` 把候选落成该主播的合成设置（只换 `localModel` / `localVoice`，其余字段原样透传）。
* **两种兜底文案显式引导**：只就绪一个预置模型（跨模型也凑不出第二条）→ `NOTE_SINGLE_PRESET_LOCAL`：两位主播同音，并指名去 `Settings → Roles → Audio TTS Model` 再下一个（如 VITS zh-ll）；一个就绪模型都没有 → `NOTE_NO_LOCAL_MODEL`。两种情况**照常出产物**，只附一句说明，不静默降级。

### 修复与优化

* **修「跨模型播客音频变快变尖、时长缩水」**：拼接由 **concat demuxer 改为 concat 滤镜**。demuxer 要求各段同参，而两位主播可能来自**不同模型**（matcha 22.05kHz / vits-zh-ll 16kHz / ZipVoice 24kHz），混拼会把 16kHz 段按第一段的 22.05kHz 播放 —— 实测 23.4s 素材只剩 18.2s，且变快变尖，附带 `Non-monotonous DTS` 警告。滤镜按各输入的**真实采样率**解码，再统一 `-ar 24000 -ac 1` 重编码为 **AAC**（`libmp3lame` 未必编进各平台 ffmpeg，AAC 是内置编码器最稳），产物由 `.mp3` 改为 `.m4a`。
* **测试**：`podcast.test.ts` 新增「本地引擎跨模型预置配对」用例 —— 锁定两条自动音色互不相同、且 `hostA` / `hostB` 的 `localModel:localVoice` 键不同（通常即跨模型），并验证显式 override 能精确落到指定模型与音色。

### 界面细节

* **播客形式说明改短**：`Q&A` → "One asks, one explains"、`Relay` → "Both carry the story forward"、`Debate` → "Opposing sides, no invented facts"、`Chat` → "Casual, faithful to the source"（原为整句解释）。
* **会议三入口副标题精简**：Live / Podcast / Transcribe 分别改为 "Records the microphone; saves notes and audio below." / "Markdown or text file → two-host podcast." / "Audio file → meeting minutes."；空态改为 "No audio — upload above." / "No documents — upload above."；屏幕录制提示改为 "Captures what this computer plays (macOS 14.2+)."
* **确认弹窗减字**：倒计时从夹在说明句里改为独立一行 `Auto-cancels in N min`（规则卡与冲突卡各一处）；头部整段说明（"AI parsed the following; review or edit before confirming." 与规则卡的长解释）删除；风险标签改为 `⚠ Note:` / `⚠ Tight fit:`；冲突区改为 `⚠ Conflicts (n/total):` 与 `Free slots:`。
* **问询弹窗（QuestionPopup）去掉头部**：删除「AI needs to confirm the following」标题区、图标块与 ` · M:SS left` 倒计时文案，只留选项列表 + 底部边框按钮区（`flex-1` 撑开）。
* **抽屉确认文案精简**：手动确认工具的长句（含 `auto-skipped without execution if no action within N min`）删除，只留 `Params:`；删除会话改为 `“标题” · N messages`（原为整句 will be removed permanently）；语音输入失败去掉后半句解释。
* **「我的定制」文案精简**：头部副标题删除；空态统一为一行 `Nothing yet.` / `No rules yet.` / `Select a rule.` / `None.`；负样本栏改为 `Patterns you said no to. Unblock to re-enable.`（原为整句），两栏标题改为 `No longer ask` / `Not a habit`；信号行改为 `Dismissed N% of last M hits` / `Needs M hits`。

## v0.7.646 (2026-09-28)

### 新增

* **规则从「只存」到「能跑」**：新增 `lib/butler/rule-exec.ts` —— `executeDeterministicRule` 执行确定性规则，支持 `create_todo`（Phase 1 便签待办）与 `create_scheduled_todo`（Phase 2 日历日程待办，带精确时刻）两类动作；`adjudicateAndExecute` 是调度枢纽（加载 active 规则 → 生成候选 → 裁决 → 执行 → 落结果），`attributeOutputEdited` 把用户后来的修改归因回规则。执行器负责项目落点解析、日程时刻计算、日历冲突降级、`producedRef` 回执。调用点在 `/api/chat` 请求链路内（不是后台常驻循环）。
* **定时触发**：新增 `lib/butler/rule-timer.ts` —— `dueTimerRules` 按 `trigger.time` 算出到期候选，回看窗口 `TIMER_LOOKBACK_MS = 24h`；用 hits 日志里的 `occurrence`（实例时刻 ms）做幂等去重，避免同一实例重复执行或补跑历史实例。
* **三通道触发裁决**：`rule-decision.ts` —— 硬命中 / 软命中 / 定时三条路径决定规则进入执行、询问还是静默；软通道相似度门限 `SOFT_SIMILARITY_THRESHOLD = 0.4`（刻意**放宽**：「多问」已被限流封顶成常数，而「漏问」的代价是永久静默，宁可多产候选）。
* **弱触发与「提议固化」（near-miss）**：新增 `lib/butler/rule-nearmiss.ts`，三层互相独立 —— ① 弱触发信号（`WEAK_SIGNALS` 同域动词，如 待办/提醒我/安排/日程/记一下/会议/新建项目）产生候选；② 限流 `NEAR_MISS_ASK_LIMIT = 2`（同一模式累计询问上限，「问过即计数」，与「被否」是两个计数）；③ 拉黑（两类负样本各按 `(objectType, class)` 独立读判据，互不误伤）。模式键**只由对象类型构成**——对象类型是有限枚举、措辞是无限集，弱触发词只作信号、不进键。重复行为阈值 `NEAR_MISS_BEHAVIOR_N = 3` 触发固化提议。状态落既有 `.state/`（`rule-behavior.json` / `rule-nearmiss.json`），不新建存储根。
* **负样本两栏与解封**：新增 `/api/butler/rules/negative-samples` —— `GET ?object_type=&class=` 返回 `{ samples, blocked, grouped }`，`DELETE ?object_type=&pattern=&class=` 解封（追加一条 `action='unblocked'`，**不删历史**，读侧 latest-wins 立即恢复候选）。两类负样本共用展示通道但不共用：`signal_mismatch`（「我把信号理解错了」→ 不该走某条已有规则，压制 near-miss 询问）与 `not_a_habit`（「这次的行为不是习惯」→ 不该固化成新规则，压制固化提议）。「我的定制」Preferences 段分「不再问 / 不想固化」两栏，附 "Patterns Butler stopped raising after you said no. Unblock to let them surface again."。扫描分片 `NEGATIVE_OBJECT_TYPES = todo / schedule / note / meeting / project / rule`（含 Phase 1 遗留 `rule` 分片只读兼容，不迁移）。
* **规则创建改为「拟稿 → 确认」**：`/api/chat` 新增 `BUTLER_RULE_DRAFT_TOOLS`（限定 `rule_create`）与 `buildRuleDraftCard()`，把工具参数构造成规则草案卡；`ButlerConfirmModal` 新增 `RuleDraftCard` / `ButlerConfirmState`，用户可在「New rule draft / Review or edit before saving…」卡片里改参数再 `Confirm create`，approved 时才用**编辑后**的参数落盘（`ctx.setExecArgs`）。
* **新工具 `rule_resolve_conflict`**（`butler` 场景）：两条规则同时命中且宿主无法裁决（`need_user`）时，记录用户的选择；按**有序规则 id 对**写入 conflict-resolution 信号，使同类输入不再重复询问。
* **Butler 搜索栏 · 微信公众号检索（搜狗微信通道）**：`electron/hippo-browser.ts` 新增 `/wechat-mp` 通道（`search` / `read` 两个动作），在一条**专属后台标签**里完成检索与读正文（`findWechatMpTab` 优先复用/认领，否则新建），**不激活、不 reveal**，既保住反爬 cookie 又不打扰用户当前页面；返回 `engine / captcha / results / text`。服务端新增 `/api/butler/wechat-search`（读 `.runtime/hippo-bridge.json` 定位主进程桥，`POST /wechat-mp { query, maxResults: 6 }`；桥离线即未启动桌面端时返回 `ok:false`，前端静默降级）与 `/api/butler/wechat-search/enrich`（**AI 精选**，SSE 逐阶段推送 `curate → read → summarize → digest → verify`）。
* **AI 精选流水线**：LLM 先从候选（标题/摘要/公众号）里判出最相关的 **3 篇** → 经桥 `read` 串行抽正文 → 逐篇一句摘要 + 一段带来源的综合综述 → 简版 **CoVe 校验**（论断须在正文有支撑，否则剔除或改写）。只在 3 篇上读正文与做摘要，成本可控；模型不可用时前端保留原始列表。抽屉搜索栏新增对应状态机（`WechatAIState.phase`）与文章结构（title / url / account / ok / excerpt / summary / keypoint）。
* **播客可选「形式」与「音色」**：`podcast.ts` 的 `PODCAST_VOICES` 由固定双音色改为可枚举音色表（`listPodcastVoices`），`generatePodcastScript` 新增 `form` 参数，`FORMAT_DYNAMICS` 提供 `qa / relay / debate / chat` 四种双主播互动形式（含 `isPodcastForm` 校验）；`resolveHostVoices` 新增 `overrides`，UI 选定的 Host A / Host B 音色可覆盖自动派生。会议面板新增 Format 选择区（`PODCAST_FORMS` = Q&A / Relay / Debate / Chat）与 Voices 选择区（留空 = Auto，与历史行为一致；可用音色不足两条时整块隐藏）；`podcast_generate` 新增 `form? / voiceA? / voiceB?` 参数，并新增 `podcast_voices` 查询返回 provider / voices / autoA / autoB / note。
* **测试**：新增 `lib/butler/rule-exec.test.ts`、`rule-timer.test.ts`、`rule-nearmiss.test.ts`、`lib/core/podcast.test.ts`，并扩充 `rule-signals.test.ts`、`rule-logs.test.ts`。

### 修复与优化

* **日志与命中口径细分**：`rule-logs.ts` 的日志类型扩为 `hits / output_edited / rule_violated / user_dismissed / conflict-resolution / negative-sample`；`HitEntry` 新增 `occurrence`（定时候选的实例时刻，语面命中不带）与 `producedRef`（产出对象引用，供 `output_edited` 归因）；新增 `NegativeSampleClass` 类型，Phase 1 旧记录无 `class` 字段时读侧按 `signal_mismatch` 兼容。
* **「否决即拉黑」**：用户在裁决时否决某条规则，除记录否决外**立即**额外落一条 `class='signal_mismatch'` 的负样本，使该对象类型的 near-miss 询问不再产生候选——不需要用户再去面板手动拉黑。

## v0.7.645 (2026-09-28)

### 新增

* **Butler 规则集（Rules）**：新增 `lib/butler/rules.ts` + `rules-shared.ts` —— 把用户的「长期承诺」从偏好层独立出来，落盘 `~/BobWork/butler/.rules/<rule_id>.md`（`r-YYYYMMDD-hex` 命名，字段 `id / name / kind / intentRaw / trigger / steps / commitment / scope / scopeTarget / priority / status / version / createdAt / lastHit`）；更新带乐观锁（变更后 `version++`）。本版为 **Phase 0：只存放与可见，不自动执行**。
* **5 枚规则工具**（挂 `butler` 场景）：`read_rules` / `rule_create` / `rule_update` / `rule_pause` / `rule_retire`；REST `/api/butler/rules` 提供 `GET / POST / PATCH / DELETE`，面板与工具读写同源同一份 `.rules/*.md`。
* **否定式表达路由（偏好 vs 承诺的分流）**：`preferences-shared.ts` 新增纯函数 `detectNegation()`，`addPreference` / `updatePreference` 增加第三道闸 —— 判据落在「**能否确定执行 + 是否存在中间态**」而非语气强弱（「回复里不要用感叹号」是硬约束→规则；「我不太喜欢很长的回复」是倾向→偏好），并刻意避开「特别 / 区别 / 识别 / 别人 / 别的」等含「别」的非否定词。命中返回 `routed` 信号，由 `remember_preference` 转成 `createRuleFromNegation()` 落规则集（偏好层不再承载承诺性内容）。
* **规则面板**：新增 `ButlerRulesPanel.tsx`，`ButlerSection` 新增 `'rules'`，新事件 `BUTLER_RULES_EVENT = 'butler:open-rules'`（`ButlerHost` 新增 `onRules` 处理器）。面板副标题 "Standing commitments Butler holds for you · stored, not yet auto-run"。
* **本地离线说话人分离（Speaker diarization）**：新增 `lib/stt/diarize.ts` —— 给整段录音标注「谁在什么时候说」，全局聚类 + 按音频指纹的独立结果缓存，档位 `DiarMode` = `solo / duo / group / auto`；导出 `ensureDiarization` / `buildSpeakerChunks` / `clipChunks` / `parseDiarizationOutput` / `DIAR_VERSION`。切块保证「单块单一说话人且无空隙」，相邻同人合并、换人切块、插入语吸收、快速对话不吞人、超长块切分。
* **STT 面板新增第 4 组 `Speaker diarization`（可选）**：模型状态带 `diarizes` 能力位，文案 "Labels who spoke when in imported recordings — offline, on this Mac."；**仅服务导入录音**，会议设置面板不加新控件。
* **文本转播客（Text to Podcast）**：新增 `lib/core/podcast.ts` —— `generatePodcastScript` 把 md/txt 资料改写成 A/B 双主播对谈脚本（严格 JSON，便于逐句取说话人）、`resolveHostVoices` 把设置里已选的那一款 TTS 拆成两位主播各一份 `TtsSettings` 副本（云端改 voice、本地改 localRefAudio/localRefText，**TTS 引擎零改动、不新增配置项**）、`renderPodcastMarkdown` 产物首行音频指针 + 逐行台词（与会议记录同口径，History 直接出 ▶ 回放）。上限：输入 20,000 字 / 成片 3,000 字 / 单条 200 字 / 150 行。会议产物新增 `podcast` 类型（`MeetingKind` 扩展），文件名前缀「播客」。只有一条可用音色时**照常出产物但回一条 note 显式提示**，不静默降级。

### 重构

* **常驻系统身份命名收口为 Bobby + Recorder**：通知助理显示名定为 **Bobby**（前身 Alfred，中间曾短暂用 Xiao Wei），真源 `NOTIFY_TITLE`；微信桥入站消息自 2026-09-28 起统一落 Bobby 线程（`threadIdHint: NOTIFY_THREAD_ID`），原先独立的「Bobby」/微信桥常驻会话退役，启动时 `purgeRetiredWechatSession()` 幂等清理（`chat-session.ts` 新增 `systemRole?: 'notify' | 'recorder'` 取代「靠 `pinned` 猜」——置顶行不止一条，`find(pinned)` 不再唯一）。Recorder 改为钉在「Bobby」正下方。
* **系统身份头像钉死**：`avatar.ts` 新增 `SYSTEM_AVATAR_IDS = ['wechat']`（第 11 张形象，不入名字散列兜底池），新增 `SYSTEM_IDENTITIES` 按**显示名**钉死形象与底色 —— Bobby 固定微信绿 `#07C160`，否则名字散列会把绿色冲成随机色相；Bobby 允许用户设人设，但头像不随性格变（Recorder 则不可改人设、不可删）。
* **项目归属从「显式收口」改为「显式优先 + 兜底可见」**：新增 `resolveProjectWithFallback` 与 `ProjectSource = 'explicit' | 'current_explicit' | 'current_fallback' | 'global'` —— 用户点名项目按 id/名称解析；没点名则落当前激活项目，但**必须在工具回执里回显 `project_source`**，让「写偏」立刻可见（此前静默写当前项目，模型看不到落点，于是反复「建→撤→建」）。`create_sticky_note` 未传 `project` 不再拒绝。
* **会议结束流程再收口**：结束前先停录并**等待分片落盘**，再发 `action=end`；无论后续是否重转，都**先落一份全文转写**作为回放字幕的时间轴来源，并记录 `recordHandle` 供后台重转复用（`end` 回执新增 `segments`）。
* **会议 API 新增三动作**：`punctuate`（批量给语音段补标点，含段数与长度上限、失败保留原文）、`retranscribe`（配合新增的 `shiftTranscriptStamps` 把切片内的转写时间戳平移回合并音频时间轴，避免回放字幕错位）、`podcast_generate`（materials 的 md/txt → 双人对谈脚本 → 逐句 TTS → ffmpeg 拼接，NDJSON 返回 md/audio，落 `butler/podcast/`）。action 全集现为 19 个。
* **导入录音接入说话人分离**：`import_probe` 触发整段分离并显示 `Analyzing speakers…`，随后串行 `import_segment` / `import_finish`，按说话人切块转写。

### 修复与优化

* **微信日程提醒可直推**：`event-reminder` 产出提醒时并行 `wechatBridge.pushText()`（应用后台运行、手机端也能收到）；微信桥未绑定 / 未运行时静默 no-op，桌面队列照常投递；用动态 import 避免与微信桥形成模块初始化环。
* **修「重启后第一条日程提醒静默丢推」**：`pushText` 收件人由「只看最近一次会话」改为「最近会话 → 退回凭证里绑定的 userId」。
* **修「Bobby 没有未读项却亮着角标」**：通知行回执补上 `persona`，避免 thread_id 为空、既不属于任何联系人又被角标计入。
* **日报正文减负**：`daily-report` 的 `text` 每个分区最多 10 条要点（`TEXT_PREVIEW`），超出补一行 `… (+N more)`；`items` 仍给全量快照（面板可展开、可勾选）；`degraded` 非空时明示告警，避免「查询失败 = 今天很空」被误读。
* **Today 快照限量**：`butler/today` 单段事件列表上限 `EVENT_CAP = 200`，只为兜住极端量级（几千条逾期）撑爆 payload；正常量级 `count === events.length`，面板据此整段摊开。
* **日历单事件查询**：`/api/calendar/events` 新增 `event_id` 参数按 id 取单个事件（通知详情点开日程提醒时读完整信息），未命中返回 404。
* **纪要防幻觉**：会议纪要 prompt 增加说话人标签说明，明确 `[说话人 N]` 是标签而非姓名，避免模型臆造成真实人名。

### 界面细节

* **月相图标观感再调**：暗面由「半透明微弱透出」改为**恒在的整轮不透明深灰蓝球面**（真实月亮的夜面是深暗的，不是透明）；亮面改为暖灰白月壤并明确 limb darkening（亮度随入射角余弦下降，月缘变暗）；档位**不再用配色染色**、只靠相位区分；明暗界线保持锐利不做柔化（月球无大气，投射线即硬边）。
* **Today 页签条吸顶**：面板自身就是滚动区，页签滚出视野后无从判断所在页 —— 用 `tabSticky` 钉在滚动区顶端（横向负边距 + 等量内边距让不透明底色铺满整宽，底色与右栏 / 浮窗面板同为 `--popover`）；Schedule 页每个分区默认 10 条（`SCHEDULE_PREVIEW`），余下折成一行可点的「N more」。
* **Report 页签 markdown 样式**：`globals.css` 新增 `.butler-report .html-renderer` 一套（标题 13/700/ink-strong 对正文 12/400/ink-muted，字号 + 字重 + 颜色三重差异），把裸 markdown 的层级真正做出来；按样式面板 token 给，换主题不用改这里。
* **人设弹窗增强**：`PersonaDialog` 新增 `fixedName`（系统身份名字钉死、不渲染姓名输入框）、`expandAdvanced`（打开即展开「高级」，首次完整人设引导用）、`heading`（覆盖标题栏文案）与 `template` 提交字段。
* **测试**：新增 `lib/butler/rules.test.ts`、`lib/stt/diarize.test.ts`、`lib/core/meeting-session.test.ts`，并扩充 `lib/project/resolve-explicit-project.test.ts`。

## v0.7.644 (2026-09-28)

### 新增

* **Butler 周期日程（recurrence）**：新增 `lib/calendar/recurrence.ts`（`RecurrenceRule` = freq / interval / byday / count / exdate / overrides / tzid / until，导出 `parseRecurrence` / `serializeRecurrence` / `coerceRecurrence` / `recurrenceLabel` / `occurrencesInWindowDetailed`），支持 `daily` / `weekly`；`events` 表新增 `recurrence_json` 列（旧库 `ALTER TABLE` 自动迁移，未迁移库读 `NULL AS recurrence_json` 兜底）；`createEvent` / `updateEvent` 支持 `recurrence`（`null` = 明确取消重复，不传 = 不改）。
* **空闲时段查询**：新增 `lib/calendar/availability.ts`（`mergeIntervals` / `computeFreeSlots` / `findFreeSlots`）——区间合并 + first-fit 找空档 + gap 缓冲 + 工作日时段限定 + 全天占用与跨日顺延。
* **两枚确定性日程工具**（挂 `butler` 场景）：`resolve_datetime`（自然语言时间 → `date` / `time` / `start_time`(UTC ISO) / `weekday` / `all_day_hint` / `topic`，要求在任何建日程工具前**先行**调用，禁止模型心算相对日期）、`query_free_slots`（按 `range_start` / `range_end` / `duration_minutes` 返回 `free[]` 与 `busy[]`，每条 free 自带可直接展示的 label）。
* **相对时刻表达**：`todo-time-parse` 新增「N分钟后」「N小时后」「半小时后」「一个半小时后 / 两个半小时后」（数字支持阿拉伯与中文数字一~十，正确跨午夜）——与既有「N天后」的整天语义刻意区分，服务「提醒我 10 分钟后喝水」这类即时提醒。

### 修复与优化

* **周期提醒按实例展开**：`event-reminder` 扫描时按需展开落在本次窗口内的实例（不物料化事件行、不新建调度器），并支持多个提前提醒时间；`reminder_sent_json` 改为 `<实例开始ms>:<提前分钟>` **复合键**——否则「昨天 9:00 已发 30 分钟提醒」会被误读成「今天 9:00 也发过了」，周期提醒从第二天起静默失效。历史遗留的纯数字偏移读取时按本事件 `start_time` 归一化，行为与改造前一致。
* **错过的提前提醒可补发**：放宽 `now < 实例开始` 限制，应用关闭期间错过的提醒在下次打开且未超过补发窗口时仍会推送；周期实例时长沿用原始 start→end 跨度，被 DETACH 改写的实例取改写后的标题。
* **日历 API 透传重复规则**：`/api/calendar/events` GET 原样回传 `recurrence`（避免前端保存时静默丢失），POST 经 `coerceRecurrence` 归一化后写入。

### 测试

* 新增三份纯计算单测：`calendar/availability.test.ts`（区间合并 / 零长区间丢弃 / first-fit / gap 缓冲 / `notBefore` / 全天占用与跨日顺延）、`calendar/recurrence.test.ts`、`todo-time-parse.test.ts`。

### 界面细节

* **月相档位图标重新对档**：四档照亮比改为与标准月相 emoji 🌒🌓🌔🌕 逐一对应（off=娥眉月 0.25 / low=上弦 0.5 / high=凸月 0.75 / max=满月 1，原为 0 / 0.25 / 0.5 / 1），绘制路径去掉条件包裹、亮面直接出图。

## v0.7.643 (2026-09-27)

### 新增

* **Recorder · 会议记录员常驻联系人**：Butler 联系人列新增第三个系统身份 Recorder，钉在 Xiao Wei 正下方（`RECORDER_THREAD_ID` / `RECORDER_TITLE` 真源在 `lib/butler/storage.ts`）；专属画像 `RECORDER_PROFILE`（`fixedScenes: ['meeting']`），不可改人设、不可删；头像复用 kuudere 形象 + 琥珀橙底色（录制指示灯），与 Alfred 藏蓝、Xiao Wei 微信绿拉开。
* **两枚只读会议工具**：`meeting_search`（无参数 = 最近会议清单；带 `query` = 跨会议正文检索，大小写不敏感子串、多词 AND、返回命中片段；带 `path` = 取某场全文）与 `meeting_summarize`（按用户 `instruction` 原样透传重新出总结，**只回对话、不落库、不写收件箱**）；挂在 `meeting` 场景，管家 / 画布主对话 / 微信桥均拿不到（工具面即能力边界）。
* **会议归档检索与阅读**：`/api/butler/meeting` 新增 `search` / `read` 两个 action——检索前先剥离音频指针与 `[mm:ss]` 时间戳（标记只对回放器有意义，喂模型只会干扰行文）。

### 重构

* **实时会议结束改为两段式**：`action=end` 只结束会话、不再同步跑模型，改为先把全文转写落到会议输出目录并立刻跳转 History；纪要由后台新增的 `action=summarize` 生成后补落，生成期间列表顶部显示 "Generating…"（`MeetingWrapUp` 模块级状态跨控制台卸载传递）。
* **`summarizeMeetingText` 抽取**：从 `finalizeMeetingText` 拆出「只调模型、不落库」的出纪要入口（新增 `instruction` 透传），`finalizeMeetingText` 改调它再落收件箱——实时与导入两路出口口径保持一致。
* **会议面板信息架构重写**：主界面即过往会议列表（History 即家）——可打开产物 / 回放录音 / 行内二次确认删除；**Live meeting** 与 **Transcribe audio** 收为标题栏两枚入口按钮，子流程整块让位并带 Back 返回主界面。
* **Import 支持直接上传录音**：子视图 Upload 走 `POST /api/materials`（与画布输入框附件同一落点 `materials/`），上传完自动选中该条，点一次即转写。

### 修复与优化

* **实时字幕流分两层**：本地流式链路新增「实时草稿行」（`onPartial` 边说边写），定稿（`onText`）时被正式条目替换；云端录制链路不产中间结果，草稿行不出现（同一句不会显示两遍）。
* **支持删除历史产物**：新增 `action=delete`，只删该份 md（路径须落在对应根内且为会议产物），面板行内二次确认 + 删除中禁用重复点击。

### 界面细节

* **月相思考档位图标升级为月面仿真**：球面明暗（以日下点为圆心的径向渐变，亮度向明暗界线衰减）+ 月海/高地暗斑（按亮面 `clipPath` 裁剪，只出现在受照区）+ 恒在暗面（地球反照微透）；渐变与裁剪 id 用 `useId` 派生，避免同页多实例（输入框按钮 + 档位菜单）互相串色。


## v0.7.642 (2026-09-27)

### 新增
- **会议回放（对标妙记）**（新增 `src/components/butler/MeetingReplay.tsx`；改 `src/app/api/butler/meeting/route.ts`、`src/components/butler/MeetingStart.tsx`、`src/components/butler/MeetingConsole.tsx`、`src/lib/core/meeting-session.ts`）：
  - 新增整块回放视图：上方录音播放器 + 下方带 `[mm:ss]` 戳的转写，点一句即跳转、播放时高亮当前段并跟随滚动；由 History 行右侧 ▶ 进入，在会议分区内部切换（Back 返回），不动抽屉结构。
  - 音频降级链：已合并件 → 服务端 `concat_audio` 合并（结果落盘复用）→ 客户端按序拼接分片（提示 seek 可能偏差）→ 无音频则纯转写 + 顶部提示，绝不整屏报错；全程 blob 抓取（项目文件代理不支持 Range / 206）。
  - 新增 `replay_audio`（返回带戳转写 + 音频分片清单 + 已合并件 + `missing`；点的是纪要时服务端自动换成同目录转写作字幕源）与 `concat_audio`（ffmpeg 合并分片为单个 webm 并写回同目录 `录音 - <标题>.webm`；`-c copy` 失败回退 libopus 重编码）。
  - **音频指针约定**：转写 md 首行写不可见的 HTML 注释 `<!-- bob-audio: local|project:<glob> -->`，回放据此定位录音；含 `*` 按分片序号通配（Live），无 `*` 即单文件（Import 录音在 `materials/`，靠指针跨目录定位）。History 条目新增 `hasAudio` 嗅探，决定是否显示播放入口。
  - 转写对齐真实时间轴：`append` 新增 `time`（该段在录音时间轴上的绝对毫秒），`meeting-session` 新增 `formatTimestampedTranscript`，`end` 返回带 `[mm:ss]` 的全文转写。
- **记忆升级为「统一长期记忆」，新增两道写入门禁**（改 `src/lib/core/preferences.ts`、`src/app/api/chat/tools/butler.ts`、`src/lib/runtime/context.ts`、`src/components/butler/ButlerMemoryPanel.tsx`）：
  - 主语收敛为**用户本人**，所有联系人共享同一份记忆；「按联系人不同」改由会话人设承担，不再算记忆维度。
  - 写入口径由「仅显式记住」改为「识别到持久事实 / 偏好即自主写入、无需先问」，但写前须先 `read_preferences` 查同类：矛盾走 `update_preference` 覆盖、同一件事合并，禁止重复追加。
  - 类型收敛为六类固定目录：`身份画像 / 偏好习惯 / 工作上下文 / 事实经历 / 目标计划 / 关系边界`（缺省「通用」）。
  - 新增 `detectSensitive` 敏感信息守卫：凭证 / 证件 / 银行卡 / CVV 等一律拒写（不落盘、并提示模型不复述原文）；新增同类型相似度硬闸 `CONFLICT_SIMILARITY_THRESHOLD(0.5)`——命中返回既有序号 + 相似度，倒逼走更新而非追加。
  - 注入分档：新增 `ALWAYS_INJECTED_TYPES`（身份画像 / 偏好习惯为常驻档，每轮注入正文）与安全阀 `ALWAYS_INJECTED_MAX=20`（常驻档超 20 条整体退化为只给目录，控 token）；其余类型只注入目录、需 `read_preferences` 按需调取。
  - 记忆面板按类型分组（六类固定顺序在前，词表外的存量类型归入 Other 并显示原始 type，空组不显示），组标题标注注入档位（`always in context` / `on demand`），类型控件由文本框改英文下拉（原值不在词表时保留一个原值选项，不静默改写存量）。
  - 新增守卫回归测试 `preferences.guard.test.ts`：守护「敏感拒写且不落盘 / 普通偏好不误判 / 同类型高相似拦截并回执序号内容分数 / 低相似放行 / 跨类型不拦 / 完全重复仍走原 `duplicate` 路径」。

### 重构
- **Butler 工具全面补「写入后回读校验」**（改 `src/app/api/chat/tools/butler.ts`）：`create_scheduled_todo` / `create_sticky_note` / `todo_update` / `todo_delete` 一律在写入后回读落库结果，与预期不符或回读失败即返回 `write_verification_failed`，不再静默通过。
  - `create_scheduled_todo` 新增回传落点来源 `project_source`（`explicit` / `current_explicit` / `current_fallback` / `global`）；未显式传项目而兜底到当前项目时附 `warning`，提示「若写偏请用 `todo_update` 改归属、勿重复创建」。
  - 标题纪律：`title` 只写简短动作摘要，用户原话 / 来源 / 背景放 `description`（`create_sticky_note` 无此字段，需保留原文时改走 `create_scheduled_todo`）。
- **`create_project` 支持建完即切换为当前项目**（改 `src/app/api/chat/tools/butler.ts`、`src/lib/project/project-manager.ts`）：新增 `make_current` / `makeCurrent` 参数，回执新增 `is_current`；当前项目切换条件由「首个项目或无当前项目」扩展为 `makeCurrent || 首个 || 无当前`。
- **项目引用支持基名兜底匹配**（改 `src/lib/project/resolve-explicit-project.ts`）：引用不含日期后缀时，用基名匹配 `createProject` 生成的 `<基名>_YYYYMMDD`；唯一命中 `via='name'`，多命中返回 `project_ambiguous`（附候选、不猜）；给了日期后缀则严格精确匹配（跨日期不配）。原有 `project_required` / `no_current_project` / `project_not_found` 口径不变，仅新增这一层匹配；配套新增 3 例单测。
- **会议视图由「中栏接管」改为「右栏分区」**（改 `src/components/butler/ButlerDrawer.tsx`）：`ButlerSection` 新增 `'meeting'`，中栏**恒为聊天**，会议开始面板与控制台改在右栏渲染；会议激活即自动展开右栏并切到该分区。
  - 右栏改「常驻挂载 + hidden」：新增 `rightMounted`，会议期间收起 / 切分区只隐藏不卸载（卸载即停录）；会议分区宽度 480。控制台新增 `visible` 传参，`onEnded` 只刷新会议状态、不再关面板。
- **Today 面板首屏瘦身**（改 `src/components/butler/ButlerTodayPanel.tsx`）：移除顶部建议卡（含「去处理」按钮）与底部「收件箱」「报告文档」两块，打开即 Report / Schedule / Sticky 三页签；嵌入态连日期头一并去掉（顶部条已写 Today）。移除 `openButlerDoc` / `ReportDoc` 与 `/api/butler/report-doc` 拉取；文案批量英文化。
- **本地 STT 精简候选**（改 `src/lib/stt/sherpa.ts`）：移除 Whisper 候选（编码器 / 解码器 / tokens 与启动参数），本地模型仅剩 SenseVoice-small（批量）+ Streaming Zipformer（实时）+ Punctuation。

### 修复与优化
- **同名联系人目录消歧**（改 `src/lib/butler/storage.ts`）：新增 `shortIdHash`（djb2 → base36）与 `disambiguateRoleDir`，目录名被其他角色占用时追加 threadId 稳定短后缀（4 → 全长），保证「一角色一目录」，避免同名联系人的附件 / 文档 / 记录串在一起；`resolveRole` 的占用检查扩展到新线程首次解析（旧目录不存在才可直接采用新名）。
  - 修的是「只在同 threadId 改名时才做占用检查」的历史 bug；配套新增 `storage.resolve-role.test.ts`（无 threadId → 未分类 / 两个同名角色必须落不同目录 / 重复解析幂等）。
- **会议纪要回执归属修正**（改 `src/lib/core/meeting-finalize.ts`、`src/lib/core/butler-notify.ts`）：纪要 / 转写两条回执各加 `threadId`，落进常驻通知线程；`NOTIFY_KINDS` 由 3 项扩为 `daily-report / calendar / inspect / meeting`，修掉「无未读却亮角标」。
- **Live 落盘拆成两份文件**（改 `src/components/butler/MeetingConsole.tsx`、`src/components/butler/MeetingStart.tsx`）：**总是**写 `会议记录 - <标题>.md`（首行音频指针 + 全文转写，回放字幕的时间轴来源），自动整理开启时**另写** `会议纪要 - <标题>.md`（不含时间戳）；只在真录到分片时才写指针，打开哪份按有无纪要决定。
  - 字幕时间轴锚点修正：`append` 带上本段**采集起点**而不是转写返回时刻，避免每条字幕偏晚一次往返、暂停后续段整段错位；Import 侧改用引擎 60 秒分块的**绝对** `[mm:ss]`（不再叠窗口头）。
- **日程提醒补 `source` 字段**（改 `src/lib/core/event-reminder.ts`、`src/components/butler/ButlerDrawer.tsx`）：收件箱项新增 `source: 'event'`（key = 日历事件 id），勾选完成即可联动 PATCH 事件状态；抽屉侧对 `source === 'event' || kind === 'calendar'` 一律按事件处理，兼容改造前未写 `source` 的存量行。
- **Today 红点轻量探针**（改 `src/app/api/butler/today/route.ts`、`src/lib/core/daily-report.ts`）：新增 `?status=1` 分支，只调新增的 `readProgressDigestDate()` 返回当日摘要日期键，不构建 Today 快照（轮询要便宜）；服务端不存阅读态，由客户端记。

### 界面细节
- **Butler 抽屉全量英文化**（改 `src/components/butler/ButlerDrawer.tsx`）：等待话术三档、消息操作、多选条、工具行 / 输入区 / 右栏的 title 与 aria-label、空态提示、人设弹窗错误、附件系统提示、周几与月名、日期分隔条等全部改英文；右栏分区名与左栏同字对齐（记忆 → Memories、日历 → Calendar），窗口键改为 Close / Zoom。
- **思考档位改月相图标**（改 `src/components/canvas/chatNodeKernelParts.tsx`、`src/components/canvas/ChatNodeKernel.tsx`）：新增纯 SVG `MoonPhaseIcon`（off 新月 / low 娥眉月 / high 与 medium 上弦 / max 满月，含月海斑点与描边，随 currentColor 着色），替换原 Brain 图标 + O/L/H/X 角标，按钮色改用档位配色。
- **左栏 Today 键新增红点**（改 `src/components/butler/ButlerDrawer.tsx`）：`RailItem` 支持描边红点；30 秒轮询 `?status=1` 取当日摘要日期键，并监听窗口 `focus` 与自定义事件 `butler-today-digest-loaded` 即时重查；已读按日期键存 localStorage，真正打开 Today 才熄灭。
- **通知助理已读视图不再显示追问气泡**（改 `src/components/butler/ButlerDrawer.tsx`）：对话正文只在未读视图出现，已读视图仅剩回执卡片（普通联系人不受影响）；在已读视图发消息时自动切回未读，避免新气泡被隐藏像没发出。
- **通知补会议样式**（改 `src/components/butler/ButlerNoticeHost.tsx`）：通知类型映射表新增 `meeting`（Mic 图标、标签 MEETING、primary 色）。


***


## v0.7.641 (2026-09-27)

### 重构
- **日报改由 Today 面板承载，三页签取代通知中心推送**（改 `src/lib/core/daily-report.ts`、`src/app/api/butler/today/route.ts`、`src/app/api/butler/daily-report/route.ts`、`src/lib/butler/today.ts`、`src/lib/butler/report-group.ts`、`src/components/butler/ButlerTodayPanel.tsx`、`src/components/butler/ButlerDrawer.tsx`）：
  - 日报不再由通知助理推送；原 Progress / Morning / Sticky 三份报告改为 Today 面板的 **Report / Schedule / Sticky** 三页签，按需读取。
  - `DailyReportType` 由 `progress | morning | sticky | notes` 收缩为 `progress | notes`：删除 `sendDailyReport()`（晨报）、`sendStickyReport()`、`buildMorningReport()`、`fetchEvents()`、`dayRange()`，以及免打扰顺延闸门 `shouldHoldMorningReport()`——Morning 并入 Schedule 页、Sticky 降为实算段。
  - 新增 `buildScheduleSection()`：直接由 Today 快照派生，不查库、不发通知；计数用快照真实 `count`，溢出补 `… (+N more)`，快照降级时加 `⚠ Partial data unavailable` 告警行。
  - `sendStickyReport` 改造为 `buildStickySection()`：每次请求实算，返回 `{ text, items, totalPending, projectCount }`，不进通知中心、不推微信，结构化项构建失败退纯文本。
  - `sendProgressReport()` → `generateProgressDigest()`：不再写待办、不推微信，改写 `state/digest-YYYY-MM-DD.md` 缓存 + 落报告文档，新增 `readProgressDigest()` 供 Today 读取；昨日无活动仍不写缓存。标记语义由「当日只发一次」变为「当日只生成一次」。
  - 调度器精简：每日 9:00 只补做 `progress + notes` 两项，移除 morning / sticky 到点发送与免打扰按住；`pushPending` 的 kind 统一为 `daily-report`（去掉 sticky 的 `inspect`）。
  - `/api/butler/today` 新增 `reports: { progress, schedule, sticky }`（sticky 构建失败容忍为 null，不拖垮整页）；`lib/butler/today.ts` 新增具名类型 `TodayEvent`，`overdue` 补齐 `end_time` / `all_day` / `priority` 字段并剔除「今天开始」的事件，`count` 改用过滤后真实总数（今天 / 逾期两块与 Schedule 页同源）。
- **Today 面板从只读扩为可勾选待办 + 承载三页签**（改 `src/components/butler/ButlerTodayPanel.tsx`）：新增 Report / Schedule / Sticky 页签条替换原顶层「今天 / 逾期」两块，默认停在 Schedule。
  - 新增 `ItemRow` + `toggleItem`：Schedule 行 PATCH 日历事件（`status: done` / `scheduled`）、Sticky 行 POST `sticky-notes` 的 `toggle_line`；勾选只翻转本地列表、不 PATCH 收件箱。
  - Sticky 段按项目分组展示。
- **抽屉撤出日报归组与三页签**（改 `src/components/butler/ButlerDrawer.tsx`，本轮该文件为纯减法）：移除 `reportGroupKey` / `mates` 归组、右栏日报三页签与 Schedule 结构化渲染、Sticky 按项目分组清单，以及全部 6 个 `butler/report-group` 导入。
  - 中栏每条回执各成一张卡片（标题直出，不再替换为组名、不再显示页签提示）；右栏详情回归「标题 + 正文 + 待办 chip」单一形态。
  - 已读语义与批量删除由「组级联动」改回「单条」：`markRead` 只处理传入的那一条，卡片眼睛按钮与右栏已读药丸改读单条状态。

### 修复与优化
- **历史日报回执一次性清理**（新增 `purgeInboxDailyReports()`；改 `src/lib/core/inbox.ts`、`src/instrumentation.ts`、`src/lib/butler/report-group.ts`）：按日报识别口径（去重键优先、标题兜底）物理删除 Progress / Morning / Sticky 类孤儿日报回执，分批 500 条规避 SQLite 绑定变量上限、幂等（不含 Notes 每日维护）。
  - 启动流程在事件提醒调度之前延迟 3s 调用，有清理则打印条数；失败仅记日志，不影响后续启动项。
- **流式 Zipformer 换 fp32 解码器修复复读**（改 `src/lib/stt/sherpa.ts`）：decoder / joiner 由 int8 改 fp32，消除「今天今天」「公公园」等自回归复读，encoder 保持 int8；文件名与启动参数同步更新，体积约 +10MB。

### 界面细节
- **折叠态侧栏新增 Calendar 入口**（改 `src/components/canvas/CanvasFlow.tsx`）：在品牌 / Settings 按钮之上加入 Calendar 按钮，对齐展开态品牌栏最右侧入口。
- **本地 STT 面板去掉分组标题与说明文字**（改 `src/components/canvas/LocalSttPanel.tsx`）：实时与标点模型不再有分类标题和底部说明，各自单列一行直接渲染（纯展示精简，无新增模型组或开关）。
- **通知与免打扰注释同步**（改 `src/lib/core/quiet-hours.ts`、`src/components/butler/ButlerNoticeHost.tsx`）：标注日报已移交 Today 面板、不再产生待办，report 档位规则保留供会议纪要等复用；轮询①改述为「每日任务回执」，现仅剩 Notes 每日维护。仅注释，通知口径无变更。


***


## v0.7.640 (2026-09-27)

### 新增
- **会议面板新增「导入录音整理成纪要」Import 模式**（改 `src/components/butler/MeetingStart.tsx`、`src/app/api/butler/meeting/route.ts`、`src/components/butler/MeetingConsole.tsx`）：
  - 面板顶部新增 Live / Import 分段切换；Import 从项目 `materials/` 里挑音频（按扩展名筛 mp3 / wav / m4a / webm 等），主行显示文件名（即会议标题）、副行显示所在会话 / 目录。
  - 长音频按 25 分钟窗口**客户端串行**分窗转写（规避引擎 30 分钟上限），逐段调 `import_segment` 并补 `[mm:ss]` 时间戳；面板显示「第几段」进度并提供 Cancel（整场作废、不落产物）。
  - 收尾走 `import_finish`，产物落盘口径与 Live 完全一致（`会议纪要` / `会议记录 - 标题.md`），落盘后直接发 `fileOpen` 打开文件。
  - 配套：录音源设置（Audio source 与系统音频提示）改为只在 Live 模式显示；会议控制台的 `safeName` / `writeOutput` 改为导出，供 Import 复用，保证两条路径落盘口径一致。
- **会议 History 过往产物列表**（改 `src/components/butler/MeetingStart.tsx`、`src/app/api/butler/meeting/route.ts`）：新增默认折叠的 History 区，展开时懒加载。
  - 新增 `action: 'history'`：服务端扫 butler 根 + 当前项目根（深度 4、跳过隐藏 / 内部目录），按 `(会议纪要|会议记录) - *.md` 识别，返回 `source` / `path` / `place` / `time`，新 → 旧取上限 30 条。
  - 点开即打开产物文件（区分 Minutes / Transcript，并显示时间与落点）。
- **设置读写支持浏览器 / IDE 内嵌 webview**（改 `src/lib/settings.ts`；新增 `src/app/api/settings/route.ts`）：`loadSettings` / `saveSettings` 新增 webview 分支——经 `/api/settings` 读写**服务端同一份文件**（引擎选择必须让服务端看到），服务端不可达才降级 localStorage；PUT 被服务端拒绝时抛错，不静默写本地。
  - 新路由 GET 返回解密后设置、PUT 落盘（写盘前统一加密与防覆盖保护）；仅本机（`localhost` / `127.0.0.1` / `::1`）可访问，非本机一律 403，失败如实回报 `{success:false,error}`。
- **离线 TTS 新增开箱即用的内置参考音（通用男 / 女声）**（改 `src/lib/tts/sherpa-local.ts`、`src/components/canvas/LocalTtsPanel.tsx`）：ZipVoice 零样本克隆预置女声与男声各一，用户无需自己录音或上传。
  - 女声由 Matcha 预置模型合成后经 ffmpeg 转码为 24kHz 单声道 PCM wav；男声用 ZipVoice 自带男声参考音**自举**（同模型内部克隆）。
  - 缓存于 `<APP_ROOT>/.tts/refs/builtin/`（与用户上传的 `.tts/refs/*.wav` 隔离），生成幂等 + 单例在途 promise（面板轮询并发去重），单条失败只跳过、下次重试。
  - 选中 zero-shot 但未挑参考音时不再直接报错，自动取内置默认音色，修正「选中了却没声音」的假失败；`listBuiltinRefs` 返回值改为「内置通用男 / 女声在前 + 模型自带样例在后」（导出签名不变）。
  - 新引入 ffmpeg 转码依赖（`resolveFfmpegPath`），ffmpeg 缺失则放弃，不留半个文件。

### 界面细节
- **已读通知区支持批量多选 / 删除**（改 `src/components/butler/ButlerDrawer.tsx`）：工具行新增多选入口（仅归档视图出现），卡片行首出勾选框，底部浮出操作条（全选 / 删除所选 / 退出）。
  - 日报组按**整组**勾选与删除（按卡片 key `daily:日期` 展开成组内全部成员 id）；待办项不摊开，归档区只做清理、不做逐条完成。
  - 与既有对话气泡的多选**并列不复用**（独立状态，避免跨助理串选）；删除条不含「复制所选」；切视图 / 切会话退出多选，多选态下卡片整行点击改为勾选并隐藏已读眼睛按钮。


***


## v0.7.639 (2026-09-27)

### 新增
- **语音链路 provider 化重构 + 「定稿 / 标点」两步收尾**（新增 `src/lib/stt/voice-providers.ts`、`src/app/api/stt/finalize/route.ts`、`src/app/api/stt/punctuate/route.ts`；改 `src/components/ui/voice-input.tsx`、`src/lib/stt/sherpa.ts`）：
  - 两条转写链路整体抽到 `voice-providers.ts`：新增 `SttProvider` / `VoiceRuntime` 抽象与 `createRealtimeProvider()` / `createRecorderProvider()` 工厂，hook 退化为「建共用采集 → 按能力选链路 → 交结果」的编排层；采集源节点改为惰性复用（波形与实时共用同一 source，避免振幅叠加）。
  - 状态机由模式枚举（`idle` / `streaming` / `recorder`）改为 provider 句柄 + 启动相位（新增相位锁防连点重复启动）；收尾契约收敛为 `provider.finish(cancel)`；实时启动失败改走 `abort()` + `onDiscard()`，失败路径会彻底停轨、清计时器与 RAF、关 AudioContext。
  - 实时链路收尾从「一次 WS `Done` / `is_eof` 直接出定稿」演进为「定稿（finalize）+ 标点（punctuate）」两段式；启动探测由 `GET /api/stt/stream` 的 `available` 改为 `createRealtimeProvider().probe()`。
- **STT 模型按「能力」而非「类型」组织，新增标点模型组**（改 `src/lib/stt/sherpa.ts`、`src/lib/settings-server.ts`、`src/components/canvas/LocalSttPanel.tsx`）：
  - `kind: 'offline' | 'streaming'` 被 `capabilities: { batch, realtime, punctuates }` 取代，UI 分组与编排决策改按能力位判断；新增 `isBatchModel` / `isRealtimeModel` 类型守卫（能力字段嵌在 `capabilities` 里 TS 无法自动收窄）；`setSttState` 返回的 models 结构随之变化，`firstReadyLocalSttModel` 改按 `capabilities.batch` 过滤。
  - 新增第三种模型形态 Punctuation 与模型 `punct-ct-transformer-zh-en`（CT-Transformer 中英 int8，75.5MB 模型 + 4.2MB tokens），改用 hf-mirror 等价镜像下载（官方 int8 包本机带宽拉不动）；设置面板新增第三组 `Punctuation (optional)`：仅下载 / 删除、不参与引擎单选、下载即生效，未下载时实时链路照常输出无标点文本。
  - 新增 `punctuateText()`：调 `sherpa-onnx-offline-punctuation`，只取 stdout 末行（stderr 全为日志不可信）；未就绪 / 空文本 / 调用失败一律**原样返回**——标点属可选增强，绝不打断语音输入。
- **流式 WS 服务端生命周期外移到独立模块**（新增 `src/lib/stt/stream-server.ts`；改 `src/lib/stt/sherpa.ts`）：把端口分配与等待、进程终止、孤儿进程回收、进程状态与退出钩子整体迁到 `stream-server`，对外提供 `startStreamServer` / `stopStreamServer`；`startLocalSttStreamServer` 瘦身为「校验 + 组装 `buildStreamingArgs`」，删除 / 卸载模型改调 `stopStreamServer`。
- **「昨日项目进展」升级为独立日报 Progress**（改 `src/lib/core/daily-report.ts`、`src/lib/butler/report-group.ts`、`src/app/api/butler/daily-report/route.ts`、`src/lib/project/daily-digest.ts`、`src/components/butler/ButlerDrawer.tsx`）：
  - 上一版作为晨报正文小节的进展归纳，改为日报组里与 Morning / Sticky 并列的独立一份：新增 `sendProgressReport()`（标记 `progress:YYYY-MM-DD`，**仅 Butler 不推微信**；昨天全项目无活动时不发且占标记防重复，归纳失败留痕并返回 `sent:true`）；晨报回到纯待办清单，删除 Morning 内的进展归纳与正文追加。
  - 日报组由两页签扩为 **Progress → Morning → Sticky** 三页签（`DailyReportType` 增 `'progress'`，去重与标题正则增 `Progress Report — 日期`）；删除 `DAILY_PROGRESS_HEADING` 常量与 `splitDailyProgress()`（进展已是独立报告，不再从正文拆分），`buildDailyProjectDigest` 的 markdown 只输出正文并不再依赖日报归组模块；调度器新增 `safeSend('progress')`（免打扰顺延闸门仍只管 Morning）。

### 修复与优化
- **右栏日报去重标题 + 分区回切修复**（改 `src/components/butler/ButlerDrawer.tsx`）：新增 `isDailyReportMember`——日报组成员（Progress / Sticky 等无 items 者）只渲染正文，不再重复打印 `… Report — 日期` 标题（中栏卡片与右栏头部已呈现）；点回执时新增 `onSectionChange('detail')`，修掉「右栏停在 Today / 记忆 / 日历分区时点开 Daily Report 却仍显示 Today」。


***


## v0.7.638 (2026-09-27)

### 新增
- **日程落地前的时段风险评估**（改 `src/lib/calendar/overlaps.ts`）：新增 `assessEventSlot`，一次调用返回分档结果 + 可直接转述给用户的中文说明 + 替代时段，把「先查一遍再报告」的多轮流程压成一次判定。
  - 三档：`none`（可直接落地）/ `potential`（先确认）/ `hard`（重叠，不许落地）；全天日程不计入 `hard`，只作 `potential` 提示；支持 `excludeEventId`（改期时排除自身）。
  - 三类潜在冲突：紧邻空档不足（`tight_gap`，默认 <15 分钟）、相邻事项异地需通勤（`remote_shift`，两边都有地点、地点不同且间隔 <60 分钟）、与全天日程同日（`all_day`）。
  - 地点比对做容错：去空白标点 / 括号地址后，完全一致、互相包含、或字符二元组 Jaccard ≥0.5 即判同场所（同楼不同房间不算异地），避免别名 / 错字误报。
  - 替代时段仅在有冲突时给出：在默认工作时段内挑 1–2 个真正空着的净空档，按「请求时刻之后最近 → 当日更早 → 后续两天」排序，候选之间互不重叠，过去时刻不作候选。
- **`create_scheduled_todo` 从「多轮仪式」改为「校验后直接落地」**（改 `src/app/api/chat/tools/butler.ts`、`src/lib/agents/profiles.ts`）：
  - 排期纪律整段重写：无冲突直接落地并一句话回报，`potential` / `hard` 先确认，不再强制先调 `query_schedule` 查占位；冲突与时间校验由代码强制，不靠提示词自觉。
  - 时间硬校验：缺 `start_time` → `need_more_info`（附 suggested 默认时段）、不可解析 → `invalid_time`、已过去（5 分钟容差，全天按日期比）→ `past_time`，三者均不落库；落地前调 `assessEventSlot`，仅 `none` 才落，否则返回 `conflict_level` / `conflicts` / `risks` / `alternatives`。
  - 新增 `force` 参数：用户明知风险仍坚持、或补记历史时强制落库（仅放行冲突与已过去时间，缺时间 / 非法时间不放行）；新增 `location` 参数，写入事件并用于相邻异地通勤风险判定。
  - 项目归属口径调整：`create_scheduled_todo` 未提及项目时不再回问，自动落当前激活项目；无激活项目则落全局日历（`scope='global'`），仅「同名多命中 / 未找到」才澄清；全局日历场景只建事件、不追加便签行。（便签与计划树工具仍要求显式 `project`。）
- **全身份注入当前时间锚点**（改 `src/lib/runtime/context.ts`、`src/app/api/chat/route.ts`）：新增 `buildNowInjection`，每轮现算本机「现在几点 / 星期 / 时区偏移」并 prepend 到当前轮 user 消息——相对时间（今天 / 明天 / 下周三）解析必需；走动态通道，不动 system 提示的缓存前缀。
- **排期纪律单一真源 + 动态注入**（改 `src/lib/agents/profiles.ts`、`src/lib/runtime/context.ts`、`src/app/api/chat/route.ts`）：新增导出常量 `BUTLER_SCHEDULE_DISCIPLINE`，被系统提示与新增的 `buildScheduleDisciplineInjection` 两处共用；动态注入绕开已装用户物化的 `agent.json`，使新口径立即生效，并显式声明「与旧提示词冲突以本段为准」。
- **晨报新增「昨日项目进展」**（改 `src/lib/core/daily-report.ts`、`src/lib/butler/report-group.ts`，`src/lib/project/daily-digest.ts` 提供摘要）：Morning 正文在待办清单之后追加一节，归纳各项目昨天的流水。
  - 与待办清单互不影响：该节无活动或归纳失败都只是缺席，绝不影响晨报整体发送；结构化 `items` 不含这一段。
  - 新增常量 `DAILY_PROGRESS_HEADING` 与 `splitDailyProgress()`，生产侧与展示侧共用同一常量，避免文案漂移。

### 界面细节
- **语音流式中间结果改写进输入框**（改 `src/components/ui/voice-input.tsx`、`src/components/butler/ButlerDrawer.tsx`、`src/components/canvas/ChatNodeKernel.tsx`）：是上一版「边说边出字」的交互改版——中间结果由录音条内显示改为**边说边写进输入框**。
  - 新增 `onPartial` / `onDiscard` 回调，移除录音条内的实时文字（只留波形 / 计时 / `Transcribing…`）；抽屉与画布两处输入框加草稿基线，`onPartial` 写「基线 + 中间文本」、`onDiscard` 还原录音前草稿、`onText` 定稿覆盖。
- **中栏对话区加宽**（改 `src/components/butler/ButlerDrawer.tsx`）：`CHAT_MAX_W` 由 420 放宽回 560，余量优先给中栏、右栏先保自身期望宽度，靠抽屉整体加宽而非挤压右栏。
- **右栏日报排版分级**（改 `src/components/butler/ButlerDrawer.tsx`）：详情顶部条显示组名 `Daily Report — 日期` 作加粗深色一级标题、页名（Morning / Sticky）退为类型标签；「昨日项目进展」小节经 `splitDailyProgress` 摘出，在待办清单下方单独渲染，空则整块不出现；今日 / 已逾期分区名升为深色半粗一级、计数退成小徽标。
- **Today 面板排版重排**（改 `src/components/butler/ButlerTodayPanel.tsx`）：按「标题 > 建议卡 > 分区头 > 扁平行」重排层级。
  - 新增 `SectionHead`（分区名深色半粗 + 计数小徽标，逾期用 warn 变体）；行去掉灰底，靠字重与缩进分主次。
  - 嵌入右栏时不再重复「Today」标题、只留一行日期（一级标题交给顶部条），独立浮窗保留完整标题；可点击的报告文档行加 hover 底色，与静态行区分。


***


## v0.7.637 (2026-09-27)

### 新增
- **本地实时流式语音输入（边说边出字）**（新增 `src/app/api/stt/stream/route.ts`；改 `src/lib/stt/sherpa.ts`、`src/components/ui/voice-input.tsx`、`src/components/canvas/{LocalSttPanel.tsx,SettingsModal.tsx}`、`src/lib/settings-server.ts`）：
  - 语音输入新增「实时链路」：AudioWorklet 采 16k 单声道 PCM 直连本地 `ws://127.0.0.1:<port>`（端口由 `/api/stt/stream` 拉起常驻 WS 服务端后分配，音频不经 HTTP 接口），边录边出中间文本；实时链路不可用时自动回退「录完再转写」。
  - `sherpa.ts` 新增 `kind:'streaming'` 模型形态（streaming-zipformer）与常驻 WS 服务端生命周期（按需 spawn、空闲回收、孤儿进程回收）；批量转写入口 `sherpaTranscribe` 拒绝 streaming 模型。
  - 设置面板新增 `kind='streaming'` 的「Real-time voice input」模型组：只提供下载 / 删除、装完即自动启用，不参与 STT 引擎单选；`firstReadyLocalSttModel` 加 `offline` 过滤，避免流式模型被选成批量转写引擎。
- **会话消息可单条删除 / 多选批量操作**（新增 `src/app/api/core/node-chat/messages/route.ts`；改 `src/app/api/core/node-chat/route.ts`、`src/components/butler/ButlerDrawer.tsx`）：气泡 hover 浮出「复制 / 删除 / 多选」三键，多选进入选择模式（气泡左侧勾选框 + 时间线与输入框之间的批量条：全选 / 复制所选 / 删除所选 / 退出）。
  - 删除走 `DELETE /api/core/node-chat/messages`：按 `role + 正文` 认领目标、`index` 仅作提示，删完不动会话 `updated_at`；`GET /api/core/node-chat` 新增与消息同序同长的逐条下标 `indexes[]`，供前端拼气泡 id 与删除认领。
- **好友会话未读与「置为已读」**（改 `src/lib/core/chat-session.ts`、`src/lib/core/butler-wechat.ts`、`src/lib/core/butler-notify.ts`、`src/app/api/core/node-chat/session/route.ts`、`src/components/butler/{ButlerDrawer.tsx,ButlerNoticeHost.tsx}`）：`ChatSession` 新增 `readAt`、摘要新增 `unread`，新建会话即写 `read_at`；新增 `markChatSessionRead` / `countUnreadAssistant` / `countUnreadChatMessages` / `deleteChatMessages`。
  - `PATCH /api/core/node-chat/session` 新增 `{ read: true }` 作为好友未读角标的清零出口（常驻通知助理与小微也允许置已读，但彻底不改人设）；联系人列每行显示未读角标（通知助理行 = 未读回执、其余会话行 = 未读消息数），角标由标题行尾挪到头像右上角。
  - 悬浮球未读数改为 `inbox.unread + chats.unread` 求和；store 变化只当触发信号，400ms 去抖后取服务端全量。
- **每日报告同日归组**（新增 `src/lib/butler/report-group.ts`；改 `src/lib/butler/today.ts`、`src/components/butler/{ButlerDrawer.tsx,butlerNotices.ts}`）：同一天的 Morning 与 Sticky 报告在中栏并成一张卡片（标题 `Daily Report — 日期`），右栏顶部按页签 Morning / Sticky 切换；已读 / 归档与未读角标按**组级**统一（任一未读即整组未读，角标按组折叠计 1）。
- **麦克风启动失败上屏**（改 `src/components/ui/voice-input.tsx`、`src/components/canvas/ChatNodeKernel.tsx`、`src/components/butler/ButlerDrawer.tsx`）：新增 `onStartError` 出口——`getUserMedia` 未启动（无权限 / 无设备 / 被占用 / 非安全上下文）时不再只写 `console.warn`，改为按 `DOMException` 分类给出可照做的说明，并在画布与抽屉弹出「Microphone unavailable」确认层。

### 修复与优化
- **修复存量日历库索引创建顺序**（改 `src/lib/db/index.ts`）：`idx_events_kind_due` 从内联建表串移出，改由 `ensureCalendarTaskColumns` 在 ALTER 补列之后创建，修掉存量库因 `no such column: kind` 中止 `db.exec`、导致日历全线不可用的启动问题。
- **新增会话未读与 TTL 单测**（新增 `src/lib/core/chat-session.test.ts`）：覆盖 `countUnreadAssistant`、以及 `notify` 类长期会话永不过期（`sessionExpiresAt('notify')` 恒 `null`）等断言。

### 界面细节
- **等待行并入助手气泡**（改 `src/components/butler/ButlerDrawer.tsx`）：等待行由时间线末尾的裸文字改为「头像 + 灰底气泡（口语句 + 行尾跳动点）」，与正式回复同款气泡样式；`WAIT_LINES` 三档文案整体重写（句式不重样、只写永远成立的话、不以「…」收尾）。


***


## v0.7.636 (2026-09-27)

### 新增
- **确定性日程排期（Scheduling）**（新增 `src/lib/calendar/scheduler/{solve.ts,index.ts}`、`src/app/api/calendar/schedule/route.ts`；改 `src/lib/db/index.ts`、`src/lib/runtime/tools.ts`、`src/app/api/chat/tools/butler.ts`）：
  - 纯函数求解器 first-fit 贪心排程，同输入必同输出；硬约束为不与忙块重叠、整块落工作时段、due 前完成、不越 horizon、锁定块不参与；软约束用固定排序键（due 近 → 优先级 → 创建早 → id），15min 网格、默认 30min 块、默认工作时段 09:00–18:00 / Asia/Shanghai。
  - IO 层候选 = 未排程任务 + 排程器排过且未锁定、开始时刻仍在未来的块（`scheduled_by='user'` 与 `block_locked` 永不移动、只作忙块）；落库一律 `markStale:false` 防自激，落不下的清回未排程；变更后 `scheduleReplan` 3s 去抖重排。
  - 新接口 `GET/POST /api/calendar/schedule`（返回排程 meta、计数、未排任务；POST 支持 `horizon_days`、`dry_run`）；新工具 `plan_schedule`（可预览、`horizon_days` 默认 14 上限 120，回报已排块与排不上原因）与只读 `query_schedule_status`。
- **事件实体三分 `kind`（event / task / log）**（改 `src/lib/db/index.ts`、`src/app/api/calendar/events/route.ts`）：events 表新增 `kind` 与排程列（`due_at` / `estimated_minutes` / `actual_minutes` / `started_at` / `completed_at` / `schedule_status` / `block_locked` / `scheduled_by`），新建单行 `schedule_meta` 表与 `(kind,due_at)` 索引；项目库与全局日历库各自幂等增量迁移。`GET` 支持 `?kind=`，未指定时默认排除 `kind='log'`。
  - 「变更即重排」集中记账：`create/update/deleteEvent` 默认 `markScheduleStale`，仅把「scheduler 排过且未锁定」的行标 stale，再动态 import 排程器触发去抖重排（动态 import 打断 db ⇄ scheduler 循环依赖）。
  - 「完成时必记」：`status→done` 且首次完成自动补 `completed_at` 与 `actual_minutes`（优先按 `started_at→now`，无则退回执行块时长），日历 UI / Butler 工具 / 便签三条完成路径共用此唯一写入漏斗。
- **估时校准反哺排程（闭环）**（新增 `src/lib/calendar/analytics.ts`）：三条只读统计（按分类 `AVG(actual/estimated)` 估时偏差、按周完成率、按分类时间分配）；产出分类校准乘子（样本 ≥3、clamp 到 [0.5,2]）在排程入口乘到 block 长度（下限 15min 与网格对齐），任务行 `estimated_minutes` 不动，求解器保持纯函数。
- **本地离线神经 TTS（第三档引擎）**（新增 `src/lib/tts/sherpa-local.ts`；改 `src/lib/tts/index.ts`、`src/lib/settings.ts`、`src/app/api/tts/local/route.ts`、`src/components/canvas/{LocalTtsPanel.tsx,SettingsModal.tsx}`）：基于 `sherpa-onnx-offline-tts`，内置 matcha-zh-baker（单音色）与 kokoro-multi-lang（8 中文音色）模型清单；Audio TTS Model 由「云端 vs macOS `say`」二选一扩为**云端池 / macOS `say` / Offline neural 三态互斥单选**，不做自动兜底。
  - 引擎与模型均支持后台下载 + 1.2s 轮询进度条 + 断点续传，已下载模型可就地删除（二次确认释放磁盘），就绪后可就地**试听**（合成样例即时回放）；多音色模型选中后可展开音色下拉。引擎复用 STT 的 shared 包，不重复下载。
  - 保存契约：`tts.provider` 写 `say` / `sherpa-local`，新增 `localModel`，`localVoice` 语义随引擎变化（`say`=音色名、sherpa=sid）；朗读按引擎自适应分段长度（本地神经引擎用 800 字，压低首字延迟）。
- **微信「小微」常驻联系人**（新增 `src/lib/core/butler-wechat.ts`；改 `src/lib/bridge/wechat-bridge.ts`、`src/lib/butler/storage.ts`、`src/lib/core/{node-chat.ts,chat-session.ts,butler-notify.ts}`）：微信消息固定落常驻线程 `butler-wechat`（标题「小微」），弃用旧的「借用桌面活动线程」绑定，跨端续聊且会话永不过期；置顶联系人由 1 个变 2 个（通知助理 + 小微），两者都不可删除、无人设入口（后端同样拒绝删 / 改人设），未读红角标仍只挂通知助理；列表改用 `systemRole` 身份标记区分（不再靠 `pinned` 猜）。
- **Butler 可直接新建项目**（改 `src/lib/agents/profiles.ts`、`src/lib/runtime/tools.ts`、`src/app/api/chat/tools/butler.ts`）：提示词把「应用结构 / 新建项目」纳入自有范围；新增 `create_project` 工具（缺名先问、直接创建不切换当前项目、广播刷新侧边栏），加入写类白名单与微信放行名单，工具有独立工具行摘要「新建项目：X」。
- **项目归属显式收口**（新增 `src/lib/project/resolve-explicit-project.ts` + 测试）：把用户口中的项目引用解析为真实项目并硬校验——空引用返回 `project_required`、哨兵仅限用户明确说「当前项目」、只匹配活跃项目，同名多命中 / 未命中返回候选供回问，杜绝静默写入当前项目。`create_scheduled_todo` / `create_sticky_note` 与 4 个计划树工具一律要求显式 `project`，不再回落当前活跃项目。
- **iCal / CalDAV 支持 VTODO**（改 `src/lib/calendar/{ical.ts,dav-server.ts,sync-runner.ts}`、`src/app/api/calendar/{ics,ics/feed}/route.ts`）：`parseIcs` 同时切分 VEVENT / VTODO 并输出 `component`，新增 `due_at`（DUE），VTODO 允许无 DTSTART（`start_time=null`），完成判定扩展（`COMPLETED` / `PERCENT-COMPLETE≥100` / `X-BOB-STATUS=DONE`），修 TZID 从整段取值的旧缺陷；`supported-calendar-component-set` 增加 `VTODO`，PUT 时 VTODO→`kind='task'`、VEVENT→`kind='event'`；同步拉取时外部 VTODO 只升不降地提升为 task 并写 `due_at`，推送仅回写同步绑定字段（`markStale:false`）、不再改动本地计划。ICS 导出与订阅两处均过滤 `kind='log'`，记录集不对外投影。
- **下载逻辑抽公共模块 + 多镜像轮换**（新增 `src/lib/net/download.ts`；改 `src/lib/stt/sherpa.ts`）：把 STT 原有的 curl 断点续传 / 重试 / tar.bz2 解压抽到 `net/download.ts` 并新增多 URL 镜像链轮换；STT 侧改为引用，并导出引擎状态与路径供 TTS 复用。

### 修复与优化
- **任务元信息（截止 / 估时 / 锁定）贯通 Butler 工具**（改 `src/app/api/chat/tools/butler.ts`）：`create_scheduled_todo` 新增 `due_at`（排程硬约束）、`estimated_minutes`（未给 `end_time` 时由估时推执行块长度，否则仍 1 小时）、`block_locked`（用户钉死、排程器不移动）；`todo_update` 可改这三项（`due_at` 传空串 = 清除）；`query_schedule` 每条输出尾部追加 `[due … · est …m · locked · stale]` 后缀。
- **长期会话不可被降级**（改 `src/lib/core/chat-session.ts`、`src/lib/core/node-chat.ts`）：`prev.source` 为 `notify` / `panel` 时沿用原 source，避免从微信等短通道对同一条桌面会话提问被压成 24h TTL 而过期删除整段历史；新增显式 `channel` 入参，把「通道能力」与「会话 source」解耦（source 只管 TTL，channel 管工具面与权限分档）；`threadIdHint` 升级为权威落点，首次微信消息也不会漏进随机新会话。
- **新增排程器工作时段配置**（改 `src/lib/settings.ts`）：`Settings` 新增 `calendarWorkingHours`（tz / 工作日 / HH:MM 起止 / buffer），缺省周一至周五 09:00–18:00，排程器据此为未排程任务找执行块（暂无 UI 入口，改 settings.json 即生效）。
- **新增回归测试**（新增 `src/lib/calendar/scheduler/solve.test.ts`、`src/lib/calendar/analytics.test.ts`、`src/lib/project/resolve-explicit-project.test.ts`）：覆盖排程器确定性、忙块与工作时段约束，以及「估时偏差 → 校准系数 → 反哺 block 长度」闭环。

### 界面细节
- **通知已读交互改版**（改 `src/components/butler/ButlerDrawer.tsx`）：**点开卡片不再自动置已读**，改由卡片右端一颗眼睛按钮显式切换（睁眼 = 未读、闭眼 = 已读、再点恢复未读）；键盘回车 / 空格只认落在卡片头部本行，避免行内眼睛 / 待办按钮冒泡误开右栏。
- **中栏视图开关简化为单颗「已读」**（改 `src/components/butler/ButlerDrawer.tsx`）：原「待处理 / 已归档」两段式改为单颗「已读」开关（点亮 = 只看已读，再点回到当前未读）；切视图不再清空右栏选中，避免详情凭空消失。
- **日历面板新增排程过期提示与手动重排**（改 `src/components/butler/ButlerCalendarPanel.tsx`）：任务 / 日程变更使计划 stale 时，顶部出现「Plan may be out of date」提示与「Replan」按钮，可立即运行排程器；数秒内自动重排后回读一次自动收起提示（不轮询），重排后触发 `calendar-events-changed` 联动刷新。
- **Butler 聊天区改用微信式灰色画布**（改 `src/components/butler/ButlerDrawer.tsx`）：栏底座保持白底，滚动区压成灰，白 / 绿气泡在灰底上浮起，贴近微信观感。
- **朗读未配置引擎文案补充离线神经选项**（改 `src/app/api/tts/speak/route.ts`）：`not_configured` 报错提示由「云端模型 / 内置 macOS 音色」扩为包含「离线神经模型」。


***


## v0.7.635 (2026-09-27)

### 新增
- **Butler 回复支持「朗读」**（新增 `src/app/api/tts/speak/route.ts`、`src/components/butler/useReadAloud.ts`、`src/lib/tts/plain-text.ts`；改 `src/components/butler/ButlerDrawer.tsx`）：每条 AI 回复气泡下沿新增朗读键（hover 显形，进行中 / 出错时常显），点击即朗读该条回复，播放中可暂停 / 继续 / 停止，同一时刻只出一条声音。
  - 引擎 = 设置里已选中的那一款 TTS（云端 / macOS `say` 互斥单选，不另立兜底），经 `POST /api/tts/speak` 合成后**直接把音频字节回给客户端播放**（Content-Type 按实际格式给：云端 mp3 / `say` 降级 m4a），不走只服务项目相对路径的 attachments 通道。
  - 回复先由 Markdown 净化为「人话」（丢代码围栏、去表格竖线 / 加粗符号 / URL / emoji，标题与列表行尾补句号），再按句子边界切段（≤600 字）；分段串行 + 预取下一段，段间无缝、首字延迟小，同段文本本会话内缓存 blob URL 重播不重复合成。
  - 朗读为模块级单例：关抽屉 / 切联系人 / 起新一条均一条命令全停；未配置 TTS 或合成失败把后端原话就地红字显示，不静默失败。产物落 `<APP_ROOT>/butler/tts`，调用时顺手清理 7 天前旧文件（该目录此前只增不减）。

### 修复与优化
- **打包脚本补声明麦克风权限**（改 `scripts/build-electron.sh`、`scripts/package-release.sh`）：两个脚本写入的 `Info.plist` 各补一条 `NSMicrophoneUsageDescription`（中文说明「BobWork 需要使用麦克风来接收您的语音输入并转成文字。」）。此前 App 未声明该键，macOS 下无法获得麦克风授权；补上后首次录音会正常弹出系统授权提示，上一版的语音输入才能真正取到麦克风。
- **语音输入与离线转写准确度修正**（改 `src/components/ui/voice-input.tsx`、`src/lib/parse/audio-parser.ts`、`src/lib/stt/sherpa.ts`）：
  - 录音码率显式提到 128 kbps（MediaRecorder 默认 AAC 码率偏低会拖低转写准确率）。
  - 转写前加静音门限：转 WAV 后用 ffmpeg `volumedetect` 量峰值音量，低于 -50 dB 直接判「没人说话」并抛错，绝不把纯静音喂给离线模型（实测 SenseVoice 会在静音上硬造韩文）；量不出时不拦截。
  - SenseVoice 锁定中文（`--sense-voice-language=zh`），避免短音频 / 带口音时中文被误判成韩 / 日文。

### 界面细节
- **对话界面改白底、对方气泡改灰**（改 `src/components/butler/ButlerDrawer.tsx`）：聊天画布与输入区由灰底 `--paper-soft` 改白底 `--panel-bg`，对方（AI）气泡由白改淡灰 `--paper-soft`（与两侧灰侧栏一致），只在白底上留一层极淡分色、不描边；自己一侧仍是绿气泡。
- **「我」的头像改用河马线稿**（改 `src/components/butler/ButlerDrawer.tsx`）：自己一侧头像由「我」派生的 emoji 改成与 Butler 侧栏同一张 `/butler-orb.png`（白底圆角方格、1px 描边），同一抽屉里读到同一个身份。
- **抽屉内分割线进一步变淡**（改 `src/components/butler/ButlerDrawer.tsx`）：左轨 / 联系人列 / 中栏工具行 / 右栏等区域边界统一改用 `DIVIDER_SOFT`（比 `--line-soft` 再淡两档），白底上只留「看得出分区」的程度；描边（输入框、头像、选中态）仍用 `--line`。
- **联系人行重排**（改 `src/components/butler/ButlerDrawer.tsx`）：时间从预览行首挪到标题右侧，且当天只给时间「21:30」、更早只给日期「09-26」（跨年补年份）；预览行独占一行、无预览不占空行，行高更稳；行尾删除键移除。
- **删除好友挪进人设弹窗**（改 `src/components/butler/{ButlerDrawer.tsx,PersonaDialog.tsx}`）：删除键由联系人行尾（悬停才现、紧邻切换热区易误点）挪到「编辑人设」弹窗标题栏右侧，仅编辑态出现（常驻通知助理无编辑入口故无删除键）；点击仍走既有确认 + `removeChatSession` 路径。
- **等待行与正文吐字衔接**（改 `src/components/butler/ButlerDrawer.tsx`）：等待行改为只在「发送中且末尾占位气泡还没吐字」时显示，第一个字落下即卸载，不再出现「正文在长、旁边还挂着等待句」；思考跳动点由文字左侧移到句尾右侧。
- **输入框排版**（改 `src/components/butler/ButlerDrawer.tsx`）：输入框改白底 + 1px 描边定区（不再压灰成「洞里一块」）；正文与 placeholder 改贴左，底部用 `pb-9` 让出 34px 按钮带，长文本换行不再压到左下角回形针。


***


## v0.7.634 (2026-09-26)

### 新增
- **聊天输入框新增语音输入**（新增 `src/components/ui/voice-input.tsx`；改 `src/components/butler/ButlerDrawer.tsx`、`src/components/canvas/ChatNodeKernel.tsx`）：麦克风 → 录音浮层（实时波形 + ✕取消 / ✓完成）→ 转文字追加进草稿框，不自动发送、不落盘。录音状态机与浮层抽为公共模块，Butler 抽屉与画布聊天节点共用；转写失败改为直接丢弃并提示（不再挂起录音、不再有待发录音计数 chip）。
- **联系人头像**（新增 `src/lib/butler/avatar.ts`；改 `src/components/butler/ButlerDrawer.tsx`）：会话列表与中栏工具行新增圆角方头像，动物 emoji 由人设性格关键词命中决定（未命中按名字 FNV-1a 散列兜底），底色由名字加盐散列派生；纯本地派生、不落库不联网，两处渲染恒定一致。
- **收件箱支持「标记未读」**（改 `src/lib/core/inbox.ts`、`src/app/api/butler/inbox/route.ts`）：新增 `markInboxUnread`（与 `markInboxRead` 对称、可反悔），PATCH body 新增可选 `read:false`；旧 `{ids}` / `{all:true}` / `{ids,done}` / `{items}` 行为不变。
- **本地语音引擎可卸载释放磁盘**（改 `src/lib/stt/sherpa.ts`、`src/app/api/stt/local/route.ts`、`src/components/canvas/LocalSttPanel.tsx`）：新增 `removeLocalSttModel` / `uninstallLocalSttBinary`（残留 `.part` 一并清理，幂等）；下载仍为异步 + GET 轮询，删除为同步、直接返回最新状态供 UI 立即刷新，前端配二次确认。
- **Butler 抽屉可拖动、缩放、最大化**（改 `src/components/butler/ButlerDrawer.tsx`）：左栏空白处拖动移动、右缘/下缘/右下角热区改尺寸、绿键铺满可用区域；几何写入 localStorage 关后再开保持，窗口尺寸变化自动钳回视口。

### 修复与优化
- **STT/TTS 引擎改为「云端 vs 本地」互斥单选，彻底取消自动兜底**（改 `src/lib/parse/audio-parser.ts`、`src/lib/tts/index.ts`、`src/lib/settings.ts`、`src/lib/stt/sherpa.ts`、`src/lib/settings-server.ts`、`src/components/canvas/{LocalSttPanel.tsx,LocalTtsPanel.tsx,SettingsModal.tsx}`）：
  - 删掉上一版引入的「云端为主 + 本地隐式兜底」双路径与 `localEnabled` 开关，选哪个用哪个、没选则明确报错；选中本地引擎即切换并清空云端池。
  - 未知 STT provider 不再静默回落到豆包（避免拿别家 Key 打火山端点报 401），改为直接抛错；标签只标注实际选中的那一个引擎。本地 STT 模型清单精简为 SenseVoice / Whisper（移除 `paraformer-zh-small`），STT 侧下线 `bobmultimodal` 厂商与 `NO_AUTH_STT_PROVIDERS` 白名单。
  - 老配置一次性迁移（`migrateLegacyEngineSelection`）：把「曾开启本地兜底」的旧配置固化为显式本地引擎（STT→第一个引擎已装且模型齐全的项、TTS→`say`），迁移后删除 `localEnabled` 故只生效一次；已显式配过云端的不动。
- **回滚「用户档案常驻注入」**（改 `src/lib/runtime/context.ts`、`src/app/api/chat/route.ts`、`src/components/butler/ButlerMemoryPanel.tsx`；删除 `src/lib/core/profile.ts`）：撤销上一版引入的每轮全量身份注入，注入链恢复为 pathContext → userPreferences → ocrFact 三段；记忆面板移除 Profile 四栏表单，面板只剩偏好列表。
- **附件统一落 materials/**（改 `src/app/api/attachments/route.ts`、`src/components/canvas/composer/useComposer.ts`、`src/components/canvas/Sidebar.tsx`）：请求体不再接受 `store` 字段，粘贴的截图不再落 `attachments/`，一律进 `<项目>/materials/`（截图因此也会进项目材料并被检索）；`AttachmentStore` 类型删除，项目不再有 `attachments/` 一级目录。
- **通知状态收敛为单维度「已读 ≡ 归档」**（改 `src/components/butler/{ButlerDrawer.tsx,ButlerNoticeHost.tsx,butlerEvents.ts,butlerNotices.ts,ButlerOrb.tsx}`、`src/lib/butler/today.ts`、`src/lib/core/butler-notify.ts`、`src/lib/core/chat-session.ts`）：合并原 done / read 两个维度——点开一张卡片即已读并退到「已归档」，反悔走右栏底部「标为已读 / 标为未读」（唯一状态出入口）。抽屉打开不再自动替用户置已读；`unreadRows` 与行内「眼镜」严格同源，联系人行角标改由前端 store 现算、点开一条当场减 1，与悬浮球、左栏三处一致；`buildNotifySummary` 移除 `badge` 字段（连带删除 `countPendingInbox`）。
- **语音与音频工具文案英文化**（改 `src/lib/parse/audio-parser.ts`、`src/lib/stt/sherpa.ts`、`src/lib/tts/{index.ts,local-say.ts}`、`src/app/api/chat/tools/audio.ts`）：原中文指引统一改为简短英文，并明确「只跑设置里选定的单一引擎、无自动回退」；STT 厂商 label 改为 `Doubao` / `DashScope` 等英文名。`LOCAL_SAY_PROVIDER` 常量下沉到 `local-say.ts` 由 index 转出，避免 `settings-server` 循环依赖。
- **日程提醒标题去掉 `⏰` 前缀**（改 `src/lib/core/event-reminder.ts`）：抽屉卡片类型图标已表达日程，仅保留表达「已过期」的 `⚠️`。

### 界面细节
- **Butler 抽屉四栏布局重排 + 视觉降噪**（改 `src/components/butler/ButlerDrawer.tsx`）：左栏 84→48px、联系人列 200→168px、中栏宽度上限 560→420；右栏展开改为「增量加宽抽屉」而非挤压中栏；左栏与联系人列同改淡灰底、分割线降为 `--line-soft`。
  - 搜索框由中栏工具行移到联系人列顶部，同一个词同时过滤联系人列表与中栏时间线，两处各自给出空态；新建会话键改名 `Buddy`，记忆 / 日历改英文 `Memories` / `Calendar`，删掉与联系人列重复的「详情」键与底部「关闭」键。
  - 窗口键只留两颗（对齐原生 titleBar）：红 = 关闭（收起抽屉并清当前会话指针，下次为全新会话）、绿 = 放大 / 还原。
- **微信式对话气泡与时间分隔**（改 `src/components/butler/ButlerDrawer.tsx`）：自己 = 绿气泡在右、对方 = 白气泡在左，头像在最外侧、气泡贴头像侧带小尖角；聊天底压成灰；时间不再逐条贴气泡，改为居中灰色分隔条（相邻间隔超 5 分钟才插一条，文案随远近在口语 / 精确间切换）。
- **流式等待有交代**（改 `src/components/butler/ButlerDrawer.tsx`）：回答期间时间线末尾挂一条「等待行」，只按会话人设口吻说一句人话，不报「思考」、不报工具名、不带秒表，整轮收尾即卸载且不入会话历史。
- **去掉批量选择与右栏列表层**（改 `src/components/butler/ButlerDrawer.tsx`）：「已归档」改为只读展示（无勾选控件、待办不摊开）；右栏只剩阅读器一种形态、未选中显示空态；「待处理 / 已归档」开关自右栏挪到中栏工具行。
- **通知卡片细节**（改 `src/components/butler/ButlerDrawer.tsx`）：单条待办并入卡片头部行（不再同一件事写两行）；时间改显事件开始时间（日历项不再显示裸 ISO 串）；报告类标题与正文仅在无结构化待办时显示。
- **点消息区空白即聚焦输入框**（改 `src/components/butler/ButlerDrawer.tsx`）：气泡、空隙、包裹层等任意落点均可聚焦（按钮 / 链接 / 输入控件放行），原先只有点在滚动容器本身才生效。
- **截图 OCR 引线改指向文字中心**（改 `src/components/screen-ocr/ScreenOcrEditor.tsx`）：引线终点改为沿「气泡中心 ← 起点」射线求交，箭头正对文字中心，不再斜插到气泡角落。
- **截图 OCR 画完线可直接微调**（改 `src/components/screen-ocr/ScreenOcrEditor.tsx`）：文字 / 下划线工具下也做标注命中检测，刚画完的线或字可直接选中拖动，不必先切回「选择」工具。


***


## v0.7.633 (2026-09-26)

### 新增
- **Butler 抽屉重构为微信式「联系人」模型**（改 `src/components/butler/ButlerDrawer.tsx`、`src/lib/core/chat-session.ts`、`src/lib/core/node-chat.ts`、`src/app/api/core/node-chat/route.ts`；新增 `src/app/api/core/node-chat/session/route.ts`）：
  - 左栏新增 200px 联系人列（CHATS）：置顶常驻「通知助理」，其余为一个助理一条会话；中栏只渲染当前联系人的消息流，不再每条通知前都叠「全部回执」。
  - 右栏改为默认不显示、可单独收起（栏首关闭键不再关整个抽屉）；会话指针经 localStorage（`butler-active-thread`）持久化，关抽屉再打开会接回上次会话；新增会话（左栏 `+`）支持删除。
  - `GET /api/core/node-chat`：`?threadId=` 返回单会话（含与消息平行的逐条时间戳 `times[]`），无参返回摘要列表；`DELETE ?threadId=` 支持单条删除；`POST/PATCH /api/core/node-chat/session` 建会话与改人设。
  - `chat-session.ts` 新增 `listChatSessions`（只回摘要，避免长历史拖慢抽屉）与逐条时间戳列 `tail_times`（含老库 `ALTER TABLE` 迁移），用尾部重合长度对齐增量，会话被裁头后仍能正确判出本轮新消息。
- **会话级人设（Persona）**（新增 `src/components/butler/PersonaDialog.tsx`；改 `src/lib/core/chat-session.ts`、`src/lib/core/node-chat.ts`、`src/app/api/chat/route.ts`）：
  - 人设与 `chat_sessions` 同行存储（含老库迁移），删除会话即删除人设；`createChatSession` 幂等建会话，`setChatPersona` 刻意不动 `updated_at`，避免改名字把会话顶到最前。
  - 新建/编辑弹窗只露「姓名 + 性格」，性格给 7 个模板 chips（傲娇/元气/天然呆/三无/温柔治愈/病娇/自定义），身份职责与称呼方式收进默认折叠的「高级」。
  - 注入仅当 `identity==='butler'` 且姓名非空，只覆盖身份与语气层、不动工具面与权限；坏 JSON / 无姓名一律当无人设。
- **Butler 抽屉支持附件上传**（新增 `src/app/api/butler/attachments/route.ts`、`src/lib/files/attachment-type.ts`；改 `src/components/butler/ButlerDrawer.tsx`、`src/app/api/attachments/route.ts`）：
  - 输入框新增回形针 / 拖拽 / 粘贴三条入口，文件落 `<角色>/<日期>/attachments/`（同名自动加序号、上限 500MB、<2MB 附 `dataUrl`），回传绝对路径供 `read_attachment` 直读。
  - 与画布节点附件、项目 materials 刻意不复用（无 nodeId、不进材料清单）；待发附件以 chip 呈现、可移除（仅解除引用不删盘上文件），有附件无正文也可发送，切换联系人清空。
  - 附件类型判定抽为公共模块 `getAttachmentType`，两个附件入口共用，避免同一文件被判成不同类型。
- **常驻「通知助理」线程**（新增 `src/lib/core/butler-notify.ts`、`src/lib/butler/storage.ts`；改 `src/lib/core/inbox.ts`、`src/app/api/butler/inbox/route.ts`、`src/components/butler/{butlerEvents.ts,butlerNotices.ts,ButlerNoticeHost.tsx,ButlerOrb.tsx}`）：
  - 只收纳系统推送类（日程提醒 / 每日报告 / 跨项目检查），用户操作类回执不进；幂等建 `source='notify'` 会话，并把上线前 `thread_id` 为空的存量通知一次性归位。
  - 会话源新增 `'notify'`，与 panel 一样永不过期、清扫器不删；`upsert` 时锁定源，防止用户追问一次被写成 `panel` 丢掉常驻语义。
  - 角标口径由「未读」统一为「未归档」：读一遍不清零、归档才清零，且改为从 `/api/butler/today` 取服务端全量（本地 store 只装 50 条会少报）；列表接口合成通知助理摘要恒置顶并 `pinned:true`，批量删除通知时跳过常驻线程。
- **Butler 存储按「角色 × 日期」重构**（新增 `src/lib/butler/storage.ts`、`src/lib/butler/transcript.ts`；改 `src/lib/butler/report-doc.ts`、`src/lib/core/daily-report.ts`、`src/app/api/butler/report-doc/route.ts`）：
  - 落盘从扁平目录改为 `butler/<角色>/<YYYY-MM-DD>/{attachments,docs,chat}`，角色取会话人设姓名，无会话上下文归「通知助理 / 未分类」；`roles.json` 维护映射，改名时整目录 rename。
  - 目录名经白名单清洗（剔除非法字符、去 `..`、不以点开头、截断 64 字）防目录穿越；`roles.json` 写入先 tmp 再 rename 并加锁串行化。
  - 会话消息按「消息当天」幂等重写到 `<角色>/<日期>/chat/YYYY-MM-DD.md`（跨天会话拆多天，`system` 不入、`think` 剥离，落盘失败不阻断保存）。
  - 日报去重标记 / `pending.json` / `error.log` 移入内部状态目录 `butler/.state/daily-report/`；报告读取接口改为遍历 butler 树（跳过 `.state` 与隐藏目录），扩展名白名单收紧为 `.md/.markdown/.txt`。
- **用户档案（Profile）常驻身份**（新增 `src/lib/core/profile.ts`、`src/app/api/butler/profile/route.ts`；改 `src/lib/runtime/context.ts`、`src/app/api/chat/route.ts`、`src/components/butler/ButlerMemoryPanel.tsx`）：
  - 新增 `~/BobWork/butler/profile.md`（称呼 / 性别 / 性格 / 语言风格，人类可读 Markdown，留空即不生效），`GET|PUT /api/butler/profile` 整体读写。
  - 与偏好记忆严格分工：偏好是行为规则、按需调取；档案是身份设定、每轮全量注入（走低频通道前缀到当前轮 user 消息以保持缓存头稳定），并声明「现场指示与档案冲突时以现场指示为准」。
  - 记忆面板新增 Profile 区块，Name / Gender / Personality / Tone of voice 四栏整体保存，保存后回显 Saved。
- **本地离线语音识别（STT）**（新增 `src/lib/stt/sherpa.ts`、`src/app/api/stt/local/route.ts`、`src/components/canvas/LocalSttPanel.tsx`；改 `src/lib/parse/audio-parser.ts`、`src/lib/settings.ts`、`src/app/api/chat/tools/admin.ts`）：
  - 接入 sherpa-onnx 离线 CLI（macOS shared 包）与三个候选模型（`paraformer-zh-small` 中文最快 / `sensevoice-small` 中英日韩粤带标点 / `whisper-small` 99 语言），引擎与模型按需下载（最大约 375MB）到 `BOBWORK_HOME/.stt/`，不随安装包分发。
  - 下载统一走系统 `curl`（`-C -` 断点续传 + `--speed-limit` 防假死），中间态写 `.part` 完成后原子改名，多轮重试，进度直接读磁盘，重启可自愈。
  - 兜底策略：显式选 `sherpa-local` 则本地为主路径；云端未配置且本地开启则本地接管；云端为主时逐段失败自动回退本地并如实标注「离线兜底」，云端成功不会误标本地。
- **本地离线语音合成（TTS）**（新增 `src/lib/tts/local-say.ts`、`src/app/api/tts/local/route.ts`、`src/components/canvas/LocalTtsPanel.tsx`；改 `src/lib/tts/index.ts`、`src/lib/settings.ts`、`src/app/api/chat/tools/audio.ts`）：
  - 用 macOS 内置 `/usr/bin/say` 合成，零下载、离线可用；音色下拉来自 `say -v '?'`（中文排前），仅 macOS 有效。
  - macOS 无 mp3 编码器，`format: mp3` 请求降级为 m4a 并在返回值如实标注实际格式（不谎报）；`speed` 倍率换算为 `say -r` 词/分（基准 180，夹在 80–400）。
  - TTS 配置改为始终输出对象（池空时仍保留 `localEnabled`/`localVoice`），引擎据此走本地兜底而非抛「未配置」；`tts/index.ts` 顺带删掉自实现 `resolveAppRoot`，改用共享 `@/lib/app-root`。

### 修复与优化
- **会议状态注入放宽到非管家身份**（改 `src/app/api/chat/route.ts`、`src/lib/runtime/context.ts`）：`buildMeetingStateInjection` 由「仅管家」放宽为全身份注入，主对话（画布 chat 节点）开会后第二轮起链路不再断；按画像 gate（dynamic 画像，或 `fixedScenes` 含 butler 的 fixed 画像），避免出现「要求调 `meeting_append`、工具却不在手里」的反向错位。场景提示词正则补充 `会议|纪要|开会|参会|会务|meeting`，会议进行中在场景合并之后追加放行 butler 场景且不写入会话 sticky，会议结束即恢复原工具面。
- **斜杠命令入口收敛**（改 `src/lib/core/commands.ts`、`src/components/canvas/CanvasFlow.tsx`、`src/lib/agents/profiles.ts`、`src/lib/bridge/wechat-bridge.ts`、`src/lib/core/node-mode.ts`、`assets/skills/user-guide/SKILL.md`；测试 `commands.capability/steering/dropdown.test.ts`）：`/chat` 整体退役（普通文本本就直连同一管家 agent，该命令只剩同义反复的意图前缀）；`/clip` 下线合并为 `/note raw`（只囤素材不编译）。`⌘F` 面板退化为纯文件搜索，斜杠指令模式移除，指令入口统一到 Butler 抽屉与微信桥；手册与工具文案同步改写，并新增「已退役命令名不得回流到给模型的文案」的防回流用例。
- **微信桥可打断范围扩大**（改 `src/lib/bridge/wechat-bridge.ts`）：`steerable` 从「仅 askNode 路径」改为会话层链路恒真，长任务进行中的补充消息统一走「打断旧任务 + 按原任务合并重跑」。
- **聚合通道收口语义收敛**（改 `src/app/api/chat/route.ts`）：拒写文案从「⌘F 面板 /chat」改为「当前聚合通道」；Butler 抽屉走专用通道不受影响。

### 界面细节
- **通知卡片行内操作 + 日报报告化**（改 `src/components/butler/ButlerDrawer.tsx`）：通知行的「完成/撤销」措辞统一为「归档/撤销归档」，短回执的待办就地摊开勾选；日报在右栏直接以「今日 / 已逾期」两栏清单呈现，点一下即完成，不再显示邮件标题与正文。
- **Butler 悬浮球改版**（改 `src/components/butler/ButlerOrb.tsx`）：球体直径 44→28px，外观改为液态玻璃（折射 + 上缘镜面弧），默认落点从视口右下角改为中栏左下角（旧位置作废），角标缩小到 12px。
- **NodeMap 连线缩略图改为居中覆盖**（改 `src/components/canvas/NodeMap.tsx`、`CanvasFlow.tsx`）：由画布左下角悬浮改为居中覆盖在对话区之上（容器铺满但指针穿透，仅面板本体可交互）。
- **截图 OCR 编辑器批注交互重做**（改 `src/components/screen-ocr/ScreenOcrEditor.tsx`）：由「划线后自动在下方开输入框」改为先画纯下划线、再拖线尾「+ 添加批注」按钮定位批注；批注气泡被拖离横线时自动补单向虚线引线箭头。
- **Hippo 对话侧栏不再渲染 App 外壳元素**（改 `src/components/bobby/BobbyAuthHost.tsx`、`ButlerOrb.tsx`、`src/components/screen-ocr/ScreenOcrHost.tsx`）：`/browser-chat` 是主进程加载的零外壳页面，此前继承根 layout 导致授权浮标、悬浮球、截图面板误入，现三处均在该路由下不渲染。
- **研究模式按钮点亮样式**（改 `src/components/hippo-browser/BrowserChatPanel.tsx`）：开启研究时由灰底改为实心主题色底 + 主题前景图标 + 投影。
- **Tooltip 适配浅色主题**（改 `src/components/ui/tooltip.tsx`）：由深色半透明毛玻璃改为不透明面板底 + 深色字，描边加重。


***


## v0.7.632 (2026-09-25)

### 新增
- **会议记录从斜杠命令升级为管家工具**（新增 `src/app/api/chat/tools/meeting.ts`、`src/lib/core/meeting-finalize.ts`；改 `src/lib/core/meeting-session.ts`、`src/lib/core/executor.ts`、`src/lib/bridge/wechat-bridge.ts`、`src/lib/runtime/context.ts`、`src/app/api/chat/route.ts`、`src/app/api/chat/tools/index.ts`、`src/app/api/chat/tools/registry.ts`）：
  - 三个工具：`meeting_start`（标题可空，默认「会议 MM-DD HH:mm」，已在会中则报告不重开）、`meeting_append`（逐条原样累积）、`meeting_end`（`endMeeting()` + `finalizeMeeting()` 生成纪要写入 Butler 收件箱，`kind='meeting'`、`dedupeKey=meeting:<id>`）。
  - 链路：`/meeting 标题` 归一化后由管家调 `meeting_start`；会中每条消息靠 route 新注入的 `ContextRuntime.buildMeetingStateInjection()`（仅 `identity==='butler'`）让模型知道「会议进行中」，从而静默调 `meeting_append`；`/meeting out` 或 10 分钟静默由微信桥定时器收尾，另加 `sweepExpiredMeeting` 清理静默超时的会议。
  - 会议状态从进程内单例改为 `.inbox.db` 的 `meeting_session` 单行表（`id` 恒 1），API 全部转 async——修复微信桥独立进程与服务端状态不一致。
- **斜杠命令改为「翻译成意图交给管家」**（改 `src/lib/core/commands.ts`、`src/lib/runtime/context.ts`、`src/app/api/chat/route.ts`、`src/lib/bridge/wechat-bridge.ts`）：
  - `ButlerCommand` 新增 `intent` / `capability` 字段，新增 `normalizeSlashInput()`：命中则把输入变成「意图：<intent>」+ 正文，未命中原样透传；`/clip` 退役（并入 `/note raw`）。
  - 新增 `buildButlerCommandsInjection()`，每轮按 `BUTLER_COMMANDS` 真源现算注入命令表——绕开 agent.json 物化，已装用户即时生效，不必等重新生成画像。
- **Butler 抽屉新增 `/` 指令下拉**（改 `src/components/butler/ButlerDrawer.tsx`）：输入框内输入 `/` 向上弹出候选（绝对定位盖住消息区），复用 `buildCommandTextAtLine` / `filterCommands` / `loadCommandUsage`；候选按使用量降序、2px 左描边高亮；↑↓ / Enter / Esc 交给 `handleCommandKey` 消费，鼠标用 `onMouseDown + preventDefault` 保住输入焦点。**只注入 `/keyword` 不执行**，斜杠命令统一走会话层（`normalizeSlashInput` → SSE `/api/core/node-chat`），不再走 `/api/core/execute`。
- **Butler 日历面板**（新增 `src/components/butler/ButlerCalendarPanel.tsx`，已接入 `ButlerDrawer`）：上为固定 42 格月历（`GRID_DAYS`）、下为当日待办；带「隐藏已完成」眼睛开关，`toggleDone` / `removeEvent` 复用 `/api/calendar/events`，并通过 `calendar-events-changed` 与 `butler-event-sync`（由 `ButlerNoticeHost` 消费）广播同步。抽屉 RailItem「日历」直接切到该面板。
- **微信通道写类白名单**（改 `src/lib/runtime/tools.ts`）：新增 `WECHAT_ALLOWED_WRITES`，放行排程三件套 + 便签 + 笔记写类（`create_note` / `update_notebook` / `write_notebook_answer` / `restore_note` / `ingest_notes` / `review_notes` / `set_note_rules`），`delete_notebook` 除外；panel 通道保持只读。`SANDBOX_BLOCKED_TOOLS` 同时补入此前散落在名单外的笔记写类——那些工具原先在聚合链路上会被静默执行，现在工具面与声称的能力边界一致。
- **管家恢复笔记能力**（改 `src/app/api/chat/route.ts`、`src/app/api/chat/tools/registry.ts`、`src/app/api/chat/tools/skill.ts`）：`profile.id==='butler'` 时在 fixedScenes 上运行时并集 `'notebook'`，并把 `delete_notebook` 追加进 coreExclusions；`create_note` 新增 `raw_only` 参数（等价旧 `/clip`，只囤 raw 不编译）。提示词里「切 Full tools 档」的说法改为「去画布会话」，Sidebar / Browser 档文案统一为「浏览器对话栏」。
- **浏览器画像补 OCR**（改 `src/lib/agents/profiles.ts`、`src/app/api/chat/route.ts`）：`BROWSER_PROFILE.fixedScenes` 由 `['browser','ledger']` 变为 `['browser','ledger','ocr']`，浏览器纪律新增 `ocr_document` / `crop_image` 处理扫描件 PDF 的指引。
- **`query_todos` 新增 `view:'sticky'`**（改 `src/app/api/chat/tools/butler.ts`）：承接 `/inspect`，动态导入 `inspectStickyTodos` / `formatInspectReply`，按 项目 → 便签 → 页 列出未完成的便签待办。
- **工具调用可拿到宿主 `baseUrl`**（改 `src/app/api/chat/tools/index.ts`）：route 注入 `new URL(request.url).origin`，供 `meeting_end` 这类需要自调用宿主 API 的工具使用。
- **新增测试**：`src/lib/core/chat-session.test.ts`（`source` 只决定会话 TTL）、`src/lib/core/commands.capability.test.ts`（归一化契约：每条命令必有非空 `intent`）、`src/lib/core/commands.dropdown.test.ts`（下拉纯逻辑，含「`/tmp` 路径靠候选为空兜住」），并扩展 `src/lib/runtime/sandbox-blocked.test.ts`（白名单必须是禁写集的子集、`delete_notebook` 不放行、`lint_notes` 不误拦）。

### 修复与优化
- **Node 模式彻底退役**（改 `src/lib/core/node-mode.ts`、`src/lib/core/node-chat.ts`、`src/app/api/core/node-chat/route.ts`、`src/app/api/core/execute/route.ts`、`src/lib/core/executor.ts`）：`node-mode.ts` 收敛为「活动会话线程绑定」，只留 `bindActiveThread` / `getActiveThreadBinding`（30 分钟窗口），`/chat out`、`/chat new` 子命令全线删除。聚合问答恒为完整管家身份（`identity:'butler'` + 显式 `projectId`，与流式链路同源同序），历史 system 一律剥离交由 route 注入，`source` 只决定会话 TTL——修掉此前「模型自称只读、工具面却是管家」的矛盾。`/api/core/execute` 标 `@deprecated` 并删除 `source` 参数，仅保留 ProjectBoardView 的程序化调用。
- **聚合链路的挂起帧短路**（改 `src/app/api/chat/route.ts`、`src/lib/chat/tool-pipeline.ts`）：请求体新增 `channel?: 'wechat'|'panel'`，一路透传到工具执行上下文；新增 `denyOnAggregateChannel()`——带 channel 时 `questions_request`、`tool_confirm`、`butler_confirm` 三类挂起帧**一律不登记挂起**，改为「回话说明 + 不执行」，避免空等 10 分钟超时；`ask_user` 则把问题与选项文本回灌给模型，让它用自然语言追问。
- **`executor.ts` 收敛为宿主服务函数**（改 `src/lib/core/executor.ts`）：删除 `askNode`、`/chat` / `/help` / `/inspect` / `/clip` 分支与 `nodeMode` 相关字段，`command` 联合类型收窄为 `'todo'|'check'|'notebook'|'meeting'|null`，仅保留 `/todo` `/note` `/meeting`；未知命令回复改用 `buildHelpText()`。
- **日程交集判定修正**（改 `src/lib/db/index.ts`、`src/app/api/chat/tools/butler.ts`、`src/app/api/calendar/events/route.ts`）：三处把 `end_time IS NULL` 的「永不结束」语义改为 `COALESCE(NULLIF(TRIM(end_time),''), start_time + 30 分钟)` 的点事件——修复「Butler 排 18:00 会议时误报 19 条 8 月无结束时间待办为冲突」，也避免这类历史待办在 today / week 查询里被误命中，或在批量清理时被误删。
- **`UnifiedPalette` 重构为纯搜索**（改 `src/components/canvas/UnifiedPalette.tsx`，约 −250 行）：删除指令态与会话态（`commandOpen` / `activeCommand` / `nodeMode` / `handleExecute`、指令下拉、Shift+Enter 分组批量、会话徽标与 placeholder 分支），指令入口统一并入 Butler 抽屉。
- **浏览器对话面板去掉档位**（改 `src/components/hippo-browser/BrowserChatPanel.tsx`）：删除 Ask / Browse / Research 下拉与解锁逻辑（`unlocked` / Lock / Unlock），身份恒为 `AGENT_IDS.browser`；Research 降级为 `researchMode` 开关（localStorage `'research'`，Telescope 图标）；自建 notice 浮层改走 `bridge.toast`；移除 `page.loading` 与 selection 注入。
- **`NodeMap` 折叠改为受控**（改 `src/components/canvas/NodeMap.tsx`、`src/components/canvas/CanvasFlow.tsx`）：新增 `collapsed` / `onCollapsedChange`，折叠即隐藏，外部点击豁免 toggle 按钮；两者一并删除 BobMail / Mail 未读角标。

### 界面细节
- Butler 抽屉用户气泡由品牌紫底白字改为 `var(--paper-hover)` + `var(--ink)`，与助手气泡靠深浅 + 描边区分；助手气泡改用 `StreamingMarkdown` + `.butler-md`，并逐帧 `stripThinkTags`。
- 新增 `.butler-md .html-renderer` 收紧气泡内 markdown（标题 13px、`color:inherit`）。
- 画布底部品牌栏新增 Calendar 入口（自 ⌘F 图标栏迁入）；项目行新增 NodeMap 开关（`data-nodemap-toggle`），并监听 `butler:open-calendar`。


***


## v0.7.631 (2026-09-25)

### 新增
- **Butler 抽屉接住三类「挂起型」SSE 帧**（改 `src/components/butler/ButlerDrawer.tsx`）：
  - 此前服务端登记挂起后前端漏接，用户会「说完一句就卡住」直到 600s 超时。现在逐一接管：`tool_confirm` → 复用 `useConfirm` 的 `confirmAsk` 弹框并回 `POST /api/chat/confirm`；`login_required` → `LoginDialog` 弹窗 + `POST /api/chat/login`（提交 / 取消 / 卸载三路都能回收）；`grant_required` → 转成 `bobby:grant-required` 窗口事件，再监听 `bobby:granted` 用 `sendRef` 自动补发「已授权，继续」，不必用户手动再问一遍。
  - `send` 的依赖修正为 `[draft, sending, confirmAsk]`，新增 `sendRef` 解决窗口监听闭包拿到旧实现的问题；关闭抽屉时同步取消挂起的登录等待。
- **Butler 抽屉支持斜杠指令**（改 `src/components/butler/ButlerDrawer.tsx`，接入 `src/lib/core/commands.ts` 的 `detectCommand`）：
  - `/chat` 仍走 SSE 流式链路（只剥离前缀；`/chat new` 经 `threadIdRef.current=null` 强制新会话；空问题回提示），`/todo`、`/note`、`/clip`、`/meeting`、`/inspect`、`/help` 走 `POST /api/core/execute` 聚合返回。
  - 输入框 placeholder 随 `draftCommand` 动态提示「将执行 /xxx — label」，不用先发出去才知道自己命中了哪条指令。
- **PDF 银行流水 / 对账单勾稽校验（恢复 + 回归保护）**（新增 `src/lib/pdf/shared/money.ts`、`src/lib/pdf/statement/semantics.ts`、`src/lib/pdf/statement/control-rows.ts`、`src/lib/pdf/statement/cell-verification.ts`、`src/lib/pdf/core/ledger.ts`；新增 `src/lib/__tests__/skill-script-imports.test.ts`）：
  - 金额定点化：`toMinorUnit` / `reconcile` / `formatMinorUnit`，用整数最小单位比较，去掉原先 IEEE754 浮点上 0.005 的容差。
  - 账务语义推断 `inferLedgerSemantics`：判断列序、余额所在位置、金额口径与借贷方向，置信度分 `confirmed` / `inferred` / `ambiguous`。
  - 控制行识别：`subtotal` / `total` / 期初 / 期末，并用 `crossPageReconciliation` 串起跨页勾稽链（不确定时落到 `needs_review` 而不是硬判错）。
  - 逐格五维校验（visual / structural / normalization / reconciliation / human）给出 green / yellow / red，结果写入 `OcrPage.cellVerification`；主入口 `ledgerValidationReport` / `buildMultiPageLedgerReport`。
  - 为什么是「恢复」：`statement/` 在上一轮被当作死代码清除，导致 `assets/skills/bob-bank-statement` 的入口 `run_statement_pipeline.ts` 直接 `ERR_MODULE_NOT_FOUND`。本次按未改动的 `shared/types.ts` 里早已声明的 `StatementLedgerRow` / `LedgerValidationReport` 类型把实现补齐，并新增 `skill-script-imports.test.ts` 作为回归保护网（防止再次被当死代码删掉）。
  - 接入现状：目前只有 skill CLI 相对 import，应用运行时 `src/` 内尚无引用，产品路径待接。
- **Butler 推送克制 / 免打扰时段**（新增 `src/lib/core/quiet-hours.ts`；改 `src/lib/core/daily-report.ts`、`src/lib/core/event-reminder.ts`、`src/lib/settings.ts`、`src/components/canvas/SettingsModal.tsx`；测试 `src/lib/core/quiet-hours.test.ts`）：
  - `quiet-hours.ts` 是唯一推送裁决点：默认开启（仅显式 `false` 才关）、免打扰窗口默认 22:00–08:00 且支持跨夜、起止相同视为零长度不作为静默、单日上限默认 6 条、`reminder` 永不被免打扰静默、读设置失败按未开启放行；计数落在 `butler/notify-state.json`。
  - 日报：`decidePush('report')` 裁决微信推送并 `recordPush` 计数；新增 `shouldHoldMorningReport()`，在免打扰窗口内按住晨报「生成」而非生成完再丢弃。提醒：`foldReminderBatch` 把一批提醒折叠成最紧急的 1 条再计数。
  - 设置面板新增 Butler 导航分组与 `butlernotify` 面板（Bell 图标，色 `var(--success)`），`bnEnabled` / `bnQuietStart` / `bnQuietEnd` / `bnDailyLimit` 自动保存进 `settings.butlerNotify`；校验 HH:mm、起止相同提示空窗口、上限要求整数 ≥ 0；非法值不静默丢弃，而是回落默认值并写内联 `bnLimitErr`。
- **报告类回执可分享**（新增 `src/lib/butler/report-share.ts`；改 `src/app/api/butler/report/route.ts`、`src/components/butler/ButlerDrawer.tsx`）：
  - 分享契约单点定义 `isShareableReportKind`，放行 `web` / `daily-report` / `inspect` / `info` 四类；`buildReportShareUrl` 生成 `/api/butler/report?id=` 链接，`sanitizeReportFileName` 清理文件名。
  - 修复旧 UI 只在 `kind==='web'` 时渲染按钮、而真实收件箱里 web 类回执为 0 条、导致分享入口从未出现过的问题；现在前后端同源判定。
  - 抽屉详情区新增 `.md` 下载与「链接」复制按钮组（复制后变「已复制」+ Check，`copiedLinkId` 1.6s 后复位）；服务端响应同时去掉正文标题行，避免重复标题。
- **B5「中途改」：微信桥支持打断并合并重跑**（改 `src/lib/core/commands.ts`、`src/lib/bridge/wechat-bridge.ts`、`src/lib/core/executor.ts`、`src/lib/core/node-chat.ts`、`src/app/api/core/node-chat/route.ts`；测试 `src/lib/core/commands.steering.test.ts`）：
  - 新增 `mergeSteeringInput`：剥掉指令前缀 → 与原任务合并 → 前缀加回，并折叠成单行。
  - 微信桥新增 `inflightTasks` 登记表（持 `AbortController`，`steerable` = node 模式或首行 `/chat`），`supersedeInflight` 负责裁决：新消息若是已知指令则只打断不合并，否则与原任务合并重跑。
  - `executor` / `node-chat` 新增 `signal` 透传与 `ExecResult.aborted`（被 abort 的任务不回执），接口透传 `request.signal` 并回 `aborted`。
- **语音转写失败改为挂起录音而非静默丢弃**（改 `src/components/canvas/ChatNodeKernel.tsx`）：
  - 新增 `deferredVoiceRef` / `deferredVoiceCount` 持有转写失败的 `File`，用 `confirmAsk` 让用户选 Keep / Discard；选 Keep 就等到真正 `doSend` 时才 `uploadAttachment(..., 'attachments')` 落盘。
  - 输入栏新增 Mic 计数 pill，点击即丢弃；改变此前「转写失败只 `console.warn` 一句、然后当附件直接发送」或静默落盘留下孤立音频的行为。

### 修复与优化
- **删掉恒为 undefined 的 `butlerAgent` 选项**（改 `src/lib/core/node-chat.ts`、`src/app/api/core/node-chat/route.ts`）：该选项 route 从来不传，导致「Butler 身份」分支永远进不去，是「画布与抽屉融合」留下的半截通路；改为由调用函数区分路径——`askTempNode` 走沙盒（`sandbox:true`）、`streamButlerChat` 走 butler。
- **`/chat` 上下文时长 15 分钟 → 30 分钟**（改 `src/lib/core/commands.ts`，帮助文案同步）。
- **微信欢迎语改为复用 `buildHelpText()`**（改 `src/lib/bridge/wechat-bridge.ts`）：以 `BUTLER_COMMANDS` 为单一真源，修掉旧手写文案「发消息即自动解析 / 直接问日程」与 executor「无指令分支硬性拒绝」相矛盾、导致新用户按欢迎语操作必失败的问题。
- **`/api/core/execute` 显式接收 `source`**（改 `src/app/api/core/execute/route.ts`）：只接受 `'wechat'`，其余按默认 panel 处理，避免来源在 HTTP 边界被静默丢弃。

### 界面细节
- Butler 抽屉输入框 placeholder 改为随指令动态提示；详情区新增 `.md` / `链接` 按钮组。
- 画布节点输入栏新增挂起录音计数 pill。
- `src/components/canvas/CanvasFlow.tsx` 仅注释更新（`butlerAgent` → `streamButlerChat`），无行为变化。


***


## v0.7.630 (2026-09-25)

### 新增
- **启动期数据目录迁移 `wanted/` → `butler/`**（新增 `src/lib/core/legacy-migrate.ts`；改 `src/instrumentation.ts`）：
  - `wanted` 命名空间并入 Butler 后，运行时数据目录随之改名。没有在源码里直接 `mv`——改名前实测到旧构建的 App 正在运行、且 `wanted/daily-report/` 仍在被写入；手动移动会让旧构建读不到 `preferences.md`（长期记忆失效），并立刻重建一个空的 `wanted/`，形成新旧目录并存的分裂状态。改由新构建首次启动时自行改名，天然保证「旧数据不丢、新旧目录不并存」。
  - 同盘 `renameSync` 原子改名、不复制数据、不产生中间态；`butler/` 已存在即返回（幂等）。必须排在 `register()` 最前、先于日报与提醒调度器——否则调度器会先 `mkdir` 出空 `butler/`，迁移被跳过、旧数据滞留；两者并存时只告警不自动合并。
  - 日报、提醒、收件箱、报告文档、偏好、TTS 等运行期目录全部改落 `butler/`。
- **Sidebar 等待安抚条：等待期间给话、只报步数**（改 `src/components/canvas/chatNodeKernelParts.tsx`、`src/components/canvas/ChatNodeKernel.tsx`）：
  - Hippo Browser 右栏（`surface==='sidebar'`）新增提示条：带秒表（每秒自跳，且自带 1s tick 只重渲染本条，不牵动整条消息列表），按等待时长分三档、每 8 秒轮换安抚话，流式刚发起（首 token 未到、尚无阶段）就出现，不再是「一片空白地等」。
  - 侧栏只报「跑了多少步」：`traceThinkText` 置空不进食思考原文与工具明细，`TraceProcessSummary` 新增 `compact` 态（保留「已跑 N 步」折叠头但不可展开），并隐藏 prefix hash / ttft / tok/s / 降档等开发诊断元数据。画布节点 `isSidebar` 恒 false，不受影响。
- **技能执行侧闸门，替代「加载了却做不了」**（改 `src/app/api/chat/tools/skill.ts`、`src/app/api/chat/route.ts`、`src/lib/agents/profiles.ts`、`src/lib/chat/tool-pipeline.ts`）：
  - Sidebar(browser) 档新增 `BROWSER_SKILL_EXCLUSIONS=['deep-research']` 与 `skillExclusionsFor()`；L1 技能目录直接剔除本档「看不见」的技能，并新增 `args_transform` 接管 `__skill_gate__` 注入 `__disallowed_skills`，`load_skill` 与技能资源读取都在执行点过闸——凭名也调不动，同时给出替代路径。历史故障：侧边栏调研跑 39 轮零产物，因为末步 `write_file` 在本档并不存在，跑到最后才发现。
  - tool-pipeline 增 `agentId` 透传，闸门信息能一路带到执行点。
- **Sidebar 档专属规则 `BROWSER_SIDEBAR_RULES`**（改 `src/app/api/chat/route.ts`）：仅 `profile.id==='browser'` 时动态注入、不进 system——①落盘约定豁免：该档没有 `write_file` / `run_command`，不再让模型去找不存在的写文件工具；②窄栏输出风格：工具调用之间不写过程叙述，正文只留交付物。
- **`/api/browser` 命名空间**（改 `src/components/canvas/McpStorePanel.tsx`）：浏览器扩展 ZIP 与浏览器桥 token 相关调用由 `/api/wanted/*` 迁到 `/api/browser/*`。

### 修复与优化
- **命名空间重构：`wanted` 拆为 `core`（通用引擎）+ `butler`（助理域）**（改 `src/lib/core/*`、`src/lib/butler/*`、`src/app/api/core/*`、`src/app/api/butler/*`；删 `src/lib/wanted/`、`src/app/api/wanted/`）：引擎类 `/api/core/`（execute / meeting / node-chat / schedule-parse）与用户面 `/api/butler/`（daily-report / inbox / organize-send / preferences / reminders / report / report-doc / today）分家；总线事件 `wanted.notice` / `wanted.executing` 更名为 `butler.notice` / `butler.executing`，payload 类型 `WantedNotice*` → `ButlerNotice*`，生产者（日报、日历提醒、收件箱）与消费者 `ButlerNoticeHost` 同步；全仓已无 `@/lib/wanted`、`/api/wanted` 残留。
- **能力检索话术**（改 `src/app/api/chat/route.ts` 的 `buildCapabilityResultText`）：fixed 画像现在如实回「本档不可用」并给替代路径，不再让模型等一个永不注入的工具；非 fixed 档补一句「下一回合立刻调用刚注入的工具，别把『已激活 / 请稍候』当成答复」。
- **Research 开关注入条件修正**（改 `src/app/api/chat/route.ts`）：`BROWSER_RESEARCH_RULES` 从档位条件里移出、改按 `researchMode` 判定，修复「Full tools + Research」时两套指引都不注入的情况。
- **TTS 探针路径修正**（改 `src/lib/bridge/wechat-bridge.ts`）：TTS 探针临时目录由硬编码 `homedir()/BobWork/wanted/tts` 改为 `resolveAppRoot()/butler/tts`，修复 dev isolation（`BOBWORK_HOME`）下写进真实用户目录。
- **内部目录豁免**（改 `src/lib/project/project-watcher.ts`、`src/lib/project/project-manager.ts`、`src/app/api/projects/route.ts`）：项目监听与 `/api/projects` 跳过 `butler/`，不再把 Butler 运行时数据当作项目文件；`project-manager` 负责确保全局 `butler/` 存在。
- **死代码清理**：删 `src/lib/wanted/todo.ts`；`src/app/globals.css` 移除 `wanted-orb-*`（悬浮球光晕）与 `lcd-progress*`（Game Boy LCD）及其 `prefers-reduced-motion` 规则——两者实现均已废弃；electron 退出清理改调 `/api/core/node-chat`；日报报告文档改绝对路径 `@/lib/butler/report-doc` 动态 import。

### 界面细节
- 提交流程文案统一为 `Butler Delivery`（改 `src/components/canvas/CanvasFlow.tsx`），提示路径 `~/BobWork/wanted/` → `butler/`；沙箱 Layer 3 文档中的落盘路径说明同步改为 `butler/`（改 `src/components/canvas/SandboxPanel.tsx`）。
- `ButlerOrb` / `ButlerDrawer` / `ButlerDocPanel` / `ButlerMemoryPanel` / `ButlerTodayPanel` / `butlerNotices` / `AICodingCreateDialog` / `ProjectBoardView` 以及便签相关路由的品牌字样与端点统一回归 `/api/butler|core/*`。


***


## v0.7.629 (2026-09-25)

### 新增
- **画布语音输入改为「录音 → 转写文字回填」**（新增 `src/app/api/transcribe/route.ts`；改 `src/components/canvas/ChatNodeKernel.tsx`、`src/components/canvas/composer/useComposer.ts`、`src/lib/parse/audio-parser.ts`、`src/lib/parse/types.ts`）：
  - 新 `POST /api/transcribe`（base64 音频 + 文件名 → 纯文字）：音频只落系统临时目录、用完即删，不进 `materials/` 也不进附件列表；转写引擎与 `transcribe_audio` 工具同源（`settings.stt`）。
  - 节点输入区录完音不再挂附件，改为转写后追加进输入框（与全局截图 OCR 注入同款口径，不自动发送）；转写期间浮层显示 `Transcribing…` 转圈并遮住输入框，故设 120s 上限，超时或失败自动退回「作为附件挂上」的旧行为，录音内容不丢。
  - 音频解析结果新增 `plain_text`（纯正文，不含 `音频转写（…）` 抬头与 `[mm:ss]` 时间戳），供「直接当文本用」的场景取用。
- **Butler 抽屉接住结构化提问，不再「说完一句然后卡住」**（改 `src/components/butler/ButlerDrawer.tsx`）：
  - 模型走 `ask_user_questions` 提问时服务端会推 `questions_request` 帧并挂起等待（最长 600s），抽屉原先不认这个帧 → 什么都不弹、气泡永远 pending。现在复用画布同款 `QuestionPopup`，以 docked 形态顶掉输入框渲染（同位置、不遮挡正文），并支持最小化成悬浮胶囊继续作答。
  - 三条兜底：显式「跳过」立即按未回答回传（不必干等 10 分钟）、倒计时归零本地清理、抽屉卸载时也按未回答回传，避免服务端空等到超时；提问卡收起后焦点自动还给输入框。
- **带图轮次自动改选候选池视觉模型**（新增 `resolveVisionChatModel` 于 `src/lib/wanted/task-model.ts`；改 `src/app/api/chat/route.ts`、`src/lib/settings.ts`）：
  - 节点模型选择器下线 Auto 后节点始终带具体模型，若当前模型读不了图，本轮改选候选池里第一个视觉模型（开关 `settings.chatModel.autoVisionOnImage`，默认开），让下方「直连多模态」判定成立；池内无视觉模型则保持原模型，继续走 Vision Bridge 描述兜底，不悄悄降级。
- **研究档报告统一引用规范：GFM 脚注 + 论文式多级编号**（改 `src/app/api/chat/route.ts`、`src/app/share/[token]/route.ts`、`src/components/canvas/ChatNodeKernel.tsx`）：
  - 报告骨架改为 `## 1 研究问题` → `## 2 检索范围` → … → `## 6 结论与下一步建议`，子问题用 `### 3.1` 逐级展开（最多四级）；正文出处一律写 GFM 脚注角标 `[^n]`，文末按顺序给 `[^n]: 来源名称 — 完整URL` 定义，正文不再出现裸 URL。
  - 分享页补齐脚注样式（角标上标 + 文末引用表，含深色模式），并修掉 sanitize 造成的锚点 id 双重前缀（`user-content-user-content-fn-1` → 角标点了跳不到引用条目）。
  - 研究档报告行新增一行正文摘要（从正文首个像样段落取、摘掉加粗标记与脚注角标），不展开也能看出结论讲了什么。

### 修复与优化
- **WANTED 临时问答的工具面按提示词收口**（改 `src/lib/runtime/tools.ts`、`src/lib/wanted/node-chat.ts`）：沙盒禁用名单补上 `create_scheduled_todo` / `todo_update` / `todo_delete` / `create_sticky_note`——提示词明写「不写入待办、日历」，工具面却照旧给着写接口，模型在两份矛盾指令间摇摆（实测思考块里出现 "There's tension"，最终有时拒答、有时想去写）。只读的 `query_schedule` / `query_todos` / `read_todo` 保留不动；提示词同步说明「要写请用右下角 Butler 悬浮球或在日程/便签面板操作」，不再让模型假装已写入。
- **Butler 会话「说一套写一套」修正**（改 `src/lib/wanted/node-chat.ts`）：Butler 链路用的是占位 `nodeId`，route 定位不到项目 → 上下文注入「当前没有激活项目」，而排程工具内部写的却是当前活跃项目，于是 Butler 误判「这条日程记为全局待办」。现在显式解析并传 `projectId`，让 route 走显式分支（沙盒路径仍不传，保持纯问答 + 临时工作区语义）。
- **待办回执三级折叠改为按需省略**（改 `src/lib/wanted/inspect.ts`）：某一层不携带信息就整层省略——单张便签且标题与项目名无差别（或为空）时不显示便签层，单页且页标题是默认的 `Pn` 时不显示页层（分页能力已废，每张便签恒为 P1），消除报告里「■ 项目名」下紧跟「◇ 同名」与 `· P1` 的噪声行，省略后子级缩进自动上提。
- **便签上限常量收口**（改 `src/app/api/chat/tools/butler.ts`）：`MAX_TODO_NOTES` 改为从 `@/lib/sticky-todo` 导入共享常量，避免与 `/api/sticky-notes` 的校验各说各话。
- **非 V4 推理模型的思考引导改为恒注入**（改 `src/lib/thinking/policy.ts`、`src/lib/settings.ts`、`src/components/canvas/SettingsModal.tsx`、`src/app/api/chat/route.ts`）：这些模型的思考块显示依赖 ` thinking` 标签引导，属正确性前提而非偏好，故移除 `injectThinkGuide` 开关（settings 类型与默认值、设置面板、策略函数签名同步），关掉开关只会让思考块显示不正常。
- **模型选择器下线 Auto**（改 `src/components/canvas/ChatNodeKernel.tsx`、`src/app/api/chat/route.ts`）：节点始终持有具体模型，存量空 `modelId` 节点经迁移 effect 落成「候选池有序首选（池空则下拉首项）」；候选池为空时下拉退化为「全部已勾选模型」，不再出现只剩 Auto 的空下拉；消息标签以服务端 done 帧回传的实际模型为准（含带图改选视觉模型的结果），避免标签误导。
- **报告固化不再把过程叙述写进正文**（改 `src/components/canvas/ChatNodeKernel.tsx`）：Research 档的「Let me open…」过程叙述与结论同处一条 assistant 消息且整段挤在报告之前，原样固化会把叙述一起写进 `materials/`（分享页照渲染）；现在按首个一级标题 `# <主题>` 切开，找不到时才保持原样，不做猜测性截断。

### 界面细节
- Butler 抽屉由右侧全高滑出改为**居中弹窗**（宽 `min(1040px, 88vw)` × 高 `min(760px, 86vh)`，圆角 16 + 四周留边、更重的投影），右栏宽度改为自适应。
- Butler 抽屉中栏话题行改微信式「收到」气泡：靠左 + 上限 85%（短主题就短气泡），类型只留图标（hover 出全称）、主题单行截断（正文预览移交右栏），新增「待办 n / ✓ n」进度徽标，不必点开就知道这条有事可做。
- Butler 悬浮球 52px → 44px，改「透明玻璃 + 黑线条河马」水晶球外观：球体靠径向高光 + 边缘暗化 + 内外阴影撑出体积，不再用蓝色渐变贴图与 `drop-shadow`（后者只按非透明像素描边，会变成线条自己投影），悬停放大 1.04；未读角标 18 → 16。
- 设置面板 Models 角色分配区由「一角色一张卡片」改为单卡片行式列表：每行行首显示当前模型（多个显示 `+N`，未配置显示 Not set），展开后才增删；思考档位策略收进默认折叠的 Advanced 区，仅「纯固定档」关闭后才有语义的两条开关改为条件渲染；STT / TTS 的 Voice、Speed 标签与占位文案统一为英文。
- 上下文占用环 `ContextMeter` 从 composer 尾部移到 AI 回复末尾动作行最右侧。
- 画布节点输入区：技能菜单去掉独立按钮（入口只留输入框内输入 `/`），菜单宽度 300 → 196 并隐藏滚动条；麦克风按钮移到发送按钮左侧、转写中一并禁用；原先的「强制 MCP」下拉按钮整体移除（Store 中全局 enabled 的 MCP 自动可用）。
- 浏览器对话面板分隔条热区改为整条左缘（可见部分仍是中间一枚小按钮），悬停任意高度都能唤出。
- 侧边栏已隐藏 Chat / Team 分段控件，Trace 图标改为可来回切换，成为从 Trace 回到对话的唯一入口。


***


## v0.7.628 (2026-09-25)

### 新增
- **Butler 从对话框改为三栏抽屉，画布 Butler 节点退役**（新增 `src/components/butler/ButlerDrawer.tsx`；改 `src/components/butler/ButlerHost.tsx`、`ButlerOrb.tsx`、`src/components/canvas/CanvasFlow.tsx`、`src/lib/bus.ts`；删除 `src/components/butler/ButlerChatDialog.tsx`、`src/components/canvas/ButlerNode.tsx`）：
  - 旧 `ButlerChatDialog` 是 420px 窄对话框 + Today / 记忆 / 文档三个互斥浮窗，搜索 / 类别 / 批量 / 存档全塞一条窄时间线越加越挤，三个浮窗同一时刻只能看一个。新 `ButlerDrawer` 从右侧滑出、无遮罩、固定宽 `min(1180px, 92vw)`，核心架构是**左栏功能键 / 中栏 Butler 会话 / 右栏预览区**三栏并列——切左栏功能键不再换掉聊天内容（这是最痛的那次 UX 问题），中栏恒为 Butler 会话、左右各自独立。窄窗自适应：< 820px 右栏改覆盖层、< 560px 左栏收成 48px 纯图标。
  - 画布右键菜单里的 Butler 节点彻底移除（备份至 `.removed-20260925.bak`）：Butler 的能力**完全收敛进悬浮球抽屉**，不再在画布里再塞一个节点。
  - `ButlerOrb` 升级为河马贴图（`public/butler-orb.png`）、位置持久化、未读角标改用 `butler:inbox-pending` 即时广播 + 兜底轮询 2 轨。
- **日历冲突统一检测与提示**（新增 `src/lib/calendar/overlaps.ts`；改 `src/lib/sticky-calendar-sync.ts`、`src/app/api/sticky-notes/route.ts`）：
  - 把「便签自动结算入日历 / Butler 排程确认卡 / 手动 Add to calendar」三条入日历路径的冲突检测**收敛成同一套 `findEventOverlaps` + `formatOverlapNote` + `stripOverlapNote`**。`sticky-calendar-sync.ts` 之前只做 `(project_id, title, start_time)` 防重，现在建 / 重排事件前先查重叠、把提示写进 `description` 前缀（`注意 · 与已有安排重叠：09:00–11:00 某某案开庭`），重排时先 `stripOverlapNote` 摘旧提示再写新的，**不动用户手写备注**。
- **技能基线哈希 + 一键更新能力**（新增 `src/lib/skills/baseline-server.ts`；改 `src/components/canvas/SkillManagerModal.tsx`、`src/lib/skills/installer-server.ts`、`src/app/api/skills/route.ts`）：
  - 物化安装时记录随包源哈希到 `<APP_ROOT>/extensions/skills-baseline.json`；之后比对源哈希 / 副本哈希 / 基线哈希的差异象限，区分**官方有更新 / 用户本地修改 / 两边都改 / 完全同步**四种状态。前端 SkillManagerModal 据此亮 UpdateBadge（蓝 / 灰 / 红三态徽章分别对应 update / edited / conflict），Market 卡片已安装项的绿色 Installed 标签在 update 状态下换成显眼的 Update 按钮（带 RefreshCw 图标），已安装卡片在 update 状态下把图标按钮换成实心品牌色按钮跳过二次确认；Conflict 状态弹窗文案改为 "Overwrite local edits with the official version?"。老用户自愈补记：首次打开管理器时对缺失基线的已安装技能自动登记，无需重装即可纳入监测。

### 修复与优化
- **浏览器对话栏档位 → Agent 身份的映射表对齐**（改 `src/components/hippo-browser/BrowserChatPanel.tsx`、`src/lib/agents/profiles.ts`、`src/app/api/chat/tools/butler.ts`）：档位 → Agent 身份映射从散落在组件各处收进画像层，`Full tools` 档与 `AGENT_IDS.chat` 强绑定；Butler 工具（`tools/butler.ts`）与身份画像的 `console` / `ledger` 场景对齐，避免出现「某档下工具面里明明有但画像说不该有」的静默漂移。
- **Butler 会话 API 放宽 + 收件面板 `stripThinkTags` 强制执行**（改 `src/lib/wanted/node-chat.ts`、`src/app/api/wanted/node-chat/route.ts`、`src/components/butler/ButlerHost.tsx`）：`POST /api/wanted/node-chat` 新增 `source:'drawer'` 来源标识（面板侧的 Butler 会话不再伪装成 canvas 节点，直接传 `source:'drawer'` 走面板专属链路）；后端强制剥离 `[[say]]`、`[[msg]]` 协议块与思考标签，确保 Butler 面板看到的是干净的对话，与画布侧共享同一套 `stripThinkTags` 实现。
- **便签 → 日历同步不再漏单**（改 `src/lib/sticky-calendar-sync.ts`）：便签「自动结算入日历」链路在重排时原本会跳过「只改了时间未改 title」的条目，现在 title 做归一化比对（去空白、去全半角差），时间 / 地点 / 参与人任何一项变动都触发重排。

### 界面细节
- 设置面板 SkillManager 区域默认折叠，Butler 相关快捷键提示里 `(Butler inbox)` 描述同步更新。
- CanvasFlow 事件总线新增 `butler:open-calendar` / `butler:open-inbox` 的跨宿主唤起通道。
- `ChatNodeKernel` 语音录制浮层的「完成 / 取消」按钮文案改为中文，并调整波形柱宽度让 10 根柱在窄屏上不溢出。


***


## v0.7.627 (2026-09-25)

### 新增
- **Butler 助理体系落地，BobMail 通知中心退役**（改 `src/components/canvas/Sidebar.tsx`、`NodeMap.tsx`、`CanvasFlow.tsx`、`canvasHooks.ts`、`src/app/layout.tsx`、`src/lib/bus.ts`；新增 `src/components/butler/*`；删除 `src/components/canvas/WantedNoticeCenter.tsx`）：
  - 新 `ButlerHost` 挂在 `layout.tsx`，与画布挂载状态解耦（不在 4000+ 行的画布 / 收件箱组件里再叠一层 UI），统一由 `butlerEvents.ts` 的 window 事件驱动（`butler:open-today` / `open-memories` / `open-inbox` / `open-doc` / `open-calendar` / `close` / `inbox-pending` / `focus-notice`），同一事件重复触发即开关，ESC 收起。
  - 新 `ButlerOrb` 悬浮球：52px 可拖拽（`DRAG_THRESHOLD=4` 区分拖拽与点击），位置落 `localStorage['butler.orb.pos']` 并钳回视口；未读角标由 `butler:inbox-pending` 即时广播 + 120s 兜底轮询 `/api/wanted/today` 的 `snapshot.inbox.unread` 共同维护。
  - 新 `ButlerChatDialog` 把收件箱从「邮件客户端」改成「会话时间线」：通知卡片与 user / assistant 气泡混排，打开即已读但仍以 `freshIdsRef` 保留「本次新到」红点；支持待处理 / 已归档、搜索、类别 chips、批量 Done / 删除、卡片内 Done / 撤销 / 去日历，底部输入框直连 `POST /api/wanted/node-chat`（`source:'panel'`，`stripThinkTags` 剥思考块）。
  - 新增 `butlerNotices.ts`（模块级 store，上限 200 条）与 `ButlerNoticeHost`（常驻无骨架），承接原 `WantedNoticeCenter` 的全部非收件箱职责：唯一消费舱轮询 `daily-report` / `reminders`（各 30s，日历变更立即）、`bus wanted.notice` 去重（5s 窗口）→ toast / 落库 `/api/wanted/inbox` / 桌面通知，以及右上「执行中」胶囊与 `butler-event-sync` 日历反向联动。
  - 原 BobMail 入口整体撤除：删除 `useMailPending` hook、`bobmail-toggle` / `bobmail-pending(-request)` 事件、展开态标题栏与折叠态 rail 的 Mail 图标及角标、`lcd-mail-*` CSS 动画；日历联动事件 `bobmail-event-sync` 改名 `butler-event-sync`。
- **Today 首屏：只读聚合 + 至多一条建议**（新增 `src/lib/wanted/today.ts`、`src/app/api/wanted/today/route.ts`、`src/components/butler/ButlerTodayPanel.tsx`）：
  - `buildTodaySnapshot` 用 `Promise.all` 聚合今天日程 / 逾期待办 / 未读回执，单源失败落进 `degraded` 数组而不是整体报错；`buildSuggestion` 按「逾期 > 负荷 ≥5 项 > 未读 ≥5 > 今天很空」优先级短路，最多给一条，无事返回 null。
  - 面板纯只读；建议卡的「去处理」只把意图翻成一句提问（如逾期 →「帮我处理逾期事项，先列出最紧急的三条」）交给 Butler 会话，不在面板里直接动手。
- **报告落成真实文档，可在面板只读预览**（新增 `src/lib/wanted/report-doc.ts`、`src/app/api/wanted/report-doc/route.ts`、`src/components/butler/ButlerDocPanel.tsx`）：
  - `writeReportDoc` 落 `wanted/reports/YYYY-MM-DD-<kind>[-n].md`，同日同类型追加序号不覆盖；`daily-report.ts` 在写 pending 后同步调用，文档写入失败不阻断通知链路。
  - 路由做路径越界校验（resolve 后必须落在 `REPORT_DOCS_DIR` 内）、扩展名白名单（.md / .markdown / .txt）、单档 2MB 上限；面板复用画布 `viewers/registry` 渲染器，只读不回写。
- **记忆可见、可改、可删**（新增 `src/app/api/wanted/preferences/route.ts`、`src/components/butler/ButlerMemoryPanel.tsx`）：GET 列表 / PATCH 按 1-based `index` 改 content 与 type / DELETE 按序号删（拒绝批量清库），底层与工具侧同源（`wanted/preferences.md`），避免记忆分叉；删除走两步确认。
- **TTS 语音合成**（新增 `src/lib/tts/index.ts`；改 `src/lib/settings.ts`、`src/app/api/chat/tools/audio.ts`、`registry.ts`、`src/components/canvas/SettingsModal.tsx`）：
  - `synthesizeSpeech` 走 OpenAI 兼容 `POST /audio/speech`（openai `tts-1` / siliconflow fishaudio / 自定义 baseUrl），单次限 2000 字符，产物落 `wanted/tts/<时间戳>-<hash8>.<format>`；未配置时抛 `TtsNotConfiguredError`，不静默降级；apiKey / baseUrl 从 Model Pool 同名厂商继承。
  - 新工具 `text_to_speech` 与 `transcribe_audio` 同域（scene `audio`）；设置面板新增默认折叠的 Audio TTS Model 区块（TTS 候选池 + Voice / Speed 可选字段，池空即整体清空）。
- **输入框语音录制 + 微信式语音条**（改 `src/components/canvas/ChatNodeKernel.tsx`、`chatNodeKernelParts.tsx`）：
  - 用 `MediaRecorder` 录音（`audio/mp4` → m4a，`audio/webm;codecs=opus` 兜底），`AnalyserNode` RMS 驱动 10 根实时波形柱（rAF 直改 DOM 高度，避开每帧 setState）；浮层覆盖输入框含计时 / ✕取消 / ✓完成，完成后进待发附件再由 `transcribe_audio` 转写。
  - 新 `AudioVoiceBar`：微信式语音条（弧线波标 + 时长 + 未读红点，播放时弧线依次闪烁）；项目相对路径走 `/api/attachments`，绝对路径（如 TTS 产物）仍走 chip 外开。
- **应用状态只读查询 + Butler 画像升级**（新增 `src/app/api/chat/tools/console.ts`；改 `src/app/api/chat/tools/index.ts`、`registry.ts`、`src/lib/agents/profiles.ts`、`official-packages.ts`）：
  - 新增 `console` 场景与 5 个只读工具 `list_agents` / `list_projects` / `list_nodes` / `get_app_status` / `read_inbox`；硬约束「不得出现任何写 / 改 / 删」，`get_app_status` 只调 `getPluginStatuses`、不触发有副作用的 `syncServers`，且绝不回传 apiKey。
  - Butler 官方包 1.0.0 → 1.1.0，`fixedScenes` 加 `console`；`BUTLER_BASE_SYSTEM_PROMPT` 由「待办与日程管家」重写为 Chief of Staff 型调度者（先派活给 team_run / Kar / Archivist / Coding、先查后答禁编造、外部动作先确认、主动但克制），待办↔日历双轨与账本只读作为子域保留。
- **微信出站媒体协议探针**（改 `src/lib/bridge/wechat-bridge.ts`、`wechat-adapter.ts`；新增 `src/app/api/wechat/probe/route.ts`）：新增 `sendVoice` / `sendFile`（本地文件 base64 塞 `voice_item` / `file_item`，字段为推定值、注释标注待端上验证）与 `probeOutboundMedia`（向最近会话依次发「文本 → 1 秒静音 WAV → 小文本文件」三条并即时清理素材），用于验证 iLink 上行媒体协议。

### 修复与优化
- **浏览器对话栏的身份只由档位决定**（改 `src/components/hippo-browser/BrowserChatPanel.tsx`）：档位新增 `Full tools`（直接映射 `AGENT_IDS.chat`），配套取消独立 Lock 按钮 —— 原先「档位」与「解锁」两套开关会互相压制，现在只留档位一个决定者；`readMode` 兼容旧 `bobmail/unlocked` 键（等价 full，迁移后停写）；面板提示统一改走 `bridge.toast`（删掉自建 notice 状态与 2.6s 定时器）；`buildContextText` 去掉与 `ambientContext` 重复的 URL / Title，只补可读性 note、其他标签与正文；`attachPageContent` 只保留划词浮层这一个入口。
- **附件选择签名放宽**（改 `src/components/canvas/composer/useComposer.ts`）：`handleFileSelect` 参数由 `FileList | null` 放宽为 `FileList | File[] | null`，录音 Blob 得以以 `File[]` 传入。
- **通知链路文案统一到 Butler 收件箱**（改 `src/lib/wanted/daily-report.ts`、`executor.ts`、`inspect.ts`、`chat-session.ts`、`node-chat.ts`、`node-mode.ts`、`meeting-session.ts`、`commands.ts`、`inbox.ts`、`src/app/api/wanted/inbox/route.ts`、`src/lib/bridge/wechat-bridge.ts`、`src/lib/bus.ts`）：把残留的「BobMail 邮件 / 通知中心」措辞全部改写为「Butler 收件箱 / 回执」（含微信推送文案与命令描述），纯文案级改动，不含逻辑变更。

### 界面细节
- 设置面板快捷键说明中的 `(BobMail)` 改为 `(Butler inbox)`；新增 TTS 区块默认折叠（`rolesCollapsed.tts`）。
- 画布 `CanvasFlow` 新增 `butler:open-calendar` 监听，供 Butler 对话框的 Calendar 动作跨宿主唤起日历面板。
- `ScreenOcrEditor` 浮层注释改为「高于 Butler 对话框」（zIndex 不变）。


***


## v0.7.626 (2026-09-24)

### 新增
- **网页材料改存「渲染后的整页 HTML 原件」，研究工作流可把结论与已读正文一并沉淀**
  （改 `src/lib/materials/link-import.ts`、`src/lib/materials/indexer.ts`、
  `src/app/api/materials/route.ts`、`src/components/canvas/Sidebar.tsx`；新增
  `src/lib/materials/html-text.ts`、`src/lib/materials/source-url.ts`）：
  - 抓取链路（Add link / Hippo 一键保存当前页）不再落一份「已成正文的 .md 副本」，改为落盘
    **渲染后的整页 HTML 原件**：原件可离线打开、可回溯，出处写在文件头注释里（浏览器解析时直接跳过、
    人读时一眼可见），正文由索引链路现场抽取。原件即唯一真相源，不再有「原件与正文两份、
    版次可能漂移」的问题。抓取优先级不变（Hippo 真实浏览器优先，桥不可用回落服务端直抓静态 HTML）。
  - 新增 `html-text.ts`：HTML → 标题 / 正文 / 出处 的纯函数（正则预剥噪声 → 取 `<article>`/`<main>` →
    turndown 转 Markdown）。**单独成文件是为了让服务端索引也能用** —— 索引链路不该被拖进浏览器侧依赖。
  - 来源 URL 归一化抽出共用实现 `source-url.ts`：候选来源清单的「去重」与正文里的「链接匹配」
    共用同一份规则。两处各写一份，规则一漂移就会出现「清单里有、正文里同一链接却匹配不上」的静默失效。
- **Research 档来源卡片升级：「研究结论」与「读过的网页」同卡、同勾选、同导入**
  （改 `src/components/canvas/ChatNodeKernel.tsx`、`src/app/api/chat/route.ts`）：
  - 候选行不再只来自「调用参数里的 URL」：新增从**工具返回原文**解析 URL / 标题 / 正文，
    行内给首段摘要、可展开看本轮读到的全文；同一页面先 navigate 后 read 按 URL 合并、后到的信息补齐。
    只认两种信封（内置工具文本信封、MCP JSON 返回体），对不上就不认 —— 宁可不认，也不猜。
  - 卡片首行是本轮**研究结论**（模型综述，属派生材料）：落盘为 .md，文件头标注
    `Derived: model-written synthesis, not a primary source`，并列出结论所依据的来源 URL，
    日后回溯能看清「这条结论是从哪几页推出来的」。
  - 网页行带「本轮已读到的正文」：导入时**直接落盘复用**，入库版本与回答里的引用必然同版
    （NotebookLM 口径）；正文缺失或太短才回落抓取链路。此类文件头标注
    `Captured: text read by the agent during research (not a re-fetched snapshot)`，不与真原件混淆。
  - 正文里「本轮真读过」的页面链接标成绿色胶囊（带 ✓），悬停弹出标题 / 域名 / 首段摘要；
    只 navigate 打开过、没读正文的页面不标注 —— 与「搜索页摘要不算读过」同一条纪律。
  - Research 档答复改为**六节综述骨架**（研究问题 → 检索范围 → 主题综合 → 争议与不一致 →
    缺口 → 结论与下一步建议），一级标题 `# <主题>` 作报告文件名；同时该档不再注入「报告交付物」
    约定，避免两套指引把答复推向 `homework/` 交付物口吻。
- **Hippo Browser：整页快照归档模式 + 指定标签读取**（改 `electron/hippo-cdp.ts`、
  `electron/hippo-browser.ts`、`src/lib/browser-tools/specs.ts`）：
  - `browser_get_html` 新增 `clean=true`：在页内一次洗净 —— 剥 script/noscript/iframe/template 与注释、
    去 `on*` 内联事件与 `javascript:` 链接、把 src/href/srcset/poster/form[action]/style `url()` 绝对化、
    `data-src*` 懒加载属性提升为真实属性。必须在页内做：只有活在文档里的 DOM 才拿得到 `<base>`
    参与解析后的绝对地址，也只有活 DOM 上的懒加载属性还没被浏览器覆盖。
  - `browser_get_html` / `browser_wait_network_idle` 新增 `tabId`：可读 / 等**指定标签**，
    后台抓页不必把用户的当前标签切走（旧实现栽在这里：后台新开 + 读活动标签，永远读不到刚开的那一页）。
  - `browser_open_tab` 传 `activate:false` 时连窗口都不再抬到前台，「不抢焦点」名副其实；
    快照字符上限由 100000 提到 4000000（原默认 20000 会把原件截成残页）。

### 修复与优化
- **账本文稿面板：正文里的项目路径可点开原件**（改 `src/components/canvas/LedgerDocPanel.tsx`、
  `src/components/canvas/HtmlRenderer.tsx`）：
  - 对话正文的 `.file-mention` 路径正则纳入 `materials/` —— 账本条目的「出处」都落在原件层，
    必须一并可点，否则档案员引用的路径点了没反应；同时排除 `[]` 与 `#`，
    账本引用标记 `[来源: 材料:materials/x.pdf#p3]` 不再被吃掉尾巴、点成一个不存在的文件。
  - 账本文稿面板新增 remark 插件，把正文里的 `materials/…` / `homework/…` 包成同款胶囊，
    点击用系统默认程序打开（只动纯文本节点，代码块 / 行内代码 / 既有链接天然不受影响）。
- **浏览器读取判重不再误伤「交互后的重读」**（改 `src/app/api/chat/route.ts`）：同一 URL 但中间发生过
  页面交互（点击 / 切 tab / 脚本改 DOM）时，URL 指纹抓不到这种变化，上一次的读取结果其实已失效；
  旧逻辑按 2 次封顶会回灌「请基于已有结果回答」，等于逼模型用陈旧内容。改为放宽到 6 次
  （保留硬顶，防「读-滚-读」原地打转）；失败的操作没改变页面，不计入。

### 界面细节
- Usage 面板日粒度柱状图悬停显示当日 tokens 与估算金额（原先只有原生 title 提示）。
- 项目图标墙底色从「按 id 哈希出色相」改为「按分类取色」（诉讼绿 / 常法蓝 / 非诉青 / 破产紫 / 研究琥珀），
  同类项目同色便于成组识别；刻意避开红色系 —— 红留给 todo 角标与开庭临近等预警信号。


***


## v0.7.625 (2026-09-24)

### 修复与优化
- **机器指纹加固：Apple Silicon 上改用 IOPlatformUUID，凭据密文不再因主机名变动而失效**
  （改 `src/lib/secrets.ts`、`src/lib/settings-server.ts`）：
  - 旧实现 macOS 侧取 `sysctl -n hw.uuid` 作密钥指纹，但 Apple Silicon 上该命令已返回 `unknown oid`，
    于是静默退化成「主机名 + 用户名」派生——主机名一变（DHCP 把 HostName 写成 IP、或用户改名），
    已加密的 API Key / Token 立刻全部解不开。新增 `hardwareFingerprints()`：
    macOS 优先 `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice` 解析 `IOPlatformUUID`（跨重启、跨网络稳定），
    `hw.uuid` 候选保留供 Intel 机器使用（同值去重）；Linux 仍读 `/etc/machine-id`。
    新增 `tryExec()` 统一吞掉命令失败（该候选取不到就跳过，不影响其它候选）。
  - 兼容与透明迁移：新增 `legacyFingerprints()` 保留历史「host + user」派生（含 macOS
    `scutil --get LocalHostName` 的 `<name>.local` 与短名两种形态），**仅用于解密回退**；
    `getKeys()` 首个候选为主密钥（用于加密），其余只作回退。新增 `isLegacyCiphertext()` / `hasLegacySecrets()`，
    读取设置时若发现「主指纹解不开、历史指纹能解开」的密文，与明文老数据一样顺手回写成主指纹加密版（用户无感）。


***

## v0.7.624 (2026-09-24)

### 新增
- **Hippo 对话栏 Research 档「来源清单」卡片**（改 `src/components/canvas/ChatNodeKernel.tsx`、
  `src/app/api/chat/route.ts`）：研究档答复下方自动列出**本轮真实读过的网页**，用户勾选后一键导入当前项目。
  - 来源取自工具调用参数而非模型自述：`RESEARCH_URL_TOOLS` 白名单（`browser_navigate` / `browser_open_tab` /
    `web_fetch` 及 `mcp__bob-browser-mcp__` 两个同名工具），失败调用（`success === false`）不计入；
    `normalizeSourceUrl` 归一化（仅 http(s)、去 hash、去 `utm_*` / `fbclid` / `gclid` / `spm` / `ref` / `share_` / `from`
    等跟踪参数、去尾斜杠），按归一化 URL 去重后**上限 30 条**；`RESEARCH_SKIP_HOSTS` 剔除搜索引擎宿主
    （google / bing / baidu / duckduckgo / sogou / so / yandex / search.brave / startpage / search.yahoo / ecosia）。
  - 仅当消息已完成且 `identity === 'browser-research'` 时渲染（画布节点与其他档位恒为空数组）；
    `ResearchSource` 以「去 `www.` 域名 + 路径尾段」为行内标签，完整 URL 走 `title` 悬浮。
  - `handleImport()` 串行逐条 `POST /api/materials {action:'add_link'}`（失败项汇总重试），已导入状态按节点存
    `localStorage` 键 `bob-research-imported:{nodeId}`，避免重复导入。
  - 文案：`Sources Read · N` / `Sources Imported · N` / `Importing p/t...` / `N of M saved to materials/ ·
    indexed automatically.` / `Import N source(s)` / `Nothing selected.` /
    `Uncheck anything you don't want in the project.`。
  - 研究提示词同步补三条纪律：取证必须真的打开页面（搜索页摘要不算读过）、引用一律给完整可点击 URL 且与实际
    打开地址一致、**不要在答复里另抄一份来源列表**（清单由宿主生成）。
- **项目分类新增「研究」**（改 `src/lib/types.ts`）：`PROJECT_CATEGORIES` 由
  `['诉讼','常法','非诉','破产','其他']` 扩为 `['诉讼','常法','非诉','破产','研究','其他']`。
  服务端 `src/app/api/projects/route.ts` 的分类白名单与本常量同源，自动放行，无需另改。
- **materials 预设标签改为材料属性口径**（改 `src/components/canvas/Sidebar.tsx`）：`DEFAULT_MATERIAL_TAGS`
  由 `['原告','被告','法院']`（当事人/机关口径）改为 `['原始材料','证据材料','参考资料','参考判例','法律依据']`
  （材料类型口径），标签筛选条与文件标签面板的候选预设同步更新。
- **Hippo 工具栏「收藏当前页」三去向浮层**（改 `electron/hippo-browser.ts` / `electron/preload.ts`）：
  收藏入口从渲染侧聊天面板迁到浏览器工具栏，由主进程承载。
  - 地址框内新增收藏按钮 `#clip`（`.addrClip`，位于星标 `#bm` 左侧；新建标签页 / 空地址时 `disabled`），
    点击经 `BAPI.saveMenu({ right })` 由主进程在按钮下方弹出无边框、`parent` 绑定、`alwaysOnTop` 的
    独立浮层子窗口（`SAVEMENU_W = 264`、`SAVEMENU_H = 178`、`data:text/html` 内联页），失焦即关、再次点击即 toggle。
  - 三个去向（与旧版逐字一致）：`Current project` / `Bob Notes` / `Bob Notes (compile now)`，
    分别走 `savePageToBobWork(target)` → `POST /api/materials {action:'save_page'}`（`notes-compiled` 归一为
    `target:'notes', compile:true`，服务端自己读当前标签，不重复抓取）。
  - 结果经 `hippo-browser:menu-cmd` 的 `saveMsg:` 前缀回传工具栏，由新增 `showToast()`（`.toast`，2.6s 自动消失、
    不拦截点击）提示：`Saving the current page…` / `Saved to materials: …` /
    `Clipped to Bob Notes (not compiled): …` / `Clipped to Bob Notes, compiling in background: …` /
    `Failed to save the page`。
  - 新增 IPC `hippo-browser:save-menu` / `hippo-browser:save-page`，preload 侧 `HippoBrowserApi` 对应新增
    `saveMenu(payload: { right: number })` / `savePage(target: string)`；`menu-exec` 同步 `closeSaveMenu()` 与
    工具菜单互斥，主窗口 `closed` 时置空 `saveMenuWin` 防悬垂。

### 修复与优化
- **收藏入口从聊天面板迁出**（改 `src/components/hippo-browser/BrowserChatPanel.tsx`，净 −133 行）：
  删除 `SaveMenu` 组件、`SaveTarget` 类型、`BookmarkPlus` 图标、`onSavePage` / `savingPage` props 与
  `savePageTo` 回调；三去向文案与请求体原样保留，只是执行位置改到主进程（见上）。工具栏 props 回归精简。
- **便签不再「停手 8 秒」自动结算**（改 `src/components/canvas/StickyTodoDock.tsx`）：删掉 `settleTimerRef` /
  `clearSettleTimer()` 及 `debounceNote` 里的 8 秒兜底定时器 —— 结算时机收敛为「离开这一行（失焦）」与
  「关闭便签卡」两处，不再有「编辑到一半被自动入日历」。同时修两类刷新覆盖：新增 `selfRefreshAtRef` +
  `broadcastRefresh()`，本组件自身广播后在 **1200ms** 内跳过 `sticky-notes-changed` 的整表重载（避免覆盖
  正在编辑的行、丢焦点）；`calendar-events-changed` 改为 `reload({ anchorsOnly: true })`，只按 `pageId`
  合入服务端行级锚点（`lineEventIds` / `lineCalendared`），不再用服务端内容整表替换本地 `pages`
  （会抹掉未落盘的空行与字符），别处新建的便签仍会并入。
- **项目看板筛选条重构**（改 `src/components/canvas/ProjectBoardView.tsx`）：分类与标签拆成两组 ——
  分类保留平铺胶囊并新增小标题 `Category`（`Default tag (category)` 提示与 `名称 数量` 文本不变），
  自定义标签收进 `<select>` 下拉（小标题 `Tags`，首项 `All tags`，选项文本改为 `名称 (数量)` 带计数），
  解决标签多时横向堆满的问题。筛选状态 `catFilter` / `tagFilter`、`Clear` 与聚合联动逻辑均未变；
  容器间距由单一 `gap-1` 改为 `gap-x-3 gap-y-2`。


***


## v0.7.623 (2026-09-24)

### 新增
- **网页链接一键入料 materials**（新增 `src/lib/materials/link-import.ts`；改 `src/app/api/materials/route.ts`、
  `src/components/canvas/Sidebar.tsx`）：
  - 新增 `add_link` action：`url` 为空回 400 `url is required`，抓取失败回 502，落盘后异步建索引。
  - 抓取走两级：`fetchDirect` 直连（Chrome UA、`AbortSignal.timeout(15000)`、turndown 剥 script/style/svg/nav/footer、
    优先 `article`/`main`）→ 失败、正文不足 `MIN_DIRECT_CHARS = 400` 字或非 HTML（如 PDF 二进制）再回落
    `fetchViaHippo`（后台开标签 `activate:false` → `browser_wait_network_idle` → `browser_read_article`，
    仍不足则 `browser_extract_text`，`kind === 'pdf'` 再走 `browser_read_pdf`，`finally` 按 id 关标签）。
  - 上限 `MAX_CHARS = 60000`、文件名主干 `MAX_STEM = 80`；仅 http(s)（缺协议自动补 `https://`）；
    落成 `.md`，正文头写 `# 标题` + `> Source: …` + `> Retrieved: YYYY-MM-DD`；同名追加 `" (1)"`；
    `folder` 剥 `..` 并拒绝越界。**不做内容去重**，只按文件名冲突去重。
  - 侧边栏材料菜单新增 `Add link`（含 `Fetching…` / `Cancel`，成功 Toast `Imported: "…"` 或
    `Imported via Hippo Browser: "…"`，失败 `Failed to import the link`）。
- **Hippo 页面一键收藏到项目或 Bob Notes**（改 `src/components/hippo-browser/BrowserChatPanel.tsx`、
  `src/app/api/materials/route.ts`）：工具栏新增书签按钮（`BookmarkPlus`）与 `SaveMenu`
  （`SaveTarget = 'project' | 'notes' | 'notes-compiled'`），菜单项为 `Current project` / `Bob Notes` /
  `Bob Notes (compile now)`。走新增 `save_page` action：存项目即 `saveCurrentHippoPage()`；
  存 Notes 走 `readCurrentHippoPage()` + `callNotes('add_raw', …)`（单条按 `RAW_NOTES_MAX_CHARS = 20000` 截断并追加
  `> …(truncated: …)`），选 `compile` 时后台 `callNotes('ingest', …)` —— 不阻塞返回、失败仅 `console.warn`。
  Toast：`Saved to materials: …` / `Clipped to Bob Notes (not compiled): …` /
  `Clipped to Bob Notes, compiling in background: …`。
- **Bob Notes 收件箱取回链接 + homework 提升为 materials**（改 `src/app/api/materials/route.ts`、
  `src/components/canvas/Sidebar.tsx`）：
  - `open_in_hippo` action：正则校验 http(s)（否则 400 `A http(s) URL is required`），
    `browser_open_tab{activate:true}` 在 Hippo 打开，失败回 502 `Hippo Browser is not available` 并带 `hint`。
    侧边栏 `Open from Bob Notes` 弹层拉 `POST /api/notebook {action:'raw_list', status:'all'}`，
    支持按标题/来源/预览前端过滤（`Search the inbox…` / `No match.` / `The Bob Notes inbox is empty.`）；
    无来源链接的条目显式标注 `no source link` 并禁用打开。
  - `promote` action：把 `homework/` 产出提升为材料（`from` 必填 400、路径越界 403 `Invalid path`、
    文件不存在 404 `Not found`；同名追加 `" (1)"`）。`copy === true` 用 `fs.cp` 保留原件，否则 `fs.rename`
    移出工作区；移动时同步清 `removeHomeworkOwnershipPaths` 与 `removeFileTags(..., 'homework', …)`。
    行菜单新增 `Move to materials` / `Copy to materials`，并新增 `indexPromotedMaterials()`
    绕过「每会话只扫一次」的索引守卫，对提升后的目录递归补索引。两个弹层均以 `linkBusy` / `notesOpeningId`
    防重复提交，Esc 与点击遮罩可关闭（忙碌时禁止）。
- **项目账本研究取向（`concept` / `claim` / `evidence` / `timeline` / `method`）**（改 `src/lib/mcp/ledger.ts`、
  `src/app/api/chat/tools/ledger.ts`、`src/lib/mcp/ledger-compile.ts`、`src/lib/agents/profiles.ts`）：
  - 新增 5 个声明式条目类型 `LEDGER_RESEARCH_TYPES`，写入 SCHEMA 种子段，并由 `migrateResearchTypeLines`
    在 `ensureLedger` 时按行补齐存量库（只增不删）。
  - 新增 `ClaimStatus`（`open` / `supported` / `refuted` / `unclear`，缺省 `open`）与
    `EvidencePoints`（`supports` / `refutes`）；条目落盘键为 `status` / `claim` / `points`，
    `recordLedgerEntry` 按类型校验（`status` 仅 `claim`、`claim` / `points` 仅 `evidence`，`claim` 须 `w-…`），
    非法即忽略并回 warning；原单条 `warning` 改为 `warnings[]` 并以 `；` 拼接。
  - `ledger_lint` 新增三类检查：孤儿证据卡、论断仅单侧证据、论断停在 `open` 超
    `CLAIM_OPEN_STALE_DAYS = 30` 天；索引与正文行补 `· {claimStatus}` 状态展示。
- **账本宪章写入工具 `ledger_schema`**（改 `src/app/api/chat/tools/ledger.ts`、`src/app/api/chat/tools/index.ts`、
  `src/app/api/chat/tools/registry.ts`、`src/lib/mcp/ledger.ts`）：
  档案员（场景 `ledger-keeper`）新增 `ledger_schema`（`action`：`read` / `set_parties` / `add_types` / `append`）。
  底层配套三个 SCHEMA 原子写 API（`writeSchemaAtomic`）：`writeLedgerParties`（整表替换当事人分区，
  `side` 仅接受 `ours` / `theirs` / `neutral`，传 `[]` 即清空并关闭分侧检查）、`addLedgerTypes`、
  `appendLedgerClause`（追加「补充条款」）。后台编译禁令同步新增 `claim`（不得写 `issue` / `analysis` / `claim`）；
  档案员提示词补入新类型与「改宪章须用户明确要求/确认」约束。

### 修复与优化
- **Hippo 下载面板改为独立浮层子窗口**（改 `electron/hippo-browser.ts` / `electron/preload.ts`）：
  此前下载列表挤在网页视图内，展开还要抬高工具栏让位。现改为无边框、不可缩放、`parent` 主窗口、
  `setAlwaysOnTop(true, 'floating')` 的独立面板窗（`openDownloadsPanel` / `closeDownloadsPanel` /
  `toggleDownloadsPanel`，新增 IPC `hippo-browser:downloads-panel` / `-close` / `-size`，preload 对应
  `downloadsPanel()` / `downloadsPanelSize()` / `downloadsPanelClose()`）。面板按内容自然高度自适应
  （`DL_PANEL_WIDTH = 340`、`DL_LIST_MAX_H = 320`，`reportSize()` 用 `lastNeedH` 去重上报避免高度回环）。
  打开前先 `closeToolMenu()` 与工具菜单浮层互斥、失焦即收起；`toggle` 用 `dlBlurClosedAt` 的 400ms 窗口
  防止「点按钮先失焦」导致的弹回。工具栏按钮收敛为角标 `renderDlBadge()`，旧的 `.dlPanel` 结构与
  `renderDownloads()` / `setDlPanel()` 及「面板展开抬高 chrome」的让位逻辑一并删除。
- **XHS 卡片分页逻辑抽为独立模块**（新增 `src/components/canvas/xhsPagination.ts` 与
  `src/components/canvas/__tests__/xhs-pagination.test.ts`；改 `src/components/canvas/XhsCard.tsx`）：
  `mdToLines` / `extractCoverItems` / `blockText` / `fitPrefix` / `parseMdTable` / `isPipeRow` /
  `splitBodyToBlocks` / `paginateBlocks` 与类型 `XhsBodyBlock` / `XhsPageData` 抽离，测量回调由调用方注入
  （生产用离屏 DOM 测量），纯函数部分首次可单测（6 组用例锁定契约）。**顺带修复**：`mdToLines` 中图片规则
  提前到链接规则之前 —— 否则 `![alt](url)` 的 `[alt](url)` 部分先被链接规则替换，图片会残留一个 `!`。
- **ChatNodeKernel 模块化拆分**（新增 `src/components/canvas/chatNodeKernelUtils.ts` /
  `src/components/canvas/chatNodeKernelParts.tsx`；改 `src/components/canvas/ChatNodeKernel.tsx`）：
  内核由 391KB 降到 347KB。纯函数与常量（`parseThink`、`isErrorReply`、`isNetworkLevelError`、
  `fetchWithServerRecovery`、`buildTurnReferences`、`stripReferenceMarkers`、`deriveInstantTitle`、
  `formatDuration`、`SYSTEM_PROMPT`、`THINKING_LEVEL_*` 等）移入 `chatNodeKernelUtils`；无状态子组件
  （`MessagesErrorBoundary`、`AttachmentChips`、`ReferenceChips`、`StepTypeIcon`、`TraceProcessSummary`、
  `TaskStepsPanel`）移入 `chatNodeKernelParts`。**零行为变更**，纯为后续维护与复用。
- **清理 PDF 死代码**（删 `src/lib/pdf/` 下 14 个文件；改 `src/lib/pdf/shared/types.ts`）：移除 `index.ts`、
  `plugin-config.ts`、`crop_regions.swift`、`ocr_vision.swift`、`pdf_to_images.py`、`shared/money.ts`、
  `core/{key-fields,ledger,segment-scheduler,structural-postprocess}.ts` 以及整个 `statement/`
  （`cell-verification` / `control-rows` / `index` / `semantics`）。`StatementRowKind` 由从
  `../statement/control-rows` 导入改为在 `shared/types.ts` 就地内联（8 个值不变）。


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
