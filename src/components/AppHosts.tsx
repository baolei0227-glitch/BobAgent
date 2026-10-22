'use client';

/**
 * 应用级宿主集合（挂根 layout，与画布 / 页面状态解耦）
 *
 * 为什么要收拢到一处：这些宿主都假设自己跑在**主窗口**里，而根 layout 是**所有窗口共用**的
 * ——独立球窗（`/butler-orb`，见 electron/butler-orb.ts）也会继承它。若照样挂载：
 *   - ButlerNoticeHost 会开始第二次轮询消费舱 / 心跳，并在主窗口最小化期间**重复弹桌面通知**；
 *   - ScreenOcrHost 会在 54px 的球窗里渲染截图编辑面板（Cmd+Shift+O 的蒙版落在一个小球上）；
 *   - BobbyAuthHost 的授权弹窗 / 系统权限引导同理无处安放。
 * 所以按路由把它们整体排除，球窗里只留那颗球。
 */
import { usePathname } from 'next/navigation';
import { ScreenOcrHost } from '@/components/screen-ocr/ScreenOcrHost';
import { BobbyAuthHost } from '@/components/bobby/BobbyAuthHost';
import { ButlerHost } from '@/components/butler/ButlerHost';

/** 不挂任何应用级宿主的「裸窗口」路由：独立球窗 /butler-orb、独立 Butler 面板窗 /butler-panel
 *  （两者都是主进程开的独立窗，自己就是 Butler，再挂一套宿主只会重复轮询、重复弹通知） */
const BARE_ROUTES = new Set(['/butler-orb', '/butler-panel']);

export function AppHosts() {
  const pathname = usePathname();
  if (BARE_ROUTES.has(pathname)) return null;
  return (
    <>
      {/* 全局截图 OCR 宿主：任意页面按 Cmd+Shift+O 都能弹编辑面板（与画布挂载状态解耦） */}
      <ScreenOcrHost />
      {/* 全局 Bobby 授权宿主：授权弹窗 / 系统权限引导 / 急停，不再依赖画布节点
          （CanvasFlow 改为单焦点 world 后画布已不存在，节点可能落在视口外导致弹窗不可见） */}
      <BobbyAuthHost />
      {/* 全局 Butler 助理宿主：悬浮球 → 微信式三栏抽屉（收件箱 / Today / 记忆 / 文档预览）
          与画布挂载状态解耦，避免在 4000+ 行的画布组件里再叠加 UI */}
      <ButlerHost />
    </>
  );
}
