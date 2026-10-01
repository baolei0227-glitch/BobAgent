/**
 * Butler 常驻「Recorder」会话（butler-recorder.ts）
 *
 * 会议记录员是**会议专属**的常驻联系人（钉在联系人列「Bobby」下方）：
 * 用户与它对话即可 (a) 检索过往会议内容，(b) 按自定义要求生成会议总结。
 *
 * 它的「能力」不靠硬编码问答，而是靠**专属 Agent 画像**（profiles.ts 的 RECORDER_PROFILE）把
 * 工具面收口到会议场景（meeting_search / meeting_summarize），身份分支见 lib/butler/entry.ts。
 * 本模块只负责会话本身：**固定落点**（RECORDER_THREAD_ID）+ 列表摘要，
 * 与 butler-notify.ts 同构（source='panel' 长期保留，联系人必须常在）。
 *
 * 本模块 server-only（经 threads 触达文件存储），仅供服务端路由引用。
 */
import { stripThinkTags } from '@/lib/bus';
import { countUnreadAssistant } from '@/lib/butler/threads-shared';
import { readThread, upsertThread, type ButlerThreadSummary } from '@/lib/butler/threads';
import { RECORDER_THREAD_ID, RECORDER_TITLE } from '@/lib/butler/storage';

/** 常驻线程 ID / 显示名真源为 lib/butler/storage.ts，此处再导出保持既有引用可用 */
export { RECORDER_THREAD_ID, RECORDER_TITLE };

/** 副标题截断上限（与 threads 列表口径一致的单行截断） */
const PREVIEW_MAX = 64;

/**
 * 常驻会话不存在时建一条空行（幂等）。列表接口先调它——否则「Recorder」在联系人列会时有时无。
 * source='panel' → 长期保留：联系人必须常在。
 */
export async function ensureRecorderSession(): Promise<void> {
  if (await readThread(RECORDER_THREAD_ID)) return;
  await upsertThread(RECORDER_THREAD_ID, [], 'panel');
}

/**
 * 常驻联系人摘要（联系人列置顶行，紧随「Bobby」）。
 * 标题固定「Recorder」；副标题取最近一条 assistant 回复（剥 think 后截断），未聊过给一句说明。
 */
export async function buildRecorderSummary(): Promise<ButlerThreadSummary & { pinned: true; systemRole: 'recorder' }> {
  await ensureRecorderSession();
  const session = await readThread(RECORDER_THREAD_ID);
  const lastAssistant = [...(session?.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'assistant' && m.content.trim());
  const preview = lastAssistant
    ? stripThinkTags(lastAssistant.content).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX)
    : '';
  return {
    threadId: RECORDER_THREAD_ID,
    source: 'panel',
    lifecycle: session?.lifecycle ?? 'active',
    createdAt: session?.createdAt ?? Date.now(),
    updatedAt: session?.updatedAt ?? Date.now(),
    messageCount: session?.messages.length ?? 0,
    title: RECORDER_TITLE,
    preview: preview || 'Search past meetings, or ask me to summarize them',
    persona: session?.persona ?? null,
    unread: countUnreadAssistant(
      session?.messages ?? [],
      session?.tailTimes ?? [],
      session?.readAt ?? 0,
      session?.updatedAt ?? 0,
    ),
    pinned: true,
    systemRole: 'recorder',
  };
}
