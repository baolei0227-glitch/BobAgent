/**
 * POST /api/team/<teamId>/control — 工作台干预（第一期：只读 + msg_send + task_retry）
 *
 * 团队级暂停/终止属第二期。msg_send 给空闲成员会由引擎调度器即时唤醒（「有信就唤醒」），
 * 因此这里的插话不是「等下次任务唤醒才投递」，而是会立刻产生一次成员发言。
 */
import type { NextRequest } from 'next/server';
import { ensureTeamReady, retryTeamTask, sendTeamMessage } from '@/lib/chat/team-client';

export const dynamic = 'force-dynamic';

type ControlBody = {
  action?: string;
  /** msg_send 目标：成员 id / 成员名 / 'all'（广播）/ 'captain' */
  to?: string;
  text?: string;
  taskId?: string;
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: ControlBody;
  try {
    body = (await request.json()) as ControlBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const ready = await ensureTeamReady();
    if (!ready.ok) {
      return Response.json({ error: ready.error }, { status: 503 });
    }

    switch (body.action) {
      case 'msg_send': {
        const to = (body.to ?? '').trim();
        const text = (body.text ?? '').trim();
        if (!to || !text) {
          return Response.json({ error: 'msg_send 需要 to 与 text' }, { status: 400 });
        }
        await sendTeamMessage(id, to, text);
        return Response.json({ ok: true });
      }
      case 'task_retry': {
        const taskId = (body.taskId ?? '').trim();
        if (!taskId) {
          return Response.json({ error: 'task_retry 需要 taskId' }, { status: 400 });
        }
        const res = await retryTeamTask(id, taskId);
        return Response.json({ ok: true, task: res.task, revoked: res.revoked, hint: res.hint });
      }
      default:
        return Response.json({ error: `未知 action：${String(body.action)}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
