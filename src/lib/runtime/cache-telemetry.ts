/**
 * cache-telemetry.ts —— 前缀缓存 per-call 遥测（2026-10-02 新增）
 *
 * 背景：现有遥测只有两处，都不足以自动归因——
 *   ① usage_log（任务级）：只有整任务的 hit/miss 合计，不知道 miss 落在第几次调用；
 *   ② cacheguard.jsonl（工具段漂移）：只有"工具段变了"，没有与之对齐的 hit/miss。
 * 于是每次复盘都要按时间窗口把两套日志 join 起来（2026-10-02 缓存审计就是这么做的），
 * 且"漂移造成的重复全价读"与"新内容必然的首次读入"无法在数据层面区分。
 *
 * 本模块按**每次 LLM 调用**落一条记录到 <appRoot>/.logs/cache-telemetry.jsonl：
 *   - 本次调用的 prompt / completion / cacheHit / cacheMiss 与任务累计；
 *   - system / tools / history 三段前缀指纹，以及 tools 是否变化、history 是否被改写
 *     （非追加式变化 = 前缀必然从该点起失效，这是与"工具段漂移"并列的第二类可归因浪费）；
 *   - 上下文规模与工具段字节数，供离线算"每次全价读的固定开销"。
 *
 * 设计约束（与 cacheguard 落盘同姿态）：
 *   - 纯旁路：任何异常都在内部吞掉，绝不阻断或影响工具循环；
 *   - 增量为 O(增量)：history 指纹用前缀链增量推进，不为每条消息重算整段；
 *   - 文件超阈值滚动一代（.1），避免无界增长。
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';

/** 落盘文件名（与 cacheguard.jsonl 同目录） */
const TELEMETRY_FILE = 'cache-telemetry.jsonl';
/** 单文件上限，超过则滚动为 <file>.1（只留一代） */
const MAX_TELEMETRY_BYTES = 8 * 1024 * 1024;

/** 参与指纹计算的最小消息结构（与 route 的 ChatMessage 结构兼容，避免反向依赖） */
export interface PrefixMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
}

/** 单次调用的三段前缀指纹与漂移判定 */
export interface CallPrefixSnapshot {
  /** system 段指纹（缓存头；同一任务内应恒定） */
  systemHash: string;
  /** tools 段指纹（按真实发送顺序逐字节哈希） */
  toolsHash: string;
  /** tools 段字节数 */
  toolsBytes: number;
  /** 工具条数 */
  toolCount: number;
  /** 工具段相对上一次调用是否变化（首次调用恒 false，避免噪声） */
  toolsChanged: boolean;
  /** history 段指纹（除 system 与最后一条之外的全部消息） */
  historyHash: string;
  /** history 段参与指纹的消息条数 */
  historyCount: number;
  /** 上次发送的 history 前缀是否被改写或变短（非追加式变化 → 该点之后全部作废）。
   *  覆盖：R-14 裁剪、压缩折叠游标跳过、附件桥接回写历史中段、画像切换。 */
  historyRewritten: boolean;
  /** 上一次调用时那条「本轮输入」（末条消息）如今已进入历史，其字节是否被改写。
   *  这一条专抓「当前轮 user 块（@资料/@引用/链接/操作目录）未被持久化，
   *  下一轮同一位置变回裸文本」——单轮任务里它就是唯一能发现该漂移的信号。 */
  lastTurnRewritten: boolean;
  /** 本条 payload 的最后一条 user 消息是否携带引用块标记（@资料 / 本地文件 / 链接 / 操作目录）。
   *  用于离线回答「historyRewritten 是否集中在带 @引用的轮次」——这是 P1-A 值不值得修的关键判据。 */
  lastUserRefBlocks: boolean;
}

/** 引用块标记（与 ChatNodeKernel 拼进 effectiveContent 的块标题逐字对齐） */
const REF_BLOCK_MARKERS = ['--- 资料列表 ---', '--- 引用本地文件 ---', '--- 链接材料 ---', '--- 操作目录 ---'];

/** 消息内容喂给哈希（长度前缀 + 分隔符，避免歧义且不拼大 JSON 字符串）。
 *  content 非字符串（直连多模态数组）时退化为 JSON 字符串，保证指纹随字节变化而变化。 */
function updateHashWithMessage(hash: ReturnType<typeof createHash>, m: PrefixMessage): void {
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls) : '';
  hash
    .update(m.role).update('|')
    .update(String(content.length)).update('|').update(content).update('|')
    .update(String(toolCalls.length)).update('|').update(toolCalls)
    .update('\x00');
}

function hashText(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/**
 * 调用级前缀指纹跟踪器：**每个会话（nodeId）一个实例、跨任务复用**（见 getSessionTracker）——
 * "上一任务最后一次发送的前缀"要能作为下一任务首调的比对基准，而跨任务边界正是
 * 「客户端重放历史与上次实际发送不一致」（@资料块丢失 / 压缩游标跳过 / R-14 裁剪）
 * 唯一可被观测到的地方。任务内则自然退化为逐轮比对。
 * 用法：每轮发送前 `tracker.describe(payloadMessages, toolDefs)`，把返回值随 usage 一起落盘。
 */
export class CallPrefixTracker {
  private lastToolDefs: unknown[] | null = null;
  private prevToolsHash = '';
  private prevHistoryHash = '';
  private prevHistoryCount = 0;
  /** 上一次调用时「本轮输入」（末条消息）的下标与指纹：下一次调用它已进入历史，重算即可判改写 */
  private prevLastIndex = -1;
  private prevLastHash = '';
  private toolsHash = '';
  private toolsBytes = 0;
  private toolCount = 0;

  /** 采集本轮三段指纹（不修改入参）
   *
   *  history 段走**全量一次遍历**而非纯增量链：要发现"中间某条历史被改写"（例如当前轮
   *  user 块的 replay 不一致、附件桥接回写历史中段），就必须重新读到那条消息的字节——
   *  纯增量链在消息追加后不再回看，会漏报这类漂移。代价是每次调用 O(消息数) 的哈希更新
   *  （最坏 185k token ≈ 500KB，毫秒级），相对一次 LLM 调用可忽略，换来的是漂移零漏报。 */
  describe(messages: PrefixMessage[], toolDefs: unknown[]): CallPrefixSnapshot {
    // ① history 段：除 system 与最后一条（本轮输入，每次必然不同）之外的全部消息。
    //    两个哈希并行推进：allHash = 当前全量；prevHash = 上一次发送时那一段的字节（改写检测基准）。
    const lastIndex = messages.length - 1;
    const allHash = createHash('sha256');
    const prevHash = this.prevHistoryCount > 0 ? createHash('sha256') : null;
    let historyCount = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || m.role === 'system' || i === lastIndex) continue;
      updateHashWithMessage(allHash, m);
      if (prevHash && historyCount < this.prevHistoryCount) updateHashWithMessage(prevHash, m);
      historyCount++;
    }
    const historyHash = historyCount > 0 ? allHash.digest('hex').slice(0, 12) : '';
    // 前缀失效判定：
    //   - 历史变短（R-14 裁剪 / 压缩折叠）→ 前缀必然从头断裂；
    //   - 上一次发送的那一段字节如今重算出不同指纹 → 中间被改写。
    //   首次调用（prevHistoryCount=0）无基准，恒 false，避免噪声。
    const historyRewritten = prevHash
      ? historyCount < this.prevHistoryCount ||
        prevHash.digest('hex').slice(0, 12) !== this.prevHistoryHash
      : false;

    // ①b 上一次的「本轮输入」如今已进入历史：重算它的指纹，变了就是改写。
    //     上一轮它是末条、被排除在 history 之外，所以只有这一条能抓到它
    //     （单轮任务里的 @资料块丢失就是这种形态）。
    const prevMsg = this.prevLastIndex >= 0 && this.prevLastIndex < lastIndex ? messages[this.prevLastIndex] : null;
    const lastTurnRewritten = !!prevMsg && this.prevLastHash !== '' && fingerprintOne(prevMsg) !== this.prevLastHash;

    // ② tools 段：仅在数组引用变化时重算（任务内重建工具集才换引用）
    if (toolDefs !== this.lastToolDefs) {
      const json = JSON.stringify(toolDefs ?? []);
      this.toolsHash = hashText(json);
      this.toolsBytes = Buffer.byteLength(json);
      this.toolCount = Array.isArray(toolDefs) ? toolDefs.length : 0;
      this.lastToolDefs = toolDefs;
    }

    // ③ system 段（缓存头；同一任务内应恒定）
    const systemContent = messages.find((m) => m?.role === 'system')?.content;
    const systemHash = hashText(typeof systemContent === 'string' ? systemContent : '');
    const toolsChanged = this.prevToolsHash !== '' && this.toolsHash !== this.prevToolsHash;

    // ④ 本轮输入是否带 @引用块（供离线回答「漂移是否集中在带 @引用的轮次」）
    const lastContent = messages[lastIndex]?.content;
    const lastUserRefBlocks =
      typeof lastContent === 'string' && REF_BLOCK_MARKERS.some((marker) => lastContent.includes(marker));

    this.prevHistoryCount = historyCount;
    this.prevHistoryHash = historyHash;
    this.prevToolsHash = this.toolsHash;
    this.prevLastIndex = lastIndex;
    this.prevLastHash = lastIndex >= 0 && messages[lastIndex] ? fingerprintOne(messages[lastIndex]) : '';

    return {
      systemHash,
      toolsHash: this.toolsHash,
      toolsBytes: this.toolsBytes,
      toolCount: this.toolCount,
      toolsChanged,
      historyHash,
      historyCount,
      historyRewritten,
      lastTurnRewritten,
      lastUserRefBlocks,
    };
  }
}

/** 单条消息指纹（用于「上一轮输入是否被改写」的定点比对） */
function fingerprintOne(m: PrefixMessage): string {
  const h = createHash('sha256');
  updateHashWithMessage(h, m);
  return h.digest('hex').slice(0, 12);
}

/** 会话级跟踪器表（nodeId → tracker）：跨任务复用，LRU 上限避免无界增长 */
const sessionTrackers = new Map<string, CallPrefixTracker>();
const MAX_SESSION_TRACKERS = 200;

/** 取某会话的跟踪器（跨任务保留"上一次发送"基准；无 nodeId 的调用方传一次性 key 即可） */
export function getSessionTracker(key: string): CallPrefixTracker {
  const existing = sessionTrackers.get(key);
  if (existing) {
    // 刷新 LRU 位置（Map 对已存在键 set 不改变插入序）
    sessionTrackers.delete(key);
    sessionTrackers.set(key, existing);
    return existing;
  }
  const created = new CallPrefixTracker();
  sessionTrackers.set(key, created);
  while (sessionTrackers.size > MAX_SESSION_TRACKERS) {
    const oldest = sessionTrackers.keys().next();
    if (oldest.done) break;
    sessionTrackers.delete(oldest.value);
  }
  return created;
}

/** 落盘记录（一次 LLM 调用一行） */
export interface CacheCallRecord extends CallPrefixSnapshot {
  taskId: string;
  nodeId?: string;
  agent?: string;
  model?: string;
  /** 本任务内的调用序号（1 起） */
  callIdx: number;
  /** 本次调用的真实 token */
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** 本任务累计（与 usage_log 同口径） */
  cumPromptTokens: number;
  cumCacheHitTokens: number;
  cumCacheMissTokens: number;
  /** 发送体字符数（估算上下文规模；chars/2.5 的口径见 estimateContextBreakdown） */
  payloadChars: number;
  /** 本轮消息条数 */
  messageCount: number;
}

/**
 * 追加一条 per-call 遥测（旁路：任何失败都吞掉，绝不影响主链路）。
 * 文件超过阈值时滚动为 <file>.1（只保留一代）。
 */
export function recordCacheCall(rec: CacheCallRecord): void {
  try {
    const dir = join(resolveAppRoot(), '.logs');
    const file = join(dir, TELEMETRY_FILE);
    mkdirSync(dir, { recursive: true });
    try {
      if (statSync(file).size > MAX_TELEMETRY_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // 文件不存在（首次写入）→ 直接 append
    }
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n', 'utf-8');
  } catch {
    // 遥测失败绝不影响工具循环主链路
  }
}
