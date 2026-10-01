/**
 * 引擎级编辑往返（R1 真实字节验证）
 *
 * 这是 `adapter-routing.test.ts` 在「决策层」验证之外的**端到端**补齐：真实走一遍
 *   parseDocx → blocksToDoc → 编辑事务 → touchedTopLevelIndices → docToBlocks → buildSaveBlocks → saveDocx
 * 断言：改后文本确实写进 docx（重解析可见），且块数量守恒；再零编辑保存一次字节不变（适配器路径稳定无漂移）。
 *
 * ⚠️ 需要在本地 `corepack pnpm install` 后运行（依赖 jszip / fast-xml-parser / utif2）。
 * 沙箱无这些依赖时，引擎 import 会失败 —— 本文件用懒加载 + 缺失跳过，避免拖垮其它套件。
 */
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { blocksToDoc } from './blocks-to-tiptap'
import { docToBlocks } from './tiptap-to-blocks'
import { touchedTopLevelIndices } from './dirty-blocks'
import { buildSaveBlocks } from './save-blocks'

/** 懒加载引擎；沙箱缺依赖时返回 null（测试跳过） */
async function loadEngine() {
  try {
    return await import('@/lib/docx-engine')
  } catch {
    return null
  }
}

function firstParagraphStart(doc: ReturnType<typeof blocksToDoc>): number {
  let pos = -1
  doc.forEach((node, offset) => {
    if (pos < 0 && node.type.name === 'paragraph') pos = offset + 1
  })
  return pos
}

describe('edit-round-trip（引擎级 · 需本地 pnpm install）', () => {
  it('改一段 → 保存 → 重解析：改后文本可见、块数守恒', async () => {
    const engine = await loadEngine()
    if (!engine) {
      console.warn('[edit-round-trip] 引擎依赖缺失，跳过（本地 pnpm install 后运行）')
      return
    }
    const { buildBlankDocx, parseDocx, saveDocx } = engine

    const original = await buildBlankDocx()
    const parsed = await parseDocx(original)
    expect(parsed.blocks.length).toBeGreaterThan(0)

    const doc = blocksToDoc(parsed.blocks)
    const pos = firstParagraphStart(doc)
    expect(pos).toBeGreaterThan(0)

    const tr = EditorState.create({ doc }).tr
    tr.insertText('MODIFIED', pos)
    const dirty = touchedTopLevelIndices(tr)
    // blank docx 只有 1 个可见块（末尾 w:sectPr 是 hidden、不进 PM 文档），
    // 触碰它即命中「过半即全量」(`size * 2 > childCount`) —— 返回 null（全量重算）是**合法且预期**的。
    expect(dirty === null || dirty.has(0)).toBe(true)

    const newBlocks = docToBlocks(tr.doc, parsed.blocks)
    const saved = await saveDocx(parsed, buildSaveBlocks(newBlocks, dirty))

    const reparsed = await parseDocx(saved)
    const allText = reparsed.blocks
      .map((b) => (b.runs ?? []).map((r) => r.text).join(''))
      .join('\n')
    expect(allText).toContain('MODIFIED')
    expect(reparsed.blocks.length).toBe(parsed.blocks.length)
  })

  it('编辑后零编辑再保存 → 字节不变（适配器路径稳定无漂移）', async () => {
    const engine = await loadEngine()
    if (!engine) {
      console.warn('[edit-round-trip] 引擎依赖缺失，跳过（本地 pnpm install 后运行）')
      return
    }
    const { buildBlankDocx, parseDocx, saveDocx } = engine

    const original = await buildBlankDocx()
    const parsed = await parseDocx(original)
    const doc = blocksToDoc(parsed.blocks)
    const pos = firstParagraphStart(doc)
    const tr = EditorState.create({ doc }).tr
    tr.insertText('STABLE', pos)
    const dirty = touchedTopLevelIndices(tr)!
    const saved = await saveDocx(parsed, buildSaveBlocks(docToBlocks(tr.doc, parsed.blocks), dirty))

    // 对产物零编辑再保存一次
    const reparsed = await parseDocx(saved)
    const reSaved = await saveDocx(reparsed, buildSaveBlocks(reparsed.blocks, new Set<number>()))
    expect(Array.from(reSaved)).toEqual(Array.from(saved))
  })
})
