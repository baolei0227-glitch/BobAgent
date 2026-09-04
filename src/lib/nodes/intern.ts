/**
 * src/lib/nodes/intern.ts
 * 检索员实习生（规格 v3 §八 R-19 ~ R-24）
 *
 * R-19: 只读不加工：返回命中块原文，不总结、不补全、不推理、不执行上游任务
 * R-20: targetNodeId 必须是祖先链上的节点，直接跳到来源 id 指向的原始出处，不级联
 * R-21: 往返 ≤2 次；未命中时收窄或改写关键词重试，不得全量扫描 .md
 * R-22: 返回内容恒带 [原始对话·未认定]，主模型引用时须标 [存疑] 或转入 pending
 * R-23: 批注命中时额外标 [个人笔记]
 * R-24: status='exhausted' 时主模型必须停止该条推理线，不得基于假设继续计算
 */

import { readManifest, extractKeywords, type NodeManifest, type ManifestEntry } from '@/lib/nodes/manifest';
import { getAncestorChain } from '@/lib/nodes/ancestors';
import { findAnchorOffset } from '@/lib/nodes/anchor';
import { matchTerms } from '@/lib/legal/synonyms';

export const INTERN_DISCLAIMER = '[原始对话·未认定]' as const;
export const INTERN_MAX_ROUNDTRIP = 2;

export interface InternRequest {
  /** 任意祖先节点（R-20：必须是祖先链上的节点） */
  targetNodeId: string;
  /** 检索指令（主模型下发） */
  instruction: string;
  /** 命中条目上限，默认 5 */
  maxResults?: number;
  /** 当前第几轮（≤2），超限返回 exhausted */
  roundTrip?: number;
}

export interface InternHit {
  anchor: string;
  type: ManifestEntry['type'];
  title: string;
  time?: string;
  sensitive?: boolean;
}

export interface InternResult {
  sourceNodeId: string;
  sourceTitle: string;
  hits: InternHit[];
  /** 命中块的 .md 原文，逐字返回（不加工） */
  content: string;
  status: 'found' | 'not-found' | 'exhausted';
  /** 恒定，不可省略（R-22） */
  disclaimer: typeof INTERN_DISCLAIMER;
}

/** 从 .md 中提取锚点后的原文块（到下一个锚点或 section 标题为止） */
function extractAnchorBlock(content: string, anchorId: string): string {
  const idx = findAnchorOffset(content, anchorId);
  if (idx < 0) return '';
  const after = content.slice(idx + `<!-- #${anchorId} -->`.length);
  // 到下一个锚点或下一节标题为止
  const stopRe = /(?:<!--\s*#[a-z]+-\d+\s*-->|^##\s)/m;
  const m = stopRe.exec(after);
  const block = m && m.index > 0 ? after.slice(0, m.index) : after;
  return block.trim();
}

/** 提取指定 ## section 的正文 */
function extractSection(content: string, heading: string): string {
  const lines = content.split('\n');
  let collecting = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (collecting) break;
      if (line.slice(3).trim() === heading) {
        collecting = true;
        continue;
      }
    }
    if (collecting) out.push(line);
  }
  return out.join('\n').trim();
}

/** 从 manifest 中按指令匹配条目（同义词双向扩展） */
function matchEntries(manifest: NodeManifest, instruction: string, maxResults: number): Array<ManifestEntry & { hitCount: number }> {
  const queryTerms = extractKeywords(instruction, 12);
  const scored = manifest.sections.map((entry) => {
    const hits = matchTerms(queryTerms, entry.keywords);
    return { entry, hitCount: hits.size };
  });
  return scored
    .filter((s) => s.hitCount > 0)
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, maxResults)
    .map((s) => ({ ...s.entry, hitCount: s.hitCount }));
}

/**
 * 检索员实习生：按指令查祖先节点 manifest → 定位锚点块 → 读取原文返回
 * @param req 检索请求
 * @param projectPath 项目绝对路径
 * @param projectId 项目 id（祖先链校验用）
 * @param currentNodeId 当前（下游）节点 id（R-20 校验 target 在祖先链上）
 */
export async function internSearchNode(
  req: InternRequest,
  projectPath: string,
  projectId: string,
  currentNodeId: string,
): Promise<InternResult> {
  const roundTrip = req.roundTrip ?? 1;

  // R-24 / R-21: 超过限次直接 exhausted
  if (roundTrip > INTERN_MAX_ROUNDTRIP) {
    return {
      sourceNodeId: req.targetNodeId,
      sourceTitle: '',
      hits: [],
      content: '',
      status: 'exhausted',
      disclaimer: INTERN_DISCLAIMER,
    };
  }

  // R-20: 必须是祖先链上的节点（不级联）
  const chain = await getAncestorChain(currentNodeId, projectPath, projectId);
  const ancestorIds = chain.depth1.concat(chain.depthPlus).map((n) => n.nodeId);
  const allowed = new Set(ancestorIds);
  if (!allowed.has(req.targetNodeId)) {
    return {
      sourceNodeId: req.targetNodeId,
      sourceTitle: '',
      hits: [],
      content: `R-20 节点 ${req.targetNodeId} 不在当前节点的祖先链上，拒绝访问。可访问: ${Array.from(allowed).join(', ') || '无'}`,
      status: 'not-found',
      disclaimer: INTERN_DISCLAIMER,
    };
  }

  const manifest = await readManifest(req.targetNodeId, projectPath);
  if (!manifest) {
    return {
      sourceNodeId: req.targetNodeId,
      sourceTitle: '',
      hits: [],
      content: '',
      status: 'not-found',
      disclaimer: INTERN_DISCLAIMER,
    };
  }

  const maxResults = Math.min(Math.max(1, req.maxResults ?? 5), 10);
  const matched = matchEntries(manifest, req.instruction, maxResults);

  if (matched.length === 0) {
    return {
      sourceNodeId: manifest.nodeId,
      sourceTitle: manifest.title,
      hits: [],
      content: `在节点「${manifest.title}」中未找到与「${req.instruction}」相关的内容。`,
      status: 'not-found',
      disclaimer: INTERN_DISCLAIMER,
    };
  }

  // R-19: 定位锚点块读取原文（不加工）；无锚点条目返回对应 section 原文
  const { findNodeFileById } = await import('@/lib/node-markdown');
  const filePath = await findNodeFileById(req.targetNodeId, projectPath);
  const md = filePath ? await import('fs/promises').then((m) => m.readFile(filePath, 'utf-8')).catch(() => '') : '';

  const hits: InternHit[] = [];
  const contents: string[] = [];
  for (const entry of matched) {
    let block = '';
    if (entry.anchor && /^q-/.test(entry.anchor)) {
      block = extractAnchorBlock(md, entry.anchor);
    } else if (entry.type === 'annotation') {
      block = extractSection(md, '批注');
    } else if (entry.type === 'attachment') {
      block = extractSection(md, '引用区');
    }
    if (!block) block = entry.title;
    hits.push({
      anchor: entry.anchor,
      type: entry.type,
      title: entry.title,
      time: entry.time,
      sensitive: entry.sensitive,
    });
    contents.push(block);
  }

  const notes = hits
    .map((h, i) => {
      const tags: string[] = [];
      if (h.sensitive) tags.push('[个人笔记]'); // R-23
      return `[${i + 1}] ${h.type}${h.anchor ? ` #${h.anchor}` : ''}${h.time ? ` (${h.time})` : ''}${tags.join(' ')}\n${contents[i]}`;
    })
    .join('\n\n');

  return {
    sourceNodeId: manifest.nodeId,
    sourceTitle: manifest.title,
    hits,
    content: notes,
    status: 'found',
    disclaimer: INTERN_DISCLAIMER,
  };
}
