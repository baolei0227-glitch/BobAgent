/**
 * `lib/core/push-policy.ts` —— ②「神经」事件折叠 + 出站接线的回归用例。
 *
 * 背景（2026-10-10 三件套工单 §三）：生产者此前各自 `pushToBridges`，一条事件一条外发；
 * 一旦感知源（邮件）在短时间内涌入多条，手机就会连着震。本用例锁住三条不变量：
 *   ① **折叠**：同一窗口内 10 条同类事件 → 外发只 1 条，且正文含真实计数（不是已展示条数）；
 *   ② **不越闸**：免打扰窗口内 → 手机 0 条、当日计数不增（裁决仍在 `push-out`，本层不绕开）；
 *   ③ **fail-open**：策略层（`decidePush`）抛错 → 仍投递。
 *
 * 隔离：`BOBWORK_HOME` 指向临时目录（计数状态落在其中）；投递函数用注入的 spy 替换，
 * 不触网；时间用假定时器钉死。`decidePush` 用部分 mock（默认真实实现，按用例改成抛错）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 让本文件可按用例把 decidePush 打成抛错（验证 fail-open），默认行为仍走真实实现
vi.mock('@/lib/core/quiet-hours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/quiet-hours')>();
  return { ...actual, decidePush: vi.fn(actual.decidePush) };
});

let home = '';
let mod: typeof import('./push-policy');
let quietHours: typeof import('@/lib/core/quiet-hours');

function at(hour: number, minute = 0): Date {
  return new Date(2026, 9, 6, hour, minute, 0);
}

function writePolicy(policy: Record<string, unknown>): void {
  writeFileSync(join(home, '.settings.json'), JSON.stringify({ version: 1, butlerNotify: policy }), 'utf-8');
}

/** 两个通道都成功的注入实现，返回可断言的 spy */
function okDeps() {
  const pushWechat = vi.fn<(text: string) => Promise<boolean>>(async () => true);
  const pushFeishu = vi.fn<(text: string) => Promise<boolean>>(async () => true);
  return { deps: { pushWechat, pushFeishu }, pushWechat, pushFeishu };
}

/** 造一条 report 事件；默认分组 = 邮件（② 的首个真实生产者） */
function ev(title: string, group = '📧 New mail'): import('./push-policy').ButlerEvent {
  return { kind: 'report', group, title };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-push-policy-'));
  process.env.BOBWORK_HOME = home;
  writePolicy({ enabled: true, quietStart: '22:00', quietEnd: '08:00', dailyPushLimit: 6 });
  vi.resetModules();
  mod = await import('./push-policy');
  quietHours = await import('@/lib/core/quiet-hours');
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('foldButlerEvents / composeDigestText —— 纯折叠', () => {
  it('单条 → 直接给那一行（单条写「(1)」是噪音）', () => {
    expect(mod.composeDigestText('📧 New mail', [ev('合同 review')])).toBe('合同 review');
  });

  it('🔴 10 条同组 → 一条 digest，含真实总数与折叠计数行', () => {
    const d = mod.foldButlerEvents(Array.from({ length: 10 }, (_, i) => ev(`邮件 ${i + 1}`)));
    expect(d).toHaveLength(1);
    expect(d[0].count).toBe(10);
    expect(d[0].text).toContain('10 条');
    expect(d[0].text).toContain('- 邮件 1');
    expect(d[0].text).not.toContain('邮件 6'); // 只逐条展示前 5 条
    expect(d[0].text).toContain('另有 5 条');
  });

  it('不同分组 / 不同档位互不折叠（reminder 不能被 report 的窗口吃掉）', () => {
    const d = mod.foldButlerEvents([
      ev('a', 'A'),
      ev('b', 'B'),
      { kind: 'reminder', group: 'A', title: 'c' },
    ]);
    expect(d).toHaveLength(3);
  });

  it('空标题被忽略（不产出空行）', () => {
    expect(mod.composeDigestText('X', [ev(''), ev('ok')])).toBe('ok');
    expect(mod.foldButlerEvents([ev(''), ev('')])).toHaveLength(0);
  });
});

describe('enqueueButlerEvents → flush —— 出站接线', () => {
  it('🔴 同一窗口 10 条同类事件 → 只外发 1 条，且正文含计数', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(10, 0));

    const d = okDeps();
    mod.enqueueButlerEvents(Array.from({ length: 10 }, (_, i) => ev(`邮件 ${i + 1}`)), d.deps);
    expect(mod.pendingButlerEventCount()).toBe(10);

    await mod.flushButlerEvents();

    expect(d.pushWechat).toHaveBeenCalledOnce();
    expect(d.pushFeishu).toHaveBeenCalledOnce();
    const text = d.pushWechat.mock.calls[0][0] as string;
    expect(text).toContain('10 条');
    expect(text).toContain('邮件 1');
    expect(mod.pendingButlerEventCount()).toBe(0);
  });

  it('🔴 免打扰窗口内 → 手机 0 条、当日计数不增（本层只收敛外发，内容由收件箱负责）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(23, 30));

    const d = okDeps();
    mod.enqueueButlerEvents([ev('深夜来信')], d.deps);
    const out = await mod.flushButlerEvents();

    // 关键：不是「投了没送达」，而是压根没尝试；且不吃配额
    expect(d.pushWechat).not.toHaveBeenCalled();
    expect(d.pushFeishu).not.toHaveBeenCalled();
    expect(out[0]?.blockedReason).toBe('quiet-hours');
    expect(await quietHours.readPushCount(at(23, 30))).toBe(0);
  });

  it('🔴 策略层抛错 → fail-open：仍然投递', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(23, 30)); // 即便在窗口内，策略故障也不得吞推送

    vi.mocked(quietHours.decidePush).mockRejectedValueOnce(new Error('settings boom'));

    const d = okDeps();
    mod.enqueueButlerEvents([ev('来信')], d.deps);
    await mod.flushButlerEvents();

    expect(d.pushFeishu).toHaveBeenCalledOnce();
  });

  it('窗口到点自动 flush（不依赖手动调用）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(10, 0));

    const d = okDeps();
    mod.enqueueButlerEvents([ev('来信')], d.deps);
    expect(mod.pendingButlerEventCount()).toBe(1);

    // 同步推进到窗口之后：定时器触发 flushKey（其函数体会同步取走缓冲，再异步投递）。
    // 这里只断言「缓冲已被取走」——异步投递完成依赖真实 I/O，假定时器推进不覆盖它，
    // 投递结果由上面的手动 flush 用例覆盖。
    vi.advanceTimersByTime(mod.PUSH_WINDOW_MS + 10);
    expect(mod.pendingButlerEventCount()).toBe(0);
  });
});
