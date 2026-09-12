/**
 * 轻量类型安全事件总线（Step 2）
 *
 * 仅用于"动作类"一次性事件（如 file.open、add-attachment-to-node）。
 * 状态类同步（textSelection / stickyNotes 等）后续随 Step 3 迁移到 store，不经过总线。
 */

type Listener<T> = (payload: T) => void;

class TypedBus {
  private handlers = new Map<string, Set<Listener<unknown>>>();

  publish<T>(event: string, payload: T): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // 拷贝后遍历，允许订阅者在回调中取消订阅
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus] 事件 "${event}" 处理异常:`, e);
      }
    }
  }

  /** 返回取消订阅函数 */
  subscribe<T>(event: string, fn: Listener<T>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn as Listener<unknown>);
    return () => this.handlers.get(event)?.delete(fn as Listener<unknown>);
  }
}

export const bus = new TypedBus();

/** 事件名契约（动作类事件统一在此声明，避免魔法字符串） */
export const BusEvents = {
  fileOpen: 'file.open',
  addAttachmentToNode: 'add-attachment-to-node',
  wantedNotice: 'wanted.notice',
  wantedExecuting: 'wanted.executing',
  traceInspect: 'trace.inspect',
} as const;

/** 聊天消息（仅 kind === 'chat' 时携带，用于邮件式线程回复） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 轨迹事件检查负载（TraceTimeline 选中事件 → UnifiedViewer 右侧检查器） */
export interface TraceInspectPayload {
  /** 归属节点 id（ChatNodeKernel 的 nodeMdId / id），UnifiedViewer 按此过滤 */
  nodeId: string;
  /** 被选中的执行事件 span */
  span: import('@/lib/types').TraceSpan;
}

/** WANTED 通知负载（由 ⌘F 面板 / 每日报告 等发布，WantedNoticeCenter 消费） */
export interface WantedNoticePayload {
  /** kind：task=任务已建 / calendar=日历提醒 / note=想法已存 / notes=笔记列表（/note check） / todo_del=日程已删 / check=日程查询（/todo check） / chat=AI 节点问答回复（含日程查询回复） / info=通用 / daily-report=每日报告 / inspect=跨项目 sticky 待办检查 */
  kind: 'task' | 'calendar' | 'note' | 'notes' | 'todo_del' | 'check' | 'chat' | 'info' | 'web' | 'daily-report' | 'inspect';
  title: string;
  body: string;
  time?: number;
  /** 是否同时发桌面系统通知（默认 true；发布者已自行发送时传 false 避免重复） */
  desktop?: boolean;
  /** 点击通知时执行的动作 */
  action?: { type: 'open-calendar' };
  /** 结构化待办列表（每日报告 / 日程查询邮件）：通知中心顶部据此渲染标签栏，点击标签筛选该类待办 */
  items?: WantedNoticeItem[];
  /** 通知来源：panel=WANTED 面板输入 / wechat=微信桥 / scheduled=定时（日报等） */
  source?: 'panel' | 'wechat' | 'scheduled';
  /** 去重 key：防止同一事件被并发 publish 两遍；消费端按此 key 做窗口内去重
   *  - calendar 提醒：evt:<projectId>:<eventId>（由服务端写入 pending.json）
   *  - daily-report：daily-report:<YYYY-MM-DD>
   *  - 其他项可选：不填则按 kind+title+time 兜底生成
   */
  dedupeKey?: string;
  /** 邮件源查询签名（如 todocheck:today）：跳过 (kind,title) 当日幂等，保证重复执行生成本轮新邮件 */
  queryKey?: string;
  /** chat 线程 ID（kind === 'chat' 时必填）；同属一次对话的多条回复共用此 ID，
   *  收件箱中按 threadId 归组缩进显示为邮件线程 */
  threadId?: string;
  /** chat 对话历史累积（仅 kind === 'chat' 时携带）。含沙盒 system prompt +
   *  交替 user/assistant，回复时直接 messages+新问题调 /api/chat，无 TTL 限制。
   *  限制最近 20 轮（40 条），超出丢弃最早 user/assistant 对。 */
  messages?: ChatMessage[];
  /** 星标收藏（详情区 Star 按钮切换）；undefined ≡ false */
  starred?: boolean;
  /** true = 只弹即时 toast，不落 INBOX/ARCHIVE（对 task/note/info 这类"用户主动操作回执"使用） */
  toast?: boolean;
}

/** WANTED 命令执行状态负载（⌘F 面板执行 / 命令期间发布，WantedNoticeCenter 消费渲染右上角"执行中"浮层） */
export interface WantedExecutingPayload {
  /** true = 进入执行中；false = 执行结束（浮层消失） */
  executing: boolean;
  /** 顶部浮层展示的文案，如 "Running /todo…"，结束时可省略 */
  label?: string;
}

/** 通知中的结构化待办项 */
export interface WantedNoticeItem {
  key: string;
  title: string;
  time: string;
  startMs: number;
  status?: string;
  priority?: string;
  allDay?: boolean;
  /** 日报分区：today=今日待办 / overdue=已过期待办（非日报项无此字段） */
  section?: 'today' | 'overdue';
  /** 笔记正文（kind === 'notes' 时携带，供笔记列表邮件逐条展示） */
  content?: string;
}

/**
 * 剥离回复中的思考块（<think>...</think>，大小写不敏感、可跨行、兼容未闭合标签）。
 * 方案 B：微信 / BobMail 展示层只保留回复正文；chat_sessions 存储仍保留完整（含思考）。
 * 放本模块（前后端共用的纯类型模块）而非 node-chat.ts，避免前端组件拉入 better-sqlite3 等 Node 依赖。
 */
export function stripThinkTags(content: string): string {
  if (!content) return content;
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}
