/**
 * src/lib/context-limits.ts
 * R-7 成果块长度上限 / R-14 上下文注入闸 的动态计算（按模型 contextWindow 比例）
 *
 * 供多端复用（api/chat/route.ts、api/nodes/route.ts、canvas 组件等），
 * 避免各处重复「inferModelSpec 推断 contextWindow + 比例换算 + 下限保护」。
 *
 * 当前模型标配 1M 上下文：成果块 ×10% = 100000，闸 ×20% = 200000。
 * 小模型（128k/256k）自动收缩，防止注入超窗。
 */
import { inferModelSpec } from './model-matcher';

/** contextWindow 推断失败/模型缺失时的默认假设（当前标配 1M 上下文） */
export const DEFAULT_CONTEXT_WINDOW = 1000000;

/** 成果块动态上限占 contextWindow 比例（R-7） */
export const OUTCOME_CONTEXT_RATIO = 0.1;
/** 上下文闸占 contextWindow 比例（R-14） */
export const CONTEXT_GATE_RATIO = 0.2;
/** T_turn 单次工具返回上限占 contextWindow 比例（闸外敞口收口）：1M→50000、256k→12800、128k→6400 */
export const TOOL_OUTPUT_RATIO = 0.05;
/** 记忆压缩触发 token 阈值占 contextWindow 比例（1M→100000、256k→25600、128k→12800，下限 16000） */
export const COMPACT_TOKEN_RATIO = 0.1;
/** 成果块上限下限（字符），保证小模型也能容纳精炼成果 */
export const OUTCOME_MAX_LENGTH_FLOOR = 8000;
/** 上下文闸下限（字符），保证基础对话可用 */
export const CONTEXT_GATE_FLOOR = 32000;
/** 记忆压缩 token 阈值下限（字符估算），保证小模型也不会过于频繁压缩 */
export const COMPACT_TOKEN_FLOOR = 16000;
/** R-14-C 预算前瞻（T2）高水位：未压缩历史（字符）达 contextGate 该比例即「提前一轮」离散折叠。
 *  1M→120000 字符（≈ estimateTokens 96k token ≈ contextWindow×9.6%），与 R-26 100k token 触发
 *  同量级，但作用在「请求内未压缩消息」（含 think 回填/附件序列化的真实上传体）而非 .md 纯文本，
 *  且不依赖上游链 → 使服务端实际裁剪与游标推进同步、每轮 prompt 提前变小（孤立节点同样受益）。 */
export const COMPACT_LOOKAHEAD_HIGH_GATE_RATIO = 0.6;
/** R-14-C 预算前瞻低水位：折叠后未压缩历史压到 contextGate 该比例以下即停（保留最近轮上下文，
 *  避免单次折叠过深；1M→60000 字符）。折叠频率上限由低水位与 R-26 冷却共同约束（离散、非每轮）。 */
export const COMPACT_LOOKAHEAD_LOW_GATE_RATIO = 0.3;

/** 按模型 id 推断 contextWindow；空模型或推断失败按 DEFAULT_CONTEXT_WINDOW（1M）假设 */
export function inferContextWindow(modelId: string, thinking = false): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  return inferModelSpec(modelId, thinking).contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** R-7 成果块动态上限：contextWindow × 10%（1M→100000、256k→25600、128k→12800、8k→8000），下限 8000 */
export function outcomeMaxLengthForContext(contextWindow: number): number {
  return Math.max(OUTCOME_MAX_LENGTH_FLOOR, Math.round(contextWindow * OUTCOME_CONTEXT_RATIO));
}

/** R-14 上下文闸：contextWindow × 20%（1M→200000、256k→51200、128k→25600、8k→1600），下限 32000 */
export function contextGateForContext(contextWindow: number): number {
  return Math.max(CONTEXT_GATE_FLOOR, Math.round(contextWindow * CONTEXT_GATE_RATIO));
}

/** T_turn 单次工具返回上限（闸外敞口收口）：contextWindow × 5%（1M→50000、256k→12800、128k→6400），下限 8000 保证不劣于现状 */
export function toolOutputMaxForContext(contextWindow: number): number {
  return Math.max(8000, Math.round(contextWindow * TOOL_OUTPUT_RATIO));
}

/** 单任务累计工具返回上限占 contextWindow 比例（T_task）：防多轮下钻累积爆窗（1M→150000） */
export const TASK_TOOL_OUTPUT_RATIO = 0.15;

/** 单任务累计工具返回上限（字符）：contextWindow × 15%，下限 8000 */
export function taskToolOutputMaxForContext(contextWindow: number): number {
  return Math.max(8000, Math.round(contextWindow * TASK_TOOL_OUTPUT_RATIO));
}

/** brief 硬上限（每上游节点，P0-c）：结论档注入的硬长度约束，保证多个满额上游降级后仍在闸内。
 *  1800 为建议值（待实测）；只约束「结论 + 确定性等级 + 来源 id」三样，不含分析推理全文。 */
export const BRIEF_MAX_CHARS_PER_UPSTREAM = 1800;

/** 记忆压缩 token 触发阈值：contextWindow × 10%（1M→100000、256k→25600、128k→12800），下限 16000 */
export function compactTriggerTokensForContext(contextWindow: number): number {
  return Math.max(COMPACT_TOKEN_FLOOR, Math.round(contextWindow * COMPACT_TOKEN_RATIO));
}

/** R-14-C 预算前瞻高水位（字符）：contextGate × 60%（1M→120000，小模型随闸值下限 32k → 19200） */
export function compactLookaheadHighCharsForContext(contextWindow: number): number {
  return Math.max(1, Math.round(contextGateForContext(contextWindow) * COMPACT_LOOKAHEAD_HIGH_GATE_RATIO));
}

/** R-14-C 预算前瞻低水位（字符）：contextGate × 30%（1M→60000，小模型随闸值下限 32k → 9600） */
export function compactLookaheadLowCharsForContext(contextWindow: number): number {
  return Math.max(1, Math.round(contextGateForContext(contextWindow) * COMPACT_LOOKAHEAD_LOW_GATE_RATIO));
}

/** 一步到位：按模型 id 计算 R-7 成果块动态上限 */
export function outcomeMaxLengthForModel(modelId: string, thinking = false): number {
  return outcomeMaxLengthForContext(inferContextWindow(modelId, thinking));
}

/** 一步到位：按模型 id 计算 R-14 上下文闸 */
export function contextGateForModel(modelId: string, thinking = false): number {
  return contextGateForContext(inferContextWindow(modelId, thinking));
}

/** 一步到位：按模型 id 计算工具单次输出上限 */
export function toolOutputMaxForModel(modelId: string, thinking = false): number {
  return toolOutputMaxForContext(inferContextWindow(modelId, thinking));
}

/** 单次生成 max_tokens 上限（输出 token ≠ 上下文窗口，二者独立）：
 *  1M 上下文推理模型（deepseek-v4 / doubao-seed 等）输出预算放大到 16384——
 *  高思考深度下 reasoning 会先占用大半输出预算，固定 8192 时正文稍长就被
 *  finish_reason=length 截断（"Output reached the model limit"）；显式 128k/256k 取 12288；
 *  其余（含小模型）保底 8192（已验证安全，避免传超出模型支持上限导致 API 400）。
 *  注意：inferModelSpec 对无窗口标记的模型默认按 1M 假设，因此这里先按模型家族
 *  精确识别"高输出上限"推理大模型，避免 gpt-4o-mini/glm-4-flash 等被误放大。 */
export function modelOutputTokenMaxForModel(modelId: string, thinking = false): number {
  const lower = (modelId || '').toLowerCase();
  // 高输出预算推理大模型：显式 1m 标记或已知输出上限高的家族 → 16384
  if (
    /1m|1000k/.test(lower) ||
    /deepseek|seed|kimi|qwen-max|qwen3|claude|o[134]\b|gpt-4o|doubao|glm-4\.6|glm-5/.test(lower)
  ) {
    return 16384;
  }
  // 显式中等窗口标记 → 12288（inferModelSpec 对无标记模型默认按 1M 假设，
  // 此处不用 contextWindow 档位，避免 glm-4-flash/qwen-turbo 等被误放宽）
  if (/256k|128k/.test(lower)) return 12288;
  return 8192;
}
