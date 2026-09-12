'use client';

// ButlerConfirmModal — Butler 节点排程操作（创建/修改/删除）的可编辑确认卡片。
// 服务端发 butler_confirm 事件 → 本组件弹出表单（字段已按 AI 解析结果自动填写），
// 用户可修改后点确认；结果（含编辑后参数）POST /api/chat/confirm 回传，服务端再真正执行。
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

export type ButlerCard = {
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
  conflicts: { title: string; when: string }[];
};

export type ButlerConfirmState = {
  confirmId: string;
  name: string;
  card: ButlerCard;
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
}: {
  pending: ButlerConfirmState | null;
  /** 可选锚点（如对话输入框顶部中心）：传入时卡片锚定其上方且遮罩透明，否则视口居中 */
  anchor?: { x: number; y: number; w?: number } | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(60);
  const [allDay, setAllDay] = useState(false);
  const [reminder, setReminder] = useState(30);
  const [submitting, setSubmitting] = useState(false);

  // 每次新卡片重置表单（以卡片预填 = "自动填写"的结果）
  useEffect(() => {
    if (!pending) return;
    const c = pending.card;
    setTitle(c.title ?? '');
    setDate(c.date || todayStr());
    setStart(c.start || (c.mode === 'create' ? nextFullHour() : '09:00'));
    setDuration(diffMinutes(c.start, c.end));
    setAllDay(c.allDay);
    setReminder(c.reminderMinutes.length > 0 ? c.reminderMinutes[0] : 30);
    setSubmitting(false);
  }, [pending]);

  const card = pending?.card ?? null;
  const mode = card?.mode ?? 'create';

  const reminderOptions = useMemo(
    () => [
      { v: 0, label: 'No reminder' },
      { v: 10, label: '10 min before' },
      { v: 30, label: '30 min before' },
      { v: 60, label: '1 hour before' },
      { v: 1440, label: '1 day before' },
    ],
    [],
  );

  if (!pending || !card) return null;

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
      className="fixed inset-0 z-[90] flex items-center justify-center p-6"
      // 锚点模式（输入框上方弹出）：遮罩透明，不遮挡正文；仍拦截画布点击
      style={{ background: anchor ? 'transparent' : 'rgba(0,0,0,0.45)' }}
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
            <div className="mt-0.5 text-11 leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              AI parsed the following; review or edit before confirming.
              {pending.timeoutSec ? ` Auto-cancels if no action within ${Math.ceil(pending.timeoutSec / 60)} min.` : ''}
            </div>
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
            <div className="mt-1 text-11 opacity-80" style={{ color: 'var(--danger)' }}>
              After deletion: the event will be removed from your calendar; if it came from a note line, that line will be deleted too.
            </div>
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
                    {[15, 30, 45, 60, 90, 120].map((m) => (
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
            ⚠ Something is already scheduled around this time — please double-check:
            {card.conflicts.map((c, i) => (
              <div key={i}>
                · {c.title} ({c.when})
              </div>
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
