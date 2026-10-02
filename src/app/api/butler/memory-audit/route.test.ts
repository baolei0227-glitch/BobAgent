/**
 * 路由级回归：`GET /api/butler/memory-audit`（Memory 台「证据视图」的只读聚合）。
 *
 * 锁三条不变量：
 *   ① 空态是**安全输入**：无负样本/无额度/无预算/无产出的全新数据根 → 各段为空数组、不 500；
 *   ② 各段数据来自**既有落点**且聚合正确（负样本两类 / 询问额度 / 会话预算 / 规则产出引用 / 最近活动）；
 *   ③ 真源路径是**绝对路径**且指向既有四个落点（供用户自行备份）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录，且必须在**动态 import** 之前设置（storage 的模块级常量在 import 时求值）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NextResponse } from 'next/server';

let home = '';
let route: typeof import('./route');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-memory-audit-'));
  process.env.BOBWORK_HOME = home;
  route = await import('./route');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

interface AuditBody {
  success?: boolean;
  paths?: Record<string, string>;
  recent?: { kind: string; title: string; at: string }[];
  negative?: { blocked: unknown[]; grouped: { signal_mismatch: unknown[]; not_a_habit: unknown[] } };
  askQuota?: { objectType: string; used: number; limit: number }[];
  budget?: { threadId: string; asks: number; limit: number }[];
  productions?: { ruleId: string; ruleName: string; producedRef: string; at: string }[];
}

async function audit(): Promise<AuditBody> {
  const res: NextResponse = await route.GET();
  return (await res.json()) as AuditBody;
}

describe('GET /api/butler/memory-audit', () => {
  it('空态：各段为空、路径为绝对路径，不报错', async () => {
    const b = await audit();
    expect(b.success).toBe(true);
    expect(b.recent).toEqual([]);
    expect(b.negative?.blocked).toEqual([]);
    expect(b.negative?.grouped.signal_mismatch).toEqual([]);
    expect(b.negative?.grouped.not_a_habit).toEqual([]);
    expect(b.askQuota).toEqual([]);
    expect(b.budget).toEqual([]);
    expect(b.productions).toEqual([]);
    // 真源路径（绝对）+ 四个落点齐全
    expect(b.paths?.root.startsWith('/')).toBe(true);
    expect(b.paths?.preferences.endsWith('/butler/preferences.md')).toBe(true);
    expect(b.paths?.rules).toBe(join(home, 'butler', '.rules'));
    expect(b.paths?.skills).toBe(join(home, 'butler', '.skills'));
    expect(b.paths?.threads).toBe(join(home, 'butler', '.state', 'threads'));
  });

  it('有数据时聚合正确（负样本 / 额度 / 预算 / 产出 / 最近活动）', async () => {
    const { recordNegativeSample } = await import('@/lib/butler/rule-signals');
    const { consumeAsk } = await import('@/lib/butler/rule-nearmiss');
    const { createRule } = await import('@/lib/butler/rules');
    const { recordHit } = await import('@/lib/butler/rule-signals');
    const { addPreference } = await import('@/lib/core/preferences');

    // 负样本：一类拉黑（signal_mismatch）
    await recordNegativeSample('todo', 'todo', 'blocked', 'signal_mismatch');
    // 询问额度：问过一次（上限 2，见 NEAR_MISS_ASK_LIMIT）
    await consumeAsk('schedule');
    // 会话预算：手写落点（真源格式由 rule-exec 定义：{ asks }）
    mkdirSync(join(home, 'butler', '.state', 'rule-budget'), { recursive: true });
    writeFileSync(join(home, 'butler', '.state', 'rule-budget', 'b-1.json'), JSON.stringify({ asks: 1 }), 'utf-8');
    // 一条规则 + 一次带产出引用的命中
    const rule = await createRule({
      name: '每天提醒喝水',
      intentRaw: '每天九点提醒我喝水',
      steps: [{ kind: 'deterministic', text: '建待办', action: 'create_todo' }],
    });
    await recordHit(rule.id, 1, 'timer', 'evt-drink-water');
    // 一条用户记忆（最近活动）
    await addPreference('喜欢简洁回答', { type: '偏好习惯' });

    const b = await audit();
    expect(b.success).toBe(true);

    const tagged = (b.negative?.blocked ?? []) as { objectType: string; class: string }[];
    expect(tagged.some((e) => e.objectType === 'todo' && e.class === 'signal_mismatch')).toBe(true);
    expect(b.negative?.grouped.signal_mismatch.length).toBeGreaterThan(0);

    expect(b.askQuota?.find((q) => q.objectType === 'schedule')).toMatchObject({ used: 1, limit: 2 });
    expect(b.budget?.find((x) => x.threadId === 'b-1')).toMatchObject({ asks: 1, limit: 2 });

    expect(b.productions?.[0]).toMatchObject({ ruleId: rule.id, ruleName: '每天提醒喝水', producedRef: 'evt-drink-water' });

    const kinds = new Set((b.recent ?? []).map((r) => r.kind));
    expect(kinds.has('rule')).toBe(true);
    expect(kinds.has('memory')).toBe(true);
  });

  it('脏数据不阻断整体视图（坏 JSON 只让该段为空）', async () => {
    writeFileSync(join(home, 'butler', '.state', 'rule-budget', 'broken.json'), '{ not json', 'utf-8');
    const b = await audit();
    expect(b.success).toBe(true);
    // 坏文件被跳过，好文件仍在
    expect(b.budget?.some((x) => x.threadId === 'b-1')).toBe(true);
    expect(b.budget?.some((x) => x.threadId === 'broken')).toBe(false);
  });
});
