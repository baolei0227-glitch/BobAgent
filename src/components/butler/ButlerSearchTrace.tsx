'use client';

/**
 * ButlerSearchTrace —— 右栏「检索实况」面板（本轮公众号检索的**逐篇账本**）。
 *
 * 为什么独立成文件：本面板**完全受控**（数据全走 props，不碰抽屉任何内部状态），
 * 因此可被两处复用：
 *   - 桌面：`ButlerDrawer` 右栏的 `search` 分区
 *   - 移动：`/butler` 的分区栈
 * 原定义内联在 `ButlerDrawer.tsx`（:1577-1793），2026-10-05 抽出以支持移动端「完整 Butler」。
 * 抽出时保持实现逐字不变，桌面行为零回归。
 *
 * 与中栏的关系：中栏只呈现结果（小微落库的综述 + 精选卡片），这里呈现**过程判定**——
 * 召回的全部文章、哪几篇被留下、哪几篇被判掉。**过程态临时、不落库**
 * （与 lib/core/butler-search.ts 的「结果态落库」互补）。
 *
 * 分三段：留下 / 判定中 / 去除。段内保持召回原顺序（序即检索排序，不重排以免对不上号）。
 * 每一行整行可点 —— 包括被判掉的：判定只是「模型没选它」，不该剥夺用户打开它的权利。
 */

import { Loader2, ThumbsDown, ThumbsUp, type LucideIcon } from 'lucide-react';
import type { WechatSearchTraceItem } from '@/lib/bus';

/**
 * 检索实况里一行的**副文案**：按判定给不同的信息——
 * 留下 = 入选理由（优先）→ 一句摘要；去除 = 搜索摘要（它能说明「为什么这篇没用」）；待判定 = 阶段提示。
 */
function traceSubtitle(it: WechatSearchTraceItem): string {
  if (it.verdict === 'kept') return (it.reason || it.summary || it.snippet || '').trim();
  if (it.verdict === 'dropped') return (it.snippet || '未给出入选理由').trim();
  return '等待精选判定…';
}

/** 判定 → 图标 + 配色（拇指是唯一的状态语言：向上 = 留下看，向下 = 判掉） */
function traceVerdictIcon(it: WechatSearchTraceItem) {
  if (it.verdict === 'kept') {
    return { Icon: ThumbsUp as LucideIcon, color: 'var(--primary)', title: '精选留下（已精读）' };
  }
  if (it.verdict === 'dropped') {
    return { Icon: ThumbsDown as LucideIcon, color: 'var(--ink-faint)', title: '精选去除（仍可点开）' };
  }
  return { Icon: Loader2 as LucideIcon, color: 'var(--ink-faint)', title: '待判定' };
}

/** 实况一行（提到组件外：在 render 里现造组件会让它每次渲染都重新挂载） */
function TraceRow({ it, onOpen }: { it: WechatSearchTraceItem; onOpen: (url: string) => void }) {
  const { Icon, color, title } = traceVerdictIcon(it);
  const sub = traceSubtitle(it);
  return (
    <button
      type="button"
      onClick={() => onOpen(it.url)}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-hover)]"
      title={`${it.title}\n${it.url}`}
    >
      <div className="min-w-0 flex-1">
        <div
          className="line-clamp-2 text-11 font-medium"
          style={{ color: it.verdict === 'dropped' ? 'var(--ink-muted)' : 'var(--ink-strong)' }}
        >
          {it.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {it.account ? (
            <span className="min-w-0 truncate text-10" style={{ color: 'var(--ink-faint)' }}>
              {it.account}
            </span>
          ) : null}
          {it.verdict === 'kept' && it.readOk === false ? (
            <span className="shrink-0 text-10" style={{ color: 'var(--ink-faint)' }}>
              正文未读到
            </span>
          ) : null}
          {it.verdict === 'kept' && it.keypoint ? (
            <span
              className="shrink-0 rounded px-1 text-10"
              style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary-strong)' }}
            >
              {it.keypoint}
            </span>
          ) : null}
        </div>
        {sub ? (
          <div className="mt-0.5 line-clamp-2 text-10" style={{ color: 'var(--ink-faint)' }}>
            {sub}
          </div>
        ) : null}
      </div>
      <span className="mt-0.5 shrink-0" title={title}>
        <Icon className={`h-3.5 w-3.5 ${it.verdict === 'pending' ? 'animate-spin' : ''}`} style={{ color }} />
      </span>
    </button>
  );
}

/** 实况一段（留下 / 判定中 / 去除） */
function TraceSection({
  label,
  rows,
  tone,
  onOpen,
}: {
  label: string;
  rows: WechatSearchTraceItem[];
  tone: string;
  onOpen: (url: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="px-2 text-10 font-semibold tracking-wide" style={{ color: tone }}>
        {label} · {rows.length}
      </div>
      <div className="mt-0.5 flex flex-col gap-0.5">
        {rows.map((it) => (
          <TraceRow key={it.id} it={it} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

export function ButlerSearchTrace({
  query,
  plan,
  items,
  busy,
  status,
  notice,
  onOpen,
}: {
  query: string;
  /** 检索前规划：问题被拆成哪几个检索方向（2026-10-01 自中栏过程块移交至此） */
  plan: { intent?: string; queries?: string[] } | null;
  items: WechatSearchTraceItem[];
  /** 检索是否还在跑（跑完就不再显示「判定中」段） */
  busy: boolean;
  status: string;
  notice: string;
  onOpen: (url: string) => void;
}) {
  const kept = items.filter((i) => i.verdict === 'kept');
  const pending = items.filter((i) => i.verdict === 'pending');
  const dropped = items.filter((i) => i.verdict === 'dropped');

  return (
    <div className="flex h-full flex-col">
      {/* 头部：检索词 + 计数。计数是这一栏的「一句话结论」：召回了多少、留下几篇、判掉几篇 */}
      <div className="shrink-0 px-3 pb-1 pt-2.5">
        <div className="truncate text-11 font-semibold" style={{ color: 'var(--ink-strong)' }} title={query}>
          {query || '公众号检索'}
        </div>
        {/* 问题下方 = 这个问题的拆解（2026-10-01 自中栏过程块移来）：
            拆解与判定读的本来是同一件事——「按这几个方向搜、收回来这些篇、留这几篇」，
            分处两栏就得来回对；同屏之后，方向与篇目才对得上号。
            单方向时不显示（「已拆为 1 个方向」是废话，与原来中栏的门控一致）。 */}
        {plan?.queries && plan.queries.length > 1 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
              已拆为 {plan.queries.length} 个检索方向{plan.intent ? `（${plan.intent}）` : ''}：
            </span>
            {plan.queries.map((qq, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-md px-1.5 py-0.5 text-10"
                style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink-muted)', border: '1px solid var(--line)' }}
              >
                {qq}
              </span>
            ))}
          </div>
        ) : null}
        {/* 计数只在有账本时出现：候选还没回来时写「召回 0 / 留下 0 / 去除 0」是废话，
            那半程由下面的空态负责交代（正在检索…）。 */}
        {items.length > 0 ? (
          <div className="mt-0.5 flex items-center gap-2 text-10" style={{ color: 'var(--ink-muted)' }}>
            <span className="tabular-nums">召回 {items.length}</span>
            <span className="tabular-nums" style={{ color: 'var(--primary-strong)' }}>
              留下 {kept.length}
            </span>
            <span className="tabular-nums">去除 {dropped.length}</span>
            {busy ? (
              <span className="inline-flex items-center gap-1" style={{ color: 'var(--ink-faint)' }}>
                <span className="h-1 w-1 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary)' }} />
                {notice || status}
              </span>
            ) : null}
          </div>
        ) : null}
        {!busy && notice ? (
          <div className="mt-1 text-10" style={{ color: 'var(--danger)' }}>
            {notice}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs" style={{ color: 'var(--ink-faint)' }}>
            {busy ? (
              /* 起搜到候选回来之间还有几秒：这一档不能写成「还没有检索记录」，
                 否则点下去的那一瞬间面板在说反话。 */
              <>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1 w-1 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary)' }} />
                  <span className="h-1 w-1 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary)', animationDelay: '150ms' }} />
                  <span className="h-1 w-1 animate-pulse rounded-full" style={{ backgroundColor: 'var(--primary)', animationDelay: '300ms' }} />
                </span>
                <div className="mt-1.5 text-10">{notice || status}</div>
              </>
            ) : (
              <>
                还没有检索记录
                <div className="mt-1 text-10">在联系人列输入关键词，点「Search WeChat Articles」</div>
              </>
            )}
          </div>
        ) : (
          <>
            <TraceSection label="留下" rows={kept} tone="var(--primary-strong)" onOpen={onOpen} />
            {/* 判定中 / 未判定：检索被验证码拦下时 enrich 根本没跑，这些篇目既不留下也没被判掉，
                得照常列出来（否则面板只剩头部计数、看起来像没搜到东西）。 */}
            <TraceSection
              label={busy ? '判定中' : '未判定'}
              rows={pending}
              tone="var(--ink-faint)"
              onOpen={onOpen}
            />
            <TraceSection label="去除" rows={dropped} tone="var(--ink-muted)" onOpen={onOpen} />
          </>
        )}
      </div>
    </div>
  );
}
