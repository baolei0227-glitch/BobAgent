/**
 * 项目流水账（Activity Log）——只读派生聚合。
 *
 * 不做任何埋点、不改任何 schema，全部从磁盘事实源派生：
 *   - 项目创建 / 归档 / 回收站 → ~/BobWork/.projects.json（ProjectConfig 的生命周期字段）
 *   - 任务执行 → notes-memory/*.md 的对话轮次块（### Q / ### A，含 taskId）
 *   - 附件添加 → materials/ 目录文件（时间用 mtime 近似）
 *   - 文档生成 → homework/ 目录产物（时间用 mtime 近似）
 *
 * 输出按日期（本地时区）分组，支持升降序、类型过滤与偏移游标分页。
 */

import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { parseNodeMarkdown } from '@/lib/node-markdown';
import type { ProjectConfig } from './project-manager';

export type ActivityKind = 'project' | 'task' | 'attachment' | 'document' | 'lifecycle';

export const ACTIVITY_KINDS: ActivityKind[] = ['project', 'task', 'attachment', 'document', 'lifecycle'];

export interface ActivityItem {
  /** 稳定唯一 id（同一条目重复请求保持一致，供前端 key / 去重） */
  id: string;
  kind: ActivityKind;
  /** ISO 时间串 */
  ts: string;
  /** 主文案，如「执行任务」/ 文件名 / 项目名 */
  title: string;
  /** 附加说明（任务节点名、问题摘要等） */
  detail?: string;
  /** 可跳转的节点 id（任务条目） */
  nodeId?: string;
  /** 相对项目根的路径（附件 / 文档条目） */
  path?: string;
  /** 文件大小（字节，附件 / 文档条目） */
  size?: number;
  /** 文件扩展名（含点，小写；附件 / 文档条目） */
  extension?: string;
}

export interface ActivityGroup {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  items: ActivityItem[];
}

export interface ProjectActivityOptions {
  order?: 'asc' | 'desc';
  /** 类型过滤；缺省返回全部 */
  kinds?: ActivityKind[];
  /** 偏移游标（上一页返回的 nextCursor），缺省 0 */
  cursor?: number;
  /** 每页条数，缺省 100，上限 500 */
  limit?: number;
}

export interface ProjectActivityResult {
  groups: ActivityGroup[];
  /** 过滤后的条目总数 */
  total: number;
  /** 下一页游标；无更多数据为 null */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** 扫描目录下全部文件（跳过隐藏文件/目录，最多 6 层），返回相对项目根的路径与文件信息 */
async function scanFiles(
  projectPath: string,
  subDir: string,
  opts?: { skipTopLevel?: string[]; maxDepth?: number; stripHashPrefix?: boolean },
): Promise<{ name: string; rel: string; size: number; mtime: Date; extension: string }[]> {
  const root = join(projectPath, subDir);
  const out: { name: string; rel: string; size: number; mtime: Date; extension: string }[] = [];
  const skipTopLevel = new Set(opts?.skipTopLevel ?? []);
  const maxDepth = opts?.maxDepth ?? 6;

  const walk = async (dir: string, relDir: string, depth: number) => {
    if (depth <= 0) return;
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (relDir === '' && entry.isDirectory() && skipTopLevel.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel, depth - 1);
      } else {
        try {
          const stat = await fs.stat(full);
          out.push({
            name: opts?.stripHashPrefix ? entry.name.replace(/^[a-f0-9-]+_/, '') : entry.name,
            rel: `${subDir}/${rel}`,
            size: stat.size,
            mtime: stat.mtime,
            extension: extname(entry.name).toLowerCase(),
          });
        } catch { /* 单文件读取失败忽略 */ }
      }
    }
  };

  await walk(root, '', maxDepth);
  return out;
}

/** 解析 notes-memory/*.md 的对话轮次，产出「执行任务」条目 */
async function collectTaskItems(projectPath: string): Promise<ActivityItem[]> {
  const notesDir = join(projectPath, 'notes-memory');
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = await fs.readdir(notesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: ActivityItem[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith('.md')) continue;
    let content: string;
    try {
      content = await fs.readFile(join(notesDir, entry.name), 'utf-8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parseNodeMarkdown(content);
    } catch {
      continue; // 非法 / 旧格式文件跳过
    }
    const nodeId = parsed.frontmatter.node_id;
    const nodeTitle = parsed.frontmatter.title;
    parsed.conversations.forEach((turn, index) => {
      const ts = turn.answerTime || turn.questionTime;
      if (!ts || Number.isNaN(new Date(ts).getTime())) return;
      const question = turn.question.replace(/\s+/g, ' ').trim();
      items.push({
        id: `task:${nodeId}:${turn.anchor || turn.taskId || index}`,
        kind: 'task',
        ts,
        title: '执行任务',
        detail: question.length > 90 ? `${question.slice(0, 90)}…` : question || nodeTitle,
        nodeId,
      });
    });
  }
  return items;
}

/** 本地时区日期键 YYYY-MM-DD */
function toLocalDateKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 聚合某项目的全部流水账条目（未分页），按 order 排序。
 * 调用方负责分页与分组，或直接使用 collectProjectActivity。
 */
export async function collectProjectActivity(
  project: ProjectConfig,
  options: ProjectActivityOptions = {},
): Promise<ProjectActivityResult> {
  const order = options.order === 'asc' ? 'asc' : 'desc';
  const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : ACTIVITY_KINDS;
  const kindSet = new Set(kinds);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = Math.max(options.cursor ?? 0, 0);

  const [taskItems, materialFiles, homeworkFiles] = await Promise.all([
    collectTaskItems(project.path),
    scanFiles(project.path, 'materials', { stripHashPrefix: true }),
    scanFiles(project.path, 'homework', { skipTopLevel: ['template'] }),
  ]);

  const items: ActivityItem[] = [];

  // 1) 项目创建
  if (project.created_at && !Number.isNaN(new Date(project.created_at).getTime())) {
    items.push({
      id: `project:created:${project.id}`,
      kind: 'project',
      ts: project.created_at,
      title: '创建项目',
      detail: project.name,
    });
  }

  // 2) 生命周期（归档 / 回收站；仅有最终态时间）
  if (project.archived && project.archived_at) {
    items.push({
      id: `lifecycle:archived:${project.id}`,
      kind: 'lifecycle',
      ts: project.archived_at,
      title: '归档项目',
      detail: project.name,
    });
  }
  if (project.trashed && project.trashed_at) {
    items.push({
      id: `lifecycle:trashed:${project.id}`,
      kind: 'lifecycle',
      ts: project.trashed_at,
      title: '移入回收站',
      detail: project.name,
    });
  }

  // 3) 任务执行
  items.push(...taskItems);

  // 4) 附件添加（mtime 近似）
  for (const f of materialFiles) {
    items.push({
      id: `attachment:${f.rel}`,
      kind: 'attachment',
      ts: f.mtime.toISOString(),
      title: f.name,
      detail: '添加附件',
      path: f.rel,
      size: f.size,
      extension: f.extension,
    });
  }

  // 5) 文档生成（mtime 近似）
  for (const f of homeworkFiles) {
    items.push({
      id: `document:${f.rel}`,
      kind: 'document',
      ts: f.mtime.toISOString(),
      title: f.name,
      detail: '生成文档',
      path: f.rel,
      size: f.size,
      extension: f.extension,
    });
  }

  const filtered = items.filter((it) => kindSet.has(it.kind));
  const dir = order === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const ta = new Date(a.ts).getTime();
    const tb = new Date(b.ts).getTime();
    if (ta !== tb) return (ta - tb) * dir;
    return a.id < b.id ? -dir : a.id > b.id ? dir : 0;
  });

  const total = filtered.length;
  const page = filtered.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < total ? String(cursor + limit) : null;

  // 按日期分组（保持排序后的顺序）
  const groups: ActivityGroup[] = [];
  let current: ActivityGroup | null = null;
  for (const item of page) {
    const date = toLocalDateKey(item.ts);
    if (!current || current.date !== date) {
      current = { date, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }

  return { groups, total, nextCursor };
}
