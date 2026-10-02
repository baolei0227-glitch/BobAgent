/**
 * Butler 常驻「小微」会话（butler-search.ts）
 *
 * 抽屉改成「微信式联系人」模型后，公众号搜索 / 资料整理需要一个可归属的常驻联系人：
 * 它既是联系人列里永远置顶的一行，也专门负责**搜索结果的展示与对话**——
 * 用户搜公众号文章时，抽屉自动切到小微会话，提问作为用户气泡、小微的综述 + 每篇卡片作为回复呈现。
 *
 * 存储复用 Butler 线程（`.state/threads/`，见 lib/butler/threads.ts）：预留常驻 thread（SEARCH_THREAD_ID），
 * source='panel'（永不过期），用户在这个联系人里追问 = 和普通线程一样的完整 Butler 能力（人设偏搜索/资料整理）。
 *
 * 本模块 server-only（经 threads 触达文件存储），仅供服务端路由引用。
 */
import { stripThinkTags, type WechatArticleCard, type WechatSearchTrace, type WechatSearchTraceItem } from '@/lib/bus';
import { readThread, upsertThread, appendThreadMessages, type ButlerThreadSummary, type ButlerPersona, type ChatMessage } from '@/lib/butler/threads';
import { SEARCH_THREAD_ID, SEARCH_TITLE } from '@/lib/butler/storage';
import { PREVIEW_MAX } from '@/lib/butler/threads-shared';

/** 常驻线程 ID / 显示名真源在 lib/butler/storage.ts（那里同时用它解析角色目录），此处再导出保持既有引用可用 */
export { SEARCH_THREAD_ID, SEARCH_TITLE };

/** 小微的默认人设（用户可在「人设」弹窗里改；头像/显示名钉死，不随性格变） */
const SEARCH_PERSONA: ButlerPersona = {
  name: SEARCH_TITLE,
  personality: '严谨、干练、信息密度高',
  role: '搜索与资料整理助手：擅长把问题拆成多个检索方向、检索公众号文章并给出带来源的综合综述',
  style: '简洁、条理清晰、每条结论都标注来源',
  addressUser: '你',
};

/**
 * 常驻会话不存在时建一条空行（幂等），并写入默认人设。
 * 列表接口与 GET ?threadId= 都先调它——否则「小微」在联系人列会时有时无。
 */
export async function ensureSearchThread(): Promise<void> {
  if (await readThread(SEARCH_THREAD_ID)) return;
  await upsertThread(SEARCH_THREAD_ID, [], 'panel', { modelId: null, thinkingLevel: null });
  // 写入默认人设（upsertThread 不透传 persona，单独补一次）
  const { setThreadPersona } = await import('@/lib/butler/threads');
  await setThreadPersona(SEARCH_THREAD_ID, SEARCH_PERSONA);
}

/**
 * 常驻联系人摘要（联系人列置顶行，紧随「Recorder」）。
 * 标题固定「小微」；副标题取最新一条 assistant 回复（剥 think 后截断），没聊过给一句说明。
 */
export async function buildSearchSummary(): Promise<ButlerThreadSummary & { pinned: true; systemRole: 'search' }> {
  await ensureSearchThread();
  const session = await readThread(SEARCH_THREAD_ID);
  const lastAssistant = [...(session?.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'assistant' && m.content.trim());
  const preview = lastAssistant
    ? stripThinkTags(lastAssistant.content).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX)
    : '';
  return {
    threadId: SEARCH_THREAD_ID,
    source: 'panel',
    lifecycle: session?.lifecycle ?? 'active',
    createdAt: session?.createdAt ?? Date.now(),
    updatedAt: session?.updatedAt ?? Date.now(),
    messageCount: session?.messages.length ?? 0,
    title: SEARCH_TITLE,
    preview: preview || '搜索公众号文章、整理资料，结果会在这里聊给你听',
    persona: session?.persona ?? SEARCH_PERSONA,
    unread: 0,
    pinned: true,
    systemRole: 'search',
  };
}

/**
 * 把一次搜索「用户提问 + 小微综述 + 文章卡片」作为一条对话补进小微常驻线程（落库，供续聊保持上下文）。
 *
 * 综述以 markdown 文本落库（digest + 要点列表）；**检索到的文章卡片随之一起落库**
 * （挂在 assistant 消息的 `cards` 字段上，见 lib/bus.ts ChatMessage.cards）——
 * 这样「检索了哪些文章」是会话历史的一部分：刷新后仍在、可直接点开原文，
 * 不再依赖前端临时浮层（旧实现卡片不进库，面板一关就没了）。
 *
 * `trace`（实况账本，2026-10-01 新增）同样挂在这条 assistant 消息上（`ChatMessage.searchTrace`）：
 * 卡片只记「留下了什么」，账本还记「哪些被判定掉了、为什么」——气泡下方的入口据此重开右栏。
 * 两条生命周期刻意**绑在消息上**：消息在则都能回看，消息删则一起消失（用户口径）。
 *
 * `plan`（规划器给的方向与意图）也一并落库：没有它就**无法归因**——
 * "12 篇里只有 2 篇相关"到底是规划器方向不好，还是搜狗在这个方向上的排序不好，事后查不出来。
 */
export async function recordSearchExchange(
  query: string,
  summaryMarkdown: string,
  cards: WechatArticleCard[] = [],
  trace: WechatSearchTraceItem[] = [],
  plan?: { queries?: string[]; intent?: string },
): Promise<void> {
  if (!query.trim() && !summaryMarkdown.trim()) return;
  const msgs: ChatMessage[] = [];
  if (query.trim()) msgs.push({ role: 'user', content: query.trim() });
  if (summaryMarkdown.trim() || cards.length || trace.length) {
    const assistant: ChatMessage = { role: 'assistant', content: summaryMarkdown.trim() };
    if (cards.length) assistant.cards = cards;
    // 实况账本随消息落库（2026-10-01）：消息下方的「查看检索实况」入口要能随时重开，
    // 靠的就是这份字段；消息被删，账本一并消失（deleteThreadMessages 整条删）。
    if (trace.length && query.trim()) {
      const st: WechatSearchTrace = { query: query.trim(), items: trace };
      // 检索方向 / 意图：空值不写字段（老轮次没有它们，回看时的 UI 要能区分"没有"与"空数组"）
      const qs = (plan?.queries ?? []).map((s) => (s || '').trim()).filter(Boolean);
      if (qs.length) st.queries = qs;
      const intent = (plan?.intent ?? '').trim();
      if (intent) st.intent = intent;
      assistant.searchTrace = st;
    }
    msgs.push(assistant);
  }
  try {
    await appendThreadMessages(SEARCH_THREAD_ID, msgs, 'panel');
  } catch (e) {
    console.warn('[butler-search] 搜索对话落库失败（不影响展示）:', e instanceof Error ? e.message : String(e));
  }
}
