/**
 * GET /api/butler/today — Butler Today 页数据源（只读聚合）
 *
 * 汇总「今天日程 + 逾期待办 + 未读回执」，由 lib/butler/today.ts 统一产出。
 * 另下发顶层的 `advice`（今日建议，2–3 条可点击项）—— 由 lib/butler/advice.ts 实时规则推导，
 * 与 `reports` 的三页签（内容型）性质不同，故平级而非嵌在 reports 下。
 *
 * 2026-09-27 起还承载**整份日报的三个页签**（Report / Schedule / Sticky）——日报不再由
 * 通知助理 Bobby 推送，改为 Today 面板按需读取：
 *   - schedule：由 Today 快照直接派生（纯函数，与「今天 / 逾期」两块同源）
 *   - sticky：全项目未完成便签待办，每次请求实算
 *   - progress：各项目昨日进展摘要，读每日生成一次的缓存（未生成时为 null）
 *
 * 2026-10-04 起建议卡带 **AI 判断**（见 lib/butler/advice-ai.ts）：本路由**只读缓存**（秒开），
 * 命中则用 AI 的 reason 覆盖规则文案；未命中返回规则文案并置 `adviceStale: true`，
 * 由前端后台打 POST /api/butler/advice/refresh 生成 —— 首屏绝不因等模型而卡住。
 *
 * 只读：不写日历、不写收件箱、不标记已读。
 *
 * `?status=1` 是给左栏 Today 键**红点**用的轻量分支：只回答「当日 Report 摘要是否已生成」，
 * 不建快照（要查日历、算 sticky）—— 红点轮询必须便宜；「看过没有」由客户端记。
 */
import { NextRequest, NextResponse } from 'next/server';
import { loadTodayBundle } from '@/lib/butler/today-advice';
import { readProgressDigestDate } from '@/lib/core/daily-tasks';
import { adviceCovered, applyAdviceReasons, readAdviceReasons } from '@/lib/butler/advice-ai';
import { readNewsConfig, readNewsBriefing } from '@/lib/news/store';

export async function GET(request: NextRequest) {
  try {
    // 红点探针：只 stat 当日摘要缓存文件，毫秒级返回
    if (request.nextUrl.searchParams.get('status') === '1') {
      const digestDate = await readProgressDigestDate();
      return NextResponse.json({ success: true, digestDate });
    }
    // querySchedule 内部需拼绝对 URL（与 executor 一致），用请求 origin 兜底
    const [bundle, newsConfig, newsBriefing] = await Promise.all([
      loadTodayBundle(request.nextUrl.origin),
      // 新闻：只读缓存（当日简报 + 主题配置），不触发采集 —— 采集 + 归纳走每日调度或显式 refresh
      readNewsConfig().catch(() => null),
      readNewsBriefing().catch(() => null),
    ]);
    // AI reason 只读缓存：命中就覆盖，未命中保留规则文案并让前端后台补算
    const reasons = await readAdviceReasons(bundle.cards);

    return NextResponse.json({
      success: true,
      snapshot: bundle.snapshot,
      // 建议是「今天」的实时规则结论，AI 只替换每张卡的 reason（条目/可点性不受影响）
      advice: applyAdviceReasons(bundle.cards, reasons),
      adviceStale: !adviceCovered(bundle.cards, reasons),
      reports: {
        progress: bundle.progress,
        schedule: bundle.schedule,
        sticky: bundle.sticky,
      },
      // News 页签：主题配置 + 当日简报（未生成为 null）
      news: { config: newsConfig, briefing: newsBriefing },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/today] 聚合失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
