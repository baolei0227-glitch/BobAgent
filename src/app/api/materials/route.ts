import { NextRequest, NextResponse } from 'next/server';
import { promises as fs, type Dirent } from 'fs';
import { join, extname, basename } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';
import { cleanupMdAnnotationSidecars } from '@/lib/md-annotations-cleanup';
import { indexMaterialFile, removeMaterialsIndex, renameMaterialsIndex, isIndexableExt, listMaterialIndexStatus, retryMaterialIndex, kickMaterialsBackfill } from '@/lib/materials/indexer';
import { importUrlAsMaterial, importReadTextAsMaterial, importResearchReportAsMaterial, importSharedDocAsMaterial, extractShareToken, saveCurrentHippoPage, readCurrentHippoPage, REUSABLE_TEXT_MIN_CHARS, type LinkImportResult } from '@/lib/materials/link-import';
import { getShareLink } from '@/lib/share-links';
import { getHippoDriver } from '@/lib/browser-tools/hippo-driver';
import { callNotes } from '@/lib/mcp/notes-bridge';
import { readFileTags, setFileTags, setFileTagsBulk, renameFileTags, removeFileTags, isTagScope, type TagScope } from '@/lib/files/tags';

const MAX_SIZE = 500 * 1024 * 1024;

/** bobnotes raw/ 单条素材上限（插件 notes_add_raw 硬约束，超出直接报错）：
 *  超长网页正文在此截断并留痕，避免整条收藏失败 */
const RAW_NOTES_MAX_CHARS = 20000;

/** PDF 同级 sidecar 后缀（批注 / OCR 识别状态）：与源文件同级存放，
 *  单个文件移动时需一并搬迁，否则新位置读不到既有批注与识别结果 */
const PDF_SIDECAR_SUFFIXES = ['.annotations.json', '.ocr.json'] as const;

/** 归档目录名：位于作用域根（materials/、homework/）之下。
 *  点开头 → 资料树扫描、搜索结果、标签候选遍历都天然看不到，渲染层无需额外过滤。 */
const ARCHIVE_DIR = '.archive';

/** 拆分并清洗作用域根下的相对路径：逐段去掉 ".." 与非法字符，过滤空段（防穿越） */
function sanitizeRelSegments(relPath: string): string[] {
  return relPath
    .split('/')
    .map((s) => s.replace(/\.\./g, '').replace(/[\\/:*?"<>|]/g, '_').trim())
    .filter((s) => s.length > 0);
}

/** 链接导入 / Hippo 一键保存共用的返回体：前端按 file 渲染「解析中」并 Toast 文件名 */
function pageImportPayload(result: Extract<LinkImportResult, { ok: true }>) {
  return {
    success: true,
    via: result.via,
    title: result.title,
    file: {
      name: result.name,
      path: result.path,
      size: result.bytes,
      extension: result.extension,
      indexable: true,
    },
  };
}

/** 把 materials 下的一个条目（文件 / 子目录）搬到目标分组目录（toSegs 为空 = materials 根）。
 *  同名冲突追加 " (1)" 后缀（与上传 / 复制行为一致）；文件的 PDF sidecar、内容索引键、标签表键随迁。
 *  失败时不做任何搬运，返回 error 供调用方决定整体报错还是跳过该条目。 */
async function relocateMaterialEntry(
  projectPath: string,
  materialsPath: string,
  fromSegs: string[],
  toSegs: string[],
): Promise<{ ok: true; path: string; name: string } | { ok: false; error: string }> {
  const fromRel = fromSegs.join('/');
  const toRel = toSegs.join('/');
  const srcAbs = join(materialsPath, ...fromSegs);
  const destDirAbs = toSegs.length > 0 ? join(materialsPath, ...toSegs) : materialsPath;
  if (!srcAbs.startsWith(materialsPath) || !destDirAbs.startsWith(materialsPath)) {
    return { ok: false, error: 'Invalid path' };
  }

  const stat = await fs.stat(srcAbs).catch(() => null);
  if (!stat) return { ok: false, error: 'Not found' };
  const srcName = fromSegs[fromSegs.length - 1];
  await fs.mkdir(destDirAbs, { recursive: true });

  // 同目录 → 已在原位，不做搬运
  if (destDirAbs === join(srcAbs, '..')) return { ok: true, path: fromRel, name: srcName };

  // 目标同名冲突：追加 " (1)" / " (2)" 后缀
  const ext = stat.isDirectory() ? '' : extname(srcName);
  const stem = ext ? srcName.slice(0, -ext.length) : srcName;
  let destName = srcName;
  let destAbs = join(destDirAbs, destName);
  for (let i = 1; i < 100; i++) {
    if (!(await fs.stat(destAbs).catch(() => null))) break;
    destName = `${stem} (${i})${ext}`;
    destAbs = join(destDirAbs, destName);
  }

  await fs.rename(srcAbs, destAbs);
  // 文件级移动：PDF 批注 / OCR sidecar 与源文件同级存放，需一并搬迁（目录移动由 rename 整棵带走）
  if (stat.isFile()) {
    for (const suffix of PDF_SIDECAR_SUFFIXES) {
      const fromSidecar = srcAbs + suffix;
      if (await fs.stat(fromSidecar).catch(() => null)) {
        await fs.rename(fromSidecar, destAbs + suffix).catch(() => {});
      }
    }
  }
  const newRel = toRel ? `${toRel}/${destName}` : destName;
  // manifest 键路径迁移（索引按内容 hash 寻址，hash 目录无需搬迁）。
  // 需等待完成：若静默失败，按新路径查不到索引会退化为重新解析
  try {
    await renameMaterialsIndex(projectPath, fromRel, newRel);
  } catch (err) {
    console.error('Materials index rename failed:', fromRel, '->', newRel, err);
  }
  // 标签表键随路径迁移（命中条目及其子路径前缀）
  try {
    await renameFileTags(projectPath, 'materials', fromRel, newRel);
  } catch (err) {
    console.error('Materials tags rename failed:', fromRel, '->', newRel, err);
  }
  return { ok: true, path: newRel, name: destName };
}

/** 提升为资料后建索引（目录则递归）。
 *  不能只靠 kickMaterialsBackfill：它有「每项目本会话只扫一次」守卫，覆盖不到刚落位的新条目。 */
async function indexPromotedMaterials(
  projectPath: string,
  materialsPath: string,
  relSegs: string[],
  isDir: boolean,
): Promise<void> {
  if (!isDir) {
    await indexMaterialFile(projectPath, relSegs.join('/')).catch(() => {});
    return;
  }
  const walk = async (dirAbs: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // 点开头条目（sidecar / 清册等）不进资料树
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dirAbs, entry.name), childRel);
        continue;
      }
      if (!isIndexableExt(extname(entry.name))) continue;
      void indexMaterialFile(projectPath, childRel).catch(() => {});
    }
  };
  await walk(join(materialsPath, ...relSegs), relSegs.join('/'));
}

/** 归档箱条目：path 为「去掉 .archive 前缀」的作用域根相对路径，归档 / 恢复两侧同义 */
interface ArchivedFileItem {
  path: string;
  name: string;
  size: number;
  archivedAt: string;
}

/** 递归列出归档目录下的文件（返回的 path 相对归档目录，即归档前的原始相对路径） */
async function listArchivedFiles(root: string, prefix = ''): Promise<ArchivedFileItem[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return []; // 归档目录不存在 = 空归档箱
  }
  const out: ArchivedFileItem[] = [];
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listArchivedFiles(root, rel)));
      continue;
    }
    const stat = await fs.stat(join(root, rel)).catch(() => null);
    if (!stat) continue;
    out.push({ path: rel, name: entry.name, size: stat.size, archivedAt: stat.mtime.toISOString() });
  }
  return out;
}

/** 读取 homework 归属清册（键 = homework 根相对路径）；无清册或损坏时返回 null */
async function readHomeworkOwnership(projectPath: string): Promise<Record<string, string> | null> {
  try {
    const raw = await fs.readFile(join(projectPath, 'homework', '.ownership.json'), 'utf-8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

/** 原子写回 homework 归属清册（tmp + rename，与 local-files 侧写法一致） */
async function writeHomeworkOwnership(projectPath: string, manifest: Record<string, string>): Promise<void> {
  const manifestPath = join(projectPath, 'homework', '.ownership.json');
  const tmp = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.rename(tmp, manifestPath);
}

/** 归档 / 恢复时迁移 homework/.ownership.json 的归属键。
 *  与 local-files 的 transferHomeworkOwnership 不同：那里禁止目标落在点目录下，此处必须放行。 */
async function transferHomeworkOwnershipPath(projectPath: string, fromRel: string, toRel: string): Promise<void> {
  const manifest = await readHomeworkOwnership(projectPath);
  if (!manifest) return;
  const moves: Array<[string, string]> = [];
  if (manifest[fromRel]) moves.push([fromRel, toRel]);
  const prefix = `${fromRel}/`;
  for (const key of Object.keys(manifest)) {
    if (key.startsWith(prefix)) moves.push([key, `${toRel}/${key.slice(prefix.length)}`]);
  }
  if (moves.length === 0) return;
  for (const [from, to] of moves) {
    manifest[to] = manifest[from];
    delete manifest[from];
  }
  await writeHomeworkOwnership(projectPath, manifest).catch(() => {});
}

/** 永久删除时清理 homework/.ownership.json 中该路径及其子路径的归属条目 */
async function removeHomeworkOwnershipPaths(projectPath: string, rel: string): Promise<void> {
  const manifest = await readHomeworkOwnership(projectPath);
  if (!manifest) return;
  const prefix = `${rel}/`;
  let changed = false;
  for (const key of Object.keys(manifest)) {
    if (key === rel || key.startsWith(prefix)) {
      delete manifest[key];
      changed = true;
    }
  }
  if (!changed) return;
  await writeHomeworkOwnership(projectPath, manifest).catch(() => {});
}

/** 归档 / 恢复单个条目：在 <作用域根>/ 与 <作用域根>/.archive/ 之间搬运，保留原相对路径。
 *  返回搬运后的「逻辑相对路径」（不含 .archive 前缀）；源不存在或搬运失败返回 null。 */
async function moveToArchiveState(
  projectPath: string,
  scope: TagScope,
  rel: string,
  archived: boolean,
): Promise<string | null> {
  const segs = sanitizeRelSegments(rel);
  if (segs.length === 0) return null;
  // 已在归档目录内的条目不可再归档（幂等保护）
  if (archived && segs[0] === ARCHIVE_DIR) return null;

  const scopeRoot = join(projectPath, scope);
  const archiveRoot = join(scopeRoot, ARCHIVE_DIR);
  const srcRoot = archived ? scopeRoot : archiveRoot;
  const destRoot = archived ? archiveRoot : scopeRoot;
  const srcAbs = join(srcRoot, ...segs);
  const destDirAbs = join(destRoot, ...segs.slice(0, -1));

  const stat = await fs.stat(srcAbs).catch(() => null);
  if (!stat) return null;

  await fs.mkdir(destDirAbs, { recursive: true });
  // 目标同名冲突：追加 " (1)" / " (2)" 后缀（与上传 / 复制行为一致）
  const name = segs[segs.length - 1];
  const ext = stat.isDirectory() ? '' : extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let destName = name;
  let destAbs = join(destDirAbs, destName);
  for (let i = 1; i < 100; i++) {
    if (!(await fs.stat(destAbs).catch(() => null))) break;
    destName = `${stem} (${i})${ext}`;
    destAbs = join(destDirAbs, destName);
  }

  try {
    await fs.rename(srcAbs, destAbs);
  } catch {
    return null;
  }
  // 目录由 rename 整棵带走；文件则需一并搬迁同级 PDF sidecar（批注 / OCR 识别结果）
  if (stat.isFile()) {
    for (const suffix of PDF_SIDECAR_SUFFIXES) {
      if (await fs.stat(srcAbs + suffix).catch(() => null)) {
        await fs.rename(srcAbs + suffix, destAbs + suffix).catch(() => {});
      }
    }
  }

  const newRel = [...segs.slice(0, -1), destName].join('/');
  // 附属数据键迁移：归档前 / 归档后两种键形态（含 / 不含 .archive 前缀）
  const fromRel = archived ? rel : `${ARCHIVE_DIR}/${rel}`;
  const toRel = archived ? `${ARCHIVE_DIR}/${newRel}` : newRel;
  if (fromRel !== toRel) {
    // 内容索引键迁移（仅 materials 有内容索引）：内容 hash 目录不搬，恢复后零重新解析
    if (scope === 'materials') {
      await renameMaterialsIndex(projectPath, fromRel, toRel).catch(() => {});
    }
    await renameFileTags(projectPath, scope, fromRel, toRel).catch(() => {});
    if (scope === 'homework') {
      await transferHomeworkOwnershipPath(projectPath, fromRel, toRel);
    }
  }
  return newRel;
}

/** 标签作用域：materials 资料 / homework 作业产物（本路由统一承载两者的标签读写，各自落在自己的 .tags.json）。
 *  参数缺省或非法值一律回落到 materials。 */
function resolveTagScope(raw: unknown): TagScope {
  return isTagScope(raw) ? raw : 'materials';
}

interface MaterialTreeNode {
  name: string;
  type: 'file' | 'directory';
  children?: MaterialTreeNode[];
  size?: number;
  extension?: string;
  mimeType?: string;
  path: string;
  uploadedAt?: string;
}

function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.csv': 'text/csv',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

async function scanMaterialsTree(dirPath: string, prefix: string, maxDepth: number): Promise<MaterialTreeNode[]> {
  if (maxDepth <= 0) return [];

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: MaterialTreeNode[] = [];

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    // 点文件（.tags.json 标签表等）为内部数据，不作为资料展示
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dirPath, entry.name);
    const relPath = prefix ? prefix + '/' + entry.name : entry.name;

    if (entry.isDirectory()) {
      const children = await scanMaterialsTree(fullPath, relPath, maxDepth - 1);
      nodes.push({
        name: entry.name,
        type: 'directory',
        path: relPath,
        children: children.length > 0 ? children : [],
      });
    } else {
      const stat = await fs.stat(fullPath);
      const ext = extname(entry.name).toLowerCase();
      const displayName = entry.name.replace(/^[a-f0-9-]+_/, '');

      nodes.push({
        name: displayName,
        type: 'file',
        path: relPath,
        size: stat.size,
        extension: ext,
        mimeType: getMimeType(ext),
        uploadedAt: stat.mtime.toISOString(),
      });
    }
  }

  return nodes;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'list';

    const project = await getCurrentProject();
    const projectPath = project.path;

    if (action === 'list') {
      const materialsPath = join(projectPath, 'materials');
      await fs.mkdir(materialsPath, { recursive: true });
      // 可索引白名单扩容（如新增 .docx/.xlsx）后，老材料在打开资料树时补建索引（后台、一次性、不阻断）
      kickMaterialsBackfill(projectPath);
      const tree = await scanMaterialsTree(materialsPath, '', 3);
      return NextResponse.json({ success: true, tree });
    }

    if (action === 'index_status') {
      // 上传后前端轮询：已索引 / 后台识别中 / 识别失败三态（零抽取开销，只读 manifest）。
      // 长扫描件走后台异步任务，需要「进行中」与「失败可重试」在前端可见，不再是静默丢弃。
      const status = await listMaterialIndexStatus(projectPath);
      return NextResponse.json({ success: true, ...status });
    }

    if (action === 'tags') {
      // 标签表（键 = 作用域根相对路径）：前端据此在扁平清单上做筛选与编辑
      const scope = resolveTagScope(searchParams.get('scope'));
      const tags = await readFileTags(projectPath, scope);
      return NextResponse.json({ success: true, scope, tags });
    }

    if (action === 'archived') {
      // 归档箱清单：递归列 <作用域根>/.archive/ 下的文件。
      // 归档目录是点目录，资料树与搜索都不会展示，故单独列出供归档箱恢复 / 永久删除。
      const scope = resolveTagScope(searchParams.get('scope'));
      const items = await listArchivedFiles(join(projectPath, scope, ARCHIVE_DIR));
      return NextResponse.json({ success: true, scope, items });
    }

    if (action === 'read') {
      const filePath = searchParams.get('path');
      if (!filePath) {
        return NextResponse.json({ error: 'path is required' }, { status: 400 });
      }
      const fullPath = join(projectPath, 'materials', filePath);
      if (!fullPath.startsWith(join(projectPath, 'materials'))) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
      }

      const content = await fs.readFile(fullPath);
      const ext = extname(fullPath).toLowerCase();
      const mimeType = getMimeType(ext);

      return new NextResponse(content, {
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const project = await getCurrentProject();
    const projectPath = project.path;
    const materialsPath = join(projectPath, 'materials');
    await fs.mkdir(materialsPath, { recursive: true });

    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const body = await request.json();
      const action = body.action;

      if (action === 'create_folder') {
        const folderPath = body.folderPath || '';
        if (!folderPath.trim()) {
          return NextResponse.json({ error: 'folderPath is required' }, { status: 400 });
        }
        const safeSegments = folderPath
          .split('/')
          .map((s: string) => s.replace(/\.\./g, '').replace(/[\\/:*?"<>|]/g, '_').trim())
          .filter((s: string) => s.length > 0);
        if (safeSegments.length === 0) {
          return NextResponse.json({ error: 'Invalid folder name' }, { status: 400 });
        }
        const safeName = safeSegments.join('/');
        const targetPath = join(materialsPath, ...safeSegments);
        await fs.mkdir(targetPath, { recursive: true });
        return NextResponse.json({ success: true, path: safeName });
      }

      if (action === 'retry_index') {
        // 失败态材料的重试入口：清掉该路径的 failed/pending 登记后重新走索引（长扫描件会再转后台）
        const pathSegs = sanitizeRelSegments(typeof body.path === 'string' ? body.path : '');
        if (pathSegs.length === 0) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }
        const result = await retryMaterialIndex(projectPath, pathSegs.join('/'));
        return NextResponse.json({ success: true, ...result });
      }

      if (action === 'add_link' || action === 'save_page') {
        // add_link：带「研究中已读到的正文」时直接落盘，否则抓取正文
        // （服务端直抓优先，失败 / 登录墙回落 Hippo）
        // save_page：Hippo 侧边栏一键保存当前标签（直接读已渲染的页面，不重新抓取）
        const folder = typeof body.folder === 'string' ? body.folder : '';
        // save_page 两个去向：project = 当前项目 materials/（默认）；notes = bobnotes raw/ 收件箱（只投放，不编译）
        if (action === 'save_page' && body.target === 'notes') {
          const page = await readCurrentHippoPage();
          if (!page.ok) {
            return NextResponse.json({ error: page.error }, { status: 502 });
          }
          const clip = await callNotes('add_raw', {
            text:
              page.markdown.length > RAW_NOTES_MAX_CHARS
                ? `${page.markdown.slice(0, RAW_NOTES_MAX_CHARS)}\n\n> …(truncated: the raw inbox accepts at most ${RAW_NOTES_MAX_CHARS} chars)`
                : page.markdown,
            title: page.title,
            source: page.url,
          });
          if (!clip.ok) {
            return NextResponse.json({ error: clip.error }, { status: 502 });
          }
          const rawEntry = (clip.data?.raw ?? {}) as { id?: string; title?: string };
          const rawId = rawEntry.id ?? '';
          // compile=true：收藏即编译（一键 —— 收件箱留档 + 交给插件大脑 ingest）
          // 编译耗时不可控（走大脑模型），故不阻塞返回、失败只 console.warn 留痕：
          // 条目已落在收件箱，用户随时可用 /note ingest 补编译，不出现「假失败」误导。
          if (body.compile === true && rawId) {
            void callNotes('ingest', { ids: [rawId] })
              .then((r) => {
                if (!r.ok) console.warn('[materials] save_page compile failed:', r.error);
              })
              .catch((e) => console.warn('[materials] save_page compile error:', e));
          }
          return NextResponse.json({
            success: true,
            target: 'notes',
            compiled: body.compile === true && Boolean(rawId),
            title: rawEntry.title || page.title,
            entry: { id: rawId },
          });
        }
        let result;
        if (action === 'save_page') {
          result = await saveCurrentHippoPage({ projectRoot: projectPath, folder });
        } else {
          const url = typeof body.url === 'string' ? body.url : '';
          if (!url.trim()) {
            return NextResponse.json({ error: 'url is required' }, { status: 400 });
          }
          // Research 档来源导入会带上「本轮已读到的正文」：有就直接落盘（与回答里的引用同版），
          // 缺失 / 太短才回落抓取链路（服务端直抓 → Hippo Browser）
          const captured = typeof body.body === 'string' ? body.body.trim() : '';
          result =
            captured.length >= REUSABLE_TEXT_MIN_CHARS
              ? await importReadTextAsMaterial({
                  projectRoot: projectPath,
                  url,
                  title: typeof body.title === 'string' ? body.title : '',
                  markdown: captured,
                  folder,
                })
              : await importUrlAsMaterial({ projectRoot: projectPath, url, folder });
        }
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 502 });
        }
        // 与上传同口径：异步建立内容索引，不阻塞返回
        void indexMaterialFile(projectPath, result.path).catch(() => {});
        return NextResponse.json(pageImportPayload(result));
      }

      if (action === 'paste_link') {
        // 粘贴链接（工作区 Ctrl+V / ⋮ → Paste link）：智能识别两类链接
        //   - 本机分享链接（路径 /share/<token> 且 token 能在本机 store 命中）→ 复制**原始 md**
        //     （原文保真、离线可用，不依赖局域网是否可达）
        //   - 其它 http(s) 链接（普通网页、别人机器发来的分享链接）→ 走既有抓取管线
        // 判定只靠 token 命中、不做 host 校验：别人机器的 token 在本地查不到，自然回落抓取。
        const url = typeof body.url === 'string' ? body.url.trim() : '';
        if (!url) {
          return NextResponse.json({ error: 'url is required' }, { status: 400 });
        }
        const folder = typeof body.folder === 'string' ? body.folder : '';
        const token = extractShareToken(url);
        const share = token ? await getShareLink(token) : null;
        const result = share
          ? await importSharedDocAsMaterial({
              projectRoot: projectPath,
              url,
              title: share.title,
              folder,
              sourcePath: share.path,
            })
          : await importUrlAsMaterial({ projectRoot: projectPath, url, folder });
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 502 });
        }
        // 与上传同口径：异步建立内容索引，不阻塞返回
        void indexMaterialFile(projectPath, result.path).catch(() => {});
        return NextResponse.json(pageImportPayload(result));
      }

      if (action === 'add_report') {
        // 研究结论固化：正文即 Hippo 对话栏 Research 档本轮的回答（派生材料），
        // 出处头带会话节点与依据来源清单。与 add_link 一样由用户显式勾选触发，不自动入库。
        const markdown = typeof body.body === 'string' ? body.body : '';
        if (!markdown.trim()) {
          return NextResponse.json({ error: 'body is required' }, { status: 400 });
        }
        const result = await importResearchReportAsMaterial({
          projectRoot: projectPath,
          nodeId: typeof body.nodeId === 'string' ? body.nodeId : '',
          title: typeof body.title === 'string' ? body.title : '',
          markdown,
          sources: Array.isArray(body.sources) ? body.sources.filter((u: unknown): u is string => typeof u === 'string') : [],
          folder: typeof body.folder === 'string' ? body.folder : '',
        });
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 502 });
        }
        void indexMaterialFile(projectPath, result.path).catch(() => {});
        return NextResponse.json(pageImportPayload(result));
      }

      if (action === 'open_in_hippo') {
        // 收件箱（或任意）链接 → 在 Hippo 新标签打开并聚焦。
        // 正文不在这里抓：登录墙 / JS 渲染 / 正文抽取全交给 Hippo，
        // 用户随后用对话栏书签按钮「Current project」把渲染好的正文存进本项目 materials/。
        const url = typeof body.url === 'string' ? body.url.trim() : '';
        if (!/^https?:\/\//i.test(url)) {
          return NextResponse.json({ error: 'A http(s) URL is required' }, { status: 400 });
        }
        const opened = await getHippoDriver().exec('browser_open_tab', { url, activate: true }, {});
        if (!opened.ok) {
          return NextResponse.json(
            { error: opened.error?.message || 'Hippo Browser is not available', hint: opened.error?.hint },
            { status: 502 },
          );
        }
        return NextResponse.json({ success: true, url });
      }

      if (action === 'set_tags') {
        // 覆盖式设置某个文件（资料 / 作业产物）的标签（空数组 = 取消全部标签）
        const scope = resolveTagScope(body.scope);
        const pathSegs = sanitizeRelSegments(typeof body.path === 'string' ? body.path : '');
        if (pathSegs.length === 0) {
          return NextResponse.json({ error: 'path is required' }, { status: 400 });
        }
        const relPath = pathSegs.join('/');
        const tags = await setFileTags(projectPath, scope, relPath, body.tags);
        return NextResponse.json({ success: true, scope, path: relPath, tags });
      }

      if (action === 'set_tags_bulk') {
        // 多选批量打标签：一次读表 + 一次落盘（避免逐项读改写同一 .tags.json 时互相覆盖）
        const scope = resolveTagScope(body.scope);
        const items: { relPath: string; tags: unknown }[] = [];
        for (const raw of Array.isArray(body.items) ? body.items : []) {
          if (!raw || typeof raw !== 'object') continue;
          const rec = raw as { path?: unknown; tags?: unknown };
          const segs = sanitizeRelSegments(typeof rec.path === 'string' ? rec.path : '');
          if (segs.length === 0) continue;
          items.push({ relPath: segs.join('/'), tags: rec.tags });
        }
        if (items.length === 0) {
          return NextResponse.json({ error: 'items is required' }, { status: 400 });
        }
        const tags = await setFileTagsBulk(projectPath, scope, items);
        return NextResponse.json({ success: true, scope, tags });
      }

      if (action === 'set_archived') {
        // 批量归档 / 恢复：在 <作用域根>/ 与 <作用域根>/.archive/ 之间搬运选中项，保留原相对路径。
        // materials 与 homework 共用本实现；一次请求处理整批，单项失败不阻断其余项。
        const scope = resolveTagScope(body.scope);
        const archived = body.archived !== false;
        const scopeRoot = join(projectPath, scope);
        await fs.mkdir(archived ? join(scopeRoot, ARCHIVE_DIR) : scopeRoot, { recursive: true });

        const moved: string[] = [];
        const failed: string[] = [];
        for (const raw of Array.isArray(body.items) ? body.items : []) {
          const rel = typeof raw === 'string' ? sanitizeRelSegments(raw).join('/') : '';
          if (!rel) continue;
          const next = await moveToArchiveState(projectPath, scope, rel, archived);
          if (next) moved.push(next);
          else failed.push(rel);
        }
        if (moved.length === 0 && failed.length === 0) {
          return NextResponse.json({ error: 'items is required' }, { status: 400 });
        }
        return NextResponse.json({ success: true, scope, archived, moved, failed });
      }

      if (action === 'move') {
        // 移动：把 materials 下的文件 / 分组移到目标分组（to 为空串 = 移到 materials 根）。
        // 分组视图把资料行拖到另一个分组即为真实移动。
        const fromSegs = sanitizeRelSegments(typeof body.from === 'string' ? body.from : '');
        const toSegs = sanitizeRelSegments(typeof body.to === 'string' ? body.to : '');
        if (fromSegs.length === 0) {
          return NextResponse.json({ error: 'from is required' }, { status: 400 });
        }
        const fromRel = fromSegs.join('/');
        const toRel = toSegs.join('/');
        // 目标已在源目录内（拖进自己 / 自己的子孙目录）→ 拒绝，避免自我吞并
        if (toRel === fromRel || toRel.startsWith(fromRel + '/')) {
          return NextResponse.json({ error: 'Cannot move into itself' }, { status: 400 });
        }
        const result = await relocateMaterialEntry(projectPath, materialsPath, fromSegs, toSegs);
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: result.error === 'Not found' ? 404 : 403 });
        }
        return NextResponse.json({ success: true, path: result.path, name: result.name });
      }

      if (action === 'dissolve_group') {
        // 解散分组：把分组目录下的直属条目全部搬回 materials 根（未分组），再删掉这个已空的目录。
        // 文件不删除，只回到未分组；子目录整体搬迁，内部结构不变。
        const groupSegs = sanitizeRelSegments(typeof body.groupPath === 'string' ? body.groupPath : '');
        if (groupSegs.length === 0) {
          return NextResponse.json({ error: 'groupPath is required' }, { status: 400 });
        }
        if (groupSegs[0] === ARCHIVE_DIR) {
          return NextResponse.json({ error: 'Cannot dissolve the archive folder' }, { status: 400 });
        }
        const groupAbs = join(materialsPath, ...groupSegs);
        if (!groupAbs.startsWith(materialsPath)) {
          return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
        }
        const groupStat = await fs.stat(groupAbs).catch(() => null);
        if (!groupStat || !groupStat.isDirectory()) {
          return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }
        const children = await fs.readdir(groupAbs, { withFileTypes: true });
        const moved: string[] = [];
        const failed: string[] = [];
        for (const child of children) {
          const result = await relocateMaterialEntry(projectPath, materialsPath, [...groupSegs, child.name], []);
          if (result.ok) moved.push(result.path); else failed.push(child.name);
        }
        if (failed.length > 0) {
          // 有条目没搬出去：保留目录（否则残留条目会随目录一起被删），让用户重试
          return NextResponse.json({ error: `Failed to move: ${failed.join(', ')}`, moved, failed }, { status: 500 });
        }
        await fs.rm(groupAbs, { recursive: true, force: true });
        return NextResponse.json({ success: true, moved });
      }

      if (action === 'promote') {
        // 提升为资料：把 homework 里的成果搬 / 复制进 materials，转成可检索、可被账本引用的正式材料。
        // 索引边界不变——不是让索引去读 homework，而是让文件**真的成为** materials 内的材料；
        // 落位后必须显式建索引（见 indexPromotedMaterials 注释）。
        const fromSegs = sanitizeRelSegments(typeof body.from === 'string' ? body.from : '');
        const toSegs = sanitizeRelSegments(typeof body.to === 'string' ? body.to : '');
        const isCopy = body.copy === true;
        if (fromSegs.length === 0) {
          return NextResponse.json({ error: 'from is required' }, { status: 400 });
        }

        const homeworkPath = join(projectPath, 'homework');
        const srcAbs = join(homeworkPath, ...fromSegs);
        if (!srcAbs.startsWith(homeworkPath)) {
          return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
        }
        const stat = await fs.stat(srcAbs).catch(() => null);
        if (!stat) return NextResponse.json({ error: 'Not found' }, { status: 404 });

        const destDirAbs = toSegs.length > 0 ? join(materialsPath, ...toSegs) : materialsPath;
        if (!destDirAbs.startsWith(materialsPath)) {
          return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
        }
        await fs.mkdir(destDirAbs, { recursive: true });

        // 目标同名冲突：追加 " (1)" / " (2)"（与上传 / 搬运 / 复制行为一致）
        const srcName = fromSegs[fromSegs.length - 1];
        const srcExt = stat.isDirectory() ? '' : extname(srcName);
        const stem = srcExt ? srcName.slice(0, -srcExt.length) : srcName;
        let destName = srcName;
        let destAbs = join(destDirAbs, destName);
        for (let i = 1; i < 100; i++) {
          if (!(await fs.stat(destAbs).catch(() => null))) break;
          destName = `${stem} (${i})${srcExt}`;
          destAbs = join(destDirAbs, destName);
        }

        try {
          if (isCopy) await fs.cp(srcAbs, destAbs, { recursive: true });
          else await fs.rename(srcAbs, destAbs);
        } catch (e) {
          return NextResponse.json(
            { error: e instanceof Error ? e.message : 'Promote failed' },
            { status: 500 },
          );
        }

        const fromRel = fromSegs.join('/');
        const destRelSegs = [...toSegs, destName];
        if (isCopy) {
          // 复制：原件仍在工作区，归属清册与标签保持原样（资料侧副本按新路径重新起标签）
        } else {
          // 移动：成果已离开工作区 —— 清掉归属清册键（留着会成指向不存在路径的僵尸键），
          // 并回收 homework 侧标签键（标签表按「作用域 + 相对路径」寻址，键留着会指向空路径）
          await removeHomeworkOwnershipPaths(projectPath, fromRel);
          await removeFileTags(projectPath, 'homework', fromRel).catch(() => {});
        }

        // 建内容索引：文本层本地抽取，扫描件走统一 OCR 链路；异步不阻塞返回（与上传分支同款）
        void indexPromotedMaterials(projectPath, materialsPath, destRelSegs, stat.isDirectory());

        return NextResponse.json({
          success: true,
          path: destRelSegs.join('/'),
          name: destName,
          copied: isCopy,
        });
      }

      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    const folder = (formData.get('folder') as string) || '';
    let targetDir = materialsPath;
    if (folder) {
      const safeSegments = folder
        .split('/')
        .map((s: string) => s.replace(/\.\./g, '').replace(/[\\/:*?"<>|]/g, '_').trim())
        .filter((s: string) => s.length > 0);
      targetDir = join(materialsPath, ...safeSegments);
      await fs.mkdir(targetDir, { recursive: true });
    }

    const fileName = basename(file.name).replace(/[\\/:*?"<>|\n\r\t]/g, '_');
    const filePath = join(targetDir, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    const ext = extname(file.name).toLowerCase();
    const stat = await fs.stat(filePath);

    const relFolder = folder
      .split('/')
      .map((s: string) => s.replace(/\.\./g, '').replace(/[\\/:*?"<>|]/g, '_').trim())
      .filter((s: string) => s.length > 0)
      .join('/');
    const relPath = relFolder ? relFolder + '/' + fileName : fileName;

    // 建立内容索引（异步，不阻塞上传返回；文本层本地抽取，扫描件走统一 OCR 链路）
    void indexMaterialFile(projectPath, relPath).catch(() => {});

    return NextResponse.json({
      success: true,
      file: {
        name: file.name,
        path: relPath,
        size: stat.size,
        extension: ext,
        uploadedAt: stat.mtime.toISOString(),
        // 是否会被后台建立内容索引（前端据此决定是否显示「解析中」提示）
        indexable: isIndexableExt(ext),
      },
    });
  } catch (e) {
    console.error('Materials operation failed:', e);
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const project = await getCurrentProject();
    const projectPath = project.path;

    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    // 归档箱的「永久删除」也走本接口：scope 指定作用域，path 为 .archive/ 下的相对路径
    const scope = resolveTagScope(searchParams.get('scope'));
    const scopeRoot = join(projectPath, scope);

    const fullPath = join(scopeRoot, filePath);
    if (!fullPath.startsWith(scopeRoot)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
    }

    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      await fs.rm(fullPath, { recursive: true });
    } else {
      await fs.unlink(fullPath);
    }
    // 联动清理：删除文档/目录时同步清理 md-annotations 中对应的 sidecar
    await cleanupMdAnnotationSidecars({ targets: [{ abs: fullPath, isDir: stat.isDirectory() }] }).catch(() => {});
    // 回收内容索引（移除 manifest 条目并清理不再被引用的 hash 目录；仅 materials 有内容索引）
    if (scope === 'materials') {
      void removeMaterialsIndex(projectPath, filePath, stat.isDirectory()).catch(() => {});
    }
    // 回收标签表中该路径及其子路径的条目
    await removeFileTags(projectPath, scope, filePath).catch(() => {});
    // homework：同步清理 .ownership.json 归属清册中该路径及其子路径的条目
    if (scope === 'homework') {
      await removeHomeworkOwnershipPaths(projectPath, filePath);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
