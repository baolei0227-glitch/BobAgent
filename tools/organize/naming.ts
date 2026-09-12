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
import { extname, join } from 'path';

import {
  DEFAULT_NAMING,
  composeName,
  parseName,
  type NamingRule,
} from '@/lib/file-organizer/naming-rule';

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

export interface MoveRecord {
  at: string;
  from: string;
  to: string;
  category: string;
  topic: string;
  version: string;
  confidence: number;
  model: string;
}

export interface OrganizeLog {
  version: 1;
  entries: MoveRecord[];
}

/**
 * 计算版本号序号：
 *   1) 目录内同主题既有文件的最大序号 +1；
 *   2) 若为同主题首份（序号 1）且文档自带版本标识，采纳文档标识；
 *   3) 其余情况用序号。
 * 只认当前命名规则的文件名——改规则后旧名文件不再计入同主题。
 */
export async function resolveVersionIndex(
  dir: string,
  topic: string,
  docVersion: string | null,
  rule: NamingRule = DEFAULT_NAMING,
): Promise<number> {
  let max = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    /* 目录不可读按空处理 */
  }
  for (const name of entries) {
    const parsed = parseName(name.slice(0, name.length - extname(name).length), rule);
    if (parsed && parsed.topic === topic) max = Math.max(max, parsed.version);
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

/** 是否应当跳过（隐藏文件、日志、本工具产物） */
export function shouldSkip(name: string): boolean {
  return name.startsWith('.') || name === LOG_NAME || name === LEGACY_LOG_NAME || name === 'node_modules';
}
