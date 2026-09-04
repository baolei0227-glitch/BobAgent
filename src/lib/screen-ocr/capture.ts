/**
 * 全局截图 OCR（Cmd+Shift+O）核心模块
 *
 * 链路（macOS 原生，无第三方依赖）：
 *   `/usr/sbin/screencapture -x -o`（整屏捕获，秒回；选区交互由 BobWork 前端覆盖层完成）→ 临时 PNG
 *   → OCR：优先 bob-ocr-mcp `ocr.recognize`（项目统一识别出口，upgrade=off 纯本地 Vision）
 *   → 兜底：本地 Swift Vision（编译运行 ocr_vision.swift，需 Xcode CLT；无 CLT 时报明确错误）
 *
 * 注意：本模块只使用相对路径导入（无 @/ 别名），同时供
 *   1. Next.js API 路由（/api/screen-ocr）与
 *   2. Electron 主进程（electron/main.ts，tsup 编译为 CJS）复用，
 * 保证两处实现单一来源。截屏需宿主进程拥有 macOS「屏幕录制」权限。
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

/** 系统交互式选区截屏命令（-i 交互选区；-x 无快门声；-o 无阴影） */
const SCREENSHOT_CMD = '/usr/sbin/screencapture';
/** 选区交互最长等待（用户可能斟酌许久；Esc 取消时提前退出） */
const CAPTURE_TIMEOUT_MS = 120_000;
/** OCR 调用超时（单张截图本地 Vision 秒级，留足余量） */
const OCR_TIMEOUT_MS = 60_000;

export interface ScreenOcrResult {
  ok: boolean;
  /** 识别出的文本（ok=true 时有值） */
  text?: string;
  /** 用户按 Esc 取消选区（非错误，前端静默） */
  canceled?: boolean;
  /** 失败原因（ok=false 且非 canceled 时） */
  error?: string;
}

/** 单次截屏 + OCR：返回合并后的纯文本 */
export async function captureRegionAndOcr(): Promise<ScreenOcrResult> {
  const shot = await captureRegionToFile();
  if (!shot.ok) {
    if (shot.canceled) return { ok: false, canceled: true };
    return { ok: false, error: shot.error };
  }
  try {
    // OCR（bob-ocr-mcp 优先 → 本地 Swift Vision 兜底）
    const text = await ocrRecognize(shot.path!);
    if (!text.trim()) {
      return { ok: false, error: '选区内未识别到文字（可能选中了空白区域或纯图片）。' };
    }
    return { ok: true, text: text.trim() };
  } finally {
    cleanupShotFile(shot.path!);
  }
}

/** 截图文件结果（仅截屏，未 OCR） */
export interface ShotFileResult {
  ok: boolean;
  /** 临时 PNG 路径（ok=true 时有值） */
  path?: string;
  /** 用户按 Esc 取消选区（非错误，前端静默） */
  canceled?: boolean;
  /** 失败原因（ok=false 且非 canceled 时） */
  error?: string;
}

/**
 * 仅截屏（不 OCR）：整屏捕获 → 临时 PNG 路径。
 * 供「截图后编辑」链路复用：主进程拿到路径 → 下发渲染层编辑 → 编辑完成后同一文件再 OCR。
 */
export async function captureRegionToFile(): Promise<ShotFileResult> {
  // ---- 0. 屏幕录制权限预检 ----
  // 关键：screencapture 的权限按「责任进程」判定（dev 终端 / 打包版 .app），
  // 与系统设置里勾选的目标可能不一致。此处用 CGPreflight/SCShareableContent 预检
  // （与 screencapture 同一责任链，bobby 已验证准确）；未授权时先主动请求一次
  // （触发系统授权弹窗，归因真正运行的应用），授权成功则本次直接继续。
  const perm = await ensureScreenRecordingPermission();
  if (perm === 'denied') {
    const afterRequest = await requestScreenRecordingPermission();
    if (afterRequest === 'denied') {
      return { ok: false, error: buildScreenPermissionError() };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'bobwork-ocr-'));
  const shot = join(dir, 'shot.png');
  // ---- 1. 整屏截屏（无交互，秒回；选区交互由前端覆盖层完成）----
  try {
    const { stderr } = await execFileAsync(SCREENSHOT_CMD, ['-x', '-o', shot], {
      timeout: CAPTURE_TIMEOUT_MS,
    });
    // 截屏失败时 screencapture 退出码非 0（部分系统版本退出码为 1），以文件是否生成为准
    if (!existsSync(shot) && stderr) {
      return { ok: false, error: `截屏失败：${stderr.slice(0, 300)}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout/i.test(msg)) {
      return { ok: false, error: '整屏截屏超时（超过 120s），已取消。' };
    }
    // 预检已通过时不再猜测为权限问题，直接暴露真实错误（避免误导用户反复授权）
    return { ok: false, error: `截屏失败：${msg.slice(0, 400)}` };
  }
  if (!existsSync(shot)) {
    return { ok: false, canceled: true };
  }
  return { ok: true, path: shot };
}

/** 删除临时截图文件及所在目录（容错，文件已删/目录非空均忽略） */
export function cleanupShotFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    /* 忽略 */
  }
  try {
    rmdirSync(dirname(filePath));
  } catch {
    /* 目录非空/已删则忽略 */
  }
}

/** 图片路径 → 识别文本：bob-ocr-mcp 优先，失败降级本地 Swift Vision */
export async function ocrRecognize(imagePath: string): Promise<string> {
  try {
    const viaMcp = await ocrImageViaMcp(imagePath);
    if (viaMcp !== null) return viaMcp;
    console.warn('[screen-ocr] bob-ocr-mcp 不可用，降级本地 Swift Vision');
  } catch (e) {
    console.warn('[screen-ocr] bob-ocr-mcp 调用失败，降级本地 Swift Vision:', e instanceof Error ? e.message : e);
  }
  return ocrImageLocalSwift(imagePath);
}

// ==================== 引擎 A：bob-ocr-mcp（ocr.recognize） ====================

/**
 * 经 bob-ocr-mcp 识别单张图片。
 * 与 src/lib/mcp/ocr-client.ts 同一协议（无状态 streamable-http：
 * initialize → initialized → tools/call），但仅用相对导入 + 原生 fetch，
 * 便于 Electron 主进程（tsup）直接编译。MCP 未配置/不可用/失败 → null。
 */
async function ocrImageViaMcp(imagePath: string): Promise<string | null> {
  const cfg = await findOcrMcpConfig();
  if (!cfg?.url) return null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const auth = cfg.headers?.Authorization || cfg.headers?.authorization;
  if (auth) headers.Authorization = auth;

  // 1) initialize 握手（短超时，快速失败走降级）
  const init = await mcpPost(
    cfg.url,
    headers,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'bob-work-screen-ocr', version: '1.0.0' },
      },
    },
    2_000,
  ).catch(() => null);
  if (!init) return null;

  // 2) initialized 通知（可选，忽略失败）
  await mcpPost(cfg.url, headers, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 2_000).catch(() => null);

  // 3) tools/call ocr.recognize（本地 Vision，upgrade=off）
  const call = await mcpPost(
    cfg.url,
    headers,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ocr.recognize', arguments: { path: imagePath, upgrade: 'off' } },
    },
    OCR_TIMEOUT_MS,
  ).catch(() => null);
  if (!call) return null;

  const result = (call as { result?: { content?: { text?: string }[]; isError?: boolean } }).result;
  if (!result || result.isError) return null;
  const raw = (result.content ?? []).map((c) => c.text ?? '').join('');
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { rawPages?: Array<{ text?: string }>; text?: string; error?: string };
    if (j.error) return null;
    const pages = (j.rawPages ?? []).map((p) => p.text ?? '').join('\n');
    return (pages || j.text || '').trim();
  } catch {
    return raw.trim();
  }
}

/** 从 BobWork 设置读取 bob-ocr-mcp 条目（URL/token 随配置走） */
async function findOcrMcpConfig(): Promise<{ url: string; headers?: Record<string, string> } | null> {
  try {
    const { readSettingsFromFile } = await import('../settings-server');
    const settings = await readSettingsFromFile();
    const list = (settings as { mcpServers?: Array<{ id: string; enabled: boolean; url?: string; headers?: Record<string, string> }> }).mcpServers;
    const cfg = (list ?? []).find((s) => s.id === 'bob-ocr-mcp' && s.enabled && !!s.url);
    return cfg ? { url: cfg.url!, headers: cfg.headers } : null;
  } catch {
    return null;
  }
}

/** 单次 MCP JSON-RPC POST（兼容 JSON 与 SSE 两种响应体） */
async function mcpPost(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) return null;
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream') && res.body) {
      // SSE：逐帧解析，取 id 对应的请求响应帧
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let resultJson: string | undefined;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const raw = dataLine.slice(5).trim();
          if (!raw) continue;
          try {
            const msg = JSON.parse(raw);
            if (msg?.id !== undefined) resultJson = raw;
          } catch {
            /* 坏帧忽略 */
          }
        }
      }
      reader.releaseLock();
      return resultJson ? JSON.parse(resultJson) : null;
    }
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 引擎 B：本地 Swift Vision（兜底） ====================

/**
 * 本地 Swift Vision 脚本路径：多候选兜底（按存在性取第一个）
 *   1. 仓库源码路径（Next.js dev：cwd=projects 根）
 *   2. tsup 产物内（compile:electron 已把脚本复制到 electron/dist/pdf/core/）
 *   3. ESM 相对本模块
 */
function resolveSwiftScriptPath(): string {
  const candidates: string[] = [];
  candidates.push(join(process.cwd(), 'src/lib/pdf/core/ocr_vision.swift'));
  if (typeof __dirname !== 'undefined') {
    candidates.push(join(__dirname, 'pdf/core/ocr_vision.swift'));
  } else {
    // ESM 运行时（Next.js）：相对本模块解析；CJS（Electron tsup）import.meta 为空，需兜底
    try {
      candidates.push(fileURLToPath(new URL('../pdf/core/ocr_vision.swift', import.meta.url)));
    } catch {
      /* import.meta 不可用（CJS）时忽略该候选 */
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

const OCR_SWIFT_SCRIPT = resolveSwiftScriptPath();

/** 编译缓存目录（BOBWORK_HOME 隔离数据目录内，与其它 bin 一致） */
function localBinDir(): string {
  const home = process.env.BOBWORK_HOME || join(homedir(), 'BobWork');
  return join(home, '.bin');
}

/** 编译 Swift 脚本为可执行二进制（缓存到 BOBWORK_HOME/.bin/，幂等） */
function ensureCompiledBinary(scriptPath: string, binName: string): string {
  const binDir = localBinDir();
  const bin = join(binDir, binName);
  if (existsSync(bin)) return bin;
  if (!existsSync(scriptPath)) {
    throw new Error(`Swift 脚本缺失：${scriptPath}`);
  }
  mkdirSync(binDir, { recursive: true });
  execFileSync('/usr/bin/swiftc', ['-O', scriptPath, '-o', bin], { timeout: 90_000, stdio: 'pipe' });
  return bin;
}

/** 编译 ocr_vision.swift 为可执行二进制（幂等，缓存到 BOBWORK_HOME/.bin/ocr_vision） */
function ensureLocalOcrBinary(): string {
  if (!existsSync(OCR_SWIFT_SCRIPT)) {
    throw new Error(`Swift 脚本缺失：${OCR_SWIFT_SCRIPT}`);
  }
  return ensureCompiledBinary(OCR_SWIFT_SCRIPT, 'ocr_vision');
}

// ==================== 屏幕录制权限预检（与 screencapture 同一责任链） ====================

/**
 * screen_permission.swift 路径：多候选兜底（按存在性取第一个）
 *   1. 仓库源码路径（Next.js dev：cwd=projects 根）
 *   2. tsup 产物内（compile:electron 已把脚本复制到 electron/dist/swift/）
 *   3. ESM 相对本模块
 */
function resolveScreenPermScriptPath(): string {
  const candidates: string[] = [];
  candidates.push(join(process.cwd(), 'src/lib/screen-ocr/screen_permission.swift'));
  if (typeof __dirname !== 'undefined') {
    candidates.push(join(__dirname, 'swift', 'screen_permission.swift'));
  } else {
    try {
      candidates.push(fileURLToPath(new URL('./screen_permission.swift', import.meta.url)));
    } catch {
      /* import.meta 不可用（CJS）时忽略该候选 */
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

const SCREEN_PERM_SWIFT = resolveScreenPermScriptPath();

/**
 * 屏幕录制权限预检（不弹窗）：
 * CGPreflightScreenCaptureAccess（macOS 10.15+），与 screencapture 同一 TCC 责任链，
 * 检测结果即 screencapture 实际可用性。
 * @returns 'granted' | 'denied' | 'unknown'（unknown=预检不可用：无 CLT / 旧系统，交由 screencapture 自行判定）
 */
export async function ensureScreenRecordingPermission(): Promise<'granted' | 'denied' | 'unknown'> {
  return runScreenPermission('check');
}

/**
 * 主动请求屏幕录制权限（触发系统授权弹窗一次）：
 * 权限未决（从未授权也未拒绝）时 SCShareableContent 首次访问会弹系统标准授权窗
 * （归因当前应用的真正责任进程），等待用户响应后返回最终状态。
 * @returns 'granted' | 'denied' | 'unknown'
 */
export async function requestScreenRecordingPermission(): Promise<'granted' | 'denied' | 'unknown'> {
  return runScreenPermission('request');
}

async function runScreenPermission(mode: 'check' | 'request'): Promise<'granted' | 'denied' | 'unknown'> {
  try {
    const bin = ensureCompiledBinary(SCREEN_PERM_SWIFT, 'screen_permission');
    const { stdout } = await execFileAsync(bin, [mode], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    return /screen=1/.test(stdout) ? 'granted' : 'denied';
  } catch (e) {
    console.warn(`[screen-ocr] 屏幕录制权限预检（${mode}）不可用，跳过交由 screencapture 判定:`, e instanceof Error ? e.message : e);
    return 'unknown';
  }
}

/**
 * 屏幕录制权限被拒时的引导文案（端侧用户视角）：
 * - 打包版（.app）：只需勾选 BobWork 本体，不出现 Electron/路径等开发者术语；
 * - 仅开发模式（electron .）才提示终端归因（端侧永远不会出现）。
 */
export function buildScreenPermissionError(): string {
  try {
    const exe = process.execPath || '';
    const m = exe.match(/^(.*?\.app)\//);
    if (m) {
      if (m[1].includes('Electron.app')) {
        // 仅开发模式走到这里；打包版端侧用户不会出现
        return '未获得「屏幕录制」权限。开发模式（electron .）下系统按「启动它的终端应用」判定权限，请在 屏幕录制 中勾选启动 Electron 的终端（如 iTerm / Terminal / VS Code），或改用打包版 BobWork。勾选后完全退出并重新打开生效。';
      }
      // 打包版：端侧只需勾选 BobWork
      return '未获得「屏幕录制」权限。请在 屏幕录制 中勾选 BobWork（若列表中没有，点击 + 添加上一次安装的应用）；若已勾选仍失败，请完全退出并重新打开 BobWork 生效。';
    }
    return '未获得「屏幕录制」权限。请在 屏幕录制 中勾选 BobWork，勾选后完全退出并重新打开 BobWork 生效。';
  } catch {
    return '未获得「屏幕录制」权限。请在 屏幕录制 中勾选 BobWork，勾选后完全退出并重新打开 BobWork 生效。';
  }
}

/** 本地 Swift Vision OCR：图片路径 → 识别文本（JSON pages[].text 合并） */
async function ocrImageLocalSwift(imagePath: string): Promise<string> {
  const bin = ensureLocalOcrBinary();
  const { stdout } = await execFileAsync(bin, [imagePath], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
  try {
    const j = JSON.parse(stdout) as { pages?: Array<{ text?: string }> };
    return (j.pages ?? []).map((p) => p.text ?? '').join('\n').trim();
  } catch {
    return stdout.trim();
  }
}
