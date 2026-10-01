/**
 * 适配器 B 单测（不依赖引擎运行时）
 * 验证：PM 文档 → Block[] 的 mark 提取、docxIndex 对齐、新建块（docxIndex=null）处理。
 */
import { type Mark } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { docToBlocks } from './tiptap-to-blocks'
import { docxSchema } from './docx-schema'

function text(t: string, marks: readonly Mark[] = []) {
  return docxSchema.text(t, marks)
}

describe('docToBlocks（适配器 B）', () => {
  it('提取标准 mark 为 Run 建模字段', () => {
    const doc = docxSchema.nodes.doc.createChecked({}, [
      docxSchema.nodes.paragraph.createChecked(
        { docxIndex: 7, styleId: null },
        [text('Bold', [docxSchema.marks.strong.create()]), text(' and strike', [docxSchema.marks.strike.create()])],
      ),
    ])
    const blocks = docToBlocks(doc, [])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].docxIndex).toBe(7)
    expect(blocks[0].runs).toEqual([
      { text: 'Bold', bold: true },
      { text: ' and strike', strike: true },
    ])
  })

  it('提取 runFormat mark 的 color / size / font', () => {
    const doc = docxSchema.nodes.doc.createChecked({}, [
      docxSchema.nodes.heading.createChecked(
        { level: 3, docxIndex: 2, styleId: null },
        [text('X', [docxSchema.marks.runFormat.create({ color: '00FF00', sizeHalfPoints: 24, font: 'Calibri' })])],
      ),
    ])
    const blocks = docToBlocks(doc, [])
    expect(blocks[0].type).toBe('heading')
    expect(blocks[0].level).toBe(3)
    expect(blocks[0].runs).toEqual([
      { text: 'X', color: '00FF00', sizeHalfPoints: 24, font: 'Calibri' },
    ])
  })

  it('docxIndex 为 null 的块视为新建（无 originalXml / rawPPr 回带）', () => {
    const doc = docxSchema.nodes.doc.createChecked({}, [
      docxSchema.nodes.paragraph.createChecked({ docxIndex: null, styleId: null }, text('new')),
    ])
    const blocks = docToBlocks(doc, [])
    expect(blocks[0].docxIndex).toBeNull()
    expect(blocks[0].originalXml).toBeNull()
    expect(blocks[0].rawPPr).toBeUndefined()
    expect(blocks[0].id).toMatch(/^b\d+$/)
  })

  it('按 docxIndex 从 originalBlocks 回带 rawPPr / format / styleId', () => {
    const doc = docxSchema.nodes.doc.createChecked({}, [
      docxSchema.nodes.paragraph.createChecked({ docxIndex: 4, styleId: null }, text('kept')),
    ])
    const blocks = docToBlocks(doc, [
      {
        id: 'orig4',
        type: 'paragraph',
        docxIndex: 4,
        originalXml: '<w:p>4</w:p>',
        rawPPr: '<w:pPr/>',
        styleId: 'Normal',
        format: { align: 'center' } as never,
        runs: [],
      },
    ])
    expect(blocks[0].rawPPr).toBe('<w:pPr/>')
    expect(blocks[0].styleId).toBe('Normal')
    expect(blocks[0].format).toEqual({ align: 'center' })
  })
})
