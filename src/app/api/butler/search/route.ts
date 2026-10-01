/**
 * /api/butler/search —— 跨会话历史消息搜索（Butler 联系人列搜索栏）
 *
 * GET ?q=<关键词>[&limit=]
 *   扫全部线程文件（与 /api/butler/threads 同口径：跳过 system / 已归档 / 已过期），
 *   返回命中的**历史消息**（threadId + role + 正文 + 时间），前端按 threadId 归组，
 *   嵌到对应联系人行下面（微信式「聊天记录」）。
 *
 * 只给线程消息；通知回执（inbox 行）不在线程文件里，前端用已加载的 notices 现算。
 * 空词直接返回空数组（不打存储）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchThreadMessages } from '@/lib/butler/threads';

export async function GET(request: NextRequest) {
  try {
    const params = new URL(request.url).searchParams;
    const q = (params.get('q') ?? '').trim();
    if (!q) return NextResponse.json({ success: true, hits: [] });
    const raw = Number(params.get('limit'));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : 100;
    const hits = await searchThreadMessages(q, limit);
    return NextResponse.json({ success: true, hits });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/search] 搜索失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}