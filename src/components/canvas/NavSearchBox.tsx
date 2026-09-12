'use client';
/**
 * 侧栏顶部“真实搜索框”：边输入边出结果（不弹 ⌘F 浮层面板）。
 * 数据源与 UnifiedPalette 一致（GET /api/search?q=&scope=global）；
 * 打开行为一致：项目 → 切换项目（无刷新）；文件 → 可预览走查看舱，否则系统默认程序打开。
 */

import { useEffect, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { desktop } from '@/lib/desktop-adapter';
import { isBrowserDoc, isPreviewable } from './viewers/registry';
import { bus, BusEvents } from '@/lib/bus';

interface NavSearchHit {
  type: string;
  source?: string;
  name: string;
  path: string;
  extension?: string;
  projectId?: string;
}

interface NavSearchSections {
  key: string;
  label: string;
  items: NavSearchHit[];
}

/** 展示用短路径：保留末尾三段 */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-3).join('/') || p;
}

export function NavSearchBox() {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<NavSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const doSearch = async (q: string) => {
    if (!q.trim()) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=global`);
      const data = await resp.json();
      if (data.success) {
        setHits((data.results || []) as NavSearchHit[]);
        setActiveIdx(0);
      } else {
        setHits([]);
      }
    } catch {
      setHits([]);
    } finally {
      setLoading(false);
    }
  };

  // 外部点击：收起结果列表（保留输入词）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, []);

  const flatItems = hits;
  const sections: NavSearchSections[] = [
    { key: 'projects', label: 'Projects', items: hits.filter((h) => h.type === 'project') },
    { key: 'workspace', label: 'BobWorkspace', items: hits.filter((h) => h.type !== 'project' && h.source === 'workspace') },
    { key: 'bobwork', label: 'BobWork', items: hits.filter((h) => h.type !== 'project' && h.source === 'bobwork') },
  ].filter((s) => s.items.length > 0);

  const closeAndClear = () => {
    setOpen(false);
    setHits([]);
    setText('');
  };

  /** 打开结果：项目 → 切换（无刷新）；文件 → 查看舱 / 系统默认程序 */
  const openHit = async (item: NavSearchHit) => {
    if (item.type === 'project' && item.projectId) {
      try {
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'switch', project_id: item.projectId }),
        });
        const data = await resp.json();
        if (data.success) {
          window.dispatchEvent(new CustomEvent('bobagent:project-switched', { detail: { projectId: item.projectId } }));
        }
      } catch { /* 切换失败静默 */ }
      closeAndClear();
      return;
    }
    if (isPreviewable(item.extension) || isBrowserDoc(item.name)) {
      bus.publish(BusEvents.fileOpen, { source: 'local', path: item.path, name: item.name });
    } else {
      void desktop.openFile(item.path);
    }
    closeAndClear();
  };

  const onInput = (value: string) => {
    setText(value);
    setOpen(true);
    setActiveIdx(0);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void doSearch(value), 220);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (flatItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % flatItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[activeIdx];
      if (item) void openHit(item);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <div
        className="flex items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors focus-within:border-[var(--primary)]"
        style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: 'var(--ink-faint)' }} />
        ) : (
          <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-faint)' }} />
        )}
        <input
          type="text"
          value={text}
          onChange={(e) => onInput(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search files, notes…"
          spellCheck={false}
          className="w-full min-w-0 bg-transparent text-xs outline-none"
          style={{ color: 'var(--ink)' }}
        />
      </div>

      {open && text.trim() !== '' && (
        <div
          className="absolute left-0 right-0 top-full z-[90] mt-1 overflow-hidden rounded-lg border shadow-2xl"
          style={{ backgroundColor: 'var(--card)', borderColor: 'var(--line)' }}
        >
          <div className="max-h-[300px] overflow-y-auto py-1 ai-canvas-scroll">
            {loading && hits.length === 0 && (
              <div className="px-3 py-2 text-xs" style={{ color: 'var(--ink-muted)' }}>Searching…</div>
            )}
            {!loading && hits.length === 0 && (
              <div className="px-3 py-2 text-xs" style={{ color: 'var(--ink-muted)' }}>No matches</div>
            )}
            {sections.map((sec) => (
              <div key={sec.key}>
                <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                  {sec.label}
                </div>
                {sec.items.map((item) => {
                  const gi = flatItems.indexOf(item);
                  return (
                    <button
                      key={`${item.path}-${item.name}`}
                      type="button"
                      onMouseDown={(e) => {
                        // mousedown 先于 blur，直接在此触发打开避免列表先收起
                        e.preventDefault();
                        void openHit(item);
                      }}
                      onMouseEnter={() => setActiveIdx(gi)}
                      className="flex w-full flex-col px-3 py-1 text-left transition-colors"
                      style={{
                        backgroundColor: gi === activeIdx ? 'var(--paper-hover)' : 'transparent',
                        color: 'var(--ink)',
                      }}
                    >
                      <span className="truncate text-xs font-medium">{item.name}</span>
                      <span className="truncate text-[10px]" style={{ color: 'var(--ink-muted)' }}>
                        {shortPath(item.path)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
