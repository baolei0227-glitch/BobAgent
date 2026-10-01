/**
 * ContextMeter — dsh 上下文占用环
 *
 * AI 回复末尾动作行最右侧 14px 占用圆环：按 系统/工具/对话 分组展示当前上下文占用，
 * 点击弹出明细（分组 token 数 + 容量进度条）。接近上限（≥80%）变黄、≥95% 变红预警。
 *
 * 数据来源：服务端 /api/chat SSE 事件 `context_meter`（任务开始时下发一次 + done 时下发最终状态）。
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface CtxMeterInfo {
  system: number;
  tools: number;
  conversation: number;
  capacity: number;
}

/** token 数格式化：≥1000 显示 k（如 128k / 1.2M） */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function meterColor(pct: number): string {
  if (pct >= 95) return 'var(--danger)';
  if (pct >= 80) return 'var(--warn)';
  if (pct >= 60) return 'oklch(0.72 0.16 85)';
  return 'var(--info)';
}

export function ContextMeter({ meter }: { meter: CtxMeterInfo | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const total = meter ? meter.system + meter.tools + meter.conversation : 0;
  const capacity = meter?.capacity || 1_000_000;
  const pct = meter ? Math.min(100, Math.max(0, (total / capacity) * 100)) : 0;
  const color = meter ? meterColor(pct) : 'color-mix(in oklab, var(--ink-muted) 40%, transparent)';
  const R = 6.5;
  const CIRC = 2 * Math.PI * R;

  // 点击外部关闭明细弹窗
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative flex shrink-0 items-center">
      {/* 环形计量器 = 自绘 SVG 特殊控件，豁免迁移 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_80%,transparent)]"
        title={
          meter
            ? `Context ${pct.toFixed(0)}% (${fmtTokens(total)} / ${fmtTokens(capacity)} tokens) — click for breakdown`
            : 'Context usage — will show after the first message'
        }
      >
        <svg width="15" height="15" viewBox="0 0 16 16" className="shrink-0">
          <circle cx="8" cy="8" r={R} fill="none" stroke="color-mix(in oklab, var(--line) 60%, transparent)" strokeWidth="1.6" />
          <circle
            cx="8" cy="8" r={R} fill="none"
            stroke={meter ? color : 'transparent'}
            strokeWidth="1.6" strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={meter ? CIRC * (1 - pct / 100) : CIRC}
            transform="rotate(-90 8 8)"
            style={{ transition: 'stroke-dashoffset 400ms ease, stroke 200ms ease' }}
          />
        </svg>
      </button>

      {open && meter && (
        <div
          className="absolute bottom-full right-0 z-50 mb-1.5 w-60 rounded-xl border p-3 shadow-lg"
          style={{
            borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'var(--popover)',
            animation: 'fade-in 120ms ease-out',
          }}
        >
          {/* 头部 */}
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>
              Context usage
            </span>
            <Button
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              onClick={() => setOpen(false)}
              aria-label="关闭明细"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* 占用率 + 进度条 */}
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
              {fmtTokens(total)} / {fmtTokens(capacity)} tokens
            </span>
            <span className="text-sm font-bold" style={{ color }}>
              {pct.toFixed(0)}%
            </span>
          </div>
          <div
            className="mb-2.5 h-1 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: 'color-mix(in oklab, var(--line) 50%, transparent)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${pct}%`,
                backgroundColor: color,
                transition: 'width 400ms ease',
              }}
            />
          </div>

          {/* 分组明细 */}
          {[
            { label: 'System', value: meter.system, hint: 'system prompt + skills' },
            { label: 'Tools', value: meter.tools, hint: 'tool schemas' },
            { label: 'Conversation', value: meter.conversation, hint: 'messages + tool results' },
          ].map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between rounded-md px-1.5 py-1"
              title={row.hint}
            >
              <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>{row.label}</span>
              <span className="text-xs font-medium tabular-nums" style={{ color: 'var(--ink)' }}>
                {fmtTokens(row.value)}
              </span>
            </div>
          ))}

          <div className="mt-2 border-t pt-1.5" style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}>
            <span className="text-10 leading-tight" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
              Character-based estimate · updates after each task
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
