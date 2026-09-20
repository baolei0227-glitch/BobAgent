'use client';

// TeamMemberPickerDialog — 多智能体协作模式的成员选择弹窗。
// 点击对话节点工具条的「Multi-agent mode」按钮弹出：候选 = 已安装的 Agent 包（Extensions Store →
// Agents，GET /api/agents；滤掉内置画像与已禁用项），勾选后作为**本次执行**的成员名单（presetAgentIds）。
//
// 名单不落盘（每次重选）：只随当次 /api/chat 请求发送，不写 frontmatter；multi-agent 开关本身仍
// 持久化（frontmatter multi_agent_mode）。AI 若判断名单内人手不够而补充名单外成员，由服务端强制
// 弹确认卡请用户批准（见 lib/chat/team-run.ts 门禁）——本弹窗只管「用户预设名单」这一半。
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { listAgents } from '@/lib/agents/profiles';

interface AgentOption {
  id: string;
  label: string;
}

export default function TeamMemberPickerDialog({
  selected,
  modeOn,
  willLaunch,
  onCancel,
  onConfirm,
  onDisable,
}: {
  /** 当前会话已选中的 agent id（重开弹窗时回显；空 = 未预设成员） */
  selected: string[];
  /** Multi-agent mode 当前是否已开启（已开启才显示 Turn off） */
  modeOn: boolean;
  /** 输入框已有需求文本：Start 即用本轮名单发起该需求（选完即发起）；否则本轮只设名单 */
  willLaunch: boolean;
  onCancel: () => void;
  /** 确认：入参为本轮成员名单（可为空 = 不预设成员，由主 agent 编排后弹卡请用户批准） */
  onConfirm: (ids: string[]) => void;
  /** 关闭多智能体模式（仅 modeOn 时可用） */
  onDisable: () => void;
}) {
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected));

  // 候选名单：与画布「＋ Add session」菜单（marketAgents）同一数据源、同一过滤口径
  useEffect(() => {
    let alive = true;
    fetch('/api/agents')
      .then((r) => r.json())
      .then((d: { agents?: Array<{ id?: string; label?: string }>; disabled?: string[] }) => {
        if (!alive) return;
        const builtin = new Set(listAgents().map((a) => a.id));
        const disabled = new Set(d?.disabled || []);
        const list: AgentOption[] = [];
        for (const a of d?.agents ?? []) {
          if (a && typeof a.id === 'string' && !builtin.has(a.id) && !disabled.has(a.id)) {
            list.push({ id: a.id, label: a.label ?? a.id });
          }
        }
        setAgents(list);
      })
      .catch(() => {
        if (alive) setAgents([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onCancel}
    >
      <div
        className="w-[420px] max-w-full rounded-2xl border p-4 shadow-2xl"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
          fontFamily: 'var(--font-sans)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              Multi-agent mode
            </div>
          </div>
          <Button type="button" onClick={onCancel} variant="ghost" tone="neutral" size="icon-sm" aria-label="Close">
            ✕
          </Button>
        </div>

        <div
          className="max-h-[280px] overflow-y-auto rounded-lg border"
          style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}
        >
          {agents === null ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading agents…
            </div>
          ) : agents.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              No agent packages installed yet.
              <br />
              You can still start — the main agent plans the members and asks you to approve them first.
            </div>
          ) : (
            agents.map((a) => {
              const on = checked.has(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggle(a.id)}
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--paper-soft)]"
                >
                  <span
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-xs"
                    style={{
                      backgroundColor: on ? 'var(--info)' : 'transparent',
                      borderColor: on ? 'var(--info)' : 'var(--ink-faint)',
                      color: '#fff',
                    }}
                  >
                    {on && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <Bot className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                  <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink)' }}>
                    {a.label}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          {modeOn ? (
            <Button type="button" onClick={onDisable} variant="ghost" tone="danger" size="sm">
              Turn off
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button type="button" onClick={onCancel} variant="soft" tone="neutral" size="md">
              Cancel
            </Button>
            <Button type="button" onClick={() => onConfirm(Array.from(checked))} variant="solid" tone="brand" size="md">
              {willLaunch ? 'Start & Send' : 'Start'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
