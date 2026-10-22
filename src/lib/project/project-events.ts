/**
 * 项目相关变更通知广播器（服务端内存）
 *
 * 后端 watcher 检测到工作区目录变化完成对账后，通过这里通知所有订阅者
 * （当前为 /api/projects/events SSE 连接的浏览器端）：
 *  - projects-changed：项目列表变化（新增/删除/归档/复活）→ 驱动项目列表实时刷新
 *  - files-changed：项目内文件树可见内容变化（homework/materials 等）→ 驱动已展开项目文件树实时刷新
 *  - node-outcome：某节点成果块被改写（后台自动提炼完成）→ 驱动画布上该节点的成果块状态刷新
 *  - project-switched：**当前项目被服务端工具（管家）切换**（2026-10-05）→ 前端补一次「无刷新切换」
 *    （用户从侧边栏点击切换时是前端自己切的；本通道只补「AI 侧发起」那条路径）
 *  - session-request：服务端工具（管家）要求**在某个项目里新建会话、并可选执行一个任务**（2026-10-05）
 *    → 前端复用既有 quick-launch-open 链路落节点（跨项目时先等画布重载完成，避免竞态）
 *
 * 为什么不让工具直接写节点文件：会话节点是**画布状态**，创建要经过前端既有链路
 * （节点定位、agent 壳、后台自动执行缓冲 window.__pendingNodeTasks）。服务端只做
 * 「解析 + 授权 + 广播」，节点本体仍由画布创建，避免两套创建语义漂移。
 */
type Listener = () => void;
type NodeOutcomeListener = (nodeId: string) => void;
type ProjectSwitchedListener = (projectId: string) => void;
type SessionRequestListener = (payload: SessionRequestPayload) => void;

/** 前端建会话所需的最小契约（服务端已解析好项目与 agent，前端只负责落节点） */
export interface SessionRequestPayload {
  /** 目标项目 id（前端据此判断是否需要先切项目） */
  project_id: string;
  /** 会话标题（空 = 由前端兜底为 Quick） */
  label: string;
  /** agent 身份（chat / coding / note / archivist …；未知身份由前端回退 chat） */
  agent: string;
  /** 首个待执行任务；空 = 只建会话、不执行 */
  prompt: string;
  /** 是否后台自动执行（prompt 非空时恒为 true） */
  auto: boolean;
  /** 绑定的 Bob Sandbox app id（Butler 把已有/新建小程序交给 coding 会话时带上；节点据此注入小程序上下文） */
  sandbox_app_id?: string;
  /** 产物落点模式：'outbox' = 先落暂存区（**管家派发的默认**，不污染当前项目）、'project' = 直接落当前项目 homework/ */
  output_mode?: 'outbox' | 'project';
  /** 产物暂存区批次 id（output_mode='outbox' 时由服务端生成并随本契约下发，供节点带回 chat 请求） */
  batch_id?: string;
}

const projectsListeners = new Set<Listener>();
const filesListeners = new Set<Listener>();
const nodeOutcomeListeners = new Set<NodeOutcomeListener>();
const projectSwitchedListeners = new Set<ProjectSwitchedListener>();
const sessionRequestListeners = new Set<SessionRequestListener>();

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

/** 订阅节点成果块变更通知（携带节点 id，前端据此只刷新该节点），返回取消订阅函数 */
export function onNodeOutcomeChanged(cb: NodeOutcomeListener): () => void {
  nodeOutcomeListeners.add(cb);
  return () => {
    nodeOutcomeListeners.delete(cb);
  };
}

/** 广播节点成果块变更通知（后台自动提炼写出后调用；订阅者不应抛异常，逐个 try/catch 隔离） */
export function emitNodeOutcomeChanged(nodeId: string): void {
  for (const cb of [...nodeOutcomeListeners]) {
    try {
      cb(nodeId);
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  }
}

/** 当前是否有订阅者（供调试/避免无谓广播） */
export function hasProjectsChangedListeners(): boolean {
  return projectsListeners.size > 0;
}

/** 订阅「当前项目被服务端切换」通知（携带项目 id），返回取消订阅函数 */
export function onProjectSwitched(cb: ProjectSwitchedListener): () => void {
  projectSwitchedListeners.add(cb);
  return () => {
    projectSwitchedListeners.delete(cb);
  };
}

/** 广播「当前项目被服务端切换」通知（订阅者不应抛异常，逐个 try/catch 隔离） */
export function emitProjectSwitched(projectId: string): void {
  for (const cb of [...projectSwitchedListeners]) {
    try {
      cb(projectId);
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  }
}

/** 订阅「新建会话请求」通知（携带建会话契约），返回取消订阅函数 */
export function onSessionRequest(cb: SessionRequestListener): () => void {
  sessionRequestListeners.add(cb);
  return () => {
    sessionRequestListeners.delete(cb);
  };
}

/** 广播「新建会话请求」通知（订阅者不应抛异常，逐个 try/catch 隔离） */
export function emitSessionRequest(payload: SessionRequestPayload): void {
  for (const cb of [...sessionRequestListeners]) {
    try {
      cb(payload);
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  }
}
