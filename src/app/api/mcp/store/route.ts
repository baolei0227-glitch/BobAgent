/**
 * /api/mcp/store — MCP 市场（Extensions Store · MCP & Plugins）
 *
 * GET  — 市场条目清单：assets/mcp/registry.json 元数据 + MCP_PRESETS 配置模板摘要
 *         + 已装/启用状态 + 运行态（connected/error，来自最近一次 sync）。
 * POST — { action: 'install' | 'uninstall' | 'enable' | 'disable', id, apiKey? }
 *   install   从预置模板物化一条配置写入 .settings.json 并启用；
 *             官方不覆盖用户配置（A 方案）：目标 id 已存在时返回 409，不提供 force。
 *             需要 API Key 的条目可带 apiKey，按模板 authScheme 自动写入 env/headers。
 *   uninstall 从配置中移除该服务器（不触碰预置模板）。
 *   enable/disable 切换已装服务器的 enabled。
 *   安装/启停均触发 mcpManager.syncServers 立即装配，高危条目操作落审计
 *   <APP_ROOT>/mcp/.audit/mcp-installs.md。
 */

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { MCP_PRESETS, type McpServerConfig } from '@/lib/mcp/types';
import { readSettingsFromFile, writeSettingsToFile } from '@/lib/settings-server';
import { mcpManager } from '@/lib/mcp/manager';
import { mcpAuditDir } from '@/lib/extensions/index-server';

/** 随包市场清单（与 assets/skills 同级，打包脚本复制到 next-standalone/assets/mcp/） */
const REGISTRY_PATH = path.resolve(process.cwd(), 'assets', 'mcp', 'registry.json');

interface McpStoreEntryMeta {
  id: string;
  name: string;
  description: string;
  group: 'bundled' | 'download';
  category: string;
  risk: 'normal' | 'high';
  vetted: boolean;
  auth: boolean;
  /** 展示归属：plugin = 系统中可独立打开的本地/随包能力；mcp = 作为节点工具连接的外部 MCP 服务 */
  kind: 'plugin' | 'mcp';
  /** 条目自带配置页（如 Bob OCR 插件 /setup/status）：Installed 卡渲染 Configure 入口 */
  config?: boolean;
  /** 条目需要额外装配引导（如 Bob Browser 扩展下载/绑定）：Installed 卡渲染 Setup 展开块 */
  setup?: boolean;
}

/** 读随包市场清单（静态只读，体量小无需缓存） */
function loadRegistry(): McpStoreEntryMeta[] {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    return JSON.parse(raw) as McpStoreEntryMeta[];
  } catch (e) {
    console.error('load MCP registry error:', e);
    return [];
  }
}

/** 追加 MCP 市场操作审计（install / uninstall / enable / disable 均留痕） */
function appendAudit(line: string): void {
  try {
    const dir = mcpAuditDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(path.join(dir, 'mcp-installs.md'), `- ${stamp} | ${line}\n`, 'utf-8');
  } catch (e) {
    console.warn('append MCP audit error:', e);
  }
}

/** 从预置模板克隆一条服务器配置（保留 {BUNDLED} 占位，写盘由 settings-server 归一化） */
function templateFor(id: string): McpServerConfig | undefined {
  const p = MCP_PRESETS.find((s) => s.id === id);
  if (!p) return undefined;
  return JSON.parse(JSON.stringify(p)) as McpServerConfig;
}

/** 按模板 authScheme 把用户填的 apiKey 写入 env 或 headers（用户无需感知放置结构） */
function applyApiKey(cfg: McpServerConfig, apiKey: string): McpServerConfig {
  const scheme = cfg.authScheme;
  if (!scheme) return cfg;
  const next: McpServerConfig = { ...cfg, env: { ...(cfg.env || {}) }, headers: { ...(cfg.headers || {}) } };
  if (scheme.placement.kind === 'env') {
    next.env![scheme.placement.key] = apiKey;
  } else {
    next.headers![scheme.placement.key] = scheme.placement.template.replace('{KEY}', apiKey);
  }
  return next;
}

export async function GET() {
  try {
    const registry = loadRegistry();
    const settings = await readSettingsFromFile();
    const installed = new Map<string, McpServerConfig>();
    for (const s of settings.mcpServers || []) installed.set(s.id, s);
    const statuses = new Map((mcpManager.getPluginStatuses() || []).map((r) => [r.id, r]));
    const presets = new Map(MCP_PRESETS.map((p) => [p.id, p]));

    const entries = registry.map((meta) => {
      const cfg = installed.get(meta.id);
      const preset = presets.get(meta.id);
      const runtime = statuses.get(meta.id);
      return {
        ...meta,
        installed: !!cfg,
        enabled: !!cfg?.enabled,
        authDetail:
          meta.auth && preset?.authScheme
            ? {
                placeholder: preset.authScheme.placeholder,
                signupUrl: preset.authScheme.signupUrl,
                description: preset.authScheme.description,
              }
            : null,
        status: runtime
          ? { state: runtime.state, error: runtime.error, missingDeps: runtime.missingDeps }
          : undefined,
      };
    });

    // 自定义 server（registry 之外的 settings.mcpServers）：以 kind=mcp 展示在 Installed · MCP 区
    const registryIds = new Set(registry.map((m) => m.id));
    const customs = (settings.mcpServers || [])
      .filter((s) => !registryIds.has(s.id))
      .map((cfg) => {
        const runtime = statuses.get(cfg.id);
        return {
          id: cfg.id,
          name: cfg.name || cfg.id,
          description: 'Custom MCP server added manually (not from the store catalog).',
          group: 'custom' as const,
          category: 'Custom',
          risk: 'normal' as const,
          vetted: false,
          auth: false,
          kind: 'mcp' as const,
          installed: true,
          enabled: cfg.enabled !== false,
          authDetail: null,
          status: runtime
            ? { state: runtime.state, error: runtime.error, missingDeps: runtime.missingDeps }
            : undefined,
        };
      });

    // Screenshot OCR（BobWork Capture 助手 + 经 bob-ocr-mcp 识别）：以静态插件卡展示在 Plugins 分区
    const screenshotPlugin = {
      id: 'screenshot-ocr',
      name: 'Screenshot OCR',
      description: 'Screen-region capture + text pickup (⌘⇧O). Capture runs through the BobWork Capture helper; text recognition runs through Bob OCR.',
      group: 'bundled' as const,
      category: 'OCR',
      risk: 'normal' as const,
      vetted: true,
      auth: false,
      kind: 'plugin' as const,
      installed: true,
      enabled: true,
      authDetail: null,
      pluginPanel: 'screenshot-ocr' as const,
      status: undefined,
    };

    return NextResponse.json({ entries: [...entries, ...customs, screenshotPlugin] });
  } catch (e: unknown) {
    console.error('GET /api/mcp/store error:', e);
    return NextResponse.json({ entries: [], error: e instanceof Error ? e.message : 'Failed to load MCP store' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, apiKey, name, endpoint } = body as {
      action: 'install' | 'uninstall' | 'enable' | 'disable' | 'addCustom' | 'updateKey';
      id?: string;
      apiKey?: string;
      name?: string;
      /** streamable-http URL 或 stdio 命令（如 "npx -y @org/mcp"） */
      endpoint?: string;
    };
    const settings = await readSettingsFromFile();
    const servers = settings.mcpServers || [];

    // addCustom：添加 registry 之外的自定义 MCP server（不进 Market，落在 Installed · MCP）
    if (action === 'addCustom') {
      const nm = (name || '').trim();
      const ep = (endpoint || '').trim();
      if (!nm || !ep) {
        return NextResponse.json({ success: false, error: 'Both a name and an endpoint (URL or command) are required.' }, { status: 400 });
      }
      const slug = (nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom');
      const cfgId = `${slug}-${Date.now().toString(36)}`;
      const isHttp = /^https?:\/\//i.test(ep);
      const base: McpServerConfig = { id: cfgId, name: nm, enabled: true, transport: isHttp ? 'streamable-http' : 'stdio' };
      if (isHttp) {
        base.url = ep;
        base.timeout = 60;
      } else {
        const parts = ep.split(/\s+/).filter(Boolean);
        base.command = parts[0];
        base.args = parts.slice(1);
      }
      settings.mcpServers = [...servers, base];
      await writeSettingsToFile(settings);
      appendAudit(`add-custom | ${cfgId} | ${nm}`);
      await mcpManager.syncServers(settings.mcpServers);
      return NextResponse.json({ success: true, id: cfgId, name: nm, enabled: true });
    }

    if (!id) {
      return NextResponse.json({ success: false, error: '"id" is required' }, { status: 400 });
    }
    const meta = loadRegistry().find((e) => e.id === id) ?? null;
    const idx = servers.findIndex((s) => s.id === id);

    switch (action) {
      case 'install': {
        // 只有市场条目可 install（有预置模板）
        if (!meta) {
          return NextResponse.json({ success: false, error: `Unknown store entry "${id}"` }, { status: 404 });
        }
        if (idx >= 0) {
          // A 方案：官方永不覆盖用户配置。已装 = 已在本地，需先卸载或直接在 Installed 管理。
          return NextResponse.json(
            { success: false, error: `"${id}" is already installed. Manage or uninstall it first.` },
            { status: 409 },
          );
        }
        const template = templateFor(id);
        if (!template) {
          return NextResponse.json({ success: false, error: `No preset template for "${id}"` }, { status: 400 });
        }
        const cfg = apiKey ? applyApiKey(template, apiKey) : template;
        // 默认开启（装完即用）；bobby 为本地桌面自动化（高风险），安装后默认关闭，需在 Installed 手动开启
        cfg.enabled = id !== 'bobby';
        settings.mcpServers = [...servers, cfg];
        await writeSettingsToFile(settings);
        appendAudit(`install | ${id} | risk=${meta.risk} | vetted=${meta.vetted}`);
        await mcpManager.syncServers(settings.mcpServers);
        return NextResponse.json({ success: true, id, name: meta.name, enabled: true });
      }
      case 'uninstall': {
        if (idx < 0) {
          return NextResponse.json({ success: false, error: `"${id}" is not installed` }, { status: 404 });
        }
        settings.mcpServers = servers.filter((s) => s.id !== id);
        await writeSettingsToFile(settings);
        appendAudit(`uninstall | ${id}`);
        await mcpManager.syncServers(settings.mcpServers);
        return NextResponse.json({ success: true, id, installed: false });
      }
      case 'updateKey': {
        // Installed 卡更换 API Key：按该条目预置 authScheme 写入 env/headers（保留其余配置与 enabled），立即重连
        if (idx < 0) {
          return NextResponse.json({ success: false, error: `"${id}" is not installed` }, { status: 404 });
        }
        const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : '';
        if (!key) {
          return NextResponse.json({ success: false, error: 'apiKey is required' }, { status: 400 });
        }
        const template = templateFor(id);
        if (!template?.authScheme) {
          return NextResponse.json(
            { success: false, error: `"${id}" has no API key scheme configured — update its env/headers manually` },
            { status: 400 },
          );
        }
        const base = JSON.parse(JSON.stringify(servers[idx])) as McpServerConfig;
        const updated = applyApiKey(base, key);
        settings.mcpServers = servers.map((s, i) => (i === idx ? updated : s));
        await writeSettingsToFile(settings);
        appendAudit(`updateKey | ${id}`);
        await mcpManager.syncServers(settings.mcpServers);
        return NextResponse.json({ success: true, id, name: servers[idx].name || id, enabled: updated.enabled });
      }
      case 'enable':
      case 'disable': {
        if (idx < 0) {
          return NextResponse.json({ success: false, error: `"${id}" is not installed` }, { status: 404 });
        }
        const enabled = action === 'enable';
        settings.mcpServers = servers.map((s) => (s.id === id ? { ...s, enabled } : s));
        await writeSettingsToFile(settings);
        appendAudit(`${action} | ${id} | risk=${meta?.risk ?? 'custom'}`);
        await mcpManager.syncServers(settings.mcpServers);
        return NextResponse.json({ success: true, id, enabled });
      }
      default:
        return NextResponse.json(
          { success: false, error: `Unknown action "${String(action)}"` },
          { status: 400 },
        );
    }
  } catch (e: unknown) {
    console.error('POST /api/mcp/store error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'MCP store operation failed' }, { status: 500 });
  }
}
