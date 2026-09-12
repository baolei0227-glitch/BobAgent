# BobWork 主应用（projects/）架构梳理与优化建议

> 范围：`/Users/baolei/Desktop/BobWork/projects/`（Next.js 16 + Electron 43 + React 19 桌面应用）
> 梳理时间：2026-09-12
> 说明：本文件是对工作区根目录《架构优化评估报告.md》（2026-08-24）的**刷新与深化**——重点校正其已过时结论，并给出可落地的优化动作。

---

## 一、执行概要

主应用的核心设计（画布式节点 UI、单焦点宿主、BOBWORK_HOME/iCloud 隔离、MCP plugin-kernel 状态机）仍属合理。但自 2026-08 以来，**巨型文件问题在恶化而非收敛**，且编译超时根因未消除（仅以启动期 `fetch('/api/chat')` 预热 hack 掩盖）。当前最大瓶颈有两点：

1. **`/api/chat` 超重依赖锥** → dev 首次编译超时，被迫加预热 hack。
2. **`CanvasFlowInner` 4600 行 god component** → 40+ `useState`/`useRef`，节点状态即组件 `useState`，任意变更触发整树重渲染。

两者叠加，是开发效率与运行性能的首要结构性风险。

---

## 二、与旧版评估报告（2026-08-24）的关键差异

| 旧报告结论 | 当前核实 | 结论 |
|---|---|---|
| 前端“基于 `@xyflow/react` 画布式 UI” | 2026-09 重构已**移除 ReactFlow**，改为宿主自绘单焦点（world 层绝对定位 + `node-host.ts`） | **报告已过时，须修正** |
| 死依赖 `pg`/`@supabase`/`drizzle-orm` 零引用 | 在 `projects/package.json` 中**已不存在**（精确 grep 确认无声明、src 无 import） | P0-2 在主应用已不成立 |
| `types.ts` 56KB/1381 行 | 现已拆为 `src/types/`（仅 `global.d.ts` 1.4KB），巨型类型文件消失 | 已部分治理，正面进展 |
| ChatNodeKernel 7070 行 / tools 5467 / route 3545 / CanvasFlow 4307 | **8157 / 7965 / 4759 / 5567**（持续增长 15%~45%） | 巨型文件问题**在恶化** |
| electron/main.ts 1737 行 | 现已 **2608** 行 | 主进程也在膨胀 |

> 关键信号：巨型文件自 8 月以来仍在增长，说明"拆文件"尚未真正推行，仅靠预热 hack 与局部抽离（canvasUtils / canvasHooks）止血。

---

## 三、整体架构地图

```
┌──────────────────────────────────────────────────────────────┐
│ Electron 主进程  main.ts (2608 行)                              │
│  · 拉起 Next.js standalone 子进程 / 看门狗 / 单实例锁          │
│  · 截图：screencapture + Swift Vision OCR + TCC 权限           │
│  · 密钥派生：sysctl -n hw.uuid（macOS 专属）                   │
└───────────────────────────┬──────────────────────────────────┘
                            │  BrowserWindow (localhost:8321)
┌───────────────────────────▼──────────────────────────────────┐
│ Next.js 16 App Router  (React 19)                              │
│  page.tsx ──▶ CanvasFlow.tsx (5567 行)                         │
│                  └─ CanvasFlowInner()  god component (~4600)   │
│                       ├─ 节点图：useState(nodes/edges) + refs  │
│                       ├─ 30+ useState / 45+ useEffect         │
│                       ├─ node-host.ts：NodeHostContext          │
│                       │    (useSyncExternalStore 订阅)         │
│                       ├─ graph-gateway.ts：另一套快照 store     │
│                       └─ 子组件：ChatNodeKernel(8157)/DocEditor │
│                                  /WantedNotice/XhsCard/...     │
└───────────────────────────┬──────────────────────────────────┘
        ┌────────────────────┼─────────────────────┬───────────────┐
        ▼                    ▼                     ▼               ▼
  83 个 API 路由         lib/ 33 个子系统      instrumentation   MCP 服务
  (~19K 行，/api/chat    (pdf/wanted/sandbox/  .ts 启动 10+      (bob-ocr / browser /
   4759 行独占)           parse/trajectory/     后台调度器)        docx-template …)
                           mcp/skills/…)          │ 含 fetch 预热 hack
                                                  ▼
                                          better-sqlite3
                                          (每项目 .project.db +
                                           全局模板/日历/收件箱)
```

**状态管理现状（不一致，是核心问题）**
- 节点图：`CanvasFlowInner` 内 `useState<Node[]>` + `useRef` 镜像（nodesRef/edgesRef），节点变更经 `setNodes` 触发整树重渲染。
- 画布订阅：`node-host.ts` 提供 `NodeHostContext`，节点组件用 `useSyncExternalStore` 订阅。
- 关系图：`graph-gateway.ts` 另起一套 `useSyncExternalStore` 快照。
- 全局 store 库（zustand/redux）**零使用**。→ 同一概念（图状态）存在两套订阅机制，且无单一真源。

**后台调度器（instrumentation.ts）**：启动即拉起 10+ 调度器（会话清扫、日报、日历提醒、缓存清理、便签迁移、旧画布清理、微信桥、磁盘监听、Python 包清理），每个都是独立 `setTimeout` + `try/catch` 吞错，无统一生命周期。

---

## 四、优化建议（按优先级）

### P0-A　拆分 `/api/chat` 依赖锥（消除编译超时根因）
**根因**：`route.ts`(4759) → `tools.ts`(7965) → `types`/`openai`/`@modelcontextprotocol/sdk`/`better-sqlite3`。dev 按需编译该锥体超过 Next 默认超时，于是 `instrumentation.ts:86-101` 在启动期 `fetch('/api/chat')` 强制预编译——这是止血不是治疗。

动作：
1. **`tools.ts` 按 ToolScene 拆分**：现有 `ToolDefinition` 接口 + `toApiFormat(activeScenes)` 已具备场景过滤雏形。拆为 `lib/chat/tools/{fs,web,ocr,skills,mcp-bridge}.ts` 各自 `export const toolDefs`，`index.ts` 聚合。Next 可按场景分块编译。
2. **`route.ts` 抽出编排纯函数**：工具循环、停滞检测、声明校验移至 `lib/chat/orchestration.ts`，route 仅做请求解析 + SSE 流式。
3. **重依赖延迟加载**：`openai`/`@modelcontextprotocol/sdk` 在工具执行路径内用动态 `import()`，缩小 `/api/chat` 首编模块图。
4. **拆分完成后移除预热 hack**（或降级为可关闭的环境兜底）。

收益：dev 首编不再超时，合并冲突面下降，热更新更快。风险：中（需回归 SSE 与工具调用）。

### P0-B　解耦 `CanvasFlowInner` 的图状态（消除重渲染风暴）
**根因**：节点图是 god component 的 `useState`，每次插入/移动/更新节点都 `setNodes` → 重渲染 4600 行组件及其全部子树。

动作（与既有 Phase A/C 抽离衔接）：
1. **把节点图提升为外部 store**：`node-host.ts` 已定义 store API（`updateNodes`/`subscribe`），但当前实现仍回写组件 `useState`。改为独立模块级 store（tiny zustand 或手写 `useSyncExternalStore` store），`CanvasFlowInner` 通过 selector 订阅切片，节点更新不再触发宿主整树重渲染。
2. **续推 Phase B（已 DEFERRED）**：将 `MainNav`（左栏）、`RightDock`（右面板）、`CanvasStage`（world 层）抽为独立组件，复用已定义的 `PANEL_W_*`/`NAV_W_*` 边界常量。
3. **续推 Phase C 剩余簇**：把 30+ `useEffect` 按归属（conversation / panels / viewport 广播 / plugin 注册表）收口为自定义 Hook——已抽 `useStarredApps`/`useMailPending`/`useUpdateStatus`/`usePluginPanels`，应推广此模式。

收益：运行性能、可测试性、合并冲突同步改善。风险：中（需 `pnpm dev` 端上目视验证，本环境仅能 tsc 校验）。

### P1-A　统一状态管理真源
- 图状态 → 外部 store（见 P0-B）。
- 会话/消息 → 独立 store 或 context（目前大概率散在 `ChatNodeKernel` 8157 行内）。
- UI chrome（面板宽度等）→ 保留局部 `useState`。
- 建议引入 **zustand**（仅数 KB，且代码已惯用 `useSyncExternalStore` 习惯，迁移成本低），避免自建多套订阅机制。

### P1-B　数据层版本化与类型化（lib/db/index.ts 1261 行）
- 引入 `PRAGMA user_version` 迁移机制，杜绝 `ALTER TABLE ADD COLUMN` 探测式 schema 漂移。
- 抽取共享 schema 常量（`initDb` 与 `CALENDAR_SCHEMA_SQL` 两处重复需合并）。
- 消除 `db: any`：用 `@types/better-sqlite3` 为查询补 Row 类型与 mapper。
- 评估"会话元数据 SQLite + 消息体 JSONL 文件"混合存储是否需统一边界。

### P1-C　后台调度器统一化（instrumentation.ts）
- 引入 `WorkerRegistry`：`register(name, fn, {interval|cron|delay})`，统一 `start/stop`、健康检查、单一错误边界。
- 启动配置化为数组，便于测试与按需禁用。

### P1-D　MCP 集成三模式收敛
- 现状：SDK 插件（manager + plugin-kernel 状态机，质量高）/ 裸 fetch（ocr-client 手写 JSON-RPC+SSE+退避，重复 manager 逻辑）/ exec python3（docx-template 绕过协议）。
- 建议：`ocr-client` 复用 manager 传输层或并入 plugin-kernel；docx-template 对内降级为"脚本+模板库"依赖。

### P2-A　平台耦合隔离（macOS 专属）
- 专属点：`sips` 图标生成、`codesign`、`launchd` plist、密钥 `sysctl -n hw.uuid`、端口检查 `lsof`、`screencapture`+TCC、构建脚本全 `bash VAR=value`。当前 `electron-builder` 仅 mac target（dmg/zip）。
- 若需跨平台：把平台相关操作抽象到 `lib/platform/`（如 `getMachineId()` 替代 `sysctl`、图标用 `sharp` 替代 `sips`、权限走 Electron API）；增加 win/linux 构建矩阵。
- 即便维持 macOS-only，隔离适配器也能提升可测试性、避免"换系统全崩"断崖。

### P2-B　依赖与类型卫生
- 精确 grep 确认 `pg`/`@supabase`/`drizzle` 在主应用已无残留（旧报告 P0-2 已不成立）。
- `tools.ts` 自 8 月增长 45%，拆分紧迫度上升；建议纳入本季度必做。
- `CanvasFlow.tsx` 顶层 import 60+ 符号/50+ 组件，建议按 feature 桶文件收敛。

---

## 五、落地路线图（建议节奏）

| 阶段 | 内容 | 收益 | 风险 |
|---|---|---|---|
| 立即 | P0-A 拆分 tools.ts + route.ts 编排层；完成后摘掉预热 hack | 根治编译超时 | 中 |
| 近期 | P0-B 图状态外提为 store + 续推 Phase B/C 组件/Hook 抽离 | 消除重渲染、可测试 | 中 |
| 中期 | P1-A 状态统一 / P1-B 数据层版本化 / P1-C 调度器统一 / P1-D MCP 收敛 | 稳定性与可维护性 | 中 |
| 远期 | P2-A 平台隔离 / P2-B 依赖卫生持续治理 | 可移植性、长期健康 | 低 |

---

## 六、风险与权衡

- **P0-A/B 是高价值高风险的协调式重构**，本环境只能 `tsc` 校验，必须端上 `pnpm dev` 目视验证后再判定（符合你"端上先跑诊断再下结论"的惯例）。
- **不要一次性大改**：按既有 Phase A/C 已验证的"先抽纯函数/Hook、零行为变更"路径小步推进，每步 tsc 绿 + 端上目视。
- **预热 hack 是症状不是病**：拆锥完成前保留它，避免微信端 `/chat` 首问失败；但应标注 TODO，防止被误当成"已解决"。
