/**
 * rule-nearmiss 回归：弱触发对象类型映射 / 重复行为计数达 N 才提议 / 限流「问过计数」封顶 /
 * 两类负样本互不误伤（各写各的、各读各的）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的模块级常量在 import 时由环境变量确定，
 * 故先设 env 再动态 import（对齐 rule-logs.test.ts）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let nearmiss: typeof import('./rule-nearmiss');
let signals: typeof import('./rule-signals');
let shared: typeof import('./rules-shared');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-rule-nearmiss-'));
  process.env.BOBWORK_HOME = home;
  nearmiss = await import('./rule-nearmiss');
  signals = await import('./rule-signals');
  shared = await import('./rules-shared');
});

beforeEach(() => {
  // 清空 butler 根（计数 + 日志），每个用例从零开始
  rmSync(join(home, 'butler'), { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('weakSignalObjectTypes', () => {
  it('把同域动词映射到对象类型', () => {
    expect(nearmiss.weakSignalObjectTypes('记一下明天的事')).toContain('note');
    expect(nearmiss.weakSignalObjectTypes('开个会吧')).toContain('meeting');
    expect(nearmiss.weakSignalObjectTypes('提醒我买牛奶')).toContain('todo');
  });

  it('一句话可命中多个对象类型，去重', () => {
    const got = nearmiss.weakSignalObjectTypes('把这句话记一下，顺便安排个会议');
    expect(got).toContain('note');
    expect(got).toContain('schedule');
    expect(got).toContain('meeting');
    expect(new Set(got).size).toBe(got.length);
  });

  it('无弱触发词 → 空数组', () => {
    expect(nearmiss.weakSignalObjectTypes('今天天气不错')).toEqual([]);
  });
});

describe('noteBehavior', () => {
  it('累计达 N(=3) 才 exceeded', async () => {
    expect((await nearmiss.noteBehavior('todo')).exceeded).toBe(false);
    expect((await nearmiss.noteBehavior('todo')).exceeded).toBe(false);
    const third = await nearmiss.noteBehavior('todo');
    expect(third.count).toBe(shared.NEAR_MISS_BEHAVIOR_N);
    expect(third.exceeded).toBe(true);
  });
});

describe('consumeAsk（限流：问过即计数，封顶 NEAR_MISS_ASK_LIMIT=2）', () => {
  it('前两次放行，第三次拒绝', async () => {
    expect(await nearmiss.consumeAsk('todo')).toBe(true);
    expect(await nearmiss.consumeAsk('todo')).toBe(true);
    expect(await nearmiss.consumeAsk('todo')).toBe(false);
  });
});

describe('两类负样本互不误伤', () => {
  it('signal_mismatch 拉黑不压制 not_a_habit，反之亦然', async () => {
    await signals.recordNegativeSample('note', 'note', 'blocked', 'signal_mismatch');
    expect(await nearmiss.isBlocked('note', 'signal_mismatch')).toBe(true);
    expect(await nearmiss.isBlocked('note', 'not_a_habit')).toBe(false);

    await signals.recordNegativeSample('note', 'note', 'blocked', 'not_a_habit');
    expect(await nearmiss.isBlocked('note', 'signal_mismatch')).toBe(true);
    expect(await nearmiss.isBlocked('note', 'not_a_habit')).toBe(true);
  });

  it('解封某一类（追加 unblocked）不影响另一类', async () => {
    await signals.recordNegativeSample('todo', 'todo', 'blocked', 'signal_mismatch');
    await signals.recordNegativeSample('todo', 'todo', 'blocked', 'not_a_habit');
    await signals.recordNegativeSample('todo', 'todo', 'unblocked', 'signal_mismatch');
    expect(await nearmiss.isBlocked('todo', 'signal_mismatch')).toBe(false);
    expect(await nearmiss.isBlocked('todo', 'not_a_habit')).toBe(true);
  });
});

describe('proposeForText（达 N 次才提议；两类负样本各自压制）', () => {
  it('行为未达 N 次不提议，达 N 次后提议', async () => {
    expect(await nearmiss.proposeForText('记一下 A')).toBeNull();
    expect(await nearmiss.proposeForText('记一下 B')).toBeNull();
    const p = await nearmiss.proposeForText('记一下 C');
    expect(p?.objectType).toBe('note');
    expect(p?.count).toBe(shared.NEAR_MISS_BEHAVIOR_N);
  });

  it('not_a_habit 被拉黑 → 不再提议固化', async () => {
    await signals.recordNegativeSample('note', 'note', 'blocked', 'not_a_habit');
    for (let i = 0; i < 4; i += 1) {
      expect(await nearmiss.proposeForText('记一下 X')).toBeNull();
    }
  });

  it('signal_mismatch 被拉黑 → 固化提议仍能触发（互不误伤）', async () => {
    await signals.recordNegativeSample('note', 'note', 'blocked', 'signal_mismatch');
    await nearmiss.proposeForText('记一下 A');
    await nearmiss.proposeForText('记一下 B');
    const p = await nearmiss.proposeForText('记一下 C');
    expect(p?.objectType).toBe('note');
  });
});