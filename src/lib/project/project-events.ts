/**
 * 项目相关变更通知广播器（服务端内存）
 *
 * 后端 watcher 检测到工作区目录变化完成对账后，通过这里通知所有订阅者
 * （当前为 /api/projects/events SSE 连接的浏览器端）：
 *  - projects-changed：项目列表变化（新增/删除/归档/复活）→ 驱动项目列表实时刷新
 *  - files-changed：项目内文件树可见内容变化（homework/materials 等）→ 驱动已展开项目文件树实时刷新
 */
type Listener = () => void;

const projectsListeners = new Set<Listener>();
const filesListeners = new Set<Listener>();

/** 订阅项目列表变更通知，返回取消订阅函数 */
export function onProjectsChanged(cb: Listener): () => void {
  projectsListeners.add(cb);
  return () => {
    projectsListeners.delete(cb);
  };
}

/** 订阅项目内文件树变更通知，返回取消订阅函数 */
export function onProjectFilesChanged(cb: Listener): () => void {
  filesListeners.add(cb);
  return () => {
    filesListeners.delete(cb);
  };
}

/** 广播项目列表变更通知（订阅者不应抛异常，逐个 try/catch 隔离） */
export function emitProjectsChanged(): void {
  for (const cb of [...projectsListeners]) {
    try {
      cb();
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  }
}

/** 广播项目内文件树变更通知（订阅者不应抛异常，逐个 try/catch 隔离） */
export function emitProjectFilesChanged(): void {
  for (const cb of [...filesListeners]) {
    try {
      cb();
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  }
}

/** 当前是否有订阅者（供调试/避免无谓广播） */
export function hasProjectsChangedListeners(): boolean {
  return projectsListeners.size > 0;
}
