/**
 * 小微搜索「落库往返」回归测试（recordSearchExchange）。
 *
 * 为什么值得测：2026-09-30 收口前，检索综述落库、**文章卡片只在临时浮层里**，
 * 于是用户「看到综述、但看不到检索了哪些文章」，刷新后卡片更是彻底消失。
 * 收口后卡片挂在 assistant 消息的 `cards` 字段上一并落库 —— 这条链路的每一环都必须成立：
 *   recordSearchExchange → appendThreadMessages → 线程文件 JSON → parseThread → 读回 cards
 * 任一环把 `cards` 丢掉（字段白名单 / 序列化 / 裁剪），缺陷就静默复现，故用测试钉住。
 *
 * 隔离：BOBWORK_HOME 指向临时目录（对齐 threads.test.ts），不碰真实 ~/BobWork。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let threads: typeof import('@/lib/butler/threads');
let search: typeof import('./butler-search');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-search-'));
  process.env.BOBWORK_HOME = home;
  threads = await import('@/lib/butler/threads');
  search = await import('./butler-search');
  // 常驻线程须先建（appendThreadMessages 对不存在的线程直接跳过，不凭空建）
  await threads.createThread('butler-search', null, 'panel');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

const cards = [
  { title: '低空经济为什么会火', url: 'https://mp.weixin.qq.com/s/a', account: '甲号', keypoint: '政策放开', summary: '政策与产业共振。' },
  { title: 'eVTOL 产业链梳理', url: 'https://mp.weixin.qq.com/s/b' },
];

describe('recordSearchExchange 落库往返', () => {
  it('提问 + 综述 + 卡片一并落库；卡片可原样读回', async () => {
    await search.recordSearchExchange('低空经济', '## 检索综述\n政策与产业共振。', cards as never);

    const t = await threads.readThread('butler-search');
    expect(t?.messages).toHaveLength(2);
    expect(t?.messages[0]).toMatchObject({ role: 'user', content: '低空经济' });
    expect(t?.messages[1].role).toBe('assistant');
    // 🔴 关键断言：cards 未被字段白名单 / 序列化剥掉
    expect(t?.messages[1].cards).toEqual(cards);
  });

  it('只有卡片、没有综述正文（模型写综述失败）也落库 —— 至少留下列表', async () => {
    await search.recordSearchExchange('固态电池', '', cards.slice(0, 1) as never);
    const t = await threads.readThread('butler-search');
    const last = t?.messages[t.messages.length - 1];
    expect(last?.role).toBe('assistant');
    expect(last?.content).toBe('');
    expect(last?.cards).toHaveLength(1);
  });

  it('检索实况账本随综述消息落库，可原样读回（含被判掉的那几篇）', async () => {
    // 2026-10-01：气泡下方的「查看检索实况」入口依赖这份字段 —— 它要能跨会话 / 重启重开右栏，
    // 所以账本必须跟着消息落库；一旦某环把它丢掉（白名单 / 序列化 / 裁剪），入口就成了死链。
    const trace = [
      { id: 0, title: '入选的一篇', url: 'https://mp.weixin.qq.com/s/x', verdict: 'kept' as const, reason: '深度分析', readOk: true },
      { id: 1, title: '被判定掉的一篇', url: 'https://mp.weixin.qq.com/s/y', verdict: 'dropped' as const, snippet: '标题党' },
    ];
    await search.recordSearchExchange('低空经济', '综述正文', cards.slice(0, 1) as never, trace);
    const t = await threads.readThread('butler-search');
    const last = t?.messages[t.messages.length - 1];
    expect(last?.role).toBe('assistant');
    expect(last?.searchTrace).toEqual({ query: '低空经济', items: trace });
  });

  it('没有账本时不写 searchTrace 字段（普通消息不受影响）', async () => {
    await search.recordSearchExchange('固态电池续', '只有综述', []);
    const t = await threads.readThread('butler-search');
    const last = t?.messages[t.messages.length - 1];
    expect(last?.searchTrace).toBeUndefined();
  });

  it('规划器给的方向与意图一并落库（没有它就无法归因"召回为什么差"）', async () => {
    const trace = [
      { id: 0, title: '入选的一篇', url: 'https://mp.weixin.qq.com/s/x', verdict: 'kept' as const },
    ];
    await search.recordSearchExchange('低空经济', '综述', [], trace, {
      queries: ['低空经济 政策', '  ', 'eVTOL 适航'],
      intent: '想知道低空经济的政策与产业进展',
    });
    const t = await threads.readThread('butler-search');
    const st = t?.messages[t.messages.length - 1]?.searchTrace;
    // 空白方向被剔掉
    expect(st?.queries).toEqual(['低空经济 政策', 'eVTOL 适航']);
    expect(st?.intent).toBe('想知道低空经济的政策与产业进展');
  });

  it('不传 plan（老轮次 / 降级）时不写 queries / intent 字段，而不是写空数组', async () => {
    const trace = [{ id: 0, title: 'A', url: 'https://a', verdict: 'kept' as const }];
    await search.recordSearchExchange('某查询', '综述', [], trace, { queries: ['  '], intent: '   ' });
    const t = await threads.readThread('butler-search');
    const st = t?.messages[t.messages.length - 1]?.searchTrace;
    // UI 要靠"字段不存在"区分"老轮次"与"规划器给了空方向"，所以这里必须是 undefined
    expect(st?.queries).toBeUndefined();
    expect(st?.intent).toBeUndefined();
  });

  it('空提问 + 空综述不落库（避免写入一条无意义的空气泡）', async () => {
    const before = (await threads.readThread('butler-search'))?.messages.length ?? 0;
    await search.recordSearchExchange('', '   ', []);
    const after = (await threads.readThread('butler-search'))?.messages.length ?? 0;
    expect(after).toBe(before);
  });

  it('parseThread 透传 cards 与 searchTrace：绕过存储层也能从原始 JSON 里读回', () => {
    const trace = { query: '低空经济', items: [{ id: 0, title: '甲', url: 'u', verdict: 'dropped' as const }] };
    const raw = JSON.stringify({
      threadId: 'butler-search',
      messages: [{ role: 'assistant', content: '综述', cards, searchTrace: trace }],
      tailTimes: [1],
      source: 'panel',
      lifecycle: 'active',
      readAt: 0,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: null,
    });
    const parsed = threads.parseThread(raw, 'butler-search');
    expect(parsed?.messages[0].cards).toEqual(cards);
    expect(parsed?.messages[0].searchTrace).toEqual(trace);
  });
});
