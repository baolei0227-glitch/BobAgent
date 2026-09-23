/**
 * T2-1 · 小红书卡片分页纯函数单测（xhsPagination.ts，从 XhsCard.tsx 抽离件）。
 * 分页核心规则来自方案 §7.2：块内不拆 / 标题与后块同页 / table 整块不跨页 /
 * 超大表格独占一页 / 单块超高回退 fitPrefix 行内切。
 * measure 回调为注入参数，单测用确定性 mock（每字符 10px），不依赖 DOM。
 */
import { describe, expect, it } from 'vitest';
import {
  extractCoverItems,
  fitPrefix,
  mdToLines,
  paginateBlocks,
  parseMdTable,
  splitBodyToBlocks,
} from '../xhsPagination';
import type { XhsBodyBlock } from '../xhsPagination';

/** 每字符 10px 的确定性文本测量 */
const measureText = (t: string) => t.length * 10;
/** 表格测量：每行（含表头）25px */
const measureTable = (_h: string[], rows: string[][]) => (rows.length + 1) * 25;

describe('mdToLines', () => {
  it('keepHeadings=false 剥掉 # 前缀，列表规整为 •', () => {
    const md = ['# 标题', '', '段落一', '', '- 项目A', '- 项目B', '', '1. 第一', '2. 第二'].join('\n');
    expect(mdToLines(md)).toEqual([
      '标题', '', '段落一', '', '• 项目A', '• 项目B', '', '1. 第一', '2. 第二',
    ]);
  });

  it('keepHeadings=true 保留 # 语义标记（分页 keep-with-next 依赖）', () => {
    expect(mdToLines('## 二级标题', true)).toEqual(['## 二级标题']);
    expect(mdToLines('## 二级标题', false)).toEqual(['二级标题']);
  });

  it('行内标记压平：加粗/斜体/行内码/链接，图片删除', () => {
    expect(mdToLines('**粗**和*斜*和`码`')).toEqual(['粗和斜和码']);
    expect(mdToLines('看[链接](https://x)和![图](https://y)')).toEqual(['看链接和']);
  });

  it('代码块整段跳过；连续空行折叠为单个；首尾空行去除', () => {
    const md = ['', '```js', 'const a = 1;', '```', '', '', '正文', '', ''].join('\n');
    expect(mdToLines(md)).toEqual(['正文']);
  });
});

describe('extractCoverItems', () => {
  it('至少 2 项列表才作为封面要点，最多取 3 项', () => {
    expect(extractCoverItems(['• 甲', '• 乙', '• 丙', '• 丁'])).toEqual(['甲', '乙', '丙']);
    expect(extractCoverItems(['1. 甲', '2. 乙'])).toEqual(['甲', '乙']);
  });

  it('不足 2 项返回 null（封面退回引言模式）', () => {
    expect(extractCoverItems(['• 甲'])).toBeNull();
    expect(extractCoverItems(['普通段落'])).toBeNull();
  });
});

describe('fitPrefix', () => {
  const m = (t: string) => t.length;

  it('二分取容量内最大前缀', () => {
    expect(fitPrefix('abcdefgh', 5, m)).toBe('abcde');
  });

  it('回退到句末标点，避免句中切断', () => {
    expect(fitPrefix('ab。cdef', 7, m)).toBe('ab。');
  });

  it('零容量 / 首字符即超 → 空串', () => {
    expect(fitPrefix('abc', 0, m)).toBe('');
    expect(fitPrefix('', 5, m)).toBe('');
  });
});

describe('parseMdTable', () => {
  it('表头 + 分隔行 + 数据行 → 结构化表格', () => {
    expect(parseMdTable(['| A | B |', '| --- | --- |', '| 1 | 2 |'])).toEqual({
      header: ['A', 'B'],
      rows: [['1', '2']],
    });
  });

  it('无分隔行 → null（交回文本段处理）', () => {
    expect(parseMdTable(['| A | B |', '| x | y |'])).toBeNull();
  });

  it('数据行单元格数补齐到表头列数', () => {
    expect(parseMdTable(['| A | B | C |', '| --- | --- | --- |', '| 1 |'])).toEqual({
      header: ['A', 'B', 'C'],
      rows: [['1', '', '']],
    });
  });
});

describe('splitBodyToBlocks', () => {
  it('混合正文 → 顺序语义块：标题 / 段落 / 列表整组 / 表格', () => {
    const body = [
      '# 标题一', '', '第一段。', '', '• 甲', '• 乙', '',
      '| A | B |', '| --- | --- |', '| 1 | 2 |',
    ].join('\n');
    expect(splitBodyToBlocks(body)).toEqual([
      { kind: 'heading', text: '标题一' },
      { kind: 'text', text: '第一段。' },
      { kind: 'list', items: ['甲', '乙'] },
      { kind: 'table', header: ['A', 'B'], rows: [['1', '2']] },
    ]);
  });

  it('首尾带 | 但无分隔行的行退回文本段', () => {
    const body = '| A | B |\n| x | y |';
    const blocks = splitBodyToBlocks(body);
    expect(blocks).toEqual([{ kind: 'text', text: body }]);
  });
});

describe('paginateBlocks（§7.2 语义块边界分页）', () => {
  it('块内不拆：剩余空间不足时整块下移', () => {
    const blocks = [
      { kind: 'text', text: 'aaaa' },   // 40px
      { kind: 'text', text: 'bbbb' },   // 40px
      { kind: 'text', text: 'cccccc' }, // 60px
    ] as const;
    const pages = paginateBlocks([...blocks], 100, measureText, measureTable);
    expect(pages).toEqual([
      [blocks[0], blocks[1]], // 80 ≤ 100
      [blocks[2]],            // 80+60 > 100 → 下移
    ]);
  });

  it('标题 keep-with-next：标题与后块整组下移，不产生孤行标题', () => {
    const blocks = [
      { kind: 'text', text: 'aaaa' },      // 40px，占页 1
      { kind: 'heading', text: '标题h' },  // 30px
      { kind: 'text', text: 'bbbbbb' },    // 60px
    ] as const;
    // 无 keep 时：40+30=70 ≤ 100 标题会留在页 1 成为孤行；
    // keep 生效：40+30+60=130 > 100 → 标题带后块整组去页 2
    const pages = paginateBlocks([...blocks], 100, measureText, measureTable);
    expect(pages).toEqual([
      [blocks[0]],
      [blocks[1], blocks[2]],
    ]);
  });

  it('table 整块不跨页：放不下整块下移', () => {
    const table: XhsBodyBlock = { kind: 'table', header: ['A'], rows: [['1'], ['2'], ['3']] }; // 100px
    const pages = paginateBlocks(
      [{ kind: 'text', text: 'aaaa' } as const, table],
      100, measureText, measureTable,
    );
    expect(pages).toEqual([
      [{ kind: 'text', text: 'aaaa' }],
      [table],
    ]);
  });

  it('超大表格（单块 > 页容量）独占一页，前后块各归其页', () => {
    const big: XhsBodyBlock = { kind: 'table', header: ['A'], rows: [['1'], ['2'], ['3'], ['4'], ['5'], ['6']] }; // 175px > 100
    const pages = paginateBlocks(
      [{ kind: 'text', text: 'aaaa' } as const, big, { kind: 'text', text: 'bbbb' } as const],
      100, measureText, measureTable,
    );
    expect(pages).toEqual([
      [{ kind: 'text', text: 'aaaa' }],
      [big],
      [{ kind: 'text', text: 'bbbb' }],
    ]);
  });

  it('单块超高回退行切：超长单行按句末标点逐段放入独立页', () => {
    // 12 字符 = 120px > 100 → fitPrefix 切为 10 字符 + 2 字符两页
    const pages = paginateBlocks(
      [{ kind: 'text', text: 'a'.repeat(12) } as const],
      100, measureText, measureTable,
    );
    expect(pages).toEqual([
      [{ kind: 'text', text: 'a'.repeat(10) }],
      [{ kind: 'text', text: 'aa' }],
    ]);
  });
});
