# Butler 能力面审计

> 日期：2026-09-27 ｜ 范围：`projects/src`（工具系统 + API 面）｜ 性质：只读审计，未改任何代码

## 1. 结论

**"让 Butler 操作 BobWork 任何功能"在结构上不成立，但能力面比想象的大得多。**

- BobWork 有 **≈115 个 API 路由**、**22 个工具模块、约 97 个工具定义**、**22 个场景（ToolScene）**。
- Butler 的工具面按画像静态决定，实际约 **70+ 个工具**，覆盖：事务域（日程/待办/便签/项目/计划树/偏好/单价/会议）、笔记（13）、项目档案只读（2）、应用状态只读（5）、节点树（4）、内核文件与命令（14）、联网与浏览器自动化（7）、附件/技能/Agent 包（6）。
- 仍不是"任何功能"：**大量 UI 侧能力没有被工具化**（便签改删、项目生命周期、材料增删改、日历账户与同步、文档 AI 编辑与生成、微信/分享/插件面板等）。且新增能力必须"写工具 + 改画像"，没有通用通道。

## 2. 工具面架构（两层过滤）

见 `src/app/api/chat/tools/registry.ts`：

1. **注册表**：所有工具先进 `registry`；`toApiFormat(activeScenes)` 负责过滤，并按工具名排序（保证前缀缓存命中）。
2. **两层过滤**：
   - **未标注场景 = 通用工具**，任何画像都注入；
   - **标注了场景 = 仅当该场景激活才注入**（`SCENED_TOOLS` / 工具自带 `scenes`）。
3. **固定画像公式**：`工具面 = fixedScenes 命中的工具 ∪ 内核工具 − coreExclusions`（`src/app/api/chat/route.ts` L3926–3935 附近）。
4. **运行时并集**：不改 `agent.json`（安装时已物化），而是在请求期对画像做并集——例如存在激活项目时给所有画像并 `'ledger'`（只读），管家再并 `'notebook'`。

## 3. Butler 画像的真实定义

`src/lib/agents/official-packages.ts`：

```
id: 'butler', name: 'Butler', version: '1.2.0',
fixedScenes: ['general', 'node', 'butler', 'ledger', 'console'],
prompt: BUTLER_BASE_SYSTEM_PROMPT,
```

**无 `coreExclusions`** → 内核工具全部保留。运行时追加：`'notebook'`（并把 `delete_notebook` 追加进 `coreExclusions`，防微信/语音短指令误删）。

由此推出：

| 组 | 内容 | 数量 |
| --- | --- | --- |
| 内核（始终） | `read_file` `write_file` `edit_code` `rename_file` `delete_file` `list_directory` `search_files` `run_command` `execute_script` `finish_task` `todo_write` `ask_user_questions` `search_capabilities` `team_run` | 14 |
| 通用（未标注场景） | `web_search` `web_fetch`、`hippo_browser_navigate/extract/capture/screenshot/search`、`read_attachment`、`load_skill` `read_skill_resource`、`create/validate/update_agent_package` | 13 |
| `general` 场景 | 随普通对话注入的那批（本次未逐一点名） | 待补 |
| `node` 场景 | `read_upstream_node` `read_manifest` `intern_search` `draw` | 4 |
| `butler` 事务域 | 日程/待办 8 + 便签 1 + 项目 1 + 计划树 4 + 偏好 4 + 单价 2 + 会议 3（= 20，定义在 `tools/butler.ts`） | 20 |
| `ledger` 只读 | `read_ledger` `search_materials` | 2 |
| `notebook`（运行时并集） | 读/写/编译/维护 13（无 `delete_notebook`） | 13 |
| `console` | `list_agents` `list_projects` `list_nodes` `get_app_status` `read_inbox` | 5 |

> 注意：`admin`（管理类 10 个：`manage_mcp_server` / `update_provider_config` / `test_model` / `sandbox_*` 等）**不在管家画像内**，管家默认拿不到。

## 4. 域级覆盖度

| 域 | API | Butler 工具 | 覆盖度 |
| --- | --- | --- | --- |
| 日程日历 | `calendar/events` `calendar/schedule` | 事务域 8 个 | 完整（事件读写） |
| 日历账户与同步 | `calendar/accounts`(+discover) `calendar/sync` `calendar/ics`(+feed) `calendar/feed` `dav` | 无 | 无 |
| 待办 / 便签 | `sticky-notes` `sticky-notes/parse-time` | `create_sticky_note` `read_todo` `query_todos` | 部分：只能建，不能改 / 删 / 移 / 结算 |
| 项目 | `projects`（含切换/重命名/删除/恢复）、`projects/events` `projects/activity` | `create_project` + 计划树 4 | 部分：生命周期动作无工具 |
| 项目文件 | `project-files/[...path]` | 内核 `read_file` 等 | 完整 |
| 资料 / 附件 | `materials`（增删改）、`attachments` `local-files` | `search_materials`（只读）、`read_attachment` | 部分：只读 |
| 笔记 / 知识库 | `notebook` `ledger/document` | 13 个 | 完整（主责归 Kar） |
| 项目账本 | — | `read_ledger`（只读） | 只读（写归 Archivist） |
| 文档 AI 编辑 | `ai-edit/markdown` `ai-edit/html` `ai-edit/image` `ai-generate/*` `docx/revise` `docx/audit-revise` `md-consistency` `md-navigate` `antv-chart` | 无 | 无 |
| 浏览器 / 联网 / 扩展 | `browser/*` `link-preview` `extensions/index` `plugin-panel*` | `hippo_browser`×5 `web_search` `web_fetch` | 大部分（插件面板无） |
| 设置 / 模型 / MCP / Skills | `settings` `models`(+health) `mcp/*` `skills/*` `usage` `test-model` | admin 10（**不在管家画像**）+ skill 2 | 有，但不对管家常态化开放 |
| 团队 / 沙箱 / 代理 / 节点 | `team/*` `sandbox/*` `agents` `nodes` `edges` `trajectory` | `team_run` `list_agents/nodes`、sandbox 运维 | 部分 |
| 多模态 IO | `ocr` `screen-ocr` `pdf-text` `pdf-ocr-status` `stt/*` `tts/*` `transcribe` | `ocr_document` `crop_image` `transcribe_audio` `text_to_speech` | 有（按意图放行） |
| 外部集成 | `wechat/*` `share` `bobby` `xhs-doodles` `quick-launch` | 无（`manage_quick_launch` 属 admin） | 无 |

## 5. 建议优先开放（判据：已有 API、属高频意图、且不应推给专职 agent）

1. **便签编辑 / 删除 / 结算** —— 管家能建不能改，最痛；`sticky-notes` API 已具备。
2. **项目生命周期**（重命名 / 切换 / 删除 / 归档）—— `projects` API 已具备。
3. **材料增删改** —— 只读工具与写 API 都已有，只差工具层。
4. **节点 / 画布结构写操作**（`nodes` / `edges`）—— 管家有 `node` 场景却无写工具。
5. **日历账户 / 同步配置** —— 中风险，建议带二次确认。
6. **文档 AI 编辑**（`ai-edit/*`）—— 价值高、风险中，建议先只读或需确认。

> 反例（不该开）：`delete_notebook` 这类不可逆操作已有意收归专职 agent；`admin` 类保持低频、不常驻管家，避免"随口一句改配置"。

## 6. 未核实 / 边界

- `general` 场景的实际工具清单未逐一点名（本次只确认它被并进管家画像）。
- `tools/cards.ts`、`tools/browser.ts`、`tools/shared.ts` 未匹配到工具名定义，可能用了其它定义形式，**未计入**那约 97 个。
- 用户安装的 MCP / 插件工具会额外增加工具面（如 `bob-mind-mcp` 的 8 个只归 `mind` 场景）。

## 7. 附：触成本次审计的三个问题（同日已修）

1. **待办落错项目**：`create_scheduled_todo` 未传 `project` 时静默兜底当前项目 → 已补"写入后回读校验落点"（`write_verification_failed`）+ `project_source` 回传 + `current_fallback` 告警。
2. **标题污染**：用户原话被塞进 `title`（同时是便签行文本）→ 契约改为"title 短概括、原话/来源逐字进 `description`"。
3. **项目解析不支持简称**：`resolve-explicit-project` 新增基名匹配（`余靖潘案` → `余靖潘案_20260927`），并给 `create_project` 增加 `make_current`。

同一原则：**让模型负责决策，让代码保证正确性。**