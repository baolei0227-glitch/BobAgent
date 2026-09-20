/**
 * Session 导出投影（batch3-a）：把一次任务的事件日志融合成「与 node .md / 前端渲染等价」的消息序列。
 *
 * 设计说明：
 *  - core 事件（user/assistant/attempt/tool-result）提供「文本主干 + 工具名/参数」；
 *  - SSE 帧（tool_call_update / tool_result / tool_span）提供工具步骤的完整字段
 *    （phase/success/durationMs/kind/summary/spanId/startAt/endAt）；
 *  - 二者按工具名（name）融合——工具名在一轮内唯一度高，足以支撑对照；精确 span 级还原留给
 *    batch3-b 接入 node .md 写回时按 spanId 精确化。
 *
 * 定位：只读纯函数；无消费者前不接入 route.ts（不增加协议载荷）。
 */

import type { TrajectoryEvent } from './event-log';
import { CORE_EVENT } from './event-log';
import { stripThinkTags } from '@/lib/bus';

export interface ExportedToolStep {
  toolName: string;
  arguments: Record<string, unknown>;
  result: string;
  success: boolean;
  phase: string;
  durationMs?: number;
  kind?: string;
  summary?: string;
  spanId?: string;
  startAt?: number;
  endAt?: number;
}

export interface ExportedMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: ExportedToolStep[];
  /** 事件 seq（近似稳定 id） */
  _eventSeq?: number;
}

/** 把 events 融合为可对照导出消息序列 */
export function buildExportMessages(events: TrajectoryEvent[]): ExportedMessage[] {
  const out: ExportedMessage[] = [];
  // 当前打开的"工具轮"assistant 消息 + 按工具名挂起的步骤 registry
  let attempt: { msg: ExportedMessage; steps: Map<string, ExportedToolStep> } | null = null;

  const closeAttempt = () => {
    if (attempt) {
      out.push(attempt.msg);
      attempt = null;
    }
  };
  const stepFor = (name: string): ExportedToolStep | undefined =>
    attempt?.steps.get(name);

  for (const e of events) {
    const p = e.payload;
    if (e.type === CORE_EVENT.USER_MESSAGE) {
      closeAttempt();
      out.push({ role: 'user', content: s(p.content), _eventSeq: e.seq });
    } else if (e.type === CORE_EVENT.ASSISTANT_MESSAGE) {
      closeAttempt();
      out.push({ role: 'assistant', content: s(p.content), reasoning: s(p.reasoning), _eventSeq: e.seq });
    } else if (e.type === CORE_EVENT.ASSISTANT_ATTEMPT) {
      closeAttempt();
      attempt = { msg: { role: 'assistant', content: s(p.content), reasoning: s(p.reasoning), toolCalls: [], _eventSeq: e.seq }, steps: new Map() };
      // 预填工具名/参数（模型调用侧事实）
      if (Array.isArray(p.toolCalls)) {
        for (const tc of p.toolCalls as Array<{ name?: string; arguments?: string }>) {
          const name = tc.name ?? '';
          if (!name) continue;
          attempt.steps.set(name, {
            toolName: name,
            arguments: parseArgs(tc.arguments),
            result: '',
            success: false,
            phase: 'pending',
          });
        }
      }
    } else if (e.type === CORE_EVENT.TOOL_RESULT) {
      const name = s(p.name);
      if (!name || !attempt) continue;
      // core 全文事件晚于 SSE tool_result：若步骤已结算则回补全文，否则留在挂起池
      const step = stepFor(name) ?? attempt.msg.toolCalls?.find((tc) => tc.toolName === name);
      if (step) {
        const full = s(p.content);
        if (full && full.length > (step.result?.length ?? 0)) step.result = full;
        step.success = true;
        if (step.phase === 'pending') step.phase = 'done';
      } else if (attempt.steps.size === 0) {
        // 极端兜底：无任何步骤信息时仍保留文本
        attempt.msg.toolCalls!.push({
          toolName: name,
          arguments: {},
          result: s(p.content),
          success: true,
          phase: 'done',
        });
      }
    }
    // —— SSE 帧：补全工具步骤执行字段 ——
    else if (e.type === 'tool_call_update') {
      const name = s(p.name);
      if (!name || !attempt) continue;
      const step = stepFor(name) ?? { toolName: name, arguments: {}, result: '', success: false, phase: 'pending' };
      if (typeof p.phase === 'string') step.phase = p.phase;
      if (typeof p.startAt === 'number') step.startAt = p.startAt;
      step.spanId = s(p.spanId);
      if (!attempt.steps.has(name)) attempt.steps.set(name, step);
    } else if (e.type === 'tool_result') {
      const name = s(p.name);
      if (!name || !attempt) continue;
      const step = stepFor(name) ?? { toolName: name, arguments: {}, result: '', success: false, phase: 'done' };
      if (typeof p.success === 'boolean') step.success = p.success;
      if (typeof p.phase === 'string') step.phase = p.phase;
      if (typeof p.durationMs === 'number') step.durationMs = p.durationMs;
      if (typeof p.kind === 'string') step.kind = p.kind;
      if (typeof p.summary === 'string') step.summary = p.summary;
      if (typeof p.endAt === 'number') step.endAt = p.endAt;
      step.spanId = s(p.spanId) ?? step.spanId;
      // SSE 帧为截断结果；core tool/result 的完整文本优先（已在前置分支处理）
      if (typeof p.result === 'string' && p.result && !step.result) step.result = p.result;
      if (!attempt.steps.has(name)) attempt.steps.set(name, step);
      // 步骤结算：并入消息 toolCalls（按尝试顺序保持稳定）
      attempt.msg.toolCalls!.push(step);
      attempt.steps.delete(name);
    } else if (e.type === 'tool_span') {
      // tool_span 仅作耗时修正（已在 tool_result 携带，无需额外处理）
    }
  }
  closeAttempt();
  return out;
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/* ==================== append 摘要派生（batch3-b 方案 A/C 共用） ==================== */

/** OutputFile 产物声明行（与前端 extractOutputFileBlocks 同口径） */
const OUTPUT_FILE_LINE_RE = /^\s*OutputFile:\s*\S/;

/** 剥离思考块与 OutputFile 标记行后的「用户可见正文」；无任何正文时返回空串。 */
export function visibleAnswerBody(content: string | undefined): string {
  if (!content) return '';
  return stripThinkTags(content)
    .split(/\r?\n/)
    .filter((ln) => !OUTPUT_FILE_LINE_RE.test(ln))
    .join('\n')
    .trim();
}

export interface AppendDerivedPayload {
  question?: string;
  answer?: string;
  reasoning?: string;
  toolCalls?: ExportedToolStep[];
  /** 输出文件卡（取自 output_files SSE 帧 files） */
  outputFiles?: Array<{ path: string; name: string; size: number; kind: string; source?: string }>;
  /** 任务内出现过的工具名（供诊断） */
  toolNames?: string[];
}

/**
 * 把一次任务的事件日志派生为「前端 append 等价摘要」——方案 A 的 derive 分支核心，
 * 也是方案 C 一致性单测的比对对象：
 *  - question：首条 user/message 原文
 *  - answer/reasoning：末条 assistant/message（终答）；无终答（中断）返回空 answer。
 *    例外兜底：终答为「空壳」（剥掉 think 与 OutputFile 行后无正文，典型即工具返回后
 *    只回一行 OutputFile）时，answer 改用此前 assistant/attempt 轮打捞到的可见正文 +
 *    终答 OutputFile 行，防止模型写在工具调用轮的完整答复落盘时丢失。
 *  - toolCalls：全部工具轮步骤（按事件序）
 *  - outputFiles：output_files SSE 帧（最终一次）files
 */
export function appendPayloadFromEvents(events: TrajectoryEvent[]): AppendDerivedPayload {
  const msgs = buildExportMessages(events);

  const firstUser = msgs.find((m) => m.role === 'user');
  let finalAssistant: ExportedMessage | undefined = msgs[msgs.length - 1];
  if (!finalAssistant || finalAssistant.role !== 'assistant') finalAssistant = undefined;

  // ── 空壳终答打捞（2026-09-16 事故修复）────────────────────────────────────
  // 事故形态：模型把完整答复写在「带 write_file 工具调用的那一轮」assistant 文本里，
  // 工具返回后的终答只输出一行 OutputFile。落盘 answer 只取终答 → 正文全丢、只剩产物卡片。
  // 兜底：终答剥掉 think/OutputFile 行后无任何可见正文时，从本轮此前的 assistant/attempt
  // 文本中打捞可见正文（保序、整块去重），末尾保留终答的 OutputFile 行供产物卡片解析。
  let answer = finalAssistant?.content || undefined;
  if (answer !== undefined && visibleAnswerBody(answer) === '') {
    const salvaged: string[] = [];
    for (const m of msgs) {
      if (m.role !== 'assistant' || m === finalAssistant) continue;
      const body = visibleAnswerBody(m.content);
      if (body && !salvaged.includes(body)) salvaged.push(body);
    }
    if (salvaged.length > 0) {
      const finalTail = stripThinkTags(answer).trim(); // 保留 OutputFile 标记行
      answer = finalTail ? `${salvaged.join('\n\n')}\n${finalTail}` : salvaged.join('\n\n');
    }
  }

  const toolCalls: ExportedToolStep[] = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.toolName && !toolCalls.some((x) => x.toolName === tc.toolName && x.spanId === tc.spanId)) {
          toolCalls.push(tc);
        }
      }
    }
  }

  let outputFiles: AppendDerivedPayload['outputFiles'] = undefined;
  for (const e of events) {
    if (e.type === 'output_files' && Array.isArray(e.payload?.files) && (e.payload.files as unknown[]).length > 0) {
      outputFiles = e.payload.files as AppendDerivedPayload['outputFiles'];
    }
  }

  return {
    question: firstUser?.content || undefined,
    answer,
    reasoning: finalAssistant?.reasoning || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    outputFiles,
    toolNames: [...new Set(toolCalls.map((t) => t.toolName))],
  };
}
