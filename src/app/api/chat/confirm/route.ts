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
      // 缺 confirmId 是请求体不合法，同样不能回 200：前端以前会把 200 当「回传成功」，
      // 于是挂起项还在、门禁却没人收口，只能干等到 10 分钟超时（与挂起项不存在同一种静默挂死）。
      return Response.json({ success: false, error: 'confirmId 缺失' }, { status: 400 });
    }
    const approved = body?.approved === true;
    // 结构化确认卡片：用户编辑后的参数（可选），随确认结果回传覆盖执行参数
    const edited =
      body?.edited && typeof body.edited === 'object'
        ? (body.edited as Record<string, unknown>)
        : undefined;
    const ok = resolvePendingConfirm(confirmId, approved, edited);
    if (!ok) {
      // 服务端留痕：这条才是事后定位门禁挂死的证据（浏览器 console 看不到）。落到 dev 日志里，
      // 出现时即可确认「回传的 confirmId 在挂起表里查不到」——热更重建挂起表 / 超时已收口 / 旧卡片。
      console.warn('[chat/confirm] 挂起项不存在，本次确认未生效:', confirmId);
      // 409 而不是 200：这个挂起项已经不存在了（超时收口、本轮已断开、或卡片来自上一次会话）。
      // 以前返回 200 让前端无从分辨「回传成功」与「白回传」——团队审批门禁正因此静默挂死到超时。
      return Response.json(
        { success: false, error: '确认已超时或已失效（挂起项不存在），本次确认未生效' },
        { status: 409 },
      );
    }
    return Response.json({ success: true, approved });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
