/**
 * Sticky 便签未完成待办索引（todo-index.json）
 *
 * 背景：待办状态内嵌在 sticky-notes.json 每张便签 pages[].content 的文本行
 * （`- [ ]` / `- [x]`），跨项目聚合（/inspect）若直接扫描主文档，数据量大时
 * 每张便签的 content 都要读入并做行级正则，浪费 IO 与 token。
 *
 * 方案：为每个项目在主文档旁维护一个轻量「未完成待办索引」todo-index.json，
 * 由 sticky 写操作（create/update/delete）在写盘后**增量同步**：
 *  - 只记录未完成行（- [ ] 或非 checklist 普通行），已完成行（- [x]）自动剔除
 *  - /inspect 只读各项目索引即可聚合，零全量扫描
 *  - 索引缺失/损坏/版本不符时返回 null，调用方回退为扫描主文档重建（幂等自愈）
 *
 * 数据结构与前端 parseLines 语义保持一致（见 CanvasStickyNotes.tsx）：
 *   - `- [x] 文本` → 已完成
 *   - `- [ ] 文本` → 未完成待办
 *   - 其它非空行 → 未完成普通行（同样纳入待办）
 *   - 便签 note 模式（kind='note' 带编号笔记）已于 2026-08 停用，存量 note 页由
 *     sticky-notes GET 惰性迁移到 notebook.json；索引继续跳过 note 页（兼容迁移前数据）
 */
import { join } from 'path';

export type StickyTodoIndex = {
  version: 1;
  updatedAt: string;
  notes: StickyTodoIndexNote[];
};

export type StickyTodoIndexNote = {
  noteId: string;
  title: string;
  color: string;
  pages: StickyTodoIndexPage[];
};

export type StickyTodoIndexPage = {
  pageId: string;
  pageTitle: string;
  items: string[];
};

/** 每项目待办便签（todo sticky）数量上限 */
export const MAX_TODO_NOTES = 3;
/** 待办便签可用配色（与前端 NOTE_COLORS 保持一致） */
export const TODO_NOTE_COLORS = ['yellow', 'blue', 'green', 'pink'] as const;

/**
 * 计算新建待办便签的颜色：优先用调用方指定色，若已被占用则取当前未使用的第一个颜色，
 * 保证同一项目内多张待办便签颜色互不重复。
 */
export function pickTodoNoteColor(
  notes: Array<Record<string, unknown>>,
  preferred?: string,
): string {
  const used = new Set(
    notes.map((n) => (typeof n.color === 'string' ? n.color : '')).filter(Boolean),
  );
  if (
    preferred &&
    (TODO_NOTE_COLORS as readonly string[]).includes(preferred) &&
    !used.has(preferred)
  ) {
    return preferred;
  }
  return TODO_NOTE_COLORS.find((c) => !used.has(c)) ?? 'yellow';
}

/** 从便签页内容中提取未完成待办项（与前端 parseLines 语义一致，过滤空行） */
export function extractPendingItems(content: string): string[] {
  const items: string[] = [];
  for (const raw of String(content ?? '').split('\n')) {
    const m = raw.match(/^-\s*\[( |x)\]\s*(.*)$/);
    const done = m ? m[1] === 'x' : false;
    const text = (m ? m[2] : raw.trim()).trim();
    if (done) continue;
    if (!text) continue;
    items.push(text);
  }
  return items;
}

/**
 * 从内存中的便签列表构建完整索引（只保留"至少含一个待办项"的便签/页）。
 * 兼容老数据：无 pages 时把 content 视为 P1（与前端 hydratePages / 服务端 upgradeNotePages 一致）。
 * 返回 null 表示无任何待办（此时索引文件可写为空 notes 数组）。
 */
export function buildTodoIndex(notes: Array<Record<string, unknown>>): StickyTodoIndex {
  const idxNotes: StickyTodoIndexNote[] = [];
  for (const n of notes) {
    const noteId = typeof n.id === 'string' ? n.id : '';
    if (!noteId) continue;
    const title = typeof n.title === 'string' && n.title.trim() ? n.title.trim() : '';
    const color = typeof n.color === 'string' && n.color.trim() ? n.color.trim() : 'yellow';
    const pages: StickyTodoIndexPage[] = [];
    const rawPages = n.pages;
    const rawContent = typeof n.content === 'string' ? n.content : '';
    if (Array.isArray(rawPages)) {
      for (const p of rawPages as Array<Record<string, unknown>>) {
        // note 模式的页（带编号笔记）不参与待办索引：/inspect 只查 todo 清单
        if (p.kind === 'note') continue;
        const pageId = typeof p.id === 'string' ? p.id : '';
        const pageTitle = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : 'P1';
        const content = typeof p.content === 'string' ? p.content : '';
        const items = extractPendingItems(content);
        if (pageId && items.length > 0) {
          pages.push({ pageId, pageTitle, items });
        }
      }
    } else if (rawContent.trim().length > 0) {
      // 老数据：content → P1
      const items = extractPendingItems(rawContent);
      if (items.length > 0) {
        pages.push({ pageId: 'pg-legacy', pageTitle: 'P1', items });
      }
    }
    if (pages.length > 0) {
      idxNotes.push({ noteId, title, color, pages });
    }
  }
  return { version: 1, updatedAt: new Date().toISOString(), notes: idxNotes };
}

const TODO_INDEX_FILE = 'todo-index.json';

/** 原子写 todo-index.json（与主文档同目录 sticky-notes/ 下） */
export async function writeTodoIndexFile(
  projectDir: string,
  notes: Array<Record<string, unknown>>,
): Promise<void> {
  const fs = require('fs/promises') as typeof import('fs/promises');
  const dir = join(projectDir, 'sticky-notes');
  await fs.mkdir(dir, { recursive: true });
  const target = join(dir, TODO_INDEX_FILE);
  const tmp = join(dir, `.${TODO_INDEX_FILE}.tmp`);
  const index = buildTodoIndex(notes);
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
  await fs.rename(tmp, target);
}

/** 读 todo-index.json；文件缺失/损坏/版本不符 → 返回 null（调用方回退扫描主文档） */
export async function readTodoIndexFile(projectDir: string): Promise<StickyTodoIndex | null> {
  const fs = require('fs/promises') as typeof import('fs/promises');
  try {
    const raw = await fs.readFile(join(projectDir, 'sticky-notes', TODO_INDEX_FILE), 'utf-8');
    const data = JSON.parse(raw) as StickyTodoIndex;
    if (data?.version !== 1 || !Array.isArray(data.notes)) return null;
    return data;
  } catch {
    return null;
  }
}