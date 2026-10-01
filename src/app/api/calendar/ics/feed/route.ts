import { NextRequest } from 'next/server';
import { getCalendarDb, projectIdByFeedToken, listEventsInRange } from '@/lib/db';
import { buildIcs } from '@/lib/calendar/ical';

/**
 * GET /api/calendar/ics/feed?token=xxx
 *
 * Apple 日历「新建日历订阅」端点。带 token 鉴权（无登录态，Apple 日历直接拉取）。
 * 返回该订阅的 .ics 流，Apple 日历定期自动刷新。
 * 注：日历数据已全局化（.calendar.db），token 也存于全局库。
 */
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token') || '';
    if (!token) {
      return new Response('Missing token', { status: 400, headers: { 'Content-Type': 'text/plain' } });
    }

    const db = await getCalendarDb();
    const pid = await projectIdByFeedToken(db, token);
    if (!pid) {
      return new Response('Invalid token', { status: 401, headers: { 'Content-Type': 'text/plain' } });
    }

    const rangeStart = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
    const rangeEnd = new Date(Date.now() + 365 * 86400 * 1000).toISOString();
    const rows = await listEventsInRange(db, null, rangeStart, rangeEnd);
    // 记录集（kind='log'）不对外投影
    const visible = rows.filter((r) => (r.kind ?? 'event') !== 'log');

    const ics = buildIcs(
      visible.map((r) => ({
        // UID 必须稳定：外部导入事件沿用原 external_id；本地事件用数据库主键 event_id 兜底，
        // 禁止 Date.now() 之类每次请求都变化的兜底（否则 Apple 日历把同一事件当成全新事件反复追加/不更新）
        external_id: r.external_id || r.event_id,
        title: r.title,
        description: r.description,
        location: r.location,
        start_time: r.start_time,
        end_time: r.end_time,
        all_day: r.all_day === 1,
        // Apple 日历订阅只认 STATUS:CONFIRMED/CANCELLED，没有 DONE 状态：
        // BobWork「已完成」的日程映射为 CANCELLED，订阅端显示为"已取消"（灰色划线）。
        // 仅影响订阅 feed；CalDAV 同步（dav-server.ts）与 BobWork 内部语义不变。
        status: r.status === 'done' ? 'cancelled' : r.status,
        priority: r.priority,
        tags: (() => { try { return JSON.parse(r.tags_json || '[]'); } catch { return []; } })(),
      })),
      { calendarName: 'BobWork' },
    );

    return new Response(ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'no-store, no-cache',
      },
    });
  } catch (e) {
    return new Response(`Feed error: ${e instanceof Error && e.message ? e.message : 'unknown'}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
}
