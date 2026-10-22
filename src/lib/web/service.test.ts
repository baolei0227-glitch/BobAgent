import { describe, expect, it, vi } from 'vitest';
import { WebService } from './service';
import { WebError, type WebFetchProvider, type WebSearchProvider } from './types';

/** 可控可用性的假 provider（不触网） */
function searchProvider(id: string, available: boolean): WebSearchProvider {
  return {
    id,
    isAvailable: vi.fn(async () => available),
    search: vi.fn(async () => ({ provider: id, sources: [] })),
  };
}

function fetchProvider(id: string, available: boolean): WebFetchProvider {
  return {
    id,
    isAvailable: vi.fn(async () => available),
    fetch: vi.fn(async () => ({
      provider: id,
      requestedUrl: 'https://example.com',
      finalUrl: 'https://example.com',
      statusCode: 200,
      title: '',
      markdown: '',
      truncated: false,
    })),
  };
}

function service(
  selection: { searchProvider?: string; fetchProvider?: string },
  search: WebSearchProvider[],
  fetch: WebFetchProvider[] = [],
): WebService {
  const s = new WebService({
    loadSelection: async () => selection,
    defaultSearchProvider: 'deepseek-search-api',
    defaultFetchProvider: 'deepseek-fetch-api',
  });
  for (const p of search) s.registerSearchProvider(p);
  for (const p of fetch) s.registerFetchProvider(p);
  return s;
}

describe('WebService provider 选择', () => {
  it('显式配置且可用：使用该 provider', async () => {
    const a = searchProvider('a', true);
    const b = searchProvider('b', true);
    const s = service({ searchProvider: 'b' }, [a, b]);
    const result = await s.search({ query: 'q' });
    expect(result.provider).toBe('b');
    expect(a.search).not.toHaveBeenCalled();
  });

  it('显式配置了未注册的 provider：CONFIGURED_MISSING', async () => {
    const s = service({ searchProvider: 'missing' }, [searchProvider('a', true)]);
    await expect(s.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    });
  });

  it('显式配置了但不可用：CONFIGURED_UNAVAILABLE', async () => {
    const s = service({ searchProvider: 'a' }, [searchProvider('a', false)]);
    await expect(s.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    });
  });

  it('未配置时使用默认 provider（deepseek-search-api）', async () => {
    const s = service({}, [searchProvider('deepseek-search-api', true), searchProvider('other', true)]);
    expect((await s.search({ query: 'q' })).provider).toBe('deepseek-search-api');
  });

  it('auto：默认 provider 不可用时回退到唯一可用 provider', async () => {
    const s = service({ searchProvider: 'auto' }, [searchProvider('deepseek-search-api', false), searchProvider('http-search', true)]);
    expect((await s.search({ query: 'q' })).provider).toBe('http-search');
  });

  it('auto：默认不可用且多个可用时明确 AMBIGUOUS，不猜', async () => {
    const s = service({ searchProvider: 'auto' }, [
      searchProvider('deepseek-search-api', false),
      searchProvider('a', true),
      searchProvider('b', true),
    ]);
    await expect(s.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_AMBIGUOUS' });
  });

  it('完全没有可用 provider：UNAVAILABLE', async () => {
    const s = service({ searchProvider: 'auto' }, [searchProvider('deepseek-search-api', false)]);
    await expect(s.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' });
  });

  it('搜索与抓取的 provider 选择互不影响', async () => {
    const s = service(
      { searchProvider: 'deepseek-search-api', fetchProvider: 'http' },
      [searchProvider('deepseek-search-api', true)],
      [fetchProvider('deepseek-fetch-api', true), fetchProvider('http', true)],
    );
    expect((await s.search({ query: 'q' })).provider).toBe('deepseek-search-api');
    expect((await s.fetch({ url: 'https://example.com' })).provider).toBe('http');
  });

  it('provider 抛出普通异常时归一为 WEB_PROVIDER_ERROR', async () => {
    const broken = searchProvider('deepseek-search-api', true);
    broken.search = vi.fn(async () => {
      throw new Error('boom');
    });
    const s = service({}, [broken]);
    await expect(s.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      provider: 'deepseek-search-api',
    });
  });

  it('WebError 原样透传（不二次包装）', async () => {
    const broken = searchProvider('deepseek-search-api', true);
    const original = new WebError('WEB_PROVIDER_CREDENTIAL_MISSING', 'no key');
    broken.search = vi.fn(async () => {
      throw original;
    });
    const s = service({}, [broken]);
    await expect(s.search({ query: 'q' })).rejects.toBe(original);
  });
});
