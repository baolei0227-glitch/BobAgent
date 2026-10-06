/**
 * 每日报告（Progress / Morning / Sticky）同日归组契约
 *
 * **现状（2026-09-27）**：日报三页签已整体移交 Today 面板（lib/butler/today.ts + ButlerTodayPanel），
 * 通知助理 Bobby 不再推送日报，历史日报回执也在启动时被 `purgeInboxDailyReports()` 清掉。
 * 于是本模块的归组/计数职责退居**兜底与兼容**：
 *   - 判定口径被 `purgeInboxDailyReports()` 复用（识别哪些存量行属于日报、该删）；
 *   - 抽屉侧的中栏并卡 / 右栏页签在无日报行时自然不再触发，代码保留但不产生新的展示。
 *   - 未读计数（countUnreadWithDailyReports / isGroupRead）已于 2026-09-28 删除：
 *     通知 = 普通消息，「已读」概念整体移除，不再有任何未读统计（见 butlerNotices / today.ts）。
 *
 * 识别口径（两处同源）：
 *   1. dedupeKey：`progress:YYYY-MM-DD` / `morning:YYYY-MM-DD` / `sticky:YYYY-MM-DD`（**历史行**写入）
 *   2. 标题兜底：`Report|Schedule|Sticky Report — YYYY-MM-DD`（存量行 / 刚落内存的实时态；
 *      改名前的 `Progress Report` / `Morning Report` 一并识别，历史收件箱行仍能归组）
 * `Notes Maintenance — …` **不并入**：它仍走通知中心，不属于日报三页签。
 *
 * 日期一律用**发出当天**，页签顺序 Report → Schedule → Sticky。
 *
 * 本模块必须保持纯净（不 import node/服务端依赖），否则前端组件无法引用。
 */

/** 组内的页签（报告类型） */
export type DailyReportSection = 'progress' | 'morning' | 'sticky';

const DEDUPE_RE = /^(progress|morning|sticky):(\d{4}-\d{2}-\d{2})$/;
/** 标题前缀同时收新旧两套写法（长串在前，避免 `Report` 抢走 `Progress Report`） */
const TITLE_RE = /^(Progress Report|Morning Report|Sticky Report|Report|Schedule)\s*—\s*(\d{4}-\d{2}-\d{2})$/;
/** 标题前缀 → 页签：同一页签的新名与旧名都映射过来，改名不割裂历史行 */
const TITLE_SECTION: Record<string, DailyReportSection> = {
  report: 'progress',
  'progress report': 'progress',
  schedule: 'morning',
  'morning report': 'morning',
  'sticky report': 'sticky',
};

/** 归组只需要这两个字段，故不绑定 ButlerNotice 类型，服务端行记录同样适用 */
export interface ReportGroupInput {
  title: string;
  dedupeKey?: string | null;
}

/** 页签顺序（Report 在前）与显示名 —— 卡片与右栏共用，避免两处顺序不一致。
 *  显示名即生产侧标题前缀（见 lib/core/daily-tasks.ts）：`Report — …` / `Schedule — …` / `Sticky Report — …`。 */
export const REPORT_SECTION_ORDER: readonly DailyReportSection[] = ['progress', 'morning', 'sticky'];
export const REPORT_SECTION_LABEL: Record<DailyReportSection, string> = {
  progress: 'Report',
  morning: 'Schedule',
  sticky: 'Sticky',
};

/** 解析一条回执属于哪个组的哪个页签；非每日报告返回 null */
export function dailyReportSection(
  n: ReportGroupInput,
): { section: DailyReportSection; date: string; key: string } | null {
  const raw = typeof n.dedupeKey === 'string' ? n.dedupeKey.trim() : '';
  const byKey = raw ? DEDUPE_RE.exec(raw) : null;
  if (byKey) {
    const section = byKey[1] as DailyReportSection;
    return { section, date: byKey[2], key: `daily:${byKey[2]}` };
  }
  const byTitle = TITLE_RE.exec((n.title ?? '').trim());
  if (byTitle) {
    const section = TITLE_SECTION[byTitle[1].toLowerCase()];
    if (section) return { section, date: byTitle[2], key: `daily:${byTitle[2]}` };
  }
  return null;
}

/** 组键（同日的 Morning + Sticky 同键）；非每日报告返回 null */
export function reportGroupKey(n: ReportGroupInput): string | null {
  return dailyReportSection(n)?.key ?? null;
}

/** 卡片标题：`Daily Report — 2026-09-27`（日期取自组键，与生产侧标题里的日期同源） */
export function reportGroupTitle(date: string): string {
  return `Daily Report — ${date}`;
}

/** 组内排序：先按页签顺序（Report → Schedule → Sticky），同页签再按时间 —— 卡片 / 右栏页签共用 */
export function sortReportMembers<T extends ReportGroupInput & { time?: number }>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    const sa = dailyReportSection(a);
    const sb = dailyReportSection(b);
    const ia = sa ? REPORT_SECTION_ORDER.indexOf(sa.section) : REPORT_SECTION_ORDER.length;
    const ib = sb ? REPORT_SECTION_ORDER.indexOf(sb.section) : REPORT_SECTION_ORDER.length;
    if (ia !== ib) return ia - ib;
    return (a.time ?? 0) - (b.time ?? 0);
  });
}
