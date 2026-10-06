/**
 * docx 形 ProseMirror schema（适配器 A/B 的共同基础，编辑器无关）
 *
 * 设计约束（S1 ② B' 路线）：
 *   - 顶层块节点（paragraph / heading）携带 `docxIndex` 属性 —— 这是回写时的 patch 锚点；
 *     适配器 B 靠它在 `Block[]` 与原始 `Block` 之间对齐（保留 rawPPr / format / styleId）。
 *   - 字符级格式拆成两类 mark：
 *       · 标准 mark（strong/em/underline/strike）—— 与 Tiptap StarterKit 同名，未来真实编辑器零成本接入；
 *       · `runFormat` 自定义 mark —— 承载 docx 特有的字符字段（color / sizeHalfPoints / font…），
 *         这些 StarterKit 不建模，必须独立携带，否则往返会丢格式。
 *   - 本 schema 与未来 Tiptap 编辑器（StarterKit + 同名 runFormat）保持**节点/mark 同名**，使适配器可直接消费
 *     真实编辑器产出的 PM 文档（ProseMirror 文档自带 schema 引用，适配器只按 name/attrs 遍历）。
 *
 * ⚠️ 本 schema 已覆盖文本块（paragraph / heading）+ 表格/图片/列表（table / image / listItem）。
 *    passthrough（图表/OLE/无法建模内容）仍走 `docxPlaceholder` 只读占位。新增节点须同步在
 *    `components/canvas/docx-editor/docx-tiptap-extensions.ts` 的编辑器 schema 中定义同名同形节点，
 *    否则 `setContent(json)` 重解析会失败（适配器 A 用本 schema 建 JSON，编辑器用其自身 schema 重解析）。
 */

import { Schema, type MarkSpec, type NodeSpec } from '@tiptap/pm/model'

const docxIndexAttr = { docxIndex: { default: null as number | null } }
const styleIdAttr = { styleId: { default: null as string | null } }

/**
 * 段落级「同页 / 孤行」保真属性（P2 · 2026-10-04）。
 *
 * 🔴 **必须与 `components/canvas/docx-editor/docx-tiptap-extensions.ts` 的同名常量逐字对齐。**
 * 本 schema 是适配器 A（`blocksToDoc`）建节点的目标 schema，而 `NodeType.createChecked`
 * 走 `computeAttrs` —— 它**只遍历 schema 声明的属性**，未声明的键**静默丢弃**。
 * 三者缺一的后果不是报错，而是「引擎解析出的 w:keepNext 走不到编辑器的分页层」，
 * 表现为「属性明明在，分页却当它不存在」（本单 P2 第一版即如此，已由
 * `pagination-fidelity-roundtrip.test.ts` 抓出）。
 * 默认值必须为 `null`：`tiptap-to-blocks.ts` 的 `mergeFmt` 在 null 时**删除**该键
 * （保持「原文没有的属性，保存后仍然没有」），而显式 `false` 会被保留。
 */
const paginationFidelityAttrs = {
  /** w:keepNext —— 本段与下一段必须同页（标题与其首段同页就靠它） */
  keepNext: { default: null },
  /** w:keepLines —— 段内不允许跨页（整段必须落在同一页） */
  keepLines: { default: null },
  /** w:widowControl —— 孤行控制（缺省视为**开**：页底与下页各至少 2 行） */
  widowControl: { default: null },
}

/**
 * 非文本块（table / image / listItem / 其它复杂块）在 PM 文档中的只读占位节点。
 * 阶段 3 的 passthrough 策略：这些块无法表达为可生成的 `GeneratedBlock`，
 * 编辑器用原子占位节点承载其 `docxIndex`，保存时走 `{kind:'original'}` 逐字节搬运原 XML。
 * 原子节点不可编辑、不可在内部落光标高，渲染为灰底「原样保留」提示框。
 */
export const PLACEHOLDER_KINDS = ['table', 'image', 'listItem', 'passthrough'] as const
export type DocxPlaceholderKind = (typeof PLACEHOLDER_KINDS)[number]

/** 占位节点的可读标签（渲染层用，不含语义） */
export function placeholderLabel(kind: string): string {
  switch (kind) {
    case 'table': return '表格（原样保留，不可编辑）'
    case 'image': return '图片（原样保留，不可编辑）'
    case 'listItem': return '列表（原样保留，不可编辑）'
    default: return '复杂内容（原样保留，不可编辑）'
  }
}

/** 引擎块类型 → 占位 kind（非 paragraph/heading 一律占位保原样） */
export function blockTypeToPlaceholderKind(type: string): DocxPlaceholderKind {
  if ((PLACEHOLDER_KINDS as readonly string[]).includes(type)) return type as DocxPlaceholderKind
  return 'passthrough'
}

const paragraph: NodeSpec = {
  content: 'inline*',
  group: 'block',
  attrs: {
    ...docxIndexAttr,
    ...styleIdAttr,
    ...paginationFidelityAttrs,
    align: { default: null as string | null },
    // 段落级分页符 / 段间距 / 缩进 / 行距（与 docx-tiptap-extensions 同名同形；经 Block.format 字节保真）
    pageBreakBefore: { default: null },
    spaceBefore: { default: null },
    spaceAfter: { default: null },
    indentLeft: { default: null },
    indentFirstLine: { default: null },
    lineSpacing: { default: null },
  },
  parseDOM: [{ tag: 'p', getAttrs: (el) => ({ align: (el as HTMLElement).style.textAlign || null }) }],
  toDOM: (node) => ['p', node.attrs.align ? { style: `text-align:${node.attrs.align as string}` } : {}, 0],
}

const heading: NodeSpec = {
  content: 'inline*',
  group: 'block',
  attrs: {
    level: { default: 1 },
    ...docxIndexAttr,
    ...styleIdAttr,
    ...paginationFidelityAttrs,
    align: { default: null as string | null },
    pageBreakBefore: { default: null },
    spaceBefore: { default: null },
    spaceAfter: { default: null },
    indentLeft: { default: null },
    indentFirstLine: { default: null },
    lineSpacing: { default: null },
  },
  parseDOM: [
    { tag: 'h1', getAttrs: (el) => ({ level: 1, align: (el as HTMLElement).style.textAlign || null }) },
    { tag: 'h2', getAttrs: (el) => ({ level: 2, align: (el as HTMLElement).style.textAlign || null }) },
    { tag: 'h3', getAttrs: (el) => ({ level: 3, align: (el as HTMLElement).style.textAlign || null }) },
    { tag: 'h4', getAttrs: (el) => ({ level: 4, align: (el as HTMLElement).style.textAlign || null }) },
    { tag: 'h5', getAttrs: (el) => ({ level: 5, align: (el as HTMLElement).style.textAlign || null }) },
    { tag: 'h6', getAttrs: (el) => ({ level: 6, align: (el as HTMLElement).style.textAlign || null }) },
  ],
  toDOM: (node) => [`h${node.attrs.level as number}`, node.attrs.align ? { style: `text-align:${node.attrs.align as string}` } : {}, 0],
}

const docxPlaceholder: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  attrs: {
    ...docxIndexAttr,
    ...styleIdAttr,
    placeholderKind: { default: 'passthrough' as string },
    label: { default: null as string | null },
  },
  // 占位节点只由程序创建（blocksToDoc），不从 HTML 解析
  parseDOM: [],
  toDOM: (node) => {
    const kind = (node.attrs.placeholderKind as string) || 'passthrough'
    const label = (node.attrs.label as string | null) ?? placeholderLabel(kind)
    return [
      'div',
      {
        class: 'docx-placeholder',
        'data-kind': kind,
        'data-placeholder': '1',
        contenteditable: 'false',
      },
      label,
    ]
  },
}

/**
 * 图片块（type === 'image'）：携带显示用 data URL + 尺寸/对齐。
 * 编辑器内为只读原子（不编辑像素），写回走 passthrough 原 XML，不丢字节。
 * 真渲染由编辑器 schema 的 `addNodeView`（React `<img>`）完成；本基础 schema 仅用于建 JSON。
 */
const docxImage: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  attrs: {
    ...docxIndexAttr,
    ...styleIdAttr,
    imageDataUrl: { default: null as string | null },
    imageWidthPx: { default: null as number | null },
    imageHeightPx: { default: null as number | null },
    imageAlign: { default: null as string | null },
    label: { default: null as string | null },
  },
  toDOM: () => ['div', { 'data-docx-image': '1' }],
}

/**
 * 列表项（type === 'listItem'）：可编辑（内容行内 runs 同 paragraph），带 list 元数据。
 * 编辑器 NodeView 渲染项目符号/编号前缀。
 */
const docxListItem: NodeSpec = {
  group: 'block',
  content: 'inline*',
  attrs: {
    ...docxIndexAttr,
    ...styleIdAttr,
    listKind: { default: 'bullet' as string },
    numId: { default: null as string | null },
    ilvl: { default: 0 },
    marker: { default: null as string | null },
  },
  toDOM: () => ['div', { 'data-docx-listitem': '1' }, 0],
}

/**
 * 表格单元格（仅出现在 docxTableRow 内，不在 block group）：内容为一个或多个段落（可含嵌套表格）。
 * colSpan/rowSpan/fill 等驱动 NodeView 的 <td> 渲染；cellMeta 存未建模的 tcPr 细节（保真回写用）。
 */
const docxTableCell: NodeSpec = {
  content: 'block+',
  attrs: {
    colSpan: { default: 1 },
    rowSpan: { default: 1 },
    fill: { default: null as string | null },
    vMerge: { default: null as string | null },
    align: { default: null as string | null },
    vAlign: { default: null as string | null },
    cellMeta: { default: null as Record<string, unknown> | null },
  },
  toDOM: () => ['td', 0],
}

/** 表格行（仅出现在 docxTable 内）：内容为单元格序列。rowMeta 存行高/表头重复等。 */
const docxTableRow: NodeSpec = {
  content: 'docxTableCell+',
  attrs: {
    rowMeta: { default: null as Record<string, unknown> | null },
  },
  toDOM: () => ['tr', 0],
}

/**
 * 表格块（type === 'table'）：可编辑嵌套结构（行→单元格→段落）。
 * tableMeta 存表格级元数据（列宽/边框/底纹/对齐/表头选项等），写回脏时由
 * `generateTableModelXml` 从整张表模型重建 OOXML。
 */
const docxTable: NodeSpec = {
  group: 'block',
  content: 'docxTableRow+',
  attrs: {
    ...docxIndexAttr,
    ...styleIdAttr,
    tableMeta: { default: null as Record<string, unknown> | null },
  },
  toDOM: () => ['table', { 'data-docx-table': '1' }, 0],
}

const runFormat: MarkSpec = {
  attrs: {
    /** hex color without '#'，对应 Run.color */
    color: { default: null as string | null },
    /** font size in half-points，对应 Run.sizeHalfPoints */
    sizeHalfPoints: { default: null as number | null },
    /** primary font family，对应 Run.font */
    font: { default: null as string | null },
    /** 'superscript' | 'subscript'，对应 Run.vertAlign（w:vertAlign） */
    vertAlign: { default: null as string | null },
  },
  parseDOM: [{ tag: 'span[data-rf]' }],
  toDOM: (mark) => ['span', { 'data-rf': '1', ...markAttrsToDom(mark.attrs) }, 0],
}

function markAttrsToDom(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  if (attrs.color != null) out['data-color'] = String(attrs.color)
  if (attrs.sizeHalfPoints != null) out['data-sz'] = String(attrs.sizeHalfPoints)
  if (attrs.font != null) out['data-font'] = String(attrs.font)
  if (attrs.vertAlign != null) out['data-va'] = String(attrs.vertAlign)
  return out
}

/**
 * 修订 mark（对应 docx 的 w:ins / w:del 包裹）。
 * 让「已落修订标记」的 run 在编辑器中可见（绿色插入 / 红色删除线），并往返保真：
 *   - 适配器 A（blocksToDoc）按 `Run.ins` / `Run.del` 给 run 打对应 mark；
 *   - 适配器 B（docToBlocks）反向把 mark 提取回 `Run.ins` / `Run.del`；
 *   - 经 `/api/docx/revise` apply/resolve 产出的字节重新解析后由本 mark 渲染。
 * author/date/id 来自引擎 `RevisionInfo`，仅用于展示与稳定 id，不影响回写。
 */
function revInsAttrsToDom(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { 'data-rev-ins': '1' }
  if (attrs.author != null) out['data-author'] = String(attrs.author)
  if (attrs.date != null) out['data-date'] = String(attrs.date)
  if (attrs.id != null) out['data-rid'] = String(attrs.id)
  return out
}
function revDelAttrsToDom(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { 'data-rev-del': '1' }
  if (attrs.author != null) out['data-author'] = String(attrs.author)
  if (attrs.date != null) out['data-date'] = String(attrs.date)
  if (attrs.id != null) out['data-rid'] = String(attrs.id)
  return out
}

const docxIns: MarkSpec = {
  attrs: {
    author: { default: null as string | null },
    date: { default: null as string | null },
    id: { default: null as string | null },
  },
  parseDOM: [{ tag: 'span[data-rev-ins]' }],
  toDOM: (mark) => ['span', revInsAttrsToDom(mark.attrs), 0],
}

const docxDel: MarkSpec = {
  attrs: {
    author: { default: null as string | null },
    date: { default: null as string | null },
    id: { default: null as string | null },
  },
  parseDOM: [{ tag: 'span[data-rev-del]' }],
  toDOM: (mark) => ['span', revDelAttrsToDom(mark.attrs), 0],
}

export const docxSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph,
    heading,
    docxPlaceholder,
    docxImage,
    docxListItem,
    docxTable,
    docxTableRow,
    docxTableCell,
    text: { group: 'inline' },
  },
  marks: {
    strong: {
      parseDOM: [{ tag: 'strong' }, { style: 'font-weight=bold' }],
      toDOM: () => ['strong', 0],
    },
    em: {
      parseDOM: [{ tag: 'em' }, { style: 'font-style=italic' }],
      toDOM: () => ['em', 0],
    },
    underline: {
      parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
      toDOM: () => ['u', 0],
    },
    strike: {
      parseDOM: [{ tag: 's' }, { style: 'text-decoration=line-through' }],
      toDOM: () => ['s', 0],
    },
    runFormat,
    docxIns,
    docxDel,
  },
})

export type DocxSchema = typeof docxSchema
