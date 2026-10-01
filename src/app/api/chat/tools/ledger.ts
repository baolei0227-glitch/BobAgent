/**
 * Agent 工具系统 — ledger 场景（项目账本 / 档案员 Archivist 维护的项目档案）
 *
 * 账本是**宿主原生文件层**（`<项目根>/.ledger/`，见 lib/mcp/ledger.ts），不起任何 MCP 实例。
 * 与 notebook 场景（个人知识库，Kar 专职）并列的第二本「库」：
 *   - 个人库：notes-bridge → bob-notes-mcp（全局单库，Kar 独有写权）
 *   - 项目账本：lib/mcp/ledger.ts（按项目隔离，档案员 Archivist 维护）
 *
 * 工具面分两层（软规定：入口给到 + 提示词引导，不做硬门禁）：
 *   - read_ledger：全体 agent 可见（账本场景随「存在激活项目」激活）——先读档案定位资料；
 *   - ledger_record / ledger_pending / ledger_lint / ledger_challenge / ledger_project / ledger_schema：
 *     仅 keeper（档案员，ledger-keeper 场景）——账本由档案员维护，其他 agent 只读
 *     （见 official-packages.ts 的 Archivist 包 fixedScenes）。
 *
 * 依赖方向单向：仅以 import type 依赖 index.ts 的类型（编译期擦除），不产生运行时循环依赖。
 */

import type { Tool } from './index';
import type { LedgerEntry, LedgerItem, LedgerSide, LedgerTypeDef, ProjectStage } from '@/lib/mcp/ledger';
import type { MaterialIndexHit } from '@/lib/materials/indexer';

const NO_PROJECT = '当前没有激活项目：项目账本仅在有项目的画布下可用。';

/** 当事人立场白名单（与 lib/mcp/ledger.ts 的 LedgerSide 一致）：写入前本地校验，非法值不猜、直接跳过 */
const LEDGER_SIDE_KEYS: readonly LedgerSide[] = ['ours', 'theirs', 'neutral'];

/** 条目单行渲染 */
function itemLine(item: LedgerItem): string {
  const tag = item.tags && item.tags.length > 0 ? `[${item.tags.join(' · ')}] ` : '';
  const src = item.source ? ` — 出处：${item.source}` : '';
  // 「需复核」必须在行内可见：所依据材料已变更的结论不能被当成现行事实引用
  const stale = item.stale === true ? ' · 需复核' : '';
  // 论断的验证状态（open 是待办信号）：索引里就能看出哪些命题还没结论
  const claim = item.type === 'claim' && item.claimStatus ? ` · ${item.claimStatus}` : '';
  const sum = item.summary ? `\n    ${item.summary}` : '';
  return `- ${tag}${item.title} \`${item.id}\`${claim}${stale}${src}${sum}`;
}

/** 批量形态的边界：一次最多返回多少条、每条首段最多多少字 */
const BATCH_MAX = 20;
const BATCH_HEAD_CHARS = 400;
/** 批量形态单次返回总长上限（建议值·待实测）：防一次读满上下文；超出即停止收录并提示分批 */
const BATCH_TOTAL_CHARS = 12000;
/** topics 关键词最多取几个（每个词各自展开成一批命中） */
const BATCH_MAX_TOPICS = 5;

/** 正文首段（到第一个空行为止，压平换行并受字符上限约束） */
function firstParagraph(body: string): string {
  const para = body.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  const flat = para.replace(/\s*\n\s*/g, ' ');
  return flat.length > BATCH_HEAD_CHARS ? `${flat.slice(0, BATCH_HEAD_CHARS)}…` : flat;
}

/** 批量形态的单条渲染：元信息 + 首段（全文仍走 id 单读，避免批量把上下文吃满） */
function batchLine(entry: LedgerEntry): string {
  const tag = entry.tags && entry.tags.length > 0 ? `[${entry.tags.join(' · ')}] ` : '';
  const src = entry.source ? ` — 出处：${entry.source}` : '';
  const kind = entry.kind === 'raw' ? '原始登记' : entry.kind === 'project' ? '项目页' : '概览';
  return `- ${tag}${entry.title} \`${entry.id}\`（${kind}）${src}\n    ${firstParagraph(entry.body)}`;
}

/** read_ledger 工具 — 项目账本的唯一只读入口
 *  （四态：省略=索引 / ids|topics=批量元信息+首段 / id=单条正文 / rules=true=账本规则）。
 *  用途：执行任务前先读档案定位"这个项目里有什么"，再按账本记录的路径取原文。 */
async function toolReadLedger(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const rules = args.rules === true || args.rules === 'true';
  const ids = Array.isArray(args.ids) ? args.ids.map((s) => String(s).trim()).filter(Boolean) : [];
  const topics = Array.isArray(args.topics) ? args.topics.map((s) => String(s).trim()).filter(Boolean) : [];

  try {
    const { currentProjectRoot, readLedgerRules, readLedgerEntry, readLedgerIndex } = await import('@/lib/mcp/ledger');
    const root = await currentProjectRoot();
    if (!root) return NO_PROJECT;

    if (rules) {
      const content = readLedgerRules(root);
      if (!content) return '账本规则为空（账本尚未初始化）。';
      return `项目账本规则（SCHEMA.md，管家每次编译/回看前都会遵守）：\n${content.length > 4000 ? `${content.slice(0, 4000)}\n…（截断）` : content}`;
    }

    if (ids.length > 0 || topics.length > 0) {
      // 批量形态：一次拿 N 条的元信息 + 首段，省掉"每条 wiki 发一次调用"的往返成本。
      const picked = new Map<string, LedgerEntry>();
      const missing: string[] = [];
      for (const want of ids.slice(0, BATCH_MAX)) {
        const entry = readLedgerEntry(root, want);
        if (entry) picked.set(entry.id, entry);
        else missing.push(want);
      }
      for (const topic of topics.slice(0, BATCH_MAX_TOPICS)) {
        for (const hit of readLedgerIndex(root, topic).hits) {
          if (picked.size >= BATCH_MAX) break;
          if (!picked.has(hit.id)) picked.set(hit.id, hit);
        }
      }
      const list = [...picked.values()];
      if (list.length === 0) {
        const ask = [...ids, ...topics].join(' / ');
        const { total } = readLedgerIndex(root);
        return `账本里没有命中「${ask}」的条目（共 ${total.wiki} 条概览 / ${total.raw} 条原始登记）。`
          + '可省略参数看完整索引；账本确实没有时改用 search_materials 检索材料正文。';
      }
      const overflow = ids.length + topics.length > BATCH_MAX;
      // 逐条累加长度：累计将超 BATCH_TOTAL_CHARS 即停止收录（至少收录第 1 条），剩余条数显式告知
      const lines: string[] = [];
      let used = 0;
      for (const entry of list) {
        const line = batchLine(entry);
        if (lines.length > 0 && used + line.length > BATCH_TOTAL_CHARS) break;
        lines.push(line);
        used += line.length + 1;
      }
      const omitted = list.length - lines.length;
      return `账本批量命中 ${list.length} 条（元信息 + 首段；要全文用 read_ledger id=… 单读）：\n${lines.join('\n')}`
        + (overflow ? `\n（一次最多 ${BATCH_MAX} 条，其余请分批再取）` : '')
        + (missing.length > 0 ? `\n未找到的 id：${missing.join('、')}（账本中不存在此 id，勿按记忆复述）` : '')
        + '\n\n原文按条目「出处」列的项目相对路径用 read_attachment 取，账本不复制原文。'
        + (omitted > 0 ? `\n（本次返回已达单次总长上限 [truncated]，剩余 ${omitted} 条请用 read_ledger ids=[…] 分批再取）` : '');
    }

    if (id) {
      const entry = readLedgerEntry(root, id);
      if (!entry) return `账本中没有 id 为 ${id} 的条目。先用 read_ledger 看索引。`;
      const tag = entry.tags && entry.tags.length > 0 ? `[${entry.tags.join(' · ')}] ` : '';
      const src = entry.source ? `\n出处：${entry.source}` : '';
      const kind = entry.kind === 'raw' ? '原始登记' : entry.kind === 'project' ? '项目页' : '概览条目';
      const claim = entry.type === 'claim' && entry.claimStatus ? `\n状态：${entry.claimStatus}` : '';
      const stale = entry.stale === true ? `\n⚠️ 需复核：${entry.staleReason ?? '所依据材料已变更'}（复核后更新本条即自动清除标记；复核前不得当作现行事实引用）` : '';
      return `- 📁 ${tag}${entry.title}（${kind} \`${entry.id}\`）${src}${claim}${stale}\n\n${entry.body}`;
    }

    const index = readLedgerIndex(root, query);
    if (index.total.wiki === 0 && index.total.raw === 0 && index.projects.length === 0) {
      return '项目账本尚无条目（材料录入时宿主会自动登记；管家可另补充结论与约定）。原文材料仍在 materials/ 下，可直接按文件名读取。';
    }

    if (query) {
      if (index.hits.length === 0) {
        return `账本里没有命中「${query}」的条目（共 ${index.total.wiki} 条概览 / ${index.total.raw} 条原始登记）。可省略 query 看完整索引。`;
      }
      return `账本命中「${query}」${index.hits.length} 条：\n${index.hits
        .map((h: LedgerEntry) => {
          const body = h.body.length > 600 ? `${h.body.slice(0, 600)}…` : h.body;
          return `${itemLine(h)}\n    ${body.replace(/\n/g, '\n    ')}`;
        })
        .join('\n\n')}`;
    }

    const head = `项目账本索引（项目页 ${index.projects.length} 项 / 概览 ${index.total.wiki} 条 / 原始登记 ${index.total.raw} 条，待编译 ${index.pending.length} 条）`;
    // 机械自检摘要（0 token，随索引刷新一并算出）：有账本问题时先让读取方看见——
    // 修它的是 AI（有账本工具），不能指望人记得手动跑 ledger_lint。空数组则不显示。
    const lintLine = index.lint.length > 0
      ? `\n⚠️ 自检 ${index.lint.length} 项待处理：${index.lint
        .slice(0, 3)
        .map((s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s))
        .join('；')}${index.lint.length > 3 ? ` 等 ${index.lint.length} 项` : ''}\n（机械检查结果，跑 ledger_lint 看全部并修正）`
      : '';
    const projectBlock = index.projects.length > 0
      ? index.projects.map((p: LedgerItem) => `- [${p.stage ?? 'idea'}] ${itemLine(p).replace(/^- /, '')}`).join('\n')
      : '（暂无：一件要产出的事开一页，用 ledger_project 建）';
    const wikiBlock = index.wiki.length > 0 ? index.wiki.map(itemLine).join('\n') : '（暂无）';
    const rawBlock = index.raw.length > 0
      ? index.raw.slice(0, 40).map((r: LedgerItem) => `${itemLine(r)}${index.pending.some((p) => p.id === r.id) ? ' · 待编译' : ''}`).join('\n')
      : '（暂无）';
    return `${head}${lintLine}\n\n【项目页 wiki/p-…（要产出的事）】\n${projectBlock}\n\n【概览条目 wiki/】\n${wikiBlock}\n\n【原始登记 raw/】${index.raw.length > 40 ? `（仅列最近 40 条，共 ${index.raw.length} 条）` : ''}\n${rawBlock}\n\n提示：要多条概览时用批量形态（read_ledger ids=["w-…","w-…"] 或 topics=["关键词1","关键词2"]），一次拿元信息 + 首段；要单条全文用 read_ledger id=…；需要原文时按条目记录的出处路径用 read_attachment 读取，账本不复制原文。`;
  } catch (e) {
    return `读取项目账本失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 解析 origin 参数：合法值透传，未传/非法 = undefined（不传 → 库层视为材料事实，存量行为不变） */
function parseOrigin(v: unknown): 'material' | 'user' | 'external' | undefined {
  return v === 'material' || v === 'user' || v === 'external' ? v : undefined;
}

/** ledger_record 工具（keeper）— 登记/更新一条账本概览条目（事实、结论、约定、材料综述）。 */
async function toolLedgerRecord(args: Record<string, unknown>): Promise<string> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content) return 'Error: content required（要登记的账本内容必填）';
  if (!title) return 'Error: title required（账本条目必须有标题，供索引显示）';
  try {
    const { currentProjectRoot, recordLedgerEntry } = await import('@/lib/mcp/ledger');
    const root = await currentProjectRoot();
    if (!root) return NO_PROJECT;
    const tags = Array.isArray(args.tags) ? args.tags.map((s) => String(s)).filter(Boolean) : undefined;
    const rawIds = Array.isArray(args.rawIds) ? args.rawIds.map((s) => String(s)).filter(Boolean) : undefined;
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const origin = parseOrigin(args.origin);
    const statedBy = typeof args.statedBy === 'string' ? args.statedBy.trim() : '';
    const statedAt = typeof args.statedAt === 'string' ? args.statedAt.trim() : '';
    const type = typeof args.type === 'string' ? args.type.trim() : '';
    // 研究取向字段（仅对 claim/evidence 生效，库层按类型校验并回 warning）
    const status = typeof args.status === 'string' ? args.status.trim() : '';
    const claimRef = typeof args.claim === 'string' ? args.claim.trim() : '';
    const points = typeof args.points === 'string' ? args.points.trim() : '';
    const r = recordLedgerEntry(root, {
      title,
      content,
      ...(id ? { id } : {}),
      ...(typeof args.source === 'string' && args.source.trim() ? { source: args.source.trim() } : {}),
      ...(tags ? { tags } : {}),
      ...(rawIds ? { rawIds } : {}),
      ...(origin ? { origin } : {}),
      ...(statedBy ? { statedBy } : {}),
      ...(statedAt ? { statedAt } : {}),
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
      ...(claimRef ? { claim: claimRef } : {}),
      ...(points ? { points } : {}),
    });
    return `✅ 已${r.created ? '登记' : '更新'}账本条目 \`${r.id}\`「${title}」，索引已刷新。`
      + (origin === 'user' ? '\n已登记为用户陈述（不可核，引用时标 [来源: 用户陈述 · 日期]）。' : '')
      + (r.warning ? `\n注意：${r.warning}` : '');
  } catch (e) {
    return `登记失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** ledger_pending 工具（keeper）— 列出待编译的原始登记（材料录入时宿主自动登记，编译器是管家自己）。 */
async function toolLedgerPending(): Promise<string> {
  try {
    const { currentProjectRoot, listLedgerPending } = await import('@/lib/mcp/ledger');
    const root = await currentProjectRoot();
    if (!root) return NO_PROJECT;
    const pending = listLedgerPending(root);
    if (pending.length === 0) return '没有待编译的原始登记（或账本尚未登记任何材料）。';
    return `待编译登记 ${pending.length} 条（读取正文用 read_ledger id=…；编译成概览条目后用 ledger_record 并带上 rawIds 标记出处）：\n${pending.map(itemLine).join('\n')}`;
  } catch (e) {
    return `读取待编译清单失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** ledger_lint 工具（keeper）— 机械自检（0 token）：缺出处 / 重复标题 / 断链 / 索引不一致 / 待编译积压。
 *  同一套检查在每次索引刷新时也会跑（结果摘要写在索引头），本工具用于看全部明细。 */
async function toolLedgerLint(): Promise<string> {
  try {
    const { currentProjectRoot, lintLedger } = await import('@/lib/mcp/ledger');
    const root = await currentProjectRoot();
    if (!root) return NO_PROJECT;
    const issues = lintLedger(root);
    if (issues.length === 0) return '账本自检通过：无断链、无重复标题、条目均有出处、索引与文件一致。';
    return `账本自检发现 ${issues.length} 个问题：\n${issues.map((s) => `· ${s}`).join('\n')}`;
  } catch (e) {
    return `账本自检失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 项目页阶段白名单（与 lib/mcp/ledger.ts 的 ProjectStage 一致；工具层显式校验，
 *  避免写错的 stage 被静默回退成 idea —— 阶段倒退会让创作闭环失真） */
const PROJECT_STAGE_VALUES = ['idea', 'outline', 'draft', 'done'] as const;

/** 解析 stage 参数：空 = 未传（undefined）；非法 = 返回错误文案 */
function parseStage(v: unknown): ProjectStage | undefined | string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return undefined;
  if (!PROJECT_STAGE_VALUES.includes(s as ProjectStage)) {
    return `Error: stage 只能是 ${PROJECT_STAGE_VALUES.join(' | ')}`;
  }
  return s as ProjectStage;
}

/**
 * ledger_project 工具（keeper）— 项目页（创作闭环）：一件要产出的事开一页。
 * 四态：list = 列项目页 / read = 读一页（含阶段）/ create = 新建（给五节骨架）/ update = 推进（改正文或阶段）。
 * 与 w- 概览条目的分工：w- 存**知识**，p- 记**要做的事**（引用哪些知识、还缺什么、怎么做、产出回编）。
 */
async function toolLedgerProject(args: Record<string, unknown>): Promise<string> {
  const action = typeof args.action === 'string' ? args.action.trim() : 'list';
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const tags = Array.isArray(args.tags) ? args.tags.map((s) => String(s)).filter(Boolean) : undefined;
  const stage = parseStage(args.stage);
  if (typeof stage === 'string') return stage;

  try {
    const mod = await import('@/lib/mcp/ledger');
    const root = await mod.currentProjectRoot();
    if (!root) return NO_PROJECT;

    if (action === 'list') {
      const pages = mod.listProjectPages(root);
      if (pages.length === 0) {
        return '账本里还没有项目页。一件要产出的事开一页：ledger_project action=create title=… goal=…（正文会给五节骨架）。';
      }
      return `项目页 ${pages.length} 项（阶段 idea → outline → draft → done）：\n${pages
        .map((p: LedgerItem) => `- [${p.stage ?? 'idea'}] ${p.title} \`${p.id}\`${p.summary ? `\n    ${p.summary}` : ''}`)
        .join('\n')}\n\n看一页全文：ledger_project action=read id=…`;
    }

    if (action === 'read') {
      if (!id) return 'Error: id required（read 要看哪一页：p-YYYYMMDD-NNN）';
      const page = mod.readProjectPage(root, id);
      if (!page) return `没有 id 为 ${id} 的项目页。用 ledger_project action=list 看清单。`;
      const tag = page.tags && page.tags.length > 0 ? `[${page.tags.join(' · ')}] ` : '';
      return `- 📁 ${tag}${page.title}（项目页 · 阶段 ${page.stage} \`${page.id}\`）\n\n${page.body}`;
    }

    if (action === 'create') {
      if (!title) return 'Error: title required（新建项目页要有标题：这件事要产出什么）';
      const r = mod.createProjectPage(root, {
        title,
        ...(goal ? { goal } : {}),
        ...(stage ? { stage } : {}),
        ...(content.trim() ? { content } : {}),
        ...(tags ? { tags } : {}),
      });
      if (!r) return '新建项目页失败（标题为空或账本不可写）。';
      return `✅ 已建项目页 \`${r.id}\`「${title}」（阶段 ${stage ?? 'idea'}）。正文五节骨架：目标 / 知识引用 / 知识缺口 / 工作流 / 产出与回编。`
        + `用 ledger_project action=update id=${r.id} content=… 填内容、stage=… 推进阶段；产出中的新结论用 ledger_record 回编成 w- 条目。`;
    }

    if (action === 'update') {
      if (!id) return 'Error: id required（update 要改哪一页）';
      const ok = mod.updateProjectPage(root, {
        id,
        ...(title ? { title } : {}),
        ...(stage ? { stage } : {}),
        ...(args.content !== undefined ? { content } : {}),
        ...(tags ? { tags } : {}),
      });
      if (!ok) return `没有 id 为 ${id} 的项目页（或不是 p- 开头的项目页 id）。用 ledger_project action=list 看清单。`;
      const page = mod.readProjectPage(root, id);
      return `✅ 已更新项目页 \`${id}\`（阶段 ${page?.stage ?? 'idea'}），索引已刷新。`;
    }

    return 'Error: action must be list | read | create | update';
  } catch (e) {
    return `项目页操作失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/* ------------------------- 观点体检（ledger_challenge） ------------------------- */

/** 单关键词最多取多少条材料命中（多关键词合并后再按「路径 + 页码」去重） */
const CHALLENGE_MATERIAL_MAX = 20;
/** 材料命中片段长度上限（与 search_materials 的 SNIPPET_MAX_CHARS 同口径，超限截断） */
const CHALLENGE_SNIPPET_MAX_CHARS = 200;

/** 检索词提取（确定性、无模型）：按空白与中英文标点切分，保留长度 ≥ 2 的片段，去重取前 6；全空则退回原串。 */
function extractClaimKeywords(claim: string): string[] {
  const parts = claim
    .split(/[\s\u3000,，.。;；:：!！?？、·…—\-–_/\\|"'“”‘’()（）[\]【】{}<>《》]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const uniq: string[] = [];
  for (const p of parts) {
    if (!uniq.includes(p)) uniq.push(p);
    if (uniq.length >= 6) break;
  }
  return uniq.length > 0 ? uniq : [claim.trim()];
}

/** 立场显示名：优先分区声明里的 label；声明里没写该侧时的中文兜底（默认 SCHEMA 只声明 ours/theirs） */
const SIDE_FALLBACK_LABEL: Record<LedgerSide, string> = { ours: '我方', theirs: '对方', neutral: '中立' };
function sideDisplay(parties: Array<{ key: LedgerSide; label: string }>, key: LedgerSide): string {
  return parties.find((p) => p.key === key)?.label || SIDE_FALLBACK_LABEL[key];
}

/** 材料命中单行渲染：与 search_materials 的命中行格式保持一致（来源串可直接照抄） */
function challengeMaterialLine(hit: MaterialIndexHit, qualityByPath: Map<string, string>): string {
  const projectPath = `materials/${hit.relPath}`;
  const quality = qualityByPath.get(hit.relPath);
  const mark = quality ? ` · ${quality === 'vision' ? '视觉识别' : '文字层'}` : '';
  // 视觉识别（OCR）页码可能出错：零成本加一句提醒，防错 OCR 被当事实（与 search_materials 同口径）
  const review = quality === 'vision' ? '（视觉识别，关键处建议视觉复核）' : '';
  const snippet = hit.snippet.length > CHALLENGE_SNIPPET_MAX_CHARS
    ? `${hit.snippet.slice(0, CHALLENGE_SNIPPET_MAX_CHARS)}…[truncated]`
    : hit.snippet;
  return `- [来源: 材料:${projectPath}#p${hit.page}] ${projectPath}（第 ${hit.page}/${hit.pageCount} 页${mark}）${review}\n  ${snippet}`;
}

/** 账本条目命中单行渲染 */
function challengeLedgerLine(item: LedgerItem): string {
  // 需复核的条目在其结论所依据的材料变更后就不再是现行事实：显式标注，避免被当作支撑/不利证据
  const stale = item.stale === true ? ' · ⚠️ 需复核（所依据材料已变更）' : '';
  return `- \`${item.id}\` ${item.title}${stale}${item.source ? ` — 出处：${item.source}` : ''}`;
}

/**
 * ledger_challenge 工具（观点体检）— 用户提出一个观点时做**双侧检索 + 对称性呈现**。
 * 宿主只做确定性的「分侧检索 + 覆盖缺口揭示」，**不判断哪条支撑、哪条反对**（语义判定留给模型）；
 * 但「另一侧搜没搜、命中多少」由本工具强制摆在模型面前，模型无法遗漏。
 * 返回按**立场**分组（ours/theirs/neutral + 账本条目），三节（支撑/不利/缺口）由调用方据此写出。
 */
async function toolLedgerChallenge(args: Record<string, unknown>): Promise<string> {
  const claim = typeof args.claim === 'string' ? args.claim.trim() : '';
  if (!claim) return 'Error: claim required（要体检的观点原文必填）';
  const note = typeof args.note === 'string' ? args.note.trim() : '';
  try {
    const { currentProjectRoot, readLedgerIndex, readLedgerParties, sideOfPath, appendEntryLog } =
      await import('@/lib/mcp/ledger');
    const root = await currentProjectRoot();
    if (!root) return NO_PROJECT;

    const keywords = extractClaimKeywords(claim);

    // 2) 账本侧：逐词检索，按条目 id 去重合并
    const ledgerHits = new Map<string, LedgerEntry>();
    for (const kw of keywords) {
      for (const hit of readLedgerIndex(root, kw).hits) {
        if (!ledgerHits.has(hit.id)) ledgerHits.set(hit.id, hit);
      }
    }
    const ledgerList = [...ledgerHits.values()];

    // 3) 材料侧：复用 search_materials 的同一个索引检索函数，按「路径 + 页码」去重合并
    const { searchMaterialsIndex, listMaterialsInventory } = await import('@/lib/materials/indexer');
    const materialHits = new Map<string, MaterialIndexHit>();
    for (const kw of keywords) {
      let hits: MaterialIndexHit[] = [];
      try {
        hits = await searchMaterialsIndex(root, kw, CHALLENGE_MATERIAL_MAX);
      } catch {
        hits = []; // 单个关键词检索失败不影响其余关键词
      }
      for (const h of hits) {
        const key = `${h.relPath}#p${h.page}`;
        if (!materialHits.has(key)) materialHits.set(key, h);
      }
    }
    const materialList = [...materialHits.values()];
    // 索引质量只在 manifest 里（命中结构不带），关联后用于标注「建议视觉复核」
    const qualityByPath = new Map<string, string>();
    try {
      for (const it of await listMaterialsInventory(root)) qualityByPath.set(it.relPath, it.quality);
    } catch {
      /* 质量关联失败不影响命中输出 */
    }

    // 4) 按立场分组：sideOfPath 用材料命中路径归侧；归不进任何声明目录 = 未归侧（不猜、不默认中立）
    const parties = readLedgerParties(root);
    const bySide: Record<LedgerSide, MaterialIndexHit[]> = { ours: [], theirs: [], neutral: [] };
    const unassigned: MaterialIndexHit[] = [];
    for (const h of materialList) {
      const side = sideOfPath(parties, `materials/${h.relPath}`);
      if (side) bySide[side].push(h);
      else unassigned.push(h);
    }

    const renderHits = (hits: MaterialIndexHit[]): string =>
      hits.length === 0 ? '- （无）' : hits.map((h) => challengeMaterialLine(h, qualityByPath)).join('\n');

    // 5) 返回格式：Markdown，每一节永远存在（无命中写「（无）」）
    const lines: string[] = [];
    lines.push(`## 观点体检：${claim}`);
    lines.push(`（检索词：${keywords.join('、')} ｜ 检索范围：账本 index.md + 材料索引 materials/**；homework/ 产出不在此列）`);
    lines.push('');

    if (parties.length === 0) {
      // 未声明分区：不分侧，全部命中单列，并在顶部明确写出补法
      lines.push('⚠️ 项目未声明「当事人与材料分区」，无法分侧对照：请在 .ledger/SCHEMA.md 补该段（格式：- ours | 我方 | materials/我方）');
      lines.push('');
      lines.push(`### 材料命中（未分侧，${materialList.length} 条）`);
      lines.push(renderHits(materialList));
    } else {
      lines.push(`### 自方材料命中（${sideDisplay(parties, 'ours')}，${bySide.ours.length} 条）`);
      lines.push(renderHits(bySide.ours));
      lines.push(`### 对方材料命中（${sideDisplay(parties, 'theirs')}，${bySide.theirs.length} 条）`);
      lines.push(renderHits(bySide.theirs));
      lines.push(`### 中立材料命中（${sideDisplay(parties, 'neutral')}，${bySide.neutral.length} 条）`);
      lines.push(renderHits(bySide.neutral));
      lines.push(`### 未归侧材料命中（未声明归侧，${unassigned.length} 条）`);
      lines.push(renderHits(unassigned));
    }

    lines.push(`### 账本条目命中（${ledgerList.length} 条）`);
    lines.push(ledgerList.length === 0 ? '- （无）' : ledgerList.map(challengeLedgerLine).join('\n'));
    lines.push('');

    lines.push('### 覆盖缺口与检索边界（必须原样输出，不得省略）');
    const oursN = parties.length === 0 ? materialList.length : bySide.ours.length;
    const theirsN = parties.length === 0 ? 0 : bySide.theirs.length;
    const neutralN = parties.length === 0 ? 0 : bySide.neutral.length;
    if (parties.length === 0) {
      lines.push(`- 立场覆盖：未声明分区，材料命中未分侧（${materialList.length} 条）`);
      lines.push('⚠ 未声明分区 → 无法判断对方一侧是否已覆盖：不得据此认定该观点有事实支撑，请先在 .ledger/SCHEMA.md 声明「当事人与材料分区」。');
    } else {
      lines.push(`- 立场覆盖：${sideDisplay(parties, 'ours')}=${oursN} / ${sideDisplay(parties, 'theirs')}=${theirsN} / ${sideDisplay(parties, 'neutral')}=${neutralN}`);
      if (oursN > 0 && theirsN === 0) {
        lines.push('⚠ 未检索到对方材料命中（不等于不存在）：请在结论里写「未检索到不利事实（不等于不存在）」，不得据此认定该观点有事实支撑。');
      }
      if (oursN === 0 && theirsN === 0 && neutralN > 0) {
        lines.push('⚠ 未检索到任何一方材料命中（仅中立材料）：无法形成双方对照，不得据此认定任何一方的主张有事实支撑。');
      }
    }
    if (materialList.length === 0) {
      // 材料是唯一可核的事实来源：材料零命中时，账本条目再多也不能当作事实依据（补充条款 10）。
      lines.push(ledgerList.length === 0
        ? '⚠ 账本与材料中均未检索到相关事实：该观点目前无项目事实支撑，不得据此下结论。'
        : `⚠ 两侧材料均未检索到命中：账本有 ${ledgerList.length} 条条目命中，但账本条目是索引与分析、不是可核事实，不能单独作为事实支撑。`);
    }
    lines.push('口径提醒：账本检索是关键词 + 索引（无向量），本次只覆盖上述检索词与范围，禁止宣称"已核对全部材料"。');
    if (ledgerList.some((e) => e.origin === 'user')) {
      lines.push('注：其中包含用户陈述条目（不可核），引用时须标 [来源: 用户陈述 · 日期]。');
    }
    const staleN = ledgerList.filter((e) => e.stale === true).length;
    if (staleN > 0) {
      lines.push(`⚠ 账本命中中有 ${staleN} 条标记「需复核」（所依据材料已变更）：复核前不得作为现行事实或支撑/不利依据引用。`);
    }
    const out = lines.join('\n');

    // 6) 留痕：追加一条 [challenge] 记录；失败不影响返回
    try {
      appendEntryLog(root, [
        `[challenge] claim="${claim.slice(0, 80)}"${note ? ` | note="${note.slice(0, 80)}"` : ''} | 检索词 ${keywords.join(',')} | ours=${oursN} theirs=${theirsN} neutral=${neutralN} ledger=${ledgerList.length}`,
      ]);
    } catch (e) {
      console.warn('[ledger:challenge] 留痕失败:', e instanceof Error ? e.message : String(e));
    }

    return out;
  } catch (e) {
    return `观点体检失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * ledger_schema 工具（keeper）— 读 / 改账本规则文件（SCHEMA.md）。
 *
 * 改宪章是重动作（规则本身约束档案员自己）：只写用户明确要求的内容，
 * 且必须把结果（含 warnings）如实转述给用户，不能默默改掉口径。
 */
async function toolLedgerSchema(args: Record<string, unknown>): Promise<string> {
  const action = typeof args.action === 'string' ? args.action.trim() : 'read';
  try {
    const mod = await import('@/lib/mcp/ledger');
    const root = await mod.currentProjectRoot();
    if (!root) return NO_PROJECT;

    if (action === 'read') {
      const content = mod.readLedgerRules(root);
      if (!content) return '账本规则为空（账本尚未初始化）。';
      return `账本规则文件（SCHEMA.md）：\n${content.length > 6000 ? `${content.slice(0, 6000)}\n…（截断）` : content}`;
    }

    if (action === 'set_parties') {
      const raw = Array.isArray(args.parties) ? args.parties : [];
      const parties: Array<{ key: LedgerSide; label: string; dirs: string[] }> = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const key = String(o.side ?? '').trim() as LedgerSide;
        if (!LEDGER_SIDE_KEYS.includes(key)) continue; // 非法 side 直接跳过（不猜）
        parties.push({
          key,
          label: String(o.label ?? '').trim(),
          dirs: (Array.isArray(o.dirs) ? o.dirs : []).map((d) => String(d)),
        });
      }
      if (raw.length > 0 && parties.length === 0) {
        return 'set_parties 未写入：parties 里没有合法条目（side 只能是 ours / theirs / neutral）。';
      }
      const res = mod.writeLedgerParties(root, parties);
      if (!res.ok) return `set_parties 失败：${res.error}`;
      const now = mod.readLedgerParties(root);
      const lines = now.length > 0
        ? now.map((p) => `- ${p.key} | ${p.label} | ${p.dirs.join(', ') || '（未声明目录）'}`)
        : ['（已清空声明：本项目不做分侧检查）'];
      return [`已写入「当事人与材料分区」段（${res.path}）：`, ...lines, ...res.warnings.map((w) => `⚠ ${w}`)].join('\n');
    }

    if (action === 'add_types') {
      const raw = Array.isArray(args.types) ? args.types : [];
      const defs: LedgerTypeDef[] = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        defs.push({
          key: String(o.key ?? '').trim(),
          label: String(o.label ?? '').trim(),
          ...(o.skeleton ? { skeleton: String(o.skeleton) } : {}),
        });
      }
      if (defs.length === 0) return 'add_types 未写入：types 为空。';
      const res = mod.addLedgerTypes(root, defs);
      if (!res.ok) return `add_types 失败：${res.error}`;
      const declared = mod.readLedgerTypes(root).map((t) => t.key).join(', ');
      return [`已按需追加条目类型（${res.path}）。当前声明：${declared}`, ...res.warnings.map((w) => `⚠ ${w}`)].join('\n');
    }

    if (action === 'append') {
      const clause = typeof args.clause === 'string' ? args.clause : '';
      const res = mod.appendLedgerClause(root, clause);
      if (!res.ok) return `append 失败：${res.error}`;
      return `已追加补充条款到「补充条款」段（${res.path}）。既有段落未改动。`;
    }

    return `未知 action：${action}（可用 read / set_parties / add_types / append）。`;
  } catch (e) {
    return `账本规则写入失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * ledger 场景工具定义。
 * 场景标注在 registry.ts 的 SCENED_TOOLS（静态表，同时决定工具分层 ondemand）。
 */
export const ledgerToolDefs: Tool[] = [
  {
    name: 'read_ledger',
    description: 'STEP 1 of 3 (ledger → materials index → original). Read the PROJECT LEDGER for the current project — the keeper-maintained archive of what this project contains (materials registered on entry, outputs, conventions, project-relative paths of originals). Call it BEFORE exploring project files when a task needs project materials. Fixed order: (1) read_ledger = router (conclusions + project-relative paths), (2) search_materials = locator (page numbers + snippets), (3) read_attachment = fetch the original. SHORTCUT: when an entry here already names an exact path, skip step 2 and read_attachment that path directly. Forms: no args = index (entries grouped by wiki/raw, use it to locate); ids=[…] or topics=[…] = BATCH metadata + first paragraph (preferred over one call per entry); id = one entry in full (w-… knowledge, r-… raw registration, p-… project page); query = keyword search; rules=true = the ledger rules (SCHEMA.md). Entries marked 需复核 rest on source material that has since changed — never cite them as current fact. Original files always stay in materials/ — read them by the paths recorded here; a path that does not exist is a hard error, never retell it from memory.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Entry id from the index (w-… wiki entry / r-… raw registration / p-… project page) — returns that entry in full.',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'BATCH: several entry ids at once (w-…/r-…/p-…), returned as metadata + first paragraph each. Use this instead of calling read_ledger once per entry.',
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'BATCH: several keywords, each expanded to its ledger matches (metadata + first paragraph, deduped, capped). Good for "what does the ledger say about X and Y" in one round trip.',
        },
        query: {
          type: 'string',
          description: 'Optional keyword to search the ledger (title/summary/source/tags, wiki also body); omit to browse the whole index.',
        },
        rules: {
          type: 'boolean',
          description: 'true = read the ledger rules (SCHEMA.md) instead of entries.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadLedger,
    maxOutput: 6000,
  },
  {
    name: 'ledger_record',
    description: 'KEEPER ONLY (project ledger). Write or update a ledger entry (a conclusion, a materials survey, a naming/usage convention, a task outcome summary). ALWAYS cite project-relative paths (materials/…, homework/…) in the content or the source field; when the entry compiles earlier raw registrations, list their ids in rawIds so they stop counting as pending. Pass id to update an existing entry instead of creating a new one; updating an entry also clears its needs-review flag. Tag the entry with type so the ledger can be browsed by kind. Record both sides of a dispute and never adjudicate — the model compares, the human decides. Research-oriented entries carry extra fields: a claim takes status (open|supported|refuted|unclear), and an evidence card takes claim (the w-… id it bears on) plus points (supports|refutes). Not for personal notes (use create_note) and not for one-off chat.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Entry title shown in the ledger index (keep it short and specific).',
        },
        content: {
          type: 'string',
          description: 'Entry body in markdown: the conclusion/facts plus the project-relative paths they rest on. The first line becomes the index summary.',
        },
        id: {
          type: 'string',
          description: 'Existing wiki entry id (w-…) to update in place; omit to create a new entry.',
        },
        source: {
          type: 'string',
          description: 'Primary project-relative path this entry relies on (e.g. materials/原告/原告证据.pdf).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for grouping in the index (e.g. 材料, 时间线, 约定).',
        },
        rawIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Raw registration ids (r-…) this entry compiles; they then stop showing as pending.',
        },
        origin: {
          type: 'string',
          enum: ['material', 'user', 'external'],
          description: 'Where these facts come from (the three legal sources, never mixed). Omit = material (original text under materials/, verifiable, cite the path). Use "user" for NEW facts the user states verbally that the ledger does not already contain — NOT verifiable but a valid party statement; also pass statedBy/statedAt, and never dress it as a materials/ path. Use "external" for information retrieved outside the project (must carry a URL in the content). Model knowledge/opinions are never a fact source.',
        },
        statedBy: {
          type: 'string',
          description: 'Only meaningful with origin="user": who stated it.',
        },
        statedAt: {
          type: 'string',
          description: 'Only meaningful with origin="user": when it was stated (YYYY-MM-DD).',
        },
        type: {
          type: 'string',
          description: 'Optional entry type key declared in .ledger/SCHEMA.md (条目类型 section; built-ins: fact, entity, issue, comparison, analysis, note, plus research-oriented concept, claim, evidence, timeline, method). Pick fact only when the body rests on materials/ original text; pick comparison only when the body sets the two sides (ours/theirs) against each other — a one-sided statement is not a comparison; claim and analysis are not facts and must never be cited as fact by another entry; evidence must carry a stance and point at a claim; method should record the search/filter criteria so the conclusion is reproducible. An undeclared key is written as unclassified and returned as a warning.',
        },
        status: {
          type: 'string',
          enum: ['open', 'supported', 'refuted', 'unclear'],
          description: 'Only for type="claim": how far the hypothesis has been verified — open (awaiting evidence, the default), supported, refuted, or unclear. Shown on the index line; a claim left open for ~30 days is reported by ledger_lint. Ignored (with a warning) for other types.',
        },
        claim: {
          type: 'string',
          description: 'Only for type="evidence": the id (w-…) of the claim this evidence card bears on. An evidence card without a valid claim target (missing, nonexistent, or pointing at a non-claim entry) is reported by ledger_lint as an orphan. Ignored (with a warning) for other types.',
        },
        points: {
          type: 'string',
          enum: ['supports', 'refutes'],
          description: 'Only for type="evidence": the direction — supports or refutes the claim it points at. Required on evidence cards: a claim with evidence on only one side is reported by ledger_lint. Ignored (with a warning) for other types.',
        },
      },
      required: ['title', 'content'],
    },
    category: '文件',
    execute: toolLedgerRecord,
    maxOutput: 3000,
  },
  {
    name: 'ledger_pending',
    description: 'KEEPER ONLY (project ledger). List raw registrations not yet compiled into the ledger wiki (materials are registered automatically when they enter the project). Read their bodies with read_ledger id=…, write the conclusion with ledger_record (listing rawIds), so the ledger stays useful for every agent.',
    parameters: { type: 'object', properties: {}, required: [] },
    category: '文件',
    execute: toolLedgerPending,
    maxOutput: 3000,
  },
  {
    name: 'ledger_lint',
    description: 'KEEPER ONLY (project ledger). Mechanical self-check of the ledger (zero tokens, deterministic): entries missing a source path, duplicate titles, broken raw links, project pages referencing a missing w- entry or materials/ path, index out of sync with the files, backlog of uncompiled registrations, one-sided entries, fact/comparison type violations, adjudicating wording (the model compares, it never decides), entries needing review because their source material changed, and research-oriented issues (orphan evidence cards, a claim with evidence on only one side, a claim left open for ~30 days). Run it periodically and fix what it reports.',
    parameters: { type: 'object', properties: {}, required: [] },
    category: '文件',
    execute: toolLedgerLint,
    maxOutput: 3000,
  },
  {
    name: 'ledger_project',
    description: 'KEEPER ONLY (project ledger). Work with PROJECT PAGES (p-… in .ledger/wiki/) — the creation loop: one page per thing to produce, next to the knowledge entries (w-…). A project page body has five sections: 目标 (goal) / 知识引用 (knowledge cited: w-… ids or materials/… paths) / 知识缺口 (what the library still lacks) / 工作流 (how it gets done) / 产出与回编 (where the output lands, and new conclusions recorded back with ledger_record). Actions: list = all pages with their stage; read = one page in full; create = new page (title + optional goal) with the five-section skeleton; update = fill body or advance stage. Stage flows idea → outline → draft → done. Use read_ledger for knowledge (w-…/r-…) and this tool for the work to be produced.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'create', 'update'],
          description: 'list = project pages with stage; read = one page in full; create = new page with skeleton; update = edit body/title/tags or advance stage.',
        },
        id: {
          type: 'string',
          description: 'Project page id (p-YYYYMMDD-NNN): required for read and update.',
        },
        title: {
          type: 'string',
          description: 'create: what this thing to produce is (short, specific). update: new title.',
        },
        goal: {
          type: 'string',
          description: 'create only: what this page must produce and how it is accepted; goes into the 目标 section and the index summary.',
        },
        stage: {
          type: 'string',
          enum: ['idea', 'outline', 'draft', 'done'],
          description: 'Creation stage; defaults to idea on create. Advance it as the work moves on.',
        },
        content: {
          type: 'string',
          description: 'update: full replacement body in markdown (keep the five sections, cite w-… ids and materials/… paths accurately). create: body to use instead of the skeleton.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for grouping.',
        },
      },
      required: ['action'],
    },
    category: '文件',
    execute: toolLedgerProject,
    maxOutput: 6000,
  },
  {
    name: 'ledger_schema',
    description: 'KEEPER ONLY (project ledger). Read or edit the ledger RULES file (.ledger/SCHEMA.md) — the charter you obey on every compile and review. It carries two machine-parsed tables plus free clauses. Actions: read = the whole file; set_parties = rewrite the 当事人与材料分区 table (the very table ledger_lint and ledger_challenge use to tell our side from theirs) — pass the COMPLETE table as parties=[{side:"ours"|"theirs"|"neutral", label, dirs:["materials/我方"]}], where dirs are project-relative path prefixes; an empty array clears the declaration and disables the two-sided check; the section\'s explanatory prose is preserved either way. add_types = declare extra entry-type keys (append-only: existing rows are never touched, so removing a type stays a manual edit). append = append a free-form clause to the 补充条款 section (append-only, nothing else is rewritten). WHEN TO WRITE: only when the user explicitly asks for the change or confirms your proposal — never rewrite the charter on your own initiative; it is the rule that binds you. After any write, relay exactly what changed (including the ⚠ lines) to the user.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'set_parties', 'add_types', 'append'],
          description: 'read = whole SCHEMA.md; set_parties = rewrite the party/material partition table; add_types = declare additional entry types; append = append a clause.',
        },
        parties: {
          type: 'array',
          description: 'set_parties: the COMPLETE declaration table (it replaces the previous one). Omit or pass [] to clear the declaration.',
          items: {
            type: 'object',
            properties: {
              side: {
                type: 'string',
                enum: ['ours', 'theirs', 'neutral'],
                description: 'Which party this bucket of materials belongs to (neutral = neither, e.g. court documents).',
              },
              label: {
                type: 'string',
                description: 'Human-readable name (e.g. 我方 / 被告 / 法院).',
              },
              dirs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Project-relative path prefixes (e.g. materials/我方). Materials under them are auto-classified into this side. No absolute paths, no "..".',
              },
            },
            required: ['side'],
          },
        },
        types: {
          type: 'array',
          description: 'add_types: additional entry types to declare; keys already declared are skipped and reported back.',
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Type key stored in front-matter (letters/digits/_/-, must start with a letter).',
              },
              label: {
                type: 'string',
                description: 'Short explanation shown in the entry-type list.',
              },
              skeleton: {
                type: 'string',
                description: 'Optional body skeleton for entries of this type.',
              },
            },
            required: ['key'],
          },
        },
        clause: {
          type: 'string',
          description: 'append: the clause text (markdown) appended to the 补充条款 section.',
        },
      },
      required: ['action'],
    },
    category: '文件',
    execute: toolLedgerSchema,
    maxOutput: 6000,
  },
  {
    name: 'ledger_challenge',
    description: 'CLAIM CHECK (观点体检). Call whenever the user asserts a CLAIM / position / judgment about the project (e.g. "the contract was signed late", "we have the delivery proof", "the other side never replied") — WHY: litigation has two sides; never answer a claim with one-sided evidence. It runs a deterministic TWO-SIDED keyword search (ledger index + materials index) and returns hits grouped BY SIDE (ours / theirs / neutral) plus ledger entries: it does NOT decide what supports or contradicts the claim — that semantic judgment is YOURS. MANDATORY: write ALL THREE sections into your answer — (1) supporting facts, (2) adverse facts, (3) coverage gaps — each section must appear even when empty ("无"). When adverse facts are zero you MUST NOT say the claim "has factual support"; write only "未检索到不利事实（不等于不存在）". The search is keyword + index based (NO vector search): never claim "all materials were checked", and treat "no hits" as "not found", NEVER as "does not exist". Material hit lines already carry a ready-to-copy [来源: 材料:…] tag — reuse it verbatim (do not assemble your own path or page). If the project has not declared its party/material sides, the result says so and lists hits unsided — relay that limitation instead of inventing sides.',
    parameters: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description: 'The user\'s claim/position verbatim (or a faithful condensation) — the statement to put through the two-sided check.',
        },
        note: {
          type: 'string',
          description: 'Optional free-form context recorded in the ledger audit log (e.g. where the claim came from); does not affect retrieval.',
        },
      },
      required: ['claim'],
    },
    category: '文件',
    execute: toolLedgerChallenge,
    maxOutput: 8000,
  },
];