/**
 * Electron 主进程
 *
 * 启动 Next.js standalone 服务为子进程，创建 BrowserWindow 加载本地 URL。
 * 生产模式下从打包资源中启动 Next.js 服务；开发模式下连接 pnpm dev。
 */

import { app, BrowserWindow, shell, ipcMain, Notification, dialog, session, nativeTheme, globalShortcut, systemPreferences, clipboard, nativeImage, screen } from 'electron';
import { spawn, spawnSync, execFile, execFileSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { autoUpdater } from 'electron-updater';
import { readSettingsFromFile, writeSettingsToFile, settingsFileExists } from '../src/lib/settings-server';
import { captureRegionToFile, cleanupShotFile, ocrRecognize, ensureScreenRecordingPermission as checkScreenRecordingPermission, requestScreenRecordingPermission, buildScreenPermissionError } from '../src/lib/screen-ocr/capture';
import { setupHippoBrowser, openHtmlInHippo, isHippoReady, toggleWindow, setMainWindowCapsuleListener } from './hippo-browser';

let nextServerProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
/** 运行期服务重启中（看门狗同一时刻只允许一次重启，避免并发拉起多个 next-server） */
let serverRestartInFlight = false;
/** 应用退出中（before-quit 已触发）：看门狗不再探测/重启服务 */
let appQuitting = false;

/** 是否为开发模式：app.isPackaged 在非 asar 打包时不可靠，改为检查 standalone 目录是否存在 */
const standaloneDir = path.join(process.resourcesPath, 'next-standalone');
const isDev = !fs.existsSync(standaloneDir);

const PORT = isDev
  ? Number(process.env.BOB_DEV_PORT || process.env.PORT) || 3000
  : 8321;
const SERVER_URL = `http://localhost:${PORT}`;

/** 日志写入文件（生产模式诊断用） */
const logDir = isDev ? null : app.getPath('logs');
const logFile = isDev ? null : path.join(logDir!, 'bob-work.log');
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(line.trim());
  if (logFile) {
    try {
      // 确保日志目录存在
      if (!fs.existsSync(logDir!)) fs.mkdirSync(logDir!, { recursive: true });
      fs.appendFileSync(logFile, line);
    } catch { /* ignore */ }
  }
}

// ===== 单实例锁：防止多实例同时竞争 8321 端口互相 SIGKILL（闪退放大器） =====
// 更新安装脚本用 `open` 拉起新版本时，若旧实例尚未完全退出，两个实例会同时执行
// "SIGKILL stale port 8321"，把对方的 next-server 杀成孤儿 → 主进程闪退。
// 锁保证同一时刻只有一个主进程进入启动流程：
//   - 拿不到锁 = 已有实例在跑，本实例立即退出（不碰端口、不创建窗口）
//   - second-instance = 用户重复打开/更新拉起时，聚焦已有实例窗口
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  log('Another BobWork instance is already running — quitting this instance (single-instance lock).');
  app.exit(0);
} else {
  app.on('second-instance', () => {
    log('Second instance detected — focusing existing main window.');
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 捕获未处理异常，避免 Electron 弹出 "Uncaught Exception" 对话框
process.on('uncaughtException', (err: Error) => {
  log(`Uncaught Exception: ${err.message}\n${err.stack ?? ''}`);
});
process.on('unhandledRejection', (reason: unknown) => {
  log(`Unhandled Rejection: ${String(reason)}`);
});

// 子进程（GPU/Utility/网络服务等）崩溃监听：补全 render-process-gone 覆盖不到的进程级崩溃
app.on('child-process-gone', (_event, details) => {
  log(
    `Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} ` +
    `name=${details.name ?? ''} service=${details.serviceName ?? ''}`,
  );
});

/** 等待 Next.js 服务就绪 */
function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http
        .get(url, (res) => {
          if (res.statusCode === 200 || res.statusCode === 307) {
            resolve();
          } else {
            retry();
          }
          res.destroy();
        })
        .on('error', () => retry());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server at ${url} did not start within ${timeoutMs}ms`));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

/**
 * 构建子进程 PATH — 确保 node、git 等常用命令可被发现。
 *
 * launchd 启动的 GUI 应用 PATH 极不完整，而用户的 node 可能通过
 * nvm/fnm/Homebrew 安装在非标准路径。这里合并多个来源：
 *   1. 当前 process.env.PATH（shell launcher 已设置的基础路径）
 *   2. Homebrew 标准路径（Intel & Apple Silicon）
 *   3. nvm 默认路径（通过 glob 扫描）
 *   4. 用户 .workbuddy 管理的 node 路径
 */
function buildChildPath(): string {
  const home = app.getPath('home');
  const pathDirs = new Set<string>([
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ]);

  // 用户当前 PATH（可能包含 shell launcher 设置的路径）
  const currentPath = process.env.PATH || '';
  for (const dir of currentPath.split(':')) {
    const trimmed = dir.trim();
    if (trimmed) pathDirs.add(trimmed);
  }

  // nvm 路径（扫描 versions 目录）
  const nvmDir = path.join(home, '.nvm/versions/node');
  try {
    if (fs.existsSync(nvmDir)) {
      for (const ver of fs.readdirSync(nvmDir)) {
        const binDir = path.join(nvmDir, ver, 'bin');
        if (fs.existsSync(binDir)) pathDirs.add(binDir);
      }
    }
  } catch { /* ignore */ }

  // fnm 路径
  const fnmDir = path.join(home, '.fnm/node-versions');
  try {
    if (fs.existsSync(fnmDir)) {
      for (const ver of fs.readdirSync(fnmDir)) {
        const binDir = path.join(fnmDir, ver, 'installation', 'bin');
        if (fs.existsSync(binDir)) pathDirs.add(binDir);
      }
    }
  } catch { /* ignore */ }

  // WorkBuddy 管理的 node
  const wbNodeDir = path.join(home, '.workbuddy/binaries/node/versions');
  try {
    if (fs.existsSync(wbNodeDir)) {
      for (const ver of fs.readdirSync(wbNodeDir)) {
        const binDir = path.join(wbNodeDir, ver, 'bin');
        if (fs.existsSync(binDir)) pathDirs.add(binDir);
      }
    }
  } catch { /* ignore */ }

  // volta 路径
  const voltaDir = path.join(home, '.volta/bin');
  if (fs.existsSync(voltaDir)) pathDirs.add(voltaDir);

  return Array.from(pathDirs).join(':');
}

/** 启动 Next.js standalone 服务
 *
 *  新增可靠性兜底（避免 splash 永远转圈）：
 *   1. 单次启动最多等 `bootTimeoutMs`，端口仍不通 → kill 后自动重启一次 `maxRestarts` 轮
 *      （已知偶发：孤儿端口没杀净、fs cache 锁、next 首次编译 hang，杀掉重启即可自愈）
 *   2. startNextServer 返回的 ChildProcess 上挂载 `startupReady: Promise<void>`，
 *      上层用 `Promise.race([proc.startupReady, waitForServer])` 保证如果 proc 意外
 *      exit / ENOENT，不等 30s 超时就能立刻跳错误页。
 */
function startNextServer(): ChildProcess & { startupReady: Promise<void> } {
  if (isDev) {
    // 开发模式：next dev 已由 pnpm dev:web 启动，无需在此启动
    const err = new Error('Should not start server in dev mode');
    const fake = Object.assign({} as ChildProcess & { startupReady: Promise<void> }, {
      startupReady: Promise.reject(err),
    });
    return fake;
  }

  const bootTimeoutMs = 12000;
  const maxRestarts = 1;

  let attempts = 0;
  let curProc: ChildProcess | null = null;
  let stopTimer: (() => void) | null = null;

  const startupReady = new Promise<void>((resolve, reject) => {
    const trySpawn = () => {
      // 启动前先清本应用全部残留 next-server（含不监听端口、卡死占 CPU 的僵尸实例），
      // 防止多次启动/闪退导致的孤儿进程堆积（它们不会被下方"只清监听端口"的 lsof 逻辑抓到）
      killStaleNextServers();
      // 每轮启动前再清一次端口：第一轮 SIGTERM 可能没杀干净，第二轮前补一次
      try {
        const probe = spawnSync('/usr/sbin/lsof', [`-tiTCP:${PORT}`, '-sTCP:LISTEN'], {
          encoding: 'utf8',
          timeout: 3000,
        });
        const stalePids = (probe.stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s !== '' && s !== String(process.pid));
        for (const pid of stalePids) {
          try {
            process.kill(Number(pid), 'SIGKILL');
            log(`Spawn attempt ${attempts}: SIGKILL stale port ${PORT} pid=${pid}`);
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }

      const serverPath = path.join(process.resourcesPath, 'next-standalone', 'server.js');
      const childPath = buildChildPath();
      log(`Child PATH: ${childPath}`);

      let sandboxPath = path.join(app.getPath('home'), 'BobWork', '.sandbox');
      // 限制 V8 old space 上限为 1GB，避免长时间运行后堆膨胀到 1.49GB+ 触发 macOS jetsam 杀进程
      // （历史崩溃：node 24h 写 137GB + Footprint 1.49GB → jetsam → 应用闪退）
      const proc = spawn('node', ['--max-old-space-size=1024', serverPath], {
        cwd: path.join(process.resourcesPath, 'next-standalone'),
        env: {
          ...process.env,
          PATH: childPath,
          PORT: String(PORT),
          HOSTNAME: 'localhost',
          NODE_ENV: 'production',
          COZE_WORKSPACE_PATH: sandboxPath,
          FFMPEG_PATH: path.join(process.resourcesPath, 'bin', 'ffmpeg'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      curProc = proc;
      if (!nextServerProc) nextServerProc = proc; // 同步写全局（供 killNextServer 用）

      proc.on('error', (e: Error) => {
        log(`Next.js server process error (attempt ${attempts}): ${e.message}`);
      });

      proc.stdout?.on('data', (d: Buffer) => log(`[next] ${d.toString().trim()}`));
      proc.stderr?.on('data', (d: Buffer) => log(`[next:err] ${d.toString().trim()}`));

      // 单次启动超时：若 bootTimeoutMs 内服务仍没起来，判死刑并重启
      const bootTimer = setTimeout(() => {
        log(`Next.js boot timeout ${bootTimeoutMs}ms (attempt ${attempts}), killing pid=${proc.pid}`);
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, bootTimeoutMs);
      stopTimer = () => clearTimeout(bootTimer);

      // 启动成功探测：端口返回 200/307 → 本轮通过
      let settled = false;
      const probeStart = Date.now();
      const probeInterval = setInterval(() => {
        http.get(`http://localhost:${PORT}/`, (res) => {
          if (res.statusCode === 200 || res.statusCode === 307 || res.statusCode === 302) {
            if (!settled) {
              settled = true;
              clearInterval(probeInterval);
              stopTimer?.();
              log(`Next.js server up in ${Date.now() - probeStart}ms (attempt ${attempts})`);
              resolve();
            }
          }
          res.destroy();
        }).on('error', () => { /* retry */ });
      }, 300);

      proc.on('exit', (code, signal) => {
        log(`Next.js server exited: code=${code}, signal=${signal} (attempt ${attempts})`);
        clearInterval(probeInterval);
        stopTimer?.();
        if (settled) return; // 正常启动后 exit 不归启动逻辑管（由退出时的 handler 处理）
        if (attempts < maxRestarts) {
          attempts += 1;
          log(`Restarting Next.js server… (attempt ${attempts}/${maxRestarts})`);
          setTimeout(trySpawn, 300);
        } else {
          reject(new Error(
            `Next.js server failed to start after ${attempts + 1} attempts ` +
            `(last exit code=${code ?? 'null'}, signal=${signal ?? 'null'})`
          ));
        }
      });
    };

    trySpawn();
  });

  // 用返回的 curProc 作为主体；外层同步替换时始终引用当前子进程
  return new Proxy(curProc!, {
    get(target, prop, receiver) {
      if (prop === 'startupReady') return startupReady;
      // ⚠️ 不能引用全局 nextServerProc：它会被赋值为本 Proxy 自身（startNextServer 返回值），
      // 若再经 Reflect.get(live=nextServerProc,...) 会再次进入本 trap → 无限递归 → 栈溢出。
      // 直接用 Proxy 的 target（即最新 curProc 原始子进程）即可。
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as Function).bind(target) : v;
    },
  }) as ChildProcess & { startupReady: Promise<void> };
}

/**
 * 终止 Next.js 子进程。
 * ⚠️ 必须显式调用：安装更新用 app.exit(0) 退出时不会触发 before-quit/will-quit，
 * 若不杀掉子进程，它会成为孤儿进程继续占用端口，导致更新重启后新版本服务无法启动（应用打不开）。
 * SIGTERM 后 800ms 未退出再 SIGKILL 兜底（卡死/忙循环实例会忽略 SIGTERM）；
 * 最后清一轮全部残留实例，防止历史孤儿堆积。
 */
function killNextServer(): void {
  const proc = nextServerProc;
  nextServerProc = null;
  if (proc && !proc.killed) {
    try {
      proc.kill(); // SIGTERM
      const t = setTimeout(() => {
        try {
          if (!proc.killed) {
            proc.kill('SIGKILL');
            log('Next.js server SIGKILL fallback (SIGTERM ignored / slow exit)');
          }
        } catch { /* ignore */ }
      }, 800);
      if (typeof (t as NodeJS.Timeout & { unref?: () => void }).unref === 'function') {
        (t as NodeJS.Timeout & { unref: () => void }).unref();
      }
    } catch { /* ignore */ }
  }
  killStaleNextServers();
}

/**
 * 清理本应用残留的 next-server 进程（含不监听端口、卡死占 CPU 的僵尸实例）。
 * 两步识别，双保险不误杀：
 *   1. ps 按进程标题匹配 `next-server`（Next standalone 启动后 process.title 变为 "next-server (vxx)"，
 *      命令行里不含路径，不能用路径匹配）；
 *   2. lsof 按 cwd 二次确认进程工作目录位于本应用 next-standalone。
 * 仅影响 BobWork.app 安装版；dev 模式（next dev）与其它 next-server 进程不受影响。
 * 启动时调用防止多实例堆积；退出时调用兜底清除历史孤儿。
 */
function killStaleNextServers(): void {
  try {
    const ps = spawnSync('ps', ['axo', 'pid=,command='], { encoding: 'utf8', timeout: 3000 });
    const candidates = new Set<number>();
    for (const line of (ps.stdout || '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+next-server/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid !== process.pid) candidates.add(pid);
    }
    if (candidates.size === 0) return;
    const lsof = spawnSync('lsof', ['-a', '-d', 'cwd', '-p', [...candidates].join(',')], {
      encoding: 'utf8',
      timeout: 4000,
    });
    for (const line of (lsof.stdout || '').split('\n')) {
      // cwd 行格式：node <pid> ... cwd DIR ... /Applications/BobWork.app/Contents/Resources/next-standalone
      if (!line.includes('next-standalone')) continue;
      const m = line.match(/^\S+\s+(\d+)\s/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!candidates.has(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        log(`Stale next-server cleanup: SIGKILL pid=${pid} (next-standalone orphan)`);
      } catch { /* 已退出则忽略 */ }
    }
  } catch { /* ps/lsof 不可用时不阻塞启动 */ }
}

/** 探测本地 Next.js 服务是否可达（连接级；返回 500 等也视为存活，只有连接失败才算死） */
function probeServer(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(SERVER_URL, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    // 防挂起：3s 无响应视为失败（本地 TCP 正常毫秒级响应）
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 运行期重启 Next.js 服务（看门狗用）。
 * 先终止当前子进程并清残留，再走 startNextServer 的启动自愈流程并等待就绪。
 * 同一时刻只允许一次重启；应用退出中不执行；dev 模式服务由外部 dev.sh 管理，不在此重启。
 */
async function restartNextServer(): Promise<boolean> {
  if (isDev || serverRestartInFlight || appQuitting) return false;
  serverRestartInFlight = true;
  try {
    log('[server-watchdog] Server unreachable — restarting Next.js server…');
    killNextServer(); // SIGTERM → 800ms SIGKILL 兜底 + 清理残留，并置 nextServerProc = null
    const proc = startNextServer();
    nextServerProc = proc;
    await Promise.race([
      waitForServer(SERVER_URL, 30000),
      (proc as ChildProcess & { startupReady?: Promise<void> }).startupReady ?? Promise.resolve(),
    ]);
    log('[server-watchdog] Next.js server restarted and ready.');
    return true;
  } catch (err) {
    log(`[server-watchdog] Restart failed: ${err}`);
    return false;
  } finally {
    serverRestartInFlight = false;
  }
}

/**
 * 运行期服务看门狗（仅生产）：每 15s 探测一次本地服务，连续 2 次连接失败即判定
 * 服务已死（闲置期间崩溃 / 被系统回收 / 异常退出），自动重启自愈。
 * 修复「BobWork 停滞久了，ChatNode 报 Error: Failed to fetch」——此前服务进程
 * 运行期退出不会被重启（startNextServer 的 exit 处理器只处理启动期）。
 */
function startServerWatchdog(): void {
  if (isDev) return; // dev 模式服务由 dev.sh 外部管理
  let failures = 0;
  const timer = setInterval(() => {
    if (appQuitting || serverRestartInFlight) return;
    probeServer().then((ok) => {
      if (ok) {
        failures = 0;
        return;
      }
      failures += 1;
      log(`[server-watchdog] Probe failed (${failures}/2).`);
      if (failures >= 2) {
        failures = 0;
        restartNextServer().catch(() => {});
      }
    });
  }, 15000);
  if (typeof (timer as NodeJS.Timeout & { unref?: () => void }).unref === 'function') {
    (timer as NodeJS.Timeout & { unref: () => void }).unref();
  }
  log('[server-watchdog] Runtime server watchdog started (15s interval).');
}

/** 渲染进程崩溃自动重载冷却期（防崩溃循环时无限 reload 刷屏/抖动） */
const RENDERER_RELOAD_COOLDOWN_MS = 5 * 60 * 1000;
/** 最近一次崩溃时间（按 webContents.id） */
const rendererCrashAt = new Map<number, number>();

/** 创建主窗口（加载完成前保持隐藏，由欢迎窗口先行展示） */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'BobWork',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f5f5f7',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 使用 os.homedir()/process 等 Node 能力，必须关闭渲染进程沙箱，
      // 否则沙箱化 preload 中 require('os') 抛错 → window.api 不注入 → 本地文件夹等功能全部失效
      sandbox: false,
    },
  });

  // 外部链接在系统浏览器中打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 渲染进程崩溃监听：任何窗口（含 activate 重建的）都记录崩溃原因到日志；
  // 非正常退出（crashed/killed/oom 等）尝试自动重载恢复，5 分钟冷却防崩溃循环刷屏。
  win.webContents.on('render-process-gone', (_event, details) => {
    try {
      log(
        `Renderer process gone: webContentsId=${win.webContents.id} url=${win.webContents.getURL()} ` +
        `reason=${details.reason} exitCode=${details.exitCode}`,
      );
    } catch { /* webContents 已销毁时忽略取数失败 */ }
    if (details.reason === 'clean-exit' || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const now = Date.now();
    const last = rendererCrashAt.get(win.webContents.id) ?? 0;
    if (now - last < RENDERER_RELOAD_COOLDOWN_MS) {
      log(`Renderer auto-reload skipped (cooldown active, last crash ${now - last}ms ago)`);
      return;
    }
    rendererCrashAt.set(win.webContents.id, now);
    log(`Renderer crashed (reason=${details.reason}), attempting auto-reload`);
    win.webContents.reload();
  });

  return win;
}

// ============ 全局截图 OCR（Cmd+Shift+O：系统选区截屏 → OCR → 结果回填对话输入框） ============

/** 全局快捷键（macOS 为 Cmd+Shift+O；CommandOrControl 兼容 Win 的 Ctrl） */
const SCREEN_OCR_SHORTCUT = 'CommandOrControl+Shift+O';
/** 防重入：截图选区为交互阻塞流程，避免连按触发叠加 */
let screenOcrBusy = false;
/** 编辑阶段待处理截图文件：截屏后暂存，编辑确认后同文件 OCR，取消/完成即清理 */
let pendingShotPath: string | null = null;

/** 清理编辑阶段暂存截图（取消/完成共用，幂等） */
function cleanupPendingShot(): void {
  if (!pendingShotPath) return;
  cleanupShotFile(pendingShotPath);
  pendingShotPath = null;
}

/** 截图编辑覆盖窗口（微信式）：截图后在独立全屏窗口内编辑，不切走 BobWork 主界面 */
let ocrEditorWindow: BrowserWindow | null = null;
/** 待编辑截图：覆盖窗口页挂载后主动拉取（避免 send 时序竞争） */
let pendingEditorShot: { dataUrl: string; mode: 'region' | 'full' } | null = null;

/** 创建/复用截图编辑覆盖窗口（透明置顶、覆盖光标所在显示器）；失败返回 null（调用方回退主窗口编辑）。
 *  窗口常驻复用：编辑完成仅 hide 不销毁，下次截图直接 show + 下发新截图，
 *  省去每次新建窗口 + 重新加载 Next 页面（消除"截图→出现编辑画面"的卡顿）。 */
function openScreenOcrEditorWindow(dataUrl: string, mode: 'region' | 'full'): BrowserWindow | null {
  try {
    if (ocrEditorWindow && !ocrEditorWindow.isDestroyed() && !ocrEditorWindow.webContents.isCrashed()) {
      // 复用常驻窗口：移到光标所在显示器 → 显示 → 下发新截图
      pendingEditorShot = { dataUrl, mode };
      try {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        ocrEditorWindow.setBounds(display.bounds);
      } catch { /* ignore */ }
      ocrEditorWindow.show();
      ocrEditorWindow.focus();
      try { app.focus({ steal: true }); } catch { /* ignore */ }
      try { ocrEditorWindow.webContents.focus(); } catch { /* ignore */ }
      // 兼容新旧前端：先尝试直发（新前端监听 new-shot），同时 reload 兜底——
      // 旧前端无 new-shot 监听，reload 后页面经 getEditorShot 拉取最新截图（pending 已更新）。
      try { ocrEditorWindow.webContents.send('screen-ocr:new-shot', { dataUrl, mode }); } catch { /* ignore */ }
      if (ocrEditorWindow && !ocrEditorWindow.isDestroyed()) ocrEditorWindow.webContents.reload();
      return ocrEditorWindow;
    }
    if (ocrEditorWindow && !ocrEditorWindow.isDestroyed()) ocrEditorWindow.close();
    pendingEditorShot = { dataUrl, mode };
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    ocrEditorWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    ocrEditorWindow.setAlwaysOnTop(true, 'screen-saver');
    ocrEditorWindow.on('closed', () => {
      ocrEditorWindow = null;
      pendingEditorShot = null;
    });
    // 覆盖窗口 console 转发（排查编辑器交互问题；主窗口日志同前缀文件）
    ocrEditorWindow.webContents.on('console-message', (_e, level, message) => {
      try {
        fs.appendFileSync(path.join(os.homedir(), '.bobwork-renderer.log'), `[OCR-WIN:${level}] ${message}\n`);
      } catch { /* ignore */ }
    });
    ocrEditorWindow.webContents.on('render-process-gone', (_e, details) => {
      try {
        fs.appendFileSync(path.join(os.homedir(), '.bobwork-renderer.log'), `[OCR-WIN:gone] ${JSON.stringify(details)}\n`);
      } catch { /* ignore */ }
    });
    ocrEditorWindow.loadURL(`${SERVER_URL}/ocr-editor`);
    ocrEditorWindow.show();
    ocrEditorWindow.focus();
    // 覆盖窗口需键盘焦点（文字输入框 / Esc 退出）：截图时 BobWork 可能在后台，
    // 必须把应用强制激活为前台，否则 textarea 无法聚焦输入
    try { app.focus({ steal: true }); } catch { /* ignore */ }
    try { ocrEditorWindow.webContents.focus(); } catch { /* ignore */ }
    return ocrEditorWindow;
  } catch (e) {
    log(`创建截图编辑覆盖窗口失败，回退主窗口编辑: ${e instanceof Error ? e.message : String(e)}`);
    ocrEditorWindow = null;
    pendingEditorShot = null;
    return null;
  }
}

/** 读取图片文件为 data URL（供下发渲染层编辑面板） */
async function fileToDataUrl(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const buf = await fs.promises.readFile(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 屏幕录制 TCC 权限 gate（2026-08-30 新增）：
 * 截图前一次性处理权限，避免每次 Cmd+Shift+O 都让 macOS 弹系统权限窗。
 *  - granted → 直接截图；
 *  - denied → 先主动请求一次（弹系统授权窗，归因正确实体），授权成功则本次直接继续；
 *    仍拒绝 → 引导 + 一键打开系统设置屏幕录制面板（冷却限频）。
 *
 * 注意：判定走「与 screencapture 同一责任链」的 CGPreflight/SCShareableContent 预检
 * （而非 systemPreferences 的应用自身身份）——dev 模式责任进程是终端、打包版是 .app 本体，
 * 旧实现因此误判（用户已勾选仍提示未授权）。
 */
let screenRecordingGranted = false;
/** 权限引导提示冷却时间戳：防连按快捷键反复弹同一条引导/反复打开系统设置 */
let lastScreenPermPromptAt = 0;
const SCREEN_PERM_PROMPT_COOLDOWN_MS = 60_000;

async function ensureScreenRecordingPermission(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  if (screenRecordingGranted) return true;

  // 权威检测：与 screencapture 同责任链（只读，不弹窗）
  const status = await checkScreenRecordingPermission();
  if (status === 'granted') {
    screenRecordingGranted = true;
    return true;
  }
  if (status === 'unknown') {
    // 预检不可用：不阻塞，让 captureRegionToFile 内 screencapture 自行判定（失败会带原始错误）
    return true;
  }

  // 未授权：由主进程（应用自身稳定身份）发起授权。
  // 关键：不用子进程 CGRequest 弹窗——子进程责任链不稳定会导致授权落空、每次热键都重新弹窗。
  const asked = await askScreenRecordingFromMain();
  if (asked === true) {
    // 授权已写入：重新走子链检测（screencapture 每次都是全新子进程，通常即时生效）
    const after = await checkScreenRecordingPermission();
    if (after === 'granted') {
      screenRecordingGranted = true;
      return true;
    }
    // 个别系统版本要求重启后才对新进程生效：引导重启，本次不截图（避免误判为失败或循环弹窗）
    sendScreenPermGuide('已授权「屏幕录制」。请完全退出并重新打开 BobWork，再按 Cmd+Shift+O。');
    return false;
  }
  if (asked === 'unavailable') {
    // askForMediaAccess 不可用（旧版 Electron / 未签名）：回退子进程 CGRequest，
    // 但冷却限频（60s 一次），避免子进程责任链不稳定导致的循环弹窗
    const now = Date.now();
    if (now - lastScreenPermPromptAt >= SCREEN_PERM_PROMPT_COOLDOWN_MS) {
      lastScreenPermPromptAt = now;
      const fallback = await requestScreenRecordingPermission();
      if (fallback === 'granted') {
        screenRecordingGranted = true;
        return true;
      }
    }
  }
  // 拒绝或仍不可用：引导 + 一键打开系统设置屏幕录制面板（端侧闭环，用户无需自己找设置项）
  sendScreenPermGuide();
  return false;
}

/**
 * 由 Electron 主进程发起屏幕录制授权请求（应用自身稳定 TCC 身份）。
 * @returns true=已授权；false=被拒/未授权；'unavailable'=API 不可用（需回退子进程）
 */
async function askScreenRecordingFromMain(): Promise<boolean | 'unavailable'> {
  try {
    // 注：Electron 类型定义未收录 'screen'（运行时自 13 起支持），显式收窄类型
    const ask = systemPreferences.askForMediaAccess as unknown as (mediaType: 'screen') => Promise<boolean>;
    const granted = await ask('screen');
    return granted === true;
  } catch {
    return 'unavailable';
  }
}

/** 屏幕录制权限引导提示（冷却限频）＋ 一键打开系统设置屏幕录制面板 */
function sendScreenPermGuide(message?: string): void {
  const now = Date.now();
  if (now - lastScreenPermPromptAt < SCREEN_PERM_PROMPT_COOLDOWN_MS) return;
  lastScreenPermPromptAt = now;
  mainWindow?.webContents.send('screen-ocr:error', {
    message: message ?? buildScreenPermissionError(),
  });
  // 直达 系统设置 → 隐私与安全性 → 屏幕录制（与 /api/bobby open_permissions 同款 URL，已实测可用）
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => {});
}

/**
 * 助手版本标记：bump 时触发重新安装（TCC 按签名绑定，重装=重新签名=旧授权失效，
 * 重装后会自动 reset 失配条目并弹一次系统授权窗恢复，用户点「允许」即可）。
 * 策略：仅当 BobWorkCapture 功能/代码确实变更时才 bump；BobWork 常规更新不 bump
 * （同版本直接复用已安装助手，授权长期保留，不会反复索要）。
 */
const CAPTURE_HELPER_VERSION = '1.0.5';

/** 助手安装目录：~/Library/Application Support/BobWorkCapture/（打包版）| BobWorkCapture-Dev/（dev）。
 *  必须独立于 BobWork 包内（嵌套在父包 Resources 的 .app 经 open 启动时，
 *  macOS 可能将其 TCC 归因给父应用，导致授权落不到助手自身）。
 *  dev 与打包版分目录 + 独立 bundle id（见 captureHelperBundleId）：两者都是 ad-hoc 签名
 *  且每次重签不同，若共享同一 TCC 条目会互相踢授权（后装者的签名与条目 csreq 失配，
 *  表现为「已勾选仍提示无权限」），分目录分 id 后互不干扰。 */
function captureHelperInstallDir(): string {
  const suffix = isDev ? '-Dev' : '';
  return path.join(app.getPath('appData'), `BobWorkCapture${suffix}`);
}

/** BobWorkCapture 的 TCC bundle id：dev 独立身份，与打包版授权条目彻底隔离 */
function captureHelperBundleId(): string {
  return isDev ? 'com.bobwork.capture.dev' : 'com.bobwork.capture';
}

/** 确保助手已安装到稳定目录（原子替换，绝不留下损坏状态；失败返回 null 且不破坏现有安装）。
 *  版本变化触发重装时，因重新签名会导致原屏幕录制授权失效，重装完成后自动请求一次授权恢复。 */
function ensureCaptureHelperInstalled(bundledApp: string): string | null {
  const dest = path.join(captureHelperInstallDir(), 'BobWorkCapture.app');
  const markerFile = path.join(captureHelperInstallDir(), '.installed-version');
  const srcBin = path.join(bundledApp, 'Contents', 'MacOS', 'BobWorkCapture');
  // 源不完整 → 不安装
  if (!fs.existsSync(srcBin)) return null;
  const upToDate =
    fs.existsSync(path.join(dest, 'Contents', 'MacOS', 'BobWorkCapture')) &&
    fs.readFileSync(markerFile, 'utf8') === CAPTURE_HELPER_VERSION;
  if (upToDate) return dest;
  // 区分「首次安装」与「版本升级重装」：升级重装后原 TCC 授权（按签名绑定）必然失效，
  // 需自动请求一次恢复；首次安装不打扰，留给用户首次使用时自然触发授权。
  const wasInstalled = fs.existsSync(path.join(dest, 'Contents', 'MacOS', 'BobWorkCapture'));

  // 原子替换：先复制到临时目录并校验，再一次性替换，避免中途失败留下坏 .app
  const tmp = path.join(captureHelperInstallDir(), `.tmp-${Date.now()}`);
  try {
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.cpSync(bundledApp, tmp, { recursive: true });
    if (!fs.existsSync(path.join(tmp, 'Contents', 'MacOS', 'BobWorkCapture'))) {
      throw new Error('复制后二进制缺失');
    }
    try { execFileSync('/usr/bin/xattr', ['-cr', tmp]); } catch { /* ignore */ }
    // dev 安装改用独立身份（bundle id / 名称）：与打包版的 TCC 授权条目彻底隔离，互不踢授权
    if (isDev) {
      try {
        const plist = path.join(tmp, 'Contents', 'Info.plist');
        execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.bobwork.capture.dev', plist]);
        execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', 'BobWork Capture Dev', plist]);
        execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', 'BobWork Capture Dev', plist]);
      } catch { /* 身份改写失败不阻塞安装（退化为共享身份，仅授权可能互踢） */ }
    }
    // 固定本地证书签名（签名恒定 → TCC 授权跨版本保留，重装不再反复要授权）。
    // 证书缺失（新环境）回退 ad-hoc 保证可用，但授权将随重装失效（罕见，会在截图时提示）。
    const signTmp = () => {
      try {
        execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', 'BobWork Local Signing', tmp]);
        return true;
      } catch {
        try { execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', tmp]); } catch { /* ignore */ }
        return false;
      }
    };
    const signedFixed = signTmp();
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    if (!signedFixed) log('WARNING: 固定签名证书 BobWork Local Signing 缺失，已回退 ad-hoc（授权将随重装失效）');
    fs.writeFileSync(markerFile, CAPTURE_HELPER_VERSION);
    log(`BobWorkCapture 助手已安装: ${dest}`);
    // 版本升级重装：静默请求一次屏幕录制授权（helper request 模式，未决时弹系统授权窗归因 BobWork Capture）
    if (wasInstalled) {
      requestCapturePermission(dest);
    }
    return dest;
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    log(`BobWorkCapture 助手安装失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 重置 BobWorkCapture 的屏幕录制授权条目（tccutil）。
 *  关键场景：ad-hoc 重签后旧 TCC 记录仍在（系统设置显示「已勾选」）但签名校验失败，
 *  preflight 恒为 false——用户反复勾选无效，只有整条 reset 清掉失配记录后重新授权才能恢复；
 *  reset 同时保证随后 request 模式必弹授权窗（有记录时 CGRequestScreenCaptureAccess 不再弹）。 */
function resetCapturePermission(): void {
  try {
    execFileSync('/usr/bin/tccutil', ['reset', 'ScreenCapture', captureHelperBundleId()], { timeout: 10_000 });
    log(`BobWorkCapture 屏幕录制授权已重置 (${captureHelperBundleId()})`);
  } catch (e) {
    log(`BobWorkCapture 授权重置失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 经 LaunchServices 以 request 模式启动助手：请求一次屏幕录制授权（未决时弹系统授权窗归因 BobWork Capture）。
 *  用于版本升级重装后自动恢复授权；fire-and-forget，不阻塞安装流程（helper 侧轮询等待用户点击并写 status.json）。
 *  前置 reset：升级重装=重签=旧条目必然失配，不 reset 则可能已存在记录导致弹窗不出现。 */
function requestCapturePermission(helperApp: string): void {
  try {
    resetCapturePermission();
    const staging = path.join(os.homedir(), 'Library', 'Caches', 'bobwork-capture');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'request.json'), JSON.stringify({ action: 'request' }));
    fs.rmSync(path.join(staging, 'status.json'), { force: true });
    execFile('/usr/bin/open', [helperApp], { timeout: 10_000 }, () => {});
  } catch (e) {
    log(`BobWorkCapture 自动恢复授权失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 权限自动恢复闭环（截图被拒时调用）：
 *  1) tccutil reset 清掉失配/陈旧授权条目（系统设置里「已勾选」但签名校验失败的场景仅此可解）；
 *  2) request 模式启动助手，弹系统授权窗并等待用户点「允许」（helper 轮询 preflight，最长 90s）；
 *  3) 轮询 status.json 读取授权结果。
 *  返回 true 表示已授权落盘，调用方可直接重试截图——用户全程只需点一次「允许」。 */
async function recoverCapturePermission(helperApp: string): Promise<boolean> {
  try {
    resetCapturePermission();
    const staging = path.join(os.homedir(), 'Library', 'Caches', 'bobwork-capture');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'request.json'), JSON.stringify({ action: 'request' }));
    fs.rmSync(path.join(staging, 'status.json'), { force: true });
    const launched = await new Promise<boolean>((resolve) => {
      execFile('/usr/bin/open', [helperApp], { timeout: 10_000 }, (err) => resolve(!err));
    });
    if (!launched) return false;
    // helper 在「用户点允许 / 系统设置勾选 / 90s 超时」后写 status.json；留 100s 覆盖其等待窗口
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      try {
        const statusFile = path.join(staging, 'status.json');
        if (fs.existsSync(statusFile)) {
          const s = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as { granted?: boolean };
          return s.granted === true;
        }
      } catch { /* 原子写中，重试 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  } catch (e) {
    log(`BobWorkCapture 自动恢复授权失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** BobWorkCapture 截图助手 .app 路径：优先稳定安装目录（须版本匹配）；否则从包内 Resources / dev 产物安装 */
function resolveCaptureHelperApp(): string | null {
  // 1) 已安装到稳定目录（独立 TCC 身份）——必须校验版本标记，否则残留旧版（如仍用 -i 交互选区）会一直生效
  const installed = path.join(captureHelperInstallDir(), 'BobWorkCapture.app');
  let installedFresh = false;
  if (fs.existsSync(path.join(installed, 'Contents', 'MacOS', 'BobWorkCapture'))) {
    try {
      installedFresh = fs.readFileSync(path.join(captureHelperInstallDir(), '.installed-version'), 'utf8') === CAPTURE_HELPER_VERSION;
    } catch {
      installedFresh = false;
    }
  }
  if (installedFresh) return installed;
  // 2) 首次使用 / 安装缺失 / 版本过旧：从包内 Resources / dev 产物重新安装（逐个尝试）
  //    注意层级：tsup 编译后 __dirname=electron/dist（需 ../../../ 回 BobAgent 根），
  //    tsx 直跑时 __dirname=electron（只需 ../../）。
  const sources = [
    path.join(process.resourcesPath, 'BobWorkCapture.app'), // 打包版
    path.join(__dirname, '../../../screenshot-plugin/dist/BobWorkCapture.app'), // dev：tsup 编译产物（electron/dist）
    path.join(__dirname, '../../screenshot-plugin/dist/BobWorkCapture.app'), // dev：tsx 直跑（electron）
  ];
  for (const s of sources) {
    const installedPath = ensureCaptureHelperInstalled(s);
    if (installedPath) return installedPath;
  }
  return null;
}

/**
 * 经 LaunchServices 启动截图助手截屏（固定暂存目录契约，无参）。
 * 关键：必须用 open（LaunchServices）启动，不能直接 spawn 二进制——
 * 直接 spawn 会让 screencapture 的责任进程归因回 BobWork，失去独立 TCC 身份的意义。
 */
async function captureRegionViaHelper(helperApp: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
  const staging = path.join(os.homedir(), 'Library', 'Caches', 'bobwork-capture');
  const jsonFile = path.join(staging, 'result.json');
  const shotFile = path.join(staging, 'shot.jpg');

  // 上一轮编辑面板若仍在处理同一固定目录的暂存截图，先挪到独立临时路径，避免被本次清理覆盖
  if (pendingShotPath && path.dirname(pendingShotPath) === staging) {
    try {
      const keep = path.join(os.tmpdir(), `bobwork-edit-${Date.now()}${path.extname(pendingShotPath)}`);
      fs.copyFileSync(pendingShotPath, keep);
      pendingShotPath = keep;
    } catch { /* ignore */ }
  }
  // 清理上一次残留，保证轮询到的是本次结果
  try { fs.rmSync(jsonFile, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(shotFile, { force: true }); } catch { /* ignore */ }
  // 微信式：整屏捕获（JPEG，快）→ 前端覆盖窗口全屏显示原位画面并拖选；不再用 -i 原生选区
  try { fs.writeFileSync(path.join(staging, 'request.json'), JSON.stringify({ action: 'fullscreen' })); } catch { /* ignore */ }

  const launched = await new Promise<boolean>((resolve) => {
    execFile('/usr/bin/open', [helperApp], { timeout: 10_000 }, (err) => resolve(!err));
  });
  if (!launched) return { ok: false, error: '无法启动截图助手 BobWorkCapture（open 失败）' };

  // 轮询结果（整屏捕获秒回，30s 足够；超时按失败处理）
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(jsonFile)) {
        const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as { ok?: boolean; canceled?: boolean; error?: string };
        if (parsed.ok && fs.existsSync(shotFile)) return { ok: true, path: shotFile };
        if (parsed.canceled) return { ok: false, canceled: true };
        return { ok: false, error: parsed.error || '截图失败' };
      }
    } catch {
      /* JSON 原子写中，重试 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: false, error: '截图助手超时未返回结果' };
}

/** 助手权限引导：授权对象是「BobWork Capture」（已自动安装到 Application Support，稳定实体）。
 *  仅在自动恢复闭环（reset + 弹窗等待）失败后出现，此时需用户手动去系统设置勾选。
 *  附带权限诊断（diag.json 的 grantedAfter），便于一次性定位"授权是否真正落盘"。 */
function buildCaptureHelperPermError(): string {
  const appName = isDev ? 'BobWork Capture Dev' : 'BobWork Capture';
  const base = `未获得「屏幕录制」权限。已自动重置并弹出授权窗口但未完成授权。请到 系统设置 → 隐私与安全性 → 屏幕录制 手动勾选 ${appName}，完成后按 Cmd+Shift+O 重试（将再次自动弹出授权窗）。`;
  try {
    const diagPath = path.join(os.homedir(), 'Library', 'Caches', 'bobwork-capture', 'diag.json');
    if (fs.existsSync(diagPath)) {
      const d = JSON.parse(fs.readFileSync(diagPath, 'utf8')) as { grantedAfter?: boolean; grantedBefore?: boolean; bundleId?: string };
      const grantedAfter = typeof d.grantedAfter === 'boolean' ? d.grantedAfter : undefined;
      if (grantedAfter === false) {
        return `${base}（诊断：请求后授权仍未落盘，请确认勾选的是 BobWork Capture 而非旧条目）`;
      }
    }
  } catch { /* 无诊断信息不附加 */ }
  return base;
}

/** 读取「截图 OCR」功能开关（settings.screenOcr.enabled）；读取失败默认启用 */
async function isCapturePluginEnabled(): Promise<boolean> {
  try {
    const settings = await readSettingsFromFile();
    return settings.screenOcr?.enabled !== false;
  } catch {
    return true;
  }
}

/** 快捷键处理：优先截图插件助手（独立 TCC 身份）；助手缺失或功能关闭时回退内置链路 */
async function handleGlobalScreenOcr(): Promise<void> {
  if (screenOcrBusy) return;
  screenOcrBusy = true;
  try {
    const helperApp = resolveCaptureHelperApp();
    const useHelper = helperApp !== null && (await isCapturePluginEnabled());
    // 通知渲染层「选区进行中」（前端可据此弱化输入框焦点状态）
    mainWindow?.webContents.send('screen-ocr:start');

    let shot: { ok: boolean; path?: string; canceled?: boolean; error?: string };
    if (useHelper) {
      // 插件助手：独立 .app 拥有稳定屏幕录制授权，首次使用弹窗归因「BobWork Capture」，
      // 授权一次即永久生效，不受 BobWork 重建/更新影响。
      // 微信式：助手做整屏捕获（无交互，秒回 JPEG）→ 编辑覆盖窗口全屏显示原屏画面，
      // 选区由前端覆盖层蒙版拖选完成（画面保持原屏幕位置，无需 -i 原生选区）。
      shot = await captureRegionViaHelper(helperApp);
      if (!shot.ok && shot.error === 'SCREEN_PERMISSION_DENIED') {
        // 自动恢复：TCC 条目失配（重签后「已勾选仍失败」）时反复勾选无效，
        // reset + 重新弹授权窗 + 用户点「允许」后自动重截，全程无需手动去系统设置
        const recovered = await recoverCapturePermission(helperApp);
        if (recovered) {
          shot = await captureRegionViaHelper(helperApp);
        } else {
          sendScreenPermGuide(buildCaptureHelperPermError());
          return;
        }
      }
    } else {
      // 助手缺失（未构建/未分发）：回退内置链路（含权限 gate + 直连 screencapture）
      const permitted = await ensureScreenRecordingPermission();
      if (!permitted) return;
      shot = await captureRegionToFile();
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      if (shot.path) cleanupShotFile(shot.path);
      return;
    }
    if (!shot.ok) {
      if (shot.canceled) {
        mainWindow.webContents.send('screen-ocr:canceled');
        return;
      }
      mainWindow.webContents.send('screen-ocr:error', { message: shot.error ?? '截图失败' });
      return;
    }
    // 进入编辑阶段：记录待处理文件。
    // 微信式：截图一律为整屏画面（helper fullscreen 或内置全屏均同）→ mode 'full'，
    // 编辑覆盖窗口全屏显示（画面即原屏幕位置，无需居中），前端覆盖层变暗蒙版 → 用户拖选选区 → 标注。
    pendingShotPath = shot.path ?? null;
    const dataUrl = await fileToDataUrl(shot.path!);
    const mode = 'full' as 'full';
    const edWin = openScreenOcrEditorWindow(dataUrl, mode);
    if (!edWin) {
      // 覆盖窗口创建失败兜底：回退主窗口内编辑（ScreenOcrHost 渲染编辑面板）
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('screen-ocr:captured', { dataUrl, mode });
    }
  } catch (e) {
    log(`Screen OCR error: ${e instanceof Error ? e.message : String(e)}`);
    mainWindow?.webContents.send('screen-ocr:error', {
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    screenOcrBusy = false;
  }
}

/** 注册全局截图 OCR 快捷键与编辑面板回传 IPC（仅 macOS；选区截屏依赖 screencapture） */
function setupGlobalScreenOcr(): void {
  // 编辑面板 ✓：复制选区图片到系统剪贴板（不再走 OCR，转文字由 ocr-region 单独处理）
  ipcMain.handle('screen-ocr:copy-image', async (_e, payload: { dataUrl?: string }) => {
    try {
      if (!payload?.dataUrl) return { ok: false, error: '无图片数据' };
      const img = nativeImage.createFromDataURL(payload.dataUrl);
      if (img.isEmpty()) return { ok: false, error: '图片数据无效' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 编辑面板「To Text」：OCR 选区图片（dataUrl）→ 返回识别文本（请求/响应式）
  ipcMain.handle('screen-ocr:ocr-region', async (_e, payload: { dataUrl?: string }) => {
    let tmp: string | null = null;
    try {
      if (!payload?.dataUrl) return { ok: false, error: '无图片数据' };
      tmp = path.join(os.tmpdir(), `bobwork-ocr-${Date.now()}.png`);
      const base64 = payload.dataUrl.includes(',') ? payload.dataUrl.split(',')[1] : payload.dataUrl;
      fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
      const text = await ocrRecognize(tmp);
      if (!text.trim()) {
        return { ok: false, error: '选区内未识别到文字（可能选中了空白区域或纯图片）。' };
      }
      return { ok: true, text: text.trim() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (tmp) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      }
    }
  });

  // 编辑面板取消：放弃本次截图，清理临时文件
  ipcMain.on('screen-ocr:cancel-edit', cleanupPendingShot);
  // 编辑面板确认（✓）：清理暂存截图，避免 shot.png/result.json 残留
  ipcMain.on('screen-ocr:finish-edit', cleanupPendingShot);
  // 覆盖编辑窗口：页面挂载后主动拉取待编辑截图（幂等：取一次即清）
  ipcMain.handle('screen-ocr:get-editor-shot', () => {
    const shot = pendingEditorShot;
    pendingEditorShot = null;
    return shot;
  });
  // 覆盖编辑窗口：编辑完成/取消，隐藏窗口（常驻复用，下次截图免重建/免重载页面）
  ipcMain.on('screen-ocr:close-editor', () => {
    if (ocrEditorWindow && !ocrEditorWindow.isDestroyed()) ocrEditorWindow.hide();
  });

  // 设置面板：查询 BobWorkCapture 屏幕录制授权状态（助手 check 模式自报，不弹窗不截图）
  ipcMain.handle('screen-ocr:permission-status', async () => {
    const helperApp = resolveCaptureHelperApp();
    if (!helperApp) return { status: 'missing' as const };
    const staging = path.join(os.homedir(), 'Library', 'Caches', 'bobwork-capture');
    try {
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, 'request.json'), JSON.stringify({ action: 'check' }));
      fs.rmSync(path.join(staging, 'status.json'), { force: true });
      await new Promise<void>((resolve) => {
        execFile('/usr/bin/open', [helperApp], () => resolve());
      });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          if (fs.existsSync(path.join(staging, 'status.json'))) {
            const j = JSON.parse(fs.readFileSync(path.join(staging, 'status.json'), 'utf8')) as { granted?: boolean };
            return { status: j.granted ? ('granted' as const) : ('denied' as const) };
          }
        } catch {
          /* 原子写中，重试 */
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return { status: 'unknown' as const };
    } catch (e) {
      return { status: 'unknown' as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 设置面板：一键打开 系统设置 → 屏幕录制
  ipcMain.handle('screen-ocr:open-permissions', async () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => {});
    return { success: true };
  });

  if (process.platform !== 'darwin') {
    log('Screen OCR hotkey skipped: only supported on macOS');
    return;
  }
  const ok = globalShortcut.register(SCREEN_OCR_SHORTCUT, () => {
    void handleGlobalScreenOcr();
  });
  if (!ok) {
    log(`Global shortcut ${SCREEN_OCR_SHORTCUT} registration FAILED (conflict or unsupported)`);
  } else {
    log(`Global shortcut ${SCREEN_OCR_SHORTCUT} registered (screenshot OCR)`);
  }
}

// ============ 启动欢迎窗口（独立小窗口，主界面就绪后关闭） ============

/** 南瓜表情包 logo 目录（开发/打包双路径），用于欢迎窗口每次启动随机更换 logo */
function resolveSplashLogoDir(): string {
  if (isDev) {
    // 开发模式：直接读取项目 assets 目录
    return path.resolve(__dirname, '../../assets/南瓜表情包_裁切/去除背景_新');
  }
  // 打包模式：构建脚本已复制到 Resources/splash-logos/
  return path.join(process.resourcesPath, 'splash-logos');
}

/** 欢迎窗口默认法条库（首次启动写入 law-quotes.json，此后以 JSON 文件为准） */
const DEFAULT_LAW_QUOTES = [
  { text: '民事主体从事民事活动，不得违反法律，不得违背公序良俗。', source: '《中华人民共和国民法典》第八条' },
  { text: '民事主体的人身权利、财产权利以及其他合法权益受法律保护，任何组织或者个人不得侵犯。', source: '《中华人民共和国民法典》第三条' },
  { text: '民事主体从事民事活动，应当遵循诚信原则，秉持诚实，恪守承诺。', source: '《中华人民共和国民法典》第七条' },
  { text: '民事主体的财产权利受法律平等保护。', source: '《中华人民共和国民法典》第一百一十三条' },
  { text: '依法成立的合同，受法律保护。', source: '《中华人民共和国民法典》第四百六十五条' },
];

/** 应用数据根目录（与 sandbox/settings 同目录：统一 ~/BobWork） */
function appDataHome(): string {
  return process.env.BOBWORK_HOME || path.join(app.getPath('home'), 'BobWork');
}

/** 法条库文件路径：应用数据目录下 .law-quotes.json（点前缀 = Finder 默认隐藏；用户可直接编辑维护，无需改代码） */
function lawQuotesFile(): string {
  return path.join(appDataHome(), '.law-quotes.json');
}

/** 旧版非隐藏路径（早期版本写入过 law-quotes.json），迁移到隐藏文件后删除 */
function legacyLawQuotesFile(): string {
  return path.join(appDataHome(), 'law-quotes.json');
}

/**
 * 读取法条库 JSON 文件。
 * - 新路径（.law-quotes.json 隐藏文件）不存在但旧版 law-quotes.json 存在：一次性迁移并删除旧文件
 * - 文件不存在：用内置默认法条创建并写入（用户随后可自由编辑）
 * - 文件存在但损坏/格式不对：回退内置默认法条，不影响启动
 */
function loadLawQuotes(): Array<{ text: string; source: string }> {
  const file = lawQuotesFile();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) {
        const quotes = parsed
          .filter((q): q is { text: string; source: string } =>
            q && typeof q.text === 'string' && q.text.trim() && typeof q.source === 'string' && q.source.trim())
          .map((q) => ({ text: q.text.trim(), source: q.source.trim() }));
        if (quotes.length > 0) return quotes;
      }
    } else {
      // 迁移旧版非隐藏文件 law-quotes.json（一次性）：读内容 → 写隐藏文件 → 删除旧文件
      const legacy = legacyLawQuotesFile();
      if (fs.existsSync(legacy)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
          if (Array.isArray(parsed)) {
            const quotes = parsed
              .filter((q): q is { text: string; source: string } =>
                q && typeof q.text === 'string' && q.text.trim() && typeof q.source === 'string' && q.source.trim())
              .map((q) => ({ text: q.text.trim(), source: q.source.trim() }));
            if (quotes.length > 0) {
              fs.mkdirSync(appDataHome(), { recursive: true });
              fs.writeFileSync(file, JSON.stringify(quotes, null, 2), 'utf-8');
              fs.unlinkSync(legacy);
              log(`Law quotes migrated to hidden file: ${file}`);
              return quotes;
            }
          }
        } catch (e) {
          log(`Failed to migrate legacy law-quotes.json: ${String(e)}`);
        }
      }
      // 首次启动：写入默认法条（隐藏文件），方便用户发现并维护该文件
      try {
        fs.mkdirSync(appDataHome(), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(DEFAULT_LAW_QUOTES, null, 2), 'utf-8');
        log(`Law quotes file created: ${file}`);
      } catch (e) {
        log(`Failed to write law-quotes.json: ${String(e)}`);
      }
    }
  } catch (e) {
    log(`Failed to load law-quotes.json, using defaults: ${String(e)}`);
  }
  return DEFAULT_LAW_QUOTES;
}

/** 构建欢迎窗口 HTML（logo 以 base64 内嵌；主题颜色用 prefers-color-scheme 跟随系统深浅色） */
function buildSplashHtml(logoDataUrl: string, quote: { text: string; source: string }): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
:root {
  --bg: #faf9fc; --card: #ffffff; --text: #1f1b2e; --muted: #6f6a80; --border: #e7e3f0; --brand: #6b5bff;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #16141f; --card: #201c2d; --text: #f0eef6; --muted: #a39cb5; --border: #332d47; }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  display: flex; align-items: center; justify-content: center; user-select: none; overflow: hidden;
  -webkit-app-region: drag;
}
.splash { width: 100%; max-width: 360px; padding: 28px 30px 32px; display: flex; flex-direction: column; align-items: center; gap: 22px; text-align: center; }
.logo {
  width: 104px; height: 104px; border-radius: 50%; background: var(--card); border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  animation: breathe 2.4s ease-in-out infinite;
}
.logo img { width: 92px; height: 92px; object-fit: contain; }
@keyframes breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
.app-name { font-size: 21px; font-weight: 600; letter-spacing: 0.5px; }
.tagline { margin-top: 5px; font-size: 12px; color: var(--muted); }
.loading-btn {
  display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 26px; border: none; border-radius: 21px;
  background: var(--brand); color: #fff; font-size: 14px; font-family: inherit; cursor: default;
}
.spinner { width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.law {
  margin-top: 2px; padding: 14px 16px; border-left: 3px solid var(--brand); background: var(--card);
  border-radius: 8px; text-align: left;
}
.law-text { font-size: 13px; line-height: 1.7; }
.law-source { margin-top: 8px; font-size: 11px; color: var(--muted); text-align: right; }
</style></head><body>
<div class="splash">
  <div class="logo"><img src="${logoDataUrl}" alt="logo"/></div>
  <div>
    <div class="app-name">BobWork</div>
    <div class="tagline">法律智能工作台</div>
  </div>
  <div class="loading-btn"><span class="spinner"></span>正在加载，请稍候…</div>
  <div class="law">
    <div class="law-text">“${quote.text}”</div>
    <div class="law-source">—— ${quote.source}</div>
  </div>
</div>
</body></html>`;
}

/**
 * 创建并显示启动欢迎窗口（独立小窗口）。
 * - logo：从南瓜表情包目录随机选一张（每次启动自动更换）
 * - 动态加载按钮 + 一行随机民法典法条
 * - 主题颜色跟随系统深浅色（prefers-color-scheme）
 * - 资源缺失时返回 null（回退为直接等待主窗口，不影响启动）
 */
async function createSplashWindow(): Promise<BrowserWindow | null> {
  try {
    // 读取头像设置（mode: random/fixed），决定使用哪张头像
    const settings = await readSettingsFromFile();
    const avatarMode = settings.avatar?.mode ?? 'random';
    const avatarSelected = settings.avatar?.selected;

    const allAvatars = listAllAvatars();
    if (allAvatars.length === 0) {
      log('Splash skipped: no avatar files found');
      return null;
    }

    let logoDataUrl: string;
    if (avatarMode === 'fixed' && avatarSelected) {
      // 固定模式：使用用户选中的头像
      const found = allAvatars.find((a: AvatarItem) => a.id === avatarSelected);
      logoDataUrl = found
        ? found.dataUrl
        : allAvatars[0].dataUrl; // 选中的已被删除，回退第一张
      log(`Splash avatar: fixed (${avatarSelected})`);
    } else {
      // 随机模式：从所有头像中随机选一张
      logoDataUrl = allAvatars[Math.floor(Math.random() * allAvatars.length)].dataUrl;
      log(`Splash avatar: random`);
    }

    // 从 law-quotes.json 读取法条库（首次启动自动创建默认文件，用户可自由编辑维护）
    const lawQuotes = loadLawQuotes();
    const quote = lawQuotes[Math.floor(Math.random() * lawQuotes.length)];
    const html = buildSplashHtml(logoDataUrl, quote);

    const win = new BrowserWindow({
      width: 380,
      height: 520,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      center: true,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16141f' : '#faf9fc',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    return win;
  } catch (e) {
    log(`Splash window error: ${String(e)}`);
    return null;
  }
}

/** 关闭欢迎窗口（幂等） */
function closeSplashWindow(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.close();
}

// ============ 头像管理（模块级，欢迎窗口 + IPC 共用） ============

/** 用户自定义头像目录（应用数据根目录/avatars/） */
function customAvatarDir(): string {
  return path.join(appDataHome(), 'avatars');
}

/** 读取图片文件为 base64 data URL */
function imageToDataUrl(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

interface AvatarItem { id: string; name: string; dataUrl: string; builtin: boolean; }

/** 扫描内置 + 自定义头像目录，返回完整头像列表 */
function listAllAvatars(): AvatarItem[] {
  const items: AvatarItem[] = [];
  const seen = new Set<string>();

  // 内置头像（南瓜表情包）
  const builtinDir = resolveSplashLogoDir();
  try {
    if (fs.existsSync(builtinDir)) {
      for (const f of fs.readdirSync(builtinDir).sort()) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) continue;
        const id = `builtin/${f}`;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, name: f.replace(/\.[^.]+$/, ''), dataUrl: imageToDataUrl(path.join(builtinDir, f)), builtin: true });
      }
    }
  } catch { /* ignore */ }

  // 用户自定义头像
  const customDir = customAvatarDir();
  try {
    if (fs.existsSync(customDir)) {
      for (const f of fs.readdirSync(customDir).sort()) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) continue;
        const id = `custom/${f}`;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, name: f.replace(/\.[^.]+$/, ''), dataUrl: imageToDataUrl(path.join(customDir, f)), builtin: false });
      }
    }
  } catch { /* ignore */ }

  return items;
}

// ===== 自研断点续传更新下载器 =====
// 背景：electron-updater 自带下载器对中断恢复不可靠（部分场景 .partial 续传会永久卡死）。
// GitCode 的 release 下载 CDN 已验证支持 HTTP Range（返回 206），因此自研下载器接管下载：
//   断点续传（断网/重启后从断点继续，不全量重下）+ 自动重试 + sha512 校验 + 磁盘预检。

/** updater 缓存根目录（与 app-update.yml 的 updaterCacheDirName 一致） */
function updaterCacheDir(): string {
  return path.join(app.getPath('home'), 'Library', 'Caches', 'bob-updater');
}

/** 自研下载目录（与 electron-updater 自身缓存隔离，互不干扰） */
function updateDownloadDir(): string {
  return path.join(updaterCacheDir(), 'downloads');
}

/** 自动更新源 base URL（读取 app-update.yml 的 url 字段） */
let updateBaseUrl = '';
function resolveUpdateBaseUrl(): string {
  if (updateBaseUrl) return updateBaseUrl;
  try {
    const yml = path.join(process.resourcesPath, 'app-update.yml');
    if (fs.existsSync(yml)) {
      const m = fs.readFileSync(yml, 'utf8').match(/^url:\s*(\S+)\s*$/m);
      if (m) updateBaseUrl = m[1].replace(/\/+$/, '');
    }
  } catch { /* ignore */ }
  return updateBaseUrl;
}

/** 进行中的自研下载任务（全局单任务） */
let activeDownload: {
  version: string;
  fileName: string;
  url: string;
  size: number;
  sha512: string;
  finalPath: string;
  partialPath: string;
  cancelled: boolean;
} | null = null;

/** 最近一次 update-available 的下载元数据（供手动重试/续传） */
let lastUpdateMeta: { version: string; url: string; size: number; sha512: string } | null = null;

/** 简单版本号比较（仅支持 0.5.x 风格） */
function versionGreater(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * 智能清理中断下载残留，同时【保留】可续传的合法 .partial：
 *  - keepVersion + keepSize：仅保留该版本且 0 < size < 目标大小的 partial（下载前调用）
 *  - keepNewerThan：保留版本号高于当前运行版本的 partial（跨重启续传；检查/出错时调用）
 *  - 其余 partial、陈旧 update-info.json、electron-updater 旧缓存目录一律清理
 */
function cleanInterruptedDownloadCaches(opts?: { keepVersion?: string; keepSize?: number; keepNewerThan?: string }): void {
  let removed = 0;
  try {
    const root = updaterCacheDir();
    if (fs.existsSync(root)) {
      // 收集目录（含根目录与所有子目录，如 pending/、downloads/），再逐目录清理
      const dirs: string[] = [];
      const walk = (d: string) => {
        dirs.push(d);
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(d, e.name));
        }
      };
      walk(root);

      for (const dir of dirs) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const fp = path.join(dir, entry.name);
          if (entry.name.endsWith('.partial')) {
            let keep = false;
            const m = entry.name.match(/BobWork-([\d.]+)-macos-arm64\.zip\.partial$/);
            if (m) {
              const v = m[1];
              if (opts?.keepVersion && v === opts.keepVersion) {
                try {
                  const s = fs.statSync(fp).size;
                  keep = s > 0 && (!opts.keepSize || s < opts.keepSize);
                } catch { keep = false; }
              } else if (opts?.keepNewerThan && versionGreater(v, opts.keepNewerThan)) {
                keep = true;
              }
            }
            if (!keep) {
              fs.rmSync(fp, { force: true });
              removed++;
            }
          } else if (entry.name.endsWith('.zip')) {
            // 已安装版本的完整安装包不再需要：仅保留版本号高于当前运行版本的 zip（供续装/回退）
            const m = entry.name.match(/BobWork-([\d.]+)-macos-arm64\.zip$/);
            if (m && !versionGreater(m[1], app.getVersion())) {
              fs.rmSync(fp, { force: true });
              removed++;
            }
          } else if (entry.name === 'update-info.json') {
            // 若记录指向的文件与 .partial 均不存在，说明是陈旧/中断残留，删除该记录
            try {
              const info = JSON.parse(fs.readFileSync(fp, 'utf8'));
              const target = info.fileName ? path.join(dir, info.fileName) : '';
              if (!target || (!fs.existsSync(target) && !fs.existsSync(target + '.partial'))) {
                fs.rmSync(fp, { force: true });
                removed++;
              }
            } catch {
              fs.rmSync(fp, { force: true });
              removed++;
            }
          }
        }
      }
    }
  } catch (err) {
    log(`Interrupted download cleanup failed: ${String(err)}`);
  }
  // 已不再使用 electron-updater 下载器，其旧缓存目录直接清空（避免残留干扰）
  for (const legacy of [path.join(app.getPath('userData'), 'updater-cache'), path.join(app.getPath('userData'), '__update__')]) {
    try {
      if (fs.existsSync(legacy)) {
        fs.rmSync(legacy, { recursive: true, force: true });
        removed++;
      }
    } catch { /* ignore */ }
  }
  if (removed > 0) log(`Cleaned ${removed} stale update download artifact(s)`);
}

/** 跟随重定向发起请求（GitCode release 下载会 302 跳转到 CDN），返回最终响应 */
function requestWithRedirects(url: string, headers: Record<string, string>, redirectsLeft = 6): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        requestWithRedirects(new URL(String(res.headers.location), url).toString(), headers, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
  });
}

/** 计算文件 sha512（小写 hex，与 latest-mac.yml 一致） */
function sha512OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const rs = fs.createReadStream(filePath);
    rs.on('data', (d) => hash.update(d));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

/**
 * 断点续传下载单个文件：
 *  - 存在合法 .partial → 带 Range 从断点继续（服务端返回 206 时追加写入）
 *  - 416（Range 不满足）/ 大小越界 → 删除 partial 全量重下
 *  - 下载完成自动 rename 为最终文件；期间中断保留 .partial，下次从断点继续
 */
function downloadWithResume(
  url: string,
  partialPath: string,
  finalPath: string,
  totalSize: number,
  onProgress: (percent: number, transferred: number, total: number, bytesPerSecond: number) => void,
): Promise<void> {
  const existing = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
  let startByte = existing;
  if (existing >= totalSize) {
    fs.rmSync(partialPath, { force: true });
    startByte = 0;
  }
  const run = async (from: number): Promise<void> => {
    const headers: Record<string, string> = {
      'User-Agent': `BobWork-Updater/${app.getVersion()}`,
      'Accept-Encoding': 'identity',
    };
    if (from > 0) headers.Range = `bytes=${from}-`;
    const res = await requestWithRedirects(url, headers);
    if (res.statusCode === 416) {
      // 服务端文件已变化/不支持该范围：删除 partial 全量重下
      res.resume();
      fs.rmSync(partialPath, { force: true });
      return run(0);
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode} while downloading`);
    }
    const isResume = from > 0 && res.statusCode === 206;
    const ws = fs.createWriteStream(partialPath, { flags: isResume ? 'a' : 'w' });
    let transferred = isResume ? from : 0;
    let lastEmit = 0;
    let windowStart = Date.now();
    let windowBytes = transferred;
    let finished = false;
    await new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        if (!ws.write(chunk)) res.pause();
        const now = Date.now();
        if (now - lastEmit >= 200) {
          lastEmit = now;
          const elapsed = Math.max(1, (now - windowStart) / 1000);
          onProgress(
            Math.min(100, (transferred / totalSize) * 100),
            transferred,
            totalSize,
            Math.round((transferred - windowBytes) / elapsed),
          );
          windowBytes = transferred;
          windowStart = now;
        }
      });
      ws.on('drain', () => res.resume());
      res.on('end', () => {
        finished = true;
        ws.end(() => resolve());
      });
      res.on('close', () => {
        if (!finished) {
          ws.destroy();
          reject(new Error('Connection closed before download completed'));
        }
      });
      res.on('error', reject);
      ws.on('error', reject);
    });
  };
  return run(startByte).then(() => {
    const finalSize = fs.statSync(partialPath).size;
    if (finalSize !== totalSize) throw new Error(`Size mismatch: expected ${totalSize}, got ${finalSize}`);
    fs.renameSync(partialPath, finalPath);
  });
}

/** 将已下载 zip 复制到 install handler 读取的 pending 目录（已存在且大小一致则跳过） */
function ensurePendingCopy(finalPath: string): void {
  try {
    const pendingDir = path.join(updaterCacheDir(), 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const pendingZip = path.join(pendingDir, path.basename(finalPath));
    const srcSize = fs.statSync(finalPath).size;
    if (!fs.existsSync(pendingZip) || fs.statSync(pendingZip).size !== srcSize) {
      if (fs.existsSync(pendingZip)) fs.rmSync(pendingZip, { force: true });
      fs.copyFileSync(finalPath, pendingZip);
    }
  } catch (err) {
    log(`Failed to copy update to pending dir: ${String(err)}`);
  }
}

/**
 * 启动/恢复断点续传下载：
 *  - 最多 3 次尝试（2s/4s 指数退避），每次重试自动从 .partial 断点续传
 *  - 下载完成做 sha512 校验；校验失败删除并全量重下
 *  - 最终失败保留 .partial，下次检查/重启自动从断点继续
 */
async function startResumableDownload(meta: { version: string; url: string; size: number; sha512: string }): Promise<boolean> {
  if (activeDownload) {
    if (activeDownload.version === meta.version) return true; // 同版本已在下载中
    activeDownload.cancelled = true;
    activeDownload = null;
  }
  const dir = updateDownloadDir();
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `BobWork-${meta.version}-macos-arm64.zip`;
  const finalPath = path.join(dir, fileName);
  const partialPath = `${finalPath}.partial`;

  // 已存在且校验通过 → 视为下载完成：补发 update:downloaded 事件（否则复检同版本时
  // 前端会停在 downloading 转圈，因为没有任何后续事件能把它带出该状态）
  if (fs.existsSync(finalPath)) {
    try {
      if ((await sha512OfFile(finalPath)).toLowerCase() === meta.sha512.toLowerCase()) {
        log(`Update ${meta.version} already downloaded (checksum ok)`);
        ensurePendingCopy(finalPath);
        activeDownload = null;
        mainWindow?.webContents.send('update:downloaded', { version: meta.version });
        return true;
      }
    } catch { /* 校验失败 → 重下 */ }
    fs.rmSync(finalPath, { force: true });
  }

  // 磁盘空间预检（下载 + 解压安装至少需要 2 倍包大小 + 200MB 余量）
  try {
    const stats = fs.statfsSync(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < meta.size * 2 + 200 * 1024 * 1024) {
      log(`Insufficient disk space for update: free ${(free / 1024 / 1024 / 1024).toFixed(1)}GB`);
      mainWindow?.webContents.send('update:error', { message: 'Not enough disk space to download the update', manual: true });
      return false;
    }
  } catch { /* 预检失败不阻塞下载 */ }

  activeDownload = { version: meta.version, fileName, url: meta.url, size: meta.size, sha512: meta.sha512, finalPath, partialPath, cancelled: false };
  // 精确清理：只保留当前目标版本的合法 partial（即续传点）
  cleanInterruptedDownloadCaches({ keepVersion: meta.version, keepSize: meta.size });

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (activeDownload?.cancelled) return false;
    try {
      await downloadWithResume(meta.url, partialPath, finalPath, meta.size, (percent, transferred, total, bps) => {
        mainWindow?.webContents.send('update:download-progress', {
          percent,
          bytesPerSecond: bps,
          downloaded: transferred,
          total,
        });
      });
      const actual = (await sha512OfFile(finalPath)).toLowerCase();
      if (actual !== meta.sha512.toLowerCase()) {
        throw new Error('Checksum mismatch — will redownload from scratch');
      }
      // 复制到 install handler 读取的 pending 目录（保持原有安装流程不变）
      ensurePendingCopy(finalPath);
      log(`Update ${meta.version} downloaded and verified (${(fs.statSync(finalPath).size / 1024 / 1024).toFixed(0)}MB)`);
      activeDownload = null;
      mainWindow?.webContents.send('update:downloaded', { version: meta.version });
      return true;
    } catch (err) {
      const reason = String((err as Error)?.message || err);
      if (activeDownload?.cancelled) return false;
      // 校验/大小不符时删除损坏文件，下次从 0 全量重下；网络中断则保留 .partial 供续传
      if (reason.includes('Checksum') || reason.includes('Size mismatch')) {
        fs.rmSync(finalPath, { force: true });
        fs.rmSync(partialPath, { force: true });
      }
      log(`Update download attempt ${attempt}/${maxAttempts} failed: ${reason}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 2000)); // 2s / 4s 退避后自动续传
      }
    }
  }
  const msg = 'Update download was interrupted. It will resume automatically on the next check.';
  log(msg);
  mainWindow?.webContents.send('update:error', { message: msg, manual: true });
  activeDownload = null;
  return false;
}

/** 从 electron-updater 的 update-available 信息提取下载元数据并启动续传下载 */
async function startResumableDownloadFromInfo(info: any): Promise<boolean> {
  const file = info?.files?.[0];
  const size = typeof file?.size === 'number' ? file.size : 0;
  const sha512 = typeof file?.sha512 === 'string' ? file.sha512 : '';
  if (!size || !sha512) {
    // 元数据缺失（极少见）：回退到 electron-updater 自带下载器
    log('Update metadata missing (size/sha512) — falling back to electron-updater downloader');
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (err) {
      log(`Fallback download failed: ${String(err)}`);
      return false;
    }
  }
  const fileName = file.url || `BobWork-${info.version}-macos-arm64.zip`;
  const url = fileName.startsWith('http') ? fileName : `${resolveUpdateBaseUrl()}/${fileName}`;
  const meta = { version: info.version, url, size, sha512 };
  lastUpdateMeta = meta;
  return startResumableDownload(meta);
}

/** 自动更新配置 */
function setupAutoUpdater(): void {
  // 注册通用的 IPC handler（无论自动更新是否启用）
  ipcMain.handle('update:get-version', () => {
    return app.getVersion();
  });

  // 清理 stale pending 更新：如果 pending 更新的文件名包含当前版本号，
  // 说明是同版本重复下载，删除以避免阻塞新版本检测
  try {
    const currentVersion = app.getVersion();
    const cacheDir = path.join(app.getPath('home'), 'Library', 'Caches', 'bob-updater');
    const pendingDir = path.join(cacheDir, 'pending');
    const updateInfoPath = path.join(pendingDir, 'update-info.json');
    if (fs.existsSync(updateInfoPath)) {
      const info = JSON.parse(fs.readFileSync(updateInfoPath, 'utf8'));
      if (info.fileName && info.fileName.includes(currentVersion)) {
        log(`Clearing stale pending update (same version ${currentVersion})`);
        fs.rmSync(pendingDir, { recursive: true, force: true });
        const updateZip = path.join(cacheDir, 'update.zip');
        if (fs.existsSync(updateZip)) fs.rmSync(updateZip, { force: true });
      }
    }
  } catch (err) {
    log(`Pending update cleanup failed: ${String(err)}`);
  }

  const isUpdaterEnabled = !isDev && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));

  if (!isUpdaterEnabled) {
    log(isDev ? 'Auto-updater disabled in dev mode' : 'Auto-updater disabled: app-update.yml not found');

    // 注册占位 handler，避免前端调用时报错
    ipcMain.handle('update:check', async () => {
      return { success: false, error: 'Auto-updater is not configured' };
    });
    ipcMain.handle('update:download', async () => {
      return { success: false, error: 'Auto-updater is not configured' };
    });
    ipcMain.handle('update:install', async () => {
      return { success: false, error: 'Auto-updater is not configured' };
    });
    return;
  }

  // 下载由自研断点续传下载器接管（见 startResumableDownload）：electron-updater 仅负责版本检查，
  // 真正的下载（断点续传 + 重试 + sha512 校验）全部走自研链路，规避其 .partial 续传不可靠的问题
  autoUpdater.autoDownload = false;
  // 禁用 Squirrel 自动安装：本应用 ad-hoc 签名，Squirrel 安装必然签名校验失败；
  // 安装统一由自定义 update:install handler（解压 zip → ditto 覆盖 /Applications）完成
  autoUpdater.autoInstallOnAppQuit = false;

  /** 标记当前是否为手动检查更新（用于区分手动检查和自动检查的 UI 提示） */
  let isManualCheck = false;
  /** 缓存发现的新版本号（用于 update-downloaded 事件回传给前端，避免漏事件导致 updateVersion 为空） */
  let pendingVersion = '';

  autoUpdater.on('checking-for-update', () => {
    log('Checking for update...');
    mainWindow?.webContents.send('update:checking', { manual: isManualCheck });
  });

  autoUpdater.on('update-available', (info) => {
    log(`Update available: ${info.version}`);
    pendingVersion = info.version;
    mainWindow?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes || '',
      releaseDate: info.releaseDate || '',
    });
    // 自动开始断点续传下载（含重试与校验；中断保留 .partial，跨重启可续传）
    void startResumableDownloadFromInfo(info).catch((err) => {
      log(`Custom update download failed: ${String(err)}`);
    });
  });

  autoUpdater.on('update-not-available', () => {
    log('No update available');
    pendingVersion = '';
    // 清理过期残留，但保留版本号高于当前版本的 partial（跨重启续传用）
    cleanInterruptedDownloadCaches({ keepNewerThan: app.getVersion() });
    mainWindow?.webContents.send('update:not-available', { manual: isManualCheck });
    isManualCheck = false;
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      downloaded: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', () => {
    log('Update downloaded');
    const v = pendingVersion;
    mainWindow?.webContents.send('update:downloaded', { version: v });
    pendingVersion = '';
    isManualCheck = false;
  });

  autoUpdater.on('error', (err) => {
    log(`Update error: ${err.message}`);
    pendingVersion = '';
    // 保留可续传的 partial（版本号高于当前版本），仅清理其余残留
    cleanInterruptedDownloadCaches({ keepNewerThan: app.getVersion() });
    mainWindow?.webContents.send('update:error', { message: err.message, manual: isManualCheck });
    isManualCheck = false;
  });

  ipcMain.handle('update:check', async () => {
    try {
      isManualCheck = true;
      // 保留可跨重启续传的 partial，清理其余残留
      cleanInterruptedDownloadCaches({ keepNewerThan: app.getVersion() });
      await autoUpdater.checkForUpdates();
      return { success: true };
    } catch (err) {
      log(`Check for updates failed: ${err}`);
      isManualCheck = false;
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('update:download', async () => {
    try {
      // 手动触发/恢复下载：进行中直接返回，有元数据则从 .partial 断点续传
      if (activeDownload) return { success: true, resuming: true };
      if (!lastUpdateMeta) return { success: false, error: 'No pending update to download' };
      const ok = await startResumableDownload(lastUpdateMeta);
      return { success: ok };
    } catch (err) {
      log(`Download update failed: ${err}`);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('update:install', async () => {
    // ⚠️ 关键：本应用为 ad-hoc 签名（无开发者证书），Squirrel.Mac 在安装时会执行代码签名校验
    // 并因 "did not pass validation" 失败而静默回滚 —— autoUpdater.quitAndInstall() 在此场景下永远不生效。
    // 因此这里绕过 Squirrel，自实现安装：
    //   1) 从 updater 缓存目录读取已下载的 update.zip（electron-updater 下载的完整 zip）
    //   2) 解压出 BobWork.app
    //   3) 用 osascript 请求管理员权限复制覆盖 /Applications/BobWork.app
    //   4) 移除 quarantine 后重新启动
    try {
      const cacheDir = path.join(app.getPath('home'), 'Library', 'Caches', 'bob-updater');
      // 优先使用 pending 目录中的完整更新包（含版本号文件名），兜底使用 update.zip
      let zipPath = '';
      const pendingDir = path.join(cacheDir, 'pending');
      try {
        if (fs.existsSync(pendingDir)) {
          const pendingZips = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.zip'));
          if (pendingZips.length > 0) {
            // ⚠️ 必须安装版本号最高的安装包：fs.readdirSync 按字母序返回，
            // 直接取 [0] 会装回最旧版本（如 0.5.70 < 0.5.71 < 0.5.72），导致永远升不上去
            pendingZips.sort((a, b) => {
              const va = (a.match(/BobWork-([\d.]+)-macos-arm64\.zip$/) || [])[1] || '0';
              const vb = (b.match(/BobWork-([\d.]+)-macos-arm64\.zip$/) || [])[1] || '0';
              return versionGreater(va, vb) ? 1 : -1;
            });
            zipPath = path.join(pendingDir, pendingZips[pendingZips.length - 1]);
          }
        }
      } catch { /* ignore */ }
      if (!zipPath || !fs.existsSync(zipPath)) {
        const fallback = path.join(cacheDir, 'update.zip');
        if (fs.existsSync(fallback)) zipPath = fallback;
      }
      if (!zipPath) {
        log(`Manual install aborted: no update zip found in ${cacheDir}`);
        return { success: false, error: `No downloaded update package found in ${cacheDir}` };
      }

      const tmpDir = path.join(app.getPath('temp'), `bobwork-update-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      // 解压 update.zip（macOS 自带 unzip；-q 静默避免 ENOBUFS 缓冲区溢出，-o 覆盖，-d 指定目标）
      mainWindow?.webContents.send('update:install-progress', { stage: 'extracting', message: 'Extracting update package…', percent: 10 });
      const unzip = spawnSync('/usr/bin/unzip', ['-q', '-o', zipPath, '-d', tmpDir], {
        timeout: 120000,
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'utf8',
      });
      if (unzip.status !== 0) {
        log(`Manual install aborted: unzip failed: ${unzip.stderr?.toString() || unzip.error?.message}`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { success: false, error: 'Failed to extract update package' };
      }

      // 定位解压出的 .app（zip 内为 BobWork.app/）
      const extractedApp = path.join(tmpDir, 'BobWork.app');
      if (!fs.existsSync(extractedApp)) {
        log(`Manual install aborted: BobWork.app not found after extraction`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { success: false, error: 'Update package has no BobWork.app' };
      }

      const targetApp = path.join('/Applications', 'BobWork.app');
      mainWindow?.webContents.send('update:install-progress', { stage: 'copying', message: 'Preparing to apply update…', percent: 50 });

      // 退出当前程序需征得用户许可（英文提示）：
      // 更新包已解压就绪，此时询问用户是否允许退出并重启以完成安装；
      // 用户选择 Later 则中止安装（清理临时目录），当前应用保持运行。
      const dialogOpts: Electron.MessageBoxOptions = {
        type: 'question',
        title: 'Restart to Complete Update',
        message: 'Restart BobWork to finish the update?',
        detail:
          'The update is ready to install.\n\n' +
          'BobWork will close and restart automatically to complete the installation.\n' +
          'Your projects and data will not be affected.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const { response } = mainWindow
        ? await dialog.showMessageBox(mainWindow, dialogOpts)
        : await dialog.showMessageBox(dialogOpts);
      if (response !== 0) {
        log(`Manual install cancelled by user — update staged (zip=${zipPath})`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { success: false, cancelled: true, error: 'Update cancelled' };
      }

      // 安装脚本：等主进程退出后清理旧 app → 复制新 app → 移除 quarantine → 重新启动
      // /Applications 对 admin 组可写，无需管理员授权；detached 后台运行避免随主进程退出被终止
      const script = [
        `sleep 3`,
        `rm -rf "${targetApp}"`,
        `ditto "${extractedApp}" "${targetApp}"`,
        `xattr -dr com.apple.quarantine "${targetApp}" 2>/dev/null || true`,
        `open "${targetApp}"`,
        `rm -rf "${tmpDir}"`,
      ].join('\n');

      const scriptFile = path.join(tmpDir, 'install-update.sh');
      fs.writeFileSync(scriptFile, script, { mode: 0o755 });

      // detached + unref：主进程退出后脚本继续执行
      const installer = spawn('/bin/bash', [scriptFile], {
        detached: true,
        stdio: 'ignore',
      });
      installer.unref();

      mainWindow?.webContents.send('update:install-progress', { stage: 'launching', message: 'Launching new version…', percent: 90 });
      log(`Manual install started (zip=${zipPath}, script=${scriptFile})`);

      // 先终止 Next.js 子进程，再退出当前应用：
      // app.exit() 不触发 before-quit，若不显式杀掉子进程，它将成为孤儿进程继续占用端口，
      // 导致替换后的新版本启动时服务无法绑定端口（应用打不开）。
      killNextServer();

      // 延迟退出当前应用，让前端先收到返回值
      setTimeout(() => {
        app.exit(0);
      }, 500);

      return { success: true, installing: true };
    } catch (err) {
      log(`Manual install failed: ${String(err)}`);
      return { success: false, error: String(err) };
    }
  });

  // 清除更新缓存（ShipIt + updater cache）
  ipcMain.handle('update:clear-cache', async () => {
    const dirsToClean = [
      path.join(app.getPath('userData'), 'updater-cache'),
      path.join(app.getPath('userData'), '__update__'),
      path.join(app.getPath('home'), 'Library', 'Caches', 'bob-updater'),
      path.join(app.getPath('home'), 'Library', 'Caches', 'com.bobwork.app.ShipIt'),
      path.join(app.getPath('home'), 'Library', 'Caches', 'com.bobwork.app.ShipItTemp'),
    ];
    let deletedCount = 0;
    let freedBytes = 0;

    const getDirSize = (dir: string): number => {
      try {
        let size = 0;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { size += getDirSize(fp); }
          else { try { size += fs.statSync(fp).size; } catch {} }
        }
        return size;
      } catch { return 0; }
    };

    for (const dir of dirsToClean) {
      try {
        const size = getDirSize(dir);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          deletedCount++;
          freedBytes += size;
          log(`Cleared update cache: ${dir} (${(size / 1024 / 1024).toFixed(1)}MB)`);
        }
      } catch (e) {
        log(`Failed to clear ${dir}: ${String(e)}`);
      }
    }

    return {
      success: true,
      deletedCount,
      freedBytes,
      freedMB: +(freedBytes / 1024 / 1024).toFixed(2),
    };
  });

  // 系统通知
  ipcMain.handle('notify', (_event, title: string, body: string) => {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body });
      n.show();
      return true;
    }
    return false;
  });

  // 启动后延迟 5 秒自动检查更新
  setTimeout(() => {
    if (!mainWindow?.isDestroyed()) {
      log('Auto-checking for updates...');
      autoUpdater.checkForUpdates().catch(err => log(`Auto-update check failed: ${err.message}`));
    }
  }, 5000);
}

app.whenReady().then(async () => {
  log(`App ready. isDev=${isDev}, PORT=${PORT}`);

  // 确保工作区目录存在
  let workspaceDir = path.join(app.getPath('home'), 'BobWork', '.sandbox');
  if (process.env.BOBWORK_HOME) {
    workspaceDir = path.join(process.env.BOBWORK_HOME, '.sandbox');
  }
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  // 设置读写 IPC
  ipcMain.handle('settings:load', async () => {
    return await readSettingsFromFile();
  });
  ipcMain.handle('settings:save', async (_event, settings) => {
    try {
      await writeSettingsToFile(settings);
      return { success: true };
    } catch (err) {
      // 写入被拒（如防覆盖保护）或 I/O 失败：返回失败信息，前端不再静默
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('settings:exists', async () => {
    return await settingsFileExists();
  });

  // ===== 头像管理 IPC（内置南瓜表情包 + 用户自定义） =====

  ipcMain.handle('avatar:list', async () => {
    return listAllAvatars();
  });

  ipcMain.handle('avatar:add', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择头像图片',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const customDir = customAvatarDir();
      fs.mkdirSync(customDir, { recursive: true });

      for (const srcPath of result.filePaths) {
        const ext = path.extname(srcPath);
        const baseName = path.basename(srcPath, ext);
        // 避免文件名冲突：若已存在则追加序号
        let destName = `${baseName}${ext}`;
        let destPath = path.join(customDir, destName);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          destName = `${baseName}_${counter}${ext}`;
          destPath = path.join(customDir, destName);
          counter++;
        }
        fs.copyFileSync(srcPath, destPath);
        log(`Avatar added: ${destName}`);
      }

      return { success: true, avatars: listAllAvatars() };
    } catch (err) {
      log(`avatar:add failed: ${String(err)}`);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('avatar:delete', async (_event, id: string) => {
    try {
      // 仅允许删除自定义头像（builtin/ 前缀的拒绝删除）
      if (!id.startsWith('custom/')) {
        return { success: false, error: '内置头像不可删除' };
      }
      const fileName = id.slice('custom/'.length);
      const filePath = path.join(customAvatarDir(), fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log(`Avatar deleted: ${fileName}`);
      }
      return { success: true, avatars: listAllAvatars() };
    } catch (err) {
      log(`avatar:delete failed: ${String(err)}`);
      return { success: false, error: String(err) };
    }
  });

  // 开发者工具
  ipcMain.handle('devtools:open', () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  // 打印：弹系统打印面板（渲染层已通过 @media print 隐藏 UI，只输出文档正文）
  ipcMain.handle('print:open', async () => {
    try {
      if (!mainWindow) return { success: false, error: 'no window' };
      // macOS 下系统打印面板依赖窗口处于激活前台状态：先恢复/显示/聚焦，避免静默不弹
      if (mainWindow.isDestroyed()) return { success: false, error: 'window destroyed' };
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      await new Promise((r) => setTimeout(r, 150));
      // Electron 29+ 的 resolve 值为 { success, failureReason }——必须检查，
      // 否则面板静默失败（如系统打印服务异常）会被吞掉表现为"点了没反应"
      const res = (await mainWindow.webContents.print({ silent: false, printBackground: true })) as
        | { success: boolean; failureReason?: string }
        | undefined;
      if (res && res.success === false) {
        // 用户取消打印面板：正常结束，不算失败（避免渲染层误报并触发兜底打印）
        if (res.failureReason === 'cancelled') return { success: true };
        return { success: false, error: res.failureReason || 'Print failed (system)' };
      }
      return { success: true };
    } catch (err) {
      log(`print:open failed: ${String(err)}`);
      return { success: false, error: String(err) };
    }
  });

  // PDF 导出：webContents.printToPDF（受 @media print 控制，只输出文档正文）→ base64 返回渲染层下载
  ipcMain.handle('pdf:export', async () => {
    try {
      if (!mainWindow) return { success: false, error: 'no window' };
      if (mainWindow.isDestroyed()) return { success: false, error: 'window destroyed' };
      const buffer = await mainWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.79, bottom: 0.79, left: 0.79, right: 0.79 }, // 2cm
      });
      return { success: true, data: buffer.toString('base64') };
    } catch (err) {
      log(`pdf:export failed: ${String(err)}`);
      return { success: false, error: String(err) };
    }
  });

  // 用系统默认程序打开文件（PDF/Word 等）
  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    try {
      const result = await shell.openPath(filePath);
      if (result) return { success: false, error: result };
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 在系统文件管理器中显示并选中指定文件（macOS：Finder「在访达中显示」；Windows：资源管理器定位选中）
  ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 将 HTML 内容写入系统临时目录后预览：Hippo Browser（侧边栏）可用时应用内展示，否则退回系统默认浏览器
  ipcMain.handle('shell:openHtml', async (_event, content: string, filename?: string) => {
    try {
      const name = (filename && /\.html?$/i.test(filename) ? filename : 'preview.html').replace(/[\\/:*?"<>|]/g, '_');
      const filePath = path.join(os.tmpdir(), `bobwork-${Date.now()}-${name}`);
      fs.writeFileSync(filePath, content, 'utf-8');
      if (isHippoReady() && openHtmlInHippo(filePath)) {
        return { success: true, path: filePath, hippo: true };
      }
      const result = await shell.openPath(filePath);
      if (result) return { success: false, error: result };
      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 选择本地文件夹（用于电脑目录浏览器）
  ipcMain.handle('dialog:openDirectory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择要浏览的文件夹',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 批量保存图片（小红书卡片多页导出）：files = 弹目录选择逐张写盘；zip = 弹保存对话框打包成 zip。
  // 绕过浏览器"非用户手势多次下载被拦截"的限制（渲染层连续 <a download> 只放行第一张）。
  ipcMain.handle(
    'shell:saveImages',
    async (
      _event,
      payload: {
        format?: 'files' | 'zip';
        name?: string;
        images: Array<{ name: string; dataUrl: string }>;
      },
    ) => {
      try {
        const images = Array.isArray(payload) ? (payload as unknown as Array<{ name: string; dataUrl: string }>) : payload?.images;
        if (!Array.isArray(images) || images.length === 0) {
          return { success: false, error: 'no images' };
        }
        // dataURL → 临时文件（.png/.jpg），返回文件路径列表
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobwork-save-'));
        const files: string[] = [];
        for (const img of images) {
          const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(img.dataUrl || '');
          if (!m) continue;
          const ext = m[1].includes('jpeg') || m[1].includes('jpg') ? 'jpg' : 'png';
          const safeName = (img.name || `bobwork-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
          const filePath = path.join(tmpDir, `${safeName}.${ext}`);
          fs.writeFileSync(filePath, Buffer.from(m[2], 'base64'));
          files.push(filePath);
        }
        if (files.length === 0) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return { success: false, error: 'no valid image data' };
        }

        // zip 模式：保存对话框 → 系统 zip 命令打包 → 定位 zip
        if (payload?.format === 'zip') {
          const save = await dialog.showSaveDialog({
            title: '保存 ZIP',
            defaultPath: path.join(app.getPath('downloads'), `${payload.name || 'bobwork-xhs'}.zip`),
            filters: [{ name: 'ZIP', extensions: ['zip'] }],
          });
          if (save.canceled || !save.filePath) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return { success: false, canceled: true };
          }
          const zipPath = save.filePath.replace(/\.zip$/i, '') + '.zip';
          const ok = await new Promise<boolean>((resolve) => {
            spawn('zip', ['-j', zipPath, ...files], { stdio: 'ignore' }).on('close', (code) => resolve(code === 0));
          });
          fs.rmSync(tmpDir, { recursive: true, force: true });
          if (!ok) return { success: false, error: 'zip 打包失败' };
          shell.showItemInFolder(zipPath);
          return { success: true, path: zipPath, count: files.length, format: 'zip' };
        }

        // files 模式：弹目录选择 → 逐张写盘 → Finder 定位首个文件
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: '选择图片保存位置',
          defaultPath: app.getPath('downloads'),
        });
        if (result.canceled || result.filePaths.length === 0) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return { success: false, canceled: true };
        }
        const dir = result.filePaths[0];
        const saved: string[] = [];
        for (const filePath of files) {
          const target = path.join(dir, path.basename(filePath));
          fs.copyFileSync(filePath, target);
          saved.push(target);
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
        shell.showItemInFolder(saved[0]); // 在 Finder 中定位首个文件
        return { success: true, dir, count: saved.length, format: 'files' };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );


  setupAutoUpdater();

  // GitCode CDN 的 releases/download 路由对带任何 query 的请求返回 404，
  // 而 electron-updater 会硬编码追加 ?noCache= 参数 → 自动更新 404。
  // 关键：electron-updater 使用独立 partition session "electron-updater"（见其
  // electronHttpExecutor.getNetSession → session.fromPartition("electron-updater", {cache:false})），
  // 并非 defaultSession —— 必须在该 session 上注册 webRequest 拦截才生效。
  try {
    const stripGitCodeQuery = (
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void,
    ) => {
      try {
        const u = new URL(details.url);
        if (u.hostname === 'gitcode.com' && u.pathname.includes('/releases/download/')) {
          u.search = '';
          if (u.toString() !== details.url) {
            callback({ redirectURL: u.toString() });
            return;
          }
        }
      } catch {}
      callback({});
    };

    // electron-updater 实际使用的 session（懒创建，与 updater 共享同一实例）
    const updaterSession = session.fromPartition('electron-updater', { cache: false });
    updaterSession.webRequest.onBeforeRequest({ urls: ['*://gitcode.com/*'] }, stripGitCodeQuery);
    log('GitCode noCache query 拦截已注册（electron-updater session）');
  } catch (err) {
    log(`GitCode query 拦截注册失败: ${String(err)}`);
  }

  log('Creating splash window...');
  const splashWindow = await createSplashWindow();
  log('Creating main window...');
  mainWindow = createWindow();
  log('Main window created (hidden until server ready).');
  // 渲染进程错误诊断：转发 console 与崩溃事件到 ~/.bobwork-renderer.log（排查前端交互失效）
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    try {
      fs.appendFileSync(path.join(os.homedir(), '.bobwork-renderer.log'), `[${level}] ${message}\n`);
    } catch { /* 忽略 */ }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    try {
      fs.appendFileSync(path.join(os.homedir(), '.bobwork-renderer.log'), `[render-gone] ${JSON.stringify(details)}\n`);
    } catch { /* 忽略 */ }
  });
  setupGlobalScreenOcr();
  // 启动即预装/升级截图助手：版本变化时自动重装，并在重装后自动请求一次屏幕录制授权恢复
  // （更新后首次启动 BobWork 即完成，无需等用户按快捷键才发现要授权）
  try { resolveCaptureHelperApp(); } catch { /* 安装失败留待快捷键触发时重试 */ }
  // Hippo Browser 独立窗口（Cmd+Shift+B 唤起）
  setupHippoBrowser();
  // 浏览器收起为胶囊时，转发到主窗口渲染层（居中呼吸灯胶囊按钮）
  setMainWindowCapsuleListener((capsule) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hippo-browser:capsule', capsule);
      }
    } catch { /* 主窗口未就绪或已销毁时忽略 */ }
  });
  try {
    globalShortcut.register('CommandOrControl+Shift+B', () => toggleWindow());
  } catch { /* 快捷键注册失败不阻断启动 */ }

  // 主页面加载兜底：即使 server 已就绪，loadURL 后页面可能因
  // SSR/React hydration 挂起、静态资源死锁、扩展注入异常等 never paint，
  // 导致 ready-to-show 永远不触发 → splash 永久转圈。
  // 此处设一个硬上限：loadURL 后 PAGE_PAINT_TIMEOUT_MS 内若还没 ready-to-show，
  // 强制显示主窗口 + 关闭 splash，最差让用户看到白屏/半渲染而不是永远欢迎页。
  const PAGE_PAINT_TIMEOUT_MS = 8000;
  const showMainAndCloseSplash = (reason: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) {
      mainWindow.show();
      log(`Main window shown (${reason}).`);
    }
    closeSplashWindow(splashWindow);
  };
  let pagePaintTimer: NodeJS.Timeout | null = null;

  if (!isDev) {
    log('Starting Next.js server...');
    nextServerProc = startNextServer();
  }

  try {
    log('Waiting for server...');
    // 生产：startNextServer 内部已带 12s×2 轮 启动自愈与 startupReady 快失败
    //   （proc ENOENT / 首次启动崩溃 立即 reject，不傻等 30s）
    //   dev：next dev 已外部启动，此处只做端口轮询
    const waitPromise = isDev
      ? waitForServer(SERVER_URL, 30000)
      : Promise.race([
          waitForServer(SERVER_URL, 30000),
          (nextServerProc as ChildProcess & { startupReady?: Promise<void> })
            ?.startupReady ?? Promise.resolve(),
        ]);
    await waitPromise;

    log('Server is ready. Loading app URL...');
    mainWindow.loadURL(SERVER_URL);
    // 运行期服务看门狗：闲置期间服务若崩溃/被回收，自动重启自愈（仅生产）
    startServerWatchdog();

    // ready-to-show：首次 paint 成功才触发（正常路径）
    mainWindow.once('ready-to-show', () => {
      if (pagePaintTimer) {
        clearTimeout(pagePaintTimer);
        pagePaintTimer = null;
      }
      showMainAndCloseSplash('ready-to-show');
    });
    // 页面 paint 超时兜底（新 · 解决"卡欢迎页"最常见场景）
    pagePaintTimer = setTimeout(() => {
      pagePaintTimer = null;
      showMainAndCloseSplash('page-paint-timeout');
    }, PAGE_PAINT_TIMEOUT_MS);
    log(`App URL loaded. (page-paint timeout=${PAGE_PAINT_TIMEOUT_MS}ms)`);
  } catch (err) {
    log(`Failed to start Next.js server: ${err}`);
    if (pagePaintTimer) {
      clearTimeout(pagePaintTimer);
      pagePaintTimer = null;
    }
    closeSplashWindow(splashWindow);
    // 即使 server 启动失败，也显示错误页面
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<html><body style="background:#1a1a1a;color:#ff6b6b;font-family:sans-serif;padding:40px;">
      <h2>启动失败</h2>
      <p>Next.js 服务启动超时。请检查日志：<br><code>~/Library/Logs/BobWork/bob-work.log</code></p>
      <p style="color:#888;margin-top:20px;">错误: ${String(err)}</p>
      </body></html>`
    )}`);
    mainWindow.show();
  }

  app.on('activate', () => {
    // macOS: 点击 dock 图标时重新显示或创建窗口
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    } else {
      mainWindow = createWindow();
      if (!isHippoReady()) setupHippoBrowser();
      mainWindow.loadURL(SERVER_URL);
      mainWindow.once('ready-to-show', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
      });
    }
  });
});

app.on('window-all-closed', () => {
  // macOS：关闭窗口后保持应用运行（dock 栏仍可见），不杀服务进程
  // 用户点击 dock 图标时通过 activate 事件重新创建窗口
  if (process.platform !== 'darwin') {
    killNextServer();
    app.quit();
  }
});

// 退出前清理 WANTED 临时项目（/chat 残留）再杀服务进程：
// 发送 DELETE 请求由服务端删除临时项目，收到响应/出错/超时后终止 Next.js 子进程。
// 用 quitCleanupStarted 防止 before-quit 重复触发时重复清理。
let quitCleanupStarted = false;
app.on('before-quit', () => {
  // 通知看门狗停止探测/重启（退出流程正在终止服务）
  appQuitting = true;
  // 全局快捷键随应用退出注销（避免残留占用系统级按键）
  try {
    globalShortcut.unregisterAll();
  } catch { /* ignore */ }
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  const cleanupTempProjectOnExit = () => {
    const req = http.request(`${SERVER_URL}/api/wanted/node-chat`, { method: 'DELETE' }, (res) => {
      res.resume();
      killNextServer();
    });
    req.on('error', () => killNextServer());
    req.setTimeout(300, () => {
      req.destroy();
      killNextServer();
    });
    req.end();
  };
  try {
    cleanupTempProjectOnExit();
  } catch {
    killNextServer();
  }
});
