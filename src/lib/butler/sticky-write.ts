/**
 * lib/butler/sticky-write.ts —— 便签待办的**落盘原语**（server-only）
 *
 * 为什么单独一层：`create_sticky_note` 工具与规则执行器（rule-exec.ts，Phase 1 §3.4 的
 * `step.action === 'create_todo'`）都要「在项目便签上静默追加一张待办便签」。落盘逻辑（读现有便签、
 * 上限判定、颜色分配、坐标级联、原子写、索引同步、写后回读校验）必须**唯一一份**，
 * 否则两处漂移会写出不一致的便签结构。
 *
 * 依赖：只依赖 @/lib/sticky-todo（纯工具）与 fs。项目解析、回执文案仍由调用方负责。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from './fs-atomic';

/** 追加便签入参 */
export interface AppendStickyTodoInput {
  /** 项目根目录（便签落 <root>/sticky-notes/sticky-notes.json） */
  projectRoot: string;
  /** 项目名（默认便签标题） */
  projectName: string;
  /** 便签标题；缺省用项目名 */
  title?: string;
  /** 便签正文（待办事项文本） */
  content: string;
  /** 指定颜色；已被占用则自动换未用色 */
  color?: string;
}

/** 追加结果 */
export interface AppendStickyTodoResult {
  ok: boolean;
  /** 项目便签全集（已含新便签；调用方若要继续改（如入日历）应基于它写回） */
  notes: Array<Record<string, unknown>>;
  /** 新便签 id；受上限限制时为既有便签 id */
  noteId: string;
  /** 待办页 id（供入日历用） */
  pageId: string;
  /** 待办行下标（新建便签恒为 0） */
  lineIndex: number;
  title: string;
  color: string;
  /** 命中「每项目最多三张待办便签」上限，未新建 */
  limited?: boolean;
  /** ok=false 时的错误码 */
  error?: string;
  /** ok=false 时的说明 */
  message?: string;
}

/**
 * 在项目便签上静默追加一张待办便签（原子写 + 索引同步 + 写后回读校验）。
 * 便签为用户私有数据（AI 不可读回），本函数只负责写入，不返回内容、不触发确认。
 */
export async function appendStickyTodoNote(input: AppendStickyTodoInput): Promise<AppendStickyTodoResult> {
  const { projectRoot, projectName } = input;
  const stickyDir = join(projectRoot, 'sticky-notes');
  const stickyFile = join(stickyDir, 'sticky-notes.json');

  // 读取现有便签（文件不存在时视为空数组）
  let notes: Array<Record<string, unknown>> = [];
  try {
    const raw = await fs.readFile(stickyFile, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data?.notes)) notes = data.notes as Array<Record<string, unknown>>;
  } catch { /* 文件不存在或损坏 → 从空数组开始 */ }

  const content = String(input.content ?? '').trim();
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : (projectName || 'Untitled');
  if (!content) return { ok: false, notes, noteId: '', pageId: '', lineIndex: 0, title, color: '', error: 'content 不能为空' };

  const { MAX_TODO_NOTES, pickTodoNoteColor, normalizeStickyNote } = await import('@/lib/sticky-todo');
  // 每项目最多三张待办便签：已满三张时不新建，返回已有便签
  if (notes.length >= MAX_TODO_NOTES) {
    const existing = notes[0];
    return {
      ok: true,
      notes,
      noteId: typeof existing.id === 'string' ? existing.id : '',
      pageId: '',
      lineIndex: 0,
      title: typeof existing.title === 'string' ? existing.title : title,
      color: typeof existing.color === 'string' ? existing.color : 'yellow',
      limited: true,
    };
  }
  // 颜色自动与已有便签区分：优先调用方指定色，已被占用则取当前未使用色
  const color = pickTodoNoteColor(notes, typeof input.color === 'string' ? input.color : undefined);
  // 便签为屏幕像素定位，模型无法获知窗口尺寸 → 坐标一律由服务端级联分配，
  // 从源头避免模型自编坐标（如 1586）导致便签落在可视区外（2026-08-22 修复）
  const n = notes.length;
  const x = 40 + (n % 5) * 28;
  const y = 120 + (n % 5) * 28;
  const now = new Date().toISOString();
  const pageId = `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const noteId = `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const topZ = notes.reduce((m, nn) => Math.max(m, typeof nn.z === 'number' ? nn.z : 0), 0);

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

  // AI 静默创建的便签行不带事件锚点；行会在用户「结算」便签时自动入日历（2026-09-21 起语义）
  const arrToWrite = notes.map((nn) => normalizeStickyNote(nn as unknown as Record<string, unknown>));

  // 原子写入：先写临时文件再 rename，避免半写状态（统一走 fs-atomic：随机后缀 + 失败重试 + tmp 清理）
  await fs.mkdir(stickyDir, { recursive: true });
  await atomicWriteFile(stickyFile, JSON.stringify({ notes: arrToWrite }, null, 2));

  // 同步未完成待办索引（todo-index.json）；失败仅影响索引命中，回退全量扫描可自愈
  try {
    const { writeTodoIndexFile } = await import('@/lib/sticky-todo');
    await writeTodoIndexFile(projectRoot, arrToWrite);
  } catch { /* 索引同步失败不阻断 */ }

  // 写入后校验落点：回读文件，确认便签真的落在该项目目录里（防静默写偏 / 半写）
  try {
    const rawBack = await fs.readFile(stickyFile, 'utf-8');
    const back = JSON.parse(rawBack);
    const landed = Array.isArray(back?.notes) && back.notes.some((nn: { id?: string }) => nn?.id === noteId);
    if (!landed) {
      return {
        ok: false, notes: arrToWrite, noteId, pageId, lineIndex: 0, title, color,
        error: 'write_verification_failed',
        message: `便签写入后回读未命中 ${noteId}（预期落在 ${stickyFile}）——请复核，勿重复创建。`,
      };
    }
  } catch (e) {
    return {
      ok: false, notes: arrToWrite, noteId, pageId, lineIndex: 0, title, color,
      error: 'write_verification_failed',
      message: `便签写入后回读失败：${e instanceof Error ? e.message : String(e)}——请复核，勿重复创建。`,
    };
  }

  return { ok: true, notes: arrToWrite, noteId, pageId, lineIndex: 0, title, color };
}