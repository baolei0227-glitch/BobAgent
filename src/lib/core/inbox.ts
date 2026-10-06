/**
 * Butler 收件箱持久化（全局 .inbox.db）
 *
 * 设计理念：Butler 采用"邮件"式异步交互——用户发出指令，执行完成后回执
 * 作为一封"邮件"进入收件箱，晚些时候回来仍能查阅历史。
 * 收件箱不分项目，统一存于应用根目录（BOBWORK_HOME，发布版 ~/BobWork）。
 *
 * 写入时机：前端 ButlerNoticeHost 收到 butler.notice 事件时 POST 落库，
 * 覆盖所有发布源（/todo、/note、对话、日程查询、日历提醒、每日报告）。
 */
import { join } from 'path';
import { resolveAppRoot, INBOX_DB_FILENAME } from '@/lib/app-root';
import { dailyReportSection } from '@/lib/butler/report-group';
import type { ButlerNoticeItem, ChatMessage } from '@/lib/bus';

const INBOX_DB_PATH = join(resolveAppRoot(), INBOX_DB_FILENAME);

type DB = import('better-sqlite3').Database;

let _db: DB | null = null;

/** 惰性单例：打开（或创建）收件箱数据库 */
async function getDb(): Promise<DB> {
  if (!_db) {
    const Database = (await import('better-sqlite3')).default;
    _db = new Database(INBOX_DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL DEFAULT 'info',
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        items_json  TEXT,
        action_type TEXT,
        source      TEXT,
        thread_id   TEXT,
        messages_json TEXT,
        read        INTEGER NOT NULL DEFAULT 0,
        done        INTEGER NOT NULL DEFAULT 0,
        time        INTEGER NOT NULL,
        created_at  TEXT NOT NULL
      );
    `);
    // 迁移：老库补充 done 列（收件箱/已完成拆分）
    const cols = _db.prepare(`PRAGMA table_info(inbox)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'done')) {
      _db.exec(`ALTER TABLE inbox ADD COLUMN done INTEGER NOT NULL DEFAULT 0`);
    }
    // 迁移：老库补充 source 列（通知来源标识：panel / wechat / scheduled）
    if (!cols.some((c) => c.name === 'source')) {
      _db.exec(`ALTER TABLE inbox ADD COLUMN source TEXT`);
    }
    // 迁移：老库补充 thread_id 列（chat 线程归组用）
    if (!cols.some((c) => c.name === 'thread_id')) {
      _db.exec(`ALTER TABLE inbox ADD COLUMN thread_id TEXT`);
    }
    // 迁移：老库补充 messages_json 列（chat 对话历史持久化）
    if (!cols.some((c) => c.name === 'messages_json')) {
      _db.exec(`ALTER TABLE inbox ADD COLUMN messages_json TEXT`);
    }
    // 迁移：老库补充 dedupe_key 列（显式全局唯一去重键，evt:xxx / notes:xxx / chat:xxx）
    if (!cols.some((c) => c.name === 'dedupe_key')) {
      _db.exec(`ALTER TABLE inbox ADD COLUMN dedupe_key TEXT`);
    }
    // 迁移：老库补充 query_key 列（邮件源查询签名，如 todocheck:today；用于跳过 (kind,title) 当日幂等）
    if (!cols.some((c) => c.name === 'query_key')) {
      _db.exec(`ALTER TABLE inbox ADD COLUMN query_key TEXT`);
    }
    // 迁移：'daily-report' kind 正名为 'notes-maintenance'（日报三页签退役后，该 kind 只剩
    //  知识库每日维护一种来源）。幂等：迁完即无匹配行。
    _db.prepare(`UPDATE inbox SET kind = 'notes-maintenance' WHERE kind = 'daily-report'`).run();
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox(created_at DESC);`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_read ON inbox(read);`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_done ON inbox(done);`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_dedupe_key ON inbox(dedupe_key);`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_query_key ON inbox(query_key, done);`);
  }
  return _db;
}

export interface InboxRecord {
  id: string;
  kind: string;
  title: string;
  body: string;
  items: ButlerNoticeItem[] | null;
  action_type: string | null;
  source: string | null;
  thread_id: string | null;
  messages: ChatMessage[] | null;
  dedupe_key: string | null;
  query_key: string | null;
  read: boolean;
  done: boolean;
  time: number;
  created_at: string;
}

interface InboxRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  items_json: string | null;
  action_type: string | null;
  source: string | null;
  thread_id: string | null;
  messages_json: string | null;
  dedupe_key: string | null;
  query_key: string | null;
  read: number;
  done: number;
  time: number;
  created_at: string;
}

function rowToRecord(row: InboxRow): InboxRecord {
  let items: ButlerNoticeItem[] | null = null;
  if (row.items_json) {
    try {
      items = JSON.parse(row.items_json);
    } catch {
      items = null;
    }
  }
  let messages: ChatMessage[] | null = null;
  if (row.messages_json) {
    try {
      messages = JSON.parse(row.messages_json);
    } catch {
      messages = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    items,
    action_type: row.action_type,
    source: row.source,
    thread_id: row.thread_id,
    messages,
    dedupe_key: row.dedupe_key,
    query_key: row.query_key,
    read: !!row.read,
    done: !!row.done,
    time: row.time,
    created_at: row.created_at,
  };
}

/** 写入一条收件箱消息，返回落库后的完整记录。
 *  幂等分两层（两层任一命中即复用，不产生重复）：
 *    1) 显式 dedupeKey（若提供）：全局唯一键（如 evt:<projectId>:<eventId>、notes:<YYYY-MM-DD>、chat:<threadId>）
 *       命中即直接返回（不限制自然日，如跨 00:00 的补发仍正确去重）
 *    2) (kind, title) 在同一自然日内匹配（兜底，兼容未传 dedupeKey 的老路径）
 *  覆盖场景：
 *    1) ButlerNoticeHost 订阅 bus 事件 POST 入库时，恰好 inbox 历史也刚拉到（或反之）→ 重复 insert；
 *    2) 前端轮询 pending.json 时因网络并发重试导致同一 pending 被 POST 两次；
 *    3) 事件跨 00:00 仍未被 reminded_at 标记，扫描器重启后重复写入"⏰ Due — 同事件"。
 */
export async function insertInbox(input: {
  kind: string;
  title: string;
  body: string;
  items?: ButlerNoticeItem[] | null;
  actionType?: string | null;
  source?: string | null;
  threadId?: string | null;
  messages?: ChatMessage[] | null;
  time?: number;
  dedupeKey?: string | null;
  queryKey?: string | null;
}): Promise<InboxRecord> {
  const db = await getDb();
  const now = new Date();
  const nowISO = now.toISOString();
  const id = `in-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const time = input.time ?? Date.now();

  // 当日边界（本地时区 00:00 ~ 次日 00:00，毫秒）
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;

  // ① 优先按显式 dedupeKey 查（全局唯一，不受自然日限制）
  if (input.dedupeKey) {
    const byKey = db
      .prepare(`SELECT * FROM inbox WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1`)
      .get(input.dedupeKey) as InboxRow | undefined;
    if (byKey) return rowToRecord(byKey);
  }

  const itemsJson = input.items && input.items.length > 0 ? JSON.stringify(input.items) : null;
  const messagesJson = input.messages && input.messages.length > 0 ? JSON.stringify(input.messages) : null;
  const dedupeKeyVal = input.dedupeKey ?? null;
  const queryKeyVal = input.queryKey ?? null;

  // ② 兜底：同 kind+title 在当日是否已存在 → 存在直接返回（幂等）。
  //    仅对"无查询签名（queryKey）"的邮件生效——带签名意味着"可重复执行"，
  //    需生成新邮件而非复用旧邮件（如 /todo check 重复查询要得到本轮新结果）。
  //    注：新邮件一律进「收件箱」，不做自动归档——只有用户手动归档才进「已完成」。
  const existing = !queryKeyVal
    ? (db
        .prepare(
          `SELECT * FROM inbox
            WHERE kind = ? AND title = ? AND time >= ? AND time < ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(input.kind, input.title, dayStart, dayEnd) as InboxRow | undefined)
    : undefined;
  if (existing) return rowToRecord(existing);

  const tx = db.transaction(() => {
    // 事务内 double-check：避免两个并发 insert 都过了上面的 SELECT
    if (dedupeKeyVal) {
      const dupKey = db
        .prepare(`SELECT * FROM inbox WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1`)
        .get(dedupeKeyVal) as InboxRow | undefined;
      if (dupKey) return rowToRecord(dupKey);
    }
    const dup = !queryKeyVal
      ? (db
          .prepare(
            `SELECT * FROM inbox
              WHERE kind = ? AND title = ? AND time >= ? AND time < ?
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(input.kind, input.title, dayStart, dayEnd) as InboxRow | undefined)
      : undefined;
    if (dup) return rowToRecord(dup);
    db.prepare(
      `INSERT INTO inbox (id, kind, title, body, items_json, action_type, source, thread_id, messages_json, dedupe_key, query_key, read, done, time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      id,
      input.kind,
      input.title,
      input.body,
      itemsJson,
      input.actionType ?? null,
      input.source ?? null,
      input.threadId ?? null,
      messagesJson,
      dedupeKeyVal,
      queryKeyVal,
      0,
      time,
      nowISO,
    );
    return rowToRecord({
      id,
      kind: input.kind,
      title: input.title,
      body: input.body,
      items_json: itemsJson,
      action_type: input.actionType ?? null,
      source: input.source ?? null,
      thread_id: input.threadId ?? null,
      messages_json: messagesJson,
      dedupe_key: dedupeKeyVal,
      query_key: queryKeyVal,
      read: 0,
      done: 0,
      time,
      created_at: nowISO,
    });
  });
  return tx();
}

/** 拉取收件箱历史（新→旧） */
export async function listInbox(limit = 50): Promise<InboxRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(`SELECT * FROM inbox ORDER BY created_at DESC LIMIT ?`)
    .all(Math.max(1, Math.min(Math.floor(limit), 200))) as InboxRow[];
  return rows.map(rowToRecord);
}

/** 按 id 查一条收件箱消息（供报告分享链接读取正文） */
export async function getInboxById(id: string): Promise<InboxRecord | null> {
  const db = await getDb();
  const row = db.prepare(`SELECT * FROM inbox WHERE id = ? LIMIT 1`).get(id) as InboxRow | undefined;
  return row ? rowToRecord(row) : null;
}

/** 标记指定消息为已完成（归入「已完成」分区） */
export async function markInboxDone(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE inbox SET done = 1 WHERE id IN (${placeholders})`).run(...ids);
}

/** 恢复指定消息为未完成（从「已完成」分区移回待办） */
export async function markInboxUndone(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE inbox SET done = 0 WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * 标记回执「已点开」（read = 1）。
 *
 * 2026-09-28 收口：通知 = 普通消息，「已读」不再是一颗按钮/开关，而是**点开卡片**这一动作本身——
 * 卡片上的红色未读点（微信语音消息那颗）与好友头像角标都由它清零。只置 1，不提供回退。
 */
export async function markInboxRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE inbox SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
}

/** 线程级归档：把同 threadId 的所有邮件标记为已完成。
 *  客户端内存中可能只持有部分线程邮件（回复邮件未采纳服务端 id / 超出 100 条上限被逐出），
 *  仅按 id PATCH 会漏掉 DB 中其余行 → 重启后未归档邮件重回 INBOX。按 threadId 全量更新兜底。 */
export async function markThreadInboxDone(threadId: string): Promise<void> {
  const db = await getDb();
  db.prepare(`UPDATE inbox SET done = 1 WHERE thread_id = ?`).run(threadId);
}

/** 线程级恢复：把同 threadId 的所有邮件标记为未完成（从 ARCHIVE 移回 INBOX） */
export async function markThreadInboxUndone(threadId: string): Promise<void> {
  const db = await getDb();
  db.prepare(`UPDATE inbox SET done = 0 WHERE thread_id = ?`).run(threadId);
}

/** 更新指定消息的 items（notes 邮件删除笔记后同步收件箱快照，避免刷新后删除项复活） */
export async function updateInboxItems(ids: string[], items: ButlerNoticeItem[] | null): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  const itemsJson = items && items.length > 0 ? JSON.stringify(items) : null;
  db.prepare(`UPDATE inbox SET items_json = ? WHERE id IN (${placeholders})`).run(itemsJson, ...ids);
}

/** 物理删除指定消息（日历端删除事件后联动清理收件箱对应条目） */
export async function deleteInbox(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM inbox WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * 清理历史「每日报告」回执（Progress / Morning / Sticky 三类）。
 *
 * 背景（2026-09-27）：日报三页签整体搬进 Today 面板，通知助理 Bobby 不再推送日报，
 * 存量收件箱里的日报回执成了点了也没反应的孤儿（右栏日报页签在管道关停后已无新数据）。
 * 这里按 report-group 的同一套判定（dedupeKey 优先、标题兜底）一次性物理删除。
 *
 * **不含 Notes Maintenance**：它仍走 Bobby 通知中心（每周节奏，不是日报三页签）。
 * 幂等：无匹配行时返回 0；启动时调用一次即可（见 instrumentation.ts）。
 */
export async function purgeInboxDailyReports(): Promise<number> {
  const db = await getDb();
  const rows = db.prepare(`SELECT id, title, dedupe_key FROM inbox`).all() as Array<{
    id: string;
    title: string;
    dedupe_key: string | null;
  }>;
  const ids = rows
    .filter((r) => dailyReportSection({ title: r.title, dedupeKey: r.dedupe_key }) !== null)
    .map((r) => r.id);
  if (ids.length === 0) return 0;
  // 分批删除：SQLite 绑定变量数有上限（默认 999），一次性塞几千个 id 会直接报错
  const CHUNK = 500;
  let removed = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    removed += db.prepare(`DELETE FROM inbox WHERE id IN (${placeholders})`).run(...chunk).changes;
  }
  return removed;
}

/** 按消息 id 查其关联的线程（thread_id 去重、过滤空值）——供删除时联动清理 /chat 会话 */
export async function getInboxThreadIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT DISTINCT thread_id FROM inbox WHERE id IN (${placeholders}) AND thread_id IS NOT NULL AND thread_id != ''`)
    .all(...ids) as Array<{ thread_id: string }>;
  return rows.map((r) => r.thread_id);
}

/** 统计指定线程（thread_id）剩余邮件数——删除后仍 >0 说明线程未删完，会话保留 */
export async function countInboxByThreadId(threadId: string): Promise<number> {
  const db = await getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM inbox WHERE thread_id = ?`).get(threadId) as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * 未点开的回执总数（read = 0）。
 * 悬浮球角标 = 会话未读消息 + 本数（见 lib/butler/today.ts）；
 * 好友头像角标则按线程现算（抽屉侧只需 store，不必等这轮 COUNT）。
 */
export async function countUnreadInbox(): Promise<number> {
  const db = await getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM inbox WHERE read = 0`).get() as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * 把指定 kind、**尚未归属任何线程**的回执一次性划入某线程，返回受影响行数（幂等）。
 * 用途：常驻「通知助理」上线前落的系统推送类通知 thread_id 为空，存量行需要一次归位迁移，
 * 否则联系人行会一直是占位副标题、按线程取回执也取不到它们。
 */
export async function adoptInboxThread(kinds: string[], threadId: string): Promise<number> {
  if (kinds.length === 0) return 0;
  const db = await getDb();
  const placeholders = kinds.map(() => '?').join(',');
  const res = db
    .prepare(
      `UPDATE inbox SET thread_id = ?
        WHERE (thread_id IS NULL OR thread_id = '') AND kind IN (${placeholders})`,
    )
    .run(threadId, ...kinds);
  return res.changes;
}

/**
 * 按线程取回执（**时间正序**，供把通知与追问按时间归并成一条时间线）。
 * 先按时间倒序取最近 limit 条再反转，避免长线程下截掉最新的那一头。
 */
export async function listInboxByThread(threadId: string, limit = 200): Promise<InboxRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(`SELECT * FROM inbox WHERE thread_id = ? ORDER BY time DESC, created_at DESC LIMIT ?`)
    .all(threadId, Math.max(1, Math.min(Math.floor(limit), 500))) as InboxRow[];
  return rows.reverse().map(rowToRecord);
}
