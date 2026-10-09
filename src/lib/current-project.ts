/**
 * 当前激活项目 id 的轻量客户端 store（server-only 逻辑禁入）。
 *
 * 背景：2026-09 布局重构后 todo/便签类 UI 收进会话标题栏（ChatNodeKernel），
 * 而 currentProjectId 只在 CanvasFlow 顶层 state 中维护；深层组件不便逐层下钻，
 * 故以模块级 store + subscribe 广播，宿主（CanvasFlow）在项目切换时写入。
 */
import { useEffect, useState } from 'react';

let currentProjectId = '';
const listeners = new Set<(id: string) => void>();

export function setCurrentProject(id: string): void {
  if (currentProjectId === id) return;
  currentProjectId = id;
  for (const fn of listeners) fn(id);
}

export function getCurrentProjectId(): string {
  return currentProjectId;
}

/** 订阅当前项目 id 的 React hook（客户端组件使用） */
export function useCurrentProjectId(): string {
  const [id, setId] = useState<string>(currentProjectId);
  useEffect(() => {
    listeners.add(setId);
    // 挂载晚于 store 首次写入时，以最新值补一次
    if (currentProjectId !== id) setId(currentProjectId);
    return () => {
      listeners.delete(setId);
    };
  }, [id]);
  return id;
}

/**
 * 画布是否落后于服务端的当前项目（落后 → 需要补一次无刷新切换）。
 *
 * 为什么需要这个判定：`current_project_id` 的真源在服务端 `.projects.json`。前端自己点的切换
 * （Sidebar / 项目看板 / 命令面板 / Butler Today）都会在 POST 成功后广播
 * `bobagent:project-switched`，画布跟着重载；但服务端还有若干**单方面改写**当前项目的路径 ——
 * 管家 `create_project(make_current=true)` 建完即切、`getCurrentProject()` 在旧当前项目被归档 /
 * 移入垃圾桶时自动回退到第一个活跃项目……这些路径若只广播 `projects-changed`（刷新列表），
 * 侧边栏高亮会跟上、画布与会话列表却仍停在旧项目；用户再点那条已高亮的项目又会被
 * 「已是 current，无需切换」挡掉，形成「点不动、会话还是上一个项目的」死结。
 *
 * 因此侧边栏每次拿到服务端快照都要对一次账：画布所在项目 ≠ 服务端当前项目 → 补发切换广播。
 * 判定口径：两边都有值且不一致才算落后 —— 画布还没报到（启动瞬间 store 为空）时不拿空值当
 * 「落后」，服务端没有当前项目时也无从跟随。
 */
export function canvasLagsServerProject(canvasProjectId: string, serverProjectId: string): boolean {
  return !!canvasProjectId && !!serverProjectId && canvasProjectId !== serverProjectId;
}
