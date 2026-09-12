'use client';

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Folder,
  FolderOpen,
  Plus,
  Trash,
  RefreshCw,
  FileText,
  FolderPlus,
  Upload,
  FolderUp,
  Shield,
  ShieldCheck,
  ArrowUpCircle,
  PlusCircle,
  Pencil,
  ExternalLink,
  StickyNote,
  X,
  Star,
  MoreHorizontal,
  MoreVertical,
  Copy,
  ChevronDown,
} from 'lucide-react';
import { WantedNoticeCenter } from './WantedNoticeCenter';
import { SkillManagerModal } from './SkillManagerModal';
import { TrashDialog } from './TrashDialog';
import { ProjectActivityLog } from './ProjectActivityLog';
import { bus, BusEvents } from '@/lib/bus';
import { desktop, isDesktop } from '@/lib/desktop-adapter';
import { loadSettings, applyCustomTheme, applyFontScale } from '@/lib/settings';
import type { MessageAttachment } from '@/lib/types';
import { PROJECT_CATEGORIES, PROJECT_TAG_LIMIT, PROJECT_NOTE_MAX } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { FileName } from './FileName';

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_accessed_at: string;
  hidden?: boolean;
  archived?: boolean;
  archived_at?: string;
  /** 项目分类（诉讼 / 常法 / 非诉 / 破产），创建时选择 */
  category?: string;
  /** 自定义标签（最多 PROJECT_TAG_LIMIT 个），显示在项目标题右侧 */
  tags?: string[];
  /** 项目备注（上限 PROJECT_NOTE_MAX 字符） */
  note?: string;
}

interface FileNode {
  name: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  extension?: string;
  /** 相对项目根的真实路径（如 homework/template/template-fill 运行目录 set_000 下的 xx.docx）；
   *  template 解压目录摊平展示时，名称链不再含中间目录，需据此解析真实路径 */
  rel?: string;
  /** 会话标题（attachments/ 下节点附件目录：后端按 node 短 id 关联 notes-memory 填充） */
  title?: string;
}

/** homework/ 按 kind 类别分组的输出文件（来自 list_files 的 homework_kind_groups） */
interface HomeworkKindGroup {
  kind: string; // doc|sheet|slide|pdf|image|text|code|other
  label: string; // 英文展示标签（Documents/Spreadsheets/...）
  files: { name: string; extension?: string; path: string; source?: 'project' | 'local' }[];
}

// 文件树层级缩进：每级 6px、封顶 3 级；多级文件夹通过缩进表达层级（无圆点/竖线装饰）
const LEVEL_INDENT_STEP = 6; // 每级缩进 px
const LEVEL_INDENT_CAP = 3; // 缩进封顶级数（更深层级不再右移）
/** 层级缩进（封顶） */
const levelIndent = (level: number) => Math.min(Math.max(level, 0), LEVEL_INDENT_CAP) * LEVEL_INDENT_STEP;
/** Workspace 浮层最小宽度（保证 Finder 列式浏览可读） */
const WORKSPACE_MIN_WIDTH = 560;

interface SidebarProps {
  onOpenSettings: () => void;
  onOpenCalendar: () => void;
  projectId: string;
  /** 折叠状态变化通知（父级据此调整顶部拖拽区让出按钮区域；rail 已移除恒为折叠态） */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** 发送文件到新建节点（由 CanvasFlow 提供，复用 LocalFileExplorer 的逻辑） */
  onCreateNodeWithFile?: (filePath: string, isDir: boolean) => Promise<{ nodeId: string; attachment: unknown } | null>;
}

/** 文件图标映射：已知格式按映射显示，其余按真实扩展名显示（无扩展名兜底 FILE） */
function fileIcon(ext?: string): { color: string; label: string } {
  const e = ext ?? '';
  switch (e.toLowerCase()) {
    case '.md':
    case '.markdown': return { color: 'oklch(0.55 0.15 45)', label: 'MD' };
    case '.json': return { color: 'oklch(0.50 0.12 200)', label: '{}' };
    case '.ts':
    case '.tsx': return { color: 'oklch(0.50 0.15 240)', label: 'TS' };
    case '.js':
    case '.jsx': return { color: 'oklch(0.55 0.15 60)', label: 'JS' };
    case '.py': return { color: 'oklch(0.55 0.15 180)', label: 'PY' };
    case '.css': return { color: 'oklch(0.55 0.15 300)', label: 'CSS' };
    case '.db': return { color: 'oklch(0.45 0.05 150)', label: 'DB' };
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.bmp':
    case '.heic': return { color: 'oklch(0.55 0.15 330)', label: 'IMG' };
    // 常见文档 / 数据 / 脚本格式：真实格式标签
    case '.txt': return { color: 'oklch(0.50 0.02 60)', label: 'TXT' };
    case '.html':
    case '.htm': return { color: 'oklch(0.55 0.16 35)', label: 'HTML' };
    case '.pdf': return { color: 'oklch(0.55 0.16 25)', label: 'PDF' };
    case '.doc':
    case '.docx': return { color: 'oklch(0.52 0.12 240)', label: 'DOC' };
    case '.xls':
    case '.xlsx': return { color: 'oklch(0.52 0.12 155)', label: 'XLS' };
    case '.ppt':
    case '.pptx': return { color: 'oklch(0.55 0.14 60)', label: 'PPT' };
    case '.csv': return { color: 'oklch(0.52 0.12 155)', label: 'CSV' };
    case '.svg': return { color: 'oklch(0.52 0.14 300)', label: 'SVG' };
    case '.yaml':
    case '.yml': return { color: 'oklch(0.52 0.10 195)', label: 'YAML' };
    case '.sh':
    case '.bash':
    case '.zsh': return { color: 'oklch(0.52 0.12 165)', label: 'SH' };
    case '.go': return { color: 'oklch(0.52 0.12 220)', label: 'GO' };
    case '.rs': return { color: 'oklch(0.55 0.14 55)', label: 'RS' };
    case '.java': return { color: 'oklch(0.55 0.14 40)', label: 'JAVA' };
    case '.sql': return { color: 'oklch(0.50 0.12 250)', label: 'SQL' };
    case '.xml': return { color: 'oklch(0.50 0.08 260)', label: 'XML' };
    case '.log': return { color: 'oklch(0.50 0.02 60)', label: 'LOG' };
    default: {
      // 未知格式：按真实扩展名大写显示（如 .vue → VUE、.less → LESS），无扩展名兜底 FILE
      const name = e.replace(/^\./, '');
      if (!name) return { color: 'oklch(0.50 0.02 60)', label: 'FILE' };
      const label = name.toUpperCase();
      return { color: 'oklch(0.50 0.05 70)', label: label.length > 5 ? label.slice(0, 5) : label };
    }
  }
}

export function Sidebar({ onOpenCalendar, projectId, onCollapsedChange, onCreateNodeWithFile }: SidebarProps) {
  // 侧边栏仅保留浮层渲染（rail 视觉条已迁至 ⌘F 面板底部图标栏，2026-09-01）：
  // Workspace → 可拖动浮层（项目列表 + 文件树）
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  // 浮层位置（初始贴左缘；拖动标题栏可移动，会话内记忆）
  const [wsPos, setWsPos] = useState<{ x: number; y: number }>({ x: 52, y: 96 });
  // 浮层宽度（右缘拖动调宽，会话内记忆）
  const [wsWidth, setWsWidth] = useState(700);
  // 浮层视图：files=文件树（Finder 列式）/ log=项目流水账
  const [wsView, setWsView] = useState<'files' | 'log'>('files');
  // 流水账刷新信号（项目内文件变更时自增，触发日志面板重新拉取）
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  // 拖动/调宽期间读取最新值用 ref 镜像（避免重建事件监听）
  const wsPosRef = useRef(wsPos);
  useEffect(() => {
    wsPosRef.current = wsPos;
  }, [wsPos]);
  const wsWidthRef = useRef(wsWidth);
  useEffect(() => {
    wsWidthRef.current = wsWidth;
  }, [wsWidth]);
  // 右栏 Finder 列式浏览路径（openPath[i] = 第 i 层选中的目录名）
  const [wsOpenPath, setWsOpenPath] = useState<string[]>([]);
  // 无 rail 视觉条：通知父级布局按"折叠态"处理（NodeMap / 预览面板偏移保持折叠值）
  useEffect(() => {
    onCollapsedChange?.(true);
  }, [onCollapsedChange]);
  // 点击浮层外部 → 关闭
  useEffect(() => {
    if (!workspaceOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && t.nodeType === 1) {
        const el = t as Element;
        if (el.closest('[data-bob-sidebar-popover]')) return; // 浮层内部点击不关闭
        if (el.closest('[data-bob-sidebar-rail]')) return; // rail 按钮（重新点击切换）不关闭
        if (el.closest('[data-material-menu]')) return; // materials 操作菜单同样 portal 到 body：点击菜单项不关闭浮层
        if (el.closest('[data-ws-switch]')) return; // 标题栏项目切换下拉 portal 到 body：点击项不关闭浮层
        if (el.closest('[data-row-menu], [data-ws-rename]')) return; // 文件行 ⋮ 菜单 / 重命名弹窗：点击不关闭浮层
      }
      setWorkspaceOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [workspaceOpen]);

  // 事件桥接：⌘F 面板底部图标栏触发 Sidebar 内部面板（rail 已移除，2026-09-01）
  useEffect(() => {
    const onWorkspaceToggle = () => setWorkspaceOpen((v) => !v);
    const onCreateProject = () => setCreateDialogOpen(true);
    const onTrashOpen = () => setTrashOpen(true);
    window.addEventListener('workspace-toggle', onWorkspaceToggle);
    window.addEventListener('create-project-open', onCreateProject);
    window.addEventListener('trash-open', onTrashOpen);
    return () => {
      window.removeEventListener('workspace-toggle', onWorkspaceToggle);
      window.removeEventListener('create-project-open', onCreateProject);
      window.removeEventListener('trash-open', onTrashOpen);
    };
  }, []);

  // 浮层拖动：标题栏按下（非按钮）→ pointermove 更新位置，pointerup 结束
  const startDrag = useCallback((e: React.PointerEvent) => {
    if ((e.target as Element).closest('button')) return; // 标题栏上的按钮（切换/关闭等）不触发拖动
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = wsPos;
    const move = (ev: PointerEvent) => {
      const nx = Math.max(0, base.x + ev.clientX - startX);
      const ny = Math.max(8, base.y + ev.clientY - startY);
      setWsPos({ x: nx, y: ny });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [wsPos]);

  // 浮层宽度调整：拖动右缘调宽（会话内记忆，不随拖移位置而复位）
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wsWidthRef.current;
    const move = (ev: PointerEvent) => {
      const maxW = Math.max(WORKSPACE_MIN_WIDTH, window.innerWidth - wsPosRef.current.x - 16);
      const nw = Math.min(Math.max(startW + ev.clientX - startX, WORKSPACE_MIN_WIDTH), maxW);
      setWsWidth(nw);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  // BobMail 受控状态：入口图标统一在 ⌘F 面板底部图标栏，弹层由 WantedNoticeCenter 受控渲染
  const [wantedOpen, setWantedOpen] = useState(false);
  const [wantedAnchor, setWantedAnchor] = useState<DOMRect | null>(null);
  const [wantedPending, setWantedPending] = useState(0);
  const handleWantedClick = useCallback((anchorRect?: DOMRect | null) => {
    setWantedAnchor(anchorRect ?? null);
    setWantedOpen((prev) => !prev);
  }, []);

  // BobMail 跨组件入口：Sidebar WANTED 图标唤起弹层（bobmail-toggle，携带点击图标 rect 作锚点），
  // 并同步未读数（bobmail-pending 广播 / bobmail-pending-request 拉取），保证两处入口角标一致。
  useEffect(() => {
    const onToggle = (e: Event) => {
      const detail = (e as CustomEvent).detail as { anchor?: DOMRect | null } | undefined;
      handleWantedClick(detail?.anchor ?? null);
    };
    const onPendingRequest = () => {
      window.dispatchEvent(new CustomEvent('bobmail-pending', { detail: { pending: wantedPending } }));
    };
    window.addEventListener('bobmail-toggle', onToggle);
    window.addEventListener('bobmail-pending-request', onPendingRequest);
    return () => {
      window.removeEventListener('bobmail-toggle', onToggle);
      window.removeEventListener('bobmail-pending-request', onPendingRequest);
    };
  }, [handleWantedClick, wantedPending]);
  useEffect(() => {
    // 未读数变化时主动广播（含挂载初始值），Sidebar BobMail 角标即时同步
    window.dispatchEvent(new CustomEvent('bobmail-pending', { detail: { pending: wantedPending } }));
  }, [wantedPending]);

  // Skill Store（独立市场面板）：⌘F 面板图标栏 skill-store-open 唤起，本组件受控渲染 Dialog
  const [skillStoreOpen, setSkillStoreOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setSkillStoreOpen(true);
    window.addEventListener('skill-store-open', onOpen);
    return () => window.removeEventListener('skill-store-open', onOpen);
  }, []);

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  // 切换当前项目后，右栏 Finder 列式浏览回到根列
  useEffect(() => {
    setWsOpenPath([]);
  }, [currentId]);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectCategory, setNewProjectCategory] = useState('');
  const [newProjectNote, setNewProjectNote] = useState('');
  // 新建项目：两个独立标签输入框（最多 2 个）
  const [newProjectTag1, setNewProjectTag1] = useState('');
  const [newProjectTag2, setNewProjectTag2] = useState('');
  const [creating, setCreating] = useState(false);
  // 编辑分类/标签/备注弹窗（⋮ 菜单入口）
  const [editMetaProject, setEditMetaProject] = useState<ProjectInfo | null>(null);
  const [editMetaCategory, setEditMetaCategory] = useState('');
  const [editMetaTags, setEditMetaTags] = useState<string[]>(['', '']);
  const [editMetaNote, setEditMetaNote] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  // 更新状态（常驻提示迁移至 NodeMap：Sidebar 保留逻辑，广播 update-status-changed 事件）
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'no-update' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = useState<string>('');
  const [updateProgress, setUpdateProgress] = useState<number>(0);
  const [updateError, setUpdateError] = useState<string>('');
  const [installProgress, setInstallProgress] = useState<{ stage: string; message: string; percent?: number } | null>(null);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Materials 相关状态（上传/新建共用）
  const [newFolderParent, setNewFolderParent] = useState<string>('');
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [uploadTargetFolder, setUploadTargetFolder] = useState<string>('');
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadFolderInputRef = useRef<HTMLInputElement>(null);

  // 右键菜单状态（文件树）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filePath: string; fileName: string; isDir: boolean } | null>(null);
  // 列式浏览行 ⋮ 菜单状态（重命名 / 复制 / 删除）；rel 为项目相对路径，用于区分 homework / materials
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; filePath: string; fileName: string; isDir: boolean; rel: string } | null>(null);
  // 重命名状态
  const [renaming, setRenaming] = useState<{ filePath: string; oldName: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  // 当前激活节点 ID（用于"发送到当前节点"）
  const activeNodeIdRef = useRef<string | null>(null);
  // 关闭右键菜单（点击任意位置）
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [ctxMenu]);
  // 关闭行 ⋮ 菜单（点击任意位置）
  useEffect(() => {
    if (!rowMenu) return;
    const close = () => setRowMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [rowMenu]);

  // 发送附件到指定节点（复用 LocalFileExplorer 的事件机制）
  const sendAttachmentToNode = useCallback((nodeId: string, attachment: MessageAttachment) => {
    window.dispatchEvent(new CustomEvent('add-attachment-to-node', {
      detail: { node_id: nodeId, attachment },
    }));
  }, []);

  // 发送文件到当前节点
  const addToCurrentNode = useCallback(async (filePath: string, isDir: boolean) => {
    const nodeId = activeNodeIdRef.current;
    if (!nodeId) return;
    if (isDir) {
      const name = filePath.split('/').filter(Boolean).pop() || filePath;
      sendAttachmentToNode(nodeId, {
        id: `sent-folder:${filePath}`,
        name,
        type: 'folder',
        mimeType: 'application/x-folder',
        size: 0,
        path: filePath,
      } as MessageAttachment);
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
        sendAttachmentToNode(nodeId, data.attachment as MessageAttachment);
      }
    } catch { /* ignore */ }
  }, [sendAttachmentToNode]);

  // 发送文件到新建节点
  const addToNewNode = useCallback(async (filePath: string, isDir: boolean) => {
    setCtxMenu(null);
    if (!onCreateNodeWithFile) return;
    const result = await onCreateNodeWithFile(filePath, isDir);
    if (result && result.attachment) {
      sendAttachmentToNode(result.nodeId, result.attachment as MessageAttachment);
    }
  }, [onCreateNodeWithFile, sendAttachmentToNode]);

  // 重命名文件/文件夹
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
        if (currentId) loadProjectFilesRef.current?.(currentId);
      }
    } catch { /* ignore */ }
  }, [renaming, renameValue, currentId]);

  // 删除文件/文件夹
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
        if (currentId) loadProjectFilesRef.current?.(currentId);
      }
    } catch { /* ignore */ }
  }, [currentId]);

  // loadProjectFiles ref（解决定义顺序问题）
  const loadProjectFilesRef = useRef<((pid: string) => Promise<void>) | null>(null);
  // 项目列表是否已首次加载（首次自动展开当前项目；后续 focus/切换刷新不重置用户展开状态）
  const projectsLoadedRef = useRef(false);

  // materials 目录授权状态（复用 .local-roots.json 授权机制：授权后 AI 可读写 + @ 引用联动）
  const [localRoots, setLocalRoots] = useState<string[]>([]);
  const loadLocalRoots = useCallback(async () => {
    try {
      const resp = await fetch('/api/local-files?action=roots');
      const data = await resp.json();
      if (data.success) setLocalRoots(data.roots || []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    loadLocalRoots();
    const handler = () => loadLocalRoots();
    window.addEventListener('local-roots-changed', handler);
    return () => window.removeEventListener('local-roots-changed', handler);
  }, [loadLocalRoots]);

  /** 判断指定项目的 materials 目录是否已授权 AI 读写 */
  const isMaterialsAuthed = useCallback((projId: string): boolean => {
    const project = projects.find((p) => p.id === projId);
    if (!project) return false;
    return localRoots.includes(`${project.path}/materials`);
  }, [projects, localRoots]);

  /** 授权/取消授权 materials 目录（授权后 AI 可用文件工具读写） */
  const toggleMaterialsAuth = useCallback(async (projId: string) => {
    const project = projects.find((p) => p.id === projId);
    if (!project) return;
    const materialsPath = `${project.path}/materials`;
    const action = isMaterialsAuthed(projId) ? 'revoke_root' : 'authorize_root';
    try {
      const resp = await fetch(`/api/local-files?action=${action}&path=${encodeURIComponent(materialsPath)}`);
      const data = await resp.json();
      if (data.success) {
        setLocalRoots(data.roots || []);
        window.dispatchEvent(new CustomEvent('local-roots-changed'));
      }
    } catch { /* ignore */ }
  }, [projects, isMaterialsAuthed]);



  // 监听更新事件
  useEffect(() => {
    if (!isDesktop()) return;
    const unsubscribe: Array<() => void> = [];

    // 兜底看门狗：进入 downloading 后若 3 分钟无任何下载进度/完成/错误事件，
    // 自动回到 available（重新显示下载按钮），防止下载链路异常时 UI 永久转圈
    const armDownloadWatchdog = () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      updateTimerRef.current = setTimeout(() => {
        setUpdateStatus((s) => (s === 'downloading' ? 'available' : s));
      }, 3 * 60 * 1000);
    };

    unsubscribe.push(desktop.update.onChecking((info) => {
      // 自动检查不显示 spinner，仅手动检查显示；但如果我们已经手动 set 了 checking，则保留
      if (!info?.manual && updateStatus !== 'checking') return;
      setUpdateStatus('checking');
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      // 15 秒超时（含网络往返）自动恢复，防状态卡死
      updateTimerRef.current = setTimeout(() => {
        setUpdateStatus('idle');
      }, 15000);
    }));

    unsubscribe.push(desktop.update.onAvailable((info) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      setUpdateVersion(info.version);
      // available：发现新版本，进入短暂 available 状态显示【下载 vX.X.X】按钮
      // 下载器自动开始下载后触发 download-progress 转为 downloading。
      // 如果 2s 后还没 progress，也自动转 downloading（并启动兜底看门狗防永久转圈）
      setUpdateStatus('available');
      updateTimerRef.current = setTimeout(() => {
        setUpdateStatus((s) => {
          if (s !== 'available') return s;
          armDownloadWatchdog();
          return 'downloading';
        });
      }, 2000);
    }));

    unsubscribe.push(desktop.update.onNotAvailable((info) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      if (info?.manual) {
        setUpdateStatus('no-update');
        setTimeout(() => setUpdateStatus('idle'), 3000);
      } else {
        setUpdateStatus('idle');
      }
    }));

    unsubscribe.push(desktop.update.onDownloadProgress((p) => {
      setUpdateStatus('downloading');
      setUpdateProgress(p.percent);
      // 每次进度事件重置看门狗：正常下载会持续有进度，不会误触发
      armDownloadWatchdog();
    }));

    unsubscribe.push(desktop.update.onDownloaded((info) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      if (info?.version) setUpdateVersion(info.version);
      setUpdateStatus('downloaded');
    }));

    // 安装进度（extracting/copying/launching），用于点击 Install 后显示真实安装阶段
    unsubscribe.push(desktop.update.onInstallProgress((p) => {
      setInstallProgress(p);
    }));

    unsubscribe.push(desktop.update.onError((info) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      // 自动检查的错误静默忽略
      if (!info?.manual) {
        setUpdateStatus('idle');
        return;
      }
      setUpdateError(info.message || 'Update check failed');
      setUpdateStatus('error');
      setTimeout(() => {
        setUpdateStatus('idle');
        setUpdateError('');
      }, 5000);
    }));

    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      unsubscribe.forEach(fn => fn());
    };
  }, []);

  // 更新状态广播给 NodeMap 常驻提示；并监听 NodeMap 发出的更新动作（check/download/install/retry）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('update-status-changed', {
      detail: { status: updateStatus, version: updateVersion, progress: updateProgress, error: updateError, install: installProgress },
    }));
  }, [updateStatus, updateVersion, updateProgress, updateError, installProgress]);
  useEffect(() => {
    const onAction = (e: Event) => {
      const d = (e as CustomEvent).detail as { action?: string } | undefined;
      if (d?.action === 'check') {
        desktop.update.check().catch(() => {});
      } else if (d?.action === 'download') {
        if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
        setUpdateStatus('downloading');
      } else if (d?.action === 'install') {
        if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
        setUpdateStatus('installing');
        setInstallProgress(null);
        setUpdateError('Installing…');
        setTimeout(() => {
          desktop.update.install().then((r) => {
            if (r && !r.success) {
              if ((r as { cancelled?: boolean }).cancelled) {
                setUpdateStatus('downloaded'); setUpdateError(''); setInstallProgress(null); return;
              }
              setUpdateError((r as { error?: string }).error || 'Install failed');
              setUpdateStatus('error');
              setTimeout(() => { setUpdateStatus('downloaded'); setUpdateError(''); setInstallProgress(null); }, 5000);
            }
          }).catch((err) => {
            setUpdateError(err?.message || String(err) || 'Install failed');
            setUpdateStatus('error');
            setTimeout(() => { setUpdateStatus('downloaded'); setUpdateError(''); setInstallProgress(null); }, 5000);
          });
        }, 200);
      }
    };
    window.addEventListener('update-action', onAction);
    return () => window.removeEventListener('update-action', onAction);
  }, []);

  // 应用全局主题：启动时加载，设置保存（provider-configs-changed）或 AI 工具写盘（app-config-changed）后刷新
  useEffect(() => {
    const apply = async () => {
      try {
        const s = await loadSettings();
        applyCustomTheme(s);
        applyFontScale(s.fontScale);
      } catch { /* 读取失败时保持默认主题 */ }
    };
    apply();
    const handler = () => apply();
    window.addEventListener('provider-configs-changed', handler);
    window.addEventListener('app-config-changed', handler);
    return () => {
      window.removeEventListener('provider-configs-changed', handler);
      window.removeEventListener('app-config-changed', handler);
    };
  }, []);

  // 微信绑定弹窗已改为 SettingsModal 右侧面板内嵌显示，不再通过 open-wechat-bind 事件打开

  // 文件树相关状态
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [projectFiles, setProjectFiles] = useState<Map<string, FileNode[]>>(new Map());
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  // homework 按 kind 类别分组的输出文件，key 为项目 id
  const [homeworkGroups, setHomeworkGroups] = useState<Map<string, HomeworkKindGroup[]>>(new Map());
  // 类别分组展开状态；key 为 `${projId}:${kind}`。
  // 默认展开：首次收到某项目的类别分组时全部展开，之后尊重用户手动折叠（见 loadProjectFiles）
  const [homeworkOpenGroups, setHomeworkOpenGroups] = useState<Set<string>>(new Set());
  // 已执行过"默认展开"的项目 id（防止后续刷新/重开浮层覆盖用户手动折叠状态）
  const defaultHomeworkExpandedRef = useRef<Set<string>>(new Set());

  // 项目标星（localStorage 持久化，仅前端；置顶分组展示在 Workspace 浮层顶部）
  const [starredProjects, setStarredProjects] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('bobwork.starred-projects');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem('bobwork.starred-projects', JSON.stringify([...starredProjects])); } catch { /* ignore */ }
  }, [starredProjects]);
  const toggleProjectStar = useCallback((pid: string) => {
    setStarredProjects((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const resp = await fetch('/api/projects');
      const data = await resp.json();
      if (data.success) {
        setProjects((data.active_projects || data.projects || []).filter((p: ProjectInfo) => !p.hidden));
        setCurrentId(data.current_id);
        // 首次加载才自动展开当前项目文件树；刷新（focus/切换）不重置用户手动展开状态
        if (!projectsLoadedRef.current && data.current_id) {
          projectsLoadedRef.current = true;
          setExpandedProjects(new Set([data.current_id]));
          loadProjectFilesRef.current?.(data.current_id);
        }
      }
    } catch (err) {
      console.error('加载项目列表失败:', err);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // 窗口重新聚焦时自动刷新项目列表：外部/其他入口新增或变更项目（写 config）后，
  // 切回 BobWork 窗口即可看到最新列表（项目列表无轮询/目录监听，挂载时只加载一次）
  useEffect(() => {
    const onFocus = () => loadProjects();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadProjects]);

  // 监听项目切换事件：无刷新切换后同步项目列表（高亮/展开状态保持一致）
  useEffect(() => {
    const onSwitched = () => loadProjects();
    window.addEventListener('bobagent:project-switched', onSwitched);
    return () => window.removeEventListener('bobagent:project-switched', onSwitched);
  }, [loadProjects]);

  // 后端 watcher：工作区目录/项目内文件变更实时推送（SSE）
  //  - projects-changed：项目列表增删 → 刷新项目列表
  //  - files-changed：项目内文件可见变更 → Workspace 浮层打开时刷新已展开项目的文件树
  // workspaceOpen / expandedProjects 用 ref 镜像：回调读取最新值，同时避免重建 EventSource
  const workspaceOpenRef = useRef(workspaceOpen);
  useEffect(() => {
    workspaceOpenRef.current = workspaceOpen;
  }, [workspaceOpen]);
  const expandedProjectsRef = useRef(expandedProjects);
  useEffect(() => {
    expandedProjectsRef.current = expandedProjects;
  }, [expandedProjects]);
  useEffect(() => {
    const es = new EventSource('/api/projects/events');
    const onChanged = () => loadProjects();
    const onFilesChanged = () => {
      if (!workspaceOpenRef.current) return; // 浮层关闭时无需刷新（重开时另有刷新兜底）
      setLogRefreshKey((k) => k + 1);
      for (const pid of expandedProjectsRef.current) {
        loadProjectFiles(pid);
      }
    };
    es.addEventListener('projects-changed', onChanged);
    es.addEventListener('files-changed', onFilesChanged);
    return () => {
      es.removeEventListener('projects-changed', onChanged);
      es.removeEventListener('files-changed', onFilesChanged);
      es.close();
    };
  }, [loadProjects]);

  // Workspace 浮层打开时刷新当前项目文件树：关闭期间不接收 files-changed 推送，重开需拉取最新列表；
  // 当前项目在右栏文件树恒为展开态，同时加入 expandedProjects 使其进入 SSE 文件变更刷新集合
  useEffect(() => {
    if (workspaceOpen && currentId) {
      setExpandedProjects((prev) => (prev.has(currentId) ? prev : new Set(prev).add(currentId)));
      loadProjectFiles(currentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceOpen]);

  // 打开 Workspace 且尚未下钻时：自动展开根列第一个目录（文件树加载完成后触发一次）
  useEffect(() => {
    if (!workspaceOpen || !currentId) return;
    const roots = projectFiles.get(currentId) || [];
    if (roots.length === 0) return;
    if (wsOpenPath.length > 0) return; // 已下钻/用户已操作则不干预
    const firstDir = roots.find((r) => r.type === 'directory');
    if (!firstDir) return;
    setWsOpenPath([firstDir.name]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceOpen, projectFiles, currentId]);

  // 监听 AI 工具文件变更，自动刷新文件树
  useEffect(() => {
    const handler = () => {
      // 为所有已展开的项目刷新文件树
      for (const pid of expandedProjects) {
        loadProjectFiles(pid);
      }
      setLogRefreshKey((k) => k + 1);
    };
    window.addEventListener('project-files-changed', handler);
    return () => window.removeEventListener('project-files-changed', handler);
  }, [expandedProjects]);

  const handleSwitch = useCallback(
    async (projectId: string) => {
      if (projectId === currentId) return;
      try {
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'switch', project_id: projectId }),
        });
        const data = await resp.json();
        if (data.success) {
          // 无刷新切换：更新本地选中态 + 清空旧展开 + 加载新项目文件树 + 广播事件，
          // 由 CanvasFlow 监听后重载画布数据（替代 window.location.reload()，避免整页白屏闪烁）
          setCurrentId(projectId);
          // 选中项目自动展开文件树（清空其他项目展开态）
          setExpandedProjects(new Set([projectId]));
          setExpandedFolders(new Set());
          loadProjectFilesRef.current?.(projectId);
          window.dispatchEvent(new CustomEvent('bobagent:project-switched', { detail: { projectId } }));
        }
      } catch (err) {
        console.error('切换项目失败:', err);
      }
    },
    [currentId],
  );

  const handleCreate = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name,
          category: newProjectCategory || undefined,
          note: newProjectNote.trim() || undefined,
          tags: [newProjectTag1, newProjectTag2].map((t) => t.trim()).filter(Boolean).slice(0, PROJECT_TAG_LIMIT),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setCreateDialogOpen(false);
        setNewProjectName('');
        setNewProjectCategory('');
        setNewProjectNote('');
        setNewProjectTag1('');
        setNewProjectTag2('');
        // 无刷新直达新项目（复用切换流程，广播 bobagent:project-switched 由 CanvasFlow 重载画布）。
        // 不再 window.location.reload()，避免触发启动自动打开项目看板（"跳到项目面板"）。
        await handleSwitch(data.project.id);
      } else {
        alert(data.error || 'Failed to create project');
      }
    } catch (err) {
      console.error('Failed to create project:', err);
      alert('Failed to create project');
    } finally {
      setCreating(false);
    }
  }, [newProjectName, newProjectCategory, newProjectNote, newProjectTag1, newProjectTag2, handleSwitch]);

  // 打开编辑分类/标签/备注弹窗
  const openEditMeta = useCallback((p: ProjectInfo) => {
    setEditMetaProject(p);
    setEditMetaCategory(p.category || '');
    setEditMetaTags([p.tags?.[0] || '', p.tags?.[1] || '']);
    setEditMetaNote(p.note || '');
  }, []);

  // 保存分类/标签/备注（POST /api/projects action=update_meta，无需整页刷新）
  const handleSaveProjectMeta = useCallback(async () => {
    if (!editMetaProject) return;
    setSavingMeta(true);
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_meta',
          project_id: editMetaProject.id,
          category: editMetaCategory || '',
          tags: editMetaTags.map((t) => t.trim()).filter(Boolean).slice(0, PROJECT_TAG_LIMIT),
          note: editMetaNote.trim(),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setEditMetaProject(null);
        await loadProjects();
      } else {
        alert(data.error || 'Failed to update project');
      }
    } catch (err) {
      console.error('Failed to update project meta:', err);
      alert('Failed to update project meta');
    } finally {
      setSavingMeta(false);
    }
  }, [editMetaProject, editMetaCategory, editMetaTags, editMetaNote, loadProjects]);

  // materials 目录行「⋯」操作菜单：锚点位置 + 当前行上下文（菜单项操作跟随上下文执行）
  const [materialMenu, setMaterialMenu] = useState<{
    top: number;
    right: number;
    projId: string;
    isRoot: boolean;
    materialsRelPath: string;
    folderName: string;
  } | null>(null);
  // 标题栏项目切换下拉锚点（全部项目：标星置顶、横线分隔）
  const [wsSwitchAnchor, setWsSwitchAnchor] = useState<{ top: number; right: number } | null>(null);

  /** 点击标题栏项目名称/文件夹图标：toggle 项目切换下拉 */
  const toggleWsSwitch = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (wsSwitchAnchor) {
      setWsSwitchAnchor(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setWsSwitchAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, [wsSwitchAnchor]);

  // 点击 materials 菜单外部 / Esc / 滚动 → 关闭
  useEffect(() => {
    if (!materialMenu) return;
    const close = () => setMaterialMenu(null);
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-material-menu]')) return;
      close();
    };
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    };
  }, [materialMenu]);

  // 点击项目切换下拉外部 / Esc / 滚动 → 关闭
  useEffect(() => {
    if (!wsSwitchAnchor) return;
    const close = () => setWsSwitchAnchor(null);
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-ws-switch]')) return;
      close();
    };
    // 浮层内部列表自身滚动（列表较长时可滚动）不应关闭浮层，仅外部容器滚动才关闭
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.closest('[data-ws-switch]')) return;
      close();
    };
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    };
  }, [wsSwitchAnchor]);

  // 浮层关闭时同步关闭 materials 菜单 / 项目切换下拉（portal 独立渲染，不随浮层卸载）
  useEffect(() => {
    if (!workspaceOpen) {
      setMaterialMenu(null);
      setWsSwitchAnchor(null);
    }
  }, [workspaceOpen]);

  /** 加载项目文件树 */
  const loadProjectFiles = async (pid: string) => {
    setLoadingFiles((prev) => new Set(prev).add(pid));
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_files', project_id: pid }),
      });
      const data = await resp.json();
      if (data.success) {
        setProjectFiles((prev) => {
          const next = new Map(prev);
          next.set(pid, data.files);
          return next;
        });
        setHomeworkGroups((prev) => {
          const next = new Map(prev);
          next.set(pid, data.homework_kind_groups || []);
          return next;
        });
        // 默认展开：首次收到该项目类别分组时全部展开（此后不覆盖用户手动折叠）
        const groupKeys: string[] = (data.homework_kind_groups || []).map((g: HomeworkKindGroup) => `${pid}:${g.kind}`);
        if (groupKeys.length > 0 && !defaultHomeworkExpandedRef.current.has(pid)) {
          setHomeworkOpenGroups((prev) => {
            if (defaultHomeworkExpandedRef.current.has(pid)) return prev;
            const next = new Set(prev);
            groupKeys.forEach((k) => next.add(k));
            return next;
          });
          defaultHomeworkExpandedRef.current.add(pid);
        }
      }
    } catch (err) {
      console.error('加载文件树失败:', err);
    } finally {
      setLoadingFiles((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
    }
  };
  loadProjectFilesRef.current = loadProjectFiles;

  /** 切换文件夹展开 */
  const toggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  /** 切换 homework 节点分组展开（默认折叠，无按钮，点击分组行切换） */
  const toggleHomeworkGroup = useCallback((key: string) => {
    setHomeworkOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 创建文件夹（项目文件树 + materials 共用）
  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const folderPath = newFolderParent ? newFolderParent + '/' + name : name;
      const resp = await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_folder', folderPath }),
      });
      const data = await resp.json();
      if (data.success) {
        setNewFolderVisible(false);
        setNewFolderName('');
        if (currentId) loadProjectFiles(currentId);
      }
    } catch (err) {
      console.error('创建文件夹失败:', err);
    }
  }, [newFolderName, newFolderParent, currentId]);

  // 上传文件（项目文件树 + materials 共用）
  const handleUploadMaterial = useCallback(async (file: File, subFolder?: string) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const targetFolder = subFolder ? (uploadTargetFolder ? uploadTargetFolder + '/' + subFolder : subFolder) : uploadTargetFolder;
      if (targetFolder) {
        formData.append('folder', targetFolder);
      }
      const resp = await fetch('/api/materials', {
        method: 'POST',
        body: formData,
      });
      await resp.json();
    } catch (err) {
      console.error('上传失败:', err);
    }
  }, [uploadTargetFolder]);

  // 批量上传多个文件（单文件 input 多选）：逐个上传后统一刷新一次
  const handleUploadMultiple = useCallback(async (files: File[]) => {
    for (const f of files) {
      await handleUploadMaterial(f);
    }
    if (currentId) loadProjectFiles(currentId);
  }, [handleUploadMaterial, currentId]);

  // 上传文件夹：遍历所选文件，按 webkitRelativePath 保留目录结构上传
  const handleUploadFolder = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);
    for (const f of fileArr) {
      // webkitRelativePath 格式："根文件夹名/sub/file.ext"，全部保留作为相对子路径
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const subPath = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      await handleUploadMaterial(f, subPath);
    }
    if (currentId) loadProjectFiles(currentId);
  }, [handleUploadMaterial, currentId]);

  // 删除文件/文件夹（项目文件树 + materials 共用）
  const handleDeleteMaterial = useCallback(async (path: string, isDir: boolean) => {
    const label = isDir ? 'folder' : 'file';
    if (!confirm('Delete this ' + label + '?')) return;
    try {
      const resp = await fetch('/api/materials?path=' + encodeURIComponent(path), {
        method: 'DELETE',
      });
      const data = await resp.json();
      if (data.success) {
        if (currentId) loadProjectFiles(currentId);
      }
    } catch (err) {
      console.error('删除失败:', err);
    }
  }, [currentId]);

  // 删除 homework 文件（同步清理 .ownership.json 归属清册，节点分组随刷新更新）
  const handleDeleteHomeworkFile = useCallback(async (absPath: string) => {
    if (!confirm('Delete this file? It will be removed from homework and its node outputs.')) return;
    // 从绝对路径推导该文件所属项目的 homework 根目录
    const i = absPath.indexOf('/homework/');
    const homeworkRoot = i === -1 ? '' : absPath.slice(0, i + '/homework'.length);
    if (!homeworkRoot) return;
    try {
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_homework', targetPath: absPath, homeworkRoot }),
      });
      const data = await resp.json();
      if (data.success) {
        if (currentId) loadProjectFiles(currentId);
      } else {
        console.error('删除失败:', data.error);
      }
    } catch (err) {
      console.error('删除失败:', err);
    }
  }, [currentId]);

  /** 复制文件/文件夹（项目列式浏览 ⋮ 菜单）：后端递归复制，自动生成 "xxx 的副本" 名称 */
  const handleRowCopy = useCallback(async (filePath: string) => {
    setRowMenu(null);
    try {
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'copy', sourcePath: filePath }),
      });
      const data = await resp.json();
      if (data.success) {
        if (currentId) loadProjectFilesRef.current?.(currentId);
      } else {
        console.error('复制失败:', data.error);
      }
    } catch (err) {
      console.error('复制失败:', err);
    }
  }, [currentId]);

  /** 删除文件/文件夹（项目列式浏览 ⋮ 菜单）：按路径归属分流到对应后端清理逻辑 */
  const handleRowDelete = useCallback((menu: { filePath: string; fileName: string; isDir: boolean; rel: string }) => {
    setRowMenu(null);
    const { filePath, fileName, isDir, rel } = menu;
    // homework：清理 .ownership.json 归属清册（根目录受保护）
    if (rel === 'homework') return;
    if (rel.startsWith('homework/')) {
      void handleDeleteHomeworkFile(filePath);
      return;
    }
    // materials：走 materials API（根目录受保护）
    if (rel === 'materials') return;
    if (rel.startsWith('materials/')) {
      void handleDeleteMaterial(rel.replace(/^materials\//, ''), isDir);
      return;
    }
    void handleDelete(filePath, fileName);
  }, [handleDeleteHomeworkFile, handleDeleteMaterial, handleDelete]);

  /** 递归渲染文件树 */
  const renderFileTree = (nodes: FileNode[], depth: number, parentPath: string, projId: string) => {
    // 将文件树虚拟路径（<projectId>/...）转换为真实文件系统路径
    const toRealPath = (virtualPath: string): string => {
      const project = projects.find((p) => p.id === projId);
      if (!project) return virtualPath;
      return `${project.path}${virtualPath.slice(projId.length)}`;
    };

    // homework 子项过滤：输出文件已全部聚合进上方类别分组（doc/sheet/.../image/，含 legacy Image/ 目录），
    // 不在 Files 树平铺重复展示，避免同一文件出现两次；template/ 与其他自定义子目录仍保留在 Files 树
    const KIND_DIR_NAMES = new Set(['doc', 'sheet', 'slide', 'pdf', 'image', 'text', 'code', 'other', 'Image']);
    const filterHomeworkChildren = (children: FileNode[]): FileNode[] => {
      return children.filter((n) => n.type === 'directory' && !KIND_DIR_NAMES.has(n.name));
    };

    return nodes.map((node) => {
      const nodePath = `${parentPath}/${node.name}`;
      const isExpanded = expandedFolders.has(nodePath);
      // 真实路径：优先用服务端下发的 rel（摊平展示的 template 文档路径与名称链不一致时仍正确），否则按名称链还原
      const realPath = node.rel
        ? `${projects.find((p) => p.id === projId)?.path ?? ''}/${node.rel}`
        : toRealPath(nodePath);

      if (node.type === 'directory') {
        const isUnderMaterials = nodePath.startsWith(`${projId}/materials`);
        const materialsRelPath = isUnderMaterials
          ? nodePath.slice(`${projId}/materials`.length).replace(/^\//, '') || ''
          : '';
        const isMaterialsRoot = isUnderMaterials && materialsRelPath === '';
        // homework 根目录：展开时先展示 AI 节点目录（每个节点一个文件夹），再展示其余文件系统内容
        const isHomeworkRoot = nodePath === `${projId}/homework`;

        return (
          <div key={nodePath}>
            <div
              className="group relative flex w-full items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ paddingLeft: `${15 + levelIndent(depth + 1)}px` }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ x: e.clientX, y: e.clientY, filePath: realPath, fileName: node.name, isDir: true });
              }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFolder(nodePath);
                }}
                className="flex flex-1 items-center gap-1.5 min-w-0 text-left"
              >
                {isExpanded ? (
                  <FolderOpen className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--primary)' }} />
                ) : (
                  <Folder className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ink-muted)' }} />
                )}
                <FileName name={node.name} className="text-sm" style={{ color: 'var(--ink)' }} />
              </button>

              {isUnderMaterials && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMaterialMenu({
                      top: rect.bottom + 4,
                      right: window.innerWidth - rect.right,
                      projId,
                      isRoot: isMaterialsRoot,
                      materialsRelPath,
                      folderName: node.name,
                    });
                  }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-hover)] hover:text-[var(--ink)]"
                  title="Actions"
                  aria-label="Actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {isExpanded && node.children && (
              <div>
                {isHomeworkRoot && renderProjectKindGroups(projId, depth + 1)}
                {renderFileTree(
                  isHomeworkRoot ? filterHomeworkChildren(node.children) : node.children,
                  depth + 1,
                  nodePath,
                  projId,
                )}
              </div>
            )}
          </div>
        );
      }

      // 文件节点 - 可点击打开
      const icon = fileIcon(node.extension);
      // 应用内打开路径：优先用 rel（template 摊平文件需带 set_* 等中间目录）
      const relativePath = node.rel ?? nodePath.replace(`${projId}/`, '');
      const isUnderMaterials = nodePath.startsWith(`${projId}/materials`);
      const materialsRelPath = isUnderMaterials
        ? relativePath.replace(/^materials\//, '')
        : '';

      return (
        <div key={nodePath} className="group flex items-center"
          style={{ paddingLeft: '16px' }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ x: e.clientX, y: e.clientY, filePath: realPath, fileName: node.name, isDir: false });
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              bus.publish(BusEvents.fileOpen, { source: 'project', path: relativePath, name: node.name });
            }}
            className="flex flex-1 min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
          >
            <FileText className="h-3.5 w-3.5 flex-shrink-0" style={{ color: icon.color }} />
            {node.extension && !nodePath.startsWith(`${projId}/homework`) && (
              <span
                className="flex-shrink-0 rounded px-1 py-0 text-xs font-medium"
                style={{ backgroundColor: `${icon.color}18`, color: icon.color }}
              >
                {icon.label}
              </span>
            )}
            <FileName name={node.name} className="flex-1 truncate text-sm" style={{ color: 'var(--ink)' }} />
          </button>
          {/* homework 中 markdown 文档：用本地默认软件打开（Finder/系统默认关联应用） */}
          {isDesktop() && node.extension && /^\.md$/i.test(node.extension) && nodePath.startsWith(`${projId}/homework`) && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const res = await desktop.openFile(realPath);
                if (!res.success && res.error) console.error('打开文档失败:', res.error);
              }}
              className="mr-1 hidden flex-shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--info-soft)] group-hover:block"
              style={{ color: 'var(--info)' }}
              title="Open with default app"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          {/* homework 文件删除（同步清理节点归属清册） */}
          {nodePath.startsWith(`${projId}/homework`) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void handleDeleteHomeworkFile(realPath);
              }}
              className="mr-1 hidden flex-shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--danger-soft)] group-hover:block"
              style={{ color: 'var(--danger)' }}
              title="Delete from homework"
            >
              <Trash className="h-3 w-3" />
            </button>
          )}
          {isUnderMaterials && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!confirm(`Delete file "${node.name}"?`)) return;
                handleDeleteMaterial(materialsRelPath, false);
              }}
              className="hidden group-hover:flex shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--danger-soft)]"
              style={{ color: 'var(--danger)' }}
              title="Delete"
            >
              <Trash className="h-3 w-3" />
            </button>
          )}
        </div>
      );
    });
  };



  /** 渲染 homework 类别分组目录：每个 kind 一个目录，目录内含该类别的输出文件（嵌入 homework 目录内，depth 与文件树对齐） */
  const renderProjectKindGroups = (projId: string, depth: number = 0) => {
    const groups = homeworkGroups.get(projId) || [];
    const project = projects.find((p) => p.id === projId);
    const projectPath = project?.path || '';

    if (groups.length === 0) {
      return null;
    }

    // f.path：project 源为项目相对路径（含 homework/ 前缀，如 homework/报告.md）；
    // local 源为绝对路径（bob-sandbox 小程序文件）。直接用 f.path 作为打开路径。
    const openGroupFile = (f: { name: string; path: string; source?: 'project' | 'local' }) => {
      const isLocal = f.source === 'local';
      bus.publish(BusEvents.fileOpen, {
        source: isLocal ? 'local' : 'project',
        path: f.path,
        name: f.name,
      });
    };
    const groupFilePath = (f: { path: string; source?: 'project' | 'local' }) =>
      f.source === 'local' ? f.path : `${projectPath}/${f.path}`;

    return (
      <div className="mt-0.5">
        {groups.map((g) => {
          const key = `${projId}:${g.kind}`;
          const isOpen = homeworkOpenGroups.has(key);
          return (
            <div key={key}>
              {/* 类别目录行：文件夹图标 + 标签 + 文件数 */}
              <div
                className="group relative flex cursor-pointer items-center rounded-md py-1 transition-colors hover:bg-[var(--paper-hover)]"
                style={{ paddingLeft: `${15 + levelIndent(depth + 1)}px` }}
                onClick={() => {
                  toggleHomeworkGroup(key);
                }}
                title={g.label}
              >
                {isOpen ? (
                  <FolderOpen className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--primary)' }} />
                ) : (
                  <Folder className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--ink-muted)' }} />
                )}
                <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--ink)' }}>
                  {g.label}
                </span>
                <span
                  className="flex-shrink-0 text-xs"
                  style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
                >
                  {g.files.length}
                </span>
                {/* 打开该类别文件夹按钮（Finder，hover 显示，仅桌面环境） */}
                {isDesktop() && g.files.length > 0 && (
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      const projFile = g.files.find((f) => f.source !== 'local');
                      if (!projFile) return;
                      const abs = groupFilePath(projFile);
                      const dir = abs.lastIndexOf('/') > 0 ? abs.slice(0, abs.lastIndexOf('/')) : abs;
                      const res = await desktop.openFile(dir);
                      if (!res.success && res.error) {
                        console.error('打开类别文件夹失败:', res.error);
                      }
                    }}
                    className="mr-1 hidden flex-shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--info-soft)] group-hover:block"
                    style={{ color: 'var(--info)' }}
                    title="Open homework folder in Finder"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </div>
              {/* 展开：该类别下的文件 */}
              {isOpen && g.files.length > 0 && (
                <div>
                  {g.files.map((f) => {
                    const fic = fileIcon(f.extension);
                    return (
                      <div
                        key={`${key}:${f.path}`}
                        className="group flex items-center"
                        style={{ paddingLeft: '16px' }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            filePath: groupFilePath(f),
                            fileName: f.name,
                            isDir: false,
                          });
                        }}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openGroupFile(f);
                          }}
                          className="flex flex-1 min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                        >
                          <FileText className="h-3.5 w-3.5 flex-shrink-0" style={{ color: fic.color }} />
                          <span
                            className="flex-shrink-0 rounded px-1 py-0 text-xs font-medium"
                            style={{ backgroundColor: `${fic.color}18`, color: fic.color }}
                          >
                            {fic.label}
                          </span>
                          <FileName name={f.name} className="flex-1 truncate text-sm" style={{ color: 'var(--ink)' }} />
                        </button>
                        {/* homework 中 AI 节点输出的 markdown 文档：用本地默认软件打开 */}
                        {isDesktop() && /^\.md$/i.test(f.extension ?? '') && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              const res = await desktop.openFile(groupFilePath(f));
                              if (!res.success && res.error) console.error('打开文档失败:', res.error);
                            }}
                            className="mr-1 hidden flex-shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--info-soft)] group-hover:block"
                            style={{ color: 'var(--info)' }}
                            title="Open with default app"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        )}
                        {/* 节点输出文件删除（同步清理归属清册） */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteHomeworkFile(groupFilePath(f));
                          }}
                          className="mr-1 hidden flex-shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--danger-soft)] group-hover:block"
                          style={{ color: 'var(--danger)' }}
                          title="Delete from homework"
                        >
                          <Trash className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // 旧行内展开树渲染已被右栏 Finder 列式浏览取代（保留函数体待后续清理，标记使用以免误报）
  void renderFileTree;
  void renderProjectKindGroups;

  return (
    <>
      {/* 侧边条 rail 已移除（2026-09-01）：全部按钮迁至 ⌘F 面板底部图标栏；
          常驻状态提示（BobMail 角标 / 更新进度）迁移至 NodeMap。
          本组件仅保留浮层渲染（Workspace / BobMail / 回收站 / 新建项目等）。 */}

      {/* Workspace 浮层（可拖动）：项目列表 + 当前项目文件树（完整交互） */}
      {workspaceOpen && typeof document !== 'undefined' && createPortal(
        <div
          data-bob-sidebar-popover
          className="fixed z-[60] flex flex-col overflow-hidden rounded-xl border"
          style={{
            left: wsPos.x,
            top: wsPos.y,
            width: wsWidth,
            height: 'min(56vh, calc(100vh - 40px))',
            maxHeight: 'calc(100vh - 40px)',
            backgroundColor: 'var(--paper)',
            borderColor: 'color-mix(in oklab, var(--line) 35%, transparent)',
            boxShadow: '0 12px 32px color-mix(in srgb, var(--ink) 22%, transparent)',
          }}
        >
          <div className="flex h-full min-h-0 flex-col">
          {/* 标题栏（拖动把手）：Workspace · 当前项目（文件夹图标/名称 → 下拉切换项目） */}
          <div
            className="flex shrink-0 cursor-move select-none items-center gap-1.5 border-b px-2 py-1.5"
            style={{ borderColor: 'var(--line-soft)', WebkitUserSelect: 'none' }}
            onPointerDown={(e) => startDrag(e)}
          >
            <span className="shrink-0 pl-1 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              Workspace
            </span>
            <span style={{ width: 1, height: 16, backgroundColor: 'var(--line-soft)' }} />
            {(() => {
              const cp = projects.find((p) => p.id === currentId) || null;
              return (
                <button
                  type="button"
                  onClick={(e) => toggleWsSwitch(e)}
                  className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                  title={cp ? `Switch project (${cp.name})` : 'No active project'}
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: cp ? 'var(--primary)' : 'var(--ink-muted)' }} />
                  <span className="max-w-[220px] truncate font-medium" style={{ color: cp ? 'var(--ink)' : 'var(--ink-muted)' }}>
                    {cp ? cp.name : 'No project'}
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                </button>
              );
            })()}
            {(() => {
              const cp = projects.find((p) => p.id === currentId);
              if (!cp) return null;
              return (
                <>
                  {cp.category && (
                    <span
                      className="shrink-0 rounded px-1.5 py-px text-10 leading-4 font-medium"
                      style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)', color: 'var(--primary)' }}
                    >
                      {cp.category}
                    </span>
                  )}
                  {cp.note && (
                    <Button
                      type="button"
                      onClick={() => openEditMeta(cp)}
                      variant="ghost"
                      tone="neutral"
                      size="icon-sm"
                      title={cp.note}
                    >
                      <StickyNote className="h-3 w-3" />
                    </Button>
                  )}
                  {isDesktop() && cp.path && (
                    <Button
                      type="button"
                      onClick={async () => {
                        const res = await desktop.openFile(cp.path);
                        if (!res.success && res.error) console.error('打开文件夹失败:', res.error);
                      }}
                      variant="ghost"
                      tone="neutral"
                      size="icon-sm"
                      title="Open in Finder"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  )}
                </>
              );
            })()}
            {/* 上下文操作（作用于当前打开的文件夹；仅 materials 下目录时可用） */}
            {(() => {
              if (wsView !== 'files' || !currentId || wsOpenPath.length === 0) return null;
              const roots = projectFiles.get(currentId) || [];
              if (roots.length === 0) return null;
              let node: FileNode | null = null;
              let arr = roots;
              for (const nm of wsOpenPath) {
                const f = arr.find((x) => x.type === 'directory' && x.name === nm);
                if (!f) { node = null; break; }
                node = f;
                arr = f.children ?? [];
              }
              if (!node) return null;
              const rel = node.rel ?? wsOpenPath.join('/');
              if (rel !== 'materials' && !rel.startsWith('materials/')) return null;
              const matRel = rel.replace(/^materials\/?/, '');
              const isRoot = rel === 'materials';
              return (
                <>
                  <span style={{ width: 1, height: 16, backgroundColor: 'var(--line-soft)' }} />
                  <Button
                    type="button"
                    variant="ghost"
                    tone="neutral"
                    size="icon-sm"
                    title="Upload file to this folder"
                    onClick={() => {
                      setUploadTargetFolder(matRel);
                      setTimeout(() => uploadInputRef.current?.click(), 50);
                    }}
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    tone="neutral"
                    size="icon-sm"
                    title="Upload folder"
                    onClick={() => {
                      setUploadTargetFolder(matRel);
                      setTimeout(() => uploadFolderInputRef.current?.click(), 50);
                    }}
                  >
                    <FolderUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    tone="neutral"
                    size="icon-sm"
                    title="New subfolder"
                    onClick={() => {
                      setNewFolderParent(matRel);
                      setNewFolderName('');
                      setNewFolderVisible(true);
                    }}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </Button>
                  {!isRoot && (
                    <Button
                      type="button"
                      variant="ghost"
                      tone="neutral"
                      size="icon-sm"
                      title="Delete folder"
                      onClick={() => {
                        if (confirm(`Delete folder "${node?.name}" and all its contents?`)) handleDeleteMaterial(matRel, true);
                      }}
                    >
                      <Trash className="h-3.5 w-3.5" style={{ color: 'var(--danger)' }} />
                    </Button>
                  )}
                </>
              );
            })()}
            <div className="flex-1" />
            {/* 视图切换：文件（Finder 列式）/ 日志（项目流水账） */}
            <div
              className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5"
              style={{ backgroundColor: 'var(--paper-soft)' }}
            >
              {([['files', '文件'], ['log', '日志']] as const).map(([key, label]) => {
                const active = wsView === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setWsView(key)}
                    className="rounded px-1.5 py-0.5 text-xs transition-colors"
                    style={{
                      backgroundColor: active ? 'var(--paper)' : 'transparent',
                      color: active ? 'var(--ink)' : 'var(--ink-muted)',
                      fontWeight: active ? 500 : 400,
                      boxShadow: active ? '0 1px 2px color-mix(in srgb, var(--ink) 12%, transparent)' : 'none',
                    }}
                    title={key === 'files' ? '文件树' : '项目流水账'}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {/* 刷新当前项目文件列表 */}
            {wsView === 'files' && currentId && (
              <Button
                type="button"
                onClick={() => loadProjectFiles(currentId)}
                variant="ghost"
                tone="neutral"
                size="icon-sm"
                title="Refresh file list"
                aria-label="Refresh file list"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${currentId && loadingFiles.has(currentId) ? 'animate-spin' : ''}`} />
              </Button>
            )}
            {/* 关闭浮层 */}
            <Button
              type="button"
              onClick={() => setWorkspaceOpen(false)}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Close"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* 主体（日志视图）：项目流水账，按日期分组 */}
          {wsView === 'log' && (
            currentId ? (
              <ProjectActivityLog projectId={currentId} refreshKey={logRefreshKey} />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
                暂无项目
              </div>
            )
          )}

          {/* 主体（文件视图）：Finder 列式浏览（当前项目与切换已入标题栏） */}
          {wsView === 'files' && (
          <div className="flex min-h-0 flex-1">
            {(() => {
              const currentProject = projects.find((p) => p.id === currentId) || null;
              return (
                <>

                  {/* ── 右栏：当前项目文件树 ── */}
                  <div className="flex min-w-0 flex-1 flex-col">
                    {!currentProject ? (
                      <div className="flex flex-1 items-center justify-center p-4">
                        <div className="w-full rounded-md border border-dashed px-3 py-5 text-center" style={{ borderColor: 'var(--line)' }}>
                          <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
                            No active project
                          </div>
                          <div className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                            Create a project to get started
                          </div>
                          <Button
                            type="button"
                            onClick={() => setCreateDialogOpen(true)}
                            variant="solid"
                            tone="brand"
                            size="sm"
                            className="mt-2"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            New project
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Finder 列式浏览：每列显示一层内容，点目录推入右侧新列 */}
                        <div className="flex min-h-0 flex-1 overflow-x-auto">
                          {(() => {
                            const roots = projectFiles.get(currentProject.id) || [];
                            const isLoading = loadingFiles.has(currentProject.id) && roots.length === 0;
                            const childrenAt = (prefix: string[]): FileNode[] => {
                              let arr = roots;
                              for (const nm of prefix) {
                                const d = arr.find((x) => x.type === 'directory' && x.name === nm);
                                if (!d || !d.children) return [];
                                arr = d.children;
                              }
                              return arr;
                            };
                            const totalCols = 1 + wsOpenPath.length;

                            if (roots.length === 0) {
                              return (
                                <div className="flex w-full items-center justify-center py-6 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                  {isLoading ? 'Loading...' : 'Empty'}
                                </div>
                              );
                            }

                            // 行 ⋮ 按钮：以按钮右下角为锚点打开操作菜单（重命名 / 复制 / 删除）
                            const openRowMenu = (e: React.MouseEvent<HTMLButtonElement>, node: FileNode, rel: string, isDir: boolean) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setRowMenu({
                                x: rect.right - 176, // 菜单宽 176px：右对齐按钮，向左展开以免超出右缘
                                y: rect.bottom + 4,
                                filePath: `${currentProject.path}/${rel}`,
                                fileName: node.name,
                                isDir,
                                rel,
                              });
                            };
                            const rowMenuButton = (node: FileNode, rel: string, isDir: boolean) => (
                              <button
                                type="button"
                                onClick={(e) => openRowMenu(e, node, rel, isDir)}
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-hover)] hover:opacity-100 group-hover:opacity-100"
                                style={{ color: 'var(--ink-muted)' }}
                                title="More actions"
                                aria-label="More actions"
                              >
                                <MoreVertical className="h-3.5 w-3.5" />
                              </button>
                            );

                            const renderRow = (c: number, node: FileNode, prefix: string[]) => {
                              const rel = node.rel ?? (prefix.length ? [...prefix, node.name].join('/') : node.name);
                              const isUnderMaterials = rel === 'materials' || rel.startsWith('materials/');
                              const materialsRel = rel.startsWith('materials') ? rel.replace(/^materials\/?/, '') : '';
                              if (node.type === 'directory') {
                                const isOpen = wsOpenPath[c] === node.name;
                                const authed = isMaterialsAuthed(currentProject.id);
                                return (
                                  <div key={node.name} className="group relative flex items-center rounded-md pr-1" style={isOpen ? { backgroundColor: 'color-mix(in oklab, var(--primary) 9%, transparent)' } : undefined}>
                                    <button
                                      type="button"
                                      onClick={() => setWsOpenPath((prev) => [...prev.slice(0, c), node.name])}
                                      className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                                      title={node.title || node.name}
                                    >
                                      {isOpen ? (
                                        <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                      ) : (
                                        <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                                      )}
                                      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--ink)' }}>
                                        {node.title || node.name}
                                      </span>
                                    </button>
                                    {isUnderMaterials && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleMaterialsAuth(currentProject.id);
                                        }}
                                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                                        style={{ color: authed ? 'var(--success)' : 'var(--ink-muted)' }}
                                        title={authed ? 'AI read/write authorized, click to revoke' : 'Authorize AI read/write for this directory (@ mentions, file tools)'}
                                        aria-label={authed ? 'Revoke AI access' : 'Authorize AI access'}
                                      >
                                        {authed ? (
                                          <ShieldCheck className="h-3 w-3" />
                                        ) : (
                                          <Shield className="h-3 w-3" />
                                        )}
                                      </button>
                                    )}
                                    {rowMenuButton(node, rel, true)}
                                  </div>
                                );
                              }
                              const fic = fileIcon(node.extension);
                              return (
                                <div key={node.name} className="group relative flex items-center rounded-md pr-1">
                                  <button
                                    type="button"
                                    onClick={() => bus.publish(BusEvents.fileOpen, { source: 'project', path: rel, name: node.name })}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                                    title={node.name}
                                  >
                                    <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: fic.color }} />
                                    <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--ink)' }}>
                                      {node.name}
                                    </span>
                                  </button>
                                  {isUnderMaterials && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (confirm(`Delete file "${node.name}"?`)) handleDeleteMaterial(materialsRel, false);
                                      }}
                                      className="hidden shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--danger-soft)] group-hover:block"
                                      style={{ color: 'var(--danger)' }}
                                      title="Delete"
                                    >
                                      <Trash className="h-3 w-3" />
                                    </button>
                                  )}
                                  {rowMenuButton(node, rel, false)}
                                </div>
                              );
                            };

                            const columns: ReactNode[] = [];
                            for (let c = 0; c < totalCols; c++) {
                              const prefix = wsOpenPath.slice(0, c);
                              const children = childrenAt(prefix);
                              columns.push(
                                <div
                                  key={c}
                                  className={cn(
                                    'flex flex-col border-r last:border-r-0',
                                    c === 0 ? 'w-[140px] shrink-0' : 'min-w-[160px] flex-1',
                                  )}
                                  style={{
                                    borderColor: 'var(--line-soft)',
                                    ...(c === 0 ? { backgroundColor: 'var(--paper-soft)' } : {}),
                                  }}
                                >
                                  <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                                    {children.length === 0 ? (
                                      <div className="px-2 py-3 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
                                        Empty
                                      </div>
                                    ) : (
                                      children.map((ch) => renderRow(c, ch, prefix))
                                    )}
                                  </div>
                                </div>,
                              );
                            }
                            return columns;
                          })()}
                        </div>
                      </>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
          )}

          </div>

          {/* 右缘调宽把手（拖动调宽） */}
          <div
            data-ws-resize
            onPointerDown={(e) => startResize(e)}
            className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none select-none"
            style={{ transition: 'background-color 0.15s ease' }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--primary) 25%, transparent)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            title="Drag to resize"
            aria-label="Drag to resize"
          />
        </div>,
        document.body,
      )}

      {/* 标题栏项目切换下拉（portal 挂 body）：全部项目，标星置顶 + 横线分隔 */}
      {wsSwitchAnchor && typeof document !== 'undefined' && createPortal(
        <div
          data-ws-switch
          className="fixed z-[500] max-h-[50vh] w-72 overflow-hidden rounded-lg border py-1 shadow-xl"
          style={{ top: wsSwitchAnchor.top, right: wsSwitchAnchor.right, backgroundColor: 'var(--popover)', borderColor: 'var(--line)' }}
        >
          {(() => {
            const starredList = projects.filter((p) => starredProjects.has(p.id));
            const otherList = projects.filter((p) => !starredProjects.has(p.id));
            const row = (p: ProjectInfo) => {
              const isCur = p.id === currentId;
              const starred = starredProjects.has(p.id);
              return (
                <div key={p.id} className="flex items-center pr-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (!isCur) handleSwitch(p.id);
                      setWsSwitchAnchor(null);
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 truncate px-3 py-1.5 text-left text-13 transition-colors hover:bg-[var(--paper-hover)]',
                      isCur && 'opacity-90',
                    )}
                    style={{ color: 'var(--ink)' }}
                    title={isCur ? 'Current project' : `Switch to ${p.name}`}
                  >
                    {isCur ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {isCur && (
                      <span
                        className="shrink-0 rounded px-1.5 py-px text-10 font-semibold uppercase"
                        style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)', color: 'var(--primary)' }}
                      >
                        Active
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleProjectStar(p.id); }}
                    title={starred ? 'Unstar' : 'Star'}
                    aria-label={starred ? 'Unstar' : 'Star'}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: starred ? 'var(--warn)' : 'var(--ink-faint)' }}
                  >
                    <Star className="h-3 w-3" style={{ fill: starred ? 'var(--warn)' : 'transparent' }} />
                  </button>
                </div>
              );
            };
            if (projects.length === 0) {
              return (
                <div className="px-3 py-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  No projects
                </div>
              );
            }
            return (
              <div className="max-h-[calc(50vh-16px)] overflow-y-auto">
                {starredList.length > 0 && (
                  <div className="mt-1">
                    <div className="px-3 py-1 text-11 font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-faint)' }}>
                      Starred
                    </div>
                    {starredList.map((p) => row(p))}
                  </div>
                )}
                {starredList.length > 0 && otherList.length > 0 && (
                  <div className="my-1 h-px" style={{ backgroundColor: 'var(--line)' }} />
                )}
                {otherList.length > 0 && (
                  <div className="mt-1">
                    <div className="px-3 py-1 text-11 font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-faint)' }}>
                      Projects
                    </div>
                    {otherList.map((p) => row(p))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>,
        document.body,
      )}

      {/* materials 目录「⋯」操作菜单（portal 挂 body，避免被浮层滚动容器裁切） */}
      {materialMenu && typeof document !== 'undefined' && createPortal(
        <div
          data-material-menu
          className="fixed z-[500] w-56 overflow-hidden rounded-lg border py-1 shadow-xl"
          style={{ top: materialMenu.top, right: materialMenu.right, backgroundColor: 'var(--popover)', borderColor: 'var(--line)' }}
        >
          {(() => {
            const authed = isMaterialsAuthed(materialMenu.projId);
            const itemBase = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-13 transition-colors hover:bg-[var(--paper-hover)]';
            return (
              <>
                {materialMenu.isRoot && (
                  <button
                    type="button"
                    onClick={() => {
                      setMaterialMenu(null);
                      toggleMaterialsAuth(materialMenu.projId);
                    }}
                    className={itemBase}
                    style={{ color: authed ? 'var(--success)' : 'var(--ink)' }}
                  >
                    {authed ? (
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--success)' }} />
                    ) : (
                      <Shield className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                    )}
                    {authed ? 'Revoke AI access' : 'Authorize AI access'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMaterialMenu(null);
                    setUploadTargetFolder(materialMenu.materialsRelPath);
                    setTimeout(() => uploadInputRef.current?.click(), 50);
                  }}
                  className={itemBase}
                  style={{ color: 'var(--ink)' }}
                >
                  <Upload className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--info)' }} />
                  Upload file
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMaterialMenu(null);
                    setUploadTargetFolder(materialMenu.materialsRelPath);
                    setTimeout(() => uploadFolderInputRef.current?.click(), 50);
                  }}
                  className={itemBase}
                  style={{ color: 'var(--ink)' }}
                >
                  <FolderUp className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--info)' }} />
                  Upload folder
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMaterialMenu(null);
                    setNewFolderParent(materialMenu.materialsRelPath);
                    setNewFolderName('');
                    setNewFolderVisible(true);
                  }}
                  className={itemBase}
                  style={{ color: 'var(--ink)' }}
                >
                  <FolderPlus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                  New subfolder
                </button>
                {!materialMenu.isRoot && (
                  <>
                    <div className="my-1 h-px" style={{ backgroundColor: 'var(--line)' }} />
                    <button
                      type="button"
                      onClick={() => {
                        setMaterialMenu(null);
                        if (confirm(`Delete folder "${materialMenu.folderName}" and all its contents?`)) {
                          handleDeleteMaterial(materialMenu.materialsRelPath, true);
                        }
                      }}
                      className={itemBase}
                      style={{ color: 'var(--danger)' }}
                    >
                      <Trash className="h-3.5 w-3.5 shrink-0" />
                      Delete folder
                    </button>
                  </>
                )}
              </>
            );
          })()}
        </div>,
        document.body,
      )}

      {/* BobMail 通知中心：入口图标在 Sidebar（collapsed rail），弹层受控渲染（portal 到 body） */}
      <WantedNoticeCenter
        onOpenCalendar={onOpenCalendar}
        open={wantedOpen}
        onOpenChange={setWantedOpen}
        anchorRect={wantedAnchor}
        onPendingChange={setWantedPending}
      />

      {/* Skill Store（独立面板）：⌘F 面板图标栏入口，Dialog 形态（打开即落在 Market 视图） */}
      <SkillManagerModal
        open={skillStoreOpen}
        onOpenChange={setSkillStoreOpen}
        initialView="market"
      />

      {/* 新建项目对话框 */}
      {createDialogOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => !creating && setCreateDialogOpen(false)}
        >
          <div
            className="rounded-2xl p-6 shadow-xl"
            style={{
              border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
              backgroundColor: 'var(--popover)',
              width: '360px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-base font-medium" style={{ color: 'var(--ink)' }}>
              New Project
            </h3>
            <p className="mb-3 -mt-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Name will get <code>_YYYYMMDD</code> suffix automatically.
            </p>
            <input
              type="text"
              autoFocus
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating) {
                  handleCreate();
                }
                if (e.key === 'Escape' && !creating) {
                  setCreateDialogOpen(false);
                  setNewProjectName('');
                  setNewProjectCategory('');
                  setNewProjectNote('');
                  setNewProjectTag1('');
                  setNewProjectTag2('');
                }
              }}
              disabled={creating}
              className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
              style={{
                backgroundColor: 'var(--paper)',
                borderColor: 'var(--line)',
                color: 'var(--ink)',
              }}
            />
            {/* 分类选择（诉讼 / 常法 / 非诉 / 破产，可留空） */}
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Category
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PROJECT_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={creating}
                    onClick={() => setNewProjectCategory(newProjectCategory === c ? '' : c)}
                    className="rounded-lg px-2.5 py-1 text-xs transition-colors"
                    style={
                      newProjectCategory === c
                        ? { backgroundColor: 'var(--primary)', color: 'var(--paper)' }
                        : { backgroundColor: 'var(--paper)', color: 'var(--ink-muted)', border: '1px solid var(--line)' }
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            {/* 标签（两个独立输入框，并排显示，最多 2 个） */}
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Tags (up to {PROJECT_TAG_LIMIT})
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newProjectTag1}
                  onChange={(e) => setNewProjectTag1(e.target.value)}
                  disabled={creating}
                  placeholder="Tag 1"
                  className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
                  style={{
                    backgroundColor: 'var(--paper)',
                    borderColor: 'var(--line)',
                    color: 'var(--ink)',
                  }}
                />
                <input
                  type="text"
                  value={newProjectTag2}
                  onChange={(e) => setNewProjectTag2(e.target.value)}
                  disabled={creating}
                  placeholder="Tag 2"
                  className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
                  style={{
                    backgroundColor: 'var(--paper)',
                    borderColor: 'var(--line)',
                    color: 'var(--ink)',
                  }}
                />
              </div>
            </div>
            {/* 备注（自动字数计数，最多 100 字） */}
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                <span>Note (optional)</span>
                <span style={{ color: newProjectNote.length >= PROJECT_NOTE_MAX ? 'var(--danger, #e8463a)' : 'var(--ink-faint)' }}>
                  {newProjectNote.length}/{PROJECT_NOTE_MAX}
                </span>
              </div>
              <textarea
                value={newProjectNote}
                onChange={(e) => setNewProjectNote(e.target.value)}
                disabled={creating}
                maxLength={PROJECT_NOTE_MAX}
                rows={3}
                placeholder="What is this project about?"
                className="w-full resize-none rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
                style={{
                  backgroundColor: 'var(--paper)',
                  borderColor: 'var(--line)',
                  color: 'var(--ink)',
                }}
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => {
                  setCreateDialogOpen(false);
                  setNewProjectName('');
                  setNewProjectCategory('');
                  setNewProjectNote('');
                  setNewProjectTag1('');
                  setNewProjectTag2('');
                }}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                onClick={handleCreate}
                disabled={creating || !newProjectName.trim()}
                loading={creating}
              >
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑分类/标签对话框 */}
      {editMetaProject && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => !savingMeta && setEditMetaProject(null)}
        >
          <div
            className="rounded-2xl p-6 shadow-xl"
            style={{
              border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
              backgroundColor: 'var(--popover)',
              width: '360px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-base font-medium" style={{ color: 'var(--ink)' }}>
              Project info
            </h3>
            <div className="mb-4 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
              {editMetaProject.name}
            </div>

            {/* 分类选择 */}
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Category
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PROJECT_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={savingMeta}
                    onClick={() => setEditMetaCategory(editMetaCategory === c ? '' : c)}
                    className="rounded-lg px-2.5 py-1 text-xs transition-colors"
                    style={
                      editMetaCategory === c
                        ? { backgroundColor: 'var(--primary)', color: 'var(--paper)' }
                        : { backgroundColor: 'var(--paper)', color: 'var(--ink-muted)', border: '1px solid var(--line)' }
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* 自定义标签（最多 2 个，并排显示） */}
            <div>
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Tags (up to {PROJECT_TAG_LIMIT})
              </div>
              <div className="flex gap-2">
                {[0, 1].map((i) => (
                  <input
                    key={i}
                    type="text"
                    placeholder={`Tag ${i + 1}`}
                    value={editMetaTags[i] || ''}
                    onChange={(e) => {
                      const next = [...editMetaTags];
                      next[i] = e.target.value;
                      setEditMetaTags(next);
                    }}
                    disabled={savingMeta}
                    className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
                    style={{
                      backgroundColor: 'var(--paper)',
                      borderColor: 'var(--line)',
                      color: 'var(--ink)',
                    }}
                  />
                ))}
              </div>
            </div>

            {/* 备注（自动字数计数，最多 100 字，空 = 清除） */}
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                <span>Note (up to {PROJECT_NOTE_MAX} characters, empty to clear)</span>
                <span style={{ color: editMetaNote.length >= PROJECT_NOTE_MAX ? 'var(--danger, #e8463a)' : 'var(--ink-faint)' }}>
                  {editMetaNote.length}/{PROJECT_NOTE_MAX}
                </span>
              </div>
              <textarea
                value={editMetaNote}
                onChange={(e) => setEditMetaNote(e.target.value)}
                disabled={savingMeta}
                maxLength={PROJECT_NOTE_MAX}
                rows={3}
                placeholder="No note yet"
                className="w-full resize-none rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
                style={{
                  backgroundColor: 'var(--paper)',
                  borderColor: 'var(--line)',
                  color: 'var(--ink)',
                }}
              />
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => setEditMetaProject(null)}
                disabled={savingMeta}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                onClick={handleSaveProjectMeta}
                disabled={savingMeta}
                loading={savingMeta}
              >
                {savingMeta ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 节点回收站对话框 */}
      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} projectId={projectId} />

      {/* 隐藏文件上传 input（通过右键菜单触发） */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void handleUploadMultiple(files);
          e.target.value = '';
        }}
      />

      {/* 隐藏文件夹上传 input */}
      <input
        ref={uploadFolderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory 是非标准属性但被主流浏览器支持
        webkitdirectory="true"
        directory="true"
        className="hidden"
        onChange={(e) => {
          handleUploadFolder(e.target.files);
          e.target.value = '';
        }}
      />

      {/* 行内新建文件夹输入框 */}
      {newFolderVisible && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => setNewFolderVisible(false)}
        >
          <div
            className="rounded-2xl p-5 shadow-xl"
            style={{
              border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
              backgroundColor: 'var(--popover)',
              width: '300px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-medium" style={{ color: 'var(--ink)' }}>
              New Subfolder
            </h3>
            <p className="mb-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Parent directory: {newFolderParent}
            </p>
            <input
              type="text"
              autoFocus
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newFolderName.trim()) {
                  handleCreateFolder();
                }
                if (e.key === 'Escape') {
                  setNewFolderVisible(false);
                  setNewFolderName('');
                }
              }}
              className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
              style={{
                backgroundColor: 'var(--paper)',
                borderColor: 'var(--line)',
                color: 'var(--ink)',
              }}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => {
                  setNewFolderVisible(false);
                  setNewFolderName('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim()}
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 文件树右键菜单 */}
      {ctxMenu && (
        <div
          className="fixed z-[100] w-44 overflow-hidden rounded-xl shadow-2xl"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 180),
            top: Math.min(ctxMenu.y, window.innerHeight - 220),
            border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'var(--popover)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { setCtxMenu(null); addToCurrentNode(ctxMenu.filePath, ctxMenu.isDir); }}
            disabled={!activeNodeIdRef.current}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            style={{ color: activeNodeIdRef.current ? 'var(--ink)' : 'var(--ink-muted)' }}
            title={activeNodeIdRef.current ? undefined : 'No node selected — click a node on the canvas first'}
          >
            <ArrowUpCircle className="h-3.5 w-3.5" style={{ color: activeNodeIdRef.current ? 'var(--primary)' : 'var(--ink-muted)' }} />
            <span className="flex-1">发送到当前节点</span>
            {!activeNodeIdRef.current && (
              <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>无节点</span>
            )}
          </button>
          <button
            onClick={() => addToNewNode(ctxMenu.filePath, ctxMenu.isDir)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
          >
            <PlusCircle className="h-3.5 w-3.5" style={{ color: 'var(--info)' }} />
            <span className="flex-1">发送到新建节点</span>
          </button>

          <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--line-soft)' }} />

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
            <span className="flex-1">重命名</span>
          </button>
          <button
            onClick={() => handleDelete(ctxMenu.filePath, ctxMenu.fileName)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--danger)' }}
          >
            <Trash className="h-3.5 w-3.5" style={{ color: 'var(--danger)' }} />
            <span className="flex-1">删除</span>
          </button>
        </div>
      )}

      {/* 列式浏览行 ⋮ 菜单（portal 到 body，避免被浮层 overflow-hidden 裁切） */}
      {rowMenu && typeof document !== 'undefined' && createPortal(
        <div
          data-row-menu
          className="fixed z-[102] w-44 overflow-hidden rounded-xl shadow-2xl"
          style={{
            left: Math.max(8, Math.min(rowMenu.x, window.innerWidth - 184)),
            top: Math.min(rowMenu.y, window.innerHeight - 132),
            border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'var(--popover)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setRowMenu(null);
              setRenaming({ filePath: rowMenu.filePath, oldName: rowMenu.fileName });
              setRenameValue(rowMenu.fileName);
              setTimeout(() => renameRef.current?.focus(), 50);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
          >
            <Pencil className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            Rename
          </button>
          <button
            onClick={() => handleRowCopy(rowMenu.filePath)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
          >
            <Copy className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            Copy
          </button>
          <button
            onClick={() => handleRowDelete(rowMenu)}
            disabled={rowMenu.rel === 'homework' || rowMenu.rel === 'materials'}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            style={{ color: rowMenu.rel === 'homework' || rowMenu.rel === 'materials' ? 'var(--ink-muted)' : 'var(--danger)' }}
            title={rowMenu.rel === 'homework' || rowMenu.rel === 'materials' ? 'Root directories cannot be deleted' : undefined}
          >
            <Trash className="h-3.5 w-3.5" style={{ color: rowMenu.rel === 'homework' || rowMenu.rel === 'materials' ? 'var(--ink-muted)' : 'var(--danger)' }} />
            Delete
          </button>
        </div>,
        document.body,
      )}

      {/* 重命名弹窗 */}
      {renaming && (
        <div
          data-ws-rename
          className="fixed inset-0 z-[101] flex items-start justify-center pt-20"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onClick={() => setRenaming(null)}
        >
          <div
            className="w-72 rounded-2xl p-4 shadow-2xl"
            style={{ border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)', backgroundColor: 'var(--popover)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-3 text-sm font-medium font-display" style={{ color: 'var(--ink)' }}>
              重命名
            </p>
            <input
              ref={renameRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') setRenaming(null);
              }}
              className="mb-3 w-full rounded-md border px-3 py-2 text-sm outline-none"
              style={{ borderColor: 'var(--input-border)', color: 'var(--ink)' }}
              autoFocus
              onFocus={(e) => {
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
                取消
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                onClick={handleRename}
                disabled={!renameValue.trim() || renameValue.trim() === renaming.oldName}
              >
                确认
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
