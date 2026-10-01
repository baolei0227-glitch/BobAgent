/**
 * docx 编辑器分页扩展（S1 · 视觉分页，非像素级保真）
 *
 * 做法：用 ProseMirror 的 widget 装饰，在「应换页的顶层块之前」插入一个高度为 PAGE_GAP 的
 * 不可编辑间隙，使内容在视觉上落到下一页白纸上。块级换页（段落不会从中劈开），与 Word 一致。
 *
 * 关键性质：装饰（Decoration）**不进入文档模型**，因此 `getJSON`/`docToBlocks` 保存时
 * 不会带上这些间隙 —— 分页是纯视觉层，不影响 docx 字节保真。
 *
 * 换页位置由 React 侧测得后写入 `paginationBreaksRef`，再通过 meta 事务触发装饰重算。
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
/** 页间灰隙（px） */
export const PAGE_GAP = 24
/**
 * 换页间隙（装饰 spacer 高度）= 上页下边距 + 视觉页Gap + 下页上边距。
 * 这样每页首块正好落在下一白纸的可用区顶部（与单页 padding-top 一致）。
 */
export const PAGE_SPACER = 2 * PAGE_MARGIN_Y + PAGE_GAP

/** React 侧测得的换页位置：顶层块下标数组（这些块应作为新页首块）+ 是否手动分页符 */
export interface PaginationBreak {
  index: number
  manual: boolean
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
                      const el = document.createElement('div')
                      el.className = 'docx-page-spacer'
                      el.style.height = `${PAGE_SPACER}px`
                      el.setAttribute('contenteditable', 'false')
                      const num = document.createElement('span')
                      num.className = 'docx-page-num'
                      num.textContent = manual ? `第 ${pageNo} 页 · 分页符` : `第 ${pageNo} 页`
                      el.appendChild(num)
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
