'use client';

/**
 * AgentStorePanel — Extensions Store · Agents tab
 *
 * 与 Skills tab 同排版（SkillManagerModal 市场/已装 双视图约定）：
 *   - Market：随包/可下载 agent 包网格（Assets agents），已装卡片保留并显示 Installed 态；
 *   - Installed：系统内置 + 已装市场 agent 卡片（启用开关/卸载/编辑系统提示 —— agent 编辑统一入口；
 *     结构性改造场景/内核/技能池走 AI Coding → Sub-Agent → Existing Agent 的 update_agent_package）。
 * 数据经 /api/agents（GET market+agents / POST install_agent|uninstall_agent|set_disabled），
 * 持久化到 <appRoot>/agents + .agents.json。
 */
import { useEffect, useState, useCallback } from 'react';
import {
  Bot, Check, Loader2, Search, X, Trash, Download, AlertCircle, RefreshCw, ShieldCheck, Sparkles, Pencil, Eye, EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from './ToggleSwitch';

interface AgentMarketManifest {
  id: string;
  name: string;
  description: string;
  version?: string;
  fixedScenes?: string[];
  coreExclusions?: string[];
  skillPool?: string[];
  icon?: string;
}

interface AgentMarketEntry {
  manifest: AgentMarketManifest;
  installed: boolean;
}

interface AgentItem {
  id: string;
  label: string;
  scenes: 'dynamic' | 'fixed';
  fixedScenes?: string[];
  forceBrowserTools?: boolean;
}

const SCENE_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All Scenes' },
  { key: 'legal', label: 'Legal' },
  { key: 'notebook', label: 'Notes' },
  { key: 'node', label: 'Node' },
  { key: 'general', label: 'General' },
  { key: 'butler', label: 'Butler' },
];

const sceneLabel = (key: string) => SCENE_FILTERS.find((f) => f.key === key)?.label ?? key;

/** 已装 agent 卡片：启用/禁用（chat 恒可用）+ 菜单可见性 + 市场类卸载 + 系统提示编辑（统一编辑入口，2026-09-06） */
function InstalledAgentCard({ agent, isMarket, disabled, hidden, busy, promptText, onToggle, onHiddenChange, onUninstall, onPromptSaved }: {
  agent: AgentItem;
  isMarket: boolean;
  disabled: boolean;
  /** 是否隐藏 ＋ Add session 菜单显示（≠禁用：能力保留） */
  hidden: boolean;
  busy: boolean;
  /** 当前 prompt 覆盖（来自 ~/.agents.json；空 = 用包内默认 prompt） */
  promptText: string;
  onToggle: (id: string, nextDisabled: boolean) => void;
  onHiddenChange: (id: string, nextHidden: boolean) => void;
  onUninstall: (id: string) => void;
  onPromptSaved: () => void;
}) {
  const scenes = agent.fixedScenes ?? [];
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(promptText);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [promptMsg, setPromptMsg] = useState('');

  const savePrompt = async (prompt: string) => {
    setSavingPrompt(true);
    setPromptMsg('');
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_prompt', agentId: agent.id, prompt }),
      });
      const data = await resp.json();
      if (data.success) {
        setPromptMsg(prompt.trim() ? 'Prompt override saved (next conversation uses it).' : 'Restored package default prompt.');
        onPromptSaved();
      } else {
        setPromptMsg(data.error || 'Failed to save prompt.');
      }
    } catch {
      setPromptMsg('Network error while saving prompt.');
    } finally {
      setSavingPrompt(false);
    }
  };

  return (
    <div
      className="rounded-md border px-3 py-2 transition-colors"
      style={{
        borderColor: !disabled ? 'color-mix(in oklab, var(--primary) 25%, transparent)' : 'var(--line)',
        backgroundColor: !disabled ? 'color-mix(in oklab, var(--primary) 3%, transparent)' : 'var(--input-bg)',
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
        >
          <Bot className="h-3.5 w-3.5" />
        </span>
        <span className="flex-1 truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>{agent.label}</span>
        {agent.id === 'chat' ? (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-xs leading-tight"
            style={{ backgroundColor: 'color-mix(in oklab, var(--success) 12%, transparent)', color: 'var(--success)' }}
          >
            <ShieldCheck className="h-2.5 w-2.5" />System
          </span>
        ) : isMarket ? (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-xs leading-tight"
            style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)', color: 'var(--primary)' }}
          >
            <Download className="h-2.5 w-2.5" />Market
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-xs leading-tight" style={{ color: 'var(--ink-faint)' }}>{agent.id}</span>
      </div>

      {scenes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {scenes.map((s) => (
            <span key={s} className="rounded px-1.5 py-px text-xs leading-tight" style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)' }}>
              {sceneLabel(s)}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <div
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2"
          style={{ backgroundColor: !disabled ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent' }}
          title={disabled ? 'Enable this agent' : 'Disable this agent'}
        >
          {agent.id === 'chat' ? (
            <>
              <ShieldCheck className="h-3 w-3" style={{ color: 'var(--success)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--success)' }}>Always on</span>
            </>
          ) : (
            <>
              <ToggleSwitch checked={!disabled} disabled={busy} onChange={() => onToggle(agent.id, !disabled)} />
              <span className="truncate text-xs font-medium" style={{ color: !disabled ? 'var(--primary)' : 'var(--ink-muted)' }}>
                {disabled ? 'Disabled' : 'Enabled'}
              </span>
            </>
          )}
        </div>
        {agent.id !== 'chat' && (
          <Button
            type="button"
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            className="shrink-0"
            title={editing ? 'Close prompt editor' : 'Edit system prompt'}
            aria-label="Edit system prompt"
            onClick={() => { setEditing((v) => !v); setEditText(promptText); setPromptMsg(''); }}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        )}
        {agent.id !== 'chat' && (
          <Button
            type="button"
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            className="shrink-0"
            disabled={busy}
            title={hidden ? 'Hidden from Add-session menu — click to show (agent stays installed)' : 'Shown in Add-session menu — click to hide (agent stays installed)'}
            aria-label="Toggle menu visibility"
            onClick={() => onHiddenChange(agent.id, !hidden)}
          >
            {hidden ? (
              <EyeOff className="h-3 w-3" style={{ color: 'var(--ink-muted)' }} />
            ) : (
              <Eye className="h-3 w-3" style={{ color: 'var(--primary)' }} />
            )}
          </Button>
        )}
        {agent.id !== 'chat' && isMarket && (
          <Button type="button" variant="outline" tone="neutral" size="icon-sm" className="shrink-0" disabled={busy}
            title="Uninstall agent" aria-label="Uninstall agent"
            onClick={() => onUninstall(agent.id)}
          >
            <Trash className="h-3 w-3" />
          </Button>
        )}
      </div>

      {editing && agent.id !== 'chat' && (
        <div className="mt-2 rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={5}
            placeholder={`System prompt override (empty = package default). For structural edits (scenes / kernel tools / skills) use AI Coding → Sub-Agent → Existing Agent.`}
            className="w-full resize-none rounded border bg-[var(--input-bg)] px-2 py-1.5 text-xs outline-none transition-colors"
            style={{ borderColor: 'var(--line)', color: 'var(--ink)', fontFamily: 'var(--font-sans)', lineHeight: 1.6 }}
          />
          <div className="mt-1.5 flex items-center justify-between gap-1.5">
            <span className="min-w-0 flex-1 truncate text-11" style={{ color: 'var(--ink-muted)' }}>{promptMsg || (editText.trim() ? 'Override in ~/.agents.json — package file unchanged.' : 'Uses package default prompt.')}</span>
            <span className="flex shrink-0 items-center gap-1">
              <Button type="button" variant="outline" tone="neutral" size="sm" disabled={savingPrompt}
                onClick={() => { void savePrompt(''); setEditText(''); }}>
                Restore Default
              </Button>
              <Button type="button" variant="solid" tone="brand" size="sm" disabled={savingPrompt} loading={savingPrompt}
                onClick={() => void savePrompt(editText)}>
                {savingPrompt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Save
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentStorePanel() {
  const [market, setMarket] = useState<AgentMarketEntry[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [hiddenMenu, setHiddenMenu] = useState<Set<string>>(new Set());
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [view, setView] = useState<'market' | 'installed'>('market');
  const [search, setSearch] = useState('');
  const [scene, setScene] = useState('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/agents');
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setError(data.error || 'Failed to load');
        return;
      }
      setAgents((data.agents || []) as AgentItem[]);
      setMarket((data.market || []) as AgentMarketEntry[]);
      setDisabled(new Set(data.disabled as string[]));
      setHiddenMenu(new Set((data.hiddenMenu as string[]) || []));
      setPrompts((data.prompts as Record<string, string>) || {});
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAgentsChanged = () => {
    window.dispatchEvent(new Event('agents-changed'));
  };

  const runAction = useCallback(async (id: string, action: 'install_agent' | 'uninstall_agent') => {
    if (busyId) return;
    setBusyId(id);
    setError('');
    setStatusMsg('');
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, agentId: id }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setError(data.error || 'Action failed');
        return;
      }
      setStatusMsg(action === 'install_agent' ? `Installed: ${id}` : `Uninstalled: ${id}`);
      refreshAgentsChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusyId(null);
    }
  }, [busyId, load]);

  const toggleDisabled = useCallback(async (id: string, nextDisabled: boolean) => {
    setBusyId(id);
    setError('');
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_disabled', agentId: id, disabled: nextDisabled }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setError(data.error || 'Failed to update');
        return;
      }
      setDisabled(new Set(data.disabled as string[]));
      refreshAgentsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusyId(null);
    }
  }, []);

  /** 菜单可见性（≠禁用）：隐藏只影响 ＋ Add session 菜单，agent 仍已装且身份可被调用 */
  const toggleHiddenMenu = useCallback(async (id: string, nextHidden: boolean) => {
    setBusyId(id);
    setError('');
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_hidden_menu', agentId: id, hidden: nextHidden }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setError(data.error || 'Failed to update');
        return;
      }
      setHiddenMenu(new Set((data.hiddenMenu as string[]) || []));
      refreshAgentsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusyId(null);
    }
  }, []);

  const q = search.trim().toLowerCase();
  const availableCount = market.filter((m) => !m.installed).length;
  const installedMarketIds = new Set(market.filter((m) => m.installed).map((m) => m.manifest.id));
  const marketScenes = Array.from(
    new Set(
      market
        .map((m) => m.manifest.fixedScenes?.[0])
        .filter((s): s is string => !!s && SCENE_FILTERS.some((f) => f.key === s)),
    ),
  );
  const enabledCount = agents.filter((a) => !disabled.has(a.id)).length;

  const filteredMarket = market.filter((entry) => {
    const m = entry.manifest;
    const primary = m.fixedScenes?.[0];
    const okScene = scene === 'all' || primary === scene;
    const okQuery = !q || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) || m.id.includes(q);
    return okScene && okQuery;
  });
  const filteredAgents = agents.filter((a) => !q || a.label.toLowerCase().includes(q) || a.id.includes(q));

  return (
    <>
      {/* 吸顶头部：视图切换 + 计数 + 搜索/场景筛选 */}
      <div
        className="sticky top-0 z-20 -mx-6 mb-3 border-b bg-[var(--paper)] px-6 pb-2 sm:-mx-8 sm:px-8"
        style={{ borderColor: 'var(--line-soft)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 rounded-md border p-0.5" style={{ borderColor: 'var(--line)' }}>
            <button
              type="button"
              onClick={() => setView('market')}
              className="rounded px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1"
              style={{
                color: view === 'market' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                backgroundColor: view === 'market' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
              }}
            >
              <Download className="h-3 w-3" />Market
            </button>
            <button
              type="button"
              onClick={() => setView('installed')}
              className="rounded px-2.5 py-1 text-xs font-medium transition-colors"
              style={{
                color: view === 'installed' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                backgroundColor: view === 'installed' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
              }}
            >
              Installed
            </button>
          </div>
          <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {view === 'market' ? `${availableCount} available` : `${enabledCount} / ${agents.length} enabled`}
          </span>
        </div>

        <div className="relative mt-2">
          <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={view === 'market' ? 'Search agents…' : '搜索 agent 名称或 id…'}
            className="w-full rounded-md border py-1.5 pl-7 pr-7 text-xs outline-none transition-colors"
            style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink-strong)' }}
          />
          {search && (
            <button type="button" onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors hover:bg-[var(--paper-soft)]">
              <X className="h-3 w-3" style={{ color: 'var(--ink-muted)' }} />
            </button>
          )}
        </div>

        {view === 'market' && marketScenes.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setScene('all')}
              className="rounded-full px-2 py-0.5 text-xs transition-colors"
              style={{
                backgroundColor: scene === 'all' ? 'var(--primary)' : 'transparent',
                color: scene === 'all' ? '#fff' : 'var(--ink-muted)',
                border: scene === 'all' ? '1px solid var(--primary)' : '1px solid var(--line)',
              }}
            >
              All
            </button>
            {marketScenes.map((sc) => (
              <button
                key={sc}
                type="button"
                onClick={() => setScene(sc)}
                className="rounded-full px-2 py-0.5 text-xs transition-colors"
                style={{
                  backgroundColor: scene === sc ? 'var(--primary)' : 'transparent',
                  color: scene === sc ? '#fff' : 'var(--ink-muted)',
                  border: scene === sc ? '1px solid var(--primary)' : '1px solid var(--line)',
                }}
              >
                {sceneLabel(sc)}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs"
          style={{ backgroundColor: 'color-mix(in oklab, var(--danger) 6%, transparent)', color: 'var(--danger)' }}>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {statusMsg && (
        <div className="mb-3 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs"
          style={{ backgroundColor: 'color-mix(in oklab, var(--success) 6%, transparent)', color: 'var(--success)' }}>
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span>{statusMsg}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--primary)' }} />
        </div>
      ) : view === 'market' ? (
        filteredMarket.length === 0 ? (
          <div className="rounded-md border px-4 py-6 text-center" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
            <Sparkles className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              {market.length === 0 ? 'No bundled agents available right now.' : 'No agents match your search / filter.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
            {filteredMarket.map((entry) => {
              const m = entry.manifest;
              const busy = busyId === m.id;
              const primary = m.fixedScenes?.[0];
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-2.5 rounded-md border px-3 py-2.5"
                  style={{
                    borderColor: entry.installed ? 'color-mix(in oklab, var(--primary) 22%, transparent)' : 'var(--line)',
                    backgroundColor: entry.installed ? 'color-mix(in oklab, var(--primary) 3%, transparent)' : 'var(--input-bg)',
                  }}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}>
                    <Bot className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>{m.name}</span>
                      {primary && marketScenes.includes(primary) && (
                        <span className="hidden shrink-0 rounded px-1 py-px text-xs leading-tight md:inline"
                          style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}>
                          {sceneLabel(primary)}
                        </span>
                      )}
                      <span className="shrink-0 text-xs leading-tight" style={{ color: 'var(--ink-faint)' }}>v{m.version || '1.0.0'}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>{m.description}</p>
                  </div>
                  {entry.installed ? (
                    <span className="flex shrink-0 items-center rounded-md px-2.5 py-1.5 text-xs font-medium"
                      style={{
                        color: 'var(--success)',
                        border: '1px solid color-mix(in oklab, var(--success) 30%, transparent)',
                        backgroundColor: 'color-mix(in oklab, var(--success) 6%, transparent)',
                      }}>
                      Installed
                    </span>
                  ) : (
                    <Button type="button" disabled={busy} loading={busy}
                      onClick={() => void runAction(m.id, 'install_agent')} variant="solid" tone="brand" size="sm">
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      {busy ? 'Installing…' : 'Install'}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : filteredAgents.length === 0 ? (
        <div className="rounded-md border px-4 py-6 text-center" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
          <Bot className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {agents.length === 0 ? 'No agents installed yet.' : 'No agents match your search.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredAgents.map((a) => (
            <InstalledAgentCard
              key={a.id}
              agent={a}
              isMarket={installedMarketIds.has(a.id)}
              disabled={disabled.has(a.id)}
              hidden={hiddenMenu.has(a.id)}
              busy={busyId === a.id}
              promptText={prompts[a.id] ?? ''}
              onToggle={(id, nextDisabled) => void toggleDisabled(id, nextDisabled)}
              onHiddenChange={(id, nextHidden) => void toggleHiddenMenu(id, nextHidden)}
              onUninstall={(id) => void runAction(id, 'uninstall_agent')}
              onPromptSaved={() => void load()}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-end">
        <Button type="button" onClick={() => void load()} disabled={loading} variant="ghost" tone="neutral" size="sm">
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>
    </>
  );
}
