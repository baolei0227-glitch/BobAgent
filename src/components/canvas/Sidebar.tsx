'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder,
  FolderOpen,
  Plus,
  Settings,
  Lightbulb,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Check,
  RefreshCw,
  Bug,
  FileText,
  ChevronDown,
  Cog,
  CalendarDays,
  Download,
  AlertCircle,
  ArrowDownCircle,
} from 'lucide-react';
import { TaskPanel } from './TaskPanel';
import { TemplatePanel } from './TemplatePanel';
import { TemplateEditor } from './TemplateEditor';
import { TemplateApplyDialog } from './TemplateApplyDialog';

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_accessed_at: string;
}

interface FileNode {
  name: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  extension?: string;
}

interface SidebarProps {
  onOpenSettings: () => void;
  onOpenSkills: () => void;
  onOpenCalendar: () => void;
  onOpenFile?: (projectId: string, fileName: string, filePath: string) => void;
  projectId: string;
}

/** 文件图标映射 */
function fileIcon(ext?: string): { color: string; label: string } {
  switch (ext) {
    case '.md': return { color: 'oklch(0.55 0.15 45)', label: 'MD' };
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
    case '.webp': return { color: 'oklch(0.55 0.15 330)', label: 'IMG' };
    default: return { color: 'oklch(0.50 0.02 60)', label: 'FILE' };
  }
}

export function Sidebar({ onOpenSettings, onOpenSkills, onOpenCalendar, onOpenFile, projectId }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const [envInfo, setEnvInfo] = useState<{ isolation?: boolean; app_root?: string } | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');

  // 更新状态
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'downloading' | 'downloaded' | 'no-update' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = useState<string>('');
  const [updateProgress, setUpdateProgress] = useState<number>(0);
  const [updateError, setUpdateError] = useState<string>('');
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 模板相关状态
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | undefined>(undefined);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null);
  const [templateRefreshTrigger, setTemplateRefreshTrigger] = useState(0);

  // 监听更新事件
  useEffect(() => {
    if (typeof window.api?.update === 'undefined') return;
    const unsubscribe: Array<() => void> = [];

    window.api.update.onChecking((info) => {
      // 自动检查不显示 spinner，仅手动检查显示
      if (!info?.manual) return;
      setUpdateStatus('checking');
      // 10 秒超时自动消失
      updateTimerRef.current = setTimeout(() => {
        setUpdateStatus('idle');
      }, 10000);
    });

    window.api.update.onAvailable((info) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      setUpdateVersion(info.version);
      setUpdateStatus('downloading');
    });

    window.api.update.onNotAvailable((info) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      if (info?.manual) {
        setUpdateStatus('no-update');
        setTimeout(() => setUpdateStatus('idle'), 3000);
      } else {
        setUpdateStatus('idle');
      }
    });

    window.api.update.onDownloadProgress((p) => {
      setUpdateProgress(p.percent);
    });

    window.api.update.onDownloaded(() => {
      setUpdateStatus('downloaded');
    });

    window.api.update.onError((info) => {
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
    });

    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      unsubscribe.forEach(fn => fn());
    };
  }, []);

  // 加载环境信息（用于显示 Dev Badge）
  useEffect(() => {
    fetch('/api/env')
      .then((r) => r.json())
      .then((d) => d && d.success && setEnvInfo(d))
      .catch(() => {});
  }, []);

  // 加载应用版本号
  useEffect(() => {
    if (typeof window !== 'undefined' && window.api?.update?.getVersion) {
      window.api.update.getVersion().then(v => setAppVersion(v)).catch(() => {});
    }
  }, []);

  // 点击外部关闭设置菜单
  useEffect(() => {
    if (!settingsMenuOpen) return;
    const handler = (e: PointerEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setSettingsMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [settingsMenuOpen]);

  // 文件树相关状态
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [projectFiles, setProjectFiles] = useState<Map<string, FileNode[]>>(new Map());
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());

  const loadProjects = useCallback(async () => {
    try {
      const resp = await fetch('/api/projects');
      const data = await resp.json();
      if (data.success) {
        setProjects(data.projects);
        setCurrentId(data.current_id);
      }
    } catch (err) {
      console.error('加载项目列表失败:', err);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

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
          window.location.reload();
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
        body: JSON.stringify({ action: 'create', name }),
      });
      const data = await resp.json();
      if (data.success) {
        await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'switch', project_id: data.project.id }),
        });
        setCreateDialogOpen(false);
        setNewProjectName('');
        window.location.reload();
      } else {
        alert(data.error || 'Failed to create project');
      }
    } catch (err) {
      console.error('Failed to create project:', err);
      alert('Failed to create project');
    } finally {
      setCreating(false);
    }
  }, [newProjectName]);

  const handleDelete = useCallback(
    async (projectId: string, projectName: string) => {
      if (!confirm(`Delete project "${projectName}"?\n\nAll nodes and edges in this project will be permanently deleted. This action cannot be undone.`)) {
        return;
      }
      try {
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', project_id: projectId }),
        });
        const data = await resp.json();
        if (data.success) {
          await loadProjects();
          window.location.reload();
        } else {
          alert(data.error || 'Failed to delete project');
        }
      } catch (err) {
        console.error('Failed to delete project:', err);
        alert('Failed to delete project');
      }
    },
    [loadProjects],
  );

  /** 切换项目展开/折叠 */
  const toggleProjectExpand = useCallback(async (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
        return next;
      }
      // 展开时始终重新加载文件树
      loadProjectFiles(projectId);
      next.add(projectId);
      return next;
    });
  }, []);

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

  /** 切换文件夹展开 */
  const toggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const sidebarWidth = collapsed ? '56px' : '240px';

  /** 递归渲染文件树 */
  const renderFileTree = (nodes: FileNode[], depth: number, parentPath: string, projId: string) => {
    return nodes.map((node) => {
      const nodePath = `${parentPath}/${node.name}`;
      const isExpanded = expandedFolders.has(nodePath);

      if (node.type === 'directory') {
        return (
          <div key={nodePath}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleFolder(nodePath);
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-[oklch(0.92_0.01_75)]"
              style={{ paddingLeft: `${12 + depth * 14}px` }}
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3 flex-shrink-0" style={{ color: 'oklch(0.50 0.02 50)' }} />
              ) : (
                <ChevronRight className="h-3 w-3 flex-shrink-0" style={{ color: 'oklch(0.50 0.02 50)' }} />
              )}
              {isExpanded ? (
                <FolderOpen className="h-3 w-3 flex-shrink-0" style={{ color: 'oklch(0.62 0.17 45)' }} />
              ) : (
                <Folder className="h-3 w-3 flex-shrink-0" style={{ color: 'oklch(0.55 0.08 45)' }} />
              )}
              <span className="truncate text-[11px]" style={{ color: 'oklch(0.40 0.02 50)' }}>
                {node.name}
              </span>
            </button>
            {isExpanded && node.children && (
              <div>{renderFileTree(node.children, depth + 1, nodePath, projId)}</div>
            )}
          </div>
        );
      }

      // 文件节点 - 可点击打开
      const icon = fileIcon(node.extension);
      const relativePath = nodePath.replace(`${projId}/`, '');
      return (
        <button
          key={nodePath}
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile?.(projId, node.name, relativePath);
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-[oklch(0.92_0.01_75)]"
          style={{ paddingLeft: `${12 + depth * 14}px` }}
        >
          <FileText className="h-3 w-3 flex-shrink-0" style={{ color: icon.color }} />
          <span className="flex-1 truncate text-[11px]" style={{ color: 'oklch(0.40 0.02 50)' }}>
            {node.name}
          </span>
          {node.extension && (
            <span
              className="flex-shrink-0 rounded px-1 py-0 text-[8px] font-medium"
              style={{ backgroundColor: `${icon.color}18`, color: icon.color }}
            >
              {icon.label}
            </span>
          )}
        </button>
      );
    });
  };

  return (
    <>
      <div
        className="flex h-screen flex-col transition-all duration-200 ease-in-out"
        style={{
          width: sidebarWidth,
          backgroundColor: 'oklch(0.97 0.01 80)',
          borderRight: '1px solid oklch(0.85 0.01 70)',
          fontFamily: "'Noto Serif SC', serif",
          flexShrink: 0,
          zIndex: 20,
        }}
      >
        {/* 折叠时的展开按钮 */}
        {collapsed && (
          <div className="flex justify-center pt-10 pb-2">
            <button
              onClick={() => setCollapsed(false)}
              className="rounded-md p-1 transition-colors hover:bg-[oklch(0.92_0.01_75)]"
              style={{ color: 'oklch(0.55 0.02 50)' }}
              title="Expand sidebar"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* 展开时的折叠按钮 */}
        {!collapsed && (
          <div className="flex justify-end px-3 py-3">
            <button
              onClick={() => setCollapsed(true)}
              className="rounded-md p-1 transition-colors hover:bg-[oklch(0.92_0.01_75)]"
              style={{ color: 'oklch(0.55 0.02 50)' }}
              title="Collapse sidebar"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* 项目列表区域 */}
        <div className="flex-1 overflow-y-auto py-2">
          {!collapsed && (
            <div className="px-3 pb-1">
              <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'oklch(0.55 0.02 50)' }}>
                Projects
              </span>
            </div>
          )}

          {projects.map((project) => {
            const isActive = project.id === currentId;
            const isExpanded = expandedProjects.has(project.id);
            const isLoading = loadingFiles.has(project.id);
            const files = projectFiles.get(project.id) || [];

            return (
              <div key={project.id} className="mx-1.5 mb-0.5">
                {/* 项目行 */}
                <div
                  className="group flex items-center rounded-md transition-colors"
                  style={{
                    backgroundColor: isActive ? 'oklch(0.92 0.015 75)' : 'transparent',
                  }}
                >
                  {/* 展开/折叠按钮 */}
                  {!collapsed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleProjectExpand(project.id);
                      }}
                      className="flex-shrink-0 rounded p-0.5 transition-colors hover:bg-[oklch(0.88_0.01_75)]"
                      style={{ color: 'oklch(0.50 0.02 50)' }}
                    >
                      {isLoading ? (
                        <RefreshCw className="h-3 w-3 animate-spin" />
                      ) : isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                  )}

                  {/* 项目名称按钮 */}
                  <button
                    onClick={() => handleSwitch(project.id)}
                    className="flex flex-1 items-center gap-2 truncate rounded-md px-1.5 py-1.5 text-left text-xs"
                    title={project.name}
                  >
                    {isActive ? (
                      <FolderOpen
                        className="h-3.5 w-3.5 flex-shrink-0"
                        style={{ color: 'oklch(0.62 0.17 45)' }}
                      />
                    ) : (
                      <Folder
                        className="h-3.5 w-3.5 flex-shrink-0"
                        style={{ color: 'oklch(0.60 0.02 55)' }}
                      />
                    )}
                    {!collapsed && (
                      <>
                        <span className="truncate" style={{ color: isActive ? 'oklch(0.35 0.02 50)' : 'oklch(0.45 0.02 50)' }}>
                          {project.name}
                        </span>
                        {isActive && (
                          <Check className="h-3 w-3 flex-shrink-0 ml-auto" style={{ color: 'oklch(0.55 0.15 45)' }} />
                        )}
                      </>
                    )}
                  </button>

                  {/* 删除按钮 */}
                  {!collapsed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(project.id, project.name);
                      }}
                      className="mr-1 hidden flex-shrink-0 rounded p-0.5 transition-colors hover:bg-red-100 group-hover:block"
                      style={{ color: 'oklch(0.55 0.18 25)' }}
                      title="Delete project"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                  {/* 刷新按钮（hover 显示） */}
                  {!collapsed && isExpanded && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        loadProjectFiles(project.id);
                      }}
                      className="mr-1 hidden flex-shrink-0 rounded p-0.5 transition-colors hover:bg-[oklch(0.88_0.01_75)] group-hover:block"
                      style={{ color: 'oklch(0.50 0.02 50)' }}
                      title="刷新文件列表"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {/* 文件树 */}
                {!collapsed && isExpanded && (
                  <div className="mt-0.5">
                    {files.length > 0 ? (
                      renderFileTree(files, 0, project.id, project.id)
                    ) : (
                      <div className="py-2 text-center text-[10px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        {isLoading ? 'Loading...' : 'Empty'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* 新建项目按钮 */}
          {!collapsed && (
            <button
              onClick={() => setCreateDialogOpen(true)}
              className="mx-1.5 mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-[oklch(0.92_0.015_75)]"
              style={{ color: 'oklch(0.50 0.12 45)' }}
              title="New project"
            >
              <Plus className="h-3.5 w-3.5 flex-shrink-0" />
              <span>New project</span>
            </button>
          )}

          {/* 工作流模板 */}
          <TemplatePanel
            onCreateNew={() => {
              setEditingTemplateId(undefined);
              setTemplateEditorOpen(true);
            }}
            onEditTemplate={(templateId) => {
              setEditingTemplateId(templateId);
              setTemplateEditorOpen(true);
            }}
            onApplyTemplate={(templateId) => {
              setApplyingTemplateId(templateId);
              setApplyDialogOpen(true);
            }}
            refreshTrigger={templateRefreshTrigger}
          />
        </div>

        {/* 任务归纳面板（独立区块，项目列表与 Logo 之间） */}
        <TaskPanel
          onEventsCreated={() => window.dispatchEvent(new Event('calendar-events-changed'))}
          onOpenCalendar={onOpenCalendar}
        />

        {/* 底部：Logo + 功能按钮 */}
        <div
          className="py-2"
          style={{ borderTop: '1px solid oklch(0.85 0.01 70)' }}
        >
          {!collapsed && (
            <div className="flex items-center gap-2 px-3 pb-2">
              <img
                src="/bobagent-logo.png"
                alt="BobAgent"
                className="h-5 w-5 rounded object-contain"
              />
              <span className="text-sm font-semibold" style={{ color: 'oklch(0.35 0.02 50)' }}>
                BobAgent
              </span>
              {envInfo?.isolation ? (
                <span
                  className="rounded px-1.5 py-0.5 text-[9px] font-bold leading-tight"
                  style={{
                    backgroundColor: 'oklch(0.55 0.18 27 / 0.12)',
                    color: 'oklch(0.55 0.18 27)',
                    letterSpacing: '0.03em',
                  }}
                  title={`数据目录：${envInfo.app_root || '未设置'}`}
                >
                  DEV
                </span>
              ) : (
                <span className="text-[9px]" style={{ color: 'oklch(0.50 0.02 55)' }}>
                  v{appVersion || '1.0.2'}
                </span>
              )}
              {/* 设置齿轮图标 + 更新状态指示 */}
              <div className="relative ml-auto flex items-center gap-0.5" ref={settingsMenuRef}>
                {/* 更新状态指示 - 显示在齿轮左侧 */}
                {updateStatus === 'checking' && (
                  <RefreshCw className="h-3 w-3 animate-spin" style={{ color: 'oklch(0.62 0.17 45)' }} />
                )}
                {updateStatus === 'downloading' && (
                  <span className="text-[10px] font-medium tabular-nums" style={{ color: 'oklch(0.62 0.17 45)' }}>
                    {Math.round(updateProgress)}%
                  </span>
                )}
                {updateStatus === 'error' && (
                  <AlertCircle className="h-3 w-3" style={{ color: 'oklch(0.65 0.20 25)' }} />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSettingsMenuOpen((v) => !v);
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[oklch(0.92_0.015_75)]"
                  style={{ color: 'oklch(0.50 0.02 55)' }}
                  title={
                    updateStatus === 'downloading' ? `Downloading v${updateVersion} (${Math.round(updateProgress)}%)` :
                    updateStatus === 'downloaded' ? `Update v${updateVersion} ready to install` :
                    updateStatus === 'checking' ? 'Checking for updates...' :
                    'Settings'
                  }
                >
                  {updateStatus === 'downloaded' ? (
                    <ArrowDownCircle className="h-3.5 w-3.5" style={{ color: 'oklch(0.55 0.15 45)' }} />
                  ) : (
                    <Cog className="h-3.5 w-3.5" />
                  )}
                </button>
                {settingsMenuOpen && (
                  <div
                    className="absolute bottom-full right-0 mb-1 w-44 rounded-lg border py-1 shadow-lg z-50"
                    style={{
                      backgroundColor: 'oklch(0.98 0.012 80)',
                      borderColor: 'oklch(0.80 0.03 60 / 0.4)',
                    }}
                    onWheel={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSettingsMenuOpen(false);
                        onOpenSettings();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                      style={{ color: 'oklch(0.30 0.015 50)' }}
                    >
                      <Settings className="h-3.5 w-3.5" style={{ color: 'oklch(0.62 0.17 45)' }} />
                      Model settings
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSettingsMenuOpen(false);
                        onOpenSkills();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                      style={{ color: 'oklch(0.30 0.015 50)' }}
                    >
                      <Lightbulb className="h-3.5 w-3.5" style={{ color: 'oklch(0.62 0.17 45)' }} />
                      Skills
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (updateStatus === 'downloaded') {
                          setSettingsMenuOpen(false);
                          if (typeof window.api?.update !== 'undefined') {
                            window.api.update.install();
                          }
                        } else {
                          setSettingsMenuOpen(false);
                          if (typeof window.api?.update !== 'undefined') {
                            window.api.update.check();
                          }
                        }
                      }}
                      disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[oklch(0.95_0.01_80)] disabled:opacity-50"
                      style={{ color: 'oklch(0.30 0.015 50)' }}
                    >
                      {updateStatus === 'checking' ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" style={{ color: 'oklch(0.62 0.17 45)' }} />
                      ) : updateStatus === 'downloading' ? (
                        <Download className="h-3.5 w-3.5" style={{ color: 'oklch(0.62 0.17 45)' }} />
                      ) : updateStatus === 'downloaded' ? (
                        <ArrowDownCircle className="h-3.5 w-3.5" style={{ color: 'oklch(0.55 0.15 45)' }} />
                      ) : updateStatus === 'no-update' ? (
                        <Check className="h-3.5 w-3.5" style={{ color: 'oklch(0.55 0.15 45)' }} />
                      ) : updateStatus === 'error' ? (
                        <AlertCircle className="h-3.5 w-3.5" style={{ color: 'oklch(0.65 0.20 25)' }} />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" style={{ color: 'oklch(0.62 0.17 45)' }} />
                      )}
                      <span className="flex-1 text-left">
                        {updateStatus === 'checking' ? 'Checking...' : 
                         updateStatus === 'downloading' ? `Downloading (${Math.round(updateProgress)}%)` :
                         updateStatus === 'downloaded' ? `Install v${updateVersion}` :
                         updateStatus === 'no-update' ? 'Already up to date' :
                         updateStatus === 'error' ? updateError || 'Failed' :
                         'Check for updates'}
                      </span>
                      {updateStatus === 'downloaded' && (
                        <span
                          className="ml-auto h-2 w-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: 'oklch(0.55 0.22 30)' }}
                        />
                      )}
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (typeof window.api?.update?.clearCache === 'function') {
                          try {
                            const r = await window.api.update.clearCache();
                            if (r.success) {
                              alert(`已清除 ${r.deletedCount} 个更新缓存目录，释放 ${r.freedMB}MB`);
                            }
                          } catch {
                            alert('清除失败，请稍后重试');
                          }
                        }
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                      style={{ color: 'oklch(0.30 0.015 50)' }}
                    >
                      <Trash2 className="h-3.5 w-3.5" style={{ color: 'oklch(0.55 0.02 50)' }} />
                      Clear update cache
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSettingsMenuOpen(false);
                        if (typeof window.api?.openDevTools === 'function') {
                          window.api.openDevTools();
                        }
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                      style={{ color: 'oklch(0.30 0.015 50)' }}
                    >
                      <Bug className="h-3.5 w-3.5" style={{ color: 'oklch(0.62 0.17 45)' }} />
                      Developer
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          {collapsed && (
            <div className="flex justify-center pb-2">
              <img
                src="/bobagent-logo.png"
                alt="BobAgent"
                className="h-6 w-6 rounded object-contain"
              />
            </div>
          )}
        </div>
      </div>

      {/* 新建项目对话框 */}
      {createDialogOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => !creating && setCreateDialogOpen(false)}
        >
          <div
            className="rounded-lg p-6 shadow-xl"
            style={{
              backgroundColor: 'oklch(0.97 0.015 80)',
              border: '1px solid oklch(0.80 0.03 60 / 0.4)',
              width: '360px',
              fontFamily: "'Noto Serif SC', serif",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-base font-medium" style={{ color: 'oklch(0.40 0.02 50)' }}>
              New Project
            </h3>
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
                }
              }}
              disabled={creating}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-amber-400"
              style={{
                backgroundColor: 'oklch(1 0 0 / 0.6)',
                borderColor: 'oklch(0.80 0.03 60 / 0.4)',
                color: 'oklch(0.40 0.02 50)',
                fontFamily: "'Noto Serif SC', serif",
              }}
            />
            <p className="mt-2 text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>
              Project will be created under <code className="rounded px-1 py-0.5" style={{ backgroundColor: 'oklch(0.92 0.01 60)' }}>~/BobAgent/</code>
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setCreateDialogOpen(false);
                  setNewProjectName('');
                }}
                disabled={creating}
                className="rounded-md px-3 py-1.5 text-xs transition-colors hover:bg-gray-100"
                style={{ color: 'oklch(0.50 0.02 50)' }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newProjectName.trim()}
                className="rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
                style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 模板编辑器对话框 */}
      <TemplateEditor
        open={templateEditorOpen}
        onOpenChange={setTemplateEditorOpen}
        templateId={editingTemplateId}
        onSaved={() => {
          setTemplateRefreshTrigger((v) => v + 1);
        }}
      />

      {/* 模板应用对话框 */}
      <TemplateApplyDialog
        open={applyDialogOpen}
        onOpenChange={setApplyDialogOpen}
        templateId={applyingTemplateId}
        onApplied={(nodes) => {
          // 触发刷新
          setTemplateRefreshTrigger((v) => v + 1);
        }}
      />
    </>
  );
}
