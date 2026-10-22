import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webToolDefs } from '@/app/api/chat/tools/web';

/**
 * web_search / web_fetch 切换 DeepSeek Search / Fetch 后的契约回归（2026-10-17）。
 *
 * 锁四件事：
 *   ① 端点与鉴权：baseUrl 不带 /v1 时补一次，带 /v1 时不重复拼；Bearer 用设置里的 DeepSeek Key；
 *   ② 搜索结果映射：标题/URL/摘要/站点/日期/权威性既要进模型文本，也要进 ai-card；
 *   ③ 错误映射：429 等 HTTP 错误返回可执行的中文提示，不抛异常；
 *   ④ 未配置 Key：明确提示去设置里配置，而不是静默降级到旧链路。
 */

const state: { providers: Array<{ type: string; apiKey: string; baseUrl?: string }> } = {
  providers: [{ type: 'deepseek', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }],
};

vi.mock('@/lib/settings-server', () => ({
  readSettingsFromFile: async () => state,
}));

// 计费流水：这里只断言「该记 / 不该记」，绝不写真实用量账本（.usage.db）
const usageMocks = vi.hoisted(() => ({
  recordWebToolUsage: vi.fn(async () => {}),
}));
vi.mock('@/lib/usage', () => ({
  recordWebToolUsage: usageMocks.recordWebToolUsage,
}));

const searchTool = webToolDefs.find((t) => t.name === 'web_search')!;
const fetchTool = webToolDefs.find((t) => t.name === 'web_fetch')!;

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  state.providers = [{ type: 'deepseek', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }];
  fetchMock.mockReset();
  usageMocks.recordWebToolUsage.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web_search → DeepSeek Search', () => {
  it('调用 /v1/tools/search，鉴权与请求体正确，结果同时进入文本与卡片', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        {
          title: '中华人民共和国民法典 第五百七十七条',
          url: 'https://www.court.gov.cn/zixun/xiangqing/123.html',
          snippet: '当事人一方不履行合同义务…',
          summary: '民法典第577条规定违约责任的基本形式，属于现行有效条文。',
          site_name: '最高人民法院',
          date: '2026-06-01T00:00:00+00:00',
          authority: 3,
        },
      ],
    }));

    const res = await searchTool.execute({ query: '民法典 第577条' });
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') throw new Error(res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://api.deepseek.com/v1/tools/search');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      query: '民法典 第577条',
      count: 5,
      need_content: false,
    });

    expect(res.text).toContain('https://www.court.gov.cn/zixun/xiangqing/123.html');
    expect(res.text).toContain('最高人民法院');
    expect(res.text).toContain('权威性 3/4');
    expect(res.text).toContain('2026-06-01');
    expect(res.cardHtml).toContain('ai-card');
    expect(res.cardHtml).toContain('权威 3');

    // 按次计费：成功搜索记一次（空结果不计，见下一条用例）
    expect(usageMocks.recordWebToolUsage).toHaveBeenCalledTimes(1);
    expect(usageMocks.recordWebToolUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'search', provider: 'deepseek-search-api' }),
    );
  });

  it('baseUrl 已带 /v1 时不重复拼 /v1', async () => {
    state.providers = [{ type: 'deepseek', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1/' }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

    const res = await searchTool.execute({ query: '测试' });
    expect(typeof res).toBe('string');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/tools/search');
    // 空结果（results: []）不计费
    expect(usageMocks.recordWebToolUsage).not.toHaveBeenCalled();
  });

  it('429 返回限速提示，不抛异常', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limit exceeded' } }, 429));

    const res = await searchTool.execute({ query: '测试' });
    expect(typeof res).toBe('string');
    expect(res).toContain('限速');
    expect(res).toContain('5 QPS');
  });

  it('未配置 DeepSeek Key 时返回可路由的 provider 不可用错误', async () => {
    state.providers = [];
    const res = await searchTool.execute({ query: '测试' });
    expect(typeof res).toBe('string');
    expect(res).toContain('WEB_PROVIDER_CONFIGURED_UNAVAILABLE');
    expect(res).toContain('deepseek-search-api');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('web_fetch → DeepSeek Fetch', () => {
  it('返回标题 + Markdown 正文', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ title: '测试文章', content: '# 正文\n\n第一段。' }));

    const res = await fetchTool.execute({ url: 'https://example.com/article' });
    expect(typeof res).toBe('string');
    expect(res).toContain('URL: https://example.com/article');
    expect(res).toContain('标题: 测试文章');
    expect(res).toContain('# 正文');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(usageMocks.recordWebToolUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'fetch', provider: 'deepseek-fetch-api' }),
    );
  });

  it('403 提示改用浏览器工具', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'blocked by policy' } }, 403));

    const res = await fetchTool.execute({ url: 'https://example.com/article' });
    expect(typeof res).toBe('string');
    expect(res).toContain('浏览器工具');
  });
});
