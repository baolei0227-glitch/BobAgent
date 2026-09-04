/**
 * WANTED /chat 独立会话存储（替代原 temporary 项目 + chat-*.md 节点文件模型）
 *
 * 背景：/chat 与 ChatNode（画布节点）彻底语义隔离——对话历史不再以"节点 .md 文件"
 * 形式存在，而是存为独立会话记录。对话引擎（/api/chat）照旧复用，只是存储/标识/
 * 生命周期全部脱离"节点"概念：
 *   - 标识：threadId（BobMail 线程主键），不再有 nodeId
 *   - 存储：全局 SQLite（.inbox.db）chat_sessions 表，跨实例共享（UnifiedPalette 与微信桥同后端）
 *   - 生命周期：panel 会话长期保留（对应 BobMail 邮件线程）；wechat 会话 24 小时过期
 *   - 新建标准：/chat out 解绑后首问、/chat new、无活动绑定 → 新会话；30min 活动窗口内复用
 *
 * 本模块 server-only（better-sqlite3），仅被 node-chat.ts / instrumentation 引用。
 */
import { join } from 'path';
import { resolveAppRoot, INBOX_DB_FILENAME } from '@/lib/app-root';
import type { ChatMessage } from '@/lib/bus';

type DB = import('better-sqlite3').Database;

/** 微信桥 /chat 专属会话 TTL：24 小时（panel 会话为长期，expires_at=null） */
export const WECHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** 周期清理间隔：每分钟删除过期会话（wechat 24h TTL） */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** 会话来源：panel = ⌘F 面板（长期保留）；wechat = 微信桥（24 小时过期） */
export type ChatSessionSource = 'panel' | 'wechat';

export interface ChatSession {
  threadId: string;
  /** 完整对话消息（含 system prompt + 历史 user/assistant + 待答 user） */
  messages: ChatMessage[];
  source: ChatSessionSource;
  createdAt: number;
  updatedAt: number;
  /** 过期时间戳；null = 长期保留（panel） */
  expiresAt: number | null;
}

let _db: DB | null = null;
let _dbPromise: Promise<DB> | null = null;

async function getDb(): Promise<DB> {
  if (_db) return _db;
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(join(resolveAppRoot(), INBOX_DB_FILENAME));
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          thread_id   TEXT PRIMARY KEY,
          messages    TEXT NOT NULL,           -- JSON 数组（ChatMessage[]）
          source      TEXT NOT NULL,           -- 'panel' | 'wechat'
          expires_at  INTEGER,                 -- null = 长期保留；否则过期时间戳（ms）
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_expire ON chat_sessions(expires_at);`);
      return db;
    })();
  }
  _db = await _dbPromise;
  return _db;
}

/** 计算过期时间：wechat = now + 24h；panel = 长期（null） */
export function sessionExpiresAt(source: ChatSessionSource, now: number = Date.now()): number | null {
  return source === 'wechat' ? now + WECHAT_SESSION_TTL_MS : null;
}

/** 保存（upsert）会话。wechat 会话每次写入都刷新 24h 过期窗口。 */
export async function upsertChatSession(
  threadId: string,
  messages: ChatMessage[],
  source: ChatSessionSource,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO chat_sessions (thread_id, messages, source, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       messages = excluded.messages,
       source = excluded.source,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).run(threadId, JSON.stringify(messages), source, sessionExpiresAt(source, now), now, now);
}

/** 读取会话；已过期（wechat 24h）则删除并返回 null。 */
export async function loadChatSession(threadId: string): Promise<ChatSession | null> {
  const db = await getDb();
  type Row = {
    thread_id: string;
    messages: string;
    source: string;
    expires_at: number | null;
    created_at: number;
    updated_at: number;
  };
  const row = db.prepare(`SELECT * FROM chat_sessions WHERE thread_id = ?`).get(threadId) as Row | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at != null && row.expires_at <= now) {
    db.prepare(`DELETE FROM chat_sessions WHERE thread_id = ?`).run(threadId);
    return null;
  }
  let messages: ChatMessage[] = [];
  try {
    const parsed = JSON.parse(row.messages);
    if (Array.isArray(parsed)) messages = parsed as ChatMessage[];
  } catch { /* 坏数据按空会话处理 */ }
  return {
    threadId: row.thread_id,
    messages,
    source: row.source as ChatSessionSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/** 删除指定会话（/chat out 仅解绑线程标记不删会话；本函数供显式清理用） */
export async function deleteChatSession(threadId: string): Promise<void> {
  const db = await getDb();
  db.prepare(`DELETE FROM chat_sessions WHERE thread_id = ?`).run(threadId);
}

/** 清理全部已过期会话（wechat 24h），返回删除条数。 */
export async function sweepChatSessions(): Promise<{ deleted: number }> {
  const db = await getDb();
  const now = Date.now();
  const res = db.prepare(`DELETE FROM chat_sessions WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(now);
  return { deleted: res.changes };
}

type SweeperGlobal = { __bobworkChatSessionSweeperStarted?: boolean };
const sweeperGlobal = globalThis as unknown as SweeperGlobal;

/** 启动周期清理器（instrumentation 启动时调用）：每 60s 删除过期会话。
 *  dev 模式 HMR 重复注册由全局标记防抖。 */
export function startChatSessionSweeper(): void {
  if (sweeperGlobal.__bobworkChatSessionSweeperStarted) return;
  sweeperGlobal.__bobworkChatSessionSweeperStarted = true;
  // 启动先跑一次：清理上次关闭应用后已过期的残留会话
  sweepChatSessions().catch((e) => {
    console.warn('[chat-session] 启动清理失败:', e instanceof Error ? e.message : String(e));
  });
  const timer = setInterval(() => {
    sweepChatSessions().catch((e) => {
      console.warn('[chat-session] 周期清理失败:', e instanceof Error ? e.message : String(e));
    });
  }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
