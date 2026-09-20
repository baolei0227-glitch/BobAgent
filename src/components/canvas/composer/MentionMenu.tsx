'use client';

import { AtSign, ChevronLeft, Folder } from 'lucide-react';
import type { DirMentionItem } from './useComposer';

/**
 * @ 引用弹窗：入口列表（Materials 资料夹 + 已授权目录）→ 目录/子目录浏览 → 选中文件。
 * chat 与 team 输入栏共用；compact = team 侧窄栏的小字号形态。
 */
export default function MentionMenu({
  open,
  menuRef,
  dir,
  dirItems,
  dirLoading,
  query,
  index,
  authorizedRoots,
  onSelect,
  onBack,
  compact = false,
}: {
  open: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  dir: { root: string; path: string; source: 'auth' | 'materials' } | null;
  dirItems: DirMentionItem[];
  dirLoading: boolean;
  query: string;
  index: number;
  authorizedRoots: string[];
  onSelect: (item: DirMentionItem) => void;
  onBack: () => void;
  compact?: boolean;
}) {
  if (!open) return null;
  const t = compact ? 'text-10' : 'text-xs';

  return (
    <div
      ref={menuRef}
      data-mention-popup
      className={`absolute z-50 mb-1 max-h-40 overflow-y-auto rounded-xl border py-1 shadow-lg ${compact ? 'w-56' : 'w-64'}`}
      style={{
        bottom: '100%',
        left: 0,
        borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
        backgroundColor: 'var(--popover)',
      }}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {(() => {
        // 未进入任何目录 → 入口列表（Materials 文件夹 + 授权目录们）
        if (!dir) {
          const entries: DirMentionItem[] = [
            { name: 'Materials', path: '__materials__', type: 'directory' },
            ...authorizedRoots.map((r) => ({
              name: r.split('/').filter(Boolean).pop() || r,
              path: r,
              type: 'directory' as const,
            })),
          ];
          const q = query.toLowerCase();
          const filtered = entries.filter((i) => i.name.toLowerCase().includes(q));
          if (filtered.length === 0) {
            return (
              <div className={`px-3 py-2 ${t}`} style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                No matching folders
              </div>
            );
          }
          return filtered.slice(0, 10).map((item, idx) => (
            <button
              key={item.path}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(item);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${t}`}
              style={{
                backgroundColor: idx === index ? 'var(--paper-soft)' : 'transparent',
              }}
              onMouseEnter={(el) => {
                el.currentTarget.style.backgroundColor = 'var(--paper-soft)';
              }}
              onMouseLeave={(el) => {
                if (idx !== index) {
                  el.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              <Folder
                className="h-3 w-3 shrink-0"
                style={{ color: item.path === '__materials__' ? 'var(--primary-strong)' : 'var(--info)' }}
              />
              <div className="min-w-0 flex-1">
                <div className={`truncate font-medium ${t}`} style={{ color: 'var(--ink)' }}>
                  {item.name}
                </div>
                <div className={t} style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                  {item.path === '__materials__' ? 'Materials folder' : 'Authorized directory'}
                </div>
              </div>
            </button>
          ));
        }
        // 已进入目录/子目录（materials 或授权目录）
        const q = query.toLowerCase();
        const filtered = dirItems.filter((i) => i.name.toLowerCase().includes(q));
        return (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onBack();
              }}
              className={`flex w-full items-center gap-1 px-3 py-1 text-left transition-colors ${t}`}
              style={{ color: 'color-mix(in oklab, var(--ink-muted) 80%, transparent)' }}
            >
              <ChevronLeft className="h-3 w-3" />
              {dir.path ? 'Back' : authorizedRoots.length > 0 ? 'Back to folder list' : 'Close'}
            </button>
            {dirLoading ? (
              <div className={`px-3 py-2 ${t}`} style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                Loading...
              </div>
            ) : filtered.length === 0 ? (
              <div className={`px-3 py-2 ${t}`} style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                {dirItems.length === 0 ? 'Folder is empty' : 'No matching files'}
              </div>
            ) : (
              filtered.slice(0, 10).map((item, idx) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(item);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${t}`}
                  style={{
                    backgroundColor: idx === index ? 'var(--paper-soft)' : 'transparent',
                  }}
                  onMouseEnter={(el) => {
                    el.currentTarget.style.backgroundColor = 'var(--paper-soft)';
                  }}
                  onMouseLeave={(el) => {
                    if (idx !== index) {
                      el.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  {item.type === 'directory' ? (
                    <Folder className="h-3 w-3 shrink-0" style={{ color: 'var(--info)' }} />
                  ) : (
                    <AtSign className="h-3 w-3 shrink-0" style={{ color: 'var(--primary-strong)' }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className={`truncate font-medium ${t}`} style={{ color: 'var(--ink)' }}>
                      {item.name}
                    </div>
                    <div className={t} style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                      {item.type === 'directory'
                        ? 'Directory'
                        : `${item.extension ? item.extension.toUpperCase() : 'File'}${item.size ? ' · ' + item.size : ''}`}
                    </div>
                  </div>
                </button>
              ))
            )}
          </>
        );
      })()}
    </div>
  );
}
