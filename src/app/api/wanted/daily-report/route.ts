/**
 * /api/wanted/daily-report
 *
 * 每日自动报告（Morning + Sticky + Notes 维护）：
 *   - POST { type: 'morning' | 'sticky' | 'notes' } — 手动触发 / 每日 9:00 调度器调用
 *     （当天已发过则返回 sent:false 跳过；sticky 仅发 BobMail；notes 触发知识库每日维护）
 *   - GET — 前端轮询拉取"待发布到通知中心"的报告（拉取后清空队列）
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  sendDailyReport,
  sendStickyReport,
  sendNotesMaintenance,
  takePendingReports,
  type DailyReportType,
} from '@/lib/wanted/daily-report';

export async function POST(request: NextRequest) {
  try {
    const { type } = (await request.json()) as { type?: DailyReportType };
    const base = new URL(request.url).origin;
    const result =
      type === 'sticky'
        ? await sendStickyReport(base)
        : type === 'morning'
          ? await sendDailyReport(type, base)
          : type === 'notes'
            ? await sendNotesMaintenance()
            : null;
    if (!result) {
      return NextResponse.json({ success: false, error: 'type must be morning, sticky or notes' }, { status: 400 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/daily-report] 发送失败:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function GET() {
  try {
    const reports = await takePendingReports();
    return NextResponse.json({ success: true, reports });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
