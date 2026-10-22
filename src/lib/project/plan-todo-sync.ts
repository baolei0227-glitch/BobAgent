/**
 * 计划步骤 → 便签待办 单向同步（P0-1(a) 首版）
 *
 * 背景：计划（`.butler/plans.json`）是 AI 侧的执行骨架，步骤的 `due` 只出现在管家对话
 * 与项目详情侧栏里；用户日常真正会看的「待办」是画布便签。于是「计划里有 due 的未完成步骤」
 * 与「用户待办」长期是两条互不相干的线 —— 计划赐了截止日，用户却看不见。
 *
 * 方案（与产品确认的默认决策）：
 *  - **单向**：仅 plan → sticky。勾选/编辑便签行**绝不**回写计划（避免用户误操作改坏计划）。
 *  - **落点**：每项目一张「专用系统便签」（`note.planTodos === true`），不混入用户自己的便签，
 *    也不落日历（本轮只做 sticky 待办，日历提醒属后续）。
 *  - **去重/幂等**：行级来源标记 `page.linePlanRefs`（与 content 行序对齐，语义同 lineEventIds），
 *    ref = `${planId}/${stepId}`。重复同步不产生重复行；客户端结构编辑把标记弄丢时，
 *    还能按「行文本 == 步骤标题」认领回标记，避免重复行。
 *  - **清理**：步骤变 done / 被删 / 计划收尾（done|abandoned）/ 不再带 due → 移除对应行；
 *    系统便签被清空则整张移除，不占画布。
 *  - 只有 **active** 计划中 `status !== 'done'` 且带 `due` 的步骤才物料化。
 *  - 该便签**豁免** `MAX_TODO_NOTES` 上限（直写，不经 POST create 的限额检查）；
 *    也不参与「自动入日历」（见 sticky-calendar-sync.autoAddStickyLinesToCalendar 的 planTodos 短路）。
 *
 * 触发：butler 计划工具（create / add_steps / step_status / close / delete）落盘后调用本模块；
 * 同步失败只记日志，不阻断计划写入本身。
 */
import { join } from 'path';
import { promises as fs } from 'fs';
import type { StickyNote, StickyNotePage } from '@/app/api/sticky-notes/route';
import type { ProjectPlan } from './plans';
import { normalizeStickyNote, writeTodoIndexFile } from '@/lib/sticky-todo';

const STICKY_DIR = 'sticky-notes';
const STICKY_FILE = 'sticky-notes.json';

/** 系统「计划待办」便签标题（English label） */
export const PLAN_TODOS_NOTE_TITLE = 'Plan Todos';

/** 一行计划待办的展示文本：`- [ ] 标题 · due 2026-11-01` */
export function planTodoRowText(title: string, due: string): string {
  return `- [ ] ${title} · due ${due}`;
}

/** 计划「待办行」的派生结果（title/due/text 均来自计划步骤） */
export type PlanTodoRow = {
  /** 行级来源标记：`${planId}/${stepId}` */
  ref: string;
  title: string;
  due: string;
  text: string;
};

/** 收集应物料化到便签的计划步骤行：仅 active 计划中未完成且带 due 的步骤 */
export function collectPlanTodoRows(plans: ProjectPlan[]): PlanTodoRow[] {
  const rows: PlanTodoRow[] = [];
  for (const plan of plans) {
    if (plan.status !== 'active') continue;
    for (const m of plan.milestones) {
      for (const s of m.steps) {
        if (s.status === 'done') continue;
        const title = typeof s.title === 'string' ? s.title.trim() : '';
        const due = typeof s.due === 'string' ? s.due.trim() : '';
        if (!title || !due) continue;
        rows.push({ ref: `${plan.id}/${s.id}`, title, due, text: planTodoRowText(title, due) });
      }
    }
  }
  return rows;
}

/** 解析一行待办：`- [x]` 视为已完成；非 checklist 普通行按未完成处理 */
function parseRow(row: string): { done: boolean; text: string } {
  const m = row.match(/^-\s*\[( |x)\]\s*(.*)$/);
  if (m) return { done: m[1] === 'x', text: m[2] };
  return { done: false, text: row.trim() };
}

async function readNotes(root: string): Promise<StickyNote[]> {
  try {
    const raw = await fs.readFile(join(root, STICKY_DIR, STICKY_FILE), 'utf-8');
    const data = JSON.parse(raw) as { notes?: StickyNote[] };
    return Array.isArray(data?.notes) ? data.notes : [];
  } catch {
    return [];
  }
}

/** 原子写（tmp + rename）并为 normalizeStickyNote 对齐行级元数据；写完同步 todo-index.json */
async function writeNotes(root: string, notes: StickyNote[]): Promise<void> {
  const dir = join(root, STICKY_DIR);
  await fs.mkdir(dir, { recursive: true });
  const normalized = notes.map(
    (n) => normalizeStickyNote(n as unknown as Record<string, unknown>) as unknown as StickyNote,
  );
  // 临时文件唯一名：与面板新增/画布自动保存共用固定 tmp 名会互相踩踏
  const tmp = join(
    dir,
    `.${STICKY_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.plan.tmp`,
  );
  await fs.writeFile(tmp, JSON.stringify({ notes: normalized }, null, 2), 'utf-8');
  await fs.rename(tmp, join(dir, STICKY_FILE));
  // 索引同步失败不影响主文档写入（/inspect 会回退扫描主文档自愈）
  try {
    await writeTodoIndexFile(root, normalized as unknown as Array<Record<string, unknown>>);
  } catch (e) {
    console.error('[plan-todo-sync] 待办索引同步失败:', e);
  }
}

function newId(): string {
  return `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function newPageId(): string {
  return `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 挑一个不与现有便签重叠的落点（画布左上起小范围试探；找不到就退左上角） */
function pickFreeSpot(notes: StickyNote[]): { x: number; y: number } {
  for (let step = 0; step < 8; step++) {
    const x = 24 + step * 40;
    const y = 24 + (step % 2) * 40;
    const clash = notes.some(
      (n) => Math.abs((n.x ?? 0) - x) < 200 && Math.abs((n.y ?? 0) - y) < 160,
    );
    if (!clash) return { x, y };
  }
  return { x: 24, y: 24 };
}

/** 新建系统「计划待办」便签（蓝底区分用户自己的便签） */
function newSystemNote(notes: StickyNote[]): StickyNote {
  const now = new Date().toISOString();
  const page: StickyNotePage = { id: newPageId(), title: 'P1', content: '', kind: 'todo' };
  const topZ = notes.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
  const spot = pickFreeSpot(notes);
  return {
    id: newId(),
    x: spot.x,
    y: spot.y,
    color: 'blue',
    kind: 'todo',
    title: PLAN_TODOS_NOTE_TITLE,
    pages: [page],
    activePageId: page.id,
    createdAt: now,
    updatedAt: now,
    sidebarCollapsed: true,
    z: topZ + 1,
    planTodos: true,
  };
}

/** 取系统便签当前页（activePageId 有效则用它，否则第一页；无页则补建） */
function systemPageOf(note: StickyNote): StickyNotePage {
  const pages = Array.isArray(note.pages) ? note.pages : [];
  const active = pages.find((p) => p.id === note.activePageId);
  if (active) return active;
  if (pages.length > 0) return pages[0];
  const page: StickyNotePage = { id: newPageId(), title: 'P1', content: '', kind: 'todo' };
  note.pages = [page];
  note.activePageId = page.id;
  return page;
}

export type PlanTodoSyncResult = {
  /** 本次新增的行数 */
  created: number;
  /** 本次移除的行数（含失效引用与重复引用） */
  removed: number;
  /** 是否真的改了便签（幂等：内容一致时返回 false 且不写盘） */
  changed: boolean;
};

/**
 * 把计划步骤单向同步到系统「计划待办」便签（幂等）。
 * 重复调用不产生重复行；内容无变化时不写盘。
 */
export async function syncPlanTodos(
  root: string,
  plans: ProjectPlan[],
): Promise<PlanTodoSyncResult> {
  const notes = await readNotes(root);
  const desired = collectPlanTodoRows(plans);
  const desiredByRef = new Map(desired.map((d) => [d.ref, d]));
  const noteIdx = notes.findIndex((n) => n.planTodos === true);

  // 既无系统便签、也没有要物料的步骤 → 空操作
  if (noteIdx < 0 && desired.length === 0) return { created: 0, removed: 0, changed: false };

  const existing = noteIdx >= 0 ? notes[noteIdx] : null;
  const page = existing ? systemPageOf(existing) : null;
  const rows = page ? String(page.content ?? '').split('\n') : [];
  const rawRefs = page && Array.isArray(page.linePlanRefs) ? page.linePlanRefs : [];
  const refs = rows.map((_, i) =>
    Array.isArray(rawRefs[i]) ? String((rawRefs[i] as unknown[])[0] ?? '') : '',
  );

  const keptRows: string[] = [];
  const keptRefs: string[] = [];
  const satisfied = new Set<string>();
  let removed = 0;

  for (let i = 0; i < rows.length; i++) {
    const ref = refs[i];
    if (!ref) {
      keptRows.push(rows[i]);
      keptRefs.push('');
      continue;
    }
    const d = desiredByRef.get(ref);
    // 步骤已完成 / 被删 / 计划收尾 / 不再带 due → 行失效，移除
    if (!d) {
      removed++;
      continue;
    }
    // 同一 ref 重复成行 → 去重
    if (satisfied.has(ref)) {
      removed++;
      continue;
    }
    satisfied.add(ref);
    // 用户已勾选的行原样保留（单向：勾选不改计划）；未勾选的行按计划口径重写（反映改名/改期）
    keptRows.push(parseRow(rows[i]).done ? rows[i] : d.text);
    keptRefs.push(ref);
  }

  // 认领：无 ref 但文本匹配目标（标题或完整行文本）的行 → 补回 ref，避免重复行
  // （客户端结构编辑把标记弄丢后自愈；也容忍用户只写了标题没带 due 后缀）
  for (const d of desired) {
    if (satisfied.has(d.ref)) continue;
    const i = keptRows.findIndex((row, k) => {
      if (keptRefs[k]) return false;
      const text = parseRow(row).text;
      return text === d.title || text === parseRow(d.text).text;
    });
    if (i >= 0) {
      keptRefs[i] = d.ref;
      satisfied.add(d.ref);
    }
  }

  // 追加仍缺的目标行
  let created = 0;
  for (const d of desired) {
    if (satisfied.has(d.ref)) continue;
    keptRows.push(d.text);
    keptRefs.push(d.ref);
    satisfied.add(d.ref);
    created++;
  }

  const nonBlank = keptRows.filter((r) => r.trim().length > 0).length;
  const content = keptRows.join('\n');
  const nextRefs = keptRefs.map((r) => (r ? [r] : []));

  // 清空则整张系统便签移除（无计划待办时不占画布）
  if (nonBlank === 0) {
    if (noteIdx < 0) return { created: 0, removed: 0, changed: false };
    notes.splice(noteIdx, 1);
    await writeNotes(root, notes);
    return { created: 0, removed, changed: true };
  }

  if (!existing) {
    const note = newSystemNote(notes);
    const p = systemPageOf(note);
    p.content = content;
    p.linePlanRefs = nextRefs;
    notes.push(note);
    await writeNotes(root, notes);
    return { created, removed, changed: true };
  }

  const before = JSON.stringify({ c: page!.content, r: page!.linePlanRefs });
  page!.content = content;
  page!.linePlanRefs = nextRefs;
  const after = JSON.stringify({ c: page!.content, r: page!.linePlanRefs });
  if (before === after) return { created: 0, removed: 0, changed: false };
  existing.updatedAt = new Date().toISOString();
  await writeNotes(root, notes);
  return { created, removed, changed: true };
}
