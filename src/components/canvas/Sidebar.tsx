'use client';

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  BookOpen,
  Folder,
  FolderOpen,
  Plus,
  Trash,
  FileText,
  Upload,
  FolderUp,
  FolderPlus,
  Shield,
  ShieldCheck,
  ArrowUpCircle,
  PlusCircle,
  Pencil,
  X,
  Star,
  MoreVertical,
  Copy,
  Download,
  SquareCheck,
  Archive,
  Share2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Tag,
  Check,
  Minus,
  Filter,
  MessagesSquare,
  AlertTriangle,
} from 'lucide-react';
import { WantedNoticeCenter } from './WantedNoticeCenter';
import { SkillManagerModal } from './SkillManagerModal';
import { TrashDialog } from './TrashDialog';
import { ArchiveDialog } from './ArchiveDialog';
import { LedgerDocPanel } from './LedgerDocPanel';
import { ProjectActivityLog } from './ProjectActivityLog';
import { bus, BusEvents } from '@/lib/bus';
import { showImageAiEditToast } from '@/lib/image-ai-edit-runtime';
import { desktop, isDesktop } from '@/lib/desktop-adapter';
import { loadSettings, applyCustomTheme, applyFontScale } from '@/lib/settings';
import type { MessageAttachment } from '@/lib/types';
import { PROJECT_CATEGORIES, PROJECT_TAG_LIMIT, PROJECT_NOTE_MAX } from '@/lib/types';
import { cn } from '@/lib/utils';
import type { TagScope } from '@/lib/files/tags';
import { Button } from '@/components/ui/button';

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

/** homework 单文件的来源会话（后端 .ownership.json + notes-memory 关联结果） */
interface HomeworkOwner {
  nodeId: string;
  /** 会话标题；缺失时前端回落为 nodeId 短 id */
  title?: string;
  /** 文件修改时间（ms）：分组视图按「该会话最新产出」倒序排组 */
  mtimeMs: number;
}

/** Workspace 浮层最小宽度（保证 Finder 列式浏览可读） */
const WORKSPACE_MIN_WIDTH = 560;
/** 项目一级默认目录（homework / materials / attachments）：不提供重命名 / 复制 / 删除 */
const DEFAULT_ROOT_DIRS = new Set(['homework', 'materials', 'attachments']);
/** 上传后「解析中」提示的最长展示时长：超时仍未建索引（无文字 / 解析失败）则自动撤下，避免永久转圈 */
const PARSING_DEADLINE_MS = 5 * 60 * 1000;
/** 文件树折叠态的 localStorage 键前缀（按项目分键：前缀 + 项目 id）。
 *  homework / materials 已改为扁平清单，折叠态即整个清单的显隐；attachments 等仍为可折叠树。 */
const WS_EXPANDED_LS_PREFIX = 'bob.workspace.expanded.';
/** homework 清单视图的 localStorage 键前缀（按项目分键：前缀 + 项目 id；'0'=扁平，其余 / 缺失=按来源会话分组） */
const WS_HOMEWORK_GROUPED_LS_PREFIX = 'bob.workspace.homework-grouped.';
/** materials 清单视图的 localStorage 键前缀（按项目分键：前缀 + 项目 id；'1'=按来源文件夹分组，其余 / 缺失=扁平） */
const WS_MATERIALS_GROUPED_LS_PREFIX = 'bob.workspace.materials-grouped.';
/** 侧栏内部拖拽（分组视图把资料行拖进来源文件夹）的 dataTransfer 类型，与 OS 文件拖入的 'Files' 区分 */
const WS_ROW_DRAG_MIME = 'application/x-bobwork-ws-row';
/** 标签筛选中的「无标签」哨兵：以 NUL 开头，与用户可输入的标签（经清洗后必为可见字符）不会撞名 */
const UNTAGGED_FILTER = '\u0000untagged';
/** materials 作用域的预设标签：无需先给文件打标签即可直接勾选 */
const DEFAULT_MATERIAL_TAGS = ['原告', '被告', '法院'];
/** 标签调色板：12 个可区分的色相（浅底深字由统一饱和度/亮度生成，保证同一色相下的胶囊都清晰可读） */
const TAG_COLOR_HUES = [352, 20, 42, 95, 145, 172, 197, 222, 252, 282, 312, 332];
/** 可否分享：分享链接仅支持 .md 文档（/api/share 服务端同样只接受 .md），文件夹不支持 */
const isShareableDoc = (fileName: string, isDir: boolean): boolean => !isDir && /\.md$/i.test(fileName);

/** 拖拽上传收集结果：subPath 为相对目标目录的子路径（顶层文件为空串，目录内文件含目录名） */
interface DroppedFile { file: File; subPath: string; }

/** 读取目录项的全部子项（readEntries 单次最多返回 100 条，需循环读到空数组为止） */
const readAllEntries = (entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> =>
  new Promise((resolve) => {
    const reader = entry.createReader();
    const acc: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(acc);
        else { acc.push(...batch); readBatch(); }
      }, () => resolve(acc));
    };
    readBatch();
  });

/** 递归收集拖入的文件/目录：dirPath 为当前所在子路径（保留拖入目录的层级结构） */
const collectDropped = async (entry: FileSystemEntry, dirPath: string, out: DroppedFile[]): Promise<void> => {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    if (file) out.push({ file, subPath: dirPath });
    return;
  }
  for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
    if (child.isDirectory) await collectDropped(child, dirPath ? `${dirPath}/${child.name}` : child.name, out);
    else await collectDropped(child, dirPath, out);
  }
};

interface SidebarProps {
  onOpenSettings: () => void;
  onOpenCalendar: () => void;
  projectId: string;
  /** 折叠状态变化通知（父级据此调整顶部拖拽区让出按钮区域；rail 已移除恒为折叠态） */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** 发送文件到新建节点（由 CanvasFlow 提供，复用 LocalFileExplorer 的逻辑） */
  onCreateNodeWithFile?: (filePath: string, isDir: boolean) => Promise<{ nodeId: string; attachment: unknown } | null>;
  /** 当前活跃节点（由 CanvasFlow 提供与本地文件面板共用的同一 ref），"发送到当前节点"据此判断可用性 */
  activeNodeIdRef: RefObject<string | null>;
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

export function Sidebar({ onOpenCalendar, projectId, onCollapsedChange, onCreateNodeWithFile, activeNodeIdRef }: SidebarProps) {
  // 侧边栏仅保留浮层渲染（rail 视觉条已迁至 ⌘F 面板底部图标栏，2026-09-01）：
  // Workspace → 可拖动浮层（项目列表 + 文件树）
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  // 编译文稿浮层（标题栏 Ledger 按钮打开）：只读查看账本 wiki 归并结果，不落盘
  const [ledgerOpen, setLedgerOpen] = useState(false);
  // 归档箱弹窗（根行 ⋮ 菜单的 Archived… 打开）；null 表示关闭，值即当前查看的作用域
  const [archiveScope, setArchiveScope] = useState<TagScope | null>(null);
  // 浮层位置（初始贴左缘；拖动标题栏可移动，会话内记忆）
  const [wsPos, setWsPos] = useState<{ x: number; y: number }>({ x: 52, y: 96 });
  // 浮层宽度（右缘拖动调宽，会话内记忆）
  const [wsWidth, setWsWidth] = useState(700);
  // 浮层视图：files=项目文件（materials 为扁平清单 + 标签筛选，其余目录为可折叠树）/ log=项目流水账
  const [wsView, setWsView] = useState<'files' | 'log'>('files');
  // 流水账刷新信号（项目内文件变更时自增，触发日志面板重新拉取）
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  // 标题栏搜索关键词：Files 搜文件名（全树扁平匹配）/ Log 搜日志条目，两视图各存一份互不覆盖
  const [wsFileQuery, setWsFileQuery] = useState('');
  const [wsLogQuery, setWsLogQuery] = useState('');
  const wsQuery = wsView === 'files' ? wsFileQuery : wsLogQuery;
  const setWsQuery = wsView === 'files' ? setWsFileQuery : setWsLogQuery;
  // 拖动/调宽期间读取最新值用 ref 镜像（避免重建事件监听）
  const wsPosRef = useRef(wsPos);
  useEffect(() => {
    wsPosRef.current = wsPos;
  }, [wsPos]);
  const wsWidthRef = useRef(wsWidth);
  useEffect(() => {
    wsWidthRef.current = wsWidth;
  }, [wsWidth]);
  // 目录展开态（homework / attachments 等可折叠树）：已展开目录的 rel 集合，按项目分别持久化到 localStorage
  const [wsExpanded, setWsExpanded] = useState<Set<string>>(new Set());
  // 根目录标签栏：materials / homework 当前显示的一栏（两栏都存在时才出现标签栏）；仅会话内记忆
  const [wsRootTab, setWsRootTab] = useState<'materials' | 'homework'>('materials');
  // homework 清单视图：默认 true=按来源会话分组；显式切回扁平后按项目持久化（随项目切换由 effect 重新读取）
  const [homeworkGrouped, setHomeworkGrouped] = useState(true);
  // materials 清单视图：默认 false=扁平清单（沿用原行为）；显式开启后按来源文件夹分组并按项目持久化
  const [materialsGrouped, setMaterialsGrouped] = useState(false);
  // 分组视图下已折叠的分组键（`<项目id>|m:<目录>` / `<项目id>|h:<会话键>`）：点击分组标题切换，仅会话内记忆
  const [collapsedWsGroups, setCollapsedWsGroups] = useState<Set<string>>(new Set());
  const toggleWsGroupCollapsed = useCallback((key: string) => {
    setCollapsedWsGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // 文件标签：作用域（materials 资料 / homework 作业产物）→ 作用域根相对路径 → 标签数组。
  // 各自存于 <项目>/<作用域>/.tags.json，随项目切换重新拉取
  const [fileTags, setFileTags] = useState<Record<TagScope, Record<string, string[]>>>({ materials: {}, homework: {} });
  // 标签筛选（按作用域分别记录，单选）：'' 表示 All（不筛选），UNTAGGED_FILTER 为「无标签」哨兵
  const [tagFilter, setTagFilter] = useState<Record<TagScope, string>>({ materials: '', homework: '' });
  // 标签筛选下拉（根行筛选按钮触发）：锚点为按钮右下角
  const [tagFilterMenu, setTagFilterMenu] = useState<{ x: number; y: number; scope: TagScope } | null>(null);
  // 标签编辑弹层：锚点为行内标签按钮右下角，scope 决定写入哪张标签表
  const [tagEditor, setTagEditor] = useState<{ x: number; y: number; scope: TagScope; rel: string } | null>(null);
  // 标签编辑弹层的新建标签输入
  const [tagDraft, setTagDraft] = useState('');
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
        if (el.closest('[data-ws-switch]')) return; // 标题栏项目切换下拉 portal 到 body：点击项不关闭浮层
        if (el.closest('[data-row-menu], [data-materials-menu], [data-ws-rename], [data-tag-menu], [data-tag-filter-menu]')) return; // 文件行 / materials 行 ⋮ 菜单 / 重命名弹窗 / 标签编辑弹层 / 标签筛选下拉：点击不关闭浮层
      }
      setWorkspaceOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [workspaceOpen]);

  // 标签筛选下拉：点击菜单外部 → 关闭（触发按钮自身由 onClick 切换，不算外部）
  useEffect(() => {
    if (!tagFilterMenu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && t.nodeType === 1) {
        const el = t as Element;
        if (el.closest('[data-tag-filter-menu], [data-tag-filter-trigger]')) return;
      }
      setTagFilterMenu(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [tagFilterMenu]);

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
  // 切换当前项目：恢复该项目上次的资料树展开态（localStorage 持久化），并清空标签筛选
  useEffect(() => {
    setTagFilter({ materials: '', homework: '' });
    // homework 清单视图：首开默认按来源会话分组，用户显式切回扁平后按项目记住（仅 '0' 表示扁平）
    try {
      setHomeworkGrouped(localStorage.getItem(WS_HOMEWORK_GROUPED_LS_PREFIX + currentId) !== '0');
    } catch {
      setHomeworkGrouped(true);
    }
    // materials 清单视图：首开默认扁平，用户显式切到按来源文件夹分组后按项目记住（仅 '1' 表示分组）
    try {
      setMaterialsGrouped(localStorage.getItem(WS_MATERIALS_GROUPED_LS_PREFIX + currentId) === '1');
    } catch {
      setMaterialsGrouped(false);
    }
    if (!currentId) {
      setWsExpanded(new Set());
      return;
    }
    try {
      const raw = localStorage.getItem(WS_EXPANDED_LS_PREFIX + currentId);
      const arr = raw ? (JSON.parse(raw) as unknown) : null;
      // 首次打开该项目（无持久化记录）：默认展开 homework（作业产物）与 materials（资料），可直接看到文件清单
      setWsExpanded(Array.isArray(arr) ? new Set<string>(arr as string[]) : new Set<string>(['homework', 'materials']));
    } catch {
      setWsExpanded(new Set<string>(['homework', 'materials']));
    }
  }, [currentId]);
  /** 展开态持久化（按项目分键）：重启 BobWork 后仍保留上次的折叠状态 */
  const persistWsExpanded = useCallback((pid: string, next: Set<string>) => {
    try {
      localStorage.setItem(WS_EXPANDED_LS_PREFIX + pid, JSON.stringify([...next]));
    } catch {
      /* 隐私模式/配额异常：忽略，仅丢失持久化 */
    }
  }, []);
  /** 展开态更新入口（统一在此持久化，避免依赖 effect 顺序） */
  const updateWsExpanded = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setWsExpanded((prev) => {
      const next = updater(prev);
      if (currentId) persistWsExpanded(currentId, next);
      return next;
    });
  }, [currentId, persistWsExpanded]);
  /** 折叠 / 展开单个目录 */
  const toggleWsDir = useCallback((rel: string) => {
    updateWsExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, [updateWsExpanded]);
  /** homework 清单视图切换（按来源会话分组 ↔ 扁平），按项目持久化 */
  const toggleHomeworkGrouped = useCallback(() => {
    setHomeworkGrouped((prev) => {
      const next = !prev;
      if (currentId) {
        try {
          localStorage.setItem(WS_HOMEWORK_GROUPED_LS_PREFIX + currentId, next ? '1' : '0');
        } catch {
          /* 隐私模式/配额异常：忽略，仅丢失持久化 */
        }
      }
      return next;
    });
  }, [currentId]);

  /** materials 清单视图切换（按来源文件夹分组 ↔ 扁平），按项目持久化 */
  const toggleMaterialsGrouped = useCallback(() => {
    setMaterialsGrouped((prev) => {
      const next = !prev;
      if (currentId) {
        try {
          localStorage.setItem(WS_MATERIALS_GROUPED_LS_PREFIX + currentId, next ? '1' : '0');
        } catch {
          /* 隐私模式/配额异常：忽略，仅丢失持久化 */
        }
      }
      return next;
    });
  }, [currentId]);

  /** 拉取标签表（项目切换时调用，materials / homework 两个作用域并行）；
   *  失败静默保留上次结果，标签是附加信息不阻塞文件浏览 */
  const loadFileTags = useCallback(async (): Promise<void> => {
    try {
      const fetchScope = async (scope: TagScope): Promise<Record<string, string[]>> => {
        const resp = await fetch(`/api/materials?action=tags&scope=${scope}`);
        const data = await resp.json();
        return data?.success && data.tags ? data.tags as Record<string, string[]> : {};
      };
      const [materials, homework] = await Promise.all([fetchScope('materials'), fetchScope('homework')]);
      setFileTags({ materials, homework });
    } catch {
      /* 拉取失败不提示 */
    }
  }, []);

  useEffect(() => {
    if (!currentId) {
      setFileTags({ materials: {}, homework: {} });
      return;
    }
    void loadFileTags();
  }, [currentId, loadFileTags]);

  /** 保存某文件（资料 / 作业产物）的标签（覆盖式）：先本地生效保证弹层即时反馈，再以服务端规范化结果为准 */
  const saveFileTags = useCallback(async (scope: TagScope, rel: string, tags: string[]): Promise<void> => {
    const apply = (list: string[]) => setFileTags((prev) => {
      const next = { ...prev, [scope]: { ...prev[scope] } };
      if (list.length > 0) next[scope][rel] = list;
      else delete next[scope][rel];
      return next;
    });
    apply(tags);
    try {
      const resp = await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_tags', scope, path: rel, tags }),
      });
      const data = await resp.json();
      if (data?.success && Array.isArray(data.tags)) apply(data.tags as string[]);
    } catch (err) {
      console.error('保存标签失败:', err);
    }
  }, []);

  /** 为某文件增删单个标签（大小写不敏感判重，与后端规范化一致） */
  const toggleFileTag = useCallback((scope: TagScope, rel: string, tag: string, current: string[]): void => {
    const key = tag.toLowerCase();
    const has = current.some((t) => t.toLowerCase() === key);
    void saveFileTags(scope, rel, has ? current.filter((t) => t.toLowerCase() !== key) : [...current, tag]);
  }, [saveFileTags]);

  /** 标签筛选选择（按作用域，单选）：点击已选项回到 All（''） */
  const selectTagFilter = useCallback((scope: TagScope, tag: string): void => {
    setTagFilter((prev) => ({ ...prev, [scope]: prev[scope] === tag ? '' : tag }));
  }, []);

  /** 某作用域的可选标签：materials 预设标签（原告/被告/法院）在前，其后为该作用域已用过的标签（去重、按本地化排序） */
  const candidateTagsOf = useCallback((scope: TagScope, extra: string[] = []): string[] => {
    const presets = scope === 'materials' ? DEFAULT_MATERIAL_TAGS : [];
    // 归档条目（键以 .archive/ 开头）已从文件树隐藏，其标签不再作为候选
    const visible = Object.entries(fileTags[scope])
      .filter(([rel]) => !rel.startsWith('.archive/'))
      .flatMap(([, tags]) => tags);
    const used = Array.from(new Set([...visible, ...extra]))
      .filter((t) => !presets.some((p) => p.toLowerCase() === t.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    return [...presets, ...used];
  }, [fileTags]);

  /** 标签 → 色相：两个作用域的候选标签并集，按标签串哈希取色相，冲突时线性探测，
   *  保证同屏出现的不同标签颜色互不相同，且同一标签的颜色在标签集变化时基本保持稳定 */
  const tagHueMap = useMemo(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const t of [...candidateTagsOf('materials'), ...candidateTagsOf('homework')]) {
      const k = t.toLowerCase();
      if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
    const used = new Set<number>();
    const map = new Map<string, number>();
    for (const k of keys) {
      let h = 0;
      for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
      let idx = h % TAG_COLOR_HUES.length;
      while (used.has(idx)) idx = (idx + 1) % TAG_COLOR_HUES.length;
      used.add(idx);
      map.set(k, TAG_COLOR_HUES[idx]);
    }
    return map;
  }, [candidateTagsOf]);
  /** 标签文字色：同一色相深色，用于菜单类场景（仅文字上色） */
  const tagTextColor = (tag: string): string => `hsl(${tagHueMap.get(tag.toLowerCase()) ?? TAG_COLOR_HUES[0]} 52% 36%)`;
  /** 标签胶囊配色：同色相浅底 + 深字 */
  const tagChipStyle = (tag: string): { backgroundColor: string; color: string } => ({
    backgroundColor: `hsl(${tagHueMap.get(tag.toLowerCase()) ?? TAG_COLOR_HUES[0]} 72% 92%)`,
    color: tagTextColor(tag),
  });
  /** 行内标签胶囊组（最多 2 个 + 余量）：interactive=false 时仅作展示（多选态下批量打标签的结果需就地可见） */
  const renderTagChips = (
    tags: string[],
    interactive: boolean,
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void,
  ): React.ReactNode => {
    if (tags.length === 0) return null;
    const chips = (
      <>
        {tags.slice(0, 2).map((t) => (
          <span
            key={t}
            className="max-w-[64px] truncate rounded-full px-1 py-px text-9"
            style={{ ...tagChipStyle(t), boxShadow: 'var(--shadow-sm)' }}
          >
            {t}
          </span>
        ))}
        {tags.length > 2 && (
          <span className="text-9" style={{ color: 'var(--ink-faint)' }}>{`+${tags.length - 2}`}</span>
        )}
      </>
    );
    const cls = 'flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 transition-colors';
    return interactive ? (
      <button
        type="button"
        onClick={onClick}
        className={cn(cls, 'hover:bg-[var(--paper-hover)]')}
        title={tags.join(', ')}
      >
        {chips}
      </button>
    ) : (
      <span className={cls} title={tags.join(', ')}>
        {chips}
      </span>
    );
  };

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectCategory, setNewProjectCategory] = useState('');
  const [newProjectNote, setNewProjectNote] = useState('');
  // 新建项目：两个独立标签输入框（最多 2 个）
  const [newProjectTag1, setNewProjectTag1] = useState('');
  const [newProjectTag2, setNewProjectTag2] = useState('');
  const [creating, setCreating] = useState(false);

  // 更新状态（常驻提示迁移至 NodeMap：Sidebar 保留逻辑，广播 update-status-changed 事件）
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'no-update' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = useState<string>('');
  const [updateProgress, setUpdateProgress] = useState<number>(0);
  const [updateError, setUpdateError] = useState<string>('');
  const [installProgress, setInstallProgress] = useState<{ stage: string; message: string; percent?: number } | null>(null);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Materials 相关状态（上传共用）
  const [uploadTargetFolder, setUploadTargetFolder] = useState<string>('');
  // 拖拽上传：拖入文件悬停在 materials 目录上方时高亮
  const [materialsDragActive, setMaterialsDragActive] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadFolderInputRef = useRef<HTMLInputElement>(null);
  // 上传后「解析中」提示：后台建索引（文本抽取 / OCR）完成前在文件行显示
  // key = `${projId}::${materials相对路径}`；deadline 用于兜底（无文字的文件不会永久卡住）
  const [parsingFiles, setParsingFiles] = useState<Set<string>>(new Set());
  const parsingDeadlineRef = useRef<Map<string, number>>(new Map());
  // 后台识别失败：key 同上 → 失败原因；文件行显示重试入口（长扫描件识别失败过去是静默丢弃）
  const [failedIndexFiles, setFailedIndexFiles] = useState<Map<string, string>>(new Map());

  /** 拉取索引三态并同步到界面（已索引 / 识别中 / 失败） */
  const syncIndexStatus = useCallback(async (): Promise<{ indexed: Set<string>; pending: Set<string>; failed: Map<string, string> }> => {
    const empty = { indexed: new Set<string>(), pending: new Set<string>(), failed: new Map<string, string>() };
    try {
      const resp = await fetch('/api/materials?action=index_status');
      const data = await resp.json();
      return {
        indexed: new Set<string>(Array.isArray(data?.indexed) ? data.indexed : []),
        pending: new Set<string>(Array.isArray(data?.pending) ? data.pending : []),
        failed: new Map<string, string>(Object.entries(data?.failed ?? {}) as [string, string][]),
      };
    } catch {
      return empty; // 网络抖动：调用方下个 tick 重试
    }
  }, []);

  // 切换项目时先取一次状态：否则重开后「识别中」与「识别失败」都不会显示
  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    void (async () => {
      const { pending, failed } = await syncIndexStatus();
      if (cancelled) return;
      setFailedIndexFiles(new Map([...failed].map(([rel, err]) => [`${currentId}::${rel}`, err])));
      if (pending.size > 0) {
        setParsingFiles((prev) => {
          const next = new Set(prev);
          for (const rel of pending) next.add(`${currentId}::${rel}`);
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [currentId, syncIndexStatus]);

  // 「解析中」轮询：还有待解析文件时，周期性只读 manifest 检查是否已建索引（零开销，不触发抽取/OCR）
  const parsingActive = parsingFiles.size > 0;
  useEffect(() => {
    if (!parsingActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      const { indexed, pending, failed } = await syncIndexStatus();
      if (cancelled) return;
      const now = Date.now();
      setParsingFiles((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        let changed = false;
        for (const key of prev) {
          const sep = key.indexOf('::');
          const pid = sep >= 0 ? key.slice(0, sep) : '';
          const rel = sep >= 0 ? key.slice(sep + 2) : key;
          const mine = pid === currentId;
          const done = mine && indexed.has(rel);
          // 后台异步识别中：不按 deadline 兜底（长扫描件分钟级），等它落地或转失败
          const isPending = mine && pending.has(rel);
          const expired = !isPending && (parsingDeadlineRef.current.get(key) ?? 0) <= now;
          if (done || expired) {
            next.delete(key);
            parsingDeadlineRef.current.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // 失败态同步：失败的从「解析中」摘掉，改在文件行显示重试入口
      setFailedIndexFiles((prev) => {
        const next = new Map<string, string>();
        if (currentId) for (const [rel, err] of failed) next.set(`${currentId}::${rel}`, err);
        if (next.size === prev.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev;
        return next;
      });
      if (!cancelled) timer = setTimeout(tick, 1500);
    };

    timer = setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [parsingActive, currentId, syncIndexStatus]);

  /** 失败材料重试：清掉失败态、恢复「解析中」，并让后台重新建索引 */
  const retryMaterialIndex = useCallback(async (rel: string) => {
    if (!currentId) return;
    const key = `${currentId}::${rel}`;
    setFailedIndexFiles((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    parsingDeadlineRef.current.set(key, Date.now() + PARSING_DEADLINE_MS);
    setParsingFiles((prev) => new Set(prev).add(key));
    try {
      await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_index', path: rel }),
      });
    } catch {
      /* 轮询会兜底刷新状态 */
    }
  }, [currentId]);

  // 右键菜单状态（文件树）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filePath: string; fileName: string; isDir: boolean } | null>(null);
  // 列式浏览行 ⋮ 菜单状态（重命名 / 复制 / 删除）；rel 为项目相对路径，用于区分 homework / materials
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; filePath: string; fileName: string; isDir: boolean; rel: string } | null>(null);
  // 目录行 ⋮ 菜单状态（materials / homework 根行）：收纳上传 / 授权 / 进入多选等目录级操作
  const [materialsMenu, setMaterialsMenu] = useState<{ x: number; y: number; rel: string; name: string; isRoot: boolean; scope: TagScope } | null>(null);
  // 多选态：null 为未进入；进入后锁定单一作用域，rels 为命中行的项目内相对路径集合
  const [selection, setSelection] = useState<{ scope: TagScope; rels: Set<string> } | null>(null);
  // 批量打标签弹层（锚点为多选操作条的 Tag 按钮）
  const [batchTagMenu, setBatchTagMenu] = useState<{ x: number; y: number } | null>(null);
  // 重命名状态；kind='newFolder' 时 filePath 复用为「materials 根相对的目标目录」（空串即根），oldName 无意义
  const [renaming, setRenaming] = useState<{ filePath: string; oldName: string; kind?: 'rename' | 'newFolder' } | null>(null);
  // materials 分组视图：拖拽悬停的分组（值为分组对应的项目内相对路径），用于落点高亮
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  // 当前激活节点 ID（"发送到当前节点"）由 CanvasFlow 传入，与右侧本地文件面板共用同一 ref
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
  // 关闭 materials 行 ⋮ 菜单（点击任意位置）
  useEffect(() => {
    if (!materialsMenu) return;
    const close = () => setMaterialsMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [materialsMenu]);
  // 关闭标签编辑弹层（点击任意位置）；弹层内部点击已由容器 stopPropagation 拦截
  useEffect(() => {
    if (!tagEditor) return;
    const close = () => { setTagEditor(null); setTagDraft(''); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [tagEditor]);
  // 关闭批量打标签弹层（点击任意位置）
  useEffect(() => {
    if (!batchTagMenu) return;
    const close = () => setBatchTagMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [batchTagMenu]);
  // 多选态下 Esc 退出多选（连同批量标签弹层一并收起）
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setBatchTagMenu(null);
      setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);
  // 切换项目时退出多选（rels 为项目内相对路径，跨项目复用无意义）
  useEffect(() => { setSelection(null); setBatchTagMenu(null); }, [currentId]);

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

  // 重命名文件/文件夹；kind='newFolder' 时改为在指定目录下真实新建文件夹（分组视图的「新建分组」）
  const handleRename = useCallback(async () => {
    if (!renaming || !renameValue.trim()) return;
    const creatingFolder = renaming.kind === 'newFolder';
    try {
      const resp = await fetch(creatingFolder ? '/api/materials' : '/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          creatingFolder
            ? { action: 'create_folder', folderPath: [renaming.filePath, renameValue.trim()].filter(Boolean).join('/') }
            : { action: 'rename', sourcePath: renaming.filePath, newName: renameValue.trim() },
        ),
      });
      const data = await resp.json();
      if (data.success) {
        setRenaming(null);
        setRenameError(null);
        if (currentId) loadProjectFilesRef.current?.(currentId);
        // materials / homework 内文件重命名会迁移标签表键，需同步本地标签映射
        void loadFileTags();
      } else {
        setRenameError(data.error || (creatingFolder ? 'Create folder failed' : 'Rename failed'));
      }
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : (creatingFolder ? 'Create folder failed' : 'Rename failed'));
    }
  }, [renaming, renameValue, currentId, loadFileTags]);

  // 分组视图拖拽落点：把资料行移动到目标文件夹（真实移动，标签表键 / 内容索引键随迁）
  const handleRowMove = useCallback(async (srcRel: string, destDirRel: string) => {
    const projectPath = projects.find((p) => p.id === currentId)?.path;
    // 可拖拽的行恒为文件，不存在「移入自身子孙」的风险，故只校验必要项
    if (!srcRel || !projectPath) return;
    // 落在原目录（含拖到 Root / 组内互拖）：无变化，静默返回
    if (srcRel.slice(0, srcRel.lastIndexOf('/')) === destDirRel) return;
    try {
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'move',
          sourcePath: `${projectPath}/${srcRel}`,
          destDir: `${projectPath}/${destDirRel}`,
        }),
      });
      const data = await resp.json();
      if (!data?.success) {
        showImageAiEditToast(data?.error || 'Move failed', 'error');
        return;
      }
      if (currentId) loadProjectFilesRef.current?.(currentId);
      // 标签表键随移动迁移，需同步本地标签映射
      void loadFileTags();
      const target = destDirRel === 'materials' ? 'materials' : destDirRel.slice('materials/'.length);
      showImageAiEditToast(`Moved "${srcRel.split('/').pop()}" to ${target}`);
    } catch (err) {
      console.error('移动资料失败:', err);
      showImageAiEditToast('Move failed', 'error');
    }
  }, [currentId, projects, loadFileTags]);

  // 解散分组：分组内的文件全部移回未分组（materials 根），再删除该空文件夹
  const handleDissolveGroup = useCallback(async (groupDirRel: string, title: string) => {
    // groupDirRel 为项目内相对路径（含首段 materials），接口要的是 materials 根相对路径
    const groupPath = groupDirRel.slice('materials/'.length);
    if (!groupPath) return;
    if (!window.confirm(`Delete group "${title}"? Files will be moved to the ungrouped folder.`)) return;
    try {
      const resp = await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dissolve_group', groupPath }),
      });
      const data = await resp.json();
      if (!data?.success) {
        showImageAiEditToast(data?.error || 'Delete group failed', 'error');
        return;
      }
      if (currentId) loadProjectFilesRef.current?.(currentId);
      // 标签表键随移动迁移，需同步本地标签映射
      void loadFileTags();
      showImageAiEditToast(`Deleted group "${title}"`);
    } catch (err) {
      console.error('删除分组失败:', err);
      showImageAiEditToast('Delete group failed', 'error');
    }
  }, [currentId, loadFileTags]);

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
  const [projectFiles, setProjectFiles] = useState<Map<string, FileNode[]>>(new Map());
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  // homework 归属表：项目 id →（homework 根相对路径 → 来源会话）。由 list_files 的 homework_owners 下发，
  // 供「按来源会话分组」视图使用；无清册时为 {}（此时全部文件落 Ungrouped）
  const [homeworkOwners, setHomeworkOwners] = useState<Map<string, Record<string, HomeworkOwner>>>(new Map());

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
    // 节点成果块被后台自动提炼改写 → 转成窗口事件，由 ChatNodeKernel 自行按 id 匹配刷新状态
    // （成果块在服务端后台生成，画布不会主动知道；不复用文件树刷新，避免无谓重拉）
    const onNodeOutcome = (e: MessageEvent) => {
      try {
        const { node_id } = JSON.parse(e.data || '{}') as { node_id?: string };
        if (node_id) window.dispatchEvent(new CustomEvent('node-outcome-refresh', { detail: { node_id } }));
      } catch {
        /* 负载非法（心跳/异常）忽略 */
      }
    };
    es.addEventListener('projects-changed', onChanged);
    es.addEventListener('files-changed', onFilesChanged);
    es.addEventListener('node-outcome', onNodeOutcome);
    return () => {
      es.removeEventListener('projects-changed', onChanged);
      es.removeEventListener('files-changed', onFilesChanged);
      es.removeEventListener('node-outcome', onNodeOutcome);
      es.close();
    };
  }, [loadProjects]);

  // Workspace 浮层打开时刷新一次：关闭期间不接收 files-changed 推送，重开需拉取最新列表；
  // 当前项目在右栏文件树恒为展开态，同时加入 expandedProjects 使其进入 SSE 文件变更刷新集合；
  // 同步刷新「项目流水账」视图（logRefreshKey），保证文件/日志两个视图每次打开都是最新的
  useEffect(() => {
    if (workspaceOpen && currentId) {
      setExpandedProjects((prev) => (prev.has(currentId) ? prev : new Set(prev).add(currentId)));
      loadProjectFiles(currentId);
      setLogRefreshKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceOpen]);

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

  // 浮层关闭时同步关闭项目切换下拉（portal 独立渲染，不随浮层卸载）
  useEffect(() => {
    if (!workspaceOpen) {
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
        // homework 归属表：随文件树一并刷新（缺失 / 无清册时存空对象，分组视图全部落 Ungrouped）
        setHomeworkOwners((prev) => {
          const next = new Map(prev);
          next.set(pid, (data.homework_owners ?? {}) as Record<string, HomeworkOwner>);
          return next;
        });
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

  // 上传文件（项目文件树 + materials 共用）；baseFolder 用于拖拽上传时显式指定目标目录（不依赖 uploadTargetFolder 状态）
  const handleUploadMaterial = useCallback(async (file: File, subFolder?: string, baseFolder?: string) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const base = baseFolder ?? uploadTargetFolder;
      const targetFolder = subFolder ? (base ? base + '/' + subFolder : subFolder) : base;
      if (targetFolder) {
        formData.append('folder', targetFolder);
      }
      const resp = await fetch('/api/materials', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      // 后台会异步建索引（文本抽取 / OCR）：可索引文件先标记「解析中」，
      // 由轮询在 manifest 出现该路径后移除（deadline 兜底，避免解析失败/无文字时永久转圈）
      if (data?.success && data.file?.indexable && currentId) {
        const key = `${currentId}::${data.file.path}`;
        parsingDeadlineRef.current.set(key, Date.now() + PARSING_DEADLINE_MS);
        setParsingFiles((prev) => new Set(prev).add(key));
      }
    } catch (err) {
      console.error('上传失败:', err);
    }
  }, [uploadTargetFolder, currentId]);

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

  // 拖拽上传落点：materials 根（界面已扁平化，不再有可选子目录层级）
  const materialsDropReady = Boolean(currentId) && wsView === 'files';

  /** 收集拖入的 OS 文件并上传到指定 materials 子目录（target 为相对 materials 的子路径，'' 为根） */
  const uploadDroppedFiles = async (e: React.DragEvent, target: string) => {
    // dataTransfer.items 在 await 之后失效，先同步取出各项 entry
    const entries = Array.from(e.dataTransfer.items)
      .filter((it) => it.kind === 'file')
      .map((it) => it.webkitGetAsEntry())
      .filter((en): en is FileSystemEntry => en !== null);
    const collected: DroppedFile[] = [];
    if (entries.length > 0) {
      for (const en of entries) {
        // 顶层目录整体作为一层子路径保留目录名，文件直接落到当前目录
        await collectDropped(en, en.isDirectory ? en.name : '', collected);
      }
    } else {
      // 兜底（浏览器未提供 items）：按普通文件平铺上传
      Array.from(e.dataTransfer.files).forEach((f) => collected.push({ file: f, subPath: '' }));
    }
    if (collected.length === 0) return;
    for (const { file, subPath } of collected) {
      await handleUploadMaterial(file, subPath || undefined, target);
    }
    if (currentId) loadProjectFiles(currentId);
  };

  const handleMaterialsDragOver = (e: React.DragEvent) => {
    if (!materialsDropReady) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setMaterialsDragActive(true);
  };

  const handleMaterialsDragLeave = (e: React.DragEvent) => {
    // 在子元素间移动同样触发 dragleave：仅当真正离开拖拽区（relatedTarget 为空或不在区内）才取消高亮
    const next = e.relatedTarget as Node | null;
    if (!next || !e.currentTarget.contains(next)) setMaterialsDragActive(false);
  };

  const handleMaterialsDrop = async (e: React.DragEvent) => {
    setMaterialsDragActive(false);
    if (!materialsDropReady) return;
    e.preventDefault();
    await uploadDroppedFiles(e, '');
  };

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
        // 删除会回收该路径（及其子路径）的标签条目，需同步本地标签映射
        void loadFileTags();
      }
    } catch (err) {
      console.error('删除失败:', err);
    }
  }, [currentId, loadFileTags]);

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
        // 删除会回收该 homework 文件的标签条目，需同步本地标签映射
        void loadFileTags();
      } else {
        console.error('删除失败:', data.error);
      }
    } catch (err) {
      console.error('删除失败:', err);
    }
  }, [currentId, loadFileTags]);

  /**
   * 复制（行 ⋮ 菜单）：就地在该条目所在目录生成副本（后端按 Finder 规则追加 " copy"，
   * 文件夹递归复制），随后刷新文件树。
   */
  const handleRowCopy = useCallback(async (menu: { filePath: string; fileName: string; isDir: boolean }) => {
    setRowMenu(null);
    try {
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'copy', sourcePath: menu.filePath }),
      });
      const data = await resp.json();
      if (!data.success) {
        showImageAiEditToast('Copy failed', 'error');
        return;
      }
      if (currentId) loadProjectFilesRef.current?.(currentId);
      showImageAiEditToast(`Copied "${String(data.newName || menu.fileName)}"`);
    } catch {
      showImageAiEditToast('Copy failed', 'error');
    }
  }, [currentId]);

  /**
   * 下载到本地（行 ⋮ 菜单）：选目标文件夹（桌面 / 下载等）后把源复制过去，完成后在 Finder 中定位，
   * 便于再拖入微信等外部应用。复用后端 paste 动作（同名时按 Finder 规则追加 " copy"）。
   */
  const handleRowDownload = useCallback(async (menu: { filePath: string; fileName: string }) => {
    setRowMenu(null);
    if (!isDesktop()) {
      showImageAiEditToast('Downloading to a local folder requires the desktop app', 'error');
      return;
    }
    const picked = await desktop.selectDirectory();
    if (!picked.success || !picked.path) return; // 用户取消选择
    try {
      const resp = await fetch('/api/local-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'paste', sourcePath: menu.filePath, destDir: picked.path }),
      });
      const data = await resp.json();
      if (data.success) {
        showImageAiEditToast(`Saved "${data.newName ?? menu.fileName}"`);
        void desktop.showItemInFolder(data.newPath);
      } else {
        showImageAiEditToast(`Download failed: ${data.error ?? 'unknown'}`, 'error');
      }
    } catch (err) {
      showImageAiEditToast(`Download failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, []);

  /** 多选：进入某作用域的多选态（顺带展开该作用域，使勾选框可见） */
  const startSelection = useCallback((scope: TagScope) => {
    setMaterialsMenu(null);
    setRowMenu(null);
    // 关闭单文件标签弹层：否则它会残留并盖在批量标签弹层上，导致点击落错目标
    setTagEditor(null);
    setTagDraft('');
    updateWsExpanded((prev) => (prev.has(scope) ? prev : new Set([...prev, scope])));
    setSelection({ scope, rels: new Set() });
  }, [updateWsExpanded]);

  /** 多选：勾选 / 取消勾选一行（key 为项目内相对路径） */
  const toggleSelected = useCallback((rel: string) => {
    setSelection((prev) => {
      if (!prev) return prev;
      const rels = new Set(prev.rels);
      if (rels.has(rel)) rels.delete(rel);
      else rels.add(rel);
      return { ...prev, rels };
    });
  }, []);

  /** 多选：所选行的路径派生（作用域根相对路径用于标签 / materials 删除，绝对路径用于文件操作） */
  const selectionPaths = useCallback((): { rel: string; scopeRel: string; absPath: string; name: string }[] => {
    if (!selection) return [];
    const rootPath = projects.find((p) => p.id === currentId)?.path ?? '';
    return Array.from(selection.rels).map((rel) => ({
      rel,
      scopeRel: rel.startsWith(selection.scope + '/') ? rel.slice(selection.scope.length + 1) : rel,
      absPath: `${rootPath}/${rel}`,
      name: rel.split('/').pop() || rel,
    }));
  }, [selection, projects, currentId]);

  /** 多选：当前作用域下的全部文件相对路径（Select all 用，与清单同源的项目文件树遍历） */
  const allRelsInScope = useCallback((scope: TagScope): string[] => {
    if (!currentId) return [];
    const root = (projectFiles.get(currentId) || []).find((n) => (n.rel ?? n.name) === scope);
    const out: string[] = [];
    const walk = (nodes: FileNode[], prefix: string[]) => {
      for (const n of nodes) {
        if (n.type === 'directory') {
          if (n.children?.length) walk(n.children, [...prefix, n.name]);
          continue;
        }
        out.push(n.rel ?? (prefix.length ? [...prefix, n.name].join('/') : n.name));
      }
    };
    if (root?.children?.length) walk(root.children, [scope]);
    return out;
  }, [currentId, projectFiles]);

  /** 多选：批量下载到本地（只选一次目标文件夹，逐项复制，完成后在 Finder 中定位） */
  const handleBatchDownload = useCallback(async () => {
    const items = selectionPaths();
    if (items.length === 0) return;
    if (!isDesktop()) {
      showImageAiEditToast('Downloading to a local folder requires the desktop app', 'error');
      return;
    }
    const picked = await desktop.selectDirectory();
    if (!picked.success || !picked.path) return; // 用户取消选择
    let ok = 0;
    for (const item of items) {
      try {
        const resp = await fetch('/api/local-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'paste', sourcePath: item.absPath, destDir: picked.path }),
        });
        const data = await resp.json();
        if (data.success) ok += 1;
      } catch {
        /* 单项失败不阻断其余项 */
      }
    }
    if (ok === 0) {
      showImageAiEditToast('Download failed', 'error');
      return;
    }
    showImageAiEditToast(`Saved ${ok} ${ok === 1 ? 'item' : 'items'}`);
    void desktop.showItemInFolder(picked.path);
  }, [selectionPaths]);

  /** 多选：批量复制（就地在该文件所在目录生成副本；后端按 Finder 规则追加 " copy"） */
  const handleBatchCopy = useCallback(async () => {
    const items = selectionPaths();
    if (items.length === 0) return;
    let ok = 0;
    for (const item of items) {
      try {
        const resp = await fetch('/api/local-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'copy', sourcePath: item.absPath }),
        });
        const data = await resp.json();
        if (data.success) ok += 1;
      } catch {
        /* 单项失败不阻断其余项 */
      }
    }
    if (ok === 0) {
      showImageAiEditToast('Copy failed', 'error');
      return;
    }
    if (currentId) loadProjectFilesRef.current?.(currentId);
    showImageAiEditToast(`Copied ${ok} ${ok === 1 ? 'item' : 'items'}`);
  }, [selectionPaths, currentId]);

  /** 多选：批量删除（一次确认后逐项删除；materials 走 materials API，homework 走归属清册清理） */
  const handleBatchDelete = useCallback(async () => {
    const items = selectionPaths();
    const scope = selection?.scope;
    if (items.length === 0 || !scope) return;
    if (!confirm(`Delete ${items.length} ${items.length === 1 ? 'file' : 'files'}?`)) return;
    let ok = 0;
    for (const item of items) {
      try {
        if (scope === 'materials') {
          const resp = await fetch('/api/materials?path=' + encodeURIComponent(item.scopeRel), { method: 'DELETE' });
          if ((await resp.json()).success) ok += 1;
          continue;
        }
        const i = item.absPath.indexOf('/homework/');
        if (i === -1) continue;
        const resp = await fetch('/api/local-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'delete_homework',
            targetPath: item.absPath,
            homeworkRoot: item.absPath.slice(0, i + '/homework'.length),
          }),
        });
        if ((await resp.json()).success) ok += 1;
      } catch {
        /* 单项失败不阻断其余项 */
      }
    }
    if (currentId) loadProjectFiles(currentId);
    void loadFileTags();
    setSelection(null);
    if (ok === 0) showImageAiEditToast('Delete failed', 'error');
    else showImageAiEditToast(`Deleted ${ok} ${ok === 1 ? 'file' : 'files'}`);
  }, [selection, selectionPaths, currentId, loadFileTags]);

  /** 归档 / 恢复（共用）：rel 为作用域根相对路径，一次请求处理整批；成功后刷新文件树与标签表 */
  const applyArchive = useCallback(async (scope: TagScope, rels: string[], archived = true): Promise<boolean> => {
    if (rels.length === 0) return false;
    const verb = archived ? 'Archive' : 'Restore';
    try {
      const resp = await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_archived', scope, items: rels, archived }),
      });
      const data = await resp.json();
      if (!data?.success) {
        showImageAiEditToast(`${verb} failed`, 'error');
        return false;
      }
      const failed = Array.isArray(data.failed) ? data.failed.length : 0;
      if (currentId) loadProjectFilesRef.current?.(currentId);
      void loadFileTags();
      const done = rels.length - failed;
      if (failed > 0) showImageAiEditToast(`${verb}d ${done}, ${failed} skipped`);
      else showImageAiEditToast(`${verb}d ${done} ${done === 1 ? 'item' : 'items'}`);
      return true;
    } catch (err) {
      console.error('归档失败:', err);
      showImageAiEditToast(`${verb} failed`, 'error');
      return false;
    }
  }, [currentId, loadFileTags]);

  /** 多选：批量归档（移入 <作用域根>/.archive/，保留原相对路径；归档后行从文件树消失，故退出多选） */
  const handleBatchArchive = useCallback(async () => {
    const items = selectionPaths();
    const scope = selection?.scope;
    if (items.length === 0 || !scope) return;
    await applyArchive(scope, items.map((it) => it.scopeRel));
    setSelection(null);
  }, [applyArchive, selection, selectionPaths]);

  /** 多选：批量打标签（所选全部已有该标签则整体移除，否则整体补齐）。
   *  一次请求写入（set_tags_bulk）：只提交需变更的条目，避免逐项读改写同一标签表造成覆盖。 */
  const applyBatchTag = useCallback(async (tag: string) => {
    const value = tag.trim();
    const scope = selection?.scope;
    const items = selectionPaths();
    if (!value || !scope || items.length === 0) return;
    const key = value.toLowerCase();
    const scoped = fileTags[scope] ?? {};
    const hasTag = (it: { scopeRel: string }) => (scoped[it.scopeRel] ?? []).some((t) => t.toLowerCase() === key);
    const allHave = items.every(hasTag);
    // 所选全部已有 → 整体移除（每条都需提交）；否则补齐缺失条目的标签
    const payload = items
      .filter((it) => (allHave ? true : !hasTag(it)))
      .map((it) => {
        const current = scoped[it.scopeRel] ?? [];
        return { path: it.scopeRel, tags: allHave ? current.filter((t) => t.toLowerCase() !== key) : [...current, value] };
      });

    // 弹层保持打开：各标签的「全选/部分/无」勾选态随写入结果即时刷新，作为点击后的可视反馈

    try {
      const resp = await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_tags_bulk', scope, items: payload }),
      });
      const data = await resp.json();
      if (!data?.success) {
        showImageAiEditToast('Tagging failed', 'error');
        return;
      }
      // 以服务端规范化结果为准，一次性合并回本地标签表
      const applied = (data.tags ?? {}) as Record<string, string[]>;
      setFileTags((prev) => {
        const next = { ...prev, [scope]: { ...prev[scope] } };
        for (const [rel, tags] of Object.entries(applied)) {
          if (tags.length > 0) next[scope][rel] = tags;
          else delete next[scope][rel];
        }
        return next;
      });
      if (allHave) showImageAiEditToast(`Removed "${value}"`);
      else showImageAiEditToast(`Tagged ${payload.length} ${payload.length === 1 ? 'file' : 'files'} with "${value}"`);
    } catch (err) {
      console.error('批量保存标签失败:', err);
      showImageAiEditToast('Tagging failed', 'error');
    }
  }, [selection, selectionPaths, fileTags]);

  /** 分享文件（项目列式浏览 ⋮ 菜单）：生成局域网分享链接并复制到剪贴板（仅 .md 文档） */
  const handleRowShare = useCallback(async (filePath: string, fileName: string, isDir: boolean) => {
    setRowMenu(null);
    if (!isShareableDoc(fileName, isDir)) {
      showImageAiEditToast('Only Markdown documents can be shared', 'error');
      return;
    }
    try {
      const resp = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, title: fileName }),
      });
      const data = await resp.json();
      if (!data.success || !data.url) {
        showImageAiEditToast(`Share failed: ${data.error ?? 'unknown'}`, 'error');
        return;
      }
      await navigator.clipboard.writeText(data.url).catch(() => {});
      showImageAiEditToast(`Share link copied: ${data.url}`);
    } catch (err) {
      showImageAiEditToast(`Share failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, []);

  /** 删除文件/文件夹（项目列式浏览 ⋮ 菜单）：按路径归属分流到对应后端清理逻辑 */
  const handleRowDelete = useCallback((menu: { filePath: string; fileName: string; isDir: boolean; rel: string }) => {
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
              const canOpenFolder = isDesktop() && !!cp?.path;
              return (
                <div className="flex min-w-0 items-center rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--paper-hover)]">
                  {/* 项目图标即「打开项目文件夹」：原右侧 Open in Finder 按钮已并入此图标 */}
                  <button
                    type="button"
                    disabled={!canOpenFolder}
                    onClick={async () => {
                      if (!cp?.path) return;
                      const res = await desktop.openFile(cp.path);
                      if (!res.success && res.error) console.error('打开文件夹失败:', res.error);
                    }}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded disabled:cursor-default"
                    title={canOpenFolder ? 'Open in Finder' : 'No active project'}
                    aria-label="Open in Finder"
                  >
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: cp ? 'var(--primary)' : 'var(--ink-muted)' }} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => toggleWsSwitch(e)}
                    className="flex min-w-0 items-center gap-1 text-left text-sm"
                    title={cp ? `Switch project (${cp.name})` : 'No active project'}
                  >
                    <span className="max-w-[220px] truncate font-medium" style={{ color: cp ? 'var(--ink)' : 'var(--ink-muted)' }}>
                      {cp ? cp.name : 'No project'}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                  </button>
                </div>
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
                </>
              );
            })()}
            {/* materials 的操作（上传文件 / 上传文件夹 / 新建子文件夹 / 重命名 / 删除）与授权入口，已统一收敛至 materials 文件夹行右侧的 ⋮ 菜单 */}
            <div className="flex-1" />
            {/* 搜索框：随视图切换目标——Files 搜文件名（全树扁平匹配）/ Log 搜日志条目。
                onPointerDown 阻止冒泡，否则输入框内点击会触发标题栏拖动把手 */}
            <div className="relative min-w-[104px] max-w-[240px] flex-[2]" onPointerDown={(e) => e.stopPropagation()}>
              <Search
                className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2"
                style={{ color: 'var(--ink-faint)' }}
              />
              <input
                type="text"
                value={wsQuery}
                onChange={(e) => setWsQuery(e.target.value)}
                placeholder={wsView === 'files' ? 'Search files' : 'Search activity'}
                aria-label={wsView === 'files' ? 'Search files' : 'Search activity'}
                className="h-6 w-full cursor-text select-text rounded-md border bg-transparent pl-6 pr-5 text-xs outline-none transition-colors placeholder:text-[var(--ink-faint)]"
                style={{ borderColor: 'var(--line-soft)', color: 'var(--ink)' }}
              />
              {wsQuery && (
                <button
                  type="button"
                  onClick={() => setWsQuery('')}
                  className="absolute right-0.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-faint)' }}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {/* 视图切换：文件（Finder 列式）/ 日志（项目流水账） */}
            <div
              className="flex shrink-0 items-center gap-0.5 rounded-md p-0.5"
              style={{ backgroundColor: 'var(--paper-soft)' }}
            >
              {([['files', 'Files'], ['log', 'Log']] as const).map(([key, label]) => {
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
                    title={key === 'files' ? 'File tree' : 'Project activity'}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {/* 编译文稿（账本）：只读查看档案员归并出的条目，不落盘 */}
            <Button
              type="button"
              onClick={() => setLedgerOpen(true)}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Compiled ledger"
              aria-label="Compiled ledger"
            >
              <BookOpen className="h-3.5 w-3.5" />
            </Button>
            {/* 回收站（2026-09-12 自左侧栏迁入，替代原刷新按钮）；打开 workspace 已自动刷新，无需手动刷新 */}
            <Button
              type="button"
              onClick={() => window.dispatchEvent(new Event('trash-open'))}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="Trash"
              aria-label="Trash"
            >
              <Trash className="h-3.5 w-3.5" />
            </Button>
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
              <ProjectActivityLog
                projectId={currentId}
                refreshKey={logRefreshKey}
                query={wsLogQuery}
                onQueryChange={setWsLogQuery}
              />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
                No project
              </div>
            )
          )}

          {/* 主体（文件视图）：materials 扁平清单 + 标签筛选，其余目录为可折叠树（当前项目与切换已入标题栏） */}
          {wsView === 'files' && (
          <div className="flex min-h-0 flex-1">
            {(() => {
              const currentProject = projects.find((p) => p.id === currentId) || null;
              return (
                <>

                  {/* ── 右栏：当前项目文件清单 ──（拖入 OS 文件上传到 materials 根目录） */}
                  <div
                    className="relative flex min-w-0 flex-1 flex-col"
                    onDragOver={handleMaterialsDragOver}
                    onDragLeave={handleMaterialsDragLeave}
                    onDrop={handleMaterialsDrop}
                    style={materialsDragActive ? { outline: '1.5px dashed var(--primary)', outlineOffset: -2, backgroundColor: 'color-mix(in oklab, var(--primary) 5%, transparent)' } : undefined}
                  >
                    {materialsDragActive && (
                      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-2">
                        <span className="rounded-full px-2.5 py-1 text-xs" style={{ backgroundColor: 'var(--primary)', color: '#fff' }}>
                          Drop to upload to materials
                        </span>
                      </div>
                    )}
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
                        {/* 项目文件容器：本身不滚动，滚动交给内部列表（标签栏 / 多选条固定在顶部） */}
                        <div className="flex min-h-0 flex-1 flex-col px-1 py-1">
                          {(() => {
                            const roots = projectFiles.get(currentProject.id) || [];
                            const isLoading = loadingFiles.has(currentProject.id) && roots.length === 0;

                            if (roots.length === 0) {
                              return (
                                <div className="flex w-full items-center justify-center py-6 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                  {isLoading ? 'Loading...' : 'Empty'}
                                </div>
                              );
                            }

                            // 搜索态：全树扁平匹配（目录/文件名 + 会话标题），命中以「文件名 + 所在路径」列表呈现
                            const fileQuery = wsFileQuery.trim().toLowerCase();
                            if (fileQuery) {
                              const hits: {
                                rel: string;
                                name: string;
                                label: string;
                                isDir: boolean;
                                extension?: string;
                                parent: string[];
                                /** 命中项的所有祖先目录 rel：点击时逐层展开，使结果在树中可见 */
                                ancestorRels: string[];
                              }[] = [];
                              const walk = (nodes: FileNode[], prefix: string[], ancestorRels: string[]) => {
                                for (const n of nodes) {
                                  const rel = n.rel ?? (prefix.length ? [...prefix, n.name].join('/') : n.name);
                                  const label = n.title || n.name;
                                  if (n.name.toLowerCase().includes(fileQuery) || label.toLowerCase().includes(fileQuery)) {
                                    hits.push({ rel, name: n.name, label, isDir: n.type === 'directory', extension: n.extension, parent: prefix, ancestorRels });
                                  }
                                  if (n.type === 'directory' && n.children?.length) walk(n.children, [...prefix, n.name], [...ancestorRels, rel]);
                                }
                              };
                              walk(roots, [], []);
                              return (
                                <div className="flex w-full flex-1 flex-col">
                                  <div className="shrink-0 px-1.5 py-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                    {hits.length === 0 ? 'No matching files' : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}
                                  </div>
                                  {hits.map((h) => (
                                    <button
                                      key={h.rel}
                                      type="button"
                                      onClick={() => {
                                        // 目录 → 展开其祖先链与自身；文件 → 展开祖先链并打开
                                        updateWsExpanded((prev) => new Set([...prev, ...h.ancestorRels, ...(h.isDir ? [h.rel] : [])]));
                                        if (!h.isDir) bus.publish(BusEvents.fileOpen, { source: 'project', path: h.rel, name: h.name });
                                      }}
                                      className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                                      title={h.rel}
                                    >
                                      {h.isDir ? (
                                        <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                                      ) : (
                                        <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: fileIcon(h.extension).color }} />
                                      )}
                                      <span className="shrink-0 truncate" style={{ color: 'var(--ink)' }}>
                                        {h.label}
                                      </span>
                                      {h.parent.length > 0 && (
                                        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--ink-faint)' }}>
                                          {h.parent.join('/')}
                                        </span>
                                      )}
                                    </button>
                                  ))}
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
                            // materials / homework 目录 ⋮ 按钮：菜单收纳上传 / 授权 / 进入多选等目录级操作。
                            // 根行内为 hover 渐显；标签栏上常显（alwaysVisible=true）并取更小尺寸（compact=true）
                            const dirMenuButton = (rel: string, scope: TagScope, alwaysVisible = false, compact = false) => (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setMaterialsMenu({
                                    x: rect.right - 192,
                                    y: rect.bottom + 4,
                                    rel,
                                    name: rel.split('/').pop() || rel,
                                    isRoot: true,
                                    scope,
                                  });
                                }}
                                className={cn(
                                  'flex shrink-0 items-center justify-center rounded transition-opacity hover:bg-[var(--paper-hover)] hover:opacity-100',
                                  compact ? 'h-4 w-4' : 'h-5 w-5',
                                  !alwaysVisible && 'opacity-0 group-hover:opacity-100',
                                )}
                                style={{ color: 'var(--ink-muted)' }}
                                title="More actions"
                                aria-label="More actions"
                              >
                                <MoreVertical className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
                              </button>
                            );

                            // 资料已统一为单一 materials 目录：界面不再分组（树内拖拽随之取消），
                            // 改为扁平文件清单 + 自定义标签筛选。
                            const materialsNode = roots.find((n) => (n.rel ?? n.name) === 'materials') || null;
                            /** 资料行：rel 为项目内相对路径，parent 为所在子目录链（扁平后用于提示历史嵌套） */
                            interface MaterialRow { rel: string; name: string; parent: string[]; extension?: string }
                            /** 摊平 materials 子树：目录仅用于定位，最终以文件为单位成列 */
                            const flattenMaterials = (nodes: FileNode[], prefix: string[]): MaterialRow[] => {
                              const out: MaterialRow[] = [];
                              for (const n of nodes) {
                                const rel = n.rel ?? (prefix.length ? [...prefix, n.name].join('/') : n.name);
                                if (n.type === 'directory') {
                                  if (n.children?.length) out.push(...flattenMaterials(n.children, [...prefix, n.name]));
                                  continue;
                                }
                                out.push({ rel, name: n.name, parent: prefix, extension: n.extension });
                              }
                              return out;
                            };
                            const materialRows = materialsNode?.children?.length
                              ? flattenMaterials(materialsNode.children, ['materials'])
                              : [];
                            /** 作用域根相对路径（即标签表键）：如 materials/a/b.pdf → a/b.pdf */
                            const scopeRel = (scope: TagScope, rel: string): string =>
                              rel.startsWith(scope + '/') ? rel.slice(scope.length + 1) : rel;
                            /** 某文件的标签（标签表键为所在作用域根下的相对路径） */
                            const tagsOfRel = (scope: TagScope, rel: string): string[] =>
                              fileTags[scope][scopeRel(scope, rel)] ?? [];
                            /** 该行是否通过当前标签筛选（单选）：'' 为 All（全部通过），UNTAGGED_FILTER 仅匹配无标签行 */
                            const matchesTagFilter = (scope: TagScope, rel: string): boolean => {
                              const sel = tagFilter[scope];
                              if (!sel) return true;
                              const tags = tagsOfRel(scope, rel).map((t) => t.toLowerCase());
                              if (sel === UNTAGGED_FILTER) return tags.length === 0;
                              return tags.includes(sel.toLowerCase());
                            };
                            const visibleMaterialRows = materialRows.filter((row) => matchesTagFilter('materials', row.rel));
                            /** 收集 materials 下的全部子目录（项目内相对路径）：空文件夹也要作为分组出现，才能拖入 */
                            const collectMaterialDirs = (nodes: FileNode[], prefix: string[]): string[] => {
                              const out: string[] = [];
                              for (const n of nodes) {
                                if (n.type !== 'directory') continue;
                                out.push(n.rel ?? [...prefix, n.name].join('/'));
                                if (n.children?.length) out.push(...collectMaterialDirs(n.children, [...prefix, n.name]));
                              }
                              return out;
                            };
                            /** 分组视图：按文件所在的来源文件夹归组（直属 materials 根的归入 Root 组，恒排最后）。
                             *  不做标签筛选时列出全部文件夹（含空文件夹，供拖入）；筛选时只保留有命中文件的分组 */
                            const materialGroups = (() => {
                              if (!materialsGrouped) return [] as { dir: string; title: string; rows: MaterialRow[] }[];
                              const rowsByDir = new Map<string, MaterialRow[]>();
                              for (const row of visibleMaterialRows) {
                                const dir = row.parent.join('/'); // 含首段 materials
                                const list = rowsByDir.get(dir);
                                if (list) list.push(row);
                                else rowsByDir.set(dir, [row]);
                              }
                              const filtering = tagFilter.materials !== '';
                              const dirs = filtering
                                ? [...rowsByDir.keys()]
                                : ['materials', ...collectMaterialDirs(materialsNode?.children ?? [], ['materials']), ...rowsByDir.keys()];
                              const groups = [...new Set(dirs)].map((dir) => ({
                                dir,
                                title: dir === 'materials' ? 'Root' : dir.slice('materials/'.length),
                                rows: rowsByDir.get(dir) ?? [],
                              }));
                              const root = groups.filter((g) => g.dir === 'materials');
                              const others = groups
                                .filter((g) => g.dir !== 'materials')
                                .sort((a, b) => a.title.localeCompare(b.title, 'zh'));
                              return [...others, ...root];
                            })();
                            /** 打开某作用域的标签编辑弹层（行内 Tag 按钮 / 标签胶囊共用） */
                            const openTagEditor = (
                              e: React.MouseEvent<HTMLButtonElement>,
                              scope: TagScope,
                              rel: string,
                            ) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setTagFilterMenu(null);
                              setTagDraft('');
                              setTagEditor({ x: rect.right - 208, y: rect.bottom + 4, scope, rel });
                            };
                            /** 根行筛选按钮：点击展开该作用域的标签筛选下拉（有选中项时高亮） */
                            const tagFilterButton = (scope: TagScope, compact = false) => {
                              const selected = tagFilter[scope];
                              const active = selected !== '';
                              return (
                                <button
                                  type="button"
                                  data-tag-filter-trigger
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    setTagEditor(null);
                                    setTagFilterMenu((prev) => (
                                      prev && prev.scope === scope
                                        ? null
                                        : { x: rect.right - 208, y: rect.bottom + 4, scope }
                                    ));
                                  }}
                                  className={cn(
                                    'flex shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]',
                                    compact ? 'h-4 w-4' : 'h-5 w-5',
                                  )}
                                  style={{ color: active ? 'var(--primary)' : 'var(--ink-muted)' }}
                                  title={active ? `Filtering by "${selected === UNTAGGED_FILTER ? 'Untagged' : selected}"` : 'Filter by tag'}
                                  aria-label="Filter by tag"
                                >
                                  <Filter className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
                                </button>
                              );
                            };

                            /** 多选：当前是否处于该作用域的多选态（仅同作用域的行可勾选） */
                            const inSelection = (scope: TagScope): boolean => selection?.scope === scope;
                            /** 多选：勾选框（选中填充主色 + 对勾） */
                            const selectCheckbox = (checked: boolean) => (
                              <span
                                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border"
                                style={{
                                  borderColor: checked ? 'var(--primary)' : 'var(--line)',
                                  backgroundColor: checked ? 'var(--primary)' : 'transparent',
                                }}
                              >
                                {checked && <Check className="h-2.5 w-2.5" style={{ color: '#fff' }} />}
                              </span>
                            );

                            /** 资料根行展开态：与 homework / attachments 共用 wsExpanded（默认展开，按项目持久化）。
                             *  两栏项目下根行已移除，此态不参与渲染 */
                            const materialsExpanded = wsExpanded.has('materials');

                            /** 资料根行：可折叠（清单已扁平，折叠即收起文件列表）；上传 / 授权等目录级操作集中在顶部标签栏。
                             *  仅在单栏项目（无标签栏）下渲染 */
                            const renderMaterialsRoot = (node: FileNode) => (
                              <div key="materials" className="group relative flex items-center rounded-md pr-1 transition-colors" style={{ paddingLeft: 6 }}>
                                {/* 折叠箭头已移除（与内容行首缩进对齐留空）：点击根行名称仍可折叠 / 展开 */}
                                <span className="h-4 w-4 shrink-0" />
                                <button
                                  type="button"
                                  onClick={() => toggleWsDir('materials')}
                                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                                  title={node.title || node.name}
                                >
                                  {materialsExpanded ? (
                                    <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                  ) : (
                                    <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                                  )}
                                  <span className="min-w-0 truncate" style={{ color: 'var(--ink)' }}>
                                    {node.title || node.name}
                                  </span>
                                  {/* 筛选 / 计数 / ⋮ 已移至顶部标签栏；仅单栏项目（无标签栏）时留在根行 */}
                                  {!tabbedRoots && tagFilterButton('materials')}
                                  {!tabbedRoots && (
                                    <span className="shrink-0 text-11" style={{ color: 'var(--ink-faint)' }}>
                                      {`(${materialRows.length})`}
                                    </span>
                                  )}
                                  <span className="min-w-0 flex-1" />
                                </button>
                                {!tabbedRoots && dirMenuButton('materials', 'materials')}
                              </div>
                            );

                            /** 资料文件行：图标 + 文件名 + 归属子目录 + 标签 + 解析中 + 行操作 */
                            const renderMaterialRow = (row: MaterialRow) => {
                              const materialsRel = scopeRel('materials', row.rel);
                              const tags = tagsOfRel('materials', row.rel);
                              const parsing = parsingFiles.has(`${currentProject.id}::${materialsRel}`);
                              const indexError = failedIndexFiles.get(`${currentProject.id}::${materialsRel}`);
                              const parentPath = row.parent.slice(1).join('/'); // 去掉首段 materials
                              const editTags = (e: React.MouseEvent<HTMLButtonElement>) =>
                                openTagEditor(e, 'materials', materialsRel);
                              // 多选态：整行点击改为勾选 / 取消勾选，行内标签与 ⋮ 暂时让位
                              const selectable = inSelection('materials');
                              const selected = selectable && (selection?.rels.has(row.rel) ?? false);
                              return (
                                <div
                                  key={row.rel}
                                  draggable
                                  onDragStart={(e) => {
                                    // 侧栏内部拖拽：分组视图把它拖到另一个来源文件夹即为真实移动
                                    e.dataTransfer.setData(WS_ROW_DRAG_MIME, row.rel);
                                    e.dataTransfer.effectAllowed = 'move';
                                  }}
                                  onDragEnd={() => setDragOverGroup(null)}
                                  className={cn('group relative flex items-center rounded-md pr-1 pl-[26px] transition-colors', selected && 'bg-[var(--paper-hover)]')}
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (selectable) { toggleSelected(row.rel); return; }
                                      bus.publish(BusEvents.fileOpen, { source: 'project', path: row.rel, name: row.name });
                                    }}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                                    title={row.rel}
                                  >
                                    {selectable ? selectCheckbox(selected) : (
                                      <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: fileIcon(row.extension).color }} />
                                    )}
                                    <span className="shrink-0 truncate" style={{ color: 'var(--ink)' }}>
                                      {row.name}
                                    </span>
                                    {/* 分组视图下所在文件夹已由分组标题承担，行内不再重复显示 */}
                                    {parentPath && !materialsGrouped && (
                                      <span
                                        className="min-w-0 max-w-[140px] truncate text-9 italic opacity-0 transition-opacity group-hover:opacity-100"
                                        style={{ color: 'var(--ink-faint)' }}
                                      >
                                        {parentPath}
                                      </span>
                                    )}
                                  </button>
                                  {renderTagChips(tags, !selectable, editTags)}
                                  {!selectable && (
                                    <button
                                      type="button"
                                      onClick={editTags}
                                      className={cn(
                                        'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-[var(--paper-hover)]',
                                        tags.length > 0 ? 'opacity-60 hover:opacity-100' : 'opacity-0 hover:opacity-100 group-hover:opacity-100',
                                      )}
                                      style={{ color: 'var(--ink-muted)' }}
                                      title="Edit tags"
                                      aria-label="Edit tags"
                                    >
                                      <Tag className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {parsing && (
                                    <span
                                      className="flex shrink-0 items-center gap-1 pr-1 text-10"
                                      style={{ color: 'var(--ink-muted)' }}
                                      title="Indexing content (local processing, no token cost)"
                                    >
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      Parsing
                                    </span>
                                  )}
                                  {indexError && !parsing && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void retryMaterialIndex(row.rel);
                                      }}
                                      className="flex shrink-0 items-center gap-1 pr-1 text-10 transition-opacity hover:opacity-70"
                                      style={{ color: 'var(--danger)' }}
                                      title={`Content indexing failed: ${indexError}`}
                                    >
                                      <AlertTriangle className="h-3 w-3" />
                                      Retry
                                    </button>
                                  )}
                                  {!selectable && rowMenuButton({ name: row.name, type: 'file', extension: row.extension }, row.rel, false)}
                                </div>
                              );
                            };

                            /** materials 区块：文件清单（扁平，或按来源文件夹分组）。
                             *  两栏项目下根行已移除（名称 / 计数由顶部标签栏承担），列表恒展开；
                             *  单栏项目保留根行，仍可用它折叠列表 */
                            const renderMaterialsBlock = (node: FileNode) => (
                              <div key="materials" className="flex flex-col">
                                {!tabbedRoots && renderMaterialsRoot(node)}
                                {(tabbedRoots || materialsExpanded) && (
                                  <>
                                    {materialRows.length === 0 ? (
                                      <div className="px-2 pb-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                        No materials yet
                                      </div>
                                    ) : visibleMaterialRows.length === 0 ? (
                                      <div className="px-2 pb-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                        No files match the selected tags
                                      </div>
                                    ) : materialsGrouped ? (
                                      materialGroups.map((group, i) => (
                                        <div
                                          key={group.dir}
                                          // 拖拽落点：把侧栏内部拖来的资料行移到该来源文件夹（OS 文件拖入仍走外层容器的既有逻辑）
                                          onDragOver={(e) => {
                                            if (!e.dataTransfer.types.includes(WS_ROW_DRAG_MIME)) return;
                                            e.preventDefault();
                                            e.dataTransfer.dropEffect = 'move';
                                            setDragOverGroup(group.dir);
                                          }}
                                          onDragLeave={() => setDragOverGroup((prev) => (prev === group.dir ? null : prev))}
                                          onDrop={(e) => {
                                            const rel = e.dataTransfer.getData(WS_ROW_DRAG_MIME);
                                            if (!rel) return; // 非侧栏内部拖拽：交给外层容器处理
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setDragOverGroup(null);
                                            void handleRowMove(rel, group.dir);
                                          }}
                                          className={cn(
                                            'flex flex-col rounded-md transition-colors',
                                            i > 0 && 'mt-1 border-t pt-1',
                                            dragOverGroup === group.dir && 'bg-[var(--paper-hover)]',
                                          )}
                                          style={i > 0 ? { borderColor: 'var(--line-soft)' } : undefined}
                                        >
                                          {/* 分组标题：点击折叠 / 展开该分组（无折叠符号），右侧为该来源文件夹下的文件数；root（未分组）不提供删除 */}
                                          <div className="group/head flex items-center rounded-md transition-colors">
                                            <button
                                              type="button"
                                              onClick={() => toggleWsGroupCollapsed(`${currentProject.id}|m:${group.dir}`)}
                                              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                                              title={group.title}
                                            >
                                              <Folder className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                                              <span className="min-w-0 truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                                                {group.title}
                                              </span>
                                              <span className="shrink-0 text-9" style={{ color: 'var(--ink-faint)' }}>
                                                {`(${group.rows.length})`}
                                              </span>
                                            </button>
                                            {group.dir !== 'materials' && (
                                              <button
                                                onClick={() => void handleDissolveGroup(group.dir, group.title)}
                                                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover/head:opacity-100"
                                                style={{ color: 'var(--ink-faint)' }}
                                                title="Delete group (files move to the ungrouped folder)"
                                              >
                                                <Trash className="h-3 w-3" />
                                              </button>
                                            )}
                                          </div>
                                          {!collapsedWsGroups.has(`${currentProject.id}|m:${group.dir}`) && group.rows.map(renderMaterialRow)}
                                        </div>
                                      ))
                                    ) : (
                                      visibleMaterialRows.map(renderMaterialRow)
                                    )}
                                  </>
                                )}
                              </div>
                            );

                            // homework 同为界面扁平化（磁盘保持现状）：目录降级为行内小字归属提示，
                            // 不再层层展开。深度优先摊平，使同一文件夹内的文件在清单中自然相邻。
                            const homeworkNode = roots.find((n) => (n.rel ?? n.name) === 'homework') || null;
                            /** 作业行：rel 为项目内相对路径，parent 为所在子目录链（扁平后用于提示归属） */
                            interface HomeworkRow { rel: string; name: string; parent: string[]; extension?: string }
                            /** 摊平 homework 子树：目录仅用于定位，最终以文件为单位成列 */
                            const flattenHomework = (nodes: FileNode[], prefix: string[]): HomeworkRow[] => {
                              const out: HomeworkRow[] = [];
                              for (const n of nodes) {
                                const rel = n.rel ?? (prefix.length ? [...prefix, n.name].join('/') : n.name);
                                if (n.type === 'directory') {
                                  if (n.children?.length) out.push(...flattenHomework(n.children, [...prefix, n.name]));
                                  continue;
                                }
                                out.push({ rel, name: n.name, parent: prefix, extension: n.extension });
                              }
                              return out;
                            };
                            const homeworkRows = homeworkNode?.children?.length
                              ? flattenHomework(homeworkNode.children, ['homework'])
                              : [];
                            const visibleHomeworkRows = homeworkRows.filter((row) => matchesTagFilter('homework', row.rel));

                            /** 当前项目的 homework 归属表：文件（相对 homework 根）→ 来源会话 */
                            const homeworkOwnerMap = homeworkOwners.get(currentProject.id) ?? {};
                            /** 无归属（手动放入 / 老数据无清册条目）的兜底分组键，恒排最后 */
                            const HOMEWORK_UNGROUPED = '\u0000ungrouped';
                            /** 分组视图：按来源会话把可见文件行归组，组间以横线分隔 */
                            const homeworkGroups = (() => {
                              if (!homeworkGrouped) return [] as { key: string; title: string; rows: HomeworkRow[]; latest: number }[];
                              const byKey = new Map<string, { key: string; title: string; rows: HomeworkRow[]; latest: number }>();
                              for (const row of visibleHomeworkRows) {
                                const owner = homeworkOwnerMap[scopeRel('homework', row.rel)];
                                const key = owner?.nodeId || HOMEWORK_UNGROUPED;
                                let group = byKey.get(key);
                                if (!group) {
                                  group = {
                                    key,
                                    title: owner ? (owner.title?.trim() || owner.nodeId.slice(0, 8)) : 'Ungrouped',
                                    rows: [],
                                    latest: 0,
                                  };
                                  byKey.set(key, group);
                                }
                                group.rows.push(row);
                                // 组排序依据：该会话最新产出文件的 mtime
                                if (owner) group.latest = Math.max(group.latest, owner.mtimeMs);
                              }
                              // 会话组按最近产出倒序；Ungrouped 恒排最后
                              const list = [...byKey.values()]
                                .filter((g) => g.key !== HOMEWORK_UNGROUPED)
                                .sort((a, b) => b.latest - a.latest);
                              const ungrouped = byKey.get(HOMEWORK_UNGROUPED);
                              if (ungrouped) list.push(ungrouped);
                              return list;
                            })();

                            /** 作业根行展开态：与 materials / attachments 共用 wsExpanded（首开默认折叠，按项目持久化）。
                             *  两栏项目下根行已移除，此态不参与渲染 */
                            const homeworkExpanded = wsExpanded.has('homework');

                            /** 作业根行：可折叠（清单已扁平，折叠即收起文件列表）。仅在单栏项目（无标签栏）下渲染 */
                            const renderHomeworkRoot = (node: FileNode) => (
                              <div key="homework" className="group relative flex items-center rounded-md pr-1 transition-colors" style={{ paddingLeft: 6 }}>
                                {/* 折叠箭头已移除（与内容行首缩进对齐留空）：点击根行名称仍可折叠 / 展开 */}
                                <span className="h-4 w-4 shrink-0" />
                                <button
                                  type="button"
                                  onClick={() => toggleWsDir('homework')}
                                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                                  title={node.title || node.name}
                                >
                                  {homeworkExpanded ? (
                                    <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                  ) : (
                                    <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                                  )}
                                  <span className="min-w-0 truncate" style={{ color: 'var(--ink)' }}>
                                    {node.title || node.name}
                                  </span>
                                  {/* 筛选 / 计数 / ⋮ 已移至顶部标签栏；仅单栏项目（无标签栏）时留在根行。
                                      会话分组切换（原 MessagesSquare 图标按钮）统一收进 ⋮ 菜单。 */}
                                  {!tabbedRoots && tagFilterButton('homework')}
                                  {!tabbedRoots && (
                                    <span className="shrink-0 text-11" style={{ color: 'var(--ink-faint)' }}>
                                      {`(${homeworkRows.length})`}
                                    </span>
                                  )}
                                  <span className="min-w-0 flex-1" />
                                </button>
                                {!tabbedRoots && dirMenuButton('homework', 'homework')}
                              </div>
                            );

                            /** 作业文件行：图标 + 文件名 + 归属子目录 + 标签 + 行操作 */
                            const renderHomeworkRow = (row: HomeworkRow) => {
                              const homeworkRel = scopeRel('homework', row.rel);
                              const tags = tagsOfRel('homework', row.rel);
                              const parentPath = row.parent.slice(1).join('/'); // 去掉首段 homework
                              const editTags = (e: React.MouseEvent<HTMLButtonElement>) =>
                                openTagEditor(e, 'homework', homeworkRel);
                              // 多选态：整行点击改为勾选 / 取消勾选，行内标签与 ⋮ 暂时让位
                              const selectable = inSelection('homework');
                              const selected = selectable && (selection?.rels.has(row.rel) ?? false);
                              return (
                                <div
                                  key={row.rel}
                                  className={cn('group relative flex items-center rounded-md pr-1 pl-[26px] transition-colors', selected && 'bg-[var(--paper-hover)]')}
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (selectable) { toggleSelected(row.rel); return; }
                                      bus.publish(BusEvents.fileOpen, { source: 'project', path: row.rel, name: row.name });
                                    }}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                                    title={row.rel}
                                  >
                                    {selectable ? selectCheckbox(selected) : (
                                      <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: fileIcon(row.extension).color }} />
                                    )}
                                    <span className="shrink-0 truncate" style={{ color: 'var(--ink)' }}>
                                      {row.name}
                                    </span>
                                    {parentPath && (
                                      <span
                                        className="min-w-0 max-w-[140px] truncate text-9 italic opacity-0 transition-opacity group-hover:opacity-100"
                                        style={{ color: 'var(--ink-faint)' }}
                                      >
                                        {parentPath}
                                      </span>
                                    )}
                                  </button>
                                  {renderTagChips(tags, !selectable, editTags)}
                                  {!selectable && (
                                    <button
                                      type="button"
                                      onClick={editTags}
                                      className={cn(
                                        'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-[var(--paper-hover)]',
                                        tags.length > 0 ? 'opacity-60 hover:opacity-100' : 'opacity-0 hover:opacity-100 group-hover:opacity-100',
                                      )}
                                      style={{ color: 'var(--ink-muted)' }}
                                      title="Edit tags"
                                      aria-label="Edit tags"
                                    >
                                      <Tag className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {!selectable && rowMenuButton({ name: row.name, type: 'file', extension: row.extension }, row.rel, false)}
                                </div>
                              );
                            };

                            /** homework 区块：文件清单（扁平，或按来源会话分组）。
                             *  两栏项目下根行已移除（名称 / 计数由顶部标签栏承担），列表恒展开；
                             *  单栏项目保留根行，仍可用它折叠列表 */
                            const renderHomeworkBlock = (node: FileNode) => (
                              <div key="homework" className="flex flex-col">
                                {!tabbedRoots && renderHomeworkRoot(node)}
                                {(tabbedRoots || homeworkExpanded) && (
                                  homeworkRows.length === 0 ? (
                                    <div className="px-2 pb-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                      No files yet
                                    </div>
                                  ) : visibleHomeworkRows.length === 0 ? (
                                    <div className="px-2 pb-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                      No files match the selected tags
                                    </div>
                                  ) : homeworkGrouped ? (
                                    homeworkGroups.map((group, i) => (
                                      <div
                                        key={group.key}
                                        className={cn('flex flex-col', i > 0 && 'mt-1 border-t pt-1')}
                                        style={i > 0 ? { borderColor: 'var(--line-soft)' } : undefined}
                                      >
                                        {/* 分组标题：点击折叠 / 展开该分组（无折叠符号），右侧为该会话产出的文件数 */}
                                        <button
                                          type="button"
                                          onClick={() => toggleWsGroupCollapsed(`${currentProject.id}|h:${group.key}`)}
                                          className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                                          title={group.title}
                                        >
                                          <MessagesSquare className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                                          <span className="min-w-0 truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                                            {group.title}
                                          </span>
                                          <span className="shrink-0 text-9" style={{ color: 'var(--ink-faint)' }}>
                                            {`(${group.rows.length})`}
                                          </span>
                                        </button>
                                        {!collapsedWsGroups.has(`${currentProject.id}|h:${group.key}`) && group.rows.map(renderHomeworkRow)}
                                      </div>
                                    ))
                                  ) : (
                                    visibleHomeworkRows.map(renderHomeworkRow)
                                  )
                                )}
                              </div>
                            );

                            /** 树行：折叠箭头 + 图标 + 名称 + 行尾操作（attachments 等仍为可折叠树） */
                            const renderTreeRow = (node: FileNode, prefix: string[], depth: number): ReactNode => {
                              const rel = node.rel ?? (prefix.length ? [...prefix, node.name].join('/') : node.name);
                              const isDir = node.type === 'directory';
                              const hasChildren = isDir && (node.children?.length ?? 0) > 0;
                              const expanded = isDir && wsExpanded.has(rel);
                              const rowStyle: React.CSSProperties = {
                                paddingLeft: 6 + depth * 14,
                                ...(expanded ? { backgroundColor: 'color-mix(in oklab, var(--primary) 9%, transparent)' } : {}),
                              };
                              return (
                                <div key={rel} className="flex flex-col">
                                  <div className="group relative flex items-center rounded-md pr-1 transition-colors" style={rowStyle}>
                                    {isDir ? (
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); if (hasChildren) toggleWsDir(rel); }}
                                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
                                        style={{ color: 'var(--ink-muted)', visibility: hasChildren ? 'visible' : 'hidden' }}
                                        title={expanded ? 'Collapse' : 'Expand'}
                                        aria-label={expanded ? 'Collapse' : 'Expand'}
                                      >
                                        <ChevronRight className="h-3 w-3 transition-transform" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} />
                                      </button>
                                    ) : (
                                      <span className="h-4 w-4 shrink-0" />
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (!isDir) {
                                          bus.publish(BusEvents.fileOpen, { source: 'project', path: rel, name: node.name });
                                          return;
                                        }
                                        // 目录：折叠 / 展开（拖拽归组已取消，选中态不再需要）
                                        if (hasChildren) toggleWsDir(rel);
                                      }}
                                      className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-[var(--paper-hover)]"
                                      title={isDir ? (node.title || node.name) : node.name}
                                    >
                                      {isDir ? (
                                        expanded ? (
                                          <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                        ) : (
                                          <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                                        )
                                      ) : (
                                        <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: fileIcon(node.extension).color }} />
                                      )}
                                      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--ink)' }}>
                                        {isDir ? (node.title || node.name) : node.name}
                                      </span>
                                    </button>
                                    {isDir
                                      ? (!DEFAULT_ROOT_DIRS.has(rel) && rowMenuButton(node, rel, true))
                                      : rowMenuButton(node, rel, false)}
                                  </div>
                                  {expanded && hasChildren && (
                                    <div className="flex flex-col">
                                      {node.children!.map((ch) => renderTreeRow(ch, [...prefix, node.name], depth + 1))}
                                    </div>
                                  )}
                                </div>
                              );
                            };

                            /** 根目录标签栏：materials / homework 两栏切换（一次只显示一栏；其他目录仍在下方顺排）。
                             *  两栏等宽平分，不随选中态伸缩；目录级操作（标签筛选 / 分组切换 / ⋮ 更多）
                             *  统一收在该栏的标签上，随选中态显示；两栏项目下这两栏的根行不再渲染，名称 / 计数完全由标签承担 */
                            const renderRootTabs = (active: 'materials' | 'homework') => (
                              <div
                                className="mx-2 mb-1 flex items-center gap-0.5 rounded-md p-px"
                                style={{ backgroundColor: 'color-mix(in oklab, var(--line-soft) 80%, transparent)' }}
                              >
                                {(['materials', 'homework'] as const).map((key) => {
                                  const isActive = key === active;
                                  const count = key === 'materials' ? materialRows.length : homeworkRows.length;
                                  return (
                                    <div
                                      key={key}
                                      className="relative flex min-w-0 flex-1 items-center rounded"
                                      style={isActive ? { backgroundColor: 'var(--paper)', boxShadow: 'var(--shadow-sm)' } : undefined}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => setWsRootTab(key)}
                                        className={cn(
                                          'flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-1.5 py-0.5 text-11 transition-colors',
                                          !isActive && 'hover:bg-[var(--paper-hover)]',
                                        )}
                                        style={{ color: isActive ? 'var(--ink)' : 'var(--ink-muted)' }}
                                        title={isActive ? `Showing ${key}` : `Show ${key}`}
                                      >
                                        <span className="min-w-0 truncate">{key === 'materials' ? 'Materials' : 'Homework'}</span>
                                        <span className="shrink-0 text-9" style={{ color: 'var(--ink-faint)' }}>{`(${count})`}</span>
                                      </button>
                                      {/* 目录级操作按钮：绝对贴右（不参与标题居中计算），切栏时标题位置保持不变 */}
                                      {isActive && (
                                        <div className="absolute right-0 top-0 flex h-full items-center gap-0.5 pr-0.5">
                                          {tagFilterButton(key, true)}
                                          {dirMenuButton(key, key, true, true)}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );

                            const hasMaterialsRoot = roots.some((n) => (n.rel ?? n.name) === 'materials');
                            const hasHomeworkRoot = roots.some((n) => (n.rel ?? n.name) === 'homework');
                            /** 两栏都在才有标签栏；只有一栏时直接用该栏，标签栏隐藏 */
                            const tabbedRoots = hasMaterialsRoot && hasHomeworkRoot;
                            const activeRootTab: 'materials' | 'homework' = tabbedRoots
                              ? wsRootTab
                              : (hasHomeworkRoot ? 'homework' : 'materials');

                            return (
                              <>
                                {/* 标签栏固定在顶部；多选条紧随其下：两者都在滚动列表之外，不随列表滚动 */}
                                {tabbedRoots && renderRootTabs(activeRootTab)}
                                {selection && (() => {
                                  const scope = selection.scope;
                                  const count = selection.rels.size;
                                  const allRels = allRelsInScope(scope);
                                  const allSelected = allRels.length > 0 && allRels.every((rel) => selection.rels.has(rel));
                                  const barButton = (
                                    icon: React.ReactNode,
                                    label: string,
                                    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void,
                                    opts?: { disabled?: boolean; danger?: boolean; title?: string },
                                  ) => (
                                    <button
                                      type="button"
                                      onClick={onClick}
                                      disabled={opts?.disabled}
                                      title={opts?.title ?? label}
                                      className="flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-10 transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                                      style={{ color: opts?.danger ? 'var(--danger)' : 'var(--ink)' }}
                                    >
                                      {icon}
                                      {label}
                                    </button>
                                  );
                                  // 多选条：无背景无边框，仅用下方一条分隔线与列表隔开
                                  return (
                                    <div
                                      className="mb-1 flex shrink-0 flex-wrap items-center gap-0.5 border-b px-1 pb-1"
                                      style={{ borderColor: 'var(--line-soft)' }}
                                    >
                                      <span className="shrink-0 px-1 text-10" style={{ color: 'var(--ink-muted)' }}>
                                        {count} selected
                                      </span>
                                      {barButton(
                                        <Check className="h-3 w-3" />,
                                        allSelected ? 'Clear' : 'All',
                                        () => setSelection((prev) => (prev ? { ...prev, rels: allSelected ? new Set() : new Set(allRels) } : prev)),
                                        { title: allSelected ? 'Clear selection' : `Select all in ${scope}` },
                                      )}
                                      {barButton(
                                        <Tag className="h-3 w-3" />,
                                        'Tag',
                                        (e) => {
                                          const rect = e.currentTarget.getBoundingClientRect();
                                          setTagDraft('');
                                          setBatchTagMenu({ x: rect.right - 176, y: rect.bottom + 4 });
                                        },
                                        { disabled: count === 0, title: 'Add or remove a tag on the selected files' },
                                      )}
                                      {barButton(
                                        <Archive className="h-3 w-3" />,
                                        'Archive',
                                        () => { void handleBatchArchive(); },
                                        { disabled: count === 0, title: 'Move selected files to the archive' },
                                      )}
                                      {barButton(
                                        <Copy className="h-3 w-3" />,
                                        'Copy',
                                        () => { void handleBatchCopy(); setSelection(null); },
                                        { disabled: count === 0, title: 'Duplicate the selected files in place' },
                                      )}
                                      {barButton(
                                        <Download className="h-3 w-3" />,
                                        'Download',
                                        () => { void handleBatchDownload(); },
                                        { disabled: count === 0, title: 'Save copies to a local folder (e.g. Desktop)' },
                                      )}
                                      {barButton(
                                        <Trash className="h-3 w-3" />,
                                        'Delete',
                                        () => { void handleBatchDelete(); },
                                        { disabled: count === 0, danger: true, title: 'Delete selected files' },
                                      )}
                                      {barButton(
                                        <X className="h-3 w-3" />,
                                        'Cancel',
                                        () => { setBatchTagMenu(null); setSelection(null); },
                                        { title: 'Exit selection (Esc)' },
                                      )}
                                    </div>
                                  );
                                })()}
                                {/* 文件清单：唯一的滚动区（隐藏滚动条，仍可滚动） */}
                                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto hide-scrollbar">
                                  {roots.map((n) => {
                                    const rootRel = n.rel ?? n.name;
                                    if (rootRel === 'materials') return activeRootTab === 'materials' ? renderMaterialsBlock(n) : null;
                                    if (rootRel === 'homework') return activeRootTab === 'homework' ? renderHomeworkBlock(n) : null;
                                    return renderTreeRow(n, [], 0);
                                  })}
                                </div>
                              </>
                            );
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

          {/* 右缘调宽把手（无可见视觉，仍可拖动调宽） */}
          <div
            data-ws-resize
            onPointerDown={(e) => startResize(e)}
            className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none select-none"
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

      {/* 新建项目对话框（portal 到 body，避免被浮层祖先 z-40 stacking context 囚禁在画布 UI 层 z-[1500] 之下） */}
      {createDialogOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[1600] flex items-center justify-center"
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
        </div>,
        document.body,
      )}

      {/* 节点回收站对话框 */}
      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} projectId={projectId} />

      {/* 编译文稿（只读）：账本 wiki 条目现拼成一份文稿，磁盘不落盘 */}
      <LedgerDocPanel open={ledgerOpen} onOpenChange={setLedgerOpen} projectId={projectId} />

      {/* 归档箱对话框（materials / homework 作用域）：恢复 / 永久删除后刷新文件树与标签表 */}
      {archiveScope && (
        <ArchiveDialog
          open
          onOpenChange={(v) => { if (!v) setArchiveScope(null); }}
          scope={archiveScope}
          onChanged={() => {
            if (currentId) loadProjectFilesRef.current?.(currentId);
            void loadFileTags();
          }}
        />
      )}

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

      {/* 标签编辑弹层（portal 到 body）：勾选已有标签即时增删，输入框回车可新建 */}
      {tagEditor && typeof document !== 'undefined' && (() => {
        const current = fileTags[tagEditor.scope][tagEditor.rel] ?? [];
        // 候选标签：该作用域预设标签 + 全部已用标签并集，保证「新建过的标签」可被同作用域任何文件复用
        const known = candidateTagsOf(tagEditor.scope, current);
        const addTag = () => {
          const t = tagDraft.trim();
          if (!t) return;
          if (!current.some((x) => x.toLowerCase() === t.toLowerCase())) {
            void saveFileTags(tagEditor.scope, tagEditor.rel, [...current, t]);
          }
          setTagDraft('');
        };
        return createPortal(
          <div
            data-tag-menu
            className="fixed z-[1600] w-52 overflow-hidden rounded-xl shadow-2xl"
            style={{
              left: Math.max(8, Math.min(tagEditor.x, window.innerWidth - 216)),
              top: Math.min(tagEditor.y, window.innerHeight - 280),
              border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
              backgroundColor: 'var(--popover)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="max-h-48 overflow-y-auto py-1">
              {known.length === 0 ? (
                <div className="px-3 py-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  No tags yet
                </div>
              ) : known.map((t) => {
                const active = current.some((x) => x.toLowerCase() === t.toLowerCase());
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      toggleFileTag(tagEditor.scope, tagEditor.rel, t, current);
                      // 打上 / 取消标签后立即收起弹层（与批量标签弹层行为一致）
                      setTagEditor(null);
                      setTagDraft('');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--ink)' }}
                  >
                    <Check className="h-3.5 w-3.5 shrink-0" style={{ color: active ? 'var(--primary)' : 'var(--ink-faint)', opacity: active ? 1 : 0.35 }} />
                    <span className="min-w-0 flex-1 truncate" style={{ color: tagTextColor(t) }}>{t}</span>
                  </button>
                );
              })}
            </div>
            <div className="border-t p-2" style={{ borderColor: 'var(--line-soft)' }}>
              <input
                type="text"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                  if (e.key === 'Escape') { setTagEditor(null); setTagDraft(''); }
                }}
                placeholder="New tag, press Enter"
                className="w-full rounded-md border px-2 py-1 text-xs outline-none"
                style={{ borderColor: 'var(--input-border)', color: 'var(--ink)', backgroundColor: 'var(--paper)' }}
              />
            </div>
          </div>,
          document.body,
        );
      })()}

      {/* 标签筛选下拉（portal 到 body）：根行右侧筛选按钮触发，单选 All / 具体标签 / Untagged */}
      {tagFilterMenu && typeof document !== 'undefined' && (() => {
        const scope = tagFilterMenu.scope;
        const selected = tagFilter[scope];
        const known = candidateTagsOf(scope, selected && selected !== UNTAGGED_FILTER ? [selected] : []);
        /** 单选项行：value 为 '' 时代表 All；labelColor 仅用于具体标签（All / Untagged 保持默认墨色） */
        const optionRow = (value: string, label: string, title: string, labelColor?: string) => {
          const active = selected === value;
          return (
            <button
              key={value || '__all'}
              type="button"
              onClick={() => {
                selectTagFilter(scope, value);
                setTagFilterMenu(null); // 选中即收起下拉（All / 标签 / Untagged 一致）
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink)' }}
              title={title}
            >
              <Check className="h-3.5 w-3.5 shrink-0" style={{ color: active ? 'var(--primary)' : 'var(--ink-faint)', opacity: active ? 1 : 0.35 }} />
              <span className="min-w-0 flex-1 truncate" style={labelColor ? { color: labelColor } : undefined}>{label}</span>
            </button>
          );
        };
        return createPortal(
          <div
            data-tag-filter-menu
            className="fixed z-[1600] w-52 overflow-hidden rounded-xl shadow-2xl"
            style={{
              left: Math.max(8, Math.min(tagFilterMenu.x, window.innerWidth - 216)),
              top: Math.min(tagFilterMenu.y, window.innerHeight - 300),
              border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
              backgroundColor: 'var(--popover)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 pb-1 pt-2">
              <span className="text-11" style={{ color: 'var(--ink-muted)' }}>
                {scope === 'materials' ? 'Filter materials' : 'Filter homework'}
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto py-1">
              {optionRow('', 'All', 'Show all files')}
              {known.length === 0 ? (
                <div className="px-3 py-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  No tags yet
                </div>
              ) : known.map((t) => optionRow(t, t, `Filter by "${t}"`, tagTextColor(t)))}
              {optionRow(UNTAGGED_FILTER, 'Untagged', 'Filter files without tags')}
            </div>
          </div>,
          document.body,
        );
      })()}

      {/* 批量打标签弹层（portal 到 body）：多选操作条 Tag 按钮触发；所选全部已有该标签则整体移除，否则整体补齐 */}
      {batchTagMenu && selection && typeof document !== 'undefined' && createPortal(
        <div
          data-batch-tag-menu
          className="fixed z-[1600] w-44 overflow-hidden rounded-xl shadow-2xl"
          style={{
            left: Math.max(8, Math.min(batchTagMenu.x, window.innerWidth - 184)),
            top: Math.min(batchTagMenu.y, window.innerHeight - 300),
            border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'var(--popover)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 pb-1 pt-2">
            <span className="text-11" style={{ color: 'var(--ink-muted)' }}>
              {`Tag ${selection.rels.size} ${selection.rels.size === 1 ? 'file' : 'files'}`}
            </span>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {(() => {
              // 各标签在所选集合中的命中情况：全部命中 → 勾选（再点即整体移除）；部分命中 → 半选并标出计数
              const items = selectionPaths();
              return candidateTagsOf(selection.scope).map((t) => {
                const key = t.toLowerCase();
                const have = items.filter((it) =>
                  (fileTags[selection.scope][it.scopeRel] ?? []).some((x) => x.toLowerCase() === key),
                ).length;
                const all = items.length > 0 && have === items.length;
                const some = have > 0 && !all;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => void applyBatchTag(t)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--ink)' }}
                    title={all ? `Remove "${t}" from all selected files` : `Add "${t}" to the selected files`}
                  >
                    {all ? (
                      <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                    ) : some ? (
                      <Minus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                    ) : (
                      <Tag className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                    )}
                    <span className="min-w-0 flex-1 truncate" style={{ color: tagTextColor(t) }}>{t}</span>
                    {some && (
                      <span className="shrink-0 text-9" style={{ color: 'var(--ink-faint)' }}>{`${have}/${items.length}`}</span>
                    )}
                  </button>
                );
              });
            })()}
          </div>
          <div className="border-t p-2" style={{ borderColor: 'var(--line-soft)' }}>
            <input
              type="text"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); const v = tagDraft; setTagDraft(''); void applyBatchTag(v); }
                if (e.key === 'Escape') { setBatchTagMenu(null); setTagDraft(''); }
              }}
              placeholder="New tag, press Enter"
              className="w-full rounded-md border px-2 py-1 text-xs outline-none"
              style={{ borderColor: 'var(--input-border)', color: 'var(--ink)', backgroundColor: 'var(--paper)' }}
            />
          </div>
        </div>,
        document.body,
      )}

      {/* 文件树右键菜单（portal 到 body，避免被浮层祖先 z-40 stacking context 囚禁在画布 UI 层 z-[1500] 之下） */}
      {ctxMenu && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[1600] w-44 overflow-hidden rounded-xl shadow-2xl"
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
            <span className="flex-1">Send to new node</span>
          </button>

          <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--line-soft)' }} />

          <button
            onClick={() => {
              setCtxMenu(null);
              setRenaming({ filePath: ctxMenu.filePath, oldName: ctxMenu.fileName });
              setRenameValue(ctxMenu.fileName);
              setRenameError(null);
              setTimeout(() => renameRef.current?.focus(), 50);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
          >
            <Pencil className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            <span className="flex-1">Rename</span>
          </button>
          <button
            onClick={() => handleDelete(ctxMenu.filePath, ctxMenu.fileName)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--danger)' }}
          >
            <Trash className="h-3.5 w-3.5" style={{ color: 'var(--danger)' }} />
            <span className="flex-1">Delete</span>
          </button>
        </div>,
        document.body,
      )}

      {/* 列式浏览行 ⋮ 菜单（portal 到 body，避免被浮层 overflow-hidden 裁切；z-[1600] 需高于画布 UI 覆盖层 z-[1500] 否则点击被拦截） */}
      {rowMenu && typeof document !== 'undefined' && createPortal(
        <div
          data-row-menu
          className="fixed z-[1600] w-44 overflow-hidden rounded-xl shadow-2xl"
          style={{
            left: Math.max(8, Math.min(rowMenu.x, window.innerWidth - 184)),
            top: Math.min(rowMenu.y, window.innerHeight - 208),
            border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'var(--popover)',
          }}
          onClick={(e) => {
            // 任一项点击后即收起菜单（含 Delete 等未自行关闭的项），避免菜单悬留
            e.stopPropagation();
            setRowMenu(null);
          }}
        >
          <button
            onClick={() => {
              setRowMenu(null);
              setRenaming({ filePath: rowMenu.filePath, oldName: rowMenu.fileName });
              setRenameValue(rowMenu.fileName);
              setRenameError(null);
              setTimeout(() => renameRef.current?.focus(), 50);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
          >
            <Pencil className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            Rename
          </button>
          <button
            onClick={() => { void handleRowCopy({ filePath: rowMenu.filePath, fileName: rowMenu.fileName, isDir: rowMenu.isDir }); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
            title="Duplicate this item in place"
          >
            <Copy className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            Copy
          </button>
          {/* 归档：移入 <作用域根>/.archive/（仅 materials / homework 的非根条目；归档后从文件树消失，可在归档箱恢复） */}
          {(() => {
            const rel = rowMenu.rel;
            const isMaterials = rel.startsWith('materials/');
            const isHomework = rel.startsWith('homework/');
            const enabled = isMaterials || isHomework;
            return (
              <button
                onClick={() => {
                  setRowMenu(null);
                  if (isMaterials) void applyArchive('materials', [rel.slice('materials/'.length)]);
                  else if (isHomework) void applyArchive('homework', [rel.slice('homework/'.length)]);
                }}
                disabled={!enabled}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                style={{ color: enabled ? 'var(--ink)' : 'var(--ink-muted)' }}
                title={enabled ? 'Move to the archive' : 'Only materials and homework items can be archived'}
              >
                <Archive className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
                Archive
              </button>
            );
          })()}
          <button
            onClick={() => handleRowDownload({ filePath: rowMenu.filePath, fileName: rowMenu.fileName })}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink)' }}
            title="Save a copy to a local folder (e.g. Desktop)"
          >
            <Download className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            Download to…
          </button>
          <button
            onClick={() => handleRowShare(rowMenu.filePath, rowMenu.fileName, rowMenu.isDir)}
            disabled={!isShareableDoc(rowMenu.fileName, rowMenu.isDir)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            style={{ color: isShareableDoc(rowMenu.fileName, rowMenu.isDir) ? 'var(--ink)' : 'var(--ink-muted)' }}
            title={isShareableDoc(rowMenu.fileName, rowMenu.isDir) ? 'Copy a LAN share link to clipboard' : 'Only Markdown documents can be shared'}
          >
            <Share2 className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            Share
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

      {/* materials 行 ⋮ 菜单（portal 到 body）：标题栏与行内的 materials 操作统一收纳于此，悬停 ⋮ 后展开 */}
      {materialsMenu && typeof document !== 'undefined' && (() => {
        const rel = materialsMenu.rel;
        const matRel = rel.replace(/^materials\/?/, '');
        const authed = currentId ? isMaterialsAuthed(currentId) : false;
        const projectPath = projects.find((p) => p.id === currentId)?.path;
        return createPortal(
          <div
            data-materials-menu
            className="fixed z-[1600] w-48 overflow-hidden rounded-xl shadow-2xl"
            style={{
              left: Math.max(8, Math.min(materialsMenu.x, window.innerWidth - 200)),
              top: Math.min(materialsMenu.y, window.innerHeight - 300),
              border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
              backgroundColor: 'var(--popover)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setMaterialsMenu(null);
                setUploadTargetFolder(matRel);
                setTimeout(() => uploadInputRef.current?.click(), 50);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink)' }}
            >
              <Upload className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
              Upload file
            </button>
            <button
              onClick={() => {
                setMaterialsMenu(null);
                setUploadTargetFolder(matRel);
                setTimeout(() => uploadFolderInputRef.current?.click(), 50);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink)' }}
            >
              <FolderUp className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
              Upload folder
            </button>
            {/* 进入多选：勾选该作用域下的文件后执行批量删除 / 打标签 / 下载 / 复制 */}
            <button
              onClick={() => startSelection(materialsMenu.scope)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink)' }}
              title="Select multiple files for batch actions"
            >
              <SquareCheck className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
              Select…
            </button>

            {/* 归档箱：查看该作用域下已归档的条目，支持批量恢复 / 永久删除 */}
            <button
              onClick={() => {
                const scope = materialsMenu.scope;
                setMaterialsMenu(null);
                setArchiveScope(scope);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink)' }}
              title="View archived items (restore or delete permanently)"
            >
              <Archive className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
              Archived…
            </button>

            {/* 视图切换：按来源会话分组 ↔ 扁平清单（homework 根目录专属，默认按会话分组，按项目记忆） */}
            {materialsMenu.isRoot && materialsMenu.scope === 'homework' && (
              <>
                <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--line-soft)' }} />
                <button
                  onClick={() => {
                    setMaterialsMenu(null);
                    toggleHomeworkGrouped();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink)' }}
                  title={homeworkGrouped ? 'Currently grouped by source conversation' : 'Currently a flat list'}
                >
                  <MessagesSquare className="h-3.5 w-3.5" style={{ color: homeworkGrouped ? 'var(--primary)' : 'var(--ink-muted)' }} />
                  <span className="min-w-0 flex-1 truncate">Group by conversation</span>
                </button>
              </>
            )}

            {/* 视图切换：按来源文件夹分组 ↔ 扁平清单（materials 根目录专属，默认扁平，按项目记忆） */}
            {materialsMenu.isRoot && materialsMenu.scope === 'materials' && (
              <>
                <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--line-soft)' }} />
                <button
                  onClick={() => {
                    setMaterialsMenu(null);
                    toggleMaterialsGrouped();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink)' }}
                  title={materialsGrouped ? 'Currently grouped by source folder' : 'Currently a flat list'}
                >
                  <Folder className="h-3.5 w-3.5" style={{ color: materialsGrouped ? 'var(--primary)' : 'var(--ink-muted)' }} />
                  <span className="min-w-0 flex-1 truncate">Group by folder</span>
                </button>
                {/* 新建分组：在 materials 下真实新建文件夹（filePath 复用为「materials 根相对的目标目录」，空串即根） */}
                <button
                  onClick={() => {
                    setMaterialsMenu(null);
                    // 新建的分组只在分组视图可见，顺手切过去，避免「建完看不到」
                    if (!materialsGrouped) toggleMaterialsGrouped();
                    setRenaming({ filePath: '', oldName: '', kind: 'newFolder' });
                    setRenameValue('');
                    setRenameError(null);
                    setTimeout(() => renameRef.current?.focus(), 50);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink)' }}
                  title="Create a folder on disk; drag files onto it to move them in"
                >
                  <FolderPlus className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
                  <span className="min-w-0 flex-1 truncate">New folder</span>
                </button>
              </>
            )}

            <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--line-soft)' }} />

            <button
              onClick={() => {
                setMaterialsMenu(null);
                if (currentId) void toggleMaterialsAuth(currentId);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink)' }}
              title={authed ? 'AI read/write authorized, click to revoke' : 'Authorize AI read/write for this directory (@ mentions, file tools)'}
            >
              {authed ? (
                <ShieldCheck className="h-3.5 w-3.5" style={{ color: 'var(--success)' }} />
              ) : (
                <Shield className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
              )}
              {authed ? 'Revoke AI access' : 'Authorize AI access'}
            </button>

            {!materialsMenu.isRoot && (
              <>
                <div className="mx-2 my-1 border-t" style={{ borderColor: 'var(--line-soft)' }} />
                <button
                  onClick={() => {
                    setMaterialsMenu(null);
                    if (!projectPath) return;
                    setRenaming({ filePath: `${projectPath}/${rel}`, oldName: materialsMenu.name });
                    setRenameValue(materialsMenu.name);
                    setRenameError(null);
                    setTimeout(() => renameRef.current?.focus(), 50);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink)' }}
                >
                  <Pencil className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
                  Rename folder
                </button>
                <button
                  onClick={() => {
                    setMaterialsMenu(null);
                    if (confirm(`Delete folder "${materialsMenu.name}" and all its contents?`)) handleDeleteMaterial(matRel, true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--danger)' }}
                >
                  <Trash className="h-3.5 w-3.5" style={{ color: 'var(--danger)' }} />
                  Delete folder
                </button>
              </>
            )}
          </div>,
          document.body,
        );
      })()}

      {/* 重命名弹窗（portal 到 body：浮层祖先 z-40 会创建 stacking context，不 portal 会被画布 UI 层 z-[1500] 遮挡） */}
      {renaming && typeof document !== 'undefined' && createPortal(
        <div
          data-ws-rename
          className="fixed inset-0 z-[1600] flex items-start justify-center pt-20"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onClick={() => { setRenaming(null); setRenameError(null); }}
        >
          <div
            className="w-72 rounded-2xl p-4 shadow-2xl"
            style={{ border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)', backgroundColor: 'var(--popover)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-3 text-sm font-medium font-display" style={{ color: 'var(--ink)' }}>
              {renaming.kind === 'newFolder' ? 'New folder' : 'Rename'}
            </p>
            <input
              ref={renameRef}
              type="text"
              value={renameValue}
              onChange={(e) => {
                setRenameValue(e.target.value);
                if (renameError) setRenameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') { setRenaming(null); setRenameError(null); }
              }}
              className="mb-3 w-full rounded-md border px-3 py-2 text-sm outline-none"
              style={{ borderColor: 'var(--input-border)', color: 'var(--ink)' }}
              placeholder={renaming.kind === 'newFolder' ? 'Folder name' : undefined}
              autoFocus
              onFocus={(e) => {
                // 新建文件夹：文件夹名里的点不是扩展名，不做主干选中
                if (renaming.kind === 'newFolder') {
                  e.target.select();
                  return;
                }
                const dotIdx = renameValue.lastIndexOf('.');
                if (dotIdx > 0) {
                  e.target.setSelectionRange(0, dotIdx);
                } else {
                  e.target.select();
                }
              }}
            />
            {renameError && (
              <p className="-mt-1 mb-3 text-xs" style={{ color: 'var(--destructive, #dc2626)' }}>
                {renameError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => { setRenaming(null); setRenameError(null); }}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                onClick={handleRename}
                disabled={!renameValue.trim() || (renaming.kind !== 'newFolder' && renameValue.trim() === renaming.oldName)}
              >
                Confirm
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
