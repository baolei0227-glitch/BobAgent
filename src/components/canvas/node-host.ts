'use client';

/**
 * node-host —— 单焦点宿主（2026-09 布局重构）节点注入通道
 *
 * 画布渲染层从 React Flow 迁移为宿主自绘（CanvasFlow 内 world 层绝对定位渲染）后，
 * 节点组件（ChatNodeKernel / ImageGenNode / BobbyNode / AgentTeamsNode / AnnotationNode）
 * 不再访问 RF store，一律经本 Context 获取画布数据与宿主原语：
 *  - 读：edges / readNode / readNodes / readEdges；
 *  - 写：updateNodes（等价旧 setNodes 函数式语义）/ addNodes / addEdges /
 *         removeNode / removeEdge / deleteNodeWithEdges；
 *  - 订阅：subscribe（配合 React useSyncExternalStore 订阅边/节点变化）。
 *
 * 数据 shape 刻意对齐旧 RF Node/Edge 的"被使用字段"（id/type/position/data/selected/
 * hidden/measuredWidth/measuredHeight；edge: source/target/data.relation/disconnected 等），
 * 让节点组件与派生逻辑尽可能少改动即可移植。
 */

import { createContext, useContext } from 'react';

/** 宿主自绘画布节点（替代旧 React Flow Node；data 泛型默认为 unknown） */
export interface HostNode<D = unknown> {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: D;
  selected?: boolean;
  hidden?: boolean;
  dragging?: boolean;
  /** RF 时代的节点渲染宽度/高度（仅占位：宿主无 RF 测量来源，语义保留供回退排版） */
  width?: number;
  height?: number;
  /** 实际渲染测量尺寸（兼容旧代码 n.measured?.width 读取；宿主无 RF 测量来源，常缺省回退占位） */
  measured?: { width?: number; height?: number };
  measuredWidth?: number;
  measuredHeight?: number;
}

/** 宿主自绘画布边（替代旧 React Flow Edge；画布不再物理绘制连线，仅数据消费） */
export interface HostEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  type?: string;
  animated?: boolean;
  data?: {
    relation?: string;
    disconnected?: boolean;
    executing?: boolean;
    [key: string]: unknown;
  };
}

/** NodeHostContext 注入值（由 CanvasFlow 提供） */
export interface NodeHostValue {
  /** 当前边表（引用随边变化；配合 subscribe 供 useSyncExternalStore 订阅） */
  edges: HostEdge[];
  /** 订阅画布（节点/边）变化；返回退订函数 */
  subscribe(listener: () => void): () => void;
  /** 读单个节点（data 为 unknown，调用方自行断言所需 data 类型） */
  readNode(nodeId: string): HostNode | undefined;
  /** 读全部节点 */
  readNodes(): HostNode[];
  /** 读全部边 */
  readEdges(): HostEdge[];
  /** 原始函数式更新节点（等价旧 useReactFlow().setNodes；数据层直接落到宿主 nodes state） */
  updateNodes(updater: (prev: HostNode[]) => HostNode[]): void;
  /** 追加节点（幂等语义由调用方保证；imagegenAlbum 等运行期动态节点用） */
  addNodes(nodes: HostNode[]): void;
  /** 追加边（重复 id 自动去重） */
  addEdges(edges: HostEdge[]): void;
  /** 移除单个节点（仅内存；不动后端档案） */
  removeNode(nodeId: string): void;
  /** 移除单条边（仅内存） */
  removeEdge(edgeId: string): void;
  /** 删除节点 + 关联边：宿主统一先 POST /api/nodes delete（含附件目录收集、imagegenAlbum 连带），再清内存 */
  deleteNodeWithEdges(nodeId: string): void;
}

export const NodeHostContext = createContext<NodeHostValue | null>(null);

/** 在宿主自绘画布节点内读取注入通道；Provider 外调用抛错 */
export function useNodeHost(): NodeHostValue {
  const value = useContext(NodeHostContext);
  if (!value) {
    throw new Error('useNodeHost must be used within a <NodeHostContext.Provider> (CanvasFlow world layer)');
  }
  return value;
}
