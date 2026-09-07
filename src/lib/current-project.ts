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
