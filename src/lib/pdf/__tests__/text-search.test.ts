import { describe, expect, it } from 'vitest';
import {
  buildOcrPageIndex,
  buildPageText,
  contextAround,
  excerptAround,
  findMatches,
  looksLikeScannedPdf,
  matchToRects,
  searchOcrPages,
  searchPageIndexes,
  splitOcrPagesFromText,
} from '../text-search';
import type { OcrBlockGeom, TextItemGeom, ViewportMeta } from '../text-search';

/** scale=1、rotation=0 的 pdfjs 视口：y 翻转且平移到页高 */
const VP: ViewportMeta = { transform: [1, 0, 0, -1, 0, 800], scale: 1, w: 600, h: 800 };

function item(str: string, x: number, yPdf: number, width: number): TextItemGeom {
  // 典型字体矩阵：字号 12，无旋转
  return { str, transform: [12, 0, 0, 12, x, yPdf], width, height: 12 };
}

describe('buildPageText', () => {
  it('拼接文字块并记录字符区间', () => {
    const entry = buildPageText([
      item('破产案件', 50, 100, 48),
      item('不动产信息', 150, 100, 60),
    ]);
    expect(entry.text).toBe('破产案件不动产信息');
    expect(entry.segments).toEqual([
      { start: 0, end: 4, itemIdx: 0 },
      { start: 4, end: 9, itemIdx: 1 },
    ]);
  });

  it('跳过空文字块，itemIdx 指向有效项', () => {
    const entry = buildPageText([item('', 0, 0, 10), item('证据', 20, 50, 24)]);
    expect(entry.text).toBe('证据');
    expect(entry.segments[0].itemIdx).toBe(0);
    expect(entry.items[0].str).toBe('证据');
  });
});

describe('findMatches', () => {
  it('大小写不敏感、多命中顺延不重叠', () => {
    expect(findMatches('Foo foo FOO', 'foo')).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
  });

  it('重叠场景按非重叠消费（aaa in aaaaaa）', () => {
    expect(findMatches('aaaaaa', 'aaa')).toEqual([
      [0, 3],
      [3, 6],
    ]);
  });

  it('空查询与未命中返回空数组', () => {
    expect(findMatches('合同编号 2024', '')).toEqual([]);
    expect(findMatches('合同编号 2024', '判决')).toEqual([]);
  });
});

describe('matchToRects', () => {
  it('单块整体命中：基线框换算正确（左下原点 → 左上原点）', () => {
    const entry = buildPageText([item('破产案件不动产信息', 50, 100, 120)]);
    const rects = matchToRects(entry, 0, 9, VP);
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBeCloseTo(50 / 600, 6);
    expect(rects[0].y).toBeCloseTo((800 - 100 - 12) / 800, 6);
    expect(rects[0].w).toBeCloseTo(120 / 600, 6);
    expect(rects[0].h).toBeCloseTo(12 / 800, 6);
  });

  it('块内部分命中：按字符比例内插', () => {
    const entry = buildPageText([item('破产案件不动产信息', 50, 100, 120)]);
    const rects = matchToRects(entry, 4, 8, VP); // 第4~7字符
    expect(rects).toHaveLength(1);
    // 单块共 9 字符：offsetRatio = ratio = 4/9
    expect(rects[0].x).toBeCloseTo((50 + 120 * (4 / 9)) / 600, 6);
    expect(rects[0].w).toBeCloseTo((120 * (4 / 9)) / 600, 6);
  });

  it('同一行相邻块合并为一个矩形，跨行保持分离', () => {
    const entry = buildPageText([
      item('破产案件', 50, 100, 48),
      item('受理信息', 110, 100, 48),
      item('第二行内容', 50, 80, 60),
    ]);
    const rects = matchToRects(entry, 0, entry.text.length, VP);
    expect(rects.length).toBe(2);
    expect(rects[0].x).toBeCloseTo(50 / 600, 6);
    expect(rects[0].w).toBeCloseTo(108 / 600, 6);
    // CSS 坐标系下第二行 top 更大（pdfY=80 → cssTop=708 > 688）
    expect(rects[1].y).toBeGreaterThan(rects[0].y);
  });

  it('超出视口时裁剪到 0~1', () => {
    const entry = buildPageText([item('越界文本', 590, 5, 300)]);
    const rects = matchToRects(entry, 0, 4, VP);
    for (const r of rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(1.0000001);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(1.0000001);
    }
  });
});

describe('searchPageIndexes', () => {
  const e1 = buildPageText([item('破产案件受理通知', 50, 700, 96)]);
  const e2 = buildPageText([item('登记信息一览表', 40, 650, 84)]);

  it('跨页检索返回页码、上下文与矩形', () => {
    const hits = searchPageIndexes([e1, e2], '登记', { viewports: [VP, VP] });
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe(2);
    expect(hits[0].rects).toHaveLength(1);
    expect(hits[0].context).toContain('登记');
  });

  it('缺省视口时只做页级命中（rects 为空）', () => {
    const hits = searchPageIndexes([e1, e2], '登记');
    expect(hits).toHaveLength(1);
    expect(hits[0].rects).toHaveLength(0);
  });

  it('totalHitsLimit 截断结果', () => {
    const hits = searchPageIndexes([e1, e2], '信息', { totalHitsLimit: 1 });
    expect(hits).toHaveLength(1);
  });
});

describe('looksLikeScannedPdf', () => {
  it('平均每页可视字符过少判定为扫描件', () => {
    expect(looksLikeScannedPdf([{ text: '' }, { text: '水印 logo' }])).toBe(true);
    expect(looksLikeScannedPdf([{ text: '破产清算申请书全文正文很长'.repeat(3) }])).toBe(false);
  });

  it('空白字符不计入统计', () => {
    expect(looksLikeScannedPdf([{ text: '\n \t\n' }, { text: '   ' }])).toBe(true);
  });
});

describe('searchOcrPages', () => {
  const pages = [
    { page: 1, text: '[第1页] 抵押权登记信息摘要' },
    { page: 2, text: '[第2页] 续表：不动产自然状况' },
  ];

  it('OCR 页级检索不带矩形、带摘录', () => {
    const hits = searchOcrPages(pages, '不动产');
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe(2);
    expect(hits[0].rects).toEqual([]);
    expect(hits[0].context).toContain('续表');
  });

  it('数量上限截断', () => {
    const hits = searchOcrPages(pages, '', { totalHitsLimit: 5 });
    expect(hits).toHaveLength(0);
  });
});

describe('OCR blocks 行级几何高亮', () => {
  it('单块命中：y 翻转 + 按字符比例切分', () => {
    const page = {
      page: 1,
      text: 'Hello World',
      // Vision 左下原点：x=0.5, y=0.7, w=0.22, h=0.05 → 左上原点应为 top=0.25
      blocks: [{ text: 'Hello World', x: 0.5, y: 0.7, w: 0.22, h: 0.05 }],
    };
    const hits = searchOcrPages([page], 'WORLD');
    expect(hits).toHaveLength(1);
    expect(hits[0].rects).toHaveLength(1);
    const r = hits[0].rects[0];
    expect(r.y).toBeCloseTo(1 - 0.75, 6); // top = 1-(y+h)
    expect(r.h).toBeCloseTo(0.05, 6);
    expect(r.x).toBeCloseTo(0.5 + 0.22 * (6 / 11), 6); // 'World' 从第 6 字符起
    expect(r.w).toBeCloseTo(0.22 * (5 / 11), 6);
  });

  it('不同行插入换行符阻止跨行假命中', () => {
    const page = {
      page: 1,
      text: '',
      blocks: [
        { text: '保证金缴存', x: 0.1, y: 0.9, w: 0.2, h: 0.04 },
        { text: '凭证专用章', x: 0.1, y: 0.8, w: 0.2, h: 0.04 },
      ],
    };
    expect(searchOcrPages([page], '存凭证')).toHaveLength(0);
    const hit = searchOcrPages([page], '凭证专用');
    expect(hit).toHaveLength(1);
    expect(hit[0].rects[0].y).toBeCloseTo(1 - 0.84, 6); // 第二行框
  });

  it('同一视觉线双框拼接后可连续检索且矩形合并', () => {
    const page = {
      page: 1,
      text: '',
      blocks: [
        { text: 'HELLO', x: 0.1, y: 0.9, w: 0.3, h: 0.04 },
        { text: 'WORLD', x: 0.4, y: 0.9, w: 0.3, h: 0.04 },
      ],
    };
    const hits = searchOcrPages([page], 'LOWORLD');
    expect(hits).toHaveLength(1);
    expect(hits[0].rects).toHaveLength(1); // 同行相邻片段合并
    const r = hits[0].rects[0];
    expect(r.x).toBeCloseTo(0.28, 6); // 0.1 + 0.3*(3/5)
    expect(r.w).toBeCloseTo(0.7 - 0.28, 6); // 延伸到第二框右缘
  });

  it('无骨架页退化为页级检索', () => {
    const hits = searchOcrPages([{ page: 3, text: '纯文本兜底关键词' }], '关键词');
    expect(hits).toHaveLength(1);
    expect(hits[0].rects).toEqual([]);
  });

  it('全部无效块视为无骨架并退化', () => {
    const bad = [{ text: 'abc', x: 0.1, y: 0.9, w: 0, h: 0.04 }] as OcrBlockGeom[];
    const hits = searchOcrPages([{ page: 1, text: '文本', blocks: bad }], '文本');
    expect(hits).toHaveLength(1);
    expect(hits[0].rects).toEqual([]);
  });

  it('buildOcrPageIndex 边界：空输入返回 null 且剔除无效块', () => {
    expect(buildOcrPageIndex(undefined)).toBeNull();
    expect(buildOcrPageIndex([])).toBeNull();
    expect(buildOcrPageIndex([{ text: '   ', x: 0.1, y: 0.9, w: 0.2, h: 0.04 }])).toBeNull();
    const ok = buildOcrPageIndex([
      { text: '有效', x: 0.1, y: 0.9, w: 0.2, h: 0.04 },
      { text: '   ', x: NaN, y: NaN, w: 0.2, h: 0.04 },
    ]);
    expect(ok).not.toBeNull();
    expect(ok?.text).toBe('有效');
  });
});

describe('splitOcrPagesFromText', () => {
  it('按 [Page N] 标记切分并去掉页内标记', () => {
    const text = '[Page 1] 第一页内容\n[Page 2] 第二页内容';
    const pages = splitOcrPagesFromText(text);
    expect(pages).toEqual([
      { page: 1, text: '第一页内容' },
      { page: 2, text: '第二页内容' },
    ]);
  });

  it('无标记文本返回空数组（避免整包误判为一页）', () => {
    expect(splitOcrPagesFromText('普通全文没有分页标记')).toEqual([]);
  });
});

describe('contextAround', () => {
  it('两侧留白并折叠空白、标注省略号', () => {
    const text = `${'前'.repeat(30)}关键词${'后'.repeat(30)}`;
    const ctx = contextAround(text, 30, 33, 10);
    expect(ctx.startsWith('…')).toBe(true);
    expect(ctx.endsWith('…')).toBe(true);
    expect(ctx).toContain('关键词');
  });

  it('贴边时不加省略号', () => {
    expect(contextAround('开头即命中', 0, 2, 10)).toBe('开头即命中');
  });
});

describe('excerptAround（hover 长上下文预览）', () => {
  it('文本与命中下标自洽：slice 即命中词', () => {
    const text = `${'前'.repeat(200)}关键词${'后'.repeat(300)}`;
    const ex = excerptAround(text, 200, 203);
    expect(ex.text.slice(ex.matchStart, ex.matchEnd)).toBe('关键词');
    expect(ex.text.startsWith('…')).toBe(true);
    expect(ex.text.endsWith('…')).toBe(true);
    // 两侧 160 + 命中词 3 + 首尾省略号
    expect(ex.text.length).toBeLessThanOrEqual(160 * 2 + 3 + 2);
  });

  it('贴边无截断时下标原样保留、无省略号', () => {
    const ex = excerptAround('开头即命中', 0, 2);
    expect(ex.text).toBe('开头即命中');
    expect([ex.matchStart, ex.matchEnd]).toEqual([0, 2]);
  });

  it('空白折叠为单空格且命中下标同步平移', () => {
    const text = '前 文\n\n\t关键 词 之后';
    const s = text.indexOf('关');
    const ex = excerptAround(text, s, s + 4);
    expect(ex.text).toBe('前 文 关键 词 之后');
    expect(ex.text.slice(ex.matchStart, ex.matchEnd)).toBe('关键 词');
  });

  it('头部省略号计入偏移；命中前空白折叠为单空格', () => {
    const text = `${'x'.repeat(300)}   中间词`;
    const s = 303; // '中'（其前 3 个空格位于摘录内部）
    const ex = excerptAround(text, s, s + 3);
    expect(ex.text).toBe(`…${'x'.repeat(157)} 中间词`);
    expect(ex.text.slice(ex.matchStart, ex.matchEnd)).toBe('中间词');
  });

  it('摘录可见区以空白开头时不产生前导空格', () => {
    const ex = excerptAround('   中间词', 3, 6);
    expect(ex.text).toBe('中间词');
    expect([ex.matchStart, ex.matchEnd]).toEqual([0, 3]);
  });
});

describe('搜索命中附带长摘录 excerpt', () => {
  it('原生文本层路径：excerpt 与 context 同源且下标自洽', () => {
    const entry = buildPageText([
      item(`${'引言'.repeat(120)}抵押权登记`, 50, 100, 72),
      item('后续条款内容'.repeat(20), 140, 100, 144),
    ]);
    const hits = searchPageIndexes([entry], '抵押权登记', { viewports: [VP] });
    expect(hits).toHaveLength(1);
    const ex = hits[0].excerpt;
    expect(ex).toBeDefined();
    expect(ex!.text.slice(ex!.matchStart, ex!.matchEnd)).toBe('抵押权登记');
    expect(hits[0].context.length).toBeLessThan(ex!.text.length);
  });

  it('OCR 页级兜底路径与 blocks 路径均附带 excerpt', () => {
    // 页级兜底（无 blocks）
    const plain = [{ page: 1, text: `[第1页] ${'背景介绍'.repeat(100)}不动产登记信息` }];
    const h1 = searchOcrPages(plain, '不动产')[0];
    expect(h1.excerpt).toBeDefined();
    expect(h1.excerpt!.text.slice(h1.excerpt!.matchStart, h1.excerpt!.matchEnd)).toBe('不动产');

    // blocks 行级骨架路径
    const page = {
      page: 2,
      text: '',
      blocks: [
        { text: `${'表格说明'.repeat(90)}`, x: 0.1, y: 0.5, w: 0.8, h: 0.02 },
        { text: '不动产状况一览', x: 0.1, y: 0.45, w: 0.3, h: 0.02 },
      ],
    };
    const h2 = searchOcrPages([page], '不动产')[0];
    expect(h2.excerpt).toBeDefined();
    expect(h2.excerpt!.text.slice(h2.excerpt!.matchStart, h2.excerpt!.matchEnd)).toBe('不动产');
    expect(h2.excerpt!.text).toContain('表格说明');
  });
});
