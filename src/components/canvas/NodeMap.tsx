'use client';

import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { Pin, Tags, Orbit } from 'lucide-react';
import type { GraphGateway, NodeKind } from '@/lib/graph/graph-gateway';
import { computeRadialLayout } from '@/lib/graph/nodemap-layout';

/** 径向连线（辐条）：端点各取"圆心 → 对方圆心"方向上的圆缘点，控制点沿同方向等距内推。
 *  四点共线 → 观感是一条干净的直线辐条；辐射布局下不再像旧 Left/Right 锚点那样互相绕圈。
 *  @returns [pathD, midX, midY] —— SVG path 与 t=0.5 处中点（供"拖断把手"命中） */
function radialEdgePath(
  sx0: number, sy0: number,
  tx0: number, ty0: number,
  half: number,
): [string, number, number] {
  const dx = tx0 - sx0;
  const dy = ty0 - sy0;
  const len = Math.hypot(dx, dy);
  // 两圆心重合（异常/极近）：退化为一条极短直线，避免除零
  if (len < 0.001) return [`M${sx0},${sy0} L${tx0},${ty0}`, sx0, sy0];
  const ux = dx / len;
  const uy = dy / len;
  let sx = sx0 + ux * half;
  let sy = sy0 + uy * half;
  let tx = tx0 - ux * half;
  let ty = ty0 - uy * half;
  // 两个圆点相交（锚点越过对方圆心）时回落到圆心连线，避免端点反向
  if ((tx - sx) * ux + (ty - sy) * uy <= 0) {
    sx = sx0; sy = sy0; tx = tx0; ty = ty0;
  }
  const k = Math.hypot(tx - sx, ty - sy) * 0.25; // 控制点内推量（同旧 curvature 0.25 手感）
  const c1x = sx + ux * k, c1y = sy + uy * k;
  const c2x = tx - ux * k, c2y = ty - uy * k;
  const d = `M${sx},${sy} C ${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`;
  // 三次贝塞尔 t=0.5：P = (P0 + 3P1 + 3P2 + P3)/8
  const midX = (sx + 3 * c1x + 3 * c2x + tx) / 8;
  const midY = (sy + 3 * c1y + 3 * c2y + ty) / 8;
  return [d, midX, midY];
}

/** 单焦点画布：可被桌面"单节点 + 导航圆点"收纳的 AI 研究节点类型（与 CanvasFlow isFocusableResearch 同口径） */
function isFocusFlowType(type?: string): boolean {
  return type === 'aiChat' || type === 'aiCoding' || (!!type && type.startsWith('agent-'));
}

/** 名称浮层定位（圆点中心 → 面板 local 坐标）：优先落在圆点上方/下方（prefer），
 *  该侧放不下则翻到另一侧，并始终夹紧在面板可视区内（面板 overflow-hidden）。
 *  悬停浮层（prefer='above'）与常驻名称标签（prefer='below'）共用，避免两份定位数学漂移。 */
function labelBox(
  cx: number, cy: number, half: number,
  prefer: 'above' | 'below',
  w: number, h: number,
  containerW: number, containerH: number, pad: number,
): { left: number; top: number } {
  const gap = 6; // 浮层与圆点的间距
  const above = cy - half - gap - h;
  const below = cy + half + gap;
  const overflow = prefer === 'above' ? above < pad + 1 : below + h > containerH - pad - 1;
  let top = overflow ? (prefer === 'above' ? cy + half + gap + 1 : above) : prefer === 'above' ? above : below;
  let left = cx - w / 2;
  if (w) left = Math.min(Math.max(left, pad + 1), containerW - w - pad - 1);
  top = Math.min(Math.max(top, pad + 1), Math.max(pad + 1, containerH - h - pad - 1));
  return { left, top };
}

/** 迷你节点圆点几何基准：以固定 400×400 占位缩放，直径收敛到 [12,16]px——
 *  不随节点展开/收起跳动（保持快照固定占位语义），下限 12px 保证可辨识，
 *  上限 16px 收敛为醒目圆点，节点少时也更易按压、拖拽 */
const CARD_MIN = 12;
const CARD_MAX = 16;

/** 连接把手离开圆点的间距：把手落在圆点外缘，避免与圆点重叠、可独立抓取 */
const HANDLE_GAP = 8;

/** 建边吸附半径增量（屏幕像素）：拖线端点进入"目标圆点半径 + 该增量"范围内即吸附锁定目标，
 *  端点收拢到目标中心并点亮高亮环——不必精确定位到卡片上，接近即磁吸 */
const CONNECT_SNAP_PX = 10;

/** 迷你连线中点拖断判定阈值（屏幕像素）：地图空间小，比画布 30px 更灵敏 */
const EDGE_DRAG_THRESHOLD_PX = 12;

/** 建边出线方位（仅左右）：鼠标接触原点时，在圆点左右两缘各出现一个拖拽点；
 *  dx/dy 为单位方向向量，决定拖线起点落在圆点左缘还是右缘。 */
type ConnectSide = 'east' | 'west';
const CONNECT_SIDES: { id: ConnectSide; dx: number; dy: number }[] = [
  { id: 'east', dx: 1, dy: 0 },
  { id: 'west', dx: -1, dy: 0 },
];

/** 迷你连线中点编辑把手（复刻真实画布 FloatingEdge 交互，为 NodeMap 承担连线管理做准备）：
 *  - 激活连线：中点显示可拖拽圆点，hover 放大 + 光环，拖出阈值 → 断开（软删）；
 *  - 断开连线：中点 ✕ 徽标，点击 → 重连。
 *  父 svg 是 pointer-events-none，本把手显式 pointerEvents:auto 恢复命中；
 *  pointerdown stopPropagation 避免误触缩略图拖拽平移。 */
function EdgeHandle({ disconnected, show, midX, midY, onDisconnect, onReconnect, onLeave }: {
  disconnected: boolean;
  show: boolean;
  midX: number;
  midY: number;
  onDisconnect: () => void;
  onReconnect: () => void;
  onLeave: (e: React.PointerEvent<SVGElement>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  // 已断开：✕ 徽标，点击重连（与画布 FloatingEdge 断线徽标一致）
  if (disconnected) {
    return (
      <g
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onReconnect(); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ cursor: 'pointer', pointerEvents: 'auto' }}
      >
        <circle
          cx={midX}
          cy={midY}
          r={hovered ? 11 : 9}
          fill="oklch(0.97 0.015 80 / 0.95)"
          stroke="oklch(0.55 0.12 45 / 0.5)"
          strokeWidth={1.5}
          style={{ transition: 'r 0.12s' }}
        />
        <text
          x={midX}
          y={midY + 3}
          textAnchor="middle"
          fontSize={8}
          fontWeight={600}
          fill="oklch(0.50 0.15 25)"
          style={{ pointerEvents: 'none' }}
        >
          ✕
        </text>
        {hovered && <title>Click to reconnect</title>}
      </g>
    );
  }

  // 仅悬停命中连线时出现（未命中不渲染，避免每根线常驻中点圆点）
  if (!show) return null;

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerDown={(e) => {
        e.stopPropagation(); // 阻止缩略图平移启动
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        (e.currentTarget as SVGGElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const start = dragStartRef.current;
        if (!start) return;
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > EDGE_DRAG_THRESHOLD_PX) {
          dragStartRef.current = null;
          onDisconnect();
        }
      }}
      onPointerUp={() => { dragStartRef.current = null; }}
      // 离开把手时交由父级判断：若仍在同组连线内（线↔把手往返）则保持，彻底离开才清除
      onPointerLeave={onLeave}
      style={{ cursor: hovered ? 'grab' : 'default', pointerEvents: 'auto' }}
    >
      {/* 透明大圆：扩大命中/拖拽区 */}
      <circle cx={midX} cy={midY} r={hovered ? 14 : 9} fill="transparent" style={{ transition: 'r 0.12s' }} />
      {/* 中点圆：平时小点，hover 放大 + 主色描边 */}
      <circle
        cx={midX}
        cy={midY}
        r={hovered ? 6.5 : 4.5}
        fill={hovered ? 'oklch(0.97 0.015 80 / 0.95)' : 'oklch(0.97 0.015 80 / 0.7)'}
        stroke={hovered ? 'oklch(0.55 0.12 45 / 0.85)' : 'oklch(0.55 0.12 45 / 0.4)'}
        strokeWidth={1.5}
        style={{ transition: 'r 0.12s, fill 0.12s, stroke 0.12s' }}
      />
      {hovered && <title>Drag to disconnect</title>}
    </g>
  );
}

/** 节点地图 — 小圆点形式展示全部节点，并绘制节点间连线
 *  画布数据访问全部通过 gateway（GraphGateway 统一对接端口，太空舱理念），
 *  不直接触碰 ReactFlow store / window 事件总线。
 */
export function NodeMap({ gateway, title, projectId, focusedNodeId, collapsed, onCollapsedChange }: {
  gateway: GraphGateway;
  title?: string;
  /** 当前项目 id */
  projectId?: string;
  /** 当前打开的会话（研究）节点 id：焦点经左侧 rail / autoOpen / 删除回退等切换时，红点跟随同步 */
  focusedNodeId?: string | null;
  /** 展开/折叠受控：开关按钮已迁至左侧栏项目行（项目名右侧、新建会话按钮左侧），
   *  本组件不再渲染左下角悬浮开关按钮 */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [pinned, setPinned] = useState(false);
  /** 名称标签开关（标题栏按钮）：打开后所有圆点常驻显示名称浮层 */
  const [showAllLabels, setShowAllLabels] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  // 当前鼠标悬停的连线 id：命中连线后中点显示可拖拽"断开"把手；离开整组才清除
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  // 正在执行任务的节点 id 集合（AiChatNode 流式执行中广播 node-executing 事件）
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set());
  // 常驻状态提示（原左侧 rail 底部，2026-09-01 迁移至 NodeMap）：
  // 回执未读角标已统一到 ButlerOrb（订阅 butler:inbox-pending），本组件不再重复展示
  // 当前通过 NodeMap 聚焦放大的节点 id
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const zoomedIdRef = useRef<string | null>(null);
  // 保持 ref 与 state 同步，避免 stale closure 在事件回调中读到旧值
  zoomedIdRef.current = zoomedId;
  // 红点跟随当前打开的会话节点：焦点经左侧 rail / 自动打开 / 删除回退等切换（focusedNodeId 变化）时
  // 同步高亮。豁免类型（imageGen 等）不在 focusedNodeId 管理内，仍由本地 focusNode 高亮。
  useEffect(() => {
    if (focusedNodeId) setZoomedId(focusedNodeId);
  }, [focusedNodeId]);
  // 缩略图自身缩放倍率：固定最大档（2x），不再提供两档切换按钮（放大看局部布局）
  const mapZoom = 2;

  // ———— 拖拽建边（新连线）：卡片右侧连接锚点拖到另一张卡片松手即建边 ————
  //  connectFrom：当前拖出的源卡片 id；connectPos：指针在面板 local 坐标（临时线端点）；
  //  connectTarget：指针当前命中的目标卡片 id（高亮 + 松手建边目标）。
  //  落库语义复用画布 onConnect（edge-create-request → CanvasFlow 监听）：自动锁定上游源节点、
  //  /api/edges create、成功后经 gateway 快照自动回流；失败沿画布 alert 提示。
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [connectPos, setConnectPos] = useState<{ x: number; y: number } | null>(null);
  const [connectTarget, setConnectTarget] = useState<string | null>(null);
  // 建边拖拽进行中：暂存 from + 出边方位（left/right）供 pointer 事件消费（ref 避免 stale closure）
  const connectStateRef = useRef<{ from: string; side: ConnectSide } | null>(null);
  // 面板（卡片定位所在 .relative 容器）ref，pointer client 坐标 → 面板 local 坐标用
  const mapPaneRef = useRef<HTMLDivElement | null>(null);

  // ———— 圆点按住拖拽定位（手动调整位置，拖后落定不回弹）————
  //  dragDot：当前正在拖拽的圆点 + 实时世界坐标（拖动中跟随指针，驱动连线端点同步）；
  //  dragStartRef：拖拽起点（nodeId + 指针面板坐标 + 节点当前世界坐标 + 累计位移），供 move 算增量；
  //  dragLiveRef：当前实时世界坐标，供 endDrag 落定读取（避免读到过期的 dragDot state）。
  //  manualPositions：已落定的手动位置覆盖（本组件会话持久），优先于自动排版位置。
  const [dragDot, setDragDot] = useState<{ id: string; cx: number; cy: number } | null>(null);
  const [manualPositions, setManualPositions] = useState<Record<string, { cx: number; cy: number }>>({});
  const dragStartRef = useRef<{ nodeId: string; paneStart: { x: number; y: number }; worldStart: { cx: number; cy: number }; moved: number } | null>(null);
  const dragLiveRef = useRef<{ id: string; cx: number; cy: number } | null>(null);
  // 拖拽落定后抑制紧随的 click（避免拖完又触发聚焦），下一次 click 消费后复位
  const suppressClickRef = useRef(false);
  // 悬停标题浮层（圆点上方显示，避让左右拖拽把手）：ref 供挂载后测量宽高；
  // hoverTipSize 缓存实测尺寸，用于把浮层水平夹紧在面板可视区内
  const hoverTipRef = useRef<HTMLDivElement | null>(null);
  const [hoverTipSize, setHoverTipSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const tip = hoverTipRef.current;
    if (!tip) return;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    setHoverTipSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, [hoveredNodeId, connectFrom]);
  // 常驻名称标签尺寸实测：所有标签共用一个稳定 ref 回调（按 data-label-node 取 id），
  // 仅在实测尺寸变化时写入 state（尺寸相同则原样返回），据此完成居中/夹紧且不会形成渲染循环。
  const [labelSizes, setLabelSizes] = useState<Record<string, { w: number; h: number }>>({});
  const measureLabelRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const id = el.dataset.labelNode;
    if (!id) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setLabelSizes((prev) => {
      const cur = prev[id];
      if (cur && Math.abs(cur.w - w) < 0.5 && Math.abs(cur.h - h) < 0.5) return prev;
      return { ...prev, [id]: { w, h } };
    });
  }, []);
  // 连线悬停清除：若指针仍停留在此连线组内（线→中点把手等相邻元素），保持高亮；彻底离开才清除。
  // 复刻真实画布 FloatingEdge 的"线 + 中点把手"同组 hover 语义，避免把手消失/闪烁。
  const clearEdgeHover = (e: React.PointerEvent<SVGElement>) => {
    const t = e.relatedTarget as Element | null;
    if (t && t.closest('[data-edge-id]')) return;
    setHoveredEdgeId(null);
  };

  // ———— 节点标题链接图标"reveal"：展开 NodeMap 并高亮该节点及其连线（nodemap-reveal-node）————
  const [highlightNodeId, setHighlightNodeId] = useState<string | null>(null);
  useEffect(() => {
    const onReveal = (e: Event) => {
      const d = (e as CustomEvent<{ nodeId?: string }>).detail;
      if (!d?.nodeId) return;
      onCollapsedChange(false);
      setHighlightNodeId(d.nodeId);
    };
    window.addEventListener('nodemap-reveal-node', onReveal);
    return () => window.removeEventListener('nodemap-reveal-node', onReveal);
  }, [onCollapsedChange]);
  // 面板折叠时清除高亮（外部点击/收起后不再残留强调）
  useEffect(() => {
    if (collapsed) setHighlightNodeId(null);
  }, [collapsed]);

  // 订阅画布快照：节点/边变化时自动重渲染（gateway 内部按引用比较过滤无关更新）
  const { nodes, edges } = useSyncExternalStore(
    gateway.subscribe,
    gateway.getSnapshot,
    gateway.getSnapshot,
  );

  // 订阅节点执行状态：流式执行中/结束分别携带 executing=true/false（驱动执行中琥珀呼吸灯）
  useEffect(() => {
    return gateway.onNodeEvent((e) => {
      setExecutingIds((prev) => {
        const next = new Set(prev);
        if (e.executing) next.add(e.nodeId);
        else next.delete(e.nodeId);
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);
  const containerRef = useRef<HTMLDivElement>(null);

  // 展开时：点击地图外部任意处自动折叠。
  // 用 pointerdown 而非 click：pointerdown 先于 React 状态更新触发，
  // 此时折叠/展开按钮的 DOM 尚未被替换，contains 判断可靠，
  // 避免"点展开按钮立即被误判为点击外部而折叠"的竞态。
  useEffect(() => {
    if (collapsed || pinned) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (containerRef.current?.contains(target as Node)) return;
      // 左侧栏的开关按钮在容器之外：豁免它，否则 pointerdown 先折叠、紧随的 click 又展开，
      // 表现为"点按钮关不掉"（按钮自身负责切换，见 CanvasFlow 项目行）
      if (target?.closest?.('[data-nodemap-toggle]')) return;
      onCollapsedChange(true);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [collapsed, pinned, onCollapsedChange]);

  // 画布 zoom 恒 1（单焦点宿主 2026-09）：旧"zoom 偏离 1 时拉回"的 setViewport 死逻辑已移除。

  // 径向轨道排版（2026-09-17 起替代力导向）：
  // 关系（边）本身即排版依据 —— 增删连线会重新分环/分扇区，让"从哪个节点分出来"一眼可读；
  // 纯函数 + 确定性，故直接 useMemo 缓存（无锚点缓存/增量模式）。手动拖拽定位仍然优先（见下方覆盖）。
  const { dots, bounds, centers } = useMemo(() => {
    const layoutNodes = nodes.filter((n) => n.type !== 'annotation');
    if (layoutNodes.length === 0) {
      return { dots: [], bounds: null, centers: {} as Record<string, { cx: number; cy: number }> };
    }
    const { positions, bounds: fbounds } = computeRadialLayout(nodes, edges);
    // 手工拖拽 + 实时拖拽覆盖：手动定位优先于自动排版，拖拽中实时跟随、落定后持久不回落
    const effective: Record<string, { cx: number; cy: number }> = {};
    for (const id of Object.keys(positions)) effective[id] = positions[id];
    for (const id of Object.keys(manualPositions)) effective[id] = manualPositions[id];
    if (dragDot) effective[dragDot.id] = { cx: dragDot.cx, cy: dragDot.cy };
    const list: { id: string; cx: number; cy: number; name: string; kind: NodeKind }[] = [];
    const centerMap: Record<string, { cx: number; cy: number }> = {};
    for (const n of nodes) {
      // 批注框（annotation）不在地图上显示圆点（纯画布分组/思路视觉，非研究节点）
      if (n.type === 'annotation') continue;
      const p = effective[n.id];
      if (!p) continue;
      let kind: NodeKind = 'chat';
      if (n.sandboxAppId) kind = 'coding';
      list.push({ id: n.id, cx: p.cx, cy: p.cy, name: n.title, kind });
      centerMap[n.id] = { cx: p.cx, cy: p.cy };
    }
    if (list.length === 0) {
      return { dots: [], bounds: null, centers: {} as Record<string, { cx: number; cy: number }> };
    }
    return { dots: list, bounds: fbounds, centers: centerMap };
  }, [nodes, edges, manualPositions, dragDot]);

  // 聚焦/取消聚焦单个节点（地图圆点与目录项共用同一套状态机）
  // 单焦点画布（2026-09）：AI 研究节点点击 = 桌面切换到该节点（CanvasFlow 统一处理
  // 取消隐藏、展开、居中；其余研究节点自动隐藏）。NodeMap 红点跟随当前打开节点。
  // 归档节点不在此处理（恢复统一走左侧节点列）；非研究节点（imageGen/沙盒等）画布常驻，
  // 点击仅在地图内高亮跟随，不再放大/展开/移动视口。
  const focusNode = useCallback((nodeId: string) => {
    const snap = gateway.getSnapshot();
    const node = snap.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setZoomedId(nodeId);
    if (isFocusFlowType(node.type)) {
      window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId } }));
    } else {
      window.dispatchEvent(new CustomEvent('map-node-focused', { detail: { nodeId, projectId: projectId ?? null } }));
    }
  }, [gateway, projectId]);

  // ———— 一键排序（标题栏按钮 / ⌘R）————
  // 自动排版是确定性纯函数（见 nodemap-layout），"排序"= 丢弃手动拖拽的位置覆盖，回到自动排版；
  // 折叠态下触发时顺手展开面板，让结果可见。
  const arrangeNow = useCallback(() => {
    setManualPositions({});
    setDragDot(null);
    setHoveredEdgeId(null);
    onCollapsedChange(false);
  }, [onCollapsedChange]);
  // ⌘R / Ctrl+R：一键排序（替换旧 React Flow 时代的"Fit canvas & arrange sticky notes"，该处理器早已下线）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'r') return;
      // 始终拦住默认行为：避免 Chromium/Electron 的整页刷新把排序动作吞掉
      e.preventDefault();
      arrangeNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arrangeNow]);

  const mapW = 360 * mapZoom;
  const mapH = 240 * mapZoom;
  const pad = 8;
  const containerW = mapW + pad * 2;
  const containerH = mapH + pad * 2;
  const bw = bounds ? bounds.maxX - bounds.minX : 0;
  const bh = bounds ? bounds.maxY - bounds.minY : 0;
  // 单轴跨度为 0 时（径向排版下"一条纯链"会呈正放射状单轴展开）用另一轴定比例，
  // 避免 scale 归零把整图压成一个点；两轴都无跨度（单节点）才回落到 0（居中显示）。
  const scaleX = bw > 0 ? mapW / bw : Infinity;
  const scaleY = bh > 0 ? mapH / bh : Infinity;
  const scale = Number.isFinite(Math.min(scaleX, scaleY)) ? Math.min(scaleX, scaleY) : 0;

  // 统一以容器（含内边距）中心为基准的映射，确保连线/圆点/临时拖线在同一坐标系精确对齐
  const toMapX = (x: number) => (bounds ? (x - (bounds.minX + bounds.maxX) / 2) * scale + containerW / 2 : 0);
  const toMapY = (y: number) => (bounds ? (y - (bounds.minY + bounds.maxY) / 2) * scale + containerH / 2 : 0);

  // 迷你卡片边长：按固定 400×400 占位 × 整体比例收敛到 [CARD_MIN, CARD_MAX]
  const cardSize = Math.min(Math.max(400 * scale, CARD_MIN), CARD_MAX);

  // 常驻名称标签（标题栏开关打开时）：所有圆点显示名称，默认落在圆点下方（避让左右拖拽把手），
  // 越界自动翻面 + 夹紧在面板可视区内。依赖 labelSizes：尺寸实测后重算一次完成居中。
  const allLabelBoxes = useMemo(() => {
    if (!showAllLabels) return [];
    const half = Math.max(cardSize, 14) / 2;
    return dots.map((d) => {
      const size = labelSizes[d.id] ?? { w: 0, h: 0 };
      const { left, top } = labelBox(
        toMapX(d.cx), toMapY(d.cy), half, 'below',
        size.w, size.h, containerW, containerH, pad,
      );
      return { id: d.id, name: d.name, left, top };
    });
  }, [dots, showAllLabels, labelSizes, cardSize, containerW, containerH, pad, toMapX, toMapY]);

  // ———— 拖拽建边辅助：坐标换算 / 命中判定 / 锚点 pointer 事件 ————
  const connectTargetRef = useRef<string | null>(null);
  // 取消建边（pointercancel / 外部操作）：清全部连接态
  const stopConnect = useCallback(() => {
    connectStateRef.current = null;
    connectTargetRef.current = null;
    setConnectFrom(null);
    setConnectPos(null);
    setConnectTarget(null);
  }, []);
  // 指针 client 坐标 → 面板 local 坐标（与 toMapX/toMapY 同系，卡片定位以 .relative 容器为包含块）
  const toPaneLocal = useCallback((e: { clientX: number; clientY: number }) => {
    const r = mapPaneRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
  }, []);
  // 命中判定（建边吸附）：指针 local 坐标 → 命中的目标卡片（排除源卡片与归档卡片）。
  // 圆形命中 + CONNECT_SNAP_PX 磁吸增量：接近目标卡片即"吸住"，取距离最近者避免重叠误判。
  const hitCardAtLocal = useCallback((lx: number, ly: number): string | null => {
    const from = connectStateRef.current?.from;
    if (!from) return null;
    let best: string | null = null;
    let bestD = Infinity;
    const hitR = Math.max(cardSize, 14) / 2 + CONNECT_SNAP_PX;
    for (const d of dots) {
      if (d.id === from) continue;
      const cx = toMapX(d.cx);
      const cy = toMapY(d.cy);
      const dist = Math.hypot(lx - cx, ly - cy);
      if (dist <= hitR && dist < bestD) {
        bestD = dist;
        best = d.id;
      }
    }
    return best;
  }, [dots, cardSize, toMapX, toMapY]);
  // 面板级 hover 命中：鼠标 local 坐标 → 最近圆点（阈值覆盖圆点 + 左右拖拽点，
  // 保证"圆点 ↔ 拖拽点"往返不闪退）。面板级兜底，规避子按钮在父容器 pointer-events-none
  // 组合下 onMouseEnter/onPointerEnter 不触发的问题。
  const hitDotAtLocal = useCallback((lx: number, ly: number): string | null => {
    const hitR = Math.max(cardSize, 14) / 2 + HANDLE_GAP + 6;
    let best: string | null = null;
    let bestD = Infinity;
    for (const d of dots) {
      const dx = toMapX(d.cx) - lx;
      const dy = toMapY(d.cy) - ly;
      const dist = Math.hypot(dx, dy);
      if (dist <= hitR && dist < bestD) {
        bestD = dist;
        best = d.id;
      }
    }
    return best;
  }, [dots, cardSize, toMapX, toMapY]);
  // 面板级 hover 兜底：子按钮在 pointer-events-none 父容器下 enter/leave 不可靠，
  // 直接靠整个面板的 onPointerMove + 坐标命中实时维护 hoveredNodeId / hoveredEdgeId。
  // 圆点命中半径覆盖圆点 + 左右拖拽点（圆点↔拖拽点往返不闪退）；
  // 连线命中用"点到线段距离"覆盖整条线（触碰线任一点都亮出中点"断开"把手，且不闪退）。
  const edgeGeom = useMemo(() => {
    const out: { id: string; sx: number; sy: number; mx: number; my: number; tx: number; ty: number }[] = [];
    for (const edge of edges) {
      const s = centers[edge.source];
      const t = centers[edge.target];
      if (!s || !t) continue;
      const sx0 = toMapX(s.cx);
      const sy0 = toMapY(s.cy);
      const tx0 = toMapX(t.cx);
      const ty0 = toMapY(t.cy);
      const half = cardSize / 2;
      // 取贝塞尔真实中点（mx/my）作为命中折线的中间顶点，
      // 让中点"断开"把手始终落在命中区域内，避免线↔把手往返时闪退
      const [, mx, my] = radialEdgePath(sx0, sy0, tx0, ty0, half);
      out.push({ id: edge.id, sx: sx0, sy: sy0, mx, my, tx: tx0, ty: ty0 });
    }
    return out;
  }, [edges, centers, cardSize, toMapX, toMapY]);
  // 鼠标 local 坐标 → 最近折线（连线）；以"源→中点→目标"两段近似贝塞尔曲线，
  // 命中范围覆盖整条线及中点把手（触碰线任一点都亮出"断开"把手，且往返不闪退）
  const hitEdgeAtLocal = useCallback((lx: number, ly: number): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    const distToSeg = (ax: number, ay: number, bx: number, by: number) => {
      const abx = bx - ax;
      const aby = by - ay;
      const len2 = abx * abx + aby * aby;
      let t = len2 === 0 ? 0 : ((lx - ax) * abx + (ly - ay) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(lx - (ax + t * abx), ly - (ay + t * aby));
    };
    for (const seg of edgeGeom) {
      const d1 = distToSeg(seg.sx, seg.sy, seg.mx, seg.my);
      if (d1 <= 10 && d1 < bestD) { bestD = d1; best = seg.id; }
      const d2 = distToSeg(seg.mx, seg.my, seg.tx, seg.ty);
      if (d2 <= 10 && d2 < bestD) { bestD = d2; best = seg.id; }
    }
    return best;
  }, [edgeGeom]);
  const handlePanePointerMove = useCallback((e: React.PointerEvent) => {
    const p = toPaneLocal(e);
    if (!p) return;
    setHoveredNodeId(hitDotAtLocal(p.x, p.y));
    setHoveredEdgeId(hitEdgeAtLocal(p.x, p.y));
  }, [toPaneLocal, hitDotAtLocal, hitEdgeAtLocal]);
  // 指针彻底离开面板：onPointerMove 不再触发，直接清零悬停，避免残留高亮
  const handlePanePointerLeave = useCallback(() => {
    setHoveredNodeId(null);
    setHoveredEdgeId(null);
  }, []);
  // 锚点按下：源 = 该卡片；side 记录从哪侧出线（east/west），capture 指针开启拖线
  const beginConnect = useCallback((e: React.PointerEvent<HTMLButtonElement>, nodeId: string, side: ConnectSide) => {
    e.stopPropagation(); // 防止误触缩略图平移 / 卡片聚焦
    e.preventDefault();
    connectStateRef.current = { from: nodeId, side };
    connectTargetRef.current = null;
    setConnectFrom(nodeId);
    setConnectTarget(null);
    setConnectPos(toPaneLocal(e));
    try {
      (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    } catch {
      // 合成指针（自动化/测试）无 active pointer 时捕获会抛错，忽略即可
    }
  }, [toPaneLocal]);
  // 拖线移动：更新端点 + 命中目标。
  // 吸附：命中目标卡片（含磁吸半径）时端点收拢到目标中心（视觉"被吸住"），
  // 移出磁吸半径恢复跟随指针。
  const moveConnect = useCallback((e: React.PointerEvent) => {
    if (!connectStateRef.current) return;
    const p = toPaneLocal(e);
    if (!p) return;
    const t = hitCardAtLocal(p.x, p.y);
    connectTargetRef.current = t;
    setConnectTarget(t);
    if (t) {
      const td = dots.find((d) => d.id === t);
      setConnectPos(td ? { x: toMapX(td.cx), y: toMapY(td.cy) } : p);
    } else {
      setConnectPos(p);
    }
  }, [toPaneLocal, hitCardAtLocal, dots, toMapX, toMapY]);
  // 松手：命中目标卡片则派发建边请求（画布 onConnect 全流程），无论成败都清连接态
  const finishConnect = useCallback(() => {
    const from = connectStateRef.current?.from ?? null;
    const to = connectTargetRef.current;
    connectStateRef.current = null;
    connectTargetRef.current = null;
    setConnectFrom(null);
    setConnectPos(null);
    setConnectTarget(null);
    if (from && to && to !== from) {
      // CanvasFlow 监听 edge-create-request 后执行完整 onConnect：自动锁定上游源节点 → create → 布局
      window.dispatchEvent(new CustomEvent('edge-create-request', { detail: { from, to } }));
    }
  }, []);

  // ———— 圆点按住拖拽定位：pointer 三件套（down/move/up）————
  // 起点：记录 nodeId + 指针面板坐标 + 节点当前世界坐标，capture 指针进入拖拽；
  // dragStartRef 存节点世界坐标起点，move 以此为基准计算增量，保证不跳动。
  const beginDrag = (e: React.PointerEvent<HTMLButtonElement>, dot: { id: string; cx: number; cy: number }) => {
    if (connectStateRef.current) return; // 建边拖拽进行中不响应圆点拖拽
    e.stopPropagation(); // 不干扰点外部折叠 / 卡片聚焦
    e.preventDefault();
    const pane = toPaneLocal(e);
    if (!pane) return;
    dragStartRef.current = {
      nodeId: dot.id,
      paneStart: pane,
      worldStart: { cx: dot.cx, cy: dot.cy },
      moved: 0,
    };
    dragLiveRef.current = { id: dot.id, cx: dot.cx, cy: dot.cy };
    suppressClickRef.current = false;
    setDragDot({ id: dot.id, cx: dot.cx, cy: dot.cy });
    try {
      (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    } catch {
      // 合成指针（自动化/测试）无 active pointer 时捕获会抛错，忽略即可
    }
  };
  // 拖拽中：以节点面板中心为基准加手指位移，换算回世界坐标（反 toMapX/toMapY），
  // 夹紧在容器内防止圆点拖丢；实时更新 dragDot → 驱动圆点与连线端点跟随。
  const moveDrag = (e: React.PointerEvent) => {
    const start = dragStartRef.current;
    if (!start || !bounds || scale === 0) return;
    const pane = toPaneLocal(e);
    if (!pane) return;
    const dist = Math.hypot(pane.x - start.paneStart.x, pane.y - start.paneStart.y);
    if (dist > 3) start.moved = dist;
    const cx0 = (bounds.minX + bounds.maxX) / 2;
    const cy0 = (bounds.minY + bounds.maxY) / 2;
    // 节点面板坐标（toMapX/toMapY 已含居中）→ 加指针位移 → 夹紧 → 反向回世界坐标
    const dotPaneX = toMapX(start.worldStart.cx) + (pane.x - start.paneStart.x);
    const dotPaneY = toMapY(start.worldStart.cy) + (pane.y - start.paneStart.y);
    const px = Math.min(Math.max(dotPaneX, 7), containerW - 7);
    const py = Math.min(Math.max(dotPaneY, 7), containerH - 7);
    const next = {
      id: start.nodeId,
      cx: (px - containerW / 2) / scale + cx0,
      cy: (py - containerH / 2) / scale + cy0,
    };
    dragLiveRef.current = next;
    setDragDot(next);
  };
  // 落定：位移超阈值 → 写入手动覆盖（手动定位优先于自动排版，拖后不回弹），
  // 并抑制紧随的 click；否则视为点击（focusNode 仍正常触发）。
  const endDrag = () => {
    const start = dragStartRef.current;
    const live = dragLiveRef.current;
    dragStartRef.current = null;
    dragLiveRef.current = null;
    setDragDot(null);
    if (start && live && start.moved > 3) {
      suppressClickRef.current = true;
      setManualPositions((prev) => ({ ...prev, [live.id]: { cx: live.cx, cy: live.cy } }));
    }
  };

  // 无节点或已折叠时整体隐藏（无总览内容可展示；聚焦/归档恢复入口在左侧节点列；
  // 展开/折叠开关按钮在左侧栏项目行，本组件不再渲染左下角悬浮按钮）
  if (nodes.length === 0 || !bounds || collapsed) return null;

  // 展开态：居中覆盖在中栏对话区之上（2026-09-25 由「画布左下角悬浮」改为居中）。
  // 容器铺满中栏但 pointer-events-none，点击穿透到画布/对话内容；仅面板本体 pointer-events-auto
  //（因此点击面板内部不会被下方 pointerdown 判定为"点击外部"，而点击空白处仍会折叠）。
  return (
    <div
      ref={containerRef}
      data-canvas-ui="overlay"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
      style={{ fontFamily: "var(--font-sans)" }}
    >
      {/* 状态提示栈（原左侧 rail 底部按钮，2026-09-01 迁移至 NodeMap 上方）：
          仅保留应用更新状态；回执未读角标由 Butler 悬浮球承担。 */}
      <div className="flex flex-col items-end gap-1.5"></div>

      {/* 聚焦圆点的红色光晕呼吸动画 */}
      <style>{`
        @keyframes nodemap-breathe {
          0%, 100% { box-shadow: 0 0 4px var(--danger); }
          50% { box-shadow: 0 0 10px var(--danger); }
        }
        /* 执行中节点的琥珀色呼吸动画（AiChatNode 广播 node-executing 事件驱动） */
        @keyframes nodemap-executing {
          0%, 100% { box-shadow: 0 0 4px oklch(0.72 0.16 75 / 0.55); }
          50% { box-shadow: 0 0 11px oklch(0.72 0.16 75 / 1); }
        }
      `}</style>
        <div
          className="pointer-events-auto rounded-lg shadow-lg overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: mapW + 16,
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--line)',
          }}
        >
          <div
            className="flex items-center justify-between px-2 py-1.5"
            style={{ borderBottom: '1px solid var(--line)' }}
          >
            <div
              className="flex min-w-0 flex-1 items-center gap-1.5"
              title={title ? `${title} — Node Map (${nodes.length})` : `Node Map (${nodes.length})`}
            >
              {title && (
                <span className="min-w-0 max-w-[220px] truncate text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                  {title}
                </span>
              )}
              <span className="shrink-0 text-xs font-semibold tabular-nums" style={{ color: 'var(--ink-muted)' }}>
                {nodes.length}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {/* 项目相关工具已并入画布左上角项目名称卡片（2026-09-04） */}
              {/* 回执/通知入口已统一到 Butler 悬浮球（原此处的 BobMail 图标已移除） */}
              {/* 分组分隔线：工具（固定） */}
              <div className="mx-1 h-4 w-px shrink-0 self-center" style={{ backgroundColor: 'var(--line-soft)' }} />
              {/* 一键排序：丢弃手动拖拽的位置覆盖，回到自动排版（等价的快捷键 ⌘R） */}
              <button
                onClick={arrangeNow}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Auto arrange (⌘R)"
              >
                <Orbit className="h-3 w-3" />
              </button>
              {/* 名称标签开关：打开后所有圆点常驻显示名称浮层（透明底 + 灰框） */}
              <button
                onClick={() => setShowAllLabels((v) => !v)}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                style={{
                  color: showAllLabels ? '#fff' : 'var(--ink-muted)',
                  backgroundColor: showAllLabels ? 'var(--primary)' : 'transparent',
                }}
                title={showAllLabels ? 'Hide node names' : 'Show node names'}
              >
                <Tags className="h-3 w-3" />
              </button>
              <button
                onClick={() => setPinned((p) => !p)}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                style={{
                  color: pinned ? '#fff' : 'var(--ink-muted)',
                  backgroundColor: pinned ? 'var(--primary)' : 'transparent',
                }}
                title={pinned ? '已固定：点击空白处不折叠' : '固定面板：点击空白处不折叠'}
              >
                <Pin className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div
            ref={mapPaneRef}
            className="relative"
            onPointerMove={handlePanePointerMove}
            onPointerLeave={handlePanePointerLeave}
            style={{
              width: containerW,
              height: containerH,
              padding: pad,
              cursor: 'default',
              userSelect: 'none',
              touchAction: 'none',
            }}
          >
            {/* 节点间连线：径向辐条（端点沿两圆心连线方向落在圆缘）+ 迷你箭头。
                辐射布局下连线呈放射状，不再像旧 Left/Right 锚点那样互相绕圈；
                普通连线 = 暖棕虚线 + 端点迷你箭头，断开 = 淡灰虚线，执行中 = 琥珀电流光晕 */}
            <svg
              className="nodemap-edges absolute inset-0 pointer-events-none"
              style={{ width: containerW, height: containerH, zIndex: 0 }}
            >
              <defs>
                <marker
                  id="nodemap-edge-arrow"
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto"
                  markerUnits="userSpaceOnUse"
                >
                  <path d="M 0 0 L 7 3.5 L 0 7 L 1.75 3.5 Z" fill="oklch(0.55 0.12 45 / 0.7)" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const s = centers[edge.source];
                const t = centers[edge.target];
                if (!s || !t) return null;
                const sx0 = toMapX(s.cx);
                const sy0 = toMapY(s.cy);
                const tx0 = toMapX(t.cx);
                const ty0 = toMapY(t.cy);
                // 径向辐条：端点沿两圆心连线方向落在圆缘，控制点同向 —— 与 edgeGeom 同一套几何
                const [d, labelX, labelY] = radialEdgePath(sx0, sy0, tx0, ty0, cardSize / 2);
                const disconnected = Boolean(edge.disconnected);
                const executing = !disconnected && (executingIds.has(edge.source) || executingIds.has(edge.target));
                // 标题链接图标 reveal 高亮：与高亮节点直接相连的边强调显示
                const highlighted = !!highlightNodeId && (edge.source === highlightNodeId || edge.target === highlightNodeId);
                return (
                  <g key={edge.id} data-edge-id={edge.id}>
                    {/* reveal 高亮：主色光晕垫底，让相关连线醒目 */}
                    {highlighted && (
                      <path
                        d={d}
                        fill="none"
                        stroke="color-mix(in oklab, var(--primary) 35%, transparent)"
                        strokeWidth={5}
                        strokeLinecap="round"
                      />
                    )}
                    {/* 执行中：琥珀"电流"光晕层 */}
                    {executing && (
                      <path
                        d={d}
                        fill="none"
                        stroke="oklch(0.78 0.16 75 / 0.25)"
                        strokeWidth={3.5}
                        strokeLinecap="round"
                        strokeDasharray="1 7"
                      />
                    )}
                    <path
                      d={d}
                      fill="none"
                      stroke={
                        highlighted
                          ? 'var(--primary)'
                          : disconnected
                          ? 'oklch(0.65 0.01 60 / 0.4)'
                          : executing
                          ? 'oklch(0.78 0.16 75 / 0.95)'
                          : 'oklch(0.55 0.12 45 / 0.55)'
                      }
                      strokeWidth={highlighted ? 2 : 1.5}
                      strokeDasharray={highlighted ? undefined : (disconnected ? '3 5' : executing ? '2 6' : '8 4')}
                      strokeLinecap="round"
                      markerEnd={!disconnected ? 'url(#nodemap-edge-arrow)' : undefined}
                    />
                    {/* 透明宽描边命中区：仅是"线可交互"的指针光棒（hover 已由面板级 onPointerMove 兜底），
                        不再单独收发 enter/leave，避免与坐标命中重复竞争导致闪退 */}
                    {!disconnected && (
                      <path
                        d={d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={14}
                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      />
                    )}
                    {/* 中点编辑把手：激活边（悬停时出现）拖拽断开 / 断开边 ✕ 点击重连 */}
                    <EdgeHandle
                      disconnected={disconnected}
                      show={hoveredEdgeId === edge.id || disconnected}
                      midX={labelX}
                      midY={labelY}
                      onDisconnect={() => gateway.disconnectEdge(edge.id)}
                      onReconnect={() => gateway.reconnectEdge(edge.id)}
                      onLeave={clearEdgeHover}
                    />
                  </g>
                );
              })}
            </svg>
            {/* 节点圆点 + 连接拖拽点（同一 hover 组，data-dot-hover-group）：
                鼠标接触圆点，左右两缘各出现一个拖拽点，向任一方向拖到另一张卡片松手即建边；
                同组内"圆点 ↔ 拖拽点"互移不闪退，避免圆点命中区小、一移向把手就消失。
                圆点按类型上色（coding 偏 info / imageGen 偏 primary / chat 中性），悬停标题走浮层。 */}
            {dots.map((dot) => {
              const hit = Math.max(cardSize, 14); // 命中区 ≥14px，保证小卡片可点
              const cx = toMapX(dot.cx);
              const cy = toMapY(dot.cy);
              // 建边拖拽进行中只保留源卡片拖拽点，避免多圆点干扰；
              // 空闲时仅 hover 的圆点显示拖拽点。
              const isSource = connectFrom === dot.id;
              const anchorsVisible = isSource || (!connectFrom && hoveredNodeId === dot.id);
              return (
                <div
                  key={dot.id}
                  data-dot-hover-group={dot.id}
                  className="absolute inset-0 pointer-events-none"
                >
                  <button
                    className="absolute flex items-center justify-center"
                    data-nodemap-dot={dot.id}
                    style={{
                      width: hit,
                      height: hit,
                      left: cx - hit / 2,
                      top: cy - hit / 2,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      cursor: dragDot?.id === dot.id ? 'grabbing' : 'grab',
                      pointerEvents: 'auto', // 父容器 pointer-events-none，按钮需显式开启才能点击/拖拽
                      zIndex: 2,
                      touchAction: 'none',
                    }}
                    onPointerDown={(e) => beginDrag(e, dot)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onClick={(e) => {
                      // 拖拽落定后抑制紧随的 click，避免拖完又触发聚焦
                      if (suppressClickRef.current) { suppressClickRef.current = false; e.stopPropagation(); return; }
                      focusNode(dot.id);
                    }}
                    // 名称标签全量显示时不再叠原生 tooltip（避免与常驻标签重复显示同一名称）
                    title={showAllLabels ? undefined : dot.name}
                >
                  <span
                    className="block"
                    style={{
                      width: cardSize,
                      height: cardSize,
                      borderRadius: '50%', // 圆点形态（类型差异以颜色表达）
                      backgroundColor:
                        executingIds.has(dot.id)
                          ? 'oklch(0.72 0.16 75)' // 执行中：琥珀色（运行态优先级最高）
                          : zoomedId === dot.id
                          ? 'var(--danger)' // 聚焦：红色
                          : hoveredNodeId === dot.id
                          ? (dot.kind === 'coding'
                              ? 'color-mix(in oklab, color-mix(in oklab, var(--canvas-bg) 60%, var(--info) 40%) 90%, var(--ink-faint) 10%)'
                              : dot.kind === 'imageGen'
                              ? 'color-mix(in oklab, color-mix(in oklab, var(--canvas-bg) 60%, var(--primary) 40%) 90%, var(--ink-faint) 10%)'
                              : 'color-mix(in oklab, color-mix(in oklab, var(--canvas-bg) 78%, var(--ink-faint) 22%) 95%, var(--primary) 5%)')
                          : (dot.kind === 'coding'
                              // coding：画布底70% + info 22% + 淡灰 8%
                              ? 'color-mix(in oklab, color-mix(in oklab, var(--canvas-bg) 70%, var(--info) 22%) 92%, var(--ink-faint) 8%)'
                              : dot.kind === 'imageGen'
                              // imageGen：画布底70% + primary 22% + 淡灰 8%
                              ? 'color-mix(in oklab, color-mix(in oklab, var(--canvas-bg) 70%, var(--primary) 22%) 92%, var(--ink-faint) 8%)'
                              // chat：画布底 82% + 淡灰 15% + 极弱 primary 3% 让它在画布上有温度感不发灰
                              : 'color-mix(in oklab, color-mix(in oklab, var(--canvas-bg) 82%, var(--ink-faint) 15%) 97%, var(--primary) 3%)'),
                      boxShadow:
                        (executingIds.has(dot.id)
                          ? '0 0 6px oklch(0.72 0.16 75 / 0.6), 0 0 10px 3px oklch(0.72 0.16 75 / 0.2)'
                          : zoomedId === dot.id
                          ? '0 0 6px var(--danger-soft), 0 0 10px 3px color-mix(in oklab, var(--danger) 22%, transparent)'
                          : hoveredNodeId === dot.id
                          ? (dot.kind === 'coding'
                              ? '0 0 5px color-mix(in oklab, var(--info) 28%, transparent), 0 0 10px 3px color-mix(in oklab, var(--info) 10%, transparent)'
                              : dot.kind === 'imageGen'
                              ? '0 0 5px color-mix(in oklab, var(--primary) 28%, transparent), 0 0 10px 3px color-mix(in oklab, var(--primary) 12%, transparent)'
                              : '0 0 4px color-mix(in oklab, var(--ink-faint) 18%, transparent)')
                          : (dot.kind === 'coding'
                              ? '0 0 4px 2px color-mix(in oklab, var(--info) 7%, transparent)'
                              : dot.kind === 'imageGen'
                              ? '0 0 4px 2px color-mix(in oklab, var(--primary) 8%, transparent)'
                              : '0 0 4px 2px color-mix(in oklab, var(--ink-faint) 5%, transparent)')),
                      outline: 'none',
                      animation:
                        executingIds.has(dot.id)
                          ? 'nodemap-executing 1.4s ease-in-out infinite'
                          : zoomedId === dot.id
                          ? 'nodemap-breathe 1.6s ease-in-out infinite'
                          : undefined,
                    }}
                  />
                </button>
                  {anchorsVisible && CONNECT_SIDES.map((s) => {
                    // 拖拽点中心落在圆点外缘（cardSize/2 + HANDLE_GAP），不与圆点重叠、可独立抓取
                    const handleOffset = cardSize / 2 + HANDLE_GAP;
                    const ax = cx + s.dx * handleOffset;
                    const ay = cy + s.dy * handleOffset;
                    return (
                      <button
                        key={`connect-${dot.id}-${s.id}`}
                        className="absolute flex items-center justify-center rounded-full"
                        data-nodemap-connect={dot.id}
                        data-side={s.id}
                        style={{
                          width: 12,
                          height: 12,
                          left: ax - 6,
                          top: ay - 6,
                          padding: 0,
                          border: 'none',
                          background: 'transparent',
                          cursor: 'crosshair',
                          pointerEvents: 'auto', // 父容器 pointer-events-none，按钮需显式开启才能拖拽建边
                          zIndex: 3,
                          touchAction: 'none',
                        }}
                        onPointerDown={(e) => beginConnect(e, dot.id, s.id)}
                        onPointerMove={moveConnect}
                        onPointerUp={finishConnect}
                        onPointerCancel={stopConnect}
                        title={`Create child edge from: ${dot.name}`}
                      >
                        <span
                          className="block rounded-full"
                          style={{
                            width: 7,
                            height: 7,
                            // 悬停态若沿用 --paper 填充（与面板底色同色）会"隐形"——锚点必须始终清晰可见
                            backgroundColor: 'var(--primary)',
                            border: '2px solid var(--paper)',
                            boxShadow: isSource
                              ? '0 0 6px 1px color-mix(in oklab, var(--primary) 55%, transparent)'
                              : '0 0 4px color-mix(in oklab, var(--primary) 30%, transparent)',
                            transition: 'background-color 0.12s, box-shadow 0.12s',
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {/* reveal 高亮框：标题链接图标点击后，标记目标节点卡片 */}
            {highlightNodeId && (() => {
              const hd = dots.find((d) => d.id === highlightNodeId);
              if (!hd) return null;
              const h = Math.max(cardSize, 14);
              return (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left: toMapX(hd.cx) - h / 2 - 3,
                    top: toMapY(hd.cy) - h / 2 - 3,
                    width: h + 6,
                    height: h + 6,
                    border: '2px solid var(--primary)',
                    borderRadius: '50%', // 圆环贴合圆点
                    boxShadow: '0 0 10px color-mix(in oklab, var(--primary) 50%, transparent)',
                    zIndex: 3,
                  }}
                />
              );
            })()}
            {/* 建边拖线：临时虚线 + 端点 + 目标卡片高亮框（盖在卡片之上但 pointer-events 透传） */}
            {connectFrom && connectPos && (() => {
              const src = centers[connectFrom];
              if (!src) return null;
              const side = connectStateRef.current?.side ?? 'east';
              // 拖线起点与把手同心：也落在圆点外缘，保证从把手位置起笔
              const handleOffset = cardSize / 2 + HANDLE_GAP;
              const s = CONNECT_SIDES.find((x) => x.id === side) ?? CONNECT_SIDES[0];
              const sx = toMapX(src.cx) + s.dx * handleOffset;
              const sy = toMapY(src.cy) + s.dy * handleOffset;
              const tDot = connectTarget ? dots.find((d) => d.id === connectTarget) : undefined;
              const th = tDot ? Math.max(cardSize, 14) : 0;
              return (
                <svg
                  className="absolute pointer-events-none"
                  style={{ width: containerW, height: containerH, zIndex: 3 }}
                >
                  {tDot && (
                    <g>
                      <rect
                        x={toMapX(tDot.cx) - th / 2}
                        y={toMapY(tDot.cy) - th / 2}
                        width={th}
                        height={th}
                        rx={th / 2} // 目标圆点圆形高亮（吸附点亮：柔和填充示意"即将连接"）
                        fill="color-mix(in oklab, var(--primary) 12%, transparent)"
                        stroke="var(--primary)"
                        strokeWidth={1.5}
                        strokeDasharray="3 2"
                      />
                      {/* 目标吸附中心锚点：端点收拢后与其重合 */}
                      <circle cx={toMapX(tDot.cx)} cy={toMapY(tDot.cy)} r={2.5} fill="var(--primary)" />
                    </g>
                  )}
                  {/* 拖线用 --primary（--primary-soft 在浅色面板上近白隐形）；目标高亮框已为主色虚线 */}
                  <line x1={sx} y1={sy} x2={connectPos.x} y2={connectPos.y} stroke="var(--primary)" strokeWidth={1.5} strokeDasharray="4 3" strokeLinecap="round" />
                  <circle
                    cx={connectPos.x}
                    cy={connectPos.y}
                    r={connectTarget ? 4.5 : 3}
                    fill="var(--primary)"
                    stroke="var(--paper)"
                    strokeWidth={connectTarget ? 1.5 : 0}
                  />
                </svg>
              );
            })()}
            {/* 常驻名称标签（标题栏"名称"开关打开时全量显示）：透明底 + 灰框，
                默认落在圆点下方（避让左右拖拽把手），越界自动翻面并夹紧在面板内 */}
            {allLabelBoxes.map((lb) => (
              <div
                key={lb.id}
                ref={measureLabelRef}
                data-label-node={lb.id}
                className="absolute max-w-[132px] truncate rounded px-1.5 py-0.5 text-xs leading-tight pointer-events-none whitespace-nowrap"
                style={{
                  left: lb.left,
                  top: lb.top,
                  backgroundColor: 'transparent',
                  border: '1px solid var(--line)',
                  color: 'var(--ink)',
                  zIndex: 9,
                }}
              >
                {lb.name}
              </div>
            ))}
            {/* 悬停标题浮层（拖线建边期间隐藏；标签全量显示时名称已在场，故不再叠一层）：
                水平居中于圆点、垂直落在圆点正上方——浮层的垂直范围与左右拖拽把手
                （圆点两侧同一横向高度带）错开，不遮挡把手；顶部放不下翻到下方并夹紧在面板内 */}
            {hoveredNodeId && !connectFrom && !showAllLabels && (() => {
              const d = dots.find((x) => x.id === hoveredNodeId);
              if (!d) return null;
              const half = Math.max(cardSize, 14) / 2;
              const { w = 0, h = 0 } = hoverTipSize ?? {};
              const { left, top } = labelBox(
                toMapX(d.cx), toMapY(d.cy), half, 'above',
                w, h, containerW, containerH, pad,
              );
              return (
                <div
                  ref={hoverTipRef}
                  className="absolute px-1.5 py-0.5 rounded text-xs leading-tight pointer-events-none whitespace-nowrap"
                  style={{
                    left,
                    top,
                    backgroundColor: 'transparent',
                    border: '1px solid var(--line)',
                    color: 'var(--ink)',
                    zIndex: 10,
                  }}
                >
                  {d.name}
                </div>
              );
            })()}
          </div>
        </div>
    </div>
  );
}
