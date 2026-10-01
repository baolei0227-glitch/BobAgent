/**
 * 脏块 → `SaveBlock[]` 装配单测（src/lib/docx-editor/save-blocks.ts）
 *
 * 本组用例的锚点是一条**外部契约**：`docx-engine/patch.ts` 的 `saveDocx` 在
 * `isUnchanged` 为真时直接返回 `originalBytes`（逐字节不变，`:464`）。而
 * `isUnchanged`（`:422-430`）要求：
 *
 *   finalBlocks.length === parsed.blocks.filter(b => !b.hidden).length
 *   且每一项都是 { kind:'original', docxIndex: 可见块的 docxIndex, revision: undefined }
 *
 * 因此下面的 `unchangedShape()` 就是那段判据的复刻——"全部干净"一条用例直接断言
 * 它成立，等于断言"打开即保存不改字节"这条能力没有被本文件破坏。
 */
import type { Block, SaveBlock } from '@/lib/docx-engine'
import { describe, expect, it } from 'vitest'

import { buildSaveBlocks, defaultRenderDirtyBlock, toGeneratedBlock } from './save-blocks'

/** 构造最小可用块；`docxIndex === null` 表示编辑器新建块 */
function blk(o: {
  id: string
  type?: Block['type']
  docxIndex?: number | null
  hidden?: boolean
  invisibleMarker?: boolean
}): Block {
  const docxIndex = o.docxIndex === undefined ? 0 : o.docxIndex
  return {
    id: o.id,
    type: o.type ?? 'paragraph',
    docxIndex,
    originalXml: docxIndex === null ? null : `<w:p>${o.id}</w:p>`,
    hidden: o.hidden,
    invisibleMarker: o.invisibleMarker,
  }
}

/** 复刻 saveDocx 的 isUnchanged 判据（patch.ts:422-430，忽略与之无关的 options 部分） */
function unchangedShape(finalBlocks: readonly SaveBlock[], parsedBlocks: readonly Block[]): boolean {
  const visibleOriginalOrder = parsedBlocks.filter((b) => !b.hidden).map((b) => b.docxIndex)
  return (
    finalBlocks.length === visibleOriginalOrder.length &&
    finalBlocks.every(
      (fb, i) => fb.kind === 'original' && fb.docxIndex === visibleOriginalOrder[i] && fb.revision === undefined,
    )
  )
}

describe('buildSaveBlocks', () => {
  it('全部干净 ⇒ 输出恰为可见块的 original 序列（= saveDocx 逐字节早退的形状）', () => {
    const blocks = [blk({ id: 'a', docxIndex: 0 }), blk({ id: 'b', docxIndex: 1 }), blk({ id: 'c', docxIndex: 2 })]
    const out = buildSaveBlocks(blocks, new Set<number>())

    expect(out).toEqual([
      { kind: 'original', docxIndex: 0 },
      { kind: 'original', docxIndex: 1 },
      { kind: 'original', docxIndex: 2 },
    ])
    // 关键断言：这条路径必须让 saveDocx 走 originalBytes 早退
    expect(unchangedShape(out, blocks)).toBe(true)
  })

  it('一个脏块 ⇒ 仅该块 generated（带 docxIndex），其余 original，且不再满足 isUnchanged', () => {
    const blocks = [blk({ id: 'a', docxIndex: 0 }), blk({ id: 'b', docxIndex: 1 }), blk({ id: 'c', docxIndex: 2 })]
    const out = buildSaveBlocks(blocks, new Set([1]))

    expect(out[0]).toEqual({ kind: 'original', docxIndex: 0 })
    expect(out[1]).toEqual({
      kind: 'generated',
      block: expect.objectContaining({ type: 'paragraph', runs: [] }),
      docxIndex: 1,
    })
    expect(out[2]).toEqual({ kind: 'original', docxIndex: 2 })
    expect(unchangedShape(out, blocks)).toBe(false)
  })

  it('新块（docxIndex === null）⇒ generated 且不带 docxIndex', () => {
    const blocks = [blk({ id: 'a', docxIndex: 0 }), blk({ id: 'new', docxIndex: null })]
    const out = buildSaveBlocks(blocks, new Set([1]))

    expect(out[0]).toEqual({ kind: 'original', docxIndex: 0 })
    expect((out[1] as { kind: string; docxIndex?: number }).kind).toBe('generated')
    expect((out[1] as { kind: string; docxIndex?: number }).docxIndex).toBeUndefined()
  })

  it('新块即使被漏标为干净也仍然生成（兜底，绝不静默丢弃）', () => {
    const blocks = [blk({ id: 'a', docxIndex: 0 }), blk({ id: 'new', docxIndex: null })]
    const out = buildSaveBlocks(blocks, new Set<number>())

    expect(out).toHaveLength(2)
    expect(out[1].kind).toBe('generated')
  })

  it('被删除的块（不在此次 blocks 中）自然不出现在输出里', () => {
    const blocks = [blk({ id: 'a', docxIndex: 0 }), blk({ id: 'c', docxIndex: 2 })]
    const out = buildSaveBlocks(blocks, new Set<number>())

    expect(out).toEqual([
      { kind: 'original', docxIndex: 0 },
      { kind: 'original', docxIndex: 2 },
    ])
    expect(out).toHaveLength(2)
  })

  it('hidden 块被跳过：块数必须等于可见块数，否则 saveDocx 的排序会错位', () => {
    const blocks = [
      blk({ id: 'a', docxIndex: 0 }),
      blk({ id: 'sectPr', docxIndex: 1, hidden: true }),
      blk({ id: 'b', docxIndex: 2 }),
    ]
    const out = buildSaveBlocks(blocks, new Set<number>())

    expect(out).toEqual([
      { kind: 'original', docxIndex: 0 },
      { kind: 'original', docxIndex: 2 },
    ])
    expect(unchangedShape(out, blocks)).toBe(true)
  })

  it('dirty === null ⇒ 全部可见块都走 generated（全量重算分支）', () => {
    const blocks = [
      blk({ id: 'a', docxIndex: 0 }),
      blk({ id: 'sectPr', docxIndex: 1, hidden: true }),
      blk({ id: 'b', docxIndex: 2 }),
    ]
    const out = buildSaveBlocks(blocks, null)

    expect(out).toHaveLength(2)
    expect(out.every((b) => b.kind === 'generated')).toBe(true)
    // 旧块的 docxIndex 必须保留（saveDocx 用它定位来源块）
    expect(out.map((b) => (b as { docxIndex?: number }).docxIndex)).toEqual([0, 2])
  })

  it('invisibleMarker 块（非 hidden）保持 original —— 它必须留在原位', () => {
    const blocks = [
      blk({ id: 'a', docxIndex: 0 }),
      blk({ id: 'bm', docxIndex: 1, invisibleMarker: true }),
    ]
    const out = buildSaveBlocks(blocks, new Set<number>())

    expect(out).toEqual([
      { kind: 'original', docxIndex: 0 },
      { kind: 'original', docxIndex: 1 },
    ])
  })

  it('脏块为 table 且用默认渲染器 ⇒ 显式抛错（不把表格当段落写出去）', () => {
    const blocks = [blk({ id: 't1', type: 'table', docxIndex: 0 })]
    expect(() => buildSaveBlocks(blocks, new Set([0]))).toThrowError(/table/)
    expect(() => buildSaveBlocks(blocks, new Set([0]))).toThrowError(/t1/)
  })

  it('脏块为 table 但注入自定义渲染器 ⇒ 可产出 {kind:"xml"}', () => {
    const blocks = [blk({ id: 't1', type: 'table', docxIndex: 0 })]
    const out = buildSaveBlocks(blocks, new Set([0]), (block) => ({
      kind: 'xml',
      xml: `<w:tbl>${block.id}</w:tbl>`,
      docxIndex: block.docxIndex ?? undefined,
    }))

    expect(out).toEqual([{ kind: 'xml', xml: '<w:tbl>t1</w:tbl>', docxIndex: 0 }])
  })
})

describe('toGeneratedBlock', () => {
  it('只接受 paragraph / heading / listItem', () => {
    expect(toGeneratedBlock(blk({ id: 'p', type: 'paragraph' }))?.type).toBe('paragraph')
    expect(toGeneratedBlock(blk({ id: 'h', type: 'heading' }))?.type).toBe('heading')
    expect(toGeneratedBlock(blk({ id: 'l', type: 'listItem' }))?.type).toBe('listItem')
    expect(toGeneratedBlock(blk({ id: 't', type: 'table' }))).toBeNull()
    expect(toGeneratedBlock(blk({ id: 'i', type: 'image' }))).toBeNull()
    expect(toGeneratedBlock(blk({ id: 'x', type: 'passthrough' }))).toBeNull()
  })

  it('runs 缺失时补为空数组（GeneratedBlock.runs 是必填）', () => {
    expect(toGeneratedBlock(blk({ id: 'p' }))?.runs).toEqual([])
  })

  it('默认渲染器对新块不写 docxIndex', () => {
    const out = defaultRenderDirtyBlock(blk({ id: 'new', docxIndex: null }), 0)
    expect(out.kind).toBe('generated')
    expect((out as { docxIndex?: number }).docxIndex).toBeUndefined()
  })
})
