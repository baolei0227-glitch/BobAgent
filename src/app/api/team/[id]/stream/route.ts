/**
 * GET /api/team/<teamId>/stream — 团队工作台 SSE
 *
 * 引擎没有推送通道（MCP 是请求-响应），故此处以固定间隔轮询 team_status 面板做变更检测：
 *  - `panel`   面板变化（成员/任务/邮箱/终态）——不含产出全文，避免逐帧传大文本
 *  - `events`  新增事件（引擎落盘 <teamId>.events.jsonl 的呈现层映射）
 *  - `results` 新 done 任务的产出全文（按 taskId 增量给）
 *
 * 去重口径：面板事件窗口只保留最近 200 条，故用「已见 id 集合」判新——事件是追加写的，
 * 滑出窗口的 id 不会再回来，每个轮询周期把集合裁剪回当前窗口即可，无需额外游标持久化。
 * 增量 panel 帧**不带** events（只在首帧带全量），故窗口放大不会让每帧体积跟着涨。
 */
import type { NextRequest } from 'next/server';
import type { TeamChatEvent, TeamDetail } from '@/lib/types';
import {
  buildTeamDetail,
  collectTeamResults,
  ensureTeamReady,
  mapEngineEvents,
  resultsToMap,
} from '@/lib/chat/team-client';

export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();
const POLL_MS = 1500;
/** 连续失败上限：引擎进程可能重启，短暂失败应容忍，长期失败则断开让前端重连 */
const MAX_FAILURES = 3;

/** 面板指纹：成员状态 / 任务状态与进度 / 邮箱条数 / 终态 —— 变化即推一帧 panel */
function panelKey(d: TeamDetail): string {
  return JSON.stringify([
    d.status,
    d.terminal,
    d.updatedAt,
    d.members.map((m) => [m.id, m.status, m.currentTaskId ?? '', m.messageCount]),
    d.tasks.map((t) => [t.id, t.status, t.error ?? '', t.progressText ?? '', t.attempts ?? 0, t.lastActivityAt ?? 0]),
    d.messages.length,
    d.messages.length > 0 ? d.messages[d.messages.length - 1].id : '',
  ]);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const ready = await ensureTeamReady();
  if (!ready.ok) {
    return Response.json({ error: ready.error }, { status: 503 });
  }

  let closed = false;
  /** 本连接的定时器清理函数（start 登记，cancel 时调用——cancel 回调收到的是 reason，
   *  拿不到 controller，故不能在回调里按 controller 反查） */
  let dispose: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let timer: ReturnType<typeof setInterval> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const send = (frame: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeat) clearInterval(heartbeat);
      };
      // 登记给 cancel 用：客户端断开时清掉两个定时器（否则轮询会一直跑）
      dispose = () => cleanup();

      let failures = 0;
      let busy = false;
      let lastPanelKey = '';
      /** 本轮之后不再重发的事件 id（追加写文件，滑出窗口即可裁剪） */
      const seenEvents = new Set<string>();
      /** 已回传过全文的 done 任务 id */
      const seenResults = new Set<string>();

      // 首帧：带产出全文与最近 200 条事件，让重连/刷新后马上成形（不必等下个轮询周期）
      let first: TeamDetail;
      try {
        first = await buildTeamDetail(id, { withResults: true });
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        cleanup();
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
        return;
      }
      lastPanelKey = panelKey(first);
      for (const e of first.events ?? []) seenEvents.add(e.id);
      for (const t of first.tasks) if (t.status === 'done') seenResults.add(t.id);
      send({ type: 'panel', detail: first });

      const poll = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          const detail = await buildTeamDetail(id);
          failures = 0;

          // ① 新增事件 → 群聊流增量
          const events = detail.events ?? [];
          if (events.length > 0) {
            const fresh = events.filter((e) => !seenEvents.has(e.id));
            // 事件窗口只保留最近 200 条：把集合裁剪回当前窗口，避免无界增长
            if (seenEvents.size > events.length) {
              const inWindow = new Set(events.map((e) => e.id));
              for (const seen of seenEvents) if (!inWindow.has(seen)) seenEvents.delete(seen);
            }
            for (const e of fresh) seenEvents.add(e.id);
            if (fresh.length > 0) {
              const subjects = new Map(detail.tasks.map((t) => [t.id, t.subject]));
              const mapped: TeamChatEvent[] = mapEngineEvents(fresh, subjects);
              if (mapped.length > 0) send({ type: 'events', events: mapped });
            }
          }

          // ② 新完成任务的产出全文 → 单独一帧（面板帧不带全文，避免帧体积随产出增长）
          const freshDone = detail.tasks.filter((t) => t.status === 'done' && !seenResults.has(t.id));
          if (freshDone.length > 0) {
            for (const t of freshDone) seenResults.add(t.id);
            const map = resultsToMap(await collectTeamResults(id));
            const picked: Record<string, string> = {};
            for (const t of freshDone) picked[t.id] = map[t.id] ?? '';
            send({ type: 'results', results: picked });
          }

          // ③ 面板变化
          const key = panelKey(detail);
          if (key !== lastPanelKey) {
            lastPanelKey = key;
            // 增量帧不带事件流：引擎窗口已放大到 200 条（队长条目 / 成员留言会很快把「启动」挤出窗口），
            // 而前端只在**首帧**消费 detail.events（此后靠 ① 的 events 增量帧），故这里省掉可让帧体积恒定。
            send({ type: 'panel', detail: { ...detail, events: undefined } });
          }
        } catch (e) {
          failures += 1;
          if (failures >= MAX_FAILURES) {
            send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
            cleanup();
            try {
              controller.close();
            } catch {
              /* 已关闭 */
            }
          } else if (failures === 1) {
            send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
          }
        } finally {
          busy = false;
        }
      };

      timer = setInterval(() => void poll(), POLL_MS);

      // 心跳：轮询期间已有数据帧，仅在长时间静默时保活（防中间层按空闲断流）
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          cleanup();
        }
      }, 25000);
    },
    cancel() {
      dispose?.();
      dispose = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
