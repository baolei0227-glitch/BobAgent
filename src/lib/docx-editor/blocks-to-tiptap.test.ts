/**
 * 适配器 A 单测（不依赖引擎运行时）
 * 验证：Block[] → PM 文档 → 文本/类型/mark/docxIndex 映射正确，且 A→B 往返保真。
 */
import { describe, expect, it } from 'vitest'
import type { Block } from '@/lib/docx-engine/types'
import { blocksToDoc } from './blocks-to-tiptap'
import { docToBlocks } from './tiptap-to-blocks'

const sampleBlocks: Block[] = [
  {
    id: 'p0',
    type: 'paragraph',
    docxIndex: 0,
    originalXml: '<w:p>orig0</w:p>',
    rawPPr: '<w:pPr><w:jc w:val="left"/></w:pPr>',
    runs: [
      { text: 'Hello', bold: true },
      { text: ' world', italic: true },
    ],
  },
  {
    id: 'h1',
    type: 'heading',
    docxIndex: 1,
    originalXml: '<w:p>orig1</w:p>',
    level: 2,
    styleId: 'Heading2',
    runs: [{ text: 'Title', color: 'FF0000', sizeHalfPoints: 36, font: 'Arial' }],
  },
]

describe('blocksToDoc（适配器 A）', () => {
  it('文本块映射为同型 PM 节点，docxIndex 作为锚点属性', () => {
    const doc = blocksToDoc(sampleBlocks)
    expect(doc.childCount).toBe(2)
    expect(doc.firstChild?.type.name).toBe('paragraph')
    expect(doc.firstChild?.attrs.docxIndex).toBe(0)
    expect(doc.lastChild?.type.name).toBe('heading')
    expect(doc.lastChild?.attrs.level).toBe(2)
    expect(doc.lastChild?.attrs.docxIndex).toBe(1)
  })

  it('Run 建模字段映射为对应 mark（strong/em/runFormat）', () => {
    const doc = blocksToDoc(sampleBlocks)
    const para = doc.firstChild!
    expect(para.textContent).toBe('Hello world')
    // 'Hello' 带 strong，' world' 带 em
    const hello = para.child(0)
    expect(hello.isText).toBe(true)
    expect(hello.marks.some((m) => m.type.name === 'strong')).toBe(true)

    const heading = doc.lastChild!
    expect(heading.textContent).toBe('Title')
    const titleMark = heading.child(0).marks.find((m) => m.type.name === 'runFormat')
    expect(titleMark).toBeDefined()
    expect(titleMark!.attrs.color).toBe('FF0000')
    expect(titleMark!.attrs.sizeHalfPoints).toBe(36)
    expect(titleMark!.attrs.font).toBe('Arial')
  })
})

describe('blocksToDoc → docToBlocks 往返保真（适配器 A→B）', () => {
  it('文本 / 类型 / 层级 / docxIndex / 建模 mark / rawPPr 全部还原', () => {
    const doc = blocksToDoc(sampleBlocks)
    const back = docToBlocks(doc, sampleBlocks)

    expect(back).toHaveLength(2)

    expect(back[0].type).toBe('paragraph')
    expect(back[0].docxIndex).toBe(0)
    expect(back[0].rawPPr).toBe('<w:pPr><w:jc w:val="left"/></w:pPr>')
    expect(back[0].runs).toEqual([
      { text: 'Hello', bold: true },
      { text: ' world', italic: true },
    ])

    expect(back[1].type).toBe('heading')
    expect(back[1].level).toBe(2)
    expect(back[1].docxIndex).toBe(1)
    expect(back[1].styleId).toBe('Heading2')
    expect(back[1].runs).toEqual([
      { text: 'Title', color: 'FF0000', sizeHalfPoints: 36, font: 'Arial' },
    ])
  })
})
