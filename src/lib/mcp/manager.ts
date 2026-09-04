/**
 * MCP 客户端管理器 — 单例（插件化改造）
 *
 * 参照 deepseek-harness 底层的 Cordis 插件内核，把每个 MCP 服务器视为一个插件：
 *   - 生命周期：Fiber 状态机（pending → loading → active → error → unloading → disposed）
 *   - 可逆副作用：连接建立、健康检查、服务注册均为 effect，卸载时逆序撤销（不留孤儿）
 *   - 依赖管理：config.dependsOn 声明对其它 server 的依赖，依赖未连接则本插件不挂载并记录原因
 *   - 事件总线：插件状态变化可订阅（供 UI/诊断）
 *   - 组合即数据：配置（settings.mcpServers）即插件的装配清单
 *
 * 门面方法签名保持不变（syncServers / discoverTools / callTool / testConnection /
 * getConnectedServers / hasConnections），新增 getPluginStatuses() 暴露运行态。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { homedir } from 'os';
import { isAbsolute, join, resolve, sep } from 'path';
import { bundledDataHome } from '../extensions/bundled-data-home';
import type { McpServerConfig, McpToolInfo } from './types';
import { PluginKernel, type PluginRuntime, type PluginSpec } from './plugin-kernel';

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

/**
 * 清洗 MCP 工具名，使其符合 OpenAI 兼容 API 的 function.name 约束
 * `^[a-zA-Z0-9_-]+$`。部分 MCP 服务（如北大法宝 pkulaw）暴露的工具名
 * 自带点号（如 `mcp-law-search-service.search_article`），直接透传会在
 * 组装工具列表时被模型 API 拒绝（400 Invalid tools[n].function.name）。
 * 仅用于对外暴露名；调用 MCP 时仍通过 toolNameByFullName 还原原始名。
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 归一化鉴权头，防御"Bearer Bearer xxx"类重复前缀（历史配置/直接编辑 JSON 可能产生）。
 * 仅处理 Authorization 头：把连续的 `Bearer ` 前缀收敛为一个（Bearer Bearer xxx → Bearer xxx），
 * 其余头与其它鉴权方案（Basic 等）原样保留。
 */
export function normalizeAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() !== 'authorization') continue;
    out[key] = out[key].replace(/^(Bearer\s+)+/i, 'Bearer ');
  }
  return out;
}

/** MCP 连接运行态（作为插件提供的服务，供 discoverTools / callTool 读取） */
interface McpConnectionState {
  client?: Client;
  /** 超时时间（毫秒），0 表示不限制 */
  timeout: number;
  /** 工具发现缓存：连接变化（重连/重启）后置空，下次 discoverTools 重新拉取 */
  toolsCache: McpToolInfo[] | null;
  /** 连续失败计数（健康检查 / 调用失败用，触发自愈） */
  failCount: number;
}

/** 服务名约定：mcp:<serverId> → McpConnectionState */
function connServiceName(serverId: string): string {
  return `mcp:${serverId}`;
}

/** 建立 MCP 连接（stdio / streamable-http），失败抛错 */
async function createConnection(config: McpServerConfig): Promise<{ client: Client; close: () => Promise<void> }> {
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (config.transport === 'stdio') {
    const childPath = buildChildPath();
    // 随包插件数据根统一：注入 BOB_*_MCP_HOME → ~/BobWork/extensions/<plugin>。
    // 仅登记过的随包插件注入；自定义/未登记 server 不注入；config.env 显式值优先。
    const dataHome = bundledDataHome(config.id);
    transport = new StdioClientTransport({
      command: config.command || 'npx',
      args: [...(config.args || [])],
      env: {
        ...process.env,
        PATH: childPath,
        // 告知 MCP 子进程宿主 /api 服务端口（如 bob-team-mcp 成员执行回调 /api/chat）。
        // 不注入的话子进程会回退到默认端口 —— 5000 被 macOS AirPlay 占用会秒回 403
        ...(process.env.PORT ? { DEPLOY_RUN_PORT: String(process.env.PORT) } : {}),
        ...(dataHome ? { [dataHome.envKey]: dataHome.dir } : {}),
        ...(config.env || {}),
      } as Record<string, string>,
    });
  } else {
    // streamable-http
    const requestInit: RequestInit = {};
    if (config.headers && Object.keys(config.headers).length > 0) {
      requestInit.headers = normalizeAuthHeaders(config.headers);
    }
    const opts: { requestInit?: RequestInit } = {};
    if (Object.keys(requestInit).length > 0) {
      opts.requestInit = requestInit;
    }
    transport = new StreamableHTTPClientTransport(
      new URL(config.url || ''),
      opts,
    );
  }

  const client = new Client({
    name: 'bob-work',
    version: '1.0.0',
  }, {
    capabilities: {},
  });

  await client.connect(transport);
  return {
    client,
    close: async () => {
      try { await client.close(); } catch { /* 已断开忽略 */ }
    },
  };
}

/** 建立/重建连接并刷新工具缓存；失败抛错 */
async function ensureConnected(state: McpConnectionState, config: McpServerConfig): Promise<void> {
  if (state.client) {
    try { await state.client.close(); } catch { /* 忽略 */ }
    state.client = undefined;
  }
  const { client } = await createConnection(config);
  state.client = client;
  state.toolsCache = null; // 连接变化 → 工具发现缓存失效
  state.failCount = 0;
}

/** MCP 服务器 → 插件规格（setup 即插件的可逆副作用集合） */
function mcpServerPlugin(config: McpServerConfig): PluginSpec<McpServerConfig> {
  return {
    id: config.id,
    name: config.name,
    dependencies: config.dependsOn ?? [],
    setup: async (ctx, cfg) => {
      const state: McpConnectionState = {
        timeout: (cfg.timeout ?? 0) * 1000, // 秒 → 毫秒，0 表示不限制
        toolsCache: null,
        failCount: 0,
      };
      try {
        // 连接（失败 → setup 抛错 → 插件 error 状态，不产生孤儿连接）
        await ensureConnected(state, cfg);
        ctx.logger.info(`已连接 (${cfg.transport})`);

        // 对外提供服务：mcp:<id> → 连接状态（卸载时自动移除，可逆）
        ctx.provide(connServiceName(cfg.id), state);

        // 可选健康检查：周期性 ping（listTools），失败计入 failCount（调用侧/下次 sync 自愈）
        if (cfg.healthCheckIntervalSec && cfg.healthCheckIntervalSec > 0) {
          ctx.effect(() => {
            const timer = setInterval(() => {
              void (async () => {
                if (!state.client) return;
                try {
                  await state.client.listTools();
                  state.failCount = 0;
                } catch {
                  state.failCount += 1;
                  ctx.logger.warn(`健康检查失败（连续 ${state.failCount} 次）`);
                }
              })();
            }, cfg.healthCheckIntervalSec! * 1000);
            return () => clearInterval(timer);
          });
        }

        // 卸载时断开连接（可逆）
        return async () => {
          try { await state.client?.close(); } catch { /* 忽略 */ }
          state.client = undefined;
          state.toolsCache = null;
        };
      } catch (e) {
        // 失败路径同样确保连接被回收（避免 setup 中断导致连接泄漏）
        try { await state.client?.close(); } catch { /* 忽略 */ }
        state.client = undefined;
        throw e;
      }
    },
  };
}

/**
 * 拓扑排序：按 dependencies 把插件排成"依赖先挂载"的顺序。
 * 成环或依赖缺失由内核在挂载时标记 error（missingDeps）。
 */
function topologicalSort<T extends { id: string; dependencies?: string[] }>(items: T[]): T[] {
  const ids = new Set(items.map((i) => i.id));
  const visited = new Set<string>();
  const result: T[] = [];
  const visit = (item: T, stack: Set<string>) => {
    if (visited.has(item.id)) return;
    if (stack.has(item.id)) return; // 成环：交给内核标记 error
    stack.add(item.id);
    for (const dep of item.dependencies ?? []) {
      if (!ids.has(dep)) continue; // 非本插件集的依赖（如未来服务依赖）跳过
      const depItem = items.find((i) => i.id === dep);
      if (depItem) visit(depItem, stack);
    }
    stack.delete(item.id);
    visited.add(item.id);
    result.push(item);
  };
  for (const item of items) visit(item, new Set());
  return result;
}

class McpClientManager {
  private kernel = new PluginKernel();
  private configs: McpServerConfig[] = [];
  private configsById = new Map<string, McpServerConfig>();
  /** 正在自愈重连中的 server id（防并发重连） */
  private reconnecting = new Set<string>();
  /** bob-browser-mcp 桥 token 探测节流时间戳（桥重启会轮换 token，>20s 才探测一次） */
  private browserTokenProbeAt = 0;
  /** 清洗后的 fullName → MCP 原始工具名（调用时还原用） */
  private toolNameByFullName = new Map<string, string>();

  private static instance: McpClientManager | null = null;
  static getInstance(): McpClientManager {
    if (!this.instance) this.instance = new McpClientManager();
    return this.instance;
  }

  /**
   * 同步 MCP 服务器配置（组合即数据：配置即插件装配清单）：
   * 挂载新增/缺失的、卸载已移除/禁用的、重启配置变更的；依赖不满足的进入 error 状态并记录原因。
   */
  async syncServers(configs: McpServerConfig[]): Promise<void> {
    // bob-browser-mcp：桥重启会轮换 token，落盘配置里的旧 token 会让连接 401。
    // 同步前探测 /setup/status，token 不一致则就地刷新（运行时，不写盘），
    // 使下方 configChanged 感知变更并触发一次重连。
    await this.refreshBrowserBridgeToken(configs);

    const prev = this.configs;
    this.configs = configs;
    this.configsById = new Map(configs.map((c) => [c.id, c]));

    const enabled = configs.filter((c) => c.enabled && !c.builtin);
    const specs = topologicalSort(enabled.map((c) => mcpServerPlugin(c)));
    const configMap = new Map(enabled.map((c) => [c.id, c]));

    // 检测配置变更（headers / url / env / command / args / dependsOn 等）→ 重启
    const changed = new Set<string>();
    for (const c of enabled) {
      const old = prev.find((x) => x.id === c.id);
      if (old && this.configChanged(c, old)) changed.add(c.id);
    }

    await this.kernel.reconcile(specs, configMap, changed);
  }

  /**
   * bob-browser-mcp 桥 token 自动刷新（节流：>20s 才探测一次）。
   * 桥 /setup/status 返回实时 token；与配置 url 内嵌 token 不一致时，
   * 就地改写该 config 的 url/headers（仅运行时，不落盘）。桥不可达时保持现状。
   */
  private async refreshBrowserBridgeToken(configs: McpServerConfig[]): Promise<void> {
    const now = Date.now();
    if (now - this.browserTokenProbeAt < 20_000) return;
    this.browserTokenProbeAt = now;

    const cfg = configs.find(
      (c) => c.id === 'bob-browser-mcp' && c.enabled && !c.builtin && c.transport === 'streamable-http' && !!c.url,
    );
    const url = cfg?.url || '';
    if (!cfg || !url) return;
    const portMatch = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(url);
    if (!portMatch) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch(`http://127.0.0.1:${portMatch[1]}/setup/status`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as { token?: unknown } | null;
      const token = typeof data?.token === 'string' && data.token ? data.token : null;
      if (!token) return;
      const encoded = encodeURIComponent(token);
      if (url.includes(`token=${encoded}`)) return; // token 未变
      cfg.url = url.replace(/([?&]token=)[^&]*/, `$1${encoded}`);
      if (cfg.headers && typeof cfg.headers.Authorization === 'string' && cfg.headers.Authorization.startsWith('Bearer ')) {
        cfg.headers = { ...cfg.headers, Authorization: `Bearer ${token}` };
      }
    } catch {
      /* 桥不可达：保持现状，等待下一次节流窗口再探测 */
    }
  }

  /** 检测配置是否变更（headers / url / env / command / args / dependsOn 等） */
  private configChanged(config: McpServerConfig, oldConfig: McpServerConfig): boolean {
    const keys: (keyof McpServerConfig)[] = ['url', 'command', 'transport'];
    for (const k of keys) {
      if (config[k] !== oldConfig[k]) return true;
    }
    // args
    const oldArgs = oldConfig.args || [];
    const newArgs = config.args || [];
    if (oldArgs.length !== newArgs.length || oldArgs.some((a, i) => a !== newArgs[i])) return true;
    // dependsOn
    const oldDeps = (oldConfig.dependsOn || []).join(',');
    const newDeps = (config.dependsOn || []).join(',');
    if (oldDeps !== newDeps) return true;
    // headers / env（浅比较）
    if (!shallowEqual(config.headers, oldConfig.headers)) return true;
    if (!shallowEqual(config.env, oldConfig.env)) return true;
    return false;
  }

  /** 测试单个 MCP 服务器连接（不持久化，用完即断开） */
  async testConnection(config: McpServerConfig): Promise<{ success: boolean; toolsCount: number; error?: string; builtin?: boolean; note?: string }> {
    if (config.builtin) {
      return {
        success: true,
        toolsCount: 0,
        builtin: true,
        note: 'Built-in capability: no MCP connection required',
      };
    }
    try {
      const { client, close } = await createConnection(config);
      let toolsCount = 0;
      try {
        const result = await client.listTools();
        toolsCount = result.tools.length;
      } catch { /* 列工具失败不阻断测试结果 */ }
      await close();
      return { success: true, toolsCount };
    } catch (e: any) {
      return { success: false, toolsCount: 0, error: e?.message || 'Connection failed' };
    }
  }

  /**
   * 发现所有已连接（active 插件）服务器的工具。
   * 带连接级缓存：首次发现后缓存，重连/重启时自动失效。
   */
  async discoverTools(): Promise<McpToolInfo[]> {
    const allTools: McpToolInfo[] = [];
    this.toolNameByFullName.clear();

    for (const rt of this.kernel.getAllRuntimes()) {
      if (rt.state !== 'active') continue;
      const state = this.kernel.getService<McpConnectionState>(connServiceName(rt.id));
      if (!state?.client) continue;
      try {
        if (!state.toolsCache) {
          const result = await state.client.listTools();
          state.toolsCache = result.tools.map((tool) => ({
            fullName: '', // 下面统一补
            name: tool.name,
            description: tool.description || `MCP tool: ${tool.name}`,
            inputSchema: tool.inputSchema as Record<string, unknown>,
            serverId: rt.id,
            serverName: rt.name,
          }));
        }
        for (const tool of state.toolsCache) {
          // 对外暴露名清洗为 ^[a-zA-Z0-9_-]+$（pkulaw 等服务的工具名含点号，OpenAI API 会拒绝）
          // serverId 同样需清洗：用户配置的 id 可能含点号/冒号等非法字符
          const safeToolName = sanitizeToolName(tool.name);
          const safeServerId = sanitizeToolName(rt.id);
          const fullName = `mcp__${safeServerId}__${safeToolName}`;
          this.toolNameByFullName.set(fullName, tool.name);
          allTools.push({ ...tool, fullName });
        }
      } catch (e) {
        console.error(`[MCP] 发现工具失败 (${rt.name}):`, e);
      }
    }

    return allTools;
  }

  /** 调用 MCP 工具；连接层异常时自动自愈重连（超时不重试调用，防副作用重复）。
   *  opts.redactArgs=true 时参数不打印到日志（凭据类调用，如 browser.login_fill）。 */
  async callTool(fullName: string, args: Record<string, unknown>, opts?: { redactArgs?: boolean }): Promise<string> {
    if (!fullName.startsWith('mcp__')) {
      return `Error: Invalid MCP tool name: ${fullName}`;
    }
    const rest = fullName.slice(5); // 去掉 'mcp__' 前缀

    let serverId = '';
    let toolName = '';
    for (const id of this.kernel.activeIds()) {
      // 用清洗后的 serverId 匹配前缀（与 discoverTools 拼接逻辑一致）
      const prefix = sanitizeToolName(id) + '__';
      if (rest.startsWith(prefix)) {
        serverId = id;
        toolName = rest.slice(prefix.length);
        break;
      }
    }
    if (!serverId) {
      // 回退：用旧解析方式（兼容 serverId 不含 '__' 的情况）
      const parts = rest.split('__');
      if (parts.length < 2) {
        return `Error: Invalid MCP tool name: ${fullName}`;
      }
      serverId = parts[0];
      toolName = parts.slice(1).join('__');
    }

    const runtime = this.kernel.getRuntime(serverId);
    if (!runtime || runtime.state !== 'active') {
      console.error(`[MCP:callTool] 服务器未连接: ${serverId}, 当前连接: [${[...this.kernel.activeIds()].join(', ')}]`);
      return `Error: MCP server not connected: ${serverId}`;
    }
    const state = this.kernel.getService<McpConnectionState>(connServiceName(serverId));
    if (!state?.client) {
      return `Error: MCP server not connected: ${serverId}`;
    }

    // 还原 MCP 原始工具名：fullName 中工具名部分经过 sanitizeToolName 清洗
    // （pkulaw 等服务的原名含点号，仅对外展示名被清洗，调用必须用原名）
    const originalToolName = this.toolNameByFullName.get(fullName) ?? toolName;

    // bob-ocr-mcp 的 ocr.* 工具要求绝对路径（或 ~/ 前缀），但模型常直接抄上下文里的
    // 项目相对路径（如 attachments/xxx.png）。此处按当前项目根规范化，避免服务端报
    // "path must be absolute" 后模型反复重试（视觉理解链路因此降级）。
    if (serverId === 'bob-ocr-mcp' && args && typeof args.path === 'string' && args.path.trim()) {
      const raw = args.path.trim();
      if (!isAbsolute(raw) && !raw.startsWith('~')) {
        try {
          const { getCurrentProject } = await import('@/lib/project/project-manager');
          const project = await getCurrentProject();
          if (project?.path) {
            const root = resolve(project.path);
            const resolved = resolve(join(root, raw));
            if (resolved === root || resolved.startsWith(root + sep)) {
              args = { ...args, path: resolved };
            }
          }
        } catch { /* 规范化失败保持原样，由服务端报错 */ }
      }
    }

    if (opts?.redactArgs) {
      console.log(`[MCP:callTool] 调用 ${serverId}/${originalToolName}, 参数: <redacted>`);
    } else {
      console.log(`[MCP:callTool] 调用 ${serverId}/${originalToolName}, 参数:`, JSON.stringify(args).slice(0, 200));
    }

    const timeoutMs = state.timeout;
    const doCall = async (): Promise<{ text: string }> => {
      // 关键：SDK Client 默认 requestTimeout = 60s（DEFAULT_REQUEST_TIMEOUT_MSEC），
      // 若这里不传 timeout，任何超过 60s 的调用（如 ingest 编译多条长文）都会先被 SDK 以
      // -32001 Request timed out 中断——即使下方外层 race 给了 300s 也无效（SDK 更早抛）。
      // 显式传 config.timeout（毫秒），让 SDK 请求超时与配置一致；0=不限制时仍给一个兜底大值，
      // 因为 SDK 无法真正禁用请求超时。
      const callPromise = state.client!.callTool(
        {
          name: originalToolName,
          arguments: args,
        },
        undefined,
        { timeout: timeoutMs > 0 ? timeoutMs : 3_600_000 }, // 1h 兜底（0=不限制语义）
      );
      const result = timeoutMs > 0
        ? await Promise.race([
            callPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`MCP 工具调用超时 (${timeoutMs / 1000}s)`)), timeoutMs)
            ),
          ])
        : await callPromise;
      // 检查 isError 标志
      if (result.isError) {
        const errText = Array.isArray(result.content) ? result.content.map((c: any) => c.text || '').join(' ') : 'Unknown error';
        console.error(`[MCP:callTool] ${serverId}/${toolName} 服务端报错:`, errText.slice(0, 300));
        return { text: `Error from server: ${errText}` };
      }
      // 提取文本内容
      if (result.content && Array.isArray(result.content)) {
        const texts: string[] = [];
        for (const item of result.content) {
          if (item.type === 'text' && item.text) {
            texts.push(item.text);
          }
        }
        const output = texts.join('\n') || '(empty result)';
        console.log(`[MCP:callTool] ${serverId}/${toolName} 成功, 输出长度: ${output.length}`);
        return { text: output };
      }
      return { text: JSON.stringify(result.content || result) };
    };

    try {
      const r = await doCall();
      state.failCount = 0;
      return r.text;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const isTimeout = /timeout/i.test(errMsg);
      // 连接层异常 → 触发自愈重连（恢复运输层）；超时不重试调用（防副作用重复）
      await this.reconnectServer(serverId).catch(() => {});
      if (isTimeout) {
        console.error(`[MCP:callTool] ${serverId}/${toolName} 调用超时:`, errMsg);
        return `Error: ${errMsg}`;
      }
      // 非超时异常 → 重连后重试一次
      try {
        const r2 = await doCall();
        state.failCount = 0;
        console.warn(`[MCP:callTool] ${serverId}/${toolName} 自愈重连后重试成功`);
        return r2.text;
      } catch (e2) {
        const err2 = e2 instanceof Error ? e2.message : String(e2);
        console.error(`[MCP:callTool] ${serverId}/${toolName} 调用失败:`, err2);
        return `Error: ${err2}`;
      }
    }
  }

  /** 自愈重连：仅恢复连接运输层（工具缓存自动失效），失败静默（下次调用/sync 再试） */
  private async reconnectServer(serverId: string): Promise<void> {
    if (this.reconnecting.has(serverId)) return;
    this.reconnecting.add(serverId);
    try {
      const config = this.configsById.get(serverId);
      if (!config) return;
      const state = this.kernel.getService<McpConnectionState>(connServiceName(serverId));
      if (!state) return;
      state.failCount += 1;
      await ensureConnected(state, config);
      console.warn(`[MCP] ${config.name} (${serverId}) 已自愈重连`);
    } catch (e) {
      console.warn(`[MCP] ${serverId} 自愈重连失败:`, e instanceof Error ? e.message : e);
    } finally {
      this.reconnecting.delete(serverId);
    }
  }

  /** 断开所有连接（卸载全部 active 插件） */
  async disconnectAll(): Promise<void> {
    for (const id of this.kernel.activeIds()) {
      await this.kernel.unmount(id);
    }
  }

  /** 已连接（active）服务器列表 */
  getConnectedServers(): { id: string; name: string }[] {
    return this.kernel.getAllRuntimes()
      .filter((r) => r.state === 'active')
      .map((r) => ({ id: r.id, name: r.name }));
  }

  /** 全部插件运行态（含 error/missingDeps，供 UI/诊断展示） */
  getPluginStatuses(): PluginRuntime[] {
    return this.kernel.getAllRuntimes();
  }

  /** 订阅插件状态变化；返回退订函数 */
  onPluginStateChange(handler: (change: { id: string; state: string; error?: string }) => void): () => void {
    return this.kernel.onStateChange((c) => handler(c));
  }

  /** 是否有任何已连接的服务器 */
  hasConnections(): boolean {
    return this.kernel.activeIds().size > 0;
  }
}

/** 浅比较两个对象 */
function shallowEqual<T extends Record<string, unknown>>(a?: T, b?: T): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

/** 导出单例 */
export const mcpManager = McpClientManager.getInstance();
