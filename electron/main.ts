/**
 * Electron 主进程
 *
 * 启动 Next.js standalone 服务为子进程，创建 BrowserWindow 加载本地 URL。
 * 生产模式下从打包资源中启动 Next.js 服务；开发模式下连接 pnpm dev。
 */

import { app, BrowserWindow, shell, ipcMain, Notification, dialog, session, nativeTheme, globalShortcut, systemPreferences, clipboard, nativeImage, screen, desktopCapturer } from 'electron';
import { spawn, spawnSync, execFile, execFileSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { readSettingsFromFile, writeSettingsToFile, settingsFileExists } from '../src/lib/settings-server';
import { captureRegionToFile, cleanupShotFile, ocrRecognize, ensureScreenRecordingPermission as checkScreenRecordingPermission, requestScreenRecordingPermission, buildScreenPermissionError } from '../src/lib/screen-ocr/capture';
import AdmZip from 'adm-zip';
import { IS_WIN, IS_DARWIN, POSIX_SYSTEM_DIRS, windowsBinDirs, splitPathList, joinPathList, exeName, listListeningPidsSync, listStaleServerPidsSync, terminatePid, isPidAlive, PLATFORM } from '../src/lib/platform';
import { updateArtifactName, fileNameFromUpdateUrl, parseUpdateArtifact, pickLatestArtifact } from '../src/lib/update/artifact';
import { setupHippoBrowser, openHtmlInHippo, openUrlInHippo, isHippoReady, toggleWindow, setMainWindowCapsuleListener, setHippoChatCanvasNotifier, setMainWindowProvider } from './hippo-browser';
import { setupButlerOrb, bindButlerOrbMainWindow, prewarmButlerOrb, disposeButlerOrb } from './butler-orb';
import type { ScreenOcrGeometry } from './preload';

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

/**
 * 本次启动的一次性停服令牌（随进程生成，不落盘）。
 *
 * 为什么需要：Windows 上**没有 SIGTERM 语义**，`process.kill()` 被 Node 映射成
 * `TerminateProcess` —— 子进程当场消失，SQLite WAL 来不及收尾、正在写的 docx 半截落盘。
 * 因此停服改走「HTTP 请求服务端自己关停」这条通道，令牌经子进程 env 注入，
 * 服务端在校验通过后 `server.close()` 等在飞请求结束再退出（见 src/server.ts）。
 *
 * 强制要求：服务端读到该 env 后**立刻从 process.env 删除**，避免被它 spawn 的
 * 插件/工具子进程继承（否则一个被诱导执行命令的插件就能停掉整个服务）。
 */
const SHUTDOWN_TOKEN = crypto.randomUUID();
const SHUTDOWN_PATH = '/__bobwork/shutdown';


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
    openMainWindow();
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
  // 目录表按平台取（Windows 用 System32/ProgramFiles\nodejs 等；POSIX 保持历史顺序）
  const pathDirs = new Set<string>(IS_WIN ? windowsBinDirs() : POSIX_SYSTEM_DIRS);

  // 用户当前 PATH（可能包含 shell launcher 设置的路径）
  const currentPath = process.env.PATH || '';
  // Windows 上必须按 ';' 切：按 ':' 切会把 `C:\Windows` 拆成 `C` + `\Windows`
  for (const dir of splitPathList(currentPath)) {
    pathDirs.add(dir);
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

  return joinPathList(pathDirs);
}

/**
 * 解析「Electron as node」子进程该用哪个可执行文件。
 *
 * macOS 打包版**不能**用 process.execPath：它是 App 包内的裸 Mach-O（Contents/MacOS/BobWork），
 * 从 GUI 主进程 spawn 它时 macOS 会把它登记成**新的前台应用**，而裸可执行文件没有应用图标，
 * Dock 里于是多出一颗通用可执行图标（黑底绿字 exec，悬停名 BobWork），每次启动必现。
 * 改用包内 Frameworks 下的 helper（Info.plist 带 LSUIElement=true，与 Chromium 自家
 * GPU/Renderer/Plugin helper 同款）：天生不进 Dock；它仍是同一份 Electron 二进制，
 * Node 版本与 ABI 与随包原生模块完全一致（实测 node 24.18.0 arm64），且 process.resourcesPath
 * 依旧解析到主 App 的 Resources（src/lib/settings-server.ts 依赖它定位随包资源）。
 *
 * 找不到 helper（dev / 非常规布局 / 打包改名）时回退 process.execPath：服务照常启动，
 * 代价只是那颗 Dock 图标可能回来，绝不因此起不来。
 */
function resolveNodeRuntimeExecPath(): string {
  // Windows / Linux 没有这个问题（进程不会进 Dock / 任务栏）
  if (IS_WIN || process.platform !== 'darwin') return process.execPath;
  const frameworksDir = path.join(path.dirname(path.dirname(process.execPath)), 'Frameworks');
  const candidates: string[] = [];
  try {
    for (const entry of fs.readdirSync(frameworksDir)) {
      // 只取「基础」helper：GPU/Renderer/Plugin 是带 --type 参数的进程专用壳
      if (!entry.endsWith('.app') || !entry.includes('Helper') || /GPU|Renderer|Plugin/.test(entry)) continue;
      const macosDir = path.join(frameworksDir, entry, 'Contents', 'MacOS');
      for (const exe of fs.readdirSync(macosDir)) {
        if (!exe.startsWith('.')) candidates.push(path.join(macosDir, exe));
      }
    }
  } catch { /* 目录缺失/不可读：直接走兜底 */ }
  candidates.push(process.execPath);
  return candidates.find((c) => fs.existsSync(c)) ?? process.execPath;
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
      // 防止多次启动/闪退导致的孤儿进程堆积（它们不会被下方"只清监听端口"的探测抓到）
      killStaleNextServers();
      // 每轮启动前再清一次端口：第一轮优雅关闭可能没生效，第二轮前补一次
      try {
        // 探测口径按平台分派（darwin: lsof -tiTCP:PORT -sTCP:LISTEN；win32: netstat -ano 解析 LISTENING）。
        // 旧实现硬编码 /usr/sbin/lsof：Windows 上 spawnSync 直接 ENOENT，stdout 为空、
        // stalePids 恒为空 ⇒ 一个残留都清不掉，日志里只有一句 spawn error。
        const { pids, otherStates } = listListeningPidsSync(PORT);
        const stalePids = pids.filter((p) => p !== process.pid);
        for (const pid of stalePids) {
          // darwin 保持历史行为（只 SIGKILL 该 pid）；Windows 必须 /T 连子进程一起收，
          // 否则父进程死了、子进程还占着端口，下一轮照样 EADDRINUSE
          if (terminatePid(pid, { force: true, tree: IS_WIN })) {
            log(`Spawn attempt ${attempts}: kill stale port ${PORT} pid=${pid}`);
          } else {
            log(`Spawn attempt ${attempts}: 端口 ${PORT} 占用者 pid=${pid} 终止失败（权限不足？）`);
          }
        }
        // 端口对得上、但一个 LISTENING 都没有：说明「谁在监听」的判断可能失灵（本地化/新格式）。
        // 留证据而不是静默跳过 —— 否则又是一次「什么都不报、就是起不来」。
        if (stalePids.length === 0 && otherStates.length > 0) {
          log(`Spawn attempt ${attempts}: 端口 ${PORT} 未见 LISTENING（见到状态：${otherStates.join(',')}）`);
        }
      } catch (e) {
        log(`Spawn attempt ${attempts}: 端口 ${PORT} 探测异常 ${(e as Error).message}`);
      }

      const serverPath = path.join(process.resourcesPath, 'next-standalone', 'server.js');
      const childPath = buildChildPath();
      log(`Child PATH: ${childPath}`);

      const sandboxPath = path.join(app.getPath('home'), 'BobWork', '.sandbox');
      // ⚠️ 用 **Electron 自带的 Node 运行时**（ELECTRON_RUN_AS_NODE=1），**不要** spawn 系统 PATH
      // 里的 'node'：用户机器上可能根本没装 node，或装的是 x64 / 版本不符的 node —— 加载包内只有
      // arm64 一份的原生模块（better-sqlite3 / sharp）时服务直接起不来
      // （用户现场实测 `Next.js server failed to start … signal=SIGSEGV`）。
      // Electron 的运行时与随包发布的原生模块架构/ABI 必然一致。
      // 运行时选哪个二进制见 resolveNodeRuntimeExecPath()：macOS 打包版走包内 helper，
      // 避免 Dock 里多出一颗无图标的 exec 图标。
      // 限制 V8 old space 上限为 1GB，避免长时间运行后堆膨胀到 1.49GB+ 触发 macOS jetsam 杀进程
      // （历史崩溃：node 24h 写 137GB + Footprint 1.49GB → jetsam → 应用闪退）
      const runtimeExec = resolveNodeRuntimeExecPath();
      log(`Next.js server runtime: ${runtimeExec} (Electron as node)`);
      const proc = spawn(runtimeExec, ['--max-old-space-size=1024', serverPath], {
        cwd: path.join(process.resourcesPath, 'next-standalone'),
        env: {
          ...process.env,
          PATH: childPath,
          ELECTRON_RUN_AS_NODE: '1',
          PORT: String(PORT),
          HOSTNAME: 'localhost',
          NODE_ENV: 'production',
          COZE_WORKSPACE_PATH: sandboxPath,
          // Windows 上 @ffmpeg-installer 落的是 ffmpeg.exe，硬编码无后缀会静默拿不到 ffmpeg
          FFMPEG_PATH: path.join(process.resourcesPath, 'bin', exeName('ffmpeg')),
          // 随包资源根目录：Next 服务子进程没有 process.resourcesPath，
          // 靠它解析 resources/python（Windows 随包嵌入式解释器，见 binaries.ts pythonBin）。
          BOBWORK_RESOURCES: process.resourcesPath,
          ...(IS_WIN
            ? {
                // 显式指向随包解释器，避免服务端再去翻 LOCALAPPDATA / Program Files。
                // 刻意不设 PYTHONHOME：embeddable 版靠 python311._pth 定位标准库，
                // 设了 PYTHONHOME 反而会让 site-packages 解析错位。
                BOBWORK_PYTHON: path.join(process.resourcesPath, 'python', 'python.exe'),
              }
            : {}),
          // 优雅关停令牌（服务端读后立即从 process.env 删除，不传给插件子进程）
          BOB_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN,
          // Windows 控制台默认代码页 936（GBK）：Python 子进程按 locale 编码输出，
          // 中文路径/报错会变乱码或 UnicodeEncodeError。这两个变量只对 Python 生效，
          // 不改变子进程的代码页设置（不依赖 chcp，避免污染全局控制台）。
          ...(IS_WIN ? { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } : {}),
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
          // 401 也算「服务已起」：远程访问 strict 模式下，本探针不带 Token，会被自定义
          // server 的鉴权网关挡下 —— 能返回 401 恰恰说明 HTTP 服务已经可用。
          if (
            res.statusCode === 200 ||
            res.statusCode === 307 ||
            res.statusCode === 302 ||
            res.statusCode === 401
          ) {
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
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  }) as ChildProcess & { startupReady: Promise<void> };
}

/**
 * 请求服务端自己优雅关停（POST /__bobwork/shutdown + 一次性令牌）。
 * 返回 true = 服务端已受理（HTTP 200）。失败不抛错：调用方随后走强制终止兜底。
 */
function requestGracefulShutdown(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const req = http.request(
        `${SERVER_URL}${SHUTDOWN_PATH}`,
        {
          method: 'POST',
          headers: { 'x-bob-shutdown-token': SHUTDOWN_TOKEN, 'content-length': '0' },
          timeout: 1000,
        },
        (res) => {
          res.resume();
          done(res.statusCode === 200);
        },
      );
      req.on('error', () => done(false));
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.end();
    } catch {
      done(false);
    }
  });
}

/**
 * 已发起终止但尚未确认退出的 pid → 强杀截止时间戳。
 *
 * 为什么记截止时间而不是单纯记 pid：优雅关停需要一段窗口（等在飞请求收尾），
 * 而 `will-quit` 是同步的、几乎紧跟 `before-quit` 发生 —— 若它无条件强杀，
 * 优雅窗口名存实亡（等于又变回 TerminateProcess）。
 */
const pendingKills = new Map<number, number>();
/** 优雅关停窗口：服务端自己关停 + 等在飞请求的时限。超过则强制终止。 */
const GRACEFUL_KILL_DEADLINE_MS = 2500;

/**
 * 兜底强杀：把「已过优雅窗口」（或显式 force）的 pid 强制终止（含进程树）。
 *
 * 为什么必须有：`app.exit(0)` **不触发** will-quit，而定时器在进程退出后也不会再跑 ——
 * 只靠 setTimeout 升级强杀，一旦退出路径比定时器快，子进程就变成占着端口的孤儿。
 */
function flushPendingKills(opts: { force?: boolean } = {}): void {
  const now = Date.now();
  for (const [pid, deadline] of [...pendingKills]) {
    if (!opts.force && now < deadline) continue; // 还在优雅窗口内，交给定时器
    pendingKills.delete(pid);
    if (!isPidAlive(pid)) continue;
    if (terminatePid(pid, { force: true, tree: true })) {
      log(`Flush: force-killed lingering pid=${pid}`);
    } else {
      log(`Flush: 无法终止残留 pid=${pid}（权限不足？）`);
    }
  }
}

/** 轮询等这些 pid 退出（最多 timeoutMs）；用于退出前给优雅关停留窗口 */
function waitPidsGone(pids: Iterable<number>, timeoutMs: number): Promise<void> {
  const list = [...pids];
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const alive = list.filter((p) => isPidAlive(p));
      if (alive.length === 0 || Date.now() >= deadline) return resolve();
      setTimeout(tick, 60);
    };
    tick();
  });
}

/**
 * 终止 Next.js 子进程。
 * ⚠️ 必须显式调用：安装更新用 app.exit(0) 退出时不会触发 before-quit/will-quit，
 * 若不杀掉子进程，它会成为孤儿进程继续占用端口，导致更新重启后新版本服务无法启动（应用打不开）。
 *
 * 终止顺序（阶段 C 修订）：
 *   1. **HTTP 优雅关停**：服务端自己 server.close() + 等在飞请求结束
 *      —— 保护 SQLite WAL 与正在写的 docx；
 *   2. darwin/linux 仍先发 SIGTERM（历史行为，双保险，不改变 mac 观感）；
 *      Windows 不发 —— 那里 `process.kill()` 就是 TerminateProcess，会直接废掉第 1 步；
 *   3. GRACEFUL_KILL_DEADLINE_MS 后仍存活 → 强制终止（Windows `/T /F` 整树，POSIX SIGKILL）；
 *   4. 最后清一轮全部残留实例，防止历史孤儿堆积。
 */
function killNextServer(): void {
  const proc = nextServerProc;
  nextServerProc = null;
  const pid = proc?.pid;
  if (proc && !proc.killed && pid) {
    pendingKills.set(pid, Date.now() + GRACEFUL_KILL_DEADLINE_MS);
    void requestGracefulShutdown().then((ok) => {
      if (!ok) log('Graceful shutdown request rejected/unreachable — falling back to force kill');
    });
    // darwin/linux：保持历史的 SIGTERM（服务端通常立刻退出，随后定时器发现已死便什么都不做）
    if (!IS_WIN) {
      try { proc.kill(); } catch { /* ignore */ }
    }
    const t = setTimeout(() => {
      if (!pendingKills.has(pid)) return; // 已被 flush 处理
      pendingKills.delete(pid);
      if (!isPidAlive(pid)) return;
      if (terminatePid(pid, { force: true, tree: true })) {
        log('Next.js server force-killed (graceful shutdown timed out)');
      }
    }, GRACEFUL_KILL_DEADLINE_MS + 100);
    if (typeof (t as NodeJS.Timeout & { unref?: () => void }).unref === 'function') {
      (t as NodeJS.Timeout & { unref: () => void }).unref();
    }
  }
  killStaleNextServers();
}

/**
 * 清理本应用残留的 next-server 进程（含不监听端口、卡死占 CPU 的僵尸实例）。
 *
 * 判据按平台分派 —— 这是旧实现的**结构性错误**：它依赖
 *   `ps axo pid=,command=` 输出里进程标题为 `next-server`
 * （Next standalone 启动后会把 process.title 改成 `next-server (vX.Y)`，命令行里不含路径）。
 * **Windows 没有进程标题这个概念**，命令行永远是 `BobWork.exe … server.js`，
 * 正则 `/^\s*(\d+)\s+next-server/` 一条都匹配不到 ⇒ 整个清扫静默失效。
 *
 *   - darwin/linux：ps 进程标题初筛 → lsof 按 cwd 二次确认（双保险不误杀别的 next-server）；
 *   - win32：Get-CimInstance 按 **CommandLine 含 next-standalone** 匹配（命令行是完整路径，
 *     比 mac 的标题判据更精确，不需要二次确认）。
 *
 * 仅影响本应用安装版；dev 模式（next dev，cwd 不在 next-standalone）不受影响。
 * 启动时调用防止多实例堆积；退出时调用兜底清除历史孤儿。
 */
function killStaleNextServers(): void {
  try {
    const stalePids = listStaleServerPidsSync('next-standalone');
    for (const pid of stalePids) {
      if (pid === process.pid) continue;
      if (terminatePid(pid, { force: true, tree: IS_WIN })) {
        log(`Stale next-server cleanup: killed pid=${pid} (next-standalone orphan)`);
      }
    }
  } catch (e) {
    log(`Stale next-server cleanup skipped: ${(e as Error).message}`);
  }
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
    killNextServer(); // HTTP 优雅关停 → 2.5s 强杀兜底 + 清理残留，并置 nextServerProc = null
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
  // 默认铺满主屏可用区域（此前宽度固定 1400、高度固定 900，宽屏上左右留白且底部不满；
  // 窗口状态不落盘，重启即回到固定值，故此处直接取屏幕可用区域并按其原点摆放）
  const workArea = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
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

  // 外部链接（http/https）统一在内置 Hippo Browser 打开；Hippo 不可用时退回系统默认浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (!openUrlInHippo(url)) shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 应用窗口内未走 window.open 的普通 <a> 跳转：外部站点同样收编到内置浏览器，避免主窗口被导航到外部站点
  win.webContents.on('will-navigate', (e, url) => {
    if (!/^https?:\/\//i.test(url) || url.startsWith(SERVER_URL)) return;
    e.preventDefault();
    if (!openUrlInHippo(url)) shell.openExternal(url);
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

/**
 * 创建主窗口并绑定 Butler 球窗监听。
 *
 * 为什么要包一层：主窗口在 macOS 上会被关闭后由 Dock 图标重建（见 activate），
 * 而「最小化 → 球独立留在桌面 / 还原 → 收球」这些监听必须挂在**当前**这个窗口上。
 * 直接调 createWindow() 会漏绑新窗口（表现为重建后最小化不再出球）。
 */
function createMainWindow(): BrowserWindow {
  const win = createWindow();
  bindButlerOrbMainWindow(win);
  return win;
}

/**
 * 显示主窗口（不存在则重建）。Dock 图标激活 / 第二次启动 / 点击桌面悬浮球都走这里，
 * 三处行为必须一致（restore + show + focus）。
 */
function openMainWindow(): BrowserWindow | null {
  if (!app.isReady()) {
    // second-instance / activate 有可能在 whenReady 完成前到达，此时建窗会抛
    // "Cannot create BrowserWindow before app is ready" → 等就绪再走一遍
    void app.whenReady().then(() => openMainWindow());
    return null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  const win = createMainWindow();
  mainWindow = win;
  // Hippo 初始化失败绝不能阻断主窗口显示：否则 openMainWindow 抛错后 loadURL/show 不执行，
  // 应用会变成「有进程、无窗口」的假死状态（更新后重启时表现为「打不开，必须强制退出」）。
  if (!isHippoReady()) {
    try {
      setupHippoBrowser();
    } catch (err) {
      log(`setupHippoBrowser failed (main window will still open): ${String(err)}`);
    }
  }
  win.loadURL(SERVER_URL);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
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
type ScreenOcrEditorShot = {
  dataUrl: string;
  mode: 'region' | 'full';
  geometry?: ScreenOcrGeometry | null;
  /** 画面属于哪一屏（geometry.screens 下标）；-1/null = 全部屏幕并集 */
  screenIndex?: number | null;
};
let pendingEditorShot: ScreenOcrEditorShot | null = null;

/** 创建覆盖窗口（不显示）：预加载与首次使用共用。透明置顶、覆盖光标所在显示器 */
function createOcrEditorWindow(): BrowserWindow | null {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // 优先用助手给的权威点尺寸（NSScreen），回退 Electron 的 display.bounds
    const preferred = ocrEditorBoundsFromGeometry(screenGeometryCache);
    const bounds = preferred ?? { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height };
    log(
      `[ocr-geom] window=${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}x${Math.round(bounds.height)} ` +
        `source=${preferred ? 'nsscreen' : 'electron'} display.bounds=${display.bounds.width}x${display.bounds.height} scaleFactor=${display.scaleFactor}`,
    );
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
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
      show: false,
      // 关键：允许窗口突破工作区，真正盖住菜单栏与 Dock。
      // 实测（Electron 实测脚本，主屏 1512x982 / workArea y=33 h=890）：
      //   不带此开关：请求 (0,0,1512x982) → show 后实际 (0,33,1512x982)，
      //     即窗口被下移一个菜单栏高度、底部再压到 Dock 上，
      //     画面 1:1 铺开时「真实菜单栏/Dock」与「照片里的菜单栏/Dock」同时出现（用户反馈的重复）。
      //   带上此开关：实际 (0,0,1512x982)，与屏幕逐点重合，只剩照片里那一套，蒙版错觉成立。
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    // 覆盖所有虚拟桌面（Space）：显示在当前活动桌面，不把用户切回 BobWork 所在桌面。
    // visibleOnFullScreen 让覆盖层能盖在全屏应用之上（在全屏 Space 里也能截图）。
    // 窗口平时隐藏，仅截图编辑期间出现，因此「所有桌面可见」不会造成常驻干扰。
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
    win.on('closed', () => {
      ocrEditorWindow = null;
      pendingEditorShot = null;
    });
    // 覆盖窗口 console 转发（排查编辑器交互问题；主窗口日志同前缀文件）
    win.webContents.on('console-message', (_e, level, message) => {
      try {
        fs.appendFileSync(path.join(os.homedir(), '.bobwork-renderer.log'), `[OCR-WIN:${level}] ${message}\n`);
      } catch { /* ignore */ }
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      try {
        fs.appendFileSync(path.join(os.homedir(), '.bobwork-renderer.log'), `[OCR-WIN:gone] ${JSON.stringify(details)}\n`);
      } catch { /* ignore */ }
    });
    win.loadURL(`${SERVER_URL}/ocr-editor`);
    return win;
  } catch (e) {
    log(`创建截图编辑覆盖窗口失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 预加载覆盖窗口：server 就绪后提前创建并加载页面（保持隐藏）。
 *  消除首次截图那一段「建窗口 + loadURL + React 水合」耗时——这是「按快捷键→出蒙版」的主要延迟来源。 */
function prewarmOcrEditorWindow(): void {
  try {
    if (ocrEditorWindow && !ocrEditorWindow.isDestroyed() && !ocrEditorWindow.webContents.isCrashed()) return;
    const win = createOcrEditorWindow();
    if (!win) return;
    ocrEditorWindow = win;
    log('OCR editor window prewarmed.');
  } catch (e) {
    log(`预加载截图编辑覆盖窗口失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 显示覆盖窗口并下发待编辑截图（常驻复用：仅 show + send，不重建窗口/不重载页面）。
 *  旧实现每次截图都 webContents.reload()（整页重载 + Next 重新水合），
 *  导致「按快捷键→出现编辑画面」明显迟滞/白闪——已移除。 */
function openScreenOcrEditorWindow(shot: ScreenOcrEditorShot): BrowserWindow | null {
  try {
    let win = ocrEditorWindow;
    if (win && (win.isDestroyed() || win.webContents.isCrashed())) {
      try { win.close(); } catch { /* ignore */ }
      win = null;
      ocrEditorWindow = null;
    }
    if (!win) {
      win = createOcrEditorWindow();
      if (!win) return null;
      ocrEditorWindow = win;
    }
    // 移到光标所在显示器 → 显示 → 下发新截图（同样优先用权威点尺寸）
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      // 用本次 shot 命中的屏（不是上一次的 pendingEditorShot）
      const want = ocrEditorBoundsFromGeometry(screenGeometryCache, shot.screenIndex) ?? display.bounds;
      win.setBounds(want);
      // 校验：macOS 是否把窗口夹回工作区（y 应为屏幕原点 0；若出现 y=33 说明
      // enableLargerThanScreen 未生效，会重现「菜单栏/Dock 重复」）
      const got = win.getBounds();
      log(
        `[ocr-geom] setBounds want=${Math.round(want.x)},${Math.round(want.y)} ${Math.round(want.width)}x${Math.round(want.height)} ` +
          `got=${Math.round(got.x)},${Math.round(got.y)} ${Math.round(got.width)}x${Math.round(got.height)}`,
      );
    } catch { /* ignore */ }
    pendingEditorShot = shot;
    win.show();
    // 不再调用 app.focus({ steal: true })：强激活应用会把用户切回 BobWork 主窗口所在的 Space。
    // 覆盖窗口已 setVisibleOnAllWorkspaces，show + focus 即在当前桌面成为关键窗口并拿到键盘焦点
    // （文字输入框 / Esc 退出依赖此焦点；若端上实测焦点不足，再退化为 app.focus）。
    win.focus();
    try { win.webContents.focus(); } catch { /* ignore */ }
    try { win.webContents.send('screen-ocr:new-shot', shot); } catch { /* ignore */ }
    return win;
  } catch (e) {
    log(`显示截图编辑覆盖窗口失败，回退主窗口编辑: ${e instanceof Error ? e.message : String(e)}`);
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
// 1.0.7：助手新增 windows 动作（只枚举屏幕/窗口几何，不截图），供启动时预热权威屏幕点尺寸
// 1.0.7 → 1.0.8：fullscreen 只抓光标所在单屏（screencapture -D，带像素尺寸回验），
// result.json 增加 screen 字段（-1 = 并集兜底），供覆盖窗口与画面坐标基准对齐
// 1.0.8 → 1.0.9：窗口枚举不再排除 BobWork 自身（画面保留自身 ↔ 自身可作为吸附目标保持一致）
const CAPTURE_HELPER_VERSION = '1.0.9';

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
type CaptureHelperResult = {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
  geometry?: ScreenOcrGeometry | null;
  /** 本次截图命中的屏幕下标（对应 geometry.screens[screenIndex]）；
   *  null = 未知；-1 = 抓的是全部屏幕并集（兜底）。多屏时画面只含这一屏。 */
  screenIndex?: number | null;
};

/** 最近一次从助手拿到的屏幕几何（权威点尺寸，来自 NSScreen）；启动时预热一次 */
let screenGeometryCache: ScreenOcrGeometry | null = null;

/** 覆盖窗口的 bounds（点/DIP）。
 *
 * 背景：用户反馈「整张蒙版显示在屏幕中间、比真实屏幕小」。BrowserWindow 的 x/y/width/height
 * 单位是 DIP，若直接拿 display.bounds 建窗而该值不是点尺寸，窗口就会与屏幕不等大，
 * 画面再按窗口尺寸 fit 就会偏大/偏小并居中留白。这里以助手给出的权威点尺寸为准。 */
function ocrEditorBoundsFromGeometry(
  geo: ScreenOcrGeometry | null,
  preferIndex?: number | null,
): { x: number; y: number; width: number; height: number } | null {
  const screens = geo?.screens;
  if (!screens || screens.length === 0) return null;
  // 助手已回传「实际抓到的是哪一屏」时以它为准：覆盖窗口必须与画面同源，
  // 否则（窗口在 A 屏、画面是 B 屏）会出现画面被缩放/错位的老问题。
  if (typeof preferIndex === 'number' && preferIndex >= 0 && screens[preferIndex]) {
    const s = screens[preferIndex];
    return { x: s.x, y: s.y, width: s.w, height: s.h };
  }
  // display.bounds 与光标点同单位；与权威点尺寸一比即可得出换算系数（1 = 点，2 = 物理像素）
  let unit = 1;
  try {
    const primary = screen.getPrimaryDisplay();
    if (primary?.bounds?.width && screens[0]?.w) unit = primary.bounds.width / screens[0].w;
  } catch { /* ignore */ }
  const u = unit >= 1.5 ? 2 : 1;
  let cursor = { x: 0, y: 0 };
  try { cursor = screen.getCursorScreenPoint(); } catch { /* ignore */ }
  const cx = cursor.x / u;
  const cy = cursor.y / u;
  const hit = screens.find((s) => cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) ?? screens[0];
  return { x: hit.x, y: hit.y, width: hit.w, height: hit.h };
}

/** 向助手请求一次屏幕几何（只枚举，不截图），用于启动时预热权威点尺寸 */
async function fetchScreenGeometry(helperApp: string): Promise<ScreenOcrGeometry | null> {
  try {
    const staging = path.join(os.homedir(), 'Library', 'Caches', 'bobwork-capture');
    const windowsFile = path.join(staging, 'windows.json');
    try { fs.mkdirSync(staging, { recursive: true }); } catch { /* ignore */ }
    try { fs.rmSync(windowsFile, { force: true }); } catch { /* ignore */ }
    try { fs.writeFileSync(path.join(staging, 'request.json'), JSON.stringify({ action: 'windows' })); } catch { return null; }
    const launched = await new Promise<boolean>((resolve) => {
      execFile('/usr/bin/open', [helperApp], { timeout: 10_000 }, (err) => resolve(!err));
    });
    if (!launched) return null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const g = readWindowsGeometry(windowsFile);
      if (g) return g;
      await new Promise((r) => setTimeout(r, 60));
    }
    return null;
  } catch {
    return null;
  }
}

/** 读取助手产出的窗口几何（windows.json）；缺失/损坏返回 null（前端退化为不吸附） */
function readWindowsGeometry(file: string): ScreenOcrGeometry | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ScreenOcrGeometry;
    if (!parsed || !Array.isArray(parsed.screens) || !Array.isArray(parsed.windows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function captureRegionViaHelper(helperApp: string): Promise<CaptureHelperResult> {
  const t0 = Date.now();
  const staging = path.join(os.homedir(), 'Library', 'Caches', 'bobwork-capture');
  const jsonFile = path.join(staging, 'result.json');
  const shotFile = path.join(staging, 'shot.jpg');
  const windowsFile = path.join(staging, 'windows.json');

  // 上一轮编辑面板若仍在处理同一固定目录的暂存截图，先挪到独立临时路径，避免被本次清理覆盖
  if (pendingShotPath && path.dirname(pendingShotPath) === staging) {
    try {
      const keep = path.join(os.tmpdir(), `bobwork-edit-${Date.now()}${path.extname(pendingShotPath)}`);
      fs.copyFileSync(pendingShotPath, keep);
      pendingShotPath = keep;
    } catch { /* ignore */ }
  }
  // 清理上一次残留，保证读到的是本次结果
  try { fs.rmSync(jsonFile, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(shotFile, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(windowsFile, { force: true }); } catch { /* ignore */ }
  // 微信式：整屏捕获（JPEG，快）→ 前端覆盖窗口全屏显示原位画面并拖选；不再用 -i 原生选区
  try { fs.writeFileSync(path.join(staging, 'request.json'), JSON.stringify({ action: 'fullscreen' })); } catch { /* ignore */ }

  const launched = await new Promise<boolean>((resolve) => {
    execFile('/usr/bin/open', [helperApp], { timeout: 10_000 }, (err) => resolve(!err));
  });
  if (!launched) return { ok: false, error: '无法启动截图助手 BobWorkCapture（open 失败）' };
  const t1 = Date.now();

  /** 读一次结果；原子写未完成时返回 null（稍后重试） */
  const parseResult = (): CaptureHelperResult | null => {
    try {
      if (!fs.existsSync(jsonFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as {
        ok?: boolean;
        canceled?: boolean;
        error?: string;
        screen?: number;
      };
      // screen：-1 = 整屏并集（兜底）；>=0 = 命中第 N 屏（与 geometry.screens 下标一致）
      const screenIndex = typeof parsed.screen === 'number' ? parsed.screen : null;
      if (parsed.ok && fs.existsSync(shotFile)) return { ok: true, path: shotFile, screenIndex };
      if (parsed.canceled) return { ok: false, canceled: true };
      return { ok: false, error: parsed.error || '截图失败' };
    } catch {
      return null; // result.json 原子写中
    }
  };

  // 结果监听：fs.watch 即时感知（取代 150ms 定长轮询，省 0–150ms 的粒度等待）；
  // 保留 40ms 兜底轮询（watch 在部分环境不触发，同时兼作超时检查）。整屏捕获秒回，30s 超时按失败处理。
  const deadline = Date.now() + 30_000;
  const result = await new Promise<CaptureHelperResult>((resolve) => {
    let done = false;
    let watcher: fs.FSWatcher | null = null;
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      try { watcher?.close(); } catch { /* ignore */ }
      if (timer) { clearInterval(timer); timer = null; }
    };
    const finish = (r: CaptureHelperResult) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(r);
    };
    const check = () => {
      if (done) return;
      const r = parseResult();
      if (r) finish(r);
      else if (Date.now() > deadline) finish({ ok: false, error: '截图助手超时未返回结果' });
    };
    try { watcher = fs.watch(staging, () => check()); } catch { /* watch 不可用则退化为纯轮询 */ }
    timer = setInterval(check, 40);
    check(); // 立即查一次（结果可能已就绪）
  });

  const t2 = Date.now();
  log(`[ocr-perf] helper open=${t1 - t0}ms capture=${t2 - t1}ms`);
  return { ...result, geometry: readWindowsGeometry(windowsFile) };
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
  const t0 = Date.now();
  try {
    const helperApp = resolveCaptureHelperApp();
    const useHelper = helperApp !== null && (await isCapturePluginEnabled());
    // 通知渲染层「选区进行中」（前端可据此弱化输入框焦点状态）
    mainWindow?.webContents.send('screen-ocr:start');

    // 主窗口**不再隐藏/置透明**：过去用 setOpacity(0) 把自身排除出快照（"避开拍到自己"），
    // 副作用是用户看到的「按快捷键 → BobWork 先消失一下，冻结照片里也没有 BobWork」。
    // 现改为保留自身：冻结画面与截图前所见逐帧一致，且能截 BobWork 自己的内容。
    // 历史教训（勿回退）：更不能用 hide()/show()——show 一个位于其他虚拟桌面的窗口，
    // 会让 macOS 直接切回那个桌面（用户曾反馈「按快捷键后跳回 BobWork 所在桌面」）。
    let shot: CaptureHelperResult;
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
    const t3 = Date.now();
    const dataUrl = await fileToDataUrl(shot.path!);
    const t4 = Date.now();
    log(`[ocr-perf] shortcut→shot=${t3 - t0}ms dataUrl=${t4 - t3}ms (${Math.round(dataUrl.length / 1024)}KB base64)`);
    // 每次截图顺带刷新权威屏幕几何（助手已随本次截图产出）
    if (shot.geometry) screenGeometryCache = shot.geometry;
    const mode = 'full';
    const geometry = shot.geometry ?? null;
    const screenIndex = shot.screenIndex ?? null;
    const edWin = openScreenOcrEditorWindow({ dataUrl, mode, geometry, screenIndex });
    if (!edWin) {
      // 覆盖窗口创建失败兜底：回退主窗口内编辑（ScreenOcrHost 渲染编辑面板）。
      // 此路径必须显示主窗口才能编辑，切换桌面属预期（仅覆盖窗口创建失败时才会走到这里）
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('screen-ocr:captured', { dataUrl, mode, geometry, screenIndex });
    }
  } catch (e) {
    log(`Screen OCR error: ${e instanceof Error ? e.message : String(e)}`);
    mainWindow?.webContents.send('screen-ocr:error', {
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    // 主窗口不再临时置透明（截图保留自身，见上），此处只复位忙标志
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

/** 内置头像目录（开发/打包双路径），供头像池的内置项使用 */
function resolveBuiltinAvatarDir(): string {
  if (isDev) {
    // 开发模式：直接读取项目 assets 目录
    return path.resolve(__dirname, '../../assets/avatars');
  }
  // 打包模式：构建脚本已复制到 Resources/avatars/
  return path.join(process.resourcesPath, 'avatars');
}

/** 欢迎窗口品牌图标（固定使用 public/welcome-icon.png）
 *  - dev：读项目 public 目录
 *  - 打包：读随包分发的 next-standalone/public 目录 */
function resolveWelcomeLogoPath(): string {
  if (isDev) {
    return path.resolve(__dirname, '../../public/welcome-icon.png');
  }
  return path.join(process.resourcesPath, 'next-standalone/public/welcome-icon.png');
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
  width: 104px; height: 104px; border-radius: 24px; background: var(--card); border: 1px solid var(--border);
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
 * - logo：固定使用 public/welcome-icon.png
 * - 动态加载按钮 + 一行随机民法典法条
 * - 主题颜色跟随系统深浅色（prefers-color-scheme）
 * - 资源缺失时返回 null（回退为直接等待主窗口，不影响启动）
 */
async function createSplashWindow(): Promise<BrowserWindow | null> {
  try {
    // 欢迎窗口品牌图标：固定使用 public/welcome-icon.png
    const logoPath = resolveWelcomeLogoPath();
    if (!fs.existsSync(logoPath)) {
      log('Splash skipped: welcome icon not found');
      return null;
    }
    const logoDataUrl = imageToDataUrl(logoPath);

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
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((e) => {
      log(`Splash loadURL failed (icon too large? data URL chars=${encodeURIComponent(html).length}): ${String(e)}`);
      if (!win.isDestroyed()) win.destroy();
    });
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

  // 内置头像
  const builtinDir = resolveBuiltinAvatarDir();
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

/**
 * updater 缓存根目录（按平台取「缓存」语义的真实位置）。
 *
 * 为什么不手拼 `~/Library/Caches`：Windows 上会造出一个假的
 * `C:\Users\x\Library\Caches`，与 electron-updater 自己的缓存目录永远对不上，
 * 表现为「下载完了但安装时找不到包」。
 *
 * 也不使用 `app.getPath('cache')`：Electron 的 PathName 里没有 'cache'
 * （类型定义会直接报错，运行期也不保证存在）。
 *   - macOS  → ~/Library/Caches（与原实现一致，老用户的 .partial 可继续续传）
 *   - Windows → %LOCALAPPDATA%（electron-updater 的常规缓存根）
 *   - Linux  → $XDG_CACHE_HOME 或 ~/.cache
 */
function updaterCacheDir(): string {
  if (IS_DARWIN) {
    return path.join(app.getPath('home'), 'Library', 'Caches', 'bob-updater');
  }
  if (IS_WIN) {
    const base = process.env.LOCALAPPDATA || app.getPath('userData');
    return path.join(base, 'bob-updater');
  }
  const base = process.env.XDG_CACHE_HOME || path.join(app.getPath('home'), '.cache');
  return path.join(base, 'bob-updater');
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
let lastUpdateMeta: { version: string; fileName: string; url: string; size: number; sha512: string } | null = null;

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
            // 平台无关：Windows 是 .exe.partial，macOS 是 .zip.partial。
            // 只认合规产物名，避免把用户手放的文件当残留删掉。
            const artifact = parseUpdateArtifact(entry.name.slice(0, -'.partial'.length));
            if (artifact) {
              const v = artifact.version;
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
          } else if (parseUpdateArtifact(entry.name)) {
            // 已安装版本的完整安装包不再需要：仅保留版本号高于当前运行版本的包（供续装/回退）
            const artifact = parseUpdateArtifact(entry.name);
            if (artifact && !versionGreater(artifact.version, app.getVersion())) {
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

/** 计算文件 sha512（小写 hex，与 mac 侧 `shasum -a 512` 生成的清单一致） */
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
 * 校验文件 sha512，**同时接受 hex 与 base64 两种写法**。
 *
 * 为什么必须兼容：两个平台的清单不是同一个工具生成的 ——
 *   - macOS：scripts/package-release.sh 用 `shasum -a 512`（hex）；
 *   - Windows：electron-builder 的 latest.yml 用 builder-util `hashFile`（base64）。
 * 只比 hex 时，Windows 每一次下载都会「校验失败 → 删文件 → 重下」循环 3 次后报错，
 * 而日志只写 checksum mismatch，与真因（编码不同）完全无关。
 */
async function sha512Matches(filePath: string, expected: string): Promise<boolean> {
  const want = String(expected || '').trim();
  if (!want) return false;
  const hex = (await sha512OfFile(filePath)).toLowerCase();
  if (hex === want.toLowerCase()) return true;
  const base64 = Buffer.from(hex, 'hex').toString('base64');
  return base64 === want;
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

/**
 * 将已下载的更新包复制到 install handler 读取的 pending 目录（已存在且大小一致则跳过）。
 *
 * 仅 macOS 需要：那边的安装实现是「解压 zip → 覆盖 .app」，依赖 pending 里的完整包。
 * Windows 直接把 NSIS 安装器跑起来即可，再复制一份 380MB 的 exe 纯属浪费磁盘和时间。
 */
function ensurePendingCopy(finalPath: string): void {
  if (!IS_DARWIN) return;
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
async function startResumableDownload(meta: { version: string; fileName: string; url: string; size: number; sha512: string }): Promise<boolean> {
  if (activeDownload) {
    if (activeDownload.version === meta.version) return true; // 同版本已在下载中
    activeDownload.cancelled = true;
    activeDownload = null;
  }
  const dir = updateDownloadDir();
  fs.mkdirSync(dir, { recursive: true });
  // 文件名来自清单（files[0].url），不再按平台写死：Windows 是 .exe、macOS 是 .zip
  const fileName = meta.fileName;
  const finalPath = path.join(dir, fileName);
  const partialPath = `${finalPath}.partial`;

  // 已存在且校验通过 → 视为下载完成：补发 update:downloaded 事件（否则复检同版本时
  // 前端会停在 downloading 转圈，因为没有任何后续事件能把它带出该状态）
  if (fs.existsSync(finalPath)) {
    try {
      if (await sha512Matches(finalPath, meta.sha512)) {
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
      if (!(await sha512Matches(finalPath, meta.sha512))) {
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
async function startResumableDownloadFromInfo(info: UpdateInfo): Promise<boolean> {
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
  // ⚠️ 不能把 `file.url` 直接当本地文件名：GitCode 会给 URL 带上 ?noCache=，
  // 原样拼进 path 会在 Windows 上产生非法字符，在 macOS 上则变成一个带问号的文件。
  const rawUrl = typeof file?.url === 'string' ? file.url : '';
  const fileName = fileNameFromUpdateUrl(rawUrl) || updateArtifactName(info.version, PLATFORM);
  const url = rawUrl.startsWith('http') ? rawUrl : `${resolveUpdateBaseUrl()}/${rawUrl || fileName}`;
  const meta = { version: info.version, fileName, url, size, sha512 };
  lastUpdateMeta = meta;
  return startResumableDownload(meta);
}

/**
 * 找出下载目录里版本最高的 Windows 安装器（NSIS exe）。
 *
 * 必须按版本号挑而不是 `readdirSync()[0]`：文件按字母序返回，
 * `0.7.9` 排在 `0.7.10` 之后，直接取第一个会把用户「升级」回旧版本。
 */
function findLatestWindowsInstaller(): string {
  try {
    const dir = updateDownloadDir();
    const best = pickLatestArtifact(fs.readdirSync(dir), 'exe');
    return best ? path.join(dir, best) : '';
  } catch {
    return '';
  }
}

/**
 * Windows 更新安装：运行已下载的 NSIS 安装器，然后退出当前实例。
 *
 * 参数与 electron-updater 的 NsisUpdater 完全一致（见其 doInstall）：
 *   /S            静默安装。assisted 安装器（oneClick:false）只有 Silent 时
 *                 才执行「装完自动拉起」分支（app-builder-lib/installSection.nsh），
 *                 不加则装完什么都不发生，用户会以为更新失败。
 *   --force-run   安装完成后自动启动新版本。
 *   --updated     标记这是升级：跳过安装目录选择页，复用已安装位置。
 *   --package-file 让安装器知道包位置（差分/修复用）。
 */
async function installWindowsUpdate(): Promise<{ success: boolean; installing?: boolean; cancelled?: boolean; error?: string }> {
  const installer = findLatestWindowsInstaller();
  if (!installer) {
    // 元数据缺失时下载走了 electron-updater 自带下载器，安装包在它自己的缓存里，
    // 只有它知道 installerPath —— 交给 quitAndInstall（Windows 上不存在签名回滚问题）。
    try {
      log('No installer in custom download dir — delegating to electron-updater');
      autoUpdater.quitAndInstall(false, true);
      return { success: true, installing: true };
    } catch (err) {
      log(`Windows install fallback failed: ${String(err)}`);
      return { success: false, error: 'No downloaded update installer found' };
    }
  }

  const dialogOpts: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Restart to Complete Update',
    message: 'Restart BobWork to finish the update?',
    detail: 'BobWork will close, install the update, and reopen automatically. Your data is safe.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, dialogOpts)
    : await dialog.showMessageBox(dialogOpts);
  if (response !== 0) {
    log(`Windows install cancelled by user — installer staged (${installer})`);
    return { success: false, cancelled: true, error: 'Update cancelled' };
  }

  mainWindow?.webContents.send('update:install-progress', { stage: 'installing', message: 'Installing update…', percent: 60 });
  const args = ['/S', '--force-run', '--updated', `--package-file=${installer}`];
  const child = spawn(installer, args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => log(`Failed to launch Windows installer: ${String(err)}`));
  child.unref();
  log(`Windows installer launched: ${installer}`);

  // 收尾顺序与 macOS 分支一致：先让窗口消失，再停 Next 服务，最后退出。
  // 反过来会在退出瞬间留下「窗口还在、服务已停」的白屏（也会留下 Butler 球窗）。
  mainWindow?.webContents.send('update:install-progress', { stage: 'launching', message: 'Restarting…', percent: 90 });
  appQuitting = true;
  disposeButlerOrb();
  try {
    mainWindow?.hide();
  } catch { /* 忽略 */ }
  killNextServer();
  setTimeout(() => {
    flushPendingKills({ force: true });
    app.exit(0);
  }, 500);

  return { success: true, installing: true };
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
    const cacheDir = updaterCacheDir();
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
    //
    // ⚠️ 平台分流（2026-10 起 Windows 也走自动更新）：
    //   - macOS：绕过 Squirrel 的签名校验，自实现「解压 zip → 覆盖 /Applications」；
    //   - Windows：运行下载好的 NSIS 安装器（/S + --force-run 由安装器自己重启应用）；
    //   - 其余平台：明确拒绝，而不是让它们命中 /usr/bin/unzip 报出与真因无关的错误。
    if (IS_WIN) {
      return await installWindowsUpdate();
    }
    if (!IS_DARWIN) {
      return { success: false, error: '自动安装目前仅支持 macOS / Windows' };
    }
    try {
      const cacheDir = updaterCacheDir();
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
        // 精简文案：原三行说明（就绪/自动重启/数据不受影响）压成一句，减少弹窗信息量
        detail: 'BobWork will reopen automatically. Your data is safe.',
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
      //
      // ⚠️ 必须确保旧实例真正退出后再 `open`：否则 macOS 的 `open` 只是「激活」仍在运行的旧实例
      // （不会启动新版本），而旧实例此时已无窗口 —— 表现为「更新后自动打开却半天打不开、
      // 必须强制退出才恢复」。旧版只发 SIGTERM，主进程不退时无兜底 → 残留实例持单实例锁把新版
      // 挡在门外（用户现场实测：升级始终不生效）。此处改 SIGKILL，并**轮询确认进程真的消失**再替换 app。
      const script = [
        `sleep 3`,
        `pkill -9 -f "^${targetApp}/Contents/MacOS/BobWork$" 2>/dev/null || true`,
        `for _ in $(seq 1 20); do pgrep -f "^${targetApp}/Contents/MacOS/BobWork$" >/dev/null 2>&1 || break; sleep 0.5; done`,
        `pkill -9 -f "^${targetApp}/Contents/MacOS/BobWork$" 2>/dev/null || true`,
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
      // 同时先置 appQuitting：否则看门狗会在退出过程中把刚杀掉的 Next.js 服务又拉起来
      //（用户现场实测：安装后主进程未退、服务被看门狗复活 → 旧实例持锁挡新版）。
      appQuitting = true;
      // 与 before-quit 同款收尾，安装路径不能省：app.exit() **不触发** before-quit，而退出时
      // 主窗 closed 会走「出球」那条路 —— 那一刻服务已被杀，球窗加载 /butler-orb 失败，会在
      // 桌面上留下一块 54×54 的白色置顶小方块（2026-10-12 用户实测：「更新后打开时白色的」）。
      // 顺序要求：必须在 hide() 之前 dispose —— hide 会触发 win.on('hide') → showOrbFree()。
      disposeButlerOrb();
      // 再让主窗先消失、最后才杀服务：顺序反过来的话窗口还在、服务已没，界面会整片变白
      //（渲染层所有 API 都取不到，日志表现为成片的 `加载项目列表失败: Failed to fetch`）。
      try {
        mainWindow?.hide();
      } catch { /* 忽略 */ }
      killNextServer();

      // 延迟退出当前应用，让前端先收到返回值
      setTimeout(() => {
        // app.exit(0) 不触发 will-quit ⇒ 升级强杀的定时器不会有机会跑，必须在这里同步兜底
        flushPendingKills({ force: true });
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
      updaterCacheDir(),
      // Squirrel.Mac 的残留目录只在 macOS 存在；其他平台拼出来只会是空路径
      ...(IS_DARWIN
        ? [
            path.join(app.getPath('home'), 'Library', 'Caches', 'com.bobwork.app.ShipIt'),
            path.join(app.getPath('home'), 'Library', 'Caches', 'com.bobwork.app.ShipItTemp'),
          ]
        : []),
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

  // ── 远程访问鉴权：strict 模式下桌面端（localhost）也需 Bearer，这里在网络层自动补 Token ──
  // 仅对发往本机 BobWork server 的请求注入；loopback-exempt 模式下回环本就豁免，无需注入。
  // webRequest 在网络层拦截，覆盖渲染进程所有 fetch / XHR，无需改动前端代码。
  let remoteAccessToken = '';
  let remoteAccessMode: 'loopback-exempt' | 'strict' = 'loopback-exempt';
  const refreshRemoteAccess = async () => {
    try {
      const s = await readSettingsFromFile();
      remoteAccessToken = s.remoteAccess?.token || '';
      remoteAccessMode = s.remoteAccess?.mode === 'strict' ? 'strict' : 'loopback-exempt';
    } catch {
      /* 忽略读取失败 */
    }
  };
  await refreshRemoteAccess();
  setInterval(refreshRemoteAccess, 5000).unref();
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (
      remoteAccessMode === 'strict' &&
      remoteAccessToken &&
      details.url.startsWith(SERVER_URL) &&
      !requestHeaders['Authorization']
    ) {
      requestHeaders['Authorization'] = `Bearer ${remoteAccessToken}`;
    }
    callback({ requestHeaders });
  });

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

  // ===== 头像管理 IPC（内置头像 + 用户自定义） =====

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
          // 用内置打包器而不是 `zip` 命令：Windows 没有 zip 命令行（只有 PowerShell 的
          // Compress-Archive，参数语义完全不同且慢）。adm-zip 已在依赖里，两平台同一份实现。
          let ok = false;
          try {
            const zip = new AdmZip();
            for (const f of files) zip.addLocalFile(f);
            zip.writeZip(zipPath);
            ok = fs.existsSync(zipPath);
          } catch (e) {
            log(`zip 打包失败: ${(e as Error).message}`);
          }
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


  // 系统音频采集（会议模式的远端参会人音源）：渲染层 getDisplayMedia({audio:true}) 时，
  // 主进程静默授权首个屏幕源并附 loopback 系统音轨（不弹选择器）。
  // 平台支持：macOS 14.2+（Apple CoreAudio Tap）/ Windows；Linux 无 loopback，降级为仅麦克风。
  // 注意：macOS 必须在 Info.plist 声明 NSAudioCaptureUsageDescription（见 scripts/build-electron.sh
  // 与 scripts/package-release.sh 的 plist）。dev 模式下责任进程是终端/IDE，其无该键 →
  // 系统音频**只能在打包版验证**；终端里跑 electron 只会拿到空音轨。
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 }, // 不要缩略图：省去每个源的图像处理，只要 id/name
        });
        if (sources.length === 0) {
          callback({});
          return;
        }
        const supportsLoopback = process.platform === 'darwin' || process.platform === 'win32';
        callback({
          video: sources[0],
          ...(request.audioRequested && supportsLoopback ? { audio: 'loopback' as const } : {}),
        });
      } catch (err) {
        log(`display-media handler failed: ${String(err)}`);
        callback({});
      }
    });
    log('系统音频采集 handler 已注册（display media / loopback）');
  } catch (err) {
    log(`系统音频采集 handler 注册失败: ${String(err)}`);
  }

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

  // Butler 桌面独立窗（最小化后留在桌面左下角的球 + 就地展开的 Butler 面板）：注册 IPC + 注入依赖。
  // 放在创建主窗口之前，让紧跟着的 bindButlerOrbMainWindow 有 host 可用；
  // 非 macOS 传 enabled:false，整个模块退化为空操作（不动 Windows/Linux 的退出语义）。
  setupButlerOrb({
    getMainWindow: () => mainWindow,
    getServerUrl: () => SERVER_URL,
    log,
    // 悬浮球目前只有 macOS 形态（透明无边框 + 全 Space 可见 + skipTransformProcessType）。
    // 非 darwin 显式记日志而不是静默禁用：功能消失必须有人知道，入口此时回退到主窗口。
    enabled: IS_DARWIN,
  });
  if (!IS_DARWIN) {
    log('[butler-orb] 当前平台未实现桌面悬浮球 —— Butler 入口回退到主窗口（阶段 H 处理）');
  }

  log('Creating splash window...');
  const splashWindow = await createSplashWindow();
  log('Creating main window...');
  mainWindow = createMainWindow();
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
  // 先注入主窗口读取器：Hippo 建窗/唤起时据此把自己摆到 BobWork 所在显示器（见 ensureOnMainWindowDisplay）
  setMainWindowProvider(() => mainWindow);
  setupHippoBrowser();
  // 浏览器收起为胶囊时，转发到主窗口渲染层（居中呼吸灯胶囊按钮）
  setMainWindowCapsuleListener((capsule) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hippo-browser:capsule', capsule);
      }
    } catch { /* 主窗口未就绪或已销毁时忽略 */ }
  });
  // Hippo 对话栏「投送画布」：把浏览器会话投给主窗口，由画布挂载新节点并置焦点
  setHippoChatCanvasNotifier((payload) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bob:focus-canvas-node', payload);
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
    // 预加载截图编辑覆盖窗口（保持隐藏）：首次 Cmd+Shift+O 直接 show + 下发截图，
    // 省去「建窗口 + loadURL + React 水合」这段——它是「按快捷键→出蒙版」延迟的最大头
    prewarmOcrEditorWindow();
    // 预热 Butler 独立球窗（保持隐藏）：消除首次最小化时「先空窗再出球」的迟滞，同理
    prewarmButlerOrb();
    // 预热屏幕几何：让助手枚举 NSScreen 拿到权威点尺寸，覆盖窗口据此创建（异步，不阻塞启动）
    void (async () => {
      try {
        const helper = resolveCaptureHelperApp();
        if (!helper) return;
        const g = await fetchScreenGeometry(helper);
        if (g) {
          screenGeometryCache = g;
          log(`[ocr-geom] cached screens=${g.screens.map((s) => `${Math.round(s.w)}x${Math.round(s.h)}@${s.scale}`).join(', ')}`);
        } else {
          log('[ocr-geom] 预热屏幕几何失败，回退 Electron display.bounds');
        }
      } catch { /* ignore */ }
    })();
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
      <p>Next.js 服务启动超时。请检查日志：<br><code>${app.getPath('logs')}/bob-work.log</code></p>
      <p style="color:#888;margin-top:20px;">错误: ${String(err)}</p>
      </body></html>`
    )}`);
    mainWindow.show();
  }

  app.on('activate', () => {
    // macOS: 点击 dock 图标时重新显示或创建窗口（与「点击桌面悬浮球」共用同一条路径）
    openMainWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS：关闭窗口后保持应用运行（dock 栏仍可见），不杀服务进程
  // 用户点击 dock 图标时通过 activate 事件重新创建窗口
  if (!IS_DARWIN) {
    // 非 macOS：关窗即退出。这里**异步等一下**优雅关停再 quit ——
    // Windows 上 process.kill() 就是 TerminateProcess，直接杀掉会打断 SQLite WAL 收尾
    // 与正在落盘的 docx；而 app.quit() 之后 will-quit 是同步的，没机会等。
    const pid = nextServerProc?.pid;
    killNextServer();
    void (async () => {
      if (pid) await waitPidsGone([pid], GRACEFUL_KILL_DEADLINE_MS);
      flushPendingKills({ force: true });
      app.quit();
    })();
    return;
  }
});

// 退出前清理 Butler 临时项目（/chat 残留）再杀服务进程：
// 发送 DELETE 请求由服务端删除临时项目，收到响应/出错/超时后终止 Next.js 子进程。
// 用 quitCleanupStarted 防止 before-quit 重复触发时重复清理。
let quitCleanupStarted = false;
app.on('before-quit', () => {
  // 通知看门狗停止探测/重启（退出流程正在终止服务）
  appQuitting = true;
  // 销毁 Butler 独立球窗：否则退出时主窗 closed → 又会把球窗显示出来
  disposeButlerOrb();
  // 全局快捷键随应用退出注销（避免残留占用系统级按键）
  try {
    globalShortcut.unregisterAll();
  } catch { /* ignore */ }
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  const cleanupTempProjectOnExit = () => {
    const req = http.request(`${SERVER_URL}/api/core/node-chat`, { method: 'DELETE' }, (res) => {
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

// 退出前最后一道同步兜底：把「已登记但还没确认退出」的子进程强杀掉。
// 为什么不能只靠 before-quit 里的定时器：进程退出后定时器不再执行，
// 剩下的子进程就成为占着端口的孤儿（下次启动会以 EADDRINUSE / 闪退的形式暴露）。
app.on('will-quit', () => {
  try {
    flushPendingKills();
  } catch { /* 兜底失败不阻塞退出 */ }
});
