/**
 * 命名与落盘规则 —— 全部确定性逻辑，不经过模型。
 *
 * 命名形态由「受控选项」规则决定（见 @/lib/file-organizer/naming-rule）：
 *   字段顺序（版本号 / 主题 / 日期）× 分隔符 × 版本号补零位数，
 *   默认 {版本号}{主题}_{日期}.{扩展名}   如 v01房屋租赁合同_2026-09-12.pdf
 *   版本号 = 同主题既有文件的最大序号 +1（新主题首份若文档自带版本标识则采纳）
 *   主题   = 模型输出，已清理非法字符
 *   日期   = 执行整理的当天（本地时区），由代码填
 *
 * 拼名与反解共用同一份规则（composeName / parseName），改规则不会让版本累加失效。
 */
import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import { basename, extname, join } from 'path';

import {
  DEFAULT_NAMING,
  composeName,
  parseName,
  type NamingRule,
} from '@/lib/file-organizer/naming-rule';
// 判定档由模型层定义（type-only 引入，编译后不产生依赖）
import type { Verdict } from './model';

export {
  DEFAULT_NAMING,
  formatVersion,
  normalizeNaming,
  previewName,
  todayStamp,
  type NameSlot,
  type NamingRule,
} from '@/lib/file-organizer/naming-rule';

/** 整理日志文件名（放在被整理目录根部，供 --undo 回滚）；前缀点 = 默认隐藏，不在文件夹里露出 */
export const LOG_NAME = '.整理日志.json';

/** 旧版日志文件名（无隐藏前缀）；仅用于兼容读取历史日志 */
export const LEGACY_LOG_NAME = '_整理日志.json';

/** 人工纠正簿文件名（放投递箱根部）；前缀点 = 默认隐藏 */
export const CORRECTION_NAME = '.整理纠正.json';

/** 纠正簿最多保留的条数（规划时只取最近若干条作 few-shot） */
const CORRECTION_LIMIT = 30;

export interface MoveRecord {
  at: string;
  from: string;
  to: string;
  category: string;
  topic: string;
  version: string;
  /** 判定档：落 _待处理 的记录通常为 unsure / unknown */
  verdict: Verdict;
  /** 判定依据或失败原因（供人工复核） */
  note: string;
  model: string;
  /** token 用量（含复核与截断重试；老日志无此字段） */
  tokens?: { prompt: number; completion: number; reasoning: number };
  /** 因截断重试的次数 */
  retries?: number;
}

export interface OrganizeLog {
  version: 1;
  entries: MoveRecord[];
}

/** 主题归一：去空白与常见噪音后缀，用于「同一份文件」的近似判定 */
function topicKey(topic: string): string {
  return topic
    .replace(/[\s·・\-_（）()【】\[\]]/g, '')
    .replace(/(最终版|最新版|修订版|扫描件|副本|复印件|电子版|版本)$/g, '')
    .toLowerCase();
}

/** 归一后相似度（按较长的串做 LCS 比例：抗 OCR 丢字/多字） */
function similarTopic(a: string, b: string): boolean {
  const x = topicKey(a);
  const y = topicKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 互为前缀（「财产分配债权人账户信息」vs「…信息表」）也视为同一主题
  if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
  const [long, short] = x.length >= y.length ? [x, y] : [y, x];
  if (short.length < 4) return false;
  // 最长公共子序列长度 / 长串长度 ≥ 0.85 视为同主题
  const dp = new Array<number>(short.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= long.length; i++) {
    let prev = 0;
    for (let j = 1; j <= short.length; j++) {
      const cur = dp[j];
      dp[j] = long[i - 1] === short[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = cur;
    }
  }
  best = dp[short.length];
  return best / long.length >= 0.85;
}

/** 目录内已用主题清单（去重、保序、限量）：注入提示词让模型优先沿用既有措辞 */
export async function listTopics(
  dir: string,
  rule: NamingRule = DEFAULT_NAMING,
  limit = 30,
): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of entries) {
    const topic = parseName(name.slice(0, name.length - extname(name).length), rule)?.topic;
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    out.push(topic);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 主题稳定化：模型对同一份内容可能给出近似但不一致的主题
 * （「主播合作保密协议」/「商业秘密保密协议」这类同义改写，或 OCR 多字少字），
 * 而版本累加依赖主题一致。这里在目标目录里找「已经存在的同主题」，
 * 命中就沿用既有措辞——同一主题在目录里只有一个写法，文件名不会越攒越乱。
 * 返回 null = 目录里没有可复用的同主题（首次归档，采用模型给的新主题）。
 */
export async function reuseExistingTopic(
  dir: string,
  topic: string,
  rule: NamingRule = DEFAULT_NAMING,
): Promise<string | null> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const topics = entries
    .map((name) => parseName(name.slice(0, name.length - extname(name).length), rule)?.topic)
    .filter((t): t is string => !!t);
  if (topics.includes(topic)) return null; // 已有完全同名：无需改写
  return topics.find((t) => similarTopic(t, topic)) ?? null;
}

/**
 * 计算版本号序号：
 *   1) 目录内同主题既有文件的最大序号 +1；
 *   2) 主题精确匹配优先；一个都没命中时，退一步用「同目录内近似主题」匹配
 *      （模型/OCR 让主题抖一两个字时，版本号不会重置成 v01）；
 *   3) 若为同主题首份（序号 1）且文档自带版本标识，采纳文档标识；
 *   4) 其余情况用序号。
 * 只认当前命名规则的文件名——改规则后旧名文件不再计入同主题。
 */
export async function resolveVersionIndex(
  dir: string,
  topic: string,
  docVersion: string | null,
  rule: NamingRule = DEFAULT_NAMING,
): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    /* 目录不可读按空处理 */
  }
  const parsedList = entries
    .map((name) => parseName(name.slice(0, name.length - extname(name).length), rule))
    .filter((p): p is NonNullable<typeof p> => !!p);

  let exact = 0;
  for (const p of parsedList) {
    if (p.topic === topic) exact = Math.max(exact, p.version);
  }
  let max = exact;
  if (max === 0) {
    for (const p of parsedList) {
      if (similarTopic(p.topic, topic)) max = Math.max(max, p.version);
    }
  }

  const next = max + 1;
  if (next === 1 && docVersion) {
    const n = Number(docVersion.replace(/\D/g, ''));
    if (n > 0) return n;
  }
  return next;
}

/** 组装文件名（含重名兜底：同主题同版本已存在时给主题追加 -2/-3） */
export async function buildTargetName(
  dir: string,
  stamp: string,
  topic: string,
  ext: string,
  versionIndex: number,
  rule: NamingRule = DEFAULT_NAMING,
): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const suffix = i === 1 ? '' : `-${i}`;
    const name = `${composeName(rule, stamp, `${topic}${suffix}`, versionIndex)}${ext}`;
    try {
      await fs.access(join(dir, name));
    } catch {
      return name; // 不存在 → 可用
    }
  }
  throw new Error(`重名过多，无法为「${topic}」分配文件名`);
}

/** 分类子目录名安全化（分类来自枚举，此处仅兜底） */
export function safeDirName(name: string): string {
  return name.replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '').trim() || '其他';
}

/* ==================== 整理日志（回滚依据） ==================== */

/** 读取日志原文：优先新文件名，缺失时回退旧文件名（历史日志兼容） */
async function readLogRaw(root: string): Promise<OrganizeLog | null> {
  for (const name of [LOG_NAME, LEGACY_LOG_NAME]) {
    let raw: string;
    try {
      raw = await fs.readFile(join(root, name), 'utf-8');
    } catch {
      continue; // 该文件名不存在 → 试下一个
    }
    try {
      const parsed = JSON.parse(raw) as OrganizeLog;
      return Array.isArray(parsed?.entries) ? { version: 1, entries: parsed.entries } : { version: 1, entries: [] };
    } catch {
      return { version: 1, entries: [] }; // 文件在但内容损坏 → 不再回退旧文件，避免复活陈旧记录
    }
  }
  return null;
}

/** 新旧日志已合并落盘后，删掉旧文件，避免文件夹里残留两份 */
async function removeLegacyLog(root: string): Promise<void> {
  try {
    await fs.unlink(join(root, LEGACY_LOG_NAME));
  } catch {
    /* 旧文件不存在则忽略 */
  }
}

export async function readLog(root: string): Promise<OrganizeLog> {
  return (await readLogRaw(root)) ?? { version: 1, entries: [] };
}

export async function appendLog(root: string, records: MoveRecord[]): Promise<void> {
  if (records.length === 0) return;
  const log = await readLog(root);
  log.entries.push(...records);
  await fs.writeFile(join(root, LOG_NAME), JSON.stringify(log, null, 2), 'utf-8');
  await removeLegacyLog(root); // 历史记录已并入新文件
}

/**
 * 按日志回滚：倒序把文件移回原位。
 * 原位已有同名文件则跳过（不覆盖任何东西），返回「已回滚 / 跳过」数量。
 */
export async function undo(root: string): Promise<{ restored: number; skipped: number }> {
  const log = await readLog(root);
  let restored = 0;
  let skipped = 0;
  const remain: MoveRecord[] = [];
  for (const rec of [...log.entries].reverse()) {
    try {
      await fs.access(rec.from); // 原位已被占用 → 跳过
      remain.push(rec);
      skipped++;
      continue;
    } catch {
      /* 原位空闲，可回滚 */
    }
    try {
      await fs.rename(rec.to, rec.from);
      restored++;
    } catch {
      remain.push(rec);
      skipped++;
    }
  }
  await fs.writeFile(
    join(root, LOG_NAME),
    JSON.stringify({ version: 1, entries: remain.reverse() } satisfies OrganizeLog, null, 2),
    'utf-8',
  );
  await removeLegacyLog(root); // 回滚结果已写入新文件
  return { restored, skipped };
}

/* ==================== 人工纠正（few-shot 依据） ==================== */

/** 人工纠正记录：被模型判为待处理的文件，后来出现在某个正常分类目录 → 视为人工归位 */
export interface Correction {
  /** 主题（沿用整理日志里的 topic） */
  topic: string;
  /** 人工归入的分类目录名 */
  category: string;
  /** 归位后的文件名（不含扩展名，便于核对） */
  file: string;
  at: string;
}

export interface CorrectionBook {
  version: 1;
  entries: Correction[];
}

/** 读取纠正簿（不存在/损坏 → 空） */
export async function readCorrections(root: string): Promise<Correction[]> {
  try {
    const raw = await fs.readFile(join(root, CORRECTION_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as CorrectionBook;
    return Array.isArray(parsed?.entries) ? parsed.entries.filter((c) => c?.topic && c?.category) : [];
  } catch {
    return [];
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 对账人工纠正（仅在跑整理时调用一次，不做常驻监听）：
 * 整理日志里判为 pendingDir 的记录，若其主题 / 原文件名如今出现在某个正常分类目录里，
 * 且原文件已不在 pendingDir，即视为用户手动归位 → 记入纠正簿，供下次规划做 few-shot。
 * 返回合并后的完整纠正簿（去重、按最近保留上限截断）。
 */
export async function reconcileCorrections(
  root: string,
  pendingDir: string,
  rule: NamingRule = DEFAULT_NAMING,
): Promise<Correction[]> {
  const stored = await readCorrections(root);
  const log = await readLog(root);
  const pendings = log.entries.filter((e) => e.category === pendingDir && e.topic);
  if (pendings.length === 0) return stored;

  // 分类目录内现存文件 → 「主题 / 原文件名」到分类 的索引
  let dirs: Dirent[] = [];
  try {
    dirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return stored;
  }
  const byTopic = new Map<string, string>();
  const byBase = new Map<string, string>();
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === pendingDir) continue;
    for (const f of await fs.readdir(join(root, d.name)).catch(() => [] as string[])) {
      const base = f.slice(0, f.length - extname(f).length);
      byBase.set(base, d.name);
      const parsed = parseName(base, rule);
      if (parsed?.topic) byTopic.set(parsed.topic, d.name);
    }
  }

  const seen = new Set(stored.map((c) => `${c.topic}\u0000${c.category}`));
  const fresh: Correction[] = [];
  for (const rec of pendings) {
    const base = basename(rec.to).replace(/\.[^.]+$/, '');
    const category = byTopic.get(rec.topic) ?? byBase.get(base);
    if (!category) continue;
    if (await exists(rec.to)) continue; // 原文件还在 _待处理 里 → 用户尚未归位
    const key = `${rec.topic}\u0000${category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ topic: rec.topic, category, file: base, at: new Date().toISOString() });
  }
  if (fresh.length === 0) return stored;

  // 同主题只留最近一条（用户可能改过归入的分类，新旧两条会互相打架）
  const latest = new Map<string, Correction>();
  for (const c of [...stored, ...fresh]) {
    latest.delete(c.topic);
    latest.set(c.topic, c);
  }
  const merged = [...latest.values()].slice(-CORRECTION_LIMIT);
  try {
    await fs.writeFile(
      join(root, CORRECTION_NAME),
      JSON.stringify({ version: 1, entries: merged } satisfies CorrectionBook, null, 2),
      'utf-8',
    );
  } catch {
    /* 写入失败不阻塞整理，本次仍按内存结果做 few-shot */
  }
  return merged;
}

/** 是否应当跳过（隐藏文件、日志、本工具产物） */
export function shouldSkip(name: string): boolean {
  return name.startsWith('.') || name === LOG_NAME || name === LEGACY_LOG_NAME || name === 'node_modules';
}
