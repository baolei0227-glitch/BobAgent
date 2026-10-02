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
  butlerNotice: 'butler.notice',
  butlerExecuting: 'butler.executing',
  traceInspect: 'trace.inspect',
} as const;

/**
 * 公众号检索命中的一篇文章（检索结果富卡片的数据源）。
 *
 * 由「小微」搜索综述消息携带：卡片随消息一起落库（`ChatMessage.cards`），
 * 使「检索到了哪些文章」成为**会话历史的一部分**（刷新后可回看、可点开原文），
 * 而不是只活在某个临时浮层里。
 */
export interface WechatArticleCard {
  title: string;
  url: string;
  account?: string;
  /** 一句话摘要（读正文后由模型生成；缺省时前端退化为候选片段） */
  summary?: string;
  /** 文章关键要点短语（用于卡片角标） */
  keypoint?: string;
}

/**
 * 检索实况的一行：召回到的某一篇 + 精选对它的判定（2026-10-01）。
 *
 * 与 `WechatArticleCard` 的分工：卡片是**结果**（精编后留下的那几篇，给人读）；
 * 这一行是**判定过程**（连被判掉的也在），给人核对「AI 有没有漏掉好东西」。
 * 它随综述消息落库（`ChatMessage.searchTrace`）—— 消息在则账本在，**消息删则账本消失**。
 */
export interface WechatSearchTraceItem {
  /** 候选在召回列表里的下标（= 服务端 curated 帧的 id，按位回填判定） */
  id: number;
  title: string;
  url: string;
  account?: string;
  /** 召回时的搜索摘要（被判定掉的那些靠它说明「为什么这篇没用」） */
  snippet?: string;
  /** pending = 未判定（仅实时预览期存在，落库时不会出现）；kept = 入选精读；dropped = 被判掉 */
  verdict: 'pending' | 'kept' | 'dropped';
  /** 入选理由（kept） */
  reason?: string;
  /**
   * 模型给出的**相关度名次**（kept 才有；0 = 最相关）—— 2026-10-01 新增。
   *
   * 为什么必须存下来：账本数组是按**召回下标**排的，模型的相关度顺序原本在这一步被丢掉，
   * 于是"排序质量"（nDCG）离线完全算不了 —— 评测 CLI 只能报 `nDCG N/A`。
   *
   * 只有**模型真的排过序**时才写：兜底路径（模型不可用 → 取召回前 3 篇）不写，
   * 那几篇的顺序是召回顺序，给它标名次等于凭空造一份排序。
   * 因此 `rank` 存在 ⟺ 这一轮有真实的模型排序，评测据此判定 `ranked`。
   */
  rank?: number;
  /** 逐篇一句摘要（kept 且模型已产出） */
  summary?: string;
  /** 文章关键要点短语（kept 且模型已产出） */
  keypoint?: string;
  /** 正文是否读到（kept；false = 只有搜索摘要可用） */
  readOk?: boolean;
}

/** 一轮检索的实况账本：检索问题 + 逐篇判定。挂在综述消息上随消息落库。 */
export interface WechatSearchTrace {
  /** 该轮检索词（右栏面板的标题；不必再去猜是哪一条 user 消息） */
  query: string;
  /**
   * 规划器**实际拿去检索的关键词串**（1–3 个）—— 2026-10-01 新增。
   *
   * 为什么必须记下来：召回出问题时，"规划器给的方向不好"与"搜狗在该方向上的排序不好"
   * 是两种完全不同的病；在此之前账本里只有最终候选、没有方向，**无法归因**。
   *
   * ⚠ 降级路径可由此推断：若 `queries` 只有一个元素且等于 `query`，
   * 说明规划器没跑成（模型不可用 → 原句直搜），这一轮的召回不能算在规划头上。
   */
  queries?: string[];
  /** 规划器对用户意图的一句话概括（与 queries 同批落库，回看时能对齐"当时按什么搜的"） */
  intent?: string;
  items: WechatSearchTraceItem[];
}

/** 聊天消息（仅 kind === 'chat' 时携带，用于邮件式线程回复） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * 检索到的文章卡片（仅「小微」搜索综述的 assistant 消息携带）。
   * 可选：其余消息不写此字段；服务端线程存储原样透传（见 lib/butler/threads.ts parseThread）。
   */
  cards?: WechatArticleCard[];
  /**
   * 本轮检索的**实况账本**（仅「小微」搜索综述消息携带，2026-10-01 新增）。
   *
   * 为什么跟着消息落库（而不是只活在右栏内存里）：账本要能从消息下方的入口**随时重开**——
   * 抽屉关过、应用重启过都得还能点开，否则那个入口就是一条时灵时不灵的死链。
   * 随之而来的删除语义也自然成立：删掉这条消息，账本不复存在（右栏对应清空）。
   * 服务端线程存储原样透传（parseThread 逐字段保留，见 lib/butler/threads.ts）。
   */
  searchTrace?: WechatSearchTrace;
}

/** 轨迹事件检查负载（TraceTimeline 选中事件 → UnifiedViewer 右侧检查器） */
export interface TraceInspectPayload {
  /** 归属节点 id（ChatNodeKernel 的 nodeMdId / id），UnifiedViewer 按此过滤 */
  nodeId: string;
  /** 被选中的执行事件 span */
  span: import('@/lib/types').TraceSpan;
}

/** Butler 通知负载（由 ⌘F 面板 / 每日报告 等发布，ButlerNoticeHost 消费） */
export interface ButlerNoticePayload {
  /** kind：task=任务已建 / calendar=日历提醒 / note=想法已存 / notes=笔记列表（/note check） / todo_del=日程已删 / check=日程查询（/todo check） / info=通用 / web=一键整理网页报告 / daily-report=每日报告 / inspect=跨项目 sticky 待办检查 */
  kind: 'task' | 'calendar' | 'note' | 'notes' | 'todo_del' | 'check' | 'info' | 'web' | 'daily-report' | 'inspect';
  title: string;
  body: string;
  time?: number;
  /** 是否同时发桌面系统通知（默认 true；发布者已自行发送时传 false 避免重复） */
  desktop?: boolean;
  /** 点击通知时执行的动作 */
  action?: { type: 'open-calendar' };
  /** 结构化待办列表（每日报告 / 日程查询邮件）：通知中心顶部据此渲染标签栏，点击标签筛选该类待办 */
  items?: ButlerNoticeItem[];
  /** 通知来源：panel=Butler 面板输入 / wechat=微信桥 / scheduled=定时（日报等） */
  source?: 'panel' | 'wechat' | 'scheduled';
  /** 去重 key：防止同一事件被并发 publish 两遍；消费端按此 key 做窗口内去重
   *  - calendar 提醒：evt:<projectId>:<eventId>（由服务端写入 pending.json）
   *  - daily-report：daily-report:<YYYY-MM-DD>
   *  - 其他项可选：不填则按 kind+title+time 兜底生成
   */
  dedupeKey?: string;
  /** 邮件源查询签名（如 todocheck:today）：跳过 (kind,title) 当日幂等，保证重复执行生成本轮新邮件 */
  queryKey?: string;
  /** 会话线程 ID（可选）；DB 保留字段，供未来会话式通知归组使用 */
  threadId?: string;
  /** 对话历史 / 报告附件（kind === 'web' 时携带整理源对话、info 类通知携带原始对话存档） */
  messages?: ChatMessage[];
  /** 星标收藏（详情区 Star 按钮切换）；undefined ≡ false */
  starred?: boolean;
  /** true = 只弹即时 toast，不落 INBOX/ARCHIVE（对 task/note/info 这类"用户主动操作回执"使用） */
  toast?: boolean;
  /**
   * 打扰闸（B5 克制策略，2026-10-02 接线）：消费端在弹 toast / 系统通知前是否要问一次推送裁决。
   *  - `'gate'`（缺省）：先问 `POST /api/butler/push-gate`，免打扰窗口内/**超单日上限**时不打扰；
   *    落库不受影响（条目照常进抽屉收件箱），故**不丢数据**。
   *  - `'always'`：不过闸。用于两类——① **义务性通知**（规则执行回执等，v6 §3.2「义务不是打扰」）；
   *    ② **服务端已裁决过的**推送（如日报：服务端在 `GET /api/butler/daily-report` 已按同一策略
   *    决定放行或留在队列，客户端再过闸会双重计数）。
   */
  interrupt?: 'gate' | 'always';
}

/** Butler 命令执行状态负载（⌘F 面板执行 / 命令期间发布，ButlerNoticeHost 消费渲染"执行中"浮层） */
export interface ButlerExecutingPayload {
  /** true = 进入执行中；false = 执行结束（浮层消失） */
  executing: boolean;
  /** 顶部浮层展示的文案，如 "Running /todo…"，结束时可省略 */
  label?: string;
}

/** 通知中的结构化待办项 */
export interface ButlerNoticeItem {
  key: string;
  title: string;
  time: string;
  startMs: number;
  status?: string;
  priority?: string;
  allDay?: boolean;
  /** 日报分区：today=今日待办 / 已过期待办（非日报项无此字段） */
  section?: 'today' | 'overdue';
  /** 笔记正文（kind === 'notes' 时携带，供笔记列表邮件逐条展示） */
  content?: string;
  /**
   * 点击完成时接的真实链路（缺省 = 只翻转通知内的本地勾选，不动任何底层数据）：
   *  - 'event'：key 即日历事件 id（日报 Schedule 页）→ PATCH 事件状态，日历 / 便签侧随之联动
   *  - 'sticky'：便签待办行（日报 Sticky 页）→ 勾掉便签正文对应行，该行已入日历则事件同步完成
   */
  source?: 'event' | 'sticky';
  /** source='sticky' 的行定位：项目 + 便签 / 页 + 行号（text 用于行号漂移后的兜底匹配） */
  sticky?: { projectId: string; noteId: string; pageId: string; lineIndex: number; text?: string };
  /** sticky 项所属项目名（Sticky 页按项目分组渲染） */
  group?: string;
  /** sticky 项的次级归属（便签标题；与项目同名 / 只有一张便签时为空，不占一行） */
  subgroup?: string;
}

/**
 * 剥离回复中的思考块（<think>...</think>，大小写不敏感、可跨行、兼容未闭合标签）。
 * 方案 B：微信 / Butler 抽屉展示层只保留回复正文；chat_sessions 存储仍保留完整（含思考）。
 * 放本模块（前后端共用的纯类型模块）而非 node-chat.ts，避免前端组件拉入 better-sqlite3 等 Node 依赖。
 */
export function stripThinkTags(content: string): string {
  if (!content) return content;
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}
