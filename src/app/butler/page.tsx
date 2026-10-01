'use client';

/**
 * /butler —— Butler 移动端单栏页
 *
 * 背景：iPhone「添加到主屏幕」后 PWA 的 start_url 指向本路由，而桌面工作台（/）是
 * 「无限画布 + Butler 作为默认关闭的抽屉」，在手机上只剩一个空画布。这里给移动端一个
 * 只属于 Butler 的入口：**单栏、全屏、无画布**，把桌面的「联系人列 → 会话」压成
 * 「列表视图 ↔ 对话视图」两屏，用汉堡键切换。
 *
 * 与桌面抽屉的关系（不复制生成链路）：
 *   - 数据面完全复用既有契约：GET /api/butler/threads（列表 / 单线程全文）、
 *     POST /api/butler/threads（stream:true → SSE）、POST /api/butler/threads/session（新建）。
 *   - 正文渲染复用画布的 StreamingMarkdown；结构化提问复用 QuestionPopup（docked 模式）；
 *     排程确认卡复用 ButlerConfirmModal —— 三类挂起帧必须接住，否则服务端会空等 600s
 *     （口径见 lib/butler/entry.ts 与 ButlerDrawer 的同款处理）。
 *   - 桌面抽屉（四栏 + 可拖拽调宽）在手机上不可用，故不直接复用它的骨架。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Menu, Plus, Sparkles } from 'lucide-react';
import { ButlerConfirmModal, type ButlerConfirmState } from '@/components/canvas/ButlerConfirmModal';
import QuestionPopup, { type AnswerEntry, type QuestionItem } from '@/components/canvas/QuestionPopup';
import { StreamingMarkdown } from '@/components/canvas/HtmlRenderer';
import { stripThinkTags, type ChatMessage } from '@/lib/bus';
import type { ButlerThreadSummary } from '@/lib/butler/threads-shared';

/** 时序最小气泡模型：只在本文档内用，不复用桌面抽屉的消息结构（它带删除/多选等桌面态） */
interface MobileMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 流式中（末尾空气泡）：渲染为跳动光标 + 等待文案 */
  pending?: boolean;
}

interface PendingQuestion {
  requestId: string;
  questions: QuestionItem[];
  timeoutSec?: number;
}

/** 与 ButlerDrawer 同款收尾兜底：模型只吐思考没吐正文时，也给一句交代 */
const NO_TEXT_PLACEHOLDER = '(Butler produced no text response this time)';

/** 列表时间：今天显示 HH:MM，其余显示 M/D */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ButlerMobilePage() {
  const [view, setView] = useState<'list' | 'chat'>('list');
  const [threads, setThreads] = useState<ButlerThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MobileMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // 三类挂起帧（缺一即服务端空等超时）：排程确认卡 / 结构化提问 / 通用工具确认
  const [confirm, setConfirm] = useState<ButlerConfirmState | null>(null);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  // 发送时读 ref 而非 state：SSE 回调里要拿到「刚被首帧改写」的最新线程 id
  const activeIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch('/api/butler/threads');
      const data = (await res.json()) as { success?: boolean; sessions?: ButlerThreadSummary[] };
      if (data.success && Array.isArray(data.sessions)) setThreads(data.sessions);
    } catch {
      /* 列表拉取失败静默：下拉刷新可重试，不打断对话 */
    }
  }, []);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // 新消息 / 流式增量：始终贴底（移动端一屏一段，回滚到中间反而看不见最新回复）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 页面卸载：中止在途流，避免关页面后仍挂着 SSE
  useEffect(() => () => abortRef.current?.abort(), []);

  /** 打开某条线程：先切视图再拉历史，避免空白闪烁 */
  const openThread = useCallback(async (id: string) => {
    setView('chat');
    setActiveId(id);
    activeIdRef.current = id;
    setMessages([]);
    try {
      const res = await fetch(`/api/butler/threads?threadId=${encodeURIComponent(id)}`);
      const data = (await res.json()) as { success?: boolean; messages?: ChatMessage[]; error?: string };
      if (!res.ok || !data.success) {
        setMessages([{ id: 'err', role: 'assistant', content: `⚠ ${data.error || 'Failed to load this chat'}` }]);
        return;
      }
      const rows = (data.messages || []).map((m, i) => ({
        id: `h-${i}`,
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      }));
      setMessages(rows);
      // 打开即已读（与桌面抽屉一致：看一眼就清角标）
      void fetch(`/api/butler/threads/session?threadId=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true }),
      }).catch(() => undefined);
      void loadThreads();
    } catch (e) {
      setMessages([{ id: 'err', role: 'assistant', content: `⚠ ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }, [loadThreads]);

  /** 新建会话：先建空线程（人设弹窗在移动端略过，保持极简），再进对话视图 */
  const newChat = useCallback(async () => {
    try {
      const res = await fetch('/api/butler/threads/session', { method: 'POST' });
      const data = (await res.json()) as { success?: boolean; threadId?: string };
      if (!data.success || !data.threadId) return;
      setActiveId(data.threadId);
      activeIdRef.current = data.threadId;
      setMessages([]);
      setView('chat');
    } catch {
      /* 失败静默：留在列表页，用户可重试 */
    }
  }, []);

  // ── 挂起帧的两个回传口（与 ButlerDrawer 同款端点） ──
  const postQuestionAnswers = useCallback((requestId: string, answers: AnswerEntry[] = [], supplement?: string) => {
    void fetch('/api/chat/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        answers: answers.map((a) => ({ questionId: a.questionId, selected: a.selected, custom: a.custom })),
        supplement: supplement?.trim() || undefined,
      }),
    }).catch(() => undefined);
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    const uid = `u-${Date.now()}`;
    const aid = `a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: uid, role: 'user', content: text },
      { id: aid, role: 'assistant', content: '', pending: true },
    ]);
    setSending(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/api/butler/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          text,
          source: 'panel',
          // 首条消息时 activeIdRef 可能为空 → 服务端按「新建线程」处理，随后首帧回传新 id
          reuseThreadId: activeIdRef.current,
          stream: true,
        }),
      });

      const ctype = res.headers.get('content-type') || '';
      if (!res.ok || !res.body || !ctype.includes('text/event-stream')) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string; message?: string };
          msg = j.error || j.message || msg;
        } catch {
          /* 非 JSON 响应体 */
        }
        setMessages((prev) => prev.map((m) => (m.id === aid ? { ...m, pending: false, content: `⚠ ${msg}` } : m)));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let d: Record<string, unknown>;
            try {
              d = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            } catch {
              continue; // 心跳 / 非 JSON 帧
            }
            // 首帧 threadId：新会话靠它才能续聊（后续消息 reuseThreadId 才认得同一条线程）
            if (typeof d.threadId === 'string' && d.threadId) {
              activeIdRef.current = d.threadId;
              setActiveId(d.threadId);
            }
            // 挂起帧：接住才不会让服务端空等（确认卡 600s / 提问 600s）
            if (d.butler_confirm) {
              setConfirm(d.butler_confirm as ButlerConfirmState);
              continue;
            }
            if (d.questions_request) {
              const qr = d.questions_request as {
                requestId?: string;
                questions?: QuestionItem[];
                timeoutSec?: number;
              };
              if (qr.requestId && Array.isArray(qr.questions) && qr.questions.length > 0) {
                setQuestion({ requestId: qr.requestId, questions: qr.questions, timeoutSec: qr.timeoutSec });
              }
              continue;
            }
            // 通用工具确认：移动端用系统确认框（桌面走 ConfirmDialog），语义一致：Allow / Deny
            if (d.tool_confirm) {
              const cf = d.tool_confirm as { confirmId?: string; name?: string };
              if (cf.confirmId) {
                const approved = window.confirm(`Allow tool "${cf.name || 'unknown'}"?`);
                void fetch('/api/chat/confirm', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ confirmId: cf.confirmId, approved }),
                }).catch(() => undefined);
              }
              continue;
            }
            if (typeof d.error === 'string' && d.error) acc += `${acc ? '\n\n' : ''}⚠ ${d.error}`;
            if (typeof d.content === 'string' && d.content) {
              acc += d.content;
              // 逐帧剥 think：只在收尾剥会让「思考块」在流式期间裸露在气泡里
              const shown = stripThinkTags(acc);
              setMessages((prev) => prev.map((m) => (m.id === aid ? { ...m, content: shown } : m)));
            }
          }
        }
      }

      const finalText = stripThinkTags(acc).trim();
      setMessages((prev) =>
        prev.map((m) => (m.id === aid ? { ...m, pending: false, content: finalText || NO_TEXT_PLACEHOLDER } : m)),
      );
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aid
            ? { ...m, pending: false, content: aborted ? '(stopped)' : `⚠ ${e instanceof Error ? e.message : String(e)}` }
            : m,
        ),
      );
    } finally {
      setSending(false);
      abortRef.current = null;
      // 新会话 / 新标题：回复落地后刷新列表（标题取首条 user 消息，需重新拉摘要）
      void loadThreads();
    }
  }, [draft, sending, loadThreads]);

  const activeThread = threads.find((t) => t.threadId === activeId);
  const activeTitle = activeThread?.title || (activeId ? 'Chat' : 'New chat');
  const activeInitial = (activeTitle || 'B').trim().charAt(0).toUpperCase();

  return (
    <div className="bwm-root">
      <style>{`
        .bwm-root {
          position: fixed; inset: 0; display: flex; flex-direction: column;
          background: var(--background, #f7f7f8); color: var(--text, #171717);
          font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
          overscroll-behavior: none; -webkit-font-smoothing: antialiased;
        }

        /* ── 顶栏：磨砂玻璃 + 刘海安全区 ── */
        .bwm-header {
          flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
          padding: calc(env(safe-area-inset-top, 0px) + 12px) 14px 12px;
          background: color-mix(in oklab, var(--panel-bg, #fff) 84%, transparent);
          -webkit-backdrop-filter: saturate(180%) blur(16px); backdrop-filter: saturate(180%) blur(16px);
          border-bottom: 1px solid var(--line-soft, rgba(0,0,0,.07)); z-index: 5;
        }
        .bwm-head { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 10px; }
        .bwm-headtext { min-width: 0; }
        .bwm-name { font-size: 17px; font-weight: 700; letter-spacing: -.2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bwm-status { display: flex; align-items: center; gap: 5px; margin-top: 1px;
          font-size: 11.5px; color: var(--text-muted, #52525b); }
        .bwm-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--success, #1dc981); }

        .bwm-brandmark {
          flex: 0 0 auto; width: 34px; height: 34px; border-radius: 11px; color: #fff;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg, #6f6fff 0%, var(--primary, #4b3fe3) 100%);
          box-shadow: 0 4px 12px -3px color-mix(in oklab, var(--primary, #4b3fe3) 55%, transparent);
        }
        .bwm-avatar {
          flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 16px; font-weight: 600; color: var(--brand-text, #1a1759);
          background: linear-gradient(160deg, #eef1ff 0%, var(--brand-soft-strong, #e5eaff) 100%);
          border: 1px solid color-mix(in oklab, var(--primary, #4b3fe3) 12%, transparent);
        }
        .bwm-avatar.sm { width: 34px; height: 34px; font-size: 14px; }

        .bwm-ghost {
          flex: 0 0 auto; width: 36px; height: 36px; display: inline-flex; align-items: center;
          justify-content: center; border: 0; border-radius: 10px; background: transparent;
          color: var(--text, #171717); transition: background .15s ease; -webkit-tap-highlight-color: transparent;
        }
        .bwm-ghost:active { background: var(--muted, #efeff2); }
        .bwm-newbtn {
          flex: 0 0 auto; height: 34px; padding: 0 13px; display: inline-flex; align-items: center; gap: 4px;
          border: 0; border-radius: 999px; color: #fff; font-size: 13.5px; font-weight: 600;
          background: linear-gradient(135deg, #6f6fff 0%, var(--primary, #4b3fe3) 100%);
          box-shadow: 0 4px 12px -3px color-mix(in oklab, var(--primary, #4b3fe3) 55%, transparent);
          transition: transform .15s ease; -webkit-tap-highlight-color: transparent;
        }
        .bwm-newbtn:active { transform: scale(.96); }

        /* ── 列表 ── */
        .bwm-list { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch;
          padding: 6px 0 calc(env(safe-area-inset-bottom, 0px) + 16px); animation: bwm-in .22s ease both; }
        .bwm-row {
          width: 100%; display: flex; align-items: center; gap: 12px; text-align: left;
          padding: 11px 14px; border: 0; background: transparent; font: inherit; color: inherit;
          transition: background .15s ease; -webkit-tap-highlight-color: transparent;
        }
        .bwm-row:active { background: var(--muted, #efeff2); }
        .bwm-rowmain { flex: 1 1 auto; min-width: 0; }
        .bwm-rowtop, .bwm-rowbottom { display: flex; align-items: center; gap: 8px; }
        .bwm-rowtitle { flex: 1 1 auto; min-width: 0; font-size: 15px; font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bwm-rowprev { flex: 1 1 auto; min-width: 0; margin-top: 3px; font-size: 13px;
          color: var(--text-muted, #52525b); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bwm-time { flex: 0 0 auto; font-size: 11.5px; color: var(--ink-faint, #71717a); }
        .bwm-unread { flex: 0 0 auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
          background: var(--danger, #e8463a); color: #fff; font-size: 11px; font-weight: 600;
          line-height: 18px; text-align: center; }

        /* ── 空态 ── */
        .bwm-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 5px; padding: 72px 32px; text-align: center; }
        .bwm-chat .bwm-empty { margin: auto 0; padding: 28px 24px; }
        .bwm-emptyicon { width: 60px; height: 60px; border-radius: 20px; margin-bottom: 7px;
          display: flex; align-items: center; justify-content: center; color: var(--primary, #4b3fe3);
          background: color-mix(in oklab, var(--primary, #4b3fe3) 9%, transparent); }
        .bwm-emptytitle { font-size: 15.5px; font-weight: 600; }
        .bwm-emptyhint { max-width: 240px; font-size: 13px; line-height: 1.5; color: var(--text-muted, #52525b); }

        /* ── 对话 ── */
        .bwm-chat { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch;
          padding: 14px 14px 6px; display: flex; flex-direction: column; gap: 10px; animation: bwm-in .22s ease both; }
        .bwm-bubble { max-width: 84%; border-radius: 18px; padding: 10px 13px; font-size: 15px; line-height: 1.55;
          word-break: break-word; animation: bwm-pop .2s ease both; }
        .bwm-bubble.user { align-self: flex-end; color: #fff; white-space: pre-wrap;
          background: linear-gradient(135deg, #6f6fff 0%, var(--primary, #4b3fe3) 100%);
          border-bottom-right-radius: 6px;
          box-shadow: 0 6px 16px -8px color-mix(in oklab, var(--primary, #4b3fe3) 70%, transparent); }
        .bwm-bubble.assistant { align-self: flex-start; color: var(--text, #171717);
          background: var(--panel-bg, #fff); border: 1px solid var(--line-soft, rgba(0,0,0,.07));
          border-bottom-left-radius: 6px; box-shadow: 0 4px 14px -10px rgba(15,20,40,.35); }
        .bwm-dots { display: inline-flex; gap: 4px; align-items: center; padding: 4px 2px; }
        .bwm-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-faint, #71717a);
          animation: bwm-blink 1.2s infinite ease-in-out; }
        .bwm-dots i:nth-child(2) { animation-delay: .18s; }
        .bwm-dots i:nth-child(3) { animation-delay: .36s; }
        @keyframes bwm-blink { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
        @keyframes bwm-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        @keyframes bwm-pop { from { opacity: 0; transform: translateY(4px) scale(.99); } to { opacity: 1; transform: none; } }

        /* ── 输入条 ── */
        .bwm-composer { flex: 0 0 auto; display: flex; align-items: flex-end; gap: 8px;
          padding: 9px 12px calc(env(safe-area-inset-bottom, 0px) + 9px);
          background: color-mix(in oklab, var(--panel-bg, #fff) 88%, transparent);
          -webkit-backdrop-filter: saturate(180%) blur(16px); backdrop-filter: saturate(180%) blur(16px);
          border-top: 1px solid var(--line-soft, rgba(0,0,0,.07)); }
        .bwm-input { flex: 1 1 auto; resize: none; max-height: 132px; min-height: 40px;
          padding: 10px 14px; font-size: 15.5px; line-height: 1.4; font-family: inherit;
          border: 1px solid var(--border, rgba(0,0,0,.14)); border-radius: 20px;
          background: var(--input-bg, #f7f7f8); color: var(--text, #171717);
          transition: border-color .15s ease, box-shadow .15s ease; }
        .bwm-input:focus { outline: none; border-color: var(--primary, #4b3fe3);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary, #4b3fe3) 16%, transparent); }
        .bwm-send { flex: 0 0 auto; width: 40px; height: 40px; border: 0; border-radius: 50%; color: #fff;
          display: inline-flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg, #6f6fff 0%, var(--primary, #4b3fe3) 100%);
          box-shadow: 0 4px 12px -3px color-mix(in oklab, var(--primary, #4b3fe3) 55%, transparent);
          transition: transform .15s ease, background .15s ease; -webkit-tap-highlight-color: transparent; }
        .bwm-send:active:not(:disabled) { transform: scale(.94); }
        .bwm-send:disabled { background: var(--muted, #efeff2); color: var(--ink-faint, #71717a); box-shadow: none; }
        .bwm-qwrap { padding: 0 12px; background: var(--panel-bg, #fff); }
      `}</style>

      <header className="bwm-header">
        {view === 'chat' ? (
          <>
            <button className="bwm-ghost" aria-label="All chats" onClick={() => setView('list')}>
              <Menu size={21} />
            </button>
            <div className="bwm-head">
              <div className="bwm-avatar sm">{activeInitial}</div>
              <div className="bwm-headtext">
                <div className="bwm-name">{activeTitle}</div>
                <div className="bwm-status">
                  <span className="bwm-dot" />
                  {sending ? 'Replying…' : 'Ready'}
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="bwm-head">
              <div className="bwm-brandmark">
                <Sparkles size={17} />
              </div>
              <div className="bwm-headtext">
                <div className="bwm-name">Butler</div>
                <div className="bwm-status">
                  <span className="bwm-dot" />
                  Your personal assistant
                </div>
              </div>
            </div>
            <button className="bwm-newbtn" onClick={() => void newChat()}>
              <Plus size={15} strokeWidth={2.75} /> New
            </button>
          </>
        )}
      </header>

      {view === 'list' ? (
        <div className="bwm-list">
          {threads.length === 0 ? (
            <div className="bwm-empty">
              <div className="bwm-emptyicon">
                <Sparkles size={26} />
              </div>
              <div className="bwm-emptytitle">No chats yet</div>
              <div className="bwm-emptyhint">Tap “New” to start a conversation with Butler.</div>
            </div>
          ) : (
            threads.map((t) => (
              <button key={t.threadId} className="bwm-row" onClick={() => void openThread(t.threadId)}>
                <div className="bwm-avatar">{(t.title || 'B').trim().charAt(0).toUpperCase()}</div>
                <div className="bwm-rowmain">
                  <div className="bwm-rowtop">
                    <span className="bwm-rowtitle">{t.title || 'New chat'}</span>
                    <span className="bwm-time">{fmtTime(t.updatedAt)}</span>
                  </div>
                  <div className="bwm-rowbottom">
                    <span className="bwm-rowprev">{t.preview || '—'}</span>
                    {t.unread > 0 && <span className="bwm-unread">{t.unread > 99 ? '99+' : t.unread}</span>}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="bwm-chat" ref={scrollRef}>
            {messages.length === 0 && !sending ? (
              <div className="bwm-empty">
                <div className="bwm-emptyicon">
                  <Sparkles size={26} />
                </div>
                <div className="bwm-emptytitle">Ask Butler anything</div>
                <div className="bwm-emptyhint">Schedules, notes, research — or just a quick question.</div>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`bwm-bubble ${m.role}`}>
                  {m.role === 'assistant' ? (
                    m.pending && !m.content ? (
                      <span className="bwm-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <StreamingMarkdown content={m.content} streaming={!!m.pending} />
                    )
                  ) : (
                    m.content
                  )}
                </div>
              ))
            )}
          </div>

          {/* 结构化提问：docked 模式顶在输入框上方（无遮罩、不 portal，占满容器宽度） */}
          {question && (
            <div className="bwm-qwrap">
              <QuestionPopup
                questions={question.questions}
                timeoutSec={question.timeoutSec}
                docked
                onSubmit={(answers, supplement) => {
                  postQuestionAnswers(question.requestId, answers, supplement);
                  setQuestion(null);
                }}
                onClose={() => postQuestionAnswers(question.requestId, [])}
                onSkip={() => {
                  postQuestionAnswers(question.requestId, []);
                  setQuestion(null);
                }}
                onRestore={() => {
                  /* docked 模式无悬浮胶囊，不会触发 */
                }}
                onExpire={() => setQuestion(null)}
              />
            </div>
          )}

          <div className="bwm-composer">
            <textarea
              className="bwm-input"
              rows={1}
              value={draft}
              placeholder="Message Butler…"
              enterKeyHint="send"
              onChange={(e) => {
                setDraft(e.target.value);
                // 自动增高（上限由 CSS max-height 收口）
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="bwm-send" disabled={sending || !draft.trim()} onClick={() => void send()} aria-label="Send">
              {sending ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={19} strokeWidth={2.75} />}
            </button>
          </div>
        </>
      )}

      {/* 排程确认卡（可编辑）：复用画布同源组件，回传口与桌面一致 */}
      <ButlerConfirmModal pending={confirm} onClose={() => setConfirm(null)} zIndex={1400} />
    </div>
  );
}