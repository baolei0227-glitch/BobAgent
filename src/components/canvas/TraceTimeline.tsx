/**
 * TraceTimeline — dsh Trajectory 风格统一执行轨迹视图
 *
 * 对齐 DeepSeek Harness（deepseek-ai/deepseek-harness，packages/client/ui-trajectory）：
 *   - Overview 三泳道时间线：Input(输入/上下文) / Model(模型思考) / Tools(工具调用)，
 *     等宽 ↔ 实际耗时两投影，点击色块定位事件行
 *   - 事件表按 Turn 组织；信任摘要（TraceSummary）默认折叠，展开即完整轨迹
 *   - 产物内联：截图缩略图 / cardHtml 在事件行下就地展示
 *   - 行内记录检查器（dsh local inspector）：选中事件就地展开明细，替代弹窗
 *
 * 保留原能力：
 *   - 工具卡片（cardHtml）、模板填充按钮（fill_template）
 *   - 旧接口（thinkText / toolCalls / skillDetails）自动 assemble
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain, Sparkles, Wrench, Plug, Eye, RefreshCw, HardDrive,
  CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, FilePen, Hammer,
  Copy, Search, Clock3, PanelRight, ListCollapse, X, Play, Square, GitFork, Settings2,
  History,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TraceSpan, ToolCallRecord, SkillDetail, ThinkingStage } from '@/lib/types';
import { parseThinkingToSpans } from '@/lib/thinking-parser';
import { HtmlRenderer } from './HtmlRenderer';
import Lightbox from 'yet-another-react-lightbox';
import 'yet-another-react-lightbox/styles.css';

/* ==================== 图标 & 配色 ==================== */

const KIND_ICON: Record<TraceSpan['kind'], React.ComponentType<{ className?: string }>> = {
  thinking_phase: Brain,
  skill_load: Sparkles,
  tool_call: Wrench,
  mcp_call: Plug,
  vision_stage: Eye,
  model_switch: RefreshCw,
  system_change: Hammer,
  memory_compact: HardDrive,
};

/** 事件类型 → 标签（dsh 账本 kind tag，UI 文案统一英文） */
const KIND_LABEL: Record<TraceSpan['kind'], string> = {
  thinking_phase: 'Think',
  skill_load: 'Skill',
  tool_call: 'Tool',
  mcp_call: 'MCP',
  vision_stage: 'Vision',
  model_switch: 'Model',
  system_change: 'Sys',
  memory_compact: 'Memory',
};

/** 事件类型 → 主题色（Overview 色块 / 圆点 / 徽标共用） */
function kindColor(kind: TraceSpan['kind'], phase: TraceSpan['phase']): string {
  if (phase === 'error') return 'var(--danger)';
  switch (kind) {
    case 'thinking_phase': return 'var(--primary-strong)';
    case 'skill_load': return 'oklch(0.72 0.16 85)';
    case 'tool_call': return 'var(--info)';
    case 'mcp_call': return 'var(--info)';
    case 'vision_stage': return 'oklch(0.60 0.18 170)';
    case 'model_switch': return 'oklch(0.65 0.15 260)';
    case 'system_change': return 'var(--warn)';
    case 'memory_compact': return 'color-mix(in oklab, var(--ink-muted) 70%, transparent)';
  }
}

/* ==================== 辅助：从旧 ToolCallRecord + SkillDetail + thinkText 组装 TraceSpan 列表 ==================== */

let _spanSeq = 0;
function nid() { return `sp-${Date.now().toString(36)}-${(_spanSeq++).toString(36)}`; }

const THINKING_STAGE_ICON: Record<ThinkingStage, string> = {
  understanding: 'U',
  decomposition: 'D',
  reasoning: 'R',
  verification: 'V',
  other: '·',
};

export function assembleTraceSpans(opts: {
  thinkText?: string;
  toolCalls: ToolCallRecord[];
  skillDetails: (SkillDetail | string)[];
  matchedSkillNames: string[];
  /** 流式模式（断点3修复）：思考解析始终产出可见 span 承载实时文本，未完成尾部由 UI 标记 running */
  streaming?: boolean;
}): TraceSpan[] {
  const spans: TraceSpan[] = [];
  const now = Date.now();

  // 1. 思考阶段（若存在 thinkText）
  if (opts.thinkText && opts.thinkText.trim().length > 0) {
    const parsed = parseThinkingToSpans(opts.thinkText, { streaming: opts.streaming });
    for (const s of parsed.spans) {
      spans.push({
        id: nid(),
        kind: 'thinking_phase',
        title: `${THINKING_STAGE_ICON[s.stage]} ${s.stageTitle}`,
        phase: 'done',
        startAt: now,
        endAt: now,
        durationMs: 0,
        success: true,
        meta: {
          stage: s.stage,
          stageTitle: s.stageTitle,
          content: s.content,
          summary: s.content.length > 120 ? s.content.slice(0, 120) + '…' : s.content,
        },
      });
    }
    if (parsed.unclassified) {
      spans.push({
        id: nid(),
        kind: 'thinking_phase',
        title: `${THINKING_STAGE_ICON.other} Free thinking`,
        phase: 'done',
        startAt: now,
        endAt: now,
        durationMs: 0,
        success: true,
        meta: {
          stage: 'other',
          stageTitle: 'Free thinking',
          content: parsed.unclassified,
          summary: parsed.unclassified.length > 120 ? parsed.unclassified.slice(0, 120) + '…' : parsed.unclassified,
        },
      });
    }
  }

  // 2. 技能加载步骤
  for (const item of opts.skillDetails) {
    if (typeof item === 'string') {
      spans.push({
        id: nid(),
        kind: 'skill_load',
        title: `Skill context loaded: ${item}`,
        phase: 'done',
        startAt: now,
        endAt: now,
        durationMs: 0,
        success: true,
        meta: { skillName: item, matchScore: 1, forced: true, matchedKeywords: [] },
      });
      continue;
    }
    spans.push({
      id: nid(),
      kind: 'skill_load',
      title: `${item.forced ? '[manual] ' : ''}Skill loaded: ${item.name} (${Math.round(item.score * 100)}%)`,
      phase: 'done',
      startAt: now,
      endAt: now,
      durationMs: 0,
      success: true,
      meta: {
        skillName: item.name,
        matchScore: item.score,
        matchedKeywords: item.matchedKeywords,
        forced: item.forced,
        purpose: item.matchedKeywords.length > 0
          ? `Matched: ${item.matchedKeywords.slice(0, 6).join(', ')}${item.matchedKeywords.length > 6 ? '…' : ''}`
          : undefined,
      },
    });
  }
  if (opts.skillDetails.length === 0) {
    for (const name of opts.matchedSkillNames) {
      spans.push({
        id: nid(),
        kind: 'skill_load',
        title: `Skill context loaded: ${name}`,
        phase: 'done',
        startAt: now,
        endAt: now,
        durationMs: 0,
        success: true,
        meta: { skillName: name, matchScore: 1, forced: true, matchedKeywords: [] },
      });
    }
  }

  // 3. 工具步骤（P1：优先用服务端 spanId 稳定 id + 真实时间戳）
  for (const tc of opts.toolCalls) {
    const kind = tc.kind ?? (tc.toolName.startsWith('mcp__') ? 'mcp_call' : 'tool_call');
    const systemChange = classifySystemChange(tc.toolName, tc.arguments ?? {});
    const purpose = tc.purpose || resolvePurpose(tc.toolName);
    const argsText = summarizeArgs(tc.toolName, tc.arguments ?? {});
    const phase = (tc.phase ?? (tc.success ? 'done' : (tc.success === false ? 'error' : 'done'))) as TraceSpan['phase'];
    const result = tc.result ?? '';
    const resultShort = result.length > 200 ? result.slice(0, 200) + '…' : result;
    // P1：服务端下发的真实时间戳，fallback 到渲染期 now（历史消息兜底）
    const spStart = tc.startAt ?? now;
    const spEnd = tc.endAt ?? now;
    const spDuration = tc.endAt && tc.startAt ? (tc.endAt - tc.startAt) : tc.durationMs;

    if (systemChange.change) {
      spans.push({
        id: tc.spanId ? `change-${tc.spanId}` : nid(),
        kind: 'system_change',
        title: systemChange.summary || 'System change',
        phase,
        startAt: spStart,
        endAt: spEnd,
        durationMs: spDuration,
        success: tc.success !== false,
        meta: {
          changeType: systemChange.type,
          changeSummary: systemChange.summary,
          changeDetail: resultShort || undefined,
          errorMessage: phase === 'error' ? result : undefined,
        },
      });
    }

    spans.push({
      id: tc.spanId ?? nid(),
      kind: kind === 'mcp' ? 'mcp_call' : kind as TraceSpan['kind'],
      title: argsText,
      phase,
      startAt: spStart,
      endAt: spEnd,
      durationMs: spDuration,
      success: tc.success !== false,
      meta: {
        toolName: tc.toolName,
        arguments: tc.arguments,
        result,
        cardHtml: tc.cardHtml,
        purpose,
        summary: tc.summary || resultShort,
        errorMessage: phase === 'error' ? result : undefined,
      },
    });
  }

  return spans;
}

/* ==================== 工具辅助逻辑（保留原实现） ==================== */

const TOOL_PURPOSE: Record<string, string> = {
  read_file: 'Read project file',
  list_directory: 'List directory structure',
  search_files: 'Search project files by keyword',
  write_file: 'Write / save file to project',
  run_command: 'Run terminal command',
  read_attachment: 'Read source file (attachment / material)',
  ocr_document: 'OCR text recognition on document/image',
  crop_image: 'Crop image region for review',
  parse_image: 'Recognize image content',
  read_upstream_node: 'Read upstream node output',
  intern_search: 'Search project nodes / sources',
  web_search: 'Search the web for public info',
  web_fetch: 'Fetch web page content',
  browser_control: 'Control real browser for web actions',
  manage_mcp_server: 'Manage MCP server connections',
  intern_statute_search: 'Search statutes & regulations',
  intern_case_search: 'Search case precedents',
};

function resolvePurpose(toolName: string): string {
  const direct = TOOL_PURPOSE[toolName];
  if (direct) return direct;
  const m = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (m) return `Call MCP ${m[1]} → ${m[2]}`;
  return '';
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return `${toolName}()`;
  const keys = ['path', 'command', 'query', 'url', 'pattern', 'title', 'name', 'filePath'];
  const parts: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (v === undefined || v === null) continue;
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}="${str.length > 40 ? str.slice(0, 40) + '…' : str}"`);
  }
  if (parts.length === 0) {
    const entries = Object.entries(args);
    const first = entries[0];
    if (first) {
      const str = typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1]);
      parts.push(`${first[0]}="${str.length > 40 ? str.slice(0, 40) + '…' : str}"`);
    }
  }
  return `${toolName}(${parts.join(', ')})`;
}

function classifySystemChange(toolName: string, args: Record<string, unknown>) {
  let type: 'file_write' | 'file_delete' | 'file_rename' | 'pkg_install' | 'pkg_uninstall' | 'config_change' | 'script_exec' | undefined;
  let summary: string | undefined;
  switch (toolName) {
    case 'write_file': case 'append_file':
      type = 'file_write';
      summary = `Write file ${typeof args.path === 'string' ? args.path : ''}`; break;
    case 'delete_file':
      type = 'file_delete';
      summary = `Delete file ${typeof args.path === 'string' ? args.path : ''}`; break;
    case 'rename_file':
      type = 'file_rename';
      summary = 'Rename / move file'; break;
    case 'manage_mcp_server':
      type = 'config_change';
      summary = 'Update MCP server config'; break;
    case 'run_command': {
      const cmd = String(args.command ?? '');
      const m = cmd.match(/(?:pip3?|npm|pnpm|yarn|brew|apt(?:-get)?|apk|gem|composer|poetry)\s+(install|add|uninstall|remove|upgrade|update|i)\b/i);
      if (m) {
        const action = m[1].toLowerCase();
        type = (action === 'uninstall' || action === 'remove') ? 'pkg_uninstall' : 'pkg_install';
        summary = `${type === 'pkg_install' ? 'Install' : 'Uninstall'} package: ${m[0]}`;
      } else if (/(?:python3?\s+[^\s]+\.py|node\s+[^\s]+\.js|\.\/[a-zA-Z0-9_-]+\.sh|make\b)/.test(cmd)) {
        type = 'script_exec';
        summary = 'Run script / build';
      }
      break;
    }
  }
  return { change: !!type, type, summary };
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 判断事件是否属于"工具调用类"（用于 Calls 折叠） */
function isToolKind(kind: TraceSpan['kind']): boolean {
  return kind === 'tool_call' || kind === 'mcp_call';
}

/** 从工具结果文本中提取截图 dataUrl（browser.screenshot 等返回 base64 图片）。
 * 兼容 JSON 序列化后的 \/ 转义；最多取 3 张避免超大 base64 撑爆渲染。 */
function extractImagesFromDetail(detail: string): string[] {
  if (!detail) return [];
  const out: string[] = [];
  // data:image/png;base64,xxx —— 兼容 JSON 里反斜杠转义的 data:image\/png;base64,xxx
  const re = /data:image\/(?:png|jpeg|webp|gif)(\\?\/);base64,([A-Za-z0-9+/=]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(detail)) !== null) {
    if (out.length >= 3) break;
    // 还原反斜杠转义：data:image\/png → data:image/png
    const src = m[0].replace(/\\\//g, '/');
    out.push(src);
  }
  return out;
}

/** 仅计数（不取图、不设上限）：用于信任摘要里"N screenshots"。 */
function countImagesInResult(result: string): number {
  if (!result) return 0;
  const re = /data:image\/(?:png|jpeg|webp|gif)(\\?\/);base64,/g;
  const m = result.match(re);
  return m ? m.length : 0;
}

/** 是否属于"网络核实"类工具（用于摘要里"N sources"；兼容 MCP 前缀）。 */
function isWebSourceTool(toolName: string): boolean {
  if (toolName === 'web_search' || toolName === 'web_fetch') return true;
  return /^mcp__.+__(?:web_search|web_fetch)$/.test(toolName);
}

/* ==================== dsh 三泳道 Overview 语义 ==================== */

/** dsh 泳道：input(输入/上下文) / model(模型思考) / tools(工具调用) */
type TraceLane = 'input' | 'model' | 'tools';
const LANE_ORDER: TraceLane[] = ['input', 'model', 'tools'];
const LANE_LABEL: Record<TraceLane, string> = { input: 'Input', model: 'Model', tools: 'Tools' };

/** 事件 → 泳道（对齐 dsh：user/context 入 Input、assistant/reasoning 入 Model、tool/subtool 入 Tools） */
function laneOf(kind: TraceSpan['kind']): TraceLane {
  if (kind === 'thinking_phase') return 'model';
  if (kind === 'tool_call' || kind === 'mcp_call' || kind === 'system_change') return 'tools';
  return 'input';
}

/** 工具结果 → 行内单行预览（剥 base64 图片、压缩空白、限长）；无可展示返回 null。
 *  对齐 dsh 账本 tool 行「名称 → 结果」的原地摘要。 */
function toolResultPreview(result?: string): string | null {
  if (!result) return null;
  const cleaned = result
    .replace(/data:image\/(?:png|jpeg|webp|gif)(\\?\/);base64,[A-Za-z0-9+/=]+/g, '[img]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '...') return null;
  const withoutImgs = cleaned.replace(/\[img\]/g, '').trim();
  if (!withoutImgs) return null;
  return cleaned.length > 140 ? `${cleaned.slice(0, 140)}…` : cleaned;
}

/* ==================== 事件检查器 ==================== */

export function EventInspector({
  span,
  isStreaming,
}: {
  span: TraceSpan;
  isStreaming: boolean;
}) {
  const Icon = KIND_ICON[span.kind] ?? Wrench;
  const color = kindColor(span.kind, span.phase);
  const duration = formatDuration(span.durationMs ?? 0);
  const isTool = span.kind === 'tool_call' || span.kind === 'mcp_call';
  const isThinking = span.kind === 'thinking_phase';

  return (
    <div className="flex h-full flex-col gap-2.5 min-w-0 w-full">
      {/* 头部：图标 + 类型 + 状态 */}
      <div className="flex items-center gap-2 min-w-0">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: 'color-mix(in oklab, var(--paper-soft) 60%, transparent)', color }}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color }}>
              {KIND_LABEL[span.kind]}
            </span>
            {span.phase === 'running' && (
              <Loader2 className="h-3 w-3 animate-spin" style={{ color: 'var(--ink-muted)' }} />
            )}
            {span.phase === 'error' && (
              <span className="text-11 font-medium" style={{ color: 'var(--danger)' }}>Failed</span>
            )}
          </div>
          <div className="truncate text-13 font-medium [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ color: 'var(--ink)' }}>
            {span.title}
          </div>
        </div>
      </div>

      {/* 元信息行 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
        {duration && (
          <span className="inline-flex items-center gap-1">
            <Clock3 className="h-3 w-3" /> {duration}
          </span>
        )}
        {span.meta?.toolName && (
          <span className="inline-flex items-center gap-1">
            <Wrench className="h-3 w-3" /> {span.meta.toolName}
          </span>
        )}
        {span.meta?.stageTitle && (
          <span>Stage: {span.meta.stageTitle}</span>
        )}
        {span.meta?.skillName && (
          <span className="inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3" /> {span.meta.skillName}
          </span>
        )}
      </div>

      <div className="h-px w-full" style={{ backgroundColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }} />

      {/* 详情区（可滚动） */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
        {span.meta?.purpose && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>Purpose</div>
            <div className="text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ color: 'color-mix(in oklab, var(--ink) 85%, transparent)' }}>
              {span.meta.purpose}
            </div>
          </div>
        )}

        {span.kind === 'system_change' && span.meta?.changeSummary && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'var(--warn)' }}>System change</div>
            <div className="text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ color: 'color-mix(in oklab, var(--warn) 80%, transparent)' }}>
              <FilePen className="h-2.5 w-2.5 inline mr-1 align-[-2px]" />
              {span.meta.changeSummary}
              {span.meta.changeDetail && (
                <div className="mt-0.5 text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                  {span.meta.changeDetail}
                </div>
              )}
            </div>
          </div>
        )}

        {isThinking && span.meta?.content && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>Reasoning</div>
            <div className="whitespace-pre-wrap text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ color: 'color-mix(in oklab, var(--ink) 88%, transparent)' }}>
              {span.meta.content}
            </div>
          </div>
        )}

        {isTool && span.meta?.arguments && Object.keys(span.meta.arguments).length > 0 && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>Parameters</div>
            <pre className="rounded-md p-2 text-11 leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>
              {JSON.stringify(span.meta.arguments, null, 2)}
            </pre>
          </div>
        )}

        {isTool && span.meta?.summary && span.meta.summary !== span.meta.result && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>Summary</div>
            <div className="text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ color: 'color-mix(in oklab, var(--ink) 88%, transparent)' }}>
              {span.meta.summary}
            </div>
          </div>
        )}

        {span.meta?.result && span.meta.result.trim() !== '' && span.meta.result !== '...' && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: span.phase === 'error' ? 'var(--danger)' : 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
              Result
            </div>
            <div
              className="ai-canvas-scroll max-h-[240px] overflow-y-auto whitespace-pre-wrap text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere] pr-1"
              style={{ color: span.phase === 'error' ? 'color-mix(in oklab, var(--danger) 88%, transparent)' : 'color-mix(in oklab, var(--ink) 88%, transparent)' }}
            >
              {span.meta.result}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

/** 流式思考行标题（断点5修复）：取思考文本尾部（最近生成的内容）压缩为单行摘要，
 *  替代固定 "Thinking..." 文案——用户不用滚动内容区也能在标题行看到"在想什么" */
function liveThinkingTitle(content: string | undefined): string {
  if (!content) return 'Thinking...';
  const flattened = content.replace(/\s+/g, ' ').trim();
  if (!flattened) return 'Thinking...';
  return flattened.length > 64 ? `… ${flattened.slice(-64)}` : flattened;
}

/* ==================== 事件行 ==================== */

function EventRow({
  span,
  selected,
  highlighted,
  onSelect,
}: {
  span: TraceSpan;
  selected: boolean;
  highlighted: boolean;
  onSelect: (id: string) => void;
}) {
  const Icon = KIND_ICON[span.kind] ?? Wrench;
  const color = kindColor(span.kind, span.phase);
  const duration = formatDuration(span.durationMs ?? 0);
  const success = span.success ?? span.phase === 'done';
  const isThinking = span.kind === 'thinking_phase';
  const isTool = span.kind === 'tool_call' || span.kind === 'mcp_call';
  // 工具类事件优先展示「目的短标题」，参数摘要下移为副行（与已合并的执行步骤展示对齐）
  const rowTitle = isThinking && span.phase === 'running'
    ? liveThinkingTitle(span.meta?.content)
    : (isTool && span.meta?.purpose) || span.title;

  // 产物内联：工具结果截图 / cardHtml 就地展示，不再锁进事件详情弹窗（少钻一层）
  const images = useMemo(() => (isTool ? extractImagesFromDetail(span.meta?.result ?? '') : []), [isTool, span.meta?.result]);
  const cardHtml = isTool ? span.meta?.cardHtml : undefined;
  // 行内结果预览（dsh：tool 行 名称 → 结果 单行小结）
  const toolInline = useMemo(() => (isTool ? toolResultPreview(span.meta?.result) : null), [isTool, span.meta?.result]);
  const [cardOpen, setCardOpen] = useState(false);
  const [lightbox, setLightbox] = useState<{ open: boolean; index: number; slides: { src: string }[] }>({ open: false, index: 0, slides: [] });

  return (
    <div
      className={cn(
        'w-full min-w-0 transition-colors',
        selected && 'bg-[color:color-mix(in_oklab,var(--primary-strong)_12%,transparent)]',
      )}
      style={{
        borderRadius: 8,
        border: '0.5px solid color-mix(in oklab, var(--line) 22%, transparent)',
        backgroundColor: selected ? undefined : 'color-mix(in oklab, var(--paper) 35%, transparent)',
        ...(selected ? { boxShadow: 'inset 0 0 0 2px color-mix(in oklab, var(--primary-strong) 80%, transparent)' } : {}),
        ...(highlighted ? { boxShadow: `0 0 0 1px ${color}` } : {}),
      }}
    >
      <div
        className="flex w-full min-w-0 cursor-pointer select-none items-center"
        style={{ minHeight: 38, padding: '0 8px 0 20px', gap: 24 }}
        onClick={() => onSelect(span.id)}
        title={span.title}
      >
        {/* 账本行左槽：kind 徽标（dsh tag 语义，tagSlot 80px + tag 22px 高 / 6px 圆角 / 13px 强字重） */}
        <span className="flex shrink-0 items-center" style={{ width: 80, minWidth: 0 }}>
          <span
            className="inline-flex items-center whitespace-nowrap"
            style={{
              height: 22,
              maxWidth: '100%',
              padding: '0 4px',
              gap: 4,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              color,
              backgroundColor: `color-mix(in oklab, ${color} 13%, transparent)`,
            }}
          >
            <Icon className="h-3.5 w-3.5" />
            {KIND_LABEL[span.kind]}
          </span>
        </span>
        {/* 内容 */}
        <div className="min-w-0 flex-1" style={{ fontSize: 13 }}>
          <div
            className={cn(
              'truncate leading-snug [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]',
              span.phase === 'error' && 'text-[color:var(--danger)]',
            )}
            style={{ color: span.phase === 'error' ? undefined : 'var(--ink)' }}
          >
            {rowTitle}
          </div>
          <div className="truncate" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)', fontSize: 12 }}>
            {isTool ? (
              <>
                <span>{span.meta?.purpose ? span.title : (span.meta?.toolName ?? KIND_LABEL[span.kind])}</span>
                {toolInline && (span.phase === 'done' || span.phase === 'error') && (
                  <span
                    className="ml-1"
                    style={{
                      color: span.phase === 'error' ? 'var(--danger)' : 'color-mix(in oklab, var(--ink-muted) 60%, transparent)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    → {toolInline}
                  </span>
                )}
              </>
            ) : (
              <>
                {KIND_LABEL[span.kind]}
                {span.meta?.toolName && span.meta.toolName !== span.title ? ` · ${span.meta.toolName}` : ''}
              </>
            )}
          </div>
        </div>
        {/* 右侧状态（dsh trailing：耗时列 71px 定宽右对齐 + 状态图标 12px） */}
        <div className="flex shrink-0 items-center" style={{ gap: 12 }}>
          <span className="flex items-center justify-end" style={{ width: 71, fontSize: 13, color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
            {duration && span.phase !== 'pending' && span.phase !== 'running' ? duration : ''}
          </span>
          {span.phase === 'running' ? (
            <Loader2 className="h-3 w-3 animate-spin" style={{ color: 'var(--primary)' }} />
          ) : span.phase === 'pending' ? (
            <span style={{ fontSize: 13, color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>…</span>
          ) : span.phase === 'error' ? (
            <XCircle className="h-3 w-3 shrink-0" style={{ color: 'var(--danger)' }} />
          ) : span.phase === 'skipped' ? (
            <Copy className="h-3 w-3 shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)', opacity: 0.4 }} />
          ) : success ? (
            <CheckCircle2 className="h-3 w-3 shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 45%, transparent)' }} />
          ) : (
            <XCircle className="h-3 w-3 shrink-0" style={{ color: 'var(--danger)' }} />
          )}
          <ChevronRight className="h-3 w-3" style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)' }} />
        </div>
      </div>

      {/* 思考行运行中：实时渲染思考全文（逐 token 刷新，末尾呼吸光标），
          完成后收起为标题行，全文进事件检查器的 Reasoning 区。 */}
      {isThinking && span.phase === 'running' && span.meta?.content && (
        <div className="px-2 pb-1.5">
          <div
            className="ai-canvas-scroll max-h-[320px] overflow-y-auto whitespace-pre-wrap border-l-2 py-1 pl-2 pr-1 text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]"
            style={{
              borderColor: color,
              color: 'color-mix(in oklab, var(--ink) 88%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--paper-soft) 35%, transparent)',
            }}
          >
            {span.meta.content}
            <span
              className="ml-0.5 inline-block h-3 w-[2px] animate-pulse align-text-bottom"
              style={{ backgroundColor: 'var(--primary-strong)', borderRadius: 1 }}
              title="Thinking"
            />
          </div>
        </div>
      )}

      {/* 产物内联：截图缩略图 / cardHtml 卡片在事件行下就地展示（点击缩略图放大，卡片折叠展开） */}
      {isTool && (images.length > 0 || cardHtml) && (
        <div className="px-2 pb-1.5">
          {images.length > 0 && (
            <div className="mb-1 flex flex-wrap gap-1.5">
              {images.map((src, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="group relative cursor-pointer overflow-hidden rounded border"
                  style={{ borderColor: 'color-mix(in oklab, var(--line) 35%, transparent)' }}
                  title="Preview screenshot"
                  onClick={(e) => { e.stopPropagation(); setLightbox({ open: true, index: idx, slides: images.map((s) => ({ src: s })) }); }}
                >
                  <img src={src} alt={`截图 ${idx + 1}`} className="block max-h-[120px] w-auto transition-opacity group-hover:opacity-85" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {cardHtml && (
            <div>
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1 py-0.5 text-11 font-medium transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-soft)_50%,transparent)]"
                style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
                onClick={(e) => { e.stopPropagation(); setCardOpen((v) => !v); }}
              >
                <PanelRight className="h-3 w-3" />
                {cardOpen ? 'Hide card' : 'View card'}
                <ChevronDown className={cn('h-3 w-3 transition-transform', cardOpen && 'rotate-180')} />
              </button>
              {cardOpen && (
                <div
                  className="ai-canvas-scroll mt-1 max-h-[280px] overflow-y-auto rounded-md border border-dashed px-2 py-1.5"
                  style={{ borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)' }}
                >
                  <HtmlRenderer content={cardHtml} />
                </div>
              )}
            </div>
          )}
          {images.length > 0 && (
            <Lightbox
              open={lightbox.open}
              close={() => setLightbox((s) => ({ ...s, open: false }))}
              index={lightbox.index}
              slides={lightbox.slides}
              on={{ click: () => setLightbox((s) => ({ ...s, open: false })) }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ==================== 信任摘要行 ==================== */

/** 可折叠成一行摘要的信任信号条（dsh 会话流「已完成回答前折叠过程内容」）：`N steps · 产物 · 耗时`，点击展开完整轨迹。 */
function TraceSummary({
  toolCount,
  imageCount,
  cardCount,
  sourceCount,
  durationMs,
  onExpand,
}: {
  toolCount: number;
  imageCount: number;
  cardCount: number;
  sourceCount: number;
  durationMs?: number;
  onExpand: () => void;
}) {
  const bits: string[] = [`${toolCount} steps`];
  if (imageCount > 0) bits.push(`${imageCount} screenshot${imageCount > 1 ? 's' : ''}`);
  if (cardCount > 0) bits.push(`${cardCount} card${cardCount > 1 ? 's' : ''}`);
  if (sourceCount > 0) bits.push(`${sourceCount} source${sourceCount > 1 ? 's' : ''}`);
  if (durationMs && durationMs > 0) bits.push(`${(durationMs / 1000).toFixed(1)}s`);

  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-soft)_50%,transparent)]"
    >
      <Settings2 className="h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }} />
      <span className="text-xs leading-relaxed" style={{ color: 'color-mix(in oklab, var(--ink-muted) 65%, transparent)' }}>
        {bits.join(' · ')}
      </span>
      <span className="flex-1" />
      <span className="text-xs font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
        View process
      </span>
      <ChevronDown className="h-3 w-3" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }} />
    </button>
  );
}

/* ==================== 主组件：TraceTimeline（dsh Trajectory 风格） ==================== */

export interface TraceTimelineProps {
  spans?: TraceSpan[];
  /** 兼容旧接口：直接传 toolCalls / skills / thinkText，内部自动 assemble */
  thinkText?: string;
  toolCalls?: ToolCallRecord[];
  skillDetails?: (SkillDetail | string)[];
  matchedSkillNames?: string[];
  isStreaming: boolean;
  /** 整轮耗时 ms（消息级 stats.durationMs），用于信任摘要展示；缺省时不显示耗时。 */
  durationMs?: number;
  /** 外层驱动：版本号递增时，自动折叠整轮 Turn 并强制收起 Thinking 组（"思考完成"时机）。undefined 时不生效。 */
  thinkingGroupFoldVersion?: number;
  /** 会话内请求序号（dsh Request #N 边界锚）；缺省不显示。 */
  requestNumber?: number;
  /** P3 轨迹：Fork 回调（选中事件后，从该点之前的上文分叉继续） */
  onFork?: (span: TraceSpan) => void;
}

export function TraceTimeline({
  spans: propSpans,
  thinkText,
  toolCalls = [],
  skillDetails = [],
  matchedSkillNames = [],
  isStreaming,
  durationMs,
  requestNumber,
  onFork,
}: TraceTimelineProps) {
  const spans = useMemo(() => {
    const raw = propSpans && propSpans.length > 0
      ? propSpans
      : assembleTraceSpans({ thinkText, toolCalls, skillDetails, matchedSkillNames, streaming: isStreaming });

    // 流式中：把最后一个 thinking_phase 强制标记为 running，用于"思考进行中"指示
    if (!isStreaming) return raw;
    const thinkingIdxs: number[] = [];
    raw.forEach((s, i) => { if (s.kind === 'thinking_phase') thinkingIdxs.push(i); });
    if (thinkingIdxs.length === 0) return raw;
    const lastIdx = thinkingIdxs[thinkingIdxs.length - 1];
    const last = raw[lastIdx];
    if (last.phase === 'done' || last.phase === 'pending') {
      const clone = raw.slice();
      clone[lastIdx] = { ...last, phase: 'running' };
      return clone;
    }
    return raw;
  }, [propSpans, thinkText, toolCalls, skillDetails, matchedSkillNames, isStreaming]);

  // dsh 视图状态
  const [durationMode, setDurationMode] = useState<'equal' | 'actual'>('actual');
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 行内检查器：显式点击事件行（或时间线色块）时打开，就地展开明细
  const [detailId, setDetailId] = useState<string | null>(null);
  // dsh 全面展示：默认展开完整轨迹（含事件表），用户可折叠；历史消息同理
  const [turnCollapsed, setTurnCollapsed] = useState(false);
  // 区块级折叠（收起为摘要一行）仅由用户手动触发；默认全展开让 dsh 账本可见
  const [blockCollapsed, setBlockCollapsed] = useState(false);

  // P3 replay：逐事件回放（spans 从 0 逐步显示，模拟"当时怎么一步步执行"）
  const [replaying, setReplaying] = useState(false);
  const [replayCount, setReplayCount] = useState(0);
  const replayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 开始/停止回放：逐步显示 spans；播完自动复位
  const toggleReplay = () => {
    if (replaying) {
      if (replayTimerRef.current) clearInterval(replayTimerRef.current);
      replayTimerRef.current = null;
      setReplaying(false);
      setReplayCount(0);
      return;
    }
    // 展开 Turn 以便看到回放过程
    setTurnCollapsed(false);
    setReplayCount(0);
    setReplaying(true);
    replayTimerRef.current = setInterval(() => {
      setReplayCount((c) => {
        if (c >= spans.length) {
          if (replayTimerRef.current) clearInterval(replayTimerRef.current);
          replayTimerRef.current = null;
          setReplaying(false);
          return c;
        }
        return c + 1;
      });
    }, 280);
  };

  // 组件卸载时清理回放定时器
  useEffect(() => () => {
    if (replayTimerRef.current) clearInterval(replayTimerRef.current);
  }, []);

  // 统计
  const stats = useMemo(() => {
    const toolCount = spans.filter((s) => isToolKind(s.kind)).length;
    const thinkCount = spans.filter((s) => s.kind === 'thinking_phase').length;
    const totalDuration = spans.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);
    return { toolCount, thinkCount, totalDuration };
  }, [spans]);

  // 搜索过滤 + 高亮
  const searchLower = searchQuery.trim().toLowerCase();
  const highlightedIds = useMemo(() => {
    if (!searchLower) return new Set<string>();
    const ids = new Set<string>();
    spans.forEach((s) => {
      const hay = [
        s.title,
        s.meta?.toolName,
        s.meta?.result,
        s.meta?.content,
        s.meta?.summary,
        s.meta?.purpose,
      ].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(searchLower)) ids.add(s.id);
    });
    return ids;
  }, [spans, searchLower]);

  // dsh 三泳道 Overview：事件按 lane 分组（Input/Model/Tools），块宽=等宽或真实耗时
  const laneSpans = useMemo(() => {
    const lanes: Record<TraceLane, TraceSpan[]> = { input: [], model: [], tools: [] };
    spans.forEach((s) => { lanes[laneOf(s.kind)].push(s); });
    return lanes;
  }, [spans]);

  // 选中事件
  const selectedSpan = useMemo(() => spans.find((s) => s.id === selectedId) ?? null, [spans, selectedId]);
  // 弹窗详情事件
  const detailSpan = useMemo(() => spans.find((s) => s.id === detailId) ?? null, [spans, detailId]);

  // 选中并投递检查器：本地高亮 + 打开详情弹窗（明确反馈）。不再投递 UnifiedViewer 右侧面板。
  const handleInspect = (id: string) => {
    setSelectedId(id);
    setDetailId(id);
  };

  // 展开证据层：区块折叠放开 + 事件表（Turn）一并展开，让产物/事件直接可见，少钻一层
  const expandTrace = () => {
    setBlockCollapsed(false);
    setTurnCollapsed(false);
  };

  // 工具类事件行（用于 Calls 折叠后的摘要）
  const toolSpans = useMemo(() => spans.filter((s) => isToolKind(s.kind)), [spans]);

  // 请求状态（dsh Request #N 锚）：running / error / complete
  const requestState = useMemo<'running' | 'error' | 'complete'>(() => {
    if (isStreaming) return 'running';
    if (spans.some((s) => s.phase === 'error')) return 'error';
    return 'complete';
  }, [spans, isStreaming]);

  // Assistant 级折叠文案（dsh summarizeAssistantTools："N tool calls · name1, name2"）
  const callSummaryNames = useMemo(
    () => toolSpans.slice(0, 3).map((s) => s.meta?.purpose ?? s.meta?.toolName ?? s.title).join(', '),
    [toolSpans],
  );

  // 信任摘要派生：步数=原始工具调用数（不含 thinking/skill/system 行），产物/来源由 toolCalls 直接统计
  const summary = useMemo(() => {
    const toolCount = toolCalls.length > 0 ? toolCalls.length : toolSpans.length;
    const imageCount = toolCalls.reduce((n, tc) => n + countImagesInResult(tc.result ?? ''), 0);
    const cardCount = toolCalls.filter((tc) => tc.cardHtml && tc.cardHtml.trim().length > 0).length;
    const sourceCount = toolCalls.filter((tc) => isWebSourceTool(tc.toolName) && tc.success !== false).length;
    return { toolCount, imageCount, cardCount, sourceCount };
  }, [toolCalls, toolSpans]);

  if (spans.length === 0) return null;

  // 思考完成态收口（dsh：reasoning 不铺独立账本行，只在 message 内作为明细存在）：
  // 流式期间保留逐行实时渲染；完成后把思考阶段合并为一条「思考」行，全文进行内检查器
  const thinkRows = spans.filter((s) => s.kind === 'thinking_phase');
  const thinkMerged: TraceSpan | null = !isStreaming && !replaying && thinkRows.length > 1
    ? {
        id: '__think_all__',
        kind: 'thinking_phase',
        title: `${thinkRows.length} thinking stage${thinkRows.length > 1 ? 's' : ''}`,
        phase: thinkRows.some((r) => r.phase === 'error') ? 'error' : 'done',
        startAt: thinkRows[0].startAt,
        endAt: thinkRows[thinkRows.length - 1].endAt ?? thinkRows[0].startAt,
        durationMs: thinkRows.reduce((a, r) => a + (r.durationMs ?? 0), 0),
        success: true,
        meta: {
          stageTitle: '思考',
          content: thinkRows.map((r) => r.meta?.content ?? r.title).filter(Boolean).join('\n\n'),
        },
      }
    : null;

  // 基础行：完成后思考合并为一行，其余照常
  let baseRows: TraceSpan[];
  if (thinkMerged) {
    const firstThinkIdx = spans.findIndex((s) => s.kind === 'thinking_phase');
    baseRows = spans.filter((s) => s.kind !== 'thinking_phase');
    baseRows.splice(firstThinkIdx < 0 ? 0 : firstThinkIdx, 0, thinkMerged);
  } else {
    baseRows = spans;
  }
  // Calls 折叠时：工具行替换为单行摘要，其余行（思考/技能/回答/变更）照常
  let displayRows = callsCollapsed
    ? baseRows.filter((s) => !isToolKind(s.kind))
    : baseRows;
  // P3 replay：回放中只显示前 replayCount 个 span（逐步长出）
  if (replaying) {
    displayRows = displayRows.slice(0, replayCount);
  }

  return (
    <>
    <div className="w-full min-w-0">
      {(blockCollapsed && summary.toolCount > 0) ? (
        <TraceSummary
          toolCount={summary.toolCount}
          imageCount={summary.imageCount}
          cardCount={summary.cardCount}
          sourceCount={summary.sourceCount}
          durationMs={durationMs}
          onExpand={expandTrace}
        />
      ) : (
        <>
      {/* ==== 统计条（dsh 顶部 Trajectory 标题 + 概要） ==== */}
      <div className="flex items-center" style={{ gap: 8, padding: '6px 6px 4px' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Trajectory</span>
        <span style={{ width: 1, height: 12, backgroundColor: 'color-mix(in oklab, var(--line) 50%, transparent)' }} />
        <span style={{ fontSize: 12, color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
          {stats.toolCount} calls · {stats.thinkCount} think
          {stats.totalDuration > 0 ? ` · ${formatDuration(stats.totalDuration)}` : ''}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setBlockCollapsed(true)}
          className="inline-flex cursor-pointer items-center transition-colors"
          style={{ height: 20, padding: '0 7px', gap: 4, borderRadius: 3, fontSize: 12, color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
          title="Collapse to one-line summary"
        >
          <ListCollapse className="h-3 w-3" /> Summary
        </button>
        <button
          type="button"
          onClick={() => {
            const target =
              detailSpan ?? selectedSpan ?? spans.find((s) => s.kind !== 'thinking_phase') ?? spans[0];
            if (target) handleInspect(target.id);
          }}
          className="inline-flex cursor-pointer items-center transition-colors"
          style={{ height: 20, padding: '0 7px', gap: 4, borderRadius: 3, fontSize: 12, color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
          title="Inspect the selected record"
        >
          <PanelRight className="h-3 w-3" /> Details
        </button>
      </div>

      {/* ==== 工具栏（dsh toggle/action：20px 高、3px 圆角、12px 字号；搜索框 22px/4px） ==== */}
      <div className="flex flex-wrap items-center" style={{ gap: 8, padding: '0 6px 6px', borderBottom: '0.5px solid color-mix(in oklab, var(--line) 40%, transparent)' }}>
        <button
          type="button"
          onClick={() => setDurationMode((v) => (v === 'actual' ? 'equal' : 'actual'))}
          title="Equal-width / actual duration"
          className="inline-flex cursor-pointer items-center transition-colors"
          style={{
            height: 20,
            padding: '0 7px',
            gap: 4,
            borderRadius: 3,
            fontSize: 12,
            color: durationMode === 'actual' ? 'var(--ink)' : 'color-mix(in oklab, var(--ink-muted) 60%, transparent)',
            backgroundColor: durationMode === 'actual' ? 'color-mix(in oklab, var(--paper-soft) 60%, transparent)' : 'transparent',
          }}
        >
          <Clock3 className="h-3 w-3" />
          {durationMode === 'actual' ? 'Actual' : 'Equal'}
        </button>

        <button
          type="button"
          onClick={() => setCallsCollapsed((v) => !v)}
          title={callsCollapsed ? 'Expand tool calls' : 'Collapse tool calls into summary'}
          className="inline-flex cursor-pointer items-center transition-colors"
          style={{
            height: 20,
            padding: '0 7px',
            gap: 4,
            borderRadius: 3,
            fontSize: 12,
            color: callsCollapsed ? 'var(--ink)' : 'color-mix(in oklab, var(--ink-muted) 60%, transparent)',
            backgroundColor: callsCollapsed ? 'color-mix(in oklab, var(--paper-soft) 60%, transparent)' : 'transparent',
          }}
        >
          <ListCollapse className="h-3 w-3" />
          {callsCollapsed ? `${toolSpans.length} tools` : 'Fold calls'}
        </button>

        {/* P3 replay：逐事件回放（仅非流式时可用；回放中点击停止） */}
        {!isStreaming && spans.length > 0 && (
          <button
            type="button"
            onClick={toggleReplay}
            title={replaying ? 'Stop replay' : 'Replay step by step'}
            className="inline-flex cursor-pointer items-center transition-colors"
            style={{
              height: 20,
              padding: '0 7px',
              gap: 4,
              borderRadius: 3,
              fontSize: 12,
              color: replaying ? 'var(--ink)' : 'color-mix(in oklab, var(--ink-muted) 60%, transparent)',
              backgroundColor: replaying ? 'color-mix(in oklab, var(--paper-soft) 60%, transparent)' : 'transparent',
            }}
          >
            {replaying ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {replaying ? 'Stop' : 'Replay'}
          </button>
        )}

        <div className="flex-1" />

        <div
          className="flex items-center"
          style={{ flex: '0 1 164px', minWidth: 84, height: 22, padding: '0 6px', gap: 4, borderRadius: 4, border: '0.5px solid color-mix(in oklab, var(--line) 45%, transparent)', backgroundColor: 'color-mix(in oklab, var(--paper) 40%, transparent)' }}
        >
          <Search className="h-3 w-3 shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search…"
            className="min-w-0 w-full border-0 bg-transparent outline-none"
            style={{ color: 'var(--ink)', fontSize: 12 }}
          />
        </div>
      </div>

      {/* ==== Overview 时间线（dsh plot：50px 高、3 泳道 14px 间距、色块 8px 高/1px 圆角、标签 10px） ==== */}
      <div
        className="overflow-hidden"
        style={{
          height: 50,
          display: 'grid',
          gridTemplateColumns: '44px minmax(0,1fr)',
          borderBottom: '0.5px solid color-mix(in oklab, var(--line) 40%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--paper-soft) 45%, transparent)',
        }}
      >
        {/* 泳道标签（dsh labels：右对齐、10px、top 7/21/35） */}
        <div style={{ position: 'relative', borderRight: '0.5px solid color-mix(in oklab, var(--line) 40%, transparent)' }}>
          {LANE_ORDER.map((l, i) => (
            <span
              key={l}
              style={{
                position: 'absolute',
                top: 7 + i * 14,
                right: 3,
                height: 8,
                fontSize: 10,
                lineHeight: '8px',
                textAlign: 'right',
                color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)',
              }}
            >
              {LANE_LABEL[l]}
            </span>
          ))}
        </div>
        {/* 泳道 */}
        <div style={{ position: 'relative', overflow: 'hidden' }}>
          {LANE_ORDER.map((lane, i) => {
            const items = laneSpans[lane];
            return (
              <div key={lane} style={{ position: 'absolute', top: 7 + i * 14, left: 0, right: 0, height: 8, display: 'flex', gap: 1 }}>
                {items.length === 0 ? (
                  <div style={{ flex: 1, height: 8, borderRadius: 1, backgroundColor: 'color-mix(in oklab, var(--ink-muted) 8%, transparent)' }} />
                ) : (
                  items.map((s) => {
                    const color = kindColor(s.kind, s.phase);
                    const weight = durationMode === 'actual' ? Math.max(s.durationMs ?? 0, 1) : 1;
                    const dimmed = !!searchLower && !highlightedIds.has(s.id);
                    const tooltip = `${KIND_LABEL[s.kind]} · ${s.title}${(s.durationMs ?? 0) > 0 ? ` · ${formatDuration(s.durationMs ?? 0)}` : ''}`;
                    return (
                      <div
                        key={s.id}
                        title={tooltip}
                        className="cursor-pointer transition-opacity"
                        style={{
                          height: 8,
                          minWidth: 2,
                          borderRadius: 1,
                          backgroundColor: s.phase === 'error' ? 'var(--danger)' : color,
                          flex: `${weight} 1 0`,
                          opacity:
                            s.phase === 'pending' || s.phase === 'skipped' ? 0.3
                            : dimmed ? 0.14
                            : s.id === selectedId ? 1
                            : 0.78,
                          boxShadow: s.id === selectedId ? '0 0 0 1px color-mix(in oklab, var(--ink) 40%, transparent)' : undefined,
                        }}
                        onClick={() => { setSelectedId(s.id); setDetailId(s.id); }}
                      />
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ==== 主体：事件表（点击事件行 → 详情弹窗 + 下方内联检查器） ==== */}
      <div className="flex w-full min-w-0 items-start gap-2">
        {/* 事件表 */}
        <div className="min-w-0 flex-1">
          {/* Turn 头（dsh sticky turn bar：44px 高、full-bleed ghost-active fill、标题 13px 强字重） */}
          <button
            type="button"
            className="flex w-full min-w-0 cursor-pointer items-center text-left"
            style={{ height: 44, padding: '0 8px 0 20px', gap: 12, backgroundColor: 'color-mix(in oklab, var(--paper-soft) 55%, transparent)' }}
            onClick={() => setTurnCollapsed((v) => !v)}
          >
            <ChevronDown
              className={cn('h-3 w-3 shrink-0 transition-transform', turnCollapsed && '-rotate-90')}
              style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}
            />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
              Turn {requestNumber ?? 1}
            </span>
            <span className="flex-1" />
            {/* dsh Request #N 边界锚：会话内请求序号 + 状态色（running/error/complete） */}
            {typeof requestNumber === 'number' && (
              <span
                className="inline-flex items-center"
                style={{
                  height: 22,
                  padding: '0 6px',
                  gap: 4,
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  color: requestState === 'error' ? 'var(--danger)'
                    : requestState === 'running' ? 'var(--primary-strong)'
                    : 'color-mix(in oklab, var(--ink-muted) 70%, transparent)',
                  backgroundColor: requestState === 'error' ? 'color-mix(in oklab, var(--danger) 10%, transparent)'
                    : requestState === 'running' ? 'color-mix(in oklab, var(--primary-strong) 10%, transparent)'
                    : 'color-mix(in oklab, var(--ink-muted) 8%, transparent)',
                }}
                title={requestState === 'error' ? 'Request failed' : requestState === 'running' ? 'Request in progress' : `Request #${requestNumber} completed`}
              >
                {requestState === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
                {requestState === 'error' && <XCircle className="h-3 w-3" />}
                {requestState === 'complete' && <CheckCircle2 className="h-3 w-3" />}
                #{requestNumber}
              </span>
            )}
          </button>

          {/* 事件行列表（dsh Turn body：gap 10px、padding 0 16px 12px） */}
          {!turnCollapsed && (
            <div className="flex flex-col" style={{ gap: 8, padding: '8px 8px 12px' }}>
              {callsCollapsed && toolSpans.length > 0 && (
                <div
                  className="flex w-full min-w-0 cursor-pointer select-none items-center"
                  style={{ minHeight: 38, padding: '0 8px 0 20px', gap: 24, borderRadius: 8, border: '0.5px solid color-mix(in oklab, var(--info) 25%, transparent)', backgroundColor: 'color-mix(in oklab, var(--info) 10%, transparent)' }}
                  onClick={() => setCallsCollapsed(false)}
                  title="Click to expand all tool calls"
                >
                  <Wrench className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--info)' }} />
                  <span className="flex-1 truncate" style={{ fontSize: 13, color: 'var(--ink)' }}>
                    {toolSpans.length} tool calls{callSummaryNames ? ` · ${callSummaryNames}${toolSpans.length > 3 ? '…' : ''}` : ''}
                  </span>
                  <span style={{ fontSize: 12, color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
                    Expand
                  </span>
                  <ChevronRight className="h-3 w-3" style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)' }} />
                </div>
              )}

              {displayRows.map((span) => (
                <EventRow
                  key={span.id}
                  span={span}
                  selected={span.id === selectedId}
                  highlighted={highlightedIds.has(span.id)}
                  onSelect={handleInspect}
                />
              ))}
            </div>
          )}

          {/* 事件行列表渲染于上 */}
        </div>
      </div>
        </>
      )}
    </div>

      {/* 行内记录检查器（dsh local inspector）：选中事件就地展开，替代弹窗 */}
      {detailSpan && (
        <div
          className="mt-1.5 overflow-hidden rounded-lg"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
          }}
        >
          <div
            className="flex items-center gap-2 px-2.5 py-1.5"
            style={{ borderBottom: '1px solid color-mix(in oklab, var(--line) 25%, transparent)', backgroundColor: 'color-mix(in oklab, var(--paper-soft) 40%, transparent)' }}
          >
            <PanelRight className="h-3.5 w-3.5" style={{ color: kindColor(detailSpan.kind, detailSpan.phase) }} />
            <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: kindColor(detailSpan.kind, detailSpan.phase) }}>
              {KIND_LABEL[detailSpan.kind]}
            </span>
            <span className="truncate text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
              {detailSpan.title}
            </span>
            <span className="flex-1" />
            {/* P3 fork：从该事件点分叉继续（仅工具类事件 + 提供 onFork 时可用） */}
            {onFork && (detailSpan.kind === 'tool_call' || detailSpan.kind === 'mcp_call') && (
              <button
                type="button"
                onClick={() => { setDetailId(null); onFork(detailSpan); }}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-11 font-medium transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary-strong)_10%,transparent)]"
                style={{ color: 'var(--primary-strong)' }}
                title="Fork and continue from this step"
              >
                <GitFork className="h-3 w-3" /> Fork here
              </button>
            )}
            <button
              type="button"
              onClick={() => setDetailId(null)}
              className="cursor-pointer rounded-md p-1 transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-soft)_60%,transparent)]"
              style={{ color: 'var(--ink-muted)' }}
              title="Close inspector"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="ai-canvas-scroll max-h-[340px] overflow-y-auto p-2.5">
            <EventInspector span={detailSpan} isStreaming={isStreaming} />
          </div>
        </div>
      )}
    </>
  );
}

/* ==================== 会话级 Trajectory（全屏 overlay：dsh 多 Turn 聚合） ==================== */

/** 单个请求轮（Turn）的聚合素材：由宿主从 messages 派生 */
export interface ConversationTrajectoryItem {
  number: number;
  /** 本轮用户提问（dsh user 行） */
  userText?: string;
  thinkText?: string;
  toolCalls: ToolCallRecord[];
  skillDetails: (SkillDetail | string)[];
  matchedSkills: string[];
  isStreaming: boolean;
  durationMs?: number;
  /** P5b-1 历史 replay：本轮任务的事件日志 taskId（存在才显示「原始轨迹」入口） */
  taskId?: string;
}

interface TurnModel {
  number: number;
  userText?: string;
  isStreaming: boolean;
  durationMs?: number;
  error: boolean;
  toolCount: number;
  thinkCount: number;
  rows: TraceSpan[];
  /** P5b-1 历史 replay：透传 taskId（供 Turn 头「查看原始轨迹」入口） */
  taskId?: string;
}

/** span 检索文本（对齐 TrajectorySearchIndex 的 sources 聚合） */
function spanSearchText(s: TraceSpan): string {
  return [
    s.title,
    s.meta?.toolName,
    s.meta?.purpose,
    s.meta?.summary,
    s.meta?.content,
    s.meta?.result,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function ConversationTrajectory({
  open,
  onClose,
  items,
  embedded,
  onReplayTask,
}: {
  open?: boolean;
  onClose?: () => void;
  items: ConversationTrajectoryItem[];
  /** 嵌入模式（节点内「Trace」分栏）：不套全屏遮罩、无关闭按钮，交给宿主滚动容器 */
  embedded?: boolean;
  /** P5b-1 历史 replay：点击 Turn 头「查看原始轨迹」（taskId + turn 号）→ 宿主 fetch 事件回放 */
  onReplayTask?: (taskId: string, turnNumber: number) => void;
}) {
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [openTurns, setOpenTurns] = useState<Record<number, boolean>>({});
  const [detail, setDetail] = useState<{ number: number; span: TraceSpan } | null>(null);

  const q = query.trim().toLowerCase();

  const turnModels = useMemo<TurnModel[]>(() => {
    const out: TurnModel[] = [];
    for (const it of items) {
      const hasTrace = (it.toolCalls?.length ?? 0) > 0
        || !!it.thinkText?.trim()
        || (it.skillDetails?.length ?? 0) > 0
        || (it.matchedSkills?.length ?? 0) > 0;
      if (!hasTrace) continue;
      let rows = assembleTraceSpans({
        thinkText: it.thinkText,
        toolCalls: it.toolCalls ?? [],
        skillDetails: it.skillDetails ?? [],
        matchedSkillNames: it.matchedSkills ?? [],
        streaming: it.isStreaming,
      });
      // 流式中：末个思考阶段标记 running（实时）
      if (it.isStreaming) {
        const thinkIdx: number[] = [];
        rows.forEach((s, i) => { if (s.kind === 'thinking_phase') thinkIdx.push(i); });
        const lastIdx = thinkIdx[thinkIdx.length - 1];
        if (lastIdx !== undefined && (rows[lastIdx].phase === 'done' || rows[lastIdx].phase === 'pending')) {
          rows = rows.map((s, i) => (i === lastIdx ? { ...s, phase: 'running' as const } : s));
        }
      }
      // 完成态：思考阶段合并为一行（全文进明细）
      const thinkRows = rows.filter((s) => s.kind === 'thinking_phase');
      if (!it.isStreaming && thinkRows.length > 1) {
        const firstIdx = rows.findIndex((s) => s.kind === 'thinking_phase');
        const others = rows.filter((s) => s.kind !== 'thinking_phase');
        others.splice(firstIdx < 0 ? 0 : firstIdx, 0, {
          id: '__think_all__',
          kind: 'thinking_phase' as const,
          title: `${thinkRows.length} thinking stage${thinkRows.length > 1 ? 's' : ''}`,
          phase: thinkRows.some((r) => r.phase === 'error') ? 'error' as const : 'done' as const,
          startAt: thinkRows[0].startAt,
          endAt: thinkRows[thinkRows.length - 1].endAt ?? thinkRows[0].startAt,
          durationMs: thinkRows.reduce((a, r) => a + (r.durationMs ?? 0), 0),
          success: true,
          meta: { stageTitle: '思考', content: thinkRows.map((r) => r.meta?.content ?? r.title).filter(Boolean).join('\n\n') },
        });
        rows = others;
      }
      out.push({
        number: it.number,
        userText: it.userText,
        isStreaming: it.isStreaming,
        durationMs: it.durationMs,
        error: rows.some((s) => s.phase === 'error'),
        toolCount: rows.filter((s) => isToolKind(s.kind)).length,
        thinkCount: thinkRows.length,
        rows,
        taskId: it.taskId,
      });
    }
    return out;
  }, [items]);

  const toggleAll = (expanded: boolean) => {
    const map: Record<number, boolean> = {};
    turnModels.forEach((t) => { map[t.number] = expanded; });
    setOpenTurns(map);
  };

  if (!embedded && !open) return null;

  return (
    <div
      data-canvas-ui={embedded ? undefined : 'overlay'}
      className={cn('flex flex-col', embedded ? 'w-full min-w-0' : 'fixed inset-0 z-[480]')}
      style={embedded ? undefined : { backgroundColor: 'color-mix(in oklab, var(--paper) 55%, transparent)', backdropFilter: 'blur(8px)' }}
    >
      {/* 顶栏 */}
      <div
        className={cn('flex items-center gap-2', embedded ? 'flex-wrap px-2.5 py-1.5' : 'px-4 py-2.5')}
        style={{ borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}
      >
        <span className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>Trajectory</span>
        <span className="text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
          {turnModels.length} turns · session trajectory
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => toggleAll(true)}
          className="cursor-pointer rounded px-2 py-1 text-11 font-medium transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-soft)_60%,transparent)]"
          style={{ color: 'var(--ink-muted)' }}
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={() => toggleAll(false)}
          className="cursor-pointer rounded px-2 py-1 text-11 font-medium transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-soft)_60%,transparent)]"
          style={{ color: 'var(--ink-muted)' }}
        >
          Collapse all
        </button>
        <button
          type="button"
          onClick={() => setCallsCollapsed((v) => !v)}
          className={cn('cursor-pointer rounded px-2 py-1 text-11 font-medium transition-colors', callsCollapsed && 'bg-[color:color-mix(in_oklab,var(--primary)_10%,transparent)]')}
          style={{ color: callsCollapsed ? 'var(--primary-strong)' : 'var(--ink-muted)' }}
        >
          {callsCollapsed ? 'Show calls' : 'Fold calls'}
        </button>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-48 rounded-full border-0 bg-transparent py-1 pl-7 pr-2 text-12 outline-none"
            style={{ color: 'var(--ink)', border: '1px solid color-mix(in oklab, var(--line) 50%, transparent)', backgroundColor: 'var(--paper)' }}
          />
        </div>
        {!embedded && (
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md p-1.5 transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-soft)_60%,transparent)]"
            style={{ color: 'var(--ink-muted)' }}
            title="Close trajectory view"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 主体：Turn 列表 */}
      <div className={cn(embedded ? 'w-full min-w-0' : 'ai-canvas-scroll min-h-0 flex-1 overflow-y-auto')}>
        <div className={cn('mx-auto flex w-full max-w-[880px] flex-col gap-3', embedded ? 'px-2.5 py-2' : 'px-4 py-4')}>
          {turnModels.length === 0 && (
            <div className="py-16 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>No trajectory yet (tools / thinking / skills)</div>
          )}
          {turnModels.map((tm) => {
            const matchRows = q ? tm.rows.filter((s) => spanSearchText(s).includes(q)) : tm.rows;
            const headerMatch = q && (tm.userText?.toLowerCase().includes(q) ?? false);
            const forceOpen = !!q && (matchRows.length > 0 || headerMatch);
            const expanded = forceOpen || !!openTurns[tm.number];
            let visible = expanded ? matchRows : [];
            if (!q && callsCollapsed) visible = visible.filter((s) => !isToolKind(s.kind));

            return (
              <section key={tm.number} data-turn={tm.number} style={{ borderRadius: 10, border: '1px solid color-mix(in oklab, var(--line) 22%, transparent)' }}>
                {/* Turn 头：左侧展开/折叠切换 + P5b-1「查看原始轨迹」入口（仅该轮带 taskId 时显示） */}
                <div className="flex w-full min-w-0 items-stretch" style={{ backgroundColor: 'var(--paper)' }}>
                <button
                  type="button"
                  onClick={() => { if (!q) setOpenTurns((v) => ({ ...v, [tm.number]: !v[tm.number] })); }}
                  className={cn('flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left', tm.taskId ? 'rounded-tl-lg' : 'rounded-t-lg')}
                  style={{ backgroundColor: 'var(--paper)' }}
                >
                  <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', !expanded && '-rotate-90')} style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }} />
                  <span className="text-12 font-semibold" style={{ color: 'var(--ink-strong)' }}>Turn {tm.number}</span>
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-10 font-semibold leading-4"
                    style={{
                      color: tm.error ? 'var(--danger)' : tm.isStreaming ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--ink-muted) 70%, transparent)',
                      backgroundColor: tm.error ? 'color-mix(in oklab, var(--danger) 10%, transparent)' : tm.isStreaming ? 'color-mix(in oklab, var(--primary-strong) 10%, transparent)' : 'color-mix(in oklab, var(--ink-muted) 8%, transparent)',
                    }}
                  >
                    {tm.isStreaming && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                    {tm.error && !tm.isStreaming && <XCircle className="h-2.5 w-2.5" />}
                    #{tm.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
                    {tm.userText ? `Q: ${tm.userText}` : ''}
                  </span>
                  <span className="shrink-0 text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
                    {tm.toolCount > 0 ? `${tm.toolCount} tools · ` : ''}{tm.thinkCount > 0 ? `${tm.thinkCount} think · ` : ''}
                    {tm.durationMs && tm.durationMs > 0 ? `${(tm.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                </button>
                {tm.taskId && (
                  <button
                    type="button"
                    title="查看原始轨迹（事件日志回放）"
                    onClick={(e) => { e.stopPropagation(); onReplayTask?.(tm.taskId!, tm.number); }}
                    className="flex shrink-0 cursor-pointer items-center rounded-tr-lg border-l px-2.5 transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-soft)_70%,transparent)]"
                    style={{ backgroundColor: 'var(--paper)', color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
                  >
                    <History className="h-3.5 w-3.5" />
                  </button>
                )}
                </div>

                {expanded && (
                  <div className="flex flex-col gap-0.5 px-1.5 pb-2 pt-1">
                    {/* 用户行（dsh user cell） */}
                    {tm.userText && (
                      <div className="flex items-start gap-2 px-2 py-1.5">
                        <span
                          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-px text-10 font-semibold leading-4"
                          style={{ color: 'var(--success)', backgroundColor: 'color-mix(in oklab, var(--success) 12%, transparent)' }}
                        >
                          User
                        </span>
                        <span className="min-w-0 flex-1 truncate text-12 leading-relaxed" style={{ color: 'var(--ink)' }}>{tm.userText}</span>
                      </div>
                    )}
                    {visible.length === 0 && !q && (
                      <div className="px-2 py-2 text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                        （Calls 已折叠，点击上方「展开 Calls」查看）
                      </div>
                    )}
                    {visible.map((span) => (
                      <EventRow
                        key={span.id}
                        span={span}
                        selected={detail?.number === tm.number && detail.span.id === span.id}
                        highlighted={false}
                        onSelect={(id) => {
                          setDetail({ number: tm.number, span: span.id === id ? span : span });
                        }}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {/* 行内记录检查器（选中事件就地查看明细） */}
      {detail && (
        <div className="border-t" style={{ borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)', backgroundColor: 'var(--paper)' }}>
          <div className="mx-auto flex w-full max-w-[880px] flex-col gap-1 px-4 py-2">
            <div className="flex items-center gap-2">
              <PanelRight className="h-3.5 w-3.5" style={{ color: kindColor(detail.span.kind, detail.span.phase) }} />
              <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: kindColor(detail.span.kind, detail.span.phase) }}>
                {KIND_LABEL[detail.span.kind]} · Turn {detail.number}
              </span>
              <span className="truncate text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>{detail.span.title}</span>
              <span className="flex-1" />
              <button type="button" onClick={() => setDetail(null)} className="cursor-pointer rounded p-1" style={{ color: 'var(--ink-muted)' }} title="Close">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="ai-canvas-scroll max-h-[300px] overflow-y-auto">
              <EventInspector span={detail.span} isStreaming={false} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
