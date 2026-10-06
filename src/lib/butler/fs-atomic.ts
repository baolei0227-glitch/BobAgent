/**
 * lib/butler/fs-atomic.ts —— Butler 侧「串行锁 + 原子写」公共原语（server-only）
 *
 * 背景（2026-10-02 架构评审 P1-⑨/⑪）：同一套并发控制此前有 **5 份副本**——
 *   - 模块级全局串行锁：`rules.ts`（`_rulesLock`）、`skills.ts`（`_skillsLock`）、
 *     `rule-logs.ts`（`_logLock`）、`storage.ts`（`_rolesLock`，还是内联未抽函数的写法）；
 *   - 按 key 分键的锁：`threads.ts`（`Map<threadId, Promise>`，含队尾归还）。
 * 另有 **8 处** `${pid}.${Date.now()}.tmp` 的临时文件名，同毫秒并发会互相覆盖。
 * 该坑仓库里已有记载与正确先例：`lib/core/daily-tasks.ts` 的 pushPending 用随机后缀修掉了
 * 「同名 tmp 相互覆盖 → 后一个 rename 的源已不存在 → ENOENT」。
 *
 * 本模块把两者收敛成唯一真源，**不引入任何新锁协议**（仍是进程内 promise 队列 + tmp→rename）。
 * ⚠️ 进程内锁只在单进程内有效：dev 与安装版共用 `~/BobWork` 时属跨进程，仍靠原子写兜底。
 *
 * 依赖刻意做到零内部依赖（只碰 node 内置），避免与 threads / rules 形成 import 环。
 */
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';

/**
 * 建一把**全局串行锁**：同一把锁上的临界区按调用顺序排队执行。
 * 语义与既有 `rules.ts` / `skills.ts` / `rule-logs.ts` / `storage.ts` 的写法逐字一致。
 */
export function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = tail;
    let release: () => void = () => {};
    tail = (async () => {
      if (prev) await prev;
      await new Promise<void>((res) => {
        release = res;
      });
    })();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * 建一把**按 key 分键的锁**：不同 key 互不阻塞，同 key 串行。
 * 语义与既有 `threads.ts` 的 `withLock(threadId, fn)` 逐字一致——含**队尾归还**：
 * 只有自己仍是最新排队者时才摘除，避免把后来者的锁误删（否则后续请求会绕过队列）。
 */
export function createKeyedLock<K = string>(): <T>(key: K, fn: () => Promise<T>) => Promise<T> {
  const locks = new Map<K, Promise<void>>();
  return async function withKeyLock<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = (async () => {
      if (prev) await prev;
      await new Promise<void>((res) => {
        release = res;
      });
    })();
    locks.set(key, next);
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === next) locks.delete(key);
    }
  };
}

/**
 * 原子写文本文件：先写**随机后缀**的 tmp，再 rename 覆盖目标（POSIX rename 是原子的）。
 *
 * 随机后缀是必须的：旧写法 `${pid}.${Date.now()}.tmp` 在同一进程同一毫秒发起两次写时会同名，
 * 后者覆盖前者的 tmp，先完成的 rename 把源移走后，另一个 rename 就 ENOENT。
 * （每日任务链路已按此修过并留了注释，见 `lib/core/daily-tasks.ts` 的 pushPending。）
 *
 * rename 失败会重试 3 次并退化为直写：宁可少一次原子性，也不要把内容丢掉。
 * 失败路径统一清掉自己的 tmp，避免遗留在数据目录里（评审实测 `.state/threads/` 曾有 4 个残留）。
 */
export async function atomicWriteFile(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, 'utf-8');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch {
      // 目标被并发删/改、或 Windows 上短暂占用 → 重试
    }
  }
  try {
    await fs.writeFile(target, data, 'utf-8');
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
