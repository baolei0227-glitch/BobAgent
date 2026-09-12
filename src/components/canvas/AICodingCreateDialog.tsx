'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Code2, Plus, FolderOpen, Loader2, Boxes, Lightbulb, FileText, Bot, Sparkles, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEFAULT_MODEL_ID } from '@/lib/types';

interface SandboxApp {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  entry: string;
}

interface SandboxTemplate {
  id: string;
  label: string;
  description: string;
  entry: string;
  /** 可选：每个模板自带的"灵感需求描述种子"，选模板时预填需求描述框（可选） */
  promptSeed?: { category: string; interaction: string; persistence: string };
}

interface CreatedNodePayload {
  nodeId: string;
  title: string;
  sandboxAppId?: string;
  appName?: string;
  /** 可选：用户在创建对话框里填写的初始需求，画布层需要先把它作为首轮 user 消息塞进节点 */
  initialPrompt?: string;
}

interface Props {
  open: boolean;
  /** 画布坐标（flow 坐标），创建节点时写入 frontmatter 便于重启恢复布局 */
  position: { x: number; y: number } | null;
  onClose: () => void;
  /** 创建成功回调，由画布层挂载节点并打开预览 */
  onCreated: (payload: CreatedNodePayload) => void;
}

/**
 * AI Coding 节点创建对话框（画布空白处右键 → AI Coding 节点触发）：
 *  - 新建项目：输入小程序名称 + 选模板，先建 sandbox app 再建绑定节点
 *  - 绑定已有：从现有小程序列表选择，创建绑定同一 app 的节点
 * AI Coding 节点创建时写入 frontmatter.sandbox_app_id，
 * 后端 /api/chat 会据此注入编程上下文（写入路径、截图自检闭环）。
 */
export function AICodingCreateDialog({ open, position, onClose, onCreated }: Props) {
  // 产物类型：mini = Bob Sandbox 小程序（原有）；agent = 创建专属子 Agent（经 Coding 对话确认后调 create_agent_package）
  const [kind, setKind] = useState<'mini' | 'agent'>('mini');
  // Sub-Agent 档内部：new = 新建（create_agent_package）；existing = 改造已装 agent（update_agent_package）
  const [agentMode, setAgentMode] = useState<'new' | 'existing'>('new');
  const [mode, setMode] = useState<'create' | 'bind'>('create');
  const [apps, setApps] = useState<SandboxApp[]>([]);
  const [templates, setTemplates] = useState<SandboxTemplate[]>([]);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('blank');
  const [prompt, setPrompt] = useState('');
  // Agent 档：补充人设/边界（可选）
  const [agentRole, setAgentRole] = useState('');
  // Existing 档：已装可改造 agent（市场安装的包；chat/coding 系统内置不可经包改）
  const [installedAgents, setInstalledAgents] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  /** 灵感卡片（推荐分类 + 对应模板 id，点击即选中并预填） */
  const INSPIRATIONS: { label: string; emoji: string; tplId: string; desc: string }[] = [
    { label: 'To-do List', emoji: '✅', tplId: 'todo', desc: 'Task manager, check off items, keep history' },
    { label: 'Habit Tracker', emoji: '🌱', tplId: 'habit', desc: 'Daily check-in, streak counting' },
    { label: 'Pomodoro', emoji: '🍅', tplId: 'pomodoro', desc: 'Focus timer, short/long breaks, daily stats' },
    { label: 'Contact Form', emoji: '📋', tplId: 'contact-form', desc: 'Lead capture, surveys, review past entries' },
    { label: 'Data Report', emoji: '📊', tplId: 'data-table', desc: 'KPI cards + table + progress bars' },
    { label: 'Portfolio', emoji: '👤', tplId: 'portfolio', desc: 'Intro, skills tags, links' },
    { label: 'Landing Page', emoji: '🚀', tplId: 'landing', desc: 'Headline + CTA + email capture' },
    { label: 'Doc Reader', emoji: '📖', tplId: 'reader', desc: 'Font/theme switch, progress bar, TOC' },
    { label: 'Unit Converter', emoji: '🔁', tplId: 'converter', desc: 'Length/weight/temp/area/volume' },
    { label: 'Calculator', emoji: '🧮', tplId: 'calculator', desc: 'Basic arithmetic with parentheses' },
    { label: 'AI Chat', emoji: '🤖', tplId: 'blank', desc: 'A mini-app that talks to an AI model' },
    { label: 'Free Build', emoji: '✨', tplId: 'blank', desc: 'Blank template — build anything' },
  ];

  const loadSandbox = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/sandbox');
      const data = await resp.json();
      if (data.success) {
        setApps(data.apps || []);
        setTemplates(data.templates || []);
      }
    } catch {
      setApps([]);
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInstalledAgents = useCallback(async () => {
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
    }
  }, []);

  // 打开时重置状态并预加载小程序清单与模板
  useEffect(() => {
    if (open) {
      setKind('mini');
      setAgentMode('new');
      setMode('create');
      setName('');
      setTemplate('blank');
      setPrompt('');
      setAgentRole('');
      loadSandbox();
      loadInstalledAgents();
    }
  }, [open, loadSandbox, loadInstalledAgents]);

  if (!open) return null;

  /** 创建绑定节点，成功后统一回调（Agent 造包会话不需要 sandbox_app_id） */
  const createNode = async (title: string, sandboxAppId?: string, appName = '', initialPromptText = '', nodeType = 'coding') => {
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
          node_type: nodeType,
          ...(position ? { position_x: position.x, position_y: position.y } : {}),
          ...(sandboxAppId ? { sandbox_app_id: sandboxAppId } : {}),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        onCreated({
          nodeId: data.node_id,
          title: data.title || title,
          sandboxAppId,
          appName,
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

  /** 新建小程序项目 → 创建 AI Coding 节点 */
  const handleCreateApp = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name: name.trim() || 'Untitled App', template }),
      });
      const data = await resp.json();
      if (data.success && data.app) {
        await createNode(data.app.name, data.app.id, data.app.name, prompt);
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  /**
   * Agent 档提交：创建一段对话（chat 节点，意图词会自动激活 coding 场景 → create_agent_package 可见），
   * 预填首轮消息，由 Coding 对话引导确认 scenes/coreExclusions/skillPool 后调用 create_agent_package 完成创建。
   */
  const handleCreateAgentSession = async () => {
    const agentName = name.trim();
    const use = prompt.trim();
    if (!agentName) return;
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
    await createNode(`${agentName} · Agent`, undefined, '', lines, 'chat');
  };

  /** Existing 档提交：为已装 agent 创建 Coding 对话，预填首轮消息让其调 update_agent_package 完成改造 */
  const handleUpdateAgentSession = async (agent: { id: string; label: string }) => {
    if (creating) return;
    const lines = [
      `The user wants to modify the installed sub-agent "${agent.label}" (id: ${agent.id}).`,
      'Call the update_agent_package tool — it must already be installed (agent.json exists).',
      '',
      'First use ask_user_questions to confirm with the user which of these they want to change:',
      '1) Scenes — addScenes / removeScenes (options: General / Legal = pkulaw / Notes = notebook / Node / Butler / wanted);',
      '2) Kernel tools — replace coreExclusions (typical: strip file / command / web tools, or clear to []);',
      '3) Skill pool — replace skillPool (or [] to fall back to global default);',
      '4) Persona — append short instructions to the existing prompt (preferred), or a full prompt rewrite if asked.',
      'Change ONLY what the user confirms; keep everything else untouched. After updating, run validate_agent_package to show the resolved profile and report the result.',
    ].join('\n');
    await createNode(`Update ${agent.label} · Agent`, undefined, '', lines, 'chat');
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
          fontFamily: "var(--font-sans)",
        }}
      >
        {/* 标题栏 */}
        <div className="mb-4 flex items-center justify-between">
          <span className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--ink-strong)' }}>
            <Code2 className="h-4 w-4" style={{ color: 'var(--info)' }} />
            AI Coding
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
          Choose what to build: a runnable mini-app, or a dedicated sub-agent you can chat with.
        </p>

        {/* Deliverable type: Mini App / Sub-Agent */}
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--paper-soft)' }}>
          <button
            type="button"
            onClick={() => setKind('mini')}
            className="flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              kind === 'mini'
                ? { backgroundColor: 'var(--popover)', color: 'var(--info)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <Boxes className="h-3.5 w-3.5" />Mini App
          </button>
          <button
            type="button"
            onClick={() => setKind('agent')}
            className="flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              kind === 'agent'
                ? { backgroundColor: 'var(--popover)', color: 'var(--primary)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <Bot className="h-3.5 w-3.5" />Sub-Agent
          </button>
        </div>

        {kind === 'agent' ? (
          /* ============ Sub-Agent lane: New (create_agent_package) / Existing (update_agent_package) ============ */
          <>
            {/* 档内：New Agent / Existing Agent */}
            <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--paper-soft)' }}>
              <button
                type="button"
                onClick={() => setAgentMode('new')}
                className="flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
                style={
                  agentMode === 'new'
                    ? { backgroundColor: 'var(--popover)', color: 'var(--primary)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                    : { color: 'var(--ink-muted)' }
                }
              >
                <Plus className="h-3.5 w-3.5" />New Agent
              </button>
              <button
                type="button"
                onClick={() => setAgentMode('existing')}
                className="flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
                style={
                  agentMode === 'existing'
                    ? { backgroundColor: 'var(--popover)', color: 'var(--primary)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                    : { color: 'var(--ink-muted)' }
                }
              >
                <Pencil className="h-3.5 w-3.5" />Existing Agent
              </button>
            </div>

            {agentMode === 'new' ? (
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
                {installedAgents.length === 0 ? (
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
            </>
        ) : (
          <>
            <p className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              Create or bind a Bob Sandbox mini-app — AI codes here with auto preview & self-check.
            </p>

        {/* 模式切换：新建项目 / 绑定已有 */}
        <div className="mb-3 flex gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--paper-soft)' }}>
          <button
            type="button"
            onClick={() => setMode('create')}
            className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              mode === 'create'
                ? { backgroundColor: 'var(--popover)', color: 'var(--info)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <Plus className="h-3.5 w-3.5" />
            New Project
          </button>
          <button
            type="button"
            onClick={() => setMode('bind')}
            className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              mode === 'bind'
                ? { backgroundColor: 'var(--popover)', color: 'var(--info)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Bind Existing
          </button>
        </div>

        {mode === 'create' ? (
          /* ---- 新建项目 ---- */
          <div>
            {/* 灵感卡片网格 */}
            <div className="mb-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                <Lightbulb className="h-3.5 w-3.5" style={{ color: 'var(--warn)' }} />
                I want to make… (pick a direction — template & request auto-fill)
              </div>
              <div
                className="grid max-h-[240px] grid-cols-2 gap-1.5 overflow-y-auto pr-0.5"
              >
                {INSPIRATIONS.map((ins) => {
                  const active = template === ins.tplId;
                  return (
                    <button
                      key={ins.label}
                      type="button"
                      onClick={() => {
                        setTemplate(ins.tplId);
                        if (!name) setName(ins.label);
                        // 预填需求描述（仅当 prompt 为空时，避免覆盖用户手写内容）
                        if (!prompt.trim()) {
                          setPrompt(
                            `Build a «${ins.label}» mini-app: ${ins.desc}.${
                              templates.find((t) => t.id === ins.tplId)?.promptSeed
                                ? `\n\nDesign preferences (AI will confirm via a design form on the first turn):\n- Feature category: ${templates.find((t) => t.id === ins.tplId)!.promptSeed!.category}\n- Interaction: ${templates.find((t) => t.id === ins.tplId)!.promptSeed!.interaction}\n- Data persistence: ${templates.find((t) => t.id === ins.tplId)!.promptSeed!.persistence}`
                                : ''
                            }`,
                          );
                        }
                      }}
                      className="flex items-start gap-2 rounded-lg border p-2 text-left transition-all hover:shadow-sm"
                      style={{
                        borderColor: active ? 'color-mix(in oklab, var(--info) 55%, transparent)' : 'var(--line)',
                        backgroundColor: active
                          ? 'color-mix(in oklab, var(--info) 7%, transparent)'
                          : 'var(--popover)',
                        boxShadow: active ? '0 1px 4px rgba(0,0,0,0.06)' : undefined,
                      }}
                    >
                      <span className="text-base leading-none">{ins.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-13 font-semibold"
                          style={{ color: 'var(--ink-strong)' }}
                        >
                          {ins.label}
                        </span>
                        <span
                          className="block truncate text-11"
                          style={{ color: 'var(--ink-muted)' }}
                        >
                          {ins.desc}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Basic fields: name + template dropdown (fallback when no inspiration chosen) */}
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>App name</span>
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateApp()}
              placeholder="Mini-app name (e.g. Contract Checker)"
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--info)]"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
            />
            <select
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="mt-2 w-full rounded-lg border px-2 py-2 text-xs outline-none"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
            >
              {templates.length === 0 ? (
                <option value="blank">Blank template</option>
              ) : (
                templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} — {t.description}
                  </option>
                ))
              )}
            </select>

            {/* 需求描述大文本框 */}
            <div className="mt-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                <FileText className="h-3.5 w-3.5" />
                Request (optional — skip to the design form)
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreateApp();
                }}
                placeholder='Tell me what you want in one go — e.g. "a tool that calculates overtime pay: input monthly salary and overtime hours, get the amount owed". After creation the AI will pop a design form to confirm.'
                rows={4}
                className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--info)]"
                style={{
                  borderColor: 'var(--line)',
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--font-sans)',
                  lineHeight: 1.6,
                }}
              />
              <div
                className="mt-1 flex items-center justify-between"
                style={{ color: 'var(--ink-muted)' }}
              >
                <span className="text-11">⌘/Ctrl + Enter to create · more detail = better first build</span>
                <span className="text-11">{prompt.length}/800</span>
              </div>
            </div>

            <Button
              type="button"
              onClick={handleCreateApp}
              disabled={creating}
              loading={creating}
              variant="solid"
              tone="info"
              size="md"
              className="mt-2 w-full"
            >
              {creating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Code2 className="h-3.5 w-3.5" />
                  Create Coding Node
                </>
              )}
            </Button>
          </div>
        ) : (
          /* ---- 绑定已有项目 ---- */
          <div className="max-h-[260px] overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--info)' }} />
              </div>
            ) : apps.length === 0 ? (
              <p className="py-4 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
                No mini-apps yet — switch to New Project to create one.
              </p>
            ) : (
              apps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => createNode(app.name, app.id, app.name)}
                  disabled={creating}
                  className="mb-1.5 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--info)_8%,transparent)] disabled:opacity-60"
                  style={{ borderColor: 'color-mix(in oklab, var(--info) 50%, transparent)', backgroundColor: 'var(--popover)' }}
                >
                  <Boxes className="h-4 w-4 shrink-0" style={{ color: 'var(--info)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" style={{ color: 'var(--ink-strong)' }}>
                      {app.name}
                    </span>
                    {app.description && (
                      <span className="block truncate text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                        {app.description}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
        </>
      )}
      </div>
    </div>
  );
}
