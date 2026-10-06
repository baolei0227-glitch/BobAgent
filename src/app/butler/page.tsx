'use client';

/**
 * /butler —— Butler 移动端页（**完整 Butler**，不是「只有对话」）
 *
 * ## 形态：分区栈（对话为主 + 侧滑进入）
 * 桌面 Butler 是「四栏抽屉」：左功能键栏 + 联系人列 + 中栏会话 + 右栏详情。手机上这套骨架
 * 不可用（居中模态框在 390px 视口里点任意处即误关；若 localStorage 里存有桌面拖拽几何，
 * 面板宽度还会被钳到 520px 硬塞进手机 → 横向溢出）。故本页改为**栈式导航**：
 *   - 首屏 = 会话（列表 ↔ 对话，与改造前一致）
 *   - 分区 = 从右侧滑入的全屏栈（`SectionStack`），返回即回
 *   - 入口 = 左缘滑出导航（`SectionRail`），或对话里的就地入口（如气泡下方「Search trace」）
 *
 * ## 复刻范围（与桌面 `ButlerSection` 联合类型逐项对齐）
 *   notices(≈detail) / today / memories(≈rules) / preferences / calendar / meeting / search
 * 面板**直接复用桌面组件**，不自建副本：`ButlerTodayPanel` / `ButlerMemoryConsole` /
 * `ButlerCalendarPanel` / `MeetingStart` + `MeetingConsole` / `ButlerSearchTrace`。
 * 只有「回执详情」自建（`mobile/ButlerNoticePanel`，理由见该文件头：桌面那份不是受控组件）。
 *
 * ## 三处刻意的形态差异（不是遗漏）
 * 1. **会议视图不用 SectionStack**：`MeetingConsole` 卸载 = 停录（见其 `visible` 注释），
 *    故它常驻挂载、只用 `display:none` 收起 —— 与桌面「整块常驻挂载（不可见时 hidden）」同款。
 * 2. **会议轮询按需启停**：桌面在抽屉打开期间固定 3s 一取；手机上常驻轮询是净耗电，
 *    故只在「已有会议在跑 / 正看会议分区 / 导航已展开」时轮询（导航一展开就取一次，
 *    角标因此不会长期缺失）。
 * 3. **工作区 / 人设 / 模型选型**未上移动端：前者依赖桌面目录选择器，后两者属于重度设置面，
 *    手机上的价值远低于占用（需要时在桌面调整，设置按会话落库、移动端只读消费）。
 *
 * ## 挂起帧（漏接即服务端空等 600s）
 * 排程确认卡 / 结构化提问 / 通用工具确认三类**必须逐帧接住**，本页与桌面同款处理。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TouchEvent as ReactTouchEvent } from 'react';
import {
  ArrowUp,
  Brain,
  CalendarDays,
  Inbox,
  List,
  Loader2,
  Menu,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Video,
} from 'lucide-react';
import { ButlerConfirmModal, type ButlerConfirmState } from '@/components/canvas/ButlerConfirmModal';
import QuestionPopup, { type AnswerEntry, type QuestionItem } from '@/components/canvas/QuestionPopup';
import { StreamingMarkdown } from '@/components/canvas/HtmlRenderer';
import { MeetingConsole, type MeetingSnapshot } from '@/components/butler/MeetingConsole';
import { MeetingStart } from '@/components/butler/MeetingStart';
import { ButlerTodayPanel } from '@/components/butler/ButlerTodayPanel';
import { ButlerMemoryConsole } from '@/components/butler/ButlerMemoryConsole';
import { ButlerCalendarPanel } from '@/components/butler/ButlerCalendarPanel';
import { ButlerDocPanel } from '@/components/butler/ButlerDocPanel';
import { ButlerSearchTrace } from '@/components/butler/ButlerSearchTrace';
import { SectionStack } from '@/components/butler/mobile/SectionStack';
import { SectionRail, type RailEntry } from '@/components/butler/mobile/SectionRail';
import { ButlerNoticePanel } from '@/components/butler/mobile/ButlerNoticePanel';
import { useWechatSearch } from '@/components/butler/useWechatSearch';
import { getButlerNotices, subscribeButlerNotices, type ButlerNotice } from '@/components/butler/butlerNotices';
import { loadInboxHistory } from '@/components/butler/ButlerNoticeHost';
import {
  BUTLER_DOC_EVENT,
  BUTLER_FOCUS_NOTICE_EVENT,
  BUTLER_PREFERENCES_EVENT,
  BUTLER_RULES_EVENT,
  BUTLER_TODAY_EVENT,
  openButlerDoc,
} from '@/components/butler/butlerEvents';
import { stripThinkTags, type ChatMessage, type WechatSearchTrace } from '@/lib/bus';
import type { ButlerThreadSummary } from '@/lib/butler/threads-shared';

/** 时序最小气泡模型：只在本文档内用，不复用桌面抽屉的消息结构（它带删除/多选等桌面态） */
interface MobileMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 流式中（末尾空气泡）：渲染为跳动光标 + 等待文案 */
  pending?: boolean;
  /** 本轮检索账本（随消息落库）：有它 → 气泡下方出现「Search trace」就地入口 */
  searchTrace?: WechatSearchTrace;
}

interface PendingQuestion {
  requestId: string;
  questions: QuestionItem[];
  timeoutSec?: number;
}

/** 与 ButlerDrawer 同款收尾兜底：模型只吐思考没吐正文时，也给一句交代 */
const NO_TEXT_PLACEHOLDER = '(Butler produced no text response this time)';

/** 常驻「小微」搜索助手线程 ID（与 `lib/butler/storage.ts` 的 SEARCH_THREAD_ID 同源；前端不引 server 模块，硬编码对齐） */
const SEARCH_THREAD_ID = 'butler-search';

/** 正文里的文档链接接管（稳定引用，避免破坏 HtmlRenderer 的 memo）：开在本页的文档分区栈 */
const openDocFromMarkdown = (path: string): boolean => {
  openButlerDoc(path);
  return true;
};

/** 分区标识（与桌面 `ButlerSection` 联合类型逐项对齐） */
type MobileSection = 'notices' | 'today' | 'memories' | 'preferences' | 'calendar' | 'meeting' | 'search';

const SECTION_TITLES: Record<MobileSection, string> = {
  notices: 'Notifications',
  today: 'Today',
  memories: 'Memories',
  preferences: 'Preferences',
  calendar: 'Calendar',
  meeting: 'Meeting',
  search: 'Search Live',
};

/** 列表时间：今天显示 HH:MM，其余显示 M/D */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 左缘起手向右拖多长算「想开导航」 */
const EDGE_SWIPE_ZONE = 24;
const EDGE_SWIPE_MIN = 56;

export default function ButlerMobilePage() {
  // ── 会话 ──
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // ── 导航 / 分区 ──
  const [railOpen, setRailOpen] = useState(false);
  const [section, setSection] = useState<MobileSection | null>(null);
  /** 右栏文档预览（取代桌面抽屉的 docPath） */
  const [docPath, setDocPath] = useState<string | null>(null);
  /** 桌面通知点进来时要定位的回执 */
  const [focusNoticeId, setFocusNoticeId] = useState<string | null>(null);
  /**
   * 「Today」重挂载计数：桌面 `pickSection('today')` 每次都把面板重挂载（页签回到 Report）——
   * 否则用户上次停在 Schedule 页签，再点 Today 却回不到默认页。手机上同样需要这个口径。
   */
  const [todaySeq, setTodaySeq] = useState(0);

  /** 统一的「打开某分区」入口（导航 / 快捷条 / 事件总线三处共用，保证 today 的重挂载口径一致） */
  const openSection = useCallback((key: MobileSection) => {
    setRailOpen(false);
    if (key === 'today') setTodaySeq((s) => s + 1);
    setSection(key);
  }, []);

  // ── 会议（常驻挂载，见文件头「形态差异 1」） ──
  const [meeting, setMeeting] = useState<MeetingSnapshot | null>(null);
  const refreshMeeting = useCallback(async () => {
    try {
      const r = await fetch('/api/butler/meeting');
      const d = await r.json();
      setMeeting(d?.success && d.active ? (d as MeetingSnapshot) : null);
    } catch {
      /* 网络抖动：保留上一次状态，下一次轮询自愈 */
    }
  }, []);
  /** 只在「有会议在跑 / 正看会议分区 / 导航已展开」时轮询（见文件头「形态差异 2」） */
  const meetingPolling = !!meeting || section === 'meeting' || railOpen;
  useEffect(() => {
    if (!meetingPolling) return;
    void refreshMeeting();
    const t = setInterval(() => void refreshMeeting(), 3000);
    return () => clearInterval(t);
  }, [meetingPolling, refreshMeeting]);

  // ── 回执（导航角标 + 回执面板） ──
  const [notices, setNotices] = useState<ButlerNotice[]>(() => getButlerNotices());
  useEffect(() => {
    setNotices(getButlerNotices());
    const unsub = subscribeButlerNotices(setNotices);
    void loadInboxHistory();
    return unsub;
  }, []);
  const unreadNotices = useMemo(() => notices.filter((n) => !n.read).length, [notices]);

  // ── 公众号检索（与桌面共用同一份链路，见 useWechatSearch 文件头） ──
  const [searchKw, setSearchKw] = useState('');
  const loadThread = useCallback(async (id: string) => {
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
      setMessages(
        (data.messages || []).map((m, i) => ({
          id: `h-${i}`,
          role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: m.content,
          searchTrace: m.searchTrace,
        })),
      );
    } catch (e) {
      setMessages([{ id: 'err', role: 'assistant', content: `⚠ ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }, []);

  /** 起搜 / 收尾都把小微切到前台并加载其真源消息（只切 id 不加载 → 会残留上一个会话） */
  const activateSearchThread = useCallback(async () => {
    await loadThread(SEARCH_THREAD_ID);
  }, [loadThread]);

  /** 起搜那一刻把「检索实况」推到可见（本页＝收起导航并打开 search 分区） */
  const openSearchTrace = useCallback(() => {
    setRailOpen(false);
    setSection('search');
  }, []);

  const {
    captcha: searchCaptcha,
    plan: searchPlan,
    busy: searchBusy,
    notice: searchNotice,
    trace: searchTraceItems,
    traceQuery,
    status: searchStatus,
    openedTrace,
    run: runSearchRaw,
    openTraceFromMessage,
  } = useWechatSearch({
    activateSearchThread,
    openTrace: openSearchTrace,
    /** 手机上没有 Hippo Browser：候选文章改用系统浏览器打开（新标签，不打断当前页） */
    openHit: (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  });

  const runSearch = useCallback(() => {
    const q = searchKw.trim();
    if (!q) return;
    void runSearchRaw(q);
  }, [runSearchRaw, searchKw]);

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

  /**
   * 事件总线：与桌面 `ButlerHost` 同源。面板内部（今日 / 记忆 / 回执正文）可能发出
   * 打开文档 / 跳到某分区的请求，本页就近接住 —— 否则那些按钮在移动端点了没反应。
   */
  useEffect(() => {
    const onDoc = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      // **不动 section**：文档栈叠在分区栈之上，关掉文档即回到原分区（见渲染顺序注释）
      if (path) setDocPath(path);
    };
    const onToday = () => {
      openSection('today');
    };
    const onPrefs = () => {
      openSection('preferences');
    };
    const onRules = () => {
      openSection('memories');
    };
    const onFocusNotice = (e: Event) => {
      const id = (e as CustomEvent<{ noticeId?: string }>).detail?.noticeId;
      setSection('notices');
      setRailOpen(false);
      if (id) setFocusNoticeId(id);
    };
    window.addEventListener(BUTLER_DOC_EVENT, onDoc);
    window.addEventListener(BUTLER_TODAY_EVENT, onToday);
    window.addEventListener(BUTLER_PREFERENCES_EVENT, onPrefs);
    window.addEventListener(BUTLER_RULES_EVENT, onRules);
    window.addEventListener(BUTLER_FOCUS_NOTICE_EVENT, onFocusNotice);
    return () => {
      window.removeEventListener(BUTLER_DOC_EVENT, onDoc);
      window.removeEventListener(BUTLER_TODAY_EVENT, onToday);
      window.removeEventListener(BUTLER_PREFERENCES_EVENT, onPrefs);
      window.removeEventListener(BUTLER_RULES_EVENT, onRules);
      window.removeEventListener(BUTLER_FOCUS_NOTICE_EVENT, onFocusNotice);
    };
  }, [openSection]);

  /** 打开某条线程：先切视图再拉历史，避免空白闪烁 */
  const openThread = useCallback(
    async (id: string) => {
      await loadThread(id);
      // 打开即已读（与桌面抽屉一致：看一眼就清角标）
      void fetch(`/api/butler/threads/session?threadId=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true }),
      }).catch(() => undefined);
      void loadThreads();
    },
    [loadThread, loadThreads],
  );

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

  /** 「Ask Butler about this」：切回对话视图并把预填文案放进草稿（对应桌面预填抽屉输入框） */
  const askAboutNotice = useCallback((n: ButlerNotice) => {
    setSection(null);
    setDocPath(null);
    setView('chat');
    setDraft(`About “${n.title}”: `);
    window.setTimeout(() => inputRef.current?.focus(), 60);
  }, []);

  const activeThread = threads.find((t) => t.threadId === activeId);
  const activeTitle = activeThread?.title || (activeId ? 'Chat' : 'New chat');
  const activeInitial = (activeTitle || 'B').trim().charAt(0).toUpperCase();

  /** 导航条目（顺序对齐桌面左栏功能键：Today → Memories → Calendar → Meeting） */
  const railEntries: RailEntry[] = [
    {
      key: 'today',
      label: 'Today',
      hint: 'Reports, schedule, todos',
      Icon: Sun,
    },
    {
      key: 'memories',
      label: 'Memories',
      hint: 'What Butler remembers about you',
      Icon: Brain,
    },
    {
      key: 'preferences',
      label: 'Preferences',
      hint: 'Tone, working style',
      Icon: SlidersHorizontal,
    },
    { key: 'calendar', label: 'Calendar', hint: 'Your schedule', Icon: CalendarDays },
    { key: 'meeting', label: 'Meeting', hint: 'Live transcription', Icon: Video, live: !!meeting },
    { key: 'search', label: 'Search Live', hint: 'WeChat article search', Icon: Search },
    {
      key: 'notices',
      label: 'Notifications',
      hint: 'Butler inbox',
      Icon: Inbox,
      badge: unreadNotices,
      alert: true,
    },
  ];

  // ── 左缘滑动开导航（「侧滑进入」的手势侧） ──
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const onTouchStart = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    swipeRef.current = t && t.clientX <= EDGE_SWIPE_ZONE ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  }, []);
  const onTouchEnd = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - s.x;
    const dy = Math.abs(t.clientY - s.y);
    if (dx > EDGE_SWIPE_MIN && dy < 60 && Date.now() - s.t < 700) setRailOpen(true);
  }, []);

  /** 分区内容（除会议外都走分区栈；会议见文件头「形态差异 1」） */
  const sectionBody = useMemo(() => {
    switch (section) {
      case 'notices':
        return <ButlerNoticePanel onAsk={askAboutNotice} onOpenCalendar={() => setSection('calendar')} focusId={focusNoticeId} />;
      case 'today':
        /* key：点 Today 一律重挂载，页签回到 Report（与桌面 pickSection / todayOpenSeq 同口径） */
        return <ButlerTodayPanel key={`today-${todaySeq}`} embedded />;
      case 'memories':
        /* key=section：memories 与 preferences 是**同一个面板的两个段落**，
           不给 key 则 React 视为同类型同位置而**不重挂载** → initialSection 不生效
           （从 Memories 切到 Preferences 会停在原页签）。 */
        return <ButlerMemoryConsole key="memories" embedded />;
      case 'preferences':
        return <ButlerMemoryConsole key="preferences" embedded initialSection="preferences" />;
      case 'calendar':
        return <ButlerCalendarPanel />;
      case 'search':
        return (
          <div className="bwm-searchpane">
            <form
              className="bwm-searchbox"
              onSubmit={(e) => {
                e.preventDefault();
                runSearch();
              }}
            >
              <input
                className="bwm-searchinput"
                value={searchKw}
                placeholder="Search WeChat articles…"
                enterKeyHint="search"
                onChange={(e) => setSearchKw(e.target.value)}
              />
              <button
                className="bwm-searchgo"
                type="submit"
                disabled={searchBusy || !searchKw.trim()}
                aria-label="Search WeChat articles"
              >
                {searchBusy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              </button>
            </form>
            {searchCaptcha ? (
              <div className="bwm-searchwarn">
                Captcha required — finish it in the browser window opened on your Mac, then search again.
              </div>
            ) : null}
            <div className="bwm-searchbody">
              <ButlerSearchTrace
                query={openedTrace ? openedTrace.trace.query : traceQuery}
                plan={openedTrace ? { queries: openedTrace.trace.queries, intent: openedTrace.trace.intent } : searchPlan}
                items={openedTrace ? openedTrace.trace.items : searchTraceItems}
                busy={openedTrace ? false : searchBusy}
                status={searchStatus}
                notice={openedTrace ? '' : searchNotice}
                onOpen={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
              />
            </div>
          </div>
        );
      default:
        return null;
    }
  }, [
    section,
    todaySeq,
    focusNoticeId,
    askAboutNotice,
    searchKw,
    runSearch,
    searchBusy,
    searchCaptcha,
    searchStatus,
    searchNotice,
    searchTraceItems,
    searchPlan,
    traceQuery,
    openedTrace,
  ]);

  return (
    <div
      className="bwm-root"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => {
        swipeRef.current = null;
      }}
    >
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
          position: relative;
        }
        .bwm-ghost:active { background: var(--muted, #efeff2); }
        .bwm-ghostbadge {
          position: absolute; top: 2px; right: 2px; min-width: 15px; height: 15px; padding: 0 4px;
          border-radius: 999px; background: var(--danger, #e8463a); color: #fff;
          font-size: 10px; font-weight: 700; line-height: 15px; text-align: center;
        }
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
        /* 分区入口条（列表页顶部）：与「New」并列，随时可进分区 */
        .bwm-quickrow { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; overflow-x: auto;
          padding: 10px 14px 4px; -webkit-overflow-scrolling: touch; }
        .bwm-quick {
          flex: 0 0 auto; height: 32px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px;
          border: 1px solid var(--border, rgba(0,0,0,.12)); border-radius: 999px; background: var(--panel-bg, #fff);
          font: inherit; font-size: 12.5px; font-weight: 600; color: var(--text, #171717);
          -webkit-tap-highlight-color: transparent;
        }
        .bwm-quick:active { background: var(--muted, #efeff2); }
        .bwm-quickbadge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
          background: var(--danger, #e8463a); color: #fff; font-size: 10px; font-weight: 700;
          line-height: 16px; text-align: center; }

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
        /* 气泡下的就地入口（查看检索实况）：与桌面「查看检索实况」同源，口径一致 */
        .bwm-tracebtn {
          margin-top: 7px; display: inline-flex; align-items: center; gap: 5px; border: 0;
          padding: 3px 8px; border-radius: 999px; background: var(--paper-hover, #f2f2f4);
          font: inherit; font-size: 11.5px; font-weight: 600; color: var(--primary, #4b3fe3);
          -webkit-tap-highlight-color: transparent;
        }
        .bwm-tracebtn:active { background: var(--muted, #efeff2); }
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

        /* ── 会议外壳：常驻挂载，只在不可见时 display:none（卸载 = 停录） ── */
        .bwm-meetshell { display: none; }
        .bwm-meetshell.on {
          position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
          background: var(--background, #f7f7f8);
          animation: bws-in-like .22s cubic-bezier(.22,.61,.36,1) both;
        }
        @keyframes bws-in-like { from { transform: translateX(100%); } to { transform: none; } }
        .bwm-meethead {
          flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
          padding: calc(env(safe-area-inset-top, 0px) + 8px) 10px 8px;
          background: color-mix(in oklab, var(--panel-bg, #fff) 84%, transparent);
          -webkit-backdrop-filter: saturate(180%) blur(16px); backdrop-filter: saturate(180%) blur(16px);
          border-bottom: 1px solid var(--line-soft, rgba(0,0,0,.07));
        }
        .bwm-meetback { width: 36px; height: 36px; display: inline-flex; align-items: center;
          justify-content: center; border: 0; border-radius: 10px; background: transparent;
          color: var(--text, #171717); -webkit-tap-highlight-color: transparent; }
        .bwm-meetback:active { background: var(--muted, #efeff2); }
        .bwm-meettitle { flex: 1 1 auto; min-width: 0; text-align: center; font-size: 16px; font-weight: 650; }
        .bwm-meetbody { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

        /* ── 检索分区 ── */
        .bwm-searchpane { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
        .bwm-searchbox { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; }
        .bwm-searchinput { flex: 1 1 auto; min-width: 0; height: 40px; padding: 0 14px;
          font: inherit; font-size: 15px; border: 1px solid var(--border, rgba(0,0,0,.14));
          border-radius: 999px; background: var(--input-bg, #f7f7f8); color: var(--text, #171717); }
        .bwm-searchinput:focus { outline: none; border-color: var(--primary, #4b3fe3);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary, #4b3fe3) 16%, transparent); }
        .bwm-searchgo { flex: 0 0 auto; width: 40px; height: 40px; border: 0; border-radius: 50%; color: #fff;
          display: inline-flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg, #6f6fff 0%, var(--primary, #4b3fe3) 100%);
          -webkit-tap-highlight-color: transparent; }
        .bwm-searchgo:disabled { background: var(--muted, #efeff2); color: var(--ink-faint, #71717a); }
        .bwm-searchwarn { flex: 0 0 auto; margin: 0 12px 6px; padding: 8px 10px; border-radius: 10px;
          font-size: 12px; line-height: 1.45;
          background: color-mix(in oklab, var(--warn, #efaa17) 14%, transparent); color: var(--warn, #efaa17); }
        .bwm-searchbody { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      `}</style>

      <header className="bwm-header">
        {view === 'chat' ? (
          <>
            <button
              className="bwm-ghost"
              aria-label="Menu"
              onClick={() => setRailOpen(true)}
            >
              <Menu size={21} />
              {unreadNotices > 0 ? (
                <span className="bwm-ghostbadge">{unreadNotices > 9 ? '9+' : unreadNotices}</span>
              ) : null}
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
            <button className="bwm-ghost" aria-label="All chats" onClick={() => setView('list')}>
              <List size={20} />
            </button>
          </>
        ) : (
          <>
            <button className="bwm-ghost" aria-label="Menu" onClick={() => setRailOpen(true)}>
              <Menu size={21} />
              {unreadNotices > 0 ? (
                <span className="bwm-ghostbadge">{unreadNotices > 9 ? '9+' : unreadNotices}</span>
              ) : null}
            </button>
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
        <>
          {/* 分区快捷条：不必先进导航也能直达（手机上一次点击的成本要尽量低） */}
          <div className="bwm-quickrow">
            <button className="bwm-quick" onClick={() => openSection('today')}>
              <Sun size={13} /> Today
            </button>
            <button className="bwm-quick" onClick={() => openSection('calendar')}>
              <CalendarDays size={13} /> Calendar
            </button>
            <button className="bwm-quick" onClick={() => openSection('meeting')}>
              <Video size={13} /> Meeting
              {meeting ? <span className="bwm-dot" style={{ background: 'var(--success, #1dc981)' }} /> : null}
            </button>
            <button className="bwm-quick" onClick={() => openSection('search')}>
              <Search size={13} /> Search Live
            </button>
            <button className="bwm-quick" onClick={() => openSection('notices')}>
              <Inbox size={13} /> Inbox
              {unreadNotices > 0 ? <span className="bwm-quickbadge">{unreadNotices > 99 ? '99+' : unreadNotices}</span> : null}
            </button>
          </div>
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
        </>
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
                      <>
                        <StreamingMarkdown
                          content={m.content}
                          streaming={!!m.pending}
                          onOpenDoc={openDocFromMarkdown}
                        />
                        {m.searchTrace?.items.length ? (
                          <button
                            className="bwm-tracebtn"
                            onClick={() => openTraceFromMessage({ id: m.id, searchTrace: m.searchTrace })}
                          >
                            <Search size={12} />
                            Search trace
                          </button>
                        ) : null}
                      </>
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
              ref={inputRef}
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

      {/* ── 分区栈：除会议外的所有分区（会议常驻挂载，见下） ── */}
      {section && section !== 'meeting' && (
        <SectionStack
          title={SECTION_TITLES[section]}
          onClose={() => {
            setSection(null);
            setFocusNoticeId(null);
          }}
        >
          {sectionBody}
        </SectionStack>
      )}

      {/* ── 会议分区：**常驻挂载**，不可见时 display:none（卸载 = 停录，见 MeetingConsole 的 visible 注释） ── */}
      <div className={section === 'meeting' ? 'bwm-meetshell on' : 'bwm-meetshell'}>
        <div className="bwm-meethead">
          <button className="bwm-meetback" onClick={() => setSection(null)} aria-label="Back">
            <span style={{ fontSize: 20, lineHeight: 1 }}>‹</span>
          </button>
          <div className="bwm-meettitle">Meeting</div>
          <span style={{ width: 36 }} />
        </div>
        <div className="bwm-meetbody">
          {meeting ? (
            <MeetingConsole
              snapshot={meeting}
              onRefresh={refreshMeeting}
              onEnded={() => void refreshMeeting()}
              visible={section === 'meeting'}
            />
          ) : (
            <MeetingStart onStarted={() => void refreshMeeting()} />
          )}
        </div>
      </div>

      {/*
        ── 文档预览栈（正文里的 homework/… 链接 / 报告文档）──
        渲染顺序即层叠顺序（三者同为 z-60，DOM 靠后者胜）：分区栈 < 会议外壳 < 文档栈。
        故文档叠在**分区与会议之上** —— 会议进行中点开一份文档不会被控制台盖住，
        关掉文档又正好回到原位（section 全程不动，见 onDoc）。
      */}
      {docPath && (
        <SectionStack title="Document" onClose={() => setDocPath(null)}>
          <ButlerDocPanel path={docPath} embedded onClose={() => setDocPath(null)} />
        </SectionStack>
      )}

      {/* ── 左滑导航（分区栈入口） ── */}
      <SectionRail
        open={railOpen}
        onClose={() => setRailOpen(false)}
        entries={railEntries}
        onPick={(key) => openSection(key as MobileSection)}
      />

      {/* 排程确认卡（可编辑）：复用画布同源组件，回传口与桌面一致 */}
      <ButlerConfirmModal pending={confirm} onClose={() => setConfirm(null)} zIndex={1400} />
    </div>
  );
}
