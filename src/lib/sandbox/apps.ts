/**
 * Bob Sandbox 小程序清单管理（服务端）
 *
 * 小程序存储于 {appRoot}/bob-sandbox/apps/<appId>/ 目录：
 *   - manifest.json：清单（id/name/description/entry/时间戳）
 *   - index.html 等：入口文件（静态小程序，直接由 preview 接口返回）
 * 节点 AI 可通过 write_file（绝对/相对路径）修改这些文件实现 coding 迭代。
 */

import { join, dirname, basename, sep, resolve } from 'path';
import { mkdir, readdir, readFile, writeFile, rm, rename, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { APP_TEMPLATES, SANDBOX_TEMPLATE_ICONS, SMOKE_TEST_JS, type SandboxTemplateId } from './templates';

export interface SandboxApp {
  id: string;
  name: string;
  description: string;
  /** 卡片图标：一个 emoji 或 1-2 个字符（缺省用名称首字） */
  icon?: string;
  createdAt: string;
  updatedAt: string;
  /** 入口文件名（默认 index.html） */
  entry: string;
  /** 是否在小程序预览右上角自动注入 AI 状态指示器。
   *  @deprecated 2026-10-10「放开小程序权限」起宿主不再注入 AI 徽章，本字段已无效果（保留仅为兼容旧清单）。 */
  aiBadge?: boolean;
  /** manifest 结构版本（2026-10-10 评估 P2-16）：缺失视作 1，读时归一，写回时带上。
   *  为将来的字段迁移留锚点（此前完全没有版本号，改结构只能靠"容错读取"）。 */
  schemaVersion?: number;
  /** 来源/信任分级（2026-10-10 评估 A5）：
   *  - 'built'（默认，旧清单缺省视作 built）：宿主自己新建/迭代的小程序，hostTool 全量可用；
   *  - 'imported'：用户导入的第三方 ZIP，hostTool 只给只读工具且只能读自己目录。 */
  origin?: 'built' | 'imported';
}

/** 当前 manifest 结构版本 */
export const APP_SCHEMA_VERSION = 1;

/** 读时归一：缺 schemaVersion 的旧清单按 1 处理（不落盘，下一次写入时带上） */
export function normalizeAppManifest(mf: SandboxApp): SandboxApp {
  return {
    ...mf,
    schemaVersion: typeof mf.schemaVersion === 'number' && mf.schemaVersion > 0 ? mf.schemaVersion : APP_SCHEMA_VERSION,
    // 旧清单没有 origin：一律视作 built（自己建的），只有导入包才标记 imported
    origin: mf.origin === 'imported' ? 'imported' : 'built',
  };
}

/**
 * appId 白名单：仅 `[A-Za-z0-9_-]{1,64}`。
 *
 * 为什么必须中央化（2026-10-10 安全修复）：`DELETE /api/sandbox` 曾把 body.id 直接交给
 * `join(appsRoot, id)` + `rm(recursive,force)`，`id:"../../"` 即 `~/BobWork` —— 一条请求删除
 * 用户全部数据。export/import/appDataDir 早就有同类清洗，只有这里漏了。
 * 注意不能收得太紧（只认 `app_xxx_yyy`）：早期导入的小程序可能是别的形状，且 `.`/`/` 才是穿越要素。
 */
export function sanitizeAppId(id: unknown): string | null {
  const s = String(id ?? '').trim();
  if (!s || s.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

/** 子路径包含性校验：rel 必须落在 appDir 内（拒绝绝对路径、`..`、空字节）。非法返回 null。 */
export function safeChildPath(appDir: string, rel: unknown): string | null {
  const r = String(rel ?? '').trim();
  if (!r || r.includes('\0')) return null;
  const base = resolve(appDir);
  const target = resolve(base, r);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/** 小程序是否真实存在（有可读 manifest）。桥/流式路由的存在性闸与删除后 410 都靠它。 */
export async function appExists(id: unknown): Promise<boolean> {
  return (await readAppManifest(id)) !== null;
}

/** 读小程序 manifest（不做任何 entry 读取）；不存在/非法返回 null */
export async function readAppManifest(id: unknown): Promise<SandboxApp | null> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return null;
  try {
    const raw = await readFile(join(appsRoot(), safeId, 'manifest.json'), 'utf-8');
    const mf = JSON.parse(raw) as SandboxApp;
    return typeof mf?.id === 'string' && mf.id.length > 0 ? normalizeAppManifest(mf) : null;
  } catch {
    return null;
  }
}

/** 该小程序的信任分级：缺省（旧清单）= 'built' */
export async function appOriginOf(id: unknown): Promise<'built' | 'imported'> {
  const mf = await readAppManifest(id);
  return mf?.origin === 'imported' ? 'imported' : 'built';
}

function appsRoot(): string {
  return join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');
}

async function ensureAppsRoot(): Promise<string> {
  const root = appsRoot();
  await mkdir(root, { recursive: true });
  return root;
}

/** 列出全部小程序（按创建时间倒序） */
export async function listApps(): Promise<SandboxApp[]> {
  const root = await ensureAppsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const apps: SandboxApp[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const mf = JSON.parse(await readFile(join(root, e.name, 'manifest.json'), 'utf-8')) as SandboxApp;
      if (mf && typeof mf.id === 'string') apps.push(normalizeAppManifest(mf));
    } catch {
      // 无 manifest 或损坏：跳过
    }
  }
  return apps.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 新建小程序：写入 manifest + 模板文件 */
export async function createApp(name: string, template: SandboxTemplateId = 'blank'): Promise<SandboxApp> {
  const tpl = APP_TEMPLATES[template] ?? APP_TEMPLATES.blank;
  const now = new Date().toISOString();
  const id = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(await ensureAppsRoot(), id);
  await mkdir(dir, { recursive: true });
  const app: SandboxApp = {
    id,
    name: name.trim() || 'Untitled App',
    description: tpl.description,
    createdAt: now,
    updatedAt: now,
    entry: tpl.entry,
    // 模板默认图标（emoji）：新建即带上，用户可在卡片编辑弹窗里改
    icon: SANDBOX_TEMPLATE_ICONS[tpl.id],
    origin: 'built',
    schemaVersion: APP_SCHEMA_VERSION,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(app, null, 2), 'utf-8');
  for (const [fname, content] of Object.entries(tpl.files)) {
    await writeFile(join(dir, fname), content, 'utf-8');
  }
  // 黄金脚手架：模板不带 smoke-test.js 时补一份通用冒烟脚本。
  // coding 提示会要求用它做交付前最小自检；模板自带专用脚本（如 AI Chat）时不覆盖。
  if (!('smoke-test.js' in tpl.files)) {
    await writeFile(join(dir, 'smoke-test.js'), SMOKE_TEST_JS, 'utf-8');
  }
  return app;
}

/** 一个历史版本条目（.history/<相对目录>/<stamp>-<file>）。 */
export interface AppHistoryEntry {
  stamp: string;
  file: string;
  size: number;
}

/** 复制一个小程序（remix）：复制代码文件，跳过 data/ 与 .history/，生成新 id/名称。 */
export async function duplicateApp(sourceId: string, name?: string): Promise<SandboxApp | null> {
  const safeId = sanitizeAppId(sourceId);
  if (!safeId) return null;
  const root = await ensureAppsRoot();
  const srcDir = join(root, safeId);
  try {
    const mf = normalizeAppManifest(JSON.parse(await readFile(join(srcDir, 'manifest.json'), 'utf-8')) as SandboxApp);
    const now = new Date().toISOString();
    const newId = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const dstDir = join(root, newId);
    await mkdir(dstDir, { recursive: true });
    const copyDir = async (src: string, dst: string): Promise<void> => {
      const entries = await readdir(src, { withFileTypes: true });
      const isRoot = src === srcDir;
      for (const e of entries) {
        // 只在根层跳过私有数据 / 历史版本 / 回收站 / 清单（清单最后重写）；
        // 子目录里同名的资源文件要保留，否则 remix 会丢资产。
        if (isRoot && (e.name === 'data' || e.name === '.history' || e.name === '.trash' || e.name === '.state' || e.name === 'manifest.json')) continue;
        const from = join(src, e.name);
        const to = join(dst, e.name);
        if (e.isDirectory()) {
          await mkdir(to, { recursive: true });
          await copyDir(from, to);
        } else if (e.isFile()) {
          await writeFile(to, await readFile(from));
        }
      }
    };
    await copyDir(srcDir, dstDir);
    const app: SandboxApp = {
      ...mf,
      id: newId,
      name: (name?.trim() || `${mf.name} 副本`).slice(0, 80),
      createdAt: now,
      updatedAt: now,
      // 第三方导入代码的权限级别必须跟着走，不能因复制洗白
      origin: mf.origin === 'imported' ? 'imported' : 'built',
      schemaVersion: APP_SCHEMA_VERSION,
    };
    await writeFile(join(dstDir, 'manifest.json'), JSON.stringify(app, null, 2), 'utf-8');
    try {
      await readFile(join(dstDir, 'smoke-test.js'));
    } catch {
      await writeFile(join(dstDir, 'smoke-test.js'), SMOKE_TEST_JS, 'utf-8');
    }
    return app;
  } catch {
    return null;
  }
}

/** 更新展示元数据（名称/描述/图标）；不改 id、不改代码。 */
export async function updateAppMeta(
  id: string,
  patch: { name?: string; description?: string; icon?: string },
): Promise<SandboxApp | null> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return null;
  const dir = join(await ensureAppsRoot(), safeId);
  try {
    const mf = normalizeAppManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8')) as SandboxApp);
    if (typeof patch.name === 'string' && patch.name.trim()) mf.name = patch.name.trim().slice(0, 80);
    if (typeof patch.description === 'string') mf.description = patch.description.slice(0, 300);
    if (typeof patch.icon === 'string') mf.icon = patch.icon.trim().slice(0, 8) || undefined;
    mf.updatedAt = new Date().toISOString();
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(mf, null, 2), 'utf-8');
    return mf;
  } catch {
    return null;
  }
}

// ── Layer 1（BobStorage.set/get）在应用内预览的持久化代理 ──
// iframe 是 opaque origin，localStorage 不可用；把 set/get 的键值镜像到 app 私有的
// .state/local-storage.json，预览路由启动时内联快照，bridge 写入时由宿主回传落盘。
const LOCAL_STATE_MAX_BYTES = 500 * 1024;
const LOCAL_STATE_MAX_VALUE = 100 * 1024;
const LOCAL_STATE_MAX_KEY = 300;
const LOCAL_STATE_MAX_ENTRIES = 200;

function localStateFile(appDir: string): string {
  return join(appDir, '.state', 'local-storage.json');
}

function isSafeLocalStateKey(key: unknown): key is string {
  return typeof key === 'string'
    && key.length > 0
    && key.length <= LOCAL_STATE_MAX_KEY
    && !/[\u0000-\u001f]/.test(key);
}

/** 读取 app 的 Layer-1 持久化快照（只返回字符串键值，总量上限 500KB）。 */
export async function readAppLocalStorage(id: string): Promise<Record<string, string>> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return {};
  const appDir = join(await ensureAppsRoot(), safeId);
  try {
    const raw = JSON.parse(await readFile(localStateFile(appDir), 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    let total = 0;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isSafeLocalStateKey(key) || typeof value !== 'string') continue;
      if (value.length > LOCAL_STATE_MAX_VALUE) continue;
      const size = key.length + value.length;
      if (total + size > LOCAL_STATE_MAX_BYTES) continue;
      out[key] = value;
      total += size;
    }
    return out;
  } catch {
    return {};
  }
}

/** 合并写入 Layer-1 快照；value=null 表示删除。 */
export async function writeAppLocalStorage(
  id: string,
  entries: Array<{ key: string; value: string | null }>,
): Promise<boolean> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return false;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > LOCAL_STATE_MAX_ENTRIES) return false;
  const appDir = join(await ensureAppsRoot(), safeId);
  try {
    // app 必须真实存在
    await readFile(join(appDir, 'manifest.json'), 'utf-8');
    const current = await readAppLocalStorage(safeId);
    let applied = 0;
    for (const entry of entries) {
      if (!entry || !isSafeLocalStateKey(entry.key)) continue;
      if (entry.value === null) {
        delete current[entry.key];
        applied += 1;
        continue;
      }
      if (typeof entry.value !== 'string' || entry.value.length > LOCAL_STATE_MAX_VALUE) continue;
      current[entry.key] = entry.value;
      applied += 1;
    }
    if (applied === 0) return false;
    let total = 0;
    const capped: Record<string, string> = {};
    for (const [key, value] of Object.entries(current)) {
      const size = key.length + value.length;
      if (total + size > LOCAL_STATE_MAX_BYTES) continue;
      capped[key] = value;
      total += size;
    }
    await mkdir(join(appDir, '.state'), { recursive: true });
    await writeFile(localStateFile(appDir), JSON.stringify(capped), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 历史版本文件名：<ISO 时间戳，冒号/点替换为 ->-<原文件名> */
function parseHistoryBase(base: string): { stamp: string; filename: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/.exec(base);
  return m ? { stamp: m[1], filename: m[2] } : null;
}

/** 列出小程序文件的历史版本（新 → 旧）。 */
export async function listAppHistory(id: string): Promise<AppHistoryEntry[]> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return [];
  const appDir = join(await ensureAppsRoot(), safeId);
  const out: AppHistoryEntry[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
        continue;
      }
      if (!e.isFile()) continue;
      const parsed = parseHistoryBase(e.name);
      if (!parsed) continue;
      const st = await stat(join(dir, e.name)).catch(() => null);
      out.push({
        stamp: parsed.stamp,
        file: rel ? `${rel}/${parsed.filename}` : parsed.filename,
        size: st?.size ?? 0,
      });
    }
  };
  await walk(join(appDir, '.history'), '');
  return out.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/** 恢复某个文件的历史版本（走 writeAppFileAtomic，会在恢复前再备份当前版本）。 */
export async function restoreAppHistory(id: string, file: string, stamp: string): Promise<boolean> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(stamp)) return false;
  const appDir = join(await ensureAppsRoot(), safeId);
  if (!safeChildPath(appDir, file)) return false;
  try {
    const content = await readFile(join(appDir, '.history', dirname(file), `${stamp}-${basename(file)}`), 'utf-8');
    return await writeAppFileAtomic(id, file, content);
  } catch {
    return false;
  }
}

/** 硬删除小程序目录（不可恢复；日常删除请用 trashApp，见文件末尾回收站）。非法 id 一律拒绝。 */
export async function removeApp(id: string): Promise<boolean> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return false;
  const dir = join(await ensureAppsRoot(), safeId);
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** 读取小程序入口文件内容；不存在返回 null */
export async function readAppEntry(id: string): Promise<{ app: SandboxApp; content: string } | null> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return null;
  const root = await ensureAppsRoot();
  const appDir = join(root, safeId);
  try {
    const mf = JSON.parse(await readFile(join(appDir, 'manifest.json'), 'utf-8')) as SandboxApp;
    // manifest.entry 也可能被构造成 "../../../.settings.json"（导入的 ZIP 不校验该字段）→ 必须包含性复核
    const entryPath = safeChildPath(appDir, mf.entry || 'index.html');
    if (!entryPath) return null;
    const content = await readFile(entryPath, 'utf-8');
    return { app: mf, content };
  } catch {
    return null;
  }
}

/**
 * 判断小程序是否已有真实实现（而非仅停留在内置模板初始状态）。
 *
 * 判定规则：入口文件内容与全部内置模板的初始内容逐一比对——
 * 若与某个模板完全一致 → 尚未定制，视为"从零新建"；否则视为"已有实现"（修改场景）。
 * 目录读取失败/无 manifest 一律返回 false（保守按"无实现"处理，走首轮 Spec 采集）。
 *
 * 用途：Coding 节点首轮判定——新建节点修改已有小程序时跳过 Spec 采集，
 * 避免"新节点 + 已有实现"被误判为从零开发而强制弹需求表单。
 */
export async function hasAppImplementation(id: string): Promise<boolean> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return false;
  const root = await ensureAppsRoot();
  const dir = join(root, safeId);
  try {
    const mf = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8')) as SandboxApp;
    const entry = mf.entry || 'index.html';
    const entryPath = safeChildPath(dir, entry);
    if (!entryPath) return false;
    const content = await readFile(entryPath, 'utf-8');
    for (const tpl of Object.values(APP_TEMPLATES)) {
      const tplContent = (tpl.files as Record<string, string>)[entry];
      if (typeof tplContent === 'string' && content === tplContent) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取小程序目录内任意文件（支持子目录），供静态文件服务路由使用。
 * @param id 小程序 appId
 * @param relPath 相对 <appId>/ 的路径（如 css/style.css），允许含子目录，禁止 ../ 穿越
 * @returns 文件内容 Buffer；路径穿越或文件不存在返回 null
 */
export async function readAppFile(
  id: string,
  relPath: string,
): Promise<Buffer | null> {
  if (!relPath) return null;
  const safeId = sanitizeAppId(id);
  if (!safeId) return null;
  const root = await ensureAppsRoot();
  const appDir = join(root, safeId);
  const target = safeChildPath(appDir, relPath);
  if (!target) return null;
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

/** 更新小程序入口文件内容（AI 编辑器实时保存用） */
export async function updateAppEntry(id: string, content: string): Promise<boolean> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return false;
  const root = await ensureAppsRoot();
  const appDir = join(root, safeId);
  try {
    const mfPath = join(appDir, 'manifest.json');
    const mf = JSON.parse(await readFile(mfPath, 'utf-8')) as SandboxApp;
    const entryPath = safeChildPath(appDir, mf.entry || 'index.html');
    if (!entryPath) return false;
    await writeFile(entryPath, content, 'utf-8');
    // 更新时间戳
    mf.updatedAt = new Date().toISOString();
    await writeFile(mfPath, JSON.stringify(mf, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 同步小程序 manifest.updatedAt 为当前时间。
 * 供 write_file 等直接写盘路径在写入 .sandbox/apps/<appId>/ 后调用，
 * 保证 manifest 与 entry 文件保持一致，避免宿主一致性校验误判为"外部修改"而重置小程序。
 * @param id 小程序 appId（.sandbox/apps/ 下的目录名）
 */
export async function touchAppUpdatedAt(id: string): Promise<boolean> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return false;
  const root = await ensureAppsRoot();
  try {
    const mfPath = join(root, safeId, 'manifest.json');
    const mf = JSON.parse(await readFile(mfPath, 'utf-8')) as SandboxApp;
    if (!mf || typeof mf.id !== 'string') return false;
    mf.updatedAt = new Date().toISOString();
    await writeFile(mfPath, JSON.stringify(mf, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 每个小程序历史版本保留上限（保留最近 5 份，超出时覆盖最旧的一份） */
const HISTORY_KEEP = 5;

/** 单文件写入上限与单 app 目录总量上限（2026-10-10 评估 P1-5：原来只有 BobStorage 的 data/ 有配额） */
export const APP_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const APP_TOTAL_QUOTA_BYTES = 50 * 1024 * 1024;

/** 纯函数：配额判定（便于单测）。previousFileBytes = 被覆盖文件的当前大小 */
export function checkAppQuota(input: {
  fileBytes: number;
  currentTotalBytes: number;
  previousFileBytes: number;
}): { ok: boolean; reason?: string } {
  if (input.fileBytes > APP_FILE_MAX_BYTES) {
    return { ok: false, reason: `single file exceeds ${Math.floor(APP_FILE_MAX_BYTES / 1024 / 1024)}MB` };
  }
  const projected = input.currentTotalBytes - Math.max(0, input.previousFileBytes) + input.fileBytes;
  if (projected > APP_TOTAL_QUOTA_BYTES) {
    return { ok: false, reason: `app directory would exceed ${Math.floor(APP_TOTAL_QUOTA_BYTES / 1024 / 1024)}MB` };
  }
  return { ok: true };
}

/** 递归统计目录体积（失败按 0 计，绝不抛） */
async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) total += await dirSizeBytes(full);
    else if (e.isFile()) {
      try { total += (await stat(full)).size; } catch { /* ignore */ }
    }
  }
  return total;
}

/** 解析历史备份文件名 `<stamp>-<filename>`；不匹配返回 null。
 *  修复：原来用 `endsWith('-' + filename)`，同目录下 app.js 会把 my-app.js 的备份也算进来
 *  （pruneHistory 误删别的文件的历史；回滚 list 也会列出无关版本）。 */
export function parseHistoryName(name: string, filename: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.*)$/.exec(name);
  if (!m || m[2] !== filename) return null;
  return m[1];
}

/**
 * 原子写入小程序文件 + 版本回滚 + 同步 manifest.updatedAt。
 *
 * 相比直接 writeFile，本函数提供三重保障：
 *  1. 原子写入：先写临时文件再 rename，避免写入中途崩溃留下半截文件；
 *  2. 版本回滚：写入前把旧内容备份到 .history/，宿主检测到损坏时可回退到最近有效版本，而非清空；
 *  3. 一致性：写盘后同步 manifest.updatedAt，保证 manifest 与文件状态一致，避免宿主误判重置。
 *
 * 小程序作为 BobWork 功能组件应完全开放：允许小程序目录内任意多级子路径/任意命名文件
 * （如 css/style.css、js/app.js），仅需落在 <appId>/ 目录内并杜绝 ../ 等路径穿越。
 * @param id 小程序 appId
 * @param relPath 相对 <appId>/ 的路径（如 index.html、css/style.css），允许含子目录，禁止 ../ 穿越
 * @param content 新内容
 * @returns 成功返回 true；文件不在小程序目录内、路径穿越或写入失败返回 false
 */
export async function writeAppFileAtomic(
  id: string,
  relPath: string,
  content: string,
): Promise<boolean> {
  // 空路径或路径穿越（引导到 appDir 之外）拒绝
  if (!relPath) return false;
  const safeId = sanitizeAppId(id);
  if (!safeId) return false;
  const root = await ensureAppsRoot();
  const appDir = join(root, safeId);
  // 穿越校验：target 必须仍落在 appDir 内（safeChildPath 统一实现）
  const target = safeChildPath(appDir, relPath);
  if (!target) return false;
  try {
    // 校验小程序存在（manifest 可读）
    const mfPath = join(appDir, 'manifest.json');
    const mf = JSON.parse(await readFile(mfPath, 'utf-8')) as SandboxApp;
    if (!mf || typeof mf.id !== 'string') return false;

    // 配额：单文件 + 单 app 目录总量（原实现完全不检查，入口 HTML/资产可写满磁盘）
    const incomingBytes = Buffer.byteLength(content, 'utf8');
    let previousBytes = 0;
    try { previousBytes = (await stat(target)).size; } catch { previousBytes = 0; }
    const quota = checkAppQuota({
      fileBytes: incomingBytes,
      currentTotalBytes: await dirSizeBytes(appDir),
      previousFileBytes: previousBytes,
    });
    if (!quota.ok) return false;

    // —— 版本回滚：写入前把旧内容备份到 .history/<相对路径>/ ——
    let oldContent: string | null = null;
    try {
      oldContent = await readFile(target, 'utf-8');
    } catch {
      oldContent = null; // 目标文件尚不存在
    }
    if (oldContent !== null && oldContent !== content) {
      // 历史备份保留相对路径目录结构，避免不同子目录文件互相覆盖
      const historyDir = join(appDir, '.history', dirname(relPath));
      await mkdir(historyDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(join(historyDir, `${stamp}-${basename(relPath)}`), oldContent, 'utf-8');
      // 裁剪历史，仅保留最近 HISTORY_KEEP 份
      await pruneHistory(historyDir, basename(relPath));
    }

    // —— 原子写入：先临时文件再 rename ——
    const parentDir = dirname(target);
    if (parentDir && parentDir !== appDir) await mkdir(parentDir, { recursive: true });
    // tmp 必须唯一且与目标同目录：原来 `.{basename}.{pid}.tmp` 落在 app 根、只用 pid，
    // 并发写 css/style.css 与 js/style.css 会撞名互相覆盖；写失败还会残留 tmp
    // 被静态路由当普通资源返回、并被打进导出包（2026-10-10 评估 P1-4）。
    const tmp = join(parentDir, `.${basename(relPath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    try {
      await writeFile(tmp, content, 'utf-8');
      await rename(tmp, target);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }

    // —— 同步 manifest.updatedAt ——
    mf.updatedAt = new Date().toISOString();
    await writeFile(mfPath, JSON.stringify(mf, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 清理某文件的历史版本，仅保留最近的 HISTORY_KEEP 份 */
async function pruneHistory(historyDir: string, filename: string): Promise<void> {
  try {
    const entries = await readdir(historyDir, { withFileTypes: true });
    // 精确匹配 "<timestamp>-<filename>"（不能用 endsWith：app.js 会命中 my-app.js 的备份）
    const matched = entries
      .filter((e) => e.isFile() && parseHistoryName(e.name, filename) !== null)
      .map((e) => e.name)
      .sort(); // 时间戳前缀按字典序即时间序
    const excess = matched.length - HISTORY_KEEP;
    if (excess > 0) {
      for (const name of matched.slice(0, excess)) {
        await rm(join(historyDir, name), { force: true });
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
}

// ==================== 回收站（2026-10-10 新增） ====================
// 背景：删除小程序原为 rm -rf（不可逆、无回收站），而 ~/BobWork 是唯一副本。
// 现在「删除」= 移入 bob-sandbox/.trash/<appId>__<ts36>/，商城可恢复或彻底删除。

const TRASH_DIRNAME = '.trash';

export interface TrashItem {
  /** 回收站条目名（恢复/彻底删除的句柄） */
  trashId: string;
  appId: string;
  name: string;
  deletedAt: string;
}

function trashRoot(): string {
  return join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, TRASH_DIRNAME);
}

/** 合法回收站条目名（构造时只用 [A-Za-z0-9_-]，读取时同样校验） */
function sanitizeTrashId(id: unknown): string | null {
  const s = String(id ?? '').trim();
  if (!s || s.length > 96) return null;
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

/** 把小程序移入回收站。返回 { ok, trashId }；appId 非法或不存在时 ok=false。 */
export async function trashApp(id: unknown): Promise<{ ok: boolean; trashId?: string; appId?: string; reason?: string }> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return { ok: false, reason: 'invalid appId' };
  const root = await ensureAppsRoot();
  const src = join(root, safeId);
  try {
    await stat(join(src, 'manifest.json'));
  } catch {
    return { ok: false, reason: 'app not found' };
  }
  const trashId = `${safeId}__${Date.now().toString(36)}`;
  const dest = join(trashRoot(), trashId);
  try {
    await mkdir(trashRoot(), { recursive: true });
    await rename(src, dest);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  // 侧车元信息：即使 manifest 被删也能在回收站列表里显示名字
  try {
    const mf = JSON.parse(await readFile(join(dest, 'manifest.json'), 'utf-8')) as SandboxApp;
    await writeFile(
      join(dest, 'trash-meta.json'),
      JSON.stringify({ appId: safeId, name: mf?.name ?? safeId, deletedAt: new Date().toISOString() }, null, 2),
      'utf-8',
    );
  } catch { /* 元信息写失败不影响删除 */ }
  return { ok: true, trashId, appId: safeId };
}

/** 列出回收站条目（按删除时间倒序） */
export async function listTrash(): Promise<TrashItem[]> {
  const root = trashRoot();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const items: TrashItem[] = [];
  for (const name of entries) {
    const trashId = sanitizeTrashId(name);
    if (!trashId) continue;
    const dir = join(root, trashId);
    let appId = trashId.split('__')[0] ?? trashId;
    let appName = appId;
    let deletedAt = '';
    try {
      const meta = JSON.parse(await readFile(join(dir, 'trash-meta.json'), 'utf-8')) as Partial<TrashItem>;
      if (meta.appId) appId = String(meta.appId);
      if (meta.name) appName = String(meta.name);
      if (meta.deletedAt) deletedAt = String(meta.deletedAt);
    } catch {
      try {
        const mf = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8')) as SandboxApp;
        if (mf?.name) appName = mf.name;
      } catch { /* 忽略 */ }
    }
    // 时间兜底：trashId 尾段是 base36 时间戳
    if (!deletedAt) {
      const ts = trashId.split('__')[1];
      const ms = ts ? parseInt(ts, 36) : NaN;
      deletedAt = Number.isFinite(ms) ? new Date(ms).toISOString() : '';
    }
    items.push({ trashId, appId, name: appName, deletedAt });
  }
  return items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
}

/** 从回收站恢复小程序；同名小程序已存在时拒绝（不覆盖） */
export async function restoreApp(trashId: unknown): Promise<{ ok: boolean; appId?: string; reason?: string }> {
  const safeTrashId = sanitizeTrashId(trashId);
  if (!safeTrashId) return { ok: false, reason: 'invalid trashId' };
  const root = await ensureAppsRoot();
  const src = join(trashRoot(), safeTrashId);
  try {
    await stat(src);
  } catch {
    return { ok: false, reason: 'trash item not found' };
  }
  let appId = safeTrashId.split('__')[0] ?? safeTrashId;
  try {
    const meta = JSON.parse(await readFile(join(src, 'trash-meta.json'), 'utf-8')) as { appId?: string };
    if (meta?.appId) appId = String(meta.appId);
  } catch { /* 用 trashId 前缀兜底 */ }
  const safeAppId = sanitizeAppId(appId);
  if (!safeAppId) return { ok: false, reason: 'invalid appId in trash item' };
  const dest = join(root, safeAppId);
  try {
    await stat(dest);
    return { ok: false, reason: `同名小程序已存在（${safeAppId}），请先重命名或彻底删除后再恢复` };
  } catch { /* 目标不存在，可恢复 */ }
  try {
    await rename(src, dest);
    await rm(join(dest, 'trash-meta.json'), { force: true });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, appId: safeAppId };
}

/** 彻底删除回收站条目（不可恢复） */
export async function purgeTrashItem(trashId: unknown): Promise<boolean> {
  const safeTrashId = sanitizeTrashId(trashId);
  if (!safeTrashId) return false;
  try {
    await rm(join(trashRoot(), safeTrashId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
