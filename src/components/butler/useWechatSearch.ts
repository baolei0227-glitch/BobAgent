'use client';

/**
 * useWechatSearch —— 「公众号检索」整条链路的**唯一实现**（桌面抽屉与移动端共用）。
 *
 * ## 为什么抽成 hook
 * 这套流程原先是 `ButlerDrawer.tsx` 里约 230 行内联代码（2026-10-05 抽出）：
 *   关键词 → `/api/butler/wechat-search`（搜狗微信候选 + 检索方向拆解）
 *          → `/api/butler/wechat-search/enrich`（SSE：LLM 精选 → 读正文 → 逐篇摘要 → 综述 → CoVe 校验）
 *   结果去向：服务端把「提问 + 综述 + 卡片」落库进**小微常驻线程**（`lib/core/butler-search.ts`），
 *   前端跑完重载小微消息，结果以真实对话消息呈现；进行中那段由「检索实况」面板补过程感知。
 *
 * 移动端要复刻同一功能，若复制一份则**逐篇判定逻辑（curated / article / summary 三帧的下标＋ url
 * 双键匹配）会变成两份真源**，迟早漂移。故抽 hook，两端只提供「面板推到可见」「切到小微会话」
 * 这类**宿主才有的动作**。
 *
 * ## 状态归属
 * 过程态（本轮账本 `trace`、阶段 `phase`、兜底 `notice`、验证码 `captcha`）**刻意不落库**：
 * 落库的是结果（综述 + 卡片）。被判掉的那几篇照样留在账本里 —— AI 一次只精读 3 篇，
 * 剩下的是**被判掉而不是没搜到**，用户有权看到并照旧点开。
 *
 * ## 宿主需提供的三件事
 *   - `activateSearchThread`：把小微会话切到前台并加载消息（起搜时、收尾后各一次）
 *   - `openTrace`：把「检索实况」推到可见（起搜那一刻）
 *   - `openHit`：点候选文章的打开动作（缺省走 Hippo Browser；移动端应改为系统浏览器）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WechatSearchTrace, WechatSearchTraceItem } from '@/lib/bus';
import { desktop } from '@/lib/desktop-adapter';

/** 检索过程的阶段（enrich SSE 的 phase 帧）：只用来选一句过程文案 */
export type WechatPhase = 'curating' | 'reading' | 'summarizing' | 'digest' | 'verifying' | 'done';

/** 检索前规划：问题被拆成哪几个方向 */
export interface WechatPlan {
  intent?: string;
  queries?: string[];
}

/** 一条候选（`/api/butler/wechat-search` 的 results 元素） */
interface WechatHit {
  title: string;
  url: string;
  account?: string;
  snippet?: string;
}

export interface UseWechatSearchOptions {
  /** 把「小微」常驻会话切到前台并加载其真源消息（只切 id 不加载 → 界面残留上一个会话） */
  activateSearchThread: () => Promise<void> | void;
  /** 把「检索实况」面板推到可见（抽屉 = 展开右栏并切 search 分区；移动端 = 打开分区栈） */
  openTrace: () => void;
  /** 点候选文章的打开动作；缺省走 Hippo Browser */
  openHit?: (url: string) => void;
}

export interface UseWechatSearchResult {
  /** 候选请求在途（决定过程文案首档） */
  loading: boolean;
  /** 搜索撞上验证码 → 需要用户人工处理 */
  captcha: boolean;
  phase: WechatPhase | null;
  /** 精编报错（error 帧）：过程文案降级 */
  failed: boolean;
  plan: WechatPlan | null;
  /** 检索进行中（实况面板据此决定是否显示「判定中」段） */
  busy: boolean;
  /** 兜底说明（桥离线 / 未找到 / 中断） */
  notice: string;
  /** 本轮实时账本 */
  trace: WechatSearchTraceItem[];
  /** 本轮检索词（实况面板标题） */
  traceQuery: string;
  /** 过程文案（只反映「现在这一步在干什么」） */
  status: string;
  /** 从历史消息重开的账本（落库那份，可跨会话回看） */
  openedTrace: { messageId: string; trace: WechatSearchTrace } | null;
  /** 发起检索 */
  run: (q: string) => Promise<void>;
  /** 中断在途检索并收掉过程块 */
  cancel: () => void;
  /** 点气泡下方入口 → 回看该轮的账本 */
  openTraceFromMessage: (msg: { id: string; searchTrace?: WechatSearchTrace }) => void;
  /**
   * 消息被删时同步清账本：否则面板会继续摆着一份已经没有出处的账本。
   * 连**实时那份**一起清 —— 刚从实时切到回看时，两份是同一轮的两份副本，
   * 只清 openedTrace 会让面板「看起来没清」（退回显示实时那份、内容一模一样）。
   */
  clearOpenedTraceIfDeleted: (deletedIds: Set<string>) => void;
  /** 打开一篇候选（默认 Hippo Browser） */
  openHit: (url: string) => void;
}

export function useWechatSearch({
  activateSearchThread,
  openTrace,
  openHit,
}: UseWechatSearchOptions): UseWechatSearchResult {
  const [loading, setLoading] = useState(false);
  const [captcha, setCaptcha] = useState(false);
  const [phase, setPhase] = useState<WechatPhase | null>(null);
  const [failed, setFailed] = useState(false);
  const [plan, setPlan] = useState<WechatPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [trace, setTrace] = useState<WechatSearchTraceItem[]>([]);
  const [traceQuery, setTraceQuery] = useState('');
  const [openedTrace, setOpenedTrace] = useState<{ messageId: string; trace: WechatSearchTrace } | null>(null);
  /** 在途的检索 / 精编请求（再次点击或宿主卸载时中断） */
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  /** 组件卸载 → 中断在途请求（否则关掉面板后请求还挂着，回调往已卸载的组件写状态） */
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // 宿主回调经 ref 转接：run 是长生命周期闭包，直接进依赖数组会让它在宿主每次重渲染时重建
  // （重建本身无害，但会把 run 的引用身份传给下游 memo，得不偿失）。
  const activateRef = useRef(activateSearchThread);
  const openTraceRef = useRef(openTrace);
  activateRef.current = activateSearchThread;
  openTraceRef.current = openTrace;

  const run = useCallback(async (rawQuery: string) => {
    const q = rawQuery.trim();
    if (!q) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    let dead = false;
    const isDead = () => dead || ac.signal.aborted;

    // 搜索结果归属「小微」常驻会话：起搜即切过去，综述 + 每篇卡片作为小微的回复呈现
    await activateRef.current();
    if (isDead()) return;

    setBusy(true);
    setNotice('');
    setLoading(true);
    setCaptcha(false);
    setPhase(null);
    setFailed(false);
    setPlan(null);
    // 实况从头开始：先把上一轮的账本清掉（过程态不跨轮保留），并退出「回看历史某一轮」
    setTrace([]);
    setTraceQuery(q);
    setOpenedTrace(null);
    // 实时预览从**点下去那一刻**就开始：先切到实况（此时还没有候选，面板写「正在检索…」），
    // 候选一到就逐篇入账。若等几秒候选回来后才跳过去，前半程就是黑的——那不叫实时。
    openTraceRef.current();

    /**
     * 消费 enrich SSE —— 只挑「过程可见性」需要的帧：
     *   captcha → 要人工验证；phase → 阶段文案；error → 失败降级；done → 收尾。
     *   curated / article / summary → **只用于「检索实况」的判定展示**（哪篇留下、哪篇判掉）。
     *   它们记的是**判定过程**而不是结果内容，不落库也不进会话，所以在这里接一份不算镜像真源：
     *   结果内容（综述 + 卡片）仍只由服务端落库、前端重载后呈现，两者互不覆盖。
     *   digest 帧刻意不接：综述是结果态，时间线已有落库的那一份。
     */
    const applyEnrichEvent = (ev: Record<string, unknown>) => {
      if (isDead()) return;
      switch (ev.type as string) {
        case 'captcha':
          setCaptcha(true);
          break;
        case 'phase':
          setPhase(((ev.phase as WechatPhase) || 'curating'));
          break;
        case 'curated': {
          // 精选结果：入选的置 kept（带理由），**没入选的置 dropped**（而不是留着转圈）。
          // 判定键用服务端回的 id（= 候选下标），url 相同再兜一层，避免下标错位。
          const items = (Array.isArray(ev.items) ? ev.items : []) as Array<{
            id?: number;
            title?: string;
            url?: string;
            account?: string;
            reason?: string;
          }>;
          const picked = new Set(items.map((i) => (typeof i.id === 'number' ? i.id : -1)));
          const pickedUrls = new Set(items.map((i) => i.url || ''));
          setTrace((prev) =>
            prev.map((t) => {
              const hit = items.find((i) => i.id === t.id) ?? items.find((i) => i.url && i.url === t.url);
              const isPicked = picked.has(t.id) || (!!t.url && pickedUrls.has(t.url));
              return {
                ...t,
                verdict: isPicked ? 'kept' : 'dropped',
                ...(hit?.title ? { title: hit.title } : {}),
                ...(hit?.account ? { account: hit.account } : {}),
                ...(hit?.reason ? { reason: hit.reason } : {}),
              };
            }),
          );
          break;
        }
        case 'article': {
          // 单篇正文读取结果：只在 kept 上出现，用来标「正文没读到 → 只有搜索摘要」
          const id = typeof ev.id === 'number' ? ev.id : -1;
          const url = typeof ev.url === 'string' ? ev.url : '';
          const ok = !!ev.ok;
          setTrace((prev) =>
            prev.map((t) =>
              t.id === id || (!!url && t.url === url)
                ? {
                    ...t,
                    readOk: ok,
                    ...(typeof ev.title === 'string' && ev.title ? { title: ev.title } : {}),
                    ...(typeof ev.account === 'string' && ev.account ? { account: ev.account } : {}),
                  }
                : t,
            ),
          );
          break;
        }
        case 'summary': {
          const id = typeof ev.id === 'number' ? ev.id : -1;
          setTrace((prev) =>
            prev.map((t) =>
              t.id === id
                ? {
                    ...t,
                    ...(typeof ev.summary === 'string' && ev.summary ? { summary: ev.summary } : {}),
                    ...(typeof ev.keypoint === 'string' && ev.keypoint ? { keypoint: ev.keypoint } : {}),
                  }
                : t,
            ),
          );
          break;
        }
        case 'error':
          setFailed(true);
          // 精编中断：还没判定的一律按「判掉」落定（模型没选它们，也没读它们），
          // 免得面板上留一排永远转圈的「判定中」。
          setTrace((prev) => prev.map((t) => (t.verdict === 'pending' ? { ...t, verdict: 'dropped' } : t)));
          break;
        case 'done':
          setPhase('done');
          break;
      }
    };

    /** 读取 SSE 流并按 `data:` 行分帧 */
    const consumeEnrich = async (resp: Response) => {
      const reader = resp.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (isDead()) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
        buf += dec.decode(value, { stream: true });
        let i = buf.indexOf('\n\n');
        while (i !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              applyEnrichEvent(JSON.parse(payload) as Record<string, unknown>);
            } catch {
              /* 忽略坏帧 */
            }
          }
          i = buf.indexOf('\n\n');
        }
      }
    };

    /** 命中候选后触发的 AI 精选流水线（模型不可用 / 桥离线时静默保留原始列表） */
    const runEnrich = async (hits: WechatHit[], meta?: WechatPlan) => {
      try {
        const resp = await fetch('/api/butler/wechat-search/enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q, hits, intent: meta?.intent || '', queries: meta?.queries || [] }),
          signal: ac.signal,
        });
        if (!resp.ok || !resp.body) return;
        await consumeEnrich(resp);
      } catch {
        /* 中断 / 失败：保留原始列表 */
      }
    };

    try {
      const resp = await fetch(`/api/butler/wechat-search?q=${encodeURIComponent(q)}`, { signal: ac.signal });
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        captcha?: boolean;
        results?: WechatHit[];
        intent?: string;
        queries?: string[];
      };
      if (isDead()) return;
      if (!data.ok) {
        // 桥离线（非桌面端 / 未启动）：不静默——过程块给一句兜底说明，免得像卡死
        setCaptcha(false);
        setPlan(null);
        setNotice('公众号检索暂不可用（桥未启动 / 非桌面端）');
      } else {
        setCaptcha(!!data.captcha);
        const hits = data.results && data.results.length ? data.results : null;
        // 检索前规划结果（意图 + 拆解方向）即时上屏：用户刚发起就能看到问题被拆成几个方向
        setPlan({ intent: data.intent, queries: data.queries });
        // 候选到手就立刻收掉 loading：过程块切到「读正文 / 写综述」阶段（由 phase 驱动）
        setLoading(false);
        if (hits) {
          // 逐篇账本入账（全 pending）：从这一刻起用户能看着候选一篇篇被判留下 / 判掉，
          // 不用等综述写完。
          setTrace(
            hits.map((h, i) => ({
              id: i,
              title: h.title,
              url: h.url,
              ...(h.account ? { account: h.account } : {}),
              ...(h.snippet ? { snippet: h.snippet } : {}),
              verdict: 'pending' as const,
            })),
          );
        }
        if (!hits && !data.captcha) setNotice('没有检索到相关公众号文章');
        if (hits && !data.captcha) await runEnrich(hits, { intent: data.intent, queries: data.queries });
      }
    } catch {
      if (!isDead()) {
        setCaptcha(false);
        setNotice('检索中断，请重试');
      }
    } finally {
      if (!ac.signal.aborted) {
        setLoading(false);
        // 服务端已把本轮「提问 + 综述 + 卡片」落库（enrich 路由末尾 recordSearchExchange）
        // → 重载小微消息，让这一轮以**真实对话消息**呈现（综述气泡 + 卡片），过程块随之退场。
        await activateRef.current();
        setBusy(false);
      }
      dead = true;
    }
  }, []);

  /** 检索过程文案：只反映「现在这一步在干什么」，不承载任何结果（结果已落库成消息） */
  const status = useMemo(
    () =>
      loading
        ? 'Searching WeChat…'
        : failed
          ? 'AI summary unavailable'
          : phase === 'reading'
            ? 'Reading articles…'
            : phase === 'summarizing'
              ? 'Summarizing…'
              : phase === 'digest'
                ? 'Writing summary…'
                : phase === 'verifying'
                  ? 'Verifying…'
                  : 'AI interpreting…',
    [loading, failed, phase],
  );

  /**
   * 点综述气泡下方的「查看检索实况」→ 切到实况，并显示**这一轮**的账本（落库那份）。
   *
   * 与实时预览的区别只在于账本从哪来：这里来自消息（可跨会话 / 重启回看），
   * 那里来自本轮 SSE 帧。两者的显示口径完全一致（同一个 ButlerSearchTrace 组件）。
   */
  const openTraceFromMessage = useCallback(
    (msg: { id: string; searchTrace?: WechatSearchTrace }) => {
      if (!msg.searchTrace?.items.length) return;
      setOpenedTrace({ messageId: msg.id, trace: msg.searchTrace });
      openTraceRef.current();
    },
    [],
  );

  /**
   * 用 ref 镜像「当前正打开的那份账本」：`clearOpenedTraceIfDeleted` 要被宿主在删除回调里
   * 稳定调用（不能进依赖数组），又不该在 setState 更新函数里做副作用
   *（StrictMode 会双调用更新函数 → 副作用翻倍）。
   */
  const openedTraceRef = useRef(openedTrace);
  openedTraceRef.current = openedTrace;

  const clearOpenedTraceIfDeleted = useCallback((deletedIds: Set<string>) => {
    const cur = openedTraceRef.current;
    if (cur && deletedIds.has(cur.messageId)) {
      setOpenedTrace(null);
      setTrace([]);
      setTraceQuery('');
    }
  }, []);

  /** 点击公众号结果 → 在 Hippo Browser 打开（保留 /link?url= 形态，不打断当前页面） */
  const defaultOpenHit = useCallback((url: string) => {
    void desktop.hippoBrowser.navigate(url);
  }, []);

  return {
    loading,
    captcha,
    phase,
    failed,
    plan,
    busy,
    notice,
    trace,
    traceQuery,
    status,
    openedTrace,
    run,
    cancel,
    openTraceFromMessage,
    clearOpenedTraceIfDeleted,
    openHit: openHit ?? defaultOpenHit,
  };
}
