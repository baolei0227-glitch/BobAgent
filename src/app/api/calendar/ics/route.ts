import { NextRequest, NextResponse } from 'next/server';
import {
  getCalendarDb,
  createEvent,
  updateEvent,
  findEventByExternalId,
  type CreateEventData,
} from '@/lib/db';
import { getCurrentProject } from '@/lib/project/project-manager';
import { parseIcs, buildIcs } from '@/lib/calendar/ical';
import { scanDueEventReminders } from '@/lib/wanted/event-reminder';

/** 无当前项目时的占位 project_id（日历与项目独立） */
const GLOBAL_PROJECT_ID = '__global__';

async function getDb() {
  return await getCalendarDb();
}

/** 取当前项目 id 作为事件归属（纯展示归属）；无项目时用占位 */
async function safeProjectId(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return project.id;
  } catch {
    return GLOBAL_PROJECT_ID;
  }
}

/** POST /api/calendar/ics/import  body: { file: string(ics文本) } */
export async function POST(req: NextRequest) {
  try {
    const db = await getDb();
    const projectId = await safeProjectId();
    const body = await req.json().catch(() => ({}));
    const text: string = body?.file ?? body?.ics ?? '';
    if (!text.trim()) {
      return NextResponse.json({ ok: false, error: 'Empty .ics content' }, { status: 400 });
    }

    const parsed = parseIcs(text);
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const ev of parsed) {
      const existing = ev.external_id
        ? await findEventByExternalId(db, null, ev.external_id)
        : null;
      if (existing) {
        // 已存在：仅当外部状态有效且本地未完成时更新（保留本地 done/cancelled 状态语义）
        if (existing.status === 'done') {
          skipped++;
          continue;
        }
        await updateEvent(db, existing.event_id, {
          title: ev.title,
          description: ev.description,
          location: ev.location,
          start_time: ev.start_time,
          end_time: ev.end_time,
          all_day: ev.all_day,
          status: ev.status,
          priority: ev.priority,
          color: ev.color,
          tags: ev.tags,
          sync_provider: 'ics',
        });
        updated++;
      } else {
        const data: CreateEventData = {
          project_id: projectId,
          title: ev.title,
          description: ev.description,
          location: ev.location,
          start_time: ev.start_time,
          end_time: ev.end_time,
          all_day: ev.all_day,
          status: ev.status,
          priority: ev.priority,
          color: ev.color,
          tags: ev.tags,
          external_id: ev.external_id || undefined,
          sync_provider: 'ics',
        };
        await createEvent(db, data);
        created++;
      }
    }

    // ICS 导入可能新增/更新到期事件，触发一次到期提醒扫描
    if (created + updated > 0) {
      void scanDueEventReminders().catch((e) => {
        console.error('[calendar/ics] 导入后触发提醒扫描失败:', e);
      });
    }
    return NextResponse.json({ ok: true, created, updated, skipped, total: parsed.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'Import failed' }, { status: 500 });
  }
}

/** GET /api/calendar/ics/export?range_start=&range_end=  → 返回 .ics 文件流 */
export async function GET(req: NextRequest) {
  try {
    const db = await getDb();
    const projectId = await safeProjectId();
    const { listEventsInRange } = await import('@/lib/db');
    const searchParams = req.nextUrl.searchParams;
    const rangeStart = searchParams.get('range_start') || new Date(Date.now() - 365 * 86400 * 1000).toISOString();
    const rangeEnd = searchParams.get('range_end') || new Date(Date.now() + 365 * 86400 * 1000).toISOString();

    const rows = await listEventsInRange(db, null, rangeStart, rangeEnd);
    const ics = buildIcs(
      rows.map((r) => ({
        // UID 必须稳定：外部导入事件沿用原 external_id；本地事件用数据库主键 event_id 兜底，
        // 与订阅 feed 保持同一规则，避免 Date.now() 每次导出都变导致重复
        external_id: r.external_id || r.event_id,
        title: r.title,
        description: r.description,
        location: r.location,
        start_time: r.start_time,
        end_time: r.end_time,
        all_day: r.all_day === 1,
        status: r.status,
        priority: r.priority,
        tags: (() => { try { return JSON.parse(r.tags_json || '[]'); } catch { return []; } })(),
      })),
    );

    return new Response(ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="bobwork-${projectId}-events.ics"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'Export failed' }, { status: 500 });
  }
}