# BobWork coding 模式 vs DSH Code Mode/PTC —— 差距评估报告

> 日期 2026-09-08 · 依据：官方 DSH 发布说明与 Code Mode SDK 语义、BobWork coding 画像与 execute_script 实现实读、api.deepseek.com Thinking Mode 文档。
> 范围：只评估"编码场景的工具编排方式对齐"，不含模型/思考档位/审批（已分别立项）。

---

## 1. 术语澄清（先消除同名歧义）

| 名词 | 是谁的 | 真实含义 |
|---|---|---|
| **PTC** | BobWork（BASE prompt） | "脚本化执行优先"——**prompt 策略**：多步操作优先用 execute_script/run_command 一条链做完，少工具轮次省上下文 |
| **Code Mode** | DSH 官方 | **运行时协议**：模型输出 TypeScript 程序，工具经 **Code Mode SDK** 暴露为函数；harness 运行代码，在每个工具调用点**实时截获 → 执行 → 回填结果**，模型循环中可见可修正 |
| **PTC（DSH release 语境）** | DSH 官方 | Programmatic Tool Calls：模型程序内**嵌套调用工具**，运行时统一截获（与 Code Mode 同一机制） |

BobWork 的"PTC"是**引导模型去用脚本**；DSH 的 PTC 是**让模型写的脚本本身能调工具**。两者名字撞车、语义不同——本报告用"Code Mode/PTC"指 DSH 侧。

## 2. BobWork coding 模式现状（实读）

### 2.1 载体与画像
- **AI Coding 节点**（profile id: coding，固定场景 general/coding/design/node/browser/team/local，forceBrowserTools）；
- 画像 `CODING_BASE_SYSTEM_PROMPT`：HTML/CSS/JS 单页小程序开发（bob-sandbox/apps/）、先读后写、**每轮 capture_preview 视觉自检**、interact_preview 真实浏览器冒烟、镜像安装、产物只进 bob-sandbox/apps/；
- 应用专属上下文（Spec/交底/产物路径）按轮注入 user（S3b 已 provider 化）。

### 2.2 脚本工具能力边界（execute_script 实读）
- Python3 / Bash **单发执行**：写全脚本 → 一次跑完 → stdout 回填；**无工具调用截获**；
- CWD = homework/.ai-workspace/（产物用 `$BOB_PROJECT_HOMEWORK` 绝对路径 + OutputFile 约定）；
- 30s 超时、maxOutput 8000 字符截断；
- **脚本内只能做 shell 内可表达的操作**：文件/命令/网络(自带 curl/pip)；**不可调用 BobWork 宿主工具**（读附件、pkulaw 法条、browser.*、OCR、技能、图表……）；
- run_command 同族（工作区根、git/构建/进程，180s/30s 超时）。

### 2.3 执行循环形态
逐轮 agentic：模型每轮可并行发多个工具（含 execute_script）→ 宿主逐工具执行 → 结果拼回 → 下一轮。长链 = N 轮往返，每轮重发上下文（前缀缓存缓解）。

### 2.4 记录
- 事件日志已有 tool/result 全文、脚本内容（tool_call args）落盘；OutputFile 卡跟踪。

## 3. DSH Code Mode 语义对照

| 维度 | DSH Code Mode | BobWork coding 现状 |
|---|---|---|
| 编排载体 | TS 程序（SDK 函数：file/bash/web/...） | execute_script（Python/Bash）单发 |
| 工具可达性 | **全部工具可作函数**（SDK 层暴露，含非 shell 域） | 仅 shell 内操作；宿主工具不可入脚本 |
| 执行模型 | 运行代码 → **截获每次工具调用** → 执行 → 回填 → 模型可修正续写 | 单次脚本整体执行 → stdout 一次性回填 → 模型下轮再决策 |
| 跨域串联 | 一段程序里文件+网络+工具混编 | 需要宿主逐轮参与，脚本内外分两世界 |
| 上下文开销 | 低（程序内完成多步，少往返） | 中（每轮往返 + 大 stdout 回灌，有压缩兜底） |
| 失败处理 | 截获点可编程处理（try/catch 于程序内） | 脚本整体失败 → 模型读 stderr 再修 |
| 审计/回放 | 程序 + 每个截获点记录 | 脚本文本 + stdout（事件日志已录） |

## 4. 差距分级

| 差距 | 级别 | 说明 |
|---|---|---|
| 载体 | 🟢 已对齐 | BobWork 已是 code-first（画像引导 + execute_script），载体就是"模型写代码" |
| **工具截获与回填** | 🔴 核心差距 | 无"脚本内调宿主工具→截获→回填"运行时；execute_script 与宿主工具是两个世界 |
| 跨域工具入脚本 | 🔴 | pkulaw/browser/OCR/附件/技能 均不可被脚本编排 |
| 结果引用 | 🟡 | stdout 截断 8000 字符；长脚本中间产物需落文件再读（有成本） |
| 审计 | 🟢 | 事件日志可补"脚本 + 截获点"记录 |
| prompt 引导 | 🟢 | coding 画像已"脚本优先 + 并行化"，方向一致 |

**一句话差距**：BobWork 是"prompt 求模型用脚本"，DSH 是"协议让脚本能调一切工具"。差的不是语言/prompt，是**执行器截获层**。

## 5. 对齐路径

### PTC-v1（推荐起步，中等规模新通道，非内核改造）
在 execute_script 旁加一个 **工具桥脚本通道**：
- 脚本内提供**白名单宿主函数**（第一批评：`bob.read_file / bob.write_file / bob.list_dir / bob.web_fetch / bob.browser_shot / bob.search_files`）；
- 宿主解释执行时**截获 bob.* 调用** → 走既有工具执行与权限面（approval/路径 gate 复用）→ 结果注入脚本上下文（stdout/返回值）；
- 画像补一条：coding 节点复杂链优先写编排脚本调 bob.*，宿主截获回填，一次脚本完成多域操作；
- 事件日志：脚本全文 + 每次截获点入账（对齐 Code Mode 可审计）。
- 收益：多域串联一轮完成、少往返；风险：白名单裁剪执行器安全面（新执行面需 fail-closed）。

### PTC-v2（重，先不做）
完整移植 Code Mode SDK（TS 类型化工具 + 流式逐调用回填 + 沙箱），等"编码长任务多域编排"痛点显性再立项。

### 不做（维持现状）
保持 prompt 级 PTC。风险：跨域链仍多轮往返；无风险但收益停在"少轮 shell 链"。

## 6. 建议决策点
1. PTC-v1 是否立项？→ 我出接口面设计（bob.* 白名单第一版 + 截获执行器与现有 tool 执行/审批/路径 gate 复用点）；
2. 若做：白名单首批评哪些（读类起步最安全？浏览器截图？）；
3. 时间节奏：v1 独立于 DSH 完全对齐主线，可与回归实测并行。

## 附：参考事实源
- 官方 DSH：Code mode = "model-generated code to orchestrate multiple rounds of tool calls"；release 语境 "PTC 嵌套工具调用"；
- BobWork：CODING_BASE_SYSTEM_PROMPT（profiles.ts）、execute_script/run_command（api/chat/tools.ts）、事件日志 CORE_EVENT.tool。
