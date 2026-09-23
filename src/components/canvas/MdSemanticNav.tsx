'use client';

// MD 语义导航：按主题检索条款（AI 单次分块定位，见 /api/md-navigate）。
// 与关键词查找互补 —— 「涉及赔偿的条款」这类主题查询，靠子串匹配结构上够不到。
// 本组件只负责检索这一段：输入、结果列表、加载/空态/错误态；跳转与高亮交回 DocEditor。

import { useState } from 'react';
import { Loader2, Search, CornerDownRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface NavMatch {
  index: number;
  heading: string;
  quote: string;
  reason: string;
}

interface MdSemanticNavProps {
  /** 当前文档 markdown（每次检索取最新全文） */
  md: string;
  /** 跳转并高亮命中片段；返回是否成功定位（false → 组件内提示未找到） */
  onJump: (quote: string) => boolean;
}

export function MdSemanticNav({ md, onJump }: MdSemanticNavProps) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [matches, setMatches] = useState<NavMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 送模型的块被截断（长文档只取前 N 块）→ 提示结果可能不完整 */
  const [truncated, setTruncated] = useState(false);
  /** 点击结果但正文里已找不到该片段（文档改动过） */
  const [jumpFailed, setJumpFailed] = useState<string | null>(null);

  const run = async () => {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setMatches(null);
    setTruncated(false);
    setJumpFailed(null);
    try {
      const resp = await fetch('/api/md-navigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md, query: q }),
      });
      const data = (await resp.json()) as {
        success?: boolean;
        matches?: NavMatch[];
        truncated?: boolean;
        error?: string;
      };
      if (!data.success) {
        setError(data.error || 'Request failed');
        return;
      }
      setMatches(data.matches ?? []);
      setTruncated(!!data.truncated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ backgroundColor: 'var(--paper-soft)' }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void run(); }
          }}
          placeholder="Ask: which clauses involve…"
          className="h-7 w-80 rounded-lg border bg-transparent px-2.5 text-13 outline-none"
          style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
        />
        <Button
          type="button"
          onClick={() => void run()}
          disabled={loading || !query.trim()}
          variant="soft"
          tone="neutral"
          size="sm"
          title="Search by topic (Enter)"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {loading ? 'Searching…' : 'Search'}
        </Button>
        {loading && (
          <span className="text-11" style={{ color: 'var(--ink-faint)' }}>Reading the document…</span>
        )}
      </div>

      {error && (
        <div className="px-3 pb-2 text-11 leading-relaxed" style={{ color: 'var(--danger)' }}>{error}</div>
      )}

      {matches && matches.length === 0 && (
        <div className="px-3 pb-2 text-11 leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
          No clause matches “{query.trim()}”. Try a different topic.
        </div>
      )}

      {matches && matches.length > 0 && (
        <div className="max-h-64 overflow-y-auto ai-canvas-scroll px-3 pb-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-10 font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
              {matches.length} matching clause{matches.length > 1 ? 's' : ''}
            </span>
            {truncated && (
              <span className="text-10" style={{ color: 'var(--warn)' }}>Long document — first blocks only</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            {matches.map((m) => (
              <button
                key={`${m.index}-${m.quote.slice(0, 12)}`}
                type="button"
                onClick={() => {
                  setJumpFailed(onJump(m.quote) ? null : m.quote);
                }}
                className="rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
                style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)' }}
                title="Click to jump to this clause"
              >
                {m.heading && (
                  <span className="mb-0.5 flex items-center gap-1 text-10 font-medium" style={{ color: 'var(--primary)' }}>
                    <CornerDownRight className="h-2.5 w-2.5" />
                    {m.heading}
                  </span>
                )}
                <span className="block text-11 leading-snug" style={{ color: 'var(--ink)' }}>
                  {m.quote.length > 90 ? `${m.quote.slice(0, 90)}…` : m.quote}
                </span>
                {m.reason && (
                  <span className="mt-0.5 block text-10 leading-snug" style={{ color: 'var(--ink-muted)' }}>{m.reason}</span>
                )}
              </button>
            ))}
          </div>
          {jumpFailed && (
            <div className="mt-1 text-10" style={{ color: 'var(--danger)' }}>
              Could not locate “{jumpFailed.slice(0, 30)}…” in the current text (it may have been edited).
            </div>
          )}
        </div>
      )}
    </div>
  );
}
