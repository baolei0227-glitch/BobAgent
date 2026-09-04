/**
 * WANTED /meeting 会议会话状态（进程内单例）
 *
 * /meeting 开启后进入会议会话：后续输入（文字 + 微信桥媒体转写）全部积累进缓冲，
 * 直到输入 `/meeting out` 或静默超过 10 分钟自动视为会议结束，由 executor 触发
 * AI 整理（meeting-minutes schema）→ 发送 BobMail。
 *
 * 面板与微信桥共享同一执行进程（/api/wanted/execute），因此进程内单例双端一致。
 *
 * ⚠️ 本模块被客户端组件（UnifiedPalette，⌘F 面板）引用，禁止 import 任何服务端模块。
 */

export interface MeetingMessage {
  type: 'text' | 'voice' | 'image' | 'file' | 'video';
  /** 类型标注（如「图片·OCR」；媒体经桥接层转文字后自带的 [图片识别结果] 前缀即标注） */
  label: string;
  text: string;
  time: number;
}

export interface MeetingSession {
  /** 会议唯一 id（BobMail 幂等键用） */
  id: string;
  title: string;
  startedAt: number;
  lastActiveAt: number;
  messages: MeetingMessage[];
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

const state: MeetingSessionState = {
  active: false,
  id: '',
  title: '',
  startedAt: 0,
  lastActiveAt: 0,
  messages: [],
  remindedAt: 0,
};

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
export function isMeetingActive(): boolean {
  if (!state.active) return false;
  return Date.now() - state.lastActiveAt <= MEETING_IDLE_TTL_MS;
}

/** 开启一次会议（title 可空 → 默认标题）。已有活动会议则返回 false。 */
export function startMeeting(title?: string): boolean {
  // 防御：先清掉静默过期的未收尾会议（executor 正常流程已先 consume，这里是兜底）
  consumeExpiredMeeting();
  if (state.active) return false;
  const now = Date.now();
  state.active = true;
  state.id = newMeetingId();
  state.title = (title || '').trim() || defaultTitle(now);
  state.startedAt = now;
  state.lastActiveAt = now;
  state.messages = [];
  state.remindedAt = 0;
  return true;
}

/** 追加一条内容进会议缓冲（更新最后活动时间；重置 5 分钟提醒标记，重新计时）。未在会议中返回 -1；否则返回累计条数。 */
export function appendToMeeting(entry: { text: string; type?: MeetingMessage['type']; label?: string }): number {
  if (!isMeetingActive()) return -1;
  const text = (entry.text || '').trim();
  if (!text) return state.messages.length;
  state.lastActiveAt = Date.now();
  state.remindedAt = 0; // 有新消息：5 分钟提醒重新计时
  state.messages.push({
    type: entry.type ?? 'text',
    label: entry.label ?? '',
    text,
    time: Date.now(),
  });
  return state.messages.length;
}

/** 结束会议并返回完整快照（同时清空状态）。未在会议中返回 null。 */
export function endMeeting(): MeetingSession | null {
  if (!state.active) return null;
  const snap: MeetingSession = {
    id: state.id,
    title: state.title,
    startedAt: state.startedAt,
    lastActiveAt: state.lastActiveAt,
    messages: state.messages,
  };
  state.active = false;
  state.id = '';
  state.title = '';
  state.startedAt = 0;
  state.lastActiveAt = 0;
  state.messages = [];
  state.remindedAt = 0;
  return snap;
}

/** 检查并消费"已静默超时"的会议（返回快照并清空），供 executor 收尾整理。无则 null。 */
export function consumeExpiredMeeting(): MeetingSession | null {
  if (!state.active) return null;
  if (Date.now() - state.lastActiveAt <= MEETING_IDLE_TTL_MS) return null;
  return endMeeting();
}

/** 当前会议状态（供面板展示 / 轮询同步） */
export function getMeetingState(): { active: boolean; title: string | null; count: number } {
  const active = isMeetingActive();
  return {
    active,
    title: active ? state.title : null,
    count: active ? state.messages.length : 0,
  };
}

/** 是否到了 5 分钟静默提醒时机：活动会议 + 距最后消息 ≥5 分钟 + 本段静默尚未提醒过（幂等，只提醒一次） */
export function isMeetingRemindDue(): boolean {
  if (!state.active) return false;
  if (state.remindedAt > 0) return false;
  return Date.now() - state.lastActiveAt >= MEETING_REMIND_AFTER_MS;
}

/** 标记 5 分钟提醒已发送（防止重复提醒）；用户继续发言后由 appendToMeeting 自动重置 */
export function markMeetingReminded(): void {
  if (state.active) state.remindedAt = Date.now();
}
