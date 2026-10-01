'use client';

import { useState, useRef, useEffect, useCallback, useContext, useMemo, memo, useSyncExternalStore } from 'react';
import React from 'react';
import { createPortal } from 'react-dom';
import { useNodeHost, type HostNode, type HostEdge } from './node-host';
import { X, ArrowUpCircle, Gauge, Sparkles, ChevronDown, ChevronLeft, Check, Zap, Wrench, CheckCircle2, Copy, ClipboardCheck, FileText, Paperclip, Image as ImageIcon, File as FileIcon, AlertTriangle, AlertCircle, AtSign, Trash, Users, Folder, Film, Music, Table, Presentation, Shield, ShieldCheck, FileCheck, ExternalLink, RotateCw, ArrowDown, ClipboardList, Link2, ChartSpline, Play, Clock, Loader2, Bot, Search, Globe, Terminal, Pencil, Archive, Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AiChatNodeData, ChatMessage, ThinkingLevel, ToolCallRecord, ToolCallPhase, MessageAttachment, MessageReference, OutputFileItem, SkillDetail, SubagentPanel, TeamChatEvent } from '@/lib/types';
import QuestionPopup, { stripQuestionsBlock, type QuestionItem, type AnswerEntry } from './QuestionPopup';
import { ButlerConfirmModal, type ButlerConfirmState } from './ButlerConfirmModal';
import TeamMemberPickerDialog from './TeamMemberPickerDialog';
import TeamWorkbench from './TeamWorkbench';
import LoginDialog from './LoginDialog';
import { StreamingMarkdown, type ReadSourceInfo } from './HtmlRenderer';
import { normalizeSourceUrl } from '@/lib/materials/source-url';
import { bus, BusEvents } from '@/lib/bus';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  DISPLAY_CONFIGS,
  getAvailableModels,
  isCustomModel,
  parseCustomModel,
  getProviderPreset,
  sanitizeBaseUrl,
  PROVIDER_VENDOR,
  type ProviderConfig,
  type ProviderType,
} from '@/lib/types';
import { loadSettings, getQuickPrompts, updateQuickPrompts, type QuickPrompt } from '@/lib/settings';
import { outcomeMaxLengthForModel, inferContextWindow, compactTriggerTokensForContext } from '@/lib/context-limits';
import { WidgetRenderer, WidgetSkeleton } from './WidgetRenderer';
import { parseWidgetBlocks, hasWidgetBlocks, hasOpenWidgetFence } from '@/lib/widget-blocks';
import { desktop } from '@/lib/desktop-adapter';
import { openSandboxPreviewInHippo } from '@/lib/sandbox/open-preview';
import type { CodingPhase, AgentId } from '@/lib/agents/profiles';
import { registerScreenOcrTarget, unregisterScreenOcrTarget, setScreenOcrFocus } from '@/lib/screen-ocr/frontend';
import { parseCitations, CitationsPanel } from './CitationsPanel';
import { useConfirm } from './ConfirmDialog';
import { ShareButton, ShareCard } from './ShareCard';
import NodeCardHeader from './NodeCardHeader';
import StickyTodoDock from './StickyTodoDock';
import { ConversationTrajectory, type ConversationTrajectoryItem } from './TraceTimeline';
import { ContextMeter, type CtxMeterInfo } from './ContextMeter';
// P5a-1/P5a-2 事件窗口 schema：纯函数状态机（createTraceWindow/normalizeSseFrame/pushWindowFrame/finishWindow）
import { createTraceWindow, normalizeSseFrame, pushWindowFrame, finishWindow, eventsToTraceWindow, type TraceWindowState } from '@/lib/trajectory/present';
// P5a-2 Trace 面板窗口派生（可回退），行为不变：窗口 → ConversationTrajectoryItem 同形素材
import { windowToTrajectoryItems, type TraceWindowTurnItem } from '@/lib/trajectory/render';
import {
  useComposer,
  formatFileSize,
  type MaterialItem,
  type ComposerLink,
  type ComposerDirRef,
  type ComposerContext,
} from './composer/useComposer';
import ComposerChips from './composer/ComposerChips';
import MentionMenu from './composer/MentionMenu';
// 语音输入：录音状态机 + 麦克风左侧内联展开的录音条（与助理抽屉中栏输入框共用，见 components/ui/voice-input.tsx）
import { VoiceRecordBar, useVoiceInput, appendVoiceText } from '@/components/ui/voice-input';
// T1-2 抽离：纯函数/常量 → ./chatNodeKernelUtils，无状态子组件 → ./chatNodeKernelParts（零行为变更）
import {
  CODING_PHASE_UI, SYSTEM_PROMPT, THINKING_LEVEL_COLOR, THINKING_LEVEL_LETTER,
  buildTurnReferences, copyText, deriveInstantTitle, estimateProcessRows,
  fetchWithServerRecovery, finalizeMessagesPhase, finalizeToolCallPhase,
  formatDuration, formatMsgTime, isErrorReply, openChipPath, parseThink, stripReferenceMarkers,
} from './chatNodeKernelUtils';
import {
  AttachmentChips, MessagesErrorBoundary, ModelBrandLogo, MoonPhaseIcon, ReferenceChips, StepTypeIcon, TaskStepsPanel, TraceProcessSummary, WaitingHint,
} from './chatNodeKernelParts';
import type { PanelStep, StepStatus } from './chatNodeKernelParts';


/** 单个 URL（http/https/ftp 开头、无空白）：见 composer/useComposer */

/** 本组件视图的宿主节点形态（替代旧 React Flow Node 泛型） */
type KernelNode = HostNode<AiChatNodeData>;

/** 节点身份：由身份薄壳（ChatNode/CodingNode）注入，统一为 AGENT_PROFILES 注册表里的 AgentId */
export type ChatNodeIdentity = AgentId;


/** 宿主自绘画布节点 props（单焦点宿主 2026-09：显式声明 id/data/selected/identity） */
export interface ChatNodeKernelProps {
  id: string;
  data: AiChatNodeData;
  selected?: boolean;
  identity: ChatNodeIdentity;
  /** 渲染面：canvas = 画布节点卡片（默认）；sidebar = Hippo 浏览器对话栏。
   *  侧边栏没有画布语境，需隐藏画布专属的卡片头元素。 */
  surface?: 'canvas' | 'sidebar';
  /** 环境上下文：每轮自动前置进用户消息的模型侧内容（如 Hippo 侧边栏的当前页 URL/标题）。
   *  只进 effectiveContent，不进气泡正文、不落盘、发送后不清除 —— 与 referenceTag 的单槽位语义互不干扰。 */
  ambientContext?: string;
  /** Research 开关（Hippo 侧边栏）：同一件事的两个消费端读同一个值 ——
   *  开启时服务端多注入一段调研纪律、这里多渲染来源清单卡片，不各写各的判据。 */
  researchMode?: boolean;
}

// Context: 节点点击 .md 附件时通知画布打开阅读器
// options.outcomeMode: true 表示直接打开成果块编辑模式
export const NodeReaderContext = React.createContext<(nodeMdId: string, options?: { outcomeMode?: boolean }) => void>(() => {});




export function ChatNodeKernel({ id, data, selected, identity, ambientContext, researchMode, surface = 'canvas' }: ChatNodeKernelProps) {
  // 侧边栏面（Hippo 浏览器对话栏）：隐藏画布节点专属的卡片头元素（见下方 surface 判据）
  const isSidebar = surface === 'sidebar';
  // 宿主注入通道（单焦点宿主 2026-09）：替代 useReactFlow()/useStore(s=>s.edges)
  const nodeHost = useNodeHost();
  /** 等价旧 useReactFlow().setNodes（函数式语义；本文件 15 处 setNodes 全为"只改本节点 data"的 map） */
  const setNodes = useCallback(
    (updater: (nds: KernelNode[]) => KernelNode[]) => {
      nodeHost.updateNodes(updater as unknown as (prev: HostNode[]) => HostNode[]);
    },
    [nodeHost],
  );
  const getNodes = useCallback(
    (): KernelNode[] => nodeHost.readNodes() as KernelNode[],
    [nodeHost],
  );
  const getEdges = useCallback(
    (): HostEdge[] => nodeHost.readEdges(),
    [nodeHost],
  );

  /** 监听上游边断开状态（边表经外部 store 订阅：边变化触发本组件重渲染，不依赖 memo 数据比较） */
  const allEdges = useSyncExternalStore(nodeHost.subscribe, nodeHost.readEdges);
  // 标题栏"连线关系"计数：与我有活跃（未断开）child 边的关联数。
  // 画布已物理移除连线（2026-09），关系用标题链接图标表达，点击跳 NodeMap 高亮。
  const linkCount = useMemo(() => {
    let n = 0;
    for (const e of allEdges) {
      if (e.data?.disconnected) continue;
      if (e.source === id || e.target === id) n += 1;
    }
    return n;
  }, [allEdges, id]);
  useEffect(() => {
    const hasDisconnected = allEdges.some(
      (e) => e.target === id && e.data?.disconnected,
    );
    setHasDisconnectedUpstream(hasDisconnected);
  }, [allEdges, id]);
  const onOpenReader = useContext(NodeReaderContext);

  // 应用内置确认弹窗（macOS 风格英文文案）
  const { ask: confirmAsk, render: confirmRender } = useConfirm();
  // Butler 结构化确认卡片（排程创建/修改/删除的可编辑确认，挂在节点层）
  const [butlerConfirm, setButlerConfirm] = useState<ButlerConfirmState | null>(null);

  // 展开态尺寸（壳列分离阅读宽度方案）：外壳宽高均由外壳 style 的 width/height:100% 决定，
  // 随对话容器（已扣除左栏/右 dock）同轮次布局收缩；正文消息列仍限宽 720px（READING_COL_W），
  // 居中保证行长舒适（中文约 45 字），宽代码块经 .wide breakout 越出到正文列宽。
  // 曾用 canvas-visible-width 广播把 wrapper 实测宽写成 px：该广播经 ResizeObserver / 被动 effect
  // 在 paint 之后才送达，面板展开的那一帧外壳仍是旧宽度（1252px 覆盖 800px 面板）→ 视觉上
  // 「预览面板覆盖中间对话区」。CSS 100% 与容器在同一布局轮次收缩，无跨帧错位。

  const [messages, setMessages] = useState<ChatMessage[]>(() => finalizeMessagesPhase(data.messages ?? []));

  // AI Coding 节点（coding 身份，绑定 Bob Sandbox 小程序）
  const isCoding = identity === 'coding';
  // 标题前身份图标（2026-09 口径：去掉高亮边框后，用图标区分 agent）：coding→Terminal / Kar→FileText / Butler→ClipboardList / Archivist→Archive / 其余→Bot
  // 尺寸：chat 的 Bot 16px；coding/kar/butler/archivist 专属图标 15px（2026-09 视觉校准）
  const TitleIdentityIcon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> =
    identity === 'coding'
      ? Terminal
      : identity === 'note'
        ? FileText
        : identity === 'butler'
          ? ClipboardList
          : identity === 'archivist'
            ? Archive
            : Bot;
  const isBotTitleIcon = identity !== 'coding' && identity !== 'note' && identity !== 'butler' && identity !== 'archivist';

  // AI Coding 专项任务循环状态（改码→预览自检→测试→完成）：由服务端 coding_phase SSE 驱动
  const [codingPhase, setCodingPhase] = useState<CodingPhase>('idle');

  const [isStreaming, setIsStreaming] = useState(false);
  // 执行中同步标志（ref）：避免 setTimeout / 异步闭包读到过期的 isStreaming state
  const streamingRef = useRef(false);
  // 持久化进行中：append 请求尚未返回时置 true，期间锁定输入避免并发写同一节点文件
  const [persisting, setPersisting] = useState(false);
  const persistingRef = useRef(false);
  // 执行中点击发送的待办队列：严格插队（新消息排到队首），当前任务结束后自动逐条发送
  const pendingSendRef = useRef<string[]>([]);
  const [pendingSendCount, setPendingSendCount] = useState(0);
  // 一键安装等自动发送任务：设置（providerConfigs）尚未加载完成时的暂存位。
  // 挂载 effect 先于设置加载 effect 执行，此时 availableModels 为空会导致 doSend 在
  // 模型选择处被 alert 中断；等设置加载完成后再补发，消除挂载时序竞争。
  const deferredAutoSendRef = useRef<string | null>(null);
  const settingsLoadedRef = useRef(false);
  // 设置加载完成的 state 镜像：驱动下方"补发暂存任务"effect 触发（ref 不可作为依赖）
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // 当前正在流式生成的消息 id：仅这条消息按"未完成"渲染，其余 assistant 消息恒为完成态，
  // 避免新消息流式期间旧消息（含历史加载的消息）回退为纯文本 / 丢失卡片
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);

  // 执行状态广播：流式执行中（思考/工具调用/回复生成）通知 NodeMap 亮起呼吸灯；
  // 结束或节点卸载时广播 false，避免 NodeMap 残留高亮
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('node-executing', { detail: { node_id: id, executing: isStreaming } }),
    );
    return () => {
      window.dispatchEvent(
        // unmount:true 标识"组件卸载清理"而非真实任务结束，供 CanvasFlow 判断不点亮未读绿点
        new CustomEvent('node-executing', { detail: { node_id: id, executing: false, unmount: true } }),
      );
    };
  }, [id, isStreaming]);

  // 无卡片态状态模型（2026-09 产品口径）：
  //  - 节点一律处于大面板形态：有内容 = 大阅读面板，无内容 = 空态欢迎区（品牌行 + 输入框）；
  //  - 已移除「空节点小卡片（400px 紧凑输入条）」形态：新建会话固定为同一套欢迎区 UI，
  //    节点不再互斥收起，彻底消除「偶尔变成可展开/缩小节点」的类竞态问题。
  // 大阅读面板：宽度由外壳 style 的 width:100% 决定（高度同理由外壳 style 的 height:100% 决定），
  // 随对话容器（已扣除左栏/右 dock）同步收缩，不会与右侧宽屏预览面板重叠。
  // 宽度必须给显式定值（100%），不能用 width:auto：auto 会被内容 min-content（宽表格/长代码行）
  // 撑宽，导致节点宽度随内容抖动、300ms transition 持续跟随 → "整个节点在闪"。

  // 新建节点后自动聚焦输入框（CanvasFlow 创建流程广播）：ChatGPT 式「点新建即打字」
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ node_id?: string }>).detail;
      if (detail?.node_id && detail.node_id !== id) return;
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('chat-composer-focus', handler);
    return () => window.removeEventListener('chat-composer-focus', handler);
  }, [id]);

  // 划词追问：DocEditor 选中段落发送到本节点 → 挂为引用标签并聚焦输入框，等用户补写问题后随消息发送
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId?: string; text: string }>).detail;
      if (!detail?.text?.trim()) return;
      if (detail.nodeId && detail.nodeId !== id) return;
      setReferenceTag({ text: detail.text.trim() });
      setTimeout(() => textareaRef.current?.focus(), 100);
    };
    window.addEventListener('node-ask-question', handler);
    return () => window.removeEventListener('node-ask-question', handler);
  }, [id]);

  // 全局截图 OCR（Cmd+Shift+O）：注册本节点为结果插入目标（最近聚焦节点优先），
  // 识别文本追加到输入框并聚焦，等待用户确认后发送
  useEffect(() => {
    registerScreenOcrTarget(id, (text) => {
      setLocalInput((prev) => (prev.trim() ? `${prev}\n${text}` : text));
      setTimeout(() => textareaRef.current?.focus(), 50);
    });
    return () => unregisterScreenOcrTarget(id);
  }, [id]);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  // 消息级模型标签：展开显示完整模型名（点击切换，默认截断）
  const [expandedMetaId, setExpandedMetaId] = useState<string | null>(null);
  // Share 卡片：当前展开的消息 id（同一时间只展开一条消息的分享面板）
  const [shareMsgId, setShareMsgId] = useState<string | null>(null);
  /** 图片识别进度（vision_progress SSE 事件）：识别在流内执行，期间显示"正在识别图片 N/M"；
   *  phase='ocr' 时带 engine/model（bob-ocr-mcp 过程级进度：本地 Vision / GLM-OCR / Online OCR / VLM） */
  const [visionProgress, setVisionProgress] = useState<{
    phase: string;
    current: number;
    total: number;
    engine?: string;
    model?: string;
  } | null>(null);
  /** 等待授权的目标（Bobby grant_required SSE 事件写入；BobbyNode 授权完成事件匹配后自动继续） */
  const pendingGrantTargetRef = useRef<string | null>(null);
  /** 程序化发送消息的引用（由 handleSendWithText 同步；供早先声明的 useEffect 调用） */
  const sendTextRef = useRef<(text: string) => void>(() => {});

  // 监听 Bobby 授权完成事件（BobbyNode 弹窗点「同意」后广播）：
  // 若与当前等待授权的目标匹配 → 自动补发"已授权，继续"消息，触发主 Agent 重试执行（用户无需手动回复）
  useEffect(() => {
    const onBobbyGranted = (e: Event) => {
      const detail = (e as CustomEvent<{ target?: string }>).detail;
      const target = detail?.target;
      if (!target) return;
      const pending = pendingGrantTargetRef.current;
      if (!pending) return;
      if (target.trim().toLowerCase() !== pending.trim().toLowerCase()) return;
      pendingGrantTargetRef.current = null;
      if (streamingRef.current) return; // 若恰好仍在流式，跳过（下一轮会重新请求授权）
      // 触发新一轮：模型看到上下文中"授权拦截 + 已授权"后自动重试之前的工具调用
      sendTextRef.current(`（系统自动）已对 ${target} 完成授权，请继续执行之前暂停的任务。`);
    };
    window.addEventListener('bobby:granted', onBobbyGranted);
    return () => window.removeEventListener('bobby:granted', onBobbyGranted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bob-Mind（Buzan）未回看改动：用户在插件面板手动增删改导图走插件 REST，不会推给本节点，
  // 面板把「自上次回看以来的改动数」经 iframe 中继广播过来（PluginPanelFrame）→ 卡片显示角标；
  // 面板点 Ask Buzan → 自动发一轮消息，让 Buzan 先看最新导图再就改动表态（赞同/反对 + 理由）。
  const isMind = identity === 'mind';
  const [mindChanges, setMindChanges] = useState(0);
  useEffect(() => {
    if (!isMind) return;
    const onChanges = (e: Event) => {
      const n = Number((e as CustomEvent<{ count?: unknown }>).detail?.count);
      setMindChanges(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
    };
    const onAsk = () => {
      if (streamingRef.current) return; // 正在跑：不打断，等本轮结束由用户再点
      sendTextRef.current(
        '（系统自动）我在 Bob-Mind 面板刚改过导图，请先 mind_query 看最新状态，再就我的改动表态（赞同/反对 + 理由）。',
      );
    };
    window.addEventListener('bob-mind-changes', onChanges);
    window.addEventListener('bob-mind-ask', onAsk);
    return () => {
      window.removeEventListener('bob-mind-changes', onChanges);
      window.removeEventListener('bob-mind-ask', onAsk);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMind]);

  const [modelId, setModelId] = useState(data.modelId ?? DEFAULT_MODEL_ID);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // 节点内内容分栏（dsh 对话 / 轨迹 / 团队）：默认对话视图；轨迹承载完整执行明细，
  // 团队是本节点关联团队的协作工作台（数据真相源在引擎侧，见 TeamWorkbench）
  const [pane, setPane] = useState<'chat' | 'trace' | 'team'>('chat');
  /** P5b-1 历史 replay：点 Turn「查看原始轨迹」→ fetch /api/trajectory events → 窗口 → Trace 分栏渲染 */
  const [replay, setReplay] = useState<null | {
    taskId: string;
    turnNumber: number;
    status: 'loading' | 'ready' | 'error';
    items?: ConversationTrajectoryItem[];
    error?: string;
  }>(null);
  // 右侧「DOS 执行步骤」面板：手动关闭标记（新任务开始时自动重置）
  const [planPanelClosed, setPlanPanelClosed] = useState(false);
  // 面板收尾停留：流式结束后保留 3 秒全绿/失败状态再淡出，避免骤然消失
  const [planPanelLingering, setPlanPanelLingering] = useState(false);
  // 本轮多智能体方案被丢弃（审批卡 Discard / 等待批准超时）：右侧步骤面板据此收口为
  // 终态 DISCARDED，避免停在 EXECUTING 让人误以为还在执行。
  const [teamPlanDiscarded, setTeamPlanDiscarded] = useState(false);
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (isStreaming && !prevStreamingRef.current) {
      setPlanPanelClosed(false);
      setTeamPlanDiscarded(false);
    }
    // 流式从 true→false → 进入收尾停留
    if (!isStreaming && prevStreamingRef.current) {
      setPlanPanelLingering(true);
      const t = window.setTimeout(() => setPlanPanelLingering(false), 3000);
      prevStreamingRef.current = isStreaming;
      return () => window.clearTimeout(t);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);
  // 右侧「DOS 执行步骤」面板数据源：最近一次 todo_write 快照（三态真状态轨）。
  // goal 单独向前回溯：语义上只在首次建轨调用携带，后续心跳省略——取最近一次带 goal 的调用即可常驻显示。
  // 回退：旧 plan_task 消息（存量持久化历史，plan_task 工具已移除）仍按计数推断展示，保证历史可回看。
  const planInfo = useMemo(() => {
    if (!streamingMsgId) return null;
    const sm = messages.find((m) => m.id === streamingMsgId && m.role === 'assistant');
    if (!sm) return null;
    const calls = sm.toolCalls ?? [];

    // ① 优先：最近一次 todo_write 快照（真状态轨）
    let lastTodoIdx = -1;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].toolName === 'todo_write') { lastTodoIdx = i; break; }
    }
    if (lastTodoIdx >= 0) {
      const a = (calls[lastTodoIdx].arguments ?? {}) as Record<string, unknown>;
      const todos = Array.isArray(a.todos) ? a.todos : [];
      const items: PanelStep[] = todos.map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return {
          content: typeof o.content === 'string' ? o.content : '',
          activeForm: typeof o.activeForm === 'string' ? o.activeForm : '',
          status: (typeof o.status === 'string' ? o.status : 'pending') as StepStatus,
        };
      });
      if (items.length > 0) {
        // goal 回溯：向前找最近一次 todo_write 携带的 goal（仅在首次建轨调用携带，后续心跳省略）
        let goal = '';
        for (let i = lastTodoIdx; i >= 0; i--) {
          const c = calls[i];
          if (c.toolName !== 'todo_write') continue;
          const g = (c.arguments ?? {}).goal;
          if (typeof g === 'string' && g.trim()) { goal = g; break; }
        }
        const completed = items.filter((t) => t.status === 'completed').length;
        const running = items.some((t) => t.status === 'in_progress');
        return { goal, steps: items, completed, running, source: 'todo_write' as const };
      }
    }

    // ② 回退：存量 plan_task 消息（工具已移除，仅兼容历史回看）
    let goal = '';
    let steps: string[] = [];
    let planIdx = -1;
    calls.forEach((tc, idx) => {
      if (tc.toolName !== 'plan_task') return;
      planIdx = idx;
      const a = (tc.arguments ?? {}) as Record<string, unknown>;
      goal = typeof a.goal === 'string' ? a.goal : '';
      steps = Array.isArray(a.steps) ? a.steps.filter((s): s is string => typeof s === 'string') : [];
    });
    if (planIdx < 0 || steps.length === 0) return null;
    const execs = calls.slice(planIdx + 1).filter((tc) => tc.toolName !== 'plan_task' && tc.toolName !== 'finish_task' && tc.toolName !== 'todo_write');
    const completed = execs.filter((tc) => tc.phase === 'done' || tc.phase === 'error').length;
    const running = execs.some((tc) => tc.phase === 'running' || tc.phase === 'pending');
    return { goal, steps: steps.map((s) => ({ content: s, activeForm: '', status: 'pending' as const })), completed, running, source: 'plan_task' as const };
  }, [messages, streamingMsgId]);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    data.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
  );
  const [persistError, setPersistError] = useState<string | null>(null);
  const pendingAppendRef = useRef<{ nodeId: string; question: string; answer: string; mood?: { vibe?: string[]; sparks?: string[]; reflections?: string[]; will?: string[] }; modelId?: string; thinkingLevel?: ThinkingLevel } | null>(null);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<{name: string; description: string; source?: string; enabled?: boolean; scenes?: string[]}[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(
    () => new Set(Array.isArray(data.selectedSkills) ? data.selectedSkills as string[] : [])
  );
  /** msgId → 该回答命中的 skills 名字数组 */
  const [matchedSkillsByMsg, setMatchedSkillsByMsg] = useState<Record<string, string[]>>({});
  /** msgId → skills 详情数组（score、matchedKeywords、bodyLength 等） */
  const [skillDetailsByMsg, setSkillDetailsByMsg] = useState<Record<string, SkillDetail[]>>({});
  /** msgId → 本轮任务累计 token 消耗 { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens, calls } */
  const [usageByMsg, setUsageByMsg] = useState<Record<string, { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; calls: number }>>({});
  /** msgId → 完成轮次统计 { ttftMs, durationMs, tokensPerSec, thinking? }（dsh 完成轮次统计条）
   *  thinking：思考决策可见性（方向 D）——每轮实际档位/降级/C1 命中摘要 */
  const [statsByMsg, setStatsByMsg] = useState<Record<string, {
    ttftMs: number | null; durationMs: number; tokensPerSec: number;
    thinking?: { level?: string; downgradedRounds: number; trivialOff: boolean } | null;
  }>>({});
  /** composer 上下文占用环数据（dsh ContextMeter）：取最近一次 context_meter 事件 */
  const [composerCtxMeter, setComposerCtxMeter] = useState<CtxMeterInfo | null>(null);
  /** msgId → 缓存头指纹（system+tools SHA-256 前 12 位；pi-reasonix 思路，缓存命中归因诊断） */
  const [prefixHashByMsg, setPrefixHashByMsg] = useState<Record<string, string>>({});
  /** msgId → 该任务缓存头是否与上一个任务不同（不同 = 前缀缓存必然失效，本轮全价重算） */
  const [prefixChangedByMsg, setPrefixChangedByMsg] = useState<Record<string, boolean>>({});
  /** 最近一次见到的缓存头指纹（跨任务对比基准） */
  const lastPrefixHashRef = useRef<string>('');
  /** msgId → 缓存头分段指纹（system / tools / history / toolsByte），漂移时定位到段 */
  const [prefixSegsByMsg, setPrefixSegsByMsg] = useState<Record<string, { system: string; tools: string; toolsByte: string; history: string }>>({});
  /** msgId → 相对上一任务各分段是否变化（true 仅置位不回落，防止 done 帧同值覆盖 start 判定） */
  const [prefixSegChangedByMsg, setPrefixSegChangedByMsg] = useState<Record<string, { tools: boolean; toolsByte: boolean; history: boolean }>>({});
  /** 最近一次见到的分段指纹（跨任务逐段对比基准） */
  const lastPrefixSegsRef = useRef<{ system: string; tools: string; toolsByte: string; history: string } | null>(null);

  /**
   * 缓存头分段诊断落点：context_meter 与 done 两帧共用。
   * 对比基准语义：分段在「本任务首次收到」时与上一任务比对并记录 changed（只置 true 不回落），
   * 之后同任务重复帧（start/done 同值）不再改标记 → 渲染时能稳定展示"哪段漂移"。
   */
  const applyPrefixSegments = (assistantId: string, segs?: Record<string, unknown> | null): void => {
    if (!segs || !mountedRef.current) return;
    const cur = {
      system: typeof segs.system === 'string' ? segs.system : '',
      tools: typeof segs.tools === 'string' ? segs.tools : '',
      toolsByte: typeof segs.toolsByte === 'string' ? segs.toolsByte : '',
      history: typeof segs.history === 'string' ? segs.history : '',
    };
    const prev = lastPrefixSegsRef.current;
    const changed = {
      tools: !!prev && prev.tools !== cur.tools,
      toolsByte: !!prev && prev.toolsByte !== cur.toolsByte,
      history: !!prev && prev.history !== cur.history,
    };
    setPrefixSegsByMsg((p) => ({ ...p, [assistantId]: cur }));
    if (changed.tools || changed.toolsByte || changed.history) {
      setPrefixSegChangedByMsg((p) => ({ ...p, [assistantId]: changed }));
    }
    lastPrefixSegsRef.current = cur;
  };

  // P5a-1 事件窗口 schema（P5a-2 起 Trace 渲染消费，可回退）：旁路窗口 ref —— 每轮 doSend 开始 reset，
  // SSE 解析入口把每个已解析对象经 normalizeSseFrame + pushWindowFrame 喂入；
  // Trace 渲染优先读本窗口（见 conversationTrajectoryItems 尾部替换逻辑），窗口缺失/异常回退消息快照。
  const traceWindowRef = useRef<TraceWindowState | null>(null);
  /** P5a-2 渲染切换：窗口派生异常/类型不符回退时，console.warn 仅标注一次 */
  const windowFallbackWarnedRef = useRef(false);

  /**
   * P5b-1 历史 replay：给定 taskId fetch /api/trajectory 事件日志 → eventsToTraceWindow →
   * windowToTrajectoryItems → Trace 分栏回放（不触碰 live 旁路窗口 traceWindowRef）。
   * 接口失败 / 无可回放 → 置 error 态（Trace 分栏提示，入口保持隐藏由「无 taskId」天然覆盖）。
   */
  const openTaskReplay = async (taskId: string, turnNumber: number): Promise<void> => {
    setReplay({ taskId, turnNumber, status: 'loading' });
    try {
      const qs = new URLSearchParams({ node_id: id, task_id: taskId });
      if (typeof data.projectId === 'string' && data.projectId) qs.set('project_id', data.projectId);
      const res = await fetch(`/api/trajectory?${qs.toString()}`);
      const json = (await res.json().catch(() => null)) as { success?: boolean; events?: unknown[]; error?: string } | null;
      if (!res.ok || !json || json.success !== true || !Array.isArray(json.events)) {
        setReplay({ taskId, turnNumber, status: 'error', error: json?.error ?? `HTTP ${res.status}` });
        return;
      }
      const win = eventsToTraceWindow(json.events);
      const winItems = windowToTrajectoryItems(win) ?? [];
      const items: ConversationTrajectoryItem[] = winItems.map((w, i) => ({
        number: i === 0 ? turnNumber : turnNumber + i,
        userText: w.userText,
        thinkText: w.thinkText,
        toolCalls: w.toolCalls ?? [],
        skillDetails: w.skillDetails ?? [],
        matchedSkills: w.matchedSkills ?? [],
        isStreaming: false,
      }));
      if (items.length === 0) {
        setReplay({ taskId, turnNumber, status: 'error', error: '该任务无可回放轨迹（无工具 / 无思考 / 无技能记录）' });
        return;
      }
      setReplay({ taskId, turnNumber, status: 'ready', items });
    } catch (err) {
      setReplay({ taskId, turnNumber, status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  };

  // 会话级 Trajectory overlay 素材：把 messages 派生为「Turn 列表」（用户提问 + 该轮思考/工具/技能）
  const conversationTrajectoryItems = useMemo<ConversationTrajectoryItem[]>(() => {
    const out: ConversationTrajectoryItem[] = [];
    let userCount = 0;
    let lastUser = '';
    for (const m of messages) {
      if (m.role === 'user' && !m.system) {
        userCount += 1;
        lastUser = m.content ?? '';
        continue;
      }
      if (m.role !== 'assistant' || m.system) continue;
      const parsed = m.content ? parseThink(m.content) : null;
      const think = m.reasoning && m.reasoning.trim().length > 0 ? m.reasoning : (parsed ? parsed.think : '');
      const skills = matchedSkillsByMsg[m.id] ?? [];
      const details = skillDetailsByMsg[m.id] ?? [];
      const hasTrace = (m.toolCalls?.length ?? 0) > 0
        || think.trim().length > 0
        || details.length > 0
        || skills.length > 0;
      if (!hasTrace) continue;
      out.push({
        number: userCount,
        userText: lastUser,
        thinkText: think || undefined,
        toolCalls: m.toolCalls ?? [],
        skillDetails: details,
        matchedSkills: skills,
        isStreaming: m.id === streamingMsgId && isStreaming,
        durationMs: statsByMsg[m.id]?.durationMs,
        // P5b-1 历史 replay：携带本轮任务日志 taskId（Trace Turn 头显示「原始轨迹」入口）
        taskId: typeof m.taskId === 'string' && m.taskId ? m.taskId : undefined,
      });
    }
    // P5a-2 Trace 面板窗口派生（可回退），行为不变：当前轮旁路事件窗口存在且可展示时，
    // 用它替换「该轮消息快照派生项」；窗口为空/异常/类型不符 → 现状路径，其余轮次仍走消息快照。
    const winState = traceWindowRef.current;
    if (winState) {
      let winItems: TraceWindowTurnItem[] | null = null;
      try {
        winItems = windowToTrajectoryItems(winState);
      } catch { /* 窗口派生异常 → 回退现状路径 */ }
      const shapeOk = !!winItems && winItems.length > 0 && winItems.every(
        (w) => Array.isArray(w.toolCalls) && Array.isArray(w.skillDetails) && Array.isArray(w.matchedSkills),
      );
      if (shapeOk) {
        // 窗口恒对应最近一轮：仅替换最后一条消息派生项（保留其 number/userText/isStreaming/durationMs）
        const winItem = winItems![winItems!.length - 1];
        if (out.length > 0) {
          out[out.length - 1] = {
            ...out[out.length - 1],
            thinkText: winItem.thinkText,
            toolCalls: winItem.toolCalls,
            skillDetails: winItem.skillDetails,
            matchedSkills: winItem.matchedSkills,
          };
        } else if (winItem.toolCalls.length > 0 || (winItem.thinkText && winItem.thinkText.trim().length > 0)
          || winItem.skillDetails.length > 0 || winItem.matchedSkills.length > 0) {
          out.push({
            number: userCount > 0 ? userCount : 1,
            userText: lastUser || undefined,
            thinkText: winItem.thinkText,
            toolCalls: winItem.toolCalls,
            skillDetails: winItem.skillDetails,
            matchedSkills: winItem.matchedSkills,
            isStreaming,
          });
        }
      } else if (winItems) {
        // 类型护栏：窗口项缺失/类型不符 → 现状路径（dev 期 console.warn 一次标注）
        if (!windowFallbackWarnedRef.current) {
          windowFallbackWarnedRef.current = true;
          console.warn('[P5a-2 trace] 窗口派生类型不符 → window fallback（沿用消息快照派生）');
        }
      }
    }
    return out;
  }, [messages, matchedSkillsByMsg, skillDetailsByMsg, statsByMsg, streamingMsgId, isStreaming]);
  type StageKind = 'thinking' | { kind: 'tool'; name: string } | 'writing' | null;
  /** 将阶段值归一化为 kind 字符串，避免 TS 对联合类型收窄歧义 */
  const stageKindOf = (s: StageKind): 'thinking' | 'tool' | 'writing' | null => {
    if (s === 'thinking') return 'thinking';
    if (s !== null && typeof s === 'object' && s.kind === 'tool') return 'tool';
    if (s === 'writing') return 'writing';
    return null;
  };
  const [currentStage, setCurrentStage] = useState<StageKind>(null);
  // 等待安抚（侧边栏，见 WaitingHint）计时基准：任务开始或阶段切换即重置。
  // 计时放在窄栏那条 WaitingHint 内部（自带 1s tick），这里只存一个时刻，避免整个消息列表每秒重渲染。
  const [stageSince, setStageSince] = useState<number>(0);
  useEffect(() => {
    if (isStreaming) setStageSince(Date.now());
  }, [isStreaming]);
  useEffect(() => {
    setStageSince(Date.now());
  }, [currentStage]);
  // 空态欢迎区 BobWork 打字机效果：新建会话时逐字从左到右显示
  const [typedBrand, setTypedBrand] = useState('');
  const brandTypingDone = typedBrand.length >= 'BobWork'.length;
  useEffect(() => {
    // 仅空态（新建会话/清空后）展示打字机；一旦有内容就不再播
    if (messages.length !== 0) return;
    setTypedBrand('');
    const brand = 'BobWork';
    let i = 0;
    const timer = window.setInterval(() => {
      i += 1;
      setTypedBrand(brand.slice(0, i));
      if (i >= brand.length) window.clearInterval(timer);
    }, 90);
    return () => window.clearInterval(timer);
  }, [messages.length]);
  // 强制 MCP 胶囊名称来源：/api/mcp/store（kind=mcp 且已安装且全局打开；不依赖本地 settings 快照）
  const [nodeMcpOptions, setNodeMcpOptions] = useState<Array<{ id: string; name: string }>>([]);
  // ==== ChatNode 快捷指令（全局库） ====
  const [quickPrompts, setQuickPrompts] = useState<QuickPrompt[]>([]);
  const [quickPromptMenuOpen, setQuickPromptMenuOpen] = useState(false);
  /** 库内新建/编辑弹窗草稿：null=关闭；mode='new' 新建；mode='edit' 编辑（含 id） */
  const [quickPromptEditor, setQuickPromptEditor] = useState<{ mode: 'new' | 'edit'; id?: string; name: string; content: string; category: string } | null>(null);
  const quickPromptMenuRef = useRef<HTMLDivElement>(null);
  const [enabledMcpIds, setEnabledMcpIds] = useState<Set<string>>(
    () => new Set(Array.isArray(data.enabledMcpIds) ? data.enabledMcpIds as string[] : [])
  );
  /** 多智能体协作模式开关（frontmatter multi_agent_mode）：开启后本轮请求带 multiAgentMode，
   *  主 agent 可调用 team_run 编排多个成员协作，过程以折叠分支卡片呈现在「执行过程」区 */
  const [multiAgentMode, setMultiAgentMode] = useState<boolean>(data.multiAgentMode === true);
  /** Team 分栏两档模型（frontmatter team_main_model / team_worker_model）：队长跑主模型（规划成员与任务、
   *  复核并整合产出），全部成员一刀切跑次模型。只作用于多智能体协作，**绝不回写节点自身 chat 模型** */
  const [teamMainModel, setTeamMainModel] = useState<string>(typeof data.teamMainModel === 'string' ? data.teamMainModel : '');
  const [teamWorkerModel, setTeamWorkerModel] = useState<string>(typeof data.teamWorkerModel === 'string' ? data.teamWorkerModel : '');
  /** 本次执行的成员名单（Multi-agent mode 弹窗勾选的已安装 agent id）：**只存会话内不落盘**
   *  （用户每次点按钮重新选）；随请求发送，服务端据此注入编排规则、并对名单外补充成员强制弹卡审批 */
  const [presetAgentIds, setPresetAgentIds] = useState<string[]>([]);
  /** 成员选择弹窗开合 */
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  /** 本节点关联的协作团队 id 清单（frontmatter team_ids）：团队工作台据此列出「本会话产生过的团队」。
   *  只存引用——团队状态真相源在引擎侧（bob-team-mcp），节点不镜像任何团队数据 */
  const [teamIds, setTeamIds] = useState<string[]>(Array.isArray(data.teamIds) ? (data.teamIds as string[]) : []);
  const teamIdsRef = useRef<string[]>(Array.isArray(data.teamIds) ? (data.teamIds as string[]) : []);
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([]);
  // Role Assignment 主对话模型配置（决定节点 chat 下拉菜单的模型范围：优先模型 + 候选池）
  const [chatRoleModel, setChatRoleModel] = useState<{ defaultModel?: string; pool?: Array<{ provider: string; modelId: string }> } | undefined>(undefined);
  // 附件 / 链接 / 操作目录 的待发状态由 composer/useComposer 统一承载（chat 与 team 共用）
  // 划词操作窗：在消息内容中选中文字 → 显示"作为附件"浮层
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const selectionMenuRef = useRef<HTMLDivElement>(null);
  // 吞掉下一次 window mouseup：点击操作窗按钮时，若按钮 onClick 同步关窗，React 在离散事件内
  // 同步 flush → 弹窗在 window 层 mouseup 到达前已卸载，selectionMenuRef.contains 兜底失效，
  // 残留选区会让该 mouseup 再次 setSelectionMenu = 二次弹窗。mousedown 打标 → 紧随 mouseup 忽略。
  const suppressNextMenuMouseUpRef = useRef(false);
  // mousedown 瞬间的选区快照：mouseup 时若选区与快照完全一致 = 不是新划出来的文字，
  // 而是“点击其它地方时残留的旧选区”→ 操作窗收起而非重定位（点击弹窗外任意处即消失）
  const preMouseSelRef = useRef('');
  // 清除文档选区：操作窗因动作（复制/附件）关闭后调用，避免高亮残留导致之后任意 click 的
  // mouseup 又触发弹窗（复制关闭后 1.2s 再点一下就会二次弹窗的根因）
  const clearDocSelection = useCallback(() => {
    try {
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    } catch {
      // noop：个别隔离环境下 getSelection 可能抛错，不影响主流程
    }
  }, []);
  // 复制反馈：图标短暂变 ✓（不显示 "Copied" 文案），弹窗保持不消失；~900ms 后图标复原可再次复制
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const [questionPopup, setQuestionPopup] = useState<{
    questions: QuestionItem[];
    /** ask_user_questions 工具模式：提交后 POST /api/chat/questions 回传，由服务端把答案并入对话继续生成 */
    requestId: string;
    /** 服务端回答窗口（秒）：倒计时归零后服务端按未回答继续生成 */
    timeoutSec?: number;
    /** 最小化为悬浮胶囊：关闭弹窗≠放弃，可随时点开继续作答 */
    minimized?: boolean;
  } | null>(null);
  // 标题闪烁提醒：等待用户回答且窗口不在前台时，document.title 交替闪烁；回到前台自动还原
  const [questionTitleFlash, setQuestionTitleFlash] = useState(false);
  useEffect(() => {
    if (!questionTitleFlash) return;
    const original = document.title;
    let on = false;
    const t = setInterval(() => {
      on = !on;
      document.title = on ? '❗ 等待你的回答 — BobWork' : original;
    }, 1000);
    const onVisibility = () => {
      if (!document.hidden) setQuestionTitleFlash(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
      document.title = original;
    };
  }, [questionTitleFlash]);
  // pagehide 兜底：页面关闭/刷新时若提问仍挂起，用 sendBeacon 立即按「未回答」回传，
  // 服务端随即继续生成，不必干等 10 分钟超时（提交/跳过后 requestId 清空，监听自动移除）。
  const questionRequestId = questionPopup?.requestId;
  useEffect(() => {
    if (!questionRequestId) return;
    const onPageHide = () => {
      try {
        const payload = JSON.stringify({ requestId: questionRequestId, answers: [] });
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          navigator.sendBeacon('/api/chat/questions', new Blob([payload], { type: 'application/json' }));
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [questionRequestId]);
  // browser.login（BobWork 模式）登录弹窗：模型调用 browser.login 后扩展返回 loginRequired，
  // 服务端发 login_required SSE 事件，此处弹窗让用户输入账号密码；凭据仅经 前端→服务端内存→MCP→扩展 直传，不过模型
  const [loginPopup, setLoginPopup] = useState<{
    requestId: string;
    siteName: string;
    url: string;
    timeoutSec?: number;
  } | null>(null);
  // 工具确认等待中：节点边框呼吸灯提醒（收到 tool_confirm 至确认回传期间亮起）
  const [confirmPending, setConfirmPending] = useState(false);
  const [hasDisconnectedUpstream, setHasDisconnectedUpstream] = useState(false);
  const [outcomeStatus, setOutcomeStatus] = useState<'locked' | 'draft' | 'stale' | 'legacy' | null>(null);
  // 失效原因链（frontmatter outcome_stale_reason）：悬浮提示展示「因哪条上游、哪条前提已废」
  const [outcomeStaleReason, setOutcomeStaleReason] = useState<string | null>(null);
  const [outcomeLoading, setOutcomeLoading] = useState(false);
  // 强制锁定标记：成果块校验未通过但用户自主决定锁定
  const [forceLocked, setForceLocked] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 补充内容续写模式：用户回答 AI 提问后，将答案合并到原始用户消息中重新发起一轮完整对话
  // 存储原始 Q&A 上下文供 doSend 构建 API 消息时使用（UI 不显示中间 AI 回复，但 API 需要完整上下文）
  const continuationContextRef = useRef<{ originalUserContent: string; originalAssistantContent: string; supplementText: string; attachments?: ChatMessage['attachments']; initialOutputFiles?: OutputFileItem[] } | null>(null);
  // 续写模式 UI 快照：API 失败时回滚，避免上一轮 AI 回复丢失后 UI 只剩用户问题
  const continuationSnapshotRef = useRef<ChatMessage[] | null>(null);
  const currentMdId = data.nodeMdId || id;

  // 透传 projectId：所有 /api/nodes 请求统一加 project_id 避免走错项目
  const nodeProjectQuery = useMemo(
    () => (typeof data.projectId === 'string' && data.projectId ? `&project_id=${encodeURIComponent(data.projectId)}` : ''),
    [data.projectId],
  );
  const withProjectId = useCallback(
    <T extends Record<string, unknown>>(body: T): T =>
      (typeof data.projectId === 'string' && data.projectId ? { ...body, project_id: data.projectId } : body),
    [data.projectId],
  );

  // 归档功能已移除（2026-09）：会话只保留删除，不再支持归档/恢复

  // 引用标签（从 HtmlReader 选中文字后插入）
  const [referenceTag, setReferenceTag] = useState<{ text: string } | null>(null);

  // === 优化1：新消息提示条 ===
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const [unreadMsgCount, setUnreadMsgCount] = useState(0);
  // 记录最后一条"用户已读"消息数，用于计算新消息数
  const lastReadCountRef = useRef(0);
  // 区分自动滚动触发的 scroll 与用户手动触发的 scroll
  const programmaticScrollRef = useRef(false);

  useEffect(() => {
    // 消费"发送到新建节点"缓冲：新节点挂载时若已有待发送文字，直接设为引用标签
    const pendingRefMap = window.__pendingNodeReference;
    if (pendingRefMap?.[currentMdId]) {
      const buffered = pendingRefMap[currentMdId];
      setReferenceTag({ text: buffered });
      delete pendingRefMap[currentMdId];
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
    // 消费"一键安装等任务"缓冲：新节点挂载后直接自动发送执行
    // （忙碌时入待办队列，任务结束后自动发送；设置未加载完时暂存，加载完成后再补发，
    //   避免 availableModels 尚为空导致 doSend 在模型选择处被 alert 中断）
    const pendingTaskMap = window.__pendingNodeTasks;
    if (pendingTaskMap?.[currentMdId]) {
      const task = pendingTaskMap[currentMdId];
      delete pendingTaskMap[currentMdId];
      if (streamingRef.current || persistingRef.current) {
        pendingSendRef.current.unshift(task);
        setPendingSendCount(pendingSendRef.current.length);
      } else if (!settingsLoadedRef.current) {
        deferredAutoSendRef.current = task;
      } else {
        handleSendWithText(task);
      }
    }
    // 外部一键安装等任务派发：显式发送（忙碌时入待办队列，任务结束后自动发送）
    const taskHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { node_id: string; text: string };
      if (detail?.node_id === currentMdId && detail?.text) {
        if (streamingRef.current || persistingRef.current) {
          pendingSendRef.current.unshift(detail.text);
          setPendingSendCount(pendingSendRef.current.length);
        } else {
          handleSendWithText(detail.text);
        }
      }
    };
    window.addEventListener('send-task-to-node', taskHandler);
    return () => {
      window.removeEventListener('send-task-to-node', taskHandler);
    };
  }, [currentMdId]);

  // 从文件浏览器发送的附件通道（add-attachment-to-node）在 useComposer 之后接入，见下方

  // Materials @ mention：状态与处理器统一由 composer/useComposer 承载（chat 与 team 共用）
  /** contentEditable 输入框的纯文本镜像（含 @文件名 标记文本，DOM 渲染时替换为 chip） */
  const [localInput, setLocalInput] = useState('');
  // 输入草稿持久化：切换节点 / 节点重挂载 / 项目切换时保留未发送的输入（localStorage 按 项目+节点 隔离）
  const nodeDraftKey = useMemo(
    () => (typeof data.projectId === 'string' && data.projectId ? `bobwork-node-draft:${data.projectId}:${id}` : null),
    [data.projectId, id],
  );
  const localInputRef = useRef(localInput);
  useEffect(() => { localInputRef.current = localInput; }, [localInput]);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 挂载时恢复未发送的草稿；卸载时立即保存当前草稿（防切换瞬间丢失）
  useEffect(() => {
    if (!nodeDraftKey) return;
    try {
      const saved = localStorage.getItem(nodeDraftKey);
      if (saved && saved.trim()) setLocalInput(saved);
    } catch { /* ignore */ }
    return () => {
      if (nodeDraftKey && localInputRef.current.trim()) {
        try { localStorage.setItem(nodeDraftKey, localInputRef.current); } catch { /* ignore */ }
      }
    };
  }, [nodeDraftKey]);
  // 输入变化 → 防抖写草稿（空输入则清除）
  useEffect(() => {
    if (!nodeDraftKey) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      try {
        if (localInput.trim()) localStorage.setItem(nodeDraftKey, localInput);
        else localStorage.removeItem(nodeDraftKey);
      } catch { /* ignore */ }
    }, 400);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [localInput, nodeDraftKey]);
  // 消息已提交（发送/入队）后清除草稿
  const clearNodeDraft = useCallback(() => {
    if (nodeDraftKey) { try { localStorage.removeItem(nodeDraftKey); } catch { /* ignore */ } }
  }, [nodeDraftKey]);

  // ⌘F My Quick：外部向本节点输入框注入预设提示词（不自动发送）
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ nodeId?: string; text?: string }>).detail;
      if (d && d.nodeId === id && typeof d.text === 'string') {
        setLocalInput(d.text);
      }
    };
    window.addEventListener('quick-prompt-inject', h);
    return () => window.removeEventListener('quick-prompt-inject', h);
  }, [id]);

  // 加载已配置的提供商，并监听设置变更事件
  useEffect(() => {
    const load = async () => {
      const settings = await loadSettings();
      setProviderConfigs(settings.providers);
      setChatRoleModel(settings.chatModel);
      const servers = settings.mcpServers || [];
      // 加载快捷指令全局库
      const qps = await getQuickPrompts();
      setQuickPrompts(qps);
      // 清理已被删除的 MCP 服务器：强制列表只保留仍存在的 id（不再携带孤儿 id），并同步持久化
      const validIds = new Set(servers.map((s) => s.id));
      setEnabledMcpIds((prev) => {
        const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
        if (next.size === prev.size) return prev;
        persistAgentState({ enabledMcpIds: Array.from(next) });
        return next;
      });
      // 设置加载完成 → 标记就绪，由下方独立 effect 在 availableModels 更新后补发暂存任务
      settingsLoadedRef.current = true;
      setSettingsLoaded(true);
    };
    load();
    const handler = async () => {
      const settings = await loadSettings();
      setProviderConfigs(settings.providers);
      setChatRoleModel(settings.chatModel);
      const servers = settings.mcpServers || [];
      // 设置变更时刷新快捷指令库
      const qps = await getQuickPrompts();
      setQuickPrompts(qps);
      // 全局配置变更时同步裁剪已被删除的 MCP（同上，强制列表不携带孤儿 id）
      const validIds = new Set(servers.map((s) => s.id));
      setEnabledMcpIds((prev) => {
        const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
        if (next.size === prev.size) return prev;
        persistAgentState({ enabledMcpIds: Array.from(next) });
        return next;
      });
      settingsLoadedRef.current = true;
      setSettingsLoaded(true);
    };
    window.addEventListener('provider-configs-changed', handler);
    return () => window.removeEventListener('provider-configs-changed', handler);
  }, []);

  // 节点 MCP 下拉数据源：服务端 Store（kind=mcp 且已安装且全局打开）
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      try {
        const res = await fetch('/api/mcp/store');
        const data = (await res.json()) as { entries?: Array<{ id: string; name: string; kind: string; installed: boolean; enabled: boolean }> };
        if (cancelled) return;
        const opts = (data.entries || [])
          .filter((e) => e.kind === 'mcp' && e.installed && e.enabled)
          .map((e) => ({ id: e.id, name: e.name }));
        setNodeMcpOptions(opts);
      } catch {
        /* store 拉取失败：保留上一次结果 */
      }
    };
    void update();
    const onChanged = () => void update();
    window.addEventListener('provider-configs-changed', onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('provider-configs-changed', onChanged);
    };
  }, []);

  // AI 配置类工具执行完成 → 广播配置变更（设置弹窗 / Sidebar logo / 其他节点自动刷新）
  // 去重：流式期间 messages 每来一个 chunk 就变一次，若只看「是否存在已完成的配置工具」，
  // 会在本轮每个 chunk 都广播一次 → 订阅方（本组件 + Sidebar + 其他节点）反复全量 loadSettings
  // 并重渲染全画布。改为按「消息 id + 工具序号 + 工具名」记忆已广播项，同一处只广播一次。
  const broadcastConfigToolsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const CONFIG_TOOL_NAMES = new Set(['get_app_config', 'set_app_icon', 'update_provider_config', 'manage_mcp_server']);
    let changed = false;
    for (const m of messages) {
      (m.toolCalls || []).forEach((t, i) => {
        if (t.phase !== 'done' || !CONFIG_TOOL_NAMES.has(t.toolName)) return;
        const key = `${m.id}#${i}#${t.toolName}`;
        if (broadcastConfigToolsRef.current.has(key)) return;
        broadcastConfigToolsRef.current.add(key);
        changed = true;
      });
    }
    if (changed) {
      // 通知全局组件刷新（Sidebar logo / 其他节点 MCP、模型下拉）
      window.dispatchEvent(new Event('provider-configs-changed'));
      // 通知设置弹窗刷新表单（独立事件：设置弹窗自身保存也会广播
      // provider-configs-changed，避免把保存后的 Saved 状态误刷新掉）
      window.dispatchEvent(new Event('app-config-changed'));
    }
  }, [messages]);

  // 用户消息中出现过的绝对路径（视为用户已给出 → 自动授权；同时从授权请求卡片中剔除，避免"已给路径还弹请求卡"）
  const userGivenPaths = useMemo(() => {
    const candidates: string[] = [];
    for (const m of messages) {
      if (m.role !== 'user' || !m.content) continue;
      for (const token of m.content.split(/[\s,，、'"（）()\[\]"`；;：:]+/)) {
        if (/^(\/|~\/|~)(?!\/+$).+\S/.test(token)) candidates.push(token);
      }
    }
    return candidates;
  }, [messages]);
  const normAuthPath = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');

  // AUTH_REQ：AI 在回复中声明需要访问的项目外目录 → 自动 authorize_root（用户确认"粘贴路径即授权"，声明路径直接加入 AI 可读写白名单），并刷新「本地文件」面板。
  // 安全护栏：仅授权"用户消息中明确出现过的路径"（用户粘贴/填写/提及），AI 幻觉声明的未提供路径不自动授权，防止超范围授权。
  // 用户未给过的路径不自动授权：渲染 AuthReqCard 请求卡片，由用户一键批准。
  // processedAuthReqsRef 按消息内容去重，避免重复请求。
  const processedAuthReqsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh: string[] = [];
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.content) continue;
      const parsed = extractAuthReqs(m.content);
      for (const p of parsed.paths) {
        const key = norm(p);
        if (processedAuthReqsRef.current.has(key)) continue;
        processedAuthReqsRef.current.add(key);
        // 仅在用户消息中出现过该路径（或其父路径）时才自动授权；未给过的路径由授权请求卡片让用户手动批准
        const userGiven = userGivenPaths.some((u) => {
          const nu = norm(u);
          return nu === key || nu.startsWith(key + '/') || key.startsWith(nu + '/');
        });
        if (userGiven) fresh.push(key);
      }
    }
    if (fresh.length === 0) return;
    (async () => {
      let authorized = 0;
      for (const p of fresh) {
        try {
          // authorize_root 即授权：AI 可对目录内文件增改删；该路径同时进入浏览列表
          const res = await fetch(`/api/local-files?action=authorize_root&path=${encodeURIComponent(p)}`);
          const data = await res.json();
          if (data?.success) authorized++;
        } catch (e) {
          console.error('AUTH_REQ authorize_root failed:', p, e);
        }
      }
      if (authorized > 0) {
        window.dispatchEvent(new CustomEvent('local-roots-changed'));
      }
    })();
  }, [messages]);

  // providerConfigs 引用变化时才重算：getAvailableModels 每次调用都返回新数组，
  // 若直接内联，会让下游 effect / useMemo 的依赖（dropdownModels、teamModelOptions 等）每渲染必变，
  // 引发「每渲染必跑 effect」的重渲染放大。
  const availableModels = useMemo(() => getAvailableModels(providerConfigs), [providerConfigs]);

  // 设置加载完成 & 模型池就绪后，补发挂载期暂存的一键安装任务。
  // 依赖 availableModels：确保 setProviderConfigs 已生效（状态更新批量提交后本 effect 才运行），
  // 避免 doSend 在模型选择处拿到空池被 alert 中断；无模型时也会补发 → doSend 正确提示配置模型。
  useEffect(() => {
    if (!deferredAutoSendRef.current) return;
    // 设置尚未加载完成时不补发（挂载首帧也会触发本 effect，此时模型池仍为空）
    if (!settingsLoaded) return;
    const task = deferredAutoSendRef.current;
    deferredAutoSendRef.current = null;
    handleSendWithText(task);
  }, [settingsLoaded, availableModels]);

  /** 本地回环地址判定（localhost / 127.0.0.1 / [::1] / 0.0.0.0），与 /api/models/health 服务端判定口径一致 */
  const isLocalEndpointUrl = (url: string): boolean =>
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|[/])/i.test(url) ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(url);

  // 本地 providers 的实时连接状态（key = provider type）：菜单打开时轻量探测（10s 节流），
  // 探测失败 → 该 provider 的模型标注"本地未连接"；未探测/正常 → 不标注。方案 2：标注而非隐藏。
  const [localHealth, setLocalHealth] = useState<Record<string, 'checking' | 'ok' | 'down'>>({});
  const healthProbeAtRef = useRef<Record<string, number>>({});

  // 节点 chat 下拉菜单的模型范围：仅显示 chatModel 角色池（chatRoleModel.pool）中选择的模型，
  // 不再并入模型池全部已勾选模型（availableModels），避免下拉冗余。
  // pool 条目优先从 availableModels 查找完整信息（label/description/thinking 等），
  // 找不到再用 provider preset 合成条目，保证可见性。
  const dropdownModels = useMemo(() => {
    const chatPool = chatRoleModel?.pool ?? [];
    const result: typeof availableModels = [];
    const seen = new Set<string>();

    for (const p of chatPool) {
      const key = `${p.provider}:${p.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 优先从已勾选模型中查找完整信息
      const matched = availableModels.find((m) => m.modelId === key);
      if (matched) {
        result.push(matched);
        continue;
      }
      // 找不到则按 preset 合成
      const preset = getProviderPreset(p.provider as ProviderType);
      const presetModel = preset?.models.find((m) => m.modelId === p.modelId);
      const isThinking = presetModel?.thinking ?? true;
      result.push({
        group: preset?.label ?? p.provider,
        modelId: key,
        label: presetModel?.label ?? p.modelId,
        description: presetModel?.description ?? '角色池绑定模型',
        thinking: isThinking,
        temperature: presetModel?.temperature ?? (isThinking ? 1.0 : 0.7),
        spec: presetModel?.spec,
        vendor: preset ? PROVIDER_VENDOR[p.provider as ProviderType] : undefined,
      });
    }
    // 候选池为空时退化为「全部已勾选模型」：Auto 下线后节点必须能从下拉里选到具体模型，
    // 不能再出现「菜单里只剩 Auto」的空下拉。
    return result.length > 0 ? result : availableModels;
  }, [availableModels, chatRoleModel]);

  // Team 分栏两档模型的候选项（与节点 chat 下拉同源：chatModel 角色池）
  const teamModelOptions = useMemo(
    () => dropdownModels.map((m) => ({ modelId: m.modelId, label: m.label })),
    [dropdownModels],
  );
  // 最终生效值：frontmatter 存的选择若已不在模型池（换供应商/取消勾选）→ 回落池内首个
  //（再退到节点当前 chat 模型），避免下拉空选、team_run 因缺模型被直接拒绝
  const resolvedTeamMainModel = useMemo(() => {
    if (teamMainModel && teamModelOptions.some((m) => m.modelId === teamMainModel)) return teamMainModel;
    const fallback = availableModels.find((m) => m.modelId === modelId) ?? availableModels[0];
    return teamModelOptions[0]?.modelId ?? fallback?.modelId ?? '';
  }, [teamMainModel, teamModelOptions, availableModels, modelId]);
  // 次模型缺省 = 主模型（配置极简：默认不额外选）
  const resolvedTeamWorkerModel = useMemo(() => {
    if (teamWorkerModel && teamModelOptions.some((m) => m.modelId === teamWorkerModel)) return teamWorkerModel;
    return resolvedTeamMainModel;
  }, [teamWorkerModel, teamModelOptions, resolvedTeamMainModel]);

  // 菜单打开时对本地回环 baseUrl 的 provider 做一次轻量连接探测（10s 节流），
  // 探测失败 → localHealth[provider] = 'down'，下拉模型项显示"本地未连接"灰色标注
  useEffect(() => {
    if (!modelMenuOpen) return;
    const localProviders = new Set<string>();
    const collectLocal = (providerType: string, cfg?: ProviderConfig) => {
      const preset = getProviderPreset(providerType as ProviderType);
      const baseUrl = sanitizeBaseUrl(cfg?.baseUrl || preset?.baseUrl || '');
      if (isLocalEndpointUrl(baseUrl)) localProviders.add(providerType);
    };
    for (const m of dropdownModels) {
      const parsed = parseCustomModel(m.modelId);
      if (!parsed) continue;
      const cfg = providerConfigs.find((c) => c.type === parsed.provider);
      collectLocal(parsed.provider, cfg);
    }
    if (localProviders.size === 0) return;

    for (const provider of localProviders) {
      const last = healthProbeAtRef.current[provider];
      if (last && Date.now() - last < 10000) continue;
      healthProbeAtRef.current[provider] = Date.now();
      const cfg = providerConfigs.find((c) => c.type === provider);
      const preset = getProviderPreset(provider as ProviderType);
      const baseUrl = sanitizeBaseUrl(cfg?.baseUrl || preset?.baseUrl || '');
      setLocalHealth((s) => ({ ...s, [provider]: 'checking' }));
      (async () => {
        try {
          const res = await fetch('/api/models/health', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl, apiKey: cfg?.apiKey || '' }),
          });
          const data = await res.json().catch(() => ({}));
          setLocalHealth((s) => ({ ...s, [provider]: (data as { ok?: boolean }).ok ? 'ok' : 'down' }));
        } catch {
          setLocalHealth((s) => ({ ...s, [provider]: 'down' }));
        }
      })();
    }
  }, [modelMenuOpen, dropdownModels, providerConfigs]);

  const abortRef = useRef<AbortController | null>(null);
  // 本轮生成是否触顶（finish_reason=length）：触顶时在回复末尾追加截断提示，避免"突然停止"无任何说明
  const truncatedRef = useRef(false);
  // 已压缩对话轮次数（memory_compacted_until）：请求时跳过这些历史轮次，只发压缩后的新增对话。
  // 被跳过的内容由 system 中的「压缩记忆 + 成果块」兜底（详见 route.ts R-14），记忆不丢失。
  const compactedUntilRef = useRef<number>(typeof data.compactedUntil === 'number' ? data.compactedUntil : 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 节点最外层 wrapper（.ai-node-wrapper）：放大态拦截 wheel 避免穿透到画布平移
  const nodeWrapperRef = useRef<HTMLDivElement>(null);
  // contentEditable 输入框（支持 @ 文件引用 chip）：同 ImageGenPromptBar 的富文本输入机制
  const textareaRef = useRef<HTMLDivElement>(null);
  // 输入框根容器（inputInner，含边框/padding 的视觉外沿）：供 inputAnchor 量取与弹窗对齐的精确宽度
  const inputBoxRef = useRef<HTMLDivElement>(null);
  // IME 合成状态追踪：macOS 中文拼音输入法确认候选词时，浏览器先触发 compositionend 再触发 keydown(Enter)，
  // 此时 nativeEvent.isComposing 已为 false。用 ref 手动追踪合成状态，弥补这一竞态。
  const composingRef = useRef(false);

  // ===== 附件 + @ 引用能力（chat 与 team 输入框共用同一实现：composer/useComposer）=====
  const composer = useComposer({
    nodeId: currentMdId,
    nodeTitle: data.title || '',
    disabled: isStreaming,
    inputRef: textareaRef,
    text: localInput,
    setText: setLocalInput,
    composingRef,
  });
  const {
    pendingAttachments,
    pendingLinks,
    contextFolders,
    setContextFolders,
    uploadingAttachment,
    dragOver,
    authorizedRoots,
    addAttachments,
    removePendingAttachment,
    removePendingLink,
    removeContextFolder,
    revokeRootAuth,
    handleFileSelect,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    pendingMaterials,
    pendingDirRefs,
    mentionOpen,
    mentionQuery,
    mentionIndex,
    mentionDir,
    mentionDirItems,
    mentionDirLoading,
    mentionRef,
    handleInput,
    handleMentionKeyDown,
    handleMentionSelect,
    openMentionFromIcon,
    goBackDir,
    buildBlocks,
  } = composer;

  // ===== 语音输入（微信式）：MediaRecorder 录音 → 服务端 STT 转文字回填输入框。
  // 状态机与录音条已抽到 components/ui/voice-input.tsx（助理抽屉中栏输入框共用同一套，
  // 避免「同一个录音流程写两遍」）；这里只保留本输入框特有的两件事：文字追加到哪、失败怎么讲。 =====
  // 流式「边说边写」的草稿基线：null = 本次录音没有实时预填（走录制链路，或还没出字）
  const voiceBaseRef = useRef<string | null>(null);
  const voice = useVoiceInput({
    canStart: !isStreaming,
    // 实时预填：第一次出字时快照住当前草稿，之后草稿一直是「基线 + 中间文本」
    onPartial: (text) => {
      if (voiceBaseRef.current === null) voiceBaseRef.current = localInputRef.current;
      setLocalInput(appendVoiceText(voiceBaseRef.current, text));
    },
    // 作废（✕ / 没识别出文字 / 流式半途失败）：草稿还原成录音前的样子
    onDiscard: () => {
      const base = voiceBaseRef.current;
      voiceBaseRef.current = null;
      if (base !== null) setLocalInput(base);
    },
    // 定稿：流式链路草稿里已有预填 → 用定稿文本覆盖它；录制链路 → 追加到现有草稿之后（不自动发送）
    onText: (text) => {
      const base = voiceBaseRef.current;
      voiceBaseRef.current = null;
      setLocalInput((prev) => appendVoiceText(base ?? prev, text));
      setTimeout(() => textareaRef.current?.focus(), 50);
    },
    onError: (reason) => {
      void confirmAsk({
        title: 'Voice transcription failed',
        message: `${reason} The recording was discarded — voice input only fills the text box, nothing is saved.`,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    },
    // 录音根本没起来（无麦克风权限 / 非安全上下文 / 被预览框架拦住）：原来只 console.warn，
    // 界面上表现为「点了没反应」——这里必须把原因讲出来
    onStartError: (reason) => {
      void confirmAsk({
        title: 'Microphone unavailable',
        message: reason,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    },
  });

  // 监听从文件浏览器发送的附件（挂载时先消费事件缓冲，防止"发送到新建节点"时事件先于监听器注册而丢失）
  useEffect(() => {
    // 挂载时消费缓冲中属于本节点的附件
    const pendingMap = window.__pendingNodeAttachments;
    if (pendingMap?.[currentMdId]?.length) {
      const buffered = pendingMap[currentMdId];
      addAttachments(buffered);
      delete pendingMap[currentMdId];
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { node_id: string; attachment: MessageAttachment };
      if (detail?.node_id === currentMdId && detail?.attachment) {
        // 事件已到达则从缓冲移除，避免节点重挂载时重复添加
        if (pendingMap?.[currentMdId]) {
          pendingMap[currentMdId] = pendingMap[currentMdId].filter((a) => a.id !== detail.attachment.id);
          if (pendingMap[currentMdId].length === 0) delete pendingMap[currentMdId];
        }
        addAttachments([detail.attachment]);
      }
    };
    window.addEventListener('add-attachment-to-node', handler);
    return () => window.removeEventListener('add-attachment-to-node', handler);
  }, [currentMdId, addAttachments]);

  // 左侧导航圆点：每个 user 消息一个 ref，用于点击跳转 + 滚动联动高亮
  const userMsgRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [activeUserMsgId, setActiveUserMsgId] = useState<string | null>(null);
  /** 输入框根容器顶部中心位置 + 视觉外沿宽度：锚定确认/表单弹窗到输入框上方并保持等宽（无输入框时返回 null = 居中） */
  const inputAnchor = useCallback((): { x: number; y: number; w: number } | null => {
    const el = inputBoxRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top, w: r.width };
  }, []);
  /** Butler 确认卡片锚点：卡片到来时取一次输入框位置并固定，避免挂起期间画布平移/缩放导致卡片跳动 */
  const butlerAnchor = useMemo(
    () => (butlerConfirm ? inputAnchor() : null),
    [butlerConfirm, inputAnchor],
  );
  const mountedRef = useRef(true);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  // 新节点自动填充授权目录（只执行一次）
  const autoRootsAppliedRef = useRef(false);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);

  /** 节点标识：优先 nodeMdId，兜底 React Flow 节点 id */
  const agentNodeId = data.nodeMdId || id;

  /** 持久化节点级 MCP / 技能选择到 .md frontmatter（重启后恢复）；null 表示清除该字段（回归跟随全局），字段缺失表示保留现值 */
  const persistAgentState = async (patch: { enabledMcpIds?: string[] | null; selectedSkills?: string[] | null; quickPromptIds?: string[] | null; multiAgentMode?: boolean | null; teamIds?: string[] | null; teamMainModel?: string | null; teamWorkerModel?: string | null }) => {
    try {
      await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withProjectId({ action: 'update_agent_state', node_id: agentNodeId, ...patch })),
      });
    } catch (e) {
      console.error('Persist agent state error:', e);
    }
  };

  /** 切换 MCP 复选框（强制使用）：勾选 = 该节点无视场景/画像过滤恒定保留；与 skill 复选框语义一致 */
  const toggleMcpServer = (serverId: string) => {
    setEnabledMcpIds(prev => {
      const next = new Set(prev);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      // 持久化到节点 data，避免重挂载丢失
      setNodes((nds) =>
        nds.map((n) =>
          n.id === agentNodeId
            ? { ...n, data: { ...n.data, enabledMcpIds: Array.from(next) } }
            : n,
        ),
      );
      // 写盘到 .md frontmatter，重启后恢复
      persistAgentState({ enabledMcpIds: Array.from(next) });
      return next;
    });
  };

  /** 切换多智能体协作模式（Multi-agent mode）：开启后本轮主 agent 可编排多成员协作；
   *  与 MCP 勾选同构：更新 state + 节点 data + 写盘 frontmatter 三连 */
  const toggleMultiAgentMode = () => {
    const next = !multiAgentMode;
    setMultiAgentMode(next);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === agentNodeId
          ? { ...n, data: { ...n.data, multiAgentMode: next } }
          : n,
      ),
    );
    persistAgentState({ multiAgentMode: next });
  };

  /** 选择 Team 分栏两档模型（队长 / 成员）：与开关同构的 state + 节点 data + 写盘 frontmatter 三连。
   *  只写 frontmatter 的 team_main_model / team_worker_model，**不动节点 chat 模型** */
  const selectTeamModel = (tier: 'main' | 'worker', modelRef: string) => {
    if (!modelRef) return;
    if (tier === 'main') {
      setTeamMainModel(modelRef);
      setNodes((nds) =>
        nds.map((n) => (n.id === agentNodeId ? { ...n, data: { ...n.data, teamMainModel: modelRef } } : n)),
      );
      persistAgentState({ teamMainModel: modelRef });
      return;
    }
    setTeamWorkerModel(modelRef);
    setNodes((nds) =>
      nds.map((n) => (n.id === agentNodeId ? { ...n, data: { ...n.data, teamWorkerModel: modelRef } } : n)),
    );
    persistAgentState({ teamWorkerModel: modelRef });
  };

  /** 登记本节点产生的协作团队（team_run 每推一帧成员快照即携带 teamId）：
   *  幂等追加 + 节点 data + 写盘 frontmatter 三连，团队工作台据此列出「本会话产生过的团队」 */
  const rememberTeamId = useCallback((teamId: string) => {
    if (!teamId || teamIdsRef.current.includes(teamId)) return;
    const next = [...teamIdsRef.current, teamId];
    teamIdsRef.current = next;
    setTeamIds(next);
    setNodes((nds) =>
      nds.map((n) => (n.id === agentNodeId ? { ...n, data: { ...n.data, teamIds: next } } : n)),
    );
    void persistAgentState({ teamIds: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentNodeId]);

  /** 解绑本节点的一个协作团队记录（工作台「过往记录」的删除）：只从节点清单移除（不触碰引擎侧记录），
   *  幂等 + 节点 data + 写盘 frontmatter 三连；清空即回到工作台初始发起界面 */
  const forgetTeamId = useCallback((teamId: string) => {
    if (!teamId || !teamIdsRef.current.includes(teamId)) return;
    const next = teamIdsRef.current.filter((x) => x !== teamId);
    teamIdsRef.current = next;
    setTeamIds(next);
    setNodes((nds) =>
      nds.map((n) => (n.id === agentNodeId ? { ...n, data: { ...n.data, teamIds: next } } : n)),
    );
    void persistAgentState({ teamIds: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentNodeId]);

  /** 节点 MCP id → 显示名（store options 未就绪/含自定义时回退 id） */
  const mcpNameOf = useCallback(
    (id: string) => nodeMcpOptions.find((o) => o.id === id)?.name || id,
    [nodeMcpOptions],
  );

  /** 切换技能勾选，持久化到节点 data */
  const toggleSkill = (name: string) => {
    setSelectedSkills(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === agentNodeId
            ? { ...n, data: { ...n.data, selectedSkills: Array.from(next) } }
            : n,
        ),
      );
      // 写盘到 .md frontmatter，重启后恢复
      persistAgentState({ selectedSkills: Array.from(next) });
      return next;
    });
  };

  /** 点击指令：把内容填入输入框（追加到当前内容末尾），并聚焦输入框 */
  const applyQuickPrompt = (content: string) => {
    setLocalInput((cur) => {
      const text = cur ?? '';
      const sep = text && !text.endsWith('\n') ? '\n\n' : '';
      return text + sep + content;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /** 保存库内新建/编辑的快捷指令（写 settings.json 全局库） */
  const saveQuickPrompt = async () => {
    if (!quickPromptEditor) return;
    const { mode, id, name, content, category } = quickPromptEditor;
    if (!name.trim() || !content.trim()) return;
    const now = new Date().toISOString();
    let next: QuickPrompt[];
    if (mode === 'new') {
      const newPrompt: QuickPrompt = { id: 'qp-' + Date.now().toString(36), name: name.trim(), content: content.trim(), category: category.trim() || undefined, updatedAt: now };
      next = [...quickPrompts, newPrompt];
    } else {
      next = quickPrompts.map((q) => q.id === id ? { ...q, name: name.trim(), content: content.trim(), category: category.trim() || undefined, updatedAt: now } : q);
    }
    await updateQuickPrompts(next);
    setQuickPrompts(next);
    setQuickPromptEditor(null);
  };

  /** 删除库内快捷指令（全局库） */
  const deleteQuickPrompt = async (id: string) => {
    const next = quickPrompts.filter((q) => q.id !== id);
    await updateQuickPrompts(next);
    setQuickPrompts(next);
  };

  /** 将节点勾选状态写回为全局默认（全量覆盖：启用勾选的，禁用未勾选的） */
  const saveSkillsAsGlobalDefault = async () => {
    try {
      // 1. 获取当前全局已启用技能列表
      const res = await fetch('/api/skills');
      const data = await res.json();
      const skills: Array<{ name: string; enabled: boolean }> = data.skills || [];
      const globallyEnabled = new Set(
        skills.filter(s => s.enabled).map(s => s.name)
      );

      // 2. 计算差异：需要禁用的 + 需要启用的
      const selectedArr = Array.from(selectedSkills);
      const toDisable = [...globallyEnabled].filter((n: string) => !selectedArr.includes(n));
      const toEnable = selectedArr.filter((n: string) => !globallyEnabled.has(n));

      // 3. 批量更新（并行）
      const updates = [
        ...toEnable.map((name: string) =>
          fetch('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'enable', skillName: name }),
          })
        ),
        ...toDisable.map((name: string) =>
          fetch('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'disable', skillName: name }),
          })
        ),
      ];
      await Promise.all(updates);

      // 回归跟随全局：清除节点级技能勾选持久化
      setNodes((nds) =>
        nds.map((n) =>
          n.id === agentNodeId
            ? { ...n, data: { ...n.data, selectedSkills: undefined } }
            : n,
        ),
      );
      persistAgentState({ selectedSkills: null });
      window.dispatchEvent(new Event('skills-changed'));
    } catch (e) {
      console.error('Save skills global default error:', e);
    }
  };

  // 点击节点外部时关闭下拉菜单
  useEffect(() => {
    if (!modelMenuOpen && !thinkingMenuOpen && !skillMenuOpen && !quickPromptMenuOpen) return;
    const handler = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof globalThis.Node)) return;
      if (
        modelMenuRef.current?.contains(target) ||
        thinkingMenuRef.current?.contains(target) ||
        skillMenuRef.current?.contains(target) ||
        quickPromptMenuRef.current?.contains(target)
      ) return;
      setModelMenuOpen(false);
      setThinkingMenuOpen(false);
      setSkillMenuOpen(false);
      setQuickPromptMenuOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [modelMenuOpen, thinkingMenuOpen, skillMenuOpen, quickPromptMenuOpen]);

  // 模型下拉菜单打开时，捕获阶段拦截 wheel：双指滑动滚动模型列表时，
  // 不冒泡到 React Flow 的 panOnScroll，避免画布被拖拽
  useEffect(() => {
    const el = modelMenuRef.current;
    if (!el || !modelMenuOpen) return;
    const stopWheel = (e: WheelEvent) => {
      e.stopPropagation();
    };
    el.addEventListener('wheel', stopWheel, true);
    return () => el.removeEventListener('wheel', stopWheel, true);
  }, [modelMenuOpen]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // 加载可用技能列表
  useEffect(() => {
    const load = () => {
      fetch('/api/skills')
        .then(r => r.json())
        .then(d => {
          const list = (d.skills || []).filter((s: {source?: string; enabled?: boolean}) => s.source !== 'external' && s.enabled !== false);
          setAvailableSkills(list);
          // 清理已被全局禁用/删除的勾选技能，避免已禁用技能仍被 forcedSkills 强制注入；
          // 裁剪结果同步持久化，防止节点重挂载后孤儿技能名复活
          setSelectedSkills(prev => {
            const next = new Set(prev);
            let changed = false;
            for (const name of next) {
              if (!list.some((s: { name: string }) => s.name === name)) {
                next.delete(name);
                changed = true;
              }
            }
            if (changed) persistAgentState({ selectedSkills: Array.from(next) });
            return changed ? next : prev;
          });
        })
        .catch(() => {});
    };
    load();
    window.addEventListener('skills-changed', load);
    return () => window.removeEventListener('skills-changed', load);
  }, []);

  // Attach native wheel listener to stop propagation to React Flow's zoom handler.
  // React synthetic onWheel + stopPropagation cannot block React Flow's native listener.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.stopPropagation();
      // === 优化1：用户上滚时暂停自动滚动 ===
      // deltaY > 0: 向下滚动（滚到底部方向）；deltaY < 0: 向上滚动（远离底部）
      if (e.deltaY < 0 && isStreaming && pane === 'chat') {
        setAutoScrollPaused(true);
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, [isStreaming, pane]);

  // 大面板形态：在整个节点 wrapper 捕获阶段拦截所有 wheel 事件，
  // 避免滚动节点内容到顶/底后穿透到 ReactFlow 的 panOnScroll → 画布平移 → 节点"闪一下"。
  useEffect(() => {
    const wrap = nodeWrapperRef.current;
    if (!wrap) return;
    const onWheelCapture = (e: WheelEvent) => {
      // Ctrl/⌘ + wheel 仍是缩放画布，放行
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
    };
    wrap.addEventListener('wheel', onWheelCapture, { capture: true, passive: true });
    return () => wrap.removeEventListener('wheel', onWheelCapture, { capture: true });
  }, []);

  // ===== 左侧导航圆点：滚动 ↔ 高亮双向联动（滚动页面自动切圆点，点圆点跳转并高亮）=====
  const userMessages = useMemo(() => messages.filter((m) => m.role === 'user' && !m.system), [messages]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    // 基准线取"容器顶部 + 32px"（覆盖容器 py-3 内边距与首条消息的间距）：
    // 最后一条"顶边已越过基准线"的消息 = 当前占据视口顶部、正在阅读的那条。
    // 用 getBoundingClientRect 而非 offsetTop：不依赖 offsetParent，父级多包一层布局也不会失准。
    const computeActive = () => {
      raf = 0;
      // 程序化滚动（点击圆点跳转 / 自动跟底）期间跳过重算：跳转时已显式 setActiveUserMsgId，
      // 若此时用启发式重算，会因目标消息尚未落位而误判为相邻项，
      // 导致从后往前点选需点两次才能高亮正确（与画布链导航"点击即高亮"语义对齐）。
      if (programmaticScrollRef.current) return;
      const line = el.getBoundingClientRect().top + 32;
      let activeId: string | null = null;
      for (const m of userMessages) {
        const node = userMsgRefs.current.get(m.id);
        if (!node) continue;
        if (node.getBoundingClientRect().top <= line) activeId = m.id;
        else break; // 消息按文档顺序排列，顶边一旦超出基准线即可停止
      }
      // 无任何消息越过基准线（如首条上方有较高的欢迎/引导块）→ 兜底第一条，
      // 保证 scrollTop=0 时最上方圆点始终可高亮，不会"够不到"
      if (!activeId && userMessages.length > 0) {
        activeId = userMessages[0].id;
      }
      setActiveUserMsgId(activeId);
    };
    // rAF 节流：滚动高频触发时每帧最多重算一次
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(computeActive);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // 容器/窗口尺寸变化（窗口缩放、节点宽度动画）会移动消息位置，重新校准
    window.addEventListener('resize', onScroll);
    computeActive(); // 初始化
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [userMessages]);

  // 点击圆点 → 硬切定位到对应 user 消息（无动画）
  const scrollToUserMsg = useCallback((msgId: string) => {
    const node = userMsgRefs.current.get(msgId);
    const container = scrollRef.current;
    if (!node || !container) return;
    programmaticScrollRef.current = true;
    // 计算目标 scrollTop：节点 offsetTop - 容器 padding（8px 留白）
    const targetTop = node.offsetTop - 8;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
    setActiveUserMsgId(msgId);
    setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 100);
  }, []);

  // 同上：为 textarea 挂载原生 wheel 监听，确保输入框内双指滑动只滚动文本不触发画布 pan。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.stopPropagation();
    };
    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // === 优化1：自动滚动逻辑（支持暂停 + 未读计数） ===
  // 上次已滚动到的内容高度：仅当内容真实增高才重新滚动，避免仅 state 变更（如 toolCalls phase 更新）触发无意义微跳
  const lastAutoScrollHeightRef = useRef(0);
  // rAF 节流：流式期间 setMessages 高频触发，合并为每帧最多滚动一次
  const autoScrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    // 轨迹视图不自动跟随对话消息（避免 streaming 每次滚动把 Trace 列表拽到底）
    if (pane !== 'chat') return;
    const el = scrollRef.current;
    if (!el) return;

    const runScroll = () => {
      autoScrollRafRef.current = null;
      // 判断是否在底部（允许 40px 的容差）
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;

      if (!autoScrollPaused || atBottom) {
        // 内容未增高（如仅 toolCalls phase 更新）→ 不滚动，避免布局微跳
        if (el.scrollHeight === lastAutoScrollHeightRef.current) return;
        lastAutoScrollHeightRef.current = el.scrollHeight;
        // 非暂停状态，或当前已经在底部 → 滚动到底部
        programmaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
        // 更新"已读"标记
        lastReadCountRef.current = messages.length;
        setUnreadMsgCount(0);
        setAutoScrollPaused(false);
        // 下一帧恢复标记，避免短暂阻止用户 scroll 事件
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      } else {
        // 暂停中：累加未读消息数
        const unread = messages.length - lastReadCountRef.current;
        if (unread > 0) setUnreadMsgCount(unread);
      }
    };

    // 合并同一帧内的多次触发，仅执行一次滚动
    if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current);
    autoScrollRafRef.current = requestAnimationFrame(runScroll);
    return () => {
      if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    };
  }, [messages, autoScrollPaused, pane]);

  // 切回对话视图时立即滚到底部（重置上次高度记录，强制 autoscroll 生效一次）
  useEffect(() => {
    if (pane !== 'chat') return;
    const el = scrollRef.current;
    if (!el) return;
    lastAutoScrollHeightRef.current = 0;
    el.scrollTop = el.scrollHeight;
    lastReadCountRef.current = messages.length;
    setUnreadMsgCount(0);
    setAutoScrollPaused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane]);

  // 持久化开始：自动滚到底部，让保存提示出现在回复结尾处
  useEffect(() => {
    if (!persisting) return;
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [persisting]);

  // === 优化1：监听用户手动滚动，滚到底部时恢复自动滚动 ===
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      // 跳过代码触发的 scroll
      if (programmaticScrollRef.current) return;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (atBottom) {
        // 用户手动滚到底部 → 恢复自动滚动 + 清零未读
        lastReadCountRef.current = messages.length;
        setUnreadMsgCount(0);
        setAutoScrollPaused(false);
      }
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [messages.length]);

  // contentEditable 输入框高度自适应：由 minHeight/maxHeight + overflow 控制（无需 JS resize）

  /** 获取上游节点的索引表，注入到 system prompt 中供 AI 按需读取 */
  const fetchUpstreamContext = async (): Promise<string> => {
    const allEdges = getEdges();
    const allNodes = getNodes();

    // 找到所有连接到当前节点的活跃上游边（仅 child 关系参与上下文注入）
    const upstreamEdges = allEdges.filter(
      (e) => e.target === id && !e.data?.disconnected && e.data?.relation === 'child',
    );
    if (upstreamEdges.length === 0) return '';

    // 收集上游节点的 nodeMdId 和标题
    const upstreamItems: { mdId: string; title: string }[] = [];
    for (const edge of upstreamEdges) {
      const sourceNode = allNodes.find((n) => n.id === edge.source);
      if (!sourceNode) continue;
      const upstreamMdId = (sourceNode.data as AiChatNodeData).nodeMdId || sourceNode.id;
      const upstreamTitle = (sourceNode.data as AiChatNodeData).title || 'Untitled';
      upstreamItems.push({ mdId: upstreamMdId, title: upstreamTitle });
    }
    if (upstreamItems.length === 0) return '';

    // 通过 API 读取每个上游节点获取摘要
    const contents = await Promise.all(
      upstreamItems.map(async (item) => {
        try {
          const res = await fetch(`/api/nodes?id=${encodeURIComponent(item.mdId)}`);
          const data = await res.json();
          if (!data.success || !data.node) return { title: item.title, summary: '' };
          return { title: data.node.title || item.title, summary: data.node.summary || '' };
        } catch {
          return { title: item.title, summary: '' };
        }
      }),
    );

    // 构建索引表
    const rows = contents
      .filter((c) => c.title)
      .map((c, i) => `| ${i + 1} | **${c.title}** | ${c.summary || '(no summary)'} |`);
    const table = `| # | Node title | Summary |
|---|----------|------|
${rows.join('\n')}
`;

    const toolHint = `在处理用户请求前，请先调用 read_upstream_node 工具读取上游节点的完整内容（对话记录、批注等）。传入上方索引表中的**节点标题**或节点 ID。`;

    // 根据上游节点数量生成不同强度的读取指引
    let consolidateHint = '';
    if (contents.length >= 3) {
      consolidateHint = `\n\n**必须执行：** 你有 ${contents.length} 个上游节点。在处理任何用户请求之前，**必须**依次调用 read_upstream_node 读取**全部**上游节点的完整文档。不得遗漏任何上游节点。`;
    } else if (contents.length === 2) {
      consolidateHint = '\n\n**必须执行：** 使用 read_upstream_node 分别读取两个上游节点的完整内容，再基于原始内容回答。';
    } else {
      consolidateHint = '\n\n**必须执行：** 使用 read_upstream_node 读取上游节点的完整内容后再作答。上游节点内容是你理解用户意图的关键依据。';
    }

    const header = `\n\n## 上游节点索引（共 ${contents.length} 个上游节点）\n\n以下是与当前节点相连的上游节点概览。${consolidateHint}`;
    const footer = '\n\n## 回答原则\n以上是上游节点的摘要索引。用户的问题很可能与上游内容相关，请在必要时使用 read_upstream_node 工具读取完整文档。';

    return `${header}\n\n${table}\n${toolHint}${footer}`;
  };

  // 划词检测：在消息内容（data-msg-node 内）选中文字 → 弹出操作窗。
  // 多节点安全：仅选区起点所在消息的监听命中（其他节点 anchor 不在其消息内）。
  useEffect(() => {
    // mousedown 先于浏览器默认行为（清/改选区）执行：此刻读到的还是“旧选区”，
    // 用作 mouseup 判定“是不是这次手势新划出来的”的基线。
    const onMouseDown = () => {
      const sel = window.getSelection();
      preMouseSelRef.current = sel ? sel.toString() : '';
    };
    const onMouseUp = (e: MouseEvent) => {
      // 点击操作窗自身（按钮/空白）产生的 mouseup：直接吞掉，不再检测选区。
      // 先消费 mousedown 标记（覆盖 onClick 同步关窗、弹窗先被卸载导致 contains 失效的场景），
      // 再走 DOM contains 兜底（弹窗仍挂载时命中）。
      if (suppressNextMenuMouseUpRef.current) {
        suppressNextMenuMouseUpRef.current = false;
        return;
      }
      // 点击操作窗自身（复制/附件等按钮或空白）时忽略，避免按新坐标重定位导致弹窗漂移。
      // 注意：不能用 e.target instanceof Node —— 使用 globalThis.Node 规避与 DOM 全局的歧义，
      // 编译产物中若以值方式引用未定义名称会直接抛错，导致划词检测失效。
      const target = e.target as Element | null;
      if (target && selectionMenuRef.current?.contains(target)) return;
      // 等 selection 稳定再读取
      window.setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : '';
        if (!text) {
          setSelectionMenu(null);
          return;
        }
        const anchor = sel?.anchorNode?.parentElement;
        // 关键：必须校验选区属于【本实例】的消息区（scrollRef 内）。
        // 画布上每个 chat 类节点（chat/coding/Kar/Butler…）都在 window 挂了本监听，
        // 若只查 anchor.closest('[data-msg-node]')，任何实例都会命中"别处选区"的 data-msg-node，
        // 各自在同一坐标弹出自己的划词窗 → 重叠成一层；点某层"复制"变宽后，
        // 底下其它层的操作窗就露出来 = 用户看到的"两个弹窗"。
        if (
          !anchor ||
          !scrollRef.current?.contains(anchor) ||
          !anchor.closest('[data-msg-node]')
        ) {
          setSelectionMenu(null);
          return;
        }
        // 新划出的选区（文字与 mousedown 前快照不同）才弹窗；
        // 若与快照相同 = 点击弹窗外其它地方后残留的旧选区 → 收起弹窗（点击别处即消失，不重定位）
        if (preMouseSelRef.current === text) {
          setSelectionMenu(null);
          return;
        }
        // 新选区弹出操作窗：复制反馈复位为普通复制图标（清掉上一次的 ✓ 状态与复原计时）
        setCopied(false);
        if (copyTimerRef.current) {
          clearTimeout(copyTimerRef.current);
          copyTimerRef.current = null;
        }
        setSelectionMenu({ x: e.clientX, y: e.clientY, text });
      }, 0);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // 按钮 1：选中文字 → 在输入框上方挂引用标签（仅内存态，发送时以 `> 引用文字` 并入本轮消息）。
  // 标签形态与 md 编辑「发送到当前会话」一致：ai 图标 + 选中文字。
  // 不再落盘：旧实现会同时写一份 note-<时间戳>.txt 到 materials/，但该文件无任何回读路径，
  // 只会在账本原件层留下碎片、污染材料索引与 search_materials 结果，故移除。
  const handleQuoteSelection = useCallback((text: string) => {
    setSelectionMenu(null);
    clearDocSelection();
    if (!currentMdId || !text) return;
    setReferenceTag({ text });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [currentMdId, clearDocSelection]);

  // 粘贴 / 拖拽 / 待发附件移除：统一由 composer/useComposer 承载（chat 与 team 共用）

  // @ 弹窗数据源（materials 树 / 授权目录 / 导航 / 关闭 / 授权列表）：统一由 composer/useComposer 承载

  // 新节点（messages 空）自动把所有已授权目录填入操作目录工具栏（免发送，仅首次触发一次）
  useEffect(() => {
    if (autoRootsAppliedRef.current) return;
    if (messages.length > 0) {
      // 已有历史消息：说明不是全新节点，跳过自动填充，避免干扰
      autoRootsAppliedRef.current = true;
      return;
    }
    if (authorizedRoots.length === 0) return;
    autoRootsAppliedRef.current = true;
    setContextFolders(prev => {
      const existing = new Set(prev.filter(a => a.type === 'folder').map(a => a.path));
      const toAdd: MessageAttachment[] = [];
      for (const root of authorizedRoots) {
        if (existing.has(root)) continue;
        const name = root.split('/').filter(Boolean).pop() || root;
        toAdd.push({
          id: `auto-folder:${root}`,
          type: 'folder',
          name,
          path: root,
          mimeType: 'application/x-folder',
          size: 0,
        });
      }
      if (toAdd.length === 0) return prev;
      return [...prev, ...toAdd];
    });
  }, [authorizedRoots, messages.length]);

  // 锁定/解锁：成果块校验未通过时，由用户自主决定是否强制锁定
  const handleToggleOutcomeLock = useCallback(async () => {
    if (!data.nodeMdId) return;
    // 持久化/成果块提取进行中：此时锁定会锁到旧成果块，阻止并提示等待
    if (persistingRef.current) {
      alert('The node file is being written. Please wait a moment before locking.');
      return;
    }
    setOutcomeLoading(true);
    try {
      const action = outcomeStatus === 'locked' ? 'unlock' : 'lock';
      // R-7 动态上限：按节点当前模型 contextWindow × 10% 计算 max_length（后端未传时兜底 OUTCOME_MAX_LENGTH）
      const maxLen = outcomeMaxLengthForModel(modelId);
      const doLock = (force?: boolean) =>
        fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withProjectId({ action, node_id: data.nodeMdId, max_length: maxLen, ...(force ? { force: true } : {}) })),
        }).then((r) => r.json());
      const syncStatus = async () => {
        const dd = await fetch(`/api/nodes?id=${data.nodeMdId}${nodeProjectQuery}`).then((r) => r.json());
        if (dd.success && dd.node) {
          setOutcomeStatus(dd.node.outcome_status || null);
          setForceLocked(!!dd.node.outcome_force_locked);
          setOutcomeStaleReason(dd.node.outcome_stale_reason || null);
        }
      };
      let d = await doLock();
      if (!d.success && action === 'lock' && (d.errors?.length || String(d.error || '').includes('校验'))) {
        // 校验未通过：由用户自主决定是否强制锁定
        const force = await confirmAsk({
          title: 'Output block validation failed',
          message: `${d.error || ''}\n\nForce lock this node anyway? (Once locked, the output block stays unvalidated — downstream references are at your own risk.)`,
          confirmLabel: 'Force lock',
          cancelLabel: 'Cancel',
          anchor: inputAnchor(),
        });
        if (!force) {
          await syncStatus();
          return;
        }
        d = await doLock(true);
      }
      if (d.success) {
        setOutcomeStatus(action === 'lock' ? 'locked' : 'draft');
        setForceLocked(action === 'lock' ? !!d.force_locked : false);
        // 锁定时后端会懒生成成果块内容，通知打开的成果块面板刷新
        if (action === 'lock') {
          window.dispatchEvent(new CustomEvent('node-document-updated', { detail: { node_id: data.nodeMdId } }));
        }
      } else {
        alert(d.error || '操作失败');
        await syncStatus();
      }
    } catch {
      // 忽略网络错误
    } finally {
      setOutcomeLoading(false);
    }
  }, [data.nodeMdId, outcomeStatus, nodeProjectQuery, withProjectId, confirmAsk, modelId]);

  // 加载节点锁定状态 + 外部驱动刷新：
  // 连线/建子节点时 CanvasFlow 会先自动锁定上游（/api/nodes lock），锁定成功后广播
  // node-outcome-refresh 事件；本节点收到匹配自身的广播后重新拉取，让锁图标立即更新。
  useEffect(() => {
    if (!currentMdId) return;
    const refresh = () => {
      fetch(`/api/nodes?id=${currentMdId}${nodeProjectQuery}`)
        .then(r => r.json())
        .then(d => {
          if (d.success && d.node) {
            setOutcomeStatus(d.node.outcome_status || null);
            setForceLocked(!!d.node.outcome_force_locked);
            setOutcomeStaleReason(d.node.outcome_stale_reason || null);
          }
        })
        .catch(() => {});
    };
    refresh();
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent).detail as { node_id?: string };
      if (!detail?.node_id || detail.node_id !== currentMdId) return;
      refresh();
    };
    window.addEventListener('node-outcome-refresh', onRefresh);
    return () => {
      window.removeEventListener('node-outcome-refresh', onRefresh);
    };
  }, [currentMdId, nodeProjectQuery]);

  // @ 选择 / 输入框 chip 渲染 / 镜像 effect / onInput / 操作目录移除：统一由 composer/useComposer 承载

  const handleSend = () => {
    // contentEditable 输入框：以镜像文本为准（含 @文件名 标记，chip 引用由引用集合承载）
    const text = (localInput ?? '').trim();
    if (!text) return;
    // 执行中或压缩记忆中：输入框不锁定，可继续输入；点击发送弹「加入待办」确认。
    // 确认 → 入队，当前任务/压缩结束后自动发送；取消 → 文字回落保留在输入框。
    if (streamingRef.current || persistingRef.current) {
      confirmAsk({
        title: 'Add to queue',
        message: streamingRef.current
          ? 'A task is running. Queue this message to send automatically when it finishes?'
          : 'The previous reply is still being saved. Queue this message to send automatically when it finishes?',
        confirmLabel: 'Queue',
        cancelLabel: 'Cancel',
        anchor: inputAnchor(),
      }).then((ok) => {
        if (ok) {
          // 严格插队：新待办排到队首，当前任务结束后最先发送
          pendingSendRef.current.unshift(text);
          setPendingSendCount(pendingSendRef.current.length);
          setLocalInput('');
          clearNodeDraft();
        }
      });
      return;
    }
    setLocalInput('');
    clearNodeDraft();
    doSend(text);
  };

  const handleSendWithText = (text: string) => {
    sendTextRef.current = (t: string) => doSend(t);
    doSend(text);
  };

  /** 团队界面「发起协作」：需求文本走同一轮 /api/chat（本节点的既有链路），
   *  显式带上 multiAgent（不依赖 state 提交时序）；开关同步置为开启并落盘，
   *  之后停在团队视图看成员分工与协作过程，最终回答仍回落到对话流。
   *  ctx：团队输入框自己的附件/@引用上下文（该输入栏有独立的 composer 实例），
   *  随本轮透传给 doSend 顶替节点级 pending 状态 */
  const launchTeamRun = (text: string, ctx?: ComposerContext) => {
    const t = text.trim();
    if (!t) return;
    if (!multiAgentMode) toggleMultiAgentMode();
    setPane('team');
    void doSend(t, { multiAgent: true, composer: ctx });
  };

  /** 本轮多智能体成员名单：opts.presetAgentIds 优先——「选完即发起」在同一点击里 setState 尚未提交，
   *  只能由调用方直接告知本轮名单（同 opts.multiAgent 口径），否则本轮会丢掉刚勾选的成员 */
  const doSend = async (
    userInput: string,
    opts?: { continuation?: boolean; multiAgent?: boolean; presetAgentIds?: string[]; composer?: ComposerContext; attachments?: MessageAttachment[]; references?: MessageReference[] },
  ) => {
    const isContinuation = opts?.continuation === true;
    if ((!userInput && !isContinuation) || streamingRef.current || persistingRef.current) return;
    // 本轮引用上下文来源：团队输入栏发起时用其 composer 快照，其余情况沿用节点级输入栏
    // 重发/重试（Regenerate）会显式回传原轮快照（opts.attachments / opts.references），优先使用
    const turnAttachments = opts?.attachments ?? opts?.composer?.attachments ?? pendingAttachments;
    const turnMaterials = opts?.composer?.materials ?? pendingMaterials;
    const turnDirRefs = opts?.composer?.dirRefs ?? pendingDirRefs;
    const turnLinks = opts?.composer?.links ?? pendingLinks;
    const turnFolders = opts?.composer?.folders ?? contextFolders;
    // 新一轮消息发送：清空"等待授权"状态（授权自动继续的事件处理器会在授权完成时重新判断）
    pendingGrantTargetRef.current = null;
    // P5a-1 事件窗口 schema（旁路，行为不变）：每轮 doSend 开始时重置窗口
    traceWindowRef.current = createTraceWindow();
    // P5b-1 历史 replay：新一轮发送时退出回放态，回到 live 轨迹
    setReplay(null);
    // 已锁定则自动解锁，允许用户继续追问
    if (data.nodeMdId && outcomeStatus === 'locked') {
      setOutcomeStatus('draft');
      setForceLocked(false);
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withProjectId({ action: 'unlock', node_id: data.nodeMdId })),
      }).catch(() => {});
    }

    // 新一轮：清掉"当前流式全局"的阶段/确认/MCP等瞬态信息
    // （注意：Skills 已按 msgId 分桶，不能在这里粗暴清空！要等 assistantId 生成后，只清对应 msgId 桶）
    setCurrentStage(null);
    setHasDisconnectedUpstream(false);

    // 如果有引用标签，拼接到消息中
    let effectiveContent = userInput;
    // 气泡展示与落盘用的正文：剥离已由 chip 承载的 @文件名 标记（避免正文与 chip 重复）；
    // 送给模型的 effectiveContent 不受影响（下方 --- 资料列表 --- 块已含完整路径）
    let displayContent = userInput;
    if (!isContinuation && referenceTag) {
      effectiveContent = `> ${referenceTag.text}\n\n${userInput}`;
      setReferenceTag(null); // 发送后清除引用标签
    }

    // 模型选择器已下线 Auto：节点始终持有具体模型（旧节点的空值由节点内迁移 effect 落成），
    // 这里不再做客户端选路；极端情况（模型列表尚未就绪）留空交由服务端兜底解析。
    const currentModelId = modelId;
    // 本轮服务端实际使用的模型（done 帧回传，provider:modelId）：服务端可能因「带图改选视觉模型」
    // 而与节点所选不同，落盘时以实际为准，避免消息标签误导。
    let servedModelId = currentModelId;
    // 本轮实际思考等级：直接采用节点当前设置（不再由模型/任务推断）
    const actualThinkingLevel: ThinkingLevel = thinkingLevel;

    // 续写模式：复用已有的（合并了补充信息的）用户消息，不创建新 userMsg
    const now = new Date();
    let userMsg: ChatMessage;
    const materialFileMap: Record<string, MaterialItem> = {};

    if (isContinuation) {
      // 续写模式：最后一条用户消息是补充内容（独立消息，不合并到原始问题）
      const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !m.system);
      if (!lastUser) {
        console.warn('[doSend:continuation] 未找到用户消息，回退普通发送');
        return;
      }
      userMsg = lastUser;
      // effectiveContent 合并原始问题 + 补充信息（用于请求与持久化，UI 中保持独立消息）
      const ctx = continuationContextRef.current;
      if (ctx) {
        effectiveContent = ctx.originalUserContent + '\n\n--- 补充信息 ---\n' + ctx.supplementText + '\n--- 补充信息结束 ---';
      } else {
        effectiveContent = lastUser.content;
      }
    } else {
      // @引用 快照：与下方拼给 AI 的正文块同源，用于气泡 chip 展示 + 落盘（<!-- REFERENCES: -->）
      // 重发/重试时沿用原轮快照（opts.references），否则按本轮输入栏上下文重新组装
      const turnReferences = opts?.references ?? buildTurnReferences(turnMaterials, turnDirRefs, turnLinks, turnFolders);
      displayContent = stripReferenceMarkers(userInput, turnReferences);
      userMsg = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: displayContent,
        attachments: turnAttachments.length > 0 ? [...turnAttachments] : undefined,
        references: turnReferences.length > 0 ? turnReferences : undefined,
        timestamp: now.toISOString(),
      };

      // 使用本轮资料引用构建材料引用表
      for (const mat of turnMaterials) {
        materialFileMap[mat.path] = mat;
      }

      // 构建带资料引用的消息内容（发送给 AI 时使用）
      if (turnMaterials.length > 0) {
        const materialInfo = turnMaterials.map((file, i) => {
          return `  ${i + 1}. ${file.name} (${file.type}, ${formatFileSize(file.size)})\n     路径: ${file.path}`;
        }).join('\n');
        effectiveContent += `\n\n--- 资料列表 ---\n${materialInfo}\n--- 资料列表结束 ---\n\n如需了解资料内容，请使用 read_attachment 工具读取（路径已在列表中给出，勿向用户索要）。`;
      }

      // 引用授权目录中的文件：提示 AI 用文件工具读取
      if (turnDirRefs.length > 0) {
        const dirInfo = turnDirRefs.map((ref, i) => {
          return `  ${i + 1}. ${ref.name}${ref.size ? ` (${ref.size})` : ''}\n     路径: ${ref.path}`;
        }).join('\n');
        effectiveContent += `\n\n--- 引用本地文件 ---\n${dirInfo}\n以上为本地文件引用（来源：@ 引用或用户粘贴路径）。如需了解文件内容，请使用 read_file 工具读取完整绝对路径；若目录未授权，请先按 AUTH_REQ 流程请求授权。`;
      }

      // 链接材料：粘贴 URL 自动识别，提示 AI 用 web_fetch 访问
      if (turnLinks.length > 0) {
        const linkInfo = turnLinks.map((l, i) => `  ${i + 1}. ${l.url}`).join('\n');
        effectiveContent += `\n\n--- 链接材料 ---\n${linkInfo}\n请使用 web_fetch 工具依次访问以上链接获取网页内容，并结合链接内容回答用户问题。`;
      }

      // 操作目录（授权目录/子文件夹发送到节点）：提示 AI 在指定目录内完成读写操作
      if (turnFolders.length > 0) {
        // 用户从文件面板一键发送的子文件夹 = 锁定操作范围
        const hasUserLocked = turnFolders.some((f) => f.id.startsWith('sent-folder:'));
        const folderInfo = turnFolders.map((folder) => {
          const isUserLocked = folder.id.startsWith('sent-folder:');
          return `- ${folder.name}${isUserLocked ? '（用户指定·锁定操作范围）' : ''}\n  路径: ${folder.path}`;
        }).join('\n');
        effectiveContent +=
          `\n\n--- 操作目录 ---\n${folderInfo}\n` +
          (hasUserLocked
            ? `以上目录中带「用户指定·锁定操作范围」标记的目录，是用户指定的本次操作范围：请将文件读写操作严格集中在该目录内（使用完整绝对路径），不得越出该目录；其余目录为默认授权目录。\n`
            : `以上目录已授权给 AI，可读可写。请使用 list_directory / read_file / write_file 等文件工具在该目录内完成用户要求的操作（路径使用完整绝对路径）。\n`) +
          `--- 操作目录结束 ---`;
      }
    }

    // 环境上下文（Hippo 侧边栏的当前页 URL/标题）：每轮自动前置，随页面切换跟随。
    // 放在引用标签/资料引用拼接之后，避免被后续赋值覆盖；只进模型侧的 effectiveContent，
    // 气泡正文与落盘用 displayContent，因此不会污染用户消息（见 questionForPersist）。
    if (ambientContext && ambientContext.trim()) {
      effectiveContent = `${ambientContext.trim()}\n\n${effectiveContent}`;
    }

    const assistantId = `msg-${Date.now() + 1}`;
    // P2 轨迹：本轮任务的轨迹日志 id（done 事件下发，供持久化 + 后续日志恢复）
    let taskIdForTurn: string | null = null;
    // ============================================================
    // 仅清空本次 assistantId 对应的桶：历史消息的 Skills/耗时全部保留，不被新任务覆盖
    // ============================================================
    setMatchedSkillsByMsg((prev) => ({ ...prev, [assistantId]: [] }));
    setSkillDetailsByMsg((prev) => ({ ...prev, [assistantId]: [] }));
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      // 记录本轮实际使用的模型与思考等级（auto 模式每轮可能不同），供消息尾部标签展示与持久化
      modelId: currentModelId,
      thinkingLevel: actualThinkingLevel,
    };

    // 系统消息（压缩提示等）仅前端展示，不参与模型输入
    // 续写模式：不追加新 userMsg（用户消息已在 messages 中，含合并的补充信息）
    const baseMessages = isContinuation
      ? [...messages.filter((m) => !m.system)]
      : [...messages.filter((m) => !m.system), userMsg];
    const newMessages = [...baseMessages, assistantMsg];
    setMessages(newMessages);
    setStreamingMsgId(assistantId);
    setLocalInput('');
    clearNodeDraft();
    // 团队输入栏发起时不重置节点输入栏的引用（本轮用的是团队 composer 快照，节点侧待发内容应保留）
    if (!opts?.composer) composer.reset();
    setIsStreaming(true);
    streamingRef.current = true; // 同步执行标志到 ref，供输入框/发送按钮同步判断
    // 新任务开始：重置 AI Coding 循环状态（等待本轮工具调用重新驱动）
    setCodingPhase('idle');

    // 获取上游节点上下文（摘要索引表）。缓存稳定化：不再拼入 system——上游节点更新会改
    // system 字节 → 缓存头整段失效（作废所有下游节点请求的前缀缓存）。
    // 改为 prepend 到当前轮最后一条 user 消息：system 只含字节稳定的 SYSTEM_PROMPT，
    // 上游更新只影响当前轮（必 miss 段），不破坏缓存头。
    const upstreamContext = await fetchUpstreamContext();
    const systemContent = SYSTEM_PROMPT;
    console.log('[上下文注入] 节点:', currentMdId, '上游上下文长度:', upstreamContext.length);

    // 构建发送给 AI 的 API 消息序列
    let apiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    // 续写请求携带的初始产物（模板填充面板生成的文件等），服务端补进本轮 output_files 卡片
    let initialOutputFiles: OutputFileItem[] | undefined;

    if (isContinuation && continuationContextRef.current) {
      // 续写模式：API 收到完整 Q&A 上下文（原始用户消息 → AI 提问 → 用户补充）
      // AI 知道自己之前问了什么，不会重复提问，直接基于补充信息继续完成任务
      const ctx = continuationContextRef.current;
      // 模板填充产物等初始产物：随续写请求透传给服务端，补进本轮 output_files 卡片
      initialOutputFiles = ctx.initialOutputFiles;
      continuationContextRef.current = null;
      apiMessages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: ctx.originalUserContent },
        { role: 'assistant', content: ctx.originalAssistantContent },
        { role: 'user', content: `用户已根据你的提问补充了以下信息，请直接完成任务，不要重复提问：\n${ctx.supplementText}` },
      ];
    } else {
      // 预压缩（让 R-25 增量压缩在运行时真正生效）：已压缩的历史轮次不再全量发送，
      // 只发游标之后的新增对话。被跳过的内容由 system 中注入的「压缩记忆 + 成果块」兜底，
      // 模型仍可通过 intern_search / read_manifest 按需检索原文（成果块=索引，可顺藤摸瓜）。
      const compactedSkip = Math.min(
        compactedUntilRef.current * 2, // 每轮 = user + assistant 两条消息
        Math.max(0, baseMessages.length - 1), // 至少保留当前 user 消息
      );
      // 构建带附件元信息的消息（AI 可通过 read_attachment 工具自主读取附件内容
      const apiMessagesWithAttachments = baseMessages.slice(compactedSkip).map((m) => {
        // 对于最后一条用户消息，使用包含材料引用的 effectiveContent
        let msgContent = m.id === userMsg.id && effectiveContent !== m.content
          ? effectiveContent
          : m.content;

        // ⭐ 关键：将独立存储的 reasoning 用 <think> 标签包裹后再提交给模型。
        // 历史对话加载时，answer 被 stripThink 剥离了 think 标签，reasoning 独立存于
        // msg.reasoning 字段。若不在这里回填，模型就看不到自己之前的思考，
        // 多轮后会逐渐"丢失包标签习惯"，出现"思考过程没有被 think 标签包裹"的偶发现象。
        if (m.role === 'assistant' && m.reasoning && m.reasoning.trim().length > 0) {
          if (!/(^\s*<think[\s>])|<think>/i.test(msgContent)) {
            msgContent = `<think>${m.reasoning}</think>\n` + msgContent;
          }
        }

        if (!m.attachments || m.attachments.length === 0) {
          return { role: m.role, content: msgContent };
        }

        // 文件夹引用（授权目录）单独注入为"操作目录"块；文件附件走 read_attachment
        const fileAtts = m.attachments.filter((att) => att.type !== 'folder');
        const folderAtts = m.attachments.filter((att) => att.type === 'folder');

        let serialized = msgContent;

        if (folderAtts.length > 0) {
          const folderInfo = folderAtts.map((att) => `- ${att.name}\n  路径: ${att.path}`).join('\n');
          serialized +=
            `\n\n--- 操作目录 ---\n${folderInfo}\n` +
            `以上目录已授权给 AI，可读可写。请使用 list_directory / read_file / write_file 等文件工具在该目录内完成用户要求的操作（路径使用完整绝对路径）。\n` +
            `--- 操作目录结束 ---`;
        }

        if (fileAtts.length > 0) {
          const attachmentInfo = fileAtts.map((att, i) => {
            return `  ${i + 1}. ${att.name} (${att.type === 'text' ? 'Text' : att.type === 'image' ? 'Image' : 'File'}, ${formatFileSize(att.size)})\n     路径: ${att.path}`;
          }).join('\n');
          serialized += `\n\n--- 资料列表 ---\n${attachmentInfo}\n--- 资料列表结束 ---\n\n如需了解资料内容，请使用 read_attachment 工具读取（路径已在列表中给出，勿向用户索要）。`;
        }

        return { role: m.role, content: serialized };
      });

      apiMessages = [
        { role: 'system' as const, content: systemContent },
        ...apiMessagesWithAttachments,
      ];
    }

    // 上游摘要索引表 prepend 到当前轮最后一条 user 消息（与技能上下文/思考指令同策略：
    // system 字节保持稳定 → 前缀缓存头不失效；上游更新只落在当前轮必 miss 段）
    if (upstreamContext) {
      const lastIdx = apiMessages.length - 1;
      const last = apiMessages[lastIdx];
      if (last && last.role === 'user') {
        apiMessages[lastIdx] = { ...last, content: upstreamContext + '\n\n' + last.content };
      }
    }

    const selectedModel = availableModels.find((m) => m.modelId === currentModelId) ?? availableModels[0];
    const custom = isCustomModel(selectedModel.modelId);

    const controller = new AbortController();
    abortRef.current = controller;
    truncatedRef.current = false; // 重置输出触顶标记（每轮独立）
    // 90 秒「空闲」超时保护：SSE 流持续有数据则每次重置计时器，仅当连续 90s 无任何数据（请求真正挂起）才中断。
    // 此前为固定总时长 90s，慢推理/长工具链（每步都有 tool_call/result 事件输出）累计超时会误杀——
    // 出现"后端仍在执行，前端却已超时"的虚假超时。空闲语义下只要流在走就不会断。
    let abortedByTimeout = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        abortedByTimeout = true;
        controller.abort();
      }, 90000);
    };
    armTimeout(); // 请求发出前武装：防 fetch 首字节长期无响应

    let assistantContent = '';
    let reasoningContent = '';
    const toolCallRecords: ToolCallRecord[] = [];
    const outputFileItems: OutputFileItem[] = [];
    // 多智能体协作进度：本轮 team_run 编排的成员分支快照（subagent_update 逐帧覆盖；
    // 用局部变量而非 state，保证流末收口读到的是最新值——同 toolCallRecords 范式）
    let subagentPanel: SubagentPanel | null = null;
    // 协作「群聊流」时间线（subagent_events 增量累积）：只活在本次流式过程与会话内存里，不落盘
    const subagentEventList: TeamChatEvent[] = [];

    const requestBody: Record<string, unknown> = {
      messages: apiMessages,
      nodeId: currentMdId,
      // 节点身份（chat | coding）：服务端据此按场景过滤工具集（coding 节点剔除
      // legal/core/ocr/audio/skill 专属工具，避免每次全量注入无关注入）
      identity,
      modelId: custom ? undefined : selectedModel.modelId,
      thinking: selectedModel.thinking ? 'enabled' : 'disabled',
      temperature: selectedModel.temperature,
      thinkingLevel,
    };

    // 续写轮携带的初始产物（模板填充生成的文件）：服务端据此补发 output_files 事件
    if (initialOutputFiles && initialOutputFiles.length > 0) {
      requestBody.initialOutputFiles = initialOutputFiles;
    }

    // 投影窗口（临时节点）显式传 projectId，使其写入 hidden 的 temporary 项目而非当前项目
    if (data.projectId) {
      requestBody.projectId = data.projectId;
    }

    // Research 开关（Hippo 侧边栏）：开启才发送，服务端据此在浏览器操作纪律之外再叠一层调研纪律
    if (researchMode) {
      requestBody.researchMode = true;
    }

    if (selectedSkills.size > 0) {
      requestBody.forcedSkills = Array.from(selectedSkills);
    }

    // MCP 强制使用列表：勾选才发送（与 skill 一致）；缺省 = 服务端按 Store 全局 enabled + 场景门控自动注入
    if (enabledMcpIds.size > 0) {
      requestBody.enabledMcpIds = Array.from(enabledMcpIds);
    }

    // 多智能体协作模式：开启才发送（缺省 = 关闭）；服务端据此激活 team 场景并注入编排规则。
    // opts.multiAgent：团队界面「发起协作」显式带上的本轮开关——同一次点击里 state 尚未提交，
    // 只能由调用方直接告知本轮是多智能体（见 launchTeamRun）
    if (multiAgentMode || opts?.multiAgent === true) {
      requestBody.multiAgentMode = true;
      // 本次执行的成员名单（弹窗选定的已安装 agent id）：不落盘、仅本轮生效；
      // 服务端据此优先编排名单内成员，并对名单外补充成员强制弹卡请用户批准
      const ids = opts?.presetAgentIds ?? presetAgentIds;
      if (ids.length > 0) {
        requestBody.presetAgentIds = ids;
      }
      // Team 分栏两档模型：队长（规划 + 复核/整合）与成员（一刀切）各跑一档；服务端交给队长会话与成员会话
      if (resolvedTeamMainModel) requestBody.teamMainModel = resolvedTeamMainModel;
      if (resolvedTeamWorkerModel) requestBody.teamWorkerModel = resolvedTeamWorkerModel;
    }

    if (custom) {
      const parsed = parseCustomModel(selectedModel.modelId);
      if (parsed) {
        const preset = getProviderPreset(parsed.provider);
        const providerConfig = providerConfigs.find((c) => c.type === parsed.provider);
        if (preset && providerConfig) {
          requestBody.apiKey = providerConfig.apiKey;
          requestBody.baseUrl = providerConfig.baseUrl?.trim() || preset.baseUrl;
          requestBody.providerModelId = parsed.modelId;
          // R-14-C：随 /api/chat 请求透传压缩模型配置（节点自定义模型正在用它）——
          // 服务端长会话折叠/裁剪压缩复用同一 Key，不必再回退 settings；与 append 侧
          // compact_model_config（L4424 同源同字段：providerConfigs + preset.baseUrl）
          if (providerConfig.apiKey) {
            requestBody.compact_model_config = {
              apiKey: providerConfig.apiKey,
              baseURL: providerConfig.baseUrl?.trim() || preset.baseUrl,
              model: parsed.modelId,
            };
          }
        }
      }
    }

    // ============================================================
    // 首轮智能命名（小模型）：用户发出首条消息后，异步调用专用小模型端点
    // （/api/nodes/suggest-title，内部走 resolveTaskModel 的小模型角色）生成简短标题并落盘。
    // 主模型不参与命名（系统提示词已移除 <!-- TITLE --> 注释约定），避免被长规则压掉。
    // 触发条件：非续写 + 标题仍为默认占位 + 节点文件已存在 + 首条对话（无历史 user 消息）。
    // 不 await：命名与主对话并行，不拖慢回答首字延迟；小模型失败时回退规则标题。
    // ============================================================
    if (
      !isContinuation
      && data.title === 'AI Chat'
      && typeof data.nodeMdId === 'string'
      && !messages.some((m) => !m.system && m.role === 'user')
      && userInput.trim()
    ) {
      const nodeIdForNaming = currentMdId;
      void (async () => {
        let nextTitle = '';
        try {
          const titleResp = await fetch('/api/nodes/suggest-title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: userInput }),
          });
          const titleData = await titleResp.json();
          if (titleData?.success && typeof titleData.title === 'string') {
            nextTitle = titleData.title.trim();
          }
        } catch {
          // 小模型不可用 → 走下方规则标题兜底
        }
        if (!nextTitle) nextTitle = deriveInstantTitle(userInput);
        if (!nextTitle || !nodeIdForNaming) return;
        try {
          const renameResp = await fetch('/api/nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withProjectId({
              action: 'rename_title',
              node_id: nodeIdForNaming,
              new_title: nextTitle,
            })),
          });
          const renameData = await renameResp.json();
          if (renameData.success && renameData.title && mountedRef.current) {
            setNodes((nds) =>
              nds.map((n) =>
                n.id === id
                  ? { ...n, data: { ...n.data, title: renameData.title } }
                  : n,
              ),
            );
          }
        } catch {
          // 命名失败不影响主流程：标题保持占位
        }
      })();
    }

    try {
      // fetchWithServerRecovery：网络层失败（Failed to fetch）时探活等待本地服务
      // 恢复后重发一次，避免长时间闲置后一次性连接失败直接报错
      const response = await fetchWithServerRecovery('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      mainLoop: for (;;) {
        const { done, value } = await reader.read();
        armTimeout(); // 空闲超时：只要有数据到达就重置 90s 计时器（reader.read() 阻塞期间若流中断，超时正常触发）
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              // P5a-1 事件窗口 schema（渲染未切换，行为不变）：SSE 帧归一后喂旁路窗口。
              // 旁路只写不读；任何异常静默忽略，绝不阻断主流程 / 影响现有渲染
              if (traceWindowRef.current) {
                try {
                  const winEv = normalizeSseFrame(parsed);
                  if (winEv) traceWindowRef.current = pushWindowFrame(traceWindowRef.current, winEv);
                } catch { /* P5a-1 旁路异常：安全忽略 */ }
              }
              // ② SSE 首条：skills / MCP 概览（含 forcedSkills 区分强制 vs 自动）——写入当前 assistantId 桶
              if (parsed.matchedSkills) {
                if (mountedRef.current) {
                  setMatchedSkillsByMsg((prev) => ({ ...prev, [assistantId]: parsed.matchedSkills as string[] }));
                  if (Array.isArray(parsed.skillDetails)) {
                    setSkillDetailsByMsg((prev) => ({ ...prev, [assistantId]: parsed.skillDetails as SkillDetail[] }));
                  }
                }
              }
              if (parsed.context_meter) {
                // dsh ContextMeter：任务开始/done 时下发的上下文占用 → composer 圆环
                if (mountedRef.current) {
                  setComposerCtxMeter(parsed.context_meter as CtxMeterInfo);
                  // 缓存头指纹（pi-reasonix）：与上一个任务对比，变化即前缀缓存必然失效（归因诊断）
                  if (typeof parsed.prefixHash === 'string' && parsed.prefixHash) {
                    const prevHash = lastPrefixHashRef.current;
                    if (prevHash && prevHash !== parsed.prefixHash) {
                      setPrefixChangedByMsg((p) => ({ ...p, [assistantId]: true }));
                    }
                    lastPrefixHashRef.current = parsed.prefixHash;
                    setPrefixHashByMsg((p) => ({ ...p, [assistantId]: parsed.prefixHash }));
                  }
                  applyPrefixSegments(assistantId, parsed.prefixSegments as Record<string, unknown> | undefined);
                }
              }
              if (parsed.reasoning) {
                reasoningContent += parsed.reasoning;
                if (mountedRef.current) {
                  setCurrentStage('thinking');
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, reasoning: reasoningContent }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.content_truncated) {
                // 输出触顶（finish_reason=length）：标记，流式结束后在回复末尾追加提示
                truncatedRef.current = true;
              }
              if (parsed.content) {
                assistantContent += parsed.content;
                if (mountedRef.current) {
                  setCurrentStage('writing');
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: assistantContent, reasoning: reasoningContent, toolCalls: toolCallRecords.length > 0 ? [...toolCallRecords] : undefined }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.tool_call) {
                const tc = parsed.tool_call as { name: string; arguments: Record<string, unknown>; phase?: 'pending' | 'running' | 'done' | 'error'; spanId?: string; startAt?: number; purpose?: string };
                // 去双轨（Trae 式）：正文 = 全部流式文本直出，不再把 tool_call 前的文字剥离进
                // processNarration（该机制曾导致"模型先写结论再落盘"时交付物被吞、节点只剩 OutputFile 行）。
                // 步骤卡片只从真实 toolCalls 派生，不参与正文文本。
                toolCallRecords.push({
                  toolName: tc.name,
                  arguments: tc.arguments,
                  result: '...',
                  durationMs: 0,
                  success: true,
                  phase: tc.phase ?? 'pending',
                  spanId: tc.spanId,
                  startAt: tc.startAt,
                  purpose: tc.purpose,
                });
                if (mountedRef.current) {
                  setCurrentStage({ kind: 'tool', name: tc.name });
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: assistantContent, reasoning: reasoningContent, toolCalls: [...toolCallRecords] }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.tool_confirm) {
                // 需手动确认名单：弹确认框，结果回传服务端恢复挂起的工具执行
                const cf = parsed.tool_confirm as {
                  confirmId: string;
                  name: string;
                  arguments?: Record<string, unknown>;
                  timeoutSec?: number;
                };
                void (async () => {
                  const raw = cf.arguments ? JSON.stringify(cf.arguments, null, 2) : '{}';
                  const paramText = raw.length > 600 ? `${raw.slice(0, 600)}\n…(truncated)` : raw;
                  // 提醒用户：桌面通知（Electron IPC / web 浏览器 Notification）+ 本节点呼吸灯
                  setConfirmPending(true);
                  notifyToolConfirm(cf.name, cf.timeoutSec);
                  const approved = await confirmAsk({
                    title: `Tool "${cf.name}" needs confirmation`,
                    message: `This tool is on the manual-confirm list and will only run after you approve it (auto-skipped without execution if no action within ${Math.ceil((cf.timeoutSec ?? 600) / 60)} min).\n\nParams:\n${paramText}`,
                    confirmLabel: 'Allow',
                    cancelLabel: 'Deny',
                    anchor: inputAnchor(),
                  }).catch(() => false);
                  try {
                    await fetch('/api/chat/confirm', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ confirmId: cf.confirmId, approved }),
                    });
                  } catch {
                    /* 回传失败：服务端超时按拒绝处理 */
                  }
                  setConfirmPending(false);
                })();
              }
              if (parsed.team_confirm) {
                // 多智能体协作人类审批门禁：宿主已把团队规划成草案（成员清单 + 任务 DAG），
                // 用户批准后才 approve & run；拒绝或超时则草案作废，不创建任何成员/任务。
                const tc = parsed.team_confirm as {
                  confirmId: string;
                  /** 团队 id：建队即绑定到本节点，用户刷新页面后团队面板仍能认领（不必等 approve 后的推帧） */
                  teamId?: string;
                  goal?: string;
                  members?: Array<{ name?: string; role?: string; identity?: string }>;
                  tasks?: Array<{ subject?: string; assignee?: string; dependencies?: string[] }>;
                  timeoutSec?: number;
                  /** 名单外补充成员的名字：非空即表示本次是「AI 判断已选成员不够 → 推荐补充」触发的审批 */
                  extraMemberNames?: string[];
                  /** 用户名单里被弃用（AI 最终方案未指派任务）的成员名字：非空即表示名单被改动过 */
                  droppedMemberNames?: string[];
                };
                // 建队即绑定：团队此刻已存在于引擎（planning 态），把它登记到本节点，
                // 这样即使用户在批准前刷新页面，团队工作台依然能列出该团队
                if (tc.teamId) rememberTeamId(tc.teamId);
                void (async () => {
                  const memberLines = (tc.members ?? [])
                    .map(
                      (m) =>
                        `· ${m.name || '(unnamed)'}${m.role ? ` — ${m.role}` : ''}` +
                        `${m.identity ? `  [agent: ${m.identity}]` : ''}`,
                    )
                    .join('\n');
                  const dag = (tc.tasks ?? [])
                    .map(
                      (t, i) =>
                        `${i + 1}. ${t.subject || '(unnamed task)'}` +
                        `${t.assignee ? ` → ${t.assignee}` : ''}` +
                        `${t.dependencies && t.dependencies.length > 0 ? `  (after: ${t.dependencies.join(', ')})` : ''}`,
                    )
                    .join('\n');
                  const mins = Math.ceil((tc.timeoutSec ?? 600) / 60);
                  const extras = tc.extraMemberNames ?? [];
                  // AI 改动了用户选定的名单：补充成员（extras）与弃用你选的成员（dropped）都要逐条点名，
                  // 否则用户会以为名单被原样采纳（名单是软约束，AI 允许只用一部分，但改动必须可见）
                  const dropped = tc.droppedMemberNames ?? [];
                  // 完整计划里最占篇幅的「成员 + 任务 DAG」：一律折叠进 details，主文案只留概述
                  const plan =
                    `Members (${(tc.members ?? []).length}):\n${memberLines || '(none)'}\n\n` +
                    `Tasks (${(tc.tasks ?? []).length}):\n${dag || '(none)'}`;
                  const timeoutNote = `If no action is taken within ${mins} min, the plan is discarded without creating any member or task.`;
                  // 提醒用户：桌面通知（Electron IPC / web 浏览器 Notification）+ 本节点呼吸灯
                  setConfirmPending(true);
                  notifyToolConfirm('team_run', tc.timeoutSec);
                  const approved = await confirmAsk({
                    title:
                      dropped.length > 0
                        ? 'Approve member changes?'
                        : extras.length > 0
                          ? 'Approve extra members?'
                          : 'Approve multi-agent plan?',
                    // 名单改动逐条点名：弃用（-）与补充（+）都列出来，用户一眼看清动的是谁；
                    // 无改动时（普通计划卡）只留目标与规模概述。
                    // 成员清单与任务 DAG 一律折叠（点 View details 可查），避免卡片高过视口。
                    message:
                      dropped.length > 0
                        ? `The main agent changed the members you picked:\n` +
                          dropped.map((n) => `- dropped: ${n}`).join('\n') +
                          (extras.length > 0 ? `\n${extras.map((n) => `+ added: ${n}`).join('\n')}` : '') +
                          `\n\nApprove to run this lineup. ${timeoutNote}`
                        : extras.length > 0
                          ? `The main agent found the members you picked insufficient and suggests adding:\n` +
                            extras.map((n) => `+ ${n}`).join('\n') +
                            `\n\nThey run only if you approve. ${timeoutNote}`
                          : `A multi-agent team will be created and run only after you approve.\n\n` +
                            `Goal: ${tc.goal || '(none)'}\n\n` +
                            `Members: ${(tc.members ?? []).length} · Tasks: ${(tc.tasks ?? []).length}\n\n` +
                            timeoutNote,
                    details: plan,
                    confirmLabel: 'Approve & Run',
                    cancelLabel: 'Discard',
                    anchor: inputAnchor(),
                  }).catch(() => false);
                  // 未批准（Discard，或卡片超时自动作废）→ 方案作废：右侧步骤面板收口为 DISCARDED
                  if (!approved) setTeamPlanDiscarded(true);
                  try {
                    const res = await fetch('/api/chat/confirm', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ confirmId: tc.confirmId, approved }),
                    });
                    // 409 = 该审批挂起项已失效（超时收口 / 本轮已断开 / 卡片来自上一次会话）：
                    // 本次点击没生效，必须把计划收口为作废并留痕 —— 否则用户以为「已批准」，
                    // 而服务端根本没收门禁，团队永远停在 planning，面板一直空着。
                    if (!res.ok) {
                      const body = (await res.json().catch(() => null)) as { error?: string } | null;
                      setTeamPlanDiscarded(true);
                      console.warn('[team_confirm] 审批回传未生效:', body?.error ?? `HTTP ${res.status}`);
                    }
                  } catch {
                    /* 回传失败：服务端按未批准（超时）收口，草案由 team_run 作废 */
                  }
                  setConfirmPending(false);
                })();
              }
              if (parsed.butler_confirm) {
                // Butler 结构化确认卡片：排程创建/改/删在真正执行前先让用户确认（可编辑字段）
                const pc = parsed.butler_confirm as ButlerConfirmState;
                if (mountedRef.current && pc?.confirmId && pc?.card) {
                  setButlerConfirm({ confirmId: pc.confirmId, name: pc.name, card: pc.card, timeoutSec: pc.timeoutSec });
                }
              }
              if (parsed.coding_phase) {
                // AI Coding 专项任务循环状态：服务端按工具映射推送（改码→预览自检→测试→完成），
                // CodingNode 头部据此渲染循环状态徽标
                const cp = parsed.coding_phase as { phase: CodingPhase; tool?: string };
                if (mountedRef.current) setCodingPhase(cp.phase);
              }
              if (parsed.questions_request) {
                // 模型通过 ask_user_questions 工具提问：立即弹出结构化表单（tool 模式）。
                // 用户提交后 POST /api/chat/questions 回传 answers，服务端把它作为 tool_result 返回给模型继续生成。
                const qr = parsed.questions_request as {
                  requestId: string;
                  questions: QuestionItem[];
                  timeoutSec?: number;
                };
                setQuestionPopup({ questions: qr.questions, requestId: qr.requestId, timeoutSec: qr.timeoutSec });
                setQuestionTitleFlash(true);
                notifyUserInput('BobWork: Your answer is needed', `AI asked ${qr.questions.length} question${qr.questions.length > 1 ? 's' : ''}. Answer within ${Math.ceil((qr.timeoutSec ?? 600) / 60)} min — it will continue unanswered when time runs out.`);
              }
              if (parsed.login_required) {
                // browser.login（BobWork 模式）：弹出登录窗输入账号密码。
                // 凭据仅经 前端→服务端内存→MCP→扩展 直传，不过模型上下文/日志。
                const lr = parsed.login_required as {
                  requestId: string;
                  siteName?: string;
                  url?: string;
                  timeoutSec?: number;
                };
                setLoginPopup({
                  requestId: lr.requestId,
                  siteName: lr.siteName || 'this site',
                  url: lr.url || '',
                  timeoutSec: lr.timeoutSec,
                });
                notifyUserInput('BobWork: Login required', `Enter the username and password for ${lr.siteName || 'this site'} in the popup.`);
              }
              if (parsed.tool_call_update) {
                const up = parsed.tool_call_update as { name: string; phase?: 'running' | 'done' | 'error'; spanId?: string; startAt?: number };
                // 优先按 spanId 精确匹配（P1），fallback 到同名最后一个（历史消息兜底）
                let updateIdx = -1;
                if (up.spanId) {
                  updateIdx = toolCallRecords.findIndex((t) => t.spanId === up.spanId);
                }
                if (updateIdx < 0) {
                  for (let i = toolCallRecords.length - 1; i >= 0; i--) {
                    if (toolCallRecords[i].toolName === up.name) { updateIdx = i; break; }
                  }
                }
                if (updateIdx >= 0) {
                  toolCallRecords[updateIdx] = {
                    ...toolCallRecords[updateIdx],
                    phase: up.phase ?? toolCallRecords[updateIdx].phase,
                    spanId: up.spanId ?? toolCallRecords[updateIdx].spanId,
                    startAt: up.startAt ?? toolCallRecords[updateIdx].startAt,
                  };
                }
                if (mountedRef.current) {
                  if (up.phase === 'running') setCurrentStage({ kind: 'tool', name: up.name });
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: assistantContent, reasoning: reasoningContent, toolCalls: [...toolCallRecords] }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.tool_result) {
                const tr = parsed.tool_result as { name: string; result: string; durationMs: number; success: boolean; phase?: 'done' | 'error'; cardHtml?: string; kind?: 'tool' | 'mcp' | 'skill'; systemChange?: boolean; changeSummary?: string; summary?: string; spanId?: string; startAt?: number; endAt?: number };
                // 优先按 spanId 精确匹配（P1），fallback 到同名+result='...' 兜底
                let resultIdx = -1;
                if (tr.spanId) {
                  resultIdx = toolCallRecords.findIndex((t) => t.spanId === tr.spanId);
                }
                if (resultIdx < 0) {
                  resultIdx = toolCallRecords.findIndex((t) => t.toolName === tr.name && t.result === '...');
                }
                if (resultIdx >= 0) {
                  toolCallRecords[resultIdx] = {
                    ...toolCallRecords[resultIdx],
                    result: tr.result,
                    durationMs: tr.durationMs,
                    success: tr.success,
                    phase: tr.phase ?? (tr.success ? 'done' : 'error'),
                    cardHtml: tr.cardHtml,
                    kind: tr.kind,
                    systemChange: tr.systemChange,
                    changeSummary: tr.changeSummary,
                    summary: tr.summary,
                    spanId: tr.spanId ?? toolCallRecords[resultIdx].spanId,
                    startAt: tr.startAt ?? toolCallRecords[resultIdx].startAt,
                    endAt: tr.endAt,
                  };
                }
                if (mountedRef.current) {
                  // 文件操作工具完成后通知侧边栏刷新；命中 Bob Sandbox 小程序目录时同步刷新小程序列表
                  if (tr.success && /^(write_file|delete_file|rename_file)$/.test(tr.name)) {
                    window.dispatchEvent(new CustomEvent('project-files-changed'));
                    const lastRec = resultIdx >= 0 ? toolCallRecords[resultIdx] : null;
                    const argsStr = lastRec ? JSON.stringify(lastRec.arguments ?? {}) : '';
                    if (argsStr.includes('.sandbox')) window.dispatchEvent(new Event('sandbox-changed'));
                  }
                  // create_sticky_note / create_scheduled_todo 创建了画布便签 → 通知便签层重新加载（静默）
                  if ((tr.name === 'create_sticky_note' || tr.name === 'create_scheduled_todo') && tr.success) {
                    window.dispatchEvent(new CustomEvent('sticky-notes-changed'));
                  }
                  // create_scheduled_todo 写入了日历事件 → 通知日历面板刷新
                  if (tr.name === 'create_scheduled_todo' && tr.success) {
                    window.dispatchEvent(new Event('calendar-events-changed'));
                  }
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: assistantContent, reasoning: reasoningContent, toolCalls: [...toolCallRecords] }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.vision_progress) {
                // 图片识别进度：识别在流内执行（首字节前提速），收到事件即重置超时计时器 + 前端显示进度
                if (mountedRef.current) {
                  setVisionProgress(parsed.vision_progress as { phase: string; current: number; total: number });
                }
              }
              if (parsed.bobby_trigger) {
                // 主 Agent 调用 Bobby 插件工具。
                // 2026-09-18：原「通知画布自动打开 BobbyNode 并连线」（CanvasFlow 监听 bobby:trigger）
                // 已随画布移除而停用，此处暂保留广播（无监听方，无副作用），授权改由 grant_required
                // 事件驱动全局宿主 BobbyAuthHost 弹窗。
                const bt = parsed.bobby_trigger as { tool: string };
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('bobby:trigger', { detail: { nodeId: id, tool: bt.tool } }));
                }
              }
              if (parsed.subagent_update) {
                // 多智能体协作模式：主 Agent 经 team_run 编排成员时，服务端每 2s 推一帧成员进度快照。
                // 折叠分支卡片（Process 区内）据此实时刷新；逐帧覆盖 —— 新帧即全量成员状态。
                const panel = parsed.subagent_update as SubagentPanel;
                subagentPanel = panel;
                // 登记团队 id 到本节点（团队工作台据此列出本会话产生过的团队）
                if (panel.teamId) rememberTeamId(panel.teamId);
                // 同帧可附带「群聊流」增量事件（subagent_events 只含本次新增）：累积成时间线，与快照互补
                const fresh = Array.isArray(parsed.subagent_events)
                  ? (parsed.subagent_events as TeamChatEvent[])
                  : [];
                if (fresh.length > 0) subagentEventList.push(...fresh);
                if (mountedRef.current) {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, subagents: panel, subagentEvents: [...subagentEventList] }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.grant_required) {
                // Bobby 工具返回授权拦截：记录等待授权的目标。
                // 全局 BobbyAuthHost（layout.tsx）授权成功后广播 bobby:granted，本节点匹配则自动补发
                // "继续"消息重试，用户无需手动回复"已授权"。
                const gr = parsed.grant_required as { target?: string };
                if (typeof gr.target === 'string') {
                  pendingGrantTargetRef.current = gr.target;
                  // 即时通知全局浮层弹授权框（无需等 BobbyAuthHost 的 5s 状态轮询）。
                  // 旧链路是「通知画布打开 BobbyNode 再弹窗」，画布移除后该路径已失效。
                  if (typeof window !== 'undefined') {
                    window.dispatchEvent(
                      new CustomEvent('bobby:grant-required', { detail: { target: gr.target } }),
                    );
                  }
                }
              }
              if (parsed.tool_summary) {
                // Summary event - could be used for display, currently handled via toolCalls array
              }
              if (parsed.claim_mismatch) {
                // 声明真实性校验未通过：模型声称完成但工具记录不匹配，已注入纠偏消息
                // 前端展示一个醒目的提示，让用户知道系统正在强制模型补执行
                const cm = parsed.claim_mismatch as { mismatches: string[]; correctionCount: number };
                if (mountedRef.current) {
                  setCurrentStage({ kind: 'tool', name: 'claim-verify' });
                  // 在 assistant 消息内容末尾追加校验提示（用户可见）
                  assistantContent += `\n\n> ⚠️ **Claim verification failed** (${cm.correctionCount}/2): The following claims lack matching tool execution:\n${cm.mismatches.map((m) => `> - ${m}`).join('\n')}\n> Forcing tool execution...`;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: assistantContent, toolCalls: [...toolCallRecords] }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.completion_check) {
                // 系统注入「假完成确认」：本轮无工具调用但此前执行过工具，系统正要求模型确认是否真正完成。
                // 模型可能随后重答一遍——在此追加轻提示，避免用户看到"无头两遍答案"的错觉。
                if (mountedRef.current) {
                  setCurrentStage({ kind: 'tool', name: 'completion-check' });
                  assistantContent += `\n\n> ⏳ **Completion check**: No tool was called in this round, so the system is asking the assistant to confirm all steps are truly finished. It will only re-answer if something is still incomplete.`;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: assistantContent, toolCalls: [...toolCallRecords] }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.output_files && Array.isArray(parsed.output_files)) {
                // 输出文件卡片事件：累积到当前 assistant 消息的 outputFiles 字段
                const items = parsed.output_files as OutputFileItem[];
                const known = new Set(outputFileItems.map((f) => f.path));
                for (const f of items) {
                  if (!known.has(f.path)) {
                    outputFileItems.push(f);
                    known.add(f.path);
                  }
                }
                if (mountedRef.current) {
                  const snapshot = outputFileItems.slice();
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, outputFiles: snapshot }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.done && parsed.matchedSkills) {
                if (mountedRef.current) {
                  setMatchedSkillsByMsg((prev) => ({ ...prev, [assistantId]: parsed.matchedSkills as string[] }));
                  if (Array.isArray(parsed.skillDetails)) {
                    setSkillDetailsByMsg((prev) => ({ ...prev, [assistantId]: parsed.skillDetails as SkillDetail[] }));
                  }
                }
              }
              if (parsed.done) {
                // P2 轨迹：捕获本轮任务日志 id（后续持久化到消息 + append 到 .md）
                if (typeof parsed.taskId === 'string' && parsed.taskId) {
                  taskIdForTurn = parsed.taskId;
                }
                // 服务端实际使用模型（可能是「带图改选视觉模型」的结果）：以它作为消息标签
                if (typeof parsed.model === 'string' && parsed.model) {
                  servedModelId = parsed.model;
                }
                const u = parsed.usage as { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number; calls?: number } | undefined;
                if (u && (typeof u.promptTokens === 'number' || typeof u.completionTokens === 'number')) {
                  if (mountedRef.current) {
                    setUsageByMsg((prev) => ({
                      ...prev,
                      [assistantId]: {
                        promptTokens: u.promptTokens ?? 0,
                        completionTokens: u.completionTokens ?? 0,
                        cacheHitTokens: u.cacheHitTokens ?? 0,
                        cacheMissTokens: u.cacheMissTokens ?? 0,
                        calls: u.calls ?? 0,
                      },
                    }));
                  }
                }
                // 完成轮次统计（dsh）：TTFT / 总耗时 / tok/s
                const st = parsed.stats as { ttftMs?: number | null; durationMs?: number; tokensPerSec?: number } | undefined;
                if (st && typeof st.durationMs === 'number') {
                  if (mountedRef.current) {
                    // 思考决策可见性（方向 D）：done.thinking → 统计条展示降级/C1 命中
                    const th = parsed.thinking as { level?: string; downgradedRounds?: number; trivialOff?: boolean } | undefined;
                    const statsVal: Record<string, unknown> = { ttftMs: st.ttftMs ?? null, durationMs: st.durationMs, tokensPerSec: st.tokensPerSec ?? 0 };
                    if (th && ((th.downgradedRounds ?? 0) > 0 || th.trivialOff)) {
                      statsVal.thinking = { level: th.level ?? '', downgradedRounds: th.downgradedRounds ?? 0, trivialOff: !!th.trivialOff };
                    }
                    setStatsByMsg((prev) => ({ ...prev, [assistantId]: statsVal as never }));
                  }
                }
                // 最终上下文占用（含工具结果回灌）→ composer 圆环
                if (parsed.contextMeter) {
                  if (mountedRef.current) {
                    setComposerCtxMeter(parsed.contextMeter as CtxMeterInfo);
                    // 缓存头指纹（done 最终值，与 start 一致；幂等更新）
                    if (typeof parsed.prefixHash === 'string' && parsed.prefixHash) {
                      const prevHash = lastPrefixHashRef.current;
                      if (prevHash && prevHash !== parsed.prefixHash) {
                        setPrefixChangedByMsg((p) => ({ ...p, [assistantId]: true }));
                      }
                      lastPrefixHashRef.current = parsed.prefixHash;
                      setPrefixHashByMsg((p) => ({ ...p, [assistantId]: parsed.prefixHash }));
                    }
                    applyPrefixSegments(assistantId, parsed.prefixSegments as Record<string, unknown> | undefined);
                  }
                }
              }
              if (parsed.error) {
                assistantContent = `[${parsed.error}]`;
                if (mountedRef.current) {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: assistantContent }
                        : m,
                    ),
                  );
                }
              }
            } catch {
              // Ignore JSON parse errors for partial chunks
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError' && abortedByTimeout) {
          // 超时中断：给用户可见反馈（不能静默吞掉）
          assistantContent = 'Error: Request timed out (90s). Please try again.';
          if (mountedRef.current) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: assistantContent } : m)),
            );
          }
          desktop.update.notify('BobWork', 'Chat error: Request timed out (90s)').catch(() => {});
          // 续写模式超时：回滚 UI 到补充前的状态（恢复上一轮 AI 回复）
          if (isContinuation && continuationSnapshotRef.current && mountedRef.current) {
            const snapshot = continuationSnapshotRef.current;
            setMessages(snapshot);
            setNodes((nds) =>
              nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, messages: snapshot } } : n)),
            );
          }
        } else if (error.name !== 'AbortError') {
          // 非中断错误：显示错误信息
          assistantContent = `Error: ${error.message}`;
          if (mountedRef.current) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: assistantContent }
                  : m,
              ),
            );
          }
          // 出错时系统通知
          desktop.update.notify('BobWork', `Chat error: ${error.message}`).catch(() => {});
          // 续写模式出错：回滚 UI 到补充前的状态（恢复上一轮 AI 回复）
          if (isContinuation && continuationSnapshotRef.current && mountedRef.current) {
            const snapshot = continuationSnapshotRef.current;
            setMessages(snapshot);
            setNodes((nds) =>
              nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, messages: snapshot } } : n)),
            );
          }
        }
        // AbortError 且非超时（用户主动停止 / QUESTIONS 提前收尾）→ 保持静默，保留已生成内容
      }
    } finally {
      clearTimeout(timeoutId);
      // 续写模式：清理 UI 快照（成功时不再需要回滚，失败时 catch 块已处理）
      continuationSnapshotRef.current = null;
      // === 流式结束前：把本轮 toolCallRecords 里残留的 pending/running 强制收口为 done/error
      // （后端可能漏发 tool_call_update done/error，或 abort 时事件在途丢失；不收口会导致
      // 持久化到 .md 的 phase 非终态，下次加载时 Running… 徽章永远跳动——用户误判为"上一轮仍在思考"）
      for (let i = 0; i < toolCallRecords.length; i++) {
        const t = toolCallRecords[i];
        if (t.phase === 'pending' || t.phase === 'running' || t.phase === undefined) {
          // 有结果（result !== '...'）且 success=true → done；success=false → error；无结果 → 用 result 值兜底
          const finalPhase: ToolCallPhase =
            t.result !== '...' ? (t.success ? 'done' : 'error') : (t.success ? 'done' : 'error');
          toolCallRecords[i] = { ...t, phase: finalPhase };
        }
      }
      // P5a-1 事件窗口 schema（渲染未切换，行为不变）：流末收口旁路窗口（等价上方 toolCallRecords 收口）
      if (traceWindowRef.current) {
        traceWindowRef.current = finishWindow(traceWindowRef.current);
      }
      if (mountedRef.current) {
        setIsStreaming(false);
        setStreamingMsgId(null);
        setVisionProgress(null); // 图片识别进度随本轮流式结束清理
        streamingRef.current = false; // 同步执行标志（先复位，待办队列才能进入下一条）
        // 流式结束，清除当前阶段（「当前动作」条随之消失）
        setCurrentStage(null);
        // 回答完成 → 仅窗口不在前台时发系统通知
        if (document.hidden && assistantContent && !assistantContent.startsWith('Error:')) {
          const preview = assistantContent.slice(0, 80).replace(/\n/g, ' ');
          desktop.update.notify('BobWork response complete', preview + (assistantContent.length > 80 ? '...' : '')).catch(() => {});
        }
        // 输出触顶（finish_reason=length）：末尾追加截断提示，避免"突然停止"无任何说明
        if (truncatedRef.current && assistantContent && !assistantContent.startsWith('Error:')) {
          assistantContent += '\n\n> ⚠️ Output reached the model limit and may be incomplete. Continue the question, lower thinking depth, or split into files to retry.';
        }
        const finalMessages: ChatMessage[] = [
          ...baseMessages,
          {
            id: assistantId,
            role: 'assistant',
            content: assistantContent,
            reasoning: reasoningContent || undefined,
            toolCalls: toolCallRecords.length > 0 ? toolCallRecords : undefined,
            outputFiles: outputFileItems.length > 0 ? outputFileItems : undefined,
            // 本轮实际使用的模型与思考等级（以服务端 done 帧回传的模型为准，含带图改选视觉模型）
            modelId: servedModelId,
            thinkingLevel: actualThinkingLevel,
            taskId: taskIdForTurn ?? undefined,
            // 多智能体协作分支面板：随本轮回答定格（折叠卡片重启后仍可回看）
            subagents: subagentPanel ?? undefined,
            // 协作「群聊流」时间线：仅会话内存（不随回答落盘，重启后由分支面板降级合成）
            subagentEvents: subagentEventList.length > 0 ? [...subagentEventList] : undefined,
          },
        ];
        setMessages(finalMessages);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    messages: finalMessages,
                    isStreaming: false,
                  },
                }
              : n,
          ),
        );

        // 界面产物自动进预览：本轮流式完成后，若有 .html 交付产物，自动在右侧预览面板打开
        // （CanvasFlow 订阅 file.open 事件统一开 Tab；同路径幂等——已打开则只聚焦，避免重复建 Tab）
        if (assistantContent && !assistantContent.startsWith('Error:')) {
          for (const f of outputFileItems) {
            const norm = f.path.replace(/\\/g, '/');
            if (!/\.html?$/i.test(norm)) continue;
            const name = norm.split('/').pop() || 'page.html';
            const source = norm.startsWith('~/') || norm.startsWith('/') ? 'local' : 'project';
            bus.publish(BusEvents.fileOpen, { source, path: norm, name });
          }
        }

        // 漂移清洗兜底：模型若无视工具约定在正文输出旧版 QUESTIONS 注释块，
        // 仅剥块防 JSON 裸露（同步更新内存与落盘内容），不再弹窗——结构化提问统一走 ask_user_questions 工具
        if (assistantContent && !assistantContent.startsWith('Error:')) {
          const stripped = stripQuestionsBlock(assistantContent);
          if (stripped !== assistantContent) {
            assistantContent = stripped;
            const cleanedMessages = finalMessages.map((m) =>
              m.id === assistantId ? { ...m, content: stripped } : m,
            );
            setMessages(cleanedMessages);
            setNodes((nds) =>
              nds.map((n) =>
                n.id === id
                  ? { ...n, data: { ...n.data, messages: cleanedMessages } }
                  : n,
              ),
            );
          }
        }

      }

      // 持久化：追加问答到 .md 文件（await 确保写入完成后再更新标题/摘要）
      // 移出 mountedRef 守卫：流式期间组件卸载（渲染崩溃/节点被关闭）时仍保证结果落盘不丢失；
      // 块内的 setMessages/setNodes/setPersistError 在组件已卸载时是安全 no-op，仅挂载时产生 UI 反馈
      if (currentMdId && assistantContent && !assistantContent.startsWith('Error:')) {
          // 分离 think 和干净的回答内容
          const { content: answerWithoutMood } = parseThink(assistantContent);

          const cleanAnswer = answerWithoutMood;

          console.log('[AiChatNode:save] assistantContent 长度:', assistantContent.length, '前200字:', assistantContent.slice(0, 200));
          console.log('[AiChatNode:save] answerWithoutMood 长度:', answerWithoutMood.length, '前200字:', answerWithoutMood.slice(0, 200));
          console.log('[AiChatNode:save] cleanAnswer 长度:', cleanAnswer.length, '前200字:', cleanAnswer.slice(0, 200));

          // 安全兜底：如果解析后的答案异常短但原文很长，可能是 <think> 标签未闭合导致内容被清空
          let finalAnswer = cleanAnswer;
          if (cleanAnswer.length < 10 && assistantContent.length > 100) {
            console.warn('[AiChatNode:save] 解析后答案异常短，可能 <think> 未闭合，使用原文兜底');
            // 尝试只去除已知安全的部分：TITLE 注释
            const fallback = assistantContent
              .replace(/<!--\s*TITLE:\s*.+?\s*-->/gi, '')
              .trim();
            if (fallback.length > cleanAnswer.length) {
              finalAnswer = fallback;
              console.log('[AiChatNode:save] 兜底答案长度:', finalAnswer.length);
            }
          }
          // 从用户消息中获取附件（移除 dataUrl 以减少存储）
          const savedAttachments = userMsg.attachments?.map(({ dataUrl, ...rest }) => rest) || [];
          // 本轮 @引用 快照（资料/本地文件/链接/操作目录）：纯元数据，直接落盘
          const savedReferences = userMsg.references || [];

          // 1. 先写入 .md 文件（带重试）
          //   - 透传当前节点正在用的自定义模型（apiKey/baseUrl/providerModelId）
          //     作为 compact_model_config，压缩时可以复用同一 Key，不必再找 settings
          let compactModelCfg: { apiKey: string; baseURL: string; model: string } | undefined;
          {
            const sel = availableModels.find((m) => m.modelId === currentModelId) ?? availableModels[0];
            if (sel && isCustomModel(sel.modelId)) {
              const parsed = parseCustomModel(sel.modelId);
              if (parsed) {
                const preset = getProviderPreset(parsed.provider);
                const providerCfg = providerConfigs.find((c) => c.type === parsed.provider);
                if (preset && providerCfg && providerCfg.apiKey) {
                  compactModelCfg = {
                    apiKey: providerCfg.apiKey,
                    baseURL: providerCfg.baseUrl?.trim() || preset.baseUrl,
                    model: parsed.modelId,
                  };
                }
              }
            }
          }

          // ==================== 压缩进行中提示（参考 TRAE：压缩时先显示提示，完成后被 Memory compacted 覆盖） ====================
          // 前端预判本轮 append 后是否触发增量压缩（复刻后端 R-26 判定）：
          //   未压缩轮次 token ≥ 阈值 或 未压缩轮数 ≥ 15 → 乐观插入"压缩进行中"系统消息（置于上一条回复下方）。
          // append 响应确认压缩后原位替换为完成消息；未压缩/失败则移除提示（预判只是近似，以响应为准）。
          let pendingCompressMsgId: string | null = null;
          {
            const nonSystemMsgs = messages.filter((m) => !m.system);
            const startMsg = Math.min(compactedUntilRef.current * 2, Math.max(0, nonSystemMsgs.length - 1));
            const uncompressed = nonSystemMsgs.slice(startMsg);
            // 压缩预判的上下文窗口：high/max 档按推理大模型估算（S2b：max 为新深档，一并计入）
            const triggerTokens = compactTriggerTokensForContext(inferContextWindow(currentModelId, actualThinkingLevel === 'high' || actualThinkingLevel === 'max'));
            const totalTokens = Math.ceil(uncompressed.reduce((s, m) => s + (m.content || '').length, 0) * 0.8);
            const willCompact = uncompressed.length > 0 && (totalTokens >= triggerTokens || Math.ceil(uncompressed.length / 2) >= 15);
            if (willCompact) {
              pendingCompressMsgId = `sys-compact-pending-${Date.now()}`;
              setMessages((prev) => [
                ...prev,
                {
                  id: pendingCompressMsgId!,
                  role: 'assistant',
                  system: true,
                  content: 'Memory compression in progress…',
                  timestamp: new Date().toISOString(),
                },
              ]);
            }
          }

          let appendSuccess = false;
          // 落盘接口的响应体：仅当返回 compacted 字段时用于日志（未返回/解析失败保持 null）
          let appendRespJson: { compacted?: { new_compacted_until: number; appended_facts: number } } | null = null;
          // 开始持久化：置进行中标志，期间锁定输入避免并发写同一节点文件
          setPersisting(true);
          persistingRef.current = true;

          // 续写模式：先移除上一轮（含提问的 AI 回复），再追加合并后的完整轮次
          if (isContinuation && currentMdId) {
            try {
              await fetch('/api/nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(withProjectId({ action: 'remove_last_round', node_id: currentMdId })),
              });
            } catch {
              // 移除失败不阻塞追加，最多少移除一轮
            }
          }

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              // 续写模式：question 用合并了补充信息的 effectiveContent
              const questionForPersist = isContinuation ? (effectiveContent || userMsg.content) : displayContent;
              const appendBody: Record<string, unknown> = {
                action: 'append',
                node_id: currentMdId,
                question: questionForPersist,
                answer: finalAnswer,
                question_attachments: savedAttachments,
                question_references: savedReferences,
                title: data.title || 'AI Chat',
                // 记录本轮真实调用的模型与推理强度：auto 模式每轮可能不同，持久化后历史消息可追溯
                model_id: currentModelId,
                thinking_level: actualThinkingLevel,
                // 持久化思考内容 + 工具调用记录：think 标签与 Trajectory 在重新加载后可回看
                reasoning: reasoningContent || undefined,
                tool_calls: toolCallRecords.length > 0 ? toolCallRecords : undefined,
                task_id: taskIdForTurn ?? undefined,
                // 持久化输出文件卡片：重启/切换节点后仍可显示（homework/、materials/ 产物）
                output_files: outputFileItems.length > 0 ? outputFileItems : undefined,
                // 多智能体协作分支面板：只在本轮确有成员时写盘（RMETA 单行 JSON）
                subagents: subagentPanel && subagentPanel.members.length > 0 ? subagentPanel : undefined,
                compact_model_config: compactModelCfg,
                // P1 事件溯源（方案 A）：优先由服务端从本轮 .trajectory 事件日志派生摘要；
                // question/answer 等字段仍随请求直传，服务端仅在日志可用时用派生值补缺/校正（回退安全）
                derive: true,
              };
              // 投影窗口（临时节点）显式传 project_id，写入 temporary 项目而非当前项目
              if (data.projectId) appendBody.project_id = data.projectId;
              const resp = await fetch('/api/nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(appendBody),
              });
              if (resp.ok) {
                try { appendRespJson = await resp.json(); } catch { /* ignore */ }
                setPersistError(null);
                pendingAppendRef.current = null;
                appendSuccess = true;
                // 通知 HtmlReader 刷新
                window.dispatchEvent(new CustomEvent('node-document-updated', { detail: { node_id: currentMdId } }));
                break;
              }
            } catch {
              // 重试
            }
            if (attempt < 3) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          // 持久化完成：清除进行中标志
          setPersisting(false);
          persistingRef.current = false;

          if (appendRespJson && appendRespJson?.compacted) {
            const c = appendRespJson.compacted as { new_compacted_until: number; appended_facts: number };
            console.log(
              `[AiChatNode] 触发增量压缩：游标推进到 ${c.new_compacted_until}，硬事实补回 ${c.appended_facts} 条。`,
            );
            // 同步压缩游标：后续请求将跳过已压缩的历史轮次
            compactedUntilRef.current = c.new_compacted_until;
            setNodes((nds) =>
              nds.map((n) =>
                n.id === id ? { ...n, data: { ...n.data, compactedUntil: c.new_compacted_until } } : n,
              ),
            );
            // 对话流中插入系统消息：告知用户上下文已被压缩（仅前端展示，不参与模型输入/持久化）
            // 若此前插入了"压缩进行中"提示，则原位替换为完成消息（参考 TRAE 交互：进行中提示被完成消息覆盖）
            try {
              const doneContent = `Memory compacted: ${c.new_compacted_until} turn(s) summarized, ${c.appended_facts} hard fact(s) preserved.`;
              if (pendingCompressMsgId) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === pendingCompressMsgId ? { ...m, content: doneContent } : m,
                  ),
                );
              } else {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `sys-compact-${Date.now()}`,
                    role: 'assistant',
                    system: true,
                    content: doneContent,
                    timestamp: new Date().toISOString(),
                  },
                ]);
              }
            } catch (e) {
              console.warn('[AiChatNode] 插入压缩系统消息失败:', e instanceof Error ? e.message : String(e));
            }
          } else if (pendingCompressMsgId) {
            // 预判会压缩但实际未触发（如冷却期内 token 未达阈值）→ 移除"压缩进行中"提示
            setMessages((prev) => prev.filter((m) => m.id !== pendingCompressMsgId));
          }

          if (!appendSuccess) {
            // 3 次重试都失败，保存待重试数据并提示
            pendingAppendRef.current = {
              nodeId: currentMdId!,
              question: isContinuation ? (effectiveContent || userMsg.content) : displayContent,
              answer: cleanAnswer,
              modelId: currentModelId,
              thinkingLevel: actualThinkingLevel,
            };
            setPersistError('Save failed, click to retry');
            // 落盘失败：移除"压缩进行中"提示（压缩未执行）
            if (pendingCompressMsgId) {
              setMessages((prev) => prev.filter((m) => m.id !== pendingCompressMsgId));
            }
          }

          // 2. 生成消息摘要（写入 .md 文件后，调用 summarize API 生成智能摘要）
          if (appendSuccess && mountedRef.current && cleanAnswer) {
            // 先显示截断摘要，后续用 AI 摘要覆盖
            const quickSummary = cleanAnswer.replace(/\n/g, ' ').trim().slice(0, 100);
            if (quickSummary) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, summary: quickSummary + (quickSummary.length >= 100 ? '...' : '') } as ChatMessage & { summary?: string }
                    : m,
                ),
              );
            }

            // 异步调用 summarize API 生成智能摘要（不阻塞 UI）
            const selectedModel = availableModels.find((m) => m.modelId === currentModelId) ?? availableModels[0];
            if (selectedModel) {
              const custom = isCustomModel(selectedModel.modelId);
              const summarizeBody: Record<string, unknown> = {
                action: 'summarize',
                node_id: currentMdId,
                question: displayContent,
                answer: cleanAnswer,
              };
              if (custom) {
                const parsed = parseCustomModel(selectedModel.modelId);
                if (parsed) {
                  const preset = getProviderPreset(parsed.provider);
                  const providerConfig = providerConfigs.find((c) => c.type === parsed.provider);
                  if (preset && providerConfig) {
                    summarizeBody.apiKey = providerConfig.apiKey;
                    summarizeBody.baseUrl = providerConfig.baseUrl?.trim() || preset.baseUrl;
                    summarizeBody.providerModelId = parsed.modelId;
                  }
                }
              }
              fetch('/api/nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(withProjectId(summarizeBody)),
              }).then((r) => r.json())
                .then((result) => {
                  if (result.success && result.summary && mountedRef.current) {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantId
                          ? { ...m, summary: result.summary } as ChatMessage & { summary?: string }
                          : m,
                      ),
                    );
                  }
                })
                .catch(() => {});
            }
          }
        }
      abortRef.current = null;
      // 当前任务彻底结束（含持久化）后，逐条发送执行期间加入的待办消息
      if (mountedRef.current) {
        drainPending();
      }
    }
  };

  /** 执行期间加入的待办队列：每次任务结束后取一条发送，链式逐条清空 */
  const drainPending = () => {
    const next = pendingSendRef.current.shift();
    setPendingSendCount(pendingSendRef.current.length);
    if (next) doSend(next);
  };

  const handleStop = () => {
    // 用户主动停止：取消待办队列，待办文字合并回落回输入框，避免内容丢失
    const pending = pendingSendRef.current;
    if (pending.length > 0) {
      pendingSendRef.current = [];
      setPendingSendCount(0);
      setLocalInput((prev) => (prev ? prev + '\n' : '') + pending.join('\n'));
    }
    abortRef.current?.abort();
  };

  // browser.login 登录弹窗提交：凭据仅 POST /api/chat/login 回传服务端（→ MCP → 扩展代填），
  // 不写入任何 message / 本地状态 / 日志，也不进入模型上下文。
  const handleLoginSubmit = (username: string, password: string) => {
    if (!loginPopup) return;
    const { requestId } = loginPopup;
    setLoginPopup(null);
    fetch('/api/chat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, username, password }),
    }).catch((e) => {
      console.error('[AiChatNode] 提交登录凭据失败', e);
    });
  };

  const handleLoginClose = () => {
    if (!loginPopup) return;
    const { requestId } = loginPopup;
    setLoginPopup(null);
    fetch('/api/chat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, cancelled: true }),
    }).catch(() => {});
  };

  const handleQuestionSubmit = (answers: AnswerEntry[], supplement: string) => {
    // 把答案（含末页补充说明）回传服务端，服务端作为 tool_result 返回给模型继续生成。
    // 此时 SSE 流仍在服务端挂起等待，本地无需插入消息或触发续写。
    const requestId = questionPopup?.requestId;
    setQuestionPopup(null);
    setQuestionTitleFlash(false);
    if (!requestId) return;
    fetch('/api/chat/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        answers: answers.map((a) => ({ questionId: a.questionId, selected: a.selected, custom: a.custom })),
        supplement: supplement.trim() || undefined,
      }),
    }).catch((e) => {
      console.error('[AiChatNode] 提交提问答案失败', e);
    });
  };

  // 关闭提问弹窗 = 最小化为悬浮胶囊（不放弃）：服务端继续挂起等待，用户可随时点开胶囊继续作答。
  const handleQuestionMinimize = () => {
    setQuestionPopup((p) => (p ? { ...p, minimized: true } : p));
  };

  // 点击悬浮胶囊 = 恢复弹窗继续作答。
  const handleQuestionRestore = () => {
    setQuestionPopup((p) => (p ? { ...p, minimized: false } : p));
  };

  // 显式跳过 = 放弃回答：立即回传「未回答」，让服务端马上继续生成，不必等 10 分钟超时兜底。
  const handleQuestionSkip = () => {
    const requestId = questionPopup?.requestId;
    setQuestionPopup(null);
    setQuestionTitleFlash(false);
    if (!requestId) return;
    fetch('/api/chat/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, answers: [] }),
    }).catch((e) => {
      console.error('[AiChatNode] 回传跳过状态失败', e);
    });
  };

  // 回答窗口倒计时归零：服务端已按未回答继续生成，清理本地弹窗（无需再回传）。
  const handleQuestionExpire = () => {
    setQuestionPopup(null);
    setQuestionTitleFlash(false);
  };

  const handleSelectModel = useCallback((newModelId: string) => {
    setModelId(newModelId);
    setModelMenuOpen(false);
    const newModel = dropdownModels.find((m) => m.modelId === newModelId);
    const supportsThinking = newModel?.thinking ?? true;
    if (!supportsThinking) {
      // 模型不支持思考 → 降级到最低思考等级
      setThinkingLevel('low');
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, modelId: newModelId, thinkingLevel: 'low' as ThinkingLevel } }
            : n,
        ),
      );
    } else {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, modelId: newModelId } }
            : n,
        ),
      );
    }
  }, [id, setNodes, dropdownModels, thinkingLevel]);

  // Auto 下线迁移：存量节点（含 CanvasFlow 新建的节点）modelId 为空，等候选池就绪后
  // 落成「候选池有序首选（池空则下拉首项）」，使"节点始终有具体模型"这一前提成立。
  // 思考强度不受影响：Auto 时代默认 High === DEFAULT_THINKING_LEVEL。
  useEffect(() => {
    if (modelId !== DEFAULT_MODEL_ID || dropdownModels.length === 0) return;
    let cancelled = false;
    (async () => {
      let target = dropdownModels[0].modelId;
      try {
        const settings = await loadSettings();
        const pool = settings.chatModel?.pool ?? [];
        for (const item of pool) {
          // availableModels 的 modelId 是 `provider:modelId` 格式，配置存的是裸 modelId
          const hit = dropdownModels.find((m) => m.modelId === `${item.provider}:${item.modelId}`);
          if (hit) { target = hit.modelId; break; }
        }
      } catch { /* 读取失败则用下拉首项 */ }
      if (cancelled) return;
      handleSelectModel(target);
    })();
    return () => { cancelled = true; };
  }, [modelId, dropdownModels, handleSelectModel]);

  const handleThinkingLevelChange = useCallback((level: ThinkingLevel) => {
    setThinkingLevel(level);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, thinkingLevel: level } }
          : n,
      ),
    );
  }, [id, setNodes]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // @ mention 弹窗打开时，其中键盘事件（↑↓ 导航 / Enter 选择 / Esc 关闭）由 composer 统一处理
    if (handleMentionKeyDown(e)) return;

    // 输入法合成状态（中文候选确认/英文确认）按 Enter 不触发发送
    // composingRef 弥补 macOS 拼音输入法 compositionend 先于 keydown 触发的竞态
    const isIMEComposing = composingRef.current || (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229;
    if (e.key === 'Enter' && !e.shiftKey && !e.getModifierState('Fn') && !isIMEComposing) {
      e.preventDefault();
      handleSend();
    }
    // 输入 "/" 触发技能菜单
    if (e.key === '/' && !isStreaming && availableSkills.length > 0) {
      setTimeout(() => setSkillMenuOpen(true), 50);
    }
  };

  const handleRetryAppend = useCallback(async () => {
    const pending = pendingAppendRef.current;
    if (!pending) return;
    setPersistError('Saving...');
    try {
      const retryBody: Record<string, unknown> = {
        action: 'append',
        node_id: pending.nodeId,
        question: pending.question,
        answer: pending.answer,
        mood: pending.mood,
        title: data.title || 'AI Chat',
        model_id: pending.modelId,
        thinking_level: pending.thinkingLevel,
      };
      if (data.projectId) retryBody.project_id = data.projectId;
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryBody),
      });
      if (resp.ok) {
        pendingAppendRef.current = null;
        setPersistError(null);
      } else {
        setPersistError('Retry failed, click to try again');
      }
    } catch {
      setPersistError('Retry failed, click to try again');
    }
  }, []);

  // 删除一轮对话
  const handleDeleteRound = useCallback(async (msgIndex: number) => {
    // msgIndex 是消息在 messages 数组中的索引，只处理 user 消息
    const msg = messages[msgIndex];
    if (!msg || msg.role !== 'user') return;

    // 计算 round index（user 消息在 conversations 中的位置）
    const userMsgCount = messages.slice(0, msgIndex + 1).filter(m => m.role === 'user').length;
    const roundIndex = userMsgCount - 1;

    // 从 state 中移除 user 和接下来的 assistant 消息
    setMessages(prev => {
      const next = [...prev];
      // 移除 user 消息
      next.splice(msgIndex, 1);
      // 如果下一条是 assistant 消息，也移除
      if (msgIndex < next.length && next[msgIndex]?.role === 'assistant') {
        next.splice(msgIndex, 1);
      }
      return next;
    });

    // 同步删除 .md 文件中的记录
    if (currentMdId && roundIndex >= 0) {
      try {
        await fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withProjectId({
            action: 'remove_round',
            node_id: currentMdId,
            round_index: roundIndex,
          })),
        });
        window.dispatchEvent(new CustomEvent('node-document-updated', { detail: { node_id: currentMdId } }));
      } catch {
        // 静默失败
      }
    }
  }, [messages, currentMdId]);

  // 重试：删除当前 AI 回答及其对应的 user 消息，然后用原始问题重新发送
  const handleRegenerate = useCallback(async (msgIndex: number) => {
    const msg = messages[msgIndex];
    if (!msg || msg.role !== 'assistant' || isStreaming) return;

    // 找到上一条 user 消息（紧邻此 assistant 消息之前）
    let userIdx = msgIndex - 1;
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;

    const originalUserMsg = messages[userIdx];
    const originalContent = originalUserMsg.content;

    // 先从 state 中移除这一轮（user + assistant）
    setMessages(prev => {
      const next = [...prev];
      next.splice(userIdx, 2);
      return next;
    });

    // 同步删除 .md 文件中的记录
    if (currentMdId) {
      const userMsgCount = messages.slice(0, userIdx + 1).filter(m => m.role === 'user').length;
      const roundIndex = userMsgCount - 1;
      if (roundIndex >= 0) {
        try {
          await fetch('/api/nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withProjectId({
              action: 'remove_round',
              node_id: currentMdId,
              round_index: roundIndex,
            })),
          });
          window.dispatchEvent(new CustomEvent('node-document-updated', { detail: { node_id: currentMdId } }));
        } catch {
          // 静默失败
        }
      }
    }

    // 重新发送原始问题（带回原轮的附件与 @引用 快照，否则重试后气泡内 chip 消失）
    doSend(originalContent, {
      attachments: originalUserMsg.attachments,
      references: originalUserMsg.references,
    });
  }, [messages, currentMdId, isStreaming, doSend]);

  const messagesInner = (<>
        {persistError && (
          <div
            onClick={persistError === 'Save failed, click to retry' || persistError === 'Retry failed, click to try again' ? handleRetryAppend : undefined}
            className="mx-3 mb-2 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs cursor-pointer"
            style={{
              backgroundColor: 'color-mix(in oklab, var(--danger) 8%, transparent)',
              color: 'var(--danger)',
              fontFamily: "var(--font-sans)",
            }}
          >
            <span className="text-xs">⚠</span>
            <span className="flex-1">{persistError}</span>
            {(persistError === 'Save failed, click to retry' || persistError === 'Retry failed, click to try again') && (
              <span className="underline text-xs">Retry</span>
            )}
          </div>
        )}

        {/* 消息列表：整体包一层错误边界——正文/StreamingMarkdown 渲染异常时降级为可恢复提示，避免整节点空白 */}
        <MessagesErrorBoundary>
        {messages.map((msg) => {
          // 系统消息（如上下文压缩提示）：居中窄条展示，不参与对话气泡
          if (msg.system) {
            return (
              <div
                key={msg.id}
                className="my-1 flex w-full justify-center px-2"
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    maxWidth: '92%',
                    borderRadius: 8,
                    padding: '3px 10px',
                    fontSize: '0.733333rem',
                    color: 'color-mix(in oklab, var(--ink-muted) 85%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--paper-soft) 55%, transparent)',
                    border: '1px dashed var(--line)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    textAlign: 'center',
                    lineHeight: 1.5,
                  }}
                >
                  <span style={{ flexShrink: 0 }}>🗜️</span>
                  <span>{msg.content}</span>
                </div>
              </div>
            );
          }

          const showReasoning = msg.reasoning && msg.reasoning.trim().length > 0;

          const stageKind = stageKindOf(currentStage);
          // 「当前动作」条文案：流式中实时描述正在做什么（思考 / 正在调用的工具+目的 / 写答案）
          let currentActionText: string | null = null;
          if (msg.role === 'assistant' && msg.id === streamingMsgId && isStreaming) {
            if (stageKind === 'thinking') {
              currentActionText = 'Analyzing task…';
            } else if (stageKind === 'tool') {
              const activeCall = (msg.toolCalls ?? []).find((tc) => tc.phase === 'running' || tc.phase === 'pending');
              if (activeCall) {
                const why = activeCall.changeSummary || activeCall.purpose;
                const tool = activeCall.toolName.replace(/^browser[._]/, '').replace(/_/g, ' ');
                currentActionText = why ? `Doing: ${tool} — ${why}` : `Doing: ${tool}…`;
              } else {
                currentActionText = 'Working with tools…';
              }
            } else if (stageKind === 'writing') {
              currentActionText = 'Composing answer…';
            }
          }

          // Parse <think> tags from content
          const displayConfig = DISPLAY_CONFIGS[thinkingLevel];
          const parsedContent = msg.role === 'assistant' && msg.content
            ? parseThink(msg.content)
            : null;
          const hasThinkTags = parsedContent && parsedContent.think.trim().length > 0;
          const cleanContent = parsedContent ? parsedContent.content : msg.content;

          // Show reasoning block only if display config allows it
          const showThinkBlock = displayConfig.showThinkBlock && (showReasoning || hasThinkTags);


          // The think text to display (prefer API reasoning_content, fallback to <think> tags)
          const thinkText = showReasoning ? msg.reasoning : (hasThinkTags ? parsedContent!.think : '');

          // Sidebar 档（surface='sidebar'，Hippo Browser 右侧对话栏）：窄栏是"边看网页边问"的陪伴位，
          // 不是开发工作台 —— 思考原文 + 逐条工具行会把答复挤出视野，故本档不进食过程明细，
          // 过程区只留一行概览（TraceProcessSummary 的 compact 态）。画布节点 isSidebar 恒 false，不受影响。
          const traceThinkText = isSidebar ? '' : thinkText;

          // AI 回复：显示完整内容 + .md 附件卡片
          // 完成态判定：仅"当前正在流式的消息"按未完成渲染（纯文本），
          // 其余 assistant 消息（含历史加载的消息）恒为完成态，避免流式期间旧消息回退为纯文本/丢失卡片。
          // 完成态与正文是否非空、是否错误无关：空正文（只调工具）也按完成态渲染产物卡片；
          // 错误消息也按完成态渲染（保留操作行、剥离元数据标记），仅视觉标红。
          const msgFinished = msg.id !== streamingMsgId || !isStreaming;
          const isAssistantDone = msg.role === 'assistant' && msgFinished;
          const isErrorMsg = msg.role === 'assistant' && isErrorReply(cleanContent);

          // Step 11: 剥离 citations 元数据块（模型回答末尾的引用来源），渲染引用面板
          const citationParsed = isAssistantDone ? parseCitations(cleanContent) : null;
          const citationClean = citationParsed ? citationParsed.cleanContent : cleanContent;
          const citations = citationParsed ? citationParsed.citations : [];

          // Step 12: 从正文提取 OutputFile: 行 → 与 SSE 文件合并（工具结果未回传 SSE 时，正文行是唯一线索）
          const inlineFilesParsed = isAssistantDone ? extractOutputFileBlocks(citationClean) : null;
          const mergedOutputFiles = mergeOutputFiles(msg.outputFiles, inlineFilesParsed?.files ?? []);

          // OutputFile 均来自当前节点自身的工具调用结果（产物统一写 homework/ 根，按节点归属由后端清册维护），直接展示
          // Trae 式图片内联：项目内相对路径（homework/ materials/）的图片产物不进入文件框，
          // 直接内联显示在正文（点击放大）；~/ 与绝对路径等外部图片仍由文件框管理（可本地打开）
          const isInlineImage = (f: OutputFileItem) => {
            const p = f.path.replace(/\\/g, '/');
            return f.kind === 'image' && !p.startsWith('~/') && !p.startsWith('/');
          };
          const imageFiles = mergedOutputFiles.filter(isInlineImage);
          const nonImageFiles = mergedOutputFiles.filter((f) => !isInlineImage(f));
          // Step 13: 剥离 AUTH_REQ: 标记行（路径已自动 authorize_root 授权到 AI 可读写白名单，此处仅渲染授权提示卡片）
          const authParsed = isAssistantDone ? extractAuthReqs(inlineFilesParsed?.cleanContent ?? citationClean) : null;
          const authReqs = authParsed ? authParsed.paths : [];
          // 用户已给过的路径会自动授权，不再弹请求卡；未给过的路径展示授权请求卡片，由用户一键批准
          const pendingAuthReqs = authReqs.filter((p) => {
            const key = normAuthPath(p);
            return !userGivenPaths.some((u) => {
              const nu = normAuthPath(u);
              return nu === key || nu.startsWith(key + '/') || key.startsWith(nu + '/');
            });
          });
          const citationDisplay = authParsed ? authParsed.cleanContent : (inlineFilesParsed ? inlineFilesParsed.cleanContent : citationClean);

          // Step 14: Research 开关的候选来源清单 —— 报告本身一行 + 本轮真实读过的网页（取自工具调用记录，
          // 非模型自述）。两者同卡同勾选，由用户决定哪些进 materials/。
          // 仅 Hippo 侧边栏开关打开时出现，画布节点与开关关闭时恒为空数组
          const collectedSources = isAssistantDone && researchMode
            ? collectResearchSources(msg.toolCalls)
            : [];
          const reportSource = isAssistantDone && researchMode
            ? buildReportSource(citationDisplay, id)
            : null;
          const researchSources = reportSource ? [reportSource, ...collectedSources] : collectedSources;
          // 正文里「本轮真读过」的链接标注（hover 弹窗）。必须从 collectedSources 建映射：
          // 它按 toolCalls 身份缓存、跨渲染身份稳定，而 researchSources 是每帧新建的数组字面量 ——
          // 用它当缓存键会每次落空，新 Map 让 HtmlRenderer 的 memo 失效、innerHTML 反复重写打散划词选区
          const readSourceMap = collectedSources.length > 0 ? buildReadSourceMap(collectedSources) : undefined;

          // Trae 式简单渲染：正文完整直出，不做任何折叠/剥离
          const bodyContent = citationDisplay;

          const msgMatchedSkills = matchedSkillsByMsg[msg.id] ?? [];
          const msgUsage = usageByMsg[msg.id];
          const msgStats = statsByMsg[msg.id];
          const msgPrefixHash = prefixHashByMsg[msg.id];
          const msgPrefixChanged = !!prefixChangedByMsg[msg.id];
          const msgPrefixSegs = prefixSegsByMsg[msg.id];
          const msgPrefixSegChanged = prefixSegChangedByMsg[msg.id];
          // 对话视图是否展示紧凑「执行过程」摘要（思考 / 工具 / 技能任一存在即可）
          // 多智能体协作的过程（成员分工 / 群聊流 / 产出）不在这里出现，只在团队视图呈现
          const hasInlineTrace = msg.role === 'assistant'
            && ((msg.toolCalls?.length ?? 0) > 0
              || msgMatchedSkills.length > 0
              || !!traceThinkText);
          // 是否存在执行步骤数据（工具调用或历史过程叙述）——Final Answer 分隔线判定用
          const hasStepData = (msg.toolCalls && msg.toolCalls.length > 0)
            || (msg.processNarration && msg.processNarration.trim().length > 0);

          return (
          <div
            key={msg.id}
            data-msg-node
            ref={msg.role === 'user' ? (el) => {
              if (el) userMsgRefs.current.set(msg.id, el);
              else userMsgRefs.current.delete(msg.id);
            } : undefined}
            className={cn(
              'flex flex-col',
              msg.role === 'user' ? 'items-end' : 'items-start',
            )}
          >

            {/* 品牌标识头（AI 图标 + BobWork）：AI 回复问题时出现在回答开头 */}
            {msg.role === 'assistant' && (
              <div className="mb-1 flex shrink-0 items-center gap-1.5">
                <img
                  src="/ai-icon.png"
                  alt="BobWork"
                  className="h-[18px] w-[18px] shrink-0 rounded-full object-cover"
                  draggable={false}
                />
                <span className="text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>BobWork</span>
              </div>
            )}

            {/* 图片识别进度：识别延后到流内执行（首字节前提速），持续推送进度事件，用户可见而非干等 */}
            {msg.role === 'assistant' && msg.id === streamingMsgId && isStreaming && visionProgress && visionProgress.phase === 'image' && visionProgress.total > 0 && (
              <div className="mb-1 flex w-full items-center gap-1.5 text-10" style={{ color: 'var(--primary-strong)' }}>
                <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary-strong)' }} />
                <span>Recognizing image {visionProgress.current}/{visionProgress.total}...</span>
                <span className="flex items-center gap-0.5">
                  <span className="think-dot" />
                  <span className="think-dot" />
                  <span className="think-dot" />
                </span>
              </div>
            )}

            {/* OCR 过程级进度（bob-ocr-mcp 实时上报）：显示当前引擎（本地 Vision / GLM-OCR / Online OCR / VLM）+ 页码 */}
            {msg.role === 'assistant' && msg.id === streamingMsgId && isStreaming && visionProgress && visionProgress.phase === 'ocr' && visionProgress.total > 0 && (
              <div className="mb-1 flex w-full items-center gap-1.5 text-10" style={{ color: 'var(--primary-strong)' }}>
                <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary-strong)' }} />
                <span>
                  OCR page {visionProgress.current}/{visionProgress.total}
                  {' · '}
                  {visionProgress.engine === 'local-vision'
                    ? 'Local Vision'
                    : visionProgress.engine === 'glm-ocr'
                      ? 'GLM-OCR'
                      : visionProgress.engine === 'online-ocr'
                        ? 'Online OCR'
                        : visionProgress.engine === 'vlm'
                          ? 'VLM Vision'
                          : '…'}
                  {visionProgress.model ? ` (${visionProgress.model})` : ''}
                </span>
                <span className="flex items-center gap-0.5">
                  <span className="think-dot" />
                  <span className="think-dot" />
                  <span className="think-dot" />
                </span>
              </div>
            )}

            {/* Token 消耗：本轮任务累计真实 usage（仅完成且采集到数据时显示）；置于 Trajectory 上方，避免被长轨迹顶下去 */}
                    {msgUsage && (msgUsage.promptTokens > 0 || msgUsage.completionTokens > 0) && (
                      <div
                        className="flex items-center gap-1.5 px-0.5 text-xs"
                        style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}
                        title={`${msgUsage.calls} model call${msgUsage.calls !== 1 ? 's' : ''} this task`}
                      >
                        <Gauge className="h-2.5 w-2.5 shrink-0" style={{ color: 'var(--info)' }} />
                        <span className="font-semibold" style={{ color: 'var(--info)' }}>
                          {(msgUsage.promptTokens + msgUsage.completionTokens).toLocaleString()}
                        </span>
                        <span>tokens</span>
                        {msgUsage.promptTokens > 0 && (
                          <span className="opacity-70">· in {msgUsage.promptTokens.toLocaleString()}</span>
                        )}
                        {msgUsage.completionTokens > 0 && (
                          <span className="opacity-70">· out {msgUsage.completionTokens.toLocaleString()}</span>
                        )}
                        {msgUsage.cacheHitTokens + msgUsage.cacheMissTokens > 0 && (
                          <span
                            className="opacity-80"
                            title={`cache hit ${msgUsage.cacheHitTokens.toLocaleString()} / miss ${msgUsage.cacheMissTokens.toLocaleString()} (prefix cache, DeepSeek etc.)`}
                          >
                            · cached {Math.round((msgUsage.cacheHitTokens / (msgUsage.cacheHitTokens + msgUsage.cacheMissTokens)) * 100)}%
                          </span>
                        )}
                        {/* 缓存头指纹 / 降档 / ttft / tok/s 是开发诊断向元数据：侧边栏窄栏不展示（保留 token 用量行） */}
                        {!isSidebar && msgPrefixHash && (
                          <span
                            className="opacity-80"
                            style={msgPrefixChanged ? { color: 'var(--warning)' } : undefined}
                            title={(() => {
                              if (!msgPrefixChanged) return '缓存头指纹稳定：与上一任务前缀一致，前缀缓存可命中';
                              const segC = msgPrefixSegChanged;
                              const drift: string[] = [];
                              if (segC?.tools) drift.push('tools 工具集变化（MCP 增删/技能激活）');
                              if (segC?.toolsByte && !segC.tools) drift.push('tools 发送顺序漂移');
                              if (segC?.history) drift.push('history 历史段变化（裁剪/折叠/新对话）');
                              const hint = drift.length > 0 ? drift.join('；') : 'system 段变化';
                              return `⚠ 缓存头已变化（vs 上一任务）→ 前缀缓存失效，本轮按全价计费\n${hint}`;
                            })()}
                          >
                            · head {msgPrefixHash.slice(0, 8)}
                          </span>
                        )}
                        {!isSidebar && msgPrefixSegs && msgPrefixChanged && msgPrefixSegChanged && (
                          <span className="opacity-80" style={{ color: 'var(--warning)' }}>
                            {msgPrefixSegChanged.tools ? ` tools+` : ''}
                            {msgPrefixSegChanged.toolsByte && !msgPrefixSegChanged.tools ? ' order+' : ''}
                            {msgPrefixSegChanged.history ? ' history+' : ''}
                          </span>
                        )}
                        {!isSidebar && msgStats && msgStats.durationMs > 0 && (
                          <span className="opacity-70" title={`TTFT ${msgStats.ttftMs === null ? 'n/a' : msgStats.ttftMs + 'ms'} · total ${(msgStats.durationMs / 1000).toFixed(1)}s`}>
                            · ttft {msgStats.ttftMs === null ? '—' : msgStats.ttftMs < 1000 ? `${Math.round(msgStats.ttftMs)}ms` : `${(msgStats.ttftMs / 1000).toFixed(1)}s`}
                            · {msgStats.tokensPerSec} tok/s
                          </span>
                        )}
                        {/* 思考决策可见性（方向 D）：实际执行轮降档 / C1 琐碎关思考命中，仅在发生过时显示 */}
                        {!isSidebar && msgStats?.thinking && msgStats.thinking.downgradedRounds > 0 && (
                          <span
                            className="opacity-75"
                            title={`用户档位 ${msgStats.thinking.level || ''}：执行轮按策略降档以省 reasoning tokens（配置 thinking.downgradeOnExecution）`}
                          >
                            · 思考 {msgStats.thinking.level || ''}（执行轮降档 ×{msgStats.thinking.downgradedRounds}）
                          </span>
                        )}
                        {!isSidebar && msgStats?.thinking?.trivialOff && (
                          <span className="opacity-75" title="琐碎问答自动关闭思考省 token（配置 thinking.trivialPromptOff）">
                            · C1 琐碎关思考
                          </span>
                        )}
                      </div>
                    )}

            {/* 对话视图「执行过程」紧凑摘要：Think 小条 + 每工具一行 + 技能药丸；
                点击 Think / 工具行就地展开明细（思考原文 / 参数 / 结果），无需切换到 Trace */}
            {msg.role === 'assistant' && hasInlineTrace && (
              <TraceProcessSummary
                thinkText={traceThinkText}
                toolCalls={msg.toolCalls ?? []}
                skillNames={msgMatchedSkills}
                isStreaming={msg.id === streamingMsgId && isStreaming}
                thinkingActive={msg.id === streamingMsgId && isStreaming && stageKind === 'thinking'}
                hideStructuralTools={msg.id === streamingMsgId && isStreaming}
                compact={isSidebar}
              />
            )}

            {/* No tools indicator — 只在无思考、无工具调用、无技能加载、非错误消息的完整回复时显示 */}
            {!showThinkBlock && !(msg.toolCalls && msg.toolCalls.length > 0) && msgMatchedSkills.length === 0 && msg.role === 'assistant' && !isStreaming && cleanContent && !isErrorMsg && (
              <div className="mb-1 w-full">
                <div
                  className="flex items-center gap-1.5 text-xs"
                  style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)' }}
                  title="No tools were used for this response"
                >
                  <Wrench className="h-2.5 w-2.5" />
                  <span>No tools</span>
                </div>
              </div>
            )}


            {/* 实时「当前动作」条：流式中指示正在做什么（思考 / 正在调用的工具+目的 / 写答案）。
                置于过程区末尾、正文（Final Answer）之上：思考/调工具阶段它是回复最底部一条，
                开始写答案后固定在答案上方；完成后消失。
                Sidebar 档改走 WaitingHint：额外带秒表 + 按时长轮换的安抚话（窄栏久等易误判卡死），
                且流式刚发起（首 token 未到、尚无阶段）就出现 —— 那段静默正是最像"卡住"的窗口 */}
            {isSidebar && msg.role === 'assistant' && msg.id === streamingMsgId && isStreaming ? (
              <WaitingHint label={currentActionText} since={stageSince} />
            ) : currentActionText && (
              <div
                className="mb-1 flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5"
                style={{
                  backgroundColor: 'transparent',
                  borderColor: 'var(--ink-strong)',
                }}
              >
                <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" style={{ color: 'var(--primary-strong)' }} />
                <span className="min-w-0 truncate text-11 font-medium" style={{ color: 'var(--primary-strong)' }}>
                  {currentActionText}
                </span>
              </div>
            )}

            {/* Message bubble wrapper */}
            <div className={cn('relative group/msg-container', msg.role === 'user' ? 'ml-auto max-w-[85%]' : 'w-full')}>
              {/* Widget 消息（assistant + 含 widget）：不套气泡，直接满宽展示
                  流式期间（!isAssistantDone）也渲染已完整的 widget 块；末尾未闭合的块用骨架屏占位 */}
              {msg.role === 'assistant' && hasWidgetBlocks(bodyContent) ? (
                <div className="flex w-full flex-col gap-0.5">
                  {/* 附件 chips：与气泡分支一致（widget 分支同样展示，避免附件丢失） */}
                  <AttachmentChips attachments={msg.attachments ?? []} role={msg.role} />
                  <ReferenceChips references={msg.references ?? []} role={msg.role} />
                  {parseWidgetBlocks(bodyContent).map((block, i) =>
                    block.kind === 'text' ? (
                      /* Trae 风格：流式期间即用 markdown 渲染，完成时不切换引擎，消除割裂感 */
                      <StreamingMarkdown key={i} content={block.content} streaming={!isAssistantDone} />
                    ) : (
                      <WidgetRenderer key={i} widget={block.widget} />
                    ),
                  )}
                  {!isAssistantDone && hasOpenWidgetFence(bodyContent) && <WidgetSkeleton />}
                  {/* 完成后的附属内容（产物/授权/引用）：与气泡分支一致，仅完成态渲染 */}
                  {isAssistantDone && (
                    <>
                      <InlineImages files={imageFiles} projectId={typeof data?.projectId === 'string' ? data.projectId : undefined} />
                      {nonImageFiles.length > 0 && (
                        <OutputFilesCard files={nonImageFiles} projectId={typeof data?.projectId === 'string' ? data.projectId : undefined} />
                      )}
                      {pendingAuthReqs.length > 0 && (
                        <AuthReqCard paths={pendingAuthReqs} />
                      )}
                      {researchSources.length > 0 && (
                        <ResearchSourcesCard sources={researchSources} nodeId={id} />
                      )}
                      <CitationsPanel citations={citations} onOpenNode={(nid) => onOpenReader?.(nid)} />
                    </>
                  )}
                </div>
              ) : (
              <div
                className={cn(
                  'group/msg rounded-lg px-3 py-1.5 text-sm leading-relaxed',
                )}
                style={{
                  // 回复内容不加背景色（透明）；user 消息用 paper-hover 区分，错误消息保留危险色提示
                  backgroundColor:
                    msg.role === 'user'
                      ? 'var(--paper-hover)'
                      : isErrorMsg
                        ? 'color-mix(in oklab, var(--danger-soft) 80%, transparent)'
                        : 'transparent',
                  color:
                    msg.role === 'user'
                      ? 'var(--ink)'
                      : isErrorMsg
                        ? 'var(--danger)'
                        : 'var(--ink-strong)',
                }}
              >
                <AttachmentChips attachments={msg.attachments ?? []} role={msg.role} />
                <ReferenceChips references={msg.references ?? []} role={msg.role} />
                {cleanContent ? (
                  <>
                    {/* Trae 风格统一渲染：流式和完成态都用 StreamingMarkdown（HtmlRenderer 节流），
                         消除"先纯文本 span → 再 DocEditor 富文本"的割裂感。
                         用户消息仍用纯文本（无需 markdown）。 */}
                    {msg.role === 'user' ? (
                      <span className="whitespace-pre-line break-words">
                        {cleanContent}
                      </span>
                    ) : (
                      <>
                        {/* 结果分隔仪式：本轮执行过工具（或历史消息带过程叙述）时，
                             在正式交付物正文之前插入品牌紫"Final Answer"分隔线，让用户明确感知"过程结束、结果开始" */}
                        {hasStepData && (
                          <div className="my-1.5 flex select-none items-center gap-2">
                            <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg, transparent, color-mix(in oklab, var(--primary) 35%, transparent))' }} />
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-px text-10 font-semibold tracking-wide uppercase"
                              style={{
                                color: 'var(--primary)',
                                backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                                border: '1px solid color-mix(in oklab, var(--primary) 30%, transparent)',
                              }}
                            >
                              <Sparkles className="h-2.5 w-2.5" />
                              Final Answer
                            </span>
                            <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg, color-mix(in oklab, var(--primary) 35%, transparent), transparent)' }} />
                          </div>
                        )}
                        <StreamingMarkdown
                          content={bodyContent}
                          streaming={!isAssistantDone}
                          readSources={readSourceMap}
                        />
                      </>
                    )}
                  </>
                ) : (isStreaming && !showThinkBlock) ? (
                  <span className="inline-flex items-center gap-1 py-0.5">
                    <span
                      className="h-1.5 w-1.5 animate-bounce rounded-full"
                      style={{
                        backgroundColor: 'var(--primary-strong)',
                        animationDelay: '0ms',
                      }}
                    />
                    <span
                      className="h-1.5 w-1.5 animate-bounce rounded-full"
                      style={{
                        backgroundColor: 'var(--primary-strong)',
                        animationDelay: '150ms',
                      }}
                    />
                    <span
                      className="h-1.5 w-1.5 animate-bounce rounded-full"
                      style={{
                        backgroundColor: 'var(--primary-strong)',
                        animationDelay: '300ms',
                      }}
                    />
                  </span>
                ) : null}
                {/* 完成后的附属内容（产物/引用/授权）：置于 cleanContent 三元之外，
                     空正文的完成态消息（只调工具未写正文）也能展示产物卡片，不再常驻加载动画 */}
                {isAssistantDone && msg.role === 'assistant' && (
                  <>
                    <InlineImages files={imageFiles} projectId={typeof data?.projectId === 'string' ? data.projectId : undefined} />
                    {nonImageFiles.length > 0 && (
                      <OutputFilesCard files={nonImageFiles} projectId={typeof data?.projectId === 'string' ? data.projectId : undefined} />
                    )}
                    {pendingAuthReqs.length > 0 && (
                      <AuthReqCard paths={pendingAuthReqs} />
                    )}
                    {researchSources.length > 0 && (
                      <ResearchSourcesCard sources={researchSources} nodeId={id} />
                    )}
                    <CitationsPanel citations={citations} onOpenNode={(nid) => onOpenReader?.(nid)} />
                  </>
                )}
              </div>
              )}
              {/* 用户消息：时间 + 复制 + 删除按钮在文字下方 */}
              {msg.role === 'user' && cleanContent && (
                <div className="flex items-center justify-end gap-1 mt-1 opacity-0 group-hover/msg-container:opacity-100 transition-opacity">
                  {msg.timestamp && (
                    <span
                      className="text-xs leading-none select-none"
                      style={{ color: 'color-mix(in oklab, var(--ink-muted) 45%, transparent)' }}
                    >
                      {formatMsgTime(msg.timestamp)}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyText(msg.content).then((ok) => {
                        if (ok) {
                          setCopiedMsgId(msg.id);
                          setTimeout(() => setCopiedMsgId(null), 1500);
                        }
                      });
                    }}
                    className="flex items-center justify-center rounded p-1 transition-colors hover:bg-black/5"
                    style={{ color: 'var(--ink-muted)' }}
                    title="Copy"
                  >
                    {copiedMsgId === msg.id ? (
                      <ClipboardCheck className="h-3.5 w-3.5" style={{ color: 'var(--primary-strong)' }} />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteRound(messages.indexOf(msg));
                    }}
                    className="flex items-center justify-center rounded p-1 transition-colors hover:bg-black/5"
                    style={{ color: 'color-mix(in oklab, var(--danger) 60%, transparent)' }}
                    title="Delete this round"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {/* AI 消息：复制 + 重试按钮在文字下方（常驻显示，更易发现）
                  relative z-10：确保按钮层级高于正文（DocEditor/引用面板），避免被尾部元素覆盖导致部分区域点不到
                  重做 + 模型 + 思考强度：isAssistantDone 即显示（即使无正文，失败时也能重试）
                  复制：仅 cleanContent 非空时显示（无内容可复制） */}
              {msg.role === 'assistant' && isAssistantDone && (
                <div className="relative z-10 flex items-center gap-1 mt-1 opacity-70 hover:opacity-100 transition-opacity">
                  {cleanContent && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // 复制剥离后的正文（不含 think/CITATIONS/OutputFile/AUTH_REQ 等元信息），与显示一致
                        void copyText(bodyContent).then((ok) => {
                          if (ok) {
                            setCopiedMsgId(msg.id);
                            setTimeout(() => setCopiedMsgId(null), 1500);
                          }
                        });
                      }}
                      className="flex min-w-6 min-h-6 items-center justify-center rounded-md p-1.5 transition-colors hover:bg-black/5"
                      style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}
                      title="Copy"
                    >
                      {copiedMsgId === msg.id ? (
                        <ClipboardCheck className="h-3.5 w-3.5" style={{ color: 'var(--primary-strong)' }} />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  {cleanContent && (
                    <ShareButton
                      onClick={() => setShareMsgId(shareMsgId === msg.id ? null : msg.id)}
                      disabled={isStreaming}
                    />
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRegenerate(messages.indexOf(msg));
                    }}
                    disabled={isStreaming}
                    className="flex min-w-6 min-h-6 items-center justify-center rounded-md p-1.5 transition-colors hover:bg-black/5 disabled:opacity-30"
                    style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}
                    title="Regenerate"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                  {/* 消息级元数据标签：本条回复实际使用的模型 + 思考等级（历史消息无记录时显示 Auto，不再引用节点当前配置，避免调整模型影响已发送轮次） */}
                  {(() => {
                    const metaModel = msg.modelId ?? '';
                    const metaLevel = (msg.thinkingLevel ?? data.thinkingLevel ?? DEFAULT_THINKING_LEVEL) as ThinkingLevel;
                    const metaModelOpt = metaModel ? availableModels.find((mm) => mm.modelId === metaModel) : undefined;
                    const metaLabel = metaModelOpt
                      ? metaModelOpt.label
                      : (metaModel || 'Auto');
                    const levelLetter = THINKING_LEVEL_LETTER[metaLevel];
                    // 档位色阶（S2b）：off 灰 / low·legacy medium 信息蓝 / high 紫蓝过渡 / max 品牌紫强调
                    const levelColor = THINKING_LEVEL_COLOR[metaLevel];
                    const levelName = THINKING_LEVELS.find((l) => l.value === metaLevel)?.label ?? metaLevel;
                    const metaExpanded = expandedMetaId === msg.id;
                    return (
                      <span
                        className={`ml-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-px text-xs font-medium leading-none select-none ${metaExpanded ? '' : 'max-w-[110px] overflow-hidden'} cursor-pointer hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]`}
                        style={{
                          backgroundColor: 'var(--paper)',
                          color: 'var(--ink)',
                          border: '1px solid color-mix(in oklab, var(--line) 35%, transparent)',
                        }}
                        title={metaExpanded
                          ? '点击收起'
                          : `${metaLabel}${` · ${levelName}`}${msg.timestamp ? ` · ${msg.timestamp}` : ''}（点击展开完整名称）`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedMetaId(metaExpanded ? null : msg.id);
                        }}
                      >
                        <span className={metaExpanded ? '' : 'truncate'}>{metaLabel}</span>
                        <span
                          className="inline-flex h-[11px] min-w-[11px] shrink-0 items-center justify-center rounded-full px-[2px] text-xs font-bold leading-none text-white"
                          style={{ backgroundColor: levelColor }}
                        >
                          {levelLetter}
                        </span>
                      </span>
                    );
                  })()}
                  {/* 上下文占用环（dsh ContextMeter）：本条回复末尾最右侧，点击看明细 */}
                  <div className="ml-auto flex items-center">
                    <ContextMeter meter={composerCtxMeter} />
                  </div>
                </div>
              )}
              {/* Share 卡片预览面板（内联展开，无遮罩） */}
              {shareMsgId === msg.id && cleanContent && (() => {
                const msgIdx = messages.indexOf(msg);
                let question = '';
                for (let i = msgIdx - 1; i >= 0; i--) {
                  if (messages[i].role === 'user') {
                    question = messages[i].content || '';
                    break;
                  }
                }
                const metaModelShare = msg.modelId ?? '';
                const metaModelOptShare = metaModelShare ? availableModels.find((mm) => mm.modelId === metaModelShare) : undefined;
                const shareModelLabel = metaModelOptShare ? metaModelOptShare.label : (metaModelShare || 'Auto');
                const shareLevel = (msg.thinkingLevel ?? data.thinkingLevel ?? DEFAULT_THINKING_LEVEL) as ThinkingLevel;
                const shareLevelLetter = THINKING_LEVEL_LETTER[shareLevel];
                return (
                  <ShareCard
                    question={question}
                    answer={bodyContent || ''}
                    modelLabel={shareModelLabel}
                    levelLetter={shareLevelLetter}
                    nodeId={currentMdId}
                    open
                    onClose={() => setShareMsgId(null)}
                  />
                );
              })()}
            </div>
          </div>
          );
        })}
        </MessagesErrorBoundary>
</>);

  const inputInner = (
      <div
        ref={inputBoxRef}
        className={cn(
          'nodrag relative mx-auto mb-3 flex w-full flex-col rounded-2xl p-2 pb-1.5 transition-all',
          dragOver && 'ring-2',
        )}
        style={{
          // 空态欢迎区（新建/清空）跨正文列放大输入框（TraeWork 式），有内容时与正文阅读列同宽；
          // 空态欢迎区按输入框 70%（缩小 30%）控制：1040 → 728
          maxWidth: messages.length === 0 ? 'min(100%, 728px)' : 'min(100%, 800px)',
          border: dragOver
            ? '1px solid color-mix(in oklab, var(--primary) 50%, transparent)'
            : '1px solid var(--line)',
          backgroundColor: dragOver
            ? 'color-mix(in oklab, var(--primary) 6%, transparent)'
            : 'var(--paper)',
        }}
        // 拖入文件即附件：侧边栏不上传附件（paperclip 入口与粘贴图片同样已关），故不挂拖放处理
        onDragOver={isSidebar ? undefined : handleDragOver}
        onDragLeave={isSidebar ? undefined : handleDragLeave}
        onDrop={isSidebar ? undefined : handleDrop}
        // 阻止 click 冒泡：输入栏内点击不得触发节点级 onNodeClick（避免被当作"点击节点"处理）
        onClick={(e) => e.stopPropagation()}
      >
        {/* 勾选的 skill / MCP 胶囊标签已并入输入框内（见 inputInner 输入容器） */}

        {/* 待发送附件 + 链接材料标签（chat 与 team 共用组件；@ 文件引用 chip 内嵌于输入框） */}
        <ComposerChips
          attachments={pendingAttachments}
          links={pendingLinks}
          onRemoveAttachment={removePendingAttachment}
          onRemoveLink={removePendingLink}
        />

        {/* @ mention 弹窗（chat 与 team 共用组件） */}
        <MentionMenu
          open={mentionOpen}
          menuRef={mentionRef}
          dir={mentionDir}
          dirItems={mentionDirItems}
          dirLoading={mentionDirLoading}
          query={mentionQuery}
          index={mentionIndex}
          authorizedRoots={authorizedRoots}
          onSelect={handleMentionSelect}
          onBack={goBackDir}
        />

        {/* 引用标签 — 在输入框上方 */}
        {referenceTag && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-full px-2.5 py-1 w-fit" style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)', border: '1px solid var(--primary-soft)' }}>
            <img src="/ai-icon.png" alt="" className="h-3.5 w-3.5 object-contain" />
            <span className="max-w-[200px] truncate text-xs" style={{ color: 'var(--danger)' }}>
              {referenceTag.text}
            </span>
            <button
              onClick={() => setReferenceTag(null)}
              className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-xs"
              style={{ color: 'var(--ink-muted)' }}
            >
              ×
            </button>
          </div>
        )}

        {/* 待发送队列横幅：执行期间加入的待办消息，当前任务结束后自动逐条发送 */}
        {pendingSendCount > 0 && (
          <div
            className="mb-1.5 flex items-center gap-1.5 rounded-md px-2.5 py-1.5"
            style={{
              backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)',
              border: '1px dashed var(--primary)',
            }}
          >
            <Clock size={12} className="shrink-0" style={{ color: 'var(--primary)' }} />
            <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--primary)' }}>
              {pendingSendCount === 1
                ? '1 message queued — will send when the current task finishes'
                : `${pendingSendCount} messages queued — will send when the current task finishes`}
            </span>
            <button
              onClick={() => {
                // 取消待发队列：消息回落回输入框，不停止当前任务
                const pending = pendingSendRef.current;
                pendingSendRef.current = [];
                setPendingSendCount(0);
                if (pending.length > 0) {
                  setLocalInput((prev) => (prev ? prev + '\n' : '') + pending.join('\n'));
                }
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-xs transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              title="Cancel queued message(s)"
            >
              ×
            </button>
          </div>
        )}

        {/* 输入区（已并入 inputInner 大容器）：文本编辑区 + 胶囊 */}
        <div
          className="transition-colors"
          onWheel={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            // 阻止 pointer 事件冒泡，避免三指手势拖动节点
            e.stopPropagation();
          }}
        >
          {(selectedSkills.size > 0 || enabledMcpIds.size > 0) && (
            <div className="flex flex-wrap items-center gap-1 px-2 pt-1.5">
              {Array.from(selectedSkills).map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-10 font-medium"
                  style={{
                    backgroundColor: 'var(--primary-soft)',
                    color: 'var(--primary-strong)',
                    border: '1px solid color-mix(in oklab, var(--primary) 25%, transparent)',
                  }}
                >
                  {name}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleSkill(name); }}
                    className="rounded-full p-px transition-opacity hover:opacity-60"
                    title={`Unforce skill ${name}`}
                  >
                    <X className="h-2 w-2" />
                  </button>
                </span>
              ))}
              {Array.from(enabledMcpIds).map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-10 font-medium"
                  style={{
                    backgroundColor: 'color-mix(in oklab, var(--info) 10%, transparent)',
                    color: 'var(--info)',
                    border: '1px solid color-mix(in oklab, var(--info) 30%, transparent)',
                  }}
                >
                  {mcpNameOf(id)}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleMcpServer(id); }}
                    className="rounded-full p-px transition-opacity hover:opacity-60"
                    title={`Unforce MCP ${mcpNameOf(id)}`}
                  >
                    <X className="h-2 w-2" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div
            ref={textareaRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            data-chat-input
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onPaste={isSidebar ? undefined : handlePaste}
            className={cn(
              'node-input flex-1 overflow-y-auto px-2 py-1.5 text-sm focus:outline-none',
            )}
            style={{
              minHeight: (selectedSkills.size > 0 || enabledMcpIds.size > 0) ? '64px' : '84px',
              maxHeight: '180px',
              color: 'var(--ink-strong)',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
              WebkitOverflowScrolling: 'touch',
              touchAction: 'pan-y',
            }}
            onFocus={() => {
              // 标记最近聚焦节点：全局截图 OCR（Cmd+Shift+O）结果插入本输入框
              setScreenOcrFocus(id);
            }}
          />
        </div>

        {/* 底部工具行：已收进大输入框容器内底部（附件/技能/指令/MCP/推理/模型/发送） */}
        <div className="mt-0.5 flex items-center justify-between gap-2 px-0.5">
          {/* 左侧：附件 + 技能 + 目录标签 */}
          <div className="flex min-w-0 items-center gap-1.5">
            {/* 附件入口只在画布节点提供：浏览器对话栏是纯浏览器面，不承担上传附件 */}
            {!isSidebar && (
            <label
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors disabled:opacity-50"
              style={{
                backgroundColor: 'var(--paper-hover)',
                color: 'var(--ink-muted)',
              }}
              title="Attach"
              onMouseEnter={(e) => {
                if (!isStreaming && !uploadingAttachment) {
                  e.currentTarget.style.backgroundColor = 'var(--paper-hover)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--paper-hover)';
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="absolute opacity-0 pointer-events-none"
                style={{ width: 0, height: 0 }}
                onChange={(e) => {
                  handleFileSelect(e.target.files);
                  e.target.value = '';
                }}
                disabled={isStreaming || uploadingAttachment}
              />
              {uploadingAttachment ? (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
            </label>
            )}

            {/* 技能菜单：入口只有输入框内输入 "/"（见 handleKeyDown），不再放独立按钮 */}
            {availableSkills.length > 0 && (
              <div className="relative" ref={skillMenuRef}>
                {skillMenuOpen && (
                  <div
                    className="absolute bottom-full left-0 mb-1 rounded-xl border shadow-lg z-50 flex flex-col nowheel"
                    style={{
                      borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                      backgroundColor: 'var(--popover)',
                      width: '196px',
                      maxHeight: '320px',
                    }}
                  >
                    {/* 单列技能列表：系统 + 已下载/导入，按可用顺序平铺；超长仍可滚动但不显示滚动条 */}
                    <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
                      {availableSkills.map((s) => {
                        const checked = selectedSkills.has(s.name);
                        return (
                          <button
                            key={s.name}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSkill(s.name);
                            }}
                            title={s.description}
                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--paper-soft)]"
                          >
                            <span
                              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-xs"
                              style={{
                                backgroundColor: checked ? 'var(--primary)' : 'transparent',
                                borderColor: checked ? 'var(--primary)' : 'var(--ink-faint)',
                                color: '#fff',
                              }}
                            >
                              {checked && <Check className="h-2.5 w-2.5" />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1 flex-wrap">
                                <span className="text-xs font-medium truncate" style={{ color: 'var(--ink)' }}>
                                  {s.name}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                      {selectedSkills.size > 0 && (
                        <>
                          <div className="my-1 border-t" style={{ borderColor: 'var(--line)' }} />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              saveSkillsAsGlobalDefault();
                            }}
                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--paper-soft)]"
                            title="Save current selection as global default (other nodes follow this; unchecked ones disabled)"
                          >
                            <span className="text-xs font-medium" style={{ color: 'var(--primary-strong)' }}>
                              Set as global default
                            </span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 快捷指令管理 - 下拉菜单（全局库勾选 + 增删改）：带增删改的提示词库，
                侧边栏只做浏览器任务、用不上这套重 UI，故不提供（isSidebar） */}
            {!isSidebar && (
            <div className="relative" ref={quickPromptMenuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isStreaming) setQuickPromptMenuOpen((v) => !v);
                }}
                disabled={isStreaming}
                className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors disabled:opacity-50"
                style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}
                title="Quick prompts"
              >
                <Zap className="h-3.5 w-3.5" />
              </button>
              {quickPromptMenuOpen && (
                <div
                  className="absolute bottom-full left-0 mb-1 rounded-xl border shadow-lg z-50 flex flex-col nowheel"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                    backgroundColor: 'var(--popover)',
                    width: '320px',
                    maxHeight: '360px',
                  }}
                >
                  {quickPromptEditor ? (
                    /* 新建/编辑表单 */
                    <div className="flex flex-col gap-2 p-3">
                      <span className="text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>
                        {quickPromptEditor.mode === 'new' ? 'New quick prompt' : 'Edit quick prompt'}
                      </span>
                      <input
                        value={quickPromptEditor.name}
                        onChange={(e) => setQuickPromptEditor({ ...quickPromptEditor, name: e.target.value })}
                        placeholder="Name"
                        className="w-full rounded-md border px-2 py-1.5 text-xs outline-none"
                        style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink-strong)' }}
                      />
                      <input
                        value={quickPromptEditor.category}
                        onChange={(e) => setQuickPromptEditor({ ...quickPromptEditor, category: e.target.value })}
                        placeholder="Category (optional)"
                        className="w-full rounded-md border px-2 py-1.5 text-xs outline-none"
                        style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink-strong)' }}
                      />
                      <textarea
                        value={quickPromptEditor.content}
                        onChange={(e) => setQuickPromptEditor({ ...quickPromptEditor, content: e.target.value })}
                        placeholder="Prompt content — inserted into the input box on click"
                        rows={3}
                        className="w-full resize-none rounded-md border px-2 py-1.5 text-xs outline-none"
                        style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink-strong)' }}
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setQuickPromptEditor(null);
                          }}
                          className="rounded-md px-2.5 py-1 text-xs transition-colors hover:bg-[var(--paper-soft)]"
                          style={{ color: 'var(--ink-muted)' }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void saveQuickPrompt();
                          }}
                          disabled={!quickPromptEditor.name.trim() || !quickPromptEditor.content.trim()}
                          className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
                          style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* 指令列表 */
                    <>
                      <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}>
                        <span className="text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>Quick Prompts</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setQuickPromptEditor({ mode: 'new', name: '', content: '', category: '' });
                          }}
                          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors hover:bg-[var(--paper-soft)]"
                          style={{ color: 'var(--primary-strong)' }}
                          title="New quick prompt"
                        >
                          <ClipboardCheck className="h-3.5 w-3.5" /> New
                        </button>
                      </div>
                      <div className="overflow-y-auto py-1">
                        {quickPrompts.length === 0 && (
                          <div className="px-3 py-3 text-xs" style={{ color: 'var(--ink-muted)' }}>No quick prompts yet. Create one with New.</div>
                        )}
                        {quickPrompts.map((q) => (
                          <div
                            key={q.id}
                            onClick={() => {
                              applyQuickPrompt(q.content);
                              setQuickPromptMenuOpen(false);
                            }}
                            className="flex cursor-pointer items-center gap-2 px-2 py-1.5 transition-colors hover:bg-[var(--paper-soft)]"
                            title="Insert into input box"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>{q.name}</span>
                                {q.category && (
                                  <span className="shrink-0 rounded px-1 py-px text-10" style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)' }}>{q.category}</span>
                                )}
                              </div>
                              <div className="truncate text-11" style={{ color: 'var(--ink-muted)' }}>{q.content}</div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setQuickPromptEditor({ mode: 'edit', id: q.id, name: q.name, content: q.content, category: q.category || '' });
                              }}
                              className="shrink-0 rounded px-1 py-0.5 text-11 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-hover)]"
                              title="Edit"
                            >
                              Edit
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void deleteQuickPrompt(q.id);
                              }}
                              className="shrink-0 rounded px-1 py-0.5 text-11 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-hover)]"
                              title="Delete"
                            >
                              <Trash className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            )}

            {/* Materials 文件夹图标：无授权/操作目录时显示。侧边栏不上传/不引用本地文件，不提供 */}
            {!isSidebar && authorizedRoots.length === 0 && contextFolders.length === 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openMentionFromIcon();
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50"
                style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}
                title="Materials folder — pick a file to reference (type @ in the input)"
              >
                <Folder className="h-3.5 w-3.5" style={{ color: 'var(--primary-strong)' }} />
              </button>
            )}

            {/* 操作目录 / 授权目录（列表形式标签，直接显示文件夹名）；
                侧边栏已剔除文件工具，标签的「AI can read/write」语义不成立，故仅画布显示 */}
            {!isSidebar && (authorizedRoots.length > 0 || contextFolders.length > 0) && (
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1 overflow-hidden">
                {contextFolders.map((folder) => {
                  // 用户从本地文件面板一键发送的子文件夹：操作目录（锁定范围），用暖色小图标区分
                  const isUserSent = folder.id.startsWith('sent-folder:');
                  return (
                    <span
                      key={folder.id}
                      className="group inline-flex items-center gap-1 rounded-full px-1 py-0.5"
                      style={isUserSent ? {
                        backgroundColor: 'var(--primary-soft)',
                        border: '1px solid color-mix(in oklab, var(--primary) 30%, transparent)',
                      } : {
                        backgroundColor: 'rgba(83, 125, 150, 0.10)',
                        border: '1px solid rgba(83, 125, 150, 0.25)',
                      }}
                      // 仅图标展示，文件夹名称以弹窗显示
                      title={isUserSent
                        ? `Working directory (locked to this folder): ${folder.name} — ${folder.path}`
                        : `Working directory (AI can read/write): ${folder.name} — ${folder.path}`}
                    >
                      <Folder className={isUserSent ? 'h-2.5 w-2.5 shrink-0' : 'h-3 w-3 shrink-0'} style={{ color: isUserSent ? 'var(--primary-strong)' : '#537D96' }} />
                      <button
                        onClick={() => removeContextFolder(folder.id)}
                        className="ml-0.5 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}
                        title="Remove this working directory"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  );
                })}
                {authorizedRoots
                  .filter((root) => !contextFolders.some((f) => f.path === root))
                  .map((root) => (
                    <span
                      key={root}
                      className="group inline-flex items-center gap-1 rounded-full px-1 py-0.5"
                      style={{
                        backgroundColor: 'rgba(83, 125, 150, 0.06)',
                        border: '1px dashed rgba(83, 125, 150, 0.25)',
                      }}
                      title={root}
                    >
                      <Folder className="h-3 w-3 shrink-0" style={{ color: '#537D96' }} />
                      <button
                        onClick={() => revokeRootAuth(root)}
                        className="ml-0.5 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}
                        title="Revoke authorization"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
              </div>
            )}

            {/* 多智能体协作（Multi-agent mode）：点击弹出成员选择器（已安装 Agent 包勾选）；
                开启后本轮主 agent 可调用 team_run 编排多成员协作，与「团队」分栏是并行入口。
                侧边栏不提供：browser 画像 fixedScenes 只有 browser + ledger，team 工具根本不会注入，
                但服务端仍按开关注入 MULTI_AGENT_RULES —— 等于让模型去调一个不存在的工具（isSidebar） */}
            {!isSidebar && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!isStreaming) setMemberPickerOpen(true);
              }}
              disabled={isStreaming}
              className={cn(
                'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors disabled:opacity-50',
                multiAgentMode && 'ring-1',
              )}
              style={{
                backgroundColor: multiAgentMode ? 'var(--info-soft)' : 'var(--paper-hover)',
                color: multiAgentMode ? 'var(--info)' : 'var(--ink-muted)',
                borderColor: multiAgentMode ? 'color-mix(in oklab, var(--info) 30%, transparent)' : 'transparent',
              }}
              title={multiAgentMode
                ? `Multi-agent mode on${presetAgentIds.length > 0 ? ` · ${presetAgentIds.length} members` : ''} — click to change members or turn off`
                : 'Multi-agent mode — pick the installed Agent packages to take part in this run; if you pick none, the main agent plans the members and asks for your approval'}
            >
              <Users className="h-3.5 w-3.5" />
            </button>
            )}
          </div>

          {/* 右侧：推理强度 + 模型 + 发送 */}
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 推理强度选择器 */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isStreaming) setThinkingMenuOpen((v) => !v);
                }}
                disabled={isStreaming}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50"
                title={THINKING_LEVELS.find((l) => l.value === thinkingLevel)?.label ?? thinkingLevel}
                style={{ backgroundColor: 'var(--paper-hover)' }}
              >
                {/* 月相图标即档位本身：off=娥眉月🌒 / low=上弦🌓 / high=凸月🌔 / max=满月🌕（不再挂 O/L/H/X 角标） */}
                <MoonPhaseIcon level={thinkingLevel} size={17} className="shrink-0" />
              </button>
              {thinkingMenuOpen && (
                <div
                  ref={(el) => {
                    thinkingMenuRef.current = el;
                    if (el && !el.dataset.wheelFixed) {
                      el.dataset.wheelFixed = '1';
                      el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
                    }
                  }}
                  className="absolute bottom-full right-0 z-30 mb-1 w-28 rounded-xl border p-0.5 shadow-lg"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                    backgroundColor: 'var(--popover)',
                  }}
                >
                  {/* S2b 四档可选（legacy medium 仅存量显示，不进菜单） */}
                  {THINKING_LEVELS.filter((l) => l.value !== 'medium').map((lvl) => {
                const modelSupportsThinking = availableModels.find((m) => m.modelId === modelId)?.thinking ?? true;
                const isDisabled = !modelSupportsThinking;
                const levelSelected = thinkingLevel === lvl.value;
                return (
                <button
                  key={lvl.value}
                  title={isDisabled
                    ? 'Current model doesn\'t support thinking mode'
                    : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isStreaming && !isDisabled) {
                      handleThinkingLevelChange(lvl.value);
                      setThinkingMenuOpen(false);
                    }
                  }}
                  disabled={isStreaming || isDisabled}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-xs font-medium transition-colors"
                  style={{
                    color: isDisabled
                      ? 'var(--ink-faint)'
                      : levelSelected
                        ? 'var(--primary)'
                        : 'var(--ink)',
                    backgroundColor: levelSelected
                      ? 'var(--paper-hover)'
                      : 'transparent',
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!isDisabled && !levelSelected) {
                      e.currentTarget.style.backgroundColor = 'var(--paper-soft)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isDisabled && !levelSelected) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <MoonPhaseIcon
                      level={lvl.value}
                      size={14}
                      className="shrink-0"
                      style={{ opacity: isDisabled ? 0.4 : 1 }}
                    />
                    <span>{lvl.label}</span>
                  </span>
                  {levelSelected && <Check className="h-2.5 w-2.5" />}
                </button>
                );
              })}
            </div>
          )}
        </div>

            {/* 模型选择器 — 紧凑版本 */}
            <div className="relative" ref={modelMenuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isStreaming) setModelMenuOpen((v) => !v);
                }}
                disabled={isStreaming}
                className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: 'var(--paper-hover)',
                  color: 'var(--ink-muted)',
                }}
                title={dropdownModels.find((m) => m.modelId === modelId)?.label ?? modelId}
              >
                {/* 品牌 logo 取代此前的状态圆点（圆点只表「是否推理模型」，与旁边月相档位重复） */}
                <ModelBrandLogo modelId={modelId} size={13} />
                <span className="max-w-[200px] truncate">
                  {dropdownModels.find((m) => m.modelId === modelId)?.label ?? modelId}
                </span>
                <ChevronDown className="h-2.5 w-2.5 opacity-50" />
              </button>

              {modelMenuOpen && (
                <div
                  className="absolute bottom-full right-0 z-30 mb-1 max-h-64 w-40 overflow-y-auto rounded-xl border shadow-lg"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                    backgroundColor: 'var(--popover)',
                  }}
                >
                  {/* 模型平铺列表：不再按供应商分类 */}
                  {dropdownModels.length === 0 && (
                    <div className="px-2.5 py-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      No model configured. Add one in Settings → Models.
                    </div>
                  )}
                  {dropdownModels.map((m) => {
                    const parsed = parseCustomModel(m.modelId);
                    const providerType = parsed?.provider;
                    const providerCfg = providerType
                      ? providerConfigs.find((c) => c.type === providerType)
                      : undefined;
                    const presetBase = providerType
                      ? getProviderPreset(providerType as ProviderType)?.baseUrl
                      : '';
                    const baseUrl = sanitizeBaseUrl(providerCfg?.baseUrl || presetBase || '');
                    const isLocal = isLocalEndpointUrl(baseUrl);
                    let statusBadge: string | null = null;
                    if (parsed && !providerCfg) {
                      statusBadge = 'Unconfigured';
                    } else if (parsed && isLocal) {
                      const h = localHealth[parsed.provider];
                      if (h === 'down') statusBadge = 'Local offline';
                      else if (h === 'checking') statusBadge = 'Checking…';
                    }
                    return (
                    <button
                      key={m.modelId}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectModel(m.modelId);
                      }}
                      className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors"
                      style={{ backgroundColor: 'transparent' }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--paper-muted)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      <ModelBrandLogo modelId={m.modelId} size={13} className="mt-0.5" />
                      <div className="flex flex-1 flex-col">
                        <span
                          className="truncate text-xs font-medium"
                          style={{ color: 'var(--ink)' }}
                        >
                          {m.label}
                        </span>
                        {statusBadge && (
                          <span
                            className="mt-0.5 inline-flex w-fit items-center rounded px-1 py-px text-10 leading-none"
                            style={{
                              backgroundColor: 'color-mix(in oklab, var(--ink-faint) 14%, transparent)',
                              color: statusBadge === 'Local offline'
                                ? 'color-mix(in oklab, var(--danger) 80%, var(--ink-faint))'
                                : 'var(--ink-faint)',
                            }}
                          >
                            {statusBadge}
                          </span>
                        )}
                      </div>
                      {m.modelId === modelId && (
                        <Check
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          style={{ color: 'var(--primary)' }}
                        />
                      )}
                    </button>
                    );
                  })}
                  {/* 模型配置入口：打开设置弹窗并聚焦到 Chat Models 区块 */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setModelMenuOpen(false);
                      window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'roles' } }));
                    }}
                    className="mx-1.5 mb-1.5 flex w-[calc(100%-0.75rem)] items-center justify-center rounded-md px-2 py-1.5 transition-colors"
                    style={{ backgroundColor: 'var(--paper-muted)' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--paper-hover)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--paper-muted)';
                    }}
                  >
                    <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>
                      model settings
                    </span>
                  </button>
              </div>
          )}
        </div>

            {/* 语音输入（微信式）：点击开始录音 → 麦克风左侧**就地展开**一条录音条（实时音量波形 +
                计时 + ✕ 取消 / ✓ 完成），不覆盖输入框；录音结束服务端转文字回填输入框。
                录音本身不落盘（转写失败即丢弃）。条与按钮同排，展开方向自然朝左。
                侧边栏不提供：浏览器任务靠「看页面 + 打字追问」，键盘输入已足够（isSidebar） */}
            {!isSidebar && <VoiceRecordBar voice={voice} />}
            {!isSidebar && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                voice.start();
              }}
              disabled={isStreaming || voice.recording || voice.transcribing}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50"
              style={{
                backgroundColor: 'var(--paper-hover)',
                color: 'var(--ink-muted)',
              }}
              title="Voice note (record & transcribe to text)"
            >
              <Mic className="h-3.5 w-3.5" />
            </button>
            )}

            {/* 发送 / 停止按钮 — 最右侧：执行中且有输入 → 发送（走待办确认）；执行中无输入 → 停止 */}
            {isStreaming && !localInput.trim() ? (
              <button
                onClick={handleStop}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                style={{
                  backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)',
                  color: 'var(--danger)',
                }}
              >
                <span className="h-3 w-3 rounded-sm bg-current" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!localInput.trim() || availableModels.length === 0}
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
                )}
                style={{
                  backgroundColor: localInput.trim() && availableModels.length > 0
                    ? 'var(--primary)'
                    : 'var(--paper-hover)',
                  color: localInput.trim() && availableModels.length > 0
                    ? 'var(--paper)'
                    : 'color-mix(in oklab, var(--ink-muted) 50%, transparent)',
                }}
              >
                <ArrowUpCircle className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
);

  return (
    <div className="relative flex min-h-0 w-full h-full flex-col">
      {/* 划词操作窗：消息内容中选中文字后弹出。
          用 createPortal 挂到 body：React Flow 节点 wrapper 带 transform，直接渲染在节点内会使
          fixed 定位相对节点而非视口，导致弹窗远离高亮文字（经典 transform 包含块陷阱）。 */}
      {selectionMenu &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={selectionMenuRef}
            data-canvas-ui="overlay"
            className="fixed z-[600] flex items-center gap-1 rounded-xl border p-1 shadow-xl"
            style={{
              // 右边缘钳制：复制按钮 + Bot 按钮（图标态）≈ 90px 内容宽，留足余量
              left: Math.min(selectionMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 240),
              top: selectionMenu.y + 12,
              borderColor: 'color-mix(in oklab, var(--line) 35%, transparent)',
              backgroundColor: 'var(--popover)',
              fontFamily: 'var(--font-sans)',
            }}
            onMouseDown={(e) => {
              // 打标吞掉本次点击产生的 mouseup（防止附件同步关窗后二次弹窗）
              suppressNextMenuMouseUpRef.current = true;
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(selectionMenu.text).catch(() => {});
                // 复制反馈：图标短暂变 ✓，弹窗保持不消失（可继续附件等操作）
                setCopied(true);
                if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
                copyTimerRef.current = window.setTimeout(() => setCopied(false), 900);
              }}
              className="flex items-center justify-center rounded-lg px-2.5 py-1.5 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: copied ? 'var(--primary-strong)' : 'var(--ink)' }}
              title={copied ? '已复制' : '复制选中文字'}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" style={{ color: 'var(--primary-strong)' }} />
              ) : (
                <Copy className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
              )}
            </button>
            <button
              type="button"
              onClick={() => handleQuoteSelection(selectionMenu.text)}
              className="flex items-center justify-center rounded-lg px-2.5 py-1.5 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink)' }}
              title="将选中文字挂为输入框引用标签"
            >
              <Bot className="h-4 w-4" style={{ color: 'var(--ink-muted)' }} />
            </button>
          </div>,
          document.body,
        )}
      {/* 右侧「DOS 执行步骤」面板：消费 todo_write 三态真状态（goal + 状态轨 + activeForm 动态文案）；
          流式结束后保留 3 秒收尾停留（全绿/失败）再淡出 */}
      {planInfo && (isStreaming || planPanelLingering) && !planPanelClosed && (
        <TaskStepsPanel
          anchor={nodeWrapperRef.current}
          goal={planInfo.goal}
          steps={planInfo.steps}
          completed={planInfo.completed}
          running={planInfo.running}
          discarded={teamPlanDiscarded}
          onClose={() => setPlanPanelClosed(true)}
        />
      )}
      {/* 展开态外阴影层已移除（2026-09 布局重构：卡片铺满容器、统一浅色底，不再需要投影） */}
    <div
      ref={nodeWrapperRef}
      className={cn(
        'ai-node-wrapper group relative flex-1 min-h-0 cursor-default transition-[height] duration-300 ease-in-out',
        // 大面板自身建立横向裁剪：固定宽度下防止内容（如思考标签行的
        // shrink-0 不换行标签）抬升导致节点被内容撑宽
        // ai-node-expanded 标记类供 globals.css 壳列分离样式命中（正文列限宽 720px 居中 + 宽内容 breakout）
        'ai-node-expanded overflow-x-hidden',
      )}
      style={{
        // 宽度与对话容器同轮次布局：面板展开时随容器收缩，不再出现"外壳仍是旧宽度、被面板覆盖"的一帧
        width: '100%',
        height: '100%',
      }}
    >
      {/* 画布连线已物理移除（2026-09）：不再渲染左右 Handle 拖线；
          连线关系经标题栏链接图标查看、在 NodeMap 缩略图上管理。 */}
      {/* Inner card：
          min-width:0 + overflow-x:hidden 切断"长内容 min-content → 父节点 wrapper 被撑宽"的传递链
          （flex/grid 子项 flex-basis:auto 时 min-width 默认 auto=内容宽，这里显式归零） */}
      <div
        className={cn(
          'relative z-[1] flex w-full min-w-0 flex-col overflow-x-hidden transition-[box-shadow,border-color,background-color,opacity] duration-200',
          'h-full',
          // 画布节点是浮在灰底上的卡片；侧边栏是一块平整面板，不要圆角与四周描边
          !isSidebar && 'rounded-xl border',
          confirmPending && 'confirm-breathing',
        )}
        style={{
          // 2026-09-12 会话区改纯白：与灰色画布底 --canvas-bg 拉开对比，凸显会话卡片
          background: '#fff',
          // 2026-09 口径：去除身份高亮边框——所有 agent 统一中性边框，不再按 coding/Kar/Butler 染色
          borderColor: isSidebar ? undefined : 'color-mix(in oklab, var(--line) 45%, transparent)',
          // inset 高光减弱（淡灰底上原 18% 白光太突兀）；侧边栏无画布底，这道高光没有依据
          boxShadow: isSidebar ? undefined : 'inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent)',
        }}
      >
      {/* Header — Phase 2: 统一 NodeCardHeader 三段式骨架（左锚点 + 标题 + 右操作组） */}
      <NodeCardHeader
        divider={false}
        leftAnchor={
          <>
            {/* AI Coding 专项任务循环状态徽标（改码→预览自检→测试→完成） */}
            {isCoding && CODING_PHASE_UI[codingPhase] && (
              <span
                className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-10 font-medium"
                style={{ backgroundColor: `${CODING_PHASE_UI[codingPhase]!.color}22`, color: CODING_PHASE_UI[codingPhase]!.color }}
                title="AI Coding task loop"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: CODING_PHASE_UI[codingPhase]!.color }} />
                {CODING_PHASE_UI[codingPhase]!.label}
              </span>
            )}
            {/* AI Coding 徽标已移除：节点绑定 Bob Sandbox 小程序，通过节点标题/行为区分 */}
          </>
        }
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <TitleIdentityIcon
              className={cn('shrink-0', isBotTitleIcon ? 'h-4 w-4' : 'h-[15px] w-[15px]')}
              style={{ color: 'var(--ink-muted)' }}
            />
            <span className="inline-block max-w-full truncate">
              {/* 侧边栏的会话标题在工具条会话菜单里，此处不重复显示 */}
              {isSidebar ? '' : data.title}
            </span>
          </span>
        }
        rightActions={
          <>
            {/* 视图切换：主分栏只留 Chat / Team（Team = 多智能体协作工作台，唯一发起口，空会话也要能进），
                Trace（对话轨迹 / 历史回放）定位是「查看执行过程」，与另两者语义不同，拆成独立图标按钮：
                无外框、无底色（与标题栏其他图标按钮同款样式），仅靠与主分栏的间距区分，
                避免三个字数不等的文字标签挤在一个分段控件里 */}
            <div className="flex items-center gap-1.5">
              {/* 视图切换 Chat/Team：Team 工作台是画布分栏形态，侧边栏不提供该入口 */}
              {!isSidebar && (
                <div
                  className="flex items-center gap-0.5 rounded-lg border p-0.5"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--paper) 75%, transparent)',
                  }}
                >
                  {(['chat', 'team'] as const).map((k) => {
                    const active = pane === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setPane(k); }}
                        className={cn('flex h-5 cursor-pointer items-center rounded-md px-2 text-11 font-medium transition-colors', active ? '' : 'hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_70%,transparent)]')}
                        style={active
                          ? { backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)', color: 'var(--primary-strong)' }
                          : { color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
                        title={k === 'team' ? 'Team: launch multi-agent runs here, and watch member assignments / task progress / collaboration — you can interject and retry tasks' : 'Chat: this turn\'s conversation and the final answer'}
                      >
                        {k === 'chat' ? 'Chat' : 'Team'}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* 必须是来回切换：侧边栏已隐藏 Chat/Team 分段控件，这枚图标是从 Trace 回对话的唯一入口 */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setPane(pane === 'trace' ? 'chat' : 'trace'); }}
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: pane === 'trace' ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
                title={pane === 'trace' ? 'Back to chat' : "Trace: this conversation's execution trajectory and task replay"}
              >
                <ChartSpline className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* 连线关系入口：画布已物理移除连线（2026-09），关系经 NodeMap 查看/管理。
                点击 → NodeMap 展开并高亮本节点及其连线。 */}
            {!isSidebar && linkCount > 0 && (
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('nodemap-reveal-node', { detail: { nodeId: id } }))}
                className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title={`Connections (${linkCount}) — reveal in Node Map`}
              >
                <Link2 className="h-3.5 w-3.5" />
                <span
                  className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-7 font-bold leading-none"
                  style={{ backgroundColor: 'var(--primary-strong)', color: '#fff' }}
                >
                  {linkCount > 9 ? '9+' : linkCount}
                </span>
              </button>
            )}
            {/* Bob-Mind 未回看改动角标：面板手动改过导图，Buzan 还没看过（说话或点 Ask Buzan 后消失） */}
            {!isSidebar && isMind && mindChanges > 0 && (
              <span
                className="relative flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-7 font-bold leading-none"
                style={{
                  backgroundColor: 'color-mix(in oklab, var(--primary-strong) 12%, transparent)',
                  color: 'var(--primary-strong)',
                }}
                title={`Bob-Mind was edited ${mindChanges} time${mindChanges > 1 ? 's' : ''} and Buzan hasn't reviewed it yet`}
              >
                <Pencil className="h-3 w-3" />
                {mindChanges > 9 ? '9+' : mindChanges}
              </span>
            )}
            {/* 断线警告角标 */}
            {!isSidebar && hasDisconnectedUpstream && (
              <span
                className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                style={{ backgroundColor: 'color-mix(in oklab, var(--danger) 12%, transparent)' }}
                title="Upstream connection broken, context may be incomplete"
              >
                <AlertTriangle className="h-3 w-3" style={{ color: 'var(--danger)' }} />
              </span>
            )}
            {/* AI Coding 预览按钮：在小程序中打开预览 */}
            {!isSidebar && typeof data.sandboxAppId === 'string' && data.sandboxAppId && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void openSandboxPreviewInHippo({ id: data.sandboxAppId as string, name: data.title || 'Sandbox App' });
                  }}
                  className="flex shrink-0 items-center rounded p-0.5 transition-opacity hover:opacity-70"
                  title="Open preview"
                >
                  <Play className="h-3.5 w-3.5" style={{ color: 'var(--info)' }} />
                </button>
              </>
            )}
            {/* Todo 便签 Dock（2026-09 用户拍板：色块显示在标题栏右侧、成果块旁；点击展开完整便签卡；图钉固定） */}
            <StickyTodoDock />
            {/* 成果块预览（有成果块时显示状态标签，无则弱化为纯图标） */}
            {data.nodeMdId && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenReader?.(data.nodeMdId!, { outcomeMode: true });
                }}
                className="flex h-5 shrink-0 items-center gap-1 rounded transition-colors"
                style={{
                  padding: outcomeStatus ? '0 6px 0 4px' : '0 4px',
                  color: outcomeStatus === 'locked'
                    ? 'var(--success)'
                    : outcomeStatus === 'stale'
                      ? 'var(--danger)'
                      : 'color-mix(in oklab, var(--ink-muted) 50%, transparent)',
                  backgroundColor: outcomeStatus === 'locked'
                    ? 'color-mix(in oklab, var(--success) 8%, transparent)'
                    : outcomeStatus === 'stale'
                      ? 'color-mix(in oklab, var(--primary-strong) 8%, transparent)'
                      : 'transparent',
                }}
                title="Outcome block / .md preview"
                onMouseEnter={(e) => {
                  if (!outcomeStatus) {
                    e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--primary) 8%, transparent)';
                    e.currentTarget.style.color = 'var(--primary-strong)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!outcomeStatus) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'color-mix(in oklab, var(--ink-muted) 50%, transparent)';
                  }
                }}
              >
                <FileCheck className="h-3.5 w-3.5" />
                {outcomeStatus === 'locked' && (
                  <span className="text-xs font-medium leading-none">Locked</span>
                )}
                {outcomeStatus === 'stale' && (
                  <span className="text-xs font-medium leading-none">Update pending</span>
                )}
              </button>
            )}
            {/* 锁定/解锁 */}
            {data.nodeMdId && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleToggleOutcomeLock();
                }}
                disabled={outcomeLoading || persisting}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors disabled:opacity-40"
                style={{
                  color: outcomeStatus === 'locked'
                    ? 'var(--success)'
                    : outcomeStatus === 'stale'
                      ? 'var(--primary-strong)'    // 橙色：上游已变更
                      : outcomeStatus === 'legacy'
                        ? 'color-mix(in oklab, var(--ink-muted) 30%, transparent)'  // 灰色：旧节点
                        : 'color-mix(in oklab, var(--ink-muted) 40%, transparent)',  // 默认
                }}
                title={
                  persisting
                    ? 'The node file is being written. Please wait before locking.'
                    : outcomeStatus === 'locked'
                      ? (forceLocked ? '已强制锁定（校验未通过·用户确认，点击解锁）' : '已锁定（点击解锁）')
                      : outcomeStatus === 'stale'
                        ? `${outcomeStaleReason ? `${outcomeStaleReason.split('。')[0]}。` : '上游成果块已变更'}（点击重新锁定刷新）`
                      : outcomeStatus === 'legacy' ? '旧节点（未启用成果块）'
                      : '未锁定（点击锁定）'
                }
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = outcomeStatus === 'locked'
                    ? 'var(--success-soft)'
                    : outcomeStatus === 'stale'
                      ? 'color-mix(in oklab, var(--primary-strong) 10%, transparent)'
                      : 'color-mix(in oklab, var(--primary) 8%, transparent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {outcomeLoading
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : outcomeStatus === 'locked'
                    ? <ShieldCheck className="h-3.5 w-3.5" />
                    : <Shield className="h-3.5 w-3.5" />
                }
              </button>
            )}
            {/* 展开/收起与删除 ✕ 已从标题栏移除（2026-09）：有内容节点恒为大面板无需收起；
                删除节点入口迁至左栏会话树行 hover 操作。归档按钮已随归档功能一并移除。 */}
          </>
        }
      />

      {/* Messages wrapper — 包含顶部视图分栏（对话/轨迹）+ 左侧导航圆点 + 消息滚动区 */}
      <div
        className={cn(
          'nodrag relative flex min-h-0 flex-1 flex-col',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 视图分栏 Chat/Trace 已迁至标题栏右操作组 */}
        {/* 左侧导航圆点（对话视图 + ≥2 条 user 消息时显示） */}
        {pane === 'chat' && userMessages.length >= 2 && (
          <div
            className="absolute left-0 top-0 bottom-0 z-10 flex flex-col items-center justify-center gap-1.5 py-2 pl-1.5"
            style={{ pointerEvents: 'auto' }}
          >
            {userMessages.map((m) => {
              const isActive = activeUserMsgId === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); scrollToUserMsg(m.id); }}
                  className="flex items-center justify-center"
                  style={{
                    width: 20,
                    height: 20,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <span
                    className="rounded-full transition-all duration-150"
                    style={{
                      width: isActive ? 10 : 8,
                      height: isActive ? 10 : 8,
                      // 未选中 = 淡灰圆点；选中 = 深灰圆点，均无外框/描边
                      backgroundColor: isActive
                        ? 'var(--ink-muted)'
                        : 'color-mix(in oklab, var(--ink-muted) 30%, transparent)',
                      border: 'none',
                      boxShadow: 'none',
                    }}
                  />
                </button>
              );
            })}
          </div>
        )}
      <div
        ref={scrollRef}
        className={cn(
          'relative flex min-h-[60px] min-w-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden py-3 hide-scrollbar ai-canvas-scroll',
          'break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]',
          'px-7',
        )}
      >
        {/* 阅读列壳层：展开态由 globals.css 限宽 720px 居中（约 45 汉字/行舒适行长），
            收起态无任何约束、布局与原完全一致；flex-1/flex-col/gap-2 等价承接外层原样式
            （保住空状态垂直居中与消息间距），浮动按钮是兄弟节点定位不受影响 */}
        {pane === 'chat' ? (
          messages.length === 0 ? (
            /* 空态欢迎（新建会话 / 清空后）：品牌图标 + BobWork 一行，完整输入框紧跟其下，
               整体在节点中部区域垂直居中 */
            <div className="flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-5">
              {/* 品牌行：图标 41px（37px 基础上再放大 10%≈40.7，取整 41），文字 BobWork */}
              <div className="flex shrink-0 items-center justify-center gap-[13px]">
                <img
                  src="/ai-icon.png"
                  alt="BobWork"
                  draggable={false}
                  className="h-[41px] w-[41px] shrink-0 rounded-lg object-contain"
                  style={{ opacity: 0.95, transform: 'translateY(0.5px)' }}
                />
                <span
                  className="text-31 font-semibold leading-none"
                  style={{ color: 'var(--ink-strong)' }}
                >
                  {typedBrand}
                  {!brandTypingDone && (
                    <span
                      className="ml-0.5 inline-block h-[0.95em] w-[2px] align-middle rounded-sm bg-current animate-pulse"
                      aria-hidden
                    />
                  )}
                </span>
              </div>
              <div className="w-full">{inputInner}</div>
              {/* 底部等分隔块（高度=品牌行 41px，按最高元素图标取）：与品牌行等高，使输入框保持垂直居中（位置不变）；
                 品牌行与输入框间距由外层 gap-5（20px）拉大 */}
              <div className="h-[41px] shrink-0" aria-hidden />
            </div>
          ) : (
            <div className="reading-col flex w-full min-w-0 flex-1 flex-col gap-2">
              {messagesInner}
            </div>
          )
        ) : pane === 'team' ? (
          /* 团队视图：本节点关联的协作团队工作台（引擎侧落盘真相源的只读投影 + 插话/重试），
             同时是多智能体的**唯一发起口**（需求输入 + 选成员 + 发起，走本节点同一轮 /api/chat） */
          <TeamWorkbench
            teamIds={teamIds}
            presetAgentIds={presetAgentIds}
            launching={isStreaming}
            nodeId={currentMdId}
            nodeTitle={data.title || ''}
            onOpenMemberPicker={() => setMemberPickerOpen(true)}
            onLaunch={launchTeamRun}
            onAdoptTeam={rememberTeamId}
            onForgetTeam={forgetTeamId}
            mainModel={resolvedTeamMainModel}
            workerModel={resolvedTeamWorkerModel}
            modelOptions={teamModelOptions}
            onSelectMainModel={(m) => selectTeamModel('main', m)}
            onSelectWorkerModel={(m) => selectTeamModel('worker', m)}
          />
        ) : (
          <>
            {/* P5b-1 历史 replay：回放态顶部条（事件日志回放 → 本 Trace 分栏），带返回 live 关闭按钮；
                非回放态不渲染，不影响既有 live 路径 */}
            {replay && (
              <div
                className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5"
                style={{
                  borderBottom: '1px solid color-mix(in oklab, var(--primary-strong) 22%, transparent)',
                  backgroundColor: 'color-mix(in oklab, var(--primary) 5%, transparent)',
                }}
              >
                <span
                  className="inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-10 font-semibold leading-4"
                  style={{ color: 'var(--primary-strong)', backgroundColor: 'color-mix(in oklab, var(--primary-strong) 12%, transparent)' }}
                >
                  {replay.status === 'loading' ? '历史回放加载中' : replay.status === 'error' ? '回放失败' : '历史回放'}
                </span>
                <span className="min-w-0 flex-1 truncate text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }} title={replay.taskId}>
                  task: {replay.taskId} · turn {replay.turnNumber}
                </span>
                {replay.status === 'loading' && (
                  <span className="shrink-0 animate-pulse text-11" style={{ color: 'var(--ink-muted)' }}>加载事件日志…</span>
                )}
                {replay.status === 'error' && replay.error && (
                  <span className="shrink-0 truncate text-11" style={{ color: 'var(--danger)' }} title={replay.error}>{replay.error}</span>
                )}
                <button
                  type="button"
                  onClick={() => setReplay(null)}
                  className="shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-11 font-medium transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_12%,transparent)]"
                  style={{ color: 'var(--primary-strong)' }}
                  title="关闭历史回放，返回实时轨迹"
                >
                  返回实时
                </button>
              </div>
            )}
            <ConversationTrajectory
              embedded
              items={replay && replay.status === 'ready' && replay.items ? replay.items : conversationTrajectoryItems}
              onReplayTask={openTaskReplay}
            />
          </>
        )}



        {/* === 优化1：N 条新消息浮动按钮（仅对话视图） === */}
        {pane === 'chat' && autoScrollPaused && unreadMsgCount > 0 && (
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              if (!el) return;
              programmaticScrollRef.current = true;
              el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              lastReadCountRef.current = messages.length;
              setUnreadMsgCount(0);
              setAutoScrollPaused(false);
              setTimeout(() => {
                programmaticScrollRef.current = false;
              }, 500);
            }}
            className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full px-3 py-1.5 text-xs shadow-md transition-all hover:scale-105 active:scale-95"
            style={{
              backgroundColor: 'var(--primary)',
              color: '#fff',
              boxShadow: '0 4px 16px color-mix(in oklab, var(--primary) 35%, transparent)',
            }}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            <span>
              {unreadMsgCount === 1
                ? '1 条新消息'
                : `${unreadMsgCount} 条新消息`}
            </span>
          </button>
        )}
      </div>
      </div>
      {/* 底部输入框：空态已由中部欢迎区承载输入框，仅在已有对话内容时于底部展示；空态不再重复渲染。
          提问卡活跃（未最小化）时以停靠卡片替代输入框占位，不遮挡正文；用 display 切换而非条件卸载，
          保证最小化↔恢复往返时组件实例与已作答内容不丢失 */}
      {messages.length > 0 && pane !== 'team' && (
        <div className="w-full min-w-0 px-7">
          <div
            className="mx-auto"
            style={{
              display: questionPopup && !questionPopup.minimized ? 'block' : 'none',
              // 与输入框同宽（inputInner 对话态 maxWidth 800px）：停靠提问卡替换输入框时左右边缘对齐
              maxWidth: messages.length === 0 ? 'min(100%, 728px)' : 'min(100%, 800px)',
            }}
          >
            {questionPopup && (
              <QuestionPopup
                docked
                questions={questionPopup.questions}
                timeoutSec={questionPopup.timeoutSec}
                minimized={questionPopup.minimized}
                onSubmit={handleQuestionSubmit}
                onClose={handleQuestionMinimize}
                onSkip={handleQuestionSkip}
                onRestore={handleQuestionRestore}
                onExpire={handleQuestionExpire}
              />
            )}
          </div>
          <div style={{ display: questionPopup && !questionPopup.minimized ? 'none' : 'block' }}>
            {inputInner}
          </div>
        </div>
      )}

      {/* 提问弹窗（仅空态回退为全屏居中形态；对话态已由底部停靠卡片承载；胶囊分支内部自行 portal） */}
      {questionPopup && messages.length === 0 && (
        <QuestionPopup
          questions={questionPopup.questions}
          timeoutSec={questionPopup.timeoutSec}
          minimized={questionPopup.minimized}
          onSubmit={handleQuestionSubmit}
          onClose={handleQuestionMinimize}
          onSkip={handleQuestionSkip}
          onRestore={handleQuestionRestore}
          onExpire={handleQuestionExpire}
        />
      )}

      {/* 登录弹窗（browser.login BobWork 模式）：凭据经 前端→服务端→MCP→扩展 直传，不过模型 */}
      {loginPopup && (
        <LoginDialog
          siteName={loginPopup.siteName}
          url={loginPopup.url}
          timeoutSec={loginPopup.timeoutSec}
          onSubmit={handleLoginSubmit}
          onClose={handleLoginClose}
        />
      )}

      {/* Butler 结构化确认卡片（创建/修改/删除排程）；锚定输入框上方 + 透明遮罩，不遮挡正文 */}
      {butlerConfirm && (
        <ButlerConfirmModal
          pending={butlerConfirm}
          anchor={butlerAnchor}
          onClose={() => setButlerConfirm(null)}
        />
      )}

      {/* 多智能体成员选择弹窗：从已安装 Agent 包中勾选本次执行成员（名单仅会话内，不落盘，每次重选）。
          选完即发起：输入框已有需求时，点 Start 直接用本轮名单发起（不再要求用户二次发送）；空输入则只设名单 */}
      {memberPickerOpen && (
        <TeamMemberPickerDialog
          selected={presetAgentIds}
          modeOn={multiAgentMode}
          willLaunch={localInput.trim().length > 0}
          onCancel={() => setMemberPickerOpen(false)}
          onConfirm={(ids) => {
            setPresetAgentIds(ids);
            if (!multiAgentMode) toggleMultiAgentMode();
            setMemberPickerOpen(false);
            const text = (localInput ?? '').trim();
            if (!text) return;
            setLocalInput('');
            clearNodeDraft();
            void doSend(text, { multiAgent: true, presetAgentIds: ids });
          }}
          onDisable={() => {
            setPresetAgentIds([]);
            if (multiAgentMode) toggleMultiAgentMode();
            setMemberPickerOpen(false);
          }}
        />
      )}

      {/* 删除确认弹窗 */}
      {confirmRender}

      </div>
    </div>
    </div>
  );
}

/** 通用桌面通知：Electron 走 IPC，web 环境回退浏览器 Notification API（无权限时静默） */
function sendDesktopNotification(title: string, body: string, tag?: string) {
  try {
    // Electron 桌面通知（web 环境下 desktop.update.notify 为安全空实现）
    desktop.update.notify(title, body).catch(() => {});
    // web 浏览器回退：HTML5 Notification
    if (typeof window !== 'undefined' && 'Notification' in window) {
      const send = () => {
        try {
          const n = new Notification(title, { body, tag, silent: false });
          n.onclick = () => { window.focus(); n.close(); };
          setTimeout(() => n.close(), 15000);
        } catch { /* ignore */ }
      };
      if (Notification.permission === 'granted') send();
      else if (Notification.permission === 'default') {
        Notification.requestPermission().then((p) => { if (p === 'granted') send(); }).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

/** 工具确认桌面通知 */
function notifyToolConfirm(toolName: string, timeoutSec?: number) {
  sendDesktopNotification(
    'BobWork: Confirmation needed',
    `Tool "${toolName}" is on the manual-confirm list. Choose "Allow" or "Deny" in the app (auto-skipped if no action within ${Math.ceil((timeoutSec ?? 600) / 60)} min).`,
    'bob-tool-confirm',
  );
}

/** 需要用户填写的弹窗（模板字段 / 提问）通知：仅窗口不在前台时发送，避免前台打扰 */
function notifyUserInput(title: string, body: string) {
  if (typeof document !== 'undefined' && !document.hidden) return;
  sendDesktopNotification(title, body, 'bob-user-input');
}

/** 前端推断文件类别（与服务端 classifyOutputKind 保持一致） */
function inferOutputKind(name: string): OutputFileItem['kind'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'doc', 'docx', 'rtf', 'txt'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv', 'tsv', 'numbers'].includes(ext)) return 'sheet';
  if (['ppt', 'pptx', 'key'].includes(ext)) return 'slide';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(ext)) return 'image';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'rb', 'php', 'swift', 'kt', 'css', 'html', 'json', 'yml', 'yaml', 'sh', 'zsh'].includes(ext)) return 'code';
  return 'other';
}

/* ------------------------- Research 档候选来源清单 ------------------------- */

/** 候选来源：本轮**真实读过**的网页。
 *  URL 与正文都取自工具调用记录（调用参数 / 返回原文），不是模型自述 → 不会被编造；
 *  正文即「研究时读到的正文」，导入时直接落盘复用，与回答里的引用同版（NotebookLM 口径）。 */
interface ResearchSource {
  url: string;
  /** 去 www 的域名，用作行内标签前缀 */
  host: string;
  /** 列表展示用的短标签：域名 + 路径尾段（完整 URL 走 title 悬浮提示） */
  label: string;
  /** 页面标题（read 类工具的返回信封里有） */
  title?: string;
  /** 本轮读到的正文（Markdown）；只打开过页面、没读正文的来源没有这一项 */
  body?: string;
  /** page（默认）= 本轮读过的网页原件；report = 本轮研究结论（模型综述，派生材料） */
  kind?: 'page' | 'report';
  /** 报告行专用：正文摘要（结论首段）；网页行的摘要由 sourceSummary(body) 现算 */
  summary?: string;
}

/** 只打开页面、不返回正文的工具：URL 从调用参数取（chrome 通道的 MCP 同名工具一并认） */
const RESEARCH_NAV_TOOLS = new Set([
  'browser_navigate',
  'browser_open_tab',
  'web_fetch',
  'mcp__bob-browser-mcp__browser_navigate',
  'mcp__bob-browser-mcp__browser_open_tab',
]);

/** 返回正文的工具：URL 与正文都从**返回原文**解析（参数里没有 URL） */
const RESEARCH_READ_TOOLS = new Set([
  'browser_extract_text',
  'browser_read_article',
  'browser_read_pdf',
  'mcp__bob-browser-mcp__browser_extract_text',
  'mcp__bob-browser-mcp__browser_read_article',
  'mcp__bob-browser-mcp__browser_read_pdf',
]);

/** 搜索引擎：只用来挑候选来源，本身不是研究来源 → 不进清单 */
const RESEARCH_SKIP_HOSTS = new Set([
  'google.com', 'bing.com', 'baidu.com', 'duckduckgo.com', 'sogou.com', 'so.com',
  'yandex.com', 'yandex.ru', 'search.brave.com', 'startpage.com', 'search.yahoo.com',
  'ecosia.org', 'weixin.sogou.com',
]);

/** 正文上限：防御极长页面（返回值本身已被工具 maxOutput 截过，这里只兜底） */
const MAX_SOURCE_BODY_CHARS = 200_000;

/**
 * 从工具返回原文里解析 URL / 标题 / 正文。
 *
 * 认得两种信封：
 *   1. 内置工具的文本信封（renderEnvelope）——
 *      extract_text / read_article: `标题: …\nURL: …\n\n<正文>`
 *      read_pdf:                    `PDF: <url>\n…\n\n<正文>`
 *      navigate:                    `已打开: <url>\n标题: …`（无正文）
 *   2. MCP 通道的 JSON 返回体（url + markdown / text / content）
 * 两者都不匹配时返回 null —— 宁可不认，也不猜（避免把非正文塞进材料）。
 */
function parseReadResult(
  toolName: string,
  result: string,
): { url: string; title?: string; body?: string } | null {
  const text = (result || '').trim();
  if (!text) return null;

  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text) as Record<string, unknown>;
      const url = typeof v.url === 'string' ? v.url : '';
      if (!url) return null;
      const body = [v.markdown, v.text, v.content].find(
        (x): x is string => typeof x === 'string' && x.trim().length > 0,
      );
      return { url, title: typeof v.title === 'string' ? v.title : undefined, body };
    } catch {
      return null; // 非合法 JSON：不当信封解析，直接放弃
    }
  }

  // 首行块（到第一个空行为止）给 标题 / URL，其后整段为正文
  const sep = text.indexOf('\n\n');
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? text.slice(sep + 2).trim() : '';
  const title = /^标题:\s*(.+)$/m.exec(head)?.[1]?.trim();
  const url =
    /^URL:\s*(\S+)$/m.exec(head)?.[1] ||
    /^PDF:\s*(\S+)$/m.exec(head)?.[1] ||
    /^已打开:\s*(\S+)$/m.exec(head)?.[1] ||
    '';
  if (!url) return null;
  // 正文只认 read 类工具：navigate 的信封同样有 `标题:` 行，但它没有正文
  return { url, title, body: RESEARCH_READ_TOOLS.has(toolName) ? body : undefined };
}

/** 摘要行：正文首个像样的段落（去掉标题 / 列表符号），单行截断 */
function sourceSummary(body: string | undefined): string {
  if (!body) return '';
  const para = body
    .split(/\n{2,}/)
    // 摘要行是纯文本，脚注角标 `[^n]` 只显噪（报告正文的出处都长这样），先摘掉
    .map((p) =>
      p
        .replace(/\[\^[^\]\s]{1,64}\]/g, '')
        .replace(/^[#>\-*\d.\s]+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((p) => p.length >= 30);
  if (!para) return '';
  return para.length > 160 ? `${para.slice(0, 160)}…` : para;
}

/**
 * 本轮研究结论 → 一行候选来源（kind: 'report'）。
 *
 * 与网页来源同卡、同勾选、同导入，差别只在性质：正文不是别人写的网页原件，而是模型本轮的
 * 综述（派生材料）。url 用 `bobwork://` 合成键，只当去重 / 勾选状态 / localStorage 的键用，
 * 不会被当成可抓取地址；出处（会话节点 + 依据来源清单）由服务端写进文件头。
 */
function buildReportSource(content: string, nodeId?: string): ResearchSource | null {
  const raw = (content || '').trim();
  // 报告正文从一级标题起算：Research 档的过程叙述（"Let me open…"）与结论同处一条 assistant
  // 消息、且整段挤在报告之前，整条固化会把叙述一起写进 materials（分享页照渲染）。骨架保证
  // 报告以 `# <主题>` 开头，故按该行切开；找不到一级标题时保持原样，不做猜测性截断。
  const h1 = /^\s{0,3}#\s+.+$/m.exec(raw);
  const body = (h1 ? raw.slice(h1.index) : raw).trim();
  if (body.length < 200) return null; // 太短不值得固化（与 REUSABLE_TEXT_MIN_CHARS 同口径）
  // 优先一级标题：综述骨架以 `# <主题>` 开头，若退回「第一个标题」会把 `## 研究问题`
  // 这类小节名当文件名。无一级标题时才退回二级，再没有则由服务端用日期兜底。
  const heading =
    /^\s{0,3}#\s+(.+)$/m.exec(body)?.[1] ??
    /^\s{0,3}##\s+(.+)$/m.exec(body)?.[1];
  const title = heading?.replace(/[#*`]/g, '').trim();
  // 摘要 = 正文首个像样的段落（标题行、`① 研究问题` 这类短小节名由 sourceSummary 自行跳过），
  // 只去掉加粗/代码标记，便于在卡片行内一行读出一个结论轮廓
  const summary = sourceSummary(body).replace(/[*`]/g, '');
  return {
    url: `bobwork://report/${nodeId || 'session'}`,
    host: '',
    label: 'Research report',
    title: title && title.length <= 80 ? title : undefined,
    summary: summary || undefined,
    body,
    kind: 'report',
  };
}

/** 按 toolCalls 数组缓存收集结果：卡片所在层每帧都会重算，而正文是大字符串，
 *  不缓存的话每次渲染都要重新切片几十 KB × 来源数。数组引用变了自然失效，无额外成本。 */
const researchSourcesCache = new WeakMap<ToolCallRecord[], ResearchSource[]>();

/** 正文链接标注用的映射缓存。按 sources 数组身份缓存 —— 必须给 HtmlRenderer 一个**身份稳定**的
 *  Map：它是 React.memo 的 props 之一，每次渲染新建 Map 会让 memo 失效、innerHTML 被整块重写，
 *  进而把用户正在划词的选区打散（见 HtmlRenderer 底部注释）。 */
const readSourceMapCache = new WeakMap<ResearchSource[], Map<string, ReadSourceInfo>>();

/**
 * 本轮读过的页面 → 正文链接标注信息（键为归一化 URL）。
 *
 * 只收「真的读到了正文」的来源：只 navigate 打开过、没读正文的页面不给弹窗 ——
 * 与「搜索页摘要不算读过」同一条纪律，让「有没有真读过」在正文里也看得见。
 */
function buildReadSourceMap(sources: ResearchSource[]): Map<string, ReadSourceInfo> {
  const cached = readSourceMapCache.get(sources);
  if (cached) return cached;
  const map = new Map<string, ReadSourceInfo>();
  for (const s of sources) {
    if (s.kind === 'report' || !s.body) continue; // 合成键不是真地址；无正文不标注
    const key = normalizeSourceUrl(s.url);
    if (!key || map.has(key)) continue;
    map.set(key, { title: s.title || s.host, host: s.host, excerpt: sourceSummary(s.body) });
  }
  readSourceMapCache.set(sources, map);
  return map;
}

/** 汇总本轮候选来源：按首次出现顺序去重、剔除搜索页与失败调用、上限 30 条。
 *  同一页面可能先 navigate 后 read —— 按 URL 合并，后到的标题 / 正文补齐。 */
function collectResearchSources(toolCalls: ToolCallRecord[] | undefined): ResearchSource[] {
  if (!toolCalls?.length) return [];
  const cached = researchSourcesCache.get(toolCalls);
  if (cached) return cached;
  const byUrl = new Map<string, ResearchSource>();
  for (const t of toolCalls) {
    if (!t || t.success === false) continue;
    const isRead = RESEARCH_READ_TOOLS.has(t.toolName);
    if (!isRead && !RESEARCH_NAV_TOOLS.has(t.toolName)) continue;

    let url = '';
    let title: string | undefined;
    let body: string | undefined;
    if (isRead) {
      const parsed = parseReadResult(t.toolName, t.result);
      if (parsed) {
        url = parsed.url;
        title = parsed.title;
        body = parsed.body ? parsed.body.slice(0, MAX_SOURCE_BODY_CHARS) : undefined;
      }
    }
    if (!url) {
      const raw = t.arguments?.url;
      if (typeof raw === 'string' && raw.trim()) url = raw.trim();
    }
    if (!url) continue;

    const norm = normalizeSourceUrl(url);
    if (!norm) continue;
    let host = '';
    let path = '';
    try {
      const u = new URL(norm);
      host = u.hostname.replace(/^www\./, '');
      path = decodeURIComponent(u.pathname);
    } catch { continue; }
    if (RESEARCH_SKIP_HOSTS.has(host)) continue;

    const prev = byUrl.get(norm);
    if (prev) {
      if (!prev.title && title) prev.title = title;
      if (body && body.length > (prev.body?.length ?? 0)) prev.body = body;
      continue;
    }
    if (byUrl.size >= 30) continue;
    const tail = path.split('/').filter(Boolean).pop() ?? '';
    byUrl.set(norm, { url: norm, host, label: tail ? `${host}/${tail}` : host, title, body });
  }
  const out = Array.from(byUrl.values());
  researchSourcesCache.set(toolCalls, out);
  return out;
}

/**
 * 从回答正文提取 `OutputFile: <path>` 行（模型按系统提示在末尾输出的产物标记）。
 * 当写文件发生在工具结果未回传 SSE 时，正文行是展示产物的唯一线索。
 * 仅产物路径（homework/ materials/ .sandbox/ ~/）会转卡片，其余路径保留原文。
 * 存储平铺：homework 产物直接落在根目录，路径原样使用（kind 仅用于侧边栏分组标签）。
 */
function extractOutputFileBlocks(content: string): { files: OutputFileItem[]; cleanContent: string } {
  if (!content) return { files: [], cleanContent: content };
  const files: OutputFileItem[] = [];
  let clean = content;
  const re = /^\s*OutputFile:\s*([^\n\r]+?)\s*(\r?\n|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    const normalized = raw.replace(/\\/g, '/');
    if (!/^(homework\/|materials\/|attachments\/|\.sandbox\/|~\/)/.test(normalized)) continue; // 非产物路径：保留原文行
    const name = normalized.split('/').pop() || 'file';
    files.push({ path: normalized, name, size: 0, kind: inferOutputKind(name), source: 'answer_text' });
    clean = clean.replace(m[0], '');
  }
  return { files, cleanContent: clean };
}

/**
 * 从回答正文提取 `AUTH_REQ:<绝对路径>` 标记（模型按系统提示在回复中声明需要访问的项目外目录）。
 * 提取出的路径由前端自动 add_root 到右侧「本地文件」面板（仅浏览、待用户授权），并从显示内容中剥离，
 * 只渲染授权提示卡片，避免一行行原始标记污染正文。
 */
function extractAuthReqs(content: string): { paths: string[]; cleanContent: string } {
  if (!content) return { paths: [], cleanContent: content };
  const paths: string[] = [];
  let clean = content;
  const re = /^\s*AUTH_REQ:\s*([^\n\r]+?)\s*(\r?\n|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].trim();
    // 仅接受绝对路径形态（含 / 且不是根路径），其余保留原文行
    if (!raw || !raw.includes('/') || raw === '/') continue;
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (paths.includes(normalized)) {
      clean = clean.replace(m[0], '');
      continue;
    }
    paths.push(normalized);
    clean = clean.replace(m[0], '');
  }
  return { paths, cleanContent: clean };
}

/** 合并 SSE 文件与正文提取文件（按 path 去重，SSE 优先） */
function mergeOutputFiles(a: OutputFileItem[] | undefined, b: OutputFileItem[]): OutputFileItem[] {
  const seen = new Set<string>();
  const merged: OutputFileItem[] = [];
  for (const f of [...(a || []), ...b]) {
    const key = f.path.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  return merged;
}

function OutputFileKindIcon({ kind }: { kind: OutputFileItem['kind'] }) {
  const common = 'h-3.5 w-3.5 shrink-0';
  if (kind === 'doc' || kind === 'text')
    return <FileText className={common} style={{ color: '#537D96' }} />;
  if (kind === 'sheet')
    return <Table className={common} style={{ color: 'var(--success)' }} />;
  if (kind === 'slide')
    return <Presentation className={common} style={{ color: 'var(--danger)' }} />;
  if (kind === 'pdf')
    return <FileText className={common} style={{ color: 'var(--danger)' }} />;
  if (kind === 'image')
    return <ImageIcon className={common} style={{ color: 'var(--purple)' }} />;
  if (kind === 'code')
    return <FileIcon className={common} style={{ color: 'var(--info)' }} />;
  return <Paperclip className={common} style={{ color: '#7a7260' }} />;
}

/** 正文内联图片（Trae 式）：图片类型产物不进入文件框，直接内联显示在正文，点击放大（Lightbox）。
 *  仅项目内相对路径可经 /api/project-files/<projectId>/<path> 加载；~/ 与绝对路径等外部文件
 *  回退由 OutputFiles 卡片管理，不在此内联。 */
function InlineImages({ files, projectId }: { files: OutputFileItem[]; projectId?: string }) {
  const [lightbox, setLightbox] = useState<{ open: boolean; src: string; name: string }>({ open: false, src: '', name: '' });
  if (!files || files.length === 0) return null;
  if (!projectId) return null;
  const close = () => setLightbox({ open: false, src: '', name: '' });
  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {files.map((f) => {
          const src = `/api/project-files/${encodeURIComponent(projectId)}/${f.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
          return (
            <img
              key={f.path}
              src={src}
              alt={f.name}
              loading="lazy"
              onClick={() => setLightbox({ open: true, src, name: f.name })}
              className="max-h-[320px] w-auto max-w-full cursor-zoom-in rounded-lg border"
              style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper-hover)' }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          );
        })}
      </div>
      {lightbox.open && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-6"
          onClick={close}
        >
          <div className="relative max-h-full max-w-full">
            <img
              src={lightbox.src}
              alt={lightbox.name}
              className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={close}
              className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-white transition-colors hover:opacity-80"
              style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function OutputFilesCard({ files, projectId }: { files: OutputFileItem[]; projectId?: string }) {
  const [showDetails, setShowDetails] = useState(false);
  const [warnText, setWarnText] = useState('');
  // 幽灵文件检测：正文 OutputFile 声明可能未实际写入磁盘（write_file 未成功 / 写到了临时区），
  // 逐文件校验存在性，缺失的标记为 not found，避免「卡片打不开、目录里没有」的困惑
  const [missingFiles, setMissingFiles] = useState<Set<string>>(new Set());
  // 文件签名：files 数组每次渲染都是新引用，用归一化路径数组的 JSON 签名做 effect 依赖，
  // 避免流式高频重渲染时对同一批文件反复 stat（C9）
  const filesSig = JSON.stringify(files.map((f) => f.path.replace(/\\/g, '/')));
  useEffect(() => {
    let cancelled = false;
    setMissingFiles(new Set());
    setWarnText('');
    if (!projectId) return;
    const list = filesSig ? (JSON.parse(filesSig) as string[]) : [];
    (async () => {
      const missingNow = new Set<string>();
      for (const p of list) {
        if (p.startsWith('~/') || p.startsWith('/')) continue; // 本地绝对 / ~ 路径不在此校验
        try {
          const resp = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stat', project_id: projectId, file_path: p }),
          });
          const data = await resp.json();
          if (cancelled) return;
          if (data?.success && data.exists === false) missingNow.add(p);
        } catch { /* ignore */ }
      }
      if (!cancelled) setMissingFiles(missingNow);
    })();
    return () => { cancelled = true; };
  }, [filesSig, projectId]);
  if (!files || files.length === 0) return null;
  const isMissing = (f: OutputFileItem) => missingFiles.has(f.path.replace(/\\/g, '/'));
  const handleOpenInViewer = (f: OutputFileItem) => {
    if (isMissing(f)) {
      setWarnText(`File not found on disk: ${f.path} — the AI declared this output but it was not actually saved. Ask it to regenerate with a homework/ path.`);
      return;
    }
    setWarnText('');
    const p = f.path.replace(/\\/g, '/');
    // homework/、materials/（含历史 attachments/）都属于项目的本地相对路径
    const isSandbox = p.startsWith('~/') || p.startsWith('/');
    if (isSandbox) {
      // 绝对或 ~ 路径：直接走 local 打开（UnifiedViewer 支持 FileSourceKind=local 这种）
      const name = p.split('/').pop() || 'file';
      bus.publish(BusEvents.fileOpen, { source: 'local', path: p, name });
    } else {
      // 项目内相对路径：使用 project source
      const name = p.split('/').pop() || 'file';
      bus.publish(BusEvents.fileOpen, { source: 'project', path: p, name });
    }
  };
  // 将 output file 的路径解析为绝对路径：项目内相对路径拼项目根，~/ 与 / 直接展开
  const resolveAbsPath = async (f: OutputFileItem): Promise<string> => {
    const p = f.path.replace(/\\/g, '/');
    if (p.startsWith('~/')) return p.replace('~', desktop.getHomeDir());
    if (p.startsWith('/')) return p;
    // 优先用节点所属项目（projectId）路径；回退 current（避免切换项目后路径拼错）
    let projectPath = '';
    if (projectId) {
      try {
        const resp = await fetch('/api/projects');
        const data = await resp.json();
        const all = [
          ...(data?.projects || []),
          ...(data?.active_projects || []),
          ...(data?.archived_projects || []),
          ...(data?.trashed_projects || []),
        ];
        const proj = all.find((x: { id?: string }) => x.id === projectId);
        if (proj?.path) projectPath = proj.path;
      } catch { /* ignore */ }
    }
    if (!projectPath) {
      const resp = await fetch('/api/projects?action=current');
      const data = await resp.json();
      projectPath = data?.project?.path || '';
    }
    return `${projectPath}/${p}`;
  };
  const handleOpenWithApp = async (f: OutputFileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMissing(f)) {
      setWarnText(`File not found on disk: ${f.path} — the AI declared this output but it was not actually saved. Ask it to regenerate with a homework/ path.`);
      return;
    }
    try {
      const abs = await resolveAbsPath(f);
      const r = await desktop.openFile(abs);
      if (!r.success) setWarnText(r.error || `打开失败: ${f.path}`);
    } catch (err) {
      setWarnText(err instanceof Error ? err.message : `打开失败: ${f.path}`);
    }
  };
  const handleRevealInFolder = async (f: OutputFileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMissing(f)) {
      setWarnText(`File not found on disk: ${f.path} — the AI declared this output but it was not actually saved. Ask it to regenerate with a homework/ path.`);
      return;
    }
    try {
      const abs = await resolveAbsPath(f);
      const r = await desktop.showItemInFolder(abs);
      if (!r.success) setWarnText(r.error || `在文件夹中显示失败: ${f.path}`);
    } catch (err) {
      setWarnText(err instanceof Error ? err.message : `在文件夹中显示失败: ${f.path}`);
    }
  };

  return (
    <div
      className="mt-2 rounded-lg border px-2 py-2"
      style={{
        borderColor: 'color-mix(in oklab, var(--warn) 80%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--paper) 90%, transparent)',
      }}
    >
      <div className="flex items-center gap-1.5 px-0.5">
        <FileIcon
          className="h-2.5 w-2.5 shrink-0"
          style={{ color: 'var(--warn)' }}
        />
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'color-mix(in oklab, var(--ink-muted) 80%, transparent)' }}>
          Output Files · {files.length}
        </span>
        <div className="flex-1 h-px" style={{ backgroundColor: 'color-mix(in oklab, var(--paper-hover) 80%, transparent)' }} />
        <button
          onClick={() => setShowDetails((v) => !v)}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors hover:opacity-80"
          style={{ color: 'var(--ink-muted)', backgroundColor: 'color-mix(in oklab, var(--paper-hover) 50%, transparent)' }}
          title={showDetails ? '收起详情，显示链接标签' : '展开路径 / 大小 / 系统打开'}
        >
          {showDetails ? '收起' : '详情'}
        </button>
      </div>

      {warnText && (
        <div
          className="mt-1.5 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs leading-relaxed"
          style={{
            borderColor: 'color-mix(in oklab, var(--danger) 50%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--danger) 8%, transparent)',
            color: 'var(--danger)',
          }}
        >
          <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
          {warnText}
        </div>
      )}

      {showDetails ? (
        <div className="mt-1 grid grid-cols-1 gap-1">
          {files.map((f) => {
            const p = f.path.replace(/\\/g, '/');
            const isSandboxApp = p.includes('.sandbox/');
            const isHomework = p.includes('homework/');
            const miss = isMissing(f);
            return (
              <div
                key={f.path}
                className="group/ofc flex items-center gap-1.5 rounded-md border px-2 py-1.5 transition-colors hover:cursor-pointer hover:opacity-95"
                style={{
                  borderColor: miss ? 'color-mix(in oklab, var(--danger) 70%, transparent)' : 'color-mix(in oklab, var(--warn) 60%, transparent)',
                  backgroundColor: miss ? 'color-mix(in oklab, var(--danger) 6%, transparent)' : '#ffffff',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenInViewer(f);
                }}
              >
                <OutputFileKindIcon kind={f.kind} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    {miss && <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: 'var(--danger)' }} />}
                    <span
                      className="min-w-0 flex-1 truncate text-xs font-medium"
                      style={{
                        color: miss ? 'var(--danger)' : isSandboxApp
                          ? 'var(--info)'
                          : isHomework
                            ? 'var(--primary-strong)'
                            : 'var(--ink-strong)',
                      }}
                      title={miss
                        ? '文件在磁盘上不存在（声明未保存成功）'
                        : isSandboxApp
                          ? '.sandbox 下的 Bob Sandbox 小程序文件'
                          : isHomework
                            ? 'homework 目录下的项目产物'
                            : undefined}
                    >
                      {f.name}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-xs" style={{ color: miss ? 'var(--danger)' : 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                    <span>{miss ? 'not found' : formatFileSize(f.size || 0)}</span>
                    <span>·</span>
                    <span className="truncate opacity-80">{f.path}</span>
                  </div>
                </div>
                <button
                  onClick={(e) => handleRevealInFolder(f, e)}
                  className="shrink-0 inline-flex rounded border p-1 opacity-0 pointer-events-none transition-opacity duration-100 hover:opacity-80 group-hover/ofc:pointer-events-auto group-hover/ofc:opacity-100"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--line) 80%, transparent)',
                    color: miss ? 'var(--danger)' : 'var(--ink-muted)',
                  }}
                  title="打开所在文件夹（在访达中显示）"
                >
                  <Folder className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => handleOpenWithApp(f, e)}
                  className="shrink-0 inline-flex rounded border px-1.5 py-0.5 text-xs opacity-0 pointer-events-none transition-opacity duration-100 hover:opacity-80 group-hover/ofc:pointer-events-auto group-hover/ofc:opacity-100"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--line) 80%, transparent)',
                    color: miss ? 'var(--danger)' : 'var(--ink-muted)',
                  }}
                  title="Open with default app"
                >
                  Open
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        /* 链接标签形式：默认展示，点击在预览区打开 */
        <div className="mt-1.5 flex flex-wrap gap-1 px-0.5">
          {files.map((f) => {
            const p = f.path.replace(/\\/g, '/');
            const isSandboxApp = p.includes('.sandbox/');
            const isHomework = p.includes('homework/');
            const miss = isMissing(f);
            return (
              <div
                key={f.path}
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenInViewer(f);
                }}
                title={`${f.path} · ${miss ? 'file not found on disk' : `${formatFileSize(f.size || 0)} · 点击在预览区打开`}${isSandboxApp ? '（.sandbox 小程序文件）' : isHomework ? '（homework 项目产物）' : ''}`}
                className="group/ofc inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-all hover:opacity-90"
                style={{
                  borderColor: miss
                    ? 'color-mix(in oklab, var(--danger) 60%, transparent)'
                    : isSandboxApp
                      ? 'color-mix(in oklab, var(--info) 22%, transparent)'
                      : isHomework
                        ? 'color-mix(in oklab, var(--primary) 22%, transparent)'
                        : 'color-mix(in oklab, var(--line) 40%, transparent)',
                  backgroundColor: miss
                    ? 'color-mix(in oklab, var(--danger) 7%, transparent)'
                    : isSandboxApp
                      ? 'color-mix(in oklab, var(--info) 5%, transparent)'
                      : isHomework
                        ? 'color-mix(in oklab, var(--primary) 5%, transparent)'
                        : 'transparent',
                  color: miss ? 'var(--danger)' : isSandboxApp ? 'var(--info)' : isHomework ? 'var(--primary-strong)' : 'var(--ink-muted)',
                }}
              >
                <OutputFileKindIcon kind={f.kind} />
                <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                {miss && <AlertTriangle className="h-2.5 w-2.5 shrink-0" />}
                <button
                  onClick={(e) => handleRevealInFolder(f, e)}
                  title="打开所在文件夹（在访达中显示）"
                  className="shrink-0 inline-flex rounded-full p-0.5 opacity-0 pointer-events-none transition-opacity duration-100 hover:bg-black/10 group-hover/ofc:pointer-events-auto group-hover/ofc:opacity-100"
                  style={{ color: 'inherit' }}
                >
                  <Folder className="h-2.5 w-2.5" />
                </button>
                <ExternalLink
                  className="h-2.5 w-2.5 shrink-0 opacity-50 transition-opacity group-hover/ofc:opacity-100"
                  style={{ color: 'inherit' }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Research 档「来源清单」卡片：本轮**研究结论**一行 + 本轮**真实读过**的网页若干行。
 *  - 网页：URL 与正文都取自工具调用记录（非模型自述，故不会被编造），行内给首段摘要，
 *    可展开看本轮读到的全文；
 *  - 结论：本轮回答本身（派生材料），展开可看全文，出处头标注 Derived 并列出依据来源。
 *  两者同勾选、同导入：用户决定哪些进当前项目 materials/。网页走 add_link（**已读正文优先
 *  直接落盘**，与回答里的引用同版；没有正文的才回落抓取链路），结论走 add_report。
 *  落盘后宿主自动登记账本并建内容索引，研究结果由此沉淀成可复用的项目材料。
 *  仅 Hippo 对话栏 Research 档渲染，画布节点不出现。 */
function ResearchSourcesCard({ sources, nodeId }: { sources: ResearchSource[]; nodeId?: string }) {
  // 默认全选：excluded 只记「用户主动取消」的，新增来源自动回到选中态
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // 展开全文的来源（默认收起：候选行只占一行摘要，避免卡片被正文撑爆）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 「已导入」标记按会话节点落 localStorage：卡片每次都由 toolCalls 重建，
  // 标记不落盘的话重开会话会把同一批来源再导一遍（materials 里出现 "(1)" 副本）
  const importedKey = nodeId ? `bob-research-imported:${nodeId}` : '';
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  /** 本次导入总数：selected 会随每条例成功而收缩，不能拿它当进度分母 */
  const [total, setTotal] = useState(0);
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Array<{ label: string; error: string }>>([]);

  // 挂载后再读已导入标记：SSR 期没有 localStorage，且避开首帧水合不一致
  useEffect(() => {
    if (!importedKey) return;
    try {
      const arr: unknown = JSON.parse(localStorage.getItem(importedKey) || '[]');
      if (Array.isArray(arr)) setImported(new Set(arr.filter((x): x is string => typeof x === 'string')));
    } catch { /* 脏数据忽略 */ }
  }, [importedKey]);

  if (!sources || sources.length === 0) return null;

  const allImported = imported.size === sources.length;
  // 报告与网页同列表：报告是派生结论，网页是原件 —— 计数分开，别把报告算成「读过的网页」
  const pages = sources.filter((s) => s.kind !== 'report');
  const hasReport = sources.some((s) => s.kind === 'report');
  const headerLabel =
    `${allImported ? 'Sources Imported' : 'Sources Read'}`
    + (pages.length > 0 ? ` · ${pages.length}` : '')
    + (hasReport ? ' · Report' : '');

  const selected = sources.filter((s) => !imported.has(s.url) && !excluded.has(s.url));

  /** 标记一条已导入：同时落 localStorage，重开会话不会重复导入 */
  const markImported = (url: string) => {
    setImported((prev) => {
      const next = new Set(prev).add(url);
      if (importedKey) {
        try { localStorage.setItem(importedKey, JSON.stringify(Array.from(next))); } catch { /* 配额满忽略 */ }
      }
      return next;
    });
  };

  const toggle = (url: string) => {
    if (importing || imported.has(url)) return;
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const toggleExpand = (url: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const handleImport = async () => {
    const queue = selected;
    if (queue.length === 0 || importing) return;
    setImporting(true);
    setFailures([]);
    setTotal(queue.length);
    const failed: Array<{ label: string; error: string }> = [];
    // 串行逐条：服务端抓取有超时与降级路径，并发跑会同时压两套抓取通道
    for (let i = 0; i < queue.length; i++) {
      setProgress(i + 1);
      const s = queue[i];
      try {
        // 报告：派生结论，出处写会话节点 + 依据来源清单；网页：带本轮读到的正文与标题，
        // 服务端优先直接落盘（与引用同版），缺失才重新抓取
        const payload = s.kind === 'report'
          ? {
              action: 'add_report',
              nodeId,
              title: s.title,
              body: s.body,
              sources: pages.map((p) => p.url),
            }
          : { action: 'add_link', url: s.url, title: s.title, body: s.body };
        const res = await fetch('/api/materials', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          failed.push({ label: s.label, error: data?.error || `HTTP ${res.status}` });
        } else {
          markImported(s.url);
        }
      } catch {
        failed.push({ label: s.label, error: 'Network error' });
      }
    }
    setImporting(false);
    setProgress(0);
    if (failed.length > 0) setFailures(failed);
  };

  return (
    <div
      className="mt-2 rounded-lg border px-2 py-2"
      style={{
        borderColor: allImported
          ? 'color-mix(in oklab, var(--success) 55%, transparent)'
          : 'color-mix(in oklab, var(--primary-strong) 45%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--paper) 90%, transparent)',
      }}
    >
      <div className="flex items-center gap-1.5 px-0.5">
        {allImported ? (
          <CheckCircle2 className="h-2.5 w-2.5 shrink-0" style={{ color: 'var(--success)' }} />
        ) : (
          <Globe className="h-2.5 w-2.5 shrink-0" style={{ color: 'var(--primary-strong)' }} />
        )}
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'color-mix(in oklab, var(--ink-muted) 80%, transparent)' }}
        >
          {headerLabel}
        </span>
        <div className="h-px flex-1" style={{ backgroundColor: 'color-mix(in oklab, var(--paper-hover) 80%, transparent)' }} />
      </div>

      <div className="mt-1.5 grid grid-cols-1 gap-1 px-0.5">
        {sources.map((s) => {
          const done = imported.has(s.url);
          const checked = done || !excluded.has(s.url);
          const isReport = s.kind === 'report';
          // 报告行不给首段摘要，改说清它的性质与依据：这是本轮的结论，不是又一份原始网页
          const summary = isReport
            ? `Model-written synthesis of ${pages.length} source${pages.length === 1 ? '' : 's'} · derived`
            : sourceSummary(s.body);
          const isOpen = expanded.has(s.url);
          return (
            <div
              key={s.url}
              className="rounded-md border transition-colors"
              style={{
                borderColor: done
                  ? 'color-mix(in oklab, var(--success) 40%, transparent)'
                  : checked
                    ? 'color-mix(in oklab, var(--primary-strong) 35%, transparent)'
                    : 'color-mix(in oklab, var(--paper-hover) 90%, transparent)',
                backgroundColor: done
                  ? 'color-mix(in oklab, var(--success) 8%, transparent)'
                  : checked
                    ? 'color-mix(in oklab, var(--primary-strong) 7%, transparent)'
                    : 'transparent',
              }}
            >
              <div className="flex items-start gap-1.5 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => toggle(s.url)}
                  disabled={importing || done}
                  title={s.url}
                  className={cn(
                    'flex min-w-0 flex-1 items-start gap-1.5 text-left',
                    !importing && !done ? 'cursor-pointer' : 'cursor-default',
                  )}
                >
                  <span
                    className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border"
                    style={{
                      borderColor: done
                        ? 'color-mix(in oklab, var(--success) 60%, transparent)'
                        : checked
                          ? 'var(--primary-strong)'
                          : 'color-mix(in oklab, var(--ink-muted) 45%, transparent)',
                      backgroundColor: done
                        ? 'color-mix(in oklab, var(--success) 20%, transparent)'
                        : checked
                          ? 'color-mix(in oklab, var(--primary-strong) 20%, transparent)'
                          : 'transparent',
                    }}
                  >
                    {checked && (
                      <Check className="h-2 w-2" style={{ color: done ? 'var(--success)' : 'var(--primary-strong)' }} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs" style={{ color: 'var(--ink-strong)' }}>
                      {s.label}
                    </span>
                    {summary && (
                      <span className="mt-0.5 block text-xs leading-snug" style={{ color: 'var(--ink-muted)' }}>
                        {summary}
                      </span>
                    )}
                    {/* 报告行：性质说明之外再补一句正文摘要，不展开也能看出结论讲了什么 */}
                    {isReport && s.summary && (
                      <span className="mt-0.5 block text-xs leading-snug" style={{ color: 'var(--ink-muted)' }}>
                        {s.summary}
                      </span>
                    )}
                  </span>
                </button>
                {s.body && (
                  <button
                    type="button"
                    onClick={() => toggleExpand(s.url)}
                    className="shrink-0 cursor-pointer rounded px-1 py-0.5 text-xs"
                    style={{ color: 'var(--primary-strong)' }}
                  >
                    {isOpen ? 'Hide' : 'Show full text'}
                  </button>
                )}
              </div>
              {isOpen && s.body && (
                <div
                  className="mx-2 mb-1.5 max-h-56 overflow-auto whitespace-pre-wrap rounded border px-2 py-1.5 text-xs leading-relaxed"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--paper-hover) 90%, transparent)',
                    color: 'var(--ink-muted)',
                  }}
                >
                  {s.body}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 px-0.5">
        {importing ? (
          <button
            disabled
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium opacity-70"
            style={{
              borderColor: 'color-mix(in oklab, var(--primary-strong) 45%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--primary-strong) 12%, transparent)',
              color: 'var(--primary-strong)',
            }}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Importing {progress}/{total}...
          </button>
        ) : selected.length === 0 && imported.size > 0 ? (
          <span className="text-xs leading-relaxed" style={{ color: 'var(--success)' }}>
            {allImported ? `${imported.size} sources saved` : `${imported.size} of ${sources.length} saved`} to materials/ · indexed automatically.
          </span>
        ) : (
          <button
            onClick={() => void handleImport()}
            disabled={selected.length === 0}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              borderColor: 'color-mix(in oklab, var(--primary-strong) 45%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--primary-strong) 12%, transparent)',
              color: 'var(--primary-strong)',
            }}
          >
            <Folder className="h-3 w-3" />
            Import {selected.length === 1 ? '1 source' : `${selected.length} sources`}
          </button>
        )}
        {!importing && selected.length === 0 && imported.size === 0 && (
          <span className="flex-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            Nothing selected.
          </span>
        )}
        {!importing && selected.length > 0 && (
          <span className="flex-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            Uncheck anything you don&apos;t want in the project.
          </span>
        )}
      </div>

      {failures.length > 0 && (
        <div className="mt-1 grid grid-cols-1 gap-1 px-0.5">
          {failures.slice(0, 3).map((f, i) => (
            <div
              key={`${f.label}-${i}`}
              className="flex items-start gap-1.5 rounded-md border px-2 py-1.5"
              style={{
                borderColor: 'color-mix(in oklab, var(--danger) 40%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--danger) 8%, transparent)',
              }}
            >
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" style={{ color: 'var(--danger)' }} />
              <span className="min-w-0 flex-1 text-xs" style={{ color: 'var(--danger)' }}>
                {f.label} — {f.error}
              </span>
            </div>
          ))}
          {failures.length > 3 && (
            <span className="px-0.5 text-xs" style={{ color: 'var(--danger)' }}>
              and {failures.length - 3} more failed — click Import again to retry.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** 授权提示卡片：AI 声明需要访问的项目外目录，已自动加入右侧「本地文件」面板。
 *  卡片内提供「一键全部授权」按钮，用户无需切换到侧栏逐个点击。 */
function AuthReqCard({ paths }: { paths: string[] }) {
  const [authorizing, setAuthorizing] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [failedPaths, setFailedPaths] = useState<string[]>([]);

  if (!paths || paths.length === 0) return null;

  const handleAuthorizeAll = async () => {
    setAuthorizing(true);
    setFailedPaths([]);
    const failed: string[] = [];
    for (const p of paths) {
      try {
        const res = await fetch(`/api/local-files?action=authorize_root&path=${encodeURIComponent(p)}`);
        const data = await res.json();
        if (!data?.success) failed.push(p);
      } catch {
        failed.push(p);
      }
    }
    setAuthorizing(false);
    if (failed.length === 0) {
      setAuthorized(true);
      window.dispatchEvent(new CustomEvent('local-roots-changed'));
    } else {
      setFailedPaths(failed);
    }
  };

  return (
    <div
      className="mt-2 rounded-lg border px-2 py-2"
      style={{
        borderColor: authorized
          ? 'color-mix(in oklab, var(--success) 55%, transparent)'
          : 'color-mix(in oklab, var(--info) 55%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--paper) 90%, transparent)',
      }}
    >
      <div className="flex items-center gap-1.5 px-0.5">
        {authorized ? (
          <CheckCircle2 className="h-2.5 w-2.5 shrink-0" style={{ color: 'var(--success)' }} />
        ) : (
          <Shield className="h-2.5 w-2.5 shrink-0" style={{ color: 'var(--info)' }} />
        )}
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'color-mix(in oklab, var(--ink-muted) 80%, transparent)' }}>
          {authorized
            ? `Folder Access Granted · ${paths.length}`
            : `Folder Access Requested · ${paths.length}`}
        </span>
        <div className="flex-1 h-px" style={{ backgroundColor: 'color-mix(in oklab, var(--paper-hover) 80%, transparent)' }} />
      </div>
      <div className="mt-1.5 grid grid-cols-1 gap-1 px-0.5">
        {paths.map((p) => {
          const isFailed = failedPaths.includes(p);
          const isGranted = authorized && !isFailed;
          return (
            <div
              key={p}
              className="flex items-center gap-1.5 rounded-md border px-2 py-1.5"
              style={{
                borderColor: isGranted
                  ? 'color-mix(in oklab, var(--success) 40%, transparent)'
                  : isFailed
                    ? 'color-mix(in oklab, var(--danger) 40%, transparent)'
                    : 'color-mix(in oklab, var(--info) 40%, transparent)',
                backgroundColor: isGranted
                  ? 'color-mix(in oklab, var(--success) 8%, transparent)'
                  : isFailed
                    ? 'color-mix(in oklab, var(--danger) 8%, transparent)'
                    : 'color-mix(in oklab, var(--paper-hover) 55%, transparent)',
              }}
            >
              {isGranted ? (
                <CheckCircle2 className="h-3 w-3 shrink-0" style={{ color: 'var(--success)' }} />
              ) : isFailed ? (
                <AlertCircle className="h-3 w-3 shrink-0" style={{ color: 'var(--danger)' }} />
              ) : (
                <Folder className="h-3 w-3 shrink-0" style={{ color: 'var(--info)' }} />
              )}
              <code className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink-strong)' }}>
                {p}
              </code>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-2 px-0.5">
        {authorized ? (
          <span className="text-xs leading-relaxed" style={{ color: 'var(--success)' }}>
            All folders authorized. The assistant can now read and write them directly.
          </span>
        ) : (
          <>
            <button
              onClick={handleAuthorizeAll}
              disabled={authorizing}
              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
              style={{
                borderColor: 'color-mix(in oklab, var(--info) 45%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--info) 12%, transparent)',
                color: 'var(--info)',
              }}
            >
              {authorizing ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Authorizing...
                </>
              ) : (
                <>
                  <ShieldCheck className="h-3 w-3" />
                  Authorize All
                </>
              )}
            </button>
            {failedPaths.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--danger)' }}>
                {failedPaths.length} failed, retry available
              </span>
            )}
            <span className="flex-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              Or authorize individually in the <b>Local Files</b> panel.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 节点 props 浅比较器（配合 React.memo 避免拖拽时全节点重渲染）。
 *
 * 核心思路：拖拽中每次 mousemove 只更新 node.position / dragging 字段，
 * data 对象引用保持不变；若 data 引用没变 → 内部状态（messages/config）也没变，
 * 且 ChatNodeKernel 并不读取 props 的 position（通过 useStore 拿 position/dragging），
 * 所以此时可以安全跳过重渲染。
 */
export function areNodePropsEqual<T extends { id: string; data: AiChatNodeData; selected?: boolean }>(
  prev: T,
  next: T,
): boolean {
  if (prev.id !== next.id) return false;
  if (prev.selected !== next.selected) return false;
  // data 引用没变 → 拖拽位置变化，跳过重渲染
  if (prev.data === next.data) return true;
  // data 引用有变化 → 逐个比较关键级字段（引用相等则跳过）
  const a = prev.data;
  const b = next.data;
  if (a.messages !== b.messages) return false;
  if (a.title !== b.title) return false;
  if (a.isStreaming !== b.isStreaming) return false;
  if (a.modelId !== b.modelId) return false;
  if (a.thinkingLevel !== b.thinkingLevel) return false;
  if (a.nodeMdId !== b.nodeMdId) return false;
  if (a.sandboxAppId !== b.sandboxAppId) return false;
  if (a.compactedUntil !== b.compactedUntil) return false;
  // 常用扩展字段：身份/技能/MCP等（都用引用比较）
  const extraKeys = [
    '__hasPersistedPosition', 'enabledMcpIds', 'selectedSkills', 'multiAgentMode',
    'collapsed', 'nodeHeight', 'isArchived', 'teamIds',
  ] as const;
  for (const k of extraKeys) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}
