/**
 * /api/butler/daily-report
 *
 * 每日任务（2026-09-27 起日报三页签已移交 Today 面板承载，这里只剩两类每日任务）：
 *   - POST { type: 'progress' | 'notes' } — 手动触发 / 每日 9:00 调度器调用
 *     （当天已做过则返回 sent:false 跳过；progress 生成 Today 的 Report 页签缓存，不产生任何通知；
 *      notes 触发知识库每日维护，仍推送到 Bobby 的通知中心）
 *   - GET — 前端轮询拉取"待发布到通知中心"的回执（拉取后清空队列）
 *
 * ⚠️ B5 打扰闸（2026-10-02 接线）：GET 是**主动推送的出口**，故在此过闸。
 * 免打扰窗口内**不取走 pending**——报告留在队列、窗口结束后由下一轮轮询（30s）继续投递，
 * 与设置界面文案「held back and resume when it ends / the report is never lost」逐字一致。
 * 放行时按条计数（`recordPush`），让「单日上限」成为真上限。客户端**不再二次过闸**。
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  generateProgressDigest,
  sendNotesMaintenance,
  takePendingReports,
  type DailyReportType,
} from '@/lib/core/daily-report';
import { decidePush, recordPush } from '@/lib/core/quiet-hours';

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
    const decision = await decidePush('report');
    if (!decision.allow) {
      // 暂缓：**不动队列**，报告既没丢也没落库，窗口结束后自然续发
      return NextResponse.json({
        success: true,
        reports: [],
        held: true,
        reason: decision.reason,
        resumeAt: decision.resumeAt ?? null,
      });
    }
    const reports = await takePendingReports();
    for (let i = 0; i < reports.length; i++) await recordPush();
    return NextResponse.json({ success: true, reports });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
