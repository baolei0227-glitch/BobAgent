'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
  Search,
  Calendar,
  Clock,
  MapPin,
  Tag,
  Loader2,
  Trash,
  CheckCircle2,
  Circle,
  XCircle,
  RefreshCw,
  Upload,
  Download,
  Link2,
  Settings2,
  ScrollText,
  MoreHorizontal,
  Check,
} from 'lucide-react';
import { Callout } from '@/components/ui/callout';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import NodeCardHeader from './NodeCardHeader';

/** 前端事件结构 */
interface CalendarEvent {
  event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_time: string;
  end_time: string | null;
  all_day: boolean;
  status: 'scheduled' | 'done' | 'cancelled';
  priority: 'high' | 'normal' | 'low';
  color: string | null;
  tags: string[];
  /** 提前提醒分钟数（如 [30] = 开始前 30 分钟；空 = 默认 [30]） */
  reminder_minutes?: number[];
  source_raw: string | null;
  created_at: string;
  updated_at: string;
}

type EditMode = { event_id: string } | { date: string } | null;

interface CalendarPanelProps {
  projectId: string;
  onClose: () => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS_ICONS: Record<string, React.FC<{ className?: string }>> = {
  scheduled: Circle,
  done: CheckCircle2,
  cancelled: XCircle,
};
const PRIORITY_LABELS: Record<string, string> = { high: 'High', normal: 'Normal', low: 'Low' };

/** 提前提醒预设（分钟）：可多选，默认选中 30 min */
const REMINDER_PRESETS: { label: string; value: number }[] = [
  { label: '10 min', value: 10 },
  { label: '30 min', value: 30 },
  { label: '1 h', value: 60 },
  { label: '2 h', value: 120 },
  { label: '1 day', value: 1440 },
  { label: '2 days', value: 2880 },
];

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 所在周的周一 00:00（周视图用） */
function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
}

/** 预设色板 */
const PRESET_COLORS = ['#F59E0B', '#EF4444', '#3B82F6', '#10B981', '#8B5CF6', '#EC4899', '#14B8A6', '#64748B'];

/** 周视图时间轴：每小时行高（px）与小时刻度 */
const HOUR_HEIGHT = 44;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** 事件底色：用 color-mix 生成半透明底色。
 *  兼容 hex / CSS 变量 / 任意颜色，避免 `颜色 + '18'` 这种拼接在非 hex 值上产生非法 CSS 而底色失效。 */
function eventTint(color: string | null | undefined, pct: number): string {
  const base = color && color.trim() ? color : 'var(--primary)';
  return `color-mix(in oklab, ${base} ${pct}%, transparent)`;
}

/** 事件文字样式：分类色交由左侧色条表达，文字统一中性色；完成/取消沉为灰 + 删除线 */
function eventTextStyle(status: CalendarEvent['status']): React.CSSProperties {
  const finished = status === 'done' || status === 'cancelled';
  return {
    color: finished ? 'var(--ink-faint)' : 'var(--ink)',
    textDecoration: finished ? 'line-through' : 'none',
  };
}

/** 分类色条取色：scheduled 用事件自身颜色，完成/取消统一灰 */
function eventBarColor(ev: CalendarEvent): string {
  return ev.status === 'scheduled' ? (ev.color || 'var(--primary)') : 'var(--ink-faint)';
}

/** 取 HH:mm */
function hhmm(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

/** 事件在一天内的起始分钟 */
function startMinutesOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** 事件持续分钟（缺 end / 跨天 / 异常值均做钳制，保证时间轴方块不溢出当天） */
function durationMinutesOf(ev: CalendarEvent, startMin: number): number {
  if (!ev.end_time) return 60;
  const raw = Math.round((new Date(ev.end_time).getTime() - new Date(ev.start_time).getTime()) / 60_000);
  if (!Number.isFinite(raw) || raw <= 0) return 60;
  return Math.min(raw, 24 * 60 - startMin);
}

export function CalendarPanel({ projectId, onClose }: CalendarPanelProps) {
  const [date, setDate] = useState(() => new Date());
  const panelRef = useRef<HTMLDivElement>(null);
  const [selectedDate, setSelectedDate] = useState<string>(() => toLocalDateStr(new Date()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [saving, setSaving] = useState(false);
  // 表单状态：结束日期（支持跨天事件）、表单内错误提示、面板级错误提示、删除确认
  const [formEndDate, setFormEndDate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CalendarEvent | null>(null);
  // 视图（月/周）与搜索
  const [view, setView] = useState<'month' | 'week'>('month');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CalendarEvent[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  // 面板宽度（左边缘可拖拽调整；默认 946px，受视口宽度约束）
  const [panelWidth, setPanelWidth] = useState(946);
  const resizingRef = useRef(false);
  // 同步操作菜单：Import / Export / Subscribe / Accounts / Logs 收进 ⋯，避免抢日历主视觉
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const syncMenuRef = useRef<HTMLDivElement>(null);
  // 周视图当前时刻指示线（客户端挂载后每分钟刷新，避免 SSR 水合不一致）
  const [now, setNow] = useState<Date | null>(null);
  const weekScrollRef = useRef<HTMLDivElement>(null);

  // 新建/编辑表单
  const [formTitle, setFormTitle] = useState('');
  const [formDate, setFormDate] = useState('');
  const [formStartTime, setFormStartTime] = useState('');
  const [formEndTime, setFormEndTime] = useState('');
  const [formAllDay, setFormAllDay] = useState(false);
  const [formPriority, setFormPriority] = useState<'high' | 'normal' | 'low'>('normal');
  const [formDescription, setFormDescription] = useState('');
  const [formLocation, setFormLocation] = useState('');
  const [formColor, setFormColor] = useState('#F59E0B');
  const [formTags, setFormTags] = useState('');
  // 提前提醒分钟数（可多选）；默认 [30] = 开始前 30 分钟
  const [formReminderMinutes, setFormReminderMinutes] = useState<number[]>([30]);

  const year = date.getFullYear();
  const month = date.getMonth();

  // 月份范围
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);

  // 补齐到完整周格（前面补上月的尾数，后面补下月的前面）
  const startDayOfWeek = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();
  const totalCells = Math.ceil((startDayOfWeek + daysInMonth) / 7) * 7;

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    // 按当前视图计算拉取范围
    let rangeStart: Date;
    let rangeEnd: Date;
    if (view === 'week') {
      const ws = startOfWeek(date);
      rangeStart = ws;
      rangeEnd = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7);
    } else {
      rangeStart = new Date(year, month, 1);
      rangeEnd = new Date(year, month + 2, 0, 23, 59, 59, 999);
    }
    try {
      const resp = await fetch(
        `/api/calendar/events?scope=all&range_start=${rangeStart.toISOString()}&range_end=${rangeEnd.toISOString()}`,
      );
      const data = await resp.json();
      if (data.success) {
        setEvents(data.events || []);
        setPanelError(null);
      } else {
        setPanelError(data.error || 'Failed to load events');
      }
    } catch (err) {
      console.error('fetchEvents error:', err);
      setPanelError(`Failed to load events: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [date, view, year, month]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // 监听任务面板导入事件
  useEffect(() => {
    const handler = () => fetchEvents();
    window.addEventListener('calendar-events-changed', handler);
    return () => window.removeEventListener('calendar-events-changed', handler);
  }, [fetchEvents]);

  // ===== 日历同步（.ics 导入导出 / CalDAV / WebCal）=====
  const [syncAccounts, setSyncAccounts] = useState<Array<Record<string, any>>>([]);
  const [syncLogs, setSyncLogs] = useState<Array<{ level: string; message: string; created_at: string }>>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showSubscribeModal, setShowSubscribeModal] = useState(false);
  const [showSyncLogs, setShowSyncLogs] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadSyncState = useCallback(async () => {
    try {
      const [accResp, feedResp] = await Promise.all([
        fetch('/api/calendar/accounts'),
        fetch('/api/calendar/feed').catch(() => null),
      ]);
      const data = await accResp.json();
      if (data.ok) {
        setSyncAccounts(data.accounts || []);
        setSyncLogs(data.logs || []);
      }
      if (feedResp?.ok) {
        const feed = await feedResp.json();
        if (feed.ok) setFeedToken(feed.token);
      }
    } catch (e) {
      console.error('loadSyncState error:', e);
    }
  }, []);

  useEffect(() => {
    loadSyncState();
  }, [loadSyncState]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const resp = await fetch('/api/calendar/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await resp.json();
      if (data.ok) {
        const results = data.results || [];
        setSyncMsg(
          results.length
            ? results.map((r: any) => `${r.name}: +${r.result.added}/~${r.result.updated}/-${r.result.deleted}`).join('  ')
            : 'No sync accounts configured',
        );
        fetchEvents();
      } else {
        setSyncMsg(data.error || 'Sync failed');
      }
    } catch (e) {
      setSyncMsg(`Sync error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      loadSyncState();
    }
  }, [fetchEvents, loadSyncState]);

  const handleImportFile = useCallback(async (file: File) => {
    const text = await file.text();
    setSyncing(true);
    setSyncMsg('Importing…');
    try {
      const resp = await fetch('/api/calendar/ics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: text }),
      });
      const data = await resp.json();
      if (data.ok) {
        setSyncMsg(`Imported: +${data.created} created, ~${data.updated} updated, ${data.skipped} skipped`);
        fetchEvents();
      } else {
        setSyncMsg(data.error || 'Import failed');
      }
    } catch (e) {
      setSyncMsg(`Import error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }, [fetchEvents]);

  const handleExport = useCallback(async () => {
    setSyncing(true);
    try {
      const resp = await fetch('/api/calendar/ics');
      if (!resp.ok) {
        setSyncMsg('Export failed');
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bobwork-events.ics';
      a.click();
      URL.revokeObjectURL(url);
      setSyncMsg('Exported .ics');
    } catch (e) {
      setSyncMsg(`Export error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }, []);

  // ===== 账户管理弹窗状态 =====
  const [feedToken, setFeedToken] = useState<string | null>(null);
  const [accForm, setAccForm] = useState({
    provider: 'caldav',
    name: '',
    username: '',
    password: '',
    server_url: '',
    calendar_url: '',
    read_only: false,
  });
  const [discovered, setDiscovered] = useState<Array<{ url: string; displayName: string; color: string | null }>>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  const discoverCalendars = useCallback(async () => {
    setAddBusy(true);
    setAddErr(null);
    try {
      const resp = await fetch('/api/calendar/accounts/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: accForm.username,
          password: accForm.password,
          principal_url: 'https://caldav.icloud.com',
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        setDiscovered(data.calendars || []);
        if (!data.calendars?.length) setAddErr('No calendars found. Check your Apple ID + app-specific password.');
      } else {
        setAddErr(data.error || 'Discover failed');
      }
    } catch (e) {
      setAddErr(`Discover error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAddBusy(false);
    }
  }, [accForm.username, accForm.password]);

  const addAccount = useCallback(async () => {
    setAddBusy(true);
    setAddErr(null);
    try {
      const body: Record<string, any> = {
        provider: accForm.provider,
        name: accForm.name || (accForm.provider === 'webcal' ? 'WebCal Subscription' : 'iCloud Calendar'),
        read_only: accForm.read_only,
      };
      if (accForm.provider === 'caldav') {
        body.username = accForm.username;
        body.password = accForm.password;
        body.calendar_url = accForm.calendar_url;
      } else {
        body.server_url = accForm.server_url;
      }
      const resp = await fetch('/api/calendar/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.ok) {
        setAccForm({ provider: 'caldav', name: '', username: '', password: '', server_url: '', calendar_url: '', read_only: false });
        setDiscovered([]);
        setShowAccountModal(false);
        setSyncMsg('Account added; syncing…');
        await runSync();
      } else {
        setAddErr(data.error || 'Add failed');
      }
    } catch (e) {
      setAddErr(`Add error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAddBusy(false);
    }
  }, [accForm, runSync]);

  const removeAccount = useCallback(async (accountId: string) => {
    try {
      await fetch(`/api/calendar/accounts?account_id=${accountId}`, { method: 'DELETE' });
      loadSyncState();
    } catch (e) {
      console.error('removeAccount error:', e);
    }
  }, [loadSyncState]);

  // 切换账户只读/双向：read_only=0 时立即触发同步，把本地事件推送到远端
  const toggleReadOnly = useCallback(async (accountId: string, nextReadOnly: boolean) => {
    try {
      const resp = await fetch('/api/calendar/accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, read_only: nextReadOnly }),
      });
      const data = await resp.json();
      if (!data.ok) {
        setSyncMsg(data.error || 'Toggle failed');
        return;
      }
      await loadSyncState();
      if (nextReadOnly) {
        setSyncMsg('Switched to read-only (pull only)');
      } else {
        setSyncMsg('Switched to two-way; syncing…');
        await runSync();
      }
    } catch (e) {
      console.error('toggleReadOnly error:', e);
    }
  }, [loadSyncState, runSync]);

  const [copied, setCopied] = useState(false);
  const feedUrls = useMemo(() => {
    if (!feedToken || typeof window === 'undefined') return null;
    const loc = window.location;
    // Apple Calendar subscription requires the webcal:// scheme
    // to auto-open Calendar.app; plain http(s) URL is kept for
    // non-Apple clients that don't understand the webcal scheme.
    const httpBase = `${loc.protocol}//${loc.host}`;
    const query = `/api/calendar/ics/feed?token=${encodeURIComponent(feedToken)}`;
    const webcalBase = (() => {
      if (loc.protocol === 'https:') return `webcals://${loc.host}`;
      // 本地 http 部署：macOS Calendar 会把 webcal:// 重写为 https:// 请求（无 TLS → 订阅失败），
      // 实测必须用 http:// 版本才能订阅成功。webcal:// 仅保留供 https 部署/部分第三方客户端使用。
      return `webcal://${loc.host}`;
    })();
    return {
      http: `${httpBase}${query}`,
      webcal: `${webcalBase}${query}`,
    };
  }, [feedToken]);

  const feedUrl = feedUrls?.http ?? null;

  const copyFeedUrl = useCallback(async (scheme: 'http' | 'webcal' = 'http') => {
    if (!feedUrls) return;
    try {
      await navigator.clipboard.writeText(feedUrls[scheme]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [feedUrls]);

  const rotateFeedUrl = useCallback(async () => {
    try {
      const resp = await fetch('/api/calendar/feed', { method: 'POST' });
      const data = await resp.json();
      if (data.ok) setFeedToken(data.token);
    } catch (e) {
      console.error('rotateFeed error:', e);
    }
  }, []);

  // 前月/后月导航（周视图按周切换）
  const goPrev = () => {
    if (view === 'week') setDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 7));
    else setDate(new Date(year, month - 1, 1));
  };
  const goNext = () => {
    if (view === 'week') setDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7));
    else setDate(new Date(year, month + 1, 1));
  };
  const goToday = () => setDate(new Date());

  // 关键词搜索（复用 events 表 keyword 检索）
  const runSearch = useCallback(async (kw: string) => {
    const q = kw.trim();
    if (!q) {
      setSearchResults(null);
      setPanelError(null);
      return;
    }
    setSearching(true);
    try {
      const resp = await fetch(`/api/calendar/events?keyword=${encodeURIComponent(q)}`);
      const data = await resp.json();
      if (data.success) setSearchResults(data.events || []);
      else setPanelError(data.error || 'Search failed');
    } catch (err) {
      console.error('search error:', err);
      setPanelError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSearching(false);
    }
  }, []);

  // 键盘操作：左右方向键切月/周；Esc 关闭弹窗（输入聚焦时不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'Escape') {
        setEditMode(null);
        setConfirmDelete(null);
        setShowMonthPicker(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, date, year, month]);

  // 点击面板外部任意位置（画布空白 / 其它面板 / 拖拽画布）自动关闭日历
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPointerDown = (e: PointerEvent) => {
      const el = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(el)) {
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  // 左边缘拖拽调整面板宽度
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!resizingRef.current) return;
      const next = window.innerWidth - e.clientX;
      setPanelWidth(Math.min(Math.max(next, 560), Math.min(window.innerWidth - 40, 1400)));
    };
    const onUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // 同步菜单：点击菜单外收起
  useEffect(() => {
    if (!showSyncMenu) return;
    const onDown = (e: PointerEvent) => {
      if (syncMenuRef.current && !syncMenuRef.current.contains(e.target as Node)) setShowSyncMenu(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [showSyncMenu]);

  // 当前时刻（周视图红线）：每分钟刷新
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // 周视图默认滚到 08:00 附近，避免一进来就停在 00:00
  useEffect(() => {
    if (view !== 'week' || searchResults !== null || !weekScrollRef.current) return;
    weekScrollRef.current.scrollTop = 8 * HOUR_HEIGHT - 8;
  }, [view, date, searchResults]);

  // 打开新建弹窗（指定日期）
  const openCreate = (dateStr: string) => {
    // 非当天（或当天深夜新建导致整点跨天）默认 09:00 - 10:00；
    // 当天新建默认开始 = 1 小时后的整点，结束 = 2 小时后的整点（向上取整）
    let defaultStart = '09:00';
    let defaultEnd = '10:00';
    const isToday = toLocalDateStr(new Date()) === dateStr;
    if (isToday) {
      const ceilToHour = (base: Date) => {
        const c = new Date(base);
        if (c.getMinutes() > 0 || c.getSeconds() > 0 || c.getMilliseconds() > 0) {
          c.setMinutes(0, 0, 0);
          c.setHours(c.getHours() + 1);
        } else {
          c.setSeconds(0, 0);
        }
        return c;
      };
      const start = ceilToHour(new Date(Date.now() + 3600 * 1000));
      const end = ceilToHour(new Date(Date.now() + 2 * 3600 * 1000));
      if (toLocalDateStr(start) === dateStr && toLocalDateStr(end) === dateStr) {
        defaultStart = start.toTimeString().slice(0, 5);
        defaultEnd = end.toTimeString().slice(0, 5);
      }
    }
    setFormTitle('');
    setFormDate(dateStr);
    setFormEndDate(dateStr);
    setFormStartTime(defaultStart);
    setFormEndTime(defaultEnd);
    setFormAllDay(false);
    setFormPriority('normal');
    setFormDescription('');
    setFormLocation('');
    setFormColor('#3B82F6'); // 默认蓝色
    setFormTags('');
    setFormReminderMinutes([30]); // 默认开始前 30 分钟提醒
    setFormError(null);
    setEditMode({ date: dateStr });
  };

  // 打开编辑弹窗
  const openEdit = (ev: CalendarEvent) => {
    setFormTitle(ev.title);
    const d = new Date(ev.start_time);
    const endD = ev.end_time && !ev.all_day ? new Date(ev.end_time) : null;
    setFormDate(toLocalDateStr(d));
    setFormEndDate(endD ? toLocalDateStr(endD) : toLocalDateStr(d));
    setFormStartTime(ev.all_day ? '' : d.toTimeString().slice(0, 5));
    setFormEndTime(ev.end_time && !ev.all_day ? new Date(ev.end_time).toTimeString().slice(0, 5) : '');
    setFormAllDay(ev.all_day);
    setFormPriority(ev.priority);
    setFormDescription(ev.description || '');
    setFormLocation(ev.location || '');
    setFormColor(ev.color || '#3B82F6');
    setFormTags(ev.tags?.length ? ev.tags.join(', ') : '');
    setFormReminderMinutes(
      Array.isArray(ev.reminder_minutes) && ev.reminder_minutes.length > 0
        ? ev.reminder_minutes
        : [30],
    );
    setFormError(null);
    setEditMode({ event_id: ev.event_id });
  };

  // 提交表单
  const handleSubmit = async () => {
    // 校验
    if (!formTitle.trim()) {
      setFormError('Title is required');
      return;
    }
    if (!formDate) {
      setFormError('Date is required');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const startIso = formAllDay
        ? new Date(formDate + 'T00:00:00').toISOString()
        : new Date(formDate + 'T' + (formStartTime || '09:00') + ':00').toISOString();

      // 结束时间（支持跨天：结束日期 + 结束时刻）
      let endIso: string | null | undefined = formAllDay ? null : undefined;
      if (!formAllDay && formEndTime) {
        const startMs = new Date(formDate + 'T' + (formStartTime || '09:00') + ':00').getTime();
        const endMs = new Date((formEndDate || formDate) + 'T' + formEndTime + ':00').getTime();
        if (!Number.isFinite(endMs) || endMs < startMs) {
          setFormError('End time must be after start time');
          return;
        }
        endIso = new Date((formEndDate || formDate) + 'T' + formEndTime + ':00').toISOString();
      }

      const body: any = {
        title: formTitle.trim(),
        start_time: startIso,
        end_time: endIso ?? null,
        all_day: formAllDay,
        priority: formPriority,
        description: formDescription.trim() || null,
        location: formLocation.trim() || null,
        color: formColor,
        tags: formTags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        reminder_minutes: formReminderMinutes,
      };

      if (editMode && 'event_id' in editMode) {
        // 更新
        const resp = await fetch(`/api/calendar/events?event_id=${editMode.event_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data.success) {
          console.error('Update failed:', data.error);
          setPanelError(data.error || 'Update failed');
          return;
        }
      } else {
        // 新建
        const resp = await fetch('/api/calendar/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!data.success) {
          console.error('Create failed:', data.error);
          setPanelError(data.error || 'Create failed');
          return;
        }
      }
      setEditMode(null);
      setPanelError(null);
      fetchEvents();
      // 通知全局：日历已变更（新增/编辑事件可能反向联动便签行，便签层据此重载）
      window.dispatchEvent(new Event('calendar-events-changed'));
    } catch (err) {
      console.error('Save error:', err);
      setPanelError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  // 请求删除：弹出确认（不再用原生 confirm，避免误删）
  const requestDelete = (eventId: string) => {
    const ev = events.find((e) => e.event_id === eventId) || null;
    setConfirmDelete(ev);
  };

  // 确认删除
  const performDelete = async () => {
    if (!confirmDelete) return;
    const eventId = confirmDelete.event_id;
    try {
      const resp = await fetch(`/api/calendar/events?event_id=${eventId}`, { method: 'DELETE' });
      const data = await resp.json();
      if (!data.success) {
        setPanelError(data.error || 'Delete failed');
        setConfirmDelete(null);
        return;
      }
      setConfirmDelete(null);
      setPanelError(null);
      fetchEvents();
      // 通知全局：日历已变更（删除事件可能反向移除便签待办行，便签层据此重载）
      window.dispatchEvent(new Event('calendar-events-changed'));
      // 联动 BobMail：日历删除事件后，通知中心引用该事件的条目同步删除
      window.dispatchEvent(new CustomEvent('bobmail-event-sync', { detail: { eventId, action: 'deleted' } }));
    } catch (err) {
      console.error('Delete error:', err);
      setConfirmDelete(null);
      setPanelError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 切换状态
  const toggleStatus = async (ev: CalendarEvent, newStatus: 'scheduled' | 'done' | 'cancelled') => {
    try {
      await fetch(`/api/calendar/events?event_id=${ev.event_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      fetchEvents();
      // 通知全局：事件状态已变更（⌘F 面板据此立即拉取一次到期提醒，而非等 30s 轮询）
      window.dispatchEvent(new Event('calendar-events-changed'));
      // 联动 BobMail：日历标记完成后，通知中心引用该事件的条目自动完成
      if (newStatus === 'done') {
        window.dispatchEvent(new CustomEvent('bobmail-event-sync', { detail: { eventId: ev.event_id, action: 'done' } }));
      }
    } catch (err) {
      console.error('toggleStatus error:', err);
    }
  };

  // 按日期分组事件
  const eventsByDate: Map<string, CalendarEvent[]> = new Map();
  for (const ev of events) {
    const d = toLocalDateStr(new Date(ev.start_time));
    const arr = eventsByDate.get(d) || [];
    arr.push(ev);
    eventsByDate.set(d, arr);
  }
  // 按时间排序每组
  for (const arr of eventsByDate.values()) {
    arr.sort((a, b) => a.start_time.localeCompare(b.start_time));
  }

  const todayStr = toLocalDateStr(new Date());
  const selectedDateEvents = events.filter((ev) => toLocalDateStr(new Date(ev.start_time)) === selectedDate)
    .sort((a, b) => {
      // 完成/已取消事项自动沉底：scheduled → done → cancelled，组内保持原有时间序
      const statusRank = (s: string) => (s === 'scheduled' ? 0 : s === 'done' ? 1 : 2);
      const rankDiff = statusRank(a.status) - statusRank(b.status);
      if (rankDiff !== 0) return rankDiff;
      if (a.all_day && !b.all_day) return -1;
      if (!a.all_day && b.all_day) return 1;
      return a.start_time.localeCompare(b.start_time);
    });

  // 选中日期的展示标题
  const selectedDateLabel = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', weekday: 'short' });

  // 周视图数据：当前周 7 天 + 标题
  const currentWeekStart = startOfWeek(date);
  const weekDays = Array.from({ length: 7 }, (_, i) =>
    new Date(currentWeekStart.getFullYear(), currentWeekStart.getMonth(), currentWeekStart.getDate() + i),
  );
  const weekLabel = `${weekDays[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekDays[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  return (
    <div
      ref={panelRef}
      className="fixed right-0 top-0 z-[51] flex h-full flex-col overflow-hidden"
      style={{
        width: `${panelWidth}px`,
        maxWidth: 'calc(100vw - 40px)',
        backgroundColor: 'var(--paper)',
        borderLeft: '1px solid var(--line)',
        boxShadow: 'var(--shadow-lg)',
        fontFamily: "var(--font-sans)",
        WebkitAppRegion: 'no-drag',
        animation: 'fade-in 200ms var(--ease-base)',
      } as React.CSSProperties}
    >
      {/* 左边缘拖拽手柄：调整面板宽度 */}
      <div
        className="absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize transition-colors hover:bg-[var(--primary-soft)]"
        onPointerDown={(e) => {
          e.preventDefault();
          resizingRef.current = true;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
        title="Drag to resize"
        aria-hidden
      />
      {/* 头部 — Phase 3：NodeCardHeader 统一三段式布局 */}
      <NodeCardHeader
        leftAnchor={
          <Calendar className="h-4 w-4 shrink-0" style={{ color: 'var(--primary)' }} />
        }
        title={<span className="text-sm font-semibold">Calendar</span>}
        rightActions={
          <Button
            onClick={onClose}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            aria-label="close calendar"
          >
            <X className="h-4 w-4" />
          </Button>
        }
        dividerColor="var(--line-soft)"
        style={{ backgroundColor: 'var(--paper-soft)' }}
      />

      {/* 错误提示横幅 — Phase 3：Callout danger */}
      {panelError && (
        <Callout
          variant="danger"
          size="sm"
          description={panelError}
          dismissible
          onDismiss={() => setPanelError(null)}
          className="mx-2 mt-2 mb-1"
        />
      )}

      {/* ===== 日历同步状态条（同步相关操作收进 ⋯ 菜单，只把状态留在主视觉） ===== */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
        style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper)' }}
      >
        <span className="text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Calendar Sync</span>
        <span className="min-w-0 flex-1 truncate text-11" style={{ color: syncMsg ? 'var(--ink-muted)' : 'var(--ink-faint)' }}>
          {syncMsg || (syncAccounts.length ? `${syncAccounts.length} account${syncAccounts.length !== 1 ? 's' : ''}` : 'Not configured')}
        </span>
        {/* 账户连接方式徽章：右侧固定为 Mac，箭头反映实际数据流向（双向 ⇄ / 单向 ←） */}
        {syncAccounts.map((a) => {
          const twoWay = a.provider === 'caldav' && !a.read_only;
          return (
            <span
              key={a.account_id}
              className="hidden shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-10 font-medium sm:inline-flex"
              style={{
                backgroundColor: twoWay ? 'var(--success-soft)' : 'var(--info-soft)',
                color: twoWay ? 'var(--success)' : 'var(--info)',
              }}
              title={twoWay ? 'Two-way sync: BobWork ⇄ Mac Calendar' : 'One-way: Mac Calendar → BobWork (pull only)'}
            >
              {a.name}
              <span className="opacity-80">{twoWay ? '⇄ Mac' : '← Mac'}</span>
            </span>
          );
        })}
        <Button
          onClick={runSync}
          disabled={syncing}
          loading={syncing}
          variant="ghost"
          tone="neutral"
          size="icon-sm"
          title="Sync now"
          aria-label="Sync now"
        >
          {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
        <div className="relative" ref={syncMenuRef}>
          <Button
            onClick={() => setShowSyncMenu((v) => !v)}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            title="Sync options"
            aria-label="Sync options"
            aria-expanded={showSyncMenu}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {showSyncMenu && (
            <div
              className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-lg border py-1"
              style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', boxShadow: 'var(--shadow-lg)' }}
            >
              {([
                { key: 'import', label: 'Import .ics', icon: <Upload className="h-3.5 w-3.5" />, onClick: () => fileInputRef.current?.click() },
                { key: 'export', label: 'Export .ics', icon: <Download className="h-3.5 w-3.5" />, onClick: () => handleExport() },
                ...(feedUrl ? [{ key: 'subscribe', label: 'Subscribe', icon: <Link2 className="h-3.5 w-3.5" />, onClick: () => setShowSubscribeModal(true) }] : []),
                { key: 'accounts', label: 'Accounts', icon: <Settings2 className="h-3.5 w-3.5" />, onClick: () => setShowAccountModal(true) },
                { key: 'logs', label: 'Sync logs', icon: <ScrollText className="h-3.5 w-3.5" />, onClick: () => setShowSyncLogs((v) => !v) },
              ]).map((item) => (
                <button
                  key={item.key}
                  onClick={() => { setShowSyncMenu(false); item.onClick(); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-11 transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink)' }}
                >
                  <span style={{ color: 'var(--ink-muted)' }}>{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 同步日志（由 ⋯ 菜单的 Sync logs 展开） */}
      {showSyncLogs && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-b px-4 py-1.5" style={{ borderColor: 'var(--line-soft)' }}>
          {syncLogs.length === 0 && <div className="text-11" style={{ color: 'var(--ink-faint)' }}>No sync logs yet</div>}
          {syncLogs.map((l, i) => (
            <div key={i} className="flex gap-1.5 text-11 leading-5" style={{ color: l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warn)' : 'var(--ink-muted)' }}>
              <span className="shrink-0 opacity-60">{new Date(l.created_at).toLocaleString()}</span>
              <span className="truncate">{l.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* 隐藏的 .ics 文件选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".ics,text/calendar"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImportFile(f);
          e.currentTarget.value = '';
        }}
      />

      {/* 工具栏：视图切换 + 导航/跳转 + 搜索 */}
      <div className="flex shrink-0 flex-col gap-2 px-4 py-2">
        <div className="flex items-center justify-between">
          {/* 月/周视图切换 */}
          <div className="flex items-center gap-0.5 rounded-md border p-0.5" style={{ borderColor: 'var(--line-soft)' }}>
            {(['month', 'week'] as const).map((v) => (
              <Button
                key={v}
                onClick={() => setView(v)}
                variant={view === v ? 'solid' : 'ghost'}
                tone={view === v ? 'brand' : 'neutral'}
                size="micro"
                className="px-2 py-0.5 text-xs"
              >
                {v === 'month' ? 'Month' : 'Week'}
              </Button>
            ))}
          </div>

          {/* 导航 + 标题跳转 + Today */}
          <div className="flex items-center gap-1.5">
            <Button
              onClick={goPrev}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              aria-label="Previous"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {showMonthPicker ? (
              <input
                type="month"
                defaultValue={`${year}-${String(month + 1).padStart(2, '0')}`}
                autoFocus
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) {
                    const [y, m] = v.split('-').map(Number);
                    setDate(new Date(y, m - 1, 1));
                  }
                  setShowMonthPicker(false);
                }}
                onBlur={() => setShowMonthPicker(false)}
                className="w-[130px] rounded border px-1 py-0.5 text-xs"
                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--ink)' }}
              />
            ) : (
              <button
                onClick={() => setShowMonthPicker(true)}
                title="Jump to month"
                className="rounded px-1 py-0.5 text-sm font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink)' }}
              >
                {view === 'week' ? weekLabel : `${date.toLocaleString('default', { month: 'long' })} ${year}`}
              </button>
            )}
            <Button
              onClick={goToday}
              variant="outline"
              tone="brand"
              size="xs"
            >
              Today
            </Button>
            <Button
              onClick={goNext}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              aria-label="Next"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 关键词搜索 */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--ink-faint)' }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(searchQuery); }}
            placeholder="Search events…"
            className="w-full rounded-md border py-1.5 pl-7 pr-7 text-xs outline-none transition-colors focus:border-[var(--primary)]"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--ink)' }}
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setSearchResults(null); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity hover:opacity-70"
              style={{ color: 'var(--ink-faint)' }}
              title="Clear"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* 星期标题（月视图显示星期；周视图显示星期 + 今天胶囊） */}
      <div className="flex shrink-0 items-stretch border-b" style={{ borderColor: 'var(--line-soft)' }}>
        {/* 周视图左侧与时间轴刻度列对齐的占位 */}
        {view === 'week' && searchResults === null && <div className="w-11 shrink-0" />}
        <div className="grid flex-1 grid-cols-7">
          {searchResults !== null
            ? null
            : (view === 'month'
              ? WEEKDAYS.map((day) => (
                  <div key={day} className="py-1.5 text-center text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                    {day}
                  </div>
                ))
              : weekDays.map((d) => {
                  const isToday = toLocalDateStr(d) === todayStr;
                  return (
                    <div key={d.toISOString()} className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                      {WEEKDAYS[d.getDay()]}
                      <span
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1"
                        style={{
                          backgroundColor: isToday ? 'var(--primary)' : 'transparent',
                          color: isToday ? 'var(--paper)' : 'var(--ink)',
                        }}
                      >
                        {d.getDate()}
                      </span>
                    </div>
                  );
                })
            )}
        </div>
      </div>

      {/* 日历格子 */}
      {/* 面板整体禁止滑动：容器不再整体滚动（overflow-hidden），网格占满剩余空间（内部各自滚动），
          仅下方待办区独立滚动（max-h + overflow-y-auto） */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {searchResults !== null ? (
          /* 搜索结果列表 */
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-1.5 px-4 py-2" style={{ backgroundColor: 'var(--paper-muted)' }}>
              <Search className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                Search: 「{searchQuery.trim() || 'keyword'}」
              </span>
              <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                ({searchResults.length} result{searchResults.length !== 1 ? 's' : ''})
              </span>
            </div>
            {searchResults.length === 0 ? (
              <EmptyState
                size="sm"
                preset="search"
                title="No matching events"
                description="Try a different keyword or clear the search."
              />
            ) : (
              <div className="flex-1 divide-y divide-[var(--line-soft)] overflow-y-auto">
                {searchResults.map((ev) => (
                  <div key={ev.event_id} className="flex items-center gap-2 px-4 py-2 transition-colors hover:bg-[var(--paper-hover)]">
                    <span style={{ color: ev.status === 'done' ? 'var(--success)' : ev.status === 'cancelled' ? 'var(--ink-faint)' : (ev.color || 'var(--primary)') }}>
                      {ev.status === 'done' ? <CheckCircle2 className="h-4 w-4" /> : ev.status === 'cancelled' ? <XCircle className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1 cursor-pointer" onClick={() => openEdit(ev)}>
                      <div className="truncate text-xs font-medium" style={{ color: ev.status === 'done' ? 'var(--ink-faint)' : 'var(--ink)', textDecoration: ev.status === 'done' ? 'line-through' : 'none' }}>
                        {ev.title}
                      </div>
                      <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                        <span>
                          {new Date(ev.start_time).getMonth() + 1}/{new Date(ev.start_time).getDate()}{' '}
                          {ev.all_day ? 'All day' : `${new Date(ev.start_time).toTimeString().slice(0, 5)}${ev.end_time ? ` - ${new Date(ev.end_time).toTimeString().slice(0, 5)}` : ''}`}
                        </span>
                        {ev.tags?.map((t) => (
                          <span key={t} className="rounded px-1 py-px text-10" style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}>
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--ink-muted)' }} />
          </div>
        ) : (
          <>
            {view === 'week' ? (
              /* 周视图：时间轴网格（左列小时刻度 + 右侧 7 天列，事件按时间绝对定位） */
              <div ref={weekScrollRef} className="min-h-0 flex-1 overflow-y-auto">
                <div className="relative flex" style={{ height: 24 * HOUR_HEIGHT }}>
                  {/* 小时刻度列 */}
                  <div className="w-11 shrink-0">
                    {HOURS.map((h) => (
                      <div key={h} className="relative" style={{ height: HOUR_HEIGHT }}>
                        <span
                          className="absolute right-1.5 top-0.5 text-10 tabular-nums"
                          style={{ color: 'var(--ink-faint)' }}
                        >
                          {`${String(h).padStart(2, '0')}:00`}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* 7 天列 */}
                  <div className="relative grid flex-1 grid-cols-7">
                    {/* 每小时横线 */}
                    {HOURS.map((h) => (
                      <div
                        key={`line-${h}`}
                        className="pointer-events-none absolute left-0 right-0 border-t"
                        style={{ top: h * HOUR_HEIGHT, borderColor: 'var(--line-soft)' }}
                      />
                    ))}

                    {weekDays.map((d) => {
                      const ds = toLocalDateStr(d);
                      const dayEvents = (eventsByDate.get(ds) || []).slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
                      const isToday = ds === todayStr;
                      return (
                        <div
                          key={ds}
                          className="relative border-r last:border-r-0"
                          style={{
                            borderColor: 'var(--line-soft)',
                            backgroundColor: isToday ? 'var(--primary-faint)' : 'transparent',
                          }}
                          onDoubleClick={() => openCreate(ds)}
                          title="Double-click to add"
                        >
                          {/* 当前时刻红线（仅今天列，客户端挂载后显示，避免水合不一致） */}
                          {isToday && now && (
                            <div
                              className="pointer-events-none absolute left-0 right-0 z-10"
                              style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT }}
                            >
                              <div className="relative h-px" style={{ backgroundColor: 'var(--danger)' }}>
                                <span
                                  className="absolute -left-[3px] -top-[3px] h-1.5 w-1.5 rounded-full"
                                  style={{ backgroundColor: 'var(--danger)' }}
                                />
                              </div>
                            </div>
                          )}

                          {/* 事件块：按起始时间与时长定位，左侧色条表分类 */}
                          {dayEvents.map((ev) => {
                            const startMin = ev.all_day ? 0 : startMinutesOf(ev.start_time);
                            const dur = ev.all_day ? 30 : durationMinutesOf(ev, startMin);
                            return (
                              <div
                                key={ev.event_id}
                                onClick={() => openEdit(ev)}
                                className="absolute left-0.5 right-0.5 cursor-pointer overflow-hidden rounded-md border-l-2 px-1 py-0.5 text-11 leading-tight transition-shadow hover:shadow-md"
                                style={{
                                  top: (startMin / 60) * HOUR_HEIGHT + 1,
                                  height: Math.max((dur / 60) * HOUR_HEIGHT - 2, 15),
                                  backgroundColor: eventTint(ev.color, 14),
                                  borderLeftColor: eventBarColor(ev),
                                  ...eventTextStyle(ev.status),
                                }}
                                title={`${ev.all_day ? 'All day' : hhmm(ev.start_time)} ${ev.title}`}
                              >
                                <div className="truncate font-medium">{ev.title}</div>
                                {!ev.all_day && dur >= 45 && (
                                  <div className="truncate text-10" style={{ color: 'var(--ink-muted)' }}>
                                    {hhmm(ev.start_time)}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              /* 月视图格子：flex-1 占满网格区域（容器已禁滚动，行高随面板自适应） */
              <div className="grid min-h-0 flex-1 grid-cols-7 gap-1 p-1">
              {Array.from({ length: totalCells }).map((_, i) => {
                const cellDate = new Date(year, month, 1 - startDayOfWeek + i);
                const cellDateStr = toLocalDateStr(cellDate);
                const isCurrentMonth = cellDate.getMonth() === month;
                const isToday = cellDateStr === todayStr;
                const isSelected = cellDateStr === selectedDate;
                const dayEvents = eventsByDate.get(cellDateStr) || [];

                return (
                  <div
                    key={i}
                    className="group relative cursor-pointer rounded-lg border p-1 transition-colors hover:bg-[var(--paper-hover)]"
                    style={{
                      minHeight: '72px',
                      borderColor: isSelected ? 'var(--primary)' : 'var(--line-soft)',
                      opacity: isCurrentMonth ? 1 : 0.45,
                      backgroundColor: isSelected ? 'var(--primary-soft)' : 'transparent',
                    }}
                    onClick={() => setSelectedDate(cellDateStr)}
                    onDoubleClick={() => openCreate(cellDateStr)}
                    title={isCurrentMonth ? 'Double-click to add' : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className="text-xs font-medium"
                        style={{
                          color: isToday ? 'var(--paper)' : 'var(--ink)',
                          backgroundColor: isToday ? 'var(--primary)' : 'transparent',
                          borderRadius: isToday ? '9999px' : undefined,
                          width: isToday ? '20px' : undefined,
                          height: isToday ? '20px' : undefined,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          border: (!isToday && isSelected) ? '1.5px solid var(--primary)' : 'none',
                        }}
                      >
                        {cellDate.getDate()}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openCreate(cellDateStr);
                        }}
                        className="flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-hover)] group-hover:opacity-100"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>

                    {/* 事件标签 */}
                    <div className="mt-0.5 space-y-px">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <div
                          key={ev.event_id}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(ev);
                          }}
                          className="truncate rounded border-l-2 px-1 py-px text-xs leading-tight transition-colors hover:brightness-95"
                          style={{
                            backgroundColor: eventTint(ev.color, 14),
                            borderLeftColor: eventBarColor(ev),
                            ...eventTextStyle(ev.status),
                          }}
                          title={ev.title}
                        >
                          {!ev.all_day && ev.start_time && (
                            <span style={{ opacity: 0.7 }}>
                              {new Date(ev.start_time).toTimeString().slice(0, 5)}{' '}
                            </span>
                          )}
                          {ev.title}
                        </div>
                      ))}
                      {dayEvents.length > 3 && (
                        <span className="block px-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                          +{dayEvents.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            )}

            {/* 选中日期待办：固定高度卡片（高度不随待办数量变化，内容过多时内部滚动，避免挤压日历网格） */}
            <div className="shrink-0 h-[34%] min-h-[132px] max-h-[300px] px-3 pb-3 pt-2">
              <div
                className="flex h-full flex-col overflow-hidden rounded-xl border"
                style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', boxShadow: 'var(--shadow-sm)' }}
              >
              <div
                className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2"
                style={{ backgroundColor: 'var(--paper-muted)', borderColor: 'var(--line-soft)' }}
              >
                <Clock className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                  {selectedDate === todayStr ? 'Today' : 'Selected'} — {selectedDateLabel}
                </span>
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  ({selectedDateEvents.length} task{selectedDateEvents.length !== 1 ? 's' : ''})
                </span>
              </div>

              {selectedDateEvents.length === 0 ? (
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  <EmptyState
                    size="sm"
                    preset="inbox"
                    title={selectedDate === todayStr ? 'Nothing scheduled today' : 'Nothing scheduled'}
                    description="Double-click a day or use + to add an event."
                  />
                </div>
              ) : (
                <div className="min-h-0 flex-1 divide-y divide-[var(--line-soft)] overflow-y-auto">
                  {selectedDateEvents.map((ev) => (
                    <div
                      key={ev.event_id}
                      className="flex items-center gap-2 px-4 py-2 transition-colors hover:bg-[var(--paper-hover)]"
                    >
                      {/* 状态图标 */}
                      <button
                        onClick={() => {
                          const next = ev.status === 'done' ? 'scheduled' : ev.status === 'cancelled' ? 'scheduled' : 'done';
                          toggleStatus(ev, next);
                        }}
                        className="shrink-0 transition-colors hover:opacity-70"
                        style={{ color: ev.status === 'done' ? 'var(--success)' : ev.status === 'cancelled' ? 'var(--ink-faint)' : 'var(--ink-faint)' }}
                        title={ev.status === 'done' ? 'Mark as scheduled' : ev.status === 'cancelled' ? 'Mark as scheduled' : 'Mark as done'}
                      >
                        {ev.status === 'done' ? <CheckCircle2 className="h-4 w-4" /> :
                         ev.status === 'cancelled' ? <XCircle className="h-4 w-4" /> :
                         <Circle className="h-4 w-4" />}
                      </button>

                      {/* 内容 */}
                      <div
                        className="flex-1 min-w-0 cursor-pointer"
                        onClick={() => openEdit(ev)}
                      >
                        <div
                          className="truncate text-xs font-medium"
                          style={{
                            color: ev.status === 'done' ? 'var(--ink-faint)' : 'var(--ink)',
                            textDecoration: ev.status === 'done' ? 'line-through' : 'none',
                          }}
                        >
                          {ev.title}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                          {ev.all_day ? (
                            <span>All day</span>
                          ) : (
                            <span>
                              {new Date(ev.start_time).toTimeString().slice(0, 5)}
                              {ev.end_time && ` - ${new Date(ev.end_time).toTimeString().slice(0, 5)}`}
                            </span>
                          )}
                          {ev.priority === 'high' && (
                            <span className="rounded px-1 py-px text-xs" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
                              High
                            </span>
                          )}
                        </div>
                        {ev.description && (
                          <div className="truncate text-xs" style={{ color: 'var(--ink-faint)' }}>
                            {ev.description}
                          </div>
                        )}
                        {ev.location && (
                          <div className="flex items-center gap-1 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                            <MapPin size={9} style={{ flexShrink: 0 }} />
                            <span className="truncate">{ev.location}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      {editMode && (
        <div
          className="fixed inset-0 z-[100]"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onPointerDown={(e) => { e.stopPropagation(); setEditMode(null); }}
        >
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 shadow-2xl nowheel"
            style={{
              width: '380px',
              backgroundColor: 'var(--paper)',
              borderColor: 'var(--line)',
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              {'event_id' in editMode ? 'Edit Event' : 'New Event'}
            </h3>

            {/* 标题 */}
            <input
              type="text"
              placeholder="Event title"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              className="mb-3 w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--primary)]"
              style={{
                backgroundColor: 'var(--input-bg)',
                borderColor: 'var(--input-border)',
                color: 'var(--ink)',
              }}
              autoFocus
            />

            {/* 日期 */}
            <div className="mb-2">
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Date</label>
              <input
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                className="w-full rounded-md border px-3 py-1.5 text-sm"
                style={{
                  backgroundColor: 'var(--input-bg)',
                  borderColor: 'var(--input-border)',
                  color: 'var(--ink)',
                }}
              />
            </div>

            {/* 全天切 */}
            <label className="mb-2 flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formAllDay}
                onChange={(e) => setFormAllDay(e.target.checked)}
              />
              <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>All day</span>
            </label>

            {/* 时间（非全天时） */}
            {!formAllDay && (
              <>
                <div className="mb-2 flex gap-2">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Start</label>
                    <input
                      type="time"
                      value={formStartTime}
                      onChange={(e) => setFormStartTime(e.target.value)}
                      className="w-full rounded-md border px-3 py-1.5 text-sm"
                      style={{
                        backgroundColor: 'var(--input-bg)',
                        borderColor: 'var(--input-border)',
                        color: 'var(--ink)',
                      }}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>End</label>
                    <input
                      type="time"
                      value={formEndTime}
                      onChange={(e) => setFormEndTime(e.target.value)}
                      className="w-full rounded-md border px-3 py-1.5 text-sm"
                      style={{
                        backgroundColor: 'var(--input-bg)',
                        borderColor: 'var(--input-border)',
                        color: 'var(--ink)',
                      }}
                    />
                  </div>
                </div>
                {/* 结束日期：填了结束时间才显示，支持跨天事件（结束在次日） */}
                {formEndTime && (
                  <div className="mb-2">
                    <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>End date</label>
                    <input
                      type="date"
                      value={formEndDate}
                      onChange={(e) => setFormEndDate(e.target.value)}
                      className="w-full rounded-md border px-3 py-1.5 text-sm"
                      style={{
                        backgroundColor: 'var(--input-bg)',
                        borderColor: 'var(--input-border)',
                        color: 'var(--ink)',
                      }}
                    />
                  </div>
                )}
              </>
            )}

            {/* 优先级 */}
            <div className="mb-2">
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Priority</label>
              <select
                value={formPriority}
                onChange={(e) => setFormPriority(e.target.value as any)}
                className="w-full rounded-md border px-3 py-1.5 text-sm"
                style={{
                  backgroundColor: 'var(--input-bg)',
                  borderColor: 'var(--input-border)',
                  color: 'var(--ink)',
                }}
              >
                {(['high', 'normal', 'low'] as const).map((p) => (
                  <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                ))}
              </select>
            </div>

            {/* 提前提醒（可多选，默认开始前 30 分钟） */}
            <div className="mb-2">
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Remind before</label>
              <div className="flex flex-wrap gap-1">
                {REMINDER_PRESETS.map((r) => {
                  const active = formReminderMinutes.includes(r.value);
                  return (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() =>
                        setFormReminderMinutes((prev) =>
                          active
                            ? prev.filter((v) => v !== r.value)
                            : [...prev, r.value].sort((a, b) => a - b),
                        )
                      }
                      className="rounded-full border px-2 py-0.5 text-xs transition-colors"
                      style={{
                        borderColor: active ? 'var(--primary)' : 'var(--input-border)',
                        backgroundColor: active ? 'var(--primary-soft)' : 'transparent',
                        color: active ? 'var(--primary-strong)' : 'var(--ink-muted)',
                      }}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
              {/* 自定义分钟 */}
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  placeholder="Custom (min)"
                  className="w-28 rounded-md border px-2 py-1 text-xs outline-none"
                  style={{
                    backgroundColor: 'var(--input-bg)',
                    borderColor: 'var(--input-border)',
                    color: 'var(--ink)',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const v = Number((e.target as HTMLInputElement).value);
                      if (Number.isFinite(v) && v > 0 && !formReminderMinutes.includes(v)) {
                        setFormReminderMinutes((prev) => [...prev, v].sort((a, b) => a - b));
                      }
                      (e.target as HTMLInputElement).value = '';
                    }
                  }}
                />
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Enter to add</span>
              </div>
              <p className="mt-1 text-11" style={{ color: 'var(--ink-muted)' }}>
                Each selected time triggers a notification. Default: 30 min before.
              </p>
            </div>

            {/* 颜色 */}
            <div className="mb-2">
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Color</label>
              <div className="flex items-center gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setFormColor(c)}
                    className="h-5 w-5 rounded-full transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      boxShadow: formColor === c ? `0 0 0 2px var(--paper), 0 0 0 3.5px ${c}` : 'none',
                    }}
                    title={c}
                  />
                ))}
                <input
                  type="color"
                  value={formColor}
                  onChange={(e) => setFormColor(e.target.value)}
                  className="h-5 w-8 cursor-pointer rounded border"
                  style={{ borderColor: 'var(--input-border)' }}
                  title="Custom color"
                />
              </div>
            </div>

            {/* 描述 */}
            <div className="mb-2">
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Description</label>
              <textarea
                placeholder="Optional"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                rows={2}
                className="w-full rounded-md border px-3 py-1.5 text-sm resize-none"
                style={{
                  backgroundColor: 'var(--input-bg)',
                  borderColor: 'var(--input-border)',
                  color: 'var(--ink)',
                }}
              />
            </div>

            {/* 标签 */}
            <div className="mb-2">
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Tags</label>
              <input
                type="text"
                placeholder="Comma separated, e.g. 合同, 华为"
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
                style={{
                  backgroundColor: 'var(--input-bg)',
                  borderColor: 'var(--input-border)',
                  color: 'var(--ink)',
                }}
              />
            </div>

            {/* 地点 */}
            <div className="mb-4">
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Location</label>
              <input
                type="text"
                placeholder="Optional"
                value={formLocation}
                onChange={(e) => setFormLocation(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
                style={{
                  backgroundColor: 'var(--input-bg)',
                  borderColor: 'var(--input-border)',
                  color: 'var(--ink)',
                }}
              />
            </div>

            {/* 表单错误提示 */}
            {formError && (
              <div
                className="mb-3 rounded-md px-3 py-2 text-xs"
                style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}
              >
                {formError}
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex items-center justify-between">
              <div>
                {'event_id' in editMode && (
                  <Button
                    onClick={() => {
                      setEditMode(null);
                      requestDelete(editMode.event_id);
                    }}
                    variant="ghost"
                    tone="danger"
                    size="sm"
                  >
                    <Trash className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => setEditMode(null)}
                  variant="ghost"
                  tone="neutral"
                  size="md"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={saving || !formTitle.trim()}
                  loading={saving}
                  variant="solid"
                  tone="brand"
                  size="md"
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {'event_id' in editMode ? 'Save' : 'Create'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-[101]"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onPointerDown={(e) => { e.stopPropagation(); setConfirmDelete(null); }}
        >
          <div
            className="absolute left-1/2 top-1/2 w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 shadow-2xl"
            style={{
              backgroundColor: 'var(--paper)',
              borderColor: 'var(--line)',
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Cancel event?</h3>
            <p className="mb-4 text-xs" style={{ color: 'var(--ink-muted)' }}>
              {confirmDelete.title && <span className="font-medium" style={{ color: 'var(--ink)' }}>「{confirmDelete.title}」</span>}{' '}
              will be marked as cancelled and synced to your Mac calendar.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => setConfirmDelete(null)}
                variant="ghost"
                tone="neutral"
                size="md"
              >
                Cancel
              </Button>
              <Button
                onClick={performDelete}
                variant="solid"
                tone="danger"
                size="md"
              >
                Cancel Event
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Apple Calendar 订阅弹窗 */}
      {showSubscribeModal && feedUrl && (
        <div
          className="fixed inset-0 z-[101]"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onPointerDown={(e) => { e.stopPropagation(); setShowSubscribeModal(false); }}
        >
          <div
            className="absolute left-1/2 top-1/2 w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 shadow-2xl"
            style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Apple Calendar Subscription</h3>
                <span className="rounded px-1 text-10" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>read-only</span>
              </div>
              <Button onClick={() => setShowSubscribeModal(false)} variant="ghost" tone="neutral" size="icon-sm" aria-label="close subscription">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="mb-3 rounded-md border p-3" style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--paper-soft)' }}>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Subscription URL</div>
                <Button
                  onClick={rotateFeedUrl}
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  title="Rotate token (invalidate old link)"
                >
                  ↻ Rotate token
                </Button>
              </div>
              <div className="mb-2 space-y-2">
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="rounded px-1.5 py-0.5 text-9 font-medium" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>
                      http(s) · Recommended
                    </span>
                    <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                      macOS / iOS Calendar. Paste into Calendar.app → New Calendar Subscription. (macOS rewrites webcal:// to https://, so on a local http server use this.)
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      readOnly
                      value={feedUrls?.http ?? ''}
                      onFocus={(e) => e.target.select()}
                      className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-11 outline-none"
                      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                    />
                    <button
                      onClick={() => copyFeedUrl('http')}
                      className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs"
                      style={{ backgroundColor: copied ? 'var(--success-soft)' : 'var(--primary-soft)', color: copied ? 'var(--success)' : 'var(--primary)' }}
                      title="Copy http URL"
                    >
                      {copied ? <Check className="h-3 w-3" /> : 'Copy'}
                    </button>
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="rounded px-1.5 py-0.5 text-9 font-medium" style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}>
                      webcal(s) · HTTPS deployments
                    </span>
                    <span className="text-10" style={{ color: 'var(--ink-faint)' }}>
                      Only for https:// deployments or third-party clients that understand the webcal scheme.
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      readOnly
                      value={feedUrls?.webcal ?? ''}
                      onFocus={(e) => e.target.select()}
                      className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-11 outline-none"
                      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--input-bg)', color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)' }}
                    />
                    <Button
                      onClick={() => copyFeedUrl('webcal')}
                      variant="soft"
                      tone="neutral"
                      size="sm"
                      title="Copy webcal URL"
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              </div>
              <div className="text-10 leading-4" style={{ color: 'var(--ink-faint)' }}>
                Anyone with this link can view your calendar events. Rotate to invalidate old tokens.
              </div>
            </div>

            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="mb-2 text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Setup steps</div>
              <ol className="space-y-2 text-11 leading-5" style={{ color: 'var(--ink)' }}>
                <li className="flex gap-2">
                  <span className="shrink-0 rounded-full w-4 h-4 flex items-center justify-center text-9" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>1</span>
                  <span><b>Keep BobWork running</b>. This feed lives on your local BobWork server; Calendar.app refreshes by polling it.</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 rounded-full w-4 h-4 flex items-center justify-center text-9" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>2</span>
                  <span>Open <b>Calendar.app</b> on your Mac → <b>File → New Calendar Subscription…</b> (⌥⌘S)</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 rounded-full w-4 h-4 flex items-center justify-center text-9" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>3</span>
                  <span>Paste the <b>http://</b> URL above and click <b>Subscribe</b> (if your macOS rewrites webcal:// to https://, the plain http:// URL is required for the local server)</span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 rounded-full w-4 h-4 flex items-center justify-center text-9" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>4</span>
                  <span>Set <b>Auto-refresh</b> to Every 5 minutes (or as preferred)</span>
                </li>
              </ol>
              <div className="mt-3 rounded-md px-2.5 py-2 text-10 leading-4" style={{ backgroundColor: 'var(--warning-soft)', color: 'var(--warning)' }}>
                ⚠ This is a <b>read-only, local-only feed</b>. Events only flow from BobWork → Apple Calendar; edits you make in Apple Calendar will <b>not</b> appear back in BobWork. BobWork must remain open for Calendar.app to see refreshes.
              </div>
              <div className="mt-2 text-10 leading-4" style={{ color: 'var(--ink-faint)' }}>
                iOS/iPadOS: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar → paste the URL.
                iPhone/iPad must be on the same network as this Mac, or use the same localhost forwarder.
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <Button
                onClick={() => setShowSubscribeModal(false)}
                variant="solid"
                tone="brand"
                size="sm"
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 账户管理/同步配置弹窗 */}
      {showAccountModal && (
        <div
          className="fixed inset-0 z-[101]"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onPointerDown={(e) => { e.stopPropagation(); setShowAccountModal(false); }}
        >
          <div
            className="absolute left-1/2 top-1/2 max-h-[80vh] w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border p-5 shadow-2xl"
            style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Calendar Sync Accounts</h3>
              <Button onClick={() => setShowAccountModal(false)} variant="ghost" tone="neutral" size="icon-sm" aria-label="close accounts">
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* 已配置账户 */}
            <div className="mb-4">
              <div className="mb-1.5 text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>Configured</div>
              {syncAccounts.length === 0 && (
                <div className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--line-soft)', color: 'var(--ink-faint)' }}>
                  No accounts yet. Add an iCloud (CalDAV) or WebCal subscription below.
                </div>
              )}
              {syncAccounts.map((a) => (
                <div key={a.account_id} className="mb-1.5 flex items-center gap-2 rounded-md border px-3 py-2" style={{ borderColor: 'var(--line-soft)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--ink)' }}>
                      {a.name}
                      <span className="rounded px-1 text-10" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>
                        {a.provider === 'caldav' ? (a.read_only ? 'CalDAV·RO' : 'CalDAV') : 'WebCal'}
                      </span>
                      {!a.enabled && <span className="text-10" style={{ color: 'var(--ink-faint)' }}>(disabled)</span>}
                    </div>
                    <div className="truncate text-10" style={{ color: 'var(--ink-faint)' }}>
                      {a.calendar_name || a.username || a.server_url || '—'}
                      {a.last_sync_at ? ` · last sync ${new Date(a.last_sync_at).toLocaleString()}` : ' · never synced'}
                    </div>
                  </div>
                  {a.provider === 'caldav' && (
                    <button
                      onClick={() => toggleReadOnly(a.account_id, !a.read_only)}
                      className="shrink-0 rounded-md border px-2 py-1 text-10 transition-colors"
                      style={{
                        borderColor: 'var(--line-soft)',
                        backgroundColor: a.read_only ? 'var(--paper-hover)' : 'var(--primary-soft)',
                        color: a.read_only ? 'var(--ink-muted)' : 'var(--primary)',
                      }}
                      title={a.read_only ? 'Read-only: pull events in only. Click to enable two-way sync.' : 'Two-way sync. Click to switch to read-only.'}
                    >
                      {a.read_only ? 'Read-only' : 'Two-way'}
                    </button>
                  )}
                  <Button onClick={() => removeAccount(a.account_id)} variant="ghost" tone="danger" size="icon-sm" title="Remove account" aria-label="Remove account">
                    <Trash className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            {/* 添加账户 */}
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="mb-2 flex gap-1">
                {(['caldav', 'webcal'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setAccForm((f) => ({ ...f, provider: p, calendar_url: '', server_url: '' }))}
                    className="rounded-md px-3 py-1 text-xs transition-colors"
                    style={{
                      backgroundColor: accForm.provider === p ? 'var(--primary-soft)' : 'transparent',
                      color: accForm.provider === p ? 'var(--primary)' : 'var(--ink-muted)',
                    }}
                  >
                    {p === 'caldav' ? 'iCloud (CalDAV)' : 'WebCal URL'}
                  </button>
                ))}
              </div>

              {addErr && (
                <div className="mb-2 rounded-md px-2 py-1 text-11" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }}>
                  {addErr}
                </div>
              )}

              {accForm.provider === 'caldav' ? (
                <>
                  {/* iCloud CalDAV 设置指引 */}
                  <div className="mb-3 rounded-md border p-2.5" style={{ borderColor: 'var(--primary-soft)', backgroundColor: 'var(--primary-soft)' }}>
                    <div className="mb-1.5 text-11 font-medium" style={{ color: 'var(--primary)' }}>Setup Guide</div>
                    <ol className="space-y-1 text-10 leading-4" style={{ color: 'var(--ink-muted)' }}>
                      <li><b style={{ color: 'var(--ink)' }}>1.</b> Open <a href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--primary)' }}>appleid.apple.com</a> → sign in with your Apple ID</li>
                      <li><b style={{ color: 'var(--ink)' }}>2.</b> Go to <b>App-Specific Passwords</b> → generate one for BobWork</li>
                      <li><b style={{ color: 'var(--ink)' }}>3.</b> Enter your Apple ID email + the generated password below</li>
                      <li><b style={{ color: 'var(--ink)' }}>4.</b> Click <b>Discover calendars</b> → pick the iCloud calendar to sync</li>
                      <li><b style={{ color: 'var(--ink)' }}>5.</b> Click <b>Add &amp; Sync</b> — done! Auto-syncs every 5 min</li>
                    </ol>
                    <div className="mt-1.5 text-10" style={{ color: 'var(--ink-faint)' }}>
                      Two-way sync by default. Toggle Read-only to pull only.
                    </div>
                  </div>
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <input
                      value={accForm.name}
                      onChange={(e) => setAccForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="Account name (e.g. iCloud)"
                      className="rounded-md border px-2 py-1.5 text-xs outline-none"
                      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                    />
                    <input
                      value={accForm.username}
                      onChange={(e) => setAccForm((f) => ({ ...f, username: e.target.value }))}
                      placeholder="Apple ID email"
                      className="rounded-md border px-2 py-1.5 text-xs outline-none"
                      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                    />
                  </div>
                  <input
                    type="password"
                    value={accForm.password}
                    onChange={(e) => setAccForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="App-specific password"
                    className="mb-2 w-full rounded-md border px-2 py-1.5 text-xs outline-none"
                    style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                  />
                  <div className="mb-2 flex items-center gap-2">
                    <Button
                      onClick={discoverCalendars}
                      disabled={addBusy || !accForm.username || !accForm.password}
                      loading={addBusy}
                      variant="soft"
                      tone="brand"
                      size="sm"
                    >
                      {addBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      Discover calendars
                    </Button>
                  </div>
                  {discovered.length > 0 && (
                    <div className="mb-2 max-h-40 overflow-y-auto rounded-md border p-1.5" style={{ borderColor: 'var(--line-soft)' }}>
                      {discovered.map((c) => (
                        <label key={c.url} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--paper-hover)]">
                          <input
                            type="radio"
                            name="cal-radio"
                            checked={accForm.calendar_url === c.url}
                            onChange={() => setAccForm((f) => ({ ...f, calendar_url: c.url }))}
                          />
                          <span style={{ color: 'var(--ink)' }}>{c.displayName}</span>
                          <span className="truncate text-10" style={{ color: 'var(--ink-faint)' }}>{c.url}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <label className="mb-2 flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                    <input
                      type="checkbox"
                      checked={accForm.read_only}
                      onChange={(e) => setAccForm((f) => ({ ...f, read_only: e.target.checked }))}
                    />
                    Read-only (pull events in, don&apos;t push BobWork events out)
                  </label>
                </>
              ) : (
                <>
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <input
                      value={accForm.name}
                      onChange={(e) => setAccForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="Subscription name"
                      className="rounded-md border px-2 py-1.5 text-xs outline-none"
                      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                    />
                    <input
                      value={accForm.server_url}
                      onChange={(e) => setAccForm((f) => ({ ...f, server_url: e.target.value }))}
                      placeholder="https://…/calendar.ics or webcal://"
                      className="rounded-md border px-2 py-1.5 text-xs outline-none"
                      style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                    />
                  </div>
                  <label className="mb-2 flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                    <input
                      type="checkbox"
                      checked
                      disabled
                    />
                    WebCal is always read-only
                  </label>
                </>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => setShowAccountModal(false)}
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                >
                  Cancel
                </Button>
                <Button
                  onClick={addAccount}
                  disabled={
                    addBusy ||
                    (accForm.provider === 'caldav'
                      ? !accForm.username || !accForm.password || !accForm.calendar_url
                      : !accForm.server_url)
                  }
                  loading={addBusy}
                  variant="solid"
                  tone="brand"
                  size="sm"
                >
                  {addBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                  Add &amp; Sync
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
