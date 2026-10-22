/**
 * 「放开小程序权限」回归（2026-10-10）。
 *
 * 背景：此前小程序每次调用模型都被问一次，且有 203 次 BobStorage 磁盘读写被判非法参数。
 * 本组锁住三件事：
 *   1) 完全信任（默认开）下权限解析：无显式表项 = 全权；显式 none（商城 Revoke）优先；
 *   2) 桥客户端脚本：完全信任下不再出现 window.confirm，且提供 host / listHostTools；
 *   3) 服务端 schema 接受客户端**自动注入**的 _appId（历史 loadAppData/saveAppData 全量失败回归）；
 *   4) chatRequestPermission 真的有实现（不再 "Unknown action"）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_SANDBOX_FULL_TRUST,
  isSandboxFullTrust,
  resolveSandboxChatPermission,
  resolveSandboxGraphPermission,
} from '@/lib/settings';
import { buildBridgeClientScript, handleBridgeRequest } from '@/lib/sandbox/bridge';

describe('完全信任开关 —— 默认放开、显式否决优先', () => {
  it('默认完全信任（undefined = 放开）', () => {
    expect(DEFAULT_SANDBOX_FULL_TRUST).toBe(true);
    expect(isSandboxFullTrust({})).toBe(true);
    expect(isSandboxFullTrust({ sandboxFullTrust: undefined })).toBe(true);
  });

  it('显式 false 回到逐项授权', () => {
    expect(isSandboxFullTrust({ sandboxFullTrust: false })).toBe(false);
    expect(resolveSandboxChatPermission({ sandboxFullTrust: false }, 'app_a')).toBe('none');
    expect(resolveSandboxGraphPermission({ sandboxFullTrust: false }, 'app_a')).toBe('none');
  });

  it('完全信任下无表项 = permanent / control', () => {
    expect(resolveSandboxChatPermission({}, 'app_a')).toBe('permanent');
    expect(resolveSandboxGraphPermission({}, 'app_a')).toBe('control');
  });

  it('显式 none（商城 Revoke）压过完全信任', () => {
    const settings = {
      sandboxFullTrust: true,
      sandboxChatPermissions: { app_a: 'none' as const },
      sandboxGraphPermissions: { app_a: 'none' as const },
    };
    expect(resolveSandboxChatPermission(settings, 'app_a')).toBe('none');
    expect(resolveSandboxGraphPermission(settings, 'app_a')).toBe('none');
    // 其他小程序不受影响
    expect(resolveSandboxChatPermission(settings, 'app_b')).toBe('permanent');
  });

  it('显式表项（per_call / read）照常生效', () => {
    const settings = {
      sandboxChatPermissions: { app_a: 'per_call' as const },
      sandboxGraphPermissions: { app_a: 'read' as const },
    };
    expect(resolveSandboxChatPermission(settings, 'app_a')).toBe('per_call');
    expect(resolveSandboxGraphPermission(settings, 'app_a')).toBe('read');
  });
});

describe('桥客户端脚本 —— 完全信任不再确认、提供宿主全能力入口', () => {
  it('完全信任：不再有 window.confirm 前置闸，且带 FULL_TRUST 标记', () => {
    const script = buildBridgeClientScript('app_x', { fullTrust: true });
    expect(script).toContain('var FULL_TRUST = true;');
    expect(script).toContain('!FULL_TRUST && MANUAL_CONFIRM_ACTIONS');
    expect(script).toContain('HOST_TOOL_TIMEOUT');
  });

  it('关闭完全信任：恢复人工确认闸', () => {
    const script = buildBridgeClientScript('app_x', { fullTrust: false });
    expect(script).toContain('var FULL_TRUST = false;');
  });

  it('暴露 BobWork.host / listHostTools（宿主全能力直通）', () => {
    const script = buildBridgeClientScript('app_x', { fullTrust: true });
    expect(script).toContain("request('hostTool'");
    expect(script).toContain("request('listHostTools'");
    expect(script).toContain('host: function(name, args)');
  });
});

describe('桥服务端 —— 放开后的行为闭环', () => {
  beforeAll(() => {
    // 隔离：桥的磁盘写入（appData / audit.log）全部落临时根
    const root = mkdtempSync(join(tmpdir(), 'bobwork-fulltrust-'));
    process.env.BOBWORK_HOME = root;
    // 2026-10-10 新增「小程序存在性闸」：桥调用必须来自真实存在的小程序
    const appDir = join(root, 'bob-sandbox', 'apps', 'app_regression');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'manifest.json'),
      JSON.stringify({ id: 'app_regression', name: 'Regression', description: '', createdAt: '', updatedAt: '', entry: 'index.html' }),
      'utf-8',
    );
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><html></html>', 'utf-8');
  });

  it('chatRequestPermission 已实现：完全信任默认返回 granted:true（不再 Unknown action）', async () => {
    const res = await handleBridgeRequest('chatRequestPermission', { _appId: 'app_regression' }) as {
      granted: boolean;
      level: string;
    };
    expect(res.granted).toBe(true);
    expect(res.level).toBe('permanent');
  });

  it('appData 四个动作接受自动注入的 _appId（历史 Unrecognized key 回归）', async () => {
    const appId = 'app_regression';
    await expect(
      handleBridgeRequest('saveAppData', { appId, key: 'k', value: { v: 1 }, _appId: appId }),
    ).resolves.toBeTruthy();
    await expect(
      handleBridgeRequest('loadAppData', { appId, key: 'k', _appId: appId }),
    ).resolves.toEqual({ v: 1 });
    await expect(
      handleBridgeRequest('listAppDataKeys', { appId, _appId: appId }),
    ).resolves.toEqual(['k']);
    await expect(
      handleBridgeRequest('deleteAppData', { appId, key: 'k', _appId: appId }),
    ).resolves.toEqual({ ok: true, deleted: true });
  });
});
