/**
 * Coding 小程序的 Bridge API 文档（按需读取）。
 *
 * 背景：这些文档原先整段注入 buildCodingSandboxInjection，每轮固定占用大量上下文，
 * 对 Flash 模型是注意力稀释，也容易诱导「为了亲儿子主动加集成」。
 * 现在拆成 read_bridge_docs 工具：核心 prompt 只留一页索引 + AI 接入策略，
 * 模型真正需要持久化/宿主资源/画布/AI/hostTool 时再读对应分区。
 *
 * 注意：本模块**不静态/动态 import sandbox/bridge**（bridge → host-tools → tools/index），
 * 否则 tools/index → coding-docs 会形成 import/no-cycle。host 分区只给常用 action，
 * 完整清单让模型在运行时调 BobWork.listActions()。
 */

export type CodingDocSection = 'storage' | 'host' | 'graph' | 'chat' | 'hostTool';

export const CODING_DOC_SECTIONS: Array<{ key: CodingDocSection; label: string; when: string }> = [
  { key: 'storage', label: 'Persistence', when: '需要保存记录、历史、表单草稿、跨重启数据' },
  { key: 'host', label: 'Host resources', when: '要读 Butler 待办/笔记/偏好、节点、项目、模型、日历' },
  { key: 'graph', label: 'Canvas graph', when: '要做节点地图 / 画布导航 / 操控面板（仅应用内 Preview 可用）' },
  { key: 'chat', label: 'AI chat', when: '要接入模型、做翻译/总结/问答/文案生成，或需要模型选择 UI' },
  { key: 'hostTool', label: 'hostTool', when: '要调用宿主文件/命令/项目/Butler/MCP 等任意工具（高权限）' },
];

/** 核心 prompt 里的一页索引（保持短；详细内容走工具） */
export function codingDocIndex(): string {
  return CODING_DOC_SECTIONS.map((s) => `- ${s.key}（${s.label}）：${s.when}`).join('\n');
}

const STORAGE_DOC = `【持久化 API — 默认允许主动使用】
以下为小程序自身的持久化能力（私有数据），用户提到"加持久化"、"保存记录"、"关掉再打开还在"、"恢复上次状态"、"存历史记录"等场景时，应主动使用，无需用户额外说明：
  （预览页运行时已全局注入 window.BobStorage 对象，直接调用即可；共三层，第 2/3 层是 async，必须 await）
  - BobStorage.set(key, value)  → 浏览器端 localStorage，自动加 appId 前缀隔离，关闭 BobWork 清空浏览器缓存会丢失
  - BobStorage.get(key)         → 读取上条，返回解析后的值或 null
  - BobStorage.remove(key)      → 删除上条
  - BobStorage.listLocalKeys()  → 列出该小程序在 localStorage 中所有的 key
    * 注意：set 在超出 500KB 配额或序列化失败时**静默返回 false**（不抛错），写入前应判返回值
  - 第 3 层（全局交付目录）：await BobStorage.writeWanted(filename, content) → 写入 ~/BobWork/butler/
  - BobStorage.save(key, value) → 写入磁盘私有数据目录 ~/BobWork/bob-sandbox/apps/<appId>/data/<key>.json，真正持久化，重启/升级/重装均保留，推荐用于历史记录、长存档、表单完整状态等需要跨重启保留的数据
  - BobStorage.load(key)        → 读取磁盘私有数据目录，返回解析后的值或 null
  - BobStorage.listDiskKeys()   → 列出磁盘私有数据目录下所有 key
  - BobStorage.deleteKey(key)   → 删除磁盘私有数据目录下某 key
  选择原则：表单临时状态/UI 偏好 → 用 set/get（快，不需要等待 Promise）；历史记录/长存档/重要数据 → 用 save/load（写入磁盘，跨重启保留）。`;

const GRAPH_DOC = `【画布对接 API（GraphGateway，太空舱对接协议）】
graph* 系列动作用于小程序对接主程序画布（如"节点地图"、"画布操控面板"、"节点导航器"等需求）。规则：
  1. 完全信任模式下默认已授权（graphGetPermission 返回 level:'control'，不再弹确认框），可直接调用；
  2. 也可调用 BobWork.request('graphRequestPermission', { level: 'read'|'control' }) 显式声明需要的最低级别；
  3. 运行位置决定能力：在 BobWork 内的**沙箱预览**（商城/节点 ▶ 的 Preview）里有画布宿主，graph* 可正常调用；
     而在 Hippo 独立页（独立窗口）打开时没有画布，会以"当前为独立页面，不支持画布对接"reject ——
     所以做画布类小程序时，请在正文提示用户用 Preview 在应用内查看。
     代码应 catch 并降级（如提示"请在 BobWork 画布内打开"），不得用 alert；
  4. 需要操作节点本身（增删改查、移动、打标题等）而不依赖当前画布视图时，优先用 hostTool 的节点类工具。`;

const CHAT_DOC = `【AI 接入策略 — 何时该主动询问用户】
是否给小程序接入 AI，按以下两级判断（避免擅自加 AI 打扰用户，也避免该加时不问）：
  A. 用户主动要求（情形 1）-> 直接接入并调用（完全信任下无需申请授权，也不要生成授权按钮/提示），无需再问。
  B. 用户未提及，但小程序核心功能天然依赖 AI（情形 2）-> 在生成代码前，先用一句话向用户确认："这个小程序看起来需要 AI 能力（如翻译/总结/问答/文案生成），需要我接入吗？"
     典型应主动询问的功能：翻译、智能问答、内容总结、文案/创意生成、语义分类、情感分析、对话式交互等。
     典型不应询问的纯工具功能：计算器、倒计时、待办清单、表单填写、单位换算、文件格式转换、数据图表展示等--这些加了 AI 反而多余，不要问。
     用户回复"不用"或未明确同意 -> 不接入，按纯前端实现；用户同意 -> 按情形 1 接入。
  C. 纯工具型小程序 -> 不询问、不接入，避免弹授权框打扰用户。
  D. 用户明确禁止调用 AI（情形 4）-> 绝对禁止接入。不得生成任何 chatRequestPermission / chat / chatStream 调用代码，不得询问"是否需要 AI"，不得以任何理由在代码中引入模型调用。即使小程序功能看起来需要 AI，也必须用纯前端方案实现。此规则优先级最高，覆盖以上所有情形。

【小程序模型调用 API（chat）— 已放开权限，直接调用即可】
chat* 系列动作用于让小程序直接调用 AI 模型（无工具、纯文本裸对话）。
2026-10-10 起宿主默认「完全信任」：**不需要再申请授权、也不会弹任何确认框**，直接调用即可。规则：
  1. 不要写"先申请授权"的交互（BobWork.request('chatRequestPermission') 仍可用，但不再弹窗，仅返回 { granted:true }），也不要在 UI 上做授权按钮/提示；
  2. 调用示例：const res = await BobWork.request('chat', { model: 'deepseek:deepseek-flash', messages: [{ role: 'user', content: '...' }], maxTokens: 4096 });
     - model **必填**，格式 provider:modelId（**没有 Auto 选项**：新代码必须显式指定具体模型，不要依赖宿主兜底）；
     - provider 只要已配置 API Key 即可使用（不限 selectedModels 勾选范围）；
     - 纯文本进出，默认输出 8192 tokens，最大支持 32768 tokens，无 PII 脱敏（亲儿子模式数据不篡改）；
  3. 流式调用（长回复/打字机效果一律优先用它：chat 是非流式、客户端 120s 超时，超长生成会被判失败）：const handle = BobWork.chatStream({ model: 'deepseek:deepseek-flash', messages, maxTokens, onDelta: (text) => { /* 追加到输出 */ } });
     - 返回 handle.promise 等待最终结果（{ model, provider, usage }），handle.abort() 可中途停止生成；
     - 每段增量文本经 onDelta 回调实时获得，用于逐字渲染；与 chat 相同鉴权/无硬 token 上限；
  4. 模型不可用 / 超限 / 用户显式撤销了该小程序权限时会 reject，代码必须 catch 并给出友好提示（如"模型调用失败"），不得用 alert。

【模型选择流程 — 用户同意接入 AI 后必须执行】
当用户同意接入 AI（情形 1 或情形 2 用户确认后），你必须按以下步骤执行模型选择流程：
  1. 立即调用 list_configured_models 工具（无需参数），获取用户已配置的模型池；
  2. 将返回的可用模型以易读列表呈现给用户，格式示例：
     "你已配置以下可用模型：\\n  • DeepSeek: deepseek-flash（快速对话）\\n  • Qwen: qwen-max（长文本理解）\\n  • Zhipu GLM: glm-4-flash（轻量快速）\\n请选择一个模型（回复模型名即可）。"
     - 如果模型池为空（返回 empty: true），告知用户："当前还没有配置任何模型，请先在 Manage Models 中添加厂商 API Key 并勾选模型，然后告诉我继续。"
     - 等待用户选择后再生成代码，不要跳过此步。
  3. 根据用户选择的模型，在小程序 UI 中添加一个模型选择按钮（下拉菜单或胶囊切换），具体规范：
     - 按钮位置：放在输入框上方或右上角，与 AI 功能区域关联；
     - 按钮样式：胶囊/芯片形，显示当前选中的模型简称（如 "DeepSeek V4"），点击展开下拉列表；
     - 下拉列表：列出 list_configured_models 返回的所有可用模型，每项显示厂商 + 模型名 + 简短描述；
     - 下拉列表只列具体模型，不要出现 "Auto" 之类的自动选择项；
     - 首次使用默认选中 list_configured_models 里 isDefault:true 的那条（无则第一条）；用户选择后，将 model 值（provider:modelId 格式）保存到 BobStorage.set('selectedModel', modelId)；
     - 调用 chat 时读取本地存储的 model 值传入：const model = BobStorage.get('selectedModel'); BobWork.request('chat', { model, messages, ... })；
     - model 为空时不要发请求：提示用户先选择模型（宿主不会再代替用户自动挑）。
  4. 模型选择按钮的交互细节：
     - 默认选中第一条可用模型（首次使用）；
     - 切换模型后立即生效（下次调用 chat 时使用新模型），无需重新授权；
     - 按钮文案使用英文（如 "Model: DeepSeek V4"），不用中文；
     - 配色跟随小程序主题（用 var(--primary) 等 CSS 变量），不要写死色值。`;

const HOST_TOOL_DOC = `【宿主全能力直通（hostTool）— 小程序与画布 AI 同权，无限制操作 BobWork】
小程序已获「完全信任」：宿主工具注册表里的**任意**工具都能直接调用，与画布节点里的 AI Agent 完全同权，
且不弹任何确认框。用法：
  1. 发现能力：const tools = await BobWork.listHostTools();  // [{ name, description, category, scenes }]
  2. 调用：const r = await BobWork.host(name, args);  // → { success, result, durationMs }
     等价写法：BobWork.request('hostTool', { name, args })
  3. 常用工具名（参数与宿主 AI 一致）：
     - read_file { path } / write_file { path, content } / edit_code { … }：读写项目文件（相对路径以当前项目为根，如 homework/xxx.md）
     - list_directory { path } / search_files { … } / rename_file / delete_file / sandbox_rollback { appId, file, action }（小程序文件的历史版本回滚）
     - run_command { cmd } / execute_script { language, script }：跑命令与脚本（安装类命令 180s，其余 30s）
     - create_project { name } / switch_project { … } / list_projects：直接创建、切换项目
     - Butler / 笔记 / 日历 / 检索 / 浏览器 / OCR / Office / MCP（mcp__<server>__<tool>）等全部工具
  4. 典型场景：做"项目文件浏览器""一键跑脚本""日程+待办总控台""批量整理笔记"时，直接用 hostTool，不必等用户开口；
  5. 仍需遵守的硬护栏（调用失败会返回错误，不要绕过）：writeWanted 写入 butler/ 时，Butler 自己的少数真源/状态文件（preferences.md、roles.json、notify-state.json 等根文件）会被拒绝——注意这只是**这几条**的保护，不是全局安全边界；
     破坏性命令（rm -rf、覆盖用户文件）先向用户说明将要做什么，再执行；每次调用都会落 bob-sandbox/audit.log 审计。`;

/** 主程序共享资源（完整 action 清单在运行时用 BobWork.listActions() 查；此处只给常用项） */
function hostResourcesDoc(): string {
  return `【主程序共享资源 API — 只读接口默认可用】
小程序作为 BobWork 原生组件，调用以下只读接口读取主程序资源，打造信息门户/工作面板类体验：
  - Butler 系列：readWantedTodo（待办看板）、readWantedNotebook（个人记录索引）、readWantedPreferences（偏好配置）—— 做全局待办面板、个人偏好驱动 UI 等场景直接用
  - 节点信息系列：listNodes、readNode、getNodeAncestorChain、getNodeManifest —— 做节点导航/检索/目录页等场景直接用
  - 技能与模型：searchSkills、listConfiguredModels —— 做能力缺口检测、模型选择 UI 等场景直接用
  - 项目与配置：listProjects、getAppConfig、getProjectInfo、getTheme —— 做项目切换、主题适配、总览仪表盘等场景直接用
  - 日历提醒：listCalendarEvents —— 做今日日程/待办提醒面板直接用
  - 写入类接口（writeWanted）：仍需用户明确提及"写入 butler"场景才使用，避免误写全局交付目录
  - 通过注入的 window.BobWork.request(action, data) 调用：
  - 调用示例：const nodes = await BobWork.request('listNodes', {}); const todo = await BobWork.request('readWantedTodo', {});
  - **完整 action 清单与参数在运行时用 BobWork.listActions() 查询**（不要凭记忆猜 action 名）；
  - 需要更多宿主能力（文件/命令/项目/Butler/MCP）时，用 window.BobWork.host(...)，文档见 hostTool 分区。`;
}

/** 读取指定分区的完整文档；未知分区返回索引 + 提示。 */
export function renderCodingDoc(section: string | undefined): string {
  const key = String(section ?? '').trim() as CodingDocSection;
  if (key === 'storage') return STORAGE_DOC;
  if (key === 'host') return hostResourcesDoc();
  if (key === 'graph') return GRAPH_DOC;
  if (key === 'chat') return CHAT_DOC;
  if (key === 'hostTool') return HOST_TOOL_DOC;
  return `未知分区「${String(section ?? '')}」。可用分区：\n${CODING_DOC_SECTIONS.map((s) => `- ${s.key}：${s.label} — ${s.when}`).join('\n')}`;
}
