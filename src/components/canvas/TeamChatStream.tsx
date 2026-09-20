'use client';

/**
 * TeamChatStream —— the multi-agent collaboration "chat stream" (form A presentation layer).
 *
 * Renders the incremental events the host projects during a team_run orchestration (TeamChatEvent[])
 * as a group-chat-like message stream, grouped by task: run started / task block (member started, member
 * output, member failure) / message relayed / run finished. **Pure presentation**: it does not change
 * orchestration behavior, and its underlying data comes from the same source as the "member branch cards"
 * (the same subagent_update + subagent_events frames).
 *
 * Difference from the branch cards: cards are a "current state snapshot" (who is running, how far along),
 * while this component is "what happened" (who said what, who left a message for whom) — a timeline shape
 * that fits watching the collaboration process better.
 *
 * Restart degradation: events only live in conversation memory (not persisted), so after reopening the
 * canvas only the snapshot remains; in that case `members` is used to synthesize an equivalent timeline
 * so the view is never empty.
 *
 * Behavior notes:
 *   - Smart stick-to-bottom: auto-scrolls only while the view is already at the bottom; if the reader
 *     scrolled up, a "Jump to latest" button appears instead of yanking the scroll position away.
 *   - Task grouping: member events sharing a taskId collapse into one collapsible task block
 *     (subject + duration + time); events with no taskId (e.g. a message wake-up) stay standalone rows.
 *   - Markdown: member output is rendered as Markdown (react-markdown + remark-gfm); raw HTML stays escaped.
 *   - Truncation: event text arrives capped (backend EVENT_TEXT_CAP); when the untruncated output is
 *     available in `results` (keyed by taskId), a "Show full text" affordance reveals it.
 *   - Filtering: a member chip row appears once two or more members have spoken.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleDashed, Flag, Info, Send, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SubagentBranch, TeamChatEvent } from '@/lib/types';

/** Max length of event body text (matches the backend EVENT_TEXT_CAP: neither SSE frames nor rendering should be too long) */
const TEXT_CAP = 600;

const REMARK_PLUGINS = [remarkGfm];

/** Member events (the only ones that carry a taskId and can be grouped into a task block) */
type MemberEvent =
  | Extract<TeamChatEvent, { kind: 'member_start' }>
  | Extract<TeamChatEvent, { kind: 'member_done' }>
  | Extract<TeamChatEvent, { kind: 'member_failed' }>;

function isMemberEvent(e: TeamChatEvent): e is MemberEvent {
  return e.kind === 'member_start' || e.kind === 'member_done' || e.kind === 'member_failed';
}

/**
 * Restart degradation: synthesize an equivalent timeline from the snapshot (events are not persisted, so
 * this fills the gap after reopening the canvas). Ordered by `at`, so concurrent members interleave the
 * same way they did live instead of being serialized by array order.
 */
function synthesizeEvents(members: SubagentBranch[], goal?: string, taskCount?: number): TeamChatEvent[] {
  const active = members.filter((m) => m.state !== 'queued');
  if (active.length === 0) return [];
  const ts = (v?: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const starts = active.map((m) => ts(m.startAt)).filter((n) => n > 0);
  const out: TeamChatEvent[] = [
    {
      kind: 'team_start',
      at: starts.length > 0 ? Math.min(...starts) : 0,
      goal: goal ?? '',
      memberNames: active.map((m) => m.name),
      taskCount: taskCount ?? 0,
    },
  ];
  for (const m of active) {
    out.push({
      kind: 'member_start',
      at: ts(m.startAt),
      memberId: m.id,
      name: m.name,
      subject: m.subject,
      taskId: m.taskId,
    });
    if (m.state === 'done') {
      out.push({
        kind: 'member_done',
        at: ts(m.endAt),
        memberId: m.id,
        name: m.name,
        subject: m.subject,
        summary: m.resultSummary,
        taskId: m.taskId,
      });
    } else if (m.state === 'failed') {
      out.push({
        kind: 'member_failed',
        at: ts(m.endAt),
        memberId: m.id,
        name: m.name,
        subject: m.subject,
        error: m.error,
        taskId: m.taskId,
      });
    }
  }
  // Only close the run when every member is terminal (a snapshot in flight has no team_done event yet)
  if (members.every((m) => m.state === 'done' || m.state === 'failed')) {
    const ends = active.map((m) => ts(m.endAt)).filter((n) => n > 0);
    const failed = members.filter((m) => m.state === 'failed').length;
    out.push({
      kind: 'team_done',
      at: ends.length > 0 ? Math.max(...ends) : 0,
      done: members.length - failed,
      total: taskCount ?? members.length,
      failed,
      timedOut: false,
    });
  }
  return out;
}

/** First character shown in a member avatar (first char for CJK names, first letter for Latin names) */
function initial(name: string): string {
  const t = name.trim();
  if (!t) return '·';
  return /[a-zA-Z]/.test(t[0]) ? t[0].toUpperCase() : t[0];
}

/** Assign a stable hue per member name (the same member always renders with the same color) */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function clip(text: string | undefined): string {
  if (!text) return '';
  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text;
}

function hms(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

const DIM = 'color-mix(in oklab, var(--ink-muted) 68%, transparent)';

/**
 * Stall hint window: how long a running task may show the exact same progress text before it is flagged.
 * A tool call in flight legitimately produces no update for a while (one large OCR / one long search), so the
 * window is deliberately generous — it only catches agents that stopped advancing altogether.
 */
const STALL_HINT_MS = 120_000;
/** Re-check cadence: the workbench stream only pushes frames on real changes, so the hint cannot rely on them */
const STALL_TICK_MS = 5_000;

/** One tracked running item: an id plus the progress text that should keep changing while it advances */
export interface StallTrackItem {
  id: string;
  active: boolean;
  progressText?: string;
}

/**
 * Stall hints: id → milliseconds without any progress-text change (the fix for "the run looks frozen").
 *
 * The engine keeps the task alive and the UI keeps breathing while a member is stuck in a non-converging
 * loop, so a progress text that stops changing is the only client-side evidence that the branch stopped
 * advancing. Items without progress text are not tracked (there is nothing to compare).
 */
export function useStallHints(items: StallTrackItem[]): Record<string, number> {
  const [hints, setHints] = useState<Record<string, number>>({});
  const seen = useRef<Map<string, { text: string; since: number }>>(new Map());
  const lastKey = useRef('');
  // Fingerprint of what is actually tracked: the effect re-registers only when this changes, which lets the
  // timer keep ticking while nothing changes (a frozen run sends no frames at all)
  const fingerprint = items
    .filter((i) => i.active && !!i.progressText)
    .map((i) => `${i.id}\u0000${i.progressText}`)
    .join('\u0001');
  useEffect(() => {
    const tracked = items.filter((i) => i.active && !!i.progressText);
    const tick = () => {
      const now = Date.now();
      const live = new Set<string>();
      const next: Record<string, number> = {};
      for (const it of tracked) {
        live.add(it.id);
        const text = it.progressText ?? '';
        const prev = seen.current.get(it.id);
        if (!prev || prev.text !== text) seen.current.set(it.id, { text, since: now });
        else if (now - prev.since >= STALL_HINT_MS) next[it.id] = now - prev.since;
      }
      // Stop tracking items that are no longer running (done / failed / no longer present)
      for (const id of [...seen.current.keys()]) if (!live.has(id)) seen.current.delete(id);
      const key = JSON.stringify(next);
      if (key !== lastKey.current) {
        lastKey.current = key;
        setHints(next);
      }
    };
    tick();
    const timer = window.setInterval(tick, STALL_TICK_MS);
    return () => window.clearInterval(timer);
    // `fingerprint` covers every tracked field (id + progress text of active items)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);
  return hints;
}

/**
 * Render model: member events sharing a taskId collapse into one task block; everything else stays a line.
 * A block sits at the position of its first event, so the timeline stays ordered by "when the task started".
 */
type TaskBlock = {
  kind: 'task';
  taskId: string;
  subject?: string;
  /** First event time (block position) / last event time (for duration + trailing timestamp) */
  at: number;
  lastAt: number;
  rows: MemberEvent[];
};
type LineItem = { kind: 'line'; key: string; ev: TeamChatEvent };

function buildItems(list: TeamChatEvent[]): (TaskBlock | LineItem)[] {
  const items: (TaskBlock | LineItem)[] = [];
  const blocks = new Map<string, TaskBlock>();
  list.forEach((ev, i) => {
    if (isMemberEvent(ev) && ev.taskId) {
      let block = blocks.get(ev.taskId);
      if (!block) {
        block = { kind: 'task', taskId: ev.taskId, subject: ev.subject, at: ev.at, lastAt: ev.at, rows: [] };
        blocks.set(ev.taskId, block);
        items.push(block);
      }
      if (!block.subject && ev.subject) block.subject = ev.subject;
      block.rows.push(ev);
      if (ev.at > block.lastAt) block.lastAt = ev.at;
      return;
    }
    items.push({ kind: 'line', key: `${ev.kind}-${i}`, ev });
  });
  return items;
}

/** Truncation / expansion UI state shared by every row (the engine snapshot keeps the untruncated text) */
interface TextUI {
  /** taskId → full output text (from the engine panel snapshot); used by "Show full text" */
  results?: Record<string, string> | null;
  expanded: Set<string>;
  toggle: (key: string) => void;
}

export default function TeamChatStream({
  events,
  members,
  isStreaming,
  fill,
  results,
  goal,
  taskCount,
}: {
  /** Incremental event timeline (accumulated during this turn's streaming; empty after restart, then the members fallback kicks in) */
  events?: TeamChatEvent[] | null;
  /** Snapshot used by the degraded synthesis (also tells whether any member is still in progress) */
  members: SubagentBranch[];
  /** Whether this turn is still streaming (in-progress members show a breathing dot) */
  isStreaming?: boolean;
  /** Fill the parent's height (used by the team workbench main column); defaults to content height capped at 320px */
  fill?: boolean;
  /** Full member output text per task (taskId → text): lets "Show full text" reveal what the event cap truncated */
  results?: Record<string, string> | null;
  /** Team goal / task count: only used to synthesize the run-start line in the degraded (post-restart) view */
  goal?: string;
  taskCount?: number;
}) {
  const list = useMemo(
    () => (events && events.length > 0 ? events : synthesizeEvents(members, goal, taskCount)),
    [events, members, goal, taskCount],
  );
  // Chronological order (the host emits in order, but synthesized/replayed inputs may not be sorted)
  const sorted = useMemo(() => [...list].sort((a, b) => a.at - b.at), [list]);
  const items = useMemo(() => buildItems(sorted), [sorted]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  /** Whether the reader is parked at the bottom (only then do new events follow automatically) */
  const [atBottom, setAtBottom] = useState(true);
  const [filter, setFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const count = sorted.length;

  // New events keep arriving while streaming: follow only if the reader has not scrolled up
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, atBottom, filter]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    setAtBottom(true);
  }, []);

  const toggleIn = useCallback((set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }, []);
  const toggleCollapse = useCallback((id: string) => setCollapsed((prev) => toggleIn(prev, id)), [toggleIn]);
  const toggleText = useCallback((key: string) => setExpanded((prev) => toggleIn(prev, key)), [toggleIn]);
  const ui = useMemo<TextUI>(() => ({ results, expanded, toggle: toggleText }), [results, expanded, toggleText]);

  // Stall hints: the engine keeps the snapshot flowing while a member is stuck, so a frozen progress text is
  // the only signal that this branch stopped advancing (the breathing dot alone looks like normal work)
  const trackItems = useMemo<StallTrackItem[]>(
    () => members.map((m) => ({ id: m.taskId ?? m.id, active: m.state === 'running', progressText: m.progressText })),
    [members],
  );
  const stallHints = useStallHints(trackItems);

  /** Members that have spoken (only worth a filter chip row once there are two or more) */
  const speakers = useMemo(() => {
    const out: string[] = [];
    for (const e of sorted) if (isMemberEvent(e) && !out.includes(e.name)) out.push(e.name);
    return out;
  }, [sorted]);

  // Member filter: keep only what that member said / was told (on-stage system lines are noise then)
  const visible = useMemo(() => {
    if (!filter) return items;
    const out: (TaskBlock | LineItem)[] = [];
    for (const it of items) {
      if (it.kind === 'task') {
        const rows = it.rows.filter((r) => r.name === filter);
        if (rows.length > 0) out.push({ ...it, rows });
      } else if (it.ev.kind === 'relay' && (it.ev.from === filter || it.ev.to === filter)) {
        out.push(it);
      }
    }
    return out;
  }, [items, filter]);

  if (list.length === 0) {
    if (!fill) return null;
    // Workbench main column: show a placeholder when there are no events, so the column never collapses to blank (fresh team / pure DAG with no member speech)
    return (
      <div
        className="flex min-h-0 w-full flex-1 items-center justify-center rounded-md border text-10"
        style={{
          borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--paper-soft) 55%, transparent)',
          color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)',
        }}
      >
        No collaboration events yet
      </div>
    );
  }

  return (
    <div className={cn('relative flex w-full min-w-0 flex-col', fill && 'min-h-0 flex-1')}>
      {speakers.length >= 2 && (
        <div className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-1 pb-1">
          <Chip active={filter === null} onClick={() => setFilter(null)}>
            All
          </Chip>
          {speakers.map((name) => (
            <Chip
              key={name}
              hue={hueOf(name)}
              active={filter === name}
              onClick={() => setFilter((prev) => (prev === name ? null : name))}
            >
              {name}
            </Chip>
          ))}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-live="polite"
        aria-label="Collaboration stream"
        className={cn(
          'ai-canvas-scroll w-full overflow-y-auto rounded-md border px-2 py-1.5 outline-none',
          fill ? 'min-h-0 flex-1' : 'max-h-[320px]',
        )}
        style={{
          borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--paper-soft) 55%, transparent)',
        }}
      >
        {visible.length === 0 && (
          <div className="flex w-full items-center justify-center py-3 text-10" style={{ color: DIM }}>
            No events for {filter}
          </div>
        )}
        {visible.map((it) => {
          if (it.kind === 'task') {
            return (
              <TaskBlockView
                key={it.taskId}
                block={it}
                collapsed={collapsed.has(it.taskId)}
                onToggle={() => toggleCollapse(it.taskId)}
                ui={ui}
                streaming={!!isStreaming}
                stalledMs={stallHints[it.taskId]}
              />
            );
          }
          const e = it.ev;
          const key = it.key;
          // System line (run start/end): centered thin rule + text, acting as the event divider in the "group chat"
          if (e.kind === 'team_start') {
            return (
              <SystemLine key={key} at={e.at} icon={<Flag className="h-2.5 w-2.5" />}>
                Run started · {e.memberNames.length} members · {e.taskCount} tasks
                {e.goal ? ` · ${clip(e.goal)}` : ''}
              </SystemLine>
            );
          }
          if (e.kind === 'team_done') {
            return (
              <SystemLine key={key} at={e.at} icon={<Check className="h-2.5 w-2.5" />}>
                Run finished · {e.done}/{e.total} done
                {e.failed > 0 ? ` · ${e.failed} failed` : ''}
                {e.timedOut ? ' · stopped early on time budget' : ''}
              </SystemLine>
            );
          }
          if (e.kind === 'system') {
            return (
              <SystemLine key={key} at={e.at} icon={<Info className="h-2.5 w-2.5" />} wrap>
                {clip(e.text)}
              </SystemLine>
            );
          }
          // Messages between members: one indented line, using an arrow to express from → to
          if (e.kind === 'relay') {
            return (
              <div key={key} className="flex w-full min-w-0 items-start gap-1 py-0.5 pl-4">
                <Send className="mt-0.5 h-2.5 w-2.5 shrink-0" style={{ color: 'var(--info)' }} />
                <span className="shrink-0 text-10 font-medium" style={{ color: 'var(--ink)' }}>
                  {e.from}
                </span>
                <ChevronRight className="mt-0.5 h-2.5 w-2.5 shrink-0" style={{ color: DIM }} />
                <span className="shrink-0 text-10 font-medium" style={{ color: 'var(--ink)' }}>
                  {e.to}
                </span>
                <span
                  className="min-w-0 flex-1 whitespace-pre-wrap break-words text-10 leading-relaxed"
                  style={{ color: 'color-mix(in oklab, var(--ink) 78%, transparent)' }}
                >
                  {clip(e.text)}
                </span>
                {e.at > 0 && (
                  <span className="shrink-0 text-9" style={{ color: DIM }}>
                    {hms(e.at)}
                  </span>
                )}
              </div>
            );
          }
          // Member event with no task (message wake-up / captain speech): a standalone row
          return <MemberRow key={key} ev={e} textKey={key} ui={ui} streaming={!!isStreaming} />;
        })}
        <div ref={endRef} />
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border px-2 py-0.5 text-9 font-medium shadow-sm transition-colors"
          style={{
            borderColor: 'color-mix(in oklab, var(--line) 55%, transparent)',
            backgroundColor: 'var(--paper)',
            color: 'var(--primary-strong)',
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** One collapsible task block: header (subject + duration + time) and the narration rows underneath */
function TaskBlockView({
  block,
  collapsed,
  onToggle,
  ui,
  streaming,
  stalledMs,
}: {
  block: TaskBlock;
  collapsed: boolean;
  onToggle: () => void;
  ui: TextUI;
  /** Whether the run is still live: an unfinished block only breathes while the scheduler is actually pushing it */
  streaming: boolean;
  /** Milliseconds without progress from this task's member (≥ the stall window): flagged instead of breathing */
  stalledMs?: number;
}) {
  const failed = block.rows.some((r) => r.kind === 'member_failed');
  const done = block.rows.some((r) => r.kind === 'member_done');
  const running = !failed && !done;
  const duration = block.at > 0 && block.lastAt > block.at ? block.lastAt - block.at : 0;
  const subject = block.subject || '(untitled task)';
  return (
    <div
      className="my-1 w-full min-w-0 rounded-sm border-l-2 py-0.5 pl-1.5"
      style={{
        borderColor: failed ? 'var(--danger)' : running ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--success) 55%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--paper) 45%, transparent)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={subject}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded px-0.5 text-left transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_60%,transparent)]"
      >
        {collapsed ? (
          <ChevronRight className="h-2.5 w-2.5 shrink-0" style={{ color: DIM }} />
        ) : (
          <ChevronDown className="h-2.5 w-2.5 shrink-0" style={{ color: DIM }} />
        )}
        <span className="min-w-0 flex-1 truncate text-10 font-medium" style={{ color: failed ? 'var(--danger)' : 'var(--ink)' }}>
          {subject}
        </span>
        {running && stalledMs ? (
          <span
            className="flex shrink-0 items-center gap-0.5 text-9"
            style={{ color: 'var(--warn)' }}
            title="This member has reported no progress for a while — the run may be stuck"
          >
            <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
            Possibly stalled · {fmtDuration(stalledMs)}
          </span>
        ) : running && streaming ? (
          <span className="flex shrink-0 items-center gap-0.5" style={{ color: 'var(--primary-strong)' }}>
            <span className="think-dot" />
            <span className="think-dot" />
            <span className="think-dot" />
          </span>
        ) : running ? (
          <CircleDashed className="h-2.5 w-2.5 shrink-0" style={{ color: DIM }} />
        ) : null}
        {duration > 0 && (
          <span className="shrink-0 text-9" style={{ color: DIM }}>
            {fmtDuration(duration)}
          </span>
        )}
        {block.lastAt > 0 && (
          <span className="shrink-0 text-9" style={{ color: DIM }}>
            {hms(block.lastAt)}
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="flex flex-col pt-0.5">
          {block.rows.map((r, i) => (
            <MemberRow key={`${r.kind}-${r.memberId}-${i}`} ev={r} inBlock textKey={`${block.taskId}:${i}`} ui={ui} streaming={streaming} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Member row: avatar + name + status + narration (start / markdown output / failure reason) */
function MemberRow({
  ev,
  inBlock,
  textKey,
  ui,
  streaming,
}: {
  ev: MemberEvent;
  inBlock?: boolean;
  textKey: string;
  ui: TextUI;
  /** Whether the run is still live: "started" only breathes while the member is actually still working */
  streaming: boolean;
}) {
  const failed = ev.kind === 'member_failed';
  const running = ev.kind === 'member_start';
  const hue = hueOf(ev.name);
  const raw = ev.kind === 'member_done' ? ev.summary : ev.kind === 'member_failed' ? ev.error : undefined;
  // The event text is capped upstream; the untruncated output is only reachable through the engine snapshot
  const full = ev.kind === 'member_done' && ev.taskId ? ui.results?.[ev.taskId] : undefined;
  const clipped = clip(raw);
  const canExpand = !!full && full.length > clipped.length;
  const text = canExpand && ui.expanded.has(textKey) ? full! : clipped;
  const body = running
    ? ev.subject && !inBlock
      ? `Working on: ${ev.subject}`
      : 'Started working'
    : text || (failed ? 'Task failed' : 'Task completed');
  return (
    <div className="flex w-full min-w-0 items-start gap-1.5 py-0.5">
      <span
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-9 font-semibold"
        style={{
          backgroundColor: `color-mix(in oklab, hsl(${hue} 62% 52%) 14%, transparent)`,
          color: `hsl(${hue} 48% 42%)`,
        }}
      >
        {initial(ev.name)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <div className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-10 font-semibold" style={{ color: 'var(--ink)' }}>
            {ev.name}
          </span>
          {running && streaming ? (
            <span className="flex shrink-0 items-center gap-0.5" style={{ color: 'var(--primary-strong)' }}>
              <span className="think-dot" />
              <span className="think-dot" />
              <span className="think-dot" />
            </span>
          ) : running ? (
            <CircleDashed className="h-2.5 w-2.5 shrink-0" style={{ color: DIM }} />
          ) : failed ? (
            <X className="h-2.5 w-2.5 shrink-0" style={{ color: 'var(--danger)' }} />
          ) : (
            <Check className="h-2.5 w-2.5 shrink-0" style={{ color: 'var(--success)' }} />
          )}
          {ev.at > 0 && (
            <span className="shrink-0 text-9" style={{ color: DIM }}>
              {hms(ev.at)}
            </span>
          )}
        </div>
        {failed || running ? (
          <span
            className="w-full whitespace-pre-wrap break-words text-10 leading-relaxed"
            style={{ color: failed ? 'var(--danger)' : DIM }}
          >
            {body}
          </span>
        ) : (
          <div className="w-full min-w-0 text-10" style={{ color: 'color-mix(in oklab, var(--ink) 78%, transparent)' }}>
            <MarkdownBody text={body} />
            {canExpand && (
              <button
                type="button"
                onClick={() => ui.toggle(textKey)}
                className="mt-0.5 cursor-pointer text-9 underline underline-offset-2"
                style={{ color: 'var(--primary-strong)' }}
              >
                {ui.expanded.has(textKey) ? 'Show less' : `Show full text (${full!.length.toLocaleString()} chars)`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Member output as Markdown (no raw HTML: react-markdown escapes it by default).
 *  The whole tree is kept compact so a chat row stays a chat row instead of turning into a document. */
export function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

function MdHeading({ children }: { children?: ReactNode }) {
  return <div className="mt-1 mb-0.5 font-semibold">{children}</div>;
}

const MD_COMPONENTS: Components = {
  p: ({ children }) => <p className="my-0.5 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-0.5 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-0.5 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: MdHeading,
  h2: MdHeading,
  h3: MdHeading,
  h4: MdHeading,
  h5: MdHeading,
  h6: MdHeading,
  code: ({ className, children }) =>
    /language-/.test(className ?? '') ? (
      <code className="font-mono text-9 leading-relaxed">{children}</code>
    ) : (
      <code
        className="rounded px-1 font-mono text-9"
        style={{ backgroundColor: 'color-mix(in oklab, var(--line) 22%, transparent)' }}
      >
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre
      className="my-1 overflow-x-auto rounded-md border px-1.5 py-1 text-9 leading-relaxed"
      style={{
        borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--paper) 75%, transparent)',
        color: 'color-mix(in oklab, var(--ink) 88%, transparent)',
      }}
    >
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2" style={{ color: 'var(--info)' }}>
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote
      className="my-0.5 border-l-2 pl-2"
      style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', color: 'color-mix(in oklab, var(--ink) 68%, transparent)' }}
    >
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-1 w-full overflow-x-auto">
      <table className="w-full border-collapse text-9">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th
      className="border px-1 py-0.5 text-left font-semibold"
      style={{ borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)' }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border px-1 py-0.5 align-top" style={{ borderColor: 'color-mix(in oklab, var(--line) 35%, transparent)' }}>
      {children}
    </td>
  ),
  hr: () => <hr className="my-1" style={{ borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)' }} />,
};

/** Member filter chip (All + one per speaker, tinted with that member's own hue) */
function Chip({
  active,
  hue,
  onClick,
  children,
}: {
  active: boolean;
  hue?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  const tinted = hue !== undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="shrink-0 cursor-pointer rounded-full border px-1.5 py-px text-9 transition-colors"
      style={{
        borderColor: active
          ? tinted
            ? `hsl(${hue} 45% 48%)`
            : 'var(--primary-strong)'
          : 'color-mix(in oklab, var(--line) 45%, transparent)',
        backgroundColor: active
          ? tinted
            ? `color-mix(in oklab, hsl(${hue} 62% 52%) 14%, transparent)`
            : 'color-mix(in oklab, var(--primary) 12%, transparent)'
          : 'transparent',
        color: active ? (tinted ? `hsl(${hue} 48% 42%)` : 'var(--primary-strong)') : DIM,
      }}
    >
      {children}
    </button>
  );
}

/** System line: "on-stage events" such as run start/end, separated from member speech by a centered thin line.
 *  wrap: expand and wrap when the text is long (engine-side system events can reach hundreds of characters, and truncating to a single line would lose all of it). */
function SystemLine({
  icon,
  at,
  children,
  wrap,
}: {
  icon: ReactNode;
  at?: number;
  children: ReactNode;
  wrap?: boolean;
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 py-1">
      <span className="shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 65%, transparent)' }}>
        {icon}
      </span>
      <span
        className={`min-w-0 text-10 ${wrap ? 'whitespace-pre-wrap break-words' : 'truncate'}`}
        style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}
      >
        {children}
      </span>
      {at !== undefined && at > 0 && (
        <span className="shrink-0 text-9" style={{ color: DIM }}>
          {hms(at)}
        </span>
      )}
      <span
        className="h-px min-w-2 flex-1"
        style={{ backgroundColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}
      />
    </div>
  );
}
