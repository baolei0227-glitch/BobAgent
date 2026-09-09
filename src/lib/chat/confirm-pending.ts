/**
 * 工具执行前的人工确认挂起机制（跨请求共享）
 *
 * 流程：route.ts 工具循环发现目标工具需要人工确认时，
 * 调用 createPendingConfirm 生成 confirmId + Promise，通过 SSE 把
 * confirmId 发给前端；前端弹确认框后 POST /api/chat/confirm 回传
 * （approved + 可选 edited 编辑后参数），resolvePendingConfirm 找到对应
 * Promise 并 resolve，工具循环继续。超时未确认按 timeout 处理，避免挂起泄漏。
 *
 * edited：结构化确认卡片允许用户修改后再确认，回传的编辑结果随 verdict 一起
 * 交给服务端，服务端用 edited 覆盖工具参数后再执行。
 */

type PendingEntry = {
  toolName: string;
  /** 序列化后的工具参数（JSON 字符串） */
  args: string;
  nodeId?: string;
  resolve: (result: ConfirmResult) => void;
  timer: NodeJS.Timeout;
};

const pendingMap = new Map<string, PendingEntry>();

/** 确认结果：approved 用户允许 / denied 用户明确拒绝 / timeout 超时未操作（≠拒绝） */
export type ConfirmVerdict = 'approved' | 'denied' | 'timeout';

/** 确认完成的结果：verdict + 用户编辑后的工具参数（仅 approved 且用户改动时有） */
export type ConfirmResult = {
  verdict: ConfirmVerdict;
  /** 用户编辑后的工具参数（覆盖执行参数用；未编辑/非允许时为空） */
  edited?: Record<string, unknown>;
};

/** 默认确认等待时长（毫秒）：10 分钟。用户可能正在处理别的事，超时只是防挂起的最后防线（视为未操作 timeout，不等同于用户拒绝） */
export const CONFIRM_TIMEOUT_MS = 600_000;

/**
 * 登记一个待确认的工具调用。
 * 返回 confirmId 与 Promise：确认回传后 resolve 结果（approved/denied/timeout + edited）。
 */
export function createPendingConfirm(
  toolName: string,
  args: string,
  nodeId?: string,
): { confirmId: string; promise: Promise<ConfirmResult> } {
  const confirmId = `confirm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const promise = new Promise<ConfirmResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingMap.delete(confirmId);
      resolve({ verdict: 'timeout' }); // 超时未操作：记为 timeout（区别于用户明确拒绝）
    }, CONFIRM_TIMEOUT_MS);
    pendingMap.set(confirmId, {
      toolName,
      args,
      nodeId,
      resolve: (result: ConfirmResult) => {
        clearTimeout(timer);
        pendingMap.delete(confirmId);
        resolve(result);
      },
      timer,
    });
  });
  return { confirmId, promise };
}

/**
 * 回传确认结果。找到并 resolve 对应挂起项，返回 true；无此 confirmId 返回 false。
 * approved 为 true → approved；为 false → denied（用户明确拒绝）。
 * edited：结构化确认卡片回传的用户编辑参数（可选）。
 */
export function resolvePendingConfirm(
  confirmId: string,
  approved: boolean,
  edited?: Record<string, unknown>,
): boolean {
  const entry = pendingMap.get(confirmId);
  if (!entry) return false;
  entry.resolve(approved ? { verdict: 'approved', edited } : { verdict: 'denied' });
  return true;
}
