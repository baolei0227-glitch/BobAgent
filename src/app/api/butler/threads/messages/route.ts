/**
 * DELETE /api/butler/threads/messages?threadId=xxx
 *
 * 删除**某条线程里的若干条消息**（中栏气泡 hover 操作条的「删除 / 多选删除」）。
 *
 * 为什么与 DELETE /api/butler/threads 分成两条路由：那条删的是**整条线程**（联系人列里少一行），
 * 这条只是**就地编辑线程内容**。合成一条后，前端一个参数写错就会把整个联系人删掉。
 *
 * body: { items: { role, content, index? }[] }
 *   - role + content：要删的那条消息的身份（气泡上看得见的东西），服务端按它认领，正文比对见
 *     lib/butler/threads 的 deleteThreadMessages；
 *   - index：气泡 id 里带的「服务端下标」**提示**，只用于在重复正文中认准是哪一条，不作数。
 * 删完**不动 updatedAt**（删一条不该把线程顶到联系人列最前）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { deleteThreadMessages, type DeleteMessageTarget } from '@/lib/butler/threads';

export async function DELETE(request: NextRequest) {
  try {
    const threadId = new URL(request.url).searchParams.get('threadId');
    if (!threadId) {
      return NextResponse.json({ success: false, error: 'threadId is required' }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as { items?: unknown };
    const items = Array.isArray(body.items) ? body.items : [];
    const targets: DeleteMessageTarget[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as { role?: unknown; content?: unknown; index?: unknown };
      // role / content 缺一不可：身份不完整的目标一律丢掉，不做「猜着删」
      if (typeof o.role !== 'string' || typeof o.content !== 'string') continue;
      targets.push({
        role: o.role,
        content: o.content,
        index: typeof o.index === 'number' ? o.index : undefined,
      });
    }
    const deleted = await deleteThreadMessages(threadId, targets);
    return NextResponse.json({ success: true, deleted });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/threads] 删除消息失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}