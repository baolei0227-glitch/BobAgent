/**
 * Electron 主进程
 *
 * 启动 Next.js standalone 服务为子进程，创建 BrowserWindow 加载本地 URL。
 * 生产模式下从打包资源中启动 Next.js 服务；开发模式下连接 pnpm dev。
 */

import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import { autoUpdater } from 'electron-updater';
import {
  handleParseImage,
  handleParseGetCache,
  handleParseClearCache,
} from './handlers/parse-handlers';
import { readSettingsFromFile, writeSettingsToFile } from '../src/lib/settings-server';

let nextServerProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

/** 是否为开发模式：app.isPackaged 在非 asar 打包时不可靠，改为检查 standalone 目录是否存在 */
const standaloneDir = path.join(process.resourcesPath, 'next-standalone');
const isDev = !fs.existsSync(standaloneDir);

/** 
 * 检查是否存在 .bobagent-dev 标记文件，用于开发版 .app 隔离
 * build-electron.sh 会在构建时创建此文件
 */
const devMarkerPath = path.join(process.resourcesPath, '.bobagent-dev');
const isDevBuild = fs.existsSync(devMarkerPath);

/**
 * 为开发模式单独设置 BOBAGENT_HOME，实现开发版与安装版数据隔离。
 * 安装版（打包后）不设置此环境变量，走默认路径 ~/BobAgent/。
 */
if (isDev || isDevBuild) {
  process.env.BOBAGENT_HOME = path.join(app.getPath('home'), 'BobAgent-Dev');
}

const PORT = isDev ? 3000 : 8321;
const SERVER_URL = `http://localhost:${PORT}`;

/** 日志写入文件（生产模式诊断用） */
const logDir = isDev ? null : app.getPath('logs');
const logFile = isDev ? null : path.join(logDir!, 'bob-agent.log');
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

// 捕获未处理异常，避免 Electron 弹出 "Uncaught Exception" 对话框
process.on('uncaughtException', (err: Error) => {
  log(`Uncaught Exception: ${err.message}\n${err.stack ?? ''}`);
});
process.on('unhandledRejection', (reason: unknown) => {
  log(`Unhandled Rejection: ${String(reason)}`);
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

/** 启动 Next.js standalone 服务 */
function startNextServer(): ChildProcess {
  if (isDev) {
    // 开发模式：next dev 已由 pnpm dev:web 启动，无需在此启动
    throw new Error('Should not start server in dev mode');
  }

  const serverPath = path.join(
    process.resourcesPath,
    'next-standalone',
    'server.js',
  );

  // 构建包含 node 的 PATH，供子进程内部可能的 spawn('node', ...) 调用使用
  const childPath = buildChildPath();
  log(`Child PATH: ${childPath}`);

  // 使用系统 Node.js 启动（避免 Dock 栏出现多余的终端图标）
  // buildChildPath() 已构建包含 nvm/fnm/brew node 的完整 PATH
  let sandboxPath = path.join(app.getPath('home'), 'BobAgent', 'sandbox');
  if (isDev) {
    // 开发模式：sandbox 也切换到 BobAgent-Dev
    sandboxPath = process.env.BOBAGENT_HOME ? path.join(process.env.BOBAGENT_HOME, 'sandbox') : sandboxPath;
  }
  const proc = spawn('node', [serverPath], {
    cwd: path.join(process.resourcesPath, 'next-standalone'),
    env: {
      ...process.env,
      // 覆写 PATH，确保子进程能找到 node 等命令
      PATH: childPath,
      PORT: String(PORT),
      HOSTNAME: 'localhost',
      NODE_ENV: 'production',
      // 工具调用的工作区路径，AI 可读写此目录下的文件
      COZE_WORKSPACE_PATH: sandboxPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 捕获 spawn 错误（如 ENOENT），避免 Uncaught Exception
  proc.on('error', (err: Error) => {
    log(`Next.js server process error: ${err.message}`);
  });

  proc.stdout?.on('data', (data: Buffer) => {
    log(`[next] ${data.toString().trim()}`);
  });
  proc.stderr?.on('data', (data: Buffer) => {
    log(`[next:err] ${data.toString().trim()}`);
  });

  // 子进程意外退出时记录日志
  proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    log(`Next.js server exited: code=${code}, signal=${signal}`);
  });

  return proc;
}

/** 创建主窗口 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'BobAgent',
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
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

  // 先显示加载页面，避免 Dock 图标持续跳动
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
  win.show();

  return win;
}

/** 加载页面 HTML — server 就绪前显示 */
const LOADING_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#1a1a1a; color:#e0e0e0; font-family:-apple-system,BlinkMacSystemFont,sans-serif;
       display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; }
.spinner { width:32px; height:32px; border:3px solid #333; border-top-color:#666;
           border-radius:50%; animation:spin 0.8s linear infinite; margin-bottom:16px; }
@keyframes spin { to { transform:rotate(360deg); } }
p { font-size:14px; color:#888; }
</style></head><body>
<div class="spinner"></div>
<p>BobAgent 启动中...</p>
</body></html>`;

/** 自动更新配置 */
function setupAutoUpdater(): void {
  // 注册通用的 IPC handler（无论自动更新是否启用）
  ipcMain.handle('update:get-version', () => {
    return app.getVersion();
  });

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
    ipcMain.handle('update:install', () => {
      return { success: false, error: 'Auto-updater is not configured' };
    });
    return;
  }

  autoUpdater.autoDownload = true;

  /** 标记当前是否为手动检查更新（用于区分手动检查和自动检查的 UI 提示） */
  let isManualCheck = false;

  autoUpdater.on('checking-for-update', () => {
    log('Checking for update...');
    mainWindow?.webContents.send('update:checking', { manual: isManualCheck });
  });

  autoUpdater.on('update-available', (info) => {
    log(`Update available: ${info.version}`);
    mainWindow?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes || '',
      releaseDate: info.releaseDate || '',
    });
  });

  autoUpdater.on('update-not-available', () => {
    log('No update available');
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
    mainWindow?.webContents.send('update:downloaded');
    isManualCheck = false;
  });

  autoUpdater.on('error', (err) => {
    log(`Update error: ${err.message}`);
    mainWindow?.webContents.send('update:error', { message: err.message, manual: isManualCheck });
    isManualCheck = false;
  });

  ipcMain.handle('update:check', async () => {
    try {
      isManualCheck = true;
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
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      log(`Download update failed: ${err}`);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
    return { success: true };
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

  ipcMain.handle('parse:image', handleParseImage);
  ipcMain.handle('parse:get-cache', handleParseGetCache);
  ipcMain.handle('parse:clear-cache', handleParseClearCache);

  // 确保工作区目录存在
  let workspaceDir = path.join(app.getPath('home'), 'BobAgent', 'sandbox');
  if (process.env.BOBAGENT_HOME) {
    workspaceDir = path.join(process.env.BOBAGENT_HOME, 'sandbox');
  }
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  // 设置读写 IPC
  ipcMain.handle('settings:load', async () => {
    return await readSettingsFromFile();
  });
  ipcMain.handle('settings:save', async (_event, settings) => {
    await writeSettingsToFile(settings);
    return { success: true };
  });

  // 开发者工具
  ipcMain.handle('devtools:open', () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
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

  setupAutoUpdater();

  log('Creating main window...');
  mainWindow = createWindow();
  log('Window created (loading page shown).');

  if (!isDev) {
    log('Starting Next.js server...');
    nextServerProc = startNextServer();
  }

  try {
    log('Waiting for server...');
    await waitForServer(SERVER_URL);
    log('Server is ready. Loading app URL...');
    mainWindow.loadURL(SERVER_URL);
    log('App URL loaded.');
  } catch (err) {
    log(`Failed to start Next.js server: ${err}`);
    // 即使 server 启动失败，也显示错误页面
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<html><body style="background:#1a1a1a;color:#ff6b6b;font-family:sans-serif;padding:40px;">
      <h2>启动失败</h2>
      <p>Next.js 服务启动超时。请检查日志：<br><code>~/Library/Logs/BobAgent/bob-agent.log</code></p>
      <p style="color:#888;margin-top:20px;">错误: ${String(err)}</p>
      </body></html>`
    )}`);
  }

  app.on('activate', () => {
    // macOS: 点击 dock 图标时重新显示或创建窗口
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    } else {
      mainWindow = createWindow();
      mainWindow.loadURL(SERVER_URL);
    }
  });
});

app.on('window-all-closed', () => {
  // macOS：关闭窗口后保持应用运行（dock 栏仍可见），不杀服务进程
  // 用户点击 dock 图标时通过 activate 事件重新创建窗口
  if (process.platform !== 'darwin') {
    if (nextServerProc) {
      nextServerProc.kill();
      nextServerProc = null;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  if (nextServerProc) {
    nextServerProc.kill();
    nextServerProc = null;
  }
});
