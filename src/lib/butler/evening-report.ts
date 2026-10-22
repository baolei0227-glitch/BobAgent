/**
 * 晚间回顾（Butler 主动播报 P1，2026-10-06）
 *
 * 定位：Butler 目前**唯一会推外部通道**（微信 / 飞书）的「助理主动汇报」。
 * 9:00 那条 `generateProgressDigest` 只落 Today 面板缓存与文档、不推手机
 * （见 `lib/core/daily-tasks.ts` 的调度注释），所以「主动播报」这件事此前没有任何载体。
 *
 * 三条设计取舍（对齐 Today AI 的克制原则与仓库既有范式）：
 *   1. **内容复用 Today 的同一份事实**（`loadTodayBundle`）—— 面板与推送不许各算一遍口径，
 *      与 `today-advice.ts` 存在的理由同源；
 *   2. **不调模型**：推送要的是「点到位」，建议文案用规则引擎的 `title` / `reason` 原文。
 *      理由的 AI 润色（`advice-ai`）留给用户主动打开面板时按需生成；
 *   3. **知道什么时候该闭嘴**：今天与逾期都为空 → 直接返回 `nothing-to-report`，不发任何推送。
 *
 * 投递：桌面收件箱（`insertInbox`，不弹 toast）+ 外部通道（`pushToBridges(text, 'report')`）。
 * 两条链路互不阻塞：外部通道被免打扰窗口拦下时，收件箱里仍然有（**被静默 ≠ 丢内容**）。
 * 档位用 `report`（助理主动汇报）—— 所以它才会真正受免打扰窗口与单日上限约束。
 *
 * 幂等：`butler/.state/evening-report/<YYYY-MM-DD>.done` 原子抢占（`wx` 独占创建），
 * 与 `daily-tasks` 的 `tryAcquireSendMarker` 同手法（标记先占，防同日重复推送）。
 *
 * 调度：**本模块自带调度器**（`startEveningReportScheduler`，由 instrumentation 启动），
 * 不挂进 `daily-tasks`。原因是模块方向 —— `daily-tasks` 被 `today-advice` 静态依赖，
 * 而本模块要用 `today-advice`；若由 `daily-tasks` 反向引用本模块即形成 core ↔ butler 的
 * import 环（`eslint import/no-cycle` 连动态 `import()` 也算）。形态与 `event-reminder` 一致。
 */
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { STATE_DIR, NOTIFY_THREAD_ID } from './storage';
import { loadTodayBundle } from './today-advice';
import { insertInbox } from '@/lib/core/inbox';
import type { ButlerNoticeItem } from '@/lib/bus';

const EVENING_DIR = join(STATE_DIR, 'evening-report');
/** 正文里每个分区最多列几条（与 daily-tasks 的 TEXT_PREVIEW 同口径：这是摘要，不是清单） */
const PREVIEW = 10;

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 服务端自调用绝对 base（Node fetch 不支持相对路径）—— 与 daily-tasks / ledger-compile 同一约定 */
function selfBaseUrl(): string {
  return `http://localhost:${process.env.PORT || '5000'}`;
}

/** `composeEveningText` 的输入：从 TodayBundle 收窄出来的**纯数据**，便于直接单测 */
export interface EveningInput {
  todayCount: number;
  overdueCount: number;
  todayItems: ButlerNoticeItem[];
  overdueItems: ButlerNoticeItem[];
  /** 规则建议卡（只用标题与依据，不调模型） */
  cards: { title: string; reason: string }[];
  /** 数据源降级说明（非空时必须明示，避免「查询失败 = 今天很空」被误读） */
  degraded: string[];
  /**
   * 当日收件箱增量（② 神经：感知源今天替用户留意到的事，如新邮件）。可选 —— 缺省视为没有，
   * 保持「今日与逾期皆空且无增量 → 闭嘴」的既有判据不变。
   */
  inboxHighlights?: { title: string; detail?: string }[];
}

/**
 * 组装正文。**返回 null = 今天没有值得播报的东西**（调用方据此彻底静默）。
 *
 * 判据看「今天 / 逾期 / 当日收件箱增量」三项计数：三者皆 0 时即便还有建议卡（`clear` 卡），
 * 也不值得在晚上推一条去说「你今天很空」。
 */
export function composeEveningText(input: EveningInput): string | null {
  const { todayCount, overdueCount, todayItems, overdueItems } = input;
  const highlights = input.inboxHighlights ?? [];
  if (todayCount === 0 && overdueCount === 0 && highlights.length === 0) return null;

  const lines: string[] = [];
  if (overdueCount > 0) {
    lines.push(`⏰ Overdue (${overdueCount}):`);
    lines.push(...overdueItems.slice(0, PREVIEW).map((i) => `- ${i.time} · ${i.title}`));
    if (overdueCount > PREVIEW) lines.push(`- … (+${overdueCount - PREVIEW} more)`);
    lines.push('');
  }
  lines.push(`📋 Today (${todayCount}):`);
  if (todayCount === 0) {
    lines.push('- none');
  } else {
    lines.push(...todayItems.slice(0, PREVIEW).map((i) => `- ${i.time} · ${i.title}`));
    if (todayCount > PREVIEW) lines.push(`- … (+${todayCount - PREVIEW} more)`);
  }
  if (highlights.length > 0) {
    lines.push('');
    lines.push(`📧 Noticed today (${highlights.length}):`);
    lines.push(...highlights.slice(0, PREVIEW).map((h) => `- ${h.title}`));
    if (highlights.length > PREVIEW) lines.push(`- … (+${highlights.length - PREVIEW} more)`);
  }
  if (input.cards.length > 0) {
    lines.push('');
    lines.push('💡 Suggestions:');
    for (const c of input.cards) lines.push(`- ${c.title} — ${c.reason}`);
  }
  if (input.degraded.length > 0) {
    lines.push('');
    lines.push(`⚠ Partial data unavailable: ${input.degraded.join('; ')}`);
  }
  return lines.join('\n');
}

export interface EveningReportResult {
  /** 本次是否真的执行了（false = 当天已跑过） */
  ran: boolean;
  /** 跳过原因：当天已跑 / 无可播报内容 */
  skipped?: 'already-run' | 'nothing-to-report';
  /** 投递失败的人话说明（如事实装载异常） */
  error?: string;
  /** 桌面收件箱落库 id */
  inboxId?: string;
  pushed?: boolean;
  wechat?: boolean;
  feishu?: boolean;
  /** 外部通道被静默时的原因（quiet-hours / daily-limit） */
  blockedReason?: string;
}

/** 原子抢占当日标记：`wx` 独占创建（EEXIST = 别人已占） */
async function acquireToday(now: Date): Promise<boolean> {
  await mkdir(EVENING_DIR, { recursive: true });
  try {
    await writeFile(join(EVENING_DIR, `${dateStr(now)}.done`), now.toISOString(), {
      encoding: 'utf-8',
      flag: 'wx',
    });
    return true;
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e.code === 'EEXIST' || e.code === 'EACCES')) {
      return false;
    }
    throw e;
  }
}

/**
 * 执行一次晚间回顾（幂等：每日一次，由本模块自带调度器的 `startEveningReportScheduler` 触发）。
 * 失败不抛错 —— 调度器是 fire-and-forget，抛错只会变成未捕获拒绝。
 */
export async function runEveningReport(now: Date = new Date()): Promise<EveningReportResult> {
  if (!(await acquireToday(now))) return { ran: false, skipped: 'already-run' };

  let bundle: Awaited<ReturnType<typeof loadTodayBundle>>;
  try {
    bundle = await loadTodayBundle(selfBaseUrl());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[evening-report] 事实装载失败:', msg);
    return { ran: true, error: msg };
  }

  const body = composeEveningText({
    todayCount: bundle.snapshot.today.count,
    overdueCount: bundle.snapshot.overdue.count,
    todayItems: bundle.schedule.items.filter((i) => i.section === 'today'),
    overdueItems: bundle.schedule.items.filter((i) => i.section === 'overdue'),
    cards: bundle.cards.map((c) => ({ title: c.title, reason: c.reason })),
    degraded: bundle.snapshot.degraded,
    // 当日收件箱增量（② 神经）：感知源今天替用户留意到的事，一并进晚间汇总
    inboxHighlights: (bundle.inboxHighlights ?? []).map((h) => ({ title: h.title, detail: h.detail })),
  });
  if (!body) return { ran: true, skipped: 'nothing-to-report' };

  const title = `Evening Review — ${dateStr(now)}`;

  // ① 桌面收件箱：直接落库（**不弹 toast** —— 晚间回顾是「回来再看」，不是打断）。
  //    失败不阻断外部推送：两条链路互为独立见证。
  let inboxId: string | undefined;
  try {
    const rec = await insertInbox({
      kind: 'report',
      title,
      body,
      source: 'scheduled',
      threadId: NOTIFY_THREAD_ID,
      dedupeKey: `evening:${dateStr(now)}`,
    });
    inboxId = rec.id;
  } catch (e) {
    console.error('[evening-report] 落收件箱失败:', e);
  }

  // ② 归档成文档（内容可沉淀、可翻历史）；失败不阻断推送
  try {
    const { writeReportDoc } = await import('@/lib/butler/report-doc');
    await writeReportDoc('evening', title, body);
  } catch (e) {
    console.warn('[evening-report] 报告文档落盘失败:', e);
  }

  // ③ 外部通道：走统一出站口，档位 report ⇒ 受免打扰窗口与单日上限约束
  let out: Awaited<ReturnType<typeof import('@/lib/core/push-out').pushToBridges>>;
  try {
    const { pushToBridges } = await import('@/lib/core/push-out');
    out = await pushToBridges(`${title}\n\n${body}`, 'report');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[evening-report] 外部通道投递失败:', msg);
    return { ran: true, inboxId, error: msg };
  }

  console.log(
    `[evening-report] 已生成: ${title}（${bundle.snapshot.today.count} today / ${bundle.snapshot.overdue.count} overdue）` +
      ` · 外部通道 pushed=${out.pushed}${out.blockedReason ? ` blocked=${out.blockedReason}` : ''}`,
  );
  return {
    ran: true,
    inboxId,
    pushed: out.pushed,
    wechat: out.wechat,
    feishu: out.feishu,
    ...(out.blockedReason ? { blockedReason: out.blockedReason } : {}),
  };
}

/* ==================== 调度 ==================== */

/**
 * 晚间回顾时间点（本地小时）。
 * 与 9:00 那批的分工：9:00 产出「事实缓存」（Today 的 Report 页签 + 文档）并**不推手机**；
 * 20:00 这条是 Butler 目前**唯一会推外部通道**的助理主动汇报。
 * 20:00 落在默认免打扰窗口（22:00–08:00）之外，正常会送达；若用户把窗口调宽盖住 20:00，
 * 则出站口会静默外部通道、内容仍进收件箱。
 */
export const EVENING_HOUR = 20;
/** 检查周期（与 daily-tasks / event-reminder 同口径：睡眠唤醒或错过整点后 ≤5 分钟内补做） */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SCHEDULER_KEY = '__eveningReportSchedulerStarted__';

/**
 * 启动晚间回顾调度（instrumentation 调用，幂等）：
 *   - 立即检查一次：当天首次打开且已过 20:00 → 立即补做
 *   - 之后每 5 分钟检查续期；当日是否已发由 `runEveningReport` 内部的原子标记决定
 */
export function startEveningReportScheduler(): void {
  const g = globalThis as unknown as { [SCHEDULER_KEY]?: boolean };
  if (g[SCHEDULER_KEY]) return;
  g[SCHEDULER_KEY] = true;

  const maybeRunDue = () => {
    if (new Date().getHours() < EVENING_HOUR) return;
    void runEveningReport().catch((e) => {
      console.error('[evening-report] 周期执行失败:', e);
    });
  };

  maybeRunDue();
  const timer = setInterval(maybeRunDue, CHECK_INTERVAL_MS);
  timer.unref?.(); // 不阻止进程退出

  console.log(
    `[evening-report] 晚间回顾调度已启动（每天 ${String(EVENING_HOUR).padStart(2, '0')}:00 起，每 ${CHECK_INTERVAL_MS / 60000} 分钟检查一次）`,
  );
}
