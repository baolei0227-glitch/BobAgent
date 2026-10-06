/**
 * docx 编辑器专用 Tiptap 扩展集（S1 ② 阶段 3 内核）
 *
 * 设计约束（与 `lib/docx-editor/docx-schema.ts` 严格同名同形）：
 *   - 本扩展集产出的 ProseMirror schema 的**节点名 / mark 名 / 属性名** 必须与
 *     `docxSchema` 完全一致，这样适配器 A/B（`blocksToDoc` / `docToBlocks`）才能直接消费
 *     Tiptap 编辑器产出的文档，无需任何转换层。
 *   - 仅依赖 `@tiptap/core`（自包含，不引入 `@tiptap/extension-document|text|paragraph`，
 *     这些包在本仓未作为顶层依赖安装；StarterKit 也不 re-export 子扩展）。
 *   - mark 命名刻意用 `strong` / `em`（而非 Tiptap 默认 `bold` / `italic`），与适配器对齐。
 *
 * 节点：doc / paragraph / heading / docxPlaceholder（只读占位）
 * mark：strong / em / underline / strike / runFormat（承载 docx 字符字段）
 *      / docxIns / docxDel（修订标记 w:ins / w:del，编辑器内可见并往返保真）
 */

import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core'
import { history, redo, undo } from '@tiptap/pm/history'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { ImageNodeView, ListItemNodeView, TableNodeView, TableRowNodeView, TableCellNodeView } from './docx-nodeviews'

/**
 * 自定义命令的类型声明（Tiptap 规范做法：模块增强 `Commands` 接口）。
 * 没有这段，`addCommands()` 返回的对象无法满足 `Partial<RawCommands>`，
 * 且编辑器组件里 `commands.setParagraph()` / `toggleHeading()` 不在 `ChainedCommands` 上。
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    docxParagraph: {
      setParagraph: () => ReturnType
      setTextAlign: (align: 'left' | 'center' | 'right' | 'justify') => ReturnType
      setPageBreak: (value?: boolean) => ReturnType
      setParaFormat: (attrs: {
        align?: string | null
        pageBreakBefore?: boolean | null
        spaceBefore?: number | null
        spaceAfter?: number | null
        indentLeft?: number | null
        indentFirstLine?: number | null
        lineSpacing?: number | null
      }) => ReturnType
    }
    docxHeading: {
      setHeading: (attributes?: { level?: number }) => ReturnType
      toggleHeading: (attributes?: { level?: number }) => ReturnType
      setPageBreak: (value?: boolean) => ReturnType
      setParaFormat: (attrs: {
        align?: string | null
        pageBreakBefore?: boolean | null
        spaceBefore?: number | null
        spaceAfter?: number | null
        indentLeft?: number | null
        indentFirstLine?: number | null
        lineSpacing?: number | null
      }) => ReturnType
    }
    docxListItem: {
      toggleBulletList: () => ReturnType
      toggleNumberedList: () => ReturnType
      increaseListLevel: () => ReturnType
      decreaseListLevel: () => ReturnType
    }
    docxRunFormat: {
      setRunFormat: (attrs: { color?: string | null; sizeHalfPoints?: number | null; font?: string | null; vertAlign?: string | null }) => ReturnType
      setVertAlign: (value: 'superscript' | 'subscript') => ReturnType
    }
    docxTable: {
      insertDocxTable: (rows?: number, cols?: number) => ReturnType
      addRowAfter: () => ReturnType
      deleteRow: () => ReturnType
      addColumnAfter: () => ReturnType
      deleteColumn: () => ReturnType
    }
    docxHistory: {
      undo: () => ReturnType
      redo: () => ReturnType
    }
  }
}

// ---------- 顶层 doc ----------
export const DocxDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: 'block+',
})

// ---------- text（内联文本的承载节点，必须存在） ----------
export const DocxText = Node.create({
  name: 'text',
  group: 'inline',
})

// ---------- 段落级「同页 / 孤行」保真属性（P2 · 2026-10-04） ----------
// 引擎层**早已完整解析与生成**这三项（parse.ts:3505-3506 写入 run/para format，
// generate.ts:1152/1336/1568 写出，types.ts:453-454 定义 keepNext），
// 但编辑器层此前**零消费** —— 数据在、功能不在。
// 现在声名为节点属性，`measurePageBreaks` 据此调整换页（与既有 `pageBreakBefore` 同一模式）。
// ⚠️ 默认值必须为 `null`：`tiptap-to-blocks.ts` 的 `mergeFmt` 在值为 null 时**删除**该键，
// 于是「原文没有该属性」保持没有；而显式 `false`（`false != null`）会被保留。
const PAGINATION_FIDELITY_ATTRS = {
  /** w:keepNext —— 本段与下一段必须同页（标题与其首段同页就靠它） */
  keepNext: { default: null },
  /** w:keepLines —— 段内不允许跨页（整段必须落在同一页） */
  keepLines: { default: null },
  /** w:widowControl —— 孤行控制（缺省视为**开**：页底与下页各至少 2 行） */
  widowControl: { default: null },
} as const

// ---------- paragraph（带 docxIndex / styleId 锚点） ----------
export const DocxParagraph = Node.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return {
      ...PAGINATION_FIDELITY_ATTRS,
      docxIndex: { default: null },
      styleId: { default: null },
      align: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).style.textAlign || null,
        renderHTML: (attrs) => (attrs.align ? { style: `text-align:${attrs.align}` } : {}),
      },
      // 段落级分页符（w:pageBreakBefore）：渲染为 data 标记，真实断页由视觉分页层处理
      pageBreakBefore: {
        default: null,
        renderHTML: (attrs) => (attrs.pageBreakBefore ? { 'data-page-break': '1' } : {}),
      },
      // 段间距 / 缩进（twips，渲染为 pt 内联样式；字节保真经 Block.format 往返）
      spaceBefore: {
        default: null,
        renderHTML: (attrs) =>
          attrs.spaceBefore != null ? { style: `margin-top:${(attrs.spaceBefore as number) / 20}pt` } : {},
      },
      spaceAfter: {
        default: null,
        renderHTML: (attrs) =>
          attrs.spaceAfter != null ? { style: `margin-bottom:${(attrs.spaceAfter as number) / 20}pt` } : {},
      },
      indentLeft: {
        default: null,
        renderHTML: (attrs) =>
          attrs.indentLeft != null ? { style: `margin-left:${(attrs.indentLeft as number) / 20}pt` } : {},
      },
      indentFirstLine: {
        default: null,
        renderHTML: (attrs) =>
          attrs.indentFirstLine != null
            ? { style: `text-indent:${(attrs.indentFirstLine as number) / 20}pt` }
            : {},
      },
      // 行距（倍数，对应 ParaFormat.lineSpacing / w:spacing w:line lineRule=auto）
      lineSpacing: {
        default: null,
        renderHTML: (attrs) =>
          attrs.lineSpacing != null ? { style: `line-height:${attrs.lineSpacing}` } : {},
      },
    }
  },
  addCommands() {
    return {
      setParagraph: () => ({ commands }) => commands.setNode(this.name),
      setTextAlign:
        (align: 'left' | 'center' | 'right' | 'justify') =>
        ({ editor, chain }) => {
          const { $from } = editor.state.selection
          const type = $from.node($from.depth).type.name
          if (type !== 'paragraph' && type !== 'heading') return false
          return chain().focus().updateAttributes(type, { align }).run()
        },
      setPageBreak:
        (value?: boolean) =>
        ({ state, dispatch, tr }) => {
          const { $from } = state.selection
          const depth = $from.depth
          if (depth < 1) return false
          const node = $from.node(depth)
          const typeName = node.type.name
          if (typeName !== 'paragraph' && typeName !== 'heading') return false
          const pos = $from.before(depth)
          const next = value === undefined ? !node.attrs.pageBreakBefore : value
          if (dispatch) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, pageBreakBefore: next })
            dispatch(tr)
          }
          return true
        },
      setParaFormat:
        (attrs: {
          spaceBefore?: number | null
          spaceAfter?: number | null
          indentLeft?: number | null
          indentFirstLine?: number | null
        }) =>
        ({ state, dispatch, tr }) => {
          const { from, to } = state.selection
          let changed = false
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === 'paragraph' || node.type.name === 'heading') {
              if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
              changed = true
            }
          })
          if (changed && dispatch) dispatch(tr)
          return changed
        },
    }
  },
  parseHTML() {
    return [{ tag: 'p' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['p', mergeAttributes(HTMLAttributes), 0]
  },
})

// ---------- heading（带 level / docxIndex / styleId） ----------
export const DocxHeading = Node.create({
  name: 'heading',
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return {
      ...PAGINATION_FIDELITY_ATTRS,
      level: { default: 1 },
      docxIndex: { default: null },
      styleId: { default: null },
      align: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).style.textAlign || null,
        renderHTML: (attrs) => (attrs.align ? { style: `text-align:${attrs.align}` } : {}),
      },
      pageBreakBefore: {
        default: null,
        renderHTML: (attrs) => (attrs.pageBreakBefore ? { 'data-page-break': '1' } : {}),
      },
      spaceBefore: {
        default: null,
        renderHTML: (attrs) =>
          attrs.spaceBefore != null ? { style: `margin-top:${(attrs.spaceBefore as number) / 20}pt` } : {},
      },
      spaceAfter: {
        default: null,
        renderHTML: (attrs) =>
          attrs.spaceAfter != null ? { style: `margin-bottom:${(attrs.spaceAfter as number) / 20}pt` } : {},
      },
      indentLeft: {
        default: null,
        renderHTML: (attrs) =>
          attrs.indentLeft != null ? { style: `margin-left:${(attrs.indentLeft as number) / 20}pt` } : {},
      },
      indentFirstLine: {
        default: null,
        renderHTML: (attrs) =>
          attrs.indentFirstLine != null
            ? { style: `text-indent:${(attrs.indentFirstLine as number) / 20}pt` }
            : {},
      },
      // 行距（倍数，对应 ParaFormat.lineSpacing / w:spacing w:line lineRule=auto）
      lineSpacing: {
        default: null,
        renderHTML: (attrs) =>
          attrs.lineSpacing != null ? { style: `line-height:${attrs.lineSpacing}` } : {},
      },
    }
  },
  parseHTML() {
    return [
      { tag: 'h1', attrs: { level: 1 } },
      { tag: 'h2', attrs: { level: 2 } },
      { tag: 'h3', attrs: { level: 3 } },
      { tag: 'h4', attrs: { level: 4 } },
      { tag: 'h5', attrs: { level: 5 } },
      { tag: 'h6', attrs: { level: 6 } },
    ]
  },
  addCommands() {
    return {
      setHeading: (attributes) => ({ commands }) => commands.setNode(this.name, attributes),
      toggleHeading: (attributes) => ({ commands }) =>
        commands.toggleNode(this.name, 'paragraph', attributes),
      setPageBreak:
        (value?: boolean) =>
        ({ state, dispatch, tr }) => {
          const { $from } = state.selection
          const depth = $from.depth
          if (depth < 1) return false
          const node = $from.node(depth)
          const typeName = node.type.name
          if (typeName !== 'paragraph' && typeName !== 'heading') return false
          const pos = $from.before(depth)
          const next = value === undefined ? !node.attrs.pageBreakBefore : value
          if (dispatch) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, pageBreakBefore: next })
            dispatch(tr)
          }
          return true
        },
      setParaFormat:
        (attrs: {
          spaceBefore?: number | null
          spaceAfter?: number | null
          indentLeft?: number | null
          indentFirstLine?: number | null
        }) =>
        ({ state, dispatch, tr }) => {
          const { from, to } = state.selection
          let changed = false
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === 'paragraph' || node.type.name === 'heading') {
              if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
              changed = true
            }
          })
          if (changed && dispatch) dispatch(tr)
          return changed
        },
    }
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['h'.concat(String(node.attrs.level)), mergeAttributes(HTMLAttributes), 0]
  },
})

// ---------- docxPlaceholder（非文本块只读占位；保原样写回） ----------
export function placeholderLabel(kind: string): string {
  switch (kind) {
    case 'table': return '表格（原样保留，不可编辑）'
    case 'image': return '图片（原样保留，不可编辑）'
    case 'listItem': return '列表（原样保留，不可编辑）'
    default: return '复杂内容（原样保留，不可编辑）'
  }
}

export const DocxPlaceholder = Node.create({
  name: 'docxPlaceholder',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      docxIndex: { default: null },
      styleId: { default: null },
      placeholderKind: { default: 'passthrough' },
      label: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-docx-placeholder]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const kind = (node.attrs.placeholderKind as string) || 'passthrough'
    const label = (node.attrs.label as string | null) || placeholderLabel(kind)
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'docx-placeholder',
        'data-docx-placeholder': '1',
        'data-kind': kind,
        contenteditable: 'false',
      }),
      label,
    ]
  },
})

// ---------- docxImage（只读原子，真渲染为 <img>） ----------
export const DocxImage = Node.create({
  name: 'docxImage',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      docxIndex: { default: null },
      styleId: { default: null },
      imageDataUrl: { default: null },
      imageWidthPx: { default: null },
      imageHeightPx: { default: null },
      imageAlign: { default: null },
      label: { default: null },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView)
  },
  parseHTML() {
    return [{ tag: 'div[data-docx-image]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-docx-image': '1' })]
  },
})

// ---------- docxListItem（可编辑列表项，NodeView 渲染项目符号/编号） ----------

/** 列表切换：段落/标题 ↔ 列表项（保留内联内容）。再次点击同类列表则还原为正文。 */
function toggleListCommand(listKind: 'bullet' | 'ordered') {
  return ({ editor, state, dispatch, tr }: any) => {
    const { $from } = state.selection
    const depth = $from.depth
    if (depth < 1) return false
    const node = $from.node(depth)
    const typeName = node.type.name
    const schema = editor.schema
    if (typeName === 'docxListItem') {
      const para = schema.nodes.paragraph.createChecked({ docxIndex: null }, node.content)
      const pos = $from.before(depth)
      if (dispatch) {
        tr.replaceWith(pos, pos + node.nodeSize, para)
        dispatch(tr)
      }
      return true
    }
    if (typeName === 'paragraph' || typeName === 'heading') {
      const item = schema.nodes.docxListItem.createChecked(
        { docxIndex: null, listKind, numId: listKind === 'bullet' ? '1' : '2', ilvl: 0, marker: null },
        node.content,
      )
      const pos = $from.before(depth)
      if (dispatch) {
        tr.replaceWith(pos, pos + node.nodeSize, item)
        dispatch(tr)
      }
      return true
    }
    return false
  }
}

export const DocxListItem = Node.create({
  name: 'docxListItem',
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return {
      docxIndex: { default: null },
      styleId: { default: null },
      listKind: { default: 'bullet' },
      numId: { default: null },
      ilvl: { default: 0 },
      marker: { default: null },
    }
  },
  addCommands() {
    return {
      toggleBulletList: () => toggleListCommand('bullet'),
      toggleNumberedList: () => toggleListCommand('ordered'),
      increaseListLevel:
        () =>
        ({ state, dispatch, tr }) => {
          const { $from } = state.selection
          if ($from.depth < 1) return false
          const node = $from.node($from.depth)
          if (node.type.name !== 'docxListItem') return false
          const pos = $from.before($from.depth)
          const ilvl = Math.min((node.attrs.ilvl as number) + 1, 8)
          if (dispatch) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ilvl })
            dispatch(tr)
          }
          return true
        },
      decreaseListLevel:
        () =>
        ({ state, dispatch, tr }) => {
          const { $from } = state.selection
          if ($from.depth < 1) return false
          const node = $from.node($from.depth)
          if (node.type.name !== 'docxListItem') return false
          const pos = $from.before($from.depth)
          const ilvl = Math.max((node.attrs.ilvl as number) - 1, 0)
          if (dispatch) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ilvl })
            dispatch(tr)
          }
          return true
        },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ListItemNodeView)
  },
  parseHTML() {
    return [{ tag: 'div[data-docx-listitem]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-docx-listitem': '1' }), 0]
  },
})

// ---------- docxTableCell（仅出现在 docxTableRow 内） ----------
export const DocxTableCell = Node.create({
  name: 'docxTableCell',
  content: 'block+',
  addAttributes() {
    return {
      colSpan: { default: 1 },
      rowSpan: { default: 1 },
      fill: { default: null },
      vMerge: { default: null },
      align: { default: null },
      vAlign: { default: null },
      cellMeta: { default: null },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(TableCellNodeView)
  },
  parseHTML() {
    return [{ tag: 'td' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['td', mergeAttributes(HTMLAttributes), 0]
  },
})

// ---------- docxTableRow（仅出现在 docxTable 内） ----------
export const DocxTableRow = Node.create({
  name: 'docxTableRow',
  content: 'docxTableCell+',
  addAttributes() {
    return { rowMeta: { default: null } }
  },
  addNodeView() {
    return ReactNodeViewRenderer(TableRowNodeView)
  },
  parseHTML() {
    return [{ tag: 'tr' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['tr', mergeAttributes(HTMLAttributes), 0]
  },
})

/** 从当前选区定位表格相关祖先（节点 + 绝对位置） */
function findTableContext(state: any) {
  const $from = state.selection.$from
  let cellDepth = -1
  let rowDepth = -1
  let tableDepth = -1
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'docxTableCell' && cellDepth < 0) cellDepth = d
    if (name === 'docxTableRow' && rowDepth < 0) rowDepth = d
    if (name === 'docxTable' && tableDepth < 0) tableDepth = d
  }
  if (tableDepth < 0) return null
  return {
    $from,
    cellDepth,
    rowDepth,
    tableDepth,
    tableNode: $from.node(tableDepth),
    tablePos: $from.before(tableDepth),
  }
}

/** 收集当前表格每行的单元格（绝对位置），用于行列增删 */
function collectRows(ctx: any) {
  if (!ctx) return []
  const rows: Array<{ pos: number; node: any; cells: Array<{ pos: number; node: any }> }> = []
  const tableStart = ctx.tablePos + 1
  ctx.tableNode.forEach((row: any, offset: number) => {
    if (row.type.name !== 'docxTableRow') return
    const rowPos = tableStart + offset
    const cells: Array<{ pos: number; node: any }> = []
    row.forEach((cell: any, coff: number) => {
      cells.push({ pos: rowPos + 1 + coff, node: cell })
    })
    rows.push({ pos: rowPos, node: row, cells })
  })
  return rows
}

// ---------- docxTable（可编辑嵌套表格 + 结构命令） ----------
export const DocxTable = Node.create({
  name: 'docxTable',
  group: 'block',
  content: 'docxTableRow+',
  addAttributes() {
    return {
      docxIndex: { default: null },
      styleId: { default: null },
      tableMeta: { default: null },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(TableNodeView)
  },
  addCommands() {
    return {
      insertDocxTable:
        (rows = 3, cols = 2) =>
        ({ editor, chain }) => {
          const schema = editor.schema
          const buildCell = () =>
            schema.nodes.docxTableCell.createChecked(
              { colSpan: 1, rowSpan: 1 },
              schema.nodes.paragraph.createChecked(),
            )
          const buildRow = () =>
            schema.nodes.docxTableRow.createChecked({}, Array.from({ length: cols }, buildCell))
          const table = schema.nodes.docxTable.createChecked(
            {
              docxIndex: null,
              tableMeta: {
                colWidthsPct: Array.from({ length: cols }, () => Math.round(100 / cols)),
              },
            },
            Array.from({ length: rows }, buildRow),
          )
          return chain().insertContent(table).run()
        },
      addRowAfter:
        () =>
        ({ editor, state, dispatch, tr }) => {
          try {
            const ctx = findTableContext(state)
            if (!ctx || ctx.rowDepth < 0) return false
            const rowNode = ctx.$from.node(ctx.rowDepth)
            const colCount = rowNode.childCount
            const schema = editor.schema
            const newCells: any[] = []
            for (let c = 0; c < colCount; c++) {
              const oldCell = rowNode.child(c)
              newCells.push(
                schema.nodes.docxTableCell.createChecked(
                  {
                    colSpan: oldCell.attrs.colSpan ?? 1,
                    rowSpan: oldCell.attrs.rowSpan ?? 1,
                    fill: oldCell.attrs.fill ?? null,
                    align: oldCell.attrs.align ?? null,
                    vAlign: oldCell.attrs.vAlign ?? null,
                  },
                  schema.nodes.paragraph.createChecked(),
                ),
              )
            }
            const newRow = schema.nodes.docxTableRow.createChecked({}, newCells)
            const rowPos = ctx.$from.before(ctx.rowDepth)
            const afterPos = rowPos + rowNode.nodeSize
            if (dispatch) {
              tr.insert(afterPos, newRow)
              dispatch(tr)
            }
            return true
          } catch {
            return false
          }
        },
      deleteRow:
        () =>
        ({ state, dispatch, tr }) => {
          try {
            const ctx = findTableContext(state)
            if (!ctx || ctx.rowDepth < 0) return false
            const rowPos = ctx.$from.before(ctx.rowDepth)
            const rowNode = ctx.$from.node(ctx.rowDepth)
            if (dispatch) {
              tr.delete(rowPos, rowPos + rowNode.nodeSize)
              dispatch(tr)
            }
            return true
          } catch {
            return false
          }
        },
      addColumnAfter:
        () =>
        ({ editor, state, dispatch, tr }) => {
          try {
            const ctx = findTableContext(state)
            if (!ctx || ctx.cellDepth < 0) return false
            const rows = collectRows(ctx)
            const rowPos0 = ctx.$from.before(ctx.rowDepth)
            const curRow = rows.find((r) => r.pos === rowPos0)
            if (!curRow) return false
            let cellIndex = -1
            const curCellPos = ctx.$from.before(ctx.cellDepth)
            for (let i = 0; i < curRow.cells.length; i++) {
              if (curRow.cells[i].pos === curCellPos) cellIndex = i
            }
            if (cellIndex < 0) cellIndex = curRow.cells.length - 1
            const schema = editor.schema
            const makeCell = () =>
              schema.nodes.docxTableCell.createChecked(
                { colSpan: 1, rowSpan: 1 },
                schema.nodes.paragraph.createChecked(),
              )
            for (let r = rows.length - 1; r >= 0; r--) {
              const row = rows[r]
              const target = row.cells[cellIndex + 1]
              const at = target ? target.pos : row.pos + 1 + row.node.content.size
              if (dispatch) tr.insert(at, makeCell())
            }
            if (dispatch) dispatch(tr)
            return true
          } catch {
            return false
          }
        },
      deleteColumn:
        () =>
        ({ state, dispatch, tr }) => {
          try {
            const ctx = findTableContext(state)
            if (!ctx || ctx.cellDepth < 0) return false
            const rows = collectRows(ctx)
            const rowPos0 = ctx.$from.before(ctx.rowDepth)
            const curRow = rows.find((r) => r.pos === rowPos0)
            if (!curRow) return false
            let cellIndex = -1
            const curCellPos = ctx.$from.before(ctx.cellDepth)
            for (let i = 0; i < curRow.cells.length; i++) {
              if (curRow.cells[i].pos === curCellPos) cellIndex = i
            }
            if (cellIndex < 0) cellIndex = curRow.cells.length - 1
            for (let r = rows.length - 1; r >= 0; r--) {
              const cell = rows[r].cells[cellIndex]
              if (!cell) continue
              if (dispatch) tr.delete(cell.pos, cell.pos + cell.node.nodeSize)
            }
            if (dispatch) dispatch(tr)
            return true
          } catch {
            return false
          }
        },
    }
  },
  parseHTML() {
    return [{ tag: 'table[data-docx-table]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['table', mergeAttributes(HTMLAttributes, { 'data-docx-table': '1' }), 0]
  },
})

// ---------- marks ----------
function makeMark(
  name: string,
  tag: string,
  style: string,
) {
  return Mark.create({
    name,
    parseHTML() {
      return [{ tag }, { style }]
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, mergeAttributes(HTMLAttributes), 0]
    },
  })
}

export const DocxStrong = makeMark('strong', 'strong', 'font-weight=bold')
export const DocxEm = makeMark('em', 'em', 'font-style=italic')
export const DocxUnderline = makeMark('underline', 'u', 'text-decoration=underline')
export const DocxStrike = makeMark('strike', 's', 'text-decoration=line-through')

export const DocxRunFormat = Mark.create({
  name: 'runFormat',
  addAttributes() {
    return {
      color: { default: null },
      sizeHalfPoints: { default: null },
      font: { default: null },
      vertAlign: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-rf]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const style: string[] = []
    if (HTMLAttributes.font != null) style.push(`font-family:${String(HTMLAttributes.font)}`)
    if (HTMLAttributes.sizeHalfPoints != null) {
      const half = Number(HTMLAttributes.sizeHalfPoints)
      if (!Number.isNaN(half)) style.push(`font-size:${half / 2}pt`)
    }
    if (HTMLAttributes.color != null) style.push(`color:#${String(HTMLAttributes.color)}`)
    if (HTMLAttributes.vertAlign === 'superscript') style.push('vertical-align:super')
    else if (HTMLAttributes.vertAlign === 'subscript') style.push('vertical-align:sub')
    const attrs: Record<string, string> = { 'data-rf': '1' }
    if (style.length) attrs.style = style.join(';')
    if (HTMLAttributes.color != null) attrs['data-color'] = String(HTMLAttributes.color)
    if (HTMLAttributes.sizeHalfPoints != null) attrs['data-sz'] = String(HTMLAttributes.sizeHalfPoints)
    if (HTMLAttributes.font != null) attrs['data-font'] = String(HTMLAttributes.font)
    if (HTMLAttributes.vertAlign != null) attrs['data-va'] = String(HTMLAttributes.vertAlign)
    return ['span', mergeAttributes(attrs), 0]
  },
  addCommands() {
    return {
      // 合并式设置字符格式：保留选区已有的 color/size/font，仅覆盖传入字段，
      // 避免 setMark 用默认值（null）清掉同域其它字段。
      setRunFormat:
        (attrs: { color?: string | null; sizeHalfPoints?: number | null; font?: string | null }) =>
        ({ editor, chain }) => {
          const { state } = editor
          const { from, to } = state.selection
          const merged: Record<string, unknown> = {}
          if (from !== to) {
            state.doc.nodesBetween(from, to, (node) => {
              node.marks.forEach((m) => {
                if (m.type.name === 'runFormat') {
                  merged.color = merged.color ?? m.attrs.color
                  merged.sizeHalfPoints = merged.sizeHalfPoints ?? m.attrs.sizeHalfPoints
                  merged.font = merged.font ?? m.attrs.font
                  merged.vertAlign = merged.vertAlign ?? m.attrs.vertAlign
                }
              })
            })
          } else {
            const stored = editor.getAttributes('runFormat')
            merged.color = stored.color ?? null
            merged.sizeHalfPoints = stored.sizeHalfPoints ?? null
            merged.font = stored.font ?? null
            merged.vertAlign = stored.vertAlign ?? null
          }
          const next: Record<string, unknown> = { ...merged, ...attrs }
          Object.keys(next).forEach((k) => {
            if (next[k] == null) delete next[k]
          })
          if (Object.keys(next).length === 0) return false
          return chain().focus().setMark('runFormat', next).run()
        },
      setVertAlign:
        (value: 'superscript' | 'subscript') =>
        ({ editor, chain }) => {
          const cur = editor.getAttributes('runFormat').vertAlign as string | null | undefined
          const next = cur === value ? null : value
          return chain().focus().setRunFormat({ vertAlign: next }).run()
        },
    }
  },
})

/**
 * 修订 mark（w:ins / w:del 包裹）。编辑器内以「绿色插入 / 红色删除线」渲染，
 * 承载 author/date/id（来自引擎 RevisionInfo，仅展示与稳定 id 用）。
 * 与基础 schema 同名同形（docxIns / docxDel），适配器 A/B 才能直接消费。
 */
export const DocxIns = Mark.create({
  name: 'docxIns',
  addAttributes() {
    return {
      author: { default: null },
      date: { default: null },
      id: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-rev-ins]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const attrs: Record<string, string> = { 'data-rev-ins': '1', class: 'docx-rev-ins' }
    if (HTMLAttributes.author != null) attrs['data-author'] = String(HTMLAttributes.author)
    if (HTMLAttributes.date != null) attrs['data-date'] = String(HTMLAttributes.date)
    if (HTMLAttributes.id != null) attrs['data-rid'] = String(HTMLAttributes.id)
    return ['span', mergeAttributes(attrs), 0]
  },
})

export const DocxDel = Mark.create({
  name: 'docxDel',
  addAttributes() {
    return {
      author: { default: null },
      date: { default: null },
      id: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-rev-del]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const attrs: Record<string, string> = { 'data-rev-del': '1', class: 'docx-rev-del' }
    if (HTMLAttributes.author != null) attrs['data-author'] = String(HTMLAttributes.author)
    if (HTMLAttributes.date != null) attrs['data-date'] = String(HTMLAttributes.date)
    if (HTMLAttributes.id != null) attrs['data-rid'] = String(HTMLAttributes.id)
    return ['span', mergeAttributes(attrs), 0]
  },
})

/** 编辑器完整扩展集（顺序：结构化节点在前，marks 在后） */
// ---------- history（撤销 / 重做） ----------
/**
 * 撤销 / 重做：直接挂 prosemirror-history 插件。
 *
 * 为什么不用 @tiptap/extension-history / StarterKit：
 *   本仓未装 @tiptap/extensions；而 @tiptap/pm 是顶层依赖，@tiptap/pm/history 与
 *   docx-pagination 用的是同一份 pm 实例，不会出现双实例导致命令失效。
 *
 * 与其余机制的相互作用（都已确认）：
 *   · 装载文档的 setContent 必须带 addToHistory:false（见 DocxTiptapEditor.applyParsed），
 *     否则「撤销」会把文档退回装载前的空文档。
 *   · 分页重算 / 查找导航都是无 step 的 meta 事务，history 不记录，不会污染撤销栈。
 *   · 撤销产生的 step 会照常进入脏块追踪（touchedTopLevelIndices），因此撤销后点保存
 *     仍是安全的 passthrough 写回，只是脏集只增不减（这是 DocDirtyTracker 的既有语义）。
 */
export const DocxHistory = Extension.create({
  name: 'docxHistory',

  addOptions() {
    return { depth: 200, newGroupDelay: 400 }
  },

  addProseMirrorPlugins() {
    return [history({ depth: this.options.depth, newGroupDelay: this.options.newGroupDelay })]
  },

  addCommands() {
    return {
      undo: () => ({ state, dispatch }) => undo(state, dispatch),
      redo: () => ({ state, dispatch }) => redo(state, dispatch),
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-z': () => this.editor.commands.undo(),
      'Shift-Mod-z': () => this.editor.commands.redo(),
      'Mod-y': () => this.editor.commands.redo(),
    }
  },
})

export const docxExtensions = [
  DocxDocument,
  DocxText,
  DocxParagraph,
  DocxHeading,
  DocxPlaceholder,
  DocxImage,
  DocxListItem,
  DocxTable,
  DocxTableRow,
  DocxTableCell,
  DocxStrong,
  DocxEm,
  DocxUnderline,
  DocxStrike,
  DocxRunFormat,
  DocxIns,
  DocxDel,
  DocxHistory,
]
