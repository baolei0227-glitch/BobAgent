/**
 * src/lib/runtime/project-brief.ts
 * 项目档案「结构性预取」：首轮请求构建时由宿主生成一段档案快照，0 模型调用、0 决策成本。
 *
 * 为什么要有它：`read_ledger` / `search_materials` 都已挂上工具面，但**调度权在模型手里** ——
 * 软指针只有几十 token，实测模型可以不调，于是"项目里有什么"这件事在首轮完全缺席。
 * 本模块把「有哪些可选」直接摆进上下文，但**不替模型做相关性判断**：
 *   - 账本索引 = 路由器（条目 id + 标题 + 出处路径：有什么结论、指向哪个原文）；
 *   - 材料清单 = 定位器的目录（已建索引材料的项目相对路径 + 页数 + 索引质量）。
 * 两者都只回答「有哪些」，不回答「该看哪些」——不越界到被否决的"宿主人肉做相关性筛选"。
 *
 * 边界（否则就是变相全量注入）：
 *   - 账本条目超过 LEDGER_MAX_ITEMS 只取前 N 条 + 注明总数；
 *   - 材料超过 MATERIAL_LIST_MAX 份折叠成**两级目录**摘要（目录 → 份数 · 总页数）；
 *   - 整段再受 BRIEF_MAX_CHARS 硬上限，超出截断并注明出路。
 */

/** 账本快照最多列出的条目数（wiki 优先，其次 raw） */
const LEDGER_MAX_ITEMS = 30;
/** 材料清单超过这个份数 → 折叠成两级目录摘要 */
const MATERIAL_LIST_MAX = 50;
/** 快照整段硬上限（字符），超出截断 */
const BRIEF_MAX_CHARS = 2400;
/** 紧凑模式整段上限（字符）：首轮全量快照之后每轮重注入用的紧凑版（约 300-450 token/轮） */
const BRIEF_COMPACT_MAX_CHARS = 800;
/** 紧凑模式账本最多列出的条目数（只留标题 + id，出处交给 read_ledger） */
const LEDGER_COMPACT_ITEMS = 6;
/** 紧凑模式材料清单最多列出的目录数 */
const MATERIAL_DIR_MAX = 8;

/** 索引质量 → 人话（与 tools/materials.ts 同口径） */
function qualityLabel(quality: string): string {
  return quality === 'vision' ? '视觉识别' : '文字层';
}

/** 账本块：条目 id + 标题 + 出处（wiki 优先，raw 补足到上限）。
 *  compact：只留「标题 + id」压成一行（出处/标签交给 read_ledger），条目数收窄到 LEDGER_COMPACT_ITEMS。 */
async function buildLedgerBlock(projectRoot: string, compact: boolean): Promise<string> {
  const { readLedgerIndex } = await import('@/lib/mcp/ledger');
  const index = readLedgerIndex(projectRoot);
  // 空态（无账本 / 尚无条目）不注入：没有"有哪些"可说时，别用空壳占上下文
  if (index.total.wiki === 0 && index.total.raw === 0 && index.projects.length === 0) return '';

  const picked = [...index.wiki, ...index.raw].slice(0, compact ? LEDGER_COMPACT_ITEMS : LEDGER_MAX_ITEMS);
  const pending = new Set(index.pending.map((p) => p.id));
  const lines = picked.map((it) => {
    if (compact) {
      const mark = pending.has(it.id) ? ' · 待编译' : '';
      return `- ${it.title} \`${it.id}\`${mark}`;
    }
    const tag = it.tags && it.tags.length > 0 ? `[${it.tags.join(' · ')}] ` : '';
    const src = it.source ? ` — 出处：${it.source}` : '';
    const mark = pending.has(it.id) ? ' · 待编译' : '';
    return `- ${tag}${it.title} \`${it.id}\`${src}${mark}`;
  });
  const total = index.total.wiki + index.total.raw;
  const more = total > picked.length ? `\n（仅列前 ${picked.length} 条，共 ${total} 条）` : '';
  // 项目页（p-…）：正在做的事一页一件，先摆出来；明细正文走 read_ledger id=p-… / ledger_project
  const projectMeta = index.projects.length === 0
    ? ''
    : compact
      ? `项目页 ${index.projects.length} 项：${index.projects.slice(0, 4).map((p) => `${p.title} \`${p.id}\``).join(' · ')}\n`
      : `项目页 ${index.projects.length} 项（一件要产出的事一页 · 阶段 idea→outline→draft→done）：\n`
        + `${index.projects.slice(0, 8).map((p) => `- [${p.stage ?? 'idea'}] ${p.title} \`${p.id}\``).join('\n')}\n`;
  return `### 账本 .ledger/（结论与出处在这里，先看它）\n`
    + `概览 ${index.total.wiki} 条 / 原始登记 ${index.total.raw} 条（待编译 ${index.pending.length} 条）\n`
    + projectMeta
    + `${lines.join('\n')}${more}`;
}

/** 材料块：份数少时逐份列出，份数多时折叠成两级目录摘要。
 *  compact：一律只给**一级目录**汇总（目录 · 份数 · 总页数），份数与长度都可控。 */
async function buildMaterialsBlock(projectRoot: string, compact: boolean): Promise<string> {
  const { listMaterialsInventory } = await import('@/lib/materials/indexer');
  const all = await listMaterialsInventory(projectRoot);
  if (all.length === 0) return '';

  if (compact) {
    const buckets = new Map<string, { count: number; pages: number }>();
    for (const it of all) {
      const segs = it.relPath.split('/');
      const dir = segs.length > 1 ? segs[0] : '.';
      const cur = buckets.get(dir) ?? { count: 0, pages: 0 };
      cur.count += 1;
      cur.pages += it.pageCount;
      buckets.set(dir, cur);
    }
    const entries = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    const shown = entries.slice(0, MATERIAL_DIR_MAX);
    const more = entries.length > shown.length ? `\n…（另有 ${entries.length - shown.length} 个目录）` : '';
    return `### 材料清单（已建索引 ${all.length} 份，按目录）\n`
      + `${shown.map(([dir, v]) => `- materials/${dir}/（${v.count} 份 · 总 ${v.pages} 页）`).join('\n')}${more}\n`
      + `（覆盖范围：仅 materials/；homework/ 等产出不在索引内）`;
  }

  const header = all.length <= MATERIAL_LIST_MAX
    ? `### 材料清单（已建索引 ${all.length} 份）`
    : `### 材料清单（已建索引 ${all.length} 份，按目录折叠）`;

  let body: string;
  if (all.length <= MATERIAL_LIST_MAX) {
    const groups = new Map<string, string[]>();
    for (const it of all) {
      const slash = it.relPath.lastIndexOf('/');
      const dir = slash > 0 ? it.relPath.slice(0, slash) : '.';
      const line = `- materials/${it.relPath}（${it.pageCount} 页 · ${qualityLabel(it.quality)}）`;
      const bucket = groups.get(dir);
      if (bucket) bucket.push(line);
      else groups.set(dir, [line]);
    }
    body = [...groups.entries()]
      .map(([dir, lines]) => (dir === '.' ? lines.join('\n') : `【materials/${dir}】\n${lines.join('\n')}`))
      .join('\n');
  } else {
    // 两级折叠：取 relPath 的前两级目录作为桶（不足两级时退化为其父目录）
    const buckets = new Map<string, { count: number; pages: number }>();
    for (const it of all) {
      const segs = it.relPath.split('/');
      const dir = segs.length >= 3 ? segs.slice(0, 2).join('/') : segs.length === 2 ? segs[0] : '.';
      const cur = buckets.get(dir) ?? { count: 0, pages: 0 };
      cur.count += 1;
      cur.pages += it.pageCount;
      buckets.set(dir, cur);
    }
    body = [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
      .map(([dir, v]) => `- materials/${dir}/（${v.count} 份 · 总 ${v.pages} 页）`)
      .join('\n');
  }
  // 覆盖范围必须写明：索引只到 materials/，homework/ 产出不在内 —— 免得"没列到"被读成"不存在"
  return `${header}\n${body}\n（覆盖范围：仅 materials/ 下已建索引的文件；homework/ 等产出不在索引内，用 list_directory / read_file 查看）`;
}

/**
 * 生成项目档案快照（账本块 + 材料块）。两者皆空 → 返回空串（调用方不注入）。
 * 只读 manifest / 账本索引，不触发抽取或 OCR，不调模型。
 *
 * compact（后续轮次重注入用）：账本只留「标题 + id」、材料只留一级目录汇总，
 * 整段压到 BRIEF_COMPACT_MAX_CHARS 内——前端每轮用本地消息重建 messages，
 * 服务端 prepend 的动态上下文不回传，所以快照必须每轮重注入才存活，成本靠紧凑版压住。
 */
export async function buildProjectArchiveBrief(
  projectRoot: string,
  opts?: { compact?: boolean },
): Promise<string> {
  const compact = opts?.compact === true;
  const [ledgerBlock, materialsBlock] = await Promise.all([
    buildLedgerBlock(projectRoot, compact).catch(() => ''),
    buildMaterialsBlock(projectRoot, compact).catch(() => ''),
  ]);
  const parts = [ledgerBlock, materialsBlock].filter(Boolean);
  if (parts.length === 0) return '';
  const header = compact
    ? '## 本项目档案快照（宿主预取；明细用 read_ledger / search_materials）'
    : '## 本项目档案快照（宿主已预取，不必再为"有哪些资料"调工具）';
  const max = compact ? BRIEF_COMPACT_MAX_CHARS : BRIEF_MAX_CHARS;
  const body = `${header}\n${parts.join('\n\n')}`;
  return body.length > max
    ? `${body.slice(0, max)}\n…（快照已截断，完整清单与命中请用 read_ledger / search_materials 查看）`
    : body;
}
