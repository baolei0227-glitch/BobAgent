/**
 * 整理核心流程 —— 扫描目录 → 抽取首页 → 模型判定 → 规划新名与去向 →（可选）落盘。
 *
 * 两个入口共用，避免两份实现走偏：
 *   - tools/organize/cli.ts                     命令行：预览 / 执行 / 监听
 *   - src/lib/file-organizer/watcher.ts         应用运行期常驻监听（由设置开关驱动）
 */
import { promises as fs } from 'fs';
import { extname, join } from 'path';

import { extract } from './extract';
import {
  PENDING_DIR,
  classifyPage,
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
  reconcileCorrections,
  resolveVersionIndex,
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
): Promise<Plan> {
  const from = join(root, name);
  const ext = extname(name).toLowerCase();
  const extracted = await extract(from);

  const needVision = extracted.kind === 'image';
  const cacheKey = needVision ? 'vision' : 'text';
  if (!modelCache.has(cacheKey)) modelCache.set(cacheKey, await resolveModel(needVision, override));
  const model = modelCache.get(cacheKey) ?? null;

  let insight: FileInsight | null = null;
  let failure = ''; // 未能判定的原因（未找到模型 / 不支持 / 模型没返回 / 调用出错）
  let reviewed = false;
  if (!model) {
    failure = '未找到可用模型';
  } else if (extracted.kind === 'unsupported') {
    failure = extracted.reason;
  } else {
    const page: PageContent = extracted.kind === 'image'
      ? { kind: 'image', dataUrl: extracted.dataUrl }
      : { kind: 'text', text: extracted.text };
    const opts: ClassifyOptions = { categories, autoCreate, corrections };
    try {
      insight = await classifyPage(model, name, page, opts);
      if (!insight) failure = '模型未返回有效结果';
    } catch (e) {
      failure = `模型调用失败：${(e as Error)?.message || e}`;
    }
    // 首轮存疑 → 带首页内容再复核一遍
    if (insight?.verdict === 'unsure') {
      const first = insight;
      try {
        const second = await reviewPage(model, name, page, first, opts);
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
  const note = [failure, evidence, alt].filter(Boolean).join('；');

  const targetDir = join(root, safeDirName(category));
  const versionIndex = await resolveVersionIndex(targetDir, topic, docVersion, naming);
  const targetName = await buildTargetName(targetDir, stamp, topic, ext, versionIndex, naming);

  return {
    from,
    targetDir,
    targetName,
    category,
    topic,
    version: formatVersion(versionIndex, naming.padVersion),
    verdict,
    reviewed,
    note,
    modelName: model?.model ?? '',
  };
}

export interface Planned {
  /** 本轮可整理的规划 */
  plans: Plan[];
  /** 根目录下的候选文件总数（0 = 无可整理文件） */
  total: number;
  /** 因仍在写入而跳过、需稍后重试的文件名 */
  writing: string[];
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

  const files = await listFiles(opts.root);
  const modelCache = new Map<string, ResolvedModel | null>();
  const plans: Plan[] = [];
  const writing: string[] = [];
  for (const name of files) {
    if (opts.settle && !(await isSettled(join(opts.root, name)))) {
      writing.push(name);
      continue;
    }
    plans.push(await planOne(
      opts.root, name, opts.stamp, opts.categories, modelCache, opts.model, naming,
      opts.autoCreate, fewShot,
    ));
  }
  return { plans, total: files.length, writing };
}

/** 落盘单个规划：建分类子目录 → 改名移入 → 返回整理日志记录 */
export async function commitPlan(plan: Plan): Promise<MoveRecord> {
  const targetAbs = join(plan.targetDir, plan.targetName);
  await fs.mkdir(plan.targetDir, { recursive: true });
  await fs.rename(plan.from, targetAbs);
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
  };
}
