import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() =>
  vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
);
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { assertPublicUrl, httpFetchProvider, isPublicIp } from './http-fetch';

const fetchMock = vi.fn();

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTTP fetch provider —— 公网地址防护', () => {
  it.each([
    ['8.8.8.8', true],
    ['93.184.216.34', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.10', false],
    ['169.254.1.1', false],
    ['100.64.0.1', false],
    ['::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['2001:db8::1', false],
    ['2001:4860:4860::8888', true],
    ['::ffff:127.0.0.1', false],
  ])('isPublicIp(%s) = %s', (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });

  it('拒绝 localhost / 私网 / 内嵌凭据 / 非 http(s)', async () => {
    await expect(assertPublicUrl('http://localhost/')).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' });
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' });
    await expect(assertPublicUrl('http://10.0.0.1/')).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' });
    await expect(assertPublicUrl('http://[::1]/')).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' });
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'WEB_INVALID_URL' });
    await expect(assertPublicUrl('https://user:pass@example.com/')).rejects.toMatchObject({ code: 'WEB_INVALID_URL' });
  });

  it('DNS 解析到私网地址时拒绝', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '192.168.1.10', family: 4 }]);
    await expect(assertPublicUrl('https://example.com/')).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' });
  });

  it('公网域名解析通过', async () => {
    const url = await assertPublicUrl('https://example.com/path?q=1');
    expect(url.hostname).toBe('example.com');
  });
});

describe('HTTP fetch provider —— 抓取与转换', () => {
  it('HTML 转 Markdown，保留标题与正文', async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse('<html><head><title>测试标题</title></head><body><article><h1>Hello</h1><p>World</p></article></body></html>'),
    );

    const result = await httpFetchProvider.fetch({ url: 'https://example.com/article' });
    expect(result.provider).toBe('http');
    expect(result.statusCode).toBe(200);
    expect(result.title).toBe('测试标题');
    expect(result.markdown).toContain('# Hello');
    expect(result.markdown).toContain('World');
  });

  it('拒绝跳转到私网地址', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
    );

    await expect(httpFetchProvider.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({
      code: 'WEB_BLOCKED_URL',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('不支持的内容类型直接拒绝', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('binary', { status: 200, headers: { 'content-type': 'image/png' } }),
    );

    await expect(httpFetchProvider.fetch({ url: 'https://example.com/a.png' })).rejects.toMatchObject({
      code: 'WEB_UNSUPPORTED_CONTENT_TYPE',
    });
  });

  it('超过响应大小上限时拒绝', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('small', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '6000000' },
      }),
    );

    await expect(httpFetchProvider.fetch({ url: 'https://example.com/big' })).rejects.toMatchObject({
      code: 'WEB_FETCH_TOO_LARGE',
    });
  });

  it('非 2xx 作为结果返回（页面状态属于数据）', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    const result = await httpFetchProvider.fetch({ url: 'https://example.com/missing' });
    expect(result.statusCode).toBe(404);
    expect(result.markdown).toContain('not found');
  });
});
