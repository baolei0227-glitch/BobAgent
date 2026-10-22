'use client';

/**
 * ButlerMiniAppsPanel —— Butler 右栏「Mini Apps」分区。
 *
 * 入口：Butler 左栏的 Boxes 键（由 ButlerDrawer 渲染）。
 * 数据：标星小程序（lib/sandbox-starred，与 SandboxPanel / 旧 ⌘F 快捷图标同一份 localStorage）。
 *      同时拉一次 /api/sandbox 取 name/description/icon，并顺手 prune 掉已删除 app 的死标星。
 * 布局：iOS 桌面式图标网格 —— 图标在上、名称居中在下，可拖拽排序（顺序落 localStorage）。
 * 行为：点图标/名称 → 在 Hippo 独立页打开该小程序（与旧 ⌘F 图标一致，不挤占 Butler 抽屉）；
 *      图标右上角星标 badge（悬停浮现）→ 取消标星；Browse store → 收起 Butler，打开 Mini Programs 商城（在那里标星）。
 */
import { useEffect, useState } from 'react';
import { Boxes, Loader2, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStarredApps } from '@/components/canvas/canvasHooks';
import { openSandboxPreviewInHippo } from '@/lib/sandbox/open-preview';
import { pruneStarredApps, reorderStarredApps, toggleStarredApp } from '@/lib/sandbox-starred';
import { cn } from '@/lib/utils';

interface SandboxAppInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
}

export function ButlerMiniAppsPanel({ onCloseButler }: { onCloseButler: () => void }) {
  const [starred] = useStarredApps();
  const [apps, setApps] = useState<Record<string, SandboxAppInfo>>({});
  const [loading, setLoading] = useState(true);
  /** 拖拽排序态：dragId = 正在拖的图标，overId = 当前悬停的落点 */
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/sandbox')
      .then((r) => r.json())
      .then((data: { success?: boolean; apps?: SandboxAppInfo[] }) => {
        if (!alive || !data?.success || !Array.isArray(data.apps)) return;
        const map: Record<string, SandboxAppInfo> = {};
        for (const app of data.apps) {
          if (app && typeof app.id === 'string') map[app.id] = app;
        }
        setApps(map);
        // 删除/改名后的死标星：加载列表时回收（与 SandboxPanel 同一口径）
        pruneStarredApps(Object.keys(map));
      })
      .catch(() => {
        /* 离线/失败：仍用 localStorage 里的标星清单，不 prune */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const items = starred.map((s) => {
    const info = apps[s.id];
    return {
      id: s.id,
      name: info?.name || s.name,
      description: info?.description ?? '',
      icon: info?.icon ?? '',
    };
  });

  const openStore = () => {
    onCloseButler();
    window.dispatchEvent(new Event('sandbox-store-open'));
  };

  const openApp = (app: { id: string; name: string }) =>
    void openSandboxPreviewInHippo({ id: app.id, name: app.name });

  /** 把 fromId 拖到 toId 的位置：按当前可视顺序重排后落盘（订阅端刷新，无需本地副本） */
  const moveTo = (fromId: string, toId: string) => {
    const ids = items.map((a) => a.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    reorderStarredApps(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 items-center justify-between gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--line-soft)' }}
      >
        <span className="text-11" style={{ color: 'var(--ink-muted)' }}>
          Starred mini-apps · {items.length}
        </span>
        <Button variant="outline" tone="neutral" size="xs" onClick={openStore}>
          <Boxes className="h-3 w-3" /> Browse store
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--ink-muted)' }} />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <Star className="h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
            <p className="text-11 leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              No starred mini-apps yet. Star apps in the Mini Programs store, then they show up here.
            </p>
            <Button variant="solid" tone="brand" size="sm" onClick={openStore}>
              Browse Mini Programs
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-x-1 gap-y-3.5">
            {items.map((app) => {
              const isDragging = dragId === app.id;
              const isDropTarget = overId === app.id && dragId !== null && dragId !== app.id;
              return (
                <div
                  key={app.id}
                  className={cn(
                    'group flex select-none flex-col items-center gap-1.5',
                    isDragging && 'opacity-40',
                  )}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (overId !== app.id) setOverId(app.id);
                  }}
                  onDragLeave={() => setOverId((cur) => (cur === app.id ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId) moveTo(dragId, app.id);
                    setDragId(null);
                    setOverId(null);
                  }}
                >
                  <div className="relative">
                    <button
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        setDragId(app.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverId(null);
                      }}
                      onClick={() => openApp(app)}
                      className="flex h-14 w-14 cursor-grab items-center justify-center rounded-2xl text-2xl leading-none transition-[transform,box-shadow] active:cursor-grabbing group-hover:scale-[1.04]"
                      style={{
                        backgroundColor: 'var(--primary-soft)',
                        // iOS 图标质感：顶部一道柔光高光 + 分层投影（底部更暗，像浮在桌面上）
                        backgroundImage:
                          'linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 52%)',
                        boxShadow: isDropTarget
                          ? '0 0 0 2px var(--panel-bg), 0 0 0 4px var(--primary), inset 0 1px 0 rgba(255,255,255,0.7)'
                          : 'inset 0 1px 0 rgba(255,255,255,0.7), 0 1px 2px rgba(23,23,23,0.12), 0 4px 10px rgba(23,23,23,0.06)',
                      }}
                      title={app.description ? `${app.name} — ${app.description}` : `Open ${app.name} in Hippo`}
                      aria-label={`Open ${app.name} in Hippo`}
                    >
                      {app.icon ? (
                        app.icon
                      ) : (
                        <span className="text-lg font-semibold" style={{ color: 'var(--primary-strong)' }}>
                          {app.name.charAt(0).toUpperCase() || '•'}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleStarredApp({ id: app.id, name: app.name })}
                      className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full opacity-0 transition-opacity hover:brightness-95 group-hover:opacity-100 focus-visible:opacity-100"
                      style={{ backgroundColor: 'var(--panel-bg)', border: '1px solid var(--line-soft)' }}
                      title="Unstar"
                      aria-label={`Unstar ${app.name}`}
                    >
                      <Star className="h-3 w-3" style={{ color: 'var(--warn)' }} fill="currentColor" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => openApp(app)}
                    className="line-clamp-2 w-full px-0.5 text-center text-11 leading-tight"
                    style={{ color: 'var(--ink-strong)' }}
                    title={app.name}
                  >
                    {app.name}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
