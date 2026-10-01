/**
 * Agent 工具系统 — butler 场景（记忆/偏好 · 待办 · 日程 · 便签 · 计划树 · 模型计费）
 * butler 场景工具（含规则原语 5 个）的定义与 executor：
 *   - 事务域：read_todo / remember_preference / read_preferences / delete_preference / update_preference /
 *             resolve_datetime / query_free_slots / query_schedule / create_scheduled_todo /
 *             query_todos / todo_update / todo_delete / create_sticky_note
 *   - 应用结构：create_project（新建项目——应用级写动作，挂 butler 场景，并列入写类收口名单）
 *   - 计划树：project_plan_start / project_plan_view / project_plan_add_steps / project_plan_step_status
 *   - 模型计费：get_model_price / set_model_price（对话维护单价覆盖，新增模型 / 厂商调价）
 *   - 规则原语（v6 §5.1；Phase 0 只固化与可见、不自动执行）：
 *             read_rules / rule_create / rule_update / rule_pause / rule_retire
 * 依赖方向单向：仅以 import type 依赖 index.ts 的类型（编译期擦除），不产生运行时循环依赖。
 * 项目归属统一口径（lib/project/resolve-explicit-project 的 resolveProjectWithFallback）：
 *   点名项目 → 按名解析；明确说"当前项目" → current；**未提及项目 → 自动落当前激活项目**，
 *   并把落点来源 project_source 随回执回传，让"写偏"可见（不再静默兜底、也不再打断回问）。
 * 只有日历事件允许"无激活项目 → 落全局"（allowGlobal）；便签 / 计划树为项目私有，
 * 无激活项目时返回结构化错误。同名多命中 / 未找到仍返回 project_ambiguous / project_not_found，
 * 交模型向用户澄清，不猜。
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { getCurrentProject, createProject } from '@/lib/project/project-manager';
import { resolveProjectWithFallback } from '@/lib/project/resolve-explicit-project';
import { emitProjectsChanged } from '@/lib/project/project-events';
import { initDb } from '@/lib/db';
import { join } from 'path';
import { PROJECT_DB_FILENAME } from '@/lib/app-root';
import type { ProviderConfig } from '@/lib/types';
import type { ModelPriceOverride } from '@/lib/settings';
import type { RecurrenceRule } from '@/lib/calendar/recurrence';
import { parseRecurrence, recurrenceLabel } from '@/lib/calendar/recurrence';
import { parseTodoTime } from '@/lib/todo-time-parse';
import type { Tool } from './index';

/**
 * 解析工具入参里的周期重复设置（create_scheduled_todo / todo_update 共用）。
 *   - 未传 / 非法 → undefined（「不改」）
 *   - 'none' / 'off' → null（明确取消重复）
 *   - 'daily' / 'weekly' → 规则对象，可叠加：
 *       recurrence_until   结束日（纯日期按当日 23:59:59.999 含入）
 *       recurrence_interval 每 N 天/周（≥2 才生效）
 *       recurrence_byday   命中星期几（["mon","wed"] 或 [1,3]，0=周日）
 *       recurrence_count   总次数（含首次）
 */
const DOW_NAME: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** 星期几入参 → 0-6 数组（接受名字或数字，去重升序）；无有效项 → null */
function parseBydayArg(raw: unknown): number[] | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const items: unknown[] = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/);
  const days: number[] = [];
  for (const it of items) {
    const t = String(it).trim().toLowerCase();
    if (!t) continue;
    if (/^[0-6]$/.test(t)) { days.push(Number(t)); continue; }
    const key = t.slice(0, 3);
    if (key in DOW_NAME) days.push(DOW_NAME[key]);
  }
  return days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : null;
}

function buildRecurrence(args: Record<string, unknown>): RecurrenceRule | null | undefined {
  const raw = args.recurrence;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === 'none' || s === 'off' || s === 'no' || s === 'false') return null;
  if (s !== 'daily' && s !== 'weekly') return undefined;

  const rule: RecurrenceRule = { freq: s === 'weekly' ? 'weekly' : 'daily' };

  const untilRaw = typeof args.recurrence_until === 'string' ? args.recurrence_until.trim() : '';
  if (untilRaw) {
    // 纯日期（YYYY-MM-DD）→ 当日 23:59:59.999（含当天）；否则按可解析的 ISO 时刻
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(untilRaw);
    if (m) {
      rule.until = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).toISOString();
    } else if (Number.isFinite(Date.parse(untilRaw))) {
      rule.until = new Date(untilRaw).toISOString();
    }
  }
  if (!rule.until) rule.until = null;

  const interval = Number(args.recurrence_interval);
  if (Number.isFinite(interval) && interval >= 2) rule.interval = Math.floor(interval);

  const byday = parseBydayArg(args.recurrence_byday);
  if (byday) rule.byday = byday;

  const count = Number(args.recurrence_count);
  if (Number.isFinite(count) && count >= 1) rule.count = Math.floor(count);

  return rule;
}

/** 星期英文标签（resolve_datetime 回执给模型一个可读的星期，减少它自己推算） */
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * resolve_datetime 执行器：把自然语言时间短语**确定性地**解析成具体日期/时刻。
 *
 * 为什么需要它：LLM 的时间算术很不可靠（"下周五下午 3 点" 常被算错一天），
 * 而 [todo-time-parse.ts] 已有成熟的 CN/EN 正则快路径。把它暴露成一个工具，
 * 让模型在写日历前**先调它拿 ISO**，而不是自己心算。
 */
async function toolResolveDatetime(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text ?? '').trim();
  if (!text) return JSON.stringify({ ok: false, error: 'missing_text', hint: 'Pass the user\'s time phrase in `text`.' });
  const refRaw = typeof args.reference === 'string' ? args.reference.trim() : '';
  const refMs = refRaw ? Date.parse(refRaw) : NaN;
  const now = Number.isFinite(refMs) ? new Date(refMs) : new Date();

  const parsed = parseTodoTime(text, now);
  if (!parsed) {
    return JSON.stringify({
      ok: false,
      error: 'unresolved',
      hint: 'No time expression found in that text. Ask the user for a concrete date/time — never guess.',
    });
  }
  const [y, m, d] = parsed.date.split('-').map(Number);
  const hh = parsed.time ? Number(parsed.time.slice(0, 2)) : 0;
  const mm = parsed.time ? Number(parsed.time.slice(3, 5)) : 0;
  const at = new Date(y, m - 1, d, hh, mm, 0, 0);
  return JSON.stringify({
    ok: true,
    // 本地可读值（直接回给用户，别再换算）
    date: parsed.date,
    time: parsed.time ?? null,
    weekday: WEEKDAY_LABELS[at.getDay()],
    // 机器值：有具体时刻 → UTC ISO（可直接当 create_scheduled_todo / todo_update 的 start_time）；
    // 只有日期没有时刻 → null，此时应确认具体时间或按整天（all_day=true）处理
    start_time: parsed.time ? at.toISOString() : null,
    all_day_hint: !parsed.time,
    // 原文剔除时间表达后的事项本身（"明天下午3点开会" → "开会"），可直接当标题参考
    topic: parsed.topic ?? null,
  });
}

/**
 * query_free_slots 执行器：回答「我明天 / 这周什么时候有空」。
 * 把「读忙碌区间 → 工作时间内找空档」交给确定性代码（lib/calendar/availability），
 * 模型不必自己算空闲时段（LLM 做时间区间减法同样不可靠）。
 */
async function toolQueryFreeSlots(args: Record<string, unknown>): Promise<string> {
  const startMs = Date.parse(typeof args.range_start === 'string' ? args.range_start.trim() : '');
  const endMs = Date.parse(typeof args.range_end === 'string' ? args.range_end.trim() : '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return JSON.stringify({
      ok: false,
      error: 'invalid_range',
      hint: 'range_start / range_end must be ISO instants. Resolve a natural-language range with resolve_datetime first (then widen range_end to the end of the day/week).',
    });
  }
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const { findFreeSlots } = await import('@/lib/calendar/availability');
  const res = await findFreeSlots({
    rangeStartIso: new Date(startMs).toISOString(),
    rangeEndIso: new Date(endMs).toISOString(),
    durationMinutes: num(args.duration_minutes),
    workStartHour: num(args.work_start_hour),
    workEndHour: num(args.work_end_hour),
    limit: num(args.limit),
  });
  return JSON.stringify({
    ok: true,
    free: res.free,
    busy: res.busy.map((b) => ({ start: b.start, end: b.end, title: b.title, all_day: b.all_day })),
  });
}

/** read_todo 工具 —（已合并，DB shim）。从 events 表按 scope='all' 查询，
 *  兼容 filter (all/recent/week/today) + category 过滤，输出 Markdown 字符串。
 *  Note: 需要按时间窗/逾期/状态/关键词精细查询时，改用 query_schedule / query_todos
 *  （与 ⌘F 面板 /todo check 同一查询管线，管家手里就有，不必让用户去敲命令）。
 */
async function toolReadTodo(args: Record<string, unknown>): Promise<string> {
  const filter = (args.filter as string) || 'all'; // all | recent | week | today
  const category = (args.category as string) || '';

  try {
    const project = await getCurrentProject();
    const db = await initDb(join(project.path, PROJECT_DB_FILENAME));

    const now = new Date();
    let rangeStart: Date | null = null;
    let rangeEnd: Date | null = null;
    if (filter === 'today') {
      rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      rangeEnd = new Date(rangeStart.getTime() + 86400_000);
    } else if (filter === 'week' || filter === 'recent') {
      rangeStart = new Date(now.getTime() - 7 * 86400_000);
      rangeEnd = new Date(now.getTime() + 60 * 86400_000);
    }

    // 基础条件：scope='all'，即 (project_id = current OR scope = 'global')
    const conds: string[] = [`(project_id = ? OR scope = 'global')`];
    const params: (string | number)[] = [project.id];

    // 时间过滤：只对有 start_time 的事件生效；无时间项始终返回（通过 OR start_time IS NULL 引入）
    // 无 end_time 的事件按 start+30min 的点事件参与判定（不再视为「永不结束」，避免所有历史
    // 无结束时间待办都出现在 today/week 列表里）
    if (rangeStart && rangeEnd) {
      conds.push(`(start_time IS NULL OR (datetime(start_time) < datetime(?) AND datetime(COALESCE(NULLIF(TRIM(end_time), ''), datetime(start_time, '+30 minutes'))) >= datetime(?)))`);
      params.push(rangeEnd.toISOString(), rangeStart.toISOString());
    }

    // category 过滤：匹配 category_path_json 中任意一级节点包含目标关键词
    if (category) {
      const esc = category.replace(/[\\%_]/g, (c) => '\\' + c);
      conds.push(`category_path_json LIKE ? ESCAPE '\\'`);
      params.push(`%${esc}%`);
    }

    const rows = db.prepare(`
      SELECT * FROM events
      WHERE ${conds.join(' AND ')}
      ORDER BY COALESCE(start_time, '9999') ASC, created_at ASC
      LIMIT 500
    `).all(...params) as import('@/lib/db/index').EventRow[];

    if (rows.length === 0) {
      const filterDesc = filter === 'today' ? 'today' : filter === 'week' ? 'this week' : 'recorded';
      const catDesc = category ? ` in category "${category}"` : '';
      return `No tasks found for ${filterDesc}${catDesc}. (read_todo merged into events DB; for finer status/overdue/keyword filters use /todo check, or ask me in plain language.)`;
    }

    // 渲染为 Markdown：按分类树分组（事件条目格式）
    const lines: string[] = [
      '# TODO 待办记录 (merged: events DB)',
      `> ${rows.length} item(s) · filter=${filter}${category ? ` · category=${category}` : ''}`,
      '',
    ];

    const { ensureCategoryPath, insertLines } = await import('@/lib/butler/category-tree');
    const UNCATEGORIZED = ['其他'];

    for (const row of rows) {
      let cat: string[] = [];
      try {
        const c = JSON.parse(row.category_path_json || '[]');
        if (Array.isArray(c)) cat = c;
      } catch { /* ignore */ }
      if (cat.length === 0) cat = UNCATEGORIZED;

      const insertAt = ensureCategoryPath(lines, cat);
      const priorityEmoji = row.priority === 'high' ? '🔴' : row.priority === 'low' ? '🟢' : '🟡';
      const check = row.status === 'done' ? 'x' : row.status === 'cancelled' ? 'x' : ' ';
      const entry = [`- [${check}] ${priorityEmoji} ${row.title}`];
      if (row.start_time) {
        const fmt = (iso: string) => {
          const d = new Date(iso);
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          const hh = String(d.getHours()).padStart(2, '0');
          const mi = String(d.getMinutes()).padStart(2, '0');
          return `${mm}/${dd} ${hh}:${mi}`;
        };
        const tstr = row.all_day === 1
          ? '全天'
          : (row.end_time ? `${fmt(row.start_time)} - ${fmt(row.end_time)}` : fmt(row.start_time));
        entry.push(`  - 时间: ${tstr}`);
      } else {
        entry.push('  - 时间: 无时间');
      }
      entry.push(`  - 优先级: ${row.priority || 'normal'}`);
      entry.push(`  - status: ${row.status}`);
      entry.push(`  - scope: ${row.scope}`);
      if (row.location) entry.push(`  - 地点: ${row.location}`);
      if (row.description) entry.push(`  - 描述: ${row.description.replace(/\n/g, ' ').slice(0, 300)}`);
      entry.push('');
      insertLines(lines, insertAt, entry);
    }

    const out = lines.join('\n');
    return out.length > 5000 ? (out.slice(0, 4997) + '...') : out;
  } catch (e) {
    return `Error reading TODO (DB shim): ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** remember_preference 工具 — 记录用户记忆（识别到持久事实/偏好即自主写入，带类型元数据；敏感信息拒绝） */
async function toolRememberPreference(args: Record<string, unknown>): Promise<string> {
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content) return 'Error: content is required（记忆内容必填，例如「用户习惯用表格输出」）';
  const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : undefined;
  try {
    const { addPreference, ALWAYS_INJECTED_TYPES } = await import('@/lib/core/preferences');
    const res = await addPreference(content, type ? { type } : undefined);
    // 敏感信息守卫：明文落盘 + 每轮注入，凭证/证件一律拒绝（提示模型向用户说明、不要复述原文）
    if (res.blocked) {
      return `未记录：内容疑似敏感信息（命中「${res.blocked}」特征）。记忆以明文保存并每轮注入，为保证安全不作记录；请告知用户不保存此类信息，且不要在回复中复述其原文。`;
    }
    // ⑧：否定式表达是硬约束（执行上无中间态），不属于偏好层——路由到规则集
    if (res.routed) return await routeNegationToRule(res.routed.content);
    // 同类型相似度硬闸：拒绝追加，把既有序号交给模型——是更新就改走 update_preference，确是新事实就换措辞
    if (res.conflict) {
      const { index, content: existingContent, score } = res.conflict;
      return `未追加：与第 ${index} 条（类型 ${type || '通用'}）高度相似（相似度 ${score.toFixed(2)}）：「${existingContent}」。若这是对已有记忆的更新 / 覆盖（含矛盾），请改用 update_preference(index=${index}) 改写它，不要重复追加；若确认是完全不同的新事实，请换一种表述再调用 remember_preference。`;
    }
    // 常驻档类型每轮注入正文，其余只进目录、按需调取——回执里说明，让模型能向用户解释两者差异
    const residency = type && ALWAYS_INJECTED_TYPES.includes(type)
      ? '该类型属于常驻档，每轮注入正文'
      : '该类型按需调取（需要时用 read_preferences 读取）';
    if (res.added) {
      return `已记住用户记忆（类型：${type || '通用'}，共 ${res.total} 条）：「${content}」。记的是用户本人，所有联系人的每轮对话都会参考；${residency}。`;
    }
    return `该记忆此前已记录：「${content}」（共 ${res.total} 条，未重复添加）。`;
  } catch (e) {
    return `记录记忆失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_preferences 工具 — 列出用户记忆（带序号/类型/时间，支持按类型过滤） */
async function toolReadPreferences(args: Record<string, unknown>): Promise<string> {
  const typeFilter = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : '';
  try {
    const { listPreferences } = await import('@/lib/core/preferences');
    const prefs = typeFilter
      ? (await listPreferences()).filter((p) => p.type === typeFilter)
      : await listPreferences();
    if (prefs.length === 0) {
      return typeFilter
        ? `没有类型为「${typeFilter}」的用户记忆。可先 read_preferences 查看全部。`
        : '暂无已记录的用户记忆。识别到持久事实/偏好时调用 remember_preference 记录。';
    }
    const list = prefs.map((p) => {
      const meta = [p.type && p.type !== '通用' ? p.type : '', p.createdAt ? `记录于 ${p.createdAt}` : '', p.source && p.source !== 'chat' ? `来源 ${p.source}` : ''].filter(Boolean).join('，');
      return `${p.index}. ${p.content}${meta ? `（${meta}）` : ''}`;
    }).join('\n');
    const scope = typeFilter ? `类型「${typeFilter}」` : '全部';
    return `已记录 ${prefs.length} 条用户记忆（${scope}，统一长期记忆，所有联系人共享）：\n${list}\n\n删除：调用 delete_preference（传 index 序号）。`;
  } catch (e) {
    return `读取记忆失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** delete_preference 工具 — 按序号删除一条用户记忆（手动遗忘） */
async function toolDeletePreference(args: Record<string, unknown>): Promise<string> {
  const raw = typeof args.index === 'number' ? args.index : parseInt(String(args.index ?? ''), 10);
  const index = Number.isFinite(raw) ? Math.floor(raw) : 0;
  if (index < 1) return 'Error: index required（记忆序号必填，1-based，可用 read_preferences 查看）';
  try {
    const { removePreference } = await import('@/lib/core/preferences');
    const res = await removePreference(index);
    if (res.removed) return `已删除第 ${index} 条用户记忆，剩余 ${res.remaining} 条。`;
    return `删除失败：第 ${index} 条不存在（当前共 ${res.remaining} 条）。可用 read_preferences 查看有效序号。`;
  } catch (e) {
    return `删除记忆失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** update_preference 工具 — 按序号原子修改一条记忆（只改传入字段，元数据保留） */
async function toolUpdatePreference(args: Record<string, unknown>): Promise<string> {
  const raw = typeof args.index === 'number' ? args.index : parseInt(String(args.index ?? ''), 10);
  const index = Number.isFinite(raw) ? Math.floor(raw) : 0;
  if (index < 1) return 'Error: index required（记忆序号必填，1-based，可用 read_preferences 查看）';
  const patch: { content?: string; type?: string } = {};
  if (typeof args.content === 'string' && args.content.trim()) patch.content = args.content.trim();
  if (typeof args.type === 'string' && args.type.trim()) patch.type = args.type.trim();
  if (patch.content === undefined && patch.type === undefined) {
    return 'Error: content or type required（至少提供新内容 content 或新类型 type 之一）';
  }
  try {
    const { updatePreference } = await import('@/lib/core/preferences');
    const res = await updatePreference(index, patch);
    // ⑧：把一条偏好改成否定式表达 = 改成硬约束，偏好层拒收 → 路由到规则集
    if (res.routed) return await routeNegationToRule(res.routed.content);
    if (!res.updated || !res.preference) {
      return `修改失败：${res.error ?? '未知错误'}`;
    }
    const p = res.preference;
    return `已修改第 ${index} 条记忆：\n内容：${p.content}\n类型：${p.type}（记录于 ${p.createdAt}，来源 ${p.source}）\n剩余 ${res.remaining} 条。`;
  } catch (e) {
    return `修改记忆失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** ⑧ 路由共用回执：否定式表达 → 规则集（lib/core 不 import lib/butler，真正的创建在工具层） */
async function routeNegationToRule(content: string): Promise<string> {
  try {
    const { createRuleFromNegation } = await import('@/lib/butler/rules');
    const rule = await createRuleFromNegation(content);
    return `未写入偏好：这是硬约束（执行上无中间态），已记为一条规则（id=${rule.id}，承诺级别「${rule.commitment}」）。` +
      `规则与偏好是两层：规则是「每次必须 / 禁止」，偏好是倾向。可在 Butler 抽屉的 Rules 面板查看与管理。`;
  } catch (e) {
    return `未写入偏好：否定式表达应归规则集，但创建规则失败（${e instanceof Error ? e.message : String(e)}）。请稍后重试。`;
  }
}

// ==================== 规则原语（v6 §5.1；Phase 0 只固化与可见，不自动执行）====================

/** 解析 steps 入参：接受对象 {kind, text, annex?, action?} 或字符串（默认 deterministic）；非法 → null */
const RULE_ACTIONS = ['create_todo', 'create_scheduled_todo'] as const;

function parseRuleStepsArg(
  raw: unknown,
): Array<{
  kind: 'deterministic' | 'judgment';
  text: string;
  annex?: boolean;
  action?: 'create_todo' | 'create_scheduled_todo';
  actionParams?: { when?: string };
}> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{
    kind: 'deterministic' | 'judgment';
    text: string;
    annex?: boolean;
    action?: 'create_todo' | 'create_scheduled_todo';
    actionParams?: { when?: string };
  }> = [];
  for (const s of raw) {
    if (typeof s === 'string') {
      const t = s.trim();
      if (t) out.push({ kind: 'deterministic', text: t });
      continue;
    }
    if (!s || typeof s !== 'object') return null;
    const o = s as { kind?: unknown; text?: unknown; annex?: unknown; action?: unknown; action_params?: unknown };
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) return null;
    const kind = o.kind === 'judgment' ? 'judgment' : 'deterministic';
    const step: (typeof out)[number] = { kind, text };
    if (kind === 'judgment' && o.annex === true) step.annex = true;
    if (kind === 'deterministic') {
      // 确定性步可选绑定宿主执行器：create_todo（便签待办）/ create_scheduled_todo（日程待办）
      const action = RULE_ACTIONS.find((a) => a === o.action);
      if (action) step.action = action;
      const ap = o.action_params;
      if (ap && typeof ap === 'object' && typeof (ap as { when?: unknown }).when === 'string' && (ap as { when: string }).when) {
        step.actionParams = { when: (ap as { when: string }).when };
      }
    }
    out.push(step);
  }
  return out.length > 0 ? out : null;
}

/** read_rules 工具 — 列出规则（id/name/kind/commitment/status/触发词），供模型取 id 做 pause/retire */
async function toolReadRules(args: Record<string, unknown>): Promise<string> {
  try {
    const { listRules } = await import('@/lib/butler/rules');
    const all = await listRules();
    const statusFilter = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : '';
    const rules = statusFilter ? all.filter((r) => r.status === statusFilter) : all;
    if (rules.length === 0) {
      return statusFilter
        ? `没有状态为「${statusFilter}」的规则。可 read_rules 不带 status 查看全部。`
        : '暂无规则。用户口述「以后都要 / 每次必须 / 不要…」这类硬约束时，用 rule_create 固化（倾向类走 remember_preference）。';
    }
    const list = rules.map((r) => {
      const kw = r.trigger.keywords.length > 0 ? `，触发词 ${r.trigger.keywords.join('/')}` : '';
      const scope = r.scope === 'project' && r.scopeTarget ? `，项目 ${r.scopeTarget}` : '，全局';
      return `${r.id}｜${r.name}（${r.kind === 'flow' ? '流程' : '规则'}·${r.status}·承诺「${r.commitment}」·v${r.version}）${kw}${scope}`;
    }).join('\n');
    const scope = statusFilter ? `状态「${statusFilter}」` : '全部';
    return `共 ${rules.length} 条规则（${scope}）：\n${list}\n\n改状态：rule_pause / rule_retire（传 id）；改内容：rule_update（传 id）。`;
  } catch (e) {
    return `读取规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** rule_create 工具 — 用户口述意图固化一条规则；commitment / kind 由服务端派生后回执 */
async function toolRuleCreate(args: Record<string, unknown>): Promise<string> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const intentRaw = typeof args.intent_raw === 'string' ? args.intent_raw.trim() : '';
  if (!name) return 'Error: name is required（规则名必填，简短可检索）';
  if (!intentRaw) return 'Error: intent_raw is required（用户原话必填，不要替用户转译）';
  const steps = parseRuleStepsArg(args.steps);
  if (!steps) return 'Error: steps is required（步骤必填；每项 {kind: deterministic|judgment, text}，kind 必标）';
  try {
    const { createRule } = await import('@/lib/butler/rules');
    const keywords = Array.isArray(args.keywords) ? args.keywords.map(String).map((s) => s.trim()).filter(Boolean) : [];
    const scopeTarget = typeof args.scope_target === 'string' && args.scope_target.trim() ? args.scope_target.trim() : '';
    // 时间组（可选）：仅接受结构合法的 RecurrenceRule 子集（freq 必须 daily/weekly），其余忽略
    const timeArg = args.time && typeof args.time === 'object' ? (args.time as Record<string, unknown>) : null;
    const time = timeArg && (timeArg.freq === 'daily' || timeArg.freq === 'weekly') ? (timeArg as unknown as import('@/lib/calendar/recurrence').RecurrenceRule) : null;
    const rule = await createRule({
      name,
      intentRaw,
      steps,
      trigger: { keywords, ...(time ? { time } : {}) },
      ...(scopeTarget ? { scope: 'project' as const, scopeTarget } : {}),
    });
    const kindLabel = rule.kind === 'flow' ? '流程' : '规则';
    // Phase 2 起：命中即按规则执行（确定性步由宿主跑，判断步由我按判断执行并给你看）——不再说「本版不会跑」
    const flowNote = rule.kind === 'flow'
      ? `\n这是**流程**（含判断步），承诺级别为「会启动并尽力」：命中时我会按判断执行，做完给你看。`
      : `\n这是**规则**（确定性步骤），承诺级别「${rule.commitment}」：命中时由宿主按步骤执行。`;
    const kwNote = keywords.length > 0 ? `\n触发词：${keywords.join('/')}` : '\n未设触发词（可在 Rules 面板补充）。';
    const timeNote = time ? `\n时间组：${time.freq}${time.byday?.length ? `（周${time.byday.join('/')}）` : ''}` : '';
    return `已记下一条${kindLabel}（id=${rule.id}）：\n${rule.name}\n承诺级别：${rule.commitment}${kwNote}${timeNote}${flowNote}\n可在 Butler 抽屉的 Rules 面板查看与管理。`;
  } catch (e) {
    return `创建规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 技能可作用的对象类型（与 rules-shared 的 ObjectType 同集，用于 skill_draft 入参白名单） */
const SKILL_OBJECT_TYPES = ['todo', 'schedule', 'note', 'meeting', 'project'] as const;
type SkillObjectType = (typeof SKILL_OBJECT_TYPES)[number];

/**
 * skill_draft 工具 — AI **起草**一条技能（程序化能力，Phase 3 §3.5）。
 * 只在卡片审固（approved）后由宿主回落执行 → 真正落 `.skills/<id>.md`；用户拒绝/超时则不落盘。
 * 这里只做入参归一化与 createSkill 调用；运不运行是 3c 的事，本批（3b）不执行任何技能。
 */
async function toolSkillDraft(args: Record<string, unknown>): Promise<string> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  if (!name) return 'Error: name is required（技能名必填，简短可检索）';
  if (!description) return 'Error: description is required（一句话说明这技能要干什么）';
  const whenArg = args.when && typeof args.when === 'object' ? (args.when as Record<string, unknown>) : {};
  const keywords = Array.isArray(whenArg.keywords) ? whenArg.keywords.map(String).map((s) => s.trim()).filter(Boolean) : [];
  const scenes = Array.isArray(whenArg.scenes) ? whenArg.scenes.map(String).map((s) => s.trim()).filter(Boolean) : [];
  const objectTypes = Array.isArray(whenArg.object_types)
    ? whenArg.object_types.map(String).filter((x): x is SkillObjectType => (SKILL_OBJECT_TYPES as readonly string[]).includes(x))
    : [];
  const preconditions = Array.isArray(whenArg.preconditions) ? whenArg.preconditions.map(String).map((s) => s.trim()).filter(Boolean) : [];
  try {
    const { createSkill } = await import('@/lib/butler/skills');
    const steps = Array.isArray(args.steps) ? (args.steps as import('@/lib/butler/skills-shared').SkillStep[]) : [];
    const grants = args.grants && typeof args.grants === 'object' ? (args.grants as import('@/lib/butler/skills-shared').SkillGrants) : undefined;
    const effects = Array.isArray(args.effects) ? args.effects.map(String) : [];
    const skill = await createSkill({
      name,
      description,
      when: { keywords, ...(scenes.length > 0 ? { scenes } : {}), ...(objectTypes.length > 0 ? { objectTypes } : {}), ...(preconditions.length > 0 ? { preconditions } : {}) },
      runtime: args.runtime === 'script' ? 'script' : 'compose',
      steps,
      grants,
      ...(effects.length > 0 ? { effects } : {}),
      origin: 'ai',
    });
    const whenNote = keywords.length > 0 ? `触发词：${keywords.join('/')}` : '未设触发词（可在 Skills 面板补充）';
    return `已固化技能（id=${skill.id}）：${skill.name}\n${skill.description}\n适用：${whenNote}\n可在 Butler 抽屉的 Skills 面板查看与管理。`;
  } catch (e) {
    return `创建技能失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** rule_update 工具 — 改一条规则的内容（name / 原话 / steps / 触发词 / 范围）；乐观锁冲突要求重读 */
async function toolRuleUpdate(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id is required（规则 id 必填，可用 read_rules 查看）';
  const patch: Record<string, unknown> = {};
  if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
  if (typeof args.intent_raw === 'string' && args.intent_raw.trim()) patch.intentRaw = args.intent_raw.trim();
  if (args.steps !== undefined) {
    const steps = parseRuleStepsArg(args.steps);
    if (!steps) return 'Error: steps invalid（每项 {kind, text}，kind 必标）';
    patch.steps = steps;
  }
  if (Array.isArray(args.keywords)) {
    patch.trigger = { keywords: args.keywords.map(String).map((s) => s.trim()).filter(Boolean) };
  }
  if (Object.keys(patch).length === 0) return 'Error: nothing to update（至少提供 name / intent_raw / steps / keywords 之一）';
  try {
    const { updateRule } = await import('@/lib/butler/rules');
    const expected = typeof args.expected_version === 'number' ? args.expected_version : undefined;
    const res = await updateRule(id, patch as Parameters<typeof updateRule>[1], expected);
    if (!res.ok) {
      if (res.conflict) return `修改未生效：规则已被改动（版本冲突）。请先 read_rules 取最新 v${res.error}，再重试。`;
      return `修改失败：${res.error}`;
    }
    return `已修改规则（id=${res.rule.id}，v${res.rule.version}）：${res.rule.name}\n承诺级别：${res.rule.commitment}（命中时由宿主按步骤执行）。`;
  } catch (e) {
    return `修改规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** rule_pause / rule_retire 工具 — 用户自己停自己的规则（免确认，v6 §5.1） */
async function toolRuleSetStatus(args: Record<string, unknown>, status: 'paused' | 'retired'): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id is required（规则 id 必填，可用 read_rules 查看）';
  try {
    const { setRuleStatus } = await import('@/lib/butler/rules');
    const res = await setRuleStatus(id, status);
    if (!res.ok || !res.rule) return `操作失败：${res.error ?? '未知错误'}`;
    const verb = status === 'paused' ? '已暂停' : '已废弃';
    return `${verb}规则（id=${res.rule.id}）：${res.rule.name}。可随时在 Rules 面板恢复或删除。`;
  } catch (e) {
    return `操作规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * rule_dismiss 工具 — 用户显式否定（v6 §7 / §3.4）。两类：
 *   - class='signal_mismatch'（缺省）：否定某条**已有规则**的结果 → 写一条 user_dismissed
 *     （「拉黑」与「修订阈值」两处共读），并**否决即拉黑**该规则覆盖的对象类型；
 *   - class='not_a_habit'：否定「把某对象类型的重复行为固化成规则」的**提议** → 只按对象类型
 *     落一条 not_a_habit 负样本（与规则无关，故不需要 id，改用 object_type）。
 */
async function toolRuleDismiss(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : 'rule_dismiss';
  const cls = args.class === 'not_a_habit' ? 'not_a_habit' : 'signal_mismatch';
  try {
    // not_a_habit：否决「提议固化」——与某条规则无关，按**对象类型**落负样本（§3.4 Q13）
    if (cls === 'not_a_habit') {
      const objectType = typeof args.object_type === 'string' ? args.object_type.trim() : '';
      const allowed = ['todo', 'schedule', 'note', 'meeting', 'project'];
      if (!allowed.includes(objectType)) {
        return 'Error: object_type must be one of todo/schedule/note/meeting/project（class="not_a_habit" 时必填）';
      }
      const { recordNegativeSample } = await import('@/lib/butler/rule-signals');
      await recordNegativeSample(objectType, objectType, 'blocked', 'not_a_habit');
      return `已记下：不再提议把这类「${objectType}」行为固化成规则。可在 Rules 面板的 Negative samples 里解封。`;
    }
    // signal_mismatch（缺省）：否决某条**已有规则**的结果 → 立即拉黑该规则覆盖的对象类型
    if (!id) return 'Error: id is required（规则 id 必填，可用 read_rules 查看）';
    const { readRule } = await import('@/lib/butler/rules');
    const rule = await readRule(id);
    if (!rule) return `未找到规则（id=${id}）。可用 read_rules 查看有效 id。`;
    const { ruleObjectType } = await import('@/lib/butler/rules-shared');
    const { recordUserDismissed } = await import('@/lib/butler/rule-signals');
    await recordUserDismissed(rule.id, rule.version, source, ruleObjectType(rule) ?? undefined);
    return `已记下你对规则「${rule.name}」这次结果的否定（v${rule.version}）。这类信号不再询问；若这条规则反复不合你意，我会在命中样本足够时提议修订。`;
  } catch (e) {
    return `记录否定失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * rule_revise 工具 — 修订提议的**落地原语**（v6 §3.2）：改内容 + 乐观锁版本校验。
 * 与 rule_update 的差别：走修订语义——version++ 后修订窗口清零（evaluateRuleRevision 只统计
 * 当前版本之后的命中），修订后从头评估否定率，而不是继续背旧账。
 */
async function toolRuleRevise(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id is required（规则 id 必填，可用 read_rules 查看）';
  const patch: Record<string, unknown> = {};
  if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
  if (typeof args.intent_raw === 'string' && args.intent_raw.trim()) patch.intentRaw = args.intent_raw.trim();
  if (args.steps !== undefined) {
    const steps = parseRuleStepsArg(args.steps);
    if (!steps) return 'Error: steps invalid（每项 {kind, text}，kind 必标）';
    patch.steps = steps;
  }
  if (Array.isArray(args.keywords)) {
    patch.trigger = { keywords: args.keywords.map(String).map((s) => s.trim()).filter(Boolean) };
  }
  if (Object.keys(patch).length === 0) return 'Error: nothing to revise（至少提供 name / intent_raw / steps / keywords 之一）';
  try {
    const { updateRule } = await import('@/lib/butler/rules');
    const expected = typeof args.expected_version === 'number' ? args.expected_version : undefined;
    const res = await updateRule(id, patch as Parameters<typeof updateRule>[1], expected);
    if (!res.ok) {
      if (res.conflict) return `修订未生效：规则已被改动（版本冲突）。请先 read_rules 取最新 v${res.error}，再重试。`;
      return `修订失败：${res.error}`;
    }
    return `已修订规则（id=${res.rule.id}，v${res.rule.version}）：${res.rule.name}\n修订后否定率从新版本重新统计（旧窗口不再计入）。`;
  } catch (e) {
    return `修订规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * rule_resolve_conflict 工具 — 裁决 need_user（两条规则同时命中且输入有重叠、
 * 宿主无法判定听谁）时，用户在候选卡上选定「听谁」后的**回传原语**（v6 §9.3）。
 * 唯一写口是 lib/butler/rule-signals.recordConflictResolution：按两条规则 id 的有序对分片，
 * 记录本次输入特征、选定方与双方版本，供同类输入复用参考（避免每次都问）。
 */
async function toolRuleResolveConflict(args: Record<string, unknown>): Promise<string> {
  const a = typeof args.rule_a === 'string' ? args.rule_a.trim() : '';
  const b = typeof args.rule_b === 'string' ? args.rule_b.trim() : '';
  const chosen = typeof args.chosen === 'string' ? args.chosen.trim() : '';
  if (!a || !b) return 'Error: rule_a / rule_b are required（两条冲突规则 id 必填，可用 read_rules 查看）';
  if (chosen !== a && chosen !== b) return 'Error: chosen must be one of rule_a / rule_b（选定方须为其中一条）';
  const inputFeature = typeof args.input_feature === 'string' ? args.input_feature.trim() : '';
  try {
    const { readRule } = await import('@/lib/butler/rules');
    const [ra, rb] = await Promise.all([readRule(a), readRule(b)]);
    if (!ra || !rb) return `未找到规则（${!ra ? a : b}）。可用 read_rules 查看有效 id。`;
    const { recordConflictResolution } = await import('@/lib/butler/rule-signals');
    await recordConflictResolution(a, b, inputFeature, chosen, [ra.version, rb.version]);
    const winner = chosen === a ? ra : rb;
    return `已记下这次冲突裁决：听「${winner.name}」（id=${chosen}）。同类输入再出现时我会据此参考，不再重复问你。`;
  } catch (e) {
    return `记录冲突裁决失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * query_todos 工具执行器：
 *   - view=schedule（默认）：复用 /todo check 的查询管线（resolveReadCalendarQuery 自由语义解析
 *     → querySchedule 读全局日历库并精确过滤/格式化）。服务端自调用带绝对 base（Node fetch
 *     不支持相对路径），与 daily-report / organize-send 同一约定。
 *   - view=sticky（P2 承接 /inspect）：复用 lib/core/inspect 的跨项目便签待办聚合
 *     （项目 → 便签 → 页，排除已完成），无需自调用宿主 API。
 */
async function toolQueryTodos(args: Record<string, unknown>): Promise<string> {
  try {
    const queryText = typeof args.query === 'string' ? args.query.trim() : '';
    const scope =
      args.scope === 'project' || args.scope === 'global' ? (args.scope as 'project' | 'global') : 'all';
    // 便签待办视图（P2：承接 /inspect）：当前项目未完成的便签待办，按 项目→便签→页 组织，
    // 已完成项排除；scope='all' 扫描所有活跃项目；query 作模糊关键词过滤（多词 OR）。
    if (args.view === 'sticky') {
      const { inspectStickyTodos, formatInspectReply } = await import('@/lib/core/inspect');
      const result = await inspectStickyTodos(scope === 'all' ? 'all' : 'current', queryText || undefined);
      return formatInspectReply(result);
    }
    const base = `http://localhost:${process.env.PORT || '5000'}`;
    const { resolveReadCalendarQuery, querySchedule } = await import('@/lib/core/schedule');
    const { query } = await resolveReadCalendarQuery({ query_text: queryText, scope }, base);
    const res = await querySchedule(query, base);
    if (!res.ok) return `(todo query failed: ${res.reply})`;
    // 附上 event_id 索引，供 todo_update / todo_delete 定位（reply 本身不带完整 id）
    const events = res.events || [];
    if (events.length > 0) {
      const fmt = (iso?: string | null): string =>
        iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
      const idx = events
        .slice(0, 40)
        .map((e) => `- ${e.title}${e.start_time ? ` (${fmt(e.start_time)})` : ''} → id:${e.event_id}`)
        .join('\n');
      return `${res.reply}\n\n【event_id 索引（改/删用）】\n${idx}`;
    }
    return res.reply;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 服务端自调用绝对 base（Node fetch 不支持相对路径），与 daily-report / query_todos 同一约定 */
function selfBaseUrl(): string {
  return `http://localhost:${process.env.PORT || '5000'}`;
}

/** todo_update 执行器：按 event_id 改标题/时间/完成态等；复用 /api/calendar/events PATCH（含反向落回便签） */
async function toolTodoUpdate(args: Record<string, unknown>): Promise<string> {
  try {
    const eventId = String(args.event_id ?? '').trim();
    if (!eventId) return JSON.stringify({ ok: false, error: 'event_id 不能为空' });
    const body: Record<string, unknown> = {};
    const fieldMap: Array<[string, unknown]> = [
      ['title', args.title],
      ['start_time', args.start_time],
      ['end_time', args.end_time],
      ['all_day', args.all_day],
      ['status', args.status],
      ['priority', args.priority],
      ['color', args.color],
      ['location', args.location],
      ['description', args.description],
      ['due_at', args.due_at],
      ['estimated_minutes', args.estimated_minutes],
      ['block_locked', args.block_locked],
      ['reminder_minutes', args.reminder_minutes],
    ];
    for (const [k, v] of fieldMap) {
      if (v !== undefined && v !== null) body[k] = v;
    }
    // due_at 传空字符串 = 清除截止时间（存 null 而非空串）
    if (body.due_at === '') body.due_at = null;
    // 周期重复：'daily'/'weekly' 设置；'none' 明确取消（传 null 清库）；未提及则不动
    const rec = buildRecurrence(args);
    if (rec !== undefined) body.recurrence = rec;
    if (Object.keys(body).length === 0) return JSON.stringify({ ok: false, error: '没有要更新的字段' });
    const resp = await fetch(`${selfBaseUrl()}/api/calendar/events?event_id=${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data?.success) return `(todo update failed: ${data?.error || resp.status})`;
    const ev = data.event;
    // ⑤ 写入后校验：route 内部是 updateEvent → getEvent，故 data.event 已是落库后的行。
    // status 是最高代价字段（done / 恢复未完成 直接改变语义），做硬校验；
    // 时间/标题等由 route 的回读保证，不在工具侧做易误报的字符串比对。
    if (!ev) {
      return JSON.stringify({
        ok: false,
        error: 'write_verification_failed',
        event_id: eventId,
        message: '更新接口未回传落库后的事件行，无法确认已生效——请用 query_todos 复核，勿假设已改。',
      });
    }
    if (typeof body.status === 'string' && ev.status !== body.status) {
      return JSON.stringify({
        ok: false,
        error: 'write_verification_failed',
        event_id: eventId,
        expected_status: body.status,
        actual_status: ev.status,
        message: `状态未落库：期望 ${body.status}，实际 ${ev.status}——请重试，勿假设已改。`,
      });
    }
    // v6 §7 规则信号：若该待办由某条规则产出（hits.producedRef 归因），落一条 output_edited。
    // 用产出对象引用反查规则（findRuleByProducedRef），保证「规则跑出来的待办被改」可追踪。
    try {
      const { attributeOutputEdited } = await import('@/lib/butler/rule-exec');
      await attributeOutputEdited(
        eventId,
        '(rule-produced)',
        `fields=[${Object.keys(body).join(',')}] title="${ev?.title ?? ''}"`,
      );
    } catch { /* 归因失败不阻断更新 */ }
    if (ev?.status === 'done') return `✅ 已完成：${ev.title}`;
    if (ev?.status === 'scheduled' && body.status === 'scheduled') return `↩ 已恢复未完成：${ev.title}`;
    const recLabel = recurrenceLabel(rec);
    return `✓ 已更新：${ev?.title ?? eventId}${ev?.start_time ? ` @ ${ev.start_time}` : ''}${
      recLabel ? ` · repeats ${recLabel}` : rec === null ? ' · repeat removed' : ''
    }`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** todo_delete 执行器：按 event_id 删除（软删默认；硬删可选）；反向联动同步移除便签行 */
async function toolTodoDelete(args: Record<string, unknown>): Promise<string> {
  try {
    const eventId = String(args.event_id ?? '').trim();
    if (!eventId) return JSON.stringify({ ok: false, error: 'event_id 不能为空' });
    const hard = args.hard === true;
    const resp = await fetch(`${selfBaseUrl()}/api/calendar/events?event_id=${encodeURIComponent(eventId)}${hard ? '&hard=1' : ''}`, {
      method: 'DELETE',
    });
    const data = await resp.json();
    if (!data?.success) return `(todo delete failed: ${data?.error || resp.status})`;
    // ⑤ 写入后校验：回读确认删除真的在库里生效（软删=status cancelled；硬删=行已不存在），
    // 防"接口返回 success 但实际空操作"。route 的 404 已覆盖「事件不存在」情形。
    const { getCalendarDb, getEvent } = await import('@/lib/db');
    const db = await getCalendarDb();
    const after = await getEvent(db, eventId);
    const verified = hard ? !after : after?.status === 'cancelled';
    if (!verified) {
      return JSON.stringify({
        ok: false,
        error: 'write_verification_failed',
        event_id: eventId,
        expected: hard ? 'row removed' : 'status=cancelled',
        actual: after ? `status=${after.status}` : 'row missing',
        message: '删除未在库中生效——请复核，勿假设已删。',
      });
    }
    return hard ? `🗑 已彻底删除待办：${eventId}` : `🗑 已删除待办：${eventId}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * query_schedule 工具执行器：从全局日历库按时间窗读取日程（跨项目），
 * 供日程安排专家在做安排前查冲突。输出按开始时间排序的 markdown 列表，
 * 并附带"无时间"的未完成清单项（合并散活，便于整体排期）。
 */
async function toolQuerySchedule(args: Record<string, unknown>): Promise<string> {
  try {
    const { getCalendarDb, listEventsInRange, listEventsByStatus } = await import('@/lib/db');
    const db = await getCalendarDb();
    const now = new Date();
    const days = Math.min(Math.max(Number(args.days) || 14, 1), 120);
    const rangeStart = args.range_start ? new Date(String(args.range_start)) : now;
    const rangeEnd = args.range_end
      ? new Date(String(args.range_end))
      : new Date(rangeStart.getTime() + days * 86400_000);
    const wantStatus = typeof args.status === 'string' ? args.status : 'scheduled';
    const onlyProject = typeof args.project_id === 'string' ? args.project_id : undefined;

    const fmt = (iso?: string | null): string =>
      iso
        ? new Date(iso).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '—';

    const rows = await listEventsInRange(db, null, rangeStart.toISOString(), rangeEnd.toISOString());
    const timed = rows
      .filter(
        (r) =>
          (!wantStatus || r.status === wantStatus) &&
          (!onlyProject || r.project_id === onlyProject),
      )
      .sort((a, b) => (a.start_time ?? '9999').localeCompare(b.start_time ?? '9999'));

    // 无时间清单项（start null）：仅列 scheduled，供排建议时合并散活
    const untimedScheduled = (await listEventsByStatus(db, null, 'scheduled', 300)).filter(
      (r) => !r.start_time && (!onlyProject || r.project_id === onlyProject),
    );

    const lines: string[] = [
      `# Schedule · ${new Date(rangeStart).toLocaleDateString('zh-CN')} → ${new Date(rangeEnd).toLocaleDateString('zh-CN')}`,
      `> ${timed.length} timed event(s) · ${untimedScheduled.length} open item(s) without a time`,
      '',
    ];
    if (timed.length === 0) lines.push('(no timed events in this window)');
    // 任务元信息后缀：[due <time>] · est <n>m · [locked] · [stale]
    const meta = (r: { due_at?: string | null; estimated_minutes?: number | null; block_locked?: number; schedule_status?: string; recurrence_json?: string | null }): string => {
      const parts: string[] = [];
      if (r.due_at) parts.push(`due ${fmt(r.due_at)}`);
      if (r.estimated_minutes) parts.push(`est ${r.estimated_minutes}m`);
      if (r.block_locked === 1) parts.push('locked');
      if (r.schedule_status === 'stale') parts.push('stale');
      const rec = recurrenceLabel(parseRecurrence(r.recurrence_json));
      if (rec) parts.push(`repeats ${rec}`);
      return parts.length ? ` [${parts.join(' · ')}]` : '';
    };
    for (const r of timed) {
      lines.push(
        `- ${fmt(r.start_time)}${r.end_time ? ` ~ ${fmt(r.end_time)}` : ''} · ${r.title}${r.status === 'done' ? ' ✅' : ''}${r.scope === 'global' ? ' (global)' : ''}${meta(r)} · id:${r.event_id.slice(0, 8)}`,
      );
    }
    if (wantStatus === 'scheduled') {
      lines.push('');
      lines.push('### Open items (no fixed time)');
      if (untimedScheduled.length === 0) lines.push('(none)');
      for (const r of untimedScheduled) {
        lines.push(`- ${r.title}${r.scope === 'global' ? ' (global)' : ''}${meta(r)} · id:${r.event_id.slice(0, 8)}`);
      }
    }
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * create_scheduled_todo 工具执行器：给「仍未入日历的待办」或「用户要求精确时刻」的待办写日历事件，
 * 并把事件绑定到项目便签行（行在便签「结算」时已自动入日历——见 lib/sticky-calendar-sync.ts）。
 * 绑定规则：项目便签里已有同文本且未入日历的行 → 直接绑定该行（不新增重复行）；
 * 同文本但已入日历 → 拒绝并指向 todo_update（改期不造重复）；否则在便签上追加一行（无便签位时仅建日历事件）。
 * 事件归属：优先 args.project（项目名 / ID，或用户明确说"当前项目"时传 current）。
 * 用户未提及项目时**不再回问**——自动落当前激活项目；应用当前无激活项目则落全局日历
 * （scope='global'，仅建事件、不挂便签）。只有「同名多命中 / 未找到」才返回错误让模型澄清。
 * 时间硬校验（2026-09-27）：缺 start_time → need_more_info（附 suggested 默认时段，交由模型一句话征询，
 * 不再静默默认排期）；start_time 不可解析 → invalid_time；时间已过去（5 分钟容差，全天按日期比）→ past_time。
 * 三者都**不落库**；缺时间 / 时间非法 force 也不放行（force 只放行冲突与已过去时间的补记）。
 * 时段纪律（2026-09-27）：落地前调 lib/calendar/overlaps.assessEventSlot 做确定性评估——
 * 重叠（hard）/ 紧邻上一个日程结束时间不足 15 分钟、相邻异地需通勤、同日全天日程（potential）
 * 一律**不落库**，把 conflicts / risks / alternatives 交给模型用一两句话确认；none 才直接落库。
 * 用户已被告知风险仍坚持原时段时，带 force=true 再调用一次即落地。
 */
async function toolCreateScheduledTodo(args: Record<string, unknown>): Promise<string> {
  try {
    // 落点解析：显式项目优先；未提及项目 → 自动落当前激活项目；无激活项目 → 落全局日历
    // （scope='global'，仅建事件、不挂便签）。同名多命中 / 未找到原样返回，交模型澄清。
    // 历史教训（2026-09-27 余靖潘案）：省略 project 时静默兜底到当前项目，模型以为写进了新项目，
    // 于是反复「建→撤→建」。故落点来源（project_source）随回执回传，让模型能立刻发现写偏。
    const pr = await resolveProjectWithFallback(args.project, { allowGlobal: true });
    if (!pr.ok) return pr.payload;
    const project = pr.project;
    const projectSource = pr.source;
    const projectId = project?.id ?? '__global__';
    const projectName = project?.name ?? '全局';
    const projectRoot = project?.path ?? null;
    const title = String(args.title ?? '')
      .trim()
      .replace(/\n+/g, ' ');
    if (!title) return JSON.stringify({ ok: false, error: 'title 不能为空' });

    const cal = await import('@/lib/sticky-calendar-sync');
    const notes = projectRoot
      ? await cal.readStickyNotesFile(projectRoot)
      : ([] as import('@/app/api/sticky-notes/route').StickyNote[]);

    const startRaw = typeof args.start_time === 'string' && args.start_time ? String(args.start_time) : '';
    const allDay = args.all_day === true;
    const force = args.force === true;
    // 估时（分钟）：给了 est 而未给 end_time → 由估时推出执行块长度（否则沿用 1 小时默认）
    const estimatedMinutes =
      typeof args.estimated_minutes === 'number' && Number.isFinite(args.estimated_minutes) && args.estimated_minutes > 0
        ? Math.round(args.estimated_minutes)
        : undefined;

    // —— 硬校验（2026-09-27）：把「这个时间靠不靠谱」从模型自律改成代码强制 ——
    // ① 缺时间：原来静默用默认时段排上，与「确认要严谨」冲突 → 现在不落库，回问用户。
    //    （默认时段仍作为 suggested 返回，供模型用一句话征询，而不是丢掉这个便利。）
    if (!startRaw) {
      const fallback = cal.stickyTodoDefaultRange();
      return JSON.stringify({
        ok: false,
        error: 'need_more_info',
        suggested: fallback,
        message: `用户没给出时间，未写入日历。用一句话把建议时段（${fallback.start} 起）告知用户并等其确认；确认后再带 start_time 调用本工具。`,
      });
    }
    // ② 时间非法：模型解析错格式/错年份时不落库，要求重填或先确认。
    const startDate = new Date(startRaw);
    if (Number.isNaN(startDate.getTime())) {
      return JSON.stringify({
        ok: false,
        error: 'invalid_time',
        message: `start_time「${startRaw}」不是可解析的时间，未写入日历。请按 YYYY-MM-DDTHH:mm:ss±HH:MM 重填，或先向用户确认具体时间。`,
      });
    }
    const startTime = startRaw;
    const endTime =
      typeof args.end_time === 'string' && args.end_time
        ? String(args.end_time)
        : allDay
          ? undefined
          : new Date(
              startDate.getTime() + (estimatedMinutes ? estimatedMinutes * 60_000 : 3600_000),
            ).toISOString();
    // ③ 已过去：模型把日期/年份算错是最常见的脏数据来源。刚过去 5 分钟内仍算「现在」；
    //    全天事件只按日期比较（今天的全天事件下午再建也合理）。用户明确坚持补记历史时带 force 放行。
    if (!force) {
      const nowMs = Date.now();
      const GRACE_MS = 5 * 60_000;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const endMs = endTime ? new Date(endTime).getTime() : startDate.getTime() + 30 * 60_000;
      const isPast = allDay
        ? startDate.getTime() < todayStart.getTime()
        : (Number.isNaN(endMs) ? startDate.getTime() : endMs) < nowMs - GRACE_MS;
      if (isPast) {
        return JSON.stringify({
          ok: false,
          error: 'past_time',
          message: `时间「${startTime}」已经过去，未写入日历。请向用户确认是不是算错了日期；用户确实要补记这个历史时段时，带 force=true 再调用一次。`,
        });
      }
    }
    const reminderRaw = args.reminder_minutes;
    const reminderMinutes =
      Array.isArray(reminderRaw) && reminderRaw.every((x) => typeof x === 'number')
        ? (reminderRaw as number[])
        : allDay
          ? []
          : [30];

    // StickyTodo 行在便签「结算」保存时已自动入日历（2026-09-21）；本工具只处理两类剩余场景：
    //   a) 该行确实仍未入日历（刚由 create_sticky_note 写入、用户还没结算）；
    //   b) 用户要求精确时刻而自动排期给的是默认时段。
    // 改期（已入日历的行换时间）不该走这里，应走 todo_update —— 见下方 anchored 命中的兜底返回。
    // 绑定判据：同文本且**未入日历**的便签行 → 绑定该行（避免把既有待办排期时新增重复行）。
    // 每项目待办便签上限：取共享常量，别在这里再写一份字面量——
    // 否则 /api/sticky-notes 的校验（也读 MAX_TODO_NOTES）与本工具会各说各话。
    const { MAX_TODO_NOTES } = await import('@/lib/sticky-todo');

    // 1) 复用同文本的未排程行；顺带记下「同文本但已入日历」的行（改期误用本工具的兜底）
    let bindRow: { noteIdx: number; pageId: string; lineIndex: number } | null = null;
    let calendaredRow: { eventId: string } | null = null;
    for (let ni = 0; ni < notes.length && !bindRow; ni++) {
      const n = notes[ni];
      if (!Array.isArray(n.pages)) continue;
      for (const pg of n.pages) {
        if (pg.kind === 'note') continue;
        const rows = String(pg.content ?? '').split('\n');
        const calArr = Array.isArray(pg.lineCalendared) ? pg.lineCalendared : [];
        const evsArr = Array.isArray(pg.lineEventIds) ? pg.lineEventIds : [];
        for (let li = 0; li < rows.length; li++) {
          const m = rows[li].match(/^-\s*\[( |x)\]\s*(.*)$/);
          const done = m ? m[1] === 'x' : false;
          const rowText = (m ? m[2] : rows[li]).trim();
          if (done || !rowText || rowText !== title) continue;
          const evIds = Array.isArray(evsArr[li]) ? (evsArr[li] as string[]).filter(Boolean) : [];
          const anchored = evIds.length > 0;
          const flagged = calArr[li] === true;
          if (anchored || flagged) {
            if (!calendaredRow) calendaredRow = { eventId: evIds[0] ?? '' };
            continue;
          }
          bindRow = { noteIdx: ni, pageId: pg.id, lineIndex: li };
          break;
        }
      }
    }

    // 兜底（2026-09-25）：同名行已入日历 ⇒ 用户要的是「改期 / 改名」，不是新建。
    // 若继续执行，会在下方 :rawLines.push 追加一条同名待办行并另建一个事件，同一件事变成两份。
    // 故此处直接拒绝并指向 todo_update（能取到 event_id 就带上）。
    if (!bindRow && calendaredRow) {
      return JSON.stringify({
        ok: false,
        error: 'already_calendared',
        message:
          '该项目已有一条同名待办行且已进入日历（便签结算时自动排期）。这属于「改期 / 改名」，请改用 todo_update（先 query_todos 取 event_id 再改 start_time）——用 create_scheduled_todo 会新增一条重复待办行与一个重复日历事件。若用户确实要一件措辞相同但彼此独立的第二件事，请先把标题写得可区分（如加上日期或事由）。',
        ...(calendaredRow.eventId ? { event_id: calendaredRow.eventId } : {}),
      });
    }

    // 2) 选择可挂载的便签页；无则尝试新建（每项目最多三张，超限则只建日历事件）
    let pageId: string | undefined;
    let attachNote: (typeof notes)[number] | undefined;
    let newNoteCreated = false;
    let bindLineIndex: number | undefined;
    if (bindRow) {
      attachNote = notes[bindRow.noteIdx];
      pageId = bindRow.pageId;
      bindLineIndex = bindRow.lineIndex;
    } else if (projectRoot) {
      // 无项目（全局日历）时不新建便签，只建日历事件
      const note = notes.find((n) => Array.isArray(n.pages) && n.pages.some((p) => p.kind !== 'note'));
      if (note) {
        const page = note.pages!.find((p) => p.kind !== 'note')!;
        pageId = page.id;
        attachNote = note;
      } else if (notes.length < MAX_TODO_NOTES) {
        const now = new Date().toISOString();
        const pid = `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const nid = `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const topZ = notes.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
        const { pickTodoNoteColor } = await import('@/lib/sticky-todo');
        const createdNote = {
          id: nid,
          x: 40 + (notes.length % 5) * 28,
          y: 120 + (notes.length % 5) * 28,
          color: pickTodoNoteColor(notes as Array<Record<string, unknown>>),
          kind: 'todo',
          title: projectName || 'Untitled',
          pages: [{ id: pid, title: 'P1', content: `- [ ] ${title}`, kind: 'todo' }],
          activePageId: pid,
          createdAt: now,
          updatedAt: now,
          width: 400,
          height: 225,
          sidebarCollapsed: true,
          z: topZ + 1,
        } as import('@/app/api/sticky-notes/route').StickyNote;
        pageId = pid;
        attachNote = createdNote;
        newNoteCreated = true;
        notes.push(createdNote);
      }
    }

    // 时段风险评估（2026-09-27）：落地前把「这个时段合不合适」查清（一次 DB 查询，确定性判定）。
    //   hard      = 与既有安排区间重叠 → 不落库；
    //   potential = 紧邻上一个日程结束时间不足 15 分钟 / 相邻事项异地需通勤 / 同日全天日程 → 不落库，先让用户确认；
    // 用户明知风险仍坚持原时段 → 再次调用时带 force=true 直接落库。
    const location =
      typeof args.location === 'string' && args.location.trim() ? args.location.trim() : undefined;

    // 建日历事件（先建，获得 event_id 后再回填到便签行锚点）
    const { getCalendarDb, createEvent, getEvent } = await import('@/lib/db');
    const db = await getCalendarDb();
    const sourceRef =
      attachNote && pageId ? cal.stickyRefOf(attachNote.id, pageId) : undefined;

    // 原子性（2026-09-27）：把「冲突评估 → 写入」放进同一把日历写锁内**串行**执行，
    // 避免两个并发请求双双通过检查、再各自落库（TOCTOU 双订）。
    const { withCalendarWriteLock } = await import('@/lib/calendar/availability');
    const outcome = await withCalendarWriteLock(async () => {
      if (!force) {
        const { assessEventSlot } = await import('@/lib/calendar/overlaps');
        const assessment = await assessEventSlot({
          startIso: startTime,
          endIso: endTime ?? null,
          location,
          allDay,
        });
        if (assessment.level !== 'none') return { blocked: true as const, assessment };
      }
      const id = await createEvent(db, {
        project_id: projectId,
        title,
        description: typeof args.description === 'string' && args.description ? args.description : undefined,
        location: location ?? null,
        start_time: startTime,
        end_time: endTime ?? null,
        all_day: allDay,
        scope: project ? 'project' : 'global',
        kind: 'task',
        due_at: typeof args.due_at === 'string' && args.due_at ? String(args.due_at) : null,
        estimated_minutes: estimatedMinutes ?? null,
        block_locked: args.block_locked === true,
        scheduled_by: 'user',
        reminder_minutes: reminderMinutes,
        // 周期重复：'daily'/'weekly' → 规则；未提 / 'none' → 不重复（null 与 undefined 在创建时同义）
        recurrence: buildRecurrence(args) ?? undefined,
        source_ref: sourceRef,
      });
      return { blocked: false as const, eventId: id };
    });

    if (outcome.blocked) {
      const assessment = outcome.assessment;
      return JSON.stringify({
        ok: false,
        error: assessment.level === 'hard' ? 'slot_conflict' : 'slot_risk',
        conflict_level: assessment.level,
        conflicts: assessment.overlaps,
        risks: assessment.risks,
        alternatives: assessment.alternatives,
        message:
          assessment.level === 'hard'
            ? '该时段与已有安排重叠，未写入日历。把重叠事实与给定的空档用一两句话告知用户，等其选定时段后再调用本工具。'
            : '该时段存在潜在冲突（紧邻空档不足 / 相邻异地 / 同日全天），未写入日历。用一两句话把风险与给定的更合适时段说清，等用户确认；用户明确坚持原时段时，带 force=true 再调用一次即可落地。',
      });
    }
    const eventId = outcome.eventId;

    // ⑤ 写入后校验落点：回读该事件，确认真的落到了预期项目（防静默写偏）。
    // 落点不符 / 回读失败一律不静默通过——把差异原样回传，让模型立刻纠正而不是继续往下走。
    const persisted = await getEvent(db, eventId);
    if (!persisted) {
      return JSON.stringify({
        ok: false,
        error: 'write_verification_failed',
        event_id: eventId,
        message: '事件写入后回读失败，落点无法确认——请重试。',
      });
    }
    if (persisted.project_id !== projectId) {
      return JSON.stringify({
        ok: false,
        error: 'write_verification_failed',
        event_id: eventId,
        expected_project_id: projectId,
        actual_project_id: persisted.project_id,
        message: `事件落到了 ${persisted.project_id}，与预期 ${projectId} 不符——请用 todo_update 改正归属，勿重复创建。`,
      });
    }

    let lineIndex: number | undefined;
    if (attachNote && pageId && projectRoot) {
      const noteIdx = notes.findIndex((n) => n.id === attachNote!.id);
      const page = notes[noteIdx].pages!.find((p) => p.id === pageId)!;
      const rawLines = String(page.content ?? '').split('\n');
      const evs = Array.isArray(page.lineEventIds)
        ? page.lineEventIds.map((x) => [...x])
        : rawLines.map(() => [] as string[]);
      const calArr = Array.isArray(page.lineCalendared)
        ? [...page.lineCalendared]
        : rawLines.map(() => false);
      if (bindLineIndex !== undefined) {
        // 绑定既有同文本的未排程行（Butler 把已有便签待办排期时不新增重复行）
        lineIndex = bindLineIndex;
        rawLines[lineIndex] = `- [ ] ${title}`;
        while (evs.length <= lineIndex) evs.push([]);
        evs[lineIndex] = [...(evs[lineIndex] ?? []), eventId];
        while (calArr.length <= lineIndex) calArr.push(false);
        calArr[lineIndex] = true;
      } else if (newNoteCreated) {
        lineIndex = 0;
        rawLines[0] = `- [ ] ${title}`;
        evs[0] = [eventId];
        calArr[0] = true;
      } else {
        lineIndex = rawLines.length;
        rawLines.push(`- [ ] ${title}`);
        evs.push([eventId]);
        calArr.push(true);
      }
      const updated: typeof notes[number] = {
        ...notes[noteIdx],
        pages: notes[noteIdx].pages!.map((p) =>
          p.id === pageId
            ? { ...p, content: rawLines.join('\n'), lineEventIds: evs, lineCalendared: calArr }
            : p,
        ),
        updatedAt: new Date().toISOString(),
      };
      notes[noteIdx] = updated;
      // 落盘前统一剔除空行并重排行级日历锚点（空行不是待办）
      const { normalizeStickyNote } = await import('@/lib/sticky-todo');
      notes[noteIdx] = normalizeStickyNote(notes[noteIdx] as unknown as Record<string, unknown>) as typeof notes[number];
      await cal.writeStickyNotesFile(projectRoot, notes);
    }

    return JSON.stringify({
      ok: true,
      event_id: eventId,
      title,
      start_time: startTime,
      end_time: endTime ?? null,
      all_day: allDay,
      due_at: typeof args.due_at === 'string' && args.due_at ? String(args.due_at) : null,
      estimated_minutes: estimatedMinutes ?? null,
      block_locked: args.block_locked === true,
      // 事件落当前活跃项目（用户未点名项目时的自动归属）；应用无激活项目时落全局日历
      project: projectName,
      global: !project,
      project_id: projectId,
      project_source: projectSource,
      // 未指定项目而兜底到当前项目时，把这件事显式说给模型听（防止"以为写进了别的项目"）
      warning:
        projectSource === 'current_fallback'
          ? `你这次没有传 project，事件落到了**当前项目**《${projectName}》。若用户其实指的是别的项目，请先用 query_todos 拿 event_id 再 todo_update 改归属，或重调本工具并显式传 project——不要重复创建。`
          : undefined,
      note_id: attachNote?.id ?? null,
      line_index: lineIndex ?? null,
      calendar_only: !attachNote,
      reminder_minutes: reminderMinutes,
    });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * plan_schedule 工具执行器：运行确定性排程器，为「有截止或估时、但还没时段」的任务
 * 在工作时段内自动找执行块并落库。只读场景可传 dry_run 先看方案。
 */
async function toolPlanSchedule(args: Record<string, unknown>): Promise<string> {
  try {
    const { runScheduler } = await import('@/lib/calendar/scheduler');
    const horizonDays =
      typeof args.horizon_days === 'number' && args.horizon_days > 0
        ? Math.min(Math.round(args.horizon_days), 120)
        : undefined;
    const dryRun = args.dry_run === true;
    const res = await runScheduler({ horizonDays, dryRun });

    const fmt = (iso: string): string =>
      new Date(iso).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

    const lines: string[] = [
      `# Plan run${dryRun ? ' (dry-run, nothing written)' : ''} · placed ${res.placed} · unplaced ${res.unplaced}`,
    ];
    if (res.assignments.length > 0) {
      lines.push('', '## Scheduled blocks');
      for (const a of res.assignments) {
        lines.push(`- ${fmt(a.start)} ~ ${fmt(a.end)} · ${a.title} · id:${a.event_id.slice(0, 8)}`);
      }
    }
    if (res.unplaced_tasks.length > 0) {
      lines.push('', '## Could not place');
      for (const u of res.unplaced_tasks) {
        lines.push(`- ${u.title} (${u.reason}) · id:${u.event_id.slice(0, 8)}`);
      }
    }
    if (res.placed === 0 && res.unplaced === 0) {
      lines.push('', '(nothing to schedule — no task has a due date or an estimate yet)');
    }
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * query_schedule_status 工具执行器（只读）：报告排程计划是否最新（schedule_meta），
 * 以及还有哪些任务没有时段。用于回答「计划是最新的吗 / 还有什么没排上 / 变更后要不要重排」。
 */
async function toolQueryScheduleStatus(): Promise<string> {
  try {
    const { queryScheduleStatus } = await import('@/lib/calendar/scheduler');
    const s = await queryScheduleStatus();
    const fmt = (iso: string | null): string =>
      iso
        ? new Date(iso).toLocaleString('en-US', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '—';
    const lines: string[] = [
      `# Schedule status: ${s.status}`,
      `- version: ${s.version} · last planned: ${fmt(s.last_planned_at)}${s.status === 'stale' ? ` · dirty since: ${fmt(s.dirty_at)}` : ''}`,
      `- tasks with a block: ${s.scheduled_count} · stale: ${s.stale_count} · awaiting a slot: ${s.unscheduled_tasks.length}`,
    ];
    if (s.status === 'stale') {
      lines.push('', 'The plan is out of date and will be recomputed automatically within a few seconds; use plan_schedule to force it now.');
    }
    if (s.unscheduled_tasks.length > 0) {
      lines.push('', '## Awaiting a slot');
      for (const t of s.unscheduled_tasks) {
        const meta = [t.due_at ? `due ${fmt(t.due_at)}` : '', t.estimated_minutes ? `est ${t.estimated_minutes}m` : '']
          .filter(Boolean)
          .join(' · ');
        lines.push(`- ${t.title}${meta ? ` (${meta})` : ''} · id:${t.event_id.slice(0, 8)}`);
      }
    }
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * create_sticky_note 工具执行器：在画布上静默创建一张便签（项目私有）。
 * 便签为用户私有数据（AI 不可读回），本工具仅负责写入，不返回内容、不触发确认弹窗。
 * 目标项目必须由 args.project 显式指定（未指定 → project_required，不回落当前项目）。
 * 写入格式与 /api/sticky-notes 完全一致（pages/activePageId 结构）。
 */
async function toolCreateStickyNote(args: Record<string, unknown>): Promise<string> {
  try {
    // 落点解析：显式项目优先；未提及项目 → 自动落当前激活项目。
    // 便签为项目私有（无全局便签库），应用无激活项目时直接返回结构化错误，不硬造落点。
    const pr = await resolveProjectWithFallback(args.project);
    if (!pr.ok) return pr.payload;
    if (!pr.project) {
      return JSON.stringify({
        ok: false,
        error: 'no_active_project',
        message: '应用当前没有激活项目，便签无处可写。请让用户先在 BobWork 中激活或选择一个项目。',
      });
    }
    const projectRoot = pr.project.path;
    const projectSource = pr.source;
    const projectName = pr.project.name || 'Untitled';
    const content = String(args.content ?? '').trim();
    if (!content) return JSON.stringify({ ok: false, error: 'content 不能为空' });
    // 未指定项目而兜底到当前项目时，把这件事显式说给模型听（防止"以为写进了别的项目"）
    const fallbackWarning =
      projectSource === 'current_fallback'
        ? `你这次没有传 project，便签落到了**当前项目**《${projectName}》。若用户其实指的是别的项目，请删除该便签后带显式 project 重调本工具——不要重复创建。`
        : undefined;

    // 落盘原语与规则执行器（rule-exec.ts 的 create_todo）共用同一份，见 lib/butler/sticky-write.ts
    const { appendStickyTodoNote } = await import('@/lib/butler/sticky-write');
    const res = await appendStickyTodoNote({
      projectRoot,
      projectName,
      title: typeof args.title === 'string' ? args.title : undefined,
      content,
      color: typeof args.color === 'string' ? args.color : undefined,
    });
    if (!res.ok) {
      return JSON.stringify({
        ok: false,
        error: res.error ?? 'append_failed',
        note_id: res.noteId || undefined,
        project: projectName,
        project_root: projectRoot,
        message: res.message,
      });
    }
    if (res.limited) {
      return JSON.stringify({
        ok: true,
        note_id: res.noteId,
        title: res.title,
        color: res.color,
        limited: true,
        project: projectName,
        project_source: projectSource,
        warning: fallbackWarning,
        message: '该项目已有三张待办便签，未重复创建',
      });
    }
    return JSON.stringify({
      ok: true,
      note_id: res.noteId,
      title: res.title,
      color: res.color,
      project: projectName,
      project_id: pr.project.id,
      project_root: projectRoot,
      project_source: projectSource,
      warning: fallbackWarning,
    });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ===== 计划树（.butler/plans.json）：里程碑 → 步骤 → 状态推进 =====

type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';
type PlanStep = { id: string; title: string; status: PlanStepStatus; note?: string };
type PlanMilestone = {
  id: string;
  title: string;
  status: 'active' | 'done';
  steps: PlanStep[];
};
type ProjectPlan = {
  id: string;
  title: string;
  goal?: string;
  status: 'active' | 'done';
  milestones: PlanMilestone[];
  createdAt: string;
  updatedAt: string;
};

const BUTLER_DATA_DIR = '.butler';
const BUTLER_DATA_FILE = 'plans.json';

const ALLOWED_TRANSITIONS: Record<PlanStepStatus, PlanStepStatus[]> = {
  pending: ['in_progress', 'blocked'],
  in_progress: ['pending', 'done', 'blocked'],
  done: [],
  blocked: ['pending', 'in_progress'],
};

function newPlanId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

async function readPlans(root: string): Promise<ProjectPlan[]> {
  try {
    const raw = await readFile(join(root, BUTLER_DATA_DIR, BUTLER_DATA_FILE), 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.plans) ? (data.plans as ProjectPlan[]) : [];
  } catch {
    return [];
  }
}

async function writePlans(root: string, plans: ProjectPlan[]): Promise<void> {
  const dir = join(root, BUTLER_DATA_DIR);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${BUTLER_DATA_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
  await writeFile(tmp, JSON.stringify({ plans }, null, 2), 'utf-8');
  await rename(tmp, join(dir, BUTLER_DATA_FILE));
}

function recalcMilestone(m: PlanMilestone): void {
  m.status = m.steps.length > 0 && m.steps.every((s) => s.status === 'done') ? 'done' : 'active';
}

function recalcPlan(p: ProjectPlan): void {
  p.milestones.forEach(recalcMilestone);
  p.status = p.milestones.length > 0 && p.milestones.every((m) => m.status === 'done') ? 'done' : 'active';
  p.updatedAt = new Date().toISOString();
}

function buildMilestone(title: string, stepTitles: string[]): PlanMilestone {
  return {
    id: newPlanId('ms'),
    title,
    status: 'active',
    steps: stepTitles.map((t) => ({ id: newPlanId('st'), title: t, status: 'pending' })),
  };
}

function renderPlan(p: ProjectPlan): string {
  const lines: string[] = [];
  lines.push(`# ${p.title} · ${p.status === 'done' ? '✅ done' : '▶ active'}`);
  lines.push(`> id: ${p.id}${p.goal ? ` · goal: ${p.goal}` : ''}`);
  if (p.milestones.length === 0) {
    lines.push('');
    lines.push('(no milestones yet)');
    return lines.join('\n');
  }
  for (const m of p.milestones) {
    const doneCount = m.steps.filter((s) => s.status === 'done').length;
    lines.push('');
    lines.push(`## ${m.title} ${m.status === 'done' ? '✅' : `(${doneCount}/${m.steps.length})`} · ms:${m.id}`);
    for (const s of m.steps) {
      const mark = s.status === 'done' ? '[x]' : s.status === 'in_progress' ? '[>]' : s.status === 'blocked' ? '[!]' : '[ ]';
      lines.push(`- ${mark} ${s.title} · ${s.status}${s.note ? ` · ${s.note}` : ''} · st:${s.id}`);
    }
  }
  return lines.join('\n');
}

/**
 * 计划树工具的项目根解析：显式项目优先；未提及项目 → 自动落当前激活项目。
 * 计划树为项目私有（.butler/plans.json），应用无激活项目时返回结构化错误。
 * 兜底（current_fallback）时通过 notice 在纯文本回执里回显落点，让"写偏"可见。
 */
async function resolvePlanRoot(ref: unknown): Promise<
  | { ok: true; root: string; notice: string }
  | { ok: false; payload: string }
> {
  const pr = await resolveProjectWithFallback(ref);
  if (!pr.ok) return { ok: false, payload: pr.payload };
  if (!pr.project) {
    return {
      ok: false,
      payload: JSON.stringify({
        ok: false,
        error: 'no_active_project',
        message: '应用当前没有激活项目，无计划树可读写。请让用户先在 BobWork 中激活或选择一个项目。',
      }),
    };
  }
  const notice =
    pr.source === 'current_fallback'
      ? `\n\n[落点：项目《${pr.project.name}》——你未传 project，已自动落到当前激活项目。若用户指的是别的项目，请带显式 project 重调本工具，不要重复创建。]`
      : '';
  return { ok: true, root: pr.project.path, notice };
}

/** 计划树：新建计划（含可选里程碑/步骤） */
async function toolProjectPlanStart(args: Record<string, unknown>): Promise<string> {
  try {
    const pr = await resolvePlanRoot(args.project);
    if (!pr.ok) return pr.payload;
    const root = pr.root;
    const title = String(args.title ?? '').trim();
    if (!title) return JSON.stringify({ ok: false, error: 'title 不能为空' });
    const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : undefined;

    const now = new Date().toISOString();
    const plan: ProjectPlan = {
      id: newPlanId('plan'),
      title,
      goal,
      status: 'active',
      milestones: [],
      createdAt: now,
      updatedAt: now,
    };

    const rawMs = args.milestones;
    if (Array.isArray(rawMs) && rawMs.length > 0) {
      for (const it of rawMs as Array<Record<string, unknown>>) {
        const msTitle = String(it.title ?? '').trim() || 'Milestone';
        const stepTitles = (Array.isArray(it.steps) ? it.steps : [])
          .map((s) => String(s).trim())
          .filter(Boolean);
        plan.milestones.push(buildMilestone(msTitle, stepTitles));
      }
    } else {
      const stepTitles = (Array.isArray(args.steps) ? args.steps : [])
        .map((s) => String(s).trim())
        .filter(Boolean);
      plan.milestones.push(buildMilestone('执行', stepTitles));
    }

    const plans = await readPlans(root);
    plans.push(plan);
    await writePlans(root, plans);
    return `Plan created. id: ${plan.id}\n\n${renderPlan(plan)}\n\nTrack progress with project_plan_view / project_plan_step_status.${pr.notice}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：回读（不带 id 列全部；带 id 列完整树） */
async function toolProjectPlanView(args: Record<string, unknown>): Promise<string> {
  try {
    const pr = await resolvePlanRoot(args.project);
    if (!pr.ok) return pr.payload;
    const root = pr.root;
    const plans = await readPlans(root);
    const planId = typeof args.plan_id === 'string' ? args.plan_id : '';
    if (planId) {
      const p = plans.find((x) => x.id === planId);
      if (!p) return `Plan not found: ${planId}`;
      return renderPlan(p) + pr.notice;
    }
    if (plans.length === 0) return '(no plans in this project yet. Use project_plan_start to create one.)' + pr.notice;
    const lines = ['# Project plans', ''];
    for (const p of plans) {
      const steps = p.milestones.reduce((n, m) => n + m.steps.length, 0);
      const doneSteps = p.milestones.reduce((n, m) => n + m.steps.filter((s) => s.status === 'done').length, 0);
      lines.push(`- ${p.status === 'done' ? '✅' : '▶'} ${p.title} · id:${p.id} · ${doneSteps}/${steps} steps done`);
    }
    lines.push('');
    lines.push('Pass plan_id to project_plan_view to see a full tree.');
    return lines.join('\n') + pr.notice;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：追加步骤到里程碑（默认第一个/仅有；可按 id 或按标题定位/新建里程碑） */
async function toolProjectPlanAddSteps(args: Record<string, unknown>): Promise<string> {
  try {
    const pr = await resolvePlanRoot(args.project);
    if (!pr.ok) return pr.payload;
    const root = pr.root;
    const planId = String(args.plan_id ?? '').trim();
    const stepTitles = (Array.isArray(args.steps) ? args.steps : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!planId) return JSON.stringify({ ok: false, error: 'plan_id 不能为空' });
    if (stepTitles.length === 0) return JSON.stringify({ ok: false, error: 'steps 不能为空' });

    const plans = await readPlans(root);
    const plan = plans.find((x) => x.id === planId);
    if (!plan) return JSON.stringify({ ok: false, error: `计划不存在: ${planId}` });

    let milestone: PlanMilestone | undefined;
    const msId = typeof args.milestone_id === 'string' ? args.milestone_id : '';
    const msTitle = typeof args.milestone_title === 'string' && String(args.milestone_title).trim() ? String(args.milestone_title).trim() : '';
    if (msId) milestone = plan.milestones.find((m) => m.id === msId);
    if (!milestone) milestone = plan.milestones.find((m) => !msTitle || m.title === msTitle);
    if (!milestone && !msTitle) milestone = plan.milestones[0];
    if (!milestone) {
      milestone = buildMilestone(msTitle || '执行', []);
      plan.milestones.push(milestone);
    }
    for (const t of stepTitles) milestone.steps.push({ id: newPlanId('st'), title: t, status: 'pending' });
    recalcPlan(plan);
    await writePlans(root, plans);
    return `Added ${stepTitles.length} step(s) to "${milestone.title}".\n\n${renderPlan(plan)}${pr.notice}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：步骤状态机推进 */
async function toolProjectPlanStepStatus(args: Record<string, unknown>): Promise<string> {
  try {
    const pr = await resolvePlanRoot(args.project);
    if (!pr.ok) return pr.payload;
    const root = pr.root;
    const planId = String(args.plan_id ?? '').trim();
    const stepId = String(args.step_id ?? '').trim();
    const want = String(args.status ?? '').trim() as PlanStepStatus;
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;
    if (!planId || !stepId) return JSON.stringify({ ok: false, error: 'plan_id / step_id 不能为空' });
    if (!['pending', 'in_progress', 'done', 'blocked'].includes(want)) {
      return JSON.stringify({ ok: false, error: `非法状态: ${want}` });
    }

    const plans = await readPlans(root);
    const plan = plans.find((x) => x.id === planId);
    if (!plan) return JSON.stringify({ ok: false, error: `计划不存在: ${planId}` });
    const milestone = plan.milestones.find((m) => m.steps.some((s) => s.id === stepId));
    if (!milestone) return JSON.stringify({ ok: false, error: `步骤不存在: ${stepId}` });
    const step = milestone.steps.find((s) => s.id === stepId)!;

    if (step.status !== want) {
      const allowed = ALLOWED_TRANSITIONS[step.status];
      if (!allowed.includes(want)) {
        return JSON.stringify({ ok: false, error: `不允许 ${step.status} → ${want}（仅支持：${[...allowed, step.status].join(' / ')}）` });
      }
    }
    step.status = want;
    if (note !== undefined) step.note = note;
    recalcPlan(plan);
    await writePlans(root, plans);
    const prefix = want === 'done' ? '✅' : want === 'blocked' ? '⛔' : want === 'in_progress' ? '▶' : '◻';
    return `${prefix} Step "${step.title}" → ${want}${plan.status === 'done' ? ' · 🎉 计划全部完成' : ''}\n\n${renderPlan(plan)}${pr.notice}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ===== 模型计费：管家对话维护单价覆盖（新增模型 / 厂商调价 → 计费链路自动采纳） =====

/** 取模型引用中的裸 modelId（"provider:modelId" → "modelId"） */
function bareModelId(ref: string): string {
  return ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
}

/** 在覆盖表中按裸 modelId 查找（兼容 "provider:modelId" 与裸 key 两种写法） */
function findOverrideEntry(
  overrides: Record<string, ModelPriceOverride>,
  ref: string,
): { key: string; value: ModelPriceOverride } | null {
  const bare = bareModelId(ref);
  for (const [k, v] of Object.entries(overrides)) {
    if (v && bareModelId(k) === bare) return { key: k, value: v };
  }
  return null;
}

/** 归一化覆盖表 key：能匹配到已配置厂商 → "provider:modelId"，否则原样保留 */
function normalizeModelKey(modelRaw: string, providers: ProviderConfig[]): string {
  if (modelRaw.includes(':')) return modelRaw;
  for (const p of providers) {
    if ((p.selectedModels ?? []).some((m) => m.modelId === modelRaw)) return `${p.type}:${modelRaw}`;
  }
  return modelRaw;
}

function fmtOverrideLine(key: string, v: ModelPriceOverride): string {
  const parts = [`input ${v.input}`, `output ${v.output}`];
  if (v.cacheHit != null) parts.push(`cacheHit ${v.cacheHit}`);
  if (v.offPeak != null) parts.push(`offPeak ×${v.offPeak}`);
  return `- ${key}: ${parts.join(' · ')} ${v.currency ?? 'usd'}/1M tokens${v.note ? ` · ${v.note}` : ''} · 更新于 ${v.updatedAt}`;
}

/** get_model_price 工具：查询模型当前生效单价（覆盖价优先），或列出全部覆盖价与已配置模型定价。
 *  只读；用于「这个模型现在按什么价计费 / 哪些模型还没定价」。 */
async function toolGetModelPrice(args: Record<string, unknown>): Promise<string> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const { resolveModelPriceInfo, invalidatePriceOverrides, ensurePriceOverridesLoaded } =
      await import('@/lib/usage');
    const s = await readSettingsFromFile();
    // 强制与磁盘一致（覆盖价可能刚由 set_model_price 写入）
    invalidatePriceOverrides();
    await ensurePriceOverridesLoaded();
    const overrides = s.priceOverrides ?? {};
    const providers: ProviderConfig[] = s.providers ?? [];
    const modelRef = typeof args.model === 'string' ? args.model.trim() : '';

    if (modelRef) {
      const info = resolveModelPriceInfo(modelRef);
      const entry = findOverrideEntry(overrides, modelRef);
      const bare = bareModelId(modelRef);
      if (!info) {
        return JSON.stringify({
          model: modelRef,
          priced: false,
          source: null,
          override: null,
          message: `模型「${bare}」当前未定价（内置价格表无记录，也无用户覆盖价）。其用量成本记为 NULL，面板显示“未定价”。可用 set_model_price 写入单价。`,
        }, null, 2);
      }
      return JSON.stringify({
        model: modelRef,
        priced: true,
        source: info.source,
        unit: 'per 1M tokens',
        price: info.price,
        override: entry ? { key: entry.key, ...entry.value } : null,
        message: info.source === 'override'
          ? `「${bare}」当前走用户覆盖价（input ${info.price.input} / output ${info.price.output} ${info.price.currency}/1M）。`
          : `「${bare}」当前走内置价格表、未被覆盖（input ${info.price.input} / output ${info.price.output} ${info.price.currency}/1M）。`,
      }, null, 2);
    }

    const entries = Object.entries(overrides).filter(([, v]) => v) as Array<[string, ModelPriceOverride]>;
    const lines: string[] = ['# 模型单价总览', ''];
    lines.push(`## 用户覆盖价（${entries.length} 条 · 优先于内置价格表）`);
    if (entries.length === 0) {
      lines.push('(暂无；所有模型走内置价格表。可用 set_model_price 新增/调整。)');
    } else {
      for (const [k, v] of entries) lines.push(fmtOverrideLine(k, v));
    }
    lines.push('');
    lines.push('## 已配置模型当前生效价');
    let total = 0;
    let unpriced = 0;
    for (const p of providers) {
      for (const sel of p.selectedModels ?? []) {
        total++;
        const ref = `${p.type}:${sel.modelId}`;
        const info = resolveModelPriceInfo(ref);
        if (!info) {
          unpriced++;
          lines.push(`- ${ref} → ⚠️ 未定价`);
        } else {
          lines.push(`- ${ref} → ${info.source === 'override' ? '覆盖价' : '内置表'}: input ${info.price.input} / output ${info.price.output} ${info.price.currency}/1M`);
        }
      }
    }
    if (total === 0) lines.push('(模型池为空，或尚未配置任何模型)');
    lines.push('');
    lines.push(
      unpriced > 0
        ? `提示：${unpriced}/${total} 个已配置模型未定价，其用量成本记 NULL（面板显示“未定价”）。可用 set_model_price 补价。`
        : `全部 ${total} 个已配置模型均有定价。`,
    );
    const out = lines.join('\n');
    return out.length > 5000 ? out.slice(0, 4997) + '...' : out;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** set_model_price 工具：写入/清除某模型的用户覆盖单价（.settings.json 的 priceOverrides）。
 *  改后立即对新产生的用量生效；历史记录不改写。单价必须由用户提供或经核实，禁止编造。 */
async function toolSetModelPrice(args: Record<string, unknown>): Promise<string> {
  try {
    const modelRaw = String(args.model ?? '').trim();
    if (!modelRaw) return JSON.stringify({ ok: false, error: 'model 必填（"provider:modelId" 或裸 modelId）' });
    const remove = args.remove === true;

    const input = Number(args.input);
    const output = Number(args.output);
    if (!remove) {
      if (!Number.isFinite(input) || input < 0) return JSON.stringify({ ok: false, error: 'input 必填且为非负数（缓存未命中输入价，每百万 token）' });
      if (!Number.isFinite(output) || output < 0) return JSON.stringify({ ok: false, error: 'output 必填且为非负数（输出价，每百万 token）' });
    }
    let cacheHit: number | undefined;
    if (args.cacheHit != null && args.cacheHit !== '') {
      cacheHit = Number(args.cacheHit);
      if (!Number.isFinite(cacheHit) || cacheHit < 0) return JSON.stringify({ ok: false, error: 'cacheHit 必须为非负数' });
    }
    let offPeak: number | undefined;
    if (args.offPeak != null && args.offPeak !== '') {
      offPeak = Number(args.offPeak);
      if (!Number.isFinite(offPeak) || offPeak <= 0) return JSON.stringify({ ok: false, error: 'offPeak 必须为正数（空闲时段倍率，如 0.5）' });
    }
    const currency = args.currency === 'cny' ? 'cny' : args.currency === 'usd' ? 'usd' : undefined;
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;

    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const { invalidatePriceOverrides } = await import('@/lib/usage');
    const s = await readSettingsFromFile();
    const overrides: Record<string, ModelPriceOverride> = s.priceOverrides ?? (s.priceOverrides = {});
    const key = normalizeModelKey(modelRaw, s.providers ?? []);
    const bare = bareModelId(key);

    if (remove) {
      const existing = findOverrideEntry(overrides, key);
      if (!existing) {
        return JSON.stringify({ ok: true, removed: false, key, message: `「${bare}」本就没有覆盖价，无需清除。` });
      }
      delete overrides[existing.key];
      await writeSettingsToFile(s);
      invalidatePriceOverrides();
      return JSON.stringify({
        ok: true,
        removed: true,
        key: existing.key,
        message: `已清除「${bare}」的覆盖价，此后回退内置价格表（内置表也无 → 未定价）。`,
      }, null, 2);
    }

    // 同名不同 key 的旧条目一并清理，避免双条歧义
    const dup = findOverrideEntry(overrides, key);
    if (dup && dup.key !== key) delete overrides[dup.key];
    const prev = overrides[key] ?? null;

    overrides[key] = {
      input,
      output,
      ...(cacheHit != null ? { cacheHit } : {}),
      ...(offPeak != null ? { offPeak } : {}),
      ...(currency ? { currency } : {}),
      ...(note ? { note } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeSettingsToFile(s);
    invalidatePriceOverrides();

    // 提示：该模型既不在模型池里、也不在内置价格表中（可能是尚未接入的新模型）
    let warning: string | undefined;
    const inPool = (s.providers ?? []).some((p) => (p.selectedModels ?? []).some((m) => m.modelId === bare));
    if (!inPool) {
      const { PROVIDER_PRESETS } = await import('@/lib/providers/presets');
      const inPreset = PROVIDER_PRESETS.some((p) => p.models.some((m) => m.modelId === bare));
      if (!inPreset) warning = `注意：模型「${bare}」当前不在已配置模型池、也不在内置价格表中。单价已保存，待该模型接入并产生用量后即按此价计费。`;
    }

    return JSON.stringify({
      ok: true,
      key,
      model: bare,
      price: overrides[key],
      previous: prev,
      ...(warning ? { warning } : {}),
      message: `已更新「${bare}」单价：input ${input} / output ${output} ${currency ?? 'usd'} 每百万 token${offPeak != null ? `，空闲时段 ×${offPeak}` : ''}。此后产生的用量按新价估算成本；历史记录不变。`,
    }, null, 2);
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      hint: '若提示 version 相关错误，说明 .settings.json 版本缺失或被破坏（防覆盖保护），需先在设置界面正常保存一次。',
    }, null, 2);
  }
}

/**
 * create_project 工具执行器：新建一个 BobWork 项目（落盘目录结构 + 写入全局项目配置）。
 * 语义边界（与 Butler 定位一致）：**应用级写动作，只创建、不切换**当前项目——
 * 新项目出现在侧边栏，是否进入由用户在界面决定（Butler 无切换项目工具）。
 * 完成后广播 projects-changed，让侧边栏 SSE 即时刷新出新项目。
 */
async function toolCreateProject(args: Record<string, unknown>): Promise<string> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return JSON.stringify({
      ok: false,
      error: 'name is required',
      hint: '项目名缺失：先向用户确认名称，再调用本工具（不要自行编造名称）。',
    }, null, 2);
  }
  try {
    const makeCurrent = args.make_current === true;
    const project = await createProject(name, { makeCurrent });
    emitProjectsChanged();
    return JSON.stringify({
      ok: true,
      id: project.id,
      name: project.name,
      path: project.path,
      is_current: makeCurrent,
      message: makeCurrent
        ? `已新建项目「${project.name}」（id: ${project.id}），并已切换为当前项目——紧接着不点名项目的写入会落在这里。`
        : `已新建项目「${project.name}」（id: ${project.id}）。当前项目未切换——要往里面写待办/便签，请把 project 传成「${project.name}」或它的 id；或让用户在左侧项目列表点击进入。`,
    }, null, 2);
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }, null, 2);
  }
}

/** butler 场景工具定义（由 tools/index.ts 聚合进 toolDefs） */
export const butlerToolDefs: Tool[] = [
  {
    name: 'read_todo',
    description: 'Read Butler todo records of the current project: recent tasks, by category (会议/开发/文档/学习/沟通/生活/规划/其他), or today\'s schedule. Filter by time range (today/week/all) and category.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['today', 'week', 'all'],
          description: 'Time filter: "today" for today\'s tasks, "week" for recent 7 days, "all" for everything (default).',
        },
        category: {
          type: 'string',
          description: 'Category filter: 会议(meetings), 开发(development), 文档(documentation), 学习(learning), 沟通(communication), 生活(life), 规划(planning), 其他(other). Leave empty for all categories.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadTodo,
    maxOutput: 5000,
  },
  {
    name: 'remember_preference',
    description: 'Record a user memory into the unified long-term memory (butler/preferences.md), shared by every contact — it remembers the USER, not the assistant. Act on your own: whenever a durable fact or preference surfaces (how the user wants things done, who they are, ongoing projects, stable facts, goals, relationship boundaries), record it WITHOUT asking first — the user reviews and can edit/delete later. Do NOT record ordinary or transient chat content, the assistant\'s own output, or anything the user asked to keep out. Before writing, call read_preferences to check for a duplicate or contradictory entry in the same category: if it already exists, do not add again; if the new fact supersedes an existing one, call update_preference to overwrite it instead of appending a second conflicting entry. Also merge rather than proliferate: if an existing entry already speaks to the SAME point in different words, call update_preference to fold the new detail into it (one entry per point) instead of opening a second entry. The store enforces this too: an entry too textually similar to an existing one in the same category is rejected (returned as a conflict with the existing index) — then call update_preference(index) to overwrite, or rephrase only if it is genuinely a different fact. NEVER record secrets/credentials — the store is plain-text Markdown injected every turn; refuse passwords, keys, tokens, ID/passport/bank-card numbers. content = one fact in one sentence (one fact per call, do not bundle); type = one of the six categories 身份画像 / 偏好习惯 / 工作上下文 / 事实经历 / 目标计划 / 关系边界, default 通用.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'One fact in one sentence, e.g. "用户习惯用表格输出" or "引用法条必须标注时效性". Required. Keep one fact per call — do not bundle several facts into one entry.',
        },
        type: {
          type: 'string',
          description: 'Category — pick one of the six: 身份画像 (who the user is: name/role/city) / 偏好习惯 (how the user wants things done) / 工作上下文 (ongoing projects, terms, tools) / 事实经历 (stable facts, past decisions) / 目标计划 (goals, deadlines) / 关系边界 (people involved, privacy limits). Omit to default to 通用. 身份画像 and 偏好习惯 are injected into every turn — reserve them for few, high-value facts.',
        },
      },
      required: ['content'],
    },
    category: '记忆',
    execute: toolRememberPreference,
    maxOutput: 2000,
  },
  {
    name: 'read_preferences',
    description: 'List recorded user memories (unified long-term memory, butler/preferences.md, shared by every contact) with index/type/created_at. Use when the user asks "我有哪些偏好" / "你记住了我什么", or before remember_preference to check for a duplicate/contradictory entry, or before delete_preference / update_preference to see valid indexes. Optional type filter lists only that category. Note: 身份画像 and 偏好习惯 are already injected into every turn — read this to fetch the other four categories in full.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Optional: only list memories of this type/category, one of 身份画像 / 偏好习惯 / 工作上下文 / 事实经历 / 目标计划 / 关系边界. Omit to list all.',
        },
      },
      required: [],
    },
    category: '记忆',
    execute: toolReadPreferences,
    maxOutput: 4000,
  },
  {
    name: 'delete_preference',
    description: 'Delete one recorded user memory by its index (manual forgetting, unified memory butler/preferences.md). Use read_preferences first to see valid indexes. The user decides what to forget; do not auto-delete.',
    parameters: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'Memory index (1-based), as shown by read_preferences. Required.',
        },
      },
      required: ['index'],
    },
    category: '记忆',
    execute: toolDeletePreference,
    maxOutput: 2000,
  },
  {
    name: 'update_preference',
    description: 'Atomically update one recorded user memory by its index (unified memory butler/preferences.md). Use when the user asks to change a remembered fact, e.g. "把第 2 条改成…" or "第 1 条的类型改成工作上下文". Only update the fields provided (content and/or type); created_at/source are preserved. Use read_preferences first to see valid indexes and current values.',
    parameters: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'Memory index (1-based), as shown by read_preferences. Required.',
        },
        content: {
          type: 'string',
          description: 'New one-sentence memory content. Optional if type is provided.',
        },
        type: {
          type: 'string',
          description: 'New category, one of 身份画像 / 偏好习惯 / 工作上下文 / 事实经历 / 目标计划 / 关系边界. Optional if content is provided.',
        },
      },
      required: ['index'],
    },
    category: '记忆',
    execute: toolUpdatePreference,
    maxOutput: 2000,
  },
  {
    name: 'resolve_datetime',
    description:
      'Deterministically turn a natural-language time phrase (Chinese or English) into concrete date/time values. ALWAYS call this FIRST, before create_scheduled_todo / todo_update / plan_schedule, whenever the user expressed a time in words ("下周五下午3点" / "明天上午" / "10分钟后" / "tomorrow 3pm") — never compute or guess the date yourself (LLMs get relative dates wrong). Returns date (YYYY-MM-DD), time (HH:MM local, or null when the phrase has no clock time), start_time (UTC ISO, pass it straight into the other tools), weekday, all_day_hint, and topic (the phrase with the time part stripped, usable as the title). ok=false means no time expression was found — ask the user for a concrete time instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The user\'s time phrase, verbatim (e.g. "下周五下午3点").',
        },
        reference: {
          type: 'string',
          description: 'Optional ISO "now" used as the base for relative phrases ("10分钟后"). Defaults to the current time.',
        },
      },
      required: ['text'],
    },
    category: '系统',
    execute: toolResolveDatetime,
    maxOutput: 1000,
  },
  {
    name: 'query_free_slots',
    description:
      'Find free slots in the user\'s calendar (deterministic free/busy). Use it when the user asks WHEN they are free ("我明天什么时候有空" / "这周找个一小时的空" / "what is a good time on Thursday") or wants an appointment time picked. Resolve any natural-language range with resolve_datetime first, then pass range_start / range_end as ISO instants — widen range_end to the END of the day or week you are searching, and set duration_minutes to the length needed. Returns free[] (each already carries a ready-to-show label like "明天 14:00–15:00") plus busy[]. Do NOT work out free time yourself — read it from free[]. If free is empty, say so plainly and offer to widen the window or working hours.',
    parameters: {
      type: 'object',
      properties: {
        range_start: { type: 'string', description: 'ISO instant — start of the search window.' },
        range_end: { type: 'string', description: 'ISO instant — end of the search window (widen to cover the whole day/week, not just the requested instant).' },
        duration_minutes: { type: 'number', description: 'Length of the needed free slot in minutes (default 60).' },
        work_start_hour: { type: 'number', description: 'Earliest hour of day to consider (0-23, default 9).' },
        work_end_hour: { type: 'number', description: 'Latest hour of day to consider, exclusive (0-23, default 18).' },
        limit: { type: 'number', description: 'Max number of slots to return (default 5).' },
      },
      required: ['range_start', 'range_end'],
    },
    category: '系统',
    execute: toolQueryFreeSlots,
    maxOutput: 1200,
  },
  {
    name: 'query_schedule',
    description:
      'Query the user schedule/calendar events (cross-project calendar DB) in a time window. Use it when the user asks to see the schedule, asks for an arrangement proposal, or when several candidate slots must be compared — writing a todo does NOT require it: create_scheduled_todo checks the target slot for conflicts itself. Returns scheduled (optionally done/cancelled) events sorted by start, plus open untimed checklist items. Prefer over read_todo for schedule/conflict questions.',
    parameters: {
      type: 'object',
      properties: {
        range_start: {
          type: 'string',
          description: 'Optional ISO start boundary (e.g. 2026-09-03T00:00:00+08:00). Defaults to now.',
        },
        range_end: {
          type: 'string',
          description: 'Optional ISO end boundary. Defaults to range_start + days.',
        },
        days: {
          type: 'number',
          description: 'How many days ahead from now/range_start to scan (default 14, max 120).',
        },
        status: {
          type: 'string',
          enum: ['scheduled', 'done', 'cancelled'],
          description: 'Optional status filter. Default: scheduled only.',
        },
        project_id: {
          type: 'string',
          description: 'Optional project id to restrict results (default: all projects incl. global items).',
        },
      },
      required: [],
    },
    category: '系统',
    execute: toolQuerySchedule,
    maxOutput: 5000,
  },
  {
    name: 'create_scheduled_todo',
    description:
      'Put a todo INTO the calendar at an explicit time. Note sticky rows already auto-enter the calendar when the note is settled, so this tool is for cases a) the row is still unscheduled (freshly written by create_sticky_note, not settled yet) or b) the user wants a precise time instead of the auto-assigned default slot. Writes a calendar event and links it to a `- [ ]` sticky line — if the project already has an identical unscheduled sticky line it binds that one (no duplicate); otherwise it appends one (calendar-only at the 3-todo-sticky cap). Ticking either side syncs. IMPORTANT: to MOVE an existing todo to a new time use todo_update (query_todos first for its event_id) — re-creating it here appends a duplicate line and a duplicate event; when the same-text row is already calendared this tool refuses and tells you to use todo_update. title/start_time/end_time/all_day/reminder_minutes define the event; description goes into its notes. TITLE vs NOTES: title is a SHORT action summary (it also becomes the sticky note line text) — the user\'s ORIGINAL wording, its source (who sent it / which message / what the image said) and background details go into `description`, verbatim; never append them to the title. REMINDERS: translate the lead time the user states literally into reminder_minutes ("提前5分钟提醒我" → [5], "提前半小时" → [30], "提前一天" → [1440]); A reminder is NEVER expressed by moving start_time earlier. TIME: when the user gave the time in words ("下周五下午3点" / "tomorrow 3pm" / "10分钟后"), call resolve_datetime FIRST and pass its start_time/date through — never compute or guess the date yourself. RECURRING: when the user wants a REPEATING reminder/schedule ("每天9点提醒我…"/"每周三…"), pass recurrence="daily"/"weekly" (start_time supplies the time-of-day / weekday; if that time already passed today, set start_time to the NEXT occurrence). RECURRENCE IS EXPANDED BY THE SCANNER AT RUNTIME — the stored start_time stays the first occurrence. start_time IS VALIDATED: omit it and nothing is written (need_more_info + a suggested slot) — ask the user for a time in one sentence instead of assuming one; an unparseable value → invalid_time; a time already in the past → past_time (use force=true only for back-filling history the user really wants). TARGET PROJECT: pass `project` whenever the conversation already points at a project — the user named one, or you created it yourself with create_project earlier in this same conversation (then pass its base name, e.g. "余靖潘案", or the id create_project returned). Pass "current" when the user explicitly said "current project"/"这个项目". Omit only when the conversation has no project context at all — the event then goes to the currently active project automatically (or to the global calendar when no project is active). Do NOT ask the user which project to use and never invent a project name; but a project you just created is not an invention — route the todo into it explicitly rather than letting it fall back to the current project. WRITE IS VERIFIED AND ECHOED: the result carries project_id / project_source, and the event is read back from the DB before returning — a mismatch fails with write_verification_failed (never ignore it). When project_source=current_fallback the event went to the CURRENT project because you passed no project, and a `warning` says so: if that is not where the user meant it, fix it with todo_update (query_todos first for event_id) instead of creating another event. CONFLICT CHECK IS BUILT IN: this tool itself scans the slot for overlaps (level=hard) and for potential clashes (level=potential: less than 15 min after the previous event ends, a neighbouring event at a different location needing travel, or an all-day event the same day) and returns conflict_level / conflicts / risks / alternatives BEFORE writing. So do not pre-report the plan: call it as soon as the user asked for the arrangement. level=none → written; reply in ONE short sentence (item + absolute time + target project) — do not restate the proposal and do not ask "shall I arrange it". level=hard or potential → nothing was written; state the clash and the free slots in one or two sentences and let the user pick; if the user explicitly insists on the same slot anyway, call again with force=true to write it. Keep every reply short — the point is to confirm rigorously before writing, not to write long prose.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short action summary, e.g. "处理余靖潘案反诉事宜" (ideally under ~20 chars; it also becomes the sticky note line text). Do NOT append the source, background or parenthetical supplements here — put the user\'s original wording and context into `description` instead.',
        },
        project: {
          type: 'string',
          description: 'Target project: the project name or id. Pass it whenever the conversation already points at a project — the user named one, or YOU created it with create_project earlier in this same conversation (then pass its base name, e.g. "余靖潘案", or the id create_project returned). Pass "current" ONLY if the user explicitly said "current project"/"这个项目". Omit ONLY when the conversation has no project context at all — the event then goes to the currently active project automatically (or to the global calendar when no project is active). Never invent a project name; but a project you just created is not an invention — route the todo into it explicitly instead of silently defaulting.',
        },
        start_time: {
          type: 'string',
          description: 'Optional ISO start time (e.g. 2026-09-03T15:00:00+08:00).',
        },
        end_time: {
          type: 'string',
          description: 'Optional ISO end time.',
        },
        all_day: {
          type: 'boolean',
          description: 'All-day event (default false).',
        },
        due_at: {
          type: 'string',
          description: 'Optional deadline (local ISO). Distinct from start_time: start_time is the execution block, due_at is the "must be finished by" deadline. The scheduler treats it as a hard constraint.',
        },
        estimated_minutes: {
          type: 'number',
          description: 'Optional estimate in minutes. When end_time is omitted the execution block length is derived from it (otherwise 1 hour).',
        },
        block_locked: {
          type: 'boolean',
          description: 'Set true only when the user pinned this exact slot and it must not be moved by the auto-scheduler. Default false.',
        },
        reminder_minutes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Reminder lead minutes before start_time, e.g. [30, 1440]. Default [30]. Pass [] to disable reminders. Map the user\'s words literally: "提前5分钟提醒我"/"5 分钟前叫我" → [5]; "提前半小时" → [30]; "提前一天" → [1440]. A reminder does NOT change start_time — never move start_time earlier to express a reminder.',
        },
        recurrence: {
          type: 'string',
          enum: ['none', 'daily', 'weekly'],
          description: 'Repeating reminder/event. "daily" = every day at the start_time\'s time-of-day; "weekly" = every week on the start_time\'s weekday. Use it when the user asks for a RECURRING reminder ("每天9点提醒我…"/"每周一开周会"/"every morning"). "none"/omitted = one-off. When a recurring time has ALREADY passed today, set start_time to the NEXT occurrence (today if still ahead, otherwise tomorrow) so the series starts correctly. A recurring item is conflict-checked on its first occurrence only; if it clashes, tell the user and pass force=true only after they insist.',
        },
        recurrence_until: {
          type: 'string',
          description: 'Optional end date for a recurrence (ISO or YYYY-MM-DD; that day is included). Omit for an open-ended repeat. Only meaningful together with recurrence=daily/weekly.',
        },
        recurrence_interval: {
          type: 'number',
          description: 'Repeat every N periods: with recurrence=daily → every N days; with recurrence=weekly → every N weeks (e.g. "每两周" → 2). Omit or 1 = every period.',
        },
        recurrence_byday: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which weekdays the series hits, e.g. ["mon","wed"] or ["mon","tue","wed","thu","fri"]. Weekday names (mon..sun) or numbers (0=Sun..6=Sat). Omit = daily hits every day / weekly hits the start_time weekday. Use for "每周一和周三" / "工作日每天".',
        },
        recurrence_count: {
          type: 'number',
          description: 'Total number of occurrences including the first (e.g. "重复 5 次" → 5). Omit for an open-ended repeat. When both count and recurrence_until are given, count wins.',
        },
        description: {
          type: 'string',
          description: 'Notes/details stored on the calendar event. This is where the user\'s ORIGINAL wording goes — verbatim: their words, its source (who sent it / which message / what the image said) and any background detail. Do not paraphrase, trim or drop it, and never pack this content into `title` (the title stays a short summary).',
        },
        location: {
          type: 'string',
          description: 'Optional place of the event when the user mentioned one (room, office, online meeting). Used to flag a potential clash with a neighbouring event at a different place.',
        },
        force: {
          type: 'boolean',
          description: 'Write even if the slot has a conflict / potential clash, or if the time is already in the past (back-filling history). Pass true ONLY after the user was told the risk and explicitly insisted on this exact time. Default false.',
        },
      },
      required: ['title'],
    },
    category: '文件',
    execute: toolCreateScheduledTodo,
    maxOutput: 1500,
  },
  {
    name: 'plan_schedule',
    description:
      'Run the deterministic scheduler: it takes tasks that have a deadline (due_at) or an estimate (estimated_minutes) but no execution block yet, and places each one into a free slot inside working hours (no overlap with existing events, finishes before its deadline, honours user-pinned blocks). Writes start/end back to those tasks. Use when the user says "帮我安排一下 / 排个计划 / plan my week" and tasks exist without times. Pass dry_run=true to preview without writing. Report the placed blocks and any task it could not place (ask the user to relax the deadline or add an estimate).',
    parameters: {
      type: 'object',
      properties: {
        horizon_days: {
          type: 'number',
          description: 'How many days ahead to look for slots (default 14, max 120).',
        },
        dry_run: {
          type: 'boolean',
          description: 'true = compute and report the plan without writing anything. Default false.',
        },
      },
      required: [],
    },
    category: '系统',
    execute: toolPlanSchedule,
    maxOutput: 4000,
  },
  {
    name: 'query_schedule_status',
    description:
      'Read-only: report whether the auto-schedule plan is up to date ("ok" = current, "stale" = something changed and a replan is pending), plus how many tasks already have a block and which tasks are still waiting for a slot. Use when the user asks "计划是最新的吗 / 还有哪些没排上 / is my plan up to date". Changing any task or event marks the plan stale; it is recomputed automatically within seconds, or immediately via plan_schedule.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    category: '系统',
    execute: toolQueryScheduleStatus,
    maxOutput: 1500,
  },
  {
    name: 'query_todos',
    description:
      'Query TODOs/tasks. Default view = calendar events like /todo check, with free-form semantic queries: time ranges ("today"/"this week"/"tomorrow"/"next Monday"), status keywords ("overdue"/"done"), content keywords, empty = today; reads the shared calendar-events database (project todos + global untimed items). Set view="sticky" (like /inspect) to instead list unfinished sticky-note todos grouped project → note → page, completed items excluded. For schedule-window conflict checks prefer query_schedule.',
    parameters: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['schedule', 'sticky'], description: 'Optional. "schedule" (default) = calendar events/todos; "sticky" = unfinished sticky-note todos (project → note → page), like /inspect.' },
        query: { type: 'string', description: 'Optional natural-language query for view=schedule (e.g. "今天" / "下周" / "逾期未完成" / "上周做完的"; empty = today), or fuzzy filter keywords for view=sticky (e.g. "合同 报价"; multiple keywords match any one).' },
        scope: { type: 'string', enum: ['all', 'project', 'global'], description: 'Optional scope. Default all. For view=sticky: "all" scans all active projects, otherwise the current project.' },
      },
      required: [],
    },
    category: '系统',
    execute: toolQueryTodos,
    maxOutput: 5000,
  },
  {
    name: 'todo_update',
    description:
      'Update an existing todo/event by its event_id (from query_todos): change title, start/end time, all_day, status (done/scheduled), priority, color, location, description, reminder_minutes, recurrence. When the new time was given in words, resolve it with resolve_datetime first and pass its start_time — never compute the date yourself. Changes propagate two-way: calendar updates; a sticky-note-sourced line syncs too. Use recurrence="daily"/"weekly" to make a todo repeat (e.g. turn an existing item into a daily reminder), or recurrence="none" to stop it repeating.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id (from query_todos output).' },
        title: { type: 'string', description: 'New title / todo text. Keep it a SHORT action summary (no source, background or parenthetical supplements; it also becomes the sticky note line text) — the user\'s original wording and context belong in `description`.' },
        start_time: { type: 'string', description: 'New start time (local ISO, e.g. 2026-09-04T09:00:00+08:00).' },
        end_time: { type: 'string', description: 'New end time (local ISO).' },
        all_day: { type: 'boolean', description: 'All-day flag.' },
        status: { type: 'string', enum: ['scheduled', 'done'], description: "done = complete the todo, scheduled = re-open it. Use todo_delete to remove entirely (not 'cancelled')." },
        priority: { type: 'string', enum: ['high', 'normal', 'low'] },
        color: { type: 'string', description: 'Event color hex, e.g. #F59E0B.' },
        location: { type: 'string' },
        description: { type: 'string', description: 'New notes text on the event. Use it for the user\'s ORIGINAL wording, its source and background details — never for the title.' },
        due_at: { type: 'string', description: 'New deadline (local ISO). Empty string clears it.' },
        estimated_minutes: { type: 'number', description: 'New estimate in minutes.' },
        block_locked: { type: 'boolean', description: 'true = pin this slot so the auto-scheduler will not move it.' },
        reminder_minutes: { type: 'array', items: { type: 'number' }, description: 'Reminder lead minutes, e.g. [30]. Pass [] to disable.' },
        recurrence: {
          type: 'string',
          enum: ['none', 'daily', 'weekly'],
          description: 'Repeat rule: "daily" = every day at the current start time; "weekly" = every week on the current weekday. "none" = stop repeating (clears it). Omit to leave the current setting unchanged.',
        },
        recurrence_until: {
          type: 'string',
          description: 'Optional end date for the recurrence (ISO or YYYY-MM-DD; that day is included). Omit for open-ended. Only with recurrence=daily/weekly.',
        },
        recurrence_interval: {
          type: 'number',
          description: 'Repeat every N periods (daily → every N days; weekly → every N weeks). Omit or 1 = every period.',
        },
        recurrence_byday: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which weekdays the series hits, e.g. ["mon","wed"] (names mon..sun or numbers 0=Sun..6=Sat). Omit = daily every day / weekly the start_time weekday.',
        },
        recurrence_count: {
          type: 'number',
          description: 'Total occurrences including the first. Omit for open-ended. Wins over recurrence_until when both are given.',
        },
      },
      required: ['event_id'],
    },
    category: '系统',
    execute: toolTodoUpdate,
    maxOutput: 800,
  },
  {
    name: 'todo_delete',
    description:
      'Delete a todo/event by its event_id (soft delete: status → cancelled; external calendars see CANCELLED). Sticky-note-sourced lines are removed too (two-way). Get the id from query_todos. Only when the user clearly asks to remove a todo.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id (from query_todos output).' },
        hard: { type: 'boolean', description: 'Hard delete (physically remove row) instead of soft cancel. Default false.' },
      },
      required: ['event_id'],
    },
    category: '系统',
    execute: toolTodoDelete,
    maxOutput: 600,
  },
  {
    name: 'create_sticky_note',
    description: 'Create a sticky note on the canvas (project-private). Use for a produced plan/checklist/reminder the user wants saved as a sticky (e.g. a legal work plan split into phases). Lines DO auto-enter the calendar once the user settles the note: a line with a concrete time is scheduled to that time, otherwise it takes a near-term default slot. Until that settlement they show up in to-do queries as "not scheduled" — which means "not settled yet", not "will never be scheduled". Written silently to the project sticky-notes.json; canvas refreshes automatically (no confirm dialog). Sticky notes are private — after creation never read back or modify them via file tools. Position is auto-assigned on a cascade; do not try to control it. Max 3 todo stickies per project: at the cap, creation is skipped and an existing note is returned. TARGET PROJECT: pass `project` when the user named a project in this conversation (name or id), or "current" when the user explicitly said "current project"/"这个项目". If the user did NOT mention any project, omit it — the tool falls back to the current active project and reports the landing point (project_source); only rely on that when the sticky is clearly meant for the active project, and never guess a different one.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Sticky note body. For a plan, use one line per task/checklist item, each line starting with "- [ ] " (e.g. "- [ ] 收集证据材料"). Each line must be a SHORT action summary — a line becomes that todo\'s calendar TITLE (and the note\'s visible text), so never pack the user\'s original wording, sender/source or background into a line. The sticky has no notes field: if raw context has to be preserved, schedule that item with create_scheduled_todo instead and put the context in its `description`.',
        },
        title: {
          type: 'string',
          description: 'Optional note title (defaults to the project name, no auto date suffix). e.g. "借款纠纷诉讼计划".',
        },
        project: {
          type: 'string',
          description: 'Target project: project name or id, exactly as named by the user, or "current" when the user explicitly said "current project"/"这个项目". Omit ONLY when the user did not mention any project — the tool then falls back to the CURRENT active project and reports where it landed (project_source); if that was not what the user meant, re-run with an explicit project instead of duplicating. Never guess a different project.',
        },
        color: {
          type: 'string',
          description: 'Note color: yellow | blue | green | pink. If the color is already used by an existing note in the project, an unused color is auto-assigned so notes stay visually distinct.',
        },
      },
      required: ['content'],
    },
    category: '文件',
    execute: toolCreateStickyNote,
    maxOutput: 1000,
  },
  {
    name: 'create_project',
    description:
      'Create a new BobWork project (folder + global project config) by name. The project shows up in the sidebar. By default the CURRENT project is NOT switched — then, if the same request also has to write into the new project (a todo, a sticky note, a plan), either create it with make_current=true so it becomes the active project, or pass `project` explicitly on the follow-up write tool (base name or the returned id). Use ONLY when the user clearly asks to create/start a new project; if the name is missing, ask for it first, never guess. Creating a project is a direct low-risk action: do NOT propose-then-wait-for-confirmation — just create it and report the result.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Project name (display name; a _YYYYMMDD suffix is appended automatically). Required.',
        },
        make_current: {
          type: 'boolean',
          description: 'Set true when this same request continues by writing into the new project (e.g. "建个项目，把这件事排上") — the new project then becomes the current project so follow-up writes land in it. Leave false/omit when the user only asked to create the project.',
        },
      },
      required: ['name'],
    },
    category: '系统',
    execute: toolCreateProject,
    maxOutput: 500,
  },
  {
    name: 'project_plan_start',
    description:
      'Start a persistent project plan (plan tree) in .butler/plans.json: milestones → steps; returns its id. Pass title/goal and either a flat "steps" list or structured "milestones" [{title, steps}]. Track afterwards with project_plan_view / project_plan_add_steps / project_plan_step_status. TARGET PROJECT: pass `project` when the user named a project (name or id), or "current" when they explicitly said "current project"/"这个项目". If the user did not mention any project, omit it — the tool falls back to the current active project and reports the landing point (project_source); only rely on that when the write is clearly meant for the active project, and never guess a different one.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Target project: project name or id, exactly as named by the user, or "current" when the user explicitly said "current project"/"这个项目". Omit ONLY when the user did not mention any project — the tool then falls back to the CURRENT active project and reports where it landed (project_source); if that was not what the user meant, re-run with an explicit project instead of duplicating. Never guess a different project.',
        },
        title: { type: 'string', description: 'Plan title, e.g. "借款纠纷诉讼计划".' },
        goal: { type: 'string', description: 'Optional one-line goal / deliverable statement.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Optional flat step list (used when there are no milestones).' },
        milestones: { type: 'array', description: 'Optional milestones; each { title: string, steps: string[] }.', items: { type: 'object', properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } } },
      },
      required: ['title'],
    },
    category: '系统',
    execute: toolProjectPlanStart,
    maxOutput: 1200,
  },
  {
    name: 'project_plan_view',
    description:
      'Read back the project plan tree(s): no plan_id → list all plans (title/status/progress); with plan_id → full milestones/steps with ids and statuses. Call before updating so you address steps by their real ids. TARGET PROJECT: pass `project` when the user named a project (name or id), or "current" when they explicitly said "current project"/"这个项目". If the user did not mention any project, omit it — the tool falls back to the current active project and reports the landing point (project_source); only rely on that when the write is clearly meant for the active project, and never guess a different one.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Target project: project name or id, exactly as named by the user, or "current" when the user explicitly said "current project"/"这个项目". Omit ONLY when the user did not mention any project — the tool then falls back to the CURRENT active project and reports where it landed (project_source); if that was not what the user meant, re-run with an explicit project instead of duplicating. Never guess a different project.',
        },
        plan_id: { type: 'string', description: 'Optional plan id.' },
      },
      required: [],
    },
    category: '系统',
    execute: toolProjectPlanView,
    maxOutput: 5000,
  },
  {
    name: 'project_plan_add_steps',
    description:
      'Append steps to a plan. Default target = the first (or only) milestone; pass milestone_id (from project_plan_view) for a specific one, or milestone_title to create/find a milestone by title. TARGET PROJECT: pass `project` when the user named a project (name or id), or "current" when they explicitly said "current project"/"这个项目". If the user did not mention any project, omit it — the tool falls back to the current active project and reports the landing point (project_source); only rely on that when the write is clearly meant for the active project, and never guess a different one.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Target project: project name or id, exactly as named by the user, or "current" when the user explicitly said "current project"/"这个项目". Omit ONLY when the user did not mention any project — the tool then falls back to the CURRENT active project and reports where it landed (project_source); if that was not what the user meant, re-run with an explicit project instead of duplicating. Never guess a different project.',
        },
        plan_id: { type: 'string', description: 'Plan id.' },
        milestone_id: { type: 'string', description: 'Optional milestone id to append to.' },
        milestone_title: { type: 'string', description: 'Optional milestone title; if no milestone matches (and milestone_id empty), a milestone with this title is created.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Steps to append.' },
      },
      required: ['plan_id', 'steps'],
    },
    category: '系统',
    execute: toolProjectPlanAddSteps,
    maxOutput: 1000,
  },
  {
    name: 'project_plan_step_status',
    description:
      'Advance one step in the plan state machine: pending → in_progress → done; blocked (with reason) → pending/in_progress. Milestone/plan completion derive automatically from steps. Call when a step starts, finishes, or blocks. TARGET PROJECT: pass `project` when the user named a project (name or id), or "current" when they explicitly said "current project"/"这个项目". If the user did not mention any project, omit it — the tool falls back to the current active project and reports the landing point (project_source); only rely on that when the write is clearly meant for the active project, and never guess a different one.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Target project: project name or id, exactly as named by the user, or "current" when the user explicitly said "current project"/"这个项目". Omit ONLY when the user did not mention any project — the tool then falls back to the CURRENT active project and reports where it landed (project_source); if that was not what the user meant, re-run with an explicit project instead of duplicating. Never guess a different project.',
        },
        plan_id: { type: 'string', description: 'Plan id.' },
        step_id: { type: 'string', description: 'Step id (from project_plan_view).' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'New step status.' },
        note: { type: 'string', description: 'Optional note (esp. reason when blocked).' },
      },
      required: ['plan_id', 'step_id', 'status'],
    },
    category: '系统',
    execute: toolProjectPlanStepStatus,
    maxOutput: 800,
  },
  {
    name: 'get_model_price',
    description:
      'Read the effective billing price of a model (per 1M tokens): a user override (.settings.json priceOverrides, maintained via set_model_price) takes precedence over the built-in price table; if neither has it, the model is "unpriced" and its cost is recorded as NULL. Pass model ("provider:modelId" or bare modelId) to query one model; omit model to list all user overrides plus every configured model with its current price — use that to spot configured-but-unpriced models. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Optional model reference, e.g. "deepseek:deepseek-v4-flash" or bare "deepseek-v4-flash". Omit to list all overrides and configured models.',
        },
      },
      required: [],
    },
    category: '配置',
    execute: toolGetModelPrice,
    maxOutput: 5000,
  },
  {
    name: 'set_model_price',
    description:
      'Set or update the user override price of a model (per 1M tokens). Use when a vendor changes prices, or when a NEW model is added that the built-in price table does not know. Writes .settings.json priceOverrides; takes effect immediately for usage recorded afterwards (historical records are NOT rewritten). Provide input (cache-miss input price) and output price; optional cacheHit (cache-read price, default input × 0.25), offPeak (idle-hour multiplier e.g. 0.5), currency (usd default | cny), note (source/basis for later reconciliation). Pass remove=true to clear an override and fall back to the built-in table. CRITICAL: never invent or guess prices — only call with numbers the user explicitly gave, or that you verified from the vendor\'s official page; if a number is missing or uncertain, ASK the user first.',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model reference: "provider:modelId" or bare modelId (auto-prefixed with the configured provider when found). Required.',
        },
        input: {
          type: 'number',
          description: 'Cache-miss input price per 1M tokens. Required unless remove=true.',
        },
        output: {
          type: 'number',
          description: 'Output price per 1M tokens. Required unless remove=true.',
        },
        cacheHit: {
          type: 'number',
          description: 'Optional cache-read (cache-hit) price per 1M tokens. Omitted → input × 0.25.',
        },
        offPeak: {
          type: 'number',
          description: 'Optional idle-hour discount multiplier, e.g. 0.5 for off-peak half price. Omit for flat pricing.',
        },
        currency: {
          type: 'string',
          enum: ['usd', 'cny'],
          description: 'Billing currency. Default usd.',
        },
        note: {
          type: 'string',
          description: 'Optional note, e.g. vendor page URL / effective date, for later reconciliation.',
        },
        remove: {
          type: 'boolean',
          description: 'Clear the override and fall back to the built-in price table. Default false.',
        },
      },
      required: ['model'],
    },
    category: '配置',
    execute: toolSetModelPrice,
    maxOutput: 1500,
  },
  // ---- 规则原语（v6 §5.1：用户发起即免确认；Phase 0 只固化与可见，不自动执行）----
  {
    name: 'read_rules',
    description: 'List the user\'s standing rules/flows (stored globally under butler/.rules/, scope expressed by the `scope` field). Each line shows id, name, kind (规则/流程), status, commitment, trigger keywords and scope. Call this BEFORE rule_update / rule_pause / rule_retire to get valid ids — they take an id, not a name. Note: preferences (倾向) live in MEMORY (read_preferences), NOT here; rules are hard constraints ("每次必须 / 不要").',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'active', 'paused', 'retired'],
          description: 'Optional: only list rules in this status. Omit to list all.',
        },
      },
      required: [],
    },
    category: '记忆',
    execute: toolReadRules,
    maxOutput: 4000,
  },
  {
    name: 'rule_create',
    description: 'Create a standing rule/flow from what the user just told you — for HARD constraints ("以后每次都要…" / "不要…" / "禁止…"), i.e. something with no middle ground. Do NOT use this for preferences/tendencies ("我不太喜欢很长的回复") — those go to remember_preference. Always keep intent_raw as the USER\'S ORIGINAL WORDS (do not paraphrase). Every step MUST carry a kind: "deterministic" (the host can do it exactly — no model judgment) or "judgment" (needs model judgment; set annex=true only for an accessory refinement of an otherwise deterministic rule). The server derives commitment from the steps and returns it: all-deterministic → 必做到; accessory judgment only → 基本做到; a primary judgment step → 会启动并尽力 and the rule is classified as a 流程 (flow). When a rule matches, deterministic steps run on the host and judgment steps are executed by you (the model); a flow does NOT run silently — after it fires, tell the user the commitment level.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short human-readable rule name, e.g. "回复不要用感叹号". Required.',
        },
        intent_raw: {
          type: 'string',
          description: 'The user\'s ORIGINAL wording / intent — kept verbatim, never paraphrase. Required.',
        },
        steps: {
          type: 'array',
          description: 'Ordered action steps. Each item: { kind: "deterministic"|"judgment", text: string, annex?: boolean, action?: "create_todo"|"create_scheduled_todo", action_params?: { when: string } }. kind is required on every step. Required (at least one).',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['deterministic', 'judgment'],
                description: 'deterministic = host executes exactly, no model judgment; judgment = needs model judgment.',
              },
              text: { type: 'string', description: 'One concrete step, e.g. "回复中不使用感叹号".' },
              annex: { type: 'boolean', description: 'Only for kind=judgment: true = an accessory refinement of an otherwise deterministic rule (→ 基本做到). Default false = a primary judgment step (→ flow).' },
              action: { type: 'string', enum: ['create_todo', 'create_scheduled_todo'], description: 'Only for kind=deterministic: bind a host executor so the step actually runs when the rule matches. "create_todo" = create a sticky todo from the user\'s words; "create_scheduled_todo" = create a calendar scheduled todo (needs a time — pair it with time-triggered rules and action_params.when="occurrence"). Omit for a plain deterministic step.' },
              action_params: {
                type: 'object',
                description: 'Only for kind=deterministic with an action. when: "occurrence" = use the time this time-triggered rule fired (use this for periodic scheduled todos); or an absolute ISO datetime resolved at creation time.',
                properties: { when: { type: 'string', description: '"occurrence" or an ISO datetime string.' } },
              },
            },
            required: ['kind', 'text'],
          },
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional trigger keywords for the lexical channel, e.g. ["感叹号"]. Omit if none.',
        },
        time: {
          type: 'object',
          description: 'Optional time trigger (recurrence). Only daily/weekly are supported. Object: { freq: "daily"|"weekly", interval?: number, byday?: number[] (0=Sun…6=Sat), tzid?: string, until?: ISO, count?: number }. Use for "每周五…"/"每天…" periodic rules.',
          properties: {
            freq: { type: 'string', enum: ['daily', 'weekly'] },
            interval: { type: 'number', description: 'Every N periods (≥1). For weekly, N = every N weeks.' },
            byday: { type: 'array', items: { type: 'number' }, description: 'Weekdays to fire (0=Sunday … 6=Saturday). Mainly for weekly.' },
            tzid: { type: 'string', description: 'IANA timezone, e.g. Asia/Shanghai.' },
            until: { type: 'string', description: 'End ISO datetime (inclusive); omit for no end.' },
            count: { type: 'number', description: 'Total occurrences (includes the first).' },
          },
          required: ['freq'],
        },
        scope_target: {
          type: 'string',
          description: 'Optional: limit the rule to one project by project name. Omit for a global rule (default).',
        },
      },
      required: ['name', 'intent_raw', 'steps'],
    },
    category: '记忆',
    execute: toolRuleCreate,
    maxOutput: 2000,
  },
  {
    name: 'skill_draft',
    description: 'Draft a SKILL — a programmable capability the host can run deterministically later (loops / conditions / multi-step orchestration). Use this when the user wants the SAME multi-step procedure repeated — something a declarative rule cannot express. Do NOT use it for a simple one-action habit ("every time…") → that is a rule (rule_create), nor for preferences (→ remember_preference). You only DRAFT: after this call the user reviews an editable card and nothing is saved until they confirm. Keep `description` to ONE sentence saying what the skill does.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human-readable skill name. Required.' },
        description: { type: 'string', description: 'ONE sentence: what this skill does. Required.' },
        when: {
          type: 'object',
          description: 'When this skill is auto-invoked. Be EXPLICIT — matching never uses fuzzy semantics.',
          properties: {
            keywords: { type: 'array', items: { type: 'string' }, description: 'Trigger keywords (lexical channel).' },
            scenes: { type: 'array', items: { type: 'string' }, description: 'Optional scene tags.' },
            object_types: { type: 'array', items: { type: 'string', enum: ['todo', 'schedule', 'note', 'meeting', 'project'] }, description: 'Optional object types it acts on.' },
            preconditions: { type: 'array', items: { type: 'string' }, description: 'Optional host-checkable preconditions.' },
          },
          required: ['keywords'],
        },
        steps: {
          type: 'array',
          description: 'Ordered reviewable steps. Each item: { primitive: string, text?: string, params?: object }. primitive = an audited host primitive, e.g. "create_todo" / "create_scheduled_todo".',
          items: {
            type: 'object',
            properties: {
              primitive: { type: 'string', description: 'Audited primitive id.' },
              text: { type: 'string', description: 'Human-readable step description.' },
              params: { type: 'object', description: 'Primitive params (string values).' },
            },
            required: ['primitive'],
          },
        },
        grants: {
          type: 'object',
          description: 'Permissions the skill needs. OMIT entirely for NO extra permissions (least privilege, the default).',
          properties: {
            fs: { type: 'array', items: { type: 'string' }, description: 'Writable path allowlist.' },
            net: { type: 'boolean', description: 'Allow network requests.' },
            process: { type: 'boolean', description: 'Allow subprocesses.' },
          },
        },
        effects: { type: 'array', items: { type: 'string' }, description: 'Optional side-effect notes shown on the card (e.g. "Enters calendar").' },
      },
      required: ['name', 'description', 'when'],
    },
    category: '技能',
    execute: toolSkillDraft,
    maxOutput: 1500,
  },
  {
    name: 'rule_update',
    description: 'Update an existing rule/flow by id (get ids from read_rules). Provide at least one of: name, intent_raw, steps, keywords. Changing steps re-derives kind and commitment. Optional expected_version enables optimistic locking: if the rule changed since you read it, the update is rejected with a conflict — then read_rules again and retry.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id (e.g. r-20260928-a3f1), from read_rules. Required.' },
        name: { type: 'string', description: 'New short name.' },
        intent_raw: { type: 'string', description: 'New original wording.' },
        steps: {
          type: 'array',
          description: 'Replacement steps. Each item: { kind: "deterministic"|"judgment", text, annex?, action? }.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['deterministic', 'judgment'] },
              text: { type: 'string' },
              annex: { type: 'boolean' },
              action: { type: 'string', enum: ['create_todo', 'create_scheduled_todo'], description: 'Only for kind=deterministic: bind a host executor. "create_todo" = sticky todo; "create_scheduled_todo" = calendar scheduled todo (pair with action_params.when).' },
              action_params: {
                type: 'object',
                description: 'Only for kind=deterministic with create_scheduled_todo. when: "occurrence" = the time this time-triggered rule fired; or an absolute ISO datetime.',
                properties: { when: { type: 'string', description: '"occurrence" or an ISO datetime string.' } },
              },
            },
            required: ['kind', 'text'],
          },
        },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Replacement trigger keywords.' },
        expected_version: { type: 'number', description: 'Optional optimistic-lock version you last read.' },
      },
      required: ['id'],
    },
    category: '记忆',
    execute: toolRuleUpdate,
    maxOutput: 2000,
  },
  {
    name: 'rule_pause',
    description: 'Pause a rule by id (user-initiated, no confirmation needed). Get ids from read_rules. A paused rule is kept but inactive. Use rule_retire to retire it instead.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id, from read_rules. Required.' },
      },
      required: ['id'],
    },
    category: '记忆',
    execute: (args) => toolRuleSetStatus(args, 'paused'),
    maxOutput: 1000,
  },
  {
    name: 'rule_retire',
    description: 'Retire a rule by id (user-initiated, no confirmation needed). Get ids from read_rules. Retiring marks the rule as no longer in use but keeps it for history.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id, from read_rules. Required.' },
      },
      required: ['id'],
    },
    category: '记忆',
    execute: (args) => toolRuleSetStatus(args, 'retired'),
    maxOutput: 1000,
  },
  {
    name: 'rule_dismiss',
    description: 'Record that the user explicitly rejected something ("不对 / 不是这个 / 我说的是…"). Two cases, chosen by class. class="signal_mismatch" (default): the user rejected an existing rule\'s outcome — pass the rule id; this writes the user_dismissed signal (read by both near-miss blocking and the revision threshold) and immediately blocks that rule\'s object type from near-miss asks. class="not_a_habit": the user rejected a proposal to turn a repeated behavior into a new rule — pass object_type instead of id; this only blocks the固化 proposal for that object type. Use rule_pause/rule_retire when the user wants the rule switched OFF; use this when they merely reject this occurrence.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id, from read_rules. Required for class="signal_mismatch" (the default).' },
        source: { type: 'string', description: 'Optional short reason tag, e.g. "wrong_match". Defaults to "rule_dismiss".' },
        class: { type: 'string', enum: ['signal_mismatch', 'not_a_habit'], description: 'Which channel this rejection suppresses. Default "signal_mismatch" = rejecting an existing rule\'s outcome. Use "not_a_habit" for rejecting a proposal to create a new rule from a repeated behavior.' },
        object_type: { type: 'string', enum: ['todo', 'schedule', 'note', 'meeting', 'project'], description: 'Only for class="not_a_habit": the object type whose 固化 proposal should stop. Required in that case.' },
      },
      required: [],
    },
    category: '记忆',
    execute: toolRuleDismiss,
    maxOutput: 1000,
  },
  {
    name: 'rule_revise',
    description: 'Apply a proposed revision to an existing rule by id (get ids from read_rules). Same fields as rule_update, but with revision semantics: the rule version bumps and the revision window resets, so the dismissal rate is measured afresh from this version instead of carrying old baggage. Provide at least one of: name, intent_raw, steps, keywords.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id, from read_rules. Required.' },
        name: { type: 'string', description: 'New short name.' },
        intent_raw: { type: 'string', description: 'New original wording.' },
        steps: {
          type: 'array',
          description: 'Replacement steps. Each item: { kind: "deterministic"|"judgment", text, annex?, action? }.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['deterministic', 'judgment'] },
              text: { type: 'string' },
              annex: { type: 'boolean' },
              action: { type: 'string', enum: ['create_todo', 'create_scheduled_todo'], description: 'Only for kind=deterministic: bind a host executor. "create_todo" = sticky todo; "create_scheduled_todo" = calendar scheduled todo (pair with action_params.when).' },
              action_params: {
                type: 'object',
                description: 'Only for kind=deterministic with create_scheduled_todo. when: "occurrence" = the time this time-triggered rule fired; or an absolute ISO datetime.',
                properties: { when: { type: 'string', description: '"occurrence" or an ISO datetime string.' } },
              },
            },
            required: ['kind', 'text'],
          },
        },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Replacement trigger keywords.' },
        expected_version: { type: 'number', description: 'Optional optimistic-lock version you last read.' },
      },
      required: ['id'],
    },
    category: '记忆',
    execute: toolRuleRevise,
    maxOutput: 2000,
  },
  {
    name: 'rule_resolve_conflict',
    description: 'Record the user\'s choice when two rules both matched and the host could not decide which to follow (a need_user conflict). Get both ids from read_rules. Pass the user\'s chosen rule id. This writes the conflict-resolution signal keyed by the ordered rule-id pair, so the same kind of input does not ask again.',
    parameters: {
      type: 'object',
      properties: {
        rule_a: { type: 'string', description: 'First conflicting rule id, from read_rules. Required.' },
        rule_b: { type: 'string', description: 'Second conflicting rule id, from read_rules. Required.' },
        chosen: { type: 'string', description: 'The rule id the user chose to follow — must equal rule_a or rule_b. Required.' },
        input_feature: { type: 'string', description: 'Optional short feature of the input that caused the conflict (e.g. a keyword), for later reuse.' },
      },
      required: ['rule_a', 'rule_b', 'chosen'],
    },
    category: '记忆',
    execute: toolRuleResolveConflict,
    maxOutput: 1000,
  },
];
