'use client';

/**
 * components/butler/butlerSession.ts —— 抽屉「当前会话指针」的共享读写口（client-only）
 *
 * 真源仍是 localStorage 的一个键；本模块存在的唯一理由是**让非抽屉组件也能读到它**：
 *   - `ButlerDrawer` 负责写（切换联系人 / 新建会话时）；
 *   - `ButlerNoticeHost` 的 60s 心跳（`POST /api/butler/tick`）需要带 `threadId` 作运行锚点，
 *     否则规则预算（`.state/rule-budget`）在定时链路上永远不计数
 *     （评审 P2-⑱：预算依赖 threadId，缺省时 `consumeBudget` 直接视为有额度）。
 *
 * 常量与读写实现原在 `ButlerDrawer.tsx` 内部（`ACTIVE_THREAD_KEY` 等），2026-10-02 原样外移，
 * 行为不变：**读失败一律返回 null**（隐私模式 / 存储被禁 → 退化为「每次打开都新会话」）。
 */
const ACTIVE_THREAD_KEY = 'butler-active-thread';

export function readActiveThreadId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_THREAD_KEY);
  } catch {
    return null;
  }
}

export function writeActiveThreadId(threadId: string): void {
  try {
    localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
  } catch {
    /* 存不下不影响本次会话可用 */
  }
}

export function clearActiveThreadId(): void {
  try {
    localStorage.removeItem(ACTIVE_THREAD_KEY);
  } catch {
    /* 同上 */
  }
}
