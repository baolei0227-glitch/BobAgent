/**
 * POST /api/butler/advice/refresh — 生成今日建议卡的 AI 判断（reason）并落缓存
 *
 * 分工：GET /api/butler/today 只读缓存（首屏秒开），未命中时置 `adviceStale`；
 * 前端后台打本端点补算 —— 生成是慢路径（要等模型），绝不阻塞首屏。
 *
 * 输入取自与 GET 同一份拼装（loadTodayBundle），保证卡片集合 / hash 口径一致、缓存能打中。
 * 失败（无模型 / 超时 / 解析失败）返回 `reasons: null`，前端保留规则文案 —— 不是错误。
 * 建议卡集合为空（全 clear）时也返回 null，前端无需再请求。
 */
import { NextRequest, NextResponse } from 'next/server';
import { loadTodayBundle } from '@/lib/butler/today-advice';
import { generateAdviceReasons } from '@/lib/butler/advice-ai';

export async function POST(request: NextRequest) {
  try {
    const bundle = await loadTodayBundle(request.nextUrl.origin);
    const reasons = await generateAdviceReasons(bundle.cards);
    return NextResponse.json({ success: true, reasons });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/today] advice refresh 失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
