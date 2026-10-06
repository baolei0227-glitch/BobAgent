/**
 * 路由级回归：`POST /api/butler/preferences`（用户**手写**一条记忆）。
 *
 * 背景（2026-10-02）：此前记忆的**唯一写入者是模型**（`remember_preference`），
 * 面板只有改/删 —— 用户想「记住这个」没有任何兜底。新增 POST 后，两条路径**共用同一套闸**，
 * 本组锁住「四种不落盘的原因都要如实回执」：
 *   ① 正常新增 → added:true，且 source 记 `panel`（与模型抽取的 chat[:<threadId>] 区分）；
 *   ② 敏感信息 → reason:'sensitive'，**不落盘**；
 *   ③ 否定式表达 → reason:'negation'，且**真的转成了一条规则**（偏好层不得承载承诺）；
 *   ④ 精确重复 / 同类型高相似 → reason:'duplicate' / 'conflict'（后者带回既有序号供「改成更新」）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录，且必须在动态 import 路由之前设置。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

let home = '';
let route: typeof import('./route');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-prefs-post-'));
  process.env.BOBWORK_HOME = home;
  route = await import('./route');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/butler/preferences', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

interface PostBody {
  success?: boolean;
  added?: boolean;
  count?: number;
  reason?: string;
  duplicate?: string;
  conflict?: { index: number; content: string; score: number };
  ruleId?: string;
  commitment?: string;
}

async function create(body: unknown): Promise<PostBody> {
  const res: NextResponse = await route.POST(post(body));
  return (await res.json()) as PostBody;
}

async function list(): Promise<{ count: number; preferences: { content: string; type: string; source: string }[] }> {
  const res: NextResponse = await route.GET();
  return (await res.json()) as {
    count: number;
    preferences: { content: string; type: string; source: string }[];
  };
}

describe('POST /api/butler/preferences —— 手写记忆', () => {
  it('正常新增：落盘并记 source=panel（与模型抽取区分）', async () => {
    const d = await create({ content: '习惯用表格输出结论', type: '偏好习惯' });
    expect(d.success).toBe(true);
    expect(d.added).toBe(true);
    expect(d.count).toBe(1);

    const all = await list();
    expect(all.count).toBe(1);
    expect(all.preferences[0]).toMatchObject({ content: '习惯用表格输出结论', type: '偏好习惯', source: 'panel' });
  });

  it('敏感信息：拒写、明说原因，且不落盘', async () => {
    const before = (await list()).count;
    const d = await create({ content: '我的密码是 hunter2', type: '事实经历' });
    expect(d.success).toBe(true);
    expect(d.added).toBe(false);
    expect(d.reason).toBe('sensitive');
    expect((await list()).count).toBe(before); // 闸真的拦住了
  });

  it('否定式表达：不写偏好，**转成一条规则**（硬约束归规则层）', async () => {
    const before = (await list()).count;
    const d = await create({ content: '回复里不要用感叹号' });
    expect(d.success).toBe(true);
    expect(d.added).toBe(false);
    expect(d.reason).toBe('negation');
    expect(typeof d.ruleId).toBe('string');
    expect(d.commitment).toBeTruthy();
    expect((await list()).count).toBe(before); // 偏好层没多条目

    // 规则层确实多了一条（同一把闸的另一半）
    const { listRules } = await import('@/lib/butler/rules');
    const rules = await listRules();
    expect(rules.some((r) => r.id === d.ruleId)).toBe(true);
  });

  it('精确重复 → duplicate；同类型高相似 → conflict（带回既有序号）', async () => {
    expect((await create({ content: '习惯用表格输出结论', type: '偏好习惯' })).reason).toBe('duplicate');
    const c = await create({ content: '习惯用表格输出结论啊', type: '偏好习惯' });
    expect(c.reason).toBe('conflict');
    expect(c.conflict?.index).toBe(1);
    expect(c.conflict?.content).toBe('习惯用表格输出结论');
  });

  it('缺内容 → 400 语义（success:false），不抛错', async () => {
    const d = await create({ type: '偏好习惯' });
    expect(d.success).toBe(false);
    expect(d.added).toBeUndefined();
  });
});
