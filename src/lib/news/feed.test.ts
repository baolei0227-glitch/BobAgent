/**
 * feed.ts 单测：两个纯函数都不触网 —— `parseFeedXml`（RSS 2.0 / Atom / RDF + 异常输入）
 * 与 `interleaveFeeds`（源间轮转 / 去重 / 边界）。
 */
import { describe, expect, it } from 'vitest';
import { interleaveFeeds, parseFeedXml, type FeedItem } from './feed';

describe('parseFeedXml', () => {
  it('解析 RSS 2.0：CDATA 解包、实体解码、去标签、链接与时间', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>频道</title>
<item>
  <title><![CDATA[标题一]]></title>
  <link>https://a.com/1</link>
  <description><![CDATA[<p>正文 &amp; 更多</p>]]></description>
  <pubDate>Sun, 04 Oct 2026 07:08:18 +0000</pubDate>
</item>
<item>
  <title lang="en">T2</title>
  <link>https://a.com/2</link>
</item>
</channel></rss>`;

    const items = parseFeedXml(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: '标题一',
      url: 'https://a.com/1',
      snippet: '正文 & 更多',
      dateMs: Date.parse('Sun, 04 Oct 2026 07:08:18 +0000'),
    });
    expect(items[1].title).toBe('T2');
    expect(items[1].url).toBe('https://a.com/2');
    expect(items[1].snippet).toBe('');
    expect(items[1].dateMs).toBe(0);
  });

  it('解析 Atom：link 取 rel=alternate 的 href，时间取 updated', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title>Atom 标题</title>
  <link rel="self" href="https://b.com/self"/>
  <link rel="alternate" href="https://b.com/x"/>
  <summary>hi &lt;b&gt;there&lt;/b&gt;</summary>
  <updated>2026-10-04T07:00:00Z</updated>
</entry>
</feed>`;

    const items = parseFeedXml(xml);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://b.com/x');
    expect(items[0].title).toBe('Atom 标题');
    expect(items[0].snippet).toBe('hi there');
    expect(items[0].dateMs).toBe(Date.parse('2026-10-04T07:00:00Z'));
  });

  it('解析 RDF：用 rdf:about 兜底链接、dc:date 兜底时间', () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
<item rdf:about="https://c.com/1">
  <title>RDF 标题</title>
  <dc:date>2026-10-03T10:00:00Z</dc:date>
</item>
</rdf:RDF>`;

    const items = parseFeedXml(xml);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://c.com/1');
    expect(items[0].dateMs).toBe(Date.parse('2026-10-03T10:00:00Z'));
  });

  it('跳过没有合法链接的条目', () => {
    const xml = `<rss version="2.0"><channel>
<item><title>无链接</title></item>
<item><title>非 http</title><link>javascript:void(0)</link></item>
<item><title>正常</title><link>https://d.com/ok</link></item>
</channel></rss>`;
    const items = parseFeedXml(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('正常');
  });

  it('摘要超长时截断', () => {
    const long = 'x'.repeat(500);
    const xml = `<rss version="2.0"><channel><item><title>T</title><link>https://e.com/1</link><description>${long}</description></item></channel></rss>`;
    const items = parseFeedXml(xml);
    expect(items[0].snippet.length).toBe(201); // 200 + 省略号
    expect(items[0].snippet.endsWith('…')).toBe(true);
  });

  it('非 feed / 破损输入返回空数组而不抛异常', () => {
    expect(parseFeedXml('<html><body>not a feed</body></html>')).toEqual([]);
    expect(parseFeedXml('{"not":"xml"}')).toEqual([]);
    expect(parseFeedXml('')).toEqual([]);
  });
});

describe('interleaveFeeds', () => {
  const mk = (title: string, url: string, dateMs = 0): FeedItem => ({ title, url, snippet: `${title}`, dateMs });

  it('源间轮转：三个源逐轮各取一条', () => {
    const perFeed: FeedItem[][] = [
      [mk('a1', 'https://a/1'), mk('a2', 'https://a/2')],
      [mk('b1', 'https://b/1'), mk('b2', 'https://b/2')],
      [mk('c1', 'https://c/1'), mk('c2', 'https://c/2')],
    ];
    expect(interleaveFeeds(perFeed, 6).map((h) => h.title)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'c2']);
  });

  it('均摊：更新最勤的源不能刷满名额', () => {
    const busy = Array.from({ length: 10 }, (_, i) => mk(`busy${i}`, `https://busy/${i}`));
    const perFeed: FeedItem[][] = [busy, [mk('x', 'https://x/1')], [mk('y', 'https://y/1')]];
    expect(interleaveFeeds(perFeed, 4).map((h) => h.title)).toEqual(['busy0', 'x', 'y', 'busy1']);
  });

  it('源内按时间新→旧排序', () => {
    const perFeed: FeedItem[][] = [[mk('old', 'https://a/1', 100), mk('new', 'https://a/2', 200)]];
    expect(interleaveFeeds(perFeed, 2).map((h) => h.title)).toEqual(['new', 'old']);
  });

  it('按 URL 去重（跨源同一链接只保留一条）', () => {
    const perFeed: FeedItem[][] = [
      [mk('first', 'https://same/1')],
      [mk('second', 'https://same/1'), mk('other', 'https://other/1')],
    ];
    expect(interleaveFeeds(perFeed, 5).map((h) => h.url)).toEqual(['https://same/1', 'https://other/1']);
  });

  it('空源跳过；全部取尽时不足 maxResults 也不报错', () => {
    expect(interleaveFeeds([[], [mk('x', 'https://x/1')], []], 5).map((h) => h.title)).toEqual(['x']);
    expect(interleaveFeeds([[], []], 5)).toEqual([]);
  });
});
