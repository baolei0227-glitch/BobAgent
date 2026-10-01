/**
 * 路由级集成：/api/butler/rules + /api/butler/preferences 的 ⑧ 否定式闸口。
 *
 * 与 rules.test.ts（原语级）互补——这里走**真实 handler 函数**，验证 HTTP 边界的
 * 校验、状态码语义（success/conflict/routed）与 JSON 形状，确保面板 fetch 的契约稳定。
 *
 * 隔离：BOBWORK_HOME 指向临时目录，且必须在**动态 import** 路由之前设置
 * （preferences.ts 的 APP_ROOT 在模块加载时求值）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';

let home = '';
let rulesRoute: typeof import('./route');
let prefsRoute: typeof import('../preferences/route');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-rules-http-'));
  process.env.BOBWORK_HOME = home;
  rulesRoute = await import('./route');
  prefsRoute = await import('../preferences/route');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** 构造带 JSON body 的 NextRequest */
function jsonReq(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function body(res: NextResponse): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const BASE = 'http://localhost/api/butler/rules';

describe('GET /api/butler/rules', () => {
  it('空规则集 → success / count 0 / rules []', async () => {
    const res = await rulesRoute.GET();
    const b = await body(res);
    expect(b.success).toBe(true);
    expect(b.count).toBe(0);
    expect(b.rules).toEqual([]);
  });
});

describe('POST /api/butler/rules', () => {
  it('缺 name → 拒绝', async () => {
    const b = await body(await rulesRoute.POST(jsonReq(BASE, 'POST', { intent_raw: 'x', steps: [{ kind: 'deterministic', text: 'y' }] })));
    expect(b.success).toBe(false);
    expect(b.error).toBe('name required');
  });

  it('缺 steps → 拒绝并给出格式提示', async () => {
    const b = await body(await rulesRoute.POST(jsonReq(BASE, 'POST', { name: 'R', intent_raw: 'x' })));
    expect(b.success).toBe(false);
    expect(String(b.error)).toContain('steps required');
  });

  it('steps 非法 kind → 拒绝', async () => {
    const b = await body(await rulesRoute.POST(jsonReq(BASE, 'POST', { name: 'R', intent_raw: 'x', steps: [{ kind: 'nope', text: 'y' }] })));
    expect(b.success).toBe(false);
  });

  it('scope=project 缺 scope_target → 拒绝', async () => {
    const b = await body(
      await rulesRoute.POST(jsonReq(BASE, 'POST', { name: 'R', intent_raw: 'x', scope: 'project', steps: [{ kind: 'deterministic', text: 'y' }] })),
    );
    expect(b.success).toBe(false);
  });

  it('确定性规则 → commitment 必做到 / kind rule / id 合白名单', async () => {
    const res = await rulesRoute.POST(
      jsonReq(BASE, 'POST', { name: 'No coriander', intent_raw: '不要放香菜', steps: [{ kind: 'deterministic', text: '不要放香菜' }] }),
    );
    const b = await body(res);
    expect(b.success).toBe(true);
    const rule = b.rule as Record<string, unknown>;
    expect(rule.id).toMatch(/^r-\d{8}-[0-9a-f]{4}$/);
    expect(rule.commitment).toBe('必做到');
    expect(rule.kind).toBe('rule');
    expect(rule.version).toBe(1);
  });

  it('含主体判断步 → kind flow / 会启动并尽力', async () => {
    const b = await body(
      await rulesRoute.POST(
        jsonReq(BASE, 'POST', {
          name: 'Morning triage',
          intent_raw: '每天早上分拣邮件',
          steps: [
            { kind: 'deterministic', text: '读完当天邮件' },
            { kind: 'judgment', text: '判断哪些需要回复' },
          ],
        }),
      ),
    );
    expect(b.success).toBe(true);
    const rule = b.rule as Record<string, unknown>;
    expect(rule.kind).toBe('flow');
    expect(rule.commitment).toBe('会启动并尽力');
  });
});

describe('PATCH /api/butler/rules 乐观锁与状态', () => {
  let id = '';

  beforeAll(async () => {
    const b = await body(
      await rulesRoute.POST(jsonReq(BASE, 'POST', { name: 'Tmp', intent_raw: '临时', steps: [{ kind: 'deterministic', text: '临时' }] })),
    );
    id = (b.rule as Record<string, unknown>).id as string;
  });

  it('缺 id → 拒绝', async () => {
    const b = await body(await rulesRoute.PATCH(jsonReq(BASE, 'PATCH', { name: 'x' })));
    expect(b.success).toBe(false);
    expect(b.error).toBe('id required');
  });

  it('无任何可更新字段 → 拒绝', async () => {
    const b = await body(await rulesRoute.PATCH(jsonReq(BASE, 'PATCH', { id })));
    expect(b.success).toBe(false);
    expect(b.error).toBe('nothing to update');
  });

  it('expected_version 不符 → conflict:true，盘上不变', async () => {
    const b = await body(await rulesRoute.PATCH(jsonReq(BASE, 'PATCH', { id, name: 'Changed', expected_version: 999 })));
    expect(b.success).toBe(false);
    expect(b.conflict).toBe(true);
    const list = await body(await rulesRoute.GET());
    const got = (list.rules as Array<Record<string, unknown>>).find((r) => r.id === id);
    expect(got?.name).toBe('Tmp');
  });

  it('版本正确 → 更新成功、version 自增', async () => {
    const b = await body(await rulesRoute.PATCH(jsonReq(BASE, 'PATCH', { id, name: 'Renamed', expected_version: 1 })));
    expect(b.success).toBe(true);
    expect((b.rule as Record<string, unknown>).version).toBe(2);
    expect((b.rule as Record<string, unknown>).name).toBe('Renamed');
  });

  it('status=paused → 落盘', async () => {
    const b = await body(await rulesRoute.PATCH(jsonReq(BASE, 'PATCH', { id, status: 'paused' })));
    expect(b.success).toBe(true);
    expect((b.rule as Record<string, unknown>).status).toBe('paused');
  });

  it('status 非法值 → 拒绝', async () => {
    const b = await body(await rulesRoute.PATCH(jsonReq(BASE, 'PATCH', { id, status: 'bogus' })));
    expect(b.success).toBe(false);
    expect(b.error).toBe('status invalid');
  });
});

describe('DELETE /api/butler/rules', () => {
  it('缺 id → 拒绝', async () => {
    const b = await body(await rulesRoute.DELETE(new NextRequest(BASE, { method: 'DELETE' })));
    expect(b.success).toBe(false);
    expect(String(b.error)).toContain('id required');
  });

  it('不存在的 id → 拒绝（not found）', async () => {
    const b = await body(await rulesRoute.DELETE(new NextRequest(`${BASE}?id=r-20260101-abcd`, { method: 'DELETE' })));
    expect(b.success).toBe(false);
    expect(String(b.error)).toContain('not found');
  });

  it('存在的 id → 删除成功', async () => {
    const created = await body(
      await rulesRoute.POST(jsonReq(BASE, 'POST', { name: 'Doomed', intent_raw: '待删', steps: [{ kind: 'deterministic', text: '待删' }] })),
    );
    const id = (created.rule as Record<string, unknown>).id as string;
    const b = await body(await rulesRoute.DELETE(new NextRequest(`${BASE}?id=${id}`, { method: 'DELETE' })));
    expect(b.success).toBe(true);
  });
});

describe('⑧ 偏好层 HTTP 闸口：否定式 → routed（不落偏好）', () => {
  const PREFS = 'http://localhost/api/butler/preferences';

  beforeAll(() => {
    mkdirSync(join(home, 'butler'), { recursive: true });
    writeFileSync(
      join(home, 'butler', 'preferences.md'),
      `# User Memory\n\n- 输出尽量简洁\n  type: 偏好习惯\n  created_at: 2026-09-28 10:00\n  source: chat\n`,
      'utf-8',
    );
  });

  it('GET 能读到 seed 条目', async () => {
    const b = await body(await prefsRoute.GET());
    expect(b.success).toBe(true);
    expect(b.count).toBe(1);
  });

  it('PATCH 否定式内容 → routed:true，且不写回', async () => {
    const b = await body(await prefsRoute.PATCH(jsonReq(PREFS, 'PATCH', { index: 1, content: '禁止写长段落' })));
    expect(b.success).toBe(false);
    expect(b.routed).toBe(true);
    const after = await body(await prefsRoute.GET());
    const contents = (after.preferences as Array<Record<string, unknown>>).map((p) => p.content);
    expect(contents).toContain('输出尽量简洁');
    expect(contents).not.toContain('禁止写长段落');
  });

  it('PATCH 普通内容 → 正常更新', async () => {
    const b = await body(await prefsRoute.PATCH(jsonReq(PREFS, 'PATCH', { index: 1, content: '输出保持简短' })));
    expect(b.success).toBe(true);
    const after = await body(await prefsRoute.GET());
    expect((after.preferences as Array<Record<string, unknown>>).map((p) => p.content)).toContain('输出保持简短');
  });
});