/** 单次工具调用记录 */
export type ToolCallPhase = 'pending' | 'running' | 'done' | 'error';

/** 执行轨迹步骤类型：内置工具 / MCP 工具 / 技能上下文加载 */
export type ToolCallKind = 'tool' | 'mcp' | 'skill';

export interface ToolCallRecord {
  toolName: string;
  arguments: Record<string, unknown>;
  result: string;
  durationMs: number;
  success: boolean;
  /** 执行阶段：pending(已决定调用等待执行) / running(执行中) / done(成功) / error(失败) */
  phase?: ToolCallPhase;
  /** 方案B：工具返回的展示卡片 HTML（宿主渲染，如搜索结果卡），不进模型上下文 */
  cardHtml?: string;
  /** 执行轨迹类型（服务端下发，前端解析时兜底计算）：tool / mcp / skill */
  kind?: ToolCallKind;
  /** 该步骤的目的说明（"这一步在解决什么问题"；未知工具可缺省由前端回退） */
  purpose?: string;
  /** 是否发生系统变更（安装脚本/工具、写文件、改配置等），用于轨迹中突出标记 */
  systemChange?: boolean;
  /** 系统变更摘要（如"安装 Python 包 requests"、"写入 homework/xxx.py"） */
  changeSummary?: string;
  /** 结果摘要（短文本，供轨迹卡片默认展示；由服务端/前端截取） */
  summary?: string;
  /** P1 轨迹：服务端生成的稳定 span id（前端据此稳定渲染，不再每次重建） */
  spanId?: string;
  /** P1 轨迹：服务端生成的真实开始时间戳 ms */
  startAt?: number;
  /** P1 轨迹：服务端生成的真实结束时间戳 ms（tool_result 时填充） */
  endAt?: number;
}

export interface MessageAttachment {
  id: string;
  name: string;
  /** folder：授权目录引用（AI 通过文件工具操作目录，非文件附件） */
  type: 'image' | 'text' | 'file' | 'folder' | 'video' | 'audio';
  mimeType: string;
  size: number;
  path: string;
  dataUrl?: string;
}

/**
 * 消息级 @引用 快照（资料库文件 / 本地文件 / 链接 / 操作目录）。
 * 与 MessageAttachment 区分：@引用 不产生上传文件，仅作为本轮上下文，
 * 需要在气泡内以 chip 展示并随回答落盘（<!-- REFERENCES: -->）。
 */
export interface MessageReference {
  id: string;
  /** material=资料库文件；file=引用本地文件；link=链接材料；folder=操作目录 */
  kind: 'material' | 'file' | 'link' | 'folder';
  name: string;
  /** material：相对项目根路径（materials/...）；file/folder：本地绝对路径 */
  path?: string;
  url?: string;
  /** 展示用大小文本（如 "176.5 KB"），未知则省略 */
  size?: string;
  /** folder：用户显式授权锁定（sent-folder:） */
  locked?: boolean;
}

/**
 * 多智能体协作（Multi-agent mode）：单个成员分支的进度。
 * 由 team_run 编排期间的服务端进度快照（SSE subagent_update 帧）逐帧刷新，随回答写入持久化。
 */
export interface SubagentBranch {
  id: string;
  name: string;
  role: string;
  /** queued=等待/未开始，running=执行中，done=完成，failed=失败 */
  state: 'queued' | 'running' | 'done' | 'failed';
  taskId?: string;
  /** 该成员当前任务的标题 */
  subject?: string;
  /** 成员上报的进度文本 */
  progressText?: string;
  startAt?: number;
  endAt?: number;
  durationMs?: number;
  resultSummary?: string;
  error?: string;
}

/** 一次多智能体协作的进度面板（团队目标 + 成员分支），挂在回答消息上用于折叠分支卡片 */
export interface SubagentPanel {
  teamId: string;
  goal: string;
  done: number;
  total: number;
  failed: number;
  members: SubagentBranch[];
}

/**
 * 成员产出的一份文件（引擎随 member_done 事件 meta.artifacts 落盘，来自 /api/chat 的 output_files 帧）。
 * 与 OutputFileItem 同形但只保留呈现所需字段：用户在群聊流里点开文件卡片时，按 path 形态决定打开方式
 * （项目内相对路径走 project，`~/` 与绝对路径走 local —— 成员会话无项目上下文时产物落在沙箱，即后者）。
 */
export interface TeamArtifactItem {
  path: string;
  name: string;
  size: number;
  kind?: string;
  source?: string;
}

/**
 * 多智能体协作「群聊流」事件：team_run 编排期间由宿主（lib/chat/team-run.ts）外推的过程叙述，
 * 经 SSE subagent_events 帧送达前端，渲染成「多角色消息流」（形态 A 呈现层）。
 *
 * 与 SubagentPanel 的关系：面板是**逐帧全量快照**（当前状态），事件是**增量时间线**（发生过什么）。
 * 两者同源同帧下发，前端分别用于「分支卡片」与「群聊流」两种视图。
 *
 * 不落盘：事件只活在会话内存里（写入 .md RMETA 会让单行 JSON 体积随消息条数膨胀）；
 * 重启后由 SubagentPanel.members 合成降级视图（见 TeamChatStream）。
 */
export type TeamChatEvent =
  /** 团队启动：主 agent 已给出编排（成员 + 任务 DAG）并获批，调度器开始推进 */
  | { kind: 'team_start'; at: number; goal: string; memberNames: string[]; taskCount: number; /** 触发本轮协作的用户原文（宿主经 team_plan 带进引擎 → team_start 事件 meta）：群聊流据此渲染右侧「我的发言」气泡；旧数据 / 非交互路径可能没有 */ question?: string }
  /** 成员被任务唤醒，开始执行（taskId：被唤醒时认领的任务；消息唤醒等无任务场景为空） */
  | { kind: 'member_start'; at: number; memberId: string; name: string; subject?: string; taskId?: string }
  /** 成员任务完成（summary 为剥离留言块/发言行后的产出正文，已截断；全文在 TeamDetail.results[taskId]；
   *  say 为成员自己写的「群聊发言」（口语一句话，缺失时前端回退动作句）·steps 为工具调用次数；
   *  artifacts 为本轮落盘的文件，群聊流据此把「成员产出的文档」像发文件一样贴在群里） */
  | { kind: 'member_done'; at: number; memberId: string; name: string; subject?: string; summary?: string; say?: string; steps?: number; taskId?: string; artifacts?: TeamArtifactItem[] }
  /** 成员任务失败 */
  | { kind: 'member_failed'; at: number; memberId: string; name: string; subject?: string; error?: string; taskId?: string }
  /** 成员间留言投递（宿主中转成功后的实际投递；from 为真实来源成员名，to 为目标成员名） */
  | { kind: 'relay'; at: number; from: string; to: string; text: string }
  /**
   * 队长（宿主编排会话）的过程发言：派发任务 / 逐成员点评 / 点名追问 / 最终整合稿。
   * 由宿主经引擎 captain_note 工具落盘进 <teamId>.events.jsonl，故刷新后仍在；stage 为展示分组
   * （dispatch / review / followup / synthesis），targets 是被点名的成员名（渲染「→ 名」chip）。
   * line 是群里那句「人话」（一行口语摘要），text 是完整正文（展开可见；line 缺失时前端回退 text 首句）。
   */
  | { kind: 'captain'; at: number; stage: string; text: string; line?: string; memberId?: string; name?: string; targets?: string[]; taskId?: string }
  /** 其他状态迁移（成员增减、搁浅接管/冷恢复、人工重试、计划/质量链）：团队工作台读引擎事件流时才有 */
  | { kind: 'system'; at: number; text: string }
  /** 协作收口（全部任务终态或超出时间预算） */
  | { kind: 'team_done'; at: number; done: number; total: number; failed: number; timedOut: boolean };

/**
 * 团队工作台（chat 节点顶部 [对话 | 团队] 的团队视图）数据模型。
 *
 * 与前一组类型的差别：TeamChatEvent / SubagentPanel 是 **team_run 编排期间**宿主外推的
 * 过程数据（只活在会话内存、随回答落盘）；本组类型是引擎侧（bob-team-mcp）**落盘真相源**
 * 的只读投影——团队、成员、任务、邮箱、事件流（<teamId>.events.jsonl），由 /api/team/*
 * 实时读取，因此刷新/重启后仍在。
 */

/** 团队概览（列表视图；字段全部来自引擎面板，宿主不落库、不缓存） */
export interface TeamSummary {
  teamId: string;
  name: string;
  goal: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  /** 全部任务是否已进入终态（done/failed） */
  terminal: boolean;
  memberCount: number;
  taskCount: number;
  doneCount: number;
  failedCount: number;
  /** 草案仍在（planning 且 draft 未清空）：工作台据此列出可恢复的「未完成草案」 */
  planDraft: boolean;
}

/** 团队成员（status: idle/busy/parked/offline） */
export interface TeamMemberView {
  id: string;
  name: string;
  role: string;
  status: string;
  /** 已安装 Agent identity（bobwork market agent id）；空 = 以默认 chat 画像运行 */
  identity?: string;
  modelRef?: string;
  /** 当前正在执行的任务 id（busy 时有值） */
  currentTaskId?: string;
  /** 该成员累计发言次数（任务唤醒 + 消息唤醒） */
  messageCount: number;
}

/** 团队任务（DAG 节点） */
export interface TeamTaskView {
  id: string;
  subject: string;
  assignee?: string;
  dependencies: string[];
  status: string;
  progressText?: string;
  attempts?: number;
  lastActivityAt?: number;
  /** 开始执行时刻（认领时写入）：用于分配矩阵/时间线的耗时与区间 */
  claimedAt?: number;
  /** 终态时刻（done/failed 写入） */
  finishedAt?: number;
  /**
   * 终态传播标记：非空表示该 failed 是「上游失败导致」而非自身执行失败，值为致败依赖 id。
   * 引擎侧权威判定（见 bob-team-mcp propagateFailedDeps）——UI 的 blocked 标识与停摆横幅以此为准，
   * 不要用「deps 含 failed」在前端自行推断，否则与引擎口径分叉。
   */
  blockedBy?: string[];
  error?: string;
  qualityStage?: string;
}

/** 团队邮箱里的一条消息（引擎消息表，截断最近 50 条） */
export interface TeamMessageView {
  id: string;
  from: string;
  to: string;
  text: string;
  kind: string;
  delivered: boolean;
  createdAt: number;
}

/** 团队事件流的原始条目（= 引擎 TeamEvent，落盘 <teamId>.events.jsonl） */
export interface TeamEventItem {
  id: string;
  ts: number;
  kind: string;
  memberId?: string;
  memberName?: string;
  taskId?: string;
  from?: string;
  to?: string;
  text?: string;
  meta?: Record<string, unknown>;
}

/**
 * 计划草案的呈现层投影（审批之前 / 草案被丢弃后才有内容）。
 * 此刻成员与任务尚未物化（approve 才创建），若面板只看 members/tasks 就只剩空壳——
 * 工作台据草案渲染「计划中的成员与任务」与用户原始提问（question）。
 */
export interface TeamPlanDraftView {
  /** 触发本次协作的用户原始提问（宿主经 team_plan 带进引擎） */
  question?: string;
  members: Array<{ name: string; role?: string; identity?: string }>;
  tasks: Array<{ subject: string; assignee?: string; dependencies: string[] }>;
}

/** 团队详情（工作台主视图一次拉全；results 为成员产出全文，只在拉全量时给） */
export interface TeamDetail {
  teamId: string;
  name: string;
  goal: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number | null;
  /** 计划草案（未批准 / 已丢弃时唯一可读的分工）；成员已物化时通常无此项 */
  planDraft?: TeamPlanDraftView;
  terminal: boolean;
  /** 当前可认领（依赖已满足）的任务 id */
  ready: string[];
  /** 心跳接管阈值（引擎 STALE_MS 下发）：工作台接管倒计时据此计算，避免 UI 侧硬编码漂移 */
  staleMs?: number;
  members: TeamMemberView[];
  tasks: TeamTaskView[];
  messages: TeamMessageView[];
  /** 最近 50 条原始事件（全量拉取时给；增量走 SSE events 帧） */
  events?: TeamEventItem[];
  /** 成员产出全文：taskId → 文本（只含 done 任务；全量拉取时给，增量走 results 帧） */
  results?: Record<string, string>;
  /** 增量游标：已消费到的最后一条事件 id（SSE 断线重连时回传 since） */
  cursor?: string | null;
}

/** 团队工作台 SSE 帧（GET /api/team/<id>/stream） */
export type TeamStreamFrame =
  /** 面板状态变化（成员/任务/邮箱/终态）；不含产出全文，避免逐帧传大文本 */
  | { type: 'panel'; detail: TeamDetail }
  /** 成员产出增量（新 done 任务 → taskId → 全文） */
  | { type: 'results'; results: Record<string, string> }
  /** 群聊流增量事件（引擎事件的呈现层映射） */
  | { type: 'events'; events: TeamChatEvent[] }
  | { type: 'error'; message: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 系统消息（如上下文压缩提示）：仅前端展示，不参与模型输入，不持久化到对话记录 */
  system?: boolean;
  reasoning?: string;
  /** 工具调用轮剥离出的执行过程叙述（持久化，恢复后仍可按步骤卡片回看） */
  processNarration?: string;
  toolCalls?: ToolCallRecord[];
  attachments?: MessageAttachment[];
  /** 本轮 @引用 的上下文快照（资料 / 本地文件 / 链接 / 操作目录），气泡内以 chip 展示并落盘 */
  references?: MessageReference[];
  /** 本次回答生成的输出文件（homework/ 目录下的 .md/.docx/.pdf 等）或 attachments/nodes 下的文件 */
  outputFiles?: OutputFileItem[];
  /** 消息时间戳（ISO 字符串或 .md 中记录的 questionTime/answerTime） */
  timestamp?: string;
  /** 该条回复实际使用的模型 id（auto 模式每轮可能不同；custom 模型为完整配置串如 custom:openai:gpt-4o） */
  modelId?: string;
  /** 该条回复实际使用的思考等级（跟随节点设置，与模型无关） */
  thinkingLevel?: ThinkingLevel;
  /** P2 轨迹：本轮任务的轨迹事件日志 id（对应 .trajectory/<nodeId>/<taskId>.jsonl） */
  taskId?: string;
  /** 多智能体协作：本轮由主 agent 编排的成员分支进度（Multi-agent mode 开启且触发协作时才有） */
  subagents?: SubagentPanel;
  /** 多智能体协作：本轮的「群聊流」事件时间线（与 subagents 同源；仅会话内存，不随回答落盘） */
  subagentEvents?: TeamChatEvent[];
}

export interface OutputFileItem {
  /** 相对项目根的路径（如 homework/报告.md 或 attachments/nodes/n_xxx/数据.xlsx） */
  path: string;
  /** 文件名（含后缀） */
  name: string;
  /** 文件大小，字节数（未知时为 0） */
  size: number;
  /** 文件类别：doc 文档 / sheet 表格 / slide 演示 / pdf 文档 / image 图片 / other 其他 */
  kind: 'doc' | 'sheet' | 'slide' | 'pdf' | 'image' | 'text' | 'code' | 'other';
  /** 来源工具：write_file / rename_file / run_command */
  source: string;
}

/** 技能匹配详情（SSE 下发，供前端展示注入摘要） */
export interface SkillDetail {
  name: string;
  score: number;
  matchedKeywords: string[];
  bodyLength: number;
  forced: boolean;
}

export const DEFAULT_MODEL_ID = '';

/* ==================== 项目分类与标签 ==================== */

/** 项目分类（创建项目时选择，显示在项目标题右侧；面板 Tags 栏作为默认标签置顶显示） */
export const PROJECT_CATEGORIES = ['诉讼', '常法', '非诉', '破产', '研究', '其他'] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];
/** 项目自定义标签上限 */
export const PROJECT_TAG_LIMIT = 2;
/** 项目备注上限（字符数，超限截断；新建与编辑表单均同步该值并显示字数计数） */
export const PROJECT_NOTE_MAX = 100;

/* ==================== 自定义提供商模型 ==================== */

export type ProviderType = 'deepseek' | 'glm' | 'moonshot' | 'qwen' | 'openai' | 'doubao' | 'siliconflow' | 'agentplan' | 'codingplan' | 'ollama' | 'bobmultimodal';

// 数据与运行时函数已抽离至 providers/ 子模块，此处 re-export 保持向后兼容
export { sanitizeBaseUrl } from './providers/resolve';

export { VENDOR_BADGE_STYLE, PROVIDER_VENDOR } from './providers/presets';

export type ModelCapability = 'reasoning' | 'conversation' | 'coding' | 'creative' | 'analysis' | 'multilingual' | 'long-context' | 'vision' | 'embedding' | 'semantic-search' | 'retrieval' | 'ocr' | 'image-gen' | 'audio' | 'tts' | 'asr' | 'stt' | 'rerank' | 'agent';

export interface ModelSpec {
  capabilities: ModelCapability[];
  strengths: string[];
  weaknesses: string[];
  useCases: string[];
  /**
   * 单价（/ 百万 tokens）。input = 缓存未命中·输入基准单价；
   * 厂商存在高峰/空闲分时定价时，input/output/cacheHit 存高峰价，offPeak 存空闲折扣（如 0.5 = 半价）。
   */
  pricePerMillionTokens?: {
    input: number;
    output: number;
    /** 缓存命中单价（缺省 = input × CACHE_READ_RATIO） */
    cacheHit?: number;
    /** 空闲时段倍率（如 DeepSeek 0.5）；无分时定价则不设 */
    offPeak?: number;
    /** 结算币种：usd（默认）| cny */
    currency?: 'usd' | 'cny';
  };
  contextWindow?: number;
}

export interface ProviderModel {
  modelId: string;
  label: string;
  description: string;
  thinking: boolean;
  temperature: number;
  /** 模型家族声明（2026-09-15）：决定「怎么跟这个模型说话」的协议分支（回传 reasoning_content、
   *  强制 temperature=1、1M 上下文预检），**读声明优先、模型名正则仅作未知型号兜底**。
   *  'deepseek-v4' = DeepSeek V4 家族。厂商改 id（deepseek-v4-flash → deepseek-flash）只需改这里。 */
  family?: 'deepseek-v4';
  spec?: ModelSpec;
}

export interface ProviderPreset {
  type: ProviderType;
  label: string;
  description: string;
  baseUrl: string;
  models: ProviderModel[];
}

export { PROVIDER_PRESETS } from './providers/presets';

export interface SelectedModel {
  modelId: string;
  thinking: boolean;
  /** 用途标签（模型池统一仓库）：缺省按 category 推断，显式指定用于角色区过滤。
   *  chat=对话 / vision=视觉 / stt=语音转写 / tts=语音合成 / image=图像生成与编辑 / ocr=在线识别 */
  purpose?: 'chat' | 'vision' | 'stt' | 'tts' | 'image' | 'ocr';
}

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string; // 自定义 baseUrl，undefined 时走 preset 默认
  selectedModels?: SelectedModel[]; // 用户勾选的模型列表（含 thinking 信息）
}

/* ==================== 搜索配置 ==================== */

export interface SearchConfig {
  apiKey: string;
  baseUrl: string;
}

export interface AvailableModel {
  group: string;
  modelId: string;
  label: string;
  description: string;
  thinking: boolean;
  temperature: number;
  spec?: ModelSpec;
  /** 标准厂商名（如 'Qwen' / 'DeepSeek' / 'Kimi'），节点模型选择器徽标用 */
  vendor?: string;
}

export { getAvailableModels, isCustomModel, parseCustomModel, getProviderPreset, isDeclaredV4Model, isPresetVisionModel } from './providers/resolve';

/* ==================== 思考深度控制系统 ==================== */

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** UI 思考档位展示表（S2b 定稿 P-A：DSH 四档 off/low/high/max 可选；'medium' 为旧三档遗留值，
 *  仅用于存量消息/节点持久化的向后兼容显示——不可选，语义视同 high）。
 *  label = DSH 档位名（与 harness 对齐）；shortLabel 供紧凑场景使用。 */
export const THINKING_LEVELS: { value: ThinkingLevel; label: string; shortLabel: string }[] = [
  { value: 'off',    label: 'Off',         shortLabel: '关' },
  { value: 'low',    label: 'Low',         shortLabel: '浅' },
  { value: 'high',   label: 'High',        shortLabel: '中' },
  { value: 'max',    label: 'Max',         shortLabel: '深' },
  { value: 'medium', label: 'Deliberation', shortLabel: '中' }, // legacy：旧三档中档，语义并入 high
];

/** reasoning_effort API 参数映射（S2b 词表；实际决策已收敛到 lib/thinking/policy.effortForLevel，
 *  此处仅作类型化兜底/文档） */
export const REASONING_EFFORT_MAP: Record<ThinkingLevel, string> = {
  off: 'none',
  low: 'low',
  medium: 'high',
  high: 'high',
  max: 'max',
};

/** 思考引导注入文案（非 V4 推理模型用；DeepSeek V4 恒不注入——原生 reasoning_content）。
 *  S2b 四档语义：low=简要思考（原 low）；high=充分思考（承接原中档 Deliberation）；
 *  max=深度结构化推理框架（原深档 Retrospection）；off/legacy medium 见 SYSTEM_PROMPT_INJECTIONS。 */
const THINK_GUIDE_TEXT: Record<'low' | 'deliberation' | 'retrospection', string> = {
  low: '\n## 思考要求\n在回答前进行简要思考，但不要过度分析。思考过程用 <think></think> 标签包裹。\n\n## 提问限制\n每次最多向用户提 1-2 个问题。判断确实需要用户补充信息时才提问，不要为提问而提问。\n',
  deliberation: '\n## 思考要求\n每轮回答前先进行充分的思考，用 <think></think> 标签包裹。\n思考内容应包括：\n- 对用户问题的理解和拆解\n- 需要确认的前提条件\n- 推理的关键步骤\n\n## 提问限制\n每次最多向用户提 1-3 个问题。当需求、偏好或关键信息不明确时，主动向用户澄清。\n',
  retrospection: '\n## 深度思考要求\n对于每一个问题，请进行深度、结构化的思考。思考过程用 <think></think> 标签包裹。\n必须包含以下步骤：\n1. 用自己的话复述问题，确认理解正确\n2. 列出已知条件和未知信息\n3. 识别真正的问题（用户问的和用户需要的可能不同）\n4. 构建推理链条，逐步推导\n5. 检查每一步的可靠性，标注不确定的地方\n6. 考虑多种可能的答案或方案，比较优劣\n思考深度应足够：如果一个问题有隐含的前提假设，必须挖出来审视；如果有多种解法，必须全部列出并对比。\n\n对于疑难问题（复杂推理、长文档分析、多步骤任务），升级为以下推理框架：\n### Phase 1: 理解\n- 用自己的话完整复述问题\n- 标记所有不确定的信息和假设\n- 识别问题的隐含前提和边界条件\n### Phase 2: 拆解\n- 将问题拆解为 2~5 个子问题\n- 理清子问题之间的依赖关系\n- 确定哪些可以并行思考，哪些必须串行\n### Phase 3: 深度推理\n- 对每个子问题，从第一性原理出发逐步推导\n- 列举所有合理的替代方案或解释\n- 对每种方案进行优劣比较\n- 标注推理中的薄弱环节\n### Phase 4: 整合\n- 检查子问题之间的衔接是否自洽\n- 回溯到原始问题，确认是否完整回答\n- 标注遗留的未解决问题\n### Phase 5: 验证\n- 如果可能，用另一种方式验证结论\n- 设定检验标准：什么情况下你的答案会被证明是错的？\n\n## 提问限制\n每次最多向用户提 2-4 个问题。深度思考过程中发现的不确定因素、隐含假设和方案歧义都应向用户确认。\n',
};

/** 系统提示注入（off 不注入；medium legacy 与新 high 档同为 Deliberation 文案） */
export const SYSTEM_PROMPT_INJECTIONS: Record<ThinkingLevel, string> = {
  off: '',
  low: THINK_GUIDE_TEXT.low,
  medium: THINK_GUIDE_TEXT.deliberation, // legacy：旧三档中档
  high: THINK_GUIDE_TEXT.deliberation,   // 新 high 档 = 原中档深度
  max: THINK_GUIDE_TEXT.retrospection,   // 原深档文案随 max 档
};

/** 前端展示策略。
 *  注意：thinkCollapsed / thinkDimmed 当前无渲染路径引用（历史遗留配置）。
 *  流式期间的思考可见性由 TraceTimeline / thinking-parser 的 streaming 模式控制
 * （流式思考内容实时展开可见，完成后再折叠），不再由此静态配置决定。 */
export interface ThinkingDisplayConfig {
  showThinkBlock: boolean;
  thinkCollapsed: boolean;
  thinkDimmed: boolean;
}

export const DISPLAY_CONFIGS: Record<ThinkingLevel, ThinkingDisplayConfig> = {
  off: { showThinkBlock: true, thinkCollapsed: true, thinkDimmed: true },
  low: { showThinkBlock: true, thinkCollapsed: true, thinkDimmed: true },
  medium: { showThinkBlock: true, thinkCollapsed: true, thinkDimmed: true },
  high: { showThinkBlock: true, thinkCollapsed: true, thinkDimmed: true },
  max: { showThinkBlock: true, thinkCollapsed: true, thinkDimmed: true },
};

/** 缺省档位 = high（DSH 官方默认；S2b 后 UI/后端默认统一，off/low 显式选择才生效） */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';

export type AiChatNodeData = {
  title: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  nodeMdId?: string;  // .md 文件持久化 ID（UUID），首次对话时生成
  /** 会话创建时间（ISO，来自 .md frontmatter created_at）：左栏会话列表"最新在上"排序用 */
  createdAt?: string;
  /** AI Coding 节点：绑定的小程序（Bob Sandbox app）ID */
  sandboxAppId?: string;
  /** 已压缩对话轮次数（memory_compacted_until）：请求时跳过已压缩历史，交由压缩记忆+成果块兜底 */
  compactedUntil?: number;
  /** 多智能体协作模式开关（frontmatter multi_agent_mode）：开启后本轮请求带 multiAgentMode，主 agent 只作
   *  用户代理交 goal，宿主拉起队长（captain）会话做规划与整合 */
  multiAgentMode?: boolean;
  /** team 模式队长模型（frontmatter team_main_model，provider:modelId）：Team 分栏「Main model」选择，
   *  宿主用它跑队长会话（规划 + 复核/整合）。与节点模型（modelId）完全隔离，互不写回 */
  teamMainModel?: string;
  /** team 模式成员模型（frontmatter team_worker_model，provider:modelId）：Team 分栏「Worker model」选择，
   *  一刀切覆盖全部成员。与节点模型（modelId）完全隔离，互不写回 */
  teamWorkerModel?: string;
  /** 本节点关联的团队 id 清单（frontmatter team_ids）：团队工作台列出「本会话产生过的团队」，
   *  团队真相源在引擎侧（bob-team-mcp），此处只存引用，不镜像任何团队状态 */
  teamIds?: string[];
  /** 批注框（annotation）节点：批注文字（圆角矩形顶部展示） */
  annotationText?: string;
  /** 批注框（annotation）节点：关联的卡片节点 id 列表（自动跟随包围盒用） */
  annotationNodeIds?: string[];
  /** 批注框（annotation）节点：包围盒宽（世界坐标，动态跟随卡片重算） */
  annotationWidth?: number;
  /** 批注框（annotation）节点：包围盒高（世界坐标，动态跟随卡片重算） */
  annotationHeight?: number;
  [key: string]: unknown;
};

/** 版本历史记录项：每次生成成功后追加一条 */
export interface ImageGenVersion {
  /** 版本唯一 id */
  id: string;
  /** 生成图片 dataUrl */
  dataUrl: string;
  /** 生成时间戳（ms） */
  timestamp: number;
  /** 生成时使用的 prompt（留档，方便回溯当时怎么描述的） */
  prompt: string;
  /** 生成时使用的模型 */
  model?: string;
  /** 磁盘保存路径（homework/Image/{nodeDir}/xxx.png） */
  savedPath?: string;
  /** 用户标记为"敲定"的版本（可多个） */
  pinned?: boolean;
  /** 该版本图片的 Detect All 识别结果缓存（切换到该版本时直接复用，无需重新识别） */
  regions?: RegionRef[];
  /** 该版本上被引用的区域 id（随 regions 一起缓存） */
  selectedRegions?: string[];
}

/** VLM 识别出的可编辑区域（Auto-Locate 结果），#chip 引用指向此对象 */
export interface RegionRef {
  /** 区域唯一 id（如 region-car-xxx） */
  id: string;
  /** 显示名（# chip 文本，如 car） */
  label: string;
  /** VLM 完整描述（如 red vintage car） */
  object: string;
  /** 特征描述（如 red body, chrome bumper） */
  attributes?: string;
  /** 自然尺寸坐标 [x1, y1, x2, y2] */
  bbox: [number, number, number, number];
  /** 置信度 0~1 */
  confidence: number;
}

/** 三视图版本组：3 张图一组（正面 / 侧面 / 顶部） */
export interface TriplotGroup {
  /** 组唯一 id */
  id: string;
  /** 3 个视角的版本（顺序固定：0=front，1=side，2=top） */
  front: ImageGenVersion;
  side: ImageGenVersion;
  top: ImageGenVersion;
  /** 组创建时间戳 */
  timestamp: number;
  /** 用户标记为"敲定"的组 */
  pinned?: boolean;
  /** 当前展示的视角（'front' | 'side' | 'top'），缺省 front */
  activeView?: 'front' | 'side' | 'top';
}

/** 三视图生成进度：第 N 步 / 共 3 步，当前正在生成哪个视角 */
export interface TriplotProgress {
  step: 1 | 2 | 3;
  total: 3;
  current: 'front' | 'side' | 'top';
}

/** 多 Agent 编排节点（Bobby）数据：薄客户端，只传指令 + 附件，结果渲染由 MCP 返回 */
export type BobbyNodeData = {
  title: string;
  /** .md 文件持久化 ID（UUID），删除节点时使用 */
  nodeMdId?: string;
  /** 用户任务指令 */
  prompt: string;
  /** 附件列表（自包含：content 内联 或 path 直传） */
  attachments?: Array<{
    type: 'text' | 'image' | 'file' | 'pdf';
    name?: string;
    content?: string;
    path?: string;
    dataUrl?: string;
    mimeType?: string;
  }>;
  /** 用户偏好提供方（可选） */
  preferProvider?: 'ollama' | 'lmstudio';
  /** 执行状态 */
  status?: 'idle' | 'running' | 'done' | 'error';
  /** 最近一次编排返回（含轨迹，供节点渲染） */
  lastResult?: {
    ok: boolean;
    output?: string;
    modelRef?: string;
    trace: Array<{ step: string; status: string; detail?: string; durationMs?: number }>;
    fallback?: { reason: string };
    error?: string;
  };
  __hasPersistedPosition?: boolean;
};

/* ==================== 统一执行轨迹 TraceSpan 模型 ==================== */

/** 轨迹 Span 类型：所有"模型做了什么"统一抽象为 Span */
export type TraceSpanKind =
  | 'thinking_phase'   // 思考阶段（理解/拆解/推理/验证）
  | 'skill_load'       // 技能上下文加载
  | 'tool_call'        // 内置工具调用
  | 'mcp_call'         // MCP 服务调用
  | 'vision_stage'     // 视觉 OCR 链路阶段（Vision→在线OCR→GLM→VLM）
  | 'model_switch'     // 模型切换/降级
  | 'system_change'    // 系统变更（写文件/安装包等）
  | 'memory_compact';  // 对话记忆压缩

/** 思考子阶段（thinking_phase 的 detail.stage） */
export type ThinkingStage = 'understanding' | 'decomposition' | 'reasoning' | 'verification' | 'other';

/** 执行阶段（与 ToolCallPhase 兼容，但更通用） */
export type SpanPhase = 'pending' | 'running' | 'done' | 'error' | 'skipped';

/** 通用元数据：不同 kind 有不同字段 */
export interface TraceSpanMetadata {
  // tool_call / mcp_call
  toolName?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  cardHtml?: string;
  // skill_load
  skillName?: string;
  matchScore?: number;
  matchedKeywords?: string[];
  forced?: boolean;
  // thinking_phase
  stage?: ThinkingStage;
  stageTitle?: string;
  content?: string;
  // vision_stage
  stageName?: string;
  modelUsed?: string;
  // model_switch
  fromModel?: string;
  toModel?: string;
  reason?: string;
  // system_change
  changeType?: 'file_write' | 'file_delete' | 'file_rename' | 'pkg_install' | 'pkg_uninstall' | 'config_change' | 'script_exec';
  changeSummary?: string;
  changeDetail?: string;
  // memory_compact
  turnsSummarized?: number;
  factsPreserved?: number;
  // 通用
  purpose?: string;
  summary?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

/**
 * 统一执行轨迹 Span —— 替代原 ToolCallRecord + SkillDetail + 零散状态。
 * 所有 SSE 事件最终都映射为 Span 列表，前端按时间线统一渲染。
 */
export interface TraceSpan {
  /** 唯一 id（SSE 推送时生成，前端用 key 稳定渲染） */
  id: string;
  /** 父 Span id（支持嵌套：如 reasoning 下嵌套多个 tool_call） */
  parentId?: string;
  /** Span 类型 */
  kind: TraceSpanKind;
  /** 展示标题（如 "读取文件 homework/report.md"） */
  title: string;
  /** 执行阶段 */
  phase: SpanPhase;
  /** 开始时间戳 ms（Date.now()） */
  startAt: number;
  /** 结束时间戳 ms（未结束=0） */
  endAt?: number;
  /** 耗时 ms（endAt-startAt，前端可兜底计算） */
  durationMs?: number;
  /** 是否成功：phase=done 时 true，error 时 false，其余可选 */
  success?: boolean;
  /** 结构化元数据（不同 kind 的专属字段） */
  meta: TraceSpanMetadata;
  /** 子 Span 列表（仅非流式场景下直接嵌套；流式靠 parentId 扁平推送后前端组装树） */
  children?: TraceSpan[];
}

/** 思考结构化解析结果 */
export interface ParsedThinking {
  spans: Array<{
    stage: ThinkingStage;
    stageTitle: string;
    content: string;
  }>;
  /** 无法识别阶段的剩余思考文本 */
  unclassified: string;
}

/* ==================== 技能匹配增强类型 ==================== */

/** 用户意图粗分类（场景门控，Stage 1 快速过滤） */
export type UserIntentCategory =
  | 'visualization'  // 制图/可视化/图表
  | 'legal'          // 法律/法条/判例/合同
  | 'design'         // UI/前端/页面/设计/主题
  | 'docs'           // 文档/报告/PPT/Word/Excel/PDF
  | 'office'         // 办公自动化/飞书/日历/邮件/待办
  | 'video'          // 视频/录屏/切帧
  | 'image'          // 图片/视觉/OCR/图像生成
  | 'code'           // 代码/编程/开发
  | 'search'         // 搜索/调研/资料
  | 'general';       // 通用对话

/** 意图分类结果 */
export interface IntentClassifyResult {
  category: UserIntentCategory;
  confidence: number; // 0.0~1.0
  /** 命中的强关键词（用于精细匹配加权） */
  triggerWords: string[];
  /** 排除词：命中则视为负例（即使关键词重合） */
  exclusionWords: string[];
}

