import { NextRequest } from 'next/server';
import { handleBridgeRequest } from '@/lib/sandbox/bridge';
import { sanitizeAppId, appExists } from '@/lib/sandbox/apps';
import { resolveAppIdentity } from '@/lib/sandbox/app-token';
import { guardRequestSource } from '@/lib/http/loopback-guard';

/**
 * Bob Sandbox postMessage Bridge API
 *
 * POST /api/sandbox/bridge  { action, data }
 *
 * Called by the host window (CanvasFlow) when a sandbox iframe sends
 * a bob_request via postMessage. Executes the whitelisted action
 * server-side and returns the result.
 */
export async function POST(request: NextRequest) {
  const denied = await guardRequestSource(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => null);
    const action = String(body?.action ?? '');
    const data = (body?.data as Record<string, unknown>) || {};

    if (!action) {
      return Response.json({ success: false, error: 'action is required' }, { status: 400 });
    }

    // 身份闸（2026-10-10）：appId 一律取**签名令牌**解出的值，自报的 _appId 只作为冒充信号。
    // 没有令牌 = 不是从预览页发起的请求（脚本/本机程序）→ 401，杜绝自报身份绕过信任分级。
    const claimedAppId = sanitizeAppId((data as Record<string, unknown>)._appId ?? (data as Record<string, unknown>).appId) ?? undefined;
    const identity = await resolveAppIdentity({
      token: String((data as Record<string, unknown>)._appToken ?? ''),
      claimedAppId,
    });
    if (!identity.appId) {
      return Response.json(
        { success: false, error: `unauthorized: ${identity.error ?? 'invalid app token'}` },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const appId = sanitizeAppId(identity.appId);
    // 存在性闸：小程序已删除 → 410 Gone（已打开的预览页下一次调用即失效）
    if (!appId || !(await appExists(appId))) {
      return Response.json(
        { success: false, error: 'mini-program not found or deleted', appId: appId ?? null },
        { status: 410, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const result = await handleBridgeRequest(action, data, {
      verifiedAppId: appId,
      claimedAppId: identity.mismatch ? claimedAppId : undefined,
    });
    return Response.json({ success: true, data: result });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
