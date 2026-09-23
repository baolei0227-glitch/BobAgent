/**
 * CalDAV 服务端 - 让系统日历.app 等客户端能连接 BobWork
 *
 * 实现 RFC 4791 CalDAV 协议的最小子集：
 *  - PROPFIND: 列出日历集合和事件列表
 *  - GET: 获取事件详情（.ics）
 *  - PUT: 创建/更新事件
 *  - DELETE: 删除事件
 *  - REPORT: 时间范围查询（calendar-multiget, calendar-query）
 *
 * 认证：Basic Auth（用户名 + Token）
 * 数据：BobWork events 表 ↔ CalDAV VEVENT 对象双向映射
 */

import { getCalendarDb, listCalendarAccounts, getCalendarAccount } from '@/lib/db';
import { parseIcs, buildIcs, type ParsedIcalEvent } from '@/lib/calendar/ical';

/* ────────────────────────────────────────────────────────────
 * 常量
 * ──────────────────────────────────────────────────────────── */

const CALDAV_VERSION = '2';
const CALENDAR_NAME = 'BobWork Calendar';
const CALENDAR_DESCRIPTION = 'BobWork personal calendar';

/* ────────────────────────────────────────────────────────────
 * 认证：Basic Auth 校验
 * ──────────────────────────────────────────────────────────── */

/** 生成/获取 CalDAV 访问 Token */
async function getOrCreateDavToken(): Promise<string> {
  const db = await getCalendarDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('dav_token') as { value: string } | undefined;
  if (row?.value) return row.value;
  const token = generateToken();
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('dav_token', token);
  return token;
}

function generateToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = 'bw-';
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

/** 验证 Basic Auth */
async function verifyBasicAuth(authHeader: string | null): Promise<boolean> {
  if (!authHeader) return false;
  const parts = authHeader.split(' ');
  if (parts[0] !== 'Basic' || !parts[1]) return false;
  try {
    const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
    const [username, token] = decoded.split(':');
    const expectedToken = await getOrCreateDavToken();
    return username === 'bobwork' && token === expectedToken;
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────
 * HTTP 响应构造
 * ──────────────────────────────────────────────────────────── */

interface DavResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

function okXml(body: string, extra: Record<string, string> = {}): DavResponse {
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset="utf-8"',
      DAV: CALDAV_VERSION,
      ...extra,
    },
    body,
  };
}

function okText(body: string, extra: Record<string, string> = {}): DavResponse {
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset="utf-8"',
      DAV: CALDAV_VERSION,
      ...extra,
    },
    body,
  };
}

function okCdata(body: string, extra: Record<string, string> = {}): DavResponse {
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset="utf-8"',
      ETag: `"${hashString(body)}"`,
      DAV: CALDAV_VERSION,
      ...extra,
    },
    body,
  };
}

function noContent(extra: Record<string, string> = {}): DavResponse {
  return {
    status: 204,
    headers: {
      DAV: CALDAV_VERSION,
      ...extra,
    },
  };
}

function notFound(): DavResponse {
  return { status: 404, headers: { DAV: CALDAV_VERSION } };
}

function badRequest(msg?: string): DavResponse {
  return { status: 400, headers: { DAV: CALDAV_VERSION }, body: msg };
}

function unauthorized(realm?: string): DavResponse {
  return {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${realm || 'BobWork Calendar'}"`,
      DAV: CALDAV_VERSION,
    },
  };
}

function forbidden(): DavResponse {
  return { status: 403, headers: { DAV: CALDAV_VERSION } };
}

function notImplemented(): DavResponse {
  return { status: 501, headers: { DAV: CALDAV_VERSION } };
}

/* ────────────────────────────────────────────────────────────
 * 工具函数
 * ──────────────────────────────────────────────────────────── */

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

function extractEventIdFromPath(path: string): string | null {
  const match = /\/events\/([^/]+)\.ics$/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

function stripDavPathPrefix(path: string): string {
  return path.replace(/^\/api\/dav/, '').replace(/\/$/, '') || '/';
}

/* ────────────────────────────────────────────────────────────
 * XML 响应生成
 * ──────────────────────────────────────────────────────────── */

/** 生成 PROPFIND 响应的 multistatus XML */
function buildPropfindMultistatus(
  href: string,
  props: Record<string, string>,
  extraProps: Record<string, Record<string, string>>[] = [],
): string {
  let propsXml = '';
  for (const [ns, localName, value] of Object.entries(props) as unknown as [string, string, string][]) {
    propsXml += `<x0:${localName} xmlns:x0="${ns}">${value}</x0:${localName}>`;
  }
  for (const extra of extraProps) {
    for (const [ns, valueMap] of Object.entries(extra)) {
      for (const [localName, value] of Object.entries(valueMap)) {
        propsXml += `<x1:${localName} xmlns:x1="${ns}">${value}</x1:${localName}>`;
      }
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop>
        ${propsXml}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
}

/** 日历集合的 PROPFIND 响应 */
function buildCalendarCollectionPropfind(baseHref: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>${baseHref}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${CALENDAR_NAME}</d:displayname>
        <cal:calendar-home-set/>
        <cal:calendar-name>${CALENDAR_NAME}</cal:calendar-name>
        <cal:calendar-description>${CALENDAR_DESCRIPTION}</cal:calendar-description>
        <cal:supported-calendar-component-set>
          <cal:comp name="VEVENT"/>
        </cal:supported-calendar-component-set>
        <cs:allow-create-calendar-component-set/>
        <resourcetype>
          <collection/>
          <cal:calendar/>
        </resourcetype>
        <getcontenttype>application/xml</getcontenttype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
}

/** 事件列表的 PROPFIND 响应 */
function buildEventListPropfind(baseHref: string, events: Array<{ href: string; displayName: string; lastModified: string; etag: string }>): string {
  let responses = '';
  for (const ev of events) {
    responses += `
    <d:response>
      <d:href>${ev.href}</d:href>
      <d:propstat>
        <d:prop>
          <d:displayname>${ev.displayName}</d:displayname>
          <d:getlastmodified>${ev.lastModified}</d:getlastmodified>
          <d:getetag>"${ev.etag}"</d:getetag>
          <getcontenttype>text/calendar</getcontenttype>
          <getcontentlength>0</getcontentlength>
          <resourcetype>
            <resource/>
          </resourcetype>
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
    </d:response>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>${baseHref}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Events</d:displayname>
        <resourcetype>
          <collection/>
        </resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>${responses}
</d:multistatus>`;
}

/** 单个事件的 PROPFIND 响应 */
function buildEventPropfind(href: string, displayName: string, lastModified: string, etag: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${displayName}</d:displayname>
        <d:getlastmodified>${lastModified}</d:getlastmodified>
        <d:getetag>"${etag}"</d:getetag>
        <getcontenttype>text/calendar</getcontenttype>
        <getcontentlength>0</getcontentlength>
        <resourcetype>
          <resource/>
        </resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
}

/* ────────────────────────────────────────────────────────────
 * 数据访问层：BobWork events ↔ CalDAV VEVENT 映射
 * ──────────────────────────────────────────────────────────── */

interface DavEventInfo {
  event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_time: string;
  end_time: string | null;
  all_day: number;
  status: string;
  priority: string;
  color: string | null;
  tags_json: string;
  tags_agg?: string | null;
  external_id?: string | null;
  external_url?: string | null;
  created_at: string;
  updated_at: string;
  sync_provider?: string | null;
}

/** 转换为 ParsedIcalEvent（buildIcs 需要的格式） */
function toParsedIcalEvent(ev: DavEventInfo): ParsedIcalEvent {
  let tags: string[] = [];
  try { tags = JSON.parse(ev.tags_json || '[]'); } catch { /* empty */ }
  return {
    external_id: ev.external_id || ev.event_id,
    title: ev.title,
    description: ev.description ?? null,
    location: ev.location ?? null,
    start_time: ev.start_time,
    end_time: ev.end_time ?? null,
    all_day: ev.all_day === 1,
    status: (ev.status as 'scheduled' | 'cancelled' | 'done') || 'scheduled',
    priority: (ev.priority as 'high' | 'normal' | 'low') || 'normal',
    color: ev.color ?? null,
    tags,
  };
}

async function listAllEvents(): Promise<DavEventInfo[]> {
  const db = await getCalendarDb();
  const rows = db.prepare(`
    SELECT e.*,
      GROUP_CONCAT(t.tag, ',') as tags_agg
    FROM events e
    LEFT JOIN event_tags t ON e.event_id = t.event_id
    WHERE e.status != 'cancelled' OR e.updated_at > datetime('now', '-7 days')
    GROUP BY e.event_id
    ORDER BY e.start_time DESC
  `).all() as DavEventInfo[];
  return rows.map((r) => ({
    ...r,
    tags_json: JSON.stringify(r.tags_agg ? r.tags_agg.split(',') : []),
  }));
}

async function getEventById(eventId: string): Promise<DavEventInfo | null> {
  const db = await getCalendarDb();
  const row = db.prepare(`
    SELECT e.*,
      GROUP_CONCAT(t.tag, ',') as tags_agg
    FROM events e
    LEFT JOIN event_tags t ON e.event_id = t.event_id
    WHERE e.event_id = ?
    GROUP BY e.event_id
  `).get(eventId) as DavEventInfo | undefined;
  if (!row) return null;
  return {
    ...row,
    tags_json: JSON.stringify(row.tags_agg ? row.tags_agg.split(',') : []),
  };
}

async function createOrUpdateEvent(eventId: string, icalText: string): Promise<DavEventInfo> {
  const db = await getCalendarDb();
  const parsed = parseIcs(icalText);
  if (parsed.length === 0) throw new Error('No VEVENT found in iCalendar data');
  const ev = parsed[0];

  const now = new Date().toISOString();
  const existing = await getEventById(eventId);

  if (existing) {
    db.prepare(`
      UPDATE events SET
        title = ?,
        description = ?,
        location = ?,
        start_time = ?,
        end_time = ?,
        all_day = ?,
        status = ?,
        priority = ?,
        color = ?,
        updated_at = ?,
        external_id = ?,
        sync_provider = 'caldav'
      WHERE event_id = ?
    `).run(
      ev.title,
      ev.description,
      ev.location,
      ev.start_time,
      ev.end_time,
      ev.all_day ? 1 : 0,
      ev.status,
      ev.priority,
      ev.color,
      now,
      ev.external_id || eventId,
      eventId,
    );
    // 更新标签
    db.prepare('DELETE FROM event_tags WHERE event_id = ?').run(eventId);
    for (const tag of ev.tags) {
      db.prepare('INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)').run(eventId, tag);
    }
  } else {
    db.prepare(`
      INSERT INTO events (
        event_id, project_id, title, description, location,
        start_time, end_time, all_day, status, priority,
        color, tags_json, scope, source_node_id, source_raw,
        external_id, sync_provider, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      '__global__',
      ev.title,
      ev.description,
      ev.location,
      ev.start_time,
      ev.end_time,
      ev.all_day ? 1 : 0,
      ev.status,
      ev.priority,
      ev.color,
      JSON.stringify(ev.tags),
      'global',
      null,
      null,
      ev.external_id || eventId,
      'caldav',
      now,
      now,
    );
    for (const tag of ev.tags) {
      db.prepare('INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)').run(eventId, tag);
    }
  }

  const result = await getEventById(eventId);
  if (!result) throw new Error('Failed to create/update event');
  return result;
}

async function deleteEventById(eventId: string): Promise<void> {
  const db = await getCalendarDb();
  db.prepare("UPDATE events SET status = 'cancelled', updated_at = ? WHERE event_id = ?").run(
    new Date().toISOString(),
    eventId,
  );
}

async function getEventIcs(eventId: string): Promise<string | null> {
  const ev = await getEventById(eventId);
  if (!ev) return null;

  const parsed = toParsedIcalEvent(ev);

  // 过滤已取消事件
  if (parsed.status === 'cancelled') {
    return null;
  }

  return buildIcs([parsed]);
}

function eventToFileInfo(ev: DavEventInfo, baseHref: string) {
  const parsed = toParsedIcalEvent(ev);
  const filename = `${parsed.external_id}.ics`;
  const href = `${baseHref}/${filename}`;
  const displayName = ev.title || '(untitled)';
  const lastModified = ev.updated_at ? new Date(ev.updated_at).toUTCString() : new Date().toUTCString();
  const ics = buildIcs([parsed]);
  const etag = hashString(ics);
  return { href, displayName, lastModified, etag };
}

/* ────────────────────────────────────────────────────────────
 * 认证 Token API
 * ──────────────────────────────────────────────────────────── */

/** 获取或重置 CalDAV 访问 Token */
export async function getDavToken(): Promise<string> {
  return getOrCreateDavToken();
}

export async function resetDavToken(): Promise<string> {
  const db = await getCalendarDb();
  const token = generateToken();
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('dav_token', token);
  return token;
}

/* ────────────────────────────────────────────────────────────
 * 主 CalDAV Handler
 * ──────────────────────────────────────────────────────────── */

export interface DavRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export async function handleDavRequest(req: DavRequest): Promise<DavResponse> {
  // 1. 认证
  const authHeader = req.headers.authorization || req.headers.Authorization || null;
  // OPTIONS / PROPFIND 用于发现，部分客户端不需要认证即可访问根
  const path = stripDavPathPrefix(new URL(req.url, 'http://localhost').pathname);
  const isDiscoverPath = path === '/' && (req.method === 'OPTIONS' || req.method === 'PROPFIND');
  if (!isDiscoverPath) {
    const authed = await verifyBasicAuth(authHeader);
    if (!authed) return unauthorized('BobWork Calendar');
  }

  const baseHref = req.url.replace(/\/api\/dav.*$/, '/api/dav');
  const pathSegments = path.split('/').filter(Boolean);

  // 2. 路由分发
  switch (req.method.toUpperCase()) {
    case 'OPTIONS':
      return handleOptions();

    case 'PROPFIND':
      return handlePropfind(pathSegments, baseHref, req.body);

    case 'GET':
      return handleGet(pathSegments, baseHref);

    case 'PUT':
      return handlePut(pathSegments, baseHref, req.body, req.headers);

    case 'DELETE':
      return handleDelete(pathSegments);

    case 'HEAD':
      return handleHead(pathSegments, baseHref);

    case 'MKCOL':
    case 'MOVE':
    case 'COPY':
    case 'LOCK':
    case 'UNLOCK':
    case 'PATCH':
      return noContent();

    case 'REPORT':
      return handleReport(pathSegments, baseHref, req.body);

    default:
      return badRequest(`Method ${req.method} not supported`);
  }
}

/** OPTIONS: 返回允许的 CalDAV 功能 */
function handleOptions(): DavResponse {
  return {
    status: 200,
    headers: {
      DAV: CALDAV_VERSION,
      Allow: 'OPTIONS, PROPFIND, GET, PUT, DELETE, HEAD, REPORT, MKCOL',
      'Cache-Control': 'no-store',
    },
  };
}

/** PROPFIND: 列出资源属性 */
async function handlePropfind(pathSegments: string[], baseHref: string, body?: string): Promise<DavResponse> {
  const pathType = classifyPath(pathSegments);
  const requestBody = body?.toLowerCase() || '';
  const isCalendarQuery = requestBody.includes('calendar-query') || requestBody.includes('calendar-multiget');

  // 根目录：返回日历集合
  if (pathType === 'root' || pathType === 'calendar') {
    const calendarHref = `${baseHref}/calendar`;
    return okXml(buildCalendarCollectionPropfind(calendarHref));
  }

  // 日历事件集合：列出所有事件
  if (pathType === 'events') {
    const events = await listAllEvents();
    const eventFiles = events.map((ev) => eventToFileInfo(ev, `${baseHref}/events`));
    return okXml(buildEventListPropfind(`${baseHref}/events`, eventFiles));
  }

  // 单个事件
  if (pathType === 'event') {
    const eventId = pathSegments[pathSegments.length - 1].replace(/\.ics$/, '');
    const ev = await getEventById(decodeURIComponent(eventId));
    if (!ev) return notFound();
    const info = eventToFileInfo(ev, `${baseHref}/events`);
    return okXml(buildEventPropfind(info.href, info.displayName, info.lastModified, info.etag));
  }

  return notFound();
}

/** GET: 获取事件内容 */
async function handleGet(pathSegments: string[], baseHref: string): Promise<DavResponse> {
  const pathType = classifyPath(pathSegments);

  if (pathType === 'root' || pathType === 'calendar' || pathType === 'events') {
    // 目录列表
    const events = await listAllEvents();
    const items = events.map((ev) => `<li><a href="${baseHref}/events/${ev.event_id}.ics">${ev.title}</a></li>`).join('');
    const html = `<!DOCTYPE html><html><body><h1>BobWork Calendar</h1><ul>${items}</ul></body></html>`;
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset="utf-8"', DAV: CALDAV_VERSION },
      body: html,
    };
  }

  if (pathType === 'event') {
    const eventId = pathSegments[pathSegments.length - 1].replace(/\.ics$/, '');
    const ical = await getEventIcs(decodeURIComponent(eventId));
    if (!ical) return notFound();
    return okCdata(ical);
  }

  return notFound();
}

/** PUT: 创建/更新事件 */
async function handlePut(
  pathSegments: string[],
  baseHref: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<DavResponse> {
  const pathType = classifyPath(pathSegments);

  if (pathType !== 'event') return badRequest('Event path required');
  if (!body) return badRequest('Empty body');

  const rawEventId = decodeURIComponent(pathSegments[pathSegments.length - 1].replace(/\.ics$/, ''));
  let eventId = rawEventId;

  // 从 ical 中解析 UID 作为 event_id（如果 UID 存在）
  try {
    const parsed = parseIcs(body);
    if (parsed.length > 0 && parsed[0].external_id) {
      eventId = parsed[0].external_id;
    }
  } catch {
    // 使用路径中的 ID
  }

  // 检查 If-None-Match / If-Match
  const ifNoneMatch = (headers['if-none-match'] || headers['If-None-Match'] || '').trim();
  const ifMatch = (headers['if-match'] || headers['If-Match'] || '').trim();

  const existing = await getEventById(eventId);

  // If-None-Match: * 且已存在 → 412 Precondition Failed
  if (ifNoneMatch === '*' && existing) {
    return { status: 412, headers: { DAV: CALDAV_VERSION } };
  }

  // If-Match: 检查 ETag
  if (ifMatch && existing) {
    const ics = await getEventIcs(eventId);
    const currentEtag = ics ? `"${hashString(ics)}"` : '';
    if (ifMatch !== currentEtag) {
      return { status: 412, headers: { DAV: CALDAV_VERSION } };
    }
  }

  try {
    const ev = await createOrUpdateEvent(eventId, body);
    const ics = await getEventIcs(eventId);
    const etag = ics ? `"${hashString(ics)}"` : '';
    const created = !existing;

    // 触发后台同步（可选：推送回其他已配置的 CalDAV 账户）
    try {
      const { syncAllAccounts } = await import('@/lib/calendar/sync-runner');
      void syncAllAccounts().catch(() => {});
    } catch {
      // 忽略
    }

    return {
      status: created ? 201 : 204,
      headers: {
        ETag: etag,
        'Content-Location': `${baseHref}/events/${eventId}.ics`,
        DAV: CALDAV_VERSION,
      },
    };
  } catch (e) {
    return badRequest(e instanceof Error && e.message ? e.message : 'Failed to create/update event');
  }
}

/** DELETE: 删除事件 */
async function handleDelete(pathSegments: string[]): Promise<DavResponse> {
  const pathType = classifyPath(pathSegments);
  if (pathType !== 'event') return notFound();

  const eventId = decodeURIComponent(pathSegments[pathSegments.length - 1].replace(/\.ics$/, ''));
  const existing = await getEventById(eventId);
  if (!existing) return notFound();

  await deleteEventById(eventId);

  // 触发后台同步
  try {
    const { syncAllAccounts } = await import('@/lib/calendar/sync-runner');
    void syncAllAccounts().catch(() => {});
  } catch {
    // 忽略
  }

  return noContent();
}

/** HEAD: 获取事件元数据（无 body） */
async function handleHead(pathSegments: string[], baseHref: string): Promise<DavResponse> {
  const pathType = classifyPath(pathSegments);

  if (pathType === 'root' || pathType === 'calendar' || pathType === 'events') {
    return okXml('<d:multistatus/>');
  }

  if (pathType === 'event') {
    const eventId = decodeURIComponent(pathSegments[pathSegments.length - 1].replace(/\.ics$/, ''));
    const ev = await getEventById(eventId);
    if (!ev) return notFound();
    const ics = await getEventIcs(eventId);
    const etag = ics ? `"${hashString(ics)}"` : '';
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset="utf-8"',
        ETag: etag,
        'Last-Modified': ev.updated_at || new Date().toUTCString(),
        DAV: CALDAV_VERSION,
      },
    };
  }

  return notFound();
}

/** REPORT: 处理 calendar-multiget 和 calendar-query */
async function handleReport(pathSegments: string[], baseHref: string, body?: string): Promise<DavResponse> {
  const pathType = classifyPath(pathSegments);
  const bodyLower = (body || '').toLowerCase();

  if (pathType === 'root' || pathType === 'calendar' || pathType === 'events') {
    // calendar-multiget: 获取指定 hrefs 的事件
    if (bodyLower.includes('calendar-multiget')) {
      const hrefs = extractHrefsFromReport(body || '');
      let responses = '';
      for (const href of hrefs) {
        const match = /events\/([^/]+)\.ics$/.exec(href);
        if (!match) continue;
        const eventId = decodeURIComponent(match[1]);
        const ev = await getEventById(eventId);
        if (!ev) {
          responses += `
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop/>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>`;
          continue;
        }
        const info = eventToFileInfo(ev, baseHref);
        responses += `
  <d:response>
    <d:href>${info.href}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"${info.etag}"</d:getetag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
      }
      return okXml(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${responses}
</d:multistatus>`);
    }

    // calendar-query: 时间范围查询
    if (bodyLower.includes('calendar-query')) {
      const range = extractTimeRangeFromReport(body || '');
      const allEvents = await listAllEvents();
      const filtered = allEvents.filter((ev) => {
        if (range.start) {
          const evStart = new Date(ev.start_time).getTime();
          if (evStart > range.endTime) return false;
        }
        if (range.end) {
          const evEnd = ev.end_time ? new Date(ev.end_time).getTime() : new Date(ev.start_time).getTime();
          if (evEnd < range.startTime) return false;
        }
        return true;
      });

      let responses = '';
      for (const ev of filtered) {
        const info = eventToFileInfo(ev, baseHref);
        responses += `
  <d:response>
    <d:href>${info.href}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${info.displayName}</d:displayname>
        <d:getetag>"${info.etag}"</d:getetag>
        <d:getlastmodified>${info.lastModified}</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
      }
      return okXml(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${responses}
</d:multistatus>`);
    }

    // 通用 REPORT：回退到 PROPFIND 逻辑
    return handlePropfind(pathSegments, baseHref, body);
  }

  return notFound();
}

/** 解析 REPORT 请求中的 href 列表 */
function extractHrefsFromReport(body: string): string[] {
  const hrefs: string[] = [];
  const regex = /<d:href>([^<]+)<\/d:href>/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    hrefs.push(match[1]);
  }
  return hrefs;
}

/** 解析 REPORT 请求中的时间范围 */
function extractTimeRangeFromReport(body: string): { start?: string; end?: string; startTime: number; endTime: number } {
  let startTime = 0;
  let endTime = Date.now() + 365 * 86400 * 1000;
  const rangeTag = /<cal:time-range-start[^>]*>([^<]+)<\/cal:time-range-start>/.exec(body);
  if (rangeTag) startTime = new Date(rangeTag[1]).getTime();
  const endTag = /<cal:time-range-end[^>]*>([^<]+)<\/cal:time-range-end>/.exec(body);
  if (endTag) endTime = new Date(endTag[1]).getTime();
  return { start: rangeTag?.[1], end: endTag?.[1], startTime, endTime };
}

/** 路径分类 */
function classifyPath(pathSegments: string[]): 'root' | 'calendar' | 'events' | 'event' | 'unknown' {
  if (pathSegments.length === 0) return 'root';
  if (pathSegments.length === 1 && pathSegments[0] === 'calendar') return 'calendar';
  if (pathSegments.length === 1 && pathSegments[0] === 'events') return 'events';
  if (pathSegments.length === 2 && pathSegments[0] === 'events' && pathSegments[1].endsWith('.ics')) return 'event';
  if (pathSegments.length === 2 && pathSegments[0] === 'calendar') return 'calendar';
  return 'unknown';
}
