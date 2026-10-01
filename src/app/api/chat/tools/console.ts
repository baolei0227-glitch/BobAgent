/**
 * Console 场景工具：BobWork 应用状态只读查询（list_agents / list_projects / list_nodes /
 * get_app_status / read_inbox）。
 *
 * 定位：给「Chief of Staff 型助理」（Butler）提供「查应用」的能力——回答"有哪些项目 /
 * 有哪些节点 / 某个插件连上没有 / 有没有待处理回执"这类问题必须来自真实返回，**不得凭印象编造**。
 *
 * 硬约束：**全部只读**。本文件不得出现任何写、删、改操作（DB 只调 listInbox、MCP 只调
 * getPluginStatuses 不调 syncServers——后者会挂载/卸载插件，属副作用）。
 *
 * 依赖方向单向：仅 type-only 依赖 './index'，运行时依赖一律动态 import（与 design.ts / audio.ts 同构）。
 */
import type { Tool } from './index';

/** 统一错误返回：不向模型抛异常，转成可读文案 */
function fail(e: unknown): string {
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}

/** 摘要裁剪：避免超长正文撑爆上下文 */
function clip(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

// ─────────────────────────────── list_agents ───────────────────────────────

/** 列出已安装的 Agent 市场包（含画布可用身份与各自工具场景） */
async function toolListAgents(): Promise<string> {
  try {
    const { listInstalledPackages } = await import('@/lib/agents/market-server');
    const pkgs = listInstalledPackages();
    if (pkgs.length === 0) {
      return JSON.stringify({ count: 0, agents: [], note: '当前没有安装任何 Agent 包（Extensions Store → Agents 可安装）。' });
    }
    const agents = pkgs.map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      /** 该 agent 的固定工具场景：决定它能调用哪些专用工具 */
      scenes: m.fixedScenes ?? [],
      exclusions: m.coreExclusions ?? [],
    }));
    return JSON.stringify({ count: agents.length, agents }, null, 2);
  } catch (e) {
    return fail(e);
  }
}

// ────────────────────────────── list_projects ──────────────────────────────

/** 列出全部项目（含当前项目标记与每个活跃项目的规模统计） */
async function toolListProjects(args: Record<string, unknown>): Promise<string> {
  try {
    const withStats = args.withStats !== false;
    const { listProjects, getProjectStats } = await import('@/lib/project/project-manager');
    const { projects, active_projects, archived_projects, trashed_projects, currentId } = await listProjects();

    const shape = async (p: { id: string; name: string; path: string }) => {
      const base = { id: p.id, name: p.name, path: p.path, isCurrent: p.id === currentId };
      if (!withStats) return base;
      try {
        const st = await getProjectStats(p.id);
        return { ...base, nodeCount: st.nodeCount, dbSizeKB: st.dbSizeKB, createdDaysAgo: st.createdDaysAgo };
      } catch {
        // 单个项目统计失败不影响整体返回
        return { ...base, stats: 'unavailable' };
      }
    };

    const active = await Promise.all(active_projects.map(shape));
    return JSON.stringify(
      {
        currentProjectId: currentId,
        counts: {
          active: active_projects.length,
          archived: archived_projects.length,
          trashed: trashed_projects.length,
          total: projects.length,
        },
        active_projects: active,
        archived_projects: archived_projects.map((p) => ({ id: p.id, name: p.name, archived: true })),
      },
      null,
      2,
    );
  } catch (e) {
    return fail(e);
  }
}

// ─────────────────────────────── list_nodes ────────────────────────────────

/** 列出项目内的画布节点（node_type / 身份 / 标题 / 结果状态 / 更新时间） */
async function toolListNodes(args: Record<string, unknown>): Promise<string> {
  try {
    const { readdir, readFile } = await import('fs/promises');
    const projectId = typeof args.projectId === 'string' ? args.projectId : undefined;
    const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 200) : 100;

    const { getCurrentProject, getProjectById } = await import('@/lib/project/project-manager');
    const { parseNodeMarkdown, setCurrentProjectPath } = await import('@/lib/node-markdown');
    const project = projectId ? await getProjectById(projectId) : await getCurrentProject();
    // 指定项目时同步一下上下文：parseNodeMarkdown 无需，但保持一致以免后续调用踩空
    setCurrentProjectPath(project.path);

    const { join } = await import('path');
    const nodesDir = join(project.path, 'notes-memory');
    let files: string[] = [];
    try {
      files = await readdir(nodesDir);
    } catch {
      return JSON.stringify({ projectId: project.id, count: 0, nodes: [], note: '该项目下暂无 notes-memory 目录。' });
    }
    const mdFiles = files.filter((f) => f.endsWith('.md') && f !== 'example_node.md');

    const nodes: Array<Record<string, unknown>> = [];
    for (const file of mdFiles) {
      try {
        const content = await readFile(join(nodesDir, file), 'utf-8');
        const node = parseNodeMarkdown(content);
        const fm = node.frontmatter;
        const rec = {
          node_id: fm.node_id,
          title: fm.title,
          node_type: fm.node_type ?? null,
          outcome_status: fm.outcome_status ?? null,
          updated_at: fm.updated_at ?? null,
          starred: fm.starred === true,
        };
        if (keyword) {
          const hay = `${rec.title ?? ''} ${rec.node_type ?? ''} ${fm.tags?.join(' ') ?? ''}`.toLowerCase();
          if (!hay.includes(keyword.toLowerCase())) continue;
        }
        nodes.push(rec);
      } catch {
        // 单个节点解析失败（frontmatter 残缺）跳过，不影响整体
      }
    }
    nodes.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
    return JSON.stringify(
      { projectId: project.id, projectName: project.name, count: nodes.length, nodes: nodes.slice(0, limit) },
      null,
      2,
    );
  } catch (e) {
    return fail(e);
  }
}

// ───────────────────────────── get_app_status ──────────────────────────────

/** 应用运行态：MCP 插件连接状态 + 当前项目 + 已配置 provider 概览（只读） */
async function toolGetAppStatus(): Promise<string> {
  try {
    const { mcpManager } = await import('@/lib/mcp/manager');
    // 只读：不调用 syncServers（会挂载/卸载插件，属副作用）
    // 注意：PluginState 取值 pending|loading|active|error|unloading|disposed —— **可用态是 'active'**，
    // 不是 'connected'（前端状态Label 才会翻译成"已连接"）。
    const plugins = mcpManager.getPluginStatuses().map((p) => ({
      id: p.id,
      name: p.name,
      state: p.state,
      /** 是否可用可调用（active 才真正能跑工具） */
      ready: p.state === 'active',
      error: p.error ?? null,
      missingDeps: p.missingDeps ?? [],
    }));

    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    // 只报「是否配置 + 绑了几个模型」，绝不回传 apiKey 等密钥内容
    const providers = (settings.providers ?? []).map((p) => ({
      type: p.type,
      configured: !!p.apiKey,
      customBaseUrl: !!p.baseUrl,
      modelCount: (p.selectedModels ?? []).length,
    }));

    const { getCurrentProject } = await import('@/lib/project/project-manager');
    let currentProject: { id: string; name: string } | null = null;
    try {
      const p = await getCurrentProject();
      currentProject = { id: p.id, name: p.name };
    } catch {
      currentProject = null; // 无项目（NO_PROJECT）不是错误
    }

    return JSON.stringify(
      {
        currentProject,
        plugins: {
          count: plugins.length,
          connected: plugins.filter((p) => p.state === 'active').length,
          list: plugins,
        },
        providers: { count: providers.length, list: providers },
      },
      null,
      2,
    );
  } catch (e) {
    return fail(e);
  }
}

// ─────────────────────────────── read_inbox ────────────────────────────────

/** 读取 Butler 收件箱（默认只看未归档；返回摘要正文，需全文再按 id 追问） */
async function toolReadInbox(args: Record<string, unknown>): Promise<string> {
  try {
    const pendingOnly = args.pendingOnly !== false;
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 20;
    const { listInbox } = await import('@/lib/core/inbox');
    const all = await listInbox(100);
    // 已归档（done）的不算待处理
    const pending = all.filter((r) => !r.done);
    const picked = (pendingOnly ? pending : all).slice(0, limit);
    return JSON.stringify(
      {
        totals: { pending: pending.length },
        count: picked.length,
        items: picked.map((r) => ({
          id: r.id,
          kind: r.kind,
          source: r.source,
          title: r.title,
          preview: clip(r.body ?? ''),
          time: r.created_at,
        })),
      },
      null,
      2,
    );
  } catch (e) {
    return fail(e);
  }
}

export const consoleToolDefs: Tool[] = [
  {
    name: 'list_agents',
    description:
      'List every installed Agent package (id, name, version, its fixed tool scenes and excluded core tools) — i.e. which specialized identities are available on this BobWork install. Read-only. Call this before routing work to an agent so the "hand it to X" suggestion names something that actually exists.',
    parameters: { type: 'object', properties: {} },
    category: '配置',
    execute: toolListAgents,
    maxOutput: 6000,
  },
  {
    name: 'list_projects',
    description:
      'List all projects: id, name, path, which one is current, plus size stats (node count, db size, age) for each active project. Read-only. Use it to answer "有什么项目 / 当前在哪个项目" and to pick a projectId for follow-up queries. Set withStats=false to skip per-project stats and answer faster.',
    parameters: {
      type: 'object',
      properties: {
        withStats: {
          type: 'boolean',
          description: 'Include per-project node count / db size / age. Default true.',
        },
      },
    },
    category: '配置',
    execute: toolListProjects,
    maxOutput: 6000,
  },
  {
    name: 'list_nodes',
    description:
      'List canvas nodes of a project: node_id, title, node_type (the agent identity behind the node), outcome status and update time, newest first. Read-only. Optionally filter by keyword (matches title / node_type / tags) or switch project via projectId. Use it to answer "画布上有哪些节点" or to find a node id before reading its content.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Fuzzy filter on title / node_type / tags.' },
        projectId: { type: 'string', description: 'Target project id; defaults to the current project.' },
        limit: { type: 'number', description: 'Max rows (1-200). Default 100.' },
      },
    },
    category: '系统',
    execute: toolListNodes,
    maxOutput: 8000,
  },
  {
    name: 'get_app_status',
    description:
      'Read-only app health snapshot: current project, every MCP plugin with its live state (pending / loading / active / error / unloading / disposed — only "active" means its tools can actually run) and the configured model providers (whether each is configured, plus bound model count — never returns keys). Use it to answer "某个插件连上没有 / 现在能不能用某个能力 / 有哪些模型服务可用". It does not mount or unmount anything.',
    parameters: { type: 'object', properties: {} },
    category: '系统',
    execute: toolGetAppStatus,
    maxOutput: 6000,
  },
  {
    name: 'read_inbox',
    description:
      'Read the Butler inbox: pending receipts that are not archived (done=false), each with id, kind, source, title, a short preview and timestamp, plus the pending count. Read-only — it never modifies anything. Use it to answer "有哪些待处理回执 / 收件箱里有什么"; set pendingOnly=false to also include already-archived (done) items.',
    parameters: {
      type: 'object',
      properties: {
        pendingOnly: { type: 'boolean', description: 'Only not-done (pending) items. Default true.' },
        limit: { type: 'number', description: 'Max rows (1-100). Default 20.' },
      },
    },
    category: '记忆',
    execute: toolReadInbox,
    maxOutput: 8000,
  },
];
