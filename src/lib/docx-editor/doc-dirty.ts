/**
 * 脏块追踪（S1 ② 阶段 3 · 可测试内核逻辑，无 React / Tiptap 运行时依赖）
 *
 * 设计不变量 ——「只有持久化状态才算脏」：
 *   - 脏标记锚定在**持久化的块身份** `docxIndex` 上，而非编辑器顶层的瞬时下标。
 *     编辑会移动 / 重排节点，但 `docxIndex` 不变 ⇒ 脏标记跟随块身份，
 *     不会因位置变化而错位或丢失。
 *   - 保存时把「脏的 docxIndex 集合」换算回 `newBlocks` 的数组下标，交给
 *     `buildSaveBlocks`：被标记且身份匹配的块走 `generated`，其余走 `original`
 *     （逐字节搬运 `<w:body>` 原始切片，字节级无损）。
 *   - 新建块（docxIndex 为 null）没有原始 XML 可搬，必然视为脏。
 *
 * 与 `dirty-blocks.ts`（`touchedTopLevelIndices`，基于 PM 事务识别被触及的顶层下标）
 * 的分工：dirty-blocks 负责「哪些顶层节点被动过」，本模块负责「把被动过的节点映射到
 * 持久化身份 docxIndex 并维护脏集」，二者在编辑器 `onTransaction` 中串联。
 */

import type { Block } from '@/lib/docx-engine'

export class DocDirtyTracker {
  private dirtyDocxIndices = new Set<number>()

  /** 标记某个持久化块（按 docxIndex）为脏；docxIndex 为 null（新建块）忽略 */
  markTouched(docxIndex: number | null): void {
    if (docxIndex != null) this.dirtyDocxIndices.add(docxIndex)
  }

  /** 批量标记（如遇到未知 step、保守起见把所有原始块全标脏时使用） */
  markAll(blocks: readonly Block[]): void {
    for (const b of blocks) {
      if (b.docxIndex != null) this.dirtyDocxIndices.add(b.docxIndex)
    }
  }

  /** 该持久化身份是否脏 */
  isDirty(docxIndex: number | null): boolean {
    return docxIndex != null && this.dirtyDocxIndices.has(docxIndex)
  }

  /** 脏块数量（0 = 与打开时一致，可直接跳过写回） */
  get size(): number {
    return this.dirtyDocxIndices.size
  }

  /** 清空（保存成功后 / 重新加载后调用） */
  clear(): void {
    this.dirtyDocxIndices.clear()
  }

  /**
   * 把脏集（docxIndex 空间）换算回 `newBlocks` 的数组下标空间，供 `buildSaveBlocks` 使用。
   * 规则：docxIndex 为空（新建块）或命中脏集 ⇒ 数组下标入集（视为脏，需生成）。
   */
  toArrayIndexSet(newBlocks: readonly Block[]): Set<number> {
    const out = new Set<number>()
    newBlocks.forEach((b, i) => {
      if (b.docxIndex == null || this.dirtyDocxIndices.has(b.docxIndex)) out.add(i)
    })
    return out
  }
}
