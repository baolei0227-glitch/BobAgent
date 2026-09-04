/**
 * Chain / Tree 数据结构纯工具集（NodeMap 目录视图共用）。
 * 消除 NodeMap 里 treeData / chains / relayoutTree 内部三份同构的
 * "遍历 edges -> 建 childrenOf/parentsOf / adjacency -> BFS 连通分量"代码。
 */
import type { GraphNodeInfo, GraphEdgeInfo } from './graph-gateway';
import { groupComponentsByConnectivity } from './nodemap-layout';

export interface ChildEntry {
  id: string;
}
export interface ParentEntry {
  id: string;
  order: number;
}

export interface EdgeHierarchy {
  /** source -> children 列表 */
  childrenOf: Map<string, ChildEntry[]>;
  /** target -> parents 列表（含出现 order，用于判断"最早连线=主父"） */
  parentsOf: Map<string, ParentEntry[]>;
  /** 至少出现在一条有效边中的节点 id 集合 */
  connected: Set<string>;
}

/** 遍历 edges（跳过 disconnected），一次性构建 childrenOf / parentsOf / connected。 */
export function buildEdgeHierarchy(edges: GraphEdgeInfo[]): EdgeHierarchy {
  const childrenOf = new Map<string, ChildEntry[]>();
  const parentsOf = new Map<string, ParentEntry[]>();
  const connected = new Set<string>();
  let edgeOrder = 0;
  for (const e of edges) {
    if (e.disconnected) continue;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)!.push({ id: e.target });
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push({ id: e.source, order: edgeOrder++ });
    connected.add(e.source);
    connected.add(e.target);
  }
  return { childrenOf, parentsOf, connected };
}

export interface ParentAssignment {
  /** childId -> 主父 id（最早连线） */
  primaryParent: Map<string, string>;
  /** childId -> 其它父 id（非主父，用于目录里显示"引用项"⇄） */
  extraParents: Map<string, string[]>;
}

/** 从 parentsOf 计算主父（最早 order）与非主父集合。 */
export function pickPrimaryParent(
  parentsOf: Map<string, ParentEntry[]>,
): ParentAssignment {
  const primaryParent = new Map<string, string>();
  const extraParents = new Map<string, string[]>();
  for (const [childId, pars] of parentsOf) {
    const sorted = [...pars].sort((a, b) => a.order - b.order);
    primaryParent.set(childId, sorted[0].id);
    if (sorted.length > 1) {
      extraParents.set(childId, sorted.slice(1).map((p) => p.id));
    }
  }
  return { primaryParent, extraParents };
}

export interface NodeMeta {
  /** nodeId -> 节点标题 */
  titleOf: Map<string, string>;
  /** 无主父节点的 id 集合（根） */
  roots: string[];
}

/** 构建标题映射 / roots（无主父 = 根）。 */
export function buildNodeMeta(
  nodes: GraphNodeInfo[],
  primaryParent: Map<string, string>,
): NodeMeta {
  const titleOf = new Map<string, string>();
  for (const n of nodes) {
    titleOf.set(n.id, n.title);
  }
  const roots = nodes.filter((n) => !primaryParent.has(n.id)).map((n) => n.id);
  return { titleOf, roots };
}

/** 对单个连通分量：从首节点 head 出发按"主父子关系"DFS，给出链内节点的连贯顺序；
 *  未覆盖节点（环/引用）按 id 排序挂尾部。这让目录树展开时节点顺序符合视觉直觉。 */
export function orderChainByDfs(
  ids: string[],
  headId: string,
  childrenOf: Map<string, ChildEntry[]>,
  primaryParent: Map<string, string>,
): string[] {
  const nodeSet = new Set(ids);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
    for (const { id: kid } of childrenOf.get(id) ?? []) {
      if (primaryParent.get(kid) === id && nodeSet.has(kid)) visit(kid);
    }
  };
  visit(headId);
  // DFS 未覆盖节点（环/引用）保留原 ids 顺序并追加在尾（已按出现顺序稳定）
  for (const id of ids) if (!seen.has(id)) ordered.push(id);
  return ordered;
}

/** 从一个分量的 id 列表中挑"首节点"：
 *  优先选分量内 roots（按原始 y,x），都没有则挑分量内 y 最小者。
 *  链标题默认来源于该节点，链排序也按该节点原始 (y,x)。 */
export function pickChainHead(
  ids: string[],
  nodesById: Map<string, GraphNodeInfo>,
  rootIds: Set<string>,
): GraphNodeInfo {
  const rootsIn = ids
    .filter((id) => rootIds.has(id))
    .map((id) => nodesById.get(id)!)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (rootsIn.length > 0) return rootsIn[0];
  return ids
    .map((id) => nodesById.get(id)!)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))[0];
}

export interface GraphChain {
  /** 链首节点 id（无父的根；用作链标题与聚焦锚点） */
  rootId: string;
  /** 链内节点 id（从首节点按主父子关系 DFS 的连贯顺序） */
  ids: string[];
  /** 链序号（按首节点原始 (y,x) 升序，与 Fit 纵向堆叠顺序一致） */
  order: number;
}

/** 基于根节点（无主父）划分链：每个主节点独立成链，子节点归入其主父所在链。 */
function groupChainsByRoot(
  nodes: GraphNodeInfo[],
  childrenOf: Map<string, ChildEntry[]>,
  primaryParent: Map<string, string>,
  roots: string[],
): { chainRootId: string; ids: string[] }[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  // 每个节点归属的根节点 id（向上追溯到根）
  const belongTo = new Map<string, string>();
  const getRoot = (id: string, visited: Set<string>): string | null => {
    if (visited.has(id)) return null; // 环保护
    visited.add(id);
    if (belongTo.has(id)) return belongTo.get(id)!;
    if (!primaryParent.has(id)) return id; // 自身就是根
    return getRoot(primaryParent.get(id)!, visited);
  };

  // 1. 根节点各自成链
  for (const rootId of roots) {
    if (!belongTo.has(rootId)) {
      belongTo.set(rootId, rootId);
    }
  }

  // 2. 非根节点追溯到所属根
  for (const n of nodes) {
    if (!belongTo.has(n.id)) {
      const r = getRoot(n.id, new Set());
      if (r) belongTo.set(n.id, r);
    }
  }

  // 3. 剩余未归属的节点（孤立）各自成链
  for (const n of nodes) {
    if (!belongTo.has(n.id)) {
      belongTo.set(n.id, n.id);
    }
  }

  // 4. 按根节点分组
  const byRoot = new Map<string, string[]>();
  for (const [nodeId, rootId] of belongTo) {
    if (!byRoot.has(rootId)) byRoot.set(rootId, []);
    byRoot.get(rootId)!.push(nodeId);
  }

  // 5. 对每个链做 DFS 排序
  const result: { chainRootId: string; ids: string[] }[] = [];
  for (const [rootId, ids] of byRoot) {
    const orderedIds = orderChainByDfs(ids, rootId, childrenOf, primaryParent);
    result.push({ chainRootId: rootId, ids: orderedIds });
  }
  return result;
}

/** 画布级链分划（画布导航圆点 / NodeMap 目录共用）：
 *  基于根节点（无主父）划分链，每个主节点独立成链。
 *  链序 = 链首节点原始 (y,x) 升序。 */
export function buildChains(nodes: GraphNodeInfo[], edges: GraphEdgeInfo[]): GraphChain[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const hier = buildEdgeHierarchy(edges);
  const { primaryParent } = pickPrimaryParent(hier.parentsOf);
  const meta = buildNodeMeta(nodes, primaryParent);

  // 使用根节点分组而非连通性分组，确保每个主节点都有独立导航圆点
  const groups = groupChainsByRoot(nodes, hier.childrenOf, primaryParent, meta.roots);

  const rootSet = new Set(meta.roots);
  const laid = groups.map((g) => {
    const head = pickChainHead(g.ids, nodesById, rootSet);
    // 用 DFS 重新排序，确保子树完整且顺序正确
    const orderedIds = orderChainByDfs(g.ids, head.id, hier.childrenOf, primaryParent);
    return { rootId: head.id, ids: orderedIds, headY: head.y, headX: head.x };
  });
  laid.sort((a, b) => (a.headY - b.headY) || (a.headX - b.headX));
  return laid.map((c, i) => ({ rootId: c.rootId, ids: c.ids, order: i + 1 }));
}
