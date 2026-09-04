/**
 * CalDAV 同步引擎（iCloud / 自建 DAV 服务器）
 *
 * 采用 tsdav 客户端库（RFC 4791 支持）做 DAV 协议层：
 *  - 探测：fetchCalendars 列出日历集合
 *  - 拉取：fetchCalendarObjects 拉某日历下事件（含 etag / ics 原文）
 *  - 推送：createCalendarObject（新建/更新，带 If-Match: ETag 冲突校验）
 *  - 删除：deleteCalendarObject（带 etag）
 *
 * tsdav 为 ESM，统一用 await import 动态加载。
 */

import type { CalendarAccountRow } from '@/lib/db';

export interface DavCalendar {
  url: string;
  displayName: string;
  color: string | null;
}

export interface DavEvent {
  href: string;
  etag: string;
  ical: string;
}

/** 从 tsdav 客户端拉取日历列表 */
export async function discoverCalendars(
  serverUrl: string,
  username: string,
  password: string,
): Promise<DavCalendar[]> {
  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl,
    credentials: { username, password },
    authMethod: 'Basic',
    // 必须指定 defaultAccountType：tsdav 仅在其非空时才构建 account 对象，
    // 而 fetchCalendars 在 account 缺失时直接抛 "no account for fetchCalendars"
    defaultAccountType: 'caldav',
  });
  const calendars = await client.fetchCalendars({});
  return (calendars ?? []).map((c: any) => ({
    url: c.url || c.href || '',
    displayName: c.displayName || 'Untitled calendar',
    color: c.calendarColor || null,
  }));
}

/** 拉取某日历集合下的事件（返回 href / etag / ics 原文） */
export async function fetchCalendarEvents(
  calendarUrl: string,
  username: string,
  password: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<DavEvent[]> {
  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl: calendarUrl,
    credentials: { username, password },
    authMethod: 'Basic',
  });
  const events = await client.fetchCalendarObjects({
    calendar: { url: calendarUrl },
    timeRange: { start: rangeStart, end: rangeEnd },
  });
  return (events ?? [])
    .map((e: any) => ({
      href: e.url || e.href || '',
      etag: e.etag || '',
      ical: e.data || e.content || '',
    }))
    .filter((e) => e.href && e.ical);
}

/** 推送单个事件（新建或更新）。外部已存在（etag）时带 If-Match 校验。412 → 冲突返回 false。 */
export async function pushEvent(
  calendarUrl: string,
  username: string,
  password: string,
  hrefPath: string,
  ical: string,
  etag?: string | null,
): Promise<boolean> {
  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl: calendarUrl,
    credentials: { username, password },
    authMethod: 'Basic',
  });
  const filename = hrefPath.startsWith('http')
    ? hrefPath
    : calendarUrl.replace(/\/$/, '') + '/' + hrefPath.replace(/^\//, '');
  try {
    await client.createCalendarObject({
      calendar: { url: calendarUrl },
      iCalString: ical,
      filename,
      headers: etag ? { 'If-Match': etag } : {},
    });
    return true;
  } catch (e: any) {
    const code = (e as any)?.status || (e as any)?.response?.status || (e as any)?.statusCode;
    if (code === 412) return false;
    throw e;
  }
}

/** 删除外部事件（带 etag 做 If-Match），412 冲突返回 false */
export async function deleteDavEvent(
  calendarUrl: string,
  username: string,
  password: string,
  hrefPath: string,
  etag?: string | null,
): Promise<boolean> {
  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl: calendarUrl,
    credentials: { username, password },
    authMethod: 'Basic',
  });
  try {
    await client.deleteCalendarObject({
      calendarObject: { url: hrefPath, etag: etag || undefined },
    });
    return true;
  } catch (e: any) {
    const code = (e as any)?.status || (e as any)?.response?.status || (e as any)?.statusCode;
    if (code === 412) return false;
    throw e;
  }
}

/** WebCal 单向订阅：GET 一个 .ics URL 并返回文本 */
export async function fetchWebcal(webcalUrl: string): Promise<string> {
  const url = webcalUrl.replace(/^webcal:\/\//i, 'https://');
  const res = await fetch(url, { headers: { Accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`WebCal GET failed: ${res.status}`);
  return res.text();
}

/** 同步账户类型名 */
export function providerLabel(account: Pick<CalendarAccountRow, 'provider' | 'read_only'>): string {
  if (account.provider === 'webcal') return 'WebCal (Read-only)';
  return account.read_only ? 'CalDAV (Read-only)' : 'CalDAV (Two-way)';
}