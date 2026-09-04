/**
 * 文档分享链接 — token 存储
 *
 * 局域网分享：生成带 token 的链接，映射 md 文档路径 → 阅读链接。
 * 文档不出本机（只在本机/局域网可访问，token 即访问凭证）。
 * 存储：~/BobWork/.share-links.json  { [token]: { path, title, createdAt } }
 */
import { join } from 'path';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { resolveAppRoot } from '@/lib/app-root';

export interface ShareLinkRecord {
  /** md 文档绝对路径 */
  path: string;
  /** 展示标题（文件名，不含扩展名） */
  title: string;
  createdAt: number;
}

export interface ShareLinkEntry extends ShareLinkRecord {
  token: string;
}

const SHARE_FILE = join(resolveAppRoot(), '.share-links.json');

async function readAll(): Promise<Record<string, ShareLinkRecord>> {
  try {
    const raw = await fs.readFile(SHARE_FILE, 'utf-8');
    return JSON.parse(raw) as Record<string, ShareLinkRecord>;
  } catch {
    return {};
  }
}

async function writeAll(map: Record<string, ShareLinkRecord>): Promise<void> {
  await fs.mkdir(resolveAppRoot(), { recursive: true });
  await fs.writeFile(SHARE_FILE, JSON.stringify(map, null, 2), 'utf-8');
}

/** 生成分享 token（如已存在同路径分享，复用旧 token，不重复创建） */
export async function createShareLink(path: string, title: string): Promise<ShareLinkEntry> {
  const map = await readAll();
  // 同路径复用：避免重复生成污染 token 列表
  const existing = Object.entries(map).find(([, r]) => r.path === path);
  if (existing) {
    return { token: existing[0], path, title, createdAt: existing[1].createdAt };
  }
  const token = randomBytes(12).toString('base64url');
  map[token] = { path, title, createdAt: Date.now() };
  await writeAll(map);
  return { token, path, title, createdAt: map[token]!.createdAt };
}

/** 按 token 查分享记录；不存在返回 null */
export async function getShareLink(token: string): Promise<ShareLinkEntry | null> {
  const map = await readAll();
  const rec = map[token];
  if (!rec) return null;
  return { token, ...rec };
}

/** 删除分享（token 失效） */
export async function deleteShareLink(token: string): Promise<boolean> {
  const map = await readAll();
  if (!map[token]) return false;
  delete map[token];
  await writeAll(map);
  return true;
}

/** 列出全部分享（管理用） */
export async function listShareLinks(): Promise<ShareLinkEntry[]> {
  const map = await readAll();
  return Object.entries(map).map(([token, rec]) => ({ token, ...rec }));
}
