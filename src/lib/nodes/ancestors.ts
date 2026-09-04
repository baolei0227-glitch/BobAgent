/**
 * src/lib/nodes/ancestors.ts
 * 祖先链 BFS 构造（规格 v3 §七 R-16 ~ R-18）
 *
 * R-16: 只取 active 边，带 disconnected_at 的边不计入
 * R-17: 祖先节点（深度 ≥2）只注入存在性声明一行，不注入目录
 * R-18: 祖先链 BFS 去重，深度 ≤3，节点 ≤5；超限时按 updated_at 倒序截取并在声明中标注「另有 N 个更早祖先」
 */

import { join } from 'path';
import { initDb, listVerticalEdges } from '@/lib/db';
import { findNodeFileById, parseNodeMarkdown, type NodeMarkdown } from '@/lib/node-markdown';
import { PROJECT_DB_FILENAME } from '@/lib/app-root';

export interface AncestorNode {
  nodeId: string;
  title: string;
  /** 1 = 直接父（R-12 注入成果块全文）；≥2 = 祖先（R-17 只注入存在性声明） */
  depth: number;
  outcomeStatus?: string;
  updatedAt?: string;
  summary?: string;
}

export interface AncestorChain {
  /** 直接上游（深度 1） */
  depth1: AncestorNode[];
  /** 祖先（深度 2+） */
  depthPlus: AncestorNode[];
  /** 被截断的更早祖先数量（R-18 标注「另有 N 个更早祖先」） */
  truncated: number;
}

export const ANCESTOR_MAX_DEPTH = 3;
export const ANCESTOR_MAX_NODES = 5;

/** 读取节点（按 node_id 定位，返回 NodeMarkdown；不存在返回 null） */
export async function loadNodeById(nodeId: string, projectPath: string): Promise<NodeMarkdown | null> {
  try {
    const filePath = await findNodeFileById(nodeId, projectPath);
    if (!filePath) return null;
    const { promises: fs } = await import('fs');
    const content = await fs.readFile(filePath, 'utf-8');
    return parseNodeMarkdown(content);
  } catch {
    return null;
  }
}

/**
 * 构造祖先链：从节点沿 active 边向上 BFS
 * @param nodeId 当前节点 id
 * @param projectPath 项目绝对路径（读节点文件用）
 * @param projectId 项目 id（edges 表范围）
 */
export async function getAncestorChain(nodeId: string, projectPath: string, projectId: string): Promise<AncestorChain> {
  const db = await initDb(join(projectPath, PROJECT_DB_FILENAME));
  const edges = await listVerticalEdges(db, projectId);

  // to → [froms]（只取 active 边，R-16）
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    const list = parents.get(e.to_node_id) || [];
    list.push(e.from_node_id);
    parents.set(e.to_node_id, list);
  }

  // BFS 上溯，visited 去重（防环，R-18）
  const visited = new Set<string>([nodeId]);
  const collected: AncestorNode[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= ANCESTOR_MAX_DEPTH) continue;
    const froms = parents.get(cur.id) || [];
    for (const p of froms) {
      if (visited.has(p)) continue;
      visited.add(p);
      const node = await loadNodeById(p, projectPath);
      const depth = cur.depth + 1;
      collected.push({
        nodeId: p,
        title: node?.frontmatter.title || p,
        depth,
        outcomeStatus: node?.frontmatter.outcome_status,
        updatedAt: node?.frontmatter.updated_at,
        summary: node?.summary,
      });
      queue.push({ id: p, depth });
    }
  }

  // R-18: 节点数 ≤5，超限按 updated_at 倒序截取
  let truncated = 0;
  if (collected.length > ANCESTOR_MAX_NODES) {
    collected.sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
    truncated = collected.length - ANCESTOR_MAX_NODES;
    collected.length = ANCESTOR_MAX_NODES;
  }

  const depth1 = collected.filter((n) => n.depth === 1);
  const depthPlus = collected.filter((n) => n.depth >= 2);
  return { depth1, depthPlus, truncated };
}
