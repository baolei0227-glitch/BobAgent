'use client';

/**
 * ButlerTodayPanel —— Today 页（Butler 助理的首屏）
 *
 * 设计取向：
 *   - **首屏直接进日报**：打开即 Report / Schedule / Sticky 三页签，顶部不再有蓝色建议卡
 *     （2026-09-27 按要求移除：那块「有 N 项逾期未完成… / Take action」占掉首屏又只给一条建议）。
 *   - **承载整份日报（2026-09-27）**：三个页签搬到这里，通知助理 Bobby 不再推送日报；
 *     Schedule / Sticky 的行可直接勾选完成（写入落到日历事件 / 便签行，见下方 toggleItem）。
 *   - 原先底部的「收件箱」「报告文档」两块已移除（2026-09-27）—— 收件箱走抽屉，报告文档走文件面板。
 *
 * 排版层级（与右栏日报同一套口径）：
 *   分区头（深色半粗 + 计数徽标）> 扁平行（无底色）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { TodaySnapshot } from '@/lib/butler/today';
import type { ButlerNoticeItem } from '@/lib/bus';
import { StreamingMarkdown } from '@/components/canvas/HtmlRenderer';

/** /api/butler/today 的 reports 段：日报三页签的内容（2026-09-27 起整份日报由 Today 承载） */
interface TodayReports {
  /** 各项目昨日进展摘要（每日 9:00 生成一次并缓存）；未生成时为 null */
  progress: { markdown: string } | null;
  schedule: { text: string; items: ButlerNoticeItem[] };
  /** 便签待办实算失败时为 null（该页签退化成一行提示） */
  sticky: { text: string; items: ButlerNoticeItem[]; totalPending: number; projectCount: number } | null;
}

/** 日报三页签（顺序与 lib/butler/report-group.ts 的 REPORT_SECTION_ORDER 一致） */
type ReportTab = 'report' | 'schedule' | 'sticky';
const REPORT_TABS: readonly { key: ReportTab; label: string }[] = [
  { key: 'report', label: 'Report' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'sticky', label: 'Sticky' },
];

/** Schedule 页每个分区默认列出的条数：余下的折成一行可点的「N more」（逾期动辄几十条，全铺开会淹掉 Today） */
const SCHEDULE_PREVIEW = 10;

export interface ButlerTodayPanelProps {
  /** 独立浮窗模式的关闭回调；嵌入抽屉栏时省略（关闭由抽屉统一提供） */
  onClose?: () => void;
  /** 嵌入抽屉栏：去掉 fixed/锚定/阴影/圆角，填满父容器 */
  embedded?: boolean;
}

/** 本地时间 HH:mm */
function fmtHM(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** 毫秒时间戳 → 本地 HH:mm（sticky 项只有 startMs，没有可读 time） */
function hhmmFromMs(ms: number): string {
  return fmtHM(new Date(ms));
}

/** 独立浮窗默认样式（embedded 时改为填满父栏，由抽屉提供边框与背景） */
function panelStyle(embedded?: boolean): React.CSSProperties {
  if (embedded) {
    return {
      width: '100%',
      height: '100%',
      overflowY: 'auto',
      padding: 16,
      color: 'var(--foreground)',
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
    };
  }
  return {
    position: 'fixed',
    right: 20,
    top: 64,
    width: 360,
    maxHeight: 'calc(100vh - 108px)',
    overflowY: 'auto',
    padding: 16,
    borderRadius: 16,
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    boxShadow: '0 18px 48px rgba(0,0,0,0.18)',
    color: 'var(--foreground)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    zIndex: 1200,
  };
}

/** 日期行：嵌入态的一级标题由抽屉顶部条承担，这里只留日期当次级信息 */
const dateLine: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-faint)',
  marginBottom: 12,
};

/** 分区头整行（名 + 计数徽标），上方留白拉开分区 */
const sectionHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  margin: '16px 0 6px',
};
/** 分区名：一级，深色半粗 —— 比它统领的行更重 */
const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--ink-strong)',
};
/** 计数：二级，退成小徽标 */
const countBadge: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  padding: '1px 6px',
  borderRadius: 999,
  background: 'var(--paper-hover)',
  color: 'var(--ink-muted)',
};
/** 逾期徽标：同尺寸，换成 warn 底色以示「这类要盯」 */
const countBadgeWarn: React.CSSProperties = {
  ...countBadge,
  background: 'color-mix(in oklab, var(--warn) 14%, transparent)',
  color: 'var(--warn)',
};

/** 分区头：名 + 计数徽标（warn 变体用于逾期） */
function SectionHead({ label, count, warn }: { label: string; count?: number | string; warn?: boolean }) {
  return (
    <div style={sectionHead}>
      <span style={sectionLabel}>{label}</span>
      {count !== undefined && <span style={warn ? countBadgeWarn : countBadge}>{count}</span>}
    </div>
  );
}

/** 日报三页签的页签条（底色胶囊 + 选中项浮起，与右栏日报页签同观感） */
const tabBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  borderRadius: 8,
  padding: 2,
  background: 'var(--paper-hover)',
};
function tabBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '4px 8px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 11,
    fontWeight: 500,
    background: active ? 'var(--panel-bg)' : 'transparent',
    color: active ? 'var(--ink-strong)' : 'var(--ink-muted)',
  };
}

/** 页签条吸顶容器：面板自身就是滚动区（embedded 时 overflow-y:auto），页签滚出视野后
 *  就不知道自己在哪一页 —— 用 sticky 钉在滚动区顶端。横向负边距 + 等量内边距，让不透明底色
 *  铺满整宽（否则被截断的行会从页签两侧透出来）。底色与抽屉右栏 / 浮窗面板同为 --popover，
 *  吸顶时看不出接缝；下沿一道细线标示「这条是固定的」。（同 McpStorePanel 的吸顶头部写法。） */
const tabSticky: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  marginLeft: -16,
  marginRight: -16,
  paddingLeft: 16,
  paddingRight: 16,
  paddingBottom: 8,
  background: 'var(--popover)',
  borderBottom: '1px solid var(--line-soft)',
};

/** 可勾选待办行：点整行即完成/取消 —— 与 ButlerDrawer.toggleItem 的交互一致，
 *  但 Today 面板没有收件箱回执，勾选后只更新本地列表（不再 PATCH inbox）。 */
function ItemRow({ item, onToggle }: { item: ButlerNoticeItem; onToggle: (it: ButlerNoticeItem) => void }) {
  const done = item.status === 'done';
  const meta = item.time || (item.startMs > 0 ? hhmmFromMs(item.startMs) : '');
  return (
    <button
      type="button"
      onClick={() => onToggle(item)}
      className="hover:bg-[var(--paper-hover)]"
      style={{
        ...rowStyle,
        width: '100%',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <CheckCircle2
        size={13}
        style={{ flexShrink: 0, marginTop: 2, color: done ? 'var(--success)' : 'var(--ink-faint)' }}
      />
      <span
        style={{
          ...rowTitle,
          color: done ? 'var(--ink-faint)' : 'var(--ink-strong)',
          textDecoration: done ? 'line-through' : undefined,
        }}
      >
        {item.title}
        {item.subgroup && (
          <span style={{ display: 'block', fontSize: 10, color: 'var(--ink-faint)' }}>{item.subgroup}</span>
        )}
      </span>
      {meta && <span style={rowMeta}>{meta}</span>}
    </button>
  );
}

/** 行：**无底色**（底色只留给建议卡，别让每行都自成一块），靠字重与缩进分主次 */
const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'baseline',
  padding: '5px 6px',
  borderRadius: 8,
  marginBottom: 1,
};
/** 行内正文：一级 */
const rowTitle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  color: 'var(--ink-strong)',
};
/** 行内次要信息（时间 / 类型 / 大小）：二级 */
const rowMeta: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--ink-faint)',
};

/** 空态 / 补充说明行 */
const emptyRow: React.CSSProperties = {
  padding: '4px 6px',
  fontSize: 11.5,
  color: 'var(--ink-faint)',
};

/** 分区内的「展开更多」：长得像行，但是可点（做成一枚按钮，不再是不可点的说明文字） */
const moreBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '4px 6px',
  marginTop: 1,
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--ink-muted)',
  fontSize: 11.5,
  cursor: 'pointer',
};

/** 读取中 / 出错提示 */
const hintText: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-faint)',
};

const closeBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--muted-foreground)',
  cursor: 'pointer',
  fontSize: 14,
  padding: '2px 6px',
  borderRadius: 6,
};

export function ButlerTodayPanel({ onClose, embedded }: ButlerTodayPanelProps) {
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [reports, setReports] = useState<TodayReports | null>(null);
  const [tab, setTab] = useState<ReportTab>('schedule');
  /** Schedule 页各分区是否已展开（默认只列前 SCHEDULE_PREVIEW 条，点「+N more」摊开余下部分） */
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/butler/today');
        const data = await res.json();
        if (cancelled) return;
        if (!data?.success) {
          setError(data?.error ?? 'Failed to load today overview');
          return;
        }
        setSnapshot(data.snapshot as TodaySnapshot);
        const rep = (data.reports as TodayReports | undefined) ?? null;
        setReports(rep);
        // Report 摘要已经渲染出来 → 通知宿主清掉左栏 Today 键的红点（红点逻辑见 ButlerDrawer）
        if (rep?.progress) window.dispatchEvent(new Event('butler-today-digest-loaded'));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load today overview');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 勾选一条待办（Schedule / Sticky 两页签共用）：与 ButlerDrawer.toggleItem 同源 ——
   *   - source='event'：key 即日历事件 id → PATCH 事件状态，日历 / 便签侧随之联动；
   *   - source='sticky'：便签待办行 → 勾掉便签正文对应行，该行已入日历则事件同步完成。
   * 区别：Today 面板没有收件箱回执行，勾选后只翻转本地列表状态，不再 PATCH inbox。
   */
  const toggleItem = useCallback((item: ButlerNoticeItem) => {
    const done = item.status !== 'done';
    setReports((prev) => {
      if (!prev) return prev;
      const flip = (items: ButlerNoticeItem[]) =>
        items.map((it) => (it.key === item.key ? { ...it, status: done ? 'done' : '' } : it));
      return {
        ...prev,
        schedule: { ...prev.schedule, items: flip(prev.schedule.items) },
        sticky: prev.sticky ? { ...prev.sticky, items: flip(prev.sticky.items) } : prev.sticky,
      };
    });
    if (item.source === 'event' && item.key) {
      const eventId = item.key;
      void fetch(`/api/calendar/events?event_id=${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: done ? 'done' : 'scheduled' }),
      })
        .then(() => {
          window.dispatchEvent(new Event('calendar-events-changed'));
          if (done) {
            window.dispatchEvent(new CustomEvent('butler-event-sync', { detail: { eventId, action: 'done' } }));
          }
        })
        .catch(() => undefined);
      return;
    }
    if (item.source === 'sticky' && item.sticky) {
      const s = item.sticky;
      void fetch('/api/sticky-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggle_line',
          project_id: s.projectId,
          note_id: s.noteId,
          page_id: s.pageId,
          line_index: s.lineIndex,
          text: s.text,
          done,
        }),
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { success?: boolean };
          if (!data.success) return;
          // 该行可能已入日历 → 广播重载日历 / 便签画布
          window.dispatchEvent(new Event('calendar-events-changed'));
        })
        .catch(() => undefined);
    }
  }, []);

  /** Sticky 页签：按项目分组（与右栏日报 Sticky 页同一铺平口径，见 buildStickyTodoItems） */
  const stickyGroups = useMemo(() => {
    const byGroup = new Map<string, ButlerNoticeItem[]>();
    for (const it of reports?.sticky?.items ?? []) {
      const g = it.group ?? '';
      const arr = byGroup.get(g);
      if (arr) arr.push(it);
      else byGroup.set(g, [it]);
    }
    return [...byGroup.entries()];
  }, [reports]);

  const dateLabel = new Date().toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    // hide-scrollbar：面板靠右贴边，原生滚动条会压在最右一列的文字上（见 globals.css 的工具类）
    <aside className="hide-scrollbar" style={panelStyle(embedded)} role="dialog" aria-label="Today overview">
      {/* 面板自身不再有任何头部（2026-09-27 按要求去掉嵌入态那行日期）：
          嵌入右栏时顶部条已写着「Today」，面板再顶一行日期只是占地方 —— 现在打开即三页签。
          独立浮窗态仍自带完整标题（Today + 日期 + 关闭），该分支目前无调用方，保留以备浮窗复用。 */}
      {!embedded && (
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-strong)' }}>Today</div>
            <div style={{ ...dateLine, margin: '2px 0 0' }}>{dateLabel}</div>
          </div>
          {onClose && (
            <button type="button" onClick={onClose} style={closeBtn} aria-label="Close">
              ✕
            </button>
          )}
        </header>
      )}

      {loading && <p style={hintText}>Loading today…</p>}
      {error && <p style={{ ...hintText, color: 'var(--danger)' }}>{error}</p>}

      {!loading && !error && snapshot && (
        <>
          {/* 日报三页签（2026-09-27 起整份日报由 Today 承载，Bobby 不再推送）：
              Report=各项目昨日进展 / Schedule=今日 + 逾期待办 / Sticky=全项目便签待办。
              原先顶层的「今天 / 逾期」两块并进 Schedule 页，不再重复占版面。 */}
          {reports && (
            <>
              <div style={{ ...tabSticky, marginTop: embedded ? 0 : 14 }}>
                <div style={tabBar}>
                  {REPORT_TABS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.key}
                      onClick={() => setTab(t.key)}
                      style={tabBtnStyle(tab === t.key)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {tab === 'report' &&
                (reports.progress ? (
                  // butler-report：Report 页是三个页签里唯一直接渲染 markdown 的，
                  // 靠这个类把小结 blockquote 渲染成柔和底卡、并拉开与明细的层级（见 globals.css）。
                  <div className="butler-md butler-report" style={{ marginTop: 10 }}>
                    <StreamingMarkdown content={reports.progress.markdown} streaming={false} />
                  </div>
                ) : (
                  <div style={{ ...emptyRow, marginTop: 10 }}>Progress digest not generated yet (runs daily after 9:00)</div>
                ))}

              {tab === 'schedule' && (
                <div style={{ marginTop: 6 }}>
                  {(
                    [
                      { sec: 'today', label: 'Today', total: snapshot.today.count },
                      { sec: 'overdue', label: 'Overdue', total: snapshot.overdue.count },
                    ] as const
                  ).map(({ sec, label, total }) => {
                    const rows = reports.schedule.items.filter((x) => (x.section ?? 'overdue') === sec);
                    const opened = !!expandedSections[sec];
                    const shown = opened ? rows : rows.slice(0, SCHEDULE_PREVIEW);
                    const folded = rows.length - shown.length;
                    return (
                      <div key={sec}>
                        <SectionHead label={label} count={total} warn={sec === 'overdue' && total > 0} />
                        {rows.length === 0 ? (
                          <div style={emptyRow}>{sec === 'today' ? 'No events today' : 'Nothing overdue'}</div>
                        ) : (
                          <>
                            {shown.map((x) => (
                              <ItemRow key={x.key} item={x} onToggle={toggleItem} />
                            ))}
                            {/* 折叠的余下条目点一下就摊开（此前这里是一行不可点的说明文字，用户没法看到被截掉的待办） */}
                            {folded > 0 && (
                              <button
                                type="button"
                                className="hover:bg-[var(--paper-hover)]"
                                style={moreBtn}
                                onClick={() => setExpandedSections((p) => ({ ...p, [sec]: true }))}
                              >
                                {folded} more …
                              </button>
                            )}
                            {opened && rows.length > SCHEDULE_PREVIEW && (
                              <button
                                type="button"
                                className="hover:bg-[var(--paper-hover)]"
                                style={moreBtn}
                                onClick={() => setExpandedSections((p) => ({ ...p, [sec]: false }))}
                              >
                                Show less
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {tab === 'sticky' && (
                <div style={{ marginTop: 6 }}>
                  {!reports.sticky ? (
                    <div style={emptyRow}>Failed to load sticky todos — try again later</div>
                  ) : stickyGroups.length === 0 ? (
                    <div style={emptyRow}>
                      {reports.sticky.totalPending === 0 ? 'All sticky todos are done' : 'Nothing to list'}
                    </div>
                  ) : (
                    stickyGroups.map(([group, rows]) => {
                      const left = rows.filter((x) => x.status !== 'done').length;
                      return (
                        <div key={group || 'ungrouped'}>
                          <SectionHead label={group || 'Untitled project'} count={left > 0 ? left : `✓ ${rows.length}`} />
                          {rows.map((x) => (
                            <ItemRow key={x.key} item={x} onToggle={toggleItem} />
                          ))}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </>
          )}

          {snapshot.degraded.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--warn)' }}>
              Some data sources unavailable: {snapshot.degraded.join('; ')}
            </div>
          )}
        </>
      )}
    </aside>
  );
}