/**
 * T2-1 · DocIR 解析层单测（lib/md-export/ir.ts）。
 * 覆盖：stripFrontmatter / parseDoc 全 block 类型与 inline 压平 /
 * title-hook-stats 抽取 / chatToMarkdown 适配 / docPlainText 序列化。
 * DocIR 是多端分发管线（海报/微信/小红书/微博）的唯一解析点，此层出错则全端出错。
 */
import { describe, expect, it } from 'vitest';
import {
  chatToMarkdown,
  docPlainText,
  inlineText,
  parseDoc,
  stripFrontmatter,
} from '../ir';

const FENCE = '```';

describe('stripFrontmatter', () => {
  it('剥掉 --- 包裹的 frontmatter', () => {
    expect(stripFrontmatter('---\ntitle: x\n---\n\n正文')).toBe('正文');
  });

  it('无 frontmatter 原样返回', () => {
    expect(stripFrontmatter('--- 分隔线不是 frontmatter\n正文')).toBe('--- 分隔线不是 frontmatter\n正文');
  });
});

describe('parseDoc', () => {
  it('空内容返回空 IR，不抛错', () => {
    const ir = parseDoc('  \n\t');
    expect(ir.blocks).toEqual([]);
    expect(ir.title).toBe('');
    expect(ir.hook).toBe('');
    expect(ir.stats).toEqual([]);
  });

  it('frontmatter 在解析前剥离，不进入 blocks', () => {
    const ir = parseDoc('---\ntitle: x\n---\n\n# 标题\n\n正文');
    expect(ir.title).toBe('标题');
    expect(ir.blocks.some((b) => b.t === 'code')).toBe(false);
  });

  it('全 block 类型：heading/paragraph/list/quote/code/table/hr/image', () => {
    const md = [
      '# 主标题', '', '首段开头。这是首段后续内容。', '', '## 二级',
      '', '- 无序A', '- 无序B', '', '1. 有序一', '2. 有序二',
      '', '> 引用段落', '',
      `${FENCE}js`, 'const x = 1;', FENCE, '',
      '| 列1 | 列2 |', '| --- | --- |', '| a | b |', '',
      '---', '', '![替代文字](http://img)',
    ].join('\n');
    const ir = parseDoc(md);

    expect(ir.title).toBe('主标题');
    const kinds = ir.blocks.map((b) => b.t);
    expect(kinds).toContain('heading');
    expect(kinds).toContain('paragraph');
    expect(kinds).toContain('list');
    expect(kinds).toContain('quote');
    expect(kinds).toContain('code');
    expect(kinds).toContain('table');
    expect(kinds).toContain('hr');
    expect(kinds).toContain('image');

    const headings = ir.blocks.filter((b) => b.t === 'heading');
    expect(headings.map((h) => [h.level, h.text])).toEqual([[1, '主标题'], [2, '二级']]);

    const lists = ir.blocks.filter((b) => b.t === 'list');
    expect(lists.map((l) => [l.ordered, l.items.length])).toEqual([[false, 2], [true, 2]]);

    const quote = ir.blocks.find((b) => b.t === 'quote');
    expect(quote && quote.blocks[0].t).toBe('paragraph');

    const code = ir.blocks.find((b) => b.t === 'code');
    expect(code && [code.lang, code.lines]).toEqual(['js', ['const x = 1;']]);

    const table = ir.blocks.find((b) => b.t === 'table');
    expect(table && [table.header, table.rows]).toEqual([['列1', '列2'], [['a', 'b']]]);

    const img = ir.blocks.find((b) => b.t === 'image');
    expect(img && [img.src, img.alt]).toEqual(['http://img', '替代文字']);
  });

  it('inline 嵌套标记压平为单层：strong/em/code/del/link', () => {
    const ir = parseDoc('**粗**和*斜*和`码`和~~删~~和[链](https://u)');
    const p = ir.blocks.find((b) => b.t === 'paragraph');
    expect(p && p.inline.map((i) => i.t)).toEqual([
      'strong', 'text', 'em', 'text', 'code', 'text', 'del', 'text', 'link',
    ]);
    const link = p && p.inline.find((i) => i.t === 'link');
    expect(link && [link.value, link.href]).toEqual(['链', 'https://u']);
  });

  it('HTML <img> 标签提升为 image 块（src/alt 保留，width 丢弃）', () => {
    const ir = parseDoc('<img src="http://x.png" alt="配图" width="360">');
    const img = ir.blocks.find((b) => b.t === 'image');
    expect(img && [img.src, img.alt]).toEqual(['http://x.png', '配图']);
  });

  it('title：无 h1 取首个任意级标题；再无则取路径文件名（去扩展名）', () => {
    expect(parseDoc('## 只有二级\n\n正文').title).toBe('只有二级');
    expect(parseDoc('正文无标题', { path: '/a/b/报告.md' }).title).toBe('报告');
  });

  it('hook：首个非空段落截到首个句末标点，≤40 字', () => {
    expect(parseDoc('第一句。第二句很长很长。').hook).toBe('第一句。');
    const long = '这是一个没有句读的特别特别长的首段'.repeat(4);
    expect(parseDoc(long).hook.length).toBeLessThanOrEqual(40);
  });

  it('stats：数字必须带单位、去重、最多 6 个；纯数字不算；复合单位取首个匹配', () => {
    const md = '增长 30%，达 5 亿元，服务 120 万人，另增 30%，版本 2 更新';
    // 既有特性：单位 alternation 左优先，'120万人' 匹配到 '万' 即止 → '120万'（非 bug，记录行为）
    expect(parseDoc(md).stats).toEqual(['30%', '5亿元', '120万']);
  });
});

describe('chatToMarkdown', () => {
  it('单行问题 → 一级标题 + 回答', () => {
    expect(chatToMarkdown('问题', '回答')).toBe('# 问题\n\n回答');
  });

  it('多行问题 → 首行做标题，其余进正文', () => {
    expect(chatToMarkdown('首行\n续行', '回答')).toBe('# 首行\n\n续行\n\n回答');
  });

  it('空问题 → 仅回答', () => {
    expect(chatToMarkdown('', '回答')).toBe('回答');
  });
});

describe('docPlainText / inlineText', () => {
  it('blocks → 纯文本（列表带序号/圆点前缀）；h1 在 title 与 heading 块各出现一次', () => {
    const md = '# 标题\n\n1. 有序一\n2. 有序二\n\n- 无序一';
    const out = docPlainText(parseDoc(md));
    // 既有特性：docPlainText = [ir.title, ...blocks]，文档含 h1 时标题输出两次（观察项，未改行为）
    expect(out).toBe('标题\n\n标题\n\n1. 有序一\n2. 有序二\n\n· 无序一');
  });

  it('inlineText 拼接各段 value', () => {
    expect(inlineText([{ t: 'text', value: 'a' }, { t: 'strong', value: 'b' }])).toBe('ab');
  });
});
