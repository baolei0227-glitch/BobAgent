/**
 * AgentTeamsNode — Agent Teams 团队执行观察台（画布节点）
 *
 * 定位：不承担执行（编排由主 Agent 调 mcp__team__* 完成），节点仅用于
 *   · 实时观察团队执行过程（成员 running/idle、任务 DAG 状态、progressText 工具级进度）
 *   · 关键操作：Approve & Run 门禁、discard 草案、archive 归档
 *
 * 触发：主 Agent 调用 mcp__team__* 工具 → 服务端 SSE 推送 team_trigger →
 *       CanvasFlow 自动创建/聚焦本节点并建立「发起节点 → 本节点」连线。
 * 数据源：/api/team（GET 状态 + 团队列表；POST 转调 team_* 工具），2s 轮询。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { X, CheckCircle2, XCircle, Users, ListTodo } from 'lucide-react';
import { NodeCardHeader } from './NodeCardHeader';
import { useConfirm } from './ConfirmDialog';
import { Button } from '@/components/ui/button';
import type { AgentTeamsNodeData } from '@/lib/types';

/** 团队状态 → 徽标配色 */
const TEAM_STATUS_STYLE: Record<string, { color: string; label: string }> = {
  planning: { color: 'var(--warn)', label: 'PLANNING' },
  approved: { color: 'var(--info)', label: 'APPROVED' },
  running: { color: 'var(--success)', label: 'RUNNING' },
  done: { color: 'var(--success)', label: 'DONE' },
  archived: { color: 'var(--ink-muted)', label: 'ARCHIVED' },
};

/** 任务状态 → 徽标配色 */
const TASK_STATUS_STYLE: Record<string, { color: string; label: string }> = {
  draft: { color: 'var(--ink-muted)', label: 'DRAFT' },
  ready: { color: 'var(--info)', label: 'READY' },
  claimed: { color: 'var(--info)', label: 'CLAIMED' },
  running: { color: 'var(--success)', label: 'RUNNING' },
  done: { color: 'var(--success)', label: 'DONE' },
  failed: { color: 'var(--danger)', label: 'FAILED' },
};

/** 成员状态 → 色点 */
const MEMBER_STATUS_COLOR: Record<string, string> = {
  idle: 'var(--success)',
  busy: 'var(--warn)',
  parked: 'var(--ink-muted)',
  offline: 'var(--danger)',
};

interface TeamDetail {
  teamId: string;
  name?: string;
  goal?: string;
  status?: string;
  approvedAt?: number | null;
  members?: Array<{ id: string; name: string; role: string; status: string; currentTaskId?: string; messageCount?: number }>;
  tasks?: Array<{ id: string; subject: string; assignee?: string; dependencies?: string[]; status: string; progress?: number; progressText?: string; error?: string; qualityStage?: string }>;
  messageCount?: number;
  unreadForCaptain?: number;
  [k: string]: unknown;
}

function AgentTeamsNodeInner({ id, data, selected }: {
  id: string;
  data: AgentTeamsNodeData;
  selected?: boolean;
}) {
  const { setNodes, setEdges, getNode } = useReactFlow();
  const { ask: confirmAsk, render: confirmRender } = useConfirm();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [teams, setTeams] = useState<string[]>([]);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [lastUpdated, setLastUpdated] = useState('');
  const [error, setError] = useState('');
  // 团队已被归档/删除（status 轮询返回 Team not found）→ 停止轮询、显示中性终态而非持续红字
  const [notFound, setNotFound] = useState(false);
  const selectedRef = useRef('');
  const notFoundRef = useRef(false);
  selectedRef.current = selectedTeam;

  // 团队列表 + 启用状态（GET /api/team）
  const loadTeams = useCallback(async () => {
    try {
      const resp = await fetch('/api/team');
      const res = await resp.json();
      if (res.ok) {
        setEnabled(res.enabled === true);
        const list = Array.isArray(res.teams) ? (res.teams as string[]) : [];
        setTeams(list);
        if (list.length > 0 && !selectedRef.current) {
          setSelectedTeam(list[0]);
        }
      } else {
        setEnabled(false);
      }
    } catch {
      setEnabled(false);
    }
  }, []);

  // 团队详情（POST /api/team status）
  const loadStatus = useCallback(async (teamId: string) => {
    if (!teamId) return;
    try {
      const resp = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', team_id: teamId }),
      });
      const res = await resp.json();
      if (res.ok) {
        setTeam(res as TeamDetail);
        setError('');
      } else {
        const msg = String(res.error || 'status failed');
        if (msg.includes('Team not found')) {
          // 团队已归档：保留最后快照做终态展示，停轮询（notFoundRef 在轮询回调中拦截）
          notFoundRef.current = true;
          setNotFound(true);
          setError('');
        } else {
          setError(msg);
        }
      }
      setLastUpdated(new Date().toLocaleTimeString());
    } catch {
      /* 轮询静默 */
    }
  }, []);

  useEffect(() => {
    loadTeams();
    const t = setInterval(loadTeams, 10_000);
    return () => clearInterval(t);
  }, [loadTeams]);

  useEffect(() => {
    if (!selectedTeam) return;
    // 切换团队：复位归档终态
    notFoundRef.current = false;
    setNotFound(false);
    loadStatus(selectedTeam);
    const t = setInterval(() => {
      if (notFoundRef.current) return; // 团队已归档 → 不再打 status
      loadStatus(selectedRef.current);
    }, 2000);
    return () => clearInterval(t);
  }, [selectedTeam, loadStatus]);

  // 操作：approve / discard / archive
  const doAction = useCallback(async (action: string, confirmText?: string) => {
    if (!selectedRef.current) return;
    if (confirmText && !(await confirmAsk({ title: 'Agent Teams', message: confirmText }))) return;
    try {
      const resp = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, team_id: selectedRef.current }),
      });
      const res = await resp.json();
      if (!res.ok) setError(res.error || `${action} failed`);
      await loadStatus(selectedRef.current);
    } catch {
      /* 忽略 */
    }
  }, [confirmAsk, loadStatus]);

  // 删除节点
  const handleDelete = useCallback(async () => {
    const ok = await confirmAsk({
      title: 'Delete Node?',
      message: 'Deleting "Agent Teams" will permanently remove this node.\nThis action cannot be undone.',
    });
    if (!ok) return;
    const node = getNode(id);
    const nodeMdId = (node?.data as AgentTeamsNodeData | undefined)?.nodeMdId || id;
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', node_id: nodeMdId }),
    })
      .then((r) => { if (!r.ok) console.error('AgentTeams node delete failed:', r.status); })
      .catch((err) => console.error('AgentTeams node delete request error:', err));
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
  }, [id, getNode, setNodes, setEdges, confirmAsk]);

  const running = team?.status === 'running' || team?.tasks?.some((t) => t.status === 'running' || t.status === 'claimed');
  const hasDraft = team && (team.status === 'planning' || team.status === 'approved');
  const statusColor = enabled === null ? 'var(--ink-muted)' : enabled ? (running ? 'var(--success)' : 'var(--info)') : 'var(--danger)';

  const taskStatusCount = (team?.tasks ?? []).filter((t) => t.status === 'running' || t.status === 'claimed' || t.status === 'ready').length;
  const subtitle = enabled === false
    ? '插件未启用（设置面板）'
    : !team
      ? lastUpdated ? '暂无团队' : '载入中…'
      : running
        ? `执行中 · ${taskStatusCount} 个任务活跃`
        : team.status === 'done' || team.status === 'archived'
          ? `已完成 · ${lastUpdated}`
          : `空闲 · ${lastUpdated}`;

  return (
    <div
      className="ai-node-wrapper group relative flex flex-col overflow-hidden rounded-lg border text-sm"
      style={{
        width: 460,
        minHeight: 260,
        backgroundColor: 'var(--paper)',
        borderColor: selected ? 'color-mix(in oklab, var(--info) 60%, transparent)' : 'var(--line)',
        boxShadow: selected
          ? '0 0 0 2px color-mix(in oklab, var(--info) 25%, transparent), 0 8px 24px rgba(0,0,0,.12)'
          : '0 4px 14px rgba(0,0,0,.08)',
      }}
    >
      {/* 画布连线已物理移除（2026-09）：不再渲染 Handle 拖线 */}

      <NodeCardHeader
        title="Agent Teams"
        subtitle={subtitle}
        rightActions={
          <div className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ backgroundColor: statusColor, opacity: 0.9 }} />
            {/* 删除 = 破坏性：ghost danger 潜伏（常态灰，hover 才显红），配合上方 confirm */}
            <Button
              variant="ghost"
              tone="danger"
              size="icon-xs"
              onClick={handleDelete}
              title="删除此节点"
              aria-label="删除此节点"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        }
        divider
      />
      {confirmRender}

      <div className="flex flex-col gap-2 p-3">
        {enabled === false ? (
          <div className="rounded-md border border-dashed p-3 text-center" style={{ color: 'var(--danger)' }}>
            插件未启用：请在设置面板的 MCP 列表开启 <b>team</b>
          </div>
        ) : teams.length === 0 ? (
          <div className="rounded-md border border-dashed p-3 text-center" style={{ color: 'var(--ink-muted)' }}>
            暂无团队。对主 Agent 说"开个团队让多个分身协作"即可自动创建。
          </div>
        ) : (
          <>
            {/* 团队选择 */}
            <div className="flex items-center gap-2">
              <select
                value={selectedTeam}
                onChange={(e) => setSelectedTeam(e.target.value)}
                className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs"
                style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
              >
                {teams.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {/* 批准 = 唯一实底焦点（brand）；与下方状态灯绿（running）区分，避免同屏两处绿 */}
              {hasDraft && (
                <Button
                  variant="solid"
                  tone="brand"
                  size="sm"
                  onClick={() => doAction('approve', '批准该团队计划并开始执行？')}
                  title="Approve & Run"
                >
                  <CheckCircle2 className="h-3 w-3" /> 批准执行
                </Button>
              )}
              {team?.status === 'planning' && (
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  onClick={() => doAction('discard', '放弃当前计划草案？')}
                  title="Discard draft"
                >
                  <XCircle className="h-3 w-3" /> 放弃
                </Button>
              )}
              {(team?.status === 'done' || team?.status === 'archived') && (
                <Button
                  variant="soft"
                  tone="info"
                  size="sm"
                  onClick={() => doAction('archive', '归档该团队记录？')}
                  title="Archive team"
                >
                  归档
                </Button>
              )}
            </div>

            {error && <div className="text-xs" style={{ color: 'var(--danger)' }}>{error}</div>}
            {notFound && (
              <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                该团队已归档，仅展示最后一次快照（已停止轮询）
              </div>
            )}

            {/* 团队概览 */}
            {team?.goal && (
              <div className="rounded-md border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}>
                <span className="font-medium">目标：</span>{team.goal}
                {team.status && (
                  <span
                    className="ml-2 rounded px-1.5 py-0.5 text-10 font-semibold tracking-wider"
                    style={{ backgroundColor: 'color-mix(in oklab, ' + (TEAM_STATUS_STYLE[team.status]?.color ?? 'var(--ink)') + ' 18%, transparent)', color: TEAM_STATUS_STYLE[team.status]?.color ?? 'var(--ink)' }}
                  >
                    {TEAM_STATUS_STYLE[team.status]?.label ?? team.status.toUpperCase()}
                  </span>
                )}
              </div>
            )}

            {/* 成员面板 */}
            <div className="rounded-md border" style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-center gap-1 border-b px-2 py-1 text-10 font-semibold uppercase tracking-wider" style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}>
                <Users className="h-3 w-3" /> 成员 ({team?.members?.length ?? 0})
              </div>
              <div className="max-h-28 overflow-y-auto">
                {(team?.members ?? []).map((m) => (
                  <div key={m.id} className="flex items-center gap-2 border-b px-2 py-1 text-xs last:border-b-0" style={{ borderColor: 'color-mix(in oklab, var(--line) 50%, transparent)' }}>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: MEMBER_STATUS_COLOR[m.status] ?? 'var(--ink-muted)' }} />
                    <span className="font-medium" style={{ color: 'var(--ink)' }}>{m.name}</span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--ink-muted)' }}>{m.role}</span>
                    <span className="shrink-0" style={{ color: MEMBER_STATUS_COLOR[m.status] ?? 'var(--ink-muted)' }}>
                      {m.status}
                      {m.currentTaskId ? ` · ${m.currentTaskId}` : ''}
                    </span>
                  </div>
                ))}
                {(team?.members?.length ?? 0) === 0 && (
                  <div className="px-2 py-2 text-xs" style={{ color: 'var(--ink-muted)' }}>暂无成员（批准计划后实例化）</div>
                )}
              </div>
            </div>

            {/* 任务面板 */}
            <div className="rounded-md border" style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-center gap-1 border-b px-2 py-1 text-10 font-semibold uppercase tracking-wider" style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}>
                <ListTodo className="h-3 w-3" /> 任务 ({team?.tasks?.length ?? 0})
              </div>
              <div className="max-h-44 overflow-y-auto">
                {(team?.tasks ?? []).map((t) => {
                  const st = TASK_STATUS_STYLE[t.status] ?? { color: 'var(--ink-muted)', label: t.status.toUpperCase() };
                  const isActive = t.status === 'running' || t.status === 'claimed';
                  return (
                    <div key={t.id} className="border-b px-2 py-1.5 last:border-b-0" style={{ borderColor: 'color-mix(in oklab, var(--line) 50%, transparent)' }}>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-medium" style={{ color: 'var(--ink)' }}>{t.id}</span>
                        <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-10 font-semibold tracking-wider" style={{ backgroundColor: 'color-mix(in oklab, ' + st.color + ' 18%, transparent)', color: st.color }}>
                          {st.label}
                        </span>
                      </div>
                      {(typeof t.progress === 'number' || isActive) && (
                        <div className="mt-1 flex items-center gap-2">
                          <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'color-mix(in oklab, var(--line) 60%, transparent)' }}>
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${t.progress ?? 10}%`, backgroundColor: st.color, opacity: 0.85 }}
                            />
                          </div>
                          {t.progressText && (
                            <span className="shrink-0 text-10" style={{ color: 'var(--info)' }}>{t.progressText}</span>
                          )}
                        </div>
                      )}
                      {t.status === 'failed' && t.error && (
                        <div className="mt-0.5 truncate text-10" style={{ color: 'var(--danger)' }} title={t.error}>{t.error}</div>
                      )}
                      {t.qualityStage && t.qualityStage !== 'done' && (
                        <div className="mt-0.5 text-10" style={{ color: 'var(--warn)' }}>质量门禁阶段：{t.qualityStage}</div>
                      )}
                    </div>
                  );
                })}
                {(team?.tasks?.length ?? 0) === 0 && (
                  <div className="px-2 py-2 text-xs" style={{ color: 'var(--ink-muted)' }}>暂无任务（批准计划后进入调度）</div>
                )}
              </div>
            </div>

            {team && typeof team.unreadForCaptain === 'number' && team.unreadForCaptain > 0 && (
              <div className="text-xs" style={{ color: 'var(--warn)' }}>
                {team.unreadForCaptain} 条未读消息（成员完成通知）
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export const AgentTeamsNode = React.memo(function AgentTeamsNode(props: {
  id: string;
  data: AgentTeamsNodeData;
  selected?: boolean;
}) {
  return <AgentTeamsNodeInner {...props} />;
});
