/**
 * Butler 收件箱 API
 *
 * GET    /api/butler/inbox?limit=50   → 拉取历史（新→旧）
 * POST   /api/butler/inbox            → 写入一条回执（前端收到 butler.notice 时落库）
 * PATCH  /api/butler/inbox            → 更新 items 快照 { ids, items }；完成/恢复 { ids, done }；点开 { ids, read }
 * DELETE /api/butler/inbox            → 删除 { ids }（日历端删除事件后联动清理）
 */
import { NextRequest, NextResponse } from 'next/server';
import { insertInbox, listInbox, markInboxDone, markInboxUndone, markInboxRead, deleteInbox, markThreadInboxDone, markThreadInboxUndone, getInboxThreadIds, countInboxByThreadId, updateInboxItems } from '@/lib/core/inbox';
import { deleteThread } from '@/lib/butler/threads';
import { NOTIFY_THREAD_ID, isNotifyKind } from '@/lib/core/butler-notify';
import type { ButlerNoticeItem, ChatMessage } from '@/lib/bus';

export async function GET(request: NextRequest) {
  try {
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? '50');
    const messages = await listInbox(Number.isFinite(limit) ? limit : 50);
    return NextResponse.json({ success: true, messages });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/inbox] 拉取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      kind?: string;
      title?: string;
      body?: string;
      items?: ButlerNoticeItem[] | null;
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
    const kind = typeof body.kind === 'string' ? body.kind : 'info';
    // 系统推送类通知（日程提醒 / 每日报告 / 跨项目检查）没有会话可归属，兜底落到常驻「通知助理」线程：
    // 否则这些行永远 thread_id 为空 → 既不属于任何联系人，通知助理时间线也取不到自己那一批。
    // 用户主动操作的会话回执本来就有 threadId（或只弹 toast 不落库），不受影响。
    const threadId =
      typeof body.threadId === 'string' && body.threadId
        ? body.threadId
        : isNotifyKind(kind)
          ? NOTIFY_THREAD_ID
          : null;
    const message = await insertInbox({
      kind,
      title: body.title,
      body: typeof body.body === 'string' ? body.body : '',
      items: Array.isArray(body.items) ? body.items : null,
      actionType: body.action?.type ?? null,
      source: typeof body.source === 'string' ? body.source : null,
      threadId,
      messages: Array.isArray(body.messages) ? body.messages : null,
      time: typeof body.time === 'number' ? body.time : Date.now(),
      dedupeKey: typeof body.dedupeKey === 'string' ? body.dedupeKey : null,
      queryKey: typeof body.queryKey === 'string' ? body.queryKey : null,
    });
    return NextResponse.json({ success: true, message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/inbox] 写入失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { ids?: string[]; done?: boolean; read?: boolean; threadId?: string; items?: ButlerNoticeItem[] | null };
    // 点开卡片 → 标记已点开（read = 1）：红色未读点与好友头像角标的唯一清除口径。
    // 只置 1 不回退（「未读」不再是一颗可来回切的按钮，2026-09-28 收口）。
    if (body.read === true) {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (ids.length === 0) {
        return NextResponse.json({ success: false, error: 'Missing ids' });
      }
      await markInboxRead(ids);
      return NextResponse.json({ success: true });
    }
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
    return NextResponse.json({ success: false, error: 'Missing ids' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/inbox] 标记失败:', msg);
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
    // 联动清理 /chat 会话：删除回执前记录涉及的线程；删除后若线程已无剩余回执
    // （= 整个 Butler 线程被删），则同步删除 chat_sessions 中对应会话。
    const threadIds = await getInboxThreadIds(ids);
    await deleteInbox(ids);
    for (const threadId of threadIds) {
      // 常驻联系人（通知助理）：删通知不等于删这个联系人 —— 跳过联动
      if (threadId === NOTIFY_THREAD_ID) continue;
      const remaining = await countInboxByThreadId(threadId);
      if (remaining === 0) {
        try {
          await deleteThread(threadId);
          console.log(`[core/inbox] Butler 会话线程 ${threadId} 已删除，同步清理 /chat 会话`);
        } catch (e) {
          console.warn('[core/inbox] 清理会话失败:', e instanceof Error ? e.message : String(e));
        }
      }
    }
    return NextResponse.json({ success: true, deleted: ids.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/inbox] 删除失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
