/**
 * /inspect —— 跨项目聚合 Sticky 便签未完成待办
 *
 * 数据源优先读各项目下 sticky-notes/todo-index.json（增量索引，见 lib/sticky-todo.ts），
 * 索引缺失/损坏/版本不符时回退为扫描主文档 sticky-notes.json 重建（幂等自愈）。
 * 结果按「项目 → sticky note → page」三级折叠组织，供 executor（/inspect 命令）
 * 生成 BobMail 邮件正文。
 */
import { join } from 'path';
import { listProjects, ProjectConfig } from '@/lib/project/project-manager';
import {
  readTodoIndexFile,
  writeTodoIndexFile,
  buildTodoIndex,
  StickyTodoIndex,
  StickyTodoIndexNote,
} from '@/lib/sticky-todo';

export type InspectProject = {
  projectId: string;
  projectName: string;
  isCurrent: boolean;
  notes: StickyTodoIndexNote[];
  /** 该项目未完成待办行总数（跨便签/页合计） */
  pendingCount: number;
};

export type InspectScope = 'current' | 'all';

export type InspectResult = {
  projects: InspectProject[];
  /** 本次查询范围：'current'=仅当前项目 / 'all'=所有活跃项目 */
  scope: InspectScope;
  /** 关键词模糊过滤（多词元 OR 匹配待办行 / 页标题 / 便签标题 / 项目名；空 = 不过滤） */
  keyword?: string;
  /** 有便签待办的项目数 */
  projectCount: number;
  /** 含待办的便签总数 */
  noteCount: number;
  /** 全部未完成待办行数 */
  totalPending: number;
  /** 本次是否走索引（false = 回退全量扫描主文档） */
  fromIndex: boolean;
  /** 无待办时给出空态文案，否则为 null */
  empty?: boolean;
};

/** 文本归一化：小写 + 全角空格→半角 + 全角字母数字→半角（提升模糊命中率） */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u3000]/g, ' ')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 把输入关键词切分为多个词元（按空白 / 中英文逗号 / 顿号 / 分号 / 斜杠分隔），任一命中即算模糊命中 */
function splitKeywords(keyword: string): string[] {
  return normalizeText(keyword)
    .split(/[\s,，、;；/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 模糊包含：字段归一化后包含任一关键词词元即命中（OR 逻辑） */
function fuzzyIncludes(field: string | null | undefined, tokens: string[]): boolean {
  if (!field || tokens.length === 0) return false;
  const norm = normalizeText(field);
  return tokens.some((t) => norm.includes(t));
}

/**
 * 关键词模糊过滤：命中项目名 → 保留整项目；否则命中便签标题 / noteId → 保留整张便签；
 * 否则命中页标题 → 保留整页；最后只保留命中关键词词元的待办行。
 * 支持多关键词（空白/逗号/顿号/分号分隔），任一命中即保留（OR）；大小写、全半角不敏感。
 */
function filterByKeyword(
  projects: InspectProject[],
  keyword: string,
): InspectProject[] {
  const tokens = splitKeywords(keyword);
  if (tokens.length === 0) return projects;
  const out: InspectProject[] = [];
  for (const p of projects) {
    const nameHit = fuzzyIncludes(p.projectName, tokens);
    if (nameHit) {
      if (p.notes.length > 0) out.push(p);
      continue;
    }
    const keptNotes: StickyTodoIndexNote[] = [];
    for (const n of p.notes) {
      const titleHit = fuzzyIncludes(n.title, tokens) || fuzzyIncludes(n.noteId, tokens);
      const keptPages = titleHit
        ? n.pages
        : n.pages
            .map((pg) => {
              const pageHit = fuzzyIncludes(pg.pageTitle, tokens);
              if (pageHit) return pg;
              return {
                ...pg,
                items: (pg.items ?? []).filter((it) => fuzzyIncludes(it, tokens)),
              };
            })
            .filter((pg) => (pg.items ?? []).length > 0);
      if (keptPages.length > 0) {
        keptNotes.push({ ...n, pages: keptPages });
      }
    }
    if (keptNotes.length > 0) {
      out.push({ ...p, notes: keptNotes });
    }
  }
  return out;
}

/** 读取项目 sticky 主文档（sticky-notes.json）并仅提取未完成待办 —— 索引缺失时的回退路径（重建索引，幂等自愈） */
async function readStickyMainAsIndex(projectDir: string): Promise<StickyTodoIndex> {
  const fs = require('fs/promises') as typeof import('fs/promises');
  try {
    const raw = await fs.readFile(join(projectDir, 'sticky-notes', 'sticky-notes.json'), 'utf-8');
    const data = JSON.parse(raw) as { notes?: Array<Record<string, unknown>> };
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const index = buildTodoIndex(notes);
    // 重建索引写盘，下次 /inspect 直接走索引
    try {
      await writeTodoIndexFile(projectDir, notes);
    } catch { /* 回退路径写盘失败不阻断本次查询 */ }
    return index;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), notes: [] };
  }
}

/** 合并多项目聚合结果（含当前项目标记与统计），供 executor 使用。
 *  scope='current'：只扫当前活跃项目；scope='all'：扫全部活跃项目。
 *  keyword：可选，匹配待办行 / 便签标题 / 项目名（大小写不敏感）。
 */
export async function inspectStickyTodos(
  scope: InspectScope = 'current',
  keyword?: string,
): Promise<InspectResult> {
  const { projects, active_projects, currentId } = await listProjects();
  const activeList: ProjectConfig[] =
    active_projects.length > 0 ? active_projects : projects.filter((p) => !p.archived);

  // 范围过滤：current 只保留当前项目（无当前项目时回退为 all 语义，避免空结果误导）
  let targets = activeList;
  if (scope === 'current' && currentId) {
    const cur = activeList.find((p) => p.id === currentId);
    if (cur) targets = [cur];
  }

  const result: InspectResult = {
    projects: [],
    scope,
    keyword: keyword?.trim() || undefined,
    projectCount: 0,
    noteCount: 0,
    totalPending: 0,
    fromIndex: true,
  };

  let anyFromIndex = true;
  for (const p of targets) {
    let index: StickyTodoIndex | null = await readTodoIndexFile(p.path);
    let fromIndex = true;
    if (!index) {
      // 索引缺失/损坏 → 回退扫描主文档并重建索引（自愈）
      index = await readStickyMainAsIndex(p.path);
      fromIndex = false;
    }
    if (!fromIndex) anyFromIndex = false;

    let notes = index.notes;
    // 容错：某些索引可能来自损坏状态，只保留结构合法的条目
    notes = notes.filter(
      (n) => n && typeof n.noteId === 'string' && Array.isArray(n.pages),
    );

    const pendingCount = notes.reduce((sum, n) => {
      return sum + n.pages.reduce((s2, pg) => s2 + (Array.isArray(pg.items) ? pg.items.length : 0), 0);
    }, 0);

    result.projects.push({
      projectId: p.id,
      projectName: p.name || p.id,
      isCurrent: p.id === currentId,
      notes,
      pendingCount,
    });
  }

  // 关键词过滤（命中项目名/便签标题/待办行），空关键词不过滤
  let scopedProjects = result.projects;
  if (result.keyword) {
    scopedProjects = filterByKeyword(scopedProjects, result.keyword);
  }
  result.projects = scopedProjects;

  const withTodos = result.projects.filter((x) => x.pendingCount > 0);
  result.projectCount = withTodos.length;
  result.noteCount = withTodos.reduce((s, x) => s + x.notes.length, 0);
  result.totalPending = withTodos.reduce((s, x) => s + x.pendingCount, 0);
  result.fromIndex = anyFromIndex;
  result.empty = result.totalPending === 0;
  if (result.empty) {
    result.projects = [];
  }
  return result;
}

/** 生成 BobMail 邮件正文（Markdown，三级折叠，无待办时给空态文案） */
export function formatInspectReply(r: InspectResult): string {
  const scopeLabel = r.scope === 'all' ? '全项目' : '当前项目';
  const kwLabel = r.keyword ? ` · 关键词「${r.keyword}」` : '';
  if (r.empty) {
    return `📋 Sticky 待办检查（${scopeLabel}${kwLabel}）· 暂无未完成待办\n\n没有匹配的未完成待办 🎉\n（跳过无待办项目，索引自动同步中）`;
  }
  const lines: string[] = [
    `📋 Sticky 未完成待办（${scopeLabel}${kwLabel}）· ${r.projectCount} 个项目 / ${r.noteCount} 张便签 / ${r.totalPending} 项待办\n`,
  ];
  for (const p of r.projects) {
    if (p.pendingCount === 0) continue;
    lines.push(`■ ${p.projectName}${p.isCurrent ? '（当前）' : ''} — ${p.pendingCount} 项`);
    for (const n of p.notes) {
      const noteLabel = n.title ? `◇ ${n.title}` : `◇ ${n.noteId}`;
      lines.push(`  ${noteLabel}`);
      for (const pg of n.pages) {
        const items = (pg.items ?? []).filter((it) => typeof it === 'string' && it.trim());
        if (items.length === 0) continue;
        lines.push(`    · ${pg.pageTitle || 'P1'}`);
        for (const it of items) {
          lines.push(`      ☐ ${it}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}