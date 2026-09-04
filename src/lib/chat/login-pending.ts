/**
 * 登录凭据挂起机制（跨请求共享）
 *
 * 流程：模型调用 browser.login（BobWork 模式）时，扩展返回 loginRequired，route.ts
 * 调用 createPendingLogin 生成 requestId + Promise，通过 SSE 的 login_required 事件
 * 把站点名/URL 发给前端；前端在 BobWork 节点弹出登录窗，用户输入账号密码后
 * POST /api/chat/login 回传凭据，resolvePendingLogin 找到对应 Promise 并 resolve。
 * 服务端随后调用 browser.login_fill（日志脱敏）代填并提交，把结果摘要（不含凭据）
 * 作为 tool_result 返回给模型。超时/关闭未回传按 null 处理，避免挂起泄漏。
 *
 * 安全约定：本模块只存内存凭据，resolve 后立即清除；任何日志/审计不得输出账号密码。
 */

/** 用户提交的登录凭据（仅内存短暂存活） */
export interface PendingLoginCredentials {
  username: string;
  password: string;
}

type PendingLoginEntry = {
  nodeId?: string;
  resolve: (creds: PendingLoginCredentials | null) => void;
  timer: NodeJS.Timeout;
};

const pendingMap = new Map<string, PendingLoginEntry>();

/** 默认登录凭据等待时长（毫秒），超时视为未提供（null） */
export const LOGIN_TIMEOUT_MS = 180_000;

/**
 * 登记一个待回传的登录请求。
 * 返回 requestId 与 Promise：前端回传后 resolve(creds)，超时/关闭 resolve(null)。
 */
export function createPendingLogin(
  nodeId?: string,
): { requestId: string; promise: Promise<PendingLoginCredentials | null> } {
  const requestId = `login_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const promise = new Promise<PendingLoginCredentials | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingMap.delete(requestId);
      resolve(null); // 超时视为未提供
    }, LOGIN_TIMEOUT_MS);
    pendingMap.set(requestId, {
      nodeId,
      resolve: (creds: PendingLoginCredentials | null) => {
        clearTimeout(timer);
        pendingMap.delete(requestId);
        resolve(creds);
      },
      timer,
    });
  });
  return { requestId, promise };
}

/**
 * 回传登录凭据。找到并 resolve 对应挂起项，返回 true；无此 requestId 返回 false。
 * 凭据只在本函数内短暂引用，随后由调用方使用并丢弃，不落日志。
 */
export function resolvePendingLogin(requestId: string, creds: PendingLoginCredentials | null): boolean {
  const entry = pendingMap.get(requestId);
  if (!entry) return false;
  entry.resolve(creds);
  return true;
}
