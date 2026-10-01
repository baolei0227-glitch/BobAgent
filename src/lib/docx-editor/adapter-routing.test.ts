/**
 * 适配器 + 脏块推导 + SaveBlock 路由 的端到端闭环（不依赖引擎运行时）
 *
 * 这是 R1 风险（saveDocx 如何把 finalBlocks 映射到原始字节）在「决策层」的验证：
 *   Block[] → PM 文档 → 编辑事务 → touchedTopLevelIndices → docToBlocks → buildSaveBlocks
 * 断言：被编辑的块走 `generated`、未编辑的块走 `original`（带 docxIndex）。
 *
 * 引擎级别的「字节级 splice 确实正确」由 `edit-round-trip.test.ts`（需本地 pnpm install）补齐。
 */
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import type { Block } from '@/lib/docx-engine/types'
import { blocksToDoc } from './blocks-to-tiptap'
import { docToBlocks } from './tiptap-to-blocks'
import { touchedTopLevelIndices } from './dirty-blocks'
import { buildSaveBlocks } from './save-blocks'

const sampleBlocks: Block[] = [
  {
    id: 'p0',
    type: 'paragraph',
    docxIndex: 0,
    originalXml: '<w:p>0</w:p>',
    runs: [{ text: 'First paragraph' }],
  },
  {
    id: 'p1',
    type: 'paragraph',
    docxIndex: 1,
    originalXml: '<w:p>1</w:p>',
    runs: [{ text: 'Second paragraph' }],
  },
  {
    id: 'h0',
    type: 'heading',
    docxIndex: 2,
    originalXml: '<w:p>2</w:p>',
    level: 1,
    runs: [{ text: 'A heading' }],
  },
]

/** 找到第 index 个顶层段落的内容起点位置 */
function paragraphContentStart(doc: ReturnType<typeof blocksToDoc>, targetIndex: number): number {
  let found = -1
  doc.forEach((node, offset, index) => {
    if (index === targetIndex && node.type.name === 'paragraph') found = offset + 1
  })
  return found
}

describe('适配器 + 脏块 + 路由 闭环', () => {
  it('编辑第 0 段 → 仅该段 generated，其余 original', () => {
    const doc = blocksToDoc(sampleBlocks)
    const pos = paragraphContentStart(doc, 0)
    expect(pos).toBeGreaterThan(0)

    const tr = EditorState.create({ doc }).tr
    tr.insertText('EDITED ', pos)
    const newDoc = tr.doc

    const dirty = touchedTopLevelIndices(tr)
    expect(dirty).not.toBeNull()
    expect(dirty!.has(0)).toBe(true)
    expect(dirty!.has(1)).toBe(false)
    expect(dirty!.has(2)).toBe(false)

    const newBlocks = docToBlocks(newDoc, sampleBlocks)
    const final = buildSaveBlocks(newBlocks, dirty!)

    expect(final[0]).toMatchObject({ kind: 'generated' })
    expect(final[1]).toMatchObject({ kind: 'original', docxIndex: 1 })
    expect(final[2]).toMatchObject({ kind: 'original', docxIndex: 2 })
  })

  it('编辑标题（第 2 个顶层节点）→ 仅标题 generated', () => {
    const doc = blocksToDoc(sampleBlocks)
    // 标题是顶层 index 2：直接定位其 content start
    let pos = -1
    doc.forEach((node, offset, index) => {
      if (index === 2 && node.type.name === 'heading') pos = offset + 1
    })
    expect(pos).toBeGreaterThan(0)

    const tr = EditorState.create({ doc }).tr
    tr.insertText('X', pos)
    const dirty = touchedTopLevelIndices(tr)!
    expect(dirty.has(2)).toBe(true)
    expect(dirty.has(0)).toBe(false)

    const final = buildSaveBlocks(docToBlocks(tr.doc, sampleBlocks), dirty)
    expect(final[2]).toMatchObject({ kind: 'generated' })
    expect(final[0]).toMatchObject({ kind: 'original', docxIndex: 0 })
  })

  it('无编辑 → 全部 original（打开即保存不改字节的前提）', () => {
    const doc = blocksToDoc(sampleBlocks)
    const newBlocks = docToBlocks(doc, sampleBlocks)
    const final = buildSaveBlocks(newBlocks, new Set<number>())
    expect(final.every((f) => f.kind === 'original')).toBe(true)
    expect(final.map((f) => (f as { docxIndex: number }).docxIndex)).toEqual([0, 1, 2])
  })
})
