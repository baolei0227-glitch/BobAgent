/**
 * SessionRuntime sticky 场景回归测试
 *
 * 覆盖两件事：
 *   ① 原有语义不变：同会话聚合、'team' 永不 sticky、general/coding 不落表；
 *   ② 跨重启落盘（2026-10-02 新增）：新实例（模拟应用重启）能从磁盘读回同一批场景，
 *      损坏文件静默降级不抛错。
 *
 * 隔离方式：把 BOBWORK_HOME 指向临时目录（resolveAppRoot 运行时读取），
 * 落盘路径懒算，故每个用例内改环境变量即生效。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.BOBWORK_HOME;
    else process.env.BOBWORK_HOME = originalHome;
  });

  it('同会话聚合：场景一旦 sticky，后续请求读回（只增不减）', () => {
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

  it('落盘文件结构可读且不含空条目', () => {
    const rt = new SessionRuntime();
    rt.mergeStickyScenes('node-4', new Set<ToolScene>(['legal']));
    rt.mergeStickyScenes('node-5', new Set<ToolScene>(['general'])); // 过滤后为空 → 不落表
    const raw = JSON.parse(readFileSync(join(dir, '.runtime', 'sticky-scenes.json'), 'utf-8')) as {
      version: number;
      scenes: Record<string, string[]>;
    };
    expect(raw.version).toBe(1);
    expect(raw.scenes['node-4']).toEqual(['legal']);
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
      JSON.stringify({ version: 1, scenes: { 'node-7': ['legal', 'team', '', 42, null] } }),
      'utf-8',
    );
    const rt = new SessionRuntime();
    expect(rt.getStickyScenes('node-7')).toEqual(new Set<ToolScene>(['legal']));
  });
});
