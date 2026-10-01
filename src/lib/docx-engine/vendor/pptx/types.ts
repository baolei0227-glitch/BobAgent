/**
 * ⚠️ 本地裁剪版 —— 不是上游全文。
 *
 * 上游：`packages/pptx-engine/src/types.ts`（730 行，commit 05b4bd6）
 * 本文件仅保留 docx-engine 的 `parseCustGeom` 在**编译期**所需的类型，即
 * `custgeom.ts` 的 `import type { CustomGeometry } from './types'`；
 * 该接口原文照录自上游第 494–505 行，未改一字。
 *
 * 裁剪原因（有据）：上游 `types.ts` 的 `ChartElement` 通过**类型位置的动态 import**
 * （`types.ts:681` 的 `import('./chart').ChartModel`）牵入 `chart.ts`，
 * 并连带 `color.ts` / `theme.ts` / `xml-utils.ts` —— 完整闭包为 6 文件 / 3,366 行，
 * 而 docx 引擎只用到其中 8 行的一个接口。因是 `import type`，**运行时零影响**。
 *
 * 如需完整 pptx 类型，按同一 commit 取回
 * `packages/pptx-engine/src/{types,chart,color,theme,xml-utils}.ts` 覆盖本文件即可
 * （届时 `custgeom.ts` 无需改动，它会自动解析到完整版）。
 */

export interface CustomGeometry {
  /** Main fill+stroke path */
  path?: string
  /** stroke="0" subpath: fill only (e.g. the pie sector of arc shapes) */
  fillPath?: string
  /** fill="none" subpath: stroke only (e.g. guide arcs) */
  strokePath?: string
}
