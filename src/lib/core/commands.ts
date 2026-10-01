/**
 * Butler 指令注册表
 *
 * 新增指令只需在 BUTLER_COMMANDS 中追加一项，即可自动出现在 / 指令下拉中。
 * 每个指令定义：
 *  - keyword: 指令名（不含 /）
 *  - label: 下拉展示名
 *  - description: 下拉说明
 *  - match: 判断输入文本是否完整命中该指令（用于提交时路由）
 *  - strip: 从输入文本中去掉指令前缀，返回剩余的任务内容
 */

export interface ButlerCommand {
  id: string;
  keyword: string;
  label: string;
  description: string;
  /** 该命令对应的**意图标签**：入口归一化（normalizeSlashInput）时前置给管家，
   *  让模型不必认识斜杠语法也能正确路由（如 `/todo X` → 「意图：排期/待办」X）。 */
  intent: string;
  /** 承接该命令的**能力/工具名**（P0 只填管家现有工具）。留空 = 该能力不在管家手里，
   *  归一化后的注入文本会提示模型如实说明并引导到对应节点，不得假装执行。
   *  P1 把 /note、/meeting 工具化后在此补上工具名即可，无需改动其他文件。 */
  capability?: string;
  match: (input: string) => boolean;
  strip: (input: string) => string;
}

export const BUTLER_COMMANDS: ButlerCommand[] = [
  {
    id: 'todo',
    keyword: 'todo',
    label: 'Create calendar event',
    description: 'Parse text into a calendar event and add it to the todo list. Sub-commands: /todo del <time> to delete events (e.g. /todo del today, /todo del 2026-08-12, /todo del this week, /todo del all); /todo check to query calendar events (e.g. /todo check today, /todo check this week, /todo check overdue, or a keyword)',
    intent: '排期与待办（建 / 改 / 删 / 查日程与待办）',
    capability: 'create_scheduled_todo · todo_update · todo_delete · read_todo · query_schedule / query_todos',
    match: (input) => /^\/todo\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/todo\b/, '').trimStart(),
  },
  {
    id: 'notebook',
    keyword: 'note',
    label: 'Record a note',
    description: 'AI compiles the text into the personal wiki (Karpathy LLM Wiki). Sub-commands: /note check to query, /note review to rescue, /note lint to self-check, /note ingest to compile pending raw, /note raw <text> to drop raw material without compiling (compile later with /note ingest)',
    intent: '写进个人知识库（Kar）',
    capability: 'read_notebook / read_note（查）· create_note（记，raw-first 投放并编译；raw_only=true 时只囤素材不编译）· ingest_notes（编译待处理素材）· review_notes · lint_notes · read_raw_inbox',
    match: (input) => /^\/note\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/note\b/, '').trimStart(),
  },
  // /chat 已退役（P2 后续 · 2026-09-25）：P0 统一入口后普通文本本就直连管家同一个 agent
  // （同 endpoint / 同 identity / 同线程复用），该命令唯一作用是前置一句「普通对话提问」，
  // 而那句正是纯文本的默认语义 → 同义反复；且其指代对象（"临时 AI 节点"）已是管家自身，
  // 子命令 /chat out、/chat new 更早在 P1-e 删除。故整条移除，对话直接发消息即可。
  {
    id: 'meeting',
    keyword: 'meeting',
    label: 'Start a meeting',
    description: 'Start a meeting session — everything sent afterwards accumulates into one meeting until /meeting out (or 10 min of silence). On end the AI writes minutes (meeting-minutes schema) and sends them to your Butler inbox. e.g. /meeting 姜晓彤案推进会',
    intent: '会议记录（开启 / 累积记录 / 结束并生成纪要）',
    capability: 'meeting_start（开启）· meeting_append（逐条原样记录）· meeting_end（结束并整理纪要 → Butler 收件箱）',
    match: (input) => /^\/meeting\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/meeting\b/, '').trimStart(),
  },
  {
    id: 'inspect',
    keyword: 'inspect',
    label: 'Inspect sticky todos',
    description: 'List unfinished sticky-note todos in the current project (project → note → page, completed items excluded). Use /inspect all to scan all projects, or add fuzzy keywords to filter — multiple keywords separated by space/comma match any one of them (e.g. /inspect 合同 报价, /inspect all 合同)',
    intent: '检视当前项目未完成的便签待办',
    capability: 'query_todos（view=sticky：便签待办视图，项目→便签→页，排除已完成）',
    match: (input) => /^\/inspect\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/inspect\b/, '').trimStart(),
  },
  {
    id: 'help',
    keyword: 'help',
    label: 'Show available commands',
    description: 'List all commands and usage instructions',
    intent: '列出可用命令',
    capability: '（用注入给你的命令表如实列举，不要编造命令）',
    match: (input) => /^\/help\b/.test(input.trimStart()),
    strip: (input) => input.trimStart().replace(/^\/help\b/, '').trimStart(),
  },
];

/** 生成指令使用说明文本（/help 输出） */
export function buildHelpText(): string {
  const lines = BUTLER_COMMANDS.map((c) => `/${c.keyword} — ${c.label}: ${c.description}`);
  return `Available commands:\n${lines.join('\n')}\n\nCommands are shortcuts — put your content right after the command (no space needed, e.g. /todo买牛奶).`;
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
export function detectCommand(input: string): ButlerCommand | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return null;
  return BUTLER_COMMANDS.find((c) => c.match(input)) ?? null;
}

/**
 * 入口归一化（P0 · 统一入口）：把斜杠命令翻译成「意图 + 正文」的普通文本，交给**管家**处理。
 *
 * 背景：斜杠命令原本是宿主层语法糖（executor 逐行判定 + 确定性执行），LLM 画像不认识它。
 * 统一入口后入口只做**翻译**、不做执行：
 *   - 命中已知命令 → `「意图：<intent>」<正文>`（如 `/todo 今天下午六点开会` → 「意图：排期与待办（…）」今天下午六点开会）；
 *   - 未命中（如 `/foo`）→ **原样返回**，由管家按注入的命令表如实回复「没有这个命令」并列出可用命令；
 *   - 非斜杠输入 → 原样返回。
 *
 * 命令表仍是唯一真源：新增命令只改 BUTLER_COMMANDS，归一化与注入文本自动跟随。
 */
export function normalizeSlashInput(input: string): string {
  const cmd = detectCommand(input);
  if (!cmd) return input;
  const body = cmd.strip(input);
  const head = `「意图：${cmd.intent}」`;
  return body ? `${head} ${body}` : `${head}（用户只发了命令名，没有正文——按该意图回应或追问）`;
}

/**
 * B5「中途改」：把一条「补充要求」合并回**原指令输入**，得到重跑用的输入。
 *
 * 语义：用户在长任务（如 `/note 写一份采购合同`）没跑完时又发一句「改成 3 页」——
 * 这句本身不是指令，而是对**原任务**的补充。必须把原任务一起带上重跑，
 * 否则「改成 3 页」会丢掉原任务，用户得重述一遍。
 *
 * 两个必须的归一化：
 *   - 剥掉原输入里的指令前缀再合并，最后把前缀加回去（否则 `/note /note …`）；
 *   - 合并成**单行**：多行会让「补充要求」落到指令作用域之外
 *     （命中指令的第一行会被整条消费）。
 *
 * 无指令的原输入 → 返回纯文本（调用方按普通续问处理）。
 */
export function mergeSteeringInput(priorInput: string, supplement: string): string {
  const priorCmd = detectCommand(priorInput);
  const priorBody = (priorCmd ? priorCmd.strip(priorInput) : priorInput).replace(/\s+/g, ' ').trim();
  const extra = supplement.replace(/\s+/g, ' ').trim();
  const merged = `${priorBody}（补充要求：${extra}）`;
  return priorCmd ? `/${priorCmd.keyword} ${merged}` : merged;
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
export function filterCommands(input: string, usage?: Record<string, number>): ButlerCommand[] {
  const token = parseCommandToken(input);
  const list = token
    ? BUTLER_COMMANDS.filter((c) => c.keyword.startsWith(token))
    : [...BUTLER_COMMANDS];
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
