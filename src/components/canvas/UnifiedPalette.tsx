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
} from 'lucide-react';

import { bus, BusEvents } from '@/lib/bus';
import { desktop } from '@/lib/desktop-adapter';
import { isBrowserDoc, isPreviewable } from './viewers/registry';
import { FileName } from './FileName';

/**
 * ⌘F 统一面板（Raycast 式）—— 纯搜索
 *
 * 唯一形态：普通文本 → 搜索 BobWork 项目（按名称）+ BobWorkspace 各项目的
 * homework/materials/attachments 子目录。
 *
 * 指令态与会话态已于 2026-09（P1-c）移除：斜杠命令统一由 Butler 抽屉与微信桥落到会话层
 * （lib/core/commands.ts 归一化 → /api/core/node-chat），面板不再调用 /api/core/execute，
 * 也不再发布 butlerNotice 回执。原 TaskPanel 的 LCD 显示屏与悬浮球实现已在此前整改中从
 * globals.css 删除。
 */

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

export function UnifiedPalette({ open, onClose, actions }: UnifiedPaletteProps) {
  // ===== 输入 =====
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ===== 查找态（原 GlobalSearch 逻辑） =====
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ===== 打开时重置 =====
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setLoading(false);
    setActiveIdx(0);
    setError(null);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  // ===== 查找态：搜索 / 打开 =====
  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
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
    searchTimer.current = setTimeout(() => void doSearch(value), 250);
  }, [doSearch]);

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

  // ===== 键盘：窗口级导航（保持 GlobalSearch 行为） =====
  useEffect(() => {
    if (!open) return;
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
  }, [open, onClose, moveActive, activate, activeIdx]);

  // 选中项滚动到可视区
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open, hits]);

  if (!open) return null;

  const flatIdxOf = (item: SearchHit): number => flatItems.indexOf(item);

  const inputPlaceholder = 'Search projects & files in BobWork / BobWorkspace…';

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
        {/* 输入行 */}
        <div
          className="flex shrink-0 items-center gap-2 px-4 py-3"
          style={{ borderBottom: !actions?.length ? '1px solid var(--line-soft)' : 'none' }}
        >
          <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--ink-muted)' }} />
          <textarea
            ref={inputRef}
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            rows={1}
            placeholder={inputPlaceholder}
            className="nowheel w-full flex-1 resize-none bg-transparent text-sm outline-none"
            style={{ color: 'var(--ink)', lineHeight: 1.5, overflowY: 'hidden' }}
          />
          {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--ink-muted)' }} />}
          {query && !loading && (
            <button
              onClick={() => { setQuery(''); setHits([]); inputRef.current?.focus(); }}
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

        {/* 功能入口图标行（2026-09-12 自左侧边栏迁入）：仅图标，悬停显示名称。
            标星小程序入口已于 2026-10-18 迁到 Butler 左栏「Mini Apps」，⌘F 不再展示。 */}
        {actions && actions.length > 0 && (
          <div
            className="flex shrink-0 items-center gap-0.5 px-3 pb-3"
            style={{ borderBottom: '1px solid var(--line-soft)' }}
          >
            {actions.map((act) => (
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
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="mx-3 mt-2 flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        {/* 结果列表 */}
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
      </div>
    </div>,
    document.body,
  );
}
