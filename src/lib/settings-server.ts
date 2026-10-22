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
import { defaultSettings, normalizeCustomThemes, DEFAULT_QUICK_PROMPTS, isSandboxFullTrust, resolveSandboxChatPermission, resolveSandboxGraphPermission, type AppSettings, type SandboxChatPermission, type SandboxGraphPermission, type SttSettings } from './settings';
import { resolveAppRoot } from './app-root';
import { encryptSettings, decryptSettings, hasPlainSecrets, hasLegacySecrets } from './secrets';
import { sanitizeBaseUrl } from './types';
import { MCP_PRESETS, DEFAULT_MCP_SERVERS, SYSTEM_MCP_IDS, type McpServerConfig } from './mcp/types';
import { LOCAL_STT_MODELS, isLocalSttBinaryInstalled, isLocalSttModelReady } from './stt/sherpa';

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
export function bundledPluginPath(rel: string): string {
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

// ---------------------------------------------------------------------------
// 单引擎单选迁移（2026-09-26）
//
// STT / TTS 从「云端为主 + 本地隐式兜底」改为「云端与本地互斥单选、不做自动回退」，
// 配置里的 localEnabled 字段已删除。老配置（localEnabled:true 且从未显式选过引擎）
// 升级后会直接报「未配置引擎」，语音输入 / 朗读静默失效——为不打断老用户，
// 这里把「曾经开启本地兜底」一次性固化为「显式选中本地引擎」：
//   STT → provider='sherpa-local' + 第一个已就绪的本地模型（引擎已装且模型文件齐全）
// 仅在本机本地引擎确实可用时才迁移；迁移后即删掉 localEnabled，故只生效一次。
// 已显式配过云端引擎（model / pool 非空）的配置一律不动。
// （TTS 侧迁移分支已随 macOS say 引擎下线一并移除，不再把老配置固化为某个本地引擎。）
// ---------------------------------------------------------------------------
async function migrateLegacyEngineSelection(settings: AppSettings): Promise<AppSettings> {
  const stt = settings.stt as (SttSettings & { localEnabled?: boolean }) | undefined;
  if (stt?.localEnabled === true && !stt.localModel && !stt.model && !stt.pool?.length) {
    const readyId = await firstReadyLocalSttModel();
    if (readyId) {
      delete stt.localEnabled; // 字段已下线：迁移后不再写回，保证只迁移一次
      stt.provider = 'sherpa-local';
      stt.model = undefined;
      stt.pool = [];
      stt.localModel = readyId;
    }
  }

  return settings;
}

/** 第一个「引擎已安装 + 模型文件齐全」的本地 STT 模型 id；都不就绪返回 null。
 *  只认 batch 能力：realtime 模型只服务实时链路，被选成批量转写引擎会直接报错。 */
async function firstReadyLocalSttModel(): Promise<string | null> {
  if (!(await isLocalSttBinaryInstalled())) return null;
  for (const def of LOCAL_STT_MODELS) {
    if (!def.capabilities.batch) continue;
    if (await isLocalSttModelReady(def.id)) return def.id;
  }
  return null;
}

/**
 * 系统随包插件的面板声明对齐出厂预置（出厂升级迁移，2026-10-19）。
 *
 * 面板形态会随版本演进（如 bob-notes 从「插件自起网页 serve，钉死 9480」改为
 * 「UI 由宿主静态托管、零端口 + hostPath 稳定反代」）。而实例配置里的 panel 是**旧版本写下
 * 的快照**，effectivePanel 又优先取实例配置 ⇒ 不对齐就让升级用户永远停在旧形态：
 * 面板 URL 仍挂在会漂移/易被占用的固定端口上 —— 正是「各机装好后插件面板打不开」的场景之一。
 *
 * 仅覆盖 SYSTEM_MCP_IDS（随包系统插件，属宿主自有的出厂能力）；
 * 市场/自定义插件（如 bob-video-shot-mcp）的 panel 属用户配置，一律不动。
 */
export function syncBundledPanelDecls(configs: McpServerConfig[]): McpServerConfig[] {
  let touched = false;
  const next = configs.map((c) => {
    if (!SYSTEM_MCP_IDS.includes(c.id)) return c;
    const presetPanel = MCP_PRESETS.find((p) => p.id === c.id)?.panel;
    if (!presetPanel) return c;
    if (c.panel && JSON.stringify(c.panel) === JSON.stringify(presetPanel)) return c;
    touched = true;
    return { ...c, panel: { ...presetPanel } };
  });
  return touched ? next : configs;
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

    // 系统随包插件自动装配（出厂升级）：既有配置缺失的新增 System MCP（如 bob-mind-mcp）
    // 自动补全为默认启用，不覆盖用户已保存的旧条目
    if (Array.isArray(merged.mcpServers)) {
      const existing = new Set(merged.mcpServers.map((s) => s.id));
      const missing = DEFAULT_MCP_SERVERS.filter((p) => !existing.has(p.id));
      if (missing.length > 0) {
        merged.mcpServers = [...merged.mcpServers, ...missing];
      }
      // 面板声明对齐预置（同上「出厂升级」口径）：旧版本写下的面板快照会挡住新形态生效，
      // 让升级用户自动拿到当前形态（如 bob-notes 的去端口化面板），无需手工改配置。
      merged.mcpServers = syncBundledPanelDecls(merged.mcpServers);
    }

    // 出厂快捷指令补全（同 MCP 口径）：已保存过 quickPrompts 的老配置里没有新增的出厂条目，
    // 缺失即补到末尾，不覆盖、不重排用户自己的条目（用户新增/改名的条目一律保持原样）。
    if (Array.isArray(merged.quickPrompts)) {
      const existingQuick = new Set(merged.quickPrompts.map((q) => q.id));
      const missingQuick = DEFAULT_QUICK_PROMPTS.filter((q) => !existingQuick.has(q.id));
      if (missingQuick.length > 0) {
        merged.quickPrompts = [...merged.quickPrompts, ...missingQuick];
      }
    }

    // 解密敏感字段；明文（老数据）或「历史机器指纹加密」的密文都顺手回写成主指纹加密版（透明迁移）
    const decrypted = decryptSettings(merged);
    if (hasPlainSecrets(parsed) || hasLegacySecrets(parsed)) {
      try {
        await writeSettingsToFile(decrypted);
      } catch { /* 回写失败不影响读取 */ }    }
    // 单引擎单选迁移：须在 resolveSettings 之前，保证 UI 与运行时读到同一份已迁移配置
    const migrated = await migrateLegacyEngineSelection(decrypted);
    return resolveSettings(migrated);
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

// ============================================================
// 出口脱敏 / 写回保护（2026-10-10 评估 P0-2）
//
// 背景：`GET /api/settings` 返回**解密后**的设置，里面有 providers[].apiKey、mcpServers[].env、
// remoteAccess.token 等明文；读权限只有 loopback Host 校验 —— 而同源的小程序预览页也是 loopback，
// 于是任何小程序都能 fetch 到全部密钥。这里做两层缓解（真正的边界仍是同源隔离，见设计方案）：
//   1. GET 出口把密钥字段替换成掩码常量（UI 只需知道"已配置"）；
//   2. PUT 收到掩码/空值时**保留磁盘上的旧值**，避免 UI 把掩码写回、把真 Key 抹掉。
// ============================================================

/** 密钥掩码（前端拿到这个值表示"已配置"，原值不会出服务端） */
export const SECRET_MASK = '••••••••';

/** 字段名命中即视为密钥（大小写不敏感） */
const SECRET_FIELD_RE = /^(apikey|password|token|accesstoken|apisecret|clientsecret|secret)$/i;
/** 这些字段是"值即密钥"的字典（MCP 的 env / headers） */
const SECRET_MAP_FIELDS = new Set(['env', 'headers']);

function mapSecrets<T>(value: T, mode: 'mask' | 'preserve', stored: unknown): T {
  if (Array.isArray(value)) {
    const storedArr = Array.isArray(stored) ? stored : [];
    return value.map((v, i) => mapSecrets(v, mode, storedArr[i])) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const storedObj = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_RE.test(k) && typeof v === 'string') {
        if (mode === 'mask') {
          out[k] = v ? SECRET_MASK : v;
        } else {
          const prev = storedObj[k];
          // 掩码或空值 → 保留旧值；否则按用户输入
          out[k] = (v === '' || v === SECRET_MASK) && typeof prev === 'string' && prev ? prev : v;
        }
        continue;
      }
      if (SECRET_MAP_FIELDS.has(k) && v && typeof v === 'object') {
        const prevMap = (storedObj[k] && typeof storedObj[k] === 'object' ? storedObj[k] : {}) as Record<string, unknown>;
        const nextMap: Record<string, unknown> = {};
        for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
          if (typeof mv !== 'string') { nextMap[mk] = mapSecrets(mv, mode, prevMap[mk]); continue; }
          if (mode === 'mask') nextMap[mk] = mv ? SECRET_MASK : mv;
          else {
            const prev = prevMap[mk];
            nextMap[mk] = (mv === '' || mv === SECRET_MASK) && typeof prev === 'string' && prev ? prev : mv;
          }
        }
        out[k] = nextMap;
        continue;
      }
      out[k] = mapSecrets(v, mode, storedObj[k]);
    }
    return out as unknown as T;
  }
  return value;
}

/** GET 出口脱敏：密钥字段 → 掩码常量（结构不变，UI 无需改） */
export function maskSettingsSecrets(settings: AppSettings): AppSettings {
  return mapSecrets(settings, 'mask', null);
}

/** PUT 写回保护：incoming 里的掩码/空密钥 → 用磁盘上的旧值补齐 */
export function preserveStoredSecrets(incoming: AppSettings, stored: AppSettings): AppSettings {
  return mapSecrets(incoming, 'preserve', stored);
}

let sandboxSecretCache: { at: number; value: string } | null = null;
const SANDBOX_SECRET_TTL_MS = 60_000;

/**
 * 小程序桥签名密钥（2026-10-10）：读不到就生成一个并落盘。
 * 缓存 60s，避免每个桥请求都读文件；`rotateSandboxBridgeSecret()` 会立刻失效缓存。
 */
export async function getSandboxBridgeSecret(): Promise<string> {
  const now = Date.now();
  if (sandboxSecretCache && now - sandboxSecretCache.at < SANDBOX_SECRET_TTL_MS) return sandboxSecretCache.value;
  const settings = await readSettingsFromFile();
  let secret = typeof settings.sandboxBridgeSecret === 'string' ? settings.sandboxBridgeSecret : '';
  if (!secret) {
    const { randomBytes } = await import('crypto');
    secret = randomBytes(32).toString('base64url');
    settings.sandboxBridgeSecret = secret;
    await writeSettingsToFile(settings);
  }
  sandboxSecretCache = { at: now, value: secret };
  return secret;
}

/** 轮换密钥（所有已签发的页面令牌立即失效；需要用户刷新预览页） */
export async function rotateSandboxBridgeSecret(): Promise<string> {
  const settings = await readSettingsFromFile();
  const { randomBytes } = await import('crypto');
  const secret = randomBytes(32).toString('base64url');
  settings.sandboxBridgeSecret = secret;
  await writeSettingsToFile(settings);
  sandboxSecretCache = { at: Date.now(), value: secret };
  return secret;
}

/**
 * 小程序权限的**服务端**读取（2026-10-10 修复「每次都要询问」的根因之一）。
 *
 * lib/settings.ts 的 loadSettings() 在 Node 端没有 window/Electron IPC，会退化为
 * defaultSettings()（空配置）—— 于是桥里的 chatGetPermission / 预览页徽标永远读到"未授权"，
 * 小程序就会一次次申请授权。服务端（桥、预览路由、模型闸）必须走读文件这条路径。
 */
export async function getSandboxChatPermissionServer(appId: string): Promise<SandboxChatPermission> {
  if (!appId) return 'none';
  const settings = await readSettingsFromFile();
  return resolveSandboxChatPermission(settings, appId);
}

/** 服务端读取某小程序的画布对接授权级别（完全信任下默认 'control'） */
export async function getSandboxGraphPermissionServer(appId: string): Promise<SandboxGraphPermission> {
  if (!appId) return 'none';
  const settings = await readSettingsFromFile();
  return resolveSandboxGraphPermission(settings, appId);
}

/** 服务端读取全局「完全信任」开关（缺省 = 放开） */
export async function isSandboxFullTrustServer(): Promise<boolean> {
  const settings = await readSettingsFromFile();
  return isSandboxFullTrust(settings);
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
