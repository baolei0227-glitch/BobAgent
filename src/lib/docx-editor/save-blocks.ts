/**
 * 脏块 → `SaveBlock[]` 装配（S1 第三件）
 *
 * 上游 GenOffice 的对应逻辑埋在 `apps/docs/src/renderer/editor/convert.ts`（142 KB，
 * 与其块模型耦合）。本仓只借用**机制**，不搬运那个文件：这里只做「脏/净路由」，
 * 「每个块怎么渲染成 XML」交给调用方注入（`renderDirty`），因为那是 S3 才定的事
 * （table / image / passthrough 三类块无法表达为 `GeneratedBlock`，需要 `kind:'xml'` +
 * `generateTableXml` 之类的生成器）。
 *
 * ## 为什么必须区分"脏/净"
 * `docx-engine` 的保存是**增量拼接**：干净的块以 `{kind:'original', docxIndex}` 形式
 * 让 `saveDocx` 直接搬运 `<w:body>` 的原始 XML 切片（逐字节不变）；只有脏块才重新生成。
 * 当**没有任何脏块**时，输出的形状恰好满足 `saveDocx` 的 `isUnchanged` 判据
 * （见 `patch.ts:422-464`），于是整份文件按 `originalBytes` **逐字节**返回。
 * 这就是"打开即保存不改字节"的能力来源，也是本文件存在的全部意义。
 *
 * ## 与 `saveDocx` 的两条硬约束（改错即损坏文档）
 * 1. **hidden 块必须排除**：`saveDocx` 用 `parsed.blocks.filter(b => !b.hidden)`
 *    计算 `visibleOriginalOrder`（`patch.ts:422`），并在写盘时把 body 尾部元素
 *    （如 `w:sectPr`）自行追加。故 `hidden` 块若出现在 `finalBlocks` 里，
 *    块数与顺序都会错。
 * 2. **`finalBlocks` 必须只含最终顺序的"存活块"**：被删除的块不出现即视为删除；
 *    新块（`docxIndex === null`）必须走 `generated` 且**不带** `docxIndex`。
 *
 * ## 唯一假设（调用方必须保证）
 * `blocks` 与 ProseMirror 文档的顶层子节点**一一对应、同序**；因此
 * `dirty` 的下标空间与 `blocks` 的数组下标空间相同。
 * 该假设由「块树 ↔ PM 文档」的转换层负责，本文件无法自检；若调用方传错坐标系，
 * 会命中错误的块（表现为"改 A 处、B 处被重写"），不会静默丢内容。
 */
import type { Block, GeneratedBlock, SaveBlock } from '../docx-engine'

/** `null` = 全量重算（对应 `touchedTopLevelIndices` 返回 `null` 的情形） */
export type DirtyBlockIndices = ReadonlySet<number> | null

/** 把一个脏块渲染成 `SaveBlock`；由调用方按 `block.type` 分派 */
export type RenderDirtyBlock = (block: Block, index: number) => SaveBlock

/**
 * `Block` → `GeneratedBlock`：仅 `paragraph` / `heading` / `listItem` 可表达。
 * 其余（`table` / `image` / `passthrough`）返回 `null`，必须由调用方另走
 * `{kind:'xml'}` / `{kind:'image'}` 等分支。
 *
 * 刻意**不**设置 `GeneratedBlock.pPrChange`：原始 `w:pPrChange` 已包含在
 * `block.rawPPr` 里并随其逐字透传（见 `types.ts:1489-1495`），而该字段只在
 * 接受/拒绝修订时才需要——修订 UI 尚不存在，此刻写它反而容易写错。
 */
export function toGeneratedBlock(block: Block): GeneratedBlock | null {
  if (block.type !== 'paragraph' && block.type !== 'heading' && block.type !== 'listItem') {
    return null
  }
  return {
    type: block.type,
    level: block.level,
    outlineOnly: block.outlineOnly,
    styleId: block.styleId,
    list: block.list,
    format: block.format,
    rawPPr: block.rawPPr,
    bookmarks: block.bookmarks,
    hiddenBookmarks: block.hiddenBookmarks,
    commentStarts: block.commentStarts,
    commentEnds: block.commentEnds,
    runs: block.runs ?? [],
    sdtShell: block.sdtShell,
  }
}

/**
 * 默认的脏块渲染器：仅处理三种可生成的段落类块，其余**显式抛错**。
 * 宁可炸掉也不要静默把表格当段落写出去——那会直接损坏用户文档。
 */
export function defaultRenderDirtyBlock(block: Block, _index: number): SaveBlock {
  const generated = toGeneratedBlock(block)
  if (generated === null) {
    throw new Error(
      `buildSaveBlocks: type='${block.type}' 的块（id=${block.id}）无法表达为 GeneratedBlock；` +
        `请通过 renderDirty 为它提供 {kind:'xml'} / {kind:'image'} / {kind:'chart'} 等替代块。`,
    )
  }
  // 新块（docxIndex === null）必须不带 docxIndex；旧块带上以标记来源块
  return { kind: 'generated', block: generated, docxIndex: block.docxIndex ?? undefined }
}

/**
 * 把当前块树 + 脏块下标翻译成 `saveDocx` 需要的 `finalBlocks`。
 *
 * @param blocks      当前块树（含 hidden 块；顺序即最终顺序）
 * @param dirty       脏块下标集合（`blocks` 的数组下标空间）；`null` = 全量重算
 * @param renderDirty 脏块渲染器；默认只支持段落类块
 */
export function buildSaveBlocks(
  blocks: readonly Block[],
  dirty: DirtyBlockIndices,
  renderDirty: RenderDirtyBlock = defaultRenderDirtyBlock,
): SaveBlock[] {
  const out: SaveBlock[] = []
  blocks.forEach((block, index) => {
    // 约束 1：hidden 块由 saveDocx 自行追加到 body 尾部，这里必须跳过
    if (block.hidden) return

    // 新块没有原始 XML 可搬，必然要生成；即使调用方漏标也兜住（绝不静默丢弃）
    if (dirty === null || dirty.has(index) || block.docxIndex === null) {
      out.push(renderDirty(block, index))
      return
    }

    // 干净块：docxIndex 非空 ⇒ 可逐字节搬运原始 XML 切片
    out.push({ kind: 'original', docxIndex: block.docxIndex })
  })
  return out
}

/**
 * 带 passthrough 兜底的脏块渲染器（S1 ② 阶段 3 编辑器用）。
 *
 * 规则：
 *   - 非文本块（table / image / listItem / passthrough）即使被标记脏，也**始终**走
 *     `{kind:'original', docxIndex}` —— 它们不在编辑器内建模，重生成只会损坏文档，
 *     原样搬运是唯一安全策略（原子占位节点本就不可编辑，正常情况下不会进入脏集）。
 *   - 其余块（paragraph / heading / listItem 未来若可编辑）交给 `defaultRenderDirtyBlock`。
 *
 * 这是 `buildSaveBlocks` 的推荐 `renderDirty`，用于「占位保原样」场景。
 */
const PASSTHROUGH_TYPES = new Set(['table', 'image', 'listItem', 'passthrough'])
export function passthroughRenderDirty(block: Block, _index: number): SaveBlock {
  if (block.docxIndex != null && PASSTHROUGH_TYPES.has(block.type)) {
    return { kind: 'original', docxIndex: block.docxIndex }
  }
  return defaultRenderDirtyBlock(block, _index)
}
