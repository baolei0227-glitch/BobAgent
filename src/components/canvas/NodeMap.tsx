'use client';

import { useState, useMemo } from 'react';
import { useReactFlow, useNodes, useViewport } from '@xyflow/react';
import { Map, ChevronDown } from 'lucide-react';

/** 节点地图 — 小圆点形式展示全部节点 */
export function NodeMap() {
  const [collapsed, setCollapsed] = useState(true);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const nodes = useNodes();
  const { x: vpX, y: vpY, zoom: vpZoom } = useViewport();
  const { setCenter, fitView } = useReactFlow();

  const { dots, bounds } = useMemo(() => {
    if (nodes.length === 0) return { dots: [], bounds: null };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const list: { id: string; cx: number; cy: number; name: string }[] = [];

    for (const n of nodes) {
      const w = n.measured?.width ?? 320;
      const h = n.measured?.height ?? 200;
      const cx = n.position.x + w / 2;
      const cy = n.position.y + h / 2;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
      const title = (n.data as { title?: string })?.title || n.id.slice(0, 8);
      list.push({ id: n.id, cx, cy, name: title });
    }

    const pad = 40;
    return { dots: list, bounds: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad } };
  }, [nodes]);

  if (nodes.length === 0 || !bounds) {
    return (
      <div className="absolute bottom-4 right-4 z-10">
        <button
          className="flex h-8 w-8 items-center justify-center rounded-lg shadow-md opacity-50 cursor-default"
          style={{
            backgroundColor: 'oklch(0.97 0.01 80)',
            border: '1px solid oklch(0.85 0.01 70)',
          }}
        >
          <Map className="h-4 w-4" style={{ color: 'oklch(0.55 0.02 50)' }} />
        </button>
      </div>
    );
  }

  const mapW = 180;
  const mapH = 120;
  const bw = bounds.maxX - bounds.minX;
  const bh = bounds.maxY - bounds.minY;
  const scale = Math.min(mapW / bw, mapH / bh);

  const toMapX = (x: number) => (x - (bounds.minX + bounds.maxX) / 2) * scale + mapW / 2;
  const toMapY = (y: number) => (y - (bounds.minY + bounds.maxY) / 2) * scale + mapH / 2;

  // 视口框大小
  const vpW = (typeof window !== 'undefined' ? window.innerWidth : 1200) / vpZoom;
  const vpH = (typeof window !== 'undefined' ? window.innerHeight : 800) / vpZoom;
  const vpLeft = toMapX(vpX) + 8;
  const vpTop = toMapY(vpY) + 8;
  const vpScaledW = Math.max(vpW * scale, 4);
  const vpScaledH = Math.max(vpH * scale, 4);

  return (
    <div
      className="absolute bottom-4 right-4 z-10"
      style={{ fontFamily: "'Noto Serif SC', serif" }}
    >
      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          className="flex h-8 w-8 items-center justify-center rounded-lg shadow-md transition-colors hover:bg-[oklch(0.92_0.015_75)]"
          style={{
            backgroundColor: 'oklch(0.97 0.01 80)',
            border: '1px solid oklch(0.85 0.01 70)',
          }}
          title={`节点地图 (${nodes.length})`}
        >
          <Map className="h-4 w-4" style={{ color: 'oklch(0.50 0.02 50)' }} />
        </button>
      ) : (
        <div
          className="rounded-lg shadow-lg overflow-hidden"
          style={{
            width: mapW + 16,
            backgroundColor: 'oklch(0.97 0.01 80)',
            border: '1px solid oklch(0.85 0.01 70)',
          }}
        >
          <div
            className="flex items-center justify-between px-2 py-1.5"
            style={{ borderBottom: '1px solid oklch(0.85 0.01 70)' }}
          >
            <span className="text-[10px] font-semibold" style={{ color: 'oklch(0.40 0.015 50)' }}>
              节点地图 ({nodes.length})
            </span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => fitView({ padding: 0.4, maxZoom: 1 })}
                className="rounded px-1.5 py-0.5 text-[9px] transition-colors hover:bg-[oklch(0.92_0.015_75)]"
                style={{ color: 'oklch(0.50 0.02 50)' }}
                title="适合画面"
              >
                Fit
              </button>
              <button
                onClick={() => setCollapsed(true)}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[oklch(0.90_0.015_75)]"
                style={{ color: 'oklch(0.50 0.02 50)' }}
              >
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="relative" style={{ width: mapW + 16, height: mapH + 16, padding: 8 }}>
            {/* 当前视口框 */}
            <div
              className="absolute border pointer-events-none"
              style={{
                left: vpLeft,
                top: vpTop,
                width: vpScaledW,
                height: vpScaledH,
                borderColor: 'oklch(0.62 0.17 45 / 0.35)',
                backgroundColor: 'oklch(0.62 0.17 45 / 0.06)',
                borderRadius: '2px',
                zIndex: 1,
              }}
            />
            {/* 节点圆点 */}
            {dots.map((dot) => (
              <button
                key={dot.id}
                className="absolute rounded-full transition-transform hover:scale-150"
                style={{
                  width: '8px',
                  height: '8px',
                  left: toMapX(dot.cx) + 4,
                  top: toMapY(dot.cy) + 4,
                  backgroundColor:
                    hoveredNodeId === dot.id
                      ? 'oklch(0.62 0.17 45)'
                      : 'oklch(0.55 0.05 45 / 0.6)',
                  boxShadow:
                    hoveredNodeId === dot.id
                      ? '0 0 6px oklch(0.62 0.17 45 / 0.5)'
                      : 'none',
                  zIndex: 2,
                }}
                onMouseEnter={() => setHoveredNodeId(dot.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
                onClick={() => {
                  setCenter(dot.cx, dot.cy, { zoom: vpZoom, duration: 500 });
                }}
                title={dot.name}
              />
            ))}
            {/* 悬停提示 */}
            {hoveredNodeId && (
              <div
                className="absolute px-1.5 py-0.5 rounded text-[10px] leading-tight pointer-events-none whitespace-nowrap"
                style={{
                  left: Math.min(toMapX(dots.find((d) => d.id === hoveredNodeId)?.cx ?? 0) + 12, mapW - 40),
                  top: Math.max(toMapY(dots.find((d) => d.id === hoveredNodeId)?.cy ?? 0) - 4, 4),
                  backgroundColor: 'oklch(0.30 0.015 50 / 0.85)',
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
