/**
 * GraphGateway — 画布图数据访问接口（太空舱"统一对接端口"）
 *
 * NodeMap 等画布附属视图只面向本接口编程，不直接触碰画布宿主内部 state / window 事件，
 * 由宿主（CanvasFlow）提供实现。接口方法全部基于纯数据（可 JSON 序列化）。
 *
 * 单焦点宿主（2026-09 布局重构）口径：
 *  - 画布渲染层已从 React Flow 迁为宿主自绘（zoom 恒 1、无缩放/平移），
 *    "视口"概念随之取消 → 接口不暴露任何 viewport / fit / zoom / 居中命令；
 *  - GraphSnapshot 只含 nodes/edges。
 *
 * 对接授权协议（太空舱对接）：小程序（外部太空舱）可通过 Bob Sandbox Bridge
 * 对接本端口，但操作前必须先由用户授予权限（read / control，按 appId 存储），
 * 未授权一律拒绝；授权由用户随时可授予/撤销。实现见 lib/graph/graph-bridge.ts。
 *
 * 接口语义：
 *  - 数据源：getSnapshot() 返回当前快照（节点/边），subscribe() 在画布数据变化时通知
 *    （配合 React useSyncExternalStore 使用，getSnapshot 返回缓存引用保证稳定性）；
 *  - 命令：setNodePositions / setNodeSelected；
 *  - 节点打开：expandNode（单焦点宿主下切换为当前打开节点）；
 *  - 外部事件：onNodeEvent 订阅节点收起 / 执行状态广播。
 */

export interface GraphNodeInfo {
  id: string;
  title: string;
  /** 节点左上角世界坐标（宿主节点 position） */
  x: number;
  y: number;
  /** 固定占位尺寸：不随节点实际展开/折叠尺寸变化，避免缩略图圆点跳动 */
  width: number;
  height: number;
  /** 节点实际渲染尺寸（RF 时代来自 measured.*；单焦点宿主无测量来源，缺省时排版回退占位高度）。 */
  measuredHeight?: number;
  /** 节点实际渲染宽度（同上，缺省时排版回退占位宽度）。 */
  measuredWidth?: number;
  /** 宿主节点 type：'aiChat' / 'imageGen' / 'bobby' / 'agentTeams' / 'agent-<id>' 等 */
  type: string;
  /** 绑定 Bob Sandbox 小程序 id（AI Coding 节点），用于与普通 chat 节点区分颜色 / 徽章 */
  sandboxAppId?: string;
  /** 节点消息数（会话列表用：0 = 空会话 / 尚未执行任务，可从会话区隐藏） */
  messageCount?: number;
}

export interface GraphEdgeInfo {
  id: string;
  source: string;
  target: string;
  /** 连线关系（RF 时代 edge.data.relation；'child' 等），供上游上下文注入判断 */
  relation?: string;
  /** 已断开的边（不参与连线/目录） */
  disconnected?: boolean;
}

export interface GraphSnapshot {
  nodes: GraphNodeInfo[];
  edges: GraphEdgeInfo[];
}

export type GraphNodeEvent = {
  type: 'node-executing';
  nodeId: string;
  executing: boolean;
};

/** 节点类型（NodeMap 圆点颜色 / 徽章用） */
export type NodeKind = 'chat' | 'coding' | 'imageGen';

export interface GraphGateway {
  /** 订阅画布数据变化（React useSyncExternalStore 兼容：listener 无参，返回退订函数） */
  subscribe(listener: () => void): () => void;
  /** 读取当前画布快照（返回缓存引用，数据变化时才产生新对象） */
  getSnapshot(): GraphSnapshot;

  /** 批量设置节点坐标（自动排版），宿主负责持久化 */
  setNodePositions(positions: Record<string, { x: number; y: number }>): void;
  /** 设置选中态（null = 全部取消） */
  setNodeSelected(nodeId: string | null): void;

  /** 请求打开/聚焦节点（单焦点宿主：切换为当前打开的研究节点） */
  expandNode(nodeId: string): void;
  /** 断开连线（软删 disconnected：本地立即置灰 + 落库 /api/edges delete，语义对齐 NodeMap 中点拖断） */
  disconnectEdge(edgeId: string): void;
  /** 重连续线（清 disconnected：本地立即恢复 + 落库 /api/edges reconnect） */
  reconnectEdge(edgeId: string): void;
  /** 订阅节点外部事件（收起 / 执行状态），返回退订函数 */
  onNodeEvent(handler: (e: GraphNodeEvent) => void): () => void;
}
