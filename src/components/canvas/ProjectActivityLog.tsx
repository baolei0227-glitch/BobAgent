'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FolderOpen,
  MessageSquare,
  Paperclip,
  FileText,
  Archive,
  ArrowDownUp,
  Loader2,
} from 'lucide-react';
import { bus, BusEvents } from '@/lib/bus';
import { cn } from '@/lib/utils';
import type { ActivityKind, ActivityItem } from '@/lib/project/activity';

interface ActivityGroup {
  date: string;
  items: ActivityItem[];
}

interface ProjectActivityLogProps {
  /** 当前项目 id */
  projectId: string;
  /** 外部刷新信号（文件/项目列表变更时自增） */
  refreshKey?: number;
  /** 搜索关键词（受控）：搜索框位于浮层标题栏，按视图切换生效 */
  query: string;
  /** 搜索关键词变更回调 */
  onQueryChange: (query: string) => void;
  className?: string;
}

const PAGE_LIMIT = 100;

const KIND_META: Record<ActivityKind, { label: string; color: string }> = {
  project: { label: 'Project created', color: 'var(--primary)' },
  task: { label: 'Task executed', color: 'oklch(0.55 0.15 265)' },
  attachment: { label: 'Attachment added', color: 'oklch(0.58 0.12 200)' },
  document: { label: 'Document generated', color: 'oklch(0.58 0.14 150)' },
  lifecycle: { label: 'Project status', color: 'oklch(0.58 0.12 60)' },
};

const KIND_ICON = {
  project: FolderOpen,
  task: MessageSquare,
  attachment: Paperclip,
  document: FileText,
  lifecycle: Archive,
} as const;

const FILTERS: { key: 'all' | ActivityKind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'task', label: 'Tasks' },
  { key: 'attachment', label: 'Attachments' },
  { key: 'document', label: 'Documents' },
  { key: 'project', label: 'Projects' },
  { key: 'lifecycle', label: 'Status' },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 本地日期键 YYYY-MM-DD */
function localDateKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 日期头：Today / Yesterday / Mon, Sep 14, 2026 */
function formatDateHeader(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return dateKey;
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${WEEKDAYS[target.getDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** 时间 HH:mm */
function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 文件大小人类可读 */
function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 将扁平条目按本地日期分组（保持入参顺序） */
function groupByDate(items: ActivityItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let current: ActivityGroup | null = null;
  for (const item of items) {
    const date = localDateKey(item.ts);
    if (!current || current.date !== date) {
      current = { date, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

export function ProjectActivityLog({ projectId, refreshKey = 0, query, onQueryChange, className }: ProjectActivityLogProps) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [kind, setKind] = useState<'all' | ActivityKind>('all');
  const reqRef = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const reqId = ++reqRef.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ project_id: projectId, order, limit: String(PAGE_LIMIT) });
        if (kind !== 'all') params.set('kind', kind);
        if (cursor) params.set('cursor', cursor);
        const res = await fetch(`/api/projects/activity?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { groups: ActivityGroup[]; total: number; nextCursor: string | null };
        if (reqId !== reqRef.current) return; // 已有更新的请求，丢弃本次结果
        const flat = data.groups.flatMap((g) => g.items);
        setItems((prev) => (cursor ? [...prev, ...flat] : flat));
        setNextCursor(data.nextCursor);
        setTotal(data.total);
      } catch (error) {
        if (reqId !== reqRef.current) return;
        console.error('[ProjectActivityLog] 加载失败:', error);
        if (!cursor) setItems([]);
        setNextCursor(null);
      } finally {
        if (reqId === reqRef.current) setLoading(false);
      }
    },
    [projectId, order, kind],
  );

  // 项目 / 排序 / 过滤 / 外部刷新变化 → 重新拉取第一页
  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    void load(null);
  }, [load, refreshKey]);

  // 搜索：仅过滤已加载条目（标题 + 副行描述），不改动分页请求
  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) => item.title.toLowerCase().includes(q) || (item.detail ?? '').toLowerCase().includes(q),
    );
  }, [items, query]);

  const groups = useMemo(() => groupByDate(visibleItems), [visibleItems]);

  const openItem = (item: ActivityItem) => {
    if (item.kind === 'task' && item.nodeId) {
      window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId: item.nodeId } }));
      return;
    }
    if (item.path) {
      bus.publish(BusEvents.fileOpen, { source: 'project', path: item.path, name: item.title });
    }
  };

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {/* 工具条：排序 + 类型过滤（搜索框已上移至浮层标题栏，按视图切换目标） */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5"
        style={{ borderColor: 'var(--line-soft)' }}
      >
        <button
          type="button"
          onClick={() => setOrder((o) => (o === 'desc' ? 'asc' : 'desc'))}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)' }}
          title={order === 'desc' ? 'Current: newest first' : 'Current: oldest first'}
        >
          <ArrowDownUp className="h-3 w-3" />
          {order === 'desc' ? 'Newest first' : 'Oldest first'}
        </button>
        <span style={{ width: 1, height: 14, backgroundColor: 'var(--line-soft)' }} />
        <div className="flex min-w-0 shrink flex-wrap items-center gap-1">
          {FILTERS.map((f) => {
            const active = kind === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setKind(f.key)}
                className="shrink-0 rounded-full px-2 py-0.5 text-xs transition-colors"
                style={{
                  backgroundColor: active ? 'color-mix(in oklab, var(--primary) 14%, transparent)' : 'transparent',
                  color: active ? 'var(--primary)' : 'var(--ink-muted)',
                  fontWeight: active ? 500 : 400,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 流水账主体 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {visibleItems.length === 0 ? (
          <div className="flex h-full items-center justify-center py-8 text-xs" style={{ color: 'var(--ink-muted)' }}>
            {loading ? 'Loading…' : items.length > 0 ? 'No matching entries' : 'No activity yet'}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.date} className="mb-2">
              <div
                className="sticky top-0 z-10 -mx-2 px-2 py-1 text-xs font-medium"
                style={{ backgroundColor: 'var(--paper)', color: 'var(--ink-muted)' }}
              >
                {formatDateHeader(group.date)}
              </div>
              <div className="flex flex-col">
                {group.items.map((item) => {
                  const meta = KIND_META[item.kind];
                  const Icon = KIND_ICON[item.kind];
                  const clickable = Boolean(item.nodeId) || Boolean(item.path);
                  const sizeText = formatSize(item.size);
                  // 副行由「类型标签 + 描述 + 大小」去重拼接：与主文案相同的标签、与标签相同的描述均省略，避免同一文案重复出现
                  const subParts = [
                    meta.label === item.title ? '' : meta.label,
                    item.detail && item.detail !== meta.label ? item.detail : '',
                    sizeText,
                  ].filter(Boolean);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!clickable}
                      onClick={() => openItem(item)}
                      className={cn(
                        'flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
                        clickable && 'hover:bg-[var(--paper-hover)] cursor-pointer',
                      )}
                      title={clickable ? (item.nodeId ? 'Locate this node' : 'Open file') : undefined}
                    >
                      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: meta.color }} />
                      <span
                        className="mt-0.5 w-11 shrink-0 text-xs tabular-nums"
                        style={{ color: 'var(--ink-faint)' }}
                      >
                        {formatTime(item.ts)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm" style={{ color: 'var(--ink)' }}>
                          {item.title}
                        </span>
                        {subParts.length > 0 && (
                          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                            {subParts.map((part, i) => (
                              <span key={i} className="min-w-0 truncate">
                                {i > 0 ? `· ${part}` : part}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}

        {nextCursor && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              onClick={() => void load(nextCursor)}
              disabled={loading}
              className="flex items-center gap-1 rounded-md border px-3 py-1 text-xs transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-60"
              style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}
            >
              {loading && <Loader2 className="h-3 w-3 animate-spin" />}
              Load more (showing {items.length} / {total})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
