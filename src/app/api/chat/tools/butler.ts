/**
 * Agent 工具系统 — butler 场景（记忆/偏好 · 待办 · 日程 · 便签 · 计划树 · 模型计费）
 * butler 场景工具（17 个）的定义与 executor：
 *   - 事务域：read_todo / remember_preference / read_preferences / delete_preference / update_preference /
 *             query_schedule / create_scheduled_todo / query_todos / todo_update / todo_delete / create_sticky_note
 *   - 计划树：project_plan_start / project_plan_view / project_plan_add_steps / project_plan_step_status
 *   - 模型计费：get_model_price / set_model_price（对话维护单价覆盖，新增模型 / 厂商调价）
 * 依赖方向单向：import shared.ts 的公共助手（getProjectRootPath），
 * 仅以 import type 依赖 index.ts 的类型（编译期擦除），不产生运行时循环依赖。
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { getCurrentProject } from '@/lib/project/project-manager';
import { initDb } from '@/lib/db';
import { join } from 'path';
import { PROJECT_DB_FILENAME } from '@/lib/app-root';
import { getProjectRootPath } from './shared';
import type { ProviderConfig } from '@/lib/types';
import type { ModelPriceOverride } from '@/lib/settings';
import type { Tool } from './index';

/** read_todo 工具 —（已合并，DB shim）。从 events 表按 scope='all' 查询，
 *  兼容 filter (all/recent/week/today) + category 过滤，输出 Markdown 字符串。
 *  Note: 精细的时间/逾期/状态/关键词查询请走 ⌘F 面板 /todo check 命令（复用 schedule 查询管线）。
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
    if (rangeStart && rangeEnd) {
      conds.push(`(start_time IS NULL OR (datetime(start_time) < datetime(?) AND (end_time IS NULL OR datetime(end_time) >= datetime(?))))`);
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
      return `No tasks found for ${filterDesc}${catDesc}. (read_todo merged into events DB; use /todo check in the ⌘F panel for finer status/overdue/keyword filters.)`;
    }

    // 渲染为 Markdown：按分类树分组（事件条目格式）
    const lines: string[] = [
      '# TODO 待办记录 (merged: events DB)',
      `> ${rows.length} item(s) · filter=${filter}${category ? ` · category=${category}` : ''}`,
      '',
    ];

    const { ensureCategoryPath, insertLines } = await import('@/lib/wanted/category-tree');
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

/** remember_preference 工具 — 记录用户偏好/习惯（仅用户显式要求记住时调用，带类型元数据） */
async function toolRememberPreference(args: Record<string, unknown>): Promise<string> {
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content) return 'Error: content is required（偏好内容必填，例如「用户习惯用表格输出」）';
  const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : undefined;
  try {
    const { addPreference } = await import('@/lib/wanted/preferences');
    const res = await addPreference(content, type ? { type } : undefined);
    if (res.added) {
      return `已记住用户偏好（类型：${type || '通用'}，共 ${res.total} 条）：「${content}」。此后所有节点每轮对话都会参考该偏好。`;
    }
    return `该偏好此前已记录：「${content}」（共 ${res.total} 条，未重复添加）。`;
  } catch (e) {
    return `记住偏好失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_preferences 工具 — 列出用户偏好（带序号/类型/时间，支持按类型过滤） */
async function toolReadPreferences(args: Record<string, unknown>): Promise<string> {
  const typeFilter = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : '';
  try {
    const { listPreferences } = await import('@/lib/wanted/preferences');
    const prefs = typeFilter
      ? (await listPreferences()).filter((p) => p.type === typeFilter)
      : await listPreferences();
    if (prefs.length === 0) {
      return typeFilter
        ? `没有类型为「${typeFilter}」的用户偏好。可先 read_preferences 查看全部，或让用户说「记住：……」来新增。`
        : '暂无已记录的用户偏好。当用户明确说「记住 / 以后都这样」时，调用 remember_preference 记录。';
    }
    const list = prefs.map((p) => {
      const meta = [p.type && p.type !== '通用' ? p.type : '', p.createdAt ? `记录于 ${p.createdAt}` : '', p.source && p.source !== 'chat' ? `来源 ${p.source}` : ''].filter(Boolean).join('，');
      return `${p.index}. ${p.content}${meta ? `（${meta}）` : ''}`;
    }).join('\n');
    const scope = typeFilter ? `类型「${typeFilter}」` : '全部';
    return `已记录 ${prefs.length} 条用户偏好（${scope}，全局长期记忆，所有节点每轮参考）：\n${list}\n\n删除：调用 delete_preference（传 index 序号）。`;
  } catch (e) {
    return `读取偏好失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** delete_preference 工具 — 按序号删除一条用户偏好（手动遗忘） */
async function toolDeletePreference(args: Record<string, unknown>): Promise<string> {
  const raw = typeof args.index === 'number' ? args.index : parseInt(String(args.index ?? ''), 10);
  const index = Number.isFinite(raw) ? Math.floor(raw) : 0;
  if (index < 1) return 'Error: index required（偏好序号必填，1-based，可用 read_preferences 查看）';
  try {
    const { removePreference } = await import('@/lib/wanted/preferences');
    const res = await removePreference(index);
    if (res.removed) return `已删除第 ${index} 条用户偏好，剩余 ${res.remaining} 条。`;
    return `删除失败：第 ${index} 条不存在（当前共 ${res.remaining} 条）。可用 read_preferences 查看有效序号。`;
  } catch (e) {
    return `删除偏好失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** update_preference 工具 — 按序号原子修改一条偏好（只改传入字段，元数据保留） */
async function toolUpdatePreference(args: Record<string, unknown>): Promise<string> {
  const raw = typeof args.index === 'number' ? args.index : parseInt(String(args.index ?? ''), 10);
  const index = Number.isFinite(raw) ? Math.floor(raw) : 0;
  if (index < 1) return 'Error: index required（偏好序号必填，1-based，可用 read_preferences 查看）';
  const patch: { content?: string; type?: string } = {};
  if (typeof args.content === 'string' && args.content.trim()) patch.content = args.content.trim();
  if (typeof args.type === 'string' && args.type.trim()) patch.type = args.type.trim();
  if (patch.content === undefined && patch.type === undefined) {
    return 'Error: content or type required（至少提供新内容 content 或新类型 type 之一）';
  }
  try {
    const { updatePreference } = await import('@/lib/wanted/preferences');
    const res = await updatePreference(index, patch);
    if (!res.updated || !res.preference) {
      return `修改失败：${res.error ?? '未知错误'}`;
    }
    const p = res.preference;
    return `已修改第 ${index} 条偏好：\n内容：${p.content}\n类型：${p.type}（记录于 ${p.createdAt}，来源 ${p.source}）\n剩余 ${res.remaining} 条。`;
  } catch (e) {
    return `修改偏好失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * query_todos 工具执行器：复用 /todo check 的查询管线
 * （resolveReadCalendarQuery 自由语义解析 → querySchedule 读全局日历库并精确过滤/格式化）。
 * 服务端自调用带绝对 base（Node fetch 不支持相对路径），与 daily-report / organize-send 同一约定。
 */
async function toolQueryTodos(args: Record<string, unknown>): Promise<string> {
  try {
    const queryText = typeof args.query === 'string' ? args.query.trim() : '';
    const scope =
      args.scope === 'project' || args.scope === 'global' ? (args.scope as 'project' | 'global') : 'all';
    const base = `http://localhost:${process.env.PORT || '5000'}`;
    const { resolveReadCalendarQuery, querySchedule } = await import('@/lib/wanted/schedule');
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
      ['reminder_minutes', args.reminder_minutes],
    ];
    for (const [k, v] of fieldMap) {
      if (v !== undefined && v !== null) body[k] = v;
    }
    if (Object.keys(body).length === 0) return JSON.stringify({ ok: false, error: '没有要更新的字段' });
    const resp = await fetch(`${selfBaseUrl()}/api/calendar/events?event_id=${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data?.success) return `(todo update failed: ${data?.error || resp.status})`;
    const ev = data.event;
    if (ev?.status === 'done') return `✅ 已完成：${ev.title}`;
    if (ev?.status === 'scheduled' && body.status === 'scheduled') return `↩ 已恢复未完成：${ev.title}`;
    return `✓ 已更新：${ev?.title ?? eventId}${ev?.start_time ? ` @ ${ev.start_time}` : ''}`;
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
    for (const r of timed) {
      lines.push(
        `- ${fmt(r.start_time)}${r.end_time ? ` ~ ${fmt(r.end_time)}` : ''} · ${r.title}${r.status === 'done' ? ' ✅' : ''}${r.scope === 'global' ? ' (global)' : ''} · id:${r.event_id.slice(0, 8)}`,
      );
    }
    if (wantStatus === 'scheduled') {
      lines.push('');
      lines.push('### Open items (no fixed time)');
      if (untimedScheduled.length === 0) lines.push('(none)');
      for (const r of untimedScheduled) {
        lines.push(`- ${r.title}${r.scope === 'global' ? ' (global)' : ''} · id:${r.event_id.slice(0, 8)}`);
      }
    }
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * create_scheduled_todo 工具执行器：给「有明确时刻/用户要求入日历」的待办写日历事件，
 * 并把事件绑定到项目便签行（StickyTodo 不自动入日历——只有这里与用户手动「Add to calendar」才产生事件）。
 * 绑定规则：项目便签里已有同文本且未入日历的行 → 直接绑定该行（不新增重复行）；
 * 否则在便签上追加一行（无便签位时仅建日历事件）。仅在用户明确同意安排后调用（日程专家先查冲突、再提议、用户确认后才落地）。
 */
async function toolCreateScheduledTodo(args: Record<string, unknown>): Promise<string> {
  try {
    const project = await getCurrentProject();
    const projectId = project.id;
    const projectRoot = project.path;
    const title = String(args.title ?? '')
      .trim()
      .replace(/\n+/g, ' ');
    if (!title) return JSON.stringify({ ok: false, error: 'title 不能为空' });

    const cal = await import('@/lib/sticky-calendar-sync');
    const notes = await cal.readStickyNotesFile(projectRoot);

    const startRaw = typeof args.start_time === 'string' && args.start_time ? String(args.start_time) : '';
    const startTime = startRaw || cal.stickyTodoDefaultRange().start;
    const allDay = args.all_day === true;
    const endTime =
      typeof args.end_time === 'string' && args.end_time
        ? String(args.end_time)
        : allDay
          ? undefined
          : new Date(new Date(startTime).getTime() + 3600_000).toISOString();
    const reminderRaw = args.reminder_minutes;
    const reminderMinutes =
      Array.isArray(reminderRaw) && reminderRaw.every((x) => typeof x === 'number')
        ? (reminderRaw as number[])
        : allDay
          ? []
          : [30];

    // StickyTodo 不自动入日历（2026-09-08）：只有排程 / 用户手动入日历才产生事件。
    // 排程时若该项目已有「同文本且未入日历」的便签行 → 绑定该行（避免把既有待办排期时新增重复行）。
    const MAX_TODO_NOTES = 3;

    // 1) 复用同文本的未排程行
    let bindRow: { noteIdx: number; pageId: string; lineIndex: number } | null = null;
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
          const anchored = Array.isArray(evsArr[li]) && (evsArr[li] as string[]).length > 0;
          const flagged = calArr[li] === true;
          if (anchored || flagged) continue;
          bindRow = { noteIdx: ni, pageId: pg.id, lineIndex: li };
          break;
        }
      }
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
    } else {
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
          title: project.name || 'Untitled',
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

    // 建日历事件（先建，获得 event_id 后再回填到便签行锚点）
    const { getCalendarDb, createEvent } = await import('@/lib/db');
    const db = await getCalendarDb();
    const sourceRef =
      attachNote && pageId ? cal.stickyRefOf(attachNote.id, pageId) : undefined;
    const eventId = await createEvent(db, {
      project_id: projectId,
      title,
      description: typeof args.description === 'string' && args.description ? args.description : undefined,
      start_time: startTime,
      end_time: endTime ?? null,
      all_day: allDay,
      scope: 'project',
      reminder_minutes: reminderMinutes,
      source_ref: sourceRef,
    });

    let lineIndex: number | undefined;
    if (attachNote && pageId) {
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
 * create_sticky_note 工具执行器：在画布上静默创建一张便签（项目私有）。
 * 便签为用户私有数据（AI 不可读回），本工具仅负责写入，不返回内容、不触发确认弹窗。
 * 写入格式与 /api/sticky-notes 完全一致（pages/activePageId 结构）。
 */
async function toolCreateStickyNote(args: Record<string, unknown>): Promise<string> {
  try {
    const projectRoot = await getProjectRootPath();
    const stickyDir = join(projectRoot, 'sticky-notes');
    const stickyFile = join(stickyDir, 'sticky-notes.json');

    // 读取现有便签（文件不存在时视为空数组）
    let notes: Array<Record<string, unknown>> = [];
    try {
      const raw = await readFile(stickyFile, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data?.notes)) notes = data.notes as Array<Record<string, unknown>>;
    } catch { /* 文件不存在或损坏 → 从空数组开始 */ }

    const content = String(args.content ?? '').trim();
    if (!content) return JSON.stringify({ ok: false, error: 'content 不能为空' });

    // 默认标题：项目名（不自动追加创建日期，与 /api/sticky-notes defaultTitle 一致）
    let projectName = 'Untitled';
    try {
      const project = await getCurrentProject();
      projectName = project.name || 'Untitled';
    } catch { /* 兜底 */ }
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : projectName;
    const { MAX_TODO_NOTES, pickTodoNoteColor, normalizeStickyNote } = await import('@/lib/sticky-todo');
    // 每项目最多三张待办便签：已满三张时不新建，返回已有便签
    if (notes.length >= MAX_TODO_NOTES) {
      const existing = notes[0];
      return JSON.stringify({
        ok: true,
        note_id: existing.id,
        title: typeof existing.title === 'string' ? existing.title : title,
        color: typeof existing.color === 'string' ? existing.color : 'yellow',
        limited: true,
        message: '该项目已有三张待办便签，未重复创建',
      });
    }
    // 颜色自动与已有便签区分：优先调用方指定色，已被占用则取当前未使用色
    const color = pickTodoNoteColor(notes, typeof args.color === 'string' ? args.color : undefined);
    // 便签为屏幕像素定位，模型无法获知窗口尺寸 → 坐标一律由服务端级联分配，
    // 从源头避免模型自编坐标（如 1586）导致便签落在可视区外（2026-08-22 修复）
    const n = notes.length;
    const x = 40 + (n % 5) * 28;
    const y = 120 + (n % 5) * 28;
    const now = new Date().toISOString();
    const pageId = `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const noteId = `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const topZ = notes.reduce((m, n) => Math.max(m, typeof n.z === 'number' ? n.z : 0), 0);

    notes.push({
      id: noteId,
      x,
      y,
      color,
      kind: 'todo',
      title,
      pages: [{ id: pageId, title: 'P1', content }],
      activePageId: pageId,
      createdAt: now,
      updatedAt: now,
      width: 400,
      height: 225,
      sidebarCollapsed: true,
      z: topZ + 1,
    });

    // StickyTodo 不自动入日历（2026-09-08 起）：AI 静默创建的便签行保持纯便签、无事件锚点；
    // 入日历只在用户手动「Add to calendar」或 Butler 排程时发生（见 addStickyLineToCalendar / create_scheduled_todo）
    const arrToWrite = notes.map((n) =>
      normalizeStickyNote(n as unknown as Record<string, unknown>),
    );

    // 原子写入：先写临时文件再 rename，避免半写状态。
    // 临时名唯一：与 /api/sticky-notes、迁移脚本并发写时不共用固定 tmp 名，避免互相踩踏（rename ENOENT）
    await mkdir(stickyDir, { recursive: true });
    const tmp = join(stickyDir, `.sticky-notes.json.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    await writeFile(tmp, JSON.stringify({ notes: arrToWrite }, null, 2), 'utf-8');
    await rename(tmp, stickyFile);

    // 同步未完成待办索引（todo-index.json，与 /api/sticky-notes 写盘路径一致；
    // 失败仅影响 /inspect 的索引命中，回退全量扫描可自愈）
    try {
      const { writeTodoIndexFile } = await import('@/lib/sticky-todo');
      await writeTodoIndexFile(projectRoot, arrToWrite);
    } catch { /* 索引同步失败不阻断工具成功返回 */ }

    return JSON.stringify({ ok: true, note_id: noteId, title, color });
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

/** 计划树：新建计划（含可选里程碑/步骤） */
async function toolProjectPlanStart(args: Record<string, unknown>): Promise<string> {
  try {
    const root = await getProjectRootPath();
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
    return `Plan created. id: ${plan.id}\n\n${renderPlan(plan)}\n\nTrack progress with project_plan_view / project_plan_step_status.`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：回读（不带 id 列全部；带 id 列完整树） */
async function toolProjectPlanView(args: Record<string, unknown>): Promise<string> {
  try {
    const root = await getProjectRootPath();
    const plans = await readPlans(root);
    const planId = typeof args.plan_id === 'string' ? args.plan_id : '';
    if (planId) {
      const p = plans.find((x) => x.id === planId);
      if (!p) return `Plan not found: ${planId}`;
      return renderPlan(p);
    }
    if (plans.length === 0) return '(no plans in this project yet. Use project_plan_start to create one.)';
    const lines = ['# Project plans', ''];
    for (const p of plans) {
      const steps = p.milestones.reduce((n, m) => n + m.steps.length, 0);
      const doneSteps = p.milestones.reduce((n, m) => n + m.steps.filter((s) => s.status === 'done').length, 0);
      lines.push(`- ${p.status === 'done' ? '✅' : '▶'} ${p.title} · id:${p.id} · ${doneSteps}/${steps} steps done`);
    }
    lines.push('');
    lines.push('Pass plan_id to project_plan_view to see a full tree.');
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：追加步骤到里程碑（默认第一个/仅有；可按 id 或按标题定位/新建里程碑） */
async function toolProjectPlanAddSteps(args: Record<string, unknown>): Promise<string> {
  try {
    const root = await getProjectRootPath();
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
    return `Added ${stepTitles.length} step(s) to "${milestone.title}".\n\n${renderPlan(plan)}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：步骤状态机推进 */
async function toolProjectPlanStepStatus(args: Record<string, unknown>): Promise<string> {
  try {
    const root = await getProjectRootPath();
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
    return `${prefix} Step "${step.title}" → ${want}${plan.status === 'done' ? ' · 🎉 计划全部完成' : ''}\n\n${renderPlan(plan)}`;
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

/** butler 场景工具定义（由 tools/index.ts 聚合进 toolDefs） */
export const butlerToolDefs: Tool[] = [
  {
    name: 'read_todo',
    description: 'Read WANTED todo records of the current project: recent tasks, by category (会议/开发/文档/学习/沟通/生活/规划/其他), or today\'s schedule. Filter by time range (today/week/all) and category.',
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
    description: 'Record a user preference/habit into global long-term memory (wanted/preferences.md) with structured metadata. Call when: (1) the user explicitly asks to remember something ("记住：以后都用表格输出"), OR (2) a clear habit signal appears AND the user approves your "需要我把这条记入长期偏好吗？" question. NEVER record without consent — if declined, do NOT call. Do NOT record ordinary chat content on your own. content = one-sentence preference; type optional (e.g. 输出格式/引用规范/任务流程/沟通风格), default 通用.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'One-sentence preference description, e.g. "用户习惯用表格输出" or "引用法条必须标注时效性". Required.',
        },
        type: {
          type: 'string',
          description: 'Optional category for this preference, e.g. 输出格式 / 引用规范 / 任务流程 / 沟通风格. Omit to default to 通用. Prefer to infer the type from the user\'s intent (what aspect of behavior it governs).',
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
    description: 'List all recorded user preferences (global long-term memory, wanted/preferences.md) with index/type/created_at. Use when the user asks "我有哪些偏好" / "你记住了我什么习惯", or before delete_preference to see valid indexes. Optional type filter lists only preferences of that category.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Optional: only list preferences of this type/category (e.g. 输出格式). Omit to list all.',
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
    description: 'Delete one recorded user preference by its index (manual forgetting, wanted/preferences.md). Use read_preferences first to see valid indexes. The user decides what to forget; do not auto-delete.',
    parameters: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'Preference index (1-based), as shown by read_preferences. Required.',
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
    description: 'Atomically update one recorded user preference by its index (wanted/preferences.md). Use when the user asks to change/modify a recorded preference, e.g. "把第 2 条改成…" or "第 1 条的类型改成引用规范". Only update the fields provided (content and/or type); created_at/source are preserved. Use read_preferences first to see valid indexes and current values.',
    parameters: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'Preference index (1-based), as shown by read_preferences. Required.',
        },
        content: {
          type: 'string',
          description: 'New one-sentence preference content. Optional if type is provided.',
        },
        type: {
          type: 'string',
          description: 'New category (e.g. 输出格式 / 引用规范 / 任务流程 / 沟通风格). Optional if content is provided.',
        },
      },
      required: ['index'],
    },
    category: '记忆',
    execute: toolUpdatePreference,
    maxOutput: 2000,
  },
  {
    name: 'query_schedule',
    description:
      'Query the user schedule/calendar events (cross-project calendar DB) in a time window. Use BEFORE proposing any arrangement — check which slots are occupied to avoid conflicts. Returns scheduled (optionally done/cancelled) events sorted by start, plus open untimed checklist items. Prefer over read_todo for schedule/conflict questions.',
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
      'Schedule a todo INTO the calendar at an explicit time (sticky rows do NOT auto-enter the calendar): writes a calendar event and links it to a `- [ ]` sticky line — if the project already has an identical unscheduled sticky line it binds that one (no duplicate); otherwise it appends one (calendar-only at the 3-todo-sticky cap). Ticking either side syncs. Call ONLY after the user has explicitly confirmed your proposed arrangement. title/start_time/end_time/all_day/reminder_minutes define the event; description goes into its notes. Missing start_time → default next-hour slot.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Todo title (also becomes the sticky note line text).',
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
        reminder_minutes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Reminder lead minutes, e.g. [30, 1440]. Default [30]. Pass [] to disable reminders.',
        },
        description: {
          type: 'string',
          description: 'Optional notes/details stored on the calendar event.',
        },
      },
      required: ['title'],
    },
    category: '文件',
    execute: toolCreateScheduledTodo,
    maxOutput: 1500,
  },
  {
    name: 'query_todos',
    description:
      'Query TODOs/tasks like /todo check, with free-form semantic queries: time ranges ("today"/"this week"/"tomorrow"/"next Monday"), status keywords ("overdue"/"done"), content keywords, empty = today. Reads the shared calendar-events database (project todos + global untimed items). For schedule-window conflict checks prefer query_schedule.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional natural-language query, e.g. "今天" / "下周" / "逾期未完成" / "包含 立案" / "上周做完的". Empty = today."' },
        scope: { type: 'string', enum: ['all', 'project', 'global'], description: 'Optional scope. Default all (project + global untimed items).' },
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
      'Update an existing todo/event by its event_id (from query_todos): change title, start/end time, all_day, status (done/scheduled), priority, color, location, description, reminder_minutes. Changes propagate two-way: calendar updates; a sticky-note-sourced line syncs too.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id (from query_todos output).' },
        title: { type: 'string', description: 'New title / todo text.' },
        start_time: { type: 'string', description: 'New start time (local ISO, e.g. 2026-09-04T09:00:00+08:00).' },
        end_time: { type: 'string', description: 'New end time (local ISO).' },
        all_day: { type: 'boolean', description: 'All-day flag.' },
        status: { type: 'string', enum: ['scheduled', 'done'], description: "done = complete the todo, scheduled = re-open it. Use todo_delete to remove entirely (not 'cancelled')." },
        priority: { type: 'string', enum: ['high', 'normal', 'low'] },
        color: { type: 'string', description: 'Event color hex, e.g. #F59E0B.' },
        location: { type: 'string' },
        description: { type: 'string' },
        reminder_minutes: { type: 'array', items: { type: 'number' }, description: 'Reminder lead minutes, e.g. [30]. Pass [] to disable.' },
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
    description: 'Create a sticky note on the canvas (project-private). Use for a produced plan/checklist/reminder the user wants saved as a sticky (e.g. a legal work plan split into phases). Lines are NOT auto-added to the calendar: they appear in to-do queries as "not scheduled" until the user schedules them or taps "Add to calendar" in the sticky card. Written silently to the project sticky-notes.json; canvas refreshes automatically (no confirm dialog). Sticky notes are private — after creation never read back or modify them via file tools. Position is auto-assigned on a cascade; do not try to control it. Max 3 todo stickies per project: at the cap, creation is skipped and an existing note is returned.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Sticky note body. For a plan, use one line per task/checklist item, each line starting with "- [ ] " (e.g. "- [ ] 收集证据材料").',
        },
        title: {
          type: 'string',
          description: 'Optional note title (defaults to the project name, no auto date suffix). e.g. "借款纠纷诉讼计划".',
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
    name: 'project_plan_start',
    description:
      'Start a persistent project plan (plan tree) in .butler/plans.json: milestones → steps; returns its id. Pass title/goal and either a flat "steps" list or structured "milestones" [{title, steps}]. Track afterwards with project_plan_view / project_plan_add_steps / project_plan_step_status.',
    parameters: {
      type: 'object',
      properties: {
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
      'Read back the project plan tree(s): no plan_id → list all plans (title/status/progress); with plan_id → full milestones/steps with ids and statuses. Call before updating so you address steps by their real ids.',
    parameters: {
      type: 'object',
      properties: { plan_id: { type: 'string', description: 'Optional plan id.' } },
      required: [],
    },
    category: '系统',
    execute: toolProjectPlanView,
    maxOutput: 5000,
  },
  {
    name: 'project_plan_add_steps',
    description:
      'Append steps to a plan. Default target = the first (or only) milestone; pass milestone_id (from project_plan_view) for a specific one, or milestone_title to create/find a milestone by title.',
    parameters: {
      type: 'object',
      properties: {
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
      'Advance one step in the plan state machine: pending → in_progress → done; blocked (with reason) → pending/in_progress. Milestone/plan completion derive automatically from steps. Call when a step starts, finishes, or blocks.',
    parameters: {
      type: 'object',
      properties: {
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
];
