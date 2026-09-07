/**
 * GraphGateway — 画布图数据访问接口（太空舱"统一对接端口"）
 *
 * NodeMap 等画布附属视图只面向本接口编程，不直接触碰 ReactFlow store / window 事件，
 * 由宿主（CanvasFlow）提供实现。接口方法全部基于纯数据（可 JSON 序列化）。
 *
 * 对接授权协议（太空舱对接）：小程序（外部太空舱）可通过 Bob Sandbox Bridge
 * 对接本端口，但操作前必须先由用户授予权限（read / control，按 appId 存储），
 * 未授权一律拒绝；授权由用户随时可授予/撤销。实现见 lib/graph/graph-bridge.ts。
 *
 * 接口语义：
 *  - 数据源：getSnapshot() 返回当前快照（节点/边/视口），subscribe() 在画布数据变化时通知
 *    （配合 React useSyncExternalStore 使用，getSnapshot 返回缓存引用保证稳定性）；
 *  - 命令：setViewport / fitView / zoomBy / setNodePositions / setNodeSelected；
 *  - 节点展开：expandNode（由宿主派发到节点，节点自管其展开态）；
 *  - 外部事件：onNodeEvent 订阅节点收起 / 执行状态广播。
 */

export interface GraphNodeInfo {
  id: string;
  title: string;
  /** 节点左上角世界坐标（ReactFlow position） */
  x: number;
  y: number;
  /** 固定占位尺寸：不随节点实际展开/折叠尺寸变化，避免缩略图圆点跳动 */
  width: number;
  height: number;
  /** 节点实际渲染尺寸（收起态：ReactFlow measured.height，可能小于占位 400）。
   *  仅供排版（Fit）使用以收紧纵向间距；未渲染/未知时缺省，排版回退占位高度。 */
  measuredHeight?: number;
  /** 节点实际渲染宽度（ReactFlow measured.width，可能小于占位 400）。
   *  仅供链导航聚焦等场景收紧横向 bounds；未渲染/未知时缺省，回退占位宽度。 */
  measuredWidth?: number;
  /** ReactFlow 节点 type：目前 'aiChat' 或 'imageGen' */
  type: 'aiChat' | 'imageGen' | (string & {});
  /** 绑定 Bob Sandbox 小程序 id（AI Coding 节点），用于与普通 chat 节点区分颜色 / 徽章 */
  sandboxAppId?: string;
  /** 节点消息数（会话列表用：0 = 空会话 / 尚未执行任务，可从会话区隐藏） */
  messageCount?: number;
}

export interface GraphEdgeInfo {
  id: string;
  source: string;
  target: string;
  /** 已断开的边（不参与连线/目录） */
  disconnected?: boolean;
}

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphSnapshot {
  nodes: GraphNodeInfo[];
  edges: GraphEdgeInfo[];
  viewport: ViewportState;
}

export type GraphNodeEvent = {
  type: 'node-executing';
  nodeId: string;
  executing: boolean;
};

/** 节点类型（NodeMap 圆点颜色 / 徽章用） */
export type NodeKind = 'chat' | 'coding' | 'imageGen';

export interface GraphViewportOpts {
  duration?: number;
}

export interface GraphFitOptions {
  padding?: number;
  duration?: number;
  maxZoom?: number;
}

/** 世界坐标矩形（用于 fitBounds 适配任意子集节点） */
export interface GraphRect {
  /** 左上角世界坐标 */
  x: number;
  y: number;
  /** 矩形宽高（世界坐标尺度） */
  width: number;
  height: number;
}

export interface GraphGateway {
  /** 订阅画布数据变化（React useSyncExternalStore 兼容：listener 无参，返回退订函数） */
  subscribe(listener: () => void): () => void;
  /** 读取当前画布快照（返回缓存引用，数据变化时才产生新对象） */
  getSnapshot(): GraphSnapshot;

  /** 设定画布视口 */
  setViewport(vp: ViewportState, opts?: GraphViewportOpts): void;
  /** 读取当前画布视口 */
  getViewport(): ViewportState;
  /** 缩放适配到全部节点 */
  fitView(opts?: GraphFitOptions): void;
  /** 缩放适配到指定世界坐标矩形（适配链/子图/单个节点等局部范围） */
  fitBounds(bounds: GraphRect, opts?: GraphFitOptions): void;
  /** 把指定世界坐标点平移为视口中心，可选设定 zoom（不指定则保持当前 zoom） */
  setCenter(x: number, y: number, opts?: GraphViewportOpts & { zoom?: number }): void;
  /** 按增量缩放画布（delta>0 放大，delta<0 缩小） */
  zoomBy(delta: number, opts?: GraphViewportOpts): void;
  /** 批量设置节点坐标（自动排版），宿主负责持久化 */
  setNodePositions(positions: Record<string, { x: number; y: number }>): void;
  /** 设置选中态（null = 全部取消） */
  setNodeSelected(nodeId: string | null): void;
  /** 读取当前选中的节点 id（无选中返回 null） */
  getSelectedNode(): string | null;

  /** 请求展开节点（节点自管其展开态） */
  expandNode(nodeId: string): void;
  /** 断开连线（软删 disconnected：本地立即置灰 + 落库 /api/edges delete，语义对齐 NodeMap 中点拖断） */
  disconnectEdge(edgeId: string): void;
  /** 重连续线（清 disconnected：本地立即恢复 + 落库 /api/edges reconnect） */
  reconnectEdge(edgeId: string): void;
  /** 订阅节点外部事件（收起 / 执行状态），返回退订函数 */
  onNodeEvent(handler: (e: GraphNodeEvent) => void): () => void;
}
