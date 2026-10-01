/**
 * GET /api/butler/today — Butler Today 页数据源（只读聚合）
 *
 * 汇总「今天日程 + 逾期待办 + 未读回执 + 一条建议卡」，由 lib/butler/today.ts 统一产出。
 *
 * 2026-09-27 起还承载**整份日报的三个页签**（Report / Schedule / Sticky）——日报不再由
 * 通知助理 Bobby 推送，改为 Today 面板按需读取：
 *   - schedule：由 Today 快照直接派生（纯函数，与「今天 / 逾期」两块同源）
 *   - sticky：全项目未完成便签待办，每次请求实算
 *   - progress：各项目昨日进展摘要，读每日生成一次的缓存（未生成时为 null）
 *
 * 只读：不写日历、不写收件箱、不标记已读。
 *
 * `?status=1` 是给左栏 Today 键**红点**用的轻量分支：只回答「当日 Report 摘要是否已生成」，
 * 不建快照（要查日历、算 sticky）—— 红点轮询必须便宜；「看过没有」由客户端记。
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildTodaySnapshot, buildSuggestion } from '@/lib/butler/today';
import { buildScheduleSection, buildStickySection, readProgressDigest, readProgressDigestDate } from '@/lib/core/daily-report';

export async function GET(request: NextRequest) {
  try {
    // 红点探针：只 stat 当日摘要缓存文件，毫秒级返回
    if (request.nextUrl.searchParams.get('status') === '1') {
      const digestDate = await readProgressDigestDate();
      return NextResponse.json({ success: true, digestDate });
    }
    // querySchedule 内部需拼绝对 URL（与 executor 一致），用请求 origin 兜底
    const origin = request.nextUrl.origin;
    const snapshot = await buildTodaySnapshot(origin);
    // sticky 段构建失败不拖垮整个 Today：该页签退回空，其余照常（失败已记日志）
    const [sticky, progress] = await Promise.all([
      buildStickySection().catch((e: unknown) => {
        console.error('[core/today] sticky 段构建失败:', e);
        return null;
      }),
      readProgressDigest().catch(() => null),
    ]);
    return NextResponse.json({
      success: true,
      snapshot,
      suggestion: buildSuggestion(snapshot),
      reports: {
        progress,
        schedule: buildScheduleSection(snapshot),
        sticky,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/today] 聚合失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}