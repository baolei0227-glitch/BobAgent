/**
 * `lib/core/push-out.ts` —— 外部通道统一出站口的回归用例。
 *
 * 背景（2026-10-06 Butler 主动播报工单 P0）：改造前 `event-reminder` 直接 `pushText`，
 * 绕过了 `decidePush` ⇒ 免打扰窗口与单日上限对手机端不生效。本用例锁住四条不变量：
 *   ① 窗口内 `report`（助理主动汇报）**不投递**；同刻 `reminder`（用户自订）**照投**（对照组）；
 *   ② 达单日上限后 `report` 被拦，`reminder` 照投**且不吃配额**（用计数直接对照，不是靠「是否被拦」）；
 *   ③ 放行且送达才 +1；**策略层抛错 → fail-open 仍投递**；
 *   ④ 通道返回 false（未绑定 / 无收件人）→ `pushed=false` 且**不计数**。
 *
 * 隔离：`BOBWORK_HOME` 指向临时目录（计数状态 `butler/notify-state.json` 落在其中）；
 * 投递函数用注入的 spy 替换，不触网、不 import 真实桥。时间用假定时器钉死。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 让本文件可以按用例把 decidePush 打成抛错（验证 fail-open），默认行为仍是真实实现
vi.mock('@/lib/core/quiet-hours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/quiet-hours')>();
  return { ...actual, decidePush: vi.fn(actual.decidePush) };
});

let home = '';
let pushToBridges: typeof import('./push-out').pushToBridges;
let readPushCount: typeof import('@/lib/core/quiet-hours').readPushCount;
let quietHours: typeof import('@/lib/core/quiet-hours');

/** 本地时间（假定时器下取当日分钟数用的就是这套） */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 9, 6, hour, minute, 0);
}

function writePolicy(policy: Record<string, unknown>): void {
  writeFileSync(
    join(home, '.settings.json'),
    JSON.stringify({ version: 1, butlerNotify: policy }),
    'utf-8',
  );
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-push-out-'));
  process.env.BOBWORK_HOME = home;
  writePolicy({ enabled: true, quietStart: '22:00', quietEnd: '08:00', dailyPushLimit: 6 });
  vi.resetModules();
  quietHours = await import('@/lib/core/quiet-hours');
  readPushCount = quietHours.readPushCount;
  const po = await import('./push-out');
  pushToBridges = po.pushToBridges;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** 两个通道都成功的注入实现，返回可断言的 spy */
function okDeps() {
  const pushWechat = vi.fn(async () => true);
  const pushFeishu = vi.fn(async () => true);
  return { deps: { pushWechat, pushFeishu }, pushWechat, pushFeishu };
}

describe('pushToBridges —— 外部通道出站闸门', () => {
  it('免打扰窗口内：report 不投递；同刻 reminder 照投（对照组）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(23, 30));

    const a = okDeps();
    const blocked = await pushToBridges('晚间汇报', 'report', a.deps);
    expect(blocked.pushed).toBe(false);
    expect(blocked.blockedReason).toBe('quiet-hours');
    expect(blocked.resumeAt).toBeDefined();
    // 关键：不是「投了但没送达」，而是**压根没尝试**
    expect(a.pushWechat).not.toHaveBeenCalled();
    expect(a.pushFeishu).not.toHaveBeenCalled();

    // 对照组：同一时刻，用户自订的日历提醒必须照投
    const b = okDeps();
    const cal = await pushToBridges('日历提醒', 'reminder', b.deps);
    expect(cal.pushed).toBe(true);
    expect(b.pushWechat).toHaveBeenCalledWith('日历提醒');
    expect(b.pushFeishu).toHaveBeenCalledWith('日历提醒');
  });

  it('达单日上限后 report 被拦；reminder 照投且不吃配额（看计数，不看「是否被拦」）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(10, 0));
    writePolicy({ enabled: true, quietStart: '22:00', quietEnd: '08:00', dailyPushLimit: 2 });

    // 用满 2 条配额
    await pushToBridges('r1', 'report', okDeps().deps);
    await pushToBridges('r2', 'report', okDeps().deps);
    expect(await readPushCount(at(10, 0))).toBe(2);

    const c = okDeps();
    const third = await pushToBridges('r3', 'report', c.deps);
    expect(third.pushed).toBe(false);
    expect(third.blockedReason).toBe('daily-limit');
    expect(c.pushWechat).not.toHaveBeenCalled();

    // 用户自订提醒：配额已满也照投
    const calDeps = okDeps();
    const cal = await pushToBridges('日历提醒', 'reminder', calDeps.deps);
    expect(cal.pushed).toBe(true);
    expect(calDeps.pushFeishu).toHaveBeenCalledOnce();
    // ⚠️ 非平凡判据：若 reminder 误吃配额，计数会变 3。只断言「下次仍被拦」抓不到这个 bug。
    expect(await readPushCount(at(10, 0))).toBe(2);
  });

  it('放行且送达 → 计数 +1（每条推送一次，不按通道数累加）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(10, 0));
    expect(await readPushCount(at(10, 0))).toBe(0);

    const r = await pushToBridges('早报', 'report', okDeps().deps);
    expect(r.pushed).toBe(true);
    expect(r.wechat).toBe(true);
    expect(r.feishu).toBe(true);
    expect(await readPushCount(at(10, 0))).toBe(1);
  });

  it('🔴 策略层抛错 → fail-open：仍然投递（且不计数，与 push-gate 错误分支同口径）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(23, 30)); // 即便在窗口内，策略故障也不得吞推送

    vi.mocked(quietHours.decidePush).mockRejectedValueOnce(new Error('settings boom'));

    const d = okDeps();
    const r = await pushToBridges('早报', 'report', d.deps);
    expect(r.pushed).toBe(true);
    expect(d.pushFeishu).toHaveBeenCalledOnce();
    expect(await readPushCount(at(23, 30))).toBe(0);
  });

  it('通道未就绪（pushText 返回 false）→ pushed=false，且不计数、不抛错', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(10, 0));

    const deps = { pushWechat: vi.fn(async () => false), pushFeishu: vi.fn(async () => false) };
    const r = await pushToBridges('早报', 'report', deps);
    expect(r.pushed).toBe(false);
    expect(r.blockedReason).toBeUndefined();
    expect(r.wechat).toBe(false);
    expect(r.feishu).toBe(false);
    expect(await readPushCount(at(10, 0))).toBe(0);
  });

  it('一通道失败不影响另一条（allSettled 语义）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(10, 0));

    const deps = {
      pushWechat: vi.fn(async () => { throw new Error('wechat down'); }),
      pushFeishu: vi.fn(async () => true),
    };
    const r = await pushToBridges('早报', 'report', deps);
    expect(r.pushed).toBe(true);
    expect(r.feishu).toBe(true);
    expect(r.wechat).toBe(false);
    expect(await readPushCount(at(10, 0))).toBe(1);
  });

  it('空文本 → 直接返回，不裁决也不投递', async () => {
    const d = okDeps();
    const r = await pushToBridges('', 'report', d.deps);
    expect(r.pushed).toBe(false);
    expect(d.pushWechat).not.toHaveBeenCalled();
    expect(d.pushFeishu).not.toHaveBeenCalled();
  });
});
