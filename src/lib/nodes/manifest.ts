/**
 * src/lib/nodes/manifest.ts
 * Manifest（节点结构化目录）生成、缓存与写时维护
 *
 * 规格：《BobWork 节点记忆与继承规格 v3》§五
 *  - 每个节点一份，写时维护，缓存在 {项目}/.cache/nodes/{nodeId}-{manifest_hash}.json
 *  - 条目 anchor 是锚点 id（如 'q-003'），不是字符偏移（v3 修正 v2 的 offset）
 *  - 批注标记 sensitive（intern 命中时额外标 [个人笔记]）
 *  - 关键词匹配用同义词双向扩展（见 src/lib/legal/synonyms.ts）
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { promises as fs } from 'fs';
import type { NodeMarkdown } from '@/lib/node-markdown';
import { findNodeFileById } from '@/lib/node-markdown';

export type ManifestSectionType = 'conversation' | 'annotation' | 'attachment';

export interface ManifestEntry {
  /** 锚点 id（如 'q-003'）；无锚点的条目（批注行）为空字符串 */
  anchor: string;
  type: ManifestSectionType;
  /** 一句话摘要（检索命中依据） */
  title: string;
  time?: string;
  keywords: string[];
  /** 批注标记：命中时额外标 [个人笔记] */
  sensitive?: boolean;
}

export interface NodeManifest {
  nodeId: string;
  title: string;
  /** 一句话摘要（用于祖先存在性声明） */
  summary: string;
  outcomeStatus: 'locked' | 'draft' | 'stale' | 'legacy';
  updatedAt: string;
  sections: ManifestEntry[];
}

// ==================== 缓存路径 ====================

function cacheDir(projectPath: string): string {
  return join(projectPath, '.cache', 'nodes');
}

function cacheFilePath(projectPath: string, nodeId: string, hash: string): string {
  return join(cacheDir(projectPath), `${nodeId}-${hash}.json`);
}

/** 计算 .md 内容的 manifest hash（内容变更即失效重建） */
export function computeManifestHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

// ==================== 关键词提取 ====================

/** 从文本提取关键词（中文连续词 / 英文单词 / 数字，限量） */
export function extractKeywords(text: string, max = 10): string[] {
  const out = new Set<string>();
  if (!text) return [];
  const cnRe = /[\u4e00-\u9fa5]{2,10}/g;
  let m: RegExpExecArray | null;
  cnRe.lastIndex = 0;
  while ((m = cnRe.exec(text)) !== null) out.add(m[0]);
  const enRe = /\b[a-zA-Z]{3,}\b/g;
  enRe.lastIndex = 0;
  while ((m = enRe.exec(text)) !== null) out.add(m[0]);
  const numRe = /\d{2,}/g;
  numRe.lastIndex = 0;
  while ((m = numRe.exec(text)) !== null) out.add(m[0]);
  return Array.from(out).slice(0, max);
}

function firstLine(text: string, max = 40): string {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length > max ? first.slice(0, max) + '…' : first;
}

// ==================== 构建 ====================

/** 从 NodeMarkdown 构建 NodeManifest */
export function buildManifest(node: NodeMarkdown): NodeManifest {
  const sections: ManifestEntry[] = [];

  // 对话记录：每轮一个 entry，锚点定位
  for (const turn of node.conversations) {
    const q = turn.question || '';
    const a = turn.answer || '';
    sections.push({
      anchor: turn.anchor || '',
      type: 'conversation',
      title: firstLine(q),
      time: turn.questionTime,
      keywords: extractKeywords(q + a),
    });
  }

  // 批注：按行拆（敏感）
  for (const line of (node.annotations || '').split('\n')) {
    const text = line.replace(/^[-*]\s+/, '').trim();
    if (!text) continue;
    sections.push({
      anchor: '',
      type: 'annotation',
      title: firstLine(text),
      keywords: extractKeywords(text),
      sensitive: true,
    });
  }

  // 引用区（附件解析缓存，见 v3 §八 权限矩阵：元数据 manifest 可见）
  // 引用区条目优先（含解析摘要，关键词命中率高）；对话记录中的附件路径兜底
  const seenPaths = new Set<string>();
  for (const ref of parseReferenceEntries(node.references || '')) {
    seenPaths.add(ref.path);
    sections.push({
      anchor: '',
      type: 'attachment',
      title: ref.summary ? firstLine(ref.summary, 60) : ref.path,
      keywords: extractKeywords(`${ref.path} ${ref.summary}`),
    });
  }
  for (const att of extractAttachmentRefs(node)) {
    if (seenPaths.has(att)) continue;
    sections.push({
      anchor: '',
      type: 'attachment',
      title: att,
      keywords: extractKeywords(att),
    });
  }

  return {
    nodeId: node.frontmatter.node_id,
    title: node.frontmatter.title,
    summary: node.summary || '',
    outcomeStatus: node.frontmatter.outcome_status ?? 'legacy',
    updatedAt: node.frontmatter.updated_at || '',
    sections,
  };
}

/** 从对话问题附件中提取附件引用（attachments/{folder}/{file} 形式） */
function extractAttachmentRefs(node: NodeMarkdown): string[] {
  const out = new Set<string>();
  for (const turn of node.conversations) {
    for (const att of turn.questionAttachments || []) {
      if (att.path) out.add(att.path);
      else if (att.name) out.add(att.name);
    }
  }
  return Array.from(out);
}

/** 解析引用区条目（- `path`：摘要 形式），提取附件路径与解析摘要 */
function parseReferenceEntries(refs: string): Array<{ path: string; summary: string }> {
  const out: Array<{ path: string; summary: string }> = [];
  for (const line of (refs || '').split('\n')) {
    const m = line.match(/^-\s+`([^`]+)`(?:\s*[:：]\s*(.*))?$/);
    if (m) out.push({ path: m[1], summary: (m[2] || '').trim() });
  }
  return out;
}

// ==================== 缓存读写 ====================

/** 读取缓存中的 manifest（无缓存返回 null） */
async function readCached(projectPath: string, nodeId: string, hash: string): Promise<NodeManifest | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(projectPath, nodeId, hash), 'utf-8');
    return JSON.parse(raw) as NodeManifest;
  } catch {
    return null;
  }
}

/** 写缓存 */
async function writeCache(projectPath: string, nodeId: string, hash: string, manifest: NodeManifest): Promise<void> {
  try {
    await fs.mkdir(cacheDir(projectPath), { recursive: true });
    await fs.writeFile(cacheFilePath(projectPath, nodeId, hash), JSON.stringify(manifest), 'utf-8');
  } catch {
    // 缓存写失败不阻断主流程
  }
}

/** 失效指定节点的全部 manifest 缓存（写时维护：内容变更后调用） */
export async function invalidateManifest(nodeId: string, projectPath: string): Promise<void> {
  try {
    const dir = cacheDir(projectPath);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (f.startsWith(`${nodeId}-`) && f.endsWith('.json')) {
        await fs.unlink(join(dir, f)).catch(() => {});
      }
    }
  } catch {
    // 忽略
  }
}

// ==================== 读入口 ====================

/**
 * 读取节点 manifest（缓存优先，未命中则构建并写缓存）
 * 节点不存在返回 null
 */
export async function readManifest(nodeId: string, projectPath: string): Promise<NodeManifest | null> {
  const filePath = await findNodeFileById(nodeId, projectPath);
  if (!filePath) return null;
  const content = await fs.readFile(filePath, 'utf-8').catch(() => null);
  if (content === null) return null;

  const hash = computeManifestHash(content);
  const cached = await readCached(projectPath, nodeId, hash);
  if (cached) return cached;

  const { parseNodeMarkdown } = await import('@/lib/node-markdown');
  const node = parseNodeMarkdown(content);
  const manifest = buildManifest(node);
  await writeCache(projectPath, nodeId, hash, manifest);
  return manifest;
}

/**
 * 写时维护入口：节点 .md 变更后调用，同步 manifest_hash 与缓存
 * 内容 hash 未变则跳过（避免无谓写盘）。
 */
export async function syncManifestAfterWrite(nodeId: string, projectPath: string): Promise<void> {
  try {
    const filePath = await findNodeFileById(nodeId, projectPath);
    if (!filePath) return;
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = computeManifestHash(content);
    const { parseNodeMarkdown } = await import('@/lib/node-markdown');
    const node = parseNodeMarkdown(content);

    // frontmatter.manifest_hash 不同步时更新（单次写回）
    if (node.frontmatter.manifest_hash !== hash) {
      node.frontmatter.manifest_hash = hash;
      const { serializeNode } = await import('@/lib/node-markdown');
      await fs.writeFile(filePath, serializeNode(node), 'utf-8');
    }

    const manifest = buildManifest(node);
    await writeCache(projectPath, nodeId, hash, manifest);
  } catch (e) {
    console.warn('[manifest] 写时维护失败:', e instanceof Error ? e.message : String(e));
  }
}
