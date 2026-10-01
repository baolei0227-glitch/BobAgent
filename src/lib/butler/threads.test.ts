/**
 * Butler 线程（Threads）回归：Phase 4 §4a 的自有会话态。
 *
 * 锁住三组不变量：
 *   1) **纯函数口径**：TTL 按来源分档、未读只算 assistant、裁头对齐、摘要派生；
 *   2) **读写往返**：一条线程一个文件，字段不丢、tailTimes 按尾部倒序对齐；
 *   3) **生命周期**：wechat 过期「读到即删」、sweep 只删过期项、归档线程不进列表。
 *
 * 隔离：BOBWORK_HOME 指向临时目录（对齐 rules.test.ts 的做法），避免碰到真实 ~/BobWork。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  WECHAT_THREAD_TTL_MS,
  countUnreadAssistant,
  overlapLen,
  summarizeThread,
  threadExpiresAt,
  trimThreadMessages,
  type ButlerThread,
  type ChatMessage,
} from './threads-shared';

let home = '';
let threads: typeof import('./threads');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-threads-'));
  process.env.BOBWORK_HOME = home;
  threads = await import('./threads');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

// ==================== 纯函数 ====================

describe('线程 TTL 按来源分档（source 只管 TTL，不管身份）', () => {
  it('panel 线程长期保留：expiresAt 恒为 null', () => {
    expect(threadExpiresAt('panel')).toBeNull();
    expect(threadExpiresAt('panel', 1_700_000_000_000)).toBeNull();
  });

  it('wechat 线程 24 小时过期：expiresAt = now + TTL', () => {
    const now = 1_700_000_000_000;
    expect(threadExpiresAt('wechat', now)).toBe(now + WECHAT_THREAD_TTL_MS);
    expect(WECHAT_THREAD_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('notify（常驻通知助理）长期保留，不会被清扫器删掉', () => {
    expect(threadExpiresAt('notify')).toBeNull();
    expect(threadExpiresAt('notify', 1_700_000_000_000)).toBeNull();
  });
});

describe('线程未读判定（countUnreadAssistant）', () => {
  const msgs = (roles: Array<'user' | 'assistant'>): ChatMessage[] => roles.map((role) => ({ role, content: role }));

  it('只算 assistant：自己发出去的 user 消息不算未读', () => {
    // 正序 [assistant, user, assistant]；tailTimes 按**尾部倒序**对齐：tail[0] ↔ 最后一条
    const tail = [300, 200, 100];
    expect(countUnreadAssistant(msgs(['assistant', 'user', 'assistant']), tail, 250, 300)).toBe(1);
  });

  it('已读时刻之后的 assistant 才算未读，读过的归零', () => {
    const tail = [200, 100];
    expect(countUnreadAssistant(msgs(['assistant', 'assistant']), tail, 150, 200)).toBe(1);
    expect(countUnreadAssistant(msgs(['assistant', 'assistant']), tail, 250, 200)).toBe(0);
  });

  it('时间戳缺失（老数据无 tailTimes）退化为 updatedAt，不与已读时刻自相矛盾', () => {
    const messages = msgs(['user', 'assistant']);
    expect(countUnreadAssistant(messages, [], 100, 300)).toBe(1);
    expect(countUnreadAssistant(messages, [], 300, 300)).toBe(0);
  });
});

describe('裁头对齐（overlapLen）与裁剪窗（trimThreadMessages）', () => {
  const M = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

  it('overlapLen 认尾部重合段：裁头 + 追加同量条数也能认出新增', () => {
    const prev = ['a', 'b', 'c'];
    // 新列表 = 旧列表尾部 ['b','c'] + 新增 ['d']
    expect(overlapLen(prev, ['b', 'c', 'd'])).toBe(2);
    // 完全不相干
    expect(overlapLen(['x'], ['y'])).toBe(0);
    // 新列表是旧列表的超集（纯追加）
    expect(overlapLen(['a', 'b'], ['a', 'b', 'c'])).toBe(2);
  });

  it('trimThreadMessages 保留 system 与最近 20 轮，且剩余开头是 user', () => {
    const sys = M('system', 'S');
    const pairs: ChatMessage[] = [];
    for (let i = 0; i < 25; i++) pairs.push(M('user', `u${i}`), M('assistant', `a${i}`));
    const out = trimThreadMessages([sys, ...pairs]);
    expect(out[0]).toEqual(sys);
    expect(out.length).toBe(1 + 20 * 2);
    expect(out[1].role).toBe('user');
    // 落在窗口内的是最后 20 轮
    expect(out[1].content).toBe('u5');
  });

  it('末尾单条 user（还未答复）不会被裁掉', () => {
    const sys = M('system', 'S');
    const pairs: ChatMessage[] = [];
    for (let i = 0; i < 25; i++) pairs.push(M('user', `u${i}`), M('assistant', `a${i}`));
    const out = trimThreadMessages([sys, ...pairs, M('user', 'pending')]);
    expect(out[out.length - 1].content).toBe('pending');
    expect(out[1].role).toBe('user');
  });
});

describe('摘要派生（summarizeThread）', () => {
  const base: ButlerThread = {
    threadId: 'b-1-abc',
    messages: [
      { role: 'user', content: '帮我看看明天的日程' },
      { role: 'assistant', content: '<think>想一下</think>明天只有一场会。' },
    ],
    tailTimes: [200, 100],
    persona: null,
    source: 'panel',
    lifecycle: 'active',
    readAt: 0,
    createdAt: 1,
    updatedAt: 200,
    expiresAt: null,
  };

  it('标题取首条 user；副标题取末条 assistant 且剥掉 think', () => {
    const s = summarizeThread(base);
    expect(s.title).toBe('帮我看看明天的日程');
    expect(s.preview).toBe('明天只有一场会。');
    expect(s.messageCount).toBe(2);
    expect(s.unread).toBe(1);
  });

  it('有人设时以姓名作标题；空线程副标题退化为人设性格', () => {
    const s = summarizeThread({
      ...base,
      messages: [],
      tailTimes: [],
      persona: { name: '小法', personality: '傲娇但心软' },
    });
    expect(s.title).toBe('小法');
    expect(s.preview).toBe('傲娇但心软');
    expect(s.unread).toBe(0);
  });
});

// ==================== 读写与生命周期（fs） ====================

describe('线程存储读写与生命周期', () => {
  it('createThread 建空线程：长期保留、初始已读、出现在列表', async () => {
    await threads.createThread('b-100-a1', { name: '小法' }, 'panel');
    const t = await threads.readThread('b-100-a1');
    expect(t).not.toBeNull();
    expect(t?.messages).toEqual([]);
    expect(t?.expiresAt).toBeNull();
    expect(t?.readAt).toBeGreaterThan(0);
    const list = await threads.listThreads();
    expect(list.some((s) => s.threadId === 'b-100-a1' && s.title === '小法')).toBe(true);
  });

  it('upsertThread 自维护 tailTimes（尾部倒序对齐 messages）', async () => {
    await threads.upsertThread('b-101-a2', [{ role: 'user', content: 'hi' }], 'panel');
    const first = await threads.readThread('b-101-a2');
    expect(first?.messages).toHaveLength(1);
    expect(first?.tailTimes).toHaveLength(1);

    await threads.upsertThread(
      'b-101-a2',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      'panel',
    );
    const second = await threads.readThread('b-101-a2');
    expect(second?.messages).toHaveLength(2);
    expect(second?.tailTimes).toHaveLength(2);
    // 重合段沿用旧时间戳：尾部倒序 tail[1] ↔ 正序第 0 条 'hi'
    expect(second?.tailTimes[1]).toBe(first?.tailTimes[0]);
  });

  it('长期线程不被降级：panel 线程经 wechat 写入后仍不过期', async () => {
    await threads.upsertThread('b-102-a3', [{ role: 'user', content: 'x' }], 'panel');
    await threads.upsertThread('b-102-a3', [{ role: 'user', content: 'y' }], 'wechat');
    const t = await threads.readThread('b-102-a3');
    expect(t?.source).toBe('panel');
    expect(t?.expiresAt).toBeNull();
  });

  it('wechat 线程过期「读到即删」', async () => {
    await threads.writeThreadFile({
      threadId: 'b-103-a4',
      messages: [{ role: 'user', content: 'gone' }],
      tailTimes: [1],
      persona: null,
      source: 'wechat',
      lifecycle: 'active',
      readAt: 0,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() - 1000,
    });
    expect(await threads.readThread('b-103-a4')).toBeNull();
    // 再读一次仍为空（文件已被删除）
    expect(await threads.readThread('b-103-a4')).toBeNull();
  });

  it('sweepThreads 只删过期项，活跃线程与长期线程保留', async () => {
    await threads.createThread('b-104-a5', null, 'panel');
    await threads.writeThreadFile({
      threadId: 'b-104-a6',
      messages: [],
      tailTimes: [],
      persona: null,
      source: 'wechat',
      lifecycle: 'active',
      readAt: 0,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() - 1,
    });
    const res = await threads.sweepThreads();
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await threads.readThread('b-104-a5')).not.toBeNull();
    expect(await threads.readThread('b-104-a6')).toBeNull();
  });

  it('归档线程不进列表，但文件仍在（可解档）', async () => {
    const t: ButlerThread = {
      threadId: 'b-105-a7',
      messages: [{ role: 'user', content: 'archived' }],
      tailTimes: [1],
      persona: null,
      source: 'panel',
      lifecycle: 'archived',
      readAt: 0,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: null,
    };
    await threads.writeThreadFile(t);
    const list = await threads.listThreads();
    expect(list.some((s) => s.threadId === 'b-105-a7')).toBe(false);
    expect(await threads.readThread('b-105-a7')).not.toBeNull();
  });

  it('setThreadPersona 不改 updatedAt；markThreadRead 清零未读', async () => {
    await threads.upsertThread(
      'b-106-a8',
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
      'panel',
    );
    const before = await threads.readThread('b-106-a8');
    await threads.setThreadPersona('b-106-a8', { name: '小助手' });
    const after = await threads.readThread('b-106-a8');
    expect(after?.persona?.name).toBe('小助手');
    expect(after?.updatedAt).toBe(before?.updatedAt);

    expect((await threads.listThreads()).find((s) => s.threadId === 'b-106-a8')?.unread).toBe(1);
    await threads.markThreadRead('b-106-a8');
    expect((await threads.listThreads()).find((s) => s.threadId === 'b-106-a8')?.unread).toBe(0);
  });

  it('deleteThreadMessages 按 role+正文删，并同步过滤 tailTimes', async () => {
    await threads.upsertThread(
      'b-107-a9',
      [
        { role: 'user', content: 'k1' },
        { role: 'assistant', content: 'k2' },
        { role: 'user', content: 'k3' },
      ],
      'panel',
    );
    const removed = await threads.deleteThreadMessages('b-107-a9', [{ role: 'assistant', content: 'k2' }]);
    expect(removed).toBe(1);
    const t = await threads.readThread('b-107-a9');
    expect(t?.messages.map((m) => m.content)).toEqual(['k1', 'k3']);
    expect(t?.tailTimes).toHaveLength(2);
  });

  it('deleteThread 删掉整条；非法 id 一律拒绝（防目录穿越）', async () => {
    await threads.createThread('b-108-b1', null, 'panel');
    await threads.deleteThread('b-108-b1');
    expect(await threads.readThread('b-108-b1')).toBeNull();
    // 非法 id：读不到、删不掉
    expect(await threads.readThread('../etc/passwd')).toBeNull();
    await threads.deleteThread('../etc/passwd');
    expect(await threads.readThread('a/b')).toBeNull();
  });

  it('countUnreadThreads 汇总全部线程的未读 assistant 条数', async () => {
    await threads.createThread('b-109-b2', null, 'panel');
    await threads.upsertThread(
      'b-109-b2',
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
      'panel',
    );
    expect(await threads.countUnreadThreads()).toBeGreaterThanOrEqual(1);
  });
});