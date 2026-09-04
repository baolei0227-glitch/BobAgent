import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readConfig } from '@/lib/project/project-manager';
import type { ParseCacheRecord, ParseResult } from './types';

const CACHE_DIR_NAME = '.cache';
const PARSE_CACHE_DIR_NAME = 'parse';
// 容量上限（2000 条），超限惰性清理最旧文件（对未归档/已归档项目一视同仁）。
// 过期策略（2026-08-25 起）：未归档项目缓存长期保留；归档项目自归档日起保留 30 天，
// 超期由定时任务主动删除整个 .cache/parse/ 目录释放磁盘。
const CACHE_MAX_ENTRIES = 2000;
/** 归档项目 OCR 缓存保留时长：归档后 30 天 */
const ARCHIVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 项目归档状态内存缓存 TTL（避免每次 getCache 都读盘） */
const ARCHIVE_INFO_TTL_MS = 5000;
/** 定时清理间隔：每小时检查一次归档超期项目 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** 归档信息内存缓存：projectPath → { archivedAt, ts }；archivedAt 为归档毫秒时间戳，未归档为 null */
const archiveInfoCache = new Map<string, { archivedAt: number | null; ts: number }>();
let cleanupIntervalRef: ReturnType<typeof setInterval> | null = null;

/** 查询项目归档时间（毫秒时间戳）；未归档返回 null。带 5s 内存缓存避免频繁读盘。 */
async function getProjectArchivedAt(projectPath: string): Promise<number | null> {
  const key = path.resolve(projectPath);
  const hit = archiveInfoCache.get(key);
  if (hit && Date.now() - hit.ts < ARCHIVE_INFO_TTL_MS) return hit.archivedAt;
  let archivedAt: number | null = null;
  try {
    const config = await readConfig();
    const proj = config.projects.find((p) => p.path && path.resolve(p.path) === key);
    archivedAt = proj?.archived_at ? new Date(proj.archived_at).getTime() : null;
  } catch {
    // 读取配置失败按未归档处理（不阻断缓存命中）
  }
  archiveInfoCache.set(key, { archivedAt, ts: Date.now() });
  return archivedAt;
}

/** 进程内 PDF 预热进行中标记（key = `${projectPath}::${hash}`），用于 read_attachment 端等待预热收尾 */
const warmingMap = new Map<string, boolean>();

/** 标记某 PDF 是否正在预热中（避免重复启动预热 + 供工具端轮询等待） */
export function markPdfWarming(cacheKey: string, warming: boolean): void {
  if (warming) warmingMap.set(cacheKey, true);
  else warmingMap.delete(cacheKey);
}

/** 是否有预热正在进行 */
export function isPdfWarming(cacheKey: string): boolean {
  return warmingMap.get(cacheKey) === true;
}

/** 工具端辅助：最多等待 `maxMs` 毫秒，每 150ms 轮询一次检查预热是否完成并写入缓存。
 *  返回 true = 预热已在时限内写入缓存（调用方应再读一次缓存）；
 *  返回 false = 超时或缓存仍未写入，调用方继续正常 OCR。 */
export async function waitForPdfWarmOrTimeout(
  hash: string,
  projectPath: string,
  maxMs = 1200,
): Promise<boolean> {
  const cacheKey = `${projectPath}::${hash}`;
  if (!isPdfWarming(cacheKey)) return false;
  const t0 = Date.now();
  const interval = 150;
  while (Date.now() - t0 < maxMs) {
    // 每轮先查缓存（预热可能刚写完），再判断进行中状态
    const cached = await getCache(hash, projectPath).catch(() => null);
    if (cached?.result?.extracted_text) return true;
    if (!isPdfWarming(cacheKey)) {
      // 预热已结束（无论成功失败）再查最后一次缓存确认
      const finalCached = await getCache(hash, projectPath).catch(() => null);
      return !!(finalCached?.result?.extracted_text);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  // 超时：仍然可能缓存刚好写完，再补一次最终检查
  const lastCached = await getCache(hash, projectPath).catch(() => null);
  return !!(lastCached?.result?.extracted_text);
}

export function getCacheDir(projectPath: string): string {
  return path.join(projectPath, CACHE_DIR_NAME, PARSE_CACHE_DIR_NAME);
}

async function ensureCacheDir(projectPath: string): Promise<void> {
  const dir = getCacheDir(projectPath);
  await fs.mkdir(dir, { recursive: true });
}

function getCacheFilePath(hash: string, projectPath: string): string {
  return path.join(getCacheDir(projectPath), `${hash}.json`);
}

export async function getCache(
  hash: string,
  projectPath: string
): Promise<ParseCacheRecord | null> {
  const filePath = getCacheFilePath(hash, projectPath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const record: ParseCacheRecord = JSON.parse(raw);
    if (record.hash === hash && record.result) {
      // 过期策略：归档项目自归档日起保留 30 天，超期视为 miss（等待清理任务删除）；
      // 未归档项目长期保留（仅受 2000 条容量上限约束）
      const archivedAt = await getProjectArchivedAt(projectPath);
      if (archivedAt !== null && Date.now() - archivedAt > ARCHIVE_CACHE_TTL_MS) return null;
      return record;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setCache(
  hash: string,
  result: ParseResult,
  projectPath: string
): Promise<void> {
  await ensureCacheDir(projectPath);
  const filePath = getCacheFilePath(hash, projectPath);
  const record: ParseCacheRecord = {
    hash,
    result,
    cached_at: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
  // P5：容量上限——写后惰性清理最旧文件（异步，不阻塞主流程）
  void enforceCacheLimit(projectPath).catch(() => {});
}

/** P5：缓存文件数超过上限时，按修改时间删除最旧的，回落到上限内 */
async function enforceCacheLimit(projectPath: string): Promise<void> {
  const dir = getCacheDir(projectPath);
  const entries = await fs.readdir(dir);
  const files = entries.filter((e) => e.endsWith('.json'));
  if (files.length <= CACHE_MAX_ENTRIES) return;
  const stats = await Promise.all(
    files.map(async (f) => {
      const st = await fs.stat(path.join(dir, f));
      return { f, mtime: st.mtimeMs };
    }),
  );
  stats.sort((a, b) => a.mtime - b.mtime);
  const overflow = stats.slice(0, files.length - CACHE_MAX_ENTRIES);
  await Promise.all(
    overflow.map((s) => fs.unlink(path.join(dir, s.f)).catch(() => {})),
  );
}

export async function clearCache(projectPath: string): Promise<void> {
  const dir = getCacheDir(projectPath);
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(
      entries.map((entry) => fs.unlink(path.join(dir, entry)))
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

export async function hasCache(
  hash: string,
  projectPath: string
): Promise<boolean> {
  const record = await getCache(hash, projectPath);
  return record !== null;
}

/** 清理所有"归档超 30 天"项目的 OCR 缓存目录（.cache/parse/），返回清理的项目数。幂等，可重复调用。 */
export async function cleanupExpiredArchiveCaches(): Promise<number> {
  const config = await readConfig();
  const now = Date.now();
  let removed = 0;
  for (const proj of config.projects) {
    if (!proj.archived || !proj.archived_at || !proj.path) continue;
    const archivedMs = new Date(proj.archived_at).getTime();
    if (!Number.isFinite(archivedMs) || now - archivedMs <= ARCHIVE_CACHE_TTL_MS) continue;
    const cacheDir = path.join(proj.path, CACHE_DIR_NAME, PARSE_CACHE_DIR_NAME);
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
      removed++;
    } catch {
      // 目录不存在/无权限等：忽略，下次再试
    }
  }
  if (removed > 0) archiveInfoCache.clear();
  return removed;
}

/** 定时清理调度：每小时检查一次归档超期项目的 OCR 缓存（启动后先延迟执行一次） */
export function startCacheCleanupScheduler(): void {
  if (cleanupIntervalRef) return;
  cleanupIntervalRef = setInterval(() => {
    void cleanupExpiredArchiveCaches().catch((e) => {
      console.error('[parse-cache] 归档缓存清理失败:', e);
    });
  }, CLEANUP_INTERVAL_MS);
  setTimeout(() => {
    void cleanupExpiredArchiveCaches().catch((e) => {
      console.error('[parse-cache] 归档缓存清理失败:', e);
    });
  }, 30_000);
}