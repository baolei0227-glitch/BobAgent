/**
 * 思考档位策略层 —— Phase 2 策略层抽取 + S2a 档位词表统一（reasoning_effort）
 * ------------------------------------------------------------------
 * 将 /api/chat/route.ts 内散落的思考档位决策收敛为纯函数模块。
 * S2a（2026-09-08，基于 S1 探针）后语义定稿：
 *  - V4 与非 V4 统一走 reasoning_effort 词表（none/low/high/max），删除 thinking_mode 专用分支；
 *  - off 的 wire 表达 = reasoning_effort: 'none'（探针证实 non-thinking 不关思考是官方 bug，真正关思考 = none）；
 *  - C1 琐碎关思考 = 发 reasoning_effort: 'none'（不再是 non-thinking）；
 *  - 纯 DSH 固定档（thinking.harnessPure=true，默认）：每轮一律发用户所选档位，
 *    不降级、不做 C1 关思考；harnessPure=false = 旧业务插件行为（执行轮降级 + C1 保留）。
 * 本模块无 route 依赖、无 I/O、纯函数；调用方负责注入 level / messages / config。
 */

/** DSH 思考档位语义锚点（4 档）：off / low / high / max。
 *  与 DSH harness 的 ReasoningEffortId 对齐，作为统一收敛目标被 effortForLevel 消费；
 *  wire 表达（reasoning_effort 字段）中 off 对应 'none'，见 ReasoningEffort。 */
export type ThinkingEffort = 'off' | 'low' | 'high' | 'max';

/** reasoning_effort 请求字段取值（wire 词表）：
 *  官方支持 none/minimal/low/medium/high/xhigh/max，本项目收窄为 none/low/high/max 四档
 *  （off 显式 → none；UI low→low、medium→high、high→max）。 */
export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';

/** 档位决策输入（UI 层）：DSH 四档 off/low/high/max + 旧三档遗留 medium（与 @/lib/types 的
 *  ThinkingLevel 同构，policy 不依赖 types.ts，保持零 import）。 */
export type EffortLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** 思考档位策略开关（对应 settings.thinking 字段落盘值的运行时形态）：
 *  - harnessPure：纯 DSH 固定档（默认 true）——每轮一律发用户所选档位，不降级、不 C1 关思考；
 *  - downgradeOnExecution：工具循环执行轮（round>0 且非收尾轮）思考降一级（仅 harnessPure=false 生效），
 *    深度推理只在规划轮做，执行轮只做决策，省 reasoning tokens（原 item 4）；
 *  - trivialPromptOff：琐碎对话（问候/致谢/简短确认等）直接关思考（C1，仅 harnessPure=false 生效）。
 *  harnessPure=false 时两开关缺省均视为开（默认 true），用户显式 false 才关闭对应策略。 */
export interface ThinkingPolicyConfig {
  /** 纯 DSH 固定档：true = 每轮一律用户所选档位（不降级 / 不 C1）；false = 旧业务插件行为 */
  harnessPure: boolean;
  downgradeOnExecution: boolean;
  trivialPromptOff: boolean;
}

/** UI 档位 → reasoning_effort 基映射（S2b 四档语义）：off→none、low→low、medium(legacy)→high、high→high、max→max */
const LEVEL_TO_EFFORT: Record<EffortLevel, ReasoningEffort> = {
  off: 'none',
  low: 'low',
  medium: 'high',
  high: 'high',
  max: 'max',
};

/**
 * 档位 → reasoning_effort 映射（S2a/S2b 统一词表，V4 与非 V4 共用；原 route 的 REASONING_EFFORT_MAP
 *  恒等映射 + V4ThinkingMode 映射合并收敛于此）：
 *  - off 显式 → 'none'（DSH 语义 off = wire none）；
 *  - C1（仅 harnessPure=false && trivialPromptOff && trivialPrompt && level 非 high/max）→ 'none'：
 *    琐碎关思考修复为发 reasoning_effort: 'none'（探针证实 non-thinking 不关思考是官方 bug）；
 *    用户显式选 high/max 深度时尊重用户不降级；harnessPure=true 时忽略 trivial（纯固定档）；
 *  - 否则 low→'low'、medium(legacy)→'high'、high→'high'、max→'max'。
 * 注：trivialPrompt 由调用方用 isTrivialPrompt 计算。
 */
export function effortForLevel(
  level: EffortLevel,
  config: ThinkingPolicyConfig,
  trivialPrompt = false,
): ReasoningEffort {
  if (level === 'off') return 'none';
  if (!config.harnessPure && config.trivialPromptOff && trivialPrompt && level !== 'high' && level !== 'max') return 'none';
  return LEVEL_TO_EFFORT[level];
}

/** 执行轮降级表（effort 语义，仅 harnessPure=false 时启用）：max→high、high→low、low→none、none→none。
 *  原 DEEPSEEK_EXECUTION_THINKING_DOWNGRADE（thinking_max→thinking、thinking→non-thinking）与
 *  REASONING_EFFORT_EXECUTION_DOWNGRADE（high→medium、medium→low）统一收敛于此——
 *  因 non-thinking 关思考在官方是 bug（探针 rcLen 61），V4 执行轮降级必须一并 effort 化。 */
const EXECUTION_DOWNGRADE: Record<ReasoningEffort, ReasoningEffort> = {
  max: 'high',
  high: 'low',
  low: 'none',
  none: 'none',
};

/**
 * 定向降一档（与 EXECUTION_DOWNGRADE 同表）：max→high、high→low、low→none、none→none。
 * 与 executionDowngrade 的区别：不受 harnessPure / round / downgradeOnExecution 开关约束——
 * 供「本任务已发生输出触顶（finish_reason=length）」这类**已观测故障**的定向纠偏使用
 * （见 src/lib/chat/empty-round.ts 的截断重试）。
 */
export function downgradeEffortOnce(effort: ReasoningEffort): ReasoningEffort {
  return EXECUTION_DOWNGRADE[effort];
}

/** 工具循环执行轮降级结果（统一 effort；与 base 档位比对用于降级遥测） */
export interface ExecutionDowngradeResult {
  /** 执行轮 reasoning_effort（wire 词表：none/low/high/max） */
  reasoningEffort: ReasoningEffort;
}

/**
 * 工具循环执行轮思考降级（迁移 route.ts 的降级段）：
 * 仅当 config.harnessPure=false 且 round>0 且非收尾轮 且 config.downgradeOnExecution 开启时返回降级结果；
 * 规划轮（round=0）/ 收尾轮 / 开关关闭 / harnessPure=true（纯固定档）→ 返回 null（不降级，调用方维持原档位）。
 * 降级以 effortForLevel 输出为基点（C1/off 均为 'none'，是降级表不动点，故无需感知 trivialPrompt）。
 */
export function executionDowngrade(
  round: number,
  isFinalRound: boolean,
  level: EffortLevel,
  config: ThinkingPolicyConfig,
): ExecutionDowngradeResult | null {
  if (config.harnessPure) return null;
  if (round <= 0 || isFinalRound || !config.downgradeOnExecution) return null;
  const base = effortForLevel(level, config);
  return { reasoningEffort: EXECUTION_DOWNGRADE[base] };
}

/** isTrivialPrompt 入参的消息形状（结构最小化，兼容 route 的本地 ChatMessage） */
export interface TrivialPromptMessage {
  role?: string;
  content?: unknown;
  /** OpenAI 风格 tool_calls（assistant 工具调用迹象守卫用） */
  tool_calls?: unknown[];
}

/**
 * C1（deepseek-harness）：琐碎对话判定 —— 直接关 thinking，避免琐碎轮次白烧 30-300 reasoning tokens。
 * 保守策略，宁可少省不可误关（整体迁移 route.ts isTrivialPromptMessages L1089-1114）：
 * 1. 历史复杂度守卫：任一条 assistant 带 tool_calls/思考痕迹，或全文超 3000 字符 → 视为复杂任务延续（如"继续"），不判琐碎；
 * 2. 工具迹象守卫：当前消息含附件/路径/文件/图片/代码/分析类指令，或超 60 字符 / 含换行 → 不判琐碎；
 * 3. 命中问候/致谢/简短确认/简单运算/简单日期时间等模式 → 琐碎。
 */
export function isTrivialPrompt(messages: TrivialPromptMessage[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  const text = (typeof lastUser.content === 'string' ? lastUser.content : '').trim();
  if (!text) return false;

  // 1) 历史复杂度守卫
  let totalLen = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') totalLen += c.length;
    if (m.role === 'assistant' && m.tool_calls?.length) return false;
  }
  if (totalLen > 3000) return false;

  // 2) 工具迹象守卫
  if (text.length > 60 || text.includes('\n')) return false;
  if (/attachments?\/|assets\/|\.(?:png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|md|txt|py|js|ts|html|css|json)\b|路径|图片|扫描|ocr|文件|代码|分析|审查|生成|写(?:一|个|份)?|帮我|总结|整理|比较|对比/i.test(text)) return false;

  // 3) 琐碎模式
  return (
    /^(?:你好|您好|hi|hello|hey|嗨|哈喽|早上好|下午好|晚上好|早安|午安|晚安|谢谢|感谢|多谢|再见|拜拜|好的|好|嗯|是的|对的|可以|没问题|继续|接着|然后呢|说说|讲讲|等等|稍等|ok|okay|thanks|thx|thank|bye|goodbye|sure|again|more|yes|no)/i.test(text) ||
    /^[\d\s+\-*/×÷.=？?]+$/i.test(text) ||
    /^(?:今天|明天|昨天|现在|当前)\s*(?:是)?\s*(?:几号|几点|星期几|日期|时间|天气|温度)/i.test(text) ||
    /^\d+\s*[+\-*/×÷]\s*\d+\s*[=＝]?\s*$/.test(text)
  );
}

/**
 * 思考提示注入（Phase 2b：全面 DSH 化）：
 *  - DeepSeek V4：**恒不注入** —— 原生返回 reasoning_content，思考纯由 API 驱动
 *    （V4 已统一走 reasoning_effort，但仍是原生 reasoning_content，无需  thinking 标签引导），
 *    注入「 thinking 引导/提问限制」反而与关思考（effort none）产生矛盾（prompt 叫它想 / API 不让想）；
 *  - 非 V4 推理模型：**恒注入**  thinking 标签引导（其思考块显示依赖该格式，属正确性前提而非偏好，
 *    故不设开关；关掉只会让这些模型的思考块显示不正常）；
 *  - 非推理模型：不注入（原「清洗版思考引导」也随之移除，DSH 语义）。
 */
export function shouldInjectThinkPrompt(
  isV4: boolean,
  supportsThinking: boolean,
): boolean {
  if (isV4) return false;
  return supportsThinking;
}
