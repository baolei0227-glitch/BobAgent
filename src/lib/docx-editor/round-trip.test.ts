/**
 * 端到端契约：`buildSaveBlocks` × `saveDocx`（S1 的关键验收探针）
 *
 * 前面两个测试文件都是纯函数单测，只能证明"路由逻辑按设计走"。本文件把新代码接到
 * **真实引擎**上，证明 docx 真编辑的核心承诺没有被装配层破坏：
 *
 *   全量干净 ⇒ `saveDocx` 返回 `originalBytes`（逐字节）⇒ 打开即保存不改字节。
 *
 * 这条链路一旦断裂，用户每次打开文档保存都会重写整份 XML（甚至覆盖原始格式），
 * 属最高危回归，故单独成文件。
 *
 * ⚠️ 本文件导入真实引擎，需要 `jszip` / `fast-xml-parser` / `utif2` 三个运行时依赖
 * 已安装（见 `src/lib/docx-engine/VENDOR.md`）。若报 `ERR_MODULE_NOT_FOUND`，
 * 先在 `projects/` 下执行 `corepack pnpm install`。
 */
import { buildBlankDocx, parseDocx, saveDocx } from '@/lib/docx-engine'
import { describe, expect, it } from 'vitest'

import { buildSaveBlocks } from './save-blocks'

const bytes = (u8: Uint8Array) => Array.from(u8)

/** 取第一个可被 GeneratedBlock 表达的可见块在 `parsed.blocks` 中的下标 */
function firstGeneratableIndex(parsed: Awaited<ReturnType<typeof parseDocx>>): number {
  return parsed.blocks.findIndex(
    (b) => !b.hidden && (b.type === 'paragraph' || b.type === 'heading' || b.type === 'listItem'),
  )
}

describe('buildSaveBlocks × saveDocx 端到端', () => {
  it('全量干净 ⇒ 逐字节原样返回（isUnchanged 早退生效）', async () => {
    const original = await buildBlankDocx()
    const parsed = await parseDocx(original)

    const finalBlocks = buildSaveBlocks(parsed.blocks, new Set<number>())
    const saved = await saveDocx(parsed, finalBlocks)

    expect(saved.length).toBe(original.length)
    expect(bytes(saved)).toEqual(bytes(original))
  })

  it('对同一份 docx 反复保存保持幂等', async () => {
    const original = await buildBlankDocx()
    const parsed = await parseDocx(original)

    const a = await saveDocx(parsed, buildSaveBlocks(parsed.blocks, new Set<number>()))
    const b = await saveDocx(parsed, buildSaveBlocks(parsed.blocks, new Set<number>()))

    expect(bytes(a)).toEqual(bytes(b))
    expect(bytes(a)).toEqual(bytes(original))
  })

  it('只把一个可见块标脏 ⇒ 输出不再等于原始字节（证明早退确实被打破）', async () => {
    const original = await buildBlankDocx()
    const parsed = await parseDocx(original)

    const dirtyIndex = firstGeneratableIndex(parsed)
    expect(dirtyIndex).toBeGreaterThanOrEqual(0)

    const finalBlocks = buildSaveBlocks(parsed.blocks, new Set([dirtyIndex]))
    const saved = await saveDocx(parsed, finalBlocks)

    // 脏块必然重写 <w:p>；且 docProps/core.xml 的 cp:revision/dcterms:modified
    // 无条件 +1（patch.ts:392）⇒ 字节必然不同
    expect(bytes(saved)).not.toEqual(bytes(original))
  })

  it('dirty === null（全量重算）也能保存成功且不再是原始字节', async () => {
    const original = await buildBlankDocx()
    const parsed = await parseDocx(original)

    const saved = await saveDocx(parsed, buildSaveBlocks(parsed.blocks, null))
    expect(bytes(saved)).not.toEqual(bytes(original))
  })
})
