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
    id: 'bob-browser-mcp',
    name: 'Bob Browser',
    // 桥以常驻模式运行（bob-browser-mcp --serve，端口 9473），单实例锁会拒绝第二个 stdio 实例，
    // 因此必须以 Streamable HTTP 形式接入，否则连接永远失败（工具不注册、AI 看不到浏览器工具）。
    transport: 'streamable-http',
    url: 'http://127.0.0.1:9473/mcp?token=TOKEN_PLACEHOLDER',
    timeout: 60,
    // 默认开启：浏览器自动化常用；需要全局安装 bob-browser-mcp（--serve 常驻）+ 浏览器扩展绑定，
    // 未就绪时连接失败自动自愈重试（设置面板可关闭）
    enabled: true,
  },
  {
    id: 'bobby',
    name: 'Bobby node',
    // Phase 2 开发期用绝对路径指向工作区内的 MCP 构建产物；发布版应改为全局安装路径或相对路径。
    // 编排 MCP 提供 detect_agents / set_agent_whitelist / get_agent_status / orchestrate 四个工具。
    transport: 'stdio',
    command: 'node',
    args: ['/Users/baolei/Desktop/BobAgent/bobby-mcp/dist/cli.js'],
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
    // 侧边栏 Agent Teams 面板经 /api/team 转调。
    transport: 'stdio',
    command: 'node',
    args: ['{BUNDLED}:bob-team-mcp/dist/cli.js'],
    timeout: 300, // 成员任务执行可能达分钟级（/api/chat 长推理）
    enabled: false, // 默认关闭：多成员编排较重，需时在 Installed · Plugins 手动开启
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
    // 工具不注入普通 chat 节点（避免与宿主已有的 read_notebook 等别名工具重复）；
    // 仅宿主 /api/notebook 门面经 mcpManager 转发调用（同 /api/team 模式）。
    exposeToChatNodes: false,
  },
];

/** 系统 MCP 服务（随包 bundled，BobWork 核心功能依赖）：出厂默认装配，Installed 中作为 System 服务展示 */
export const SYSTEM_MCP_IDS: string[] = ['team', 'bob-preview-mcp', 'bob-notes-mcp'];

/**
 * 会出现在 Node 的 MCP 下拉中的服务（「插件 vs MCP」分区的 MCP 类）：
 * 以工具形式供节点强制启用/按需注入的外部 MCP 服务；
 * Plugins 类（Notes/OCR/Preview/Teams/Browser/Bobby）由各自面板/节点/服务入口管理，不进节点下拉。
 */
export const NODE_MCP_TOOL_IDS: ReadonlySet<string> = new Set(['github', 'notion', 'context7', 'pkulaw', 'tianyancha']);

/**
 * 出厂默认装配：仅系统服务随 BobWork 自带。
 * 其余预置（github/notion/context7/pkulaw/tianyancha/bob-browser-mcp/bobby 等）
 * 一律经 MCP 市场按需下载添加，避免出厂即连未授权服务、免去用户手工配置。
 */
export const DEFAULT_MCP_SERVERS: McpServerConfig[] = MCP_PRESETS.filter((p) => SYSTEM_MCP_IDS.includes(p.id));
