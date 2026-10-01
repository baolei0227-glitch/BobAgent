/**
 * 项目账本（Project Ledger）宿主原生文件层（server-only）
 *
 * 每个项目一本由「档案员（Archivist）」维护的档案：录入了哪些材料、产出过什么、有哪些约定。
 * AI 执行任务需要项目资料时**先读账本**（索引 → 条目正文 → 按条目记录的相对路径取原文），
 * 而不是从零 list_directory 重新发现项目里有什么。
 *
 * 实现取向（定案）：
 *   1) 宿主原生：账本 = `<项目根>/.ledger/` 下一小套 markdown，宿主代码直接读写，**不起任何 MCP 实例**；
 *      设计上参考 bob-notes（三层结构 / index 优先 / SCHEMA 规则 / log），但库本身不放在 bob-notes 里。
 *   2) 两个库：全局个人库归 Kar（lib/mcp/notes-bridge.ts，原样不动）／项目账本归 Butler（本模块）；
 *   3) 软规定起步：只提供"先读档案"的入口与提示，不做硬门禁（不阻断 agent 直接读 materials/）。
 *
 * 目录（随项目走，复制/归档/删除项目时账本自然跟随，不留孤儿库）：
 *   <项目根>/.ledger/
 *   ├── SCHEMA.md   账本规则（宿主种子，人可编辑；档案员每次编译/回看前遵守）
 *   ├── index.md    导航索引（**宿主维护**：扫 raw/ wiki/ 的 front-matter 生成，请勿手改）
 *   ├── log.md      操作日志（宿主追加）
 *   ├── raw/        原始登记（宿主写：材料录入即登记 1 条；档案员只读，永不修改）
 *   ── wiki/       概览条目 w-…（归并、去重、串脉络；编译由宿主在材料到达后自动起后台会话完成，不在对话里做）
 *                   + 项目页 p-…（创作闭环：目标 / 知识引用 / 知识缺口 / 工作流 / 产出与回编，见补充条款 7）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import matter from 'gray-matter';
import { CERTAINTY_RE } from '@/lib/nodes/outcome';

/** 账本目录名（项目根下，点目录 → 不进文件树、不参与默认清单展示） */
export const LEDGER_DIRNAME = '.ledger';

/** 账本根：<项目根>/.ledger */
export function ledgerHome(projectRoot: string): string {
  return join(projectRoot, LEDGER_DIRNAME);
}

/** 账本文件布局（每次现算，避免缓存到旧项目根） */
function layout(projectRoot: string) {
  const home = ledgerHome(projectRoot);
  return {
    home,
    wikiDir: join(home, 'wiki'),
    rawDir: join(home, 'raw'),
    schemaPath: join(home, 'SCHEMA.md'),
    indexPath: join(home, 'index.md'),
    logPath: join(home, 'log.md'),
    /** 锁定台账（P0-a 外部锚点）：每行一条锁定/解锁记录，append-only */
    lockTapePath: join(home, 'locks.md'),
  };
}

/** SCHEMA.md「当事人与材料分区」段标题（解析与迁移的锚点；允许标题后带括号补充说明） */
const LEDGER_PARTIES_SECTION_TITLE = '## 当事人与材料分区';

/** SCHEMA.md「当事人与材料分区」段（行式，与 bob-notes「页面类型」段同风格）：
 *   - key | 说明 | 材料目录（可多条，逗号分隔）
 *  这段既是新库种子的一部分，也是存量库的幂等迁移内容。
 *  key 只能是 ours/theirs/neutral（见 LedgerSide）；目录按项目相对路径前缀归侧。 */
const LEDGER_PARTIES_SECTION = `## 当事人与材料分区（每行一条：\`- key | 说明 | 材料目录；目录可多条用逗号分隔\`；改这里即可声明或调整）
\`key\` 用 ours（我方）/ theirs（对方）/ neutral（中立，如法院文书）；目录是**项目相对路径前缀**，
落在该前缀下的材料自动归到这一侧，据此检查条目是否只有单侧依据（缺对照）。
# 下面是示例：按本项目实际材料目录改好后，删掉行首的 \`#\` 即生效（未声明的项目不做分侧检查）
# - ours | 我方 | materials/我方
# - theirs | 对方 | materials/对方
`;

/** SCHEMA.md「条目类型」段标题（解析与迁移的锚点；允许标题后带括号补充说明） */
const LEDGER_TYPES_SECTION_TITLE = '## 条目类型';

/** SCHEMA.md「补充条款」段标题：规则的自由文本区（档案员按用户要求追加，宿主不解析）。 */
const LEDGER_CLAUSE_SECTION_TITLE = '## 补充条款';

/** 研究取向的补充类型（考证/论证类课题按需使用，普通项目不用即可）。
 *  宿主引入的**声明式**类型：新库写进种子段；存量库由 ensureLedger 按行补齐——
 *  因为 ledger_record 只认盘上「条目类型」段里声明过的 key（未声明会忽略并回 warning），
 *  所以这些类型必须真的出现在 SCHEMA.md 里才可用，而不是靠代码兜底。 */
const LEDGER_RESEARCH_TYPES: LedgerTypeDef[] = [
  { key: 'concept', label: '概念与口径（统一术语，避免同名异义）' },
  { key: 'claim', label: '论断与假设（待验证命题，不是事实，不得被引用为事实依据）' },
  { key: 'evidence', label: '证据卡（指向某条 claim，必须标立场与出处）' },
  { key: 'timeline', label: '时间线（事件按时间串，每条带 materials/ 出处）' },
  { key: 'method', label: '方法与口径（检索式/筛选标准/编码规则，保证可复现）' },
];

/** SCHEMA.md「条目类型」段（行式，与「当事人与材料分区」段同风格）：
 *   - key | 说明 | 正文骨架（可选，用字面 \n 表示换行）
 *  条目类型是"知识分层"的抓手：材料事实 vs 分析推断 vs 双方对照 vs 争议焦点，权威性完全不同。
 *  这段既是新库种子的一部分，也是存量库的幂等迁移内容。 */
const LEDGER_TYPES_SECTION = `## 条目类型（每行一条：\`- key | 说明 | 正文骨架(可选，用 \\n 表示换行)\`；改这里即可增删类型）
- fact | 材料事实综述（必须有 materials/ 出处，只说材料写了什么）
- entity | 实体页（主体/机构/人物，跨材料串同一对象）
- issue | 争议焦点（双方的争点，含无争议事实与有争议事实）
- comparison | 双方对照（同一焦点的双方主张与依据并列）
- analysis | 分析推断（不是事实，不得被引用为事实）
- note | 约定与备忘
# 研究取向的补充类型（考证/论证类课题按需使用；普通项目不用即可）
${LEDGER_RESEARCH_TYPES.map((t) => `- ${t.key} | ${t.label}`).join('\n')}
`;

/** 账本 SCHEMA.md 种子（首次创建时写入；此后由人编辑，已存在不覆盖）。
 *  「先读档案」的机制原文写在这里，档案员每次编译/回看前都会读取并遵守。 */
const LEDGER_SCHEMA_SEED = `# 项目账本 Schema

这是一个**项目账本**（不是个人知识库）：由**档案员（Archivist）**节点维护，记录本项目从创建到现在
发生过什么、有哪些材料与产出、遵循什么约定。其他 agent 执行任务前先读它定位资料，
避免从零重新翻找项目目录。

## 目录结构
- \`raw/\` —— 原始登记（材料录入即登记，宿主确定性写入）：AI 只读，永不修改。
- \`wiki/\` —— 账本条目（档案员维护：归并、去重、串出脉络）。id 前缀区分两类：
  \`w-\` = 概览条目（知识），\`p-\` = 项目页（要产出的事，见补充条款 7）。
- \`index.md\` —— 导航索引：由宿主扫描 front-matter 生成，请勿手改。
- \`log.md\` —— 操作日志（宿主追加）。

## 规则
1. **查询**：先读 \`index.md\` 定位，再按 id 读 \`wiki/\` 条目正文；不依赖向量检索。
2. **出处必填**：每条 wiki 必须写出**项目相对路径**（\`materials/…\`、\`homework/…\`）作为原文出处；
   账本只做索引与结论，原始材料始终留在原处（需要原文时按该路径取）。
3. **素材只读**：\`raw/\` 由宿主投放，AI 只读，永不修改。
4. **记录最轻**：登记发生在材料录入的时刻（宿主自动，0 token）；编译（raw → wiki）由宿主在材料到达后
   **自动起后台会话**完成（攒批、分批、用户零等待）——不做事后全项目扫描，也不占用对话轮次与任务时延。
5. **编译可追溯**：wiki 条目用 front-matter 的 \`raw:\` 列出所依据的 raw id（编译后这些 raw 不再计入「待编译」）。
6. **随材料同步（宿主自动，不用管）**：材料删除 → 其 raw 登记被回收（引用过它的 wiki 条目**保留**，
   \`raw:\` 变成断链即为「需复核」信号，由 \`ledger_lint\` 报出）；材料改名/移动 → 账本里记录的出处路径自动改写；
   同路径替换了材料内容 → 该条 raw 的页数/索引质量自动刷新（条目 id 不变）。

${LEDGER_PARTIES_SECTION}
${LEDGER_TYPES_SECTION}`;

/* ------------------------------- 数据形状 ------------------------------- */

/** 项目页的创作阶段（idea → outline → draft → done），记在 front-matter 的 stage */
export type ProjectStage = 'idea' | 'outline' | 'draft' | 'done';
const PROJECT_STAGES: ProjectStage[] = ['idea', 'outline', 'draft', 'done'];

function asStage(v: unknown): ProjectStage {
  return PROJECT_STAGES.includes(v as ProjectStage) ? (v as ProjectStage) : 'idea';
}

/** 立场：诉讼材料天然分侧。ours=我方 / theirs=对方 / neutral=中立（不可归入任何一方，如法院文书） */
export type LedgerSide = 'ours' | 'theirs' | 'neutral';
/** 事实来源：material=材料原文（可核）/ user=用户陈述（不可核但是有效当事人陈述）/ external=项目外检索信息（带 URL） */
export type FactOrigin = 'material' | 'user' | 'external';

/** 立场白名单（解析 front-matter 时校验，读不出就当没有） */
const LEDGER_SIDES: LedgerSide[] = ['ours', 'theirs', 'neutral'];
/** 事实来源白名单（同上） */
const FACT_ORIGINS: FactOrigin[] = ['material', 'user', 'external'];

function asSide(v: unknown): LedgerSide | undefined {
  return LEDGER_SIDES.includes(v as LedgerSide) ? (v as LedgerSide) : undefined;
}

function asOrigin(v: unknown): FactOrigin | undefined {
  return FACT_ORIGINS.includes(v as FactOrigin) ? (v as FactOrigin) : undefined;
}

/* 研究取向的两个正交维度（都与当事人立场 side 无关，不要混用）：
 *   - claim.status    论断的验证状态：open 待验证 / supported 已有支撑 / refuted 已被反驳 / unclear 尚不明确
 *   - evidence.points 证据方向：supports 支撑 / refutes 反驳（配合 evidence.claim 指向的论断 id）
 *  普通案件项目不用这两个字段即可，行为与存量完全一致。 */
export type ClaimStatus = 'open' | 'supported' | 'refuted' | 'unclear';
export type EvidencePoints = 'supports' | 'refutes';
const CLAIM_STATUSES: ClaimStatus[] = ['open', 'supported', 'refuted', 'unclear'];
const EVIDENCE_POINTS: EvidencePoints[] = ['supports', 'refutes'];

function asClaimStatus(v: unknown): ClaimStatus | undefined {
  return CLAIM_STATUSES.includes(v as ClaimStatus) ? (v as ClaimStatus) : undefined;
}

function asPoints(v: unknown): EvidencePoints | undefined {
  return EVIDENCE_POINTS.includes(v as EvidencePoints) ? (v as EvidencePoints) : undefined;
}

export interface LedgerItem {
  id: string;
  title: string;
  summary?: string;
  /** 原文出处（项目相对路径，如 materials/…） */
  source?: string;
  tags?: string[];
  updated?: string;
  kind: 'wiki' | 'raw' | 'project';
  /** 项目页专属：创作阶段（仅 kind==='project' 时有值） */
  stage?: ProjectStage;
  /** 立场（仅 raw 登记有值：材料属于哪一侧，由路径推断；推断不出就不写，不猜） */
  side?: LedgerSide;
  /** 事实来源（wiki 条目与 raw 登记都可有值；缺省视为 material，存量数据不迁移、不报错） */
  origin?: FactOrigin;
  /** 陈述人（仅 origin==='user' 时写：谁说的） */
  statedBy?: string;
  /** 陈述时间（仅 origin==='user' 时写：什么时候说的） */
  statedAt?: string;
  /** 条目类型 key（来自 SCHEMA.md「条目类型」段：fact/entity/issue/comparison/analysis/note，可自定义） */
  type?: string;
  /** 论断的验证状态（仅 type==='claim' 有值；front-matter 键为 status，读不出时视为 open） */
  claimStatus?: ClaimStatus;
  /** 证据卡指向的论断 id（仅 type==='evidence'；front-matter 键为 claim） */
  claim?: string;
  /** 证据方向（仅 type==='evidence'；front-matter 键为 points） */
  points?: EvidencePoints;
  /** 依据材料内容已变更、待复核（材料变更时宿主自动标记；更新该条目即视为复核完成） */
  stale?: boolean;
  /** 待复核原因（仅 stale===true 时有值） */
  staleReason?: string;
}

export interface LedgerEntry extends LedgerItem {
  body: string;
}

/** 项目页（kind=project）：创作闭环的载体，比 LedgerEntry 多一个阶段字段 */
export interface ProjectPage extends LedgerEntry {
  stage: ProjectStage;
}

/** 已激活项目根（无项目返回 null；账本只属于项目，不落到 .sandbox 之类的兜底目录） */
export async function currentProjectRoot(): Promise<string | null> {
  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const project = await getCurrentProject();
    return project?.path || null;
  } catch {
    return null;
  }
}

/** 在既有「条目类型」段末尾补齐研究取向的补充类型行（缺哪行补哪行；段本身不存在则不动，
 *  由 ensureLedger 的整段迁移处理）。段是用户可编辑的，因此只做追加，不改动已有行。 */
function migrateResearchTypeLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((ln) => ln.trim().startsWith(LEDGER_TYPES_SECTION_TITLE));
  if (start < 0) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      end = i; // 下一个二级标题 → 本段结束
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end--; // 段尾空行之前插入，保持排版
  const declared = new Set<string>();
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^\s*-\s+([^|]+)/);
    if (m) declared.add(m[1].trim());
  }
  const missing = LEDGER_RESEARCH_TYPES.filter((t) => !declared.has(t.key));
  if (missing.length === 0) return text;
  lines.splice(end, 0, ...missing.map((t) => `- ${t.key} | ${t.label}`));
  return lines.join('\n');
}

/** 确保账本骨架存在（幂等）：目录 + SCHEMA.md + log.md。返回账本根；无项目根返回 null。 */
export function ensureLedger(projectRoot: string): string | null {
  const root = (projectRoot || '').trim();
  if (!root) return null;
  const l = layout(root);
  try {
    mkdirSync(l.wikiDir, { recursive: true });
    mkdirSync(l.rawDir, { recursive: true });
    if (!existsSync(l.schemaPath)) {
      writeFileSync(l.schemaPath, LEDGER_SCHEMA_SEED, 'utf-8');
    } else {
      // 一次性幂等迁移：存量 SCHEMA.md 缺哪个宿主段就追加哪个（保留原有内容，已有则不动）。
      const cur = readFileSync(l.schemaPath, 'utf-8');
      let next = cur;
      for (const [title, section] of [
        [LEDGER_PARTIES_SECTION_TITLE, LEDGER_PARTIES_SECTION],
        [LEDGER_TYPES_SECTION_TITLE, LEDGER_TYPES_SECTION],
      ] as const) {
        if (!next.includes(title)) next = `${next.trimEnd()}\n\n${section}`;
      }
      // 二次迁移：段已在、但缺研究取向的补充类型行 → 按行补进该段末尾（只补宿主引入的这几个 key，
      // 用户自己增删的行不动）。
      next = migrateResearchTypeLines(next);
      if (next !== cur) {
        // 原子写（唯一临时名 + rename）：SCHEMA.md 是用户可编辑的规则文件，直写遇崩溃会留半截内容。
        const tmp = `${l.schemaPath}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, next, 'utf-8');
        renameSync(tmp, l.schemaPath);
      }
    }
    if (!existsSync(l.logPath)) writeFileSync(l.logPath, '# 项目账本日志\n', 'utf-8');
  } catch {
    /* 建目录失败（只读盘等）按账本不可用处理，不阻断调用方 */
  }
  return l.home;
}

/* ------------------------------ front-matter ------------------------------ */

/** 读一个账本文件（front-matter + 正文）；解析失败按"无 front-matter"处理，不抛错。 */
function readEntryFile(file: string): { data: Record<string, unknown>; body: string } | null {
  try {
    const raw = readFileSync(file, 'utf-8');
    try {
      const parsed = matter(raw);
      return { data: (parsed.data || {}) as Record<string, unknown>, body: parsed.content.trim() };
    } catch {
      return { data: {}, body: raw.trim() };
    }
  } catch {
    return null;
  }
}

/** 每个条目保留的历史快照份数上限（超出删最旧） */
const HISTORY_MAX = 20;

/**
 * 覆盖写入前留一份版本快照（`<wiki>/.history/{id}/{时间戳}.md`）。
 * 只快照 wiki 条目与项目页（raw 是宿主确定性登记，重写无损，不必快照）。
 * 快照是"改写结论是安全的"的前提（补充条款 14）：材料会变、结论会迭代，旧版本必须能回退。
 */
function snapshotEntry(file: string): void {
  const dir = dirname(file).replace(/\/+$/, '');
  if (!dir.endsWith('/wiki')) return;
  const id = basename(file).replace(/\.md$/, '');
  const histDir = join(dir, '.history', id);
  mkdirSync(histDir, { recursive: true });
  // 时间戳到毫秒；同一毫秒内连续写（批量改造）会撞名 → 撞了就加序号，绝不覆盖上一份快照
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = join(histDir, `${stamp}.md`);
  for (let i = 2; existsSync(target); i++) target = join(histDir, `${stamp}-${i}.md`);
  writeFileSync(target, readFileSync(file, 'utf-8'), 'utf-8');
  const files = readdirSync(histDir).filter((f) => f.endsWith('.md')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - HISTORY_MAX))) {
    try {
      rmSync(join(histDir, old), { force: true });
    } catch {
      /* 清理失败不影响主写入 */
    }
  }
}

/** 写一个账本文件（front-matter 用 YAML 序列化；值为 undefined 的键不写入）。
 *  覆盖前留版本快照；落盘走 tmp + rename（唯一临时名），读方永不看到半截条目。 */
function writeEntryFile(file: string, data: Record<string, unknown>, body: string): void {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  try {
    if (existsSync(file)) snapshotEntry(file);
  } catch (e) {
    console.warn('[ledger:history] 快照失败:', e instanceof Error ? e.message : String(e));
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, matter.stringify(`${body.trim()}\n`, clean), 'utf-8');
  renameSync(tmp, file);
}

/** 某条目的历史快照时间戳列表（降序，最新在前；无则空数组） */
export function listLedgerHistory(projectRoot: string, id: string): string[] {
  const clean = (id || '').trim().replace(/\.md$/, '');
  if (!clean || clean.includes('/') || clean.includes('..')) return [];
  try {
    return readdirSync(join(layout(projectRoot).wikiDir, '.history', clean))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 用某份快照回写条目（回写本身也会留快照，可再回退）；快照不存在或 id 非法返回 false */
export function restoreLedgerEntry(projectRoot: string, id: string, stamp: string): boolean {
  const clean = (id || '').trim().replace(/\.md$/, '');
  const s = (stamp || '').trim().replace(/\.md$/, '');
  if (!clean || !s || clean.includes('/') || s.includes('/') || clean.includes('..') || s.includes('..')) return false;
  const l = layout(projectRoot);
  try {
    const parsed = matter(readFileSync(join(l.wikiDir, '.history', clean, `${s}.md`), 'utf-8'));
    writeEntryFile(join(l.wikiDir, `${clean}.md`), (parsed.data || {}) as Record<string, unknown>, parsed.content);
    refreshLedgerIndex(projectRoot);
    appendLog(projectRoot, 'restore', `${clean} ← ${s}`);
    return true;
  } catch {
    return false;
  }
}

function idsOf(dir: string, prefix: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .filter((id) => id.length > 0)
      .sort();
  } catch {
    return [];
  }
}

/** 生成下一个条目 id：<prefix>-YYYYMMDD-NNN（NNN 为当日已有序号 +1）
 *  w = 概览条目 / r = 原始登记 / p = 项目页 */
function nextId(dir: string, prefix: 'w' | 'r' | 'p'): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const head = `${prefix}-${day}-`;
  let max = 0;
  for (const id of idsOf(dir, head)) {
    const n = Number.parseInt(id.slice(head.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${head}${String(max + 1).padStart(3, '0')}`;
}

function asStringTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(/[,，\s]+/).filter(Boolean);
  return [];
}

/** 收集一个目录下的条目元信息（按 id 倒序，最新在前）；kind 决定 id 前缀（wiki/raw/project 同目录不同前缀） */
function listDir(dir: string, kind: 'wiki' | 'raw' | 'project'): LedgerItem[] {
  const out: LedgerItem[] = [];
  const prefix = kind === 'raw' ? 'r-' : kind === 'project' ? 'p-' : 'w-';
  for (const id of idsOf(dir, prefix)) {
    const parsed = readEntryFile(join(dir, `${id}.md`));
    if (!parsed) continue;
    const d = parsed.data;
    const type = typeof d.type === 'string' && d.type ? d.type : undefined;
    out.push({
      id,
      kind,
      title: String(d.title ?? id),
      summary: typeof d.summary === 'string' && d.summary ? d.summary : undefined,
      source: typeof d.source === 'string' && d.source ? d.source : undefined,
      tags: asStringTags(d.tags).length > 0 ? asStringTags(d.tags) : undefined,
      updated: typeof d.updated === 'string' ? d.updated : undefined,
      side: asSide(d.side),
      origin: asOrigin(d.origin),
      statedBy: typeof d.statedBy === 'string' && d.statedBy ? d.statedBy : undefined,
      statedAt: typeof d.statedAt === 'string' && d.statedAt ? d.statedAt : undefined,
      type,
      // 论断缺省 open（未写 status 视为待验证）；证据卡的 claim/points 只在证据卡上有意义
      claimStatus: asClaimStatus(d.status) ?? (type === 'claim' ? 'open' : undefined),
      claim: typeof d.claim === 'string' && d.claim ? d.claim : undefined,
      points: asPoints(d.points),
      stale: d.stale === true ? true : undefined,
      staleReason: d.stale === true && typeof d.staleReason === 'string' && d.staleReason ? d.staleReason : undefined,
      ...(kind === 'project' ? { stage: asStage(d.stage) } : {}),
    });
  }
  return out.reverse();
}

/** 已被 wiki 引用的 raw id 集合（wiki front-matter 的 `raw:` 字段；编译完成的判据） */
function compiledRawIds(projectRoot: string): Set<string> {
  const l = layout(projectRoot);
  const set = new Set<string>();
  for (const id of idsOf(l.wikiDir, 'w-')) {
    const parsed = readEntryFile(join(l.wikiDir, `${id}.md`));
    if (!parsed) continue;
    const v = parsed.data.raw;
    const list = Array.isArray(v) ? v.map((x) => String(x)) : typeof v === 'string' ? v.split(/[,，\s]+/) : [];
    for (const r of list) if (r) set.add(r);
  }
  return set;
}

/* --------------------- 当事人与材料分区（SCHEMA.md 驱动） --------------------- */

/** 解析「当事人与材料分区」段：标题行（允许带括号补充说明）到下一个 `## ` 标题之间、以 `-` 开头的行；
 *  按 `|` 切成 key | 说明 | 目录；key 必须落在 LedgerSide 白名单内（非法行跳过），dirs 去首尾空格与末尾斜杠。 */
function parseLedgerParties(text: string): Array<{ key: LedgerSide; label: string; dirs: string[] }> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((ln) => ln.trim().startsWith(LEDGER_PARTIES_SECTION_TITLE));
  if (start < 0) return [];
  const out: Array<{ key: LedgerSide; label: string; dirs: string[] }> = [];
  const seen = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line.trim())) break; // 下一个二级标题 → 本段结束
    const m = line.match(/^\s*-\s+(.*)$/);
    if (!m) continue;
    const parts = m[1].split('|');
    const key = (parts[0] ?? '').trim() as LedgerSide;
    if (!LEDGER_SIDES.includes(key) || seen.has(key)) continue; // 非法/重复 key 跳过
    const dirs = (parts[2] ?? '')
      .split(/[,，]/)
      .map((d) => d.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    seen.add(key);
    out.push({ key, label: (parts[1] ?? '').trim() || key, dirs });
  }
  return out;
}

/** 「当事人与材料分区」解析缓存（指纹失效：SCHEMA.md 的 mtime/size 变了才重解析）。
 *  该解析挂在材料登记与 lint 等路径上，缓存避免反复读盘；仿 bob-notes 的 noteTypeCache 写法。 */
let partiesCache: { path: string; mtimeMs: number; size: number; parties: Array<{ key: LedgerSide; label: string; dirs: string[] }> } | null = null;

/** 读取当前项目的当事人/材料分区声明（SCHEMA.md「当事人与材料分区」段）。
 *  无该段 / 解析为空 / 文件不可读 → 返回 []（**只读**：不建目录、不触发迁移）。 */
export function readLedgerParties(projectRoot: string): Array<{ key: LedgerSide; label: string; dirs: string[] }> {
  const root = (projectRoot || '').trim();
  if (!root) return [];
  const path = layout(root).schemaPath;
  try {
    const st = statSync(path);
    if (partiesCache && partiesCache.path === path && partiesCache.mtimeMs === st.mtimeMs && partiesCache.size === st.size) {
      return partiesCache.parties;
    }
    const parties = parseLedgerParties(readFileSync(path, 'utf-8'));
    partiesCache = { path, mtimeMs: st.mtimeMs, size: st.size, parties };
    return parties;
  } catch {
    return [];
  }
}

/** 项目相对路径落在哪个分区目录（含子目录）下：`materials/被告/证据.pdf` 命中 `materials/被告` → theirs。
 *  不属于任何分区 → null（不猜、不默认中立）。 */
export function sideOfPath(
  parties: Array<{ key: LedgerSide; label: string; dirs: string[] }>,
  relPath: string,
): LedgerSide | null {
  const p = (relPath || '').trim().replace(/\/+$/, '');
  if (!p) return null;
  for (const party of parties) {
    for (const dir of party.dirs) {
      const d = dir.replace(/\/+$/, '');
      if (d && (p === d || p.startsWith(`${d}/`))) return party.key;
    }
  }
  return null;
}

/* ------------------------------ 条目类型 registry ------------------------------ */

/** 一条条目类型定义（来自 SCHEMA.md「条目类型」段；改规则文件即可增删类型，无需改代码） */
export interface LedgerTypeDef {
  key: string;       // 类型 key（存进 front-matter 的 type）
  label: string;     // 说明（给人/模型看）
  skeleton?: string; // 正文骨架（可选；用字面 \n 表示换行）
}

/** 内置条目类型（SCHEMA.md 缺该段或解析为空时的兜底，与种子段一致） */
export const BUILTIN_LEDGER_TYPES: LedgerTypeDef[] = [
  { key: 'fact', label: '材料事实综述（必须有 materials/ 出处，只说材料写了什么）' },
  { key: 'entity', label: '实体页（主体/机构/人物，跨材料串同一对象）' },
  { key: 'issue', label: '争议焦点（双方的争点，含无争议事实与有争议事实）' },
  { key: 'comparison', label: '双方对照（同一焦点的双方主张与依据并列）' },
  { key: 'analysis', label: '分析推断（不是事实，不得被引用为事实）' },
  { key: 'note', label: '约定与备忘' },
  ...LEDGER_RESEARCH_TYPES,
];

/** 类型 key 的合法形状（存进 front-matter，禁止怪字符） */
const LEDGER_TYPE_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 解析「条目类型」段：标题行（允许带括号补充说明）到下一个 `## ` 标题之间、以 `-` 开头的行。 */
function parseLedgerTypes(text: string): LedgerTypeDef[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((ln) => ln.trim().startsWith(LEDGER_TYPES_SECTION_TITLE));
  if (start < 0) return [];
  const out: LedgerTypeDef[] = [];
  const seen = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line.trim())) break; // 下一个二级标题 → 本段结束
    const m = line.match(/^\s*-\s+(.*)$/);
    if (!m) continue;
    const parts = m[1].split('|');
    const key = (parts[0] ?? '').trim();
    if (!LEDGER_TYPE_KEY_RE.test(key) || seen.has(key)) continue; // 非法/重复 key 跳过
    const skeleton = (parts[2] ?? '').trim().replace(/\\n/g, '\n');
    seen.add(key);
    out.push({ key, label: (parts[1] ?? '').trim() || key, ...(skeleton ? { skeleton } : {}) });
  }
  return out;
}

/** 「条目类型」解析缓存（指纹失效：SCHEMA.md 的 mtime/size 变了才重解析） */
let typesCache: { path: string; mtimeMs: number; size: number; types: LedgerTypeDef[] } | null = null;

/** 读取条目类型清单（SCHEMA.md「条目类型」段）；解析为空或文件不可读 → 回退内置 6 类（**只读**，不建目录）。 */
export function readLedgerTypes(projectRoot: string): LedgerTypeDef[] {
  const root = (projectRoot || '').trim();
  if (!root) return BUILTIN_LEDGER_TYPES;
  const path = layout(root).schemaPath;
  try {
    const st = statSync(path);
    if (typesCache && typesCache.path === path && typesCache.mtimeMs === st.mtimeMs && typesCache.size === st.size) {
      return typesCache.types;
    }
    const parsed = parseLedgerTypes(readFileSync(path, 'utf-8'));
    const types = parsed.length > 0 ? parsed : BUILTIN_LEDGER_TYPES;
    typesCache = { path, mtimeMs: st.mtimeMs, size: st.size, types };
    return types;
  } catch {
    return BUILTIN_LEDGER_TYPES;
  }
}

/** 类型短名（索引行用）：取 label 里括号前的部分，避免把说明整段塞进索引行 */
export function shortTypeLabel(types: LedgerTypeDef[], key: string | undefined): string {
  if (!key) return '';
  const def = types.find((t) => t.key === key);
  if (!def) return key;
  return def.label.split(/[（(]/)[0].trim() || key;
}

/* ------------------- SCHEMA.md 写入（仅档案员 ledger_schema） ------------------- */

/** 段写入结果：warnings 为「已写入但需要代言人转述给用户」的软提示（被忽略的行等） */
export type SchemaWriteResult = { ok: true; path: string; warnings: string[] } | { ok: false; error: string };

/** 原子写回 SCHEMA.md（唯一临时名 + rename，与 ensureLedger 同款）：
 *  规则文件用户也会手改，直写遇崩溃会留半截内容。 */
function writeSchemaAtomic(path: string, next: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, next, 'utf-8');
  renameSync(tmp, path);
  // 解析缓存按 mtime/size 失效，同秒等长写入可能命中旧缓存 → 主动清空（本文件内模块级变量）
  partiesCache = null;
  typesCache = null;
}

/** 定位 SCHEMA.md 里一个二级段的行区间：start = 标题行下标，end = 下一个 `## ` 标题或文件末尾 */
function schemaSectionRange(lines: string[], title: string): { start: number; end: number } | null {
  const start = lines.findIndex((ln) => ln.trim().startsWith(title));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) return { start, end: i };
  }
  return { start, end: lines.length };
}

/** 清洗一条分区目录：转成项目相对路径前缀（去 ./ 与末尾斜杠）；非法者记进 bad */
function cleanPartyDir(dir: string, bad: string[]): string {
  const d = dir.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!d) return '';
  if (d.startsWith('/') || d.includes('..')) {
    bad.push(dir.trim());
    return '';
  }
  return d;
}

/** 重写「当事人与材料分区」段：分区是**声明表**（同一 key 只能有一条），所以整表替换，
 *  允许改口径与撤回；段内说明行（既非 `-` 声明行也非 `#` 示例行）原样保留。
 *  parties 传 [] = 清空声明（该库不做分侧检查）。 */
export function writeLedgerParties(
  projectRoot: string,
  parties: Array<{ key: LedgerSide; label: string; dirs: string[] }>,
): SchemaWriteResult {
  const root = (projectRoot || '').trim();
  if (!root) return { ok: false, error: '无激活项目' };
  try {
    ensureLedger(root); // SCHEMA.md 缺失时先落种子（幂等）
    const path = layout(root).schemaPath;
    const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
    const range = schemaSectionRange(lines, LEDGER_PARTIES_SECTION_TITLE);
    if (!range) return { ok: false, error: 'SCHEMA.md 缺「当事人与材料分区」段，无法写入' };

    const bad: string[] = [];
    const warnings: string[] = [];
    const rows: string[] = [];
    const seen = new Set<LedgerSide>();
    for (const party of parties) {
      if (!LEDGER_SIDES.includes(party.key) || seen.has(party.key)) continue;
      seen.add(party.key);
      const dirs = party.dirs.map((d) => cleanPartyDir(d, bad)).filter(Boolean);
      if (dirs.length === 0) warnings.push(`${party.key} 未声明任何目录：该侧材料不会被自动归侧`);
      rows.push(`- ${party.key} | ${party.label.trim() || party.key} | ${dirs.join(', ')}`);
    }
    if (bad.length > 0) warnings.push(`已忽略非法目录：${bad.join('、')}（须为项目相对路径前缀，不能是绝对路径或含 ..）`);

    // 段内保留说明文字（说明行不是声明表的一部分，重写时不该把它抹掉）
    const keep = lines.slice(range.start + 1, range.end).filter((ln) => {
      const t = ln.trim();
      return !t.startsWith('-') && !t.startsWith('#');
    });
    while (keep.length > 0 && keep[keep.length - 1].trim() === '') keep.pop();

    const body = [...keep, ...(rows.length > 0 ? ['', ...rows] : []), ''];
    const next = [...lines.slice(0, range.start + 1), ...body, ...lines.slice(range.end)].join('\n');
    writeSchemaAtomic(path, next);
    return { ok: true, path, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 追加「条目类型」段缺的声明行（**只加不删**：删类型请在文件里手改，避免误删内置类型）。
 *  key 形状不合规或已声明的跳过；skeleton 里的真换行按段格式转义成字面 \n。 */
export function addLedgerTypes(projectRoot: string, defs: LedgerTypeDef[]): SchemaWriteResult {
  const root = (projectRoot || '').trim();
  if (!root) return { ok: false, error: '无激活项目' };
  try {
    ensureLedger(root);
    const path = layout(root).schemaPath;
    const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
    const range = schemaSectionRange(lines, LEDGER_TYPES_SECTION_TITLE);
    if (!range) return { ok: false, error: 'SCHEMA.md 缺「条目类型」段，无法写入' };

    const declared = new Set<string>();
    for (let i = range.start + 1; i < range.end; i++) {
      const m = lines[i].match(/^\s*-\s+([^|]+)/);
      if (m) declared.add(m[1].trim());
    }
    const warnings: string[] = [];
    const added: string[] = [];
    for (const def of defs) {
      const key = (def.key || '').trim();
      if (!LEDGER_TYPE_KEY_RE.test(key)) {
        warnings.push(`已忽略非法类型 key：${key || '(空)'}（须以字母开头，仅含字母/数字/_/-）`);
        continue;
      }
      if (declared.has(key)) {
        warnings.push(`类型 ${key} 已声明，未重复写入`);
        continue;
      }
      declared.add(key);
      const skeleton = (def.skeleton || '').trim().replace(/\n/g, '\\n');
      added.push(`- ${key} | ${(def.label || '').trim() || key}${skeleton ? ` | ${skeleton}` : ''}`);
    }
    if (added.length === 0) return { ok: true, path, warnings };

    const end = (() => {
      let e = range.end;
      while (e > range.start + 1 && lines[e - 1].trim() === '') e--; // 段尾空行之前插入，保持排版
      return e;
    })();
    const next = [...lines.slice(0, end), ...added, ...lines.slice(end)].join('\n');
    writeSchemaAtomic(path, next);
    return { ok: true, path, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 追加一条补充条款到「## 补充条款」段（段不存在则创建；append-only，不改既有内容）。
 *  段若不在文件末尾，插在该段内末尾而非文件末尾——避免落进别的段。 */
export function appendLedgerClause(projectRoot: string, clause: string): SchemaWriteResult {
  const root = (projectRoot || '').trim();
  if (!root) return { ok: false, error: '无激活项目' };
  const text = (clause || '').trim();
  if (!text) return { ok: false, error: 'clause 为空' };
  try {
    ensureLedger(root);
    const path = layout(root).schemaPath;
    const cur = readFileSync(path, 'utf-8');
    const lines = cur.split(/\r?\n/);
    const range = schemaSectionRange(lines, LEDGER_CLAUSE_SECTION_TITLE);
    let end: number;
    let head: string[];
    if (range) {
      end = range.end;
      while (end > range.start + 1 && lines[end - 1].trim() === '') end--;
      head = lines.slice(0, end);
    } else {
      head = [...lines];
      while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
      head.push('', LEDGER_CLAUSE_SECTION_TITLE);
      end = head.length;
    }
    const next = [...head, ...text.split(/\r?\n/), ...lines.slice(end)].join('\n');
    writeSchemaAtomic(path, next);
    return { ok: true, path, warnings: [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* --------------------------------- 索引 --------------------------------- */

/** 刷新 index.md（宿主维护：扫 raw/ wiki/ 的 front-matter 重写，确定性、0 token）。
 *  顺带跑一次机械自检并把问题摘要写进索引头（事件驱动：写入/材料登记都会刷新索引，
 *  不需要定时器）——返回问题行，供 read_ledger 索引形态一并显示。 */
export function refreshLedgerIndex(projectRoot: string): string[] {
  const l = layout(projectRoot);
  if (!existsSync(l.home)) return [];
  const wiki = listDir(l.wikiDir, 'wiki').reverse(); // 索引里按时间正序，便于读成脉络
  const projects = listDir(l.wikiDir, 'project').reverse(); // 项目页（p-…）：创作入口，单独分区
  const raw = listDir(l.rawDir, 'raw').reverse();
  const compiled = compiledRawIds(projectRoot);
  const pending = raw.filter((r) => !compiled.has(r.id));
  // 机械自检（0 token）：只报事实（缺出处/断链/单侧依据/需复核…），不判断对错
  const lint = collectLintIssues(projectRoot);
  const brief = lint
    .slice(0, 2)
    .map((s) => (s.length > 48 ? `${s.slice(0, 48)}…` : s))
    .join('；');

  const lines: string[] = [
    '# 项目账本索引',
    '',
    '> 由 BobWork 宿主自动生成（扫描 raw/ 与 wiki/ 的 front-matter），请勿手改；条目正文见同名文件。',
    '',
    ...(lint.length > 0 ? [`${LINT_SUMMARY_PREFIX} ${lint.length} 项待处理：${brief}（ledger_lint 看全部）`, ''] : []),
    `## 项目页 wiki/p-…（${projects.length} 项）`,
  ];
  if (projects.length === 0) {
    lines.push('（暂无：需要用档案员建项目页时才有）');
  } else {
    for (const p of projects) {
      lines.push(`- [${p.stage ?? 'idea'}] **${p.title}** \`${p.id}\``);
      if (p.summary) lines.push(`  ${p.summary}`);
    }
  }
  lines.push('', `## 概览条目 wiki/（${wiki.length} 条）`);
  if (wiki.length === 0) {
    lines.push('（暂无）');
  } else {
    const types = readLedgerTypes(projectRoot);
    for (const w of wiki) {
      // 用户陈述条目（origin=user）在索引里显式标注，避免与材料事实混读；
      // 条目标注类型短名（registry 驱动）与「需复核」（所依据材料已变更）——按侧/按类浏览都靠这几行。
      const originTag = w.origin === 'user' ? ' · 用户陈述' : '';
      const typeLabel = shortTypeLabel(types, w.type);
      const typeTag = typeLabel ? ` · ${typeLabel}` : '';
      // 论断的验证状态直接标在索引行（open 是待办信号：还没证据就得接着查）
      const claimTag = w.type === 'claim' && w.claimStatus ? ` · ${w.claimStatus}` : '';
      const staleTag = w.stale === true ? ' · 需复核' : '';
      lines.push(`- **${w.title}** \`${w.id}\`${originTag}${typeTag}${claimTag}${staleTag}${w.source ? ` — 出处：${w.source}` : ''}`);
      if (w.summary) lines.push(`  ${w.summary}`);
    }
  }
  lines.push('', `## 原始登记 raw/（${raw.length} 条，待编译 ${pending.length} 条）`);
  if (raw.length === 0) {
    lines.push('（暂无）');
  } else {
    for (const r of raw) {
      const mark = compiled.has(r.id) ? '' : ' · 待编译';
      // 材料登记的立场（由路径推断而来）标在行内，便于按侧浏览
      const sideTag = r.side ? ` · ${r.side}` : '';
      lines.push(`- ${r.title} \`${r.id}\`${sideTag}${r.source ? ` — ${r.source}` : ''}${mark}`);
    }
  }
  const text = `${lines.join('\n')}\n`;
  try {
    // 变化检测：内容没变就不写盘。readLedgerIndex → refreshLedgerIndex 挂在「每次读」的路径上，
    // 无条件重写等于 write-on-read —— 并发读会互相写竞争，账本大了每次读都要白扫一遍写一次。
    if (existsSync(l.indexPath) && readFileSync(l.indexPath, 'utf-8') === text) return lint;
    // 原子写（临时文件 + rename）：读方永不看到半截索引
    const tmp = `${l.indexPath}.tmp-${process.pid}`;
    writeFileSync(tmp, text, 'utf-8');
    renameSync(tmp, l.indexPath);
  } catch {
    /* 写索引失败不阻断读取（下次再刷） */
  }
  return lint;
}

/* -------------------------------- 读取 -------------------------------- */

/**
 * 读取时追加的**版本化增量条款**（宿主注入，不改写盘上的 SCHEMA.md）：
 * 盘上的 SCHEMA.md 由人编辑、已存在的不会被覆盖（见 ensureLedger 的种子写入），
 * 因此「加一条规则」若只改种子，对**存量项目无效** —— 增量条款挂在读取口，存量账本同样生效。
 */
const LEDGER_RULES_APPENDIX = `## 补充条款（宿主注入 · 对存量账本同样生效）
7. **项目页（创作闭环）**：\`wiki/\` 里 id 以 \`p-\` 开头的是**项目页**——一页对一件要产出的事，
   与 w- 概览条目（知识）并列、互不替代。front-matter 记 \`kind: project\` 与
   \`stage: idea|outline|draft|done\`；正文分节写「目标 / 知识引用 / 知识缺口 / 工作流 / 产出与回编」：
   - **知识引用**写账本条目 id（\`w-…\`）或材料路径（\`materials/…\`）——项目页消费知识，不复制知识；
   - **知识缺口**写"需要但库里还没有"的材料或结论，作为下一步取材料的依据；
   - **产出与回编**写产出落地的项目相对路径（\`homework/…\`）；产出中的新结论用 \`ledger_record\`
     回编成 \`w-\` 条目（知识因此回流，供下一个项目页引用）；
   - 项目页不要求 \`materials/\` 出处（它本身不是结论），但引用的知识必须真实存在（断链由 \`ledger_lint\` 报出）。
8. **冲突时的权威顺序**：项目里的结论权威只有「锁定成果块」。账本条目（结论、约定、材料综述）
   不得与已锁定成果块冲突；发现冲突时以锁定成果块为准，并在该条目标注「与锁定成果块冲突，待复核」。
9. **缓存不得作源**：压缩记忆、对话摘要等缓存内容**不得作为账本出处的来源**；
   出处一律写原始材料路径（\`materials/…\`、\`homework/…\`）。
10. **事实分三源，永不混同**：账本与回答里的事实性内容只有三个合法来源——
    ① 材料事实：\`materials/…\` 原文（可核；写出路径，能给页码就给页码）；
    ② 用户陈述：用户在对话中补充、账本里原本没有的新事实（不可核，但是有效的当事人陈述；
       登记时 \`origin=user\` 并写明陈述人与日期，引用时标 \`[来源: 用户陈述 · 日期]\`）；
    ③ 外部信息：经检索工具取回的项目外信息（\`origin=external\`，必须带 URL）。
    模型自身的法律知识、常识与记忆**只能作为分析框架**（用来提示"这里有需要核实的事实点"），
    **不得充当事实依据**；模型的分析推断也不是事实，不得被后续条目引用为事实。
11. **有正必有反，模型不做取舍**：诉讼材料天然分侧（\`ours\` 我方 / \`theirs\` 对方 / \`neutral\` 中立）。
    条目与回答里的结论性表述一律不写"成立 / 不成立 / 本院认为"式判断，只写**双方主张、各自依据、
    一致点、分歧点与缺口**。任一焦点只找到单侧依据时，必须显式标注「仅单侧依据，缺对照」——
    缺对照不等于该侧成立；写出这句标注即视为已声明缺口，\`ledger_lint\` 不再重复报该条。
    材料分区在 SCHEMA.md 的「当事人与材料分区」段声明。
12. **观点体检（不可遗漏）**：用户提出一个观点时，必须先做双侧检索，并固定输出三节：
    ① 支撑事实 ② 不利事实 ③ 覆盖缺口。三节**永远存在**，无内容也要写「无」。
    不利事实为零时不得直接说"有事实支撑"，只能写「未检索到不利事实（不等于不存在）」；
    两侧都为零时写「账本与材料中均未检索到相关事实，该观点目前无项目事实支撑」。
    账本检索是关键词 + 索引（无向量），因此**禁止宣称"已核对全部材料"**，只报检索范围与命中数。
13. **条目类型**：写条目时声明 \`type\`（fact 材料事实 / entity 实体 / issue 争议焦点 / comparison 双方对照 /
    analysis 分析推断 / note 约定备忘 / concept 概念口径 / claim 论断假设 / evidence 证据卡 /
    timeline 时间线 / method 方法口径；类型清单见 SCHEMA.md「条目类型」段，可自行增删）。
    \`comparison\` 必须**两侧各至少一条出处**（缺一侧即为缺对照）；\`fact\` 必须有 \`materials/\` 出处；
    \`analysis\` 与 \`claim\` 是推断/待验证命题，**不得被其他条目引用为事实依据**；
    \`evidence\` 必须标立场与出处，并指向某条 \`claim\`；\`method\` 记检索式/筛选标准，以便结论可复现。
    **研究取向字段**（与当事人立场 \`side\` 正交，不要混用）：\`claim\` 条目用 \`status\` 记验证状态
    （open 待验证 / supported 已有支撑 / refuted 已被反驳 / unclear 尚不明确，缺省 open）；
    \`evidence\` 条目除用 \`claim: w-…\` 指向论断外，还用 \`points: supports | refutes\` 标方向。
    证据卡脱离论断（未指向 / 指向的 id 不存在 / 指向的不是 claim）会被 \`ledger_lint\` 当**孤儿证据**报出；
    论断**只有单侧证据**、或**长期停在 open**（约 30 天）也会被报出——按检出结果补证据或推进状态即可。
    判断类（issue / comparison / analysis / claim）默认只在用户明确要求时写；**唯一例外是宿主下发的后台账本编译任务**——
    它可写 \`comparison\`（条件：同一焦点两侧材料都已读到或已登记、两侧各至少一条 \`materials/\` 出处、
    正文只并列不裁决），\`issue\` / \`analysis\` / \`claim\` 仍需用户明确要求。
14. **结论可复核**：材料内容变更时，引用它的条目会被标记「依据材料已变更，需复核」，更新该条目即视为复核完成
    （标记自动清除）；**标记未清除前，该条目的结论不得作为现行事实引用**（\`read_ledger\` 与 \`ledger_challenge\`
    会显式标注）；条目被覆盖写入前会自动留版本快照（\`.ledger/wiki/.history/{id}/{时间戳}.md\`，每条约 20 份），
    需要回退时按该目录里的旧版本重写条目即可。因此**改写结论是安全的**——
    不要为了"怕丢"而另起新条目。`;

/** 账本规则（SCHEMA.md 原文 + 宿主增量条款） */
export function readLedgerRules(projectRoot: string): string {
  ensureLedger(projectRoot);
  const l = layout(projectRoot);
  try {
    const raw = readFileSync(l.schemaPath, 'utf-8').trim();
    return raw ? `${raw}\n\n${LEDGER_RULES_APPENDIX}` : LEDGER_RULES_APPENDIX;
  } catch {
    return LEDGER_RULES_APPENDIX;
  }
}

/** 账本索引（可选关键词过滤：命中标题/摘要/出处/标签，wiki 另含正文）。
 *  `lint` 为随索引刷新一并算出的机械自检问题行（0 token，供读取方显式提示）。 */
export function readLedgerIndex(projectRoot: string, query = ''): {
  wiki: LedgerItem[];
  projects: LedgerItem[];
  raw: LedgerItem[];
  pending: LedgerItem[];
  hits: LedgerEntry[];
  total: { wiki: number; raw: number };
  lint: string[];
} {
  ensureLedger(projectRoot);
  const lint = refreshLedgerIndex(projectRoot);
  const l = layout(projectRoot);
  const wiki = listDir(l.wikiDir, 'wiki');
  const projects = listDir(l.wikiDir, 'project');
  const raw = listDir(l.rawDir, 'raw');
  const compiled = compiledRawIds(projectRoot);
  const pending = raw.filter((r) => !compiled.has(r.id));

  const q = query.trim().toLowerCase();
  if (!q) return { wiki, projects, raw, pending, hits: [], total: { wiki: wiki.length, raw: raw.length }, lint };

  const match = (item: LedgerItem, extra = ''): boolean =>
    `${item.title}\n${item.summary ?? ''}\n${item.source ?? ''}\n${(item.tags ?? []).join(' ')}\n${extra}`
      .toLowerCase()
      .includes(q);

  const wikiHits: LedgerEntry[] = [];
  for (const item of wiki) {
    const parsed = readEntryFile(join(l.wikiDir, `${item.id}.md`));
    const body = parsed?.body ?? '';
    if (match(item, body)) wikiHits.push({ ...item, body });
  }
  // 项目页同目录（p-…）：命中同样计入，让"这个项目要做什么"也能被关键词检索到
  const projectHits: LedgerEntry[] = [];
  for (const item of projects) {
    const parsed = readEntryFile(join(l.wikiDir, `${item.id}.md`));
    const body = parsed?.body ?? '';
    if (match(item, body)) projectHits.push({ ...item, body });
  }
  const rawHits: LedgerEntry[] = [];
  for (const item of raw) {
    const parsed = readEntryFile(join(l.rawDir, `${item.id}.md`));
    const body = parsed?.body ?? '';
    if (match(item, body)) rawHits.push({ ...item, body });
  }
  return { wiki, projects, raw, pending, hits: [...projectHits, ...wikiHits, ...rawHits], total: { wiki: wiki.length, raw: raw.length }, lint };
}

/** 读单条正文（wiki 优先，其次 raw） */
export function readLedgerEntry(projectRoot: string, id: string): LedgerEntry | null {
  ensureLedger(projectRoot);
  const l = layout(projectRoot);
  const cleanId = id.trim().replace(/\.md$/, '');
  // w- 概览条目与 p- 项目页同在 wiki/ 下（前缀区分），r- 原始登记在 raw/
  if (!/^[wrp]-[A-Za-z0-9-]+$/.test(cleanId)) return null;
  const dir = cleanId.startsWith('r-') ? l.rawDir : l.wikiDir;
  const parsed = readEntryFile(join(dir, `${cleanId}.md`));
  if (!parsed) return null;
  const d = parsed.data;
  const type = typeof d.type === 'string' && d.type ? d.type : undefined;
  return {
    id: cleanId,
    kind: cleanId.startsWith('r-') ? 'raw' : cleanId.startsWith('p-') ? 'project' : 'wiki',
    title: String(d.title ?? cleanId),
    summary: typeof d.summary === 'string' && d.summary ? d.summary : undefined,
    source: typeof d.source === 'string' && d.source ? d.source : undefined,
    tags: asStringTags(d.tags).length > 0 ? asStringTags(d.tags) : undefined,
    updated: typeof d.updated === 'string' ? d.updated : undefined,
    side: asSide(d.side),
    origin: asOrigin(d.origin),
    statedBy: typeof d.statedBy === 'string' && d.statedBy ? d.statedBy : undefined,
    statedAt: typeof d.statedAt === 'string' && d.statedAt ? d.statedAt : undefined,
    type,
    claimStatus: asClaimStatus(d.status) ?? (type === 'claim' ? 'open' : undefined),
    claim: typeof d.claim === 'string' && d.claim ? d.claim : undefined,
    points: asPoints(d.points),
    stale: d.stale === true ? true : undefined,
    staleReason: d.stale === true && typeof d.staleReason === 'string' && d.staleReason ? d.staleReason : undefined,
    body: parsed.body,
  };
}

/** 待编译 raw 清单（未被任何 wiki 的 `raw:` 引用） */
export function listLedgerPending(projectRoot: string): LedgerItem[] {
  const { pending } = readLedgerIndex(projectRoot);
  return pending;
}

/** 待编译 raw 条目数（**只读**：不建目录、不重写 index.md）。
 *  listLedgerPending 走 readLedgerIndex 会顺带刷新索引（写盘），不适合挂在每轮必走的注入链上；
 *  宿主每轮注入「待编译 N 条」提醒用本函数。无账本/读失败 = 0。 */
export function countPendingRaw(projectRoot: string): number {
  const l = layout(projectRoot);
  if (!existsSync(l.home)) return 0;
  const compiled = compiledRawIds(projectRoot);
  return listDir(l.rawDir, 'raw').filter((r) => !compiled.has(r.id)).length;
}

/* -------------------------------- 写入 -------------------------------- */

function appendLog(projectRoot: string, action: string, detail: string): void {
  const l = layout(projectRoot);
  try {
    appendFileSync(l.logPath, `- ${new Date().toISOString()} [${action}] ${detail}\n`, 'utf-8');
  } catch {
    /* 日志写失败不影响账本内容 */
  }
}

/** 追加「入口留痕」行（六）：`[entry] turn=… | … | fetch=…`，一次 append 写本轮一行。
 *  只在账本已存在时写 —— 不因写日志凭空创建 `.ledger/`（账本是显式产物，不该被度量副作用带出来）；
 *  无账本时跳过，对话落盘不受影响。 */
export function appendEntryLog(projectRoot: string, lines: string[]): void {
  if (lines.length === 0) return;
  const l = layout(projectRoot);
  if (!existsSync(l.home)) return;
  try {
    appendFileSync(l.logPath, lines.map((s) => `- ${new Date().toISOString()} [entry] ${s}\n`).join(''), 'utf-8');
  } catch {
    /* 留痕写失败不影响账本内容 */
  }
}

/* --------------------------- 锁定台账（P0-a 外部锚点） --------------------------- */

/** 一条锁定台账记录。台账是成果块锁定的**外部锚点**：
 *  内容哈希另存一份在 `.ledger/locks.md`，因此「正文与 frontmatter 里的哈希被一并重写」也能被检出
 *  （注入侧双锚点校验：节点侧 outcome_lock_history ↔ 项目级台账 latestLockOf）。 */
export interface LockRecord {
  at: string;
  action: 'lock' | 'relock' | 'force_lock' | 'unlock';
  nodeId: string;
  version: number;
  /** 该版内容哈希（unlock 时写保留的哈希；无则 '-'） */
  hash: string;
  /** 签署人（与 outcome_locked_by 同源）；缺省视为 unknown */
  by?: string;
  /** 前一版哈希，形成版本链 */
  prevHash?: string;
}

/** 台账文件首行（仅创建时写一次；解析时按脏行跳过，不参与记录提取） */
const LOCK_TAPE_SEED = '# 锁定台账（append-only 外部锚点 · 每行一条记录 · 请勿手改）\n';

/** 进程内「上次行数」快照：台账被截断（行数减少）→ 视为篡改信号 */
const lockTapeLineCounts = new Map<string, number>();

/** 台账行格式（append-only，一行一条）：
 *  `- <ISO> [<action>] node=<nodeId> v=<version> hash=<hash> by=<by|unknown> prev=<prevHash|->` */
const LOCK_LINE_RE = /^-\s+(\S+)\s+\[([a-z_]+)\]\s+node=(\S+)\s+v=(\d+)\s+hash=(\S+)\s+by=(\S+)\s+prev=(\S+)$/;

/** 解析一行台账记录；格式不符（脏行/表头/空行）返回 null，不抛错 */
function parseLockLine(line: string): LockRecord | null {
  const m = line.trim().match(LOCK_LINE_RE);
  if (!m) return null;
  const action = m[2] as LockRecord['action'];
  if (action !== 'lock' && action !== 'relock' && action !== 'force_lock' && action !== 'unlock') return null;
  const version = Number.parseInt(m[4], 10);
  if (!Number.isFinite(version)) return null;
  return {
    at: m[1],
    action,
    nodeId: m[3],
    version,
    hash: m[5],
    by: m[6] && m[6] !== 'unknown' ? m[6] : undefined,
    prevHash: m[7] !== '-' ? m[7] : undefined,
  };
}

/** 追加一条锁定台账记录（append-only）。台账是锁定的外部锚点，允许在此创建 .ledger/ 目录
 *  与 locks.md（只建目录 + 该文件，不写 SCHEMA.md/index.md/raw/wiki 骨架）；写失败仅 console.warn。 */
export function appendLockRecord(projectRoot: string, rec: LockRecord): void {
  const root = (projectRoot || '').trim();
  if (!root) return;
  const l = layout(root);
  const line = `- ${rec.at} [${rec.action}] node=${rec.nodeId} v=${rec.version} hash=${rec.hash} by=${rec.by || 'unknown'} prev=${rec.prevHash || '-'}\n`;
  try {
    if (!existsSync(l.lockTapePath)) {
      mkdirSync(l.home, { recursive: true });
      writeFileSync(l.lockTapePath, LOCK_TAPE_SEED, 'utf-8');
    }
    appendFileSync(l.lockTapePath, line, 'utf-8');
  } catch (err) {
    console.warn('[ledger:lock-tape] 追加锁定台账失败:', err instanceof Error ? err.message : String(err));
  }
}

/** 读整个台账：解析每行为一条记录（脏行跳过，不抛错）；并做「行数只增不减」防篡改检测
 *  （进程内 Map<projectRoot, 上次行数>，行数变少 → console.warn + truncated: true）。
 *  无台账文件时返回 { records: [], truncated: false }（读不创建目录）。 */
export function readLockTape(projectRoot: string): { records: LockRecord[]; truncated: boolean } {
  const root = (projectRoot || '').trim();
  if (!root) return { records: [], truncated: false };
  const l = layout(root);
  let text: string;
  try {
    text = readFileSync(l.lockTapePath, 'utf-8');
  } catch {
    return { records: [], truncated: false };
  }
  const lines = text.split('\n');
  const prevCount = lockTapeLineCounts.get(root);
  const truncated = prevCount !== undefined && lines.length < prevCount;
  lockTapeLineCounts.set(root, lines.length);
  if (truncated) {
    console.warn(`[ledger:lock-tape] 锁定台账行数减少（${prevCount} → ${lines.length}），疑被截断改写`);
  }
  const records: LockRecord[] = [];
  for (const line of lines) {
    const rec = parseLockLine(line);
    if (rec) records.push(rec);
  }
  return { records, truncated };
}

/** 某节点在台账里的最新一条记录（无则 null）。用于注入侧双锚点校验。 */
export function latestLockOf(projectRoot: string, nodeId: string): LockRecord | null {
  const { records } = readLockTape(projectRoot);
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].nodeId === nodeId) return records[i];
  }
  return null;
}

/** 写/更新一条 wiki 概览条目（档案员调用）：
 *  - 不传 id：新建条目；传 id：覆盖更新该条目（保留 created）。
 *  - 出处 source 与依据 raw ids 写入 front-matter，便于索引与「待编译」判定。
 *  - 更新已有条目即视为**复核完成**：不写 stale/staleReason，旧标记自动消失（front-matter 整体重写）。 */
export function recordLedgerEntry(
  projectRoot: string,
  input: { title: string; content: string; id?: string; source?: string; tags?: string[]; rawIds?: string[]; origin?: FactOrigin; statedBy?: string; statedAt?: string; type?: string; status?: string; claim?: string; points?: string },
): { id: string; created: boolean; warning?: string } {
  ensureLedger(projectRoot);
  const l = layout(projectRoot);
  const now = new Date().toISOString();
  const body = input.content.trim();
  const summary = body.split('\n').map((s) => s.trim()).filter(Boolean)[0]?.slice(0, 120) ?? '';

  // 条目类型：只接受 SCHEMA.md「条目类型」段声明的 key；未知类型不抛错（不打断档案员工作流），
  // 按未分类写入并回一个 warning，让调用方自己决定是否纠正。
  const wantedType = (input.type || '').trim();
  const type = wantedType && readLedgerTypes(projectRoot).some((t) => t.key === wantedType) ? wantedType : undefined;
  const warnings: string[] = [];
  if (wantedType && !type) warnings.push(`未知条目类型 ${wantedType}，已按未分类写入（可先在 .ledger/SCHEMA.md 的「条目类型」段声明）`);

  // 研究取向字段：只对相应类型生效（status 仅 claim；claim/points 仅 evidence）；
  // 类型不符或取值非法时按未采用处理并回 warning（与未知 type 同策略，不打断档案员工作流）。
  const wantedStatus = (input.status || '').trim();
  const status = type === 'claim' ? asClaimStatus(wantedStatus) : undefined;
  if (wantedStatus && !status) warnings.push(type === 'claim' ? `status 只能是 ${CLAIM_STATUSES.join(' | ')}（已忽略）` : 'status 仅用于 claim（论断）条目（已忽略）');
  const wantedClaim = (input.claim || '').trim();
  const claim = type === 'evidence' && /^w-/.test(wantedClaim) ? wantedClaim : undefined;
  if (wantedClaim && !claim) warnings.push(type === 'evidence' ? 'claim 必须是论断条目 id（w-…）（已忽略）' : 'claim 仅用于 evidence（证据卡）条目（已忽略）');
  const wantedPoints = (input.points || '').trim();
  const points = type === 'evidence' ? asPoints(wantedPoints) : undefined;
  if (wantedPoints && !points) warnings.push(type === 'evidence' ? `points 只能是 ${EVIDENCE_POINTS.join(' | ')}（已忽略）` : 'points 仅用于 evidence（证据卡）条目（已忽略）');

  const wanted = (input.id || '').trim().replace(/\.md$/, '');
  const existing = wanted && /^w-/.test(wanted) ? readEntryFile(join(l.wikiDir, `${wanted}.md`)) : null;
  const id = wanted && /^w-/.test(wanted) ? wanted : nextId(l.wikiDir, 'w');

  writeEntryFile(
    join(l.wikiDir, `${id}.md`),
    {
      id,
      title: input.title.trim() || id,
      summary,
      source: input.source?.trim(),
      raw: input.rawIds?.filter(Boolean),
      tags: input.tags?.filter(Boolean),
      // 事实来源（缺省不写 → 视为 material，存量调用行为完全不变）；陈述人/时间只在用户陈述时写
      origin: input.origin,
      statedBy: input.origin === 'user' ? input.statedBy?.trim() : undefined,
      statedAt: input.origin === 'user' ? input.statedAt?.trim() : undefined,
      type,
      // 研究取向字段（缺省不写；front-matter 键与 schema 一致：status / claim / points）
      status,
      claim,
      points,
      created: (existing?.data.created as string) || now,
      updated: now,
    },
    body,
  );
  refreshLedgerIndex(projectRoot);
  appendLog(projectRoot, existing ? 'update' : 'record', `${id} ${input.title.trim()}${type ? ` [${type}]` : ''}`);
  return { id, created: !existing, ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}) };
}

/** 把引用了某条 raw 的条目（wiki 概览 + 项目页）标记为「依据材料已变更，需复核」；返回被标记的条目数。
 *  只动 front-matter 的 stale/staleReason，正文与其他字段原样保留；单条写失败不影响其余。
 *  这是「事实版本锚定」的落地：材料会变、结论会迭代，基于旧版材料的结论必须显式可见。 */
function markStaleByRaw(projectRoot: string, rawId: string, reason: string): number {
  const l = layout(projectRoot);
  let count = 0;
  for (const kind of ['wiki', 'project'] as const) {
    for (const item of listDir(l.wikiDir, kind)) {
      const file = join(l.wikiDir, `${item.id}.md`);
      const parsed = readEntryFile(file);
      if (!parsed) continue;
      const rv = parsed.data.raw;
      const refs = Array.isArray(rv) ? rv.map((x) => String(x)) : typeof rv === 'string' ? rv.split(/[,，\s]+/) : [];
      if (!refs.includes(rawId)) continue;
      if (parsed.data.stale === true && parsed.data.staleReason === reason) continue; // 同一原因已标过 → 不重复写
      try {
        writeEntryFile(file, { ...parsed.data, stale: true, staleReason: reason }, parsed.body);
        count++;
      } catch {
        /* 单条写失败不影响其余条目 */
      }
    }
  }
  return count;
}

/* ------------------------- 项目页（p-… 创作闭环） ------------------------- */

/** 项目页正文骨架（五节）：新建时给出可填结构，避免开一个空页。
 *  节名即语义契约（见补充条款 7）：引用已有的、点名缺的、写清怎么做、产出回编。 */
function projectBodyTemplate(goal: string): string {
  return [
    '## 目标',
    goal.trim() || '（待写：这件事要产出什么、验收标准是什么）',
    '',
    '## 知识引用',
    '（写账本条目 id `w-…` 或材料路径 `materials/…`：引用已有知识，不复制内容）',
    '',
    '## 知识缺口',
    '（写"需要但账本/材料里还没有"的材料或结论，作为下一步取材料的依据）',
    '',
    '## 工作流',
    '（写这件事怎么做：步骤、用到的模板/工具、需要人工确认的点）',
    '',
    '## 产出与回编',
    '（写产出落地的项目相对路径 `homework/…`；产出中的新结论用 ledger_record 回编成 `w-` 条目）',
  ].join('\n');
}

/** 项目页摘要：优先显式目标，其次正文首个非空、非标题、非占位句的行 */
function projectSummary(goal: string, body: string): string {
  if (goal.trim()) return goal.trim().slice(0, 120);
  const line = body.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#') && !s.startsWith('（')) ?? '';
  return line.slice(0, 120);
}

/** 列项目页（p-…，最新在前） */
export function listProjectPages(projectRoot: string): LedgerItem[] {
  ensureLedger(projectRoot);
  return listDir(layout(projectRoot).wikiDir, 'project');
}

/** 读一个项目页（非 p- id 或不存在返回 null） */
export function readProjectPage(projectRoot: string, id: string): ProjectPage | null {
  const entry = readLedgerEntry(projectRoot, id);
  if (!entry || entry.kind !== 'project') return null;
  const parsed = readEntryFile(join(layout(projectRoot).wikiDir, `${entry.id}.md`));
  return { ...entry, stage: asStage(parsed?.data.stage) };
}

/** 新建项目页（档案员调用）：一页对一件要产出的事。
 *  - `stage` 缺省 idea；`goal` 有值时正文「目标」节与摘要都用它；
 *  - 项目页不要求 `materials/` 出处（它本身不是结论），引用写在「知识引用」节里。 */
export function createProjectPage(
  projectRoot: string,
  input: { title: string; goal?: string; stage?: ProjectStage; tags?: string[]; content?: string },
): { id: string } | null {
  const title = (input.title || '').trim();
  if (!projectRoot || !title) return null;
  ensureLedger(projectRoot);
  const l = layout(projectRoot);
  const now = new Date().toISOString();
  const goal = (input.goal || '').trim();
  const body = (input.content || '').trim() || projectBodyTemplate(goal);
  const id = nextId(l.wikiDir, 'p');
  writeEntryFile(
    join(l.wikiDir, `${id}.md`),
    {
      id,
      kind: 'project',
      title,
      summary: projectSummary(goal, body),
      stage: asStage(input.stage),
      tags: input.tags?.filter(Boolean),
      created: now,
      updated: now,
    },
    body,
  );
  refreshLedgerIndex(projectRoot);
  appendLog(projectRoot, 'project', `create ${id} ${title}`);
  return { id };
}

/** 更新项目页（档案员调用）：只改传入的字段（title / stage / content / tags），created 保留。 */
export function updateProjectPage(
  projectRoot: string,
  input: { id: string; title?: string; stage?: ProjectStage; content?: string; tags?: string[] },
): boolean {
  const cleanId = (input.id || '').trim().replace(/\.md$/, '');
  if (!projectRoot || !/^p-[A-Za-z0-9-]+$/.test(cleanId)) return false;
  ensureLedger(projectRoot);
  const l = layout(projectRoot);
  const file = join(l.wikiDir, `${cleanId}.md`);
  const parsed = readEntryFile(file);
  if (!parsed) return false;
  const now = new Date().toISOString();
  const title = (input.title ?? String(parsed.data.title ?? cleanId)).trim() || cleanId;
  const body = input.content?.trim() ? input.content.trim() : parsed.body;
  writeEntryFile(
    file,
    {
      id: cleanId,
      kind: 'project',
      title,
      summary: projectSummary('', body),
      stage: asStage(input.stage ?? parsed.data.stage),
      tags: (input.tags ?? asStringTags(parsed.data.tags)).filter(Boolean),
      created: (parsed.data.created as string) || now,
      updated: now,
    },
    body,
  );
  refreshLedgerIndex(projectRoot);
  appendLog(projectRoot, 'project', `update ${cleanId} ${title}`);
  return true;
}

/** 材料录入即登记（宿主确定性登记，0 token）：向账本 raw/ 投一条材料条目。
 *  `input.relPath` 是**项目相对路径**（`materials/…`），条目出处按它寻址。
 *  同出处已登记 → 不新增条目（1 份材料始终 1 条 raw）；若 `contentHash` 显示**材料内容已变**
 *  （同路径替换了文件），则刷新该条登记的页数 / 索引质量 / hash，条目 id 与 created 不变。 */
export function registerLedgerMaterial(
  projectRoot: string,
  input: { relPath: string; pageCount?: number; quality?: string; contentHash?: string },
): boolean {
  const relPath = (input.relPath || '').trim();
  if (!projectRoot || !relPath) return false;
  const home = ensureLedger(projectRoot);
  if (!home) return false;
  const l = layout(projectRoot);

  const ext = relPath.includes('.') ? relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase() : '';
  const contentHash = (input.contentHash || '').trim();
  // 立场由材料路径推断（SCHEMA.md 的「当事人与材料分区」段）：推断不出就不写，不猜。
  const side = sideOfPath(readLedgerParties(projectRoot), relPath);
  const bodyOf = (pageCount?: number, quality?: string): string =>
    [
      `【项目材料】${relPath}`,
      `- 类型：${ext || '未知'}`,
      `- 页数：${pageCount ?? '未知'}`,
      `- 索引质量：${quality ?? '未知'}`,
      `- 原文出处：${relPath}（需要原文时读取该文件；本条目只做登记与定位，不复制正文）`,
    ].join('\n');
  const summaryOf = (pageCount?: number): string => `${ext || '文件'}${pageCount ? ` · ${pageCount} 页` : ''}`;

  for (const item of listDir(l.rawDir, 'raw')) {
    if (item.source !== relPath) continue; // 同出处已登记 → 不新增
    const file = join(l.rawDir, `${item.id}.md`);
    const parsed = readEntryFile(file);
    if (!parsed) return true;
    const oldHash = typeof parsed.data.hash === 'string' ? parsed.data.hash : '';
    if (!contentHash || contentHash === oldHash) return true; // 内容未变（或拿不到 hash）→ 不动
    try {
      writeEntryFile(
        file,
        { ...parsed.data, summary: summaryOf(input.pageCount), hash: contentHash, updated: new Date().toISOString(), ...(side ? { side } : {}), origin: 'material' },
        bodyOf(input.pageCount, input.quality),
      );
    } catch {
      return false;
    }
    refreshLedgerIndex(projectRoot);
    appendLog(projectRoot, 'refresh', `${item.id} ${relPath}（材料内容已更新）`);
    // 事实版本锚定（补充条款 14）：引用了这条 raw 的条目，其结论基于**旧版材料** → 标记「需复核」。
    // 复核动作就是更新那条目（recordLedgerEntry/updateProjectPage 会清掉 stale）。
    const marked = markStaleByRaw(projectRoot, item.id, `依据材料内容已变更（${relPath}），需复核`);
    if (marked > 0) {
      refreshLedgerIndex(projectRoot);
      appendLog(projectRoot, 'stale', `${item.id} → ${marked} 个条目待复核（${relPath}）`);
    }
    return true;
  }

  const id = nextId(l.rawDir, 'r');
  try {
    writeEntryFile(
      join(l.rawDir, `${id}.md`),
      {
        id,
        title: `材料 · ${relPath.split('/').pop() || relPath}`,
        summary: summaryOf(input.pageCount),
        source: relPath,
        hash: contentHash || undefined,
        tags: ['材料'],
        created: new Date().toISOString(),
        ...(side ? { side } : {}),
        origin: 'material',
      },
      bodyOf(input.pageCount, input.quality),
    );
  } catch {
    return false;
  }
  refreshLedgerIndex(projectRoot);
  appendLog(projectRoot, 'ingest', `${id} ${relPath}`);
  return true;
}

/** 材料删除/移出项目 → 回收账本 raw 登记（宿主确定性回收，0 token，与 registerLedgerMaterial 对称）。
 *  `relPath` 是**项目相对路径**（`materials/…`）；`isDir` 为真时按前缀回收整棵子树。
 *  **只删 raw，不动 wiki**：引用过被删登记的 wiki 条目保留结论、不静默消失，
 *  其 `raw:` 变为断链 → 由 lintLedger 的断链检查报出，提示档案员复核该结论是否仍成立。
 *  @returns 回收的 raw 条数 */
export function recycleLedgerMaterial(projectRoot: string, relPath: string, isDir: boolean): number {
  const root = (projectRoot || '').trim();
  const target = (relPath || '').trim();
  if (!root || !target) return 0;
  const l = layout(root);
  if (!existsSync(l.rawDir)) return 0;

  let removed = 0;
  for (const item of listDir(l.rawDir, 'raw')) {
    const src = item.source;
    if (!src) continue;
    if (src !== target && !(isDir && src.startsWith(`${target}/`))) continue;
    try {
      rmSync(join(l.rawDir, `${item.id}.md`));
      removed++;
    } catch {
      /* 单条删除失败继续处理其余 */
    }
  }
  if (removed > 0) {
    refreshLedgerIndex(root);
    appendLog(root, 'recycle', `${target} → 回收 ${removed} 条 raw 登记`);
  }
  return removed;
}

/** 材料改名/移动 → 改写账本里记录的出处路径（宿主确定性，0 token）。
 *  raw 登记的 source / 标题 / 正文出处，与已编译 wiki 条目的 source / 正文路径一并跟随迁移；
 *  条目 id 不变（同一份材料仍是同一条登记），因此 wiki 的 `raw:` 引用不受影响。
 *  @returns 改写的账本条目数（raw + wiki） */
export function renameLedgerMaterial(projectRoot: string, relPath: string, newRelPath: string): number {
  const root = (projectRoot || '').trim();
  const from = (relPath || '').trim();
  const to = (newRelPath || '').trim();
  if (!root || !from || !to || from === to) return 0;
  const l = layout(root);
  if (!existsSync(l.home)) return 0;

  /** 旧路径 → 新路径（同路径或同前缀子树命中，否则 null 表示与本材料无关） */
  const mapPath = (src: string): string | null => {
    if (src === from) return to;
    if (src.startsWith(`${from}/`)) return `${to}${src.slice(from.length)}`;
    return null;
  };
  const rewrite = (text: string, oldPath: string, newPath: string): string =>
    oldPath === newPath ? text : text.split(oldPath).join(newPath);

  let touched = 0;
  // raw：出处 source + 标题（材料 · 文件名）+ 正文里的原文出处
  for (const item of listDir(l.rawDir, 'raw')) {
    const file = join(l.rawDir, `${item.id}.md`);
    const parsed = readEntryFile(file);
    if (!parsed || typeof parsed.data.source !== 'string') continue;
    const oldSource = parsed.data.source;
    const newSource = mapPath(oldSource);
    if (!newSource) continue;
    const title = item.title.startsWith('材料 · ')
      ? `材料 · ${newSource.split('/').pop() || newSource}`
      : item.title;
    writeEntryFile(file, { ...parsed.data, title, source: newSource }, rewrite(parsed.body, oldSource, newSource));
    touched++;
  }
  // wiki：出处 source 与正文里引用的路径（正文按目录前缀整体替换，覆盖子路径引用）
  for (const item of listDir(l.wikiDir, 'wiki')) {
    const file = join(l.wikiDir, `${item.id}.md`);
    const parsed = readEntryFile(file);
    if (!parsed) continue;
    const oldSource = typeof parsed.data.source === 'string' ? parsed.data.source : '';
    const newSource = oldSource ? mapPath(oldSource) : null;
    const body = rewrite(parsed.body, from, to);
    if (!newSource && body === parsed.body) continue;
    writeEntryFile(file, { ...parsed.data, ...(newSource ? { source: newSource } : {}) }, body);
    touched++;
  }
  if (touched > 0) {
    refreshLedgerIndex(root);
    appendLog(root, 'rename', `${from} → ${to}（改写 ${touched} 条）`);
  }
  return touched;
}

/* -------------------------------- 自检 -------------------------------- */

/** 裁决式表述（补充条款 11）：模型只做对照分析、不替人取舍——命中即提示改写为对照口径 */
const ADJUDICATE_RE = /本院认为|应予认定|足以认定|明显不成立|显然成立|应当认定为|可以认定/;
/** 立场中文短名（仅用于 lint 提示文案） */
const SIDE_CN: Record<LedgerSide, string> = { ours: '我方', theirs: '对方', neutral: '中立' };

/** 「单侧缺口已显式声明」的标注（补充条款 11 认可的合规解法）：条目正文写明即不再报缺对照。
 *  判定仍只在 sides.size===1 时执行，因此不存在「靠写一句标注掩盖双侧条目」的可能。 */
const SINGLE_SIDE_DECLARED_RE = /仅单侧依据|缺对照/;

/** index.md 里「自检摘要」行的整行前缀：lintLedger 比对「索引与文件一致性」时把这类行剔除——
 *  摘要内容本来就随问题数变化，不是「有人手改索引」的证据。 */
const LINT_SUMMARY_PREFIX = '⚠️ 自检';

/** 机械自检的公共部分（0 token，只做确定性检查）：缺出处 / 重复标题 / 断链 / 待编译积压 /
 *  项目页引用断链 / 疑似越权结论 / 单方论证 / 三源纪律 / 分侧声明未生效 /
 *  类型硬约束（fact 无材料出处、comparison 缺双侧）/ 禁裁决 / 依据材料变更需复核。
 *
 *  **不含**「索引与文件一致性」：那一项要先重生成索引才能比对，而 refreshLedgerIndex 会调用本函数
 *  （索引头要写自检摘要行）——若本函数反过来调 refreshLedgerIndex 就是死循环，故该项留在 lintLedger。 */
function collectLintIssues(projectRoot: string): string[] {
  ensureLedger(projectRoot);
  const l = layout(projectRoot);
  const issues: string[] = [];
  const wiki = listDir(l.wikiDir, 'wiki');
  const raw = listDir(l.rawDir, 'raw');
  const rawIds = new Set(raw.map((r) => r.id));

  // 1) 缺出处（认的出处只有 materials/ 与 homework/：与 R-3 来源标记、SCHEMA 规则 2 同口径；
  //    attachments/ 是节点附件产物，不是项目材料原文，不能充当账本出处）
  const noSourceIds = new Set<string>();
  for (const w of wiki) {
    const parsed = readEntryFile(join(l.wikiDir, `${w.id}.md`));
    const text = `${w.source ?? ''}\n${parsed?.body ?? ''}`;
    if (!/(materials|homework)\//.test(text)) {
      noSourceIds.add(w.id); // 记下：检查 11 对 fact 类型的更严口径不与之重复报
      issues.push(`${w.id}「${w.title}」缺原文出处（front-matter source 或正文里应有 materials/… 、homework/… 路径）`);
    }
  }
  // 2) 重复标题
  const byTitle = new Map<string, string[]>();
  for (const w of wiki) {
    const list = byTitle.get(w.title) ?? [];
    list.push(w.id);
    byTitle.set(w.title, list);
  }
  for (const [title, ids] of byTitle) {
    if (ids.length > 1) issues.push(`重复标题「${title}」：${ids.join('、')}（应归并为一条）`);
  }
  // 3) 断链：wiki 引用的 raw 不存在
  for (const w of wiki) {
    const parsed = readEntryFile(join(l.wikiDir, `${w.id}.md`));
    const v = parsed?.data.raw;
    const list = Array.isArray(v) ? v.map((x) => String(x)) : typeof v === 'string' ? v.split(/[,，\s]+/) : [];
    for (const r of list) {
      if (r && !rawIds.has(r)) issues.push(`${w.id} 引用的登记条目 ${r} 不存在（断链）`);
    }
  }
  // （「索引与文件一致性」不在本函数：它要重生成索引才能比对，见文件末尾 lintLedger）
  // 5) 待编译积压
  const compiled = compiledRawIds(projectRoot);
  const pending = raw.filter((r) => !compiled.has(r.id));
  if (pending.length > 0) issues.push(`待编译登记 ${pending.length} 条：${pending.map((r) => r.id).join('、')}`);

  // 6) 疑似越权结论（补充条款 8）：账本条目可以记结论/约定，但不得与锁定成果块争权威。
  //    这里只做确定性提示：命中成果块体例的确定性等级标签（[确定]/[倾向性]/[存疑]）即提示复核，
  //    文案用「疑似…请复核」——是否越权由人/档案员判断，不在这里判违规。
  const certaintyIds = new Set<string>();
  for (const w of wiki) {
    const parsed = readEntryFile(join(l.wikiDir, `${w.id}.md`));
    const text = parsed?.body ?? '';
    if (CERTAINTY_RE.test(text)) {
      certaintyIds.add(w.id); // 记下：检查 12 的裁决式表述不再对同一条目重复报
      issues.push(`${w.id}「${w.title}」疑似越权结论表述（命中成果块体例的确定性等级标签），请复核是否与锁定成果块冲突`);
    }
  }

  // 7) 项目页引用断链（补充条款 7）：项目页不要求 materials/ 出处，但「知识引用」里点名的
  //    w- 条目与 materials/ 路径必须真实存在——引用得准，是这个页有价值的前提。
  const wikiIds = new Set(wiki.map((w) => w.id));
  for (const p of listDir(l.wikiDir, 'project')) {
    const parsed = readEntryFile(join(l.wikiDir, `${p.id}.md`));
    const body = parsed?.body ?? '';
    const seen = new Set<string>();
    for (const ref of body.match(/\bw-[A-Za-z0-9-]+/g) ?? []) {
      if (seen.has(ref) || wikiIds.has(ref)) continue;
      seen.add(ref);
      issues.push(`${p.id}「${p.title}」引用的条目 ${ref} 不存在（断链）`);
    }
    for (const ref of body.match(/materials\/[^\s`（）()，,、…]+/g) ?? []) {
      if (seen.has(ref) || existsSync(join(projectRoot, ref))) continue;
      seen.add(ref);
      issues.push(`${p.id}「${p.title}」引用的材料 ${ref} 不存在（断链）`);
    }
  }

  // 8) 单方论证（补充条款 11）：仅当项目已声明「当事人与材料分区」时才检查。
  //    对 w- 概览条目（wiki/ 下 p- 项目页不在 wiki 列表内）收集依据路径 → 解析立场集合，
  //    恰好只有单侧（丢弃 null 与 neutral）时提示缺对照。
  const parties = readLedgerParties(projectRoot);
  const rawSourceById = new Map(raw.map((r) => [r.id, r.source]));
  /** 条目依据路径（front-matter 出处 + 正文材料路径 + 所引 raw 登记的材料出处）与正文 */
  const entryInfo = (w: LedgerItem): { refs: string[]; body: string } => {
    const parsed = readEntryFile(join(l.wikiDir, `${w.id}.md`));
    const body = parsed?.body ?? '';
    const refs: string[] = [];
    if (w.source) refs.push(w.source); // front-matter 出处
    refs.push(...(body.match(/materials\/[^\s`（）()，,、…]+/g) ?? [])); // 正文里出现的材料路径
    const rv = parsed?.data.raw;
    const rawRefs = Array.isArray(rv) ? rv.map((x) => String(x)) : typeof rv === 'string' ? rv.split(/[,，\s]+/) : [];
    for (const r of rawRefs) {
      const src = rawSourceById.get(r); // 所依据 raw 登记的材料出处
      if (src) refs.push(src);
    }
    return { refs, body };
  };
  /** 依据路径 → 立场集合（丢弃未归侧 null 与 neutral） */
  const sidesOf = (refs: string[]): Set<LedgerSide> => {
    const sides = new Set<LedgerSide>();
    for (const ref of refs) {
      const s = sideOfPath(parties, ref);
      if (s && s !== 'neutral') sides.add(s);
    }
    return sides;
  };
  if (parties.length > 0) {
    for (const w of wiki) {
      const { refs, body } = entryInfo(w);
      const sides = sidesOf(refs);
      // 已显式标注缺口的条目不再重复告警：标注本身就是补充条款 11 认可的合规解法。
      // （此前提示写「或显式标注缺口」却不认这句标注 → 告警无法通过遵守提示消除。）
      if (sides.size === 1 && !SINGLE_SIDE_DECLARED_RE.test(body)) {
        const side = [...sides][0];
        issues.push(`${w.id}「${w.title}」仅单侧依据（${side}），缺对照：请补另一侧材料或显式标注缺口`);
      }
    }
  }

  // 9) 三源纪律（补充条款 10）：用户陈述不得冒充材料出处且须显式标记；外部信息须带 URL。
  const originEntries = [
    ...wiki.map((w) => ({ item: w, file: join(l.wikiDir, `${w.id}.md`) })),
    ...raw.map((r) => ({ item: r, file: join(l.rawDir, `${r.id}.md`) })),
  ];
  for (const { item, file } of originEntries) {
    if (item.origin !== 'user' && item.origin !== 'external') continue;
    const parsed = readEntryFile(file);
    const body = parsed?.body ?? '';
    const text = `${item.source ?? ''}\n${body}`;
    if (item.origin === 'user') {
      if (/materials\//.test(text)) {
        issues.push(`${item.id}「${item.title}」用户陈述不得冒充材料出处（origin=user 却引用了 materials/ 路径）`);
      }
      if (!body.includes('用户陈述')) {
        issues.push(`${item.id}「${item.title}」用户陈述条目缺少显式标记（正文应写明"据用户陈述"与日期）`);
      }
    } else if (!body.includes('http')) {
      issues.push(`${item.id}「${item.title}」外部信息条目缺少 URL 出处`);
    }
  }

  // 10) 分侧声明未生效（提示性，最多报一条）：声明缺失、或声明目录与已登记材料一个都对不上时，
  //     单方论证检查会**静默空转**——必须让这种"看着装了、实际不生效"的状态显式可见。
  const declaredDirs = parties.flatMap((p) => p.dirs);
  const rawSources = raw.map((r) => r.source).filter((s): s is string => !!s);
  const assignedSources = rawSources.filter((s) => {
    const side = sideOfPath(parties, s);
    return !!side && side !== 'neutral';
  });
  if (parties.length === 0) {
    try {
      const subDirs = readdirSync(join(projectRoot, 'materials'), { withFileTypes: true }).filter((e) => e.isDirectory());
      if (subDirs.length >= 2) {
        issues.push('materials/ 下有多层材料目录但未声明「当事人与材料分区」，无法做双侧对照：请在 .ledger/SCHEMA.md 该段按实际目录声明（去掉示例行首 #）');
      }
    } catch {
      /* materials/ 不存在或不可读 → 跳过 */
    }
  } else if (rawSources.length > 0 && assignedSources.length === 0) {
    issues.push(`「当事人与材料分区」的声明目录（${declaredDirs.join('、') || '空'}）与已登记材料一个都对不上，分侧检查实际未生效：请在 .ledger/SCHEMA.md 按本项目实际材料目录修正`);
  }

  // 11) 条目类型硬约束（补充条款 13）：类型是声明，就得对得上形态。
  //     fact 必须以 materials/ 原始材料为据（比检查 1 更严：homework/ 是本节点产出，不算事实出处；
  //     已被检查 1 报过的条目不再重复报）；comparison 必须有双侧依据（不是单侧陈述）。
  for (const w of wiki) {
    const parsed = readEntryFile(join(l.wikiDir, `${w.id}.md`));
    const body = parsed?.body ?? '';
    if (w.type === 'fact' && !noSourceIds.has(w.id) && !/materials\//.test(`${w.source ?? ''}\n${body}`)) {
      issues.push(`${w.id}「${w.title}」类型为事实（fact）却无 materials/ 出处：事实只能以原始材料为据，homework/ 等本节点产物不算`);
    }
    if (w.type === 'comparison') {
      const sides = sidesOf(entryInfo(w).refs);
      if (parties.length === 0) {
        issues.push(`${w.id}「${w.title}」对比条目无法校验双侧依据：项目尚未声明「当事人与材料分区」`);
      } else if (sides.size < 2) {
        const missing = LEDGER_SIDES.filter((s) => s !== 'neutral' && !sides.has(s)).map((s) => SIDE_CN[s]);
        issues.push(`${w.id}「${w.title}」对比条目缺${missing.join('与')}一侧依据：对比必须双侧并列，不能只列一方`);
      }
    }
  }

  // 12) 禁裁决（补充条款 11）：账本可记对照与分析，不得写成裁判口吻（取舍由人决策）。
  //     检查 6 已就同一条目报过确定性等级标签的，不再重复报。
  for (const w of wiki) {
    if (certaintyIds.has(w.id)) continue;
    const parsed = readEntryFile(join(l.wikiDir, `${w.id}.md`));
    const hit = (parsed?.body ?? '').match(ADJUDICATE_RE);
    if (hit) {
      issues.push(`${w.id}「${w.title}」出现裁决式表述「${hit[0]}」：模型只做对照分析、不替人取舍，请改为双侧对照口径`);
    }
  }

  // 13) 事实版本锚定（补充条款 14）：所依据材料内容已变更 → 该条目标记 stale，须人工复核后更新（更新即自动清除）。
  for (const item of [...wiki, ...listDir(l.wikiDir, 'project')]) {
    if (item.stale !== true) continue;
    issues.push(`${item.id}「${item.title}」所依据材料已变更，需复核${item.staleReason ? `：${item.staleReason}` : ''}（复核后更新该条目即自动清除标记）`);
  }

  // 14-16) 研究取向条目（claim 论断 / evidence 证据卡）：普通案件项目不写这两类即完全不触发。
  const typeById = new Map(wiki.map((w) => [w.id, w.type]));

  // 14) 孤儿证据（补充条款 13）：证据卡脱离论断就没有意义 —— 未指向 claim、指向的 id 不存在、
  //     或指向的不是 claim 类型，都算孤儿；方向（supports/refutes）必填，缺了无从判断它在证明什么。
  for (const w of wiki) {
    if (w.type !== 'evidence') continue;
    if (!w.claim) {
      issues.push(`${w.id}「${w.title}」证据卡未指向论断：请用 ledger_record 的 claim 参数填它所支撑/反驳的 claim 条目 id`);
    } else if (!typeById.has(w.claim)) {
      issues.push(`${w.id}「${w.title}」证据卡指向的论断 ${w.claim} 不存在（孤儿证据）`);
    } else if (typeById.get(w.claim) !== 'claim') {
      issues.push(`${w.id}「${w.title}」证据卡指向的 ${w.claim} 不是论断类型（应为 claim，孤儿证据）`);
    }
    if (!w.points) {
      issues.push(`${w.id}「${w.title}」证据卡未标方向：points 填 supports（支撑）或 refutes（反驳）`);
    }
  }

  // 15) 论断只有单侧证据（研究取向，与检查 8 的分侧纪律同源）：有支撑无反驳（或反之）时须补另一侧。
  const evidenceTally = new Map<string, { supports: number; refutes: number }>();
  for (const w of wiki) {
    if (w.type !== 'evidence' || !w.claim || typeById.get(w.claim) !== 'claim') continue;
    const rec = evidenceTally.get(w.claim) ?? { supports: 0, refutes: 0 };
    if (w.points === 'supports') rec.supports++;
    else if (w.points === 'refutes') rec.refutes++;
    evidenceTally.set(w.claim, rec);
  }
  for (const w of wiki) {
    if (w.type !== 'claim') continue;
    const rec = evidenceTally.get(w.id);
    if (!rec || rec.supports === rec.refutes) continue; // 无证据、或两侧均衡 → 不在这里报
    const only = rec.supports > 0 ? `仅有支撑证据 ${rec.supports} 条、无反证` : `仅有反驳证据 ${rec.refutes} 条、无支撑`;
    issues.push(`${w.id}「${w.title}」论断${only}：请补另一侧证据或显式说明缺口`);
  }

  // 16) 论断长期停在 open（研究取向）：超过阈值仍未见结论的论断要把状态显式往前推，
  //     否则"待验证"会长期挂着而无从区分"还在查"与"忘了查"。
  const CLAIM_OPEN_STALE_DAYS = 30;
  const claimCutoff = Date.now() - CLAIM_OPEN_STALE_DAYS * 86400000;
  for (const w of wiki) {
    if (w.type !== 'claim' || (w.claimStatus ?? 'open') !== 'open') continue;
    const ts = w.updated ? Date.parse(w.updated) : Number.NaN;
    if (!Number.isFinite(ts) || ts > claimCutoff) continue;
    issues.push(`${w.id}「${w.title}」论断停在 open 已超过 ${CLAIM_OPEN_STALE_DAYS} 天：请补证据并把 status 更新为 supported/refuted/unclear`);
  }

  // 顺带：账本目录本身必须可读（statSync 失败视为异常）
  try {
    statSync(l.home);
  } catch {
    issues.push('账本目录不可读');
  }
  return issues;
}

/** 账本机械自检（0 token，只做确定性检查）：collectLintIssues 的全部检查
 *  +「索引与文件一致性」（重生成后比对；比对时剔除自检摘要行）。
 *  返回问题行（人类可读），空数组 = 无问题。 */
export function lintLedger(projectRoot: string): string[] {
  ensureLedger(projectRoot);
  const l = layout(projectRoot);
  // 索引被手改的检测：宿主维护的索引理论上恒等于重生成结果（自检摘要行除外）
  const strip = (s: string): string =>
    s.split('\n').filter((line) => !line.startsWith(LINT_SUMMARY_PREFIX)).join('\n');
  const before = existsSync(l.indexPath) ? strip(readFileSync(l.indexPath, 'utf-8')) : '';
  refreshLedgerIndex(projectRoot);
  const after = existsSync(l.indexPath) ? strip(readFileSync(l.indexPath, 'utf-8')) : '';
  const issues = collectLintIssues(projectRoot);
  if (before && before !== after) {
    issues.unshift('index.md 与条目文件不一致（有人手改过索引？已按条目重新生成）');
  }
  return issues;
}