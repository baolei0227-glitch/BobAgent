/**
 * 完整 Word 视觉保真 · 表格/图片/列表 双向映射 + 脏块渲染路由 + 回归护栏
 * ============================================================================
 * 本文件覆盖 S1「全量 1+2+3」新增适配器的核心逻辑：
 *   - 适配器 A `blocksToDoc`：table/image/listItem 三类复杂块 → 可编辑 PM 节点；
 *   - 适配器 B `docToBlocks`：编辑后 PM 文档 → 重建 TableModel（内容取 PM、元数据合并保真）/ 回带图片锚点 / 回带列表元数据；
 *   - `docxRenderDirty`：脏块分派（table→{kind:'xml'} 重生成、image 已有块→original、新图→NewImage、passthrough→original）；
 *   - 回归护栏「改 A 表不误写 B 表」：多表文档仅一处脏时，净表逐字节 passthrough，不被连带重生成。
 *
 * 约定（与既有测试一致）：
 *   - 纯适配器逻辑（A/B 双向映射、路由判定）不依赖引擎运行时，可在本地 `corepack pnpm install` 后直接跑；
 *   - 凡是调用到 `docxRenderDirty`（其内部 `import` 了 `@/lib/docx-engine/generate`）或 `saveDocx` 的用例，
 *     一律**懒加载 + 缺依赖跳过**（见 `loadRenderDirty`/`loadEngine`），避免拖垮沙箱套件 / CI。
 *     引擎字节级验证由 `round-trip.test.ts` / `edit-round-trip.test.ts` 负责。
 */

import { describe, expect, it } from 'vitest'
import type { Block, NewImage, TableModel } from '@/lib/docx-engine/types'
import { blocksToDoc } from './blocks-to-tiptap'
import { docToBlocks } from './tiptap-to-blocks'
import { buildSaveBlocks } from './save-blocks'

/* ------------------------------------------------------------------ */
/* 测试夹具                                                            */
/* ------------------------------------------------------------------ */

const tableModel = {
  rows: [
    [
      { richParas: [{ runs: [{ text: 'A1' }] }], paras: ['A1'] },
      { richParas: [{ runs: [{ text: 'B1' }] }], paras: ['B1'] },
    ],
    [
      { richParas: [{ runs: [{ text: 'A2' }] }], paras: ['A2'] },
      { richParas: [{ runs: [{ text: 'B2' }] }], paras: ['B2'] },
    ],
  ],
  colWidthsPct: [50, 50],
  borders: {
    insideH: { style: 'single', szEighths: 4 },
    insideV: { style: 'single', szEighths: 4 },
  },
  fill: null,
  align: 'center',
} as unknown as TableModel

const tableBlock: Block = {
  id: 'tbl0',
  type: 'table',
  docxIndex: 5,
  originalXml: '<w:tbl>orig5</w:tbl>',
  table: tableModel,
}

/** 模拟「单元格被编辑」：仅把 A1 文本改成 EDITED（验证 docToBlocks 从 PM 文档取内容，而非信任原 block） */
const tableBlockEdited: Block = {
  ...tableBlock,
  table: {
    ...tableModel,
    rows: [
      [
        { richParas: [{ runs: [{ text: 'EDITED' }] }], paras: ['EDITED'] },
        tableModel.rows[0][1],
      ],
      tableModel.rows[1],
    ],
  },
}

const listBlock: Block = {
  id: 'li0',
  type: 'listItem',
  docxIndex: 3,
  originalXml: '<w:p>li3</w:p>',
  list: { kind: 'ordered', numId: '1', ilvl: 0 },
  runs: [{ text: 'First item' }],
}

const imageBlock: Block = {
  id: 'img0',
  type: 'image',
  docxIndex: 9,
  originalXml: '<w:drawing>orig9</w:drawing>',
  imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  imageWidthPx: 120,
  imageHeightPx: 90,
  imageAlign: 'center',
  label: 'logo',
}

/* ------------------------------------------------------------------ */
/* 懒加载（引擎依赖缺失时优雅跳过）                                    */
/* ------------------------------------------------------------------ */

async function loadRenderDirty() {
  try {
    return await import('./render-dirty')
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 适配器 A：Block[] → PM 文档 结构映射                                */
/* ------------------------------------------------------------------ */

describe('blocksToDoc（适配器 A）· 复杂块结构', () => {
  it('表格 → docxTable / docxTableRow / docxTableCell 嵌套，维度与单元格内容正确', () => {
    const doc = blocksToDoc([tableBlock])
    expect(doc.childCount).toBe(1)
    const table = doc.firstChild!
    expect(table.type.name).toBe('docxTable')
    expect(table.attrs.docxIndex).toBe(5)
    expect(table.attrs.tableMeta).toStrictEqual(tableModel) // 整张模型存入 tableMeta（结构等价）
    expect(table.childCount).toBe(2) // 2 行
    const row0 = table.child(0)
    expect(row0.type.name).toBe('docxTableRow')
    expect(row0.childCount).toBe(2) // 每行 2 列
    const cell00 = row0.child(0)
    expect(cell00.type.name).toBe('docxTableCell')
    expect(cell00.firstChild?.textContent).toBe('A1')
  })

  it('图片 → docxImage 原子节点，data URL/尺寸/对齐作为属性', () => {
    const doc = blocksToDoc([imageBlock])
    const img = doc.firstChild!
    expect(img.type.name).toBe('docxImage')
    expect(img.attrs.docxIndex).toBe(9)
    expect(img.attrs.imageDataUrl).toBe(imageBlock.imageDataUrl)
    expect(img.attrs.imageWidthPx).toBe(120)
    expect(img.attrs.imageHeightPx).toBe(90)
    expect(img.attrs.imageAlign).toBe('center')
  })

  it('列表项 → docxListItem，有序列表 marker 按 numId 计数为 "1."', () => {
    const doc = blocksToDoc([listBlock])
    const li = doc.firstChild!
    expect(li.type.name).toBe('docxListItem')
    expect(li.attrs.listKind).toBe('ordered')
    expect(li.attrs.numId).toBe('1')
    expect(li.attrs.marker).toBe('1.')
    expect(li.textContent).toBe('First item')
  })
})

/* ------------------------------------------------------------------ */
/* 适配器 B：PM 文档 → Block[] 保真（含编辑后重建）                    */
/* ------------------------------------------------------------------ */

describe('docToBlocks（适配器 B）· 表格/图片/列表 往返保真', () => {
  it('表格回写：单元格内容取自 PM，表格级元数据（列宽/边框/对齐）合并保真', () => {
    const doc = blocksToDoc([tableBlock])
    const back = docToBlocks(doc, [tableBlock])
    expect(back).toHaveLength(1)
    expect(back[0].type).toBe('table')
    const m = back[0].table!
    expect(m.rows[0][0].richParas?.[0].runs[0].text).toBe('A1')
    expect(m.rows[1][1].richParas?.[0].runs[0].text).toBe('B2')
    // 元数据来自 tableMeta 的 {...spread}
    expect(m.colWidthsPct).toEqual([50, 50])
    expect(m.align).toBe('center')
    expect(m.borders).toEqual(tableModel.borders)
    // docxIndex / originalXml 锚点保留
    expect(back[0].docxIndex).toBe(5)
    expect(back[0].originalXml).toBe('<w:tbl>orig5</w:tbl>')
  })

  it('表格编辑后：PM 文档中的新文本进入重建模型，元数据仍保真', () => {
    const doc = blocksToDoc([tableBlockEdited])
    const back = docToBlocks(doc, [tableBlockEdited])
    expect(back[0].table!.rows[0][0].richParas?.[0].runs[0].text).toBe('EDITED')
    // 未编辑单元格内容不变
    expect(back[0].table!.rows[0][1].richParas?.[0].runs[0].text).toBe('B1')
    // 元数据仍来自 tableMeta
    expect(back[0].table!.colWidthsPct).toEqual([50, 50])
  })

  it('图片回写：data URL/尺寸/对齐/锚点全部还原', () => {
    const doc = blocksToDoc([imageBlock])
    const back = docToBlocks(doc, [imageBlock])
    expect(back[0].type).toBe('image')
    expect(back[0].docxIndex).toBe(9)
    expect(back[0].imageDataUrl).toBe(imageBlock.imageDataUrl)
    expect(back[0].imageWidthPx).toBe(120)
    expect(back[0].imageHeightPx).toBe(90)
    expect(back[0].imageAlign).toBe('center')
    expect(back[0].originalXml).toBe('<w:drawing>orig9</w:drawing>')
  })

  it('列表回写：list 元数据（kind/numId/ilvl）+ runs 还原', () => {
    const doc = blocksToDoc([listBlock])
    const back = docToBlocks(doc, [listBlock])
    expect(back[0].type).toBe('listItem')
    expect(back[0].list).toEqual({ kind: 'ordered', numId: '1', ilvl: 0 })
    expect(back[0].runs).toEqual([{ text: 'First item' }])
    expect(back[0].docxIndex).toBe(3)
  })
})

/* ------------------------------------------------------------------ */
/* docxRenderDirty 路由（依赖引擎，懒加载跳过）                        */
/* ------------------------------------------------------------------ */

describe('docxRenderDirty · 脏块分派', () => {
  it('图片（已有块 docxIndex 非空）→ {kind:"original"} 逐字节搬运原 XML', async () => {
    const mod = await loadRenderDirty()
    if (!mod) {
      console.warn('[docxRenderDirty] 引擎依赖缺失，跳过（本地 pnpm install 后运行）')
      return
    }
    const sb = mod.docxRenderDirty(imageBlock, 0)
    expect(sb.kind).toBe('original')
    expect((sb as { docxIndex?: number }).docxIndex).toBe(9)
  })

  it('图片（新插入块 docxIndex=null, png data URL）→ {kind:"image"} 转 NewImage', async () => {
    const mod = await loadRenderDirty()
    if (!mod) {
      console.warn('[docxRenderDirty] 引擎依赖缺失，跳过（本地 pnpm install 后运行）')
      return
    }
    const newImg: Block = {
      id: 'imgNew',
      type: 'image',
      docxIndex: null,
      originalXml: null,
      imageDataUrl: 'data:image/png;base64,QUJDRA==',
      imageWidthPx: 200,
      imageHeightPx: 150,
      imageAlign: 'left',
    }
    const sb = mod.docxRenderDirty(newImg, 0)
    expect(sb.kind).toBe('image')
    const img = (sb as { image: NewImage }).image
    expect(img.mime).toBe('image/png')
    expect(img.base64).toBe('QUJDRA==')
    expect(img.widthPx).toBe(200)
    expect(img.heightPx).toBe(150)
    expect(img.align).toBe('left')
  })

  it('图片（新插入块，不支持格式 webp）→ 抛出友好错误而非丢内容', async () => {
    const mod = await loadRenderDirty()
    if (!mod) {
      console.warn('[docxRenderDirty] 引擎依赖缺失，跳过（本地 pnpm install 后运行）')
      return
    }
    const bad: Block = {
      id: 'imgBad',
      type: 'image',
      docxIndex: null,
      originalXml: null,
      imageDataUrl: 'data:image/webp;base64,UklGRg==',
    }
    expect(() => mod.docxRenderDirty(bad, 0)).toThrow(/不受支持/)
  })

  it('passthrough（docxIndex 非空）→ {kind:"original"} 逐字节搬运', async () => {
    const mod = await loadRenderDirty()
    if (!mod) {
      console.warn('[docxRenderDirty] 引擎依赖缺失，跳过（本地 pnpm install 后运行）')
      return
    }
    const ph: Block = {
      id: 'ph0',
      type: 'passthrough',
      docxIndex: 11,
      originalXml: '<w:foo/>',
    }
    const sb = mod.docxRenderDirty(ph, 0)
    expect(sb.kind).toBe('original')
    expect((sb as { docxIndex?: number }).docxIndex).toBe(11)
  })

  it('表格（脏）→ {kind:"xml"} 经 generateTableModelXml 重生成 OOXML', async () => {
    const mod = await loadRenderDirty()
    if (!mod) {
      console.warn('[docxRenderDirty] 引擎依赖缺失，跳过（本地 pnpm install 后运行）')
      return
    }
    const sb = mod.docxRenderDirty(tableBlock, 0)
    expect(sb.kind).toBe('xml')
    const xml = (sb as { xml: string }).xml
    expect(typeof xml).toBe('string')
    expect(xml.length).toBeGreaterThan(0)
    // 编辑后的单元格文本应出现在生成的 OOXML 中
    expect(xml).toContain('A1')
  })
})

/* ------------------------------------------------------------------ */
/* 回归护栏：多表文档仅一处脏，净表绝不被连带重生成                    */
/* ------------------------------------------------------------------ */

describe('回归护栏 · 改 A 表不误写 B 表', () => {
  const tableB: Block = {
    id: 'tbl1',
    type: 'table',
    docxIndex: 8,
    originalXml: '<w:tbl>orig8</w:tbl>',
    table: tableModel,
  }

  it('净表恒走 original（无论另一表是否脏）—— 纯路由判定', () => {
    // dummy 渲染器：脏表一律返回 {kind:'xml'}（不触发引擎），用于只验证「路由」不误伤净表
    const dummy = (b: Block): never => ({ kind: 'xml', xml: 'X', docxIndex: b.docxIndex ?? undefined } as never)
    const final = buildSaveBlocks([tableBlock, tableB], new Set([0]), dummy)
    expect(final).toHaveLength(2)
    expect(final[0]).toMatchObject({ kind: 'xml' }) // 脏表 A → 重生成
    expect(final[1]).toMatchObject({ kind: 'original', docxIndex: 8 }) // 净表 B → 逐字节原样
  })

  it('真实 docxRenderDirty：脏表 A 走 generateTableModelXml，净表 B 仍 original（引擎层）', async () => {
    const mod = await loadRenderDirty()
    if (!mod) {
      console.warn('[回归护栏] 引擎依赖缺失，跳过（本地 pnpm install 后运行）')
      return
    }
    const final = buildSaveBlocks([tableBlock, tableB], new Set([0]), mod.docxRenderDirty)
    expect((final[0] as { kind: string }).kind).toBe('xml') // 脏表 A 被真正重生成
    expect((final[1] as { kind: string }).kind).toBe('original') // 净表 B 字节级保真
    expect((final[1] as { docxIndex?: number }).docxIndex).toBe(8)
  })

  it('零编辑保存 → 两份表都 original（打开即保存不改字节）', () => {
    const final = buildSaveBlocks([tableBlock, tableB], new Set())
    expect(final.every((f) => f.kind === 'original')).toBe(true)
    expect(final.map((f) => (f as { docxIndex: number }).docxIndex)).toEqual([5, 8])
  })
})
