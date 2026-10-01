/**
 * /api/butler/daily-report
 *
 * 每日任务（2026-09-27 起日报三页签已移交 Today 面板承载，这里只剩两类每日任务）：
 *   - POST { type: 'progress' | 'notes' } — 手动触发 / 每日 9:00 调度器调用
 *     （当天已做过则返回 sent:false 跳过；progress 生成 Today 的 Report 页签缓存，不产生任何通知；
 *      notes 触发知识库每日维护，仍推送到 Bobby 的通知中心）
 *   - GET — 前端轮询拉取"待发布到通知中心"的回执（拉取后清空队列）
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  generateProgressDigest,
  sendNotesMaintenance,
  takePendingReports,
  type DailyReportType,
} from '@/lib/core/daily-report';

export async function POST(request: NextRequest) {
  try {
    const { type } = (await request.json()) as { type?: DailyReportType };
    const result =
      type === 'progress' ? await generateProgressDigest() : type === 'notes' ? await sendNotesMaintenance() : null;
    if (!result) {
      return NextResponse.json({ success: false, error: 'type must be progress or notes' }, { status: 400 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/daily-report] 执行失败:', msg);
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
