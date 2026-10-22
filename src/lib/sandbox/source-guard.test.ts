/**
 * 来源闸 / 工具信任分级 / 截图脱敏 回归（2026-10-10 评估 A3、A5、B1、B2）。
 *
 * 全部只测纯函数与常量，不碰磁盘、不需要真实网络：
 *   - A3：checkRequestSource —— 跨站 Origin / cross-site / 非本机 Host 且未开远程访问 一律拒
 *   - A5：evaluateHostToolAccess —— built 全量；imported 只读且限自己目录；NEVER 名单两种来源都禁
 *   - B1：redactImagePayload —— base64/dataUrl 必须被替换（否则描述会被 maxOutput 截掉）
 *   - B2：TOOL_ERROR_PREFIXES —— 'Error from server' 必须被判失败（否则停滞保护失效）
 */
import { describe, expect, it } from 'vitest';
import { checkRequestSource, hostnameOf } from '@/lib/http/loopback-guard';
import {
  NEVER_BRIDGE_TOOLS,
  IMPORTED_ALLOWED_TOOLS,
  evaluateHostToolAccess,
} from '@/lib/sandbox/host-tools';
import { redactImagePayload, TOOL_ERROR_PREFIXES } from '@/app/api/chat/tools';

const LOCAL = new Set(['100.64.0.5', '192.168.7.93']);
const base = {
  host: 'localhost:8321',
  origin: '',
  secFetchSite: '',
  method: 'POST',
  remoteAccessEnabled: false,
  localAddrs: LOCAL,
};

describe('A3 来源闸 checkRequestSource', () => {
  it('hostnameOf 去端口、去方括号、忽略 null', () => {
    expect(hostnameOf('localhost:8321')).toBe('localhost');
    expect(hostnameOf('http://127.0.0.1:8321')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:8321')).toBe('::1');
    expect(hostnameOf('null')).toBe('');
  });

  it('本机来源放行（含 Tailscale 网卡地址）', () => {
    expect(checkRequestSource(base).ok).toBe(true);
    expect(checkRequestSource({ ...base, host: '100.64.0.5:8321', origin: 'http://100.64.0.5:8321' }).ok).toBe(true);
  });

  it('跨站 Origin 拒绝（普通 CSRF）', () => {
    const r = checkRequestSource({ ...base, origin: 'http://evil.example' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('untrusted origin');
  });

  it('Sec-Fetch-Site: cross-site 拒绝（含 GET）', () => {
    expect(checkRequestSource({ ...base, method: 'GET', secFetchSite: 'cross-site' }).ok).toBe(false);
  });

  it('只读预览页例外：GET cross-site 允许，写操作仍拒绝', () => {
    // 宿主 localhost 内嵌 127.0.0.1 预览页时浏览器判 cross-site；预览入口只读，CSP 限制回环嵌入。
    expect(checkRequestSource({ ...base, method: 'GET', secFetchSite: 'cross-site', allowCrossSiteRead: true }).ok).toBe(true);
    expect(checkRequestSource({ ...base, method: 'HEAD', secFetchSite: 'cross-site', allowCrossSiteRead: true }).ok).toBe(true);
    expect(checkRequestSource({ ...base, method: 'POST', secFetchSite: 'cross-site', allowCrossSiteRead: true }).ok).toBe(false);
    // 未声明例外的普通路由仍拒绝
    expect(checkRequestSource({ ...base, method: 'GET', secFetchSite: 'cross-site' }).ok).toBe(false);
  });

  it('非本机 Host 且未启用远程访问 → 拒绝（默认安装的局域网直打）', () => {
    // 非浏览器客户端（无 Origin）：由 Host 规则拦
    const noOrigin = checkRequestSource({ ...base, host: '10.9.9.9:8321' });
    expect(noOrigin.ok).toBe(false);
    expect(noOrigin.reason).toContain('non-local host');
    // 浏览器（带跨站 Origin）：由 Origin 规则拦
    const withOrigin = checkRequestSource({ ...base, host: '10.9.9.9:8321', origin: 'http://10.9.9.9:8321' });
    expect(withOrigin.ok).toBe(false);
    expect(withOrigin.reason).toContain('untrusted origin');
  });

  it('隧道域名：启用远程访问 + 有效凭据才放行，无凭据一律拒（DNS-rebind 封堵）', () => {
    const tunnel = {
      ...base,
      host: 'bob.example.com',
      origin: 'https://bob.example.com',
      remoteAccessEnabled: true,
      remoteToken: 'tok-1',
    };
    // 无凭据（rebind 攻击者的处境）→ 拒
    expect(checkRequestSource(tunnel).ok).toBe(false);
    // 带 Bearer（手机/Expo 壳）→ 放行
    expect(checkRequestSource({ ...tunnel, authorization: 'Bearer tok-1' }).ok).toBe(true);
    // 凭据错误 → 拒
    expect(checkRequestSource({ ...tunnel, authorization: 'Bearer wrong' }).ok).toBe(false);
  });

  it('写操作不允许 Origin: null', () => {
    expect(checkRequestSource({ ...base, origin: 'null' }).ok).toBe(false);
    expect(checkRequestSource({ ...base, method: 'GET', origin: 'null' }).ok).toBe(true);
  });
});

describe('A5 工具信任分级 evaluateHostToolAccess', () => {
  const imported = { origin: 'imported' as const, appId: 'app_imp_1', args: {} };
  const built = { origin: 'built' as const, appId: 'app_built_1', args: {} };

  it('NEVER 名单两种来源都禁（含 team_run / 改宿主配置）', () => {
    for (const name of NEVER_BRIDGE_TOOLS) {
      expect(evaluateHostToolAccess({ ...built, name, args: {} }).allowed, name).toBe(false);
      expect(evaluateHostToolAccess({ ...imported, name }).allowed, name).toBe(false);
    }
  });

  it('built：只读/写文件/跑命令都允许', () => {
    for (const name of ['read_file', 'write_file', 'run_command', 'execute_script', 'list_directory']) {
      expect(evaluateHostToolAccess({ ...built, name, args: { path: 'homework/a.md' } }).allowed, name).toBe(true);
    }
  });

  it('imported：只允许只读三件套，且路径必须在自己目录内', () => {
    expect(evaluateHostToolAccess({ ...imported, name: 'read_file', args: { path: 'bob-sandbox/apps/app_imp_1/index.html' } }).allowed).toBe(true);
    // 目录本身（不带尾斜杠）也放行
    expect(evaluateHostToolAccess({ ...imported, name: 'list_directory', args: { path: 'bob-sandbox/apps/app_imp_1' } }).allowed).toBe(true);
    // 别的目录 / 项目文件 / 家目录：拒
    for (const p of ['bob-sandbox/apps/app_other_1/index.html', 'homework/x.md', '.settings.json', '/etc/passwd']) {
      expect(evaluateHostToolAccess({ ...imported, name: 'read_file', args: { path: p } }).allowed, p).toBe(false);
    }
    // 写/跑命令：一律拒
    for (const name of ['write_file', 'run_command', 'execute_script', 'edit_code', 'delete_file']) {
      expect(evaluateHostToolAccess({ ...imported, name, args: { path: 'bob-sandbox/apps/app_imp_1/x' } }).allowed, name).toBe(false);
    }
    // 只读但没给路径：拒
    expect(evaluateHostToolAccess({ ...imported, name: 'read_file', args: {} }).allowed).toBe(false);
    expect(IMPORTED_ALLOWED_TOOLS).toHaveLength(3);
  });

  it('sandbox_rollback/export 只能指向自己', () => {
    expect(evaluateHostToolAccess({ ...built, name: 'sandbox_rollback', args: { appId: 'app_other_1', file: 'index.html' } }).allowed).toBe(false);
    expect(evaluateHostToolAccess({ ...built, name: 'sandbox_rollback', args: { appId: 'app_built_1', file: 'index.html' } }).allowed).toBe(true);
  });
});

describe('B1 截图 payload 脱敏', () => {
  it('pngBase64 / dataUrl 被替换为占位标记（描述才不会被截断吃掉）', () => {
    const raw = JSON.stringify({ url: 'http://localhost:8321/', pngBase64: 'A'.repeat(50_000), ok: true });
    const out = redactImagePayload(raw);
    expect(out).not.toContain('A'.repeat(100));
    expect(out).toContain('omitted — saved to disk');
    expect(out.length).toBeLessThan(500);
    const browser = JSON.stringify({ dataUrl: `data:image/png;base64,${'B'.repeat(50_000)}` });
    expect(redactImagePayload(browser)).toContain('omitted — translated by vision model');
  });
});

describe('B2 工具失败前缀', () => {
  it("'Error from server' 被判失败（MCP 报错不再算有进展）", () => {
    const isError = (r: string) => TOOL_ERROR_PREFIXES.some((p) => r.startsWith(p));
    expect(isError('Error from server: chrome not found')).toBe(true);
    expect(isError('Error: boom')).toBe(true);
    expect(isError('BLOCKED: nope')).toBe(true);
    expect(isError('{"ok":true}')).toBe(false);
  });
});

describe('① 同源隔离：预览 origin 策略与 URL 交换', () => {
  it('预览 origin 上禁宿主高危 API，放行小程序自己的通道', async () => {
    const { decidePreviewHostRequest } = await import('@/lib/http/preview-host');
    const at = (pathname: string, accept?: string) =>
      decidePreviewHostRequest({ host: '127.0.0.1:8321', pathname, accept, port: '8321' });

    for (const p of ['/api/settings', '/api/local-files/list', '/api/chat', '/api/bobby', '/api/mcp/store', '/api/skills/install']) {
      expect(at(p).action, p).toBe('deny');
    }
    // 小程序通道与系统日历订阅不受影响
    expect(at('/api/sandbox/preview/app_x_1').action).toBe('allow');
    expect(at('/api/sandbox/bridge').action).toBe('allow');
    expect(at('/api/dav/calendars/x').action).toBe('allow');
    // UI 的 HTML 导航 → 302 回 localhost（自愈）
    const ui = at('/', 'text/html,application/xhtml+xml');
    expect(ui.action).toBe('redirect');
    expect(ui.location).toBe('http://localhost:8321/');
    // 宿主 UI origin（localhost）完全不受策略影响
    const onHost = (pathname: string) => decidePreviewHostRequest({ host: 'localhost:8321', pathname, accept: 'text/html' });
    expect(onHost('/api/settings').action).toBe('allow');
    expect(onHost('/').action).toBe('allow');
  });

  it('CalDAV：预览 origin 只读，写方法 403；宿主 origin 与逃生开关不受影响', async () => {
    const { decideDavOnPreviewHost } = await import('@/lib/http/preview-host');
    const at = (host: string, method: string, allowWrite = false) => decideDavOnPreviewHost({ host, method, allowWrite });

    // 预览 origin：读放行
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT']) {
      expect(at('127.0.0.1:8321', m).action, m).toBe('allow');
    }
    // 预览 origin：写一律拒绝，且文案给出"改用 localhost 重新订阅"的出路
    for (const m of ['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY', 'LOCK', 'POST', 'PATCH']) {
      const d = at('127.0.0.1:8321', m);
      expect(d.action, m).toBe('deny');
      expect(d.message).toContain('localhost');
    }
    // 宿主 origin（localhost）：双向同步照旧
    expect(at('localhost:8321', 'PUT').action).toBe('allow');
    // 逃生开关
    expect(at('127.0.0.1:8321', 'PUT', true).action).toBe('allow');
  });

  it('预览 URL 与宿主 UI 永远不同 origin', async () => {
    const { previewOriginFor } = await import('@/lib/sandbox/open-preview');
    expect(previewOriginFor('http://localhost:8321')).toBe('http://127.0.0.1:8321');
    expect(previewOriginFor('http://127.0.0.1:8321')).toBe('http://localhost:8321');
    expect(previewOriginFor('http://[::1]:8321')).toBe('http://localhost:8321');
    // 非回环主机保持原样（Tailscale / 隧道域名没有可用的一对主机名）
    expect(previewOriginFor('http://100.64.0.5:8321')).toBe('http://100.64.0.5:8321');
    expect(previewOriginFor('https://bob.example.com')).toBe('https://bob.example.com');
    expect(previewOriginFor('not-a-url')).toBe('not-a-url');
  });
});
