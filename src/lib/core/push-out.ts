/**
 * 外部通道（微信 / 飞书）的**唯一出站口**（2026-10-06 Butler 主动播报工单 P0）
 *
 * 背景：`lib/core/event-reminder.ts` 的 `pushReminderToBridges` 直接调
 * `wechatBridge.pushText` / `feishuBridge.pushText`，**从不经过 `decidePush`**；
 * 而 `/api/butler/push-gate` 跑在浏览器里（`ButlerNoticeHost` 弹 toast 前问一次），
 * 管不到服务端直推 ⇒ 免打扰窗口与单日上限对**手机端**完全不生效。
 * 本模块把「裁决 → 投递 → 计数」收敛到一处，成为服务端出站唯一路径。
 *
 * 与 `push-gate` 的分工：`push-gate` 管**桌面侧**（toast / 系统通知），本模块管**外部通道**。
 * 两者共用同一份策略（`quiet-hours`）与同一份计数状态（`butler/notify-state.json`），
 * 所以档位口径必须同源 —— 尤其 `countsTowardDailyLimit`（见其注释）。
 *
 * 三条硬约束（与 `quiet-hours` 同一条原则）：
 *   1. **失败即放行**（fail-open）：策略层故障绝不能吞掉推送，宁可多打扰一次；
 *   2. **被静默 ≠ 丢内容**：本模块只回答「要不要打扰手机」，内容该由调用方落进抽屉收件箱
 *      （`insertInbox`）；两条链路互不阻塞；
 *   3. **放行才计数**，且只有计入配额的档位才 +1（`reminder` 豁免 —— 闹钟不吃配额）。
 */
import {
  countsTowardDailyLimit,
  decidePush,
  recordPush,
  type PushBlockReason,
  type PushKind,
} from './quiet-hours';

export interface PushOutcome {
  /** 至少有一条通道实际送达 */
  pushed: boolean;
  /** 被裁决拦下（压根没尝试投递）时的原因；放行 / 策略故障时 undefined */
  blockedReason?: PushBlockReason;
  /** 被拦时的顺延时刻（窗口结束或次日 0 点），供调用方在日志/UI 里说明 */
  resumeAt?: number;
  /** 各通道实际结果：false = 未绑定 / 无收件人 / 发送失败（见下方 warn，不静默） */
  wechat: boolean;
  feishu: boolean;
}

/** 投递函数注入缝（仅供单测替换；生产一律走默认实现 = 两个真实桥）。 */
export interface PushDeps {
  pushWechat?: (text: string) => Promise<boolean>;
  pushFeishu?: (text: string) => Promise<boolean>;
}

/**
 * 投递一条文本到外部通道。
 *
 * 动态 `import()` 解析两个桥：沿用 `event-reminder` 的既有做法，避免与桥形成模块初始化环
 * （桥反向上游走 node-chat）。
 */
export async function pushToBridges(
  text: string,
  kind: PushKind,
  deps: PushDeps = {},
): Promise<PushOutcome> {
  const miss: PushOutcome = { pushed: false, wechat: false, feishu: false };
  if (!text) return miss;

  // ① 裁决。抛错 → fail-open（decision 置 null = 放行且不计数，与 push-gate 的错误分支一致）
  let decision: Awaited<ReturnType<typeof decidePush>> | null = null;
  try {
    decision = await decidePush(kind);
  } catch (e) {
    console.warn('[push-out] 裁决失败，按放行处理:', e instanceof Error ? e.message : String(e));
  }
  if (decision && !decision.allow) {
    const at = decision.resumeAt ? new Date(decision.resumeAt).toLocaleString() : '—';
    console.warn(`[push-out] ${kind} 被静默（reason=${decision.reason}，顺延至 ${at}）—— 内容仍在收件箱`);
    return { ...miss, blockedReason: decision.reason, resumeAt: decision.resumeAt };
  }

  // ② 投递：任一通道失败不影响另一条
  const [wechatRes, feishuRes] = await Promise.allSettled([
    deps.pushWechat
      ? deps.pushWechat(text)
      : import('@/lib/bridge/wechat-bridge').then(({ wechatBridge }) => wechatBridge.pushText(text)),
    deps.pushFeishu
      ? deps.pushFeishu(text)
      : import('@/lib/bridge/feishu-bridge').then(({ feishuBridge }) => feishuBridge.pushText(text)),
  ]);
  const ok = (r: PromiseSettledResult<boolean>) => (r.status === 'fulfilled' ? r.value === true : false);
  const wechat = ok(wechatRes);
  const feishu = ok(feishuRes);

  // ③ 留痕：pushText 在「未绑定 / 无收件人 / 未运行 / 发送失败」时一律返回 false 且不抛错。
  //    不留痕的话，「飞书从未私聊过机器人 ⇒ 所有提醒静默丢推」这类冷启动问题永远不可见
  //    （工单缺口 ④）。这里至少保证它出现在日志里。
  if (!wechat || !feishu) {
    console.warn(`[push-out] ${kind} 部分通道未送达: wechat=${wechat ? 'ok' : 'MISS'} feishu=${feishu ? 'ok' : 'MISS'}`);
  }

  // ④ 计数：只有「放行且计入配额且确实投出」才 +1（reminder 不计入 —— 见 countsTowardDailyLimit）
  if (decision && countsTowardDailyLimit(kind) && (wechat || feishu)) {
    await recordPush();
  }

  return { pushed: wechat || feishu, wechat, feishu };
}
