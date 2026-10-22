'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Bot, Plus, Pencil, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEFAULT_MODEL_ID } from '@/lib/types';

interface CreatedNodePayload {
  nodeId: string;
  title: string;
  /** 预填的首轮用户消息（由画布层写入节点并落盘占位回答） */
  initialPrompt?: string;
}

interface Props {
  open: boolean;
  /** 画布坐标（flow 坐标），创建节点时写入 frontmatter 便于重启恢复布局 */
  position: { x: number; y: number } | null;
  onClose: () => void;
  /** 创建成功回调，由画布层挂载 chat 节点并打开为新对话 */
  onCreated: (payload: CreatedNodePayload) => void;
}

/**
 * AgentCreateDialog —— 创建/改造专属子 Agent 的入口（2026-10-17 从 AI Coding 创建框迁出）。
 *
 * 背景：AI Coding 创建框原本带一个 `Mini App / Sub-Agent` 分档，但 Sub-Agent 档产出的是
 * 普通 chat 节点（node_type='chat'，不写 sandbox_app_id），与「AI Coding = 绑 Bob Sandbox 小程序」
 * 是两套产物模型；且它的 `initialKind='agent'` 直入口早已无人调用，只剩一个可手动点击的孤儿 tab。
 * 现改为独立入口（＋ Add session → New Agent…），产物/文案/生命周期都归位，AI Coding 框只负责小程序。
 *
 * 流程不变：两种档位都只创建 chat 节点并预填首轮消息，由 Coding 对话（create_agent_package /
 * update_agent_package 的 scenes:['coding'] 由预填文本中的工具名激活）引导确认后落包。
 */
export function AgentCreateDialog({ open, position, onClose, onCreated }: Props) {
  // new = 新建（create_agent_package）；existing = 改造已装 agent（update_agent_package）
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  // 补充人设/边界（可选）
  const [agentRole, setAgentRole] = useState('');
  // Existing 档：已装可改造 agent（市场安装的包；chat/coding 系统内置不可经包改）
  const [installedAgents, setInstalledAgents] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadInstalledAgents = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/agents');
      const data = await resp.json();
      if (data.success) {
        const list = ((data.agents || []) as { id: string; label: string }[])
          .filter((a) => a.id !== 'chat' && a.id !== 'coding') // 系统内置不可经包改造
          .sort((a, b) => a.label.localeCompare(b.label));
        setInstalledAgents(list);
      }
    } catch {
      setInstalledAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setMode('new');
    setName('');
    setPrompt('');
    setAgentRole('');
    void loadInstalledAgents();
  }, [open, loadInstalledAgents]);

  if (!open) return null;

  /** 创建 chat 节点，成功后统一回调（Agent 造包会话不需要 sandbox_app_id） */
  const createNode = async (title: string, initialPromptText: string) => {
    setCreating(true);
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title,
          model: DEFAULT_MODEL_ID,
          sources: [],
          node_type: 'chat',
          ...(position ? { position_x: position.x, position_y: position.y } : {}),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        onCreated({
          nodeId: data.node_id,
          title: data.title || title,
          initialPrompt: initialPromptText.trim() || undefined,
        });
        onClose();
      }
    } catch {
      // 创建失败：忽略，保持对话框打开
    } finally {
      setCreating(false);
    }
  };

  /**
   * New Agent：创建一段对话（chat 节点，意图词会自动激活 coding 场景 → create_agent_package 可见），
   * 预填首轮消息，由 Coding 对话引导确认 scenes/coreExclusions/skillPool 后调用 create_agent_package。
   */
  const handleCreateAgentSession = async () => {
    const agentName = name.trim();
    if (!agentName || creating) return;
    const use = prompt.trim();
    const lines = [
      'The user wants to create a dedicated sub-agent (you design and create it). Follow the create_agent_package tool contract:',
      `- name: ${agentName}`,
      use ? `- description: ${use}` : '- description: first use ask_user_questions to get a one-line statement of what this agent specializes in',
      agentRole.trim()
        ? `- role (boundaries, one per line):\n${agentRole.trim().split('\n').map((l) => `    - ${l.trim()}`).filter((l) => l.trim() !== '-').join('\n')}`
        : '',
      '',
      'Before creating, confirm three things with the user via ask_user_questions:',
      '1) Which fixedScenes to enable (suggest: General / Legal = pkulaw / Notes = notebook domain / Node / Butler);',
      '2) Whether coreExclusions should strip file / command / web kernel tools (typical for pure specialists);',
      '3) skillPool skills to install (optional).',
      'Then call create_agent_package and report the result — the agent will appear under the sidebar ＋ Add session menu and can be used right away.',
    ].join('\n');
    await createNode(`${agentName} · Agent`, lines);
  };

  /** Existing：为已装 agent 创建 Coding 对话，预填首轮消息让其调 update_agent_package 完成改造 */
  const handleUpdateAgentSession = async (agent: { id: string; label: string }) => {
    if (creating) return;
    const lines = [
      `The user wants to modify the installed sub-agent "${agent.label}" (id: ${agent.id}).`,
      'Call the update_agent_package tool — it must already be installed (agent.json exists).',
      '',
      'First use ask_user_questions to confirm with the user which of these they want to change:',
      '1) Scenes — addScenes / removeScenes (options: General / Legal = pkulaw / Notes = notebook / Node / Butler / core);',
      '2) Kernel tools — replace coreExclusions (typical: strip file / command / web tools, or clear to []);',
      '3) Skill pool — replace skillPool (or [] to fall back to global default);',
      '4) Persona — append short instructions to the existing prompt (preferred), or a full prompt rewrite if asked.',
      'Change ONLY what the user confirms; keep everything else untouched. After updating, run validate_agent_package to show the resolved profile and report the result.',
    ].join('\n');
    await createNode(`Update ${agent.label} · Agent`, lines);
  };

  return (
    <div
      data-canvas-ui="overlay"
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.18)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-2xl border p-5 shadow-2xl"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'var(--line)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* 标题栏 */}
        <div className="mb-4 flex items-center justify-between">
          <span className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--ink-strong)' }}>
            <Bot className="h-4 w-4" style={{ color: 'var(--primary)' }} />
            Sub-Agent
          </span>
          <Button
            type="button"
            onClick={onClose}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <p className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          Create a dedicated sub-agent you can chat with, or structurally modify an installed one —
          the AI confirms scenes and tools with you first.
        </p>

        {/* 档内：New Agent / Existing Agent */}
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--paper-soft)' }}>
          <button
            type="button"
            onClick={() => setMode('new')}
            className="flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              mode === 'new'
                ? { backgroundColor: 'var(--popover)', color: 'var(--primary)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <Plus className="h-3.5 w-3.5" />New Agent
          </button>
          <button
            type="button"
            onClick={() => setMode('existing')}
            className="flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              mode === 'existing'
                ? { backgroundColor: 'var(--popover)', color: 'var(--primary)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <Pencil className="h-3.5 w-3.5" />Existing Agent
          </button>
        </div>

        {mode === 'new' ? (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
              What is this agent called and what does it do?
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateAgentSession()}
              placeholder="Agent name (e.g. Contract Review Expert)"
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--primary)]"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
            />
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="One-liner purpose — what it helps the user do? (e.g. review contracts from the client side, flag risk clauses, suggest fixes. Scenes & tools are confirmed in the conversation.)"
              rows={3}
              className="mt-2 w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--primary)]"
              style={{
                borderColor: 'var(--line)',
                backgroundColor: 'var(--input-bg)',
                color: 'var(--ink)',
                fontFamily: 'var(--font-sans)',
                lineHeight: 1.6,
              }}
            />
            <div className="mt-2">
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Role / boundaries (optional)
              </div>
              <textarea
                value={agentRole}
                onChange={(e) => setAgentRole(e.target.value)}
                placeholder={'One item per line, e.g.:\n- Only review contracts; no general legal advice\n- Always grade risk and cite legal basis\n- Deliver a revision opinion file'}
                rows={3}
                className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--primary)]"
                style={{
                  borderColor: 'var(--line)',
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--font-sans)',
                  lineHeight: 1.6,
                }}
              />
            </div>
            <div className="mt-1.5 text-11 leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              On submit we open a Coding conversation: the AI first confirms scenes (Legal / Notes / General…) and whether to strip file & network kernel tools, then calls <span style={{ color: 'var(--primary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>create_agent_package</span>. The agent then appears under the sidebar ＋ Add session menu.
            </div>
            <Button
              type="button"
              onClick={handleCreateAgentSession}
              disabled={creating || !name.trim()}
              loading={creating}
              variant="solid"
              tone="brand"
              size="md"
              className="mt-2 w-full"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
              Start Conversation & Create Agent
            </Button>
          </div>
        ) : (
          /* ---- Existing: modify an installed agent via a Coding conversation (update_agent_package) ---- */
          <div className="max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
            <p className="mb-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              Which installed agent do you want to modify? Selecting one opens a Coding conversation that calls{' '}
              <span style={{ color: 'var(--primary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>update_agent_package</span> after confirming the changes.
            </p>
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--primary)' }} />
              </div>
            ) : installedAgents.length === 0 ? (
              <div
                className="rounded-lg border border-dashed px-3 py-4 text-center text-xs"
                style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}
              >
                No installed agents to modify yet — install one from Extensions Store → Agents, or use New Agent above.
              </div>
            ) : (
              installedAgents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={creating}
                  onClick={() => void handleUpdateAgentSession(a)}
                  className="flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_8%,transparent)] disabled:opacity-60"
                  style={{ borderColor: 'color-mix(in oklab, var(--primary) 40%, transparent)', backgroundColor: 'var(--popover)' }}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                    style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
                  >
                    <Bot className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" style={{ color: 'var(--ink-strong)' }}>{a.label}</span>
                    <span className="block font-mono text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>id: {a.id}</span>
                  </span>
                  <Pencil className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
