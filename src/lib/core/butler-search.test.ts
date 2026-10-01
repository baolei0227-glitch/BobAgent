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

  it('空提问 + 空综述不落库（避免写入一条无意义的空气泡）', async () => {
    const before = (await threads.readThread('butler-search'))?.messages.length ?? 0;
    await search.recordSearchExchange('', '   ', []);
    const after = (await threads.readThread('butler-search'))?.messages.length ?? 0;
    expect(after).toBe(before);
  });

  it('parseThread 透传 cards：绕过存储层也能从原始 JSON 里读回', () => {
    const raw = JSON.stringify({
      threadId: 'butler-search',
      messages: [{ role: 'assistant', content: '综述', cards }],
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
  });
});
