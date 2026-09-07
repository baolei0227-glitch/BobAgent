/**
 * P5a-2 Trace 面板窗口派生（可回退），行为不变
 *
 * windowToTrajectoryItems：把 P5a-1 事件窗口（TraceWindowState）平移为
 * ConversationTrajectory 渲染所需的「Turn item 素材」。返回结构与
 * ConversationTrajectoryItem 对齐（thinkText / toolCalls / skillDetails / matchedSkills
 * 四字段实读核对一致）；number / userText / isStreaming / durationMs 由窗口不携带，
 * ChatNodeKernel 在被替换的「消息快照派生项」上保留 / 注入。
 *
 * 派生语义与 messages 快照派生逐帧等价（验证门）：
 * - thinkText：reasoningAccum 优先（= 消息 m.reasoning），contentAccum 剥 think 标签兜底
 *   （= parseThink(m.content).think，标签集 think/thinking/thought/reasoning）；
 * - toolCalls：spans → ToolCallRecord 字段快照（phase/success/durationMs/startAt/endAt/
 *   result/summary/kind/cardHtml/purpose/spanId/arguments/systemChange/changeSummary），
 *   顺序 = span 创建顺序；
 * - matchedSkills / skillDetails：来自 meta（matchedSkills / done 帧透传）。
 *
 * 本模块为纯函数、无 React / I/O；不 import 任何 components（避免 lib → components 反向
 * 依赖），类型贴近 @/lib/types 的 ToolCallRecord / SkillDetail，宿主适配。
 * 窗口为 null / 空（无事件）或无可展示轨迹（无工具 / 无思考 / 无技能）→ 返回 null，
 * 宿主回退现状（消息快照派生）路径。
 */

import type { SkillDetail, ToolCallKind, ToolCallRecord } from '../types';
import type { TraceWindowSpan, TraceWindowState } from './present';

/** 窗口派生 Turn item 素材：与 ConversationTrajectoryItem 对齐的最小字段（结构同形） */
export interface TraceWindowTurnItem {
  /** 本轮用户提问原文（P5b-1 replay：meta.userText，来自 user/message 结算事件） */
  userText?: string;
  /** 本轮思考文本（流式 reasoning 累积；无 reasoning 时从 contentAccum 剥 think 兜底） */
  thinkText?: string;
  toolCalls: ToolCallRecord[];
  skillDetails: (SkillDetail | string)[];
  matchedSkills: string[];
}

/** think 标签集与 ChatNodeKernel parseThink（THINK_TAG_RE / THINK_OPEN_RE）保持一致 */
const THINK_TAG_RE = /<(?:think|thinking|thought|reasoning)>([\s\S]*?)<\/(?:think|thinking|thought|reasoning)>/gi;
const THINK_OPEN_RE = /<(?:think|thinking|thought|reasoning)>([\s\S]*)$/i;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 从正文累积提取 think 文本（对齐 ChatNodeKernel parseThink 的 think 侧：
 * 多个完整标签拼接 + 未闭合标签兜底；返回 trim 后的 think 文本）。
 */
function extractThinkText(content: string | undefined): string {
  if (!content || !content.trim()) return '';
  let think = '';
  let clean = content;
  for (const m of clean.matchAll(THINK_TAG_RE)) think += `${m[1].trim()}\n`;
  clean = clean.replace(THINK_TAG_RE, '');
  const open = clean.match(THINK_OPEN_RE);
  if (open) think += open[1].trim();
  return think.trim();
}

/** meta.skillDetails 条目 → SkillDetail 结构（容错归一；字符串直通、畸形丢弃） */
function normSkillDetail(v: unknown): SkillDetail | string | null {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return null;
  const name = typeof v.name === 'string' ? v.name : '';
  if (!name) return null;
  return {
    name,
    score: typeof v.score === 'number' && Number.isFinite(v.score) ? v.score : 1,
    matchedKeywords: Array.isArray(v.matchedKeywords)
      ? v.matchedKeywords.filter((x): x is string => typeof x === 'string')
      : [],
    bodyLength: typeof v.bodyLength === 'number' ? v.bodyLength : 0,
    forced: v.forced === true,
  };
}

/** span → ToolCallRecord 字段快照（对齐 ChatNodeKernel tool_call/tool_result upsert 的终态） */
function spanToToolCall(span: TraceWindowSpan): ToolCallRecord | null {
  const toolName = span.toolName ?? span.name ?? '';
  if (!toolName) return null;
  return {
    toolName,
    arguments: span.arguments ?? {},
    result: span.result ?? '',
    durationMs: span.durationMs ?? 0,
    success: span.success ?? span.phase !== 'error',
    phase: span.phase as ToolCallRecord['phase'],
    spanId: span.spanId,
    startAt: span.startAt,
    endAt: span.endAt,
    kind: span.kind as ToolCallKind | undefined,
    cardHtml: span.cardHtml,
    purpose: span.purpose,
    summary: span.summary,
    systemChange: span.systemChange,
    changeSummary: span.changeSummary,
  };
}

/**
 * 窗口 → 单 Turn 渲染素材（ConversationTrajectoryItem 同形最小字段）。
 * 返回数组仅为与「多轮窗口」未来形态对齐：当前每轮 doSend 重置 → 恒 0..1 项。
 * 无可展示轨迹 / 空窗口 → null（宿主走消息快照现状路径）。
 */
export function windowToTrajectoryItems(state: TraceWindowState | null): TraceWindowTurnItem[] | null {
  if (!state) return null;
  const reasoning = state.reasoningAccum ?? '';
  const thinkText = reasoning.trim().length > 0 ? reasoning : extractThinkText(state.contentAccum);
  const userText = typeof state.meta.userText === 'string' && state.meta.userText.trim().length > 0
    ? state.meta.userText
    : undefined;

  const toolCalls: ToolCallRecord[] = [];
  for (const span of state.spans) {
    const rec = spanToToolCall(span);
    if (rec) toolCalls.push(rec);
  }

  const matchedSkills: string[] = Array.isArray(state.meta.matchedSkills)
    ? state.meta.matchedSkills.filter((x): x is string => typeof x === 'string')
    : [];
  const skillDetails: (SkillDetail | string)[] = [];
  if (Array.isArray(state.meta.skillDetails)) {
    for (const d of state.meta.skillDetails) {
      const norm = normSkillDetail(d);
      if (norm) skillDetails.push(norm);
    }
  }

  // 可展示轨迹判定与 messages 快照派生 hasTrace 对齐（工具 / 思考 / 技能三者任一）
  const hasTrace = toolCalls.length > 0 || thinkText.trim().length > 0 || skillDetails.length > 0 || matchedSkills.length > 0;
  if (!hasTrace) return null;
  return [{
    userText,
    thinkText: thinkText.trim().length > 0 ? thinkText : undefined,
    toolCalls,
    skillDetails,
    matchedSkills,
  }];
}
