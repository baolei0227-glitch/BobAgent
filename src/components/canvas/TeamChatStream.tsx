'use client';

/**
 * TeamChatStream —— the multi-agent collaboration "chat stream" (form A presentation layer).
 *
 * Renders the incremental events the host projects during a team_run orchestration (TeamChatEvent[])
 * as a group-chat-like message stream, grouped by task: run started / task block (member started, member
 * output, member failure) / message relayed / captain speech / run finished. **Pure presentation**: it does
 * not change orchestration behavior, and its underlying data comes from the same source as the "member
 * branch cards" (the same subagent_update + subagent_events frames).
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
 *   - Row shape (what makes this column feel like the chat step list): each event is **one flat line** —
 *     icon + speaker + one-line summary + status + duration/time. Success stays silent, only a live row
 *     breathes and only a failure is marked. Nothing is nested: one executed task = one row
 *     (member_start + member_done for the same taskId collapse into it).
 *   - Member speech reads as a group chat: one short truncated line, never a document — no expand toggle
 *     anywhere on a member's behalf (hover reveals the untruncated text; the whole output document lives in
 *     the task reading view, opened from the task list / timeline).
 *   - Deliverables: files a member wrote this turn are posted under its row as group-chat-style file cards
 *     (type glyph + name + size), and clicking one opens it in the canvas viewer (`file.open`).
 *   - Markdown: the captain / system payloads behind a click render as Markdown (react-markdown + remark-gfm);
 *     raw HTML stays escaped.
 *   - Filtering: a member chip row appears once two or more members have spoken.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Crown,
  File,
  FileCode2,
  FileText,
  Flag,
  Image as ImageIcon,
  Info,
  Presentation,
  Table,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { bus, BusEvents } from '@/lib/bus';
import { formatFileSize } from '@/components/canvas/composer/useComposer';
import type { SubagentBranch, TeamArtifactItem, TeamChatEvent } from '@/lib/types';

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

/**
 * First meaningful line of a Markdown body — the one-line summary shown while a row is collapsed.
 * Heading hashes, list bullets and quote markers are stripped so the line reads as prose, not as syntax
 * (the full body, syntax and all, is what the expanded panel renders).
 */
function firstLine(text: string | undefined): string {
  if (!text) return '';
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*>\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (line) return line;
  }
  return '';
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

/** Fixed display name of the orchestrator in the stream (it is not a team member, so it gets no member hue) */
const CAPTAIN = 'Captain';

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
 * Render model: member events sharing a taskId collapse into one row (the chat-style "one line per executed
 * task"); everything else stays a line of its own. A task sits at the position of its first event, so the
 * timeline stays ordered by "when the task started".
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

export default function TeamChatStream({
  events,
  members,
  isStreaming,
  fill,
  goal,
  taskCount,
  question,
}: {
  /** Incremental event timeline (accumulated during this turn's streaming; empty after restart, then the members fallback kicks in) */
  events?: TeamChatEvent[] | null;
  /** Snapshot used by the degraded synthesis (also tells whether any member is still in progress) */
  members: SubagentBranch[];
  /** Whether this turn is still streaming (in-progress members show a breathing dot) */
  isStreaming?: boolean;
  /** Fill the parent's height (used by the team workbench main column); defaults to content height capped at 320px */
  fill?: boolean;
  /** Team goal / task count: only used to synthesize the run-start line in the degraded (post-restart) view */
  goal?: string;
  taskCount?: number;
  /**
   * The ask that opened the run, when the engine events cannot carry it yet: before approval the team has no
   * team_start event, so the stream would otherwise open with nothing at all (the panel reads as blank).
   * Once team_start exists it wins (it is the persisted source of truth and survives a reload).
   */
  question?: string;
}) {
  const list = useMemo(
    () => (events && events.length > 0 ? events : synthesizeEvents(members, goal, taskCount)),
    [events, members, goal, taskCount],
  );
  // Chronological order (the host emits in order, but synthesized/replayed inputs may not be sorted)
  const sorted = useMemo(() => [...list].sort((a, b) => a.at - b.at), [list]);
  const items = useMemo(() => buildItems(sorted), [sorted]);

  /** The run's opening message: the user's own ask, carried by the run-start event (host-supplied, rode the
   *  engine log → survives a reload, and stays correct when an older run is reopened). Old runs and
   *  non-interactive paths have none → nothing is rendered. */
  const ask = useMemo(() => {
    for (const e of sorted) if (e.kind === 'team_start' && e.question) return { text: e.question, at: e.at };
    /* Pre-approval (or discarded): no team_start event yet — fall back to the ask handed in by the workbench,
       so the opening message is on screen from the moment the run is launched */
    return question ? { text: question, at: undefined } : null;
  }, [sorted, question]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  /** Whether the reader is parked at the bottom (only then do new events follow automatically) */
  const [atBottom, setAtBottom] = useState(true);
  const [filter, setFilter] = useState<string | null>(null);
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

  // Stall hints: the engine keeps the snapshot flowing while a member is stuck, so a frozen progress text is
  // the only signal that this branch stopped advancing (the breathing dot alone looks like normal work)
  const trackItems = useMemo<StallTrackItem[]>(
    () => members.map((m) => ({ id: m.taskId ?? m.id, active: m.state === 'running', progressText: m.progressText })),
    [members],
  );
  const stallHints = useStallHints(trackItems);

  /** Speakers worth a filter chip: members that have spoken, plus the captain once it has said anything */
  const speakers = useMemo(() => {
    const out: string[] = [];
    let captain = false;
    for (const e of sorted) {
      if (isMemberEvent(e)) {
        if (!out.includes(e.name)) out.push(e.name);
      } else if (e.kind === 'captain' || (e.kind === 'relay' && (e.from === CAPTAIN || e.to === CAPTAIN))) {
        captain = true;
      }
    }
    return captain ? [CAPTAIN, ...out] : out;
  }, [sorted]);

  // Member filter: keep only what that member said / was told (on-stage system lines are noise then).
  // The captain is a pseudo-speaker: its own rows, plus the relays it sent or received, plus captain rows
  // that address the selected member (that is how "the captain commented on X" stays visible under X).
  const visible = useMemo(() => {
    if (!filter) return items;
    const out: (TaskBlock | LineItem)[] = [];
    for (const it of items) {
      if (it.kind === 'task') {
        const rows = it.rows.filter((r) => r.name === filter);
        if (rows.length > 0) out.push({ ...it, rows });
      } else if (it.ev.kind === 'relay' && (it.ev.from === filter || it.ev.to === filter)) {
        out.push(it);
      } else if (
        it.ev.kind === 'captain' &&
        (filter === CAPTAIN || (it.ev.targets ?? []).includes(filter))
      ) {
        out.push(it);
      }
    }
    return out;
  }, [items, filter]);

  if (list.length === 0 && !ask) {
    if (!fill) return null;
    // Workbench main column: show a placeholder when there are no events, so the column never collapses to blank (fresh team / pure DAG with no member speech)
    return (
      <div
        className="flex min-h-0 w-full flex-1 items-center justify-center rounded-md border text-10"
        style={{
          borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
          /* Same surface as the loaded stream: the placeholder must not swap the column's colour */
          backgroundColor: '#fff',
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
              // The captain has no member hue: the neutral chip variant marks it as "not one of the workers"
              {...(name === CAPTAIN ? {} : { hue: hueOf(name) })}
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
          /* Plain white, not the tinted paper: this box is the reading surface of the whole stream, and the
             nodes/panels around it already carry the grey layers */
          backgroundColor: '#fff',
        }}
      >
        {/* The user's own opening message: kept above the speaker filter (it is the run's ask, not a
            speaker's line, so filtering by a member must not hide what everyone is answering) */}
        {ask && <UserRow text={ask.text} at={ask.at} />}
        {/* No events at all yet (planning / discarded): say so instead of the "No events for <member>" line,
            which only makes sense once a filter is hiding rows */}
        {list.length === 0 && (
          <div className="flex w-full items-center justify-center py-3 text-10" style={{ color: DIM }}>
            No collaboration events yet
          </div>
        )}
        {list.length > 0 && visible.length === 0 && (
          <div className="flex w-full items-center justify-center py-3 text-10" style={{ color: DIM }}>
            No events for {filter}
          </div>
        )}
        {visible.map((it) => {
          // One executed task = one row (its member_start / member_done / member_failed narration is the payload)
          if (it.kind === 'task') {
            return (
              <Fragment key={it.taskId}>
                <TaskRow block={it} streaming={!!isStreaming} stalledMs={stallHints[it.taskId]} />
                <ArtifactCards items={blockArtifacts(it)} />
              </Fragment>
            );
          }
          const e = it.ev;
          const key = it.key;
          // Run boundaries and engine notices: one muted line, long text opens instead of wrapping
          if (e.kind === 'team_start') {
            return (
              <SystemRow key={key} at={e.at} icon={<Flag className="h-3 w-3" />}>
                {`Run started · ${e.memberNames.length} members · ${e.taskCount} tasks`}
              </SystemRow>
            );
          }
          if (e.kind === 'team_done') {
            return (
              <SystemRow key={key} at={e.at} icon={<Check className="h-3 w-3" />}>
                {`Run finished · ${e.done}/${e.total} done${e.failed > 0 ? ` · ${e.failed} failed` : ''}${
                  e.timedOut ? ' · stopped early on time budget' : ''
                }`}
              </SystemRow>
            );
          }
          if (e.kind === 'system') {
            return (
              <SystemRow key={key} at={e.at} icon={<Info className="h-3 w-3" />}>
                {e.text}
              </SystemRow>
            );
          }
          if (e.kind === 'relay') {
            return <RelayRow key={key} ev={e} />;
          }
          if (e.kind === 'captain') {
            return <CaptainRow key={key} ev={e} />;
          }
          // Member event with no task (message wake-up): a standalone row, followed by the files it posted
          return (
            <Fragment key={key}>
              <MemberRow ev={e} streaming={!!isStreaming} />
              {e.kind === 'member_done' && <ArtifactCards items={e.artifacts ?? []} />}
            </Fragment>
          );
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

/**
 * One stream row — the very shape chat uses for a tool call (see ChatNodeKernel): a single flat line of
 * icon + speaker + one-line summary + status + duration/time, with the payload behind a click. Rows are
 * deliberately uniform so the eye can scan one line per step, and nothing ever renders as a nested block.
 *
 * `head` / `trail` are the fixed-width ends (speaker name, stage badge, targets); `body` is the only
 * flexible slot and is responsible for its own truncation.
 */
function StreamRow({
  icon,
  accent,
  head,
  body,
  trail,
  status,
  meta,
  panel,
}: {
  icon: ReactNode;
  /** Icon tint (member hue / semantic color); defaults to muted */
  accent?: string;
  head?: ReactNode;
  body: ReactNode;
  trail?: ReactNode;
  status?: ReactNode;
  /** Trailing muted metadata (duration / timestamp) */
  meta?: string;
  /** Expanded payload; when absent the row is a plain (non-expandable) line */
  panel?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = panel !== undefined;
  return (
    <div className="flex w-full min-w-0 flex-col items-start">
      <button
        type="button"
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
        aria-expanded={expandable ? open : undefined}
        title={expandable ? (open ? 'Collapse details' : 'Show details') : undefined}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 px-1 py-0.5 text-left transition-colors',
          expandable
            ? 'cursor-pointer hover:bg-[color:color-mix(in_oklab,var(--primary)_5%,transparent)]'
            : 'cursor-default',
        )}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" style={{ color: accent ?? DIM }}>
          {icon}
        </span>
        {head !== undefined && <span className="flex shrink-0 items-center gap-1">{head}</span>}
        {body}
        {trail}
        {status}
        {meta && (
          <span className="shrink-0 text-9" style={{ color: DIM }}>
            {meta}
          </span>
        )}
        {expandable &&
          (open ? (
            <ChevronDown className="h-2.5 w-2.5 shrink-0" style={{ color: DIM }} />
          ) : (
            <ChevronRight className="h-2.5 w-2.5 shrink-0" style={{ color: DIM }} />
          ))}
      </button>
      {expandable && open && (
        <div
          className="mb-0.5 flex w-full min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5"
          style={{
            borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--paper-soft) 60%, transparent)',
          }}
        >
          {panel}
        </div>
      )}
    </div>
  );
}

/**
 * The user's own turn, as a group-chat message: right-aligned bubble, the same convention the chat pane
 * already uses for user turns (own message on the right, everyone else runs as a document flow).
 *
 * It is the ask that opened the run, kept to a bounded height: a long prompt scrolls inside the bubble
 * instead of pushing the collaboration stream off the screen.
 */
function UserRow({ text, at }: { text: string; at?: number }) {
  return (
    <div className="flex w-full min-w-0 flex-col items-end pb-0.5">
      <div
        className="ai-canvas-scroll max-w-[85%] min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-11 leading-relaxed"
        style={{ maxHeight: 108, backgroundColor: 'var(--paper-hover)', color: 'var(--ink)' }}
      >
        {text}
      </div>
      {at !== undefined && at > 0 && (
        <span className="shrink-0 pr-1 text-9" style={{ color: DIM }}>
          {hms(at)}
        </span>
      )}
    </div>
  );
}

/** Member avatar: the initial on that member's own hue, so a name always reads the same color everywhere */
function Avatar({ name }: { name: string }) {
  const hue = hueOf(name);
  return (
    <span
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold"
      style={{
        backgroundColor: `color-mix(in oklab, hsl(${hue} 62% 52%) 16%, transparent)`,
        color: `hsl(${hue} 48% 42%)`,
      }}
    >
      {initial(name)}
    </span>
  );
}

/** Row status: a live row breathes, a stalled one warns, a failed one is marked ✕ — success stays silent
 *  (chat's convention: only exceptions deserve a mark). */
function StatusMark({
  running,
  failed,
  streaming,
  stalledMs,
}: {
  running?: boolean;
  failed?: boolean;
  streaming?: boolean;
  stalledMs?: number;
}) {
  if (running && stalledMs) {
    return (
      <span
        className="flex shrink-0 items-center gap-0.5 text-9"
        style={{ color: 'var(--warn)' }}
        title="No progress reported for a while — this member may be stuck"
      >
        <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
        {fmtDuration(stalledMs)}
      </span>
    );
  }
  if (running && streaming) {
    return (
      <span className="flex shrink-0 items-center gap-0.5" style={{ color: 'var(--primary-strong)' }}>
        <span className="think-dot" />
        <span className="think-dot" />
        <span className="think-dot" />
      </span>
    );
  }
  if (running) return <CircleDashed className="h-2.5 w-2.5 shrink-0" style={{ color: DIM }} />;
  if (failed) {
    return (
      <span className="shrink-0 text-10 font-bold leading-none" style={{ color: 'var(--danger)' }}>
        ✕
      </span>
    );
  }
  return null;
}

/** Uppercase micro label inside an expanded panel (the same language as chat's PURPOSE / ARGS / RESULT) */
function FieldLabel({ tone, children }: { tone?: string; children: ReactNode }) {
  return (
    <span
      className="shrink-0 text-10 font-semibold uppercase tracking-wide"
      style={{ color: tone ?? 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}
    >
      {children}
    </span>
  );
}

/** Scrollable payload block: Markdown for prose output, plain pre-wrap for raw error text */
function PanelBody({ text, markdown, tone }: { text: string; markdown?: boolean; tone?: string }) {
  return (
    <div
      className="ai-canvas-scroll max-h-[260px] w-full min-w-0 overflow-y-auto text-10 leading-relaxed"
      style={{ color: tone ?? 'color-mix(in oklab, var(--ink) 85%, transparent)' }}
    >
      {markdown ? <MarkdownBody text={text} /> : <span className="whitespace-pre-wrap break-words">{text}</span>}
    </div>
  );
}

/** One-line truncated preview (the flexible slot of a row) */
function Preview({ text, strong, tone, title }: { text: string; strong?: boolean; tone?: string; title?: string }) {
  return (
    <span
      className={cn('min-w-0 flex-1 truncate', strong ? 'text-11 font-medium' : 'text-10')}
      style={{ color: tone ?? (strong ? 'var(--ink)' : 'color-mix(in oklab, var(--ink-muted) 68%, transparent)') }}
      /* Rows are one line by design; the untruncated text stays reachable by hovering the line itself */
      title={title}
    >
      {text}
    </span>
  );
}

/** File-type look of an artifact card: hue + glyph (same vocabulary as the chat output-files card) */
function artifactKind(kind: string | undefined): { hue: string; Glyph: typeof File } {
  if (kind === 'doc' || kind === 'text') return { hue: '#537D96', Glyph: FileText };
  if (kind === 'sheet') return { hue: 'var(--success)', Glyph: Table };
  if (kind === 'slide') return { hue: '#C9772F', Glyph: Presentation };
  if (kind === 'pdf') return { hue: 'var(--danger)', Glyph: FileText };
  if (kind === 'image') return { hue: 'var(--purple)', Glyph: ImageIcon };
  if (kind === 'code') return { hue: 'var(--info)', Glyph: FileCode2 };
  return { hue: 'var(--ink-muted)', Glyph: File };
}

/**
 * Open a member-produced file exactly like the chat output-files card does: a project-relative path goes
 * through the project source, while a sandbox path (`~/` or absolute — what a member without project
 * context writes) opens as a local file.
 */
function openArtifact(f: TeamArtifactItem): void {
  const path = f.path.replace(/\\/g, '/');
  const name = f.name || path.split('/').pop() || 'file';
  const source = path.startsWith('~/') || path.startsWith('/') ? 'local' : 'project';
  bus.publish(BusEvents.fileOpen, { source, path, name });
}

/** The artifacts a task block produced (carried by its member_done row); empty when the task wrote no file */
function blockArtifacts(block: TaskBlock): TeamArtifactItem[] {
  for (let i = block.rows.length - 1; i >= 0; i--) {
    const r = block.rows[i];
    if (r.kind === 'member_done' && r.artifacts && r.artifacts.length > 0) return r.artifacts;
  }
  return [];
}

/**
 * A member's delivered files, posted into the stream as a group-chat file message: a tinted type tile on
 * the left, the file name and its size stacked on the right, and nothing else — the card carries the
 * document, never its content. Clicking it opens the file. Cards hang under the member's own row, so the
 * work report and its deliverables stay together while the row above remains a single flat line.
 */
function ArtifactCards({ items }: { items: TeamArtifactItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-1 pb-1 pl-[20px]">
      {items.map((f, i) => {
        const { hue, Glyph } = artifactKind(f.kind);
        const name = f.name || f.path.split('/').pop() || 'file';
        return (
          <button
            key={`${f.path}#${i}`}
            type="button"
            onClick={() => openArtifact(f)}
            title={`${f.path}\nClick to open`}
            className="flex w-[236px] max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_5%,transparent)]"
            style={{
              borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--paper) 80%, transparent)',
            }}
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
              style={{ backgroundColor: `color-mix(in oklab, ${hue} 12%, transparent)` }}
            >
              <Glyph className="h-[18px] w-[18px]" style={{ color: hue }} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="min-w-0 truncate text-11 font-medium" style={{ color: 'var(--ink)' }}>
                {name}
              </span>
              <span className="min-w-0 truncate text-9" style={{ color: DIM }}>
                {f.size > 0 ? formatFileSize(f.size) : 'File'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One executed task = one row, written the way a group-chat participant would say it: `Name` + what that
 * person just did. The spoken line comes from the member's own `say` (the one-line summary it wrote for the
 * team, see the engine's [[say]] protocol); when there is none (older runs, a model that skipped it) the row
 * falls back to a plain action sentence built from the facts (`Finished 「subject」 · 3 steps`), never to an
 * excerpt of the output document. The document itself is read in the task reading view, opened from the task
 * list / timeline — only the files a member wrote are posted here, as cards below the row.
 */
function TaskRow({
  block,
  streaming,
  stalledMs,
}: {
  block: TaskBlock;
  /** Whether the run is still live: the row only breathes while the scheduler is actually pushing it */
  streaming: boolean;
  /** Milliseconds without progress from this task's member (≥ the stall window) */
  stalledMs?: number;
}) {
  const failed = block.rows.some((r) => r.kind === 'member_failed');
  const done = block.rows.some((r) => r.kind === 'member_done');
  const running = !failed && !done;
  const duration = block.at > 0 && block.lastAt > block.at ? block.lastAt - block.at : 0;
  const subject = block.subject || '(untitled task)';
  // The narration comes from the block's last row (member_done carries the speech + output, member_failed the reason)
  const last = block.rows[block.rows.length - 1];
  const name = [...block.rows].reverse().find((r) => r.name)?.name ?? 'Member';
  const say = last.kind === 'member_done' ? last.say : undefined;
  const steps = last.kind === 'member_done' ? last.steps : 0;
  const raw = last.kind === 'member_done' ? last.summary : last.kind === 'member_failed' ? last.error : undefined;
  // Spoken line: the member's own words first, else a fact-built action sentence (never an excerpt)
  const line = say
    ? say
    : failed
      ? firstLine(raw) || 'Task failed'
      : running
        ? `Working on 「${subject}」`
        : `Finished 「${subject}」${steps && steps > 0 ? ` · ${steps} step${steps === 1 ? '' : 's'}` : ''}`;
  // Cost only, no wall-clock stamp: the row answers "how long did this take", while the exact time of day is
  // noise in a group chat (the timeline drawer and the engine event log keep the real timestamps)
  const meta = duration > 0 ? fmtDuration(duration) : undefined;
  return (
    <StreamRow
      icon={<Avatar name={name} />}
      head={
        <span className="shrink-0 text-11 font-medium" style={{ color: failed ? 'var(--danger)' : 'var(--ink)' }}>
          {name}
        </span>
      }
      body={
        <Preview
          text={line}
          tone={failed ? 'var(--danger)' : running ? DIM : 'color-mix(in oklab, var(--ink) 88%, transparent)'}
          {...(say ? {} : { title: `Task: ${subject}` })}
        />
      }
      status={<StatusMark running={running} failed={failed} streaming={streaming} stalledMs={stalledMs} />}
      meta={meta || undefined}
      panel={
        <>
          <div className="flex min-w-0 items-center gap-1.5 text-10">
            <span
              className="shrink-0 font-semibold"
              style={{
                color: failed ? 'var(--danger)' : running ? 'var(--primary-strong)' : 'var(--success)',
              }}
            >
              {failed ? 'Failed' : running ? 'Running' : 'Done'}
            </span>
            <span className="min-w-0 truncate font-medium" style={{ color: 'var(--ink)' }}>
              {subject}
            </span>
            {duration > 0 && (
              <span className="shrink-0" style={{ color: DIM }}>
                {fmtDuration(duration)}
              </span>
            )}
          </div>
          <div className="flex min-w-0 gap-1.5 text-10 leading-relaxed">
            <FieldLabel>Assignee</FieldLabel>
            <span className="min-w-0" style={{ color: 'var(--ink)' }}>
              {name}
            </span>
          </div>
          {raw ? (
            <div className="flex min-w-0 items-center gap-1.5 text-10 leading-snug">
              <FieldLabel tone={failed ? 'var(--danger)' : undefined}>{failed ? 'Error' : 'Output'}</FieldLabel>
              {/* Deliverables are read as files (cards below the row); only the opening line stays here */}
              <span
                className="min-w-0 truncate"
                style={{ color: failed ? 'var(--danger)' : 'var(--ink)' }}
                title={raw}
              >
                {firstLine(raw)}
              </span>
            </div>
          ) : (
            <div className="flex min-w-0 gap-1.5 text-10 leading-relaxed">
              <FieldLabel>Output</FieldLabel>
              <span className="min-w-0" style={{ color: DIM }}>
                {running ? 'Still working…' : '(no output)'}
              </span>
            </div>
          )}
        </>
      }
    />
  );
}

/**
 * Member event with no task of its own (a message wake-up): a standalone line. Rows that belong to a task
 * live inside TaskRow instead — that is what keeps "one executed task = one row" true.
 */
function MemberRow({
  ev,
  streaming,
}: {
  ev: MemberEvent;
  /** Whether the run is still live: the row only breathes while the member is actually still working */
  streaming: boolean;
}) {
  const failed = ev.kind === 'member_failed';
  const running = ev.kind === 'member_start';
  const raw = ev.kind === 'member_done' ? ev.summary : ev.kind === 'member_failed' ? ev.error : undefined;
  const say = ev.kind === 'member_done' ? ev.say : undefined;
  // A message wake-up reply has no task of its own, so this line *is* the message: the member's own spoken
  // line when it wrote one, else a short fact-built sentence — never an excerpt of the reply document.
  const preview = running
    ? ev.subject
      ? `Working on 「${ev.subject}」`
      : 'Started working'
    : failed
      ? firstLine(raw) || 'Task failed'
      : say || (raw ? 'Replied to the team' : 'Task completed');
  return (
    <StreamRow
      icon={<Avatar name={ev.name} />}
      head={
        <span className="shrink-0 text-11 font-medium" style={{ color: failed ? 'var(--danger)' : 'var(--ink)' }}>
          {ev.name}
        </span>
      }
      body={<Preview text={preview} tone={running ? DIM : undefined} title={raw} />}
      status={<StatusMark running={running} failed={failed} streaming={streaming} />}
    />
  );
}

/** Stage badge text: the captain's four kinds of speech, shown as a tag next to the name */
function stageLabel(stage: string): string {
  switch (stage) {
    case 'dispatch':
      return 'Dispatch';
    case 'review':
      return 'Review';
    case 'followup':
      return 'Follow-up';
    case 'synthesis':
      return 'Synthesis';
    default:
      return stage;
  }
}

/**
 * Captain row: the orchestrator's own speech — dispatching tasks, commenting on each member, following up,
 * and the final synthesis. It is not a team member, so it gets a fixed icon instead of a member hue dot,
 * plus a stage badge saying what kind of note this is (and, when it addresses specific members, who).
 * Same rhythm as every other row: one spoken line (`line`, falling back to the note's first sentence), with
 * the full note behind a click.
 */
function CaptainRow({ ev }: { ev: Extract<TeamChatEvent, { kind: 'captain' }> }) {
  const targets = ev.targets ?? [];
  const chipStyle = {
    borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)',
    color: DIM,
  } as const;
  return (
    <StreamRow
      icon={<Crown className="h-3 w-3" />}
      accent="var(--primary-strong)"
      head={
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-11 font-medium" style={{ color: 'var(--primary-strong)' }}>
            {CAPTAIN}
          </span>
          <span className="shrink-0 rounded-full border px-1 py-px text-9" style={chipStyle}>
            {stageLabel(ev.stage)}
          </span>
        </span>
      }
      body={<Preview text={ev.line || firstLine(ev.text) || '(no note)'} />}
      trail={
        targets.length > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5 text-9" style={{ color: DIM }}>
            <span className="shrink-0">→</span>
            {targets.map((t) => (
              <span key={t} className="shrink-0 rounded-full border px-1 py-px" style={chipStyle}>
                {t}
              </span>
            ))}
          </span>
        ) : undefined
      }
      meta={ev.at > 0 ? hms(ev.at) : undefined}
      panel={
        <>
          <FieldLabel>Note</FieldLabel>
          <PanelBody text={ev.text} markdown />
        </>
      }
    />
  );
}

/** Messages between members: one short line reading `from → to  ·  text` — a member's words, so no panel:
 *  like every other member line it stays one truncated line (hover reveals the rest) */
function RelayRow({ ev }: { ev: Extract<TeamChatEvent, { kind: 'relay' }> }) {
  return (
    <StreamRow
      // The speaker's own avatar (not a generic send icon): in a group chat a relay should read as
      // "this person said something to that person", the same way member rows read
      icon={<Avatar name={ev.from} />}
      accent="var(--info)"
      head={
        <span className="flex shrink-0 items-center gap-0.5 text-10">
          <span className="font-medium" style={{ color: 'var(--ink)' }}>
            {ev.from}
          </span>
          <ChevronRight className="h-2.5 w-2.5" style={{ color: DIM }} />
          <span className="font-medium" style={{ color: 'var(--ink)' }}>
            {ev.to}
          </span>
        </span>
      }
      body={
        <Preview text={ev.text} tone="color-mix(in oklab, var(--ink) 78%, transparent)" title={ev.text} />
      }
      meta={ev.at > 0 ? hms(ev.at) : undefined}
    />
  );
}

/**
 * Run boundary / engine notice (run start, run finished, member added, stranded takeover, …): one muted
 * line. Long notices open on click instead of wrapping, which is what used to make these rows tower.
 */
function SystemRow({ icon, at, children }: { icon: ReactNode; at?: number; children: string }) {
  return (
    <StreamRow
      icon={icon}
      body={
        <span className="min-w-0 flex-1 truncate" style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}>
          {children}
        </span>
      }
      meta={at !== undefined && at > 0 ? hms(at) : undefined}
      panel={children.length > 90 ? <PanelBody text={children} /> : undefined}
    />
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


