/**
 * MCP 客户端管理器 — 单例
 *
 * 管理所有 MCP 服务器连接，提供工具发现和调用能力。
 * 连接持久化，跨请求复用。
 *
 * 使用方式：
 *   const manager = McpClientManager.getInstance();
 *   await manager.syncServers(configs);  // 同步配置
 *   const tools = await manager.discoverTools();  // 发现所有工具
 *   const result = await manager.callTool(fullName, args);  // 调用工具
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { homedir } from 'os';
import { join } from 'path';
import type { McpServerConfig, McpToolInfo } from './types';

/** 构建子进程 PATH（与 electron/main.ts 的 buildChildPath 一致） */
function buildChildPath(): string {
  const home = homedir();
  const paths: string[] = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  // nvm
  try {
    const fs = require('fs');
    const nvmDir = join(home, '.nvm/versions/node');
    if (fs.existsSync(nvmDir)) {
      for (const ver of fs.readdirSync(nvmDir)) {
        paths.push(join(nvmDir, ver, 'bin'));
      }
    }
  } catch {}
  // volta
  paths.push(join(home, '.volta/bin'));
  // npm global
  paths.push(join(home, '.npm-global/bin'));
  // 当前 process.env.PATH
  if (process.env.PATH) {
    paths.push(...process.env.PATH.split(':'));
  }
  return [...new Set(paths)].join(':');
}

/** MCP 连接实例 */
interface McpConnection {
  client: Client;
  serverId: string;
  serverName: string;
  connected: boolean;
}

class McpClientManager {
  private connections = new Map<string, McpConnection>();
  private configs: McpServerConfig[] = [];
  private syncing = false;

  private static instance: McpClientManager | null = null;
  static getInstance(): McpClientManager {
    if (!this.instance) this.instance = new McpClientManager();
    return this.instance;
  }

  /** 同步 MCP 服务器配置：连接新增的、断开移除的 */
  async syncServers(configs: McpServerConfig[]): Promise<void> {
    this.configs = configs;
    const enabledIds = new Set(configs.filter((c) => c.enabled).map((c) => c.id));
    const currentIds = new Set(this.connections.keys());

    // 断开已移除或已禁用的
    for (const id of currentIds) {
      if (!enabledIds.has(id)) {
        await this.disconnect(id);
      }
    }

    // 连接新增的
    for (const config of configs) {
      if (!config.enabled) continue;
      if (this.connections.has(config.id)) continue;
      await this.connect(config).catch((e) => {
        console.error(`[MCP] 连接 ${config.name} 失败:`, e);
      });
    }
  }

  /** 连接到一个 MCP 服务器 */
  private async connect(config: McpServerConfig): Promise<void> {
    try {
      let transport: StdioClientTransport | StreamableHTTPClientTransport;

      if (config.transport === 'stdio') {
        const childPath = buildChildPath();
        transport = new StdioClientTransport({
          command: config.command || 'npx',
          args: config.args || [],
          env: {
            ...process.env,
            PATH: childPath,
            ...(config.env || {}),
          } as Record<string, string>,
        });
      } else {
        // streamable-http
        transport = new StreamableHTTPClientTransport(
          new URL(config.url || ''),
        );
      }

      const client = new Client({
        name: 'bob-agent',
        version: '1.0.0',
      }, {
        capabilities: {},
      });

      await client.connect(transport);

      this.connections.set(config.id, {
        client,
        serverId: config.id,
        serverName: config.name,
        connected: true,
      });

      console.log(`[MCP] 已连接: ${config.name} (${config.id})`);
    } catch (e) {
      console.error(`[MCP] 连接 ${config.name} 失败:`, e);
    }
  }

  /** 断开一个 MCP 连接 */
  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    try {
      await conn.client.close();
    } catch {}
    this.connections.delete(serverId);
    console.log(`[MCP] 已断开: ${conn.serverName} (${serverId})`);
  }

  /** 断开所有连接 */
  async disconnectAll(): Promise<void> {
    for (const id of this.connections.keys()) {
      await this.disconnect(id);
    }
  }

  /** 发现所有已连接服务器的工具 */
  async discoverTools(): Promise<McpToolInfo[]> {
    const allTools: McpToolInfo[] = [];

    for (const conn of this.connections.values()) {
      if (!conn.connected) continue;
      try {
        const result = await conn.client.listTools();
        for (const tool of result.tools) {
          allTools.push({
            fullName: `mcp__${conn.serverId}__${tool.name}`,
            name: tool.name,
            description: tool.description || `MCP tool: ${tool.name}`,
            inputSchema: tool.inputSchema as Record<string, unknown>,
            serverId: conn.serverId,
            serverName: conn.serverName,
          });
        }
      } catch (e) {
        console.error(`[MCP] 发现工具失败 (${conn.serverName}):`, e);
      }
    }

    return allTools;
  }

  /** 调用 MCP 工具 */
  async callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
    // 解析 fullName: mcp__<serverId>__<toolName>
    const parts = fullName.split('__');
    if (parts.length < 3 || parts[0] !== 'mcp') {
      return `Error: Invalid MCP tool name: ${fullName}`;
    }
    const serverId = parts[1];
    const toolName = parts.slice(2).join('__');

    const conn = this.connections.get(serverId);
    if (!conn) {
      return `Error: MCP server not connected: ${serverId}`;
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args,
      });

      // 提取文本内容
      if (result.content && Array.isArray(result.content)) {
        const texts: string[] = [];
        for (const item of result.content) {
          if (item.type === 'text' && item.text) {
            texts.push(item.text);
          }
        }
        return texts.join('\n') || '(empty result)';
      }

      return JSON.stringify(result.content || result);
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** 获取已连接的服务器列表 */
  getConnectedServers(): { id: string; name: string }[] {
    return Array.from(this.connections.values())
      .filter((c) => c.connected)
      .map((c) => ({ id: c.serverId, name: c.serverName }));
  }

  /** 是否有任何已连接的服务器 */
  hasConnections(): boolean {
    return this.connections.size > 0;
  }
}

/** 导出单例 */
export const mcpManager = McpClientManager.getInstance();
