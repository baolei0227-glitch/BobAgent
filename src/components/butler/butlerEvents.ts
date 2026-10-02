'use client';

/**
 * Butler 面板唤起事件（独立模块，避免 ButlerOrb ⇄ ButlerHost 循环依赖）
 *
 * 为什么不用 React Context：宿主挂在 layout 根，调用方可能在画布/浮层任意位置，
 * window 事件与 UI 树解耦，也不需要把 provider 套到整个应用。
 */
export const BUTLER_TODAY_EVENT = 'butler:open-today';
export const BUTLER_MEMORIES_EVENT = 'butler:open-memories';
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

/** 唤起 Today 页 */
export function openButlerToday(): void {
  window.dispatchEvent(new Event(BUTLER_TODAY_EVENT));
}

/** 唤起记忆台（Memory；原名「记忆面板」/ Customize）。
 *  2026-10-02 改名只动了 UI 文案，**事件名与函数名保持不变**，避免打断既有调用方
 *  （落到 section='memories'，由面板带 initialSection='memories' 打开）。 */
export function openButlerMemories(): void {
  window.dispatchEvent(new Event(BUTLER_MEMORIES_EVENT));
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
