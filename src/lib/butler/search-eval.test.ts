/**
 * search-eval 的纯逻辑单测（不需要模型 / 不需要桌面端 / 不碰磁盘）
 *
 * 这些数字是后面所有调优的基准线，所以断言写死具体比值，而不是"结果大于 0"——
 * 指标口径一旦被无意改动（比如误杀率的分母从"已标注的 dropped"改成"全部 dropped"），
 * 这里必须响。
 */
import { describe, expect, it } from 'vitest';
import {
  charBigrams,
  evaluate,
  findItemForRound,
  gradeCandidate,
  jaccard,
  matchLabel,
  ndcgAtK,
  poolCandidates,
  renderReport,
  roundFromTrace,
  scoreRound,
  triageDropped,
  type EvalCandidate,
  type EvalGoldenItem,
  type EvalRound,
} from './search-eval';

/** 造候选：url 默认按 id 派生，避免"同一篇"被去重误伤 */
function cand(p: Partial<EvalCandidate> & Pick<EvalCandidate, 'id' | 'title' | 'verdict'>): EvalCandidate {
  return { url: `https://example.com/${p.id}`, ...p };
}

const ITEM: EvalGoldenItem = {
  id: 'bankruptcy-fee',
  query: '破产衍生诉讼，债权人垫付诉讼费',
  labels: [
    { value: '权威通知', grade: 3, asserted: true },
    { value: '实务处理', grade: 2 },
    { value: '软文', grade: 0 },
  ],
};

const R1: EvalRound = {
  roundId: 'r1',
  query: ITEM.query,
  source: 'stored-trace',
  ranked: false,
  candidates: [
    cand({ id: 0, title: '权威通知：诉讼费缓交', verdict: 'kept', readOk: true }),
    cand({ id: 1, title: '浅析诉讼费实务处理', verdict: 'kept', readOk: true }),
    cand({ id: 2, title: '某某软文导流', verdict: 'kept', readOk: false }),
    // 既没被命中，也不是相关：它不该污染任何分母
    cand({ id: 3, title: '追缴股东出资相关问题', verdict: 'dropped' }),
    // 人工标为必找，却被判掉 —— 误杀
    cand({ id: 4, title: '权威通知（转载）', verdict: 'dropped' }),
  ],
};

describe('标签匹配', () => {
  it('默认按标题做大小写不敏感子串匹配', () => {
    expect(matchLabel({ value: 'butler', grade: 1 }, cand({ id: 0, title: 'Butler 检索', verdict: 'kept' }))).toBe(true);
    expect(matchLabel({ value: '不存在', grade: 1 }, cand({ id: 0, title: 'Butler 检索', verdict: 'kept' }))).toBe(false);
  });

  it('可以按 url / 公众号匹配', () => {
    const c = cand({ id: 7, title: '某文', verdict: 'kept', account: '金融与法' });
    expect(matchLabel({ by: 'url', value: 'example.com/7', grade: 2 }, c)).toBe(true);
    expect(matchLabel({ by: 'account', value: '金融', grade: 2 }, c)).toBe(true);
    expect(matchLabel({ by: 'account', value: '金融', grade: 2 }, cand({ id: 8, title: '无公众号', verdict: 'kept' }))).toBe(false);
  });

  it('以 / 包起来按正则，非法正则降级为子串（不让写错的标注炸掉评测）', () => {
    const c = cand({ id: 1, title: '债权人垫付诉讼费', verdict: 'kept' });
    expect(matchLabel({ value: '/诉讼费|垫付/', grade: 3 }, c)).toBe(true);
    expect(matchLabel({ value: '/([/', grade: 3 }, c)).toBe(false);
  });

  it('候选等级取命中标签里的最高值；未标注不参与', () => {
    const c = cand({ id: 1, title: '诉讼费实务', verdict: 'kept' });
    expect(gradeCandidate(c, [{ value: '诉讼', grade: 1 }, { value: '诉讼费', grade: 3 }]).grade).toBe(3);
    expect(gradeCandidate(c, [{ value: '诉讼', grade: null }]).grade).toBeNull();
    expect(gradeCandidate(c, [{ value: '税务', grade: 3 }]).matched).toHaveLength(0);
  });
});

describe('单轮指标', () => {
  const m = scoreRound(R1, ITEM, R1.candidates);

  it('计数正确（判掉的不等于没标注）', () => {
    expect(m.counts).toMatchObject({
      recalled: 5,
      kept: 3,
      dropped: 2,
      pending: 0,
      judged: 4,
      unjudged: 1,
      keptJudged: 3,
      droppedJudged: 1,
      relevantRecalled: 3,
      mustRecalled: 2,
      asserted: 1,
      assertedRecalled: 1,
      assertedOutsidePool: 0,
    });
  });

  it('通道召回只认 asserted 标签（口径 ①）', () => {
    expect(m.metrics.channelRecall).toMatchObject({ num: 1, den: 1 });
  });

  it('precision@k = kept 中已判定为相关的占比', () => {
    expect(m.metrics.precisionAtK).toMatchObject({ num: 2, den: 3 });
  });

  it('kept 一个都没判定时 precision 是 N/A，而不是误报 0%', () => {
    const blank: EvalGoldenItem = { ...ITEM, labels: ITEM.labels.map((l) => ({ ...l, grade: null })) };
    expect(scoreRound(R1, blank, R1.candidates).metrics.precisionAtK).toBeNull();
  });

  it('必找保持 = 召回到的 grade3 里被 kept 的比例', () => {
    expect(m.metrics.mustKeepRecall).toMatchObject({ num: 1, den: 2 });
  });

  it('误杀率分母只算"已标注的 dropped"（口径 ②）', () => {
    expect(m.metrics.falseDropRate).toMatchObject({ num: 1, den: 1 });
    expect(m.falseDrops.map((d) => d.title)).toEqual(['权威通知（转载）']);
  });

  it('pool 覆盖 = 本轮召回 / pool 总数（零标注也能算，用来量化"召回窄"）', () => {
    const pool = [...R1.candidates, cand({ id: 90, title: '只被另一个方向搜到', verdict: 'pending' })];
    expect(scoreRound(R1, ITEM, pool).metrics.poolCoverage).toMatchObject({ num: 5, den: 6 });
    // pool 就是本轮自己时恒为 1（n=1 的退化情形，报告里会警告）
    expect(m.metrics.poolCoverage).toMatchObject({ value: 1 });
  });

  it('没有模型排序时 nDCG 为 N/A，不拿召回序冒充（口径 ③）', () => {
    expect(m.metrics.ndcgAtK).toBeNull();
  });

  it('正文读到率忽略"没读正文"的轮次（readOk 为 undefined）', () => {
    expect(m.metrics.readOkRate).toMatchObject({ num: 2, den: 3 });
    const pooled: EvalRound = { ...R1, candidates: R1.candidates.map((c) => ({ ...c, readOk: undefined })) };
    expect(scoreRound(pooled, ITEM, pooled.candidates).metrics.readOkRate).toBeNull();
  });

  it('没有任何 asserted 标签时通道召回为 N/A', () => {
    const noAsserted: EvalGoldenItem = { ...ITEM, labels: ITEM.labels.map((l) => ({ ...l, asserted: undefined })) };
    expect(scoreRound(R1, noAsserted, R1.candidates).metrics.channelRecall).toBeNull();
  });

  it('nDCG 用模型名次排，不用落库的召回序（口径 ③ 的收益）', () => {
    // 数组序（召回序）恰好是"理想序"，但模型给的名次是反的：
    //   若拿数组序充数 → 1.0（假的好看）；按 rank 排 → 0.631（真实）
    const rankedRound: EvalRound = {
      ...R1,
      ranked: true,
      candidates: [
        cand({ id: 0, title: '权威通知：诉讼费缓交', verdict: 'kept', rank: 1 }),
        cand({ id: 1, title: '某某软文导流', verdict: 'kept', rank: 0 }),
      ],
    };
    const r = scoreRound(rankedRound, ITEM, rankedRound.candidates).metrics.ndcgAtK;
    if (!r) throw new Error('带 rank 的轮次应当算得出 nDCG');
    expect(r.value).toBeCloseTo(0.631, 3);
  });

  it('ranked=true 但 kept 缺 rank → 退回 N/A（不拿召回序充数）', () => {
    const broken: EvalRound = {
      ...R1,
      ranked: true,
      candidates: [cand({ id: 0, title: '权威通知：诉讼费缓交', verdict: 'kept' })],
    };
    expect(scoreRound(broken, ITEM, broken.candidates).metrics.ndcgAtK).toBeNull();
  });
});

describe('nDCG', () => {
  it('完全符合理想序时为 1', () => {
    expect(ndcgAtK([3, 0], [3, 0], 2)).toMatchObject({ value: 1 });
  });

  it('把必找的文章排到第二位会被折价', () => {
    const r = ndcgAtK([0, 3], [3, 0], 2);
    if (!r) throw new Error('ndcgAtK 不该为 null');
    expect(r.value).toBeCloseTo(0.631, 3);
  });

  it('理想增益为 0（全是不相关）时不可算，返回 null 而不是 0', () => {
    expect(ndcgAtK([0], [0], 1)).toBeNull();
  });

  it('理想序未排序也要自己排：否则 IDCG 被算小、nDCG 会虚高（实测出现过 144.9%）', () => {
    // 同一个理想集合，传"乱序"与"降序"必须给出同一个结果
    const sorted = ndcgAtK([3, 0], [3, 0, 2, 1], 2);
    const shuffled = ndcgAtK([3, 0], [2, 1, 3, 0], 2);
    if (!sorted || !shuffled) throw new Error('不该为 null');
    expect(shuffled.value).toBe(sorted.value);
    // 且永远不超过 1（>1 一定是 IDCG 算错了）
    expect(ndcgAtK([3, 0], [1, 2, 0, 3], 2)?.value).toBeLessThanOrEqual(1);
  });
});

describe('从生产数据结构转换', () => {
  it('账本没有 rank（历史轮次 / 兜底路径）→ ranked false，不冒充有排序', () => {
    const r = roundFromTrace('stored-1', {
      query: '破产',
      items: [
        { id: 0, title: 'A', url: 'https://a', verdict: 'kept', readOk: true, reason: 'r' },
        { id: 1, title: 'B', url: 'https://b', verdict: 'dropped' },
        { id: 2, title: 'C', url: 'https://c', verdict: 'pending' },
      ],
    });
    expect(r.ranked).toBe(false);
    expect(r.source).toBe('stored-trace');
    expect(r.candidates[0]).toMatchObject({ reason: 'r', readOk: true });
    expect(r.candidates[1].readOk).toBeUndefined();
    expect(r.candidates[2].verdict).toBe('pending');
  });

  it('账本带 rank（2026-10-01 起）→ ranked true，名次原样带出', () => {
    const r = roundFromTrace('stored-2', {
      query: '破产',
      items: [
        { id: 0, title: 'A', url: 'https://a', verdict: 'kept', rank: 1 },
        { id: 1, title: 'B', url: 'https://b', verdict: 'kept', rank: 0 },
        { id: 2, title: 'C', url: 'https://c', verdict: 'dropped' },
      ],
    });
    expect(r.ranked).toBe(true);
    expect(r.candidates[0].rank).toBe(1);
    expect(r.candidates[1].rank).toBe(0);
  });

  it('账本带 queries / intent → 带进评测（这是"召回差在哪"的归因依据）', () => {
    const r = roundFromTrace('stored-4', {
      query: '破产 垫付诉讼费',
      queries: ['破产衍生诉讼 诉讼费 垫付', '破产 劣后债权 清偿顺序'],
      intent: '想知道垫付与劣后清偿',
      items: [{ id: 0, title: 'A', url: 'https://a', verdict: 'kept' }],
    });
    expect(r.planQueries).toEqual(['破产衍生诉讼 诉讼费 垫付', '破产 劣后债权 清偿顺序']);
    expect(r.intent).toBe('想知道垫付与劣后清偿');
    // 老轮次没有这两个字段 → null（不是空数组，UI 与报告据此区分"没有"与"空"）
    const old = roundFromTrace('stored-5', {
      query: '破产',
      items: [{ id: 0, title: 'A', url: 'https://a', verdict: 'kept' }],
    });
    expect(old.planQueries).toBeNull();
    expect(old.intent).toBeNull();
  });

  it('只有部分 kept 带 rank → 判为无排序（宁可报 N/A，不报残缺的 nDCG）', () => {
    const r = roundFromTrace('stored-3', {
      query: '破产',
      items: [
        { id: 0, title: 'A', url: 'https://a', verdict: 'kept', rank: 0 },
        { id: 1, title: 'B', url: 'https://b', verdict: 'kept' },
      ],
    });
    expect(r.ranked).toBe(false);
  });

  it('去重按标题：同一篇文章在不同方向拿到不同 url 只算一篇（2026-10-01 实测口径）', () => {
    // 搜狗返回的是 /link?url=… 加密跳转链接，同一篇的 token 每次都不同
    const a = cand({ id: 0, title: '高院发布:关于破产衍生诉讼案件诉讼费缓交相关问题的通知', verdict: 'kept' });
    const b = cand({ id: 1, title: '高院发布:关于破产衍生诉讼案件诉讼费缓交相关问题的通知', verdict: 'pending' });
    const pool = poolCandidates([{ ...R1, candidates: [a] }, { ...R1, candidates: [b] }]);
    expect(pool).toHaveLength(1);
    expect(pool[0].url).toBe(a.url);
  });

  it('去重的代价写清楚：标题不同就是两篇，即使 url 恰好相同', () => {
    const a = cand({ id: 0, title: '第一篇', verdict: 'kept' });
    const b = { ...cand({ id: 1, title: '第二篇', verdict: 'kept' }), url: a.url };
    expect(poolCandidates([{ ...R1, candidates: [a, b] }])).toHaveLength(2);
  });

  it('标题为空时退回 url 兜底', () => {
    const a = cand({ id: 0, title: '   ', verdict: 'kept' });
    const b = cand({ id: 1, title: '', verdict: 'kept' });
    expect(poolCandidates([{ ...R1, candidates: [a, b] }])).toHaveLength(2);
  });
});

describe('整体评测（pool 口径）', () => {
  const golden = {
    version: 1 as const,
    items: [
      {
        ...ITEM,
        labels: [
          ...ITEM.labels,
          // 只在第二个 run 里出现过：按口径 ① 它算"召回成功"（通道见过它）
          { value: '第二个方向', grade: 2, asserted: true },
          // 两个 run 都没有：这才是通道漏召
          { value: '权威原文（谁都没搜到）', grade: 3, asserted: true },
        ],
      },
    ],
  };
  const r2: EvalRound = {
    roundId: 'r2',
    query: ITEM.query,
    source: 'capture-bridge',
    ranked: false,
    candidates: [cand({ id: 99, title: '第二个方向上的文章', verdict: 'dropped' })],
  };
  const report = evaluate([R1, r2], golden);
  const item = report.items[0];

  it('pool 跨 run 合并', () => {
    expect(item.runCount).toBe(2);
    expect(item.poolSize).toBe(6);
  });

  it('asserted 召回以 pool 为准；pool 里没有的进"漏召候选"', () => {
    expect(item.pool.assertedTotal).toBe(3);
    expect(item.pool.assertedRecalled).toBe(2);
    expect(item.pool.assertedMissing.map((m) => m.value)).toEqual(['权威原文（谁都没搜到）']);
  });

  it('单轮通道召回也按 pool 算（只出现在 r2 的标签算 r1 召回成功）', () => {
    const r1Metrics = item.runs.find((r) => r.roundId === 'r1');
    expect(r1Metrics?.metrics.channelRecall).toMatchObject({ num: 2, den: 3 });
  });

  it('提醒口径风险：pool 只有 1 个 run / 落库账本没有模型排序', () => {
    const single = evaluate([R1], golden).items[0];
    expect(single.warnings.join('\n')).toContain('pool 只有 1 个 run');
    expect(single.warnings.join('\n')).toContain('nDCG 不可算');
  });

  it('对不上的 run 会被单独列出而不是静默丢弃', () => {
    const stray: EvalRound = { ...R1, roundId: 'stray', query: '完全无关的问题' };
    const rep = evaluate([stray], golden);
    expect(rep.unmatchedRounds).toEqual(['stray']);
    expect(rep.warnings.join('\n')).toContain('没对上任何 golden 条目');
  });

  it('report 渲染出可核对的分子分母', () => {
    const md = renderReport(evaluate([R1], golden));
    expect(md).toContain('误杀率');
    expect(md).toContain('66.7%（2/3）');
  });
});

describe('人工标注辅助', () => {
  it('bigram / jaccard 基础行为', () => {
    expect([...charBigrams('破产 诉讼')].sort()).toEqual(['破产', '诉讼'].sort());
    expect(jaccard(charBigrams('破产诉讼'), charBigrams('破产诉讼'))).toBe(1);
    expect(jaccard(new Set(), charBigrams('破产'))).toBe(0);
  });

  it('triage 把同域的 dropped 排在前面（只是复查队列，不是判定）', () => {
    const round: EvalRound = {
      ...R1,
      candidates: [
        cand({ id: 0, title: '破产衍生诉讼诉讼费垫付实务', verdict: 'dropped' }),
        cand({ id: 1, title: '如何选购跑步鞋', verdict: 'dropped' }),
      ],
    };
    const rows = triageDropped(round);
    expect(rows).toHaveLength(2);
    expect(rows[0].candidate.id).toBe(0);
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(rows[1].score).toBe(0);
  });
});

describe('查询与条目对齐', () => {
  it('精确匹配优先，其次双向包含', () => {
    const items = [{ id: 'a', query: '破产衍生诉讼，债权人垫付诉讼费', labels: [] }];
    expect(findItemForRound({ ...R1, query: '  破产衍生诉讼，债权人垫付诉讼费 ' }, items)?.id).toBe('a');
    expect(findItemForRound({ ...R1, query: '破产衍生诉讼' }, items)?.id).toBe('a');
    expect(findItemForRound({ ...R1, query: '如何选购跑步鞋' }, items)).toBeNull();
  });

  it('pool run 靠 itemQuery 归属到原句（子方向不该变成孤儿轮次）', () => {
    const items = [{ id: 'a', query: '破产衍生诉讼，债权人垫付诉讼费', labels: [] }];
    const poolRun: EvalRound = {
      ...R1,
      roundId: 'pool-1',
      query: '破产 劣后债权 清偿顺序',
      itemQuery: '破产衍生诉讼，债权人垫付诉讼费',
    };
    expect(findItemForRound(poolRun, items)?.id).toBe('a');
    // 没标 itemQuery 时子方向确实对不上 —— 这正是加这个字段的原因
    expect(findItemForRound({ ...poolRun, itemQuery: null }, items)).toBeNull();
  });
});
