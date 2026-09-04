/**
 * WANTED Node 模式状态（进程内单例）
 *
 * /chat 提问后进入 Node 模式：后续输入（含其他指令）都直接发给当前会话，
 * 直到输入 `/chat out`、输入其他已知指令自动退出，或超过 30 分钟未操作自动退出。
 *
 * 面板与微信桥共享同一 Node 进程，因此进程内单例即可双端一致。
 * 会话标识仅 threadId（BobMail 线程主键），无 nodeId——/chat 已与 ChatNode 彻底隔离。
 *
 * 新建会话标准：
 *   - /chat out 解绑后首次 /chat → 无活动绑定 → 新会话
 *   - /chat new → 显式新会话（newThread）
 *   - 30min 无操作自动退出 → 下次提问视为新会话
 * 会话存储（chat_sessions 表）由 chat-session 模块管理：panel 长期、wechat 24 小时过期。
 *
 * ⚠️ 本模块被客户端组件（UnifiedPalette，⌘F 面板）引用，禁止 import 任何服务端模块。
 */
interface NodeModeState {
  active: boolean;
  lastActiveAt: number;
  /** 当前活动会话线程（BobMail threadId） */
  activeThreadId: string | null;
}

/** Node 模式 30 分钟无操作自动退出（线程解绑；会话存储按 source 各自 TTL） */
const NODE_MODE_TTL_MS = 30 * 60 * 1000;

const state: NodeModeState = {
  active: false,
  lastActiveAt: 0,
  activeThreadId: null,
};

/** 进入 Node 模式（并绑定 threadId）。首次 /chat 或 /chat new 时调用。 */
export function enterNodeMode(threadId?: string): void {
  state.active = true;
  state.lastActiveAt = Date.now();
  if (threadId) state.activeThreadId = threadId;
}

/** 刷新计时（每次提问/操作时调用），可用于：复用现有线程时同步刷新绑定 */
export function touchNodeMode(bind?: { threadId?: string }): void {
  if (state.active) {
    state.lastActiveAt = Date.now();
    if (bind?.threadId) state.activeThreadId = bind.threadId;
  }
}

/** 退出 Node 模式：只解绑线程标记，不删会话存储（panel 会话长期保留回看） */
export function exitNodeMode(): void {
  state.active = false;
  state.lastActiveAt = 0;
  state.activeThreadId = null;
}

/** 是否处于 Node 模式（超过 30 分钟未操作自动退出） */
export function isNodeModeActive(): boolean {
  if (!state.active) return false;
  if (Date.now() - state.lastActiveAt > NODE_MODE_TTL_MS) {
    state.active = false;
    state.lastActiveAt = 0;
    state.activeThreadId = null;
    return false;
  }
  return true;
}

/** 获取当前活动会话线程（用于 askTempNode 复用） */
export function getActiveThreadBinding(): { threadId: string | null } {
  isNodeModeActive(); // 先做过期清理（过期会置 null）
  return { threadId: state.activeThreadId };
}

/** 当前模式状态（供面板查询展示） */
export function getNodeModeState(): { active: boolean } {
  return { active: isNodeModeActive() };
}
