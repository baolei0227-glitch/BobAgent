'use client';

/**
 * ButlerTodayPanel —— Today 页（Butler 助理的首屏）
 *
 * 设计取向：
 *   - **首屏直接进 Report**：打开即 Report / Schedule / Sticky 三页签。原先顶部那张只给一条建议的
 *     蓝色建议卡已移除（2026-09-27）；2026-10-03 起建议以**结构化可点击清单**回归到 Report 页签
 *     顶部（2–3 条，由 lib/butler/advice.ts 实时规则推导，不进模型、不缓存）。
 *   - **承载整份日报（2026-09-27）**：三个页签搬到这里，通知助理 Bobby 不再推送日报；
 *     Schedule / Sticky 的行可直接勾选完成（写入落到日历事件 / 便签行，见下方 toggleItem）。
 *   - 原先底部的「收件箱」「报告文档」两块已移除（2026-09-27）—— 收件箱走抽屉，报告文档走文件面板。
 *
 * 排版层级（与右栏日报同一套口径）：
 *   分区头（深色半粗 + 计数徽标）> 扁平行（无底色）。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import type { TodaySnapshot } from '@/lib/butler/today';
import type { AdviceCard } from '@/lib/butler/advice';
import type { ButlerNoticeItem } from '@/lib/bus';
import {
  NEWS_TOPIC_SOFT_MAX,
  slugifyTopic,
  type NewsBriefing,
  type NewsConfig,
  type NewsItem,
  type NewsTopic,
} from '@/lib/news/types';
import { StreamingMarkdown } from '@/components/canvas/HtmlRenderer';
import { openProjectById } from './butlerEvents';

/** /api/butler/today 的 reports 段：日报三页签的内容（2026-09-27 起整份日报由 Today 承载） */
interface TodayReports {
  /** 各项目昨日进展摘要（每日 9:00 生成一次并缓存）；未生成时为 null */
  progress: { markdown: string } | null;
  schedule: { text: string; items: ButlerNoticeItem[] };
  /** 便签待办实算失败时为 null（该页签退化成一行提示） */
  sticky: { text: string; items: ButlerNoticeItem[]; totalPending: number; projectCount: number } | null;
}

/** /api/butler/today 的 news 段（Daily News 页签：主题配置 + 当日简报） */
interface TodayNews {
  config: NewsConfig | null;
  briefing: NewsBriefing | null;
}

/** Today 面板四页签：Report（自己的昨日复盘）+ News（外部资讯）在前，Schedule / Sticky（今天要做的事）在后。
 *  注：显示顺序**不再**与 lib/butler/report-group.ts 的 REPORT_SECTION_ORDER 对齐 —— 那份顺序管的是
 *  报告文档里的分区排列，与面板页签是两件事，此前注释把它们绑在一起是错的。 */
type ReportTab = 'report' | 'news' | 'schedule' | 'sticky';
const REPORT_TABS: readonly { key: ReportTab; label: string }[] = [
  { key: 'report', label: 'Report' },
  { key: 'news', label: 'News' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'sticky', label: 'Sticky' },
];

/** 各页签「已看过」的日期键（localStorage，tab → YYYY-MM-DD）—— 口径与 ButlerDrawer 的 Today 键红点一致：
 *  存**日期**而非布尔，隔天自然重新亮起；且只在「页签确有内容 + 用户正看着它」时才落标，
 *  这样 8:00 先打开面板（当时还没有内容）不会把 9:00 才生成的那份误标成已读。 */
const TAB_SEEN_KEY = 'butler.today-tabs.seen.v1';

/** Schedule 页每个分区默认列出的条数：余下的折成一行可点的「N more」（逾期动辄几十条，全铺开会淹掉 Today） */
const SCHEDULE_PREVIEW = 10;

export interface ButlerTodayPanelProps {
  /** 独立浮窗模式的关闭回调；嵌入抽屉栏时省略（关闭由抽屉统一提供） */
  onClose?: () => void;
  /** 嵌入抽屉栏：去掉 fixed/锚定/阴影/圆角，填满父容器 */
  embedded?: boolean;
}

/** 本地时间 HH:mm */
function fmtHM(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** 毫秒时间戳 → 本地 HH:mm（sticky 项只有 startMs，没有可读 time） */
function hhmmFromMs(ms: number): string {
  return fmtHM(new Date(ms));
}

/** 本地日期键 YYYY-MM-DD。与 lib/butler/storage 的 dateStamp 同格式，但那边摸 fs，
 *  不能在 'use client' 组件里 import，故此处本地实现一份。 */
function localDayKey(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 独立浮窗默认样式（embedded 时改为填满父栏，由抽屉提供边框与背景） */
function panelStyle(embedded?: boolean): React.CSSProperties {
  if (embedded) {
    return {
      width: '100%',
      height: '100%',
      overflowY: 'auto',
      padding: 16,
      color: 'var(--foreground)',
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
    };
  }
  return {
    position: 'fixed',
    right: 20,
    top: 64,
    width: 360,
    maxHeight: 'calc(100vh - 108px)',
    overflowY: 'auto',
    padding: 16,
    borderRadius: 16,
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    boxShadow: '0 18px 48px rgba(0,0,0,0.18)',
    color: 'var(--foreground)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    zIndex: 1200,
  };
}

/** 日期行：嵌入态的一级标题由抽屉顶部条承担，这里只留日期当次级信息 */
const dateLine: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-faint)',
  marginBottom: 12,
};

/** 分区头整行（名 + 计数徽标），上方留白拉开分区 */
const sectionHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  margin: '16px 0 6px',
};
/** 分区名：一级，深色半粗 —— 比它统领的行更重 */
const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--ink-strong)',
};
/** 计数：二级，退成小徽标 */
const countBadge: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  padding: '1px 6px',
  borderRadius: 999,
  background: 'var(--paper-hover)',
  color: 'var(--ink-muted)',
};
/** 逾期徽标：同尺寸，换成 warn 底色以示「这类要盯」 */
const countBadgeWarn: React.CSSProperties = {
  ...countBadge,
  background: 'color-mix(in oklab, var(--warn) 14%, transparent)',
  color: 'var(--warn)',
};

/** 分区头：名 + 计数徽标（warn 变体用于逾期） */
function SectionHead({ label, count, warn }: { label: string; count?: number | string; warn?: boolean }) {
  return (
    <div style={sectionHead}>
      <span style={sectionLabel}>{label}</span>
      {count !== undefined && <span style={warn ? countBadgeWarn : countBadge}>{count}</span>}
    </div>
  );
}

/** 日报三页签的页签条（底色胶囊 + 选中项浮起，与右栏日报页签同观感） */
const tabBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  borderRadius: 8,
  padding: 2,
  background: 'var(--paper-hover)',
};
function tabBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '4px 8px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 11,
    fontWeight: 500,
    background: active ? 'var(--panel-bg)' : 'transparent',
    color: active ? 'var(--ink-strong)' : 'var(--ink-muted)',
  };
}

/** 未读内容点：小实心点（**不用数字红点** —— 不打扰，看即灭）。色取 --danger，
 *  与 ButlerDrawer 回执卡的未读点同源。 */
const tabDot: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: 999,
  background: 'var(--danger)',
  flexShrink: 0,
};
/** 标签栏分组细线：Report / News（**读的**）与 Schedule / Sticky（**做的**）之间一道竖线 */
const tabDivider: React.CSSProperties = {
  width: 1,
  height: 14,
  flexShrink: 0,
  alignSelf: 'center',
  background: 'var(--line)',
};

/** 页签条吸顶容器：面板自身就是滚动区（embedded 时 overflow-y:auto），页签滚出视野后
 *  就不知道自己在哪一页 —— 用 sticky 钉在滚动区顶端。横向负边距 + 等量内边距，让不透明底色
 *  铺满整宽（否则被截断的行会从页签两侧透出来）。底色与抽屉右栏 / 浮窗面板同为 --popover，
 *  吸顶时看不出接缝；下沿一道细线标示「这条是固定的」。（同 McpStorePanel 的吸顶头部写法。） */
const tabSticky: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  marginLeft: -16,
  marginRight: -16,
  paddingLeft: 16,
  paddingRight: 16,
  paddingBottom: 8,
  background: 'var(--popover)',
  borderBottom: '1px solid var(--line-soft)',
};

/** 可勾选待办行：点整行即完成/取消 —— 与 ButlerDrawer.toggleItem 的交互一致，
 *  但 Today 面板没有收件箱回执，勾选后只更新本地列表（不再 PATCH inbox）。 */
function ItemRow({ item, onToggle }: { item: ButlerNoticeItem; onToggle: (it: ButlerNoticeItem) => void }) {
  const done = item.status === 'done';
  const meta = item.time || (item.startMs > 0 ? hhmmFromMs(item.startMs) : '');
  return (
    <button
      type="button"
      onClick={() => onToggle(item)}
      className="hover:bg-[var(--paper-hover)]"
      style={{
        ...rowStyle,
        width: '100%',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <CheckCircle2
        size={13}
        style={{ flexShrink: 0, marginTop: 2, color: done ? 'var(--success)' : 'var(--ink-faint)' }}
      />
      <span
        style={{
          ...rowTitle,
          color: done ? 'var(--ink-faint)' : 'var(--ink-strong)',
          textDecoration: done ? 'line-through' : undefined,
        }}
      >
        {item.title}
        {item.subgroup && (
          <span style={{ display: 'block', fontSize: 10, color: 'var(--ink-faint)' }}>{item.subgroup}</span>
        )}
      </span>
      {meta && <span style={rowMeta}>{meta}</span>}
    </button>
  );
}

/** 行动行：**无勾选**、右侧 chevron —— 点击执行一个动作（当前只有「切到某项目」）。
 *  与 ItemRow 分开，是因为它表达的是「去那儿」而不是「做完了」。 */
function ActionRow({ item, onAction }: { item: ButlerNoticeItem; onAction: (it: ButlerNoticeItem) => void }) {
  return (
    <button
      type="button"
      onClick={() => onAction(item)}
      className="hover:bg-[var(--paper-hover)]"
      style={{
        ...rowStyle,
        alignItems: 'center',
        width: '100%',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <span style={rowTitle}>{item.title}</span>
      {item.time && <span style={rowMeta}>{item.time}</span>}
      <ChevronRight size={13} style={{ flexShrink: 0, color: 'var(--ink-faint)' }} />
    </button>
  );
}

/** 建议卡：底色只留给它（行一律无底色），把「判断」与下面统领的行分开 */
const adviceCard: React.CSSProperties = {
  marginBottom: 8,
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--paper-hover)',
};
const adviceTitle: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  lineHeight: 1.45,
  color: 'var(--ink-strong)',
};
/** 依据行：可解释、可反驳 —— 比判断低一级 */
const adviceReason: React.CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--ink-muted)',
};

/** 行：**无底色**（底色只留给建议卡，别让每行都自成一块），靠字重与缩进分主次 */
const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'baseline',
  padding: '5px 6px',
  borderRadius: 8,
  marginBottom: 1,
};
/** 行内正文：一级 */
const rowTitle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  color: 'var(--ink-strong)',
};
/** 行内次要信息（时间 / 类型 / 大小）：二级 */
const rowMeta: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--ink-faint)',
};

/** 空态 / 补充说明行 */
const emptyRow: React.CSSProperties = {
  padding: '4px 6px',
  fontSize: 11.5,
  color: 'var(--ink-faint)',
};

/** 分区内的「展开更多」：长得像行，但是可点（做成一枚按钮，不再是不可点的说明文字） */
const moreBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '4px 6px',
  marginTop: 1,
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--ink-muted)',
  fontSize: 11.5,
  cursor: 'pointer',
};

/* ── News 页签（第 4 页签：Daily News）────────────────────────── */

/** 页头一行：Topics 标签 + Refresh now */
const newsHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  margin: '10px 0 6px',
};

/** Refresh now：小号次级按钮 */
const refreshBtn: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--ink-muted)',
  borderRadius: 999,
  padding: '2px 10px',
  fontSize: 11,
  cursor: 'pointer',
};

/** 主题 chips 容器 */
const chipRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  marginBottom: 10,
};

/** 单个主题 chip */
const chip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 4px 2px 8px',
  borderRadius: 999,
  background: 'var(--paper-hover)',
  color: 'var(--ink-strong)',
  fontSize: 11,
};

/** chip 上的移除按钮 */
const chipX: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--ink-faint)',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
  padding: '0 2px',
};

/** 新增主题输入框（无边框，融入 chips 行） */
const chipInput: React.CSSProperties = {
  minWidth: 70,
  flex: 1,
  border: 'none',
  borderBottom: '1px dashed var(--line-soft)',
  background: 'transparent',
  color: 'var(--ink-strong)',
  font: 'inherit',
  fontSize: 11,
  padding: '2px 0',
  outline: 'none',
};

/** 降级标注（LLM 不可用 → 纯链接列表） */
const notSummBadge: React.CSSProperties = {
  display: 'inline-block',
  marginBottom: 8,
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 600,
  background: 'color-mix(in oklab, var(--warn) 14%, transparent)',
  color: 'var(--warn)',
};

/** 单条新闻：无底色行 */
const newsItem: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px',
  borderRadius: 8,
  marginBottom: 2,
};

/** 新闻标题（链接本体） */
const newsTitle: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--ink-strong)',
  textDecoration: 'none',
};

/** 一句话总结 */
const newsSummary: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--ink-muted)',
};

/** why 行 */
const newsWhy: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--ink-faint)',
};

/** 单条新闻行：标题开原文，下面依次是总结 / why / 来源域 */
function NewsRow({ item }: { item: NewsItem }) {
  return (
    <div style={newsItem}>
      <a href={item.url} target="_blank" rel="noreferrer" style={newsTitle}>
        {item.title}
      </a>
      {item.summary && <div style={newsSummary}>{item.summary}</div>}
      {item.why && <div style={newsWhy}>Why: {item.why}</div>}
      {item.source && <div style={rowMeta}>{item.source}</div>}
    </div>
  );
}

/** 读取中 / 出错提示 */
const hintText: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-faint)',
};

const closeBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--muted-foreground)',
  cursor: 'pointer',
  fontSize: 14,
  padding: '2px 6px',
  borderRadius: 6,
};

export function ButlerTodayPanel({ onClose, embedded }: ButlerTodayPanelProps) {
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [reports, setReports] = useState<TodayReports | null>(null);
  /** 今日建议（实时规则推导，2–3 条）：与 reports 平级，见 /api/butler/today 的 advice 字段 */
  const [advice, setAdvice] = useState<AdviceCard[]>([]);
  /** News 页签：主题配置 + 当日简报（随 /api/butler/today 一起下发，只读缓存） */
  const [newsConfig, setNewsConfig] = useState<NewsConfig | null>(null);
  const [newsBriefing, setNewsBriefing] = useState<NewsBriefing | null>(null);
  /** Refresh now 进行中（采集 + 归纳较重，给出禁用态反馈） */
  const [newsBusy, setNewsBusy] = useState(false);
  /** 新增主题的输入值 */
  const [newTopic, setNewTopic] = useState('');
  const [tab, setTab] = useState<ReportTab>('report');
  /** Schedule 页各分区是否已展开（默认只列前 SCHEDULE_PREVIEW 条，点「+N more」摊开余下部分） */
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 各页签的「已看过」日期键（见 TAB_SEEN_KEY）：只存在本机，服务端不为此存状态 */
  const [seenTabs, setSeenTabs] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/butler/today');
        const data = await res.json();
        if (cancelled) return;
        if (!data?.success) {
          setError(data?.error ?? 'Failed to load today overview');
          return;
        }
        setSnapshot(data.snapshot as TodaySnapshot);
        const rep = (data.reports as TodayReports | undefined) ?? null;
        setReports(rep);
        setAdvice((data.advice as AdviceCard[] | undefined) ?? []);
        // News 页签：主题配置 + 当日简报（只读缓存；采集 + 归纳走每日调度或 Refresh now）
        const nw = data.news as TodayNews | undefined;
        setNewsConfig(nw?.config ?? null);
        setNewsBriefing(nw?.briefing ?? null);
        // AI 判断走缓存：命中时上面的 advice 已带 AI reason；未命中（adviceStale）先用规则文案渲染，
        // 再后台补算 —— 拿到后**就地按 id 替换 reason**（不重排、不新增卡片、不阻塞已渲染内容）。
        if (data.adviceStale) {
          void fetch('/api/butler/advice/refresh', { method: 'POST' })
            .then((r) => r.json())
            .then((d: { success?: boolean; reasons?: Record<string, string> | null }) => {
              if (cancelled || !d?.success || !d.reasons) return;
              const reasons = d.reasons;
              setAdvice((prev) =>
                prev.map((c) => (reasons[c.id] ? { ...c, reason: reasons[c.id] } : c)),
              );
            })
            .catch(() => undefined);
        }
        // Report 摘要已经渲染出来 → 通知宿主清掉左栏 Today 键的红点（红点逻辑见 ButlerDrawer）
        if (rep?.progress) window.dispatchEvent(new Event('butler-today-digest-loaded'));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load today overview');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 「已看过」标记从本机读回（服务端不存阅读状态 —— 单机应用，同 ButlerDrawer 的 Today 键红点口径）。
  // 必须声明在下面的 markSeen effect 之前：同一提交里两次 setSeenTabs 按声明顺序应用，
  // 后者是函数式更新，拿到的 prev 就是这里读回的旧值，不会把它覆盖掉。
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TAB_SEEN_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') setSeenTabs(parsed as Record<string, string>);
    } catch {
      /* 解析失败 / 隐私模式读不到：当作都没看过 */
    }
  }, []);

  /** 标记某页签今天已看过 —— 只在它**确有内容**时才落标（调用点见下方 effect） */
  const markSeen = useCallback((key: ReportTab) => {
    const today = localDayKey();
    setSeenTabs((prev) => {
      if (prev[key] === today) return prev; // 已是今天 → 原样返回，避免无谓渲染
      const next = { ...prev, [key]: today };
      try {
        localStorage.setItem(TAB_SEEN_KEY, JSON.stringify(next));
      } catch {
        /* 写入失败（隐私模式等）：本次会话内仍然生效 */
      }
      return next;
    });
  }, []);

  /** 每个页签今天有没有内容 —— 状态点的数据源。四项**全部由既有响应派生**，
   *  不必给 /api/butler/today 新增字段：progress / schedule / sticky / briefing 都已经在下发。 */
  const tabHasContent = useMemo<Record<ReportTab, boolean>>(
    () => ({
      report: !!reports?.progress,
      news: (newsBriefing?.items.length ?? 0) > 0,
      schedule: (reports?.schedule.items.length ?? 0) > 0,
      sticky: (reports?.sticky?.totalPending ?? 0) > 0,
    }),
    [reports, newsBriefing],
  );

  /** 正看着的这个页签一旦有内容就算看过 —— 含「先打开、内容后到」：不给自己这一颗亮 */
  useEffect(() => {
    if (tabHasContent[tab]) markSeen(tab);
  }, [tab, tabHasContent, markSeen]);

  /**
   * 勾选一条待办（Schedule / Sticky / 建议区共用）：与 ButlerDrawer.toggleItem 同源 ——
   *   - source='event'：key 即日历事件 id → PATCH 事件状态，日历 / 便签侧随之联动；
   *   - source='sticky'：便签待办行 → 勾掉便签正文对应行，该行已入日历则事件同步完成。
   * 区别：Today 面板没有收件箱回执行，勾选后只翻转本地列表状态，不再 PATCH inbox。
   * 建议区同一行也要跟着翻 —— 否则勾完建议里的那条没有即时反馈（远端请求照常发）。
   */
  const toggleItem = useCallback((item: ButlerNoticeItem) => {
    const done = item.status !== 'done';
    const flip = (items: ButlerNoticeItem[]) =>
      items.map((it) => (it.key === item.key ? { ...it, status: done ? 'done' : '' } : it));
    setReports((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        schedule: { ...prev.schedule, items: flip(prev.schedule.items) },
        sticky: prev.sticky ? { ...prev.sticky, items: flip(prev.sticky.items) } : prev.sticky,
      };
    });
    setAdvice((prev) =>
      prev.map((c) => (c.items.some((it) => it.key === item.key) ? { ...c, items: flip(c.items) } : c)),
    );
    if (item.source === 'event' && item.key) {
      const eventId = item.key;
      void fetch(`/api/calendar/events?event_id=${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: done ? 'done' : 'scheduled' }),
      })
        .then(() => {
          window.dispatchEvent(new Event('calendar-events-changed'));
          if (done) {
            window.dispatchEvent(new CustomEvent('butler-event-sync', { detail: { eventId, action: 'done' } }));
          }
        })
        .catch(() => undefined);
      return;
    }
    if (item.source === 'sticky' && item.sticky) {
      const s = item.sticky;
      void fetch('/api/sticky-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggle_line',
          project_id: s.projectId,
          note_id: s.noteId,
          page_id: s.pageId,
          line_index: s.lineIndex,
          text: s.text,
          done,
        }),
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { success?: boolean };
          if (!data.success) return;
          // 该行可能已入日历 → 广播重载日历 / 便签画布
          window.dispatchEvent(new Event('calendar-events-changed'));
        })
        .catch(() => undefined);
    }
  }, []);

  /**
   * 建议区的行动行（当前只有 source='project'）：点击即切到该项目，
   * 由宿主（CanvasFlow 等）监听 `bobagent:project-switched` 重载画布 —— 与 NavSearchBox / Sidebar 同链路。
   */
  const onAdviceAction = useCallback((item: ButlerNoticeItem) => {
    if (item.source === 'project' && item.project) void openProjectById(item.project.projectId);
  }, []);

  /**
   * 保存主题 chips（整份覆盖）：先乐观更新本地，再落同一份 config
   * （POST /api/butler/news save-topics，与 Butler 对话工具 news_topics 同写口）。
   * 改主题**当天不重写简报** —— 用户点 Refresh now 才重算。
   */
  const saveTopics = useCallback(async (next: NewsTopic[]) => {
    setNewsConfig((prev) => ({ topics: next, updatedAt: prev?.updatedAt ?? '' }));
    try {
      const res = await fetch('/api/butler/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save-topics', topics: next }),
      });
      const d = (await res.json()) as { success?: boolean; config?: NewsConfig };
      if (d?.success && d.config) setNewsConfig(d.config);
    } catch {
      /* 乐观值保留，失败不阻断界面 */
    }
  }, []);

  /** 新增主题（Enter 或失焦提交）；重名忽略 */
  const addTopic = useCallback(() => {
    const label = newTopic.trim();
    if (!label) return;
    const topics = [...(newsConfig?.topics ?? [])];
    if (topics.some((t) => t.label.toLowerCase() === label.toLowerCase())) {
      setNewTopic('');
      return;
    }
    topics.push({
      id: slugifyTopic(label),
      label,
      query: label,
      limit: 4,
      lang: /[\u4e00-\u9fa5]/.test(label) ? 'zh' : 'en',
    });
    setNewTopic('');
    void saveTopics(topics);
  }, [newTopic, newsConfig, saveTopics]);

  /** 移除主题 */
  const removeTopic = useCallback(
    (id: string) => {
      const topics = (newsConfig?.topics ?? []).filter((t) => t.id !== id);
      void saveTopics(topics);
    },
    [newsConfig, saveTopics],
  );

  /** Refresh now：强制重算当日简报（采集 + 归纳） */
  const refreshNews = useCallback(async () => {
    setNewsBusy(true);
    try {
      const res = await fetch('/api/butler/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      });
      const d = (await res.json()) as { success?: boolean; briefing?: NewsBriefing };
      if (d?.success && d.briefing) setNewsBriefing(d.briefing);
    } catch {
      /* 保持原简报 */
    } finally {
      setNewsBusy(false);
    }
  }, []);

  /** News 页签：按主题分组（保持 items 的原始顺序） */
  const newsGroups = useMemo(() => {
    const byGroup = new Map<string, NewsItem[]>();
    for (const it of newsBriefing?.items ?? []) {
      const arr = byGroup.get(it.topicLabel);
      if (arr) arr.push(it);
      else byGroup.set(it.topicLabel, [it]);
    }
    return [...byGroup.entries()];
  }, [newsBriefing]);

  /** Sticky 页签：按项目分组（与右栏日报 Sticky 页同一铺平口径，见 buildStickyTodoItems） */
  const stickyGroups = useMemo(() => {
    const byGroup = new Map<string, ButlerNoticeItem[]>();
    for (const it of reports?.sticky?.items ?? []) {
      const g = it.group ?? '';
      const arr = byGroup.get(g);
      if (arr) arr.push(it);
      else byGroup.set(g, [it]);
    }
    return [...byGroup.entries()];
  }, [reports]);

  const dateLabel = new Date().toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    // hide-scrollbar：面板靠右贴边，原生滚动条会压在最右一列的文字上（见 globals.css 的工具类）
    <aside className="hide-scrollbar" style={panelStyle(embedded)} role="dialog" aria-label="Today overview">
      {/* 面板自身不再有任何头部（2026-09-27 按要求去掉嵌入态那行日期）：
          嵌入右栏时顶部条已写着「Today」，面板再顶一行日期只是占地方 —— 现在打开即三页签。
          独立浮窗态仍自带完整标题（Today + 日期 + 关闭），该分支目前无调用方，保留以备浮窗复用。 */}
      {!embedded && (
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-strong)' }}>Today</div>
            <div style={{ ...dateLine, margin: '2px 0 0' }}>{dateLabel}</div>
          </div>
          {onClose && (
            <button type="button" onClick={onClose} style={closeBtn} aria-label="Close">
              ✕
            </button>
          )}
        </header>
      )}

      {loading && <p style={hintText}>Loading today…</p>}
      {error && <p style={{ ...hintText, color: 'var(--danger)' }}>{error}</p>}

      {!loading && !error && snapshot && (
        <>
          {/* 四页签（2026-09-27 起整份日报由 Today 承载，Bobby 不再推送；2026-10-04 追加 News）：
              Report=各项目昨日进展 / News=今日资讯简报 / Schedule=今日 + 逾期待办 / Sticky=全项目便签待办。
              前两个是**读的**（内容产出），后两个是**做的**（待办），故在二者之间落一道竖线分组。
              原先顶层的「今天 / 逾期」两块并进 Schedule 页，不再重复占版面。 */}
          {reports && (
            <>
              <div style={{ ...tabSticky, marginTop: embedded ? 0 : 14 }}>
                <div style={tabBar}>
                  {REPORT_TABS.map((t) => (
                    <Fragment key={t.key}>
                      {t.key === 'schedule' && <span style={tabDivider} aria-hidden />}
                      <button
                        type="button"
                        role="tab"
                        aria-selected={tab === t.key}
                        onClick={() => setTab(t.key)}
                        style={tabBtnStyle(tab === t.key)}
                      >
                        {t.label}
                        {/* 状态点：今天这条有内容、且还没看过 → 亮；切过去即灭（markSeen） */}
                        {tabHasContent[t.key] && seenTabs[t.key] !== localDayKey() && (
                          <span style={tabDot} aria-label="New content" />
                        )}
                      </button>
                    </Fragment>
                  ))}
                </div>
              </div>

              {tab === 'report' && (
                <div>
                  {/* 今日建议（实时规则，不进模型）：结论在前、可点的行动在后 —— 这是「Report 真正给判断」的落点。
                      没有建议（advice 为空）时不渲染该分区，直接进下方昨日复盘。 */}
                  {advice.length > 0 && (
                    <div>
                      <SectionHead label="Today's advice" count={advice.length} />
                      {advice.map((card) => (
                        <div key={card.id} style={adviceCard}>
                          <div style={adviceTitle}>{card.title}</div>
                          <div style={adviceReason}>{card.reason}</div>
                          {/* 卡内不缩进：卡本身已有底色框，再缩进会与下方「Yesterday」的平铺行错位 */}
                          <div style={{ marginTop: 4 }}>
                            {card.items.map((it) =>
                              it.source === 'project' ? (
                                <ActionRow key={it.key} item={it} onAction={onAdviceAction} />
                              ) : (
                                <ItemRow key={it.key} item={it} onToggle={toggleItem} />
                              ),
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <SectionHead label="Yesterday" />
                  {reports.progress ? (
                    // butler-report：Report 页是三个页签里唯一直接渲染 markdown 的，
                    // 靠这个类把小结 blockquote 渲染成柔和底卡、并拉开与明细的层级（见 globals.css）。
                    <div className="butler-md butler-report" style={{ marginTop: 4 }}>
                      <StreamingMarkdown content={reports.progress.markdown} streaming={false} />
                    </div>
                  ) : (
                    <div style={emptyRow}>Progress digest not generated yet (runs daily after 9:00)</div>
                  )}
                </div>
              )}

              {tab === 'schedule' && (
                <div style={{ marginTop: 6 }}>
                  {(
                    [
                      { sec: 'today', label: 'Today', total: snapshot.today.count },
                      { sec: 'overdue', label: 'Overdue', total: snapshot.overdue.count },
                    ] as const
                  ).map(({ sec, label, total }) => {
                    const rows = reports.schedule.items.filter((x) => (x.section ?? 'overdue') === sec);
                    const opened = !!expandedSections[sec];
                    const shown = opened ? rows : rows.slice(0, SCHEDULE_PREVIEW);
                    const folded = rows.length - shown.length;
                    return (
                      <div key={sec}>
                        <SectionHead label={label} count={total} warn={sec === 'overdue' && total > 0} />
                        {rows.length === 0 ? (
                          <div style={emptyRow}>{sec === 'today' ? 'No events today' : 'Nothing overdue'}</div>
                        ) : (
                          <>
                            {shown.map((x) => (
                              <ItemRow key={x.key} item={x} onToggle={toggleItem} />
                            ))}
                            {/* 折叠的余下条目点一下就摊开（此前这里是一行不可点的说明文字，用户没法看到被截掉的待办） */}
                            {folded > 0 && (
                              <button
                                type="button"
                                className="hover:bg-[var(--paper-hover)]"
                                style={moreBtn}
                                onClick={() => setExpandedSections((p) => ({ ...p, [sec]: true }))}
                              >
                                {folded} more …
                              </button>
                            )}
                            {opened && rows.length > SCHEDULE_PREVIEW && (
                              <button
                                type="button"
                                className="hover:bg-[var(--paper-hover)]"
                                style={moreBtn}
                                onClick={() => setExpandedSections((p) => ({ ...p, [sec]: false }))}
                              >
                                Show less
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {tab === 'sticky' && (
                <div style={{ marginTop: 6 }}>
                  {!reports.sticky ? (
                    <div style={emptyRow}>Failed to load sticky todos — try again later</div>
                  ) : stickyGroups.length === 0 ? (
                    <div style={emptyRow}>
                      {reports.sticky.totalPending === 0 ? 'All sticky todos are done' : 'Nothing to list'}
                    </div>
                  ) : (
                    stickyGroups.map(([group, rows]) => {
                      const left = rows.filter((x) => x.status !== 'done').length;
                      return (
                        <div key={group || 'ungrouped'}>
                          <SectionHead label={group || 'Untitled project'} count={left > 0 ? left : `✓ ${rows.length}`} />
                          {rows.map((x) => (
                            <ItemRow key={x.key} item={x} onToggle={toggleItem} />
                          ))}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {tab === 'news' && (
                <div style={{ marginTop: 6 }}>
                  {/* 主题 chips：直接增删（自动保存同一份 config）；右侧 Refresh now 才重算当日简报 */}
                  <div style={newsHead}>
                    <span style={sectionLabel}>Topics</span>
                    <button
                      type="button"
                      onClick={refreshNews}
                      disabled={newsBusy}
                      style={{ ...refreshBtn, opacity: newsBusy ? 0.5 : 1, cursor: newsBusy ? 'default' : 'pointer' }}
                    >
                      {newsBusy ? 'Refreshing…' : 'Refresh now'}
                    </button>
                  </div>
                  <div style={chipRow}>
                    {(newsConfig?.topics ?? []).map((t) => (
                      <span key={t.id} style={chip}>
                        {t.label}
                        <button
                          type="button"
                          onClick={() => removeTopic(t.id)}
                          style={chipX}
                          aria-label={`Remove ${t.label}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <input
                      value={newTopic}
                      onChange={(e) => setNewTopic(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addTopic();
                        }
                      }}
                      onBlur={addTopic}
                      placeholder="Add topic"
                      style={chipInput}
                      aria-label="Add topic"
                    />
                  </div>
                  {(newsConfig?.topics.length ?? 0) > NEWS_TOPIC_SOFT_MAX && (
                    <div style={emptyRow}>
                      {newsConfig?.topics.length} topics — consider merging, {NEWS_TOPIC_SOFT_MAX} recommended.
                    </div>
                  )}

                  {/* 当日简报：未生成为空态；降级标注 Not summarized；否则看点 + 分主题条目 */}
                  {!newsBriefing ? (
                    <div style={emptyRow}>No briefing yet — it builds once daily. Use Refresh now.</div>
                  ) : newsBriefing.items.length === 0 ? (
                    <div style={emptyRow}>No stories found for your topics today.</div>
                  ) : (
                    <>
                      {!newsBriefing.summarized && <span style={notSummBadge}>Not summarized</span>}
                      {newsBriefing.summarized && newsBriefing.overview && (
                        <div style={adviceCard}>
                          <div style={adviceTitle}>Today&apos;s highlights</div>
                          <div style={adviceReason}>{newsBriefing.overview}</div>
                        </div>
                      )}
                      {newsGroups.map(([topicLabel, items]) => (
                        <div key={topicLabel}>
                          <SectionHead label={topicLabel} count={items.length} />
                          {items.map((it) => (
                            <NewsRow key={it.id} item={it} />
                          ))}
                        </div>
                      ))}
                    </>
                  )}

                  {newsBriefing && newsBriefing.degradedTopics.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--warn)' }}>
                      No results for: {newsBriefing.degradedTopics.join(', ')}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {snapshot.degraded.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--warn)' }}>
              Some data sources unavailable: {snapshot.degraded.join('; ')}
            </div>
          )}
        </>
      )}
    </aside>
  );
}