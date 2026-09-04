/**
 * POST /api/wanted/mail-reply
 *
 * WantedNoticeCenter 邮件式 chat 回复：
 *   传入上下文 messages（当前通知的 chat messages）+ 用户输入的 replyText
 *   → 调 /api/chat 获取 AI 回答 → 返回聚合后的 reply + 最终 messages 数组
 *
 * 客户端 WantedNoticeCenter 原本通过静态 import 调 lib/wanted/node-chat#askFromMail，
 * 但该模块内含 fs/path/settings-server 等 server-only 依赖（且 resolveTempNodeModel
 * 会 child_process），会让 Turbopack 客户端编译失败，故封装为此纯 API 路由。
 */
import { NextRequest, NextResponse } from 'next/server';
import { askFromMail } from '@/lib/wanted/node-chat';
import type { ChatMessage } from '@/lib/bus';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      messages?: ChatMessage[];
      text?: string;
    };
    const text = (body.text ?? '').trim();
    if (!text) {
      return NextResponse.json({ ok: false, reply: 'Reply text is empty.', messages: body.messages ?? [] });
    }
    const base = new URL(request.url).origin;
    const result = await askFromMail(body.messages, text, { baseUrl: base });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/mail-reply] failed:', msg);
    return NextResponse.json(
      { ok: false, reply: msg || 'Internal error.', messages: [] },
      { status: 500 },
    );
  }
}
