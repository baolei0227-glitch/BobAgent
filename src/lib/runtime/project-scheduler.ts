/**
 * src/lib/runtime/project-scheduler.ts
 * 项目级后台调度器（server-only）：用户对话 > 成果块提炼 > 账本编译。
 *
 * 为什么需要它：三类调用都要打模型，也都会读写同一批项目文件。各自用「静默窗 + 单飞」
 * 只能保证自己不重入，管不了彼此 —— 用户正对话时后台编译起会话抢模型，或两个后台任务
 * 同时写 .md，都会出问题。
 *
 * 语义（三条写死，不再由各触发器自行判断）：
 *   - 互斥：同一项目同时只跑一个后台任务（"项目文件只能有一个后台写者"）；
 *   - 优先级：outcome（成果块提炼） > compile（账本编译），同优先级先来先跑；
 *   - 用户优先：有用户对话在跑时后台一律不启动（不抢模型），对话结束自动继续。
 *
 * 「可中断」的粒度是**批次边界**，不是 kill：正在跑的会话不 abort（abort 掉等于白烧
 * 已花掉的 token），后续批次往后排即可。账本编译本身有幂等判据（积压数减少才续跑），
 * 被挡住的批次重新排上就能接着编，不必重来。
 */

import { resolve } from 'path';

/** 后台任务优先级（仅后台之间比较；用户对话不进这个队列，它是"让位"条件） */
export type BackgroundPriority = 'outcome' | 'compile';

/** 数字越小越优先 */
const RANK: Record<BackgroundPriority, number> = { outcome: 0, compile: 1 };

interface QueueItem {
  priority: BackgroundPriority;
  /** 已包好 resolve 的 task：跑完（含抛错）即 resolve 排队方的 Promise */
  task: () => Promise<void>;
}

interface ProjectState {
  /** 正在跑的用户对话数（同一项目可能并发多个 chat 请求） */
  userTurns: number;
  /** 是否有后台任务持有互斥 */
  running: boolean;
  queue: QueueItem[];
}

/** key = 规范化项目根绝对路径 */
const states = new Map<string, ProjectState>();

function stateOf(key: string): ProjectState {
  let s = states.get(key);
  if (!s) {
    s = { userTurns: 0, running: false, queue: [] };
    states.set(key, s);
  }
  return s;
}

/** 项目根 → 调度 key；空值返回 ''（调用方回落为"不排队、直接跑"） */
function keyOf(projectRoot: string): string {
  const root = (projectRoot || '').trim();
  return root ? resolve(root) : '';
}

/**
 * 进入一轮用户对话（在 /api/chat 请求开始处调用）。
 * 持有期间后台任务不启动；返回的 release 必须在请求收尾（含异常/断开）时调用。
 * release 幂等，重复调用无副作用。
 */
export function enterUserTurn(projectRoot: string): () => void {
  const key = keyOf(projectRoot);
  if (!key) return () => {};
  const s = stateOf(key);
  s.userTurns += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.userTurns = Math.max(0, s.userTurns - 1);
    if (s.userTurns === 0) pump(key);
  };
}

/**
 * 排一个后台任务：同项目按优先级串行执行，用户对话在跑时先等。
 * 返回的 Promise 在任务真正跑完（或抛错）后 resolve —— 调用方可 await，也可 fire-and-forget。
 */
export function runBackground(
  projectRoot: string,
  priority: BackgroundPriority,
  task: () => Promise<void>,
): Promise<void> {
  const key = keyOf(projectRoot);
  // 没有项目上下文 → 无从互斥，保持原行为直接跑
  if (!key) return task();

  const s = stateOf(key);
  return new Promise<void>((resolveQueued) => {
    const item: QueueItem = {
      priority,
      task: async () => {
        try {
          await task();
        } finally {
          resolveQueued();
        }
      },
    };
    // 插到第一个比自己低优先级的项之前 → 高优先级可插队，同优先级先来先跑
    const idx = s.queue.findIndex((q) => RANK[q.priority] > RANK[priority]);
    if (idx === -1) s.queue.push(item);
    else s.queue.splice(idx, 0, item);
    pump(key);
  });
}

/** 尝试启动队首任务（有用户对话在跑 / 已有后台在跑则原地等下一次 pump） */
function pump(key: string): void {
  const s = states.get(key);
  if (!s || s.running || s.userTurns > 0) return;
  const next = s.queue.shift();
  if (!next) return;

  s.running = true;
  void next
    .task()
    .catch((e) => {
      console.warn('[project-scheduler] 后台任务异常（已吞）:', e instanceof Error ? e.message : String(e));
    })
    .finally(() => {
      s.running = false;
      pump(key);
    });
}
