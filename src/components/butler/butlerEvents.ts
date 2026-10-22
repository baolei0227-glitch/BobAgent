'use client';

/**
 * Butler 面板唤起事件（独立模块，避免 ButlerOrb ⇄ ButlerHost 循环依赖）
 *
 * 为什么不用 React Context：宿主挂在 layout 根，调用方可能在画布/浮层任意位置，
 * window 事件与 UI 树解耦，也不需要把 provider 套到整个应用。
 */
export const BUTLER_TODAY_EVENT = 'butler:open-today';
export const BUTLER_PREFERENCES_EVENT = 'butler:open-preferences';
export const BUTLER_RULES_EVENT = 'butler:open-rules';
export const BUTLER_CLOSE_EVENT = 'butler:close';
/** 打开文档阅读面板：detail = { path } */
export const BUTLER_DOC_EVENT = 'butler:open-doc';
/** 打开回执收件箱（通知中心）：detail = { anchor?: DOMRect | null } */
export const BUTLER_INBOX_EVENT = 'butler:open-inbox';
/** 定位到某条通知（桌面通知点击后）：detail = { noticeId: string } */
export const BUTLER_FOCUS_NOTICE_EVENT = 'butler:focus-notice';
/**
 * 「未读口径可能变了」信号（无 detail）：
 *   新回执落库 / 会话回复落地且没看着 / 会话或卡片被读 —— 都派一次。
 * 悬浮球（ButlerOrb）据此立即重拉数字，不再只靠 120s 兜底轮询。
 * 刻意不携带数字：角标真值由服务端 COUNT 决定，这里只负责「该去问一下了」。
 */
export const BUTLER_UNREAD_CHANGED_EVENT = 'butler:unread-changed';
/**
 * 「把悬浮球送回原位」信号（无 detail）：
 *   主窗口里点抽屉左轨红键「关闭」时派一次 —— 语义是「收起抽屉，并且球回到中栏（对话区）
 *   左下角」，同时丢弃用户拖拽过的位置。
 *   注意：这条**不动 BobWork 窗口本身**（要不要最小化窗口是用户的事，不替用户决定）。
 */
export const BUTLER_ORB_HOME_EVENT = 'butler:orb-home';

/** 唤起 Today 页 */
export function openButlerToday(): void {
  window.dispatchEvent(new Event(BUTLER_TODAY_EVENT));
}

/** 唤起记忆台（Memories；原名「记忆面板」/ Customize / Memory），直接落到 Preferences 段。 */
export function openButlerPreferences(): void {
  window.dispatchEvent(new Event(BUTLER_PREFERENCES_EVENT));
}

/** @deprecated 兼容别名，等价 openButlerPreferences()（落到 section='preferences'）。 */
export function openButlerMemories(): void {
  openButlerPreferences();
}

/** 唤起规则面板（长期承诺） */
export function openButlerRules(): void {
  window.dispatchEvent(new Event(BUTLER_RULES_EVENT));
}

/** 关闭当前面板 */
export function closeButlerPanels(): void {
  window.dispatchEvent(new Event(BUTLER_CLOSE_EVENT));
}

/** 打开一份报告文档（右侧展开阅读面板） */
export function openButlerDoc(path: string): void {
  window.dispatchEvent(new CustomEvent(BUTLER_DOC_EVENT, { detail: { path } }));
}

/** 打开回执收件箱（通知中心）；anchor 为入口按钮 rect，弹层锚定其上 */
export function openButlerInbox(anchor?: DOMRect | null): void {
  window.dispatchEvent(new CustomEvent(BUTLER_INBOX_EVENT, { detail: { anchor: anchor ?? null } }));
}

/** 通知「未读口径可能变了」，让悬浮球立刻去问一次服务端（不传数字，见上方常量说明） */
export function notifyButlerUnreadChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(BUTLER_UNREAD_CHANGED_EVENT));
}

/**
 * 切换到某个项目（Today 建议区「项目停滞」的行动入口）。
 * 与 NavSearchBox / Sidebar 同源：POST switch 成功后广播 `bobagent:project-switched`，
 * 由 CanvasFlow 等宿主重载画布 —— 三处必须走同一条链路，避免出现「只切了一半」。
 */
export async function openProjectById(projectId: string): Promise<boolean> {
  try {
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'switch', project_id: projectId }),
    });
    const data = (await resp.json()) as { success?: boolean };
    if (!data.success) return false;
    window.dispatchEvent(new CustomEvent('bobagent:project-switched', { detail: { projectId } }));
    return true;
  } catch {
    return false;
  }
}
