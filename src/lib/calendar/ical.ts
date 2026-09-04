/**
 * 最小 iCal (.ics) 解析 / 生成工具（无第三方依赖）
 *
 * 语法参考 RFC 5545，但只实现本产品需要的子集：
 *  - 解析：VEVENT 的 UID / SUMMARY / DESCRIPTION / LOCATION /
 *           DTSTART / DTEND / DTSTAMP / STATUS / PRIORITY / CATEGORIES / RRULE
 *  - 生成：输出带 VERSION:2.0 / PRODID 的标准 VCALENDAR
 *
 * 说明：
 *  - 时间格式支持本地时间（TZID 前缀，无 Z）与 UTC（Z 结尾）。
 *    DTSTART 带 TZID 时按本地中国时区（Asia/Shanghai）解释，输出统一为 ISO。
 *  - 全天天事件 DTSTART 为 DATE（YYYYMMDD），end 为次日 DATE（排除式）。
 *  - 折叠行（RFC 5545 折行）在解析前用 ITSKY 展开。
 */

const FOLD = /[\r\n]+[ \t]/g;
const UNFOLD = '\n';

/** 解析后的事件（与业务 CreateEventData 对齐） */
export interface ParsedIcalEvent {
  external_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_time: string;          // ISO 8601
  end_time: string | null;     // ISO 8601
  all_day: boolean;
  status: 'scheduled' | 'cancelled' | 'done';
  priority: 'high' | 'normal' | 'low';
  color: string | null;
  tags: string[];
}

/** 把 DATE-TIME 值解析为 ISO 字符串。tzid 为 TZID 参数（如 "Asia/Shanghai"） */
function toISO(value: string, tzid: string | null): string {
  // 1. UTC 结尾 Z
  if (value.endsWith('Z')) {
    const d = new Date(value.slice(0, 15) + 'Z');
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  // 2. 带时间（YYYYMMDDTHHMMSS）+ 可选 TZID
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (m) {
    const tz = tzid && tzid !== 'UTC' ? tzid : 'Asia/Shanghai';
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    // 尝试用 TZID 名称解析（Node 内置 Intl 支持 IANA 时区）
    try {
      const zoned = new Date(new Date(iso).toLocaleString('en-US', { timeZone: tz }));
      const shifted = new Date(iso);
      const diff = zoned.getTime() - shifted.getTime(); // 该时区相对本地的偏移
      return new Date(shifted.getTime() - diff).toISOString();
    } catch {
      return new Date(iso).toISOString();
    }
  }
  // 3. 纯日期（全天天事件）
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dm) {
    return new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])).toISOString();
  }
  return new Date().toISOString();
}

/** 解析 .ics 文本，返回事件数组（去重按 UID，一个 UID 只保留最后一个） */
export function parseIcs(text: string): ParsedIcalEvent[] {
  const unfolded = text.replace(FOLD, UNFOLD);
  const blocks = unfolded.split(/BEGIN:VEVENT/i);
  const out = new Map<string, ParsedIcalEvent>();

  for (let i = 1; i < blocks.length; i++) {
    const body = blocks[i].split(/END:VEVENT/i)[0];
    const props: Record<string, string[]> = {};
    for (const line of body.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toUpperCase();
      const val = line.slice(idx + 1).trim();
      // 提取 TZID 参数（如 DTSTART;TZID=Asia/Shanghai:...）
      const tzMatch = /^([^;]+);TZID=([^:]+):/.exec(line);
      const baseKey = tzMatch ? tzMatch[1].toUpperCase() : key;
      (props[baseKey] = props[baseKey] || []).push(val);
    }

    const uid = props.UID?.[0] ?? '';
    const summary = props.SUMMARY?.[0] ?? '(Untitled)';
    const dtstart = props.DTSTART?.[0] ?? '';
    const dtend = props.DTEND?.[0];
    const dtend2 = (props.DTEND?.[1] ?? '') as string;
    const tzMatch = /^DTSTART;TZID=([^:]+):/.exec(blocks[i].split('\n').find((l) => /^DTSTART/i.test(l)) ?? '');
    const tzid = tzMatch ? tzMatch[1] : null;

    const allDay = /^\d{8}$/.test(dtstart);
    const startIso = toISO(dtstart, tzid);
    let endIso: string | null = null;
    if (dtend) {
      endIso = toISO(dtend, tzMatch ? tzMatch[1] : tzid);
    } else if (dtend2) {
      endIso = toISO(dtend2, tzid);
    } else if (allDay) {
      // 全天事件默认当天结束
      const d = new Date(startIso);
      endIso = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
    }

    const status = (props.STATUS?.[0] ?? 'CONFIRMED').toUpperCase();
    const bobStatus = (props['X-BOB-STATUS']?.[0] ?? '').toUpperCase();
    const prioRaw = props.PRIORITY?.[0];

    const tags = (props.CATEGORIES?.[0] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    out.set(uid || `uid-${i}`, {
      external_id: uid,
      title: summary,
      description: props.DESCRIPTION?.[0] ?? null,
      location: props.LOCATION?.[0] ?? null,
      start_time: startIso,
      end_time: endIso,
      all_day: allDay,
      status: bobStatus === 'DONE' ? 'done' : (status === 'CANCELLED' ? 'cancelled' : 'scheduled'),
      priority:
        prioRaw === undefined || prioRaw === '' || prioRaw === '5'
          ? 'normal'
          : Number(prioRaw) <= 3 ? 'high' : Number(prioRaw) >= 7 ? 'low' : 'normal',
      color: null,
      tags,
    });
  }
  return Array.from(out.values());
}

/** 把本地事件转成 VEVENT 块（用于 .ics 导出 / CalDAV 推送） */
function vevent(
  ev: { external_id?: string | null; title: string; description?: string | null; location?: string | null; start_time: string | null; end_time?: string | null; all_day?: boolean; status?: string; priority?: string; tags?: string[] },
  uid: string,
): string {
  const lines: string[] = [];
  lines.push('BEGIN:VEVENT');
  lines.push('UID:' + uid);
  lines.push('DTSTAMP:' + new Date().toISOString().split('-').join('').split(':').join('').split('.').join('').slice(0, 15) + 'Z');
  lines.push('SUMMARY:' + escapeIcs(ev.title));
  if (ev.description) lines.push('DESCRIPTION:' + escapeIcs(ev.description));
  if (ev.location) lines.push('LOCATION:' + escapeIcs(ev.location));
  if (ev.tags && ev.tags.length) lines.push('CATEGORIES:' + ev.tags.map(escapeIcs).join(','));
  lines.push('STATUS:' + (ev.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'));
  // 私有扩展字段：BobWork 完成状态（Mac 日历等标准客户端会忽略 X- 属性）
  if (ev.status === 'done') lines.push('X-BOB-STATUS:DONE');

  // start_time 为 null 的无时间清单项不输出 DTSTART/DTEND（纯待办不占日历时段）
  if (ev.start_time) {
    const start = new Date(ev.start_time);
    if (ev.all_day) {
      const end = ev.end_time ? new Date(ev.end_time) : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      lines.push('DTSTART;VALUE=DATE:' + dateOnly(start));
      lines.push('DTEND;VALUE=DATE:' + dateOnly(end));
    } else {
      lines.push('DTSTART:' + dateTime(start));
      const end = ev.end_time ? new Date(ev.end_time) : new Date(start.getTime() + 3600 * 1000);
      lines.push('DTEND:' + dateTime(end));
    }
  }
  lines.push('END:VEVENT');
  return lines.join('\n');
}

function escapeIcs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function dateOnly(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function dateTime(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

/** 生成标准 .ics 文本（含一个 VCALENDAR） */
export function buildIcs(
  events: Array<{ external_id?: string | null; title: string; description?: string | null; location?: string | null; start_time: string | null; end_time?: string | null; all_day?: boolean; status?: string; priority?: string; tags?: string[] }>,
  opts?: { calendarName?: string },
): string {
  const chunks = events.map((ev, i) =>
    vevent(ev, ev.external_id || `bob-${i}-${Date.now()}`),
  );
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BobWork//Calendar Sync//CN',
    'CALSCALE:GREGORIAN',
  ];
  // X-WR-CALNAME：订阅端（macOS/iOS 日历）用此值作为日历显示名，缺失时回退为 "CalDAV" 或 URL 主机名
  if (opts?.calendarName) {
    header.push('X-WR-CALNAME:' + escapeIcs(opts.calendarName));
  }
  return [
    ...header,
    ...chunks,
    'END:VCALENDAR',
  ].join('\r\n');
}