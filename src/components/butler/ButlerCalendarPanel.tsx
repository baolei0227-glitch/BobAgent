'use client';

/**
 * ButlerCalendarPanel —— 抽屉内的精简日历（**上：月历网格 / 下：当日待办**）
 *
 * 与画布 CalendarPanel（2437 行：月/周视图 + 搜索 + 同步账户 + ICS 导入 + 事件编辑器）**分工而非重复**：
 *   - 那个是「应用级日历」，什么都能干，从侧边栏进；
 *   - 本面板是**助理视角的一天**：上面点日期，下面只看那天的待办 —— 回答「这天还有什么没做」。
 * 所以这里刻意不做：周视图、搜索、同步、新建/改期、事件编辑器。要那些就去应用日历。
 *
 * 数据与写操作全部复用 `/api/calendar/events`（与 CalendarPanel 同源同路由，不新增后端面）：
 *   - `GET ?range_start&range_end`（ISO）→ 区间事件
 *   - `PATCH ?event_id` body `{status}` → 勾选完成 / 取消完成
 *   - `DELETE ?event_id` → 软删（服务端置 status='cancelled'）
 * 写后与 CalendarPanel 一样广播两个全局事件（`calendar-events-changed` 让便签层重载、
 * `butler-event-sync` 让收件箱对应条目联动），见 CalendarPanel.tsx:956-980。
 *
 * 日期口径刻意与 CalendarPanel 完全对齐，避免跨时区串天：
 *   - 拉取区间用 `Date.toISOString()`
 *   - 归日分组用 `toLocalDateStr(new Date(start_time))`（本地日）
 *
 * 一点与画布日历的**有意差异**：
 *   - 网格固定 6 行（42 格）：画布版按 `ceil((首日星期 + 天数)/7)` 变行数，切月时高度会跳；
 *     这里固定行数，保证下方「当日待办」不被上下推挤。
 *
 * 「屏蔽已完成」口径与画布日历**完全同源**（`CalendarPanel.tsx:252-253`）：默认隐藏、只影响展示
 * 不改数据、且**同时作用于日格小圆点与当日列表**（画布同样是从 `visibleEvents` 建分组，见
 * `CalendarPanel.tsx:987-1001`）；区别仅在已完成项的呈现（这里沉底 + 灰 + 删除线）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Eye, EyeClosed, Flag, Trash2 } from 'lucide-react';

/** 前端事件结构（只取本面板用得到的字段） */
interface CalEvent {
  event_id: string;
  title: string;
  start_time: string | null;
  end_time: string | null;
  all_day: boolean;
  status: 'scheduled' | 'done' | 'cancelled';
  priority: 'high' | 'normal' | 'low';
  color: string | null;
  /** 来源锚点：kind='sticky' = 由便签待办行入日历 */
  source_ref: string | null;
}

/** 周日为第一列（对齐 CalendarPanel 的 `monthStart.getDay()` 口径） */
const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
/** 固定 6 行网格 */
const GRID_DAYS = 42;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地日 YYYY-MM-DD（与 CalendarPanel.tsx:127 同口径） */
function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地 HH:mm */
function hhmm(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 完成/取消沉底 */
function statusRank(s: CalEvent['status']): number {
  return s === 'scheduled' ? 0 : s === 'done' ? 1 : 2;
}

/** 是否来自便签待办行（source_ref 的 kind='sticky'） */
function isStickySourced(ev: CalEvent): boolean {
  if (!ev.source_ref) return false;
  try {
    return (JSON.parse(ev.source_ref) as { kind?: string } | null)?.kind === 'sticky';
  } catch {
    return false;
  }
}

/** 标识色：未完成才有色（便签来源用暖黄，其余用事件自身分类色），已完成/取消统一灰；由勾选圆圈承载 */
function accentColor(ev: CalEvent): string {
  if (ev.status !== 'scheduled') return 'var(--ink-faint)';
  if (isStickySourced(ev)) return 'var(--warn)';
  return ev.color || 'var(--primary)';
}

/** 选中日的「9月25日 · 周五」 */
function dayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK_LABELS[d.getDay()]}`;
}

export function ButlerCalendarPanel() {
  const [viewDate, setViewDate] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState(() => toLocalDateStr(new Date()));
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在写库的事件 id（防连点） */
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * 计划是否已过期：读 `/api/calendar/schedule` 的 `meta.status`。
   * 任何任务/日程变更都会把计划置 stale，排程器 3s 去抖后自动重排并复位 ——
   * 这里只在「过期」时给一条提示与手动重排入口（等待中不打扰用户）。
   */
  const [planStale, setPlanStale] = useState(false);
  const [replanning, setReplanning] = useState(false);
  /**
   * 「屏蔽已完成」：与画布日历同源（`CalendarPanel.tsx:252-253`）——
   * **默认隐藏**、只影响展示不改数据，且同时作用于日格圆点与当日列表。
   * 需要取消误勾时点标题栏眼睛按钮展开即可。
   */
  const [hideCompleted, setHideCompleted] = useState(true);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  /** 本月 1 号是周几（0=周日） */
  const firstWeekday = useMemo(() => new Date(year, month, 1).getDay(), [year, month]);
  const todayStr = toLocalDateStr(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    // 拉取区间 = 网格首格 00:00 → 末格次日 00:00（覆盖前后月露出的那几天）
    const rangeStart = new Date(year, month, 1 - firstWeekday);
    const rangeEnd = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + GRID_DAYS);
    try {
      const res = await fetch(
        `/api/calendar/events?scope=all&range_start=${rangeStart.toISOString()}&range_end=${rangeEnd.toISOString()}`,
      );
      const data = await res.json();
      if (!data?.success) {
        setError(data?.error ?? '读取日历失败');
        setEvents([]);
        return;
      }
      setEvents((data.events ?? []) as CalEvent[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取日历失败');
      setEvents([]);
    } finally {
      setLoading(false);
    }
    // 排程计划状态（与事件分开拉：失败不影响日历本体）
    try {
      const res = await fetch('/api/calendar/schedule');
      const data = await res.json();
      setPlanStale(data?.success === true && data?.meta?.status === 'stale');
    } catch {
      setPlanStale(false);
    }
  }, [year, month, firstWeekday]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 计划过期 → 排程器 3s 内会自动重排；稍后回读一次把提示收掉（不轮询） */
  useEffect(() => {
    if (!planStale) return;
    const timer = window.setTimeout(() => void load(), 4500);
    return () => window.clearTimeout(timer);
  }, [planStale, load]);

  /** 手动重排：立即运行排程器（等价于 Butler 的 plan_schedule） */
  const replan = useCallback(async () => {
    if (replanning) return;
    setReplanning(true);
    try {
      const res = await fetch('/api/calendar/schedule', { method: 'POST' });
      const data = await res.json();
      if (data?.success !== true) setError(data?.error ?? 'Replan failed');
      await load();
      window.dispatchEvent(new Event('calendar-events-changed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Replan failed');
    } finally {
      setReplanning(false);
    }
  }, [replanning, load]);

  // 其他界面（画布日历 / 便签 / Butler 排程回执）改了事件 → 本面板跟随刷新
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener('calendar-events-changed', onChanged);
    return () => window.removeEventListener('calendar-events-changed', onChanged);
  }, [load]);

  /** 展示用事件：屏蔽开启时滤掉 done（与画布 CalendarPanel.tsx:987 同一处口径） */
  const visibleEvents = useMemo(
    () => (hideCompleted ? events.filter((ev) => ev.status !== 'done') : events),
    [events, hideCompleted],
  );

  /** 归日分组（本地日）基于 **visibleEvents**（画布 CalendarPanel.tsx:989 亦然）；这里只防御 start_time 为空的行 */
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const ev of visibleEvents) {
      if (!ev.start_time) continue;
      const key = toLocalDateStr(new Date(ev.start_time));
      const arr = map.get(key);
      if (arr) arr.push(ev);
      else map.set(key, [ev]);
    }
    return map;
  }, [visibleEvents]);

  /** 选中日的事件：未完成 → 已完成 排序（组内全天优先、再按时间） */
  const dayEvents = useMemo(() => {
    const list = (eventsByDate.get(selectedDate) ?? []).slice();
    list.sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
      return (a.start_time ?? '').localeCompare(b.start_time ?? '');
    });
    return list;
  }, [eventsByDate, selectedDate]);

  const doneCount = dayEvents.filter((ev) => ev.status === 'done').length;
  const openCount = dayEvents.length - doneCount;

  /** 被屏蔽掉的已完成条数：仅用于提示，避免用户看图以为「这天没安排」 */
  const foldedDoneCount = useMemo(() => {
    if (!hideCompleted) return 0;
    return events.filter(
      (ev) =>
        ev.status === 'done' &&
        !!ev.start_time &&
        toLocalDateStr(new Date(ev.start_time)) === selectedDate,
    ).length;
  }, [hideCompleted, events, selectedDate]);

  /** 该日是否还有未完成安排（决定小圆点的颜色） */
  const dayDot = useCallback(
    (dateStr: string): 'open' | 'done' | 'none' => {
      const list = eventsByDate.get(dateStr);
      if (!list || list.length === 0) return 'none';
      return list.some((ev) => ev.status === 'scheduled') ? 'open' : 'done';
    },
    [eventsByDate],
  );

  const shiftMonth = useCallback((delta: number) => {
    setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  }, []);

  const goToday = useCallback(() => {
    const now = new Date();
    setViewDate(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(toLocalDateStr(now));
  }, []);

  /** 勾选/取消完成 */
  const toggleDone = useCallback(
    async (ev: CalEvent) => {
      if (busyId) return;
      const next = ev.status === 'done' ? 'scheduled' : 'done';
      setBusyId(ev.event_id);
      try {
        await fetch(`/api/calendar/events?event_id=${encodeURIComponent(ev.event_id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        await load();
        // 通知全局：日历已变更（便签层据此重载）
        window.dispatchEvent(new Event('calendar-events-changed'));
        // 联动 Butler 收件箱：标记完成 → 引用该事件的回执条目自动完成
        if (next === 'done') {
          window.dispatchEvent(
            new CustomEvent('butler-event-sync', { detail: { eventId: ev.event_id, action: 'done' } }),
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '更新失败');
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load],
  );

  /** 删除（服务端软删 → status='cancelled'，区间查询即不再返回） */
  const removeEvent = useCallback(
    async (ev: CalEvent) => {
      if (busyId) return;
      setBusyId(ev.event_id);
      try {
        await fetch(`/api/calendar/events?event_id=${encodeURIComponent(ev.event_id)}`, { method: 'DELETE' });
        await load();
        window.dispatchEvent(new Event('calendar-events-changed'));
        window.dispatchEvent(
          new CustomEvent('butler-event-sync', { detail: { eventId: ev.event_id, action: 'deleted' } }),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : '删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load],
  );

  const navBtn =
    'flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]';

  return (
    <div className="flex h-full flex-col">
      {/* ── 月历头 ── */}
      <div className="flex shrink-0 items-center justify-between px-3 pb-1.5 pt-2.5">
        <span className="text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>
          {year} 年 {month + 1} 月
        </span>
        <div className="flex items-center gap-1">
          {/* 屏蔽已完成事项：与画布日历同款眼睛按钮（仅切换展示，灰色不用品牌色高亮） */}
          <button
            type="button"
            className={navBtn}
            style={{ color: 'var(--ink-muted)' }}
            aria-pressed={hideCompleted}
            title={hideCompleted ? '显示已完成事项' : '屏蔽已完成事项'}
            aria-label={hideCompleted ? '显示已完成事项' : '屏蔽已完成事项'}
            onClick={() => setHideCompleted((v) => !v)}
          >
            {hideCompleted ? <EyeClosed className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className={navBtn}
            style={{ color: 'var(--ink-muted)' }}
            onClick={() => shiftMonth(-1)}
            title="上个月"
            aria-label="上个月"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-md px-1.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink-muted)' }}
            onClick={goToday}
          >
            今天
          </button>
          <button
            type="button"
            className={navBtn}
            style={{ color: 'var(--ink-muted)' }}
            onClick={() => shiftMonth(1)}
            title="下个月"
            aria-label="下个月"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── 月历网格（固定 6 行） ── */}
      <div className="shrink-0 px-2.5">
        <div className="grid grid-cols-7 gap-x-0.5">
          {WEEK_LABELS.map((w) => (
            <div key={w} className="py-1 text-center text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-x-0.5 gap-y-0.5">
          {Array.from({ length: GRID_DAYS }).map((_, i) => {
            const cellDate = new Date(year, month, 1 - firstWeekday + i);
            const ds = toLocalDateStr(cellDate);
            const inMonth = cellDate.getMonth() === month;
            const isToday = ds === todayStr;
            const isSelected = ds === selectedDate;
            const dot = dayDot(ds);
            return (
              <div
                key={ds}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={dayLabel(ds)}
                className="flex h-[34px] cursor-pointer flex-col items-center justify-center rounded-lg border transition-colors hover:bg-[var(--paper-hover)]"
                style={{
                  borderColor: isSelected ? 'var(--primary)' : 'transparent',
                  backgroundColor: isSelected ? 'var(--primary-soft)' : 'transparent',
                  opacity: inMonth ? 1 : 0.4,
                }}
                onClick={() => setSelectedDate(ds)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedDate(ds);
                  }
                }}
              >
                <span
                  className="text-[11px] font-medium leading-none"
                  style={{
                    color: isToday ? 'var(--paper)' : 'var(--ink)',
                    backgroundColor: isToday ? 'var(--primary)' : 'transparent',
                    borderRadius: 9999,
                    width: isToday ? 16 : undefined,
                    height: isToday ? 16 : undefined,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {cellDate.getDate()}
                </span>
                <span
                  className="mt-[3px] h-[3px] w-[3px] rounded-full"
                  style={{
                    backgroundColor:
                      dot === 'open' ? 'var(--primary)' : dot === 'done' ? 'var(--ink-faint)' : 'transparent',
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 计划过期提示（仅 stale 时出现；排程器 3s 内会自动重排） ── */}
      {planStale && (
        <div
          className="mt-2 flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5"
          style={{ backgroundColor: 'var(--warn-soft)' }}
        >
          <span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--warn)' }}>
            Plan may be out of date
          </span>
          <button
            type="button"
            className="flex-none rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--warn)' }}
            disabled={replanning}
            onClick={() => void replan()}
          >
            {replanning ? 'Replanning…' : 'Replan'}
          </button>
        </div>
      )}

      {/* ── 当日待办 ── */}
      <div
        className="mt-2 flex shrink-0 items-baseline justify-between border-t px-3 pb-1 pt-2.5"
        style={{ borderColor: 'var(--line)' }}
      >
        <span className="text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>
          {dayLabel(selectedDate)}
        </span>
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--ink-muted)' }}>
          {dayEvents.length === 0
            ? foldedDoneCount > 0
              ? `${foldedDoneCount} 项已完成 · 已屏蔽`
              : '无安排'
            : doneCount > 0
              ? `${openCount} 项待办 · ${doneCount} 项已完成`
              : `${openCount} 项待办`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {error && (
          <p className="px-1 py-2 text-[11px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        {!error && dayEvents.length === 0 && (
          <p className="px-1 py-3 text-[11px]" style={{ color: 'var(--ink-faint)' }}>
            {loading
              ? '载入中…'
              : foldedDoneCount > 0
                ? `已完成 ${foldedDoneCount} 项（已屏蔽，点标题栏眼睛可展开）`
                : '这天没有安排'}
          </p>
        )}
        <div className="flex flex-col gap-0.5">
          {dayEvents.map((ev) => {
            const finished = ev.status === 'done';
            return (
              <div
                key={ev.event_id}
                className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-[var(--paper-hover)]"
              >
                {/* 勾选圆圈直接承载标识色（取代原左侧色条：未完成才有色；便签来源暖黄） */}
                <button
                  type="button"
                  className="flex flex-none items-center"
                  title={finished ? '取消完成' : '标记完成'}
                  aria-label={finished ? '取消完成' : '标记完成'}
                  disabled={busyId === ev.event_id}
                  onClick={() => void toggleDone(ev)}
                >
                  {finished ? (
                    <CheckCircle2 className="h-3.5 w-3.5" style={{ color: accentColor(ev) }} />
                  ) : (
                    <Circle className="h-3.5 w-3.5" style={{ color: accentColor(ev) }} />
                  )}
                </button>
                <span
                  className="w-9 flex-none text-[11px] tabular-nums"
                  style={{ color: 'var(--ink-faint)' }}
                >
                  {ev.all_day ? '全天' : hhmm(ev.start_time)}
                </span>
                <span
                  className="min-w-0 flex-1 break-words text-xs"
                  style={{
                    color: finished ? 'var(--ink-faint)' : 'var(--ink)',
                    textDecoration: finished ? 'line-through' : 'none',
                  }}
                >
                  {ev.priority === 'high' && !finished && (
                    <span className="mr-1" style={{ color: 'var(--warn)' }} title="高优先级">
                      ●
                    </span>
                  )}
                  {ev.title}
                  {/* 开庭标旗：标题含「开庭」的法院事项，标题右侧补一面小红旗。
                      与画布日历 priority='high' 的标旗同色（红）；这里按标题主题识别，
                      不依赖 priority —— Butler 对话里排出的开庭未必带高优先级。 */}
                  {!finished && ev.title.includes('开庭') && (
                    <Flag
                      aria-hidden
                      className="ml-1 inline-block h-2.5 w-2.5 align-middle"
                      style={{ color: 'var(--danger)' }}
                      fill="currentColor"
                    />
                  )}
                </span>
                <button
                  type="button"
                  className="flex-none opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: 'var(--ink-muted)' }}
                  title="删除"
                  aria-label="删除"
                  disabled={busyId === ev.event_id}
                  onClick={() => void removeEvent(ev)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
