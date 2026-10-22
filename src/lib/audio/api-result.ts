/**
 * 把一次 `/api/audio/*` 响应规范化为「带可读原因的结果对象」。
 *
 * **纯函数**（入参只用一个 `Response`，不碰 fs / 不碰网络本体），所以可直接单测。
 *
 * 为什么需要它：`fetch` 拿到的响应体形态并不总是 JSON ——
 *   - 正常业务结果：JSON（`{success:true,…}` 或 `{success:false,error}`）；
 *   - **服务端故障**：`/api/audio/clip` 的兜底会返回 500 + JSON（见该路由 `:74-88`），
 *     但**框架级/代理级错误**（未捕获异常的默认处理器、网关）返回的是 **HTML 错误页**；
 *   - 空体：`204` / 连接被截断。
 *
 * 旧写法 `return await resp.json()`：只要响应体不是 JSON 就抛 → 被外层 catch 吞成 `null`
 * ⇒ 调用方的 `d?.error` 永远拿不到原因 ⇒ 失败对用户完全不可见
 * （打点已乐观写进组件 state，刷新后消失 = **静默丢数据**）。
 *
 * 本函数保证：**无论响应体是什么形态，都返回一个对象**，且在失败时带可读 `error`。
 * 调用方既有的 `d?.success` / `String(d?.error || '兜底文案')` 写法无需改动即可拿到真实原因。
 */
export async function readApiResult(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text().catch(() => '');
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* 非 JSON（HTML 错误页等）→ 落到下面的兜底 */
  }
  // 判定口径：走到这里说明响应体不可用。`resp.ok` 为真时多半是「OK 但无体」，
  // 但既然拿不到 `success` 字段，一律按失败处理 —— 宁可报错也不能假装成功。
  return {
    success: false,
    error: `HTTP ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`,
  };
}
