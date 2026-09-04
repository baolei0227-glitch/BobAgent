'use client';

// 引用来源面板（规格 v3 §九 引用与溯源 · 轻量版）
// 模型在回答末尾输出 <!-- CITATIONS --> JSON 块，前端剥离后渲染为可点击的引用列表
import { FileText, ShieldCheck, AlertTriangle } from 'lucide-react';

export interface Citation {
  id: number;
  node: string;
  block?: string;
  anchor?: string;
  preview?: string;
  /** locked = 上游成果块（已签字）；unverified = 实习生返回（未认定） */
  status?: string;
}

const CITATIONS_RE = /<!--\s*CITATIONS\s*-->\s*(\[[\s\S]*?\])\s*<!--\s*\/CITATIONS\s*-->/;

/** 从回答内容中剥离 citations 元数据块 */
export function parseCitations(content: string): { citations: Citation[]; cleanContent: string } {
  if (!content) return { citations: [], cleanContent: content };
  const m = CITATIONS_RE.exec(content);
  if (!m) return { citations: [], cleanContent: content };
  try {
    const citations = JSON.parse(m[1]) as Citation[];
    return { citations, cleanContent: content.replace(CITATIONS_RE, '').trim() };
  } catch {
    return { citations: [], cleanContent: content };
  }
}

interface CitationsPanelProps {
  citations: Citation[];
  /** 点击「查看完整节点」回调 */
  onOpenNode?: (nodeId: string) => void;
}

export function CitationsPanel({ citations, onOpenNode }: CitationsPanelProps) {
  if (!citations || citations.length === 0) return null;

  const unverifiedCount = citations.filter((c) => c.status === 'unverified').length;

  return (
    <div className="mt-2 w-full rounded-md border px-2.5 py-2"
      style={{ borderColor: 'color-mix(in oklab, var(--info) 14%, transparent)', backgroundColor: 'var(--popover)' }}
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--info)' }}>
        <FileText className="h-3 w-3" />
        <span>引用来源</span>
        {unverifiedCount > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-xs"
            style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)', color: 'var(--primary)' }}
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            {unverifiedCount} 条未认定
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {citations.map((c) => {
          const unverified = c.status === 'unverified';
          return (
            <button
              key={c.id}
              onClick={(e) => {
                e.stopPropagation();
                onOpenNode?.(c.node);
              }}
              className="flex items-start gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--info)_6%,transparent)]"
            >
              <span className="mt-px shrink-0 text-xs font-medium" style={{ color: 'var(--info)' }}>
                [{c.id}]
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs" style={{ color: 'var(--ink-strong)' }}>
                  {c.preview || `节点 ${c.node}`}
                </span>
                <span className="block truncate text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                  {c.node}{c.block ? ` · ${c.block}` : ''}{c.anchor ? ` · #${c.anchor}` : ''}
                </span>
              </span>
              {unverified ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-xs font-medium"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)', color: 'var(--primary)' }}
                  title="实习生返回的未认定内容，须标 [存疑] 或转入 pending"
                >
                  <AlertTriangle className="h-2.5 w-2.5" />
                  未认定
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-xs font-medium"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--success) 12%, transparent)', color: 'var(--success)' }}
                >
                  <ShieldCheck className="h-2.5 w-2.5" />
                  已锁定
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
