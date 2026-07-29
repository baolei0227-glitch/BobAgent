'use client';

import { useCallback, useState, useRef } from 'react';
import {
  Position,
  getBezierPath,
  useInternalNode,
  useReactFlow,
  type Edge,
  type Node,
  type InternalNode,
  type EdgeProps,
} from '@xyflow/react';

type FloatingEdgeData = {
  relation?: 'child' | 'sibling';
  disconnected?: boolean;
};

/** 节点中心坐标 */
function getNodeCenter(node: InternalNode<Node>): { x: number; y: number } {
  const { position, measured } = node;
  const width = measured?.width ?? 320;
  const height = measured?.height ?? 400;
  return {
    x: position.x + width / 2,
    y: position.y + height / 2,
  };
}

/** 根据侧边计算节点边上的实际连接坐标 */
function sideCoords(
  node: InternalNode<Node>,
  pos: Position,
): { x: number; y: number } {
  const w = node.measured?.width ?? 320;
  const h = node.measured?.height ?? 400;
  switch (pos) {
    case Position.Top:
      return { x: node.position.x + w / 2, y: node.position.y };
    case Position.Bottom:
      return { x: node.position.x + w / 2, y: node.position.y + h };
    case Position.Left:
      return { x: node.position.x, y: node.position.y + h / 2 };
    case Position.Right:
      return { x: node.position.x + w, y: node.position.y + h / 2 };
  }
}

/** 计算两个节点之间最近的侧边连接参数 */
function getEdgeParams(
  source: InternalNode<Node>,
  target: InternalNode<Node>,
): { sx: number; sy: number; tx: number; ty: number; sourcePos: Position; targetPos: Position } {
  const sourceCenter = getNodeCenter(source);
  const targetCenter = getNodeCenter(target);

  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;

  let sourcePos: Position;
  let targetPos: Position;

  if (Math.abs(dx) > Math.abs(dy)) {
    sourcePos = dx > 0 ? Position.Right : Position.Left;
    targetPos = dx > 0 ? Position.Left : Position.Right;
  } else {
    sourcePos = dy > 0 ? Position.Bottom : Position.Top;
    targetPos = dy > 0 ? Position.Top : Position.Bottom;
  }

  const s = sideCoords(source, sourcePos);
  const t = sideCoords(target, targetPos);

  return { sx: s.x, sy: s.y, tx: t.x, ty: t.y, sourcePos, targetPos };
}

/** 拖拽断开的距离阈值（屏幕像素） */
const DRAG_THRESHOLD = 30;

export function FloatingEdge({
  id,
  source,
  target,
  data,
}: EdgeProps<Edge<FloatingEdgeData>>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const relation = data?.relation ?? 'child';
  const disconnected = data?.disconnected ?? false;
  const { setEdges } = useReactFlow();

  // 拖拽断开状态
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  // 拖拽中点圆圈：开始
  const handlePointerDown = useCallback((e: React.PointerEvent<SVGGElement>) => {
    if (disconnected) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as SVGGElement).setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    setDragPos({ x: e.clientX, y: e.clientY });
  }, [disconnected]);

  // 拖拽中：更新位置，超过阈值则断开
  const handlePointerMove = useCallback((e: React.PointerEvent<SVGGElement>) => {
    if (!dragging || !dragStartRef.current) return;
    e.stopPropagation();
    setDragPos({ x: e.clientX, y: e.clientY });

    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > DRAG_THRESHOLD) {
      // 超过阈值 → 断开连线
      setDragging(false);
      setDragPos(null);
      dragStartRef.current = null;

      setEdges((eds) =>
        eds.map((ed) =>
          ed.id === id ? { ...ed, data: { ...ed.data, disconnected: true } } : ed,
        ),
      );
      fetch('/api/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', edge_id: id }),
      }).catch((err) => console.error('连线断开出错:', err));
    }
  }, [dragging, id, setEdges]);

  // 拖拽结束
  const handlePointerUp = useCallback((e: React.PointerEvent<SVGGElement>) => {
    if (pointerIdRef.current !== null) {
      (e.currentTarget as SVGGElement).releasePointerCapture(pointerIdRef.current);
      pointerIdRef.current = null;
    }
    setDragging(false);
    setDragPos(null);
    dragStartRef.current = null;
  }, []);

  // 点击"断"徽标 → 重连续线
  const handleReconnect = useCallback(() => {
    setEdges((eds) =>
      eds.map((ed) =>
        ed.id === id ? { ...ed, data: { ...ed.data, disconnected: false } } : ed,
      ),
    );
    fetch('/api/edges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reconnect', edge_id: id }),
    }).catch((err) => console.error('连重连出错:', err));
  }, [id, setEdges]);

  if (!sourceNode || !targetNode) return null;

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);

  const [edgePath] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
    curvature: 0.25,
  });

  const midX = (sx + tx) / 2;
  const midY = (sy + ty) / 2;

  const isChild = relation === 'child';

  const strokeColor = disconnected
    ? 'oklch(0.65 0.01 60 / 0.4)'
    : isChild
      ? 'oklch(0.55 0.12 45 / 0.5)'
      : 'oklch(0.55 0.12 45 / 0.3)';
  const strokeWidth = disconnected ? 1.5 : isChild ? 2 : 1.5;
  const dashArray = disconnected ? '3 5' : isChild ? '8 4' : '6 4';

  // 拖拽时的临时连线（从中点到鼠标位置）
  const dragLinePath = dragging && dragPos
    ? `M ${midX} ${midY} L ${dragPos.x} ${dragPos.y}`
    : null;

  return (
    <>
      {/* 主连线 */}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={dashArray}
        markerEnd={!disconnected && isChild ? 'url(#floating-arrow)' : undefined}
        style={!disconnected && isChild ? { animation: 'dashflow 0.8s linear infinite' } : undefined}
      />

      {/* 拖拽时的临时虚线 */}
      {dragLinePath && (
        <path
          d={dragLinePath}
          fill="none"
          stroke="oklch(0.62 0.17 45 / 0.5)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* 活跃连线的中点圆圈：拖拽断开 */}
      {!disconnected && (
        <g
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        >
          {/* 透明大圆，扩大可拖拽区域 */}
          <circle
            cx={midX}
            cy={midY}
            r={hovering || dragging ? 28 : 20}
            fill="transparent"
          />
          {/* hover 高亮光环 */}
          {(hovering || dragging) && (
            <circle
              cx={midX}
              cy={midY}
              r={16}
              fill="oklch(0.62 0.17 45 / 0.06)"
              stroke="oklch(0.62 0.17 45 / 0.2)"
              strokeWidth={1.5}
              strokeDasharray="3 2"
            />
          )}
          {/* 可见圆圈 */}
          <circle
            cx={midX}
            cy={midY}
            r={hovering || dragging ? 7 : 5}
            fill="oklch(0.97 0.015 80 / 0.95)"
            stroke={dragging ? 'oklch(0.55 0.15 25 / 0.8)' : hovering ? 'oklch(0.62 0.17 45 / 0.7)' : 'oklch(0.55 0.12 45 / 0.4)'}
            strokeWidth={2}
            style={{ transition: 'r 0.15s, stroke 0.15s' }}
          />
          {/* hover 时显示拖拽提示 */}
          {hovering && !dragging && (
            <text
              x={midX}
              y={midY - 11}
              textAnchor="middle"
              fontSize={8}
              fill="oklch(0.55 0.12 45 / 0.9)"
              style={{ fontFamily: 'sans-serif', pointerEvents: 'none', fontWeight: 500 }}
            >
              拖拽断开
            </text>
          )}
        </g>
      )}

      {/* 断线徽标：点击重连 */}
      {disconnected && (
        <g
          onClick={handleReconnect}
          style={{ cursor: 'pointer' }}
        >
          <circle
            cx={midX}
            cy={midY}
            r={11}
            fill="oklch(0.97 0.015 80 / 0.95)"
            stroke="oklch(0.55 0.15 25 / 0.6)"
            strokeWidth={1.5}
          />
          <text
            x={midX}
            y={midY + 3}
            textAnchor="middle"
            fontSize={9}
            fill="oklch(0.50 0.15 25)"
            style={{ fontFamily: 'sans-serif', pointerEvents: 'none', fontWeight: 600 }}
          >
            ✕
          </text>
          {/* hover 提示 */}
          <title>Click to reconnect</title>
        </g>
      )}
    </>
  );
}

/** SVG <defs>，提供浮动边使用的箭头 marker */
export function FloatingEdgeDefs() {
  return (
    <svg className="absolute" style={{ width: 0, height: 0 }}>
      <defs>
        <marker
          id="floating-arrow"
          markerWidth="12"
          markerHeight="12"
          refX="10"
          refY="6"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 0 L 12 6 L 0 12 L 3 6 Z" fill="oklch(0.55 0.12 45 / 0.6)" />
        </marker>
      </defs>
    </svg>
  );
}
