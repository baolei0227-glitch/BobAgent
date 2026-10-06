/**
 * Butler 回执（通知）详情的**展示格式层** —— 纯函数 + 一个类型，不依赖 React。
 *
 * ## 为什么独立成模块
 * 这些原本是 `ButlerDrawer.tsx` 的私有定义（`formatTime` / `ScheduleDetail` /
 * `fmtEventWhen` / `fmtReminderMinutes`）。2026-10-05 移动端 `/butler` 要复刻**同一条回执详情**
 * ——日期时间怎么写、「提前 30 min」怎么口语化，两端口径必须一致，否则同一条日程在手机与
 * 桌面显示的措辞会漂移。故就地抽为共享真源，桌面改为 import。
 *
 * 抽出时实现逐字未改，桌面行为零回归。
 */
import type { RecurrenceRule } from '@/lib/calendar/recurrence';

/** 紧凑时间：今天只给「21:30」，跨天给「09-26 21:30」。用于联系人列预览 / 通知卡片头等**列表位**。 */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

/**
 * 通知详情里「日程」块的完整事件信息。
 * 通知条目（ButlerNoticeItem）只带 title / 开始时刻，地点 / 备注 / 结束时间 / 重复 / 提醒
 * 都要点开后按事件 id 到日历库现取（GET /api/calendar/events?event_id=…）。
 */
export interface ScheduleDetail {
  event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_time: string | null;
  end_time: string | null;
  all_day: boolean;
  status: string;
  priority: string;
  recurrence: RecurrenceRule | null;
  reminder_minutes: number[];
  reminder_disabled: boolean;
}

/** 本地日期 YYYY-MM-DD */
function fmtEventDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 本地 HH:mm */
function fmtEventHm(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 日程时间：`2026-09-25 · All day` / `2026-09-25 · 14:00 - 15:00`；结束跨天补一段日期 */
export function fmtEventWhen(startIso: string | null, endIso: string | null, allDay: boolean): string {
  if (!startIso) return '';
  const date = fmtEventDate(startIso);
  if (allDay) return `${date} · All day`;
  const start = `${date} · ${fmtEventHm(startIso)}`;
  if (!endIso) return start;
  const sameDay = fmtEventDate(endIso) === date;
  return `${start} - ${sameDay ? fmtEventHm(endIso) : `${fmtEventDate(endIso)} ${fmtEventHm(endIso)}`}`;
}

/** 提前量人类可读：`30 min` / `1 h` / `1 day`（与推送正文口径一致） */
export function fmtReminderMinutes(minutes: number): string {
  if (minutes >= 1440) {
    const d = minutes / 1440;
    return `${Number.isInteger(d) ? d : d.toFixed(1)} day`;
  }
  if (minutes >= 60) {
    const h = minutes / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
  }
  return `${minutes} min`;
}
