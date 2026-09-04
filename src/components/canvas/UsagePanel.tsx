'use client';

/**
 * UsagePanel —— 模型用量统计面板
 *
 * 两种形态：
 *  - 全屏浮层（默认）：⌘F 图标栏 / 设置内按钮触发，Esc 或点遮罩关闭
 *  - embedded：嵌入 SettingsModal 右侧栏（activeSection === 'usage'），无遮罩无 Esc，随设置弹窗关闭
 *
 * 数据源：GET /api/usage?range=… 聚合真实 token 流水（usage_log 表）。
 * 自包含类型与格式化：避免 import 服务端 lib/usage（链上 better-sqlite3，不能进 client bundle）。
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { Gauge, DollarSign, Clock, Activity, Layers, Cpu } from 'lucide-react';

// ---- 与 src/lib/usage.ts 返回结构对齐的轻量类型 ----
interface Bucket {
  key: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  calls: number;
  tasks: number;
  estCost: number | null;
}
interface UsageRow {
  id: string;
  task_id: string | null;
  node_id: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  total_tokens: number;
  calls: number;
  duration_ms: number | null;
  est_cost: number | null;
  created_at: string;
  /** 结算币种（usd | cny），决定 est_cost 符号 */
  currency?: 'usd' | 'cny';
  /** scope=all 时由路由附带的项目名（project 作用域无） */
  projectName?: string | null;
}
interface UsageApiResp {
  meta: { empty?: boolean; reason?: string; scope?: string; projectName?: string; costCurrency?: string; range?: string };
  summary: { totals: Bucket; byModel: Bucket[]; byDay: Bucket[]; byMonth: Bucket[] } | null;
  recent: UsageRow[];
}

type RangeKey = 'today' | 'month' | 'all';
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'month', label: 'Month' },
  { key: 'all', label: 'All' },
];

type ScopeKey = 'project' | 'all';
const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: 'project', label: 'Project' },
  { key: 'all', label: 'All' },
];

// ---- 格式化（与 ContextMeter 同口径）----
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) {
    const k = Math.round(n / 1000);
    // 接近 1M 四舍五入到 "1000k" 时直接进位为 1M
    return k >= 1000 ? '1M' : `${k}k`;
  }
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(n);
}
/** 成本格式化：币种随模型价格表（DeepSeek 官方人民币结算显示 ¥，其余 $） */
function fmtCost(n: number | null, currency: 'usd' | 'cny'): string {
  if (n == null) return '—';
  const sym = currency === 'cny' ? '¥' : '$';
  if (n === 0) return `${sym}0`;
  if (n < 0.01) return `${sym}${n.toFixed(4)}`;
  return `${sym}${n.toFixed(2)}`;
}
/** 完整模型引用 "deepseek:deepseek-v4-flash" → 可读名 + 厂商前缀 */
function splitModel(ref: string): { vendor: string; name: string } {
  const idx = ref.lastIndexOf(':');
  return idx > 0 ? { vendor: ref.slice(0, idx), name: ref.slice(idx + 1) } : { vendor: '', name: ref };
}
function cacheRate(b: Bucket): number | null {
  const total = b.cacheHitTokens + b.cacheMissTokens;
  return total > 0 ? (b.cacheHitTokens / total) * 100 : null;
}
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function UsagePanel({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  /** embedded：嵌入设置等宿主容器，去掉遮罩/Esc/外部点击关闭，高度随内容 */
  embedded?: boolean;
}) {
  const [range, setRange] = useState<RangeKey>('month');
  const [scope, setScope] = useState<ScopeKey>('project');
  const [data, setData] = useState<UsageApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 序号守卫：快速切换 range/scope 时丢弃过期响应，避免面板数据与所选维度不一致
  const seqRef = useRef(0);
  const load = useCallback(async (r: RangeKey, s: ScopeKey) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/usage?range=${r}&scope=${s}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as UsageApiResp;
      if (seq === seqRef.current) setData(json);
    } catch (e) {
      if (seq === seqRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range, scope);
  }, [range, scope, load]);

  // 清零全部用量记录（二次确认；成功后刷新当前视图为空账本）
  const [resetting, setResetting] = useState(false);
  const handleReset = async () => {
    if (!window.confirm('Clear all recorded usage across all projects?\nThis cannot be undone.')) return;
    setResetting(true);
    try {
      const res = await fetch('/api/usage', { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load(range, scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };

  // Esc 关闭（embedded 形态由宿主容器接管）
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded, onClose]);

  const t = data?.summary?.totals;
  const rate = t ? cacheRate(t) : null;
  const cur: 'usd' | 'cny' = data?.meta.costCurrency === 'cny' ? 'cny' : 'usd';
  const maxByModel = Math.max(1, ...(data?.summary?.byModel ?? []).map((b) => b.totalTokens));
  const maxByDay = Math.max(1, ...(data?.summary?.byDay ?? []).map((b) => b.totalTokens));

  const header = (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3.5"
      style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Gauge className="h-4 w-4 shrink-0" style={{ color: 'var(--info)' }} />
        <span className="shrink-0 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Model usage</span>
        {/* All 作用域下隐藏当前项目标题；仅 Project 时显示 */}
        {scope === 'project' && data?.meta.projectName && (
          <span
            className="truncate rounded-md px-1.5 py-0.5 text-11"
            style={{ color: 'var(--ink-muted)', backgroundColor: 'color-mix(in oklab, var(--line) 25%, transparent)' }}
            title={data?.meta.projectName}
          >
            {data?.meta.projectName}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div
          className="relative flex h-8 w-[136px] shrink-0 items-center rounded-lg p-1"
          style={{ backgroundColor: 'color-mix(in oklab, var(--line) 20%, transparent)' }}
          role="group"
          aria-label="Scope"
        >
          {/* 圆角矩形滑动开关 */}
          <span
            aria-hidden
            className="absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-md border transition-transform duration-200"
            style={{
              left: 4,
              backgroundColor: 'var(--paper)',
              borderColor: 'var(--line)',
              transform: scope === 'all' ? 'translateX(100%)' : 'translateX(0)',
              boxShadow: '0 1px 2px rgb(0 0 0 / 0.08)',
            }}
          />
          {SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScope(s.key)}
              className="relative z-10 h-full flex-1 rounded-md text-11 font-medium transition-colors"
              style={{ color: scope === s.key ? 'var(--ink)' : 'var(--ink-muted)' }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div
          className="relative flex h-8 w-[190px] shrink-0 items-center rounded-lg p-1"
          style={{ backgroundColor: 'color-mix(in oklab, var(--line) 20%, transparent)' }}
          role="group"
          aria-label="Time range"
        >
          {/* 圆角矩形滑动开关（三段） */}
          <span
            aria-hidden
            className="absolute bottom-1 top-1 rounded-md border transition-transform duration-200"
            style={{
              left: 4,
              width: 'calc((100% - 8px) / 3)',
              backgroundColor: 'var(--paper)',
              borderColor: 'var(--line)',
              transform: `translateX(${RANGES.findIndex((r) => r.key === range) * 100}%)`,
              boxShadow: '0 1px 2px rgb(0 0 0 / 0.08)',
            }}
          />
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className="relative z-10 h-full flex-1 rounded-md text-11 font-medium transition-colors"
              style={{ color: range === r.key ? 'var(--ink)' : 'var(--ink-muted)' }}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={handleReset}
          disabled={resetting}
          className="rounded-md px-2.5 py-1 text-11 font-medium transition-colors hover:bg-[var(--paper-hover)] hover:text-[var(--danger)] disabled:opacity-50"
          style={{ color: 'var(--ink-muted)' }}
          title="Clear all recorded usage across all projects"
        >
          {resetting ? 'Clearing…' : 'Reset'}
        </button>
      </div>
    </div>
  );

  const body = (
    <div className="px-5 py-4">
      {error && (
        <div className="flex h-full items-center justify-center py-12 text-sm" style={{ color: 'var(--danger)' }}>
          Failed to load usage: {error}
        </div>
      )}

      {!error && loading && !data && (
        <div className="flex h-full items-center justify-center py-12 text-sm" style={{ color: 'var(--ink-muted)' }}>
          Loading usage…
        </div>
      )}

      {!error && data?.meta.reason === 'no_project' && (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 py-12 text-sm" style={{ color: 'var(--ink-muted)' }}>
          <Layers className="h-6 w-6 opacity-40" />
          No active project — open a project to track model usage.
        </div>
      )}

      {!error && data?.summary && (
        <div className="flex flex-col gap-4">
          {/* 总览卡 */}
          {data.meta.empty ? (
            <div
              className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed py-12 text-sm"
              style={{ color: 'var(--ink-muted)' }}
            >
              No usage recorded in this period yet.
            </div>
          ) : range === 'all' ? null : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard
                label="Total tokens"
                value={t ? fmtTokens(t.totalTokens) : '0'}
                sub={t ? `${t.tasks} task${t.tasks !== 1 ? 's' : ''}` : ''}
                icon={<Activity className="h-3.5 w-3.5" />}
                accent="var(--info)"
              />
              <StatCard
                label="Tokens in / out"
                value={t ? `${fmtTokens(t.promptTokens)} / ${fmtTokens(t.completionTokens)}` : '—'}
                sub={t && t.calls > 0 ? `${t.calls} model calls` : ''}
                icon={<Cpu className="h-3.5 w-3.5" />}
                accent="var(--accent)"
              />
              <StatCard
                label="Est. cost"
                value={t ? fmtCost(t.estCost, cur) : '—'}
                sub={rate != null ? `cache hit ${rate.toFixed(0)}%` : 'pricing n/a'}
                icon={<DollarSign className="h-3.5 w-3.5" />}
                accent="var(--warn)"
              />
              <StatCard
                label="Cache hit rate"
                value={rate != null ? `${rate.toFixed(1)}%` : 'n/a'}
                sub={t ? `hit ${fmtTokens(t.cacheHitTokens)} · miss ${fmtTokens(t.cacheMissTokens)}` : ''}
                icon={<Clock className="h-3.5 w-3.5" />}
                accent="var(--danger)"
              />
            </div>
          )}

          {/* byModel 排行（仅 Today / This month；All 阅读视图只留折线图） */}
          {range !== 'all' && data.summary.byModel.length > 0 && (
            <Section title="By model">
              <div className="flex flex-col gap-2.5">
                {data.summary.byModel.map((b) => {
                  const { vendor, name } = splitModel(b.key);
                  const r = cacheRate(b);
                  return (
                    <div key={b.key} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate font-medium" style={{ color: 'var(--ink)' }}>
                          {name}
                          {vendor && <span className="ml-1.5 text-10" style={{ color: 'var(--ink-muted)' }}>{vendor}</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-2 tabular-nums" style={{ color: 'var(--ink-muted)' }}>
                          <span style={{ color: 'var(--ink)' }}>{fmtTokens(b.totalTokens)}</span>
                          <span className="opacity-70">{b.tasks} task{b.tasks !== 1 ? 's' : ''}</span>
                          <span className="w-14 text-right" style={{ color: 'var(--warn)' }}>{fmtCost(b.estCost, cur)}</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}>
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${(b.totalTokens / maxByModel) * 100}%`, backgroundColor: 'var(--info)', opacity: 0.85 }}
                          />
                        </div>
                        {r != null && (
                          <span className="w-14 text-right text-10 tabular-nums" style={{ color: 'var(--ink-muted)' }} title="prefix cache hit rate">
                            {r.toFixed(0)}% hit
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* 日粒度走势：仅 Today / This month（All 用月度趋势，避免日柱过密） */}
          {range !== 'all' && data.summary.byDay.length > 1 && (
            <Section title="By day">
              <div className="flex h-24 items-end gap-1.5">
                {data.summary.byDay.map((b) => (
                  <div key={b.key} className="group flex min-w-0 flex-1 flex-col items-center gap-1" title={`${b.key}: ${b.totalTokens.toLocaleString()} tokens`}>
                    <div
                      className="w-full rounded-t-sm transition-opacity group-hover:opacity-80"
                      style={{ height: `${Math.max(2, (b.totalTokens / maxByDay) * 84)}px`, backgroundColor: 'var(--info)', opacity: 0.75 }}
                    />
                    <span className="text-9 tabular-nums" style={{ color: 'var(--ink-muted)' }}>{b.key.slice(5)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* All（阅读）视图：仅月度折线图，悬停圆点显示当月 Total tokens / Est. cost */}
          {range === 'all' && data.summary.byMonth.length > 0 && (
            <MonthTrendChart buckets={data.summary.byMonth} currency={cur} />
          )}

          {/* 最近任务（仅 Today / This month；All 阅读视图只留折线图） */}
          {range !== 'all' && data.recent.length > 0 && (
            <Section title="Recent tasks">
              <div className="flex flex-col">
                {data.recent.map((r) => {
                  const { name } = splitModel(r.model);
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-3 border-b py-1.5 text-xs last:border-b-0"
                      style={{ borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)' }}
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium" style={{ color: 'var(--ink)' }}>{name}</span>
                        <span className="text-10" style={{ color: 'var(--ink-muted)' }}>
                          {timeAgo(r.created_at)} · {r.calls} call{r.calls !== 1 ? 's' : ''}
                          {scope === 'all' && r.projectName && (
                            <span className="ml-1 opacity-75">· {r.projectName}</span>
                          )}
                          {r.node_id && <span className="ml-1 opacity-70">· {r.node_id.slice(0, 8)}</span>}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 tabular-nums">
                        <span style={{ color: 'var(--ink)' }}>{fmtTokens(r.total_tokens)}</span>
                        <span className="text-10 opacity-60">in {fmtTokens(r.prompt_tokens)}</span>
                        <span className="text-10 opacity-60">out {fmtTokens(r.completion_tokens)}</span>
                        <span className="w-16 text-right" style={{ color: r.est_cost != null ? 'var(--warn)' : 'var(--ink-muted)' }}>
                          {fmtCost(r.est_cost, r.currency ?? cur)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );

  // embedded：直接作为宿主容器内容（设置右侧栏等），高度随内容走，外层负责滚动
  if (embedded) {
    return (
      <div className="flex min-h-full w-full flex-col">
        {header}
        {body}
      </div>
    );
  }

  // 全屏浮层：遮罩 + 居中卡片，内部滚动
  return (
    <div
      data-canvas-ui="overlay"
      className="fixed inset-0 z-[280] flex items-center justify-center p-6"
      style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 30%, transparent)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex h-[min(720px,88vh)] w-[min(860px,92vw)] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ backgroundColor: 'var(--popover)', borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      </div>
    </div>
  );
}

/** All（阅读）视图：按月的 token 折线图；悬停圆点显示该月 Total tokens / Est. cost */
function MonthTrendChart({ buckets, currency }: { buckets: Bucket[]; currency: 'usd' | 'cny' }) {
  const [active, setActive] = useState<number | null>(null);
  const W = 600;
  const H = 190;
  const PADX = 46;
  const PADT = 24;
  const PADB = 30;
  const innerW = W - PADX * 2;
  const innerH = H - PADT - PADB;
  const max = Math.max(1, ...buckets.map((b) => b.totalTokens));
  const n = buckets.length;
  const pts = buckets.map((b, i) => {
    const x = n === 1 ? W / 2 : PADX + (i * innerW) / (n - 1);
    const y = PADT + innerH * (1 - b.totalTokens / max);
    return { x, y, b };
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const hovered = active != null ? pts[active] : null;

  // 跟随鼠标的十字虚线（仅绘图区内显示）
  const [cross, setCross] = useState<{ x: number; y: number } | null>(null);
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((e.clientX - rect.left) * W) / rect.width;
    const y = ((e.clientY - rect.top) * H) / rect.height;
    if (x < PADX || x > W - 10 || y < PADT || y > H - PADB) {
      setCross(null);
      return;
    }
    setCross({ x, y });
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        style={{ display: 'block', touchAction: 'none' }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setCross(null)}
      >
        {/* 纵轴刻度 + 横向网格（0 ~ max 分 4 档，左轴标注 token 量） */}
        {Array.from({ length: 5 }, (_, i) => {
          const ratio = 1 - i / 4;
          const gy = PADT + innerH * (1 - ratio);
          return (
            <g key={i}>
              <line x1={PADX} y1={gy} x2={W - 10} y2={gy} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" />
              <text x={PADX - 8} y={gy + 3} textAnchor="end" fontSize="10" style={{ fill: 'var(--ink-muted)', fontFamily: 'var(--font-sans)' }}>
                {fmtTokens(Math.round(max * ratio))}
              </text>
            </g>
          );
        })}

        {/* 鼠标十字虚线（pointer-events none，不干扰圆点悬停） */}
        {cross && (
          <g pointerEvents="none">
            <line x1={cross.x} y1={PADT} x2={cross.x} y2={H - PADB} stroke="var(--ink-muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.55" />
            <line x1={PADX} y1={cross.y} x2={W - 10} y2={cross.y} stroke="var(--ink-muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.55" />
          </g>
        )}

        {n > 1 && (
          <path d={line} fill="none" stroke="var(--info)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {pts.map((p, i) => (
          <g
            key={p.b.key}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            style={{ cursor: 'pointer' }}
          >
            {/* 隐形热区，便于点中 */}
            <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
            <circle
              cx={p.x}
              cy={p.y}
              r={i === active ? 5 : 3.5}
              fill={i === active ? 'var(--info)' : 'var(--paper)'}
              stroke="var(--info)"
              strokeWidth="1.8"
            />
          </g>
        ))}
        {pts.map((p) => (
          <text
            key={p.b.key}
            x={p.x}
            y={H - 8}
            textAnchor="middle"
            fontSize="11"
            style={{ fill: 'var(--ink-muted)', fontFamily: 'var(--font-sans)' }}
          >
            {p.b.key.slice(2)}
          </text>
        ))}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: `${Math.min(Math.max((hovered.x / W) * 100, 14), 86)}%`,
            top: `${Math.min(Math.max((hovered.y / H) * 100, 12), 76)}%`,
            transform: 'translate(-50%, -115%)',
            backgroundColor: 'var(--popover)',
            borderColor: 'var(--line)',
          }}
        >
          <div className="text-10 font-medium" style={{ color: 'var(--ink-muted)' }}>{hovered.b.key}</div>
          <div className="tabular-nums" style={{ color: 'var(--ink)' }}>
            Total tokens: <span className="font-semibold">{fmtTokens(hovered.b.totalTokens)}</span>
          </div>
          <div className="tabular-nums" style={{ color: 'var(--ink)' }}>
            Est. cost: <span className="font-semibold" style={{ color: 'var(--warn)' }}>{fmtCost(hovered.b.estCost, currency)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, icon, accent }: { label: string; value: string; sub?: string; icon: React.ReactNode; accent: string }) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'color-mix(in oklab, var(--line) 35%, transparent)' }}>
      <div className="mb-1.5 flex items-center gap-1.5 text-10 uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
        <span style={{ color: accent }}>{icon}</span>
        {label}
      </div>
      <div className="truncate text-lg font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-10 tabular-nums" style={{ color: 'var(--ink-muted)' }}>{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>{title}</h3>
      {children}
    </section>
  );
}
