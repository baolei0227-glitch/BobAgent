/**
 * /api/butler/tick — Butler 独立触发端点（Phase 3 §3.3）
 *
 * 让 Butler 的主动行为**不依赖对话**地被唤醒：直接调运行时门面 butlerTick（trigger: timer），
 * 到期的定时规则会被宿主侧执行一次（不经模型、不经 SSE 流）。
 *
 * 幂等：沿用 hits.occurrence 反查去重（rule-timer 读 logs/hits），**不新增计数器**。
 * 不做常驻调度器（与 Phase 2「不新增后台调度器」一致），由桌面端按需调用。
 *
 * POST body（可选）：{ projectId?, threadId? } —— 运行锚点（作用域具体度判定 / 预算计数）。
 * 返回：{ success, decision, notice, producedRef, missed }。
 *   `missed` = 应用未运行期间错过、超出 24h 补偿窗口、**不会补跑**的定时实例（2026-10-02 评审 §2.2-7）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { butlerTick } from '@/lib/butler/runtime';

export async function POST(request: NextRequest) {
  try {
    let body: { projectId?: unknown; threadId?: unknown } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      /* 空体 / 非 JSON → 无锚点，仍可跑（定时规则的作用域判定会自动回退） */
    }
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined;
    const threadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : undefined;

    const adj = await butlerTick({
      trigger: { kind: 'timer' },
      anchor: { projectId, threadId },
    });

    return NextResponse.json({
      success: true,
      decision: adj.decision,
      notice: adj.notice ?? null,
      producedRef: adj.producedRef ?? null,
      // 应用未运行期间错过、且超出 24h 补偿窗口的定时实例（每条规则只告知一次）——此前是静默丢失
      missed: adj.missed.length > 0 ? adj.missed : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/tick] 失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}