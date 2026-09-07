# DSH 替换 BobWork 对话运行时 — 架构差距分析与迁移方案

- 日期：2026-09-07
- 状态：**已采纳方向；P1 已落地（2026-09-07），batch3-b 起待评审后实施**（实施记录见 §8）
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

---

## 8. P1 事件溯源实施记录（2026-09-07 落地）

> 状态：**P1 batch1/2/3a 已落地**（工作区未提交 git）；batch3-b 待评审后再动；Phase2-5 未启动；§6 的 D1-D6 决策仍开放。

### 8.1 新增 / 变更资产
| 文件 | 内容 |
|---|---|
| `src/lib/trajectory/event-log.ts`（改） | 新增 `CORE_EVENT` 常量（turn/start\|end、step/start\|end、user/message、assistant/message\|attempt、tool/result）、`readEventLog()`、`deriveMessages()`、`buildRenderMessages()`；保留 record/mark/finalize 全兼容 |
| `src/app/api/chat/route.ts`（改，纯插入 15 处） | turn/start + user/message（任务起）、每轮 step/start、工具轮 assistant/attempt、7 处 tool/result（model-visible 全文）、5 处收尾 assistant/message、正常路径 turn/end |
| `src/lib/trajectory/reader.ts` + `reader.test.ts`（新） | 按 nodeId+taskId 读日志并投影；路径段防穿越 |
| `src/app/api/trajectory/route.ts`（新） | `GET /api/trajectory?node_id&task_id[&project_id]` 只读恢复接口 |
| `src/lib/trajectory/export.ts` + `export.test.ts`（新） | `buildExportMessages()`：core 文本 + SSE 帧融合成与 node .md 等价导出（batch3-b 铺垫） |
| `src/lib/trajectory/event-log.test.ts`（新） | 派生/合并/坏行容错单测 |

### 8.2 关键实现决策（与 §1 DSH 语义的取舍）
1. **聚合事件路线**：流式 reasoning/content 仍不逐块记录（避免 token 级爆炸），改为在结算点写「聚合完整正文」事件（assistant/message·attempt 携 content+reasoning 全文）。
2. **tool/result 记模型可见全文**：取自 `conversationMessages.push` 点（toolMsgContent/answersText…），而非 SSE 截断帧（2000 字符）。
3. **终答补记**：route.ts 收尾 break 前即时写入（修复"最终回答仅存内存/SSE、日志无法重建"的缺口）。
4. **未用的事件**：`request/header、request/context、session/end-seed、step/end` 未落地（request 级参数重建留 Phase3 epoch config；step/end 由后续 tool/call 帧与 turn/end 覆盖）；`tool/call` 由既有 SSE `tool_call_update/tool_result` 帧承载。
5. **旧格式兼容**：读取容错坏行；历史 JSONL（无 core 事件）仍可读（coreCount=0、messages=[]）。

### 8.3 真实验证（样例可复查）
- 任务 `mtr7mweq-5c9e5e79`（`十三幺-20260825` / node `4e3b81d5…`）：日志含完整 turn→user→step→assistant→turn 序列；`GET /api/trajectory` 恢复 `coreCount 5`，投影 user（原输入）+ assistant（`OK` + reasoning）。
- 8 个 vitest 单测（event-log/reader/export）全绿；tsc 0；lint 零新增；dev 页面 200。

### 8.4 遗留与下一步
- **batch3-b（node .md 写回切换为事件派生导出投影）**：需先评审三件事——(1) 写入方迁移（现由前端 append；改服务端/派生权威需定协议与并发策略）；(2) 续写依赖"末条 user 定位"与压缩 `memory_compacted_until` 对齐；(3) 存量 .md/共享链接零破坏（ConversationTurn 结构不变）。
- 验证 P1 阶段成果的**体积/性能**（含工具轮的 reasoning/content 全文落盘）需一次带工具的真实长任务实测。
- 前端 Trace（TraceTimeline）消费事件窗口为 Phase5，未开始。

---

## 9. batch3-b 决策稿（node .md 写回切换为事件派生导出）

> 状态：**方案 A 已落地（2026-09-07）；C 兜底单测已随附**（batch1/3a 另见 §8）

### 9.1 事实基线（2026-09-07 实读）
1. node .md 会话写回 = **每轮摘要一次**：前端在 send 收尾调用 `POST /api/nodes action=append`，携带 `question/answer/reasoning/tool_calls/task_id/output_files/model_id/thinking_level` 等**摘要字段**（非全量 messages）；服务端 `appendConversation` 组装一轮 ConversationTurn 写盘。
2. 服务端 append 内顺带执行**增量压缩**（R-25~27，`shouldCompact` → 返回 `new_compacted_until`，前端推进游标）。
3. **task_id 已在 append 落盘**（ChatNodeKernel 4192）→ 每条 answer 已关联其事件日志文件 → `.trajectory` ↔ node .md 已打通。
4. 事件日志（P1 batch1/3a）已可从任务日志**派生等价摘要**：user/message→question、assistant/message→answer+reasoning、export 融合 SSE 帧→toolCalls 步骤、output_files 帧→文件卡。
5. 前端第二处 append（4576 `handleRetryAppend`）= 保存失败重试（同语义，无新场景）。

### 9.2 决策目标
让 **.md 的内容由事件日志派生**（事件=事实源，.md=会话导出），前端不再自拼持久化内容——消除"前后端各持一份本轮事实"的漂移源，与 DSH SessionEvent→derive 语义对齐。

### 9.3 三个方案
| 方案 | 做法 | 改动面 | 风险/收益 |
|---|---|---|---|
| **A（推荐）** | append 增加"派生模式"：`body={action:'append', node_id, task_id, derive:true}`；服务端读该 task 日志 → `buildExportMessages` → 派生 question/answer/reasoning/tool_calls/output_files → 走**同一 appendConversation**（压缩逻辑天然复用）；日志缺失/为空 → 回退旧字段（前端仍传 question/answer 兜底） | `/api/nodes append` 增 derive 分支；ChatNodeKernel 收尾 append 改传 taskId（保留字段兜底） | 低-中。.md 与日志同源、压缩零改动、旧版本请求兼容 |
| **B（DSH 彻底）** | .md 仅保留最近 N 轮导出 + 事件日志为全历史权威，长历史渲染按需读事件派生 | 前端消息加载/渲染链路大改 | 高。属 Phase5（Trace 连通 + 历史渲染换源）一起定，不建议单列 |
| **C（审计兜底）** | 不切换写回；把"日志派生摘要 == append 内容"做成一致性校验（单测 + 可选后台 diff） | 小 | 零风险、即时可用，作为 A/B 前的安全网 |

### 9.4 方案 A 需要处理的点
1. **触发时机不变**：仍由前端在 send 收尾触发 append（前端持有"本轮完成"与多轮/续写语义最准确；服务端自动触发会造成提问轮/续写轮重复提交）。
2. **字段可派生性边界**：question/answer/reasoning/toolCalls 步骤字段、output_files 均可从日志+SSE 帧重建；**processNarration（前端剥离的过程叙述）与 cardHtml/purpose 等展示增强字段**若日志未含则缺失——对策：导出不含时，前端/阅读器按 toolCalls 兜底渲染（现状恢复路径已是 tool_calls 驱动），或后续在事件里补 `narration` 扩展事件（Phase2/4 工具宿主接管时可顺带）。
3. **失败回退**：日志未落盘（服务端崩溃/流中断）时保留"前端字段直传"路径，append 幂等语义不变（重试/续写 remove_last_round 逻辑不动）。
4. **压缩对齐**：派生走同一 appendConversation → `shouldCompact/compacted_until` 行为与现状一致，无需新逻辑；派生 mode 需把 `model_id/thinking_level` 透传（日志事件未含时用前端值）。
5. **并发**：写 .md 仍由 nodes append 单点串行（现状即如此），无新增并发面。

### 9.5 建议
- 采纳 **A 为主 + C 兜底**（先落 C 的一致性单测，再切 A）；B 并入 Phase5 决策。
- A 落地前需一次**带工具的真实长任务**压测日志体积/性能（P1 §8.4 已列）。
- 六决策点 D1-D6 不变（A 不影响模型/思考/协议决策）。

---

## 10. Phase 2 实施记录（思考档位 DSH 化，2026-09-07 落地）

> 决策：全面 dsh 化 —— D2 保留 UI 三档 + 适配器映射；D3 V4 删除思考 prompt 注入（纯 API）；D6 降级/C1 保留为可关策略。

### 10.1 2a 策略层抽取（默认行为与现网一致）
- 新增 `src/lib/thinking/policy.ts`：`ThinkingEffort`（off/low/high/max 锚点）、`v4ThinkingModeForLevel`（C1 琐碎关思考可开关）、`executionDowngrade`、`isTrivialPrompt`、`shouldInjectThinkPrompt`（2b seam）；均纯函数。
- `route.ts` 6 处接线改调策略层（档位/C1/降级收敛，行为逐位一致）；删除本地 `isTrivialPromptMessages` 与两降级表常量。
- `settings.ts` 新增 `thinking.{downgradeOnExecution, trivialPromptOff, injectThinkGuide}`（默认 true）；未改设置 UI。
- 待优化：档位决策点多一次 settings 文件读取（每请求），后续与工具配置读取合并。

### 10.2 2b V4 停止思考注入（行为变化点）
- `shouldInjectThinkPrompt(isV4, supports, config)`：**V4 恒 false**（原生 reasoning，纯 API thinking_mode）；非 V4 推理默认 true 可关（`injectThinkGuide`）；非推理 false。
- 对照（V4 thinking_max 同题，事件日志实测）：基线(注入) answer 351/reasoning 3421 vs 2b后(无注入) answer 395/reasoning 3643 —— **无退化、更结构化**。
- 行为副作用（观察项）：V4 不再受"提问数量限制" prompt 约束；非推理模型不再收到清洗版思考引导。

### 10.3 遗留
- 2c（2026-09-07 已落地）：SettingsModal 角色派发 Chat Model 折叠区内新增 Thinking Policy 三开关（downgradeOnExecution / trivialPromptOff / injectThinkGuide，默认 On），随主表单保存。真实三模型路径回归留待用户在配好非 V4 推理/非推理 key 后冒烟（自动化：policy 单测 + tsc/lint/dev 200 已过）。
- D2 显式 off/max 用户档位（UI 4 档）未做（语义已被 C1/thinking_max 覆盖）；
- P3（模型路由插件化）、P4、P5 待推进。

---

## 11. Phase 3 实施记录（模型路由插件化 3a，2026-09-07）

> 盘点结论：Auto 实际由**前端**每轮 analyzeTask+selectBestModel 决策并携带三件套（apiKey/baseUrl/providerModelId）给后端；服务端 resolveTaskModel 兜底仅服务外部客户端；SSE 无 model 通知帧；消息 label/落盘均用 `provider:modelId`。

### 11.1 3a：Auto 智能选模开关（D1 落实，默认行为不变）
- `settings.chatModel.auto`（默认开）：关 → 静态首选（候选池首项，等同服务端 resolveMainChat 语义）；开 → 现网按任务类型 selectBestModel 打分。
- 改动：`src/lib/settings.ts` TaskModelSettings 加 `auto?: boolean`；`ChatNodeKernel.tsx` doSend Auto 分支加 `autoModelRouting` 判断。
- 已知不一致点（记录待修）：Auto+追问（isContinuation）跳过选路会静默回退 availableModels[0]（L3449 附近）。

### 11.2 3b（2026-09-07 落地部分 + 遗留）
- ✅ Auto 追问回退修正：ChatNodeKernel 追问（continuation）延续上一条 assistant 消息实际模型；无记录则落入 Auto 决策，不再静默回退 availableModels[0]。
- ✅ Agent 专属默认模型：settings 新增 `agentModels?: Record<string, TaskModelSettings>`；task-model 新增 `resolveAgentRoleModel(agentId)`（pool 有序解析 → defaultModel 直配）；route 兜底解析按 identity 先查 agentModels 再回退 chatModel。UI 暂无编辑入口（可后续 Settings 加）。
- ⏳→✅ SSE model 通知：done 帧新增 `model` 字段（`provider:modelId`，provider 按 apiKey 反查；查不到用裸 id）；
- ⏳→✅ 服务端轻量 Auto 选路：task-model 新增 `rankPoolForTaskType`（纯，analyzeTask 分类 + 思考标志模型前置，可单测）与 `resolveAutoTaskModel(messages)`（受 chatModel.auto 开关约束）；route 兜底链路 = agentModels → auto → 静态 resolveTaskModel。与前端 spec 级打分相比为名字级启发，任务类型语义一致。

---

## 12. Phase 4 实施记录（工具/技能/审批/压缩 scope 化）

### 12.1 盘点结论（2026-09-07）
四域现状与差距（含文件行号证据）见会话盘点记录；要点：A 工具拦截=route 内核 if-else 特判 ~10 处（顺序耦合）；B 技能 load_skill 已启用、legacy matcher 死链；C 审批现网默认关闭工具确认、无统一 fail-closed 服务；D 压缩阈值=代码常量、双轨重复、非可回放事件。

### 12.2 P4a-1（已落地）：工具三段化骨架 + 首批接管迁移
- 新增 `src/lib/chat/tool-pipeline.ts`：`ToolTakeoverKind('scenario_activate'…)`/`ToolTakeoverPhase('pre'|'post')`/`registerTakeover`/`takeoverFor`/`applyScenarioActivation`（激活→sticky→rebuild 统一执行；sticky 默认 true）。
- route.ts：注册 search_capabilities(pre, 全接管) 与 load_skill(post, 法律名单命中) 两个 scenario_activate；原 if 分支删除，SSE/记录/样板保留。
- 行为等价核对：激活/sticky/needRebuildTools/提示文案逐项一致；真实冒烟（search_capabilities 命中/未命中两分支）通过。
- 设计取舍：pipeline 不产 SSE 帧（send/nodeId 收进 addStickyScene 闭包）；sticky 默认 true 依赖首批两接管均 sticky。
- 遗留：其余接管（ask_user_questions/planner/confirm/login/grant/参数注入/结果压缩）未迁移，属 P4a-2；宿主完成帧样板收敛属 P4a-3。

### 12.3 P4a-2a（已落地）：args_transform + result_compact 迁移
- tool-pipeline 扩展 `ToolTakeoverKind` 增 `'args_transform'|'result_compact'` + `takeoverOfKind(name, kind, phase?)`；handler 可选 `transformArgs/compactResult`。
- 参数注入（10 文件/沙箱工具，current_node_id/node_sandbox_app_id，exec 前 args 变换，失败 return null 不覆盖）与结果压缩（全量 >3000 token 保头保尾 + tool_compact 帧，作用面仅 conversationMessages/eventLog）迁入 pipeline；行为等价逐项核对。
- 顺序约束：result_compact 注册序必须在 load_skill(post) 之后（post 咨询按 name 首个命中）。route lint 存量 11 项行号位移，新增 0。
- 遗留（P4a-3）：挂起型五类接管 ask_user_questions / planner 卡片 / confirm 名单 / login / bobby grant。

### 12.4 P4a-3-1（已落地）：ask_user_questions 挂起型迁移
- tool-pipeline 增 `ToolTakeoverKind 'ask_user'` + host-pending 形态：`HostTakeoverVerdict('handled_continue'|'handled_fallback'|'noop')`、`HostTakeoverContext`（send/args/nodeId/spanId/startAt/commitToolResult 最小服务面）、`registerHostTakeover`/`hostTakeoverFor(name, kind, phase?)`。
- route：handler 模块级注册（handleAskUserQuestions，不持闭包、并发安全）；原 if 分支（71 行）删除→分发（36 行）；answers 恢复通道（POST /api/chat/questions 独立端点）+ 20s 心跳 + tool_result 回灌 + commitToolResult 三连（allToolCalls/conversationMessages/eventLog）逐位一致；前端协议零改动。
- 复用模式（P4a-3 后续类）：模块级注册 + ctx 注入 + verdict 分发 + consult 按 (name,kind,phase)；login(post) 与 tool_confirm(pre) 可共存于 browser.login 互不顶替。

### 12.5 P4a-3-2（已落地）：tool_confirm 名单迁移
- tool-pipeline 增 kind 'tool_confirm'；HostTakeoverContext 增可选 identity/confirmTools/execArgs/commitToolError（向后兼容）。
- route：模块级 handleToolConfirm（注册条目 name:'*'+match:()=>true，名单判定在 handler 内）；原 confirm if 分支删除，consult 点仍在 planner if 之后（顺序保证）；planner 段原样不动。
- verdict：noop（名单外/planner 覆盖）→ 通用执行；handled_continue（denied/timeout 措辞区分）→ error 落账 continue；handled_fallback（approved）→ 回落通用执行。**edited-args 通道不需要**（通用 confirm approved 从不读 edited，唯一消费者在 planner 段）。
- 人工回归：confirmTools 配 delete_file 等 → 三路验证 + planner 卡不双弹。

### 12.6 P4a-3-3（已落地）：planner 卡片迁移
- tool-pipeline 增 kind 'planner_confirm'；HostTakeoverContext 增可选 `setExecArgs(raw)`（edited.toolArgs 覆盖通道，宿主 handle 返回后同步改写 parsedArgs/execArgs，再回落通用执行）。
- route：模块级 handlePlannerCard（恒咨询，身份+PLANNER_CARD_TOOLS 名单在 handler 内判）；原 planner if 删除；consult 点仍先于 tool_confirm；verdict：handled_continue（denied/timeout）continue、handled_fallback（approved±edited）经 `plannerCardCovered` 跳过 tool_confirm consult 后通用执行、noop（非 planner/卡构建失败）→ 照常 tool_confirm consult。
- **usesPlannerCard 冗余判定保留**：覆盖"planner 身份 + 卡构建失败（buildPlannerCard null）"边界，防 confirmTools 含三工具时误弹通用确认。
- 人工回归：planner 触发三排程工具编辑参数确认/拒绝/超时 + tool_confirm 不双弹 + card 构建失败零弹窗。

### 12.7 P4a-3-4（已落地）：login / bobby grant 迁移，P4a-3 收官
- tool-pipeline kind 增 'login'|'grant'（post）；HostTakeoverContext 增可选 result/pageUrl/setExecResult；mode 注入以 args_transform 第二条目落地（与 node 参数注入互不相交）。
- login：exec 后 loginRequired → createPendingLogin → SSE login_required + 20s 心跳 → 独立端点 POST /api/chat/login → 宿主 findBrowserLoginFillFullName + mcpManager.callTool({redactArgs:true}) → setExecResult 写回三分支 → 回落通用落账；login_fill 不注册给模型的保证未破坏。
- grant：mcp__bobby__* 结果含 grantRequired → SSE grant_required{target} 旁路（无 continue）；恢复由前端 BobbyNode 授权广播补发。
- 两表隔离（registeredTakeovers 纯函数表 vs registeredHostTakeovers 挂起表）防跨 kind 串扰。

### 12.8 P4b-1（已落地）：审批策略层 approval
- 新增 src/lib/chat/approval.ts（纯函数）：`ApprovalStrategy('allow_scope'|'ask'|'never')`、`isWriteKindTool`（保守写类：内置写文件/shell/配置写 + browser 写动作，排除读/导航/截图）、`decideToolApproval` → allow|request|deny。边界：planner 结构化卡与 .local-roots 路径授权 gate 不在本层（正交）。
- settings：`approval.defaultStrategy` 默认 'allow_scope'（现网零变化：名单 request、其余 allow）；ask（写类也 request）/never（写类 deny）为新档。
- tool_confirm handler 接入：usesPlannerCard 最优先 noop → decideToolApproval；deny → SSE error（"当前审批策略（never）…"）+ commitToolError + continue。
- 单测 79 通过（approval 三策略矩阵）；tsc 0/lint 新增 0/页面 200。
- 人工回归：.settings.json 临时置 ask/never → 写类工具弹窗/拒绝、读类放行、planner 卡不受影响。

### 12.9 P4c-1（已落地）：压缩事件化 + 双轨 fallback 收敛
- event-log：CORE_EVENT 增 `COMPACTION='compaction'`（payload: reason/shadowedTurns{from,to}/hardFactsCount/hardFactsSample/summaryGoal/compactedUntil/fallbackKind）；deriveMessages 无该分支 → 投影不受影响。
- 共享 fallback：compact.ts 新增导出 `compactionFallbackSummary`（硬事实直写），route R-14-C 无模型/冷却期两分支与 nodes append fallback 均改调（行为逐字节等价，单测夹具核对两原实现）。
- route 事件注入：taskId/eventLog 创建提前到 Node Bridge 前（3043），经 applyUpstreamNodeBridge/compactTrimmedHistoryForCache 参数逐级传入；写回成功后 record compaction 事件（seq 0 于 TURN_START 前）；stream start 内重复声明删除。
- runCompaction 内部本就自带模型失败兜底，无需改动。93 单测全绿（新增 compact 等价 2 + event-log compaction 1）；tsc 0/lint 新增 0/页面 200。

### 12.10 P5a-1（已落地）：前端 live 事件窗口 schema（渲染未切换）
- 盘点结论：后端事件资产与 SSE 逐帧同构且完整，前端零消费；Trace/DOS 全基于消息快照+todo_write 参数+thinking 事后切分。
- 新增 src/lib/trajectory/present.ts：`normalizeSseFrame`（type 取显式字段或载荷首 key；reasoning/content 保留为累积标记）、`createTraceWindow`/`pushWindowFrame`（spanId upsert：tool_call 建 span（无 spanId 用 tool_call_id/id/name#seq 兜底）、tool_call_update 幂等置 running 容忍 keepalive、tool_result 乱序结算、6 类交互帧入 meta.interactions、未识别帧忽略）、`finishWindow`（pending/running 收口 done）。语义与 ChatNodeKernel 现有 upsert 逐条核对。
- ChatNodeKernel 5 处旁路接入（ref 只写不读、独立 try/catch、每轮 reset、finally finishWindow）——零行为变化。
- 17 条新单测；trajectory 组 29/29 全绿；tsc 0/lint 新增 0/页面 200。

### 12.11 P5a-2（已落地）：Trace 面板窗口派生（可回退）
- 新增 src/lib/trajectory/render.ts：`windowToTrajectoryItems`（窗口→TraceWindowTurnItem，与 ConversationTrajectoryItem 同形；thinkText 取 reasoningAccum 优先、contentAccum 剥 think 兜底；toolCalls 由 spans 全字段快照；matchedSkills/skillDetails 取 meta 并容错归一）；空窗口/无轨迹 → null（回退信号）。
- present.ts 补充渲染等价字段（span.arguments/success/systemChange/changeSummary、meta.skillDetails），同帧透传不改语义。
- ChatNodeKernel memo 尾部窗口优先：窗口派生替换**最后一条**消息派生项（保留 number/userText/isStreaming/durationMs），其余轮次仍走消息快照；null/throw/类型不符 → 现状 + 单次 console.warn 回退标记。DOS/胶囊/usage 零改动。
- 单测 34/34 全绿（render 等价门 5 例：成功+失败工具/reasoning 优先/剥 think 兜底/畸形 skillDetails 容错）；tsc 0/lint 新增 0/页面 200。

### 12.12 P5b-1 + P5d（已落地）
- P5b-1 历史 replay：present.ts `eventsToTraceWindow` + core 结算事件吸收（attempt 带 toolCalls 建 span、tool/result 全文回补、compaction 进 meta、turn/end 收口）；spanId(uuid)/tool_call_id 双命名空间别名互认防双建；reader/api 返回 events（向后兼容）；前端 ConversationTrajectory Turn 头 taskId 时显「原始轨迹」→ 回放条可返回实时。39 单测。
- ⚠️ 事故记录：P5b-1 验证清理时 rm -rf 误删回收站节点 4e3b81d5 的 .trajectory 目录 10 个任务日志（.md 正文在 .trash 未丢）。后续清理不得直接 rm 真实工作区。
- P5d 读端建模：span.compacted（tool_compact 标记同名未结算 span）、meta.corrections（completion_check/claim_mismatch 桶）、meta.outputFiles（output_files 最终帧）；coding_phase/context_meter/交互帧此前已建模。42 单测。

### 12.14 可选收尾项执行/立项记录（2026-09-07）
- ✅ P4b 扩展（部分）：`approval.perAgent?: Record<AgentId, ApprovalStrategy>`（命中优先于 defaultStrategy），route 注入点按 identity 查。denied 审计说明：deny 走 tool_result(error) SSE 已自动入事件日志（send 闭包 record），无需另建事件。
- ✅ P4d（轻量）：matcher.ts / intent-classifier.ts 头部加 @deprecated 标记（保留 sandbox searchSkills 引用；新功能禁止 import，迁移后随文件删除）。完整 skills 目录注入语义对齐受 C8 缓存头约束，未动（记录为 ADR 候选）。
- ⚪ P4a-4 评估：宿主完成帧样板已大部分收敛（各挂起 handler 复用 ctx.commitToolResult/commitToolError 三连）；剩余 20s 心跳样板逐类复刻，抽公共 helper 收益有限且引入跨类回归风险——**维持现状，不抽**（close）。
- 📋 P5d2 立项（stepId 协议化）：目标把 todo_write 步骤与工具 span 绑定（step↔spanId）。前置决策：① 协议变更（agent 输出 todo 需带稳定 stepId 并由工具事件回传）涉及 tools 定义与 prompt 纪律，属产品级变更；② DOS 面板现以 todo_write 全量快照为权威源（记忆契约），stepId 事件化收益主要在审计/回放对齐。建议作为独立立项（PRD + 抽样回归）另排。

### 12.15 自动化回归实测（2026-09-07，真实模型调用，settings 已备份/恢复零污染）
- ✅ C1 琐碎关思考：短句 reasoning 494 字符 vs high 深题 4528（~1/9 削减，V4 flash non-thinking 仍产极短 reasoning 属模型特性）
- ✅ V4 high：thinking_max 深推理 + done.model=`deepseek:deepseek-v4-flash`
- ✅ 工具轮 + 事件日志：list_directory 全事件链（tool_call/update/result/span/tool result 全文）+ 未授权 Desktop 路径被路径 gate 拒（正交层正常）
- ✅ /api/trajectory replay：16 events/8 core/完整 types（project_id 可选，省略走 current project）
- ✅ ask_user_questions 端到端：questions_request → POST /api/chat/questions → 答复回灌 → done
- ✅ tool_confirm deny：confirmTools 名单触发 → confirmId → approved:false → "拒绝"文案 → done
- ✅ approval never：write_file deny（never 文案、文件未创建零副作用）→ settings 恢复后默认档放行复验
- ✅ planner 卡：never 档下仍弹卡（planner 结构化卡强于策略的边界设计验证）→ deny 生效
- 🔧 **修复回归 bug**：abort/断开后挂起心跳仍 send → `controller.enqueue` ERR_INVALID_STATE → uncaughtException（实测"谢谢"触发 ask_user_questions 挂起后 curl 断开复现）。修复：route send 内 enqueue 包 try/catch（stream closed 静默忽略迟到帧）；修复后 R4/R5b/R6 挂起+断开均无崩溃。
- ⏳ 无法自动（需 UI/外设/长时）：browser.login 流、Bobby 授权、tool_compact 大结果实触发、压缩事件实触发（需调小 triggerTurns）、Settings UI 开关/DOS/NodeMap 视觉、tool_confirm approved 执行分支（回落通用执行与 R3 工具路径同）。

### 12.16 DSH 内核接口面盘点（2026-09-07，loop 替换前置契约基线）
- 结论：**未换内核**——本批为向 DSH 语义收敛/对齐；真正 loop/adapter 替换未做。
- 接口面盘点已落盘 → [DSH内核接口面盘点-20260907.md](DSH内核接口面盘点-20260907.md)：顶层 23 阶段 / 每轮 r0-r19 + 每 tool a-s 咨询链 / SSE 帧全集与事件 mark 点 / pending 握手 / .md 与前端承诺 / 横切机制（C2/C7/C8/R-14）/ 已抽象 vs 内核固有表 / 替换切口与硬契约 / 风险与前置决策。
- 盘点发现待决项：finish_task/todo_write 死代码（4017-4057 不可达 vs BASE prompt 契约落差）、claimMismatch 计数器 dead、会话态（chatStickyScenes/CacheGuard）迁移归属、skills L1 注入位置。
