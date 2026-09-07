/**
 * 图排版/连通性工具（纯函数模块）。
 * - groupComponentsByConnectivity：按有效边（忽略 disconnected）构建无向邻接表，
 *   划分连通分量与孤立节点，供链分组/上游上下文等消费。
 * - computeForceLayout：稳定落定式力导向排版（Obsidian 知识图谱观感）。NodeMap 用它在
 *   单焦点画布下表达"节点间关系"，而非反射画布坐标（画布节点随聚焦收起而跳动，反射无意义）。
 *   （2026-09-06：NodeMap 的 relayoutTree 整树排版已随"画布无平移/单焦点"交互下线；
 *   groupComponentsByConnectivity 仍被 chain-utils 使用，computeForceLayout 供 NodeMap 消费。）
 *
 * 纯函数约束：
 * - 不读 DOM、不读 gateway store、不写任何副作用
 * - 所有外部信息（节点/边）都通过参数注入
 * - 确定性：同输入必同输出（排序节点 + 确定性初始化 + 收敛遍历），供 useMemo 缓存防抖动
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

/** computeForceLayout 结果：节点中心坐标 + 整体包围盒（供 NodeMap 缩放适配） */
export interface ForceLayoutResult {
  positions: Record<string, { cx: number; cy: number }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface ForceLayoutOptions {
  /** 边弹簧静止长度（世界单位）；同时作为两两最小间距基准，保证圆点不重叠 */
  spacing?: number;
  /** 力导向收敛迭代上限（大图自动降档以保流畅） */
  iterations?: number;
  /** 包围盒四周留白（世界单位） */
  padding?: number;
  /**
   * 上次落定位置（锚点增量）。传入后进入"锚定模式"：
   *  - 仍存在的节点保持上次位置不动（纯边增删不改布局，只有节点增删才调整）；
   *  - 新增节点依据其连接邻居的锚点位置做初始落位 + 局部松弛，
   *    即"拉线后位置不变化"；只对新增节点做局部增量调整。
   *  （首次/空时缺省 → 全量力导向排版。）
   */
  previousPositions?: Record<string, { cx: number; cy: number }>;
}

/**
 * 稳定落定式力导向排版（Obsidian 知识图谱观感）：
 *  - 力模型：全对斥力（kRep/d²）+ 连边弹簧（kSpr·(d-rest)）+ 组件质心重力（防发散）；
 *  - 确定性：节点按 id 排序后圆环初始化，收敛遍历，杜绝 Math.random/时间戳，同输入必同输出；
 *  - 跨分量：复用 groupComponentsByConnectivity 把不连通子图分簇排版，再纵向堆叠隔离，
 *    孤立节点作为单节点簇处理，保证互不重叠；
 *  - 兜底：排版后做一轮最小间距推挤（minSep=spacing），彻底杜绝同点重叠。
 *
 * 返回的 positions 键为节点 id，值即圆点中心（世界单位，后续由调用方缩放适配）。
 */
export function computeForceLayout(
  nodes: GraphNodeInfo[],
  edges: GraphEdgeInfo[],
  opts: ForceLayoutOptions = {},
): ForceLayoutResult {
  const { spacing = 44, iterations = 200, padding = 20, previousPositions } = opts;
  // 批注框（annotation）不参与排版（与 NodeMap 圆点口径一致）
  const layoutNodes = nodes.filter((n) => n.type !== 'annotation');
  if (layoutNodes.length === 0) {
    return { positions: {}, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  }

  const idSet = new Set(layoutNodes.map((n) => n.id));
  const activeEdges = edges.filter((e) => !e.disconnected && idSet.has(e.source) && idSet.has(e.target));

  // 锚定模式：上次已有部分节点落定 → 保持这些位置不动，仅对新增节点做局部增量布局。
  // 纯边增删（拉线/断边）不改动已落定位置，解决"拉线后位置会发生变化"。
  const prevKeys = previousPositions ? Object.keys(previousPositions) : [];
  const hasAnchor = prevKeys.some((id) => idSet.has(id));
  if (hasAnchor) {
    const arranged = anchoredLayout(
      layoutNodes,
      activeEdges,
      previousPositions as Record<string, { cx: number; cy: number }>,
      spacing,
      iterations,
    );
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of layoutNodes) {
      const p = arranged[n.id];
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const positions: Record<string, { cx: number; cy: number }> = {};
    for (const n of layoutNodes) nodesToPositions(positions, arranged, n.id);
    return { positions, bounds: { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding } };
  }

  const { components, isolated } = groupComponentsByConnectivity(layoutNodes, edges);

  // 簇集合：连通分量 + 孤立节点（各自成簇）；按最小 id 排序保证跨运行确定性
  const clusters: string[][] = [
    ...components.map((c) => [...c].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
    ...isolated.map((id) => [id]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  ];

  // 逐簇排版（局部、以质心为原点），收集簇内包围盒
  const clusterResults = clusters.map((ids) => {
    const localEdges = activeEdges.filter((e) => ids.includes(e.source) && ids.includes(e.target));
    const localPos = layoutCluster(ids, localEdges, spacing, iterations);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = localPos[id];
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { ids, localPos, bbox: { minX, minY, maxX, maxY } };
  });

  // 合成：每簇横向居中对齐（x=0），纵向堆叠集群，簇间留 gap，保证跨分量不重叠
  const clusterGap = spacing * 1.5;
  const arranged: Record<string, { x: number; y: number }> = {};
  let cursorY = 0;
  for (const cr of clusterResults) {
    const h = cr.bbox.maxY - cr.bbox.minY;
    const offsetX = -(cr.bbox.minX + cr.bbox.maxX) / 2;
    const offsetY = cursorY - cr.bbox.minY;
    for (const id of cr.ids) {
      const p = cr.localPos[id];
      arranged[id] = { x: p.x + offsetX, y: p.y + offsetY };
    }
    cursorY += h + clusterGap;
  }

  // 兜底最小间距推挤：保证任意两圆点世界间距 ≥ spacing（含跨簇）
  separate(arranged, layoutNodes.map((n) => n.id), spacing);

  // 汇总包围盒 + 留白
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of layoutNodes.map((n) => n.id)) {
    const p = arranged[id];
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }

  const positions: Record<string, { cx: number; cy: number }> = {};
  for (const n of layoutNodes) nodesToPositions(positions, arranged, n.id);
  return { positions, bounds: { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding } };
}

/** 单簇力导向求解：全对斥力 + 连边弹簧 + 质心重力，速度阻尼收敛，返回簇内局部坐标（质心为原点） */
function layoutCluster(
  nodeIds: string[],
  localEdges: { source: string; target: string }[],
  spacing: number,
  iterations: number,
): Record<string, { x: number; y: number }> {
  const ids = [...nodeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = ids.length;
  const out: Record<string, { x: number; y: number }> = {};
  if (n === 1) {
    out[ids[0]] = { x: 0, y: 0 };
    return out;
  }

  const idx = new Map<string, number>();
  ids.forEach((id, i) => idx.set(id, i));
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  // 确定性圆环初始化：按序均布圆周，半径随规模增长（保证稠密但稳定）
  const initR = (spacing * Math.sqrt(n)) / 2;
  ids.forEach((id, i) => {
    const angle = (i / n) * Math.PI * 2;
    px[i] = Math.cos(angle) * initR;
    py[i] = Math.sin(angle) * initR;
  });

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const kRep = spacing * spacing;
  const kSpr = 0.06;
  const kGrav = 0.004;
  // 大图降档保流畅：n 越大迭代越少
  const iters = n > 120 ? 80 : iterations;
  let alpha = 1;
  const alphaDecay = 0.96;

  for (let iter = 0; iter < iters; iter++) {
    fx.fill(0);
    fy.fill(0);
    // 全对斥力
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) {
          dx = 0.01 * (i - j) || 0.01;
          dy = 0.01;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = (kRep / d2) * alpha;
        const ux = dx / d;
        const uy = dy / d;
        fx[i] += ux * f; fy[i] += uy * f;
        fx[j] -= ux * f; fy[j] -= uy * f;
      }
    }
    // 连边弹簧（斥力向 rest 收敛）
    for (const e of localEdges) {
      const a = idx.get(e.source);
      const b = idx.get(e.target);
      if (a === undefined || b === undefined) continue;
      const dx = px[b] - px[a];
      const dy = py[b] - py[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = kSpr * (d - spacing) * alpha;
      const ux = dx / d;
      const uy = dy / d;
      fx[a] += ux * f; fy[a] += uy * f;
      fx[b] -= ux * f; fy[b] -= uy * f;
    }
    // 质心重力（防止分量整体漂移/发散）
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += px[i]; cy += py[i]; }
    cx /= n; cy /= n;
    for (let i = 0; i < n; i++) {
      fx[i] += (cx - px[i]) * kGrav * alpha;
      fy[i] += (cy - py[i]) * kGrav * alpha;
    }
    // 积分 + 速度阻尼
    for (let i = 0; i < n; i++) {
      vx[i] = (vx[i] + fx[i]) * 0.85;
      vy[i] = (vy[i] + fy[i]) * 0.85;
      px[i] += vx[i];
      py[i] += vy[i];
    }
    alpha *= alphaDecay;
    if (alpha < 0.015) break;
  }

  ids.forEach((id, i) => { out[id] = { x: px[i], y: py[i] }; });
  return out;
}

/**
 * 锚定增量布局：上次已落定的节点保持位置不动，仅为新增节点依据其连接邻居落位并局部松弛。
 *  - 锚点（prev 中仍存在的节点）视为不可移动的固定点，只对新节点施力；
 *  - 新节点初始位置：取其已连接邻居锚点的质心 + 确定性偏移；无邻居则围绕整体质心环形落位；
 *  - 松弛迭代只更新新节点（全对斥力 + 连边弹簧 + 轻质心重力），锚点不受影响；
 *  - 兜底：只把新节点推离过近的任何节点（锚点不动），保证不重叠。
 * 返回世界坐标 {x,y}，键覆盖全部 layoutNodes。
 */
function anchoredLayout(
  layoutNodes: GraphNodeInfo[],
  edges: { source: string; target: string }[],
  prev: Record<string, { cx: number; cy: number }>,
  spacing: number,
  iterations: number,
): Record<string, { x: number; y: number }> {
  const idSet = new Set(layoutNodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }

  const pos = new Map<string, { x: number; y: number }>();
  const fixed = new Set<string>();
  const newIds: string[] = [];
  for (const n of layoutNodes) {
    const a = prev[n.id];
    if (a) { pos.set(n.id, { x: a.cx, y: a.cy }); fixed.add(n.id); }
    else newIds.push(n.id);
  }
  newIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // 整体质心（锚点质心，用于孤立新节点与轻度重力）
  let gx = 0, gy = 0, fc = 0;
  for (const id of fixed) { const p = pos.get(id)!; gx += p.x; gy += p.y; fc++; }
  if (fc > 0) { gx /= fc; gy /= fc; }

  // 新节点初始落位：依连接邻居质心 + 确定性偏移；无邻居则围绕整体质心环形落位
  for (const id of newIds) {
    const neigh = adj.get(id);
    let baseX = gx, baseY = gy;
    if (neigh && neigh.size > 0) {
      let sx = 0, sy = 0, cnt = 0;
      for (const nb of neigh) {
        const np = pos.get(nb);
        if (np) { sx += np.x; sy += np.y; cnt++; }
      }
      if (cnt > 0) { baseX = sx / cnt; baseY = sy / cnt; }
    }
    const ang = (hashString(id) / 0xffffffff) * Math.PI * 2;
    pos.set(id, { x: baseX + Math.cos(ang) * spacing, y: baseY + Math.sin(ang) * spacing });
  }

  // 若无新增节点，直接返回锚点位置（纯边增删场景）
  if (newIds.length === 0) {
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of layoutNodes) out[n.id] = { x: pos.get(n.id)!.x, y: pos.get(n.id)!.y };
    return out;
  }

  // 松弛：只更新新节点位移，锚点保持固定
  const vx = new Float64Array(newIds.length);
  const vy = new Float64Array(newIds.length);
  const kRep = spacing * spacing;
  const kSpr = 0.06;
  const kGrav = 0.004;
  const iters = Math.min(iterations, newIds.length > 60 ? 60 : 80);
  let alpha = 1;
  const alphaDecay = 0.9;
  for (let iter = 0; iter < iters; iter++) {
    const fx = new Float64Array(newIds.length);
    const fy = new Float64Array(newIds.length);
    for (let i = 0; i < newIds.length; i++) {
      const id = newIds[i];
      const p = pos.get(id)!;
      // 全对斥力（对所有节点，包括固定节点——固定节点受力但不移动）
      for (const n of layoutNodes) {
        if (n.id === id) continue;
        const q = pos.get(n.id)!;
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { dx = 0.01; dy = 0.01; d2 = 2e-4; }
        const d = Math.sqrt(d2);
        const f = (kRep / d2) * alpha;
        fx[i] += (dx / d) * f;
        fy[i] += (dy / d) * f;
      }
      // 连边弹簧（把新节点拉向邻居）
      const neigh = adj.get(id);
      if (neigh) {
        for (const nb of neigh) {
          const q = pos.get(nb);
          if (!q) continue;
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const f = kSpr * (d - spacing) * alpha;
          fx[i] += (dx / d) * f;
          fy[i] += (dy / d) * f;
        }
      }
      // 轻度质心重力：防新节点整体漂移发散
      fx[i] += (gx - p.x) * kGrav * alpha;
      fy[i] += (gy - p.y) * kGrav * alpha;
    }
    for (let i = 0; i < newIds.length; i++) {
      vx[i] = (vx[i] + fx[i]) * 0.85;
      vy[i] = (vy[i] + fy[i]) * 0.85;
      const p = pos.get(newIds[i])!;
      p.x += vx[i];
      p.y += vy[i];
    }
    alpha *= alphaDecay;
    if (alpha < 0.015) break;
  }

  // 兜底：仅推挤新节点保证与任意节点不重叠（固定节点不动）
  separateAnchored(pos, fixed, newIds, spacing);

  const out: Record<string, { x: number; y: number }> = {};
  for (const n of layoutNodes) out[n.id] = { x: pos.get(n.id)!.x, y: pos.get(n.id)!.y };
  return out;
}

/** 锚定推挤：只移动非锚点（新增）节点，把过近（< minSep）的点推开；锚点保持不动 */
function separateAnchored(
  pos: Map<string, { x: number; y: number }>,
  fixed: Set<string>,
  movableIds: string[],
  minSep: number,
): void {
  const minSepSq = minSep * minSep;
  const allIds = [...fixed, ...movableIds];
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (const a of movableIds) {
      const pa = pos.get(a)!;
      for (const b of allIds) {
        if (a === b) continue;
        const pb = pos.get(b)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minSepSq) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {
          const hash = hashString(a + '|' + b);
          const ang = (hash / 0xffffffff) * Math.PI * 2;
          d = 1;
          pa.x += Math.cos(ang);
          pa.y += Math.sin(ang);
          moved = true;
          continue;
        }
        const push = minSep - d;
        const ux = dx / d;
        const uy = dy / d;
        pa.x += ux * push;
        pa.y += uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** 最小间距推挤：迭代把彼此过近（< minSep）的点对称推开，直到不再靠近或轮次上限 */
function separate(
  positions: Record<string, { x: number; y: number }>,
  ids: string[],
  minSep: number,
): void {
  const minSepSq = minSep * minSep;
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      const a = positions[ids[i]];
      for (let j = i + 1; j < ids.length; j++) {
        const b = positions[ids[j]];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minSepSq) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {
          // 完全重合：用节点 id 哈希衍生一个确定性的分离方向
          const hash = hashString(ids[i] + '|' + ids[j]);
          const ang = (hash / 0xffffffff) * Math.PI * 2;
          d = 1;
          a.x += Math.cos(ang); a.y += Math.sin(ang);
          b.x -= Math.cos(ang); b.y -= Math.sin(ang);
          moved = true;
          continue;
        }
        const push = (minSep - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        a.x += ux * push; a.y += uy * push;
        b.x -= ux * push; b.y -= uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** 写入 positions（fmt 为 cx/cy 布局坐标） */
function nodesToPositions(
  positions: Record<string, { cx: number; cy: number }>,
  arranged: Record<string, { x: number; y: number }>,
  id: string,
): void {
  const p = arranged[id];
  if (p) positions[id] = { cx: p.x, cy: p.y };
}

/** 确定性字符串哈希（FNV-1a 变体），用于稳定方位派生，避免 Math.random */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
