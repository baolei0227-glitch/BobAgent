/**
 * WANTED 指令注册表
 *
 * 新增指令只需在 WANTED_COMMANDS 中追加一项，即可自动出现在 / 指令下拉中。
 * 每个指令定义：
 *  - keyword: 指令名（不含 /）
 *  - label: 下拉展示名
 *  - description: 下拉说明
 *  - match: 判断输入文本是否完整命中该指令（用于提交时路由）
 *  - strip: 从输入文本中去掉指令前缀，返回剩余的任务内容
 */

export interface WantedCommand {
  id: string;
  keyword: string;
  label: string;
  description: string;
  match: (input: string) => boolean;
  strip: (input: string) => string;
}

export const WANTED_COMMANDS: WantedCommand[] = [
  {
    id: 'todo',
    keyword: 'todo',
    label: 'Create calendar event',
    description: 'Parse text into a calendar event and add it to the todo list. Sub-commands: /todo del <time> to delete events (e.g. /todo del today, /todo del 2026-08-12, /todo del this week, /todo del all); /todo check to query calendar events (e.g. /todo check today, /todo check this week, /todo check overdue, or a keyword)',
    match: (input) => /^\/todo\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/todo\b/, '').trimStart(),
  },
  {
    id: 'notebook',
    keyword: 'note',
    label: 'Record a note',
    description: 'AI compiles the text into the personal wiki (Karpathy LLM Wiki). Sub-commands: /note check to query, /note review to rescue, /note lint to self-check, /note ingest to compile pending raw',
    match: (input) => /^\/note\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/note\b/, '').trimStart(),
  },
  {
    id: 'clip',
    keyword: 'clip',
    label: 'Clip raw material',
    description: 'Drop raw source material into the inbox (raw/) without compiling. Use /note ingest to compile later.',
    match: (input) => /^\/clip\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/clip\b/, '').trimStart(),
  },
  {
    id: 'chat',
    keyword: 'chat',
    label: 'Ask an AI node',
    description: 'Send a question to a temporary AI node; keeps context within 15 minutes and auto-resets on timeout',
    match: (input) => /^\/chat\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/chat\b/, '').trimStart(),
  },
  {
    id: 'meeting',
    keyword: 'meeting',
    label: 'Start a meeting',
    description: 'Start a meeting session — everything sent afterwards accumulates into one meeting until /meeting out (or 10 min of silence). On end the AI writes minutes (meeting-minutes schema) and sends them to BobMail. e.g. /meeting 姜晓彤案推进会',
    match: (input) => /^\/meeting\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/meeting\b/, '').trimStart(),
  },
  {
    id: 'inspect',
    keyword: 'inspect',
    label: 'Inspect sticky todos',
    description: 'List unfinished sticky-note todos in the current project (project → note → page, completed items excluded). Use /inspect all to scan all projects, or add fuzzy keywords to filter — multiple keywords separated by space/comma match any one of them (e.g. /inspect 合同 报价, /inspect all 合同)',
    match: (input) => /^\/inspect\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/inspect\b/, '').trimStart(),
  },
  {
    id: 'help',
    keyword: 'help',
    label: 'Show available commands',
    description: 'List all commands and usage instructions',
    match: (input) => /^\/help\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/help\b/, '').trimStart(),
  },
];

/** 生成指令使用说明文本（/help 输出） */
export function buildHelpText(): string {
  const lines = WANTED_COMMANDS.map((c) => `/${c.keyword} — ${c.label}: ${c.description}`);
  return `Available commands:\n${lines.join('\n')}\n\nPlease enter a command first. Plain text is not auto-processed — use /todo or /note followed by your content (no space needed after the command, e.g. /todo买牛奶).`;
}

/** 输入是否以 / 开头（触发指令下拉） */
export function hasCommandIntent(input: string): boolean {
  return /^\s*\//.test(input);
}

/** 解析输入开头的指令 token（/ 后到空白为止），未命中返回 '' */
export function parseCommandToken(input: string): string {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return '';
  const token = trimmed.slice(1).split(/\s/)[0] ?? '';
  return token.toLowerCase();
}

/** 当前文本是否完整命中某个指令（提交时的路由依据） */
export function detectCommand(input: string): WantedCommand | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return null;
  return WANTED_COMMANDS.find((c) => c.match(input)) ?? null;
}

/** 指令使用次数持久化 key（localStorage） */
const USAGE_STORAGE_KEY = 'wanted-command-usage';

/** 读取各指令累计使用次数（仅客户端可用；SSR/服务端返回空对象） */
export function loadCommandUsage(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(USAGE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** 记录一次指令使用（applyCommand 选中时调用） */
export function recordCommandUsage(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const usage = loadCommandUsage();
    usage[id] = (usage[id] ?? 0) + 1;
    window.localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(usage));
  } catch { /* ignore */ }
}

/** 按已输入的 token 过滤指令候选；
 *  传入 usage 时按使用频率降序排列（同频保持注册表顺序），未传时保持注册表顺序 */
export function filterCommands(input: string, usage?: Record<string, number>): WantedCommand[] {
  const token = parseCommandToken(input);
  const list = token
    ? WANTED_COMMANDS.filter((c) => c.keyword.startsWith(token))
    : [...WANTED_COMMANDS];
  if (!usage) return list;
  const order = new Map(list.map((c, i) => [c.id, i]));
  return [...list].sort(
    (a, b) => (usage[b.id] ?? 0) - (usage[a.id] ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

/** 生成选中指令后的文本：/keyword + 剩余内容 */
export function buildCommandText(input: string, keyword: string): string {
  const trimmed = input.trimStart();
  const token = parseCommandToken(trimmed);
  const rest = token ? trimmed.slice(token.length + 1) : '';
  return `/${keyword}${rest ? ' ' + rest.trimStart() : ''}`;
}

/** 获取光标所在行：行文本、行起始偏移、行结束偏移（供多行指令检测用） */
export function getLineAtCursor(text: string, pos: number): { lineText: string; lineStart: number; lineEnd: number } {
  const clamped = Math.max(0, Math.min(pos, text.length));
  const lineStart = text.lastIndexOf('\n', clamped - 1) + 1;
  const newlineEnd = text.indexOf('\n', clamped);
  const lineEnd = newlineEnd === -1 ? text.length : newlineEnd;
  return { lineText: text.slice(lineStart, lineEnd), lineStart, lineEnd };
}

/**
 * 在光标所在行生成选中指令后的文本（仅替换光标所在行，其余行不变）。
 * 返回新文本与新的光标位置（定位到新行末尾，紧跟指令内容之后）。
 */
export function buildCommandTextAtLine(
  text: string,
  pos: number,
  keyword: string,
): { text: string; caret: number } {
  const { lineText, lineStart } = getLineAtCursor(text, pos);
  const trimmed = lineText.trimStart();
  const leadingWs = lineText.slice(0, lineText.length - trimmed.length);
  const token = parseCommandToken(trimmed);
  const rest = token ? trimmed.slice(token.length + 1) : '';
  const newLine = `${leadingWs}/${keyword}${rest ? ' ' + rest.trimStart() : ''}`;
  const newText = text.slice(0, lineStart) + newLine + text.slice(lineStart + lineText.length);
  return { text: newText, caret: lineStart + newLine.length };
}
