'use client';

/**
 * TeamTimeline —— 工作台运行时间线（甘特/泳道），以抽屉形式叠加在节点面板内。
 *
 * 纵轴按成员分泳道（最能体现"谁与谁并行、谁在排队"），横轴为真实时间：任务条由
 * `claimedAt..finishedAt` 定位，运行中的任务延展到"现在"。
 *
 * 数据来源是引擎面板载荷下发的时间戳（见 bob-team-mcp team.ts panelStatus 的 claimedAt/finishedAt），
 * 前端不做任何推断 —— 因此尚未开跑（无 claimedAt）的团队只会显示"排队中"清单与空态提示。
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { TeamMemberView, TeamTaskView } from '@/lib/types';

const STATUS_COLOR: Record<string, string> = {
  done: 'var(--success)',
  failed: 'var(--danger)',
  running: 'var(--primary-strong)',
  claimed: 'var(--primary-strong)',
  ready: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)',
  draft: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)',
};

function fmt(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

type Lane = { id: string; label: string; tasks: TeamTaskView[] };

export default function TeamTimeline({
  tasks,
  members,
  onClose,
  onSelectTask,
}: {
  tasks: TeamTaskView[];
  members: TeamMemberView[];
  onClose: () => void;
  onSelectTask?: (taskId: string) => void;
}) {
  // 「现在」不在 render 内取（保持组件纯函数）：挂载后与任务集变化时刷新
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [tasks]);
  const timed = tasks.filter((t) => typeof t.claimedAt === 'number');
  const queued = tasks.filter((t) => typeof t.claimedAt !== 'number');

  const starts = timed.map((t) => t.claimedAt as number);
  const ends = timed.map((t) => t.finishedAt ?? now);
  const min = starts.length > 0 ? Math.min(...starts) : now;
  const max = ends.length > 0 ? Math.max(...ends, now) : now;
  const span = Math.max(1000, max - min);

  // 泳道：按成员顺序，未分配 / 已不在名单的 assignee 归入 unassigned 泳道
  const known = new Set(members.map((m) => m.id));
  const lanes: Lane[] = [
    ...members.map((m) => ({
      id: m.id,
      label: m.name,
      tasks: timed.filter((t) => t.assignee === m.id),
    })),
    {
      id: '__unassigned__',
      label: 'Unassigned',
      tasks: timed.filter((t) => !t.assignee || !known.has(t.assignee)),
    },
  ].filter((l) => l.tasks.length > 0);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => min + span * p);

  return (
    <div className="absolute inset-0 z-20 flex justify-end">
      {/* Backdrop: clicking outside closes the drawer */}
      <button
        type="button"
        aria-label="Close timeline"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 18%, transparent)' }}
      />
      <div
        className="relative flex h-full w-[68%] max-w-[430px] min-w-[260px] flex-col overflow-hidden border-l"
        style={{
          borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)',
          backgroundColor: 'var(--paper)',
        }}
      >
        <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5" style={{ borderColor: 'color-mix(in oklab, var(--line) 35%, transparent)' }}>
          <span className="text-10 font-semibold uppercase tracking-wide" style={{ color: 'color-mix(in oklab, var(--ink-muted) 78%, transparent)' }}>
            Timeline
          </span>
          <span className="min-w-0 flex-1 truncate text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
            {fmt(max - min)} span · {timed.length} started{queued.length > 0 ? ` · ${queued.length} queued` : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100"
            style={{ color: 'var(--ink-muted)' }}
            title="Close"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        {timed.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 65%, transparent)' }}>
            No task has started yet — the timeline appears once members begin claiming work.
          </div>
        ) : (
          <>
            {/* Time axis */}
            <div className="relative h-4 shrink-0 border-b" style={{ borderColor: 'color-mix(in oklab, var(--line) 22%, transparent)' }}>
              {ticks.map((ts, i) => (
                <span
                  key={i}
                  className="absolute -translate-x-1/2 text-8"
                  style={{ left: `${i * 25}%`, color: 'color-mix(in oklab, var(--ink-muted) 58%, transparent)' }}
                >
                  {fmtClock(ts)}
                </span>
              ))}
            </div>

            <div className="ai-canvas-scroll min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
              {lanes.map((lane) => (
                <div key={lane.id} className="mb-2">
                  <div className="mb-1 truncate text-9 font-medium" style={{ color: 'color-mix(in oklab, var(--ink) 78%, transparent)' }}>
                    {lane.label}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {lane.tasks.map((t) => {
                      const start = t.claimedAt as number;
                      const end = t.finishedAt ?? now;
                      const left = ((start - min) / span) * 100;
                      const width = Math.max(2, ((end - start) / span) * 100);
                      const running = t.status === 'running' || t.status === 'claimed';
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => onSelectTask?.(t.id)}
                          className="group relative h-4 w-full cursor-pointer"
                          title={`${t.subject}\n${fmt(end - start)}${running ? ' (running)' : ''}`}
                        >
                          <span
                            className="absolute top-0 h-full rounded-[3px]"
                            style={{
                              left: `${left}%`,
                              width: `${width}%`,
                              backgroundColor: STATUS_COLOR[t.status] ?? 'var(--ink-muted)',
                              opacity: t.status === 'failed' ? 0.85 : 1,
                            }}
                          />
                          <span
                            className="absolute top-0 h-full truncate pl-1 text-8 leading-4"
                            style={{ left: `${left}%`, maxWidth: `${Math.max(width, 8)}%`, color: 'var(--paper)' }}
                          >
                            {t.subject}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {queued.length > 0 && (
                <div className="mt-1 border-t pt-1.5" style={{ borderColor: 'color-mix(in oklab, var(--line) 25%, transparent)' }}>
                  <div className="mb-0.5 text-9 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                    Queued ({queued.length})
                  </div>
                  {queued.map((t) => (
                    <div key={t.id} className="truncate text-8" style={{ color: 'color-mix(in oklab, var(--ink-muted) 62%, transparent)' }}>
                      {t.subject}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}