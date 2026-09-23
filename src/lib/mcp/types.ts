/**
 * MCP (Model Context Protocol) 类型定义
 *
 * 支持两种传输方式：
 *   - stdio: 本地启动 npx 进程，通过 stdin/stdout 通信
 *   - streamable-http: 远程 HTTP 端点
 */

/** MCP 服务器传输类型 */
export type McpTransport = 'stdio' | 'streamable-http';

/** API Key 授权方案（预置服务简化配置用） */
export interface McpAuthScheme {
  /** API Key 放置位置 */
  placement:
    | { kind: 'header'; key: string; template: string }
    | { kind: 'env'; key: string };
  /** 输入框占位符 */
  placeholder: string;
  /** 申请 API Key 的链接 */
  signupUrl: string;
  /** 简短说明 */
  description: string;
}

/** MCP 服务器配置 */
export interface McpServerConfig {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 传输类型 */
  transport: McpTransport;
  /** stdio: 命令（如 npx） */
  command?: string;
  /** stdio: 命令参数 */
  args?: string[];
  /** stdio: 环境变量 */
  env?: Record<string, string>;
  /** streamable-http: 远程 URL */
  url?: string;
  /** streamable-http: 自定义请求头（如 Authorization） */
  headers?: Record<string, string>;
  /** 超时时间（秒） */
  timeout?: number;
  /** 依赖的其它 MCP server id：这些 server 必须先连接成功，本 server 才挂载（插件依赖管理） */
  dependsOn?: string[];
  /** 健康检查周期（秒）；>0 时周期性 ping（listTools），失败计入 failCount 供自愈 */
  healthCheckIntervalSec?: number;
  /** 是否对普通 chat 节点（aiChat/aiCoding）暴露工具。
   *  undefined/true = 暴露（默认）；false = 仅限专属节点通过专用路由调用（如 Bobby node 走 /api/bobby）。
   *  注意：此开关不影响 MCP 连接本身（syncServers 仍按 enabled 连接），仅控制工具注入。 */
  exposeToChatNodes?: boolean;
  /** 不注入模型上下文的工具名（按 MCP 工具名精确匹配，如授权管理类工具）。
   *   仅专属节点经专用路由可调用（如 Bobby node 走 /api/bobby），普通 chat 节点模型看不到。 */
  excludeToolsFromModel?: string[];
  /** 是否启用 */
  enabled: boolean;
  /** 本地内置能力标记（历史兼容：仅作开关不建立 MCP 连接；新配置一律用真实 MCP server） */
  builtin?: boolean;
  /** 预置服务的 API Key 授权方案 */
  authScheme?: McpAuthScheme;
  /**
   * 插件面板声明：该 MCP 服务自带可视化界面，启用后可出现在宿主右侧预览面板（插件面板注册表数据源）。
   * 写在预置（MCP_PRESETS）上 = 出厂随包面板；写在实例配置上 = 自定义/市场插件自带面板。
   */
  panel?: PluginPanelDecl;
}

/** 插件自带界面（Web 面板）声明 */
export interface PluginPanelDecl {
  /** 托管形态：serve = 插件自起本地网页（宿主 iframe 内嵌，先探测 statusPath 就绪）；static = 随包静态目录（宿主 /api/plugin-panel/<id> 代理，零端口） */
  mode: 'serve' | 'static';
  /** serve: 页面基址（无结尾斜杠），如 http://127.0.0.1:9482 */
  url?: string;
  /** serve: 就绪探测端点（相对 url），如 /api/status */
  statusPath?: string;
  /** static: 随包静态目录，相对插件包目录（如 panel）；绝对路径也可直接用 */
  staticRoot?: string;
}

/** MCP 工具信息（从 MCP server 发现的工具） */
export interface McpToolInfo {
  /** 工具完整名称（带 mcp__ 前缀） */
  fullName: string;
  /** 工具原始名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** JSON Schema 参数 */
  inputSchema: Record<string, unknown>;
  /** 所属 MCP 服务器 ID */
  serverId: string;
  /** 所属 MCP 服务器名称 */
  serverName: string;
}

/** 预置 MCP 服务器（作为市场可下载条目的配置模板 + 设置面板 Add New 预设） */
export const MCP_PRESETS: McpServerConfig[] = [
  {
    id: 'context7',
    name: 'Context7',
    transport: 'streamable-http',
    url: 'https://mcp.context7.com/mcp',
    // 默认关闭：Context7 为编码专用（查框架/库文档），普通对话不注入其 schema；
    // coding 节点用户需要时在设置面板手动开启。
    enabled: false,
  },
  {
    id: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {},
    enabled: false, // 需要 GITHUB_PERSONAL_ACCESS_TOKEN
    authScheme: {
      placement: { kind: 'env', key: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
      placeholder: 'Paste your GitHub Personal Access Token',
      signupUrl: 'https://github.com/settings/tokens',
      description: 'GitHub MCP 需要 Personal Access Token 才能操作仓库。',
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-notion'],
    env: {},
    enabled: false, // 需要 NOTION_API_KEY
    authScheme: {
      placement: { kind: 'env', key: 'NOTION_API_KEY' },
      placeholder: 'Paste your Notion Integration API Key',
      signupUrl: 'https://www.notion.so/my-integrations',
      description: 'Notion MCP 需要 Integration API Key 才能读写页面。',
    },
  },
  {
    id: 'pkulaw',
    name: '北大法宝·法律智能检索',
    transport: 'streamable-http',
    url: 'https://apim-gateway.pkulaw.com/mcp-law-agg/1.0.0/mcp',
    headers: {},
    timeout: 60,
    // 默认开启：法律场景常用检索；未填 API Key 时连接失败自动自愈重试（设置面板可关闭）
    enabled: true,
    authScheme: {
      placement: { kind: 'header', key: 'Authorization', template: 'Bearer {KEY}' },
      placeholder: 'Paste your pkulaw API Key',
      signupUrl: 'https://mcp.pkulaw.com/?bd_vid=11453799322082726212',
      description: '北大法宝需要 API Key 才能检索法规与案例，结果均带原文链接。',
    },
  },
  {
    id: 'tianyancha',
    name: '天眼查·企业信息检索',
    transport: 'streamable-http',
    url: 'https://mcp.tianyancha.com/v1',
    headers: {},
    timeout: 60,
    // 默认开启：企业工商/风险查询常用；未填 API Key 时连接失败自动自愈重试（设置面板可关闭）
    enabled: true,
    authScheme: {
      placement: { kind: 'header', key: 'Authorization', template: 'Bearer {KEY}' },
      placeholder: 'Paste your Tianyancha API Key',
      signupUrl: 'https://open.tianyancha.com/',
      description: '天眼查需要 API Key 才能查询企业工商、风险、知识产权等数据。',
    },
  },
  {
    id: 'coze',
    name: 'Coze (扣子)',
    // 随包分发的本地 MCP 插件（扣子 OpenAPI 桥，api.coze.cn）：args 用 {BUNDLED}: 占位符，
    // server 端（settings-server.ts）按运行环境解析为绝对路径（同 bob-team-mcp 等）。
    // 提供 list_spaces / list_bots / list_workflows / chat_bot / run_workflow 五个工具：
    // 在 BobWork 里对话扣子上已发布为「API 服务」的 bot、运行其工作流（推理在扣子云端）。
    // PAT 由面板 authScheme 配置（env COZE_API_TOKEN，密文存 settings，spawn 时解密注入）。
    transport: 'stdio',
    command: 'node',
    args: ['{BUNDLED}:coze-mcp/dist/cli.js'],
    timeout: 300, // bot 对话需轮询 retrieve（最长约 4 分钟），工作流同步运行可能数十秒
    enabled: false, // 需 PAT；market 安装后默认启用，未填有效 PAT 时连接失败自动自愈重试（设置面板可关闭）
    authScheme: {
      placement: { kind: 'env', key: 'COZE_API_TOKEN' },
      placeholder: 'Paste your Coze Personal Access Token',
      signupUrl: 'https://www.coze.cn/open/pat',
      description:
        'Coze MCP 需要 Personal Access Token（PAT）才能调用扣子 API。创建 PAT 时勾选 chat / getChat / listMessage / listWorkspace / listBot / listWorkflow / run 权限；要对话的 bot 需先「发布为 API 服务」。',
    },
  },
  {
    id: 'bob-browser-mcp',
    name: 'Bob Browser',
    // 桥以常驻模式运行（bob-browser-mcp --serve，端口 9473），单实例锁会拒绝第二个 stdio 实例，
    // 因此必须以 Streamable HTTP 形式接入，否则连接永远失败（工具不注册、AI 看不到浏览器工具）。
    transport: 'streamable-http',
    url: 'http://127.0.0.1:9473/mcp?token=TOKEN_PLACEHOLDER',
    timeout: 60,
    // 非出厂默认项：不在 SYSTEM_MCP_IDS，仅用户从 MCP 市场手动添加时装配；
    // enabled=true 只表示「添加后默认启用」。定位：Hippo 缺「真实 Chrome 身份」时的互补通道
    // （登录态/书签/密码管理），需全局安装 bob-browser-mcp（--serve 常驻）+ 浏览器扩展绑定，
    // 未就绪时连接失败自动自愈重试（设置面板可关闭）
    enabled: true,
  },
  {
    id: 'bob-ocr-mcp',
    name: 'Bob OCR',
    // 常驻 daemon（bob-ocr-mcp --serve，端口 9478，token 鉴权）须以 Streamable HTTP 接入；
    // token 由 daemon 生成（~/.bob-ocr-mcp/token.json），运行时由 manager 按 /setup/status 自动刷新，
    // 故 url 里的占位 token 会在首次同步时被替换为真实值（同 bob-browser-mcp）。
    transport: 'streamable-http',
    url: 'http://127.0.0.1:9478/mcp?token=TOKEN_PLACEHOLDER',
    timeout: 300, // 大 PDF 整份识别（本地 Vision 逐页）可能达 1-2 分钟
    // 默认开启：daemon 未安装/未启动时连接失败自动自愈重试（设置面板可关闭）
    enabled: true,
  },
  {
    id: 'bobby',
    name: 'Bobby node',
    // 随包分发的本地 MCP 插件（桌面软件控制中枢）：args 用 {BUNDLED}: 占位符，
    // server 端（settings-server.ts bundledPluginPath）按运行环境解析为绝对路径：
    //   安装版 cwd = next-standalone → <cwd>/bobby-mcp/dist/cli.js
    //   dev 模式 cwd = projects      → <仓库根>/bobby-mcp/dist/cli.js
    // 2026-09-18 修正：原硬编码 /Users/baolei/Desktop/BobAgent/bobby-mcp/dist/cli.js
    // 指向的工作区已迁移为 BobWork，绝对路径永久失效（bundledPluginPath 有 existsSync 校验，
    // 用占位符可随环境自适应，不会再因目录改名而断链）。
    // 桌面控制工具：ui_act（CGEvent 键鼠 + AX 语义树定位）/ run_command / dispatch_desktop
    // / check_permissions / grant_app 等授权管理 / abort 急停 / get_status · list_history。
    transport: 'stdio',
    command: 'node',
    args: ['{BUNDLED}:bobby-mcp/dist/cli.js'],
    timeout: 300, // orchestrate 可能触发本地模型长推理
    enabled: false, // 需要先构建 bobby-mcp（npm run build），在设置面板开启
    // 插件启用即对主 Agent 开放（2026-08-25 简化：不再单独控制 exposeToChatNodes）
    // 授权管理工具不注入主 Agent 上下文（防模型自我授权/自我放行绕过授权确认）：仅 BobbyNode 经 /api/bobby 可操作
    excludeToolsFromModel: ['grant_app', 'revoke_grant', 'list_grants', 'set_temp_allow', 'abort'],
  },
  {
    id: 'team',
    name: 'Agent Teams',
    // 随包分发的本地 MCP 插件（多成员编排）：args 用 {BUNDLED}: 占位符，
    // server 端（settings-server.ts）按运行环境解析为绝对路径：
    //   安装版 cwd = next-standalone → <cwd>/bob-team-mcp/dist/cli.js
    //   dev 模式 cwd = projects      → <仓库根>/bob-team-mcp/dist/cli.js
    // 提供 team_create/plan/approve/status、task_add/status、msg_*、quality_* 等 17 个工具，
    // 仅供宿主内置工具 team_run（lib/chat/team-run.ts）内部闭环调用；这些裸工具不注入模型。
    transport: 'stdio',
    command: 'node',
    args: ['{BUNDLED}:bob-team-mcp/dist/cli.js'],
    timeout: 300, // 成员任务执行可能达分钟级（/api/chat 长推理）
    // 系统插件，默认启用：仅代表插件进程随宿主待命，**不等于**会自动发起多智能体协作——
    // 协作的唯一入口是 chat 节点「Multi-agent mode」开关（激活 team 场景注入 team_run），
    // 关掉开关即恢复单 agent。仍可在 Installed · Plugins 手动关掉本插件（关后开关会提示未启用）。
    enabled: true,
  },
  {
    id: 'bob-preview-mcp',
    name: 'Bob Preview',
    // 随包分发的本地 MCP 插件（网页/小程序预览渲染）：真实 headless Chromium (CDP) 截图
    // 与交互测试，替代前端 iframe 的 DOM→SVG 序列化路径。提供 capture_preview / interact_preview 两工具。
    // 依赖系统 Google Chrome（BOB_CHROME_PATH 可覆盖）；首次工具调用时惰性启动 headless 实例。
    transport: 'stdio',
    command: 'node',
    args: ['{BUNDLED}:bob-preview-mcp/dist/cli.js'],
    timeout: 120, // headless Chrome 冷启动 + 页面加载可能达数十秒
    enabled: true,
    healthCheckIntervalSec: 0, // 惰性启动，不做周期健康检查（避免空转拉起 Chrome）
  },
  {
    id: 'bob-notes-mcp',
    name: 'Bob Notes',
    // 随包分发的本地 MCP 插件（个人知识库 · Karpathy LLM Wiki）：
    // 笔记实现（raw/wiki/ingest/review/lint）全部在插件域
    // （BobWork 托管数据根 ~/BobWork/extensions/bob-notes-mcp；--serve 拉起 web 面板），
    // 宿主仅保留 /api/notebook 转发门面 + iframe 面板壳。--serve 拉起插件自带 web 面板
    // （默认 9480，供 CanvasFlow iframe 嵌入）。提供 notes_add_raw/ingest/query/get/update/
    // delete/review/lint/backfill/config_*/stats 工具，供宿主门面与专属笔记节点调用。
    transport: 'stdio',
    command: 'node',
    args: ['{BUNDLED}:bob-notes-mcp/dist/cli.js', '--serve'],
    timeout: 300, // ingest 编译（插件大脑模型长推理）可能达分钟级
    enabled: true,
    // 自带 Web 面板（--serve 默认 9480）：宿主右侧预览面板通用插件 Tab 的内嵌入口（注册表数据源）
    panel: { mode: 'serve', url: 'http://127.0.0.1:9480', statusPath: '/api/status' },
    // 工具不注入普通 chat 节点（避免与宿主已有的 read_notebook 等别名工具重复）；
    // 仅宿主 /api/notebook 门面经 mcpManager 转发调用（同 bob-team-mcp 走 team_run 的模式）。
    exposeToChatNodes: false,
  },
  {
    id: 'bob-mind-mcp',
    name: 'Bob-Mind',
    // 随包分发的本地 MCP 插件（独立思维便签库 · Bob-Mind）：
    // 数据与 UI 全部在插件域（宿主注入数据根 ~/BobWork/extensions/bob-mind-mcp；
    // --serve 拉起插件自带 web 面板，默认 9482，供宿主 iframe 嵌入），
    // 宿主不内置任何便签实现，仅注册本服务 + ⌘F 面板壳。
    // 提供 mind_save/save_tree/query/get/update/delete/move/star/export/status 工具（场景注入见 tools.ts）。
    transport: 'stdio',
    command: 'node',
    args: ['{BUNDLED}:bob-mind-mcp/dist/cli.js', '--serve'],
    timeout: 120,
    enabled: true,
    // 自带 Web 面板（--serve 默认 9482）：宿主右侧预览面板通用插件 Tab 的内嵌入口（注册表数据源）
    panel: { mode: 'serve', url: 'http://127.0.0.1:9482', statusPath: '/api/status' },
    // 工具随场景注入 chat（MCP_SERVER_SCENES 标注 general），AI 可直接读写 Bob-Mind
  },
];

/** 系统 MCP 服务（随包 bundled，BobWork 核心功能依赖）：出厂默认装配，Installed 中作为 System 服务展示 */
export const SYSTEM_MCP_IDS: string[] = ['team', 'bob-preview-mcp', 'bob-notes-mcp', 'bob-mind-mcp'];

/**
 * 会出现在 Node 的 MCP 下拉中的服务（「插件 vs MCP」分区的 MCP 类）：
 * 以工具形式供节点强制启用/按需注入的外部 MCP 服务；
 * Plugins 类（Notes/OCR/Preview/Teams/Browser/Bobby）由各自面板/节点/服务入口管理，不进节点下拉。
 */
export const NODE_MCP_TOOL_IDS: ReadonlySet<string> = new Set(['github', 'notion', 'context7', 'pkulaw', 'tianyancha', 'coze']);

/**
 * 出厂默认装配：仅系统服务随 BobWork 自带。
 * 其余预置（github/notion/context7/pkulaw/tianyancha/bob-browser-mcp/bobby 等）
 * 一律经 MCP 市场按需下载添加，避免出厂即连未授权服务、免去用户手工配置。
 */
export const DEFAULT_MCP_SERVERS: McpServerConfig[] = MCP_PRESETS.filter((p) => SYSTEM_MCP_IDS.includes(p.id));
