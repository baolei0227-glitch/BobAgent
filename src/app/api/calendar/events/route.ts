import { NextRequest, NextResponse } from 'next/server';
import {
  getCalendarDb,
  createEvent,
  createEventsBulk,
  updateEvent,
  deleteEvent,
  getEvent,
  listEventsInRange,
  listEventsByStatus,
  listAllEvents,
  listCalendarAccounts,
  searchEvents,
  type EventRow,
  type CreateEventData,
  type UpdateEventData,
} from '@/lib/db';
import { getCurrentProject } from '@/lib/project/project-manager';
import { scanDueEventReminders } from '@/lib/wanted/event-reminder';
import { syncAllAccounts } from '@/lib/calendar/sync-runner';
import { deleteDavEvent } from '@/lib/calendar/sync';
import { decryptSecret } from '@/lib/secrets';
import { pushCalendarEventToSticky } from '@/lib/sticky-calendar-sync';

/** 无当前项目时的占位 project_id（日历与项目独立，事件仍可正常创建） */
const GLOBAL_PROJECT_ID = '__global__';

/** 获取全局日历数据库（与项目完全独立，事件存于 app root 的 .calendar.db） */
async function getDb() {
  return await getCalendarDb();
}

/** 取当前项目 id 作为事件归属（纯展示归属，日历数据不受项目删除/切换影响）；无项目时用占位 */
async function getCurrentProjectIdSafe(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return project.id;
  } catch {
    return GLOBAL_PROJECT_ID;
  }
}

/** 将 DB 行转为前端格式（tags_json / category_path_json 解析为数组，all_day 转 boolean） */
function rowToFrontend(row: EventRow) {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags_json || '[]');
    if (!Array.isArray(tags)) tags = [];
  } catch {
    tags = [];
  }
  let category_path: string[] = [];
  try {
    category_path = JSON.parse(row.category_path_json || '[]');
    if (!Array.isArray(category_path)) category_path = [];
  } catch {
    category_path = [];
  }
  let reminder_minutes: number[] = [];
  try {
    reminder_minutes = JSON.parse(row.reminder_minutes_json || '[]');
    if (!Array.isArray(reminder_minutes)) reminder_minutes = [];
  } catch {
    reminder_minutes = [];
  }
  // 'null' = 明确关闭提醒，与 '[]'（未配置 → 扫描时按默认 30 分钟）区分：
  // 前端据此回显「无提醒」，否则打开事件自动保存会把它悄悄改回 30 分钟
  const reminder_disabled = row.reminder_minutes_json === 'null';
  return {
    event_id: row.event_id,
    project_id: row.project_id,
    title: row.title,
    description: row.description,
    location: row.location,
    start_time: row.start_time,
    end_time: row.end_time,
    all_day: row.all_day === 1,
    status: row.status,
    priority: row.priority,
    color: row.color,
    tags,
    category_path,
    reminder_minutes,
    reminder_disabled,
    scope: row.scope,
    source_node_id: row.source_node_id,
    source_raw: row.source_raw,
    // 来源锚点：非空且 kind='sticky' = 由 StickyTodo 便签行入日历；null = 日历直接添加/外部同步
    source_ref: row.source_ref,
    external_id: row.external_id,
    sync_provider: row.sync_provider,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** GET: 查询事件（全局日历库，与项目完全独立）
 *  支持参数：
 *    - range_start, range_end: 按时间范围查询（ISO 字符串）
 *    - status: scheduled | done | cancelled
 *    - all: 任意非空值 = 返回所有事件（无状态过滤）
 *    - keyword: 按内容关键词搜索（title/description/location/tags），可与 range_start/range_end 组合
 *  注意：历史 scope 参数（project/global）不再影响结果——所有事件都在同一全局日历库中。
 */
export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const rangeStart = searchParams.get('range_start');
    const rangeEnd = searchParams.get('range_end');
    const status = searchParams.get('status');
    const all = searchParams.get('all');
    const keyword = searchParams.get('keyword');

    const db = await getDb();

    let rows: EventRow[];
    if (keyword && keyword.trim()) {
      const k = keyword.trim();
      if (rangeStart && rangeEnd) {
        rows = await searchEvents(db, null, k, { rangeStart, rangeEnd, limit: 300, desc: false });
      } else {
        rows = await searchEvents(db, null, k, { limit: 300, desc: true });
      }
    } else if (all) {
      rows = await listAllEvents(db, null, 1000);
    } else if (status === 'scheduled' || status === 'done' || status === 'cancelled') {
      rows = await listEventsByStatus(db, null, status, 500);
    } else if (rangeStart && rangeEnd) {
      rows = await listEventsInRange(db, null, rangeStart, rangeEnd);
    } else {
      const now = new Date();
      const from = new Date(now.getTime() - 30 * 86400 * 1000).toISOString();
      const to = new Date(now.getTime() + 60 * 86400 * 1000).toISOString();
      rows = await listEventsInRange(db, null, from, to);
    }

    return NextResponse.json({
      success: true,
      events: rows.map(rowToFrontend),
    });
  } catch (e) {
    console.error('calendar GET error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error && e.message ? e.message : 'Query failed' }, { status: 500 });
  }
}

/** POST: 创建事件
 *  body: CreateEventData | CreateEventData[]（支持单个或批量）
 *  额外支持字段：bulk=true 时 body 必须为数组，使用事务批量写入
 *                scope=global 时 project_id 强制为 __global__（全局待办）
 */
export async function POST(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const isBulk = searchParams.get('bulk') === 'true';
    const db = await getDb();
    const projectId = await getCurrentProjectIdSafe();

    const raw = await req.json();

    /** 把请求体的 scope/category_path 映射为 CreateEventData 对应字段，并计算 project_id */
    function resolveItem(it: Partial<CreateEventData>): CreateEventData {
      const scope = it.scope === 'global' ? 'global' : 'project';
      const effectiveProjectId = scope === 'global' ? GLOBAL_PROJECT_ID : projectId;
      return {
        project_id: effectiveProjectId,
        title: String(it.title || '').trim(),
        description: it.description ?? undefined,
        location: it.location ?? undefined,
        start_time: it.start_time ?? null,
        end_time: it.end_time ?? undefined,
        all_day: it.all_day ?? false,
        status: it.status ?? 'scheduled',
        priority: it.priority ?? 'normal',
        color: it.color ?? undefined,
        tags: it.tags ?? [],
        category_path: Array.isArray(it.category_path) ? it.category_path : undefined,
        scope,
        source_node_id: it.source_node_id ?? undefined,
        source_raw: it.source_raw ?? undefined,
        reminder_minutes: Array.isArray(it.reminder_minutes) ? it.reminder_minutes : undefined,
        external_id: it.external_id ?? undefined,
        external_url: it.external_url ?? undefined,
        sync_provider: it.sync_provider ?? undefined,
        sync_etag: it.sync_etag ?? undefined,
      };
    }

    if (isBulk) {
      if (!Array.isArray(raw)) {
        return NextResponse.json({ success: false, error: 'bulk 模式下 body 必须为数组' }, { status: 400 });
      }
      let items: CreateEventData[] = raw.map(resolveItem);
      for (const it of items) {
        if (!it.title) return NextResponse.json({ success: false, error: '事件标题不能为空' }, { status: 400 });
        // start_time 可空（null = 无时间清单项）
      }
      // 防重（杜绝 /todo 重复提交产生海量重复记录）：
      //   1. 批量内去重：同一请求中相同 (title, start_time, scope) 只保留第一条
      //   2. 库内查重：已存在相同 (title, start_time, scope) 的 scheduled 事件则跳过，
      //      避免"同一任务反复提交/双发"时每次写入全新 event_id 造成重复
      {
        const seenKey = new Set<string>();
        const batchDeduped: CreateEventData[] = [];
        for (const it of items) {
          const key = `${it.title}|${it.start_time ?? ''}|${it.scope}`;
          if (seenKey.has(key)) continue;
          seenKey.add(key);
          batchDeduped.push(it);
        }
        items = batchDeduped;

        const projectIds = [...new Set(items.map((it) => it.project_id))];
        const placeholders = projectIds.map(() => '?').join(',');
        const existingRows = db.prepare(`
          SELECT event_id, title, start_time, scope FROM events
          WHERE project_id IN (${placeholders})
            AND status = 'scheduled'
        `).all(...projectIds) as { event_id: string; title: string; start_time: string | null; scope: string }[];
        const existingKey = new Set(existingRows.map((r) => `${r.title}|${r.start_time ?? ''}|${r.scope}`));
        items = items.filter((it) => !existingKey.has(`${it.title}|${it.start_time ?? ''}|${it.scope}`));
      }
      const ids = await createEventsBulk(db, items);
      // 即改即推：写库后立即同步到远端日历，无需等待后台 5 分钟轮询
      void syncAllAccounts().catch((e) =>
        console.error('[calendar/events] POST bulk immediate sync failed:', e),
      );
      // 新建事件可能已到期（如 /todo 录入的待办 start_time 已过），触发一次到期提醒扫描。
      // /todo 创建时已通过 seen 反馈确认，传递 skip_reminder=true 避免双重通知。
      if (ids.length > 0 && searchParams.get('skip_reminder') !== 'true') {
        void scanDueEventReminders().catch((e) => {
          console.error('[calendar/events] 批量创建后触发提醒扫描失败:', e);
        });
      }
      return NextResponse.json({ success: true, event_ids: ids, count: ids.length });
    }

    // 单条创建
    const data: CreateEventData = resolveItem(raw);
    if (!data.title) return NextResponse.json({ success: false, error: '事件标题不能为空' }, { status: 400 });

    // 防重（与 bulk 路径一致）：同 (project_id, title, start_time, scope) 且 status='scheduled' 的事件已存在 → 复用，不新建
    const dedupeKey = `${data.title}|${data.start_time ?? ''}|${data.scope}`;
    const existingDup = db.prepare(`
      SELECT event_id FROM events
      WHERE project_id = ?
        AND status = 'scheduled'
        AND (title || '|' || COALESCE(start_time, '') || '|' || scope) = ?
      LIMIT 1
    `).get(data.project_id, dedupeKey) as { event_id: string } | undefined;
    if (existingDup) {
      const reused = await getEvent(db, existingDup.event_id);
      return NextResponse.json({
        success: true,
        event: reused ? rowToFrontend(reused) : null,
        reused: true,
      });
    }

    const id = await createEvent(db, data);
    const created = await getEvent(db, id);
    // 即改即推：写库后立即同步到远端日历，无需等待后台 5 分钟轮询
    void syncAllAccounts().catch((e) =>
      console.error('[calendar/events] POST immediate sync failed:', e),
    );
    // 新建事件可能已到期，触发一次到期提醒扫描（与批量路径一致）
    // /todo 创建时已通过 seen 反馈确认，传递 skip_reminder=true 避免双重通知
    if (searchParams.get('skip_reminder') !== 'true') {
      void scanDueEventReminders().catch((e) => {
        console.error('[calendar/events] 创建后触发提醒扫描失败:', e);
      });
    }
    return NextResponse.json({
      success: true,
      event: created ? rowToFrontend(created) : null,
    });
  } catch (e) {
    console.error('calendar POST error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error && e.message ? e.message : 'Create failed' }, { status: 500 });
  }
}

/** PATCH: 更新事件
 *  query: event_id
 *  body: UpdateEventData（支持 category_path / scope 新字段）
 */
export async function PATCH(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const eventId = searchParams.get('event_id');
    if (!eventId) {
      return NextResponse.json({ success: false, error: '缺少 event_id 参数' }, { status: 400 });
    }
    const db = await getDb();
    const existing = await getEvent(db, eventId);
    if (!existing) {
      return NextResponse.json({ success: false, error: '事件不存在' }, { status: 404 });
    }
    const raw: Record<string, unknown> = await req.json();
    const updateData: UpdateEventData = {};
    const writable = updateData as Record<string, unknown>;
    for (const k of ['title', 'description', 'location', 'start_time', 'end_time',
      'all_day', 'status', 'priority', 'color', 'tags', 'category_path', 'scope',
      'source_node_id', 'source_raw', 'reminder_minutes']) {
      if (raw[k] !== undefined) writable[k] = raw[k];
    }
    if (updateData.title !== undefined) updateData.title = String(updateData.title).trim();
    if (updateData.tags && !Array.isArray(updateData.tags)) {
      return NextResponse.json({ success: false, error: 'tags 必须是数组' }, { status: 400 });
    }
    if (updateData.category_path && !Array.isArray(updateData.category_path)) {
      return NextResponse.json({ success: false, error: 'category_path 必须是数组' }, { status: 400 });
    }
    await updateEvent(db, eventId, updateData);
    const updated = await getEvent(db, eventId);

    // 反向联动：源自在项目便签行的待办事件被改（标题/勾选/取消）→ 落回对应便签行。
    // 内部会比较行状态，无实际变化时跳过写盘（幂等，避免自身前向同步引发回写抖动）。
    if (updated?.source_ref) {
      await pushCalendarEventToSticky(updated).catch((e) =>
        console.error('[calendar/events] PATCH 反向落回便签失败:', e),
      );
    }

    // 即改即推：状态/内容变更后立即同步到远端日历
    void syncAllAccounts().catch((e) =>
      console.error('[calendar/events] PATCH immediate sync failed:', e),
    );

    // 状态变更后主动触发一次到期提醒扫描（事件驱动，替代纯定时轮询的延迟）：
    //   - scheduled → done/cancelled：事件不再纳入提醒，无需扫描（同步减少无意义竞态写入）
    //   - 恢复 scheduled：若该事件已到期且未提醒，立即生成提醒写入待发布队列
    // 异步执行不阻塞响应；失败仅记日志，不影响状态更新本身
    const statusBefore = existing.status;
    const statusAfter = updateData.status;
    const isRestoreToScheduled =
      statusAfter === 'scheduled' && statusBefore !== 'scheduled';
    if (isRestoreToScheduled) {
      void scanDueEventReminders().catch((e) => {
        console.error('[calendar/events] 状态变更触发提醒扫描失败:', e);
      });
    }

    return NextResponse.json({
      success: true,
      event: updated ? rowToFrontend(updated) : null,
    });
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : 'Update failed';
    if (msg === 'NO_PROJECT') {
      return NextResponse.json({ success: false, error: '请先创建项目' }, { status: 400 });
    }
    console.error('calendar PATCH error:', e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/** DELETE: 删除事件
 *  query: event_id（单条删除）或 range_start + range_end（按日期范围批量软删除）
 *        hard=1（单条彻底删除：物理删行 + 推送远端删除）
 *  支持 scope=all 删除全局无时间清单项
 */

/** 彻底删除后的远端清理：对所有启用的双向 CalDAV 账户按 href 推送删除（带 etag If-Match 防误删）。
 *  事件行已删、本地订阅 feed 自动不再包含该 UID；此处负责把删除同步到外部同步账户。 */
async function pushHardDeleteToRemote(href: string, etag?: string | null): Promise<void> {
  try {
    const db = await getDb();
    const accounts = await listCalendarAccounts(db, null);
    for (const acc of accounts) {
      if (acc.enabled !== 1 || acc.read_only || acc.provider !== 'caldav') continue;
      if (!acc.calendar_url || !acc.username || !acc.password_enc) continue;
      const password = decryptSecret(acc.password_enc);
      if (!password) continue;
      // external_url 可能是相对路径（如 xxx.ics），规范化为该账户下的完整 URL 再删
      const fullHref = href.startsWith('http')
        ? href
        : acc.calendar_url.replace(/\/$/, '') + '/' + href.replace(/^\//, '');
      try {
        await deleteDavEvent(acc.calendar_url, acc.username, password, fullHref, etag);
      } catch (e) {
        console.warn(
          `[calendar] 远端删除推送失败 (${acc.name || acc.account_id}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch (e) {
    console.warn('[calendar] pushHardDeleteToRemote 失败:', e instanceof Error ? e.message : String(e));
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const eventId = searchParams.get('event_id');
    const rangeStart = searchParams.get('range_start');
    const rangeEnd = searchParams.get('range_end');
    const hard = searchParams.get('hard') === '1';

    const db = await getDb();

    // 批量按日期范围删除（全局日历库，不按项目过滤）
    if (rangeStart && rangeEnd) {
      const conds: string[] = [];
      const params: string[] = [];

      // 匹配与日期范围有交集的事件：
      // start_time 在范围内，或 end_time 在范围内，或事件跨越该范围
      conds.push(`start_time IS NOT NULL`);
      conds.push(`status = 'scheduled'`);
      conds.push(`datetime(start_time) < datetime(?)`);
      params.push(rangeEnd);
      conds.push(`(end_time IS NULL OR datetime(end_time) > datetime(?))`);
      params.push(rangeStart);

      const rows = db.prepare(`
        SELECT * FROM events
        WHERE ${conds.join(' AND ')}
      `).all(...params) as EventRow[];

      if (rows.length === 0) {
        return NextResponse.json({ success: true, deleted: 0, soft: true });
      }

      const eventIds = rows.map((r) => r.event_id);
      for (const row of rows) {
        // 源自便签待办的事件：日历删除 → 反向移除对应便签行（双向联动）
        if (row.source_ref) {
          await pushCalendarEventToSticky(row, { removeLine: true }).catch((e) =>
            console.error('[calendar/events] DELETE range 反向移除便签行失败:', e),
          );
        }
        await updateEvent(db, row.event_id, { status: 'cancelled' });
      }

      void syncAllAccounts().catch((e) =>
        console.error('[calendar/events] DELETE range immediate sync failed:', e),
      );

      return NextResponse.json({ success: true, deleted: eventIds.length, soft: true, event_ids: eventIds });
    }

    if (!eventId) {
      return NextResponse.json({ success: false, error: '缺少 event_id 或 range_start/range_end 参数' }, { status: 400 });
    }
    const existing = await getEvent(db, eventId);
    if (!existing) {
      return NextResponse.json({ success: false, error: '事件不存在' }, { status: 404 });
    }

    // 彻底删除：物理删行 + 推送远端删除（若事件已绑定 CalDAV 同步）。
    // 订阅 feed 随之不再包含该 UID（Apple 订阅日历刷新后移除事件）；CalDAV 账户由下面 DELETE 同步。
    if (hard) {
      const href = existing.external_url || null;
      const etag = existing.sync_etag || null;
      // 源自便签待办的事件：删除 → 反向移除对应便签行（双向联动）
      if (existing.source_ref) {
        await pushCalendarEventToSticky(existing, { removeLine: true }).catch((e) =>
          console.error('[calendar/events] DELETE hard 反向移除便签行失败:', e),
        );
      }
      await deleteEvent(db, eventId);
      if (href) await pushHardDeleteToRemote(href, etag);
      return NextResponse.json({ success: true, deleted: true, hard: true });
    }

    // 软删除：标记 cancelled（推送 STATUS:CANCELLED 到远端日历，Mac 显示为已取消；
    // 拉取时 cancelled 事件保留本地状态，不会被远端 CONFIRMED 复活）
    await updateEvent(db, eventId, { status: 'cancelled' });

    // 反向联动：源自便签待办的事件被删（status=cancelled 视同删除）→ 移除对应便签行
    if (existing.source_ref) {
      await pushCalendarEventToSticky(existing, { removeLine: true }).catch((e) =>
        console.error('[calendar/events] DELETE 反向移除便签行失败:', e),
      );
    }

    // 即改即推：删除（取消）后立即同步到远端日历（推送 STATUS:CANCELLED）
    void syncAllAccounts().catch((e) =>
      console.error('[calendar/events] DELETE immediate sync failed:', e),
    );

    return NextResponse.json({ success: true, deleted: true, soft: true });
  } catch (e) {
    console.error('calendar DELETE error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error && e.message ? e.message : 'Delete failed' }, { status: 500 });
  }
}
