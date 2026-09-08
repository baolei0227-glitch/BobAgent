/**
 * 统一应用设置模块
 *
 * 所有全局设置存储于 ~/BobWork/settings.json：
 *   Electron: 主进程通过 IPC 读写文件
 *   浏览器(dev): 降级为 localStorage
 *
 * 扩展方式：只需在 AppSettings 接口中加字段即可。
 *
 * 注意：此模块前端和后端共用。Node.js 文件 I/O 使用动态 import，
 * 避免在浏览器环境中加载 fs/path/os 模块。
 */

import type { ProviderConfig, SearchConfig } from './types';
import type { McpServerConfig } from './mcp/types';
import { DEFAULT_MCP_SERVERS } from './mcp/types';
// P4b-1 审批策略层：type-only import（approval.ts 为纯函数模块、不 import settings → 无循环依赖）
import type { ApprovalStrategy } from './chat/approval';

// ============================================================
// 接口定义 — 所有全局设置集中于此
// ============================================================

/** 任务归纳小模型配置（与视觉模型同结构） */
export interface TaskModelSettings {
  defaultProvider?: string;
  defaultModel?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Auto 模式任务类型智能选模开关（默认开；关 = 静态首选池首项，等同服务端 resolveMainChat 语义） */
  auto?: boolean;
  /** 候选池：该角色可用模型（多选，默认取候选池首个 defaultModel 为首选）；运行时首选不可用时按序回退 */
  pool?: Array<{ provider: string; modelId: string }>;
}

/**
 * 音频转写（STT）配置。
 * 云端多厂商自由选择（火山豆包 / 阿里 DashScope / SiliconFlow / OpenAI 兼容）。
 */
export interface SttSettings {
  /** 转写厂商：doubao | dashscope | siliconflow | openai（云端需 API Key）| bobmultimodal（本地，无需 Key） */
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** STT 候选池（与 Chat 统一）：多选候选，首个模型（model）为活动模型 */
  pool?: Array<{ provider: string; modelId: string }>;
}

/** 图像编辑（Image Edit）配置：独立于聊天模型（图像编辑走 images API，不兼容 chat completions）。
 * 厂商：openai（gpt-image-1）/ doubao（SeedEdit，火山方舟）/ qwen（qwen-image-edit，DashScope）/ siliconflow，
 * 以及本地无鉴权厂商 bobmultimodal（MLX SDXL 等，OpenAI 兼容 images API，无需 Key）/ ollama。 */
/** 用户自定义 negative 提示词模板（持久化到 settings.imageEdit.negativeTemplates） */
export interface NegativeTemplate {
  id: string;
  label: string;
  keywords: string;
}

export interface ImageEditSettings {
  /** 图像编辑厂商 */
  provider?: string;
  /** 图像编辑模型名（如 doubao-seededit-3-0 / gpt-image-1 / qwen-image-edit） */
  model?: string;
  apiKey?: string;
  /** 留空时按厂商 preset 自动推断 */
  baseUrl?: string;
  /** 已选模型列表：Settings 标题旁 chips 显示、ImageAiEditor 模型下拉候选。
   *  provider 与当前 imageEdit.provider 一致（同 API Key 下多选）。 */
  selectedModels?: string[];
  /** 图像编辑候选池（与 Chat 统一）：多选候选，首个模型（model）为活动模型 */
  pool?: Array<{ provider: string; modelId: string }>;
  /** 用户自定义 negative 提示词模板（ImageGenPromptBar 模板弹窗内展示/管理） */
  negativeTemplates?: NegativeTemplate[];
}

/** 在线 OCR 配置（OpenAI 兼容视觉模型，如 qwen-vl-ocr / qwen3.5-ocr / GPT-4o 等）。
 * 用于扫描件 PDF / 图片识别：本地 Vision OCR 质量不足时调用在线模型兜底，
 * 或（strategy='always'）全部页面直接走在线识别。
 * 2026-08：移除 enabled 开关——配置了 model + 可解析 apiKey 即始终参与（无开关，始终为开）。
 * 2026-08-18：视觉模型配置已收敛到 bob-ocr-mcp 插件，本字段为历史兼容保留。 */
export interface OnlineOcrSettings {
  /** OCR 专用视觉模型名（如 qwen-vl-ocr）；必填，填写即启用 */
  model?: string;
  /** 显式归属厂商（''/undefined = 按模型名前缀自动推断；如 qwen/glm/deepseek/moonshot/openai/doubao）。
   *  显式配置时，Key/BaseUrl 继承与该厂商 preset 优先于模型名推断。 */
  provider?: string;
  /** 可选覆盖：留空由引擎自动推断（qwen 系自动推断 DashScope 兼容地址） */
  apiKey?: string;
  /** 可选覆盖：留空自动推断 */
  baseUrl?: string;
  /** 使用策略：fallback = 仅本地质量低/空结果时调用（默认，省流量）；always = 全部页面走在线识别 */
  strategy?: 'fallback' | 'always';
  /** OCR 候选池（与 Chat 统一）：多选候选，首个模型（model）为活动模型 */
  pool?: Array<{ provider: string; modelId: string }>;
}

/** GLM-OCR（智谱官方文档解析 API）配置：
 *  - 走独立 layout_parsing 协议（非 OpenAI 兼容），model 固定为 glm-ocr
 *  - enabled + apiKey 即生效；baseUrl 留空用官方向导默认地址
 *  - strategy: 'fallback' = 仅本地质量低/空结果时调用；'always' = 全部页面走 GLM-OCR
 *  - priority：GLM-OCR 与 Online OCR（通用 OCR 视觉模型）的相对优先级：
 *      'glm-first' = GLM-OCR 先跑，空结果才 Online OCR → VLM（默认）
 *      'glm-force' = 只跑 GLM-OCR（即使结果为空也不降级 Online / VLM —— 适合需要"只用 layout_parsing 结构化输出"的法律/公文场景） */
export interface GlmOcrSettings {
  enabled?: boolean;
  /** 智谱 API Key（必填；留空不生效） */
  apiKey?: string;
  /** 可选覆盖：默认 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl?: string;
  /** 使用策略：fallback = 仅低质页/空结果时调用（默认，省 token）；always = 全部页面 */
  strategy?: 'fallback' | 'always';
  /** 与 Online OCR 的相对优先级 */
  priority?: 'glm-first' | 'glm-force';
}

export interface UISettings {
  sidebarCollapsed: boolean;
}

export interface GeneralSettings {
  language: string;
}

/** 便签 TODO 全局模板：一组命名好的待办文本行，跨项目共享（存 settings.json） */
export interface StickyTodoTemplate {
  id: string;
  name: string;
  /** 待办文本行（不含 "- [ ] " 前缀；应用时统一转为未勾选状态） */
  lines: string[];
  updatedAt?: string;
}

/** ChatNode 快捷指令：全局库共享，节点按 id 选用（存 settings.json） */
export interface QuickPrompt {
  id: string;
  name: string;
  /** 指令内容：点击 chip 时填入输入框随消息发送 */
  content: string;
  /** 分类标签（可选），便于分组展示 */
  category?: string;
  updatedAt?: string;
}

/** 自定义工具定义：用户注册的 HTTP 工具，AI 可通过 function calling 调用 */
export interface CustomToolDef {
  /** 工具名称，需为合法函数名（如 get_weather） */
  name: string;
  /** 工具描述，AI 根据此描述决定是否调用 */
  description: string;
  /** HTTP endpoint URL */
  endpoint: string;
  /** HTTP 方法，默认 POST */
  method?: 'GET' | 'POST';
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** JSON Schema 参数定义 */
  parameters?: Record<string, unknown>;
  /** 是否启用 */
  enabled: boolean;
  /** 最大输出长度（字符），默认 5000 */
  maxOutput?: number;
  /** 请求超时（毫秒），默认 30000 */
  timeoutMs?: number;
}

/** 技能自动获取（Skill Auto-Fetch）配置：任务能力缺口时按需检索安装受控清单内技能 */
export interface AutoFetchSettings {
  enabled?: boolean;
  /** notify=可见通知+静默安装；ask=阻塞确认（预留，Phase 2 生效） */
  confirmMode?: 'notify' | 'ask';
  /** 匹配表最低分，低于拒绝安装 */
  minMatchScore?: number;
  /** 先证明现有能力不足（尝试失败一次）才允许触发检索 */
  requireFailedAttempt?: boolean;
  /** 单任务安装上限 */
  maxInstallsPerTask?: number;
  registry?: {
    builtin?: string;
    remote?: string;
    refresh?: 'manual' | 'on_boot';
  };
}

export interface AvatarSettings {
  /** 'random' = 每次启动从所有头像中随机选；'fixed' = 固定使用 selected 指定的头像 */
  mode: 'random' | 'fixed';
  /** fixed 模式下选中的头像 id（格式 'builtin/文件名' 或 'custom/文件名'） */
  selected?: string;
}

/** ⌘F 自定义快捷入口（用户通过 ChatNode 创建/安装插件后自建） */
export interface QuickLauncher {
  id: string;
  label: string;
  /** 目标 agent 身份：chat / coding 等（点击时新建/聚焦对应节点） */
  agent: string;
  /** 预设提示词（点击时填入输入框，不自动发送） */
  prompt: string;
}

/** 思考档位策略开关（Phase 2 策略层抽取 + S2a，chat 后端 thinking 决策）。
 *  存 settings.thinking；字段 undefined = 走默认（各开关缺省语义见下）。
 *  - harnessPure：纯 DSH 固定档（缺省 true，S2a 拍板 P-B）——每轮一律发用户所选档位，
 *    不降级、不 C1 关思考；显式 false = 旧业务插件行为（执行轮降级 + C1）。
 *  - downgradeOnExecution：工具循环执行轮（round>0 且非收尾轮）思考降一级（仅 harnessPure=false 生效）；
 *  - trivialPromptOff：琐碎对话（问候/致谢等）直接关思考 C1（仅 harnessPure=false 生效）。 */
export interface ThinkingSettings {
  /** 纯 DSH 固定档（缺省 true）：true = 固定档不降级不 C1；false = 旧业务插件（降级 + C1 沿用下两开关） */
  harnessPure?: boolean;
  downgradeOnExecution?: boolean;
  trivialPromptOff?: boolean;
  /** 非 V4 推理模型的 <think> 标签引导注入开关（DeepSeek V4 恒不注入） */
  injectThinkGuide?: boolean;
}

export interface AppSettings {
  version: number;
  providers: ProviderConfig[];
  search: SearchConfig;
  taskModel: TaskModelSettings;
  outcomeModel: TaskModelSettings;
  /** 主对话模型（Role Assignment 中指定）：
   *  - defaultModel：默认调用模型（候选池首个，历史星标语义）；Auto 模式不再优先使用它，改为按任务类型在 pool 内智能匹配；仍作为工具执行/AI 编辑等链路的默认模型
   *  - pool：主对话候选池，每个 { provider, modelId } 保存时自动并入该厂商已勾选模型（进入节点模型选择） */
  chatModel?: TaskModelSettings & {
    pool?: Array<{ provider: string; modelId: string }>;
  };
  /** Agent 专属默认模型（P3-3b）：key = AGENT_PROFILES id（chat/coding/planner/…）；
   *  服务端兜底解析时按请求 identity 优先于此配置的 pool，其次 chatModel。UI 暂无编辑入口。 */
  agentModels?: Record<string, TaskModelSettings>;
  /** 笔记编译/回看模型配置：笔记系统已拆分为 bob-notes-mcp 插件（插件域 config.json 自持大脑模型），
   *  本字段仅供旧版本配置文件读取兼容，宿主不再读写。 */
  notesModel?: TaskModelSettings;
  stt: SttSettings;
  /** 图像编辑（Image Edit）模型配置：图片 AI 编辑专用（独立于聊天/视觉模型） */
  imageEdit?: ImageEditSettings;
  ui: UISettings;
  general: GeneralSettings;
  /** 在线 OCR（OpenAI 兼容视觉模型，扫描件兜底/强制识别） */
  onlineOcr?: OnlineOcrSettings;
  /** GLM-OCR（智谱官方文档解析引擎，独立 layout_parsing 协议） */
  glmOcr?: GlmOcrSettings;
  /** 模型分类覆盖（L3 反馈闭环）：modelId → 分类（'vision' | 'ocr' | 'chat' 等）。
   *  用户/系统对自动分类的纠正，运行时优先于命名正则——解决"模型名不含关键词被误判"。
   *  取值即 /api/models 的 type 字段：'chat' | 'vision' | 'ocr' | 'audio' | 'embedding' | 'image-gen' | 'moderation' | 'rerank' | 'other' */
  modelOverrides?: Record<string, string>;
  textPresets: TextPreset[];
  /** 便签 TODO 全局模板（跨项目共享）：名称 + 待办文本行 */
  stickyTemplates?: StickyTodoTemplate[];
  /** ChatNode 快捷指令全局库（跨节点共享）：节点按 id 选用显示在输入框上方 */
  quickPrompts?: QuickPrompt[];
  customTools: CustomToolDef[];
  mcpServers: McpServerConfig[];
  /** 欢迎窗口头像设置；undefined = 默认随机 */
  avatar?: AvatarSettings;
  /** 侧边栏品牌 logo：头像池中的 id（如 'builtin/xxx.png'），空字符串/undefined = 使用默认 bobwork-logo.png */
  brandLogo?: string;
  /** 主题 id：'warm'（统一单一品牌色）；undefined = 'warm' */
  theme?: string;
  /** 全局字号档位：'m' | 'l' | 'xl'；undefined = 'l'（默认）。通过 html[data-fontscale] 覆盖 --fs-* 变量 */
  fontScale?: 'm' | 'l' | 'xl';
  /** 3:4 竖版分享卡主题色：预设 key（red/orange/green/blue/pink/amber）或自定义 hex；undefined = red */
  xhsThemeColor?: string;
  /** 3:4 竖版分享卡纸张背景：cream/white/kraft/blush/sky/mint/lemon；undefined = cream */
  xhsPaper?: string;
  /** 3:4 竖版分享卡标签笔刷样式：oil/calligraphy/marker/crayon/watercolor/paint/bristle；undefined = oil */
  xhsBrush?: string;
  /** 全局截图 OCR（Cmd+Shift+O）功能开关；undefined = 启用。
   *  enabled=false 时热键回退内置截屏链路（不使用 BobWorkCapture 助手）。 */
  screenOcr?: { enabled?: boolean };
  /** ⌘F 自定义快捷入口（用户自建插件/工作流一键入口） */
  quickLaunchers?: QuickLauncher[];
  /** 已启用的技能名集合（Agent 级，key='default' 的全局默认池）；undefined = 从未配置，走系统默认技能 */
  enabledSkills?: string[];
  /** 按 Agent 画像配置的技能池（2026-09-06 多 agent 分发）：key = agentId，value = 该画像启用的技能名；
   *  某 agent 有独立配置时按它出 L1 技能目录，否则回退 enabledSkills（全局默认池）。
   *  与 enabledSkills 双写保持一致（enabledSkills 恒为该记录的 'default' 池）。 */
  agentSkills?: Record<string, string[]>;
  /** 首次运行向导已完成（用户已选择保存地址）；undefined = 未完成，首次启动弹引导 */
  setupCompleted?: boolean;
  /** 技能自动获取配置；undefined = 走默认（见 DEFAULT_AUTO_FETCH） */
  skills?: { autoFetch?: AutoFetchSettings };
  /** 需手动确认后才能执行的工具名集合（白名单之外的高风险工具）。
   *  undefined = 从未配置，走默认名单（DEFAULT_CONFIRM_TOOLS） */
  confirmTools?: string[];
  /** 小程序对接画布 GraphGateway 的授权表（太空舱对接协议）：
   *  key = appId，value = 授权级别；undefined 项 = 'none'（未授权）。
   *  由用户（空间站控制台）授予/撤销，小程序操作画布前必须先取得对应级别授权。 */
  sandboxGraphPermissions?: Record<string, SandboxGraphPermission>;
  /** 小程序模型调用（bridge chat）三级授权表：
   *   - 'none'       未授权（默认），任何模型调用一律拒绝
   *   - 'per_call'   每次调用都需用户确认；弹窗会附 token/金额预估（P1#10）
   *   - 'permanent'  永久授权（等同于旧版 granted:true）
   *  key = appId。由用户在授权弹窗 / Sandbox 面板授予或撤销。 */
  sandboxChatPermissions?: Record<string, SandboxChatPermission>;
  /** 思考档位策略开关（Phase 2-2a 新增）；undefined = 两开关默认开（与策略抽取前行为一致）。不改设置 UI */
  thinking?: ThinkingSettings;
  /** 工具审批策略（P4b-1 新增）；undefined = 走默认（approval.defaultStrategy = 'allow_scope'，
   *  与现网逐位一致：仅 confirmTools 名单内需确认、其余工具自动放行）。ask / never 为新档位，
   *  默认不启用（默认档零变化）；UI 暂无编辑入口，改 settings.json 即可生效。 */
  approval?: {
    defaultStrategy?: ApprovalStrategy;
    /** P4b 扩展：per-agent 覆盖（key = AGENT_PROFILES id），命中优先于 defaultStrategy */
    perAgent?: Record<string, ApprovalStrategy>;
  };
}

/** 图像生成/编辑模型名的通用判定正则（从 Model Pool 绑定模型中兜底识别图像模型）。
 *  与 SettingsModal 的 inferModelCategory / /api/models 的 image-gen 分类保持一致的关键词集合。 */
const IMAGE_MODEL_PATTERN =
  /sdxl|stable-diffusion|flux|dall-?e|qwen-image|wan[.\-]?\d|z-image|seedream|seededit|image-2[.\-]|image-3[.\-]|image-edit|gpt-image|kolors|imagen|cogview|midjourney|recraft|hunyuan-image|sensecog/i;

/** 在 Model Pool（providers）绑定模型中反查某模型的所属厂商（本地无鉴权厂商常跳过角色池直接绑定）。 */
export function findProviderForModel(settings: AppSettings, modelId: string): ProviderConfig | undefined {
  return (settings.providers ?? []).find((p) =>
    (p.selectedModels ?? []).some((s) => (typeof s === 'string' ? s : s.modelId) === modelId),
  );
}

/** 提取图像生成/编辑模型候选（ImageGenPromptBar / ImageAiEditor 共用）：
 *  imageEdit.model（显式默认优先）+ imageEdit.selectedModels（chips）+ imageEdit.pool（角色候选池）
 *  + providers 中 purpose=image 或模型名命中图像正则的绑定模型（Model Pool 兜底）。 */
export function getImageModelCandidates(settings: AppSettings): string[] {
  const out: string[] = [];
  const push = (id?: string | null) => {
    const t = id?.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(settings.imageEdit?.model);
  (settings.imageEdit?.selectedModels ?? []).forEach(push);
  (settings.imageEdit?.pool ?? []).forEach((p) => push(p.modelId));
  for (const p of settings.providers ?? []) {
    for (const s of p.selectedModels ?? []) {
      if (typeof s === 'string') {
        if (IMAGE_MODEL_PATTERN.test(s)) push(s);
      } else if (s.purpose === 'image' || IMAGE_MODEL_PATTERN.test(s.modelId)) {
        push(s.modelId);
      }
    }
  }
  return out;
}

/** 小程序对接画布 GraphGateway 的授权级别（太空舱对接协议）：
 *  - 'none'：未授权，任何图操作都被拒绝（默认）
 *  - 'read'：可读图快照 / 视口 / 节点信息
 *  - 'control'：可读 + 可操作（展开收起、移动、缩放、选中） */
export type SandboxGraphPermission = 'none' | 'read' | 'control';

/** P1#10 小程序模型调用三级授权级别：
 *  - 'none'       未授权（默认），任何模型调用一律拒绝
 *  - 'per_call'   每次调用前都需宿主弹窗确认；调用前会在宿主侧先预估 token 与金额
 *  - 'permanent'  永久授权（等同于旧版 granted:true，一次确认后不再打扰）*/
export type SandboxChatPermission = 'none' | 'per_call' | 'permanent';

/** P1#10: 粗略 token 估算（中文 1 char ≈ 1.5 tokens，英文 4 chars ≈ 1 token）。
 *  仅用于 per_call 弹窗的金额预估，不是精确计费。js-tiktoken 是可选更精确方案。 */
export function estimatePromptTokens(messages: Array<{ role?: unknown; content?: unknown }>): number {
  let total = 0;
  for (const m of messages || []) {
    total += 4; // per-message overhead (approx)
    const content = typeof m.content === 'string' ? m.content : '';
    let cnChars = 0;
    for (let i = 0; i < content.length; i++) {
      const cp = content.charCodeAt(i);
      if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef)) cnChars++;
    }
    const enChars = content.length - cnChars;
    total += Math.ceil(cnChars * 1.5) + Math.ceil(enChars / 4);
  }
  if (messages?.length) total += 3; // assistant-init priming
  return Math.max(0, total);
}

/** P1#10: 粗略单模型单价映射（美元 / 1M input tokens），用于 per_call 弹窗金额粗估。
 *  未知模型统一按 $2.5/1M 兜底。仅用于 UI 提示，非真实账单。 */
export const CHAT_PRICE_PER_M_INPUT_TOKENS_USD: Record<string, number> = {
  'glm': 1.0, 'openai': 2.5, 'gpt': 2.5, 'claude': 3.0, 'anthropic': 3.0,
  'deepseek': 0.7, 'qwen': 0.8, 'doubao': 1.2, 'zhipu': 1.0, 'minimax': 1.0,
  'gemini': 1.25, 'google': 1.25, 'coze': 1.5,
};
const CHAT_PRICE_DEFAULT_USD_PER_M = 2.5;
/** $/1M tokens → ¥/token 粗略汇率（UI 展示用，非真实汇率） */
const USD_TO_CNY = 7.25;

export interface ChatCostEstimate {
  promptTokens: number;
  /** 按 maxTokens（默认 2048）估算输出 token */
  estOutputTokens: number;
  /** 美元粗略总价（= (input*price_in + output*1.25*price_out_crude) / 1e6） */
  usd: number;
  /** 人民币粗略总价（UI 友好） */
  cny: number;
  priceLabel: string; /* e.g. "~$2.5/1M" */
}

export function estimateChatCost(opts: {
  model?: string;
  messages: Array<{ role?: unknown; content?: unknown }>;
  maxTokens?: number;
}): ChatCostEstimate {
  const promptTokens = estimatePromptTokens(opts.messages);
  const estOutput = Math.max(1, typeof opts.maxTokens === 'number' ? opts.maxTokens : 2048);
  const key = Object.keys(CHAT_PRICE_PER_M_INPUT_TOKENS_USD).find((k) =>
    (opts.model || '').toLowerCase().includes(k.toLowerCase()),
  );
  const pricePerMIn = key ? CHAT_PRICE_PER_M_INPUT_TOKENS_USD[key] : CHAT_PRICE_DEFAULT_USD_PER_M;
  const pricePerMOut = pricePerMIn * 1.25;
  const usd = (promptTokens * pricePerMIn + estOutput * pricePerMOut) / 1e6;
  return {
    promptTokens,
    estOutputTokens: estOutput,
    usd,
    cny: usd * USD_TO_CNY,
    priceLabel: `~$${pricePerMIn.toFixed(2)}/1M input`,
  };
}

export interface TextPreset {
  name: string;
  prompt: string;
  children?: TextPreset[]; // 子预设，有则展开二级菜单
}

const DEFAULT_PRESETS: TextPreset[] = [
  // 内容加工
  { name: '精简', prompt: '精简：删除冗余表述，保留核心信息，使文字更紧凑有力。' },
  { name: '润色', prompt: '润色：改善表达，优化措辞，使文字更流畅优雅，不改变原意。' },
  { name: '扩写', prompt: '扩写：在保持原意的基础上丰富细节，使内容更充实。' },
  { name: '修正错别字', prompt: '修正所有错别字、语法错误和标点符号问题，不改变其他内容。' },
  // 图表生成
  {
    name: '图表',
    prompt: '',
    children: [
      { name: '表格', prompt: '将以下内容转为整洁的 HTML 表格，表头加粗居中，数据行交替浅灰背景，边框简洁。' },
      { name: '流程图', prompt: '将以下流程描述转为 Mermaid flowchart 代码，节点用中文，方向自上而下(TD)。只输出 ```mermaid 代码块。' },
      { name: '时序图', prompt: '将以下交互描述转为 Mermaid sequenceDiagram 代码，参与者用中文。只输出 ```mermaid 代码块。' },
      { name: '列表', prompt: '提取关键信息生成嵌套的 HTML 无序列表，层级清晰，要点加粗。' },
    ],
  },
  // 格式重组
  { name: '总结摘要', prompt: '提取核心要点，生成简洁摘要，不超过原文的三分之一。' },
  { name: '列表化', prompt: '将段落内容重组为清晰的要点列表（bullet points），每条一行，简洁明了。' },
  { name: '学术风格', prompt: '将文字改写为学术论文风格，用词严谨规范，逻辑清晰，避免口语化表达。' },
  { name: '技术文档', prompt: '将文字改写为技术文档风格，准确、简洁、无歧义，适合开发者阅读。' },
  // 语言转换
  { name: '翻译为英文', prompt: '将以下中文翻译为英文，保持专业语气。' },
  { name: '翻译为中文', prompt: '将以下英文翻译为中文，保持专业语气。' },
  { name: '正式语气', prompt: '将文字改写为正式、专业的语气，适合商务场合。' },
  { name: '口语化', prompt: '将文字改写为自然、口语化的表达。' },
];

/** ChatNode 快捷指令默认库（首次使用自动填充；用户可增删改） */
const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  { id: 'qp-summarize', name: '总结摘要', content: '请对以上内容做简洁总结，提取核心要点。', category: '通用' },
  { id: 'qp-translate-en', name: '翻译为英文', content: '请将以上内容翻译为英文，保持专业语气。', category: '翻译' },
  { id: 'qp-translate-zh', name: '翻译为中文', content: '请将以上内容翻译为中文，保持专业语气。', category: '翻译' },
  { id: 'qp-polish', name: '润色', content: '请润色以上内容，使表达更流畅优雅，不改变原意。', category: '写作' },
  { id: 'qp-legal-cite', name: '引用法条', content: '请对以上法律问题给出结论，并引用现行有效法条原文（第X条），注明制定/修订时间。', category: '法律' },
];

/** 默认需手动确认的工具：写配置类工具（用户显式确认后才真正执行）。
 * 2026-08 起默认空名单 = 所有工具默认授权、不再弹确认（用户明确要求减少确认打扰）；
 * 名单保留机制：用户仍可在设置中手动添加工具回到"需确认"，高危操作（browser.run_js 等）风险自担。 */
export const DEFAULT_CONFIRM_TOOLS: string[] = [
  // 原名单（get_app_config / browser.run_js 等）已默认移除，需确认请手动添加
];

/** 默认设置 */
export function defaultSettings(): AppSettings {
  return {
    version: 1,
    providers: [],
    search: { apiKey: '', baseUrl: '' },
    taskModel: {},
    outcomeModel: {},
    chatModel: {},
    stt: {},
    onlineOcr: {},
    modelOverrides: {},
    ui: { sidebarCollapsed: false },
    general: { language: 'zh-CN' },
    textPresets: [...DEFAULT_PRESETS],
    quickPrompts: [...DEFAULT_QUICK_PROMPTS],
    customTools: [],
    // 出厂仅装配系统服务（team/bob-preview-mcp/bob-notes-mcp）；
    // 其余预置一律进 MCP 市场按需下载，出厂不再自动连接未授权/远程服务
    mcpServers: [...DEFAULT_MCP_SERVERS],
    avatar: { mode: 'random' },
    confirmTools: [...DEFAULT_CONFIRM_TOOLS],
    screenOcr: { enabled: true },
    quickLaunchers: [],
    theme: 'warm',
    fontScale: 'l',
    // Phase 2-2a：思考档位策略开关默认开（与策略抽取前行为一致）
    thinking: { downgradeOnExecution: true, trivialPromptOff: true, injectThinkGuide: true },
    // P4b-1：审批策略默认 allow_scope —— 与现网行为逐位一致（仅 confirmTools 名单内需确认）
    approval: { defaultStrategy: 'allow_scope' },
  };
}

// ============================================================
// 主题切换
// ============================================================

/** 可选主题列表；preview* 字段用于设置面板迷你界面预览（背景/侧边栏/卡片/主色/文字/边框），dark 标记深色主题 */
export const THEME_OPTIONS: Array<{
  id: string;
  label: string;
  desc: string;
  previewBg: string;
  previewSidebar: string;
  previewCard: string;
  previewAccent: string;
  previewText: string;
  previewBorder: string;
  dark: boolean;
}> = [
  {
    id: 'warm',
    label: 'Purple',
    desc: 'Default · dynamic-ui Purple',
    previewBg: '#f7f7f8',
    previewSidebar: '#efeff2',
    previewCard: '#f7f7f8',
    previewAccent: '#4b3fe3',
    previewText: '#171717',
    previewBorder: '#e4e4e7',
    dark: false,
  },
];

/**
 * 预设主题完整 CSS 变量映射（与 globals.css 中 [data-theme="xxx"] 块保持同步）。
 * 供 get_current_theme 工具返回给 AI，使其能感知当前主题的完整设计规范。
 * warm 主题合并了 :root 基底 + [data-theme="warm"] 语义层。
 */
export const PRESET_THEME_VARIABLES: Record<string, Record<string, string>> = {
  warm: {
    '--background': '#f7f7f8',
    '--canvas-bg': '#e6e6ec',
    '--foreground': '#171717',
    '--card': '#f7f7f8',
    '--card-foreground': '#171717',
    '--popover': '#f7f7f8',
    '--popover-foreground': '#171717',
    '--primary': '#4b3fe3',
    '--primary-foreground': '#fff',
    '--secondary': '#efeff2',
    '--secondary-foreground': '#171717',
    '--muted': '#efeff2',
    '--muted-foreground': '#52525b',
    '--accent': '#efeff2',
    '--accent-foreground': '#171717',
    '--destructive': '#e8463a',
    '--destructive-foreground': '#fff',
    '--border': 'rgba(23, 23, 23, 0.12)',
    '--input': 'rgba(23, 23, 23, 0.12)',
    '--ring': '#4b3fe3',
    '--paper': '#f7f7f8',
    '--paper-soft': '#efeff2',
    '--paper-hover': '#e8e8ec',
    '--paper-muted': '#ececef',
    '--ink': '#171717',
    '--ink-strong': '#0f0f11',
    '--ink-muted': '#52525b',
    '--ink-faint': '#71717a',
    '--line': 'rgba(23, 23, 23, 0.12)',
    '--line-soft': 'rgba(23, 23, 23, 0.08)',
    '--primary-soft': '#f2f7ff',
    '--primary-strong': '#3c2eca',
    /* ===== 统一 Token（与 globals.css warm 块同步；单一品牌色 Purple = dynamic-ui 默认） ===== */
    '--brand': '#4b3fe3',
    '--brand-strong': '#3c2eca',
    '--brand-soft': '#f2f7ff',
    '--brand-soft-strong': '#e5eaff',
    '--brand-text': '#1a1759',
    '--brand-on': '#fff',
    '--surface': '#f7f7f8',
    '--surface-muted': '#efeff2',
    '--text': '#171717',
    '--text-muted': '#52525b',
    '--chart-series-1': '#3c2eca',
    '--chart-series-2': '#a9aeff',
    '--chart-series-3': '#6f6fff',
    '--chart-series-4': '#22a5f7',
    '--chart-other': '#d3d4da',
    '--info': '#22a5f7',
    '--info-soft': 'rgba(34, 165, 247, 0.10)',
    '--success': '#1dc981',
    '--success-soft': 'rgba(29, 201, 129, 0.10)',
    '--warn': '#efaa17',
    '--warn-soft': 'rgba(239, 170, 23, 0.10)',
    '--danger': '#e8463a',
    '--danger-soft': 'rgba(232, 70, 58, 0.10)',
    '--purple': '#6f6fff',
    '--purple-soft': 'rgba(111, 111, 255, 0.10)',
    '--teal': '#27d2bf',
    '--teal-soft': 'rgba(39, 210, 191, 0.10)',
    '--input-bg': '#f7f7f8',
    '--input-border': 'rgba(23, 23, 23, 0.12)',
  },
};

/** 将主题应用到 document.documentElement.dataset.theme，供 CSS [data-theme] 选择器生效 */
export function applyTheme(theme: string | undefined): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  // 先清掉历史残留的内联 CSS 变量（避免污染）
  for (const key of Array.from(root.style)) {
    if (key.startsWith('--')) root.style.removeProperty(key);
  }

  const valid = THEME_OPTIONS.some((t) => t.id === theme);
  const id = valid ? (theme as string) : 'warm';
  root.dataset.theme = id;
}

/** 应用全局字号档位：写 document.documentElement.dataset.fontscale，供 CSS :root[data-fontscale] 覆盖 --fs-* 变量。
 *  'l' / undefined = 默认档（放大）；'m' = 缩小；'xl' = 更大。 */
export function applyFontScale(scale: 'm' | 'l' | 'xl' | undefined): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const effective = scale === undefined ? 'l' : scale;
  if (effective === 'l' || effective === 'xl') {
    root.dataset.fontscale = effective;
  } else {
    delete root.dataset.fontscale;
  }
}

/** 应用主题：统一单一品牌色 Purple（dynamic-ui；自定义主题已随单品牌策略移除） */
export function applyCustomTheme(settings: AppSettings): void {
  applyTheme('warm');
}

// ============================================================
// 运行时检测
// ============================================================

let _hasElectronAPI: boolean | null = null;
function hasElectronAPI(): boolean {
  if (_hasElectronAPI !== null) return _hasElectronAPI;
  _hasElectronAPI =
    typeof window !== 'undefined' &&
    !!(window as unknown as Record<string, unknown>).desktopAPI;
  return _hasElectronAPI;
}

/** 获取 Electron settings IPC API */
function electronSettingsApi(): { load: () => Promise<AppSettings | null>; save: (s: AppSettings) => Promise<{ success?: boolean; error?: string }>; exists: () => Promise<boolean> } {
  return (window as unknown as { api: { settings: { load: () => Promise<AppSettings | null>; save: (s: AppSettings) => Promise<{ success?: boolean; error?: string }>; exists: () => Promise<boolean> } } }).api.settings;
}

// ============================================================
// 客户端统一入口 — 自动选择 IPC 或 localStorage
// ============================================================

const LS_KEY = 'bob-work-settings';

function readFromLocalStorage(): AppSettings {
  if (typeof window === 'undefined') return defaultSettings();
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...defaultSettings(), ...parsed, version: parsed.version ?? 1 };
  } catch {
    return defaultSettings();
  }
}

function writeToLocalStorage(settings: AppSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_KEY, JSON.stringify(settings));
}

/**
 * 统一单一品牌色（2026-08-20 起）：无论旧设置里是预设主题还是 AI 自定义主题，
 * 一律收敛为 warm —— 自定义主题数据清除（主题选择器与 AI 换肤已随"彻底单一品牌色"移除）。
 */
export function normalizeCustomThemes(settings: AppSettings): AppSettings {
  settings.theme = 'warm';
  return settings;
}

/**
 * 读取全局设置（前端调用）
 */
export async function loadSettings(): Promise<AppSettings> {
  if (hasElectronAPI()) {
    try {
      const api = electronSettingsApi();
      const result = await api.load();
      if (result) return normalizeCustomThemes({ ...defaultSettings(), ...result });
    } catch {
      // IPC 失败降级
    }
  }
  return normalizeCustomThemes(readFromLocalStorage());
}

/**
 * 保存全局设置（前端调用）
 *
 * Electron 下若主进程明确返回 success=false（如防覆盖保护拒绝写入），
 * 会抛出错误让上层感知；仅 IPC 通道异常时降级 localStorage 兜底。
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  if (hasElectronAPI()) {
    try {
      const result = await electronSettingsApi().save(settings);
      if (result && result.success === false) {
        throw new Error(result.error || '设置保存被拒绝（配置文件可能已损坏）');
      }
      return;
    } catch (e) {
      // 明确拒绝（success=false）→ 向上抛出；仅 IPC 网络/通道异常 → 降级 localStorage
      if (!(e instanceof Error && /设置保存被拒绝|拒绝写入/.test(e.message))) {
        writeToLocalStorage(settings);
        return;
      }
      throw e;
    }
  }
  writeToLocalStorage(settings);
}

// ============================================================
// 旧数据迁移 — localStorage → settings.json
// ============================================================

const OLD_PROVIDER_KEY = 'ai-canvas-providers';
const OLD_SEARCH_KEY = 'ai-canvas-search-config';

/** 检查旧数据并迁移 */
export async function migrateOldSettingsIfNeeded(): Promise<AppSettings | null> {
  if (typeof window === 'undefined') return null;

  const oldProviders = window.localStorage.getItem(OLD_PROVIDER_KEY);
  const oldSearch = window.localStorage.getItem(OLD_SEARCH_KEY);

  if (!oldProviders && !oldSearch) return null;

  // 守卫：Electron 下配置文件已存在时，不迁移也不写回，
  // 避免用 localStorage 里的旧/残缺数据覆盖文件中的完整配置。
  if (hasElectronAPI()) {
    try {
      const exists = await electronSettingsApi().exists();
      if (exists) {
        // 仅清理旧 localStorage，文件配置保持不动
        window.localStorage.removeItem(OLD_PROVIDER_KEY);
        window.localStorage.removeItem(OLD_SEARCH_KEY);
        return null;
      }
    } catch {
      // exists 探测失败：降级为原迁移逻辑
    }
  }

  const settings = defaultSettings();

  if (oldProviders) {
    try {
      settings.providers = JSON.parse(oldProviders) as ProviderConfig[];
    } catch { /* ignore */ }
  }

  if (oldSearch) {
    try {
      settings.search = JSON.parse(oldSearch) as SearchConfig;
    } catch { /* ignore */ }
  }

  // 保存到新位置
  await saveSettings(settings);

  // 清除旧数据
  window.localStorage.removeItem(OLD_PROVIDER_KEY);
  window.localStorage.removeItem(OLD_SEARCH_KEY);

  return settings;
}

// ============================================================
// 便捷方法 — 更新单个设置字段
// ============================================================

/** 更新 providers 并保存 */
export async function updateProviders(providers: ProviderConfig[]): Promise<void> {
  const settings = await loadSettings();
  settings.providers = providers;
  await saveSettings(settings);
}

/**
 * 批量更新多个设置字段：一次读 + 一次写。
 * 避免多个 update 函数并发写同一文件时，后完成的写者用保存前读到的旧值
 * 覆盖掉新加的字段（例如设置弹窗保存时并发写 providers 导致新添加的模型丢失）。
 */
export async function updateSettingsFields(fields: Partial<AppSettings>): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({ ...settings, ...fields });
}

/** 更新 search 并保存 */
export async function updateSearch(search: SearchConfig): Promise<void> {
  const settings = await loadSettings();
  settings.search = search;
  await saveSettings(settings);
}

/** 更新 stt（音频转写模型）并保存 */
export async function updateStt(stt: SttSettings): Promise<void> {
  const settings = await loadSettings();
  settings.stt = stt;
  await saveSettings(settings);
}

/** 获取文本编辑预设提示词 */
export async function getTextPresets(): Promise<TextPreset[]> {
  const settings = await loadSettings();
  return settings.textPresets || [];
}

/** 更新文本编辑预设提示词 */
export async function updateTextPresets(presets: TextPreset[]): Promise<void> {
  const settings = await loadSettings();
  settings.textPresets = presets;
  await saveSettings(settings);
}

/** 读取便签 TODO 全局模板列表 */
export async function getStickyTemplates(): Promise<StickyTodoTemplate[]> {
  const settings = await loadSettings();
  return settings.stickyTemplates || [];
}

/** 读取 ChatNode 快捷指令全局库 */
export async function getQuickPrompts(): Promise<QuickPrompt[]> {
  const settings = await loadSettings();
  return settings.quickPrompts || [...DEFAULT_QUICK_PROMPTS];
}

/** 保存 ChatNode 快捷指令全局库 */
export async function updateQuickPrompts(prompts: QuickPrompt[]): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({ ...settings, quickPrompts: prompts });
}

/** 保存便签 TODO 全局模板列表 */
export async function updateStickyTemplates(templates: StickyTodoTemplate[]): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({ ...settings, stickyTemplates: templates });
}

/** 更新自定义工具列表并保存 */
export async function updateCustomTools(tools: CustomToolDef[]): Promise<void> {
  const settings = await loadSettings();
  settings.customTools = tools;
  await saveSettings(settings);
}

/** 更新 MCP 服务器列表并保存 */
export async function updateMcpServers(servers: McpServerConfig[]): Promise<void> {
  const settings = await loadSettings();
  settings.mcpServers = servers;
  await saveSettings(settings);
}

/** 更新头像设置并保存 */
export async function updateAvatar(avatar: AvatarSettings): Promise<void> {
  const settings = await loadSettings();
  settings.avatar = avatar;
  await saveSettings(settings);
}

/** 更新侧边栏品牌 logo 并保存；传空字符串或 undefined 恢复默认 */
export async function updateBrandLogo(brandLogo: string | undefined): Promise<void> {
  const settings = await loadSettings();
  settings.brandLogo = brandLogo || undefined;
  await saveSettings(settings);
}

/** 更新需手动确认的工具名单并保存；传 null 恢复默认名单 */
export async function updateConfirmTools(tools: string[] | null): Promise<void> {
  const settings = await loadSettings();
  settings.confirmTools = tools ?? [...DEFAULT_CONFIRM_TOOLS];
  await saveSettings(settings);
}

/** 读取某小程序的画布对接授权级别；undefined = 'none' */
export async function getSandboxGraphPermission(appId: string): Promise<SandboxGraphPermission> {
  if (!appId) return 'none';
  const settings = await loadSettings();
  return settings.sandboxGraphPermissions?.[appId] ?? 'none';
}

/** 设置（授予/撤销）某小程序的画布对接授权级别 */
export async function updateSandboxGraphPermission(
  appId: string,
  level: SandboxGraphPermission,
): Promise<void> {
  const settings = await loadSettings();
  const permissions = { ...(settings.sandboxGraphPermissions ?? {}) };
  if (level === 'none') delete permissions[appId];
  else permissions[appId] = level;
  await updateSettingsFields({ sandboxGraphPermissions: permissions });
}

/** 读取某小程序「模型调用（bridge chat）」授权级别（P1#10 三级化）。
 *  兼容旧版 boolean：true → 'permanent'，false/undefined → 'none' */
export async function getSandboxChatPermission(appId: string): Promise<SandboxChatPermission> {
  if (!appId) return 'none';
  const settings = await loadSettings();
  const raw = settings.sandboxChatPermissions?.[appId] as unknown as SandboxChatPermission | boolean | undefined;
  if (raw === true) return 'permanent';
  if (raw === false || raw == null) return 'none';
  if (raw === 'none' || raw === 'per_call' || raw === 'permanent') return raw;
  return 'none';
}

/** 便捷判断：授权级别 >= per_call（即 permanent 或 per_call 均视为"可以调用"，仅是否弹确认不同）。
 *  用户侧 SandboxPanel 展示时，仍展示具体级别。 */
export async function isSandboxChatAllowed(appId: string): Promise<boolean> {
  const lvl = await getSandboxChatPermission(appId);
  return lvl !== 'none';
}

/** 设置某小程序的「模型调用（bridge chat）」三级授权级别（P1#10）。
 *  入参 granted: boolean 兼容旧版：true → 'permanent'，false → 'none' */
export async function updateSandboxChatPermission(
  appId: string,
  granted: SandboxChatPermission | boolean,
): Promise<void> {
  const level: SandboxChatPermission =
    granted === true ? 'permanent' :
    granted === false ? 'none' :
    (granted || 'none');
  const settings = await loadSettings();
  const permissions = { ...(settings.sandboxChatPermissions ?? {}) };
  if (level === 'none') delete permissions[appId];
  else permissions[appId] = level;
  await updateSettingsFields({ sandboxChatPermissions: permissions });
}
