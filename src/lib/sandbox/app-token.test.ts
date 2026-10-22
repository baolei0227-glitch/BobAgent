/**
 * 身份令牌回归（2026-10-10）—— 关掉「自报 appId」这条绕过路径。
 *
 * 背景（实测复现过）：`_appId` 由页面脚本自己填，而 A5 的「导入包只读」判定、被 Revoke 的
 * 小程序能否调模型、审计归因全都基于它 —— 一个 imported 小程序只要把 `_appId` 填成任意
 * built 小程序的 id，就重新拿到 `run_command`，还能写别人的私有数据目录。
 *
 * 本组锁住：令牌签发/校验（有效期、签名、篡改）、身份解析（不一致 = 冒充信号）、
 * 以及「路由传 verifiedAppId 时，权威 appId 覆盖自报值」。
 */
import { createHmac } from 'crypto';
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  verifyAppTokenWithSecret,
  resolveAppIdentityWithSecret,
} from '@/lib/sandbox/app-token';

const SECRET = 'unit-test-secret';

/** 与 mintAppToken 同构的本地签发（避免测试依赖 settings 文件） */
function mint(appId: string, exp: number): string {
  const sig = createHmac('sha256', SECRET).update(`v1|${appId}|${exp}`).digest('base64url');
  return `v1.${appId}.${exp}.${sig}`;
}

describe('令牌签发与校验', () => {
  const future = Date.now() + 60_000;
  const past = Date.now() - 1_000;

  it('合法令牌解出 appId', () => {
    const r = verifyAppTokenWithSecret(mint('app_a_1', future), SECRET);
    expect(r.ok).toBe(true);
    expect(r.appId).toBe('app_a_1');
  });

  it('过期令牌拒绝', () => {
    const r = verifyAppTokenWithSecret(mint('app_a_1', past), SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('expired');
  });

  it('签名被篡改 / 换密钥 / 格式错误一律拒绝', () => {
    const good = mint('app_a_1', future);
    const parts = good.split('.');
    const tampered = `v1.app_b_1.${parts[2]}.${parts[3]}`; // 改 appId 但签名不变
    expect(verifyAppTokenWithSecret(tampered, SECRET).ok).toBe(false);
    expect(verifyAppTokenWithSecret(good, 'another-secret').ok).toBe(false);
    expect(verifyAppTokenWithSecret('', SECRET).ok).toBe(false);
    expect(verifyAppTokenWithSecret('v1.app_a_1', SECRET).ok).toBe(false);
    expect(verifyAppTokenWithSecret('v2.app_a_1.123.sig', SECRET).ok).toBe(false);
  });
});

describe('身份解析（自报值只作冒充信号）', () => {
  const future = Date.now() + 60_000;

  it('自报值与令牌一致 → 正常', () => {
    const r = resolveAppIdentityWithSecret({ token: mint('app_a_1', future), claimedAppId: 'app_a_1' }, SECRET);
    expect(r.appId).toBe('app_a_1');
    expect(r.mismatch).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('冒充别人的 appId → 权威值仍是令牌里的，且标记 mismatch', () => {
    const r = resolveAppIdentityWithSecret(
      { token: mint('app_imported_evil_1', future), claimedAppId: 'app_built_9' },
      SECRET,
    );
    expect(r.appId).toBe('app_imported_evil_1'); // ← 不是自报的 built
    expect(r.claimedAppId).toBe('app_built_9');
    expect(r.mismatch).toBe(true);
  });

  it('无令牌 / 令牌无效 → 无权威身份（路由据此 401）', () => {
    expect(resolveAppIdentityWithSecret({ claimedAppId: 'app_a_1' }, SECRET).appId).toBeUndefined();
    expect(resolveAppIdentityWithSecret({ token: 'bad', claimedAppId: 'app_a_1' }, SECRET).appId).toBeUndefined();
    expect(resolveAppIdentityWithSecret({ token: mint('app_a_1', Date.now() - 1) }, SECRET).error).toContain('expired');
  });
});

describe('handler 用权威 appId（冒充无法提权）', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'bobwork-token-'));
  const PREV = process.env.BOBWORK_HOME;

  /** 桥的首次 import 在测试环境是秒级成本：预热到 beforeAll，否则会算进 it() 的 5s 预算 */
  let bridge: typeof import('@/lib/sandbox/bridge');

  beforeAll(async () => {
    process.env.BOBWORK_HOME = ROOT;
    // built 小程序（自报目标）与 imported 小程序（真实调用者）
    for (const [id, origin] of [['app_built_9', 'built'], ['app_imported_evil_1', 'imported']] as const) {
      const dir = join(ROOT, 'bob-sandbox', 'apps', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, name: id, entry: 'index.html', origin, schemaVersion: 1 }), 'utf-8');
      writeFileSync(join(dir, 'index.html'), '<html></html>', 'utf-8');
    }
    bridge = await import('@/lib/sandbox/bridge');
  }, 60_000);

  it('imported 冒充 built：hostTool 仍按 imported 拒绝，appData 写进自己的目录', async () => {
    const { handleBridgeRequest } = bridge;
    const identity = { verifiedAppId: 'app_imported_evil_1', claimedAppId: 'app_built_9' };

    // 1) 全量工具：仍被 imported 分级挡住（未冒充成功）
    const tool = await handleBridgeRequest(
      'hostTool',
      { name: 'run_command', args: { cmd: 'echo pwned' }, _appId: 'app_built_9' },
      identity,
    ) as { success: boolean; result: string };
    expect(tool.success).toBe(false);
    expect(tool.result).toContain('BLOCKED');

    // 2) 私有数据：写进**真实调用者**的目录，而不是被冒充的 app
    await handleBridgeRequest(
      'saveAppData',
      { appId: 'app_built_9', key: 'injected', value: { by: 'imported' }, _appId: 'app_built_9' },
      identity,
    );
    const { existsSync } = await import('fs');
    expect(existsSync(join(ROOT, 'bob-sandbox', 'apps', 'app_imported_evil_1', 'data', 'injected.json'))).toBe(true);
    expect(existsSync(join(ROOT, 'bob-sandbox', 'apps', 'app_built_9', 'data', 'injected.json'))).toBe(false);
  });
});
