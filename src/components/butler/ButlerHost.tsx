'use client';

/**
 * Butler 助理全局宿主
 *
 * 挂在应用根部（layout.tsx），把 Butler 的各类面板与画布、页面状态解耦——
 * 沿用 ScreenOcrHost 的教训：订阅与渲染曾写在页面组件内，挂载间隙时事件无人接收，
 * 表现为「点了没反应」。这里任何时刻都能被事件唤起。
 *
 * 结构（2026-09-25 收敛为「单一抽屉」）：
 *   - ButlerNoticeHost（常驻，无骨架）：消费舱轮询 / bus 订阅 / 落库 / 桌面通知 / toast / 执行中浮层
 *   - ButlerOrb（常驻悬浮球）：点击打开 / 收起 Butler 抽屉
 *   - ButlerDrawer：微信式三栏抽屉（左功能键 / 中内容 / 右详情），
 *     Today / 记忆 / 文档不再是三个互斥浮窗，而是抽屉内的分区与右栏预览。
 *
 * 本组件只负责「抽屉是否开着 + 哪个分区 + 哪份文档」；渲染与状态在 ButlerDrawer。
 * 唤起方式见 butlerEvents.ts。
 */
import { useCallback, useEffect, useState } from 'react';
import { ButlerOrb } from './ButlerOrb';
import { ButlerNoticeHost } from './ButlerNoticeHost';
import { ButlerDrawer, type ButlerSection } from './ButlerDrawer';
import {
  BUTLER_CLOSE_EVENT,
  BUTLER_DOC_EVENT,
  BUTLER_FOCUS_NOTICE_EVENT,
  BUTLER_INBOX_EVENT,
  BUTLER_ORB_HOME_EVENT,
  BUTLER_PREFERENCES_EVENT,
  BUTLER_RULES_EVENT,
  BUTLER_TODAY_EVENT,
} from './butlerEvents';

interface DrawerState {
  section: ButlerSection;
  /** 右栏文档预览路径（空 = 展示选中回执详情） */
  docPath: string | null;
  /** 桌面通知点击后要定位的回执 id */
  focusNoticeId: string | null;
}

export function ButlerHost() {
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  const close = useCallback(() => setDrawer(null), []);

  /** 左栏切换分区：清掉右栏文档预览，保证「切分区 = 回到该分区默认视图」 */
  const setSection = useCallback((section: ButlerSection) => {
    setDrawer({ section, docPath: null, focusNoticeId: null });
  }, []);

  const closeDoc = useCallback(() => {
    setDrawer((prev) => (prev ? { ...prev, docPath: null } : prev));
  }, []);

  useEffect(() => {
    /**
     * 打开某分区。`toggle` 为真时（悬浮球点击）已在该分区则收起；
     * 桌面通知等程序化唤起不传 toggle → 幂等打开，避免与随后的 focus 事件打架。
     */
    const openSection = (section: ButlerSection, toggle?: boolean) =>
      setDrawer((prev) =>
        toggle && prev && prev.section === section && !prev.docPath ? null : { section, docPath: null, focusNoticeId: null },
      );

    const onInbox = (e: Event) => {
      const d = (e as CustomEvent<{ toggle?: boolean }>).detail;
      openSection('detail', d?.toggle === true);
    };
    const onToday = () => openSection('today');
    const onPreferences = () => openSection('preferences');
    const onRules = () => openSection('rules');
    const onDoc = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      const path = detail?.path;
      if (typeof path !== 'string' || !path) return;
      // 打开文档预览：已有抽屉则换右栏文档（再点同一份 = 收起预览）；无抽屉则以 Today 分区打开
      setDrawer((prev) =>
        prev
          ? { ...prev, docPath: prev.docPath === path ? null : path }
          : { section: 'today', docPath: path, focusNoticeId: null },
      );
    };
    const onFocusNotice = (e: Event) => {
      const id = (e as CustomEvent<{ noticeId?: string }>).detail?.noticeId;
      if (typeof id !== 'string' || !id) return;
      setDrawer({ section: 'detail', docPath: null, focusNoticeId: id });
    };
    const closeAll = () => setDrawer(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(null);
    };

    window.addEventListener(BUTLER_INBOX_EVENT, onInbox);
    window.addEventListener(BUTLER_TODAY_EVENT, onToday);
    window.addEventListener(BUTLER_PREFERENCES_EVENT, onPreferences);
    window.addEventListener(BUTLER_RULES_EVENT, onRules);
    window.addEventListener(BUTLER_DOC_EVENT, onDoc);
    window.addEventListener(BUTLER_FOCUS_NOTICE_EVENT, onFocusNotice);
    window.addEventListener(BUTLER_CLOSE_EVENT, closeAll);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(BUTLER_INBOX_EVENT, onInbox);
      window.removeEventListener(BUTLER_TODAY_EVENT, onToday);
      window.removeEventListener(BUTLER_PREFERENCES_EVENT, onPreferences);
      window.removeEventListener(BUTLER_RULES_EVENT, onRules);
      window.removeEventListener(BUTLER_DOC_EVENT, onDoc);
      window.removeEventListener(BUTLER_FOCUS_NOTICE_EVENT, onFocusNotice);
      window.removeEventListener(BUTLER_CLOSE_EVENT, closeAll);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // 桌面悬浮球（独立球窗）被点击：主进程先恢复/聚焦主窗口，再派这条 IPC →
  // 在这里转成同一条 BUS 打开抽屉收件箱（复用既有链路，抽屉本身零改动）。
  // 不传 toggle：程序化唤起必须幂等打开，否则主进程的补发重试会把它又切回关闭态。
  useEffect(() => {
    const off = window.api?.butlerOrb?.onOpenInbox(() => {
      window.dispatchEvent(new CustomEvent(BUTLER_INBOX_EVENT, { detail: { toggle: false } }));
    });
    return () => {
      off?.();
    };
  }, []);

  /**
   * 左栏黄键「缩小」：收起抽屉，球留在原地（BobWork 窗口**不受影响** —— 最小化窗口是用户的事）。
   * 这是现在唯一「点击收起」的入口（点击抽屉外空白不再收起）；区别在抽屉内部：
   * 黄键不清 activeThreadId，回头打开还在原来那条会话。
   */
  const collapseToOrb = useCallback(() => {
    close();
  }, [close]);

  /** 左栏红键「关闭」：收起抽屉，并把球送回中栏（对话区）左下角（丢弃拖拽位置）；BobWork 同样不动 */
  const collapseAll = useCallback(() => {
    close();
    window.dispatchEvent(new Event(BUTLER_ORB_HOME_EVENT));
  }, [close]);

  return (
    <>
      <ButlerNoticeHost />
      <ButlerOrb />
      {drawer && (
        <ButlerDrawer
          section={drawer.section}
          onSectionChange={setSection}
          docPath={drawer.docPath}
          onCloseDoc={closeDoc}
          onClose={close}
          focusNoticeId={drawer.focusNoticeId}
          onMinimizeToOrb={collapseToOrb}
          onCloseAll={collapseAll}
        />
      )}
    </>
  );
}
