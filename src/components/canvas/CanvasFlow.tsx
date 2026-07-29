'use client';

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
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
import { MarkdownReader } from './MarkdownReader';
import { FileViewer } from './FileViewer';
import { Sidebar } from './Sidebar';
import { CalendarPanel } from './CalendarPanel';
import { UpdateNotification } from './UpdateNotification';
import { WelcomeScreen } from './WelcomeScreen';
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

function CanvasFlowInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AiChatNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { screenToFlowPosition, getNodes, getIntersectingNodes, getViewport } = useReactFlow();
  const nodeIdCounter = useRef(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [openedFile, setOpenedFile] = useState<{
    projectId: string;
    fileName: string;
    filePath: string;
  } | null>(null);
  const [, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [openReaderIds, setOpenReaderIds] = useState<string[]>([]);
  const [activeReaderId, setActiveReaderId] = useState<string | null>(null);
  const [readerTitles, setReaderTitles] = useState<Record<string, string>>({});
  const [hasProject, setHasProject] = useState<boolean | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string>('');
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectionBoxPosition, setSelectionBoxPosition] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

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

  const openReader = useCallback((nodeMdId: string) => {
    setOpenReaderIds((prev) => {
      if (prev.includes(nodeMdId)) return prev;
      return [...prev, nodeMdId];
    });
    setActiveReaderId(nodeMdId);
    // 获取节点标题用于标签页显示
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
        setActiveReaderId(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
    setReaderTitles((prev) => {
      const next = { ...prev };
      delete next[nodeMdId];
      return next;
    });
  }, [activeReaderId]);
  const bringReaderToFront = useCallback((nodeMdId: string) => {
    setOpenReaderIds((prev) => {
      if (!prev.includes(nodeMdId)) return prev;
      return [...prev.filter((id) => id !== nodeMdId), nodeMdId];
    });
    setActiveReaderId(nodeMdId);
  }, []);

  // 检查是否有项目
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.projects && data.projects.length > 0) {
          setHasProject(true);
          setCurrentProjectId(data.current_id || '');
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

  // 框选开始（仅左键，排除 Handle 连线拖拽）
  const onPaneClickStart = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return; // 仅左键
      // 排除 Handle 元素（连线拖拽），避免连线时触发框选
      const target = event.target as HTMLElement;
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
    [],
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
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} onOpenSkills={() => setSkillsOpen(true)} onOpenCalendar={() => setCalendarOpen(true)} onOpenFile={(projId, name, path) => setOpenedFile({ projectId: projId, fileName: name, filePath: path })} projectId={currentProjectId} />
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
        panOnScroll={true}
        zoomOnScroll={false}
        minZoom={0.1}
        maxZoom={3}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        fitView
        fitViewOptions={{ padding: 0.4, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        zoomOnDoubleClick={false}
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
          className="absolute"
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
        </div>
      )}

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onConfigsChange={setProviderConfigs}
      />

      <SkillManagerModal
        open={skillsOpen}
        onOpenChange={setSkillsOpen}
      />

      {/* 日历面板 */}
      {calendarOpen && (
        <CalendarPanel
          projectId={currentProjectId}
          onClose={() => setCalendarOpen(false)}
        />
      )}

      {/* Markdown 阅读器 — 顶部标签页方式展示多个文档 */}
      {openReaderIds.length > 0 && (
        <div
          className="fixed right-0 top-0 z-50 flex h-full flex-col"
          style={{
            width: '48%',
            minWidth: '480px',
            maxWidth: '780px',
            backgroundColor: '#faf8f3',
            borderLeft: '1px solid rgba(0, 0, 0, 0.07)',
            boxShadow: '-12px 0 32px rgba(0, 0, 0, 0.06)',
          }}
        >
          {/* 标签页栏 */}
          <div
            className="flex shrink-0 items-center overflow-x-auto border-b"
            style={{
              borderColor: 'rgba(0, 0, 0, 0.07)',
              backgroundColor: '#f5f2ec',
            }}
          >
            {openReaderIds.map((id) => (
              <button
                key={id}
                onClick={() => setActiveReaderId(id)}
                className="group flex shrink-0 items-center gap-1.5 border-r px-3 py-2 text-[12px] transition-colors"
                style={{
                  borderColor: 'rgba(0, 0, 0, 0.06)',
                  backgroundColor: id === activeReaderId ? '#faf8f3' : 'transparent',
                  color: id === activeReaderId ? '#2c2416' : '#8a8270',
                  borderBottom: id === activeReaderId ? '2px solid oklch(0.62 0.17 45)' : '2px solid transparent',
                  marginBottom: '-1px',
                }}
              >
                <span className="max-w-[120px] truncate">
                  {readerTitles[id] || 'Loading...'}
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closeReader(id);
                  }}
                  className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                  style={{ backgroundColor: 'rgba(0,0,0,0.08)', color: '#5c5342' }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>

          {/* 当前活跃的阅读器 */}
          {activeReaderId && (
            <MarkdownReader
              key={activeReaderId}
              nodeMdId={activeReaderId}
              onClose={closeReader}
              mode="tabbed"
            />
          )}
        </div>
      )}

      {/* 文件查看器 */}
      {openedFile && (
        <FileViewer
          projectId={openedFile.projectId}
          fileName={openedFile.fileName}
          filePath={openedFile.filePath}
          onClose={() => setOpenedFile(null)}
        />
      )}

      {/* 更新通知 */}
      <UpdateNotification />
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
