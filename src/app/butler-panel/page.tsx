'use client';

/**
 * /butler-panel —— 桌面独立 Butler 面板窗专用路由
 *
 * 宿主：`electron/butler-orb.ts` 的 `createPanelWindow()`（**透明**置顶 / 可缩放 / 可聚焦的无边框窗）。
 * 打开路径：BobWork 最小化 → 桌面左下角出现悬浮球 → **点球**就地展开成这个面板（BobWork 保持最小化）。
 *
 * 内容 = **桌面版同一个 Butler 抽屉**（`ButlerDrawer`，与 BobWork 里点球打开的是同一个组件、
 * 同一套三栏布局：左轨功能键 / 中栏会话 / 右栏详情）。
 *
 * 画面里**只有抽屉那一张卡**：窗口自身透明、不铺任何底色、也不再有独立的标题条
 * （2026-10-10 整改：上一版给面板窗铺了 `--background` 灰底 + 30px 白色标题条，
 *  于是卡片四周露出一整圈「背景面板」；而标题条上那两颗按钮与抽屉左轨的三色键完全重复）。
 * 窗口比卡片大一圈只是为了给卡片的 CSS 投影留空间，那圈是完全透明的。
 *
 * 窗口怎么拖：左轨（`nav`，卡片上那块自带 `cursor: grab` 的栏）与顶部一条 14px 隐形拖动带都设了
 * `-webkit-app-region: drag` —— 卡片在窗内居中，拖轨即拖窗，视觉上就是「把面板拖走」。
 *
 * 本文件只负责抽屉给不了的三件事：
 *   ① 上面那两处窗口拖动区（app-region），以及轨上按钮的 no-drag 例外；
 *   ② 主题 / 字号跟随桌面端设置（这个窗口没有主窗口那套 Sidebar bootstrap，不自己拉一次会退回默认主题）；
 *   ③ 收件箱保鲜：抽屉只在自己挂载时 `loadInboxHistory()` 一次，而这里没有 ButlerNoticeHost
 *      往内存 store 里推新回执（它是**消费型**轮询，再加一个消费者会造成双消费竞态），
 *      所以定时重拉一次只读的 `/api/butler/inbox`。
 *
 * 三个出口（都走抽屉自己的三色键，不改抽屉实现）：
 *   - 黄键「缩小」：收回成悬浮球，球停在面板当前所在位置；
 *   - 红键「关闭」：球与面板一起从桌面消失（下次主窗回到前台再最小化时才回来）；
 *   - 点卡片外空白：与 BobWork 里一致 —— 只是「关掉抽屉」，球留在原地（这里映射为「缩小」）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ButlerDrawer, type ButlerSection } from '@/components/butler/ButlerDrawer';
import { BUTLER_DOC_EVENT } from '@/components/butler/butlerEvents';
import { loadInboxHistory } from '@/components/butler/ButlerNoticeHost';
import { applyCustomTheme, applyFontScale, applyTheme, loadSettings } from '@/lib/settings';

/** 收件箱保鲜周期（只读重拉，不消费生产舱） */
const INBOX_REFRESH_MS = 30_000;

/**
 * 面板窗的样式。核心一句：**窗口里只许有 Butler 抽屉那一张卡**。
 * 窗口本身是透明的（见 electron/butler-orb.ts 的 createPanelWindow），所以那圈为了给 CSS 投影
 * 留空间的边距是「看不见也点不到卡片之外」的纯透明区，而不是上一版那块灰底背景面板。
 */
const PANEL_CSS = `
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    /* 透明：任何底色都会在卡片四周形成一块「背景面板」 */
    background: transparent;
  }
  /* 顶部一条看不见的拖动带：窗口永远抓得住（左轨也能拖，见下）。
     高度压在卡片上沿的留白之内，不会盖到卡片内容。 */
  .bwp-drag {
    position: fixed; top: 0; left: 0; right: 0; height: 14px; z-index: 1490;
    -webkit-app-region: drag;
  }
  /* 左轨 = 面板的窗口把手（与 macOS 无边框窗口用标题栏拖动同理）。
     抽屉自己也在这一栏上挂了「拖动卡片」的指针逻辑，但 app-region 会先吃掉按下事件，
     于是这一栏改为拖动整个窗口 —— 卡片在窗内居中，视觉上就是「把面板拖走」，更符合直觉。
     轨上的按钮（三色键 / 功能键）必须 no-drag，否则点不动。 */
  [data-butler-drawer-panel] > nav { -webkit-app-region: drag; }
  [data-butler-drawer-panel] > nav button,
  [data-butler-drawer-panel] > nav a { -webkit-app-region: no-drag; }
`;

export default function ButlerPanelPage() {
  // 与 ButlerHost 同一套状态：初始停在「详情 / 收件箱」，与 BobWork 里点球打开一致
  const [section, setSection] = useState<ButlerSection>('detail');
  const [docPath, setDocPath] = useState<string | null>(null);
  /**
   * 抽屉只在客户端挂载后再渲染。
   *
   * 必须这样：BobWork 里抽屉是「点球之后才挂载」（纯客户端），而这里它会被 SSR 渲染一次——
   * 抽屉内部按 `useWindowWidth()/useWindowHeight()` 算尺寸与窄窗档位，服务端没有窗口尺寸，
   * 于是首帧属性与客户端不一致 → React 报 hydration mismatch（实测确实报了）。
   * 面板窗晚一帧出现抽屉是看不见的，换成「挂载后再渲染」最省事。
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // 主题跟随桌面端设置（读不到就用默认主题——主题失败不该挡住面板）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const settings = await loadSettings();
        if (!alive) return;
        applyCustomTheme(settings);
        applyTheme(settings.theme);
        applyFontScale(settings.fontScale);
      } catch { /* 忽略：退回 :root 默认主题 */ }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 收件箱保鲜：只读重拉历史（消费型轮询仍归主窗口的 ButlerNoticeHost，避免双消费竞态）
  useEffect(() => {
    const timer = window.setInterval(() => void loadInboxHistory(), INBOX_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * 文档预览：**面板窗必须自己接住 BUTLER_DOC_EVENT**。
   *
   * 抽屉里的文件卡片 / 正文链接统一走 `openDocInDrawer()` → 派发该事件，本窗口没有
   * ButlerHost（它只挂在主窗口），此前没人监听 → 卡片点了毫无反应（表现为「文档打不开」）。
   * 这里把事件落到本页的 docPath，与主窗口 ButlerHost.onDoc 同语义（同路径再点 = 收起）。
   */
  useEffect(() => {
    const onDoc = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (typeof path !== 'string' || !path) return;
      setDocPath((prev) => (prev === path ? null : path));
    };
    window.addEventListener(BUTLER_DOC_EVENT, onDoc);
    return () => window.removeEventListener(BUTLER_DOC_EVENT, onDoc);
  }, []);

  /** 黄键「缩小」：收成球，球停在面板当前所在位置（与 BobWork 里「只关抽屉」等价） */
  const collapseToOrb = useCallback(() => {
    window.api?.butlerOrb?.panelMinimize();
  }, []);

  /** 红键「关闭」：球与面板一起从桌面消失 */
  const closeAll = useCallback(() => {
    window.api?.butlerOrb?.panelClose();
  }, []);

  return (
    <>
      {/* 看不见的窗口拖动带：卡片上沿留白之内，给「左轨之外」再留一个抓手 */}
      <div className="bwp-drag" />
      {mounted && (
        <ButlerDrawer
          section={section}
          onSectionChange={setSection}
          docPath={docPath}
          onCloseDoc={() => setDocPath(null)}
          // 抽屉收起入口：点黄键缩小（面板收成球，球停在当前位置）
          onClose={collapseToOrb}
          // 黄键「缩小」：收成球（BobWork 已是最小化，所以就是留球）
          onMinimizeToOrb={collapseToOrb}
          // 红键「关闭」：面板与球一起从桌面消失（与 BobWork 里那颗红键同一语义）
          onCloseAll={closeAll}
          focusNoticeId={null}
        />
      )}
      <style>{PANEL_CSS}</style>
    </>
  );
}
