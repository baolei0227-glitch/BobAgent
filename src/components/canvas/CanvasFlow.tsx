'use client';

import { useRef, useEffect, useCallback, useState, useMemo, useLayoutEffect, useSyncExternalStore } from 'react';
import { PanelRightOpen, PanelRightClose, RectangleHorizontal, RectangleVertical, X, Code2, MessageSquareText, Check, FileText, ClipboardList, NotebookText, CalendarClock, Folder, Monitor, Trash, Search, Plus, LayoutGrid, Loader2, Bot } from 'lucide-react';
import {
  ReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  SelectionMode,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useStoreApi,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChatNodeKernel, NodeReaderContext, type ChatNodeKernelProps } from './ChatNodeKernel';
import { ChatNode } from './ChatNode';
import { CodingNode } from './CodingNode';
import { NoteNode } from './NoteNode';
import { PlannerNode } from './PlannerNode';
import { ImageGenNode } from './ImageGenNode';
import { ImageGenAlbumNode } from './ImageGenAlbumNode';
import { BobbyNode } from './BobbyNode';
import { AgentTeamsNode } from './AgentTeamsNode';
import { AgentTeamsPanel } from './AgentTeamsPanel';
import { UsagePanel } from './UsagePanel';
import { AnnotationNode } from './AnnotationNode';
import { useConfirm } from './ConfirmDialog';
import { SandboxPanel } from './SandboxPanel';
import { outcomeMaxLengthForModel } from '@/lib/context-limits';
import { setCurrentProject } from '@/lib/current-project';
import { NodeMap } from './NodeMap';
import { SettingsModal } from './SettingsModal';
import { ProjectBoardView } from './ProjectBoardView';
import { DocxTemplatePanel } from './DocxTemplatePanel';
import { UnifiedViewer } from './UnifiedViewer';
import { Sidebar } from './Sidebar';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

import { CalendarPanel } from './CalendarPanel';
import { NotesPanel } from './NotesPanel';
import { BobMindPanel } from './BobMindPanel';
import { WelcomeScreen } from './WelcomeScreen';
import { LocalFileExplorer } from './LocalFileExplorer';
import { UnifiedPalette } from './UnifiedPalette';
import { AICodingCreateDialog } from './AICodingCreateDialog';
import type { AiChatNodeData, BobbyNodeData, AgentTeamsNodeData, ProviderConfig, ChatMessage } from '@/lib/types';
import { DEFAULT_MODEL_ID, DEFAULT_THINKING_LEVEL } from '@/lib/types';
import type { FileSourceKind } from '@/lib/files/types';
import type { FileOpenPayload } from '@/lib/files/types';
import { registerFileSources } from '@/lib/files/sources';
import { listAgents, agentFlowType } from '@/lib/agents/profiles';
import { bus, BusEvents } from '@/lib/bus';
import { edgeTypeToRelation } from '@/lib/edge/relations';
import type { GraphGateway, GraphSnapshot } from '@/lib/graph/graph-gateway';
import { executeGraphBridgeAction, isGraphBridgeAction } from '@/lib/graph/graph-bridge';
import { buildChains } from '@/lib/graph/chain-utils';
import { updateSandboxGraphPermission, updateSandboxChatPermission, getSandboxChatPermission, PRESET_THEME_VARIABLES, estimateChatCost, type SandboxChatPermission } from '@/lib/settings';
import { HOST_CHAT_PERMISSION_ACTIONS } from '@/lib/sandbox/bridge-constants';
import {
  setImageAiEditHidden,
  setImageAiEditKeepAlive,
  isImageAiEditKeepAlive,
  onImageAiEditStateChange,
} from '@/lib/image-ai-edit-runtime';
import { ImageAiEditToast } from './ImageAiEditToast';
import { SetupWizard } from './SetupWizard';
import { desktop, isDesktop } from '@/lib/desktop-adapter';
import pkg from '../../../package.json';

// —— 预览面板自由缩放常量 ——
// 面板宽度由固定两档（580/960）改为可在 [PANEL_W_MIN, 可用上限] 之间自由拖拽，
// 并随窗口/左栏/文件面板动态收敛，避免小窗口下被中间对话面板卡死而无法打开。
const PANEL_W_MIN = 320; // 面板最小宽度（px）
const PANEL_W_DEFAULT = 720; // 无持久化记录时的默认宽度
const PANEL_W_PRESET_NARROW = 580; // 竖屏（窄）快捷档位
const PANEL_W_PRESET_WIDE = 960; // 横屏（宽）快捷档位
const PANEL_W_ABS_MAX = 1440; // 绝对上限（超宽屏也不至于过宽）
const PANEL_W_PERSIST_KEY = 'bobwork.ui.panel.width'; // 持久化 key
const PANEL_CONVERSATION_MIN = 200; // 为中间对话区保留的最小宽度，防止面板拖到把对话挤没

// 注册统一文件来源（Step 2）：模块加载时注册，幂等
registerFileSources();

/** AI 画布节点类型：agent 节点按 AGENT_PROFILES 注册表派生（agent-<id>），避免手写散落。
 *  imagegenAlbum：ImageGen 的版本相册节点（openAlbum 以 type='imagegenAlbum' 创建，
 *  必须注册否则 ReactFlow 渲染未知类型默认占位 → 白方块） */
const AGENT_NODE_SHELLS: Record<string, React.ComponentType<any>> = {
  chat: ChatNode,
  coding: CodingNode,
  note: NoteNode,
  planner: PlannerNode,
};

/**
 * 市场/自定义 agent 通用壳（2026-09-06 Agent 市场）：未在 AGENT_NODE_SHELLS 登记的内置壳时，
 * 一律用 ChatNodeKernel + identity=<agentId> 渲染——agent 画像（prompt/场景/工具/技能池）全部服务端解析，
 * 前端无需为新 agent 写专属壳。按 id 缓存组件实例保证 memo 稳定。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const genericAgentNodeCache = new Map<string, React.ComponentType<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function genericAgentNodeFor(agentId: string): React.ComponentType<any> {
  let node = genericAgentNodeCache.get(agentId);
  if (!node) {
    node = function GenericAgentNode(props: Omit<ChatNodeKernelProps, 'identity'>) {
      return <ChatNodeKernel {...props} identity={agentId} />;
    };
    genericAgentNodeCache.set(agentId, node);
  }
  return node;
}
const nodeTypes = {
  // 兼容存量：旧 aiChat/aiCoding 节点（frontmatter 无 node_type）仍可渲染
  aiChat: ChatNode,
  aiCoding: CodingNode,
  // 新 agent 节点：flow type = agent-<id>（由 AGENT_PROFILES 派生）
  ...Object.fromEntries(
    listAgents()
      .filter((a) => AGENT_NODE_SHELLS[a.id])
      .map((a) => [agentFlowType(a.id), AGENT_NODE_SHELLS[a.id]]),
  ),
  imageGen: ImageGenNode,
  imagegenAlbum: ImageGenAlbumNode,
  bobby: BobbyNode,
  agentTeams: AgentTeamsNode,
  annotation: AnnotationNode,
};
// 展开/聚焦节点时可视区最低可用宽度：低于该值说明右侧宽屏预览面板严重挤占（14" 屏 + 宽面板场景），
// 自动折叠面板让出空间，否则展开节点会与面板重叠且宽度被压到不可用
const MIN_EXPAND_VISIBLE_W = 480;
// 节点间不重叠：避让后保留的间距
const NODE_GAP = 24;

// —— 窄屏自适应断点（级联收起，画布优先）——
// 画布舒适下限与 MIN_EXPAND_VISIBLE_W 一致(480)：低于相应宽度时全开/逐级让位也难以保住它，
// 因此窗口过窄时按优先级自动收起「左栏 → 本地文件面板 → 预览面板」，拉宽后恢复被自动收起的部分。
// 每个断点 = 该级收起前仍在场各列宽度之和 + 画布舒适 480（本地文件面板被 pin 固定时不自动收起）
const NARROW_COMFORT_CANVAS = MIN_EXPAND_VISIBLE_W; // 480
const NAV_W_EXPANDED = 280; // 展开态左栏宽度（与 className w-[280px] 保持一致）
const NAV_W_COLLAPSED = 52; // 折叠态左栏宽度（与 className w-[52px] 保持一致）
const EXPLORER_W_OPEN = 280; // 本地文件面板展开宽度（与 LocalFileExplorer width:280 保持一致）
// ① 左栏最先收起：全开（左栏+文件+预览最小）时画布已不足 480
const NARROW_W_NAV = NAV_W_EXPANDED + EXPLORER_W_OPEN + PANEL_W_MIN + NARROW_COMFORT_CANVAS; // 1360
// ② 其次收起本地文件面板：此时左栏已折为 52，剩余（文件+预览最小）画布仍不足 480
const NARROW_W_EXPLORER = NAV_W_COLLAPSED + EXPLORER_W_OPEN + PANEL_W_MIN + NARROW_COMFORT_CANVAS; // 1132
// ③ 最后收起预览面板：仅剩（左栏52+预览最小）也保不住画布 480 时才让步（预览最受保护）
const NARROW_W_PANEL = NAV_W_COLLAPSED + PANEL_W_MIN + NARROW_COMFORT_CANVAS; // 852

interface OverlapRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 固定节点不可移动（展开节点/拖拽中节点）；无 fixed 的节点均为自由节点 */
  fixed?: boolean;
}

/** 矩形是否相交（含间距 gap） */
function rectsIntersect(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/**
 * 节点间不重叠解析：固定节点（展开/拖拽中）为锚不可动，把与其相交的自由节点沿
 * 最小位移轴推出（带 gap），迭代多轮收敛链式碰撞。返回仅含发生位移节点的新位置。
 */
function resolveNodeOverlaps(nodes: OverlapRect[], gap = NODE_GAP): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const fixedSet = new Set(nodes.filter((n) => n.fixed).map((n) => n.id));
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const pa = pos.get(a.id)!;
        const pb = pos.get(b.id)!;
        const ra = { x: pa.x, y: pa.y, w: a.w, h: a.h };
        const rb = { x: pb.x, y: pb.y, w: b.w, h: b.h };
        if (!rectsIntersect(ra, rb, gap)) continue;
        if (fixedSet.has(a.id) && fixedSet.has(b.id)) continue; // 双固定：保持重叠
        const moveA = fixedSet.has(b.id) && !fixedSet.has(a.id);
        const mover = moveA ? a : b;
        const anchor = moveA ? b : a;
        const mp = pos.get(mover.id)!;
        const ap = pos.get(anchor.id)!;
        // 沿最小位移轴推出：水平推（左右）或垂直推（上下）取位移较小者
        const targetX = mp.x >= ap.x ? ap.x + anchor.w + gap : ap.x - mover.w - gap;
        const targetY = mp.y >= ap.y ? ap.y + anchor.h + gap : ap.y - mover.h - gap;
        const dx = Math.abs(targetX - mp.x);
        const dy = Math.abs(targetY - mp.y);
        pos.set(mover.id, dx <= dy ? { x: targetX, y: mp.y } : { x: mp.x, y: targetY });
        moved = true;
      }
    }
    if (!moved) break;
  }
  const result = new Map<string, { x: number; y: number }>();
  for (const [id, p] of pos) {
    const orig = nodes.find((n) => n.id === id);
    if (orig && (Math.abs(orig.x - p.x) > 0.5 || Math.abs(orig.y - p.y) > 0.5)) result.set(id, p);
  }
  return result;
}

/**
 * 依据 frontmatter node_type 计算 AI 节点类型（命名四层约定）：
 *  - node_type 以 agent- 开头（新规范）→ 原样（agent-note / agent-coding / agent-chat）
 *  - node_type = noteAgent（旧笔记 agent 节点）→ 映射 agent-note
 *  - node_type = 其他（chat/coding 兼容）→ 前缀 agent-
 *  - 无 node_type（旧存量）：sandboxAppId → aiCoding（兼容），否则 aiChat（兼容）
 */
type FlowAiNodeType = string;
function flowNodeTypeForData(data: { sandboxAppId?: string; nodeType?: string }): FlowAiNodeType {
  const nt = data.nodeType;
  if (nt) {
    if (/^agent-/.test(nt)) return nt;
    if (nt === 'noteAgent') return 'agent-note';
    return `agent-${nt}`;
  }
  if (data.sandboxAppId) return 'aiCoding';
  return 'aiChat';
}
// 画布物理不再渲染节点连线（2026-09 用户拍板：连线关系改由 NodeMap 缩略图管理，
// 节点标题栏以链接图标表达关系）。edges 数据仍完整保留在 ReactFlow store：
// gateway 快照 → NodeMap 渲染/管理、链导航圆点、上游上下文注入、断线状态均继续消费。
// 因此注册一个空渲染边类型，避免 React Flow 兜底绘制默认直线。
function EmptyCanvasEdge() {
  return null;
}
const edgeTypes = { floating: EmptyCanvasEdge };

/** 单焦点画布：可被"桌面单节点 + 左侧圆点"收纳的节点类型。
 *  agent 研究节点（含旧 aiChat/aiCoding）纳入单焦点；note/annotation/imageGen 等豁免（常驻画布）。 */
function isFocusableResearch(type?: string): boolean {
  return type === 'aiChat' || type === 'aiCoding' || (!!type && type.startsWith('agent-'));
}

/** 由节点 type 推导 agent 身份（chat/coding/note/planner）；无法识别返回 undefined */
function agentIdentityFromNodeType(type?: string): string | undefined {
  if (type === 'aiChat') return 'chat';
  if (type === 'aiCoding') return 'coding';
  if (type && type.startsWith('agent-')) return type.slice('agent-'.length);
  return undefined;
}

/** 右键菜单 agent 项图标（id → 图标元素；未配置的 agent 用默认聊天气泡）。
 *  颜色与各身份节点实际外框高亮色保持一致：coding 蓝(--info)/Kar 黄(--warn)/Planner 绿(--success)/chat 暖红(--danger)，
 *  与 ChatNodeKernel 的 accentVar 映射同源。 */
const AGENT_MENU_ICONS: Record<string, { icon: React.ReactNode; color: string; hoverBg: string }> = {
  // chat 统一用 Bot 图标（2026-09：与阅读面板标题身份图标同源；Bot 字形较实，光学收半档到 15px，
  // coding/note/planner 专属图标纤细维持 16px 才能视觉等大）
  chat: { icon: <Bot className="h-[15px] w-[15px] shrink-0" />, color: 'var(--danger)', hoverBg: 'var(--danger-soft)' },
  coding: { icon: <Code2 className="h-4 w-4 shrink-0" />, color: 'var(--info)', hoverBg: 'var(--info-soft)' },
  note: { icon: <NotebookText className="h-4 w-4 shrink-0" />, color: 'var(--warn)', hoverBg: 'var(--warn-soft)' },
  planner: { icon: <CalendarClock className="h-4 w-4 shrink-0" />, color: 'var(--success)', hoverBg: 'var(--success-soft)' },
};
const AGENT_MENU_DEFAULT_ICON = { icon: <MessageSquareText className="h-4 w-4 shrink-0" />, color: 'var(--primary-strong)', hoverBg: 'var(--paper-hover)' };

/** 右键菜单 agent 项显示名（id → 菜单文案；未配置的回退 profile.label） */
const AGENT_MENU_LABELS: Record<string, string> = {
  chat: 'Chat',
  coding: 'Coding',
  note: 'Kar',
  planner: 'Planner',
};

const defaultEdgeOptions = {
  type: 'floating' as const,
};

// 从 .md 文件恢复节点到画布
function restoredNodeToFlowNode(
  nodeData: {
    node_id: string;
    title: string;
    model?: string;
    summary?: string;
    conversations: Array<{ question: string; answer: string; questionTime: string; answerTime: string; modelId?: string; thinkingLevel?: string; reasoning?: string; processNarration?: string; toolCalls?: ChatMessage['toolCalls']; outputFiles?: ChatMessage['outputFiles'] }>;
    enabledMcpIds?: string[];
    selectedSkills?: string[];
    position_x?: number;
    position_y?: number;
    sandbox_app_id?: string;
    node_type?: string;
    /** 已压缩轮次数（memory_compacted_until）：请求时跳过已压缩历史 */
    compacted_until?: number;
  },
  index: number,
): Node<AiChatNodeData> {
  // 过滤占位 answer：创建节点时同步写入的"__BAI_INITIAL_PROMPT_PLACEHOLDER__"不展示给用户
  const INIT_PLACEHOLDER = '__BAI_INITIAL_PROMPT_PLACEHOLDER__';
  // 将对话记录转换为 ChatMessage[]
  const messages: (ChatMessage & { summary?: string })[] = [];
  const visibleTurns = nodeData.conversations.filter((c) => c.answer !== INIT_PLACEHOLDER);
  for (let i = 0; i < visibleTurns.length; i++) {
    const conv = visibleTurns[i];
    messages.push({
      id: `msg-${nodeData.node_id}-q${i}`,
      role: 'user',
      content: conv.question,
      timestamp: conv.questionTime,
    });
    messages.push({
      id: `msg-${nodeData.node_id}-a${i}`,
      role: 'assistant',
      content: conv.answer,
      summary: i === visibleTurns.length - 1 && nodeData.summary ? nodeData.summary : undefined,
      timestamp: conv.answerTime,
      // 历史消息追溯真实调用模型与推理强度（auto 模式下每轮可能不同）
      modelId: conv.modelId,
      thinkingLevel: conv.thinkingLevel as ChatMessage['thinkingLevel'],
      // 恢复持久化的思考内容 + 工具调用记录：think 标签与 Trajectory 重新加载后不丢失
      reasoning: conv.reasoning,
      processNarration: conv.processNarration,
      toolCalls: conv.toolCalls,
      outputFiles: conv.outputFiles,
    });
  }

  // 优先使用持久化的节点位置（拖拽后已保存）；缺省时按网格排列：每行 3 个，间距 400px
  let position: { x: number; y: number };
  const hasPersistedPosition = typeof nodeData.position_x === 'number' && typeof nodeData.position_y === 'number';
  if (hasPersistedPosition) {
    position = { x: nodeData.position_x as number, y: nodeData.position_y as number };
  } else {
    const col = index % 3;
    const row = Math.floor(index / 3);
    position = {
      x: -300 + col * 400,
      y: -200 + row * 350,
    };
  }

  return {
    id: nodeData.node_id,
    type: flowNodeTypeForData({ sandboxAppId: nodeData.sandbox_app_id, nodeType: nodeData.node_type }),
    position,
    data: {
      title: nodeData.title,
      messages,
      isStreaming: false,
      modelId: nodeData.model || DEFAULT_MODEL_ID,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      nodeMdId: nodeData.node_id,
      ...(nodeData.enabledMcpIds !== undefined ? { enabledMcpIds: nodeData.enabledMcpIds } : {}),
      ...(nodeData.selectedSkills !== undefined ? { selectedSkills: nodeData.selectedSkills } : {}),
      ...(nodeData.sandbox_app_id ? { sandboxAppId: nodeData.sandbox_app_id } : {}),
      ...(typeof nodeData.compacted_until === 'number' && nodeData.compacted_until > 0 ? { compactedUntil: nodeData.compacted_until } : {}),
      __hasPersistedPosition: hasPersistedPosition,
    },
  };
}

/** 将恢复的批注框节点转换为 flow 节点（annotation 类型；宽高由自动跟随包裹按卡片重算） */
function restoredAnnotationToFlowNode(
  nodeData: {
    node_id: string;
    title: string;
    annotation_node_ids?: string[];
    annotation_text?: string;
    position_x?: number;
    position_y?: number;
  },
): Node<AiChatNodeData> {
  return {
    id: nodeData.node_id,
    type: 'annotation',
    position: { x: nodeData.position_x ?? 0, y: nodeData.position_y ?? 0 },
    data: {
      title: nodeData.title || '批注',
      messages: [],
      isStreaming: false,
      nodeMdId: nodeData.node_id,
      annotationText: nodeData.annotation_text ?? '',
      annotationNodeIds: nodeData.annotation_node_ids ?? [],
      __hasPersistedPosition: typeof nodeData.position_x === 'number',
    },
  };
}

/** 将恢复的图像生成节点转换为 flow 节点（imageGen 类型，独立工作台） */
function restoredImageGenToFlowNode(
  nodeData: {
    node_id: string;
    title: string;
    position_x?: number;
    position_y?: number;
  },
  index: number,
): Node<AiChatNodeData> {
  let position: { x: number; y: number };
  const hasPersistedPosition = typeof nodeData.position_x === 'number' && typeof nodeData.position_y === 'number';
  if (hasPersistedPosition) {
    position = { x: nodeData.position_x as number, y: nodeData.position_y as number };
  } else {
    const col = index % 3;
    const row = Math.floor(index / 3);
    position = { x: -300 + col * 400, y: -200 + row * 350 };
  }
  return {
    id: nodeData.node_id,
    type: 'imageGen',
    position,
    data: {
      title: nodeData.title || 'Image Generation',
      mode: 'generate',
      prompt: '',
      size: '1024x1024',
      __hasPersistedPosition: hasPersistedPosition,
    },
  } as unknown as Node<AiChatNodeData>;
}

/** 将恢复的多 Agent 编排节点转换为 flow 节点（orchestrator 类型，薄客户端） */
function restoredBobbyToFlowNode(
  nodeData: {
    node_id: string;
    title: string;
    position_x?: number;
    position_y?: number;
  },
  index: number,
): Node<BobbyNodeData> {
  let position: { x: number; y: number };
  const hasPersistedPosition = typeof nodeData.position_x === 'number' && typeof nodeData.position_y === 'number';
  if (hasPersistedPosition) {
    position = { x: nodeData.position_x as number, y: nodeData.position_y as number };
  } else {
    const col = index % 3;
    const row = Math.floor(index / 3);
    position = { x: -300 + col * 400, y: -200 + row * 350 };
  }
  return {
    id: nodeData.node_id,
    type: 'bobby',
    position,
    data: {
      title: nodeData.title || 'Bobby node',
      prompt: '',
      status: 'idle',
      __hasPersistedPosition: hasPersistedPosition,
    },
  };
}

/** 将恢复的 Agent Teams 观察节点转换为 flow 节点（薄客户端，状态从 /api/team 实时拉取） */
function restoredAgentTeamsToFlowNode(
  nodeData: {
    node_id: string;
    title: string;
    position_x?: number;
    position_y?: number;
  },
  index: number,
): Node<AgentTeamsNodeData> {
  let position: { x: number; y: number };
  const hasPersistedPosition = typeof nodeData.position_x === 'number' && typeof nodeData.position_y === 'number';
  if (hasPersistedPosition) {
    position = { x: nodeData.position_x as number, y: nodeData.position_y as number };
  } else {
    const col = index % 3;
    const row = Math.floor(index / 3);
    position = { x: -300 + col * 400, y: -200 + row * 350 };
  }
  return {
    id: nodeData.node_id,
    type: 'agentTeams',
    position,
    data: {
      title: nodeData.title || 'Agent Teams',
      prompt: '',
      status: 'idle',
      __hasPersistedPosition: hasPersistedPosition,
    },
  };
}

/** 估算标签胶囊宽度（用于溢出折叠测量，避免依赖 DOM 布局状态） */
function estimateTabWidth(label: string): number {
  const textW = Array.from(label).reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 13 : 7), 0);
  return Math.min(140, textW + 46); // padding(20) + 关闭按钮(16) + 间距(10)
}

/** 统一悬浮面板：所有文档以标签页形式组织在单一可拖拽面板中 */
function UnifiedReaderPanel({
  openReaderIds,
  fileTabs,
  sandboxTabs,
  readerTitles,
  activePanelTab,
  collapsed,
  panelWidth,
  onToggleCollapse,
  onToggleWide,
  onSelectTab,
  onCloseNodeTab,
  onCloseFileTab,
  onCloseSandboxTab,
  onCloseTemplateTab,
  templateInitialScene,
  currentProjectId,
  outcomeModeTabIds,
  sandboxRefreshTick,
}: {
  openReaderIds: string[];
  fileTabs: Array<{
    id: string;
    source: FileSourceKind;
    fileName: string;
    filePath: string;
    /** 图片集模式：聚合的图片路径列表（所有图片共用一个标签页） */
    imagePaths?: string[];
    /** 图片集模式：当前激活的图片路径 */
    activeImagePath?: string;
  }>;
  sandboxTabs: Array<{ id: string; name: string }>;
  readerTitles: Record<string, string>;
  activePanelTab: { type: 'node' | 'file' | 'sandbox' | 'template'; id: string } | null;
  collapsed: boolean;
  /** 面板当前宽度（px），可在 [PANEL_W_MIN, 可用上限] 之间自由缩放 */
  panelWidth: number;
  onSelectTab: (type: 'node' | 'file' | 'sandbox' | 'template', id: string) => void;
  onCloseNodeTab: (nodeMdId: string) => void;
  onCloseFileTab: (tabId: string) => void;
  onCloseSandboxTab: (tabId: string) => void;
  onCloseTemplateTab: () => void;
  /** 打开模板 tab 时预选的场景名（AI 扫描到模板字段后跳转时携带） */
  templateInitialScene?: string;
  onToggleCollapse: () => void;
  /** 切换竖屏/横屏（宽窄） */
  onToggleWide: () => void;
  currentProjectId: string;
  /** 成果块模式打开的 tab ID 集合 */
  outcomeModeTabIds: Set<string>;
  /** Bob Sandbox 预览强制刷新信号（Play / 绑定 / AI 写入后递增） */
  sandboxRefreshTick: number;
}) {
  // 面板宽度：由父组件传入的 panelWidth 控制，可在最小宽度与可用上限之间自由缩放
  const PANEL_W = panelWidth;
  // 便捷档位图标判定：宽度 ≥ 宽窄两档中值视为"宽屏"，用于宽窄切换按钮的图形/文案
  const panelWide = panelWidth >= (PANEL_W_PRESET_NARROW + PANEL_W_PRESET_WIDE) / 2;

  // 标签悬停提示（完整文件名，仅在被截断时显示）
  const [hoverTip, setHoverTip] = useState<{ text: string; x: number; y: number } | null>(null);

  // 模板插件惰性挂载：一旦打开过就保持挂载（切换 tab 时仅 display 隐藏，不卸载），
  // 避免用户填了一半切到文件预览后返回时填写内容丢失
  const [templatePanelMounted, setTemplatePanelMounted] = useState(false);
  useEffect(() => {
    if (activePanelTab?.type === 'template') setTemplatePanelMounted(true);
  }, [activePanelTab?.type]);

  // —— 沙盒预览实时 console 错误（功能：预览 iframe 的 console.error/warn 实时上报，右上角胶囊提示） ——
  const [sandboxConsole, setSandboxConsole] = useState<Array<{ appId: string; level: 'error' | 'warn'; text: string; ts: number }>>([]);
  const [sandboxConsoleOpen, setSandboxConsoleOpen] = useState(false);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.type !== 'bob_console' || !Array.isArray(msg.msgs)) return;
      // 信任校验：只接受来自 sandbox 预览 iframe 的消息
      const source = event.source as Window | null;
      if (!source) return;
      const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/api/sandbox/preview/"]');
      let trusted = false;
      for (let i = 0; i < iframes.length; i++) {
        try {
          if (iframes[i].contentWindow === source) { trusted = true; break; }
        } catch { /* cross-origin access blocked – skip */ }
      }
      if (!trusted) return;
      const appId = String(msg.appId ?? '');
      setSandboxConsole((prev) =>
        [
          ...prev,
          ...(msg.msgs as Array<{ level?: string; text?: string }>).map((m) => ({
            appId,
            level: m.level === 'error' ? ('error' as const) : ('warn' as const),
            text: String(m.text ?? '').slice(0, 400),
            ts: Date.now(),
          })),
        ].slice(-50),
      );
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // 标签栏溢出折叠：放得下的标签数量（超出部分收进 "…" 下拉菜单）
  // 初始为 0，由 useLayoutEffect 在绘制前同步计算真实数量（effect 定义在 allTabs 之后）
  const [visibleCount, setVisibleCount] = useState<number>(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const tabsWrapRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Bob Sandbox iframe 缓存破除：每次选中/切换/重开小程序 tab 都重新加载预览（AI 写入后可见最新内容）
  const [sandboxReloadKey, setSandboxReloadKey] = useState(0);
  // P0#9 soft-reload helper: snapshot then bump reload key
  const HOST_ORIGIN_SB = typeof window !== 'undefined' ? window.location.origin : '';
  const softReloadActiveSandbox = useCallback((activeTabId?: string) => {
    if (!activeTabId) { setSandboxReloadKey((k) => k + 1); return; }
    const iframe = document.querySelector<HTMLIFrameElement>(
      `iframe[src*="/api/sandbox/preview/${encodeURIComponent(activeTabId)}"]`,
    );
    if (iframe && iframe.contentWindow) {
      try {
        const msg = { type: 'bob_soft_reload', id: 'pre_refresh_' + Date.now() };
        if (HOST_ORIGIN_SB) iframe.contentWindow.postMessage(msg, HOST_ORIGIN_SB);
        else iframe.contentWindow.postMessage(msg, '*');
      } catch { /* ignore */ }
      // Give iframe 80ms to capture + write snapshot (localStorage is sync, so it's cheap)
      setTimeout(() => setSandboxReloadKey((k) => k + 1), 80);
    } else {
      setSandboxReloadKey((k) => k + 1);
    }
  }, [HOST_ORIGIN_SB]);

  useEffect(() => {
    if (activePanelTab?.type === 'sandbox') {
      softReloadActiveSandbox(activePanelTab.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelTab?.type, activePanelTab?.id, sandboxRefreshTick, softReloadActiveSandbox]);

  const handleSelectTab = (type: 'node' | 'file' | 'sandbox' | 'template', id: string) => {
    if (type === 'sandbox') softReloadActiveSandbox(id);
    onSelectTab(type, id);
  };

  // 合并所有 tabs（模板插件为单例 tab，始终存在但仅在 activePanelTab 指向时才显示）
  const allTabs = useMemo(() => [
    ...openReaderIds.map(id => ({ id, type: 'node' as const, label: readerTitles[id] || '...' })),
    ...fileTabs.map(t => ({ id: t.id, type: 'file' as const, label: t.fileName })),
    ...sandboxTabs.map(t => ({ id: t.id, type: 'sandbox' as const, label: t.name })),
    ...(activePanelTab?.type === 'template' ? [{ id: 'template', type: 'template' as const, label: 'Templates' }] : []),
  ], [openReaderIds, fileTabs, sandboxTabs, readerTitles, activePanelTab]);

  // 计算可容纳的标签数量：预留 "…" 按钮宽度，按估算宽度逐个累加（面板尺寸/标签变化时重算）
  useLayoutEffect(() => {
    const el = tabsWrapRef.current;
    if (!el) return;
    const compute = () => {
      const containerW = el.clientWidth;
      const moreBtnW = 34; // "…" 按钮 + 左右间距
      let used = moreBtnW;
      let count = 0;
      for (const tab of allTabs) {
        used += estimateTabWidth(tab.label);
        if (used <= containerW + 1) count++;
        else break;
      }
      setVisibleCount(count);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [allTabs, panelWidth]);

  // 点击外部关闭 "…" 下拉菜单
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Element)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [moreOpen]);

  // 查找活跃文件 tab
  const activeFileTab = activePanelTab?.type === 'file'
    ? fileTabs.find(t => t.id === activePanelTab.id)
    : null;

  // 查找活跃小程序 tab
  const activeSandboxTab = activePanelTab?.type === 'sandbox'
    ? sandboxTabs.find(t => t.id === activePanelTab.id)
    : null;

  // 折叠态：容器消失，仅保留固定在右上角的展开按钮（与左侧边栏折叠策略一致）
  if (collapsed) {
    if (allTabs.length === 0) return null;
    return (
      <button
        onClick={onToggleCollapse}
        className="fixed right-4 top-[14px] z-50 flex h-3 w-3 items-center justify-center rounded-full transition-colors hover:bg-[var(--paper-hover)]"
        style={{ color: 'var(--ink-muted)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={`Expand panel (${allTabs.length} tabs)`}
      >
        <PanelRightOpen className="h-5 w-5" />
      </button>
    );
  }

  if (allTabs.length === 0) return null;

  return (
    <div
      className="flex h-full flex-col overflow-hidden shrink-0"
      data-canvas-ui="overlay"
      data-reader-panel
      style={{
        width: PANEL_W,
        zIndex: 50,
        // 2026-09：恢复卡片样式，与中间对话节点卡片完全一致——圆角/1px边框/顶部受光渐变/内嵌高光
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)',
        background: 'linear-gradient(180deg, color-mix(in srgb, #fff 7%, var(--paper)) 0%, var(--paper) 38%)',
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent)',
        WebkitAppRegion: 'no-drag',
        pointerEvents: 'auto',
      } as React.CSSProperties}
    >
      {/* 标签栏（overflow-visible：供 "…" 下拉菜单浮出；标签列表自身 overflow-hidden 负责裁剪） */}
      <div
        className="flex shrink-0 items-center"
        style={{ borderBottom: '1px solid', borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)' }}
      >
        {/* 折叠按钮（面板左上角，仅折叠预览面板） */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title="Collapse preview panel"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>

        {/* 竖屏/横屏（宽窄）切换：放大 = 增加面板宽度 */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleWide(); }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title={panelWide ? 'Switch to portrait (narrower)' : 'Switch to landscape (wider)'}
        >
          {panelWide ? <RectangleVertical className="h-3.5 w-3.5" /> : <RectangleHorizontal className="h-3.5 w-3.5" />}
        </button>

        {/* 标签列表：容器不滚动，放不下的标签收进 "…" 下拉菜单 */}
        <div ref={tabsWrapRef} className="flex min-w-0 flex-1 items-center overflow-hidden">
          {allTabs.map((tab, idx) => {
            const isActive = activePanelTab?.id === tab.id && activePanelTab?.type === tab.type;
            const TabIcon = tab.type === 'file' ? FileText : tab.type === 'sandbox' ? Code2 : tab.type === 'template' ? ClipboardList : MessageSquareText;
            return (
              <div key={tab.id} className={`group flex shrink-0 items-center ${idx >= visibleCount ? 'hidden' : ''}`}>
                {/* 圆角胶囊标签：类型图标 + 标签名 + 关闭按钮；选中态带底部高亮指示条 */}
                <button
                  onClick={() => handleSelectTab(tab.type, tab.id)}
                  className="group/tab relative mx-0.5 flex max-w-[148px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--paper-hover)]"
                  style={{
                    backgroundColor: isActive ? 'var(--primary-soft)' : 'transparent',
                    color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                    fontFamily: 'var(--font-sans)',
                  }}
                  title={tab.label}
                >
                  <TabIcon className="h-3 w-3 shrink-0 opacity-70" style={{ color: isActive ? 'var(--primary)' : 'var(--ink-faint)' }} />
                  <span
                    className="min-w-0 flex-1 truncate"
                    onMouseEnter={(e) => {
                      const el = e.currentTarget;
                      // 仅在文本被截断时显示完整名称提示
                      if (el.scrollWidth > el.clientWidth) {
                        const rect = el.getBoundingClientRect();
                        setHoverTip({ text: tab.label, x: rect.left, y: rect.bottom + 6 });
                      }
                    }}
                    onMouseMove={(e) => {
                      setHoverTip((prev) => (prev ? { ...prev, x: e.clientX + 12, y: e.clientY + 14 } : prev));
                    }}
                    onMouseLeave={() => setHoverTip(null)}
                  >
                    {tab.label}
                  </span>
                  {isActive && (
                    <span
                      className="absolute bottom-0.5 left-2 right-2 h-[2px] rounded-full"
                      style={{ backgroundColor: 'var(--primary)' }}
                    />
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      if (tab.type === 'node') onCloseNodeTab(tab.id);
                      else if (tab.type === 'file') onCloseFileTab(tab.id);
                      else if (tab.type === 'template') onCloseTemplateTab();
                      else onCloseSandboxTab(tab.id);
                    }}
                    tabIndex={-1}
                    className="-mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover/tab:opacity-100 hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </button>
              </div>
            );
          })}
        </div>

        {/* "…" 更多标签下拉菜单：溢出标签在此选择 */}
        {visibleCount < allTabs.length && (
          <div ref={moreRef} className="relative shrink-0 pl-0.5 pr-1.5">
            <button
              onClick={() => setMoreOpen((o) => !o)}
              className={`flex h-6 w-6 items-center justify-center rounded text-sm font-bold leading-none transition-colors hover:bg-[var(--paper-hover)] ${moreOpen ? 'bg-[var(--paper-hover)]' : ''}`}
              style={{ color: 'var(--ink-muted)' }}
              title="More tabs"
            >
              …
            </button>
            {moreOpen && (
              <div
                className="absolute right-0 top-7 z-[80] max-h-[280px] w-60 overflow-y-auto rounded-xl border py-1 shadow-xl"
                style={{ borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)', backgroundColor: 'var(--popover)' }}
              >
                {allTabs.map((tab) => {
                  const isActive = activePanelTab?.id === tab.id && activePanelTab?.type === tab.type;
                  const TabIcon = tab.type === 'file' ? FileText : tab.type === 'sandbox' ? Code2 : tab.type === 'template' ? ClipboardList : MessageSquareText;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => { handleSelectTab(tab.type, tab.id); setMoreOpen(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                      style={{
                        color: isActive ? 'var(--primary)' : 'var(--ink)',
                        fontWeight: isActive ? 600 : 400,
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <TabIcon className="h-3 w-3 shrink-0 opacity-70" style={{ color: isActive ? 'var(--primary)' : 'var(--ink-faint)' }} />
                      <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                      {isActive && <Check className="h-3 w-3 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        {activePanelTab?.type === 'node' && (
          <UnifiedViewer
            key={activePanelTab.id}
            nodeMdId={activePanelTab.id}
            onClose={(id) => onCloseNodeTab(id)}
            onClickToFront={() => {}}
            mode="floating"
            defaultOutcomeMode={outcomeModeTabIds.has(activePanelTab.id) ? true : undefined}
          />
        )}
        {activePanelTab?.type === 'file' && activeFileTab && (
          <UnifiedViewer
            key={activeFileTab.id}
            filePath={activeFileTab.filePath}
            source={activeFileTab.source}
            fileName={activeFileTab.fileName}
            projectId={currentProjectId}
            imageSet={
              activeFileTab.imagePaths && activeFileTab.activeImagePath
                ? { paths: activeFileTab.imagePaths, activePath: activeFileTab.activeImagePath }
                : undefined
            }
            onClose={(id) => onCloseFileTab(id.startsWith('file:') ? id : `file:${id}`)}
            onClickToFront={() => {}}
            mode="floating"
          />
        )}
        {/* Bob Sandbox 小程序预览：iframe 直载 preview 接口（带缓存破除参数，重选即刷新） */}
        {activePanelTab?.type === 'sandbox' && activeSandboxTab && (
          <div className="relative h-full w-full">
            <iframe
              key={activeSandboxTab.id}
              src={`/api/sandbox/preview/${encodeURIComponent(activeSandboxTab.id)}?t=${sandboxReloadKey}`}
              title={activeSandboxTab.name}
              className="h-full w-full border-0"
              style={{ backgroundColor: 'var(--popover)' }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
              referrerPolicy="no-referrer-when-downgrade"
              allow="clipboard-read; clipboard-write"
            />
            {/* 实时 console 错误胶囊（预览 iframe 上报 bob_console）：有 error/warn 时显示，点击展开/收起 */}
            {sandboxConsole.length > 0 && (
              <div className="absolute right-2 top-2 z-10 overflow-hidden rounded-lg border text-11 shadow-lg"
                style={{ borderColor: 'var(--line)', backgroundColor: 'color-mix(in srgb, var(--paper) 94%, transparent)', backdropFilter: 'blur(6px)' }}>
                <button
                  onClick={() => setSandboxConsoleOpen((o) => !o)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
                  style={{ color: sandboxConsole.some((m) => m.level === 'error') ? 'var(--danger)' : '#b58900', fontWeight: 600 }}
                  title="Preview console messages"
                >
                  <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: sandboxConsole.some((m) => m.level === 'error') ? 'var(--danger)' : '#b58900' }} />
                  <span className="shrink-0">Console</span>
                  <span className="shrink-0 opacity-80">{sandboxConsole.filter((m) => m.level === 'error').length} err · {sandboxConsole.filter((m) => m.level === 'warn').length} warn</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setSandboxConsole([]); setSandboxConsoleOpen(false); }}
                    className="ml-auto px-0.5 hover:opacity-70"
                    style={{ color: 'var(--ink-muted)' }}
                    title="Clear"
                  >
                    ✕
                  </button>
                </button>
                {sandboxConsoleOpen && (
                  <div className="max-h-28 overflow-y-auto border-t px-2 py-1" style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}>
                    {sandboxConsole.slice(-8).map((m, i) => (
                      <div key={i} className="truncate py-0.5"
                        style={{ color: m.level === 'error' ? 'var(--danger)' : '#b58900' }}>
                        <span className="opacity-60">[{m.appId.slice(-8)}]</span> {m.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* 独立模板插件：预览面板打开，字段填写 + 本地生成，零 AI
            惰性挂载 + display 显隐切换：切走 tab 时保持挂载，填写内容不丢失 */}
        {(activePanelTab?.type === 'template' || templatePanelMounted) && (
          <div className="h-full" style={{ display: activePanelTab?.type === 'template' ? undefined : 'none' }}>
            <DocxTemplatePanel initialScene={templateInitialScene} />
          </div>
        )}
      </div>

      {/* 标签悬停提示：完整文件名 */}
      {hoverTip && (
        <div
          className="pointer-events-none fixed z-[200] whitespace-nowrap rounded-md px-2 py-1 text-xs shadow-lg"
          style={{
            left: hoverTip.x,
            top: hoverTip.y,
            backgroundColor: 'var(--ink)',
            color: 'var(--paper)',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {hoverTip.text}
        </div>
      )}
    </div>
  );
}

/** 左列/工具条圆形小图标按钮（2026-09 布局重构后复用） */
function ToolBtn({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title}
          onClick={onClick}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--paper-hover)]"
          style={{
            color: active ? 'var(--primary)' : 'var(--ink-muted)',
            backgroundColor: active ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : undefined,
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{title}</TooltipContent>
    </Tooltip>
  );
}

function CanvasFlowInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AiChatNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { screenToFlowPosition, getNodes, getEdges, getViewport, fitView, setViewport, zoomIn, zoomOut } = useReactFlow();
  const rfStoreApi = useStoreApi();
  const nodeIdCounter = useRef(0);
  // 画布 wrapper 引用：用于 setCenter 手动计算真实视口中心（消除侧边栏/预览面板挤压导致的 636px 偏差）
  // 需在 graphGateway 之前声明，保证 gateway 闭包内能访问到（useRef 对象引用稳定，读取 .current 始终取最新值）
  const wrapperRef = useRef<HTMLDivElement>(null);
  // 侧边栏当前宽度 ref：供 graphGateway 内部 fitBounds/setCenter 实时读取，
  // 修正 sidebar overlay 导致的居中偏移（展开 322px / 折叠 50px）
  const sidebarWidthRef = useRef(0); // 2026-09 布局重构：旧悬浮侧栏宽度占位已无效，左列常驻不参与画布宽度计算
  // 画布真实可视宽度：wrapper 全窗宽 − 侧边栏 overlay − 右侧预览面板/本地文件面板 overlay。
  // 面板折叠（display:none 或未挂载）时宽度按 0 计。setCenter/fitBounds 居中与 ChatNode 展开
  // 宽度上限共用，避免展开节点被右侧宽屏面板遮挡（14" 屏 + 宽面板场景）
  const computeVisibleCanvasWidth = useCallback(() => {
    // 2026-09 布局重构：右 dock 为并列列（不在 wrapper 内），wrapper 宽度即对话可视宽度
    const pw = wrapperRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1200);
    const sw = sidebarWidthRef.current;
    return Math.max(pw - sw, 0);
  }, []);
  // 画布缩放锁定（默认开启）：锁定时 zoom 固定 100%，禁用滚轮/pinch 缩放与自动 fitView。
  // 由 NodeMap 的锁定按钮通过 canvas-zoom-lock 事件控制。锁定是最高优先级——
  // 即使新建节点也不允许改变画布比例。
  const [zoomLocked] = useState(true);

  // 执行中的节点 id 集合（AiChatNode 流式执行中/结束广播 node-executing 事件）
  const [executingNodeIds, setExecutingNodeIds] = useState<Set<string>>(new Set());
  // 执行完毕后未读的节点 id 集合（左侧会话/任务树绿点实心，点击查看后清除）
  const [unreadDoneIds, setUnreadDoneIds] = useState<Set<string>>(new Set());
  // 当前聚焦(正在查看)节点 id 的 ref：node-executing 监听器依赖为空闭包拿不到最新 state，改用 ref 读取
  const focusedNodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    const onExecuting = (e: Event) => {
      const d = (e as CustomEvent<{ node_id?: string; executing?: boolean; unmount?: boolean }>).detail;
      const nodeId = d?.node_id;
      if (!nodeId) return;
      // unmount=true 是节点隐藏/卸载（单焦点切换走）时的清理广播，而非真实任务结束：
      // 只清呼吸灯，不点亮未读绿点，避免"切换到别的会话后绿点又恢复"。
      const isUnmountCleanup = d.unmount === true;
      setExecutingNodeIds((prev) => {
        const next = new Set(prev);
        if (d.executing) next.add(nodeId);
        else next.delete(nodeId);
        return next;
      });
      setUnreadDoneIds((prev) => {
        const next = new Set(prev);
        if (d.executing) {
          // 任务重新开始执行，清除该节点已完成未读标记
          next.delete(nodeId);
        } else if (isUnmountCleanup) {
          // 卸载清理：不计入未读，保留当前未读状态不变
          return prev;
        } else if (focusedNodeIdRef.current === nodeId) {
          // 任务执行完毕且该会话正被查看(已读)：不点亮未读绿点
          next.delete(nodeId);
        } else {
          // 任务执行完毕：标记为未读绿点（实心），点击查看后清除
          next.add(nodeId);
        }
        return next.size === prev.size ? prev : next;
      });
    };
    window.addEventListener('node-executing', onExecuting);
    return () => window.removeEventListener('node-executing', onExecuting);
  }, []);

  // 左侧会话/任务树圆点状态：running=执行中(呼吸灯) / done=未读实心 / idle=普通
  const railDotState = useCallback(
    (nodeId: string): 'running' | 'done' | 'idle' => {
      if (executingNodeIds.has(nodeId)) return 'running';
      if (unreadDoneIds.has(nodeId)) return 'done';
      return 'idle';
    },
    [executingNodeIds, unreadDoneIds],
  );

  // 执行中节点相连的边标记 data.executing → FloatingEdge 渲染"输送电流"效果
  useEffect(() => {
    setEdges((eds) => {
      let changed = false;
      const next = eds.map((e) => {
        const running = executingNodeIds.has(e.source ?? '') || executingNodeIds.has(e.target ?? '');
        const cur = (e.data as { executing?: boolean } | undefined)?.executing === true;
        if (running === cur) return e;
        changed = true;
        if (running) return { ...e, data: { ...(e.data ?? {}), executing: true } };
        const rest = { ...(e.data ?? {}) } as { executing?: boolean };
        delete rest.executing;
        return { ...e, data: rest };
      });
      return changed ? next : eds;
    });
  }, [executingNodeIds, setEdges]);

  // GraphGateway：NodeMap 等附属视图访问画布的"统一对接端口"（太空舱理念）。
  //  - 数据源读 ReactFlow store（与 useNodes/useViewport 同源，引用级比较触发通知）；
  //  - 命令：写本地 nodes state（与画布拖拽/NodeMap Fit 持久化行为一致）+ 视口 + window 事件总线；
  //  - 快照固定 400×400 占位尺寸，不随节点展开/折叠变化，避免缩略图圆点跳动（fit 漂移根因）。
  const graphGateway = useMemo<GraphGateway>(() => {
    let dirty = true;
    let cached: GraphSnapshot | null = null;
    // 断开/重连续线：本地 setEdges 即时生效（NodeMap 与画布同步变色），
    // 再落库 /api/edges（delete 软删含下游 markStale，reconnect 仅恢复）——与 FloatingEdge 拖断同构
    const setEdgeDisconnected = (edgeId: string, disconnected: boolean) => {
      setEdges((eds) =>
        eds.map((ed) => (ed.id === edgeId ? { ...ed, data: { ...ed.data, disconnected } } : ed)),
      );
      fetch('/api/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(disconnected ? { action: 'delete', edge_id: edgeId } : { action: 'reconnect', edge_id: edgeId }),
      }).catch((err) => console.error('Edge connectivity update error:', err));
    };
    const compute = (): GraphSnapshot => {
      const rfNodes = getNodes();
      const rfEdges = getEdges();
      const vp = getViewport();
      return {
        nodes: rfNodes.map((n) => ({
          id: n.id,
          title: (n.data as { title?: string } | undefined)?.title || n.id.slice(0, 8),
          x: n.position.x,
          y: n.position.y,
          width: 400,
          height: 400,
          measuredHeight: n.measured?.height,
          measuredWidth: n.measured?.width,
          type: (n.type as FlowAiNodeType | 'imageGen') || 'aiChat',
          sandboxAppId: (n.data as { sandboxAppId?: string } | undefined)?.sandboxAppId,
          messageCount: ((n.data as { messages?: unknown[] } | undefined)?.messages?.length) || 0,
        })),
        edges: rfEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          disconnected: Boolean((e.data as { disconnected?: boolean } | undefined)?.disconnected),
        })),
        viewport: { x: vp.x, y: vp.y, zoom: vp.zoom },
      };
    };
    return {
      /** 应用视口：统一走 panZoom（d3 实例）同步。
       *  直接 rfStoreApi.setState({ transform }) 会绕过 d3 实例，导致其内部 transform 滞后，
       *  用户首次手动拖动/滚动平移时画布以旧 transform 为基点突然跳动。panZoom 未就绪时降级 setState。 */
      applyTransform: (x: number, y: number, z: number) => {
        const { panZoom } = rfStoreApi.getState();
        if (panZoom) {
          void panZoom.setViewport({ x, y, zoom: z }, { duration: 0 });
        } else {
          rfStoreApi.setState({ transform: [x, y, z] });
        }
      },
      subscribe: (listener) => {
        dirty = true;
        return rfStoreApi.subscribe((state, prevState) => {
          // 仅当画布数据（节点/边/视口 transform）引用变化时才通知，避免无关 store 更新触发重渲染
          if (state.nodes !== prevState.nodes || state.edges !== prevState.edges || state.transform !== prevState.transform) {
            dirty = true;
            listener();
          }
        });
      },
      getSnapshot: () => {
        if (dirty || !cached) {
          cached = compute();
          dirty = false;
        }
        return cached;
      },
      setViewport: (vp) => {
        const { panZoom } = rfStoreApi.getState();
        if (panZoom) {
          void panZoom.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }, { duration: 0 });
        } else {
          rfStoreApi.setState({ transform: [vp.x, vp.y, vp.zoom] });
        }
      },
      getViewport: () => getViewport(),
      fitView: (opts) => fitAllNodesWithSidebar(opts),
      fitBounds: (bounds, opts) => {
        // 手动按 wrapperRef 真实可视区计算：扣除侧边栏与右侧面板 overlay（absolute overlay 遮挡）
        const ph = wrapperRef.current?.clientHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 800);
        const sw = sidebarWidthRef.current;
        const availableW = computeVisibleCanvasWidth();
        const padding = typeof opts?.padding === 'number' ? opts.padding : 0;
        const state = rfStoreApi.getState();
        const minZoom = state.minZoom ?? 0.1;
        const maxZoom = Math.min(
          typeof opts?.maxZoom === 'number' ? opts.maxZoom : Infinity,
          state.maxZoom ?? 2,
        );
        const bW = Math.max(bounds.width, 1);
        const bH = Math.max(bounds.height, 1);
        const scaleX = availableW / (bW * (1 + padding * 2));
        const scaleY = ph / (bH * (1 + padding * 2));
        const zoom = Math.max(minZoom, Math.min(maxZoom, Math.min(scaleX, scaleY)));
        const cx = bounds.x + bW / 2;
        const cy = bounds.y + bH / 2;
        const { panZoom } = rfStoreApi.getState();
        if (panZoom) {
          void panZoom.setViewport({ x: sw + availableW / 2 - cx * zoom, y: ph / 2 - cy * zoom, zoom }, { duration: 0 });
        } else {
          rfStoreApi.setState({ transform: [sw + availableW / 2 - cx * zoom, ph / 2 - cy * zoom, zoom] });
        }
      },
      setCenter: (x, y, opts) => {
        // 手动按 wrapperRef 可视区像素中心计算：扣除侧边栏与右侧面板 overlay 后居中
        const vp = getViewport();
        const z = typeof opts?.zoom === 'number' ? opts.zoom : vp.zoom;
        const ph = wrapperRef.current?.clientHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 800);
        const sw = sidebarWidthRef.current;
        const availableW = computeVisibleCanvasWidth();
        const { panZoom } = rfStoreApi.getState();
        if (panZoom) {
          void panZoom.setViewport({ x: sw + availableW / 2 - x * z, y: ph / 2 - y * z, zoom: z }, { duration: 0 });
        } else {
          rfStoreApi.setState({ transform: [sw + availableW / 2 - x * z, ph / 2 - y * z, z] });
        }
      },
      zoomBy: (delta, opts) => (delta > 0 ? zoomIn(opts) : zoomOut(opts)),
      setNodePositions: (positions) => {
        setNodes((nds) =>
          nds.map((n) => {
            const p = positions[n.id];
            return p ? { ...n, position: p } : n;
          })
        );
        // 排版不经过拖拽事件，需显式通知画布持久化到 .md frontmatter
        window.dispatchEvent(new CustomEvent('nodes-position-changed', { detail: { positions } }));
      },
      setNodeSelected: (nodeId) => {
        setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })));
      },
      getSelectedNode: () => rfStoreApi.getState().nodes.find((n) => n.selected)?.id ?? null,
      expandNode: (nodeId) => window.dispatchEvent(new CustomEvent('node-expand-request', { detail: { node_id: nodeId } })),
      disconnectEdge: (edgeId) => setEdgeDisconnected(edgeId, true),
      reconnectEdge: (edgeId) => setEdgeDisconnected(edgeId, false),
      onNodeEvent: (handler) => {
        // node-collapsed 桥接已随恒展开收敛移除（ChatNodeKernel 不再广播 node-collapsed）
        const onExecuting = (e: Event) => {
          const d = (e as CustomEvent<{ node_id?: string; executing?: boolean }>).detail;
          if (d?.node_id) handler({ type: 'node-executing', nodeId: d.node_id, executing: !!d.executing });
        };
        window.addEventListener('node-executing', onExecuting);
        return () => {
          window.removeEventListener('node-executing', onExecuting);
        };
      },
    };
  }, [rfStoreApi, getNodes, getEdges, getViewport, setViewport, fitView, zoomIn, zoomOut, setNodes, setEdges, computeVisibleCanvasWidth]);

  // ---- 画布链导航圆点：订阅快照 → 分链 → 点击圆点居中对应链 ----
  // 水平居中以 wrapperRef 真实可视区为基准：wrapper 是 Sidebar 的 flex 兄弟，
  // clientWidth 已实时扣除侧边栏宽度（展开 312px / 折叠 40px rail），
  // 因此 gateway.setCenter / fitBounds 的水平中心天然对齐"侧边栏右缘之后"的可视区中央，
  // 侧边栏展开/收缩无需额外处理。
  const graphSnap = useSyncExternalStore(
    graphGateway.subscribe,
    graphGateway.getSnapshot,
    graphGateway.getSnapshot,
  );
  const canvasChains = useMemo(
    () => buildChains(graphSnap.nodes, graphSnap.edges),
    [graphSnap.nodes, graphSnap.edges],
  );
  // ———— 单焦点画布（2026-09）：桌面同一时刻只打开一个研究节点，其余研究节点归左侧节点圆点。
  //  focusedNodeId = 当前打开节点；annotation/imageGen 等豁免常驻；Todo 已上收为会话标题栏
  //  Dock（StickyTodoDock，见 ChatNodeKernel 成果块旁），不再占用画布。————
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  // 同步当前聚焦节点到 ref，供依赖为空的 node-executing 监听器判断"是否正在查看"
  useEffect(() => {
    focusedNodeIdRef.current = focusedNodeId;
  }, [focusedNodeId]);
  // 单焦点渲染派生：非激活研究节点置 hidden（保留在 store 供 NodeMap/链/关系消费，但画布不渲染）；
  // 豁免类型不动。
  const displayNodes = useMemo(() => {
    if (!focusedNodeId) return nodes;
    let changed = false;
    const next = nodes.map((n) => {
      const research = isFocusableResearch(n.type);
      // 豁免类型（annotation/imageGen 等）原样保留；研究节点由焦点决定显示/隐藏
      if (!research) return n;
      const shouldHide = n.id !== focusedNodeId;
      if (shouldHide === Boolean(n.hidden)) return n;
      changed = true;
      return shouldHide ? { ...n, hidden: true } : { ...n, hidden: false };
    });
    return changed ? next : nodes;
  }, [nodes, focusedNodeId]);
  // 单焦点切换：把 nodeId 设为当前打开的研究节点。
  //  其余非激活研究节点由 displayNodes 派生隐藏；目标节点取消隐藏、选中并展开居中。
  const switchFocusNode = useCallback((nodeId: string) => {
    const snap = graphGateway.getSnapshot();
    const target = snap.nodes.find((n) => n.id === nodeId);
    if (!target) return;
    // 点击查看该节点后清除"已完成未读"绿点标记
    setUnreadDoneIds((prev) => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
    setFocusedNodeId(nodeId);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? { ...n, selected: true, hidden: false }
          : { ...n, selected: false },
      ),
    );
    graphGateway.setCenter(target.x + 200, target.y + 200);
    // 展开目标（带内容节点挂载即大阅读面板；内核随后 canvas-center-request 精确居中）
    window.dispatchEvent(new CustomEvent('node-expand-request', { detail: { node_id: nodeId } }));
    // 窄容器（左栏 + 右 dock）下固定偏移会让宽/高卡片偏出视口被裁切：
    // 挂载测宽测高后按真实渲染尺寸补一次精确居中
    window.setTimeout(() => {
      const el = wrapperRef.current?.querySelector<HTMLElement>('.react-flow__node');
      const rect = el ? el.getBoundingClientRect() : null;
      const w = rect ? rect.width : 792;
      const h = rect ? rect.height : 400;
      graphGateway.setCenter(target.x + w / 2, target.y + h / 2);
    }, 180);
  }, [graphGateway, setNodes]);

  // 新建研究节点后立即打开（传统 Agent "New Chat"语义）。
  // 节点刚写入受控 state，RF store 同步可能晚于首帧 → 轮询等待节点进入快照后切换焦点；
  // 空节点经 expand-request 进入全宽输入态。
  const openNewlyCreatedNode = useCallback((nodeId: string) => {
    let tries = 0;
    const attempt = () => {
      tries += 1;
      const snap = graphGateway.getSnapshot();
      if (!snap.nodes.some((n) => n.id === nodeId)) {
        if (tries <= 6) window.setTimeout(attempt, 120);
        return;
      }
      switchFocusNode(nodeId);
    };
    requestAnimationFrame(attempt);
  }, [graphGateway, switchFocusNode]);

  // 桌面单焦点自动打开/回退：数据就绪打开第一个可用研究节点；
  // 当前焦点被删除后回退到下一个可用研究节点。
  const autoOpenNextRef = useRef(false);
  useEffect(() => {
    const snap = graphGateway.getSnapshot();
    if (focusedNodeId) {
      const cur = snap.nodes.find(
        (n) => n.id === focusedNodeId && isFocusableResearch(n.type),
      );
      if (cur) return;
    }
    const first = snap.nodes.find((n) => isFocusableResearch(n.type));
    const nextId = first?.id ?? null;
    if (nextId === focusedNodeId) return;
    if (!nextId) {
      setFocusedNodeId(null);
      return;
    }
    if (autoOpenNextRef.current) {
      switchFocusNode(nextId);
      return;
    }
    autoOpenNextRef.current = true;
    // 首次：直接置焦点，渲染派生生效后居中并请求展开
    setFocusedNodeId(nextId);
    requestAnimationFrame(() => {
      graphGateway.setCenter(first!.x + 200, first!.y + 200);
      window.dispatchEvent(new CustomEvent('node-expand-request', { detail: { node_id: nextId } }));
    });
  }, [graphGateway, focusedNodeId, nodes, switchFocusNode]);

  // 外部统一"打开某研究节点"入口：NodeMap 卡片点击等 → 单焦点切换
  useEffect(() => {
    const onFocus = (e: Event) => {
      const d = (e as CustomEvent<{ nodeId?: string }>).detail;
      if (!d?.nodeId) return;
      const snap = graphGateway.getSnapshot();
      const n = snap.nodes.find((nd) => nd.id === d.nodeId);
      if (!n || !isFocusableResearch(n.type)) return;
      switchFocusNode(d.nodeId);
    };
    window.addEventListener('canvas-focus-node', onFocus);
    return () => window.removeEventListener('canvas-focus-node', onFocus);
  }, [graphGateway, switchFocusNode]);

  // 单焦点左侧节点圆点列数据：研究节点按链顺序分组展平；未入链的独立研究节点排尾组。
  // 不再隐藏空会话（messageCount=0）节点——即使尚未执行任务也保留在侧边栏。
  const focusRail = useMemo(() => {
    type Dot = { id: string; title: string; isNote: boolean; sandboxAppId?: string; identity?: string };
    const groups: Array<{ key: string; dots: Dot[] }> = [];
    const seen = new Set<string>();
    for (const chain of canvasChains) {
      const items = chain.ids
        .map((id) => graphSnap.nodes.find((n) => n.id === id))
        .filter((n): n is NonNullable<(typeof graphSnap.nodes)[number]> => !!n && isFocusableResearch(n.type));
      if (items.length === 0) continue;
      const dots: Dot[] = items.map((n) => ({
        id: n.id,
        title: n.title,
        isNote: n.type === 'agent-note',
        sandboxAppId: n.sandboxAppId,
        identity: agentIdentityFromNodeType(n.type),
      }));
      for (const d of dots) seen.add(d.id);
      groups.push({ key: chain.rootId, dots });
    }
    const strayDots = graphSnap.nodes
      .filter((n) => isFocusableResearch(n.type) && !seen.has(n.id))
      .map((n): Dot => ({
        id: n.id,
        title: n.title,
        isNote: n.type === 'agent-note',
        sandboxAppId: n.sandboxAppId,
        identity: agentIdentityFromNodeType(n.type),
      }));
    if (strayDots.length > 0) groups.push({ key: '__strays__', dots: strayDots });
    return groups;
  }, [canvasChains, graphSnap.nodes]);

  // 替代原生 fitView：先算全部节点 bounds，再走 graphGateway.fitBounds（含侧边栏偏移修正）
  const fitAllNodesWithSidebar = useCallback((opts?: { padding?: number; maxZoom?: number; duration?: number }) => {
    const nodes = getNodes();
    if (nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const w = n.measured?.width ?? 400;
      const h = n.measured?.height ?? 400;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    if (!isFinite(minX)) return;
    graphGateway.fitBounds(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      opts,
    );
  }, [getNodes, graphGateway]);

  // AiChatNode 展开/聚焦居中：原生 setCenter 受 Sidebar/预览面板挤压布局影响有偏移，
  // 统一桥接到 graphGateway.setCenter（基于 wrapperRef 真实可视区手动计算），保证节点居中。
  // 可视区过窄（宽屏预览面板严重挤占）时先自动折叠面板让出空间，再按新可视区居中，避免节点被遮挡
  useEffect(() => {
    const onCenterRequest = (e: Event) => {
      const d = (e as CustomEvent<{ x?: number; y?: number; zoom?: number; duration?: number }>).detail;
      if (typeof d?.x !== 'number' || typeof d?.y !== 'number') return;
      const x = d.x;
      const y = d.y;
      const vis = computeVisibleCanvasWidth();
      const willCollapse = vis < MIN_EXPAND_VISIBLE_W;
      if (willCollapse) setPanelCollapsed(true);
      const center = () => graphGateway.setCenter(x, y, { zoom: d.zoom, duration: d.duration });
      if (willCollapse) requestAnimationFrame(center); // 等面板折叠（display:none → 宽 0）DOM 生效后再居中
      else center();
    };
    window.addEventListener('canvas-center-request', onCenterRequest);
    return () => window.removeEventListener('canvas-center-request', onCenterRequest);
  }, [graphGateway, computeVisibleCanvasWidth]);

  // 应用内置确认弹窗（macOS 风格英文文案）
  const { ask: confirmAsk, render: confirmRender } = useConfirm();

  // 锁定上游节点：校验未通过时由用户自主决定是否强制锁定（确认后跳过校验继续建边）
  const lockUpstreamNode = useCallback(async (srcMdId: string): Promise<{ ok: boolean; error?: string }> => {
    // R-7 动态上限：按源节点当前模型 contextWindow × 10% 计算 max_length（后端未传时兜底 OUTCOME_MAX_LENGTH）
    const srcModelId = nodes.find((n) => n.id === srcMdId)?.data.modelId || '';
    const maxLen = outcomeMaxLengthForModel(srcModelId);
    const doLock = (force?: boolean) =>
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'lock', node_id: srcMdId, max_length: maxLen, ...(force ? { force: true } : {}) }),
      }).then((r) => r.json());
    const d = await doLock();
    if (d.success) {
      // 锁定成功：广播刷新事件，让目标节点（ChatNodeKernel）重新拉取 outcome_status，锁图标立即更新
      window.dispatchEvent(new CustomEvent('node-outcome-refresh', { detail: { node_id: srcMdId } }));
      return { ok: true };
    }
    // 校验类失败（带规则清单）才提供强制锁定；其他错误（缺成果块等）直接返回
    if (!d.errors?.length && !String(d.error || '').includes('校验')) {
      return { ok: false, error: d.error || '锁定失败' };
    }
    const force = await confirmAsk({
      title: '成果块校验未通过',
      message: `${d.error || ''}\n\n是否仍要强制锁定该节点并继续？（强制锁定后成果块未通过质量校验，下游引用请自行确认）`,
      confirmLabel: '强制锁定',
      cancelLabel: '取消',
    });
    if (!force) return { ok: false, error: '用户取消锁定' };
    const rd = await doLock(true);
    if (!rd.success) return { ok: false, error: rd.error || '强制锁定失败' };
    window.dispatchEvent(new CustomEvent('node-outcome-refresh', { detail: { node_id: srcMdId } }));
    return { ok: true };
  }, [confirmAsk, nodes]);
  const lastActiveNodeIdRef = useRef<string | null>(null); // 当前活跃节点，用于全局文字选择
  const [flowKey] = useState(0); // 强制 ReactFlow 重新挂载的 key，修复长时间空闲后 store 失活
  const savedViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  // 用户是否已对画布产生过手动交互（pan/缩放/拖节点）。初始 fit 前若已交互则跳过，
  // 避免"打开时 fetch 完成较晚 → fit 在用户滑动后才执行 → 节点突然跳到画布中央"的竞态。
  const userInteractedRef = useRef(false);
  // 视口按项目隔离持久化：key = bobwork-viewport:{projectId}（无项目时用全局 key）。
  // 切换项目/重启后不再复用其他项目的 pan/zoom，避免节点坐标未变但"画布位置错乱"的漂移。
  const viewportStorageKey = useCallback((projectId: string) => {
    return projectId ? `bobwork-viewport:${projectId}` : 'bobwork-viewport';
  }, []);
  // 读取某项目保存的视口：优先项目级 key。
  // 兼容旧版本全局 key：仅当项目级 key 缺失且存在全局 key 时一次性迁移到当前项目并消费，
  // 避免旧全局视口污染之后新建的项目（否则新项目默认节点会被套到旧 pan 位置，不在画布中间）。
  const readSavedViewport = useCallback((projectId: string) => {
    try {
      const scoped = localStorage.getItem(viewportStorageKey(projectId));
      if (scoped) return JSON.parse(scoped) as { x: number; y: number; zoom: number };
      const legacy = localStorage.getItem('bobwork-viewport');
      if (legacy && projectId) {
        localStorage.setItem(viewportStorageKey(projectId), legacy);
        localStorage.removeItem('bobwork-viewport');
        return JSON.parse(legacy) as { x: number; y: number; zoom: number };
      }
      return null;
    } catch {
      return null;
    }
  }, [viewportStorageKey]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 设置弹窗打开时聚焦的区块（由 open-settings 事件指定，如节点模型菜单 → 'chat'）
  const [settingsSection, setSettingsSection] = useState<'chat' | 'roles' | 'icons' | 'theme' | 'diagram' | undefined>(undefined);
  // 项目看板（画布大视图）：Workspace 标题看板按钮打开，总览所有项目
  const [projectBoardOpen, setProjectBoardOpen] = useState(false);
  // 项目看板快捷键：⌘G 打开，再次 ⌘G 关闭
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.key.toLowerCase() !== 'g') return;
      e.preventDefault();
      setProjectBoardOpen((v) => !v);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // ⌘F / Ctrl+F 统一面板：文件搜索（BobWork 项目按名称 + BobWorkspace 各项目 homework/materials/attachments 子目录）+ WANTED 指令输入。
  // ⌘F 专属全局搜索：contenteditable 编辑器不再让行（编辑器内查找替换已改用 ⌘⇧F，见 DocEditor）；文本输入框与专业编辑器仍让行。
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      const target = e.target;
      // 文本输入框内不抢占（全局搜索面板自身输入框等）；专业编辑器（monaco/code-mirror/docx 等）保留各自内置查找
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.closest('.monaco-editor, .cm-editor, .docx, [data-editor]')) return;
      }
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  // Bob-Mind 插件全屏面板壳（⌘F Bob-Mind 按钮派发 open-bob-mind-panel）
  const [bobMindOpen, setBobMindOpen] = useState(false);
  // Bob Sandbox 全屏管理页（小程序商城）开关
  const [storeOpen, setStoreOpen] = useState(false);
  // Agent Teams 全屏面板开关（侧边栏入口派发 team-panel-open 事件打开）
  const [teamsFullscreenOpen, setTeamsFullscreenOpen] = useState(false);
  // 模型用量统计面板（图标栏/调色板入口派发 usage-panel-open 事件打开）
  const [usageOpen, setUsageOpen] = useState(false);
  // 统一悬浮面板
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // ImageAiEditor keep-alive：生成中/结果待查看时，折叠面板也保持内部挂载不中断
  const [aiEditKeepAlive, setAiEditKeepAlive] = useState<boolean>(() => isImageAiEditKeepAlive());
  useEffect(() => onImageAiEditStateChange(() => setAiEditKeepAlive(isImageAiEditKeepAlive())), []);
  // 预览面板宽度（px）：可在 [PANEL_W_MIN, 可用上限] 之间自由拖拽缩放；持久化到 localStorage
  const [panelWidth, setPanelWidthRaw] = useState<number>(() => {
    if (typeof window === 'undefined') return PANEL_W_DEFAULT;
    try {
      const stored = Number(window.localStorage.getItem(PANEL_W_PERSIST_KEY));
      if (Number.isFinite(stored) && stored > 0) {
        return Math.min(Math.max(stored, PANEL_W_MIN), PANEL_W_ABS_MAX);
      }
    } catch { /* ignore */ }
    return PANEL_W_DEFAULT;
  });
  // 便捷档位图标判定：宽度 ≥ 宽窄两档中值视为"宽屏"（用于宽窄切换按钮的图形/文案）
  const panelWide = panelWidth >= (PANEL_W_PRESET_NARROW + PANEL_W_PRESET_WIDE) / 2;

  // 本地文件夹面板：默认折叠（隐藏侧栏列表，让出画布空间）。
  // localStorage: bobwork.ui.localExplorer.collapsed
  //   • 从未设置（null）→ 默认 true（折叠）
  //   • 用户显式展开/收起后，写入并永久记住其选择
  const LOCAL_EXPLORER_COLLAPSED_KEY = 'bobwork.ui.localExplorer.collapsed';
  const [localExplorerCollapsed, setLocalExplorerCollapsedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true; // SSR 保护
    try {
      const raw = window.localStorage.getItem(LOCAL_EXPLORER_COLLAPSED_KEY);
      if (raw == null) return true; // 首次打开：默认折叠
      return raw === 'true';
    } catch {
      return true;
    }
  });
  const setLocalExplorerCollapsed = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setLocalExplorerCollapsedState((prev) => {
      const value = typeof next === 'function' ? (next as (p: boolean) => boolean)(prev) : next;
      try { window.localStorage.setItem(LOCAL_EXPLORER_COLLAPSED_KEY, String(value)); } catch { /* ignore */ }
      return value;
    });
  }, []);
  // 本地文件面板 Pin 固定：true 时鼠标移出不自动折叠（不持久化，重启后回到临时展开）
  const [localExplorerPinned, setLocalExplorerPinned] = useState(false);
  const toggleLocalExplorerPinned = useCallback(() => {
    setLocalExplorerPinned((v) => !v);
  }, []);

  // 聚焦会话重新居中：按节点真实渲染宽高把中心对准 wrapper 中心。
  // 宽度/高度变化或切换会话后必须用它（固定 +200 猜测偏移会让宽高卡片偏出容器被裁切）
  const centerFocusedNode = useCallback(() => {
    const f = graphSnap.nodes.find((n) => n.id === focusedNodeId);
    if (!f) return;
    const el = wrapperRef.current?.querySelector<HTMLElement>('.react-flow__node');
    const rect = el ? el.getBoundingClientRect() : null;
    const w = rect ? rect.width : 792;
    const h = rect ? rect.height : 400;
    graphGateway.setCenter(f.x + w / 2, f.y + h / 2);
  }, [graphSnap.nodes, focusedNodeId, graphGateway]);

  // wrapper 尺寸变化（右 dock 开合 / 左栏折叠过渡 / 窗口缩放）或焦点切换后，
  // 等节点尺寸随 canvas-visible-width 收敛再重新居中，避免对话卡片偏出容器被裁切
  useEffect(() => {
    const target = wrapperRef.current;
    if (!target) return;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(centerFocusedNode, 260);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(target);
    window.addEventListener('resize', schedule);
    schedule(); // 挂载/焦点变化后补一次（首次打开、切换会话时 wrapper 尺寸不变，观察者不触发）
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
      window.removeEventListener('resize', schedule);
    };
  }, [centerFocusedNode, focusedNodeId]);

  // 画布可视宽度广播：预览面板/本地文件面板/窗口尺寸变化 → dispatch canvas-visible-width，
  // ChatNode 等订阅者据此实时调整展开宽度上限（避免展开节点被右侧宽屏面板遮挡）。
  // 面板折叠/宽窄切换/本地面板挂载状态变化时重跑（ResizeObserver 需重挂到最新的元素上）；
  // 依赖 focusedNodeId：单焦点切换后新挂载节点需要立刻拿到当前面板宽度（否则新节点
  // 收不到已发生的广播 → 不按已打开面板收窄）。
  useEffect(() => {
    const broadcast = () => {
      window.dispatchEvent(new CustomEvent('canvas-visible-width', { detail: { width: computeVisibleCanvasWidth() } }));
    };
    broadcast();
    // 观察对话容器（wrapper）尺寸：右 dock 折叠/展开会改变 wrapper 宽度
    const ro = new ResizeObserver(broadcast);
    const target = wrapperRef.current;
    if (target) ro.observe(target);
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(broadcast);
    };
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [computeVisibleCanvasWidth, panelCollapsed, panelWidth, localExplorerCollapsed, focusedNodeId]);
  // 侧边栏折叠状态：折叠时 Sidebar 渲染 56px rail（悬浮 overlay），NodeMap 依据该状态左移避开面板
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 左列导航折叠状态（2026-09 布局重构）：折叠为窄图标轨，中栏自动占满；状态持久化
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('bobwork.nav-collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('bobwork.nav-collapsed', navCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [navCollapsed]);

  // —— 预览面板自由缩放（拖拽 + 动态收敛）——
  // 监听窗口宽度：面板可用上限随窗口/左栏/文件面板实时变化
  const [windowWidth, setWindowWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200));
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 面板可用上限：窗口宽 − 左栏 − 文件面板 − 对话最小保留。
  // 不足最小面板宽时按最小取（保证小窗口下面板仍能打开，对话区被 min-w-0 自然压缩）。
  // 窄屏（低于首个级联收起断点）时把对话区保留从 200 提升到画布舒适 480，
  // 让 clamp 自动把预览面板压小，配合级联收起确保画布不被挤到不可用
  const maxPanelWidth = useMemo(() => {
    if (typeof window === 'undefined') return PANEL_W_ABS_MAX;
    const navW = navCollapsed ? NAV_W_COLLAPSED : NAV_W_EXPANDED;
    const explorerW = localExplorerCollapsed ? 0 : EXPLORER_W_OPEN;
    const reserve = windowWidth < NARROW_W_NAV ? NARROW_COMFORT_CANVAS : PANEL_CONVERSATION_MIN;
    const avail = windowWidth - navW - explorerW - reserve;
    return Math.min(Math.max(avail, PANEL_W_MIN), PANEL_W_ABS_MAX);
  }, [windowWidth, navCollapsed, localExplorerCollapsed]);

  // 把任意宽度收敛到 [PANEL_W_MIN, 可用上限]
  const clampPanelWidth = useCallback(
    (w: number) => Math.min(Math.max(w, PANEL_W_MIN), Math.max(maxPanelWidth, PANEL_W_MIN)),
    [maxPanelWidth],
  );

  const persistPanelWidth = useCallback((w: number) => {
    try { window.localStorage.setItem(PANEL_W_PERSIST_KEY, String(w)); } catch { /* ignore */ }
  }, []);

  // 实时更新面板宽度（拖拽/切档用，不在此处持久化；抬起或点击时再 write）
  const setPanelWidthLive = useCallback((w: number) => {
    setPanelWidthRaw((prev) => clampPanelWidth(w));
  }, [clampPanelWidth]);

  // 宽窄快捷档位：点击时在窄/宽两档间切换（仍受可用上限收敛）
  const togglePanelWide = useCallback(() => {
    const target = panelWide ? PANEL_W_PRESET_NARROW : PANEL_W_PRESET_WIDE;
    const next = clampPanelWidth(target);
    setPanelWidthLive(next);
    persistPanelWidth(next);
  }, [panelWide, setPanelWidthLive, clampPanelWidth, persistPanelWidth]);

  // 窗口尺寸/左栏/文件面板变化时，把面板宽度收敛到当前可用上限（防止溢出被裁切）
  useEffect(() => {
    setPanelWidthRaw((w) => {
      const next = clampPanelWidth(w);
      return next === w ? w : next;
    });
  }, [clampPanelWidth]);

  // —— 窄屏自适应：窗口过窄时按优先级级联收起（左栏 → 本地文件 → 预览），拉宽后恢复 ——
  // prevNarrowW 记录上次各断点是否越界，只在“越过断点”瞬间动作，避免与用户手动开关打架；
  // autoCollapsed* 标记“是本逻辑自动收起的”，恢复仅针对自动行为，不打扰用户主动关闭的面板
  const prevNarrowW = useRef({ explorer: false, panel: false, nav: false });
  const autoCollapsedExplorer = useRef(false);
  const autoCollapsedPanel = useRef(false);
  const autoCollapsedNav = useRef(false);
  useEffect(() => {
    const now = {
      explorer: windowWidth < NARROW_W_EXPLORER,
      panel: windowWidth < NARROW_W_PANEL,
      nav: windowWidth < NARROW_W_NAV,
    };
    const prev = prevNarrowW.current;
    prevNarrowW.current = now;

    // 收紧：首次越过断点 → 自动收起对应面板（本地文件面板尊重 pin，用户固定时不强收）
    if (!prev.explorer && now.explorer && !localExplorerCollapsed && !localExplorerPinned) {
      autoCollapsedExplorer.current = true;
      setLocalExplorerCollapsed(true);
    }
    if (!prev.panel && now.panel && !panelCollapsed) {
      autoCollapsedPanel.current = true;
      setImageAiEditHidden(true);
      setPanelCollapsed(true);
    }
    if (!prev.nav && now.nav && !navCollapsed) {
      autoCollapsedNav.current = true;
      setNavCollapsed(true);
    }

    // 放宽：拉宽越过断点 → 恢复本逻辑自动收起的面板（逆序：高优先级面板先恢复）
    if (prev.explorer && !now.explorer && autoCollapsedExplorer.current) {
      autoCollapsedExplorer.current = false;
      setLocalExplorerCollapsed(false);
    }
    if (prev.panel && !now.panel && autoCollapsedPanel.current) {
      autoCollapsedPanel.current = false;
      setImageAiEditHidden(false);
      setImageAiEditKeepAlive(false);
      setPanelCollapsed(false);
    }
    if (prev.nav && !now.nav && autoCollapsedNav.current) {
      autoCollapsedNav.current = false;
      setNavCollapsed(false);
    }
  }, [windowWidth, localExplorerCollapsed, localExplorerPinned, panelCollapsed, navCollapsed]);

  // 打开预览面板（面板从折叠→展开）时自动折叠左栏，为中间对话区让出空间；
  // 用上一次 panelCollapsed 判断"打开"这个动作，避免面板默认展开时初始加载就折叠左栏
  const prevPanelCollapsedRef = useRef(panelCollapsed);
  useEffect(() => {
    const wasCollapsed = prevPanelCollapsedRef.current;
    prevPanelCollapsedRef.current = panelCollapsed;
    if (wasCollapsed && !panelCollapsed) {
      setNavCollapsed(true);
      // 折叠切换后中栏宽度变化：广播可视宽度（内核据此调整展开宽度上限），
      // 再等宽度过渡完成后重新居中（宽度收敛后按真实渲染宽度对准，避免卡片偏出容器）
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('canvas-visible-width', { detail: { width: computeVisibleCanvasWidth() } }));
      });
      window.setTimeout(centerFocusedNode, 400);
    }
  }, [panelCollapsed, computeVisibleCanvasWidth, centerFocusedNode]);
  const toggleNav = useCallback(() => {
    const next = !navCollapsed;
    setNavCollapsed(next);
    // 折叠切换后中栏宽度变化：广播可视宽度（内核据此调整展开宽度上限），
    // 再等宽度过渡完成后重新居中（宽度收敛后按真实渲染宽度对准，避免卡片偏出容器）
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('canvas-visible-width', { detail: { width: computeVisibleCanvasWidth() } }));
    });
    window.setTimeout(centerFocusedNode, 400);
  }, [navCollapsed, computeVisibleCanvasWidth, centerFocusedNode]);

  // 侧边栏展开/折叠时**不**平移画布：
  //  - ReactFlow pane 是悬浮 overlay 的全宽画布，居中/适配一律通过 fitBounds/setCenter 的
  //    (pw + sidebarWidth) 计算扣除侧栏后的可视区中心，展开/折叠结果一致，无需额外补偿 transform；
  //  - 若在折叠方向平移，会打断用户拖动画布（自动折叠常发生在拖动中）；
  //  - 若只展开平移而不对称还原，"展开→折叠"循环会让 transform 每次 +200 累积偏移，
  //    导致画布内容位置漂移（历史 bug 根因）。
  // 仅同步 sidebarWidthRef（供 fitBounds/setCenter/圆点对齐使用）与折叠状态。
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;
  const handleSidebarCollapsedChange = useCallback((collapsed: boolean) => {
    sidebarWidthRef.current = 0; // 2026-09 布局重构：Workspace 为临时浮层，不占画布宽度
    setSidebarCollapsed(collapsed);
    // 侧边栏宽度变化会改变画布可视区，立即广播供展开节点宽度上限同步
    window.dispatchEvent(new CustomEvent('canvas-visible-width', { detail: { width: computeVisibleCanvasWidth() } }));
  }, [computeVisibleCanvasWidth]);
  const [fileTabs, setFileTabs] = useState<Array<{
    id: string;
    source: FileSourceKind;
    fileName: string;
    filePath: string;
    imagePaths?: string[];
    activeImagePath?: string;
  }>>([]);
  const [sandboxTabs, setSandboxTabs] = useState<Array<{ id: string; name: string }>>([]);
  // Bob Sandbox 预览强制刷新信号：Play 按钮点击 / 绑定节点 / AI 写入小程序后 +1，驱动 iframe 重新加载最新内容
  const [sandboxRefreshTick, setSandboxRefreshTick] = useState(0);
  // 新建节点对话框（双击画布空白触发）：AI Chat / AI Coding 类型选择 + 小程序项目绑定
  const [nodeCreateDialogOpen, setNodeCreateDialogOpen] = useState(false);
  const [nodeCreatePos, setNodeCreatePos] = useState<{ x: number; y: number } | null>(null);
  // 标题栏「＋」会话类型下拉菜单
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Agent 市场已装画像（2026-09-06）：创建菜单与节点类型动态并入 /api/agents 返回的已装市场 agent
  const [marketAgents, setMarketAgents] = useState<Array<{ id: string; label: string }>>([]);
  // 已禁用 agent 名单：＋ Add session 菜单过滤掉禁用项（chat 系统恒可用；2026-09-06）
  const [disabledAgentIds, setDisabledAgentIds] = useState<Set<string>>(new Set());
  // 菜单隐藏名单（≠禁用）：装了但不出现在 ＋ 菜单，能力与身份保留（2026-09-06）
  const [hiddenMenuAgentIds, setHiddenMenuAgentIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/agents')
        .then((r) => r.json())
        .then((d: { agents?: Array<{ id?: string; label?: string }>; disabled?: string[]; hiddenMenu?: string[] }) => {
          if (!alive || !d || !Array.isArray(d.agents)) return;
          const builtin = new Set(listAgents().map((a) => a.id));
          const dis = new Set(d.disabled || []);
          setDisabledAgentIds(dis);
          setHiddenMenuAgentIds(new Set(d.hiddenMenu || []));
          const extras: Array<{ id: string; label: string }> = [];
          for (const a of d.agents) {
            if (a && typeof a.id === 'string' && !builtin.has(a.id) && !dis.has(a.id)) {
              extras.push({ id: a.id, label: a.label ?? a.id });
            }
          }
          setMarketAgents(extras);
        })
        .catch(() => { /* 拉取失败保持仅内置 */ });
    };
    load();
    // 市场安装/卸载/启停/可见性变更后由市场面板派发刷新事件
    const onAgentsChanged = () => load();
    window.addEventListener('agents-changed', onAgentsChanged);
    return () => {
      alive = false;
      window.removeEventListener('agents-changed', onAgentsChanged);
    };
  }, []);
  // 节点类型动态合并：内置壳（AGENT_NODE_SHELLS）+ 市场 agent 通用壳（agent-<id> → ChatNodeKernel）
  const effectiveNodeTypes = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map: Record<string, React.ComponentType<any>> = { ...nodeTypes };
    for (const a of marketAgents) {
      const flowType = agentFlowType(a.id);
      if (!map[flowType]) map[flowType] = genericAgentNodeFor(a.id);
    }
    return map;
  }, [marketAgents]);
  // 底部品牌区：应用版本号 + 点击触发更新检查（复用 desktop.update）
  const [appVersion, setAppVersion] = useState<string>(pkg.version);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'no-update' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = useState<string>('');

  useEffect(() => {
    if (!isDesktop()) return;
    desktop.update.getVersion().then((v) => {
      if (v) setAppVersion(v);
    }).catch(() => {});
    const unsubs = [
      desktop.update.onChecking(() => setUpdateStatus('checking')),
      desktop.update.onAvailable((info) => {
        setUpdateVersion(info?.version || '');
        setUpdateStatus('available');
      }),
      desktop.update.onNotAvailable(() => setUpdateStatus('no-update')),
      desktop.update.onError(() => setUpdateStatus('error')),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, []);
  const [, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [openReaderIds, setOpenReaderIds] = useState<string[]>([]);
  const [activeReaderId, setActiveReaderId] = useState<string | null>(null);
  const [activePanelTab, setActivePanelTab] = useState<{ type: 'node' | 'file' | 'sandbox' | 'template'; id: string } | null>(null);
  // 模板插件 tab：打开时预选的场景名（AI 扫描到模板字段后跳转携带）
  const [templateInitialScene, setTemplateInitialScene] = useState<string | undefined>(undefined);
  // Dev 守卫：预览面板展开时检测容器高度，若 <50px 说明 CSS 布局断裂（如 h-full/self-stretch 遗漏），提前预警
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' || panelCollapsed) return;
    const check = () => {
      const wrapper = document.querySelector('[data-reader-panel-wrapper]');
      if (wrapper && wrapper.getBoundingClientRect().height < 50) {
        console.warn('[CanvasFlow] 预览面板高度异常 (<50px)，请检查 self-stretch / h-full 是否缺失');
      }
    };
    const id = setTimeout(check, 300);
    return () => clearTimeout(id);
  }, [panelCollapsed, activePanelTab]);
  const [readerTitles, setReaderTitles] = useState<Record<string, string>>({});
  const [outcomeModeTabIds, setOutcomeModeTabIds] = useState<Set<string>>(new Set());
  const [hasProject, setHasProject] = useState<boolean | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string>('');
  // 画布左上角展示的当前项目名称（切换项目时重取）
  const [currentProjectTitle, setCurrentProjectTitle] = useState('');
  // 原生全屏检测（mac 全屏时隐藏红绿灯 → 项目名卡片移到最左）
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);
  useEffect(() => {
    const check = () => {
      const s = window.screen;
      setIsNativeFullscreen(window.innerWidth >= s.width - 1 && window.innerHeight >= s.height - 1);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    if (!currentProjectId) return;
    let alive = true;
    fetch('/api/projects?action=current')
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.success && d?.project?.name) setCurrentProjectTitle(d.project.name);
      })
      .catch(() => { /* 静默：名称加载失败则隐藏标签 */ });
    return () => { alive = false; };
  }, [currentProjectId]);

  // 广播当前项目 id：会话标题栏 todo/便签 Dock（ChatNodeKernel 深层组件）经此订阅
  useEffect(() => {
    setCurrentProject(currentProjectId);
  }, [currentProjectId]);

  // 首次进入项目：恢复该项目保存的视口（项目级 key）；无保存视口则 fit 全部节点。
  // 仅执行一次；用户已手动交互或 zoom 锁定时跳过，避免与用户手势抢画布。
  const appliedInitialViewportRef = useRef(false);
  useEffect(() => {
    if (!hasProject || appliedInitialViewportRef.current || zoomLocked) return;
    appliedInitialViewportRef.current = true;
    const saved = readSavedViewport(currentProjectId);
    savedViewportRef.current = saved;
    requestAnimationFrame(() => {
      // rAF 排队期间用户可能已开始交互，执行前再次检查
      if (userInteractedRef.current) return;
      if (saved) {
        setViewport(saved);
      } else {
        // 无保存视口（新建空项目）：fit 所有节点居中到可视区，含单初始节点场景
        fitAllNodesWithSidebar({ padding: 0.4, maxZoom: 1, duration: 0 });
      }
    });
  }, [hasProject, currentProjectId, readSavedViewport, setViewport, fitAllNodesWithSidebar, zoomLocked, getNodes]);
  const [, setSelectedNodeIds] = useState<Set<string>>(new Set());

  // 手动 pan 状态（统一 5px 阈值，避免点击微抖动触发画布平移）
  // 模式：mode=null 尚在阈值内未决；mode='pan'=平移中；mode='off'=初始
  const dragSelectRef = useRef<{
    // 起点：相对于 wrapper 的像素坐标
    startX: number;
    startY: number;
    // 起点：屏幕 clientX/Y（用于 pan 的屏幕位移增量计算，更可靠）
    startClientX: number;
    startClientY: number;
    // 起点时的 viewport（pan 用）
    startViewport: { x: number; y: number; zoom: number };
    // 模式：null=未达阈值待定；'pan'=平移中；'off'=初始
    mode: 'off' | 'pan' | null;
    hadDrag: boolean;
    // pan 目标视口（rAF 节流：mousemove 只更新此字段，每帧最多一次 setViewport）
    panTarget: { x: number; y: number; zoom: number } | null;
  }>({
    startX: 0,
    startY: 0,
    startClientX: 0,
    startClientY: 0,
    startViewport: { x: 0, y: 0, zoom: 1 },
    mode: 'off',
    hadDrag: false,
    panTarget: null,
  });
  // pan 的 requestAnimationFrame 句柄：同一时刻至多一个 rAF 挂起，每帧最多提交一次 viewport
  const panRafRef = useRef<number | null>(null);

  // 折叠面板
  const handleTogglePanel = useCallback(() => {
    setPanelCollapsed(prev => {
      const next = !prev;
      // 同步 ImageAiEditor 折叠隐藏态：折叠→hidden，展开→hidden 清除
      setImageAiEditHidden(next);
      // 展开时释放 keep-alive（折叠期间靠 keep-alive 保持挂载，展开后无需再保活）
      if (!next) setImageAiEditKeepAlive(false);
      return next;
    });
  }, []);

  const openReader = useCallback((nodeMdId: string, options?: { outcomeMode?: boolean }) => {
    setOpenReaderIds((prev) => {
      if (prev.includes(nodeMdId)) return prev;
      return [...prev, nodeMdId];
    });
    setActiveReaderId(nodeMdId);
    setActivePanelTab({ type: 'node', id: nodeMdId });
    lastActiveNodeIdRef.current = nodeMdId;
    setPanelCollapsed(false); // 确保面板展开
    // 记录是否以成果块模式打开
    if (options?.outcomeMode) {
      setOutcomeModeTabIds(prev => new Set(prev).add(nodeMdId));
    }
    // 获取节点标题
    fetch(`/api/nodes?id=${nodeMdId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.node?.title) {
          setReaderTitles((prev) => ({ ...prev, [nodeMdId]: data.node.title }));
        }
      })
      .catch(() => {});
  }, []);
  const closeReader = useCallback((nodeMdId: string) => {
    setOpenReaderIds((prev) => {
      const next = prev.filter((id) => id !== nodeMdId);
      // 如果关闭的是当前活跃的，切换到最后一个
      if (nodeMdId === activeReaderId) {
        if (next.length > 0) {
          setActiveReaderId(next[next.length - 1]);
          setActivePanelTab({ type: 'node', id: next[next.length - 1] });
        } else {
          setActiveReaderId(null);
          // 切换到文件/小程序标签（如果有）
          if (fileTabs.length > 0) {
            setActivePanelTab({ type: 'file', id: fileTabs[fileTabs.length - 1].id });
          } else if (sandboxTabs.length > 0) {
            setActivePanelTab({ type: 'sandbox', id: sandboxTabs[sandboxTabs.length - 1].id });
          } else {
            setActivePanelTab(null);
          }
        }
      }
      return next;
    });
    setReaderTitles((prev) => {
      const next = { ...prev };
      delete next[nodeMdId];
      return next;
    });
    setOutcomeModeTabIds(prev => {
      const next = new Set(prev);
      next.delete(nodeMdId);
      return next;
    });
  }, [activeReaderId, fileTabs, sandboxTabs]);
  // 图片文件扩展名（与后端 local-files read_file 的 imageExts 保持一致）
  const isImageFile = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext);
  };

  // 文件标签页管理（source 标记文件来源：local/project/attachment/material）
  const openFileTab = useCallback((source: FileSourceKind, fileName: string, filePath: string) => {
    // 图片文件：所有图片聚合到一个共享标签页（按来源分组），侧边缩略图浏览；重复打开仅切换激活图
    if (isImageFile(fileName)) {
      const tabId = `file:${source}:__images__`;
      setFileTabs((prev) => {
        const existing = prev.find(t => t.id === tabId);
        if (existing) {
          return prev.map(t => t.id === tabId
            ? {
                ...t,
                fileName,            // 标签显示当前激活图片名
                filePath,            // 最新激活图路径（头部显示 / 渲染器匹配用）
                activeImagePath: filePath,
                imagePaths: t.imagePaths?.includes(filePath)
                  ? t.imagePaths
                  : [...(t.imagePaths || []), filePath],
              }
            : t);
        }
        return [...prev, { id: tabId, source, fileName, filePath, activeImagePath: filePath, imagePaths: [filePath] }];
      });
      setActivePanelTab({ type: 'file', id: tabId });
      setPanelCollapsed(false); // 确保预览面板展开，否则点击文件事件看不到内容
      return;
    }
    // 非图片文件：每个文件独立标签
    const tabId = `file:${source}:${filePath}`;
    setFileTabs((prev) => {
      if (prev.some(t => t.id === tabId)) return prev;
      return [...prev, { id: tabId, source, fileName, filePath }];
    });
    setActivePanelTab({ type: 'file', id: tabId });
    setPanelCollapsed(false); // 确保预览面板展开，否则点击文件事件看不到内容
  }, []);

  // Step 2：订阅 file.open 事件 —— 任意舱（目录浏览器/项目树/搜索/素材）发布打开意图，查看舱统一处理
  useEffect(() => {
    return bus.subscribe<FileOpenPayload>(BusEvents.fileOpen, (p) => {
      openFileTab(p.source, p.name, p.path);
    });
  }, [openFileTab]);

  const closeFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const next = prev.filter(t => t.id !== tabId);
      // 如果关闭的是当前活跃的，切换到最后一个未关闭的
      if (activePanelTab?.type === 'file' && activePanelTab.id === tabId) {
        if (next.length > 0) {
          setActivePanelTab({ type: 'file', id: next[next.length - 1].id });
        } else if (openReaderIds.length > 0) {
          setActivePanelTab({ type: 'node', id: openReaderIds[openReaderIds.length - 1] });
          setActiveReaderId(openReaderIds[openReaderIds.length - 1]);
        } else {
          setActivePanelTab(null);
        }
      }
      return next;
    });
  }, [activePanelTab, openReaderIds]);

  // Bob Sandbox 预览标签页管理（点击边栏小程序后在此打开 iframe 预览）
  const openSandboxTab = useCallback((id: string, name: string) => {
    setSandboxTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [...prev, { id, name }];
    });
    setActivePanelTab({ type: 'sandbox', id });
    setPanelCollapsed(false); // 确保预览面板展开
    setSandboxRefreshTick((t) => t + 1); // 已打开/激活时也强制刷新 iframe，避免 Play 点击无反应
  }, []);

  // 订阅 sandbox-changed：AI 在 Coding 节点写入/修改小程序文件后广播，自动刷新已打开的预览
  useEffect(() => {
    const handler = () => setSandboxRefreshTick((t) => t + 1);
    window.addEventListener('sandbox-changed', handler);
    return () => window.removeEventListener('sandbox-changed', handler);
  }, []);

  // 订阅主题变更：通过 postMessage 实时推送 CSS 变量到 sandbox iframe（无需全量重载）
  useEffect(() => {
    const handler = () => {
      // 从主应用 DOM 读取当前主题的所有 CSS 变量
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const varNames = Object.keys(PRESET_THEME_VARIABLES.warm);
      const variables: Record<string, string> = {};
      for (const name of varNames) {
        const val = style.getPropertyValue(name).trim();
        if (val) variables[name] = val;
      }
      // 判断深色模式：统一主题（dynamic-ui Purple）为浅色；自定义主题按背景亮度判定
      const dark = (() => {
          // 自定义主题：检查背景亮度
          const bg = variables['--background'] || '';
          const match = bg.match(/oklch\(\s*([\d.]+)/);
          return match ? parseFloat(match[1]) < 0.5 : false;
        })();
      // 提取关键色摘要
      const keyColors = {
        primary: variables['--primary'] || '',
        background: variables['--background'] || variables['--canvas-bg'] || '',
        surface: variables['--paper'] || variables['--card'] || '',
        text: variables['--foreground'] || variables['--ink'] || '',
        border: variables['--border'] || variables['--line'] || '',
        muted: variables['--muted-foreground'] || variables['--ink-muted'] || '',
      };
      // 向所有 sandbox 预览 iframe 推送主题更新
      const HOST_ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
      const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/api/sandbox/preview/"]');
      iframes.forEach((iframe) => {
        try {
          const msg = { type: 'bob_theme_update', variables, dark, keyColors };
          if (HOST_ORIGIN) iframe.contentWindow?.postMessage(msg, HOST_ORIGIN);
          else iframe.contentWindow?.postMessage(msg, '*');
        } catch {
          // iframe 可能跨域或未加载，忽略
        }
      });
    };
    window.addEventListener('theme-changed', handler);
    return () => window.removeEventListener('theme-changed', handler);
  }, []);

  // 新建节点对话框创建成功回调：挂载节点；AI Coding 节点额外打开小程序预览并刷新 SandboxPanel
  const handleNodeCreated = useCallback(async (payload: { nodeId: string; title: string; sandboxAppId?: string; appName?: string; initialPrompt?: string }) => {
    const pos = nodeCreatePos ?? { x: 0, y: 0 };
    const initialMsg: ChatMessage[] =
      payload.initialPrompt
        ? [
            {
              id: `init-${payload.nodeId}-${Date.now()}`,
              role: 'user' as const,
              content: payload.initialPrompt,
              timestamp: new Date().toISOString(),
            },
          ]
        : [];
    const newNode: Node<AiChatNodeData> = {
      id: payload.nodeId,
      type: payload.sandboxAppId ? agentFlowType('coding') : agentFlowType('chat'),
      position: pos,
      data: {
        title: payload.title,
        messages: initialMsg,
        isStreaming: false,
        modelId: DEFAULT_MODEL_ID,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        nodeMdId: payload.nodeId,
        initialExpanded: true,
        ...(payload.sandboxAppId ? { sandboxAppId: payload.sandboxAppId } : {}),
      },
    };
    setNodes((nds) => [...nds, newNode]);
    // 单焦点：对话框新建（Coding/Chat）= 打开为新对话
    openNewlyCreatedNode(payload.nodeId);
    if (payload.sandboxAppId && payload.appName) {
      openSandboxTab(payload.sandboxAppId, payload.appName);
      window.dispatchEvent(new Event('sandbox-changed'));
    }
    // 用户在创建对话框里填写了初始需求：同步写入节点 .md，保证刷新/重启后回放也能看到
    if (payload.initialPrompt) {
      try {
        await fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'append',
            node_id: payload.nodeId,
            question: payload.initialPrompt,
            // 占位 AI 回答，标记为"首轮预填需求占位"，后端首轮 spec 采集会跳过此类轮次
            answer: '__BAI_INITIAL_PROMPT_PLACEHOLDER__',
          }),
        });
      } catch {
        // 写入失败忽略：节点内存里已存在用户消息，不影响 UI
      }
    }
  }, [nodeCreatePos, openSandboxTab, setNodes, openNewlyCreatedNode]);

  // Step：订阅 open-sandbox-preview 事件 —— SandboxPanel 派发，查看舱统一处理
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string; name?: string }>).detail;
      if (detail?.id) openSandboxTab(detail.id, detail.name || 'Sandbox App');
    };
    window.addEventListener('open-sandbox-preview', handler);
    return () => window.removeEventListener('open-sandbox-preview', handler);
  }, [openSandboxTab]);

  // Step：订阅 sandbox-store-open 事件 —— SandboxPanel 头部全屏按钮派发，打开全屏管理页
  useEffect(() => {
    const handler = () => setStoreOpen(true);
    window.addEventListener('sandbox-store-open', handler);
    return () => window.removeEventListener('sandbox-store-open', handler);
  }, []);

  // 订阅 team-panel-open 事件 —— 侧边栏 Agent Teams 入口派发，打开全屏团队面板
  useEffect(() => {
    const handler = () => setTeamsFullscreenOpen(true);
    window.addEventListener('team-panel-open', handler);
    return () => window.removeEventListener('team-panel-open', handler);
  }, []);

  // 订阅 usage-panel-open 事件 —— 图标栏/⌘F 入口派发，打开用量统计面板
  useEffect(() => {
    const handler = () => setUsageOpen(true);
    window.addEventListener('usage-panel-open', handler);
    return () => window.removeEventListener('usage-panel-open', handler);
  }, []);

  // 订阅 open-bob-mind-panel 事件 —— ⌘F Bob-Mind 按钮派发，打开 Bob-Mind 插件面板壳
  useEffect(() => {
    const handler = () => setBobMindOpen(true);
    window.addEventListener('open-bob-mind-panel', handler);
    return () => window.removeEventListener('open-bob-mind-panel', handler);
  }, []);

  // 监听 open-settings 事件：节点内模型菜单等入口派发，打开设置弹窗并聚焦指定区块
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ section?: 'chat' | 'roles' | 'icons' | 'theme' | 'diagram' }>).detail;
      setSettingsSection(detail?.section);
      setSettingsOpen(true);
    };
    window.addEventListener('open-settings', handler);
    return () => window.removeEventListener('open-settings', handler);
  }, []);

  // Bob Sandbox postMessage Bridge: 监听来自小程序 iframe 的 bob_request 消息
  useEffect(() => {
    // ------- Security helpers for host message listeners -------
    const HOST_ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
    function trustedMessageSource(source: Window | null): boolean {
      if (!source) return false;
      // Same-origin always allowed (dev/electron-local)
      // Additionally walk all sandbox preview iframes and check if this source is one of them
      // (covers sandboxed iframe where event.origin is 'null').
      const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/api/sandbox/preview/"]');
      for (let i = 0; i < iframes.length; i++) {
        try {
          if (iframes[i].contentWindow === source) return true;
        } catch { /* cross-origin access blocked – skip */ }
      }
      return false;
    }
    function postToSource(source: Window, msg: unknown) {
      try {
        // Prefer the iframe's own src-derived origin; fall back to HOST_ORIGIN for same-origin preview
        if (HOST_ORIGIN) {
          source.postMessage(msg, HOST_ORIGIN);
          return;
        }
      } catch { /* ignore */ }
      try { source.postMessage(msg, '*'); } catch { /* ignore */ }
    }
    // Broadcast a message to every open sandbox preview iframe
    function broadcastToSandboxes(msg: unknown) {
      const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/api/sandbox/preview/"]');
      iframes.forEach((iframe) => {
        try {
          if (iframe.contentWindow) postToSource(iframe.contentWindow, msg);
        } catch { /* ignore */ }
      });
    }

    const handler = async (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.type !== 'bob_request') return;
      // P0#1: verify source is a real sandbox preview iframe (or same-origin)
      const source = event.source as Window | null;
      if (!source || !trustedMessageSource(source)) return;
      const { id, action, data } = msg;
      try {
        // P0#3: writeWanted 宿主端用户确认（按 appId 记忆授权，防止小程序静默把投递物塞到 wanted/）
        if (String(action) === 'writeWanted') {
          const appId = String((data as Record<string, unknown> | undefined)?._appId ?? 'unknown-app');
          const filename = String((data as Record<string, unknown> | undefined)?.filename ?? '(unnamed)');
          const content = String((data as Record<string, unknown> | undefined)?.content ?? '');
          const preview = content.length > 240 ? content.slice(0, 240) + '\n... (truncated)' : content;
          const allowed = await confirmAsk({
            title: 'Wanted Delivery Confirmation',
            message:
              `Mini-program "${appId}" wants to write to your global wanted/ directory:\n\n` +
              `  File name: ${filename}\n` +
              `  Size: ${content.length} chars\n\n` +
              `Content preview:\n${preview}\n\n` +
              `This file will be placed in ~/BobWork/wanted/. Confirm delivery?`,
            confirmLabel: 'Allow',
            cancelLabel: 'Block',
          });
          if (!allowed) {
            postToSource(source, { type: 'bob_response', id, success: false, error: 'User blocked writeWanted' });
            return;
          }
        }
        // GraphGateway 对接动作（太空舱对接协议）：客户端拦截，先鉴权。
        // 未授权一律拒绝；control 类动作还需已获 control 授权；授权弹窗由用户（控制台）决定。
        if (isGraphBridgeAction(String(action))) {
          const appId = String((data as Record<string, unknown> | undefined)?._appId ?? '');
          const result = await executeGraphBridgeAction(
            String(action),
            ((data as Record<string, unknown> | undefined) || {}) as Record<string, unknown>,
            {
              appId,
              gateway: graphGateway,
              requestPermission: async (aid, level) => {
                const levelLabel =
                  level === 'control' ? 'Control (operate canvas)' : 'Read (view canvas)';
                const ok = await confirmAsk({
                  title: 'Docking Permission Request',
                  message:
                    `Mini-program "${aid}" requests ${levelLabel} access to the canvas.\n\n` +
                    (level === 'control'
                      ? 'Granting lets it read and manipulate nodes, edges, and the viewport.'
                      : 'Granting lets it read nodes, edges, and the viewport.') +
                    '\nYou can revoke anytime from the Sandbox panel.',
                  confirmLabel: 'Grant',
                  cancelLabel: 'Deny',
                });
                if (!ok) return 'none';
                await updateSandboxGraphPermission(aid, level);
                // 通知 SandboxPanel 同步授权 chip 状态
                window.dispatchEvent(
                  new CustomEvent('sandbox-permission-changed', { detail: { appId: aid, level } }),
                );
                // 通知所有打开的 sandbox iframe（graph 权限变化与 chat 状态同步）
                broadcastToSandboxes({ type: 'bob_chat_permission_changed', appId: aid, granted: level !== 'none' });
                return level;
              },
            },
          );
          if (result.success) {
            postToSource(source, { type: 'bob_response', id, success: true, data: result.data });
          } else {
            postToSource(source,
              { type: 'bob_response', id, success: false, error: result.error || 'Unknown error' },
            );
          }
          return;
        }
        // 小程序模型调用权限申请（chat）：P1#10 三档选择（None / Per-call / Permanent）
        if (HOST_CHAT_PERMISSION_ACTIONS.includes(String(action))) {
          const appId = String((data as Record<string, unknown> | undefined)?._appId ?? '');
          const currentLevel: SandboxChatPermission = await getSandboxChatPermission(appId);

          // chatGetPermission: 返回结构化 level，兼容旧版 granted boolean
          if (String(action) === 'chatGetPermission') {
            postToSource(source, {
              type: 'bob_response',
              id,
              success: true,
              data: {
                granted: currentLevel !== 'none',
                level: currentLevel,
              },
            });
            return;
          }

          // chatRequestPermission: 三级选择弹窗
          // Round 1: 主确认（Allow = permanent / Deny = none）
          const allowPermanent = await confirmAsk({
            title: 'Model-Call Permission Request',
            message:
              `Mini-program "${appId}" requests permission to call your AI models.\n\n` +
              'Granting lets it send text to your configured models (no file/tool access; ' +
              'output capped at 2048 tokens per call; every call is recorded in egress-audit.log).\n' +
              'You can revoke anytime from the Sandbox panel.\n\n' +
              '▸ "Permanent Allow" = never ask again for this mini-program\n' +
              '▸ "Ask Every Time" = each call shows a cost-estimate confirm dialog\n' +
              '▸ "Deny" = block all model calls',
            confirmLabel: 'Permanent Allow',
            cancelLabel: 'Ask Every Time',
          });
          let chosen: SandboxChatPermission;
          if (allowPermanent) {
            chosen = 'permanent';
          } else {
            // 第二轮：问用户是 Ask Every Time 还是直接 Deny
            const allowPerCall = await confirmAsk({
              title: 'Model-Call: Confirm Mode',
              message:
                `Choose permission mode for mini-program "${appId}":\n\n` +
                '▸ "Ask Every Time" — each call shows a cost-estimate confirm dialog\n' +
                '▸ "Deny" — block all model calls',
              confirmLabel: 'Ask Every Time',
              cancelLabel: 'Deny',
            });
            chosen = allowPerCall ? 'per_call' : 'none';
          }
          await updateSandboxChatPermission(appId, chosen);
          const granted = chosen !== 'none';
          window.dispatchEvent(
            new CustomEvent('sandbox-chat-permission-changed', { detail: { appId, granted, level: chosen } }),
          );
          broadcastToSandboxes({ type: 'bob_chat_permission_changed', appId, granted });
          postToSource(source, {
            type: 'bob_response',
            id,
            success: true,
            data: { granted, level: chosen },
          });
          return;
        }

        // P1#10: chat 实际执行前校验三级授权：per_call → 每次确认（附 token/cost 预估）；none → 拒绝
        if (String(action) === 'chat') {
          const appId = String((data as Record<string, unknown> | undefined)?._appId ?? data.appId ?? '');
          const messages = ((data as Record<string, unknown> | undefined)?.messages || []) as Array<{ role?: unknown; content?: unknown }>;
          const model = typeof (data as Record<string, unknown> | undefined)?.model === 'string'
            ? ((data as Record<string, unknown>).model as string)
            : undefined;
          const maxTokens = typeof (data as Record<string, unknown> | undefined)?.maxTokens === 'number'
            ? ((data as Record<string, unknown>).maxTokens as number)
            : undefined;
          const level = await getSandboxChatPermission(appId);
          if (level === 'none') {
            // 首次授权引导：弹窗确认一次 → 写入 permanent，之后该小程序永不弹窗（首次授权后永久生效）
            const firstGrant = await confirmAsk({
              title: 'Model-Call: First-Time Grant',
              message:
                `Mini-program "${appId}" wants to call your AI models.\n\n` +
                'Granting remembers the choice (permanent) — this mini-program will not ask again.\n' +
                'Every call is logged to egress-audit.log.\n' +
                'You can revoke/set per-call confirmation anytime from the Sandbox panel.',
              confirmLabel: 'Allow & Remember',
              cancelLabel: 'Deny This App',
            });
            if (!firstGrant) {
              postToSource(source, {
                type: 'bob_response',
                id,
                success: false,
                error: 'Chat permission denied by user',
              });
              return;
            }
            await updateSandboxChatPermission(appId, 'permanent');
            window.dispatchEvent(
              new CustomEvent('sandbox-chat-permission-changed', { detail: { appId, granted: true, level: 'permanent' } }),
            );
            broadcastToSandboxes({ type: 'bob_chat_permission_changed', appId, granted: true });
          }
          if (level === 'per_call') {
            const est = estimateChatCost({ model, messages, maxTokens });
            const msgCount = messages?.length || 0;
            const totalChars = messages?.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0) || 0;
            const okPerCall = await confirmAsk({
              title: 'Model-Call: Approve This Request?',
              message:
                `Mini-program "${appId}" wants to call the model.\n\n` +
                `  Model:        ${model || '(auto-picked from configured pool)'}\n` +
                `  Messages:     ${msgCount} (${totalChars} chars)\n` +
                `  Est. input:   ${est.promptTokens.toLocaleString()} tokens\n` +
                `  Max output:   ${est.estOutputTokens.toLocaleString()} tokens\n` +
                `  Price range:  ${est.priceLabel}\n` +
                `  Est. cost:    $${est.usd.toFixed(5)}  (~¥${est.cny.toFixed(4)})\n\n` +
                `Every call is logged to egress-audit.log. Approve this call?`,
              confirmLabel: 'Approve Call',
              cancelLabel: 'Deny This Call',
            });
            if (!okPerCall) {
              postToSource(source, {
                type: 'bob_response',
                id,
                success: false,
                error: 'Chat denied by user (per_call mode)',
              });
              return;
            }
          }
        }
        const resp = await fetch('/api/sandbox/bridge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, data }),
        });
        const result = await resp.json();
        if (result.success) {
          postToSource(source, { type: 'bob_response', id, success: true, data: result.data });
        } else {
          postToSource(source, { type: 'bob_response', id, success: false, error: result.error || 'Unknown error' });
        }
      } catch (e) {
        postToSource(source, { type: 'bob_response', id, success: false, error: e instanceof Error ? e.message : String(e) });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [confirmAsk, graphGateway]);

  // Bob Sandbox Chat Stream：监听小程序 iframe 的 bob_chat_stream / bob_chat_cancel，
  // 转发到服务端 SSE 端点，把增量逐块回传 iframe（流式模型调用）。
  useEffect(() => {
    const HOST_ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
    function trustedMessageSource(source: Window | null): boolean {
      if (!source) return false;
      const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/api/sandbox/preview/"]');
      for (let i = 0; i < iframes.length; i++) {
        try {
          if (iframes[i].contentWindow === source) return true;
        } catch { /* ignore */ }
      }
      return false;
    }
    function postToSource(source: Window, msg: unknown) {
      try {
        if (HOST_ORIGIN) { source.postMessage(msg, HOST_ORIGIN); return; }
      } catch { /* ignore */ }
      try { source.postMessage(msg, '*'); } catch { /* ignore */ }
    }
    // 记录进行中的流，key 为 stream id，value 为取消函数
    const activeStreams = new Map<string, () => void>();
    const streamHandler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg) return;
      const source = event.source as Window | null;
      if (!source || !trustedMessageSource(source)) return;

      // 取消：中止对应流的 AbortController
      if (msg.type === 'bob_chat_cancel') {
        const cancel = activeStreams.get(msg.id);
        if (cancel) {
          cancel();
          activeStreams.delete(msg.id);
        }
        return;
      }

      if (msg.type !== 'bob_chat_stream') return;
      const id = msg.id;
      const data = (msg.data as Record<string, unknown> | undefined) || {};
      const controller = new AbortController();
      activeStreams.set(id, () => controller.abort());

      (async () => {
        try {
          // P1#10: chatStream 同 chat 一样做三级授权校验
          const appIdStream = String((data as Record<string, unknown>)._appId ?? (data as Record<string, unknown>).appId ?? '');
          const messagesStream = ((data as Record<string, unknown>).messages || []) as Array<{ role?: unknown; content?: unknown }>;
          const modelStream = typeof (data as Record<string, unknown>).model === 'string' ? ((data as Record<string, unknown>).model as string) : undefined;
          const maxTokensStream = typeof (data as Record<string, unknown>).maxTokens === 'number' ? ((data as Record<string, unknown>).maxTokens as number) : undefined;
          const streamLevel = await getSandboxChatPermission(appIdStream);
          if (streamLevel === 'none') {
            // 首次授权引导：弹窗确认一次 → 写入 permanent，之后该小程序永不弹窗（首次授权后永久生效）
            const streamFirstGrant = await confirmAsk({
              title: 'Model-Call: First-Time Grant',
              message:
                `Mini-program "${appIdStream}" wants to stream a model call.\n\n` +
                'Granting remembers the choice (permanent) — this mini-program will not ask again.\n' +
                'Every call is logged to egress-audit.log.\n' +
                'You can revoke/set per-call confirmation anytime from the Sandbox panel.',
              confirmLabel: 'Allow & Remember',
              cancelLabel: 'Deny This App',
            });
            if (!streamFirstGrant) {
              postToSource(source,
                { type: 'bob_chat_error', id, error: 'Chat permission denied by user' },
              );
              activeStreams.delete(id);
              return;
            }
            await updateSandboxChatPermission(appIdStream, 'permanent');
            window.dispatchEvent(
              new CustomEvent('sandbox-chat-permission-changed', { detail: { appId: appIdStream, granted: true, level: 'permanent' } }),
            );
          }
          if (streamLevel === 'per_call') {
            const est = estimateChatCost({
              model: modelStream,
              messages: messagesStream,
              maxTokens: maxTokensStream,
            });
            const charCount = messagesStream.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
            const proceed = await confirmAsk({
              title: 'Stream Model-Call: Approve?',
              message:
                `Mini-program "${appIdStream}" wants to stream a model call.\n\n` +
                `  Model:        ${modelStream || '(default)'}\n` +
                `  Messages:     ${messagesStream.length} (${charCount} chars)\n` +
                `  Est. input:   ${est.promptTokens.toLocaleString()} tokens\n` +
                `  Max output:   ${est.estOutputTokens.toLocaleString()} tokens\n` +
                `  Price range:  ${est.priceLabel}\n` +
                `  Est. cost:    $${est.usd.toFixed(5)}  (~¥${est.cny.toFixed(4)})\n\n` +
                `Logged in egress-audit.log. Approve this stream call?`,
              confirmLabel: 'Approve Call',
              cancelLabel: 'Deny This Call',
            });
            if (!proceed) {
              postToSource(source,
                { type: 'bob_chat_error', id, error: 'Stream chat denied by user (per_call mode)' },
              );
              activeStreams.delete(id);
              return;
            }
          }

          const resp = await fetch('/api/sandbox/chat-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...data }),
            signal: controller.signal,
          });
          if (!resp.ok || !resp.body) {
            const err = await resp.json().catch(() => ({}));
            postToSource(source,
              { type: 'bob_chat_error', id, error: (err as { error?: string }).error || `HTTP ${resp.status}` },
            );
            activeStreams.delete(id);
            return;
          }
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let finishReason: string | undefined;
          let stopReason: string | undefined;
          let lastDoneData: unknown = {};
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const chunk = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              // 解析 SSE 事件块
              let ev = 'message';
              const dataLines: string[] = [];
              for (const line of chunk.split('\n')) {
                if (line.startsWith('event:')) ev = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
              }
              const payload = dataLines.join('\n');
              if (!payload) continue;
              if (ev === 'delta') {
                try {
                  const parsed = JSON.parse(payload);
                  if (typeof parsed.text === 'string') {
                    postToSource(source, { type: 'bob_chat_delta', id, text: parsed.text });
                  }
                } catch { /* ignore */ }
              } else if (ev === 'done') {
                let parsed: Record<string, unknown> = {};
                try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { /* ignore */ }
                lastDoneData = parsed;
                // P3#12: backprop finish_reason / stop_reason
                if (typeof parsed.finish_reason === 'string') finishReason = parsed.finish_reason;
                if (typeof parsed.stop_reason === 'string') stopReason = parsed.stop_reason;
              } else if (ev === 'error') {
                try {
                  const parsed = JSON.parse(payload) as { error?: string };
                  postToSource(source, { type: 'bob_chat_error', id, error: parsed.error || 'Unknown stream error' });
                } catch { /* ignore */ }
                activeStreams.delete(id);
              }
            }
          }
          // Emit final done event with finish/stop reasons attached (P3#12)
          const finalDone: Record<string, unknown> = typeof lastDoneData === 'object' && lastDoneData ? { ...lastDoneData } : {};
          if (finishReason) finalDone.finish_reason = finishReason;
          if (stopReason) finalDone.stop_reason = stopReason;
          postToSource(source, { type: 'bob_chat_done', id, data: finalDone });
          activeStreams.delete(id);
        } catch (e) {
          // 仅当非主动取消时才回传错误
          if (!controller.signal.aborted) {
            postToSource(source,
              { type: 'bob_chat_error', id, error: e instanceof Error ? e.message : String(e) },
            );
          }
          activeStreams.delete(id);
        }
      })();
    };
    window.addEventListener('message', streamHandler);
    return () => {
      window.removeEventListener('message', streamHandler);
      activeStreams.forEach((cancel) => cancel());
    };
  }, []);


  const closeSandboxTab = useCallback((tabId: string) => {
    setSandboxTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      // 如果关闭的是当前活跃的，切换到最后一个未关闭的
      if (activePanelTab?.type === 'sandbox' && activePanelTab.id === tabId) {
        if (next.length > 0) {
          setActivePanelTab({ type: 'sandbox', id: next[next.length - 1].id });
        } else if (fileTabs.length > 0) {
          setActivePanelTab({ type: 'file', id: fileTabs[fileTabs.length - 1].id });
        } else if (openReaderIds.length > 0) {
          setActivePanelTab({ type: 'node', id: openReaderIds[openReaderIds.length - 1] });
          setActiveReaderId(openReaderIds[openReaderIds.length - 1]);
        } else {
          setActivePanelTab(null);
        }
      }
      return next;
    });
  }, [activePanelTab, fileTabs, openReaderIds]);

  // 模板插件 tab：打开（单例，可携带预选场景）；关闭时切回最后打开的其它 tab
  const openTemplateTab = useCallback((scene?: string) => {
    setTemplateInitialScene(scene);
    setActivePanelTab({ type: 'template', id: 'template' });
    setPanelCollapsed(false);
  }, []);

  const closeTemplateTab = useCallback(() => {
    setActivePanelTab((prev) => {
      if (prev?.type !== 'template') return prev;
      if (fileTabs.length > 0) {
        setActivePanelTab({ type: 'file', id: fileTabs[fileTabs.length - 1].id });
      } else if (sandboxTabs.length > 0) {
        setActivePanelTab({ type: 'sandbox', id: sandboxTabs[sandboxTabs.length - 1].id });
      } else if (openReaderIds.length > 0) {
        setActivePanelTab({ type: 'node', id: openReaderIds[openReaderIds.length - 1] });
        setActiveReaderId(openReaderIds[openReaderIds.length - 1]);
      } else {
        return null;
      }
      return prev;
    });
  }, [fileTabs, sandboxTabs, openReaderIds]);

  // 订阅 open-template-panel：Sidebar 模板入口 / ChatNode 模板按钮派发，打开预览面板模板 tab
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ scene?: string }>).detail;
      openTemplateTab(detail?.scene);
    };
    window.addEventListener('open-template-panel', handler);
    return () => window.removeEventListener('open-template-panel', handler);
  }, [openTemplateTab]);

  // ⌘F My Quick：点击快捷入口 → 新建 chat 节点并把预设提示词注入其输入框（不自动发送）
  useEffect(() => {
    const handler = async (e: Event) => {
      const d = (e as CustomEvent<{ label?: string; agent?: string; prompt?: string }>).detail;
      const label = (d?.label || 'Quick').slice(0, 40);
      const prompt = d?.prompt || '';
      const cx = typeof window !== 'undefined' ? Math.round(window.innerWidth / 2) - 140 : 200;
      const cy = typeof window !== 'undefined' ? Math.round(window.innerHeight / 2) - 120 : 160;
      const newX = cx + Math.round((Math.random() - 0.5) * 120);
      const newY = cy + Math.round((Math.random() - 0.5) * 80);
      try {
        const resp = await fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            title: label,
            model: DEFAULT_MODEL_ID,
            sources: [],
            position_x: newX,
            position_y: newY,
          }),
        });
        const data = await resp.json();
        if (!data.success || !data.node_id) return;
        const newNodeId = data.node_id as string;
        const newNode: Node<AiChatNodeData> = {
          id: newNodeId,
          type: 'aiChat',
          position: { x: newX, y: newY },
          data: {
            title: label,
            messages: [],
            isStreaming: false,
            modelId: DEFAULT_MODEL_ID,
            thinkingLevel: DEFAULT_THINKING_LEVEL,
            nodeMdId: newNodeId,
          },
        };
        setNodes((nds) => [...nds, newNode]);
        if (!prompt) return;
        // 新节点挂载后再注入输入框（重试数次兜底）
        const inject = () =>
          window.dispatchEvent(new CustomEvent('quick-prompt-inject', { detail: { nodeId: newNodeId, text: prompt } }));
        setTimeout(inject, 500);
        setTimeout(inject, 1200);
      } catch { /* 创建失败静默 */ }
    };
    window.addEventListener('quick-launch-open', handler);
    return () => window.removeEventListener('quick-launch-open', handler);
  }, [setNodes]);

  // 检查是否有项目（只算活跃项目，归档的不算）
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const activeCount = (data.active_projects || []).length;
          if (activeCount > 0) {
            setHasProject(true);
            setCurrentProjectId(data.current_id || '');
          } else {
            setHasProject(false);
          }
        } else {
          setHasProject(false);
        }
      })
      .catch(() => {
        setHasProject(false);
      });
  }, []);

  // 启动即进入项目看板（待办面板）：每次应用启动且存在活跃项目时自动打开一次，
  // 会话内用户手动关闭后不再自动弹出（ref 防抖，避免重渲染/切项目误触发）。
  const autoOpenedBoardRef = useRef(false);
  useEffect(() => {
    if (!hasProject || autoOpenedBoardRef.current) return;
    autoOpenedBoardRef.current = true;
    setProjectBoardOpen(true);
  }, [hasProject, setProjectBoardOpen]);

  // ⌘+G 快捷键：打开项目面板（与 Sidebar 项目看板按钮一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        setProjectBoardOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setProjectBoardOpen]);

  // 全局截图 OCR（Cmd+Shift+O）：订阅与编辑面板已迁移至全局宿主 ScreenOcrHost
  // （src/components/screen-ocr/ScreenOcrHost.tsx，挂在 layout.tsx），
  // 与画布挂载状态解耦，任何页面按快捷键都能弹编辑面板。
  // 注意：OCR 结果直插输入框（screen-ocr:result）链路已废弃，主进程不再发送该事件。

  // 创建项目
  const handleCreateProject = useCallback(async (name: string) => {
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', name }),
    });
    const data = await resp.json();
    if (data.success) {
      // 切换到新项目
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switch', project_id: data.project.id }),
      });
      window.location.reload();
    } else {
      throw new Error(data.error || '创建失败');
    }
  }, []);

  // 加载当前项目节点与连线（启动 + 无刷新切换项目时复用）。
  // 先加载节点，再加载连线，避免边引用不存在的节点；空项目自动创建初始节点。
  const loadProjectData = useCallback(async () => {
    const resp = await fetch('/api/nodes?action=list');
    const data = await resp.json();

    if (data.success && data.nodes && data.nodes.length > 0) {
      const restoredNodes = data.nodes.map((n: Record<string, unknown>, i: number) =>
        n.node_type === 'imageGen'
          ? restoredImageGenToFlowNode(n as Parameters<typeof restoredImageGenToFlowNode>[0], i)
          : n.node_type === 'bobby'
            ? restoredBobbyToFlowNode(n as Parameters<typeof restoredBobbyToFlowNode>[0], i)
            : n.node_type === 'agentTeams'
              ? restoredAgentTeamsToFlowNode(n as Parameters<typeof restoredAgentTeamsToFlowNode>[0], i)
              : n.node_type === 'annotation'
                ? restoredAnnotationToFlowNode(n as Parameters<typeof restoredAnnotationToFlowNode>[0])
                : restoredNodeToFlowNode(n as Parameters<typeof restoredNodeToFlowNode>[0], i),
      );
      setNodes(restoredNodes);

      // 节点就绪后再加载连线
      try {
        const edgeResp = await fetch('/api/edges?include_disconnected=true');
        const edgeData = await edgeResp.json();
        if (edgeData.success && edgeData.edges && edgeData.edges.length > 0) {
          const restoredEdges: Edge[] = edgeData.edges.map((e: { edge_id: string; from: string; to: string; edge_type: string; disconnected: boolean }) => ({
            id: e.edge_id,
            source: e.from,
            target: e.to,
            type: 'floating',
            data: {
              relation: edgeTypeToRelation(e.edge_type),
              disconnected: e.disconnected,
            },
          }));
          setEdges(restoredEdges);
        }
      } catch {
        // 恢复连线失败忽略
      }
    } else {
      // 没有节点时，自动创建一个初始节点：position 固定左上角，首次进入视口由 fit 居中到画布中央
      const INITIAL_POSITION = { x: 40, y: 40 };
      try {
        const createResp = await fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            title: 'AI Chat',
            model: DEFAULT_MODEL_ID,
            sources: [],
            position_x: INITIAL_POSITION.x,
            position_y: INITIAL_POSITION.y,
          }),
        });
        const createData = await createResp.json();
        if (createData.success) {
          const newNode: Node<AiChatNodeData> = {
            id: createData.node_id,
            type: 'aiChat',
            position: INITIAL_POSITION,
            data: {
              title: 'AI Chat',
              messages: [],
              isStreaming: false,
              modelId: DEFAULT_MODEL_ID,
              thinkingLevel: DEFAULT_THINKING_LEVEL,
              nodeMdId: createData.node_id,
            },
          };
          setNodes([newNode]);
          // 节点落库后把视口 fit 到该节点：新建项目的默认节点必须出现在画布正中间。
          // 初始视口 effect 与节点加载是异步的，可能先于 setNodes 执行导致 fit 落空，
          // 因此这里在节点就绪后再主动 fit 一次（rAF 保证 store 已提交）。
          // 注意：不能用会话级 userInteractedRef 拦截——用户此前拖过画布会永久置 true，
          // 导致无刷新切到新空项目时 fit 被误拦、初始节点留在左上角。
          requestAnimationFrame(() => {
            fitAllNodesWithSidebar({ padding: 0.4, maxZoom: 1, duration: 0 });
          });
        }
      } catch {
        // 创建初始节点失败忽略
      }
    }
  }, [setNodes, setEdges, fitAllNodesWithSidebar]);

  // 启动时恢复节点和连线（先加载节点，再加载连线，避免边引用不存在的节点）
  useEffect(() => {
    void loadProjectData();
  }, [loadProjectData]);

  // 无刷新切换项目：监听 Sidebar 广播的 bobagent:project-switched，
  // 更新 currentProjectId 并重载节点/连线数据（替代整页 reload，避免白屏闪烁）
  useEffect(() => {
    const handler = (e: Event) => {
      const projectId = ((e as CustomEvent).detail as { projectId?: string })?.projectId;
      if (!projectId) return;
      setCurrentProjectId(projectId);
      setHasProject(true);
      setSelectedNodeIds(new Set());
      void loadProjectData();
    };
    window.addEventListener('bobagent:project-switched', handler);
    return () => window.removeEventListener('bobagent:project-switched', handler);
  }, [loadProjectData]);

  // 节点间避让（单焦点画布 2026-09 起不再需要"展开时推开邻居"）：
  // 中栏同一时刻仅承载 focusedNodeId 一个研究节点，其余研究节点由 displayNodes 置 hidden，
  // 不存在展开节点与可见邻居重叠的场景；node-expanded/node-collapsed/node-expand-resize
  // 广播已随 ChatNodeKernel 恒展开收敛而整体移除（死链清理）。

  // 标签页/窗口从后台恢复可见时，轻量触发一次重绘（不再整体重挂载 ReactFlow，
  // 避免中止节点正在进行的流式任务 / 丢失节点展开等内部状态）
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestAnimationFrame(() => {
          try {
            // 读取视口触达 store，唤醒内部 RAF 循环
            getViewport();
          } catch { /* store 失活时忽略 */ }
        });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // ReactFlow 重新挂载（flowKey 变化）后：恢复当前项目最新持久化的视口，
  // 避免重挂载掉回默认 {0,0,1} 导致画布跳位
  useEffect(() => {
    const saved = readSavedViewport(currentProjectId);
    savedViewportRef.current = saved;
    if (saved) {
      requestAnimationFrame(() => {
        try {
          setViewport(saved);
        } catch {
          /* store 未就绪忽略，defaultViewport 已用同一 ref 兜底 */
        }
      });
    }
  }, [flowKey, currentProjectId, readSavedViewport, setViewport]);

  // 连线创建时持久化到数据库
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;

    // 所有连线统一为 child（横向/子节点）
    const relation = 'child' as const;
    const edgeType = 'parallel' as const;

    // 先锁定上游，再建边（避免 R-8 死锁）
    const srcNode = getNodes().find((n) => n.id === connection.source);
    const srcMdId = srcNode ? ((srcNode.data as AiChatNodeData).nodeMdId || connection.source) : connection.source;
    const ensureLocked = relation === 'child'
      ? lockUpstreamNode(srcMdId)
      : Promise.resolve<{ ok: boolean; error?: string }>({ ok: true });

    ensureLocked.then((lockRes) => {
      if (relation === 'child' && !lockRes.ok) {
        // 锁定失败（含用户取消强制锁定）：不建边
        console.error('[auto-lock] 锁定失败:', lockRes.error);
        alert('无法锁定上游节点：' + (lockRes.error || '未知错误') + '\n\n已取消连线。');
        return;
      }
      return fetch('/api/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          from: connection.source,
          to: connection.target,
          edge_type: edgeType,
        }),
      }).then((r) => r.json()).then((data) => {
        if (data.success && data.edge) {
          const newEdge: Edge = {
            id: data.edge.edge_id,
            source: data.edge.from,
            target: data.edge.to,
            // 带 sourceHandle 的节点（多 handle 节点 →/↔）必须回传 sourceHandle，否则边不渲染
            sourceHandle: connection.sourceHandle ?? undefined,
            type: 'floating',
            data: {
              relation,
              disconnected: data.edge.disconnected ?? false,
            },
          };
          setEdges((eds) => addEdge(newEdge, eds));
        } else if (data.message === '连线已存在') {
          // 连线已存在，不做处理
        } else {
          console.error('连线保存失败:', data.error);
        }
      }).catch((err) => {
        console.error('连线保存出错:', err);
      });
    }).catch((err) => {
      console.error('[auto-lock] 出错:', err);
    });
  }, [setEdges, getNodes, lockUpstreamNode]);

  // 连线删除时从数据库彻底删除（键盘 Delete/Backspace 触发硬删除）
  const onEdgesDelete = useCallback((deletedEdges: Edge[]) => {
    for (const edge of deletedEdges) {
      fetch('/api/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'hard_delete',
          edge_id: edge.id,
        }),
      }).catch((err) => {
        console.error('连线删除出错:', err);
      });
    }
  }, []);

  // 键盘删除节点前的风险确认（Backspace/Delete 触发；返回 false 取消删除）
  const onBeforeDelete = useCallback(async ({ nodes: delNodes, edges: delEdges }: { nodes: Node[]; edges: Edge[] }) => {
    if (!delNodes.length) return true;
    // Bobby node / Agent Teams node 禁用键盘删除（防误删）：只能通过节点标题栏的 ✕ 按钮删除
    if (delNodes.some((n) => n.type === 'bobby' || n.type === 'agentTeams')) {
      await confirmAsk({
        title: '观察节点',
        message: 'Bobby / Agent Teams 节点不支持键盘删除。请点击节点标题栏的 ✕ 按钮执行删除。',
      });
      return false;
    }
    // 批注框（annotation）：轻量确认，不弹"删除文档"严重警告（不影响被包裹的卡片）
    if (delNodes.every((n) => n.type === 'annotation')) {
      return confirmAsk({
        title: delNodes.length > 1 ? `Delete ${delNodes.length} annotations?` : 'Delete annotation?',
        message: '删除批注框（不影响被包裹的卡片）。',
      });
    }
    const nodeTitles = delNodes.map((n) => (n.data as AiChatNodeData | undefined)?.title || n.id);
    const outboundCount = delEdges.filter((e) => delNodes.some((n) => n.id === e.source)).length;
    const plural = delNodes.length > 1 ? 's' : '';
    const messageLines = [
      `Deleting ${delNodes.length} node${plural} will permanently remove their .md documents (outcome, conversations, annotations, citations), attachments, generated output files (homework/), and ${delEdges.length} connected edge(s).`,
      `Nodes: ${nodeTitles.join(', ')}`,
    ];
    if (outboundCount > 0) {
      messageLines.push(
        `Some of these nodes are upstream of ${outboundCount} node(s). Deleting them will break their upstream references and may invalidate their conclusions.`,
      );
    }
    messageLines.push('This action cannot be undone.');
    return confirmAsk({
      title: delNodes.length > 1 ? `Delete ${delNodes.length} Nodes?` : 'Delete Node?',
      message: messageLines.join('\n'),
    });
  }, [confirmAsk, getNodes]);

  // 键盘删除确认通过后，硬删除节点的磁盘档案（与标题栏 ✕ 按钮行为一致）
  const onNodesDelete = useCallback((deletedNodes: Node[]) => {
    for (const node of deletedNodes) {
      const nodeMdId = (node.data as AiChatNodeData | undefined)?.nodeMdId || node.id;
      // 收集本节点关联的附件目录（含发送后未持久化到 md 的附件），
      // 与标题栏 ✕ 按钮行为一致，避免 attachments/{folder} 残留
      const attachmentFolders = new Set<string>();
      const nData = node.data as AiChatNodeData | undefined;
      for (const msg of nData?.messages || []) {
        for (const att of msg.attachments || []) {
          const m = att.path?.match(/^(?:attachments|assets)\/([^/]+)\//);
          if (m) attachmentFolders.add(m[1]);
        }
      }
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          node_id: nodeMdId,
          attachmentFolders: Array.from(attachmentFolders),
        }),
      }).catch((err) => {
        console.error('节点删除出错:', err);
      });
    }
    window.dispatchEvent(new CustomEvent('local-files-changed'));
  }, [getNodes, setNodes, setEdges]);

  // 左栏会话树删除入口（2026-09：删除 ✕ 从标题栏迁至左栏行 hover）：
  // 确认后移除节点/关联边 + 删除磁盘档案/附件，行为与键盘删除 onNodesDelete 一致
  const deleteNodeFromRail = useCallback(async (nodeId: string) => {
    const node = getNodes().find((n) => n.id === nodeId);
    if (!node) return;
    const nData = node.data as AiChatNodeData | undefined;
    const nodeMdId = nData?.nodeMdId || nodeId;
    const nodeTitle = nData?.title || 'Untitled Node';
    // 附件目录收集（与 onNodesDelete 一致），避免 attachments/{folder} 残留
    const attachmentFolders = new Set<string>();
    for (const msg of nData?.messages || []) {
      for (const att of msg.attachments || []) {
        const m = att.path?.match(/^(?:attachments|assets)\/([^/]+)\//);
        if (m) attachmentFolders.add(m[1]);
      }
    }
    const ok = await confirmAsk({
      title: 'Delete Node?',
      message: `Deleting "${nodeTitle}" will permanently remove its .md document (outcome, conversations, annotations, citations), attachments, generated output files (homework/), and connected edges.\nThis action cannot be undone.`,
    });
    if (!ok) return;
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        node_id: nodeMdId,
        attachmentFolders: Array.from(attachmentFolders),
      }),
    }).catch((err) => {
      console.error('节点删除出错:', err);
    });
    window.dispatchEvent(new CustomEvent('local-files-changed'));
  }, [confirmAsk, getNodes, setNodes, setEdges]);

  const handleNodesChange = useCallback((changes: NodeChange<Node<AiChatNodeData>>[]) => {
    // 广播节点选中变化：Sidebar 订阅后高亮 homework 中对应的节点分组
    //    （select change 逐个触发，最后一条生效；selected=false 表示取消选中）
    for (const c of changes) {
      if (c.type === 'select' && typeof c.selected === 'boolean') {
        window.dispatchEvent(new CustomEvent('node-selected', { detail: { node_id: c.selected ? c.id : null } }));
      }
    }
    onNodesChange(changes);
  }, [onNodesChange]);

  // ---- 批注框（annotation）拖动联动：拖动批注框时带动其包裹的卡片一起平移 ----
  const noteClusterDragRef = useRef<{
    rootId: string;
    othersStart: Record<string, { x: number; y: number }>;
    startX: number;
    startY: number;
  } | null>(null);
  // 批注框（annotation）拖动中标记：跟随包裹 effect 暂停，避免拖动时被拉回包围盒
  const annotationDragActiveRef = useRef(false);
  // 拖拽期间被"节点间不重叠"推开的节点集合：拖拽停止时批量持久化新位置
  const dragPushedRef = useRef<Set<string>>(new Set());

  // 拖拽开始：仅批注框（annotation）登记联动，记录被包裹卡片起始位置
  const onNodeDragStart: OnNodeDrag = useCallback((_, node) => {
    if (node.type === 'annotation') {
      const ids = (node.data as AiChatNodeData).annotationNodeIds ?? [];
      const othersStart: Record<string, { x: number; y: number }> = {};
      for (const id of ids) {
        const n = getNodes().find((nd) => nd.id === id);
        if (n) othersStart[id] = { x: n.position.x, y: n.position.y };
      }
      noteClusterDragRef.current = {
        rootId: node.id,
        othersStart,
        startX: node.position.x,
        startY: node.position.y,
      };
      annotationDragActiveRef.current = true;
    }
  }, [getNodes]);

  // 拖拽中：根节点位移 delta 应用到簇内其他卡片（绝对位置 = 起始 + delta，避免重复累加）；
  // 普通节点拖拽同时触发"节点间不重叠"——把被拖节点盖住的自由节点沿最小位移轴推开（拖拽节点固定）
  const onNodeDrag: OnNodeDrag = useCallback((_, node) => {
    const drag = noteClusterDragRef.current;
    if (drag && drag.rootId === node.id && Object.keys(drag.othersStart).length > 0) {
      const dx = node.position.x - drag.startX;
      const dy = node.position.y - drag.startY;
      setNodes((nds) =>
        nds.map((n) => {
          const s = drag.othersStart[n.id];
          return s ? { ...n, position: { x: s.x + dx, y: s.y + dy } } : n;
        }),
      );
      return;
    }
    // 批注框拖动不做避让：批注框本就包裹卡片（其联动移动在上面已处理）
    if (node.type === 'annotation') return;
    const fixed: OverlapRect = {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      w: node.measured?.width ?? 400,
      h: node.measured?.height ?? 400,
      fixed: true,
    };
    const freeRects: OverlapRect[] = getNodes()
      .filter((n) => n.id !== node.id)
      .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? 400, h: n.measured?.height ?? 400 }));
    const resolved = resolveNodeOverlaps([fixed, ...freeRects]);
    if (resolved.size === 0) return;
    for (const id of resolved.keys()) dragPushedRef.current.add(id);
    setNodes((nds) =>
      nds.map((n) => {
        const p = resolved.get(n.id);
        return p ? { ...n, position: p } : n;
      }),
    );
  }, [getNodes, setNodes]);

  // 拖拽停止：持久化节点位置到 .md frontmatter（重启后恢复布局）
  const onNodeDragStop: OnNodeDrag = useCallback((_, node) => {
    const drag = noteClusterDragRef.current;
    noteClusterDragRef.current = null;
    annotationDragActiveRef.current = false;
    // 取整吸附：拖拽终点可能是半像素坐标（缩放≠100% 时），子像素位置会让节点文字持续发虚
    const rx = Math.round(node.position.x);
    const ry = Math.round(node.position.y);
    if (rx !== node.position.x || ry !== node.position.y) {
      setNodes((nds) =>
        nds.map((n) => (n.id === node.id ? { ...n, position: { x: rx, y: ry } } : n)),
      );
    }
    const persist = (id: string, x: number, y: number) => {
      const mdId = id;
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_position', node_id: mdId, position_x: x, position_y: y }),
      }).catch(() => {});
    };
    const nodeMdId = (node.data as AiChatNodeData | undefined)?.nodeMdId || node.id;
    if (nodeMdId) persist(nodeMdId, rx, ry);

    // 被"节点间不重叠"推开的节点：批量持久化新位置（拖拽是显式操作，避让结果保留）
    if (dragPushedRef.current.size > 0) {
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of getNodes()) {
        if (!dragPushedRef.current.has(n.id)) continue;
        positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      }
      dragPushedRef.current.clear();
      if (Object.keys(positions).length > 0) {
        window.dispatchEvent(new CustomEvent('nodes-position-changed', { detail: { positions } }));
      }
    }

    // 簇内其他卡片被编程平移（不走各自拖拽事件），需手动批量持久化
    if (drag && drag.rootId === node.id && Object.keys(drag.othersStart).length > 0) {
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of getNodes()) {
        const s = drag.othersStart[n.id];
        if (!s) continue;
        positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      }
      window.dispatchEvent(new CustomEvent('nodes-position-changed', { detail: { positions } }));
    }
  }, [setNodes, getNodes]);

  // 批注框自动跟随包裹：卡片位置/尺寸变化时，annotation 节点实时重算包围盒并同步；
  // 关联卡片全部删除 → 删除批注框；批注框自身拖动中（annotationDragActiveRef）暂停跟随
  useEffect(() => {
    const annotations = nodes.filter((n) => n.type === 'annotation');
    if (annotations.length === 0) return;
    if (annotationDragActiveRef.current) return;
    const PAD = 24;
    let changed = false;
    const deadIds: string[] = [];
    const next = nodes.map((n) => {
      if (n.type !== 'annotation') return n;
      const data = n.data as AiChatNodeData;
      const ids = data.annotationNodeIds ?? [];
      if (ids.length === 0) return n;
      const live = ids.filter((id) => nodes.some((nn) => nn.id === id));
      if (live.length === 0) {
        deadIds.push(n.id);
        return n;
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of live) {
        const c = nodes.find((nn) => nn.id === id);
        if (!c) continue;
        const w = c.measured?.width ?? 220;
        const h = c.measured?.height ?? 110;
        minX = Math.min(minX, c.position.x);
        minY = Math.min(minY, c.position.y);
        maxX = Math.max(maxX, c.position.x + w);
        maxY = Math.max(maxY, c.position.y + h);
      }
      if (!Number.isFinite(minX)) return n;
      const box = {
        x: Math.round(minX - PAD),
        y: Math.round(minY - PAD),
        w: Math.round(maxX - minX + PAD * 2),
        h: Math.round(maxY - minY + PAD * 2),
      };
      const near =
        Math.abs(n.position.x - box.x) < 0.5 &&
        Math.abs(n.position.y - box.y) < 0.5 &&
        Math.abs((data.annotationWidth ?? 0) - box.w) < 0.5 &&
        Math.abs((data.annotationHeight ?? 0) - box.h) < 0.5;
      if (near && live.length === ids.length) return n;
      changed = true;
      return {
        ...n,
        position: { x: box.x, y: box.y },
        data: {
          ...data,
          annotationNodeIds: live,
          annotationWidth: box.w,
          annotationHeight: box.h,
        },
      };
    });
    if (deadIds.length > 0) {
      changed = true;
      for (const id of deadIds) {
        fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', node_id: id }),
        }).catch(() => {});
      }
    }
    if (changed) setNodes(() => next.filter((n) => !deadIds.includes(n.id)));
  }, [nodes, setNodes]);

  // NodeMap Fit 自动排版后：批量持久化新位置（Fit 不走拖拽事件，需显式保存）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ positions: Record<string, { x: number; y: number }> }>).detail;
      const positions = detail?.positions;
      if (!positions) return;
      for (const n of getNodes()) {
        const pos = positions[n.id];
        if (!pos) continue;
        const nodeMdId = (n.data as AiChatNodeData | undefined)?.nodeMdId || n.id;
        if (!nodeMdId) continue;
        fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update_position',
            node_id: nodeMdId,
            position_x: pos.x,
            position_y: pos.y,
          }),
        }).catch(() => {
          // 单个节点保存失败不影响其他节点
        });
      }
    };
    window.addEventListener('nodes-position-changed', handler);
    return () => window.removeEventListener('nodes-position-changed', handler);
  }, [getNodes]);


  // 双击空白处创建新节点
  // 在画布空白位置创建一个普通 AI Chat 节点（双击画布 / 右键菜单 → AI Chat 节点共用）
  const createPlainNode = useCallback((position: { x: number; y: number }) => {
    // 立即创建节点文件，获取稳定 ID（带初始位置，重启恢复布局）；node_type 写入 frontmatter（命名四层约定）
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        title: 'AI Chat',
        model: DEFAULT_MODEL_ID,
        sources: [],
        node_type: 'chat',
        position_x: position.x,
        position_y: position.y,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const nodeId = data.node_id;
          const newNode: Node<AiChatNodeData> = {
            id: nodeId,
            type: agentFlowType('chat'),
            position,
            data: {
              title: 'AI Chat',
              messages: [],
              isStreaming: false,
              modelId: DEFAULT_MODEL_ID,
              thinkingLevel: DEFAULT_THINKING_LEVEL,
              nodeMdId: nodeId,
              initialExpanded: true,
            },
          };
          setNodes((nds) => [...nds, newNode]);
          // 新建即选中并聚焦输入框（ChatGPT 式「点新建即打字」）：等待节点挂载后再聚焦
          setSelectedNodeIds(new Set([nodeId]));
          // 单焦点：新建 = 打开为新对话（New Chat 语义）
          openNewlyCreatedNode(nodeId);
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('chat-composer-focus', { detail: { node_id: nodeId } }));
          }, 120);
        }
      })
      .catch(() => {
        // 创建失败时使用临时 ID（降级），同时生成 UUID 作为 nodeMdId
        const id = `node-${Date.now()}-${nodeIdCounter.current++}`;
        const newNode: Node<AiChatNodeData> = {
          id,
          type: agentFlowType('chat'),
          position,
          data: {
            title: 'AI Chat',
            messages: [],
            isStreaming: false,
            modelId: DEFAULT_MODEL_ID,
            thinkingLevel: DEFAULT_THINKING_LEVEL,
            nodeMdId: id, // 降级节点也需要 nodeMdId
            initialExpanded: true,
          },
        };
        setNodes((nds) => [...nds, newNode]);
        setSelectedNodeIds(new Set([id]));
        openNewlyCreatedNode(id);
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('chat-composer-focus', { detail: { node_id: id } }));
        }, 120);
      });
  }, [setNodes, setSelectedNodeIds, openNewlyCreatedNode]);

  // 创建知识库（Kar / Notes）Agent 节点：Karpathy LLM Wiki 管理员，专属系统提示 + 笔记工具画像
  const createNoteAgentNode = useCallback((position: { x: number; y: number }) => {
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        title: 'Kar',
        model: DEFAULT_MODEL_ID,
        sources: [],
        node_type: agentFlowType('note'),
        position_x: position.x,
        position_y: position.y,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const nodeId = data.node_id;
          const newNode: Node<AiChatNodeData> = {
            id: nodeId,
            type: agentFlowType('note'),
            position,
            data: {
              title: 'Kar',
              messages: [],
              isStreaming: false,
              modelId: DEFAULT_MODEL_ID,
              thinkingLevel: DEFAULT_THINKING_LEVEL,
              nodeMdId: nodeId,
              initialExpanded: true,
            },
          };
          setNodes((nds) => [...nds, newNode]);
          // 单焦点：新建 Kar = 打开为新对话
          openNewlyCreatedNode(nodeId);
        }
      })
      .catch(() => {
        // 创建失败降级：临时 ID（无 .md 持久化）
        const id = `node-${Date.now()}-${nodeIdCounter.current++}`;
        const newNode: Node<AiChatNodeData> = {
          id,
          type: agentFlowType('note'),
          position,
          data: {
            title: 'Kar',
            messages: [],
            isStreaming: false,
            modelId: DEFAULT_MODEL_ID,
            thinkingLevel: DEFAULT_THINKING_LEVEL,
            nodeMdId: id,
            initialExpanded: true,
          },
        };
        setNodes((nds) => [...nds, newNode]);
        openNewlyCreatedNode(id);
      });
  }, [setNodes, openNewlyCreatedNode]);

  // 通用专项 Agent 节点创建（node_type = agent-<id>，frontmatter 写入；节点壳 identity 由 AGENT_NODE_SHELLS 派生）
  const createAgentNode = useCallback(
    (identity: string, label: string, position: { x: number; y: number }) => {
      const flowType = agentFlowType(identity);
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: label,
          model: DEFAULT_MODEL_ID,
          sources: [],
          node_type: flowType,
          position_x: position.x,
          position_y: position.y,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            const nodeId = data.node_id;
            const newNode: Node<AiChatNodeData> = {
              id: nodeId,
              type: flowType,
              position,
              data: {
                title: label,
                messages: [],
                isStreaming: false,
                modelId: DEFAULT_MODEL_ID,
                thinkingLevel: DEFAULT_THINKING_LEVEL,
                nodeMdId: nodeId,
                initialExpanded: true,
              },
            };
            setNodes((nds) => [...nds, newNode]);
            // 新建即选中并聚焦输入框（ChatGPT 式「点新建即打字」）：等待节点挂载后再聚焦
            setSelectedNodeIds(new Set([nodeId]));
            // 单焦点：新建专项 Agent = 打开为新对话
            openNewlyCreatedNode(nodeId);
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('chat-composer-focus', { detail: { node_id: nodeId } }));
            }, 120);
          }
        })
        .catch(() => {
          const id = `node-${Date.now()}-${nodeIdCounter.current++}`;
          const newNode: Node<AiChatNodeData> = {
            id,
            type: flowType,
            position,
            data: {
              title: label,
              messages: [],
              isStreaming: false,
              modelId: DEFAULT_MODEL_ID,
              thinkingLevel: DEFAULT_THINKING_LEVEL,
              nodeMdId: id,
              initialExpanded: true,
            },
          };
          setNodes((nds) => [...nds, newNode]);
          setSelectedNodeIds(new Set([id]));
          openNewlyCreatedNode(id);
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('chat-composer-focus', { detail: { node_id: id } }));
          }, 120);
        });
    },
    [setNodes, setSelectedNodeIds, openNewlyCreatedNode],
  );

  // 在指定位置创建图像生成节点（文生图/图生图独立工作台，与 AI Chat 节点并列）
  const createImageGenNode = useCallback((position: { x: number; y: number }) => {
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        title: 'Image Generation',
        model: DEFAULT_MODEL_ID,
        sources: [],
        node_type: 'imageGen',
        position_x: position.x,
        position_y: position.y,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const nodeId = data.node_id;
          const newNode = {
            id: nodeId,
            type: 'imageGen' as const,
            position,
            data: { title: 'Image Generation', mode: 'generate' as const, prompt: '', size: '1024x1024' },
          } as unknown as Node<AiChatNodeData>;
          setNodes((nds) => [...nds, newNode]);
        }
      })
      .catch(() => {
        // 创建失败时使用临时 ID（降级）
        const id = `image-${Date.now()}-${nodeIdCounter.current++}`;
        const newNode = {
          id,
          type: 'imageGen' as const,
          position,
          data: { title: 'Image Generation', mode: 'generate' as const, prompt: '', size: '1024x1024' },
        } as unknown as Node<AiChatNodeData>;
        setNodes((nds) => [...nds, newNode]);
      });
  }, [setNodes]);

  // 在指定位置创建多 Agent 编排节点（薄客户端，只对接 bobby-mcp）
  const createBobbyNode = useCallback(
    (position: { x: number; y: number }, opts?: { sourceNodeId?: string; autoFocus?: boolean }) => {
      // 可选：创建成功后建立「sourceNodeId → BobbyNode」连线（edge_type 'bobby'，恢复时映射为 child）
      const linkAfter = (bobbyId: string) => {
        const source = opts?.sourceNodeId;
        if (!source) return;
        fetch('/api/edges', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', from: source, to: bobbyId, edge_type: 'bobby' }),
        })
          .then((r) => r.json())
          .then((ed) => {
            if (ed.success && ed.edge) {
              setEdges((eds) =>
                addEdge(
                  {
                    id: ed.edge.edge_id,
                    source: ed.edge.from,
                    target: ed.edge.to,
                    type: 'floating',
                    animated: true, // 信号流动感：Bobby 执行时连线上的小方块流动
                    data: { relation: 'child', disconnected: ed.edge.disconnected ?? false },
                  },
                  eds,
                ),
              );
            }
          })
          .catch(() => { /* 连线失败忽略 */ });
      };

      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: 'Bobby node',
          model: DEFAULT_MODEL_ID,
          sources: [],
          node_type: 'bobby',
          position_x: position.x,
          position_y: position.y,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            const nodeId = data.node_id;
            const newNode = {
              id: nodeId,
              type: 'bobby' as const,
              position,
              data: { title: 'Bobby node', prompt: '', status: 'idle' as const, nodeMdId: nodeId },
            } as unknown as Node<AiChatNodeData>;
            setNodes((nds) => [...nds, newNode]);
            linkAfter(nodeId);
            if (opts?.autoFocus) {
              fitView({ nodes: [{ id: nodeId }] as unknown as Node[], duration: 600, padding: 0.25 });
            }
          }
        })
        .catch(() => {
          // 创建失败时使用临时 ID（降级）
          const id = `bobby-${Date.now()}-${nodeIdCounter.current++}`;
          const newNode = {
            id,
            type: 'bobby' as const,
            position,
            data: { title: 'Bobby node', prompt: '', status: 'idle' as const, nodeMdId: id },
          } as unknown as Node<AiChatNodeData>;
          setNodes((nds) => [...nds, newNode]);
        });
    },
    [setNodes, setEdges, fitView],
  );

  // 主 Agent 调用 Bobby 插件工具 → 自动打开 BobbyNode 并建立连线（"一条连线打开"）
  // 语义：复用画布已有 BobbyNode（高亮 + 滚动定位 + 补线）；没有则自动创建在发起节点右下方。
  const openBobbyNodeFor = useCallback(
    (sourceNodeId: string) => {
      const existing = getNodes().find((n) => n.type === 'bobby');
      if (existing) {
        // 复用已有：高亮选中 + 补线（若尚未连接）+ 滚动定位
        setNodes((nds) => nds.map((n) => (n.id === existing.id ? { ...n, selected: true } : n)));
        const hasEdge = getEdges().some((e) => e.source === sourceNodeId && e.target === existing.id);
        if (!hasEdge) {
          fetch('/api/edges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create', from: sourceNodeId, to: existing.id, edge_type: 'bobby' }),
          })
            .then((r) => r.json())
            .then((ed) => {
              if (ed.success && ed.edge) {
                setEdges((eds) =>
                  addEdge(
                    {
                      id: ed.edge.edge_id,
                      source: ed.edge.from,
                      target: ed.edge.to,
                      type: 'floating',
                      animated: true,
                      data: { relation: 'child', disconnected: ed.edge.disconnected ?? false },
                    },
                    eds,
                  ),
                );
              }
            })
            .catch(() => { /* 忽略 */ });
        }
        fitView({ nodes: [{ id: existing.id }] as unknown as Node[], duration: 600, padding: 0.25 });
        return;
      }
      // 无 BobbyNode → 在发起节点右下方自动创建 + 连线 + 定位
      const src = getNodes().find((n) => n.id === sourceNodeId);
      const pos = {
        x: (src?.position.x ?? 400) + 500,
        y: (src?.position.y ?? 200) + 40,
      };
      createBobbyNode(pos, { sourceNodeId, autoFocus: true });
    },
    [getNodes, getEdges, setNodes, setEdges, fitView, createBobbyNode],
  );

  // 监听 ChatNodeKernel 广播的 Bobby 触发事件（主 Agent 调用了 Bobby 工具）
  useEffect(() => {
    const onBobbyTrigger = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId?: string; tool?: string }>).detail;
      if (!detail?.nodeId) return;
      openBobbyNodeFor(detail.nodeId);
    };
    window.addEventListener('bobby:trigger', onBobbyTrigger);
    return () => window.removeEventListener('bobby:trigger', onBobbyTrigger);
  }, [openBobbyNodeFor]);

  // 在指定位置创建 Agent Teams 观察节点（薄客户端，只对接 /api/team）
  const createAgentTeamsNode = useCallback(
    (position: { x: number; y: number }, opts?: { sourceNodeId?: string; autoFocus?: boolean }) => {
      const linkAfter = (teamId: string) => {
        const source = opts?.sourceNodeId;
        if (!source) return;
        fetch('/api/edges', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', from: source, to: teamId, edge_type: 'team' }),
        })
          .then((r) => r.json())
          .then((ed) => {
            if (ed.success && ed.edge) {
              setEdges((eds) =>
                addEdge(
                  {
                    id: ed.edge.edge_id,
                    source: ed.edge.from,
                    target: ed.edge.to,
                    type: 'floating',
                    animated: true, // 信号流动感：团队执行时连线上的小方块流动
                    data: { relation: 'child', disconnected: ed.edge.disconnected ?? false },
                  },
                  eds,
                ),
              );
            }
          })
          .catch(() => { /* 连线失败忽略 */ });
      };

      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: 'Agent Teams',
          model: DEFAULT_MODEL_ID,
          sources: [],
          node_type: 'agentTeams',
          position_x: position.x,
          position_y: position.y,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            const nodeId = data.node_id;
            const newNode = {
              id: nodeId,
              type: 'agentTeams' as const,
              position,
              data: { title: 'Agent Teams', prompt: '', status: 'idle' as const, nodeMdId: nodeId },
            } as unknown as Node<AiChatNodeData>;
            setNodes((nds) => [...nds, newNode]);
            linkAfter(nodeId);
            if (opts?.autoFocus) {
              fitView({ nodes: [{ id: nodeId }] as unknown as Node[], duration: 600, padding: 0.25 });
            }
          }
        })
        .catch(() => {
          // 创建失败时使用临时 ID（降级）
          const id = `team-${Date.now()}-${nodeIdCounter.current++}`;
          const newNode = {
            id,
            type: 'agentTeams' as const,
            position,
            data: { title: 'Agent Teams', prompt: '', status: 'idle' as const, nodeMdId: id },
          } as unknown as Node<AiChatNodeData>;
          setNodes((nds) => [...nds, newNode]);
        });
    },
    [setNodes, setEdges, fitView],
  );

  // 主 Agent 调用团队编排工具 → 自动打开 AgentTeamsNode 并建立连线（"一条连线打开"）
  // 语义：复用画布已有节点（高亮 + 滚动定位 + 补线）；没有则自动创建在发起节点右下方。
  const openTeamNodeFor = useCallback(
    (sourceNodeId: string) => {
      const existing = getNodes().find((n) => n.type === 'agentTeams');
      if (existing) {
        setNodes((nds) => nds.map((n) => (n.id === existing.id ? { ...n, selected: true } : n)));
        const hasEdge = getEdges().some((e) => e.source === sourceNodeId && e.target === existing.id);
        if (!hasEdge) {
          fetch('/api/edges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create', from: sourceNodeId, to: existing.id, edge_type: 'team' }),
          })
            .then((r) => r.json())
            .then((ed) => {
              if (ed.success && ed.edge) {
                setEdges((eds) =>
                  addEdge(
                    {
                      id: ed.edge.edge_id,
                      source: ed.edge.from,
                      target: ed.edge.to,
                      type: 'floating',
                      animated: true,
                      data: { relation: 'child', disconnected: ed.edge.disconnected ?? false },
                    },
                    eds,
                  ),
                );
              }
            })
            .catch(() => { /* 忽略 */ });
        }
        fitView({ nodes: [{ id: existing.id }] as unknown as Node[], duration: 600, padding: 0.25 });
        return;
      }
      const src = getNodes().find((n) => n.id === sourceNodeId);
      const pos = {
        x: (src?.position.x ?? 400) + 500,
        y: (src?.position.y ?? 200) + 40,
      };
      createAgentTeamsNode(pos, { sourceNodeId, autoFocus: true });
    },
    [getNodes, getEdges, setNodes, setEdges, fitView, createAgentTeamsNode],
  );

  // 监听 ChatNodeKernel 广播的 Agent Teams 触发事件（主 Agent 调用了 mcp__team__* 工具）
  useEffect(() => {
    const onTeamTrigger = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId?: string; tool?: string }>).detail;
      if (!detail?.nodeId) return;
      openTeamNodeFor(detail.nodeId);
    };
    window.addEventListener('team:trigger', onTeamTrigger);
    return () => window.removeEventListener('team:trigger', onTeamTrigger);
  }, [openTeamNodeFor]);

  // 监听 Bobby 运行状态 → 控制连线"电流"：执行中 animated=true（信号流动），闲置 false（静止）
  useEffect(() => {
    const onBobbyRunState = (e: Event) => {
      const detail = (e as CustomEvent<{ running?: boolean }>).detail;
      const running = detail?.running === true;
      const bobbyNode = getNodes().find((n) => n.type === 'bobby');
      if (!bobbyNode) return;
      setEdges((eds) =>
        eds.map((ed) =>
          ed.target === bobbyNode.id || (ed.data as { relation?: string } | undefined)?.relation === 'bobby'
            ? { ...ed, animated: running }
            : ed,
        ),
      );
    };
    window.addEventListener('bobby:run-state', onBobbyRunState);
    return () => window.removeEventListener('bobby:run-state', onBobbyRunState);
  }, [getNodes, setEdges]);

  // 判断是否命中画布空白区域（节点、UI浮层、Handle、自定义组件之上都不算空白）
  // 只有空白处才允许触发画布拖拽/平移，避免操作其他功能时"顺手"把画布动了
  const isHittingCanvasBlank = useCallback((event: React.MouseEvent | React.PointerEvent | MouseEvent): boolean => {
    const target = event.target as HTMLElement;
    if (!target) return false;

    // 1. 命中节点内部（任何节点类型） → 不是空白
    if (target.closest('.react-flow__node')) return false;
    // 2. 命中 Handle（连线端点） → 不是空白
    if (target.closest('.react-flow__handle')) return false;
    // 3. 命中连线（edge）本身 → 不是空白
    if (target.closest('.react-flow__edge')) return false;
    // 4. 命中迷你图、标注等内置控件 → 不是空白
    if (target.closest('.react-flow__minimap, .react-flow__attribution')) return false;
    // 5. 命中用户自定义浮层（所有统一管理的 panel / dialog / popup）→ 不是空白
    if (target.closest('[data-canvas-ui="overlay"]')) return false;

    // 7. 命中 React Flow 本体 pane 或 Background → 才是真正空白
    const hitPane = !!(
      target.closest('.react-flow__pane') ||
      target.classList.contains('react-flow__background') ||
      target.tagName?.toLowerCase() === 'svg' && target.closest('.react-flow__renderer') && !target.closest('.react-flow__edge, .react-flow__node, .react-flow__handle')
    );
    // 如果是最外层 wrapper（点击到了 RF 外部 wrapper 边缘）也按空白处理
    const hitWrapper = wrapperRef.current && wrapperRef.current.contains(target) &&
      target === wrapperRef.current;

    return hitPane || !!hitWrapper;
  }, []);

  // 平移 开始（仅左键 + 命中空白区域 + 排除连线拖拽）
  const onPaneClickStart = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return; // 仅左键

      const target = event.target as HTMLElement;

      // 核心：命中了任何"非空白"元素 → 不启动平移
      if (!isHittingCanvasBlank(event)) {
        if (target.closest('[data-canvas-ui="overlay"]')) {
          event.stopPropagation();
        }
        return;
      }

      // 排除 Handle 元素（连线拖拽）
      if (target.closest('.react-flow__handle')) return;

      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const vp = getViewport();
      dragSelectRef.current = {
        startX: event.clientX - rect.left,
        startY: event.clientY - rect.top,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewport: { x: vp.x, y: vp.y, zoom: vp.zoom },
        // mode=null：等超过 5px 阈值再判定进入平移
        mode: null,
        hadDrag: false,
        panTarget: null,
      };
    },
    [isHittingCanvasBlank, getViewport],
  );

  // 平移拖拽（统一 5px 阈值：<5px 当作点击，≥5px 进入画布平移）
  const onPaneMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (dragSelectRef.current.mode === 'off') return;

      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const currentX = event.clientX - rect.left;
      const currentY = event.clientY - rect.top;

      const dx = currentX - dragSelectRef.current.startX;
      const dy = currentY - dragSelectRef.current.startY;

      // ========= 1) 阈值内：啥也不做，当作"点"（不平移，避免手抖抖动一下画布）=========
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

      dragSelectRef.current.hadDrag = true;

      // ========= 2) 超过阈值，mode=null 时进入平移 =============
      if (dragSelectRef.current.mode === null) {
        dragSelectRef.current.mode = 'pan';
      }
      if (dragSelectRef.current.mode !== 'pan') return;

      // ========= 3) pan：rAF 节流平移（替换 ReactFlow 内置 pan）============
      const start = dragSelectRef.current.startViewport;
      const dxClient = event.clientX - dragSelectRef.current.startClientX;
      const dyClient = event.clientY - dragSelectRef.current.startClientY;
      // 只更新"目标视口"：mousemove 频率可达 100+Hz，若每个事件都 setViewport，
      // 节点多时会超过 16ms 帧预算导致掉帧/闪烁。这里把提交收敛到每帧一次。
      dragSelectRef.current.panTarget = {
        x: start.x + dxClient,
        y: start.y + dyClient,
        zoom: start.zoom,
      };
      if (panRafRef.current === null) {
        panRafRef.current = requestAnimationFrame(() => {
          panRafRef.current = null;
          const target = dragSelectRef.current.panTarget;
          if (!target) return;
          // 直接写 store，不触发 setViewport 的动画队列
          setViewport({ x: target.x, y: target.y, zoom: target.zoom }, { duration: 0 });
        });
      }
    },
    [setViewport],
  );

  // 平移结束
  const onPaneClickEnd = useCallback(() => {
    // 取消可能挂起的 pan rAF，并清掉待提交的目标视口
    if (panRafRef.current !== null) {
      cancelAnimationFrame(panRafRef.current);
      panRafRef.current = null;
    }
    dragSelectRef.current.panTarget = null;
    if (dragSelectRef.current.mode !== 'off') {
      dragSelectRef.current.mode = 'off';
    }
  }, []);

  // 点击空白处取消选中（排除框选拖拽后的 click 事件）
  // 注意：点击节点/连线/Handle/浮层等非空白区域时，click 也会冒泡到这里，
  // 必须跳过取消选中，否则节点刚被选中就被重置（"已执行节点点击输入框不弹出"的根因）。
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (!isHittingCanvasBlank(event)) return;
    if (dragSelectRef.current.hadDrag) {
      dragSelectRef.current.hadDrag = false;
      return;
    }
    setSelectedNodeIds(new Set());
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
  }, [isHittingCanvasBlank, setNodes]);

  // === 画布内自动聚焦已移除（用户要求选中节点不再自动放大画布） ===

  // 在画布视口中央创建新的 AI Chat 节点，返回节点 ID（无则 null）
  const handleCreateNode = useCallback(async (): Promise<string | null> => {
    const viewport = getViewport();
    const center = {
      x: -viewport.x / viewport.zoom + 200,
      y: -viewport.y / viewport.zoom + 100,
    };

    const resp = await fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        title: 'AI Chat',
        model: DEFAULT_MODEL_ID,
        sources: [],
        position_x: center.x,
        position_y: center.y,
      }),
    });

    const data = await resp.json();
    if (!data.success) return null;

    const newNode: Node<AiChatNodeData> = {
      id: data.node_id,
      type: 'aiChat',
      position: center,
      data: {
        title: 'AI Chat',
        messages: [],
        isStreaming: false,
        modelId: DEFAULT_MODEL_ID,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        nodeMdId: data.node_id,
        initialExpanded: true,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    // 单焦点：新建 AI Chat（划词/文件等入口）= 打开为新对话
    openNewlyCreatedNode(data.node_id as string);
    return data.node_id as string;
  }, [getViewport, setNodes, openNewlyCreatedNode]);

  // 划词追问「新建节点」：创建节点并把选中段落写入引用标签缓冲（新节点 kernel 挂载时消费为引用标签，等用户补写问题后发送）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (!detail?.text?.trim()) return;
      void (async () => {
        const nodeId = await handleCreateNode();
        if (!nodeId) return;
        const pendingRefMap = (window.__pendingNodeReference ??= {});
        pendingRefMap[nodeId] = detail.text.trim();
      })();
    };
    window.addEventListener('node-create-and-ask', handler);
    return () => window.removeEventListener('node-create-and-ask', handler);
  }, [handleCreateNode]);

  // NodeMap 拖拽建边请求：复刻画布拖拽连线的完整 onConnect 语义（先自动锁定上游源节点、
  // POST /api/edges create、成功后 addEdge + 子列布局）。成功经 edges store 自动回流到
  // NodeMap 缩略图；失败（锁定取消 / R-8 / 重复 / 环）沿用 onConnect 的 alert 提示。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ from?: string; to?: string }>).detail;
      if (!detail?.from || !detail?.to || detail.from === detail.to) return;
      onConnect({ source: detail.from, target: detail.to, sourceHandle: null, targetHandle: null });
    };
    window.addEventListener('edge-create-request', handler);
    return () => window.removeEventListener('edge-create-request', handler);
  }, [onConnect]);

  // 新建节点并从本地文件复制附件
  const handleCreateNodeWithFile = useCallback(async (filePath: string, isDir = false): Promise<{ nodeId: string; attachment: unknown } | null> => {
    const nodeId = await handleCreateNode();
    if (!nodeId) return null;

    // 子文件夹：不复制文件，直接返回操作目录附件（id 带 sent-folder: 前缀）
    if (isDir) {
      const name = filePath.split('/').filter(Boolean).pop() || filePath;
      return {
        nodeId,
        attachment: {
          id: `sent-folder:${filePath}`,
          name,
          type: 'folder',
          mimeType: 'application/x-folder',
          size: 0,
          path: filePath,
        },
      };
    }

    // 复制文件到新节点附件
    const attachmentResp = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add_from_local',
        sourcePath: filePath,
        nodeId,
        nodeTitle: 'AI Chat',
      }),
    });
    const attachmentData = await attachmentResp.json();
    return { nodeId, attachment: attachmentData.success ? attachmentData.attachment : null };
  }, [handleCreateNode]);

  // 当前项目 id 的 ref 副本：视口持久化 effect 闭包使用（避免 stale）
  const currentProjectIdRef = useRef(currentProjectId);
  currentProjectIdRef.current = currentProjectId;

  // 视口变更 150ms 防抖写入 localStorage（按项目隔离 key）；关闭窗口/切后台时立即 flush，
  // 避免"最后几次 pan 未落盘 → 下次打开误判无历史视口 → 自动 fit 全图居中"
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const write = () => {
      const [x, y, zoom] = rfStoreApi.getState().transform;
      const key = viewportStorageKey(currentProjectIdRef.current);
      try { localStorage.setItem(key, JSON.stringify({ x, y, zoom })); } catch {}
    };
    const unsub = rfStoreApi.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(write, 150);
    });
    const flush = () => {
      clearTimeout(timer);
      write();
    };
    const onVisibilityHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibilityHidden);
    return () => {
      clearTimeout(timer);
      unsub();
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibilityHidden);
    };
  }, [rfStoreApi]);

  // 监听"用 Image Gen 打开图片编辑"事件：预览页点 AI 编辑时，创建预载该图的 imageGen 节点并居中
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { dataUrl?: string; fileName?: string } | undefined;
      if (!detail?.dataUrl) return;

      const paneEl = document.querySelector('.react-flow__pane');
      const rect = paneEl?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      const position = screenToFlowPosition({ x: cx, y: cy });
      const finalPosition = {
        x: position.x + 20 + (Math.random() * 40 - 20),
        y: position.y + 60 + (Math.random() * 40 - 20),
      };
      const title = detail.fileName || 'Image Generation';

      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title,
          model: DEFAULT_MODEL_ID,
          sources: [],
          node_type: 'imageGen',
          position_x: finalPosition.x,
          position_y: finalPosition.y,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          const nodeId: string = data.success ? data.node_id : `image-${Date.now()}-${nodeIdCounter.current++}`;
          const newNode = {
            id: nodeId,
            type: 'imageGen' as const,
            position: finalPosition,
            data: { title, mode: 'edit' as const, prompt: '', size: '1024x1024', inputImage: detail.dataUrl },
          } as unknown as Node<AiChatNodeData>;
          setNodes((nds) => [...nds, newNode]);
          // 锁定态下跳过 fitView：锁定是最高优先级，不允许任何来源改变画布比例
          if (!zoomLocked) {
            requestAnimationFrame(() => fitAllNodesWithSidebar({ padding: 0.4, maxZoom: 1, duration: 400 }));
          }
        })
        .catch(() => {});
    };
    window.addEventListener('open-imagegen-editor', handler);
    return () => window.removeEventListener('open-imagegen-editor', handler);
  }, [screenToFlowPosition, setNodes, fitView, zoomLocked]);

  // 【核心】防止画布 pan/zoom 误触：在捕获阶段判断 mousedown 是否落在非空白元素上，
  // 若是则停止事件传播，阻止 React Flow 的 document 级 pan 监听器启动。
  // React Flow 的 panOnDrag 内部是 document.addEventListener('mousedown')，
  // 只有在 capture 阶段就调用 stopPropagation 才能真正挡住它。
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const onMouseDownCapture = (e: MouseEvent) => {
      // 只关心左键
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (!target) return;

      // 使用与 isHittingCanvasBlank 相同的逻辑
      const isBlank =
        !target.closest('.react-flow__node') &&
        !target.closest('.react-flow__handle') &&
        !target.closest('.react-flow__edge') &&
        !target.closest('.react-flow__controls') &&
        !target.closest('.react-flow__minimap, .react-flow__attribution') &&
        !target.closest('[data-canvas-ui="overlay"]') &&
        (
          !!target.closest('.react-flow__pane') ||
          target.classList?.contains('react-flow__background') ||
          (target.tagName?.toLowerCase() === 'svg' && !!target.closest('.react-flow__renderer') &&
            !target.closest('.react-flow__edge, .react-flow__node, .react-flow__handle')) ||
          target === wrapper
        );

      if (!isBlank) {
        // 命中了节点/浮层/UI控件：在捕获阶段就掐断冒泡，RF 内部 pan 监听根本收不到
        e.stopPropagation();
        // 注意：不能 preventDefault()，否则文本选择、按钮点击等原生交互会失效
      }
    };

    // 滚轮：在非空白区域（节点/浮层内）滚动时，阻止传播到 RF 的 panOnScroll / zoomOnScroll
    // 例外：Ctrl/⌘ + 滚轮 始终允许缩放，方便浏览流程图
    const onWheelCapture = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;

      // Ctrl/⌘ + 滚轮 = 缩放，始终放行
      if (e.ctrlKey || e.metaKey) return;

      const isOverlayOrNode =
        target.closest('.react-flow__node') ||
        target.closest('[data-canvas-ui="overlay"]') ||
        target.closest('.react-flow__controls');

      if (isOverlayOrNode) {
        e.stopPropagation();
      }
    };

    wrapper.addEventListener('mousedown', onMouseDownCapture, true); // capture: true
    wrapper.addEventListener('wheel', onWheelCapture, true);
    return () => {
      wrapper.removeEventListener('mousedown', onMouseDownCapture, true);
      wrapper.removeEventListener('wheel', onWheelCapture, true);
    };
  }, []);

  // 左列"新建"落点：聚焦节点下方（保留初始次序），否则用原点附近默认值
  const spawnSiblingPosition = useCallback(() => {
    const f = graphSnap.nodes.find((n) => n.id === focusedNodeId);
    return f ? { x: Math.round(f.x + 24), y: Math.round(f.y + 120) } : { x: 96, y: 96 };
  }, [graphSnap.nodes, focusedNodeId]);

  // 预览面板实体：折叠时若 ImageAiEditor 需保活，则用 display:none 隐藏挂载以延续生成；否则正常展示
  const readerPanelEl = (
    <UnifiedReaderPanel
      openReaderIds={openReaderIds}
      fileTabs={fileTabs}
      sandboxTabs={sandboxTabs}
      readerTitles={readerTitles}
      activePanelTab={activePanelTab}
      collapsed={false}
      panelWidth={panelWidth}
      onSelectTab={(type, id) => {
        setActivePanelTab({ type, id });
        if (type === 'node') {
          setActiveReaderId(id);
          lastActiveNodeIdRef.current = id;
        }
      }}
      onCloseNodeTab={closeReader}
      onCloseFileTab={closeFileTab}
      onCloseSandboxTab={closeSandboxTab}
      onCloseTemplateTab={closeTemplateTab}
      templateInitialScene={templateInitialScene}
      onToggleCollapse={handleTogglePanel}
      onToggleWide={togglePanelWide}
      currentProjectId={currentProjectId}
      outcomeModeTabIds={outcomeModeTabIds}
      sandboxRefreshTick={sandboxRefreshTick}
    />
  );

  return (
    <NodeReaderContext.Provider value={openReader}>
      {hasProject === null ? (
        <div className="flex h-screen w-screen items-center justify-center" style={{ backgroundColor: 'var(--background)' }}>
          <div className="text-sm" style={{ color: 'var(--ink-muted)', fontFamily: 'var(--font-sans)' }}>
            Loading...
          </div>
        </div>
      ) : hasProject ? (
        // 根容器显式裁剪：全屏应用不应出现 body 滚动。
        // 预览面板等 overlay 依赖 self-stretch/h-full 约束高度，若某渲染时机下约束失效，
        // 长文档会把面板撑到视口底部之外（"文档出现在画布下方 + 界面可滑动"），此处兜底裁剪。
        <div className="relative flex h-screen w-screen overflow-hidden">
          {/* 顶部拖拽区域：absolute 覆盖在画布之上（z-30，低于悬浮面板 z-40）。
              这样三块面板的 top-[8px] 直接相对窗口顶部，mac 红绿灯覆盖在左侧面板左上角 */}
          <div
            className="absolute inset-x-0 top-0 z-[30] h-6 select-none"
            style={{
              WebkitAppRegion: 'drag',
              WebkitUserSelect: 'none',
              cursor: 'default',
            } as React.CSSProperties}
          >
            {/* 项目名卡片已迁入左列导航（2026-09 布局重构）；此处保留空白拖拽条 */}
          </div>

          {/* ===== 左列：项目 + 会话/任务树（2026-09 布局重构，TraeWork 式常驻导航） ===== */}
          <TooltipProvider delayDuration={150}>
          <aside
            className={`relative flex ${navCollapsed ? 'w-[52px]' : 'w-[280px]'} shrink-0 select-none flex-col overflow-hidden transition-[width] duration-150`}
            style={{
              backgroundColor: 'transparent',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            {/* mac 红绿灯 + 拖拽留白 + 折叠按钮（同排右置；按钮区域为 no-drag 以保留点击） */}
            <div
              className={`flex shrink-0 items-center ${navCollapsed ? 'justify-center' : 'justify-end'}`}
              style={{
                minHeight: isNativeFullscreen ? 8 : 32,
                // 折叠态（52px 窄栏）：红绿灯占满横向，无法靠右避让，只需把按钮下移到红绿灯垂直区域之下，
                // 避免 native 红绿灯拦截点击（展开态 280px 靠右本就与红绿灯无交叠）。
                paddingTop: navCollapsed && !isNativeFullscreen ? 40 : 0,
                WebkitAppRegion: 'drag',
                WebkitUserSelect: 'none',
              } as React.CSSProperties}
            >
              <div
                className="relative z-[31] flex shrink-0 items-center justify-center pr-1"
                style={{ WebkitAppRegion: 'no-drag', WebkitUserSelect: 'none' } as React.CSSProperties}
              >
                <ToolBtn
                  title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  onClick={toggleNav}
                >
                  {navCollapsed ? <PanelRightOpen className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
                </ToolBtn>
              </div>
            </div>
            {!navCollapsed && (
            <>
            {/* 全局工具 */}
            <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 pb-2">
              <ToolBtn title="Search (⌘F)" onClick={() => setPaletteOpen(true)}><Search className="h-3.5 w-3.5" /></ToolBtn>
              <ToolBtn title="Project board" onClick={() => setProjectBoardOpen(true)}><LayoutGrid className="h-3.5 w-3.5" /></ToolBtn>
              <ToolBtn title="Calendar" onClick={() => setCalendarOpen(true)}><CalendarClock className="h-3.5 w-3.5" /></ToolBtn>
              <ToolBtn title="Local files" onClick={() => setLocalExplorerCollapsed((v) => !v)}><Monitor className="h-3.5 w-3.5" /></ToolBtn>
              <ToolBtn title="Trash (deleted nodes)" onClick={() => window.dispatchEvent(new Event('trash-open'))}><Trash className="h-3.5 w-3.5" /></ToolBtn>
            </div>
            {/* 项目名标题栏：左侧项目名（点击切换项目），右侧 ＋ 添加会话（chat/coding/note/planner/imageGen 等类型下拉） */}
            <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('workspace-toggle'))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ cursor: 'pointer' }}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-bold" style={{ color: 'var(--ink-strong)' }}>
                      {currentProjectTitle || 'Project'}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Switch project</TooltipContent>
              </Tooltip>
              <div className="relative shrink-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setAddMenuOpen((v) => !v)}
                      className="flex h-6 w-6 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-hover)] hover:text-[var(--ink-strong)]"
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Add session</TooltipContent>
                </Tooltip>
                {addMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-[290]" onClick={() => setAddMenuOpen(false)} />
                    <div
                      className="absolute right-0 top-full z-[300] mt-1 w-48 rounded-xl border p-1.5 shadow-xl"
                      style={{
                        borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                        backgroundColor: '#ffffff',
                        fontFamily: 'var(--font-sans)',
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {listAgents()
                        .filter((a) => a.id === 'chat' || !disabledAgentIds.has(a.id))
                        .map((a) => {
                        const meta = AGENT_MENU_ICONS[a.id] ?? AGENT_MENU_DEFAULT_ICON;
                        const label = AGENT_MENU_LABELS[a.id] ?? a.label;
                        const pos = spawnSiblingPosition();
                        let onClick: () => void;
                        if (a.id === 'coding') {
                          onClick = () => { setNodeCreatePos(pos); setNodeCreateDialogOpen(true); };
                        } else if (a.id === 'note') {
                          onClick = () => createNoteAgentNode(pos);
                        } else if (a.id === 'planner') {
                          onClick = () => createAgentNode('planner', 'Planner', pos);
                        } else {
                          onClick = () => createPlainNode(pos);
                        }
                        return (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => { onClick(); setAddMenuOpen(false); }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                            style={{ color: 'var(--ink)' }}
                          >
                            {meta.icon}
                            <span className="flex-1 truncate">{label}</span>
                          </button>
                        );
                      })}
                      {/* Agent 市场已装 agent（2026-09-06）：随 /api/agents 动态并入，点击走通用 createAgentNode */}
                      {marketAgents.some((ma) => !hiddenMenuAgentIds.has(ma.id)) && (
                        <>
                          <div className="mx-2 my-1" style={{ borderTop: '1px solid color-mix(in oklab, var(--line) 35%, transparent)' }} />
                          {marketAgents
                            .filter((ma) => !hiddenMenuAgentIds.has(ma.id))
                            .map((ma) => {
                            const meta = AGENT_MENU_ICONS[ma.id] ?? AGENT_MENU_DEFAULT_ICON;
                            const label = AGENT_MENU_LABELS[ma.id] ?? ma.label;
                            return (
                              <button
                                key={ma.id}
                                type="button"
                                onClick={() => {
                                  createAgentNode(ma.id, label, spawnSiblingPosition());
                                  setAddMenuOpen(false);
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                                style={{ color: 'var(--ink)' }}
                              >
                                {meta.icon}
                                <span className="flex-1 truncate">{label}</span>
                              </button>
                            );
                          })}
                        </>
                      )}
                      <div className="mx-2 my-1" style={{ borderTop: '1px solid color-mix(in oklab, var(--line) 35%, transparent)' }} />
                      <button
                        type="button"
                        onClick={() => { createImageGenNode(spawnSiblingPosition()); setAddMenuOpen(false); }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--info-soft)]"
                        style={{ color: 'var(--ink)' }}
                      >
                        <Plus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--info)' }} />
                        <span className="flex-1">ImageGen</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            {/* 会话/任务树：链分组（含散落节点），点击切换到该节点 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {focusRail.length === 0 ? (
                <div className="px-2 pt-4 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                  No conversations yet.
                  <br />Create one below.
                </div>
              ) : (
                focusRail.map((group, gi) => {
                  const rootDot = group.dots[0];
                  const rootTitle = rootDot?.title || 'Untitled';
                  const rootActive = focusedNodeId === rootDot?.id;
                  // 会话级聚合状态：任一子节点执行中=呼吸灯，任一已完成未读=实心绿点
                  const rootRunning = group.dots.some((d) => railDotState(d.id) === 'running');
                  const rootDone = group.dots.some((d) => railDotState(d.id) === 'done');
                  return (
                    <div key={group.key} style={{ marginTop: gi === 0 ? 2 : 14 }}>
                      {/* 根行 = 会话标题（点击聚焦根节点）；hover 显示删除入口（2026-09：自标题栏迁入） */}
                      <div className="group flex items-center">
                        <button
                          type="button"
                          onClick={() => {
                            if (rootDot && !rootActive) switchFocusNode(rootDot.id);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--paper-hover)]"
                          style={{
                            backgroundColor: rootActive ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : undefined,
                            cursor: 'pointer',
                          }}
                        >
                          {AGENT_MENU_ICONS[rootDot?.identity ?? '']?.icon ?? AGENT_MENU_DEFAULT_ICON.icon}
                          <span
                            className="min-w-0 flex-1 truncate text-xs"
                            style={{ color: rootActive ? 'var(--ink-strong)' : 'var(--ink)', fontWeight: rootActive ? 600 : 400 }}
                          >
                            {rootTitle}
                          </span>
                          {(rootRunning || rootDone) && (
                            <span
                              className={`block h-1.5 w-1.5 shrink-0 rounded-full${rootRunning ? ' rail-run-breathing' : ''}`}
                              style={{ backgroundColor: 'var(--success)' }}
                            />
                          )}
                          {group.dots.length > 1 && (
                            <span className="shrink-0 text-[11px]" style={{ color: 'var(--ink-faint)' }}>{group.dots.length - 1}</span>
                          )}
                        </button>
                        <button
                          type="button"
                          title="Delete node"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (rootDot) void deleteNodeFromRail(rootDot.id);
                          }}
                          className="flex h-5 w-0 shrink-0 items-center justify-center overflow-hidden rounded text-[var(--ink-faint)] transition-all duration-100 hover:text-[var(--danger)] group-hover:w-5"
                        >
                          <X className="h-3 w-3 shrink-0" />
                        </button>
                      </div>
                      {group.dots.slice(1).map((dot) => {
                        const active = focusedNodeId === dot.id;
                        const dotState = railDotState(dot.id);
                        return (
                          <div key={dot.id} className="group flex items-center">
                            <button
                              type="button"
                              onClick={() => {
                                if (!active) switchFocusNode(dot.id);
                              }}
                              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--paper-hover)]"
                              style={{
                                backgroundColor: active ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : undefined,
                                cursor: 'pointer',
                              }}
                            >
                              {dotState === 'running' || dotState === 'done' ? (
                                <span
                                  className={`block h-1.5 w-1.5 shrink-0 rounded-full${dotState === 'running' ? ' rail-run-breathing' : ''}`}
                                  style={{ backgroundColor: 'var(--success)' }}
                                />
                              ) : (
                                <span className="block h-1.5 w-1.5 shrink-0" />
                              )}
                              <span
                                className="min-w-0 flex-1 truncate text-xs"
                                style={{ color: active ? 'var(--ink-strong)' : 'var(--ink)', fontWeight: active ? 600 : 400 }}
                              >
                                {dot.title}
                              </span>
                            </button>
                            <button
                              type="button"
                              title="Delete node"
                              onClick={(e) => {
                                e.stopPropagation();
                                void deleteNodeFromRail(dot.id);
                              }}
                              className="flex h-5 w-0 shrink-0 items-center justify-center overflow-hidden rounded text-[var(--ink-faint)] transition-all duration-100 hover:text-[var(--danger)] group-hover:w-5"
                            >
                              <X className="h-3 w-3 shrink-0" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>
            {/* 底部品牌区：品牌图标 + BobWork 版本号，点击版本号触发更新检查 */}
            <div className="shrink-0 px-2 py-2">
              <button
                type="button"
                title={updateStatus === 'checking' ? 'Checking for updates…' : 'Check for updates'}
                onClick={() => {
                  if (updateStatus === 'checking' || !isDesktop()) return;
                  setUpdateStatus('checking');
                  desktop.update.check().then((r) => {
                    if (r && !r.success) {
                      setUpdateStatus('error');
                      setTimeout(() => setUpdateStatus('idle'), 3000);
                    }
                  }).catch(() => {
                    setUpdateStatus('error');
                    setTimeout(() => setUpdateStatus('idle'), 3000);
                  });
                }}
                className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)', cursor: isDesktop() ? 'pointer' : 'default' }}
              >
                <img src="/bobwork-logo.png" alt="BobWork" className="h-4 w-4 shrink-0 rounded object-contain" draggable={false} />
                <span className="shrink-0 text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>BobWork</span>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px]">
                  {updateStatus === 'checking' ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Checking…
                    </>
                  ) : (
                    <>
                      v{appVersion}
                      {updateStatus === 'available' && ` → v${updateVersion}`}
                      {updateStatus === 'error' && ' Check failed'}
                    </>
                  )}
                </span>
              </button>
            </div>
            </>
            )}
            {/* 折叠态：窄图标轨 */}
            {navCollapsed && (
              <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-1 py-1">
                <ToolBtn title="Search (⌘F)" onClick={() => setPaletteOpen(true)}><Search className="h-4 w-4" /></ToolBtn>
                <ToolBtn title="Project board" onClick={() => setProjectBoardOpen(true)}><LayoutGrid className="h-4 w-4" /></ToolBtn>
                <ToolBtn title="Calendar" onClick={() => setCalendarOpen(true)}><CalendarClock className="h-4 w-4" /></ToolBtn>
                <ToolBtn title="Local files" onClick={() => setLocalExplorerCollapsed((v) => !v)}><Monitor className="h-4 w-4" /></ToolBtn>
                <ToolBtn title="Trash (deleted nodes)" onClick={() => window.dispatchEvent(new Event('trash-open'))}><Trash className="h-4 w-4" /></ToolBtn>
              </div>
            )}
          </aside>
          </TooltipProvider>

          {/* 画布区域：承载当前聚焦会话（TraeWork 式单会话宿主，画布交互已移除） */}
          <div
            ref={wrapperRef}
            className="relative min-w-0 flex-1 overflow-hidden"
          >
      <ReactFlow
        key={flowKey}
        nodes={displayNodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onPaneContextMenu={(e) => { e.preventDefault(); /* 2026-09 布局重构：停用画布空白右键新建 */ }}
        onMouseDown={onPaneClickStart}
        onMouseMove={onPaneMouseMove}
        onMouseUp={onPaneClickEnd}
        onMouseLeave={onPaneClickEnd}
        onClick={onPaneClick}
        nodeTypes={effectiveNodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionMode={ConnectionMode.Loose}
        selectionMode={SelectionMode.Partial}
        selectionOnDrag={false}
        // 自由画布交互已移除（2026-09 布局重构）：中栏仅承载聚焦会话，禁平移/缩放/拖拽/键盘删除
        nodesDraggable={false}
        panOnDrag={[]}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        minZoom={1}
        maxZoom={1}
        defaultViewport={savedViewportRef.current || { x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        onBeforeDelete={onBeforeDelete}
        onNodesDelete={onNodesDelete}
        onNodeClick={(_event, node) => {
          // 点击节点总是保持选中：红色高亮 + 弹出输入框。
          // 注意：不能 toggle 取消选中——节点内部（输入栏/消息区）的 click 会冒泡到此处，
          // 若"再次点击取消"会把输入框点没（点击输入栏 → 取消选中 → 输入框消失的 bug）。
          // 取消选中通过点击画布空白处（onPaneClick）或 NodeMap 完成。
          lastActiveNodeIdRef.current = node.id;
        }}
        onMoveStart={() => {
          // 任何手动平移/缩放都视为用户已接管画布，阻止后续自动 fit 抢占
          userInteractedRef.current = true;
        }}
      >
      </ReactFlow>

      {/* NodeMap 左下角悬浮（2026-09-06 恢复挂载）：折叠态 MapIcon 贴中栏左下角，点击展开连线管理缩略图 */}
      <NodeMap
        gateway={graphGateway}
        left={16}
        title={currentProjectTitle || undefined}
        projectId={currentProjectId || undefined}
        focusedNodeId={focusedNodeId}
      />

      {/* 空态提示：无聚焦会话时中栏居中提示 */}
      {!focusedNodeId && (
        <div className="pointer-events-none absolute inset-0 z-[15] flex items-center justify-center">
          <div className="text-center">
            <div className="text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
              No conversation open
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
              Pick one from the list on the left, or create a new task below.
            </div>
          </div>
        </div>
      )}

      {/* 框选/多选选中虚线框已移除（2026-09：删除框选相关功能） */}

      <div data-canvas-ui="overlay">
        <SettingsModal
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onConfigsChange={setProviderConfigs}
          initialSection={settingsSection}
        />

        {/* ⌘F 统一面板：文件搜索 + WANTED 指令（原 GlobalSearch + TaskPanel）；底部图标栏承载原 rail 全部按钮 */}
        <UnifiedPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenProjectBoard={() => setProjectBoardOpen(true)}
          onOpenNotes={() => setNotesOpen(true)}
          onOpenCalendar={() => setCalendarOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          focusedNodeId={focusedNodeId}
          projectId={currentProjectId || undefined}
        />

        {/* 项目看板：全屏大视图（Workspace 标题看板按钮打开） */}
        <ProjectBoardView
          open={projectBoardOpen}
          onClose={() => setProjectBoardOpen(false)}
        />

        {/* 日历面板 */}
        {calendarOpen && (
          <CalendarPanel
            projectId={currentProjectId}
            onClose={() => setCalendarOpen(false)}
          />
        )}

        {/* 笔记库独立界面 */}
        {notesOpen && (
          <NotesPanel onClose={() => setNotesOpen(false)} />
        )}

        {/* Bob-Mind 插件面板壳：内嵌 bob-mind-mcp 自带 Web UI（宿主零便签实现） */}
        {bobMindOpen && (
          <BobMindPanel onClose={() => setBobMindOpen(false)} />
        )}

        {/* Bob Sandbox 全屏管理页（小程序商城）：全屏覆盖层，Esc / 关闭按钮退出 */}
        {storeOpen && (
          <SandboxPanel fullscreen onClose={() => setStoreOpen(false)} />
        )}

        {/* Agent Teams 全屏面板：侧边栏入口打开，Esc / 关闭按钮退出 */}
        {teamsFullscreenOpen && (
          <AgentTeamsPanel fullscreen onClose={() => setTeamsFullscreenOpen(false)} />
        )}

        {/* 模型用量统计面板：图标栏/⌘F 入口打开，Esc / 关闭按钮退出 */}
        {usageOpen && (
          <UsagePanel onClose={() => setUsageOpen(false)} />
        )}

        {/* 新建节点对话框：AI Chat / AI Coding 类型选择 + 小程序项目绑定 */}
        <AICodingCreateDialog
          open={nodeCreateDialogOpen}
          position={nodeCreatePos}
          onClose={() => setNodeCreateDialogOpen(false)}
          onCreated={handleNodeCreated}
        />

      </div>

      </div>
      {/* ^^ 上面第一个 </div> 关闭 data-canvas-ui 覆盖层，第二个 </div> 关闭 wrapper（对话容器）。
          Sidebar 浮层与右 dock 自此成为 root flex 的并列子级 */}

      {/* 悬浮 Sidebar（Workspace 浮层）：整窗级，盖在左栏/对话之上 */}
      <div className="pointer-events-none absolute bottom-[10px] left-[10px] top-[10px] z-40">
        <div className="pointer-events-auto h-full">
          <Sidebar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCalendar={() => setCalendarOpen(true)}
            onOpenProjectBoard={() => setProjectBoardOpen(true)}
            projectId={currentProjectId}
            onCollapsedChange={handleSidebarCollapsedChange}
            onCreateNodeWithFile={handleCreateNodeWithFile}
          />
        </div>
      </div>

      {/* 右侧 dock：预览面板 + 本地文件面板（真并列列，与左栏/对话同级，互不重叠，保留固定间距）。
          wrapper（对话容器）在上面已闭合；此处 dock 为 root flex 行的最后一个子级，自动挤窄对话区 */}
      <div className="relative z-40 flex shrink-0 items-start gap-0.5 overflow-hidden py-[3px] pr-[3px]">
        {/* 折叠后仅展示的展开按钮：用固定占位 div 包裹，保持预览面板在树中的位置稳定，避免折叠时卸载导致生成中断 */}
        <div className="shrink-0 self-start">
          {panelCollapsed && (
            <button
              onClick={handleTogglePanel}
              className="pointer-events-auto mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[rgba(0,0,0,0.06)]"
              style={{ color: 'var(--ink-muted)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              title="Expand preview panel"
            >
              <PanelRightOpen className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* 预览面板：折叠时以 display:none 隐藏而非卸载。
            若 ImageAiEditor 生成中/结果待查看（keepAlive），隐藏挂载延续生成；否则折叠时彻底卸载以释放资源 */}
        {(!panelCollapsed || aiEditKeepAlive) && (
          <div
            className="self-stretch"
            data-reader-panel-wrapper
            style={panelCollapsed ? { display: 'none' } : undefined}
            aria-hidden={panelCollapsed || undefined}
          >
            {readerPanelEl}
          </div>
        )}
        {/* 本地文件面板：展开/折叠由左侧栏电脑图标或自动折叠控制 */}
        {!localExplorerCollapsed && (
          <div className="self-stretch" data-local-explorer-wrapper>
            <LocalFileExplorer
              activeNodeIdRef={lastActiveNodeIdRef}
              onCreateNodeWithFile={handleCreateNodeWithFile}
              onToggleCollapse={() => setLocalExplorerCollapsed(true)}
              pinned={localExplorerPinned}
              onTogglePinned={toggleLocalExplorerPinned}
            />
          </div>
        )}
      </div>
      </div>
      ) : (
        <WelcomeScreen onCreateProject={handleCreateProject} />
      )}
      {/* 删除确认弹窗 */}
      {confirmRender}
      {/* ImageAiEditor 生成完成/失败全局提示（需在预览面板之外，折叠时仍可见） */}
      <ImageAiEditToast />
      {/* 首次运行向导：全新安装首次启动时引导选择保存地址 */}
      <SetupWizard />
    </NodeReaderContext.Provider>
  );
}

export function CanvasFlow() {
  return (
    <ReactFlowProvider>
      <CanvasFlowInner />
    </ReactFlowProvider>
  );
}
