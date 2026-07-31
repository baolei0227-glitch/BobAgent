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

/** 日历事件（项目级） */
export interface EventRow {
  event_id: string;
  project_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_time: string;         // ISO 8601
  end_time: string | null;    // ISO 8601
  all_day: number;            // 0 / 1
  status: string;             // 'scheduled' | 'done' | 'cancelled'
  priority: string;           // 'high' | 'normal' | 'low'
  color: string | null;       // hex color (e.g. '#F59E0B')
  tags_json: string;          // JSON string array
  source_node_id: string | null;  // 关联的画布节点 ID
  source_raw: string | null;      // 原始粘贴文本（备注）
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
 * 初始化数据库
 *
 * @param dbPath 数据库文件路径（每个项目独立一个 project.db）
 */
export async function initDb(dbPath: string) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);
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

  // 日历事件表（项目级）
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled',
      priority TEXT NOT NULL DEFAULT 'normal',
      color TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_node_id TEXT,
      source_raw TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(project_id, start_time);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(project_id, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_node ON events(source_node_id);`);

  // 工作流模板表（项目级）
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_templates (
      template_id  TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT DEFAULT '',
      category     TEXT DEFAULT '通用',
      steps_json   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wf_project ON workflow_templates(project_id);`);

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
  description?: string;
  location?: string;
  start_time: string;
  end_time?: string;
  all_day?: boolean;
  status?: 'scheduled' | 'done' | 'cancelled';
  priority?: 'high' | 'normal' | 'low';
  color?: string;
  tags?: string[];
  source_node_id?: string;
  source_raw?: string;
}

export interface UpdateEventData {
  title?: string;
  description?: string | null;
  location?: string | null;
  start_time?: string;
  end_time?: string | null;
  all_day?: boolean;
  status?: 'scheduled' | 'done' | 'cancelled';
  priority?: 'high' | 'normal' | 'low';
  color?: string | null;
  tags?: string[];
  source_node_id?: string | null;
  source_raw?: string | null;
}

function _rowToEvent(row: any): EventRow {
  return row as EventRow;
}

export async function createEvent(db: any, data: CreateEventData): Promise<string> {
  const event_id = _newId();
  const now = _now();
  db.prepare(`
    INSERT INTO events (
      event_id, project_id, title, description, location,
      start_time, end_time, all_day, status, priority,
      color, tags_json, source_node_id, source_raw,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    data.source_node_id ?? null,
    data.source_raw ?? null,
    now,
    now,
  );
  return event_id;
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
  if (data.source_node_id !== undefined) { setters.push('source_node_id = ?'); params.push(data.source_node_id); }
  if (data.source_raw !== undefined) { setters.push('source_raw = ?'); params.push(data.source_raw); }

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

/** 按时间范围查询事件 [start, end)，ISO 字符串 */
export async function listEventsInRange(
  db: any,
  projectId: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<EventRow[]> {
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE project_id = ?
      AND start_time < ?
      AND (end_time IS NULL OR end_time > ?)
    ORDER BY start_time ASC
  `).all(projectId, rangeEnd, rangeStart);
  return rows.map(_rowToEvent);
}

/** 查询指定状态的事件 */
export async function listEventsByStatus(
  db: any,
  projectId: string,
  status: 'scheduled' | 'done' | 'cancelled',
  limit: number = 100,
): Promise<EventRow[]> {
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE project_id = ? AND status = ?
    ORDER BY start_time ASC
    LIMIT ?
  `).all(projectId, status, limit);
  return rows.map(_rowToEvent);
}

/** 查询所有事件（无状态过滤，按时间倒序） */
export async function listAllEvents(db: any, projectId: string, limit: number = 500): Promise<EventRow[]> {
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE project_id = ?
    ORDER BY start_time DESC
    LIMIT ?
  `).all(projectId, limit);
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
      color, tags_json, source_node_id, source_raw,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        data.source_node_id ?? null,
        data.source_raw ?? null,
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
// 工作流模板 CRUD
// ============================================================

export interface WorkflowStep {
  order: number;
  title: string;
  modelId?: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  skills: string[];
  prompt: string;
  attachmentHint?: string;
  attachments?: string[];
  nextSteps?: number[];
}

export interface WorkflowTemplate {
  template_id: string;
  project_id: string;
  name: string;
  description: string;
  category: string;
  steps: WorkflowStep[];
  created_at: string;
  updated_at: string;
}

export interface CreateWorkflowTemplateData {
  project_id: string;
  name: string;
  description?: string;
  category?: string;
  steps: WorkflowStep[];
}

function _rowToTemplate(row: any): WorkflowTemplate {
  return {
    template_id: row.template_id,
    project_id: row.project_id,
    name: row.name,
    description: row.description || '',
    category: row.category || '通用',
    steps: JSON.parse(row.steps_json || '[]'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createWorkflowTemplate(db: any, data: CreateWorkflowTemplateData): Promise<string> {
  const template_id = _newId();
  const now = _now();
  db.prepare(`
    INSERT INTO workflow_templates (template_id, project_id, name, description, category, steps_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    template_id,
    data.project_id,
    data.name,
    data.description ?? '',
    data.category ?? '通用',
    JSON.stringify(data.steps),
    now,
    now,
  );
  return template_id;
}

export async function getWorkflowTemplate(db: any, templateId: string): Promise<WorkflowTemplate | null> {
  const row = db.prepare(`SELECT * FROM workflow_templates WHERE template_id = ?`).get(templateId);
  return row ? _rowToTemplate(row) : null;
}

export async function listWorkflowTemplates(db: any, projectId: string): Promise<WorkflowTemplate[]> {
  const rows = db.prepare(`SELECT * FROM workflow_templates WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId);
  return rows.map(_rowToTemplate);
}

export async function updateWorkflowTemplate(db: any, templateId: string, data: Partial<CreateWorkflowTemplateData>): Promise<void> {
  const setters: string[] = [];
  const params: any[] = [];

  if (data.name !== undefined) { setters.push('name = ?'); params.push(data.name); }
  if (data.description !== undefined) { setters.push('description = ?'); params.push(data.description); }
  if (data.category !== undefined) { setters.push('category = ?'); params.push(data.category); }
  if (data.steps !== undefined) { setters.push('steps_json = ?'); params.push(JSON.stringify(data.steps)); }

  if (setters.length === 0) return;

  setters.push('updated_at = ?');
  params.push(_now());
  params.push(templateId);

  db.prepare(`UPDATE workflow_templates SET ${setters.join(', ')} WHERE template_id = ?`).run(...params);
}

export async function deleteWorkflowTemplate(db: any, templateId: string): Promise<void> {
  db.prepare(`DELETE FROM workflow_templates WHERE template_id = ?`).run(templateId);
}
