/**
 * 防环检测：BFS 判断新增边 from→to 后是否会产生环
 */

export interface EdgeInfo {
  from: string;
  to: string;
}

/**
 * 检查新增 from→to 边后是否会产生环。
 * 如果 to 能通过现有边到达 from，则新增 from→to 会形成环。
 *
 * @param existingEdges 现有活跃边列表
 * @param from 新边的源节点
 * @param to 新边的目标节点
 * @returns true 表示会形成环，应阻止创建
 */
export function wouldCreateCycle(
  existingEdges: EdgeInfo[],
  from: string,
  to: string,
): boolean {
  // 自环
  if (from === to) return true;

  // BFS: 从 to 出发，看能否到达 from
  const visited = new Set<string>();
  const queue: string[] = [to];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    // 找到 current 的所有下游节点
    const downstream = existingEdges
      .filter((e) => e.from === current)
      .map((e) => e.to);

    for (const next of downstream) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }

  return false;
}

/**
 * 获取某个节点的所有上游节点（递归），按拓扑顺序排列。
 * 用于上下文注入。
 */
export function getAllUpstream(
  edges: EdgeInfo[],
  nodeId: string,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();

  function dfs(node: string) {
    const upstream = edges
      .filter((e) => e.to === node)
      .map((e) => e.from);

    for (const up of upstream) {
      if (visited.has(up)) continue;
      visited.add(up);
      dfs(up);
      result.push(up);
    }
  }

  dfs(nodeId);
  return result;
}
