/**
 * ChatNodeKernel 无状态子组件（从 ChatNodeKernel.tsx 抽离，T1-2 / Phase A 式零行为变更迁移）。
 * 渲染型单元：错误边界 / 附件与引用 chips / 步骤类型图标 / 执行过程摘要 / 分步看板（后两者自带局部交互状态）。
 */
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AtSign, Brain, ChevronDown, ClipboardList, FileText, Film, Folder, Globe,
  Image as ImageIcon, Link2, Loader2, Music, Paperclip, Pencil, Plug, Search,
  Sparkles, Terminal, Wrench, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MessageAttachment, MessageReference, ToolCallPhase, ToolCallRecord } from '@/lib/types';
import { formatFileSize } from './composer/useComposer';
import { estimateProcessRows, finalizeToolCallPhase, formatDuration, openChipPath } from './chatNodeKernelUtils';

/** 消息渲染区错误边界：正文/StreamingMarkdown 等渲染异常时降级为可恢复提示，避免整节点空白。
 *  仅 widget 有自身兜底，正文区没有——渲染崩溃会直接清空整个节点，这里补上。 */
export class MessagesErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[MessagesErrorBoundary] 消息渲染异常，已降级为提示卡:', error instanceof Error ? error.message : String(error));
  }

  handleReset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="mx-3 my-2 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs"
          style={{
            borderColor: 'color-mix(in oklab, var(--danger) 30%, transparent)',
            color: 'var(--ink-muted)',
            fontFamily: 'var(--font-sans)',
          }}
        >
          <span className="text-xs">⚠</span>
          <span className="flex-1">Messages failed to render due to an unexpected error.</span>
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded px-2 py-0.5 font-medium transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--primary-strong)' }}
          >
            Retry render
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
/** 消息附件 chips（用户/助手消息通用）：图片缩略图或类型图标 + 文件名 + 大小 */
export function AttachmentChips({ attachments, role }: { attachments: MessageAttachment[]; role: 'user' | 'assistant' }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-0.5">
      {attachments.map((att) => {
        // folder 是授权目录、无预览语义；无 path 的历史附件同样不可点
        const canOpen = att.type !== 'folder' && !!att.path;
        return (
        <span
          key={att.id}
          onClick={canOpen ? (e) => { e.stopPropagation(); openChipPath(att.path, att.name); } : undefined}
          title={canOpen ? att.path : undefined}
          role={canOpen ? 'button' : undefined}
          className={cn('inline-flex items-center gap-0.5 rounded-full px-1 py-px', canOpen && 'cursor-pointer hover:opacity-80')}
          style={{
            backgroundColor: role === 'user' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'rgba(255,255,255,0.5)',
            border: `1px solid ${role === 'user' ? 'var(--primary-soft)' : 'rgba(0,0,0,0.08)'}`,
          }}
        >
          {att.type === 'image' && att.dataUrl ? (
            <img src={att.dataUrl} alt={att.name} className="h-3 w-3 rounded-sm object-cover" />
          ) : att.type === 'text' ? (
            <FileText className="h-2.5 w-2.5" style={{ color: '#537D96' }} />
          ) : att.type === 'folder' ? (
            <Folder className="h-2.5 w-2.5" style={{ color: 'var(--info)' }} />
          ) : att.type === 'video' ? (
            <Film className="h-2.5 w-2.5" style={{ color: 'var(--warn)' }} />
          ) : att.type === 'audio' ? (
            <Music className="h-2.5 w-2.5" style={{ color: 'var(--success)' }} />
          ) : (
            <Paperclip className="h-2.5 w-2.5" style={{ color: '#7a7260' }} />
          )}
          <span className="max-w-[48px] truncate text-xs" style={{ color: role === 'user' ? 'color-mix(in oklab, var(--ink-muted) 80%, transparent)' : '#a09880' }}>
            {att.name}
          </span>
          <span className="text-xs" style={{ color: role === 'user' ? 'color-mix(in oklab, var(--ink) 50%, transparent)' : '#a09880' }}>
            {formatFileSize(att.size)}
          </span>
        </span>
        );
      })}
    </div>
  );
}

/**
 * 消息 @引用 chips（用户消息）：资料库文件 / 引用本地文件 / 链接材料 / 操作目录。
 * 与 AttachmentChips 并列渲染于气泡内；虚线边框 + AtSign/Link2/Folder 图标与上传附件区分。
 */
export function ReferenceChips({ references, role }: { references: MessageReference[]; role: 'user' | 'assistant' }) {
  if (!references || references.length === 0) return null;
  const nameColor = role === 'user' ? 'color-mix(in oklab, var(--ink-muted) 80%, transparent)' : '#a09880';
  return (
    <div className="mb-2 flex flex-wrap gap-0.5">
      {references.map((ref) => {
        // link 走浏览器打开 url；material/file 走预览面板；folder 是操作目录、无预览语义
        const isLink = ref.kind === 'link' && !!ref.url;
        const canOpen = isLink || ((ref.kind === 'material' || ref.kind === 'file') && !!ref.path);
        return (
        <span
          key={ref.id}
          onClick={canOpen ? (e) => {
            e.stopPropagation();
            if (ref.kind === 'link' && ref.url) window.open(ref.url, '_blank', 'noopener');
            else openChipPath(ref.path, ref.name);
          } : undefined}
          title={ref.path ?? ref.url ?? ref.name}
          role={canOpen ? 'button' : undefined}
          className={cn('inline-flex items-center gap-0.5 rounded-full px-1 py-px', canOpen && 'cursor-pointer hover:opacity-80')}
          style={{
            backgroundColor: role === 'user' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'rgba(255,255,255,0.5)',
            border: `1px dashed ${role === 'user' ? 'var(--primary-soft)' : 'rgba(0,0,0,0.08)'}`,
          }}
        >
          {ref.kind === 'link' ? (
            <Link2 className="h-2.5 w-2.5" style={{ color: '#3b82c4' }} />
          ) : ref.kind === 'folder' ? (
            <Folder className="h-2.5 w-2.5" style={{ color: 'var(--info)' }} />
          ) : (
            <AtSign className="h-2.5 w-2.5" style={{ color: '#537D96' }} />
          )}
          <span className="max-w-[64px] truncate text-xs" style={{ color: nameColor }}>
            {ref.name}
          </span>
          {ref.size ? (
            <span className="text-xs" style={{ color: nameColor }}>
              {ref.size}
            </span>
          ) : null}
        </span>
        );
      })}
    </div>
  );
}
/**
 * StepTypeIcon — 每步的「类型图标」：按工具名映射为固定语义图标。
 * 原则：图标与颜色执行中/完成/失败都不变；完成与否改由行尾文字后的 ✓ / ✕ / 呼吸点表达。
 */
export function StepTypeIcon({ name, size = 14 }: { name: string; size?: number }) {
  const n = name.toLowerCase();
  const color = 'color-mix(in oklab, var(--ink-muted) 72%, transparent)';
  const cls = { width: size, height: size, flexShrink: 0, color } as const;
  const file = n.includes('write_file') || n.includes('read_file') || n.includes('delete_file') || n.includes('rename_file')
    || n.includes('edit_code') || n.includes('create_file') || n.includes('list_directory') || n.includes('list_files') || n.includes('search_files')
    || n.includes('attachment') || n.includes('material') || n.includes('upload_file') || n.includes('export_pdf');
  const search = n.includes('web_search') || n.includes('search_web') || n.includes('intern_search') || n.includes('search_capabilities') || n.includes('search');
  const web = n.includes('navigate') || n.includes('web_fetch') || n.includes('fetch') || n.includes('browser') || n.includes('get_html') || n.includes('click') || n.includes('type') || n.includes('fill') || n.includes('select_') || n.includes('press_key') || n.includes('scroll') || n.includes('wait_for') || n.includes('login') || n.includes('handle_dialog') || n.includes('resize_viewport') || n.includes('screenshot') || n.includes('extract_text') || n.includes('interact_preview') || n.includes('capture_preview') || n.includes('get_storage') || n.includes('reload') || n.includes('back') || n.includes('forward');
  const ocr = n.includes('ocr') || n.includes('crop_image') || n.includes('vision') || n.includes('recognize');
  const cmd = n.includes('run_command') || n.includes('execute_script') || n.includes('bash') || n.includes('shell') || n.includes('install_') || n.includes('python') || n.includes('pip');
  const skill = n.includes('skill') || n.includes('load_skill') || n.includes('read_skill');
  const todo = n.includes('sticky_note') || n.includes('scheduled_todo') || n.includes('todo_') || n.includes('query_schedule') || n.includes('query_todos') || n.includes('project_plan') || n.includes('calendar') || n.includes('event');
  const note = n.includes('read_raw_inbox') || n.includes('inbox') || n.includes('kar') || n.includes('note');
  const upstream = n.includes('upstream') || n.includes('intern') || n.includes('read_node') || n.includes('materials') || n.includes('root');
  const mcp = n.startsWith('mcp_') || n.includes('__');
  if (file) return <Pencil style={cls} />;
  if (ocr) return <ImageIcon style={cls} />;
  if (search) return <Search style={cls} />;
  if (web) return <Globe style={cls} />;
  if (cmd) return <Terminal style={cls} />;
  if (skill) return <Sparkles style={cls} />;
  if (todo) return <ClipboardList style={cls} />;
  if (note) return <Paperclip style={cls} />;
  if (upstream) return <Link2 style={cls} />;
  if (mcp) return <Plug style={cls} />;
  return <Wrench style={cls} />;
}
/**
 * TraceProcessSummary — 对话视图「执行过程」紧凑摘要（对齐 dsh 对话页签）。
 * 只给过程感：思考收成小条、每个工具一行摘要、技能小药丸；
 * 点击 Think / 工具行就地展开明细（思考原文 / 参数 / 结果），不切换到 Trace 视图。
 */
export function TraceProcessSummary({
  thinkText,
  toolCalls,
  skillNames,
  isStreaming,
  thinkingActive,
  hideStructuralTools,
}: {
  thinkText?: string;
  toolCalls: ToolCallRecord[];
  skillNames: string[];
  isStreaming: boolean;
  /** 当前是否正处于思考阶段（仅该消息流式 + thinking 阶段为 true，用于 Think 行末尾呼吸点） */
  thinkingActive?: boolean;
  /** 流式中隐藏结构性工具行（todo_write / finish_task / 存量 plan_task）——它们由右侧 DOS 步骤面板结构化呈现 */
  hideStructuralTools?: boolean;
}) {
  const [thinkOpen, setThinkOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState<number | null>(null);
  /** 结束态整体折叠：已完成且过程区超一行时默认折叠；流式中恒展开以便看实时进度 */
  const [groupFolded, setGroupFolded] = useState<boolean>(
    () => !isStreaming && estimateProcessRows(thinkText, toolCalls, skillNames) > 1,
  );
  const prevStreamingRef = useRef<boolean>(isStreaming);
  // 流式结束（true→false）且过程区超过一行时，整块自动收成一条 Process 标题行；同时收起块内已展开的 Think/工具明细
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming && estimateProcessRows(thinkText, toolCalls, skillNames) > 1) {
      setGroupFolded(true);
      setThinkOpen(false);
      setToolOpen(null);
    }
  }, [isStreaming, thinkText, toolCalls, skillNames]);
  const hasThink = !!thinkText && thinkText.trim().length > 0;
  const calls = toolCalls ?? [];
  const visibleCalls = hideStructuralTools
    ? calls.filter((tc) => tc.toolName !== 'todo_write' && tc.toolName !== 'plan_task' && tc.toolName !== 'finish_task')
    : calls;
  const skills = skillNames ?? [];
  if (!hasThink && calls.length === 0 && skills.length === 0) return null;
  const totalRows = estimateProcessRows(thinkText, toolCalls, skillNames);
  const showFoldHeader = !isStreaming && totalRows > 1;
  const showDetail = isStreaming || !showFoldHeader || !groupFolded;
  const failCount = visibleCalls.filter((tc) => tc.phase === 'error' || tc.success === false).length;
  const processSummary = [
    hasThink ? '1 thought' : null,
    visibleCalls.length > 0 ? `${visibleCalls.length} tool${visibleCalls.length === 1 ? '' : 's'}` : null,
    skills.length > 0 ? `${skills.length} skill${skills.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  const toggleGroupFold = () => {
    if (!groupFolded) {
      setThinkOpen(false);
      setToolOpen(null);
    }
    setGroupFolded((v) => !v);
  };
  const human = (name: string) => name.replace(/^browser[._]/, '').replace(/_/g, ' ');
  const phaseLabel = (phase: ToolCallPhase): string =>
    phase === 'running' ? 'Running…' : phase === 'pending' ? 'Pending…' : phase === 'error' ? 'Failed' : 'Success';
  const pretty = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    try {
      const s = JSON.stringify(v, null, 2);
      return s === undefined ? String(v) : s;
    } catch {
      return String(v);
    }
  };
  return (
    <div className="mb-1 flex w-full min-w-0 flex-col items-start gap-0.5">
      {/* 结束态整体折叠标题行：已完成且过程区超一行时显示；点击展开/收起整块过程明细 */}
      {showFoldHeader && (
        <button
          type="button"
          onClick={toggleGroupFold}
          title={groupFolded ? 'Show process details' : 'Hide process details'}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-1 py-0.5 text-left transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_5%,transparent)]"
        >
          <Wrench className="h-3 w-3 shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }} />
          <span className="text-10 font-semibold uppercase tracking-wide" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
            Process
          </span>
          {processSummary && (
            <span className="min-w-0 truncate text-11 font-medium" style={{ color: 'var(--ink)' }}>
              {processSummary}
            </span>
          )}
          {failCount > 0 && (
            <span className="shrink-0 text-10 font-bold leading-none" style={{ color: 'var(--danger)' }}>
              ✕ {failCount}
            </span>
          )}
          <ChevronDown
            className={cn('h-3 w-3 shrink-0 transition-transform duration-150', !groupFolded && 'rotate-180')}
            style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)' }}
          />
        </button>
      )}
      {showDetail && (
        <>
      {/* Think 小条：默认收起，点击就地展开思考原文 */}
      {hasThink && (
        <>
          <button
            type="button"
            onClick={() => setThinkOpen((v) => !v)}
            title={thinkOpen ? 'Collapse thinking' : 'Expand thinking'}
            className="inline-flex max-w-full cursor-pointer items-center gap-1 py-0.5 transition-opacity hover:opacity-70"
          >
            <Brain className="h-2.5 w-2.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
            <span className="text-10 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
              Think
            </span>
            {thinkingActive && (
              <span className="flex shrink-0 items-center gap-0.5">
                <span className="think-dot" />
                <span className="think-dot" />
                <span className="think-dot" />
              </span>
            )}
          </button>
          {thinkOpen && (
            <div
              className="ai-canvas-scroll max-h-[300px] w-full self-start overflow-y-auto whitespace-pre-wrap rounded-md border px-2 py-1.5 text-11 leading-relaxed"
              style={{
                borderColor: 'color-mix(in oklab, var(--primary) 18%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--primary) 4%, var(--paper))',
                color: 'var(--ink)',
              }}
            >
              {thinkText?.trim()}
            </div>
          )}
        </>
      )}
      {/* 工具调用：默认一行摘要，点击就地展开参数与结果 */}
      {visibleCalls.map((tc, i) => {
        const phase: ToolCallPhase = tc.phase ?? (tc.success === false ? 'error' : tc.success ? 'done' : 'running');
        const busy = isStreaming && (phase === 'running' || phase === 'pending');
        const open = toolOpen === i;
        const argsText = pretty(tc.arguments);
        const hasResult = !!tc.result && tc.result !== '...';
        return (
          <div key={tc.spanId ?? `${tc.toolName}-${i}`} className="flex w-full min-w-0 flex-col items-start">
            <button
              type="button"
              onClick={() => setToolOpen(open ? null : i)}
              title={open ? 'Collapse step details' : 'Show step details'}
              className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-1 py-0.5 text-left transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_5%,transparent)]"
            >
              <StepTypeIcon name={tc.toolName} />
              <span className="truncate text-11 font-medium" style={{ color: 'var(--ink)' }}>{human(tc.toolName)}</span>
              {(tc.purpose || tc.changeSummary) && (
                <span className="min-w-0 flex-1 truncate text-10" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                  {tc.changeSummary || tc.purpose}
                </span>
              )}
              {/* 状态标识不换图标颜色：进行中 = 文字后呼吸点；失败 = 文字后 ✕（成功不额外标记） */}
              {busy ? (
                <span className="flex shrink-0 items-center gap-0.5" style={{ color: 'var(--primary-strong)' }}>
                  <span className="think-dot" />
                  <span className="think-dot" />
                  <span className="think-dot" />
                </span>
              ) : phase === 'error' ? (
                <span className="shrink-0 text-10 font-bold leading-none" style={{ color: 'var(--danger)' }}>
                  ✕
                </span>
              ) : null}
              {tc.durationMs > 0 && (phase === 'done' || phase === 'error') && (
                <span className="shrink-0 text-10" style={{ color: 'color-mix(in oklab, var(--ink-muted) 45%, transparent)' }}>
                  {formatDuration(tc.durationMs)}
                </span>
              )}
            </button>
            {open && (
              <div
                className="mb-0.5 flex w-full min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5"
                style={{
                  borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                  backgroundColor: 'color-mix(in oklab, var(--paper-soft) 60%, transparent)',
                }}
              >
                {/* 状态 + 完整工具名 + 耗时 */}
                <div className="flex min-w-0 items-center gap-1.5 text-10">
                  <span className="shrink-0 font-semibold" style={{ color: phase === 'error' ? 'var(--danger)' : phase === 'done' ? 'var(--success)' : 'var(--primary-strong)' }}>
                    {phaseLabel(phase)}
                  </span>
                  <span className="truncate font-medium" style={{ color: 'var(--ink)' }}>{tc.toolName}</span>
                  {tc.durationMs > 0 && (
                    <span className="shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 45%, transparent)' }}>{formatDuration(tc.durationMs)}</span>
                  )}
                </div>
                {/* 目的 / 系统变更摘要 */}
                {(tc.purpose || tc.changeSummary) && (
                  <div className="flex min-w-0 gap-1.5 text-10 leading-relaxed" style={{ color: 'var(--ink)' }}>
                    <span className="shrink-0 font-semibold uppercase tracking-wide" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
                      Purpose
                    </span>
                    <span className="min-w-0">{tc.changeSummary || tc.purpose}</span>
                  </div>
                )}
                {/* 参数 */}
                {argsText && (
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-10 font-semibold uppercase tracking-wide" style={{ color: 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}>
                      Args
                    </span>
                    <pre
                      className="ai-canvas-scroll max-h-[220px] w-full overflow-auto whitespace-pre-wrap break-all rounded px-2 py-1 font-mono text-10 leading-relaxed"
                      style={{
                        backgroundColor: 'var(--paper)',
                        border: '1px solid color-mix(in oklab, var(--line) 25%, transparent)',
                        color: 'color-mix(in oklab, var(--ink) 85%, transparent)',
                      }}
                    >
                      {argsText}
                    </pre>
                  </div>
                )}
                {/* 结果 */}
                {hasResult && (
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-10 font-semibold uppercase tracking-wide" style={{ color: phase === 'error' ? 'var(--danger)' : 'var(--success)' }}>
                      Result
                    </span>
                    <pre
                      className="ai-canvas-scroll max-h-[260px] w-full overflow-auto whitespace-pre-wrap break-all rounded px-2 py-1 font-mono text-10 leading-relaxed"
                      style={{
                        backgroundColor: 'var(--paper)',
                        border: '1px solid color-mix(in oklab, var(--line) 25%, transparent)',
                        color: 'color-mix(in oklab, var(--ink) 85%, transparent)',
                      }}
                    >
                      {tc.result}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {/* 命中的技能：小药丸提示 */}
      {skills.length > 0 && (
        <div className="flex w-full flex-wrap items-center gap-0.5">
          {skills.map((s) => (
            <span
              key={s}
              title="Skill load details live in the Trace view"
              className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-10"
              style={{
                color: 'color-mix(in oklab, var(--info) 75%, transparent)',
                borderColor: 'color-mix(in oklab, var(--info) 25%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--info) 6%, transparent)',
              }}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {s}
            </span>
          ))}
        </div>
      )}
        </>
      )}
    </div>
  );
}

/**
 * TaskStepsPanel — 节点右侧悬浮「DOS 执行步骤」面板。
 * 数据源：agent 通过 todo_write 提交的三态真状态（content + activeForm + status）。
 * 状态映射：completed ✓ / in_progress 旋转箭头+activeForm / pending 置灰序号 / failed ✗；
 * 面板底部附「Now」高亮条展示当前步动态文案。fixed 定位跟随节点右缘（rAF 跟踪 rect），portal 到 body。
 */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export interface PanelStep {
  content: string;
  activeForm: string;
  status: StepStatus;
}
export function TaskStepsPanel({
  anchor,
  goal,
  steps,
  completed,
  running,
  discarded,
  onClose,
}: {
  anchor: HTMLElement | null;
  goal: string;
  steps: PanelStep[];
  completed: number;
  running: boolean;
  /** 本轮的多智能体方案被用户丢弃（审批卡 Discard / 超时作废）：步骤轨不再推进，
   *  面板收口为终态「DISCARDED」，避免停在 EXECUTING 让人误以为还在执行 */
  discarded?: boolean;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 上一帧坐标镜像：坐标未变时跳过 setPos，避免每帧用新对象触发一次重渲染
  const lastPosRef = useRef<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    let raf = 0;
    const PANEL_W = 300;
    const update = () => {
      const r = anchor.getBoundingClientRect();
      const estH = 120 + steps.length * 26;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const left = Math.max(8, Math.min(r.right + 10, vw - PANEL_W - 8));
      const top = Math.max(8, Math.min(r.top + 8, vh - estH - 8));
      const last = lastPosRef.current;
      if (!last || last.left !== left || last.top !== top) {
        lastPosRef.current = { left, top };
        setPos({ left, top });
      }
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [anchor, steps.length]);
  if (!pos) return null;

  const total = steps.length;
  const allDone = completed >= total && !running;
  const failedCount = steps.filter((s) => s.status === 'failed').length;
  // 丢弃后步骤轨不再推进：不 pulse、不认「当前步」（in_progress 视为已终止的普通步骤）
  const isRunning = running && !discarded;
  const currentIdx = discarded ? -1 : steps.findIndex((s) => s.status === 'in_progress');
  const displayCount = Math.min(completed, total);
  const mono = "'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace";
  return createPortal(
    <div
      data-canvas-ui="overlay"
      className="overflow-hidden rounded-xl shadow-2xl"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width: 300,
        zIndex: 640,
        fontFamily: mono,
        backgroundColor: '#0a0e14',
        border: '1px solid rgba(34,197,94,0.45)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(34,197,94,0.12)',
      }}
    >
      {/* 顶栏 */}
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5"
        style={{ backgroundColor: '#10161f', borderBottom: '1px solid rgba(34,197,94,0.25)' }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: discarded ? '#fbbf24' : failedCount > 0 ? '#f87171' : '#34d399',
            boxShadow: isRunning ? `0 0 6px ${failedCount > 0 ? '#f87171' : '#34d399'}` : 'none',
            animation: isRunning ? 'pulse 1.2s ease-in-out infinite' : 'none',
          }}
        />
        <span
          className="text-10 font-bold tracking-[0.14em]"
          style={{ color: discarded ? '#fbbf24' : failedCount > 0 ? '#f87171' : '#34d399' }}
        >
          {discarded ? 'DISCARDED' : allDone ? (failedCount > 0 ? 'DONE w/ ERRORS' : 'COMPLETE') : 'EXECUTING'}
        </span>
        <span className="text-10" style={{ color: 'rgba(148,163,184,0.55)' }}>
          {displayCount}/{total}{failedCount > 0 ? ` · ${failedCount} failed` : ''}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          title="Close steps panel"
          className="cursor-pointer rounded px-1 text-11 transition-colors hover:bg-white/10"
          style={{ color: 'rgba(148,163,184,0.9)' }}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {/* Goal */}
      {goal && (
        <div className="border-b px-2.5 py-1.5" style={{ borderColor: 'rgba(34,197,94,0.15)', backgroundColor: '#0d131c' }}>
          <div className="text-9 font-semibold uppercase tracking-widest" style={{ color: 'rgba(148,163,184,0.6)' }}>
            Goal
          </div>
          <div className="mt-0.5 text-11 leading-snug" style={{ color: '#e2e8f0', wordBreak: 'break-word' }}>
            {goal}
          </div>
        </div>
      )}
      {/* 步骤清单 */}
      <div className="flex max-h-[340px] flex-col gap-px overflow-y-auto px-2 py-2">
        {steps.map((s, i) => {
          const text = s.content.replace(/^Step\s*\d+\s*[:.]\s*/i, '');
          const isDone = s.status === 'completed';
          // 丢弃后 in_progress 不再渲染成「正在执行」（无旋转箭头/无 activeForm 脉冲），降级为置灰普通步
          const isCurrent = !discarded && s.status === 'in_progress';
          const isFailed = s.status === 'failed';
          // 当前步优先展示 activeForm 动态文案，否则展示静态 content
          const label = isCurrent && s.activeForm ? s.activeForm : text;
          const color = isDone ? '#86efac' : isCurrent ? '#a5f3fc' : isFailed ? '#fca5a5' : 'rgba(148,163,184,0.45)';
          const bg = isCurrent ? 'rgba(34,211,238,0.06)' : isFailed ? 'rgba(248,113,113,0.06)' : 'transparent';
          return (
            <div
              key={i}
              className="flex min-w-0 items-start gap-1.5 rounded px-1 py-0.5"
              style={{ color, backgroundColor: bg }}
            >
              <span className="mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center text-10 leading-none">
                {isDone ? (
                  <span style={{ color: '#34d399' }}>✓</span>
                ) : isFailed ? (
                  <span style={{ color: '#f87171' }}>✗</span>
                ) : isCurrent ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" style={{ color: '#22d3ee' }} />
                ) : (
                  <span style={{ color: 'rgba(148,163,184,0.4)' }}>{String(i + 1).padStart(2, '0')}</span>
                )}
              </span>
              <span className={cn('min-w-0 text-11 leading-snug', isCurrent && 'animate-pulse')} style={{ wordBreak: 'break-word' }}>
                {isCurrent && '▸ '}
                {label}
              </span>
            </div>
          );
        })}
      </div>
      {/* 当前步高亮条（独立于清单，便于一眼定位正在做什么）；方案被丢弃 → 改显终态说明，不再假装还在跑 */}
      {discarded ? (
        <div className="border-t px-2.5 py-1" style={{ borderColor: 'rgba(251,191,36,0.25)', backgroundColor: '#0d131c' }}>
          <div className="text-9 font-semibold uppercase tracking-widest" style={{ color: 'rgba(251,191,36,0.75)' }}>
            Discarded
          </div>
          <div className="mt-0.5 text-11 leading-snug" style={{ color: '#fcd34d', wordBreak: 'break-word' }}>
            Multi-agent plan discarded — no member or task was created.
          </div>
        </div>
      ) : (
        currentIdx >= 0 && (
          <div className="border-t px-2.5 py-1" style={{ borderColor: 'rgba(34,197,94,0.2)', backgroundColor: '#0d131c' }}>
            <div className="text-9 font-semibold uppercase tracking-widest" style={{ color: 'rgba(34,211,238,0.7)' }}>
              Now
            </div>
            <div className="mt-0.5 text-11 leading-snug animate-pulse" style={{ color: '#a5f3fc', wordBreak: 'break-word' }}>
              {steps[currentIdx].activeForm || steps[currentIdx].content}
            </div>
          </div>
        )
      )}
    </div>,
    document.body,
  );
}

