/**
 * GraphBridge — 小程序对接画布 GraphGateway 的授权执行器（太空舱对接协议）
 *
 * 太空舱理念：GraphGateway 是站内"统一对接端口"，仅面向 NodeMap 等内部视图。
 * 小程序是外部太空舱，允许通过 Bob Sandbox Bridge 对接该端口，但必须先由
 * 用户（空间站控制台）授予权限（read / control），未授权一律拒绝操作。
 *
 * 授权规则：
 *  - 权限按 appId 维度存储（settings.json → sandboxGraphPermissions），可授予/撤销；
 *  - graphGetPermission / graphRequestPermission 不需要已有权限（用于发现与申请）；
 *  - 其余 graph* 动作必须已获得对应级别授权：读类需 read，写/控制类需 control；
 *  - 未授权返回 error，小程序侧以 Rejected Promise 感知。
 */

import type { GraphGateway } from './graph-gateway';
import { getSandboxGraphPermission, type SandboxGraphPermission } from '@/lib/settings';

/** 通过 Bob Sandbox Bridge 暴露给小程序的全部 graph 动作（白名单） */
export const GRAPH_BRIDGE_ACTIONS = [
  'graphGetPermission',
  'graphRequestPermission',
  'graphGetSnapshot',
  'graphGetViewport',
  'graphExpandNode',
  'graphCollapseNode',
  'graphSetViewport',
  'graphFitView',
  'graphZoomBy',
  'graphSetNodePositions',
  'graphSetNodeSelected',
] as const;

export type GraphBridgeAction = (typeof GRAPH_BRIDGE_ACTIONS)[number];

/** 需要 control 授权的动作（可读 + 可操作画布）；其余 graph 动作只需 read（非 none） */
const CONTROL_ACTIONS: ReadonlySet<string> = new Set([
  'graphExpandNode',
  'graphCollapseNode',
  'graphSetViewport',
  'graphFitView',
  'graphZoomBy',
  'graphSetNodePositions',
  'graphSetNodeSelected',
]);

export interface GraphBridgeResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface GraphBridgeContext {
  /** 发起调用的小程序 appId（客户端脚本自动注入，与预览 iframe 一一对应） */
  appId: string;
  /** 站内统一对接端口（由 CanvasFlow 提供实现） */
  gateway: GraphGateway;
  /** 请求用户（空间站控制台）授予授权：返回实际授予后的级别（拒绝 = 'none'） */
  requestPermission: (appId: string, level: SandboxGraphPermission) => Promise<SandboxGraphPermission>;
}

/** 判断某动作是否属于 GraphBridge 白名单 */
export function isGraphBridgeAction(action: string): boolean {
  return (GRAPH_BRIDGE_ACTIONS as readonly string[]).includes(action);
}

/**
 * 执行一个 graph bridge 动作：先鉴权（按 appId + 动作类别），再调用 gateway。
 * 不抛异常，统一以 GraphBridgeResult 返回。
 */
export async function executeGraphBridgeAction(
  action: string,
  data: Record<string, unknown>,
  ctx: GraphBridgeContext,
): Promise<GraphBridgeResult> {
  // ---- 权限发现 / 申请：无需已有权限 ----
  if (action === 'graphGetPermission') {
    const level = await getSandboxGraphPermission(ctx.appId);
    return { success: true, data: { level } };
  }
  if (action === 'graphRequestPermission') {
    const requested =
      data.level === 'control' ? 'control' : data.level === 'read' ? 'read' : 'none';
    if (requested === 'none') {
      return { success: false, error: 'Invalid permission level: must be "read" or "control"' };
    }
    const granted = await ctx.requestPermission(ctx.appId, requested);
    return { success: true, data: { level: granted } };
  }

  // ---- 其余动作：先鉴权 ----
  if (!ctx.appId) {
    return { success: false, error: 'Cannot identify mini-program (appId missing)' };
  }
  if (!isGraphBridgeAction(action)) {
    return { success: false, error: 'Unknown graph action: ' + action };
  }
  const level = await getSandboxGraphPermission(ctx.appId);
  if (level === 'none') {
    return {
      success: false,
      error: 'Graph access denied: not granted. Call graphRequestPermission first.',
    };
  }
  if (CONTROL_ACTIONS.has(action) && level !== 'control') {
    return {
      success: false,
      error: 'Graph control denied: requires "control" permission (current: ' + level + ')',
    };
  }

  // ---- 执行 ----
  const gateway = ctx.gateway;
  switch (action) {
    case 'graphGetSnapshot':
      return { success: true, data: gateway.getSnapshot() };
    case 'graphGetViewport':
      return { success: true, data: gateway.getViewport() };
    case 'graphExpandNode': {
      const nodeId = String(data.nodeId ?? '');
      if (!nodeId) return { success: false, error: 'nodeId is required' };
      gateway.expandNode(nodeId);
      return { success: true, data: { ok: true } };
    }
    case 'graphCollapseNode': {
      const nodeId = String(data.nodeId ?? '');
      if (!nodeId) return { success: false, error: 'nodeId is required' };
      gateway.collapseNode(nodeId);
      return { success: true, data: { ok: true } };
    }
    case 'graphSetViewport': {
      const vp = (data.viewport ?? {}) as { x?: unknown; y?: unknown; zoom?: unknown };
      gateway.setViewport({
        x: Number(vp.x ?? 0),
        y: Number(vp.y ?? 0),
        zoom: Number(vp.zoom ?? 1),
      });
      return { success: true, data: { ok: true } };
    }
    case 'graphFitView':
      gateway.fitView({ padding: Number(data.padding ?? 0.2) });
      return { success: true, data: { ok: true } };
    case 'graphZoomBy':
      gateway.zoomBy(Number(data.delta ?? 0.2));
      return { success: true, data: { ok: true } };
    case 'graphSetNodePositions': {
      const positions = (data.positions ?? {}) as Record<string, { x: number; y: number }>;
      gateway.setNodePositions(positions);
      return { success: true, data: { ok: true } };
    }
    case 'graphSetNodeSelected':
      gateway.setNodeSelected(data.nodeId ? String(data.nodeId) : null);
      return { success: true, data: { ok: true } };
    default:
      return { success: false, error: 'Unknown graph action: ' + action };
  }
}
