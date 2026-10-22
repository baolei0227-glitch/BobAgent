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

/**
 * 重排标星顺序（桌面图标拖拽排序，2026-10-18）：
 * 按传入的 id 顺序落盘；未出现在 orderedIds 里的条目（竞态新增）保持原相对次序追加在后。
 * 有变化才写盘并广播（与 toggle/prune 同一事件，订阅端据此刷新）。
 */
export function reorderStarredApps(orderedIds: string[]): StarredApp[] {
  const cur = loadStarredApps();
  const remaining = new Map(cur.map((a) => [a.id, a]));
  const next: StarredApp[] = [];
  for (const id of orderedIds) {
    const hit = remaining.get(id);
    if (hit) {
      next.push(hit);
      remaining.delete(id);
    }
  }
  for (const a of cur) if (remaining.has(a.id)) next.push(a);
  const changed = next.length !== cur.length || next.some((a, i) => a.id !== cur[i].id);
  if (changed) {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
    window.dispatchEvent(new CustomEvent(STARRED_CHANGED_EVT, { detail: next }));
  }
  return next;
}

/**
 * 按当前有效的小程序清单回收标星（2026-10-10 评估 P1-3）：
 * 删除/改名后 localStorage 里会留下死图标，点开是 404。加载列表时调用一次即可。
 * 有变化才写盘并广播（避免无谓刷新）。
 */
export function pruneStarredApps(validIds: Iterable<string>): StarredApp[] {
  const valid = new Set(validIds);
  const cur = loadStarredApps();
  const next = cur.filter((a) => valid.has(a.id));
  if (next.length !== cur.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
    window.dispatchEvent(new CustomEvent(STARRED_CHANGED_EVT, { detail: next }));
  }
  return next;
}

/** 订阅标星集合变化；返回取消订阅函数 */
export function subscribeStarred(listener: (apps: StarredApp[]) => void): () => void {
  const handler = () => listener(loadStarredApps());
  window.addEventListener(STARRED_CHANGED_EVT, handler);
  return () => window.removeEventListener(STARRED_CHANGED_EVT, handler);
}
