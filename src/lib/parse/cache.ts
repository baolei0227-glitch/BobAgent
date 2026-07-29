import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ParseCacheRecord, ParseResult } from './types';

const CACHE_DIR_NAME = '.cache';
const PARSE_CACHE_DIR_NAME = 'parse';

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