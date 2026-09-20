/**
 * src/lib/nodes/stale.ts
 * 下游失效（stale）传播 —— R-10 的级联与原因链
 *
 * 前提被推翻必须往下传：A → B → C 断开 A-B，只标 B 的话，C 仍把 B 的结论当既定前提继续推理
 * （前提已被污染，结论却看不出问题）。所以这里按活跃边**级联**标记全部下游（visited 防环），
 * 并把可读的失效原因写进 frontmatter.outcome_stale_reason，供注入侧原样告诉模型
 * 「因上游 n_A 断边，本条前提已失效」——而不是笼统的「已变更」。
 *
 * 调用时机（三处，都属「上游成果块不可再作为既定前提」）：
 *   - 断边 / 硬删除边 / 按节点对断边 → cause='edge-disconnected'
 *   - 重新锁定（版本变更）           → cause='relocked'
 *   - 解锁（成果块可能被改）         → cause='unlocked'
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { initDb, listActiveEdges } from '@/lib/db';
import { PROJECT_DB_FILENAME } from '@/lib/app-root';
import { findNodeFileById, parseNodeMarkdown, serializeNode, updateNodeFile } from '@/lib/node-markdown';

/** 失效起因（决定原因文案） */
export type StaleCause = 'edge-disconnected' | 'relocked' | 'unlocked';

/** 级联起点：`nodeId` 失效，因其上游 `upstreamId` 发生了 `cause` */
export interface StaleSeed {
  /** 失效节点（断边/上游变更的直接下游） */
  nodeId: string;
  /** 触发失效的上游节点 id（不含 n_ 前缀） */
  upstreamId: string;
  /** 上游节点标题（写进原因链，便于模型读懂） */
  upstreamTitle: string;
  cause: StaleCause;
}

const CAUSE_TEXT: Record<StaleCause, string> = {
  'edge-disconnected': '连线已断开',
  relocked: '成果块已重新锁定（版本变更）',
  unlocked: '上游已解锁（成果块可能被修改）',
};

interface QueueItem {
  nodeId: string;
  cause: StaleCause;
  /** 直接上游节点 id 与标题 */
  parentId: string;
  parentTitle: string;
  /** 级联链（含起点上游 → … → 本节点） */
  chain: string[];
}

/**
 * 从 seeds 起向下级联标记 stale，并写入失效原因。
 * 失败静默（单个节点读失败不影响其余），返回标记成功的节点数。
 */
export async function markStaleCascade(
  seeds: StaleSeed[],
  project: { path: string; id: string },
): Promise<number> {
  if (seeds.length === 0) return 0;
  let marked = 0;
  try {
    const db = await initDb(join(project.path, PROJECT_DB_FILENAME));
    const edges = await listActiveEdges(db, project.id);
    const childrenOf = new Map<string, string[]>();
    for (const e of edges) {
      const list = childrenOf.get(e.from_node_id) ?? [];
      list.push(e.to_node_id);
      childrenOf.set(e.from_node_id, list);
    }

    const visited = new Set<string>();
    const queue: QueueItem[] = seeds.map((s) => ({
      nodeId: s.nodeId,
      cause: s.cause,
      parentId: s.upstreamId,
      parentTitle: s.upstreamTitle,
      chain: [s.upstreamId, s.nodeId],
    }));

    while (queue.length > 0) {
      const item = queue.shift() as QueueItem;
      if (visited.has(item.nodeId)) continue;
      visited.add(item.nodeId);

      const title = await markOne(item, project.path);
      if (title === null) continue;
      marked++;

      for (const childId of childrenOf.get(item.nodeId) ?? []) {
        if (visited.has(childId)) continue;
        queue.push({
          nodeId: childId,
          cause: item.cause,
          parentId: item.nodeId,
          parentTitle: title,
          chain: [...item.chain, childId],
        });
      }
    }
  } catch (e) {
    console.warn('[stale] 级联标记失败:', e instanceof Error ? e.message : String(e));
  }
  return marked;
}

/** 标记单个节点为 stale 并写原因；返回该节点标题（读失败返回 null） */
async function markOne(item: QueueItem, projectPath: string): Promise<string | null> {
  try {
    const filePath = await findNodeFileById(item.nodeId, projectPath);
    if (!filePath) return null;
    const node = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));
    const chainText = item.chain.map((id) => `n_${id}`).join(' → ');
    const reason = `因上游「${item.parentTitle}」(n_${item.parentId}) ${CAUSE_TEXT[item.cause]}，本条前提已失效。级联链：${chainText}`;
    node.frontmatter.outcome_status = 'stale';
    node.frontmatter.outcome_stale_reason = reason;
    node.frontmatter.updated_at = new Date().toISOString();
    await updateNodeFile(filePath, serializeNode(node));
    return node.frontmatter.title || item.nodeId;
  } catch (e) {
    console.warn('[stale] 标记下游 stale 失败 nodeId:', item.nodeId, e instanceof Error ? e.message : String(e));
    return null;
  }
}