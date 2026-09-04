'use client';

/**
 * 小程序标星（收藏）管理：localStorage 持久化 + 跨组件事件广播。
 * SandboxPanel（列表标星）与 Sidebar（收起态 rail 快捷入口）共享同一数据源。
 */

export interface StarredApp {
  id: string;
  name: string;
}

const KEY = 'bobwork.starred-sandbox-apps';
/** 标星集合变化事件（detail: StarredApp[]） */
export const STARRED_CHANGED_EVT = 'bob-sandbox-starred-changed';

export function loadStarredApps(): StarredApp[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x: unknown): x is StarredApp => !!x && typeof (x as StarredApp).id === 'string')
      : [];
  } catch {
    return [];
  }
}

export function isStarred(id: string): boolean {
  return loadStarredApps().some((a) => a.id === id);
}

/** 切换标星；返回 true = 已标星。label 可自定义图标显示文字 */
export function toggleStarredApp(app: { id: string; name: string }): boolean {
  const cur = loadStarredApps();
  const exists = cur.some((a) => a.id === app.id);
  const next = exists ? cur.filter((a) => a.id !== app.id) : [...cur, { id: app.id, name: app.name }];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  window.dispatchEvent(new CustomEvent(STARRED_CHANGED_EVT, { detail: next }));
  return !exists;
}

/** 订阅标星集合变化；返回取消订阅函数 */
export function subscribeStarred(listener: (apps: StarredApp[]) => void): () => void {
  const handler = () => listener(loadStarredApps());
  window.addEventListener(STARRED_CHANGED_EVT, handler);
  return () => window.removeEventListener(STARRED_CHANGED_EVT, handler);
}
