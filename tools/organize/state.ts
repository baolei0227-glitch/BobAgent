/**
 * 整理状态（幂等 + 重试依据）—— 与「整理日志」分开存：
 *   日志是给人看的流水（可回滚），状态是给机器看的指纹表（可重建）。
 *
 * 解决三个问题：
 *   1) 同一份内容重复投递 → 直接复用上次的主题/分类，不再调模型（省 token、避免主题漂移）；
 *   2) 判定失败落 _待处理 后，watcher 每次全量扫描都会重判同一个文件 → 用失败指纹短路；
 *   3) 设置面板要展示「为什么失败、失败了几次、什么时候可以重试」→ 状态就是数据源。
 *
 * 文件：<投递箱>/.整理状态.json（点前缀 = 隐藏，不污染用户的文件夹）
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

import { shouldSkip } from './naming';

/** 状态文件名（隐藏） */
export const STATE_NAME = '.整理状态.json';

/** 指纹取样的字节数：头部足够区分绝大多数文档，且避免大文件整份读入 */
const HASH_BYTES = 512 * 1024;

export interface StateEntry {
  /** 内容哈希 */
  hash: string;
  /** 首次判定时间（ISO） */
  at: string;
  /** 最近一次更新时间（ISO） */
  updatedAt: string;
  /** 判定结果：分类 / 主题 / 版本 / 判定档 */
  category: string;
  topic: string;
  version: string;
  verdict: string;
  /** 失败原因（空 = 判定成功） */
  failure: string;
  /** 判定档为可用（进了正常分类目录）还是不可用（落 _待处理） */
  usable: boolean;
  /** 被判定过几次（watcher 反复重判时累加） */
  attempts: number;
  /** 最近一次落盘后的绝对路径 */
  lastPath: string;
  /** 模型名 */
  model: string;
  /** 提取方式（如 pdf-ocr / pdf-text:hybrid）：失败指纹的一部分，
   *  提取能力升级后（例如 OCR 上线）旧失败不再短路 */
  method?: string;
}

export interface OrganizeState {
  version: 1;
  entries: StateEntry[];
}

/** 状态表容量上限（超出按最近更新淘汰），避免长期运行无限增长 */
const MAX_ENTRIES = 2000;

/** 内容指纹：大小 + 头部字节哈希（同内容不同文件名视为同一份） */
export async function contentHash(filePath: string): Promise<string | null> {
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) return null;
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(HASH_BYTES, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return createHash('sha1')
        .update(`${st.size}:`)
        .update(buf.subarray(0, bytesRead))
        .digest('hex');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** 读取状态（不存在/损坏 → 空） */
export async function readState(root: string): Promise<OrganizeState> {
  try {
    const raw = await fs.readFile(join(root, STATE_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as OrganizeState;
    return Array.isArray(parsed?.entries) ? { version: 1, entries: parsed.entries } : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeState(root: string, state: OrganizeState): Promise<void> {
  const entries = [...state.entries]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_ENTRIES);
  try {
    await fs.writeFile(join(root, STATE_NAME), JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
  } catch {
    /* 状态写不进去不阻塞整理（只是下次少一次短路机会） */
  }
}

/** 按哈希查一条 */
export function findEntry(state: OrganizeState, hash: string): StateEntry | null {
  return state.entries.find((e) => e.hash === hash) ?? null;
}

/** 记录/更新一条判定结果（同哈希覆盖，attempts 累加） */
export async function upsertEntry(
  root: string,
  patch: Omit<StateEntry, 'at' | 'updatedAt' | 'attempts'> & { at?: string },
): Promise<StateEntry> {
  const state = await readState(root);
  const now = new Date().toISOString();
  const prev = findEntry(state, patch.hash);
  const entry: StateEntry = {
    ...patch,
    at: prev?.at ?? patch.at ?? now,
    updatedAt: now,
    attempts: (prev?.attempts ?? 0) + 1,
  };
  state.entries = [entry, ...state.entries.filter((e) => e.hash !== patch.hash)];
  await writeState(root, state);
  return entry;
}

/** 批量删除若干哈希（用户点「重试」时清掉，允许重新判定） */
export async function forgetEntries(root: string, hashes: readonly string[]): Promise<number> {
  const state = await readState(root);
  const before = state.entries.length;
  const drop = new Set(hashes.filter(Boolean));
  state.entries = state.entries.filter((e) => !drop.has(e.hash));
  await writeState(root, state);
  return before - state.entries.length;
}

/** 清理「文件已不在投递箱里」的陈旧状态（启动对账用；不影响幂等语义） */
export async function pruneState(root: string): Promise<number> {
  const state = await readState(root);
  const kept: StateEntry[] = [];
  for (const e of state.entries) {
    try {
      await fs.access(e.lastPath);
      kept.push(e);
    } catch {
      /* 文件已被移走/删除：保留状态（同名内容再次投递时仍可复用），但不占配额优先位 */
      kept.push(e);
    }
  }
  if (kept.length !== state.entries.length) {
    state.entries = kept;
    await writeState(root, state);
  }
  return state.entries.length;
}

/** 投递箱里应当被跳过的目录/文件（状态文件与日志都不算待整理文件） */
export function shouldSkipEntry(name: string): boolean {
  return name === STATE_NAME || shouldSkip(name);
}
