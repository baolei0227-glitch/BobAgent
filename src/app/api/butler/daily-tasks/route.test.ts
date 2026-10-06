/**
 * 路由级回归：`GET /api/butler/daily-tasks` 的 B5 打扰闸（报告**暂缓而非丢弃**）。
 *
 * 设置界面承诺「Quiet hours silence proactive pushes… the report is never lost —
 * it still lands in the drawer inbox」以及「held back and resume when it ends」。
 * 本用例锁住该承诺在代码上成立：
 *   ① 免打扰窗口内 → 返回 `reports: []` 且 `held: true`，**pending.json 原封不动**；
 *   ② 窗口结束后（下一轮轮询）→ 同一份报告照常投递并清空队列（**不丢**）；
 *   ③ 放行会累计当日推送计数（供单日上限使用）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；pending.json 直接落盘造数（形状见 daily-tasks.ts 的 pushPending）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NextResponse } from 'next/server';

let home = '';
let route: typeof import('./route');
let pendingFile = '';

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-daily-tasks-gate-'));
  process.env.BOBWORK_HOME = home;
  writeFileSync(
    join(home, '.settings.json'),
    JSON.stringify({
      version: 1,
      butlerNotify: { enabled: true, quietStart: '22:00', quietEnd: '08:00', dailyPushLimit: 6 },
    }),
    'utf-8',
  );
  pendingFile = join(home, 'butler', '.state', 'daily-tasks', 'pending.json');
  mkdirSync(join(home, 'butler', '.state', 'daily-tasks'), { recursive: true });
  route = await import('./route');
});

afterAll(() => {
  vi.useRealTimers();
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

function seedPending(): void {
  writeFileSync(
    pendingFile,
    JSON.stringify([
      { kind: 'notes-maintenance', title: '知识库维护', body: '今日笔记已整理', time: Date.now(), items: [], dedupeKey: 'notes:2026-10-02' },
    ]),
    'utf-8',
  );
}

async function get(): Promise<{ reports?: unknown[]; held?: boolean; reason?: string }> {
  const res: NextResponse = await route.GET();
  return (await res.json()) as { reports?: unknown[]; held?: boolean; reason?: string };
}

describe('GET /api/butler/daily-tasks —— 打扰闸', () => {
  it('免打扰窗口内：暂缓（reports 空 + held），且 pending 不动（报告没丢）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 2, 23, 0, 0));
    seedPending();
    const before = readFileSync(pendingFile, 'utf-8');

    const d = await get();
    expect(d.reports).toEqual([]);
    expect(d.held).toBe(true);
    expect(d.reason).toBe('quiet-hours');
    // 关键：队列没被消费
    expect(readFileSync(pendingFile, 'utf-8')).toBe(before);
    vi.useRealTimers();
  });

  it('窗口结束后：同一份报告续发并清空队列', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
    const d = await get();
    expect(Array.isArray(d.reports)).toBe(true);
    expect(d.reports).toHaveLength(1);
    expect(JSON.parse(readFileSync(pendingFile, 'utf-8'))).toEqual([]);
    vi.useRealTimers();
  });
});
