/**
 * WANTED 指令共享执行器
 *
 * 统一"指令 → 动作"的执行入口，供两处调用：
 *   - ⌘F 统一面板（UnifiedPalette.tsx）指令态：用户指令输入
 *   - 微信 iLink 桥接（wechat-bridge.ts）：微信消息
 *
 * 新增指令只需在 commands.ts 的 WANTED_COMMANDS 注册，
 * 双端自动获得该指令能力，无需改动本文件之外的核心逻辑。
 */
import { detectCommand, buildHelpText } from './commands.ts';
import { resolveReadCalendarQuery, querySchedule, parseScheduleInput, type ScheduleEvent } from './schedule.ts';
import { enterNodeMode, exitNodeMode, isNodeModeActive, touchNodeMode, getActiveThreadBinding } from './node-mode.ts';
import { inspectStickyTodos, formatInspectReply } from './inspect.ts';
import type { WikiEntryWithContent } from '@/lib/mcp/notes-types';
import {
  isMeetingActive,
  startMeeting,
  appendToMeeting,
  endMeeting,
  consumeExpiredMeeting,
  getMeetingState,
  type MeetingSession,
} from './meeting-session.ts';
import { insertInbox } from './inbox.ts';
import type { ChatMessage } from '@/lib/bus';

/** 解析后的任务结构（/todo 指令产物） */
export interface SummarizedTask {
  title: string;
  start_time: string;
  end_time?: string | null;
  all_day: boolean;
  priority: 'high' | 'normal' | 'low';
  category_path?: string[];
  location?: string;
  /** 提前提醒分钟数（如 [1440] = 提前 1 天）；未提及提醒时缺省，由 DB 走系统默认 30 分钟 */
  reminder_minutes?: number[];
  description?: string;
  source_raw?: string;
}

/** 执行结果（供 UI 展示 / 微信组织回复） */
export interface ExecResult {
  ok: boolean;
  /** 面向用户的可读结果文本（成功确认或错误信息） */
  reply: string;
  /** 命中的指令 id：'todo' | 'check' | 'notebook' | 'clip' | 'chat' | 'meeting' | 'help' | 'inspect' | null（无指令 = 仅存待办） */
  command: 'todo' | 'check' | 'notebook' | 'clip' | 'chat' | 'meeting' | 'help' | 'inspect' | null;
  /** 当前是否处于 Node 模式（/chat 开启后，供面板展示状态） */
  nodeMode?: boolean;
  /** /chat out 退出确认：仅状态变更，不产生 bobmail 邮件（面板据此跳过通知发布） */
  nodeModeExited?: boolean;
  /** 当前是否处于会议会话（/meeting 开启后，供面板展示状态） */
  meetingMode?: boolean;
  /** /meeting out 结束确认：纪要邮件已由服务端直接写入 BobMail（面板据此跳过通知发布，避免重复邮件） */
  meetingEnded?: boolean;
  tasks?: SummarizedTask[];
  /** /todo 写入日历后返回的事件 id（与 tasks 顺序对应；供便签按行关联后续标记完成） */
  eventIds?: string[];
  ambiguous?: string[];
  modelUsed?: string;
  savedCount?: number;
  /** /chat 对话历史（system + 历史Q&A + 本轮Q&A），供 node-mode 多轮复用上下文。仅 command='chat' 时有值。 */
  messages?: ChatMessage[];
  /** 当前活动会话线程——仅 command='chat' 时有值。
   *  服务端 chat-sessions 的 threadId，跨轮次复用同一会话。 */
  threadId?: string;
  /** /note check 查询出的笔记条目（供 ⌘F 面板直接展示笔记列表，不再生成 BobMail 邮件）。仅 command='notebook' 且为 check 子命令时有值。 */
  notes?: WikiEntryWithContent[];
  /** /todo check 查询出的日程事件（供 ⌘F 面板构造结构化待办邮件，含完成/删除按钮）。仅 command='check' 时有值。 */
  events?: ScheduleEvent[];
}

export interface ExecOptions {
  /** Node 端（微信桥）必传：如 http://localhost:8321；浏览器端省略（相对路径） */
  baseUrl?: string;
  /** 前端（⌘F 面板）传入的会话线程 ID 提示，
   *  askNode 返回时会作为最终 threadId 绑定到 node-mode.activeThreadId，
   *  确保面板会话与服务端 chat-sessions 一一对应、跨轮次复用。 */
  threadIdHint?: string;
  /** 会话来源：'panel'（⌘F 面板，长期保留）| 'wechat'（微信桥，24 小时过期）。默认 'panel'。 */
  source?: 'panel' | 'wechat';
  /** 便签一键添加日历场景：所属项目名，拼进日历事件 description 前缀 */
  projectName?: string;
}

function apiUrl(base: string | undefined, path: string): string {
  return (base ? base.replace(/\/$/, '') : '') + path;
}

/**
 * /todo 未提及时间时的默认时段（与日历面板新建规则一致）：
 *  - 当天：1 小时后整点开始 / 2 小时后整点结束（向上取整）
 *  - 深夜跨天（整点落入次日）：回退当天 09:00 - 10:00
 */
function todoDefaultTimeRange(): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const toLocalIso = (d: Date): string => {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  };
  const ceilToHour = (base: Date): Date => {
    const c = new Date(base);
    if (c.getMinutes() > 0 || c.getSeconds() > 0 || c.getMilliseconds() > 0) {
      c.setMinutes(0, 0, 0);
      c.setHours(c.getHours() + 1);
    } else {
      c.setSeconds(0, 0);
    }
    return c;
  };
  const now = new Date();
  const todayKey = now.toDateString();
  const start = ceilToHour(new Date(Date.now() + 3600 * 1000));
  const end = ceilToHour(new Date(Date.now() + 2 * 3600 * 1000));
  if (start.toDateString() === todayKey && end.toDateString() === todayKey) {
    return { start: toLocalIso(start), end: toLocalIso(end) };
  }
  // 深夜跨天：回退当天 09:00 - 10:00
  const d9 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
  const d10 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
  return { start: toLocalIso(d9), end: toLocalIso(d10) };
}

/**
 * 解析 /todo del 的时间表达式，返回 { rangeStart, rangeEnd }（ISO 字符串）或 { all: true }。
 * 返回 null 表示所有层级解析均失败。
 *
 * 解析层级（优先级从高到低）：
 *   1. 精确关键字：all / today / tomorrow / yesterday / this week / this month
 *   2. 显式日期：YYYY-MM-DD / YYYY-MM-DD YYYY-MM-DD
 *   3. 中文自然语言（schedule.ts 正则快路径）：下周三、8月12号、最近3天、下周、上周…
 *   4. LLM 慢路径（异步，在 runTodoDel 中处理）：复杂自然语言
 */
function parseDelTimeRange(
  content: string,
): { rangeStart: string; rangeEnd: string; label: string } | { all: true; label: string } | null {
  const s = content.trim();
  const lower = s.toLowerCase();

  const pad = (n: number) => String(n).padStart(2, '0');
  const toIso = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`;

  // ---- 1. 精确关键字 ----

  if (lower === 'all') return { all: true, label: 'all events' };

  if (lower === 'today') {
    const t = new Date();
    const start = toIso(t);
    t.setDate(t.getDate() + 1);
    return { rangeStart: start, rangeEnd: toIso(t), label: 'today' };
  }

  if (lower === 'tomorrow') {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    const start = toIso(t);
    t.setDate(t.getDate() + 1);
    return { rangeStart: start, rangeEnd: toIso(t), label: 'tomorrow' };
  }

  if (lower === 'yesterday') {
    const t = new Date();
    t.setDate(t.getDate() - 1);
    const start = toIso(t);
    t.setDate(t.getDate() + 1);
    return { rangeStart: start, rangeEnd: toIso(t), label: 'yesterday' };
  }

  if (lower === 'this week') {
    const t = new Date();
    const day = t.getDay();
    const diff = day === 0 ? 6 : day - 1;
    t.setDate(t.getDate() - diff);
    const start = toIso(t);
    t.setDate(t.getDate() + 7);
    return { rangeStart: start, rangeEnd: toIso(t), label: 'this week' };
  }

  if (lower === 'this month') {
    const t = new Date();
    t.setDate(1);
    const start = toIso(t);
    t.setMonth(t.getMonth() + 1);
    return { rangeStart: start, rangeEnd: toIso(t), label: 'this month' };
  }

  // ---- 2. 显式日期 ----

  const rangeRe = /^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/;
  const rangeMatch = s.match(rangeRe);
  if (rangeMatch) {
    const startDate = new Date(rangeMatch[1] + 'T00:00:00');
    const endDate = new Date(rangeMatch[2] + 'T00:00:00');
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return null;
    endDate.setDate(endDate.getDate() + 1);
    return { rangeStart: toIso(startDate), rangeEnd: toIso(endDate), label: `${rangeMatch[1]} ~ ${rangeMatch[2]}` };
  }

  const singleRe = /^\d{4}-\d{2}-\d{2}$/;
  if (singleRe.test(s)) {
    const d = new Date(s + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    const start = toIso(d);
    d.setDate(d.getDate() + 1);
    return { rangeStart: start, rangeEnd: toIso(d), label: s };
  }

  // ---- 3. 中文自然语言（schedule.ts 正则快路径） ----
  const scheduleParsed = parseScheduleInput(s);
  if (scheduleParsed.ok && scheduleParsed.query) {
    // 仅接受有明确日期范围的查询（拒绝 overdue/keyword-only）
    if (scheduleParsed.query.rangeStart && scheduleParsed.query.rangeEnd) {
      return {
        rangeStart: scheduleParsed.query.rangeStart,
        rangeEnd: scheduleParsed.query.rangeEnd,
        label: scheduleParsed.query.label,
      };
    }
  }

  return null;
}

/**
 * 执行按日期范围的删除（共享逻辑）
 */
async function performDel(
  rangeStart: string, rangeEnd: string, label: string, baseUrl?: string,
): Promise<ExecResult> {
  try {
    const qs = new URLSearchParams({ range_start: rangeStart, range_end: rangeEnd, scope: 'all' });
    const resp = await fetch(`${apiUrl(baseUrl, '/api/calendar/events')}?${qs}`, { method: 'DELETE' });
    const data = await resp.json();

    if (!data.success) {
      return { ok: false, reply: data.error || '删除失败', command: 'todo' };
    }

    const count: number = data.deleted ?? 0;
    if (count === 0) {
      return { ok: true, reply: `${label} 没有可删除的日程。`, command: 'todo' };
    }

    return { ok: true, reply: `✅ 已删除 ${label} 的 ${count} 条日程。`, command: 'todo' };
  } catch (e) {
    return { ok: false, reply: `删除失败：${e instanceof Error && e.message ? e.message : '网络错误'}`, command: 'todo' };
  }
}

/**
 * 执行 /todo del 删除操作
 *
 * 解析层级：
 *   1. parseDelTimeRange（同步：关键字 → 日期 → schedule.ts 正则）
 *   2. LLM 慢路径（异步：/api/wanted/schedule-parse，仅正则均失败时触发）
 */
async function runTodoDel(content: string, baseUrl?: string): Promise<ExecResult> {
  const parsed = parseDelTimeRange(content);

  if (parsed) {
    if ('all' in parsed) {
      // 全部删除
      try {
        const qs = new URLSearchParams({ scope: 'all' });
        const resp = await fetch(`${apiUrl(baseUrl, '/api/calendar/events')}?${qs}`, {
          method: 'GET',
        });
        const data = await resp.json();
        if (!data.success) {
          return { ok: false, reply: data.error || '查询失败', command: 'todo' };
        }
        const events: Array<{ event_id?: string; status?: string }> = Array.isArray(data.events) ? data.events : [];
        const scheduledEvents = events.filter((e) => e.status === 'scheduled');
        if (scheduledEvents.length === 0) {
          return { ok: true, reply: '没有可删除的日程。', command: 'todo' };
        }
        let deleted = 0;
        for (const ev of scheduledEvents) {
          const delResp = await fetch(
            `${apiUrl(baseUrl, '/api/calendar/events')}?event_id=${ev.event_id}`,
            { method: 'DELETE' },
          );
          if (delResp.ok) deleted++;
        }
        return { ok: true, reply: `✅ 已删除全部 ${deleted} 条日程。`, command: 'todo' };
      } catch (e) {
        return { ok: false, reply: `删除失败：${e instanceof Error && e.message ? e.message : '网络错误'}`, command: 'todo' };
      }
    }

    return await performDel(parsed.rangeStart, parsed.rangeEnd, parsed.label, baseUrl);
  }

  // ---- 4. LLM 慢路径（仅正则全失败时尝试） ----
  if (baseUrl && content.trim()) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${apiUrl(baseUrl, '/api/wanted/schedule-parse')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content.trim() }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await resp.json();
      if (data?.success && data.rangeStart && data.rangeEnd) {
        return await performDel(data.rangeStart, data.rangeEnd, data.label || content.trim(), baseUrl);
      }
    } catch { /* LLM 解析失败：降级到错误提示 */ }
  }

  return {
    ok: false,
    reply: '无法识别的时间表达式。用法：\n' +
      '  /todo del today — 删除今天全部日程\n' +
      '  /todo del yesterday — 删除昨天全部日程\n' +
      '  /todo del tomorrow — 删除明天全部日程\n' +
      '  /todo del 2026-08-12 — 删除指定日期日程\n' +
      '  /todo del 2026-08-10 2026-08-12 — 删除日期范围内日程\n' +
      '  /todo del this week — 删除本周全部日程\n' +
      '  /todo del this month — 删除本月全部日程\n' +
      '  /todo del 下周三 — 删除下周三全部日程\n' +
      '  /todo del 8月12号 — 删除8月12号全部日程\n' +
      '  /todo del 最近3天 — 删除最近三天全部日程\n' +
      '  /todo del all — 删除全部已安排日程',
    command: 'todo',
  };
}

/** 调 /api/notebook 把文本投放为 raw 素材并编译进 wiki（供 /note 指令使用） */
async function saveNotebook(texts: string[], baseUrl?: string): Promise<{ ok: boolean; reply: string; count: number }> {
  const resp = await fetch(apiUrl(baseUrl, '/api/notebook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts.join('\n') }),
  });
  const data = await resp.json();
  if (!data.success) {
    return { ok: false, reply: data.error || 'Failed to save', count: 0 };
  }
  const entries: { title: string; tags?: string[] }[] = data.entries || [];
  return {
    ok: true,
    count: entries.length,
    reply: entries.length > 0
      ? `✅ Saved ${entries.length} note(s):\n${entries.map((e) => `- [${(e.tags || []).join(' · ') || 'Other'}] ${e.title}`).join('\n')}`
      : 'No notes could be extracted from the content',
  };
}

/**
 * /note review / lint / ingest：调宿主 /api/notebook 转发 bob-notes-mcp 的
 * notes_review / notes_lint / notes_ingest（Karpathy 维护回路，插件数据层）。
 */
async function runNotebookAction(
  action: 'review' | 'lint' | 'ingest',
  extra: Record<string, unknown> = {},
  baseUrl?: string,
): Promise<{ ok: boolean; reply: string }> {
  try {
    const resp = await fetch(apiUrl(baseUrl, '/api/notebook'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await resp.json();
    if (!data.success) return { ok: false, reply: data.error || `笔记 ${action} 失败` };
    return { ok: true, reply: data.reply || `笔记 ${action} 完成` };
  } catch (e) {
    return { ok: false, reply: `笔记 ${action} 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * /todo check：日程查询（原 /check 命令能力，已并入 /todo check 子命令；read_calendar / /schedule 能力已迁移）。
 * 复用 schedule.ts 统一查询管线：resolveReadCalendarQuery（正则快路径 + LLM 慢路径）→ querySchedule。
 * 空内容默认查今天；scope 固定 all（项目级 + 全局无时间待办），与 querySchedule 默认一致。
 */
async function runCheckQuery(content: string, baseUrl?: string): Promise<ExecResult> {
  const { query } = await resolveReadCalendarQuery({ query_text: content, scope: 'all' }, baseUrl);
  const res = await querySchedule(query, baseUrl);
  return { ok: res.ok, reply: res.reply, command: 'check', events: res.events };
}

/**
 * /note check：查阅 wiki（索引优先 + 关键词打分，无向量）。
 * 经宿主 /api/notebook 转发到 bob-notes-mcp notes_query（插件数据层）。
 * - 空内容：返回全部（weight 置顶优先 + 更新时间倒序）
 * - 非空内容：标题/标签/正文关键词打分排序
 * 返回 notes 数组供 ⌘F 面板构造"笔记列表邮件"逐条展示。
 */
async function runNoteCheck(content: string, baseUrl?: string): Promise<ExecResult> {
  try {
    const text = content.trim();
    const qs = new URLSearchParams({ mode: 'full' });
    if (text) qs.set('q', text);
    const resp = await fetch(`${apiUrl(baseUrl, '/api/notebook')}?${qs.toString()}`, { cache: 'no-store' });
    const data = await resp.json();
    if (!data.success) {
      return { ok: false, reply: data.error || '查阅笔记失败', command: 'notebook' };
    }
    const sorted: WikiEntryWithContent[] = (data.entries || []) as WikiEntryWithContent[];

    if (sorted.length === 0) {
      return {
        ok: true,
        reply: text
          ? `没有匹配「${text}」的笔记。`
          : '笔记库是空的，还没有任何笔记。用 /note 记录一条吧。',
        command: 'notebook',
        notes: [],
      };
    }

    const showCount = sorted.length;
    // 命中少时（≤3 条）微信直接附完整正文；多条仍列标题（完整内容见 BobMail 邮件，避免刷屏）。
    const detailMode = sorted.length > 0 && sorted.length <= 3;
    const lines = sorted.slice(0, detailMode ? sorted.length : 20).map((e, i) => {
      const tagStr = e.tags && e.tags.length > 0 ? `[${e.tags.join(' · ')}] ` : '';
      const d = e.date ? `（${e.date}）` : '';
      const head = `${i + 1}. ${tagStr}${e.title}${d}`;
      return detailMode ? `${head}\n${e.content}` : head;
    });
    const more = sorted.length > 20 ? `\n… 等共 ${sorted.length} 条，完整内容见 BobMail 邮件。` : '';
    return {
      ok: true,
      reply: `📒 共 ${showCount} 条笔记${text ? `（匹配「${text}」）` : ''}：\n${lines.join(detailMode ? '\n\n' : '\n')}${more}`,
      command: 'notebook',
      notes: sorted,
    };
  } catch (e) {
    return {
      ok: false,
      reply: `查阅笔记失败：${e instanceof Error ? e.message : String(e)}`,
      command: 'notebook',
    };
  }
}

/** 调 /api/wanted/node-chat 把问题发给 /chat 会话（/chat 指令 / Node 模式共用）。
 *
 * 参数语义（会话复用 vs 新建）：
 *   - newThread=true（如用户显式输入 /chat new）：强制新建会话，enterNodeMode 时生成新绑定。
 *   - 其它（默认）：先尝试从 node-mode 拿活动线程的 activeThreadId → 复用；无活动绑定则新建。
 *
 * 返回值 threadId：供调用方写回 node-mode.activeThreadId，
 * 保证面板会话与服务端 chat-sessions 一一对应。 */
async function askNode(
  question: string,
  baseUrl?: string,
  opts: { newThread?: boolean; threadIdHint?: string; source?: 'panel' | 'wechat' } = {},
): Promise<ExecResult> {
  const binding = getActiveThreadBinding();
  const reuseThreadId = opts.newThread ? null : binding.threadId;
  // 如果调用方传了 threadIdHint，优先用它（作为线程权威 ID）
  const preferThreadId = opts.threadIdHint || binding.threadId || null;

  try {
    const resp = await fetch(apiUrl(baseUrl, '/api/wanted/node-chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question, reuseThreadId, threadIdHint: preferThreadId, source: opts.source }),
    });
    const data = await resp.json();
    if (!data.success) {
      touchNodeMode(); // 即使失败也刷新一次计时（防止一连串失败时每发一次就强制重建新线程）
      return {
        ok: false,
        reply: data.error || 'Node request failed',
        command: 'chat',
        nodeMode: isNodeModeActive(),
        threadId: preferThreadId ?? undefined,
      };
    }

    // 成功：确定最终 threadId 并写回 node-mode 绑定
    const finalThreadId: string = data.threadId || preferThreadId || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // newThread=true 走 enterNodeMode 新建；否则按 active 状态用 enter 或 touch
    if (opts.newThread || !isNodeModeActive()) {
      enterNodeMode(finalThreadId);
    } else {
      touchNodeMode({ threadId: finalThreadId });
    }
    return {
      ok: true,
      reply: data.reply,
      command: 'chat',
      nodeMode: true,
      threadId: finalThreadId,
      messages: data.messages as ChatMessage[] | undefined,
    };
  } catch (e) {
    return {
      ok: false,
      reply: `Node request failed: ${e instanceof Error ? e.message : String(e)}`,
      command: 'chat',
      nodeMode: isNodeModeActive(),
      threadId: preferThreadId ?? undefined,
    };
  }
}

/** 执行指令：/todo → 解析建日历+写待办（子命令 /todo del 删除、/todo check 查询日程）；/note → AI 分类存想法；/chat → 发给临时节点问答（进入 Node 模式）；/help → 帮助；/inspect → 查看便签待办。
 *  纯文本（无任何指令）：不自动处理（语义判断已移除），返回提示要求使用 /todo 或 /note 等指令。
 *  以 / 开头但非已知指令（如拼写错误）时提示未知指令。
 *  指令与内容之间无需空格（/todo买牛奶 等同 /todo 买牛奶）。
 *  支持多行混合：每行独立检测指令（如第一行普通待办、第二行 /todo、第三行 /note）。
 *  Node 模式（由 /chat 开启）：后续输入不再需要 /chat，直接发给临时节点；
 *  输入已知指令（/todo /note /help 等，/chat 除外）时自动退出 Node 模式并正常执行该指令（防止忘记 /chat out）；
 *  退出方式：输入 /chat out、输入其他已知指令，或超过 30 分钟未操作自动退出。 */
/** 会议收尾：调 /api/wanted/meeting 整理纪要 → 写入 BobMail 收件箱。返回纪要文本；失败返回空串。
 *  同时被微信桥静默超时定时器调用（导出供外部复用）。 */
export async function finalizeMeeting(meeting: MeetingSession, baseUrl?: string): Promise<string> {
  try {
    const text = meeting.messages.map((m) => m.text).join('\n');
    const resp = await fetch(apiUrl(baseUrl, '/api/wanted/meeting'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: meeting.title, text }),
    });
    const data = await resp.json();
    const minutes = data?.success ? String(data.minutes || '').trim() : '';
    if (!minutes) return '';
    await insertInbox({
      kind: 'meeting',
      title: `会议纪要：${meeting.title}`,
      body: minutes,
      source: 'meeting',
      dedupeKey: `meeting:${meeting.id}`,
      time: Date.now(),
    });
    return minutes;
  } catch (e) {
    console.error('[meeting] finalize failed:', e);
    return '';
  }
}

export async function executeWantedCommand(text: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, reply: 'Please enter some content', command: null };
  }

  // ---- /meeting 会议会话（开启 / 结束 / 积累）----
  // 1) 静默超时的会议先自动收尾（AI 整理 → BobMail；异步执行，不阻塞当前输入）
  try {
    const expired = consumeExpiredMeeting();
    if (expired) {
      void finalizeMeeting(expired, opts.baseUrl).catch(() => {});
    }
  } catch { /* 忽略 */ }

  // 2) /meeting out：立即结束并整理
  for (const line of lines) {
    const cmd = detectCommand(line);
    if (cmd?.id === 'meeting' && /^out\b/i.test((cmd.strip(line) || '').trim())) {
      const ended = endMeeting();
      if (!ended) {
        return { ok: true, reply: '当前没有进行中的会议。输入 /meeting 标题 可开启一场新会议。', command: 'meeting', meetingMode: false };
      }
      if (ended.messages.length === 0) {
        return { ok: true, reply: `会议「${ended.title}」已结束（无内容，未生成纪要）。`, command: 'meeting', meetingMode: false, meetingEnded: true };
      }
      const minutes = await finalizeMeeting(ended, opts.baseUrl);
      return {
        ok: true,
        reply: minutes
          ? `会议「${ended.title}」已结束，纪要已发送到 BobMail：\n\n${minutes}`
          : `会议「${ended.title}」已结束，但纪要整理失败，请稍后重试。`,
        command: 'meeting',
        meetingMode: false,
        meetingEnded: true,
      };
    }
  }

  // 3) /meeting [标题]：开启会议（标题可空，默认"会议 MM-DD HH:mm"）
  for (const line of lines) {
    const cmd = detectCommand(line);
    if (cmd?.id === 'meeting') {
      if (isMeetingActive()) {
        const st = getMeetingState();
        return { ok: true, reply: `会议「${st.title}」进行中（已记录 ${st.count} 条）。输入 /meeting out 结束并整理纪要。`, command: 'meeting', meetingMode: true };
      }
      exitNodeMode(); // 会议优先：开启会议时退出 Node 模式
      const raw = (cmd.strip(line) || '').trim();
      if (!startMeeting(raw || undefined)) {
        return { ok: false, reply: '无法开启会议：已有未收尾的会议，请先 /meeting out。', command: 'meeting' };
      }
      const st = getMeetingState();
      return { ok: true, reply: `📋 会议「${st.title}」已开启。后续消息会自动记录，输入 /meeting out 结束并整理纪要。`, command: 'meeting', meetingMode: true };
    }
  }

  // 4) 会议进行中：所有输入（含其他指令）积累进会议缓冲（静默记录，不再逐条回复；
  //    5 分钟静默提醒与 10 分钟自动收尾由微信桥定时器负责）
  if (isMeetingActive()) {
    appendToMeeting({ text: lines.join('\n') });
    return { ok: true, reply: '', command: 'meeting', meetingMode: true };
  }

  // ---- Node 模式退出：任意一行是 /chat out ----
  for (const line of lines) {
    const cmd = detectCommand(line);
    if (cmd?.id === 'chat' && /^out\b/i.test((cmd.strip(line) || '').trim())) {
      const wasActive = isNodeModeActive();
      exitNodeMode();
      // /chat out 仅解绑线程标记 + 退出 node mode；服务端 chat-sessions 会话保留
      // （panel 长期保留供多轮复用；wechat 24h 过期自动 sweep 清理）
      return {
        ok: true,
        reply: wasActive
          ? 'Exited Node mode. Commands available: /todo (incl. /todo del, /todo check), /note, /help'
          : 'Not in Node mode',
        command: 'chat',
        nodeMode: false,
        nodeModeExited: true,
      };
    }
  }

  // ---- Node 模式：识别到其他已知指令（/todo /note /help 等，/chat 除外）时
  //     自动退出 Node 模式并执行该指令（防止用户忘记 /chat out）----
  if (isNodeModeActive()) {
    const otherCommandLine = lines.find((line) => {
      const cmd = detectCommand(line);
      return cmd && cmd.id !== 'chat';
    });
    if (otherCommandLine) {
      exitNodeMode();
    } else {
      // 仍在 Node 模式：所有输入（含其他指令）整段发给临时节点，不再执行指令
      return await askNode(text, opts.baseUrl, { threadIdHint: opts.threadIdHint });
    }
  }

  // ---- /help：列出可用指令（任一行为 /help 即返回） ----
  // ---- /chat：开启 Node 模式并提问（任一行为 /chat 即返回） ----
  for (const line of lines) {
    const cmd = detectCommand(line);
    if (cmd?.id === 'help') {
      return { ok: true, reply: buildHelpText(), command: 'help' };
    }
    if (cmd?.id === 'chat') {
      const raw = cmd.strip(line) || '';
      // —— 子命令：/chat new 显式开新线程（强制 newThread=true，忽略任何活动复用）
      if (/^new\b/i.test(raw.trim())) {
        const rest = raw.trim().replace(/^new\b[ \t]*/i, '').trim();
        if (!rest) {
          return {
            ok: false,
            reply: '/chat new: Please also include your first question for the new thread, e.g. /chat new 总结一下…',
            command: 'chat',
          };
        }
        // 新线程：进入新会话 + 首问
        return await askNode(rest, opts.baseUrl, { newThread: true, threadIdHint: opts.threadIdHint });
      }
      if (!raw) {
        return { ok: false, reply: 'Please enter a question after /chat (this will enter Node mode, no need to repeat /chat for follow-up messages)', command: 'chat' };
      }
      // 普通 /chat <question>：自动复用活动线程（30min 内未活动 → 视为新线程）
      enterNodeMode(); // 先标记 active；askNode 内部会按活动绑定复用或首建
      return await askNode(raw, opts.baseUrl, { threadIdHint: opts.threadIdHint });
    }
    // ---- /inspect：聚合 Sticky 便签未完成待办（只读索引，缺失自动回退重建；任一行为 /inspect 即返回）
    //     默认查当前项目；/inspect all 查所有活跃项目；
    //     其余文字作模糊关键词过滤（多词以空格/逗号/顿号分隔，任一命中即保留；
    //     匹配待办行/页标题/便签标题/项目名，如 /inspect 合同 报价、/inspect all 合同）----
    if (cmd?.id === 'inspect') {
      const rest = cmd.strip(line).trim();
      const scope: 'current' | 'all' = /^all\b[\s,，;；]*/i.test(rest) ? 'all' : 'current';
      const keyword = scope === 'all' ? rest.replace(/^all\b[\s,，;；]*/i, '').trim() : rest;
      let result;
      try {
        result = await inspectStickyTodos(scope, keyword || undefined);
      } catch (e) {
        return {
          ok: false,
          reply: `Inspect failed: ${e instanceof Error ? e.message : String(e)}`,
          command: 'inspect',
        };
      }
      return { ok: true, reply: formatInspectReply(result), command: 'inspect' };
    }
    if (cmd && !cmd.strip(line)) {
      return { ok: false, reply: `Please enter content after /${cmd.keyword}`, command: cmd.id === 'notebook' ? 'notebook' : 'todo' };
    }
  }

  // ---- 未知 / 指令：以 / 开头但未命中任何指令（拼写错误 / 旧指令 / 乱输入）→ 提示，不自动识别 ----
  const unknownCmdLines = lines.filter((l) => /^\s*\//.test(l) && !detectCommand(l));
  if (unknownCmdLines.length > 0) {
    const bad = unknownCmdLines[0].trimStart().split(/\s/)[0] ?? unknownCmdLines[0];
    return {
      ok: false,
      reply: `Unknown command "${bad}". Available: /todo (create calendar event; /todo del to delete, /todo check to query schedule), /note (record a note; /note check review lint ingest), /clip (clip raw material), /chat (ask an AI node), /inspect (inspect sticky todos; /inspect all for all projects), /help (view help).`,
      command: null,
    };
  }

  // ---- 按行分组：/todo 行、/note 行、无指令行 ----
  // 续行归入：无指令行自动继承上一行的指令类型（/todo 续行归 todo、/note 续行归 notebook），
  // 使多行内容（如子项列表）作为整体发给 AI 归纳，而非被拆散分流到 notebook。
  // 纯文本（无任何指令）整体：语义判断已移除（2026-08），拒绝并提示使用指令。
  const todoBlocks: string[][] = [];
  const notebookTexts: string[] = [];
  const clipTexts: string[] = [];
  const plainLines: string[] = [];
  let lastCmdId: 'todo' | 'notebook' | 'clip' | null = null;
  let currentTodoBlock: string[] | null = null;
  for (const line of lines) {
    const cmd = detectCommand(line);
    const content = cmd ? cmd.strip(line) : line;
    if (cmd?.id === 'todo') {
      // 一条 /todo 指令 = 一个待办/日程块；续行（无指令行）归入同一块
      currentTodoBlock = [content];
      todoBlocks.push(currentTodoBlock);
      lastCmdId = 'todo';
    } else if (cmd?.id === 'notebook') {
      notebookTexts.push(content);
      lastCmdId = 'notebook';
    } else if (cmd?.id === 'clip') {
      clipTexts.push(content);
      lastCmdId = 'clip';
    } else if (lastCmdId === 'todo') {
      // /todo 后的续行（如"1、xxx""2、xxx"子项列表）归入同一条 todo
      currentTodoBlock?.push(content);
    } else if (lastCmdId === 'notebook') {
      // /notebook 后的续行同理
      notebookTexts.push(content);
    } else if (lastCmdId === 'clip') {
      clipTexts.push(content);
    } else {
      plainLines.push(content);
    }
  }

  // ---- 无指令纯文本：拒绝并提示（原 AI 语义路由 / LLM route-intent / hasTimeIntent 已删除） ----
  if (plainLines.length > 0) {
    const whole = plainLines.join('\n').trim();
    return {
      ok: false,
      reply: `Plain text is not auto-processed — use /todo or /note followed by your content (e.g. /todo买牛奶).\n\nUnprocessed text:\n${whole.slice(0, 200)}`,
      command: null,
    };
  }

  const replies: string[] = [];
  let command: ExecResult['command'] = null;
  const taskList: SummarizedTask[] = [];
  const ambiguous: string[] = [];
  let savedCount = 0;
  let timeFallbackCount = 0;
  let modelUsed: string | undefined;
  let eventIds: string[] = [];

  // ---- /todo del：删除日程 ----
  if (todoBlocks.length > 0) {
    const first = todoBlocks[0]?.[0]?.trimStart() ?? '';
    if (/^del\b/i.test(first)) {
      const delContent = first.replace(/^del\b[ \t]*/i, '').trim();
      return await runTodoDel(delContent, opts.baseUrl);
    }
    // ---- /todo check：日程查询（原 /check 命令能力，已并入 /todo check；空内容默认查今天） ----
    if (/^check\b/i.test(first)) {
      const checkContent = first.replace(/^check\b[ \t]*/i, '').trim();
      return await runCheckQuery(checkContent, opts.baseUrl);
    }
  }

  // ---- /todo 行：解析为结构化任务 → 日历 + 待办双写 ----
  // 一条 /todo 指令 = 一个待办/日程；逐块以 single:true 调用，绝不把多条指令合并拆分
  for (const block of todoBlocks) {
    const blockText = block.join('\n').trim();
    if (!blockText) continue;
    const resp = await fetch(apiUrl(opts.baseUrl, '/api/tasks/summarize'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: blockText, single: true }),
    });
    const data = await resp.json();
    if (!data.success) {
      return { ok: false, reply: data.error || 'Failed to parse tasks', command: 'todo' };
    }

    const todoTasks: SummarizedTask[] = data.tasks || [];
    // 本块是否使用了时间兜底（决定是否再把 ambiguous 提示给用户造成重复）
    let usedTimeFallback = false;
    // 兜底：模型仍把无时间内容放进 ambiguous_items 时，用默认时段（当天 1h/2h 整点）补建，避免内容丢失
    if (todoTasks.length === 0 && Array.isArray(data.ambiguous_items) && data.ambiguous_items.length > 0) {
      const def = todoDefaultTimeRange();
      for (const amb of data.ambiguous_items) {
        const s = String(amb || '').trim();
        if (!s) continue;
        todoTasks.push({ title: s.slice(0, 30), start_time: def.start, end_time: def.end, all_day: false, priority: 'normal', source_raw: s });
        timeFallbackCount++;
        usedTimeFallback = true;
      }
    }
    if (todoTasks.length > 0) {
      const writeOk = await writeTodoToCalendarAndFile(todoTasks, opts.baseUrl, opts.projectName);
      if (!writeOk.ok) {
        return { ok: false, reply: writeOk.error || 'Failed to import', command: 'todo' };
      }
      if (writeOk.eventIds?.length) eventIds = writeOk.eventIds;
    }
    if (!usedTimeFallback && Array.isArray(data.ambiguous_items)) {
      ambiguous.push(...data.ambiguous_items);
    }
    taskList.push(...todoTasks);
    modelUsed = data.model_used;
  }

  if (todoBlocks.length > 0) {
    replies.push(taskList.length > 0
      ? `✅ Created ${taskList.length} calendar event(s):\n${taskList.map((t) => `- ${t.title}`).join('\n')}`
      : 'No calendar events could be identified from the content');
    if (timeFallbackCount > 0) {
      replies.push(`\n⚠️ ${timeFallbackCount} item(s) had no time info — set to finish in 1 hour by default. Adjust the time in the calendar if needed.`);
    }
    command = 'todo';
  }

  // ---- /note 行：投放 → AI 编译进 wiki（Karpathy LLM Wiki）；子命令 check/review/lint/ingest ----
  if (notebookTexts.length > 0) {
    const first = notebookTexts[0].trimStart();
    // ---- /note check：查阅笔记（索引优先 + 关键词，无向量）----
    if (/^check\b/i.test(first)) {
      const checkContent = first.replace(/^check\b[ \t]*/i, '').trim();
      return await runNoteCheck(checkContent, opts.baseUrl);
    }
    // ---- /note review：回看打捞（最久未回看 → rescue 置顶 / sink 下沉，不删除）----
    if (/^review\b/i.test(first)) {
      const r = await runNotebookAction('review', {}, opts.baseUrl);
      return { ok: r.ok, reply: r.reply, command: 'notebook' };
    }
    // ---- /note lint：自检（断链 / 孤立 / 重复标题）----
    if (/^lint\b/i.test(first)) {
      const r = await runNotebookAction('lint', {}, opts.baseUrl);
      return { ok: r.ok, reply: r.reply, command: 'notebook' };
    }
    // ---- /note ingest：手动编译 raw 中待编译素材（可跟素材 id / r-xxx 前缀，只编译命中项）----
    if (/^ingest\b/i.test(first)) {
      const arg = first.replace(/^ingest\b[ \t]*/i, '').trim();
      const ids = arg ? arg.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) : undefined;
      const r = await runNotebookAction('ingest', ids && ids.length > 0 ? { ids } : {}, opts.baseUrl);
      return { ok: r.ok, reply: r.reply, command: 'notebook' };
    }
    const nb = await saveNotebook(notebookTexts, opts.baseUrl);
    if (!nb.ok) {
      return { ok: false, reply: nb.reply, command: 'notebook' };
    }
    replies.push(nb.reply);
    if (!command) command = 'notebook';
    savedCount += nb.count;
  }

  // ---- /clip 行：投放素材到 raw/（不编译，待 /note ingest）----
  if (clipTexts.length > 0) {
    const resp = await fetch(apiUrl(opts.baseUrl, '/api/notebook'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clipTexts.join('\n'), raw_only: true }),
    });
    const data = await resp.json();
    if (!data.success) {
      return { ok: false, reply: data.error || 'Failed to clip', command: 'clip' };
    }
    replies.push('📎 已投放素材（待编译）。用 /note ingest 编译。');
    if (!command) command = 'clip';
  }

  if (ambiguous.length > 0) {
    replies.push(`\n⚠️ Needs confirmation (time not detected):\n${ambiguous.join('\n')}`);
  }

  return {
    ok: true,
    reply: replies.join('\n'),
    command,
    tasks: taskList,
    eventIds: eventIds.length ? eventIds : undefined,
    ambiguous,
    modelUsed,
    savedCount,
  };
}

/**
 * /todo 写入：统一写 events 表（SSOT）。
 * - 有 start_time → scope=project（项目级日历事件）
 * - 无 start_time → scope=global + project_id=__global__（全局无时间清单项）
 */
async function writeTodoToCalendarAndFile(
  taskList: SummarizedTask[],
  baseUrl?: string,
  projectName?: string,
): Promise<{ ok: boolean; error?: string; eventIds?: string[] }> {
  try {
    const payload = taskList.map((t) => {
      let start = t.start_time || null;
      let end = t.end_time ?? undefined;
      if (!start) {
        // /todo 未提及时间：参照日历新建默认时段（当天 1h/2h 整点，深夜跨天回退 09:00-10:00）
        const def = todoDefaultTimeRange();
        start = def.start;
        end = def.end;
      }
      // 便签一键添加日历：项目名拼进 description 前缀，便于按项目追溯
      const desc = t.description ? t.description.trim() : '';
      const description = projectName
        ? (desc ? `项目：${projectName}\n${desc}` : `项目：${projectName}`)
        : (desc || undefined);
      return {
        title: t.title,
        start_time: start,
        end_time: end,
        all_day: t.all_day,
        priority: t.priority,
        location: t.location,
        description,
        source_raw: t.source_raw,
        category_path: t.category_path,
        // 提前提醒（模型从「提前 N 天提醒」解析）：未提及 → undefined，由 DB 走系统默认 30 分钟
        reminder_minutes: t.reminder_minutes,
        // 有时间 = 项目级事件；无时间 = 全局无时间清单项
        scope: (start ? 'project' : 'global') as 'project' | 'global',
        tags: [],
      };
    });
    const calResp = await fetch(apiUrl(baseUrl, '/api/calendar/events?bulk=true&skip_reminder=true'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const calData = await calResp.json();
    if (!calData.success) {
      return { ok: false, error: calData.error || 'Calendar import failed' };
    }
    return { ok: true, eventIds: Array.isArray(calData.event_ids) ? calData.event_ids : [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : 'Network error' };
  }
}
