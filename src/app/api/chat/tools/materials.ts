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
 * 2026-10-05 起支持**跨项目**检索（project 参数）：管家要在对话里查「某个项目」的资料，
 * 而不是只查当前打开的那个。两种模式只差回执里的路径形态——
 *   当前项目 → 项目相对路径（`materials/…`，read_attachment 按当前项目根寻址）；
 *   其它项目 → **绝对路径**（相对路径会被 read_attachment 解析到当前项目根，必然读错文件），
 *             来源串同时带项目名限定，免得被当成本项目材料的出处。
 *
 * 依赖方向单向：仅以 import type 依赖 index.ts 的类型（编译期擦除），不产生运行时循环依赖。
 */

import { join } from 'path';
import { isReadablePath } from './shared';
import type { Tool } from './index';

/**
 * 目标项目解析（未点名 → 当前激活项目；点名 → 按名字/id 解析，只匹配活跃项目）。
 * 点名解析失败（同名多命中 / 未找到）原样返回 message 交模型澄清，不兜底、不猜。
 */
type TargetProject = {
  id: string;
  name: string;
  path: string;
  /** current = 就是当前激活项目（相对路径模式）；foreign = 其它项目（绝对路径模式） */
  mode: 'current' | 'foreign';
};

const NO_PROJECT = '当前没有激活项目：未点名项目时材料检索只在打开的项目的画布下可用。要查别的项目，用 project 参数点名（项目名或 id）。';

async function resolveTargetProject(
  ref: unknown,
): Promise<{ ok: true; target: TargetProject } | { ok: false; message: string }> {
  const { getCurrentProject } = await import('@/lib/project/project-manager');
  const { resolveExplicitProject } = await import('@/lib/project/resolve-explicit-project');
  const raw = typeof ref === 'string' ? ref.trim() : '';
  const current = await getCurrentProject().catch(() => null);
  if (!raw) {
    if (!current) return { ok: false, message: NO_PROJECT };
    return { ok: true, target: { id: current.id, name: current.name, path: current.path, mode: 'current' } };
  }
  const resolved = await resolveExplicitProject(raw);
  if (!resolved.ok) {
    const candidates = resolved.candidates?.length
      ? `\n候选：${resolved.candidates.map((c) => `${c.name}（${c.id}）`).join('、')}`
      : '';
    return { ok: false, message: `${resolved.message}${candidates}` };
  }
  const p = resolved.project;
  return {
    ok: true,
    target: { id: p.id, name: p.name, path: p.path, mode: current && current.id === p.id ? 'current' : 'foreign' },
  };
}

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

/** 材料来源串：`[来源: 材料:<路径>#pN]`（页码可省）。
 *  跨项目时在路径前加**项目名限定**（`材料:余靖潘案:materials/x.pdf`）：`[来源: 材料:materials/…]`
 *  是**本项目**材料的引用口径（成果块来源白名单只认本项目路径），跨项目命中必须一眼看出不是本项目的材料。 */
export function materialSourceTag(relProjectPath: string, page: number | undefined, projectName?: string): string {
  const qualified = projectName ? `${projectName}:${relProjectPath}` : relProjectPath;
  return `[来源: 材料:${qualified}${page === undefined ? '' : `#p${page}`}]`;
}

/** 回执里的路径 token：当前项目 = 项目相对路径；跨项目 = **绝对路径**。
 *  原因：read_attachment 把相对路径解析到**当前项目**根 —— 跨项目给相对路径必然读错文件（或报"路径不存在"）；
 *  绝对路径走 isReadablePath 校验（appRoot 全量放行），是跨项目唯一可读形态。 */
export function materialPathToken(absProjectPath: string, relProjectPath: string, mode: 'current' | 'foreign'): string {
  return mode === 'foreign' ? `${absProjectPath.replace(/\/+$/, '')}/${relProjectPath}` : relProjectPath;
}

/** 按目录分组渲染材料清单（目录名作小标题，条目按目录聚集更易扫读）。
 *  跨项目模式改为逐条列绝对路径：跨项目没有"项目相对"这个坐标系，模型要拿到绝对路径才读得到原文；
 *  当前项目模式保持原样（分组 + 项目相对路径），逐字节不变。 */
export function renderInventory(
  items: Array<{ relPath: string; name: string; pageCount: number; quality: string }>,
  total: number,
  target?: { mode: 'current' | 'foreign'; name: string; path: string },
): string {
  const mode = target?.mode ?? 'current';
  const scope = mode === 'foreign' && target ? `项目「${target.name}」` : '项目';
  const hint = mode === 'foreign'
    ? `已建索引 ${total} 份；未建索引/不支持索引的文件用 list_directory "<项目绝对路径>/materials" 查看`
    : `已建索引 ${total} 份；未建索引/不支持索引的文件用 list_directory "materials/" 查看`;
  let body: string;
  if (mode === 'foreign' && target) {
    body = items
      .map((it) => `- ${materialPathToken(target.path, toProjectPath(it.relPath), 'foreign')}（${it.pageCount} 页 · ${qualityLabel(it.quality)}）`)
      .join('\n');
  } else {
    const groups = new Map<string, string[]>();
    for (const it of items) {
      const slash = it.relPath.lastIndexOf('/');
      const dir = slash > 0 ? it.relPath.slice(0, slash) : '.';
      const line = `- ${it.name}（${it.pageCount} 页 · ${qualityLabel(it.quality)}）`;
      const bucket = groups.get(dir);
      if (bucket) bucket.push(line);
      else groups.set(dir, [line]);
    }
    body = [...groups.entries()]
      .map(([dir, lines]) => `【${toProjectPath(dir === '.' ? '' : dir).replace(/\/$/, '')}】\n${lines.join('\n')}`)
      .join('\n');
  }
  const truncated = items.length < total ? `\n（仅列出前 ${items.length} 条，共 ${total} 份）` : '';
  return `${scope}材料清单（${hint}）：\n${body}${truncated}`;
}

/** 命中片段长度上限（建议值·待实测）：超限截断并在尾部标注 [truncated]，防单条命中吃满上下文 */
const SNIPPET_MAX_CHARS = 200;

/** search_materials 工具 — 项目材料索引的唯一只读入口（清单 / 正文命中两态）。
 *  用途：执行任务前先知道"这个项目里有哪些资料"，再按路径取原文；project 参数可指定**别的项目**。 */
async function toolSearchMaterials(args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const prefix = normalizePrefix(args.path);
  const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 20;
  const resolvedTarget = await resolveTargetProject(args.project);
  if (!resolvedTarget.ok) return resolvedTarget.message;
  const target = resolvedTarget.target;
  const projectRoot = target.path;
  const foreign = target.mode === 'foreign';
  const scope = foreign ? `项目「${target.name}」` : '本项目';

  // 跨项目：先确认原文读得到（绝对路径走 isReadablePath）。外置目录且未授权时索引仍可给，
  // 但必须提前说明"读不到原文"，免得模型拿着路径反复失败、把失败当"文件不存在"。
  let unreadable = false;
  if (foreign) {
    try {
      unreadable = !(await isReadablePath(join(projectRoot, 'materials')));
    } catch {
      /* 判定失败按可读处理：真读不到时 read_attachment 会给出硬错误 */
    }
  }
  const warn = unreadable
    ? `⚠ 项目「${target.name}」不在可读范围内（外置目录且未授权）：索引结果可用，但 read_attachment 读不到原文，需先在该项目授权本地目录。\n`
    : '';

  try {
    const { listMaterialsInventory, searchMaterialsIndex } = await import('@/lib/materials/indexer');

    if (query) {
      // 命中按文件聚合前先多取一些，保证"限定目录"时仍有足够结果
      const fetched = await searchMaterialsIndex(projectRoot, query, prefix ? limit * 3 : limit);
      const hits = fetched.filter((h) => inPrefix(h.relPath, prefix)).slice(0, limit);
      if (hits.length === 0) {
        return `${warn}${scope}材料索引中未命中「${query}」${prefix ? `（限 materials/${prefix}/）` : ''}。`
          + '注意：索引只覆盖 materials/ 下已建索引的文件，homework/ 等产出不在索引内 —— "未命中"不等于"项目里没有"。'
          + `可换关键词再试，或用 search_materials（不带 query${foreign ? `，project 传「${target.name}」` : ''}）看有哪些材料，或用 list_directory / search_files 按文件名找。`;
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
          const token = materialPathToken(projectRoot, projectPath, target.mode);
          const quality = qualityByPath.get(h.relPath);
          const mark = quality ? ` · ${qualityLabel(quality)}` : '';
          // 视觉识别（OCR）页码可能出错：零成本加一句提醒，防错 OCR 被当事实
          const review = quality === 'vision' ? '（视觉识别，关键处建议视觉复核）' : '';
          // 跨项目命中要标出材料归属，避免被当成本项目材料的出处
          const where = foreign ? ` · 项目「${target.name}」` : '';
          // 片段长度上限：超限截断，[truncated] 必须留在尾部可见，模型才知道片段不完整
          const snippet = h.snippet.length > SNIPPET_MAX_CHARS
            ? `${h.snippet.slice(0, SNIPPET_MAX_CHARS)}…[truncated]`
            : h.snippet;
          // 来源串可直接照抄进成果块：模型无需自己拼路径，编造空间小一截
          const tag = materialSourceTag(projectPath, h.page, foreign ? target.name : undefined);
          return `- ${tag} ${token}（第 ${h.page}/${h.pageCount} 页${mark}${where}）${review}\n  ${snippet}`;
        })
        .join('\n');
      const truncNote = hits.length === limit
        ? '\n（已按 limit 截断[truncated]：可缩小 path 前缀、换关键词，或提高 limit（上限 50）后重试）'
        : '';
      const readHint = foreign
        ? '需要上下文/原文时按上面的**绝对路径**调用 read_attachment（相对路径会落到当前项目，读错文件）。'
        : '需要上下文/原文时按上面的项目相对路径调用 read_attachment。';
      return `${warn}${scope}材料正文命中「${query}」${hits.length} 条（每行首列是可直接引用的来源串）：\n${lines}\n\n`
        + readHint
        + truncNote;
    }

    const all = await listMaterialsInventory(projectRoot);
    const items = all.filter((e) => inPrefix(e.relPath, prefix));
    if (items.length === 0) {
      return `${warn}${prefix
        ? `${scope}材料索引中没有 materials/${prefix}/ 下的条目（可能未建索引，或路径不是项目相对路径）。用 list_directory 查看实际目录。`
        : `${scope}材料索引为空（尚未上传材料，或已上传的文件类型不支持索引）。注意索引只覆盖 materials/，homework/ 等产出请用 list_directory / read_file 查看。`}`;
    }
    const truncNote = items.length === limit
      ? '\n（已按 limit 截断[truncated]：可缩小 path 前缀、换关键词，或提高 limit（上限 50）后重试）'
      : '';
    const listHint = foreign
      ? `提示：用 search_materials query="关键词" 检索正文命中（project 传「${target.name}」）；材料原文按上面列出的绝对路径用 read_attachment 读取。`
      : '提示：用 search_materials query="关键词" 检索正文命中；材料原文按项目相对路径用 read_attachment 读取。';
    return `${warn}${renderInventory(items.slice(0, limit), all.length, target)}\n\n${listHint}${truncNote}`;
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
    description: 'STEP 2 of 3 (ledger → materials index → original). Search the project MATERIALS index (materials/**) — built by the host at upload time (extracted text layer / OCR), so it costs nothing and never re-OCRs. Order: (1) read_ledger = router (conclusions + project-relative paths), (2) search_materials = locator (page numbers + snippets), (3) read_attachment = fetch the original. SHORTCUT: if read_ledger already gave an exact path, skip this step and read_attachment it directly; if it did not, come here to locate. Omit `query` to list WHAT MATERIALS EXIST (path, page count, text-layer vs OCR); pass `query` to get page-level hits (path, page/total, snippet). OTHER PROJECTS: pass `project` (name or id) to search a project that is NOT the current one — use it when the user names a project ("查一下余靖潘案里的…"); results then carry ABSOLUTE paths (a relative path would resolve against the CURRENT project and read the wrong file) and their source tags are prefixed with that project name. Only materials/ is indexed — homework/ outputs are NOT (use list_directory / read_file for those), and "no hits" here does not mean "does not exist". Unsupported file types are not listed either: use list_directory "materials/". Each hit line starts with a ready-to-copy source tag [来源: 材料:…#pN] — reuse it verbatim (do not assemble your own path or page); OCR-derived pages are marked 建议视觉复核 (verify visually before treating as fact). TO HAND A FILE TO THE USER: end the reply with a line `OutputFile: <path>` using the path exactly as this tool printed it (absolute when another project) — the conversation then renders a clickable file card.',
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
        project: {
          type: 'string',
          description: 'Which project to search: project name or id exactly as the user said it, or "current" when they explicitly said "current project"/"这个项目". Omit to use the CURRENT active project. Never guess a name, and do not switch projects just to search — pass `project` instead. When it resolves to another project the result reports ABSOLUTE paths for reading.',
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