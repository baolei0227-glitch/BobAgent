/**
 * lib/plugin-panels-server.ts — 宿主侧「插件面板注册中心」（server-only）
 *
 * 让 MCP 插件可声明「自带界面」并自动出现在宿主右侧预览面板，替代逐个手写面板壳。
 *
 * 数据源（单一真相在配置侧，index.json 仅是派生视图，不作为配置源）：
 *   - MCP_PRESETS：出厂随包面板声明（如 bob-notes-mcp 9480 / bob-mind-mcp 9482，mode serve）
 *   - 实例配置 .settings.json 的 mcpServers：自定义/市场插件可在自身配置上补 panel 声明
 *
 * 形态：
 *   - serve  ：插件自起本地网页，宿主 iframe 内嵌，进入前探测 statusPath 就绪态；
 *   - static ：随包静态目录，宿主 /api/plugin-panel/<id>/** 代理托管（零端口、无孤儿进程风险），
 *              面板声明的 staticRoot 相对插件包目录（随包插件经 {BUNDLED} 定位包根）。
 *
 * 只有 enabled 的实例才进清单：出厂默认装配的 bob-notes/bob-mind 恒 enabled → 注册表出厂即有两条。
 */

import { promises as fs } from 'fs';
import { join, isAbsolute } from 'path';
import type { McpServerConfig } from '@/lib/mcp/types';
import { MCP_PRESETS } from '@/lib/mcp/types';
import type { PluginPanelEntry, PluginPanelIcon } from '@/lib/plugin-panels';
import { readSettingsFromFile, bundledPluginPath } from '@/lib/settings-server';
import { bundledDataHome } from '@/lib/extensions/bundled-data-home';

const BUNDLED_PREFIX = '{BUNDLED}:';

function presetById(id: string): McpServerConfig | undefined {
  return MCP_PRESETS.find((p) => p.id === id);
}

/** 出厂面板的图标键（前端映射 lucide） */
function presetIcon(id: string): PluginPanelIcon | undefined {
  if (id === 'bob-mind-mcp') return 'brain';
  if (id === 'bob-notes-mcp') return 'notebook';
  return undefined;
}

/** 取配置的生效面板声明：实例配置优先，缺省回退预置（两者都声明时以实例为准） */
function effectivePanel(cfg: McpServerConfig) {
  const preset = presetById(cfg.id);
  return cfg.panel ?? preset?.panel;
}

/** 由预置的 {BUNDLED} 入口推导插件包目录名（如 bob-mind-mcp/dist/cli.js → bob-mind-mcp） */
function bundledPackageDir(cfg: McpServerConfig): string | null {
  const preset = presetById(cfg.id);
  const rel = preset?.args?.find((a): a is string => typeof a === 'string' && a.startsWith(BUNDLED_PREFIX));
  if (!rel) return null;
  const firstSeg = rel.slice(BUNDLED_PREFIX.length).split('/')[0];
  return firstSeg || null;
}

/**
 * 解析 static 面板的本地目录（供 /api/plugin-panel/<pluginId>/** 静态代理使用）。
 * staticRoot 为绝对路径时直接用；相对路径视为相对插件包目录（随包插件按 {BUNDLED} 定位包根）。
 * 解析不到（目录不存在）返回 null，路由回 404。
 */
export function resolveStaticPanelDir(cfg: McpServerConfig): string | null {
  const panel = effectivePanel(cfg);
  if (!panel || panel.mode !== 'static' || !panel.staticRoot) return null;
  if (isAbsolute(panel.staticRoot)) return panel.staticRoot;
  const pkgDir = bundledPackageDir(cfg);
  if (!pkgDir) return null;
  return bundledPluginPath(join(pkgDir, panel.staticRoot));
}

/** 汇总当前启用的插件面板注册表（供 /api/plugin-panels GET） */
export async function collectPluginPanelEntries(): Promise<PluginPanelEntry[]> {
  const settings = await readSettingsFromFile();
  const configs = settings.mcpServers ?? [];
  const entries: PluginPanelEntry[] = [];

  for (const cfg of configs) {
    if (!cfg.enabled) continue;
    const panel = effectivePanel(cfg);
    if (!panel) continue;
    const preset = presetById(cfg.id);
    // 显示名优先用预置友好名（Bob Notes / Bob-Mind）；自定义实例无预置时才用实例名
    const name = preset?.name ?? cfg.name ?? cfg.id;
    const icon = presetIcon(cfg.id);

    if (panel.mode === 'serve') {
      const url = (panel.url ?? preset?.panel?.url ?? '').replace(/\/+$/, '');
      if (!url) continue;
      const statusPath = panel.statusPath ?? '/api/status';
      entries.push({
        pluginId: cfg.id,
        name,
        mode: 'serve',
        src: url,
        probeUrl: `${url}${statusPath.startsWith('/') ? statusPath : `/${statusPath}`}`,
        icon,
      });
    } else {
      entries.push({
        pluginId: cfg.id,
        name,
        mode: 'static',
        src: `/api/plugin-panel/${encodeURIComponent(cfg.id)}/index.html`,
        icon,
      });
    }
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/* 面板就绪探测                                                                */
/* -------------------------------------------------------------------------- */

/** serve 面板探测结果：ok=false 时带具体原因，供面板壳给出可操作的提示 */
export interface PluginPanelProbe {
  ok: boolean;
  /** port-in-use = 本实例在跑但端口被别的进程占着；unreachable = 服务未起来 */
  reason?: 'port-in-use' | 'unreachable';
  /** 面板端口（仅 port-in-use 时给出） */
  port?: number;
  /** 占用端口的进程 pid（尽力识别，可能为 null） */
  holderPid?: number | null;
}

/** 插件侧端口冲突标记（数据根/panel-port-conflict.json，由插件 EADDRINUSE 时写入） */
interface PanelConflictMarker {
  port?: number;
  holderPid?: number | null;
  pid?: number;
}

/** 读取插件写下的端口冲突标记；无标记 / 解析失败均返回 null */
async function readPanelConflict(pluginId: string): Promise<PanelConflictMarker | null> {
  const home = bundledDataHome(pluginId);
  if (!home) return null;
  try {
    const raw = await fs.readFile(join(home.dir, 'panel-port-conflict.json'), 'utf8');
    const parsed = JSON.parse(raw) as PanelConflictMarker;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测 serve 面板是否真的由「本 App 的插件实例」服务。
 *
 * 为什么不能只看插件 /api/status：宿主 iframe 是直连插件端口的，若端口被残留旧进程占着，
 * 新实例绑不上（只告警不退出），直连探测会命中旧进程并拿到 ok:true —— 界面静默停留在旧版本。
 * 因此先读插件写下的冲突标记：标记存在且写入者（本实例）仍然存活 → 判定「端口被占用」，
 * 面板壳据此提示用户清理残留进程，而不是把旧界面当成新界面加载。
 * 标记不存在（或写入者已退出 = 陈旧标记）时才回落到直连探测。
 */
export async function probePluginPanel(entry: PluginPanelEntry): Promise<PluginPanelProbe> {
  if (entry.mode !== 'serve' || !entry.probeUrl) return { ok: true };

  const conflict = await readPanelConflict(entry.pluginId);
  if (conflict && typeof conflict.pid === 'number' && isPidAlive(conflict.pid)) {
    return {
      ok: false,
      reason: 'port-in-use',
      port: conflict.port,
      holderPid: conflict.holderPid ?? null,
    };
  }

  try {
    const resp = await fetch(entry.probeUrl, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
    const data = (await resp.json()) as { ok?: boolean };
    return data?.ok ? { ok: true } : { ok: false, reason: 'unreachable' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
