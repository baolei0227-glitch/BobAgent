# DSH 替换 BobWork 对话运行时 — 架构差距分析与迁移方案

- 日期：2026-09-07
- 状态：**待评审**（未动任何代码）
- 范围：BobWork 对话运行时（`src/app/api/chat/route.ts` 单体内核 + 前端 `ChatNodeKernel.tsx`）与官方 DeepSeek Harness（下称 **DSH**）的架构差距、替换路径与决策点
- 前提事实：本盘点均基于只读检索与官方文档快照，未做任何代码修改

---

## 0. 摘要（给评审的一句话版）

DSH 与 BobWork 是**两种底座的对话运行时**，且官方 DSH 并无"按任务自动选模型 / thinking_mode 档位"机制——那是 BobWork 自研。因此"完全替换"不应理解为把 DSH 运行时整体搬进 BobWork（技术栈冲突、DSH 尚 pre-stable），而应理解为：**把 BobWork 对话内核从"单体内核 + 内嵌自研策略"重构为 DSH 语义的"事件溯源会话 + 可替换 agent-loop + scope 分层服务"，并把自动模型路由与思考档位从内核内嵌降级为 BobWork 业务插件。** 本文档给出逐层差距矩阵与五阶段迁移路线，末尾列 6 个待拍板决策点。

---

## 1. 事实基线 A — 官方 DSH 方案要点（master 快照，v0.1.x）

> 来源：官方 GitHub docs（`docs/architecture.md`、`docs/subsystems/*.md`、各 package README）。DSH 于 2026-08-13 开源，文档随版本快速演进，以下仅列"文档明确"结论。

### 1.1 设计口号与底座
- **Agent = Model + Harness**；**一切皆插件**（Cordis）：模型、工具、技能、会话、沙箱、存储、循环、调度、UI 全部插件化，可经配置替换，不改源码。
- Monorepo：`vendor/`（内嵌 Cordis）+ `packages/<group>/<pkg>`（49 组）+ `apps/`（cli/web）+ `website/`。Host（Node 后端）与 Client（浏览器）**两个 ts.Program 永不进同一编译面**。
- 官方随附 profile 模板：`web / headless / sdk / sdk-minimal / acp`（sdk-minimal = 两工具最小 agent）。营销文案另有 standard/code/minimal/creator 说法，与 profile 无一一映射。

### 1.2 会话：append-only SessionEvent 日志 = 单一事实源
- 12 个 core 事件：`turn/start|end, step/start|end, user/message, assistant/message|attempt, tool/call|result, request/header, request/context, session/end-seed`；插件可扩展事件。
- **"Model-visible means logged"**：凡是进模型请求的内容都必须能从日志重建（runtime invariant）。
- **历史是派生而非存储**：`Session.deriveMessages()` 从日志投影出 `Message[]`；`surfaceOp: append | {op:replace, start, end}` 表达改写。
- **resume/fork/replay 都基于同一条事件流**；事件流 = 可回放账本。

### 1.3 agent-loop（脊柱六包）
- `agent-loop` 是 `Agent` 合约的唯一具体实现，但**可替换**（扩展只依赖 `agent` 包）。驱动流程：claim 队列 prompt → open turn → system-prompt 组装 → **从日志派生 history** → LLM 流 → 工具注册表派发 → 把模型可见事实 append 回日志。
- `Agent` 接口：`send/followup/steer/inject`、`cancel(cause, keepInbox)`、`whenIdle`、`runMaintenance`；状态 `idle|running`。
- 拦截点（waterfall / serial 事件）：`agent/pre-step`（决定模型看到什么）、`agent/request`、`agent/request-error`（可 `{kind:'retry'}`）、`agent/turn-stopping`、`agent/assistant-stream` 等。
- `scope/`：`createScope/scopeOf/scopeTarget`；注册与事件可**按活 Agent 对象分层**（global layer + exact-scope layer，nearest wins）。

### 1.4 模型选择与思考档位（与 BobWork 认知**最关键的差异**）
- **DSH 无"运行时按任务内容自动路由模型"的证据**。机制是：
  - Provider route 注册进 `ctx.llm`（如 `deepseek-official`），模型 id 透传线上；
  - 配置驱动默认：`ctx.agentDefaultModel`（AgentDefaultModelConfig）；
  - 会话级选择：`ctx.sessionController.selectModel`（session-local，resume 后显式安装），选择会成为新会话默认；
  - `subagentModelSelection`：**配置门控的偏好（enabled + 精确允许的 routes）**，单次派发可显式覆盖 provider/model/reasoningEffort/maxTokens。
- 每次请求携带 `LlmCallConfig`（epoch 级）：`provider/model/reasoningEffort/temperature/maxTokens/stop`；loop 从日志 `request/header` 重建请求，不是逐调用收 config。
- **思考档位由适配器自持**（core 只对 `ReasoningEffortId` 打 brand，不枚举值）。DeepSeek 官方适配器：`reasoning_effort: off|low|high|max`（默认 high）；另有 deployment 级 `thinking: enabled|disabled`；`off` 不发送 reasoning 字段而发 `thinking:{type:"disabled"}`；`purpose:'session-title'` 强制关思考。thinking 模式下 temperature 等参数官方声明无效。
- ⚠️ 官方 DSH 文档与 DeepSeek API 文档**均未出现** `thinking_mode: non-thinking/thinking/thinking_max` 词汇。

### 1.5 工具 / 技能 / 命令 / 压缩 / 权限
- **tools**：`ctx.tools` = scoped registry + guarded pipeline；`defineTool` DSL；`tools/pre-execute → execute → post-execute`；schema 自动并入 prompt；作用域分层注册。
- **skills**：host + per-scope 分层注册表；`get()` 每次调 winning provider **重读 body**（注册表不缓存正文）；模型侧目录首次注入为 `<system-reminder>`，变更走 `agent.inject()` 全量替换；`skill({name})` 工具取全文（校验 modelInvocable）。
- **commands**：handler 直接对 agent 执行，**不产生模型消息**；可 recordInput:false。
- **compaction**：可选 capability seam，不在脊柱内；`compaction/start`（锁）→ 摘要/裁剪 → `compaction/summary`（shadowedRange/shadowedSeqs 等，可重建）→ 以唯一 surface 变更 `user/message` + `surfaceOp:{op:replace,start,end}` 落 checkpoint → `compaction/end`。另有 `toolResultPruner` 确定性裁切工具结果。
- **approval**：`ctx.approval.request(req)`，**fail-closed**（仅 allowed-once 放行）；会话级策略 `ask|never` 持久化到日志；审计仅日志不进模型历史。

### 1.6 UI / 协议
- `ui-trajectory`：turn-aware 事件账本（User/Assistant/Tool/嵌套 Subtool 记录 + 时间轴），**纯消费者**，从 `SessionEventLikeEntry` window 快照渲染。
- Host/Client：packed Remote `follow`/`page` history → Client window → target snapshot → slot view。
- SDK：换行分隔 JSON-RPC + 命名类型；Typert 从 Host ts.Program 生成 Host/Client 契约（`@Remote/@RemoteScope`），`/api/<ns>/<method>` RPC；**Remote 只做一元调用**，会话事件流走独立数据协议。

---

## 2. 事实基线 B — BobWork 对话运行时现状（项目内只读盘点）

> 根目录 `projects/`，下文 `route.ts` 指 `src/app/api/chat/route.ts`（约 4460 行）。

### 2.1 一句话现状
对话运行时 = **单体内核 `/api/chat`**（SSE 流式多轮工具循环）＋ node .md 持久化（`/api/nodes`）＋ 前端 `ChatNodeKernel.tsx`（chat/coding/note/planner/市场 agent 共用壳，约 7700 行）。轨迹、思考、技能、模型均围绕这条链扩展。

### 2.2 内核结构（route.ts 顶层分区）
| 区段 | 位置（约） | 内容 |
|---|---|---|
| 常量/辅助 | 0–712 | planner 卡片、沙盒禁写、CacheGuard（`.logs/cacheguard-state.json`）、classifySystemChange、extractOutputFiles、homework diff 等 |
| 系统提示与按需规则 | 713–938 | `BASE_SYSTEM_PROMPT`（150 行模板）、BROWSER/REPORT 规则按场景注入、`buildAndSortToolDefs`（core→ondemand→custom→MCP 分层确定性排序） |
| 场景与能力目录 | 938–1086 | `detectSceneHints`（13 类场景正则）、`CAPABILITY_CATALOG` + `search_capabilities` |
| 技能/思考注入 | 1086–1348 | `isTrivialPromptMessages`（C1）、法律防幻觉 `LEGAL_GUARD_PROMPT`、`injectSkillContext`（DSH 模式：L1 目录 + forcedSkills L2 直注）、`injectThinkingPrompt`、`prependDynamicContext`（C8） |
| Vision/PDF/OCR/Node Bridge | 1348–2096 | `applyVisionBridge`、`applyPdfBridge`、`applyUpstreamNodeBridge`（上游成果块/祖先声明/自动派发实习生/R-14 裁剪）、OCR 引擎事实注入 |
| 模型解析与门控 | 2378–2530 | 请求体字段、`isDeepseekV4` 识别、`modelSupportsThinking`、`deepseekThinkingMode`（level→thinking/thinking_max，C1 琐碎→non-thinking）、`REASONING_EFFORT_MAP` |
| 工具集计算 | 2865–2943 | MCP 排除/强制、两层场景过滤（L1 静态 + L2 动态 sticky）、`computeActiveToolDefs`、temperature 规则（Moonshot/DeepSeek V4 =1） |
| round 循环 | 3172–4281 | max_tokens 分级、执行轮思考降级（`DEEPSEEK_EXECUTION_THINKING_MODE`/`REASONING_EFFORT_EXECUTION_DOWNGRADE`）、C7 硬上限校验、指数退避重试、reasoning_content 回收/修复、C2 reasoning 回传、宿主接管工具（ask_user_questions/search_capabilities/planner/tool_confirm/browser.login 等）、停滞保护/OCR 预算门控 |
| 收尾/统计 | 4283–4445 | tool_summary/output_files、done 载荷（usage/stats/cache/contextMeter/prefixHash/prefixSegments）、`.trajectory/<nodeId>/<taskId>.jsonl` 持久化 |

SSE 事件类型约 30+ 种（matchedSkills / context_meter / reasoning / content / tool_call / tool_result / questions_request / tool_confirm / done / error 等）。

### 2.3 关键事实（供差距矩阵引用）
1. **思考强度**：`ThinkingLevel='low'|'medium'|'high'`（`src/lib/types.ts:192`）；三档 label Awareness/Deliberation/Retrospection；`SYSTEM_PROMPT_INJECTIONS` 向用户消息注入中文思考要求 + 提问数量限制；前端 Brain 按钮 L/M/H 徽标；后端 level→`reasoning_effort`（非 V4）或 `thinking_mode`（V4）；执行轮自动降一级；C1 琐碎对话强制 non-thinking。
2. **Auto 模型选择**：前端 `analyzeTask`（8 类关键词任务）+ `selectBestModel`（能力/价格三层打分）在 `settings.chatModel.pool` 内每轮选模型，**不写回节点**；后端只在无 pool 匹配时兜底 `resolveTaskModel`。
3. **会话与持久化**：历史以前端 messages + node .md（`ConversationTurn`）为准；服务端 `.trajectory/*.jsonl` **只写不读**（`event-log.ts` 注释自认 P0 全量快照、P1 事件直连、P2 历史恢复未做）。
4. **轨迹 UI**：`TraceTimeline.tsx` 头部声明对齐 DSH ui-trajectory，但输入模型是 `TraceSpan`（从消息内 toolCalls/reasoning **重建**），**不与事件日志 seq/spanId 连通**。
5. **插件内核**：`src/lib/mcp/plugin-kernel.ts`（335 行 mini-Cordis：Fiber 生命周期 / effect 可逆撤销 / provide-getService / on-off-emit）+ `manager.ts`（MCP server→插件，拓扑排序装配）；`registerMcpTools` 在 tools.ts 生成 `sanitizeToolName(serverId)__tool` 全名并做场景标注。
6. **技能**：L1 目录每轮注入用户消息、L2 仅 forcedSkills 直注、`load_skill`/`read_skill_resource`/`search_capabilities` 三工具；注册表在 `src/lib/skills/*`（loader/registry/context 三段）；无 `search_skills` 工具。
7. **已落地的 DSH 借鉴**（RELEASES.md 与代码注释）：C1 琐碎关思考、C2 reasoning 回传、C5 流式 list+join、C7 1M 硬上限、C8 前缀缓存稳定化（缓存头三段指纹 + context_meter + 每轮带 tools）；`BASE_SYSTEM_PROMPT` 内已写入"技能使用机制（DSH 模式）"。

---

## 3. 差距分析矩阵（DSH 子系统 ↔ BobWork 现状 ↔ 状态）

图例：🟢 已对齐 / 🟡 部分对齐 / 🔴 缺失 / ⚠️ 概念冲突（需定性决策）

| DSH 子系统 | BobWork 对应 | 状态 | 差距说明 |
|---|---|---|---|
| session（append-only SessionEvent，deriveMessages） | `.trajectory/*.jsonl`（event-log.ts）+ node .md | 🔴 | 只写不读；历史事实源是 node .md + 前端 messages，非事件日志；无 deriveMessages/surfaceOp/fork/replay |
| agent-loop（可替换，事件驱动） | route.ts 3172–4281 round 循环（写死 while 循环） | 🟡 | 语义有 step/turn（每轮=1 step+工具），但循环不可替换、无 `agent/*` 拦截事件；扩展只能改内核 |
| system-prompt 组装 | BASE_SYSTEM_PROMPT + 各类注入（技能/思考/路径/偏好/NodeBridge） | 🟡 | 有等价能力，但为"顺序 prepend 大字符串"，非 section 化声明式组装 |
| tools scoped registry + pre/post-execute | tools.ts ToolRegistry + route.ts 工具宿主接管分支 | 🟡 | 注册与执行有；**宿主接管（ask_user_questions/search_capabilities/planner/browser.login 等 ~10 个特判分支）是硬编码 if-else，非拦截事件** |
| scope（agent 级分层注册） | `chatStickyScenes`/场景过滤 + agentSkills（按 agent 池） | 🟡 | 有 agent 维度（identity/agentSkills），但 scope 语义未贯穿 tools/skills/events |
| 模型选择（配置驱动 + session-level + adapter 档位） | **前端每轮 analyzeTask/selectBestModel 自动路由** + settings.chatModel.pool | ⚠️ | **哲学冲突**：DSH 明确无"内容自动路由"，为配置/会话级选择；BobWork Auto 是内容打分路由 |
| 思考档位（reasoning_effort off/low/high/max + thinking 策略） | ThinkingLevel low/medium/high + `thinking_mode` + prompt 注入 + 执行轮降级 + C1 | ⚠️ | **哲学冲突**：DSH 由适配器自持档位、纯 API 参数驱动、固定 epoch config；BobWork 三档自定义 + 系统提示注入中文思考指令 + 动态降级 |
| LlmCallConfig epoch（request/header 重建请求） | 每轮动态算 level/mode/max_tokens/temperature | 🟡 | 有等价参数但由内核变量传递，非日志 `request/header` 重建 |
| skills（scope 注册表、get() 重读、system-reminder 目录、skill()） | L1 每轮注入用户消息 + load_skill + forcedSkills | 🟡 | load_skill≈skill({name})；目录注入位置不同（用户消息 vs system-reminder）；正文按需读取已实现 |
| commands（handler 直接执行、不产模型消息） | 无等价物（slack/browser 有部分宿主命令） | 🔴 | BobWork 无 slash-command 概念；planner 卡片接近但不走命令层 |
| compaction seam（checkpoint user/message replace + shadowedSeqs） | R-14 成对裁剪 + `compactTrimmedHistoryForCache` + `memory_compacted_until` 游标 | 🟡 | 语义接近但未落成"可回放的 compaction 事件 + surface replace checkpoint" |
| approval（fail-closed、ask\|never 会话策略、审计仅日志） | AUTH_REQ + grant_required/login_required/ask_user_questions/tool_confirm + 授权目录清单 | 🟡 | 有审批链路；无统一 fail-closed service、无会话策略持久化到日志 |
| sandbox 写路径（sandboxed fs 唯一写） | sandbox_app_id + SANDBOX_BLOCKED_TOOLS + 沙盒桥 | 🟡 | 有沙盒模式，非"唯一写路径"强制 |
| ui-trajectory（消费 SessionEventLikeEntry window） | TraceTimeline（TraceSpan 重建） | 🟡 | 头部对齐但**数据源未连事件日志**；P1/P2 待做 |
| Host/Client 协议（Typert + JSON-RPC + packed Remote） | Next.js API route + SSE + localStorage/electron | ⚠️ | BobWork 全 UI（React Flow + shadcn + Next16）自研；引入 DSH 双端协议 = 动底座，收益存疑 |
| Cordis vendor | plugin-kernel.ts mini-Cordis | 🟡 | 已自研核心语义（Fiber/effect/service/event）；可升级为真 Cordis 或继续自研补齐 scope |
| schedule/subagent/workflow（DshBase 上层） | wanted 轮询/team 多 agent / Coding 节点 | 🟡 | BobWork 有自己的多 agent 与定时方案（bob-team-mcp、wanted 定时），非 DSH 语义 |

### 3.1 关于"自动模型选择与思考强度"的专项定性（本次问题的焦点）
- BobWork 当前把这两件事**内嵌在对话内核与前端发送逻辑里**（ChatNodeKernel Auto 分支 + route.ts 每轮 level 计算）。
- 官方 DSH 的对应物是**两层**：配置层（agentDefaultModel / subagentModelSelection / 会话 selectModel / AgentOptions.reasoningEffort）+ **拦截事件层**（agent/request、agent/pre-step），即"在请求发出前由插件改写 provider/model/effort"。
- 结论：在 DSH 语义下，BobWork 的"Auto 内容路由"与"三档/降级/C1"应**从内核中拆出，作为 BobWork 业务插件挂在 agent/request 拦截上**，而内核只保留"配置驱动 + epoch config"的最小事实。档位词汇需在 D2/D3/D6 决策（见 §6）。

---

## 4. 结论：推荐采用何种"替换"

### 4.1 排除项（不建议）
- ❌ **不整体引入官方 DSH 运行时**（把 `dsh` 作为对话内核内嵌/替换 route.ts）：
  1. 技术栈冲突：DSH 是独立 Node 双端（Host+Client 两 ts.Program、Cordis、Vite/React18）；BobWork 是 Next.js 16 + React 19 + React Flow + shadcn + electron 的既有全栈应用，融合成本高。
  2. DSH 为 2026-08-13 开源、文档与 API 快速演进（rc→alpha 周更），当前仍 pre-stable。
  3. BobWork 大量差异化能力无 DSH 等价物或差异大：node .md 共享/阅读器/归档、材料/附件/OCR/PDF Bridge、法律防幻觉链路（pkulaw MCP 场景门控）、wanted/note/team 业务、canvas 多节点依赖。
- ❌ **不"一行不改只抄名词"**：C1–C8 编号注释若与真实机制脱节，会误导后续维护。

### 4.2 推荐项（建议的"完全替换"定义）
**把 BobWork 对话内核重构为 DSH 语义内核，把自研策略插件化：**

1. **会话事实源替换**：`.trajectory` 事件日志升级为唯一事实源（对齐 SessionEvent 12 事件 + deriveMessages + surfaceOp），node .md 变为"导出/归档投影"（保留兼容导出）。
2. **loop 可替换化**：把 round 循环抽象出 `agent/*` 事件（pre-step/request/request-error/assistant-stream/turn-stopping），内核只做"claim→open turn→组装→请求→工具→append→step"骨架；所有 BobWork 特判（宿主接管工具、思考降级、C1、场景 sticky、cache guard、C7）改为**挂事件的插件**。
3. **工具/技能/权限/压缩 scope 化**：宿主接管改 pre/post-execute 拦截；技能目录改 system-reminder 注入语义；授权/确认收拢为 fail-closed approval service；R-14 压缩落成 compaction checkpoint 事件。
4. **模型与思考配置化 + 插件化**（对应你前两问）：档位枚举迁移到适配器层；Auto 内容路由、执行轮降级、C1 从内核移到 agent/request 拦截插件；请求参数随 epoch config 走、由日志 request/header 重建。
5. **UI 轨迹连通事件流**：TraceTimeline 从"消息重建 TraceSpan"改为消费事件窗口（对齐 ui-trajectory 纯消费者语义）。
6. **插件内核二选一**：自研 plugin-kernel 补齐 scope/拦截语义（改动小），或换装 vendor 真 Cordis（改动大、收益是长期一致性），见决策 D4。

> 此定义下"BobWork 方案"= 现在内嵌内核的自研逻辑；"DSH 方案"= 上述事件溯源 + 可替换 + 插件化的内核语义。

---

## 5. 五阶段迁移路线（每阶段含目标、范围、退出标准、风险）

> 每阶段都必须**先建好观测与回滚手段**（阶段入口要求），且 node .md / 历史消息 / 共享链接的读写兼容是硬约束。阶段间可独立评审、可暂停。

### Phase 0 — 决策冻结与试点（不动核心架构）
- 产出：§6 六个决策点的最终结论；选定"先行试点子系统"（建议二选一：轨迹连通事件流 / 模型与思考配置化）。
- 试点目标：验证新技术形态与既有 UI/持久化的磨合，产出该子系统的首个可上线增量。
- 退出标准：试点合入并回滚通道验证通过；决策记录（ADR）落盘。
- 风险：低（仅试点）。

### Phase 1 — 会话事件溯源化（对齐 session/deriveMessages）
- 目标：`.trajectory/<nodeId>/<taskId>.jsonl` 从"审计日志"升级为"唯一事实源"。
- 范围：
  1. event-log.ts 补齐 12 类 core 事件与 seq/time/type 判别联合；reasoning/content **不再跳过**（与 node .md 并行双写，先验证体积与性能）；
  2. 实现 `deriveMessages()`（从日志投影 Messages）与 `surfaceOp append/replace`（服务端 round 循环改为"先 append user/message → 派生 → 请求"）；
  3. node .md 写回改为**从事件流派生的导出投影**（保留 `ConversationTurn` 结构不变，保证存量 .md 与共享链接零破坏）；
  4. done 事件携带的 taskId 打通"按 taskId 恢复一次任务全量事件"。
- 退出标准：新会话可在事件日志上完整重建当前轮消息；存量 node .md 可无损读取；`deriveMessages` 与前端渲染结果一致。
- 风险：中。双写期间体积翻倍；现有"前端消息为准"的续写/补充分支需重对齐（continuation 依赖最后一条 user 消息，要能从日志派生定位）。

### Phase 2 — 思考档位机制 DSH 化（对应问题 1）
- 目标：把"思考强度"从"三档 + prompt 注入 + 动态降级"重构为"适配器档位 + 固定 epoch config + 拦截插件"。
- 范围：
  1. 档位模型迁移：将 `ThinkingLevel` 收敛为 DSH 语义枚举（决策 D2/D3 后定为 off/low/high/max 或保留 UI 三档但做适配器映射）；
  2. `SYSTEM_PROMPT_INJECTIONS` 的用户消息思考指令注入**停用/收敛**（DSH 路径下思考只由 API 参数驱动）；中/高档的提问数量限制与思考框架需求若必须保留 → 移到系统提示 section（决策 D3）；
  3. 执行轮降级、C1 琐碎关思考改为 `agent/request` 拦截插件（内核不再每轮算 level）；
  4. max_tokens 分级、temperature 规则并入 epoch config 计算（`LlmCallConfig` 语义）。
- 退出标准：DeepSeek V4 与非 V4 思考模型在固定档位下行为与现网一致；降级/C1 行为经插件开关可整体关闭；删除 prompt 注入后回答质量抽样对比达标。
- 风险：中高。思考指令移除可能影响低/中档的"提问克制"与高档的"深度框架"；需先抽样回归。DeepSeek V4 的 `thinking_mode` 词汇与官方文档不一致（见 §1.4 警示），需先核实网关协议再定档位拼写。

### Phase 3 — 模型选择与 Auto 插件化（对应问题 2）
- 目标：Auto 内容路由从"前端发送逻辑内嵌"改为"拦截插件 + 配置化偏好"。
- 范围：
  1. `analyzeTask/selectBestModel` 包装成 BobWork `model-router` 插件，挂在 `agent/pre-step`/`agent/request`（决策 D1 后）——**DSH 内核自身不做内容路由**；
  2. 会话级 `selectModel` 语义落地：用户手动选定/本轮命中模型 → 记录为会话默认，Auto 不再每轮重算（或保留"每轮重算"为插件选项）；
  3. `settings.chatModel.pool/defaultModel` 映射为 `agentDefaultModel` + `subagentModelSelection`（enabled routes）形态；`/api/models` 探测与 health 保持不动。
- 退出标准：Auto 与手动选模型的全部现网路径（含续写、市场 agent identity、coding 节点）行为回归一致；关闭模型-router 插件后回到"纯配置驱动"可正常工作。
- 风险：中。Auto 每轮重选逻辑与"消息标签展示真实模型/思考等级"耦合（现持久化 modelId/thinkingLevel 到 .md），拆插件时标签链路不能断。

### Phase 4 — 工具/技能/权限/压缩 scope 化
- 目标：宿主特判、技能注入、审批、压缩统一为 DSH 语义 service/事件。
- 范围：
  1. 工具宿主接管分支（ask_user_questions / search_capabilities / planner_confirm / tool_confirm / login 等 ~10 处）改为 pre/post-execute 拦截事件 + answerer；
  2. skills：L1 目录注入语义对齐 system-reminder；load_skill 保持（等价 skill()）；forcedSkills 映射为 preset/standing mount；
  3. approval service：AUTH_REQ/grant/login/tool_confirm 收拢为 fail-closed `ctx.approval` + 会话策略持久化（审计仅日志）；
  4. compaction：R-14 裁剪/压缩落成 checkpoint 语义（可回放、缓存感知），`memory_compacted_until` 语义并入 shadowedSeqs。
- 退出标准：任一现网审批/技能/压缩路径在新 service 上回归通过；旧硬编码分支可整体删除。
- 风险：中高。法律防幻觉链路（LEGAL_GUARD_PROMPT 置顶 + pkulaw 场景门控）是红线，迁移时需单独回归清单。

### Phase 5 — 轨迹连通与协议取舍
- 目标：TraceTimeline 消费事件窗口；决定 Host/Client 传输形态。
- 范围：
  1. TraceTimeline/ConversationTrajectory 改为订阅事件日志派生快照（对齐 ui-trajectory 纯消费者）；
  2. SSE 保留（Node 服务器直连事件流与 SSE 并不冲突）；对"Typert + JSON-RPC + 独立 dsh 子进程"整体引入**默认不做**，除非决策 D5 明确需要进程外协议带来的隔离收益。
- 退出标准：轨迹视图在新数据源下与现网展示等价；事件流协议决策落 ADR。
- 风险：中。TraceTimeline 现有 TraceSpan 组装逻辑（thinkText 切分、toolCalls 重建）与事件流需做双跑对比。

---

## 6. 待拍板决策点（评审必须回答）

| # | 决策 | 选项 | 影响 |
|---|---|---|---|
| D1 | Auto 模型路由的去留 | (a) 保留为 BobWork 业务插件（推荐）(b) 删除、纯配置/会话选择 (c) 保留现状 | 决定 Phase 3 工作量与"自动选模型"产品能力是否保留 |
| D2 | 思考档位模型 | (a) 对齐 DSH `off/low/high/max`（UI 徽标改 4 档或隐藏 off）(b) 保留 UI 三档 L/M/H、内部映射到 DSH 枚举 | 决定 Phase 2 前端改动量与用户习惯 |
| D3 | 思考指令注入 | (a) 全删、纯 API 参数驱动（DSH 正统）(b) 收敛进系统提示 section（保留提问限制/深度框架） | 决定 Phase 2 质量回归面 |
| D4 | 插件内核 | (a) 自研 plugin-kernel 补齐 scope/拦截语义（改动小，推荐）(b) 换装 vendor 真 Cordis（长期一致，改动大） | 决定 Phase 4+ 的长期架构走向 |
| D5 | Host/Client 协议 | (a) 保持 Next.js API + SSE（推荐）(b) 引入 Typert/JSON-RPC/独立 host 子进程 | 决定是否动应用底座 |
| D6 | 执行轮降级 + C1 琐碎关思考 | (a) 保留为拦截插件（推荐）(b) 删除（省 token 收益让给 DSH 无降级语义） | 决定成本与行为边界 |

---

## 7. 附录

### 7.1 术语对照
| DSH | BobWork 现状 |
|---|---|
| SessionEvent / deriveMessages | TrajectoryEvent（`.trajectory/*.jsonl`，只写不读）/ 前端 messages + node .md |
| agent-loop + agent/* 事件 | route.ts 3172–4281 round 循环 |
| LlmCallConfig（epoch） | 每轮 level/mode/max_tokens/temperature 局部变量 |
| ReasoningEffortId（适配器档位） | ThinkingLevel low/medium/high + `thinking_mode` |
| ctx.tools + pre/post-execute | ToolRegistry + 宿主接管特判分支 |
| ctx.skills（system-reminder 目录） | L1 注入用户消息 + load_skill/read_skill_resource |
| ctx.approval（fail-closed） | AUTH_REQ/grant_required/tool_confirm/ask_user_questions |
| compaction checkpoint | R-14 裁剪 + memory_compacted_until |
| ui-trajectory（事件消费） | TraceTimeline（TraceSpan 重建） |
| Cordis | plugin-kernel.ts mini-Cordis |
| scope（agent 级分层） | chatStickyScenes + agentSkills（agent 维度） |

### 7.2 事实来源
- BobWork：本项目只读盘点（2026-09-07），关键文件 `src/app/api/chat/route.ts`、`src/app/api/chat/tools.ts`、`src/components/canvas/ChatNodeKernel.tsx`、`src/lib/{model-matcher,types,thinking-parser,context-limits,node-markdown}.ts`、`src/lib/trajectory/event-log.ts`、`src/components/canvas/TraceTimeline.tsx`、`src/lib/mcp/{plugin-kernel,manager}.ts`、`src/lib/skills/*`、`src/lib/providers/{presets,resolve}.ts`、`RELEASES.md`。
- DSH：官方仓库 master + 官方站点快照（2026-09-07），见正文 §1 各条目来源；文档随版本演进，引用以抓取时刻为准。
- 结论项仅代表分析意见，供评审拍板。
