/**
 * 路由级回归：`POST /api/butler/push-gate`（B5 打扰闸的唯一生产出口）。
 *
 * 背景（2026-10-02 架构评审 §2.2-8）：quiet-hours 的策略函数此前**零生产调用方**——
 * 免打扰窗口与单日上限从未生效。本用例锁住接线后的三条不变量：
 *   ① 免打扰窗口内，主动推送类别（report / meeting / other）**被拦**；
 *   ② 「用户自订日历提醒永不被静默」——`calendar` 在窗口内**照样放行**（映射错会吞掉夜间闹钟）；
 *   ③ 放行时**就地计数**，单日上限成为真上限（第 N+1 次被 `daily-limit` 拦），
 *      但 `calendar` **不吃配额也不受上限**（2026-10-06 起，见 countsTowardDailyLimit）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录 + 写入 `.settings.json`；`readSettingsFromFile()` 每次读盘，
 * 故同进程内改设置即刻生效。时间用假定时器钉死，避免依赖测试运行时刻。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

let home = '';
let route: typeof import('./route');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-push-gate-'));
  process.env.BOBWORK_HOME = home;
  writeFileSync(
    join(home, '.settings.json'),
    JSON.stringify({
      version: 1,
      butlerNotify: { enabled: true, quietStart: '22:00', quietEnd: '08:00', dailyPushLimit: 6 },
    }),
    'utf-8',
  );
  route = await import('./route');
});

afterAll(() => {
  vi.useRealTimers();
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

function gateReq(kind?: string): NextRequest {
  return new NextRequest('http://localhost/api/butler/push-gate', {
    method: 'POST',
    body: JSON.stringify(kind === undefined ? {} : { kind }),
    headers: { 'content-type': 'application/json' },
  });
}

async function gate(kind?: string): Promise<{ allow?: boolean; reason?: string; used?: number }> {
  const res: NextResponse = await route.POST(gateReq(kind));
  return (await res.json()) as { allow?: boolean; reason?: string; used?: number };
}

describe('B5 打扰闸', () => {
  it('免打扰窗口内（23:00）：主动推送被拦，但用户自订日历提醒照常放行', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 2, 23, 0, 0)); // 本地时间 23:00

    expect((await gate('notes-maintenance')).allow).toBe(false);
    expect((await gate('notes-maintenance')).reason).toBe('quiet-hours');
    expect((await gate('meeting')).allow).toBe(false);
    // 未知名 / 空体 → 'other'，可静默类别
    expect((await gate()).allow).toBe(false);
    // 日历提醒：窗口内不静默（窗口 + 上限双豁免）
    const cal = await gate('calendar');
    expect(cal.allow).toBe(true);
    expect(cal.reason).toBe('ok');

    vi.useRealTimers();
  });

  it('白天放行，且单日上限是真上限（第 N+1 次被拦）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0)); // 次日 12:00，计数已跨日归零
    writeFileSync(
      join(home, '.settings.json'),
      JSON.stringify({
        version: 1,
        butlerNotify: { enabled: true, quietStart: '22:00', quietEnd: '08:00', dailyPushLimit: 2 },
      }),
      'utf-8',
    );

    expect((await gate('notes-maintenance')).allow).toBe(true);
    expect((await gate('notes-maintenance')).allow).toBe(true);
    const third = await gate('notes-maintenance');
    expect(third.allow).toBe(false);
    expect(third.reason).toBe('daily-limit');

    // 对照组：配额已满，用户自订的日历提醒仍必须放行，且**不吃配额**
    const cal = await gate('calendar');
    expect(cal.allow).toBe(true);
    expect(cal.reason).toBe('ok');
    // 连推 3 条日历提醒后，主动汇报读到的 used 必须仍是 2 —— 若 calendar 误吃配额，这里会读到 5。
    // ⚠️ 不能只断言「仍被拦」：配额被吃空时也照样被拦，那是平凡为真的判据，抓不到本 bug。
    await gate('calendar');
    await gate('calendar');
    const after = await gate('notes-maintenance');
    expect(after.reason).toBe('daily-limit');
    expect(after.used).toBe(2);

    vi.useRealTimers();
  });

  it('总开关关闭（enabled:false）→ 一律放行，行为回到克制策略之前', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 4, 23, 30, 0)); // 深夜，但策略未开启
    writeFileSync(
      join(home, '.settings.json'),
      JSON.stringify({ version: 1, butlerNotify: { enabled: false } }),
      'utf-8',
    );
    const d = await gate('notes-maintenance');
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('disabled');
    vi.useRealTimers();
  });
});
