/**
 * docx 编辑器分页扩展（S1 · 视觉分页，非像素级保真）
 *
 * 做法：用 ProseMirror 的 widget 装饰，在「应换页的顶层块之前」插入一个不可编辑的间隙，
 * 把内容推到下一张 A4 白纸上。块级换页（段落不会从中劈开），与 Word 一致。
 *
 * 关键性质：装饰（Decoration）**不进入文档模型**，因此 `getJSON`/`docToBlocks` 保存时
 * 不会带上这些间隙 —— 分页是纯视觉层，不影响 docx 字节保真。
 *
 * 2026-10-02 修正「页间灰带 + 只有第一页像纸」缺陷：
 *   旧实现把间隙当成**一整块画布灰**（`background: var(--canvas-bg)` 铺满 216px），
 *   而白纸的上下边距只在整张纸的首尾各出现一次 ⇒ 中间每一页都既无上边距也无下边距，
 *   内容直接贴着一条 216px 的灰带，视觉上只有第 1 页像一张完整的纸。
 *
 *   现改为按三段构造（间隙总高 = padTop + 2·PAGE_MARGIN_Y + PAGE_GAP）：
 *     · 段 A 白 = padTop（把上一页补足到满页）+ PAGE_MARGIN_Y（上页的下边距）
 *     · 段 B 灰 = PAGE_GAP（页与页之间**唯一**的灰色带，页码角标居中于此）
 *     · 段 C 白 = PAGE_MARGIN_Y（下页的上边距）
 *   于是每页都是完整的 A4 白纸（内容不足则页底留白），页间只剩一条细灰缝 —— 与 Word 连续视图一致。
 *
 * 换页位置与每处补足量由 React 侧测得后写入 `paginationBreaksRef`，再通过 meta 事务触发装饰重算。
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/** A4 @ 96dpi（px） */
export const PAGE_W = 794
export const PAGE_H = 1123
/** 页面边距（px，≈1in @96dpi） */
export const PAGE_MARGIN_X = 96
export const PAGE_MARGIN_Y = 96
/** 页间灰隙（px）—— 每页之间唯一的灰色带 */
export const PAGE_GAP = 24
/** 单页可用内容高（页高减去上下边距） */
export const PAGE_USABLE_H = PAGE_H - 2 * PAGE_MARGIN_Y
/** 页步进：相邻两页起点之差（灰缝也占位） */
export const PAGE_STRIDE = PAGE_H + PAGE_GAP

/**
 * 换页间隙总高。
 * @param padTop 把上一页补足到满页所需的白高（内容已超出可用区时传 0）
 */
export function pageSpacerHeight(padTop: number): number {
  return Math.max(0, padTop) + 2 * PAGE_MARGIN_Y + PAGE_GAP
}

/** React 侧测得的换页位置：顶层块下标数组（这些块应作为新页首块）+ 是否手动分页符 */
export interface PaginationBreak {
  index: number
  manual: boolean
  /** 上一页内容不足满页时，需要补的白高（px）；页内溢出时为 0 */
  padTop: number
}
export const paginationBreaksRef: { current: PaginationBreak[] } = { current: [] }

export const docxPaginationKey = new PluginKey('docxPagination')

export function setPaginationBreaks(breaks: PaginationBreak[]): void {
  paginationBreaksRef.current = breaks
}

export const DocxPagination = Extension.create({
  name: 'docxPagination',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: docxPaginationKey,
        props: {
          decorations(state) {
            const breaks = paginationBreaksRef.current
            if (!breaks.length) return DecorationSet.empty
            const decos: Decoration[] = []
            let i = 0
            let bi = 0
            state.doc.forEach((_node, offset) => {
              const hit = breaks.find((b) => b.index === i)
              if (hit) {
                const pageNo = bi + 1
                bi++
                const manual = hit.manual
                decos.push(
                  Decoration.widget(
                    offset,
                    () => {
                      // 外层整块是白（页底留白 + 上页下边距 + 下页上边距），中间挖一条灰缝
                      const el = document.createElement('div')
                      el.className = 'docx-page-spacer'
                      el.style.height = `${pageSpacerHeight(hit.padTop)}px`
                      el.setAttribute('contenteditable', 'false')

                      const gap = document.createElement('div')
                      gap.className = 'docx-page-gap'
                      gap.style.top = `${hit.padTop + PAGE_MARGIN_Y}px`
                      gap.style.height = `${PAGE_GAP}px`

                      const num = document.createElement('span')
                      num.className = 'docx-page-num'
                      num.textContent = manual ? `第 ${pageNo} 页 · 分页符` : `第 ${pageNo} 页`
                      gap.appendChild(num)
                      el.appendChild(gap)
                      return el
                    },
                    { side: -1, key: `docx-page-spacer-${i}` },
                  ),
                )
              }
              i++
            })
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})
