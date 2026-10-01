/**
 * lib/stt/resident-process.ts — 常驻子进程的生命周期骨架（标点服务 / 流式转写服务共用）
 *
 * 为什么抽出来：标点服务与流式转写服务都是「起一次、长期复用、空闲回收」的常驻进程，生命周期
 * 完全同构（原先两处各写了一遍，改一处必忘另一处）：
 *   ① **单实例槽位**：存 globalThis（dev 热重载会丢模块状态，槽位必须能找回来）；
 *   ② **复用与续期**：同 key 且存活即复用，每次 acquire 续期空闲计时；
 *   ③ **冷启动合流**：并发 acquire 共用同一次启动，不会起出两个进程；
 *   ④ **失败即回收**：启动超时 / 进程报错 / 进程退出都立刻回收，并把 stderr 尾巴拼进错误信息；
 *   ⑤ **空闲回收**：超过 idleMs 自动 SIGKILL；主进程退出时顺手带走子进程；
 *   ⑥ **孤儿清理**：按二进制**完整路径**回收上一个进程留下的实例（dev 热重载、打包运行时崩溃）。
 *
 * 差异部分留给调用方，本模块只要三个钩子：
 *   spawn(req)          —— 按请求把子进程拉起来（不等就绪）
 *   waitReady(value)    —— 判定「真能用了」（TCP 可连 / 首行 READY），signal 在进程消失时中止
 *   onStop(value)       —— 回收或崩溃时的收尾（如拒掉在途请求）
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

/** stderr 尾巴上限：够定位原因又不至于无限增长 */
const LOG_TAIL_MAX = 40;

const execFileAsync = promisify(execFile);

/** 常驻实例的最小契约：本模块要用 child 判存活/回收，用 logTail 解释失败原因 */
export interface ResidentInstance {
  child: ChildProcess;
  /** stderr 尾巴（由本模块维护：启动失败时拼进错误信息） */
  logTail: string[];
}

/** 常驻请求的最小契约 */
export interface ResidentRequest {
  /** 复用与回收的标识：换 key 即重建（流式 = 模型 id，标点 = 模型文件路径） */
  key: string;
  /** 可执行文件完整路径：孤儿回收按它精确匹配 argv */
  binaryPath: string;
}

/** 回收原因：reaped = 空闲或主动回收；replaced = 换 key 重建；crashed = 进程自己退了 */
export type ResidentStopReason = 'reaped' | 'replaced' | 'crashed';

export interface ResidentOptions<Req extends ResidentRequest, T extends ResidentInstance> {
  /** globalThis 槽位键（每个常驻服务唯一）：dev 热重载后仍能找回当前实例，避免留下孤儿进程 */
  storeKey: string;
  /** 空闲回收毫秒：每次 acquire 续期 */
  idleMs: number;
  /** 拉起一份新进程（不等就绪）；失败抛错 */
  spawn: (req: Req) => Promise<T>;
  /** 等到真正可用；signal 在子进程退出/报错时中止，用于立即失败而不是干等超时 */
  waitReady: (value: T, signal: AbortSignal) => Promise<void>;
  /** 实例被回收或崩溃时通知（如拒掉在途请求）；之后本模块会 SIGKILL 子进程 */
  onStop?: (value: T, reason: ResidentStopReason) => void;
}

export interface ResidentManager<Req extends ResidentRequest, T extends ResidentInstance> {
  /** 同 key 且存活即复用并续期，否则回收重建；并发调用合流到同一次启动 */
  acquire: (req: Req) => Promise<T>;
  /** 主动回收；传 key 时只回收该 key 的实例（删某个模型时别误伤另一个） */
  stop: (keyFilter?: string) => boolean;
}

interface Slot<T extends ResidentInstance> {
  value: T;
  key: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Store<T extends ResidentInstance> {
  slot?: Slot<T>;
  starting?: Promise<T>;
}

/** 子进程是否还活着（exitCode 非空 = 已退出；killed = 我们已下过手） */
function isAlive(value: ResidentInstance): boolean {
  return value.child.exitCode === null && !value.child.killed;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createResidentManager<Req extends ResidentRequest, T extends ResidentInstance>(
  opts: ResidentOptions<Req, T>,
): ResidentManager<Req, T> {
  const slotStore = (): Store<T> => {
    const g = globalThis as unknown as Record<string, Store<T> | undefined>;
    if (!g[opts.storeKey]) g[opts.storeKey] = {};
    return g[opts.storeKey]!;
  };

  const clearTimer = (slot: Slot<T>) => {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
  };

  /** 内部回收：清槽位 → 通知调用方 → SIGKILL 子进程 */
  const dropSlot = (reason: ResidentStopReason, keyFilter?: string): boolean => {
    const store = slotStore();
    const slot = store.slot;
    if (!slot) return false;
    if (keyFilter !== undefined && slot.key !== keyFilter) return false;
    store.slot = undefined;
    clearTimer(slot);
    try {
      opts.onStop?.(slot.value, reason);
    } catch {
      /* 收尾回调出错不该影响回收本身 */
    }
    if (isAlive(slot.value)) slot.value.child.kill('SIGKILL');
    return true;
  };

  // 主进程退出时顺手带走子进程；强杀/崩溃留下的孤儿交给下次启动时的 reapStray
  const hookKey = `__bobResidentExitHook:${opts.storeKey}`;
  const flags = globalThis as unknown as Record<string, boolean | undefined>;
  if (!flags[hookKey]) {
    flags[hookKey] = true;
    process.once('exit', () => { dropSlot('reaped'); });
  }

  /**
   * 回收「上一个进程留下的」常驻服务。
   * dev 下 tsx watch 一改文件就重启主进程，内存里的槽位连同回收定时器一起蒸发，而子进程还在
   * （内存里压着模型）；打包运行时的崩溃/强杀同理——这类孤儿没有任何人再管它们。
   * 它们只可能由本应用的二进制拉起，故按完整路径精确匹配 argv。
   */
  const reapStray = async (binaryPath: string): Promise<void> => {
    try {
      const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { timeout: 5_000 });
      const self = String(process.pid);
      for (const line of stdout.split('\n')) {
        if (!line.includes(binaryPath)) continue;
        const pid = line.trim().split(/\s+/)[0];
        if (!/^\d+$/.test(pid) || pid === self) continue;
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          /* 已经退出了 */
        }
      }
    } catch {
      /* ps 不可用（或超时）就跳过，不影响主流程 */
    }
  };

  return {
    stop(keyFilter?: string) {
      return dropSlot('reaped', keyFilter);
    },

    async acquire(req: Req): Promise<T> {
      const store = slotStore();
      const slot = store.slot;
      if (slot && slot.key === req.key && isAlive(slot.value)) {
        clearTimer(slot);
        slot.timer = setTimeout(() => dropSlot('reaped'), opts.idleMs);
        return slot.value;
      }
      // 冷启动并发（如两处标点同时到达）：共用同一次启动，别起出两个进程
      if (store.starting) return store.starting;

      dropSlot('replaced'); // 换 key / 上次已退出：先清干净再重建
      const starting = (async (): Promise<T> => {
        await reapStray(req.binaryPath);
        const value = await opts.spawn(req);
        const controller = new AbortController();
        const onGone = () => {
          controller.abort(); // 让 waitReady 立刻失败，而不是干等超时
          const s = slotStore();
          if (s.slot?.value === value) dropSlot('crashed');
        };
        value.child.once('exit', onGone);
        value.child.once('error', onGone);
        value.child.stderr?.on('data', (d: Buffer) => {
          value.logTail.push(...d.toString().split('\n').filter(Boolean));
          if (value.logTail.length > LOG_TAIL_MAX) value.logTail.splice(0, value.logTail.length - LOG_TAIL_MAX);
        });
        try {
          await opts.waitReady(value, controller.signal);
        } catch (e) {
          value.child.removeListener('exit', onGone);
          value.child.removeListener('error', onGone);
          if (isAlive(value)) value.child.kill('SIGKILL');
          const tail = value.logTail.join(' | ').slice(-400);
          throw new Error(`${e instanceof Error ? e.message : String(e)}${tail ? `: ${tail}` : ''}`);
        }
        return value;
      })();

      store.starting = starting;
      try {
        const value = await starting;
        const s = slotStore();
        if (s.starting === starting) s.starting = undefined;
        s.slot = { value, key: req.key, timer: null };
        s.slot.timer = setTimeout(() => dropSlot('reaped'), opts.idleMs);
        return value;
      } catch (e) {
        const s = slotStore();
        if (s.starting === starting) s.starting = undefined;
        throw e;
      }
    },
  };
}