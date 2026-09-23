'use client';

/**
 * BrowserChatPanel —— Hippo Browser 右侧对话栏（P2 ChatSidebar）
 *
 * 形态：浏览器窗口内右侧面板（main 进程用独立 WebContentsView 加载 /browser-chat），与网页并排。
 * 对话 UI 直挂 ChatNodeKernel（方案 D4 原文），不做第二套对话前端 —— 会话在画布节点存储里，
 * 与画布会话同构（同一套消息模型 / SSE 链路 / 落盘协议），互不干扰。
 *
 * 三件事在本文件内收口：
 *  1. 会话 nodeId：按窗口维度记忆在 localStorage；失效（文件被删/项目切换）时补建
 *     `node_type='browser'` 的会话节点（画布侧按 node_type 过滤，不显示该节点）。
 *  2. 宿主注入：kernel 只需 NodeHostValue 的 readNodes/readEdges/updateNodes/subscribe
 *     四项（单节点内存态），此处合成一个最小 NodeHostContext。
 *  3. ContextEnvelope：网页上下文作为**本轮 user 消息前缀**注入（绝不进 system，守前缀缓存红线），
 *     复用既有的两条零改造通道：node-ask-question 事件 → kernel 的引用标签。
 *
 * 工具面：默认 identity='browser'（fixed scenes: browser + ledger，剔除文件/命令类内核）；
 * 用户显式解锁后切 identity='chat'，与画布会话能力一致。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Compass, FileText, Globe, History, Loader2, Lock, Plus, Send, Trash2, Unlock } from 'lucide-react';

import { ChatNodeKernel, type ChatNodeIdentity } from '@/components/canvas/ChatNodeKernel';
import { NodeHostContext, type HostEdge, type HostNode, type NodeHostValue } from '@/components/canvas/node-host';
import { AGENT_IDS } from '@/lib/agents/profiles';
import type { AiChatNodeData, ChatMessage } from '@/lib/types';

/** 会话节点标题（首次创建时写入 frontmatter；用户可在节点头部改名，改名不回写本常量） */
const SESSION_TITLE = 'Browser Chat';
/** 单次注入的网页正文上限（字符）：整页 markdown 常常数万字，按需截断保护上下文预算 */
const PAGE_CONTENT_LIMIT = 8000;
/** 空边表常量：useSyncExternalStore 要求快照引用稳定，不能在 readEdges 里每次新建数组 */
const EMPTY_EDGES: HostEdge[] = [];
/** 首轮占位 answer：画布侧用它标记「只登记未作答」的轮次，回放时需过滤 */
const INIT_PLACEHOLDER = '__BAI_INITIAL_PROMPT_PLACEHOLDER__';
/** 本窗口会话列表上限（超出时淘汰最旧的分支，仅摘出列表，不删落盘节点） */
const SESSIONS_MAX = 20;
/** 会话标题取首个提问摘要的长度上限 */
const SESSION_TITLE_MAX = 24;

/** 会话索引项：id 即落盘节点 id；title 由首个提问派生（取不到则回落 SESSION_TITLE） */
interface ChatSessionEntry {
  id: string;
  title: string;
  updatedAt: string;
}

/** 对话栏档位（工具栏「模式」下拉）：Ask = 只问答不动浏览器 / Browse = 缺省，可读写页面 / Research = Browse + 多源取证纪律。
 *  档位不新造工具面，只切换 Agent 身份 —— 工具与规则都跟着画像走（见 lib/agents/profiles.ts）。 */
type BrowserMode = 'ask' | 'browse' | 'research';

/** 档位 → Agent 身份：Ask 无 browser 场景（无 browser_* 工具、不注入操作纪律），Research 与 Browse 同工具面、多一层调研纪律 */
const MODE_IDENTITY: Record<BrowserMode, ChatNodeIdentity> = {
  ask: AGENT_IDS.browserAsk as ChatNodeIdentity,
  browse: AGENT_IDS.browser as ChatNodeIdentity,
  research: AGENT_IDS.browserResearch as ChatNodeIdentity,
};

/** 档位选项（下拉顺序即此顺序；hint 为菜单里的一行说明，UI 文案一律英文） */
const MODE_OPTIONS: Array<{ value: BrowserMode; label: string; hint: string }> = [
  { value: 'ask', label: 'Ask', hint: 'Answer only — no browser control' },
  { value: 'browse', label: 'Browse', hint: 'Read and operate the page' },
  { value: 'research', label: 'Research', hint: 'Multi-source facts with citations' },
];

/** 读档位（缺省 / 脏值一律回落 browse） */
function readMode(win: string): BrowserMode {
  const raw = localStorage.getItem(storageKey(win, 'mode'));
  return raw === 'ask' || raw === 'research' ? raw : 'browse';
}

/** 会话 / 偏好在本机的键：localStorage 与主窗口同源，务必带 bob-hippo-chat 前缀避免碰撞 */
function storageKey(win: string, kind: 'sessions' | 'active' | 'unlocked' | 'mode'): string {
  return `bob-hippo-chat:${kind}:${win}`;
}

/** 旧版单会话键（一次性迁移用）：形如 bob-hippo-chat:node:<win>，键名是历史字面量，不能由 storageKey 合成 */
function legacyNodeKey(win: string): string {
  return `bob-hippo-chat:node:${win}`;
}

/** 读会话索引（损坏 / 隐私模式下返回空表，不抛错） */
function readSessionList(win: string): ChatSessionEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(win, 'sessions'));
    const arr: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is ChatSessionEntry => !!x && typeof (x as ChatSessionEntry).id === 'string');
  } catch {
    return [];
  }
}

function writeSessionList(win: string, list: ChatSessionEntry[]): void {
  try {
    localStorage.setItem(storageKey(win, 'sessions'), JSON.stringify(list.slice(0, SESSIONS_MAX)));
  } catch {
    // 配额满 / 隐私模式：会话列表降级为本次进程内存，不影响对话本身
  }
}

/** 会话标题 = 首个有答复的提问摘要（与落盘节点标题解耦，只服务侧边栏列表） */
function deriveTitle(conversations: StoredConversation[]): string {
  const first = conversations.find((c) => c?.question?.trim() && c.answer !== INIT_PLACEHOLDER);
  const q = first?.question.trim().replace(/\s+/g, ' ') ?? '';
  if (!q) return '';
  return q.length > SESSION_TITLE_MAX ? `${q.slice(0, SESSION_TITLE_MAX)}…` : q;
}

/** 建一个 browser 会话节点（node_type='browser'：画布侧按类型过滤，不渲染） */
async function createSessionNode(nodeId: string): Promise<void> {
  const res = await fetch('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', node_id: nodeId, title: SESSION_TITLE, node_type: 'browser' }),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || 'Failed to create browser chat session');
}

/** 删除会话节点：落盘侧是软删（档案进 .trash/nodes，可从回收站恢复）。
 *  节点文件本就不存在（404）按删除成功处理，避免索引与档案反复不一致。 */
async function deleteSessionNode(nodeId: string): Promise<boolean> {
  try {
    const res = await fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', node_id: nodeId }),
    });
    if (res.status === 404) return true;
    const data = await res.json().catch(() => null);
    return res.ok && !!data?.success;
  } catch {
    return false;
  }
}

/** 读会话节点（不存在 / 请求失败返回 null，由调用方决定补建或忽略） */
async function fetchSessionNode(
  nodeId: string,
): Promise<{ title?: string; createdAt?: string; conversations?: StoredConversation[] } | null> {
  try {
    const r = await fetch(`/api/nodes?id=${encodeURIComponent(nodeId)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j?.success && j.node ? (j.node as { title?: string; createdAt?: string; conversations?: StoredConversation[] }) : null;
  } catch {
    return null;
  }
}

/** /api/nodes 落盘的对话轮次（与 CanvasFlow restoredNodeToFlowNode 对齐的最小字段集） */
interface StoredConversation {
  question: string;
  answer: string;
  questionTime: string;
  answerTime: string;
  modelId?: string;
  thinkingLevel?: string;
  reasoning?: string;
  processNarration?: string;
  toolCalls?: ChatMessage['toolCalls'];
  outputFiles?: ChatMessage['outputFiles'];
  subagents?: ChatMessage['subagents'];
  questionAttachments?: ChatMessage['attachments'];
  questionReferences?: ChatMessage['references'];
}

/** 轮次 → ChatMessage[]：与 CanvasFlow.restoredNodeToFlowNode 同一套映射（含占位 answer 过滤） */
function conversationsToMessages(nodeId: string, conversations: StoredConversation[]): ChatMessage[] {
  const visible = conversations.filter((c) => c.answer !== INIT_PLACEHOLDER);
  const messages: ChatMessage[] = [];
  visible.forEach((conv, i) => {
    messages.push({
      id: `msg-${nodeId}-q${i}`,
      role: 'user',
      content: conv.question,
      attachments: conv.questionAttachments,
      references: conv.questionReferences,
      timestamp: conv.questionTime,
    });
    messages.push({
      id: `msg-${nodeId}-a${i}`,
      role: 'assistant',
      content: conv.answer,
      timestamp: conv.answerTime,
      modelId: conv.modelId,
      thinkingLevel: conv.thinkingLevel as ChatMessage['thinkingLevel'],
      reasoning: conv.reasoning,
      processNarration: conv.processNarration,
      toolCalls: conv.toolCalls,
      outputFiles: conv.outputFiles,
      subagents: conv.subagents,
    });
  });
  return messages;
}

/** 环境上下文（每轮自动跟随）：只告诉模型「用户此刻在看哪一页」，不含正文 —
 *  正文是重内容，由浮层 Page text 手动挂，避免每轮都把整页塞进上下文。 */
function buildAmbientContext(url: string, title: string): string {
  const lines: string[] = [];
  if (url) lines.push(`URL: ${url}`);
  if (title) lines.push(`Title: ${title}`);
  if (lines.length === 0) return '';
  return ['[Current web page]', ...lines].join('\n');
}

/** 网页上下文（ContextEnvelope）→ 注入文本：只放真实拿到的事实，拿不到的行直接省略。
 *  note = 主进程给出的正文可读性提示（PDF / 登录墙 / 空壳未渲染），紧跟在标题后，
 *  让模型先知道「这次抽取不可信」，再去读可能只是导航噪声的正文。 */
function buildContextText(
  state: { url: string; title: string },
  tabs: Array<{ title: string; url: string }>,
  extractedMarkdown?: string,
  selection?: string,
  note?: string,
): string {
  const lines: string[] = ['[Web page context]'];
  if (state.url) lines.push(`URL: ${state.url}`);
  if (state.title) lines.push(`Title: ${state.title}`);
  if (note) lines.push(`Note: ${note}`);
  if (selection) lines.push('', 'Selected text:', selection);
  const others = tabs.filter((t) => t.url).filter((t) => t.url !== state.url);
  if (others.length > 0) {
    lines.push(`Other open tabs: ${others.map((t) => `${t.title || t.url} (${t.url})`).join(' | ')}`);
  }
  if (extractedMarkdown) {
    const clipped =
      extractedMarkdown.length > PAGE_CONTENT_LIMIT
        ? `${extractedMarkdown.slice(0, PAGE_CONTENT_LIMIT)}\n…(truncated)`
        : extractedMarkdown;
    lines.push('', 'Page content (markdown):', clipped);
  }
  return lines.join('\n');
}

/** 取 PDF 正文（/api/pdf-text）：面板在渲染进程里调不到模型侧的 browser_read_pdf，
 *  由宿主路由复用同一套提取管线。拿不到返回 null，由调用方回退成「成因提示」。 */
async function fetchPdfText(url: string): Promise<{ text: string; note?: string } | null> {
  try {
    const res = await fetch('/api/pdf-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const j = (await res.json()) as { ok?: boolean; text?: string; chars?: number; pages?: number; truncated?: boolean };
    const text = String(j?.text ?? '');
    if (!res.ok || !j?.ok || !text.trim()) return null;
    // 注入时还会按 PAGE_CONTENT_LIMIT 再截一刀，所以「要不要提示续读」按两者中更小的口径判
    const clipped = !!j.truncated || text.length > PAGE_CONTENT_LIMIT;
    return {
      text,
      note: clipped
        ? `PDF text (${j.pages || '?'} pages, ${j.chars ?? text.length} chars) — only the beginning is attached. Read further with the browser_read_pdf tool (Browse / Research mode).`
        : undefined,
    };
  } catch {
    return null;
  }
}

interface BrowserChatPanelProps {
  /** 所属 Hippo Browser 窗口标识（会话与偏好的隔离维度） */
  winId: string;
}

export function BrowserChatPanel({ winId }: BrowserChatPanelProps) {
  const [session, setSession] = useState<{ nodeId: string; data: AiChatNodeData } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bootKey, setBootKey] = useState(0);
  const [unlocked, setUnlocked] = useState(false);
  /** 当前档位（Ask / Browse / Research）：按窗口持久化，缺省 browse */
  const [mode, setMode] = useState<BrowserMode>('browse');
  const [page, setPage] = useState<{ url: string; title: string; loading: boolean }>({ url: '', title: '', loading: false });
  const [tabs, setTabs] = useState<Array<{ id: number; title: string; url: string }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /** 整页正文抽取中的在途标记（仅 Ask 档按钮会用到） */
  const [attaching, setAttaching] = useState(false);
  /** 本窗口的会话索引（侧边栏可多开分支；每项对应一个 node_type='browser' 节点） */
  const [sessions, setSessions] = useState<ChatSessionEntry[]>([]);
  /** 当前激活会话的节点 id；null = 尚未完成引导 */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);

  // 浏览器桥（仅 Electron 环境存在；本面板只在 Hippo 窗口的 chatView 内挂载）
  const bridge = typeof window !== 'undefined' ? window.api?.hippoBrowser : undefined;

  useEffect(() => {
    setUnlocked(localStorage.getItem(storageKey(winId, 'unlocked')) === '1');
    setMode(readMode(winId));
  }, [winId]);

  // ---------- 网页上下文订阅（url/标题/标签列表由主进程广播） ----------
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.getState().then((s) => {
      if (alive && s) setPage({ url: s.url, title: s.title, loading: s.loading });
    });
    const offState = bridge.onState((s) => {
      if (alive) setPage({ url: s.url, title: s.title, loading: s.loading });
    });
    const offTabs = bridge.onTabs((d) => {
      if (!alive) return;
      setTabs(d.tabs);
    });
    return () => {
      alive = false;
      offState();
      offTabs();
    };
  }, [bridge]);

  // ---------- 会话引导 A：确保索引就绪并定出激活项 ----------
  // 首次进入：迁移旧单会话键（bob-hippo-chat:node:*），否则新建一条；已有索引则沿用记忆的激活项。
  useEffect(() => {
    let alive = true;
    setActiveId(null);
    setError(null);
    void (async () => {
      try {
        let list = readSessionList(winId);
        if (list.length === 0) {
          const legacy = localStorage.getItem(legacyNodeKey(winId));
          if (legacy) {
            list = [{ id: legacy, title: SESSION_TITLE, updatedAt: new Date().toISOString() }];
          } else {
            const id = crypto.randomUUID();
            await createSessionNode(id);
            list = [{ id, title: SESSION_TITLE, updatedAt: new Date().toISOString() }];
          }
        }
        if (!alive) return;
        setSessions(list);
        writeSessionList(winId, list);
        const remembered = localStorage.getItem(storageKey(winId, 'active'));
        const active = list.some((s) => s.id === remembered) ? String(remembered) : list[0].id;
        localStorage.setItem(storageKey(winId, 'active'), active);
        if (alive) setActiveId(active);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [winId, bootKey]);

  // ---------- 会话引导 B：载入激活会话（缺失则按同一 id 补建，保持索引与落盘一致） ----------
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    setSession(null);
    void (async () => {
      try {
        const node = await fetchSessionNode(activeId);
        if (!alive) return;
        if (node) {
          const conversations = node.conversations ?? [];
          setSession({
            nodeId: activeId,
            data: {
              title: node.title || SESSION_TITLE,
              messages: conversationsToMessages(activeId, conversations),
              isStreaming: false,
              nodeMdId: activeId,
              createdAt: node.createdAt,
            },
          });
          // 顺带把标题刷新为首问摘要（只在有答复的轮次上派生，避免把占位轮次当标题）
          const derived = deriveTitle(conversations);
          if (derived) {
            setSessions((prev) => {
              const next = prev.map((s) => (s.id === activeId && s.title !== derived ? { ...s, title: derived } : s));
              writeSessionList(winId, next);
              return next;
            });
          }
          return;
        }
        await createSessionNode(activeId);
        if (!alive) return;
        setSession({ nodeId: activeId, data: { title: SESSION_TITLE, messages: [], isStreaming: false, nodeMdId: activeId } });
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeId, bootKey, winId]);

  // ---------- 会话切换 / 新建 ----------
  /** 切到另一条会话：换索引 + 换激活 id */
  const selectSession = useCallback(
    (id: string) => {
      if (id === activeId) return;
      localStorage.setItem(storageKey(winId, 'active'), id);
      setActiveId(id);
    },
    [activeId, winId],
  );

  const startNewSession = useCallback(async () => {
    if (creatingSession) return;
    setCreatingSession(true);
    try {
      const id = crypto.randomUUID();
      await createSessionNode(id);
      const entry: ChatSessionEntry = { id, title: SESSION_TITLE, updatedAt: new Date().toISOString() };
      const list = [entry, ...readSessionList(winId)].slice(0, SESSIONS_MAX);
      writeSessionList(winId, list);
      setSessions(list);
      localStorage.setItem(storageKey(winId, 'active'), id);
      setActiveId(id);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingSession(false);
    }
  }, [creatingSession, winId]);

  /** 删除一条会话（用户手动清理）：先摘本地索引（立即生效），再删落盘节点（软删进回收站）。
   *  删的正好是当前会话 → 切到下一条；一条不剩 → 新建一条，避免停在空白引导态。 */
  const deleteSession = useCallback(
    async (id: string) => {
      const next = readSessionList(winId).filter((s) => s.id !== id);
      writeSessionList(winId, next);
      setSessions(next);
      if (id === activeId) {
        if (next.length > 0) {
          localStorage.setItem(storageKey(winId, 'active'), next[0].id);
          setActiveId(next[0].id);
        } else {
          setActiveId(null);
          await startNewSession();
        }
      }
      const ok = await deleteSessionNode(id);
      if (!ok) setNotice('Chat removed from the list, but its archived node could not be deleted');
    },
    [winId, activeId, startNewSession],
  );

  /** 打开会话菜单时刷新标题：未被访问过的分支也拿到「首问摘要」 */
  const refreshSessionTitles = useCallback(async () => {
    const list = readSessionList(winId);
    if (!list.length) return;
    const refreshed = await Promise.all(
      list.map(async (s) => {
        const node = await fetchSessionNode(s.id);
        const derived = node ? deriveTitle(node.conversations ?? []) : '';
        return derived && derived !== s.title ? { ...s, title: derived } : s;
      }),
    );
    setSessions(refreshed);
    writeSessionList(winId, refreshed);
  }, [winId]);

  // ---------- 上下文注入通道 ----------
  /** 把上下文文本投给 kernel 的引用标签（作为本轮 user 消息前缀，不进 system） */
  const attachContext = useCallback(
    (text: string) => {
      if (!session || !text.trim()) return;
      window.dispatchEvent(new CustomEvent('node-ask-question', { detail: { nodeId: session.nodeId, text } }));
    },
    [session],
  );

  /** 每轮自动跟随的环境上下文（当前页 URL / 标题）：仅随 url/title 变化重建，
   *  loading 抖动不触发；由 kernel 在发送时前置进模型侧内容，不占引用标签槽位 */
  const ambientContext = useMemo(() => buildAmbientContext(page.url, page.title), [page.url, page.title]);

  /** 带正文的注入：DOM → markdown 由主进程完成（含 SPA 等待）。
   *  入口两个：划词浮层的 Page text，以及 Ask 档工具栏按钮（Ask 档模型没有 browser_* 工具，这是它读到正文的唯一通道） */
  const attachPageContent = useCallback(async () => {
    if (!session) return;
    setAttaching(true);
    try {
      const r = await bridge?.extract();
      let md = r?.ok ? r.markdown ?? r.text ?? '' : '';
      let note = r?.ok ? r.note : undefined;
      // PDF 分流：DOM 里没有正文，改由宿主路由取真实文本；取不到才退回成因提示（note）
      if (r?.ok && r.kind === 'pdf' && r.url) {
        const pdf = await fetchPdfText(r.url);
        if (pdf) {
          md = pdf.text;
          note = pdf.note;
        }
      }
      // 有 note 就照常注入：让模型知道这次抽取不可信、该换工具，
      // 而不是把「没抽到正文」当成「页面没内容」死在按钮上
      if (!md.trim() && !note) {
        setNotice('Page content unavailable');
        return;
      }
      attachContext(
        buildContextText({ url: r?.url || page.url, title: r?.title || page.title }, tabs, md || undefined, undefined, note),
      );
    } finally {
      setAttaching(false);
    }
  }, [attachContext, bridge, page, tabs, session]);

  /** 划词浮层动作的处理体（Ask Bob = 挂选区，Page text = 挂整页正文）。
   *  每轮渲染后刷新到 ref，订阅只装一次 —— 否则 page/tabs/session 一变就要重订 IPC。 */
  const handleSelectionAction = (p: { action: 'ask' | 'page'; text: string }): void => {
    if (p.action === 'page') void attachPageContent();
    // 选区块只带选中的文字：本页 URL/标题已由 ambientContext 每轮自动前置，
    // 这里再挂一遍会在同一轮消息里重复；标签列表对「就这段文字提问」也属噪声。
    else attachContext(`[Selected text]\n\n${p.text}`);
  };
  const selectionActionRef = useRef(handleSelectionAction);
  useEffect(() => {
    selectionActionRef.current = handleSelectionAction;
  });
  // 主进程在投递前已把侧边栏展开，这里只负责落地成上下文
  useEffect(() => {
    if (!bridge?.onSelectionAction) return;
    return bridge.onSelectionAction((p) => selectionActionRef.current(p));
  }, [bridge]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(t);
  }, [notice]);

  // ---------- 档位（模式）切换 ----------
  /** 切档位：落盘 + 立即生效（下一轮请求按新身份取工具面与规则；本轮在途不受影响） */
  const selectMode = useCallback(
    (m: BrowserMode) => {
      localStorage.setItem(storageKey(winId, 'mode'), m);
      setMode(m);
    },
    [winId],
  );

  // ---------- 工具面解锁 ----------
  const toggleUnlock = useCallback(() => {
    setUnlocked((prev) => {
      const next = !prev;
      localStorage.setItem(storageKey(winId, 'unlocked'), next ? '1' : '0');
      return next;
    });
  }, [winId]);

  // ---------- 投送到画布 ----------
  const [sending, setSending] = useState(false);
  const sendToCanvas = useCallback(async () => {
    if (!session || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/nodes?id=${encodeURIComponent(session.nodeId)}`);
      const j = await r.json();
      const conversations = (j?.node?.conversations ?? []) as StoredConversation[];
      if (!conversations.length) {
        setNotice('Nothing to send yet');
        return;
      }
      const nodeId = crypto.randomUUID();
      const title = page.title ? `Browser · ${page.title}` : 'Browser Chat';
      const createRes = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', node_id: nodeId, title, node_type: 'chat' }),
      });
      const createData = await createRes.json();
      if (!createRes.ok || !createData?.success) throw new Error(createData?.error || 'Failed to create canvas node');
      for (const conv of conversations) {
        const appendRes = await fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'append',
            node_id: nodeId,
            question: conv.question,
            answer: conv.answer,
            questionTime: conv.questionTime,
            answerTime: conv.answerTime,
            model_id: conv.modelId,
            thinking_level: conv.thinkingLevel,
            reasoning: conv.reasoning,
            // 注意：本接口的字段名是 snake_case（process_narration），传 camelCase 会被服务端忽略
            process_narration: conv.processNarration,
            tool_calls: conv.toolCalls,
            output_files: conv.outputFiles,
            question_attachments: conv.questionAttachments,
            question_references: conv.questionReferences,
          }),
        });
        if (!appendRes.ok) throw new Error('Failed to copy conversation rounds');
      }
      // 通知主窗口把新节点挂进画布并置焦点（主进程转发 → 主窗口 preload → CanvasFlow）
      await bridge?.chatSendToCanvas?.({ nodeId, title, conversations });
      setNotice('Sent to canvas');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [bridge, page.title, sending, session]);

  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-white px-6 text-center">
        <Globe className="h-5 w-5" style={{ color: 'var(--ink-muted)' }} />
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>{error}</p>
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          style={{ borderColor: 'var(--line)' }}
          onClick={() => setBootKey((k) => k + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white">
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--ink-muted)' }} />
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col bg-white" style={{ fontFamily: 'var(--font-sans)' }}>
      <Toolbar
        pageTitle={page.title}
        pageUrl={page.url}
        pageLoading={page.loading}
        unlocked={unlocked}
        attaching={attaching}
        sending={sending}
        notice={notice}
        sessions={sessions}
        activeId={activeId}
        creatingSession={creatingSession}
        mode={mode}
        onSelectMode={selectMode}
        onAttachContent={() => void attachPageContent()}
        onToggleUnlock={toggleUnlock}
        onSendToCanvas={() => void sendToCanvas()}
        onSelectSession={selectSession}
        onNewSession={() => void startNewSession()}
        onDeleteSession={(id) => void deleteSession(id)}
        onRefreshSessions={() => void refreshSessionTitles()}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatSidebarKernel
          key={session.nodeId}
          nodeId={session.nodeId}
          data={session.data}
          identity={unlocked ? (AGENT_IDS.chat as ChatNodeIdentity) : MODE_IDENTITY[mode]}
          ambientContext={ambientContext}
        />
      </div>
    </div>
  );
}

/** 顶部 slim 工具条：当前页指示 + 档位 + 会话切换 + 工具面解锁 + 投送画布（全部英文文案）。
 *  当前页 URL/标题每轮自动跟随（见 ambientContext），此处只做展示；
 *  整页正文按钮只在 Ask 档出现 —— 该档没有 browser_* 工具，是模型读到正文的唯一通道；
 *  Browse/Research 下模型自己就能实时读页，再挂一份快照反而是重复与浪费。 */
function Toolbar(props: {
  pageTitle: string;
  pageUrl: string;
  pageLoading: boolean;
  unlocked: boolean;
  attaching: boolean;
  sending: boolean;
  notice: string | null;
  sessions: ChatSessionEntry[];
  activeId: string | null;
  creatingSession: boolean;
  mode: BrowserMode;
  onSelectMode: (m: BrowserMode) => void;
  onAttachContent: () => void;
  onToggleUnlock: () => void;
  onSendToCanvas: () => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onRefreshSessions: () => void;
}) {
  const { pageTitle, pageUrl, pageLoading, unlocked, attaching, sending, notice } = props;
  const host = (() => {
    try {
      return pageUrl ? new URL(pageUrl).host : '';
    } catch {
      return '';
    }
  })();
  const label = pageTitle || host || (pageLoading ? 'Loading…' : 'New Tab');
  return (
    <div
      className="relative flex h-10 shrink-0 items-center gap-1.5 border-b px-2"
      style={{ borderColor: 'var(--line)' }}
    >
      <div
        title={pageUrl || undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1"
      >
        {pageLoading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: 'var(--ink-muted)' }} />
        ) : (
          <Globe className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
        )}
        <span className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>{label}</span>
      </div>

      <ModeMenu mode={props.mode} disabled={props.unlocked} onSelect={props.onSelectMode} />

      <SessionMenu
        sessions={props.sessions}
        activeId={props.activeId}
        creating={props.creatingSession}
        onSelect={props.onSelectSession}
        onNew={props.onNewSession}
        onDelete={props.onDeleteSession}
        onRefresh={props.onRefreshSessions}
      />

      {props.mode === 'ask' && (
        <button
          type="button"
          title="Attach full page text — Ask mode cannot read the page on its own"
          onClick={props.onAttachContent}
          disabled={!pageUrl || attaching}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/[0.06] disabled:opacity-40"
        >
          {attaching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--ink-muted)' }} />
          ) : (
            <FileText className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
          )}
        </button>
      )}

      <button
        type="button"
        title={unlocked ? 'Lock down tools (file & command access is on)' : 'Unlock full tools (file & command access)'}
        onClick={props.onToggleUnlock}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/[0.06]"
      >
        {unlocked ? (
          <Unlock className="h-3.5 w-3.5" style={{ color: 'var(--danger)' }} />
        ) : (
          <Lock className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
        )}
      </button>

      <button
        type="button"
        title="Send to canvas (copy this conversation into a canvas node)"
        onClick={props.onSendToCanvas}
        disabled={sending}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/[0.06] disabled:opacity-40"
      >
        {sending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--ink-muted)' }} />
        ) : (
          <Send className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
        )}
      </button>

      {notice && (
        <span
          className="pointer-events-none absolute right-2 top-9 z-20 max-w-[80%] truncate rounded-md border px-2 py-1 text-[11px]"
          style={{ borderColor: 'var(--line)', backgroundColor: 'var(--popover)', color: 'var(--ink-muted)' }}
        >
          {notice}
        </span>
      )}
    </div>
  );
}

/** 模式菜单（Ask / Browse / Research）：当前档位直接显示在按钮上，避免「图标认得、档位不认得」 */
function ModeMenu(props: {
  mode: BrowserMode;
  /** 解锁全量工具后身份固定为 chat，档位不再决定工具面 → 置灰并说明 */
  disabled: boolean;
  onSelect: (m: BrowserMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = MODE_OPTIONS.find((o) => o.value === props.mode) ?? MODE_OPTIONS[1];

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        title={props.disabled ? 'Mode is ignored while full tools are unlocked' : `Mode — ${current.label}: ${current.hint}`}
        onClick={() => setOpen((v) => !v)}
        disabled={props.disabled}
        className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors hover:bg-black/[0.06] disabled:opacity-40"
        style={{ color: 'var(--ink-muted)' }}
      >
        <Compass className="h-3.5 w-3.5 shrink-0" />
        <span>{current.label}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-7 z-30 w-56 rounded-lg border py-1 shadow-lg"
          style={{ borderColor: 'var(--line)', backgroundColor: 'var(--popover)' }}
        >
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                setOpen(false);
                props.onSelect(o.value);
              }}
              className="flex w-full items-start gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-black/[0.05]"
            >
              <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {o.value === props.mode && <Check className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs" style={{ color: 'var(--ink)' }}>{o.label}</span>
                <span className="block text-[11px]" style={{ color: 'var(--ink-muted)' }}>{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 会话菜单：本窗口的对话分支列表 + New chat（每次展开时刷新标题） */
function SessionMenu(props: {
  sessions: ChatSessionEntry[];
  activeId: string | null;
  creating: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  /** 待确认删除的会话 id：点垃圾桶先变红「Delete」，再点一次才真删（避免误删，无弹窗打断） */
  const [armingId, setArmingId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      // 菜单收起（外部点击 / Esc）时清掉待确认态，下次展开回到干净列表
      setArmingId(null);
      return;
    }
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setArmingId(null);
    if (next) props.onRefresh();
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        title="Chat sessions"
        onClick={toggle}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/[0.06]"
      >
        <History className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-7 z-30 max-h-72 w-64 overflow-y-auto rounded-lg border py-1 shadow-lg"
          style={{ borderColor: 'var(--line)', backgroundColor: 'var(--popover)' }}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              props.onNew();
            }}
            disabled={props.creating}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-black/[0.05] disabled:opacity-50"
          >
            {props.creating ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: 'var(--ink-muted)' }} />
            ) : (
              <Plus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
            )}
            New chat
          </button>
          <div className="my-1 h-px" style={{ backgroundColor: 'var(--line)' }} />
          {props.sessions.map((s) => (
            <div
              key={s.id}
              className="group flex w-full items-center gap-1 px-1.5 transition-colors hover:bg-black/[0.05]"
            >
              {/* 选择会话：占满剩余宽度，标题过长截断 */}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onSelect(s.id);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink)' }}>
                  {s.title || SESSION_TITLE}
                </span>
                {s.id === props.activeId && (
                  <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                )}
              </button>
              {/* 删除会话：默认只在悬停时露出，两步内联确认（垃圾桶 → 红色 Delete） */}
              <button
                type="button"
                title={armingId === s.id ? 'Click again to delete this chat' : 'Delete chat'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (armingId === s.id) {
                    setArmingId(null);
                    props.onDelete(s.id);
                  } else {
                    setArmingId(s.id);
                  }
                }}
                className={`flex h-6 shrink-0 items-center justify-center rounded-md px-1.5 transition-colors hover:bg-black/[0.06] ${
                  armingId === s.id ? '' : 'opacity-0 group-hover:opacity-100'
                }`}
                style={{ color: armingId === s.id ? 'var(--danger)' : 'var(--ink-muted)' }}
              >
                {armingId === s.id ? (
                  <span className="text-[11px]">Delete</span>
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 单节点内存态宿主：ChatNodeKernel 只用 readNodes/readEdges/updateNodes/subscribe 四项 */
function ChatSidebarKernel(props: {
  nodeId: string;
  data: AiChatNodeData;
  identity: ChatNodeIdentity;
  /** 当前页 URL/标题（每轮自动前置给模型；由 panel 随页面切换更新） */
  ambientContext: string;
}) {
  const { nodeId, data, identity, ambientContext } = props;
  const [nodes, setNodes] = useState<HostNode[]>(() => [
    { id: nodeId, type: 'agent-browser', position: { x: 0, y: 0 }, data },
  ]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const listenersRef = useRef(new Set<() => void>());

  // 节点变化 → 通知 useSyncExternalStore 订阅者（kernel 的边表订阅）
  useEffect(() => {
    listenersRef.current.forEach((l) => l());
  }, [nodes]);

  // 让 kernel 按真实面板宽度计算外壳宽（画布侧由 CanvasFlow 广播同一事件）
  useEffect(() => {
    const push = () => window.dispatchEvent(new CustomEvent('canvas-visible-width', { detail: { width: window.innerWidth } }));
    push();
    window.addEventListener('resize', push);
    return () => window.removeEventListener('resize', push);
  }, []);

  const host = useMemo<NodeHostValue>(
    () => ({
      edges: EMPTY_EDGES,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
      readNode: (id) => nodesRef.current.find((n) => n.id === id),
      readNodes: () => nodesRef.current,
      readEdges: () => EMPTY_EDGES,
      updateNodes: (updater) => setNodes((prev) => updater(prev)),
      addNodes: (ns) => setNodes((prev) => [...prev, ...ns]),
      // 浏览器对话栏不参与画布连线/删除：以下原语保持空实现，避免误改画布图
      addEdges: () => {},
      removeNode: () => {},
      removeEdge: () => {},
      deleteNodeWithEdges: () => {},
    }),
    [],
  );

  return (
    <NodeHostContext.Provider value={host}>
      <ChatNodeKernel id={nodeId} data={data} identity={identity} ambientContext={ambientContext} />
    </NodeHostContext.Provider>
  );
}