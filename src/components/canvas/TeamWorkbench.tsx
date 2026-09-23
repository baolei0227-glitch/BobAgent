'use client';

/**
 * TeamWorkbench —— the in-node "Team" view (the Team side of the chat node's [Chat | Team] switch).
 *
 * Difference from the chat view: the chat view shows "this turn's Q&A" (lives in conversation memory
 * and is persisted along with the answer); the Team view shows the engine-side (bob-team-mcp)
 * **persisted source of truth** for a team — members / task DAG / mailbox / event stream
 * (<teamId>.events.jsonl), which survives page reloads and app restarts.
 *
 * Data path: only through the host's /api/team/* (the host never touches the engine data dir directly;
 * all reads go through MCP tools).
 *   First frame: the first SSE `panel` frame carries a full snapshot (raw engine events + full member output);
 *   Increments: `events` frames (chat stream) / `results` frames (full text of newly done tasks) /
 *   `panel` frames (members / tasks / terminal state).
 * Interventions (phase one is read-only plus two actions): msg_send (broadcast / @directed, idle members
 * are woken immediately) + task_retry.
 *
 * Launching: this view is the **sole entry point for multi-agent runs** — either the "New run" button at the
 * top (when a team already exists) or the empty state that directly offers a requirement input + member
 * picker + launch. Both render the same initial (launch) interface; the node's past runs stay listed under
 * it (click to open one, × to drop it from the node). Launching does not build its own pipeline: it hands
 * the requirement to the host node as a regular /api/chat turn (forcing multiAgentMode); the team then lands
 * in this view, and the final answer merged by the main agent still returns to the chat stream.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Copy,
  History,
  Info,
  Layers,
  Loader2,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Users,
  X,
} from 'lucide-react';
import TeamChatStream, { fmtDuration, MarkdownBody, useStallHints, type StallTrackItem } from './TeamChatStream';
import TeamTimeline from './TeamTimeline';
import { useComposer, type ComposerContext } from './composer/useComposer';
import ComposerChips from './composer/ComposerChips';
import MentionMenu from './composer/MentionMenu';
import { mapEngineEvents } from '@/lib/chat/team-events';
import type { SubagentBranch, TeamChatEvent, TeamDetail, TeamStreamFrame, TeamSummary, TeamTaskView } from '@/lib/types';

/** Task status → label (engine TaskStatus) */
const TASK_LABEL: Record<string, string> = {
  draft: 'Planned',
  ready: 'Ready',
  claimed: 'Claimed',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

/** Relative time for the unfinished-plan list (minute granularity is plenty — these are stale drafts) */
function fmtAgo(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Member status → dot color (engine MemberStatus) */
const MEMBER_COLOR: Record<string, string> = {
  idle: 'var(--ink-muted)',
  busy: 'var(--primary-strong)',
  parked: 'var(--warn)',
  offline: 'var(--ink-muted)',
};

/**
 * 心跳接管阈值兜底值：正常由引擎下发的 `staleMs` 覆盖（面板载荷带 STALE_MS），
 * 仅在引擎版本较旧、未下发该字段时使用。必须与 bob-team-mcp scheduler.ts 的 STALE_MS 一致。
 */
const FALLBACK_STALE_MS = 6 * 60 * 1000;

/**
 * 「未完成草案」可认领时效（30 分钟）：草案只有被 approve 才物化成员/任务，未被批准的草案
 * 指向一个永不推进的团队 —— 点开即把 teamId 绑进节点并长期订阅，面板永远空白。
 * 门禁超时/断开现在会主动 team_discard 收口（status 转 discarded，不再出现在清单里）；
 * 本阈值只兜住「进程/宿主中途消失、没来得及 discard」的残留草案，过了时效不再列为可恢复。
 */
const DRAFT_ADOPT_TTL_MS = 30 * 60 * 1000;

/**
 * 任务耗时：claimedAt → finishedAt（终态），运行中的任务延展到「现在」。
 * 起止时间戳均来自引擎（认领 / 落终态时写入），未开跑的任务返回 undefined。
 */
function taskDuration(t: TeamTaskView, now: number): number | undefined {
  if (typeof t.claimedAt !== 'number') return undefined;
  const running = t.status === 'running' || t.status === 'claimed';
  const end = typeof t.finishedAt === 'number' ? t.finishedAt : running ? now : undefined;
  if (typeof end !== 'number') return undefined;
  return Math.max(0, end - t.claimedAt);
}

/**
 * Merged result shown in this view: every member's output, in the engine's dependency order.
 *
 * Same content team_run feeds back to the main agent for the final answer — but that copy is capped
 * (PER_RESULT_CAP / TOTAL_CAP), while this panel shows the full text, exactly like the per-task reading view.
 */
function composeDeliverable(
  tasks: TeamTaskView[],
  results: Record<string, string>,
  name: (id?: string) => string,
): string {
  const blocks: string[] = [];
  for (const t of tasks) {
    const body = (results[t.id] ?? '').trim();
    if (!body) continue;
    blocks.push(`## ${t.subject}${t.assignee ? ` · ${name(t.assignee)}` : ''}\n\n${body}`);
  }
  return blocks.join('\n\n---\n\n');
}

function TaskIcon({ status }: { status: string }) {
  if (status === 'done') return <Check className="h-2.5 w-2.5" style={{ color: 'var(--success)' }} />;
  if (status === 'failed') return <X className="h-2.5 w-2.5" style={{ color: 'var(--danger)' }} />;
  if (status === 'running' || status === 'claimed')
    return <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: 'var(--primary-strong)' }} />;
  return <CircleDashed className="h-2.5 w-2.5" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }} />;
}

export default function TeamWorkbench({
  teamIds,
  presetAgentIds,
  launching,
  nodeId,
  nodeTitle,
  onOpenMemberPicker,
  onLaunch,
  onAdoptTeam,
  onForgetTeam,
  mainModel,
  workerModel,
  modelOptions,
  onSelectMainModel,
  onSelectWorkerModel,
}: {
  teamIds: string[];
  /** Preset members for this run (installed Agent package ids, see TeamMemberPickerDialog): display only, not persisted */
  presetAgentIds: string[];
  /** This node has a turn in flight (launch button disabled to avoid stacking requests) */
  launching: boolean;
  /** Host node id — attachment upload target (files land in materials/<id_title>/); null disables uploads */
  nodeId: string | null;
  /** Host node title (part of the materials folder name) */
  nodeTitle?: string;
  /** Open the member picker dialog (reuses the chat node's TeamMemberPickerDialog; the node still owns the list) */
  onOpenMemberPicker: () => void;
  /** Launch collaboration: sends the requirement as a /api/chat turn on this node (forcing multiAgentMode);
   *  ctx = this input bar's own attachment / @-reference context, merged into the same turn */
  onLaunch: (text: string, ctx?: ComposerContext) => void;
  /** Link an orphaned team plan to this node (see the "unfinished plans" recovery list in the empty state) */
  onAdoptTeam: (teamId: string) => void;
  /** Drop a past run from this node's list (the engine-side record is left untouched) */
  onForgetTeam: (teamId: string) => void;
  /** Two-tier model choice for a run: the captain runs on `mainModel`, every member runs on `workerModel`.
   *  Both are picked from the model pool below the launch input and persisted on the node frontmatter
   *  (team_main_model / team_worker_model); they never touch the node's own chat model. */
  mainModel: string;
  workerModel: string;
  /** Model pool candidates for the two dropdowns (same source as the node's chat model menu) */
  modelOptions: Array<{ modelId: string; label: string }>;
  onSelectMainModel: (modelId: string) => void;
  onSelectWorkerModel: (modelId: string) => void;
}) {
  const idsKey = teamIds.join(',');
  const [selectedId, setSelectedId] = useState<string | null>(teamIds[0] ?? null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  /** Chat stream (engine events → presentation-layer mapping; first-frame snapshot + SSE increments) */
  const [events, setEvents] = useState<TeamChatEvent[]>([]);
  /** Full member output text: taskId → text (first-frame snapshot + results frames) */
  const [results, setResults] = useState<Record<string, string>>({});
  /** Id of the task whose full text is being read (null = showing the chat stream) */
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** Interjection target: 'all' = broadcast to everyone, otherwise a member id */
  const [target, setTarget] = useState('all');
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  /** "New run" view: the initial launch interface (shown instead of the run detail; past runs stay listed under it) */
  const [launchOpen, setLaunchOpen] = useState(false);
  /** Expanded state of the merged-result block (collapsed by default: the collaboration stream owns the main
   *  column, and the merged text duplicates the per-task output that the stream reveals on click) */
  const [deliverableOpen, setDeliverableOpen] = useState(false);
  const [copiedDeliverable, setCopiedDeliverable] = useState(false);
  /** 侧栏（成员/任务）展开状态：折叠优先于拖动——节点内嵌面板宽度受限，拖动易破版 */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /** 时间线抽屉开关（P1-3，甘特/泳道） */
  const [timelineOpen, setTimelineOpen] = useState(false);
  /** 被点击的成员：高亮其名下任务（再点一次取消） */
  const [highlightMember, setHighlightMember] = useState<string | null>(null);
  /** 被停摆横幅 #tN 定位到的任务：高亮并滚动到可视区 */
  const [highlightTask, setHighlightTask] = useState<string | null>(null);
  /** 侧栏滚动容器：停摆横幅点 #tN 时滚动定位任务行 */
  const asideRef = useRef<HTMLDivElement | null>(null);

  // Selection follows the node's run list: a freshly launched run takes the view (otherwise "New run" would
  // land back on the run the user was just looking at), a dropped selection falls back to the first run.
  const knownIdsRef = useRef<string[]>(teamIds);
  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    const known = knownIdsRef.current;
    knownIdsRef.current = ids;
    const added = ids.filter((x) => !known.includes(x));
    setSelectedId((prev) => {
      if (added.length > 0) return added[added.length - 1];
      return prev && ids.includes(prev) ? prev : (ids[0] ?? null);
    });
  }, [idsKey]);

  /**
   * Team list snapshot, fetched while the launch view is on screen: it labels this node's past runs (the
   * node only stores ids; the engine knows the name / goal) and surfaces unfinished plans.
   *
   * Unfinished plans: a team that was created but not yet approved only reaches this node through the
   * frames pushed after approval, so a reload before approval used to leave this panel blank forever.
   * Planning-state teams are exactly the ones that never got a chance to bind, so they are surfaced here
   * as a recovery entry (the list endpoint already exists; no engine-side project field is needed).
   */
  const [teamList, setTeamList] = useState<TeamSummary[]>([]);
  const launchView = teamIds.length === 0 || launchOpen;
  useEffect(() => {
    if (!launchView) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/team/list');
        const data = (await res.json().catch(() => null)) as { teams?: TeamSummary[] } | null;
        if (cancelled) return;
        setTeamList(data?.teams ?? []);
      } catch {
        /* Best-effort: without the list the runs fall back to their order label and the plans list stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [launchView]);

  const openPlans = useMemo(() => {
    if (teamIds.length > 0) return [];
    const now = Date.now();
    return teamList.filter(
      (t) =>
        t.status === 'planning' &&
        t.planDraft &&
        now - t.updatedAt < DRAFT_ADOPT_TTL_MS,
    );
  }, [teamList, teamIds.length]);

  /** Past-run label: engine name / goal when the snapshot has it, otherwise the position in this node's list */
  const runLabel = useCallback(
    (id: string, i: number) => {
      const s = teamList.find((t) => t.teamId === id);
      return s?.name || s?.goal || `Team ${i + 1}`;
    },
    [teamList],
  );

  // Subscribe to the selected team's live stream: the first frame is a full snapshot, then incremental frames
  useEffect(() => {
    if (!selectedId) return;
    let closed = false;
    /** Whether the snapshot has been consumed (EventSource reconnects automatically; on reconnect the server resends the full snapshot → it must be consumed again) */
    let snapshot = false;
    setDetail(null);
    setEvents([]);
    setResults({});
    setError(null);
    setReading(null);
    setTarget('all');
    const es = new EventSource(`/api/team/${encodeURIComponent(selectedId)}/stream`);
    es.onopen = () => {
      snapshot = false;
    };
    es.onmessage = (ev) => {
      if (closed) return;
      let frame: TeamStreamFrame;
      try {
        frame = JSON.parse(ev.data) as TeamStreamFrame;
      } catch {
        return;
      }
      if (frame.type === 'error') {
        setError(frame.message);
        return;
      }
      if (frame.type === 'panel') {
        setError(null);
        setDetail(frame.detail);
        if (!snapshot) {
          snapshot = true;
          // The snapshot's events are in raw engine form and must go through the same pure mapping to become chat-stream events
          const subjects = new Map(frame.detail.tasks.map((t) => [t.id, t.subject]));
          setEvents(mapEngineEvents(frame.detail.events ?? [], subjects));
          setResults(frame.detail.results ?? {});
        }
        return;
      }
      if (frame.type === 'events') {
        setEvents((prev) => [...prev, ...frame.events]);
        return;
      }
      if (frame.type === 'results') {
        setResults((prev) => ({ ...prev, ...frame.results }));
      }
    };
    es.onerror = () => {
      if (!closed) setError('Live connection lost, reconnecting…');
    };
    return () => {
      closed = true;
      es.close();
    };
  }, [selectedId]);

  const members = useMemo(() => detail?.members ?? [], [detail]);
  const tasks = useMemo(() => detail?.tasks ?? [], [detail]);

  /**
   * Pre-approval readability: the engine materializes members and tasks only on approve, so a team that is
   * still planning (or whose plan was discarded) has none of either — the panel used to collapse into an empty
   * shell ("No members", nothing in the stream) with no trace of what was planned. The plan draft rides the
   * panel and is what keeps the run readable: it lists the planned roster / tasks and the user's own ask.
   */
  const planned = detail?.planDraft;
  const plannedMembers = members.length === 0 ? (planned?.members ?? []) : [];
  const plannedTasks = tasks.length === 0 ? (planned?.tasks ?? []) : [];
  /** planning / discarded: drives the one-line explanation above the stream */
  const preRunStatus =
    detail && (detail.status === 'planning' || detail.status === 'discarded') ? detail.status : null;
  /** Roster size for the sidebar: the live members once materialized, the planned ones before that */
  const rosterCount = members.length > 0 ? members.length : plannedMembers.length;
  const rosterTaskCount = tasks.length > 0 ? tasks.length : plannedTasks.length;

  // Stall hints: this stream only pushes a frame when the panel actually changes, so a running task whose
  // progress text stopped changing is the only evidence that its member is stuck (the spinner keeps turning)
  const stallTrack = useMemo<StallTrackItem[]>(
    () =>
      tasks.map((t) => ({
        id: t.id,
        active: t.status === 'running' || t.status === 'claimed',
        progressText: t.progressText,
      })),
    [tasks],
  );
  const stallHints = useStallHints(stallTrack);
  const memberName = useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m.name]));
    return (id?: string) => (id ? (map.get(id) ?? id) : '');
  }, [members]);

  // Merged result: the run's deliverable, assembled from the members' full outputs (empty until a task lands)
  const deliverable = useMemo(
    () => composeDeliverable(tasks, results, memberName),
    [tasks, results, memberName],
  );
  const doneCount = useMemo(() => tasks.filter((t) => t.status === 'done').length, [tasks]);
  const failedCount = useMemo(() => tasks.filter((t) => t.status === 'failed').length, [tasks]);

  // 心跳接管阈值：优先用引擎下发值（单一事实来源），旧引擎下未下发时回落到本地常量
  const staleMs = detail?.staleMs ?? FALLBACK_STALE_MS;

  // 运行中任务存在时按 5s 走时钟：驱动「成员累计耗时」与「接管倒计时」增长（面板帧只在真变化时下发）
  const hasActiveTasks = useMemo(
    () => tasks.some((t) => t.status === 'running' || t.status === 'claimed'),
    [tasks],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActiveTasks) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [hasActiveTasks]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const isUnassigned = useCallback(
    (t: TeamTaskView) => !t.assignee || !memberIds.has(t.assignee),
    [memberIds],
  );

  /** 分配矩阵：每个成员的已分配数 / 已完成数 / 累计耗时（含运行中任务的实时增长） */
  const memberLoad = useMemo(() => {
    const map = new Map<string, { assigned: number; done: number; durationMs: number }>();
    for (const m of members) map.set(m.id, { assigned: 0, done: 0, durationMs: 0 });
    for (const t of tasks) {
      if (!t.assignee) continue;
      const rec = map.get(t.assignee);
      if (!rec) continue;
      rec.assigned += 1;
      if (t.status === 'done') rec.done += 1;
      rec.durationMs += taskDuration(t, now) ?? 0;
    }
    return map;
  }, [members, tasks, now]);

  // 停摆：引擎终态传播产出的 blockedBy（权威判定），前端不再自行按「deps 含 failed」推断
  const blockedTasks = useMemo(() => tasks.filter((t) => (t.blockedBy?.length ?? 0) > 0), [tasks]);
  const blockedUpstreams = useMemo(() => {
    const s = new Set<string>();
    for (const t of blockedTasks) for (const d of t.blockedBy ?? []) s.add(d);
    return [...s];
  }, [blockedTasks]);

  /** 停摆横幅点 #tN：高亮该任务并滚动到侧栏可视区 */
  const locateTask = useCallback((taskId: string) => {
    setHighlightTask(taskId);
    const el = asideRef.current?.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const copyDeliverable = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(deliverable);
      setCopiedDeliverable(true);
      setTimeout(() => setCopiedDeliverable(false), 1500);
    } catch {
      /* Clipboard unavailable (permissions) — the text stays selectable in the block */
    }
  }, [deliverable]);

  /**
   * Fallback timeline source for the chat stream: the incremental events are not persisted, so when the
   * engine's event window is empty the stream synthesizes a timeline from this. The workbench snapshot is
   * engine-shaped (member status + task status) while the synthesizer expects per-branch progress, so one
   * entry is derived per task that actually ran — that keeps the launch line, the task blocks and the
   * closing line intact after a restart.
   */
  const streamMembers = useMemo<SubagentBranch[]>(() => {
    const byId = new Map(members.map((m) => [m.id, m]));
    const out: SubagentBranch[] = [];
    for (const t of tasks) {
      if (t.status !== 'claimed' && t.status !== 'running' && t.status !== 'done' && t.status !== 'failed') continue;
      const done = t.status === 'done';
      const failed = t.status === 'failed';
      const m = t.assignee ? byId.get(t.assignee) : undefined;
      out.push({
        id: m?.id ?? t.assignee ?? t.id,
        name: m?.name ?? t.assignee ?? 'Member',
        role: m?.role ?? '',
        state: done ? 'done' : failed ? 'failed' : 'running',
        taskId: t.id,
        subject: t.subject,
        progressText: t.progressText,
        startAt: t.lastActivityAt,
        endAt: done || failed ? t.lastActivityAt : undefined,
        resultSummary: done ? results[t.id] : undefined,
        error: failed ? t.error : undefined,
      });
    }
    return out;
  }, [members, tasks, results]);

  // Interjection input: same attachment / @-reference capability as the chat input (shared useComposer core).
  // The control endpoint has no attachment metadata channel, so the references are serialized into the text.
  const interjectRef = useRef<HTMLDivElement>(null);
  const interjectFileRef = useRef<HTMLInputElement>(null);
  const interjectComposingRef = useRef(false);
  const composer = useComposer({
    nodeId,
    nodeTitle,
    disabled: sending,
    inputRef: interjectRef,
    text: draft,
    setText: setDraft,
    composingRef: interjectComposingRef,
  });

  /** Interject: broadcast (to='all') or direct (to=member id); the engine instantly wakes idle recipients */
  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!selectedId || !text || sending) return;
    const blocks = composer.buildBlocks();
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/team/${encodeURIComponent(selectedId)}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'msg_send', to: target, text: text + blocks }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error || `Send failed (${res.status})`);
      setDraft('');
      composer.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [draft, selectedId, target, sending, composer]);

  /** Retry a failed task: takes over the in-flight attempt and moves it back to ready for rescheduling (state transitions come back via SSE polling) */
  const retryTask = useCallback(
    async (taskId: string) => {
      if (!selectedId || retrying) return;
      setRetrying(taskId);
      setError(null);
      try {
        const res = await fetch(`/api/team/${encodeURIComponent(selectedId)}/control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'task_retry', taskId }),
        });
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(data?.error || `Retry failed (${res.status})`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRetrying(null);
      }
    },
    [selectedId, retrying],
  );

  // Launch view: the node has no run yet, or "New run" was pressed — the initial interface, identical in
  // both cases. Past runs stay reachable underneath: click one to open it, × to drop it from this node.
  if (launchView) {
    return (
      <div className="flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-3 py-8">
        <div className="flex shrink-0 items-center gap-1.5">
          <Users className="h-4 w-4" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }} />
          <span className="text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink) 72%, transparent)' }}>
            Start a multi-agent collaboration
          </span>
        </div>
        <div className="w-full max-w-[560px]">
          <LaunchPanel
            presetAgentIds={presetAgentIds}
            launching={launching}
            nodeId={nodeId}
            nodeTitle={nodeTitle}
            onOpenMemberPicker={onOpenMemberPicker}
            mainModel={mainModel}
            workerModel={workerModel}
            modelOptions={modelOptions}
            onSelectMainModel={onSelectMainModel}
            onSelectWorkerModel={onSelectWorkerModel}
            onLaunch={(t, ctx) => {
              setLaunchOpen(false);
              onLaunch(t, ctx);
            }}
          />
        </div>
        {/* Silent stretch between Launch and the first engine frame (captain planning) — see PlanningStatus.
            Only this node's first run leaves the launch view on screen (teamIds empty), so that is exactly
            where the stage needs to be named; once a run exists the run view takes over on the spot. */}
        {launching && teamIds.length === 0 && <PlanningStatus />}
        {teamIds.length > 0 ? (
          <div className="w-full max-w-[560px]">
            <div className="mb-1 flex items-center gap-1 text-10" style={{ color: 'color-mix(in oklab, var(--ink-muted) 78%, transparent)' }}>
              <History className="h-3 w-3 shrink-0" />
              Past runs — open one to watch it, or remove it from this node
            </div>
            <div className="flex max-h-[132px] flex-col gap-0.5 overflow-y-auto">
              {teamIds.map((id, i) => (
                <div
                  key={id}
                  className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 4%, transparent)' }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(id);
                      setLaunchOpen(false);
                    }}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-10"
                    style={{ color: 'color-mix(in oklab, var(--ink) 80%, transparent)' }}
                    title={`${runLabel(id, i)} · ${id}`}
                  >
                    {runLabel(id, i)}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onForgetTeam(id);
                    }}
                    className="flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded transition-opacity"
                    style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}
                    title="Remove this run from this node's list"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          openPlans.length > 0 && (
            <div className="w-full max-w-[560px]">
              <div className="mb-1 flex items-center gap-1 text-10" style={{ color: 'color-mix(in oklab, var(--ink-muted) 78%, transparent)' }}>
                <AlertCircle className="h-3 w-3 shrink-0" />
                Unfinished plans (created but never approved) — pick one to reopen it in this panel
              </div>
              <div className="flex max-h-[132px] flex-col gap-0.5 overflow-y-auto">
                {openPlans.map((p) => (
                  <button
                    key={p.teamId}
                    type="button"
                    onClick={() => onAdoptTeam(p.teamId)}
                    className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-10 transition-colors"
                    style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 4%, transparent)' }}
                    title={p.goal || p.name}
                  >
                    <span className="min-w-0 flex-1 truncate" style={{ color: 'color-mix(in oklab, var(--ink) 80%, transparent)' }}>
                      {p.goal || p.name}
                    </span>
                    <span className="shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                      {fmtAgo(p.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        )}
      </div>
    );
  }

  const readingTask = reading ? tasks.find((t) => t.id === reading) : undefined;

  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col gap-1.5">
      {/* New run: switches to the initial launch view (past runs stay listed there, see the launch view above) */}
      <div className="flex w-full min-w-0 shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLaunchOpen(true);
          }}
          className="flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1.5 text-10 font-medium transition-colors"
          style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)', color: 'var(--primary-strong)' }}
          title="Launch a new multi-agent run"
        >
          <Plus className="h-2.5 w-2.5" />
          New run
        </button>
        {presetAgentIds.length > 0 && !timelineOpen && (
          <span className="min-w-0 flex-1 truncate text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 65%, transparent)' }}>
            {presetAgentIds.length} preset members
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {/* Timeline: gantt/swimlane drawer (parallelism + queueing at a glance) */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setTimelineOpen(true);
            }}
            className="flex h-5 shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1.5 text-10 transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_70%,transparent)]"
            style={{ color: 'color-mix(in oklab, var(--ink-muted) 78%, transparent)' }}
            title="Show the run timeline (start/end of each task, parallelism)"
          >
            <BarChart3 className="h-2.5 w-2.5" />
            Timeline
          </button>
          {/* Sidebar collapse: the panel is node-embedded, so width is precious (collapse, not drag) */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSidebarOpen((v) => !v);
            }}
            className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_70%,transparent)]"
            style={{ color: 'color-mix(in oklab, var(--ink-muted) 78%, transparent)' }}
            title={sidebarOpen ? 'Collapse the members/tasks sidebar' : 'Expand the members/tasks sidebar'}
          >
            <ChevronRight className="h-3 w-3" style={sidebarOpen ? undefined : { transform: 'rotate(180deg)' }} />
          </button>
        </div>
      </div>

      {/* Team selector row: only the switcher between several runs, so it stays hidden for a single run
          (the ask bubble, the Run started/finished lines and the sidebar already carry that run's name and
          progress — an extra row repeating them is noise). Labels are short on purpose: the run's goal is
          long, and it is already on screen; hover reveals it in full. */}
      {teamIds.length > 1 && (
      <div className="flex w-full min-w-0 shrink-0 items-center gap-1 overflow-x-auto pb-0.5 hide-scrollbar">
        {teamIds.map((id, i) => {
          const active = id === selectedId;
          return (
            <div
              key={id}
              className="group flex shrink-0 items-center rounded-md pl-1.5 pr-0.5 transition-colors"
              style={active ? { backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)' } : undefined}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(id);
                }}
                title={`${runLabel(id, i)} · ${id}`}
                className="shrink-0 cursor-pointer py-0.5 text-10 font-medium"
                style={active ? { color: 'var(--primary-strong)' } : { color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}
              >
                {`Run ${i + 1}`}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onForgetTeam(id);
                }}
                className="flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded opacity-40 transition-opacity group-hover:opacity-100"
                style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}
                title="Remove this run from this node's list"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        })}
        <span className="shrink-0 text-10" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
          {tasks.length > 0
            ? `· ${tasks.filter((t) => t.status === 'done').length}/${tasks.length} done`
            : ''}
        </span>
      </div>
      )}

      {error && (
        <div
          className="flex w-full min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 py-1"
          style={{ backgroundColor: 'var(--danger-soft)' }}
        >
          <AlertCircle className="h-3 w-3 shrink-0" style={{ color: 'var(--danger)' }} />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-10" style={{ color: 'var(--danger)' }}>
            {error}
          </span>
        </div>
      )}

      {/* Stall banner: tasks whose failure came from an upstream failure (engine-authoritative blockedBy).
          These have no executable path until a human retries the upstream — surface that loudly and make the
          culprit upstream tasks reachable in one click. */}
      {blockedTasks.length > 0 && (
        <div
          className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-1 rounded-md px-2 py-1"
          style={{ backgroundColor: 'var(--danger-soft)' }}
        >
          <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: 'var(--danger)' }} />
          <span className="text-10" style={{ color: 'var(--danger)' }}>
            {blockedTasks.length} {blockedTasks.length === 1 ? 'task' : 'tasks'} stalled by failed upstream
          </span>
          {blockedUpstreams.map((id) => (
            <button
              key={id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                locateTask(id);
              }}
              className="shrink-0 cursor-pointer rounded px-1 text-10 font-medium underline decoration-dotted underline-offset-2"
              style={{ color: 'var(--danger)' }}
              title="Locate this failed upstream task — retry it to revive its dependents"
            >
              #{id}
            </button>
          ))}
          <span className="text-9" style={{ color: 'color-mix(in oklab, var(--danger) 80%, transparent)' }}>
            · retry the upstream to revive dependents automatically
          </span>
        </div>
      )}

      <div className="flex min-h-0 w-full min-w-0 flex-1 gap-2">
        {/* Main column: chat stream / full task output text */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Unapproved run: one muted line so the panel says what it is waiting for (the stream below is
              legitimately silent until approve materializes members and starts the schedule) */}
          {preRunStatus && (
            <div
              className="flex w-full min-w-0 shrink-0 items-center gap-1 px-1 pb-1 text-10"
              style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}
            >
              <Info className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {preRunStatus === 'discarded'
                  ? 'Plan discarded — no members or tasks were created'
                  : 'Plan awaiting approval — members and tasks are created once you approve'}
              </span>
            </div>
          )}
          {readingTask ? (
            <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
              <div className="flex w-full min-w-0 shrink-0 items-center gap-1.5 pb-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setReading(null);
                  }}
                  className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1 py-0.5 text-10 font-medium transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_70%,transparent)]"
                  style={{ color: 'var(--primary-strong)' }}
                >
                  <ArrowLeft className="h-2.5 w-2.5" />
                  Back to stream
                </button>
                <span className="min-w-0 flex-1 truncate text-10 font-medium" style={{ color: 'var(--ink)' }} title={readingTask.subject}>
                  {readingTask.subject}
                </span>
                <span className="shrink-0 text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 65%, transparent)' }}>
                  {memberName(readingTask.assignee)}
                </span>
              </div>
              <div
                className="ai-canvas-scroll min-h-0 w-full min-w-0 flex-1 overflow-y-auto rounded-md border px-2 py-1.5 text-10 leading-relaxed"
                style={{
                  borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                  backgroundColor: 'color-mix(in oklab, var(--paper-soft) 55%, transparent)',
                  color: 'color-mix(in oklab, var(--ink) 82%, transparent)',
                }}
              >
                {results[readingTask.id] ? <MarkdownBody text={results[readingTask.id]} /> : '(no output text)'}
              </div>
            </div>
          ) : (
            <>
              {/* Merged result: every member's output in dependency order, i.e. the one place to read or copy the
                  full text at once (the stream's per-task panels hold the same text, one click each).
                  Deliberately demoted to a single collapsed line: the collaboration stream below owns the main
                  column, and an open merged block would push it off the first screen. */}
              {deliverable && (
                <div className="mb-1 flex w-full min-w-0 shrink-0 flex-col overflow-hidden">
                  <div
                    onClick={() => setDeliverableOpen((v) => !v)}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_5%,transparent)]"
                  >
                    <Layers className="h-3 w-3 shrink-0" style={{ color: 'var(--primary-strong)' }} />
                    <span className="shrink-0 text-10 font-medium" style={{ color: 'var(--ink)' }}>
                      Merged result
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-9"
                      style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}
                    >
                      {doneCount} member outputs
                      {failedCount > 0 ? ` · ${failedCount} failed` : ''}
                      {detail && !detail.terminal ? ' · still running' : ''}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyDeliverable();
                      }}
                      className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 text-9 transition-colors"
                      style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 5%, transparent)', color: 'var(--ink-muted)' }}
                      title="Copy the merged result"
                    >
                      {copiedDeliverable ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
                      {copiedDeliverable ? 'Copied' : 'Copy'}
                    </button>
                    <ChevronDown
                      className={`h-3 w-3 shrink-0 transition-transform ${deliverableOpen ? '' : '-rotate-90'}`}
                      style={{ color: 'var(--ink-muted)' }}
                    />
                  </div>
                  {deliverableOpen && (
                    <div
                      className="ai-canvas-scroll mb-0.5 min-h-0 w-full min-w-0 overflow-y-auto rounded-md border px-2 py-1.5 text-10 leading-relaxed"
                      style={{
                        maxHeight: '34vh',
                        borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                        backgroundColor: 'color-mix(in oklab, var(--paper-soft) 60%, transparent)',
                        color: 'color-mix(in oklab, var(--ink) 82%, transparent)',
                      }}
                    >
                      <MarkdownBody text={deliverable} />
                    </div>
                  )}
                </div>
              )}
              <TeamChatStream
                fill
                events={events}
                members={streamMembers}
                isStreaming={detail ? !detail.terminal : false}
                goal={detail?.goal}
                taskCount={tasks.length}
                /* Ask fallback: pre-approval there is no team_start event to carry the ask. The draft holds the
                   user's exact wording; older runs (draft already cleared) fall back to the team goal, which is
                   also derived from that ask — either way the stream opens with what the run is about. */
                question={planned?.question ?? detail?.goal}
              />
            </>
          )}
        </div>

        {/* Side column: members + task DAG. Collapsible (not draggable): the panel is node-embedded,
            so a free drag risks broken layouts at narrow node widths. */}
        <aside
          ref={asideRef}
          className={`ai-canvas-scroll flex shrink-0 flex-col gap-2 overflow-y-auto rounded-md border py-1.5 ${
            sidebarOpen ? 'w-[184px] px-1.5' : 'w-[28px] items-center px-0.5'
          }`}
          style={{
            borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--paper) 55%, transparent)',
          }}
        >
          {!sidebarOpen ? (
            // Collapsed strip: counts only, click anywhere to expand
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSidebarOpen(true);
              }}
              className="flex w-full cursor-pointer flex-col items-center gap-1.5 rounded px-0.5 py-0.5 transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_60%,transparent)]"
              title="Expand the members/tasks sidebar"
            >
              <ChevronRight className="h-3 w-3 rotate-180" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }} />
              <span className="flex flex-col items-center gap-0.5" title={`${rosterCount} members`}>
                <Users className="h-2.5 w-2.5" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }} />
                <span className="text-8" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>{rosterCount}</span>
              </span>
              <span className="flex flex-col items-center gap-0.5" title={`${doneCount}/${rosterTaskCount} tasks done`}>
                <Layers className="h-2.5 w-2.5" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }} />
                <span className="text-8" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                  {doneCount}/{rosterTaskCount}
                </span>
              </span>
              {blockedTasks.length > 0 && (
                <span className="flex flex-col items-center gap-0.5" title={`${blockedTasks.length} tasks stalled by failed upstream`}>
                  <AlertTriangle className="h-2.5 w-2.5" style={{ color: 'var(--danger)' }} />
                  <span className="text-8" style={{ color: 'var(--danger)' }}>{blockedTasks.length}</span>
                </span>
              )}
            </button>
          ) : (
            <>
          <div className="flex flex-col gap-0.5">
            <span className="text-9 font-semibold uppercase tracking-wide" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
              Members {rosterCount > 0 ? `(${rosterCount})` : ''}
              {/* Planned roster: not created yet (approve materializes them) — say so instead of passing the
                  pre-approval rows off as running members */}
              {members.length === 0 && plannedMembers.length > 0 ? ' · planned' : ''}
            </span>
            {/* Member row = allocation unit: status dot + name + load badge (done/assigned) + cumulative time + progress bar.
                Click highlights that member's tasks below. */}
            {members.map((m) => {
              const load = memberLoad.get(m.id);
              const active = highlightMember === m.id;
              const runningTask = m.currentTaskId ? tasks.find((t) => t.id === m.currentTaskId) : undefined;
              const pct = load && load.assigned > 0 ? Math.round((load.done / load.assigned) * 100) : 0;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHighlightMember(active ? null : m.id);
                  }}
                  className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded px-0.5 py-0.5 text-left transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_60%,transparent)]"
                  style={active ? { backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)' } : undefined}
                  title={`${m.name} · ${m.role || 'Member'} · ${m.status}${load ? ` · ${load.done}/${load.assigned} tasks done` : ''}`}
                >
                  <span className="flex w-full min-w-0 items-center gap-1">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: MEMBER_COLOR[m.status] ?? 'var(--ink-muted)' }} />
                    <span className="min-w-0 truncate text-10" style={{ color: 'var(--ink)' }}>
                      {m.name}
                    </span>
                    {load && load.assigned > 0 && (
                      <span
                        className="ml-auto shrink-0 rounded px-1 text-9"
                        style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 8%, transparent)', color: 'color-mix(in oklab, var(--ink-muted) 82%, transparent)' }}
                      >
                        {load.done}/{load.assigned}
                      </span>
                    )}
                  </span>
                  <span className="flex w-full min-w-0 items-center gap-1 pl-2.5">
                    <span className="min-w-0 flex-1 truncate text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 65%, transparent)' }}>
                      {runningTask?.subject ?? m.role}
                    </span>
                    {load && load.durationMs > 0 && (
                      <span className="shrink-0 text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 62%, transparent)' }} title="Cumulative execution time of this member's tasks">
                        {fmtDuration(load.durationMs)}
                      </span>
                    )}
                  </span>
                  {load && load.assigned > 0 && (
                    <span className="ml-2.5 block h-[2px] w-[calc(100%-0.625rem)] overflow-hidden rounded-full" style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 10%, transparent)' }}>
                      <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: 'var(--success)' }} />
                    </span>
                  )}
                </button>
              );
            })}
            {members.length === 0 && plannedMembers.length > 0 &&
              plannedMembers.map((m, i) => (
                <div
                  key={`${m.name}-${i}`}
                  className="flex w-full min-w-0 items-center gap-1 rounded px-0.5 py-0.5"
                  title={`${m.name}${m.role ? ` · ${m.role}` : ''}${m.identity ? ` · agent: ${m.identity}` : ''}`}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: 'color-mix(in oklab, var(--ink-muted) 45%, transparent)' }}
                  />
                  <span className="min-w-0 truncate text-10" style={{ color: 'color-mix(in oklab, var(--ink) 78%, transparent)' }}>
                    {m.name}
                  </span>
                  {m.role && (
                    <span className="ml-auto min-w-0 shrink-0 truncate text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 65%, transparent)' }}>
                      {m.role}
                    </span>
                  )}
                </div>
              ))}
            {members.length === 0 && plannedMembers.length === 0 && (
              <span className="text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
                {detail ? 'No members' : 'Loading…'}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-9 font-semibold uppercase tracking-wide" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
              Tasks {tasks.length > 0 ? `(${doneCount}/${tasks.length})` : plannedTasks.length > 0 ? `(${plannedTasks.length}) · planned` : ''}
            </span>
            {tasks.map((t) => {
              const dur = taskDuration(t, now);
              const unassigned = isUnassigned(t);
              const isBlocked = (t.blockedBy?.length ?? 0) > 0;
              const running = t.status === 'running' || t.status === 'claimed';
              const stallMs = stallHints[t.id];
              const takeoverIn = stallMs !== undefined ? Math.max(0, staleMs - stallMs) : undefined;
              const highlighted = highlightTask === t.id || (highlightMember !== null && t.assignee === highlightMember);
              return (
                <div
                  key={t.id}
                  data-task-id={t.id}
                  className="flex min-w-0 flex-col gap-0.5 rounded px-0.5"
                  style={highlighted ? { backgroundColor: 'color-mix(in oklab, var(--primary) 9%, transparent)' } : undefined}
                >
                  <div className="flex min-w-0 items-start gap-1">
                    <span className="mt-0.5 shrink-0">
                      <TaskIcon status={t.status} />
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (t.status === 'done') setReading(t.id);
                      }}
                      className={`min-w-0 flex-1 break-words text-left text-10 leading-snug ${t.status === 'done' ? 'cursor-pointer hover:underline' : 'cursor-default'}`}
                      style={{ color: t.status === 'failed' ? 'var(--danger)' : 'color-mix(in oklab, var(--ink) 85%, transparent)' }}
                      title={`${t.subject}\n${TASK_LABEL[t.status] ?? t.status}${t.assignee ? ` · ${memberName(t.assignee)}` : ''}${isBlocked ? `\nBlocked by failed upstream ${t.blockedBy!.map((d) => `#${d}`).join(', ')}` : ''}`}
                    >
                      {t.subject}
                    </button>
                    {/* Retry only for self-inflicted failures: a task failed *through* an upstream must not offer
                        retry (the engine rejects it — dependencies are still failed). Retry the upstream instead. */}
                    {t.status === 'failed' && !isBlocked && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void retryTask(t.id);
                        }}
                        disabled={retrying !== null}
                        className="shrink-0 cursor-pointer rounded p-0.5 transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_70%,transparent)] disabled:opacity-40"
                        style={{ color: 'var(--ink-muted)' }}
                        title="Retry this task"
                      >
                        {retrying === t.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RotateCcw className="h-2.5 w-2.5" />}
                      </button>
                    )}
                  </div>
                  <span className="flex flex-wrap items-center gap-1 pl-3.5 text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 62%, transparent)' }}>
                    <span>{TASK_LABEL[t.status] ?? t.status}</span>
                    {t.assignee && !unassigned ? <span>· {memberName(t.assignee)}</span> : null}
                    {unassigned && (
                      <span className="rounded px-1" style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 8%, transparent)' }}>
                        unassigned
                      </span>
                    )}
                    {dur !== undefined && (
                      <span title="Execution time">{fmtDuration(dur)}</span>
                    )}
                    {isBlocked && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          locateTask(t.blockedBy![0]);
                        }}
                        className="shrink-0 cursor-pointer rounded px-1 font-medium"
                        style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}
                        title={`Blocked by failed upstream ${t.blockedBy!.map((d) => `#${d}`).join(', ')} — retry that upstream to revive this task`}
                      >
                        blocked by {t.blockedBy!.map((d) => `#${d}`).join(', ')}
                      </button>
                    )}
                  </span>
                  {t.dependencies.length > 0 && (
                    <span
                      className="truncate pl-3.5 text-9"
                      style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}
                      title={`Depends on: ${t.dependencies.map((d) => tasks.find((x) => x.id === d)?.subject ?? d).join(', ')}`}
                    >
                      ↳ after {t.dependencies.map((d) => tasks.find((x) => x.id === d)?.subject ?? d).join(', ')}
                    </span>
                  )}
                  {t.progressText && t.status !== 'done' && (
                    <span className="break-words pl-3.5 text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 62%, transparent)' }}>
                      {t.progressText}
                    </span>
                  )}
                  {stallMs !== undefined && (
                    <span className="flex flex-wrap items-center gap-1 break-words pl-3.5 text-9" style={{ color: 'var(--warn)' }}>
                      <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                      <span title="This member has reported no progress for a while — the engine takes the attempt over automatically at the threshold">
                        {takeoverIn !== undefined && takeoverIn > 0
                          ? `No progress for ${fmtDuration(stallMs)} · takeover in ${fmtDuration(takeoverIn)}`
                          : `No progress for ${fmtDuration(stallMs)} · takeover due`}
                      </span>
                      {running && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void retryTask(t.id);
                          }}
                          disabled={retrying !== null}
                          className="shrink-0 cursor-pointer rounded px-1 font-medium underline decoration-dotted underline-offset-2 disabled:opacity-40"
                          style={{ color: 'var(--primary-strong)' }}
                          title="Take over now: revoke this in-flight attempt and requeue the task"
                        >
                          {retrying === t.id ? 'taking over…' : 'Take over'}
                        </button>
                      )}
                    </span>
                  )}
                  {t.error && (
                    <span className="break-words pl-3.5 text-9" style={{ color: 'var(--danger)' }}>
                      {t.error}
                    </span>
                  )}
                </div>
              );
            })}
            {tasks.length === 0 && plannedTasks.length > 0 &&
              plannedTasks.map((t, i) => (
                <div
                  key={`${t.subject}-${i}`}
                  className="flex min-w-0 flex-col gap-0.5 rounded px-0.5"
                >
                  <div className="flex min-w-0 items-start gap-1">
                    <span className="mt-0.5 shrink-0">
                      <CircleDashed className="h-2.5 w-2.5" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }} />
                    </span>
                    <span
                      className="min-w-0 flex-1 break-words text-10 leading-snug"
                      style={{ color: 'color-mix(in oklab, var(--ink) 78%, transparent)' }}
                      title={`${t.subject}\nPlanned — created once the plan is approved`}
                    >
                      {t.subject}
                    </span>
                  </div>
                  {(t.assignee || t.dependencies.length > 0) && (
                    <span className="flex flex-wrap items-center gap-1 pl-3.5 text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 62%, transparent)' }}>
                      <span>Planned</span>
                      {t.assignee ? <span>· {t.assignee}</span> : null}
                      {t.dependencies.length > 0 ? <span>· after {t.dependencies.join(', ')}</span> : null}
                    </span>
                  )}
                </div>
              ))}
            {tasks.length === 0 && plannedTasks.length === 0 && (
              <span className="text-9" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
                {detail ? 'No tasks' : 'Loading…'}
              </span>
            )}
          </div>
            </>
          )}
        </aside>
      </div>

      {/* Interjection input: broadcast / @direct to a member (idle members are woken by the engine immediately, not at the next task).
          Local attachments (picker / drag / paste) and @-references behave exactly like the chat input. */}
      <div
        className="flex w-full min-w-0 shrink-0 flex-col gap-1 pt-0.5"
        onDragOver={composer.handleDragOver}
        onDragLeave={composer.handleDragLeave}
        onDrop={composer.handleDrop}
        onClick={(e) => e.stopPropagation()}
      >
        <ComposerChips
          compact
          className="mb-0.5"
          attachments={composer.pendingAttachments}
          links={composer.pendingLinks}
          onRemoveAttachment={composer.removePendingAttachment}
          onRemoveLink={composer.removePendingLink}
        />
        <div className="flex w-full min-w-0 items-center gap-1.5">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-6 shrink-0 cursor-pointer rounded-md border bg-transparent px-1 text-10 outline-none"
            style={{ borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)', color: 'var(--ink)' }}
            title="Choose recipient"
          >
            <option value="all">All members</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="relative min-w-0 flex-1">
            <MentionMenu
              compact
              open={composer.mentionOpen}
              menuRef={composer.mentionRef}
              dir={composer.mentionDir}
              dirItems={composer.mentionDirItems}
              dirLoading={composer.mentionDirLoading}
              query={composer.mentionQuery}
              index={composer.mentionIndex}
              authorizedRoots={composer.authorizedRoots}
              onSelect={composer.handleMentionSelect}
              onBack={composer.goBackDir}
            />
            <div
              ref={interjectRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              onInput={composer.handleInput}
              onKeyDown={(e) => {
                if (composer.handleMentionKeyDown(e)) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              onCompositionStart={() => {
                interjectComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                interjectComposingRef.current = false;
              }}
              onPaste={composer.handlePaste}
              className="node-input ai-canvas-scroll w-full min-w-0 overflow-y-auto rounded-md border bg-transparent px-1.5 py-0.5 text-10 outline-none"
              style={{
                minHeight: '24px',
                maxHeight: '120px',
                borderColor: composer.dragOver
                  ? 'color-mix(in oklab, var(--primary) 50%, transparent)'
                  : 'color-mix(in oklab, var(--line) 45%, transparent)',
                color: 'var(--ink)',
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              }}
            />
          </div>
          <label
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
            style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}
            title="Attach files"
          >
            <input
              ref={interjectFileRef}
              type="file"
              multiple
              className="absolute opacity-0 pointer-events-none"
              style={{ width: 0, height: 0 }}
              onChange={(e) => {
                void composer.handleFileSelect(e.target.files);
                e.target.value = '';
              }}
              disabled={sending || composer.uploadingAttachment}
            />
            {composer.uploadingAttachment ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Paperclip className="h-2.5 w-2.5" />
            )}
          </label>
          <button
            type="button"
            onClick={() => void sendMessage()}
            disabled={!draft.trim() || sending}
            className="flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-2 text-10 font-medium transition-opacity disabled:cursor-default disabled:opacity-40"
            style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)', color: 'var(--primary-strong)' }}
          >
            {sending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Send className="h-2.5 w-2.5" />}
            Send
          </button>
        </div>
      </div>

      {/* Timeline drawer (overlays the whole workbench; closed by default) */}
      {timelineOpen && (
        <TeamTimeline
          tasks={tasks}
          members={members}
          onClose={() => setTimelineOpen(false)}
          onSelectTask={(taskId) => {
            setTimelineOpen(false);
            if (tasks.find((t) => t.id === taskId)?.status === 'done') setReading(taskId);
            else locateTask(taskId);
          }}
        />
      )}
    </div>
  );
}

/**
 * Planning status: this node's launched turn is in flight and no team exists yet (teamIds empty).
 *
 * Why it is needed: the captain session plans the member roster + task DAG in a single LLM call *before*
 * team_create, so in that window there is no team id — this panel has no engine data to render and would
 * otherwise look frozen (only the Launch button spins). The row names the stage and counts the elapsed
 * time; it goes away by itself the moment the team id arrives and the run view takes over.
 */
function PlanningStatus() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      className="flex w-full max-w-[560px] items-center gap-1.5 rounded-md border px-2 py-1.5"
      style={{
        borderColor: 'color-mix(in oklab, var(--primary) 25%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--primary) 5%, transparent)',
      }}
    >
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" style={{ color: 'var(--primary)' }} />
      <span className="shrink-0 text-10 font-medium" style={{ color: 'color-mix(in oklab, var(--ink) 85%, transparent)' }}>
        Captain is planning
      </span>
      <span className="min-w-0 truncate text-10" style={{ color: 'color-mix(in oklab, var(--ink-muted) 85%, transparent)' }}>
        · members and task DAG
      </span>
      <span className="ml-auto shrink-0 text-9 tabular-nums" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
        {seconds}s
      </span>
    </div>
  );
}

/**
 * Launch area: requirement input + member picker + launch (shared by the empty state and "New run").
 *
 * It only collects and echoes input; it does not build its own pipeline: the launch button hands the text
 * to the host node (onLaunch), which sends it as a /api/chat turn (forcing multiAgentMode); the team then
 * lands in this view.
 */
function LaunchPanel({
  presetAgentIds,
  launching,
  nodeId,
  nodeTitle,
  onOpenMemberPicker,
  onLaunch,
  mainModel,
  workerModel,
  modelOptions,
  onSelectMainModel,
  onSelectWorkerModel,
}: {
  presetAgentIds: string[];
  launching: boolean;
  /** Host node id — attachment upload target (files land in materials/<id_title>/); null disables uploads */
  nodeId: string | null;
  /** Host node title (part of the materials folder name) */
  nodeTitle?: string;
  onOpenMemberPicker: () => void;
  onLaunch: (text: string, ctx?: ComposerContext) => void;
  /** Captain model / member model (see TeamWorkbench props) */
  mainModel: string;
  workerModel: string;
  modelOptions: Array<{ modelId: string; label: string }>;
  onSelectMainModel: (modelId: string) => void;
  onSelectWorkerModel: (modelId: string) => void;
}) {
  const [text, setText] = useState('');
  // Requirement input: local attachments (picker / drag / paste) and @-references behave like the chat input
  const inputRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const composer = useComposer({
    nodeId,
    nodeTitle,
    disabled: launching,
    inputRef,
    text,
    setText,
    composingRef,
  });
  const canLaunch = text.trim().length > 0 && !launching;

  const submit = () => {
    if (!canLaunch) return;
    const t = text.trim();
    // The host node folds this snapshot into the launched turn itself, so the text stays plain here
    const ctx = composer.composerContext;
    setText('');
    composer.reset();
    onLaunch(t, ctx);
  };

  return (
    <div
      className="flex w-full min-w-0 flex-col gap-1.5 rounded-lg border px-2 py-1.5"
      style={{
        borderColor: composer.dragOver
          ? 'color-mix(in oklab, var(--primary) 50%, transparent)'
          : 'color-mix(in oklab, var(--line) 40%, transparent)',
        backgroundColor: composer.dragOver
          ? 'color-mix(in oklab, var(--primary) 6%, transparent)'
          : 'color-mix(in oklab, var(--paper) 70%, transparent)',
      }}
      onDragOver={composer.handleDragOver}
      onDragLeave={composer.handleDragLeave}
      onDrop={composer.handleDrop}
      onClick={(e) => e.stopPropagation()}
    >
      <ComposerChips
        compact
        attachments={composer.pendingAttachments}
        links={composer.pendingLinks}
        onRemoveAttachment={composer.removePendingAttachment}
        onRemoveLink={composer.removePendingLink}
      />
      <div className="relative w-full min-w-0">
        <MentionMenu
          compact
          open={composer.mentionOpen}
          menuRef={composer.mentionRef}
          dir={composer.mentionDir}
          dirItems={composer.mentionDirItems}
          dirLoading={composer.mentionDirLoading}
          query={composer.mentionQuery}
          index={composer.mentionIndex}
          authorizedRoots={composer.authorizedRoots}
          onSelect={composer.handleMentionSelect}
          onBack={composer.goBackDir}
        />
        <div
          ref={inputRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          onInput={composer.handleInput}
          onKeyDown={(e) => {
            if (composer.handleMentionKeyDown(e)) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onPaste={composer.handlePaste}
          className="node-input ai-canvas-scroll w-full min-w-0 overflow-y-auto rounded-md border bg-transparent px-1.5 py-1 text-10 leading-relaxed outline-none"
          style={{
            minHeight: '44px',
            maxHeight: '160px',
            borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)',
            color: 'var(--ink)',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}
        />
      </div>
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <label
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
          style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}
          title="Attach files"
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            className="absolute opacity-0 pointer-events-none"
            style={{ width: 0, height: 0 }}
            onChange={(e) => {
              void composer.handleFileSelect(e.target.files);
              e.target.value = '';
            }}
            disabled={launching || composer.uploadingAttachment}
          />
          {composer.uploadingAttachment ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Paperclip className="h-2.5 w-2.5" />
          )}
        </label>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenMemberPicker();
          }}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors"
          style={{ borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)', color: 'var(--primary-strong)' }}
          title="Pick the installed Agent packages to take part in this run; if you pick none, the main agent plans the members and asks for your approval"
        >
          <Users className="h-2.5 w-2.5 shrink-0" />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            submit();
          }}
          disabled={!canLaunch}
          className="flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-2 text-10 font-medium transition-opacity disabled:cursor-default disabled:opacity-40"
          style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)', color: 'var(--primary-strong)' }}
        >
          {launching ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Send className="h-2.5 w-2.5" />}
          Launch
        </button>
      </div>
      {/* Two-tier models (below the input): the captain — planning + review/merge — runs on Main; every
          member runs on Worker. Picked from the model pool, persisted on the node frontmatter; the node's
          own chat model is never touched. */}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <label className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-10" style={{ color: 'color-mix(in oklab, var(--ink-muted) 88%, transparent)' }}>
            Main model
          </span>
          <select
            value={mainModel}
            onChange={(e) => onSelectMainModel(e.target.value)}
            disabled={launching || modelOptions.length === 0}
            className="h-6 min-w-0 max-w-[200px] cursor-pointer rounded-md border bg-transparent px-1 text-10 outline-none disabled:cursor-default"
            style={{ borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)', color: 'var(--ink)' }}
            title="Captain model: plans the members and tasks, then reviews and merges the member outputs"
          >
            {modelOptions.length === 0 ? <option value="">No model available</option> : null}
            {modelOptions.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-10" style={{ color: 'color-mix(in oklab, var(--ink-muted) 88%, transparent)' }}>
            Worker model
          </span>
          <select
            value={workerModel}
            onChange={(e) => onSelectWorkerModel(e.target.value)}
            disabled={launching || modelOptions.length === 0}
            className="h-6 min-w-0 max-w-[200px] cursor-pointer rounded-md border bg-transparent px-1 text-10 outline-none disabled:cursor-default"
            style={{ borderColor: 'color-mix(in oklab, var(--line) 45%, transparent)', color: 'var(--ink)' }}
            title="Member model: applied to every member of the team"
          >
            {modelOptions.length === 0 ? <option value="">No model available</option> : null}
            {modelOptions.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
