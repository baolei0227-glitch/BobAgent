/**
 * P2 保真属性（keepNext / keepLines / widowControl）的**往返保真**单测。
 *
 * 为什么单独一个文件：P2 的分页消费侧由 Electron 靶场
 * （`pagination-p0-probe/editor-harness/p2.ts`，直接驱动产品 `measurePageBreaks`）验证；
 * 但靶场是**手工构造 JSON + `editor.commands.setContent`** 灌进编辑器的，
 * **绕过了适配器 A**。而生产链路是
 * `引擎 Block[] → blocksToDoc(docxSchema) → JSON → 编辑器 setContent(编辑器 schema)`，
 * 所以「引擎解析出的 w:keepNext 能否活着走到分页层」必须单独用适配器链路来验。
 *
 * 🔴 本文件第一版是**红**的 —— 它抓到了一个真实缺陷：
 * `docx-schema.ts` 的 paragraph/heading **未声明**这三个属性，
 * 而 `NodeType.createChecked` 走 `computeAttrs`（只遍历 schema 声明的属性）
 * ⇒ **未声明属性被静默丢弃**，适配器 A 那条写入形同虚设。
 * 修法：在 `docx-schema.ts` 与 `docx-tiptap-extensions.ts` 保持**同名同形**地声明这三项。
 */
import { describe, expect, it } from 'vitest'
import type { Block } from '@/lib/docx-engine/types'
import { blocksToDoc } from './blocks-to-tiptap'
import { docToBlocks } from './tiptap-to-blocks'
import { docxSchema } from './docx-schema'

function para(format: Record<string, unknown> | undefined): Block {
  return {
    id: 'p0',
    type: 'paragraph',
    docxIndex: 0,
    originalXml: '<w:p/>',
    format: format as never,
    runs: [{ text: 'T' }],
  }
}

const ATTRS = ['keepNext', 'keepLines', 'widowControl'] as const

describe('适配器 A · 三项保真属性必须落到 PM 节点上（不被 schema 丢弃）', () => {
  for (const name of ATTRS) {
    it(`${name}: true → 节点属性为 true`, () => {
      const doc = blocksToDoc([para({ [name]: true })])
      expect(doc.firstChild?.attrs[name]).toBe(true)
    })

    it(`${name}: 原文缺省（format 无此键）→ 节点属性为 null`, () => {
      const doc = blocksToDoc([para({})])
      expect(doc.firstChild?.attrs[name]).toBeNull()
    })

    it(`${name}: 显式 false → 节点属性为 false（不等于缺省）`, () => {
      const doc = blocksToDoc([para({ [name]: false })])
      expect(doc.firstChild?.attrs[name]).toBe(false)
    })
  }

  it('heading 与 paragraph 同形（三项属性同样可达）', () => {
    const doc = blocksToDoc([
      { id: 'h', type: 'heading', docxIndex: 0, level: 2, originalXml: '<w:p/>', format: { keepNext: true } as never, runs: [{ text: 'H' }] },
    ])
    expect(doc.firstChild?.type.name).toBe('heading')
    expect(doc.firstChild?.attrs.keepNext).toBe(true)
    expect(doc.firstChild?.attrs.keepLines).toBeNull()
    expect(doc.firstChild?.attrs.widowControl).toBeNull()
  })

  it('docxSchema 自身声明了三项（防回归：这是丢弃发生的唯一位置）', () => {
    for (const name of ATTRS) {
      expect(Object.keys(docxSchema.nodes.paragraph.spec.attrs ?? {})).toContain(name)
      expect(Object.keys(docxSchema.nodes.heading.spec.attrs ?? {})).toContain(name)
    }
  })
})

describe('适配器 A→B 往返 · 三项属性的「保留 / 删除」语义', () => {
  it('true 往返后仍在 format 上', () => {
    const src = [para({ keepNext: true, keepLines: true, widowControl: true })]
    const back = docToBlocks(blocksToDoc(src), src)
    expect(back[0].format?.keepNext).toBe(true)
    expect(back[0].format?.keepLines).toBe(true)
    expect(back[0].format?.widowControl).toBe(true)
  })

  it('显式 false 被保留（写作 false，不是删除）', () => {
    const src = [para({ keepNext: false })]
    const back = docToBlocks(blocksToDoc(src), src)
    expect(back[0].format?.keepNext).toBe(false)
    expect('keepNext' in (back[0].format ?? {})).toBe(true)
  })

  it('缺省（null）在往返后**删除该键**，不写成 false', () => {
    const src = [para({})]
    const back = docToBlocks(blocksToDoc(src), src)
    expect('keepNext' in (back[0].format ?? {})).toBe(false)
    expect('keepLines' in (back[0].format ?? {})).toBe(false)
    expect('widowControl' in (back[0].format ?? {})).toBe(false)
  })

  it('编辑器里新设的属性会被写回 format（原文没有 → 保存后有）', () => {
    // 模拟编辑器命令：在 PM 节点上把 keepNext 置 true（与 UI 面板同路径）
    const src = [para({})]
    const doc = blocksToDoc(src)
    const child = doc.firstChild!
    const edited = doc.type.create(
      doc.attrs,
      child.type.create({ ...child.attrs, keepNext: true }, child.content, child.marks),
    )
    const back = docToBlocks(edited, src)
    expect(back[0].format?.keepNext).toBe(true)
  })
})
