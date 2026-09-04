/**
 * 边关系模型层 —— 连线统一为 child（子节点/层级）。
 *
 * 纵向 Handle（top/bottom）已移除，所有连线均从 left/right 拖出，
 * 持久化 edge_type 统一为 parallel，relation 统一为 child。
 * 旧 vertical 边通过 edgeTypeToRelation 兼容映射为 child。
 */

/** 边关系类型：child = 子节点/层级 */
export type EdgeRelation = 'child';

/** 持久化边类型（数据库 edge_type 字段） */
export type EdgeType = 'parallel' | 'vertical';

/** 持久化边类型 → 关系（兼容旧 vertical 边，统一返回 child） */
export function edgeTypeToRelation(_edgeType: string): EdgeRelation {
  return 'child';
}
