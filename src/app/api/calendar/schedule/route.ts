import { NextRequest, NextResponse } from 'next/server';
import { getCalendarDb } from '@/lib/db';
import { runScheduler, listUnscheduledTasks, queryScheduleStatus } from '@/lib/calendar/scheduler';

/**
 * GET  /api/calendar/schedule        → 排程状态（meta + 未排程任务列表）
 * POST /api/calendar/schedule        → 运行排程器并落库（body: { horizon_days?, dry_run? }）
 */

export async function GET() {
  try {
    const db = await getCalendarDb();
    const tasks = await listUnscheduledTasks(db);
    const status = await queryScheduleStatus();
    return NextResponse.json({
      success: true,
      meta: {
        status: status.status,
        version: status.version,
        dirty_at: status.dirty_at,
        last_planned_at: status.last_planned_at,
      },
      counts: {
        scheduled: status.scheduled_count,
        stale: status.stale_count,
        unscheduled: tasks.length,
      },
      unscheduled: tasks.map((t) => ({
        event_id: t.event_id,
        title: t.title,
        due_at: t.due_at,
        estimated_minutes: t.estimated_minutes,
        priority: t.priority,
        schedule_status: t.schedule_status,
      })),
    });
  } catch (e) {
    console.error('calendar schedule GET error:', e);
    return NextResponse.json(
      { success: false, error: e instanceof Error && e.message ? e.message : 'Query failed' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body: Record<string, unknown> = await req.json().catch(() => ({}));
    const horizonDays =
      typeof body.horizon_days === 'number' && body.horizon_days > 0
        ? Math.min(Math.round(body.horizon_days), 120)
        : undefined;
    const dryRun = body.dry_run === true;

    const result = await runScheduler({ horizonDays, dryRun });
    return NextResponse.json({ success: true, dry_run: dryRun, ...result });
  } catch (e) {
    console.error('calendar schedule POST error:', e);
    return NextResponse.json(
      { success: false, error: e instanceof Error && e.message ? e.message : 'Schedule failed' },
      { status: 500 },
    );
  }
}
