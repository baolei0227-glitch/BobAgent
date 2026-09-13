'use client';

import { useRef, useEffect, useCallback, useState, useMemo, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelRightOpen, PanelRightClose, X, Code2, MessageSquareText, MessageCircle, Check, FileText, ClipboardList, NotebookText, CalendarClock, Calendar, Folder, Monitor, Trash, Search, Plus, LayoutGrid, Loader2, Bot, Settings, Blocks, Boxes, Users, Mail, LayoutTemplate, FilePen, Globe, MoreVertical, Pencil } from 'lucide-react';
import type { HostNode, HostEdge, NodeHostValue } from './node-host';
import { NodeHostContext } from './node-host';
import {
  addEdge,
  flowNodeTypeForData,
  isFocusableResearch,
  isAbsoluteFsPath,
  agentIdentityFromNodeType,
  type FlowAiNodeType,
  estimateTabWidth,
  pluginPanelTabIcon,
} from './canvasUtils';
import { useStarredApps, useMailPending, useUpdateStatus, usePluginPanels } from './canvasHooks';

// —— 宿主自绘画布（2026-09 布局重构）：以本地类型替代旧 React Flow 的 Node/Edge/Connection。
// 节点 state 统一以 AiChatNodeData 承载（非研究节点 data 语义照旧经断言访问）。
type Node<D = AiChatNodeData> = HostNode<D>;
type Edge = HostEdge;
/** 连线创建请求的最小形态（原 Connection：source/target + 可选 handle） */
interface Connection {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}
import { ChatNodeKernel, NodeReaderContext, type ChatNodeKernelProps } from './ChatNodeKernel';
import { ChatNode } from './ChatNode';
import { CodingNode } from './CodingNode';
import { NoteNode } from './NoteNode';
import { ButlerNode } from './ButlerNode';
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
import { ProjectBoardView, LAUNCH_BOARD_KEY } from './ProjectBoardView';
import { DocxTemplatePanel } from './DocxTemplatePanel';
import { UnifiedViewer } from './UnifiedViewer';
import { Sidebar } from './Sidebar';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

import { CalendarPanel } from './CalendarPanel';
import { PluginPanelFrame } from './PluginPanelFrame';
import { WelcomeScreen } from './WelcomeScreen';
import { LocalFileExplorer } from './LocalFileExplorer';
import { UnifiedPalette } from './UnifiedPalette';
import { NavSearchBox } from './NavSearchBox';
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
import type { PluginPanelEntry } from '@/lib/plugin-panels';
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
import { HippoCapsule } from '@/components/hippo-browser/HippoCapsule';

// —— 预览面板自由缩放常量 ——
// 面板宽度由固定两档（580/960）改为可在 [PANEL_W_MIN, 可用上限] 之间自由拖拽，
// 并随窗口/左栏/文件面板动态收敛，避免小窗口下被中间对话面板卡死而无法打开。
const PANEL_W_MIN = 320; // 面板最小宽度（px）
const PANEL_W_DEFAULT = 800; // 无持久化记录时的默认宽度（已去除窄档，统一用加宽后的宽度）
const PANEL_W_ABS_MAX = 2560; // 绝对上限（放宽到 2560 以支持 4K 超宽屏；再大就是多屏拼接，无意义）
const PANEL_W_PERSIST_KEY = 'bobwork.ui.panel.width.v3'; // 持久化 key（v3：去除窄档后重置旧宽值，让 800 默认宽度生效）
const PANEL_W_PERSIST_STALE_KEYS = ['bobwork.ui.panel.width', 'bobwork.ui.panel.width.v2']; // 旧 key（启动时清理，避免遗留宽值干扰）
const PANEL_CONVERSATION_MIN = 160; // 为中间对话区保留的最小宽度（从 200 下调到 160，既放宽面板又不至于挤爆对话区；窄屏模式下会自动提升到 480 保护画布舒适宽度）

// 注册统一文件来源（Step 2）：模块加载时注册，幂等
registerFileSources();

/** 宿主节点壳统一 props（2026-09 宿主重构）：id/data/selected，identity 由壳内部注入 */
type HostAgentNodeProps = Omit<ChatNodeKernelProps, 'identity'>;

/** AI 画布节点类型：agent 节点按 AGENT_PROFILES 注册表派生（agent-<id>），避免手写散落。 */
const AGENT_NODE_SHELLS: Record<string, React.ComponentType<HostAgentNodeProps>> = {
  chat: ChatNode,
  coding: CodingNode,
  note: NoteNode,
  butler: ButlerNode,
};

/**
 * 市场/自定义 agent 通用壳（2026-09-06 Agent 市场）：未在 AGENT_NODE_SHELLS 登记的内置壳时，
 * 一律用 ChatNodeKernel + identity=<agentId> 渲染——agent 画像（prompt/场景/工具/技能池）全部服务端解析，
 * 前端无需为新 agent 写专属壳。按 id 缓存组件实例保证 memo 稳定。
 */
const genericAgentNodeCache = new Map<string, React.ComponentType<HostAgentNodeProps>>();
function genericAgentNodeFor(agentId: string): React.ComponentType<HostAgentNodeProps> {
  let node = genericAgentNodeCache.get(agentId);
  if (!node) {
    node = function GenericAgentNode(props: Omit<ChatNodeKernelProps, 'identity'>) {
      return <ChatNodeKernel {...props} identity={agentId} />;
    };
    genericAgentNodeCache.set(agentId, node);
  }
  return node;
}
// 研究节点渲染分发表：aiChat/aiCoding 存量兼容 + agent-<id> 派生；
// imageGen/bobby/agentTeams/annotation 等豁免类型由 renderHostNode switch 分流，不在此表。
const nodeTypes: Record<string, React.ComponentType<HostAgentNodeProps>> = {
  // 兼容存量：旧 aiChat/aiCoding 节点（frontmatter 无 node_type）仍可渲染
  aiChat: ChatNode,
  aiCoding: CodingNode,
  // 新 agent 节点：flow type = agent-<id>（由 AGENT_PROFILES 派生）
  ...Object.fromEntries(
    listAgents()
      .filter((a) => AGENT_NODE_SHELLS[a.id])
      .map((a) => [agentFlowType(a.id), AGENT_NODE_SHELLS[a.id]]),
  ),
};
// 展开/聚焦节点时可视区最低可用宽度：低于该值说明右侧宽屏预览面板严重挤占（14" 屏 + 宽面板场景），
// 自动折叠面板让出空间，否则展开节点会与面板重叠且宽度被压到不可用
const MIN_EXPAND_VISIBLE_W = 480;

// —— 窄屏自适应断点（级联收起，画布优先）——
// 画布舒适下限与 MIN_EXPAND_VISIBLE_W 一致(480)：低于相应宽度时全开/逐级让位也难以保住它，
// 因此窗口过窄时按优先级自动收起「左栏 → 本地文件面板 → 预览面板」，拉宽后恢复被自动收起的部分。
// 每个断点 = 该级收起前仍在场各列宽度之和 + 画布舒适 480（本地文件面板被 pin 固定时不自动收起）
const NARROW_COMFORT_CANVAS = MIN_EXPAND_VISIBLE_W; // 480
const NAV_W_EXPANDED = 258; // 展开态左栏宽度（与 className w-[258px] 保持一致）
const NAV_W_COLLAPSED = 52; // 折叠态左栏宽度（与 className w-[52px] 保持一致）
const EXPLORER_W_OPEN = 258; // 本地文件面板展开宽度（与 LocalFileExplorer width:258 保持一致）
// ① 左栏最先收起：全开（左栏+文件+预览最小）时画布已不足 480
const NARROW_W_NAV = NAV_W_EXPANDED + EXPLORER_W_OPEN + PANEL_W_MIN + NARROW_COMFORT_CANVAS; // 1316
// ② 其次收起本地文件面板：此时左栏已折为 52，剩余（文件+预览最小）画布仍不足 480
const NARROW_W_EXPLORER = NAV_W_COLLAPSED + EXPLORER_W_OPEN + PANEL_W_MIN + NARROW_COMFORT_CANVAS; // 1110
// ③ 最后收起预览面板：仅剩（左栏52+预览最小）也保不住画布 480 时才让步（预览最受保护）
const NARROW_W_PANEL = NAV_W_COLLAPSED + PANEL_W_MIN + NARROW_COMFORT_CANVAS; // 852


// 画布物理不再渲染节点连线（2026-09 用户拍板：连线关系改由 NodeMap 缩略图管理，
// 节点标题栏以链接图标表达关系）。edges 数据仍完整保留在宿主节点 state：
// gateway 快照 → NodeMap 渲染/管理、链导航圆点、上游上下文注入、断线状态均继续消费。


/** 右键菜单 agent 项图标（id → 图标元素；未配置的 agent 用默认聊天气泡）。
 *  颜色与各身份节点实际外框高亮色保持一致：coding 蓝(--info)/Kar 黄(--warn)/Butler 绿(--success)/chat 暖红(--danger)，
 *  与 ChatNodeKernel 的 accentVar 映射同源。 */
const AGENT_MENU_ICONS: Record<string, { icon: React.ReactNode; color: string; hoverBg: string }> = {
  // 尺寸：chat 的 Bot 14px；coding/kar/butler 专属图标 13px（2026-09 视觉校准）
  chat: { icon: <Bot className="h-[14px] w-[14px] shrink-0" />, color: 'var(--danger)', hoverBg: 'var(--danger-soft)' },
  coding: { icon: <Code2 className="h-[13px] w-[13px] shrink-0" />, color: 'var(--info)', hoverBg: 'var(--info-soft)' },
  note: { icon: <NotebookText className="h-[13px] w-[13px] shrink-0" />, color: 'var(--warn)', hoverBg: 'var(--warn-soft)' },
  butler: { icon: <CalendarClock className="h-[13px] w-[13px] shrink-0" />, color: 'var(--success)', hoverBg: 'var(--success-soft)' },
};
const AGENT_MENU_DEFAULT_ICON = { icon: <MessageSquareText className="h-[13px] w-[13px] shrink-0" />, color: 'var(--primary-strong)', hoverBg: 'var(--paper-hover)' };

/** 右键菜单 agent 项显示名（id → 菜单文案；未配置的回退 profile.label） */
const AGENT_MENU_LABELS: Record<string, string> = {
  chat: 'Chat',
  coding: 'Coding',
  note: 'Kar',
  butler: 'Butler',
};

// 从 .md 文件恢复节点到画布
function restoredNodeToFlowNode(
  nodeData: {
    node_id: string;
    title: string;
    model?: string;
    summary?: string;
    /** 会话创建时间（frontmatter）：左栏会话列表"最新在上"排序用 */
    created_at?: string;
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
      createdAt: nodeData.created_at,
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


/** 置顶标签：这些插件面板的标签固定在标签栏最前面（先于会话/文件/沙盒标签） */
const PINNED_PANEL_PLUGIN_IDS = new Set(['bob-mind-mcp']);

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
  onSelectTab,
  onCloseNodeTab,
  onCloseFileTab,
  onCloseSandboxTab,
  onCloseTemplateTab,
  pluginPanels,
  onClosePluginTab,
  openPluginIds,
  templateInitialScene,
  currentProjectId,
  outcomeModeTabIds,
  sandboxRefreshTick,
  onPanelWidthChange,
  onPanelWidthCommit,
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
  activePanelTab: { type: 'node' | 'file' | 'sandbox' | 'template' | 'plugin'; id: string } | null;
  collapsed: boolean;
  /** 面板当前宽度（px），可在 [PANEL_W_MIN, 可用上限] 之间自由缩放 */
  panelWidth: number;
  /** 插件面板注册表（服务端 /api/plugin-panels 下发，驱动通用插件 Tab 与标签名/图标） */
  pluginPanels: PluginPanelEntry[];
  /** 已打开的插件面板 id（按打开顺序）：常驻标签栏，切走仅 display 隐藏，iframe 不重建 */
  openPluginIds: string[];
  onSelectTab: (type: 'node' | 'file' | 'sandbox' | 'template' | 'plugin', id: string) => void;
  onCloseNodeTab: (nodeMdId: string) => void;
  onCloseFileTab: (tabId: string) => void;
  onCloseSandboxTab: (tabId: string) => void;
  onCloseTemplateTab: () => void;
  onClosePluginTab: (pluginId: string) => void;
  /** 打开模板 tab 时预选的场景名（AI 扫描到模板字段后跳转时携带） */
  templateInitialScene?: string;
  onToggleCollapse: () => void;
  currentProjectId: string;
  /** 成果块模式打开的 tab ID 集合 */
  outcomeModeTabIds: Set<string>;
  /** Bob Sandbox 预览强制刷新信号（Play / 绑定 / AI 写入后递增） */
  sandboxRefreshTick: number;
  /** 拖拽 handle 实时更新面板宽度（父组件内部 clamp 收敛） */
  onPanelWidthChange?: (newWidth: number) => void;
  /** 拖拽 handle 松手时持久化（父组件读取最新值写入 localStorage） */
  onPanelWidthCommit?: () => void;
}) {
  // 面板宽度：由父组件传入的 panelWidth 控制，可在最小宽度与可用上限之间自由缩放
  const PANEL_W = panelWidth;

  // 拖拽 handle：左边缘可拖，改变面板宽度
  const dragStartRef = useRef<{ mouseX: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const s = dragStartRef.current;
      if (!s) return;
      // handle 在面板左边缘：向左拖 → 面板变宽（delta 负，newWidth = startW - delta = startW + |delta|）
      const delta = e.clientX - s.mouseX;
      onPanelWidthChange?.(s.width - delta);
    };
    const onUp = () => {
      dragStartRef.current = null;
      setDragging(false);
      onPanelWidthCommit?.();
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onPanelWidthChange, onPanelWidthCommit]);

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

  const handleSelectTab = (type: 'node' | 'file' | 'sandbox' | 'template' | 'plugin', id: string) => {
    if (type === 'sandbox') softReloadActiveSandbox(id);
    onSelectTab(type, id);
  };

  // 合并所有 tabs（模板/插件面板为单例 tab，始终存在但仅在 activePanelTab 指向时才显示）
  // 置顶组：Templates 与置顶插件（Bob-Mind）固定排在标签栏最前面，避免被会话/文件标签挤到末尾
  const allTabs = useMemo(() => {
    // 打开过的插件面板常驻标签栏（按打开顺序），切到其它标签也不消失
    const pluginTabs = openPluginIds.map((id) => ({
      id,
      type: 'plugin' as const,
      label: pluginPanels.find((p) => p.pluginId === id)?.name || id,
    }));
    const pinnedTabs = [
      ...(templatePanelMounted ? [{ id: 'template', type: 'template' as const, label: 'Templates' }] : []),
      ...pluginTabs.filter(t => PINNED_PANEL_PLUGIN_IDS.has(t.id)),
    ];
    return [
      ...pinnedTabs,
      ...pluginTabs.filter(t => !PINNED_PANEL_PLUGIN_IDS.has(t.id)),
      ...openReaderIds.map(id => ({ id, type: 'node' as const, label: readerTitles[id] || '...' })),
      ...fileTabs.map(t => ({ id: t.id, type: 'file' as const, label: t.fileName })),
      ...sandboxTabs.map(t => ({ id: t.id, type: 'sandbox' as const, label: t.name })),
    ];
  }, [openReaderIds, fileTabs, sandboxTabs, readerTitles, openPluginIds, pluginPanels, templatePanelMounted]);

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
      className="relative flex h-full flex-col overflow-hidden shrink-0"
      data-canvas-ui="overlay"
      data-reader-panel
      style={{
        width: PANEL_W,
        zIndex: 50,
        // 2026-09-12 预览面板改纯白：与灰色画布底 --canvas-bg 拉开对比
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)',
        background: '#fff',
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent)',
        WebkitAppRegion: 'no-drag',
        pointerEvents: 'auto',
      } as React.CSSProperties}
    >
      {/* 拖拽 handle：面板左边缘 4px 竖条，hover 时变宽变蓝，cursor: col-resize */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dragStartRef.current = { mouseX: e.clientX, width: PANEL_W };
          setDragging(true);
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
        className="absolute left-0 top-0 z-[60] h-full shrink-0 select-none transition-[width,background-color] duration-100"
        style={{
          width: dragging ? 6 : 4,
          cursor: 'col-resize',
          backgroundColor: dragging ? 'var(--primary)' : 'transparent',
          borderRadius: '12px 0 0 12px',
        }}
        onMouseEnter={(e) => {
          if (!dragging) {
            (e.currentTarget as HTMLDivElement).style.width = '6px';
            (e.currentTarget as HTMLDivElement).style.backgroundColor = 'color-mix(in oklab, var(--primary) 35%, transparent)';
          }
        }}
        onMouseLeave={(e) => {
          if (!dragging) {
            (e.currentTarget as HTMLDivElement).style.width = '4px';
            (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
          }
        }}
      />
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

        {/* 标签列表：容器不滚动，放不下的标签收进 "…" 下拉菜单 */}
        <div ref={tabsWrapRef} className="flex min-w-0 flex-1 items-center overflow-hidden">
          {allTabs.map((tab, idx) => {
            const isActive = activePanelTab?.id === tab.id && activePanelTab?.type === tab.type;
            const TabIcon = tab.type === 'file' ? FileText : tab.type === 'sandbox' ? Code2 : tab.type === 'template' ? ClipboardList : tab.type === 'plugin' ? pluginPanelTabIcon(pluginPanels.find(p => p.pluginId === tab.id)?.icon) : MessageSquareText;
            return (
              <div key={tab.id} className={`group flex shrink-0 items-center ${idx >= visibleCount ? 'hidden' : ''}`}>
                {/* 圆角胶囊标签：类型图标 + 标签名 + 关闭按钮；选中态以背景+边框高亮，不加下划线 */}
                <button
                  onClick={() => handleSelectTab(tab.type, tab.id)}
                  className={`group/tab relative mx-0.5 flex max-w-[112px] shrink-0 items-center gap-0.5 rounded-md border px-1 py-0.5 text-[11px] font-medium transition-all ${
                    isActive
                      ? 'border-[color-mix(in_oklab,var(--primary)_38%,transparent)] bg-[var(--primary-soft)]'
                      : 'border-[color-mix(in_srgb,var(--line)_45%,transparent)] bg-transparent hover:border-[color-mix(in_srgb,var(--line)_95%,transparent)] hover:bg-[var(--paper-hover)]'
                  }`}
                  style={{
                    color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                  }}
                  title={tab.label}
                >
                  <TabIcon className="h-2.5 w-2.5 shrink-0 opacity-70" style={{ color: isActive ? 'var(--primary)' : 'var(--ink-faint)' }} />
                  <span
                    className="min-w-0 flex-1 truncate transition-[padding] group-hover/tab:pr-4"
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
                  {/* 关闭按钮：默认隐藏，悬停标签时显示。
                      注意：不能再用 <button>——外层标签已是 <button>，
                      嵌套 button 是非法 HTML，SSR 解析时浏览器会提前闭合外层标签，
                      导致该按钮被移出 group/tab 作用域、group-hover 永远匹配不到。 */}
                  <span
                    role="button"
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      if (tab.type === 'node') onCloseNodeTab(tab.id);
                      else if (tab.type === 'file') onCloseFileTab(tab.id);
                      else if (tab.type === 'template') {
                        // 退出常驻：从标签栏移除（onCloseTemplateTab 只会切走激活，需本地清标记）
                        setTemplatePanelMounted(false);
                        onCloseTemplateTab();
                      }
                      else if (tab.type === 'plugin') onClosePluginTab(tab.id);
                      else onCloseSandboxTab(tab.id);
                    }}
                    className="absolute right-0.5 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 cursor-pointer items-center justify-center rounded bg-[var(--paper)] opacity-0 pointer-events-none transition-opacity group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    <X className="h-2.5 w-2.5" />
                  </span>
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
                  const TabIcon = tab.type === 'file' ? FileText : tab.type === 'sandbox' ? Code2 : tab.type === 'template' ? ClipboardList : tab.type === 'plugin' ? pluginPanelTabIcon(pluginPanels.find(p => p.pluginId === tab.id)?.icon) : MessageSquareText;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => { handleSelectTab(tab.type, tab.id); setMoreOpen(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                      style={{
                        color: isActive ? 'var(--primary)' : 'var(--ink)',
                        fontWeight: isActive ? 600 : 400,
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
          <div data-template-panel className="h-full" style={{ display: activePanelTab?.type === 'template' ? undefined : 'none' }}>
            <DocxTemplatePanel initialScene={templateInitialScene} />
          </div>
        )}
        {/* 插件面板（注册表驱动）：内嵌插件自带 Web UI——serve 先探测就绪，static 直载宿主代理。
            惰性挂载 + display 显隐切换：切走 tab 时保持挂载，iframe 不重建（Bob-Mind 面板状态不丢） */}
        {openPluginIds.map((pluginId) => {
          const entry = pluginPanels.find((p) => p.pluginId === pluginId);
          if (!entry) return null;
          const isActive = activePanelTab?.type === 'plugin' && activePanelTab.id === pluginId;
          return (
            <div
              key={pluginId}
              data-plugin-panel={pluginId}
              className="h-full w-full"
              style={{ display: isActive ? undefined : 'none' }}
            >
              <PluginPanelFrame
                pluginId={entry.pluginId}
                name={entry.name}
                src={entry.src}
                probeUrl={entry.probeUrl}
              />
            </div>
          );
        })}
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
          }}
        >
          {hoverTip.text}
        </div>
      )}
    </div>
  );
}

/**
 * 探测插件面板是否有「未保存改动」：插件可暴露 GET <src>/api/project → { ok, dirty }（如 bob-mind）。
 * 不支持该约定（404/静态面板/超时）一律按无改动处理，不阻塞关闭。
 */
async function fetchPluginDirty(src: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(new URL('/api/project', src).toString(), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return false;
    const d = (await r.json()) as { ok?: boolean; dirty?: boolean };
    return d?.ok === true && d.dirty === true;
  } catch {
    return false;
  }
}

/** 左列/工具条圆形小图标按钮（2026-09 布局重构后复用） */
function ToolBtn({ title, active, disabled, onClick, children }: { title: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title}
          onClick={onClick}
          disabled={disabled}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-60"
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

/** 项目文件树中的目录/文件节点（仅取新建 MD 弹窗所需字段） */
interface ProjectTreeLikeNode {
  name: string;
  type: 'file' | 'directory';
  children?: ProjectTreeLikeNode[];
}

/** 从项目文件树收集 homework 下所有目录（含根）与各目录已有文件名，供新建 MD 弹窗选择文件夹并查重 */
function collectHomeworkTree(files: ProjectTreeLikeNode[] | undefined): {
  dirs: Array<{ rel: string; label: string; depth: number }>;
  namesByDir: Map<string, Set<string>>;
} {
  const dirs: Array<{ rel: string; label: string; depth: number }> = [{ rel: '', label: 'homework', depth: 0 }];
  const namesByDir = new Map<string, Set<string>>();
  namesByDir.set('', new Set<string>());
  const hw = (files || []).find((f) => f.name === 'homework' && f.type === 'directory');
  const walk = (children: ProjectTreeLikeNode[] | undefined, rel: string, depth: number) => {
    for (const c of children || []) {
      if (c.type === 'directory') {
        const childRel = rel ? `${rel}/${c.name}` : c.name;
        dirs.push({ rel: childRel, label: c.name, depth });
        namesByDir.set(childRel, new Set<string>());
        walk(c.children, childRel, depth + 1);
      } else {
        namesByDir.get(rel)?.add(c.name);
      }
    }
  };
  walk(hw?.children, '', 1);
  return { dirs, namesByDir };
}

function CanvasFlowInner() {
  // 宿主自绘画布数据（2026-09 布局重构）：nodes/edges 为普通本地 state，替代 RF store。
  const [nodes, setNodes] = useState<Node<AiChatNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  // nodes/edges 最新值 ref 镜像：供 getNodes/getEdges/readNode 等"最新值读取"在事件回调/effect 中访问
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const getNodes = useCallback(() => nodesRef.current as Node<AiChatNodeData>[], []);
  const getEdges = useCallback(() => edgesRef.current, []);
  const nodeIdCounter = useRef(0);
  // 画布 wrapper 引用：用于计算真实可视宽度（扣除 overlay）
  const wrapperRef = useRef<HTMLDivElement>(null);
  // wrapper 节点的 state 镜像：workspace 挂载前 wrapperRef.current 恒为 null，
  // 若只在挂载前的 effect 里 observe(Ref.current)，该 effect 不会因 DOM 出现而重跑 →
  // ResizeObserver 永远没挂上 → 右 dock 加宽（打开预览标签）时不再广播可视宽度，
  // 会话卡片保持原宽被面板覆盖。用回调 ref 同步 state，让广播 effect 随挂载重跑。
  const [wrapperEl, setWrapperEl] = useState<HTMLDivElement | null>(null);
  const attachWrapper = useCallback((el: HTMLDivElement | null) => {
    wrapperRef.current = el;
    setWrapperEl(el);
  }, []);
  // 侧边栏当前宽度 ref（2026-09 布局重构后恒为 0：左列常驻，不参与画布宽度计算）
  const sidebarWidthRef = useRef(0);
  // 画布真实可视宽度：wrapper 宽度即对话可视宽度（右 dock 为并列列，不在 wrapper 内）。
  // 供 ChatNode 展开宽度上限使用，避免展开节点被右侧宽屏面板遮挡（14" 屏 + 宽面板场景）
  const computeVisibleCanvasWidth = useCallback(() => {
    const pw = wrapperRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1200);
    const sw = sidebarWidthRef.current;
    return Math.max(pw - sw, 0);
  }, []);
  // 画布缩放锁定（2026-09 宿主重构后恒为锁定：世界层无缩放/平移，zoom 恒 1）
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

  // —— 执行中节点相连的"电流边" effect 已移除（2026-09 宿主重构）：画布不再物理绘制连线，
  // NodeMap 执行中高亮由其自身订阅 node-executing 驱动，无需往 edges.data.executing 回写。——

  // GraphGateway：NodeMap 等附属视图访问画布的"统一对接端口"（太空舱理念）。
  //  - 数据源读宿主 nodes/edges state（本组件经 useMemo 重建实例，getSnapshot 缓存引用稳定）；
  //  - 命令：写本地 nodes state（与画布拖拽/NodeMap Fit 持久化行为一致）+ 视口偏移 state + window 事件总线；
  //  - 快照固定 400×400 占位尺寸，不随节点展开/折叠变化，避免缩略图圆点跳动（fit 漂移根因）。
  const graphListenersRef = useRef<Set<() => void>>(new Set());
  const notifyGraphListeners = useCallback(() => {
    for (const l of graphListenersRef.current) l();
  }, []);
  // 快照缓存：getNodes/getEdges 读 ref（引用稳定），因此 graphGateway 实例保持稳定；
  // nodes/edges 变化时在下方 effect 中重建 snapshotRef 并 notify，getSnapshot 始终返回最新缓存。
  const computeSnapshot = useCallback((): GraphSnapshot => {
    const hostNodes = getNodes();
    const hostEdges = getEdges();
    return {
      nodes: hostNodes.map((n) => ({
        id: n.id,
        title: (n.data as { title?: string } | undefined)?.title || n.id.slice(0, 8),
        x: n.position.x,
        y: n.position.y,
        width: 400,
        height: 400,
        measuredHeight: n.measuredHeight,
        measuredWidth: n.measuredWidth,
        type: (n.type as FlowAiNodeType) || 'aiChat',
        sandboxAppId: (n.data as { sandboxAppId?: string } | undefined)?.sandboxAppId,
        messageCount: ((n.data as { messages?: unknown[] } | undefined)?.messages?.length) || 0,
        createdAt: (n.data as { createdAt?: string } | undefined)?.createdAt,
      })),
      edges: hostEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        relation: e.data?.relation,
        disconnected: Boolean(e.data?.disconnected),
      })),
    };
  }, [getNodes, getEdges]);
  const snapshotRef = useRef<GraphSnapshot | null>(null);
  const graphGateway = useMemo<GraphGateway>(() => {
    // 断开/重连续线：本地 setEdges 即时生效（NodeMap 与画布同步变色），
    // 再落库 /api/edges（delete 软删含下游 markStale，reconnect 仅恢复）——与旧 FloatingEdge 拖断同构
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
    const compute = (): GraphSnapshot => computeSnapshot();
    const cached: GraphSnapshot = compute();
    return {
      subscribe: (listener) => {
        graphListenersRef.current.add(listener);
        return () => {
          graphListenersRef.current.delete(listener);
        };
      },
      getSnapshot: () => snapshotRef.current ?? cached,
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
      // 展开 = 单焦点宿主下切换为当前打开节点（走统一"打开某研究节点"入口）
      expandNode: (nodeId) => window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId } })),
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
  }, [getNodes, getEdges, setNodes, setEdges]);

  // nodes/edges 任一变化 → 重建快照缓存并通知订阅者（NodeMap 等 useSyncExternalStore 消费者重读）
  useEffect(() => {
    snapshotRef.current = computeSnapshot();
    notifyGraphListeners();
  }, [computeSnapshot, notifyGraphListeners, nodes, edges]);

  // 节点选中态变化 → 广播 node-selected（Sidebar 订阅高亮 homework 分组；payload { node_id } 语义保持）
  const lastSelectedBroadcastRef = useRef<string | null>(null);
  useEffect(() => {
    const broadcast = (force: boolean) => {
      const selId = nodes.find((n) => n.selected)?.id ?? null;
      if (!force && selId === lastSelectedBroadcastRef.current) return;
      lastSelectedBroadcastRef.current = selId;
      window.dispatchEvent(new CustomEvent('node-selected', { detail: { node_id: selId } }));
    };
    broadcast(false);
    // 新挂载的订阅方（如 DocEditor）请求重播当前选中节点，避免错过挂载前已广播的状态
    const onRequest = () => broadcast(true);
    window.addEventListener('node-selected-request', onRequest);
    return () => window.removeEventListener('node-selected-request', onRequest);
  }, [nodes]);

  // ---- 画布链导航圆点：由宿主快照 → 分链 → 点击圆点切换焦点节点 ----
  // 订阅网关快照：graphGateway 引用稳定（读 refs + snapshotRef），必须用 useSyncExternalStore
  // 才能在快照重建（nodes/edges 变化）时拿到最新引用，否则 useMemo 缓存旧快照导致左栏树/链目录不更新。
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
  //  其余非激活研究节点由 displayNodes 派生隐藏；目标节点取消隐藏、选中并展开。
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
  }, [graphGateway, setNodes]);

  // 新建研究节点后立即打开（传统 Agent "New Chat"语义）。
  // 节点刚写入受控 state，可能晚于首帧 → 轮询等待节点进入快照后切换焦点；
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
  // Draft 后台任务节点：自动打开/回退规则跳过它们（只在会话区挂任务，不抢占前台）
  const quickBgNodesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const snap = graphGateway.getSnapshot();
    if (focusedNodeId) {
      const cur = snap.nodes.find(
        (n) => n.id === focusedNodeId && isFocusableResearch(n.type),
      );
      if (cur) return;
    }
    const first = snap.nodes.find((n) => isFocusableResearch(n.type) && !quickBgNodesRef.current.has(n.id));
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
    // 首次：直接置焦点（研究节点挂载即大面板，无需再请求展开）
    setFocusedNodeId(nextId);
  }, [graphGateway, focusedNodeId, nodes, switchFocusNode]);

  // 外部统一"打开某研究节点"入口：NodeMap 卡片点击等 → 单焦点切换
  useEffect(() => {
    const onFocus = (e: Event) => {
      const d = (e as CustomEvent<{ nodeId?: string }>).detail;
      if (!d?.nodeId) return;
      const snap = graphGateway.getSnapshot();
      const n = snap.nodes.find((nd) => nd.id === d.nodeId);
      if (!n || !isFocusableResearch(n.type)) return;
      // 用户主动打开后台任务节点后，不再排除于自动回退候选
      quickBgNodesRef.current.delete(d.nodeId);
      switchFocusNode(d.nodeId);
    };
    window.addEventListener('canvas-focus-node', onFocus);
    return () => window.removeEventListener('canvas-focus-node', onFocus);
  }, [graphGateway, switchFocusNode]);

  // 单焦点左侧节点圆点列数据：研究节点按链顺序分组展平；未入链的独立研究节点排尾组。
  // 不再隐藏空会话（messageCount=0）节点——即使尚未执行任务也保留在侧边栏。
  // 排序：按"组内最新创建的会话时间"降序 → 新增加的会话始终排在最上面。
  const focusRail = useMemo(() => {
    type Dot = { id: string; title: string; isNote: boolean; sandboxAppId?: string; identity?: string };
    // 创建时间（ms）：取自 .md frontmatter created_at；
    // 本地刚新建、尚未重载 frontmatter 的节点无 createdAt → 按"最新"（+∞）处理，保证新建会话即时置顶
    const createdMs = new Map<string, number>();
    for (const n of graphSnap.nodes) {
      const t = n.createdAt ? Date.parse(n.createdAt) : NaN;
      createdMs.set(n.id, Number.isFinite(t) ? t : Number.POSITIVE_INFINITY);
    }
    const timeOf = (id: string) => createdMs.get(id) ?? 0;
    const dotOf = (n: (typeof graphSnap.nodes)[number]): Dot => ({
      id: n.id,
      title: n.title,
      isNote: n.type === 'agent-note',
      sandboxAppId: n.sandboxAppId,
      identity: agentIdentityFromNodeType(n.type),
    });
    const groups: Array<{ key: string; dots: Dot[] }> = [];
    const seen = new Set<string>();
    for (const chain of canvasChains) {
      const items = chain.ids
        .map((id) => graphSnap.nodes.find((n) => n.id === id))
        .filter((n): n is NonNullable<(typeof graphSnap.nodes)[number]> => !!n && isFocusableResearch(n.type));
      if (items.length === 0) continue;
      const dots: Dot[] = items.map(dotOf);
      for (const d of dots) seen.add(d.id);
      groups.push({ key: chain.rootId, dots });
    }
    const strayDots = graphSnap.nodes
      .filter((n) => isFocusableResearch(n.type) && !seen.has(n.id))
      .map(dotOf)
      .sort((a, b) => timeOf(b.id) - timeOf(a.id));
    if (strayDots.length > 0) groups.push({ key: '__strays__', dots: strayDots });
    // 组间降序（组键 = 组内最新会话时间）；时间相同保持原有链序（Array.sort 稳定）
    const groupNewest = (g: { dots: Dot[] }) => g.dots.reduce((mx, d) => Math.max(mx, timeOf(d.id)), 0);
    groups.sort((a, b) => {
      const ta = groupNewest(a);
      const tb = groupNewest(b);
      return ta === tb ? 0 : tb > ta ? 1 : -1;
    });
    return groups;
  }, [canvasChains, graphSnap.nodes]);

  // 应用内置确认弹窗（macOS 风格英文文案）
  const { ask: confirmAsk, askChoices: confirmAskChoices, render: confirmRender } = useConfirm();

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
  const lastActiveNodeIdRef = useRef<string | null>(null); // 当前活跃节点：文件面板"发送到当前节点"的投递目标
  // 单焦点宿主下用户可见的会话即"当前节点"，随焦点同步写入 ref。
  // 不能只依赖画布点击赋值：聚焦节点输入栏的 click 被 stopPropagation 拦截（见 ChatNodeKernel 输入栏），
  // 用户点进输入框时并不会触发 onHostCanvasClick，导致"发送到当前节点"始终无目标。
  useEffect(() => {
    lastActiveNodeIdRef.current = focusedNodeId;
  }, [focusedNodeId]);
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
  // ===== 原 ⌘F 底部栏按钮迁入左侧边栏所需状态与逻辑（2026-09） =====
  // Markdown：为当前打开的会话生成 homework Markdown 文档（归属当前项目）
  // 点击后弹窗让用户命名并选择 homework 内的目标文件夹（默认 homework 根）
  const [mdCreating, setMdCreating] = useState(false);
  const [mdDialog, setMdDialog] = useState<{
    nodeId: string;
    dirs: Array<{ rel: string; label: string; depth: number }>;
    namesByDir: Map<string, Set<string>>;
  } | null>(null);
  const [mdName, setMdName] = useState('untitled.md');
  const [mdDir, setMdDir] = useState('');
  const [mdError, setMdError] = useState<string | null>(null);
  const openCreateMdDialog = async () => {
    if (mdCreating) return;
    const targetNodeId = focusedNodeId;
    if (!targetNodeId) {
      window.alert('Please open a conversation node first, then tap Markdown.');
      return;
    }
    setMdCreating(true);
    try {
      // 拉取项目文件树 → 收集 homework 目录树与各目录已有文件名（用于选择文件夹 + 默认名查重）
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_files', project_id: currentProjectId || undefined }),
      });
      const data = await resp.json();
      if (!data.success) {
        window.alert(data.error || 'Failed to load project files');
        return;
      }
      const { dirs, namesByDir } = collectHomeworkTree(data.files as ProjectTreeLikeNode[] | undefined);
      const rootNames = namesByDir.get('') || new Set<string>();
      let name = 'untitled.md';
      let counter = 2;
      while (rootNames.has(name)) {
        name = `untitled-${counter}.md`;
        counter++;
      }
      setMdName(name);
      setMdDir('');
      setMdError(null);
      setMdDialog({ nodeId: targetNodeId, dirs, namesByDir });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to load project files');
    } finally {
      setMdCreating(false);
    }
  };

  // 确认新建：按用户输入的文件名在所选 homework 子目录创建空 md 并打开
  const confirmCreateSidebarMd = async () => {
    if (!mdDialog) return;
    const raw = mdName.trim();
    if (!raw) {
      setMdError('Please enter a file name');
      return;
    }
    if (raw.includes('/') || raw.includes('\\')) {
      setMdError('File name cannot contain slashes');
      return;
    }
    const name = /\.md$/i.test(raw) ? raw : `${raw}.md`;
    if ((mdDialog.namesByDir.get(mdDir) || new Set<string>()).has(name)) {
      setMdError('A file with this name already exists');
      return;
    }
    try {
      const body: Record<string, unknown> = {
        action: 'create_homework_md',
        node_id: mdDialog.nodeId,
        file_name: name,
        target_dir: mdDir,
      };
      if (currentProjectId) body.project_id = currentProjectId;
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!data.success) {
        setMdError(data.error || 'Create MD file failed');
        return;
      }
      setMdDialog(null);
      bus.publish(BusEvents.fileOpen, { source: 'project', path: data.path, name: data.name });
    } catch (e) {
      setMdError(e instanceof Error ? e.message : 'Create MD file failed');
    }
  };
  // Draft：底部快捷发起（Chat 头像 + 可选名称 + 大输入框 → 在当前项目新建 Chat 会话自动执行）。
  // 草稿为全局持久状态（临时便签语义）：与项目无关，切换项目/关闭应用均不丢失，
  // 直到点击发送把内容送进"当前打开的项目"的新建会话（发送后仅清空草稿本体）。
  const QUICKSTART_COMPOSER_KEY = 'bobwork.ui.quickstart.composer';
  const [quickComposerInit] = useState(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(QUICKSTART_COMPOSER_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { quickDraft?: unknown; draftName?: unknown };
      return {
        quickDraft: typeof parsed.quickDraft === 'string' ? parsed.quickDraft : '',
        draftName: typeof parsed.draftName === 'string' ? parsed.draftName : '',
      };
    } catch {
      return null;
    }
  });
  const [quickDraft, setQuickDraft] = useState(quickComposerInit?.quickDraft ?? '');
  const [draftName, setDraftName] = useState(quickComposerInit?.draftName ?? '');
  // 任何修改即时落盘：切项目不清空、重启后仍在（quickstart 统一走 Chat agent，不再持久化 agent 选择）
  useEffect(() => {
    try {
      window.localStorage.setItem(
        QUICKSTART_COMPOSER_KEY,
        JSON.stringify({ quickDraft, draftName }),
      );
    } catch { /* 存储失败静默 */ }
  }, [quickDraft, draftName]);
  // 自动编号状态：记录上次"自动续号"新产生的空编号行起点（lineStart），
  // 供该行再按回车时撤销编号、结束列表（参照有序列表交互：空项回车退出列表）
  const quickAutoNumRef = useRef<{ lineStart: number } | null>(null);
  // 发送 → 在当前打开的项目中新建 Chat 独立会话并自动执行（不占用当前打开会话；名称可作会话标题）。
  // 显式携带 project_id 锚定"当前项目"，避免后端会话级当前项目被 AI 工具操作漂移后发错项目。
  const sendQuickDraft = () => {
    const text = quickDraft.trim();
    if (!text) return;
    window.dispatchEvent(
      new CustomEvent('quick-launch-open', {
        detail: {
          label: (draftName.trim() || text).slice(0, 40) || 'Quick',
          prompt: text,
          auto: true,
          projectId: currentProjectId,
        },
      }),
    );
    setQuickDraft('');
  };
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
      // 清理旧 key，让去除窄档后的新默认宽度生效
      for (const k of PANEL_W_PERSIST_STALE_KEYS) window.localStorage.removeItem(k);
      const stored = Number(window.localStorage.getItem(PANEL_W_PERSIST_KEY));
      if (Number.isFinite(stored) && stored > 0) {
        return Math.min(Math.max(stored, PANEL_W_MIN), PANEL_W_ABS_MAX);
      }
    } catch { /* ignore */ }
    return PANEL_W_DEFAULT;
  });
  // 拖拽 handle 松手时需要读最新面板宽度：用 ref 避免闭包拿到旧值
  const panelWidthRef = useRef(panelWidth);
  useEffect(() => { panelWidthRef.current = panelWidth; }, [panelWidth]);

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

  // 画布可视宽度广播：预览面板/本地文件面板/窗口尺寸变化 → dispatch canvas-visible-width，
  // ChatNode 等订阅者据此实时调整展开宽度上限（避免展开节点被右侧宽屏面板遮挡）。
  // 面板折叠/宽窄切换/本地面板挂载状态变化时重跑（ResizeObserver 需重挂到最新的元素上）；
  // 依赖 focusedNodeId：单焦点切换后新挂载节点需要立刻拿到当前面板宽度（否则新节点
  // 收不到已发生的广播 → 不按已打开面板收窄）。
  // 依赖 wrapperEl：workspace 挂载晚于本 effect 首次执行，必须等 wrapper 出现后再挂 RO。
  useEffect(() => {
    const broadcast = () => {
      window.dispatchEvent(new CustomEvent('canvas-visible-width', { detail: { width: computeVisibleCanvasWidth() } }));
    };
    broadcast();
    // 观察对话容器（wrapper）尺寸：右 dock 折叠/展开会改变 wrapper 宽度
    const ro = new ResizeObserver(broadcast);
    if (wrapperEl) ro.observe(wrapperEl);
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
  }, [computeVisibleCanvasWidth, wrapperEl, panelCollapsed, panelWidth, localExplorerCollapsed, focusedNodeId]);
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

  // 窗口尺寸/左栏/文件面板变化 + 面板展开时，把面板宽度收敛到当前可用上限（防止溢出裁切）
  // 用 useLayoutEffect 确保 paint 前同步收敛，避免"面板先以旧宽度闪出一帧再收缩"的视觉 bug
  useLayoutEffect(() => {
    setPanelWidthRaw((w) => {
      const next = clampPanelWidth(w);
      return next === w ? w : next;
    });
  }, [clampPanelWidth, panelCollapsed]);

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

  // 打开预览面板（面板从折叠→展开）时：自动折叠左栏 + 收敛面板宽度到当前可用空间
  // 用 useLayoutEffect 保证 paint 前同步 flush 这两个 setState，避免"面板先以旧宽度闪出一帧再收缩"
  // 中间对话区"覆盖"的视觉 bug（根因：React render→paint→effect 时序导致旧 panelWidth 先被渲染）
  const prevPanelCollapsedRef = useRef(panelCollapsed);
  useLayoutEffect(() => {
    const wasCollapsed = prevPanelCollapsedRef.current;
    prevPanelCollapsedRef.current = panelCollapsed;
    if (wasCollapsed && !panelCollapsed) {
      // ① 左栏折叠（258→52），为中间对话区让出 206px
      setNavCollapsed(true);
      // ② 面板宽度收敛（同一 batch flush，paint 前一起生效）
      //    此时 clampPanelWidth 还基于旧 navCollapsed 计算，
      //    但 React 会把本轮 layout effect 里所有 setState 合并到同一 render，
      //    所以下一轮 render 时 navCollapsed 已变 true，clampPanelWidth 也会更新
      setPanelWidthRaw((w) => {
        const next = clampPanelWidth(w);
        return next === w ? w : next;
      });
      // 下面的 rAF 留在 layout effect 里调度不影响——它总是 paint 后才执行
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('canvas-visible-width', { detail: { width: computeVisibleCanvasWidth() } }));
      });
    }
  }, [panelCollapsed, clampPanelWidth, computeVisibleCanvasWidth]);
  const toggleNav = useCallback(() => {
    const next = !navCollapsed;
    setNavCollapsed(next);
    // 折叠切换后中栏宽度变化：广播可视宽度（内核据此调整展开宽度上限）
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('canvas-visible-width', { detail: { width: computeVisibleCanvasWidth() } }));
    });
  }, [navCollapsed, computeVisibleCanvasWidth]);

  // 侧边栏展开/折叠仅同步 sidebarWidthRef（2026-09 布局重构后恒为 0，不占画布宽度）与折叠状态；
  // 单焦点宿主无画布平移/缩放（zoom 恒 1），不存在"补偿 transform"导致的漂移问题。
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
    const map: Record<string, React.ComponentType<HostAgentNodeProps>> = { ...nodeTypes };
    for (const a of marketAgents) {
      const flowType = agentFlowType(a.id);
      if (!map[flowType]) map[flowType] = genericAgentNodeFor(a.id);
    }
    return map;
  }, [marketAgents]);
  const { appVersion, setAppVersion, updateStatus, setUpdateStatus, updateVersion, updateProgress, updateErrText } = useUpdateStatus();
  const [mailPending, setMailPending] = useMailPending();
  // 标星小程序（与 SandboxPanel 共享数据源）：在 ⌘F 面板输入框下方与功能按钮同排展示，点击直接打开预览
  const [starredApps] = useStarredApps();
  const [, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [openReaderIds, setOpenReaderIds] = useState<string[]>([]);
  const [activeReaderId, setActiveReaderId] = useState<string | null>(null);
  const [activePanelTab, setActivePanelTab] = useState<{ type: 'node' | 'file' | 'sandbox' | 'template' | 'plugin'; id: string } | null>(null);
  // 切换 BobWork 页面（预览面板 tab）时自动收起 Hippo Browser 为胶囊：
  // 浏览器是独立的系统级置顶窗口，不会随页面切换走，留在最上层会遮住新页面。
  // collapse 幂等，主进程会跳过「已收起 / 已关闭 / 用户正在浏览器里操作」的情况。
  useEffect(() => {
    if (!isDesktop()) return;
    void desktop.hippoBrowser.collapse();
  }, [activePanelTab?.type, activePanelTab?.id]);
  const [pluginPanels, setPluginPanels] = usePluginPanels();
  // 插件面板（Bob-Mind 等）惰性挂载：打开过的插件面板保持挂载并常驻标签栏，
  // 切到文件/会话标签时仅 display 隐藏，避免 iframe 被卸载重建（重建后面板回到初始状态）
  const [openPluginIds, setOpenPluginIds] = useState<string[]>([]);
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

  // 首次进入项目视口恢复已收敛（2026-09 宿主重构）：视口恢复统一由上方
  // [currentProjectId] effect 完成（zoom 锁定恒 1，旧"无保存视口则 fit 全节点"分支恒不触发）。
  const [, setSelectedNodeIds] = useState<Set<string>>(new Set());

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

  // HTML/PDF 文档直接在 Hippo Browser 中打开，并让就地编辑能回写原文件：
  //  - 本地绝对路径 → file:// 直接载入（HTML 可原样编辑并落盘；PDF 主进程重定向到内置批注阅读器）
  //  - 项目内相对路径 → 解析到项目真实磁盘绝对路径后同样走 file://
  //  - 解析失败兜底 → file_proxy 代理（仅只读渲染）
  const openLocalFileInBrowser = useCallback(async (_source: string, filePath: string) => {
    if (!isDesktop()) return;
    let target: string;
    if (isAbsoluteFsPath(filePath)) {
      target = 'file://' + filePath.replace(/^file:\/\//, '');
    } else {
      // 项目相对路径 → 解析项目根目录，拼成磁盘绝对路径
      let abs = '';
      try {
        const d = await (await fetch('/api/projects?action=current')).json();
        const pRoot: string = d?.project?.path || '';
        if (pRoot) abs = `${pRoot}/${filePath.replace(/^[\\/]/, '')}`;
      } catch {
        abs = '';
      }
      if (abs) {
        target = 'file://' + abs;
      } else {
        try {
          const list = await (await fetch('/api/projects')).json();
          const pid: string = (list && list.current_id) || '';
          target = `${window.location.origin}/api/projects?action=file_proxy&project_id=${encodeURIComponent(pid)}&file_path=${encodeURIComponent(filePath)}`;
        } catch {
          return;
        }
      }
    }
    void desktop.hippoBrowser.open();
    void desktop.hippoBrowser.navigate(target);
  }, []);

  // Step 2：订阅 file.open 事件 —— 任意舱（目录浏览器/项目树/搜索/素材）发布打开意图，查看舱统一处理
  useEffect(() => {
    return bus.subscribe<FileOpenPayload>(BusEvents.fileOpen, (p) => {
      // 文档类（HTML/PDF/图片）不进入预览面板，直接交由 Hippo Browser 打开（PDF/图片由主进程重定向到对应查看页）
      if (/\.html?$/i.test(p.name) || /\.pdf$/i.test(p.name) || /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(p.name)) {
        void openLocalFileInBrowser(p.source, p.path);
        return;
      }
      openFileTab(p.source, p.name, p.path);
    });
  }, [openFileTab, openLocalFileInBrowser]);

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
                      ? 'Granting lets it read and manipulate nodes and edges.'
                      : 'Granting lets it read nodes and edges.') +
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

  // 插件面板 tab（注册表驱动，每个插件一个单例）：在右侧预览面板打开；打开后常驻标签栏
  const openPluginPanel = useCallback((pluginId: string) => {
    if (!pluginPanels.some((p) => p.pluginId === pluginId)) return;
    setOpenPluginIds((prev) => (prev.includes(pluginId) ? prev : [...prev, pluginId]));
    setActivePanelTab({ type: 'plugin', id: pluginId });
    setPanelCollapsed(false);
  }, [pluginPanels]);

  const closePluginPanel = useCallback(async (pluginId: string) => {
    // 插件有未保存到项目的改动时先询问：保存 / 不保存 / 取消（取消则不关闭）
    const entry = pluginPanels.find((p) => p.pluginId === pluginId);
    if (entry?.src && (await fetchPluginDirty(entry.src))) {
      const choice = await confirmAskChoices({
        title: 'Unsaved changes',
        message: `${entry.name} has changes that haven't been saved to the current project. Save before closing?`,
        // 取消由 ConfirmDialog 自带的 Cancel 提供（避免重复按钮）
        choices: [
          { label: 'Save', value: 'save' },
          { label: "Don't Save", value: 'discard', danger: true },
        ],
      });
      // 仅 save / discard 继续关闭；其余（Cancel 按钮、Esc、点遮罩）一律取消。
      // 注意：ConfirmDialog 的取消路径 askChoices 实际 resolve 的是 false（非 null），故用白名单判断。
      if (choice !== 'save' && choice !== 'discard') return;
      if (choice === 'save') {
        try {
          await fetch(new URL('/api/project/save', entry.src).toString(), { method: 'POST' });
        } catch {
          // 保存失败仍继续关闭，避免面板卡住（插件侧已 toast 提示）
        }
      }
    }
    // 退出常驻：从标签栏移除并卸载对应 iframe
    setOpenPluginIds((prev) => prev.filter((id) => id !== pluginId));
    setActivePanelTab((prev) => {
      if (prev?.type !== 'plugin' || prev.id !== pluginId) return prev;
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
  }, [fileTabs, sandboxTabs, openReaderIds, pluginPanels, confirmAskChoices]);

  // 订阅 open-plugin-panel：左侧快捷入口 / 其它 UI 派发，打开对应插件面板 tab
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) openPluginPanel(id);
    };
    window.addEventListener('open-plugin-panel', handler);
    return () => window.removeEventListener('open-plugin-panel', handler);
  }, [openPluginPanel]);

  // 兼容旧入口事件 open-bob-mind-panel（⌘F / 旧快捷按钮）→ 落到 Bob-Mind 插件面板
  useEffect(() => {
    const handler = () => openPluginPanel('bob-mind-mcp');
    window.addEventListener('open-bob-mind-panel', handler);
    return () => window.removeEventListener('open-bob-mind-panel', handler);
  }, [openPluginPanel]);

  // Draft（底部快捷发起，auto=true）：新建独立 chat 节点，挂载后自动执行；
  // 不占用当前打开会话；名称（或提示词前 40 字）作为会话标题。
  // project_id 由派发方（Draft）显式锚定当前打开的项目，建会话不落错项目。
  useEffect(() => {
    const handler = async (e: Event) => {
      const d = (e as CustomEvent<{ label?: string; agent?: string; prompt?: string; auto?: boolean; projectId?: string }>).detail;
      const label = (d?.label || 'Quick').slice(0, 40);
      const prompt = d?.prompt || '';
      const auto = d?.auto === true;
      const agent = d?.agent && d.agent !== 'chat' ? d.agent : 'chat';
      const projectId = d?.projectId || undefined;
      const cx = typeof window !== 'undefined' ? Math.round(window.innerWidth / 2) - 140 : 200;
      const cy = typeof window !== 'undefined' ? Math.round(window.innerHeight / 2) - 120 : 160;
      // 后台任务节点置于画布外很远（但仍挂载可见尺寸），保证内核能正常启动执行且不打扰当前视图
      const newX = auto ? -9000 + Math.round(Math.random() * 6000) : cx + Math.round((Math.random() - 0.5) * 120);
      const newY = auto ? -9000 + Math.round(Math.random() * 6000) : cy + Math.round((Math.random() - 0.5) * 80);
      try {
        const resp = await fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            title: label,
            model: DEFAULT_MODEL_ID,
            sources: [],
            node_type: agent,
            position_x: newX,
            position_y: newY,
            project_id: projectId,
          }),
        });
        const data = await resp.json();
        if (!data.success || !data.node_id) return;
        const newNodeId = data.node_id as string;
        const newNode: Node<AiChatNodeData> = {
          id: newNodeId,
          type: agentFlowType(agent),
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
        if (auto && prompt && typeof window !== 'undefined') {
          // 挂载即自动执行：写入待执行缓冲（节点 kernel 挂载后消费，忙碌自动排队）
          (window.__pendingNodeTasks ??= {})[newNodeId] = prompt;
        }
        if (auto) quickBgNodesRef.current.add(newNodeId);
        setNodes((nds) => [...nds, newNode]);
        if (!prompt) return;
        // 仅入会话语义：不切换/不聚焦新会话，让其在后台自动执行（会话区新增一条任务）
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

  // 启动即进入项目面板（待办面板）：受项目面板标题栏 “Open on launch” 开关控制——
  // 开 = 每次启动自动打开项目面板一次；关 = 直接进入上次关闭时的项目画布。
  // 会话内用户手动关闭后不再自动弹出（ref 防抖，避免重渲染/切项目误触发）。
  const autoOpenedBoardRef = useRef(false);
  useEffect(() => {
    if (!hasProject || autoOpenedBoardRef.current) return;
    autoOpenedBoardRef.current = true;
    let openBoardOnLaunch = true;
    try {
      openBoardOnLaunch = localStorage.getItem(LAUNCH_BOARD_KEY) !== '0';
    } catch { /* 读取失败时按默认开启处理 */ }
    if (openBoardOnLaunch) setProjectBoardOpen(true);
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
        n.node_type === 'bobby'
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
        }
      } catch {
        // 创建初始节点失败忽略
      }
    }
  }, [setNodes, setEdges]);

  // 启动时恢复节点和连线（先加载节点，再加载连线，避免边引用不存在的节点）
  useEffect(() => {
    void loadProjectData();
  }, [loadProjectData]);

  // 无刷新切换项目：监听 Sidebar / 看板广播的 bobagent:project-switched，
  // 更新 currentProjectId 并重载节点/连线数据（替代整页 reload，避免白屏闪烁）；
  // 数据就绪后广播 project-canvas-ready，供发起方（项目看板）据此关闭"Opening…"过渡层
  useEffect(() => {
    const handler = async (e: Event) => {
      const projectId = ((e as CustomEvent).detail as { projectId?: string })?.projectId;
      if (!projectId) return;
      setCurrentProjectId(projectId);
      setHasProject(true);
      setSelectedNodeIds(new Set());
      // 切换项目同样属于「切页」：顺手把置顶的 Hippo Browser 收起为胶囊（幂等）
      if (isDesktop()) void desktop.hippoBrowser.collapse();
      try {
        await loadProjectData();
      } finally {
        window.dispatchEvent(new CustomEvent('bobagent:project-canvas-ready', { detail: { projectId } }));
      }
    };
    window.addEventListener('bobagent:project-switched', handler);
    return () => window.removeEventListener('bobagent:project-switched', handler);
  }, [loadProjectData]);

  // 节点间避让（单焦点画布 2026-09 起不再需要"展开时推开邻居"）：
  // 中栏同一时刻仅承载 focusedNodeId 一个研究节点，其余研究节点由 displayNodes 置 hidden，
  // 不存在展开节点与可见邻居重叠的场景；node-expanded/node-collapsed/node-expand-resize
  // 广播已随 ChatNodeKernel 恒展开收敛而整体移除（死链清理）。

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
        // 用户在"是否强制锁定"确认中主动取消：静默终止，不弹 alert / 不记 error（正常取消流程）
        if (lockRes.error === '用户取消锁定') return;
        // 真实锁定失败：提示并终止建边
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

  // 左栏会话树重命名：内联输入（Electron 不支持 window.prompt，故不用弹窗）
  // 正在内联编辑的节点 id（null = 未编辑）+ 草稿文本
  const [railEditingId, setRailEditingId] = useState<string | null>(null);
  const [railEditDraft, setRailEditDraft] = useState('');
  const railRenameCancelledRef = useRef(false);

  // 进入内联编辑：用当前标题预填草稿
  const startRenameNodeFromRail = useCallback((nodeId: string) => {
    const node = getNodes().find((n) => n.id === nodeId);
    const currentTitle = (node?.data as AiChatNodeData | undefined)?.title || '';
    railRenameCancelledRef.current = false;
    setRailEditDraft(currentTitle);
    setRailEditingId(nodeId);
  }, [getNodes]);

  // 提交重命名：乐观更新 setNodes + 持久化到 /api/nodes（Esc 取消时直接退出，不落盘）
  const commitRenameNodeFromRail = useCallback((nodeId: string) => {
    setRailEditingId(null);
    if (railRenameCancelledRef.current) {
      railRenameCancelledRef.current = false;
      return;
    }
    const trimmed = railEditDraft.trim();
    const node = getNodes().find((n) => n.id === nodeId);
    const currentTitle = ((node?.data as AiChatNodeData | undefined)?.title || '').trim();
    if (!trimmed || trimmed === currentTitle) return;
    // 乐观更新前端
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== nodeId) return n;
        const d = (n.data ?? {}) as Record<string, unknown>;
        return { ...n, data: { ...d, title: trimmed } as AiChatNodeData };
      }),
    );
    // 持久化到后端（nodeId 在 nodes 路由里是 md 文档 id，与 rail 里用的是同一个）
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'rename_title',
        node_id: nodeId,
        new_title: trimmed,
      }),
    }).catch((err) => {
      console.error('会话重命名失败:', err);
    });
  }, [getNodes, setNodes, railEditDraft]);

  // 取消重命名（Esc）
  const cancelRenameNodeFromRail = useCallback(() => {
    railRenameCancelledRef.current = true;
    setRailEditingId(null);
  }, []);

  // 左栏三点菜单打开状态（node id → 打开；null → 全部关闭）
  const [railMenuOpenId, setRailMenuOpenId] = useState<string | null>(null);

  // 节点选中态广播已上收为独立 effect（随 nodes 变化检测 selected 变化 → node-selected 事件）：
  // 见 graphGateway 之后的 lastSelectedBroadcastRef effect。


  // 批注框自动跟随包裹：卡片位置/尺寸变化时，annotation 节点实时重算包围盒并同步；
  // 关联卡片全部删除 → 删除批注框
  useEffect(() => {
    const annotations = nodes.filter((n) => n.type === 'annotation');
    if (annotations.length === 0) return;
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
    [setNodes, setEdges],
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
    [getNodes, getEdges, setNodes, setEdges, createBobbyNode],
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
    [setNodes, setEdges],
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
        return;
      }
      const src = getNodes().find((n) => n.id === sourceNodeId);
      const pos = {
        x: (src?.position.x ?? 400) + 500,
        y: (src?.position.y ?? 200) + 40,
      };
      createAgentTeamsNode(pos, { sourceNodeId, autoFocus: true });
    },
    [getNodes, getEdges, setNodes, setEdges, createAgentTeamsNode],
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

  // 点击画布（宿主自绘语义，替代 RF onPaneClick + 节点点击选中）：
  //  - 空白处：取消全部选中（排除框选拖拽后的 click 事件）；
  //  - 节点上：选中该节点（RF 点击即选中语义；研究节点单焦点内保持选中，豁免节点驱动 Prompt Bar 等）。
  // 注意：点击节点/连线/Handle/浮层等非空白区域时，click 也会冒泡到这里，
  // 必须跳过取消选中，否则节点刚被选中就被重置（"已执行节点点击输入框不弹出"的根因）。
  const onHostCanvasClick = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (!target) return;
    if (isHittingCanvasBlank(event)) {
      setSelectedNodeIds(new Set());
      setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
      return;
    }
    const nodeEl = target.closest('[data-host-node]') as HTMLElement | null;
    if (!nodeEl) return;
    const nodeId = nodeEl.getAttribute('data-host-node-id');
    if (!nodeId) return;
    // 点击节点总是保持选中：红色高亮 + 弹出输入框。
    // 注意：不能 toggle 取消选中——节点内部（输入栏/消息区）的 click 会冒泡到此处，
    // 若"再次点击取消"会把输入框点没（点击输入栏 → 取消选中 → 输入框消失的 bug）。
    // 取消选中通过点击画布空白处完成。
    lastActiveNodeIdRef.current = nodeId;
    setNodes((nds) => {
      if (nds.some((n) => n.id === nodeId && n.selected)) return nds;
      return nds.map((n) => ({ ...n, selected: n.id === nodeId }));
    });
  }, [isHittingCanvasBlank, setNodes, setSelectedNodeIds]);

  // === 画布内自动聚焦已移除（用户要求选中节点不再自动放大画布） ===

  // 创建新的 AI Chat 节点，返回节点 ID（无则 null）
  // 单焦点宿主取消平移/缩放（zoom 恒 1），落点用固定常量即可（不再按视口反算屏幕中央）
  const handleCreateNode = useCallback(async (): Promise<string | null> => {
    const center = { x: 200, y: 100 };

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
  }, [setNodes, openNewlyCreatedNode]);

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

  // ============ 宿主自绘节点通道（2026-09）：NodeHostContext 注入值 + 删除统一入口 ============
  // 删除节点 + 关联边（Annotation ✕ / Bobby / AgentTeams / ImageGen ✕ 标题栏删除统一入口）：
  // 与旧实现一致 —— POST /api/nodes delete（nodeMdId 档案）+ 连带 imagegenAlbum 子节点/连线的清理。
  const deleteNodeWithEdgesHost = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    const nData = (node?.data ?? {}) as Record<string, unknown>;
    const nodeMdId = typeof nData.nodeMdId === 'string' && nData.nodeMdId
      ? nData.nodeMdId
      : nodeId;
    // 附件目录收集（与左栏 rail 删除一致），避免 attachments/{folder} 残留
    const attachmentFolders = new Set<string>();
    const msgs = Array.isArray((nData as { messages?: unknown }).messages)
      ? ((nData as { messages?: Array<{ attachments?: Array<{ path?: string }> }> }).messages ?? [])
      : [];
    for (const msg of msgs) {
      for (const att of msg.attachments ?? []) {
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
    }).then((r) => {
      if (!r.ok) console.error('Host node delete failed:', r.status);
      window.dispatchEvent(new CustomEvent('local-files-changed'));
    }).catch((err) => console.error('Host node delete request error:', err));
    // 本地移除：节点自身 + 关联边
    setNodes((nds) =>
      nds.filter((n) => n.id !== nodeId),
    );
    setEdges((eds) =>
      eds.filter((e) =>
        e.source !== nodeId && e.target !== nodeId && e.id !== `edge-album-${nodeId}`,
      ),
    );
  }, [setNodes, setEdges]);

  // NodeHostContext 注入值：节点组件（ChatNodeKernel 等）经 useNodeHost() 读画布数据 + 宿主原语
  const nodeHostValue = useMemo<NodeHostValue>(() => ({
    edges,
    subscribe: (listener) => {
      graphListenersRef.current.add(listener);
      return () => {
        graphListenersRef.current.delete(listener);
      };
    },
    readNode: (nodeId) => nodesRef.current.find((n) => n.id === nodeId),
    readNodes: () => nodesRef.current as HostNode[],
    readEdges: () => edgesRef.current,
    updateNodes: (updater) => {
      setNodes((prev) => updater(prev as unknown as HostNode<unknown>[]) as unknown as HostNode<AiChatNodeData>[]);
    },
    addNodes: (ns) => {
      setNodes((prev) => [...prev, ...(ns as unknown as HostNode<AiChatNodeData>[])]);
    },
    addEdges: (es) => {
      setEdges((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        let changed = false;
        for (const e of es) {
          if (!byId.has(e.id)) { byId.set(e.id, e); changed = true; }
        }
        return changed ? Array.from(byId.values()) : prev;
      });
    },
    removeNode: (nodeId) => setNodes((prev) => prev.filter((n) => n.id !== nodeId)),
    removeEdge: (edgeId) => setEdges((prev) => prev.filter((e) => e.id !== edgeId)),
    deleteNodeWithEdges: (nodeId) => deleteNodeWithEdgesHost(nodeId),
  }), [edges, setNodes, setEdges, deleteNodeWithEdgesHost]);

  // 宿主节点渲染：按节点 type 分发到对应组件（单焦点研究节点 + 豁免常驻节点，均按世界坐标定位）
  const renderHostNode = (hostNode: Node<AiChatNodeData>) => {
    const nodeId = hostNode.id;
    const selected = hostNode.selected ?? false;
    switch (hostNode.type) {
      
      
      
      
      
      
      case 'bobby':
        return <BobbyNode id={nodeId} data={hostNode.data as unknown as BobbyNodeData} selected={selected} />;
      case 'agentTeams':
        return <AgentTeamsNode id={nodeId} data={hostNode.data as unknown as AgentTeamsNodeData} selected={selected} />;
      case 'annotation':
        return <AnnotationNode id={nodeId} data={hostNode.data as AiChatNodeData} selected={selected} />;
      default: {
        // 研究节点（aiChat/aiCoding/agent-*）：经 AGENT_NODE_SHELLS/通用壳分发，身份由壳注入
        const Comp = effectiveNodeTypes[hostNode.type] ?? ChatNode;
        return <Comp id={nodeId} data={hostNode.data as AiChatNodeData} selected={selected} />;
      }
    }
  };
  // 宿主画布层（替代 RF 的 hidden 过滤）：displayNodes 派生已编码单焦点隐藏语义。
  // 两类节点保持"隐藏挂载"（display:none，仍在后台执行）：
  //  1) Draft 后台任务节点（quickBgNodesRef）
  //  2) 正在执行（executingNodeIds）的节点 —— 切走会话后任务不中断，会话区绿点持续
  const worldVisibleNodes = useMemo(
    () =>
      displayNodes.filter(
        (n) => !n.hidden || quickBgNodesRef.current.has(n.id) || executingNodeIds.has(n.id),
      ),
    [displayNodes, executingNodeIds],
  );
  // 聊天流式主区聚焦节点（2026-09 普通界面化）：聚焦研究节点占中栏全宽；
  //   非聚焦/隐藏节点仅作 display:none 保活挂载，不渲染进主视觉流。
  const focusedHostNode = useMemo(
    () => displayNodes.find((n) => n.id === focusedNodeId && !n.hidden) ?? null,
    [displayNodes, focusedNodeId],
  );

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
      pluginPanels={pluginPanels}
      onClosePluginTab={closePluginPanel}
      openPluginIds={openPluginIds}
      templateInitialScene={templateInitialScene}
      onToggleCollapse={handleTogglePanel}
      currentProjectId={currentProjectId}
      outcomeModeTabIds={outcomeModeTabIds}
      sandboxRefreshTick={sandboxRefreshTick}
      onPanelWidthChange={setPanelWidthLive}
      onPanelWidthCommit={() => persistPanelWidth(panelWidthRef.current)}
    />
  );

  // 功能按钮（2026-09-12 从左侧栏迁回 ⌘F 面板）：渲染在 ⌘F 输入框下方，仅图标 + 悬停显示名称
  const navActions: Array<{ key: string; label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }> = [
    { key: 'store', label: 'Extensions Store', icon: <Blocks className="h-4 w-4 shrink-0" />, onClick: () => window.dispatchEvent(new CustomEvent('skill-store-open')) },
    { key: 'miniapps', label: 'Mini Programs', icon: <Boxes className="h-4 w-4 shrink-0" />, onClick: () => window.dispatchEvent(new CustomEvent('sandbox-store-open')) },
    { key: 'teams', label: 'Agent Teams', icon: <Users className="h-4 w-4 shrink-0" />, onClick: () => window.dispatchEvent(new CustomEvent('team-panel-open')) },
    { key: 'calendar', label: 'Calendar', icon: <Calendar className="h-4 w-4 shrink-0" />, onClick: () => setCalendarOpen(true) },
    // Bob Notes 主入口 → 打开 bob-notes-mcp 原厂 Web 面板（宿主定制 UI 壳已去除）
    { key: 'notes', label: 'Bob Notes', icon: <NotebookText className="h-4 w-4 shrink-0" />, onClick: () => window.dispatchEvent(new CustomEvent('open-plugin-panel', { detail: { id: 'bob-notes-mcp' } })) },
  ];
  // 快速工具（仅图标）：插件面板（注册表驱动）/ Templates / Markdown，供展开态“项目下方工具条”与折叠窄栏复用
  const quickToolIcon = (key: string, size = 'h-4 w-4') => {
    const cls = `${size} shrink-0`;
    if (key.startsWith('plugin:')) {
      const panel = pluginPanels.find((p) => p.pluginId === key.slice('plugin:'.length));
      const Icon = pluginPanelTabIcon(panel?.icon);
      return <Icon className={cls} />;
    }
    switch (key) {
      case 'templates':
        return <LayoutTemplate className={cls} />;
      case 'md':
        return mdCreating ? <Loader2 className={`${cls} animate-spin`} /> : <FilePen className={cls} />;
    }
  };
  const quickTools: Array<{ key: string; label: string; onClick: () => void; disabled?: boolean }> = [
    ...pluginPanels
      // bob-notes 不再从“项目下方工具条”快捷入口进入（仍可经侧栏 Bob Notes 打开）
      .filter((p) => p.pluginId !== 'bob-notes-mcp')
      .map((p) => ({
        key: `plugin:${p.pluginId}`,
        label: p.name,
        onClick: () => window.dispatchEvent(new CustomEvent('open-plugin-panel', { detail: { id: p.pluginId } })),
      })),
    { key: 'templates', label: 'Templates', onClick: () => window.dispatchEvent(new CustomEvent('open-template-panel', { detail: {} })) },
    { key: 'md', label: 'Markdown', onClick: () => void openCreateMdDialog(), disabled: mdCreating },
  ];

  return (
    <NodeReaderContext.Provider value={openReader}>
      {hasProject === null ? (
        <div className="flex h-screen w-screen items-center justify-center" style={{ backgroundColor: 'var(--background)' }}>
          <div className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Loading...
          </div>
        </div>
      ) : hasProject ? (
        // 根容器显式裁剪：全屏应用不应出现 body 滚动。
        // 预览面板等 overlay 依赖 self-stretch/h-full 约束高度，若某渲染时机下约束失效，
        // 长文档会把面板撑到视口底部之外（"文档出现在画布下方 + 界面可滑动"），此处兜底裁剪。
        <div className="relative flex h-screen w-screen overflow-hidden">
          {/* 顶部拖拽区域：absolute 覆盖在画布之上（z-30，低于悬浮面板 z-40）。
              这样三块面板的 top-[8px] 直接相对窗口顶部，mac 红绿灯覆盖在左侧面板左上角。
              高度必须 ≤ 8px（= 会话卡片标题栏 py-2 的上内边距）：
              中栏会话卡片顶到窗口顶部，卡片仅 z-[1] 低于本层，若本层更高会吃掉
              标题栏按钮的点击热区（表现为"只能点击图标下方"）。 */}
          <div
            className="absolute inset-x-0 top-0 z-[30] h-2 select-none"
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
            className={`relative flex ${navCollapsed ? 'w-[52px]' : 'w-[258px]'} shrink-0 select-none flex-col overflow-hidden transition-[width] duration-150`}
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
            {/* 侧栏顶部真实搜索框：边输入边出结果（不弹 ⌘F 浮层面板） */}
            <div className="px-2 pb-0.5">
              <NavSearchBox />
            </div>
            {/* 搜索框下方功能入口（2026-09-12）：原「项目下方工具条」除 Trash 外迁入此处，以图标+文字展示 */}
            <div className="px-2 pt-1">
              <button
                type="button"
                onClick={() => setProjectBoardOpen(true)}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-13 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
              >
                <LayoutGrid className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Project board</span>
              </button>
              <button
                type="button"
                onClick={() => setLocalExplorerCollapsed((v) => !v)}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-13 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
              >
                <Monitor className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Local files</span>
              </button>
              <button
                type="button"
                onClick={() => void desktop.hippoBrowser.open()}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-13 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
              >
                <Globe className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Browser</span>
              </button>
              {quickTools.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={t.onClick}
                  disabled={t.disabled}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-13 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-default disabled:opacity-70"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  {quickToolIcon(t.key)}
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                </button>
              ))}
            </div>
            {/* 项目栏上方刻痕分隔（居中短痕，两端渐隐） */}
            <div aria-hidden className="flex justify-center pb-0.5 pt-2">
              <span className="h-[0.5px] w-52" style={{ background: 'linear-gradient(to right, transparent, var(--line) 25%, var(--line) 75%, transparent)' }} />
            </div>
            {/* 项目名标题栏：左侧项目名（点击切换项目），右侧 ＋ 添加会话（chat/coding/note/butler/imageGen 等类型下拉） */}
            <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('workspace-toggle'))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ cursor: 'pointer' }}
                  >
                    <Folder className="h-4 w-4 shrink-0" style={{ color: 'var(--primary)' }} />
                    <span className="min-w-0 flex-1 truncate text-13 font-medium" style={{ color: 'var(--ink-strong)' }}>
                      {currentProjectTitle || 'Project'}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Switch project</TooltipContent>
              </Tooltip>
              {/* 新建项目（纯图标，位于新建会话按钮之前） */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('create-project-open'))}
                    className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-hover)] hover:text-[var(--ink-strong)]"
                  >
                    <Plus className="h-[13px] w-[13px] shrink-0" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">New project</TooltipContent>
              </Tooltip>
              <div className="relative -ml-1 shrink-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setAddMenuOpen((v) => !v)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-hover)] hover:text-[var(--ink-strong)]"
                    >
                      <MessageCircle className="h-[13px] w-[13px] shrink-0" />
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
                        backgroundColor: 'var(--popover)',
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
                        } else if (a.id === 'butler') {
                          onClick = () => createAgentNode('butler', 'Butler', pos);
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
                    </div>
                  </>
                )}
              </div>
            </div>
            {/* 会话/任务树：链分组（含散落节点），点击切换到该节点（左内边距与项目图标对齐） */}
            <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar pl-[9.5px] pb-2 pr-1.5">
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
                      {/* 根行 = 会话标题（点击聚焦根节点）；hover 显示三点菜单 */}
                      <div className="group relative flex items-center">
                        {railEditingId === rootDot?.id ? (
                          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1">
                            {AGENT_MENU_ICONS[rootDot?.identity ?? '']?.icon ?? AGENT_MENU_DEFAULT_ICON.icon}
                            <input
                              autoFocus
                              value={railEditDraft}
                              onChange={(e) => setRailEditDraft(e.target.value)}
                              onFocus={(e) => e.currentTarget.select()}
                              onBlur={() => {
                                if (rootDot) commitRenameNodeFromRail(rootDot.id);
                              }}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') {
                                  if (rootDot) commitRenameNodeFromRail(rootDot.id);
                                } else if (e.key === 'Escape') {
                                  cancelRenameNodeFromRail();
                                }
                              }}
                              className="min-w-0 flex-1 rounded bg-transparent px-0.5 text-xs outline-none"
                              style={{ color: 'var(--ink-strong)', fontWeight: 600 }}
                            />
                          </div>
                        ) : (
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
                              <span className="shrink-0 text-11" style={{ color: 'var(--ink-faint)' }}>{group.dots.length - 1}</span>
                            )}
                          </button>
                        )}
                        <div className="relative">
                          <button
                            type="button"
                            title="More actions"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRailMenuOpenId((prev) => prev === rootDot?.id ? null : rootDot?.id ?? null);
                            }}
                            className={`flex h-5 shrink-0 items-center justify-center rounded text-[var(--ink-faint)] transition-all duration-100 hover:bg-[var(--paper-hover)] hover:text-[var(--ink-strong)] ${
                              railMenuOpenId === rootDot?.id ? 'w-5 text-[var(--ink-strong)]' : 'w-0 overflow-hidden group-hover:w-5'
                            }`}
                          >
                            <MoreVertical className="h-3.5 w-3.5 shrink-0" />
                          </button>
                          {railMenuOpenId === rootDot?.id && (
                            <>
                              <div className="fixed inset-0 z-[290]" onClick={() => setRailMenuOpenId(null)} />
                              <div
                                className="absolute right-0 top-full z-[300] mt-0.5 w-32 rounded-lg border p-1 shadow-lg"
                                style={{
                                  borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                                  backgroundColor: 'var(--popover)',
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRailMenuOpenId(null);
                                    if (rootDot) startRenameNodeFromRail(rootDot.id);
                                  }}
                                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                                  style={{ color: 'var(--ink)' }}
                                >
                                  <Pencil className="h-3 w-3 shrink-0" />
                                  <span>Rename</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRailMenuOpenId(null);
                                    if (rootDot) void deleteNodeFromRail(rootDot.id);
                                  }}
                                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--danger-soft)]"
                                  style={{ color: 'var(--danger)' }}
                                >
                                  <Trash className="h-3 w-3 shrink-0" />
                                  <span>Delete</span>
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                      {group.dots.slice(1).map((dot) => {
                        const active = focusedNodeId === dot.id;
                        const dotState = railDotState(dot.id);
                        return (
                          <div key={dot.id} className="group relative flex items-center">
                            {railEditingId === dot.id ? (
                              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1">
                                <span className="block h-1.5 w-1.5 shrink-0" />
                                <input
                                  autoFocus
                                  value={railEditDraft}
                                  onChange={(e) => setRailEditDraft(e.target.value)}
                                  onFocus={(e) => e.currentTarget.select()}
                                  onBlur={() => commitRenameNodeFromRail(dot.id)}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') {
                                      commitRenameNodeFromRail(dot.id);
                                    } else if (e.key === 'Escape') {
                                      cancelRenameNodeFromRail();
                                    }
                                  }}
                                  className="min-w-0 flex-1 rounded bg-transparent px-0.5 text-xs outline-none"
                                  style={{ color: 'var(--ink-strong)', fontWeight: 600 }}
                                />
                              </div>
                            ) : (
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
                            )}
                            <div className="relative">
                              <button
                                type="button"
                                title="More actions"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRailMenuOpenId((prev) => prev === dot.id ? null : dot.id);
                                }}
                                className={`flex h-5 shrink-0 items-center justify-center rounded text-[var(--ink-faint)] transition-all duration-100 hover:bg-[var(--paper-hover)] hover:text-[var(--ink-strong)] ${
                                  railMenuOpenId === dot.id ? 'w-5 text-[var(--ink-strong)]' : 'w-0 overflow-hidden group-hover:w-5'
                                }`}
                              >
                                <MoreVertical className="h-3.5 w-3.5 shrink-0" />
                              </button>
                              {railMenuOpenId === dot.id && (
                                <>
                                  <div className="fixed inset-0 z-[290]" onClick={() => setRailMenuOpenId(null)} />
                                  <div
                                    className="absolute right-0 top-full z-[300] mt-0.5 w-32 rounded-lg border p-1 shadow-lg"
                                    style={{
                                      borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                                      backgroundColor: 'var(--popover)',
                                    }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setRailMenuOpenId(null);
                                        startRenameNodeFromRail(dot.id);
                                      }}
                                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                                      style={{ color: 'var(--ink)' }}
                                    >
                                      <Pencil className="h-3 w-3 shrink-0" />
                                      <span>Rename</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setRailMenuOpenId(null);
                                        void deleteNodeFromRail(dot.id);
                                      }}
                                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--danger-soft)]"
                                      style={{ color: 'var(--danger)' }}
                                    >
                                      <Trash className="h-3 w-3 shrink-0" />
                                      <span>Delete</span>
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>
            {/* Draft（左侧栏最底部、品牌栏上方）：Chat 头像 + 可选名称 + 大输入框 → 新建 Chat 会话自动执行。
                做旧稿纸配色：Draft 是"临时便签"性质的全局草稿，用极淡暖米稿纸底 + 微弱做旧渐变，
                与正式会话输入区分（冷灰画布上透出一张旧稿纸） */}
            <div
              className="mx-2 mb-1.5 mt-0.5 flex flex-col gap-1.5 rounded-lg border p-1.5"
              style={{
                backgroundColor: '#f8f4e8',
                backgroundImage: 'linear-gradient(152deg, rgba(255,255,255,0.55) 0%, rgba(198,172,112,0.09) 100%)',
                borderColor: 'rgba(146,120,66,0.26)',
              }}
            >
              <div className="flex items-center gap-1.5">
                {/* Chat 机器人头像 = Run 按钮（Send 已融入）：
                    无草稿 → 白色水印线条、禁用；有草稿 → 线条变黑 + 呼吸灯提醒可发送，
                    点击把草稿发到当前项目新建 Chat 会话 */}
                <button
                  type="button"
                  disabled={!quickDraft.trim()}
                  onClick={() => void sendQuickDraft()}
                  title={quickDraft.trim() ? 'Run in current project (⌘/Ctrl+Enter)' : 'Type a prompt, then tap to run'}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all hover:opacity-85 active:scale-95 disabled:cursor-default disabled:hover:opacity-100${
                    quickDraft.trim() ? ' animate-pulse [animation-duration:1.8s]' : ''
                  }`}
                >
                  <Bot
                    className="h-6 w-6 shrink-0"
                    style={{ color: quickDraft.trim() ? 'var(--ink)' : '#FFFFFF', strokeWidth: 2 }}
                  />
                </button>
                <input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="Name (optional)"
                  title="Session title (optional)"
                  className="min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none"
                  style={{ borderColor: 'transparent', backgroundColor: 'rgba(255,255,255,0.32)', color: 'var(--ink)', boxShadow: 'inset 0 1px 1px rgba(96,80,30,0.18), inset 0 -1px 0 rgba(255,255,255,0.6)' }}
                />
              </div>
              <div className="relative">
                <textarea
                  value={quickDraft}
                  onChange={(e) => setQuickDraft(e.target.value)}
                  placeholder="Type a prompt to start a new chat…"
                  rows={5}
                  className="hide-scrollbar w-full resize-none rounded-md border px-2 py-2 text-xs outline-none"
                  style={{ borderColor: 'transparent', backgroundColor: 'rgba(255,255,255,0.32)', color: 'var(--ink)', minHeight: 176, lineHeight: 1.6, textAlign: 'justify', boxShadow: 'inset 0 1px 1px rgba(96,80,30,0.16), inset 0 -1px 0 rgba(255,255,255,0.6)' }}
                  onKeyDown={(e) => {
                    // Esc：清空草稿（持久化的草稿同步清空）
                    if (e.key === 'Escape') {
                      setQuickDraft('');
                      return;
                    }
                    // ⌘/Ctrl+Enter：发送
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      void sendQuickDraft();
                      return;
                    }
                    // 自动编号：仅处理纯回车（Shift 换行 / IME 组词回车 / 多选区时走默认行为）
                    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                    const el = e.currentTarget;
                    const caret = el.selectionStart ?? 0;
                    if ((el.selectionEnd ?? caret) !== caret) return;
                    const val = el.value;
                    const lineStart = val.lastIndexOf('\n', caret - 1) + 1;
                    const before = val.slice(lineStart, caret);
                    const lineEndIdx = val.indexOf('\n', caret);
                    const afterToLineEnd = val.slice(caret, lineEndIdx === -1 ? val.length : lineEndIdx);
                    // 1) 撤销自动编号：光标行只含自动续出的空编号（如 "2. "）再回车 → 删除编号并结束列表
                    const bare = before.match(/^(\d+)\.\s*$/);
                    if (bare && afterToLineEnd === '' && quickAutoNumRef.current?.lineStart === lineStart) {
                      e.preventDefault();
                      quickAutoNumRef.current = null;
                      const next = val.slice(0, lineStart) + val.slice(lineStart + bare[0].length);
                      const p = lineStart;
                      setQuickDraft(next);
                      requestAnimationFrame(() => {
                        el.focus();
                        el.setSelectionRange(p, p);
                      });
                      return;
                    }
                    // 2) 续号：光标行以 "N. " 开头（带正文，或首个空编号 "1."）→ 换行自动补 "N+1. "
                    const cont =
                      before.match(/^(\d+)\.\s+\S/) ||
                      (bare && !quickAutoNumRef.current ? bare : null);
                    if (!cont) return; // 普通行：默认换行
                    e.preventDefault();
                    const n = parseInt(cont[1], 10) + 1;
                    const suffix = `\n${n}. `;
                    const next = val.slice(0, caret) + suffix + val.slice(caret);
                    const p = caret + suffix.length;
                    quickAutoNumRef.current = { lineStart: caret + 1 };
                    setQuickDraft(next);
                    requestAnimationFrame(() => {
                      el.focus();
                      el.setSelectionRange(p, p);
                    });
                  }}
                />
              </div>
            </div>
            {/* 底部品牌区：logo + BobWork + 版本号连排（左侧），右侧 BobMail 入口 */}
            <div className="shrink-0 px-2 py-1.5">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  title="Settings"
                  className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-[var(--paper-hover)]"
                >
                  <img src="/hippo-icon.png" alt="BobWork" className="h-4 w-4 shrink-0 rounded object-contain" draggable={false} />
                  <span className="shrink-0 text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>BobWork</span>
                </button>
                {/* 版本号 = 更新状态入口：检查/发现新版本过渡/下载中/就绪呼吸灯，不再另设独立更新按钮 */}
                <button
                  type="button"
                  title={
                    updateStatus === 'checking' ? 'Checking for updates…'
                    : updateStatus === 'available' ? `v${updateVersion} available — click to download`
                    : updateStatus === 'downloading' ? `Downloading v${updateVersion} — ${Math.round(updateProgress)}%`
                    : updateStatus === 'downloaded' ? `v${updateVersion} downloaded — click to install`
                    : updateStatus === 'installing' ? 'Installing…'
                    : updateStatus === 'error' ? `${updateErrText || 'Update failed'} — click to retry`
                    : 'Check for updates'
                  }
                  onClick={() => {
                    if (!isDesktop() || updateStatus === 'checking' || updateStatus === 'downloading' || updateStatus === 'installing') return;
                    if (updateStatus === 'available') {
                      setUpdateStatus('downloading');
                      desktop.update.download().catch(() => {});
                    } else if (updateStatus === 'downloaded') {
                      setUpdateStatus('installing');
                      desktop.update.install().then((r) => {
                        if (r && !r.success) setUpdateStatus('error');
                      }).catch(() => setUpdateStatus('error'));
                    } else {
                      // idle / no-update / error → 手动检查
                      setUpdateStatus('checking');
                      desktop.update.check().then((r) => {
                        if (r && !r.success) {
                          setUpdateStatus('error');
                          setTimeout(() => setUpdateStatus((s) => (s === 'error' ? 'idle' : s)), 3000);
                        }
                      }).catch(() => {
                        setUpdateStatus('error');
                        setTimeout(() => setUpdateStatus((s) => (s === 'error' ? 'idle' : s)), 3000);
                      });
                    }
                  }}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-1 py-1 text-11 transition-colors hover:bg-[var(--paper-hover)]"
                  style={{
                    color:
                      updateStatus === 'available' || updateStatus === 'downloading' ? 'var(--primary)'
                      : updateStatus === 'downloaded' || updateStatus === 'installing' ? '#16a34a'
                      : updateStatus === 'error' ? 'var(--danger)'
                      : 'var(--ink-muted)',
                    cursor: isDesktop() ? 'pointer' : 'default',
                  }}
                >
                  <style>{`@keyframes cf-ver-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
                    @keyframes cf-ver-arrow { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }`}</style>
                  {updateStatus === 'checking' || updateStatus === 'installing' ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {updateStatus === 'installing' && updateVersion ? `v${updateVersion}` : `v${appVersion}`}
                    </>
                  ) : (updateStatus === 'available' || updateStatus === 'downloading') && updateVersion ? (
                    <>
                      {/* 从旧到新过渡：发现新版本即「旧亮新暗」起点（新号暗 0.35）；
                          下载中旧号随进度渐淡、新号逐渐变亮；下载中箭头闪烁提示升级进行中 */}
                      <span
                        style={{
                          opacity: updateStatus === 'available' ? 1 : Math.max(0.15, 1 - (updateProgress || 0) / 100),
                          transition: 'opacity 0.25s linear',
                        }}
                      >v{appVersion}</span>
                      <span
                        style={{
                          opacity: 0.55,
                          animation: updateStatus === 'downloading' ? 'cf-ver-arrow 0.9s ease-in-out infinite' : 'none',
                        }}
                      >→</span>
                      <span
                        style={{
                          opacity: updateStatus === 'available' ? 0.35 : Math.min(1, (updateProgress || 0) / 100 + 0.35),
                          transition: 'opacity 0.25s linear',
                        }}
                      >v{updateVersion}</span>
                    </>
                  ) : updateStatus === 'downloaded' && updateVersion ? (
                    <>
                      {/* 新版本就绪：版本号闪烁提示安装（点击安装） */}
                      <span style={{ animation: 'cf-ver-blink 1.2s ease-in-out infinite' }}>v{updateVersion}</span>
                    </>
                  ) : (
                    <>
                      v{appVersion}
                      {updateStatus === 'error' && ' · Update failed'}
                    </>
                  )}
                </button>
                <div className="flex-1" />
                {/* BobMail 入口：唤起通知中心（Sidebar 受控渲染弹层），带未读角标 */}
                <button
                  type="button"
                  title="BobMail"
                  aria-label="BobMail"
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    window.dispatchEvent(new CustomEvent('bobmail-toggle', { detail: { anchor: rect } }));
                  }}
                  className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-hover)] hover:text-[var(--ink-strong)]"
                >
                  <Mail className="h-4 w-4" />
                  {mailPending > 0 && (
                    <span
                      className="absolute -right-0.5 -top-0.5 flex min-w-[14px] items-center justify-center rounded-full px-1 text-9 font-semibold"
                      style={{ backgroundColor: 'var(--danger)', color: '#fff', lineHeight: '14px' }}
                    >
                      {mailPending > 99 ? '99+' : mailPending}
                    </span>
                  )}
                </button>
              </div>
            </div>
            </>
            )}
            {/* 折叠态：窄图标轨 —— 只保留“项目下方工具条”对应图标（Search/Project board/Calendar/Local files/Trash + 快速工具） */}
            {navCollapsed && (
              <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto hide-scrollbar px-1 py-1">
                <ToolBtn title="Search (⌘F)" onClick={() => setPaletteOpen(true)}><Search className="h-[13px] w-[13px]" /></ToolBtn>
                <ToolBtn title="Project board" onClick={() => setProjectBoardOpen(true)}><LayoutGrid className="h-[13px] w-[13px]" /></ToolBtn>
                <ToolBtn title="Local files" onClick={() => setLocalExplorerCollapsed((v) => !v)}><Monitor className="h-[13px] w-[13px]" /></ToolBtn>
                <ToolBtn title="Trash (deleted nodes)" onClick={() => window.dispatchEvent(new Event('trash-open'))}><Trash className="h-[13px] w-[13px]" /></ToolBtn>
                <ToolBtn title="Hippo Browser (⌘⇧B)" onClick={() => void desktop.hippoBrowser.open()}><Globe className="h-[13px] w-[13px]" /></ToolBtn>
                <div className="my-1 h-px w-5 shrink-0" style={{ backgroundColor: 'color-mix(in oklab, var(--line) 30%, transparent)' }} />
                {quickTools.map((t) => (
                  <ToolBtn key={`q-${t.key}`} title={t.label} onClick={t.onClick} disabled={t.disabled}>{quickToolIcon(t.key, 'h-[13px] w-[13px]')}</ToolBtn>
                ))}
              </div>
            )}
          </aside>
          </TooltipProvider>

          {/* 画布区域：承载当前聚焦会话（TraeWork 式单会话宿主，画布交互已移除） */}
          <div
            ref={attachWrapper}
            className="relative min-w-0 flex-1 overflow-hidden"
            onClick={onHostCanvasClick}
            data-host-canvas
          >
      {/* 宿主节点注入通道：中栏内所有自绘节点经 useNodeHost() 访问画布数据与宿主原语 */}
      <NodeHostContext.Provider value={nodeHostValue}>
      {/* 画布自绘渲染层（2026-09 宿主重构，替代 <ReactFlow>）：pane + 世界层(world) */}
      <div className="absolute inset-0" style={{ backgroundColor: 'var(--canvas-bg)' }} data-host-canvas-pane />
      {/* 聊天流式主区（2026-09 普通界面化）：原绝对定位 world 层改为纵向流式容器，
          聚焦会话占满中栏向下滚动；其余隐藏/后台保活节点以 display:none 挂载，不进入视觉流。
          不再有世界层平移与节点 position 绝对定位 → 无画布缩放/平移/连线。
          同一节点在"焦点槽/保活槽"间切换只用 display 控制可见性，key 恒为 node.id，
          避免切会话时 React 判定为不同组件而重挂载 → 保住流式生成中的 abortRef 不被触发。
          worldVisibleNodes 已含 焦点节点 + 执行中(executingNodeIds) + 后台任务(quickBg) 保活集。 */}
      <div className="absolute inset-0 overflow-y-auto hide-scrollbar">
        <div className="flex h-full min-h-0 flex-col">
          {worldVisibleNodes.map((node) => {
            const isFocused = focusedHostNode?.id === node.id;
            // 非焦点且非 hidden 的节点（豁免常驻等）不进入统一容器：它们既非保活也非可见
            if (!isFocused && !node.hidden) return null;
            return (
              <div
                key={node.id}
                data-host-node-id={node.id}
                {...(isFocused ? { 'data-host-node': true } : {})}
                className={isFocused ? `react-flow__node react-flow__node-${node.type} flex min-h-0 flex-col` : undefined}
                style={isFocused ? { width: '100%', height: '100%' } : { display: 'none' }}
              >
                {renderHostNode(node)}
              </div>
            );
          })}
        </div>
      </div>

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

        {/* ⌘F 统一面板：文件搜索 + WANTED 指令（原 GlobalSearch + TaskPanel）。
            2026-09-12：功能按钮（Extensions Store / Mini Programs / Agent Teams / Calendar / Bob Notes）
            从左侧边栏迁回本面板，渲染在输入框下方，仅图标 + 悬停显示名称 */}
        <UnifiedPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          actions={navActions}
          starredApps={starredApps}
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

        {/* Bob Sandbox 全屏管理页（小程序商城）：全屏覆盖层，Esc / 关闭按钮退出 */}
        {storeOpen && (
          <SandboxPanel onClose={() => setStoreOpen(false)} />
        )}

        {/* Agent Teams 全屏面板：侧边栏入口打开，Esc / 关闭按钮退出 */}
        {teamsFullscreenOpen && (
          <AgentTeamsPanel onClose={() => setTeamsFullscreenOpen(false)} />
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

      </NodeHostContext.Provider>
      </div>
      {/* ^^ 上面第一个 </div> 关闭 data-canvas-ui 覆盖层，第二个 </div> 关闭 wrapper（对话容器）。
          Sidebar 浮层与右 dock 自此成为 root flex 的并列子级 */}

      {/* 悬浮 Sidebar（Workspace 浮层）：整窗级，盖在左栏/对话之上 */}
      <div className="pointer-events-none absolute bottom-[10px] left-[10px] top-[10px] z-40">
        <div className="pointer-events-auto h-full">
          <Sidebar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCalendar={() => setCalendarOpen(true)}
            projectId={currentProjectId}
            onCollapsedChange={handleSidebarCollapsedChange}
            onCreateNodeWithFile={handleCreateNodeWithFile}
            activeNodeIdRef={lastActiveNodeIdRef}
          />
        </div>
      </div>

      {/* 右侧 dock：预览面板 + 本地文件面板（真并列列，与左栏/对话同级，互不重叠，保留固定间距）。
          wrapper（对话容器）在上面已闭合；此处 dock 为 root flex 行的最后一个子级，自动挤窄对话区 */}
      <div className="relative z-40 flex shrink-0 items-start gap-0.5 overflow-hidden">
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
      {/* 新建 Markdown 文档弹窗：命名 + 选择 homework 内的目标文件夹（portal 到 body，避免被画布 UI 层 stacking context 囚禁） */}
      {mdDialog && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[1600] flex items-start justify-center pt-20"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onClick={() => setMdDialog(null)}
        >
          <div
            className="w-96 rounded-xl p-4 shadow-2xl"
            style={{ backgroundColor: 'var(--paper)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-3 text-sm font-medium" style={{ color: 'var(--ink)' }}>
              New Markdown file
            </p>
            <label className="mb-1 block text-xs" style={{ color: 'var(--ink-muted)' }}>File name</label>
            <input
              type="text"
              autoFocus
              value={mdName}
              onChange={(e) => { setMdName(e.target.value); setMdError(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmCreateSidebarMd();
                if (e.key === 'Escape') setMdDialog(null);
              }}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none"
              style={{ borderColor: 'var(--input-border)', color: 'var(--ink)', backgroundColor: 'var(--paper)' }}
              onFocus={(e) => {
                // 选中文件名（不含扩展名）
                const dotIdx = mdName.lastIndexOf('.');
                if (dotIdx > 0) {
                  e.target.setSelectionRange(0, dotIdx);
                } else {
                  e.target.select();
                }
              }}
            />
            <label className="mb-1 mt-3 block text-xs" style={{ color: 'var(--ink-muted)' }}>Folder</label>
            <select
              value={mdDir}
              onChange={(e) => { setMdDir(e.target.value); setMdError(null); }}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none"
              style={{ borderColor: 'var(--input-border)', color: 'var(--ink)', backgroundColor: 'var(--paper)' }}
            >
              {mdDialog.dirs.map((d) => (
                <option key={d.rel || '__root__'} value={d.rel}>
                  {`${'\u00A0\u00A0'.repeat(d.depth)}${d.label}`}
                </option>
              ))}
            </select>
            {mdError && (
              <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{mdError}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" tone="neutral" size="sm" onClick={() => setMdDialog(null)}>
                Cancel
              </Button>
              <Button variant="solid" tone="brand" size="sm" onClick={() => void confirmCreateSidebarMd()}>
                Create
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* 删除确认弹窗 */}
      {confirmRender}
      {/* ImageAiEditor 生成完成/失败全局提示（需在预览面板之外，折叠时仍可见） */}
      <ImageAiEditToast />
      {/* Hippo Browser 胶囊态：收起后主窗口正中的呼吸灯圆角胶囊按钮 */}
      <HippoCapsule />
      {/* 首次运行向导：全新安装首次启动时引导选择保存地址 */}
      <SetupWizard />
    </NodeReaderContext.Provider>
  );
}

export function CanvasFlow() {
  // 单焦点宿主（2026-09 布局重构）：无需 ReactFlowProvider，画布数据由 CanvasFlowInner 内部 state 承载
  return <CanvasFlowInner />;
}
