'use client';

// ButlerConfirmModal — Butler 节点排程操作（创建/修改/删除）的可编辑确认卡片。
// 服务端发 butler_confirm 事件 → 本组件弹出表单（字段已按 AI 解析结果自动填写），
// 用户可修改后点确认；结果（含编辑后参数）POST /api/chat/confirm 回传，服务端再真正执行。
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

export type ButlerCard = {
  /** 卡片判别式：排程卡（缺省）或规则草案卡 */
  kind?: 'schedule';
  tool: string;
  mode: 'create' | 'update' | 'delete';
  event_id: string | null;
  title: string;
  date: string; // YYYY-MM-DD（本地）
  start: string; // HH:MM
  end: string; // HH:MM（可空）
  allDay: boolean;
  reminderMinutes: number[];
  targetLabel: string;
  /** 同窗口已有安排（when 为 `09:00–11:00` 区间，跨日带日期） */
  conflicts: { title: string; when: string }[];
  /** 重叠命中总数（可选：旧载荷没有此字段时按 conflicts.length 处理） */
  conflictTotal?: number;
  /** 潜在风险（紧邻空档不足 / 相邻异地 / 同日全天）；text 为展示用英文文案（可选：旧载荷无此字段） */
  risks?: { kind: string; text: string }[];
  /** 净空替代时段标签（`Today 15:00–16:00`） */
  alternatives?: string[];
};

/** 规则草案卡（v6 §3.2「拟稿回显 → 确认」）：rule_create 命中「规则 + 全局」时弹出，approved 才落盘 */
export type RuleDraftCard = {
  kind: 'rule_draft';
  tool: string;
  name: string;
  intentRaw: string;
  steps: {
    kind: 'deterministic' | 'judgment';
    text: string;
    annex?: boolean;
    action?: 'create_todo' | 'create_scheduled_todo';
    actionParams?: { when?: string };
  }[];
  keywords: string[];
  /** 承诺级别：固定原词（必做到 / 基本做到） */
  commitment: string;
};

/** 技能草案卡（Phase 3 §3.5）：skill_draft 恒弹此卡，approved 才落 .skills/<id>.md */
export type SkillDraftCard = {
  kind: 'skill_draft';
  tool: string;
  /** ① 这技能要干什么（一句） */
  name: string;
  description: string;
  /** ② 什么时候会被自动调用（适用条件） */
  when: { keywords: string[]; scenes?: string[]; objectTypes?: string[]; preconditions?: string[] };
  runtime: 'compose' | 'script';
  steps: { primitive: string; text?: string; params?: Record<string, string> }[];
  /** ③ 它要什么权限（默认空 = 无额外权限） */
  grants: { fs?: string[]; net?: boolean; process?: boolean };
  /** ④ 会产生什么副作用（写文件 / 进日历 / 发消息） */
  effects: string[];
};

export type ButlerConfirmState = {
  confirmId: string;
  name: string;
  card: ButlerCard | RuleDraftCard | SkillDraftCard;
  timeoutSec?: number;
};

const pad = (n: number) => String(n).padStart(2, '0');

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 下一个整点时刻 HH:MM */
function nextFullHour(): string {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 本地 date + HH:MM（+ 偏移分钟）→ 带本地时区偏移的 ISO */
function toLocalIso(date: string, hhmm: string, addMin = 0): string {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10) || 0);
  const [y, mo, da] = date.split('-').map((x) => parseInt(x, 10));
  const d = new Date(y, mo - 1, da, h, m + addMin, 0, 0);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function diffMinutes(start: string, end: string): number {
  if (!start || !end) return 60;
  const [sh, sm] = start.split(':').map((x) => parseInt(x, 10));
  const [eh, em] = end.split(':').map((x) => parseInt(x, 10));
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 && diff <= 480 ? diff : 60;
}

/** 锚点定位：卡片在锚点上方居中（水平钳制视口；上方空间不足时改到下方显示；限高防溢出视口） */
/** 锚点定位：卡片在锚点上方居中且与输入框等宽（w 缺省回退 420；水平钳制在视口内；限高防溢出） */
function computeAnchorStyle(anchor: { x: number; y: number; w?: number }): CSSProperties {
  const cardW = anchor.w ?? 420;
  const vw = window.innerWidth;
  const left = Math.max(8, Math.min(anchor.x - cardW / 2, vw - cardW - 8));
  const showBelow = anchor.y < 460;
  return {
    position: 'fixed',
    left,
    width: cardW,
    top: showBelow ? anchor.y + 12 : anchor.y - 12,
    transform: showBelow ? undefined : 'translateY(-100%)',
    maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
  };
}

export function ButlerConfirmModal({
  pending,
  anchor,
  onClose,
  zIndex,
}: {
  pending: ButlerConfirmState | null;
  /** 可选锚点（如对话输入框顶部中心）：传入时卡片锚定其上方且遮罩透明，否则视口居中 */
  anchor?: { x: number; y: number; w?: number } | null;
  onClose: () => void;
  /** 层级（缺省 90 = 画布节点内使用）。Butler 抽屉（z-1320）等高层容器需传更大值，否则卡片被盖住 */
  zIndex?: number;
}) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(60);
  const [allDay, setAllDay] = useState(false);
  const [reminder, setReminder] = useState(30);
  const [submitting, setSubmitting] = useState(false);
  // 规则草案卡的可编辑字段（仅 kind==='rule_draft' 时使用）
  const [ruleName, setRuleName] = useState('');
  const [ruleIntent, setRuleIntent] = useState('');
  const [ruleSteps, setRuleSteps] = useState<RuleDraftCard['steps']>([]);
  const [ruleKeywords, setRuleKeywords] = useState('');
  // 技能草案卡的可编辑字段（仅 kind==='skill_draft' 时使用）
  const [skillName, setSkillName] = useState('');
  const [skillDescription, setSkillDescription] = useState('');
  const [skillKeywords, setSkillKeywords] = useState('');

  // 每次新卡片重置表单（以卡片预填 = "自动填写"的结果）
  useEffect(() => {
    if (!pending) return;
    const c = pending.card;
    if (c.kind === 'skill_draft') {
      setSkillName(c.name);
      setSkillDescription(c.description);
      setSkillKeywords(c.when.keywords.join(', '));
      setSubmitting(false);
      return;
    }
    if (c.kind === 'rule_draft') {
      setRuleName(c.name);
      setRuleIntent(c.intentRaw);
      setRuleSteps(c.steps);
      setRuleKeywords(c.keywords.join(', '));
      setSubmitting(false);
      return;
    }
    setTitle(c.title ?? '');
    setDate(c.date || todayStr());
    setStart(c.start || (c.mode === 'create' ? nextFullHour() : '09:00'));
    setDuration(diffMinutes(c.start, c.end));
    setAllDay(c.allDay);
    setReminder(c.reminderMinutes.length > 0 ? c.reminderMinutes[0] : 30);
    setSubmitting(false);
  }, [pending]);

  const card = pending?.card ?? null;

  // 提醒档位：固定常用档 + 当前值（AI 可能解析出非档位值，如「提前 5 分钟」→ 5，需可显示/可保留）
  const reminderOptions = useMemo(
    () =>
      [...new Set([0, 10, 30, 60, 1440, reminder])]
        .filter((v) => v >= 0)
        .sort((a, b) => a - b)
        .map((v) => ({
          v,
          label:
            v === 0
              ? 'No reminder'
              : v === 60
                ? '1 hour before'
                : v === 1440
                  ? '1 day before'
                  : v % 60 === 0
                    ? `${v / 60} hours before`
                    : `${v} min before`,
        })),
    [reminder],
  );

  if (!pending || !card) return null;

  // 规则草案卡：渲染可编辑草案表单（name / 原话 / steps / 触发词 + 承诺级别固定原词）
  if (card.kind === 'rule_draft') {
    const submitDraft = async (approved: boolean) => {
      setSubmitting(true);
      let edited: Record<string, unknown> | undefined;
      if (approved) {
        const name = ruleName.trim();
        const intent = ruleIntent.trim();
        const steps = ruleSteps
          .map((s) => ({
            kind: s.kind,
            text: s.text.trim(),
            ...(s.annex ? { annex: true } : {}),
            ...(s.action ? { action: s.action } : {}),
            ...(s.actionParams?.when ? { action_params: { when: s.actionParams.when } } : {}),
          }))
          .filter((s) => s.text);
        const keywords = ruleKeywords.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
        if (!name || !intent || steps.length === 0) {
          setSubmitting(false);
          return;
        }
        edited = { toolArgs: { name, intent_raw: intent, steps, keywords } };
      }
      try {
        await fetch('/api/chat/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmId: pending.confirmId, approved, edited }),
        });
      } catch {
        /* 回传失败：服务端超时按未落盘处理 */
      }
      setSubmitting(false);
      onClose();
    };
    return createPortal(
      <div
        className="fixed inset-0 flex items-center justify-center p-6"
        style={{ zIndex: zIndex ?? 90, background: anchor ? 'transparent' : 'rgba(0,0,0,0.45)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="w-[420px] max-w-full rounded-2xl border p-4 shadow-2xl"
          style={{
            backgroundColor: 'var(--popover)',
            borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
            fontFamily: 'var(--font-sans)',
            ...(anchor ? computeAnchorStyle(anchor) : {}),
          }}
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                New rule draft
                {pending.name && <span className="ml-1 text-10 font-normal opacity-60">via {pending.name}</span>}
              </div>
              {pending.timeoutSec ? (
                <div className="mt-0.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                  {`Auto-cancels in ${Math.ceil(pending.timeoutSec / 60)} min`}
                </div>
              ) : null}
            </div>
            <Button type="button" onClick={() => submitDraft(false)} variant="ghost" tone="neutral" size="icon-sm" aria-label="Close">
              ✕
            </Button>
          </div>

          <div className="space-y-2.5">
            <div>
              <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Name</label>
              <input
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                className="w-full rounded-lg border px-2.5 py-1.5 text-sm outline-none"
                style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
              />
            </div>
            <div>
              <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Original words</label>
              <textarea
                value={ruleIntent}
                onChange={(e) => setRuleIntent(e.target.value)}
                rows={2}
                className="w-full resize-none rounded-lg border px-2.5 py-1.5 text-xs outline-none"
                style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
              />
            </div>
            <div>
              <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Steps</label>
              <div className="space-y-1.5">
                {ruleSteps.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-10"
                      style={{ backgroundColor: 'var(--paper)', color: 'var(--ink-muted)', border: '1px solid color-mix(in oklab, var(--line) 60%, transparent)' }}
                    >
                      {s.kind === 'judgment' ? 'judgment' : (s.action ?? 'deterministic')}
                    </span>
                    <input
                      value={s.text}
                      onChange={(e) => setRuleSteps((prev) => prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                      className="w-full rounded-lg border px-2 py-1 text-xs outline-none"
                      style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Trigger keywords</label>
              <input
                value={ruleKeywords}
                onChange={(e) => setRuleKeywords(e.target.value)}
                placeholder="comma separated"
                className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
                style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
              />
            </div>
          </div>

          <div
            className="mt-3 rounded-lg border p-2 text-11 leading-relaxed"
            style={{
              borderColor: 'color-mix(in oklab, var(--line) 50%, transparent)',
              backgroundColor: 'var(--paper)',
              color: 'var(--ink-muted)',
            }}
          >
            Commitment: <b style={{ color: 'var(--ink)' }}>{card.commitment}</b>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" onClick={() => submitDraft(false)} disabled={submitting} variant="soft" tone="neutral" size="sm">
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => submitDraft(true)}
              disabled={submitting || !ruleName.trim() || !ruleIntent.trim()}
              loading={submitting}
              variant="solid"
              tone="brand"
              size="sm"
            >
              {submitting ? 'Submitting…' : 'Confirm create'}
            </Button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  // 技能草案卡：让用户看懂 4 件事 —— 要干什么 / 何时调用 / 要什么权限 / 有什么副作用
  if (card.kind === 'skill_draft') {
    const grantsText = (() => {
      const g = card.grants;
      const parts: string[] = [];
      if (g.fs && g.fs.length > 0) parts.push(`Files: ${g.fs.join(', ')}`);
      if (g.net) parts.push('Network');
      if (g.process) parts.push('Subprocess');
      return parts.length > 0 ? parts.join(' · ') : 'No extra permissions';
    })();
    const whenExtras = [
      card.when.scenes?.length ? `Scenes: ${card.when.scenes.join(', ')}` : '',
      card.when.objectTypes?.length ? `Objects: ${card.when.objectTypes.join(', ')}` : '',
      card.when.preconditions?.length ? `Preconditions: ${card.when.preconditions.join(', ')}` : '',
    ].filter(Boolean);
    const readonlyBox: CSSProperties = {
      borderColor: 'color-mix(in oklab, var(--line) 50%, transparent)',
      backgroundColor: 'var(--paper)',
      color: 'var(--ink-muted)',
    };

    const submitSkill = async (approved: boolean) => {
      setSubmitting(true);
      let edited: Record<string, unknown> | undefined;
      if (approved) {
        const name = skillName.trim();
        const description = skillDescription.trim();
        if (!name || !description) {
          setSubmitting(false);
          return;
        }
        const keywords = skillKeywords.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
        edited = {
          toolArgs: {
            name,
            description,
            when: {
              keywords,
              ...(card.when.scenes ? { scenes: card.when.scenes } : {}),
              ...(card.when.objectTypes ? { object_types: card.when.objectTypes } : {}),
              ...(card.when.preconditions ? { preconditions: card.when.preconditions } : {}),
            },
            runtime: card.runtime,
            steps: card.steps,
            grants: card.grants,
            effects: card.effects,
          },
        };
      }
      try {
        await fetch('/api/chat/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmId: pending.confirmId, approved, edited }),
        });
      } catch {
        /* 回传失败：服务端超时按未落盘处理 */
      }
      setSubmitting(false);
      onClose();
    };

    return createPortal(
      <div
        className="fixed inset-0 flex items-center justify-center p-6"
        style={{ zIndex: zIndex ?? 90, background: anchor ? 'transparent' : 'rgba(0,0,0,0.45)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="w-[420px] max-w-full rounded-2xl border p-4 shadow-2xl"
          style={{
            backgroundColor: 'var(--popover)',
            borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
            fontFamily: 'var(--font-sans)',
            ...(anchor ? computeAnchorStyle(anchor) : {}),
          }}
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                New skill draft
                {pending.name && <span className="ml-1 text-10 font-normal opacity-60">via {pending.name}</span>}
              </div>
              {pending.timeoutSec ? (
                <div className="mt-0.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                  {`Auto-cancels in ${Math.ceil(pending.timeoutSec / 60)} min`}
                </div>
              ) : null}
            </div>
            <Button type="button" onClick={() => submitSkill(false)} variant="ghost" tone="neutral" size="icon-sm" aria-label="Close">
              ✕
            </Button>
          </div>

          <div className="space-y-2.5">
            <div>
              <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Name</label>
              <input
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
                className="w-full rounded-lg border px-2.5 py-1.5 text-sm outline-none"
                style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
              />
            </div>
            <div>
              <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>What it does</label>
              <textarea
                value={skillDescription}
                onChange={(e) => setSkillDescription(e.target.value)}
                rows={2}
                className="w-full resize-none rounded-lg border px-2.5 py-1.5 text-xs outline-none"
                style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
              />
            </div>
            <div>
              <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Trigger keywords</label>
              <input
                value={skillKeywords}
                onChange={(e) => setSkillKeywords(e.target.value)}
                placeholder="comma separated"
                className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
                style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
              />
              {whenExtras.length > 0 && (
                <div className="mt-1 text-11" style={{ color: 'var(--ink-muted)' }}>{whenExtras.join(' · ')}</div>
              )}
            </div>
          </div>

          <div className="mt-3 space-y-1.5 rounded-lg border p-2 text-11 leading-relaxed" style={readonlyBox}>
            <div>Permissions: <b style={{ color: 'var(--ink)' }}>{grantsText}</b></div>
            <div>Side effects: <b style={{ color: 'var(--ink)' }}>{card.effects.join(' · ')}</b></div>
            {card.steps.length > 0 && (
              <div>
                Steps:
                {card.steps.map((s, i) => (
                  <div key={i}>· <span style={{ color: 'var(--ink)' }}>{s.primitive}</span>{s.text ? ` — ${s.text}` : ''}</div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" onClick={() => submitSkill(false)} disabled={submitting} variant="soft" tone="neutral" size="sm">
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => submitSkill(true)}
              disabled={submitting || !skillName.trim() || !skillDescription.trim()}
              loading={submitting}
              variant="solid"
              tone="brand"
              size="sm"
            >
              {submitting ? 'Submitting…' : 'Confirm create'}
            </Button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const mode = card.mode;

  // 风险区标题按类型取词：note_link（删日程会连带删便签行）与时段类风险（紧邻/异地/全天）措辞不同
  const riskKinds = new Set((card.risks ?? []).map((r) => r.kind));
  const riskLabel = riskKinds.size === 1 && riskKinds.has('note_link') ? '⚠ Note:' : '⚠ Tight fit:';

  const submit = async (approved: boolean) => {
    setSubmitting(true);
    let edited: Record<string, unknown> | undefined;
    if (approved) {
      let toolArgs: Record<string, unknown>;
      if (mode === 'delete') {
        toolArgs = { event_id: card.event_id ?? '' };
      } else if (mode === 'update') {
        toolArgs = { event_id: card.event_id ?? '' } as Record<string, unknown>;
        if (title.trim()) toolArgs.title = title.trim();
        toolArgs.all_day = allDay;
        toolArgs.reminder_minutes = allDay ? [] : reminder > 0 ? [reminder] : [];
        if (!allDay) {
          if (date) toolArgs.start_time = toLocalIso(date, start || '09:00');
          toolArgs.end_time = date ? toLocalIso(date, start || '09:00', duration) : undefined;
        } else if (date) {
          toolArgs.start_time = toLocalIso(date, '00:00');
        }
        if (!date) {
          delete toolArgs.start_time;
          delete toolArgs.end_time;
        }
      } else {
        toolArgs = { title: title.trim(), all_day: allDay };
        if (allDay) {
          if (date) toolArgs.start_time = toLocalIso(date, '00:00');
        } else {
          toolArgs.start_time = date ? toLocalIso(date, start || '09:00') : undefined;
          toolArgs.end_time = date ? toLocalIso(date, start || '09:00', duration) : undefined;
        }
        toolArgs.reminder_minutes = allDay ? [] : reminder > 0 ? [reminder] : [];
        if (!title.trim()) return; // 标题必填
      }
      edited = { toolArgs };
    }
    try {
      await fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmId: pending.confirmId, approved, edited }),
      });
    } catch {
      /* 回传失败：服务端超时按未执行处理 */
    }
    setSubmitting(false);
    onClose();
  };

  const label = mode === 'create' ? 'Confirm create' : mode === 'update' ? 'Confirm update' : 'Confirm delete';

  // React Flow 节点 wrapper 带 transform → 用 portal 挂到 body，避免 fixed 定位被祖先扭曲
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-6"
      // 锚点模式（输入框上方弹出）：遮罩透明，不遮挡正文；仍拦截画布点击
      style={{ zIndex: zIndex ?? 90, background: anchor ? 'transparent' : 'rgba(0,0,0,0.45)' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-[420px] max-w-full rounded-2xl border p-4 shadow-2xl"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
          fontFamily: 'var(--font-sans)',
          ...(anchor ? computeAnchorStyle(anchor) : {}),
        }}
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              {mode === 'delete' ? 'Delete task' : mode === 'update' ? 'Update task' : 'Create schedule'}
              {pending.name && (
                <span className="ml-1 text-10 font-normal opacity-60">via {pending.name}</span>
              )}
            </div>
            {pending.timeoutSec ? (
              <div className="mt-0.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                {`Auto-cancels in ${Math.ceil(pending.timeoutSec / 60)} min`}
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            onClick={() => submit(false)}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            aria-label="Close"
          >
            ✕
          </Button>
        </div>

        {mode === 'delete' ? (
          <div className="mb-3 rounded-lg border p-3 text-sm" style={{ borderColor: 'color-mix(in oklab, var(--danger) 40%, transparent)', backgroundColor: 'color-mix(in oklab, var(--danger) 8%, transparent)' }}>
            <div style={{ color: 'var(--ink)' }}>{card.title || card.targetLabel}</div>
            {(card.date || card.start) && (
              <div className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                {card.date ? `${card.date}${card.start ? ` ${card.start}` : ''}` : ''}
                {card.allDay ? ' · All day' : ''}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            <div>
              <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
                Title
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                className="w-full rounded-lg border px-2.5 py-1.5 text-sm outline-none"
                style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink)' }}>
                <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
                All day
              </label>
            </div>
            {!allDay && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Date</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
                    style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Start</label>
                  <input
                    type="time"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    className="w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
                    style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Duration</label>
                  <select
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                    className="w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
                    style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                  >
                    {[...new Set([15, 30, 45, 60, 90, 120, duration].filter((m) => m > 0))]
                      .sort((a, b) => a - b)
                      .map((m) => (
                        <option key={m} value={m}>{m} min</option>
                      ))}
                  </select>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Reminder</label>
                <select
                  value={reminder}
                  onChange={(e) => setReminder(Number(e.target.value))}
                  className="w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--paper)', color: 'var(--ink)' }}
                >
                  {reminderOptions.map((o) => (
                    <option key={o.v} value={o.v}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {card.conflicts.length > 0 && (
          <div
            className="mt-3 rounded-lg border p-2 text-11 leading-relaxed"
            style={{
              borderColor: 'color-mix(in oklab, var(--warn) 50%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--warn) 10%, transparent)',
              color: 'var(--warn-ink, #8a6d1d)',
            }}
          >
            ⚠ Conflicts
            {(() => {
              const total = card.conflictTotal ?? card.conflicts.length;
              return total > card.conflicts.length
                ? ` (${card.conflicts.length}/${total}):`
                : ':';
            })()}
            {card.conflicts.map((c, i) => (
              <div key={i}>
                · {c.when} — {c.title}
              </div>
            ))}
          </div>
        )}

        {(card.risks ?? []).length > 0 && (
          <div
            className="mt-3 rounded-lg border p-2 text-11 leading-relaxed"
            style={{
              borderColor: 'color-mix(in oklab, var(--warn) 50%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--warn) 6%, transparent)',
              color: 'var(--warn-ink, #8a6d1d)',
            }}
          >
            {riskLabel}
            {(card.risks ?? []).map((r, i) => (
              <div key={i}>· {r.text}</div>
            ))}
          </div>
        )}

        {(card.alternatives ?? []).length > 0 && (
          <div
            className="mt-3 rounded-lg border p-2 text-11 leading-relaxed"
            style={{
              borderColor: 'color-mix(in oklab, var(--line) 50%, transparent)',
              backgroundColor: 'var(--paper)',
              color: 'var(--ink-muted)',
            }}
          >
            Free slots:
            {(card.alternatives ?? []).map((a, i) => (
              <div key={i}>· {a}</div>
            ))}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            onClick={() => submit(false)}
            disabled={submitting}
            variant="soft"
            tone="neutral"
            size="sm"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => submit(true)}
            disabled={submitting || (mode !== 'delete' && !title.trim())}
            loading={submitting}
            variant="solid"
            tone={mode === 'delete' ? 'danger' : 'brand'}
            size="sm"
          >
            {submitting ? 'Submitting…' : label}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
