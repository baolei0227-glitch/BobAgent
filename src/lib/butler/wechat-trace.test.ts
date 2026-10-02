/**
 * 账本组装（buildTrace / fallbackTrace）的单测。
 *
 * 这是**账本 schema 的唯一边界**：写进 `ChatMessage.searchTrace` 的字段，
 * 事后没法补（历史落库了就落库了）。所以这里逐个字段钉：
 * 数组顺序恒为召回序、模型名次只进 `rank`、兜底路径**不许**写 rank。
 */
import { describe, expect, it } from 'vitest';
import { buildTrace, fallbackTrace, type TraceHit } from './wechat-trace';

const HITS: TraceHit[] = [
  { title: '甲', url: 'https://a', account: '号A', snippet: '甲摘要' },
  { title: '乙', url: 'https://b', snippet: '乙摘要' },
  { title: '丙', url: 'https://c' },
  { title: '丁', url: 'https://d' },
];

describe('buildTrace', () => {
  it('数组顺序恒为召回序（id 升序），模型名次只进 rank', () => {
    const trace = buildTrace(
      HITS,
      [{ index: 3, reason: '最相关' }, { index: 1, reason: '次之' }],
      [],
      new Map(),
      { ranked: true },
    );
    expect(trace.map((t) => t.id)).toEqual([0, 1, 2, 3]);
    expect(trace.map((t) => t.verdict)).toEqual(['dropped', 'kept', 'dropped', 'kept']);
    // rank = 在 picks 里的位置（picks 已按相关度降序）
    expect(trace[3].rank).toBe(0);
    expect(trace[1].rank).toBe(1);
    expect(trace[3].reason).toBe('最相关');
  });

  it('判掉的篇目不写 rank / reason / summary / readOk', () => {
    const trace = buildTrace(
      HITS,
      [{ index: 1, reason: 'r' }],
      [{ id: 0, ok: true, title: 'x', account: 'y' }],
      new Map([[0, { summary: 's', keypoint: 'k' }]]),
      { ranked: true },
    );
    const dropped = trace[0];
    expect(dropped.verdict).toBe('dropped');
    expect(dropped.rank).toBeUndefined();
    expect(dropped.reason).toBeUndefined();
    expect(dropped.summary).toBeUndefined();
    expect(dropped.readOk).toBeUndefined();
  });

  it('ranked=false（兜底路径）不写 rank —— 那几篇的顺序是召回序，不是模型排序', () => {
    const trace = buildTrace(HITS, [{ index: 0, reason: '' }], [], new Map(), { ranked: false });
    expect(trace[0].verdict).toBe('kept');
    expect(trace[0].rank).toBeUndefined();
  });

  it('正文读到过就用正文里的标题 / 公众号（更准），并记 readOk', () => {
    const trace = buildTrace(
      HITS,
      [{ index: 1, reason: 'r' }],
      [{ id: 1, ok: true, title: '乙（正文标题）', account: '真号' }],
      new Map(),
      { ranked: true },
    );
    expect(trace[1].title).toBe('乙（正文标题）');
    expect(trace[1].account).toBe('真号');
    expect(trace[1].readOk).toBe(true);
  });

  it('正文没读到（ok=false）也要记下来：卡片上会标"正文未读到"，不是假装读到了', () => {
    const trace = buildTrace(HITS, [{ index: 2, reason: 'r' }], [{ id: 2, ok: false, title: '', account: '' }], new Map(), {
      ranked: true,
    });
    expect(trace[2].readOk).toBe(false);
    expect(trace[2].title).toBe('丙'); // 没被空标题覆盖
  });

  it('摘要 / 要点只挂在对应的 kept 上', () => {
    const trace = buildTrace(
      HITS,
      [{ index: 1, reason: 'r1' }, { index: 2, reason: 'r2' }],
      [],
      new Map([[2, { summary: '丙的一句话', keypoint: '要点' }]]),
      { ranked: true },
    );
    expect(trace[1].summary).toBeUndefined();
    expect(trace[2].summary).toBe('丙的一句话');
    expect(trace[2].keypoint).toBe('要点');
  });

  it('snippet 截到 160 字（账本不存整段摘要）', () => {
    const long = 'x'.repeat(400);
    const trace = buildTrace([{ title: '长', url: 'https://long', snippet: long }], [], [], new Map(), { ranked: false });
    expect(trace[0].snippet).toHaveLength(160);
  });
});

describe('fallbackTrace（模型不可用 / 精编中断）', () => {
  it('只留前 maxPick 篇为 kept，且一律不写 rank', () => {
    const trace = fallbackTrace(HITS, 3);
    expect(trace.map((t) => t.verdict)).toEqual(['kept', 'kept', 'kept', 'dropped']);
    expect(trace.every((t) => t.rank === undefined)).toBe(true);
  });

  it('候选比 maxPick 少时也不炸', () => {
    const trace = fallbackTrace(HITS.slice(0, 2), 3);
    expect(trace.every((t) => t.verdict === 'kept')).toBe(true);
  });
});
