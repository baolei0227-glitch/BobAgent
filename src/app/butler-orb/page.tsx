'use client';

/**
 * /butler-orb —— 独立置顶球窗专用页（BobWork 最小化后的那颗桌面悬浮球）
 *
 * 宿主：`electron/butler-orb.ts` 创建的无边框透明置顶小窗（默认隐藏，主窗口最小化 / 隐藏时显示）。
 * 本页只做三件事：
 *   ① 画那颗球（外观与主窗口内那颗共用 `ButlerOrbVisual`，只有「独立态」加厚一层）
 *   ② 把指针事件交给主进程：dragStart / dragEnd（位移小于阈值 = 点击 → 恢复主窗口并开抽屉）。
 *      真正的窗口移动在主进程里做（`screen.getCursorScreenPoint()` 轮询 + setBounds）——
 *      窗口本身要跟着光标走，渲染层算不了屏幕坐标，也不该把拖动做成 `-webkit-app-region`（会吃掉 click）。
 *   ③ 未读角标：本窗没有主窗口那套事件总线（ButlerNoticeHost 在 /butler-orb 上被刻意不挂载），
 *      所以自己轮询 /api/butler/today（只读、失败静默，口径与主窗口那颗球一致）。
 *
 * 透明背景：globals.css 给 body 上了 `--canvas-bg`，不覆盖的话透明窗里会糊一层灰底。
 * 这里同时用 `<style>` 与内联样式双保险（内联样式优先级最高，且早于首帧水合生效）。
 */
import { useEffect, useRef, useState } from 'react';
import { ORB_SIZE, ORB_WINDOW_PAD } from '@/lib/butler/orb-geometry';
import { OrbFace, OrbGlassStyle } from '@/components/butler/ButlerOrbVisual';
import { fetchUnreadCount } from '@/components/butler/ButlerNoticeHost';

/** 未读兜底轮询：本窗收不到应用内的 BUTLER_UNREAD_CHANGED_EVENT，只能自己问服务端 */
const REFRESH_MS = 30_000;
/** 超过该位移（px）判定为拖拽而非点击 */
const DRAG_THRESHOLD = 4;

/** 透明窗必须自己抹掉全局底色（globals.css 的 body 背景 + 可能的滚动条） */
const TRANSPARENT_CSS = `
  html, body { background: transparent !important; overflow: hidden; margin: 0; padding: 0; }
  #__next, body > div { background: transparent !important; }
  * { -webkit-user-select: none; user-select: none; }
`;

export default function ButlerOrbWindowPage() {
  const [unread, setUnread] = useState(0);
  const [isDrag, setIsDrag] = useState(false);
  const dragging = useRef(false);
  const moved = useRef(false);
  const downAt = useRef<{ x: number; y: number } | null>(null);

  // 透明底：内联样式优先级最高，避免任何一层全局背景把窗口糊成灰块
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.overflow = 'hidden';
    document.body.style.margin = '0';
  }, []);

  // 未读轮询（只读、失败静默——助理不该因为角标失败打扰用户）
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const n = await fetchUnreadCount();
      if (alive && n !== null) setUnread(n);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // 指针事件挂 window：指针移出球（甚至移出窗口）也不丢 pointerup
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const down = downAt.current;
      if (down && !moved.current && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_THRESHOLD) {
        moved.current = true;
      }
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      downAt.current = null;
      setIsDrag(false);
      // moved=false → 主进程按「点击」处理：恢复并聚焦主窗口 + 打开 Butler 抽屉
      window.api?.butlerOrb?.dragEnd({ moved: moved.current });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    // 指针捕获丢失（系统抢走 / 拖拽会话被中断）也要收尾，否则主进程的轮询会一直跟着光标跑
    window.addEventListener('lostpointercapture', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('lostpointercapture', onUp);
    };
  }, []);

  return (
    <>
      <style>{TRANSPARENT_CSS}</style>
      <OrbGlassStyle />
      <button
        type="button"
        className={`butler-orb standalone${unread > 0 ? ' has-unread' : ''}`}
        aria-label="BobWork 助理"
        onPointerDown={(e) => {
          // 指针在窗口内的位置就是「抓取偏移」：主进程据此让球跟光标走（不会跳一下再跟手）
          dragging.current = true;
          moved.current = false;
          downAt.current = { x: e.clientX, y: e.clientY };
          // 捕获指针：快速拖动时指针很容易离开这 54px 的小窗，
          // 捕获后 pointermove / pointerup 仍回本元素（配合 macOS 的 drag 会话，拖到窗外也不丢）
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch { /* 捕获失败不影响主流程 */ }
          setIsDrag(true);
          window.api?.butlerOrb?.dragStart({ x: e.clientX, y: e.clientY });
        }}
        style={{
          position: 'absolute',
          left: ORB_WINDOW_PAD,
          top: ORB_WINDOW_PAD,
          width: ORB_SIZE,
          height: ORB_SIZE,
          borderRadius: '50%',
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'grab',
          touchAction: 'none',
        }}
      >
        <OrbFace unread={unread} dragging={isDrag} />
      </button>
    </>
  );
}
