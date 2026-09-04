/**
 * WANTED 收件箱 API
 *
 * GET    /api/wanted/inbox?limit=50   → 拉取历史（新→旧）
 * POST   /api/wanted/inbox            → 写入一条回执（前端收到 wanted.notice 时落库）
 * PATCH  /api/wanted/inbox            → 标记已读 { ids?: string[] } | { all: true }；完成/恢复 { ids, done }
 * DELETE /api/wanted/inbox            → 删除 { ids }（日历端删除事件后联动清理）
 */
import { NextRequest, NextResponse } from 'next/server';
import { insertInbox, listInbox, markInboxRead, markAllInboxRead, markInboxDone, markInboxUndone, deleteInbox, markThreadInboxDone, markThreadInboxUndone, getInboxThreadIds, countInboxByThreadId, updateInboxItems } from '@/lib/wanted/inbox';
import { deleteChatSession } from '@/lib/wanted/chat-session';
import type { WantedNoticeItem, ChatMessage } from '@/lib/bus';

export async function GET(request: NextRequest) {
  try {
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? '50');
    const messages = await listInbox(Number.isFinite(limit) ? limit : 50);
    return NextResponse.json({ success: true, messages });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/inbox] 拉取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      kind?: string;
      title?: string;
      body?: string;
      items?: WantedNoticeItem[] | null;
      action?: { type?: string } | null;
      source?: string | null;
      threadId?: string | null;
      messages?: ChatMessage[] | null;
      time?: number;
      dedupeKey?: string | null;
      queryKey?: string | null;
    };
    if (!body.title || typeof body.title !== 'string') {
      return NextResponse.json({ success: false, error: 'Missing title' });
    }
    const message = await insertInbox({
      kind: typeof body.kind === 'string' ? body.kind : 'info',
      title: body.title,
      body: typeof body.body === 'string' ? body.body : '',
      items: Array.isArray(body.items) ? body.items : null,
      actionType: body.action?.type ?? null,
      source: typeof body.source === 'string' ? body.source : null,
      threadId: typeof body.threadId === 'string' ? body.threadId : null,
      messages: Array.isArray(body.messages) ? body.messages : null,
      time: typeof body.time === 'number' ? body.time : Date.now(),
      dedupeKey: typeof body.dedupeKey === 'string' ? body.dedupeKey : null,
      queryKey: typeof body.queryKey === 'string' ? body.queryKey : null,
    });
    return NextResponse.json({ success: true, message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/inbox] 写入失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { ids?: string[]; all?: boolean; done?: boolean; threadId?: string; items?: WantedNoticeItem[] | null };
    // 更新 items 快照（notes 邮件删除笔记后同步收件箱，避免刷新后删除项复活）——需显式传 items 字段
    if ('items' in body) {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (ids.length === 0) {
        return NextResponse.json({ success: false, error: 'Missing ids' });
      }
      await updateInboxItems(ids, body.items ?? null);
      return NextResponse.json({ success: true });
    }
    // 标记已完成（归入「已完成」分区）/ 恢复未完成（done: false 移回待办）
    // ids + threadId 可同时传：ids 覆盖内存中已知的邮件，threadId 覆盖 DB 中该线程全部行
    // （回复邮件可能未采纳服务端 id，仅按 id 会漏更，导致重启后未归档邮件重回 INBOX）
    if (typeof body.done === 'boolean') {
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        const ids = body.ids.filter((x) => typeof x === 'string');
        if (body.done) await markInboxDone(ids);
        else await markInboxUndone(ids);
      }
      if (typeof body.threadId === 'string' && body.threadId) {
        if (body.done) await markThreadInboxDone(body.threadId);
        else await markThreadInboxUndone(body.threadId);
      }
      return NextResponse.json({ success: true });
    }
    if (body.all) {
      await markAllInboxRead();
      return NextResponse.json({ success: true });
    }
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      await markInboxRead(body.ids.filter((x) => typeof x === 'string'));
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: 'Missing ids or all flag' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/inbox] 标记失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
    if (ids.length === 0) {
      return NextResponse.json({ success: false, error: 'Missing ids' });
    }
    // 联动清理 /chat 会话：删除邮件前记录涉及的线程；删除后若线程已无剩余邮件
    // （= 整个 BobMail 线程被删），则同步删除 chat_sessions 中对应会话。
    const threadIds = await getInboxThreadIds(ids);
    await deleteInbox(ids);
    for (const threadId of threadIds) {
      const remaining = await countInboxByThreadId(threadId);
      if (remaining === 0) {
        try {
          await deleteChatSession(threadId);
          console.log(`[wanted/inbox] BobMail 线程 ${threadId} 已删除，同步清理 /chat 会话`);
        } catch (e) {
          console.warn('[wanted/inbox] 清理会话失败:', e instanceof Error ? e.message : String(e));
        }
      }
    }
    return NextResponse.json({ success: true, deleted: ids.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/inbox] 删除失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
