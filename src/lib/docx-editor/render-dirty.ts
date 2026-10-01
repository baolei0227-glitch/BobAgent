/**
 * 脏块渲染器（完整 Word 视觉保真版）
 *
 * 配合 `buildSaveBlocks` 使用：当某块被标记为脏时，本函数决定如何把它转成 `SaveBlock`。
 * 干净块由 `buildSaveBlocks` 统一走 `{kind:'original', docxIndex}` 逐字节搬运原 XML，本函数只处理脏块。
 *
 * 路由：
 *   - table（已编辑）→ `{ kind:'xml', xml: generateTableModelXml(model, originalXml) }`：
 *       从整张表的编辑模型重建 OOXML（originalTableXml 让未建模属性逐字存活）。
 *   - image / passthrough（原子、未建模）→ `{ kind:'original', docxIndex }` 逐字节搬运原 XML。
 *   - paragraph / heading / listItem（可生成）→ `GeneratedBlock`。
 *
 * 该渲染器比 `passthroughRenderDirty` 更进一步：表格真正参与重生成，而非永远保原样。
 */

import type { Block, SaveBlock, NewImage } from '@/lib/docx-engine'
import { generateTableModelXml } from '@/lib/docx-engine/generate'
import { defaultRenderDirtyBlock } from './save-blocks'

/** 原子 / 未建模块（仅 passthrough 类型）：即便被误标脏也强制保原样 */
const PASSTHROUGH_TYPES = new Set(['passthrough'])

/** data URL → 引擎 NewImage（仅支持 png/jpeg/gif；其它格式返回 null 走降级） */
function dataUrlToNewImage(
  dataUrl: string | null,
  wPx: number | null,
  hPx: number | null,
  align: string | null,
): NewImage | null {
  if (!dataUrl) return null
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl)
  if (!m) return null
  const mime = m[1].toLowerCase()
  const allowed: NewImage['mime'] | null =
    mime === 'image/png' ? 'image/png' : mime === 'image/jpeg' ? 'image/jpeg' : mime === 'image/gif' ? 'image/gif' : null
  if (!allowed) return null
  return {
    base64: m[2],
    mime: allowed,
    widthPx: wPx ?? 200,
    heightPx: hPx ?? 150,
    align: (align as 'left' | 'center' | 'right') ?? 'left',
  }
}

export function docxRenderDirty(block: Block, _index: number): SaveBlock {
  // 表格：从编辑模型重建 OOXML
  if (block.type === 'table' && block.table) {
    return {
      kind: 'xml',
      xml: generateTableModelXml(block.table, block.originalXml ?? undefined),
      docxIndex: block.docxIndex ?? undefined,
    }
  }
  // 图片：已有块逐字节搬运；新插入块把 data URL 转成 NewImage 嵌入
  if (block.type === 'image') {
    if (block.docxIndex != null) return { kind: 'original', docxIndex: block.docxIndex }
    const img = dataUrlToNewImage(block.imageDataUrl ?? null, block.imageWidthPx ?? null, block.imageHeightPx ?? null, block.imageAlign ?? null)
    if (img) return { kind: 'image', image: img }
    throw new Error('新插入的图片格式不受支持（仅 png/jpeg/gif），无法写回原稿')
  }
  // 无法建模的 passthrough：逐字节搬运原 XML
  if (block.docxIndex != null && PASSTHROUGH_TYPES.has(block.type)) {
    return { kind: 'original', docxIndex: block.docxIndex }
  }
  // paragraph / heading / listItem：生成
  return defaultRenderDirtyBlock(block, _index)
}
