import { NextRequest } from 'next/server';
import { resolvePendingConfirm } from '@/lib/chat/confirm-pending';

/**
 * 工具「需手动确认名单」的确认回传接口。
 * 前端收到 SSE tool_confirm 事件、用户点击允许/拒绝后调用本接口，
 * 服务端据此恢复挂起的工具循环（允许→执行，拒绝→跳过并告知模型）。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const confirmId = String(body?.confirmId ?? '');
    if (!confirmId) {
      return Response.json({ success: false, error: 'confirmId 缺失' });
    }
    const approved = body?.approved === true;
    // 结构化确认卡片：用户编辑后的参数（可选），随确认结果回传覆盖执行参数
    const edited =
      body?.edited && typeof body.edited === 'object'
        ? (body.edited as Record<string, unknown>)
        : undefined;
    const ok = resolvePendingConfirm(confirmId, approved, edited);
    if (!ok) {
      return Response.json({ success: false, error: '确认已超时或不存在' });
    }
    return Response.json({ success: true, approved });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
