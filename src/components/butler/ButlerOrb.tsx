'use client';

/**
 * ButlerOrb —— 助理悬浮球（统一入口 · 主窗口内形态）
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
 *
 * 位置语义（2026-10 改造，几何算术见 `@/lib/butler/orb-geometry`）：
 *   - 球的家 = **中栏（对话区）左下角**（`[data-host-canvas]`）。旧实现存「视口绝对坐标」，
 *     于是左侧栏 / 导航折叠、右栏显隐、窗口缩放时球都杵在原地；现在存的是**相对锚点的偏移**，
 *     锚点一动球跟着动（偏移 (0,0) 即「家在锚点左下角内缩 ORB_EDGE_GAP」）。
 *   - 落盘同样是偏移，刷新后能还原用户拖到的地方。
 *   - 窗口最大化 / 还原 / 进出全屏 → 主进程派 `butler-orb:window-state`，偏移清零 = 弹回中栏左下角。
 *   - 主窗口最小化 / 隐藏 → 本球随窗口一起不可见，由**独立置顶球窗**接管（electron/butler-orb.ts）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { BUTLER_INBOX_EVENT, BUTLER_ORB_HOME_EVENT, BUTLER_UNREAD_CHANGED_EVENT } from './butlerEvents';
import { fetchUnreadCount } from './ButlerNoticeHost';
import { OrbFace, OrbGlassStyle } from './ButlerOrbVisual';
import {
  ORB_SIZE,
  canHostOrb,
  clamp,
  clampOrbPoint,
  orbOffsetFromPoint,
  orbPointFromOffset,
  type OrbAnchor,
  type OrbPoint,
} from '@/lib/butler/orb-geometry';

/** 位置键：语义从「视口绝对坐标」改为「相对中栏左下角的偏移」，旧值一律作废
 *  （旧值是绝对坐标，当偏移用会让球直接飞到视口外） */
const OFFSET_KEY = 'butler.orb.offset.v1';
/** 超过该位移（px）判定为拖拽而非点击 */
const DRAG_THRESHOLD = 4;
const REFRESH_MS = 120_000;
/** 「未读口径变了」信号的合并窗口：一次动作可能连派数个（落库 + 换 id / 回复落地 + 置已读），
 *  合并成一次拉取，避免同一秒打三四次 /api/butler/today。 */
const UNREAD_DEBOUNCE_MS = 400;
/** 等中栏挂载的上限（项目数据回来才有 [data-host-canvas]）≈ 2s */
const HOST_WAIT_FRAMES = 120;
/** 兜底重测周期：ResizeObserver 覆盖不到的布局变化（右栏显隐等）靠它纠偏 */
const ANCHOR_RECONCILE_MS = 500;
/** 不渲染悬浮球的路由：
 *  - /butler：页面本身就是 Butler，再挂一个「打开桌面抽屉」的球是多余入口
 *  - /browser-chat：主进程 WebContentsView 加载的零外壳页面，但该路由没有自己的 layout，
 *    会继承根 layout 而把球渲染进去
 *  - /butler-orb、/butler-panel：主进程独立窗专用页（自己就是那颗球 / 那块面板，
 *    再挂一颗球会变成两颗） */
const SKIP_ROUTES = new Set(['/browser-chat', '/butler', '/butler-orb', '/butler-panel']);
/** 家的偏移 */
const HOME: OrbPoint = { x: 0, y: 0 };

/** 测量中栏锚点。中栏未挂载 / 尺寸不足（Loading 骨架、无项目）时退回视口左下角 */
function measureAnchor(): { anchor: OrbAnchor; fromHost: boolean } {
  const rect = document.querySelector('[data-host-canvas]')?.getBoundingClientRect();
  if (rect && canHostOrb({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })) {
    return { anchor: { left: rect.left, bottom: rect.bottom }, fromHost: true };
  }
  return { anchor: { left: 0, bottom: window.innerHeight }, fromHost: false };
}

/** 锚点是否已变（亚像素抖动不触发重渲染） */
function sameAnchor(a: OrbAnchor | null, b: OrbAnchor): boolean {
  if (!a) return false;
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.bottom - b.bottom) < 0.5;
}

/** 读回用户拖拽落盘的偏移（损坏 / 旧语义的值一律丢弃，退回「家」） */
function readSavedOffset(): OrbPoint | null {
  try {
    const raw = window.localStorage.getItem(OFFSET_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<OrbPoint>;
    if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return null;
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
    return { x: saved.x, y: saved.y };
  } catch {
    return null;
  }
}

function saveOffset(offset: OrbPoint): void {
  try {
    window.localStorage.setItem(OFFSET_KEY, JSON.stringify(offset));
  } catch {
    // 存储失败忽略：位置仅影响下次打开
  }
}

export function ButlerOrb() {
  const pathname = usePathname();
  /** 中栏左下角（视口坐标）；null = 还没测到锚点，先不渲染（避免先落在视口角上再跳一次） */
  const [anchor, setAnchor] = useState<OrbAnchor | null>(null);
  /** 相对锚点的偏移；(0,0) = 家 */
  const [offset, setOffset] = useState<OrbPoint>(HOME);
  const [unread, setUnread] = useState(0);
  // C 拖拽歪头：tilt=当前倾斜角（度），isDrag=是否按住拖动（决定跟随/弹簧 + 暂停其他动效）
  const [tilt, setTilt] = useState(0);
  const [isDrag, setIsDrag] = useState(false);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  /** 指针在球内的抓取偏移（按下瞬间的指针 − 球点） */
  const grab = useRef({ dx: 0, dy: 0 });
  /** 按下时的指针位置：用来判定「拖拽 vs 点击」 */
  const downAt = useRef<{ x: number; y: number } | null>(null);
  /** 拖拽水平速度（px/s，EMA 平滑）；停止移动时由 rAF 按半衰期衰减 → 头慢慢回正 */
  const vxRef = useRef(0);
  const lastMoveRef = useRef<{ t: number; x: number } | null>(null);
  const tiltShownRef = useRef(0);

  // 锚点跟踪：中栏挂载后测量，并在「中栏自身 / 其容器尺寸变化」与窗口 resize 时重测。
  // 侧栏与导航折叠都会改变中栏的左边缘 → ResizeObserver 即时跟上（避免球在动画结束后才瞬移）；
  // 500ms 兜底重测负责 ResizeObserver 覆盖不到的布局变化（如右栏显隐改变中栏宽度但元素未 remount）。
  useEffect(() => {
    if (SKIP_ROUTES.has(pathname)) return;
    setOffset(readSavedOffset() ?? HOME);

    let rafWait = 0;
    let rafCommit = 0;
    let tries = 0;
    let timer = 0;
    let ro: ResizeObserver | null = null;
    let observed: Element | null = null;

    /** 中栏可能整块重挂（切项目）：观察对象变了就换绑 */
    const syncObserver = () => {
      const host = document.querySelector('[data-host-canvas]');
      if (host === observed) return;
      if (observed && ro) ro.unobserve(observed);
      observed = host;
      if (host && ro) {
        ro.observe(host);
        if (host.parentElement) ro.observe(host.parentElement);
      }
    };

    const commit = () => {
      rafCommit = 0;
      const { anchor: next } = measureAnchor();
      syncObserver();
      setAnchor((prev) => (sameAnchor(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!rafCommit) rafCommit = requestAnimationFrame(commit);
    };
    if (typeof ResizeObserver !== 'undefined') ro = new ResizeObserver(() => schedule());

    // 中栏要等项目数据回来才挂载（hasProject === null 时只有 Loading 骨架），
    // 此时查不到 [data-host-canvas] → 用 rAF 等它出现（上限约 2s，仍无则退回视口左下角）。
    const waitForHost = () => {
      const { fromHost } = measureAnchor();
      if (!fromHost && tries++ < HOST_WAIT_FRAMES) {
        rafWait = requestAnimationFrame(waitForHost);
        return;
      }
      commit();
      window.addEventListener('resize', schedule);
      timer = window.setInterval(schedule, ANCHOR_RECONCILE_MS);
    };
    waitForHost();

    return () => {
      cancelAnimationFrame(rafWait);
      cancelAnimationFrame(rafCommit);
      window.clearInterval(timer);
      window.removeEventListener('resize', schedule);
      if (observed && ro) ro.unobserve(observed);
      ro?.disconnect();
    };
  }, [pathname]);

  // 最大化 / 还原 / 进出全屏：主进程派窗口状态事件 → 偏移清零 = 球弹回中栏左下角（丢弃拖拽位置）
  useEffect(() => {
    const off = window.api?.butlerOrb?.onWindowState(() => {
      setOffset(HOME);
      saveOffset(HOME);
    });
    return () => {
      off?.();
    };
  }, []);

  // 抽屉左轨红键「关闭」：同样把球送回中栏左下角（见 butlerEvents 的 BUTLER_ORB_HOME_EVENT）
  useEffect(() => {
    const onHome = () => {
      setOffset(HOME);
      saveOffset(HOME);
    };
    window.addEventListener(BUTLER_ORB_HOME_EVENT, onHome);
    return () => window.removeEventListener(BUTLER_ORB_HOME_EVENT, onHome);
  }, []);

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

  // 拖拽：pointermove / pointerup 挂 window，保证拖出元素也不丢事件。
  // 落盘的是「相对锚点的偏移」：中栏一动（折叠 / 缩放）球跟着动，而不是留在旧绝对坐标。
  useEffect(() => {
    if (!anchor) return;
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const down = downAt.current;
      if (down && !moved.current && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_THRESHOLD) {
        moved.current = true;
      }
      const desired = clampOrbPoint(
        { x: e.clientX - grab.current.dx, y: e.clientY - grab.current.dy },
        { width: window.innerWidth, height: window.innerHeight },
      );
      // 速度：dx/dt（夹住极端 dt），EMA 平滑，钳 ±1400px/s（rAF 衰减在另一 effect 里）
      const last = lastMoveRef.current;
      if (last) {
        const dt = e.timeStamp - last.t;
        if (dt > 0) {
          const raw = clamp(((e.clientX - last.x) / dt) * 1000, -1400, 1400);
          vxRef.current = raw * 0.55 + vxRef.current * 0.45;
        }
      }
      lastMoveRef.current = { t: e.timeStamp, x: e.clientX };
      setOffset(orbOffsetFromPoint(desired, anchor));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      downAt.current = null;
      lastMoveRef.current = null;
      vxRef.current = 0;
      tiltShownRef.current = 0;
      setIsDrag(false);
      setTilt(0); // 松手：角度归零，HippoFace 用弹簧过渡回正
      setOffset((cur) => {
        saveOffset(cur);
        return cur;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [anchor]);

  // 拖拽中：rAF 循环做速度衰减 + 速度→倾斜角映射。
  // 鼠标停下但还按住时，vx 按半衰期 110ms 衰减（时间基准，帧率无关），头缓缓回正而不是瞬回。
  useEffect(() => {
    if (!isDrag) return;
    let raf = 0;
    let lastT = performance.now();

    const frame = (now: number) => {
      const dt = now - lastT;
      lastT = now;
      vxRef.current *= Math.pow(0.5, dt / 110);
      const target = clamp(vxRef.current * 0.045, -14, 14);
      if (Math.abs(target - tiltShownRef.current) > 0.2) {
        tiltShownRef.current = target;
        setTilt(target);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [isDrag]);

  /** 点击悬浮球：打开 / 收起 Butler 抽屉（锚点为球自身；toggle=true 表示再点即收起） */
  const openDialog = () => {
    void refreshUnread();
    window.dispatchEvent(
      new CustomEvent(BUTLER_INBOX_EVENT, {
        detail: { anchor: orbRef.current?.getBoundingClientRect() ?? null, toggle: true },
      }),
    );
  };

  if (!anchor || SKIP_ROUTES.has(pathname)) return null;

  // 渲染点 = 家 + 偏移，再钳回视口内（偏移本身不动：窗口变大后球会回到用户放的位置）
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const point = clampOrbPoint(orbPointFromOffset(anchor, offset), viewport);

  return (
    <>
      <OrbGlassStyle />
      {/* 有未读 → has-unread：玻璃本体色从冰晶蓝切到暖琥珀（见 ButlerOrbVisual 的变量注释） */}
      <button
        type="button"
        className={`butler-orb${unread > 0 ? ' has-unread' : ''}`}
        ref={orbRef}
        aria-label="BobWork 助理"
        onPointerDown={(e) => {
          grab.current = { dx: e.clientX - point.x, dy: e.clientY - point.y };
          downAt.current = { x: e.clientX, y: e.clientY };
          dragging.current = true;
          moved.current = false;
          vxRef.current = 0;
          tiltShownRef.current = 0;
          lastMoveRef.current = { t: e.timeStamp, x: e.clientX };
          setIsDrag(true); // 进入拖拽态：歪头层快速跟随 + 呼吸/摇铃暂停
        }}
        onClick={() => {
          // 拖拽结束也会触发 click：位移未过阈值才算点击
          if (!moved.current) openDialog();
        }}
        style={{
          position: 'fixed',
          left: point.x,
          top: point.y,
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
        <OrbFace unread={unread} tiltDeg={tilt} dragging={isDrag} />
      </button>
    </>
  );
}
