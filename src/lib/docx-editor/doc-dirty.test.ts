/**
 * DocDirtyTracker（S1 ② 阶段 3 · 脏块追踪内核）
 *
 * 验证「只有持久化状态才算脏」不变量：
 *   - 脏标记锚定在 docxIndex（持久化块身份），不随顶层位置变化而错位；
 *   - 新建块（docxIndex=null）恒为脏；
 *   - clear() 后归零，可跳过写回；
 *   - toArrayIndexSet 把 docxIndex 脏集正确换算回 newBlocks 数组下标。
 */
import { describe, expect, it } from 'vitest'
import type { Block } from '@/lib/docx-engine'
import { DocDirtyTracker } from './doc-dirty'

function block(docxIndex: number | null, id = `b${docxIndex ?? 'new'}`): Block {
  return {
    id,
    type: 'paragraph',
    docxIndex,
    runs: [{ text: 'x' }],
    originalXml: null,
  } as Block
}

describe('DocDirtyTracker', () => {
  it('脏标记跟随 docxIndex 身份，不因顶层位置变化而错位', () => {
    const t = new DocDirtyTracker()
    // 编辑时文档重排：原始 [A@0, B@1, C@2] → 新顺序 [A@0, C@2, B@1]
    // 只动了 identity=1 的块 B（现在落在数组下标 2）
    t.markTouched(1)
    expect(t.isDirty(0)).toBe(false)
    expect(t.isDirty(1)).toBe(true)
    expect(t.isDirty(2)).toBe(false)

    const newBlocks = [block(0, 'A'), block(2, 'C'), block(1, 'B')]
    const idx = t.toArrayIndexSet(newBlocks)
    // 脏标记跟随 B 的身份到其新位置（下标 2），且未因占据 B 旧下标(1) 的 C 而误标
    expect(idx.has(0)).toBe(false) // A 干净
    expect(idx.has(1)).toBe(false) // C 占据旧下标，但身份 2 干净 → 不误标
    expect(idx.has(2)).toBe(true) // B 真实脏，落在下标 2
  })

  it('新建块（docxIndex=null）恒为脏', () => {
    const t = new DocDirtyTracker()
    const newBlocks = [block(0, 'A'), block(null, 'NEW')]
    const idx = t.toArrayIndexSet(newBlocks)
    expect(idx.has(1)).toBe(true)
    expect(t.isDirty(null)).toBe(false) // null 本身不是有效身份
  })

  it('clear() 归零后可跳过写回', () => {
    const t = new DocDirtyTracker()
    t.markTouched(3)
    t.markTouched(7)
    expect(t.size).toBe(2)
    t.clear()
    expect(t.size).toBe(0)
    expect(t.toArrayIndexSet([block(3), block(7)]).size).toBe(0)
  })

  it('markAll 把所有原始块标脏（未知 step 的保守回退）', () => {
    const t = new DocDirtyTracker()
    const parsed: Block[] = [block(0, 'A'), block(1, 'B'), block(2, 'C')]
    t.markAll(parsed)
    expect(t.size).toBe(3)
    expect(t.isDirty(1)).toBe(true)
  })
})
