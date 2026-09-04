/**
 * 视觉理解结果缓存（ocr.image_understand）
 *
 * 与 parse cache（OCR/PDF 识别）解耦的独立缓存层：
 *   - 键 = 文件内容 SHA-256 + mode + prompt（内容哈希，跨项目/跨路径可复用）
 *   - 存储 = <appRoot>/.cache/vision/<key>.json（全局，跨项目共享命中）
 *   - TTL 30 天 + 容量上限 2000（写后惰性清理最旧）
 *
 * 背景：image_understand 之前无缓存，同一张图在多轮对话/多项目间反复出现时
 * 每次都真实调用视觉模型（单次 10~57s），是视觉层缓存 miss 的主要来源之一。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveAppRoot } from '@/lib/app-root';

const VISION_CACHE_DIR = 'vision';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const CACHE_MAX_ENTRIES = 2000;

// P3 负缓存：确定性失败（如 400 图片格式错误）短时记忆，避免视觉回退链风暴重试。
// 进程级 Map + 5 分钟 TTL（负缓存本就用于短时兜底，跨进程失效可接受）。
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const negativeCache = new Map<string, number>(); // fileHash -> 过期时间戳

/** 是否处于负缓存期内（确定性失败后 5 分钟内跳过重试） */
export function isVisionNegativelyCached(fileHash: string): boolean {
  const expireAt = negativeCache.get(fileHash);
  if (!expireAt) return false;
  if (Date.now() > expireAt) {
    negativeCache.delete(fileHash);
    return false;
  }
  return true;
}

/** 标记负缓存（确定性失败后调用） */
export function markVisionNegative(fileHash: string): void {
  negativeCache.set(fileHash, Date.now() + NEGATIVE_TTL_MS);
}

export interface VisionCacheRecord {
  /** 文件内容 SHA-256 */
  fileHash: string;
  mode: string;
  prompt?: string;
  understanding: string;
  model: string;
  cached_at: string;
}

/** 文件内容 SHA-256（独立实现，避免引入 image-parser 的重依赖） */
export async function computeVisionFileHash(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getCacheDir(): string {
  return path.join(resolveAppRoot(), '.cache', VISION_CACHE_DIR);
}

/** 缓存键：fileHash + mode + prompt 合成哈希，作为文件名 */
function cacheKey(fileHash: string, mode: string, prompt?: string): string {
  const raw = `${fileHash}\x00${mode}\x00${prompt ?? ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getCacheFilePath(key: string): string {
  return path.join(getCacheDir(), `${key}.json`);
}

export async function getVisionCache(
  fileHash: string,
  mode: string,
  prompt?: string,
): Promise<VisionCacheRecord | null> {
  const filePath = getCacheFilePath(cacheKey(fileHash, mode, prompt));
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const record: VisionCacheRecord = JSON.parse(raw);
    if (record.fileHash !== fileHash || !record.understanding) return null;
    // TTL 过期检查：过期视为 miss
    const age = Date.now() - new Date(record.cached_at).getTime();
    if (Number.isFinite(age) && age > CACHE_TTL_MS) return null;
    return record;
  } catch {
    return null;
  }
}

export async function setVisionCache(record: VisionCacheRecord): Promise<void> {
  const dir = getCacheDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getCacheFilePath(cacheKey(record.fileHash, record.mode, record.prompt));
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
  // 容量上限：写后惰性清理最旧文件（异步，不阻塞主流程）
  void enforceVisionCacheLimit(dir).catch(() => {});
}

async function enforceVisionCacheLimit(dir: string): Promise<void> {
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
  await Promise.all(overflow.map((s) => fs.unlink(path.join(dir, s.f)).catch(() => {})));
}
