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
  LOW_CONFIDENCE,
  PENDING_DIR,
  classifyImage,
  classifyText,
  resolveModel,
  type FileInsight,
  type ResolvedModel,
} from './model';
import {
  DEFAULT_NAMING,
  buildTargetName,
  formatVersion,
  resolveVersionIndex,
  safeDirName,
  shouldSkip,
  type MoveRecord,
  type NamingRule,
} from './naming';

/** 新写入的文件需静置多久才处理（毫秒），避免读到写一半的文件 */
export const SETTLE_MS = 3000;

/** 单个文件的去向规划（尚未落盘） */
export interface Plan {
  from: string;
  targetDir: string;
  targetName: string;
  category: string;
  topic: string;
  version: string;
  confidence: number;
  modelName: string;
  note: string;
}

/**
 * 主题兜底：解析失败/低置信度时用原文件名当主题。
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

/** 规划单个文件的去向（不落盘）；naming = 设置里的命名规则（缺省用默认形态） */
export async function planOne(
  root: string,
  name: string,
  stamp: string,
  categories: readonly string[],
  modelCache: Map<string, ResolvedModel | null>,
  override?: string,
  naming: NamingRule = DEFAULT_NAMING,
): Promise<Plan> {
  const from = join(root, name);
  const ext = extname(name).toLowerCase();
  const extracted = await extract(from);

  const needVision = extracted.kind === 'image';
  const cacheKey = needVision ? 'vision' : 'text';
  if (!modelCache.has(cacheKey)) modelCache.set(cacheKey, await resolveModel(needVision, override));
  const model = modelCache.get(cacheKey) ?? null;

  let insight: FileInsight | null = null;
  let note = '';
  if (!model) {
    note = '未找到可用模型';
  } else if (extracted.kind === 'unsupported') {
    note = extracted.reason;
  } else {
    try {
      insight = extracted.kind === 'image'
        ? await classifyImage(model, name, extracted.dataUrl, categories)
        : await classifyText(model, name, extracted.text, categories);
      if (!insight) note = '模型未返回有效结果';
    } catch (e) {
      note = `模型调用失败：${(e as Error)?.message || e}`;
    }
  }

  // 低置信度或识别失败 → 落 _待处理，交由人工
  const usable = !!insight && !!insight.topic && insight.confidence >= LOW_CONFIDENCE;
  const category = usable ? insight!.category : PENDING_DIR;
  const topic = usable ? insight!.topic : topicFromFileName(name);
  const docVersion = usable ? insight!.version : null;
  const confidence = insight?.confidence ?? 0;

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
    confidence,
    modelName: model?.model ?? '',
    note,
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

/** 扫描 + 逐文件规划（不落盘） */
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
}): Promise<Planned> {
  const files = await listFiles(opts.root);
  const modelCache = new Map<string, ResolvedModel | null>();
  const plans: Plan[] = [];
  const writing: string[] = [];
  for (const name of files) {
    if (opts.settle && !(await isSettled(join(opts.root, name)))) {
      writing.push(name);
      continue;
    }
    plans.push(await planOne(opts.root, name, opts.stamp, opts.categories, modelCache, opts.model, opts.naming));
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
    confidence: plan.confidence,
    model: plan.modelName,
  };
}
