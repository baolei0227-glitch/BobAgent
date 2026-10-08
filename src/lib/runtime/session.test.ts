/**
 * SessionRuntime sticky 场景回归测试
 *
 * 覆盖四件事：
 *   ① 原有语义：同会话聚合、'team' 永不 sticky、general/coding 不落表；
 *   ② 跨重启落盘（2026-10-02）：新实例（模拟应用重启）能从磁盘读回同一批场景，损坏文件静默降级；
 *   ③ 场景衰减 TTL（2026-10-08）：只有「被本轮意图重新命中 / 中途显式激活」才续命，
 *      仅靠 sticky 读回的旧场景会过期脱落（否则工具段会单调膨胀）；
 *   ④ 每会话场景数上限：超出按最近激活淘汰。
 *
 * 隔离方式：把 BOBWORK_HOME 指向临时目录（resolveAppRoot 运行时读取），落盘路径懒算；
 * TTL 用 vitest 假时钟（vi.setSystemTime）推进，不动真实时间。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionRuntime } from './session';
import type { ToolScene } from '@/app/api/chat/tools';

describe('SessionRuntime', () => {
  let dir: string;
  const originalHome = process.env.BOBWORK_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bobwork-sticky-'));
    process.env.BOBWORK_HOME = dir;
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.BOBWORK_HOME;
    else process.env.BOBWORK_HOME = originalHome;
  });

  it('同会话聚合：场景一旦 sticky，后续请求读回', () => {
    const rt = new SessionRuntime();
    rt.mergeStickyScenes('node-1', new Set<ToolScene>(['legal']));
    const next = new Set<ToolScene>(['ocr']);
    rt.mergeStickyScenes('node-1', next);
    expect([...next].sort()).toEqual(['legal', 'ocr']);
  });

  it("team / general / coding 永不落 sticky", () => {
    const rt = new SessionRuntime();
    rt.mergeStickyScenes('node-2', new Set<ToolScene>(['team', 'general', 'coding', 'legal']));
    expect(rt.getStickyScenes('node-2')).toEqual(new Set<ToolScene>(['legal']));
    rt.addStickyScene('node-2', 'team');
    expect(rt.hasSticky('node-2', 'team')).toBe(false);
  });

  it('跨实例（模拟应用重启）读回磁盘 sticky 场景', () => {
    const first = new SessionRuntime();
    first.mergeStickyScenes('node-3', new Set<ToolScene>(['legal', 'browser']));

    // 新实例 = 进程重启：内存表为空，必须从磁盘读回
    const second = new SessionRuntime();
    const scenes = new Set<ToolScene>();
    second.mergeStickyScenes('node-3', scenes);
    expect([...scenes].sort()).toEqual(['browser', 'legal']);
  });

  it('落盘为 v2 结构（场景 → 时间戳），不含空条目', () => {
    const rt = new SessionRuntime();
    rt.mergeStickyScenes('node-4', new Set<ToolScene>(['legal']));
    rt.mergeStickyScenes('node-5', new Set<ToolScene>(['general'])); // 过滤后为空 → 不落表
    const raw = JSON.parse(readFileSync(join(dir, '.runtime', 'sticky-scenes.json'), 'utf-8')) as {
      version: number;
      scenes: Record<string, Record<string, number>>;
    };
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.scenes['node-4'])).toEqual(['legal']);
    expect(typeof raw.scenes['node-4'].legal).toBe('number');
    expect(raw.scenes['node-5']).toBeUndefined();
  });

  it('落盘文件损坏时不抛错，按空表降级', () => {
    mkdirSync(join(dir, '.runtime'), { recursive: true });
    writeFileSync(join(dir, '.runtime', 'sticky-scenes.json'), '{ not json', 'utf-8');
    const rt = new SessionRuntime();
    expect(() => rt.mergeStickyScenes('node-6', new Set<ToolScene>(['legal']))).not.toThrow();
    expect(rt.getStickyScenes('node-6')).toEqual(new Set<ToolScene>(['legal']));
  });

  it('丢弃落盘里的非法场景值（非字符串 / 空串 / team）', () => {
    mkdirSync(join(dir, '.runtime'), { recursive: true });
    writeFileSync(
      join(dir, '.runtime', 'sticky-scenes.json'),
      JSON.stringify({ version: 2, scenes: { 'node-7': { legal: Date.now(), team: Date.now(), '': Date.now(), bad: 'x' } } }),
      'utf-8',
    );
    const rt = new SessionRuntime();
    expect(rt.getStickyScenes('node-7')).toEqual(new Set<ToolScene>(['legal']));
  });

  it('v1 旧格式平滑迁移：数组按 updatedAt 打戳，未过 TTL 照常读回', () => {
    mkdirSync(join(dir, '.runtime'), { recursive: true });
    writeFileSync(
      join(dir, '.runtime', 'sticky-scenes.json'),
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), scenes: { 'node-8': ['legal', 'ocr'] } }),
      'utf-8',
    );
    const rt = new SessionRuntime();
    expect(rt.getStickyScenes('node-8')).toEqual(new Set<ToolScene>(['legal', 'ocr']));
  });

  it('TTL：场景超过 24h 未被重新命中 → 过期脱落', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const rt = new SessionRuntime();
    rt.mergeStickyScenes('node-9', new Set<ToolScene>(['legal', 'browser']));

    // 12h 后：仍在 TTL 内 → 读回，但不重新命中（不续命）
    vi.setSystemTime(new Date('2026-10-08T22:00:00Z'));
    const mid = new Set<ToolScene>();
    rt.mergeStickyScenes('node-9', mid);
    expect([...mid].sort()).toEqual(['browser', 'legal']);

    // 再 12h（距首次命中 24h+）→ 过期脱落
    vi.setSystemTime(new Date('2026-10-09T11:00:00Z'));
    const after = new Set<ToolScene>();
    rt.mergeStickyScenes('node-9', after);
    expect([...after]).toEqual([]);
    expect(rt.getStickyScenes('node-9')).toBeUndefined();
  });

  it('TTL：被本轮意图重新命中会续命', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const rt = new SessionRuntime();
    rt.mergeStickyScenes('node-10', new Set<ToolScene>(['legal']));

    // 20h 后再次被命中（本轮 activeScenes 里带上 legal）→ 时间戳刷新
    vi.setSystemTime(new Date('2026-10-09T06:00:00Z'));
    rt.mergeStickyScenes('node-10', new Set<ToolScene>(['legal']));

    // 再过 20h（距刷新只有 20h）→ 仍在
    vi.setSystemTime(new Date('2026-10-10T02:00:00Z'));
    const scenes = new Set<ToolScene>();
    rt.mergeStickyScenes('node-10', scenes);
    expect([...scenes]).toEqual(['legal']);
  });

  it('TTL：中途显式激活（addStickyScene）同样续命', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const rt = new SessionRuntime();
    rt.mergeStickyScenes('node-11', new Set<ToolScene>(['legal']));

    vi.setSystemTime(new Date('2026-10-09T05:00:00Z'));
    rt.addStickyScene('node-11', 'legal'); // search_capabilities 重新激活

    vi.setSystemTime(new Date('2026-10-10T01:00:00Z')); // 距激活 20h
    expect(rt.hasSticky('node-11', 'legal')).toBe(true);
  });

  it('每会话场景数上限：超出按最近激活淘汰', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const rt = new SessionRuntime();
    rt.mergeStickyScenes(
      'node-12',
      new Set<ToolScene>(['node', 'ledger', 'legal', 'ocr', 'office', 'admin']),
    );
    expect(rt.getStickyScenes('node-12')?.size).toBe(6);

    // 新命中两个 → 总数仍为 6，且新的两个必须在（时间最新）
    vi.setSystemTime(new Date('2026-10-08T11:00:00Z'));
    rt.mergeStickyScenes('node-12', new Set<ToolScene>(['design', 'audio']));
    const kept = rt.getStickyScenes('node-12')!;
    expect(kept.size).toBe(6);
    expect(kept.has('design')).toBe(true);
    expect(kept.has('audio')).toBe(true);
  });
});
