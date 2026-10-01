/**
 * 脏块追踪（dirty top-level block tracking）
 *
 * 移植自 GenOffice `apps/docs/src/renderer/editor/touched-blocks.ts`
 * （commit 05b4bd6e4b23102b2e85847b49b5f9cc94c33797，Apache-2.0），
 * 逻辑与上游逐行一致，仅补注释与中文说明。
 *
 * ## 为什么需要它
 * docx「真编辑」的核心是：保存时**只重写被改动的顶层块**，未改动的块按原 XML 片段
 * 逐字节透传（见 `lib/docx-engine` 的 `SaveBlock` / `saveDocx`；未改动时 `saveDocx`
 * 直接返回原始字节，见 `patch.ts` 的 `isUnchanged` 早退）。
 *
 * ProseMirror 只告诉我们「发生了哪些 step」，并不直接给出「哪些顶层块受影响」。
 * 本模块负责这个推导；`save-blocks.ts` 再把它翻译成 `SaveBlock[]`。
 *
 * ## 四条设计决策（改动前务必读懂 —— 任一处出错都会导致用户改动丢失或文档损坏）
 * 1. **坐标映射**：第 i 个 step 的 mapping 给出的是「该 step 之后」的坐标，
 *    必须再经**其后所有** mapping（j = i+1 … end）逐级 `map()`，才能落到**最终文档**坐标。
 * 2. **mark / attribute 回退**：mark、attribute 类 step 不移动位置（其 mapping 为空），
 *    此时读 step 自身的 `from`/`to`；只有 `pos` 时取 `pos..pos+1`（须覆盖该位置的节点）。
 * 3. **未知即全量**：既无范围、也无 `from`/`to`/`pos` 的 step（未知类型）→ 直接返回 `null`。
 *    宁可全量重算，也绝不漏块 —— 漏块的后果是静默丢失用户改动。
 * 4. **过半即全量**：受影响块数 > 总块数一半 → 返回 `null`，此时逐块拼接已不划算。
 *
 * ## 返回契约
 * - 返回**最终文档中顶层节点的 offset**（不是下标！）。需要下标请用同文件的
 *   `touchedTopLevelIndices(tr)` —— 它就是这个换算的收口点。
 * - 返回 `null` 表示「必须全量重算」，消费侧应走全量分支而非逐块优化。
 */
import type { Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'

/**
 * Top-level blocks a transaction touched, as offsets in its final document;
 * null when a step replaces so much that recomputing everything is cheaper.
 */
export function touchedTopLevelBlocks(tr: Transaction): Set<number> | null {
  const { doc } = tr
  const maps = tr.mapping.maps
  const ranges: Array<[number, number]> = []
  let unknown = false
  tr.steps.forEach((step, i) => {
    // positions after step i, carried through the later steps into the final doc
    const push = (start: number, end: number) => {
      let from = start
      let to = end
      for (let j = i + 1; j < maps.length; j++) {
        from = maps[j].map(from, -1)
        to = maps[j].map(to, 1)
      }
      ranges.push([from, to])
    }
    let moved = false
    maps[i].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      moved = true
      push(newStart, newEnd)
    })
    if (moved) return
    // mark and attribute steps leave positions alone but change the nodes
    const s = step as { from?: unknown; to?: unknown; pos?: unknown }
    if (typeof s.from === 'number' && typeof s.to === 'number') push(s.from, s.to)
    else if (typeof s.pos === 'number') push(s.pos, s.pos + 1)
    else unknown = true
  })
  if (unknown) return null
  const touched = new Set<number>()
  doc.forEach((node, offset) => {
    const end = offset + node.nodeSize
    if (ranges.some(([from, to]) => offset < to && end > from)) touched.add(offset)
  })
  return touched.size * 2 > doc.childCount ? null : touched
}

/**
 * 与 `touchedTopLevelBlocks` 同源，但把 **offset 换算成最终文档中顶层子节点的下标**。
 *
 * 消费侧（`save-blocks.ts` → `Block[]`）拿不到 PM 坐标，只认"第几个块"，
 * 而 `touchedTopLevelBlocks` 的返回契约明确是 offset（≠ 下标，见文件头）。
 * 本函数就是这个契约的收口点 —— 两者**必须同时使用**，不可只取其一。
 *
 * ⚠️ 返回的 `null` 语义与 `touchedTopLevelBlocks` 完全一致：必须全量重算。
 */
export function touchedTopLevelIndices(tr: Transaction): Set<number> | null {
  const offsets = touchedTopLevelBlocks(tr)
  if (offsets === null) return null
  const indices = new Set<number>()
  let index = 0
  // doc.forEach 按文档顺序遍历，故 index 恰为顶层子节点下标
  tr.doc.forEach((_node, offset) => {
    if (offsets.has(offset)) indices.add(index)
    index += 1
  })
  return indices
}

/** a single insertion at the document end: every existing position survives unchanged */
export function appendsAtEnd(tr: Transaction): boolean {
  if (tr.steps.length !== 1) return false
  const step = tr.steps[0]
  if (!(step instanceof ReplaceStep)) return false
  return step.from === step.to && step.from === tr.before.content.size
}