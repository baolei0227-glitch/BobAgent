/**
 * NodeMap 自动排版算法（纯函数模块）。
 *  - 按有效边（child/parallel/vertical 父子语义）构建树：根（无父）在首层，子逐层向右展开
 *  - 同一父节点的多个子节点垂直并排（子树垂直居中于父节点右侧），层间距固定
 *  - fan-in 多父共享节点独立放置：从普通树剥离，水平居中于所有父之间（x=父层最右缘下一层，
 *    y=父们中心，均按节点实际高度计算并做碰撞避让，兼容放大/缩小不同状态）
 *  - 未覆盖节点兜底追加到最底部一行
 *  - 多连通分量（互不相连的子图）按首节点原始 (y, x) 纵向堆叠
 *  - 整体以「当前视口中心」为锚点偏移：排版后所有节点整齐排列在用户当前看到的画布中间
 *
 * 纯函数约束：
 *  - 不读 DOM、不读 gateway store、不写任何副作用
 *  - 所有外部信息（节点/边/视口/画布尺寸）都通过参数注入
 *  - 返回 positions + bounds，调用方决定如何应用（写回 state、fitBounds 等）
 */
import type { GraphNodeInfo, GraphEdgeInfo } from './graph-gateway';

export interface NodemapLayoutResult {
  /** nodeId → 新的世界坐标 {x, y}（左上角） */
  positions: Record<string, { x: number; y: number }>;
  /** 整图包围盒（世界坐标，含 400×400 占位尺寸），可直接用于 fitBounds */
  bounds: { x: number; y: number; width: number; height: number };
}

export interface NodemapLayoutOpts {
  /** 视口 transform：x/y=画布平移到屏幕左上，zoom=当前缩放 */
  viewport: { x: number; y: number; zoom: number };
  /** ReactFlow pane 可视区像素尺寸（不缩放的原始像素）。调用方取 wrapperRef.clientWidth/Height */
  paneW: number;
  /** ReactFlow pane 可视区像素高度 */
  paneH: number;
  /** 整体水平对齐：'center' = 居中到可视区中心（默认）；'left' = 节点链贴可视区左缘（右侧留白） */
  horizontalAlign?: 'center' | 'left';
  /** horizontalAlign='left' 时，节点链左边缘距可视区左缘的屏幕像素边距（默认 48） */
  leftPadding?: number;
  /** 可选间距覆写：锁定（100% zoom）下传更紧凑的数值让一屏显示更多链 */
  gaps?: {
    /** 连通分量之间的纵向堆叠间距（默认 240） */
    componentGap?: number;
    /** 主/子节点层间纵向间距（默认 120） */
    verticalGap?: number;
    /** 同层节点横向间距（默认 60） */
    horizontalGap?: number;
  };
}

const NODE_W = 400;
/** 节点槽位高度占位：优先用 GraphNodeInfo.measuredHeight（节点实际收起高度），未测量回退本值。
 *  兄弟子节点垂直并排间距 = 各节点实际高度 + horizontalGap，避免固定 400 把 Fit 结果撑太稀。 */
const NODE_H = 400;
const DEFAULT_H_GAP = 20;        // 同层节点横向间距（水平树：兄弟/子节点垂直并排间距）
const DEFAULT_V_GAP = 40;       // 父子层纵向间距（水平树：父子层水平间距）
const DEFAULT_COMPONENT_GAP = 64; // 连通分量之间的纵向堆叠间距

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

export function relayoutTree(
  nodes: GraphNodeInfo[],
  edges: GraphEdgeInfo[],
  opts: NodemapLayoutOpts,
): NodemapLayoutResult | null {
  if (nodes.length === 0) return null;

  const { viewport: vp, paneW, paneH } = opts;
  // 实际使用的间距：允许调用方（锁定状态）传紧凑覆写，默认走 DEFAULT_*
  const H_GAP = opts.gaps?.horizontalGap ?? DEFAULT_H_GAP;
  const V_GAP = opts.gaps?.verticalGap ?? DEFAULT_V_GAP;
  const COMPONENT_GAP = opts.gaps?.componentGap ?? DEFAULT_COMPONENT_GAP;
  // 排版锚点 = 当前画布可视区域中心（世界坐标）：重排后的节点整体居中到这里
  // RF 视口变换：screenX = worldX * zoom + vp.x → worldCenterX = (paneW/2 - vp.x) / zoom
  const anchorCx = (paneW / 2 - vp.x) / vp.zoom;
  const anchorCy = (paneH / 2 - vp.y) / vp.zoom;

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const activeEdges = edges.filter((e) => !e.disconnected);
  /** 节点槽位高度：优先用实际收起高度（避免固定 400 把兄弟间距撑太大），未测量回退占位 */
  const nodeH = (id: string): number => {
    const n = nodesById.get(id);
    const h = n?.measuredHeight;
    return Number.isFinite(h) && (h ?? 0) > 0 ? (h as number) : NODE_H;
  };

  // 连通分量只算一次：分量排版 + 孤立节点 rest 共用结果，避免对同一 nodes/edges 跑两遍 BFS
  const connectivity = groupComponentsByConnectivity(nodes, edges);
  const { components } = connectivity;

  // ————— 工具：对一组连通的节点做局部树排版（placeTree + 分量内 rest） —————
  type LocalLayout = {
    localPos: Map<string, { x: number; y: number }>;
    headId: string;
    minLocalX: number; maxLocalX: number; minLocalY: number; maxLocalY: number;
  };
  const applyComponentLayout = (compIds: string[]): LocalLayout => {
    const idSet = new Set(compIds);
    const compNodes = compIds.map((id) => nodesById.get(id)!).filter(Boolean);
    const compEdges = activeEdges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

    const childMap = new Map<string, string[]>();
    for (const e of compEdges) {
      if (!childMap.has(e.source)) childMap.set(e.source, []);
      childMap.get(e.source)!.push(e.target);
    }
    // 同一父节点的子节点按原始位置（y 上→下，再 x 左→右）排序——
    // 纵向并排顺序必须与画布直觉一致，而不是依赖边数组的随机遍历顺序
    for (const [p, kids] of childMap) {
      childMap.set(p, [...new Set(kids)].sort((a, b) => {
        const na = nodesById.get(a);
        const nb = nodesById.get(b);
        if (!na || !nb) return 0;
        return (na.y - nb.y) || (na.x - nb.x);
      }));
    }
    const normalIds = new Set(compNodes.map((n) => n.id));
    const hasParent = new Set(compEdges.map((e) => e.target));
    const roots = compNodes
      .filter((n) => normalIds.has(n.id) && !hasParent.has(n.id))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))
      .map((n) => n.id);

    // ————— fan-in（多父共享节点）识别：被 ≥2 个分量内普通父引用的目标节点 —————
    // 普通树无法正确放置它们（placeTreeH 只随首个父、其他父连线拉空），
    // 因此从父侧移除、由下方 fan-in 块独立"水平居中于所有父之间"放置。
    const fanInParents = new Map<string, string[]>();
    for (const e of compEdges) {
      if (!normalIds.has(e.source) || !normalIds.has(e.target)) continue;
      if (!fanInParents.has(e.target)) fanInParents.set(e.target, []);
      fanInParents.get(e.target)!.push(e.source);
    }
    const fanInIds = new Set<string>();
    for (const [t, ps] of fanInParents) if (ps.length >= 2) fanInIds.add(t);
    if (fanInIds.size > 0) {
      for (const [p, kids] of childMap) {
        const filtered = kids.filter((k) => !fanInIds.has(k));
        if (filtered.length !== kids.length) childMap.set(p, filtered);
      }
    }

    // ————— 水平树排版：父在左、子向右逐层展开；同父多子垂直并排，父垂直居中于其子树 —————
    // 层间距（x 方向）用 V_GAP（原"层间纵向"），同层/兄弟并排（y 方向）用 H_GAP（原"同层横向"），
    // 保持视觉密度语义不变。子树高度 = max(子节点总高, 本体 NODE_H)。
    const subtreeH = new Map<string, number>();
    const computingH = new Set<string>();
    const calcH = (id: string): number => {
      if (subtreeH.has(id)) return subtreeH.get(id)!;
      if (computingH.has(id)) return nodeH(id);
      computingH.add(id);
      const kids = childMap.get(id) ?? [];
      const total = kids.length > 0
        ? kids.reduce((s, k) => s + calcH(k), 0) + (kids.length - 1) * H_GAP
        : 0;
      const h = Math.max(total, nodeH(id));
      subtreeH.set(id, h);
      computingH.delete(id);
      return h;
    };
    for (const id of normalIds) if (!subtreeH.has(id)) calcH(id);
    for (const id of normalIds) if (!subtreeH.has(id)) subtreeH.set(id, nodeH(id));

    const localPos = new Map<string, { x: number; y: number }>();
    /** 水平放置子树：节点本体 x = depth*(NODE_W+V_GAP)，子节点在其右侧垂直并排；返回子树槽底 y */
    const placeTreeH = (id: string, depth: number, offsetY: number): number => {
      if (localPos.has(id)) return offsetY + (subtreeH.get(id) ?? nodeH(id));
      const x = depth * (NODE_W + V_GAP); // 层深 → 水平向右
      const kids = childMap.get(id) ?? [];
      if (kids.length === 0) {
        localPos.set(id, { x, y: offsetY });
        return offsetY + nodeH(id);
      }
      const heights = kids.map((k) => subtreeH.get(k) ?? nodeH(k));
      const totalH = heights.reduce((s, h) => s + h, 0) + (kids.length - 1) * H_GAP;
      // 本体垂直居中于子节点范围
      const bodyTop = offsetY + Math.max(0, (totalH - nodeH(id)) / 2);
      localPos.set(id, { x, y: bodyTop });
      let cy = offsetY;
      for (let i = 0; i < kids.length; i++) {
        placeTreeH(kids[i], depth + 1, cy);
        cy += heights[i] + H_GAP;
      }
      return offsetY + Math.max(totalH, nodeH(id));
    };
    let gy = 0;
    for (const r of roots) gy = placeTreeH(r, 0, gy) + H_GAP;

    // ————— fan-in 共享节点放置：水平居中于所有父之间 —————
    // 普通树已给出各父位置；共享节点（被 ≥2 个父引用）连同其子树整体放在父层最右缘
    // 的下一层（x），垂直居中于父们中心（y）。节点放大/缩小的不同状态经 nodeH()（实际
    // 高度）计入：父中心、子树总高、碰撞避让均按各节点真实高度计算，展开/收起不会重叠。
    if (fanInIds.size > 0) {
      // 子树整体向下避让已放置节点（纯 AABB，最多 40 轮）
      const avoidDown = (
        rect: { x: number; y: number; w: number; h: number },
        obstacles: Array<{ x: number; y: number; w: number; h: number }>,
      ): number => {
        let dy = 0;
        for (let i = 0; i < 40; i++) {
          const m = { x: rect.x, y: rect.y + dy, w: rect.w, h: rect.h };
          let need = 0;
          for (const o of obstacles) {
            if (m.x < o.x + o.w && m.x + m.w > o.x && m.y < o.y + o.h && m.y + m.h > o.y) {
              need = Math.max(need, o.y + o.h + V_GAP - m.y);
            }
          }
          if (need <= 0) return dy;
          dy += need;
        }
        return dy;
      };
      // 处理顺序：父们已就位的先放（父可能是另一 fan-in 节点，需等它先放）；死锁时强制放第一个
      let pendingFanIn = [...fanInIds].sort(
        (a, b) => ((nodesById.get(a)?.y ?? 0) - (nodesById.get(b)?.y ?? 0)) || ((nodesById.get(a)?.x ?? 0) - (nodesById.get(b)?.x ?? 0)),
      );
      let guard = 0;
      while (pendingFanIn.length > 0 && guard < fanInIds.size * 2 + 2) {
        const ready = pendingFanIn.filter((s) =>
          (fanInParents.get(s) ?? []).every((p) => localPos.has(p)),
        );
        const batch = ready.length > 0 ? ready : [pendingFanIn[0]];
        for (const s of batch) {
          const parents = (fanInParents.get(s) ?? [])
            .filter((p) => localPos.has(p))
            .map((p) => ({ id: p, pos: localPos.get(p)! }));
          if (parents.length === 0) {
            localPos.set(s, { x: 0, y: 0 });
            continue;
          }
          const maxParentRight = Math.max(...parents.map(({ pos }) => pos.x)) + NODE_W;
          // 水平位置取"父层右缘"与"父们直接子列右缘"的较大者再 +V_GAP：
          // 父们若已有私有子列占据父层右侧（childMap 已过滤 fan-in 目标，此处只含私有子），
          // 共享节点放到子列之后，避免与私有子列碰撞触发向下避让、破坏"垂直居中于父们"
          let maxRight = maxParentRight;
          for (const { id } of parents) {
            for (const k of childMap.get(id) ?? []) {
              const kp = localPos.get(k);
              if (kp) maxRight = Math.max(maxRight, kp.x + NODE_W);
            }
          }
          const sX = maxRight + V_GAP;
          const parentCy = parents.reduce((sum, { id, pos }) => sum + (pos.y + nodeH(id) / 2), 0) / parents.length;
          const subTotalH = subtreeH.get(s) ?? nodeH(s);
          const sY = parentCy - subTotalH / 2;
          const before = new Set(localPos.keys());
          placeTreeH(s, 0, sY); // 以 s 为根排子树（s.x=0，子树向右展开）
          // 平移：s.x → sX（父层右侧下一层，即"水平居中于所有父之间"）
          const dx = sX - localPos.get(s)!.x;
          const moved: Array<{ id: string; x: number; y: number; h: number }> = [];
          for (const [id, c] of localPos) {
            if (before.has(id)) continue;
            c.x += dx;
            moved.push({ id, x: c.x, y: c.y, h: nodeH(id) });
          }
          // 碰撞避让：s 子树整体向下避开已放置节点（障碍含普通树与已排分身）
          if (moved.length > 0) {
            const rect = {
              x: Math.min(...moved.map((m) => m.x)),
              y: Math.min(...moved.map((m) => m.y)),
              w: Math.max(...moved.map((m) => m.x + NODE_W)) - Math.min(...moved.map((m) => m.x)),
              h: Math.max(...moved.map((m) => m.y + m.h)) - Math.min(...moved.map((m) => m.y)),
            };
            const obstacles: Array<{ x: number; y: number; w: number; h: number }> = [];
            for (const [id, c] of localPos) {
              if (before.has(id)) obstacles.push({ x: c.x, y: c.y, w: NODE_W, h: nodeH(id) });
            }
            const dy = avoidDown(rect, obstacles);
            if (dy > 0) {
              for (const m of moved) {
                localPos.get(m.id)!.y += dy;
              }
            }
          }
        }
        pendingFanIn = pendingFanIn.filter((s) => !batch.includes(s));
        guard++;
      }
    }

    // 分量内 rest：placeTreeH 没排到的节点（如边不是父子结构导致）
    const compRest = compNodes
      .filter((n) => !localPos.has(n.id))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    if (compRest.length > 0) {
      let maxY = 0, mnX = Infinity, mxX = -Infinity;
      for (const c of localPos.values()) {
        maxY = Math.max(maxY, c.y);
        mnX = Math.min(mnX, c.x);
        mxX = Math.max(mxX, c.x + NODE_W);
      }
      const bottomY = localPos.size === 0 ? 0 : maxY + NODE_H + V_GAP;
      const colCx = localPos.size === 0 ? NODE_W / 2 : (mnX + mxX) / 2;
      const colX = colCx - NODE_W / 2;
      let restY = bottomY;
      for (const rn of compRest) {
        localPos.set(rn.id, { x: colX, y: restY });
        restY += nodeH(rn.id) + V_GAP;
      }
    }

    // bounds + headId
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (const [id, c] of localPos) {
      mnX = Math.min(mnX, c.x);
      mnY = Math.min(mnY, c.y);
      mxX = Math.max(mxX, c.x + NODE_W);
      mxY = Math.max(mxY, c.y + nodeH(id));
    }
    let headId = roots[0];
    if (!headId) {
      let bestId = compIds[0]; let bestY = Infinity;
      for (const [id, c] of localPos) if (c.y < bestY) { bestY = c.y; bestId = id; }
      headId = bestId;
    }
    return { localPos, headId, minLocalX: mnX, maxLocalX: mxX, minLocalY: mnY, maxLocalY: mxY };
  };

  // ————— 分量级排序：按首节点原始 (y, x) —————
  const laidComponents = components.map((ids): { layout: LocalLayout; headOriginalY: number; headOriginalX: number } => {
    const layout = applyComponentLayout(ids);
    const hn = nodesById.get(layout.headId);
    return { layout, headOriginalY: hn?.y ?? 0, headOriginalX: hn?.x ?? 0 };
  });
  laidComponents.sort((a, b) => (a.headOriginalY - b.headOriginalY) || (a.headOriginalX - b.headOriginalX));

  // ————— 分量纵向堆叠：每分量首节点水平中心对齐 anchorCx —————
  const globalPos = new Map<string, { x: number; y: number }>();
  let cursorY = 0;
  for (const item of laidComponents) {
    const { layout } = item;
    const headLocal = layout.localPos.get(layout.headId)!;
    const headLocalCx = headLocal.x + NODE_W / 2;
    const dx = anchorCx - headLocalCx;
    const dy = cursorY - layout.minLocalY;
    for (const [id, c] of layout.localPos) {
      globalPos.set(id, { x: c.x + dx, y: c.y + dy });
    }
    const compMaxY = cursorY + (layout.maxLocalY - layout.minLocalY);
    cursorY = compMaxY + COMPONENT_GAP;
  }

  // ————— 全局 rest：孤立节点纵向一列，列中心同 anchorCx —————
  const { isolated } = connectivity;
  if (isolated.length > 0) {
    const isolatedNodes = isolated.map((id) => nodesById.get(id)!).filter(Boolean)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const colX = anchorCx - NODE_W / 2;
    const bottomY = cursorY === 0 ? 0 : cursorY;
    let isoY = bottomY;
    for (const n of isolatedNodes) {
      globalPos.set(n.id, { x: colX, y: isoY });
      isoY += nodeH(n.id) + V_GAP;
    }
  }

  // ————— 整体居中（水平 + 垂直）到锚点 —————
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [id, c] of globalPos) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + NODE_W);
    maxY = Math.max(maxY, c.y + nodeH(id));
  }
  if (isFinite(minX)) {
    const dy = anchorCy - (minY + maxY) / 2;
    // 水平对齐策略：'left' 时整图左边缘贴可视区左缘 + leftPadding（屏幕像素/zoom 转世界坐标），
    // 右侧留白便于查看后续展开内容；默认水平居中到锚点
    let dx: number;
    if (opts.horizontalAlign === 'left') {
      const leftPadWorld = (opts.leftPadding ?? 48) / vp.zoom;
      dx = (0 - vp.x) / vp.zoom + leftPadWorld - minX;
    } else {
      dx = anchorCx - (minX + maxX) / 2;
    }
    for (const c of globalPos.values()) { c.x += dx; c.y += dy; }
    // 重新计算包围盒（整体平移后数值不变，但防御性再算一次）
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const [id, c] of globalPos) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + NODE_W);
      maxY = Math.max(maxY, c.y + nodeH(id));
    }
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, c] of globalPos) {
    // 取整：避免排版产生半像素坐标，节点文字在子像素位置上会持续发虚（GPU 光栅化糊）
    positions[id] = { x: Math.round(c.x), y: Math.round(c.y) };
  }
  return {
    positions,
    bounds: isFinite(minX)
      ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
      : { x: 0, y: 0, width: 0, height: 0 },
  };
}
