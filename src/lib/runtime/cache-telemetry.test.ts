/**
 * CallPrefixTracker 回归测试（2026-10-02 新增 per-call 缓存遥测）
 *
 * 锁定三件在下一次缓存审计里必须可信的事：
 *   ① 追加式增长的历史 → historyRewritten 恒 false（不误报漂移）；
 *   ② 中间历史被改写 → 下一次调用必须报 historyRewritten=true（真漂移不能漏报）；
 *   ③ 工具段变化 → toolsChanged=true；首次调用不报（避免噪声）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CallPrefixTracker, getSessionTracker, recordCacheCall, type PrefixMessage } from './cache-telemetry';

const SYS: PrefixMessage = { role: 'system', content: 'BASE' };
const TOOLS_A = [{ function: { name: 'read_file' } }];
const TOOLS_B = [{ function: { name: 'read_file' } }, { function: { name: 'browser_click' } }];

describe('CallPrefixTracker', () => {
  it('追加式增长的历史不报漂移，且 history 口径排除最后一条', () => {
    const t = new CallPrefixTracker();
    const msgs: PrefixMessage[] = [SYS, { role: 'user', content: 'u1' }];
    const first = t.describe(msgs, TOOLS_A);
    // 首轮：history 只有 system 之外的 0 条（最后一条被排除）
    expect(first.historyCount).toBe(0);
    expect(first.toolsChanged).toBe(false);

    msgs.push({ role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' });
    const second = t.describe(msgs, TOOLS_A);
    expect(second.historyCount).toBe(2); // u1 + a1
    expect(second.historyRewritten).toBe(false);
    expect(second.toolsChanged).toBe(false);
    // 工具段未变 → 指纹一致
    expect(second.toolsHash).toBe(first.toolsHash);
    // system 段恒定
    expect(second.systemHash).toBe(first.systemHash);
  });

  it('历史中段被改写 → 后续调用报 historyRewritten=true', () => {
    const t = new CallPrefixTracker();
    const msgs: PrefixMessage[] = [SYS, { role: 'user', content: 'u1' }];
    t.describe(msgs, TOOLS_A);
    msgs.push({ role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' });
    t.describe(msgs, TOOLS_A);

    // 模拟「当前轮 user 块未被持久化，下一轮同一位置变回裸文本」：改写历史中间的消息
    msgs[1] = { role: 'user', content: 'u1-改写' };
    msgs.push({ role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3' });
    const third = t.describe(msgs, TOOLS_A);
    expect(third.historyRewritten).toBe(true);
  });

  it('工具段变化 → toolsChanged=true 且指纹/字节数随之更新', () => {
    const t = new CallPrefixTracker();
    const msgs: PrefixMessage[] = [SYS, { role: 'user', content: 'u1' }];
    const a = t.describe(msgs, TOOLS_A);
    const b = t.describe(msgs, TOOLS_B);
    expect(b.toolsChanged).toBe(true);
    expect(b.toolCount).toBe(2);
    expect(b.toolsHash).not.toBe(a.toolsHash);
    expect(b.toolsBytes).toBeGreaterThan(a.toolsBytes);
    // 同一引用重复调用不再重算，也不再报变化
    const c = t.describe(msgs, TOOLS_B);
    expect(c.toolsChanged).toBe(false);
  });

  it('上一轮的「本轮输入」被改写（@资料块丢失形态）→ lastTurnRewritten=true', () => {
    const t = new CallPrefixTracker();
    // 第 1 轮：本轮输入带 @资料块
    const msgs: PrefixMessage[] = [SYS, { role: 'user', content: 'u1\n--- 资料列表 ---\nX' }];
    const first = t.describe(msgs, TOOLS_A);
    expect(first.lastUserRefBlocks).toBe(true);

    // 第 2 轮：同一条消息变回裸文本（客户端未持久化 effectiveContent）
    msgs[1] = { role: 'user', content: 'u1' };
    msgs.push({ role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' });
    const second = t.describe(msgs, TOOLS_A);
    expect(second.lastTurnRewritten).toBe(true);
    // 不带引用块的普通轮次
    expect(second.lastUserRefBlocks).toBe(false);
  });

  it('getSessionTracker 按 key 复用同一实例（跨任务保留比对基准）', () => {
    const a = getSessionTracker('node-x');
    const b = getSessionTracker('node-x');
    expect(a).toBe(b);
    expect(getSessionTracker('node-y')).not.toBe(a);
  });
});

describe('recordCacheCall', () => {
  const originalHome = process.env.BOBWORK_HOME;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bobwork-cachetel-'));
    process.env.BOBWORK_HOME = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.BOBWORK_HOME;
    else process.env.BOBWORK_HOME = originalHome;
  });

  it('按行追加 JSONL，字段可回读', () => {
    recordCacheCall({
      taskId: 'task-1',
      nodeId: 'node-1',
      agent: 'chat',
      model: 'deepseek-flash',
      callIdx: 1,
      systemHash: 's',
      toolsHash: 't',
      toolsBytes: 1234,
      toolCount: 19,
      toolsChanged: false,
      historyHash: 'h',
      historyCount: 3,
      historyRewritten: false,
      lastTurnRewritten: false,
      lastUserRefBlocks: true,
      promptTokens: 100,
      completionTokens: 10,
      cacheHitTokens: 90,
      cacheMissTokens: 10,
      cumPromptTokens: 100,
      cumCacheHitTokens: 90,
      cumCacheMissTokens: 10,
      payloadChars: 250,
      messageCount: 4,
    });
    const lines = readFileSync(join(dir, '.logs', 'cache-telemetry.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(rec.taskId).toBe('task-1');
    expect(rec.cacheMissTokens).toBe(10);
    expect(typeof rec.t).toBe('string');
  });
});
