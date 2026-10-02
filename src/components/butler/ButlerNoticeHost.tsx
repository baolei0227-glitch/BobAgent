'use client';

/**
 * Butler 通知常驻宿主（无骨架，仅 toast 栈 + 「执行中」浮层）
 *
 * 承接原 WantedNoticeCenter 的全部「非收件箱」职责，使收件箱 UI 可以彻底重做/替换：
 *   1. 轮询消费舱（唯一）：/api/butler/daily-report（30s）+ /api/butler/reminders（30s + calendar-events-changed 立即）
 *      —— 生产舱（daily-report.ts / event-reminder.ts）只写 pending.json，其他组件禁止做同类轮询（避免双消费竞态）
 *   1.5 Butler 独立心跳：/api/butler/tick（60s，body 带当前 projectId）—— 唤醒到期定时规则，
 *      产出 notice 时同样走 butler.notice bus（不新增展示通道，也不引入常驻后台调度器）。
 *   2. 订阅 bus butler.notice → 内存去重 → 落库 inbox / 桌面通知 → 写入 butlerNotices store；
 *      同时把**新发布（2s 内）**的消息推成应用内浮层通知（窗口左上角，见下）
 *   3. 订阅 bus butler.executing → 右上角「执行中」常驻浮层
 *   4. 日历反向联动（butler-event-sync）：日历端完成/删除事件 → 收件箱对应条目自动完成/删除
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, ClipboardList, Info, Loader2, Mic, NotebookPen, Search, Zap } from 'lucide-react';
import { bus, BusEvents, type ButlerExecutingPayload, type ButlerNoticeItem, type ButlerNoticePayload } from '@/lib/bus';
import { desktop } from '@/lib/desktop-adapter';
import { getCurrentProjectId } from '@/lib/current-project';
import { BUTLER_INBOX_EVENT, BUTLER_FOCUS_NOTICE_EVENT, notifyButlerUnreadChanged } from './butlerEvents';
import { readActiveThreadId } from './butlerSession';
import {
  getButlerNotices,
  patchButlerNotice,
  removeButlerNotice,
  setButlerNotices,
  upsertButlerNotice,
  type ButlerNotice,
} from './butlerNotices';

const REFRESH_MS = 30_000;
/** Butler 独立心跳：每 60s 拉一次 /api/butler/tick（不依赖对话，唤醒到期的定时规则） */
const TICK_MS = 60_000;
const TOAST_TTL_MS = 3500;

interface ToastItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  actionType: string | null;
}

/** kind → 图标 + 色（toast 与对话框卡片共用语义） */
const KIND_ICON: Record<string, { Icon: typeof Zap; color: string; label: string }> = {
  task: { Icon: CheckCircle2, color: 'var(--success)', label: 'TASK' },
  note: { Icon: NotebookPen, color: 'var(--primary)', label: 'NOTE' },
  notes: { Icon: NotebookPen, color: 'var(--primary)', label: 'NOTES' },
  info: { Icon: Info, color: 'var(--info)', label: 'INFO' },
  calendar: { Icon: CalendarClock, color: 'var(--warn)', label: 'REMINDER' },
  'daily-report': { Icon: ClipboardList, color: 'var(--info)', label: 'REPORT' },
  inspect: { Icon: Search, color: 'var(--warn)', label: 'CHECK' },
  meeting: { Icon: Mic, color: 'var(--primary)', label: 'MEETING' },
  web: { Icon: Info, color: 'var(--info)', label: 'WEB' },
  check: { Icon: CalendarClock, color: 'var(--warn)', label: 'SCHEDULE' },
  todo_del: { Icon: CalendarClock, color: 'var(--warn)', label: 'SCHEDULE' },
};

export function kindMeta(kind: string): { Icon: typeof Zap; color: string; label: string } {
  return KIND_ICON[kind] ?? { Icon: Info, color: 'var(--ink-muted)', label: kind.toUpperCase() };
}

/** 点桌面通知 → 打开 Butler 抽屉并定位该条 */
function openNoticeFromDesktop(noticeId: string): void {
  window.dispatchEvent(new CustomEvent(BUTLER_INBOX_EVENT, { detail: { anchor: null } }));
  window.dispatchEvent(new CustomEvent(BUTLER_FOCUS_NOTICE_EVENT, { detail: { noticeId } }));
}

/**
 * B5 打扰闸（2026-10-02 接线）：弹 toast / 系统通知前问一句服务端「现在能不能打扰」。
 *
 * 为什么必须服务端裁决：免打扰窗口与单日计数是**同一份状态**（`butler/notify-state.json`），
 * 客户端自己算会各算一份。策略层故障**失败即放行**（fail-open）——静默掉通知比多打扰一次严重。
 * 与落库完全解耦：被拒时条目照常进抽屉收件箱，只是不打扰（报告不会丢）。
 */
async function allowInterrupt(kind: string): Promise<boolean> {
  try {
    const res = await fetch('/api/butler/push-gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    const d = (await res.json()) as { allow?: boolean };
    return d?.allow !== false;
  } catch {
    return true;
  }
}

function sendDesktopNotification(title: string, body: string, opts?: { noticeId?: string }): void {
  try {
    void desktop.update.notify(title, body).catch(() => undefined);
    // web 回退：HTML5 Notification
    if (typeof window !== 'undefined' && 'Notification' in window) {
      const send = () => {
        try {
          const n = new Notification(title, { body, silent: false });
          n.onclick = () => {
            window.focus();
            n.close();
            if (opts?.noticeId) openNoticeFromDesktop(opts.noticeId);
          };
          setTimeout(() => n.close(), 15000);
        } catch {
          /* ignore */
        }
      };
      if (Notification.permission === 'granted') send();
      else if (Notification.permission === 'default') {
        void Notification.requestPermission().then((p) => {
          if (p === 'granted') send();
        }).catch(() => undefined);
      }
    }
  } catch {
    /* ignore */
  }
}

export function ButlerNoticeHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [executingLabel, setExecutingLabel] = useState<string | null>(null);
  const noticeSeq = useRef(0);

  const pushToast = useCallback((p: ButlerNoticePayload) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [{ id, kind: p.kind, title: p.title, body: p.body, actionType: p.action?.type ?? null }, ...prev].slice(0, 3));
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_TTL_MS + 200);
  }, []);

  // 执行中浮层
  useEffect(() => {
    return bus.subscribe<ButlerExecutingPayload>(BusEvents.butlerExecuting, (p) => {
      setExecutingLabel(p.executing ? (p.label ?? 'Running…') : null);
    });
  }, []);

  // 通知事件：去重 → toast / 落库 / 桌面通知 → store
  useEffect(() => {
    const seen = new Map<string, number>();
    const DEDUP_WINDOW_MS = 5000;
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of seen) if (v <= now) seen.delete(k);
    }, 30000);

    const unsub = bus.subscribe<ButlerNoticePayload>(BusEvents.butlerNotice, (payload) => {
      const dedupeKey = payload.dedupeKey ?? `${payload.kind}|${payload.title}|${payload.time ?? ''}`;
      const now = Date.now();
      const expire = seen.get(dedupeKey);
      if (expire && expire > now) return;
      seen.set(dedupeKey, now + DEDUP_WINDOW_MS);

      // toast 分支：用户主动操作回执（task/note/info）只弹浮层 + 可选桌面通知，不落库
      if (payload.toast === true) {
        pushToast(payload);
        if (payload.desktop !== false && (payload.time == null || Date.now() - payload.time < 2000)) {
          sendDesktopNotification(payload.title, payload.body);
        }
        return;
      }

      // 统一 time：内存 / 落库 / (kind,title,time) 去重签名三处必须一致
      const unifiedTime = payload.time ?? Date.now();
      const localId = `wn-${Date.now()}-${noticeSeq.current++}`;
      const notice: ButlerNotice = {
        id: localId,
        kind: payload.kind,
        title: payload.title,
        body: payload.body,
        time: unifiedTime,
        done: false,
        read: false,
        items: payload.items ?? null,
        actionType: payload.action?.type ?? null,
        source: payload.source ?? null,
        threadId: payload.threadId ?? null,
        messages: payload.messages ?? null,
        dedupeKey: payload.dedupeKey ?? null,
      };
      upsertButlerNotice(notice);
      // 「有消息就弹一下」：应用内浮层通知（窗口左上角）与桌面通知共用同一条**新鲜度**门槛
      // （2s 内才算新发布），否则重启后把 pending.json 里的历史重放一遍会连弹一屏。
      // desktop=false 只约束**系统**通知，不拦应用内浮层（日报这类本就不发系统通知，但仍该在应用内提示）。
      const fresh = payload.time == null || Date.now() - unifiedTime < 2000;
      // 打扰闸与落库解耦：先同步落库（fire-and-forget），打扰另起一条异步链，避免一次鉴权往返拖慢落库。
      void (async () => {
        const mayInterrupt = payload.interrupt === 'always' ? true : await allowInterrupt(payload.kind);
        if (!mayInterrupt) return;
        if (fresh) pushToast(payload);
        if (payload.desktop !== false && fresh) {
          sendDesktopNotification(payload.title, payload.body, { noticeId: localId });
        }
      })();

      // 落库（fire-and-forget）；成功后把内存 id 换成服务端 in- 主键，
      // 否则删除的 DELETE 用 wn- id 会静默 no-op。
      void fetch('/api/butler/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: payload.kind,
          title: payload.title,
          body: payload.body,
          items: payload.items,
          action: payload.action,
          source: payload.source,
          threadId: payload.threadId,
          messages: payload.messages,
          time: unifiedTime,
          dedupeKey: payload.dedupeKey,
          queryKey: payload.queryKey,
        }),
      })
        .then((r) => r.json().catch(() => null))
        .then((data) => {
          const msg = (data as { message?: { id?: string; done?: boolean; read?: boolean } } | null)?.message;
          if (!msg?.id) return;
          removeButlerNotice(localId);
          upsertButlerNotice({
            ...notice,
            id: msg.id,
            done: !!msg.done,
            // 服务端可能按 dedupeKey 命中一条已点开的存量行 → read 以服务端为准
            read: !!msg.read,
          });
          // 回执此刻才真正落库（未点开 = 未读）→ 让悬浮球立即重拉角标，不等 120s 兜底轮询。
          notifyButlerUnreadChanged();
        })
        .catch(() => undefined);
    });

    return () => {
      unsub();
      clearInterval(sweep);
    };
  }, [pushToast]);

  // 消费舱轮询 ①：每日任务回执（2026-09-27 起日报三页签已移交 Today 面板，
  //   这里只剩 Notes 知识库每日维护——日报不再产生 pending，故多数轮询为空转）
  useEffect(() => {
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await fetch('/api/butler/daily-report');
        const d = (await res.json()) as {
          success?: boolean;
          reports?: { kind?: string; title: string; body: string; time: number; items?: ButlerNoticeItem[]; dedupeKey?: string }[];
        };
        if (alive && d?.success && Array.isArray(d.reports)) {
          for (const r of d.reports) {
            bus.publish(BusEvents.butlerNotice, {
              kind: r.kind === 'inspect' ? 'inspect' : 'daily-report',
              title: r.title,
              body: r.body,
              time: r.time,
              desktop: false,
              items: r.items,
              source: 'scheduled',
              dedupeKey: r.dedupeKey,
              // 服务端（GET /api/butler/daily-report）已按同一策略裁决并计数：
              // 免打扰窗口内报告**留在队列**、窗口结束后续发。客户端不再二次过闸，否则双重计数。
              interrupt: 'always',
            });
          }
        }
      } catch {
        /* 网络错误忽略，下一轮重试 */
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // 消费舱轮询 ②：日历到期提醒
  useEffect(() => {
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await fetch('/api/butler/reminders');
        const d = (await res.json()) as {
          success?: boolean;
          reminders?: { title: string; body: string; time: number; items?: ButlerNoticeItem[]; dedupeKey?: string }[];
        };
        if (alive && d?.success && Array.isArray(d.reminders)) {
          for (const r of d.reminders) {
            bus.publish(BusEvents.butlerNotice, {
              kind: 'calendar',
              title: r.title,
              body: r.body,
              time: r.time,
              desktop: true, // 由宿主按 time 判定：刚到期弹桌面通知，补发历史不弹
              items: r.items,
              action: { type: 'open-calendar' },
              source: 'scheduled',
              // 用户自订日历提醒：过闸但**免打扰窗口不静默它**（策略层 kind='reminder' 只受单日上限）
              interrupt: 'gate',
              dedupeKey: r.dedupeKey,
            });
          }
        }
      } catch {
        /* 网络错误忽略 */
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), REFRESH_MS);
    const onEventsChanged = () => void poll();
    window.addEventListener('calendar-events-changed', onEventsChanged);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('calendar-events-changed', onEventsChanged);
    };
  }, []);

  // 消费舱轮询 ③：Butler 独立心跳（不依赖对话）。
  //   每 60s POST /api/butler/tick，到期的定时规则由宿主侧确定性执行一次（不经模型、不经 SSE）。
  //   返回非空 notice（= 本轮确实做了一件事）时复用 butler.notice bus 走既有 toast / 落库链路；
  //   幂等由服务端 hits.occurrence 反查保证，这里不新增计数器 —— 未到期的下一轮自然返回空 notice。
  useEffect(() => {
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await fetch('/api/butler/tick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // threadId = 当前抽屉会话（评审 P2-⑱）：预算计数依赖它，不带则定时链路永不扣预算。
          body: JSON.stringify({
            projectId: getCurrentProjectId() || undefined,
            threadId: readActiveThreadId() || undefined,
          }),
        });
        const d = (await res.json()) as {
          success?: boolean;
          notice?: string | null;
          /** 应用未运行期间错过、且不会补跑的定时实例（评审 §2.2-7：此前是**静默丢失**） */
          missed?: { ruleName: string; occurrence: number }[] | null;
        };
        if (alive && d?.success && Array.isArray(d.missed) && d.missed.length > 0) {
          // 「漏触发告知」：定时规则到期时应用没开、且超出 24h 补偿窗口 → 明说一句，不假装没发生
          const names = d.missed.map((m) => m.ruleName).join('、');
          bus.publish(BusEvents.butlerNotice, {
            kind: 'info',
            title: '有定时规则错过的执行',
            body: `应用未运行期间，「${names}」的触发时刻已过、超出补偿窗口，本次未补跑。需要的话现在可以手动执行一次。`,
            time: Date.now(),
            desktop: false,
            source: 'scheduled',
            // 与规则执行回执同属**义务性告知**（状态性痕迹，不占预算、不被静默）
            interrupt: 'always',
          });
        }
        if (alive && d?.success && d.notice) {
          bus.publish(BusEvents.butlerNotice, {
            kind: 'task',
            title: 'Butler',
            body: d.notice,
            time: Date.now(),
            desktop: true,
            source: 'scheduled',
            // 规则执行回执 = **义务性通知**（v6 §3.2：「义务不是打扰」，不占预算、不被静默）→ 不过闸
            interrupt: 'always',
          });
        }
      } catch {
        /* 网络错误忽略，下一轮重试 */
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // 日历反向联动：事件完成/删除 → 收件箱对应条目自动完成/删除
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { eventId?: string; action?: 'done' | 'deleted' } | undefined;
      const evId = detail?.eventId;
      if (!evId) return;
      const current = getButlerNotices();
      // 单事件提醒邮件（calendar 等）整封联动；多事件日报只动对应 item
      const noticeLevel = (n: ButlerNotice) => n.kind !== 'daily-report';

      if (detail.action === 'done') {
        for (const n of current) {
          const linked = (n.items ?? []).some((it) => it.key === evId);
          if (!linked) continue;
          if (noticeLevel(n)) {
            if (n.done) continue;
            void fetch('/api/butler/inbox', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: [n.id], done: true }),
            }).catch(() => undefined);
            patchButlerNotice(n.id, { done: true });
          } else {
            const nextItems = (n.items ?? []).map((x) => (x.key === evId ? { ...x, status: 'done' } : x));
            void fetch('/api/butler/inbox', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: [n.id], items: nextItems }),
            }).catch(() => undefined);
            patchButlerNotice(n.id, { items: nextItems });
          }
        }
        return;
      }

      if (detail.action === 'deleted') {
        const doomed: string[] = [];
        const patchDaily: { id: string; items: ButlerNoticeItem[] }[] = [];
        for (const n of current) {
          if (!(n.items ?? []).some((it) => it.key === evId)) continue;
          if (noticeLevel(n)) {
            doomed.push(n.id);
            continue;
          }
          const trimmed = (n.items ?? []).filter((it) => it.key !== evId);
          patchDaily.push({ id: n.id, items: trimmed });
          patchButlerNotice(n.id, { items: trimmed });
        }
        if (doomed.length > 0) {
          void fetch('/api/butler/inbox', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: doomed }),
          }).catch(() => undefined);
        }
        if (patchDaily.length > 0) {
          void Promise.all(
            patchDaily.map((p) =>
              fetch('/api/butler/inbox', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [p.id], items: p.items }),
              }).catch(() => undefined),
            ),
          ).catch(() => undefined);
        }
      }
    };
    window.addEventListener('butler-event-sync', handler);
    return () => window.removeEventListener('butler-event-sync', handler);
  }, []);

  return (
    <>
      {/* 「执行中」浮层：顶部居中胶囊 */}
      {executingLabel && (
        <div
          className="fixed left-1/2 top-3 z-[1350] flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-xs shadow-lg"
          style={{
            backgroundColor: 'var(--popover)',
            border: '1px solid var(--border)',
            color: 'var(--ink)',
          }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--primary)' }} />
          <span>{executingLabel}</span>
        </div>
      )}

      {/* Toast 栈：**应用窗口左上角**（2026-09-28 自右下角移来），最多 3 条、最新在上 */}
      {toasts.length > 0 && (
        <div className="fixed left-4 top-4 z-[1350] flex w-[300px] flex-col gap-2">
          {toasts.map((t) => {
            const meta = kindMeta(t.kind);
            return (
              <div
                key={t.id}
                className="flex items-start gap-2 rounded-xl px-3 py-2 shadow-lg"
                style={{
                  backgroundColor: 'var(--popover)',
                  border: '1px solid var(--border)',
                }}
              >
                <meta.Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: meta.color }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>
                    {t.title}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-11" style={{ color: 'var(--ink-muted)' }}>
                    {t.body}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                  className="shrink-0 rounded p-0.5 text-11 transition-opacity hover:opacity-60"
                  style={{ color: 'var(--ink-faint)' }}
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * 未读角标数（服务端全量 COUNT）；失败返回 null（调用方保持原值，不把角标刷成 0）。
 * 口径 = **好友会话未读消息 + 尚未点开的回执**（见 lib/butler/today.ts 的 chats.unread）——
 * 回执是「普通消息」的一种（微信里的语音/文件消息），点开卡片才清。
 * 与 ButlerOrb 的兜底轮询读同一端点同一字段，保证两处上屏的数字永远同源。
 */
export async function fetchUnreadCount(): Promise<number | null> {
  try {
    const res = await fetch('/api/butler/today');
    const data = await res.json();
    if (!data?.success) return null;
    return Number(data?.snapshot?.chats?.unread ?? 0);
  } catch {
    return null;
  }
}

/** 追踪节奏 / 上限：5s 一次、最多 24 次 ≈ 2 分钟（与悬浮球 120s 兜底轮询同一量级，追不上就交给它） */
const UNREAD_WATCH_MS = 5000;
const UNREAD_WATCH_MAX = 24;

let unreadWatchTimer: number | null = null;

/**
 * 「你切走之后落的回复」追踪。
 *
 * 为什么需要它：切换联系人 / 折叠抽屉会**中止前端消费**（abort 掉 SSE），
 * 但服务端仍继续读上游并**在流结束时才落库**（lib/butler/entry.ts 的 finally）。
 * 于是「回应落地」这一刻前端没有任何事件可听——切走时派的那次 unread-changed 问得太早，
 * 服务端那时还没写完，读到的仍是 0，角标就一直不亮。
 * 只能在切走后按节奏问一句「未读总数变了吗」，变了就派 unread-changed：
 * 悬浮球（ButlerOrb）与联系人列（ButlerDrawer 的会话列表监听）都会据此立刻刷新。
 *
 * 刻意用**总数变化**而不是某个线程：这里拿不到「哪条线程在飞」的上下文，
 * 而多派一次信号只是多一次轻量刷新，代价远小于漏掉。
 */
export function watchForUnreadGrowth(): void {
  if (typeof window === 'undefined') return;
  stopUnreadWatch();
  let base: number | null = null;
  void fetchUnreadCount().then((n) => {
    if (n !== null) base = n;
  });
  let tries = 0;
  unreadWatchTimer = window.setInterval(() => {
    if (++tries > UNREAD_WATCH_MAX) {
      stopUnreadWatch();
      return;
    }
    void fetchUnreadCount().then((now) => {
      if (now === null) return; // 读不到不算变化，下一轮再看
      if (base === null) {
        base = now; // 起点当时没读到 → 用第一个有效值当基线
        return;
      }
      if (now === base) return;
      stopUnreadWatch();
      notifyButlerUnreadChanged();
    });
  }, UNREAD_WATCH_MS);
}

/** 停掉追踪（已确认未读变化、或要开始新一轮观察时） */
export function stopUnreadWatch(): void {
  if (typeof window === 'undefined' || unreadWatchTimer === null) return;
  window.clearInterval(unreadWatchTimer);
  unreadWatchTimer = null;
}

/** 拉取收件箱历史并与 store 合并（按 id 去重；对话框打开时调用） */
export async function loadInboxHistory(): Promise<void> {
  try {
    const resp = await fetch('/api/butler/inbox?limit=50');
    const data = await resp.json();
    if (!data?.success) return;
    const rows = (data.messages ?? []) as Array<{
      id: string;
      kind: string;
      title: string;
      body: string;
      time: number;
      done: boolean;
      read?: boolean;
      action_type?: string | null;
      items?: ButlerNoticeItem[] | null;
      source?: string | null;
      thread_id?: string | null;
      messages?: ButlerNotice['messages'];
      dedupe_key?: string | null;
    }>;
    const merged = new Map<string, ButlerNotice>();
    for (const r of rows) {
      merged.set(r.id, {
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        time: r.time,
        done: !!r.done,
        // 存量行的 read 可能为 undefined（老接口未带）→ 按未点开处理，点一次即落库收敛
        read: !!r.read,
        items: r.items ?? null,
        actionType: r.action_type ?? null,
        source: r.source ?? null,
        threadId: r.thread_id ?? null,
        messages: r.messages ?? null,
        dedupeKey: r.dedupe_key ?? null,
      });
    }
    // 内存中已有但历史未返回的（刚落库前的本地态）保留
    for (const n of getButlerNotices()) {
      if (!merged.has(n.id)) merged.set(n.id, n);
    }
    setButlerNotices([...merged.values()].sort((a, b) => a.time - b.time));
  } catch {
    /* 历史拉取失败不影响实时态 */
  }
}
