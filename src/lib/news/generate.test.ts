/**
 * Daily News —— 采集三级降级单测（全部走 mock，不触外部网络）
 *
 * 覆盖「RSS → 权威站定向检索（site:）→ 裸关键词搜索」顺序，以及两个真实失败模式：
 *   ① 有 RSS 结果时不得再触发搜索 —— 顺序颠倒会让权威站白名单污染原本正常的链路；
 *   ② 无权威站 / 权威站全空时必须落到裸关键词搜索 —— **白名单过滤过头会让整条链路空转**。
 * 第二个用例是**负对照**：没有它，上面两条断言在「恒返回空」的实现下也会平凡为真。
 *
 * 2026-10-17 成本优化后额外锁两件事：
 *   ③ 多个 `site:` 合并进同一次 Search（受 128 字符 query 上限约束），不能再退化成「每站一次」；
 *   ④ 正文由 Search 的 `need_content` 一并返回，不再逐条 Fetch。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewsTopic } from './types';

const state = vi.hoisted(() => ({
  rssHits: [] as Array<{ title: string; url: string; snippet: string }>,
  siteHits: [] as Array<{ title: string; url: string; snippet: string; content?: string }>,
  bareHits: [] as Array<{ title: string; url: string; snippet: string; content?: string }>,
  searchCalls: [] as string[],
}));

vi.mock('./feed', () => ({
  searchNewsRss: vi.fn(async () => ({ hits: state.rssHits, errors: [] })),
}));

vi.mock('@/lib/web', () => ({
  webService: {
    search: vi.fn(async (request: { query: string }) => {
      state.searchCalls.push(request.query);
      // 按查询形态分流：带 site: 的算第二级，其余算第三级
      const isSiteQuery = request.query.includes('site:');
      const hits = isSiteQuery ? state.siteHits : state.bareHits;
      return {
        provider: 'deepseek-search-api',
        sources: hits.map((h) => ({
          title: h.title,
          url: h.url,
          snippet: h.snippet,
          summary: '',
          content: h.content || '',
          siteName: null,
          publishedAt: null,
          authority: -1,
        })),
      };
    }),
  },
}));

// 采集函数不触达下列模块；空实现仅用于切断 import 链（避免测试拉入 fs / 模型依赖）
vi.mock('@/lib/core/task-model', () => ({ resolveTaskModel: vi.fn(async () => null) }));
vi.mock('@/lib/core/preferences', () => ({ listPreferences: vi.fn(async () => []) }));
vi.mock('@/lib/butler/storage', () => ({ dateStamp: vi.fn(() => '2026-10-11') }));
vi.mock('./store', () => ({
  readNewsBriefing: vi.fn(async () => null),
  readNewsConfig: vi.fn(async () => ({ topics: [], updatedAt: '' })),
  writeNewsBriefing: vi.fn(async () => undefined),
}));

import { chunkSiteQueries, collectTopicHits } from './generate';

const hit = (n: string, host: string, content = '') => ({
  title: `t${n}`,
  url: `https://${host}/${n}`,
  snippet: `s${n}`,
  content,
});

const tech: NewsTopic = { id: 'tech', label: 'Tech', query: '科技', limit: 4, lang: 'zh' };
const legal: NewsTopic = { id: 'legal', label: 'Legal', query: '法规', limit: 4, lang: 'zh' };

beforeEach(() => {
  state.rssHits = [];
  state.siteHits = [];
  state.bareHits = [];
  state.searchCalls = [];
});

describe('collectTopicHits —— 三级降级', () => {
  it('第一级：RSS 有结果即返回，不触发任何搜索', async () => {
    state.rssHits = [hit('a', 'ifanr.com')];
    state.siteHits = [hit('b', '36kr.com')]; // 故意也放结果：若顺序颠倒，返回的会是它
    const hits = await collectTopicHits({ ...tech, feeds: ['https://ifanr.com/feed'] });
    expect(hits.map((h) => h.url)).toEqual(['https://ifanr.com/a']);
    expect(state.searchCalls).toEqual([]);
  });

  it('第二级：RSS 无结果时走权威站定向检索，4 个法律站合并成 1 次请求', async () => {
    state.siteHits = [hit('b', 'court.gov.cn')];
    const hits = await collectTopicHits(legal); // legal 无内置 feeds，但内置 sites 非空
    expect(hits).toHaveLength(1);
    expect(state.searchCalls).toHaveLength(1);
    expect(state.searchCalls[0]).toContain('site:court.gov.cn');
    expect(state.searchCalls[0]).toContain('site:legaldaily.com.cn');
  });

  it('第三级：权威站无结果时回退裸关键词搜索（兜底不得塌）', async () => {
    state.bareHits = [hit('c', 'random.com')];
    const hits = await collectTopicHits(legal);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://random.com/c');
    expect(state.searchCalls.some((q) => q.includes('site:'))).toBe(true); // 先走过第二级
    expect(state.searchCalls).toContain('法规'); // 再落到裸 query
  });

  it('负对照：无权威站时跳过第二级，直接裸搜索（白名单为空不得空转）', async () => {
    state.bareHits = [hit('d', 'somewhere.com')];
    const hits = await collectTopicHits({ id: 'no-such-topic', label: 'X', query: 'q', limit: 4, lang: 'zh' });
    expect(state.searchCalls).toEqual(['q']); // 没有产生任何 site: 查询
    expect(hits).toHaveLength(1);
  });

  it('正文由 Search 一并带回（不再逐条 Fetch）', async () => {
    state.bareHits = [hit('e', 'somewhere.com', '正文内容')];
    const hits = await collectTopicHits({ id: 'no-such-topic', label: 'X', query: 'q', limit: 4, lang: 'zh' });
    expect(hits[0].body).toBe('正文内容');
  });
});

describe('chunkSiteQueries —— 站点合并控制检索成本', () => {
  it('4 个法律站合成 1 次检索，query ≤ 120 字符且覆盖全部站点', () => {
    const sites = ['court.gov.cn', 'spp.gov.cn', 'moj.gov.cn', 'legaldaily.com.cn'];
    const queries = chunkSiteQueries(sites, '法规');
    expect(queries).toHaveLength(1);
    expect(queries[0].length).toBeLessThanOrEqual(120);
    for (const site of sites) expect(queries[0]).toContain(`site:${site}`);
  });

  it('6 个常见科技域名合成 1 次检索（长度上限内）', () => {
    const sites = ['36kr.com', 'ifanr.com', 'ithome.com', 'sspai.com', 'jiqizhixin.com', 'qbitai.com'];
    const queries = chunkSiteQueries(sites, '科技新闻');
    expect(queries).toHaveLength(1);
    expect(queries[0].length).toBeLessThanOrEqual(120);
    for (const site of sites) expect(queries[0]).toContain(`site:${site}`);
  });

  it('超长域名组合按 120 字符上限拆块，且覆盖全部站点', () => {
    const sites = ['legaldaily.com.cn', 'court.gov.cn', 'spp.gov.cn', 'moj.gov.cn', 'chinacourt.org', 'pkulaw.com'];
    const queries = chunkSiteQueries(sites, '法规');
    expect(queries.length).toBeGreaterThan(1);
    for (const q of queries) expect(q.length).toBeLessThanOrEqual(120);
    const joined = queries.join(' ');
    for (const site of sites) expect(joined).toContain(`site:${site}`);
  });
});
