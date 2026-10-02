/**
 * lib/butler/threads-shared.ts —— Butler 线程的**纯类型与纯函数**（无任何 Node 依赖）
 *
 * 为什么独立成文件：与 rules-shared.ts 同因 —— 线程列表摘要要在客户端（ButlerDrawer 联系人列）
 * 展示，而 threads.ts 含 fs 读写，客户端链路无法 bundle。故把类型与纯函数抽到这里，
 * 服务端（threads.ts 转出）与客户端共用同一份定义，避免两处漂移。
 *
 * 语义边界（Phase 4 §二）：**Threads = Butler 的「会话身体」**（转录 + 生命周期），
 * 是**状态**不是能力，与 Memories（`butler/preferences.md`）/ Rules（`.rules/`）/ Skills（`.skills/`）
 * 并列而不混用 —— Threads 不是「第四层记忆」，它是上面三层组合**发生的地方**（上下文载体）。
 *
 * 真源：`<APP_ROOT>/butler/.state/threads/<threadId>.json`（读写见 threads.ts）。
 */
import { stripThinkTags, type ChatMessage } from '@/lib/bus';
import type { ThinkingLevel } from '@/lib/types';

export type { ChatMessage };

/** 微信桥线程 TTL：24 小时（panel / notify 线程为长期保留，expiresAt = null） */
export const WECHAT_THREAD_TTL_MS = 24 * 60 * 60 * 1000;

/** 线程来源：panel = 桌面抽屉（长期）；wechat = 微信桥（24h 过期）；notify = 常驻通知助理（长期） */
export type ButlerThreadSource = 'panel' | 'wechat' | 'notify';

/** 线程生命周期（Butler 自有）：active 在用 / archived 归档（归档不进列表、不参与未读） */
export type ButlerThreadLifecycle = 'active' | 'archived';

/** 新线程 id 前缀（迁移进来的历史 id 原样保留，不改写） */
export const BUTLER_THREAD_ID_PREFIX = 'b-';

/** 线程保留最近 N 轮（= 2*N 条 user/assistant）；超出裁剪最早对话对 */
export const THREAD_MAX_ROUNDS = 20;

/**
 * 会话级人设（角色卡裁剪版）。字段与既有 ChatPersona 同构，仅归属改为 Butler 线程文件。
 * NOT NULL 的只有 name —— 其余缺省 = 不注入该维度，行为与「没有专属人设」完全一致。
 */
export interface ButlerPersona {
  /** 助理姓名 —— 同时作为联系人行 / 中栏工具行的标题 */
  name: string;
  /** 性格 / 语气（如「傲娇但心软」） */
  personality?: string;
  /** 身份 / 职责边界（如「只聊法律问题」） */
  role?: string;
  /** 说话风格（如「简短、少用敬语」） */
  style?: string;
  /** 如何称呼用户（如「老板」） */
  addressUser?: string;
  /** 来自哪个预设模板（如 'tsundere'），仅作溯源展示 */
  template?: string;
}

/**
 * 会话级**工作区**（用户显式指定的操作范围）：一个目录 = 一条会话的工作区。
 * 与画布「操作目录」的锁定版同义（useComposer.buildFolderBlock 的 sent-folder 语义），
 * 但**常驻**：选定后每轮对话都随消息注入「锁定操作范围」，发送后不清、切联系人各自保留。
 */
export interface ButlerWorkspaceFolder {
  /** 绝对路径（读写都基于它；非绝对路径一律视为无效 → 清空） */
  path: string;
  /** 展示名（默认取路径最后一节）。pill 超长时前端截断，悬停给全名 + 路径 */
  name: string;
}

/** 一条 Butler 线程（= 一个文件；结构对应 `.state/threads/<threadId>.json`） */
export interface ButlerThread {
  threadId: string;
  /** 完整对话消息（含历史 user/assistant + 待答 user；system 由 /api/chat 每轮重注入，不入库） */
  messages: ChatMessage[];
  /**
   * 逐条消息时间戳，**从尾部倒序对齐 messages**：索引 i ↔ messages[length-1-i]。
   * 由 writeThread 自维护（新增消息 = now）。旧文件缺字段/长度不足 → 用 messageTimeAt 退化为 updatedAt。
   */
  tailTimes: number[];
  persona: ButlerPersona | null;
  /**
   * 本会话选用的模型（`provider:modelId` 标签）。null / 缺省 = 未选 → entry 解析
   * 「第一个已配置厂商的对话模型」（历史行为），或按请求另传。
   */
  modelId?: string | null;
  /**
   * 本会话的思考档位。null / 缺省 = 未选 → 沿用历史默认（medium，语义同 high）。
   * 与模型同属**会话级选型**（一个联系人一套），随线程文件一起存活 / 删除。
   */
  thinkingLevel?: ThinkingLevel | null;
  /**
   * 本会话的**工作区**（用户指定 · 锁定操作范围）。null / 缺省 = 未指定。
   * 与选型同为**会话级**（一个联系人一套），随线程文件存活 / 删除；发送消息**不清除**。
   */
  workspaceFolder?: ButlerWorkspaceFolder | null;
  source: ButlerThreadSource;
  lifecycle: ButlerThreadLifecycle;
  /** 最近已读时刻（ms）；0 / 缺字段 = 从未读过 → 未读数按全部 assistant 消息算 */
  readAt: number;
  createdAt: number;
  updatedAt: number;
  /** 过期时间戳；null = 长期保留（panel / notify） */
  expiresAt: number | null;
}

/**
 * 线程列表项（Butler 抽屉联系人列用）。
 * **只带摘要、不带 messages 全文**：单条历史可达 20KB+，一次推给前端会让打开抽屉明显卡顿；
 * 全文由 GET ?threadId= 按需单独取。
 */
export interface ButlerThreadSummary {
  threadId: string;
  source: ButlerThreadSource;
  lifecycle: ButlerThreadLifecycle;
  createdAt: number;
  updatedAt: number;
  /** 有效消息条数（不含 system） */
  messageCount: number;
  /** 列表标题：人设姓名 > 首条 user 消息单行截断；都无则 'New chat' */
  title: string;
  /** 列表副标题：最后一条 assistant 回复截断（已剥 think）；无回复时退化为性格描述 */
  preview: string;
  persona: ButlerPersona | null;
  /** 置顶（常驻联系人 = true）：联系人列永远排在最前且不渲染删除键 */
  pinned?: boolean;
  /** 未读消息数：readAt 之后到达的 assistant 消息条数（自己发的不算未读） */
  unread: number;
  /** 常驻身份标记：'notify' = Bobby（通知助理）；'recorder' = Recorder（会议记录员）；'search' = 小微（搜索助手）。普通线程无此字段 */
  systemRole?: 'notify' | 'recorder' | 'search';
  /**
   * 该会话的**常驻工作区**（2026-10-02 补：Memory 台的 Threads 段要显示它）。
   * 真源是线程文件的 `workspaceFolder`（见 `parseWorkspaceFolder`：非绝对路径一律归一为 null）；
   * 与联系人列一样**只带路径与展示名**，不复制内容。
   */
  workspaceFolder?: ButlerWorkspaceFolder | null;
}

/**
 * 跨会话搜索的一条命中（联系人列搜索栏的「聊天记录」结果）。
 * 只带**消息**本体；会话标题/头像由前端从联系人列表取（同一 threadId），此处不回传以免口径分叉。
 * 放在 pure 模块：前端直接 `import type`，不触 fs。
 */
export interface ThreadMessageHit {
  threadId: string;
  role: 'user' | 'assistant';
  /** 命中消息正文（不截断：截断与高亮交给前端按关键词取上下文片段） */
  content: string;
  /** 命中消息时间戳（ms） */
  time: number;
}

// ==================== 纯函数（客户端亦可复用，无 fs） ====================

/** 计算过期时间：wechat = now + 24h；panel / notify = 长期（null） */
export function threadExpiresAt(source: ButlerThreadSource, now: number = Date.now()): number | null {
  return source === 'wechat' ? now + WECHAT_THREAD_TTL_MS : null;
}

/** 解析 persona（坏数据 / 非对象 / 无 name 一律当作「无人设」，不让脏数据进模型上下文） */
export function parsePersona(raw: unknown): ButlerPersona | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const pick = (k: string): string | undefined => {
    const s = typeof o[k] === 'string' ? (o[k] as string).trim() : '';
    return s || undefined;
  };
  const name = typeof o.name === 'string' ? (o.name as string).trim() : '';
  if (!name) return null;
  return {
    name,
    personality: pick('personality'),
    role: pick('role'),
    style: pick('style'),
    addressUser: pick('addressUser'),
    template: pick('template'),
  };
}

/** 消息指纹：内容逐字相同才算同一条（对齐裁剪窗口用） */
export function msgKey(m: ChatMessage): string {
  return `${m.role}\u0000${m.content}`;
}

// ---------- 会话级选型（模型 / 思考档位）的清洗 ----------

/** 合法思考档位（含 legacy medium：存量线程可能存着旧三档的中档值） */
const THINKING_LEVEL_VALUES: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

/** 模型标签（`provider:modelId`）长度上限：超出视为脏数据，按「未选」处理 */
export const MODEL_TAG_MAX = 128;

/**
 * 清洗思考档位（线程文件读取 / 请求体共用）：非法值一律 → null = 「未选」，
 * 交给调用方回退默认档，不让脏字符串流进 /api/chat。
 */
export function parseThinkingLevel(raw: unknown): ThinkingLevel | null {
  return typeof raw === 'string' && (THINKING_LEVEL_VALUES as readonly string[]).includes(raw)
    ? (raw as ThinkingLevel)
    : null;
}

/** 清洗模型标签：非空字符串且不超长才认；null / '' / 超长 → null（= 自动选型） */
export function parseModelTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s && s.length <= MODEL_TAG_MAX ? s : null;
}

/** 工作区路径长度上限：超长视为脏数据（正常路径远短于此），按「未指定」处理 */
export const WORKSPACE_PATH_MAX = 1024;

/**
 * 清洗会话级工作区：必须是 `{ path: 绝对路径 }`，否则 → null（= 未指定）。
 * name 缺省由 path 末节兜底 —— pill 要显示名字，缺了不该整个工作区失效。
 */
export function parseWorkspaceFolder(raw: unknown): ButlerWorkspaceFolder | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const path = typeof o.path === 'string' ? o.path.trim() : '';
  if (!path || !path.startsWith('/') || path.length > WORKSPACE_PATH_MAX) return null;
  const rawName = typeof o.name === 'string' ? o.name.trim() : '';
  const name = (rawName || path.split('/').filter(Boolean).pop() || path).slice(0, 120);
  return { path, name };
}

/**
 * 注入块起始标记：客户端拼在**用户正文尾部**、只给模型看的上下文（附件列表 / 会话级工作区）。
 * 集中定义是为了让「拼接」与「剥离」同源——两边各写字面量，改标记时必然漏改另一处。
 */
export const ATTACHMENTS_BLOCK_HEAD = '\n\n--- Attachments ---';
export const WORKSPACE_BLOCK_HEAD = '\n\n--- 工作区（用户指定 · 锁定操作范围） ---';
export const INJECTED_BLOCK_HEADS: readonly string[] = [ATTACHMENTS_BLOCK_HEAD, WORKSPACE_BLOCK_HEAD];

/**
 * 剥掉正文尾部的注入块（**只用于展示 / 可读记录**，不要在发给模型的正文上调用）。
 *
 * 为什么需要：块随正文一起发给服务端，服务端存的就是整段原文 —— 重新打开会话会连块一起读回，
 * 用户气泡与 `butler/<角色>/<日期>/chat/*.md` 里就会冒出「--- 工作区 … ---」这种机器文案；
 * 而刚发出去那条气泡用的是**干净原文**，两条路径显示不一致。
 * 模型侧不受影响：块由客户端**每轮重新注入**，历史里有没有都不缺上下文。
 *
 * 按**首个**命中标记截断（块恒追加在尾部）；调用方只在 user 消息上用它。
 */
export function stripInjectedBlocks(content: string): string {
  let cut = -1;
  for (const head of INJECTED_BLOCK_HEADS) {
    const i = content.indexOf(head);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  return cut >= 0 ? content.slice(0, cut).trimEnd() : content;
}

/**
 * 对齐新旧消息列表的重合长度 L：新列表 = 旧列表尾部 L 条（只从头部裁剪）+ 尾部新增。
 * 为什么不能只比长度差：线程到达上限后（trimThreadMessages 会「裁头 + 追加」同量条数），
 * 新旧长度相等而实际新增了消息 —— 只按长度差会把这轮新消息的时间戳沿用成旧的。
 */
export function overlapLen(prev: string[], next: string[]): number {
  const max = Math.min(prev.length, next.length);
  for (let l = max; l > 0; l--) {
    let ok = true;
    for (let i = 0; i < l; i++) {
      if (prev[prev.length - l + i] !== next[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return l;
  }
  return 0;
}

/**
 * 取某条消息的时间戳（index 为 messages 正序下标）。
 * 缺字段 / 长度不足（老数据）→ 退化为线程 updatedAt，不返回 0 把时间线排到最前。
 */
export function messageTimeAt(tailTimes: number[], messageCount: number, updatedAt: number, index: number): number {
  const t = tailTimes[messageCount - 1 - index];
  return typeof t === 'number' ? t : updatedAt;
}

/**
 * 未读消息数（纯函数，便于单测）：`readAt` 之后到达的 **assistant** 消息条数。
 *
 * 为什么只算 assistant：user 消息是你自己发出去的，把「自己刚说的话」算成未读，
 * 会让角标在你发完消息的瞬间自增一次、再被置已读清零 —— 纯噪声。
 * 时间戳缺失/长度不足时退化为 `updatedAt`（与 messageTimeAt 同口径）。
 */
export function countUnreadAssistant(
  messages: ChatMessage[],
  tailTimes: number[],
  readAt: number,
  updatedAt: number,
): number {
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'assistant') continue;
    const t = tailTimes[messages.length - 1 - i];
    const at = typeof t === 'number' ? t : updatedAt;
    if (at > readAt) n++;
  }
  return n;
}

/**
 * 裁剪 messages：保留 system + 最近 THREAD_MAX_ROUNDS 轮 user/assistant 对。
 * 超出时丢弃最旧的 user+assistant 对（保证 system prompt 始终存在）。
 */
export function trimThreadMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const sys = messages[0]?.role === 'system' ? messages[0] : null;
  const rest = sys ? messages.slice(1) : messages;
  // rest 按 [user, assistant, user, assistant, ...] 交替，最后一个可能是 user（待提问时）
  const maxPairs = THREAD_MAX_ROUNDS * 2;
  // 如果最后是单个 user（还没有 assistant 回答），裁剪时也要保留它（因此保留最右奇数条）
  let trimmed = rest;
  if (trimmed.length > maxPairs) {
    const overflow = trimmed.length - maxPairs;
    // 向偶数对齐向下切：overflow 如果是奇数，多删 1 条让剩余开头是 user
    const sliceStart = (overflow % 2) === 0 ? overflow : overflow + 1;
    trimmed = trimmed.slice(sliceStart);
    // 兜底：如果 slice 后开头是 assistant（前一个 user 被切掉了），再前进一步
    if (trimmed[0]?.role === 'assistant') {
      trimmed = trimmed.slice(1);
    }
  }
  return sys ? [sys, ...trimmed] : trimmed;
}

/** 列表标题 / 摘要的单行截断上限（多行文本会把列表项撑破） */
export const TITLE_MAX = 42;
export const PREVIEW_MAX = 64;

/** 压成单行 + 截断（列表标题与摘要共用） */
export function condense(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 由一条线程派生列表摘要（纯函数）。
 * 标题**不做模型生成**（避免每个线程多一轮 API）：取首条 user 消息截断，零成本、即时可用。
 */
export function summarizeThread(thread: ButlerThread): ButlerThreadSummary {
  // system 是旧版落库残留（写入端已剥离），一律不计入线程内容与条数
  const messages = thread.messages.filter((m) => m.role !== 'system');
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  return {
    threadId: thread.threadId,
    source: thread.source,
    lifecycle: thread.lifecycle,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: messages.length,
    // 有专属人设时以「姓名」作标题（用户是按助理名字认人的），否则退回首条提问截断
    title: thread.persona?.name ?? (firstUser ? condense(firstUser.content, TITLE_MAX) : 'New chat'),
    // 还没聊过时副标题退化为人设描述，否则空线程在列表里只剩一个名字、看不出它是谁
    preview: lastAssistant
      ? condense(stripThinkTags(lastAssistant.content), PREVIEW_MAX)
      : condense(thread.persona?.personality ?? '', PREVIEW_MAX),
    persona: thread.persona,
    // readAt 为 0 按「一律未读」：若退化成 updatedAt，那条「读过之后才落的回复」会被随 updatedAt 一起前移，永远判不出未读
    unread: countUnreadAssistant(messages, thread.tailTimes, thread.readAt ?? 0, thread.updatedAt),
    // 常驻工作区（Memory 台 Threads 段要显示；只带路径，不复制内容）
    workspaceFolder: thread.workspaceFolder ?? null,
  };
}