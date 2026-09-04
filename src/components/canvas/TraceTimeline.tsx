/**
 * TraceTimeline — dsh Trajectory 风格统一执行轨迹视图（彻底整改）
 *
 * 按 DeepSeek Harness 的 Trajectory 视图整改：
 *   - 顶部统计条：轮次 / 工具调用数 / 思考数 / 总耗时
 *   - 工具栏（吸顶）：Duration 等宽↔实际耗时切换、Calls 折叠、搜索
 *   - Overview 时间线：活动总览色块（宽度=耗时或等宽，悬停看事件名）
 *   - 事件表：按 Turn 组织的事件记录（思考/技能/工具/回答），点击行选中
 *   - 事件检查器：右侧弹出，显示选中事件的原始参数/结果/耗时
 *
 * 保留原能力：
 *   - Turn 1 默认折叠，点击 Turn 头展开；流式期间展开后思考实时渲染，完成后保持折叠
 *   - 工具卡片（cardHtml）、模板填充按钮（fill_template）
 *   - 旧接口（thinkText / toolCalls / skillDetails）自动 assemble
 */

'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Brain, Sparkles, Wrench, Plug, Eye, RefreshCw, HardDrive,
  CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, FilePen, Hammer,
  Copy, Search, Clock3, PanelRight, ListCollapse, X, Play, Square, GitFork,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TraceSpan, ToolCallRecord, SkillDetail, ThinkingStage } from '@/lib/types';
import { parseThinkingToSpans } from '@/lib/thinking-parser';
import { HtmlRenderer } from './HtmlRenderer';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

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

/** 事件类型 → 中文标签 */
const KIND_LABEL: Record<TraceSpan['kind'], string> = {
  thinking_phase: '思考',
  skill_load: '技能',
  tool_call: '工具',
  mcp_call: 'MCP',
  vision_stage: '视觉',
  model_switch: '模型',
  system_change: '变更',
  memory_compact: '记忆',
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
  /** P1 轨迹：按模型调用轮切分的思考文本（每轮一段）；提供时按轮生成思考 spans，优先于 thinkText 整段 */
  traceTurns?: Array<{ turn: number; reasoning: string }>;
  toolCalls: ToolCallRecord[];
  skillDetails: (SkillDetail | string)[];
  matchedSkillNames: string[];
  /** 流式模式（断点3修复）：思考解析始终产出可见 span 承载实时文本，未完成尾部由 UI 标记 running */
  streaming?: boolean;
}): TraceSpan[] {
  const spans: TraceSpan[] = [];
  const now = Date.now();

  // 1. 思考阶段：优先按模型轮（traceTurns）逐轮切分（每轮一至多个 stage span，标注 turn）；
  //    否则退化为整段 thinkText（旧消息/无轮数据），不标 turn。
  const thinkSegments: Array<{ turn?: number; text: string }> =
    opts.traceTurns && opts.traceTurns.length > 0
      ? opts.traceTurns.map((t) => ({ turn: t.turn, text: t.reasoning }))
      : opts.thinkText && opts.thinkText.trim().length > 0
        ? [{ text: opts.thinkText }]
        : [];
  for (const seg of thinkSegments) {
    const parsed = parseThinkingToSpans(seg.text, { streaming: opts.streaming });
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
        turn: seg.turn,
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
        turn: seg.turn,
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
        turn: tc.turn,
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
      turn: tc.turn,
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
  read_attachment: 'Read attachment (PDF/image/doc)',
  ocr_document: 'OCR text recognition on document/image',
  crop_image: 'Crop image region for review',
  parse_image: 'Recognize image content',
  read_upstream_node: 'Read upstream node output',
  read_material: 'Read material file',
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

/* ==================== 事件检查器 ==================== */

/**
 * 高度过渡容器：children 变化时从旧高度平滑过渡到新高度（220ms ease）。
 * 用于事件检查器——"思考→工具"切换瞬间内容从长思考全文变成工具摘要，
 * 直接换内容会造成瞬时高度骤变（跳动），包一层后高度平滑过渡。
 */
function CollapseHeight({ children }: { children: React.ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>(0);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    // 首次挂载（height=0）直接落定目标高度，后续变化由 transition 平滑过渡
    setHeight(el.scrollHeight);
  }, [children]);

  return (
    <div style={{ height: height > 0 ? height : undefined, overflow: 'hidden', transition: 'height 220ms cubic-bezier(.4,0,.2,1)' }}>
      <div ref={innerRef}>{children}</div>
    </div>
  );
}

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
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>目的</div>
            <div className="text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ color: 'color-mix(in oklab, var(--ink) 85%, transparent)' }}>
              {span.meta.purpose}
            </div>
          </div>
        )}

        {span.kind === 'system_change' && span.meta?.changeSummary && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'var(--warn)' }}>系统变更</div>
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
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>思考全文</div>
            <div className="whitespace-pre-wrap text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ color: 'color-mix(in oklab, var(--ink) 88%, transparent)' }}>
              {span.meta.content}
            </div>
          </div>
        )}

        {isTool && span.meta?.arguments && Object.keys(span.meta.arguments).length > 0 && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>参数</div>
            <pre className="rounded-md p-2 text-11 leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ backgroundColor: 'var(--paper-soft)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>
              {JSON.stringify(span.meta.arguments, null, 2)}
            </pre>
          </div>
        )}

        {isTool && span.meta?.summary && span.meta.summary !== span.meta.result && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>摘要</div>
            <div className="text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]" style={{ color: 'color-mix(in oklab, var(--ink) 88%, transparent)' }}>
              {span.meta.summary}
            </div>
          </div>
        )}

        {span.meta?.result && span.meta.result.trim() !== '' && span.meta.result !== '...' && (
          <div>
            <div className="mb-0.5 text-11 font-medium" style={{ color: span.phase === 'error' ? 'var(--danger)' : 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
              结果
            </div>
            <div
              className="ai-canvas-scroll max-h-[240px] overflow-y-auto whitespace-pre-wrap text-12 leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere] pr-1"
              style={{ color: span.phase === 'error' ? 'color-mix(in oklab, var(--danger) 88%, transparent)' : 'color-mix(in oklab, var(--ink) 88%, transparent)' }}
            >
              {span.meta.result}
            </div>
          </div>
        )}

        {span.meta?.cardHtml && (
          <div className="ai-canvas-scroll max-h-[280px] overflow-y-auto pr-1">
            <div className="mb-0.5 text-11 font-medium" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>卡片</div>
            <HtmlRenderer content={span.meta.cardHtml} />
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

/** 单轮思考摘要（Turn 折叠态预览）：拼接该轮全部思考阶段文本，压缩为单行前 140 字。
 *  无思考（纯工具/纯回答轮）返回 null，不显示摘要行。 */
function turnPreview(rows: TraceSpan[]): string | null {
  const texts: string[] = [];
  for (const s of rows) {
    if (s.kind === 'thinking_phase') {
      const c = s.meta?.content;
      if (c && c.trim()) texts.push(c.trim());
    }
  }
  if (texts.length === 0) return null;
  const joined = texts.join(' ').replace(/\s+/g, ' ');
  return joined.length > 140 ? joined.slice(0, 140) + '…' : joined;
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

  return (
    <div
      className={cn(
        'w-full min-w-0 rounded-md transition-colors',
        selected && 'bg-[color:color-mix(in_oklab,var(--primary-strong)_12%,transparent)]',
        highlighted && 'ring-1 ring-inset',
      )}
      style={{
        backgroundColor: selected ? undefined : 'transparent',
        ...(highlighted ? { boxShadow: `0 0 0 1px ${color}` } : {}),
      }}
    >
      <div
        className="flex w-full min-w-0 cursor-pointer select-none items-center gap-2 px-2 py-1.5"
        onClick={() => onSelect(span.id)}
        title={span.title}
      >
        {/* 类型色条 */}
        <div className="h-4 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: color }} />
        {/* 图标 */}
        <div className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color }}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        {/* 标题 */}
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate text-13 leading-snug [overflow-wrap:anywhere] [word-break:break-word] [line-break:anywhere]',
              span.phase === 'error' && 'text-[color:var(--danger)]',
            )}
            style={{ color: span.phase === 'error' ? undefined : 'var(--ink)' }}
          >
            {isThinking && span.phase === 'running'
              ? liveThinkingTitle(span.meta?.content)
              : span.title}
          </div>
          <div className="truncate text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
            {KIND_LABEL[span.kind]}
            {span.meta?.toolName && span.meta.toolName !== span.title ? ` · ${span.meta.toolName}` : ''}
          </div>
        </div>
        {/* 右侧状态 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {duration && span.phase !== 'pending' && span.phase !== 'running' && (
            <span className="text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
              {duration}
            </span>
          )}
          {span.phase === 'running' ? (
            <Loader2 className="h-3 w-3 animate-spin" style={{ color: 'var(--primary)' }} />
          ) : span.phase === 'pending' ? (
            <span className="text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>…</span>
          ) : span.phase === 'error' ? (
            <XCircle className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--danger)' }} />
          ) : span.phase === 'skipped' ? (
            <Copy className="h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)', opacity: 0.4 }} />
          ) : success ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 45%, transparent)' }} />
          ) : (
            <XCircle className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--danger)' }} />
          )}
          <ChevronRight className="h-3 w-3" style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)' }} />
        </div>
      </div>

      {/* 思考行运行中：实时渲染思考全文（逐 token 刷新，末尾呼吸光标），
          完成后收起为标题行，全文在事件详情弹窗查看。
          断点5修复：高度 220px→320px，约 15 行思考内容免滚动可见 */}
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
    </div>
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
  /** P1 轨迹：按模型调用轮切分的思考文本（每轮一段），供 assemble 按轮生成 thinking spans */
  traceTurns?: Array<{ turn: number; reasoning: string }>;
  isStreaming: boolean;
  /** 外层驱动：版本号递增时，自动折叠整轮 Turn 并强制收起 Thinking 组（"思考完成"时机）。undefined 时不生效。 */
  thinkingGroupFoldVersion?: number;
  /** P3 轨迹：Fork 回调（选中事件后，从该点之前的上文分叉继续） */
  onFork?: (span: TraceSpan) => void;
}

export function TraceTimeline({
  spans: propSpans,
  thinkText,
  toolCalls = [],
  skillDetails = [],
  matchedSkillNames = [],
  traceTurns,
  isStreaming,
  thinkingGroupFoldVersion,
  onFork,
}: TraceTimelineProps) {
  const spans = useMemo(() => {
    const raw = propSpans && propSpans.length > 0
      ? propSpans
      : assembleTraceSpans({ thinkText, traceTurns, toolCalls, skillDetails, matchedSkillNames, streaming: isStreaming });

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
  }, [propSpans, thinkText, traceTurns, toolCalls, skillDetails, matchedSkillNames, isStreaming]);

  // dsh 视图状态
  const [durationMode, setDurationMode] = useState<'equal' | 'actual'>('actual');
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 弹窗详情：显式点击事件行（或"点击事件查看详情"提示）时打开，给出明确反馈
  const [detailId, setDetailId] = useState<string | null>(null);
  // Turn 折叠状态：expandedTurns 记录已展开的 turn（默认空 = 全折叠：完成态/历史消息不抢占视觉）。
  // 流式期间点击 Turn 头展开后思考全文仍实时渲染；foldVersion 递增时折叠全部。
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<number>>(new Set());
  const toggleTurn = (t: number) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };
  const expandAllTurns = () => {
    const all = new Set<number>();
    let anyTurn = false;
    for (const s of spans) {
      if (typeof s.turn === 'number') { all.add(s.turn); anyTurn = true; }
    }
    if (!anyTurn) all.add(1); // 无 turn 数据（旧消息）视为单 Turn 1
    setExpandedTurns(all);
  };

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
    expandAllTurns();
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

  // 思考阶段完成（外层 foldVersion 递增）：延迟 3s 后自动折叠整轮 Turn（保留头部摘要，可再手动展开）；
  // 断点4修复：此前"思考→正文"切换瞬间立即折叠，用户尚未读完思考内容即被收起
  //（思考通常持续 5-15s，阅读 200 字需 30s+，立即折叠远快于阅读速度），改为延迟折叠留出阅读时间
  const prevFoldVersionRef = useRef<number | undefined>(thinkingGroupFoldVersion);
  useEffect(() => {
    if (thinkingGroupFoldVersion !== undefined && thinkingGroupFoldVersion !== prevFoldVersionRef.current) {
      const foldTimer = setTimeout(() => {
        setExpandedTurns(new Set());
        setSelectedId((cur) => {
          if (!cur) return cur;
          const curSpan = spans.find((s) => s.id === cur);
          if (curSpan && curSpan.kind === 'thinking_phase') {
            const firstNonThink = spans.find((s) => s.kind !== 'thinking_phase');
            return firstNonThink ? firstNonThink.id : cur;
          }
          return cur;
        });
      }, 3000);
      prevFoldVersionRef.current = thinkingGroupFoldVersion;
      return () => clearTimeout(foldTimer);
    }
    prevFoldVersionRef.current = thinkingGroupFoldVersion;
  }, [thinkingGroupFoldVersion, spans]);

  // 思考进行中不再自动展开 Turn（默认折叠，用户点击查看）；
  // real-time 渲染能力保留——展开状态下 EventRow 末行思考全文逐 token 刷新

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

  // Overview 色块数据（保持 spans 顺序）
  const overviewBlocks = useMemo(() => spans.map((s) => ({
    id: s.id,
    kind: s.kind,
    phase: s.phase,
    durationMs: s.durationMs ?? 0,
    title: s.title,
  })), [spans]);
  const totalDur = Math.max(1, overviewBlocks.reduce((a, b) => a + b.durationMs, 0));

  // 选中事件
  const selectedSpan = useMemo(() => spans.find((s) => s.id === selectedId) ?? null, [spans, selectedId]);
  // 弹窗详情事件
  const detailSpan = useMemo(() => spans.find((s) => s.id === detailId) ?? null, [spans, detailId]);

  // 选中并投递检查器：本地高亮 + 打开详情弹窗（明确反馈）。不再投递 UnifiedViewer 右侧面板。
  const handleInspect = (id: string) => {
    setSelectedId(id);
    setDetailId(id);
  };

  // 工具类事件行（用于 Calls 折叠后的摘要）
  const toolSpans = useMemo(() => spans.filter((s) => isToolKind(s.kind)), [spans]);

  if (spans.length === 0) return null;

  // P1 轨迹：按模型轮分组。有 turn 标记的 spans 按 turn 归组（无 turn 的早期事件如技能加载归入首个真实轮）；
  // 无任何 turn 标记（旧消息/历史数据）整体归为单组 Turn 1，保持旧交互不变。
  const turnGroups = useMemo(() => {
    const hasTurn = spans.some((s) => typeof s.turn === 'number');
    const map = new Map<number, TraceSpan[]>();
    let firstRealTurn: number | null = null;
    if (hasTurn) {
      for (const s of spans) {
        if (typeof s.turn === 'number') {
          if (firstRealTurn === null) firstRealTurn = s.turn;
          if (!map.has(s.turn)) map.set(s.turn, []);
        }
      }
      for (const s of spans) {
        const t = typeof s.turn === 'number' ? s.turn : (firstRealTurn ?? 1);
        map.get(t)!.push(s);
      }
    } else {
      map.set(1, [...spans]);
    }
    return [...map.keys()].sort((a, b) => a - b).map((turn) => ({ turn, rows: map.get(turn)!, preview: turnPreview(map.get(turn)!) }));
  }, [spans]);

  return (
    <>
    <div className="w-full min-w-0">
      {/* ==== 统计条 ==== */}
      <div className="mb-1 flex items-center gap-2 rounded-t-lg px-3 pt-2 pb-1">
        <span className="text-12 font-semibold" style={{ color: 'var(--ink)' }}>Trajectory</span>
        <span className="h-3 w-px" style={{ backgroundColor: 'color-mix(in oklab, var(--line) 50%, transparent)' }} />
        <span className="text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
          {stats.toolCount} calls · {stats.thinkCount} think
          {stats.totalDuration > 0 ? ` · ${formatDuration(stats.totalDuration)}` : ''}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            const target =
              detailSpan ?? selectedSpan ?? spans.find((s) => s.kind !== 'thinking_phase') ?? spans[0];
            if (target) handleInspect(target.id);
          }}
          className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-11 transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary-strong)_10%,transparent)]"
          style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
          title="在弹窗中查看当前选中事件详情"
        >
          <PanelRight className="h-3 w-3" /> 点击事件查看详情
        </button>
      </div>

      {/* ==== 工具栏 ==== */}
      <div className="mb-1 flex flex-wrap items-center gap-1.5 rounded-md px-2 py-1" style={{ backgroundColor: 'color-mix(in oklab, var(--paper-soft) 50%, transparent)' }}>
        <button
          type="button"
          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium transition-colors', durationMode === 'actual' && 'ring-1 ring-inset')}
          style={{
            color: durationMode === 'actual' ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--ink-muted) 60%, transparent)',
            ...(durationMode === 'actual' ? { boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary-strong) 40%, transparent)' } : {}),
          }}
          onClick={() => setDurationMode((v) => (v === 'actual' ? 'equal' : 'actual'))}
          title="等宽 / 实际耗时"
        >
          <Clock3 className="h-3 w-3" />
          {durationMode === 'actual' ? '实际耗时' : '等宽'}
        </button>

        <button
          type="button"
          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium transition-colors', callsCollapsed && 'ring-1 ring-inset')}
          style={{
            color: callsCollapsed ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--ink-muted) 60%, transparent)',
            ...(callsCollapsed ? { boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary-strong) 40%, transparent)' } : {}),
          }}
          onClick={() => setCallsCollapsed((v) => !v)}
          title={callsCollapsed ? '展开工具调用' : '折叠工具调用为摘要'}
        >
          <ListCollapse className="h-3 w-3" />
          {callsCollapsed ? `${toolSpans.length} tools` : '折叠调用'}
        </button>

        {/* P3 replay：逐事件回放（仅非流式 + 单 Turn 时可用；回放中点击停止） */}
        {!isStreaming && spans.length > 0 && turnGroups.length <= 1 && (
          <button
            type="button"
            className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium transition-colors', replaying && 'ring-1 ring-inset')}
            style={{
              color: replaying ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--ink-muted) 60%, transparent)',
              ...(replaying ? { boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary-strong) 40%, transparent)' } : {}),
            }}
            onClick={toggleReplay}
            title={replaying ? '停止回放' : '逐步回放执行过程'}
          >
            {replaying ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {replaying ? '停止' : '回放'}
          </button>
        )}

        <div className="flex-1" />

        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索记录…"
            className="w-36 rounded-full border-0 bg-transparent py-0.5 pl-7 pr-2 text-12 outline-none"
            style={{ color: 'var(--ink)', border: '1px solid color-mix(in oklab, var(--line) 50%, transparent)' }}
          />
        </div>
      </div>

      {/* ==== Overview 时间线 ==== */}
      <div className="mb-1.5 flex h-5 items-stretch gap-px overflow-hidden rounded-md px-1" style={{ backgroundColor: 'color-mix(in oklab, var(--paper-soft) 50%, transparent)' }}>
        {overviewBlocks.map((b) => {
          const color = kindColor(b.kind, b.phase);
          const flexGrow = durationMode === 'actual' && b.durationMs > 0 ? b.durationMs / totalDur : undefined;
          return (
            <div
              key={b.id}
              className="min-w-0 rounded-sm"
              title={b.title}
              style={{
                backgroundColor: b.phase === 'error' ? 'var(--danger)' : color,
                flexGrow,
                flexBasis: flexGrow ? 0 : undefined,
                flex: flexGrow ? `${flexGrow} 1 0` : '1 1 0',
                opacity: b.phase === 'pending' || b.phase === 'skipped' ? 0.4 : 0.85,
              }}
            />
          );
        })}
        {overviewBlocks.length === 0 && (
          <div className="flex-1 rounded-sm" style={{ backgroundColor: 'color-mix(in oklab, var(--ink-muted) 20%, transparent)' }} />
        )}
      </div>

      {/* ==== 主体：事件表（点击事件行 → 详情弹窗 + 下方内联检查器） ==== */}
      <div className="flex w-full min-w-0 items-start gap-2">
        {/* 事件表 */}
        <div className="min-w-0 flex-1">
          {/* P1 轨迹：Turn 分组（按模型调用轮渲染 Turn 头；单组=旧消息数据，交互与旧版一致） */}
          {turnGroups.map(({ turn, rows, preview }) => {
            const expanded = expandedTurns.has(turn);
            const groupToolSpans = rows.filter((s) => isToolKind(s.kind));
            let groupRows = callsCollapsed ? rows.filter((s) => !isToolKind(s.kind)) : rows;
            // P3 replay：回放中只显示前 replayCount 个 span（逐步长出）；回放仅在单 Turn 下可用
            if (replaying) groupRows = groupRows.slice(0, replayCount);
            return (
              <div key={turn} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--paper-soft) 55%, transparent)' }}
                  onClick={() => toggleTurn(turn)}
                >
                  <ChevronDown
                    className={cn('h-3 w-3 shrink-0 transition-transform', !expanded && '-rotate-90')}
                    style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}
                  />
                  <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}>
                    Turn {turn}
                  </span>
                  {rows.length > 0 && (
                    <span
                      className="rounded-full px-1.5 py-px text-10 font-semibold leading-none"
                      style={{ backgroundColor: 'color-mix(in oklab, var(--line) 30%, transparent)', color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}
                    >
                      {rows.length}
                    </span>
                  )}
                </button>

                {/* Turn 折叠态思考摘要：不展开也能知道这一轮在想什么（无思考轮不显示） */}
                {!expanded && preview && (
                  <button
                    type="button"
                    className="-mt-0.5 mb-0.5 flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-md py-0.5 pl-8 pr-2 text-left transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-soft)_60%,transparent)]"
                    onClick={() => toggleTurn(turn)}
                    title="点击展开本轮思考"
                  >
                    <Brain className="mt-0.5 h-2.5 w-2.5 shrink-0" style={{ color: 'color-mix(in oklab, var(--primary-strong) 55%, transparent)' }} />
                    <span className="line-clamp-2 text-11 leading-relaxed" style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}>
                      {preview}
                    </span>
                  </button>
                )}

                {expanded && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    {callsCollapsed && groupToolSpans.length > 0 && (
                      <div
                        className="flex w-full min-w-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5"
                        style={{ backgroundColor: 'color-mix(in oklab, var(--info) 10%, transparent)' }}
                        onClick={() => setCallsCollapsed(false)}
                        title="点击展开所有工具调用"
                      >
                        <div className="h-4 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: 'var(--info)' }} />
                        <Wrench className="h-3.5 w-3.5" style={{ color: 'var(--info)' }} />
                        <span className="flex-1 truncate text-13" style={{ color: 'var(--ink)' }}>
                          {groupToolSpans.length} 次工具调用
                        </span>
                        <span className="text-11" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
                          展开
                        </span>
                        <ChevronRight className="h-3 w-3" style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)' }} />
                      </div>
                    )}

                    {groupRows.map((span) => (
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
              </div>
            );
          })}

          {/* 内联事件检查器已移除：事件详情统一走弹窗（点击事件行 → 事件详情弹窗） */}
        </div>
      </div>
    </div>

      {/* 事件详情弹窗：显式点击事件行时打开，确保有明确反馈 */}
      {detailSpan && (
        <Dialog open onOpenChange={(v) => !v && setDetailId(null)}>
          <DialogContent className="flex max-h-[85vh] flex-col p-0 sm:max-w-[560px]">
            <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-2 px-5 py-3" style={{ borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}>
              <DialogTitle className="text-sm font-semibold leading-none" style={{ color: 'var(--ink-strong)' }}>
                事件详情
              </DialogTitle>
              <div className="flex items-center gap-1">
                {/* P3 fork：从该事件点分叉继续（仅工具类事件 + 提供 onFork 时可用） */}
                {onFork && (detailSpan.kind === 'tool_call' || detailSpan.kind === 'mcp_call') && (
                  <button
                    type="button"
                    onClick={() => { setDetailId(null); onFork(detailSpan); }}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-12 font-medium transition-colors hover:bg-black/5"
                    style={{ color: 'var(--primary-strong)' }}
                    title="从该步骤之后分叉，基于上文继续提问"
                  >
                    <GitFork className="h-3.5 w-3.5" /> Fork here
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDetailId(null)}
                  className="rounded-md p-1.5 transition-colors hover:bg-black/5"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </DialogHeader>
            <DialogDescription className="sr-only">事件详情</DialogDescription>
            <div className="min-h-0 flex-1 overflow-y-auto p-4" style={{ backgroundColor: 'var(--paper-soft)' }}>
              <EventInspector span={detailSpan} isStreaming={isStreaming} />
            </div>
          </DialogContent>
         </Dialog>
       )}
    </>
  );
}
