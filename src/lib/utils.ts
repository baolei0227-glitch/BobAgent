import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 把本地的「YYYY-MM-DD（必选）+ HH:MM（可选，缺省 fallbackHour:fallbackMin）」拼成本地时区 ISO
 * （如 2026-09-10 09:30 → 2026-09-10T09:30:00+08:00），供日历事件 start_time 使用。
 * 解析失败返回 null。
 */
export function localDateTimeToIso(
  dateStr: string,
  timeStr?: string,
  fallbackMinute = '09:00',
): string | null {
  const d = dateStr.trim();
  const m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  let hh = 9;
  let mm = 0;
  const t = (timeStr ?? '').trim();
  if (t) {
    const tm = t.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!tm) return null;
    hh = Number(tm[1]);
    mm = Number(tm[2]);
  } else if (fallbackMinute) {
    const fm = fallbackMinute.match(/^(\d{1,2}):(\d{1,2})$/);
    if (fm) {
      hh = Number(fm[1]);
      mm = Number(fm[2]);
    }
  }
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm, 0, 0);
  if (!Number.isFinite(dt.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -dt.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T` +
    `${pad(dt.getHours())}:${pad(dt.getMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
