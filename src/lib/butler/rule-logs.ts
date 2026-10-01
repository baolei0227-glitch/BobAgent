/**
 * lib/butler/rule-logs.ts —— 规则的**从属日志**存储（server-only）
 *
 * 依据：BobWork 轻量化管家方案 v6 §3.1（规则本体与运行数据是「两种访问形态、两种形状」）、
 * §7（信号闭环）、§10.2 Phase 1（hits / output_edited / user_dismissed 落盘）。
 *
 * 落点：`<APP_ROOT>/butler/.rules/.logs/<type>/<key>.jsonl`
 *   - 与规则本体（`.rules/<id>.md`）**同根并存**：`listRules()` 只认 `.md` 且匹配 RULE_ID_RE，
 *     `.logs` 目录名不会被误读为规则。
 *   - 日志高频、只追加、不需确认 → 按 key 分片成 JSONL，**一条一文件会产出孤儿且带来并发写冲突**。
 *   - 每片保留最近 MAX_LINES_PER_SHARD 行（写入后超限截断），避免无限增长。
 *
 * 依赖刻意收敛：只依赖 ./storage（其自身零内部依赖），**不 import rules.ts**（避免环；
 * 本模块不需要规则类型，只需要路径原语）。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { butlerRoot, ensureDir } from './storage';

/** 规则集目录名（与 rules.ts 同口径的点前缀；此处不 import 以免成环） */
const RULES_DIR_NAME = '.rules';
/** 从属日志目录名（在规则集旁） */
const LOGS_DIR_NAME = '.logs';
/** 每片保留的最近行数上限 */
const MAX_LINES_PER_SHARD = 200;

/** 从属日志类型（各自独立分片目录） */
export type RuleLogType =
  | 'hits'                // 分片键 规则 id / 技能 id（Skills 复用同一信号写口，Phase 3 §3.8）；{at, scene, rule_version, producedRef?}
  | 'output_edited'       // 分片键 rule_id；{at, rule_version, diff, stepFieldMap?}
  | 'rule_violated'       // 分片键 rule_id；{at, rule_version, detail}
  | 'user_dismissed'      // 分片键 rule_id；{at, rule_version, source}
  | 'conflict-resolution' // 分片键 `a__b`（两条规则 id 的有序对）；{at, inputFeature, chosen, versions}
  | 'skill_failure'       // 分片键 skill_id；{at, rule_version, reason?}——技能执行失败（隔离判据原料）
  | 'negative-sample';    // 分片键 object_type；{at, pattern, action}

/** 所有日志条目的公共字段 */
export interface RuleLogEntry {
  /** 写入时刻（ISO 8601；由 appendRuleLog 自动补齐，调用方通常不传） */
  at: string;
}

export interface HitEntry extends RuleLogEntry {
  scene: string;
  rule_version: number;
  /** 产出对象引用（如待办 event_id）；供 output_edited 归因 */
  producedRef?: string;
  /**
   * 定时候选：本次执行对应的**实例时刻（ms）**；语面命中的 hits 不带此字段。
   * 供 rule-timer 幂等去重（同一实例已执行过则不再产候选）。
   */
  occurrence?: number;
}

export interface OutputEditedEntry extends RuleLogEntry {
  rule_version: number;
  diff: string;
  stepFieldMap?: Record<string, string>;
}

export interface RuleViolatedEntry extends RuleLogEntry {
  rule_version: number;
  detail: string;
}

export interface UserDismissedEntry extends RuleLogEntry {
  rule_version: number;
  /** 否定来源（如 rule_dismiss / draft_denied） */
  source: string;
}

export interface ConflictResolutionEntry extends RuleLogEntry {
  inputFeature: string;
  chosen: string;
  versions: [number, number];
}

/** 技能执行失败（Phase 3 §3.8）：连续失败达阈值即自动隔离（quarantine） */
export interface SkillFailureEntry extends RuleLogEntry {
  rule_version: number;
  /** 失败原因（可读；如执行器回报的中文文案） */
  reason?: string;
}

/**
 * 负样本类（v6 §3.4 / Q11）：两类**共用展示通道、不共用负样本**。
 *   - signal_mismatch：「我把信号理解错了」→ 不该走某条**已有**规则 → 压制 near-miss 询问
 *   - not_a_habit     ：「这次的行为不是习惯」→ 不该固化成新规则 → 压制固化提议
 * Phase 1 旧记录无此字段，读侧按 signal_mismatch 兼容（见 rule-signals）。
 */
export type NegativeSampleClass = 'signal_mismatch' | 'not_a_habit';

export interface NegativeSampleEntry extends RuleLogEntry {
  pattern: string;
  action: string;
  /** 负样本类；缺省（旧记录）语义 = signal_mismatch */
  class?: NegativeSampleClass;
}

/** 日志根目录：<APP_ROOT>/butler/.rules/.logs */
export function logsRoot(): string {
  return join(butlerRoot(), RULES_DIR_NAME, LOGS_DIR_NAME);
}

/** 某类型的日志目录：<logsRoot>/<type> */
function logTypeDir(type: RuleLogType): string {
  return join(logsRoot(), type);
}

/**
 * key 白名单清洗：只保留 `[A-Za-z0-9_-]`（`_` 天然涵盖 `__` 分隔符），其余替换为 `_`。
 * 目的：防目录穿越（`/`、`..`）与非法路径字符。结果为空 → 调用方视为非法 key。
 */
function sanitizeKey(key: string): string {
  return (typeof key === 'string' ? key : '').replace(/[^A-Za-z0-9_-]/g, '_');
}

/** 分片文件路径；key 清洗后为空 → null（非法 key，不落盘） */
function shardPath(type: RuleLogType, key: string): string | null {
  const k = sanitizeKey(key);
  if (!k) return null;
  return join(logTypeDir(type), `${k}.jsonl`);
}

/** 日志写串行化：append + 超限截断构成读-改-写临界区，串行避免互相覆盖（照抄 storage.ts 的锁法） */
let _logLock: Promise<void> = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _logLock;
  let release: () => void = () => {};
  _logLock = (async () => {
    if (prev) await prev;
    await new Promise<void>((res) => { release = res; });
  })();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 解析 JSONL：坏行跳过（脏数据不阻断，同 parseRule 原则） */
function parseLines<T>(raw: string): T[] {
  const entries: T[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) entries.push(v as T);
    } catch { /* 坏行跳过 */ }
  }
  return entries;
}

/** 读取一个分片文件；不存在 / 非法 key → [] */
async function readShard<T>(type: RuleLogType, key: string): Promise<T[]> {
  const file = shardPath(type, key);
  if (!file) return [];
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return [];
  }
  return parseLines<T>(raw);
}

/** 写入后超限截断：保留最近 MAX_LINES_PER_SHARD 行（原子写，避免半截文件） */
async function truncateIfNeeded(file: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return;
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length <= MAX_LINES_PER_SHARD) return;
  const kept = lines.slice(-MAX_LINES_PER_SHARD).join('\n') + '\n';
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, kept, 'utf-8');
  await fs.rename(tmp, file);
}

/**
 * 追加一行日志（自动补 `at` 时间戳）。
 * 追加语义：单行 JSONL 追加不重写；超上限时截断旧行。
 */
export async function appendRuleLog(
  type: RuleLogType,
  key: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const file = shardPath(type, key);
  if (!file) throw new Error('rule log key is required');
  const record: Record<string, unknown> = { ...entry };
  if (typeof record.at !== 'string' || !record.at) record.at = new Date().toISOString();
  const line = `${JSON.stringify(record)}\n`;

  await withLock(async () => {
    await ensureDir(logTypeDir(type));
    await fs.appendFile(file, line, 'utf-8');
    await truncateIfNeeded(file);
  });
}

/**
 * 读取一个分片的日志（时间升序，即写入顺序）。
 * `limit` 指定时返回**最近** limit 条（仍按升序）。
 */
export async function readRuleLog<T = RuleLogEntry>(
  type: RuleLogType,
  key: string,
  limit?: number,
): Promise<T[]> {
  const entries = await readShard<T>(type, key);
  if (typeof limit === 'number' && limit >= 0 && entries.length > limit) {
    return entries.slice(entries.length - limit);
  }
  return entries;
}

/** 列出某类型下全部分片键（升序） */
export async function listRuleLogKeys(type: RuleLogType): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(logTypeDir(type));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => n.slice(0, -'.jsonl'.length))
    .filter(Boolean)
    .sort();
}

/**
 * 命中窗口（供修订判据）：返回最近 window 次 hits，以及**落在该窗口时间范围内**的 user_dismissed。
 * 窗口起点取窗口内最早一次命中的 `at`；此前发生的否定不属于本窗口，不计入。
 */
export async function readHitWindow(
  ruleId: string,
  window: number,
): Promise<{ hits: HitEntry[]; dismissed: UserDismissedEntry[] }> {
  const hits = await readRuleLog<HitEntry>('hits', ruleId, window);
  if (hits.length === 0) return { hits, dismissed: [] };
  const startAt = hits[0].at;
  const allDismissed = await readRuleLog<UserDismissedEntry>('user_dismissed', ruleId);
  const dismissed = allDismissed.filter((d) => typeof d.at === 'string' && d.at >= startAt);
  return { hits, dismissed };
}

/** 反查：某产出对象（如待办 event_id）由哪条规则产出（供 output_edited 归因） */
export async function findRuleByProducedRef(ref: string): Promise<string | null> {
  if (!ref) return null;
  const keys = await listRuleLogKeys('hits');
  let found: { ruleId: string; at: string } | null = null;
  for (const ruleId of keys) {
    const entries = await readRuleLog<HitEntry>('hits', ruleId);
    for (const e of entries) {
      if (e.producedRef !== ref) continue;
      const at = typeof e.at === 'string' ? e.at : '';
      if (!found || at >= found.at) found = { ruleId, at };
    }
  }
  return found ? found.ruleId : null;
}