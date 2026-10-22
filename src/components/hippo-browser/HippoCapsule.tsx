'use client';

/**
 * Hippo Browser「胶囊态」浮层——浏览器窗口收起时（非关闭），在主窗口正中
 * 显示一个圆角矩形胶囊按钮 + 呼吸灯。点击即恢复浏览器窗口。
 *
 * 状态来源：主进程在收起/恢复时通过 'hippo-browser:capsule' 事件推送，
 * preload 的 onCapsule 订阅；这里同步本地 state 控制显隐。
 *
 * 拖拽：胶囊可按住拖动（相对默认「顶部居中」的偏移），位置落盘，
 * 下次收起时回到同一处；位移超过阈值判定为拖拽，不触发恢复。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Globe } from 'lucide-react';
import { desktop } from '@/lib/desktop-adapter';

/** 拖拽偏移（相对默认位置）的落盘键 */
const OFFSET_KEY = 'hippo.capsule.offset.v1';
/** 超过该位移（px）判定为拖拽而非点击 */
const DRAG_THRESHOLD = 4;
/** 默认位置距顶部，与 globals.css 的 .hippo-capsule top 保持一致 */
const BASE_TOP = 56;
/** 拖到视口边缘时至少保留的内缩，避免贴边后不好抓 */
const EDGE_GAP = 8;

type Offset = { x: number; y: number };

const HOME: Offset = { x: 0, y: 0 };

function readSavedOffset(): Offset | null {
  try {
    const raw = window.localStorage.getItem(OFFSET_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Offset>;
    if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return null;
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
    return { x: saved.x, y: saved.y };
  } catch {
    return null;
  }
}

function saveOffset(offset: Offset): void {
  try {
    window.localStorage.setItem(OFFSET_KEY, JSON.stringify(offset));
  } catch {
    // 存储失败忽略：位置仅影响下次收起时的落点
  }
}

export function HippoCapsule() {
  const [capsule, setCapsule] = useState(false);
  const [offset, setOffset] = useState<Offset>(HOME);
  const [dragging, setDragging] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  /** 最近一次偏移（pointerup 时读，避免闭包里的旧 state） */
  const offsetRef = useRef<Offset>(HOME);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);
  /** 拖拽结束后紧随其后的 click 要吞掉，避免误恢复浏览器 */
  const suppressClick = useRef(false);

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  // 恢复上次拖到的位置（仅在客户端读 localStorage）
  useEffect(() => {
    setOffset(readSavedOffset() ?? HOME);
  }, []);

  useEffect(() => {
    // 初始同步一次当前态（避免主窗口晚于浏览器创建，漏掉首帧状态）
    let alive = true;
    void desktop.hippoBrowser.getCapsule().then((on) => {
      if (alive) setCapsule(!!on);
    });
    const unsub = desktop.hippoBrowser.onCapsule((on) => setCapsule(!!on));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  /** 把偏移限制在视口内（按胶囊实际宽高算边界） */
  const clampOffset = useCallback((x: number, y: number): Offset => {
    const el = btnRef.current;
    if (!el) return { x, y };
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const halfRoom = (window.innerWidth - w) / 2;
    const minX = EDGE_GAP - halfRoom;
    const maxX = halfRoom - EDGE_GAP;
    const minY = EDGE_GAP - BASE_TOP;
    const maxY = window.innerHeight - h - EDGE_GAP - BASE_TOP;
    return {
      x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
      y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
    };
  }, []);

  // 窗口尺寸变化后重新夹取，避免拖过的位置在缩小窗口后跑到视口外
  useEffect(() => {
    const onResize = () => setOffset((o) => clampOffset(o.x, o.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampOffset]);

  // 胶囊出现时按当前视口夹取一次（上次落盘的位置可能来自更大的窗口）
  useEffect(() => {
    if (capsule) setOffset((o) => clampOffset(o.x, o.y));
  }, [capsule, clampOffset]);

  if (!capsule) return null;

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const base = offsetRef.current;
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: base.x, baseY: base.y, moved: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    const next = clampOffset(d.baseX + dx, d.baseY + dy);
    offsetRef.current = next;
    setOffset(next);
  };

  const endDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!d.moved) return;
    suppressClick.current = true;
    setDragging(false);
    saveOffset(offsetRef.current);
  };

  return (
    <button
      ref={btnRef}
      type="button"
      aria-label="Restore Hippo Browser"
      title="Click to restore the browser (⌘⇧B) · Drag to move"
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        void desktop.hippoBrowser.capsuleToggle();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={`hippo-capsule${dragging ? ' is-dragging' : ''}`}
      style={
        {
          '--capsule-x': `${offset.x}px`,
          '--capsule-y': `${offset.y}px`,
        } as CSSProperties
      }
    >
      <Globe className="h-[23px] w-[23px]" />
      <span className="hippo-capsule__dot" aria-hidden />
    </button>
  );
}
