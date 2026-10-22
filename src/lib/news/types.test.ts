/**
 * Daily News —— 配置归一化单测（纯函数，无 I/O）
 *
 * 覆盖容错读盘 / 接口入参的关键口径：非法项丢弃、条数夹取、id 稳定与去重、
 * 语言推断、空配置回退默认预设。落盘与采集不在此测（依赖 fs / 外部网络）。
 */
import { describe, expect, it } from 'vitest';
import {
  CURATED_TOPIC_SITES,
  DEFAULT_NEWS_TOPICS,
  NEWS_TOPIC_LIMIT_MAX,
  NEWS_TOPIC_LIMIT_MIN,
  NEWS_TOPIC_SOFT_MAX,
  normalizeNewsConfig,
  sitesForTopic,
  slugifyTopic,
} from './types';

describe('slugifyTopic', () => {
  it('lowercases and hyphenates non-alphanumerics', () => {
    expect(slugifyTopic('Tech')).toBe('tech');
    expect(slugifyTopic('AI & ML')).toBe('ai-ml');
  });
  it('keeps CJK characters', () => {
    expect(slugifyTopic('新能源')).toBe('新能源');
  });
  it('falls back to "topic" when nothing usable remains', () => {
    expect(slugifyTopic('   ')).toBe('topic');
    expect(slugifyTopic('!!!')).toBe('topic');
  });
});

describe('normalizeNewsConfig', () => {
  it('falls back to the default presets for null / empty input', () => {
    const cfg = normalizeNewsConfig(null);
    expect(cfg.topics.map((t) => t.id)).toEqual(DEFAULT_NEWS_TOPICS.map((t) => t.id));
    expect(cfg.updatedAt).toBe('');
  });

  it('drops entries without a label', () => {
    const cfg = normalizeNewsConfig({ topics: [{ label: 'Tech' }, { label: '  ' }, null, 42] });
    expect(cfg.topics).toHaveLength(1);
    expect(cfg.topics[0].label).toBe('Tech');
  });

  it('clamps limit into range and defaults query to the label', () => {
    const cfg = normalizeNewsConfig({
      topics: [
        { label: 'A', limit: 99 },
        { label: 'B', limit: 0 },
        { label: 'C' },
      ],
    });
    expect(cfg.topics[0].limit).toBe(NEWS_TOPIC_LIMIT_MAX);
    expect(cfg.topics[1].limit).toBe(NEWS_TOPIC_LIMIT_MIN);
    expect(cfg.topics[2].limit).toBe(4);
    expect(cfg.topics.map((t) => t.query)).toEqual(['A', 'B', 'C']);
  });

  it('keeps supplied ids and disambiguates duplicates', () => {
    const cfg = normalizeNewsConfig({
      topics: [
        { id: 'tech', label: 'Tech' },
        { id: 'tech', label: 'Tech 2' },
      ],
    });
    expect(cfg.topics[0].id).toBe('tech');
    expect(cfg.topics[1].id).not.toBe('tech');
    expect(new Set(cfg.topics.map((t) => t.id)).size).toBe(2);
  });

  it('infers language from the query when not provided', () => {
    const cfg = normalizeNewsConfig({ topics: [{ label: 'Tech' }, { label: 'Legal', query: '法规' }] });
    expect(cfg.topics[0].lang).toBe('en');
    expect(cfg.topics[1].lang).toBe('zh');
  });

  it('caps the stored topic count at 2× the soft max', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `T${i}` }));
    const cfg = normalizeNewsConfig({ topics: many });
    expect(cfg.topics).toHaveLength(NEWS_TOPIC_SOFT_MAX * 2);
  });
});

/**
 * 权威站（sites）—— 采集第二级（`site:<domain>` 定向检索）的配置口径。
 * 这一组的失败模式是「白名单过滤过头」：把用户/默认值里合法但写法宽松的域名丢掉，
 * 导致第二级静默失效、整条链路只剩裸关键词搜索。故逐条断言归一化结果。
 */
describe('topic sites (权威站)', () => {
  it('normalizes protocols, paths, case and www down to a bare domain', () => {
    const cfg = normalizeNewsConfig({
      topics: [{ label: 'Tech', sites: ['HTTPS://WWW.36Kr.com/article/1', 'ifanr.com', 'www.qbitai.com/'] }],
    });
    expect(cfg.topics[0].sites).toEqual(['36kr.com', 'ifanr.com', 'qbitai.com']);
  });

  it('drops invalid entries and de-duplicates', () => {
    const cfg = normalizeNewsConfig({
      topics: [{ label: 'Tech', sites: ['not a domain', 'a', 42, null, 'ok.com', 'ok.com'] }],
    });
    expect(cfg.topics[0].sites).toEqual(['ok.com']);
  });

  it('caps sites at the same limit as feeds', () => {
    const many = Array.from({ length: 20 }, (_, i) => `s${i}.com`);
    const cfg = normalizeNewsConfig({ topics: [{ label: 'Tech', sites: many }] });
    expect(cfg.topics[0].sites).toHaveLength(6);
  });

  it('omits both source keys when empty (old-config compatibility)', () => {
    const cfg = normalizeNewsConfig({ topics: [{ label: 'Tech' }] });
    expect('sites' in cfg.topics[0]).toBe(false);
    expect('feeds' in cfg.topics[0]).toBe(false);
  });

  it('prefers topic-supplied sites over the built-in table', () => {
    const base = { id: 'tech', label: 'Tech', query: 'x', limit: 4, lang: 'en' as const };
    expect(sitesForTopic(base)).toEqual(CURATED_TOPIC_SITES.tech);
    expect(sitesForTopic({ ...base, sites: ['mine.com'] })).toEqual(['mine.com']);
  });

  it('returns an empty list for an unknown topic (caller falls back to keyword search)', () => {
    expect(sitesForTopic({ id: 'nope', label: 'Nope', query: 'x', limit: 4, lang: 'en' })).toEqual([]);
  });

  it('covers legal, which has no usable RSS feed', () => {
    expect(CURATED_TOPIC_SITES.legal).toContain('court.gov.cn');
    expect(CURATED_TOPIC_SITES.legal.length).toBeGreaterThan(0);
  });
});
