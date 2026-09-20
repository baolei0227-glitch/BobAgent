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
import { execFile } from 'child_process';
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
  /** 已回收「本插件残留实例」：插件侧重试接管端口后会自愈，面板壳可自动重探 */
  reaped?: boolean;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 监听指定端口的进程 pid（macOS lsof）；非 darwin / 查询失败返回 null */
function portHolderPid(port: number): Promise<number | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const pid = Number(String(stdout).trim().split('\n')[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/**
 * 端口上正在服务的是不是该插件：直接问它的 /api/status。
 * 比按进程命令行猜路径可靠（打包态资源目录、相对路径启动都能认），也是唯一安全的判据——
 * 答不出或答的不是该插件，就绝不回收那个进程。
 */
async function isOwnPluginOnPort(pluginId: string, port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    const data = (await resp.json()) as { plugin?: unknown };
    return data?.plugin === pluginId;
  } catch {
    return false;
  }
}

/** 取进程的父 pid（ps）；失败返回 null */
function processParentPid(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const ppid = Number(String(stdout).trim());
      resolve(Number.isInteger(ppid) && ppid > 0 ? ppid : null);
    });
  });
}

/**
 * 只回收「本宿主的上一代」与「孤儿」：
 *   - ppid === 本进程 pid：本宿主重复 spawn 留下的旧一代（真凶场景）；
 *   - ppid === 1：宿主崩溃/被强杀后 reparent 到 launchd 的孤儿。
 * 父进程是另一个仍在运行的主机（如同时开着的打包版 App / 另一个 dev 服务）时，它是合法实例，
 * 绝不回收——否则两个宿主会互相抢杀、面板来回失效。不认识的占用者一律不碰。
 */
async function isReapableStaleHolder(pid: number): Promise<boolean> {
  if (pid === process.pid || pid === process.ppid) return false;
  const ppid = await processParentPid(pid);
  return ppid !== null && (ppid === process.pid || ppid === 1);
}

/**
 * 回收「本插件的残留实例」：重复 spawn 的上一代、宿主崩溃后 reparent 到 launchd 的孤儿
 * 都会卡在面板端口上。SIGTERM →1s→ 仍存活则 SIGKILL；返回是否真的回收了进程。
 */
async function reapStaleHolder(pluginId: string, pid: number, port: number): Promise<boolean> {
  if (!(await isReapableStaleHolder(pid))) return false;
  if (!isPidAlive(pid) || !(await isOwnPluginOnPort(pluginId, port))) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  for (let i = 0; i < 10 && isPidAlive(pid); i++) await delay(100);
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  return true;
}

/** 等面板就绪（占用者被回收后，插件侧下一次重试即接管端口）；超时返回 false */
async function waitPanelReady(probeUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const resp = await fetch(probeUrl, { signal: AbortSignal.timeout(1200), cache: 'no-store' });
      const data = (await resp.json()) as { ok?: boolean };
      if (data?.ok) return true;
    } catch {
      /* 未就绪，继续等 */
    }
    if (Date.now() >= deadline) return false;
    await delay(400);
  }
}

/**
 * 探测 serve 面板是否真的由「本 App 的插件实例」服务。
 *
 * 为什么不能只看插件 /api/status：宿主 iframe 是直连插件端口的，若端口被残留旧进程占着，
 * 新实例绑不上（只告警不退出），直连探测会命中旧进程并拿到 ok:true —— 界面静默停留在旧版本。
 * 因此先读插件写下的冲突标记：标记存在、写入者（本实例）仍然存活且占用者是别的进程 → 判定「端口被占用」。
 * 若占用者是「本插件的残留实例」（重复 spawn 的第二代 / 崩溃孤儿），宿主直接回收它，
 * 插件侧下一次重试（3s 一次）即接管端口——面板自愈，用户无需手工 kill 或重启 BobWork。
 */
export async function probePluginPanel(entry: PluginPanelEntry): Promise<PluginPanelProbe> {
  if (entry.mode !== 'serve' || !entry.probeUrl) return { ok: true };

  const conflict = await readPanelConflict(entry.pluginId);
  const port = conflict?.port;
  const holderPid = conflict ? (conflict.holderPid ?? (port ? await portHolderPid(port) : null)) : null;

  /**
   * 标记可信的前提：写标记的插件实例仍然活着（它确实没拿到端口），且占用者是「另一个」进程。
   * holderPid === conflict.pid 是「自己占着自己的端口」的自指标记——插件回收上一代并重绑成功后，
   * 标记写入与其 listening 清理存在竞态，会残留这种脏标记。
   * 宿主若照此回收，等于杀掉插件健在的当前实例，面板随即变成 unreachable（历史故障根因之一）。
   * 故自指标记 / 占用者查不到时一律不信任，退回直连探测。
   */
  if (
    conflict &&
    typeof conflict.pid === 'number' &&
    isPidAlive(conflict.pid) &&
    typeof holderPid === 'number' &&
    holderPid !== conflict.pid
  ) {
    const reaped = port ? await reapStaleHolder(entry.pluginId, holderPid, port) : false;
    if (reaped && (await waitPanelReady(entry.probeUrl, 4000))) {
      return { ok: true };
    }
    return { ok: false, reason: 'port-in-use', port, holderPid, reaped };
  }

  try {
    const resp = await fetch(entry.probeUrl, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
    const data = (await resp.json()) as { ok?: boolean };
    return data?.ok ? { ok: true } : { ok: false, reason: 'unreachable' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
