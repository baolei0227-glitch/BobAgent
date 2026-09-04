import { NextRequest } from 'next/server';
import { resolvePendingQuestions, type PendingAnswerEntry } from '@/lib/chat/questions-pending';

/**
 * AI 提问（ask_user_questions）的答案回传接口。
 * 前端收到 SSE questions_request 事件、用户在结构化表单中提交答案后调用本接口，
 * 服务端据此恢复挂起的工具循环，把 answers 作为 tool_result 返回给模型继续生成。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const requestId = String(body?.requestId ?? '');
    if (!requestId) {
      return Response.json({ success: false, error: 'requestId 缺失' });
    }
    const answers = Array.isArray(body?.answers) ? (body.answers as PendingAnswerEntry[]) : [];
    const ok = resolvePendingQuestions(requestId, answers);
    if (!ok) {
      return Response.json({ success: false, error: '提问请求已超时或不存在' });
    }
    return Response.json({ success: true, count: answers.length });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}