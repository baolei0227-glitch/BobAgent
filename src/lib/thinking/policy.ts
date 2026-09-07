/**
 * 思考档位策略层 —— Phase 2 策略层抽取（默认行为与现网完全一致）
 * ------------------------------------------------------------------
 * 将 /api/chat/route.ts 内散落的思考档位决策收敛为纯函数模块：
 *  - C1 琐碎对话关思考（问候/致谢等简单轮次白烧 reasoning tokens）
 *  - DeepSeek V4 thinking_mode 档位映射（non-thinking / thinking / thinking_max）
 *  - item 4 工具循环「执行轮」思考降级（省 reasoning tokens）
 * 本模块无 route 依赖、无 I/O、纯函数；调用方负责注入 messages / level / config。
 * settings.thinking 两个开关默认开 —— 用户不配置 thinking 字段时，
 * 所有决策结果与策略抽取前（2026-09）逐位一致。
 */

/** DSH 思考档位语义枚举（4 档）：off / low / high / max。
 *  本期仅作类型与映射锚点：BobWork 现网 UI 档位为 3 档 ThinkingLevel
 *  （low/medium/high，reasoning_effort 取同名字符串，DeepSeek V4 走 thinking_mode），
 *  DSH 4 档语义将在 Phase 2 后续（2b+）作为统一收敛目标，本期未被 route 消费。 */
export type ThinkingEffort = 'off' | 'low' | 'high' | 'max';

/** 思考档位策略开关（对应 settings.thinking 字段落盘值的运行时形态）：
 *  - downgradeOnExecution：工具循环执行轮（round>0 且非收尾轮）思考降一级，
 *    深度推理只在规划轮做，执行轮只做决策，省 reasoning tokens（原 item 4）；
 *  - trivialPromptOff：琐碎对话（问候/致谢/简短确认等）直接关思考（原 C1）。
 *  两开关缺省均视为开（默认 true），用户显式 false 才关闭对应策略。 */
export interface ThinkingPolicyConfig {
  downgradeOnExecution: boolean;
  trivialPromptOff: boolean;
  /** 非 V4 推理模型的「<think> 标签引导」注入开关（Phase 2b）：
   *  默认 true（现网行为）；DeepSeek V4 恒不注入（原生 reasoning_content，纯 API 驱动）。 */
  injectThinkGuide?: boolean;
}

/** DeepSeek V4 thinking_mode 取值（non-thinking/thinking/thinking_max） */
export type V4ThinkingMode = 'thinking' | 'thinking_max' | 'non-thinking';

/**
 * V4 thinking_mode 档位映射（迁移 route.ts L2501-2511 的 deepseekThinkingMode IIFE）：
 *  - trivialPrompt 琐碎且 level!=='high'：仅当 config.trivialPromptOff 开启时 → non-thinking（C1，
 *    用户显式选高思考深度时尊重用户不降级）；
 *  - 否则 low/medium → thinking；high → thinking_max。
 * 注：原逻辑仅 DeepSeek V4 使用，调用方负责 isDeepseekV4 判断；trivialPrompt 由 isTrivialPrompt 计算。
 */
export function v4ThinkingModeForLevel(
  level: 'low' | 'medium' | 'high',
  config: ThinkingPolicyConfig,
  trivialPrompt = false,
): V4ThinkingMode {
  if (config.trivialPromptOff && trivialPrompt && level !== 'high') return 'non-thinking';
  switch (level) {
    case 'low':
    case 'medium':
      return 'thinking';
    case 'high':
      return 'thinking_max';
    default:
      return 'thinking'; // 类型穷尽后不可达，兜底
  }
}

/** 非 V4（reasoning_effort 系）执行轮降级表（迁移原 REASONING_EFFORT_EXECUTION_DOWNGRADE）：
 *  high→medium、medium→low、low→low */
const REASONING_EFFORT_EXECUTION_DOWNGRADE: Record<string, string> = {
  high: 'medium',
  medium: 'low',
  low: 'low',
};

/** V4（thinking_mode 系）执行轮降级表（迁移原 DEEPSEEK_EXECUTION_THINKING_MODE）：
 *  thinking_max→thinking、thinking→non-thinking、non-thinking→non-thinking。
 *  降级结果只会是 thinking / non-thinking，不会产生 thinking_max。 */
const DEEPSEEK_EXECUTION_THINKING_DOWNGRADE: Record<V4ThinkingMode, 'thinking' | 'non-thinking'> = {
  thinking_max: 'thinking',
  thinking: 'non-thinking',
  'non-thinking': 'non-thinking',
};

/** 工具循环执行轮降级结果（V4 与 非V4 二选一落地；与 base 档位比对用于降级遥测） */
export interface ExecutionDowngradeResult {
  /** V4：降级后的 thinking_mode（仅 thinking / non-thinking） */
  thinkingMode?: 'thinking' | 'non-thinking';
  /** 非 V4：降级后的 reasoning_effort */
  reasoningEffort?: string;
}

/**
 * 工具循环执行轮思考降级（迁移 route.ts L3233-3256 的降级段）：
 * 仅当 round>0 且非收尾轮 且 config.downgradeOnExecution 开启时返回降级结果；
 * 规划轮（round=0）/ 收尾轮 / 开关关闭 → 返回 null（不降级，调用方维持原档位）。
 *  - V4：按 DEEPSEEK_EXECUTION_THINKING_DOWNGRADE 映射 base thinking_mode 降一级。
 *    （C1 琐碎关思考只会把 base 变成 non-thinking，而 non-thinking 是降级映射的不动点，
 *    故此处按 level 推算 base 与按实际 base 推算的输出完全一致，无需感知 trivialPrompt。）
 *  - 非 V4：reasoning_effort 与 level 同名（low/medium/high），high→medium、medium→low、low→low。
 */
export function executionDowngrade(
  round: number,
  isFinalRound: boolean,
  level: 'low' | 'medium' | 'high',
  isV4: boolean,
  config: ThinkingPolicyConfig,
): ExecutionDowngradeResult | null {
  if (round <= 0 || isFinalRound || !config.downgradeOnExecution) return null;
  if (isV4) {
    const base = v4ThinkingModeForLevel(level, config);
    return { thinkingMode: DEEPSEEK_EXECUTION_THINKING_DOWNGRADE[base] };
  }
  // REASONING_EFFORT_MAP 是恒等映射（low/medium/high → 同名字符串），effort 可直接用 level
  const effort = level;
  return { reasoningEffort: REASONING_EFFORT_EXECUTION_DOWNGRADE[effort] ?? effort };
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
 * 思考提示注入开关（Phase 2b：全面 DSH 化）：
 *  - DeepSeek V4：**恒不注入** —— 原生返回 reasoning_content，思考纯由 API thinking_mode 驱动，
 *    注入「<think> 引导/提问限制」反而与 C1 关思考产生矛盾（prompt 叫它想 / API 不让想）；
 *  - 非 V4 推理模型：默认注入 <think> 标签引导（其思考块显示依赖该格式），可由
 *    settings.thinking.injectThinkGuide=false 关闭；
 *  - 非推理模型：不注入（原「清洗版思考引导」也随之移除，DSH 语义）。
 */
export function shouldInjectThinkPrompt(
  isV4: boolean,
  supportsThinking: boolean,
  config: ThinkingPolicyConfig,
): boolean {
  if (isV4) return false;
  return supportsThinking && config.injectThinkGuide !== false;
}
