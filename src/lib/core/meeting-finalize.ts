/**
 * 会议收尾（共享）：调 /api/core/meeting 按 meeting-minutes schema 整理纪要 → 写入 Butler 收件箱。
 * 返回纪要正文；失败返回空串（调用方按"整理失败"回话）。
 *
 * 三个调用方（P1-b 抽出，此前定义在 executor.ts）：
 *   - 管家会议工具 meeting_end（app/api/chat/tools/meeting.ts）：与 Next 服务端同进程，baseUrl 省略；
 *   - 宿主 executor 的 /meeting out 分支（微信桥经 /api/core/execute 调用；⌘F 面板已退化为纯搜索，不再走此路）；
 *   - 微信桥静默超时定时器：桥是独立进程 → 传 baseUrl（http://localhost:<port>）。
 *
 * 2026-09-27：新增「导入录音」模式（会议面板 Import → api/butler/meeting 的 import_finish）——
 * 它没有会议会话，只有拼好的转写文本，故收口到 finalizeMeetingText / recordTranscriptText。
 * 2026-09-27：抽出 summarizeMeetingText（**只调模型、不落库**）——「按用户要求出纪要、但别写收件箱」
 * 的场景走它；finalizeMeetingText 改调它再落库。
 */
import { insertInbox } from './inbox.ts';
import { NOTIFY_THREAD_ID } from '@/lib/butler/storage';
import type { MeetingSession } from './meeting-session.ts';

/**
 * 只调模型出纪要正文（**不落任何库**）：调 /api/core/meeting 按 meeting-minutes schema 整理。
 * 失败返回空串（调用方按"整理失败"回话）。
 *
 * instruction：用户对本次总结的额外要求（如「只列行动项和负责人」），原样透传给模型；
 * 缺省 = 按默认 schema 出。只要结果、不要落库的场景走这条。
 */
export async function summarizeMeetingText(
  title: string,
  text: string,
  baseUrl?: string,
  speakers?: string,
  instruction?: string,
): Promise<string> {
  try {
    const base = baseUrl ? baseUrl.replace(/\/$/, '') : '';
    const resp = await fetch(`${base}/api/core/meeting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // speakers：会议设置里的参会人数口径（auto 时省略，由模型按内容判断）
      body: JSON.stringify({
        title,
        text,
        ...(speakers ? { speakers } : {}),
        ...(instruction ? { instruction } : {}),
      }),
    });
    const data = await resp.json();
    return data?.success ? String(data.minutes || '').trim() : '';
  } catch (e) {
    console.error('[meeting] summarize failed:', e);
    return '';
  }
}

/**
 * 文本版收尾（**唯一落收件箱的出口**）：出纪要 → 写 Butler 收件箱。
 * 为什么按纯文本而非 session 收口：导入录音模式没有「进行中的会议会话」，
 * 只有一段已拼好的转写文本，但产出口径必须与实时模式完全一致（同一 schema、同一收件箱条目）。
 * dedupeKey 省略 = 不去重（导入模式每次导入都是一次独立产物）。
 */
export async function finalizeMeetingText(
  title: string,
  text: string,
  baseUrl?: string,
  speakers?: string,
  dedupeKey?: string,
): Promise<string> {
  const minutes = await summarizeMeetingText(title, text, baseUrl, speakers);
  if (!minutes) return '';
  try {
    await insertInbox({
      kind: 'meeting',
      title: `会议纪要：${title}`,
      body: minutes,
      source: 'meeting',
      // 会议回执没有自己的会话，落进常驻「Bobby」线程：否则 thread_id 为空、既不属于任何联系人，
      // 又会被角标计入（2026-09-27 修「Bobby 没有未读项却亮着角标」）。
      threadId: NOTIFY_THREAD_ID,
      dedupeKey,
      time: Date.now(),
    });
    return minutes;
  } catch (e) {
    console.error('[meeting] finalize failed:', e);
    return '';
  }
}

export async function finalizeMeeting(
  meeting: MeetingSession,
  baseUrl?: string,
  speakers?: string,
): Promise<string> {
  return finalizeMeetingText(
    meeting.title,
    meeting.messages.map((m) => m.text).join('\n'),
    baseUrl,
    speakers,
    `meeting:${meeting.id}`,
  );
}

/**
 * 不整理、只留档：「会后自动整理」关闭时的收尾。
 * 为什么仍要落收件箱：会议会话一收尾即被清空（导入模式则本就没有会话），不落档等于内容彻底丢失；
 * 落档口径与面板侧一致——只有全文转写，不伪造纪要结构。返回落档正文。
 */
export async function recordTranscriptText(title: string, text: string, dedupeKey?: string): Promise<string> {
  const body = `## 全文转写\n\n${text.trim() || '（无内容）'}\n`;
  await insertInbox({
    kind: 'meeting',
    title: `会议记录：${title}`,
    body,
    source: 'meeting',
    // 同 finalizeMeetingText：无会话的会议回执统一归属常驻「Bobby」线程。
    threadId: NOTIFY_THREAD_ID,
    dedupeKey,
    time: Date.now(),
  });
  return body;
}

export async function recordMeetingTranscript(meeting: MeetingSession): Promise<string> {
  return recordTranscriptText(
    meeting.title,
    meeting.messages.map((m) => m.text).join('\n'),
    `meeting:${meeting.id}`,
  );
}