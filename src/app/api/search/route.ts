import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getCurrentProject, listProjects, getProjectsDir } from '@/lib/project/project-manager';
import { searchMaterialsIndex } from '@/lib/materials/indexer';

/**
 * 文件名检索 API
 *
 * 支持在以下范围内按文件名匹配搜索：
 *   - 本地授权根目录（.local-roots.json 中的 roots）
 *   - 当前项目的 attachments 文件夹
 *   - 当前项目的 materials 文件夹
 *   - scope=global：BobWork 项目（按名称）+ BobWorkspace 各项目的 homework/materials/attachments 子目录（⌘F 全局搜索）
 *
 * 检索方式：文件名包含关键词（不区分大小写），不做内容索引；
 * 例外：当前项目 materials 额外走 .materials-index/ 内容检索（读取已落盘的抽取/OCR 正文，检索本身不再调用模型），
 * 命中返回 matchType='content' 与 snippet/page 字段。
 */

/** 获取项目级授权根配置文件路径 */
async function getRootsFile(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return join(project.path, '.local-roots.json');
  } catch {
    // 无项目时回退到全局配置
    return join(homedir(), 'BobWork', '.local-roots.json');
  }
}

async function readRoots(): Promise<string[]> {
  try {
    const rootsFile = await getRootsFile();
    const content = await fs.readFile(rootsFile, 'utf-8');
    const config = JSON.parse(content) as { roots?: string[]; browseRoots?: string[] };
    // 搜索覆盖所有已添加目录（浏览目录 + 授权目录）
    return Array.from(new Set([...(config.roots || []), ...(config.browseRoots || [])]));
  } catch {
    return [];
  }
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '.cache', '__pycache__', '.venv', 'venv', '.DS_Store',
  'Library', 'Pictures', 'Music', 'Movies', 'Applications',
]);

interface SearchResult {
  name: string;
  path: string;
  source: 'local' | 'attachment' | 'material' | 'bobwork' | 'workspace' | 'project';
  sourceLabel: string;
  type: 'file' | 'directory' | 'project';
  size?: string;
  extension?: string;
  /** 项目结果专用：项目 ID（切换项目用） */
  projectId?: string;
  projectName?: string;
  /** 命中方式：name=文件名匹配（默认）；content=materials 正文内容命中 */
  matchType?: 'name' | 'content';
  /** 内容命中时的上下文片段 */
  snippet?: string;
  /** 内容命中时的页码（1-based，非分页文件恒为 1） */
  page?: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function walkDir(
  dir: string,
  keyword: string,
  source: 'local' | 'attachment' | 'material' | 'bobwork' | 'workspace',
  sourceLabel: string,
  results: SearchResult[],
  maxResults: number,
  maxDepth: number,
  depth: number,
  /** 所属项目信息：workspace 文件标注所属项目，点击时可跳转到对应项目打开 */
  project?: { id: string; name: string },
): Promise<void> {
  if (results.length >= maxResults || depth > maxDepth) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name.startsWith('.')) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isFile() && entry.name.toLowerCase().includes(keyword)) {
      let size: string | undefined;
      let sizeBytes = 0;
      try {
        const st = await fs.stat(fullPath);
        size = formatSize(st.size);
        sizeBytes = st.size;
      } catch { /* ignore */ }

      results.push({
        name: entry.name,
        path: fullPath,
        source,
        sourceLabel,
        type: 'file',
        size,
        extension: entry.name.split('.').pop()?.toLowerCase(),
        projectId: project?.id,
        projectName: project?.name,
      });
    }

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // 本地搜索时，目录名也参与匹配
      if (source === 'local' && entry.name.toLowerCase().includes(keyword)) {
        results.push({
          name: entry.name,
          path: fullPath,
          source,
          sourceLabel,
          type: 'directory',
        });
      }
      await walkDir(fullPath, keyword, source, sourceLabel, results, maxResults, maxDepth, depth + 1, project);
    }
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const keyword = (searchParams.get('q') || '').trim().toLowerCase();
  const scope = searchParams.get('scope') || 'all'; // all | local | project | global

  if (!keyword) {
    return NextResponse.json({ error: 'q (keyword) is required' }, { status: 400 });
  }

  const maxResults = 150;
  const maxDepth = 8;
  const results: SearchResult[] = [];

  // ⌘F 全局搜索：BobWork 项目（按名称）+ BobWorkspace 各项目 homework/materials/attachments 子目录
  if (scope === 'global') {
    // 可切换项目（非归档/非已删除/非隐藏）目录名 → 项目信息：
    // 归档项目不可切换（switch 会报错），从项目结果与 workspace 文件结果中一并排除，避免点击后无反应
    const projectByDirName = new Map<string, { id: string; name: string }>();
    try {
      const { projects } = await listProjects();
      for (const p of projects) {
        if (p.hidden || p.trashed || p.archived) continue;
        projectByDirName.set(basename(p.path), { id: p.id, name: p.name });
        // 1) 项目名匹配（不包含归档/隐藏/已删除项目）
        if (results.length < maxResults && p.name.toLowerCase().includes(keyword)) {
          results.push({
            name: p.name,
            path: p.path,
            source: 'project',
            sourceLabel: 'Project',
            type: 'project',
            projectId: p.id,
            projectName: p.name,
          });
        }
      }
    } catch { /* 配置读取失败时忽略 */ }

    // 2) BobWorkspace 大文件夹内：仅检索各项目 homework / materials / attachments 三个子目录（限制检索范围，
    //    不搜索整个项目数据目录；子目录缺失时 walkDir 静默跳过）
    const workspaceDir = getProjectsDir();
    const PROJECT_SUBDIRS = ['homework', 'materials', 'attachments'];
    try {
      const wsEntries = await fs.readdir(workspaceDir, { withFileTypes: true });
      for (const entry of wsEntries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.')) continue;
        if (!entry.isDirectory()) continue;
        const fullPath = join(workspaceDir, entry.name);
        // 不在可切换项目列表中的目录（归档/非注册目录）不参与搜索，避免点击后无法跳转
        const tag = projectByDirName.get(entry.name);
        if (!tag) continue;
        for (const sub of PROJECT_SUBDIRS) {
          if (results.length >= maxResults) break;
          await walkDir(join(fullPath, sub), keyword, 'workspace', 'BobWorkspace', results, maxResults, maxDepth, 0, tag);
        }
      }
    } catch { /* 工作区目录不可读时忽略 */ }
  }

  // 搜索本地授权根目录
  if (scope === 'all' || scope === 'local') {
    const roots = await readRoots();
    for (const root of roots) {
      if (results.length >= maxResults) break;
      await walkDir(root, keyword, 'local', basename(root), results, maxResults, maxDepth, 0);
    }
  }

  // 搜索项目 attachments + materials
  if (scope === 'all' || scope === 'project') {
    try {
      const project = await getCurrentProject();
      const attachmentsDir = join(project.path, 'attachments');
      const materialsDir = join(project.path, 'materials');

      await walkDir(attachmentsDir, keyword, 'attachment', '附件', results, maxResults, 5, 0);
      await walkDir(materialsDir, keyword, 'material', '素材', results, maxResults, 5, 0);

      // materials 内容检索：读 .materials-index/（抽取/OCR 正文已落盘），检索本身不再调用模型
      const budget = maxResults - results.length;
      if (budget > 0) {
        const hits = await searchMaterialsIndex(project.path, keyword, budget).catch(() => []);
        const nameMatched = new Set(results.map((r) => r.path));
        const seen = new Set<string>();
        for (const hit of hits) {
          if (results.length >= maxResults) break;
          const abs = join(materialsDir, hit.relPath);
          // 已按文件名命中该文件的，不再重复插入内容条目
          if (nameMatched.has(abs)) continue;
          const key = `${abs}#${hit.page}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            name: hit.name,
            path: abs,
            source: 'material',
            sourceLabel: '素材内容',
            type: 'file',
            size: formatSize(hit.size),
            extension: hit.name.split('.').pop()?.toLowerCase(),
            matchType: 'content',
            snippet: hit.snippet,
            page: hit.page,
          });
        }
      }
    } catch { /* 无项目时跳过 */ }
  }

  return NextResponse.json({
    success: true,
    keyword,
    count: results.length,
    results,
    truncated: results.length >= maxResults,
  });
}
