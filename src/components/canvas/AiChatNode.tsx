'use client';

import { useState, useRef, useEffect, useCallback, useContext } from 'react';
import React from 'react';
import {
  Handle,
  Position,
  useReactFlow,
  useStore,
  type NodeProps,
  type Node,
} from '@xyflow/react';
import { X, Send, Sparkles, ChevronDown, Brain, Check, Zap, Wrench, CheckCircle2, XCircle, Copy, ClipboardCheck, FileText, Paperclip, Image as ImageIcon, File as FileIcon, Upload, Lightbulb, AlertTriangle, AtSign, Pin, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AiChatNodeData, ChatMessage, ThinkingLevel, ToolCallRecord, MessageAttachment } from '@/lib/types';
import QuestionPopup, { extractQuestions, type QuestionItem, type AnswerEntry } from './QuestionPopup';
import { HtmlRenderer } from './HtmlRenderer';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  DISPLAY_CONFIGS,
  getAvailableModels,
  isCustomModel,
  parseCustomModel,
  getProviderPreset,
  type ProviderConfig,
  type AvailableModel,
} from '@/lib/types';
import { loadSettings } from '@/lib/settings';
import { analyzeTask, selectBestModel } from '@/lib/model-matcher';


const SYSTEM_PROMPT =
  'You are a helpful, knowledgeable AI assistant. Respond concisely and clearly. Use markdown formatting when appropriate. Answer in the same language as the user.';

/** Parse <think>...</think> and <mood>...</mood> tags from content */
function parseThinkMood(content: string): { think: string; mood: string; content: string } {
  let think = '';
  let mood = '';
  let clean = content;

  // Extract <mood>...</mood>
  const moodMatch = clean.match(/<mood>([\s\S]*?)<\/mood>/i);
  if (moodMatch) {
    mood = moodMatch[1].trim();
    clean = clean.replace(/<mood>[\s\S]*?<\/mood>/i, '');
  }

  // Extract <think>...</think> (may be multiple)
  const thinkMatches = clean.matchAll(/<think>([\s\S]*?)<\/think>/gi);
  for (const m of thinkMatches) {
    think += m[1].trim() + '\n';
  }
  clean = clean.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Handle unclosed <think> tag (during streaming)
  const openThinkMatch = clean.match(/<think>([\s\S]*)$/i);
  if (openThinkMatch) {
    think += openThinkMatch[1].trim();
    clean = clean.replace(/<think>[\s\S]*$/i, '');
  }

  // Handle unclosed <mood> tag (during streaming)
  const openMoodMatch = clean.match(/<mood>([\s\S]*)$/i);
  if (openMoodMatch) {
    mood += openMoodMatch[1].trim();
    clean = clean.replace(/<mood>[\s\S]*$/i, '');
  }

  const result = clean.trim();
  // 安全兜底：如果结果为空但原文有实质内容，可能是 <think> 未闭合导致全部清空
  if (!result && content.length > 20) {
    const fallback = content
      .replace(/<mood>[\s\S]*?<\/mood>/gi, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();
    return { think: think.trim(), mood: mood.trim(), content: fallback || content.trim() };
  }

  return { think: think.trim(), mood: mood.trim(), content: result };
}

/** 从回答内容中提取 <!-- TITLE: xxx --> 格式的标题建议 */
function extractTitleSuggestion(content: string): { title: string | null; cleanContent: string } {
  const titleMatch = content.match(/<!--\s*TITLE:\s*(.+?)\s*-->/i);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    const cleanContent = content.replace(/<!--\s*TITLE:\s*.+?\s*-->/i, '').trim();
    return { title, cleanContent };
  }
  return { title: null, cleanContent: content };
}

/** 将 mood 文本解析为 NodeMood 对象（vibe/sparks/reflections/will 数组） */
function parseMoodTextToObject(moodText: string): { vibe?: string[]; sparks?: string[]; reflections?: string[]; will?: string[] } | undefined {
  if (!moodText || !moodText.trim()) return undefined;

  const pools: Record<string, string[]> = {
    vibe: [],
    sparks: [],
    reflections: [],
    will: [],
  };
  const poolNames = ['vibe', 'sparks', 'reflections', 'will'] as const;

  // 方式1: 按 "Vibe:" / "Sparks:" 标签分割
  const sections = moodText.split(/(?:^|\n)\s*(?:Vibe|Sparks|Reflections|Will)\s*[:：]\s*/i);
  const labels = moodText.match(/(?:Vibe|Sparks|Reflections|Will)\s*[:：]/gi) || [];

  for (let i = 0; i < labels.length && i + 1 < sections.length; i++) {
    const labelLower = labels[i].toLowerCase().replace(/[:：]\s*/, '').trim();
    if (pools[labelLower] !== undefined) {
      pools[labelLower] = sections[i + 1]
        .split('\n')
        .map(s => s.replace(/^[-•·]\s*/, '').trim())
        .filter(s => s.length > 0);
    }
  }

  // 方式2: 如果方式1失败，尝试 <vibe>...</vibe> XML 标签格式
  if (Object.values(pools).every(arr => arr.length === 0)) {
    for (const name of poolNames) {
      const tagRegex = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i');
      const match = moodText.match(tagRegex);
      if (match) {
        pools[name] = match[1]
          .split('\n')
          .map(s => s.replace(/^[-•·]\s*/, '').trim())
          .filter(s => s.length > 0);
      }
    }
  }

  // 如果仍然解析失败，整体作为 vibe
  if (Object.values(pools).every(arr => arr.length === 0) && moodText.trim()) {
    pools.vibe = [moodText.trim()];
  }

  const result: Record<string, string[]> = {};
  for (const key of Object.keys(pools)) {
    if (pools[key].length > 0) {
      result[key] = pools[key];
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

type AiChatNodeType = Node<AiChatNodeData, 'aiChat'>;

// Context: 节点点击 .md 附件时通知画布打开阅读器
export const NodeReaderContext = React.createContext<(nodeMdId: string) => void>(() => {});

export function AiChatNode({ id, data, selected }: NodeProps<AiChatNodeType>) {
  const { setNodes, setEdges, getNode, getEdges, getNodes } = useReactFlow();

  /** 监听上游边断开状态 */
  const allEdges = useStore((s) => s.edges);
  useEffect(() => {
    const hasDisconnected = allEdges.some(
      (e) => e.target === id && e.data?.disconnected,
    );
    setHasDisconnectedUpstream(hasDisconnected);
  }, [allEdges, id]);
  const onOpenReader = useContext(NodeReaderContext);

  const [messages, setMessages] = useState<ChatMessage[]>(data.messages ?? []);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(new Set());
  const [modelId, setModelId] = useState(data.modelId ?? DEFAULT_MODEL_ID);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(data.thinkingLevel ?? DEFAULT_THINKING_LEVEL);
  const [persistError, setPersistError] = useState<string | null>(null);
  const pendingAppendRef = useRef<{ nodeId: string; question: string; answer: string; mood?: { vibe?: string[]; sparks?: string[]; reflections?: string[]; will?: string[] } } | null>(null);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<{name: string; description: string; source?: string; enabled?: boolean}[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [matchedSkills, setMatchedSkills] = useState<string[]>([]);
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [questionPopup, setQuestionPopup] = useState<{
    questions: QuestionItem[];
    assistantContent: string;
  } | null>(null);
  const [hasDisconnectedUpstream, setHasDisconnectedUpstream] = useState(false);
  const [hasStickies, setHasStickies] = useState(false);
  const [stickyLines, setStickyLines] = useState<string[]>([]);
  const [stickyExpanded, setStickyExpanded] = useState(false);
  const [stickyInput, setStickyInput] = useState('');
  const [stickySaving, setStickySaving] = useState(false);
  // 便签动画：idle → opening → visible → closing
  const [stickyAnimPhase, setStickyAnimPhase] = useState<'idle' | 'opening' | 'visible' | 'closing'>('idle');
  const [stickyOrigin, setStickyOrigin] = useState('right top');
  const pinRef = useRef<HTMLButtonElement>(null);
  const miniStickyRef = useRef<HTMLDivElement>(null);
  const stickyPanelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoSendRef = useRef<string | null>(null);
  const currentMdId = data.nodeMdId || id;

  // 引用标签（从 HtmlReader 选中文字后插入）
  const [referenceTag, setReferenceTag] = useState<{ text: string } | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail as { node_id: string; selected_text: string };
        if (detail?.node_id === currentMdId && detail?.selected_text) {
        setReferenceTag({ text: detail.selected_text });
        // 自动聚焦输入框
        setTimeout(() => textareaRef.current?.focus(), 100);
      }
    };
    window.addEventListener('insert-node-reference', handler);
    return () => window.removeEventListener('insert-node-reference', handler);
  }, [currentMdId]);

  // Materials @ mention state
  interface MaterialItem { id: string; name: string; path: string; size: number; extension: string; type: string; uploadedAt: string }
  const [materialFiles, setMaterialFiles] = useState<MaterialItem[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionAtPos, setMentionAtPos] = useState(-1);
  const mentionRef = useRef<HTMLDivElement>(null);
  const [pendingMaterials, setPendingMaterials] = useState<MaterialItem[]>([]);
  const [pendingMaterialPaths, setPendingMaterialPaths] = useState<Set<string>>(new Set());

  // 加载已配置的提供商，并监听设置变更事件
  useEffect(() => {
    const load = async () => {
      const settings = await loadSettings();
      setProviderConfigs(settings.providers);
    };
    load();
    const handler = async () => {
      const settings = await loadSettings();
      setProviderConfigs(settings.providers);
    };
    window.addEventListener('provider-configs-changed', handler);
    return () => window.removeEventListener('provider-configs-changed', handler);
  }, []);

  const availableModels = getAvailableModels(providerConfigs);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);

  // 点击节点外部时关闭下拉菜单
  useEffect(() => {
    if (!modelMenuOpen && !thinkingMenuOpen && !skillMenuOpen) return;
    const handler = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof globalThis.Node)) return;
      if (
        modelMenuRef.current?.contains(target) ||
        thinkingMenuRef.current?.contains(target) ||
        skillMenuRef.current?.contains(target)
      ) return;
      setModelMenuOpen(false);
      setThinkingMenuOpen(false);
      setSkillMenuOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [modelMenuOpen, thinkingMenuOpen, skillMenuOpen]);

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
        .then(d => setAvailableSkills((d.skills || []).filter((s: {enabled?: boolean}) => s.enabled !== false)))
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
    };
    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

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
      .map((c, i) => `| ${i + 1} | **${c.title}** | ${c.summary || '（无摘要）'} |`);
    const table = `| # | 节点标题 | 摘要 |
|---|----------|------|
${rows.join('\n')}
`;

    const toolHint = `如需了解上游节点详细内容（完整对话记录、批注、便签等），请调用 read_upstream_node 工具，传入上方索引表中的**节点标题**。`;

    // 根据上游节点数量生成不同强度的读取指引
    let consolidateHint = '';
    if (contents.length >= 3) {
      consolidateHint = `\n\n**重要：** 你有 ${contents.length} 个上游节点。当用户要求汇总、整理、合并分析或生成报告时，**必须**依次调用 read_upstream_node 读取**全部**上游节点的完整文档，再综合整理出报告。不得遗漏任何上游节点。`;
    } else if (contents.length === 2) {
      consolidateHint = '\n\n**提示：** 当用户要求汇总或对比分析时，请用 read_upstream_node 读取全部上游节点后再作答。';
    }

    const header = `\n\n## 上游节点索引（共 ${contents.length} 个上游节点）\n\n以下是与当前节点相连的上游节点概览。${consolidateHint}`;
    const footer = '\n\n## 回答原则\n以上是上游节点的摘要索引。用户的问题很可能与上游内容相关，请在必要时使用 read_upstream_node 工具读取完整文档。';

    return `${header}\n\n${table}\n${toolHint}${footer}`;
  };

  /** File → base64 (不含 data: 前缀) */
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1] || '');
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  };

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0 || !currentMdId) return;

    const fileArray = Array.from(files);

    setUploadingAttachment(true);
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      try {
        // 用 base64 + JSON 上传，避免 Turbopack FormData bug
        const base64 = await fileToBase64(file);

        const resp: Response = await fetch('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodeId: currentMdId,
            nodeTitle: data.title || '',
            fileName: file.name,
            fileType: file.type || 'application/octet-stream',
            data: base64,
          }),
        });
        const respData = await resp.json();
        if (respData.success && respData.attachment) {
          setPendingAttachments((prev) => [...prev, respData.attachment]);
        } else {
          console.error('上传附件失败:', file.name, respData.error);
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotReadableError') {
          console.warn(`附件无法读取（文件可能已被移动或删除）: ${file.name}`);
        } else {
          console.error('上传附件失败:', file.name, e);
        }
      }
    }
    setUploadingAttachment(false);
  }, [currentMdId]);

  /** 粘贴图片/PDF */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (isStreaming) return;
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      handleFileSelect(dt.files);
    }
  }, [isStreaming, handleFileSelect]);

  /** 拖拽进入 */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isStreaming) setDragOver(true);
  }, [isStreaming]);

  /** 拖拽离开 */
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  /** 拖拽放下 */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (isStreaming) return;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      handleFileSelect(files);
    }
  }, [isStreaming, handleFileSelect]);

  const removePendingAttachment = useCallback((attId: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== attId));
  }, []);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // 加载 materials 文件列表
  const loadMaterialFiles = useCallback(async () => {
    try {
      const resp = await fetch('/api/materials?action=list');
      const data = await resp.json();
      if (data.success) {
        setMaterialFiles(data.files);
      }
    } catch {}
  }, []);

  // 检查节点是否有便签内容
  const refreshStickies = useCallback(() => {
    if (!currentMdId) return;
    fetch(`/api/nodes?id=${currentMdId}&action=raw`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.content) {
          const stickyMatch = data.content.match(/## 便签\n([\s\S]*?)(?:\n##|\n*$)/);
          if (stickyMatch && stickyMatch[1].trim() && stickyMatch[1].trim() !== '（暂无）') {
            setHasStickies(true);
            // 提取便签内容行（去掉 - 前缀和空行）
            const lines = stickyMatch[1].trim().split('\n')
              .map((l: string) => l.replace(/^-\s*/, '').trim())
              .filter((l: string) => l.length > 0);
            setStickyLines(lines);
          } else {
            setHasStickies(false);
            setStickyLines([]);
          }
        }
      })
      .catch(() => {});
  }, [currentMdId]);

  useEffect(() => {
    refreshStickies();
  }, [refreshStickies]);

  // 监听 HtmlReader 端的 sticky notes 更新 → 双向联动
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { node_id: string };
      if (detail?.node_id === currentMdId) {
        refreshStickies();
      }
    };
    window.addEventListener('sticky-notes-updated', handler);
    return () => window.removeEventListener('sticky-notes-updated', handler);
  }, [currentMdId, refreshStickies]);

  /** 选择 @ 引用的文件 */
  const handleMentionSelect = useCallback((file: MaterialItem) => {
    if (mentionAtPos < 0) return;
    // 移除输入框中的 @xxx 查询文字
    const beforeAt = input.slice(0, mentionAtPos);
    const afterQuery = input.slice(mentionAtPos + 1 + mentionQuery.length);
    setInput(`${beforeAt}${afterQuery}`);
    // 添加到 pendingMaterials（去重）
    if (!pendingMaterialPaths.has(file.path)) {
      setPendingMaterials(prev => [...prev, file]);
      setPendingMaterialPaths(prev => new Set(prev).add(file.path));
    }
    setMentionOpen(false);
    setMentionQuery('');
    setMentionAtPos(-1);
    setMentionIndex(0);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [input, mentionAtPos, mentionQuery, pendingMaterialPaths]);

  /** 关闭 mention 弹窗 */
  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionQuery('');
    setMentionAtPos(-1);
    setMentionIndex(0);
  }, []);

  const handleSend = () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput('');
    doSend(text);
  };

  const handleSendWithText = (text: string) => {
    doSend(text);
  };

  const doSend = async (userInput: string) => {
    if (!userInput || isStreaming) return;

    setMatchedSkills([]);
    setHasDisconnectedUpstream(false);

    // 如果有引用标签，拼接到消息中
    let effectiveContent = userInput;
    if (referenceTag) {
      effectiveContent = `> ${referenceTag.text}\n\n${userInput}`;
      setReferenceTag(null); // 发送后清除引用标签
    }

    let currentModelId = modelId;

    if (!currentModelId || currentModelId === DEFAULT_MODEL_ID) {
      const taskAnalysis = analyzeTask(userInput);
      const bestModel = selectBestModel(availableModels, taskAnalysis);

      if (!bestModel) {
        alert('Please configure at least one model in settings');
        return;
      }

      currentModelId = bestModel.modelId;
      setModelId(currentModelId);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, modelId: currentModelId } }
            : n,
        ),
      );
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: userInput,
      attachments: pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
    };

    // 使用 pendingMaterials 构建材料引用表
    const materialFileMap: Record<string, MaterialItem> = {};
    for (const mat of pendingMaterials) {
      materialFileMap[mat.path] = mat;
    }

    // 构建带材料引用的消息内容（发送给 AI 时使用）
    if (pendingMaterials.length > 0) {
      const materialInfo = pendingMaterials.map((file, i) => {
        return `  ${i + 1}. ${file.name} (${file.type}, ${formatFileSize(file.size)})\n     路径: ${file.path}`;
      }).join('\n');
      effectiveContent += `\n\n--- 引用资料列表 ---\n${materialInfo}\n如需了解资料详细内容，请使用 read_material 工具读取。`;
    }

    const assistantId = `msg-${Date.now() + 1}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
    };

    const baseMessages = [...messages, userMsg];
    const newMessages = [...baseMessages, assistantMsg];
    setMessages(newMessages);
    setInput('');
    setPendingAttachments([]);
    setPendingMaterials([]);
    setPendingMaterialPaths(new Set());
    setIsStreaming(true);

    // 获取上游节点上下文，注入到系统提示中
    const upstreamContext = await fetchUpstreamContext();
    const systemContent = upstreamContext
      ? SYSTEM_PROMPT + upstreamContext
      : SYSTEM_PROMPT;
    console.log('[上下文注入] 节点:', currentMdId, '上游上下文长度:', upstreamContext.length);

    // 构建带附件元信息的消息（AI 可通过 read_attachment 工具自主读取附件内容
    const apiMessagesWithAttachments = baseMessages.map((m) => {
      // 对于最后一条用户消息，使用包含材料引用的 effectiveContent
      const msgContent = m.id === userMsg.id && effectiveContent !== m.content
        ? effectiveContent
        : m.content;

      if (!m.attachments || m.attachments.length === 0) {
        return { role: m.role, content: msgContent };
      }

      const attachmentInfo = m.attachments.map((att, i) => {
        return `  ${i + 1}. ${att.name} (${att.type === 'text' ? 'Text' : att.type === 'image' ? 'Image' : 'File'}, ${formatFileSize(att.size)})\n     路径: ${att.path}`;
      }).join('\n');

      return {
        role: m.role,
        content: msgContent + `\n\n--- 附件列表 ---\n${attachmentInfo}\n--- 附件列表结束 ---\n\n如需了解附件内容，请使用 read_attachment 工具读取。`,
      };
    });

    const apiMessages = [
      { role: 'system' as const, content: systemContent },
      ...apiMessagesWithAttachments,
    ];

    const selectedModel = availableModels.find((m) => m.modelId === currentModelId) ?? availableModels[0];
    const custom = isCustomModel(selectedModel.modelId);

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantContent = '';
    let reasoningContent = '';
    const toolCallRecords: ToolCallRecord[] = [];

    const requestBody: Record<string, unknown> = {
      messages: apiMessages,
      nodeId: currentMdId,
      modelId: custom ? undefined : selectedModel.modelId,
      thinking: selectedModel.thinking ? 'enabled' : 'disabled',
      temperature: selectedModel.temperature,
      thinkingLevel,
    };

    if (selectedSkills.size > 0) {
      requestBody.forcedSkills = Array.from(selectedSkills);
    }

    if (custom) {
      const parsed = parseCustomModel(selectedModel.modelId);
      if (parsed) {
        const preset = getProviderPreset(parsed.provider);
        const providerConfig = providerConfigs.find((c) => c.type === parsed.provider);
        if (preset && providerConfig) {
          requestBody.apiKey = providerConfig.apiKey;
          requestBody.baseUrl = preset.baseUrl;
          requestBody.providerModelId = parsed.modelId;
        }
      }
    }

    try {
      const response = await fetch('/api/chat', {
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

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.reasoning) {
                reasoningContent += parsed.reasoning;
                if (mountedRef.current) {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, reasoning: reasoningContent }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.content) {
                assistantContent += parsed.content;
                if (mountedRef.current) {
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
                const tc = parsed.tool_call as { name: string; arguments: Record<string, unknown> };
                toolCallRecords.push({
                  toolName: tc.name,
                  arguments: tc.arguments,
                  result: '...',
                  durationMs: 0,
                  success: true,
                });
                if (mountedRef.current) {
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
                const tr = parsed.tool_result as { name: string; result: string; durationMs: number; success: boolean };
                // 找到第一个同名且结果还是 '...'（待填充）的记录
                const lastIdx = toolCallRecords.findIndex((t) => t.toolName === tr.name && t.result === '...');
                if (lastIdx >= 0) {
                  toolCallRecords[lastIdx] = {
                    ...toolCallRecords[lastIdx],
                    result: tr.result,
                    durationMs: tr.durationMs,
                    success: tr.success,
                  };
                }
                if (mountedRef.current) {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: assistantContent, reasoning: reasoningContent, toolCalls: [...toolCallRecords] }
                        : m,
                    ),
                  );
                }
              }
              if (parsed.tool_summary) {
                // Summary event - could be used for display, currently handled via toolCalls array
              }
              if (parsed.done && parsed.matchedSkills) {
                if (mountedRef.current) {
                  setMatchedSkills(parsed.matchedSkills as string[]);
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
      if (error instanceof Error && error.name !== 'AbortError') {
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
        if (typeof window.api?.update?.notify === 'function') {
          window.api.update.notify('BobAgent', `对话出错: ${error.message}`).catch(() => {});
        }
      }
    } finally {
      if (mountedRef.current) {
        setIsStreaming(false);
        // 回答完成 → 仅窗口不在前台时发系统通知
        if (document.hidden && assistantContent && !assistantContent.startsWith('Error:') && typeof window.api?.update?.notify === 'function') {
          const preview = assistantContent.slice(0, 80).replace(/\n/g, ' ');
          window.api.update.notify('BobAgent 回答完成', preview + (assistantContent.length > 80 ? '...' : '')).catch(() => {});
        }
        const finalMessages: ChatMessage[] = [
          ...baseMessages,
          {
            id: assistantId,
            role: 'assistant',
            content: assistantContent,
            reasoning: reasoningContent || undefined,
            toolCalls: toolCallRecords.length > 0 ? toolCallRecords : undefined,
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

        // 持久化：追加问答到 .md 文件（await 确保写入完成后再更新标题/摘要）
        if (currentMdId && assistantContent && !assistantContent.startsWith('Error:')) {
          // 分离 mood 和干净的回答内容
          const { mood: moodText, content: answerWithoutMood } = parseThinkMood(assistantContent);
          const moodObj = parseMoodTextToObject(moodText);

          // 从回答中提取标题建议
          const { title: suggestedTitle, cleanContent: cleanAnswer } = extractTitleSuggestion(answerWithoutMood);

          console.log('[AiChatNode:save] assistantContent 长度:', assistantContent.length, '前200字:', assistantContent.slice(0, 200));
          console.log('[AiChatNode:save] answerWithoutMood 长度:', answerWithoutMood.length, '前200字:', answerWithoutMood.slice(0, 200));
          console.log('[AiChatNode:save] cleanAnswer 长度:', cleanAnswer.length, '前200字:', cleanAnswer.slice(0, 200));

          // 安全兜底：如果解析后的答案异常短但原文很长，可能是 <think> 标签未闭合导致内容被清空
          let finalAnswer = cleanAnswer;
          if (cleanAnswer.length < 10 && assistantContent.length > 100) {
            console.warn('[AiChatNode:save] 解析后答案异常短，可能 <think> 未闭合，使用原文兜底');
            // 尝试只去除已知安全的部分：mood 标签和 TITLE 注释
            let fallback = assistantContent
              .replace(/<mood>[\s\S]*?<\/mood>/gi, '')
              .replace(/<!--\s*TITLE:\s*.+?\s*-->/gi, '')
              .trim();
            if (fallback.length > cleanAnswer.length) {
              finalAnswer = fallback;
              console.log('[AiChatNode:save] 兜底答案长度:', finalAnswer.length);
            }
          }

          // 从用户消息中获取附件（移除 dataUrl 以减少存储）
          const savedAttachments = userMsg.attachments?.map(({ dataUrl, ...rest }) => rest) || [];

          // 1. 先写入 .md 文件（带重试）
          let appendSuccess = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const resp = await fetch('/api/nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'append',
                  node_id: currentMdId,
                  question: userInput,
                  answer: finalAnswer,
                  mood: moodObj,
                  question_attachments: savedAttachments,
                  title: data.title || 'AI Chat',
                }),
              });
              if (resp.ok) {
                setPersistError(null);
                pendingAppendRef.current = null;
                appendSuccess = true;
                refreshStickies();
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

          if (!appendSuccess) {
            // 3 次重试都失败，保存待重试数据并提示
            pendingAppendRef.current = {
              nodeId: currentMdId!,
              question: userInput,
              answer: cleanAnswer,
              mood: moodObj,
            };
            setPersistError('Save failed, click to retry');
          }

          // 2. 更新节点标题（仅当标题为默认值时，即首次对话后自动命名）
          if (appendSuccess && data.title === 'AI Chat' && suggestedTitle && suggestedTitle.length > 2 && suggestedTitle.length <= 50) {
            try {
              const renameResp = await fetch('/api/nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'rename_title',
                  node_id: currentMdId,
                  new_title: suggestedTitle,
                }),
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
              // 标题更新失败不影响主流程
            }
          }

          // 3. 生成消息摘要（写入 .md 文件后，调用 summarize API 生成智能摘要）
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
                question: userInput,
                answer: cleanAnswer,
              };
              if (custom) {
                const parsed = parseCustomModel(selectedModel.modelId);
                if (parsed) {
                  const preset = getProviderPreset(parsed.provider);
                  const providerConfig = providerConfigs.find((c) => c.type === parsed.provider);
                  if (preset && providerConfig) {
                    summarizeBody.apiKey = providerConfig.apiKey;
                    summarizeBody.baseUrl = preset.baseUrl;
                    summarizeBody.providerModelId = parsed.modelId;
                  }
                }
              }
              fetch('/api/nodes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(summarizeBody),
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

        // 检查 AI 回复中是否包含提问
        if (assistantContent && !assistantContent.startsWith('Error:')) {
          const { questions, cleanContent } = extractQuestions(assistantContent);
          if (questions.length > 0) {
            // 更新消息内容为去除提问块后的纯文本
            const cleanedMessages = finalMessages.map((m) =>
              m.id === assistantId ? { ...m, content: cleanContent } : m,
            );
            setMessages(cleanedMessages);
            setNodes((nds) =>
              nds.map((n) =>
                n.id === id
                  ? { ...n, data: { ...n.data, messages: cleanedMessages } }
                  : n,
              ),
            );
            // 显示提问弹窗
            setQuestionPopup({ questions, assistantContent: cleanContent });
          }
        }
      }
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleQuestionSubmit = (answers: AnswerEntry[]) => {
    const answerText = answers
      .map((a, i) => {
        const q = questionPopup?.questions[i];
        const qText = q?.question || `问题${i + 1}`;
        let ans = a.selected || '';
        if (a.custom.trim()) {
          ans = ans ? `${ans}（补充：${a.custom.trim()}）` : a.custom.trim();
        }
        return `关于"${qText}"：${ans}`;
      })
      .join('\n');

    setQuestionPopup(null);
    autoSendRef.current = answerText;
  };

  // autoSendRef 变化时自动触发发送
  useEffect(() => {
    if (autoSendRef.current && !isStreaming) {
      const text = autoSendRef.current;
      autoSendRef.current = null;
      setInput(text);
      // 下一帧触发 handleSend
      requestAnimationFrame(() => {
        handleSendWithText(text);
      });
    }
  }, [autoSendRef.current, isStreaming]);

  const handleSelectModel = useCallback((newModelId: string) => {
    setModelId(newModelId);
    setModelMenuOpen(false);
    const newModel = availableModels.find((m) => m.modelId === newModelId);
    const supportsThinking = newModel?.thinking ?? false;
    if (!supportsThinking && thinkingLevel !== 'off') {
      setThinkingLevel('off');
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, modelId: newModelId, thinkingLevel: 'off' as ThinkingLevel } }
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
  }, [id, setNodes, availableModels, thinkingLevel]);

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

  const toggleReasoning = useCallback((msgId: string) => {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 如果 mention 弹窗打开，处理其中的键盘事件
    if (mentionOpen) {
      const filtered = materialFiles.filter((f) =>
        f.name.toLowerCase().includes(mentionQuery.toLowerCase()),
      );
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[mentionIndex]) {
          handleMentionSelect(filtered[mentionIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // 输入 "/" 触发技能菜单
    if (e.key === '/' && !isStreaming && availableSkills.length > 0) {
      setTimeout(() => setSkillMenuOpen(true), 50);
    }
  };

  const handleDelete = useCallback(() => {
    abortRef.current?.abort();

    const node = getNode(id);
    const nodeMdId = node?.data?.nodeMdId || id;

    // 先从画布移除
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));

    // 调用API删除节点文件和关联边
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', node_id: nodeMdId }),
    }).then((r) => {
      if (!r.ok) {
        console.error('节点删除失败:', r.status, r.statusText);
      }
    }).catch((err) => {
      console.error('节点删除请求出错:', err);
    });
  }, [id, getNode, setNodes, setEdges]);

  const handleRetryAppend = useCallback(async () => {
    const pending = pendingAppendRef.current;
    if (!pending) return;
    setPersistError('Saving...');
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'append',
          node_id: pending.nodeId,
          question: pending.question,
          answer: pending.answer,
          mood: pending.mood,
          title: data.title || 'AI Chat',
        }),
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
          body: JSON.stringify({
            action: 'remove_round',
            node_id: currentMdId,
            round_index: roundIndex,
          }),
        });
        window.dispatchEvent(new CustomEvent('node-document-updated', { detail: { node_id: currentMdId } }));
      } catch {
        // 静默失败
      }
    }
  }, [messages, currentMdId]);

  // 便签打开：从标题栏便签标签位置平滑展开为编辑面板
  const handleStickyOpen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setStickyInput(hasStickies ? stickyLines.join('\n') : '');
    // 动画原点：从左侧便签纸位置展开
    setStickyOrigin('right top');
    setStickyExpanded(true);
    setStickyAnimPhase('opening');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setStickyAnimPhase('visible');
      });
    });
  }, [hasStickies, stickyLines]);

  // 便签关闭：反向收缩回缩小态位置
  const handleStickyClose = useCallback(() => {
    setStickyAnimPhase('closing');
    setTimeout(() => {
      setStickyExpanded(false);
      setStickyAnimPhase('idle');
    }, 300);
  }, []);

  // 便签 Enter 自动编号：已有的行自动编号，并创建下一个编号行
  const handleStickyKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const textarea = e.currentTarget;
      const currentText = textarea.value;
      const lines = currentText.split('\n');

      // 找出已有编号中的最大值（格式：N. 或 N) ）
      let lastNum = 0;
      const numbered: boolean[] = new Array(lines.length).fill(false);
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(\d+)[.)]\s*/);
        if (match) {
          lastNum = Math.max(lastNum, parseInt(match[1], 10));
          numbered[i] = true;
        }
      }

      // 为未编号的非空行自动编号
      const resultLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (numbered[i]) {
          resultLines.push(lines[i]);
        } else {
          lastNum++;
          resultLines.push(`${lastNum}. ${trimmed}`);
        }
      }

      // 添加下一个编号空行
      lastNum++;
      const newLine = `${lastNum}. `;
      resultLines.push(newLine);

      const newText = resultLines.join('\n');
      setStickyInput(newText);

      // 光标放到新行末尾
      setTimeout(() => {
        textarea.selectionStart = newText.length;
        textarea.selectionEnd = newText.length;
      }, 0);
    }
  }, []);

  const handleStickySave = useCallback(async () => {
    if (!currentMdId || stickySaving) return;
    const lines = stickyInput
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    setStickySaving(true);
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set_stickies',
          node_id: currentMdId,
          stickies: lines,
        }),
      });
      if (resp.ok) {
        setStickyLines(lines);
        setHasStickies(lines.length > 0);
        handleStickyClose();
        setStickyInput('');
        // 通知 HtmlReader 同步更新
        window.dispatchEvent(new CustomEvent('sticky-notes-updated', { detail: { node_id: currentMdId } }));
      }
    } catch {
      // save failed silently
    } finally {
      setStickySaving(false);
    }
  }, [currentMdId, stickyInput, stickySaving]);

  return (
    <div
      className="ai-node-wrapper group relative w-[320px] cursor-default"
    >
      {/* 扩展 hover 触发面积（超出节点 40px），鼠标离开节点后按钮不立即消失 */}
      <div className="absolute -inset-10 z-0" />
      {/* 展开态：编辑面板 — 带缩放展开/收缩动效 */}
      {stickyExpanded && (
        <div
          ref={stickyPanelRef}
          className="absolute z-30"
          style={{
            right: '-20px',
            top: '40px',
            width: '250px',
            transform: stickyAnimPhase === 'visible' ? 'scale(1)' : 'scale(0.48)',
            opacity: stickyAnimPhase === 'closing' ? 0 : 1,
            transformOrigin: stickyOrigin,
            transition: stickyAnimPhase === 'visible' || stickyAnimPhase === 'opening'
              ? 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease'
              : 'transform 0.28s cubic-bezier(0.5, 0, 0.75, 0), opacity 0.2s ease',
            pointerEvents: stickyAnimPhase === 'visible' ? 'auto' : 'none',
          }}
          onWheel={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="flex flex-col sticky-paper"
            style={{
              backgroundColor: '#f5e6c8',
              borderRadius: '0',
              border: '1px solid oklch(0.88 0.10 95 / 0.5)',
              boxShadow: '2px 5px 14px rgba(0,0,0,0.12), -1px 3px 6px rgba(0,0,0,0.06)',
              fontFamily: "'Noto Serif SC', serif",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-3 py-2"
              style={{ borderBottom: '1px solid oklch(0.82 0.08 90 / 0.4)' }}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-base">📌</span>
                <span className="text-xs font-semibold" style={{ color: 'oklch(0.30 0.02 30)' }}>Sticky Notes</span>
              </div>
              <button
                onClick={handleStickyClose}
                className="flex h-5 w-5 items-center justify-center rounded text-xs"
                style={{ color: 'oklch(0.50 0.02 50)' }}
              >
                ✕
              </button>
            </div>

            {/* 编辑区 */}
            <div className="p-3">
              <textarea
                value={stickyInput}
                onChange={(e) => setStickyInput(e.target.value)}
                className="nodrag w-full resize-y rounded border px-3 py-2 text-xs leading-relaxed"
                style={{
                  minHeight: '120px',
                  backgroundColor: '#faf3e0',
                  borderColor: 'oklch(0.84 0.08 92 / 0.6)',
                  color: 'oklch(0.28 0.02 50)',
                  outline: 'none',
                  fontSize: '12px',
                }}
                placeholder="输入便签，每行一条..."
                rows={4}
                onKeyDown={handleStickyKeyDown}
                onWheel={(e) => e.stopPropagation()}
              />
            </div>

            {/* 底部按钮 */}
            <div className="flex justify-end gap-2 px-3 pb-3">
              <button
                onClick={handleStickyClose}
                className="rounded px-3 py-1.5 text-xs font-medium transition-colors"
                style={{ color: 'oklch(0.50 0.02 50)' }}
              >
                取消
              </button>
              <button
                onClick={handleStickySave}
                disabled={stickySaving}
                className="rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
              >
                {stickySaving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inner card */}
      <div
        className={cn(
          'relative z-[1] flex w-full flex-col rounded-xl border transition-all duration-200',
          selected
            ? 'shadow-[0_0_24px_oklch(0.62_0.17_45/0.15)]'
            : 'shadow-[0_4px_20px_oklch(0.40_0.03_50/0.10)]',
        )}
        style={{
          background: 'oklch(0.97 0.015 80 / 0.96)',
          borderColor: selected
            ? 'oklch(0.62 0.17 45 / 0.5)'
            : 'oklch(0.78 0.03 60 / 0.45)',
        }}
      >
      {/* Target Handle - 接收连线（内侧） */}
      <Handle
        type="target"
        position={Position.Top}
        id="top-target"
        isConnectable
        className="!h-3 !w-3 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-60"
        style={{
          backgroundColor: 'oklch(0.97 0.015 80)',
          borderColor: 'oklch(0.55 0.15 145 / 0.7)',
          top: 0,
        }}
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom-target"
        isConnectable
        className="!h-3 !w-3 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-60"
        style={{
          backgroundColor: 'oklch(0.97 0.015 80)',
          borderColor: 'oklch(0.55 0.15 145 / 0.7)',
          bottom: 0,
        }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left-target"
        isConnectable
        className="!h-3 !w-3 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-60"
        style={{
          backgroundColor: 'oklch(0.97 0.015 80)',
          borderColor: 'oklch(0.55 0.15 145 / 0.7)',
          left: 0,
        }}
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right-target"
        isConnectable
        className="!h-3 !w-3 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-60"
        style={{
          backgroundColor: 'oklch(0.97 0.015 80)',
          borderColor: 'oklch(0.55 0.15 145 / 0.7)',
          right: 0,
        }}
      />

      {/* Source Handle - 拖拽生成节点（外侧，稍大） */}
      <Handle
        type="source"
        position={Position.Top}
        id="top"
        isConnectable
        className="!h-3.5 !w-3.5 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-80"
        style={{
          backgroundColor: 'oklch(0.62 0.17 45 / 0.8)',
          borderColor: 'oklch(0.97 0.015 80)',
          top: '-2px',
          boxShadow: '0 2px 8px oklch(0.62 0.17 45 / 0.3)',
        }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        isConnectable
        className="!h-3.5 !w-3.5 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-80"
        style={{
          backgroundColor: 'oklch(0.62 0.17 45 / 0.8)',
          borderColor: 'oklch(0.97 0.015 80)',
          bottom: '-2px',
          boxShadow: '0 2px 8px oklch(0.62 0.17 45 / 0.3)',
        }}
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        isConnectable
        className="!h-3.5 !w-3.5 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-80"
        style={{
          backgroundColor: 'oklch(0.62 0.17 45 / 0.8)',
          borderColor: 'oklch(0.97 0.015 80)',
          left: '-2px',
          boxShadow: '0 2px 8px oklch(0.62 0.17 45 / 0.3)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        isConnectable
        className="!h-3.5 !w-3.5 !rounded-full !border-2 !opacity-0 transition-opacity hover:!opacity-100 group-hover:!opacity-80"
        style={{
          backgroundColor: 'oklch(0.62 0.17 45 / 0.8)',
          borderColor: 'oklch(0.97 0.015 80)',
          right: '-2px',
          boxShadow: '0 2px 8px oklch(0.62 0.17 45 / 0.3)',
        }}
      />

      {/* Header */}
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'oklch(0.80 0.03 60 / 0.3)' }}
      >
        <Sparkles
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: 'oklch(0.55 0.15 45)' }}
        />
        <span
          className="flex-1 truncate text-xs font-semibold"
          style={{ color: 'oklch(0.30 0.015 50)' }}
        >
          {data.title}
        </span>
        {/* 断线警告角标 */}
        {hasDisconnectedUpstream && (
          <span
            className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: 'oklch(0.58 0.22 35 / 0.12)' }}
            title="上游节点连线已断开，上下文可能不完整"
          >
            <AlertTriangle className="h-3 w-3" style={{ color: 'oklch(0.55 0.22 35)' }} />
          </span>
        )}
        {/* sticky notes — 缩小便签钉在备忘录图标上 */}
        <span className="relative shrink-0">
          <button
            ref={pinRef}
            onClick={handleStickyOpen}
            className="flex shrink-0 items-center transition-opacity hover:opacity-70 relative z-10"
            title={hasStickies ? `${stickyLines.length} 条便签` : '添加便签'}
          >
            <span className="text-[13px] leading-none">📝</span>
          </button>
          {hasStickies && stickyLines.length > 0 && !stickyExpanded && (
            <div
              ref={miniStickyRef}
              onClick={handleStickyOpen}
              className="nodrag absolute z-20 cursor-pointer sticky-paper transition-all hover:scale-[1.05] active:scale-95"
              style={{
                bottom: '-26px',
                right: '0px',
                width: '50px',
                height: '53px',
                backgroundColor: '#f5e6c8',
                border: '1px solid oklch(0.88 0.10 95 / 0.5)',
                borderRadius: '0',
                boxShadow: '2px 5px 14px rgba(0,0,0,0.08), -1px 3px 6px rgba(0,0,0,0.04)',
                fontFamily: "'Noto Serif SC', serif",
                transform: 'rotate(-3deg)',
                padding: '5px 6px',
                overflow: 'visible',
              }}
            >
              <div className="flex flex-col gap-px text-[7px] leading-tight" style={{ color: 'oklch(0.34 0.02 40)' }}>
                {stickyLines.slice(0, 2).map((line, i) => (
                  <div key={i} className="truncate">{line}</div>
                ))}
                {stickyLines.length > 2 && (
                  <div className="text-[6px]" style={{ color: 'oklch(0.50 0.02 40 / 0.6)' }}>+{stickyLines.length - 2}</div>
                )}
              </div>
              {/* 图钉 */}
              <span
                className="absolute pointer-events-none"
                style={{
                  top: '-2px',
                  right: '-3px',
                  fontSize: '12px',
                  lineHeight: 1,
                  transform: 'rotate(15deg)',
                  filter: 'drop-shadow(0px 1.5px 1.5px rgba(0,0,0,0.3))',
                  display: 'inline-block',
                  overflow: 'hidden',
                  height: '9px',
                }}
              >📌</span>
            </div>
          )}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
          className="flex h-5 w-5 items-center justify-center rounded transition-colors"
          style={{ color: 'oklch(0.55 0.02 50 / 0.5)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'oklch(0.58 0.22 27 / 0.12)';
            e.currentTarget.style.color = 'oklch(0.50 0.22 27)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = 'oklch(0.55 0.02 50 / 0.5)';
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onMouseDown={(e) => e.stopPropagation()}
        className="nodrag flex max-h-[300px] min-h-[60px] flex-col gap-2 overflow-y-auto p-3 ai-canvas-scroll"
      >
        {messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center py-4">
            <span
              className="text-xs"
              style={{ color: 'oklch(0.55 0.02 50 / 0.5)' }}
            >
              Type a message...

            </span>
          </div>
        )}
        {persistError && (
          <div
            onClick={persistError === 'Save failed, click to retry' || persistError === 'Retry failed, click to try again' ? handleRetryAppend : undefined}
            className="mx-3 mb-2 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] cursor-pointer"
            style={{
              backgroundColor: 'oklch(0.58 0.22 27 / 0.08)',
              color: 'oklch(0.42 0.16 27)',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            }}
          >
            <span className="text-xs">⚠</span>
            <span className="flex-1">{persistError}</span>
            {(persistError === 'Save failed, click to retry' || persistError === 'Retry failed, click to try again') && (
              <span className="underline text-[10px]">Retry</span>
            )}
          </div>
        )}
        {/* 已触发技能标签 */}
        {matchedSkills.length > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5"
            style={{
              borderColor: 'oklch(0.62 0.17 45 / 0.3)',
              backgroundColor: 'oklch(0.62 0.17 45 / 0.06)',
            }}
          >
            <Sparkles className="h-3 w-3 shrink-0" style={{ color: 'oklch(0.55 0.15 45)' }} />
            <span className="text-[10px] font-medium" style={{ color: 'oklch(0.45 0.10 45)' }}>触发技能</span>
            {matchedSkills.map((name) => (
              <span
                key={name}
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: 'oklch(0.62 0.17 45)',
                  color: '#fff',
                }}
              >
                {name}
              </span>
            ))}
          </div>
        ) : !isStreaming && messages.length > 0 ? (
          <div className="mb-2 flex items-center gap-1 rounded-md px-2 py-1"
            style={{ backgroundColor: 'oklch(0.95 0.005 70 / 0.5)' }}
          >
            <span className="text-[9px]" style={{ color: 'oklch(0.60 0.01 50)' }}>未触发技能</span>
          </div>
        ) : null}
        {messages.map((msg) => {
          const showReasoning = msg.reasoning && msg.reasoning.trim().length > 0;

          // Parse <think> and <mood> tags from content
          const displayConfig = DISPLAY_CONFIGS[thinkingLevel];
          const parsedContent = msg.role === 'assistant' && msg.content
            ? parseThinkMood(msg.content)
            : null;
          const hasThinkTags = parsedContent && parsedContent.think.trim().length > 0;
          const hasMoodTags = parsedContent && parsedContent.mood.trim().length > 0;
          const cleanContent = parsedContent ? parsedContent.content : msg.content;

          // Show reasoning block only if display config allows it
          const showThinkBlock = displayConfig.showThinkBlock && (showReasoning || hasThinkTags);
          const showMoodBlock = hasMoodTags && displayConfig.showMood;

          // Think block collapse logic — always collapsed by default
          const thinkExpanded = showThinkBlock
            ? (isStreaming && !cleanContent ? true : expandedReasoning.has(msg.id + '-think'))
            : false;

          // Mood block collapse logic
          const moodDefaultCollapsed = displayConfig.moodCollapsed;
          const moodExpanded = showMoodBlock
            ? (isStreaming && !cleanContent ? true : (!moodDefaultCollapsed || expandedReasoning.has(msg.id + '-mood')))
            : false;

          // The think text to display (prefer API reasoning_content, fallback to <think> tags)
          const thinkText = showReasoning ? msg.reasoning : (hasThinkTags ? parsedContent!.think : '');

          // Tool calls collapse logic — 默认折叠
          const toolsExpanded = expandedReasoning.has(msg.id + '-tools');

          // AI 回复：显示完整内容 + .md 附件卡片
          const isAssistantDone = msg.role === 'assistant' && !isStreaming && cleanContent && !/^\[?(Error|工具|tool)/i.test(cleanContent) && !cleanContent.startsWith('Error:');

          return (
          <div
            key={msg.id}
            className={cn(
              'flex flex-col',
              msg.role === 'user' ? 'items-end' : 'items-start',
            )}
          >
            {/* MOOD block (collapsible) — 四池网格布局 */}
            {showMoodBlock && (
              <div className="mb-1.5 w-full">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleReasoning(msg.id + '-mood');
                  }}
                  className="flex items-center gap-1.5 text-[11px] font-medium transition-opacity hover:opacity-80"
                  style={{ color: 'oklch(0.50 0.05 55 / 0.6)' }}
                >
                  <Sparkles className="h-3 w-3" style={{ color: 'oklch(0.55 0.12 55 / 0.7)' }} />
                  <span>MOOD</span>
                  <ChevronDown
                    className={cn('h-3 w-3 transition-transform', moodExpanded ? 'rotate-180' : '')}
                  />
                </button>
                {moodExpanded && (
                  <div
                    className="mt-1 rounded-lg border p-2 ai-canvas-scroll"
                    style={{
                      borderColor: 'oklch(0.80 0.05 55 / 0.2)',
                      backgroundColor: 'oklch(0.97 0.008 70 / 0.5)',
                    }}
                  >
                    {(() => {
                      // 解析 MOOD 四个池子
                      const moodText = parsedContent!.mood;
                      const pools: { label: string; cls: string; color: string; items: string[] }[] = [
                        { label: 'Vibe', cls: 'vibe', color: 'oklch(0.55 0.20 25)', items: [] },
                        { label: 'Sparks', cls: 'sparks', color: 'oklch(0.65 0.15 85)', items: [] },
                        { label: 'Reflections', cls: 'reflections', color: 'oklch(0.55 0.10 230)', items: [] },
                        { label: 'Will', cls: 'will', color: 'oklch(0.55 0.15 145)', items: [] },
                      ];
                      // 方式1: 按 "Vibe:" / "Sparks:" 标签分割
                      const sections = moodText.split(/(?:^|\n)\s*(?:Vibe|Sparks|Reflections|Will)\s*[:：]\s*/i);
                      const labels = moodText.match(/(?:Vibe|Sparks|Reflections|Will)\s*[:：]/gi) || [];
                      for (let i = 0; i < labels.length && i + 1 < sections.length; i++) {
                        const labelLower = labels[i].toLowerCase().replace(/[:：]\s*/, '').trim();
                        const pool = pools.find(p => p.label.toLowerCase() === labelLower);
                        if (pool) {
                          pool.items = sections[i + 1]
                            .split('\n')
                            .map(s => s.replace(/^[-•·]\s*/, '').trim())
                            .filter(s => s.length > 0);
                        }
                      }
                      // 方式2: 如果方式1失败，尝试 <vibe>...</vibe> XML 标签格式
                      if (pools.every(p => p.items.length === 0)) {
                        for (const pool of pools) {
                          const tagRegex = new RegExp(`<${pool.cls}>([\\s\\S]*?)</${pool.cls}>`, 'i');
                          const match = moodText.match(tagRegex);
                          if (match) {
                            pool.items = match[1]
                              .split('\n')
                              .map(s => s.replace(/^[-•·]\s*/, '').trim())
                              .filter(s => s.length > 0);
                          }
                        }
                      }
                      // 如果仍然解析失败，整体作为 Vibe
                      if (pools.every(p => p.items.length === 0) && moodText.trim()) {
                        pools[0].items = [moodText.trim()];
                      }
                      return pools.filter(p => p.items.length > 0).map(pool => (
                        <div
                          key={pool.cls}
                          className="mb-1.5 last:mb-0 rounded-md px-2 py-1"
                          style={{ backgroundColor: 'oklch(0.95 0.005 70 / 0.5)' }}
                        >
                          <div
                            className="text-[10px] font-semibold uppercase tracking-wide mb-0.5"
                            style={{ color: pool.color }}
                          >
                            {pool.label}
                          </div>
                          <ul className="space-y-0.5">
                            {pool.items.map((item, idx) => (
                              <li
                                key={idx}
                                className="text-[11px] leading-snug flex gap-1"
                                style={{ color: 'oklch(0.45 0.03 55 / 0.8)' }}
                              >
                                <span style={{ color: 'oklch(0.60 0.02 50 / 0.4)' }}>—</span>
                                <span className="whitespace-pre-wrap break-words">{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Think block (collapsible) — 流式时带脉冲指示器 */}
            {showThinkBlock && (
              <div className="mb-1.5 w-full">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleReasoning(msg.id + '-think');
                  }}
                  className="flex items-center gap-1.5 text-[11px] font-medium transition-opacity hover:opacity-80"
                  style={{ color: 'oklch(0.50 0.02 50 / 0.6)' }}
                >
                  <Brain className="h-3 w-3" style={{ color: 'oklch(0.55 0.10 45 / 0.6)' }} />
                  <span>{isStreaming && !cleanContent ? 'Thinking...' : 'Thought Process'}</span>
                  {isStreaming && !cleanContent && (
                    <span
                      className="ml-auto inline-block h-1.5 w-1.5 rounded-full animate-pulse"
                      style={{ backgroundColor: 'oklch(0.55 0.15 45 / 0.7)' }}
                    />
                  )}
                  <ChevronDown
                    className={cn('h-3 w-3 transition-transform', thinkExpanded ? 'rotate-180' : '')}
                  />
                </button>
                {thinkExpanded && (
                  <div
                    className="mt-1 max-h-[160px] overflow-y-auto rounded-lg border px-2.5 py-1.5 text-[12px] leading-relaxed ai-canvas-scroll"
                    style={{
                      borderColor: 'oklch(0.80 0.02 60 / 0.25)',
                      backgroundColor: 'oklch(0.96 0.008 75 / 0.6)',
                      color: displayConfig.thinkDimmed ? 'oklch(0.48 0.02 50 / 0.8)' : 'oklch(0.30 0.015 50)',
                      fontFamily: "'Noto Serif SC', Georgia, serif",
                    }}
                  >
                    <span className="whitespace-pre-wrap break-words">
                      {thinkText}
                      {isStreaming && !cleanContent && (
                        <span
                          className="ml-0.5 inline-block h-3 w-0.5 animate-pulse"
                          style={{ backgroundColor: 'oklch(0.50 0.10 45 / 0.5)' }}
                        />
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Tool calls block — 统一折叠展示 */}
            {msg.toolCalls && msg.toolCalls.length > 0 ? (
              <div className="mb-1.5 w-full">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleReasoning(msg.id + '-tools');
                  }}
                  className="flex items-center gap-1.5 text-[11px] font-medium transition-opacity hover:opacity-80"
                  style={{ color: 'oklch(0.50 0.08 45 / 0.7)' }}
                >
                  <Wrench className="h-3 w-3" style={{ color: 'oklch(0.55 0.12 45 / 0.7)' }} />
                  <span>Tool Calls ({msg.toolCalls.length})</span>
                  {/* 折叠时不显示任何摘要 */}
                  {!toolsExpanded && msg.toolCalls.length > 4 && (
                    <span className="ml-1 text-[10px]" style={{ color: 'oklch(0.50 0.02 50 / 0.4)' }}>+{msg.toolCalls.length - 4}</span>
                  )}
                  <ChevronDown
                    className={cn('ml-auto h-3 w-3 transition-transform', toolsExpanded ? 'rotate-180' : '')}
                  />
                </button>
                {/* 展开时显示完整详情 */}
                {toolsExpanded && (
                  <div className="mt-1 space-y-1.5">
                    {msg.toolCalls.map((tc, idx) => (
                      <div
                        key={idx}
                        className="rounded-lg border px-2.5 py-1.5 text-[12px] ai-canvas-scroll"
                        style={{
                          borderColor: 'oklch(0.80 0.05 55 / 0.25)',
                          backgroundColor: 'oklch(0.96 0.01 70 / 0.5)',
                        }}
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span
                            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: 'oklch(0.62 0.17 45 / 0.12)',
                              color: 'oklch(0.50 0.15 45)',
                            }}
                          >
                            <Wrench className="h-2.5 w-2.5" />
                            {tc.toolName}
                          </span>
                          {tc.durationMs > 0 && (
                            <span className="text-[10px]" style={{ color: 'oklch(0.50 0.02 50 / 0.5)' }}>
                              {tc.durationMs.toFixed(0)}ms
                            </span>
                          )}
                          {tc.result !== '...' && (
                            tc.success ? (
                              <CheckCircle2 className="h-3 w-3" style={{ color: 'oklch(0.55 0.15 145 / 0.7)' }} />
                            ) : (
                              <XCircle className="h-3 w-3" style={{ color: 'oklch(0.55 0.15 25 / 0.7)' }} />
                            )
                          )}
                        </div>
                        {/* Arguments */}
                        <div className="mb-0.5" style={{ color: 'oklch(0.45 0.02 50 / 0.7)' }}>
                          <span className="text-[10px]">Args: </span>
                          <code className="text-[11px]" style={{ fontFamily: 'ui-monospace, monospace' }}>
                            {JSON.stringify(tc.arguments)}
                          </code>
                        </div>
                        {/* Result */}
                        {tc.result !== '...' && (
                          <div
                            className="mt-0.5 max-h-[80px] overflow-y-auto rounded px-1.5 py-1 text-[11px] leading-relaxed ai-canvas-scroll"
                            style={{
                              backgroundColor: 'oklch(0.94 0.008 75 / 0.6)',
                              color: tc.success ? 'oklch(0.35 0.015 50)' : 'oklch(0.50 0.15 25)',
                            }}
                          >
                            <span className="whitespace-pre-wrap break-words">{tc.result}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : msg.role === 'assistant' && !isStreaming && cleanContent && !cleanContent.startsWith('[') ? (
              <div className="mb-1 w-full">
                <div
                  className="flex items-center gap-1.5 text-[10px]"
                  style={{ color: 'oklch(0.55 0.02 50 / 0.4)' }}
                  title="No tools were used for this response"
                >
                  <Wrench className="h-2.5 w-2.5" />
                  <span>No tools</span>
                </div>
              </div>
            ) : null}

            {/* Message bubble wrapper */}
            <div className={cn('relative group/msg-container', msg.role === 'user' ? 'ml-auto max-w-[85%]' : 'w-full')}>
              <div
                className={cn(
                  'group/msg rounded-lg px-3 py-1.5 text-[13px] leading-relaxed',
                )}
                style={{
                  backgroundColor:
                    msg.role === 'user'
                      ? 'oklch(0.92 0.035 50)'
                      : cleanContent.startsWith('[')
                        ? 'oklch(0.95 0.04 25 / 0.8)'
                        : 'oklch(0.93 0.015 75)',
                  color:
                    msg.role === 'user'
                      ? 'oklch(0.35 0.02 50)'
                      : cleanContent.startsWith('[')
                        ? 'oklch(0.50 0.15 25)'
                        : 'oklch(0.28 0.02 50)',
                }}
              >
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-0.5">
                    {msg.attachments.map((att) => (
                      <span
                        key={att.id}
                        className="inline-flex items-center gap-0.5 rounded-full px-1 py-px"
                        style={{
                          backgroundColor: msg.role === 'user' ? 'oklch(0.62 0.17 45 / 0.08)' : 'rgba(255,255,255,0.5)',
                          border: `1px solid ${msg.role === 'user' ? 'oklch(0.62 0.17 45 / 0.2)' : 'rgba(0,0,0,0.08)'}`,
                        }}
                      >
                        {att.type === 'image' && att.dataUrl ? (
                          <img src={att.dataUrl} alt={att.name} className="h-3 w-3 rounded-sm object-cover" />
                        ) : att.type === 'text' ? (
                          <FileText className="h-2.5 w-2.5" style={{ color: '#537D96' }} />
                        ) : (
                          <Paperclip className="h-2.5 w-2.5" style={{ color: '#7a7260' }} />
                        )}
                        <span className="max-w-[48px] truncate text-[9px]" style={{ color: msg.role === 'user' ? 'oklch(0.45 0.02 55 / 0.8)' : '#a09880' }}>
                          {att.name}
                        </span>
                        <span className="text-[8px]" style={{ color: msg.role === 'user' ? 'oklch(0.45 0.02 50 / 0.5)' : '#a09880' }}>
                          {formatFileSize(att.size)}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
                {cleanContent ? (
                  <>
                    {isAssistantDone ? (
                      <>
                        <HtmlRenderer content={cleanContent} />
                        {data.nodeMdId && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenReader?.(data.nodeMdId!);
                            }}
                            className="mt-2 flex w-full items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-opacity hover:opacity-80"
                            style={{
                              borderColor: 'rgba(83, 125, 150, 0.12)',
                              backgroundColor: '#fffef9',
                              color: '#537D96',
                            }}
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{data.title || 'Document'}.md</span>
                          </button>
                        )}
                      </>
                    ) : (
                      <span className={msg.role === 'user' ? 'whitespace-pre-line break-words' : 'whitespace-pre-wrap break-words'}>
                        {cleanContent}
                      </span>
                    )}
                  </>
                ) : !showThinkBlock ? (
                  <span className="inline-flex items-center gap-1 py-0.5">
                    <span
                      className="h-1.5 w-1.5 animate-bounce rounded-full"
                      style={{
                        backgroundColor: 'oklch(0.55 0.15 45)',
                        animationDelay: '0ms',
                      }}
                    />
                    <span
                      className="h-1.5 w-1.5 animate-bounce rounded-full"
                      style={{
                        backgroundColor: 'oklch(0.55 0.15 45)',
                        animationDelay: '150ms',
                      }}
                    />
                    <span
                      className="h-1.5 w-1.5 animate-bounce rounded-full"
                      style={{
                        backgroundColor: 'oklch(0.55 0.15 45)',
                        animationDelay: '300ms',
                      }}
                    />
                  </span>
                ) : null}
              </div>
              {/* 用户消息：复制 + 删除按钮在文字下方 */}
              {msg.role === 'user' && cleanContent && (
                <div className="flex items-center justify-end gap-0.5 mt-0.5 opacity-0 group-hover/msg-container:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(msg.content);
                      setCopiedMsgId(msg.id);
                      setTimeout(() => setCopiedMsgId(null), 1500);
                    }}
                    className="flex items-center justify-center rounded p-0 transition-colors hover:opacity-80"
                    style={{ color: 'oklch(0.50 0.02 55 / 0.6)' }}
                    title="复制"
                  >
                    {copiedMsgId === msg.id ? (
                      <ClipboardCheck className="h-2.5 w-2.5" style={{ color: 'oklch(0.55 0.12 45)' }} />
                    ) : (
                      <Copy className="h-2.5 w-2.5" />
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteRound(messages.indexOf(msg));
                    }}
                    className="flex items-center justify-center rounded p-0.5 transition-colors hover:opacity-80"
                    style={{ color: 'oklch(0.50 0.15 25 / 0.6)' }}
                    title="删除本轮对话"
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
          );
        })}
      </div>

      {/* Input area - visible when selected, or on new/empty nodes, or when reference tag is set */}
      {(selected || messages.length === 0 || referenceTag) && (
      <div
        className={cn('nodrag relative border-t p-2 transition-all', dragOver && 'ring-2')}
        style={{
          borderColor: dragOver ? 'oklch(0.62 0.17 45 / 0.5)' : 'oklch(0.80 0.03 60 / 0.3)',
          backgroundColor: dragOver ? 'oklch(0.62 0.17 45 / 0.06)' : 'transparent',
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* 待发送附件预览 — 小图标模式 */}
        {pendingAttachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-0.5">
            {pendingAttachments.map((att) => (
              <span
                key={att.id}
                className="group inline-flex items-center gap-0.5 rounded-full px-1 py-px"
                style={{
                  backgroundColor: 'oklch(0.62 0.17 45 / 0.08)',
                  border: '1px solid oklch(0.62 0.17 45 / 0.2)',
                }}
                title={`${att.name} (${formatFileSize(att.size)})`}
              >
                {att.type === 'image' && att.dataUrl ? (
                  <img src={att.dataUrl} alt={att.name} className="h-3 w-3 rounded-sm object-cover" />
                ) : att.type === 'text' ? (
                  <FileText className="h-2.5 w-2.5" style={{ color: '#537D96' }} />
                ) : (
                  <Paperclip className="h-2.5 w-2.5" style={{ color: '#7a7260' }} />
                )}
                <span className="max-w-[48px] truncate text-[9px]" style={{ color: 'oklch(0.40 0.02 50)' }}>
                  {att.name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removePendingAttachment(att.id);
                  }}
                  className="ml-0 rounded-full p-px opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: 'oklch(0.50 0.02 55 / 0.6)' }}
                >
                  <X className="h-2 w-2" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 已选技能标签 */}
        {selectedSkills.size > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {Array.from(selectedSkills).map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                style={{
                  backgroundColor: 'oklch(0.62 0.17 45 / 0.12)',
                  color: 'oklch(0.50 0.12 45)',
                  border: '1px solid oklch(0.62 0.17 45 / 0.25)',
                }}
              >
                {name}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedSkills((prev) => {
                      const next = new Set(prev);
                      next.delete(name);
                      return next;
                    });
                  }}
                  className="rounded-full p-px transition-colors hover:bg-[oklch(0.62_0.17_45_/_0.2)]"
                >
                  <X className="h-2 w-2" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 引用材料标签 — 在输入框上方 */}
        {pendingMaterials.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-0.5">
            {pendingMaterials.map((mat) => (
              <span
                key={mat.path}
                className="group inline-flex items-center gap-0.5 rounded-full px-1.5 py-px"
                style={{
                  backgroundColor: 'oklch(0.60 0.12 200 / 0.08)',
                  border: '1px solid oklch(0.60 0.12 200 / 0.2)',
                }}
              >
                <AtSign className="h-2.5 w-2.5" style={{ color: 'oklch(0.50 0.12 200)' }} />
                <span className="max-w-[80px] truncate text-[9px]" style={{ color: 'oklch(0.35 0.02 50)' }}>
                  {mat.name}
                </span>
                <button
                  onClick={() => {
                    setPendingMaterials(prev => prev.filter(m => m.path !== mat.path));
                    setPendingMaterialPaths(prev => { const s = new Set(prev); s.delete(mat.path); return s; });
                  }}
                  className="ml-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: 'oklch(0.50 0.02 50 / 0.5)' }}
                >
                  <X className="h-2 w-2" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* @ mention 弹窗 */}
        {mentionOpen && (
          <div
            ref={mentionRef}
            className="absolute z-50 mb-1 max-h-40 w-56 overflow-y-auto rounded-lg border py-1 shadow-lg"
            style={{
              bottom: '100%',
              left: 0,
              backgroundColor: 'oklch(1 0 0 / 0.97)',
              borderColor: 'oklch(0.82 0.03 60 / 0.4)',
            }}
            onWheel={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {(() => {
              const filtered = materialFiles.filter((f) =>
                f.name.toLowerCase().includes(mentionQuery.toLowerCase()),
              );
              if (filtered.length === 0) {
                return (
                  <div className="px-3 py-2 text-[11px]" style={{ color: 'oklch(0.55 0.02 50 / 0.5)' }}>
                    {materialFiles.length === 0 ? 'materials 文件夹为空，请先上传资料' : '无匹配文件'}
                  </div>
                );
              }
              return filtered.slice(0, 10).map((file, idx) => (
                <button
                  key={file.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMentionSelect(file);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
                  style={{
                    backgroundColor: idx === mentionIndex ? 'oklch(0.95 0.01 80)' : 'transparent',
                  }}
                  onMouseEnter={(el) => {
                    el.currentTarget.style.backgroundColor = 'oklch(0.95 0.01 80)';
                  }}
                  onMouseLeave={(el) => {
                    if (idx !== mentionIndex) {
                      el.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  <AtSign className="h-3 w-3 shrink-0" style={{ color: 'oklch(0.55 0.15 45)' }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium" style={{ color: 'oklch(0.30 0.015 50)' }}>
                      {file.name}
                    </div>
                    <div className="text-[10px]" style={{ color: 'oklch(0.55 0.02 50 / 0.5)' }}>
                      {file.type} · {formatFileSize(file.size)}
                    </div>
                  </div>
                </button>
              ));
            })()}
          </div>
        )}

        {/* 引用标签 — 在输入框上方 */}
        {referenceTag && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-full px-2.5 py-1 w-fit" style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.08)', border: '1px solid oklch(0.62 0.17 45 / 0.2)' }}>
            <img src="/pumpkin-icon.png" alt="" className="h-3.5 w-3.5 object-contain" />
            <span className="max-w-[200px] truncate text-[11px]" style={{ color: 'oklch(0.45 0.12 40)' }}>
              {referenceTag.text}
            </span>
            <button
              onClick={() => setReferenceTag(null)}
              className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px]"
              style={{ color: 'oklch(0.50 0.02 50)' }}
            >
              ×
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* textarea 独占上部 */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);

              // 检测 @ 触发 mention
              const cursorPos = e.target.selectionStart || 0;
              const textBeforeCursor = val.slice(0, cursorPos);
              const atMatch = textBeforeCursor.match(/(?:^|\s)@([^\s]*)$/);
              if (atMatch) {
                const query = atMatch[1];
                setMentionAtPos(cursorPos - query.length - 1);
                setMentionQuery(query);
                setMentionOpen(true);
                setMentionIndex(0);
                loadMaterialFiles();
              } else {
                if (mentionOpen) {
                  closeMention();
                }
              }
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type a message..."
            rows={2}
            disabled={isStreaming}
            className={cn(
              'flex-1 resize-none rounded-lg border px-3 py-2 text-[13px] transition-colors',
              'focus:outline-none disabled:opacity-50',
            )}
            style={{
              maxHeight: '120px',
              backgroundColor: 'oklch(0.95 0.015 75)',
              borderColor: 'oklch(0.80 0.03 60 / 0.4)',
              color: 'oklch(0.25 0.02 50)',
            }}
            onPointerDown={(e) => {
              // 阻止 pointer 事件冒泡，避免三指手势拖动节点
              e.stopPropagation();
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'oklch(0.62 0.17 45 / 0.4)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'oklch(0.80 0.03 60 / 0.4)';
            }}
          />
        </div>

        {/* 底部工具栏：左侧附件+技能，右侧发送+推理+模型 */}
        <div className="mt-1.5 flex items-center justify-between">
          {/* 左侧：附件 + 技能 */}
          <div className="flex items-center gap-1.5">
            <label
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors disabled:opacity-50"
              style={{
                backgroundColor: 'oklch(0.94 0.01 70)',
                color: 'oklch(0.50 0.02 55 / 0.7)',
              }}
              title="Attach"
              onMouseEnter={(e) => {
                if (!isStreaming && !uploadingAttachment) {
                  e.currentTarget.style.backgroundColor = 'oklch(0.90 0.02 65)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'oklch(0.94 0.01 70)';
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

            {/* 技能选择按钮 */}
            {availableSkills.length > 0 && (
              <div className="relative" ref={skillMenuRef}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isStreaming) setSkillMenuOpen((v) => !v);
                  }}
                  disabled={isStreaming}
                  className={cn(
                    'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors disabled:opacity-50',
                    selectedSkills.size > 0 && 'ring-1',
                  )}
                  style={{
                    backgroundColor: selectedSkills.size > 0 ? 'oklch(0.62 0.17 45 / 0.12)' : 'oklch(0.94 0.01 70)',
                    color: selectedSkills.size > 0 ? 'oklch(0.50 0.12 45)' : 'oklch(0.50 0.02 55 / 0.7)',
                    borderColor: selectedSkills.size > 0 ? 'oklch(0.62 0.17 45 / 0.3)' : 'transparent',
                  }}
                  title={selectedSkills.size > 0 ? `已选 ${selectedSkills.size} 个技能` : '选择技能'}
                >
                  <Lightbulb className="h-3.5 w-3.5" />
                  {selectedSkills.size > 0 && (
                    <span className="text-[10px] font-medium">{selectedSkills.size}</span>
                  )}
                </button>
                {skillMenuOpen && (
                  <div
                    className="absolute bottom-full left-0 mb-1 w-52 rounded-lg border py-1 shadow-lg z-50"
                    style={{
                      backgroundColor: 'oklch(1 0 0 / 0.95)',
                      borderColor: 'oklch(0.82 0.03 60 / 0.4)',
                    }}
                  >
                    {availableSkills.map((s) => {
                      const checked = selectedSkills.has(s.name);
                      return (
                        <button
                          key={s.name}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSkills((prev) => {
                              const next = new Set(prev);
                              if (checked) next.delete(s.name);
                              else next.add(s.name);
                              return next;
                            });
                          }}
                          className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                        >
                          <span
                            className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[8px]"
                            style={{
                              backgroundColor: checked ? 'oklch(0.62 0.17 45)' : 'transparent',
                              borderColor: checked ? 'oklch(0.62 0.17 45)' : 'oklch(0.75 0.02 60)',
                              color: '#fff',
                            }}
                          >
                            {checked && <Check className="h-2.5 w-2.5" />}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1">
                              <span className="text-[11px] font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>
                                {s.name}
                              </span>
                              {s.source === 'builtin' && (
                                <span className="shrink-0 rounded px-1 text-[8px] leading-tight"
                                  style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.12)', color: 'oklch(0.50 0.12 45)' }}>内置</span>
                              )}
                              {s.source === 'user' && (
                                <span className="shrink-0 rounded px-1 text-[8px] leading-tight"
                                  style={{ backgroundColor: 'oklch(0.55 0.15 145 / 0.12)', color: 'oklch(0.45 0.12 145)' }}>用户</span>
                              )}
                            </div>
                            <div className="text-[10px] leading-tight truncate" style={{ color: 'oklch(0.55 0.02 50)' }}>
                              {s.description.slice(0, 40)}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 右侧：推理强度 + 模型 + 发送 */}
          <div className="flex items-center gap-1.5">
            {/* 推理强度选择器 */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isStreaming) setThinkingMenuOpen((v) => !v);
                }}
                disabled={isStreaming}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all disabled:opacity-50"
                title={THINKING_LEVELS.find((l) => l.value === thinkingLevel)?.label ?? thinkingLevel}
                style={{
                  backgroundColor: thinkingLevel === 'off'
                    ? 'oklch(0.94 0.01 70)'
                    : 'oklch(0.62 0.17 45 / 0.12)',
                  color: thinkingLevel === 'off'
                    ? 'oklch(0.50 0.02 55 / 0.7)'
                    : 'oklch(0.50 0.12 45)',
                }}
              >
                <Brain className="h-3.5 w-3.5 shrink-0" />
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
                  className="absolute bottom-full right-0 z-30 mb-1 w-28 rounded-lg border p-0.5 shadow-lg"
                  style={{
                    backgroundColor: 'oklch(0.97 0.015 80)',
                    borderColor: 'oklch(0.78 0.03 60 / 0.4)',
                  }}
                >
                  {THINKING_LEVELS.map((lvl) => {
                const modelSupportsThinking = availableModels.find((m) => m.modelId === modelId)?.thinking ?? false;
                const isDisabled = lvl.value !== 'off' && !modelSupportsThinking;
                return (
                <button
                  key={lvl.value}
                  title={isDisabled ? 'Current model doesn\'t support thinking mode' : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isStreaming && !isDisabled) {
                      handleThinkingLevelChange(lvl.value);
                      setThinkingMenuOpen(false);
                    }
                  }}
                  disabled={isStreaming || isDisabled}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-[10px] font-medium transition-colors"
                  style={{
                    color: isDisabled
                      ? 'oklch(0.75 0.01 50)'
                      : thinkingLevel === lvl.value
                        ? 'oklch(0.62 0.17 45)'
                        : 'oklch(0.30 0.015 50)',
                    backgroundColor: thinkingLevel === lvl.value
                      ? 'oklch(0.92 0.035 50)'
                      : 'transparent',
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!isDisabled && thinkingLevel !== lvl.value) {
                      e.currentTarget.style.backgroundColor = 'oklch(0.95 0.015 75)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isDisabled && thinkingLevel !== lvl.value) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  <span>{lvl.label}</span>
                  {thinkingLevel === lvl.value && <Check className="h-2.5 w-2.5" />}
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
                className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: 'oklch(0.94 0.01 70)',
                  color: 'oklch(0.50 0.02 55 / 0.7)',
                }}
                title={modelId && modelId !== DEFAULT_MODEL_ID
                  ? availableModels.find((m) => m.modelId === modelId)?.label ?? modelId
                  : 'Auto Mode'}
              >
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: (availableModels.find((m) => m.modelId === modelId)?.thinking ?? false)
                      ? 'oklch(0.55 0.15 45)'
                      : 'oklch(0.65 0.02 55)',
                  }}
                />
                <span className="max-w-[60px] truncate">
                  {modelId && modelId !== DEFAULT_MODEL_ID
                    ? availableModels.find((m) => m.modelId === modelId)?.label?.split(' ')[0] ?? modelId.slice(0, 8)
                    : 'Auto'}
                </span>
                <ChevronDown className="h-2.5 w-2.5 opacity-50" />
              </button>

              {modelMenuOpen && (
                <div
                  className="absolute bottom-full right-0 z-30 mb-1 max-h-64 w-52 overflow-y-auto rounded-lg border shadow-lg"
                  style={{
                    borderColor: 'oklch(0.80 0.03 60 / 0.4)',
                    backgroundColor: 'oklch(0.98 0.012 80)',
                  }}
                >
                  {(() => {
                    const groups: Record<string, typeof availableModels> = {};
                    for (const m of availableModels) {
                      if (!groups[m.group]) groups[m.group] = [];
                      groups[m.group].push(m);
                    }
                  return Object.entries(groups).map(([groupName, models]) => (
                    <div key={groupName}>
                      <div
                        className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide"
                        style={{
                          color: 'oklch(0.55 0.02 50 / 0.5)',
                          backgroundColor: 'oklch(0.96 0.008 80)',
                        }}
                      >
                        {groupName}
                      </div>
                      {models.map((m) => (
                        <button
                          key={m.modelId}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectModel(m.modelId);
                          }}
                          className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors"
                          style={{
                            backgroundColor: m.modelId === modelId ? 'oklch(0.95 0.02 70)' : 'transparent',
                          }}
                          onMouseEnter={(e) => {
                            if (m.modelId !== modelId) {
                              e.currentTarget.style.backgroundColor = 'oklch(0.96 0.01 75)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (m.modelId !== modelId) {
                              e.currentTarget.style.backgroundColor = 'transparent';
                            }
                          }}
                        >
                          <div className="flex flex-1 flex-col">
                            <span
                              className="text-[12px] font-medium"
                              style={{ color: 'oklch(0.30 0.015 50)' }}
                            >
                              {m.label}
                            </span>
                            <span
                              className="text-[10px]"
                              style={{ color: 'oklch(0.55 0.02 50 / 0.6)' }}
                            >
                              {m.description}
                            </span>
                          </div>
                          {m.modelId === modelId && (
                            <Check
                              className="mt-0.5 h-3.5 w-3.5 shrink-0"
                              style={{ color: 'oklch(0.62 0.17 45)' }}
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  ));
                })()}
              </div>
          )}
        </div>

            {/* 发送按钮 — 最右侧 */}
            {isStreaming ? (
              <button
                onClick={handleStop}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                style={{
                  backgroundColor: 'oklch(0.58 0.22 27 / 0.12)',
                  color: 'oklch(0.50 0.22 27)',
                }}
              >
                <span className="h-3 w-3 rounded-sm bg-current" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() || availableModels.length === 0}
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
                )}
                style={{
                  backgroundColor: input.trim() && availableModels.length > 0
                    ? 'oklch(0.62 0.17 45)'
                    : 'oklch(0.88 0.02 60)',
                  color: input.trim() && availableModels.length > 0
                    ? 'oklch(0.98 0.01 80)'
                    : 'oklch(0.60 0.02 55 / 0.5)',
                }}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
      )}

      {/* 提问弹窗 */}
      {questionPopup && (
        <QuestionPopup
          questions={questionPopup.questions}
          onSubmit={handleQuestionSubmit}
          onClose={() => setQuestionPopup(null)}
        />
      )}

      </div>
    </div>
  );
}
