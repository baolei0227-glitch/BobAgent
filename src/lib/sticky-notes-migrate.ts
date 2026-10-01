/**
 * 便签 note 页 → 全局笔记库迁移（2026-08 便签 note 模式停用）
 *
 * 设计约束：便签 todo 清单按项目隔离（<项目>/sticky-notes/sticky-notes.json），
 * 而 kind='note' 的笔记页真实数据迁入全局笔记库 ~/BobWork/butler/notebook.json，
 * 实现「笔记独立于项目」——删除/切换项目不影响笔记。
 *
 * 迁移入口（三者互相兜底，均幂等）：
 *  - GET /api/sticky-notes：访问项目画布时惰性迁移
 *  - deleteProject：删除项目文件夹前兜底迁移（防删项目丢笔记）
 *  - sweepAllStickyNotePages：启动全量清扫，处理从未打开过画布便签的存量项目
 *
 * 本文件独立于 route handler，避免 project-manager / instrumentation 反向依赖 route
 * 造成循环导入。
 */
import type { StickyNote } from '@/app/api/sticky-notes/route';
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join } from 'path';
import { writeTodoIndexFile } from '@/lib/sticky-todo';
import { callNotes } from '@/lib/mcp/notes-bridge';
import { readProjectRefs } from '@/lib/project/project-config';

const STICKY_DIR = 'sticky-notes';
const STICKY_FILE = 'sticky-notes.json';

/** 与 route.ts 一致的原子写（含待办索引同步）。迁移后写回以移除 note 页，保证下次扫描幂等 */
async function writeNotes(projectDir: string, notes: StickyNote[]): Promise<void> {
  const dir = join(projectDir, STICKY_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, STICKY_FILE);
  // 唯一临时名，避免与 route.ts / AI 工具并发写共用固定 tmp 名时互相踩踏（rename ENOENT）
  const tmp = join(dir, `.${STICKY_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  await writeFile(tmp, JSON.stringify({ notes }, null, 2), 'utf-8');
  await rename(tmp, target);
  // 索引同步失败不影响主文档写入（/inspect 会回退扫描主文档自愈）
  try {
    await writeTodoIndexFile(projectDir, notes);
  } catch (e) {
    console.error('[sticky-notes] 待办索引同步失败:', e);
  }
}

/**
 * 迁移便签中的 note 页（kind='note'）到统一笔记库 notebook.json。
 *  - 每页作为一条笔记：标题「<便签标题> · <页标题>」（便签无标题则用页标题），内容为页内行文本，
 *    分类 ["便签"]，日期取当天（与 /note 写入一致）
 *  - 迁移后从便签移除 note 页；某便签迁移后无剩余页 → 整张删除
 *  - 写回 sticky-notes.json 并同步 todo-index；无 note 页时零开销返回
 *  - 幂等：迁移完成后便签中不再存在 note 页
 */
export async function migrateStickyNotePages(projectDir: string): Promise<{ migrated: number; removedNotes: number }> {
  let notes: StickyNote[];
  try {
    const raw = await readFile(join(projectDir, STICKY_DIR, STICKY_FILE), 'utf-8');
    notes = JSON.parse(raw)?.notes ?? [];
  } catch {
    return { migrated: 0, removedNotes: 0 };
  }

  let migrated = 0;
  let dirty = false;
  const next: StickyNote[] = [];

  for (const n of notes) {
    const pages = Array.isArray(n.pages) ? n.pages : [];
    const notePages = pages.filter((p) => p.kind === 'note');
    const todoPages = pages.filter((p) => p.kind !== 'note');

    if (notePages.length > 0) {
      const noteTitle = (n.title || '').trim();
      for (const p of notePages) {
        const content = (p.content || '').trim();
        if (!content) continue;
        const title = noteTitle
          ? `${noteTitle} · ${(p.title || '').trim() || '笔记'}`
          : (p.title || '').trim() || '便签笔记';
        // 经 bob-notes-mcp 直接回填为 wiki 笔记（不经 LLM 编译，与宿主流 buildWikiEntry 等价）
        const r = await callNotes('backfill', { title, content, tags: ['便签'], type: 'note' });
        if (r.ok) {
          migrated++;
          dirty = true;
        } else {
          console.warn(`[sticky-notes] 便签笔记迁移失败（保留本地 note 页）: ${title}`, r.error);
        }
      }
    }

    // 仅含 note 页的便签 → 整体删除；含 todo 页的 → 移除 note 页保留 todo
    if (todoPages.length === 0 && notePages.length > 0) continue;
    if (notePages.length > 0) {
      const activePageId =
        todoPages.some((p) => p.id === n.activePageId)
          ? n.activePageId
          : todoPages[0]?.id;
      next.push({ ...n, pages: todoPages, activePageId, content: undefined });
    } else {
      next.push(n);
    }
  }

  if (dirty) await writeNotes(projectDir, next);
  return { migrated, removedNotes: notes.length - next.length };
}

/**
 * 启动全量清扫（幂等）：遍历所有项目，把仍残留在各项目 sticky-notes/sticky-notes.json
 * 中的 note 页（kind='note'）迁入全局笔记库 notebook.json。
 * 兜底处理从未触发过 GET 惰性迁移的存量项目——它们的 note 页若不迁移，删除项目即丢失。
 * 经 project-config 只读读取项目引用，避免与 project-manager 形成循环依赖。
 */
export async function sweepAllStickyNotePages(): Promise<{ projects: number; migrated: number }> {
  const projects = await readProjectRefs();
  let migrated = 0;
  for (const p of projects) {
    const res = await migrateStickyNotePages(p.path);
    migrated += res.migrated;
  }
  if (migrated > 0) {
    console.log(
      `[sticky-notes] 启动全量清扫：扫描 ${projects.length} 个项目，迁移 ${migrated} 条便签笔记到全局笔记库`,
    );
  }
  return { projects: projects.length, migrated };
}
