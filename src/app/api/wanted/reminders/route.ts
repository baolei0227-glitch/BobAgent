/**
 * /api/wanted/reminders
 *
 * 日历到期提醒（kind='calendar'）待发布队列：
 *   - GET — 前端轮询拉取"待发布到通知中心"的到期提醒（拉取后清空队列）
 *   - POST { action: 'scan' } — 手动触发一次扫描（调试/测试用）
 */
import { NextRequest, NextResponse } from 'next/server';
import { takePendingReminders, scanDueEventReminders } from '@/lib/wanted/event-reminder';

export async function GET() {
  try {
    const reminders = await takePendingReminders();
    return NextResponse.json({ success: true, reminders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/reminders] 拉取失败:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { action } = (await request.json()) as { action?: string };
    if (action === 'scan') {
      const count = await scanDueEventReminders();
      return NextResponse.json({ success: true, scanned: count });
    }
    return NextResponse.json({ success: false, error: 'action must be scan' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/reminders] 扫描失败:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}