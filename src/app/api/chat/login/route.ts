import { NextRequest } from 'next/server';
import { resolvePendingLogin, type PendingLoginCredentials } from '@/lib/chat/login-pending';

/**
 * BobWork 登录弹窗的凭据回传接口（browser.login bobwork 模式）。
 * 前端收到 SSE login_required 事件、用户在节点登录弹窗中输入账号密码后调用本接口，
 * 服务端据此恢复挂起的工具循环，调用 browser.login_fill（日志脱敏）代填提交。
 *
 * 安全约定：本接口不打印/记录凭据，凭据只经内存 resolve 后由调用方使用并立即丢弃。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const requestId = String(body?.requestId ?? '');
    if (!requestId) {
      return Response.json({ success: false, error: 'requestId 缺失' });
    }
    const cancelled = body?.cancelled === true;
    let creds: PendingLoginCredentials | null = null;
    if (!cancelled) {
      const username = String(body?.username ?? '').trim();
      const password = String(body?.password ?? '');
      if (!username || !password) {
        return Response.json({ success: false, error: '账号与密码不能为空' });
      }
      creds = { username, password };
    }
    const ok = resolvePendingLogin(requestId, creds);
    if (!ok) {
      return Response.json({ success: false, error: '登录请求已超时或不存在' });
    }
    return Response.json({ success: true, cancelled });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
