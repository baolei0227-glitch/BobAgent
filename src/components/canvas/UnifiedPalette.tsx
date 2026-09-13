'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Search,
  X,
  Loader2,
  File as FileIcon,
  Folder,
  Briefcase,
  Zap,
  Mic,
} from 'lucide-react';

import { bus, BusEvents, type ChatMessage, type WantedNoticeItem, type WantedNoticePayload } from '@/lib/bus';
import { desktop } from '@/lib/desktop-adapter';
import { isBrowserDoc, isPreviewable } from './viewers/registry';
import { FileName } from './FileName';
import {
  type WantedCommand,
  hasCommandIntent,
  detectCommand,
  filterCommands,
  getLineAtCursor,
  buildCommandTextAtLine,
  loadCommandUsage,
  recordCommandUsage,
} from '@/lib/wanted/commands';
import type { SummarizedTask } from '@/lib/wanted/executor';
import type { WikiEntryWithContent } from '@/lib/mcp/notes-types';
import type { ScheduleEvent } from '@/lib/wanted/schedule';

/**
 * ⌘F 统一面板（Raycast 式）
 *
 * 双形态：
 *  - 查找态（默认）：普通文本 → 搜索 BobWork 项目（按名称）+ BobWorkspace 各项目的 homework/materials/attachments 子目录
 *  - 指令态：输入以 "/" 开头 → WANTED 指令输入（/todo /note /chat /meeting /inspect /help），
 *    Enter 提交走服务端 /api/wanted/execute；反馈统一走右上角通知中心（toast + BobMail）
 *  - 会话态：Node 模式（/chat 激活中）或会议模式（/meeting 记录中）下，普通文本直接发给会话
 *
 * 语义判断已移除（2026-08）：普通文本只走搜索/会话，指令必须显式以 / 开头。
 * 原 TaskPanel 的 LCD 显示屏、悬浮球均已废弃，指令执行反馈全部由 WantedNoticeCenter 承担。
 */

/** 服务端统一执行返回结构（与微信端共享同一状态，不再本地执行） */
interface WantedExecResponse {
  success: boolean;
  error?: string;
  reply?: string;
  command?: 'todo' | 'check' | 'notebook' | 'chat' | 'meeting' | 'help' | 'inspect' | null;
  nodeMode?: boolean;
  nodeModeExited?: boolean;
  meetingMode?: boolean;
  meetingEnded?: boolean;
  tasks?: SummarizedTask[];
  ambiguous?: string[];
  modelUsed?: string;
  savedCount?: number;
  /** /chat 对话历史（system + 历史Q&A + 本轮Q&A），由服务端 askTempNode 构建，直接透传给 BobMail 线程 */
  messages?: ChatMessage[];
  /** /chat 活动线程（BobMail threadId ↔ /chat 会话一一对应），服务端确认后回传 */
  threadId?: string;
  /** /note check 查询出的笔记条目 */
  notes?: WikiEntryWithContent[];
  /** /todo check 查询出的日程事件 */
  events?: ScheduleEvent[];
}

interface SearchHit {
  name: string;
  path: string;
  source: 'bobwork' | 'workspace' | 'project' | 'local' | 'attachment' | 'material';
  sourceLabel: string;
  type: 'file' | 'directory' | 'project';
  size?: string;
  extension?: string;
  projectId?: string;
  projectName?: string;
}

interface UnifiedPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 输入框下方功能入口（仅图标，悬停显示名称）：由宿主注入，保持面板不感知各功能面板的开关状态 */
  actions?: Array<{ key: string; label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }>;
  /** 标星小程序快捷图标（与功能入口同一行，之间用竖线隔开）：点击直接打开预览 */
  starredApps?: Array<{ id: string; name: string }>;
}

/** 文件扩展名 → 图标颜色（与本地文件浏览器一致） */
function fileExtColor(ext?: string): string {
  switch (ext) {
    case 'md': return 'oklch(0.55 0.15 45)';
    case 'json': return 'oklch(0.50 0.12 200)';
    case 'ts': case 'tsx': return 'oklch(0.50 0.15 240)';
    case 'js': case 'jsx': return 'oklch(0.55 0.15 60)';
    case 'py': return 'oklch(0.55 0.15 180)';
    case 'css': return 'oklch(0.55 0.15 300)';
    case 'pdf': return 'oklch(0.55 0.18 25)';
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': return 'oklch(0.55 0.15 330)';
    case 'doc': case 'docx': return 'oklch(0.50 0.15 250)';
    case 'xls': case 'xlsx': return 'oklch(0.55 0.15 140)';
    default: return 'oklch(0.50 0.02 60)';
  }
}

const sourceBadgeColor: Record<string, string> = {
  project: 'oklch(0.55 0.15 260)',
  workspace: 'oklch(0.55 0.15 140)',
  bobwork: 'oklch(0.55 0.12 200)',
};

/** 展示用短路径：保留末尾三段 */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-3).join('/') || p;
}

export function UnifiedPalette({ open, onClose, actions, starredApps }: UnifiedPaletteProps) {
  // ===== 输入（查找态 / 指令态共用） =====
  const [query, setQuery] = useState('');
  const [cursorPos, setCursorPos] = useState(0);
  const cursorPosRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ===== 查找态（原 GlobalSearch 逻辑） =====
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ===== 指令态（原 TaskPanel 指令核心） =====
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandHighlight, setCommandHighlight] = useState(0);
  const [activeCommand, setActiveCommand] = useState<WantedCommand | null>(null);
  const [commandUsage, setCommandUsage] = useState<Record<string, number>>(() => loadCommandUsage());

  // ===== 会话态：Node 模式 / 会议模式（与微信端共享服务端进程状态） =====
  const [nodeMode, setNodeMode] = useState(false);
  const [meetingMode, setMeetingMode] = useState(false);
  const activeChatThreadIdRef = useRef<string | null>(null);

  // 形态判定：/ 开头 → 指令态；Node/会议激活 → 会话态；否则 → 查找态
  const commandMode = hasCommandIntent(query);
  const sessionMode = nodeMode || meetingMode;
  const searchMode = !commandMode && !sessionMode;

  // ===== 打开时重置 + 拉取服务端会话状态（保证面板关闭后再次 ⌘F 可续聊） =====
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setLoading(false);
    setActiveIdx(0);
    setError(null);
    setCommandOpen(false);
    setActiveCommand(null);
    setCommandHighlight(0);
    setExecuting(false);
    fetch('/api/wanted/node-chat', { method: 'GET' })
      .then((r) => r.json())
      .then((d: { active?: boolean; meetingActive?: boolean; threadId?: string | null }) => {
        if (typeof d?.active === 'boolean') setNodeMode(d.active);
        if (typeof d?.meetingActive === 'boolean') setMeetingMode(d.meetingActive);
        if (typeof d?.threadId === 'string' && d.threadId) activeChatThreadIdRef.current = d.threadId;
      })
      .catch(() => { /* 服务未就绪时忽略 */ });
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  // ===== 查找态：搜索 / 打开 =====
  const doSearch = useCallback(async (q: string) => {
    if (!q.trim() || hasCommandIntent(q)) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=global`);
      const data = await resp.json();
      if (data.success) {
        setHits((data.results || []) as SearchHit[]);
        setActiveIdx(0);
      } else {
        setHits([]);
      }
    } catch {
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = useCallback((value: string) => {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    // 指令态/会话态不触发搜索（避免无意义请求）
    if (hasCommandIntent(value) || executing) return;
    searchTimer.current = setTimeout(() => void doSearch(value), 250);
  }, [doSearch, executing]);

  const sections = useMemo(() => {
    const projects = hits.filter((h) => h.type === 'project');
    const files = hits.filter((h) => h.type !== 'project');
    return [
      { key: 'projects', label: 'Projects', items: projects },
      { key: 'workspace', label: 'BobWorkspace', items: files.filter((h) => h.source === 'workspace') },
      { key: 'bobwork', label: 'BobWork', items: files.filter((h) => h.source === 'bobwork') },
    ].filter((s) => s.items.length > 0);
  }, [hits]);

  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const switchToProject = useCallback(async (projectId: string): Promise<boolean> => {
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switch', project_id: projectId }),
      });
      const data = await resp.json();
      if (data.success) {
        window.dispatchEvent(new CustomEvent('bobagent:project-switched', { detail: { projectId } }));
        return true;
      }
    } catch { /* 切换失败静默 */ }
    return false;
  }, []);

  const getCurrentProjectId = useCallback(async (): Promise<string | null> => {
    try {
      const resp = await fetch('/api/projects?action=current');
      const data = await resp.json();
      return data?.success ? (data?.project?.id ?? null) : null;
    } catch {
      return null;
    }
  }, []);

  const openProject = useCallback(async (projectId: string) => {
    const currentId = await getCurrentProjectId();
    if (currentId === projectId) {
      onClose();
      return;
    }
    const ok = await switchToProject(projectId);
    if (!ok) {
      setError('Failed to switch project — please retry');
      return;
    }
    onClose();
  }, [getCurrentProjectId, switchToProject, onClose]);

  /** 单击打开：项目条目 → 切换/关闭；文件 → 直接打开（跨项目文件不生成影子、不切换项目，
   *  可预览走查看舱，否则系统默认程序打开） */
  const openFileInCurrent = useCallback(async (item: SearchHit) => {
    if (item.type === 'project' && item.projectId) {
      await openProject(item.projectId);
      return;
    }
    if (isPreviewable(item.extension) || isBrowserDoc(item.name)) {
      bus.publish(BusEvents.fileOpen, { source: 'local', path: item.path, name: item.name });
    } else {
      void desktop.openFile(item.path);
    }
    onClose();
  }, [openProject, onClose]);

  const activate = useCallback((idx: number) => {
    const item = flatItems[idx];
    if (!item) return;
    if (item.type === 'project' && item.projectId) {
      void openProject(item.projectId);
    } else {
      // 默认动作 = 直接打开（跨项目文件不切项目、不生成影子）
      void openFileInCurrent(item);
    }
  }, [flatItems, openProject, openFileInCurrent]);

  const moveActive = useCallback((delta: number) => {
    setActiveIdx((prev) => {
      if (flatItems.length === 0) return 0;
      return (prev + delta + flatItems.length) % flatItems.length;
    });
  }, [flatItems.length]);

  // ===== 指令态：光标行指令状态同步 =====
  const updateCommandState = useCallback((text: string, pos: number, keepHighlight?: boolean) => {
    const { lineText } = getLineAtCursor(text, pos);
    if (hasCommandIntent(lineText)) {
      const matched = detectCommand(lineText);
      if (matched) {
        setActiveCommand(matched);
        setCommandOpen(false);
      } else {
        setActiveCommand(null);
        setCommandOpen(true);
        if (!keepHighlight) setCommandHighlight(0);
      }
    } else {
      setActiveCommand(null);
      setCommandOpen(false);
    }
  }, []);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const pos = e.target.selectionStart ?? value.length;
    cursorPosRef.current = pos;
    setCursorPos(pos);
    handleInput(value);
    updateCommandState(value, pos);
  }, [handleInput, updateCommandState]);
  const handleCursorMove = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.target as HTMLTextAreaElement;
    const pos = ta.selectionStart ?? 0;
    cursorPosRef.current = pos;
    setCursorPos(pos);
    const isKeyboardNav = (e.nativeEvent as Event).type === 'keyup';
    updateCommandState(query, pos, isKeyboardNav ? true : undefined);
  }, [query, updateCommandState]);

  /** 应用选中的指令：把 /xxx 写到光标所在行行首，其余行保持不变 */
  const applyCommand = useCallback((cmd: WantedCommand) => {
    recordCommandUsage(cmd.id);
    setCommandUsage((prev) => ({ ...prev, [cmd.id]: (prev[cmd.id] ?? 0) + 1 }));
    const pos = cursorPosRef.current;
    const { text: newText, caret } = buildCommandTextAtLine(query, pos, cmd.keyword);
    setQuery(newText);
    setActiveCommand(cmd);
    setCommandOpen(false);
    setCommandHighlight(0);
    cursorPosRef.current = caret;
    setCursorPos(caret);
    inputRef.current?.focus();
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (ta) ta.setSelectionRange(caret, caret);
    });
  }, [query]);

  // 当前光标行的指令候选（用于下拉渲染）
  const { lineText: currentLineText } = getLineAtCursor(query, cursorPos);
  const commandCandidates = commandOpen ? filterCommands(currentLineText, commandUsage) : [];

  // ===== 指令/会话执行：分组 → /api/wanted/execute → 通知中心（LCD 已废弃） =====
  const handleExecute = useCallback(async () => {
    const text = query.trim();
    if (!text || executing) return;
    setExecuting(true);
    setError(null);
    // 发布"执行中"状态：通知中心右上角弹出常驻浮层，整批命令跑完后再关闭
    const firstLine = text.split('\n')[0] || '/';
    const runningLabel = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
    bus.publish(BusEvents.wantedExecuting, { executing: true, label: `Running ${runningLabel}` });
    try {
      // 多命令分组：每条 /命令行开启新组，无指令的续行归入上一组（支持 shift+enter 批量）
      const allLines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const groups: string[] = [];
      let currentGroup: string[] = [];
      for (const line of allLines) {
        if (/^\s*\//.test(line) && currentGroup.length > 0) {
          groups.push(currentGroup.join('\n'));
          currentGroup = [line];
        } else {
          currentGroup.push(line);
        }
      }
      if (currentGroup.length > 0) groups.push(currentGroup.join('\n'));

      let anySuccess = false;
      let firstError: string | null = null;

      for (const group of groups) {
        // chat 线程复用判定：/chat out 清理 / /chat new 强制新建 / 会话态与普通 /chat 复用活动线程
        const trimmed = group.trim();
        const isChatOut = /^\s*\/chat\s+out\b/i.test(trimmed);
        const isChatNew = /^\s*\/chat\s+new\b/i.test(trimmed);
        if (isChatOut || isChatNew) {
          activeChatThreadIdRef.current = null;
        }
        const isChatReuse = nodeMode || (trimmed.startsWith('/chat') && !isChatNew);
        const threadIdHint = isChatReuse ? (activeChatThreadIdRef.current ?? undefined) : undefined;

        const resp = await fetch('/api/wanted/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: group, threadIdHint }),
        });
        const result = (await resp.json()) as WantedExecResponse;
        // 同步会话状态（/chat 进入 / 退出、/meeting 开启 / 静默超时）
        if (typeof result.nodeMode === 'boolean') setNodeMode(result.nodeMode);
        if (typeof result.meetingMode === 'boolean') setMeetingMode(result.meetingMode);
        if (!result.success) {
          firstError = result.error || 'Execution failed';
          continue;
        }
        anySuccess = true;
        // 每条命令独立触发一条通知事件（/chat out 为纯状态变更、/help 与 /meeting 不进 BobMail）
        if (result.reply && !result.nodeModeExited && result.command !== 'help' && result.command !== 'meeting') {
          const isNoteCheck = result.command === 'notebook' && Array.isArray(result.notes);
          const kind: WantedNoticePayload['kind'] =
            result.command === 'todo' && (!result.tasks || result.tasks.length === 0) ? 'todo_del'
            : result.command === 'todo' ? 'task'
            : result.command === 'notebook' ? (isNoteCheck ? 'notes' : 'note')
            : result.command === 'check' ? 'check'
            : result.command === 'inspect' ? 'inspect'
            : 'info';
          let threadId: string | undefined;
          let messages: ChatMessage[] | undefined;
          let noticeTitle =
            result.command === 'todo'
              ? `Tasks saved (${result.tasks?.length ?? 0})`
              : result.command === 'notebook'
                ? (isNoteCheck ? 'Notes check' : 'Notes saved')
                : result.command === 'check'
                  ? 'Schedule check'
                  : result.command === 'inspect'
                    ? 'Inspect all projects'
                    : result.command === 'chat'
                      ? 'Node reply'
                      : 'WANTED';
          let items: WantedNoticeItem[] | undefined;
          if (isNoteCheck) {
            items = (result.notes ?? []).map((n) => ({
              key: n.id,
              title: n.title,
              content: n.content,
              time: n.date || (n.updatedAt || '').slice(0, 10) || '',
              startMs: n.updatedAt ? Date.parse(n.updatedAt) || Date.now() : Date.now(),
            }));
          } else if (result.command === 'check' && Array.isArray(result.events)) {
            items = result.events
              .filter((ev) => ev.event_id)
              .slice(0, 30)
              .map((ev) => ({
                key: ev.event_id!,
                title: ev.title,
                time: ev.start_time,
                startMs: ev.start_time ? Date.parse(ev.start_time) || Date.now() : Date.now(),
                status: ev.status,
                priority: ev.priority,
                allDay: !!ev.all_day,
              }));
          }
          // 查询签名：同一查询重复执行时生成"本轮新邮件"而非复用旧邮件
          let queryKey: string | undefined;
          const queryText = (cmd: string): string =>
            group.replace(new RegExp(`^\\s*${cmd.replace('/', '\\/')}\\b[ \\t]*`, 'i'), '').trim();
          if (isNoteCheck) {
            queryKey = `notecheck:${queryText('/note check') || 'all'}`;
          } else if (result.command === 'check') {
            queryKey = `todocheck:${queryText('/todo check') || 'all'}`;
          } else if (result.command === 'inspect') {
            queryKey = 'inspect';
          } else if (result.command === 'todo' && kind === 'todo_del') {
            queryKey = `tododel:${queryText('/todo del') || 'all'}`;
          }
          // /chat 不再进 BobMail：统一 toast 浮层展示，保持面板轻量交互
          bus.publish(BusEvents.wantedNotice, {
            kind,
            title: noticeTitle,
            body: result.reply,
            action: result.command === 'todo' ? { type: 'open-calendar' } : undefined,
            source: 'panel',
            threadId,
            messages,
            items,
            queryKey,
            dedupeKey: threadId ?? `${kind}|${noticeTitle}|${Date.now() / 1000 | 0}`,
            toast: kind === 'task' || kind === 'note' || result.command === 'chat',
          });
        }
        // 日历事件变更信号：通知 WantedNoticeCenter 立即拉取 reminders 队列
        if (result.command === 'todo' && result.tasks && result.tasks.length > 0) {
          window.dispatchEvent(new Event('calendar-events-changed'));
        }
      }

      if (anySuccess) {
        setQuery('');
        setCommandOpen(false);
        setActiveCommand(null);
        // 执行成功 → 关闭面板，让用户看到通知中心的 toast / BobMail 邮件
        onClose();
      } else {
        setError(firstError || 'Execution failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setExecuting(false);
      bus.publish(BusEvents.wantedExecuting, { executing: false });
    }
  }, [query, executing, nodeMode, onClose]);

  // ===== 键盘：查找态窗口级导航（保持 GlobalSearch 行为） =====
  useEffect(() => {
    if (!open || !searchMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveActive(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveActive(-1);
        return;
      }
      if (e.key === 'Enter') {
        if ((e as KeyboardEvent & { isComposing?: boolean }).isComposing) return;
        e.preventDefault();
        activate(activeIdx);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, searchMode, onClose, moveActive, activate, activeIdx]);

  // 指令态/会话态：Esc 关闭面板（指令下拉的 Esc 由 textarea 优先处理并 stopPropagation）
  useEffect(() => {
    if (!open || searchMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, searchMode, onClose]);

  // 选中项滚动到可视区
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open, hits]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 指令下拉打开时的导航键
    if (commandOpen) {
      const { lineText } = getLineAtCursor(query, cursorPosRef.current);
      const candidates = filterCommands(lineText, commandUsage);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setCommandHighlight((i) => (i + 1) % Math.max(candidates.length, 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setCommandHighlight((i) => (i - 1 + Math.max(candidates.length, 1)) % Math.max(candidates.length, 1));
        return;
      }
      if (e.key === 'Enter' && candidates.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        applyCommand(candidates[commandHighlight]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setCommandOpen(false);
        return;
      }
    }
    // 指令态/会话态：Enter 提交；Shift+Enter 换行；IME 拼音合成阶段按 Enter 仅上屏不提交
    if (commandMode || sessionMode) {
      const isIMEComposing = (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229;
      if (e.key === 'Enter' && !e.shiftKey && !isIMEComposing) {
        e.preventDefault();
        e.stopPropagation();
        void handleExecute();
      }
    }
  }, [commandOpen, commandHighlight, commandUsage, query, applyCommand, commandMode, sessionMode, handleExecute]);

  // 输入区行数：查找态固定 1 行；指令/会话态按换行自适应（最多 4 行）
  const textareaRows = searchMode ? 1 : Math.min(query.split('\n').length, 4);

  if (!open) return null;

  const flatIdxOf = (item: SearchHit): number => flatItems.indexOf(item);

  // 会话态徽标：/chat 或 /meeting
  const sessionLabel = meetingMode ? '/meeting' : '/chat';

  const inputPlaceholder = meetingMode
    ? 'Meeting recording… type or forward content (type /meeting out to end)'
    : nodeMode
      ? 'Node mode enabled: type directly to ask the AI node (type /chat out or any command like /todo to exit)'
      : activeCommand
        ? `${activeCommand.keyword} enabled — type task content…`
        : 'Search projects & files in BobWork / BobWorkspace… or type / for commands';

  return createPortal(
    <div
      data-canvas-ui="overlay"
      className="fixed inset-0 flex items-start justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.35)', zIndex: 10000, WebkitAppRegion: 'no-drag' } as CSSProperties}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="mt-[16vh] flex w-[790px] max-w-[90vw] flex-col overflow-hidden rounded-2xl shadow-2xl"
        style={{
          backgroundColor: 'var(--paper)',
          border: '1px solid var(--line)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* 输入行（指令/会话态与查找态共用） */}
        <div
          className="flex shrink-0 items-center gap-2 px-4 py-3"
          style={{ borderBottom: searchMode && !actions?.length ? '1px solid var(--line-soft)' : 'none' }}
        >
          {sessionMode ? (
            <span
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-10 font-semibold uppercase"
              style={{ color: 'var(--primary)', backgroundColor: 'var(--primary-soft, var(--paper-hover))', border: '1px solid var(--line)' }}
            >
              {meetingMode ? <Mic className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
              {sessionLabel}
            </span>
          ) : commandMode ? (
            <Zap className="h-4 w-4 shrink-0" style={{ color: 'var(--primary)' }} />
          ) : (
            <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--ink-muted)' }} />
          )}
          <textarea
            ref={inputRef}
            value={query}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onSelect={handleCursorMove}
            onClick={handleCursorMove}
            onKeyUp={handleCursorMove}
            rows={textareaRows}
            placeholder={inputPlaceholder}
            className="nowheel w-full flex-1 resize-none bg-transparent text-sm outline-none"
            style={{ color: 'var(--ink)', lineHeight: 1.5, overflowY: searchMode ? 'hidden' : 'auto' }}
          />
          {(loading || executing) && <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--ink-muted)' }} />}
          {query && !loading && !executing && (
            <button
              onClick={() => { setQuery(''); setHits([]); setCommandOpen(false); setActiveCommand(null); inputRef.current?.focus(); }}
              className="rounded p-0.5 hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <kbd
            className="shrink-0 rounded border px-1.5 py-0.5 text-10 font-medium"
            style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}
          >
            ⌘F
          </kbd>
        </div>

        {/* 功能入口图标行（2026-09-12 自左侧边栏迁入）：仅图标，悬停显示名称；
            其后紧跟标星小程序快捷图标，两者之间用竖线隔开 */}
        {((actions && actions.length > 0) || (starredApps && starredApps.length > 0)) && (
          <div
            className="flex shrink-0 items-center gap-0.5 px-3 pb-3"
            style={{ borderBottom: searchMode ? '1px solid var(--line-soft)' : 'none' }}
          >
            {actions?.map((act) => (
              <button
                key={act.key}
                type="button"
                onClick={() => { act.onClick(); onClose(); }}
                disabled={act.disabled}
                title={act.label}
                aria-label={act.label}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                style={{ color: 'var(--ink-muted)' }}
              >
                {act.icon}
              </button>
            ))}
            {/* 竖线分隔：功能按钮 / 标星小程序 */}
            {actions && actions.length > 0 && starredApps && starredApps.length > 0 && (
              <span
                className="mx-1 h-5 w-px shrink-0"
                style={{ backgroundColor: 'color-mix(in oklab, var(--line) 30%, transparent)' }}
              />
            )}
            {/* 标星小程序（点击直接打开预览，最多显示 5 个，超出折叠为 +N 打开商店） */}
            {starredApps?.slice(0, 5).map((app) => (
              <button
                key={app.id}
                type="button"
                title={`${app.name} — open`}
                aria-label={app.name}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('open-sandbox-preview', { detail: { id: app.id, name: app.name } }));
                  onClose();
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--paper-soft)] text-sm font-semibold text-[var(--ink-strong)] transition-all duration-100 hover:scale-[1.18] hover:bg-[var(--primary-soft)] hover:text-[var(--primary)] hover:shadow-sm"
              >
                {app.name.charAt(0).toUpperCase()}
              </button>
            ))}
            {starredApps && starredApps.length > 5 && (
              <button
                type="button"
                title="More starred apps — open store"
                aria-label="More starred mini programs"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('sandbox-store-open'));
                  onClose();
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm font-medium transition-colors hover:brightness-95"
                style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)' }}
              >
                +{starredApps.length - 5}
              </button>
            )}
          </div>
        )}

        {/* 指令候选下拉（流式撑开面板，避免被 overflow-hidden 裁剪） */}
        {commandOpen && (
          <div
            className="shrink-0"
            style={{
              margin: '0 12px 4px',
              maxHeight: 200,
              overflowY: 'auto',
              backgroundColor: 'var(--paper)',
              border: '1px solid var(--line)',
              borderRadius: '8px',
              boxShadow: '0 6px 16px rgba(0,0,0,0.10)',
            }}
          >
            {commandCandidates.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => applyCommand(c)}
                onMouseEnter={() => setCommandHighlight(i)}
                className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left"
                style={{
                  backgroundColor: i === commandHighlight ? 'var(--paper-hover)' : 'transparent',
                  borderLeft: i === commandHighlight ? '2px solid var(--primary)' : '2px solid transparent',
                }}
              >
                <span className="w-20 shrink-0 text-13 font-semibold" style={{ color: 'var(--primary)' }}>/{c.keyword}</span>
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>{c.description}</span>
              </button>
            ))}
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="mx-3 mt-2 flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        {/* 查找态：结果列表 */}
        {searchMode && (
          <div ref={listRef} className="max-h-[64vh] overflow-y-auto">
            {!query.trim() ? null : loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--ink-muted)' }} />
              </div>
            ) : flatItems.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
                {`No matches for "${query}"`}
              </div>
            ) : (
              sections.map((section) => (
                <div key={section.key}>
                  <div
                    className="sticky top-0 z-10 px-4 pb-1 pt-3 text-11 font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--ink-muted)', backgroundColor: 'var(--paper)' }}
                  >
                    {section.label} · {section.items.length}
                  </div>
                  {section.items.map((item) => {
                    const idx = flatIdxOf(item);
                    const active = idx === activeIdx;
                    return (
                      <div
                        key={`${item.source}-${item.path}`}
                        data-active={active || undefined}
                        className="group flex cursor-pointer items-center gap-2.5 px-4 py-2"
                        style={{
                          backgroundColor: active ? 'var(--paper-hover)' : 'transparent',
                          borderLeft: active ? '2px solid var(--primary)' : '2px solid transparent',
                        }}
                        onMouseMove={() => setActiveIdx(idx)}
                        onClick={() => activate(idx)}
                      >
                        {item.type === 'project' ? (
                          <Briefcase className="h-4 w-4 shrink-0" style={{ color: 'var(--primary)' }} />
                        ) : (
                          <FileIcon className="h-4 w-4 shrink-0" style={{ color: fileExtColor(item.extension) }} />
                        )}
                        <div className="min-w-0 flex-1">
                          <FileName
                            name={item.name}
                            className="text-sm"
                            style={{ color: 'var(--ink)' }}
                          />
                          <div className="truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                            {shortPath(item.path)}
                          </div>
                        </div>
                        {item.size && (
                          <span className="shrink-0 text-11" style={{ color: 'var(--ink-muted)' }}>{item.size}</span>
                        )}
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-10 font-medium"
                          style={{
                            backgroundColor: `${sourceBadgeColor[item.source] || 'oklch(0.5 0.02 60)'}22`,
                            color: sourceBadgeColor[item.source] || 'var(--ink-muted)',
                          }}
                        >
                          {item.sourceLabel}
                        </span>
                        {item.type !== 'project' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void desktop.showItemInFolder(item.path);
                            }}
                            className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-[var(--paper-hover)] group-hover:opacity-100"
                            style={{ color: 'var(--ink-muted)' }}
                            title="Reveal in Finder"
                          >
                            <Folder className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
