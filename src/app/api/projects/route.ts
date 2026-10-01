import { NextRequest, NextResponse } from 'next/server';
import {
  listProjects,
  getCurrentProject,
  createProject,
  switchProject,
  deleteProject,
  restoreProject,
  purgeProject,
  renameProject,
  validateProjectParentDir,
  getDefaultProjectDir,
  setDefaultProjectDir,
  resetDefaultProjectDir,
  isCustomDefaultProjectDir,
  getProjectsDir,
  syncProjectsFromDisk,
  archiveProject,
  unarchiveProject,
  getProjectStats,
  updateProjectMeta,
  type ProjectConfig,
} from '@/lib/project/project-manager';
import { PROJECT_CATEGORIES, PROJECT_TAG_LIMIT } from '@/lib/types';
import { inspectStickyTodos } from '@/lib/core/inspect';
import { promises as fs } from 'fs';
import { join, extname, dirname } from 'path';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { classifyOutputKind, HOMEWORK_KIND_LABEL, HOMEWORK_KIND_ORDER, type HomeworkKind } from '@/lib/homework/kind';

/** 截断后的文件名主体最长字符数（不含扩展名） */
const OUTPUT_STEM_MAX = 40;

/**
 * 输出文件名兜底：清洗非法字符 + 截断超长主体（保留目录与扩展名）。
 * 返回 { path, truncated }，truncated 表示是否发生了长度截断（供调用方决定是否去重）。
 */
function sanitizeOutputFilename(filePath: string): { path: string; truncated: boolean } {
  const slash = filePath.lastIndexOf('/');
  const dir = slash >= 0 ? filePath.slice(0, slash + 1) : '';
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const ext = extname(base);
  let stem = ext ? base.slice(0, base.length - ext.length) : base;
  // 清洗非法字符（Windows 保留字符 + 控制字符）并去掉首尾空白/点
  stem = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. \t]+$/g, '');
  const truncated = stem.length > OUTPUT_STEM_MAX;
  if (truncated) stem = stem.slice(0, OUTPUT_STEM_MAX);
  return { path: `${dir}${stem}${ext}`, truncated };
}

/** 判断路径是否存在 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface FileNode {
  name: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  extension?: string;
  /** 相对扫描根目录（项目根）的路径，如 homework/报告.md；树形摊平后仍可据此解析真实路径 */
  rel: string;
  /** 会话标题（materials/ 与历史 attachments/ 下的节点附件目录：由短 id 关联 notes-memory node 元数据填充，仅展示用） */
  title?: string;
}

/** 递归扫描目录，返回文件树（最大深度5层，跳过隐藏文件、node_modules 和 .db）。
 *  深度需 ≥4 才能覆盖 ImageGen 产物路径 homework/Image/{nodeId}/v1.png */
async function scanDirectory(dirPath: string, maxDepth = 5, relDir = ''): Promise<FileNode[]> {
  const result: FileNode[] = [];
  if (maxDepth <= 0) return result;

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return result;
  }

  // homework 置顶，materials 紧随其后，然后目录优先，最后按名称排序
  entries.sort((a, b) => {
    const aHw = a.isDirectory() && a.name === 'homework';
    const bHw = b.isDirectory() && b.name === 'homework';
    if (aHw !== bHw) return aHw ? -1 : 1;
    const aMat = a.isDirectory() && a.name === 'materials';
    const bMat = b.isDirectory() && b.name === 'materials';
    if (aMat !== bMat) return aMat ? -1 : 1;
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    // 跳过 BobWork 内部数据目录（sticky-notes、notes-memory、butler 等）
    if (entry.isDirectory() && (entry.name === 'sticky-notes' || entry.name === 'notes-memory' || entry.name === 'butler')) continue;
    // 跳过 SQLite 数据库及其 WAL/SHM 辅助文件（.project.db / .project.db-shm / .project.db-wal）
    if (!entry.isDirectory() && /\.db(-shm|-wal)?$/i.test(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const children = await scanDirectory(fullPath, maxDepth - 1, rel);
      result.push({ name: entry.name, type: 'directory', rel, children });
    } else {
      const ext = extname(entry.name).toLowerCase();
      result.push({ name: entry.name, type: 'file', extension: ext, rel });
    }
  }

  return result;
}

/** 文件树展示优化（homework/template 区）：隐藏模板填充生成的 .zip（与解压文档重复），
 *  并将 set_* 解压目录摊平到所属 template-fill-* 运行目录下，使生成文档直接可见。
 *  仅影响展示，磁盘结构不变；摊平节点的真实路径仍由 FileNode.rel 保留。 */
function flattenTemplateTree(nodes: FileNode[]): FileNode[] {
  const walk = (list: FileNode[]): FileNode[] => {
    const out: FileNode[] = [];
    for (const n of list) {
      const inTemplate = n.rel === 'homework/template' || n.rel.startsWith('homework/template/');
      if (inTemplate && n.type === 'file' && n.extension === '.zip') continue;
      if (n.type === 'directory') {
        const children = n.children ? walk(n.children) : undefined;
        // set_000 等解压目录：其文档上提一层，目录本身不再展示
        if (inTemplate && /^set_\d+$/.test(n.name)) {
          out.push(...(children ?? []));
          continue;
        }
        out.push({ ...n, children });
      } else {
        out.push(n);
      }
    }
    return out;
  };
  return walk(nodes);
}

/** 解析 notes-memory/*.md 的 frontmatter，建立 node_id → { title, sandbox_app_id } 映射 */
async function parseNodeMeta(notesDir: string): Promise<Map<string, { title: string; sandboxAppId?: string }>> {
  const map = new Map<string, { title: string; sandboxAppId?: string }>();
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = await fs.readdir(notesDir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith('.md')) continue;
    try {
      const content = await fs.readFile(join(notesDir, entry.name), 'utf-8');
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) continue;
      const nodeId = fm[1].match(/node_id:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
      const title = fm[1].match(/title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
      const sandboxAppId = fm[1].match(/sandbox_app_id:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
      if (nodeId) {
        map.set(nodeId, { title: title || nodeId.slice(0, 8), sandboxAppId: sandboxAppId || undefined });
      }
    } catch { /* 单文件解析失败忽略 */ }
  }
  return map;
}

/** 类别分组文件项：path 相对项目根（source=project，如 homework/报告.md）或绝对路径（source=local，如 bob-sandbox 小程序文件） */
interface HomeworkKindFile {
  name: string;
  extension?: string;
  path: string;
  source?: 'project' | 'local';
}

/** 扫描 homework/ 下输出文件，按 kind 类别分组（不再按节点分组）：
 *  - homework/ 下全部文件（含子目录）：按扩展名 classifyOutputKind 归入对应类别桶
 *    （doc/sheet/slide/pdf/image/text/code/other），跳过隐藏目录（.ai-workspace/.crops）
 *    与 template/ 特殊输出区（其在 Files 树可见，不进类别分组，避免 zip+解压目录噪声）
 *  - bob-sandbox/apps/<appId>/ 文件：当前项目 Coding 节点小程序产物（经 notes-memory
 *    sandbox_app_id 关联过滤，避免泄漏其他项目），按扩展名归入类别桶，source=local + 绝对路径
 *  类别顺序固定为 HOMEWORK_KIND_ORDER，仅含有文件的类别出现。 */
async function scanHomeworkByKind(projectPath: string): Promise<{
  groups: { kind: HomeworkKind; label: string; files: HomeworkKindFile[] }[];
}> {
  const homeworkRoot = join(projectPath, 'homework');
  const buckets = new Map<HomeworkKind, HomeworkKindFile[]>();
  const ensure = (k: HomeworkKind): HomeworkKindFile[] => {
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    return arr;
  };

  // 1) homework/ 下全部文件（含子目录），按扩展名分类到 kind 桶。
  //    跳过隐藏目录（.ai-workspace/.crops/.ownership.json）与 template/ 特殊输出区。
  const walkHomework = async (dir: string, relDir: string) => {
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      // template/ 是模板生成器的结构化输出区（zip + 解压目录），整体跳过，其文件在 Files 树可见
      if (relDir === '' && e.isDirectory() && e.name === 'template') continue;
      const full = join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walkHomework(full, rel);
      } else {
        const kind = classifyOutputKind(e.name);
        ensure(kind).push({ name: e.name, extension: extname(e.name).toLowerCase(), path: `homework/${rel}`, source: 'project' });
      }
    }
  };
  await walkHomework(homeworkRoot, '');

  // 2) bob-sandbox/apps/<appId>/：当前项目 Coding 节点的小程序产物，按扩展名分类到 kind 桶（source=local）。
  //    经 parseNodeMeta 过滤只取本项目的 sandbox_app_id，避免泄漏其他项目的小程序文件。
  const nodeTitles = await parseNodeMeta(join(projectPath, 'notes-memory'));
  const sandboxAppsRoot = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');
  for (const [, meta] of nodeTitles) {
    if (!meta.sandboxAppId) continue;
    const appDir = join(sandboxAppsRoot, meta.sandboxAppId);
    let fileEntries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      fileEntries = await fs.readdir(appDir, { withFileTypes: true });
    } catch { continue; }
    for (const f of fileEntries) {
      if (f.isDirectory() || f.name.startsWith('.')) continue;
      const kind = classifyOutputKind(f.name);
      ensure(kind).push({ name: f.name, extension: extname(f.name).toLowerCase(), path: join(appDir, f.name), source: 'local' });
    }
  }

  // 按 HOMEWORK_KIND_ORDER 输出，仅含有文件的类别
  const groups = HOMEWORK_KIND_ORDER
    .map((k) => ({ kind: k, label: HOMEWORK_KIND_LABEL[k], files: buckets.get(k) ?? [] }))
    .filter((g) => g.files.length > 0);

  return { groups };
}

/** homework 归属视图：文件（相对 homework 根）→ 来源会话 { node_id, 会话标题, 修改时间 }。
 *  数据源：homework/.ownership.json（文件 → node_id）+ notes-memory 的 node 元数据（标题）。
 *  mtimeMs 供侧边栏「按来源会话分组」按最近产出排序；已删除 / 已归档条目不返回（前端也不会渲染）。 */
async function scanHomeworkOwners(
  projectPath: string,
): Promise<Record<string, { nodeId: string; title?: string; mtimeMs: number }>> {
  const homeworkRoot = join(projectPath, 'homework');
  let manifest: Record<string, string> = {};
  try {
    manifest = JSON.parse(await fs.readFile(join(homeworkRoot, '.ownership.json'), 'utf-8')) as Record<string, string>;
  } catch {
    return {}; // 无清册或损坏：无归属信息，前端文件全部落到 Ungrouped
  }
  const meta = await parseNodeMeta(join(projectPath, 'notes-memory'));
  const owners: Record<string, { nodeId: string; title?: string; mtimeMs: number }> = {};
  for (const [rel, nodeId] of Object.entries(manifest)) {
    if (!rel || typeof nodeId !== 'string' || !nodeId) continue;
    const st = await fs.stat(join(homeworkRoot, rel)).catch(() => null);
    if (!st || !st.isFile()) continue; // 磁盘上已不存在（删除 / 归档）→ 不返回
    owners[rel] = { nodeId, title: meta.get(nodeId)?.title, mtimeMs: st.mtimeMs };
  }
  return owners;
}

/** 从项目 Sticky 待办解析未来最近的开庭日期，返回 YYYY-MM-DD。
 *  日期来源（二选一，取更早）：
 *   1. 该行绑定的日历事件开始时间（lineEventIds → events 表；2026-09-08 起行内不再写日期，日期存事件）
 *   2. 行文本里固定格式日期（YYYY/M/D 或 YYYY年M月D日 …开庭，兼容老数据）
 */
async function scanHearingDate(projectDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(projectDir, 'sticky-notes', 'sticky-notes.json'), 'utf-8');
    const data = JSON.parse(raw);
    const notes = Array.isArray(data?.notes) ? data.notes : [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let best: Date | null = null;
    const addCandidate = (d: Date) => {
      if (Number.isNaN(d.getTime()) || d < today) return;
      if (!best || d < best) best = d;
    };
    // 事件表按需懒加载（无开庭行/无锚点时零开销）
    const { getCalendarDb, getEvent } = await import('@/lib/db');
    const db = await getCalendarDb();
    for (const n of notes) {
      const pages = Array.isArray(n.pages) ? n.pages : [];
      for (const pg of pages) {
        if (pg.kind === 'note') continue;
        const content = typeof pg.content === 'string' ? pg.content : '';
        const rows = content.split('\n');
        const evsArr = Array.isArray(pg.lineEventIds) ? (pg.lineEventIds as unknown[][]) : [];
        for (let i = 0; i < rows.length; i++) {
          const line = rows[i];
          if (!line.includes('开庭')) continue;
          // 已勾选完成的待办行（- [x] …）不再计入开庭提醒，与 todo-index 未完成统计口径一致
          if (/^\s*-\s*\[x\]/i.test(line)) continue;
          // 1) 锚点事件优先：行已入日历 → 用事件开始时间（行文本不含日期时也能识别）
          const anchors = evsArr[i];
          if (Array.isArray(anchors)) {
            let usedEvent = false;
            for (const id of anchors as string[]) {
              if (!id) continue;
              try {
                const row = await getEvent(db, id);
                if (row?.status === 'scheduled' && row.start_time) {
                  const dt = new Date(row.start_time);
                  if (Number.isFinite(dt.getTime())) {
                    addCandidate(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()));
                    usedEvent = true;
                  }
                }
              } catch {
                /* 单条事件读取失败忽略 */
              }
            }
            if (usedEvent) continue;
          }
          // 2) 行文本固定格式日期（老数据兜底）
          const m = line.match(/(\d{4})[/年](\d{1,2})[/月](\d{1,2})日?/);
          if (!m) continue;
          addCandidate(new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
        }
      }
    }
    if (!best) return null;
    const b = best as Date;
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${b.getFullYear()}-${pad(b.getMonth() + 1)}-${pad(b.getDate())}`;
  } catch {
    return null;
  }
}

/** GET: 获取项目列表或当前项目 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');

    // PDF 等二进制文件的代理流
    if (action === 'file_proxy') {
      const projectId = searchParams.get('project_id');
      const filePath = searchParams.get('file_path');
      if (!projectId || !filePath) {
        return new NextResponse('Missing params', { status: 400 });
      }
      const { projects } = await listProjects();
      const project = projects.find((p: ProjectConfig) => p.id === projectId);
      if (!project) {
        return new NextResponse('Project not found', { status: 404 });
      }
      const fullPath = join(project.path, filePath);
      if (!fullPath.startsWith(project.path)) {
        return new NextResponse('Forbidden', { status: 403 });
      }

      try {
        const stat = await fs.stat(fullPath);
        const buffer = await fs.readFile(fullPath);
        const ext = extname(fullPath).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.htm': 'text/html; charset=utf-8',
          '.pdf': 'application/pdf',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml',
        };
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            'Content-Type': mimeMap[ext] || 'application/octet-stream',
            'Content-Length': String(stat.size),
            // 打开时刻的 mtime 哨兵：docx 编辑器（DocxTiptapEditor）记录后，更新原稿前比对该值，检测文件是否被 WPS 等外部程序改过
            'X-File-Mtime': String(stat.mtimeMs),
            'Cache-Control': 'public, max-age=3600',
          },
        });
      } catch {
        return new NextResponse('File not found', { status: 404 });
      }
    }

    if (action === 'current') {
      const current = await getCurrentProject();
      return NextResponse.json({ success: true, project: current });
    }

    if (action === 'stats') {
      const projectId = searchParams.get('project_id');
      if (!projectId) {
        return NextResponse.json({ success: false, error: 'project_id is required' }, { status: 400 });
      }
      const stats = await getProjectStats(projectId);
      return NextResponse.json({ success: true, stats });
    }

    // 默认返回项目列表（含分组）
    // 磁盘对账：手动放入工作区目录（如从 Finder 拖入）的文件夹自动注册为项目，列表实时跟随磁盘变化
    await syncProjectsFromDisk();
    const result = await listProjects();
    const defaultProjectDir = await getDefaultProjectDir();
    const builtinProjectsDir = getProjectsDir();
    // 项目看板：批量统计各项目节点数（notes-memory/*.md 数量），附加到各分组条目
    const nodeCounts = new Map<string, number>();
    await Promise.all(
      result.projects.map(async (p) => {
        try {
          const files = await fs.readdir(join(p.path, 'notes-memory'));
          nodeCounts.set(p.id, files.filter((f) => f.endsWith('.md')).length);
        } catch {
          nodeCounts.set(p.id, 0);
        }
      }),
    );
    // 项目看板：批量统计各项目 Sticky 便签未完成待办数（todo-index.json，索引缺失自动回退重建）
    const todoCounts = new Map<string, number>();
    try {
      const todoRes = await inspectStickyTodos('all');
      for (const pr of todoRes.projects) {
        todoCounts.set(pr.projectId, pr.pendingCount);
      }
    } catch {
      /* 待办统计失败不阻塞项目列表 */
    }
    // 项目看板：从 Sticky 待办文本解析未来最近的开庭日期（固定格式 YYYY/M/D ...开庭）
    const hearingDates = new Map<string, string>();
    await Promise.all(
      result.projects.map(async (p) => {
        const d = await scanHearingDate(p.path);
        if (d) hearingDates.set(p.id, d);
      }),
    );
    const enrich = <T extends { id: string }>(arr: T[]) =>
      arr.map((p) => ({
        ...p,
        node_count: nodeCounts.get(p.id) ?? 0,
        todo_count: todoCounts.get(p.id) ?? 0,
        hearing_date: hearingDates.get(p.id) ?? null,
      }));
    return NextResponse.json({
      success: true,
      projects: enrich(result.projects),
      active_projects: enrich(result.active_projects),
      archived_projects: enrich(result.archived_projects),
      trashed_projects: enrich(result.trashed_projects),
      current_id: result.currentId,
      default_project_dir: defaultProjectDir,
      default_projects_dir: builtinProjectsDir,
      is_custom_default_dir: await isCustomDefaultProjectDir(),
    });
  } catch (error) {
    console.error('[projects:GET] error', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** POST: 创建/切换/删除/重命名项目 */
export async function POST(request: NextRequest) {
  let action: unknown = '';
  try {
    const body = await request.json();
    action = body?.action ?? '';

    if (action === 'create') {
      const { name, category, note, tags } = body;
      if (!name || !name.trim()) {
        return NextResponse.json(
          { success: false, error: 'name is required' },
          { status: 400 },
        );
      }
      // 分类校验：仅允许预设四类之一（空 = 不设分类）
      const cat = typeof category === 'string' ? category.trim() : '';
      if (cat && !(PROJECT_CATEGORIES as readonly string[]).includes(cat)) {
        return NextResponse.json(
          { success: false, error: `invalid category: ${cat}` },
          { status: 400 },
        );
      }
      // 标签：≤ PROJECT_TAG_LIMIT 个、每项非空（清洗与截断由数据层统一处理）
      const tagsOut = Array.isArray(tags)
        ? tags.map((t: unknown) => String(t ?? '').trim()).filter(Boolean).slice(0, PROJECT_TAG_LIMIT)
        : undefined;
      const project = await createProject(name.trim(), {
        category: cat || undefined,
        note: typeof note === 'string' ? note.trim() : undefined,
        tags: tagsOut && tagsOut.length > 0 ? tagsOut : undefined,
      });
      return NextResponse.json({ success: true, project });
    }

    if (action === 'update_meta') {
      const { project_id, category, tags, note } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      // 分类校验（仅允许预设四类；空串 = 清除分类）
      const cat = typeof category === 'string' ? category.trim() : undefined;
      if (cat && !(PROJECT_CATEGORIES as readonly string[]).includes(cat)) {
        return NextResponse.json(
          { success: false, error: `invalid category: ${cat}` },
          { status: 400 },
        );
      }
      // 标签校验：≤ PROJECT_TAG_LIMIT 个、每项非空
      let tagsOut: string[] | undefined;
      if (Array.isArray(tags)) {
        tagsOut = tags.map((t: unknown) => String(t ?? '').trim()).filter(Boolean).slice(0, PROJECT_TAG_LIMIT);
      }
      // 备注：透传字符串（空串 = 清除备注），截断由数据层统一处理
      const noteOut = typeof note === 'string' ? note : undefined;
      const project = await updateProjectMeta(project_id, { category: cat, tags: tagsOut, note: noteOut });
      return NextResponse.json({ success: true, project });
    }

    if (action === 'switch') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      console.log('[projects:switch] begin', JSON.stringify({ project_id }));
      const project = await switchProject(project_id);
      console.log('[projects:switch] ok', JSON.stringify({ project_id, name: project.name }));
      return NextResponse.json({ success: true, project });
    }

    if (action === 'delete') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      // 软删除：移入垃圾桶，数据保留在磁盘，可从垃圾桶恢复
      const project = await deleteProject(project_id);
      return NextResponse.json({ success: true, project });
    }

    if (action === 'restore') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      const project = await restoreProject(project_id);
      return NextResponse.json({ success: true, project });
    }

    if (action === 'purge') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      // 彻底删除：删除文件夹 + 移除配置条目，不可恢复
      await purgeProject(project_id);
      return NextResponse.json({ success: true });
    }

    if (action === 'rename') {
      const { project_id, new_name } = body;
      if (!project_id || !new_name || !new_name.trim()) {
        return NextResponse.json(
          { success: false, error: 'project_id 和 new_name 不能为空' },
          { status: 400 },
        );
      }
      const project = await renameProject(project_id, new_name.trim());
      return NextResponse.json({ success: true, project });
    }

    if (action === 'archive') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json({ success: false, error: 'project_id is required' }, { status: 400 });
      }
      const project = await archiveProject(project_id);
      return NextResponse.json({ success: true, project });
    }

    if (action === 'unarchive') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json({ success: false, error: 'project_id is required' }, { status: 400 });
      }
      const project = await unarchiveProject(project_id);
      return NextResponse.json({ success: true, project });
    }

    if (action === 'get_default_dir') {
      const dir = await getDefaultProjectDir();
      return NextResponse.json({
        success: true,
        default_project_dir: dir,
        default_projects_dir: getProjectsDir(),
        is_custom_default_dir: await isCustomDefaultProjectDir(),
      });
    }

    if (action === 'set_default_dir') {
      const { dir } = body;
      if (!dir || typeof dir !== 'string') {
        return NextResponse.json({ success: false, error: 'dir is required' }, { status: 400 });
      }
      const err = await validateProjectParentDir(dir);
      if (err) {
        return NextResponse.json({ success: false, error: err }, { status: 400 });
      }
      const savedDir = await setDefaultProjectDir(dir);
      return NextResponse.json({
        success: true,
        default_project_dir: savedDir,
        default_projects_dir: getProjectsDir(),
        is_custom_default_dir: await isCustomDefaultProjectDir(),
      });
    }

    if (action === 'reset_default_dir') {
      const savedDir = await resetDefaultProjectDir();
      return NextResponse.json({
        success: true,
        default_project_dir: savedDir,
        default_projects_dir: getProjectsDir(),
        is_custom_default_dir: false,
      });
    }

    if (action === 'list_files') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      const { projects } = await listProjects();
      const project = projects.find((p: ProjectConfig) => p.id === project_id);
      if (!project) {
        return NextResponse.json(
          { success: false, error: 'Project not found' },
          { status: 404 },
        );
      }
      const tree = flattenTemplateTree(await scanDirectory(project.path));
      // homework/ 按 kind 类别分组的输出文件，供侧边栏按类别展示（不再按节点分组）
      const { groups } = await scanHomeworkByKind(project.path);
      // materials/<shortId>_<标题>/（历史 attachments/ 同构）会话附件目录：短 id 关联 notes-memory 的 node 标题，
      // 前端展示时以会话标题代替机器目录名（原名仅作路径标识，不展示给人）；
      // 用户在 materials 下自建的分组不属于任何会话（短 id 匹配不上）→ 保持原名。
      const titleByShort = new Map<string, string>();
      const nodeMeta = await parseNodeMeta(join(project.path, 'notes-memory'));
      for (const [nid, meta] of nodeMeta) {
        const short = nid.slice(0, 4);
        if (meta.title && !titleByShort.has(short)) titleByShort.set(short, meta.title);
      }
      const attachSessionTitles = (nodes: FileNode[]) => {
        for (const n of nodes) {
          if (n.type !== 'directory') continue;
          if (n.rel === 'attachments' || n.rel === 'materials') {
            for (const ch of n.children ?? []) {
              if (ch.type !== 'directory') continue;
              const title = titleByShort.get(ch.name.split('_')[0]);
              if (title) ch.title = title;
            }
          }
          if (n.children) attachSessionTitles(n.children);
        }
      };
      attachSessionTitles(tree);
      // homework 归属视图：文件 → 来源会话（侧边栏「按来源会话分组」用；无清册时为空对象）
      const homeworkOwners = await scanHomeworkOwners(project.path);
      return NextResponse.json({
        success: true,
        files: tree,
        project_path: project.path,
        homework_kind_groups: groups,
        homework_owners: homeworkOwners,
      });
    }

    if (action === 'stat') {
      // 轻量存在性校验（产物卡片幽灵文件检测）：返回文件是否存在，不读取内容
      const { project_id, file_path } = body;
      if (!project_id || !file_path) {
        return NextResponse.json(
          { success: false, error: 'project_id and file_path are required' },
          { status: 400 },
        );
      }
      const { projects } = await listProjects();
      const project = projects.find((p: ProjectConfig) => p.id === project_id);
      if (!project) {
        return NextResponse.json(
          { success: false, error: 'Project not found' },
          { status: 404 },
        );
      }
      const fullPath = join(project.path, file_path);
      if (!fullPath.startsWith(project.path)) {
        return NextResponse.json(
          { success: false, error: 'Invalid file path' },
          { status: 403 },
        );
      }
      try {
        const st = await fs.stat(fullPath);
        return NextResponse.json({ success: true, exists: true, size: st.size, mtime: st.mtimeMs });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('ENOENT')) {
          return NextResponse.json({ success: true, exists: false });
        }
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
      }
    }

    if (action === 'read_file') {
      const { project_id, file_path } = body;
      if (!project_id || !file_path) {
        return NextResponse.json(
          { success: false, error: 'project_id and file_path are required' },
          { status: 400 },
        );
      }
      const { projects } = await listProjects();
      const project = projects.find((p: ProjectConfig) => p.id === project_id);
      if (!project) {
        return NextResponse.json(
          { success: false, error: 'Project not found' },
          { status: 404 },
        );
      }
      const fullPath = join(project.path, file_path);
      if (!fullPath.startsWith(project.path)) {
        return NextResponse.json(
          { success: false, error: 'Invalid file path' },
          { status: 403 },
        );
      }

      const ext = extname(fullPath).toLowerCase();
      const textExts = new Set([
        '.md', '.txt', '.json', '.csv', '.xml', '.html', '.css',
        '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c',
        '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log',
        '.env', '.sh', '.bash', '.zsh',
      ]);
      const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

      try {
        if (textExts.has(ext)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          const stat = await fs.stat(fullPath);
          return NextResponse.json({
            success: true,
            type: 'text',
            content,
            size: stat.size,
            extension: ext,
            name: file_path.split('/').pop() || file_path,
            full_path: fullPath,
          });
        }

        if (imageExts.has(ext)) {
          const buffer = await fs.readFile(fullPath);
          const base64 = buffer.toString('base64');
          const mimeMap: Record<string, string> = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
            '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
          };
          return NextResponse.json({
            success: true,
            type: 'image',
            content: `data:${mimeMap[ext] || 'application/octet-stream'};base64,${base64}`,
            size: buffer.length,
            extension: ext,
            name: file_path.split('/').pop() || file_path,
            full_path: fullPath,
          });
        }

        // 未知扩展名：尝试文本检测，避免 HTML/MD 等无扩展名文件被当作二进制无法预览
        // （AI 生成文件偶尔会丢失扩展名，这里做一次容错）
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          // UTF-8 解码成功且无替换字符，认为是有效文本
          if (!content.includes('\uFFFD')) {
            const stat = await fs.stat(fullPath);
            return NextResponse.json({
              success: true,
              type: 'text',
              content,
              size: stat.size,
              extension: ext || '.txt',
              name: file_path.split('/').pop() || file_path,
              full_path: fullPath,
            });
          }
        } catch {
          // 读取失败则保持 binary 兜底
        }

        // 其他二进制文件
        const stat = await fs.stat(fullPath);
        return NextResponse.json({
          success: true,
          type: 'binary',
          size: stat.size,
          extension: ext,
          name: file_path.split('/').pop() || file_path,
          full_path: fullPath,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('ENOENT')) {
          return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
        }
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
      }
    }

    if (action === 'write_file') {
      const { project_id, file_path, content, encoding, base_version } = body as {
        project_id: string;
        file_path: string;
        content: string;
        encoding?: string;
        base_version?: number;
      };
      if (!project_id || !file_path || content === undefined) {
        return NextResponse.json(
          { success: false, error: 'project_id, file_path and content are required' },
          { status: 400 },
        );
      }
      const { projects } = await listProjects();
      const project = projects.find((p: ProjectConfig) => p.id === project_id);
      if (!project) {
        return NextResponse.json(
          { success: false, error: 'Project not found' },
          { status: 404 },
        );
      }
      // === 输出文件名兜底：清洗 + 截断超长主体（解决 AI 生成超长文件名） ===
      const sant = sanitizeOutputFilename(file_path);
      let safeRelPath = sant.path;
      // === 智能扩展名推断：如果文件名没有后缀，根据内容特征自动补上，避免产生无扩展名的僵尸文件 ===
      // （AI 偶尔会忘记加后缀，导致 OutputFiles 里出现回形针图标且预览打不开）
      if (encoding !== 'base64' && content && typeof content === 'string') {
        const currentExt = extname(safeRelPath);
        if (!currentExt) {
          const snippet = content.trimStart().slice(0, 200).toLowerCase();
          let inferredExt = '.txt';
          if (/^<!DOCTYPE html|<html[\s>]/i.test(snippet)) {
            inferredExt = '.html';
          } else if (/^# /.test(content.trimStart())) {
            inferredExt = '.md';
          } else if (snippet.startsWith('{') || snippet.startsWith('[')) {
            inferredExt = '.json';
          } else if (snippet.startsWith('---')) {
            inferredExt = '.yaml';
          } else if (/^\s*</.test(snippet)) {
            inferredExt = '.xml';
          }
          // 将推断的扩展名追加到文件名后（保留目录结构）
          const slash = safeRelPath.lastIndexOf('/');
          if (slash >= 0) {
            safeRelPath = `${safeRelPath}${inferredExt}`;
          } else {
            safeRelPath = `${safeRelPath}${inferredExt}`;
          }
        }
      }
      // 仅当发生长度截断时才做同名去重（避免破坏 write_file 本来的覆盖语义）：
      // 截断可能使两个不同文件撞名，追加 -2/-3… 序号避免意外覆盖
      if (sant.truncated && safeRelPath) {
        const slash = safeRelPath.lastIndexOf('/');
        const dir = slash >= 0 ? safeRelPath.slice(0, slash + 1) : '';
        const base = slash >= 0 ? safeRelPath.slice(slash + 1) : safeRelPath;
        const ext = extname(base);
        const stem = ext ? base.slice(0, base.length - ext.length) : base;
        let candidate = safeRelPath;
        let seq = 2;
        while (await pathExists(join(project.path, candidate))) {
          candidate = `${dir}${stem}-${seq}${ext}`;
          seq++;
        }
        safeRelPath = candidate;
      }
      const fullPath = join(project.path, safeRelPath);
      if (!fullPath.startsWith(project.path)) {
        return NextResponse.json(
          { success: false, error: 'Invalid file path' },
          { status: 403 },
        );
      }
      try {
        // 乐观并发：保存时回传加载时刻 mtime 令牌，写前比对，检测加载后被外部（AI write_file 等）改写
        const currentVersion = await fs.stat(fullPath).then((s) => s.mtimeMs).catch(() => null);
        if (typeof base_version === 'number' && currentVersion !== null && Math.abs(currentVersion - base_version) > 1) {
          return NextResponse.json({
            conflict: true,
            current_version: currentVersion,
            current_content: await fs.readFile(fullPath, 'utf-8').catch(() => ''),
          });
        }
        // 确保父目录存在
        await fs.mkdir(dirname(fullPath), { recursive: true });
        if (encoding === 'base64') {
          // 图片等二进制写回：content 为 base64（不含 data: 前缀）
          await fs.writeFile(fullPath, Buffer.from(content, 'base64'));
        } else {
          await fs.writeFile(fullPath, content, 'utf-8');
        }
        const version = await fs.stat(fullPath).then((s) => s.mtimeMs).catch(() => currentVersion ?? Date.now());
        // 返回实际写入的路径（可能已被截断），让前端展示真实文件名
        return NextResponse.json({ success: true, path: safeRelPath, version });
      } catch (e) {
        return NextResponse.json(
          { success: false, error: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (error) {
    console.error(
      '[projects:POST] error',
      JSON.stringify({ action, error: error instanceof Error ? error.message : String(error) }),
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
