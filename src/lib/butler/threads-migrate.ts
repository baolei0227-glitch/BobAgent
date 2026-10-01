/**
 * lib/butler/threads-migrate.ts —— 历史会话的一次性迁移（Phase 4 §4a）
 *
 * 背景：Phase 4 之前，Butler 的联系人/线程存于 `.inbox.db` 的 `chat_sessions` 表。
 * 本模块在升级后**一次性**把这些行搬进新真源 `<butlerRoot>/.state/threads/<id>.json`，
 * 让用户的联系人与历史**一条不少**地跟着走。
 *
 * 设计要点：
 *   - **幂等**：已存在的线程文件一律跳过（不覆盖新存储里更新过的内容）；
 *     全部处理完写标记 `.state/threads/.migrated`，之后直接短路返回。
 *   - **best-effort**：读库/写文件失败只告警不抛出 —— 迁移不能拖垮会话读写；
 *     未写标记则下次访问重试（沿用 butler-notify 的存量归位模式）。
 *   - **不改 threadId**：收件箱 `inbox` 行以 thread_id 关联，改写会切断归属；故历史 id 原样保留。
 *   - **不删旧表**：`chat_sessions` 保留只读兜底，避免不可逆的数据风险。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { resolveAppRoot, INBOX_DB_FILENAME } from '@/lib/app-root';
import { ensureDir } from './storage';
import { parsePersona, threadExpiresAt, type ButlerThread, type ButlerThreadSource, type ChatMessage } from './threads-shared';
import { threadFilePath, threadsDir, writeThreadFile } from './threads';

/** 迁移完成标记（点前缀 = 内部文件，不会与线程文件混淆） */
const MIGRATED_MARKER = '.migrated';

type LegacyRow = {
  thread_id: string;
  messages: string;
  tail_times: string | null;
  source: string;
  expires_at: number | null;
  persona: string | null;
  read_at: number | null;
  created_at: number;
  updated_at: number;
};

/** `chat_sessions.source` → Butler 线程 source（未知值按 panel 处理，与旧解析口径一致） */
function toSource(raw: string): ButlerThreadSource {
  return (['panel', 'wechat', 'notify'] as string[]).includes(raw) ? (raw as ButlerThreadSource) : 'panel';
}

function parseMessages(raw: string): ChatMessage[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter(
      (m): m is ChatMessage => !!m && typeof m === 'object' && typeof (m as ChatMessage).content === 'string',
    );
  } catch {
    return [];
  }
}

function parseTail(raw: string | null): number[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

function parsePersonaCell(raw: string | null): ButlerThread['persona'] {
  if (!raw) return null;
  try {
    return parsePersona(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** 该线程是否已迁入新存储（存在即跳过，避免覆盖新存储里更新过的内容） */
async function alreadyMigrated(threadId: string): Promise<boolean> {
  try {
    await fs.access(threadFilePath(threadId));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 `chat_sessions` 全量迁入 `.state/threads/`。
 * 幂等 + best-effort：完成写标记；失败不抛出（调用方无需 try）。
 */
export async function migrateLegacyThreads(): Promise<void> {
  const marker = join(threadsDir(), MIGRATED_MARKER);
  try {
    await fs.access(marker);
    return; // 已迁过
  } catch { /* 未迁过 */ }

  let rows: LegacyRow[];
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(join(resolveAppRoot(), INBOX_DB_FILENAME), { readonly: true });
    try {
      rows = db.prepare(`SELECT * FROM chat_sessions`).all() as LegacyRow[];
    } finally {
      db.close();
    }
  } catch (e) {
    // 库不存在 / 无表 / 打不开：没有可迁内容，不写标记（留给以后的库出现时再试）
    console.warn('[butler/threads] 读取历史会话失败（跳过迁移）:', e instanceof Error ? e.message : String(e));
    return;
  }

  await ensureDir(threadsDir());
  let migrated = 0;
  for (const row of rows) {
    const threadId = row.thread_id;
    if (!threadId) continue;
    try {
      if (await alreadyMigrated(threadId)) continue;
      const source = toSource(row.source);
      const now = Date.now();
      const thread: ButlerThread = {
        threadId,
        messages: parseMessages(row.messages),
        tailTimes: parseTail(row.tail_times),
        persona: parsePersonaCell(row.persona),
        source,
        lifecycle: 'active',
        readAt: row.read_at ?? 0,
        createdAt: row.created_at ?? now,
        updatedAt: row.updated_at ?? now,
        // 迁移保留原过期语义：旧 expires_at 缺省时按 source 重算（wechat 24h / 其余长期）
        expiresAt:
          typeof row.expires_at === 'number' && Number.isFinite(row.expires_at)
            ? row.expires_at
            : threadExpiresAt(source, now),
      };
      await writeThreadFile(thread);
      migrated++;
    } catch (e) {
      console.warn(`[butler/threads] 迁移线程 ${threadId} 失败:`, e instanceof Error ? e.message : String(e));
    }
  }

  try {
    await fs.writeFile(marker, `${new Date().toISOString()}\n`, 'utf-8');
  } catch (e) {
    console.warn('[butler/threads] 写迁移标记失败（下次会重试）:', e instanceof Error ? e.message : String(e));
    return; // 标记没写成 → 下次重跑（幂等，已迁文件会被跳过）
  }
  console.log(`[butler/threads] 历史会话迁移完成：${migrated} 条`);
}