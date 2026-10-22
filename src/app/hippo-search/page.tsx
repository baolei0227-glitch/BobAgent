'use client';

/**
 * Hippo AI Search 页面（Perplexity 式）。
 *
 * 入口：
 *  - 新标签页的搜索框 → /hippo-search?q=…
 *  - 工具栏放大镜按钮 → /hippo-search
 *
 * 链路：本页 POST /api/hippo-search（SSE）→ 服务端搜索 + 抓 Top5 正文 + 流式作答。
 * 页面只负责渲染：正文里的编号引用 [1] 与来源卡一一对应，链接一律新标签
 * （Hippo 标签的 setWindowOpenHandler 会把它收编成 Hippo 新标签页）。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, ExternalLink, Globe, Loader2, RotateCw, Search } from 'lucide-react';

interface SearchSource {
  index: number;
  title: string;
  url: string;
  siteName: string | null;
  snippet: string;
}

type Phase = 'searching' | 'reading' | 'writing';

interface Turn {
  question: string;
  answer: string;
  sources: SearchSource[];
  phase: Phase;
  /** 已完成 / 失败：done=true 时 phase 无意义 */
  done: boolean;
  error?: string;
  /** 引用编号越界检查结果（仅异常时下发） */
  audit?: { invalid: number[] };
}

const PHASE_LABEL: Record<Phase, string> = {
  searching: 'Searching the web',
  reading: 'Reading sources',
  writing: 'Writing answer',
};

/** 来源域名展示（URL 非法时退回原串） */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 把正文里的 [1] 转成可点击锚点（不碰已存在的 markdown 链接 [x](…)） */
function linkCitations(md: string): string {
  return md.replace(/(?<!\])\[(\d{1,2})\](?!\()/g, (_m, n: string) => `[${n}](#src-${n})`);
}

function scrollToSource(turnIndex: number, srcIndex: number): void {
  document.getElementById(`t${turnIndex}-src-${srcIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 引用锚点 → 跳到本轮来源卡；跳转目标是本轮闭包，故按轮生成 components */
function markdownForTurn(turnIndex: number): Components {
  return {
    ...BASE_COMPONENTS,
    a: ({ href, children }) => {
      if (href?.startsWith('#src-')) {
        const index = Number(href.slice(5));
        return (
          <button
            type="button"
            onClick={() => scrollToSource(turnIndex, index)}
            title={`Source ${index}`}
            className="mx-0.5 inline-flex h-[16px] min-w-[16px] translate-y-[-1px] items-center justify-center rounded-[4px] px-1 align-middle text-[10px] font-semibold transition-colors"
            style={{ color: '#5b4bd6', backgroundColor: 'rgba(107,92,240,0.12)' }}
          >
            {children}
          </button>
        );
      }
      return <ExternalAnchor href={href}>{children}</ExternalAnchor>;
    },
  };
}

function ExternalAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-[rgba(107,92,240,0.35)] underline-offset-2"
      style={{ color: '#5b4bd6' }}
    >
      {children}
    </a>
  );
}

const BASE_COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mb-3 mt-7 text-[19px] font-semibold leading-8">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-6 text-[16.5px] font-semibold leading-7">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-5 text-[15px] font-semibold leading-6">{children}</h3>,
  p: ({ children }) => <p className="my-3 text-[14.5px] leading-7">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="text-[14.5px] leading-7">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 pl-3" style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}>
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded px-1 py-0.5 text-[13px]" style={{ backgroundColor: '#f2f2f8' }}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-lg p-3 text-[12.5px] leading-6" style={{ backgroundColor: '#f7f7fb' }}>
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b px-2 py-1.5 text-left font-semibold" style={{ borderColor: 'var(--line)' }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b px-2 py-1.5 align-top" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
      {children}
    </td>
  ),
  hr: () => <hr className="my-6" style={{ borderColor: 'var(--line)' }} />,
};

export default function HippoSearchPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomInputRef = useRef<HTMLInputElement>(null);

  /** 追加一轮并流式填充；priorTurns 供模型理解追问上下文 */
  const runSearch = useCallback(async (question: string, priorTurns: Turn[]) => {
    const q = question.trim();
    if (!q) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const index = priorTurns.length;
    const history = priorTurns
      .filter((t) => t.answer.trim())
      .slice(-2)
      .flatMap((t) => [
        { role: 'user' as const, content: t.question },
        { role: 'assistant' as const, content: t.answer.slice(0, 4000) },
      ]);

    setTurns([...priorTurns, { question: q, answer: '', sources: [], phase: 'searching', done: false }]);
    setDraft('');
    setBusy(true);

    /** 只改本轮字段，不动已完成的历史轮 */
    const patch = (fields: Partial<Turn>) =>
      setTurns((prev) => prev.map((t, i) => (i === index ? { ...t, ...fields } : t)));

    let acc = '';
    try {
      const res = await fetch('/api/hippo-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, history }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Search failed (HTTP ${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');

          let event = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;

          const payload = JSON.parse(data) as Record<string, unknown>;
          if (event === 'status') {
            const next = String(payload.phase ?? '');
            if (next === 'searching' || next === 'reading' || next === 'writing') patch({ phase: next });
          } else if (event === 'sources') {
            patch({ sources: Array.isArray(payload.sources) ? (payload.sources as SearchSource[]) : [] });
          } else if (event === 'delta') {
            acc += String(payload.text ?? '');
            patch({ answer: acc });
          } else if (event === 'audit') {
            const invalid = Array.isArray(payload.invalid)
              ? payload.invalid.filter((n): n is number => typeof n === 'number')
              : [];
            if (invalid.length > 0) patch({ audit: { invalid } });
          } else if (event === 'error') {
            throw new Error(String(payload.message ?? 'Search failed'));
          }
        }
      }

      patch({ done: true });
    } catch (e) {
      if (ac.signal.aborted) return;
      patch({ done: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (!ac.signal.aborted) setBusy(false);
      requestAnimationFrame(() => bottomInputRef.current?.focus());
    }
  }, []);

  /** 新搜索：清空线程（标题栏输入框走这条路） */
  const startNewSearch = useCallback(
    (q: string) => {
      abortRef.current?.abort();
      setBusy(false);
      window.history.replaceState(null, '', '/hippo-search');
      void runSearch(q, []);
    },
    [runSearch],
  );

  /** 追问：保留线程，把本轮追加到末尾 */
  const askFollowUp = useCallback(
    (q: string) => {
      if (busy) return;
      void runSearch(q, turns);
    },
    [busy, runSearch, turns],
  );

  // 首屏：URL 带 q 就直接检索（新标签页 / 工具栏入口）
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')?.trim() ?? '';
    if (!q) return;
    setDraft('');
    void runSearch(q, []);
  }, [runSearch]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
    setTurns([]);
    setDraft('');
    window.history.replaceState(null, '', '/hippo-search');
  }, []);

  const composer = (variant: 'hero' | 'followup') => {
    const isHero = variant === 'hero';
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const q = draft.trim();
          if (!q || busy) return;
          if (variant === 'followup') askFollowUp(q);
          else {
            setDraft('');
            startNewSearch(q);
          }
        }}
        className={`flex w-full items-center gap-2 rounded-full border bg-white transition-shadow ${
          isHero ? 'h-14 px-5 shadow-[0_6px_24px_rgba(28,28,36,0.08)]' : 'h-9 px-3.5 shadow-[0_1px_6px_rgba(28,28,36,0.05)]'
        }`}
        style={{ borderColor: 'var(--line)' }}
      >
        <Search
          className="shrink-0"
          style={{ width: isHero ? 18 : 14, height: isHero ? 18 : 14, color: 'var(--ink-muted)' }}
        />
        <input
          ref={variant === 'followup' ? bottomInputRef : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={variant === 'followup' ? 'Ask a follow-up…' : 'Ask anything…'}
          className="min-w-0 flex-1 bg-transparent outline-none"
          style={{ fontSize: isHero ? 15 : 13 }}
        />
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          title="Ask"
          className="flex shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
          style={{
            width: isHero ? 32 : 24,
            height: isHero ? 32 : 24,
            backgroundColor: '#6b5cf0',
            color: '#fff',
          }}
        >
          {isHero ? <ArrowUp style={{ width: 15, height: 15 }} /> : <ArrowUp style={{ width: 13, height: 13 }} />}
        </button>
      </form>
    );
  };

  const hasTurns = turns.length > 0;

  return (
    <div className="min-h-screen w-full bg-white" style={{ color: 'var(--ink)', fontFamily: 'var(--font-sans)' }}>
      <header
        className="sticky top-0 z-20 border-b backdrop-blur"
        style={{ borderColor: 'var(--line)', backgroundColor: 'rgba(255,255,255,0.9)' }}
      >
        <div className="mx-auto flex h-14 w-full max-w-[820px] items-center gap-3 px-5">
          <button type="button" onClick={reset} className="flex shrink-0 items-center gap-2" title="New search">
            <span
              className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[13px] font-bold text-white"
              style={{ backgroundColor: '#6b5cf0' }}
            >
              H
            </span>
            <span className="text-[13.5px] font-semibold tracking-[-0.01em]">Hippo Search</span>
          </button>
        </div>
      </header>

      {!hasTurns ? (
        <main className="mx-auto flex min-h-[calc(100vh-56px)] w-full max-w-[720px] flex-col items-center justify-center px-5 pb-24">
          <div className="mb-7 flex flex-col items-center gap-3 text-center">
            <span
              className="flex h-12 w-12 items-center justify-center rounded-2xl text-[22px] font-bold text-white"
              style={{ backgroundColor: '#6b5cf0', boxShadow: '0 10px 30px rgba(107,92,240,0.28)' }}
            >
              H
            </span>
            <h1 className="text-[26px] font-semibold tracking-[-0.02em]">What do you want to know?</h1>
            <p className="text-[13px]" style={{ color: 'var(--ink-muted)' }}>
              Answers synthesized from live web sources, with citations.
            </p>
          </div>
          <div className="w-full max-w-[620px]">{composer('hero')}</div>
        </main>
      ) : (
        <main className="mx-auto w-full max-w-[760px] px-5 pb-28 pt-7">
          {turns.map((turn, ti) => (
            <section key={ti} className="mb-12">
              <h2 className="mb-3 text-[21px] font-semibold leading-8 tracking-[-0.01em]">{turn.question}</h2>

              {!turn.done && !turn.answer ? (
                <div className="mb-3 flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--ink-muted)' }}>
                  <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} />
                  <span>
                    {PHASE_LABEL[turn.phase]}
                    {turn.phase === 'reading' && turn.sources.length > 0 ? ` · ${turn.sources.length} pages` : ''}
                    <span className="ml-0.5 animate-pulse">…</span>
                  </span>
                </div>
              ) : null}

              {turn.error ? (
                <div
                  className="mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]"
                  style={{ borderColor: 'rgba(224,72,61,0.28)', backgroundColor: 'rgba(224,72,61,0.06)' }}
                >
                  <span className="min-w-0 flex-1">{turn.error}</span>
                  <button
                    type="button"
                    onClick={() => {
                      abortRef.current?.abort();
                      setBusy(false);
                      void runSearch(turn.question, turns.slice(0, ti));
                    }}
                    className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors hover:bg-black/[0.05]"
                    style={{ color: '#c0392b' }}
                  >
                    <RotateCw style={{ width: 12, height: 12 }} />
                    Retry
                  </button>
                </div>
              ) : null}

              {turn.answer ? (
                <article className="min-w-0">
                  <Markdown remarkPlugins={[remarkGfm]} components={markdownForTurn(ti)}>
                    {linkCitations(turn.answer)}
                  </Markdown>
                  {turn.audit && turn.audit.invalid.length > 0 ? (
                    <p className="mt-2 text-[11.5px]" style={{ color: '#b45309' }}>
                      {turn.audit.invalid.length} citation marker(s) could not be matched to sources.
                    </p>
                  ) : null}
                </article>
              ) : null}

              {turn.sources.length > 0 ? (
                <section className="mt-6">
                  <div
                    className="mb-3 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em]"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    <Globe style={{ width: 12, height: 12 }} />
                    Sources
                  </div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {turn.sources.map((s) => (
                      <a
                        key={s.index}
                        id={`t${ti}-src-${s.index}`}
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="group flex min-w-0 gap-3 rounded-xl border px-3 py-2.5 transition-colors hover:bg-black/[0.025]"
                        style={{ borderColor: 'var(--line)' }}
                      >
                        <span
                          className="mt-0.5 flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] px-1 text-[10px] font-semibold"
                          style={{ color: '#5b4bd6', backgroundColor: 'rgba(107,92,240,0.12)' }}
                        >
                          {s.index}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start gap-1">
                            <span className="min-w-0 flex-1 text-[13px] font-medium leading-5">{s.title}</span>
                            <ExternalLink
                              className="mt-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
                              style={{ width: 11, height: 11 }}
                            />
                          </span>
                          <span className="mt-0.5 block truncate text-[11.5px]" style={{ color: 'var(--ink-muted)' }}>
                            {s.siteName || hostOf(s.url)}
                          </span>
                          {s.snippet ? (
                            <span className="mt-1 line-clamp-2 block text-[12px] leading-5" style={{ color: 'var(--ink-muted)' }}>
                              {s.snippet}
                            </span>
                          ) : null}
                        </span>
                      </a>
                    ))}
                  </div>
                </section>
              ) : null}
            </section>
          ))}

          {!busy ? (
            <div className="sticky bottom-4">{composer('followup')}</div>
          ) : (
            <div className="sticky bottom-4 flex h-11 items-center justify-center gap-2 rounded-full border bg-white/95 text-[12.5px]" style={{ borderColor: 'var(--line)', color: 'var(--ink-muted)' }}>
              <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} />
              {turnPhaseLabel(turns)}
            </div>
          )}
        </main>
      )}
    </div>
  );
}

/** 底部状态条文案：取当前进行中一轮的阶段 */
function turnPhaseLabel(turns: Turn[]): string {
  const active = [...turns].reverse().find((t) => !t.done);
  if (!active) return 'Working';
  if (active.phase === 'reading' && active.sources.length > 0) return `Reading ${active.sources.length} sources`;
  return PHASE_LABEL[active.phase];
}
