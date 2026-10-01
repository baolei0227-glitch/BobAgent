/**
 * 适配器 A：Block[] → ProseMirror 文档（docx 形 schema）
 *
 * 把引擎解析出的 `Block[]` 转成可编辑的 PM 文档：
 *   - 文本块（paragraph / heading）→ 同型 PM 节点；heading 带 `level`，两者都带 `docxIndex` 锚点 + `styleId`。
 *   - 每一条 `Run` → 一个携带对应 mark 的 text 节点（bold→strong / italic→em / underline / strike /
 *     color+size+font→runFormat）。一个 Run 一节点，保证 A→B 往返后 run 粒度 1:1 可校验。
 *   - table → 嵌套 `docxTable`/`docxTableRow`/`docxTableCell`（单元格内段落可编辑）；
 *     表格级元数据整体存入 `tableMeta`（单元格嵌套表等未建模字段随模型保留，写回时再合并）。
 *   - image → `docxImage` 原子节点（携带 data URL + 尺寸/对齐），编辑器 NodeView 真渲染。
 *   - listItem → `docxListItem`（可编辑，NodeView 渲染项目符号/编号）。
 *   - 其余无法建模的块（chart / diagram / OLE 等）→ `docxPlaceholder` 只读占位保原样。
 *   - `hidden` 块（body 末尾的 `w:sectPr` 等）**跳过、不建节点**：它们是 body 尾部元数据，
 *     `saveDocx` 写盘时会自行追加。若在这里建成占位节点，适配器 B 会把它当正文块回灌，
 *     结果保存出的 `<w:body>` 尾部出现**两个 `w:sectPr`**（每存一次多一个）。
 *
 * 注意：本适配器不引入引擎运行时依赖（仅 `import type`），可独立单测。
 */

import { type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import type { Block, Run, TableCell } from '@/lib/docx-engine/types'
import { docxSchema, blockTypeToPlaceholderKind } from './docx-schema'

/** 把一条 Run 的建模字段转成 PM mark 列表（仅含本 schema 建模的子集） */
export function marksForRun(run: Run, schema: Schema): Mark[] {
  const marks: Mark[] = []
  if (run.bold) marks.push(schema.marks.strong.create())
  if (run.italic) marks.push(schema.marks.em.create())
  if (run.underline) marks.push(schema.marks.underline.create())
  if (run.strike) marks.push(schema.marks.strike.create())

  const rfAttrs: Record<string, unknown> = {}
  if (run.color != null) rfAttrs.color = run.color
  if (run.sizeHalfPoints != null) rfAttrs.sizeHalfPoints = run.sizeHalfPoints
  if (run.font != null) rfAttrs.font = run.font
  if (run.vertAlign != null) rfAttrs.vertAlign = run.vertAlign
  if (Object.keys(rfAttrs).length > 0) marks.push(schema.marks.runFormat.create(rfAttrs))

  // 修订标记：run 处于插入/删除修订态 → 打对应 mark（互斥，至多一个）。
  // 经 /api/docx/revise apply/resolve 落盘的 w:ins/w:del 重新解析后由本分支还原为可见标记。
  if (run.ins) {
    marks.push(
      schema.marks.docxIns.create({
        author: run.ins.author ?? null,
        date: run.ins.date ?? null,
        id: run.ins.id ?? null,
      }),
    )
  } else if (run.del) {
    marks.push(
      schema.marks.docxDel.create({
        author: run.del.author ?? null,
        date: run.del.date ?? null,
        id: run.del.id ?? null,
      }),
    )
  }

  return marks
}

function runToTextNode(run: Run, schema: Schema): PMNode | null {
  if (!run.text) return null
  return schema.text(run.text, marksForRun(run, schema))
}

/** 一条 Run[] → 一个 paragraph PM 节点 */
function paragraphFromRuns(runs: Run[], schema: Schema, styleId?: string): PMNode {
  const inline: PMNode[] = []
  for (const run of runs) {
    const n = runToTextNode(run, schema)
    if (n) inline.push(n)
  }
  return schema.nodes.paragraph.createChecked(
    { docxIndex: null, styleId: styleId ?? null },
    inline.length > 0 ? inline : undefined,
  )
}

/** 一个单元格 → docxTableCell（内容为其直接段落；嵌套表等未建模字段在写回时从模型合并保真） */
function cellToNode(cell: TableCell, schema: Schema): PMNode {
  const paras: PMNode[] = []
  if (cell.richParas && cell.richParas.length > 0) {
    for (const rp of cell.richParas) paras.push(paragraphFromRuns(rp.runs ?? [], schema, rp.styleId))
  } else if (cell.paras && cell.paras.length > 0) {
    for (const p of cell.paras) paras.push(paragraphFromRuns([{ text: p }], schema))
  }
  if (paras.length === 0) paras.push(schema.nodes.paragraph.createChecked())

  const attrs: Record<string, unknown> = {
    colSpan: cell.colSpan ?? 1,
    fill: cell.fill ?? null,
    vMerge: cell.vMerge ?? null,
    align: cell.align ?? null,
    vAlign: cell.vAlign ?? null,
    cellMeta: null,
  }
  return schema.nodes.docxTableCell.createChecked(attrs, paras)
}

/** 表格块 → 嵌套 docxTable/docxTableRow/docxTableCell；表格级元数据整体存入 tableMeta */
function tableToNode(block: Block, schema: Schema): PMNode {
  const model = block.table!
  const rows: PMNode[] = []
  for (const row of model.rows) {
    const cells: PMNode[] = []
    for (const cell of row) cells.push(cellToNode(cell, schema))
    rows.push(schema.nodes.docxTableRow.createChecked({}, cells))
  }
  const meta: Record<string, unknown> = { ...(model as unknown as Record<string, unknown>) }
  return schema.nodes.docxTable.createChecked(
    { docxIndex: block.docxIndex, styleId: block.styleId ?? null, tableMeta: meta },
    rows,
  )
}

/** 列表项前缀字符（项目符号按层级；编号按 numId 顺序计数） */
function markerFor(block: Block, counters: Map<string, number>): string {
  if (!block.list) return '•'
  if (block.list.kind === 'bullet') {
    const bullets = ['•', '◦', '▸', '▪']
    return bullets[Math.min(block.list.ilvl, bullets.length - 1)] ?? '•'
  }
  const n = (counters.get(block.list.numId) ?? 0) + 1
  counters.set(block.list.numId, n)
  return `${n}.`
}

function blockToNode(block: Block, schema: Schema, counters: Map<string, number>): PMNode | null {
  if (block.type === 'paragraph' || block.type === 'heading') {
    const runs = block.runs ?? []
    const inline: PMNode[] = []
    for (const run of runs) {
      if (!run.text) continue
      inline.push(schema.text(run.text, marksForRun(run, schema)))
    }

    const fmt = block.format
    const attrs: Record<string, unknown> = {
      docxIndex: block.docxIndex,
      styleId: block.styleId ?? null,
      align: (fmt?.align as string | null | undefined) ?? null,
      pageBreakBefore: fmt?.pageBreakBefore ?? null,
      spaceBefore: fmt?.spaceBefore ?? null,
      spaceAfter: fmt?.spaceAfter ?? null,
      indentLeft: fmt?.indentLeft ?? null,
      indentFirstLine: fmt?.indentFirstLine ?? null,
      lineSpacing: fmt?.lineSpacing ?? null,
    }
    if (block.type === 'heading') attrs.level = block.level ?? 1

    const nodeType = block.type === 'heading' ? schema.nodes.heading : schema.nodes.paragraph
    return nodeType.createChecked(attrs, inline.length > 0 ? inline : undefined)
  }

  // 表格：可编辑嵌套结构（单元格内段落可编辑）
  if (block.type === 'table' && block.table) return tableToNode(block, schema)

  // 图片：原子节点，编辑器 NodeView 真渲染
  if (block.type === 'image') {
    return schema.nodes.docxImage.createChecked({
      docxIndex: block.docxIndex,
      styleId: block.styleId ?? null,
      imageDataUrl: block.imageDataUrl ?? null,
      imageWidthPx: block.imageWidthPx ?? null,
      imageHeightPx: block.imageHeightPx ?? null,
      imageAlign: block.imageAlign ?? null,
      label: block.label ?? null,
    })
  }

  // 列表项：可编辑
  if (block.type === 'listItem') {
    const runs = block.runs ?? []
    const inline: PMNode[] = []
    for (const run of runs) {
      const n = runToTextNode(run, schema)
      if (n) inline.push(n)
    }
    return schema.nodes.docxListItem.createChecked(
      {
        docxIndex: block.docxIndex,
        styleId: block.styleId ?? null,
        listKind: block.list?.kind ?? 'bullet',
        numId: block.list?.numId ?? null,
        ilvl: block.list?.ilvl ?? 0,
        marker: markerFor(block, counters),
      },
      inline.length > 0 ? inline : undefined,
    )
  }

  // 其余无法建模的块：只读占位（passthrough 保原样，不可编辑）。
  const placeholderType = schema.nodes.docxPlaceholder
  return placeholderType.createChecked({
    docxIndex: block.docxIndex,
    styleId: block.styleId ?? null,
    placeholderKind: blockTypeToPlaceholderKind(block.type),
    label: null,
  })
}

/**
 * Block[] → PM 文档。
 * @param blocks 引擎解析出的块序列
 * @param schema 目标 schema（默认 docxSchema）；真实编辑器接入时可传入其 schema（需同名节点/mark）
 * @returns PM 文档；无法建模的块转为只读占位。
 */
export function blocksToDoc(blocks: Block[], schema: Schema = docxSchema): PMNode {
  const counters = new Map<string, number>()
  const nodes: PMNode[] = []
  for (const block of blocks) {
    // hidden 块不进 PM 文档：saveDocx 会把 body 尾部元素（w:sectPr）自行追加，
    // 这里若建节点，回灌时会与那次追加重复（见文件头注释）。
    if (block.hidden) continue
    const node = blockToNode(block, schema, counters)
    if (node) nodes.push(node)
  }
  return schema.nodes.doc.createChecked({}, nodes.length > 0 ? nodes : undefined)
}
