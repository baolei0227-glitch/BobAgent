/**
 * src/lib/nodes/compact.ts
 * 增量压缩（规格 v3 §四）
 *
 * R-25: 压缩只处理 memory_compacted_until 之后的新增轮次，已压缩部分冻结，不再进入压缩通道
 * R-26: 触发条件：未压缩内容超过 compact_trigger_tokens，或累积 compact_trigger_turns 轮，谁先到算谁
 * R-27: 硬事实（日期、金额、条款号、当事人、期限）由规则直接抽取进 settled，原文照抄，模型无权改写
 *
 * v1 每次全量重压的做法会导致「转述的转述」，数字和日期在多次重写中逐渐飘移。
 * 增量压缩后，压十次和压一次的信息衰减相同，因此频率可以放到很短。
 */

import type { ConversationTurn } from '@/lib/node-markdown';
import OpenAI from 'openai';
import { compactTriggerTokensForContext, DEFAULT_CONTEXT_WINDOW, modelOutputTokenMaxForModel } from '@/lib/context-limits';

// ==================== 配置 ====================

export interface CompactConfig {
  /** 未压缩内容超过该 token 数触发压缩（R-26，token 优先） */
  triggerTokens: number;
  /** 未压缩轮数达到该值触发压缩（R-26，轮数兜底） */
  triggerTurns: number;
}

export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  triggerTokens: compactTriggerTokensForContext(DEFAULT_CONTEXT_WINDOW),
  triggerTurns: 15,
};

/** 压缩冷却：上次压缩（memory_compacted_at）后至少间隔该时长，token 触发才再次生效。
 *  用于压制「长文档逐轮触发」——问题/回答含附件全文时一轮就可能达 token 阈值，压缩完下一轮又触发。
 *  轮数兜底（triggerTurns）不受冷却限制，保证上下文不会无限膨胀。 */
export const COMPACT_COOLDOWN_MS = 10 * 60 * 1000;

// ==================== 触发判定（R-26） ====================

export type CompactReason = 'tokens' | 'turns' | 'none';

export interface CompactDecision {
  shouldCompact: boolean;
  reason: CompactReason;
  /** 本次需要压缩的轮次区间（conversations 下标，左闭右开）；无需压缩时为 null */
  range: { start: number; end: number } | null;
}

/**
 * 估算文本 token 数（近似：中文 1 字 ≈ 1 token，标点/空白偏轻）。
 * 压缩阈值是工程近似，不需要精确计费级 tokenizer。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length * 0.8);
}

/**
 * R-14-C 预算前瞻（T2，route projection hook）折叠量计算：
 * 给定「从旧到新」的逐对字符长度数组，从最老开始折叠，使保留（最新）部分的总字符
 * ≤ lowWaterChars，且至少保留 minKeepPairs 对（最新轮上下文不被折叠进摘要）。
 * @param pairChars 每轮 (user+assistant) 字符长度，下标 0 = 最老轮
 * @returns 应折叠的最老对数（0 = 无需折叠）；纯函数，便于单测。
 */
export function oldestPairsToFold(pairChars: number[], lowWaterChars: number, minKeepPairs = 2): number {
  const n = pairChars.length;
  if (n <= 0 || !(lowWaterChars > 0)) return 0;
  let keep = 0;
  let sum = 0;
  for (let i = n - 1; i >= 0; i--) {
    const len = pairChars[i] > 0 ? pairChars[i] : 0;
    // 最新 minKeepPairs 对无条件保留；之后仅当累加不超低水位才继续保留更老轮
    if (keep >= minKeepPairs && sum + len > lowWaterChars) break;
    sum += len;
    keep += 1;
  }
  return Math.max(0, n - keep);
}

/**
 * R-26 触发判定：只看 memory_compacted_until 之后的新增轮次
 * @param conversations 全量对话轮次
 * @param compactedUntil 已压缩游标（= 已压缩轮次数量，0 表示从未压缩）
 * @param configOrContextWindow 可传 CompactConfig 或 contextWindow 数字；传数字时按比例动态计算 triggerTokens
 * @param compactedAt 上次压缩时间（ISO 或毫秒时间戳）；在冷却期内 token 触发被压制（轮数兜底不受影响）
 */
export function shouldCompact(
  conversations: ConversationTurn[],
  compactedUntil: number,
  configOrContextWindow: CompactConfig | number = DEFAULT_COMPACT_CONFIG,
  compactedAt?: string | number | null,
): CompactDecision {
  const config: CompactConfig = typeof configOrContextWindow === 'number'
    ? { triggerTokens: compactTriggerTokensForContext(configOrContextWindow), triggerTurns: DEFAULT_COMPACT_CONFIG.triggerTurns }
    : configOrContextWindow;
  const start = Math.min(Math.max(0, compactedUntil), conversations.length);
  const uncompressed = conversations.slice(start);
  if (uncompressed.length === 0) {
    return { shouldCompact: false, reason: 'none', range: null };
  }
  const totalTokens = estimateTokens(
    uncompressed.reduce((s, t) => s + (t.question || '') + (t.answer || ''), ''),
  );
  if (totalTokens >= config.triggerTokens) {
    // token 触发受冷却压制：压缩后 10 分钟内不再因 token 量重复触发（长文档逐轮触发的主因）
    if (compactedAt) {
      const lastAt = typeof compactedAt === 'number' ? compactedAt : Date.parse(compactedAt);
      if (Number.isFinite(lastAt) && Date.now() - lastAt < COMPACT_COOLDOWN_MS) {
        return { shouldCompact: false, reason: 'none', range: null };
      }
    }
    return { shouldCompact: true, reason: 'tokens', range: { start, end: conversations.length } };
  }
  if (uncompressed.length >= config.triggerTurns) {
    return { shouldCompact: true, reason: 'turns', range: { start, end: conversations.length } };
  }
  return { shouldCompact: false, reason: 'none', range: null };
}

// ==================== 硬事实抽取（R-27） ====================

/** 硬事实模式：日期 / 金额 / 条款号 / 文号编号 / 百分比（规则抽取，原文照抄） */
const HARD_FACT_PATTERNS: RegExp[] = [
  // 日期：2026-07-31、2026/7/31、2026年7月31日
  /\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?/g,
  // 金额：8000元、￥8,000、1.5万元、3亿元
  /(?:￥|¥)?[\d,]+(?:\.\d+)?\s*(?:元|万元|亿元|人民币)/g,
  // 条款号：第三条、第 4.1 条、第2款
  /第[零一二三四五六七八九十百千\d]+[条款项]/g,
  // 文号/编号：法释〔2020〕17号、国发〔2022〕12号、（2021）最高法民终123号
  /(?:法释|发改|国发|人社部发|〔20\d{2〕|（20\d{2}）|\(20\d{2}\))[^，。；\n]{0,16}号?/g,
  // 百分比与数值比率
  /\d+(?:\.\d+)?%/g,
];

/**
 * R-27 从文本中规则抽取硬事实（去重，保序）
 * 返回的每条硬事实在写入 settled 时必须原文照抄，模型无权改写。
 */
export function extractHardFacts(text: string): string[] {
  const facts = new Set<string>();
  for (const pattern of HARD_FACT_PATTERNS) {
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const fact = m[0].trim();
      if (fact) facts.add(fact);
    }
  }
  return Array.from(facts);
}

// ==================== 压缩输入组装 ====================

export interface CompressInput {
  /** 已有任务目标（压缩记忆 goal 字段） */
  goal: string;
  /** 已有压缩记忆全文（增量更新基础） */
  existingMemory: string;
  /** 本次未压缩的新增轮次（R-25 只处理这些） */
  uncompressedTurns: ConversationTurn[];
  /** R-27 规则抽取的硬事实（必须原文照抄进 settled） */
  hardFacts: string[];
}

export interface CompressPrompt {
  system: string;
  user: string;
}

/**
 * 组装增量压缩的模型输入（供 compress 角色调用，见规格 v3 §十 模型分工）
 * 各 agent 上下文物理隔离：compress 只拿全量新增对话 + 已有记忆，不复用 main 的消息。
 */
export function buildCompressPrompt(input: CompressInput): CompressPrompt {
  const system = [
    '你是节点的记忆压缩器。只处理「本次新增对话」部分，基于「已有压缩记忆」做增量更新，不重复压缩已冻结的内容。',
    '',
    '输出格式（严格按以下五节，节内可多行）：',
    '### 任务目标',
    '### 已确认事实',
    '### 当前争议',
    '### 已排除路径',
    '### 用户偏好',
    '',
    '规则：',
    '- 已确认事实只写精简事实，不带来源标记。',
    '- 「硬事实清单」中的内容必须原文照抄进「已确认事实」，不得改写、不得遗漏。',
    '- 用户在第 3 轮提的输出要求、口径、风格（如「用表格输出」「只写依据」）必须保留进「用户偏好」。',
    '- 「已排除路径」记录试过且失败的方向。',
    '- 对话不足时相关节写「无」。',
  ].join('\n');

  const user = [
    '### 已有压缩记忆',
    input.existingMemory || '（无）',
    '',
    '### 任务目标',
    input.goal || '（无）',
    '',
    '### 硬事实清单（原文照抄，不得改写）',
    input.hardFacts.length > 0 ? input.hardFacts.map((f) => `- ${f}`).join('\n') : '（无）',
    '',
    '### 本次新增对话',
    ...input.uncompressedTurns.flatMap((t, i) => [
      `第 ${i + 1} 轮 问：${t.question}`,
      `答：${t.answer}`,
    ]),
  ].join('\n');

  return { system, user };
}

// ==================== 压缩产物解析 ====================

export interface CompressedMemory {
  goal: string;
  settled: string[];
  disputes: string[];
  excluded: string[];
  preferences: string[];
}

const COMPACT_SECTION_PATTERNS: Array<{ key: keyof CompressedMemory; re: RegExp }> = [
  { key: 'goal',        re: /###\s*任务目标\s*\n([\s\S]*?)(?=###\s*|$)/ },
  { key: 'settled',     re: /###\s*已确认事实\s*\n([\s\S]*?)(?=###\s*|$)/ },
  { key: 'disputes',    re: /###\s*当前争议\s*\n([\s\S]*?)(?=###\s*|$)/ },
  { key: 'excluded',    re: /###\s*已排除路径\s*\n([\s\S]*?)(?=###\s*|$)/ },
  { key: 'preferences', re: /###\s*用户偏好\s*\n([\s\S]*?)(?=###\s*|$)/ },
];

function parseSectionLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-\*\d.、)）]+/, '').trim())
    .filter((l) => l.length > 0 && l !== '（无）' && l !== '(无)' && l !== '无');
}

/**
 * 把模型输出的 5 节文本解析为结构化 CompressedMemory。
 * 任何一节缺失 → 返回空字符串数组（不会丢已有的硬事实）。
 */
export function parseCompressedMemory(raw: string): CompressedMemory {
  const result: CompressedMemory = { goal: '', settled: [], disputes: [], excluded: [], preferences: [] };
  const text = (raw || '').trim();
  if (!text) return result;
  for (const { key, re } of COMPACT_SECTION_PATTERNS) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const body = m[1].trim();
    if (key === 'goal') {
      result.goal = body.replace(/^[\s\-]+/, '').split(/\r?\n/)[0]?.trim() || '';
    } else {
      result[key] = parseSectionLines(body);
    }
  }
  return result;
}

/**
 * 反向校验（R-27 第二道防线）：确保所有硬事实都原文出现在 settled 中。
 * 返回缺失的硬事实列表，非空说明模型漏写了，需把这些硬事实强制 append 进 settled。
 */
export function verifyHardFacts(memory: CompressedMemory, hardFacts: string[]): string[] {
  const haystack = memory.settled.join('\n');
  return hardFacts.filter((f) => !haystack.includes(f));
}

/** 把 CompressedMemory 序列化成写入 ## 压缩记忆 分区的可读文本 */
export function renderCompressedMemory(memory: CompressedMemory): string {
  const lines: string[] = [];
  lines.push('### 任务目标');
  lines.push(memory.goal ? `- ${memory.goal}` : '- 无');
  lines.push('');
  lines.push('### 已确认事实');
  lines.push(memory.settled.length > 0 ? memory.settled.map((s) => `- ${s}`).join('\n') : '- 无');
  lines.push('');
  lines.push('### 当前争议');
  lines.push(memory.disputes.length > 0 ? memory.disputes.map((d) => `- ${d}`).join('\n') : '- 无');
  lines.push('');
  lines.push('### 已排除路径');
  lines.push(memory.excluded.length > 0 ? memory.excluded.map((e) => `- ${e}`).join('\n') : '- 无');
  lines.push('');
  lines.push('### 用户偏好');
  lines.push(memory.preferences.length > 0 ? memory.preferences.map((p) => `- ${p}`).join('\n') : '- 无');
  lines.push('');
  lines.push('> 增量压缩：只记录 `memory_compacted_until` 之前的轮次。后续对话继续追加，达到阈值再压。');
  return lines.join('\n').trim() + '\n';
}

// ==================== 压缩降级 fallback（R-14-C 与 nodes append 双轨共享） ====================

/**
 * 无可调用压缩模型（无 Key / 冷却期）时的降级摘要：仅把硬事实直写成 settled，
 * 推理/争议/偏好留空，游标照常推进（避免同一段反复触发）。
 *
 * P4c-1 fallback 收敛：route（R-14-C 缓存压缩）与 nodes append 增量压缩的原内联实现
 * 均等价于 `renderCompressedMemory({ goal, settled: hardFacts, disputes: [], excluded: [], preferences: [] })`，
 * 统一收敛到此共享函数，保证双轨降级行为完全一致。默认行为不变。
 */
export function compactionFallbackSummary(input: CompressInput): string {
  return renderCompressedMemory({
    goal: input.goal,
    settled: input.hardFacts,
    disputes: [],
    excluded: [],
    preferences: [],
  });
}

// ==================== 模型调用（runCompaction） ====================

/** 调用自定义 OpenAI-compatible endpoint 做压缩（流式不行必须拿完整文本） */
export interface CompactModelConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature?: number;
  /** 单轮超时 ms，默认 60_000 */
  timeoutMs?: number;
}

export interface RunCompactionResult {
  rendered: string;
  parsed: CompressedMemory;
  hardFactsAppended: string[];
  tokenApprox: { input: number; output: number };
}

/**
 * 端到端：buildCompressPrompt → 调模型 → 解析 5 节 → 硬事实校验+强制补回 → 渲染写入文本。
 * 模型调用失败（网络/欠费/模型不可用）时不 throw：返回仅由硬事实组成的最小可用 memory，
 * 保证下一次触发时数据依旧连贯（只是缺少推理要点）。
 */
export async function runCompaction(
  input: CompressInput,
  modelCfg: CompactModelConfig,
): Promise<RunCompactionResult> {
  const prompt = buildCompressPrompt(input);
  const inputApprox = estimateTokens(prompt.system + '\n' + prompt.user);

  let rawText = '';
  let failed = false;
  try {
    const client = new OpenAI({
      apiKey: modelCfg.apiKey,
      baseURL: modelCfg.baseURL,
      timeout: modelCfg.timeoutMs ?? 60_000,
    });
    const resp = await client.chat.completions.create({
      model: modelCfg.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      stream: false,
      temperature: modelCfg.temperature ?? 0.1,
      // 记忆压缩要消化长对话并产出完整压缩记忆，默认 4096 在思考模式下可能截断 → 按模型能力放大
      max_tokens: modelOutputTokenMaxForModel(modelCfg.model),
    });
    rawText = (resp.choices[0]?.message?.content || '').trim();
  } catch (e) {
    failed = true;
    console.warn(
      '[compact] 压缩模型调用失败，降级为仅由硬事实生成压缩记忆:',
      e instanceof Error ? e.message : String(e),
    );
  }

  let parsed = failed ? { goal: '', settled: [], disputes: [], excluded: [], preferences: [] } : parseCompressedMemory(rawText);

  // R-27 兜底：把所有硬事实原文照抄进 settled，漏写的强制 append
  const missing = verifyHardFacts(parsed, input.hardFacts);
  const settled = Array.from(new Set([...parsed.settled, ...input.hardFacts]));
  parsed = { ...parsed, settled };

  const rendered = renderCompressedMemory(parsed);
  return {
    rendered,
    parsed,
    hardFactsAppended: missing,
    tokenApprox: { input: inputApprox, output: estimateTokens(rendered) },
  };
}

/** 合并已有压缩记忆中的各列表到 CompressInput（不重复进压缩范围） */
export function extractGoalFromExistingMemory(existing: string): string {
  const m = existing.match(/###\s*任务目标\s*\n\s*-\s*([^\n]+)/);
  return m ? m[1].trim() : '';
}
