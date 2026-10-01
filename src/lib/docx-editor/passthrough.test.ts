/**
 * 非文本块 passthrough 往返（S1 ② 阶段 3 核心）
 *
 * 验证：非文本块经
 *   blocksToDoc（适配器 A）→ 真实编辑 → docToBlocks（适配器 B）→ buildSaveBlocks
 * 全程**不丢、不损坏**，且顺序/下标与原文一致。
 *
 * 适配器 A 对非文本块分两档（2026-09-30 起）：
 *   - 有可建模内容的 → 真实可编辑节点（如 image → `docxImage`、带 `table` 模型 → `docxTable`）；
 *   - 无可建模内容的 → `docxPlaceholder` 只读占位（如本文件夹具中**未带 `table` 模型**的表格块）。
 * 两档在适配器 B 都会回带 `docxIndex` + `originalXml`，故保存侧一律可走 passthrough 逐字节搬运。
 *
 * 仅依赖 ProseMirror schema + 适配器，不引入 Tiptap 运行时，可在沙箱直接跑。
 */
import { describe, expect, it } from 'vitest'
import type { Block, SaveBlock } from '@/lib/docx-engine'
import { blocksToDoc } from './blocks-to-tiptap'
import { docToBlocks } from './tiptap-to-blocks'
import { buildSaveBlocks, passthroughRenderDirty } from './save-blocks'

/** 构造一个含文本块 + 非文本块的混合块序列（模拟 parseDocx 产物） */
function makeBlocks(): Block[] {
  return [
    {
      id: 'p0', type: 'paragraph', docxIndex: 0, originalXml: '<w:p/>',
      runs: [{ text: '第一段', bold: true }],
    },
    {
      id: 't1', type: 'table', docxIndex: 1, originalXml: '<w:tbl><w:tr><w:tc/></w:tr></w:tbl>',
      runs: [],
    },
    {
      id: 'p2', type: 'paragraph', docxIndex: 2, originalXml: '<w:p/>',
      runs: [{ text: '第三段' }],
    },
    {
      id: 'i3', type: 'image', docxIndex: 3, originalXml: '<w:drawing/>',
      runs: [],
    },
    {
      id: 'p4', type: 'heading', docxIndex: 4, originalXml: '<w:p/>', level: 1,
      runs: [{ text: '标题' }],
    },
  ]
}

describe('passthrough：非文本块不丢不损坏', () => {
  it('适配器 A：可建模非文本块 → 真实节点；不可建模 → docxPlaceholder 占位', () => {
    const blocks = makeBlocks()
    const doc = blocksToDoc(blocks)
    const kinds: string[] = []
    doc.forEach((n) => kinds.push(n.type.name))
    expect(kinds).toEqual(['paragraph', 'docxPlaceholder', 'paragraph', 'docxImage', 'heading'])

    // 第 2 个顶层节点是表格占位
    let ph: import('@tiptap/pm/model').Node | null = null
    let i = 0
    doc.forEach((n) => { if (i === 1) ph = n; i++ })
    expect(ph).not.toBeNull()
    expect(ph!.type.name).toBe('docxPlaceholder')
    expect(ph!.attrs.docxIndex).toBe(1)
    expect(ph!.attrs.placeholderKind).toBe('table')
    expect(ph!.isAtom).toBe(true)
  })

  it('适配器 B：占位节点 → 保原样 Block（type/docxIndex/originalXml 还原）', () => {
    const blocks = makeBlocks()
    const doc = blocksToDoc(blocks)
    const out = docToBlocks(doc, blocks)
    expect(out.length).toBe(5)

    const table = out[1]
    expect(table.type).toBe('table')
    expect(table.docxIndex).toBe(1)
    expect(table.originalXml).toBe('<w:tbl><w:tr><w:tc/></w:tr></w:tbl>')

    const image = out[3]
    expect(image.type).toBe('image')
    expect(image.docxIndex).toBe(3)
    expect(image.originalXml).toBe('<w:drawing/>')

    // 文本块内容保真
    expect(out[0].runs?.[0].text).toBe('第一段')
    expect(out[0].runs?.[0].bold).toBe(true)
    expect(out[4].type).toBe('heading')
    expect(out[4].runs?.[0].text).toBe('标题')
  })

  it('buildSaveBlocks（全干净）：非文本块 → original，且下标/顺序与原文一致', () => {
    const blocks = makeBlocks()
    const doc = blocksToDoc(blocks)
    const out = docToBlocks(doc, blocks)
    const finalBlocks = buildSaveBlocks(out, new Set<number>(), passthroughRenderDirty)

    expect(finalBlocks.length).toBe(5)
    const kinds = finalBlocks.map((b) => (b as { kind: string }).kind)
    expect(kinds).toEqual(['original', 'original', 'original', 'original', 'original'])
    // 每个 original 的 docxIndex 与原块对齐
    finalBlocks.forEach((fb, idx) => {
      const orig = out[idx]
      expect((fb as { kind: 'original'; docxIndex: number }).docxIndex).toBe(orig.docxIndex)
    })
  })

  it('buildSaveBlocks（仅改第一段）：脏文本块 → generated，非文本块仍 original', () => {
    const blocks = makeBlocks()
    const doc = blocksToDoc(blocks)
    const out = docToBlocks(doc, blocks)
    // 下标 0（第一段）脏
    const finalBlocks = buildSaveBlocks(out, new Set([0]), passthroughRenderDirty)
    expect((finalBlocks[0] as { kind: string }).kind).toBe('generated')
    expect((finalBlocks[1] as { kind: string }).kind).toBe('original') // 表格
    expect((finalBlocks[2] as { kind: string }).kind).toBe('original')
    expect((finalBlocks[3] as { kind: string }).kind).toBe('original') // 图片
    expect((finalBlocks[4] as { kind: string }).kind).toBe('original')
  })

  it('passthroughRenderDirty 兜底：即使非文本块被标脏，也强制 original（不重生成损坏）', () => {
    const blocks = makeBlocks()
    const doc = blocksToDoc(blocks)
    const out = docToBlocks(doc, blocks)
    // 误把表格下标标脏
    const finalBlocks: SaveBlock[] = buildSaveBlocks(out, new Set([1]), passthroughRenderDirty)
    expect((finalBlocks[1] as { kind: 'original'; docxIndex: number }).kind).toBe('original')
    expect((finalBlocks[1] as { kind: 'original'; docxIndex: number }).docxIndex).toBe(1)
  })
})
