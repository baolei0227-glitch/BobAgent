'use client';

/**
 * ButlerOrb —— 助理悬浮球（统一入口）
 *
 * 为什么不是往 ⌘F / 侧边导航 / 画布侧栏里加菜单：那几处都要动大组件
 * （UnifiedPalette 869 行、CanvasFlow 5700 行），
 * 悬浮球是自包含浮层，零侵入即可让 Butler 抽屉 / Today 页 / 记忆面板可达。
 *
 * 行为：
 *   - 拖拽移动（指针事件），位置存 localStorage，刷新后保持
 *   - 点击（未发生拖拽）→ 打开 / 收起 Butler 抽屉（微信式三栏；Today / 记忆 / 文档在抽屉左栏）
 *   - 未读总数 > 0 时在球上显示角标（2026-09-28 口径 = **好友会话未读消息 + 尚未点开的回执**，
 *     即 today 快照的 `chats.unread`，见 lib/butler/today.ts）：回执是「普通消息」的一种，
 *     点开卡片才清（卡片右上角红点），故也能进这个总数。
 *     刷新时机：① 收到 BUTLER_UNREAD_CHANGED_EVENT（新消息 / 新回执落库 / 被读）即时重拉；
 *     ② 点击悬浮球时；③ 120s 兜底轮询——前两者漏掉时最多晚 2 分钟纠正）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { BUTLER_INBOX_EVENT, BUTLER_UNREAD_CHANGED_EVENT } from './butlerEvents';
import { fetchUnreadCount } from './ButlerNoticeHost';
import { HippoFace } from './HippoFace';

/** 球体直径。28px：原 34px 在画布上偏抢眼，收小后回到「安静待在角落」的定位
 *  （其余定位/钳制逻辑均以本常量派生，改这里即可整体缩放）。 */
const ORB_SIZE = 28;
/** 默认落点相对中栏的留白 */
const EDGE_GAP = 16;
/** 位置键：默认落点语义从「视口右下角」改为「中栏左下角」，旧值一律作废（否则用户看到的还是旧位置） */
const POS_KEY = 'butler.orb.pos.v2';
/** 超过该位移（px）判定为拖拽而非点击 */
const DRAG_THRESHOLD = 4;
const REFRESH_MS = 120_000;
/** 「未读口径变了」信号的合并窗口：一次动作可能连派数个（落库 + 换 id / 回复落地 + 置已读），
 *  合并成一次拉取，避免同一秒打三四次 /api/butler/today。 */
const UNREAD_DEBOUNCE_MS = 400;

interface OrbPos {
  x: number;
  y: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 用户拖拽过的位置（钳回视口内，防止上次窗口更大导致球跑到屏幕外）；未拖拽过返回 null */
function readSavedPos(): OrbPos | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<OrbPos>;
    if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return null;
    return {
      x: clamp(saved.x, 8, window.innerWidth - ORB_SIZE - 8),
      y: clamp(saved.y, 8, window.innerHeight - ORB_SIZE - 8),
    };
  } catch {
    return null;
  }
}

/** 默认落点：中栏（对话区）左下角；中栏未挂载时退回视口左下角 */
function defaultPos(): OrbPos {
  const rect = document.querySelector('[data-host-canvas]')?.getBoundingClientRect();
  let left = 0;
  let bottom = window.innerHeight;
  if (rect && rect.width > ORB_SIZE * 3 && rect.height > ORB_SIZE * 3) {
    left = rect.left;
    bottom = rect.bottom;
  }
  return {
    x: clamp(left + EDGE_GAP, 8, window.innerWidth - ORB_SIZE - 8),
    y: clamp(bottom - ORB_SIZE - EDGE_GAP, 8, window.innerHeight - ORB_SIZE - 8),
  };
}

export function ButlerOrb() {
  const pathname = usePathname();
  const [pos, setPos] = useState<OrbPos | null>(null);
  const [unread, setUnread] = useState(0);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const offset = useRef({ dx: 0, dy: 0 });

  // 初始位置：中栏（对话区）左下角；已存的位置先钳回视口内（防止上次窗口更大导致球跑到屏幕外）
  useEffect(() => {
    if (pathname === '/browser-chat' || pathname === '/butler') return; // 这两个路由不渲染悬浮球，无需定位
    const saved = readSavedPos();
    if (saved) {
      setPos(saved);
      return;
    }
    // 中栏要等项目数据回来才挂载（hasProject === null 时只有 Loading 骨架），
    // 此时查不到 [data-host-canvas] → 用 rAF 等它出现（上限约 2s，仍无则退回视口左下角）。
    let raf = 0;
    let tries = 0;
    const place = () => {
      if (!document.querySelector('[data-host-canvas]') && tries++ < 120) {
        raf = requestAnimationFrame(place);
        return;
      }
      setPos(defaultPos());
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  // 未读消息角标（只读轮询，失败静默——助理不该因为角标失败打扰用户）
  const refreshUnread = useCallback(async () => {
    const unread = await fetchUnreadCount();
    if (unread !== null) setUnread(unread);
  }, []);

  useEffect(() => {
    void refreshUnread();
    const timer = window.setInterval(() => void refreshUnread(), REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [refreshUnread]);

  // 即时刷新：新消息 / 新回执落库 / 会话或卡片被读，都由生产端派 BUTLER_UNREAD_CHANGED_EVENT。
  // 只做「收到信号 → 重拉一次」，信号不带数字（真值由服务端 COUNT 决定）。
  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshUnread(), UNREAD_DEBOUNCE_MS);
    };
    window.addEventListener(BUTLER_UNREAD_CHANGED_EVENT, onChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(BUTLER_UNREAD_CHANGED_EVENT, onChange);
    };
  }, [refreshUnread]);

  // 拖拽：pointermove / pointerup 挂 window，保证拖出元素也不丢事件
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const nx = clamp(e.clientX - offset.current.dx, 8, window.innerWidth - ORB_SIZE - 8);
      const ny = clamp(e.clientY - offset.current.dy, 8, window.innerHeight - ORB_SIZE - 8);
      if (Math.abs(nx - (pos?.x ?? nx)) > 0 || Math.abs(ny - (pos?.y ?? ny)) > 0) moved.current = true;
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setPos((cur) => {
        if (cur) {
          try {
            window.localStorage.setItem(POS_KEY, JSON.stringify(cur));
          } catch {
            // 存储失败忽略：位置仅影响下次打开
          }
        }
        return cur;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pos]);

  /** 点击悬浮球：打开 / 收起 Butler 抽屉（锚点为球自身；toggle=true 表示再点即收起） */
  const openDialog = () => {
    void refreshUnread();
    window.dispatchEvent(
      new CustomEvent(BUTLER_INBOX_EVENT, {
        detail: { anchor: orbRef.current?.getBoundingClientRect() ?? null, toggle: true },
      }),
    );
  };

  // Hippo 对话侧栏（/browser-chat）不该出现悬浮球：它是主进程 WebContentsView 加载的独立页面，
  // 设计上「零 App 外壳」，但该路由没有自己的 layout → 继承根 layout，挂在根上的悬浮球会跟着渲染进去。
  // /butler（移动端单栏页）同理：页面本身就是 Butler，再挂一个「打开桌面抽屉」的球是多余入口。
  if (!pos || pathname === '/browser-chat' || pathname === '/butler') return null;

  return (
    <>
      {/* 液态玻璃球外观（透明折射 + 镜面高光）：球体/边缘/悬停态放 CSS 里，
          这样 :hover / :active 能不靠 JS 状态改样式；:active 光标也在此表达，
          避免在 render 里读 ref（react-hooks/refs 规则）。 */}
      <style>{`
        .butler-orb:active { cursor: grabbing !important; }
        /* 球体：**不用黑色描边**，靠「液态玻璃」撑出立体球感——
           ① 折射（backdrop-filter）：背后画布被模糊 + 提饱和，这是「液态玻璃」与「半透明圆」的分界。
              模糊量刻意压到 4px（悬停 6px）——球是 position:fixed 常驻元素，大半径 blur 在画布拖动时掉帧明显。
           ② 左上柔光高光（径向渐变，不是硬线，所以不会跟河马耳朵打架）
           ③ 边缘暗化（limb darkening）：中心全透明 → 越靠边越沉，球体边界由此成形
           ④ 上缘镜面弧（::after，见下）+ 外投影 + 左上内高光 + 右下内阴影（体积） */
        .butler-orb .ball {
          position: absolute; inset: 0; border-radius: 50%;
          overflow: hidden;
          background:
            radial-gradient(circle at 28% 22%, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.32) 13%, rgba(255,255,255,0) 35%),
            radial-gradient(circle at 36% 30%, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0) 51%),
            radial-gradient(circle at 50% 50%, rgba(255,255,255,0) 43%, rgba(122,136,166,0.11) 75%, rgba(86,100,130,0.34) 100%);
          -webkit-backdrop-filter: blur(4px) saturate(190%);
          backdrop-filter: blur(4px) saturate(190%);
          box-shadow:
            0 6px 16px rgba(15,20,40,0.20),
            0 1px 2px rgba(15,20,40,0.14),
            0 0 0 0.5px rgba(255,255,255,0.45),
            inset 0 1px 1px rgba(255,255,255,0.95),
            inset 3px 4px 9px rgba(255,255,255,0.62),
            inset -3px -5px 11px rgba(52,64,92,0.20),
            inset 0 -5px 9px rgba(255,255,255,0.22);
          transition: box-shadow .18s ease, transform .18s ease, backdrop-filter .18s ease;
        }
        /* 上缘镜面弧（specular rim）：液态玻璃最显眼的特征——一道贴住上内缘的窄亮弧。
           单独用 ::after 画，避免与中心高光糊成一片白。 */
        .butler-orb .ball::after {
          content: ''; position: absolute; inset: 0; border-radius: 50%;
          background: radial-gradient(ellipse 76% 46% at 50% -14%, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.20) 44%, rgba(255,255,255,0) 74%);
          mix-blend-mode: screen;
          pointer-events: none;
        }
        .butler-orb:hover .ball {
          box-shadow:
            0 9px 22px rgba(15,20,40,0.28),
            0 1px 3px rgba(15,20,40,0.16),
            0 0 0 0.5px rgba(255,255,255,0.60),
            inset 0 1px 1px rgba(255,255,255,1),
            inset 4px 5px 12px rgba(255,255,255,0.78),
            inset -4px -6px 14px rgba(52,64,92,0.24),
            inset 0 -6px 11px rgba(255,255,255,0.28);
          transform: scale(1.05);
          -webkit-backdrop-filter: blur(6px) saturate(210%);
          backdrop-filter: blur(6px) saturate(210%);
        }
        /* 河马线稿：黑色线条、透明底 → 叠在玻璃球里（不投影，才像「球里」而不是「球上」）。
           用矢量版 HippoFace（同一张线稿描的路径），好处是眼睛能独立分组、可眨眼。 */
        .butler-orb .ball .hippo-face { position: absolute; inset: 9%; width: 82%; height: 82%; }
      `}</style>
      <button
        type="button"
        className="butler-orb"
        ref={orbRef}
        aria-label="BobWork 助理"
        onPointerDown={(e) => {
          dragging.current = true;
          moved.current = false;
          offset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        onClick={() => {
          // 拖拽结束也会触发 click：位移未过阈值才算点击
          if (!moved.current) openDialog();
        }}
        style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          width: ORB_SIZE,
          height: ORB_SIZE,
          borderRadius: '50%',
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'grab',
          zIndex: 1300,
          touchAction: 'none',
          // 投影交给 .ball 的 box-shadow：filter:drop-shadow 是按「非透明像素」描边，
          // 透明球身上只有河马线条会被描出来（＝线条自己投影），与「球里」的观感相悖。
        }}
      >
        <span className="ball" aria-hidden>
          <HippoFace className="hippo-face" />
        </span>
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              minWidth: 12,
              height: 12,
              padding: '0 3px',
              borderRadius: 999,
              background: 'var(--danger)',
              color: '#fff',
              fontSize: 8,
              lineHeight: '12px',
              textAlign: 'center',
              boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    </>
  );
}
