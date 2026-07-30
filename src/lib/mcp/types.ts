/**
 * MCP (Model Context Protocol) 类型定义
 *
 * 支持两种传输方式：
 *   - stdio: 本地启动 npx 进程，通过 stdin/stdout 通信
 *   - streamable-http: 远程 HTTP 端点
 */

/** MCP 服务器传输类型 */
export type McpTransport = 'stdio' | 'streamable-http';

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
  /** 是否启用 */
  enabled: boolean;
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

/** 预置 MCP 服务器 */
export const MCP_PRESETS: McpServerConfig[] = [
  {
    id: 'context7',
    name: 'Context7',
    transport: 'streamable-http',
    url: 'https://mcp.context7.com/mcp',
    enabled: true,
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    enabled: true,
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: {},
    enabled: false, // 需要 BRAVE_API_KEY
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~/BobAgent/sandbox'],
    enabled: false, // 已有内置文件工具，默认关闭
  },
  {
    id: 'playwright',
    name: 'Playwright（浏览器自动化）',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    enabled: false, // 首次需要 playwright install 下载浏览器
  },
  {
    id: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {},
    enabled: false, // 需要 GITHUB_PERSONAL_ACCESS_TOKEN
  },
  {
    id: 'notion',
    name: 'Notion',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-notion'],
    env: {},
    enabled: false, // 需要 NOTION_API_KEY
  },
];
