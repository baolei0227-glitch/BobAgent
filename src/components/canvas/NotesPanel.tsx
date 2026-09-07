'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  NotebookText,
  X,
  Search,
  Loader2,
  RefreshCw,
  Sparkles,
  Stethoscope,
  Cpu,
  Inbox,
  Trash2,
  Pin,
  Link2,
  CornerUpLeft,
  Pencil,
  Check,
  Undo2,
  History,
  ScrollText,
} from 'lucide-react';
import NodeCardHeader from './NodeCardHeader';
import { HtmlRenderer } from './HtmlRenderer';
import { Button } from '@/components/ui/button';
import type { WikiEntryWithContent, WikiEntryType } from '@/lib/mcp/notes-types';

/** 内联编辑用的 DocEditor（懒加载，进入编辑模式才拉取 ~157KB） */
const DocEditor = dynamic(() => import('./DocEditor').then((m) => m.DocEditor), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center py-10" style={{ color: 'var(--ink-faint)' }}>
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  ),
});

type TypeFilter = '' | WikiEntryType;

const TYPE_LABELS: Record<TypeFilter, string> = {
  '': 'All',
  concept: 'Concept',
  note: 'Note',
  source: 'Source',
  todo: 'Todo',
};

const TYPE_ORDER: TypeFilter[] = ['', 'concept', 'note', 'source', 'todo'];

/** 从操作符查询中提取用于高亮的词（与后端 parseQueryOperators 语义对齐的轻量子集） */
function extractHighlightTerms(query: string): string[] {
  const terms = new Set<string>();
  const q = query.trim();
  if (!q) return [];
  const pm = q.match(/"([^"]+)"/);
  if (pm) terms.add(pm[1]);
  const toks = q.replace(/"([^"]+)"/g, ' ').split(/\s+/).filter(Boolean);
  for (const t of toks) {
    if (t.startsWith('tag:') || t.startsWith('type:') || t.startsWith('-')) continue;
    if (t.toLowerCase() === 'or') continue;
    const v = t.trim();
    if (v.length >= 1) terms.add(v);
  }
  return [...terms].filter(Boolean);
}

/** 渲染 markdown 正文，并在文本节点上高亮命中的搜索词（不影响代码块/链接结构） */
function HighlightedContent({ content, query }: { content: string; query: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const terms = useMemo(() => extractHighlightTerms(query), [query]);

  useEffect(() => {
    const root = ref.current;
    if (!root || terms.length === 0) return;
    const lowered = terms.map((t) => t.toLowerCase());
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const text = node.nodeValue ?? '';
      if (lowered.some((t) => text.toLowerCase().includes(t))) targets.push(node);
    }
    for (const node of targets) {
      const text = node.nodeValue ?? '';
      const frag = document.createDocumentFragment();
      let rest = text;
      let matched = false;
      while (rest.length > 0) {
        let hit: { word: string; idx: number } | null = null;
        for (const w of lowered) {
          const idx = rest.toLowerCase().indexOf(w);
          if (idx !== -1 && (hit === null || idx < hit.idx)) hit = { word: w, idx };
        }
        if (!hit) break;
        matched = true;
        if (hit.idx > 0) frag.appendChild(document.createTextNode(rest.slice(0, hit.idx)));
        const mark = document.createElement('mark');
        mark.textContent = rest.slice(hit.idx, hit.idx + hit.word.length);
        frag.appendChild(mark);
        rest = rest.slice(hit.idx + hit.word.length);
      }
      if (matched) {
        frag.appendChild(document.createTextNode(rest));
        node.parentNode?.replaceChild(frag, node);
      }
    }
  }, [content, query, terms]);

  return (
    <div ref={ref}>
      <HtmlRenderer content={content} />
    </div>
  );
}

/** 列表项命中片段：定位第一个命中词，显示其前后约 30 字符上下文（含高亮） */
function Snippet({ content, terms }: { content: string; terms: string[] }) {
  if (!terms.length || !content) return null;
  const lower = content.toLowerCase();
  let idx = -1;
  let word = '';
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (idx === -1 || i < idx)) {
      idx = i;
      word = t;
    }
  }
  if (idx === -1) return null;
  const start = Math.max(0, idx - 30);
  const end = Math.min(content.length, idx + word.length + 30);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return (
    <div className="mt-1 truncate text-11 leading-snug" style={{ color: 'var(--ink-faint)' }}>
      {prefix}
      {content.slice(start, idx)}
      <mark>{content.slice(idx, idx + word.length)}</mark>
      {content.slice(idx + word.length, end)}
      {suffix}
    </div>
  );
}

/** 大纲 TOC：从 markdown 提取 h1-h3 标题，点击滚动定位到正文对应 heading（文本匹配，避免 slug 算法不一致） */
function TocOutline({ content, bodyRef }: { content: string; bodyRef: React.RefObject<HTMLDivElement | null> }) {
  const items = useMemo(() => {
    const out: { level: number; text: string }[] = [];
    for (const m of content.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
      const text = m[2].trim().replace(/[*_`]/g, '').trim();
      if (text) out.push({ level: m[1].length, text });
    }
    return out;
  }, [content]);
  if (items.length === 0) return null;
  const jump = (text: string) => {
    const root = bodyRef.current;
    if (!root) return;
    const heads = root.querySelectorAll('h1, h2, h3, h4');
    for (const h of heads) {
      if ((h.textContent ?? '').trim() === text) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  };
  return (
    <details
      open
      className="mt-2 rounded-lg border px-2.5 py-1.5"
      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper-soft)' }}
    >
      <summary className="cursor-pointer select-none text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
        Outline ({items.length})
      </summary>
      {/* 完整展开：不设内部高度上限，跟随右侧详情栏整体滚动，保证长大纲完整可见 */}
      <div className="mt-1.5 flex flex-col gap-0.5">
        {items.map((it, i) => (
          <button
            key={i}
            onClick={() => jump(it.text)}
            className="truncate rounded px-1.5 py-0.5 text-left text-11 transition-colors hover:opacity-80"
            style={{ color: 'var(--ink-muted)', paddingLeft: `${10 + (it.level - 1) * 12}px` }}
            title={it.text}
          >
            {it.text}
          </button>
        ))}
      </div>
    </details>
  );
}

/** 笔记独立界面：右侧固定面板（同 CalendarPanel），master-detail 浏览个人 wiki */
export function NotesPanel({ onClose }: { onClose: () => void }) {
  const [notes, setNotes] = useState<WikiEntryWithContent[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('');
  const [tagFilter, setTagFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 自然语言拆解结果（"已按…检索"提示条） */
  const [parsedInfo, setParsedInfo] = useState<{ keywords: string[]; from?: string; to?: string } | null>(null);
  /** 内联编辑：编辑中的笔记 id（null = 查看模式） */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 插件大脑面板（bob-notes-mcp web panel, 默认 9480）内嵌开关 */
  const [brainOpen, setBrainOpen] = useState(false);
  /** 素材箱（raw/ inbox）弹层：浏览待编译素材并勾选编译 */
  const [inboxOpen, setInboxOpen] = useState(false);
  /** 版本历史弹层 / 维护日志弹层 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const load = useCallback(async (q: string, t: TypeFilter, tag: string, from: string, to: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('mode', 'full');
      if (q.trim()) params.set('q', q.trim());
      if (t) params.set('type', t);
      if (tag) params.set('tag', tag);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const resp = await fetch(`/api/notebook?${params.toString()}`);
      const data = await resp.json();
      if (!data.success) {
        setError(data.error || 'Failed to load notes');
        return;
      }
      const list = (data.entries || []) as WikiEntryWithContent[];
      setNotes(list);
      setTotal(data.total ?? list.length);
      setParsedInfo(data.parsed && (data.parsed.keywords?.length > 0 || data.parsed.from || data.parsed.to) ? data.parsed : null);
      setSelectedId((prev) => (prev && list.some((n) => n.id === prev) ? prev : (list[0]?.id ?? null)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 搜索防抖
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void load(query, typeFilter, tagFilter, dateFrom, dateTo);
    }, 250);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, typeFilter, tagFilter, dateFrom, dateTo, load]);

  // Esc 关闭（大脑模型弹窗优先关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (brainOpen) setBrainOpen(false);
      else if (inboxOpen) setInboxOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, brainOpen, inboxOpen]);

  // 插件面板（9480）在 cfg-only 直达模式下关闭模型配置后，通知宿主收起外层弹窗（避免停留空白/需再关一次）
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== 'http://127.0.0.1:9480') return;
      if (e.data && e.data.type === 'bob-notes-cfg-close') setBrainOpen(false);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );

  /** 标签聚合（当前列表出现频率 Top 20） */
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of n.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  }, [notes]);

  /** 详情正文容器 ref（TOC 滚动定位用） */
  const bodyRef = useRef<HTMLDivElement | null>(null);

  /** 当前查询的命中词（snippet/高亮用） */
  const terms = useMemo(() => extractHighlightTerms(query), [query]);

  async function runAction(action: 'ingest' | 'review' | 'lint') {
    setRunning(action);
    setNotice(null);
    try {
      const resp = await fetch('/api/notebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await resp.json();
      if (!data.success) {
        setNotice(data.error || 'Action failed');
        return;
      }
      setNotice(data.reply || 'Done');
      await load(query, typeFilter, tagFilter, dateFrom, dateTo);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  async function deleteNote(id: string) {
    try {
      const resp = await fetch(`/api/notebook?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await resp.json();
      if (data.success) {
        setNotice('Note deleted');
        await load(query, typeFilter, tagFilter, dateFrom, dateTo);
      } else {
        setNotice(data.error || 'Delete failed');
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 跳到某条笔记：切换选中 + 列表滚动定位。
   */
  const jumpToNote = useCallback((id: string) => {
    setSelectedId(id);
    requestAnimationFrame(() => {
      document.getElementById(`note-item-${id}`)?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  /**
   * 双链点击跳转：link 可能是条目 id（w-xxx）或标题；命中则切换选中并滚动列表，未命中给出提示。
   */
  const handleLinkClick = useCallback((link: string) => {
    const target = notes.find((n) => n.id === link || n.title === link);
    if (!target) {
      setNotice(`未找到关联笔记：「${link}」`);
      return;
    }
    jumpToNote(target.id);
  }, [notes, jumpToNote]);

  // 反向链接：当前笔记被哪些笔记引用（links 含其 id 或标题）
  const backlinks = useMemo(() => {
    if (!selected) return [];
    return notes.filter((n) => (n.links ?? []).some((l) => l === selected.id || l === selected.title));
  }, [notes, selected]);

  /** 切换选中笔记（列表点击）：退出内联编辑，保持列表滚动锚点 */
  const selectNote = useCallback((id: string) => {
    setEditingId(null);
    setSelectedId(id);
    requestAnimationFrame(() => {
      document.getElementById(`note-item-${id}`)?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  /** 进入内联编辑 */
  const startEdit = useCallback(() => {
    if (!selected) return;
    setEditingId(selected.id);
  }, [selected]);

  /**
   * 保存并退出编辑：DocEditor onSave 已触发落盘（/api/notebook entry_id），
   * 稍等 POST 完成后刷新列表 + 回查看模式（避免 GET 与 POST 竞态读到旧内容）。
   */
  const finishEdit = useCallback(async () => {
    setEditingId(null);
    setNotice('Note saved');
    setTimeout(() => {
      void load(query, typeFilter, tagFilter, dateFrom, dateTo);
    }, 250);
  }, [load, query, typeFilter]);

  /** 取消编辑：不落盘，直接回查看模式（重挂载 DocEditor 丢弃未保存改动） */
  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  return (
    <div
      data-canvas-ui="overlay"
      className="fixed inset-0 z-[51] flex h-full w-full flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--paper)',
        fontFamily: 'var(--font-sans)',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      {/* 头部 */}
      <NodeCardHeader
        leftAnchor={<NotebookText className="h-4 w-4 shrink-0" style={{ color: 'var(--primary)' }} />}
        title={<span className="text-sm font-semibold">Notes</span>}
        subtitle={`${total} notes`}
        subtitleInline
        rightActions={
          <>
            {!brainOpen && (
            <>
            <Button
              variant="soft"
              tone="brand"
              size="xs"
              onClick={() => runAction('ingest')}
              disabled={running !== null}
              loading={running === 'ingest'}
              title="Compile pending raw material"
            >
              {running === 'ingest' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Inbox className="h-3 w-3" />}
              Ingest
            </Button>
            <Button
              variant="soft"
              tone="brand"
              size="xs"
              onClick={() => runAction('review')}
              disabled={running !== null}
              loading={running === 'review'}
              title="Review & rescue (promote/sink)"
            >
              {running === 'review' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Review
            </Button>
            <Button
              variant="soft"
              tone="neutral"
              size="xs"
              onClick={() => runAction('lint')}
              disabled={running !== null}
              loading={running === 'lint'}
              title="Self-check (broken links / orphans / duplicates)"
            >
              {running === 'lint' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Stethoscope className="h-3 w-3" />}
              Lint
            </Button>
            <Button
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              onClick={() => load(query, typeFilter, tagFilter, dateFrom, dateTo)}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            {selectedId && (
              <Button
                variant="ghost"
                tone="neutral"
                size="icon-sm"
                onClick={() => setHistoryOpen(true)}
                title="Version history (undo brain rewrites)"
                aria-label="Version history"
              >
                <History className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              onClick={() => setLogOpen(true)}
              title="Maintenance log (what the brain did)"
              aria-label="Maintenance log"
            >
              <ScrollText className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              onClick={() => setInboxOpen(true)}
              title="Raw inbox: browse uncompiled material and compile selected"
              aria-label="Raw inbox"
            >
              <Inbox className="h-3.5 w-3.5" />
            </Button>
            </>
            )}
            <button
              onClick={() => setBrainOpen(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-11 font-medium transition-colors disabled:opacity-50"
              style={
                brainOpen
                  ? { color: 'var(--paper)', backgroundColor: 'var(--primary)' }
                  : { color: 'var(--primary)', backgroundColor: 'var(--primary-soft)' }
              }
              title="Configure the plugin brain model (bob-notes-mcp web panel)"
            >
              <Cpu className="h-3 w-3" />
              Model
            </button>
            <Button
              variant="soft"
              tone="neutral"
              size="icon"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="close notes"
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        }
        dividerColor="var(--line-soft)"
        style={{ backgroundColor: 'var(--paper-soft)' }}
      />

      {/* 工具条：搜索 + 类型过滤 */}
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line-soft)' }}>
        <div className="flex items-center gap-2">
          <div
            className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5"
            style={{ backgroundColor: 'var(--paper-soft)', border: '1px solid var(--line-soft)' }}
          >
            <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-faint)' }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search…  tag:贷款 type:concept "精确短语" -排除 a OR b'
              className="min-w-0 flex-1 bg-transparent text-13 outline-none"
              style={{ color: 'var(--ink)' }}
            />
            {query && (
              <button onClick={() => setQuery('')} style={{ color: 'var(--ink-muted)' }}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {TYPE_ORDER.map((t) => (
            <button
              key={t || 'all'}
              onClick={() => setTypeFilter(t)}
              className="rounded-full px-2.5 py-1 text-11 font-medium transition-colors"
              style={{
                color: typeFilter === t ? 'var(--primary)' : 'var(--ink-muted)',
                backgroundColor: typeFilter === t ? 'var(--primary-soft)' : 'var(--paper-hover)',
              }}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        {/* 标签聚合 chips：点击过滤 tag:xxx */}
        {tagCounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {tagCounts.map(([tag, count]) => {
              const active = tagFilter === tag;
              return (
                <button
                  key={tag}
                  onClick={() => setTagFilter(active ? '' : tag)}
                  title={`Filter by tag: ${tag} (${count})`}
                  className="rounded-full px-2 py-0.5 text-10 transition-colors"
                  style={{
                    color: active ? 'var(--primary)' : 'var(--ink-faint)',
                    backgroundColor: active ? 'var(--primary-soft)' : 'transparent',
                    border: `1px solid ${active ? 'var(--primary)' : 'var(--line-soft)'}`,
                  }}
                >
                  #{tag} {count}
                </button>
              );
            })}
          </div>
        )}
        {/* 日期过滤 */}
        <div className="flex items-center gap-1.5">
          <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
            From
          </span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded border px-1 py-0.5 text-11 outline-none"
            style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink)' }}
          />
          <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
            To
          </span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded border px-1 py-0.5 text-11 outline-none"
            style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink)' }}
          />
          {(dateFrom || dateTo) && (
            <Button
              variant="soft"
              tone="brand"
              size="micro"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
              }}
            >
              Clear
            </Button>
          )}
        </div>
        {/* 自然语言拆解提示：已按 关键词/时间范围 检索 */}
        {parsedInfo && (
          <div className="flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
            <Sparkles className="h-3 w-3 shrink-0" style={{ color: 'var(--primary)' }} />
            <span className="truncate">
              Searched by
              {parsedInfo.keywords.length > 0 && (
                <>
                  {' '}
                  <span className="font-medium" style={{ color: 'var(--ink)' }}>
                    「{parsedInfo.keywords.join('、')}」
                  </span>
                </>
              )}
              {(parsedInfo.from || parsedInfo.to) && (
                <>
                  {(parsedInfo.keywords.length > 0 ? ' · ' : ' ')}
                  <span className="font-medium" style={{ color: 'var(--ink)' }}>
                    {parsedInfo.from || '…'} ~ {parsedInfo.to || '…'}
                  </span>
                </>
              )}
            </span>
          </div>
        )}
      </div>

      {/* 操作反馈横幅 */}
      {notice && (
        <div
          className="shrink-0 border-b px-3 py-2 text-12"
          style={{ borderColor: 'var(--line-soft)', color: 'var(--ink-muted)', backgroundColor: 'var(--paper-soft)' }}
        >
          {notice}
          <button onClick={() => setNotice(null)} className="float-right" style={{ color: 'var(--ink-faint)' }}>
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* 主体：master-detail */}
      <div className="flex min-h-0 flex-1">
        {/* 列表 */}
        <div className="w-[30%] min-w-[260px] max-w-[420px] shrink-0 overflow-y-auto border-r" style={{ borderColor: 'var(--line-soft)' }}>
          {loading && notes.length === 0 ? (
            <div className="flex items-center justify-center py-10" style={{ color: 'var(--ink-faint)' }}>
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : notes.length === 0 ? (
            <div className="px-4 py-10 text-center text-12" style={{ color: 'var(--ink-faint)' }}>
              {error || 'No notes yet. Use /note or /clip to create some.'}
            </div>
          ) : (
            notes.map((n) => {
              const active = n.id === selectedId;
              return (
                <button
                  key={n.id}
                  id={`note-item-${n.id}`}
                  onClick={() => selectNote(n.id)}
                  className="block w-full border-b px-3 py-2.5 text-left transition-colors"
                  style={{
                    borderColor: 'var(--line-soft)',
                    backgroundColor: active ? 'var(--primary-soft)' : 'transparent',
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    {n.weight > 0 && (
                      <span className="flex items-center gap-0.5 text-10" style={{ color: 'var(--warning)' }}>
                        <Pin className="h-3 w-3" />
                        {n.weight > 1 ? `×${n.weight}` : ''}
                      </span>
                    )}
                    <span
                      className="min-w-0 flex-1 truncate text-13 font-medium"
                      style={{ color: active ? 'var(--primary)' : 'var(--ink)' }}
                    >
                      {n.title}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 truncate">
                    <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                      {TYPE_LABELS[n.type as TypeFilter] ?? n.type}
                    </span>
                    {n.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded px-1 py-0.5 text-10"
                        style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}
                      >
                        {tag}
                      </span>
                    ))}
                    {n.date && (
                      <span className="ml-auto shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>
                        {n.date}
                      </span>
                    )}
                  </div>
                  <Snippet content={n.content || ''} terms={terms} />
                </button>
              );
            })
          )}
        </div>

        {/* 详情 */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            editingId === selected.id ? (
              // ===== 内联编辑模式：DocEditor（懒加载），保存/取消在右上角 =====
              <div className="flex h-full flex-col">
                <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-13 font-medium" style={{ color: 'var(--ink)' }}>
                    {selected.title}
                  </span>
                  <Button
                    onClick={() => void finishEdit()}
                    variant="soft"
                    tone="success"
                    size="xs"
                    title="Save & back"
                  >
                    <Check className="h-3 w-3" />
                    Done
                  </Button>
                  <Button
                    onClick={cancelEdit}
                    variant="soft"
                    tone="neutral"
                    size="xs"
                    title="Discard changes"
                  >
                    <Undo2 className="h-3 w-3" />
                    Cancel
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden border-t" style={{ borderColor: 'var(--line-soft)' }}>
                  <DocEditor
                    key={selected.id}
                    content={selected.content}
                    notebookEntryId={selected.id}
                    editable
                    hideToc
                    onSave={() => void finishEdit()}
                  />
                </div>
              </div>
            ) : (
            <div className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 flex-1 text-15 font-semibold" style={{ color: 'var(--ink)' }}>
                  {selected.title}
                </h2>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    onClick={startEdit}
                    variant="soft"
                    tone="brand"
                    size="xs"
                    title="Edit this note"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </Button>
                  <Button
                    onClick={() => deleteNote(selected.id)}
                    variant="soft"
                    tone="danger"
                    size="xs"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </Button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span
                  className="rounded-full px-2 py-0.5 text-10 font-medium"
                  style={{ color: 'var(--primary)', backgroundColor: 'var(--primary-soft)' }}
                >
                  {TYPE_LABELS[selected.type as TypeFilter] ?? selected.type}
                </span>
                {selected.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full px-2 py-0.5 text-10"
                    style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}
                  >
                    {tag}
                  </span>
                ))}
                <span className="ml-auto text-10" style={{ color: 'var(--ink-faint)' }}>
                  {selected.date || ''}
                </span>
              </div>

              {selected.links.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Link2 className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                  {selected.links.map((link) => {
                    const hit = notes.some((n) => n.id === link || n.title === link);
                    return (
                      <button
                        key={link}
                        onClick={() => handleLinkClick(link)}
                        title={hit ? `Jump to: ${link}` : `No matching note: ${link}`}
                        className="rounded px-1.5 py-0.5 font-mono text-10 transition-colors hover:opacity-80"
                        style={{
                          backgroundColor: hit ? 'var(--primary-soft)' : 'var(--paper-soft)',
                          color: hit ? 'var(--primary)' : 'var(--ink-muted)',
                          cursor: hit ? 'pointer' : 'default',
                        }}
                      >
                        {link}
                      </button>
                    );
                  })}
                </div>
              )}

              {backlinks.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <CornerUpLeft className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                  <span className="text-11" style={{ color: 'var(--ink-faint)' }}>
                    Referenced by ({backlinks.length})
                  </span>
                  {backlinks.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => jumpToNote(b.id)}
                      title={`Jump to: ${b.title}`}
                      className="max-w-[180px] truncate rounded px-1.5 py-0.5 text-10 transition-colors hover:opacity-80"
                      style={{
                        backgroundColor: 'var(--primary-soft)',
                        color: 'var(--primary)',
                        cursor: 'pointer',
                      }}
                    >
                      {b.title}
                    </button>
                  ))}
                </div>
              )}

              <TocOutline content={selected.content} bodyRef={bodyRef} />
              <div
                ref={bodyRef}
                className="note-content mt-2 rounded-lg border p-3 text-13 leading-relaxed"
                style={{
                  borderColor: 'var(--line-soft)',
                  backgroundColor: 'var(--paper-soft)',
                  color: 'var(--ink)',
                  wordBreak: 'break-word',
                }}
              >
                {selected.content ? (
                  <HighlightedContent content={selected.content} query={query} />
                ) : (
                  '(empty)'
                )}
              </div>
            </div>
            )
          ) : (
            <div className="flex h-full items-center justify-center text-12" style={{ color: 'var(--ink-faint)' }}>
              Select a note to view
            </div>
          )}
        </div>
      </div>
      {historyOpen && selected && (
        <HistoryDialog
          entryId={selected.id}
          entryTitle={selected.title}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => void load(query, typeFilter, tagFilter, dateFrom, dateTo)}
        />
      )}
      {logOpen && <LogDialog onClose={() => setLogOpen(false)} />}
      {inboxOpen && (
        <RawInboxDialog
          onClose={() => setInboxOpen(false)}
          onCompiled={() => void load(query, typeFilter, tagFilter, dateFrom, dateTo)}
        />
      )}
      {brainOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBrainOpen(false);
          }}
        >
          <div
            className="flex h-[min(80vh,720px)] w-[min(760px,92vw)] flex-col overflow-hidden rounded-xl border shadow-xl"
            style={{ backgroundColor: 'var(--panel)', borderColor: 'var(--line-soft)' }}
          >
            <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4" style={{ color: 'var(--primary)' }} />
                <span className="text-13 font-semibold">Notes brain model</span>
              </div>
              <Button
                onClick={() => setBrainOpen(false)}
                variant="ghost"
                tone="neutral"
                size="icon-sm"
                title="Close"
                aria-label="close brain model"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <BrainEmbed />
          </div>
        </div>
      )}
    </div>
  );
}

/** 插件大脑面板（bob-notes-mcp 自带 web 面板）内嵌视图：模型配置（Provider / Key / Model + Test & Save） */
function BrainEmbed() {
  const [up, setUp] = useState<boolean | null>(null);
  const check = useCallback(() => {
    setUp(null);
    fetch('http://127.0.0.1:9480/api/status', { signal: AbortSignal.timeout(3000) })
      .then((r) => setUp(r.ok))
      .catch(() => setUp(false));
  }, []);
  useEffect(() => {
    check();
  }, [check]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {up === false && (
        <div
          className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-12"
          style={{ color: 'var(--ink-muted)' }}
        >
          <p>Plugin panel unreachable at http://127.0.0.1:9480.</p>
          <p>Confirm bob-notes-mcp is enabled in Settings → MCP — it starts with --serve.</p>
          <Button
            onClick={check}
            variant="soft"
            tone="brand"
            size="xs"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </div>
      )}
      {/* ?cfg=1：面板加载后自动弹出模型设置（契约见 bob-notes-mcp panel.ts） */}
      {up !== false && (
        <iframe
          src="http://127.0.0.1:9480/?cfg=1"
          title="Notes brain model panel"
          className="h-full w-full flex-1 border-0"
          style={{ backgroundColor: 'var(--paper)' }}
          onLoad={() => setUp(true)}
        />
      )}
    </div>
  );
}

/** 版本历史弹层：自动快照列表 + 一键恢复（"大脑改写"的安全气囊） */
function HistoryDialog({
  entryId,
  entryTitle,
  onClose,
  onRestored,
}: {
  entryId: string;
  entryTitle: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [snapshots, setSnapshots] = useState<Array<{ time: number }> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSnapshots(null);
    setError('');
    try {
      const resp = await fetch('/api/notebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'history', id: entryId }),
      });
      const d = await resp.json();
      if (!d.success) {
        setError(d.error || 'Failed to load history');
        setSnapshots([]);
        return;
      }
      setSnapshots(Array.isArray(d.snapshots) ? (d.snapshots as Array<{ time: number }>) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnapshots([]);
    }
  }, [entryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (time: number) => {
    setBusy(String(time));
    setError('');
    try {
      const resp = await fetch('/api/notebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', id: entryId, time }),
      });
      const d = await resp.json();
      if (!d.success) {
        setError(d.error || 'Restore failed');
        return;
      }
      onRestored();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[560px] max-w-full flex-col rounded-xl border p-4"
        style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line-soft)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="truncate text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>
            Version history · {entryTitle}
          </span>
          <Button
            onClick={onClose}
            variant="ghost"
            tone="neutral"
            size="icon-xs"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mb-2 text-11" style={{ color: 'var(--ink-muted)' }}>
          每次正文被覆盖前自动留存快照（每篇最多 20 个）；恢复会把当前版也留档，可反悔。
        </div>
        {error && (
          <div className="mb-2 text-11" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {snapshots === null ? (
            <div className="py-8 text-center" style={{ color: 'var(--ink-faint)' }}>
              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
            </div>
          ) : snapshots.length === 0 ? (
            <div className="py-8 text-center text-12" style={{ color: 'var(--ink-faint)' }}>
              No history yet — no version has overwritten this note since snapshots began.
            </div>
          ) : (
            snapshots.map((s) => (
              <div
                key={s.time}
                className="flex items-center gap-2 border-b py-1.5"
                style={{ borderColor: 'var(--line-soft)' }}
              >
                <History className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                <span className="min-w-0 flex-1 truncate text-12" style={{ color: 'var(--ink)' }}>
                  {new Date(s.time).toLocaleString('zh-CN', { hour12: false })}
                </span>
                <Button
                  onClick={() => void restore(s.time)}
                  disabled={busy !== null}
                  loading={busy === String(s.time)}
                  variant="soft"
                  tone="brand"
                  size="micro"
                >
                  {busy === String(s.time) ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Undo2 className="h-3 w-3" />
                  )}
                  Restore
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** 素材箱（raw/ inbox）弹层：浏览待编译素材 → 勾选 → 编译选中（宿主原生素材箱入口） */
interface RawItemLite {
  id: string;
  title: string;
  source?: string;
  status: 'uncompiled' | 'compiled';
  compiledEntryIds?: string[];
  createdAt: string;
  preview?: string;
}
function RawInboxDialog({ onClose, onCompiled }: { onClose: () => void; onCompiled: () => void }) {
  const [items, setItems] = useState<RawItemLite[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'uncompiled' | 'compiled' | 'all'>('uncompiled');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy('load');
    setError('');
    try {
      const resp = await fetch('/api/notebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'raw_list', status }),
      });
      const d = await resp.json();
      if (!d.success) {
        setError(d.error || 'Failed to load inbox');
        setItems([]);
        return;
      }
      const list = Array.isArray(d.items) ? (d.items as RawItemLite[]) : [];
      setItems(list);
      // 清理已不存在的选中
      setSelected((prev) => {
        const ids = new Set(list.map((x) => x.id));
        return new Set([...prev].filter((id) => ids.has(id)));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setBusy(null);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const compileSelected = async () => {
    const ids = items?.filter((x) => selected.has(x.id) && x.status === 'uncompiled').map((x) => x.id) ?? [];
    if (ids.length === 0) return;
    setBusy('compile');
    setError('');
    try {
      const resp = await fetch('/api/notebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ingest', ids }),
      });
      const d = await resp.json();
      if (!d.success) {
        setError(d.error || 'Compile failed');
        return;
      }
      setSelected(new Set());
      onCompiled();
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const visItems = items?.filter((x) => (status === 'uncompiled' ? x.status === 'uncompiled' : status === 'compiled' ? x.status === 'compiled' : true)) ?? [];
  const pendingCount = items?.filter((x) => x.status === 'uncompiled').length ?? 0;
  const selCount = [...selected].filter((id) => items?.some((x) => x.id === id && x.status === 'uncompiled')).length;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[70vh] w-[min(680px,92vw)] flex-col overflow-hidden rounded-xl border shadow-xl"
        style={{ backgroundColor: 'var(--panel)', borderColor: 'var(--line-soft)' }}
      >
        {/* 头 */}
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5" style={{ borderColor: 'var(--line-soft)' }}>
          <div className="flex items-center gap-2">
            <Inbox className="h-4 w-4" style={{ color: 'var(--primary)' }} />
            <span className="text-13 font-semibold">Raw Inbox</span>
            <span className="text-11" style={{ color: 'var(--ink-muted)' }}>
              {pendingCount} uncompiled
            </span>
          </div>
          <Button
            onClick={onClose}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            title="Close"
            aria-label="close inbox"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 工具条 */}
        <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line-soft)' }}>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="rounded-md border px-2 py-1 text-12 outline-none"
            style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink)' }}
          >
            <option value="uncompiled">Uncompiled</option>
            <option value="compiled">Compiled</option>
            <option value="all">All</option>
          </select>
          <span className="flex-1" />
          <Button
            onClick={compileSelected}
            disabled={busy !== null || selCount === 0}
            loading={busy === 'compile'}
            variant="solid"
            tone="brand"
            size="sm"
            title="Compile selected uncompiled material into the wiki"
          >
            {busy === 'compile' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            Compile selected{selCount > 0 ? ` (${selCount})` : ''}
          </Button>
        </div>

        {error && (
          <div className="px-3 py-1.5 text-11" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        {/* 列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {busy === 'load' && items === null ? (
            <div className="py-10 text-center" style={{ color: 'var(--ink-faint)' }}>
              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
            </div>
          ) : visItems.length === 0 ? (
            <div className="py-10 text-center text-12" style={{ color: 'var(--ink-faint)' }}>
              {status === 'uncompiled' ? 'No pending material. Add text via /clip, /note or the browser extension.' : 'Nothing here.'}
            </div>
          ) : (
            visItems.map((x) => {
              const isSel = selected.has(x.id);
              const isCompiled = x.status === 'compiled';
              return (
                <div
                  key={x.id}
                  className="flex cursor-pointer items-start gap-2 border-b px-3 py-2 transition-colors"
                  style={{ borderColor: 'var(--line-soft)', backgroundColor: isSel ? 'var(--primary-soft)' : 'transparent' }}
                  onClick={() => !isCompiled && toggle(x.id)}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    disabled={isCompiled}
                    onChange={() => !isCompiled && toggle(x.id)}
                    className="mt-0.5 shrink-0"
                    style={{ accentColor: 'var(--primary)' }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-12.5 font-medium" style={{ color: 'var(--ink)' }}>
                      <span className="truncate">{x.title || x.id}</span>
                      <span
                        className="shrink-0 rounded-full px-1.5 text-10"
                        style={{
                          color: isCompiled ? 'var(--success)' : 'var(--warning)',
                          backgroundColor: isCompiled ? 'color-mix(in oklab, var(--success) 12%, transparent)' : 'color-mix(in oklab, var(--warning) 12%, transparent)',
                        }}
                      >
                        {isCompiled ? `compiled${(x.compiledEntryIds?.length ?? 0) ? ` (${x.compiledEntryIds!.length})` : ''}` : 'uncompiled'}
                      </span>
                    </div>
                    {x.preview ? (
                      <div className="mt-0.5 line-clamp-2 text-11.5" style={{ color: 'var(--ink-muted)' }}>
                        {x.preview}
                      </div>
                    ) : null}
                    {x.source ? (
                      <div className="mt-0.5 truncate text-10.5" style={{ color: 'var(--ink-faint)' }}>
                        {x.source}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
/** 维护日志弹层：大脑最近对笔记库做了什么（ingest / review / lint / fix / backfill / restore） */
function LogDialog({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<Array<{ time: string; kind: string; message: string }> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const resp = await fetch('/api/notebook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'log' }),
        });
        const d = await resp.json();
        if (!alive) return;
        if (!d.success) {
          setError(d.error || 'Failed to load log');
          setEntries([]);
          return;
        }
        setEntries(Array.isArray(d.entries) ? (d.entries as Array<{ time: string; kind: string; message: string }>) : []);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const KIND_EMOJI: Record<string, string> = {
    ingest: '📥',
    review: '🔁',
    lint: '🔍',
    fix: '🧹',
    backfill: '🔗',
    restore: '↩️',
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[620px] max-w-full flex-col rounded-xl border p-4"
        style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line-soft)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>
            Maintenance log
          </span>
          <Button
            onClick={onClose}
            variant="ghost"
            tone="neutral"
            size="icon-xs"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mb-2 text-11" style={{ color: 'var(--ink-muted)' }}>
          What the brain did to the notes library (newest first).
        </div>
        {error && (
          <div className="mb-2 text-11" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {entries === null ? (
            <div className="py-8 text-center" style={{ color: 'var(--ink-faint)' }}>
              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
            </div>
          ) : entries.length === 0 ? (
            <div className="py-8 text-center text-12" style={{ color: 'var(--ink-faint)' }}>
              No maintenance records yet.
            </div>
          ) : (
            entries.map((e, i) => (
              <div key={i} className="border-b py-1.5" style={{ borderColor: 'var(--line-soft)' }}>
                <div className="flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                  <span>{KIND_EMOJI[e.kind] ?? '•'}</span>
                  <span className="font-medium" style={{ color: 'var(--ink)' }}>
                    {e.kind}
                  </span>
                  <span className="truncate">{new Date(e.time).toLocaleString('zh-CN', { hour12: false })}</span>
                </div>
                <div className="mt-0.5 pl-4 text-12" style={{ color: 'var(--ink)' }}>
                  {e.message}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
