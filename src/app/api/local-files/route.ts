import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { join, resolve, sep, dirname, extname, basename } from 'path';
import { homedir, tmpdir } from 'os';
import { getCurrentProject, getProjectsDir } from '@/lib/project/project-manager';
import { expandEmbeds } from '@/lib/md-embed';
import { cleanupMdAnnotationSidecars } from '@/lib/md-annotations-cleanup';
import { renameMaterialsIndex } from '@/lib/materials/indexer';
import { renameFileTags, removeFileTags, type TagScope } from '@/lib/files/tags';
import { parseRange, rangeHeaders, unsatisfiableHeaders } from '@/lib/files/range';
import { fileMime } from '@/lib/files/mime';
import { fsPathKey } from '@/lib/platform';

/**
 * 解析路径（支持 ~ 展开为主目录）
 */
function resolvePath(input: string): string {
  if (input === '~') return homedir();
  // `~/x` 与 Windows 的 `~\x` 都要认（只认前者时，Windows 上「主目录」快捷方式静默失效）
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return resolve(input);
}

/**
 * 本地文件授权 API
 *
 * 用于右侧"本地文件"侧栏。
 *
 * 注意：授权机制（.local-roots.json）只限制 AI 工具侧的读写，
 *       不限制人类用户在 UI 中的操作。
 *       browseRoots 为仅人类浏览的目录（AI 不可访问）；
 *       roots 为已授权目录（授权即读写：AI 可对目录内文件增改删）。
 *       旧 writableRoots 字段读取时自动合并进 roots（向后兼容）。
 */

interface RootsConfig {
  roots: string[];
  browseRoots: string[];
}

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

async function readRoots(): Promise<RootsConfig> {
  try {
    const rootsFile = await getRootsFile();
    const content = await fs.readFile(rootsFile, 'utf-8');
    const config = JSON.parse(content) as { roots?: string[]; writableRoots?: string[]; browseRoots?: string[] };
    // 旧 writableRoots 迁移：授权即读写，直接并入 roots
    const legacyWritable = config.writableRoots || [];
    const roots = Array.from(new Set([...(config.roots || []), ...legacyWritable]));
    return {
      roots,
      browseRoots: config.browseRoots || [],
    };
  } catch {
    return { roots: [], browseRoots: [] };
  }
}

async function writeRoots(config: RootsConfig): Promise<void> {
  const rootsFile = await getRootsFile();
  await fs.mkdir(dirname(rootsFile), { recursive: true });
  const tmp = rootsFile + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ roots: config.roots, browseRoots: config.browseRoots }, null, 2), 'utf-8');
  await fs.rename(tmp, rootsFile);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';

  // 列出浏览目录与授权目录
  if (action === 'roots') {
    const config = await readRoots();
    return NextResponse.json({ success: true, roots: config.roots, browseRoots: config.browseRoots });
  }

  // 添加浏览目录（仅人类浏览，AI 不可访问）
  if (action === 'add_root') {
    const rootPath = searchParams.get('path');
    if (!rootPath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    const resolved = resolvePath(rootPath);
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) {
        return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'Path does not exist' }, { status: 400 });
    }
    const config = await readRoots();
    if (!config.browseRoots.includes(resolved)) {
      config.browseRoots.push(resolved);
      await writeRoots(config);
    }
    return NextResponse.json({ success: true, roots: config.roots, browseRoots: config.browseRoots });
  }

  // 授权目录（授权即读写：AI 可对目录内文件增改删）
  if (action === 'authorize_root') {
    const rootPath = searchParams.get('path');
    if (!rootPath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    const resolved = resolvePath(rootPath);
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) {
        return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'Path does not exist' }, { status: 400 });
    }
    const config = await readRoots();
    if (!config.roots.includes(resolved)) {
      config.roots.push(resolved);
      // 授权目录默认也可浏览
      if (!config.browseRoots.includes(resolved)) {
        config.browseRoots.push(resolved);
      }
      await writeRoots(config);
    }
    return NextResponse.json({ success: true, roots: config.roots, browseRoots: config.browseRoots });
  }

  // 断开授权（保留浏览）
  if (action === 'revoke_root') {
    const rootPath = searchParams.get('path');
    if (!rootPath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    const resolved = resolvePath(rootPath);
    const config = await readRoots();
    config.roots = config.roots.filter(r => r !== resolved);
    await writeRoots(config);
    return NextResponse.json({ success: true, roots: config.roots, browseRoots: config.browseRoots });
  }

  // 移除目录（从浏览与授权中一并移除）
  if (action === 'remove_root') {
    const rootPath = searchParams.get('path');
    if (!rootPath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    const resolved = resolvePath(rootPath);
    const config = await readRoots();
    config.roots = config.roots.filter(r => r !== resolved);
    config.browseRoots = config.browseRoots.filter(r => r !== resolved);
    await writeRoots(config);
    return NextResponse.json({ success: true, roots: config.roots, browseRoots: config.browseRoots });
  }

  // 读取单个文件内容（人类 UI 侧：任意本地路径自由读）
  if (action === 'read_file') {
    const filePath = searchParams.get('path');
    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    const resolved = resolvePath(filePath);
    const ext = extname(resolved).toLowerCase();
    const textExts = new Set([
      '.md', '.txt', '.json', '.csv', '.xml', '.html', '.css',
      '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c',
      '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log',
      '.env', '.sh', '.bash', '.zsh',
    ]);
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

    try {
      if (textExts.has(ext)) {
        let content = await fs.readFile(resolved, 'utf-8');
        // expand=1 且为 md：展开嵌入语法（![[路径]] → 内容），供只读预览"阅读展开"
        if (ext === '.md' && searchParams.get('expand') === '1') {
          content = await expandEmbeds(content, 0, undefined, dirname(resolved));
        }
        const stat = await fs.stat(resolved);
        return NextResponse.json({
          success: true,
          type: 'text',
          content,
          size: stat.size,
          extension: ext,
          name: resolved.split(sep).pop() || resolved,
          full_path: resolved,
        });
      }
      if (imageExts.has(ext)) {
        const buffer = await fs.readFile(resolved);
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
          name: resolved.split(sep).pop() || resolved,
          full_path: resolved,
        });
      }
      // 其他二进制文件
      const stat = await fs.stat(resolved);
      return NextResponse.json({
        success: true,
        type: 'binary',
        size: stat.size,
        extension: ext,
        name: resolved.split(sep).pop() || resolved,
        full_path: resolved,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('ENOENT')) {
        return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
      }
      return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
  }

  // 轻量版本查询：仅返回 mtimeMs 令牌，供 DocEditor 编辑期轮询检测外部改写（不读全文件）
  if (action === 'stat') {
    const filePath = searchParams.get('path');
    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    const resolved = resolvePath(filePath);
    try {
      const st = await fs.stat(resolved);
      return NextResponse.json({ success: true, mtime: st.mtimeMs });
    } catch {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }
  }

  // 文件代理（返回文件二进制流，用于 PDF / Word / Excel / 音频预览等浏览器端渲染场景）
  // 支持 HTTP Range（单区间）：音频等大文件可由浏览器按需分段拉取，避免整份读进内存。
  if (action === 'file_proxy') {
    const filePath = searchParams.get('path');
    if (!filePath) {
      return new NextResponse('Missing path', { status: 400 });
    }
    const resolved = resolvePath(filePath);
    try {
      const stat = await fs.stat(resolved);
      const ext = extname(resolved).toLowerCase();
      // 200 / 206 / 416 三分支共用的头（Content-Type、mtime 哨兵、Accept-Ranges、缓存策略）
      const baseHeaders: Record<string, string> = {
        'Content-Type': fileMime(ext),
        // 打开时刻的 mtime 哨兵：docx 编辑器（DocxTiptapEditor）记录后，更新原稿前比对该值，检测文件是否被 WPS 等外部程序改过
        'X-File-Mtime': String(stat.mtimeMs),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      };

      const range = parseRange(request.headers.get('range'), stat.size);
      if (range === 'unsatisfiable') {
        return new NextResponse(null, {
          status: 416,
          headers: { ...baseHeaders, ...unsatisfiableHeaders(stat.size) },
        });
      }
      if (range) {
        // 只送该区间：用文件流，不再整份读进内存
        const nodeStream = createReadStream(resolved, { start: range.start, end: range.end });
        return new NextResponse(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
          status: 206,
          headers: { ...baseHeaders, ...rangeHeaders(range, stat.size) },
        });
      }

      const buffer = await fs.readFile(resolved);
      return new NextResponse(buffer, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
      });
    } catch {
      return new NextResponse('File not found', { status: 404 });
    }
  }

  // 列目录内容（供授权目录展开浏览，仅人类 UI 侧）
  const dirPath = searchParams.get('path');
  if (!dirPath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  const resolved = resolvePath(dirPath);

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    // 先过滤隐藏文件并排序（目录优先、同类按名称），再并发 stat。
    // 原实现逐个 await fs.stat，文件多时退化为串行系统调用，是打开目录卡顿的主因。
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    const items = await Promise.all(visible.map(async (entry) => {
      const fullPath = join(resolved, entry.name);
      let size = '';
      let sizeBytes = 0;

      if (entry.isFile()) {
        try {
          const st = await fs.stat(fullPath);
          size = formatSize(st.size);
          sizeBytes = st.size;
        } catch { /* ignore */ }
      }

      return {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size,
        sizeBytes,
        extension: entry.isFile() ? entry.name.split('.').pop()?.toLowerCase() : undefined,
      };
    }));

    return NextResponse.json({
      success: true,
      path: resolved,
      items,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) {
      return NextResponse.json({ error: 'Directory not found' }, { status: 404 });
    }
    if (msg.includes('EACCES')) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** 检查路径是否在可操作范围内 — 仅用于防止越界，人类操作可自由管理自己的文件 */
function isHumanWritablePath(targetPath: string): boolean {
  // 人类 UI 侧的操作：保护系统关键目录不被误删，但允许对用户主目录及其他任何用户目录操作
  const protectedPaths = [
    '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var',
    join(homedir(), 'Library'),
  ];
  const resolved = resolve(targetPath);
  return !protectedPaths.some(p => resolved === p || resolved.startsWith(p + sep));
}

/**
 * 重命名后迁移 homework/.ownership.json 的归属条目（relFrom → relTo；目录按前缀整体迁移）。
 * 仅在源与目标都位于某个项目的 homework/ 根内时生效；无清册或损坏时静默忽略。
 */
async function transferHomeworkOwnership(fromAbs: string, toAbs: string): Promise<void> {
  const workspaceRoot = resolve(getProjectsDir());
  // 从源路径的父目录向上找 homework 根（其父目录须位于 BobWorkspace 内，即 <project>/homework）
  let dir = fromAbs.substring(0, fromAbs.lastIndexOf(sep));
  let homeworkRoot: string | null = null;
  while (dir.startsWith(workspaceRoot + sep)) {
    if (dir.split(sep).pop() === 'homework') {
      homeworkRoot = dir;
      break;
    }
    const parent = dir.substring(0, dir.lastIndexOf(sep));
    if (parent === dir) break;
    dir = parent;
  }
  if (!homeworkRoot) return;
  if (!(toAbs === homeworkRoot || toAbs.startsWith(homeworkRoot + sep))) return;

  const relFrom = fromAbs.slice(homeworkRoot.length + 1);
  const relTo = toAbs.slice(homeworkRoot.length + 1);
  if (!relFrom || !relTo || relFrom.startsWith('.') || relTo.startsWith('.')) return;

  const manifestPath = join(homeworkRoot, '.ownership.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<string, string>;
    const moves: Array<[string, string]> = [];
    if (manifest[relFrom]) moves.push([relFrom, relTo]);
    const prefix = `${relFrom}/`;
    for (const key of Object.keys(manifest)) {
      if (key.startsWith(prefix)) moves.push([key, `${relTo}/${key.slice(prefix.length)}`]);
    }
    if (moves.length === 0) return;

    for (const [from, to] of moves) {
      manifest[to] = manifest[from];
      delete manifest[from];
    }
    const tmp = join(homeworkRoot, `.ownership.json.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
    await fs.rename(tmp, manifestPath);
  } catch { /* 无清册或损坏时忽略 */ }
}

/**
 * 解析「某项目 materials/ 内的重命名」相对路径对：源与目标都须落在同一 <项目>/materials 根内。
 * 非 materials 内路径、或重命名后跨出 materials 根时返回 null。
 */
function resolveMaterialsRename(
  fromAbs: string,
  toAbs: string,
): { projectPath: string; relFrom: string; relTo: string } | null {
  const workspaceRoot = resolve(getProjectsDir());
  // 从源路径的父目录向上找 materials 根（其父目录须位于 BobWorkspace 内，即 <project>/materials）
  let dir = fromAbs.substring(0, fromAbs.lastIndexOf(sep));
  let materialsRoot: string | null = null;
  while (dir.startsWith(workspaceRoot + sep)) {
    if (dir.split(sep).pop() === 'materials') {
      materialsRoot = dir;
      break;
    }
    const parent = dir.substring(0, dir.lastIndexOf(sep));
    if (parent === dir) break;
    dir = parent;
  }
  if (!materialsRoot) return null;
  if (!(toAbs === materialsRoot || toAbs.startsWith(materialsRoot + sep))) return null;

  const relFrom = fromAbs.slice(materialsRoot.length + 1);
  const relTo = toAbs.slice(materialsRoot.length + 1);
  if (!relFrom || !relTo || relFrom.startsWith('.') || relTo.startsWith('.')) return null;

  return { projectPath: materialsRoot.substring(0, materialsRoot.lastIndexOf(sep)), relFrom, relTo };
}

/** 标签作用域根目录名（与 <项目> 下的顶层目录同名） */
const TAG_SCOPE_DIRS: readonly TagScope[] = ['materials', 'homework'];

/**
 * 定位路径所属的标签作用域：从路径的父目录向上找最近的 materials/ 或 homework/ 根
 * （作用域根的父目录须是 BobWorkspace 下的项目目录，避免把更深的同名子目录误判为作用域根）。
 * 路径本身位于作用域根之外（含隐藏条目 / 根目录自身）时返回 null。
 */
function resolveTagScopePath(
  absPath: string,
): { projectPath: string; scope: TagScope; rel: string } | null {
  const workspaceRoot = resolve(getProjectsDir());
  let dir = absPath.substring(0, absPath.lastIndexOf(sep));
  while (dir.startsWith(workspaceRoot + sep)) {
    const parent = dir.substring(0, dir.lastIndexOf(sep));
    if (parent === dir) break;
    const name = dir.split(sep).pop();
    const scope = TAG_SCOPE_DIRS.find((s) => s === name);
    // 仅当作用域根的父目录就是项目目录时才算命中，否则继续向上（跳过同名嵌套子目录）
    if (scope && parent.startsWith(workspaceRoot + sep) && !parent.slice(workspaceRoot.length + 1).includes(sep)) {
      const rel = absPath.slice(dir.length + 1);
      if (!rel || rel.startsWith('.')) return null;
      return { projectPath: parent, scope, rel };
    }
    dir = parent;
  }
  return null;
}

/**
 * 重命名后迁移标签表键：源与目标须落在同一项目、同一作用域根内。无标签表时静默忽略。
 */
async function transferFileTagsRename(fromAbs: string, toAbs: string): Promise<void> {
  const from = resolveTagScopePath(fromAbs);
  const to = resolveTagScopePath(toAbs);
  if (!from || !to || from.projectPath !== to.projectPath || from.scope !== to.scope) return;
  await renameFileTags(from.projectPath, from.scope, from.rel, to.rel)
    .catch(() => { /* 无标签表时忽略 */ });
}

/**
 * 重命名后迁移 <项目>/materials/ 的附属数据：内容索引条目（.materials-index）。
 * （标签表键的迁移统一由 transferFileTagsRename 处理，覆盖 materials 与 homework 两个作用域。）
 * 无对应数据时静默忽略。
 */
async function transferMaterialsRename(fromAbs: string, toAbs: string): Promise<void> {
  const target = resolveMaterialsRename(fromAbs, toAbs);
  if (!target) return;
  await renameMaterialsIndex(target.projectPath, target.relFrom, target.relTo)
    .catch(() => { /* 无索引时忽略 */ });
}

/** 删除后回收标签表键（该路径及其子路径前缀）。无标签表时静默忽略。 */
async function transferFileTagsRemove(absPath: string): Promise<void> {
  const target = resolveTagScopePath(absPath);
  if (!target) return;
  await removeFileTags(target.projectPath, target.scope, target.rel)
    .catch(() => { /* 无标签表时忽略 */ });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action as string;

    if (!action) {
      return NextResponse.json({ error: 'action is required' }, { status: 400 });
    }

    // 重命名文件/文件夹
    if (action === 'rename') {
      const sourcePath = body.sourcePath as string;
      const newName = body.newName as string;
      if (!sourcePath || !newName) {
        return NextResponse.json({ error: 'sourcePath and newName are required' }, { status: 400 });
      }

      const resolved = resolvePath(sourcePath);
      if (!isHumanWritablePath(resolved)) {
        return NextResponse.json({ error: 'Protected system directory' }, { status: 403 });
      }

      // 安全检查：新文件名不能包含路径分隔符
      if (newName.includes('/') || newName.includes('\\')) {
        return NextResponse.json({ error: 'File name cannot contain path separators' }, { status: 400 });
      }

      const parentDir = resolved.substring(0, resolved.lastIndexOf(sep));
      const newPath = join(parentDir, newName);

      try {
        await fs.access(newPath);
        return NextResponse.json({ error: 'A file or folder with that name already exists' }, { status: 409 });
      } catch { /* 目标不存在，可以 rename */ }

      await fs.rename(resolved, newPath);
      // 归属清册维护：重命名项目 homework/ 内的文件时迁移 .ownership.json 条目，
      // 否则该产物会丢失与原节点的归属关系（AI 的 rename_file 工具同样做归属转移）。
      await transferHomeworkOwnership(resolved, newPath);
      // 附属数据维护：重命名项目 materials/ 内的文件/文件夹时迁移可检索索引条目，
      // 否则重命名后既有正文索引会因键路径失配而失效（需重新 OCR）；
      // 标签表键的迁移覆盖 materials 与 homework 两个作用域，避免标签丢失。
      await transferMaterialsRename(resolved, newPath);
      await transferFileTagsRename(resolved, newPath);
      return NextResponse.json({ success: true, newPath });
    }

    // 复制文件或文件夹（文件夹递归复制）
    if (action === 'copy') {
      const sourcePath = body.sourcePath as string;
      if (!sourcePath) {
        return NextResponse.json({ error: 'sourcePath is required' }, { status: 400 });
      }

      const resolved = resolvePath(sourcePath);
      if (!isHumanWritablePath(resolved)) {
        return NextResponse.json({ error: 'Protected system directory' }, { status: 403 });
      }

      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat) {
        return NextResponse.json({ error: 'Source does not exist' }, { status: 404 });
      }

      const isDir = stat.isDirectory();
      const originalName = resolved.split(sep).pop() || (isDir ? 'folder' : 'file');
      const parentDir = resolved.substring(0, resolved.lastIndexOf(sep));

      // 生成副本名：filename copy.ext / filename copy 2.ext ...（文件夹同理）
      let counter = 1;
      let copyPath: string;
      do {
        const suffix = counter === 1 ? ' copy' : ` copy ${counter}`;
        if (isDir) {
          copyPath = join(parentDir, `${originalName}${suffix}`);
        } else {
          const ext = originalName.includes('.') ? '.' + originalName.split('.').pop() : '';
          const baseName = ext ? originalName.slice(0, -ext.length) : originalName;
          copyPath = join(parentDir, `${baseName}${suffix}${ext}`);
        }
        counter++;
      } while (await fs.access(copyPath).then(() => true).catch(() => false));

      // cp 同时支持文件和目录，recursive: true 递归复制目录
      await fs.cp(resolved, copyPath, { recursive: true });
      const newName = copyPath.split(sep).pop() || '';
      return NextResponse.json({ success: true, newPath: copyPath, newName });
    }

    // 粘贴：把「复制」暂存（应用内剪贴板）的源复制到目标目录，对应 macOS 的拷贝 / 粘贴语义。
    // 目标目录已有同名条目时才追加 " copy" / " copy 2"，否则保持原名（与 Finder 一致）。
    if (action === 'paste') {
      const sourcePath = body.sourcePath as string;
      const destDir = body.destDir as string;
      if (!sourcePath || !destDir) {
        return NextResponse.json({ error: 'sourcePath and destDir are required' }, { status: 400 });
      }

      const resolvedSource = resolvePath(sourcePath);
      const resolvedDest = resolvePath(destDir);
      if (!isHumanWritablePath(resolvedSource) || !isHumanWritablePath(resolvedDest)) {
        return NextResponse.json({ error: 'Protected system directory' }, { status: 403 });
      }

      const srcStat = await fs.stat(resolvedSource).catch(() => null);
      if (!srcStat) {
        return NextResponse.json({ error: 'Source does not exist' }, { status: 404 });
      }

      const destStat = await fs.stat(resolvedDest).catch(() => null);
      if (!destStat || !destStat.isDirectory()) {
        return NextResponse.json({ error: 'Destination is not a directory' }, { status: 400 });
      }

      const isDir = srcStat.isDirectory();
      // 目录不能粘贴进自身或其子孙目录（fs.cp 递归复制自身会无限膨胀）：
      // 比较前先解符号链接取真实路径；macOS / Windows 文件系统默认大小写不敏感，统一小写后再比前缀。
      // 反向（源在目标之内，如把子目录粘到父目录）是合法操作，不拦。
      if (isDir) {
        const [realSource, realDest] = await Promise.all([
          fs.realpath(resolvedSource).catch(() => resolvedSource),
          fs.realpath(resolvedDest).catch(() => resolvedDest),
        ]);
        const norm = fsPathKey;
        const srcKey = norm(realSource);
        const dstKey = norm(realDest);
        if (dstKey === srcKey || dstKey.startsWith(srcKey + sep)) {
          return NextResponse.json({ error: 'Cannot paste a folder into itself' }, { status: 400 });
        }
      }

      const originalName = resolvedSource.split(sep).pop() || (isDir ? 'folder' : 'file');
      const ext = !isDir && originalName.includes('.') ? '.' + originalName.split('.').pop() : '';
      const baseName = ext ? originalName.slice(0, -ext.length) : originalName;

      // 优先沿用原名；被占用时按 Finder 规则追加 " copy"、" copy 2"……
      let counter = 0;
      let destPath: string;
      do {
        const suffix = counter === 0 ? '' : counter === 1 ? ' copy' : ` copy ${counter}`;
        destPath = join(resolvedDest, `${baseName}${suffix}${ext}`);
        counter++;
      } while (await fs.access(destPath).then(() => true).catch(() => false));

      await fs.cp(resolvedSource, destPath, { recursive: true });
      const newName = destPath.split(sep).pop() || '';
      return NextResponse.json({ success: true, newPath: destPath, newName });
    }

    // 移动：把源文件/文件夹移到目标目录（侧栏分组视图的拖拽落点），对应 macOS 的拖拽移动语义。
    // 目标已有同名条目时报错（不自动改名）：拖拽后拿到名字被改的副本更令人困惑。
    if (action === 'move') {
      const sourcePath = body.sourcePath as string;
      const destDir = body.destDir as string;
      if (!sourcePath || !destDir) {
        return NextResponse.json({ error: 'sourcePath and destDir are required' }, { status: 400 });
      }

      const resolvedSource = resolvePath(sourcePath);
      const resolvedDest = resolvePath(destDir);
      if (!isHumanWritablePath(resolvedSource) || !isHumanWritablePath(resolvedDest)) {
        return NextResponse.json({ error: 'Protected system directory' }, { status: 403 });
      }

      const srcStat = await fs.stat(resolvedSource).catch(() => null);
      if (!srcStat) {
        return NextResponse.json({ error: 'Source does not exist' }, { status: 404 });
      }

      const destStat = await fs.stat(resolvedDest).catch(() => null);
      if (!destStat || !destStat.isDirectory()) {
        return NextResponse.json({ error: 'Destination is not a directory' }, { status: 400 });
      }

      // 已在目标目录内：视为成功（幂等），避免「拖回原处」报错
      if (resolvedSource.substring(0, resolvedSource.lastIndexOf(sep)) === resolvedDest) {
        return NextResponse.json({ success: true, newPath: resolvedSource, unchanged: true });
      }

      // 目录不能移入自身或其子孙目录：比较前先解符号链接取真实路径；
      // macOS / Windows 文件系统默认大小写不敏感，统一小写后再比前缀（判据见 fsPathKey）。
      if (srcStat.isDirectory()) {
        const [realSource, realDest] = await Promise.all([
          fs.realpath(resolvedSource).catch(() => resolvedSource),
          fs.realpath(resolvedDest).catch(() => resolvedDest),
        ]);
        const norm = fsPathKey;
        const srcKey = norm(realSource);
        const dstKey = norm(realDest);
        if (dstKey === srcKey || dstKey.startsWith(srcKey + sep)) {
          return NextResponse.json({ error: 'Cannot move a folder into itself' }, { status: 400 });
        }
      }

      const originalName = resolvedSource.split(sep).pop() || (srcStat.isDirectory() ? 'folder' : 'file');
      const newPath = join(resolvedDest, originalName);

      try {
        await fs.access(newPath);
        return NextResponse.json({ error: 'A file or folder with that name already exists' }, { status: 409 });
      } catch { /* 目标不存在，可以 move */ }

      await fs.rename(resolvedSource, newPath);
      // 与 rename 一致的附属数据维护：归属清册 / 内容索引 / 标签表键（含目录按前缀整体迁移）
      await transferHomeworkOwnership(resolvedSource, newPath);
      await transferMaterialsRename(resolvedSource, newPath);
      await transferFileTagsRename(resolvedSource, newPath);
      return NextResponse.json({ success: true, newPath });
    }

    // 删除文件
    if (action === 'delete') {
      const targetPath = body.targetPath as string;
      if (!targetPath) {
        return NextResponse.json({ error: 'targetPath is required' }, { status: 400 });
      }

      const resolved = resolvePath(targetPath);
      if (!isHumanWritablePath(resolved)) {
        return NextResponse.json({ error: 'Protected system directory' }, { status: 403 });
      }

      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        await fs.rm(resolved, { recursive: true });
      } else {
        await fs.unlink(resolved);
      }
      // 联动清理：删除文档/目录时同步清理 md-annotations 中对应的批注/修订 sidecar
      await cleanupMdAnnotationSidecars({ targets: [{ abs: resolved, isDir: stat.isDirectory() }] }).catch(() => {});
      // 回收标签表键：删除 materials / homework 作用域内的条目时，其标签一并清除
      await transferFileTagsRemove(resolved);
      return NextResponse.json({ success: true });
    }

    // 删除项目 homework 目录内文件（同步清理 .ownership.json 清册归属，节点分组随之更新）。
    // 安全边界：homework 根必须位于 BobWorkspace 内；目标必须位于 homework 根内；隐藏条目（.ownership.json/.ai-workspace 等）受保护。
    if (action === 'delete_homework') {
      const targetPath = body.targetPath as string;
      const homeworkRoot = body.homeworkRoot as string;
      if (!targetPath || !homeworkRoot) {
        return NextResponse.json({ error: 'targetPath and homeworkRoot are required' }, { status: 400 });
      }
      const rootAbs = resolve(homeworkRoot);
      const workspaceRoot = resolve(getProjectsDir());
      if (!(rootAbs === workspaceRoot || rootAbs.startsWith(workspaceRoot + sep))) {
        return NextResponse.json({ error: 'Invalid homework root' }, { status: 403 });
      }
      const resolved = resolvePath(targetPath);
      if (!(resolved === rootAbs || resolved.startsWith(rootAbs + sep))) {
        return NextResponse.json({ error: 'Path escapes homework directory' }, { status: 403 });
      }
      const relToHomework = resolved.slice(rootAbs.length + 1);
      if (!relToHomework || relToHomework.startsWith('.')) {
        return NextResponse.json({ error: 'Protected homework entry' }, { status: 403 });
      }
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
      }
      if (stat.isDirectory()) {
        await fs.rm(resolved, { recursive: true });
      } else {
        await fs.unlink(resolved);
      }
      // 联动清理 homework 内文档对应的批注/修订 sidecar（含目录整体删除时其下所有文档）
      await cleanupMdAnnotationSidecars({ targets: [{ abs: resolved, isDir: stat.isDirectory() }] }).catch(() => {});
      // 同步清理 .ownership.json 归属清册（原子写，防止并发覆盖）。
      // 删除目录时按前缀清理：该目录内所有归属条目（homework/<nodeId>/...）一并清除，避免残留。
      const manifestPath = join(rootAbs, '.ownership.json');
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<string, string>;
        let manifestChanged = false;
        const prefix = `${relToHomework}/`;
        for (const key of Object.keys(manifest)) {
          if (key === relToHomework || key.startsWith(prefix)) {
            delete manifest[key];
            manifestChanged = true;
          }
        }
        if (manifestChanged) {
          const tmp = join(rootAbs, `.ownership.json.${process.pid}.${Date.now()}.tmp`);
          await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
          await fs.rename(tmp, manifestPath);
        }
      } catch { /* 无清册或损坏时忽略 */ }
      // 回收标签表键：删除 homework 内的文件/目录时，其标签一并清除
      await transferFileTagsRemove(resolved);
      return NextResponse.json({ success: true });
    }

    // 写入文件（编辑器保存本地文件）
    if (action === 'write') {
      const targetPath = body.path as string;
      const content = body.content as string;
      const encoding = (body.encoding as string) || 'utf-8';
      const base_version = typeof body.base_version === 'number' ? body.base_version : null;
      if (!targetPath || content === undefined) {
        return NextResponse.json({ error: 'path and content are required' }, { status: 400 });
      }

      const resolved = resolvePath(targetPath);
      if (!isHumanWritablePath(resolved)) {
        return NextResponse.json({ error: '系统目录受保护，无法操作' }, { status: 403 });
      }

      // 乐观并发：保存时回传加载时刻 mtime 令牌，写前比对，检测加载后被外部（AI/其他程序）改写
      const currentVersion = await fs.stat(resolved).then((s) => s.mtimeMs).catch(() => null);
      if (base_version !== null && currentVersion !== null && Math.abs(currentVersion - base_version) > 1) {
        return NextResponse.json({
          conflict: true,
          current_version: currentVersion,
          current_content: await fs.readFile(resolved, 'utf-8').catch(() => ''),
        });
      }

      await fs.mkdir(dirname(resolved), { recursive: true });
      if (encoding === 'base64') {
        // 图片等二进制写回：content 为 base64（不含 data: 前缀）
        await fs.writeFile(resolved, Buffer.from(content, 'base64'));
      } else {
        await fs.writeFile(resolved, content, 'utf-8');
      }
      const version = await fs.stat(resolved).then((s) => s.mtimeMs).catch(() => currentVersion ?? Date.now());
      return NextResponse.json({ success: true, version });
    }

    // 修订版保存到项目 homework 目录（docx 编辑器自动/手动保存，不污染附件/materials 原文）
    if (action === 'save_to_homework') {
      const filename = body.filename as string;
      const content = body.content as string;
      const encoding = (body.encoding as string) || 'base64';
      if (!filename || content === undefined) {
        return NextResponse.json({ error: 'filename and content are required' }, { status: 400 });
      }
      let homeworkDir: string;
      try {
        const project = await getCurrentProject();
        homeworkDir = join(project.path, 'homework');
      } catch {
        homeworkDir = join(homedir(), 'BobWork', 'homework');
      }
      // 存储平铺：basename 防路径穿越，直接落 homework/ 根目录（不生成 kind 子文件夹）；
      // 侧边栏按文件类别标签分组展示。同名覆盖（客户端用时间戳文件名，会话内自动保存复用同名）
      const safeName = basename(filename);
      const target = join(homeworkDir, safeName);
      await fs.mkdir(homeworkDir, { recursive: true });
      if (encoding === 'base64') {
        await fs.writeFile(target, Buffer.from(content, 'base64'));
      } else {
        await fs.writeFile(target, content, 'utf-8');
      }
      // 返回落盘时刻 mtime：客户端外部打开前比对，检测文件是否被 WPS 等外部程序改写
      const savedStat = await fs.stat(target);
      return NextResponse.json({ success: true, path: target, mtime: savedStat.mtimeMs });
    }

    // 接受修订后直接更新原稿：严格冲突防护（Word/WPS 锁文件 + mtime 哨兵）→ 回写前快照备份 → 临时文件原子替换。
    // 任一冲突都拒绝写回（success:false + conflict 字段），由前端提示用户恢复外部版本或另存修订稿
    if (action === 'save_to_original') {
      const filePath = body.path as string;
      const content = body.content as string;
      const expectedMtime = typeof body.expectedMtime === 'number' ? body.expectedMtime : null;
      const doBackup = body.backup !== false; // 默认备份；前端「仅会话首次备份」策略在非首次写回时传 backup:false
      if (!filePath || typeof content !== 'string') {
        return NextResponse.json({ error: 'path and content are required' }, { status: 400 });
      }
      const resolved = resolvePath(filePath);
      if (!isHumanWritablePath(resolved)) {
        return NextResponse.json({ success: false, error: '系统目录受保护，无法写入' }, { status: 403 });
      }
      // ① 锁文件检测：Word/WPS 打开文档时会留下 ~$ 开头的临时文件
      //    （长文件名规则为 ~$ + 原名去掉前两个字符，短名/部分导出器为 ~$ + 原名，两种都查）
      const name = basename(resolved);
      const dir = dirname(resolved);
      try {
        const entries = await fs.readdir(dir);
        const lockHit = entries.find((e) => {
          if (!e.startsWith('~$')) return false;
          const bare = e.slice(2);
          return bare === name || bare === name.slice(2);
        });
        if (lockHit) {
          return NextResponse.json({
            success: false,
            conflict: 'locked',
            error: `检测到 Word/WPS 锁文件（${lockHit}），文档可能正被 Office 打开，请先关闭后重试`,
          });
        }
      } catch { /* 目录不可读时交给后续 stat 兜底 */ }
      // ② mtime 哨兵：打开文档时记录的 X-File-Mtime 与磁盘当前值不一致 → 原稿已被外部改过，拒绝覆盖
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile()) {
        return NextResponse.json({ success: false, error: '原稿不存在或不可访问' }, { status: 404 });
      }
      if (expectedMtime !== null && Math.abs(stat.mtimeMs - expectedMtime) > 1000) {
        return NextResponse.json({
          success: false,
          conflict: 'modified',
          currentMtime: stat.mtimeMs,
          error: '原稿在打开后已被外部程序修改，为防覆盖已拒绝写回',
        });
      }
      // ③ 回写前快照：当前原稿先备份到 homework（写回内容有误或后悔时可恢复；backup:false 时跳过）
      let backupPath: string | null = null;
      if (doBackup) {
        try {
          let homeworkDir: string;
          try {
            const project = await getCurrentProject();
            homeworkDir = join(project.path, 'homework');
          } catch {
            homeworkDir = join(homedir(), 'BobWork', 'homework');
          }
          await fs.mkdir(homeworkDir, { recursive: true });
          const d = new Date();
          const p2 = (n: number) => String(n).padStart(2, '0');
          const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
          backupPath = join(homeworkDir, `${name.replace(/\.docx$/i, '')}-回写前备份-${stamp}.docx`);
          await fs.copyFile(resolved, backupPath);
        } catch { /* 备份失败不阻塞写回（新内容已在内存完整持有） */ }
      }
      // ④ 原子写入：同目录临时文件 + rename，进程崩溃/断电不会留下半截 docx
      const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(tmp, Buffer.from(content, 'base64'));
        await fs.rename(tmp, resolved);
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
      const done = await fs.stat(resolved);
      return NextResponse.json({ success: true, path: resolved, mtime: done.mtimeMs, backup: backupPath });
    }

    // 外部打开副本：复制到系统临时目录后交桌面程序打开。WPS/Word 的保存与自动备份只会写到副本，
    // 物理隔离防止改写 homework 修订版或附件原文（修订标记被 WPS 写回剥掉的问题根源）
    if (action === 'open_external_copy') {
      const filePath = body.path as string;
      if (!filePath) {
        return NextResponse.json({ error: 'path is required' }, { status: 400 });
      }
      const resolved = resolvePath(filePath);
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile()) {
        return NextResponse.json({ success: false, error: '文件不存在' }, { status: 404 });
      }
      const tmpDir = join(tmpdir(), 'bobwork-open');
      await fs.mkdir(tmpDir, { recursive: true });
      // 清理超过 24h 的历史副本，防止临时目录膨胀
      const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
      const entries = await fs.readdir(tmpDir).catch(() => [] as string[]);
      await Promise.all(entries.map(async (name) => {
        const p = join(tmpDir, name);
        const st = await fs.stat(p).catch(() => null);
        if (st && st.mtimeMs < staleBefore) await fs.rm(p, { force: true }).catch(() => {});
      }));
      const tempPath = join(tmpDir, basename(resolved));
      await fs.copyFile(resolved, tempPath);
      return NextResponse.json({ success: true, tempPath, mtime: stat.mtimeMs });
    }

    // 新建节点并将文件作为附件
    if (action === 'create_node_with_file') {
      const filePath = body.filePath as string;
      if (!filePath) {
        return NextResponse.json({ error: 'filePath is required' }, { status: 400 });
      }

      // 创建节点
      const resp = await fetch(`${request.nextUrl.origin}/api/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: 'AI Chat',
          model: '',
          sources: [],
        }),
      });
      const nodeData = await resp.json();
      if (!nodeData.success) {
        return NextResponse.json({ error: nodeData.error || 'Failed to create node' }, { status: 500 });
      }

      const nodeId = nodeData.node_id;

      // 添加附件
      const attachmentResp = await fetch(`${request.nextUrl.origin}/api/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add_from_local',
          sourcePath: filePath,
          nodeId,
          nodeTitle: 'AI Chat',
        }),
      });
      const attachmentData = await attachmentResp.json();

      return NextResponse.json({
        success: true,
        nodeId,
        nodeTitle: 'AI Chat',
        attachment: attachmentData.success ? attachmentData.attachment : null,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('local-files POST error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
