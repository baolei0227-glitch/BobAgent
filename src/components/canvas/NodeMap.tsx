'use client';

import { useState, useMemo, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { useThumbnailDrag } from '@/hooks/useThumbnailDrag';
import { MapPinned as MapIcon, Pin, Scan, Inbox, RefreshCw, Download, AlertCircle, ArrowDownCircle } from 'lucide-react';
import type { GraphGateway, GraphRect, NodeKind } from '@/lib/graph/graph-gateway';
import { relayoutTree } from '@/lib/graph/nodemap-layout';

/** Note 便签固定渲染尺寸（与 CanvasFlow 中 NOTE_NODE_W/H 一致） */
const NOTE_W = 220;
const NOTE_H = 110;
/** Note 簇紧凑间距：左右 32px、上下 16px */
const NOTE_H_GAP = 32;
const NOTE_V_GAP = 16;

/** 更新状态图标按钮（原 rail 底部更新入口，2026-09-01 迁移至 NodeMap）：
 *  按状态渲染对应图标，点击派发 update-action 由 Sidebar 执行具体动作 */
function StatusIconBtn({ status, updateInfo }: {
  status: string;
  updateInfo: { version?: string; progress?: number; error?: string; install?: { stage?: string; message?: string; percent?: number } | null };
}) {
  const act = (action: string) => window.dispatchEvent(new CustomEvent('update-action', { detail: { action } }));
  const base: CSSProperties = {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    border: '1px solid var(--line)',
    boxShadow: '0 2px 6px rgba(0,0,0,0.10)',
    cursor: 'pointer',
  };
  if (status === 'checking') {
    return (
      <button type="button" style={{ ...base, backgroundColor: 'var(--paper)', color: 'var(--primary)' }} title="Checking for updates…">
        <RefreshCw className="h-4 w-4 animate-spin" />
      </button>
    );
  }
  if (status === 'available') {
    return (
      <button type="button" onClick={() => act('download')} style={{ ...base, backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }} title={`v${updateInfo.version} available — click to download`}>
        <Download className="h-4 w-4" />
      </button>
    );
  }
  if (status === 'downloading') {
    return (
      <button type="button" style={{ ...base, backgroundColor: 'var(--paper)', color: 'var(--primary)' }} title={`Downloading v${updateInfo.version} — ${Math.round(updateInfo.progress ?? 0)}%`}>
        <RefreshCw className="h-4 w-4 animate-spin" />
      </button>
    );
  }
  if (status === 'downloaded') {
    return (
      <button type="button" onClick={() => act('install')} style={{ ...base, backgroundColor: 'var(--primary-strong)', color: 'var(--primary-foreground)' }} title={`v${updateInfo.version} ready — click to install`}>
        <ArrowDownCircle className="h-4 w-4" />
      </button>
    );
  }
  if (status === 'installing') {
    return (
      <button type="button" style={{ ...base, backgroundColor: 'var(--primary-strong)', color: 'var(--primary-foreground)' }} title={updateInfo.install?.message || updateInfo.error || 'Installing…'}>
        <RefreshCw className="h-4 w-4 animate-spin" />
      </button>
    );
  }
  if (status === 'error') {
    return (
      <button type="button" onClick={() => act('check')} style={{ ...base, backgroundColor: 'var(--paper)', color: 'var(--danger)' }} title={updateInfo.error || 'Update error — click to retry'}>
        <AlertCircle className="h-4 w-4" />
      </button>
    );
  }
  return null;
}

/**
 * Note 树形排版（考虑父子簇关系）：
 *  - 以无上游 note 为根，沿 note→note 边构建森林
 *  - 首个根（nodes 顺序中的第一个 note）卡片居中于视口中心
 *  - 每个根的子 note 纵向列排在其右侧（中心对齐根），孙/更深层递归向右展开
 *  - 多个根横向排开（各自子树不重叠），间距 32/16
 * @returns nodeId → 新位置（左上角世界坐标）
 */
function layoutNoteTrees(
  roots: string[],
  tree: Record<string, string[]>,
  opts: { centerX: number; centerY: number },
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (roots.length === 0) return positions;

  // 第一遍：子树高度 / 宽度（含根卡片）
  const subH: Record<string, number> = {};
  const subW: Record<string, number> = {};
  const height = (node: string): number => {
    const kids = tree[node] || [];
    if (kids.length === 0) {
      subH[node] = NOTE_H;
      return subH[node];
    }
    let s = 0;
    for (const k of kids) s += height(k);
    subH[node] = s + (kids.length - 1) * NOTE_V_GAP;
    return subH[node];
  };
  const width = (node: string): number => {
    const kids = tree[node] || [];
    if (kids.length === 0) {
      subW[node] = NOTE_W;
      return subW[node];
    }
    let mw = 0;
    for (const k of kids) mw = Math.max(mw, width(k));
    subW[node] = NOTE_W + NOTE_H_GAP + mw;
    return subW[node];
  };
  for (const r of roots) {
    height(r);
    width(r);
  }

  // 递归布局：子树根中心对齐 yCenter，子列在根右侧纵向展开（列中心=根中心）
  const place = (node: string, x: number, yCenter: number) => {
    positions[node] = { x: Math.round(x), y: Math.round(yCenter - NOTE_H / 2) };
    const kids = tree[node] || [];
    if (kids.length === 0) return;
    const childX = x + NOTE_W + NOTE_H_GAP;
    let cy = yCenter - subH[node] / 2;
    for (const k of kids) {
      place(k, childX, cy + subH[k] / 2);
      cy += subH[k] + NOTE_V_GAP;
    }
  };

  // 首个根居中于视口中心，其余根依次向右排（间隔左簇子树宽度 + 水平间距）
  let rx = opts.centerX - NOTE_W / 2;
  for (let i = 0; i < roots.length; i++) {
    place(roots[i], rx, opts.centerY);
    rx += subW[roots[i]] + NOTE_H_GAP;
  }
  return positions;
}

/** Note 线性布局的包围盒（世界坐标，含卡片尺寸） */
function noteNodesBounds(layout: Record<string, { x: number; y: number }>): GraphRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of Object.values(layout)) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NOTE_W);
    maxY = Math.max(maxY, p.y + NOTE_H);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 节点地图 — 小圆点形式展示全部节点，并绘制节点间连线
 *  画布数据访问全部通过 gateway（GraphGateway 统一对接端口，太空舱理念），
 *  不直接触碰 ReactFlow store / window 事件总线。
 */
export function NodeMap({ gateway, left, title, projectId, onAfterFit }: {
  gateway: GraphGateway;
  left?: number;
  title?: string;
  /** 当前项目 id */
  projectId?: string;
  onAfterFit?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [pinned, setPinned] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  // 正在执行任务的节点 id 集合（AiChatNode 流式执行中广播 node-executing 事件）
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set());
  // 常驻状态提示（原左侧 rail 底部，2026-09-01 迁移至 NodeMap）：
  // - BobMail 未读角标（Sidebar bobmail-pending 广播）
  const [wantedPending, setWantedPending] = useState(0);
  // - 应用更新状态（Sidebar 保留更新逻辑，广播 update-status-changed）
  const [updateInfo, setUpdateInfo] = useState<{
    status: string;
    version?: string;
    progress?: number;
    error?: string;
    install?: { stage?: string; message?: string; percent?: number } | null;
  }>({ status: 'idle' });
  useEffect(() => {
    const onPending = (e: Event) => {
      const d = (e as CustomEvent).detail as { pending?: number } | undefined;
      if (typeof d?.pending === 'number') setWantedPending(d.pending);
    };
    const onUpdate = (e: Event) => {
      const d = (e as CustomEvent).detail as typeof updateInfo | undefined;
      if (d) setUpdateInfo(d);
    };
    window.addEventListener('bobmail-pending', onPending);
    window.addEventListener('update-status-changed', onUpdate);
    // 挂载时主动拉取 BobMail 未读数（Sidebar 已广播过，确保早期打开能拿到）
    window.dispatchEvent(new Event('bobmail-pending-request'));
    return () => {
      window.removeEventListener('bobmail-pending', onPending);
      window.removeEventListener('update-status-changed', onUpdate);
    };
  }, []);
  // 当前通过 NodeMap 聚焦放大的节点 id
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const zoomedIdRef = useRef<string | null>(null);
  // 保持 ref 与 state 同步，避免 stale closure 在事件回调中读到旧值
  zoomedIdRef.current = zoomedId;
  // 聚焦前的画布 viewport 快照（缩放 + 位置），再次点击已聚焦节点时恢复
  const viewportMemoryRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  // 缩略图自身缩放倍率（1x / 2x，仅两档，放大看局部布局）
  const [mapZoom, setMapZoom] = useState(1);
  // 画布缩放锁定（2026-09-03 起恒定开启：NodeMap 缩放按钮已移除，不再提供解锁入口）。
  // 锁定时 zoom 固定 100%，滚轮转为平移；CanvasFlow 默认同为锁定态，二者保持一致。
  const zoomLocked = true;
  // 拖拽平移画布视口 → 由 useThumbnailDrag hook 封装（见调用处）

  // 订阅画布快照：节点/边/视口变化时自动重渲染（gateway 内部按引用比较过滤无关更新）
  const { nodes, edges, viewport } = useSyncExternalStore(
    gateway.subscribe,
    gateway.getSnapshot,
    gateway.getSnapshot,
  );
  const { x: vpX, y: vpY, zoom: vpZoom } = viewport;

  // 订阅节点外部事件（收起 / 执行状态）：聚焦节点容器收起时清除聚焦态 → 红色圆点消失；
  // AiChatNode 流式执行中/结束分别携带 executing=true/false
  // 使用 zoomedIdRef 而非 zoomedId 避免 stale closure：
  //   点击另一个圆点时旧节点收起触发 node-collapsed，此时 effect 的旧 listener
  //   尚未被清理，若闭包中是旧 zoomedId 会错误匹配并重置新 zoomedId
  useEffect(() => {
    return gateway.onNodeEvent((e) => {
      if (e.type === 'node-collapsed') {
        if (e.nodeId === zoomedIdRef.current) {
          setZoomedId(null);
          window.dispatchEvent(new CustomEvent('map-node-focused', { detail: { nodeId: null, projectId: projectId ?? null } }));
        }
      } else {
        setExecutingIds((prev) => {
          const next = new Set(prev);
          if (e.executing) next.add(e.nodeId);
          else next.delete(e.nodeId);
          return next;
        });
      }
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
      if (containerRef.current?.contains(e.target as Node)) return;
      setCollapsed(true);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [collapsed, pinned]);

  /**
   * 树形层级排版算法已抽到独立模块（@/lib/graph/nodemap-layout）。
   *  - 纯函数：不读 DOM、不写副作用、只接收 nodes/edges/viewport/paneSize
   *  - 返回 { positions, bounds }：调用方写回 positions 并直接用 bounds 做 fitBounds
   */

  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 排版 + 适配视口：
  //  - 先按树形算法规整全部节点坐标，再决定视口策略（分锁定 / 非锁定两套）
  //  - 不直接调用 fitView：setNodePositions 是异步 state，fitView 会读到旧坐标导致缩放到 10%
  //  - 直接用 relayoutTree 返回的 bounds 做 fitBounds 或 setCenter：同步、精确
  //  - zoomLocked=锁定时：强制 zoom=100%，不做缩放适配，只平移视口中心对齐排版结果中心
  //    （节点多放不下时用户用滚轮平移，符合"锁定=不缩放"的直觉）
  const doLayoutAndFit = useCallback(() => {
    const snap = gateway.getSnapshot();
    // 排版只针对真实节点：批注框（annotation）不参与 ⌘+R 排版（自动跟随包裹，独立管理）；
    // 归档节点（archived）不参与排版——已完成使命，保留原位，仅由导航圆点外圈标识
    const layoutNodes = snap.nodes.filter((n) => n.type !== 'annotation' && !n.archived);
    if (layoutNodes.length === 0) {
      if (zoomLocked) {
        gateway.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 });
      } else {
        gateway.fitView({ padding: 0.1, maxZoom: 1, duration: 300 });
      }
      return;
    }
    const pane = document.querySelector('.react-flow__pane') as HTMLElement | null;
    const paneW = pane?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1200);
    const paneH = pane?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 800);
    const vp = gateway.getViewport();

    // 锁定下：排版的锚点视口就按"最终 zoom=1 + 当前平移"计算，
    // 排出来的节点集群中心直接落在"用户锁定后看到的屏幕中心"，
    // 写完坐标 setViewport(finalVp) 就能一步到位，不需要 setCenter 二次平移。
    const finalVp = zoomLocked ? { x: vp.x, y: vp.y, zoom: 1 } : vp;
    const layoutOpts = zoomLocked
      ? {
          viewport: finalVp,
          paneW,
          paneH,
          horizontalAlign: 'left' as const,
          leftPadding: 48 + (left ?? 0),
          gaps: { componentGap: 32, verticalGap: 28, horizontalGap: 12 } as const,
        }
      : { viewport: finalVp, paneW, paneH, horizontalAlign: 'left' as const, leftPadding: 48 + (left ?? 0) };
    const result = relayoutTree(layoutNodes, snap.edges, layoutOpts);
    if (!result) return;
    const positions = { ...result.positions };
    // Note 树形排版：画布存在便签（note）节点时覆盖其位置——
    // 按父子簇结构排版：首个根卡片居中于视口中心，子 note 纵向排在根右侧（32/16 紧凑间距）
    const noteNodes = layoutNodes.filter((n) => n.type === 'note');
    let noteLayout: Record<string, { x: number; y: number }> = {};
    if (noteNodes.length > 0) {
      // 排版锚点视口即最终视口（锁定时 zoom=1）：视口中心的世界坐标
      const centerX = (paneW / 2 - finalVp.x) / finalVp.zoom;
      const centerY = (paneH / 2 - finalVp.y) / finalVp.zoom;
      // 构建 note→note 森林：边源为父、目标为子；无上游 note 为根
      const noteIds = new Set(noteNodes.map((n) => n.id));
      const tree: Record<string, string[]> = {};
      const hasUpstream = new Set<string>();
      for (const e of snap.edges) {
        if (e.disconnected) continue;
        if (!noteIds.has(e.source) || !noteIds.has(e.target)) continue;
        (tree[e.source] ||= []).push(e.target);
        hasUpstream.add(e.target);
      }
      const roots = noteNodes.map((n) => n.id).filter((id) => !hasUpstream.has(id));
      noteLayout = layoutNoteTrees(roots, tree, { centerX, centerY });
      Object.assign(positions, noteLayout);
    }
    gateway.setNodePositions(positions);
    if (zoomLocked) {
      // 排版锚点已对齐 finalVp（zoom=1）的视口中心，集群中心自然落在屏幕中心
      gateway.setViewport(finalVp, { duration: 300 });
    } else if (noteNodes.length > 0) {
      // 有便签：以便签簇为适配范围，首个卡片对准视口中心（其余自动缩放可见）
      const b = noteNodesBounds(noteLayout);
      if (b) {
        const pad = 0.1;
        const zoom = Math.min((paneW * (1 - pad)) / b.width, (paneH * (1 - pad)) / b.height, 1);
        const first = noteNodes[0];
        const f = noteLayout[first.id];
        const vpx = paneW / 2 - (f.x + NOTE_W / 2) * zoom;
        const vpy = paneH / 2 - (f.y + NOTE_H / 2) * zoom;
        gateway.setViewport({ x: vpx, y: vpy, zoom }, { duration: 300 });
      } else {
        gateway.fitView({ padding: 0.1, maxZoom: 1, duration: 300 });
      }
    } else {
      // 非锁定：自动缩放 + 左对齐（节点链贴侧边栏右缘、右侧留白）+ 垂直居中。
      // 不用 fitBounds——它会把整图重新居中到视口中心，抵消 layout 的靠左偏移。
      const b = result.bounds;
      const pad = 0.1;
      const availableW = paneW - (left ?? 0);
      const scaleX = (availableW * (1 - pad)) / b.width;
      const scaleY = (paneH * (1 - pad)) / b.height;
      const zoom = Math.min(scaleX, scaleY, 1);
      const leftPadPx = 48 + (left ?? 0);
      const vpx = -b.x * zoom + leftPadPx;
      const vpy = -b.y * zoom + (paneH - b.height * zoom) / 2;
      gateway.setViewport({ x: vpx, y: vpy, zoom }, { duration: 300 });
    }
  }, [relayoutTree, gateway, zoomLocked, left]);

  const handleFit = useCallback(() => {
    const expanded = zoomedId;
    setZoomedId(null);
    if (!expanded) {
      doLayoutAndFit();
    } else {
      // 有展开节点：先收起（等动画完成再排版，否则展开态尺寸会干扰排版结果）
      gateway.collapseNode(expanded);
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
      fitTimerRef.current = setTimeout(() => doLayoutAndFit(), 350);
    }
    // 同步触发"排列全部便签到画布右侧"（与点击侧边 sticky 圆点一致）
    onAfterFit?.();
  }, [zoomedId, gateway, doLayoutAndFit, onAfterFit]);

  // ⌘+R 快捷键：等效点击 Fit 按钮（重排节点 + 排列便签）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleFit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleFit]);

  useEffect(() => {
    return () => { if (fitTimerRef.current) clearTimeout(fitTimerRef.current); };
  }, []);

  // 缩放锁定时：若画布 zoom 偏离 1（如锁定前残留或 RF 内部重置），自动拉回 100%，
  // 保持 x/y 不变——只纠正 zoom，不移动视口位置。
  useEffect(() => {
    if (!zoomLocked) return;
    if (Math.abs(vpZoom - 1) < 0.001) return;
    gateway.setViewport({ x: vpX, y: vpY, zoom: 1 });
  }, [zoomLocked, vpZoom, vpX, vpY, gateway]);

  const { dots, bounds, centers } = useMemo(() => {
    if (nodes.length === 0) return { dots: [], bounds: null, centers: {} as Record<string, { cx: number; cy: number }> };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const list: { id: string; cx: number; cy: number; name: string; kind: NodeKind; archived: boolean }[] = [];
    const centerMap: Record<string, { cx: number; cy: number }> = {};

    for (const n of nodes) {
      // 批注框（annotation）与便签（note）都不在地图上显示圆点（纯画布分组/思路视觉，非研究节点）
      if (n.type === 'annotation' || n.type === 'note') continue;
      const w = 400;
      const h = 400;
      const cx = n.x + w / 2;
      const cy = n.y + h / 2;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w);
      maxY = Math.max(maxY, n.y + h);
      let kind: NodeKind = 'chat';
      if (n.type === 'imageGen') kind = 'imageGen';
      else if (n.sandboxAppId) kind = 'coding';
      list.push({ id: n.id, cx, cy, name: n.title, kind, archived: Boolean(n.archived) });
      centerMap[n.id] = { cx, cy };
    }

    const pad = 40;
    return { dots: list, bounds: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }, centers: centerMap };
  }, [nodes]);

  // 聚焦/取消聚焦单个节点（地图圆点与目录项共用同一套状态机）
  //  - 聚焦：记住视口快照 → setCenter 把节点中心平移到视口中心（不强制改 zoom，保持当前比例）→ 展开
  //  - 取消：视口恢复快照 → 收起
  //  setCenter 比 fitBounds 更适合"定位到中心"语义：fitBounds 在节点已适配时可能不触发位移，
  //  而 setCenter 直接按世界坐标设置中心，不受 minZoom/maxZoom 钳制以外的干扰。
  const focusNode = useCallback((nodeId: string) => {
    if (zoomedId === nodeId) {
      setZoomedId(null);
      window.dispatchEvent(new CustomEvent('map-node-focused', { detail: { nodeId: null, projectId: projectId ?? null } }));
      const prev = viewportMemoryRef.current;
      viewportMemoryRef.current = null;
      if (prev) gateway.setViewport(prev, { duration: 300 });
      gateway.collapseNode(nodeId);
      return;
    }
    const snap = gateway.getSnapshot();
    const node = snap.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    viewportMemoryRef.current = gateway.getViewport();
    setZoomedId(nodeId);
    window.dispatchEvent(new CustomEvent('map-node-focused', { detail: { nodeId, projectId: projectId ?? null } }));
    gateway.setNodeSelected(nodeId);
    // 瞬时 setCenter：expandNode 请求紧随其后会触发 React 重渲染，
    // d3-zoom duration transition 会被中断 → 无 duration 确保视口立即到位。
    gateway.setCenter(node.x + node.width / 2, node.y + node.height / 2);
    gateway.expandNode(nodeId);
  }, [zoomedId, gateway]);

  const mapW = 360 * mapZoom;
  const mapH = 240 * mapZoom;
  const pad = 8;
  const containerW = mapW + pad * 2;
  const containerH = mapH + pad * 2;
  const bw = bounds ? bounds.maxX - bounds.minX : 0;
  const bh = bounds ? bounds.maxY - bounds.minY : 0;
  const scale = bw > 0 && bh > 0 ? Math.min(mapW / bw, mapH / bh) : 0;

  // 统一以容器（含内边距）中心为基准的映射，确保连线/圆点/视口框在同一坐标系精确对齐
  const toMapX = (x: number) => (bounds ? (x - (bounds.minX + bounds.maxX) / 2) * scale + containerW / 2 : 0);
  const toMapY = (y: number) => (bounds ? (y - (bounds.minY + bounds.maxY) / 2) * scale + containerH / 2 : 0);

  // 视口框大小
  const vpW = (typeof window !== 'undefined' ? window.innerWidth : 1200) / vpZoom;
  const vpH = (typeof window !== 'undefined' ? window.innerHeight : 800) / vpZoom;
  const vpLeft = toMapX(vpX);
  const vpTop = toMapY(vpY);
  const vpScaledW = Math.max(vpW * scale, 4);
  const vpScaledH = Math.max(vpH * scale, 4);

  // 缩略图拖拽交互（dragRef + 捕获阈值 + isDragging + 3 事件）封装在 hook 中。
  // 注意：useThumbnailDrag 必须在条件 return 之前调用，否则违反 React Hooks 规则。
  // toMapX/toMapY 仍在本组件体内：渲染 SVG 连线/圆点/视口框/悬停 tooltip 都需要。
  const {
    isDragging: isMapDragging,
    onPointerDown: onMapPointerDown,
    onPointerMove: onMapPointerMove,
    onPointerUp: onMapPointerUp,
  } = useThumbnailDrag({ vpX, vpY, vpZoom, scale, setViewport: gateway.setViewport });

  if (nodes.length === 0 || !bounds) {
    return (
      <div className="absolute bottom-4 right-4 z-10">
        <button
          className="flex h-9 w-9 items-center justify-center rounded-lg shadow-md opacity-50 cursor-default"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--line)',
          }}
        >
          <MapIcon className="h-4 w-4" style={{ color: 'var(--ink-muted)' }} />
        </button>
      </div>
    );
  }

  // 缩略图缩放两档循环：1x → 2x → 1x
  const cycleMapZoom = () => {
    setMapZoom((z) => (z >= 2 ? 1 : 2));
  };

  return (
    <div
      ref={containerRef}
      data-canvas-ui="overlay"
      className="absolute bottom-4 z-10 flex flex-col items-end gap-2"
      style={{ fontFamily: "var(--font-sans)", left: left ?? 16 }}
    >
      {/* 状态提示栈（原左侧 rail 底部按钮，2026-09-01 迁移至 NodeMap 上方）：
          仅保留应用更新状态；BobMail 未读角标直接落在 NodeMap 的 MapIcon 上，
          打开入口在展开面板标题栏内。 */}
      <div className="flex flex-col items-end gap-1.5">
        {updateInfo.status !== 'idle' && updateInfo.status !== 'no-update' && (
          <StatusIconBtn status={updateInfo.status} updateInfo={updateInfo} />
        )}
      </div>

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
      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          className="relative flex h-9 w-9 items-center justify-center rounded-lg shadow-md transition-colors hover:bg-[var(--paper-hover)]"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--line)',
          }}
          title={`Node Map (${nodes.length})${wantedPending > 0 ? ` — ${wantedPending} unread notifications` : ''}`}
        >
          <MapIcon className="h-4 w-4" style={{ color: 'var(--ink-muted)' }} />
          {wantedPending > 0 && (
            <span
              role="button"
              onClick={(e) => {
                // 点击角标直接打开 BobMail；stopPropagation 避免触发外层按钮的展开行为
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('bobmail-toggle', {
                  detail: { anchor: (e.currentTarget as HTMLSpanElement).getBoundingClientRect() },
                }));
              }}
              title={`Notifications (BobMail) — ${wantedPending} unread`}
              className="absolute -right-0.5 -top-0.5 flex h-[14px] min-w-[14px] cursor-pointer items-center justify-center rounded-full px-1 text-8 font-bold leading-none transition-opacity hover:opacity-80"
              style={{ backgroundColor: 'var(--danger)', color: '#fff' }}
            >
              {wantedPending > 99 ? '99+' : wantedPending}
            </span>
          )}
        </button>
      ) : (
        <div
          className="rounded-lg shadow-lg overflow-hidden"
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
              {/* 分组分隔线：通知 */}
              <div className="mx-1 h-4 w-px shrink-0 self-center" style={{ backgroundColor: 'var(--line-soft)' }} />
              {/* BobMail 入口（展开态标题栏内）：点击打开通知中心，未读叠加红点；弹窗锚定该按钮上方 */}
              <button
                type="button"
                onClick={(e) => window.dispatchEvent(new CustomEvent('bobmail-toggle', {
                  detail: { anchor: (e.currentTarget as HTMLButtonElement).getBoundingClientRect() },
                }))}
                className="relative flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title={`Notifications (BobMail)${wantedPending > 0 ? ` — ${wantedPending} unread` : ''}`}
              >
                <Inbox className="h-3 w-3" />
                {wantedPending > 0 && (
                  <span
                    className="absolute -right-0.5 -top-0.5 flex h-[12px] min-w-[12px] items-center justify-center rounded-full px-0.5 text-7 font-bold leading-none"
                    style={{ backgroundColor: 'var(--danger)', color: '#fff' }}
                  >
                    {wantedPending > 99 ? '99+' : wantedPending}
                  </span>
                )}
              </button>
              {/* 分组分隔线：通知 │ 工具（R / 缩略图缩放 / 固定） */}
              <div className="mx-1 h-4 w-px shrink-0 self-center" style={{ backgroundColor: 'var(--line-soft)' }} />
              <button
                onClick={handleFit}
                className="rounded px-1.5 py-0.5 text-xs transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Fit view (relayout all nodes and fit canvas) — ⌘R"
              >
                R
              </button>
              <button
                onClick={cycleMapZoom}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title={`Thumbnail zoom ${mapZoom}x (click to toggle 1x / 2x)`}
              >
                <Scan className="h-3 w-3" />
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
            className="relative"
            style={{
              width: containerW,
              height: containerH,
              padding: pad,
              cursor: isMapDragging ? 'grabbing' : 'grab',
              userSelect: 'none',
              touchAction: 'none',
            }}
            onPointerDown={onMapPointerDown}
            onPointerMove={onMapPointerMove}
            onPointerUp={onMapPointerUp}
            onPointerCancel={onMapPointerUp}
            onPointerLeave={onMapPointerUp}
          >
            {/* 节点间连线 */}
            <svg
              className="nodemap-edges absolute inset-0 pointer-events-none"
              style={{ width: containerW, height: containerH, zIndex: 0 }}
            >
              {edges.map((edge) => {
                const s = centers[edge.source];
                const t = centers[edge.target];
                if (!s || !t) return null;
                return (
                  <line
                    key={edge.id}
                    x1={toMapX(s.cx)}
                    y1={toMapY(s.cy)}
                    x2={toMapX(t.cx)}
                    y2={toMapY(t.cy)}
                    stroke="var(--info-soft)"
                    strokeWidth={1}
                  />
                );
              })}
            </svg>
            {/* 当前视口框：仅边框标示画布视口位置，不填充——填充色在 zoom 100% 时会把缩略图盖满 */}
            <div
              className="absolute border pointer-events-none"
              style={{
                left: vpLeft,
                top: vpTop,
                width: vpScaledW,
                height: vpScaledH,
                borderColor: 'var(--primary-soft)',
                borderRadius: '2px',
                zIndex: 1,
              }}
            />
            {/* 节点圆点：外层 button 为扩大命中区（16px），内层 span 为视觉圆点（8px） */}
            {dots.map((dot) => (
              <button
                key={dot.id}
                className="absolute flex items-center justify-center"
                style={{
                  width: '16px',
                  height: '16px',
                  left: toMapX(dot.cx) - 8,
                  top: toMapY(dot.cy) - 8,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  zIndex: 2,
                }}
                onMouseEnter={() => setHoveredNodeId(dot.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
                // 已归档圆点：点击恢复节点回画布（节点从画布隐藏后仅圆点可见，圆点即归档入口）
                onClick={() => (dot.archived ? gateway.restoreNode(dot.id) : focusNode(dot.id))}
                title={dot.archived ? `Restore: ${dot.name}` : dot.name}
              >
                <span
                  className="block rounded-full transition-transform hover:scale-150"
                  style={{
                    width: '8px',
                    height: '8px',
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
                      (dot.archived ? '0 0 0 3px color-mix(in oklab, var(--success) 50%, transparent), ' : '') +
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
            ))}
            {/* 悬停提示 */}
            {hoveredNodeId && (
              <div
                className="absolute px-1.5 py-0.5 rounded text-xs leading-tight pointer-events-none whitespace-nowrap"
                style={{
                  left: Math.min(toMapX(dots.find((d) => d.id === hoveredNodeId)?.cx ?? 0) + 12, mapW - 40),
                  top: Math.max(toMapY(dots.find((d) => d.id === hoveredNodeId)?.cy ?? 0) - 4, 4),
                  backgroundColor: 'var(--ink)',
                  color: '#fff',
                  zIndex: 10,
                }}
              >
                {dots.find((d) => d.id === hoveredNodeId)?.name}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
