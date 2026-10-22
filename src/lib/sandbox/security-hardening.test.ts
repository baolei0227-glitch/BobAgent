/**
 * 安全加固回归（2026-10-10 三轮）：设置出口脱敏/写回保护、DNS-rebind 身份复验、远程会话助手。
 * 全部纯函数，不碰磁盘。
 */
import { describe, expect, it } from 'vitest';
import { checkRequestSource } from '@/lib/http/loopback-guard';
import { expectedCookieValue, hasValidBearerAuth, hasValidSessionCookie, hasValidRemoteAuth } from '@/lib/http/remote-session';
import { SECRET_MASK, maskSettingsSecrets, preserveStoredSecrets } from '@/lib/settings-server';
import type { AppSettings } from '@/lib/settings';

const TOKEN = 'test-token-abc123';
const LOCAL = new Set(['100.64.0.5']);
const base = {
  host: 'localhost:8321',
  origin: '',
  secFetchSite: '',
  method: 'POST',
  remoteAccessEnabled: true,
  localAddrs: LOCAL,
  remoteToken: TOKEN,
  authorization: null as string | null,
  cookie: null as string | null,
};

describe('DNS-rebind 防护：非本机 Host 必须带有效凭据', () => {
  it('攻击者域名（解析到 127.0.0.1）没凭据 → 拒（即使 Origin === Host）', () => {
    const r = checkRequestSource({ ...base, host: 'evil.example', origin: 'http://evil.example' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('without valid remote credentials');
  });

  it('隧道域名带 Bearer → 放行', () => {
    const r = checkRequestSource({
      ...base,
      host: 'bob.example.com',
      origin: 'https://bob.example.com',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(r.ok).toBe(true);
  });

  it('隧道域名带会话 Cookie → 放行；带错 Cookie → 拒', () => {
    const good = { ...base, host: 'bob.example.com', origin: 'https://bob.example.com', cookie: `bw_remote=${expectedCookieValue(TOKEN)}` };
    expect(checkRequestSource(good).ok).toBe(true);
    expect(checkRequestSource({ ...good, cookie: 'bw_remote=deadbeef' }).ok).toBe(false);
  });

  it('本机桌面不要求 Token（与网关豁免一致）', () => {
    expect(checkRequestSource({ ...base, host: '127.0.0.1:8321', remoteToken: '' }).ok).toBe(true);
  });
});

describe('远程会话助手', () => {
  it('Bearer / Cookie 校验对错分明', () => {
    expect(hasValidBearerAuth(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(hasValidBearerAuth('Bearer nope', TOKEN)).toBe(false);
    expect(hasValidBearerAuth(null, TOKEN)).toBe(false);
    expect(hasValidSessionCookie(`bw_remote=${expectedCookieValue(TOKEN)}`, TOKEN)).toBe(true);
    expect(hasValidSessionCookie('other=1; bw_remote=bad', TOKEN)).toBe(false);
    expect(hasValidRemoteAuth({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
    expect(hasValidRemoteAuth({ cookie: `bw_remote=${expectedCookieValue(TOKEN)}` }, TOKEN)).toBe(true);
    expect(hasValidRemoteAuth({}, TOKEN)).toBe(false);
  });
});

describe('设置出口脱敏与写回保护', () => {
  const stored = {
    version: 1,
    providers: [
      { type: 'deepseek', name: 'DeepSeek', apiKey: 'sk-real-key', selectedModels: ['deepseek-chat'] },
      { type: 'glm', name: 'GLM', apiKey: '', selectedModels: [] },
    ],
    search: { provider: 'brave', apiKey: 'search-secret' },
    mcpServers: [{ id: 'github', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret', PLAIN: 'visible' } }],
    remoteAccess: { enabled: true, token: 'remote-secret' },
  } as unknown as AppSettings;

  it('GET 出口：所有密钥字段变掩码，非密钥字段不动', () => {
    const masked = maskSettingsSecrets(stored) as unknown as Record<string, never>;
    const p = (masked.providers as unknown as Array<Record<string, string>>)[0];
    expect(p.apiKey).toBe(SECRET_MASK);
    expect((masked.providers as unknown as Array<Record<string, string>>)[1].apiKey).toBe(''); // 本来就空
    expect((masked.search as unknown as Record<string, string>).apiKey).toBe(SECRET_MASK);
    const env = ((masked.mcpServers as unknown as Array<Record<string, unknown>>)[0].env) as Record<string, string>;
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(SECRET_MASK);
    expect(env.PLAIN).toBe(SECRET_MASK); // env 的值一律视为密钥
    expect((masked.remoteAccess as unknown as Record<string, string>).token).toBe(SECRET_MASK);
    expect((masked.providers as unknown as Array<Record<string, unknown>>)[0].selectedModels).toEqual(['deepseek-chat']);
  });

  it('PUT 写回：掩码/空值不覆盖磁盘上的真 Key，用户改的值生效', () => {
    const incoming = JSON.parse(JSON.stringify(stored)) as unknown as Record<string, never>;
    (incoming.providers as unknown as Array<Record<string, string>>)[0].apiKey = SECRET_MASK; // UI 原样回传掩码
    (incoming.providers as unknown as Array<Record<string, string>>)[1].apiKey = 'sk-new-key'; // 用户新填
    const merged = preserveStoredSecrets(incoming as unknown as AppSettings, stored) as unknown as Record<string, never>;
    const provs = merged.providers as unknown as Array<Record<string, string>>;
    expect(provs[0].apiKey).toBe('sk-real-key');
    expect(provs[1].apiKey).toBe('sk-new-key');
    expect((merged.remoteAccess as unknown as Record<string, string>).token).toBe('remote-secret');
  });
});
