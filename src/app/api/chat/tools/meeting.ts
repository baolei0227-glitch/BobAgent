/**
 * 管家会议工具（P1-b · `/meeting` 工具化）
 *
 * 统一入口后斜杠命令只是入口语法糖：`/meeting 标题` 被入口归一化成
 * 「意图：会议记录（…）」+ 正文，由**管家按本文件的工具**办事（微信 / Butler 抽屉 / ⌘F 面板同源）。
 *
 * 会议缓冲为**全局单场**（meeting-session.ts，P1-d 起落 SQLite .inbox.db 单行）：
 *   - meeting_start  → startMeeting()       开启（标题可空 → 默认"会议 MM-DD HH:mm"）
 *   - meeting_append → appendToMeeting()    累积一条（会议进行中每条输入，原样记录）
 *   - meeting_end    → endMeeting() + 纪要整理 → Butler 收件箱（复用 core/meeting-finalize）
 *
 * 模型如何知道"会议进行中"：route 经
 * ContextRuntime.buildMeetingStateInjection() 注入当前会议状态（低频动态通道）。
 * P1-b 起仅管家（identity==='butler'）注入；2026-09-26 放宽为全身份（route 按画像 gate：
 * dynamic 画像恒可注入，fixed 画像须 fixedScenes 含 butler）→
 * 主对话（画布 chat 节点）同样可用：开会靠 detectSceneHints 的「会议/纪要/开会/meeting」命中本场景，
 * 会议进行中 route 还会直接补放行本场景，保证状态注入与三件工具同时在场（否则反向错位）。
 */
import {
  isMeetingActive,
  startMeeting,
  appendToMeeting,
  endMeeting,
  consumeExpiredMeeting,
  getMeetingState,
} from '@/lib/core/meeting-session';
import { finalizeMeeting } from '@/lib/core/meeting-finalize';
import type { Tool, ToolExecContext } from './index';

/** 兜底收尾静默超时的会议：startMeeting 内部会直接丢弃过期会议（否则内容丢失），故先扫一次。
 *  异步执行不阻塞本次调用（与原 executor 同一处理：先收尾旧会议，再开新会议）。 */
async function sweepExpiredMeeting(ctx?: ToolExecContext): Promise<void> {
  const expired = await consumeExpiredMeeting();
  if (expired) void finalizeMeeting(expired, ctx?.baseUrl).catch(() => {});
}

/** 开启会议 */
async function toolMeetingStart(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  await sweepExpiredMeeting(ctx);
  const title = String(args.title ?? '').trim();
  if (await isMeetingActive()) {
    const st = await getMeetingState();
    return JSON.stringify({
      ok: true,
      already_active: true,
      title: st.title,
      count: st.count,
      message: `已有会议「${st.title}」进行中（已记录 ${st.count} 条）。继续记录用 meeting_append；结束并整理纪要用 meeting_end（等同用户说 /meeting out）。不要重复开启。`,
    });
  }
  if (!(await startMeeting(title || undefined))) {
    return JSON.stringify({ ok: false, error: '无法开启会议：已有未收尾的会议，请先结束它（meeting_end）再开新会议。' });
  }
  const st = await getMeetingState();
  return JSON.stringify({
    ok: true,
    title: st.title,
    count: 0,
    message: `会议「${st.title}」已开启。此后用户每条消息默认都调用 meeting_append 原样记录（用户无需再敲指令）；用户说 /meeting out 或要求整理时调用 meeting_end。请把"已开启"如实告知用户。`,
  });
}

/** 累积一条会议内容 */
async function toolMeetingAppend(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text ?? '').trim();
  if (!text) return JSON.stringify({ ok: false, error: 'text 不能为空' });
  const count = await appendToMeeting({ text });
  if (count < 0) {
    return JSON.stringify({
      ok: false,
      error: 'no_meeting',
      message: '当前没有进行中的会议，本条未记录。若用户是要开会，请调用 meeting_start。',
    });
  }
  return JSON.stringify({
    ok: true,
    count,
    message: `已记录（第 ${count} 条）。不要回应、总结或另起任务，简短确认即可。`,
  });
}

/** 结束会议并整理纪要 */
async function toolMeetingEnd(_args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  const snap = await endMeeting();
  if (!snap) {
    return JSON.stringify({
      ok: false,
      error: 'no_meeting',
      message: '当前没有进行中的会议，无需整理。若用户是要开会，请调用 meeting_start。',
    });
  }
  if (snap.messages.length === 0) {
    return JSON.stringify({
      ok: true,
      title: snap.title,
      empty: true,
      message: `会议「${snap.title}」已结束（无内容，未生成纪要）。请如实告知用户。`,
    });
  }
  const minutes = await finalizeMeeting(snap, ctx?.baseUrl);
  if (!minutes) {
    return JSON.stringify({
      ok: false,
      title: snap.title,
      error: `会议「${snap.title}」已结束，但纪要整理失败（模型未配置或调用失败），请告知用户稍后重试。`,
    });
  }
  return JSON.stringify({
    ok: true,
    title: snap.title,
    count: snap.messages.length,
    minutes,
    message: '纪要已写入 Butler 收件箱。请把 minutes 原文完整转述给用户，不要自行改写或省略。',
  });
}

export const meetingToolDefs: Tool[] = [
  {
    name: 'meeting_start',
    description:
      'Start a meeting-recording session (Butler). Once started, EVERY incoming user message is meeting content and should be recorded verbatim with meeting_append until meeting_end (or 10 min of silence, which auto-closes and compiles the minutes). Use it when the user asks to record/dictate a meeting or sends the /meeting shortcut (「意图：会议记录」). If a meeting is already in progress it is NOT restarted — the running one is reported.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional meeting title, e.g. "姜晓彤案推进会". Defaults to "会议 MM-DD HH:mm".',
        },
      },
      required: [],
    },
    category: '系统',
    execute: toolMeetingStart,
    maxOutput: 1200,
  },
  {
    name: 'meeting_append',
    description:
      'Record ONE entry verbatim into the meeting currently in progress — plain text, dictated words, or transcribed voice/image/file content (keep annotations like [图片识别结果] as-is). Call it for EVERY incoming message while a meeting is active (the injected context tells you when). Do NOT summarize, answer, act on, or restructure the content — just record it. If no meeting is in progress the call reports so; check with the user before starting a new one.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The meeting content to record, verbatim.' },
      },
      required: ['text'],
    },
    category: '系统',
    execute: toolMeetingAppend,
    maxOutput: 800,
  },
  {
    name: 'meeting_end',
    description:
      'End the meeting in progress, compile structured minutes (meeting-minutes schema: discussion points / decisions / action items / open items) and deliver them to the Butler inbox. Call it when the user ends the meeting (/meeting out) or asks to wrap up / 整理纪要. The returned minutes are already final — relay them to the user as-is.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    category: '系统',
    execute: toolMeetingEnd,
    maxOutput: 12000,
  },
];