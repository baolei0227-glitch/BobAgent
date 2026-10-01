/**
 * 脏块追踪单测（src/lib/docx-editor/dirty-blocks.ts）
 *
 * 目的：把 `touchedTopLevelBlocks` 的**四条设计决策**与**返回契约**钉死，
 * 防止后续重构（或"顺手修 bug"）破坏 docx 真编辑的增量保存前提。
 *
 * ## 证据来源（均为本仓实际安装的依赖，非记忆）
 *  - `prosemirror-transform@3.29.2` `dist/index.js:148-156` `StepMap.forEach(f)`：
 *    非 inverted 时等价于 `f(oldStart, oldStart+oldSize, newStart, newStart+newSize)`，
 *    其中 `oldSize = ranges[i+1]`、`newSize = ranges[i+2]`。
 *  - 同文件 `:707-709` `ReplaceStep.getMap()` → `new StepMap([from, to-from, slice.size])`。
 *    ⇒ **纯删除**（`slice.size === 0`）产生**零宽**新区间 `[from, from]`。
 *  - 同文件 `:1143-1157`：`setNodeMarkup` 对非叶节点生成 **ReplaceAroundStep**（非 AttrStep）；
 *    `AttrStep`（`:1806+`，持有 `pos`、`getMap()` 为 `StepMap.empty`）与 `DocAttrStep`
 *    （`:1861+`，**既无 from/to 也无 pos**）均为公开导出。
 *
 * ## 测试夹具的坐标约定
 * 段落 `doc('aa','bb','cc','dd')` 每段 `nodeSize = 2 + 文本长度`：
 *  - 2 字段落 → nodeSize 4 → 顶层 offset 依次为 0 / 4 / 8 / 12（**下标**则是 0/1/2/3）
 *  - 1 字段落 → nodeSize 3 → 顶层 offset 依次为 0 / 3 / 6 / 9
 *  因此"offset ≠ 下标"在 2 字夹具里天然可区分，可用来验证返回的是 offset 而非下标。
 */
import { Schema } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { AttrStep, DocAttrStep } from '@tiptap/pm/transform'
import { describe, expect, it } from 'vitest'

import { appendsAtEnd, touchedTopLevelBlocks, touchedTopLevelIndices } from './dirty-blocks'

// `@tiptap/pm/schema-basic` 不存在，必须手工建 Schema。
// 刻意不写 toDOM：本测试只操作文档模型，不做 DOM 序列化。
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      // AttrStep 需要一个真实存在的属性名才能落到节点上
      attrs: { indent: { default: 0 } },
    },
    text: { group: 'inline' },
  },
  marks: { strong: {} },
})

/** 构造一个段落；空串得到空段落 */
function para(text: string) {
  return schema.node('paragraph', null, text ? [schema.text(text)] : [])
}

/** 构造文档；每个入参是一个段落的文本 */
function doc(...texts: string[]) {
  return schema.node('doc', null, texts.map(para))
}

function state(...texts: string[]) {
  return EditorState.create({ doc: doc(...texts), schema })
}

/** 归一化为可断言形式：null 保持 null，否则升序数组 */
function offsets(tr: Transaction): number[] | null {
  const touched = touchedTopLevelBlocks(tr)
  return touched === null ? null : [...touched].sort((a, b) => a - b)
}

/** 同 `offsets`，但取下标版本 */
function indices(tr: Transaction): number[] | null {
  const touched = touchedTopLevelIndices(tr)
  return touched === null ? null : [...touched].sort((a, b) => a - b)
}

/** 遍历取每个顶层块的 offset，用于自校验夹具算术 */
function childOffsets(tr: Transaction): number[] {
  const out: number[] = []
  tr.doc.forEach((_node, offset) => void out.push(offset))
  return out
}

describe('touchedTopLevelBlocks', () => {
  it('无 step 时返回空集（而非 null）', () => {
    const tr = state('aa', 'bb', 'cc', 'dd').tr
    // 空集语义 = "没有任何顶层块需要重新生成"，消费侧可整体回退原始字节
    expect(offsets(tr)).toEqual([])
  })

  it('决策 1：块内插入只命中该块，且返回 offset 而非下标', () => {
    // p2 占 8..12，文本从 9 起 ⇒ 在 9 处插入必然只影响 p2
    const tr = state('aa', 'bb', 'cc', 'dd').tr.insert(9, schema.text('X'))
    // 8 = p2 的 offset（其下标是 2），证明返回的是 offset
    expect(offsets(tr)).toEqual([8])
  })

  it('决策 1：一次 step 可命中多个块（一次插入两段）', () => {
    // 在文档最前插入两个段落（各 nodeSize 3）⇒ map=[0,0,6]，区间 [0,6]
    // 覆盖新块 offset 0（0..3）与 offset 3（3..6）
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr.replaceWith(0, 0, [para('X'), para('Y')])
    expect(tr.steps.length).toBe(1)
    expect(tr.doc.childCount).toBe(6)
    expect(childOffsets(tr)).toEqual([0, 3, 6, 10, 14, 18])
    expect(offsets(tr)).toEqual([0, 3])
  })

  it('跨段替换会合并段落：只标记合并后的那一个块，集合以最终文档坐标给出', () => {
    // 实测（prosemirror Fitter 行为，非推断）：替换跨越块边界时两段被合并，
    // 顶层块数由 4 降为 3，区间 [7,8] 落在合并段（4..11）内 ⇒ 只标记该段。
    // 这条用例的作用是固定"块数会变、offset 随之重排"这一事实。
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr.replaceWith(7, 9, [schema.text('X')])
    expect(tr.doc.childCount).toBe(3)
    expect(childOffsets(tr)).toEqual([0, 4, 11])
    expect(offsets(tr)).toEqual([4])
  })

  it('回车分段（split）：两个半段都必须被标记 —— 最高频编辑操作，漏标记即丢内容', () => {
    // 在 p2（8..12，文本 9..11）内部 10 处分段：单步 ReplaceStep(10,10,size=2)，
    // 区间 [10,12] 同时落在左半段（8..11）与右半段（11..14）内
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr.split(10)
    expect(tr.steps.length).toBe(1)
    expect(tr.doc.childCount).toBe(5)
    expect(childOffsets(tr)).toEqual([0, 4, 8, 11, 14])
    expect(offsets(tr)).toEqual([8, 11])
  })

  it('ReplaceAroundStep 的多段范围：命中其所在块（保守方向＝宁可多标记，绝不少标记）', () => {
    // setNodeMarkup 对非叶节点生成 ReplaceAroundStep；实测 map=[4,1,1,7,1,1]
    // ⇒ 两段范围 [4,5) 与 [7,8)，均落在 p1（4..8）内。
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr.setNodeMarkup(4, null, { indent: 1 })
    expect(tr.steps.length).toBe(1)
    expect(tr.doc.childCount).toBe(4)
    expect(offsets(tr)).toEqual([4])
  })

  it('决策 1：后续 step 造成的位置漂移必须逐级映射到最终文档坐标', () => {
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr
    // step 0：在末段 p3（12..16，文本起于 13）内插入 'X' ⇒ 区间 [13,14]
    tr.insert(13, schema.text('X'))
    // step 1：在文档最前插入整段 'NEW'（nodeSize = 2 + 3 = 5）⇒ 其后所有位置 +5
    tr.insert(0, para('NEW'))

    expect(tr.steps.length).toBe(2)
    // 自校验：最终文档顶层 offset 应为 0 / 5 / 9 / 13 / 17
    expect(childOffsets(tr)).toEqual([0, 5, 9, 13, 17])

    // step 0 的原始区间 [13,14] 若不映射，会命中 offset 13（= p2）
    // 逐级映射后为 [18,19]，命中 offset 17（= 末段 p3）——这才是正确答案
    expect(offsets(tr)).toEqual([0, 17])
  })

  it('决策 2：mark step（mapping 为空）回退读 from/to', () => {
    // p1 占 4..8，文本 5..7；对 5..7 加 mark
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr.addMark(5, 7, schema.marks.strong.create())
    expect(tr.steps.length).toBe(1)
    // AddMarkStep.getMap() 为 StepMap.empty ⇒ 走 from/to 回退
    expect(offsets(tr)).toEqual([4])
  })

  it('决策 2：属性 step（仅有 pos）回退取 pos..pos+1', () => {
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr
    // AttrStep 持有 pos、getMap() 为 StepMap.empty、且无 from/to
    tr.step(new AttrStep(8, 'indent', 1))
    expect(tr.steps.length).toBe(1)
    // [8, 9) 命中 p2（8..12）；若回退区间不是 pos..pos+1 就会漏块
    expect(offsets(tr)).toEqual([8])
  })

  it('决策 3：既无范围也无 from/to/pos 的 step ⇒ 返回 null（宁可全量）', () => {
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr
    // DocAttrStep：无 from/to、无 pos、getMap() 为 StepMap.empty
    tr.step(new DocAttrStep('marker', 1))
    expect(tr.steps.length).toBe(1)
    expect(offsets(tr)).toBeNull()
  })

  it('决策 4：命中块数超过总数一半 ⇒ 返回 null（逐块拼接已不划算）', () => {
    // 4 个 1 字段落（nodeSize 3，offset 0/3/6/9），一次 mark 覆盖全部 4 块
    const st = state('a', 'b', 'c', 'd')
    const tr = st.tr.addMark(1, 11, schema.marks.strong.create())
    // 4 * 2 = 8 > 4 ⇒ null
    expect(offsets(tr)).toBeNull()
  })

  it('决策 4 的边界：恰好一半不触发 null', () => {
    // 4 个 1 字段落，只覆盖前 2 块（8 = p2 起点）
    const st = state('a', 'b', 'c', 'd')
    const tr = st.tr.addMark(1, 7, schema.marks.strong.create())
    // 2 * 2 = 4，不 > 4 ⇒ 保留集合
    expect(offsets(tr)).toEqual([0, 3])
  })

  it('整块删除返回空集 —— 删除由块树差异承担，不由本函数承担', () => {
    // 这是**刻意**的行为，不是缺陷：ReplaceStep.getMap() 对 slice.size === 0
    // 产生零宽区间 [4,4]，不命中任何块；被删块已不在新块树中，故无需标记。
    // ⚠️ 切勿"顺手修"成标记相邻块——那会让未被改动的块被重新生成。
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr.delete(4, 8)
    expect(tr.steps.length).toBe(1)
    expect(offsets(tr)).toEqual([])
  })

  it('块内部分删除仍能命中该块（零宽区间命中其所在块）', () => {
    // [9,9] 落在 p2（8..12）内部 ⇒ offset < 9 && end > 9 成立
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr.delete(9, 10)
    expect(offsets(tr)).toEqual([8])
  })
})

describe('touchedTopLevelIndices', () => {
  it('把 offset 换算成最终文档的顶层下标（offset ≠ 下标）', () => {
    const tr = state('aa', 'bb', 'cc', 'dd').tr.insert(9, schema.text('X'))
    // offset 是 8（见上一组用例），下标则是 2 —— 收口点必须能正确换过来
    expect(offsets(tr)).toEqual([8])
    expect(indices(tr)).toEqual([2])
  })

  it('分段后两个半段的下标都被命中', () => {
    const tr = state('aa', 'bb', 'cc', 'dd').tr.split(10)
    // 最终文档 5 个块：p0 / p1 / 左半段 / 右半段 / p3 ⇒ 下标 2 与 3
    expect(offsets(tr)).toEqual([8, 11])
    expect(indices(tr)).toEqual([2, 3])
  })

  it('多步并集：下标各自加一（前插一段使右侧整体后移）', () => {
    const st = state('aa', 'bb', 'cc', 'dd')
    const tr = st.tr.insert(1, schema.text('X')).insert(11, schema.text('Y'))
    // 最终 4 个块：p0(+X) / p1 / p2(+Y) / p3 ⇒ 下标 0 与 2
    expect(indices(tr)).toEqual([0, 2])
  })

  it('无 step ⇒ 空集；null 原样透传', () => {
    expect(indices(state('a', 'b').tr)).toEqual([])
    const st = state('a', 'b')
    const tr = st.tr
    tr.step(new DocAttrStep('marker', 1))
    expect(indices(tr)).toBeNull()
  })
})

describe('appendsAtEnd', () => {
  it('单步在文档末尾追加 ⇒ true', () => {
    const st = state('a', 'b', 'c', 'd')
    // content.size = 12（4 段 × nodeSize 3）
    const tr = st.tr.insert(12, para('e'))
    expect(tr.before.content.size).toBe(12)
    expect(appendsAtEnd(tr)).toBe(true)
  })

  it('插入点不是文档末尾 ⇒ false', () => {
    const tr = state('a', 'b', 'c', 'd').tr.insert(0, para('e'))
    expect(appendsAtEnd(tr)).toBe(false)
  })

  it('多步 ⇒ false（只认"恰好一步且在末尾追加"）', () => {
    const st = state('a', 'b', 'c', 'd')
    const tr = st.tr.insert(12, para('e')).insert(15, para('f'))
    expect(tr.steps.length).toBe(2)
    expect(appendsAtEnd(tr)).toBe(false)
  })

  it('末尾替换（非纯追加）⇒ false', () => {
    const st = state('a', 'b', 'c', 'd')
    // 替换末尾段落的内容：from !== to，不是纯追加
    const tr = st.tr.replaceWith(10, 11, [schema.text('Z')])
    expect(appendsAtEnd(tr)).toBe(false)
  })
})
