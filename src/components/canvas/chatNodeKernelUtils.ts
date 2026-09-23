/**
 * ChatNodeKernel 纯函数与常量（从 ChatNodeKernel.tsx 抽离，T1-2 / Phase A 式零行为变更迁移）。
 * 全部为无 React 依赖的工具：think 标签解析 / 网络错误判定与自愈 fetch / 消息终态化 /
 * 引用组装与剥离 / 兜底标题 / 时间格式化 / 各类 UI 元数据表。
 */
import { bus, BusEvents } from '@/lib/bus';
import type {
  ChatMessage,
  MessageAttachment,
  MessageReference,
  ThinkingLevel,
  ToolCallPhase,
  ToolCallRecord,
} from '@/lib/types';
import type { CodingPhase } from '@/lib/agents/profiles';
import { formatFileSize, type MaterialItem, type ComposerLink, type ComposerDirRef } from './composer/useComposer';

// ── S2b 思考档位徽标元数据（字母 + 颜色）：DSH 四档 off/low/high/max + legacy medium
//  legacy medium 保留旧 M/蓝 显示（存量消息/节点向后兼容）
export const THINKING_LEVEL_LETTER: Record<ThinkingLevel, string> = {
  off: 'O',
  low: 'L',
  medium: 'M',
  high: 'H',
  max: 'X',
};
export const THINKING_LEVEL_COLOR: Record<ThinkingLevel, string> = {
  off: 'var(--ink-muted)',
  low: 'var(--info)',
  medium: 'var(--info)',
  high: 'color-mix(in oklab, var(--primary-strong) 55%, var(--info))',
  max: 'var(--primary-strong)',
};


/**
 * 复制文本到剪贴板（带降级与错误处理）。
 * Electron 打包/非 secure context 下 navigator.clipboard 可能不可用（undefined 或抛错），
 * 此时回退到隐藏 textarea + document.execCommand('copy')。返回是否成功。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    console.warn('[copy] navigator.clipboard failed, falling back to execCommand:', e);
  }
  try {
    // 降级：临时 textarea + execCommand（同步，兼容旧 WebView/非安全上下文）
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    console.warn('[copy] execCommand fallback failed:', e);
    return false;
  }
}

/**
 * 判断是否为网络层错误（而非 HTTP 状态码错误 / 用户取消）。
 * Chromium 对连接失败统一抛 `TypeError: Failed to fetch`；AbortError 是用户取消
 * /前端超时，绝不能重试。长时间闲置后（系统休眠 / App Nap / 本地服务被回收）
 * 首次 fetch 常见该错误，连接其实已经失效。
 */
export function isNetworkLevelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  return err instanceof TypeError || /Failed to fetch/i.test(err.message) || /fetch failed/i.test(err.message);
}

/**
 * 带本地服务恢复的 fetch：网络层失败时先探活等待本地服务恢复（主进程看门狗
 * 约 15s 内自动重启服务），服务就绪后把原请求重发一次。
 * 修复「BobWork 停滞久了，ChatNode 报 Error: Failed to fetch」——一次性网络失败
 * 不再直接展示错误，而是静默恢复后重试，避免用户手动重发。
 */
export async function fetchWithServerRecovery(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isNetworkLevelError(err) || init.signal?.aborted) throw err;
    // 探活等待本地服务恢复（最多 ~20s，覆盖看门狗 15s 周期 + 启动时间）
    const deadline = Date.now() + 20_000;
    let serverUp = false;
    while (Date.now() < deadline) {
      if (init.signal?.aborted) throw err;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2000);
      try {
        const probe = await fetch('/api/env', { signal: ctl.signal });
        if (probe.ok) {
          serverUp = true;
          break;
        }
      } catch {
        // 服务未恢复，继续探测
      } finally {
        clearTimeout(t);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!serverUp || init.signal?.aborted) throw err;
    // 服务已恢复：重发原请求一次
    return await fetch(url, init);
  }
}

export const SYSTEM_PROMPT =
  'You are a helpful, knowledgeable AI assistant. Respond concisely and clearly. Use markdown formatting when appropriate. Answer in the same language as the user.';

/** think 标签及其常见变体（大小写不敏感）：
 *  标准 <think>、以及部分模型（尤其追问模型）输出的 <thinking> / <Thought> / <reasoning> 等。
 *  这些变体若不被识别，think 内容会残留在正文中全文展示、折叠芯片不出现（"标签消失"的根因）。 */
const THINK_TAG_RE = /<(?:think|thinking|thought|reasoning)>([\s\S]*?)<\/(?:think|thinking|thought|reasoning)>/gi;

/** 未闭合的 think 标签（流式过程中） */
const THINK_OPEN_RE = /<(?:think|thinking|thought|reasoning)>([\s\S]*)$/i;

/** Parse <think>...</think> tags from content */
export function parseThink(content: string): { think: string; content: string } {
  let think = '';
  let clean = content;

  // Extract think 标签（支持多个 + 变体）
  const thinkMatches = clean.matchAll(THINK_TAG_RE);
  for (const m of thinkMatches) {
    think += m[1].trim() + '\n';
  }
  clean = clean.replace(THINK_TAG_RE, '');

  // Handle unclosed think 标签 (during streaming)
  const openThinkMatch = clean.match(THINK_OPEN_RE);
  if (openThinkMatch) {
    think += openThinkMatch[1].trim();
    clean = clean.replace(THINK_OPEN_RE, '');
  }

  const result = clean.trim();
  // 安全兜底：如果结果为空但原文有实质内容，可能是 think 未闭合导致全部清空
  if (!result && content.length > 20) {
    const fallback = content
      .replace(THINK_TAG_RE, '')
      .trim();
    return { think: think.trim(), content: fallback || content.trim() };
  }

  return { think: think.trim(), content: result };
}

/** 统一判定 AI 回复是否为「错误消息」（完成态判定 / 气泡染红 / No tools / 操作行共用同一启发式）：
 *  以 Error / 工具 / tool（可带 [ 前缀）开头的消息视为错误。避免"正文以 [ 开头被误染红"、
 *  "真错误消息却丢失操作入口"等分裂行为。 */
export function isErrorReply(text: string): boolean {
  if (!text) return false;
  return /^\[?(?:Error|工具|tool)/i.test(text.trimStart());
}

/**
 * 点击气泡内的附件 / 引用 chip 时，在预览面板打开对应文件。
 * 绝对路径（/ 或 ~ 开头）按 local 来源，项目内相对路径（materials/…、homework/…）按 project 来源，
 * 与 OutputFilesCard 的打开逻辑同源；目录类没有「预览」语义，由调用方过滤。
 */
export function openChipPath(path: string | undefined, name: string) {
  const p = (path ?? '').replace(/\\/g, '/').trim();
  if (!p) return;
  const isAbsolute = p.startsWith('~/') || p.startsWith('/');
  bus.publish(BusEvents.fileOpen, { source: isAbsolute ? 'local' : 'project', path: p, name });
}
/**
 * 由本轮 @引用 上下文组装消息级 references 快照。
 * 与发送给 AI 的正文块（--- 资料列表 --- 等）同源，保证「气泡 chip」与「模型实际收到的上下文」一致。
 */
export function buildTurnReferences(
  materials: MaterialItem[],
  dirRefs: ComposerDirRef[],
  links: ComposerLink[],
  folders: MessageAttachment[],
): MessageReference[] {
  const refs: MessageReference[] = [];
  for (const mat of materials) {
    refs.push({ id: `ref-mat:${mat.path}`, kind: 'material', name: mat.name, path: mat.path, size: formatFileSize(mat.size) });
  }
  for (const d of dirRefs) {
    refs.push({ id: `ref-dir:${d.path}`, kind: 'file', name: d.name, path: d.path, size: d.size });
  }
  for (const l of links) {
    refs.push({ id: `ref-link:${l.url}`, kind: 'link', name: l.url, url: l.url });
  }
  for (const f of folders) {
    refs.push({ id: `ref-folder:${f.path}`, kind: 'folder', name: f.name, path: f.path, locked: f.id.startsWith('sent-folder:') });
  }
  return refs;
}

/**
 * 剥离正文中已被 chip 承载的 @引用 标记（@文件名）。
 * 输入栏为支持「标记 ↔ chip」双向渲染，会把 chip 文案以 `@文件名` 形式写进镜像文本；
 * 若原样发送，气泡正文会与 chip 重复展示同一文件名。此处按本轮 references 精确剥离，
 * 仅剥离确实登记为引用的名字（用户手打的未被识别的 @xxx 保持不变）。
 */
export function stripReferenceMarkers(text: string, references: MessageReference[]): string {
  let out = text;
  for (const ref of references) {
    if (ref.kind !== 'material' && ref.kind !== 'file') continue;
    if (!ref.name) continue;
    const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`@${escaped}[ \\t]*`, 'g'), '');
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 兜底标题（规则层，0 token）：小模型命名失败/超时时，从用户首条消息提取简短标题。
 * 取首个非空行 → 剥离常见祈使引导词（请/帮我/麻烦…）→ 空白归一 → 截断 ≤20 字符。
 */
export function deriveInstantTitle(text: string): string {
  const firstLine = text
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? '';
  if (!firstLine) return '';
  const stripped = firstLine
    .replace(/^(请帮我|请你帮我|帮我写|帮我做|帮我生成|帮我|麻烦你|麻烦|拜托|请帮我|请你|请|我想|我想要|我要|我需要|能否|能不能|能帮我)[：:，,。.、\s]*/i, '')
    .trim();
  const base = stripped.length >= 2 ? stripped : firstLine;
  const compact = base.replace(/\s+/g, ' ').trim();
  return compact.length > 20 ? `${compact.slice(0, 20).trim()}…` : compact;
}
/** AI Coding 循环阶段 → 徽标文案/颜色（状态语义色，非普通分类色） */
export const CODING_PHASE_UI: Record<CodingPhase, { label: string; color: string } | null> = {
  idle: null,
  coding: { label: 'Coding…', color: '#4B7BFF' },
  preview: { label: 'Preview check…', color: '#9A6BFF' },
  testing: { label: 'Testing…', color: '#E8A33D' },
  done: { label: 'Round complete', color: '#2FBF71' },
};
/** 分步看板耗时格式化：<1分钟→秒，<1小时→分秒，≥1小时→时分 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** 格式化消息时间戳：当天显示 HH:MM（只到分，不含日期），隔天才显示 MM-DD HH:MM */
export function formatMsgTime(ts: string): string {
  try {
    // .md 里的 questionTime 格式为 "YYYY-MM-DD HH:MM:SS"，消息流里是 ISO 字符串（含 T）。
    // ISO 直接原生解析；空格分隔格式先替换 / 兼容 Safari（- 分隔的日期在部分引擎解析为 UTC 或 Invalid）
    const d = new Date(ts.includes('T') ? ts : ts.replace(/-/g, '/'));
    if (isNaN(d.getTime())) return ts;
    const now = new Date();
    const isToday = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (isToday) return `${hh}:${mm}`;
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mo}-${dd} ${hh}:${mm}`;
  } catch {
    return ts;
  }
}

/**
 * 收口非终态 phase → done/error（用于持久化/恢复路径，避免"上一轮思考仍在转动"的视觉 bug）。
 * 规则：success=true（或 undefined 且 result≠'...'）→ done；success=false → error；
 *       完全无结果（'...'且 undefined success）视为未完成但任务已结束 → 标 done。
 */
export function finalizeToolCallPhase(t: ToolCallRecord): ToolCallRecord {
  if (t.phase === 'done' || t.phase === 'error') return t;
  const finalPhase: ToolCallPhase = t.success === false ? 'error' : 'done';
  return { ...t, phase: finalPhase };
}

/**
 * 对一批消息做"终态化"：
 *   1. 每个 assistant 消息的 toolCalls 中非终态 phase → done/error
 *   2. 静默修复 .md 中可能残留的历史脏数据（abort/崩溃未收的 tool phases）
 * 仅在**非流式**时调用：初始化恢复、删除/重试后的重建。
 */
export function finalizeMessagesPhase(items: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const result = items.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.toolCalls) || m.toolCalls.length === 0) return m;
    let arrChanged = false;
    const nextArr = m.toolCalls.map((tc) => {
      if (tc.phase === 'done' || tc.phase === 'error') return tc;
      arrChanged = true;
      return finalizeToolCallPhase(tc);
    });
    if (!arrChanged) return m;
    changed = true;
    return { ...m, toolCalls: nextArr };
  });
  return changed ? result : items;
}
/** 结束态整体折叠辅助：估算「执行过程」区占行数（Think 芯片 1 行 + 每个工具 1 行 + 技能一行）。 */
export function estimateProcessRows(
  thinkText: string | undefined,
  toolCalls: ToolCallRecord[] | undefined,
  skillNames: string[] | undefined,
): number {
  const hasThink = !!thinkText && thinkText.trim().length > 0;
  const calls = toolCalls ?? [];
  const skills = skillNames ?? [];
  return (hasThink ? 1 : 0) + calls.length + (skills.length > 0 ? 1 : 0);
}
