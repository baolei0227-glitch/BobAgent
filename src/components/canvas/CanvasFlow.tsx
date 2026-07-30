'use client';

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  ConnectionMode,
  SelectionMode,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type HandleType,
  type OnConnectStart,
  type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AiChatNode, NodeReaderContext } from './AiChatNode';
import { FloatingEdge, FloatingEdgeDefs } from './FloatingEdge';
import { SettingsModal } from './SettingsModal';
import { SkillManagerModal } from './SkillManagerModal';
import { HtmlReader } from './HtmlReader';
import { TextEditPopup } from './TextEditPopup';
import { TextSelectionActions } from './TextSelectionActions';
import { FileViewer } from './FileViewer';
import { Sidebar } from './Sidebar';
import { CalendarPanel } from './CalendarPanel';
import { WelcomeScreen } from './WelcomeScreen';
import { TemplateEditor } from './TemplateEditor';
import type { AiChatNodeData, NodeRelation, ProviderConfig, ChatMessage } from '@/lib/types';
import { DEFAULT_MODEL_ID, DEFAULT_THINKING_LEVEL } from '@/lib/types';

const nodeTypes = { aiChat: AiChatNode };
const edgeTypes = { floating: FloatingEdge };

const defaultEdgeOptions = {
  type: 'floating' as const,
};

// 从 .md 文件恢复节点到画布
function restoredNodeToFlowNode(
  nodeData: {
    node_id: string;
    title: string;
    model?: string;
    mood?: unknown;
    summary?: string;
    conversations: Array<{ question: string; answer: string; questionTime: string; answerTime: string }>;
  },
  index: number,
): Node<AiChatNodeData> {
  // 将对话记录转换为 ChatMessage[]
  const messages: (ChatMessage & { summary?: string })[] = [];
  for (let i = 0; i < nodeData.conversations.length; i++) {
    const conv = nodeData.conversations[i];
    messages.push({
      id: `msg-${nodeData.node_id}-q${i}`,
      role: 'user',
      content: conv.question,
    });
    messages.push({
      id: `msg-${nodeData.node_id}-a${i}`,
      role: 'assistant',
      content: conv.answer,
      summary: i === nodeData.conversations.length - 1 && nodeData.summary ? nodeData.summary : undefined,
    });
  }

  // 网格排列：每行 3 个，间距 400px
  const col = index % 3;
  const row = Math.floor(index / 3);
  const position = {
    x: -300 + col * 400,
    y: -200 + row * 350,
  };

  return {
    id: nodeData.node_id,
    type: 'aiChat',
    position,
    data: {
      title: nodeData.title,
      messages,
      isStreaming: false,
      modelId: nodeData.model || DEFAULT_MODEL_ID,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      nodeMdId: nodeData.node_id,
    },
  };
}

/** 节点宽高常量（与 AiChatNode 一致） */
const NODE_WIDTH = 320;
const NODE_HEIGHT = 400;

/** 新建节点与源节点的间距 */
const NEW_NODE_OFFSET_X = 380;
const NEW_NODE_OFFSET_Y = 340;

/** 统一悬浮面板：所有文档以标签页形式组织在单一可拖拽面板中 */
function UnifiedReaderPanel({
  openReaderIds,
  fileTabs,
  readerTitles,
  activePanelTab,
  collapsed,
  wrapperRef,
  onSelectTab,
  onCloseNodeTab,
  onCloseFileTab,
  onToggleCollapse,
  currentProjectId,
}: {
  openReaderIds: string[];
  fileTabs: Array<{ id: string; projectId: string; fileName: string; filePath: string }>;
  readerTitles: Record<string, string>;
  activePanelTab: { type: 'node' | 'file'; id: string } | null;
  collapsed: boolean;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  onSelectTab: (type: 'node' | 'file', id: string) => void;
  onCloseNodeTab: (nodeMdId: string) => void;
  onCloseFileTab: (tabId: string) => void;
  onToggleCollapse: () => void;
  currentProjectId: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startMouseX: number; startMouseY: number; originLeft: number; originTop: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const PANEL_W = 580;

  // 计算默认位置：右侧贴边
  const getDefaultLeft = useCallback(() => {
    const w = wrapperRef.current?.clientWidth ?? window.innerWidth - 260;
    return Math.max(0, w - PANEL_W);
  }, [wrapperRef]);

  const defaultLeft = getDefaultLeft();
  const left = pos?.x ?? defaultLeft;
  const top = pos?.y ?? 0;

  // 合并所有 tabs
  const allTabs = useMemo(() => [
    ...openReaderIds.map(id => ({ id, type: 'node' as const, label: readerTitles[id] || '...' })),
    ...fileTabs.map(t => ({ id: t.id, type: 'file' as const, label: t.fileName })),
  ], [openReaderIds, fileTabs, readerTitles]);

  // 查找活跃文件 tab
  const activeFileTab = activePanelTab?.type === 'file'
    ? fileTabs.find(t => t.id === activePanelTab.id)
    : null;

  // 拖拽处理
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-drag-handle]')) return;
    e.preventDefault();
    e.stopPropagation();

    const currentLeft = pos?.x ?? getDefaultLeft();
    const currentTop = pos?.y ?? 0;

    dragRef.current = {
      startX: currentLeft,
      startY: currentTop,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      originLeft: currentLeft,
      originTop: currentTop,
    };
    setIsDragging(true);

    const handleMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startMouseX;
      const dy = ev.clientY - dragRef.current.startMouseY;
      setPos({
        x: Math.max(-PANEL_W + 40, dragRef.current.startX + dx),
        y: Math.max(0, dragRef.current.startY + dy),
      });
    };

    const handleUp = () => {
      dragRef.current = null;
      setIsDragging(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [pos, getDefaultLeft]);

  // 折叠态：显示小按钮（右上角）
  if (collapsed && allTabs.length > 0) {
    // 计算右上角位置
    const rightPos = wrapperRef.current ? wrapperRef.current.clientWidth - left - PANEL_W : 0;
    return (
      <div className="absolute z-50" style={{ right: Math.max(8, rightPos), top }}>
        <button
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 shadow-lg transition-all hover:shadow-xl"
          style={{ backgroundColor: '#faf8f3', border: '1px solid rgba(0, 0, 0, 0.1)' }}
          title="展开面板"
        >
          <ChevronsLeft className="h-4 w-4" style={{ color: '#537D96' }} />
          <span className="text-[12px] font-medium" style={{ color: '#2c2416' }}>
            {allTabs.length} 个标签
          </span>
        </button>
      </div>
    );
  }

  if (allTabs.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className="absolute flex flex-col overflow-hidden rounded-xl"
      data-canvas-ui="overlay"
      style={{
        left,
        top,
        width: PANEL_W,
        height: '100%',
        zIndex: 50,
        backgroundColor: '#faf8f3',
        boxShadow: '0 16px 48px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06)',
        cursor: isDragging ? 'grabbing' : 'default',
        transition: isDragging ? 'none' : 'box-shadow 0.2s',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
      onPointerDown={handlePointerDown}
    >
      {/* 标签栏 */}
      <div
        className="flex shrink-0 items-center overflow-x-auto"
        style={{ borderBottom: '1px solid rgba(0, 0, 0, 0.07)', backgroundColor: '#f5f2eb' }}
        data-drag-handle=""
      >
        {/* 折叠按钮 */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          className="shrink-0 px-2 py-2 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
          style={{ color: '#7a7260' }}
          title="折叠面板"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>

        {/* 标签列表 */}
        <div className="flex flex-1 items-center overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {allTabs.map((tab) => {
            const isActive = activePanelTab?.id === tab.id && activePanelTab?.type === tab.type;
            return (
              <div
                key={tab.id}
                className="group flex shrink-0 items-center"
                style={{
                  borderBottom: isActive ? '2px solid oklch(0.62 0.17 45)' : '2px solid transparent',
                }}
              >
                <button
                  onClick={() => onSelectTab(tab.type, tab.id)}
                  className="max-w-[120px] truncate px-3 py-2 text-[12px] font-medium transition-colors"
                  style={{
                    color: isActive ? 'oklch(0.30 0.02 30)' : 'oklch(0.50 0.02 50)',
                    fontFamily: "'Noto Serif SC', serif",
                  }}
                  title={tab.label}
                >
                  {tab.label}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    tab.type === 'node' ? onCloseNodeTab(tab.id) : onCloseFileTab(tab.id);
                  }}
                  className="mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: '#8a8270' }}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        {activePanelTab?.type === 'node' && (
          <HtmlReader
            key={activePanelTab.id}
            nodeMdId={activePanelTab.id}
            onClose={(id) => onCloseNodeTab(id)}
            onClickToFront={() => {}}
            mode="floating"
          />
        )}
        {activePanelTab?.type === 'file' && activeFileTab && (
          activeFileTab.fileName.endsWith('.md') ? (
            <HtmlReader
              key={activeFileTab.id}
              filePath={activeFileTab.filePath}
              projectId={activeFileTab.projectId}
              fileName={activeFileTab.fileName}
              onClose={(id) => onCloseFileTab(id.startsWith('file:') ? id : `file:${id}`)}
              onClickToFront={() => {}}
              mode="floating"
            />
          ) : (
            <FileViewer
              key={activeFileTab.id}
              projectId={activeFileTab.projectId}
              fileName={activeFileTab.fileName}
              filePath={activeFileTab.filePath}
              onClose={() => onCloseFileTab(activeFileTab.id)}
              mode="tabbed"
            />
          )
        )}
      </div>
    </div>
  );
}

function CanvasFlowInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AiChatNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { screenToFlowPosition, getNodes, getIntersectingNodes, getViewport } = useReactFlow();
  const nodeIdCounter = useRef(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastActiveNodeIdRef = useRef<string | null>(null); // 当前活跃节点，用于全局文字选择
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [templateInitialSteps, setTemplateInitialSteps] = useState<any[] | undefined>(undefined);
  const [templateInitialName, setTemplateInitialName] = useState<string | undefined>(undefined);
  // 统一悬浮面板
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [fileTabs, setFileTabs] = useState<Array<{ id: string; projectId: string; fileName: string; filePath: string }>>([]);
  const [, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [openReaderIds, setOpenReaderIds] = useState<string[]>([]);
  const [activeReaderId, setActiveReaderId] = useState<string | null>(null);
  const [activePanelTab, setActivePanelTab] = useState<{ type: 'node' | 'file'; id: string } | null>(null);
  const [readerTitles, setReaderTitles] = useState<Record<string, string>>({});
  const [hasProject, setHasProject] = useState<boolean | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string>('');
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectionBoxPosition, setSelectionBoxPosition] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // 系统级文字选择（来自 HtmlReader 或其他组件的事件）
  const [textSelection, setTextSelection] = useState<{
    selectedText: string;
    nodeMdId: string;
    selectionPos: { x: number; y: number };
    popupPos: { x: number; y: number };
  } | null>(null);
  const [editPopupOpen, setEditPopupOpen] = useState(false);
  const [editPopupText, setEditPopupText] = useState('');
  const [editPopupPos, setEditPopupPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [editPopupNodeId, setEditPopupNodeId] = useState('');

  // 跟踪从哪个节点的哪个方向开始拖拽连线
  const connectingRef = useRef<{
    nodeId: string | null;
    handleType: HandleType | null;
    handleId: string | null;
  } | null>(null);

  // 框选状态
  const dragSelectRef = useRef<{ startX: number; startY: number; isSelecting: boolean; hadDrag: boolean; isTouchSelect?: boolean }>({
    startX: 0,
    startY: 0,
    isSelecting: false,
    hadDrag: false,
    isTouchSelect: false,
  });

  // 折叠面板
  const handleTogglePanel = useCallback(() => {
    setPanelCollapsed(prev => !prev);
  }, []);

  const openReader = useCallback((nodeMdId: string) => {
    setOpenReaderIds((prev) => {
      if (prev.includes(nodeMdId)) return prev;
      return [...prev, nodeMdId];
    });
    setActiveReaderId(nodeMdId);
    setActivePanelTab({ type: 'node', id: nodeMdId });
    lastActiveNodeIdRef.current = nodeMdId;
    setPanelCollapsed(false); // 确保面板展开
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
          // 切换到文件标签（如果有）
          if (fileTabs.length > 0) {
            setActivePanelTab({ type: 'file', id: fileTabs[fileTabs.length - 1].id });
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
  }, [activeReaderId, fileTabs]);
  const bringReaderToFront = useCallback((nodeMdId: string) => {
    setActiveReaderId(nodeMdId);
    setActivePanelTab({ type: 'node', id: nodeMdId });
    lastActiveNodeIdRef.current = nodeMdId;
    setPanelCollapsed(false);
  }, []);

  // 文件标签页管理
  const openFileTab = useCallback((projId: string, fileName: string, filePath: string) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      if (prev.some(t => t.id === tabId)) return prev;
      return [...prev, { id: tabId, projectId: projId, fileName, filePath }];
    });
    setActivePanelTab({ type: 'file', id: tabId });
  }, []);

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

  // 启动时恢复节点和连线（先加载节点，再加载连线，避免边引用不存在的节点）
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      const resp = await fetch('/api/nodes?action=list');
      const data = await resp.json();

      if (cancelled) return;

      if (data.success && data.nodes && data.nodes.length > 0) {
        const restoredNodes = data.nodes.map((n: Record<string, unknown>, i: number) =>
          restoredNodeToFlowNode(n as Parameters<typeof restoredNodeToFlowNode>[0], i),
        );
        setNodes(restoredNodes);

        // 节点就绪后再加载连线
        try {
          const edgeResp = await fetch('/api/edges?include_disconnected=true');
          const edgeData = await edgeResp.json();
          if (cancelled) return;
          if (edgeData.success && edgeData.edges && edgeData.edges.length > 0) {
            const restoredEdges: Edge[] = edgeData.edges.map((e: { edge_id: string; from: string; to: string; edge_type: string; disconnected: boolean }) => ({
              id: e.edge_id,
              source: e.from,
              target: e.to,
              type: 'floating',
              data: {
                relation: e.edge_type === 'vertical' ? 'child' : 'sibling',
                disconnected: e.disconnected,
              },
            }));
            setEdges(restoredEdges);
          }
        } catch {
          // 恢复连线失败忽略
        }
      } else {
        // 没有节点时，自动创建一个初始节点
        try {
          const createResp = await fetch('/api/nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'create',
              title: 'AI Chat',
              model: DEFAULT_MODEL_ID,
              sources: [],
            }),
          });
          const createData = await createResp.json();
          if (!cancelled && createData.success) {
            const newNode: Node<AiChatNodeData> = {
              id: createData.node_id,
              type: 'aiChat',
              position: { x: -160, y: -200 },
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
    }

    restore();

    return () => { cancelled = true; };
  }, [setNodes, setEdges]);

  // 开始拖拽连线：记录源节点和 Handle 信息
  const onConnectStart: OnConnectStart = useCallback((_, params) => {
    connectingRef.current = {
      nodeId: params.nodeId,
      handleType: params.handleType,
      handleId: params.handleId,
    };
  }, []);

  // 拖拽结束：如果从 source handle 拖到空白处，则在释放位置创建新节点并连线
  const onConnectEnd: OnConnectEnd = useCallback(
    (event) => {
      const startData = connectingRef.current;
      connectingRef.current = null;
      if (!startData) return;

      const sourceNodeId = startData.nodeId;
      const sourceHandleId = startData.handleId || 'right';
      const sourceHandleType = startData.handleType;

      if (!sourceNodeId) return;

      // 只有 source handle 拖拽到空白处才创建新节点
      // target handle 的拖拽由 onConnect 处理
      if (sourceHandleType === 'target') {
        return;
      }

      // 将屏幕坐标转为画布坐标
      const clientX = 'changedTouches' in event
        ? event.changedTouches[0]?.clientX ?? 0
        : event.clientX;
      const clientY = 'changedTouches' in event
        ? event.changedTouches[0]?.clientY ?? 0
        : event.clientY;
      const targetPosition = screenToFlowPosition({ x: clientX, y: clientY });

      // 检查释放位置是否在某个节点上（如果是，则由 onConnect 处理，这里不创建新节点）
      const targetNodes = getIntersectingNodes({
        x: targetPosition.x - 20,
        y: targetPosition.y - 20,
        width: 40,
        height: 40,
      });

      if (targetNodes && targetNodes.length > 0) {
        return;
      }

      // 空白处释放 → 创建新节点
      const sourceNode = getNodes().find((n) => n.id === sourceNodeId);
      if (!sourceNode) return;

      // 根据拖拽方向计算新节点位置
      const handleId = sourceHandleId.replace('-source', '');
      let newX = targetPosition.x - NODE_WIDTH / 2;
      let newY = targetPosition.y - NODE_HEIGHT / 2;

      // 如果拖拽距离太小，使用默认偏移
      const sourceCenterX = sourceNode.position.x + ((sourceNode.measured?.width as number) ?? NODE_WIDTH) / 2;
      const sourceCenterY = sourceNode.position.y + ((sourceNode.measured?.height as number) ?? NODE_HEIGHT) / 2;
      const dx = targetPosition.x - sourceCenterX;
      const dy = targetPosition.y - sourceCenterY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 100) {
        // 距离太近，按 handle 方向使用默认偏移
        switch (handleId) {
          case 'right':
            newX = sourceNode.position.x + NEW_NODE_OFFSET_X;
            newY = sourceNode.position.y;
            break;
          case 'left':
            newX = sourceNode.position.x - NEW_NODE_OFFSET_X;
            newY = sourceNode.position.y;
            break;
          case 'bottom':
            newX = sourceNode.position.x + 40;
            newY = sourceNode.position.y + NEW_NODE_OFFSET_Y;
            break;
          case 'top':
            newX = sourceNode.position.x;
            newY = sourceNode.position.y - NEW_NODE_OFFSET_Y;
            break;
          default:
            newX = sourceNode.position.x + NEW_NODE_OFFSET_X;
            newY = sourceNode.position.y;
        }
      }

      // 确定关系类型（垂直=子节点，水平=同级）
      const isVertical = handleId === 'top' || handleId === 'bottom';
      const edgeType = isVertical ? 'vertical' : 'parallel';
      const relation = isVertical ? 'child' : 'sibling';

      // 创建节点文件
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: 'AI Chat',
          model: DEFAULT_MODEL_ID,
          sources: [],
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data.success) return;
          const newNodeId = data.node_id;

          // 添加节点
          const newNode: Node<AiChatNodeData> = {
            id: newNodeId,
            type: 'aiChat',
            position: { x: newX, y: newY },
            data: {
              title: 'AI Chat',
              messages: [],
              isStreaming: false,
              modelId: DEFAULT_MODEL_ID,
              thinkingLevel: DEFAULT_THINKING_LEVEL,
              nodeMdId: newNodeId,
            },
          };
          setNodes((nds) => [...nds, newNode]);

          // 创建连线
          fetch('/api/edges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'create',
              from: sourceNodeId,
              to: newNodeId,
              edge_type: edgeType,
            }),
          })
            .then((r) => r.json())
            .then((edgeData) => {
              if (edgeData.success && edgeData.edge) {
                setEdges((eds) => addEdge({
                  id: edgeData.edge.edge_id,
                  source: edgeData.edge.from,
                  target: edgeData.edge.to,
                  type: 'floating',
                  data: {
                    relation,
                    disconnected: edgeData.edge.disconnected ?? false,
                  },
                }, eds));
              }
            })
            .catch((err) => console.error('连线创建出错:', err));
        })
        .catch((err) => console.error('节点创建出错:', err));
    },
    [screenToFlowPosition, getIntersectingNodes, getNodes, setNodes, setEdges],
  );

  // 连线创建时持久化到数据库
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;

    // 根据 sourceHandle 和 targetHandle 判断连线类型
    const sourceHandle = connection.sourceHandle || '';
    const targetHandle = connection.targetHandle || '';
    const isVertical = sourceHandle.includes('top') || sourceHandle.includes('bottom') ||
                       targetHandle.includes('top') || targetHandle.includes('bottom');
    const edgeType = isVertical ? 'vertical' : 'parallel';
    const relation = isVertical ? 'child' : 'sibling';

    fetch('/api/edges', {
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
  }, [setEdges]);

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

  // 拖拽停止后检查同级节点是否移到了源节点下方，若是则转为子节点关系
  const onNodeDragStop = useCallback(() => {
    const allNodes = getNodes();
    setEdges((eds) =>
      eds.map((edge) => {
        if (edge.data?.relation !== 'sibling') return edge;

        const sourceNode = allNodes.find((n) => n.id === edge.source);
        const targetNode = allNodes.find((n) => n.id === edge.target);
        if (!sourceNode || !targetNode) return edge;

        const sw = sourceNode.measured?.width ?? 320;
        const sh = sourceNode.measured?.height ?? 200;
        const tw = targetNode.measured?.width ?? 320;
        const th = targetNode.measured?.height ?? 200;

        const sc = { x: sourceNode.position.x + sw / 2, y: sourceNode.position.y + sh / 2 };
        const tc = { x: targetNode.position.x + tw / 2, y: targetNode.position.y + th / 2 };

        const dx = Math.abs(tc.x - sc.x);
        const dy = tc.y - sc.y;

        // 目标节点在源节点下方且垂直距离大于水平距离 → 转为子节点
        if (dy > 0 && dy > dx) {
          return { ...edge, data: { ...edge.data, relation: 'child' as NodeRelation } };
        }

        return edge;
      }),
    );
  }, [getNodes, setEdges]);


  // 双击空白处创建新节点
  const handlePaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // 检查是否双击在节点上，如果是则忽略
      const target = event.target as HTMLElement;
      if (target.closest('.react-flow__node')) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // 立即创建节点文件，获取稳定 ID
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: 'AI Chat',
          model: DEFAULT_MODEL_ID,
          sources: [],
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            const nodeId = data.node_id;
            const newNode: Node<AiChatNodeData> = {
              id: nodeId,
              type: 'aiChat',
              position,
              data: {
                title: 'AI Chat',
                messages: [],
                isStreaming: false,
                modelId: DEFAULT_MODEL_ID,
                thinkingLevel: DEFAULT_THINKING_LEVEL,
                nodeMdId: nodeId,
              },
            };
            setNodes((nds) => [...nds, newNode]);
          }
        })
        .catch(() => {
          // 创建失败时使用临时 ID（降级），同时生成 UUID 作为 nodeMdId
          const id = `node-${Date.now()}-${nodeIdCounter.current++}`;
          const newNode: Node<AiChatNodeData> = {
            id,
            type: 'aiChat',
            position,
            data: {
              title: 'AI Chat',
              messages: [],
              isStreaming: false,
              modelId: DEFAULT_MODEL_ID,
              thinkingLevel: DEFAULT_THINKING_LEVEL,
              nodeMdId: id, // 降级节点也需要 nodeMdId
            },
          };
          setNodes((nds) => [...nds, newNode]);
        });
    },
    [screenToFlowPosition, setNodes],
  );

  // 判断是否命中画布空白区域（节点、UI浮层、Handle、自定义组件之上都不算空白）
  // 只有空白处才允许触发画布拖拽/平移/框选，避免操作其他功能时"顺手"把画布动了
  const isHittingCanvasBlank = useCallback((event: React.MouseEvent | React.PointerEvent | MouseEvent): boolean => {
    const target = event.target as HTMLElement;
    if (!target) return false;

    // 1. 命中节点内部（任何节点类型） → 不是空白
    if (target.closest('.react-flow__node')) return false;
    // 2. 命中 Handle（连线端点） → 不是空白
    if (target.closest('.react-flow__handle')) return false;
    // 3. 命中连线（edge）本身 → 不是空白
    if (target.closest('.react-flow__edge')) return false;
    // 4. 命中 Controls 控制条（+/-/fit 按钮）→ 不是空白
    if (target.closest('.react-flow__controls')) return false;
    // 5. 命中迷你图、标注等内置控件 → 不是空白
    if (target.closest('.react-flow__minimap, .react-flow__attribution')) return false;
    // 6. 命中用户自定义浮层（所有统一管理的 panel / dialog / popup）→ 不是空白
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

  // 框选开始（仅左键 + 命中空白区域 + 排除连线拖拽）
  const onPaneClickStart = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return; // 仅左键

      const target = event.target as HTMLElement;

      // 核心：命中了任何"非空白"元素 → 阻止 React Flow 启动 pan（也不框选）
      // 这样在节点、浮层上拖动就不会误伤画布平移/缩放
      if (!isHittingCanvasBlank(event)) {
        // 在节点/浮层上的事件由节点自身/浮层自己处理；这里不再调用 stopPropagation，
        // 而是让 React Flow 内部的 mouseDown 监听（document 级）因判断 target 不在 pane 上也自动不 pan。
        // 额外防御：如果是自定义 overlay，再明确一次 stopPropagation（overlay 的 onMouseDown 应该自己也会调）。
        if (target.closest('[data-canvas-ui="overlay"]')) {
          event.stopPropagation();
        }
        return;
      }

      // 排除 Handle 元素（连线拖拽），避免连线时触发框选
      if (target.closest('.react-flow__handle')) return;

      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      dragSelectRef.current = {
        startX: event.clientX - rect.left,
        startY: event.clientY - rect.top,
        isSelecting: true,
        hadDrag: false,
        isTouchSelect: false,
      };
    },
    [isHittingCanvasBlank],
  );

  // 框选拖拽（鼠标）
  const onPaneMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!dragSelectRef.current.isSelecting || dragSelectRef.current.isTouchSelect) return;

      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const currentX = event.clientX - rect.left;
      const currentY = event.clientY - rect.top;

      const dx = currentX - dragSelectRef.current.startX;
      const dy = currentY - dragSelectRef.current.startY;

      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

      dragSelectRef.current.hadDrag = true;

      // 选择框屏幕坐标（相对于 wrapper）
      const left = Math.min(dragSelectRef.current.startX, currentX);
      const top = Math.min(dragSelectRef.current.startY, currentY);

      // 选择框画布坐标（用于碰撞检测）
      const viewport = getViewport();
      const flowStart = screenToFlowPosition({
        x: dragSelectRef.current.startX + rect.left,
        y: dragSelectRef.current.startY + rect.top,
      });
      const flowEnd = screenToFlowPosition({
        x: currentX + rect.left,
        y: currentY + rect.top,
      });

      const flowX = Math.min(flowStart.x, flowEnd.x);
      const flowY = Math.min(flowStart.y, flowEnd.y);
      const flowW = Math.abs(flowEnd.x - flowStart.x);
      const flowH = Math.abs(flowEnd.y - flowStart.y);

      setSelectionBoxPosition({ x: left, y: top, width: Math.abs(dx), height: Math.abs(dy) });

      const intersectingNodes = getIntersectingNodes({
        x: flowX,
        y: flowY,
        width: flowW,
        height: flowH,
      });

      setSelectedNodeIds(new Set(intersectingNodes.map((n) => n.id)));
    },
    [screenToFlowPosition, getIntersectingNodes, getViewport],
  );

  // 框选结束
  const onPaneClickEnd = useCallback(() => {
    if (dragSelectRef.current.isSelecting && !dragSelectRef.current.isTouchSelect) {
      dragSelectRef.current.isSelecting = false;
      setSelectionBoxPosition(null);
    }
  }, []);

  // 点击空白处取消选中（排除框选拖拽后的 click 事件）
  const onPaneClick = useCallback(() => {
    if (dragSelectRef.current.hadDrag) {
      dragSelectRef.current.hadDrag = false;
      return;
    }
    setSelectedNodeIds(new Set());
    setSelectionBoxPosition(null);
  }, []);

  // 基于选中节点创建新节点
  const createNodeFromSelection = useCallback(async () => {
    if (selectedNodeIds.size === 0) return;

    const viewport = getViewport();
    const selectedNodes = getNodes().filter((n) => selectedNodeIds.has(n.id));

    if (selectedNodes.length === 0) {
      setSelectedNodeIds(new Set());
      return;
    }

    // 计算选中节点的包围盒，新节点放置在右侧，垂直居中
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of selectedNodes) {
      const w = n.measured?.width ?? NODE_WIDTH;
      const h = n.measured?.height ?? NODE_HEIGHT;
      minX = Math.min(minX, n.position.x);
      maxX = Math.max(maxX, n.position.x + w);
      minY = Math.min(minY, n.position.y);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const boundingCenterY = (minY + maxY) / 2;
    const GAP = 120;

    const newPosition = {
      x: maxX + GAP,
      y: boundingCenterY - NODE_HEIGHT / 2,
    };

    const resp = await fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        title: 'AI Chat',
        model: DEFAULT_MODEL_ID,
        sources: Array.from(selectedNodeIds),
      }),
    });

    const data = await resp.json();
    if (data.success) {
      const newNode: Node<AiChatNodeData> = {
        id: data.node_id,
        type: 'aiChat',
        position: newPosition,
        data: {
          title: 'AI Chat',
          messages: [],
          isStreaming: false,
          modelId: DEFAULT_MODEL_ID,
          thinkingLevel: DEFAULT_THINKING_LEVEL,
          nodeMdId: data.node_id,
        },
      };
      setNodes((nds) => [...nds, newNode]);

      // 自动创建连线
      for (const sourceId of selectedNodeIds) {
        const edgeResp = await fetch('/api/edges', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            from: sourceId,
            to: data.node_id,
            edge_type: 'parallel',
          }),
        });
        const edgeData = await edgeResp.json();
        if (edgeData.success && edgeData.edge) {
          setEdges((eds) =>
            addEdge(
              {
                id: edgeData.edge.edge_id,
                source: edgeData.edge.from,
                target: edgeData.edge.to,
                type: 'floating',
                data: {
                  relation: 'sibling',
                  disconnected: edgeData.edge.disconnected ?? false,
                },
              },
              eds,
            ),
          );
        }
      }
    }

    setSelectedNodeIds(new Set());
  }, [selectedNodeIds, getNodes, getViewport, setNodes, setEdges]);

  // 从选中节点创建模板
  const saveAsTemplate = useCallback(async () => {
    if (selectedNodeIds.size < 2) return;

    const selectedNodes = getNodes().filter((n) => selectedNodeIds.has(n.id));
    if (selectedNodes.length < 2) return;

    // 提取节点数据，按拓扑顺序（y 坐标排序作为简化）
    const sorted = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);

    const steps = sorted.map((node, i) => {
      const data = node.data as AiChatNodeData;
      return {
        order: i,
        title: data.title || `步骤 ${i + 1}`,
        modelId: data.modelId,
        thinkingLevel: data.thinkingLevel,
        skills: [],
        prompt: '',
      };
    });

    setTemplateInitialSteps(steps);
    setTemplateInitialName('');
    setTemplateEditorOpen(true);
  }, [selectedNodeIds, getNodes]);

  // 跟踪 viewport 变换，用于计算选中节点边界框的屏幕位置
  const [viewport, setViewportState] = useState({ x: 0, y: 0, zoom: 1 });

  // 计算选中节点（≥2）的边界框
  const selectionOutline = useMemo(() => {
    if (selectedNodeIds.size < 2) return null;
    const selectedNodes = getNodes().filter((n) => selectedNodeIds.has(n.id));
    if (selectedNodes.length < 2) return null;

    const NODE_WIDTH = 360;
    const NODE_HEIGHT = 160;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of selectedNodes) {
      const w = n.measured?.width ?? NODE_WIDTH;
      const h = n.measured?.height ?? NODE_HEIGHT;
      const x = n.position.x;
      const y = n.position.y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }

    // 从 flow 坐标转换到屏幕坐标
    const pad = 12;
    return {
      left: minX * viewport.zoom + viewport.x - pad,
      top: minY * viewport.zoom + viewport.y - pad,
      width: (maxX - minX) * viewport.zoom + pad * 2,
      height: (maxY - minY) * viewport.zoom + pad * 2,
    };
  }, [selectedNodeIds, getNodes, viewport]);

  // 监听系统级文字选择事件
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        selectedText: string;
        nodeMdId: string;
        selectionPos: { x: number; y: number } | null;
        popupPos: { x: number; y: number } | null;
      };
      if (!detail || !detail.selectedText || !detail.nodeMdId) {
        setTextSelection(null);
        return;
      }
      setTextSelection({
        selectedText: detail.selectedText,
        nodeMdId: detail.nodeMdId,
        selectionPos: detail.selectionPos!,
        popupPos: detail.popupPos!,
      });
    };
    window.addEventListener('text-selection-changed', handler);
    return () => window.removeEventListener('text-selection-changed', handler);
  }, []);

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
    const onWheelCapture = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;

      const isOverlayOrNode =
        target.closest('.react-flow__node') ||
        target.closest('[data-canvas-ui="overlay"]') ||
        target.closest('.react-flow__controls');

      if (isOverlayOrNode) {
        // 捕获阶段 stopPropagation，RF 的滚轮 pan/zoom 监听完全拿不到事件
        e.stopPropagation();
        // 注意：不 preventDefault，让节点内部的滚动（聊天记录、下拉菜单等）正常工作
      }
    };

    wrapper.addEventListener('mousedown', onMouseDownCapture, true); // capture: true
    wrapper.addEventListener('wheel', onWheelCapture, true);
    return () => {
      wrapper.removeEventListener('mousedown', onMouseDownCapture, true);
      wrapper.removeEventListener('wheel', onWheelCapture, true);
    };
  }, []);

  // 全局 mouseup：在非 reader 区域选中文字时，发送到当前活跃节点
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

        // 跳过 reader 内容区（由 HtmlReader 自己的 handler 处理）
        if (sel.anchorNode) {
          const anchorEl = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode as Element;
          if (anchorEl?.closest?.('[data-reader-content]')) return;
        }

        // 跳过输入框
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.getAttribute('contenteditable') === 'true')) return;

        const targetNodeId = lastActiveNodeIdRef.current;
        if (!targetNodeId) return; // 没有活跃节点则忽略

        const text = sel.toString().trim();
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        window.dispatchEvent(new CustomEvent('text-selection-changed', {
          detail: {
            selectedText: text,
            nodeMdId: targetNodeId,
            selectionPos: { x: rect.right + 8, y: rect.top - 4 },
            popupPos: { x: rect.left - 540, y: rect.top - 12 },
          },
        }));
      }, 10);
    };

    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  // 系统级：发送选中文字到指定节点
  const handleSendToNode = useCallback((targetNodeId: string) => {
    if (!textSelection) return;
    window.dispatchEvent(new CustomEvent('insert-node-reference', {
      detail: { node_id: targetNodeId, selected_text: textSelection.selectedText },
    }));
  }, [textSelection]);

  // 系统级 handleInsertReference
  const handleSystemInsertReference = useCallback(() => {
    if (!textSelection) return;
    setEditPopupText(textSelection.selectedText);
    setEditPopupNodeId(textSelection.nodeMdId);
    setEditPopupPos(textSelection.popupPos);
    setEditPopupOpen(true);
    // 打开编辑弹窗后保留选中高亮，关闭弹窗时清除
  }, [textSelection]);

  return (
    <NodeReaderContext.Provider value={openReader}>
      {hasProject === null ? (
        <div className="flex h-screen w-screen items-center justify-center" style={{ backgroundColor: 'oklch(0.96 0.01 80)' }}>
          <div className="text-sm" style={{ color: 'oklch(0.55 0.02 55)', fontFamily: "'Noto Serif SC', serif" }}>
            Loading...
          </div>
        </div>
      ) : hasProject ? (
        <div className="flex h-screen w-screen">
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} onOpenSkills={() => setSkillsOpen(true)} onOpenCalendar={() => setCalendarOpen(true)} onOpenFile={(projId, name, path) => openFileTab(projId, name, path)} projectId={currentProjectId} />
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* 顶部拖拽区域 */}
            <div
              className="h-8 shrink-0 flex items-center justify-center select-none"
              style={{
                WebkitAppRegion: 'drag',
                WebkitUserSelect: 'none',
                cursor: 'grab',
              } as React.CSSProperties}
            >
              <div className="flex items-center gap-1 opacity-20 pointer-events-none">
                <span className="w-8 h-0.5 rounded-full" style={{ backgroundColor: 'oklch(0.50 0.02 50)' }} />
                <span className="w-5 h-0.5 rounded-full" style={{ backgroundColor: 'oklch(0.50 0.02 50)' }} />
                <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: 'oklch(0.50 0.02 50)' }} />
              </div>
            </div>
            <div ref={wrapperRef} className="paper-canvas flex-1 relative overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onEdgesDelete={onEdgesDelete}
        onNodeDragStop={onNodeDragStop}
        onDoubleClick={handlePaneDoubleClick}
        onMouseDown={onPaneClickStart}
        onMouseMove={onPaneMouseMove}
        onMouseUp={onPaneClickEnd}
        onMouseLeave={onPaneClickEnd}
        onClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionMode={ConnectionMode.Loose}
        selectionMode={SelectionMode.Partial}
        selectionOnDrag={false}
        panOnDrag={[1]}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        minZoom={0.1}
        maxZoom={3}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        fitView
        fitViewOptions={{ padding: 0.4, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        onNodeClick={(_event, node) => {
          lastActiveNodeIdRef.current = node.id;
        }}
        onMoveEnd={(_event, vp) => setViewportState(vp)}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.5}
          color="oklch(0.82 0.015 70)"
        />
        <Controls showInteractive={false} className="!border-0 !shadow-lg" />
        <FloatingEdgeDefs />
      </ReactFlow>

      {/* 框选矩形 */}
      {selectionBoxPosition && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: selectionBoxPosition.x,
            top: selectionBoxPosition.y,
            width: selectionBoxPosition.width,
            height: selectionBoxPosition.height,
            border: '2px dashed oklch(0.62 0.17 45)',
            backgroundColor: 'oklch(0.62 0.17 45 / 0.1)',
            zIndex: 100,
          }}
        />
      )}

      {/* 多节点选中虚线框 */}
      {selectionOutline && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: selectionOutline.left,
            top: selectionOutline.top,
            width: selectionOutline.width,
            height: selectionOutline.height,
            border: '2px dashed oklch(0.55 0.15 45)',
            borderRadius: '8px',
            backgroundColor: 'oklch(0.62 0.17 45 / 0.04)',
            zIndex: 50,
          }}
        />
      )}

      {/* 选中 2 个及以上节点后显示创建按钮 — 放在虚线框右侧垂直居中 */}
      {selectedNodeIds.size >= 2 && (
        <div
          className="absolute flex flex-col gap-2"
          data-canvas-ui="overlay"
          style={{
            left: selectionOutline
              ? selectionOutline.left + selectionOutline.width + 20
              : '12px',
            top: selectionOutline
              ? selectionOutline.top + selectionOutline.height / 2
              : '12px',
            transform: 'translateY(-50%)',
            zIndex: 200,
          }}
        >
          <button
            onClick={createNodeFromSelection}
            className="rounded-lg px-4 py-2 text-sm shadow-lg transition-colors hover:opacity-90"
            style={{
              backgroundColor: 'oklch(0.62 0.17 45)',
              color: 'white',
              fontFamily: "'Noto Serif SC', serif",
            }}
          >
            + Create Node
          </button>
          <button
            onClick={saveAsTemplate}
            className="rounded-lg px-4 py-2 text-sm shadow-lg transition-colors hover:opacity-90"
            style={{
              backgroundColor: 'oklch(0.99 0.003 80)',
              color: 'oklch(0.35 0.015 50)',
              border: '1px solid oklch(0.62 0.17 45 / 0.3)',
              fontFamily: "'Noto Serif SC', serif",
            }}
          >
            Save as Template
          </button>
        </div>
        )}


      <div data-canvas-ui="overlay">
        <SettingsModal
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onConfigsChange={setProviderConfigs}
        />

        <SkillManagerModal
          open={skillsOpen}
          onOpenChange={setSkillsOpen}
        />

        {/* 模板编辑器（从画布选中节点创建） */}
        <TemplateEditor
          open={templateEditorOpen}
          onOpenChange={(open) => {
            setTemplateEditorOpen(open);
            if (!open) {
              setTemplateInitialSteps(undefined);
              setTemplateInitialName(undefined);
            }
          }}
          initialSteps={templateInitialSteps}
          initialName={templateInitialName}
        />

        {/* 日历面板 */}
        {calendarOpen && (
          <CalendarPanel
            projectId={currentProjectId}
            onClose={() => setCalendarOpen(false)}
          />
        )}
      </div>

      {/* 统一悬浮面板 — 所有文档以标签页组织在单一面板中（自身带 absolute 定位） */}
      <UnifiedReaderPanel
        openReaderIds={openReaderIds}
        fileTabs={fileTabs}
        readerTitles={readerTitles}
        activePanelTab={activePanelTab}
        collapsed={panelCollapsed}
        wrapperRef={wrapperRef}
        onSelectTab={(type, id) => {
          setActivePanelTab({ type, id });
          if (type === 'node') {
            setActiveReaderId(id);
            lastActiveNodeIdRef.current = id;
          }
        }}
        onCloseNodeTab={closeReader}
        onCloseFileTab={closeFileTab}
        onToggleCollapse={handleTogglePanel}
        currentProjectId={currentProjectId}
      />

      {/* 系统级：选中文字后的按钮组（fixed 定位，组件自身带 overlay 标记） */}
      {textSelection && (
        <TextSelectionActions
          selectionPos={textSelection.selectionPos}
          nodes={nodes.map(n => ({ id: n.data.nodeMdId || n.id, title: n.data.title }))}
          onEdit={handleSystemInsertReference}
          onSendToNode={handleSendToNode}
          onDismiss={() => {
            setTextSelection(null);
            window.dispatchEvent(new CustomEvent('clear-text-selection'));
          }}
        />
      )}

      {/* 系统级：文本编辑弹窗（Portal 到 body，不在 wrapper 里所以不会触发 RF） */}
      {editPopupOpen && editPopupNodeId && (
        <TextEditPopup
          selectedText={editPopupText}
          nodeMdId={editPopupNodeId}
          onClose={() => {
            setEditPopupOpen(false);
            window.dispatchEvent(new CustomEvent('clear-text-selection'));
          }}
          onApplied={() => {
            // 通知对应 reader 刷新
            window.dispatchEvent(new CustomEvent('node-document-updated', {
              detail: { node_id: editPopupNodeId },
            }));
          }}
          position={editPopupPos}
        />
      )}
      </div>
      </div>
      </div>
      ) : (
        <WelcomeScreen onCreateProject={handleCreateProject} />
      )}
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
