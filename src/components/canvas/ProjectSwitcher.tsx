'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Folder, ChevronDown, Plus, Trash2, Check } from 'lucide-react';

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_accessed_at: string;
}

interface ProjectSwitcherProps {
  onProjectSwitched?: () => void;
}

/** 项目切换器组件 */
export function ProjectSwitcher({ onProjectSwitched }: ProjectSwitcherProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 加载项目列表
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

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const currentProject = projects.find((p) => p.id === currentId);

  // 切换项目
  const handleSwitch = useCallback(
    async (projectId: string) => {
      if (projectId === currentId) {
        setMenuOpen(false);
        return;
      }
      try {
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'switch', project_id: projectId }),
        });
        const data = await resp.json();
        if (data.success) {
          setMenuOpen(false);
          // 切换项目后刷新整个页面，重新加载画布数据
          if (onProjectSwitched) {
            onProjectSwitched();
          } else {
            window.location.reload();
          }
        }
      } catch (err) {
        console.error('切换项目失败:', err);
      }
    },
    [currentId, onProjectSwitched],
  );

  // 创建新项目
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
        // 创建后直接切换到新项目
        await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'switch', project_id: data.project.id }),
        });
        setCreateDialogOpen(false);
        setNewProjectName('');
        setMenuOpen(false);
        window.location.reload();
      } else {
        alert(data.error || 'Failed to create project');
      }
    } catch (err) {
      console.error('创建项目失败:', err);
      alert('Failed to create project');
    } finally {
      setCreating(false);
    }
  }, [newProjectName]);

  // 删除项目
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
          // 删除后刷新页面（如果删光了会显示欢迎页）
          window.location.reload();
        } else {
          alert(data.error || 'Failed to delete project');
        }
      } catch (err) {
        console.error('删除项目失败:', err);
        alert('Failed to delete project');
      }
    },
    [loadProjects],
  );

  return (
    <div ref={menuRef} className="relative">
      {/* 当前项目显示按钮 */}
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs shadow-md transition-all hover:shadow-lg"
        style={{
          backgroundColor: 'oklch(0.97 0.015 80 / 0.95)',
          border: '1px solid oklch(0.80 0.03 60 / 0.35)',
          color: 'oklch(0.40 0.02 50)',
          backdropFilter: 'blur(8px)',
          fontFamily: "'Noto Serif SC', serif",
          maxWidth: '200px',
        }}
      >
        <Folder className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'oklch(0.62 0.17 45)' }} />
        <span className="truncate">{currentProject?.name || 'Loading...'}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0" />
      </button>

      {/* 下拉菜单 */}
      {menuOpen && (
        <div
          className="absolute left-0 top-full z-50 mt-1 min-w-[240px] rounded-lg shadow-lg"
          style={{
            backgroundColor: 'oklch(0.97 0.015 80 / 0.98)',
            border: '1px solid oklch(0.80 0.03 60 / 0.4)',
            backdropFilter: 'blur(8px)',
          }}
        >
          {/* 项目列表 */}
          <div className="max-h-[280px] overflow-y-auto py-1">
            {projects.map((project) => (
              <div
                key={project.id}
                className="group flex items-center justify-between px-3 py-2 text-xs transition-colors hover:bg-amber-50/50"
                style={{
                  color: project.id === currentId ? 'oklch(0.45 0.15 45)' : 'oklch(0.40 0.02 50)',
                  fontFamily: "'Noto Serif SC', serif",
                }}
              >
                <button
                  onClick={() => handleSwitch(project.id)}
                  className="flex flex-1 items-center gap-2 truncate text-left"
                >
                  <Folder className="h-3 w-3 flex-shrink-0" style={{ color: 'oklch(0.62 0.17 45 / 0.6)' }} />
                  <span className="truncate">{project.name}</span>
                  {project.id === currentId && (
                    <Check className="h-3 w-3 flex-shrink-0" style={{ color: 'oklch(0.55 0.15 45)' }} />
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(project.id, project.name);
                  }}
                  className="ml-2 hidden flex-shrink-0 rounded p-1 transition-colors hover:bg-red-100 group-hover:block"
                  style={{ color: 'oklch(0.55 0.18 25)' }}
                  title="Delete Project"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          {/* 分隔线 */}
          <div style={{ borderTop: '1px solid oklch(0.80 0.03 60 / 0.3)' }} />

          {/* 新建项目按钮 */}
          <button
            onClick={() => {
              setMenuOpen(false);
              setCreateDialogOpen(true);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-amber-50/50"
            style={{
              color: 'oklch(0.45 0.15 45)',
              fontFamily: "'Noto Serif SC', serif",
            }}
          >
            <Plus className="h-3 w-3" />
            <span>New Project</span>
          </button>
        </div>
      )}

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
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              className="mb-4 text-base font-medium"
              style={{
                color: 'oklch(0.40 0.02 50)',
                fontFamily: "'Noto Serif SC', serif",
              }}
            >
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
            <p
              className="mt-2 text-xs"
              style={{
                color: 'oklch(0.55 0.02 50)',
                fontFamily: "'Noto Serif SC', serif",
              }}
            >
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
                style={{
                  color: 'oklch(0.50 0.02 50)',
                  fontFamily: "'Noto Serif SC', serif",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newProjectName.trim()}
                className="rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: 'oklch(0.62 0.17 45)',
                  color: 'white',
                  fontFamily: "'Noto Serif SC', serif",
                }}
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
