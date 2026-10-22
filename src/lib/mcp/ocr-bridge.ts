/**
 * lib/mcp/ocr-bridge.ts — Bob OCR 常驻桥的「宿主托管」（server-only）
 *
 * 背景（2026-10-12 用户现场）：Bob OCR 的识别能力不在宿主进程里，而由独立常驻桥
 * （`bob-ocr-mcp --serve`，127.0.0.1:9478，token 鉴权 + /settings 配置页）提供。
 * 过去这个桥要用户自己 `npm i -g bob-ocr-mcp` 再 `--install-daemon`，而安装包**没有**随包分发它：
 * 普通用户装完 BobWork，设置 → Extensions Store 的 Bob OCR 卡片只会弹
 * 「Bob OCR plugin is offline or not configured. Start it with: bob-ocr-mcp --install-daemon」，
 * 且终端命令对他们等于死路（没装 node / 不会用 launchd）。
 *
 * 现在：桥随包分发（scripts/package-release.sh 内置 bob-ocr-mcp），宿主负责「确保它在线」：
 *   ① 已有在线桥（用户自装 launchd daemon、或另一个 BobWork 宿主拉起的）→ 直接复用，不抢进程；
 *   ② 未在线 → 用随包副本以当前 Node 运行时拉起 `--serve`（见 child-env.ts：打包版 = Electron as node，
 *      因此用户机器不需要装 node），端口/数据根由宿主注入，日志落 <数据根>/host-bridge.log；
 *   ③ 就绪探测失败 → 记录原因返回失败，调用方按「桥不可用」处理，绝不阻塞宿主主流程。
 *
 * 复用既有 HTTP 契约（不改 token/URL 体系）：桥在线后由 mcp/manager.ts 的
 * refreshLocalBridgeTokens 从 /setup/status 取实时 token 刷新运行时配置。
 *
 * 状态挂 globalThis：Next 每个 route 是独立 chunk、dev 下 HMR 会重建模块实例，
 * 只有 globalThis 才是同进程唯一（仓库既有模式见 panel-ports.ts / server.ts）。
 */

import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { bundledPluginPath } from '@/lib/settings-server';
import { bundledDataHome } from '@/lib/extensions/bundled-data-home';
import { spawnNodeProcess } from './child-env';
import { MCP_PRESETS } from './types';

/** 桥的 MCP server id（与 MCP_PRESETS / settings.mcpServers 同键） */
export const OCR_BRIDGE_ID = 'bob-ocr-mcp';

/** 探测 /setup/status 的超时：只确认在线，短超时避免拖慢 OCR 入口 */
const PROBE_TIMEOUT_MS = 800;
/** 拉起后等待就绪的总时长（含首次启动 esbuild 单文件加载 + python/swift 探测） */
const READY_TIMEOUT_MS = 8000;
/** 就绪轮询间隔 */
const READY_POLL_MS = 200;
/** 同一次失败后再次尝试拉起的冷却期（防抖：避免每个 route 都重复 spawn） */
const RESPAWN_COOLDOWN_MS = 15_000;
/**
 * 拉起失败后的冷却期：子进程因 EADDRINUSE / 入口损坏等原因秒退时，
 * 若每次 OCR 调用都重试一遍「spawn + 等就绪」，用户会感到莫名其妙的卡顿
 * ⇒ 失败后先返回缓存的失败原因，冷却期内不再尝试（force 或冷却结束再试）。
 */
const FAILURE_COOLDOWN_MS = 30_000;
/** 随包入口（打包脚本内置到 next-standalone/bob-ocr-mcp/） */
const BRIDGE_ENTRY_REL = `${OCR_BRIDGE_ID}/dist/cli.js`;

export interface OcrBridgeProbe {
  online: boolean;
  /** 桥自报的实时 token（供 manager 刷新配置；探测失败时 undefined） */
  token?: string;
  /** 插件 /settings 配置页地址（自带 token） */
  settingsUrl?: string;
  error?: string;
}

export interface OcrBridgeEnsureResult {
  /** 桥可用（已有或本次拉起成功） */
  ok: boolean;
  online: boolean;
  /** 本次是否由宿主新拉起了进程 */
  spawned: boolean;
  /** 失败原因（可直接展示给用户） */
  error?: string;
  /** 子进程日志路径（排障用） */
  logPath?: string;
}

interface BridgeState {
  child?: ChildProcess;
  logStream?: WriteStream;
  logPath?: string;
  lastEnsureAt: number;
  lastError?: string;
  lastExit?: { code: number | null; signal: string | null; at: number };
  /** 上一次拉起失败（用于失败冷却：冷却期内不再重复 spawn） */
  lastFailure?: { at: number; error: string; logPath?: string };
  inflight?: Promise<OcrBridgeEnsureResult>;
  cleanupBound?: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __bobOcrBridgeState__: BridgeState | undefined;
}

function state(): BridgeState {
  if (!globalThis.__bobOcrBridgeState__) {
    globalThis.__bobOcrBridgeState__ = { lastEnsureAt: 0 };
  }
  return globalThis.__bobOcrBridgeState__;
}

/** 桥端口：宿主 env 覆盖优先（测试/多实例），否则取预置 URL 的端口，最后回退 9478 */
export function ocrBridgePort(): number {
  const envPort = Number((process.env.BOB_OCR_MCP_PORT || '').trim());
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  const url = MCP_PRESETS.find((p) => p.id === OCR_BRIDGE_ID)?.url || '';
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(url);
  const presetPort = m ? Number(m[1]) : NaN;
  if (Number.isFinite(presetPort) && presetPort > 0) return presetPort;
  return 9478;
}

/** 桥的 /setup/status 地址（该端点不校验 token） */
export function ocrBridgeStatusUrl(port = ocrBridgePort()): string {
  return `http://127.0.0.1:${port}/setup/status`;
}

/** 探测桥是否在线（含 token / 配置页地址）；任何异常都归为「不在线」 */
export async function probeOcrBridge(timeoutMs = PROBE_TIMEOUT_MS): Promise<OcrBridgeProbe> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(ocrBridgeStatusUrl(), { signal: ctl.signal });
    if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => null)) as
      | { token?: unknown; settingsUrl?: unknown; connected?: unknown }
      | null;
    return {
      online: true,
      token: typeof data?.token === 'string' && data.token ? data.token : undefined,
      settingsUrl: typeof data?.settingsUrl === 'string' && data.settingsUrl ? data.settingsUrl : undefined,
    };
  } catch (e) {
    return { online: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 随包桥子进程日志路径（<数据根>/host-bridge.log） */
export function ocrBridgeLogPath(): string {
  const dataHome = bundledDataHome(OCR_BRIDGE_ID);
  return join(dataHome?.dir ?? dirname(bundledPluginPath(BRIDGE_ENTRY_REL)), 'host-bridge.log');
}

/** 收尾：关掉本宿主拉起的子进程与日志流（不碰用户自装的 daemon） */
export function stopOcrBridge(): void {
  const s = state();
  const child = s.child;
  s.child = undefined;
  try { child?.kill('SIGTERM'); } catch { /* 已退出忽略 */ }
  try { s.logStream?.end(); } catch { /* 忽略 */ }
  s.logStream = undefined;
  if (child) s.lastExit = { code: null, signal: 'SIGTERM', at: Date.now() };
}

/**
 * 进程退出时收尾（只绑定一次）。
 *
 * ⚠️ 信号处理必须**交回默认语义**：Electron 的 killNextServer 是「SIGTERM → 800ms 未退出则 SIGKILL
 * 兜底」，只挂一个 on('SIGTERM') 监听会吞掉默认的终止动作 → 白白触发 SIGKILL 兜底与
 * 「SIGTERM ignored / slow exit」告警（见 electron/main.ts:339-352）。所以这里摘掉自己的监听后
 * 重发同一信号，让进程按默认动作立刻退出。
 * 被 SIGKILL 强杀时下面的 handler 不会执行 —— 桥成为孤儿进程也无妨：它是本地常驻服务，
 * 下次启动的探测（/setup/status）会直接复用。
 */
function bindCleanupOnce(): void {
  const s = state();
  if (s.cleanupBound) return;
  s.cleanupBound = true;
  process.once('exit', () => { try { stopOcrBridge(); } catch { /* 忽略 */ } });
  const onSignal = (sig: NodeJS.Signals): void => {
    try { stopOcrBridge(); } catch { /* 忽略 */ }
    try {
      process.removeListener(sig, onSignal);
      process.kill(process.pid, sig); // 交回默认动作（真正退出），不改变宿主既有退出时序
    } catch {
      process.exit(0);
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

/** 轮询等待桥就绪；子进程已退出则提前返回（附退出码，便于诊断） */
async function waitReady(deadlineMs: number, child?: ChildProcess): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (await probeOcrBridge().then((p) => p.online)) return true;
    // 必须用调用方持有的子进程句柄判退出：进程退出后 state().child 已被清空，
    // 只看 state 会漏判「进程已死」→ 白等满整个就绪超时（EADDRINUSE 场景实测 6s）。
    const c = child ?? state().child;
    if (c && c.exitCode !== null) return false;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

/** 拉起随包桥进程；失败返回 error（入口缺失 / spawn 抛错） */
function spawnBridge(): { child: ChildProcess; logPath: string } | { error: string } {
  const entry = bundledPluginPath(BRIDGE_ENTRY_REL);
  if (!entry || !existsSync(entry)) {
    return { error: `bundled bridge entry not found (${entry})` };
  }
  const logPath = ocrBridgeLogPath();
  let logStream: WriteStream | undefined;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logStream = createWriteStream(logPath, { flags: 'a' });
  } catch { /* 日志不可写不阻断拉起 */ }

  try {
    // --import-if-empty：插件侧首次启动且自身无配置时，从 BobWork .settings.json 导入
    // vision / OCR 模型（否则普通用户即使桥起来了也会因「No vision model configured」失败）
    const dataHome = bundledDataHome(OCR_BRIDGE_ID);
    const child = spawnNodeProcess([entry, '--serve', '--import-if-empty'], {
      cwd: dirname(entry),
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...(dataHome ? { [dataHome.envKey]: dataHome.dir } : {}),
        BOB_OCR_MCP_PORT: String(ocrBridgePort()),
      },
    });
    bindCleanupOnce();
    const s = state();
    s.logStream = logStream;
    s.logPath = logPath;
    if (logStream) {
      try { child.stdout?.pipe(logStream, { end: false }); } catch { /* 忽略 */ }
      try { child.stderr?.pipe(logStream, { end: false }); } catch { /* 忽略 */ }
    }
    child.once('exit', (code, signal) => {
      const st = state();
      if (st.child === child) st.child = undefined;
      st.lastExit = { code, signal, at: Date.now() };
    });
    child.once('error', (e) => {
      const st = state();
      st.lastError = `bridge process error: ${e.message}`;
    });
    return { child, logPath };
  } catch (e) {
    try { logStream?.end(); } catch { /* 忽略 */ }
    return { error: `failed to spawn bridge: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 确保 Bob OCR 常驻桥在线。
 *
 * opts.waitMs —— 等待就绪的上限（默认 8000；MCP 装配路径用更短的 3000 以免拖慢首个请求）
 * opts.force —— 跳过「刚试过」的冷却（用户在卡片上手动重试时用）
 */
export async function ensureOcrBridge(opts: { waitMs?: number; force?: boolean } = {}): Promise<OcrBridgeEnsureResult> {
  const s = state();
  if (s.inflight) return s.inflight;
  s.inflight = (async (): Promise<OcrBridgeEnsureResult> => {
    const first = await probeOcrBridge();
    if (first.online) {
      s.lastFailure = undefined;
      return { ok: true, online: true, spawned: false };
    }

    // 失败冷却（见 FAILURE_COOLDOWN_MS）：秒退的桥不该让每次 OCR 调用都白等一轮就绪超时
    const failure = s.lastFailure;
    if (!opts.force && failure && Date.now() - failure.at < FAILURE_COOLDOWN_MS) {
      return { ok: false, online: false, spawned: false, error: failure.error, logPath: failure.logPath };
    }

    const cooldownActive = !opts.force && Date.now() - s.lastEnsureAt < RESPAWN_COOLDOWN_MS;
    if (cooldownActive && s.child && s.child.exitCode === null) {
      // 我们刚拉起过、进程还活着：只等就绪，不重复 spawn
      const ok = await waitReady(opts.waitMs ?? READY_TIMEOUT_MS, s.child);
      return { ok, online: ok, spawned: false, error: ok ? undefined : s.lastError, logPath: s.logPath };
    }

    s.lastEnsureAt = Date.now();
    const spawned = spawnBridge();
    if ('error' in spawned) {
      s.lastError = spawned.error;
      s.lastFailure = { at: Date.now(), error: spawned.error };
      return { ok: false, online: false, spawned: false, error: spawned.error };
    }
    s.child = spawned.child;
    s.lastError = undefined;

    const waitMs = opts.waitMs ?? READY_TIMEOUT_MS;
    const ok = await waitReady(waitMs, spawned.child);
    if (!ok) {
      const exit = s.lastExit;
      const exitNote = exit && Date.now() - exit.at < waitMs + 2000
        ? ` (process exited: code=${exit.code} signal=${exit.signal})`
        : '';
      s.lastError = `bridge did not answer /setup/status within ${waitMs}ms${exitNote}`;
      s.lastFailure = { at: Date.now(), error: s.lastError, logPath: spawned.logPath };
    } else {
      s.lastFailure = undefined;
    }
    return { ok, online: ok, spawned: true, error: ok ? undefined : s.lastError, logPath: spawned.logPath };
  })();
  try {
    return await s.inflight;
  } finally {
    s.inflight = undefined;
  }
}

/** 排障用快照（宿主侧运行态，不含任何 token） */
export function ocrBridgeDiagnostics(): {
  port: number;
  statusUrl: string;
  spawnedPid?: number;
  logPath?: string;
  lastError?: string;
  lastExit?: { code: number | null; signal: string | null; at: number };
} {
  const s = state();
  return {
    port: ocrBridgePort(),
    statusUrl: ocrBridgeStatusUrl(),
    spawnedPid: s.child?.pid,
    logPath: s.logPath ?? ocrBridgeLogPath(),
    lastError: s.lastError,
    lastExit: s.lastExit,
  };
}
