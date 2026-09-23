'use client';

/**
 * CheckReport — 导出前体检报告（方案 §6）。
 *
 * 只做展示：fail / warn / pass 三档，fail 不阻断导出（由调用方的确认策略决定）。
 * 复用 ExportDocxDialog 的暗色蒙层弹窗范式（见 WeChatArticleDialog）。
 */

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { summarizeChecks, type CheckItem, type CheckLevel } from '@/lib/md-export/check';

const LEVEL_STYLE: Record<CheckLevel, { color: string; icon: typeof CheckCircle2 }> = {
  fail: { color: '#D9534F', icon: XCircle },
  warn: { color: '#C77700', icon: AlertTriangle },
  pass: { color: '#3F9A5F', icon: CheckCircle2 },
};

const LEVEL_ORDER: Record<CheckLevel, number> = { fail: 0, warn: 1, pass: 2 };

export function CheckReport({ items, onLocate }: { items: CheckItem[]; onLocate?: (item: CheckItem) => void }) {
  if (!items.length) return null;
  const { fail, warn } = summarizeChecks(items);
  const sorted = [...items].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const summary = fail > 0
    ? `${fail} blocking issue${fail > 1 ? 's' : ''}${warn ? ` · ${warn} warning${warn > 1 ? 's' : ''}` : ''}`
    : warn > 0
      ? `${warn} warning${warn > 1 ? 's' : ''}`
      : 'All checks passed';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
          Pre-flight check
        </span>
        <span className="text-11" style={{ color: fail > 0 ? LEVEL_STYLE.fail.color : warn > 0 ? LEVEL_STYLE.warn.color : LEVEL_STYLE.pass.color }}>
          {summary}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {sorted.map((it) => {
          const { color, icon: Icon } = LEVEL_STYLE[it.level];
          const body = (
            <>
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color }} />
              <div className="min-w-0">
                <div className="text-11 leading-snug" style={{ color: 'var(--ink)' }}>{it.msg}</div>
                {it.fix && (
                  <div className="text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>{it.fix}</div>
                )}
              </div>
            </>
          );
          // 传了 onLocate 时整条可点（跳转到正文对应位置）
          return onLocate ? (
            <button
              key={it.key}
              type="button"
              onClick={() => onLocate(it)}
              className="flex items-start gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
              title="Jump to this location"
            >
              {body}
            </button>
          ) : (
            <div key={it.key} className="flex items-start gap-2">{body}</div>
          );
        })}
      </div>
    </div>
  );
}
