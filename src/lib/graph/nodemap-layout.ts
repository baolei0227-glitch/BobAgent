/**
 * 图排版/连通性工具（纯函数模块）。
 * - groupComponentsByConnectivity：按有效边（忽略 disconnected）构建无向邻接表，
 *   划分连通分量与孤立节点，供链分组/上游上下文等消费。
 * - computeRadialLayout：NodeMap 的"中心星射 + 多点散开"排版。
 *   · 中心：每个连通分量取簇内度数最大者居中——"被连线最多"的点是视觉中心，其关联点绕它四周散开；
 *   · 分层：以中心为源做 BFS，一跳邻居在近圈、二跳在外圈，层次即方位可读；
 *   · 散开：每圈半径由该圈最小扇区反推（弧距恒 ≥ spacing），关联多的点自动把邻居摊得更开；
 *   · 孤立：无任何连线的点不进分量，绕主结构外圈均匀散布（保持孤立，不假装有关系）；
 *   · 其余较小分量同样落外圈，放不下则按环递增半径。
 *   （2026-09-17：主父层级骨架版下线——它以"最早连线的父"为根，根常落在图的边缘，
 *   整个结构偏在一侧；且扇区按叶子数分配时窄支会在外圈挤成一坨，观感混乱。）
 *
 * 纯函数约束：
 * - 不读 DOM、不读 gateway store、不写任何副作用
 * - 所有外部信息（节点/边）都通过参数注入
 * - 确定性：同输入必同输出（BFS/子节点按 id 定序、确定性扇区分配），供 useMemo 缓存防抖动
 */
import type { GraphNodeInfo, GraphEdgeInfo } from './graph-gateway';

/** 建立双向邻接表（activeEdges 无向），返回 components（每个分量是 nodeId[]）+ 没进入任何分量的孤立 nodeId[] */
export function groupComponentsByConnectivity(
  nodes: GraphNodeInfo[],
  edges: GraphEdgeInfo[],
): { components: string[][]; isolated: string[] } {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const e of edges) if (!e.disconnected) link(e.source, e.target);

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const n of nodes) {
    if (visited.has(n.id)) continue;
    if (!adj.has(n.id)) continue; // 孤立 = 不进入分量，留在 isolated
    const q = [n.id];
    visited.add(n.id);
    const comp: string[] = [];
    while (q.length) {
      const cur = q.shift()!;
      comp.push(cur);
      for (const nx of adj.get(cur) ?? []) if (!visited.has(nx)) { visited.add(nx); q.push(nx); }
    }
    components.push(comp);
  }

  const isolated = nodes.filter((n) => !visited.has(n.id)).map((n) => n.id);
  return { components, isolated };
}

const TAU = Math.PI * 2;
/** 扇区起始角：正上方（SVG y 轴向下，故 -π/2 朝上） */
const UP = -Math.PI / 2;
/** 相邻环之间的径向间距系数（保证跨环两点世界间距 > spacing） */
const RING_GAP = 1.15;
/** 同环弧距安全系数：弧距按 spacing × 该系数折算，避免圆点贴边 */
const ARC_SAFE = 1.35;
/** 外圈首环最多一圈容纳的簇数：小规模尽量单环（一个干净的圆环），超过再增圈 */
const FIRST_RING_MAX = 12;

/** computeRadialLayout 结果：节点中心坐标 + 整体包围盒（供 NodeMap 缩放适配） */
export interface RadialLayoutResult {
  positions: Record<string, { cx: number; cy: number }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface RadialLayoutOptions {
  /** 相邻环径向间距（世界单位）：同时决定同环最小弧距，保证圆点不重叠 */
  spacing?: number;
  /** 包围盒四周留白（世界单位） */
  padding?: number;
}

/** 单簇排版结果：簇内局部坐标（中心居原点）+ 距原点的最大半径（供外圈编排留位） */
interface ClusterLayout {
  ids: string[];
  local: Map<string, { x: number; y: number }>;
  radius: number;
}

const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 中心星射排版：
 *  - 簇划分：连通分量各自成一颗"中心星"，孤立节点是单点簇；
 *  - 主结构居中：最大的簇（有关系者）居中，其中心在圆心、其余节点按 BFS 层上圈；
 *  - 外圈均布：其余簇（孤立节点 / 较小分量）绕主结构外圈均布，放不下则按环递增半径；
 *  - 确定性：同输入必同输出，无随机数。
 */
export function computeRadialLayout(
  nodes: GraphNodeInfo[],
  edges: GraphEdgeInfo[],
  opts: RadialLayoutOptions = {},
): RadialLayoutResult {
  const { spacing = 44, padding = 20 } = opts;
  // 批注框（annotation）不参与排版（与 NodeMap 圆点口径一致）
  const layoutNodes = nodes.filter((n) => n.type !== 'annotation');
  if (layoutNodes.length === 0) {
    return { positions: {}, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  }

  const idSet = new Set(layoutNodes.map((n) => n.id));
  const activeEdges = edges.filter((e) => !e.disconnected && idSet.has(e.source) && idSet.has(e.target));

  // 无向邻接表（与连通分量同口径）：中心选取、BFS 分层都依赖，邻居按 id 定序保证确定性
  const adjacency = new Map<string, string[]>();
  for (const e of activeEdges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.source)!.push(e.target);
    adjacency.get(e.target)!.push(e.source);
  }
  for (const list of adjacency.values()) list.sort(cmpId);

  const { components, isolated } = groupComponentsByConnectivity(layoutNodes, activeEdges);

  // 簇集合：连通分量 + 孤立单点；大簇在前（作为中心主结构），同规模按最小 id 定序
  const clusters = [
    ...components.map((ids) => [...ids].sort(cmpId)),
    ...isolated.map((id) => [id]),
  ]
    .sort((a, b) => b.length - a.length || cmpId(a[0], b[0]))
    .map((ids) => layoutCluster(ids, adjacency, spacing));

  // ———— 合成：有关系的主簇居中，其余簇绕外圈均布 ————
  const arranged: Record<string, { x: number; y: number }> = {};
  const main = clusters[0];
  const hasMain = Boolean(main && main.ids.length > 1);
  const orbit = hasMain ? clusters.slice(1) : clusters;
  if (hasMain) placeCluster(arranged, main, 0, 0);

  if (orbit.length > 0) {
    const gap = spacing * RING_GAP;
    // outer = 已占用区域的外缘半径：主结构外缘起算（无主结构则从原点起）
    let outer = hasMain ? main.radius + gap : 0;
    let cursor = 0;
    let ring = 0;
    while (cursor < orbit.length) {
      const left = orbit.slice(cursor);
      // 保守取剩余簇的最大半径：本环所有簇都按它留位，保证同环不重叠
      const maxRadius = left.reduce((m, c) => Math.max(m, c.radius), 0);
      // 本环半径：簇整体（含自身半径）落在已占用区域之外；同时满足"一圈装下"的周长要求
      const capacityRadius = (Math.min(left.length, FIRST_RING_MAX) * spacing * ARC_SAFE) / TAU;
      const ringRadius = Math.max(outer + maxRadius, capacityRadius);
      // 槽位宽 = 本环最大直径 + 安全间距
      const slot = Math.max(spacing * ARC_SAFE, 2 * maxRadius + gap);
      const capacity = Math.max(1, Math.floor((TAU * ringRadius) / slot + 1e-6));
      const take = Math.min(capacity, left.length);
      const step = TAU / take;
      // 槽位起始偏移：奇数环偏半格，避免外圈点与内圈点串在同一半径方向上
      const offset = ring % 2 === 1 ? step / 2 : 0;
      for (let k = 0; k < take; k++) {
        const angle = UP + offset + k * step;
        const cluster = orbit[cursor + k];
        placeCluster(arranged, cluster, Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius);
      }
      outer = ringRadius + maxRadius + gap;
      cursor += take;
      ring += 1;
    }
  }

  // 汇总包围盒 + 留白
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const positions: Record<string, { cx: number; cy: number }> = {};
  for (const n of layoutNodes) {
    const p = arranged[n.id];
    if (!p) continue;
    positions[n.id] = { cx: p.x, cy: p.y };
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { positions, bounds: { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding } };
}

/** 把簇落到位（局部坐标 + 簇中心偏移） */
function placeCluster(
  out: Record<string, { x: number; y: number }>,
  cluster: ClusterLayout,
  offsetX: number,
  offsetY: number,
): void {
  for (const id of cluster.ids) {
    const p = cluster.local.get(id);
    if (!p) continue;
    out[id] = { x: p.x + offsetX, y: p.y + offsetY };
  }
}

/**
 * 单簇"中心星射 + 多点散开"排版（局部坐标，簇中心居原点）：
 *  - 中心：簇内度数最大的节点（并列取 id 小者）——关系最密者居中，其关联点绕它四周散开；
 *  - 分层：以中心为源做 BFS，第 d 层落到第 d 圈——一跳邻居在近圈、二跳在外圈，层次可读；
 *  - 扇区：父把自身扇区按下辖各子树的"同层最大宽度"分给子（宽支占角大，不挤成一坨），
 *    子落在自己扇区的中位角、父居中于整片扇区 → 从哪个节点分出来一眼可读；
 *  - 半径：每圈取 max(上一圈 + 环间距, 最小扇区所需弧距)——同圈弧距恒 ≥ spacing，多点也能散开；
 *  - 确定性：同输入必同输出（BFS 邻居按 id 升序、子按 id 定序）。
 */
function layoutCluster(
  ids: string[],
  adjacency: Map<string, string[]>,
  spacing: number,
): ClusterLayout {
  if (ids.length === 1) {
    return { ids, local: new Map([[ids[0], { x: 0, y: 0 }]]), radius: 0 };
  }
  const inCluster = new Set(ids);
  const neighborsIn = (id: string) => (adjacency.get(id) ?? []).filter((n) => inCluster.has(n));

  // 中心 = 簇内度数最大者（并列取 id 小者）
  let center = ids[0];
  let centerDeg = neighborsIn(center).length;
  for (const id of ids) {
    const deg = neighborsIn(id).length;
    if (deg > centerDeg || (deg === centerDeg && cmpId(id, center) < 0)) {
      center = id;
      centerDeg = deg;
    }
  }

  // BFS 分层 + 生成树（父 = 先发现它的邻居；邻居已按 id 定序 → 同输入同输出）
  const parent = new Map<string, string>();
  const depth = new Map<string, number>([[center, 0]]);
  const order: string[] = [center];
  for (let i = 0; i < order.length; i++) {
    const cur = order[i];
    for (const nx of neighborsIn(cur)) {
      if (depth.has(nx)) continue;
      parent.set(nx, cur);
      depth.set(nx, depth.get(cur)! + 1);
      order.push(nx);
    }
  }
  // 兜底：连通分量必被 BFS 覆盖；异常时挂到中心，保证每个节点都有位置
  for (const id of ids) if (!depth.has(id)) { parent.set(id, center); depth.set(id, 1); order.push(id); }

  // 生成树 children（按 id 升序）
  const children = new Map<string, string[]>();
  for (const id of order) {
    const p = parent.get(id);
    if (!p) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(id);
  }
  for (const list of children.values()) list.sort(cmpId);

  // 子树同层节点数序列（levels[k] = 该子树第 k 层节点数）：逆 BFS 序即后序，逐层累加到父
  const levels = new Map<string, number[]>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const arr: number[] = [1];
    for (const kid of children.get(id) ?? []) {
      const kl = levels.get(kid)!;
      for (let k = 0; k < kl.length; k++) arr[k + 1] = (arr[k + 1] ?? 0) + kl[k];
    }
    levels.set(id, arr);
  }
  // 扇区权重 = 子树内同层最大宽度（≥1）：最宽的一层能拿到足够角度，外圈才不会挤成一坨
  const weightOf = (id: string) => (levels.get(id) ?? [1]).reduce((m, v) => Math.max(m, v), 1);

  // 扇区分配：子按权重瓜分父扇区、落在各自中位角；同时记录每圈最小扇区宽度
  const angle = new Map<string, number>([[center, UP]]);
  const minSpan = new Map<number, number>();
  const assign = (id: string, a0: number, a1: number) => {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    const d = depth.get(id)! + 1;
    const total = kids.reduce((s, k) => s + weightOf(k), 0);
    let cursor = a0;
    for (const kid of kids) {
      const span = ((a1 - a0) * weightOf(kid)) / total;
      angle.set(kid, cursor + span / 2);
      minSpan.set(d, Math.min(minSpan.get(d) ?? Infinity, span));
      assign(kid, cursor, cursor + span);
      cursor += span;
    }
  };
  assign(center, UP, UP + TAU);

  // 圈半径：上一圈 + 环间距（跨圈不重叠），且最小扇区的弧距 ≥ spacing（同圈不重叠）
  const maxDepth = Math.max(...depth.values());
  const ringRadius: number[] = [0];
  for (let d = 1; d <= maxDepth; d++) {
    const span = minSpan.get(d) ?? TAU;
    const arcNeed = span > 0 ? (spacing * ARC_SAFE) / span : 0;
    ringRadius[d] = Math.max(ringRadius[d - 1] + spacing * RING_GAP, arcNeed);
  }

  const local = new Map<string, { x: number; y: number }>();
  let radius = 0;
  for (const id of order) {
    const r = ringRadius[depth.get(id)!];
    const a = angle.get(id) ?? UP;
    local.set(id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
    radius = Math.max(radius, r);
  }
  return { ids, local, radius };
}