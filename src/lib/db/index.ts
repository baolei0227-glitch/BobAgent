import { join, dirname, basename } from 'path';
import { promises as fs } from 'fs';
import {
  resolveAppRoot,
  PROJECT_DB_FILENAME,
  isICloudPath,
  PROJECT_DB_NOSYNC_DIRNAME,
  CALENDAR_DB_FILENAME,
} from '@/lib/app-root';

export interface SessionRow {
  id: string;
  title: string | null;
  status: string;
  thinking: string | null;
  model: string | null;
  provider: string | null;
  message_count: number;
  token_usage_json: string;
  file_path: string;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EdgeRow {
  edge_id: string;
  project_id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
  disconnected_at: string | null;
  created_at: string;
}

/** 日历事件（项目级 + 全局待办合并） */
export interface EventRow {
  event_id: string;
  project_id: string;          // 项目级事件 = project_id；全局待办 = '__global__'
  title: string;
  description: string | null;
  location: string | null;
  start_time: string | null;   // ISO 8601，null = 无时间清单项
  end_time: string | null;     // ISO 8601
  all_day: number;            // 0 / 1
  status: string;             // 'scheduled' | 'done' | 'cancelled'
  priority: string;           // 'high' | 'normal' | 'low'
  color: string | null;       // hex color (e.g. '#F59E0B')
  tags_json: string;          // JSON string array
  category_path_json: string; // JSON string array，层级分类如 ["工作","开发"]
  scope: string;              // 'project' | 'global'（global = 全局待办）
  source_node_id: string | null;  // 关联的画布节点 ID
  source_raw: string | null;      // 原始粘贴文本（备注）
  /** 反向引用来源（JSON 字符串，如 {"kind":"sticky","noteId":"sn-xxx","pageId":"pg-xxx"}）：
   *  便签行被手动「Add to calendar」或 Butler 排程入日历时写入，供日历侧变更（改标题/勾选/删除）反向落回便签行 */
  source_ref: string | null;
  notified_at: string | null;     // 到期提醒「已通知」时间（null = 未提醒；已由多通知时间取代，保留兼容）
  /** 提前提醒分钟数配置（JSON 数组，如 [30, 1440] = 开始前 30 分钟 + 1 天；空数组/空 = 默认 [30]） */
  reminder_minutes_json: string;
  /** 已触发的提前分钟数（JSON 数组，防同一通知时间重复推送） */
  reminder_sent_json: string;
  external_id: string | null;     // 外部日历 ICALUID（.ics 导入 / CalDAV / WebCal 去重键）
  external_url: string | null;    // 外部日历资源 href（CalDAV 推送定位；WebCal 订阅来源）
  sync_provider: string | null;   // 'caldav' | 'webcal' | 'ics' | null
  sync_etag: string | null;       // 外部 ETag（CalDAV 冲突校验 / 增量判断）
  created_at: string;
  updated_at: string;
}

export function _now(): string {
  return new Date().toISOString();
}

export function _newId(): string {
  return crypto.randomUUID().slice(0, 24);
}

/**
 * 归一化项目 db 路径：
 * - 普通项目：db 直接放项目根目录
 * - iCloud 项目：db 放 .project.db.nosync 子目录（.nosync 后缀让 iCloud 跳过同步，避免 SQLite 多端写坏）
 * - 迁移：若 iCloud 项目根目录存在升级前遗留的旧 .project.db，移动到 .nosync 子目录（含 WAL/SHM）
 */
async function ensureProjectDbPath(dbPath: string): Promise<string> {
  // 仅处理项目 db（文件名 = .project.db），其他 db 原样返回
  if (basename(dbPath) !== PROJECT_DB_FILENAME) {
    await fs.mkdir(dirname(dbPath), { recursive: true });
    return dbPath;
  }

  const projectDir = dirname(dbPath);

  // 非 iCloud 项目：db 直接在项目根目录
  if (!isICloudPath(projectDir)) {
    await fs.mkdir(projectDir, { recursive: true });
    return dbPath;
  }

  // iCloud 项目：db 放 .nosync 子目录
  const nosyncDir = join(projectDir, PROJECT_DB_NOSYNC_DIRNAME);
  const finalPath = join(nosyncDir, PROJECT_DB_FILENAME);
  await fs.mkdir(nosyncDir, { recursive: true });

  // 迁移：.nosync 里还没有 db，但项目根目录有旧 db → 移入 .nosync（含 WAL/SHM）
  try {
    await fs.access(finalPath);
  } catch {
    try {
      await fs.access(dbPath);
      await fs.rename(dbPath, finalPath);
      for (const suffix of ['-wal', '-shm']) {
        try {
          await fs.rename(dbPath + suffix, finalPath + suffix);
        } catch { /* 辅助文件不存在则忽略 */ }
      }
    } catch { /* 旧 db 也不存在，全新项目 */ }
  }

  return finalPath;
}

/**
 * 初始化数据库
 *
 * @param dbPath 数据库文件路径（每个项目独立一个 .project.db）
 */
export async function initDb(dbPath: string) {
  const finalPath = await ensureProjectDbPath(dbPath);
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(finalPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      thinking TEXT,
      model TEXT,
      provider TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      token_usage_json TEXT NOT NULL DEFAULT '{}',
      file_path TEXT NOT NULL,
      pinned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, updated_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(pinned_at);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      edge_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      edge_type TEXT NOT NULL DEFAULT 'parallel',
      disconnected_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_project_id ON edges(project_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_from_node ON edges(from_node_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_to_node ON edges(to_node_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_disconnected ON edges(disconnected_at);`);

  // 日历事件表（项目级 + 全局待办合并）
  // start_time 可空（null = 无时间清单项）
  // category_path_json: 层级分类
  // scope: 'project' | 'global'，global = 全局待办
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      start_time TEXT,
      end_time TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled',
      priority TEXT NOT NULL DEFAULT 'normal',
      color TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      category_path_json TEXT NOT NULL DEFAULT '[]',
      scope TEXT NOT NULL DEFAULT 'project',
      source_node_id TEXT,
      source_raw TEXT,
      notified_at TEXT,
      reminder_minutes_json TEXT NOT NULL DEFAULT '[]',
      reminder_sent_json TEXT NOT NULL DEFAULT '[]',
      external_id TEXT,
      external_url TEXT,
      sync_provider TEXT,
      sync_etag TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 迁移：旧库 events 表 start_time 为 NOT NULL 且无 category_path_json / scope 列 → 表重建
  const eventCols = (db.prepare(`PRAGMA table_info(events)`).all() as { name: string; notnull: number }[]);
  const hasCategoryPath = eventCols.some((c) => c.name === 'category_path_json');
  const hasScope = eventCols.some((c) => c.name === 'scope');
  const hasNotifiedAt = eventCols.some((c) => c.name === 'notified_at');
  const hasReminderMinutes = eventCols.some((c) => c.name === 'reminder_minutes_json');
  const hasReminderSent = eventCols.some((c) => c.name === 'reminder_sent_json');
  const hasExternalId = eventCols.some((c) => c.name === 'external_id');
  const hasExternalUrl = eventCols.some((c) => c.name === 'external_url');
  const hasSyncProvider = eventCols.some((c) => c.name === 'sync_provider');
  const hasSyncEtag = eventCols.some((c) => c.name === 'sync_etag');
  const startTimeCol = eventCols.find((c) => c.name === 'start_time');
  const needsRebuild = !!startTimeCol && startTimeCol.notnull === 1;

  if (needsRebuild) {
    // SQLite 不支持 ALTER COLUMN 去 NOT NULL → 走经典表重建流程
    // 1. 旧表重命名
    db.exec(`ALTER TABLE events RENAME TO _events_old;`);
    // 2. 创建新表（完整 schema）
    db.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        start_time TEXT,
        end_time TEXT,
        all_day INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'scheduled',
        priority TEXT NOT NULL DEFAULT 'normal',
        color TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        category_path_json TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT 'project',
        source_node_id TEXT,
        source_raw TEXT,
        notified_at TEXT,
        reminder_minutes_json TEXT NOT NULL DEFAULT '[]',
        reminder_sent_json TEXT NOT NULL DEFAULT '[]',
        external_id TEXT,
        external_url TEXT,
        sync_provider TEXT,
        sync_etag TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // 3. 拷贝数据（旧表可能缺列，动态构建 SELECT）
    const oldCols = eventCols.map((c) => c.name);
    const selectCols = [
      'event_id', 'project_id', 'title', 'description', 'location',
      'start_time', 'end_time', 'all_day', 'status', 'priority',
      'color', 'tags_json',
      // 新列：旧表没有 → 用默认值
      `'[]' AS category_path_json`,
      `'project' AS scope`,
      'source_node_id', 'source_raw',
      hasNotifiedAt ? 'notified_at' : 'NULL AS notified_at',
      `'[]' AS reminder_minutes_json`,
      `'[]' AS reminder_sent_json`,
      hasExternalId ? 'external_id' : 'NULL AS external_id',
      hasExternalUrl ? 'external_url' : 'NULL AS external_url',
      hasSyncProvider ? 'sync_provider' : 'NULL AS sync_provider',
      hasSyncEtag ? 'sync_etag' : 'NULL AS sync_etag',
      'created_at', 'updated_at',
    ];
    db.exec(`INSERT INTO events SELECT ${selectCols.join(', ')} FROM _events_old;`);
    // 4. 删除旧表
    db.exec(`DROP TABLE _events_old;`);
    // 5. 重建索引（旧索引随旧表一起删除了）
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(project_id, start_time);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(project_id, status);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_node ON events(source_node_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_external ON events(project_id, external_id);`);
    // 6. FTS 表和触发器也需要重建（content='events' 指向的表被重建了）
    db.exec(`DROP TABLE IF EXISTS events_fts;`);
  } else {
    // 新建库或已有新 schema：补 ALTER TABLE 方式加列（与原有迁移模式一致）
    if (!hasCategoryPath) db.exec(`ALTER TABLE events ADD COLUMN category_path_json TEXT NOT NULL DEFAULT '[]'`);
    if (!hasScope) db.exec(`ALTER TABLE events ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
    if (!hasNotifiedAt) db.exec(`ALTER TABLE events ADD COLUMN notified_at TEXT`);
    if (!hasReminderMinutes) db.exec(`ALTER TABLE events ADD COLUMN reminder_minutes_json TEXT NOT NULL DEFAULT '[]'`);
    if (!hasReminderSent) db.exec(`ALTER TABLE events ADD COLUMN reminder_sent_json TEXT NOT NULL DEFAULT '[]'`);
    if (!hasExternalId) db.exec(`ALTER TABLE events ADD COLUMN external_id TEXT`);
    if (!hasExternalUrl) db.exec(`ALTER TABLE events ADD COLUMN external_url TEXT`);
    if (!hasSyncProvider) db.exec(`ALTER TABLE events ADD COLUMN sync_provider TEXT`);
    if (!hasSyncEtag) db.exec(`ALTER TABLE events ADD COLUMN sync_etag TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(project_id, start_time);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(project_id, status);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_node ON events(source_node_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_external ON events(project_id, external_id);`);
  }

  // 日历同步账户表（CalDAV 双向 / WebCal 单向订阅统一建模）
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_accounts (
      account_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,              -- 'caldav' | 'webcal'
      name TEXT NOT NULL,                  -- 展示名（如 "iCloud · 日程"）
      username TEXT,                       -- CalDAV 账号（Apple ID 邮箱）
      password_enc TEXT,                   -- app-specific password（AES-256-GCM 加密）
      server_url TEXT,                     -- CalDAV principal URL / WebCal 订阅 URL
      calendar_url TEXT,                   -- 具体日历 DAV URL（CalDAV）；webcal 时与 server_url 同
      calendar_name TEXT,                  -- 远程日历显示名（用于展示）
      read_only INTEGER NOT NULL DEFAULT 0,-- 1=仅拉取不推送（合规只读场景）
      sync_token TEXT,                     -- CalDAV sync-collection token（增量同步游标）
      last_sync_at TEXT,                   -- 最近一次成功同步时间
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_accounts_project ON calendar_accounts(project_id);`);

  // 日历同步日志表（同步成功/失败/冲突记录，页面状态条展示）
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_sync_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_log_account ON calendar_sync_log(account_id, created_at DESC);`);

  // 日历订阅 token 表（每个项目一个，用于 Apple 日历订阅 BobWork 发布的 .ics 流）
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_feed_token (
      project_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // 日历事件全文索引（FTS5）：trigram 分词支持中文子串匹配。
  // 外置表（content='events'）+ 触发器同步，按 rowid 关联。
  // 兼容迁移：早期库的 events_fts 声明列是 tags（当时 events 也有 tags 列），
  // 现 events 已改名 tags_json；外置表按声明列读 content 表，旧表会因
  // "no such column: T.tags" 报错，检测到旧结构（含 tags 或缺 tags_json）时重建。
  const ftsCols = (db.prepare(`PRAGMA table_info(events_fts)`).all() as { name: string }[]).map((c) => c.name);
  if (ftsCols.length > 0 && (ftsCols.includes('tags') || !ftsCols.includes('tags_json'))) {
    db.exec(`DROP TABLE IF EXISTS events_fts;`);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      title, description, location, tags_json,
      content='events',
      tokenize='trigram'
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, title, description, location, tags_json)
      VALUES (new.rowid, new.title, new.description, new.location, new.tags_json);
    END;
    CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, description, location, tags_json)
      VALUES('delete', old.rowid, old.title, old.description, old.location, old.tags_json);
    END;
    CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, description, location, tags_json)
      VALUES('delete', old.rowid, old.title, old.description, old.location, old.tags_json);
      INSERT INTO events_fts(rowid, title, description, location, tags_json)
      VALUES (new.rowid, new.title, new.description, new.location, new.tags_json);
    END;
  `);
  // 存量回填：仅当 FTS 表为空时执行（initDb 每次请求都会调用，避免重复重建）
  const ftsCount = (db.prepare(`SELECT count(*) AS c FROM events_fts`).get() as any)?.c ?? 0;
  if (ftsCount === 0) {
    db.exec(`
      INSERT INTO events_fts(rowid, title, description, location, tags_json)
      SELECT rowid, title, description, location, tags_json FROM events;
    `);
  }

  // 模型用量流水（用量统计：每次 chat 任务 done 落一条真实 token 记录）
  // task_id 为幂等键：同一任务重试/断线重放不重复记账
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      node_id TEXT,
      agent TEXT,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      rounds INTEGER,
      duration_ms INTEGER,
      ttft_ms INTEGER,
      est_cost REAL,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_task ON usage_log(task_id) WHERE task_id IS NOT NULL AND task_id != '';`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_log_created ON usage_log(created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_log_model ON usage_log(model);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_log_node ON usage_log(node_id);`);

  return db;
}

export async function createSession(db: any, data: { title?: string; thinking?: string; model?: string; provider?: string; file_path: string }): Promise<string> {
  const id = _newId();
  const now = _now();
  db.prepare(`
    INSERT INTO sessions (id, title, thinking, model, provider, file_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.title || null, data.thinking || null, data.model || null, data.provider || null, data.file_path, now, now);
  return id;
}

export async function updateSessionTitle(db: any, id: string, title: string): Promise<void> {
  db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(title, _now(), id);
}

export async function pinSession(db: any, id: string, pinned: boolean = true): Promise<void> {
  db.prepare(`UPDATE sessions SET pinned_at = ?, updated_at = ? WHERE id = ?`).run(pinned ? _now() : null, _now(), id);
}

export async function archiveSession(db: any, id: string): Promise<void> {
  db.prepare(`UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?`).run(_now(), id);
}

export async function deleteSession(db: any, id: string): Promise<void> {
  db.prepare(`UPDATE sessions SET status = 'deleted', updated_at = ? WHERE id = ?`).run(_now(), id);
}

export async function listSessions(db: any, status: string = 'active', limit: number = 50, offset: number = 0): Promise<SessionRow[]> {
  const rows = db.prepare(`
    SELECT id, title, status, thinking, model, provider, message_count, token_usage_json, pinned_at, created_at, updated_at
    FROM sessions
    WHERE status = ?
    ORDER BY pinned_at DESC, updated_at DESC
    LIMIT ? OFFSET ?
  `).all(status, limit, offset);
  return rows as SessionRow[];
}

export async function getSession(db: any, id: string): Promise<SessionRow | null> {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
  return row as SessionRow | null;
}

export async function appendMessage(db: any, sessionId: string, message: { role: string; content: string }): Promise<void> {
  const session = await getSession(db, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  
  db.prepare(`UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?`).run(_now(), sessionId);
  
  const record = {
    type: 'message',
    session_id: sessionId,
    timestamp: _now(),
    ...message,
  };
  
  const fs = await import('fs/promises');
  await fs.appendFile(session.file_path, JSON.stringify(record, null, 0) + '\n', 'utf-8');
}

export async function readMessages(db: any, sessionId: string, limit: number = 100, offset: number = 0): Promise<{ role: string; content: string; timestamp: string }[]> {
  const session = await getSession(db, sessionId);
  if (!session) return [];
  
  try {
    const fs = await import('fs/promises');
    const content = await fs.readFile(session.file_path, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const messages = lines.map(line => JSON.parse(line))
      .filter((record: { type: string }) => record.type === 'message');
    return messages.slice(offset, offset + limit) as { role: string; content: string; timestamp: string }[];
  } catch {
    return [];
  }
}

export async function createEdge(db: any, data: { project_id: string; from_node_id: string; to_node_id: string; edge_type?: string }): Promise<string> {
  const edge_id = _newId();
  const now = _now();
  db.prepare(`
    INSERT INTO edges (edge_id, project_id, from_node_id, to_node_id, edge_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(edge_id, data.project_id, data.from_node_id, data.to_node_id, data.edge_type || 'parallel', now);
  return edge_id;
}

export async function deleteEdge(db: any, edgeId: string): Promise<void> {
  db.prepare(`DELETE FROM edges WHERE edge_id = ?`).run(edgeId);
}

export async function disconnectEdge(db: any, edgeId: string): Promise<void> {
  db.prepare(`UPDATE edges SET disconnected_at = ? WHERE edge_id = ?`).run(_now(), edgeId);
}

export async function reconnectEdge(db: any, edgeId: string): Promise<void> {
  db.prepare(`UPDATE edges SET disconnected_at = NULL WHERE edge_id = ?`).run(edgeId);
}

export async function listEdges(db: any, projectId: string): Promise<EdgeRow[]> {
  const rows = db.prepare(`SELECT * FROM edges WHERE project_id = ?`).all(projectId);
  return rows as EdgeRow[];
}

export async function listActiveEdges(db: any, projectId: string): Promise<EdgeRow[]> {
  const rows = db.prepare(`SELECT * FROM edges WHERE project_id = ? AND disconnected_at IS NULL`).all(projectId);
  return rows as EdgeRow[];
}

export async function listParallelEdges(db: any, projectId: string): Promise<EdgeRow[]> {
  const rows = db.prepare(`SELECT * FROM edges WHERE project_id = ? AND edge_type = 'parallel' AND disconnected_at IS NULL`).all(projectId);
  return rows as EdgeRow[];
}

export async function listVerticalEdges(db: any, projectId: string): Promise<EdgeRow[]> {
  const rows = db.prepare(`SELECT * FROM edges WHERE project_id = ? AND edge_type = 'vertical' AND disconnected_at IS NULL`).all(projectId);
  return rows as EdgeRow[];
}

export async function getUpstreamNodeIds(db: any, projectId: string, nodeId: string): Promise<string[]> {
  const rows = db.prepare(`SELECT from_node_id FROM edges WHERE project_id = ? AND to_node_id = ? AND disconnected_at IS NULL`).all(projectId, nodeId);
  return rows.map((r: { from_node_id: string }) => r.from_node_id);
}

export async function getDownstreamNodeIds(db: any, projectId: string, nodeId: string): Promise<string[]> {
  const rows = db.prepare(`SELECT to_node_id FROM edges WHERE project_id = ? AND from_node_id = ? AND disconnected_at IS NULL`).all(projectId, nodeId);
  return rows.map((r: { to_node_id: string }) => r.to_node_id);
}

export async function deleteEdgesByNode(db: any, projectId: string, nodeId: string): Promise<void> {
  db.prepare(`UPDATE edges SET disconnected_at = ? WHERE project_id = ? AND (from_node_id = ? OR to_node_id = ?)`).run(_now(), projectId, nodeId, nodeId);
}

// ============================================================
// 日历事件 CRUD
// ============================================================

export interface CreateEventData {
  project_id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start_time: string | null;     // null = 无时间清单项
  end_time?: string | null;
  all_day?: boolean;
  status?: 'scheduled' | 'done' | 'cancelled';
  priority?: 'high' | 'normal' | 'low';
  color?: string | null;
  tags?: string[];
  category_path?: string[];      // 层级分类如 ["工作","开发"]
  scope?: 'project' | 'global';  // 默认 'project'；'global' = 全局待办（project_id 设为 '__global__'）
  source_node_id?: string;
  source_raw?: string;
  /** 反向引用来源（JSON 字符串；便签行手动入日历 / Butler 排程时写入的锚点，供日历侧反向联动） */
  source_ref?: string;
  /** 提前提醒分钟数（如 [30] = 开始前 30 分钟；多个则每个时间点各提醒一次；缺省默认 [30]） */
  reminder_minutes?: number[];
  external_id?: string;
  external_url?: string;
  sync_provider?: string;
  sync_etag?: string;
}

export interface UpdateEventData {
  title?: string;
  description?: string | null;
  location?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  all_day?: boolean;
  status?: 'scheduled' | 'done' | 'cancelled';
  priority?: 'high' | 'normal' | 'low';
  color?: string | null;
  tags?: string[];
  category_path?: string[];
  scope?: 'project' | 'global';
  source_node_id?: string | null;
  source_raw?: string | null;
  source_ref?: string | null;
  reminder_minutes?: number[];
  external_id?: string | null;
  external_url?: string | null;
  sync_provider?: string | null;
  sync_etag?: string | null;
}

function _rowToEvent(row: any): EventRow {
  return row as EventRow;
}

export async function createEvent(db: any, data: CreateEventData, event_id?: string): Promise<string> {
  const id = event_id ?? _newId();
  const now = _now();
  db.prepare(`
    INSERT INTO events (
      event_id, project_id, title, description, location,
      start_time, end_time, all_day, status, priority,
      color, tags_json, category_path_json, scope,
      source_node_id, source_raw, source_ref,
      reminder_minutes_json, reminder_sent_json,
      external_id, external_url, sync_provider, sync_etag,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.project_id,
    data.title,
    data.description ?? null,
    data.location ?? null,
    data.start_time,
    data.end_time ?? null,
    data.all_day ? 1 : 0,
    data.status ?? 'scheduled',
    data.priority ?? 'normal',
    data.color ?? null,
    JSON.stringify(data.tags ?? []),
    JSON.stringify(data.category_path ?? []),
    data.scope ?? 'project',
    data.source_node_id ?? null,
    data.source_raw ?? null,
    data.source_ref ?? null,
    // 提前提醒存储语义：未配置 → '[]'（扫描时默认 [30]）；明确取消（空数组）→ 'null'（不提醒）；否则存 JSON 数组
    data.reminder_minutes === undefined
      ? '[]'
      : (data.reminder_minutes.length === 0 ? 'null' : JSON.stringify(data.reminder_minutes)),
    '[]',
    data.external_id ?? null,
    data.external_url ?? null,
    data.sync_provider ?? null,
    data.sync_etag ?? null,
    now,
    now,
  );
  return id;
}

export async function updateEvent(db: any, eventId: string, data: UpdateEventData): Promise<void> {
  const setters: string[] = [];
  const params: any[] = [];

  if (data.title !== undefined) { setters.push('title = ?'); params.push(data.title); }
  if (data.description !== undefined) { setters.push('description = ?'); params.push(data.description); }
  if (data.location !== undefined) { setters.push('location = ?'); params.push(data.location); }
  if (data.start_time !== undefined) { setters.push('start_time = ?'); params.push(data.start_time); }
  if (data.end_time !== undefined) { setters.push('end_time = ?'); params.push(data.end_time); }
  if (data.all_day !== undefined) { setters.push('all_day = ?'); params.push(data.all_day ? 1 : 0); }
  if (data.status !== undefined) { setters.push('status = ?'); params.push(data.status); }
  if (data.priority !== undefined) { setters.push('priority = ?'); params.push(data.priority); }
  if (data.color !== undefined) { setters.push('color = ?'); params.push(data.color); }
  if (data.tags !== undefined) { setters.push('tags_json = ?'); params.push(JSON.stringify(data.tags)); }
  if (data.category_path !== undefined) { setters.push('category_path_json = ?'); params.push(JSON.stringify(data.category_path)); }
  if (data.scope !== undefined) { setters.push('scope = ?'); params.push(data.scope); }
  if (data.source_node_id !== undefined) { setters.push('source_node_id = ?'); params.push(data.source_node_id); }
  if (data.source_raw !== undefined) { setters.push('source_raw = ?'); params.push(data.source_raw); }
  if (data.source_ref !== undefined) { setters.push('source_ref = ?'); params.push(data.source_ref); }
  if (data.reminder_minutes !== undefined) {
    // 明确空数组（取消所有提醒）→ 存 'null' 标记；否则存 JSON 数组
    setters.push('reminder_minutes_json = ?');
    params.push(data.reminder_minutes.length === 0 ? 'null' : JSON.stringify(data.reminder_minutes));
  }
  if (data.external_id !== undefined) { setters.push('external_id = ?'); params.push(data.external_id); }
  if (data.external_url !== undefined) { setters.push('external_url = ?'); params.push(data.external_url); }
  if (data.sync_provider !== undefined) { setters.push('sync_provider = ?'); params.push(data.sync_provider); }
  if (data.sync_etag !== undefined) { setters.push('sync_etag = ?'); params.push(data.sync_etag); }

  if (setters.length === 0) return;

  setters.push('updated_at = ?');
  params.push(_now());
  params.push(eventId);

  db.prepare(`UPDATE events SET ${setters.join(', ')} WHERE event_id = ?`).run(...params);
}

export async function deleteEvent(db: any, eventId: string): Promise<void> {
  db.prepare(`DELETE FROM events WHERE event_id = ?`).run(eventId);
}

export async function getEvent(db: any, eventId: string): Promise<EventRow | null> {
  const row = db.prepare(`SELECT * FROM events WHERE event_id = ?`).get(eventId);
  return row ? _rowToEvent(row) : null;
}

/** 按时间范围查询事件 [start, end)，ISO 字符串。projectId 传 null = 查询全部（全局日历库）。
 *  默认排除已删除（status='cancelled'）事件，避免被删除日程仍显示在日历中；
 *  需要查询已删除事件请用 listEventsByStatus(db, null, 'cancelled')。 */
export async function listEventsInRange(
  db: any,
  projectId: string | null,
  rangeStart: string,
  rangeEnd: string,
): Promise<EventRow[]> {
  const conds: string[] = [];
  const params: any[] = [];
  if (projectId) { conds.push('project_id = ?'); params.push(projectId); }
  // datetime() 把带时区偏移的 ISO（+08:00）与 UTC ISO（.000Z）统一归一化到 UTC 再比较，
  // 避免字符串比较跨时区偏移时出错（如本地 17:00 事件被误判晚于当天 16:00Z 范围终点）
  conds.push('datetime(start_time) < datetime(?)'); params.push(rangeEnd);
  conds.push('(end_time IS NULL OR datetime(end_time) >= datetime(?))'); params.push(rangeStart);
  conds.push("status != 'cancelled'");
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE ${conds.join(' AND ')}
    ORDER BY start_time ASC
  `).all(...params);
  return rows.map(_rowToEvent);
}

/** 查询指定状态的事件。projectId 传 null = 查询全部（全局日历库） */
export async function listEventsByStatus(
  db: any,
  projectId: string | null,
  status: 'scheduled' | 'done' | 'cancelled',
  limit: number = 100,
): Promise<EventRow[]> {
  const conds: string[] = [];
  const params: any[] = [];
  if (projectId) { conds.push('project_id = ?'); params.push(projectId); }
  conds.push('status = ?'); params.push(status);
  conds.push('1=1'); // 保持 LIMIT 参数位置稳定
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE ${conds.join(' AND ')}
    ORDER BY start_time ASC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(_rowToEvent);
}

/** 查询所有待提醒的定时事件（status=scheduled 且 start_time 非空），供多通知时间扫描使用。
 *  projectId 传 null = 全局日历库全量扫描（日历独立于项目后提醒走全局库） */
export async function listScheduledEventsWithTime(db: any, projectId: string | null): Promise<EventRow[]> {
  const conds: string[] = [];
  const params: any[] = [];
  if (projectId) { conds.push("(project_id = ? OR scope = 'global')"); params.push(projectId); }
  conds.push("status = 'scheduled'");
  conds.push("start_time IS NOT NULL AND start_time != ''");
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE ${conds.join(' AND ')}
    ORDER BY start_time ASC
  `).all(...params);
  return rows.map(_rowToEvent);
}

/** 更新事件的已触发提醒分钟数（reminder_sent_json，防同一通知时间重复推送） */
export async function markReminderSent(db: any, eventId: string, sentMinutes: number[]): Promise<void> {
  db.prepare(`UPDATE events SET reminder_sent_json = ?, updated_at = ? WHERE event_id = ?`)
    .run(JSON.stringify(sentMinutes), _now(), eventId);
}

/** 查询所有事件（默认排除已删除 cancelled，按时间倒序）。projectId 传 null = 全局日历库全量。
 *  需要查询已删除事件请用 listEventsByStatus(db, null, 'cancelled')。 */
export async function listAllEvents(db: any, projectId: string | null, limit: number = 500): Promise<EventRow[]> {
  const conds: string[] = [];
  const params: any[] = [];
  if (projectId) { conds.push('project_id = ?'); params.push(projectId); }
  conds.push("status != 'cancelled'");
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE ${conds.join(' AND ')}
    ORDER BY start_time DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(_rowToEvent);
}

export interface SearchEventsOptions {
  /** 可选时间范围 [start, end)，ISO 字符串（与 listEventsInRange 语义一致） */
  rangeStart?: string;
  rangeEnd?: string;
  limit?: number;
  /** true = 按开始时间倒序（最近优先），默认正序 */
  desc?: boolean;
}

/**
 * 按内容关键词搜索事件（title / description / location / tags_json 模糊匹配）。
 *
 * 混合策略：
 *   - 关键词 ≥3 字 → FTS5 全文索引（events_fts，trigram 分词，中文子串可命中），
 *     失败（如索引缺失）自动回退 LIKE；
 *   - 关键词 <3 字（如"华为""合同"）→ FTS5 trigram 不支持短词，直接 LIKE 扫描。
 * LIKE 通配符（% _）自动转义，避免用户输入被当作模式。
 */
export async function searchEvents(
  db: any,
  projectId: string | null,
  keyword: string,
  opts: SearchEventsOptions = {},
): Promise<EventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  // 短关键词（<3 字）走 LIKE；长关键词优先 FTS5
  if ([...keyword].length >= 3) {
    try {
      const match = `"${keyword.replace(/"/g, '""')}"`;
      const conds: string[] = [];
      const params: any[] = [];
      if (projectId) { conds.push('e.project_id = ?'); params.push(projectId); }
      params.push(match);
      if (opts.rangeStart && opts.rangeEnd) {
        conds.push('datetime(e.start_time) < datetime(?)');
        conds.push('(e.end_time IS NULL OR datetime(e.end_time) >= datetime(?))');
        params.push(opts.rangeEnd, opts.rangeStart);
      }
      conds.push("e.status != 'cancelled'");
      const order = opts.desc ? 'e.start_time DESC' : 'e.start_time ASC';
      const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT e.* FROM events e
        INNER JOIN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?) f ON f.rowid = e.rowid
        ${where}
        ORDER BY ${order}
        LIMIT ?
      `).all(...params, limit);
      return rows.map(_rowToEvent);
    } catch {
      // FTS5 不可用（旧库缺索引等）→ 回退 LIKE
    }
  }

  const esc = keyword.replace(/[\\%_]/g, (c) => '\\' + c);
  const like = `%${esc}%`;
  const conds: string[] = [];
  const params: any[] = [];
  if (projectId) { conds.push('project_id = ?'); params.push(projectId); }
  conds.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')`);
  params.push(like, like, like, like);
  if (opts.rangeStart && opts.rangeEnd) {
    conds.push('datetime(start_time) < datetime(?)');
    conds.push('(end_time IS NULL OR datetime(end_time) >= datetime(?))');
    params.push(opts.rangeEnd, opts.rangeStart);
  }
  conds.push("status != 'cancelled'");
  const order = opts.desc ? 'ORDER BY start_time DESC' : 'ORDER BY start_time ASC';
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE ${conds.join(' AND ')}
    ${order}
    LIMIT ?
  `).all(...params, limit);
  return rows.map(_rowToEvent);
}

/** 批量创建事件（用于小模型归纳后一次性写入） */
export async function createEventsBulk(db: any, items: CreateEventData[]): Promise<string[]> {
  const ids: string[] = [];
  const now = _now();
  const stmt = db.prepare(`
    INSERT INTO events (
      event_id, project_id, title, description, location,
      start_time, end_time, all_day, status, priority,
      color, tags_json, category_path_json, scope,
      source_node_id, source_raw,
      reminder_minutes_json, reminder_sent_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((list: CreateEventData[]) => {
    for (const data of list) {
      const event_id = _newId();
      stmt.run(
        event_id,
        data.project_id,
        data.title,
        data.description ?? null,
        data.location ?? null,
        data.start_time,
        data.end_time ?? null,
        data.all_day ? 1 : 0,
        data.status ?? 'scheduled',
        data.priority ?? 'normal',
        data.color ?? null,
        JSON.stringify(data.tags ?? []),
        JSON.stringify(data.category_path ?? []),
        data.scope ?? 'project',
        data.source_node_id ?? null,
        data.source_raw ?? null,
        // 提前提醒存储语义：未配置 → '[]'（扫描时默认 [30]）；明确取消（空数组）→ 'null'（不提醒）；否则存 JSON 数组
        data.reminder_minutes === undefined
          ? '[]'
          : (data.reminder_minutes.length === 0 ? 'null' : JSON.stringify(data.reminder_minutes)),
        '[]',
        now,
        now,
      );
      ids.push(event_id);
    }
  });
  tx(items);
  return ids;
}

// ============================================================
// 日历外部同步 helper（CalDAV / WebCal / .ics）
// ============================================================

export interface CalendarAccountRow {
  account_id: string;
  project_id: string;
  provider: string;
  name: string;
  username: string | null;
  password_enc: string | null;
  server_url: string | null;
  calendar_url: string | null;
  calendar_name: string | null;
  read_only: number;
  sync_token: string | null;
  last_sync_at: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CalendarAccountData {
  project_id: string;
  provider: 'caldav' | 'webcal';
  name: string;
  username?: string;
  password_enc?: string;
  server_url?: string;
  calendar_url?: string;
  calendar_name?: string;
  read_only?: boolean;
  sync_token?: string;
  last_sync_at?: string;
  enabled?: boolean;
}

export async function listCalendarAccounts(db: any, projectId: string | null): Promise<CalendarAccountRow[]> {
  return db.prepare(`SELECT * FROM calendar_accounts ${projectId ? 'WHERE project_id = ?' : ''} ORDER BY created_at ASC`)
    .all(...(projectId ? [projectId] : [])) as CalendarAccountRow[];
}

export async function getCalendarAccount(db: any, accountId: string): Promise<CalendarAccountRow | null> {
  return (db.prepare(`SELECT * FROM calendar_accounts WHERE account_id = ?`).get(accountId) as CalendarAccountRow | undefined) ?? null;
}

export async function createCalendarAccount(db: any, data: CalendarAccountData): Promise<string> {
  const account_id = _newId();
  const now = _now();
  db.prepare(`
    INSERT INTO calendar_accounts (
      account_id, project_id, provider, name, username, password_enc,
      server_url, calendar_url, calendar_name, read_only, sync_token,
      last_sync_at, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account_id, data.project_id, data.provider, data.name,
    data.username ?? null, data.password_enc ?? null,
    data.server_url ?? null, data.calendar_url ?? null,
    data.calendar_name ?? null, data.read_only ? 1 : 0,
    data.sync_token ?? null, null, data.enabled === false ? 0 : 1, now, now
  );
  return account_id;
}

export async function updateCalendarAccount(db: any, accountId: string, data: Partial<Omit<CalendarAccountData, 'project_id'>>): Promise<void> {
  const setters: string[] = [];
  const params: any[] = [];
  const map: Record<string, any> = {
    name: data.name, username: data.username, password_enc: data.password_enc,
    server_url: data.server_url, calendar_url: data.calendar_url,
    calendar_name: data.calendar_name, sync_token: data.sync_token,
    last_sync_at: data.last_sync_at,
  };
  for (const [col, val] of Object.entries(map)) {
    if (val !== undefined) { setters.push(`${col} = ?`); params.push(val); }
  }
  if (data.read_only !== undefined) { setters.push('read_only = ?'); params.push(data.read_only ? 1 : 0); }
  if (data.enabled !== undefined) { setters.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
  if (data.password_enc === null) { setters.push('password_enc = ?'); params.push(null); }
  if (setters.length === 0) return;
  setters.push('updated_at = ?');
  params.push(_now(), accountId);
  db.prepare(`UPDATE calendar_accounts SET ${setters.join(', ')} WHERE account_id = ?`).run(...params);
}

export async function deleteCalendarAccount(db: any, accountId: string): Promise<void> {
  db.prepare(`DELETE FROM calendar_accounts WHERE account_id = ?`).run(accountId);
}

/** 按外部日历 ICALUID 查找本地事件（用于 .ics / CalDAV / WebCal 去重）。projectId 传 null = 全局库查找 */
export async function findEventByExternalId(db: any, projectId: string | null, externalId: string): Promise<EventRow | null> {
  const row = projectId
    ? db.prepare(`SELECT * FROM events WHERE project_id = ? AND external_id = ? LIMIT 1`).get(projectId, externalId) as EventRow | undefined
    : db.prepare(`SELECT * FROM events WHERE external_id = ? LIMIT 1`).get(externalId) as EventRow | undefined;
  return row ?? null;
}

/** 按外部 URL 查找本地事件（CalDAV href 定位推送目标）。projectId 传 null = 全局库查找 */
export async function findEventByExternalUrl(db: any, projectId: string | null, externalUrl: string): Promise<EventRow | null> {
  const row = projectId
    ? db.prepare(`SELECT * FROM events WHERE project_id = ? AND external_url = ? LIMIT 1`).get(projectId, externalUrl) as EventRow | undefined
    : db.prepare(`SELECT * FROM events WHERE external_url = ? LIMIT 1`).get(externalUrl) as EventRow | undefined;
  return row ?? null;
}

/** 写入同步日志 */
export async function addSyncLog(db: any, accountId: string, projectId: string, level: 'info' | 'warn' | 'error', message: string): Promise<void> {
  db.prepare(`INSERT INTO calendar_sync_log (account_id, project_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(accountId, projectId, level, message, _now());
}

/** 最近 N 条同步日志（N 默认 20）。projectId 传 null = 全局库查询 */
export async function listSyncLogs(db: any, projectId: string | null, accountId?: string, limit = 20): Promise<{ level: string; message: string; created_at: string }[]> {
  const conds: string[] = [];
  const params: any[] = [];
  if (projectId) { conds.push('project_id = ?'); params.push(projectId); }
  if (accountId) { conds.push('account_id = ?'); params.push(accountId); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  return db.prepare(`SELECT level, message, created_at FROM calendar_sync_log ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as { level: string; message: string; created_at: string }[];
}

/** 获取或生成项目的日历订阅 token（Apple 日历订阅 BobWork 发布流用） */
export async function getOrCreateFeedToken(db: any, projectId: string): Promise<string> {
  const row = db.prepare(`SELECT token FROM calendar_feed_token WHERE project_id = ?`).get(projectId) as { token: string } | undefined;
  if (row?.token) return row.token;
  const token = Array.from({ length: 24 }, () =>
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)],
  ).join('');
  db.prepare(`INSERT INTO calendar_feed_token (project_id, token, created_at) VALUES (?, ?, ?)`)
    .run(projectId, token, _now());
  return token;
}

/** 校验订阅 token 是否合法，返回对应项目 id（null = 无效） */
export async function projectIdByFeedToken(db: any, token: string): Promise<string | null> {
  const row = db.prepare(`SELECT project_id FROM calendar_feed_token WHERE token = ?`).get(token) as { project_id: string } | undefined;
  return row?.project_id ?? null;
}

/** 重置项目的订阅 token（吊销旧订阅链接） */
export async function rotateFeedToken(db: any, projectId: string): Promise<string> {
  const token = Array.from({ length: 24 }, () =>
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)],
  ).join('');
  db.prepare(`INSERT INTO calendar_feed_token (project_id, token, created_at) VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`)
    .run(projectId, token, _now());
  return token;
}

// ============================================================
// 全局日历数据库 —— 日历与项目完全独立（2026-08-18 起）
// 事件/账户/同步日志/订阅 token 存于 app root 的 .calendar.db，
// 不随项目删除、切换、重建而丢失。首次使用时自动从各项目
// .project.db 一次性迁移历史数据（幂等，按来源项目记录）。
// ============================================================

const CALENDAR_DB_PATH = join(resolveAppRoot(), CALENDAR_DB_FILENAME);
const CALENDAR_DB_KEY = '__calendarDbSingleton__';

/** 全局日历库建表 SQL（与项目库中日历表 schema 保持一致） */
const CALENDAR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    start_time TEXT,
    end_time TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'scheduled',
    priority TEXT NOT NULL DEFAULT 'normal',
    color TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    category_path_json TEXT NOT NULL DEFAULT '[]',
    scope TEXT NOT NULL DEFAULT 'project',
    source_node_id TEXT,
    source_raw TEXT,
    source_ref TEXT,
    notified_at TEXT,
    reminder_minutes_json TEXT NOT NULL DEFAULT '[]',
    reminder_sent_json TEXT NOT NULL DEFAULT '[]',
    external_id TEXT,
    external_url TEXT,
    sync_provider TEXT,
    sync_etag TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);
  CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(project_id, start_time);
  CREATE INDEX IF NOT EXISTS idx_events_status ON events(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_events_node ON events(source_node_id);
  CREATE INDEX IF NOT EXISTS idx_events_external ON events(project_id, external_id);
  CREATE TABLE IF NOT EXISTS calendar_accounts (
    account_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    username TEXT,
    password_enc TEXT,
    server_url TEXT,
    calendar_url TEXT,
    calendar_name TEXT,
    read_only INTEGER NOT NULL DEFAULT 0,
    sync_token TEXT,
    last_sync_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cal_accounts_project ON calendar_accounts(project_id);
  CREATE TABLE IF NOT EXISTS calendar_sync_log (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cal_log_account ON calendar_sync_log(account_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS calendar_feed_token (
    project_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calendar_migration (
    project_id TEXT PRIMARY KEY,
    migrated_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    title, description, location, tags_json,
    content='events',
    tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, title, description, location, tags_json)
    VALUES (new.rowid, new.title, new.description, new.location, new.tags_json);
  END;
  CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, title, description, location, tags_json)
    VALUES('delete', old.rowid, old.title, old.description, old.location, old.tags_json);
  END;
  CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, title, description, location, tags_json)
    VALUES('delete', old.rowid, old.title, old.description, old.location, old.tags_json);
    INSERT INTO events_fts(rowid, title, description, location, tags_json)
    VALUES (new.rowid, new.title, new.description, new.location, new.tags_json);
  END;
`;

/** 为已有全局日历库补齐 source_ref 列（增量迁移，幂等）：旧库 events 表无此列时 ALTER 添加，
 *  并补建反向引用索引。新库建表 SQL 已含该列，此函数仅兜底存量库。 */
function ensureCalendarSourceRefColumn(db: any): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(events)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'source_ref')) {
      db.exec(`ALTER TABLE events ADD COLUMN source_ref TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_source_ref ON events(source_ref)`);
  } catch (e) {
    console.error('[calendar-db] events.source_ref 列迁移失败（不影响后续使用）:', e);
  }
}

/** 获取全局日历数据库（单例，惰性初始化 + 幂等迁移历史数据）。
 *  日历完全独立于项目：项目删除/切换/重建不影响任何日历数据。 */
export async function getCalendarDb(): Promise<any> {
  const g = globalThis as unknown as { [CALENDAR_DB_KEY]?: any };
  if (g[CALENDAR_DB_KEY]) return g[CALENDAR_DB_KEY];
  const Database = (await import('better-sqlite3')).default;
  await fs.mkdir(resolveAppRoot(), { recursive: true });
  const db = new Database(CALENDAR_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CALENDAR_SCHEMA_SQL);
  ensureCalendarSourceRefColumn(db);
  // 首次建库后回填 FTS（与项目库 initDb 一致）
  const ftsCount = (db.prepare(`SELECT count(*) AS c FROM events_fts`).get() as { c?: number } | undefined)?.c ?? 0;
  if (ftsCount === 0) {
    db.exec(`INSERT INTO events_fts(rowid, title, description, location, tags_json)
      SELECT rowid, title, description, location, tags_json FROM events;`);
  }
  await migrateLegacyCalendarData(db);
  g[CALENDAR_DB_KEY] = db;
  return db;
}

/** 一次性迁移：把各项目 .project.db 中的历史 events / calendar_accounts 迁入全局库（幂等）。 */
async function migrateLegacyCalendarData(db: any): Promise<void> {
  try {
    const { listProjects } = await import('@/lib/project/project-manager');
    const { projects } = await listProjects();
    for (const p of projects) {
      const done = db.prepare(`SELECT 1 AS x FROM calendar_migration WHERE project_id = ?`).get(p.id);
      if (done) continue;
      const srcDb = await initDb(join(p.path, PROJECT_DB_FILENAME));
      const evRows = srcDb.prepare(`SELECT * FROM events`).all() as EventRow[];
      if (evRows.length > 0) {
        const insEv = db.prepare(`
          INSERT OR IGNORE INTO events (
            event_id, project_id, title, description, location, start_time, end_time,
            all_day, status, priority, color, tags_json, category_path_json, scope,
            source_node_id, source_raw, notified_at, reminder_minutes_json, reminder_sent_json,
            external_id, external_url, sync_provider, sync_etag, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // global 事件在多个项目库中各有一份副本（不同 event_id）→ 只迁入首份（按 title+start_time 去重）
        const hasGlobalDup = db.prepare(
          `SELECT 1 AS x FROM events WHERE scope = 'global' AND title = ? AND start_time IS ?`,
        );
        db.transaction((rows: EventRow[]) => {
          for (const r of rows) {
            if (r.scope === 'global' && hasGlobalDup.get(r.title, r.start_time ?? null)) continue;
            insEv.run(
              r.event_id, r.project_id, r.title, r.description, r.location, r.start_time, r.end_time,
              r.all_day, r.status, r.priority, r.color, r.tags_json, r.category_path_json, r.scope,
              r.source_node_id, r.source_raw, r.notified_at, r.reminder_minutes_json, r.reminder_sent_json,
              r.external_id, r.external_url, r.sync_provider, r.sync_etag, r.created_at, r.updated_at,
            );
          }
        })(evRows);
        console.log(`[calendar-db] 已迁移项目「${p.name}」${evRows.length} 条历史日历事件 → 全局库`);
      }
      const accRows = srcDb.prepare(`SELECT * FROM calendar_accounts`).all() as CalendarAccountRow[];
      if (accRows.length > 0) {
        const insAcc = db.prepare(`
          INSERT OR IGNORE INTO calendar_accounts (
            account_id, project_id, provider, name, username, password_enc,
            server_url, calendar_url, calendar_name, read_only, sync_token,
            last_sync_at, enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        db.transaction((rows: CalendarAccountRow[]) => {
          for (const a of rows) {
            insAcc.run(
              a.account_id, a.project_id, a.provider, a.name, a.username, a.password_enc,
              a.server_url, a.calendar_url, a.calendar_name, a.read_only, a.sync_token,
              a.last_sync_at, a.enabled, a.created_at, a.updated_at,
            );
          }
        })(accRows);
      }
      db.prepare(`INSERT OR REPLACE INTO calendar_migration (project_id, migrated_at) VALUES (?, ?)`)
        .run(p.id, _now());
    }
  } catch (e) {
    console.error('[calendar-db] 历史日历数据迁移失败（不影响后续使用）:', e);
  }
}
