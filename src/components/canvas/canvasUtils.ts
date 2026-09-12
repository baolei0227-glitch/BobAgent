// canvasUtils.ts
// 纯/无状态工具函数（2026-09 Stage 4 Phase A 抽离自 CanvasFlow.tsx 的 CanvasFlowInner）。
// 零运行时依赖：仅依赖本地类型与环境无关的数学/字符串判定，便于单测与复用。
// 注意：这些函数无副作用、不读取 React 组件/上下文状态；UI 区域组件与状态 hook 的抽离见后续 Phase B / Phase C。

import type { HostEdge } from './node-host';
import type { PluginPanelEntry } from '@/lib/plugin-panels';
import { NotebookText, BrainCircuit, Boxes } from 'lucide-react';

/** 追加一条边（重复 id 去重；等价旧 React Flow addEdge 行为） */
export function addEdge(edge: HostEdge, eds: HostEdge[]): HostEdge[] {
  return eds.some((e) => e.id === edge.id) ? eds : [...eds, edge];
}

export type FlowAiNodeType = string;

/**
 * 依据 frontmatter node_type 计算 AI 节点类型（命名四层约定）：
 *  - node_type 以 agent- 开头（新规范）→ 原样（agent-note / agent-coding / agent-chat）
 *  - node_type = noteAgent（旧笔记 agent 节点）→ 映射 agent-note
 *  - node_type = 其他（chat/coding 兼容）→ 前缀 agent-
 *  - 无 node_type（旧存量）：sandboxAppId → aiCoding（兼容），否则 aiChat（兼容）
 */
export function flowNodeTypeForData(data: { sandboxAppId?: string; nodeType?: string }): FlowAiNodeType {
  const nt = data.nodeType;
  if (nt) {
    if (/^agent-/.test(nt)) return nt;
    if (nt === 'noteAgent') return 'agent-note';
    return `agent-${nt}`;
  }
  if (data.sandboxAppId) return 'aiCoding';
  return 'aiChat';
}

/** 单焦点画布：可被"桌面单节点 + 左侧圆点"收纳的节点类型。
 *  agent 研究节点（含旧 aiChat/aiCoding）纳入单焦点；note/annotation/imageGen 等豁免（常驻画布）。 */
export function isFocusableResearch(type?: string): boolean {
  return type === 'aiChat' || type === 'aiCoding' || (!!type && type.startsWith('agent-'));
}

/** 判断是否为绝对本地文件路径（用于把 HTML 文档交给 Hippo Browser） */
export function isAbsoluteFsPath(p: string): boolean {
  return typeof p === 'string' && (p.startsWith('/') || p.startsWith('~/') || /^file:\/\//.test(p));
}

/** 由节点 type 推导 agent 身份（chat/coding/note/butler）；无法识别返回 undefined */
export function agentIdentityFromNodeType(type?: string): string | undefined {
  if (type === 'aiChat') return 'chat';
  if (type === 'aiCoding') return 'coding';
  if (type && type.startsWith('agent-')) return type.slice('agent-'.length);
  return undefined;
}

/** 估算标签胶囊宽度（用于溢出折叠测量，避免依赖 DOM 布局状态） */
export function estimateTabWidth(label: string): number {
  const textW = Array.from(label).reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 13 : 7), 0);
  return Math.min(140, textW + 46); // padding(20) + 关闭按钮(16) + 间距(10)
}

/** 插件面板 Tab 图标：按注册表 icon 键映射（brain/notebook），缺省通用插件图标 */
export function pluginPanelTabIcon(icon?: PluginPanelEntry['icon']) {
  if (icon === 'notebook') return NotebookText;
  if (icon === 'brain') return BrainCircuit;
  return Boxes;
}
