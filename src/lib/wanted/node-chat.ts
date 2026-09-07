/**
 * WANTED /chat 会话核心逻辑（原"临时问答节点"，已与 ChatNode 彻底语义隔离）
 *
 * 用户在 wanted 面板 / 微信输入 `/chat 问题` 时：
 *   1. 决定会话 threadId：
 *      - 显式 threadIdHint（⌘F 面板续聊，对应 BobMail 邮件线程）优先
 *      - 其次复用 30min 活动窗口内的线程绑定（reuseThreadId）
 *      - 否则新建（/chat out 后首问 / /chat new / 无活动绑定）
 *   2. 从会话存储（chat_sessions 表）加载历史 messages → 组装对话（沙盒系统提示 + 历史 + 新问题）
 *   3. 调 /api/chat（显式 sandbox，不传 projectId/nodeId，避免节点文件依赖）
 *   4. 聚合 SSE 流为完整文本 → 写回会话存储（panel 长期保留；wechat 24 小时过期）
 *   5. 返回 reply + messages + threadId
 *
 * 生命周期：panel 会话长期保留（对应 BobMail 邮件线程）；wechat 会话 24 小时过期；
 * 过期由 chat-session 的 60s 周期 sweep 兜底清理。
 */
import { readSettingsFromFile } from '@/lib/settings-server';
import { PROVIDER_PRESETS } from '@/lib/types';
import {
  upsertChatSession,
  loadChatSession,
  type ChatSessionSource,
} from '@/lib/wanted/chat-session';
import type { ChatMessage } from '@/lib/bus';

/** 兼容占位 ID（仅用于 /api/chat 的 gateway 占位，非实际落盘文件） */
export const TEMP_NODE_ID = 'temporary-node';
/** 会话保留最近 N 轮（= 2*N 条 user/assistant）；超出裁剪最早对话对 */
export const CHAT_MAX_ROUNDS = 20;

interface TempNodeModel {
  /** 是否自定义 provider（true 传 apiKey/baseUrl/providerModelId；false 只传托管 modelId） */
  custom: boolean;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  providerModelId?: string;
}

/** 解析 /chat 使用的模型：第一个已配置的自定义 provider（无则报错引导配置） */
export async function resolveTempNodeModel(): Promise<TempNodeModel> {
  const settings = await readSettingsFromFile();
  for (const prov of settings.providers) {
    if (prov.apiKey && prov.selectedModels && prov.selectedModels.length > 0) {
      const firstChat =
        prov.selectedModels.find((s) => typeof s !== 'string' && !s.modelId.match(/vision|vl|embedding|rerank|audio/i)) ||
        prov.selectedModels[0];
      const modelId = typeof firstChat === 'string' ? firstChat : firstChat.modelId;
      if (!modelId) continue;
      const baseUrl = prov.baseUrl?.trim() || PROVIDER_PRESETS.find((p) => p.type === prov.type)?.baseUrl;
      if (!baseUrl) continue;
      return {
        custom: true,
        providerModelId: modelId,
        apiKey: prov.apiKey,
        baseUrl,
      };
    }
  }
  throw new Error('No model configured. Please add a provider model in Settings → Models before using /chat.');
}

/** 沙盒约束提示：Node 模式为纯问答，禁止写类工具产生任何副作用。
 *  唯一定义源——executor / UnifiedPalette / askFromMail 均从此导入，杜绝多处副本不一致。 */
export const SANDBOX_SYSTEM_PROMPT =
  '当前为 WANTED 临时问答模式（Node 模式）。你主要回答用户的提问，严格禁止执行多数有副作用的操作：' +
  '不调用 write_file / rename_file / delete_file / run_command / execute_script / draw 等写类工具，' +
  '不写入待办、日历或任何文件。' +
  '笔记/知识库（notebook）能力 2026-09-06 起收归画布「知识库（Kar）节点」专职承载，本临时问答不注入笔记工具——' +
  '用户明确要查阅/记录/整理笔记时，请引导其使用 ⌘F / 微信的 /note 指令（/note check 查阅、/note 记录、/note ingest 编译）' +
  '或打开画布 Kar 节点操作，不要尝试调用不存在的 read_notebook 等工具。';

/**
 * 向 /chat 会话提问（原 askTempNode，已脱离节点文件模型）：
 *   - opts.reuseThreadId: 30min 活动窗口内绑定的 threadId → 复用该会话历史；
 *   - opts.threadIdHint: ⌘F 面板传入的 BobMail 线程 ID（续聊优先）；
 *   - opts.source: 'panel'（长期保留）| 'wechat'（24 小时过期）。
 *
 * 返回 { reply, messages, threadId }：threadId 用于调用方将新绑定写回 node-mode 的 activeThreadId。
 */
export async function askTempNode(
  question: string,
  opts: {
    baseUrl?: string;
    reuseThreadId?: string | null;
    threadIdHint?: string;
    source?: ChatSessionSource;
  } = {},
): Promise<{ ok: boolean; reply: string; messages?: ChatMessage[]; threadId: string }> {
  const source: ChatSessionSource = opts.source ?? 'panel';
  const base = opts.baseUrl ? opts.baseUrl.replace(/\/$/, '') : '';

  // 1. 决定 threadId：显式 hint > 活动绑定复用；复用目标不存在/已过期则视为新会话
  let threadId = opts.threadIdHint || opts.reuseThreadId || null;
  let session = threadId ? await loadChatSession(threadId) : null;
  if (threadId && !session) {
    // 会话缺失（wechat 24h 过期被清 / 从未落库）→ 退化为新会话
    threadId = null;
  }
  if (!threadId) {
    threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session = null;
  }

  // 2. 组装消息：历史会话（含 system prompt）或全新 system + 新问题
  const history = session?.messages ?? [];
  const baseMessages: ChatMessage[] =
    history.length > 0 && history[0]?.role === 'system'
      ? [...history]
      : [{ role: 'system', content: SANDBOX_SYSTEM_PROMPT }, ...history];
  const messages: ChatMessage[] = [...baseMessages, { role: 'user', content: question }];

  // 3. 调 /api/chat（sandbox 问答，不绑定项目/节点 → 不传 projectId/nodeId，内部回退 sandbox 兜底路径）
  const model = await resolveTempNodeModel();
  const ac = new AbortController();
  const timeoutTimer = setTimeout(() => ac.abort(new Error('请求超时（180 秒），请稍后重试或简化问题')), 180_000);
  try {
    const chatResp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        messages,
        nodeId: TEMP_NODE_ID,
        thinkingLevel: 'medium',
        sandbox: true,
        ...(model.custom
          ? { apiKey: model.apiKey, baseUrl: model.baseUrl, providerModelId: model.providerModelId }
          : { modelId: model.modelId }),
      }),
    });
    clearTimeout(timeoutTimer);

    if (!chatResp.ok) {
      let errText = '';
      try { errText = (await chatResp.json()).error || ''; } catch { /* 非 JSON */ }
      return { ok: false, reply: errText || `节点请求失败（HTTP ${chatResp.status}）`, threadId };
    }

    const raw = await chatResp.text();
    const ct = chatResp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        const jsonErr = JSON.parse(raw);
        return {
          ok: false,
          reply: (jsonErr.error || jsonErr.message || jsonErr.reply || '服务端错误') as string,
          threadId,
        };
      } catch {
        // 解析失败：继续走 SSE 兜底
      }
    }

    // 4. 聚合 SSE 流：拼接 content + reasoning（用 <think> 包裹在前面，避免思考丢失）
    let answer = '';
    let reasoning = '';
    for (const chunk of raw.split('\n\n')) {
      const line = chunk.trim();
      if (!line.startsWith('data:')) continue;
      try {
        const data = JSON.parse(line.slice(5).trim());
        if (data.error) {
          return { ok: false, reply: String(data.error), threadId };
        }
        if (typeof data.reasoning === 'string' && data.reasoning) reasoning += data.reasoning;
        if (typeof data.content === 'string') answer += data.content;
      } catch {
        // 忽略无法解析的 chunk
      }
    }
    const thinkWrapped = reasoning ? `<think>${reasoning}</think>\n` : '';
    const combinedAnswer = thinkWrapped + answer;

    if (!combinedAnswer.trim()) {
      return { ok: false, reply: '节点未返回有效内容，请重试', threadId };
    }

    // 5. 写回会话存储（panel 长期；wechat 24 小时过期），连续提问保持上下文
    const fullMessages = trimChatMessages([
      ...messages,
      { role: 'assistant' as const, content: combinedAnswer },
    ]);
    try {
      await upsertChatSession(threadId, fullMessages, source);
    } catch (e) {
      console.warn('[chat-session] 会话写入失败（不影响回复）:', e instanceof Error ? e.message : String(e));
    }

    return { ok: true, reply: combinedAnswer, messages: fullMessages, threadId };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { ok: false, reply: e.message || '请求超时，请稍后重试', threadId };
    }
    return { ok: false, reply: e?.message || String(e) || '网络错误', threadId };
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/**
 * 裁剪 messages：保留 system prompt + 最近 CHAT_MAX_ROUNDS 轮 user/assistant 对。
 * 超出时丢弃最旧的 user+assistant 对（保证 system prompt 始终存在）。
 */
export function trimChatMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const sys = messages[0]?.role === 'system' ? messages[0] : null;
  const rest = sys ? messages.slice(1) : messages;
  // rest 按 [user, assistant, user, assistant, ...] 交替，最后一个可能是 user（待提问时）
  const maxPairs = CHAT_MAX_ROUNDS * 2;
  // 如果最后是单个 user（还没有 assistant 回答），裁剪时也要保留它（因此保留最右奇数条）
  let trimmed = rest;
  if (trimmed.length > maxPairs) {
    const overflow = trimmed.length - maxPairs;
    // 向偶数对齐向下切：overflow 如果是奇数，多删 1 条让剩余开头是 user
    const sliceStart = (overflow % 2) === 0 ? overflow : overflow + 1;
    trimmed = trimmed.slice(sliceStart);
    // 兜底：如果 slice 后开头是 assistant（前一个 user 被切掉了），再前进一步
    if (trimmed[0]?.role === 'assistant') {
      trimmed = trimmed.slice(1);
    }
  }
  return sys ? [sys, ...trimmed] : trimmed;
}

/** SSE 聚合：与 askTempNode 内联逻辑一致，抽出供 askFromMail 复用
 *  返回 answer 会把 reasoning 用 <think> 包裹在 content 最前面：
 *   · 会话存储保留完整（多轮上下文模型能看到自己之前的思考，不丢失标签风格）
 *   · 展示层（微信 / BobMail）经 stripThinkTags 剥离思考块，只显示正文 */
function aggregateSse(raw: string): { ok: boolean; answer: string; reasoning: string; error?: string } {
  let answer = '';
  let reasoning = '';
  for (const chunk of raw.split('\n\n')) {
    const line = chunk.trim();
    if (!line.startsWith('data:')) continue;
    try {
      const data = JSON.parse(line.slice(5).trim());
      if (data.error) return { ok: false, answer: '', reasoning: '', error: String(data.error) };
      if (typeof data.reasoning === 'string' && data.reasoning) reasoning += data.reasoning;
      if (typeof data.content === 'string') answer += data.content;
    } catch {
      // 忽略无法解析的 chunk
    }
  }
  const thinkWrapped = reasoning ? `<think>${reasoning}</think>\n` : '';
  const combined = thinkWrapped + answer;
  if (!combined.trim()) return { ok: false, answer: '', reasoning: '', error: '模型未返回有效内容，请重试' };
  return { ok: true, answer: combined, reasoning };
}

/**
 * 邮件式 chat 线程回复：直接用邮件携带的 messages（已含沙盒 system prompt + 历史对话）
 * 追加新用户问题调 /api/chat。无临时项目依赖，无 TTL 限制。
 *
 * 返回新回答文本 + 更新后的 messages（调用方用于生成新的 chat 通知）。
 * opts.baseUrl 用于 Node 端显式传服务地址；浏览器端省略（相对路径）。
 */
export async function askFromMail(
  prevMessages: ChatMessage[] | undefined,
  replyText: string,
  opts: { baseUrl?: string } = {},
): Promise<{ ok: boolean; reply: string; messages: ChatMessage[] }> {
  if (!replyText.trim()) {
    return { ok: false, reply: '回复内容为空', messages: prevMessages ?? [] };
  }

  const base: ChatMessage[] =
    Array.isArray(prevMessages) && prevMessages.length > 0
      ? [...prevMessages]
      : [{ role: 'system', content: SANDBOX_SYSTEM_PROMPT }];
  if (base[0]?.role !== 'system') {
    base.unshift({ role: 'system', content: SANDBOX_SYSTEM_PROMPT });
  }

  // ⭐ 防御性规范化：历史消息中若 reasoning 存于独立字段但 content 未包 <think>，
  // 则在此处回填 think 标签，避免模型多轮后丢失包标签习惯。
  // askTempNode 产出的 BobMail 消息 content 已带 think 标签（正常路径不会命中），
  // 此分支用于兼容：① 早期版本遗留的无标签历史；② 手工同步/导入的消息；
  // ③ CanvasFlow 加载的节点消息（reasoning 与 answer 分字段存储）被带入邮件线程。
  for (const m of base) {
    const cast = m as unknown as { reasoning?: string };
    if (m.role === 'assistant' && cast.reasoning && cast.reasoning.trim().length > 0) {
      if (!/(^\s*<think[\s>])|<think>/i.test(m.content)) {
        (m as { content: string }).content = `<think>${cast.reasoning}</think>\n` + m.content;
      }
    }
  }

  const trimmed = trimChatMessages(base);
  const messages: ChatMessage[] = [...trimmed, { role: 'user', content: replyText.trim() }];

  const model = await resolveTempNodeModel();

  const baseUrl = opts.baseUrl ? opts.baseUrl.replace(/\/$/, '') : '';
  const ac = new AbortController();
  const timeoutTimer = setTimeout(() => ac.abort(new Error('请求超时（180 秒），请稍后重试或简化问题')), 180_000);
  try {
    const chatResp = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        messages,
        // 邮件式回复不绑定具体项目/节点，占位使用 TEMP_NODE_ID 以复用现有 gateway 路径；
        // 注意：不传 projectId，避免虚假 ID 引发 getProjectById 抛错干扰工具执行；
        // /api/chat 会在内部尝试 getCurrentProject，失败则回退到 sandbox 兜底路径
        nodeId: TEMP_NODE_ID,
        thinkingLevel: 'medium',
        sandbox: true,
        ...(model.custom
          ? { apiKey: model.apiKey, baseUrl: model.baseUrl, providerModelId: model.providerModelId }
          : { modelId: model.modelId }),
      }),
    });
    clearTimeout(timeoutTimer);

    if (!chatResp.ok) {
      let errText = '';
      try { errText = (await chatResp.json()).error || ''; } catch { /* 非 JSON */ }
      return { ok: false, reply: errText || `请求失败（HTTP ${chatResp.status}）`, messages };
    }

    const raw = await chatResp.text();
    const ct = chatResp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        const jsonErr = JSON.parse(raw);
        return {
          ok: false,
          reply: (jsonErr.error || jsonErr.message || jsonErr.reply || '服务端错误') as string,
          messages,
        };
      } catch {
        // 解析失败：继续走 SSE 兜底
      }
    }

    const agg = aggregateSse(raw);
    if (!agg.ok) {
      return { ok: false, reply: agg.error as string, messages };
    }

    const finalMessages = trimChatMessages([...messages, { role: 'assistant', content: agg.answer }]);
    return { ok: true, reply: agg.answer, messages: finalMessages };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { ok: false, reply: e.message || '请求超时，请稍后重试', messages };
    }
    return { ok: false, reply: e?.message || String(e) || '网络错误', messages };
  } finally {
    clearTimeout(timeoutTimer);
  }
}
