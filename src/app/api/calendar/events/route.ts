import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import {
  initDb,
  createEvent,
  createEventsBulk,
  updateEvent,
  deleteEvent,
  getEvent,
  listEventsInRange,
  listEventsByStatus,
  listAllEvents,
  type EventRow,
  type CreateEventData,
} from '@/lib/db';
import { getCurrentProject } from '@/lib/project/project-manager';

/** 获取当前项目的数据库实例 */
async function getDb() {
  const project = await getCurrentProject();
  const dbPath = join(project.path, 'project.db');
  return await initDb(dbPath);
}

async function getCurrentProjectId(): Promise<string> {
  const project = await getCurrentProject();
  return project.id;
}

/** 将 DB 行转为前端格式（tags_json 解析为数组，all_day 转 boolean） */
function rowToFrontend(row: EventRow) {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags_json || '[]');
    if (!Array.isArray(tags)) tags = [];
  } catch {
    tags = [];
  }
  return {
    event_id: row.event_id,
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
    source_node_id: row.source_node_id,
    source_raw: row.source_raw,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** GET: 查询事件
 *  支持参数：
 *    - range_start, range_end: 按时间范围查询（ISO 字符串）
 *    - status: scheduled | done | cancelled
 *    - all: 任意非空值 = 返回所有事件（无状态过滤）
 */
export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const rangeStart = searchParams.get('range_start');
    const rangeEnd = searchParams.get('range_end');
    const status = searchParams.get('status');
    const all = searchParams.get('all');

    const db = await getDb();
    const projectId = await getCurrentProjectId();

    let rows: EventRow[];
    if (all) {
      rows = await listAllEvents(db, projectId, 1000);
    } else if (status === 'scheduled' || status === 'done' || status === 'cancelled') {
      rows = await listEventsByStatus(db, projectId, status, 500);
    } else if (rangeStart && rangeEnd) {
      rows = await listEventsInRange(db, projectId, rangeStart, rangeEnd);
    } else {
      // 默认返回近 30 天 + 未来 60 天
      const now = new Date();
      const from = new Date(now.getTime() - 30 * 86400 * 1000).toISOString();
      const to = new Date(now.getTime() + 60 * 86400 * 1000).toISOString();
      rows = await listEventsInRange(db, projectId, from, to);
    }

    return NextResponse.json({
      success: true,
      events: rows.map(rowToFrontend),
    });
  } catch (e: any) {
    if (e?.message === 'NO_PROJECT') {
      return NextResponse.json({ success: false, error: '请先创建项目' }, { status: 400 });
    }
    console.error('calendar GET error:', e);
    return NextResponse.json({ success: false, error: e?.message || 'Query failed' }, { status: 500 });
  }
}

/** POST: 创建事件
 *  body: CreateEventData | CreateEventData[]（支持单个或批量）
 *  额外支持字段：bulk=true 时 body 必须为数组，使用事务批量写入
 */
export async function POST(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const isBulk = searchParams.get('bulk') === 'true';
    const db = await getDb();
    const projectId = await getCurrentProjectId();

    const raw = await req.json();

    if (isBulk) {
      if (!Array.isArray(raw)) {
        return NextResponse.json({ success: false, error: 'bulk 模式下 body 必须为数组' }, { status: 400 });
      }
      const items: CreateEventData[] = raw.map((it: any) => ({
        project_id: projectId,
        title: String(it.title || '').trim(),
        description: it.description ?? undefined,
        location: it.location ?? undefined,
        start_time: it.start_time,
        end_time: it.end_time ?? undefined,
        all_day: it.all_day ?? false,
        status: it.status ?? 'scheduled',
        priority: it.priority ?? 'normal',
        color: it.color ?? undefined,
        tags: it.tags ?? [],
        source_node_id: it.source_node_id ?? undefined,
        source_raw: it.source_raw ?? undefined,
      }));
      for (const it of items) {
        if (!it.title) return NextResponse.json({ success: false, error: '事件标题不能为空' }, { status: 400 });
        if (!it.start_time) return NextResponse.json({ success: false, error: '事件缺少 start_time' }, { status: 400 });
      }
      const ids = await createEventsBulk(db, items);
      return NextResponse.json({ success: true, event_ids: ids, count: ids.length });
    }

    // 单条创建
    const data: CreateEventData = {
      project_id: projectId,
      title: String(raw.title || '').trim(),
      description: raw.description ?? undefined,
      location: raw.location ?? undefined,
      start_time: raw.start_time,
      end_time: raw.end_time ?? undefined,
      all_day: raw.all_day ?? false,
      status: raw.status ?? 'scheduled',
      priority: raw.priority ?? 'normal',
      color: raw.color ?? undefined,
      tags: raw.tags ?? [],
      source_node_id: raw.source_node_id ?? undefined,
      source_raw: raw.source_raw ?? undefined,
    };
    if (!data.title) return NextResponse.json({ success: false, error: '事件标题不能为空' }, { status: 400 });
    if (!data.start_time) return NextResponse.json({ success: false, error: '事件缺少 start_time' }, { status: 400 });

    const id = await createEvent(db, data);
    const created = await getEvent(db, id);
    return NextResponse.json({
      success: true,
      event: created ? rowToFrontend(created) : null,
    });
  } catch (e: any) {
    if (e?.message === 'NO_PROJECT') {
      return NextResponse.json({ success: false, error: '请先创建项目' }, { status: 400 });
    }
    console.error('calendar POST error:', e);
    return NextResponse.json({ success: false, error: e?.message || 'Create failed' }, { status: 500 });
  }
}

/** PATCH: 更新事件
 *  query: event_id
 *  body: UpdateEventData
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
    const raw = await req.json();
    const updateData: any = {};
    for (const k of ['title', 'description', 'location', 'start_time', 'end_time',
      'all_day', 'status', 'priority', 'color', 'tags',
      'source_node_id', 'source_raw']) {
      if (raw[k] !== undefined) updateData[k] = raw[k];
    }
    if (updateData.title !== undefined) updateData.title = String(updateData.title).trim();
    if (updateData.tags && !Array.isArray(updateData.tags)) {
      return NextResponse.json({ success: false, error: 'tags 必须是数组' }, { status: 400 });
    }
    await updateEvent(db, eventId, updateData);
    const updated = await getEvent(db, eventId);
    return NextResponse.json({
      success: true,
      event: updated ? rowToFrontend(updated) : null,
    });
  } catch (e: any) {
    if (e?.message === 'NO_PROJECT') {
      return NextResponse.json({ success: false, error: '请先创建项目' }, { status: 400 });
    }
    console.error('calendar PATCH error:', e);
    return NextResponse.json({ success: false, error: e?.message || 'Update failed' }, { status: 500 });
  }
}

/** DELETE: 删除事件
 *  query: event_id
 */
export async function DELETE(req: NextRequest) {
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
    await deleteEvent(db, eventId);
    return NextResponse.json({ success: true, deleted: eventId });
  } catch (e: any) {
    if (e?.message === 'NO_PROJECT') {
      return NextResponse.json({ success: false, error: '请先创建项目' }, { status: 400 });
    }
    console.error('calendar DELETE error:', e);
    return NextResponse.json({ success: false, error: e?.message || 'Delete failed' }, { status: 500 });
  }
}
