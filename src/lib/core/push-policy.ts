/**
 * Butler 事件折叠与出站接线（② 神经，2026-10-10）
 *
 * 定位：把「② 事件驱动主动性」里**从事件到出站**的那一段收敛到一处 —— 生产者只描述
 * 「发生了什么」（`ButlerEvent`），**不自己决定推不推、推几条**：
 *
 *   事件 ──enqueue──▶ 折叠缓冲（同组、窗口内）──flush──▶ 一条 digest ──▶ pushToBridges
 *
 * 与上下游的分工（**不重复造**）：
 *   - 上游 `mail-poll` / 后续其它感知源：负责「看见事件」并写收件箱，本模块不碰 IO 采集；
 *   - 下游 `lib/core/push-out.ts`：唯一出站口，免打扰窗口 / 单日上限 / 计数都在那里裁决；
 *     本模块**只做折叠**，绝不绕开它直投桥 —— 否则窗口与上限对手机端立即失效。
 *
 * 三条硬约束：
 *   1. **折叠而非丢内容**：一次收到 N 条同类事件，只推一条带计数的 digest（对齐「另有 N 条」），
 *      细节仍在各自收件箱条目里（本模块只影响**外发文案条数**）；
 *   2. **fail-open**：折叠层自身抛错时，退化成「逐行原文」照推 —— 策略故障绝不吞推送
 *      （与 `push-out.ts` 的 decidePush 错误分支同一条原则）；
 *   3. **窗口内合并**：同一 (档位, 分组) 的事件在 `PUSH_WINDOW_MS` 内合并为一条，
 *      避免「一秒来 10 封邮件 → 手机震 10 下」。
 *
 * 为什么不走 `lib/bus.ts` 的事件订阅：`bus` 是**纯客户端**单例（全部订阅方在
 * `components/**`），服务端 publish 到不了任何消费者；且 Turbopack 下 instrumentation 与
 * route handler 可能落在不同 chunk，模块级单例不共享（`feishu-bridge` 因此挂 globalThis）。
 * 故这里用**进程内直接 enqueue**：生产者显式把事件交给本模块，确定性最强、无跨 chunk 隐患。
 */
import { pushToBridges, type PushDeps, type PushOutcome } from './push-out';
import type { PushKind } from './quiet-hours';

/**
 * 一条待播报事件。
 *
 * 生产者只填「事实」三件套：档位、分组、一句话；推不推、推几条交给本模块与 `push-out`。
 */
export interface ButlerEvent {
  /** 档位：决定能否被免打扰静默、是否计当日配额（口径与 `quiet-hours` 同源） */
  kind: PushKind;
  /** 折叠分组（同时用作 digest 标题）：同组事件在窗口内折成一条，如 `'📧 New mail'` */
  group: string;
  /** 一行摘要（digest 正文的那一句） */
  title: string;
  /** 次级说明（可选，如发件人），渲染在 title 下一行 */
  detail?: string;
  /** 事件时刻（排序 / 展示用，缺省按入队顺序） */
  at?: number;
}

/** 同组事件的合并窗口：窗口内到达的合并为一条（从**首个**事件起算，故批量事件只推一次） */
export const PUSH_WINDOW_MS = 60_000;

/** digest 里最多逐条列出的条数（其余折成一行计数） */
const PREVIEW = 5;

/* ==================== 纯函数（可测、无 IO） ==================== */

/**
 * 纯：把**同一组**事件折成一条 digest 文本。
 *  - 0 条 → ''（调用方据此跳过）
 *  - 1 条 → 直接给那一行（不写计数头 —— 单条写「(1)」是噪音）
 *  - N 条 → `标题 · N 条` + 前 PREVIEW 行 + 「…另有 K 条（已折叠）」
 */
export function composeDigestText(group: string, events: ButlerEvent[]): string {
  const list = events.filter((e) => e && e.title);
  if (list.length === 0) return '';
  const line = (e: ButlerEvent) => (e.detail ? `${e.title}\n  ${e.detail}` : e.title);
  if (list.length === 1) return line(list[0]);

  const shown = list.slice(0, PREVIEW);
  const folded = list.length - shown.length;
  const lines = [`${group} · ${list.length} 条`, ...shown.map((e) => `- ${line(e)}`)];
  if (folded > 0) lines.push(`- …另有 ${folded} 条（已折叠）`);
  return lines.join('\n');
}

/** 折叠后的 digest（按 (档位, 分组) 各一条） */
export interface PushDigest {
  kind: PushKind;
  group: string;
  count: number;
  text: string;
}

/** 纯：一批事件 → 按 (档位, 分组) 折叠的 digest 列表（保持首次出现的分组顺序） */
export function foldButlerEvents(events: ButlerEvent[]): PushDigest[] {
  const buckets = new Map<string, ButlerEvent[]>();
  for (const e of events) {
    if (!e || !e.title) continue;
    const key = `${e.kind}\u0000${e.group}`;
    const arr = buckets.get(key);
    if (arr) arr.push(e);
    else buckets.set(key, [e]);
  }
  const out: PushDigest[] = [];
  for (const [key, arr] of buckets) {
    const sep = key.indexOf('\u0000');
    const kind = key.slice(0, sep) as PushKind;
    const group = key.slice(sep + 1);
    out.push({ kind, group, count: arr.length, text: composeDigestText(group, arr) });
  }
  return out;
}

/* ==================== 折叠缓冲（进程内） ==================== */

interface Buffer {
  kind: PushKind;
  group: string;
  events: ButlerEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  deps: PushDeps;
}

/** key = `${kind}\u0000${group}` —— 不同档位 / 分组互不折叠（reminder 不能被 report 的窗口吃掉） */
const buffers = new Map<string, Buffer>();

function bufferKey(e: ButlerEvent): string {
  return `${e.kind}\u0000${e.group}`;
}

/**
 * 投入一批事件（生产者的唯一入口）。同组事件在 `PUSH_WINDOW_MS` 内合并，窗口到点自动 flush。
 *
 * `deps` 仅供单测注入投递函数；生产一律省略（走真实桥）。
 */
export function enqueueButlerEvents(events: ButlerEvent[], deps: PushDeps = {}): void {
  for (const e of events) {
    if (!e || !e.title) continue;
    const key = bufferKey(e);
    let buf = buffers.get(key);
    if (!buf) {
      buf = { kind: e.kind, group: e.group, events: [], timer: null, deps };
      buffers.set(key, buf);
    }
    buf.events.push(e);
    if (deps) buf.deps = deps;
    if (!buf.timer) {
      buf.timer = setTimeout(() => {
        void flushKey(key).catch((err) => {
          console.error('[push-policy] 折叠出站失败:', err instanceof Error ? err.message : String(err));
        });
      }, PUSH_WINDOW_MS);
      // 不阻止进程退出（服务端本身常驻，这里只是防御性）
      buf.timer.unref?.();
    }
  }
}

/**
 * flush 一个缓冲：折叠 → 逐 digest 走统一出站口。
 *
 * **fail-open**：折叠抛错时退化为「逐行原文」，绝不因策略层故障吞掉推送。
 */
async function flushKey(key: string): Promise<PushOutcome[]> {
  const buf = buffers.get(key);
  if (!buf) return [];
  buffers.delete(key);
  if (buf.timer) clearTimeout(buf.timer);
  if (buf.events.length === 0) return [];

  let digests: PushDigest[];
  try {
    digests = foldButlerEvents(buf.events);
  } catch (e) {
    console.warn('[push-policy] 折叠失败，退化为逐行原文:', e instanceof Error ? e.message : String(e));
    digests = [{ kind: buf.kind, group: buf.group, count: buf.events.length, text: buf.events.map((x) => x.title).join('\n') }];
  }

  const out: PushOutcome[] = [];
  for (const d of digests) {
    if (!d.text) continue;
    out.push(await pushToBridges(d.text, d.kind, buf.deps));
  }
  return out;
}

/** 立刻 flush 所有缓冲（供单测与优雅退出；生产由窗口定时器触发） */
export async function flushButlerEvents(): Promise<PushOutcome[]> {
  const keys = [...buffers.keys()];
  const out: PushOutcome[] = [];
  for (const k of keys) out.push(...(await flushKey(k)));
  return out;
}

/** 当前缓冲中的事件总数（观测 / 单测用；不触发任何 IO） */
export function pendingButlerEventCount(): number {
  let n = 0;
  for (const buf of buffers.values()) n += buf.events.length;
  return n;
}
