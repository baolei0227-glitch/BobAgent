/**
 * `lib/butler/evening-report.ts` 用例。
 *
 * 两段各自锁住一类判据：
 *   A. `composeEveningText`（纯函数）—— **空快照必须返回 null**（闭嘴判据）、逾期/今日分段与折叠、
 *      建议卡渲染、降级明示。这些若只靠端上目视，最容易退化成「每条都推送」。
 *   B. `runEveningReport` —— 每日幂等（第二次 already-run）、档位必须是 `report`（否则不受窗口约束）、
 *      外部通道被拦时收件箱仍要有（**被静默 ≠ 丢内容**）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ButlerNoticeItem } from '@/lib/bus';

vi.mock('./today-advice', () => ({ loadTodayBundle: vi.fn() }));
vi.mock('@/lib/core/inbox', () => ({ insertInbox: vi.fn(async () => ({ id: 'in-test-1' })) }));
vi.mock('@/lib/butler/report-doc', () => ({ writeReportDoc: vi.fn(async () => '/tmp/x.md') }));
vi.mock('@/lib/core/push-out', () => ({ pushToBridges: vi.fn() }));

let home = '';
let mod: typeof import('./evening-report');
let loadTodayBundle: ReturnType<typeof vi.fn>;
let insertInbox: ReturnType<typeof vi.fn>;
let pushToBridges: ReturnType<typeof vi.fn>;

function item(title: string, time = '10/06 09:00'): ButlerNoticeItem {
  return { key: title, title, time, startMs: 0 } as ButlerNoticeItem;
}

/** 收窄输入的最小工厂：只覆盖 composeEveningText 会用到的字段 */
function input(over: Partial<import('./evening-report').EveningInput> = {}) {
  return {
    todayCount: 0,
    overdueCount: 0,
    todayItems: [],
    overdueItems: [],
    cards: [],
    degraded: [],
    ...over,
  };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-evening-'));
  process.env.BOBWORK_HOME = home;
  vi.resetModules();
  mod = await import('./evening-report');
  const ta = (await import('./today-advice')) as unknown as { loadTodayBundle: ReturnType<typeof vi.fn> };
  const ib = (await import('@/lib/core/inbox')) as unknown as { insertInbox: ReturnType<typeof vi.fn> };
  const po = (await import('@/lib/core/push-out')) as unknown as { pushToBridges: ReturnType<typeof vi.fn> };
  loadTodayBundle = ta.loadTodayBundle;
  insertInbox = ib.insertInbox;
  pushToBridges = po.pushToBridges;
  loadTodayBundle.mockReset();
  insertInbox.mockClear();
  pushToBridges.mockReset();
});

afterEach(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('composeEveningText —— 正文组装（纯函数）', () => {
  it('🔴 今天与逾期都为空 → null（宁可闭嘴，也不推一条「你今天很空」）', () => {
    expect(mod.composeEveningText(input())).toBeNull();
    // 即便规则引擎给了一张 clear 卡，也不该改变这个判据
    expect(mod.composeEveningText(input({ cards: [{ title: '今天很空', reason: '没有待办' }] }))).toBeNull();
  });

  it('逾期与今日分段渲染；今日为空时显式写 none（不留空白让人误以为漏算）', () => {
    const text = mod.composeEveningText(input({
      todayCount: 0,
      overdueCount: 2,
      overdueItems: [item('写周报'), item('交房租')],
    }))!;
    expect(text).toContain('⏰ Overdue (2):');
    expect(text).toContain('- 10/06 09:00 · 写周报');
    expect(text).toContain('📋 Today (0):');
    expect(text).toContain('- none');
  });

  it('超出预览条数时补折叠计数行（计数用真实总数，不是已展示条数）', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`事件${i + 1}`));
    const text = mod.composeEveningText(input({
      todayCount: 12,
      todayItems: items,
    }))!;
    // 断言必须打在有区分度的子串上：整行是 `- 10/06 09:00 · 事件N`，
    // 写 `- 事件N` 会永远为假（且反向断言 `not.toContain` 会平凡为真，抓不到任何东西）
    expect(text).toContain('· 事件10');
    expect(text).not.toContain('· 事件11');
    expect(text).not.toContain('· 事件12');
    expect(text).toContain('- … (+2 more)');
  });

  it('建议卡按「标题 — 依据」渲染（依据来自规则引擎，不调模型）', () => {
    const text = mod.composeEveningText(input({
      todayCount: 1,
      todayItems: [item('评审')],
      cards: [{ title: '有 2 项逾期', reason: '逾期项建议优先处理' }],
    }))!;
    expect(text).toContain('💡 Suggestions:');
    expect(text).toContain('- 有 2 项逾期 — 逾期项建议优先处理');
  });

  it('降级时明示，避免「查询失败 = 今天很空」被误读', () => {
    const text = mod.composeEveningText(input({
      todayCount: 1,
      todayItems: [item('评审')],
      degraded: ['overdue: 日历库读取失败'],
    }))!;
    expect(text).toContain('⚠ Partial data unavailable: overdue: 日历库读取失败');
  });
});

describe('runEveningReport —— 每日一次 + 投递接线', () => {
  const now = new Date(2026, 9, 6, 20, 0, 0);

  function stubBundle() {
    return {
      snapshot: { today: { count: 1, events: [] }, overdue: { count: 1, events: [] }, degraded: [] },
      schedule: {
        text: 'ignored',
        items: [
          { ...item('评审'), section: 'today' },
          { ...item('写周报'), section: 'overdue' },
        ],
      },
      cards: [],
      sticky: null,
      progress: null,
    };
  }

  it('首跑：落收件箱 + 走外部通道，且档位必须是 report（否则不受窗口约束）', async () => {
    loadTodayBundle.mockResolvedValue(stubBundle());
    pushToBridges.mockResolvedValue({ pushed: true, wechat: true, feishu: true });

    const r = await mod.runEveningReport(now);
    expect(r.ran).toBe(true);
    expect(r.inboxId).toBe('in-test-1');
    expect(insertInbox).toHaveBeenCalledOnce();
    // 收件箱落库先于外部推送（互不阻塞）
    expect(insertInbox.mock.calls[0][0]).toMatchObject({ kind: 'report', dedupeKey: 'evening:2026-10-06' });
    expect(pushToBridges).toHaveBeenCalledOnce();
    expect(pushToBridges.mock.calls[0][1]).toBe('report');
  });

  it('同日再跑 → already-run，且不再落库、不再推送（幂等）', async () => {
    loadTodayBundle.mockResolvedValue(stubBundle());
    pushToBridges.mockResolvedValue({ pushed: true, wechat: true, feishu: true });

    await mod.runEveningReport(now);
    const second = await mod.runEveningReport(now);
    expect(second).toMatchObject({ ran: false, skipped: 'already-run' });
    expect(insertInbox).toHaveBeenCalledOnce(); // 仍然只有第一次那一次
    expect(pushToBridges).toHaveBeenCalledOnce();
  });

  it('无可播报内容 → nothing-to-report，且不落库、不推送', async () => {
    loadTodayBundle.mockResolvedValue({
      snapshot: { today: { count: 0, events: [] }, overdue: { count: 0, events: [] }, degraded: [] },
      schedule: { text: '', items: [] },
      cards: [],
      sticky: null,
      progress: null,
    });

    const r = await mod.runEveningReport(now);
    expect(r).toMatchObject({ ran: true, skipped: 'nothing-to-report' });
    expect(insertInbox).not.toHaveBeenCalled();
    expect(pushToBridges).not.toHaveBeenCalled();
  });

  it('🔴 外部通道被静默（quiet-hours）→ 收件箱仍要落库（被静默 ≠ 丢内容）', async () => {
    loadTodayBundle.mockResolvedValue(stubBundle());
    pushToBridges.mockResolvedValue({
      pushed: false,
      wechat: false,
      feishu: false,
      blockedReason: 'quiet-hours',
      resumeAt: Date.now(),
    });

    const r = await mod.runEveningReport(now);
    expect(r.inboxId).toBe('in-test-1');
    expect(r.blockedReason).toBe('quiet-hours');
    expect(insertInbox).toHaveBeenCalledOnce();
  });
});
