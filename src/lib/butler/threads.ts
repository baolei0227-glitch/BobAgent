/**
 * lib/butler/threads.ts —— Butler 线程存储写原语（server-only，Phase 4 §4a）
 *
 * 定位：Butler **会话身体的真源**。取代此前的 `lib/core/chat-session.ts`——
 * 后者把 Butler 的联系人/线程存进 `.inbox.db` 的 `chat_sessions` 表（表名、类型名、TTL 语义都叫 "chat"），
 * 让 Butler 的会话层长期寄生在主 chat 的命名与存储里。
 *
 * 落点：`<APP_ROOT>/butler/.state/threads/<threadId>.json`（**一条线程 = 一个文件**）。
 *   - 点前缀目录 `.state/` 与 `.rules/` / `.skills/` 同构，同在 `butlerRoot()` 下，与角色目录分离；
 *   - 结构见 threads-shared.ts 的 ButlerThread。
 *
 * 并发控制：单写原语内部串行（每 threadId 一把锁，照抄 rules.ts 的 `withLock`）
 * + 原子写（tmp → rename，照抄 storage.ts 的 writeRoles）。**不引入额外锁协议**。
 *
 * 生命周期：`lifecycle`（active / archived）+ `expiresAt`（wechat 24h）由本模块拥有，
 * 周期清扫由 `startThreadSweeper` 自己起（不再叫 chat-session）。
 *
 * 依赖刻意收敛：只依赖 ./storage（其自身零内部依赖）、./threads-shared 与 lib/bus（纯类型），
 * 不 import chat / core，避免环。迁移模块走**动态 import**（静态会形成 threads ↔ threads-migrate 环）。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { stripThinkTags } from '@/lib/bus';
import type { ThinkingLevel } from '@/lib/types';
import { butlerRoot, ensureDir, pruneOrphanRoles } from './storage';
import { atomicWriteFile, createKeyedLock } from './fs-atomic';
import {
  BUTLER_THREAD_ID_PREFIX,
  messageTimeAt,
  msgKey,
  overlapLen,
  parseModelTag,
  parsePersona,
  parseThinkingLevel,
  parseWorkspaceFolder,
  summarizeThread,
  threadExpiresAt,
  trimThreadMessages,
  type ButlerPersona,
  type ButlerThread,
  type ButlerThreadLifecycle,
  type ButlerThreadSource,
  type ButlerThreadSummary,
  type ButlerWorkspaceFolder,
  type ChatMessage,
  type ThreadMessageHit,
} from './threads-shared';

export type {
  ButlerPersona,
  ButlerThread,
  ButlerThreadSource,
  ButlerThreadLifecycle,
  ButlerThreadSummary,
  ButlerWorkspaceFolder,
  ChatMessage,
  ThreadMessageHit,
} from './threads-shared';

/** 线程 id 白名单：字母数字与 `-` / `_`，1–128 位。同时挡住目录穿越（不含 `.` 与 `/`）。
 *  历史 id（`chat-…`）、常驻 id（`butler-notify` / `butler-recorder`）与新 id（`b-…`）都在此集合内。 */
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 线程目录：<APP_ROOT>/butler/.state/threads */
export function threadsDir(): string {
  return join(butlerRoot(), '.state', 'threads');
}

/** 单个线程文件路径：<threadsDir>/<threadId>.json */
export function threadFilePath(threadId: string): string {
  return join(threadsDir(), `${threadId}.json`);
}

/** 生成新线程 id：`b-<ts>-<6rand>`；迁移进来的历史 id **原样保留**，不重写。 */
export function generateThreadId(): string {
  return `${BUTLER_THREAD_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ==================== 迁移懒钩子（一次性） ====================

let _migratePromise: Promise<void> | null = null;

/**
 * 确保历史 `chat_sessions` 已迁入本存储（幂等，best-effort）。
 * 走**动态 import** 取迁移实现：静态 import 会形成 threads ↔ threads-migrate 的模块环。
 * 失败只告警不阻断 —— 迁移是最佳努力，不能拖垮会话读写；结果按进程缓存（重试留给下次启动，
 * 避免在无旧库的环境（如单测）里每次读写都重试并刷日志）。
 */
async function ensureMigrated(): Promise<void> {
  if (!_migratePromise) {
    _migratePromise = (async () => {
      try {
        const { migrateLegacyThreads } = await import('./threads-migrate');
        await migrateLegacyThreads();
      } catch (e) {
        console.warn('[butler/threads] 历史会话迁移失败:', e instanceof Error ? e.message : String(e));
      }
    })();
  }
  await _migratePromise;
}

// ==================== 序列化 / 反序列化 ====================

/** 解析线程文件内容；坏文件 / 缺关键字段 → null（不让脏数据阻断列表） */
export function parseThread(raw: string, fallbackId: string): ButlerThread | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const messages: ChatMessage[] = Array.isArray(o.messages)
    ? (o.messages as unknown[]).filter(
        (m): m is ChatMessage =>
          !!m && typeof m === 'object' && typeof (m as ChatMessage).content === 'string',
      )
    : [];
  const tailTimes: number[] = Array.isArray(o.tailTimes)
    ? (o.tailTimes as unknown[]).filter((x): x is number => typeof x === 'number')
    : [];
  const sourceRaw = typeof o.source === 'string' ? o.source : '';
  const source: ButlerThreadSource = (['panel', 'wechat', 'notify'] as string[]).includes(sourceRaw)
    ? (sourceRaw as ButlerThreadSource)
    : 'panel';
  const lifecycle: ButlerThreadLifecycle = o.lifecycle === 'archived' ? 'archived' : 'active';
  const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return {
    threadId: typeof o.threadId === 'string' && o.threadId ? o.threadId : fallbackId,
    messages,
    tailTimes,
    persona: parsePersona(o.persona),
    // 会话级选型（旧文件无此二字段 → null = 未选，由 entry 回退默认，行为与改造前一致）
    modelId: parseModelTag(o.modelId),
    thinkingLevel: parseThinkingLevel(o.thinkingLevel),
    // 会话级工作区（旧文件无此字段 → null = 未指定）
    workspaceFolder: parseWorkspaceFolder(o.workspaceFolder),
    source,
    lifecycle,
    readAt: num(o.readAt),
    createdAt: num(o.createdAt),
    updatedAt: num(o.updatedAt),
    expiresAt: typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : null,
  };
}

// ==================== 读写原语 ====================

/** 每 threadId 一把串行锁：多请求并发改同一线程时避免互相覆盖。
 *  锁与原子写原语统一取自 `./fs-atomic`（2026-10-02 评审：此前 5 份副本各自演化）。 */
const withLock = createKeyedLock();

/** 原子写一个线程文件（先写 tmp 再 rename，避免并发读-改-写写出半截文件） */
export async function writeThreadFile(thread: ButlerThread): Promise<void> {
  await ensureDir(threadsDir());
  await atomicWriteFile(threadFilePath(thread.threadId), JSON.stringify(thread, null, 2));
}

/**
 * 读一条线程；文件不存在 / id 非法 / 解析失败 → null。
 * 已过期（wechat 24h）→ 删除文件并按 null 返回（与旧 loadChatSession「读到即删」同口径）。
 */
export async function readThread(threadId: string): Promise<ButlerThread | null> {
  if (!THREAD_ID_RE.test(threadId)) return null;
  await ensureMigrated();
  let raw: string;
  try {
    raw = await fs.readFile(threadFilePath(threadId), 'utf-8');
  } catch {
    return null;
  }
  const thread = parseThread(raw, threadId);
  if (!thread) return null;
  if (thread.expiresAt != null && thread.expiresAt <= Date.now()) {
    try {
      await fs.unlink(threadFilePath(threadId));
    } catch { /* 已被并发删掉 */ }
    return null;
  }
  return thread;
}

/**
 * 保存（upsert）线程：整轮覆盖写 messages，并自维护 tailTimes。
 *
 * tailTimes 与上一条落盘记录**对齐后**计算：新追加的消息记 now、被头部裁掉的历史不影响尾部对齐
 * （与旧 upsertChatSession 同算法，见 threads-shared.overlapLen）。
 *
 * **长期线程不可被降级**（notify 常驻 / panel 桌面长期保留都算）：已存在文件是这两种时沿用原 source。
 * 两个真实场景：① 用户在通知助理里追问一次，source 会被写成 panel，常驻语义（永不过期）就丢了；
 * ② 从微信（短期通道）对同一条桌面线程说一句，expiresAt 随之压成 24h —— 24 小时内没回桌面再聊，
 * 整条线程连同全部历史被 readThread 判过期删除。会话历史是不可再生数据，这里宁可不降级。
 *
 * `settings`（会话级选型）：**传了才覆盖**（本轮请求带的具体选择），不传则沿用文件里的旧值
 * ——微信桥这类不带选型的调用方不会把桌面选好的模型抹成「自动」。
 */
export async function upsertThread(
  threadId: string,
  messages: ChatMessage[],
  source: ButlerThreadSource,
  settings?: { modelId?: string | null; thinkingLevel?: ThinkingLevel | null },
): Promise<void> {
  if (!THREAD_ID_RE.test(threadId)) return;
  await ensureMigrated();
  await withLock(threadId, async () => {
    const now = Date.now();
    const prev = await readThreadRaw(threadId);
    const prevMessages = prev?.messages ?? [];
    const prevTail = prev?.tailTimes ?? [];
    const L = overlapLen(prevMessages.map(msgKey), messages.map(msgKey));
    const tail: number[] = new Array(messages.length);
    for (let i = 0; i < messages.length; i++) {
      const j = messages.length - 1 - i; // 该消息在 messages 中的正序下标
      if (j >= L) {
        tail[i] = now; // 重合段之后 = 本轮新增
        continue;
      }
      const t = prevTail[L - 1 - j];
      tail[i] = typeof t === 'number' ? t : now;
    }
    const prevSource = prev?.source;
    const longLived = prevSource === 'notify' || prevSource === 'panel';
    const effectiveSource: ButlerThreadSource = longLived ? (prevSource as ButlerThreadSource) : source;
    await writeThreadFile({
      threadId,
      messages,
      tailTimes: tail,
      persona: prev?.persona ?? null,
      modelId: settings ? parseModelTag(settings.modelId) : (prev?.modelId ?? null),
      thinkingLevel: settings ? parseThinkingLevel(settings.thinkingLevel) : (prev?.thinkingLevel ?? null),
      // 工作区**不由消息链路改动**（唯一写入口是 setThreadWorkspace）→ 一律沿用文件里的旧值
      workspaceFolder: prev?.workspaceFolder ?? null,
      source: effectiveSource,
      lifecycle: prev?.lifecycle ?? 'active',
      readAt: prev?.readAt ?? 0,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      expiresAt: threadExpiresAt(effectiveSource, now),
    });
  });
  // 可读记录：把消息按「消息当天」写入 <角色>/<日期>/chat/YYYY-MM-DD.md（幂等覆盖）。
  // 真源仍是本文件；落盘失败只留日志，不阻断线程保存。
  try {
    const thread = await readThreadRaw(threadId);
    if (thread) {
      const { writeSessionTranscript } = await import('./transcript');
      await writeSessionTranscript(threadId, thread.messages, thread.tailTimes);
    }
  } catch (e) {
    console.error('[butler/threads] 会话记录落盘失败:', e instanceof Error ? e.message : String(e));
  }
}

/**
 * 向已有线程**追加**若干条消息（不覆盖历史、不做重叠合并），供系统身份把「工具产出」补成一条对话落库。
 * 与 upsertThread 同锁、同裁剪（trimThreadMessages）、同 transcript 落盘口径；只是把「整轮覆盖」换成「尾部追加」。
 * 小微搜索助手用它把「用户提问 + 小微综述」补进 butler-search 常驻线程。
 */
export async function appendThreadMessages(
  threadId: string,
  newMsgs: ChatMessage[],
  source: ButlerThreadSource = 'panel',
): Promise<void> {
  if (!THREAD_ID_RE.test(threadId)) return;
  if (!newMsgs.length) return;
  await ensureMigrated();
  await withLock(threadId, async () => {
    const prev = await readThreadRaw(threadId);
    if (!prev) return; // 线程不存在（常驻线程应先 ensure）：跳过，不凭空建
    const now = Date.now();
    const messages = trimThreadMessages([...prev.messages, ...newMsgs]);
    const added = messages.length - prev.messages.length;
    const tail: number[] = new Array(messages.length);
    for (let i = 0; i < messages.length; i++) {
      const j = messages.length - 1 - i; // 尾部倒序对齐
      if (j < added) tail[i] = now; // 新增的 = 本轮
      else {
        const t = prev.tailTimes[prev.tailTimes.length - 1 - (prev.messages.length - 1 - j)];
        tail[i] = typeof t === 'number' ? t : now;
      }
    }
    const prevSource = prev.source;
    const longLived = prevSource === 'notify' || prevSource === 'panel';
    const effectiveSource: ButlerThreadSource = longLived ? (prevSource as ButlerThreadSource) : source;
    await writeThreadFile({
      ...prev,
      messages,
      tailTimes: tail,
      source: effectiveSource,
      updatedAt: now,
      expiresAt: threadExpiresAt(effectiveSource, now),
    });
  });
  try {
    const thread = await readThreadRaw(threadId);
    if (thread) {
      const { writeSessionTranscript } = await import('./transcript');
      await writeSessionTranscript(threadId, thread.messages, thread.tailTimes);
    }
  } catch (e) {
    console.error('[butler/threads] 会话记录落盘失败:', e instanceof Error ? e.message : String(e));
  }
}

/** 读原始文件（**不做过期判定**）：供 upsert 对齐使用。
 *  过期线程被 upsert 时应视作「无历史」而非触发删除——本轮新消息就是它的重生。 */
async function readThreadRaw(threadId: string): Promise<ButlerThread | null> {
  try {
    const raw = await fs.readFile(threadFilePath(threadId), 'utf-8');
    return parseThread(raw, threadId);
  } catch {
    return null;
  }
}

/**
 * 建一条**空线程**（messages=[]）并可选带上人设 —— 「新建会话」弹窗确认后调用。
 * 为什么不像发消息那样惰性建文件：有了人设弹窗，「建了助理」是一条**有意义的**记录，
 * 用户预期它立刻出现在联系人列并长期存在（哪怕一句没聊）。已存在则原样保留，不覆盖消息与人设。
 *
 * `settings`（会话级选型，可选）：新建时就把抽屉当前的模型 / 档位带上，用户不必为新助理再选一次。
 */
export async function createThread(
  threadId: string,
  persona: ButlerPersona | null,
  source: ButlerThreadSource = 'panel',
  settings?: { modelId?: string | null; thinkingLevel?: ThinkingLevel | null },
): Promise<void> {
  if (!THREAD_ID_RE.test(threadId)) return;
  await ensureMigrated();
  await withLock(threadId, async () => {
    if (await readThreadRaw(threadId)) return;
    const now = Date.now();
    await writeThreadFile({
      threadId,
      messages: [],
      tailTimes: [],
      persona,
      modelId: parseModelTag(settings?.modelId),
      thinkingLevel: parseThinkingLevel(settings?.thinkingLevel),
      // 新建会话不带工作区（用户选定后才由 setThreadWorkspace 落盘）
      workspaceFolder: null,
      source,
      lifecycle: 'active',
      // 刚建出来的空线程 = 已读过（没有任何消息），否则它一出现就自带未读
      readAt: now,
      createdAt: now,
      updatedAt: now,
      expiresAt: threadExpiresAt(source, now),
    });
  });
}

/**
 * 覆盖某条线程的人设（「人设」弹窗编辑态保存）。
 * **不动 updatedAt**：它是联系人列表的排序键，改个名字不该把线程顶到最前。
 */
export async function setThreadPersona(threadId: string, persona: ButlerPersona | null): Promise<void> {
  if (!THREAD_ID_RE.test(threadId)) return;
  await withLock(threadId, async () => {
    const thread = await readThreadRaw(threadId);
    if (!thread) return;
    await writeThreadFile({ ...thread, persona });
  });
}

/**
 * 覆盖某会话的模型 / 思考档位（抽屉选型器改动即落盘，不等下一条消息）。
 * 与 setThreadPersona 同口径：**不动 updatedAt** —— 换模型不该把会话顶到联系人列最前。
 * 传 null = 「未选」（模型回自动 / 档位回默认），不是「不改」。
 */
export async function setThreadModelSettings(
  threadId: string,
  modelId: string | null,
  thinkingLevel: ThinkingLevel | null,
): Promise<void> {
  if (!THREAD_ID_RE.test(threadId)) return;
  await withLock(threadId, async () => {
    const thread = await readThreadRaw(threadId);
    if (!thread) return;
    await writeThreadFile({
      ...thread,
      modelId: parseModelTag(modelId),
      thinkingLevel: parseThinkingLevel(thinkingLevel),
    });
  });
}

/**
 * 覆盖某会话的**工作区**（用户指定 · 锁定操作范围）；传 null = 清除。
 * 与 setThreadModelSettings 同口径：**不动 updatedAt** —— 换个工作区不该把会话顶到联系人列最前。
 * 这是工作区**唯一**的写入口：消息链路（upsertThread）只沿用旧值，不参与它的变更。
 */
export async function setThreadWorkspace(
  threadId: string,
  folder: ButlerWorkspaceFolder | null,
): Promise<void> {
  if (!THREAD_ID_RE.test(threadId)) return;
  await withLock(threadId, async () => {
    const thread = await readThreadRaw(threadId);
    if (!thread) return;
    await writeThreadFile({ ...thread, workspaceFolder: folder });
  });
}

/**
 * 标记该线程「已读到此刻」—— 未读角标清零的**唯一**出口。
 * 刻意不改 updatedAt：它是联系人列的排序键，置已读不该把线程顶到最前。
 */
export async function markThreadRead(threadId: string): Promise<void> {
  if (!THREAD_ID_RE.test(threadId)) return;
  await withLock(threadId, async () => {
    const thread = await readThreadRaw(threadId);
    if (!thread) return;
    await writeThreadFile({ ...thread, readAt: Date.now() });
  });
}

/** 列出全部未过期、未归档线程的摘要（按最近更新倒序） */
export async function listThreads(limit = 100): Promise<ButlerThreadSummary[]> {
  await ensureMigrated();
  let names: string[];
  try {
    names = await fs.readdir(threadsDir());
  } catch {
    return [];
  }
  const now = Date.now();
  const out: ButlerThreadSummary[] = [];
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : '';
    if (!id || !THREAD_ID_RE.test(id)) continue;
    const thread = await readThread(id); // 读到即删过期线程（与列表口径一致，避免僵尸项）
    if (!thread) continue;
    if (thread.lifecycle === 'archived') continue;
    if (thread.expiresAt != null && thread.expiresAt <= now) continue;
    out.push(summarizeThread(thread));
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}

/** 全部线程的未读消息总数（悬浮球角标用；与 listThreads 同源） */
export async function countUnreadThreads(limit = 200): Promise<number> {
  const threads = await listThreads(limit);
  return threads.reduce((sum, t) => sum + t.unread, 0);
}

/**
 * 跨会话搜**历史消息**（联系人列搜索栏的「聊天记录」结果）。
 *
 * 与 listThreads 同口径扫全部线程文件：跳过 system 行、跳过已归档 / 已过期线程；
 * 命中按**线程最近更新倒序**返回（与联系人列排序一致），线程内按消息时间倒序 ——
 * 前端拿到扁平数组后按 threadId 归组，嵌到对应联系人行下面。
 *
 * 只搜线程消息；通知回执（inbox 行）不在线程文件里，前端用已加载的 notices 现算。
 * 逐线程读文件与 listThreads 同成本，线程数有上限（limit），文本匹配为纯字符串包含，无需索引。
 */
export async function searchThreadMessages(query: string, limit = 100): Promise<ThreadMessageHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  await ensureMigrated();
  let names: string[];
  try {
    names = await fs.readdir(threadsDir());
  } catch {
    return [];
  }
  const now = Date.now();
  const groups: Array<{ threadUpdatedAt: number; hits: ThreadMessageHit[] }> = [];
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : '';
    if (!id || !THREAD_ID_RE.test(id)) continue;
    const thread = await readThread(id); // 读到即删过期线程，与列表口径一致
    if (!thread) continue;
    if (thread.lifecycle === 'archived') continue;
    if (thread.expiresAt != null && thread.expiresAt <= now) continue;
    const hits: ThreadMessageHit[] = [];
    for (let i = 0; i < thread.messages.length; i++) {
      const m = thread.messages[i];
      if (m.role === 'system' || !m.content) continue;
      // 剥掉  thinking 再匹配与回传：思考草稿不是「聊天记录」，露在结果里既脏又会误命中
      const text = stripThinkTags(m.content);
      if (!text || !text.toLowerCase().includes(q)) continue;
      hits.push({
        threadId: id,
        role: m.role === 'user' ? 'user' : 'assistant',
        content: text,
        time: messageTimeAt(thread.tailTimes, thread.messages.length, thread.updatedAt, i),
      });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => b.time - a.time); // 线程内：新的命中排前面
    groups.push({ threadUpdatedAt: thread.updatedAt, hits });
  }
  groups.sort((a, b) => b.threadUpdatedAt - a.threadUpdatedAt);
  const out: ThreadMessageHit[] = [];
  for (const g of groups) {
    for (const h of g.hits) {
      out.push(h);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 删除指定线程（联系人列删除 / 收件箱删除线程时调用） */
export async function deleteThread(threadId: string): Promise<void> {
  if (!THREAD_ID_RE.test(threadId)) return;
  try {
    await fs.unlink(threadFilePath(threadId));
  } catch { /* 不存在视作已删 */ }
}

/** 删除目标：`role + 正文`是**真身份**；`index` 只是「服务端下标」的提示（可能因头部裁剪而过时） */
export interface DeleteMessageTarget {
  role: string;
  content: string;
  index?: number;
}

/**
 * 删除线程里的若干条消息（中栏气泡 hover 操作条的「删除 / 多选删除」）。
 *
 * 为什么不复用 upsertThread：那是「整轮覆盖写」—— 会把 updatedAt 顶到 now（这条线程当场被
 * 顶到联系人列最前）、还会用 overlapLen 重算 tailTimes。删一条消息属于**就地编辑**，
 * 这两个副作用都不该有：删掉一条不该让线程看起来「刚更新过」。
 *
 * **身份按正文认，不按下标认**：线程会被裁头（trimThreadMessages 只留最近 N 轮），
 * 一旦裁过，前端手里那批「服务端下标」就整体偏大 —— 直接照着删会**删掉另一条消息**。
 * 所以下标只当提示先验一次（role + 正文都对得上才用），对不上就退回按正文找第一条还没被删的。
 * 代价：两条**逐字相同**的消息无法区分（点哪条都删前面那条）—— 删完两边剩下的内容一模一样，故接受。
 *
 * messages 与 tailTimes 必须按同一组下标**同步**过滤：tailTimes 尾部倒序对齐 messages，
 * 只删一边会让剩下所有消息的时间戳整体错位、时间线排序全乱。
 * system 行一律不删：前端本来就读不到它（GET 会滤掉），误删会伤到每轮重注入的 prompt。
 */
export async function deleteThreadMessages(threadId: string, targets: DeleteMessageTarget[]): Promise<number> {
  if (targets.length === 0 || !THREAD_ID_RE.test(threadId)) return 0;
  return withLock(threadId, async () => {
    const thread = await readThreadRaw(threadId);
    if (!thread) return 0;
    const msgs = thread.messages;
    const len = msgs.length;
    /** 比对用的归一化：气泡里的正文是剥过 think 的，库里存的是模型原话（含 think） */
    const norm = (s: string): string => stripThinkTags(s).trim();
    const key = (role: string, content: string): string => `${role}\u0000${norm(content)}`;
    const byContent = new Map<string, number[]>();
    for (let i = 0; i < len; i++) {
      const m = msgs[i];
      if (m.role === 'system') continue;
      const k = key(m.role, m.content);
      const list = byContent.get(k);
      if (list) list.push(i);
      else byContent.set(k, [i]);
    }
    const drop = new Set<number>();
    for (const t of targets) {
      const k = key(t.role, t.content);
      const i = t.index;
      // ① 下标提示先验：range 内 + 没被删过 + role 与正文都对得上 → 就是这一条（重复正文时能认准）
      if (
        typeof i === 'number' &&
        Number.isInteger(i) &&
        i >= 0 &&
        i < len &&
        !drop.has(i) &&
        msgs[i].role !== 'system' &&
        key(msgs[i].role, msgs[i].content) === k
      ) {
        drop.add(i);
        continue;
      }
      // ② 下标过时（裁过头）或本来就没有（本地刚发的气泡）→ 按正文认领第一条还没被删的
      const hit = byContent.get(k)?.find((x) => !drop.has(x));
      if (hit !== undefined) drop.add(hit);
    }
    if (drop.size === 0) return 0;
    const nextMsgs = msgs.filter((_, i) => !drop.has(i));
    const nextTail = thread.tailTimes.filter((_, k) => !drop.has(len - 1 - k));
    await writeThreadFile({ ...thread, messages: nextMsgs, tailTimes: nextTail });
    return drop.size;
  });
}

/** 清理全部已过期线程（wechat 24h），返回删除条数。
 *  顺带两件事：
 *   - 回收 `roles.json` 的孤儿条目（评审 P2-⑯）：线程被删后注册表只增不删，
 *     实测 10 条角色 vs 3 个活线程。清条目**不动角色目录**（附件/文档仍在）。
 *   - 清掉原子写的 tmp 残骸（评审 P2-⑮）：旧实现失败后会把 `${file}.<pid>.<ts>.tmp` 留在数据目录
 *     （实测 4 个、两个各约 150KB）。只删 1 小时前的，避免误删进行中的写入。 */
export async function sweepThreads(): Promise<{ deleted: number }> {
  let names: string[];
  try {
    names = await fs.readdir(threadsDir());
  } catch {
    return { deleted: 0 };
  }
  const now = Date.now();
  let deleted = 0;
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : '';
    if (!id || !THREAD_ID_RE.test(id)) continue;
    const thread = await readThreadRaw(id);
    if (!thread) continue;
    if (thread.expiresAt != null && thread.expiresAt <= now) {
      await deleteThread(id);
      deleted++;
    }
  }
  // tmp 残骸清扫（1 小时前的才算残骸）
  const staleBefore = now - 60 * 60 * 1000;
  for (const n of names) {
    if (!n.endsWith('.tmp')) continue;
    const p = join(threadsDir(), n);
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs < staleBefore) await fs.unlink(p);
    } catch { /* 已被并发清掉 / 权限问题：跳过 */ }
  }
  try {
    const pruned = await pruneOrphanRoles();
    if (pruned.length > 0) console.log(`[butler/threads] 已回收角色注册表孤儿条目 ${pruned.length} 条`);
  } catch (e) {
    console.warn('[butler/threads] 角色注册表回收失败:', e instanceof Error ? e.message : String(e));
  }
  return { deleted };
}

/** 周期清理间隔：每分钟删除过期线程（wechat 24h TTL） */
const SWEEP_INTERVAL_MS = 60 * 1000;

type SweeperGlobal = { __bobworkButlerThreadSweeperStarted?: boolean };
const sweeperGlobal = globalThis as unknown as SweeperGlobal;

/**
 * 启动周期清理器（instrumentation 启动时调用）：每 60s 删除过期线程。
 * dev 模式 HMR 重复注册由全局标记防抖。
 */
export function startThreadSweeper(): void {
  if (sweeperGlobal.__bobworkButlerThreadSweeperStarted) return;
  sweeperGlobal.__bobworkButlerThreadSweeperStarted = true;
  // 启动先跑一次：清理上次关闭应用后已过期的残留线程
  sweepThreads().catch((e) => {
    console.warn('[butler/threads] 启动清理失败:', e instanceof Error ? e.message : String(e));
  });
  const timer = setInterval(() => {
    sweepThreads().catch((e) => {
      console.warn('[butler/threads] 周期清理失败:', e instanceof Error ? e.message : String(e));
    });
  }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** 退役清理：删除旧的「Bobby」微信桥常驻线程（2026-09-28 起微信入站消息改落通知助理线程）。幂等。 */
export async function purgeRetiredWechatThread(): Promise<boolean> {
  const file = threadFilePath('butler-wechat');
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}