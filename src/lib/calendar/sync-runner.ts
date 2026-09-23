import {
  getCalendarDb,
  listCalendarAccounts,
  getCalendarAccount,
  updateCalendarAccount,
  createEvent,
  updateEvent,
  deleteEvent as dbDeleteEvent,
  findEventByExternalId,
  findEventByExternalUrl,
  addSyncLog,
  type EventRow,
} from '@/lib/db';
import { decryptSecret } from '@/lib/secrets';
import { parseIcs, buildIcs } from '@/lib/calendar/ical';
import { fetchCalendarEvents, pushEvent, fetchWebcal } from '@/lib/calendar/sync';
import { scanDueEventReminders } from '@/lib/wanted/event-reminder';

/** 全局日历同步互斥标记（跨模块/热重载保持单例） */
declare global {
  // eslint-disable-next-line no-var
  var __calendarSyncRunning__: boolean | undefined;
}

/** 尝试获取同步锁：已被占用（另一处同步进行中）返回 false */
function tryAcquireSyncLock(): boolean {
  if (globalThis.__calendarSyncRunning__) return false;
  globalThis.__calendarSyncRunning__ = true;
  return true;
}

/** 释放同步锁 */
function releaseSyncLock(): void {
  globalThis.__calendarSyncRunning__ = false;
}

/** 获取全局日历数据库（与项目完全独立；dbPath 参数仅为兼容旧签名，已不再使用） */
async function getDb(_dbPath?: string) {
  return await getCalendarDb();
}

/** 拉取单个 CalDAV 账户：把远端事件同步进本地 events 表 */
async function pullCalDav(accountId: string, projectId: string): Promise<{ added: number; updated: number; deleted: number }> {
  const db = await getDb();
  const account = await getCalendarAccount(db, accountId);
  if (!account || !account.calendar_url || !account.username || !account.password_enc) {
    return { added: 0, updated: 0, deleted: 0 };
  }
  const password = decryptSecret(account.password_enc);
  if (!password) {
    await addSyncLog(db, accountId, projectId, 'error', 'Failed to decrypt account password');
    return { added: 0, updated: 0, deleted: 0 };
  }

  const now = new Date();
  const rangeStart = new Date(now.getTime() - 365 * 86400 * 1000).toISOString();
  const rangeEnd = new Date(now.getTime() + 365 * 86400 * 1000).toISOString();

  let remote: { href: string; etag: string; ical: string }[];
  try {
    remote = await fetchCalendarEvents(account.calendar_url, account.username, password, rangeStart, rangeEnd);
  } catch (e) {
    await addSyncLog(db, accountId, projectId, 'error', `CalDAV pull failed: ${e instanceof Error ? e.message : String(e)}`);
    return { added: 0, updated: 0, deleted: 0 };
  }

  let added = 0;
  let updated = 0;
  const seen = new Set<string>();

  for (const ev of remote) {
    const parsed = parseIcs(ev.ical);
    for (const p of parsed) {
      seen.add(p.external_id);
      const existing = await findEventByExternalId(db, null, p.external_id);
      if (existing) {
        // etag 相同则跳过（未变更）
        if (existing.sync_etag && existing.sync_etag === ev.etag) continue;
        // Mac 端无法表达"完成/取消"（日程无 completed 状态）：本地已 done/cancelled 的日程保留本地状态，
        // 仅当远端明确 CANCELLED 时才允许改写（Mac 端删除/取消始终生效，防止复活）
        const finalStatus =
          (existing.status === 'done' || existing.status === 'cancelled') && p.status !== 'cancelled'
            ? existing.status
            : p.status;
        await updateEvent(db, existing.event_id, {
          title: p.title,
          description: p.description,
          location: p.location,
          start_time: p.start_time,
          end_time: p.end_time,
          all_day: p.all_day,
          status: finalStatus,
          priority: p.priority,
          color: p.color,
          tags: p.tags,
          external_url: ev.href,
          sync_provider: 'caldav',
          sync_etag: ev.etag,
        });
        updated++;
      } else {
        await createEvent(db, {
          project_id: projectId,
          title: p.title,
          description: p.description,
          location: p.location,
          start_time: p.start_time,
          end_time: p.end_time,
          all_day: p.all_day,
          status: p.status,
          priority: p.priority,
          color: p.color,
          tags: p.tags,
          external_id: p.external_id,
          external_url: ev.href,
          sync_provider: 'caldav',
          sync_etag: ev.etag,
        });
        added++;
      }
    }
  }

  // 本地 caldav 事件但远端已消失 → 删除（仅删除本账户来源的；日历已全局化，不按项目过滤）
  const rows = db.prepare(`SELECT * FROM events WHERE sync_provider = 'caldav'`).all() as EventRow[];
  let deleted = 0;
  for (const row of rows) {
    if (row.external_id && !seen.has(row.external_id)) {
      await dbDeleteEvent(db, row.event_id);
      deleted++;
    }
  }

  await updateCalendarAccount(db, accountId, { last_sync_at: new Date().toISOString() });
  await addSyncLog(db, accountId, projectId, 'info', `Pull done: +${added} / ~${updated} / -${deleted}`);
  return { added, updated, deleted };
}

/** 拉取单个 WebCal 账户：GET .ics 并同步进本地（单向只读） */
async function pullWebCal(accountId: string, projectId: string): Promise<{ added: number; updated: number; deleted: number }> {
  const db = await getDb();
  const account = await getCalendarAccount(db, accountId);
  if (!account || !account.server_url) return { added: 0, updated: 0, deleted: 0 };

  let text: string;
  try {
    text = await fetchWebcal(account.server_url);
  } catch (e) {
    await addSyncLog(db, accountId, projectId, 'error', `WebCal fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return { added: 0, updated: 0, deleted: 0 };
  }

  const parsed = parseIcs(text);
  let added = 0;
  let updated = 0;
  const seen = new Set<string>();

  for (const p of parsed) {
    seen.add(p.external_id);
    const existing = await findEventByExternalId(db, projectId, p.external_id);
    if (existing) {
      await updateEvent(db, existing.event_id, {
        title: p.title,
        description: p.description,
        location: p.location,
        start_time: p.start_time,
        end_time: p.end_time,
        all_day: p.all_day,
        status: p.status,
        priority: p.priority,
        color: p.color,
        tags: p.tags,
        external_url: account.server_url,
        sync_provider: 'webcal',
      });
      updated++;
    } else {
      await createEvent(db, {
        project_id: projectId,
        title: p.title,
        description: p.description,
        location: p.location,
        start_time: p.start_time,
        end_time: p.end_time,
        all_day: p.all_day,
        status: p.status,
        priority: p.priority,
        color: p.color,
        tags: p.tags,
        external_id: p.external_id,
        external_url: account.server_url,
        sync_provider: 'webcal',
      });
      added++;
    }
  }

  const rows = db.prepare(`SELECT * FROM events WHERE sync_provider = 'webcal'`).all() as EventRow[];
  let deleted = 0;
  for (const row of rows) {
    if (row.external_id && !seen.has(row.external_id)) {
      await dbDeleteEvent(db, row.event_id);
      deleted++;
    }
  }

  await updateCalendarAccount(db, accountId, { last_sync_at: new Date().toISOString() });
  await addSyncLog(db, accountId, projectId, 'info', `WebCal sync done: +${added} / ~${updated} / -${deleted}`);
  return { added, updated, deleted };
}

/** 推送本地未同步事件到 CalDAV（单向 write-back，仅 read_only=0 的账户） */
async function pushLocalToCalDav(accountId: string, projectId: string, syncBaseAt: string | null): Promise<number> {
  const db = await getDb();
  const account = await getCalendarAccount(db, accountId);
  if (!account || account.read_only || !account.calendar_url || !account.username || !account.password_enc) return 0;
  const password = decryptSecret(account.password_enc);
  if (!password) return 0;

  // 需要推送的本地事件：
  //  - scheduled：内容变更照常推送
  //  - done / cancelled：仅在本次同步基准之后新变更的（updated_at > syncBaseAt）推送 STATUS:CANCELLED，
  //    让 Mac 日历移除该日程（done 事件额外带 X-BOB-STATUS:DONE 供拉回识别）；
  //    已推送过的不重复推，避免每次同步重复 PUT 引发 etag 抖动循环
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE project_id = ?
      AND (sync_provider = 'caldav' OR (sync_provider IS NULL AND external_id IS NULL))
      AND (status NOT IN ('done', 'cancelled') OR updated_at > COALESCE(?, '1970-01-01T00:00:00.000Z'))
  `).all(projectId, syncBaseAt) as EventRow[];

  let pushed = 0;
  for (const row of rows) {
    const uid = row.external_id || `bob-${row.event_id}`;
    const ical = buildIcs([{
      external_id: uid,
      title: row.title,
      description: row.description,
      location: row.location,
      start_time: row.start_time,
      end_time: row.end_time,
      all_day: row.all_day === 1,
      status: row.status,
      priority: row.priority,
      tags: (() => { try { return JSON.parse(row.tags_json || '[]'); } catch { return []; } })(),
    }]);

    const existing = row.external_url ? await findEventByExternalUrl(db, null, row.external_url) : null;
    const etag = row.sync_etag;
    try {
      // 已绑定 url → 更新；否则新建
      const hrefPath = row.external_url || uid + '.ics';
      const ok = await pushEvent(account.calendar_url, account.username, password, hrefPath, ical, etag);
      if (!ok) {
        await addSyncLog(db, accountId, projectId, 'warn', `Push conflict (412) for "${row.title}", skipped`);
        continue;
      }
      await updateEvent(db, row.event_id, {
        external_id: uid,
        external_url: hrefPath,
        sync_provider: 'caldav',
      });
      pushed++;
    } catch (e) {
      await addSyncLog(db, accountId, projectId, 'error', `Push failed for "${row.title}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (pushed) await addSyncLog(db, accountId, projectId, 'info', `Push done: ${pushed} event(s)`);
  return pushed;
}

/** 同步单个账户（先拉取，再推送写回） */
export async function syncAccount(accountId: string, dbPath?: string): Promise<{ provider: string; added: number; updated: number; deleted: number; pushed: number }> {
  // 全局互斥：防止"事件变更后立即同步"与后台 5 分钟 worker 并发重复推送。
  // 并发窗口内后来的调用直接跳过本次，等下一轮轮询兜底。
  if (!tryAcquireSyncLock()) {
    return { provider: 'unknown', added: 0, updated: 0, deleted: 0, pushed: 0 };
  }
  try {
    const db = await getDb(dbPath);
    const account = await getCalendarAccount(db, accountId);
    if (!account) return { provider: 'unknown', added: 0, updated: 0, deleted: 0, pushed: 0 };
    const projectId = account.project_id;

    if (account.provider === 'webcal') {
      const r = await pullWebCal(accountId, projectId);
      return { provider: 'webcal', ...r, pushed: 0 };
    }
    const r = await pullCalDav(accountId, projectId);
    let pushed = 0;
    if (!account.read_only) {
      // 推送基准 = 本次同步开始前的 last_sync_at：cancelled 事件仅在此之后新取消的才推送
      const syncBaseAt = account.last_sync_at || null;
      pushed = await pushLocalToCalDav(accountId, projectId, syncBaseAt);
    }
    return { provider: 'caldav', ...r, pushed };
  } finally {
    releaseSyncLock();
  }
}

/** 同步所有启用的日历账户（全局日历库，与项目无关） */
export async function syncAllAccounts(): Promise<Array<{ account_id: string; name: string; result: { provider: string; added: number; updated: number; deleted: number; pushed: number } }>> {
  const db = await getDb();
  const accounts = await listCalendarAccounts(db, null);
  const out = [];
  for (const acc of accounts) {
    if (acc.enabled !== 1) continue;
    const result = await syncAccount(acc.account_id);
    out.push({ account_id: acc.account_id, name: acc.name, result });
  }
  // 外部同步可能改了事件状态（done/cancelled），触发一次到期提醒扫描
  if (out.length > 0) {
    void scanDueEventReminders().catch((e) => {
      console.error('[calendar-sync] 同步后触发提醒扫描失败:', e);
    });
  }
  return out;
}

/** 后台 worker：同步所有启用的日历账户（日历已全局化，不再按项目遍历） */
export async function syncAllProjects(): Promise<Array<{ projectId: string; name: string; accounts: number }>> {
  const db = await getDb();
  const accounts = await listCalendarAccounts(db, null);
  const out: Array<{ projectId: string; name: string; accounts: number }> = [];
  let done = 0;
  for (const acc of accounts) {
    if (acc.enabled !== 1) continue;
    try {
      await syncAccount(acc.account_id);
      done++;
    } catch (e) {
      console.error(`[calendar-sync] account=${acc.name} failed:`, e);
    }
  }
  if (done > 0) out.push({ projectId: 'global', name: 'Global Calendar', accounts: done });
  // 全量同步完成后触发一次到期提醒扫描（覆盖多项目状态变更）
  if (out.length > 0) {
    void scanDueEventReminders().catch((e) => {
      console.error('[calendar-sync] 全量同步后触发提醒扫描失败:', e);
    });
  }
  return out;
}