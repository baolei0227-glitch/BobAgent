/**
 * 适配器 B：ProseMirror 文档 → Block[]
 *
 * 把编辑后的 PM 文档还原成引擎可消费的 `Block[]`，供 `buildSaveBlocks` 路由：
 *   - 顶层节点按序遍历，与编辑后文档 1:1 同序（保证 `touchedTopLevelIndices` 的下标对得上）。
 *   - 节点 `docxIndex` 决定回写锚点；通过 `originalBlocks` 按 docxIndex 查找，回带
 *     `rawPPr` / `format` / `styleId` 等编辑器不建模但写回必需的字段（纯文本编辑时 pPr 原样复用）。
 *   - mark → Run 建模字段：strong→bold / em→italic / underline / strike / runFormat→color+size+font。
 *   - table → 重建 `TableModel`（单元格内容从编辑后的 PM 段落取，其余表格/单元格字段从 tableMeta 模型合并保真）；
 *     image / listItem → 回带 docxIndex + originalXml，未改动时走 passthrough 逐字节搬运。
 *
 * 不引入引擎运行时依赖（仅 `import type`）。
 */

import { type Mark, type Node as PMNode } from '@tiptap/pm/model'
import type { Block, Run, TableModel, TableCell, TableParagraph } from '@/lib/docx-engine/types'

/** 把一段 text + 其 mark 列表转成一条 Run（仅取本 schema 建模的子集） */
export function runFromText(text: string, marks: readonly Mark[]): Run {
  const run: Run = { text }
  for (const mark of marks) {
    switch (mark.type.name) {
      case 'strong':
        run.bold = true
        break
      case 'em':
        run.italic = true
        break
      case 'underline':
        run.underline = true
        break
      case 'strike':
        run.strike = true
        break
      case 'runFormat':
        if (mark.attrs.color != null) run.color = mark.attrs.color as string
        if (mark.attrs.sizeHalfPoints != null) run.sizeHalfPoints = mark.attrs.sizeHalfPoints as number
        if (mark.attrs.font != null) run.font = mark.attrs.font as string
        if (mark.attrs.vertAlign != null) run.vertAlign = mark.attrs.vertAlign as 'superscript' | 'subscript'
        break
      case 'docxIns': {
        // run 处于插入修订态：还原为 RevisionInfo（author 必填，缺失时回退空串以保证类型合法）
        const info: { author: string; date?: string; id?: string } = {
          author: (mark.attrs.author as string | null | undefined) ?? '',
        }
        if (mark.attrs.date != null) info.date = mark.attrs.date as string
        if (mark.attrs.id != null) info.id = mark.attrs.id as string
        run.ins = info as never
        break
      }
      case 'docxDel': {
        const info: { author: string; date?: string; id?: string } = {
          author: (mark.attrs.author as string | null | undefined) ?? '',
        }
        if (mark.attrs.date != null) info.date = mark.attrs.date as string
        if (mark.attrs.id != null) info.id = mark.attrs.id as string
        run.del = info as never
        break
      }
    }
  }
  return run
}

/** 收集一个块节点内联子节点的 runs（用于 listItem 与单元格段落） */
function runsFromNode(node: PMNode): Run[] {
  const runs: Run[] = []
  node.forEach((child) => {
    if (child.isText) runs.push(runFromText(child.text ?? '', child.marks))
  })
  return runs
}

function blockFromNode(node: PMNode, index: number, originalBlocks: Block[]): Block | null {
  // 只读占位节点（chart / diagram / OLE 等无法建模内容）：保原样，回带 docxIndex + originalXml
  if (node.type.name === 'docxPlaceholder') {
    const docxIndex = (node.attrs.docxIndex as number | null) ?? null
    const kind = (node.attrs.placeholderKind as string) || 'passthrough'
    const orig = docxIndex != null ? originalBlocks.find((b) => b.docxIndex === docxIndex) : undefined
    return {
      id: orig?.id ?? `b${index}`,
      type: kind as Block['type'],
      docxIndex,
      originalXml: orig?.originalXml ?? null,
      runs: orig?.runs ?? [],
    }
  }

  // 表格：重建 TableModel（单元格内容从编辑后的 PM 段落取；其余表格/单元格字段从模型合并保真）
  if (node.type.name === 'docxTable') {
    const docxIndex = (node.attrs.docxIndex as number | null) ?? null
    const orig = docxIndex != null ? originalBlocks.find((b) => b.docxIndex === docxIndex) : undefined
    const tableMeta = ((node.attrs.tableMeta as TableModel | null) ??
      (orig?.table as TableModel | null)) as TableModel | null
    if (!tableMeta) return null
    const modelRows = tableMeta.rows
    const rebuiltRows: TableCell[][] = []
    node.forEach((rowNode, _ro, rIdx) => {
      if (rowNode.type.name !== 'docxTableRow') return
      const cells: TableCell[] = []
      rowNode.forEach((cellNode, _co, cIdx) => {
        if (cellNode.type.name !== 'docxTableCell') return
        const origCell = modelRows[rIdx]?.[cIdx]
        const richParas: TableParagraph[] = []
        cellNode.forEach((pNode) => {
          if (pNode.type.name !== 'paragraph') return
          const runs = runsFromNode(pNode)
          richParas.push({ runs })
        })
        const paras = richParas.map((rp) => rp.runs.map((r) => r.text ?? '').join(''))
        cells.push({
          ...(origCell ?? {}),
          colSpan: (cellNode.attrs.colSpan as number) ?? 1,
          rowSpan: (cellNode.attrs.rowSpan as number) ?? 1,
          fill: (cellNode.attrs.fill as string | null) ?? null,
          vMerge: (cellNode.attrs.vMerge as string | null) ?? null,
          align: (cellNode.attrs.align as string | null) ?? null,
          vAlign: (cellNode.attrs.vAlign as string | null) ?? null,
          richParas,
          paras,
        } as TableCell)
      })
      rebuiltRows.push(cells)
    })
    const table: TableModel = { ...tableMeta, rows: rebuiltRows }
    return {
      id: orig?.id ?? `b${index}`,
      type: 'table',
      docxIndex,
      originalXml: orig?.originalXml ?? null,
      table,
    }
  }

  // 图片：原子节点，回带 data URL + 尺寸/对齐；未改动时 passthrough 原 XML
  if (node.type.name === 'docxImage') {
    const docxIndex = (node.attrs.docxIndex as number | null) ?? null
    const orig = docxIndex != null ? originalBlocks.find((b) => b.docxIndex === docxIndex) : undefined
    return {
      id: orig?.id ?? `b${index}`,
      type: 'image',
      docxIndex,
      originalXml: orig?.originalXml ?? null,
      imageDataUrl: (node.attrs.imageDataUrl as string | null) ?? orig?.imageDataUrl ?? undefined,
      imageWidthPx: (node.attrs.imageWidthPx as number | null) ?? orig?.imageWidthPx ?? undefined,
      imageHeightPx: (node.attrs.imageHeightPx as number | null) ?? orig?.imageHeightPx ?? undefined,
      imageAlign:
        (node.attrs.imageAlign as 'left' | 'center' | 'right' | null) ?? orig?.imageAlign ?? undefined,
      label: (node.attrs.label as string | null) ?? orig?.label ?? undefined,
      runs: orig?.runs ?? [],
    }
  }

  // 列表项：可编辑，回带 list 元数据 + runs
  if (node.type.name === 'docxListItem') {
    const docxIndex = (node.attrs.docxIndex as number | null) ?? null
    const orig = docxIndex != null ? originalBlocks.find((b) => b.docxIndex === docxIndex) : undefined
    const runs = runsFromNode(node)
    return {
      id: orig?.id ?? `b${index}`,
      type: 'listItem',
      docxIndex,
      originalXml: orig?.originalXml ?? null,
      list: {
        kind: (node.attrs.listKind as 'bullet' | 'ordered') ?? 'bullet',
        numId: (node.attrs.numId as string | null) ?? '',
        ilvl: (node.attrs.ilvl as number) ?? 0,
      },
      styleId: (node.attrs.styleId as string | null) ?? orig?.styleId ?? undefined,
      runs,
    }
  }

  if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return null

  const docxIndex = (node.attrs.docxIndex as number | null) ?? null
  const orig = docxIndex != null ? originalBlocks.find((b) => b.docxIndex === docxIndex) : undefined

  const runs: Run[] = []
  node.forEach((child) => {
    if (child.isText) runs.push(runFromText(child.text ?? '', child.marks))
  })

  const block: Block = {
    id: orig?.id ?? `b${index}`,
    type: node.type.name === 'heading' ? 'heading' : 'paragraph',
    docxIndex,
    originalXml: orig?.originalXml ?? null,
    runs,
  }

  if (node.type.name === 'heading') block.level = (node.attrs.level as number) ?? 1
  if (orig?.styleId != null) block.styleId = orig.styleId
  else if (node.attrs.styleId != null) block.styleId = node.attrs.styleId as string
  // 段落对齐（w:jc）同样经 Block.format 往返：引擎只认 format.align（parse.ts 写入、generate.ts 读取），
  // 顶层 block.align 不被消费 —— 写在顶层会导致对齐既不回显也不落盘。
  const align = node.attrs.align as string | null | undefined;

  // 段落格式（段间距 / 缩进 / 分页符）经 Block.format 往返，保证字节保真：
  // 以原 format 为基底，叠加编辑器节点属性；未触碰的字段保留原值（如 shading/lineSpacing）。
  const fmt: Record<string, unknown> = { ...(orig?.format ?? {}) }
  const mergeFmt = (key: string, val: unknown) => {
    if (val != null) fmt[key] = val
    else if (Object.prototype.hasOwnProperty.call(fmt, key)) delete fmt[key]
  }
  mergeFmt('align', align)
  mergeFmt('pageBreakBefore', node.attrs.pageBreakBefore)
  // 同页 / 孤行（P2）：与既有一致 —— 值为 null 时删键（保持「原文没有」），显式 false 会被保留
  mergeFmt('keepNext', node.attrs.keepNext)
  mergeFmt('keepLines', node.attrs.keepLines)
  mergeFmt('widowControl', node.attrs.widowControl)
  mergeFmt('spaceBefore', node.attrs.spaceBefore)
  mergeFmt('spaceAfter', node.attrs.spaceAfter)
  mergeFmt('indentLeft', node.attrs.indentLeft)
  mergeFmt('indentFirstLine', node.attrs.indentFirstLine)
  mergeFmt('lineSpacing', node.attrs.lineSpacing)
  if (Object.keys(fmt).length > 0) block.format = fmt as never
  else if (orig?.format != null) block.format = orig.format
  if (orig?.rawPPr != null) block.rawPPr = orig.rawPPr

  return block
}

/**
 * PM 文档 → Block[]。
 * @param doc 编辑后的 PM 文档
 * @param originalBlocks 编辑器加载时的原始块序列（用于回带 rawPPr/format/styleId）
 */
export function docToBlocks(doc: PMNode, originalBlocks: Block[] = []): Block[] {
  const out: Block[] = []
  doc.forEach((node, _offset, index) => {
    const block = blockFromNode(node, index, originalBlocks)
    if (block) out.push(block)
  })
  return out
}
