'use client';

import { useRef, useState, useCallback } from 'react';

/**
 * 缩略图拖拽平移画布（React Hook）。
 *
 * 核心交互规则：
 *  - 按下圆点/按钮区域 → 不触发拖拽（被 closest('button') 过滤）
 *  - 按下后移动 <4px → 视作 click，不捕获指针，圆点的 click 不被抢走
 *  - 移动 ≥4px → 才 setPointerCapture 进入拖拽态，缩略图改为 grabbing 光标
 *  - 拖拽位移（像素）/ scale（缩略图倍率）= 世界坐标位移 → gateway.setViewport({x,y,zoom})
 *
 * 参数：
 *  - vpX/vpY/vpZoom: 当前画布视口（从 gateway.getViewport() 或订阅快照）
 *  - scale: 缩略图坐标映射倍率（= min(mapW/bw, mapH/bh)）
 *  - setViewport: GraphGateway.setViewport，写入画布平移
 *
 * 用法：
 *  const { isDragging, onPointerDown, onPointerMove, onPointerUp } = useThumbnailDrag({...});
 *  <svg onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerUp}>
 */
export function useThumbnailDrag(opts: {
  vpX: number;
  vpY: number;
  vpZoom: number;
  scale: number;
  setViewport: (vp: { x: number; y: number; zoom: number }, opts?: { duration?: number }) => void;
}): {
  isDragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
} {
  const { vpX, vpY, vpZoom, scale, setViewport } = opts;

  type DragState = {
    startX: number;
    startY: number;
    startVpX: number;
    startVpY: number;
    captured: boolean;
  };
  const dragRef = useRef<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startVpX: vpX,
        startVpY: vpY,
        captured: false,
      };
    },
    [vpX, vpY],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.captured) {
        if (Math.hypot(dx, dy) < 4) return;
        // 确认是拖拽（而非 click）后才捕获指针，保证圆点的 click 不被抢走
        d.captured = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setIsDragging(true);
      }
      setViewport({ x: d.startVpX - dx / scale, y: d.startVpY - dy / scale, zoom: vpZoom });
    },
    [scale, vpZoom, setViewport],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  return { isDragging, onPointerDown, onPointerMove, onPointerUp };
}
