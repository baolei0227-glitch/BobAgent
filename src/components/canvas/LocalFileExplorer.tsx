'use client';

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  Folder,
  FolderOpen,
  File as FileIcon,
  Search,
  X,
  Loader2,
  AlertCircle,
  FolderPlus,
  FilePlus,
  Pencil,
  Copy,
  Trash,
  ArrowUpCircle,
  PlusCircle,
  Eye,
  ExternalLink,
  ShieldCheck,
  CornerUpLeft,
  Pin,
  PinOff,
  MoreVertical,
} from 'lucide-react';

import { bus, BusEvents } from '@/lib/bus';
import type { MessageAttachment } from '@/lib/types';
import { isBrowserDoc, isPreviewable } from './viewers/registry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { FileName } from './FileName';

/** 目录/文件列表项（授权目录展开浏览用） */
interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: string;
  sizeBytes?: number;
  extension?: string;
}
import { desktop, isDesktop } from '@/lib/desktop-adapter';

interface SearchResult {
  name: string;
  path: string;
  source: 'local' | 'attachment' | 'material';
  sourceLabel: string;
  type: 'file' | 'directory';
  size?: string;
  extension?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  filePath: string;
  fileName: string;
  /** true：授权目录内的子文件夹（发送到节点后作为操作目录，锁定 AI 操作范围） */
  isDir: boolean;
}

interface LocalFileExplorerProps {
  activeNodeIdRef: RefObject<string | null>;
  onCreateNodeWithFile?: (filePath: string, isDir?: boolean) => Promise<{ nodeId: string; attachment: unknown } | null>;
  /** 自动折叠用：鼠标移出 debounce 2s 后调用（一般 setCollapsed(true)）；点击面板外部立即折叠。
   *  undefined 时仍能正常渲染，仅不会触发自动折叠（兼容旧调用方）。 */
  onToggleCollapse?: () => void;
  /** Pin 固定状态：true 时鼠标移出不自动折叠 */
  pinned?: boolean;
  /** 切换 Pin/Unpin（父级 CanvasFlow 提供） */
  onTogglePinned?: () => void;
}

/** 字符串数组浅比较（用于轮询时避免无谓 setState） */
function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 文件项浅比较：轮询刷新内容未变化时不触发重渲染，避免列表抖动 */
function itemsEqual(a: FileItem[], b: FileItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.name !== y.name || x.path !== y.path || x.type !== y.type || x.size !== y.size || x.extension !== y.extension) {
      return false;
    }
  }
  return true;
}

/** 搜索结果浅比较（同 itemsEqual，避免搜索轮询抖动） */
function searchResultsEqual(a: SearchResult[], b: SearchResult[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.name !== y.name || x.path !== y.path || x.type !== y.type || x.size !== y.size || x.source !== y.source) {
      return false;
    }
  }
  return true;
}

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
    case 'db': return 'oklch(0.45 0.05 150)';
    default: return 'oklch(0.50 0.02 60)';
  }
}

const sourceColor: Record<string, string> = {
  local: 'oklch(0.55 0.12 200)',
  attachment: 'oklch(0.55 0.15 45)',
  material: 'oklch(0.55 0.15 140)',
};

export function LocalFileExplorer({
  activeNodeIdRef,
  onCreateNodeWithFile,
  onToggleCollapse,
  pinned = false,
  onTogglePinned,
}: LocalFileExplorerProps) {
  const [roots, setRoots] = useState<string[]>([]);
  const [browseRoots, setBrowseRoots] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 待授权目录（点击「授权」后弹确认框，确认才授权给 AI）
  const [authorizePendingPath, setAuthorizePendingPath] = useState<string | null>(null);
  const mouseLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePanelMouseEnter = useCallback(() => {
    if (mouseLeaveTimerRef.current) {
      clearTimeout(mouseLeaveTimerRef.current);
      mouseLeaveTimerRef.current = null;
    }
  }, []);
  const handlePanelMouseLeave = useCallback(() => {
    // 授权确认弹窗打开时不移出自动收起（无论是否固定）
    if (pinned || authorizePendingPath) return;
    if (!onToggleCollapse) return;
    if (mouseLeaveTimerRef.current) clearTimeout(mouseLeaveTimerRef.current);
    mouseLeaveTimerRef.current = setTimeout(() => {
      onToggleCollapse();
    }, 1000);
  }, [pinned, authorizePendingPath, onToggleCollapse]);

  // 面板挂载期间即展开态：点击面板外部任意位置 → 立即折叠（不等 1s debounce；pinned 固定时不折叠）
  const rootRef = useRef<HTMLDivElement>(null);
  // 授权确认弹窗（body 级 portal）的引用：点击弹窗内部不触发折叠
  const authModalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pinned || !onToggleCollapse) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const el = rootRef.current;
      if (!el) return;
      const target = e.target as Node | null;
      // 点击面板内部或授权确认弹窗内不折叠
      if (target && (el.contains(target) || (authModalRef.current && authModalRef.current.contains(target)))) return;
      if (mouseLeaveTimerRef.current) {
        clearTimeout(mouseLeaveTimerRef.current);
        mouseLeaveTimerRef.current = null;
      }
      onToggleCollapse();
    };
    window.addEventListener('pointerdown', onDocPointerDown);
    return () => window.removeEventListener('pointerdown', onDocPointerDown);
  }, [pinned, onToggleCollapse]);
  // 授权目录展开浏览状态（仅限已授权目录内导航）
  const [expandedRoot, setExpandedRoot] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);

  // 搜索状态
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  // 重命名弹窗
  const [renaming, setRenaming] = useState<{ filePath: string; oldName: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  // 关闭右键菜单（点击任意处）
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);

  // 加载浏览目录与授权目录（相同数据不触发 setState，避免轮询导致无谓重渲染）
  const loadRoots = useCallback(async (): Promise<void> => {
    try {
      const resp = await fetch('/api/local-files?action=roots');
      const data = await resp.json();
      if (data.success) {
        const nextRoots = (data.roots || []) as string[];
        const nextBrowseRoots = (data.browseRoots || []) as string[];
        setRoots((prev) => (arraysEqual(prev, nextRoots) ? prev : nextRoots));
        setBrowseRoots((prev) => (arraysEqual(prev, nextBrowseRoots) ? prev : nextBrowseRoots));
      }
    } catch { /* ignore */ }
  }, []);

  // 加载授权目录内容（仅限已授权目录内浏览）；silent=true 用于轮询静默刷新（不闪 loading、内容相同不重渲染）
  const listDirectory = useCallback(async (dirPath: string, silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/local-files?path=${encodeURIComponent(dirPath)}`);
      const data = await resp.json();
      if (data.success) {
        const nextItems = (data.items || []) as FileItem[];
        setItems((prev) => (itemsEqual(prev, nextItems) ? prev : nextItems));
        setBrowsePath((prev) => (prev === data.path ? prev : data.path));
      } else {
        setError(data.error || 'Failed to read directory');
        setItems([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // 选择文件夹 → 添加为浏览目录（仅人类浏览，不涉及 AI 授权）
  const handleSelectDirectory = useCallback(async () => {
    if (!isDesktop()) {
      setError('Folder selection requires the Electron desktop app');
      return;
    }
    const result = await desktop.selectDirectory();
    if (!result.success || result.canceled) return;
    const path = result.path!;
    try {
      const resp = await fetch(`/api/local-files?action=add_root&path=${encodeURIComponent(path)}`);
      const data = await resp.json();
      if (data.success) {
        setRoots(data.roots || []);
        setBrowseRoots(data.browseRoots || []);
        setError(null);
        // 添加成功后自动展开浏览该目录
        setExpandedRoot(path);
        setBrowsePath(path);
        listDirectory(path);
        window.dispatchEvent(new CustomEvent('local-roots-changed'));
      } else {
        setError(data.error || 'Add failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [listDirectory]);

  // 一键在系统文件管理器中打开文件夹（优先当前浏览目录，其次第一个已添加目录）
  const handleOpenInFinder = useCallback(async () => {
    if (!isDesktop()) {
      setError('Opening in Finder requires the Electron desktop app');
      return;
    }
    const fallback = [...new Set([...browseRoots, ...roots])][0];
    const target = browsePath || expandedRoot || fallback;
    if (!target) {
      setError('No folder to open');
      return;
    }
    const result = await desktop.showItemInFolder(target);
    if (!result.success) setError(result.error || 'Open failed');
  }, [browsePath, expandedRoot, browseRoots, roots]);

  // 点击授权/断开：已授权 → 直接断开；未授权 → 弹确认框
  const handleAuthorizeClick = useCallback((rootPath: string) => {
    if (roots.includes(rootPath)) {
      // 断开授权（保留浏览）
      fetch(`/api/local-files?action=revoke_root&path=${encodeURIComponent(rootPath)}`)
        .then(r => r.json())
        .then((data) => {
          if (data.success) {
            setRoots(data.roots || []);
            setBrowseRoots(data.browseRoots || []);
            setError(null);
            window.dispatchEvent(new CustomEvent('local-roots-changed'));
          } else {
            setError(data.error || 'Revoke failed');
          }
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    } else {
      setAuthorizePendingPath(rootPath);
    }
  }, [roots]);

  // 确认授权（授权即读写：AI 可读取并修改目录内文件）
  const confirmAuthorize = useCallback(async () => {
    if (!authorizePendingPath) return;
    const resp = await fetch(`/api/local-files?action=authorize_root&path=${encodeURIComponent(authorizePendingPath)}`);
    const data = await resp.json();
    if (data.success) {
      setRoots(data.roots || []);
      setBrowseRoots(data.browseRoots || []);
      setAuthorizePendingPath(null);
      setError(null);
      window.dispatchEvent(new CustomEvent('local-roots-changed'));
    } else {
      setError(data.error || 'Authorization failed');
    }
  }, [authorizePendingPath]);

  // 取消授权
  const cancelAuthorize = useCallback(() => {
    setAuthorizePendingPath(null);
  }, []);

  // 搜索（受限：仅已授权目录内，只保留文件结果）；silent=true 用于轮询静默刷新（不闪 searching、结果相同不重渲染）
  const doSearch = useCallback(async (q: string, silent = false) => {
    if (!q.trim()) {
      setSearchResults([]);
      setSearchMode(false);
      return;
    }
    if (!silent) {
      setSearching(true);
      setSearchMode(true);
      setError(null);
      // 进入搜索时收起目录展开浏览
      setExpandedRoot(null);
      setBrowsePath(null);
      setItems([]);
    }
    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=local`);
      const data = await resp.json();
      if (data.success) {
        const next = (data.results || []).filter((r: SearchResult) => r.type === 'file');
        setSearchResults((prev) => (searchResultsEqual(prev, next) ? prev : next));
      } else {
        if (!silent) setError(data.error || 'Search failed');
        setSearchResults([]);
      }
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : String(e));
      setSearchResults([]);
    } finally {
      if (!silent) setSearching(false);
    }
  }, []);

  const handleSearchInput = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(value), 400);
  }, [doSearch]);

  // 展开/收起授权目录
  const toggleExpand = useCallback((root: string) => {
    setCtxMenu(null);
    if (expandedRoot === root) {
      setExpandedRoot(null);
      setBrowsePath(null);
      setItems([]);
    } else {
      setExpandedRoot(root);
      setBrowsePath(root);
      listDirectory(root);
    }
  }, [expandedRoot, listDirectory]);

  // 进入子目录
  const enterDir = useCallback((dirPath: string) => {
    setCtxMenu(null);
    listDirectory(dirPath);
  }, [listDirectory]);

  // 返回上级（不越过授权根目录）
  const goUp = useCallback(() => {
    if (!expandedRoot || !browsePath) return;
    if (browsePath === expandedRoot) return;
    const parts = browsePath.split('/').filter(Boolean);
    parts.pop();
    const parent = '/' + parts.join('/');
    listDirectory(parent);
  }, [expandedRoot, browsePath, listDirectory]);

  // 刷新当前视图（浏览模式刷新目录，搜索模式重新搜索）；轮询/事件刷新走静默模式，避免 loading 闪烁与内容未变时的重渲染抖动
  const refreshView = useCallback(() => {
    if (expandedRoot && browsePath) {
      listDirectory(browsePath, true);
    } else if (searchQuery) {
      doSearch(searchQuery, true);
    }
  }, [expandedRoot, browsePath, searchQuery, listDirectory, doSearch]);

  // 发送附件到指定节点：先写入事件缓冲（防新建节点挂载前事件丢失），再广播事件
  const sendAttachmentToNode = useCallback((nodeId: string, attachment: MessageAttachment) => {
    const pendingMap = (window.__pendingNodeAttachments ??= {});
    (pendingMap[nodeId] ??= []).push(attachment);
    window.dispatchEvent(new CustomEvent('add-attachment-to-node', {
      detail: { node_id: nodeId, attachment },
    }));
  }, []);

  // 授权目录内的子文件夹 → 操作目录附件（id 带 sent-folder: 前缀，节点端据此区分颜色/锁定范围）
  const buildFolderAttachment = useCallback((dirPath: string): MessageAttachment => {
    const name = dirPath.split('/').filter(Boolean).pop() || dirPath;
    return {
      id: `sent-folder:${dirPath}`,
      name,
      type: 'folder',
      mimeType: 'application/x-folder',
      size: 0,
      path: dirPath,
    };
  }, []);

  // 添加文件到当前节点附件
  const addToCurrentNode = useCallback(async (filePath: string, isDir = false) => {
    const nodeId = activeNodeIdRef.current;
    if (!nodeId) {
      setError('Please select a node on the canvas first');
      return;
    }
    setError(null);
    // 子文件夹：直接作为操作目录发送（引用路径，无需复制文件）
    if (isDir) {
      sendAttachmentToNode(nodeId, buildFolderAttachment(filePath));
      return;
    }
    try {
      const resp = await fetch('/api/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add_from_local',
          sourcePath: filePath,
          nodeId,
          nodeTitle: 'AI Chat',
        }),
      });
      const data = await resp.json();
      if (data.success) {
        // 通过 CustomEvent 通知 AiChatNode 添加附件
        sendAttachmentToNode(nodeId, data.attachment);
      } else {
        setError(data.error || 'Add failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeNodeIdRef, sendAttachmentToNode, buildFolderAttachment]);

  // 发送到新建节点
  const addToNewNode = useCallback(async (filePath: string, isDir = false) => {
    setCtxMenu(null);
    if (!onCreateNodeWithFile) return;
    const result = await onCreateNodeWithFile(filePath, isDir);
    if (result && result.attachment) {
      // 通过 CustomEvent 通知新创建的 AiChatNode 添加附件（attachment 结构同 MessageAttachment）
      sendAttachmentToNode(result.nodeId, result.attachment as MessageAttachment);
    }
  }, [onCreateNodeWithFile, sendAttachmentToNode]);

  // 重命名
  const handleRename = useCallback(async () => {
    if (!renaming || !renameValue.trim()) return;
    try {
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'rename',
          sourcePath: renaming.filePath,
          newName: renameValue.trim(),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setRenaming(null);
        // 刷新当前视图（目录浏览或搜索结果）
        refreshView();
      } else {
        setError(data.error || 'Rename failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [renaming, renameValue, refreshView]);

  // 复制文件
  const handleCopy = useCallback(async (filePath: string) => {
    setCtxMenu(null);
    try {
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'copy', sourcePath: filePath }),
      });
      const data = await resp.json();
      if (data.success) {
        refreshView();
      } else {
        setError(data.error || 'Copy failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refreshView]);

  // 删除文件
  const handleDelete = useCallback(async (filePath: string, fileName: string) => {
    setCtxMenu(null);
    if (!window.confirm(`Delete "${fileName}"? This cannot be undone.`)) return;
    try {
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', targetPath: filePath }),
      });
      const data = await resp.json();
      if (data.success) {
        refreshView();
      } else {
        setError(data.error || 'Delete failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refreshView]);

  // 可预览判断：复用 viewers/registry 的 isPreviewable，避免白名单双写

  // 用系统默认程序打开
  const handleOpenWithApp = useCallback(async (filePath: string) => {
    setCtxMenu(null);
    await desktop.openFile(filePath);
  }, []);

  // 在当前浏览目录新建空 md 文件（未展开目录时禁用）
  const handleCreateMdFile = useCallback(async () => {
    const dir = browsePath || expandedRoot;
    if (!dir) return;
    try {
      // 生成不重名的文件名：untitled.md / untitled-2.md ...
      const listResp = await fetch(`/api/local-files?path=${encodeURIComponent(dir)}`);
      const listData = await listResp.json();
      const names = new Set((listData.items || []).map((it: { name: string }) => it.name));
      let name = 'untitled.md';
      let counter = 2;
      while (names.has(name)) {
        name = `untitled-${counter}.md`;
        counter++;
      }
      const fullPath = `${dir}/${name}`;
      const writeResp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'write', path: fullPath, content: '' }),
      });
      const writeData = await writeResp.json();
      if (!writeData.success) {
        setError(writeData.error || 'Create file failed');
        return;
      }
      setError(null);
      window.dispatchEvent(new CustomEvent('local-files-changed'));
      // 打开到查看舱编辑（与双击 md 文件行为一致）
      bus.publish(BusEvents.fileOpen, { source: 'local', path: fullPath, name });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create file failed');
    }
  }, [browsePath, expandedRoot]);

  // 在 UnifiedViewer 中打开（发布 file.open 事件，查看舱订阅打开标签）
  const handleOpenInViewer = useCallback((filePath: string, fileName: string) => {
    setCtxMenu(null);
    bus.publish(BusEvents.fileOpen, { source: 'local', path: filePath, name: fileName });
  }, []);

  // 移除目录（从浏览与授权中一并移除）
  const handleRemoveRoot = useCallback(async (rootPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const resp = await fetch(`/api/local-files?action=remove_root&path=${encodeURIComponent(rootPath)}`);
    const data = await resp.json();
    if (data.success) {
      setRoots(data.roots || []);
      setBrowseRoots(data.browseRoots || []);
      window.dispatchEvent(new CustomEvent('local-roots-changed'));
    }
  }, []);

  // 右键菜单（保留作兜底，实际触发已迁移到 MoreVertical 按钮）
  const handleContextMenu = useCallback((e: React.MouseEvent, filePath: string, fileName: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, filePath, fileName, isDir });
  }, []);

  // 三个点按钮打开下拉菜单：以按钮右下角为锚点，避免超出视口边界
  const openActionsMenu = useCallback((btnEl: HTMLElement, filePath: string, fileName: string, isDir: boolean) => {
    const rect = btnEl.getBoundingClientRect();
    setCtxMenu({
      x: rect.right - 180,        // 菜单宽 180px，左对齐按钮左侧 → 贴齐按钮右边但别超出左边界
      y: rect.bottom + 4,         // 按钮下方 4px
      filePath, fileName, isDir,
    });
  }, []);

  // 合并浏览目录与授权目录（去重）
  const allDirs = Array.from(new Set([...browseRoots, ...roots]));

  // 初始化：只加载目录列表（不自动浏览任何目录）
  useEffect(() => {
    loadRoots();
  }, [loadRoots]);

  // 轮询刷新：浏览/搜索视图激活时每 2 秒刷新，感知外部文件变化（AI 工具、编辑器保存、外部程序）
  useEffect(() => {
    if (!expandedRoot && !(searchMode && searchQuery)) return;
    const timer = setInterval(() => { refreshView(); }, 2000);
    return () => clearInterval(timer);
  }, [expandedRoot, searchMode, searchQuery, refreshView]);

  // 目录列表低频轮询：感知授权/浏览目录的外部增删
  useEffect(() => {
    const timer = setInterval(() => { loadRoots(); }, 5000);
    return () => clearInterval(timer);
  }, [loadRoots]);

  // 即时刷新：编辑器保存等本地文件变更后立即刷新当前视图与目录列表
  useEffect(() => {
    const handler = () => { refreshView(); loadRoots(); };
    window.addEventListener('local-files-changed', handler);
    return () => window.removeEventListener('local-files-changed', handler);
  }, [refreshView, loadRoots]);

  // 授权目录变更即时同步：对话框中撤销/授权目录后，本地文件浏览器立即更新
  useEffect(() => {
    const handler = () => { loadRoots(); };
    window.addEventListener('local-roots-changed', handler);
    return () => window.removeEventListener('local-roots-changed', handler);
  }, [loadRoots]);

  // 渲染文件/目录行（搜索结果 + 授权目录展开浏览共用）
  const renderFileItem = (item: FileItem | SearchResult, isSearchResult = false) => {
    const filePath = item.path;
    const fileName = item.name;
    const isDir = item.type === 'directory';
    const src = isSearchResult ? (item as SearchResult).source : undefined;

    return (
      <div
        key={filePath}
        className="group flex items-center gap-2 px-2 py-1.5 rounded transition-colors hover:bg-[var(--paper-hover)] select-none"
        style={{ cursor: isDir ? 'pointer' : 'default' }}
        onClick={(e) => {
          if (isDir) enterDir(filePath);
        }}
        onDoubleClick={(e) => {
          if (isDir) return;
          e.stopPropagation();
          // 可预览的类型优先用 UnifiedViewer 打开；文档类（HTML/PDF/图片）走 file.open 交由 Hippo Browser 打开
          if (isPreviewable(item.extension) || isBrowserDoc(fileName)) {
            handleOpenInViewer(filePath, fileName);
          } else {
            handleOpenWithApp(filePath);
          }
        }}
      >
        {isDir ? (
          <Folder className="h-4 w-4 shrink-0" style={{ color: 'var(--ink-muted)' }} />
        ) : (
          <FileIcon className="h-4 w-4 shrink-0" style={{ color: fileExtColor(item.extension) }} />
        )}

        <FileName
          name={item.name}
          className="flex-1 text-sm"
          style={{ color: isDir ? 'var(--ink-muted)' : 'var(--ink)' }}
        />

        {isSearchResult && src && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium"
            style={{ backgroundColor: `${sourceColor[src]}20`, color: sourceColor[src] }}
          >
            {(item as SearchResult).sourceLabel}
          </span>
        )}

        {!isDir && item.size && (
          <span className="shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>{item.size}</span>
        )}

        {/* 三个点下拉按钮：hover 时可见，点击阻止冒泡 */}
        {(!isDir || expandedRoot) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // 右键菜单里的按钮都是关闭后执行动作，复用同一套菜单即可
              openActionsMenu(e.currentTarget, filePath, fileName, isDir);
            }}
            className="shrink-0 flex h-5 w-5 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink-muted)' }}
            title="More actions"
            aria-label="More actions"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  // 重命名浮层
  if (renaming) {
    return (
      <div className="absolute inset-0 z-50 flex items-start justify-center pt-20" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
        <div className="w-72 rounded-xl p-4 shadow-2xl" style={{ backgroundColor: 'var(--paper)' }}>
          <p className="mb-3 text-sm font-medium" style={{ color: 'var(--ink)', fontFamily: "var(--font-sans)" }}>
            Rename
          </p>
          <input
            ref={renameRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            className="mb-3 w-full rounded-md border px-3 py-2 text-sm outline-none"
            style={{ borderColor: 'var(--input-border)', color: 'var(--ink)' }}
            autoFocus
            onFocus={(e) => {
              // 选中文件名（不含扩展名）
              const dotIdx = renameValue.lastIndexOf('.');
              if (dotIdx > 0) {
                e.target.setSelectionRange(0, dotIdx);
              } else {
                e.target.select();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={() => setRenaming(null)}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="brand"
              size="sm"
              onClick={handleRename}
            >
              Confirm
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <TooltipProvider delayDuration={0}>
    <div
      ref={rootRef}
      className="relative flex h-full flex-col overflow-hidden shrink-0"
      data-canvas-ui="overlay"
      style={{
        width: 258,
        // 2026-09-12 本地文件面板改纯白：与预览面板一致，与灰色画布底 --canvas-bg(#e6e6ec) 拉开对比
        borderRadius: 12,
        border: '1px solid',
        borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)',
        background: '#fff',
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent)',
        WebkitAppRegion: 'no-drag',
        pointerEvents: 'auto',
      } as React.CSSProperties}
      onMouseEnter={handlePanelMouseEnter}
      onMouseLeave={handlePanelMouseLeave}
    >
      {/* 搜索框 + 返回上级 + 添加文件夹 + 打开文件夹 + Pin/Unpin 按钮 */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--line-soft)' }}>
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--ink-muted)' }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder="Search within authorized directories..."
            className="w-full rounded-md py-1.5 pl-7 pr-7 text-xs outline-none transition-colors"
            style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--ink)' }}
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchMode(false); }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {expandedRoot && (
          <Button
            onClick={goUp}
            disabled={!browsePath || browsePath === expandedRoot}
            variant="ghost"
            tone="info"
            size="icon-sm"
            title="Go up"
            aria-label="Go up"
          >
            <CornerUpLeft className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          onClick={handleSelectDirectory}
          variant="ghost"
          tone="info"
          size="icon-sm"
          title="Add folder (browse)"
          aria-label="Add folder"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <Button
          onClick={handleCreateMdFile}
          disabled={!browsePath && !expandedRoot}
          variant="ghost"
          tone="brand"
          size="icon-sm"
          title={browsePath || expandedRoot ? 'Create new Markdown file here' : 'Expand a directory first to create files'}
          aria-label="Create Markdown file"
        >
          <FilePlus className="h-3.5 w-3.5" />
        </Button>
        {onTogglePinned && (
          <button
            onClick={onTogglePinned}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: pinned ? 'var(--primary)' : 'var(--ink-muted)' }}
            title={pinned ? 'Unpin local files' : 'Pin local files'}
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* 活跃节点提示 */}
      <div className="shrink-0 px-3 py-1.5" style={{ borderBottom: '1px solid var(--line-soft)', backgroundColor: 'var(--info-soft)' }}>
        <div className="flex items-center gap-1.5">
          <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: activeNodeIdRef.current ? 'var(--success)' : 'var(--ink-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {activeNodeIdRef.current ? `Current node: ${activeNodeIdRef.current.slice(0, 8)}` : 'Click a node on the canvas first'}
          </span>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="shrink-0 mx-3 mt-2 flex items-start gap-1.5 rounded-md p-2" style={{ backgroundColor: 'var(--danger-soft)' }}>
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" style={{ color: 'var(--danger)' }} />
          <span className="text-xs leading-tight" style={{ color: 'var(--danger)' }}>{error}</span>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {searching || (searchMode && searchQuery) ? (
          <div className="py-2">
            {searching && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--ink-muted)' }} />
              </div>
            )}
            {!searching && searchResults.length === 0 && searchQuery && (
              <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
                No files match &quot;{searchQuery}&quot;
              </div>
            )}
            {!searching && searchResults.length > 0 && (
              <>
                <div className="px-3 py-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>{searchResults.length} result(s)</div>
                {searchResults.map(r => renderFileItem(r, true))}
              </>
            )}
          </div>
        ) : (
          <div className="py-2">
            {allDirs.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
                No directories<br />Click &quot;Add&quot; to choose a folder
              </div>
            ) : (
              <div className="px-3 py-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Added directories ({allDirs.length})
              </div>
            )}
            {allDirs.map(root => {
              const isAuthorized = roots.includes(root);
              const isExpanded = expandedRoot === root;
              return (
                <div key={root}>
                  <div
                    className="group flex items-center gap-2 px-2 py-2 rounded transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleExpand(root)}
                    title={isExpanded ? 'Collapse' : 'Expand directory contents'}
                  >
                    {isExpanded ? (
                      <FolderOpen className="h-4 w-4 shrink-0" style={{ color: 'var(--info)' }} />
                    ) : (
                      <Folder className="h-4 w-4 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-medium" style={{ color: 'var(--ink)' }} title={root.split('/').pop() || root}>{root.split('/').pop() || root}</div>
                    </div>
                    {/* 授权状态按钮：未授权 → 点击授权；已授权 → 点击断开 */}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleAuthorizeClick(root); }}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                      style={{ color: isAuthorized ? 'var(--info)' : 'var(--ink-muted)', opacity: isAuthorized ? 1 : 0.55 }}
                      title={isAuthorized ? 'Authorized: AI can read/write this directory (click to revoke)' : 'Authorize AI for this directory'}
                    >
                      <ShieldCheck className="h-3 w-3" />
                    </button>
                    {/* 三个点：根目录作为 directory 打开菜单，Delete 自动被 disabled 保护 */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openActionsMenu(e.currentTarget, root, root.split('/').pop() || root, true);
                      }}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--paper-hover)]"
                      style={{ color: 'var(--ink-muted)' }}
                      title="More actions"
                      aria-label="More actions"
                    >
                      <MoreVertical className="h-3 w-3" />
                    </button>
                    <Button
                      onClick={(e) => handleRemoveRoot(root, e)}
                      variant="ghost"
                      tone="neutral"
                      size="icon-xs"
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      title="Remove directory"
                      aria-label="Remove directory"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>

                  {/* 展开的目录内容（仅限授权根内导航） */}
                  {isExpanded && (
                    <div className="ml-5 border-l pl-2" style={{ borderColor: 'var(--line-soft)' }}>
                      {loading ? (
                        <div className="flex items-center justify-center py-6">
                          <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--ink-muted)' }} />
                        </div>
                      ) : items.length === 0 ? (
                        <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>Empty folder</div>
                      ) : (
                        items.map(item => renderFileItem(item))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {ctxMenu && (
        <div
          className="fixed z-[100] w-44 overflow-hidden rounded-lg shadow-2xl"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 180),
            top: Math.min(ctxMenu.y, window.innerHeight - 220),
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--line)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 一键发送到附件 / 操作目录 */}
          <div className="px-2 pt-2 pb-1">
            <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              {ctxMenu.isDir ? 'Send as working directory' : 'Attach'}
            </span>
          </div>
          <button
            onClick={() => { setCtxMenu(null); addToCurrentNode(ctxMenu.filePath, ctxMenu.isDir); }}
            disabled={!activeNodeIdRef.current}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            style={{ color: activeNodeIdRef.current ? 'var(--ink)' : 'var(--ink-muted)' }}
            title={activeNodeIdRef.current ? undefined : 'No node selected — click a node on the canvas first'}
          >
            <ArrowUpCircle className="h-3.5 w-3.5" style={{ color: activeNodeIdRef.current ? 'var(--primary)' : 'var(--ink-muted)' }} />
            <span className="flex-1">Send to current node</span>
            {!activeNodeIdRef.current && (
              <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>No node</span>
            )}
          </button>
          <button
            onClick={() => addToNewNode(ctxMenu.filePath, ctxMenu.isDir)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
          >
            <PlusCircle className="h-3.5 w-3.5" style={{ color: 'var(--info)' }} />
            Send to new node
          </button>

          <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--line-soft)' }} />

          {/* 打开文件/文件夹 */}
          <div className="px-2 pt-1 pb-1">
            <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Open</span>
          </div>
          {(() => {
            const ctxExt = ctxMenu.fileName.split('.').pop() || '';
            const canPreview = isPreviewable(ctxExt) || isBrowserDoc(ctxMenu.fileName);
            return (
              <>
                {!ctxMenu.isDir && (
                  <button
                    onClick={() => handleOpenInViewer(ctxMenu.filePath, ctxMenu.fileName)}
                    disabled={!canPreview}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ color: 'var(--ink)' }}
                  >
                    <Eye className="h-3.5 w-3.5" style={{ color: 'var(--info)' }} />
                    Open in viewer
                  </button>
                )}
                <button
                  onClick={() => handleOpenWithApp(ctxMenu.filePath)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink)' }}
                >
                  <ExternalLink className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
                  Open with system app
                </button>
                <button
                  onClick={() => {
                    setCtxMenu(null);
                    void desktop.showItemInFolder(ctxMenu.filePath);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink)' }}
                  title="在系统文件管理器中显示并选中该文件"
                >
                  <Folder className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
                  Reveal in Finder
                </button>
              </>
            );
          })()}

          <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--line-soft)' }} />

          {/* 重命名 */}
          <button
            onClick={() => {
              setCtxMenu(null);
              setRenaming({ filePath: ctxMenu.filePath, oldName: ctxMenu.fileName });
              setRenameValue(ctxMenu.fileName);
              setTimeout(() => renameRef.current?.focus(), 50);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
          >
            <Pencil className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            Rename
          </button>

          {/* 复制 / 删除：文件和子文件夹都支持；根目录本身受保护不可删除（走独立的 Remove directory 按钮） */}
          <button
            onClick={() => handleCopy(ctxMenu.filePath)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
          >
            <Copy className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            Copy
          </button>
          <button
            onClick={() => handleDelete(ctxMenu.filePath, ctxMenu.fileName)}
            disabled={allDirs.includes(ctxMenu.filePath)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            style={{ color: allDirs.includes(ctxMenu.filePath) ? 'var(--ink-muted)' : 'var(--danger)' }}
            title={allDirs.includes(ctxMenu.filePath) ? 'Root directories cannot be deleted here — use the Remove button on the directory header' : undefined}
          >
            <Trash className="h-3.5 w-3.5" style={{ color: allDirs.includes(ctxMenu.filePath) ? 'var(--ink-muted)' : 'var(--danger)' }} />
            Delete
          </button>
        </div>
      )}
    </div>
    </TooltipProvider>
    {/* 授权确认弹窗：portal 到 body（画布容器外），不替换/卸载面板，避免侧边栏自动收起 */}
    {authorizePendingPath && createPortal(
      <div
        ref={authModalRef}
        data-canvas-ui="overlay"
        className="fixed inset-0 flex items-start justify-center pt-20"
        style={{ backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 9999 }}
      >
        <div className="w-80 rounded-xl p-4 shadow-2xl" style={{ backgroundColor: 'var(--paper)' }}>
          <p className="mb-1 text-sm font-medium" style={{ color: 'var(--ink)', fontFamily: "var(--font-sans)" }}>
            Authorize this directory for AI?
          </p>
          <p className="mb-2 break-all text-xs" style={{ color: 'var(--ink-muted)' }} title={authorizePendingPath}>
            {authorizePendingPath}
          </p>
          <p className="mb-4 text-xs leading-relaxed" style={{ color: 'var(--ink)' }}>
            After authorization, the AI assistant can read and modify files in this directory (create, edit, rename, delete). Applies to AI tools only.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={cancelAuthorize}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="brand"
              size="sm"
              onClick={confirmAuthorize}
            >
              Authorize
            </Button>
          </div>
        </div>
      </div>,
      document.body,
    )}
    </>
  );
}
