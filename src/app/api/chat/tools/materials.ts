/**
 * Agent 工具系统 — 项目材料检索（P0：只读入口）
 *
 * 解决"AI 不知道项目里有哪些资料"：材料上传时宿主已建好内容索引
 * （`.materials-index/`：manifest 元数据 + 逐页正文），但此前只被前端搜索面板
 * （/api/search）使用，agent 侧只能 list_directory / search_files（均按文件名），
 * 导致大量材料从未被读到。本工具把这套已有索引接给 agent：
 *   - 不带 query → 材料清单（有哪些材料、各多少页、文字层还是走视觉识别）；
 *   - 带 query   → 正文命中（项目相对路径 + 页码 + 片段），再按路径取原文。
 *
 * 零新增数据结构、零模型调用（检索在宿主侧读已落盘正文，不重跑抽取/OCR）。
 * 索引只覆盖 materials/**；产出（homework/）暂未入索引（后续阶段）。
 *
 * 依赖方向单向：仅以 import type 依赖 index.ts 的类型（编译期擦除），不产生运行时循环依赖。
 */

import type { Tool } from './index';

/** 严格解析当前激活项目：材料索引只属于项目，无项目时明确报错 */
async function currentProjectRoot(): Promise<string | null> {
  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const project = await getCurrentProject();
    return project?.path || null;
  } catch {
    return null;
  }
}

const NO_PROJECT = '当前没有激活项目：项目材料检索仅在打开的项目的画布下可用。';

/** 索引里的 relPath 是 **materials 相对**路径（如 `被告/证据.pdf`）；工具对外一律给**项目相对**路径
 *  （`materials/被告/证据.pdf`）—— read_attachment / 账本条目出处都按项目相对路径寻址。 */
function toProjectPath(relMaterialPath: string): string {
  return `materials/${relMaterialPath}`;
}

/** 归一化 path 前缀参数（去掉首尾斜杠；空串=不限）。
 *  两种写法都接受：项目相对 `materials/被告` 与 materials 相对 `被告`。 */
function normalizePrefix(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().replace(/^\/+|\/+$/g, '') : '';
  return s === 'materials' ? '' : s.startsWith('materials/') ? s.slice('materials/'.length) : s;
}

/** 判断材料条目是否落在路径前缀内（relPath 为 materials 相对路径） */
function inPrefix(relPath: string, prefix: string): boolean {
  return !prefix || relPath === prefix || relPath.startsWith(`${prefix}/`);
}

/** 索引质量 → 人话 */
function qualityLabel(quality: string): string {
  return quality === 'vision' ? '视觉识别' : '文字层';
}

/** 按目录分组渲染材料清单（目录名作小标题，条目按目录聚集更易扫读） */
function renderInventory(
  items: Array<{ relPath: string; name: string; pageCount: number; quality: string }>,
  total: number,
): string {
  const groups = new Map<string, string[]>();
  for (const it of items) {
    const slash = it.relPath.lastIndexOf('/');
    const dir = slash > 0 ? it.relPath.slice(0, slash) : '.';
    const line = `- ${it.name}（${it.pageCount} 页 · ${qualityLabel(it.quality)}）`;
    const bucket = groups.get(dir);
    if (bucket) bucket.push(line);
    else groups.set(dir, [line]);
  }
  const body = [...groups.entries()]
    .map(([dir, lines]) => `【${toProjectPath(dir === '.' ? '' : dir).replace(/\/$/, '')}】\n${lines.join('\n')}`)
    .join('\n');
  const truncated = items.length < total ? `\n（仅列出前 ${items.length} 条，共 ${total} 份）` : '';
  return `项目材料清单（已建索引 ${total} 份；未建索引/不支持索引的文件用 list_directory "materials/" 查看）：\n${body}${truncated}`;
}

/** 命中片段长度上限（建议值·待实测）：超限截断并在尾部标注 [truncated]，防单条命中吃满上下文 */
const SNIPPET_MAX_CHARS = 200;

/** search_materials 工具 — 项目材料索引的唯一只读入口（清单 / 正文命中两态）。
 *  用途：执行任务前先知道"这个项目里有哪些资料"，再按项目相对路径取原文。 */
async function toolSearchMaterials(args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const prefix = normalizePrefix(args.path);
  const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 20;
  const projectRoot = await currentProjectRoot();
  if (!projectRoot) return NO_PROJECT;

  try {
    const { listMaterialsInventory, searchMaterialsIndex } = await import('@/lib/materials/indexer');

    if (query) {
      // 命中按文件聚合前先多取一些，保证"限定目录"时仍有足够结果
      const fetched = await searchMaterialsIndex(projectRoot, query, prefix ? limit * 3 : limit);
      const hits = fetched.filter((h) => inPrefix(h.relPath, prefix)).slice(0, limit);
      if (hits.length === 0) {
        return `材料索引中未命中「${query}」${prefix ? `（限 materials/${prefix}/）` : ''}。`
          + '注意：索引只覆盖 materials/ 下已建索引的文件，homework/ 等产出不在索引内 —— "未命中"不等于"项目里没有"。'
          + '可换关键词再试，或用 search_materials（不带 query）看本项目有哪些材料，或用 list_directory / search_files 按文件名找。';
      }
      // 索引质量只在 manifest 里（命中结构不带），关联后用于标注「建议视觉复核」
      const qualityByPath = new Map<string, string>();
      try {
        for (const it of await listMaterialsInventory(projectRoot)) qualityByPath.set(it.relPath, it.quality);
      } catch {
        /* 质量关联失败不影响命中输出 */
      }
      const lines = hits
        .map((h) => {
          const projectPath = toProjectPath(h.relPath);
          const quality = qualityByPath.get(h.relPath);
          const mark = quality ? ` · ${qualityLabel(quality)}` : '';
          // 视觉识别（OCR）页码可能出错：零成本加一句提醒，防错 OCR 被当事实
          const review = quality === 'vision' ? '（视觉识别，关键处建议视觉复核）' : '';
          // 片段长度上限：超限截断，[truncated] 必须留在尾部可见，模型才知道片段不完整
          const snippet = h.snippet.length > SNIPPET_MAX_CHARS
            ? `${h.snippet.slice(0, SNIPPET_MAX_CHARS)}…[truncated]`
            : h.snippet;
          // 来源串可直接照抄进成果块：模型无需自己拼路径，编造空间小一截
          return `- [来源: 材料:${projectPath}#p${h.page}] ${projectPath}（第 ${h.page}/${h.pageCount} 页${mark}）${review}\n  ${snippet}`;
        })
        .join('\n');
      const truncNote = hits.length === limit
        ? '\n（已按 limit 截断[truncated]：可缩小 path 前缀、换关键词，或提高 limit（上限 50）后重试）'
        : '';
      return `材料正文命中「${query}」${hits.length} 条（每行首列是可直接引用的来源串）：\n${lines}\n\n`
        + '需要上下文/原文时按上面的项目相对路径调用 read_attachment。'
        + truncNote;
    }

    const all = await listMaterialsInventory(projectRoot);
    const items = all.filter((e) => inPrefix(e.relPath, prefix));
    if (items.length === 0) {
      return prefix
        ? `材料索引中没有 materials/${prefix}/ 下的条目（可能未建索引，或路径不是项目相对路径）。用 list_directory 查看实际目录。`
        : '本项目材料索引为空（尚未上传材料，或已上传的文件类型不支持索引）。注意索引只覆盖 materials/，homework/ 等产出请用 list_directory / read_file 查看。';
    }
    const truncNote = items.length === limit
      ? '\n（已按 limit 截断[truncated]：可缩小 path 前缀、换关键词，或提高 limit（上限 50）后重试）'
      : '';
    return `${renderInventory(items.slice(0, limit), all.length)}\n\n提示：用 search_materials query="关键词" 检索正文命中；材料原文按项目相对路径用 read_attachment 读取。${truncNote}`;
  } catch (e) {
    return `材料检索失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 材料场景工具定义。
 * 场景标注在 registry.ts 的 SCENED_TOOLS（'ledger' = 项目档案，存在激活项目即放行 → 全体 agent 可用）。
 */
export const materialsToolDefs: Tool[] = [
  {
    name: 'search_materials',
    description: 'STEP 2 of 3 (ledger → materials index → original). Search the project MATERIALS index (materials/**) — built by the host at upload time (extracted text layer / OCR), so it costs nothing and never re-OCRs. Order: (1) read_ledger = router (conclusions + project-relative paths), (2) search_materials = locator (page numbers + snippets), (3) read_attachment = fetch the original. SHORTCUT: if read_ledger already gave an exact path, skip this step and read_attachment it directly; if it did not, come here to locate. Omit `query` to list WHAT MATERIALS EXIST (project-relative path, page count, text-layer vs OCR); pass `query` to get page-level hits (path, page/total, snippet). Only materials/ is indexed — homework/ outputs are NOT (use list_directory / read_file for those), and "no hits" here does not mean "does not exist". Unsupported file types are not listed either: use list_directory "materials/". Each hit line starts with a ready-to-copy source tag [来源: 材料:materials/…#pN] — reuse it verbatim (do not assemble your own path or page); OCR-derived pages are marked 建议视觉复核 (verify visually before treating as fact).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword searched in the indexed full text (case-insensitive). Omit to get the materials inventory instead of hits.',
        },
        path: {
          type: 'string',
          description: 'Optional project-relative folder to restrict to (prefix match), e.g. "materials/被告".',
        },
        limit: {
          type: 'number',
          description: 'Max entries/hits to return (default 20, max 50).',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolSearchMaterials,
    maxOutput: 6000,
  },
];