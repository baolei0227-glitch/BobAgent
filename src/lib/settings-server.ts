/**
 * 设置文件 I/O — 仅服务端/Electron 主进程使用
 *
 * 从 settings.ts 分离，避免浏览器打包时解析 fs/os/path 模块。
 *
 * 防丢失机制：
 *   1. 原子写：先写 .tmp 再 rename，避免写一半崩溃损坏配置文件
 *   2. 滚动备份：写入前保留 .settings.json.bak / .bak.1 ... .bak.4（共 5 份）
 *   3. 防覆盖保护：已有配置文件时，若传入配置带"读取失败标记"（version=0）
 *      或缺少 version，拒绝覆盖（防止空默认值清空真实配置）
 *   4. 读取失败返回 version=0 的标记配置，由上层决定是否允许写回
 */

import { promises as fs, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { defaultSettings, normalizeCustomThemes, type AppSettings } from './settings';
import { resolveAppRoot } from './app-root';
import { encryptSettings, decryptSettings, hasPlainSecrets } from './secrets';
import { sanitizeBaseUrl } from './types';
import { MCP_PRESETS, type McpServerConfig } from './mcp/types';

/** 清理所有 provider 的 baseUrl：去掉误存的端点后缀（如 .../images/generations），
 * 避免运行时/连接测试拼接端点后得到 .../images/generations/chat/completions → 404 */
function sanitizeProviderBaseUrls(settings: AppSettings): AppSettings {
  if (!Array.isArray(settings.providers)) return settings;
  for (const p of settings.providers) {
    if (p?.baseUrl) {
      const clean = sanitizeBaseUrl(p.baseUrl);
      if (clean !== p.baseUrl) p.baseUrl = clean;
    }
  }
  return settings;
}

/** 备份文件滚动上限（.settings.json.bak + .bak.1 ~ .bak.4 = 5 份） */
const BACKUP_MAX = 5;

/** 读取失败时写入的标记 version，用于防止被覆盖写回 */
const BROKEN_VERSION = 0;

function getSettingsFilePath(): string {
  return join(resolveAppRoot(), '.settings.json');
}

/**
 * 写前备份：把当前 .settings.json 滚动保留为 .settings.json.bak（最新）、.bak.1、.bak.2 ...
 * 最多保留 BACKUP_MAX 份。无现有文件时直接跳过。
 */
async function rotateSettingsBackup(root: string, filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }
  const base = join(root, '.settings.json.bak');
  // 先删最老（.bak.{BACKUP_MAX-1}），再从旧到新滚动，避免重名覆盖冲突
  const oldest = `${base}.${BACKUP_MAX - 1}`;
  await fs.rm(oldest, { force: true }).catch(() => {});
  for (let i = BACKUP_MAX - 2; i >= 0; i--) {
    const src = i === 0 ? base : `${base}.${i}`;
    const dst = i === 0 ? `${base}.1` : `${base}.${i + 1}`;
    await fs.rename(src, dst).catch(() => {});
  }
  await fs.copyFile(filePath, base);
}

/** 检查配置文件是否存在（供前端 migrate 判断，避免旧数据覆盖已有配置） */
export async function settingsFileExists(): Promise<boolean> {
  try {
    await fs.access(getSettingsFilePath());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 随包 MCP 插件路径解析
// 预置配置（MCP_PRESETS）里本地插件用 "{BUNDLED}:<rel>" 占位符，避免在客户端
// bundle（McpSettingsModal 引用 MCP_PRESETS）里引入 fs/path；本模块是 server-only，
// 在统一读取出口把占位符解析为运行环境的绝对路径：
//   安装版 cwd = next-standalone  → <cwd>/<rel>（插件随包分发）
//   dev 模式 cwd = projects       → <仓库根>/<rel>（插件在仓库根目录下）
// ---------------------------------------------------------------------------
const BUNDLED_PREFIX = '{BUNDLED}:';

/** 定位随包分发的本地 MCP 插件入口（多环境候选，均缺失时回退 cwd 候选） */
function bundledPluginPath(rel: string): string {
  const candidates: string[] = [];
  // Electron 主进程：GUI 应用 cwd 常为 /（resolve(cwd, rel) 会产出无意义的根路径），
  // 必须优先按资源目录定位，否则坏值经 IPC 返回渲染进程、随保存写回，永久污染占位符
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(join(resourcesPath, rel));
    candidates.push(join(resourcesPath, 'next-standalone', rel));
  }
  const cwdCandidate = resolve(process.cwd(), rel);
  candidates.push(cwdCandidate); // 安装版：Next standalone cwd = .../Resources/next-standalone
  candidates.push(resolve(process.cwd(), '..', rel)); // dev：插件在仓库根目录下
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return cwdCandidate;
}

/** 把 MCP 配置数组里的 {BUNDLED}: 占位符替换为绝对路径（/api/mcp/test 等接收外部原始 config 的入口也须调用） */
export function resolveBundledMcpPlaceholders(configs: McpServerConfig[]): McpServerConfig[] {
  if (!configs.some((c) => c.args?.some((a) => a.startsWith(BUNDLED_PREFIX)))) return configs;
  return configs.map((c) =>
    c.args?.some((a) => a.startsWith(BUNDLED_PREFIX))
      ? { ...c, args: c.args.map((a) => (a.startsWith(BUNDLED_PREFIX) ? bundledPluginPath(a.slice(BUNDLED_PREFIX.length)) : a)) }
      : c,
  );
}

/** bundledPluginPath 候选根目录的逆序表（更具体的前缀在前，保证还原出与预置一致的 rel） */
function bundledRootCandidates(): string[] {
  const roots: string[] = [];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    roots.push(join(resourcesPath, 'next-standalone'));
    roots.push(resourcesPath);
  }
  roots.push(process.cwd());
  roots.push(resolve(process.cwd(), '..'));
  return roots;
}

/** 从预置配置收集随包插件的相对入口（如 bob-team-mcp/dist/cli.js），用于跨环境识别被解析的占位符 */
function bundledRelCandidates(): string[] {
  const rels = new Set<string>();
  for (const c of MCP_PRESETS) {
    for (const a of c.args || []) {
      if (typeof a === 'string' && a.startsWith(BUNDLED_PREFIX)) rels.add(a.slice(BUNDLED_PREFIX.length));
    }
  }
  return [...rels];
}

/** 把已解析成绝对路径的随包插件参数还原为 {BUNDLED}: 占位符（写盘前归一化）。
 * 渲染进程拿到的永远是解析后的路径，若原样写回会永久污染占位符（磁盘上必须始终存占位符）。
 * 两层识别：① 当前环境候选根前缀 + 往返一致校验（防误伤用户自配路径）；
 * ② 预置 rel 后缀匹配（兜底跨环境残留，如 App 包内解析出的路径被带回 dev 保存）。 */
function unresolveBundledMcpPlaceholders(configs: McpServerConfig[]): McpServerConfig[] {
  if (!Array.isArray(configs)) return configs;
  const roots = bundledRootCandidates();
  const rels = bundledRelCandidates();
  let touched = false;
  const next = configs.map((c) => {
    if (!c?.args?.some((a) => typeof a === 'string' && (roots.some((r) => a.startsWith(r + '/')) || rels.some((rel) => a.endsWith('/' + rel))))) return c;
    touched = true;
    return {
      ...c,
      args: c.args.map((a) => {
        if (typeof a !== 'string') return a;
        for (const r of roots) {
          if (!a.startsWith(r + '/')) continue;
          const rel = a.slice(r.length + 1);
          return bundledPluginPath(rel) === a ? BUNDLED_PREFIX + rel : a;
        }
        for (const rel of rels) {
          if (a.endsWith('/' + rel)) return BUNDLED_PREFIX + rel;
        }
        return a;
      }),
    };
  });
  return touched ? next : configs;
}

/** 读取后统一应用随包路径解析 */
function resolveSettings(settings: AppSettings): AppSettings {
  const normalized = normalizeCustomThemes(sanitizeProviderBaseUrls(settings));
  return {
    ...normalized,
    mcpServers: resolveBundledMcpPlaceholders(normalized.mcpServers || []),
  };
}

export async function readSettingsFromFile(): Promise<AppSettings> {
  try {
    const APP_ROOT = resolveAppRoot();
    const filePath = getSettingsFilePath();
    // 迁移旧文件名 → 新隐藏文件名（默认根目录下，非默认根目录下不再迁移）
    const legacyDefault = join(homedir(), 'BobWork');
    if (APP_ROOT === legacyDefault) {
      const oldPath = join(APP_ROOT, 'settings.json');
      try {
        await fs.access(oldPath);
        try { await fs.access(filePath); } catch {
          await fs.rename(oldPath, filePath);
        }
      } catch { /* 旧文件不存在 */ }
    }
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged: AppSettings = { ...defaultSettings(), ...parsed, version: (typeof parsed.version === 'number' && parsed.version > 0) ? parsed.version : 1 };

    // 解密敏感字段；如果有明文，顺便回写成加密版（透明迁移）
    const decrypted = decryptSettings(merged);
    if (hasPlainSecrets(parsed)) {
      try {
        await writeSettingsToFile(decrypted);
      } catch { /* 回写失败不影响读取 */ }    }
    return resolveSettings(decrypted);
  } catch (err) {
    // 文件不存在（首次运行）：返回正常默认配置，允许后续保存创建文件
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return resolveSettings(defaultSettings());
    }
    // 读取失败（文件损坏/权限）：返回带标记的默认配置。
    // version=0 表示"读取异常"，writeSettingsToFile 会拒绝用它覆盖已有文件。
    console.warn('[settings] 读取 .settings.json 失败，返回空配置（version=0 标记）:', err);
    return resolveSettings({ ...defaultSettings(), version: BROKEN_VERSION });
  }
}

/**
 * 写入设置到 .settings.json
 *
 * 注意：当传入配置带"读取失败标记"（version=0）或缺少 version 时（防覆盖保护），
 * 本函数会抛出异常，调用方应感知并提示用户，而不是静默忽略。
 */
export async function writeSettingsToFile(settings: AppSettings): Promise<void> {
  const APP_ROOT = resolveAppRoot();
  await fs.mkdir(APP_ROOT, { recursive: true });
  const filePath = getSettingsFilePath();

  // 防覆盖保护：传入配置带"读取失败标记"（version=0）或缺少 version，
  // 说明上层可能读到了空默认值，拒绝写入，避免把毒数据写到文件
  if (typeof settings.version !== 'number' || settings.version === BROKEN_VERSION) {
    const msg =
      `拒绝写入 ${filePath}：传入配置 version=${String(settings.version)}（读取失败的空默认值）。` +
      '若配置文件损坏，请删除该文件后重试。';
    console.warn(`[settings] ${msg}`);
    throw new Error(msg);
  }

  // 写前滚动备份（原子写失败时也能从 .bak 恢复）
  await rotateSettingsBackup(APP_ROOT, filePath);

  // 占位符归一化：把读时解析出的绝对路径还原为 {BUNDLED}: 占位符再落盘，
  // 杜绝「解析值经渲染进程随保存写回」对占位符的永久污染
  const normalized: AppSettings = {
    ...settings,
    mcpServers: unresolveBundledMcpPlaceholders(settings.mcpServers || []),
  };
  const encrypted = encryptSettings(sanitizeProviderBaseUrls(normalized));
  // 原子写：先写临时文件再 rename，避免写一半崩溃损坏配置文件
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(encrypted, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}
