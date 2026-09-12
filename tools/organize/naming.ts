/**
 * 命名与落盘规则 —— 全部确定性逻辑，不经过模型。
 *
 * 命名模板：{日期}_{版本号}_{主题}.{扩展名}
 *   日期   = 执行整理的当天（本地时区），由代码填
 *   版本号 = 同主题既有文件的最大序号 +1（新主题首份若文档自带版本标识则采纳）
 *   主题   = 模型输出，已清理非法字符
 */
import { promises as fs } from 'fs';
import { extname, join } from 'path';

/** 整理日志文件名（放在被整理目录根部，供 --undo 回滚） */
export const LOG_NAME = '_整理日志.json';

/** 文件名模板解析：YYYY-MM-DD_vNN_主题 */
const NAME_RE = /^\d{4}-\d{2}-\d{2}_v(\d{1,2})_(.+)$/;

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

/** 本地时区的 YYYY-MM-DD */
export function todayStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 计算版本号序号：
 *   1) 目录内同主题既有文件的最大序号 +1；
 *   2) 若为同主题首份（序号 1）且文档自带版本标识，采纳文档标识；
 *   3) 其余情况用序号。
 */
export async function resolveVersionIndex(
  dir: string,
  topic: string,
  docVersion: string | null,
): Promise<number> {
  let max = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    /* 目录不可读按空处理 */
  }
  for (const name of entries) {
    const m = NAME_RE.exec(name.slice(0, name.length - extname(name).length));
    if (m && m[2] === topic) max = Math.max(max, Number(m[1]) || 0);
  }
  const next = max + 1;
  if (next === 1 && docVersion) {
    const n = Number(docVersion.replace(/\D/g, ''));
    if (n > 0) return n;
  }
  return next;
}

/** 组装文件名（含重名兜底：同主题同版本已存在时追加 -2/-3） */
export function formatVersion(n: number): string {
  return `v${String(n).padStart(2, '0')}`;
}

export async function buildTargetName(
  dir: string,
  stamp: string,
  topic: string,
  ext: string,
  versionIndex: number,
): Promise<string> {
  const ver = formatVersion(versionIndex);
  for (let i = 1; i < 100; i++) {
    const suffix = i === 1 ? '' : `-${i}`;
    const name = `${stamp}_${ver}_${topic}${suffix}${ext}`;
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

export async function readLog(root: string): Promise<OrganizeLog> {
  try {
    const raw = await fs.readFile(join(root, LOG_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as OrganizeLog;
    return Array.isArray(parsed?.entries) ? { version: 1, entries: parsed.entries } : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

export async function appendLog(root: string, records: MoveRecord[]): Promise<void> {
  if (records.length === 0) return;
  const log = await readLog(root);
  log.entries.push(...records);
  await fs.writeFile(join(root, LOG_NAME), JSON.stringify(log, null, 2), 'utf-8');
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
  return { restored, skipped };
}

/** 是否应当跳过（隐藏文件、日志、本工具产物） */
export function shouldSkip(name: string): boolean {
  return name.startsWith('.') || name === LOG_NAME || name === 'node_modules';
}
