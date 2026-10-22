/**
 * 整理核心流程 —— 扫描目录 → 抽取首页 → 模型判定 → 规划新名与去向 →（可选）落盘。
 *
 * 两个入口共用，避免两份实现走偏：
 *   - tools/organize/cli.ts                     命令行：预览 / 执行 / 监听
 *   - src/lib/file-organizer/watcher.ts         应用运行期常驻监听（由设置开关驱动）
 */
import { promises as fs } from 'fs';
import { dirname, extname, join } from 'path';

import { extract } from './extract';
import {
  contentHash,
  findEntry,
  forgetEntries,
  readState,
  upsertEntry,
  type OrganizeState,
} from './state';
import {
  PENDING_DIR,
  classifyPage,
  emptyMeta,
  resolveModel,
  reviewPage,
  type ClassifyOptions,
  type FileInsight,
  type PageContent,
  type ResolvedModel,
  type Verdict,
} from './model';
import {
  DEFAULT_NAMING,
  buildTargetName,
  formatVersion,
  listTopics,
  reconcileCorrections,
  resolveVersionIndex,
  reuseExistingTopic,
  safeDirName,
  shouldSkip,
  type Correction,
  type MoveRecord,
  type NamingRule,
} from './naming';

/** 新写入的文件需静置多久才处理（毫秒），避免读到写一半的文件 */
export const SETTLE_MS = 3000;

/** few-shot 注入上限：人工纠正簿只取最近这么多条写进提示词（多了会淹没本次内容） */
const CORRECTION_FEWSHOT = 8;

/** 单个文件的去向规划（尚未落盘） */
export interface Plan {
  from: string;
  targetDir: string;
  targetName: string;
  category: string;
  topic: string;
  version: string;
  /** 判定档：confident=确定 / unsure=存疑 / unknown=无法判断 */
  verdict: Verdict;
  /** 是否经过第二轮复核（首轮存疑才复核） */
  reviewed: boolean;
  /** 判定依据或失败原因（写入日志，供人工复核） */
  note: string;
  modelName: string;
  /** 本次判定的 token 用量（含复核与截断重试，缺失为 0） */
  tokens?: { prompt: number; completion: number; reasoning: number };
  /** 因截断重试的次数 */
  retries?: number;
  /** 内容指纹（用于幂等复用与设置面板的重试） */
  hash?: string;
  /** 本计划是否直接复用了历史判定（没有调模型） */
  cached?: boolean;
  /** 历史判定是「失败」→ 本轮直接短路，不重试模型 */
  shortCircuit?: boolean;
  /** 提取方式（写进内容指纹表，作为失败指纹的一部分） */
  method?: string;
}

/**
 * 主题兜底：判定不出/解析失败时用原文件名当主题。
 * 先剥掉文件名里的日期、版本标识与旧版命名残留，只留核心词，
 * 使兜底结果同样符合当前命名规范。
 */
export function topicFromFileName(name: string): string {
  const base = name
    .slice(0, name.length - extname(name).length)
    // 日期（2026-09-12 / 20260815 / 2026.08.15，连同紧邻的分隔符）
    .replace(/[_\- ]*(19|20)\d{2}[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/g, '')
    // 版本标识（v01 / V2 / 合同v03；要求前面不是拉丁字母，避免误伤 Officev15 这类词）
    .replace(/^v\s*\d{1,2}(?![0-9])/i, '')
    .replace(/([^A-Za-z0-9])v\s*\d{1,2}(?![0-9])/gi, '$1')
    // 中文版本标识（第3版 / 第三版）
    .replace(/[_\- ]*第?\s*[0-9一二三四五六七八九十]+\s*版/g, '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '') // 文件名非法字符
    .replace(/[\s_\-]+/g, '') // 分隔符残留
    .slice(0, 40);
  return base || '未命名';
}

/** 列目录：只要根目录下的普通文件（子文件夹天然不会递归进来） */
export async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !shouldSkip(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * 发现投递箱里「已有的分类目录」——归档结构是长期资产，模型必须先看到它。
 * 排除：隐藏目录、_待处理、以及本工具的产物目录。
 */
export async function discoverExistingCategories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== PENDING_DIR)
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** 文件是否已写入完毕（仅监听模式需要，避免读到写一半的内容） */
async function isSettled(filePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(filePath);
    return Date.now() - st.mtimeMs >= SETTLE_MS;
  } catch {
    return false;
  }
}

/**
 * 规划单个文件的去向（不落盘）。
 *   naming      = 设置里的命名规则（缺省用默认形态）
 *   autoCreate  = 允许模型自创分类（清单都不合适时新建同名子目录）
 *   corrections = 人工纠正 few-shot（最近若干条，注入提示词）
 * 判定分两遍：首轮 confident 直接用；unsure 时带首页内容复核一遍；
 * 两遍都判不出（unknown）才落 _待处理 交人工。
 */
export async function planOne(
  root: string,
  name: string,
  stamp: string,
  categories: readonly string[],
  modelCache: Map<string, ResolvedModel | null>,
  override?: string,
  naming: NamingRule = DEFAULT_NAMING,
  autoCreate = false,
  corrections: readonly Correction[] = [],
  existing: readonly string[] = [],
  state: OrganizeState | null = null,
  topicsByCategory: ReadonlyMap<string, string[]> = new Map(),
): Promise<Plan> {
  const from = join(root, name);
  const ext = extname(name).toLowerCase();
  const hash = await contentHash(from);
  const extracted = await extract(from);
  const method = extracted.method ?? extracted.kind;

  // 幂等短路：同一份内容（指纹一致）已经判过，就直接复用历史结论。
  //   ① 判成功过 → 复用分类/主题/版本，不调模型（省 token，且主题不会漂移）；
  //   ② 判失败过，且失败指纹（提取方式+原因）与这次一样 → 连模型都不必调，直接落 _待处理。
  const prior = hash && state ? findEntry(state, hash) : null;
  if (prior && prior.method === method && prior.failure === '') {
    const targetDir = join(root, safeDirName(prior.category));
    // 主题稳定化：目录里已有同义主题就沿用既有措辞
    const topic = (await reuseExistingTopic(targetDir, prior.topic, naming))
      || prior.topic
      || topicFromFileName(name);
    const versionIndex = await resolveVersionIndex(targetDir, topic, null, naming);
    const targetName = await buildTargetName(targetDir, stamp, topic, ext, versionIndex, naming);
    return {
      from,
      targetDir,
      targetName,
      category: prior.category,
      topic,
      version: formatVersion(versionIndex, naming.padVersion),
      verdict: (prior.verdict as Verdict) || 'confident',
      reviewed: false,
      note: `复用历史判定（内容指纹一致，上次 ${prior.updatedAt.slice(0, 10)}）`,
      modelName: prior.model,
      tokens: { prompt: 0, completion: 0, reasoning: 0 },
      retries: 0,
      hash: hash ?? undefined,
      cached: true,
      method,
    };
  }

  const needVision = extracted.kind === 'image';
  const cacheKey = needVision ? 'vision' : 'text';
  if (!modelCache.has(cacheKey)) modelCache.set(cacheKey, await resolveModel(needVision, override));
  const model = modelCache.get(cacheKey) ?? null;

  let insight: FileInsight | null = null;
  let failure = ''; // 未能判定的原因（未找到模型 / 不支持 / 模型没返回 / 调用出错）
  let reviewed = false;
  const meta = emptyMeta(model?.model ?? ''); // token / 截断重试痕迹（写日志用）
  // 已用主题：让模型优先沿用既有措辞（主题稳定 → 版本累加与去重才能真正生效）
  const topicsHint = existing.flatMap((c) => (topicsByCategory.get(c) ?? []).slice(0, 8)).slice(0, 50);
  if (!model) {
    failure = '未找到可用模型';
  } else if (extracted.kind === 'unsupported') {
    failure = extracted.reason;
  } else {
    const page: PageContent = extracted.kind === 'image'
      ? { kind: 'image', dataUrl: extracted.dataUrl }
      : { kind: 'text', text: extracted.text };
    const opts: ClassifyOptions = { categories, autoCreate, corrections, existing, topics: topicsHint };
    try {
      insight = await classifyPage(model, name, page, opts, meta);
      if (!insight) failure = '模型未返回有效结果';
    } catch (e) {
      failure = `模型调用失败：${(e as Error)?.message || e}`;
    }
    // 首轮存疑 → 带首页内容再复核一遍
    if (insight?.verdict === 'unsure') {
      const first = insight;
      try {
        const second = await reviewPage(model, name, page, first, opts, meta);
        if (second) {
          insight = second;
          reviewed = true;
        }
      } catch (e) {
        failure = `复核失败，沿用初判：${(e as Error)?.message || e}`;
      }
    }
  }

  // 判定可用性：必须给出主题，且判定档不是「无法判断」
  const usable = !!insight && !!insight.topic && insight.verdict !== 'unknown';
  const category = usable ? insight!.category : PENDING_DIR;
  const topic = usable ? insight!.topic : topicFromFileName(name);
  const docVersion = usable ? insight!.version : null;
  const verdict: Verdict = insight?.verdict ?? 'unknown';
  if (!usable && !failure) failure = '模型判定为无法判断';

  // 备注 = 失败原因 + 判定依据（复核过的标注出来）+ 次选分类，写入日志供人工复核
  const evidence = insight ? (reviewed ? `复核·${insight.reason || '—'}` : insight.reason) : '';
  const alt = insight && insight.alternatives.length > 0 ? `次选：${insight.alternatives.join('、')}` : '';
  const note = [failure, meta.note, evidence, alt].filter(Boolean).join('；');

  const targetDir = join(root, safeDirName(category));
  // 主题稳定化：目录里已有同义主题就沿用既有措辞，避免同主题出现多种写法
  const stableTopic = (await reuseExistingTopic(targetDir, topic, naming)) ?? topic;
  const versionIndex = await resolveVersionIndex(targetDir, stableTopic, docVersion, naming);
  const targetName = await buildTargetName(targetDir, stamp, stableTopic, ext, versionIndex, naming);

  return {
    from,
    targetDir,
    targetName,
    category,
    topic: stableTopic,
    version: formatVersion(versionIndex, naming.padVersion),
    verdict,
    reviewed,
    note,
    modelName: model?.model ?? '',
    tokens: meta.tokens,
    retries: meta.retries,
    hash: hash ?? undefined,
    method,
    shortCircuit: !!prior && prior.method === method && prior.failure !== '' && !usable,
  };
}

export interface Planned {
  /** 本轮可整理的规划 */
  plans: Plan[];
  /** 根目录下的候选文件总数（0 = 无可整理文件） */
  total: number;
  /** 因仍在写入而跳过、需稍后重试的文件名 */
  writing: string[];
  /** 本轮识别到的既有分类目录（供调用方注入提示词/展示） */
  existing?: string[];
}

/** 扫描 + 逐文件规划（不落盘）；跑之前先对账人工纠正，把结果作为 few-shot 注入提示词 */
export async function scanAndPlan(opts: {
  root: string;
  categories: readonly string[];
  stamp: string;
  /** 指定模型（p:m），缺省走设置里的任务模型 */
  model?: string;
  /** 是否等待文件写入静置（监听模式需要，手动执行不需要） */
  settle?: boolean;
  /** 命名规则；缺省 = 默认 {版本号}{主题}_{日期} */
  naming?: NamingRule;
  /** 允许模型自创分类（清单都不合适时新建同名子目录）；缺省 false = 严格限定在清单内 */
  autoCreate?: boolean;
}): Promise<Planned> {
  const naming = opts.naming ?? DEFAULT_NAMING;
  // 人工纠正对账（仅在跑整理时做一次）：判错过的主题下次能沿用人工归入的分类
  const corrections = await reconcileCorrections(opts.root, PENDING_DIR, naming)
    .catch(() => [] as Correction[]);
  // 只带当前清单里仍存在的分类（避免提示词里出现已被删掉的历史分类，与枚举规则打架）
  const fewShot = corrections
    .filter((c) => opts.autoCreate === true || opts.categories.includes(c.category))
    .slice(-CORRECTION_FEWSHOT);

  // 既有分类目录：注入提示词要求优先复用；也参与分类名归一（避免同义目录分裂）
  const existing = await discoverExistingCategories(opts.root);
  // 内容指纹表：同一份内容判过就复用，失败过且原因未变就短路（见 planOne）
  const state = await readState(opts.root).catch(() => null);
  // 各分类目录里已用的主题（注入提示词，压制同主题的多种写法）
  const topicsByCategory = new Map<string, string[]>();
  for (const c of existing) {
    topicsByCategory.set(c, await listTopics(join(opts.root, c), naming).catch(() => []));
  }

  const files = await listFiles(opts.root);
  const modelCache = new Map<string, ResolvedModel | null>();
  const plans: Plan[] = [];
  const writing: string[] = [];
  for (const name of files) {
    if (opts.settle && !(await isSettled(join(opts.root, name)))) {
      writing.push(name);
      continue;
    }
    const plan = await planOne(
      opts.root, name, opts.stamp, opts.categories, modelCache, opts.model, naming,
      opts.autoCreate, fewShot, existing, state, topicsByCategory,
    );
    // 已知失败且提取能力未变：不再重复调模型，但也不重复搬动文件（它已经在 _待处理 里）
    if (plan.shortCircuit) continue;
    plans.push(plan);
  }
  return { plans, total: files.length, writing, existing };
}

/** 落盘单个规划：建分类子目录 → 改名移入 → 返回整理日志记录 */
export async function commitPlan(plan: Plan): Promise<MoveRecord> {
  const targetAbs = join(plan.targetDir, plan.targetName);
  await fs.mkdir(plan.targetDir, { recursive: true });
  await fs.rename(plan.from, targetAbs);
  await recordState(plan, targetAbs).catch(() => { /* 记账失败不影响文件已落盘的事实 */ });
  return {
    at: new Date().toISOString(),
    from: plan.from,
    to: targetAbs,
    category: plan.category,
    topic: plan.topic,
    version: plan.version,
    verdict: plan.verdict,
    note: plan.note,
    model: plan.modelName,
    tokens: plan.tokens,
    retries: plan.retries,
  };
}

/* ==================== 状态记账 / 人工重试 ==================== */

/** 把一次判定结果写进内容指纹表（供幂等复用与设置面板展示） */
export async function recordState(plan: Plan, targetAbs: string): Promise<void> {
  if (!plan.hash) return;
  const root = dirname(plan.targetDir);
  await upsertEntry(root, {
    hash: plan.hash,
    category: plan.category,
    topic: plan.topic,
    version: plan.version,
    verdict: plan.verdict,
    failure: plan.category === PENDING_DIR ? plan.note || '判定失败' : '',
    usable: plan.category !== PENDING_DIR,
    lastPath: targetAbs,
    model: plan.modelName,
    method: plan.method,
  });
}

/**
 * 人工重试：清掉指定文件（或全部失败项）的内容指纹，让下一轮 watcher 重新判定。
 * 返回被清除的指纹数。
 */
export async function retryFile(root: string, filePath?: string): Promise<number> {
  const state = await readState(root);
  if (!filePath) {
    return forgetEntries(root, state.entries.filter((e) => !e.usable).map((e) => e.hash));
  }
  const hash = await contentHash(filePath);
  if (hash) return forgetEntries(root, [hash]);
  // 文件已经不在原地（可能被移动过）：按路径匹配兜底
  return forgetEntries(root, state.entries.filter((e) => e.lastPath === filePath).map((e) => e.hash));
}
