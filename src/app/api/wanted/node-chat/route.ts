/**
 * POST /api/wanted/node-chat
 *
 * WANTED /chat 指令的服务端入口：
 * 接收问题文本 → 交给 /chat 会话（独立会话存储，已与 ChatNode 彻底隔离）
 * → 聚合回复返回。浏览器端与微信桥（Node 端）共用。
 *
 * 会话复用机制：
 *   body.reuseThreadId = 30min 活动窗口内绑定的 threadId → 复用该会话历史（保持 LLM 上下文）
 *   body.threadIdHint = ⌘F 面板传入的 BobMail 线程 ID（续聊优先）
 *   未传或会话已过期 → 自动新建会话
 * 生命周期：
 *   30min node-mode 解绑（线程标记层，会话存储保留）
 *   wechat 会话 24 小时过期 / panel 会话长期保留（chat_sessions 表，60s sweep 兜底清理）
 */
import { NextRequest, NextResponse } from 'next/server';
import { askTempNode } from '@/lib/wanted/node-chat';
import { loadChatSession, sweepChatSessions } from '@/lib/wanted/chat-session';
import { getActiveThreadBinding, getNodeModeState } from '@/lib/wanted/node-mode';
import { getMeetingState } from '@/lib/wanted/meeting-session';
import type { ChatMessage } from '@/lib/bus';

/** GET /api/wanted/node-chat — 查询 Node 模式状态 + 活动会话对话历史（供 overlay 页面）
 *  返回当前绑定的 threadId（若无活动绑定则返回空 conversations，不自动创建）
 *  同时附带 /meeting 会议状态（meetingActive / meetingTitle / meetingCount），供 ⌘F 面板轮询同步 */
export async function GET() {
  const modeState = getNodeModeState();
  const meetingState = getMeetingState();
  const meetingExtra = {
    meetingActive: meetingState.active,
    meetingTitle: meetingState.title,
    meetingCount: meetingState.count,
  };
  const binding = getActiveThreadBinding();
  if (!modeState.active || !binding.threadId) {
    return NextResponse.json({ success: true, ...modeState, ...meetingExtra, conversations: [] });
  }
  try {
    const session = await loadChatSession(binding.threadId);
    return NextResponse.json({
      success: true,
      ...modeState,
      ...meetingExtra,
      threadId: binding.threadId,
      // 仅返回 user/assistant 对话对（不含 system prompt），与旧 parseNodeMarkdown conversations 语义对齐
      conversations: (session?.messages ?? []).filter((m: ChatMessage) => m.role !== 'system'),
    });
  } catch {
    return NextResponse.json({ success: true, ...modeState, ...meetingExtra, conversations: [] });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      text?: string;
      reuseThreadId?: string | null;
      threadIdHint?: string;
      source?: 'panel' | 'wechat';
    };
    const question = (body.text || '').trim();
    if (!question) {
      return NextResponse.json({ success: false, error: 'Please enter a question for the chat' });
    }

    // 浏览器端为相对路径（baseUrl 为空），Node 端（微信桥）显式传服务地址
    const base = new URL(request.url).origin;
    const result = await askTempNode(question, {
      baseUrl: base,
      reuseThreadId: typeof body.reuseThreadId === 'string' ? body.reuseThreadId : null,
      threadIdHint: typeof body.threadIdHint === 'string' ? body.threadIdHint : undefined,
      source: body.source,
    });

    if (!result.ok) {
      return NextResponse.json({
        success: false,
        error: result.reply,
        threadId: result.threadId,
      });
    }
    return NextResponse.json({
      success: true,
      reply: result.reply,
      messages: result.messages,
      threadId: result.threadId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/node-chat] 执行失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

/** DELETE /api/wanted/node-chat — 兼容旧调用：清理过期会话。
 *  生命周期：
 *   - /chat out → executor.exitNodeMode() 解绑（不调该 API，会话保留）
 *   - 过期清理：startChatSessionSweeper 每 60s 扫 chat_sessions 过期行
 *   - 启动兜底：instrumentation → startChatSessionSweeper 先跑一次 */
export async function DELETE() {
  try {
    await sweepChatSessions();
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/node-chat] sweep 失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
