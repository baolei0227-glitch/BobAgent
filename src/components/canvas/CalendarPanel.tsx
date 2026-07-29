'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
  Calendar,
  Clock,
  MapPin,
  Tag,
  Loader2,
  Trash2,
  CheckCircle2,
  Circle,
  XCircle,
} from 'lucide-react';

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

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function CalendarPanel({ projectId, onClose }: CalendarPanelProps) {
  const [date, setDate] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [saving, setSaving] = useState(false);

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
    try {
      const resp = await fetch(
        `/api/calendar/events?range_start=${monthStart.toISOString()}&range_end=${new Date(year, month + 2, 0).toISOString()}`,
      );
      const data = await resp.json();
      if (data.success) setEvents(data.events || []);
    } catch (err) {
      console.error('fetchEvents error:', err);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // 监听任务面板导入事件
  useEffect(() => {
    const handler = () => fetchEvents();
    window.addEventListener('calendar-events-changed', handler);
    return () => window.removeEventListener('calendar-events-changed', handler);
  }, [fetchEvents]);

  // 前月/后月导航
  const goPrev = () => setDate(new Date(year, month - 1, 1));
  const goNext = () => setDate(new Date(year, month + 1, 1));
  const goToday = () => setDate(new Date());

  // 打开新建弹窗（指定日期）
  const openCreate = (dateStr: string) => {
    setFormTitle('');
    setFormDate(dateStr);
    setFormStartTime('');
    setFormEndTime('');
    setFormAllDay(false);
    setFormPriority('normal');
    setFormDescription('');
    setFormLocation('');
    setFormColor('#F59E0B');
    setEditMode({ date: dateStr });
  };

  // 打开编辑弹窗
  const openEdit = (ev: CalendarEvent) => {
    setFormTitle(ev.title);
    const d = new Date(ev.start_time);
    setFormDate(toLocalDateStr(d));
    setFormStartTime(ev.all_day ? '' : d.toTimeString().slice(0, 5));
    setFormEndTime(ev.end_time && !ev.all_day ? new Date(ev.end_time).toTimeString().slice(0, 5) : '');
    setFormAllDay(ev.all_day);
    setFormPriority(ev.priority);
    setFormDescription(ev.description || '');
    setFormLocation(ev.location || '');
    setFormColor(ev.color || '#F59E0B');
    setEditMode({ event_id: ev.event_id });
  };

  // 提交表单
  const handleSubmit = async () => {
    if (!formTitle.trim()) return;
    setSaving(true);
    try {
      const startIso = formAllDay
        ? new Date(formDate + 'T00:00:00').toISOString()
        : new Date(formDate + 'T' + (formStartTime || '09:00') + ':00').toISOString();
      const endIso = formAllDay
        ? null
        : formEndTime
          ? new Date(formDate + 'T' + formEndTime + ':00').toISOString()
          : undefined;

      const body: any = {
        title: formTitle.trim(),
        start_time: startIso,
        end_time: endIso ?? null,
        all_day: formAllDay,
        priority: formPriority,
        description: formDescription.trim() || null,
        location: formLocation.trim() || null,
        color: formColor,
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
          return;
        }
      }
      setEditMode(null);
      fetchEvents();
    } catch (err) {
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  };

  // 删除事件
  const handleDelete = async (eventId: string) => {
    if (!confirm('Delete this event?')) return;
    try {
      await fetch(`/api/calendar/events?event_id=${eventId}`, { method: 'DELETE' });
      fetchEvents();
    } catch (err) {
      console.error('Delete error:', err);
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

  return (
    <div
      className="fixed right-0 top-0 z-50 flex h-full flex-col"
      style={{
        width: '420px',
        backgroundColor: '#faf8f3',
        borderLeft: '1px solid rgba(0, 0, 0, 0.07)',
        boxShadow: '-12px 0 32px rgba(0, 0, 0, 0.06)',
        fontFamily: "'Noto Serif SC', serif",
      }}
    >
      {/* 头部 */}
      <div
        className="flex shrink-0 items-center justify-between border-b px-4 py-3"
        style={{ borderColor: 'rgba(0, 0, 0, 0.07)', backgroundColor: '#f5f2ec' }}
      >
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4" style={{ color: 'oklch(0.55 0.15 45)' }} />
          <span className="text-sm font-semibold" style={{ color: '#2c2416' }}>Calendar</span>
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-black/5"
          style={{ color: '#8a8270' }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 月份导航 */}
      <div className="flex shrink-0 items-center justify-between px-4 py-2">
        <button
          onClick={goPrev}
          className="rounded p-1 transition-colors hover:bg-black/5"
          style={{ color: '#5c5342' }}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: '#2c2416' }}>
            {date.toLocaleString('default', { month: 'long' })} {year}
          </span>
          <button
            onClick={goToday}
            className="rounded px-2 py-0.5 text-[10px] transition-colors hover:bg-black/5"
            style={{ color: 'oklch(0.50 0.12 45)', border: '1px solid currentColor' }}
          >
            Today
          </button>
        </div>
        <button
          onClick={goNext}
          className="rounded p-1 transition-colors hover:bg-black/5"
          style={{ color: '#5c5342' }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* 星期标题 */}
      <div className="grid shrink-0 grid-cols-7 border-b" style={{ borderColor: 'rgba(0, 0, 0, 0.06)' }}>
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="py-1 text-center text-[10px] font-medium"
            style={{ color: '#8a8270' }}
          >
            {day}
          </div>
        ))}
      </div>

      {/* 日历格子 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: '#8a8270' }} />
          </div>
        ) : (
          <div className="grid grid-cols-7">
            {Array.from({ length: totalCells }).map((_, i) => {
              const cellDate = new Date(year, month, 1 - startDayOfWeek + i);
              const cellDateStr = toLocalDateStr(cellDate);
              const isCurrentMonth = cellDate.getMonth() === month;
              const isToday = cellDateStr === todayStr;
              const dayEvents = eventsByDate.get(cellDateStr) || [];

              return (
                <div
                  key={i}
                  className="relative cursor-pointer border-b border-r p-0.5 transition-colors hover:bg-black/[0.02]"
                  style={{
                    minHeight: '72px',
                    borderColor: 'rgba(0, 0, 0, 0.04)',
                    opacity: isCurrentMonth ? 1 : 0.3,
                  }}
                  onClick={() => openCreate(cellDateStr)}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="text-[11px] font-medium"
                      style={{
                        color: isToday ? '#faf8f3' : '#2c2416',
                        backgroundColor: isToday ? 'oklch(0.62 0.17 45)' : 'transparent',
                        borderRadius: isToday ? '9999px' : undefined,
                        width: isToday ? '20px' : undefined,
                        height: isToday ? '20px' : undefined,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {cellDate.getDate()}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openCreate(cellDateStr);
                      }}
                      className="flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity hover:bg-black/5 group-hover:opacity-100"
                      style={{ color: '#8a8270' }}
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>

                  {/* 事件标签 */}
                  <div className="mt-0.5 space-y-px">
                    {dayEvents.slice(0, 3).map((ev) => {
                      const statusIconCls = ev.status === 'done'
                        ? { color: '#10b981', textDecoration: 'line-through' }
                        : ev.status === 'cancelled'
                          ? { color: '#9ca3af', textDecoration: 'line-through' }
                          : { color: ev.color || 'oklch(0.55 0.08 45)', textDecoration: 'none' };

                      return (
                        <div
                          key={ev.event_id}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(ev);
                          }}
                          className="truncate rounded px-1 py-px text-[9px] leading-tight transition-colors hover:brightness-95"
                          style={{
                            backgroundColor: `${ev.color || 'oklch(0.55 0.08 45)'}18`,
                            color: statusIconCls.color,
                            textDecoration: statusIconCls.textDecoration as any,
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
                      );
                    })}
                    {dayEvents.length > 3 && (
                      <span className="block px-1 text-[8px]" style={{ color: '#8a8270' }}>
                        +{dayEvents.length - 3} more
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
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
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 shadow-2xl"
            style={{
              width: '380px',
              backgroundColor: '#faf8f3',
              borderColor: 'rgba(0, 0, 0, 0.1)',
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-sm font-semibold" style={{ color: '#2c2416' }}>
              {'event_id' in editMode ? 'Edit Event' : 'New Event'}
            </h3>

            {/* 标题 */}
            <input
              type="text"
              placeholder="Event title"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              className="mb-3 w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-amber-400"
              style={{
                backgroundColor: '#fff',
                borderColor: 'rgba(0, 0, 0, 0.1)',
                color: '#2c2416',
              }}
              autoFocus
            />

            {/* 日期 */}
            <div className="mb-2">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: '#8a8270' }}>Date</label>
              <input
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                className="w-full rounded-md border px-3 py-1.5 text-sm"
                style={{
                  backgroundColor: '#fff',
                  borderColor: 'rgba(0, 0, 0, 0.1)',
                  color: '#2c2416',
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
              <span className="text-[11px]" style={{ color: '#5c5342' }}>All day</span>
            </label>

            {/* 时间（非全天时） */}
            {!formAllDay && (
              <div className="mb-2 flex gap-2">
                <div className="flex-1">
                  <label className="mb-1 block text-[10px] font-medium" style={{ color: '#8a8270' }}>Start</label>
                  <input
                    type="time"
                    value={formStartTime}
                    onChange={(e) => setFormStartTime(e.target.value)}
                    className="w-full rounded-md border px-3 py-1.5 text-sm"
                    style={{
                      backgroundColor: '#fff',
                      borderColor: 'rgba(0, 0, 0, 0.1)',
                      color: '#2c2416',
                    }}
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-[10px] font-medium" style={{ color: '#8a8270' }}>End</label>
                  <input
                    type="time"
                    value={formEndTime}
                    onChange={(e) => setFormEndTime(e.target.value)}
                    className="w-full rounded-md border px-3 py-1.5 text-sm"
                    style={{
                      backgroundColor: '#fff',
                      borderColor: 'rgba(0, 0, 0, 0.1)',
                      color: '#2c2416',
                    }}
                  />
                </div>
              </div>
            )}

            {/* 优先级 */}
            <div className="mb-2">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: '#8a8270' }}>Priority</label>
              <select
                value={formPriority}
                onChange={(e) => setFormPriority(e.target.value as any)}
                className="w-full rounded-md border px-3 py-1.5 text-sm"
                style={{
                  backgroundColor: '#fff',
                  borderColor: 'rgba(0, 0, 0, 0.1)',
                  color: '#2c2416',
                }}
              >
                {(['high', 'normal', 'low'] as const).map((p) => (
                  <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                ))}
              </select>
            </div>

            {/* 颜色 */}
            <div className="mb-2">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: '#8a8270' }}>Color</label>
              <input
                type="color"
                value={formColor}
                onChange={(e) => setFormColor(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded border"
                style={{ borderColor: 'rgba(0, 0, 0, 0.1)' }}
              />
            </div>

            {/* 描述 */}
            <div className="mb-2">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: '#8a8270' }}>Description</label>
              <textarea
                placeholder="Optional"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                rows={2}
                className="w-full rounded-md border px-3 py-1.5 text-sm resize-none"
                style={{
                  backgroundColor: '#fff',
                  borderColor: 'rgba(0, 0, 0, 0.1)',
                  color: '#2c2416',
                }}
              />
            </div>

            {/* 地点 */}
            <div className="mb-4">
              <label className="mb-1 block text-[10px] font-medium" style={{ color: '#8a8270' }}>Location</label>
              <input
                type="text"
                placeholder="Optional"
                value={formLocation}
                onChange={(e) => setFormLocation(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
                style={{
                  backgroundColor: '#fff',
                  borderColor: 'rgba(0, 0, 0, 0.1)',
                  color: '#2c2416',
                }}
              />
            </div>

            {/* 操作按钮 */}
            <div className="flex items-center justify-between">
              <div>
                {'event_id' in editMode && (
                  <button
                    onClick={() => {
                      handleDelete(editMode.event_id);
                      setEditMode(null);
                    }}
                    className="flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors hover:bg-red-50"
                    style={{ color: 'oklch(0.55 0.18 25)' }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditMode(null)}
                  className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-black/5"
                  style={{ color: '#5c5342' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={saving || !formTitle.trim()}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
                  style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {'event_id' in editMode ? 'Save' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
