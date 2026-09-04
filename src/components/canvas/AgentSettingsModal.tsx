'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Cpu, ChevronDown, ChevronRight, Loader2, Pencil, RotateCcw, ShieldCheck, X, Check } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';

/**
 * Agent 设置面板（Settings → Agents）
 *
 * 展示全部已注册 Agent（来自 AGENT_PROFILES 注册表），支持：
 *   - 启用/禁用专项 agent（禁用后该身份的请求回退到通用 chat Agent）
 *   - 查看 / 编辑专属 base system prompt（覆盖注册表默认值，空串恢复默认）
 *
 * 数据经 /api/agents 读写，持久化到 $BOBWORK_HOME/.agents.json。
 */

interface AgentProfileLike {
  id: string;
  label: string;
  scenes: 'dynamic' | 'fixed';
  fixedScenes?: string[];
  forceBrowserTools?: boolean;
  baseSystemPrompt?: string;
}

interface AgentSettingsModalProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  embedded?: boolean;
}

const SCENE_LABELS: Record<string, string> = {
  general: 'General',
  coding: 'Coding',
  design: 'Design',
  node: 'Node',
  browser: 'Browser',
  team: 'Team',
  local: 'Local',
  legal: 'Legal',
  office: 'Office',
  wanted: 'Wanted',
  notebook: 'Notes',
  ocr: 'OCR',
  audio: 'Audio',
  skill: 'Skills',
  admin: 'Admin',
  company: 'Company',
};

export function AgentSettingsModal({ open, onOpenChange, embedded }: AgentSettingsModalProps) {
  const [agents, setAgents] = useState<AgentProfileLike[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 展开的提示词面板（agentId 集合）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 正在编辑提示词的 agentId（null = 无编辑）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ id: string; text: string } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/agents');
      const data = await resp.json();
      if (data.success) {
        setAgents(data.agents as AgentProfileLike[]);
        setDisabled(new Set(data.disabled as string[]));
        setPrompts((data.prompts as Record<string, string>) || {});
      } else {
        setError(data.error || 'Failed to load agents');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleDisabled = useCallback(async (agentId: string, nextDisabled: boolean) => {
    setTogglingId(agentId);
    setSaveMsg(null);
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_disabled', agentId, disabled: nextDisabled }),
      });
      const data = await resp.json();
      if (data.success) {
        setDisabled(new Set(data.disabled as string[]));
        setPrompts((data.prompts as Record<string, string>) || {});
      } else {
        setError(data.error || 'Failed to update');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingId(null);
    }
  }, []);

  const startEdit = useCallback((agent: AgentProfileLike) => {
    const current = prompts[agent.id] ?? agent.baseSystemPrompt ?? '';
    setEditingId(agent.id);
    setEditText(current);
    setSaveMsg(null);
    setExpanded((prev) => new Set(prev).add(agent.id));
    requestAnimationFrame(() => scrollRef.current?.scrollIntoView({ block: 'nearest' }));
  }, [prompts]);

  const savePrompt = useCallback(async (agentId: string) => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_prompt', agentId, prompt: editText }),
      });
      const data = await resp.json();
      if (data.success) {
        setPrompts((data.prompts as Record<string, string>) || {});
        setEditingId(null);
        setSaveMsg({ id: agentId, text: editText.trim() ? 'Custom prompt saved' : 'Restored default prompt' });
        setTimeout(() => setSaveMsg((m) => (m?.id === agentId ? null : m)), 2500);
      } else {
        setError(data.error || 'Failed to save prompt');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [editText]);

  const resetPrompt = useCallback(async (agentId: string) => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_prompt', agentId, prompt: '' }),
      });
      const data = await resp.json();
      if (data.success) {
        setPrompts((data.prompts as Record<string, string>) || {});
        setEditingId(null);
        setEditText('');
        setSaveMsg({ id: agentId, text: 'Restored default prompt' });
        setTimeout(() => setSaveMsg((m) => (m?.id === agentId ? null : m)), 2500);
      } else {
        setError(data.error || 'Failed to reset prompt');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  const toggleExpand = useCallback((agentId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  const isDisabled = (id: string) => disabled.has(id);

  const inner = (
    <>
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <div>
          <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            Agents
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-[var(--paper-soft)]"
          style={{ color: 'var(--ink-muted)' }}
          title="Refresh"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="mx-5 mb-2 rounded-md px-3 py-2 text-xs" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--ink-muted)' }} />
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-5 pb-5">
          {agents.map((agent) => {
            const off = isDisabled(agent.id);
            const isOpen = expanded.has(agent.id);
            const hasCustom = !!prompts[agent.id];
            const isEditing = editingId === agent.id;
            const isGeneral = agent.scenes === 'dynamic';
            return (
              <div
                key={agent.id}
                className="overflow-hidden rounded-xl border transition-colors"
                style={{
                  borderColor: isOpen ? 'color-mix(in oklab, var(--line) 60%, transparent)' : 'var(--line-soft)',
                  backgroundColor: 'var(--paper)',
                  opacity: off ? 0.62 : 1,
                }}
              >
                {/* 卡片头 */}
                <div className="flex items-center gap-3 px-3.5 py-3">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: isGeneral ? 'var(--paper-soft)' : 'color-mix(in oklab, var(--info) 12%, transparent)' }}
                  >
                    <Bot className="h-4 w-4" style={{ color: isGeneral ? 'var(--ink-muted)' : 'var(--info)' }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium" style={{ color: 'var(--ink)' }}>{agent.label}</span>
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-10 font-medium"
                        style={{
                          backgroundColor: isGeneral ? 'var(--paper-soft)' : 'color-mix(in oklab, var(--info) 12%, transparent)',
                          color: isGeneral ? 'var(--ink-muted)' : 'var(--info)',
                        }}
                      >
                        {isGeneral ? 'General' : 'Specialized'}
                      </span>
                    </div>
                    <div className="truncate font-mono text-11" style={{ color: 'var(--ink-faint)' }}>
                      id: {agent.id}
                    </div>
                  </div>

                  {/* 启用/禁用开关（chat 恒可用） */}
                  {agent.id === 'chat' ? (
                    <span className="flex shrink-0 items-center gap-1 text-11" style={{ color: 'var(--success)' }}>
                      <ShieldCheck className="h-3.5 w-3.5" /> Always on
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={togglingId === agent.id}
                      onClick={() => void toggleDisabled(agent.id, !off)}
                      className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-11 font-medium transition-colors disabled:opacity-60"
                      style={{
                        backgroundColor: off ? 'var(--paper-soft)' : 'color-mix(in oklab, var(--success) 14%, transparent)',
                        color: off ? 'var(--ink-muted)' : 'var(--success)',
                      }}
                      title={off ? 'Click to enable this agent' : 'Click to disable this agent'}
                    >
                      {togglingId === agent.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: off ? 'var(--ink-muted)' : 'var(--success)' }} />
                      )}
                      {off ? 'Disabled' : 'Enabled'}
                    </button>
                  )}
                </div>

                {/* 工具画像 */}
                <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-3">
                  {!isGeneral && agent.fixedScenes && agent.fixedScenes.length > 0 && (
                    <span className="flex items-center gap-1 text-10" style={{ color: 'var(--ink-faint)' }}>
                      <Cpu className="h-3 w-3" /> scenes:
                    </span>
                  )}
                  {!isGeneral &&
                    (agent.fixedScenes || []).map((s) => (
                      <span
                        key={s}
                        className="rounded px-1.5 py-0.5 text-10 font-medium"
                        style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)' }}
                      >
                        {SCENE_LABELS[s] ?? s}
                      </span>
                    ))}
                  {agent.forceBrowserTools && (
                    <span
                      className="rounded px-1.5 py-0.5 text-10 font-medium"
                      style={{ backgroundColor: 'color-mix(in oklab, var(--primary-strong) 12%, transparent)', color: 'var(--primary-strong)' }}
                    >
                      Browser rules
                    </span>
                  )}
                  {hasCustom && (
                    <span
                      className="rounded px-1.5 py-0.5 text-10 font-medium"
                      style={{ backgroundColor: 'color-mix(in oklab, var(--info) 12%, transparent)', color: 'var(--info)' }}
                    >
                      Custom prompt
                    </span>
                  )}
                  {!isGeneral && (
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => (isEditing ? setEditingId(null) : startEdit(agent))}
                        className="flex items-center gap-1 rounded px-2 py-1 text-11 font-medium transition-colors hover:bg-[var(--paper-soft)]"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <Pencil className="h-3 w-3" />
                        {isEditing ? 'Cancel edit' : 'Edit prompt'}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleExpand(agent.id)}
                        className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--paper-soft)]"
                        style={{ color: 'var(--ink-muted)' }}
                        title={isOpen ? 'Collapse prompt' : 'View prompt'}
                      >
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    </span>
                  )}
                </div>

                {/* 提示词查看/编辑 */}
                {isOpen && (
                  <div className="border-t px-3.5 py-3" style={{ borderColor: 'var(--line-soft)' }}>
                    {agent.id === 'chat' && !prompts.chat ? (
                      <div className="text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                        Uses the shared general base prompt (BASE_SYSTEM_PROMPT) from the chat engine.
                      </div>
                    ) : isEditing ? (
                      <>
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          spellCheck={false}
                          rows={10}
                          className="w-full resize-y rounded-md border p-2 font-mono text-xs leading-relaxed outline-none"
                          style={{
                            borderColor: 'var(--input-border)',
                            backgroundColor: 'var(--input-bg)',
                            color: 'var(--ink)',
                          }}
                        />
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void savePrompt(agent.id)}
                            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                            style={{ backgroundColor: 'var(--primary)' }}
                          >
                            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                            Save
                          </button>
                          {hasCustom && (
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void resetPrompt(agent.id)}
                              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--paper-soft)] disabled:opacity-50"
                              style={{ color: 'var(--ink-muted)' }}
                            >
                              <RotateCcw className="h-3 w-3" />
                              Reset to default
                            </button>
                          )}
                          {saveMsg?.id === agent.id && (
                            <span className="text-xs" style={{ color: 'var(--success)' }}>{saveMsg.text}</span>
                          )}
                        </div>
                      </>
                    ) : (
                      <pre
                        ref={scrollRef}
                        className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md p-2 font-mono text-11 leading-relaxed"
                        style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)' }}
                      >
                        {prompts[agent.id] ?? agent.baseSystemPrompt ?? '(none)'}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div className="px-1 py-1">{inner}</div>;
  }
  return (
    <DialogShell open={!!open} onOpenChange={onOpenChange} inner={inner} />
  );
}

/** 独立弹窗形态（当前 Settings 内嵌使用；保留 Dialog 能力供未来独立打开） */
function DialogShell({ open, onOpenChange, inner }: { open: boolean; onOpenChange?: (o: boolean) => void; inner: React.ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0" style={{ fontFamily: 'var(--font-sans)' }}>
        {inner}
        <div className="flex items-center justify-end px-6 py-4">
          <button
            type="button"
            onClick={() => onOpenChange?.(false)}
            className="flex items-center gap-1 rounded-md px-4 py-1.5 text-xs transition-colors hover:bg-[var(--paper-soft)]"
            style={{ color: 'var(--ink-muted)' }}
          >
            <X className="h-3 w-3" /> Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
