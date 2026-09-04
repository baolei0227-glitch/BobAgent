/**
 * AgentTeamsPanel — Agent Teams 团队管理与协作面板
 *
 * 两种形态（与 Bob Sandbox 全屏市场同构）：
 *   · 侧边栏（默认）：入口按钮，点击派发 team-panel-open 事件 → CanvasFlow 打开全屏页。
 *     轻量轮询（15s）团队未读数，显示红点角标。
 *   · 全屏（fullscreen）：独立页面覆盖层，顶栏 + 两栏内容；既是监控台也是管理台——
 *     创建团队 / 添加·移除成员（role/modelRef/effort）/ 添加任务（assignee/dependencies）/
 *     发送消息 / Approve & Run·Discard·Archive 门禁，2s 轮询详情，Esc 或关闭按钮退出。
 * 数据源：/api/team（GET 状态 + 团队列表；POST 转调 team_* 工具）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { Plus, RefreshCw, Users, X } from 'lucide-react';

interface TeamTask {
  id: string;
  subject: string;
  assignee?: string;
  dependencies: string[];
  status: string;
  progress?: number;
  progressText?: string;
  error?: string;
  qualityStage?: string;
}
interface TeamMember {
  id: string;
  name: string;
  role: string;
  status: string;
  modelRef?: string;
  currentTaskId?: string;
}
interface TeamMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  delivered: boolean;
}
interface TeamStatus {
  teamId: string;
  name: string;
  goal: string;
  status: string;
  members: TeamMember[];
  tasks: TeamTask[];
  messages: TeamMessage[];
  unreadForCaptain: number;
  terminal: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'var(--green, #16a34a)',
  busy: 'var(--amber, #d97706)',
  parked: 'var(--ink-muted, #8a8a92)',
  offline: 'var(--red, #dc2626)',
};

const TASK_BORDER: Record<string, string> = {
  ready: 'var(--info, #3b82f6)',
  claimed: 'var(--amber, #d97706)',
  running: 'var(--amber, #d97706)',
  done: 'var(--green, #16a34a)',
  failed: 'var(--red, #dc2626)',
};

async function post(action: string, extra: Record<string, unknown> = {}) {
  const r = await fetch('/api/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  return r.json();
}

interface AgentTeamsPanelProps {
  /** 全屏独立页面模式（顶栏 + 两栏内容） */
  fullscreen?: boolean;
  /** 全屏模式关闭回调 */
  onClose?: () => void;
}

export function AgentTeamsPanel({ fullscreen = false, onClose }: AgentTeamsPanelProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [teams, setTeams] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const selectedRef = useRef('');
  // ---- 管理表单 state（全屏模式）----
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamGoal, setNewTeamGoal] = useState('');
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberName, setMemberName] = useState('');
  const [memberRole, setMemberRole] = useState('');
  const [memberModel, setMemberModel] = useState('');
  const [memberEffort, setMemberEffort] = useState('medium');
  const [showAddTask, setShowAddTask] = useState(false);
  const [taskSubject, setTaskSubject] = useState('');
  const [taskAssignee, setTaskAssignee] = useState('');
  const [taskDeps, setTaskDeps] = useState('');
  const [msgTo, setMsgTo] = useState('all');
  const [msgText, setMsgText] = useState('');
  const [busy, setBusy] = useState(false);

  const loadTeams = useCallback(async () => {
    try {
      const r = await fetch('/api/team');
      const j = await r.json();
      setEnabled(!!j.enabled);
      if (j.teams) setTeams(j.teams);
      if (j.teams && j.teams.length > 0 && !j.teams.includes(selectedRef.current)) {
        selectedRef.current = j.teams[0];
        setSelected(j.teams[0]);
      }
    } catch {
      setEnabled(false);
    }
  }, []);

  const loadStatus = useCallback(async (teamId: string) => {
    if (!teamId) return;
    try {
      const j = await post('status', { team_id: teamId });
      if (j.ok) {
        // 防止旧团队（已归档）的迟到响应覆盖新选中团队的状态
        if (selectedRef.current === teamId) {
          setStatus(j as TeamStatus);
          setError('');
        }
      } else {
        const msg = String(j.error || 'status failed');
        if (msg.includes('Team not found')) {
          // 团队已归档/删除：清空旧快照，避免残留任务等内容
          setStatus(null);
          setError('');
        } else {
          setError(msg);
        }
      }
    } catch {
      /* 轮询静默 */
    }
  }, []);

  const doAction = useCallback(
    async (action: string, confirmText?: string) => {
      if (confirmText && !window.confirm(confirmText)) return;
      setRefreshing(true);
      try {
        const j = await post(action, { team_id: selectedRef.current });
        if (!j.ok) setError(j.error || `${action} failed`);
        await loadStatus(selectedRef.current);
      } finally {
        setRefreshing(false);
      }
    },
    [loadStatus],
  );

  // 团队列表轮询（15s，两种形态共用）
  useEffect(() => {
    loadTeams();
    const t = setInterval(loadTeams, 15_000);
    return () => clearInterval(t);
  }, [loadTeams]);

  // 选中团队详情轮询：全屏 2s（实时进度），侧边栏入口 15s（仅未读红点）
  useEffect(() => {
    selectedRef.current = selected;
    if (!selected) return;
    loadStatus(selected);
    const t = setInterval(() => loadStatus(selectedRef.current), fullscreen ? 2000 : 15_000);
    return () => clearInterval(t);
  }, [selected, loadStatus, fullscreen]);

  // 全屏：Esc 关闭
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, onClose]);

  const unread = status?.unreadForCaptain ?? 0;
  // 后端 panelStatus 不保证返回 members/tasks/messages（如旧团队数据缺失），一律兜底空数组
  const members = status?.members ?? [];
  const tasks = status?.tasks ?? [];
  const messages = status?.messages ?? [];
  const refresh = () => {
    loadTeams();
    if (selectedRef.current) loadStatus(selectedRef.current);
  };

  // ---- 管理动作：创建团队 / 添加·移除成员 / 添加任务 / 发消息 ----
  const runManage = async (action: string, args: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      // create 不需要 team_id（新团队尚不存在）
      const j = await post(action, { ...(action === 'create' ? {} : { team_id: selectedRef.current }), ...args });
      if (!j.ok) setError(j.error || `${action} failed`);
      else {
        setError('');
        // 创建成功后自动切换选中新团队
        if (action === 'create' && typeof j.team_id === 'string') {
          selectedRef.current = j.team_id;
          setSelected(j.team_id);
        }
        await loadTeams();
        if (selectedRef.current) await loadStatus(selectedRef.current);
      }
    } finally {
      setBusy(false);
    }
  };

  const submitCreateTeam = () => {
    if (!newTeamName.trim() || !newTeamGoal.trim()) return;
    void runManage('create', { name: newTeamName.trim(), goal: newTeamGoal.trim() }).then(() => {
      setShowNewTeam(false);
      setNewTeamName('');
      setNewTeamGoal('');
    });
  };

  const submitAddMember = () => {
    if (!memberName.trim()) return;
    void runManage('add_member', {
      name: memberName.trim(),
      ...(memberRole.trim() ? { role: memberRole.trim() } : {}),
      ...(memberModel.trim() ? { model_ref: memberModel.trim() } : {}),
      effort: memberEffort,
    }).then(() => {
      setShowAddMember(false);
      setMemberName('');
      setMemberRole('');
      setMemberModel('');
      setMemberEffort('medium');
    });
  };

  const submitAddTask = () => {
    if (!taskSubject.trim()) return;
    void runManage('add_task', {
      subject: taskSubject.trim(),
      ...(taskAssignee ? { assignee: taskAssignee } : {}),
      ...(taskDeps.trim()
        ? { dependencies: taskDeps.split(',').map((d) => d.trim()).filter(Boolean) }
        : {}),
    }).then(() => {
      setShowAddTask(false);
      setTaskSubject('');
      setTaskAssignee('');
      setTaskDeps('');
    });
  };

  const submitSendMsg = () => {
    if (!msgText.trim()) return;
    void runManage('send', { to: msgTo, text: msgText.trim() }).then(() => setMsgText(''));
  };

  // ---- 侧边栏入口按钮（点击打开全屏页）----
  if (!fullscreen) {
    return (
      <div className="px-2 py-1" style={{ borderTop: '1px solid var(--line-soft)', marginTop: 10, paddingTop: 10 }}>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('team-panel-open'))}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--paper-hover)]"
          title="Open Agent Teams"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'var(--primary-soft)' }}>
            <Users className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold leading-tight" style={{ color: 'var(--ink)' }}>
              Agent Teams
            </span>
            <span className="block text-10 leading-tight" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
              Multi-Agent Collaboration
            </span>
          </span>
          {enabled === false ? (
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-10" style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-faint)' }}>
              Off
            </span>
          ) : unread > 0 ? (
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-semibold" style={{ backgroundColor: 'var(--red, #dc2626)', color: '#fff' }}>
              {unread}
            </span>
          ) : (
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-semibold" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>
              {teams.length}
            </span>
          )}
        </button>
      </div>
    );
  }

  // ---- 全屏独立页面（与 Bob Sandbox 全屏市场同构）----
  return (
    <div className="fixed inset-0 z-[120] flex flex-col" style={{ backgroundColor: 'var(--paper)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {/* 顶栏 */}
      <div
        className="flex shrink-0 items-center gap-3 px-6 py-3"
        style={{ borderBottom: '1px solid var(--line)', backgroundColor: 'var(--paper-soft)' }}
      >
        <Users className="h-5 w-5 shrink-0" style={{ color: 'var(--primary)' }} />
        <span className="text-base font-bold tracking-tight" style={{ color: 'var(--ink)' }}>
          Agent Teams
        </span>
        <span className="rounded-full px-2 py-0.5 text-11 font-semibold" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>
          Multi-Agent Collaboration
        </span>
        {enabled === false && (
          <span className="rounded-full px-2 py-0.5 text-11 font-semibold" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
            MCP disabled
          </span>
        )}
        {status && (
          <span className="hidden truncate text-xs sm:inline" style={{ color: 'var(--ink-muted)' }}>
            {status.name}
            <span className="ml-1.5 uppercase font-semibold" style={{ color: 'var(--ink)' }}>
              {status.status}
            </span>
            {status.goal ? ` · ${status.goal}` : ''}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowNewTeam((v) => !v)}
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: 'var(--primary)' }}
            title="Create a new agent team"
          >
            <Plus className="h-3.5 w-3.5" /> New Team
          </button>
          {teams.length > 0 && (
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded-md border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--line, #e6e4de)', background: '#fff' }}
            >
              {teams.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={refresh}
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink-muted)' }}
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--danger-soft)]"
            style={{ color: 'var(--ink-muted)' }}
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 主体：两栏（左 roster + 控制；右 任务 + 邮箱） */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* New Team 表单（顶栏按钮展开） */}
        {showNewTeam && (
          <div className="mb-4 rounded-lg border p-4" style={{ borderColor: 'var(--line)', background: 'var(--paper-soft)' }}>
            <div className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              New Team
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder="Team name"
                className="min-w-[180px] flex-1 rounded-md border px-2 py-1.5 text-xs"
                style={{ borderColor: 'var(--line)', background: '#fff' }}
              />
              <input
                value={newTeamGoal}
                onChange={(e) => setNewTeamGoal(e.target.value)}
                placeholder="Goal — what should the team accomplish?"
                className="min-w-[260px] flex-[2] rounded-md border px-2 py-1.5 text-xs"
                style={{ borderColor: 'var(--line)', background: '#fff' }}
                onKeyDown={(e) => { if (e.key === 'Enter') submitCreateTeam(); }}
              />
              <button
                type="button"
                onClick={submitCreateTeam}
                disabled={busy || !newTeamName.trim() || !newTeamGoal.trim()}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-white transition-opacity disabled:opacity-40"
                style={{ background: 'var(--primary)' }}
              >
                {busy ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => setShowNewTeam(false)}
                className="rounded-md border px-3 py-1.5 text-xs"
                style={{ borderColor: 'var(--line)' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {enabled && teams.length === 0 && (
          <div className="rounded-md p-3" style={{ background: 'var(--paper-soft)', color: 'var(--ink-muted)' }}>
            No teams yet — call <code>team_create</code> from a chat node.
          </div>
        )}
        {error && (
          <div className="rounded-md p-2" style={{ background: '#fee2e2', color: 'var(--red, #dc2626)' }}>
            {error}
          </div>
        )}
        {status && (
          <div className="grid gap-5 lg:grid-cols-2">
            {/* 左列：团队信息 + 成员名册 + 门禁控制 */}
            <div className="space-y-4">
              {/* Roster */}
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    Roster ({members.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowAddMember((v) => !v)}
                    className="ml-auto flex items-center gap-0.5 rounded px-1.5 py-0.5 text-11 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--primary)' }}
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>
                {showAddMember && (
                  <div className="mb-2 space-y-1.5 rounded-md border p-2.5" style={{ borderColor: 'var(--line)', background: 'var(--paper-soft)' }}>
                    <input
                      value={memberName}
                      onChange={(e) => setMemberName(e.target.value)}
                      placeholder="Member name"
                      className="w-full rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: 'var(--line)', background: '#fff' }}
                    />
                    <input
                      value={memberRole}
                      onChange={(e) => setMemberRole(e.target.value)}
                      placeholder="Role — e.g. legal researcher, translator…"
                      className="w-full rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: 'var(--line)', background: '#fff' }}
                    />
                    <input
                      value={memberModel}
                      onChange={(e) => setMemberModel(e.target.value)}
                      placeholder="Model — provider:modelId (optional, default BobWork chat model)"
                      className="w-full rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: 'var(--line)', background: '#fff' }}
                    />
                    <div className="flex items-center gap-2">
                      <select
                        value={memberEffort}
                        onChange={(e) => setMemberEffort(e.target.value)}
                        className="rounded-md border px-2 py-1 text-xs"
                        style={{ borderColor: 'var(--line)', background: '#fff' }}
                      >
                        <option value="low">effort: low</option>
                        <option value="medium">effort: medium</option>
                        <option value="high">effort: high</option>
                      </select>
                      <button
                        type="button"
                        onClick={submitAddMember}
                        disabled={busy || !memberName.trim()}
                        className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium text-white transition-opacity disabled:opacity-40"
                        style={{ background: 'var(--primary)' }}
                      >
                        {busy ? 'Adding…' : 'Add member'}
                      </button>
                    </div>
                  </div>
                )}
                {members.length === 0 && <div style={{ color: 'var(--ink-muted)' }}>No members</div>}
                <div className="space-y-1">
                  {members.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1.5" style={{ background: 'var(--paper-soft)' }}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[m.status] ?? 'var(--ink-muted)' }} />
                      <span className="truncate text-sm font-medium">{m.name}</span>
                      <span className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {m.role}
                        {m.currentTaskId ? ` · ${m.currentTaskId}` : ''}
                      </span>
                      <span className="ml-auto shrink-0 text-10 uppercase" style={{ color: 'var(--ink-faint)' }}>
                        {m.status}
                      </span>
                      {m.status !== 'busy' && (
                        <button
                          type="button"
                          onClick={() => void runManage('remove_member', { member_id: m.id })}
                          disabled={busy}
                          className="shrink-0 rounded px-1 text-11 transition-colors hover:bg-[var(--danger-soft)] disabled:opacity-40"
                          style={{ color: 'var(--red, #dc2626)' }}
                          title={`Remove ${m.name}`}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* Actions（门禁控制） */}
              {status.status !== 'archived' && (
                <section className="flex flex-wrap gap-2">
                  {status.status === 'planning' && (
                    <>
                      <button
                        type="button"
                        onClick={() => doAction('approve', 'Approve & Run this team?')}
                        className="rounded-md px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
                        style={{ background: 'var(--info, #3b82f6)' }}
                      >
                        Approve & Run
                      </button>
                      <button
                        type="button"
                        onClick={() => doAction('discard', 'Discard the staged plan?')}
                        className="rounded-md border px-3 py-1 text-xs"
                        style={{ borderColor: 'var(--line, #e6e4de)' }}
                      >
                        Discard
                      </button>
                    </>
                  )}
                  {status.status !== 'planning' && (
                    <button
                      type="button"
                      onClick={() => doAction('archive', 'Archive this team?')}
                      className="rounded-md border px-3 py-1 text-xs"
                      style={{ borderColor: 'var(--red, #dc2626)', color: 'var(--red, #dc2626)' }}
                    >
                      Archive
                    </button>
                  )}
                </section>
              )}
            </div>

            {/* 右列：任务 DAG + 邮箱 */}
            <div className="space-y-4">
              {/* Tasks */}
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    Tasks ({tasks.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowAddTask((v) => !v)}
                    className="ml-auto flex items-center gap-0.5 rounded px-1.5 py-0.5 text-11 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--primary)' }}
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>
                {showAddTask && (
                  <div className="mb-2 space-y-1.5 rounded-md border p-2.5" style={{ borderColor: 'var(--line)', background: 'var(--paper-soft)' }}>
                    <input
                      value={taskSubject}
                      onChange={(e) => setTaskSubject(e.target.value)}
                      placeholder="Task subject"
                      className="w-full rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: 'var(--line)', background: '#fff' }}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitAddTask(); }}
                    />
                    <div className="flex items-center gap-2">
                      <select
                        value={taskAssignee}
                        onChange={(e) => setTaskAssignee(e.target.value)}
                        className="flex-1 rounded-md border px-2 py-1 text-xs"
                        style={{ borderColor: 'var(--line)', background: '#fff' }}
                      >
                        <option value="">Assignee (auto)</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                      <input
                        value={taskDeps}
                        onChange={(e) => setTaskDeps(e.target.value)}
                        placeholder="Dependencies (task ids, comma)"
                        className="flex-[1.5] rounded-md border px-2 py-1 text-xs"
                        style={{ borderColor: 'var(--line)', background: '#fff' }}
                      />
                      <button
                        type="button"
                        onClick={submitAddTask}
                        disabled={busy || !taskSubject.trim()}
                        className="rounded-md px-2.5 py-1 text-xs font-medium text-white transition-opacity disabled:opacity-40"
                        style={{ background: 'var(--primary)' }}
                      >
                        {busy ? 'Adding…' : 'Add task'}
                      </button>
                    </div>
                  </div>
                )}
                {tasks.length === 0 && <div style={{ color: 'var(--ink-muted)' }}>No tasks</div>}
                <div className="space-y-1.5">
                  {tasks.map((t) => (
                    <div
                      key={t.id}
                      className="rounded-md border px-2.5 py-1.5"
                      style={{ borderLeft: `3px solid ${TASK_BORDER[t.status] ?? 'var(--line, #e6e4de)'}`, borderColor: 'var(--line, #e6e4de)' }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t.id}</span>
                        <span className="truncate text-sm">{t.subject}</span>
                        <span className="ml-auto shrink-0 text-10 uppercase" style={{ color: 'var(--ink-muted)' }}>
                          {t.status}
                        </span>
                      </div>
                      {(t.progressText || t.qualityStage) && (
                        <div className="truncate text-xs" style={{ color: 'var(--info, #3b82f6)' }}>
                          {t.qualityStage ? `quality: ${t.qualityStage}` : ''}
                          {t.qualityStage && t.progressText ? ' · ' : ''}
                          {t.progressText}
                        </div>
                      )}
                      {t.error && (
                        <div className="truncate text-xs" style={{ color: 'var(--red, #dc2626)' }}>
                          {t.error}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* Mailbox */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  Mailbox {unread > 0 ? `(${unread} unread)` : ''}
                </h3>
                {messages.length === 0 && <div style={{ color: 'var(--ink-muted)' }}>Empty</div>}
                <div className="space-y-1.5">
                  {messages.slice(-5).map((m) => (
                    <div key={m.id} className="rounded-md px-2 py-1.5" style={{ background: 'var(--paper-soft)' }}>
                      <div className="text-xs">
                        <span className="font-medium">{m.from}</span> → <span className="font-medium">{m.to}</span>
                        {!m.delivered && (
                          <span className="ml-1.5 font-semibold" style={{ color: 'var(--red, #dc2626)' }}>
                            unread
                          </span>
                        )}
                      </div>
                      <div className="line-clamp-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {m.text}
                      </div>
                    </div>
                  ))}
                </div>
                {/* 发送消息（队长 → 成员 / 全员） */}
                <div className="mt-2 flex items-center gap-1.5">
                  <select
                    value={msgTo}
                    onChange={(e) => setMsgTo(e.target.value)}
                    className="shrink-0 rounded-md border px-1.5 py-1 text-xs"
                    style={{ borderColor: 'var(--line, #e6e4de)', background: '#fff' }}
                    title="Send to"
                  >
                    <option value="all">all members</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={msgText}
                    onChange={(e) => setMsgText(e.target.value)}
                    placeholder="Message to team…"
                    className="min-w-0 flex-1 rounded-md border px-2 py-1 text-xs"
                    style={{ borderColor: 'var(--line, #e6e4de)', background: '#fff' }}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitSendMsg(); }}
                  />
                  <button
                    type="button"
                    onClick={submitSendMsg}
                    disabled={busy || !msgText.trim()}
                    className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-white transition-opacity disabled:opacity-40"
                    style={{ background: 'var(--primary)' }}
                  >
                    Send
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
