/**
 * Butler /meeting 会议会话状态（全局单场 · SQLite 单行）
 *
 * /meeting 开启后进入会议会话：后续输入（文字 + 微信桥媒体转写）全部积累进缓冲，
 * 直到输入 `/meeting out` 或静默超过 10 分钟自动视为会议结束，由调用方触发
 * AI 整理（meeting-minutes schema）→ 发送到 Butler 收件箱。
 *
 * 存储：全局 SQLite（.inbox.db）meeting_session 表，**全局唯一一场会议**（单行，id 恒为 1）。
 * 状态原先存于进程内单例，而微信桥可能是独立进程 → 桥与 Next 服务端各持一份、跨端不一致
 * （P1-d 修复）。落库后两端读写同一行，产品语义不变：进行中不允许再开第二场。
 *
 * 本模块 server-only（better-sqlite3）。
 */
import { join } from 'path';
import { resolveAppRoot, INBOX_DB_FILENAME } from '@/lib/app-root';

type DB = import('better-sqlite3').Database;

export interface MeetingMessage {
  type: 'text' | 'voice' | 'image' | 'file' | 'video';
  /** 类型标注（如「图片·OCR」；媒体经桥接层转文字后自带的 [图片识别结果] 前缀即标注） */
  label: string;
  text: string;
  time: number;
}

export interface MeetingSession {
  /** 会议唯一 id（收件箱幂等键用） */
  id: string;
  title: string;
  startedAt: number;
  lastActiveAt: number;
  messages: MeetingMessage[];
  /** 产物落点：'project' = 当前项目内相对目录；'butler' = butler 根下相对目录 */
  outputKind: 'project' | 'butler';
  /** 产物目录（project 时为项目内相对路径，butler 时为 butler 根下相对路径；空 = 默认） */
  outputDir: string;
}

interface MeetingSessionState extends MeetingSession {
  active: boolean;
  /** 5 分钟静默提醒已发送的时间戳（0 = 尚未提醒；用户继续发言后重置，重新计时） */
  remindedAt: number;
}

/** 会议静默提醒阈值：5 分钟无新消息时提醒一次"即将自动收尾"（与微信桥 15 分钟去重窗口错开） */
const MEETING_REMIND_AFTER_MS = 5 * 60 * 1000;
/** 会议静默超时：10 分钟无新消息自动结束整理（提醒后再等 5 分钟） */
const MEETING_IDLE_TTL_MS = 10 * 60 * 1000;

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
        CREATE TABLE IF NOT EXISTS meeting_session (
          id             INTEGER PRIMARY KEY CHECK (id = 1),
          active         INTEGER NOT NULL DEFAULT 0,   -- 0/1
          meeting_id     TEXT    NOT NULL DEFAULT '',  -- 会议唯一 id（收件箱幂等键用）
          title          TEXT    NOT NULL DEFAULT '',
          started_at     INTEGER NOT NULL DEFAULT 0,
          last_active_at INTEGER NOT NULL DEFAULT 0,
          reminded_at    INTEGER NOT NULL DEFAULT 0,   -- 本段静默是否已提醒（0 = 未提醒）
          messages       TEXT    NOT NULL DEFAULT '[]',-- JSON 数组（MeetingMessage[]）
          output_kind    TEXT    NOT NULL DEFAULT 'butler', -- 产物落点：'project' | 'butler'
          output_dir     TEXT    NOT NULL DEFAULT ''   -- 产物目录（kind=butler 时为 butler 根下的相对路径）
        );
      `);
      // 迁移：老库补列（SQLite 无 IF NOT EXISTS 的 ADD COLUMN，用 PRAGMA 自查）
      const cols = db.prepare(`PRAGMA table_info(meeting_session)`).all() as Array<{ name: string }>;
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has('output_kind')) db.exec(`ALTER TABLE meeting_session ADD COLUMN output_kind TEXT NOT NULL DEFAULT 'butler'`);
      if (!has('output_dir')) db.exec(`ALTER TABLE meeting_session ADD COLUMN output_dir TEXT NOT NULL DEFAULT ''`);
      return db;
    })();
  }
  _db = await _dbPromise;
  return _db;
}

interface Row {
  active: number;
  meeting_id: string;
  title: string;
  started_at: number;
  last_active_at: number;
  reminded_at: number;
  messages: string;
  output_kind: string;
  output_dir: string;
}

/** 读取单行状态；表内无行时返回"未开启"默认值（不写入，落库由 startMeeting 负责）。 */
async function readState(): Promise<MeetingSessionState> {
  const db = await getDb();
  const row = db.prepare(`SELECT * FROM meeting_session WHERE id = 1`).get() as Row | undefined;
  if (!row) {
    return { active: false, id: '', title: '', startedAt: 0, lastActiveAt: 0, messages: [], remindedAt: 0, outputKind: 'butler', outputDir: '' };
  }
  let messages: MeetingMessage[] = [];
  try {
    const parsed = JSON.parse(row.messages);
    if (Array.isArray(parsed)) messages = parsed as MeetingMessage[];
  } catch { /* 坏数据按空会议处理 */ }
  return {
    active: row.active === 1,
    id: row.meeting_id,
    title: row.title,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    messages,
    remindedAt: row.reminded_at,
    outputKind: row.output_kind === 'project' ? 'project' : 'butler',
    outputDir: row.output_dir || '',
  };
}

/** 覆盖写入单行状态（单行 upsert，id 恒为 1）。 */
async function writeState(s: MeetingSessionState): Promise<void> {
  const db = await getDb();
  db.prepare(
    `INSERT INTO meeting_session (id, active, meeting_id, title, started_at, last_active_at, reminded_at, messages, output_kind, output_dir)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       active = excluded.active,
       meeting_id = excluded.meeting_id,
       title = excluded.title,
       started_at = excluded.started_at,
       last_active_at = excluded.last_active_at,
       reminded_at = excluded.reminded_at,
       messages = excluded.messages,
       output_kind = excluded.output_kind,
       output_dir = excluded.output_dir`,
  ).run(
    s.active ? 1 : 0,
    s.id,
    s.title,
    s.startedAt,
    s.lastActiveAt,
    s.remindedAt,
    JSON.stringify(s.messages),
    s.outputKind,
    s.outputDir,
  );
}

function newMeetingId(): string {
  return `mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 默认会议标题：会议 MM-DD HH:mm */
function defaultTitle(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `会议 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 是否处于活动会议（静默超时视为已结束；过期未消费的会议由 consumeExpiredMeeting 统一收尾） */
export async function isMeetingActive(): Promise<boolean> {
  const s = await readState();
  if (!s.active) return false;
  return Date.now() - s.lastActiveAt <= MEETING_IDLE_TTL_MS;
}

/** 开启一次会议（title 可空 → 默认标题）。已有活动会议则返回 false。 */
export async function startMeeting(
  title?: string,
  output?: { kind?: 'project' | 'butler'; dir?: string },
): Promise<boolean> {
  // 防御：先清掉静默过期的未收尾会议（调用方正常流程已先 consume，这里是兜底）
  await consumeExpiredMeeting();
  if ((await readState()).active) return false;
  const now = Date.now();
  const kind: 'project' | 'butler' = output?.kind === 'project' ? 'project' : 'butler';
  await writeState({
    active: true,
    id: newMeetingId(),
    title: (title || '').trim() || defaultTitle(now),
    startedAt: now,
    lastActiveAt: now,
    messages: [],
    remindedAt: 0,
    outputKind: kind,
    // 默认目录：project 落项目内 homework/，butler 落 butler 根下 meetings/
    outputDir: (output?.dir || '').trim() || (kind === 'butler' ? 'meetings' : 'homework'),
  });
  return true;
}

/** 追加一条内容进会议缓冲（更新最后活动时间；重置 5 分钟提醒标记，重新计时）。未在会议中返回 -1；否则返回累计条数。
 *  time 可选：本条内容在录音时间轴上的「发生时刻」（绝对毫秒）。实时字幕按录音段起点传入，
 *  这样回放时字幕才能与音频对齐（缺省 = 落库时刻，会偏晚一次转写往返）。 */
export async function appendToMeeting(entry: { text: string; type?: MeetingMessage['type']; label?: string; time?: number }): Promise<number> {
  if (!(await isMeetingActive())) return -1;
  const s = await readState();
  const text = (entry.text || '').trim();
  if (!text) return s.messages.length;
  const now = Date.now();
  s.lastActiveAt = now;
  s.remindedAt = 0; // 有新消息：5 分钟提醒重新计时
  s.messages.push({
    type: entry.type ?? 'text',
    label: entry.label ?? '',
    text,
    time: typeof entry.time === 'number' && entry.time > 0 ? entry.time : now,
  });
  await writeState(s);
  return s.messages.length;
}

/**
 * 会议全文转写（每条带 `[mm:ss]` 时间戳）——供回放字幕 / 转写落盘使用。
 * 时间 = 相对会议开始的秒数，格式与 audio-parser 的分块时间戳同口径（跨 100 分钟自然进位成三位）。
 * 注意：这是**给人/播放器看**的版本；送模型生成纪要时请用纯文本，不要把时间戳喂进去。
 *
 * 说话人分块不在这里：**实时会议过程中不做说话人识别**，`[说话人 N]` 一律来自会后的整段
 * 重转（见 api/butler/meeting 的 retranscribe → parseAudio + diarize）。
 */
export function formatTimestampedTranscript(s: Pick<MeetingSession, 'startedAt' | 'messages'>): string {
  const mmss = (absMs: number) => {
    const sec = Math.max(0, Math.floor((absMs - s.startedAt) / 1000));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  };
  return s.messages.map((m) => `[${mmss(m.time)}]\n${m.text}`).join('\n\n');
}

/**
 * 把一段转写里的 `[mm:ss]` 独占行整体平移 offsetSec（秒）。
 *
 * 为什么需要：超过 100MB 的录音会被切成多个小片分别转写（见 api/butler/meeting 的 retranscribe），
 * 每片的时间戳是「片内」口径；平移后才归一到**合并音频**的时间轴——回放字幕直接拿它跟
 * 音频 currentTime 对齐，不平移会整体错位。
 *
 * 只动「独占一行的 `[mm:ss]`」，不碰正文里可能出现的 `[说话人 N]`、方括号内容或行内 `[..]`。
 * 进位与补零口径同 formatTimestampedTranscript（分钟补到两位，跨 100 分钟自然成三位）。
 */
export function shiftTranscriptStamps(text: string, offsetSec: number): string {
  if (!(offsetSec > 0)) return text;
  const shift = Math.floor(offsetSec);
  return text.replace(/^\[(\d{1,3}):(\d{2})\]\s*$/gm, (_m, mm: string, ss: string) => {
    const sec = Number(mm) * 60 + Number(ss) + shift;
    return `[${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}]`;
  });
}

/** 结束会议并返回完整快照（同时清空状态）。未在会议中返回 null。 */
export async function endMeeting(): Promise<MeetingSession | null> {
  const s = await readState();
  if (!s.active) return null;
  const snap: MeetingSession = {
    id: s.id,
    title: s.title,
    startedAt: s.startedAt,
    lastActiveAt: s.lastActiveAt,
    messages: s.messages,
    outputKind: s.outputKind,
    outputDir: s.outputDir,
  };
  await writeState({ active: false, id: '', title: '', startedAt: 0, lastActiveAt: 0, messages: [], remindedAt: 0, outputKind: 'butler', outputDir: '' });
  return snap;
}

/** 检查并消费"已静默超时"的会议（返回快照并清空），供调用方收尾整理。无则 null。 */
export async function consumeExpiredMeeting(): Promise<MeetingSession | null> {
  const s = await readState();
  if (!s.active) return null;
  if (Date.now() - s.lastActiveAt <= MEETING_IDLE_TTL_MS) return null;
  return endMeeting();
}

/** 当前会议状态（供状态展示 / 轮询同步） */
export async function getMeetingState(): Promise<{ active: boolean; title: string | null; count: number }> {
  const s = await readState();
  const active = s.active && Date.now() - s.lastActiveAt <= MEETING_IDLE_TTL_MS;
  return {
    active,
    title: active ? s.title : null,
    count: active ? s.messages.length : 0,
  };
}

/**
 * 会议完整快照（供会议模式视图轮询）：活动状态 + 标题 + 计时起点 + 已记录条数 + 实时字幕流。
 * 与 getMeetingState 的区别：额外带上 startedAt（顶部条计时用）与 messages（实时字幕流）。
 */
export async function getMeetingSnapshot(): Promise<{
  active: boolean;
  title: string | null;
  startedAt: number;
  count: number;
  messages: MeetingMessage[];
  outputKind: 'project' | 'butler';
  outputDir: string;
}> {
  const s = await readState();
  const active = s.active && Date.now() - s.lastActiveAt <= MEETING_IDLE_TTL_MS;
  return {
    active,
    title: active ? s.title : null,
    startedAt: active ? s.startedAt : 0,
    count: active ? s.messages.length : 0,
    messages: active ? s.messages : [],
    outputKind: s.outputKind,
    outputDir: s.outputDir,
  };
}

/** 是否到了 5 分钟静默提醒时机：活动会议 + 距最后消息 ≥5 分钟 + 本段静默尚未提醒过（幂等，只提醒一次） */
export async function isMeetingRemindDue(): Promise<boolean> {
  const s = await readState();
  if (!s.active) return false;
  if (s.remindedAt > 0) return false;
  return Date.now() - s.lastActiveAt >= MEETING_REMIND_AFTER_MS;
}

/** 标记 5 分钟提醒已发送（防止重复提醒）；用户继续发言后由 appendToMeeting 自动重置 */
export async function markMeetingReminded(): Promise<void> {
  const s = await readState();
  if (!s.active) return;
  s.remindedAt = Date.now();
  await writeState(s);
}