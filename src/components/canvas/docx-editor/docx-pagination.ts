/**
 * docx 编辑器分页扩展（S1 · 视觉分页，非像素级保真）
 *
 * 做法：用 ProseMirror 的 widget 装饰，在「应换页的位置」插入一个不可编辑的间隙，
 * 把内容推到下一张 A4 白纸上。两种断点：
 *   · 块级断点（`inlinePos` 为空）：间隙插在**顶层块之前**，整块下移；
 *   · 段内断点（`inlinePos` 有值，P1 / 2026-10-03 新增）：间隙插在**段落内部的文档位置**上，
 *     段落因此可以在页底断开、下半段从下页页首继续 —— 与 Word 的段落跨页行为一致。
 *
 * 关键性质：装饰（Decoration）**不进入文档模型**，因此 `getJSON`/`docToBlocks` 保存时
 * 不会带上这些间隙 —— 分页是纯视觉层，不影响 docx 字节保真。
 * （靶场实测：断点前后 `getJSON()` 逐字节相同、分页 meta 事务不压入撤销栈。见工单 §十）
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
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

/** A4 @ 96dpi（px）—— 即 `DEFAULT_GEOMETRY`，保留导出以兼容既有消费方（两个靶场） */
export const PAGE_W = 794
export const PAGE_H = 1123
/** 页面边距（px，≈1in @96dpi） */
export const PAGE_MARGIN_X = 96
export const PAGE_MARGIN_Y = 96
/** 页间灰隙（px）—— 每页之间唯一的灰色带 */
export const PAGE_GAP = 24
/**
 * 单页可用内容高（页高减去上下边距）—— **默认几何**下的值。
 * ⚠️ 几何动态化（P4）后它只是常量快照；运行时判断请一律用 `usableHeight()`。
 */
export const PAGE_USABLE_H = PAGE_H - 2 * PAGE_MARGIN_Y
/**
 * 页步进：相邻两页起点之差（灰缝也占位）—— **默认几何**下的值。
 * ⚠️ 运行时请用 `pageStride()`。
 */
export const PAGE_STRIDE = PAGE_H + PAGE_GAP
/** twips → px @96dpi（1in = 1440twips = 96px）—— docx 节属性的单位换算因子 */
export const TWIPS_PER_PX = 15

/* ================================================================
 * 节几何（P4 · 2026-10-04）
 *
 * 为什么要引入：P1–P3 把 794 / 1123 / 96 / 24 写成了模块级常量，等于「所有 docx
 * 都是 A4 + 1in 边距」。而真源在文档自己的 `w:sectPr` 里（`readSections` 已能读出，
 * 单位 twips）—— 边距不同的文档，页底留白与换页位置会系统性错位。
 *
 * 设计取舍：
 *   · 只暴露 `marginX` / `marginY` 一个左右、一个上下的**对称**边距，而不是四个独立值。
 *     因为纸面容器用的是 `padding: marginY marginX`，非对称边距在当前布局里表达不出来。
 *     取**上下均值** `(marginTop+marginBottom)/2` 的一个好处：`h − 2·marginY` 恰好等于
 *     真实可用高 `h − marginTop − marginBottom`（2·均值 = 和），所以**不损失换页精度**，
 *     只是纸面留白左右不对称的文档会看到居中的近似。
 *   · 几何住在模块级可变单例里（而不是 React state）：`measurePageBreaks` 是纯函数、
 *     被靶场直接驱动，必须能在没有 React 的情况下读到当前几何。宿主另存一份 React state
 *     用于渲染，两者由 `applyParsed` 同点写入 —— 见 DocxTiptapEditor 的 `geom`。
 * ================================================================ */

export interface PageGeometry {
  /** 纸宽（px）*/
  w: number
  /** 纸高（px）*/
  h: number
  /** 左右页边距（px，取左右均值）*/
  marginX: number
  /** 上下页边距（px，取上下均值）*/
  marginY: number
  /** 页间灰隙（px）—— 与文档无关，是编辑器的视觉约定 */
  gap: number
  /** 页脚文字块**底边**距页面**底边**的距离（px，来自 `w:footer` 的 footerDist，缺省 48）*/
  footerDist: number
}

/** A4 + 1in 边距 —— 也是几何切换的复位目标 */
export const DEFAULT_GEOMETRY: PageGeometry = {
  w: PAGE_W,
  h: PAGE_H,
  marginX: PAGE_MARGIN_X,
  marginY: PAGE_MARGIN_Y,
  gap: PAGE_GAP,
  footerDist: 720 / TWIPS_PER_PX,
}

let currentGeometry: PageGeometry = { ...DEFAULT_GEOMETRY }

/**
 * 设置当前节几何。
 * ⚠️ 传入 `null` 复位为 A4 默认 —— **切换文档时必须复位**：否则上一份文档的节属性
 * 会串到下一份「读不到 sectPr」的文档上（表现为莫名其妙的页高/留白）。
 */
export function setPageGeometry(next: Partial<PageGeometry> | null): void {
  currentGeometry = next ? { ...DEFAULT_GEOMETRY, ...next } : { ...DEFAULT_GEOMETRY }
}

export function pageGeometry(): PageGeometry {
  return currentGeometry
}

/** 单页可用内容高 = 页高 − 2·边距 */
export function usableHeight(g: PageGeometry = currentGeometry): number {
  return g.h - 2 * g.marginY
}

/** 页步进 = 页高 + 灰缝（相邻两页**纸面顶端**之差）*/
export function pageStride(g: PageGeometry = currentGeometry): number {
  return g.h + g.gap
}

/**
 * 第 i 页（0-based）**正文区顶端**的纵坐标（相对纸面容器顶端，纸面顶端 = 0）。
 * 与 `MeasureResult.pageTops` 同系（`pageTops[0] === marginY`），可直接用于滚动定位。
 */
export function pageTopAt(i: number, g: PageGeometry = currentGeometry): number {
  return g.marginY + i * pageStride(g)
}

/**
 * 第 i 页**页脚文字块顶端**的纵坐标（相对纸面容器顶端，纸面顶端 = 0）。
 *
 * 口径：页脚底边距页面底边 `footerDist` ⇒ 文字块顶 = 页底 − footerDist − 行高。
 *
 * ⚠️ 这里**不能**直接用 `pageTopAt(i)`：后者含 `marginY`（正文区偏移），而页脚要贴的是
 * 纸的**物理底边**。用 `pageTopAt` 会把页脚多推一个页边距、掉到纸外面去（i=0 时会算到
 * 1171 而不是 1075）。所以纵坐标从 `i·stride` 起算，不经过 `pageTopAt`。
 *
 * 自检（默认几何）：页脚顶 1075−lineH ≥ 正文区底 1027 ⇒ 页脚稳定落在下边距带里。
 */
export function pageFooterTopAt(i: number, lineH: number, g: PageGeometry = currentGeometry): number {
  return i * pageStride(g) + g.h - g.footerDist - lineH
}

/** 纸面总高（撑开滚动容器用）= pages·h + (pages−1)·gap */
export function paperHeightOf(pages: number, g: PageGeometry = currentGeometry): number {
  return pages * g.h + Math.max(0, pages - 1) * g.gap
}

/**
 * 由 docx 节属性（`w:sectPr`，单位 **twips**）导出编辑器几何（px）。
 *
 * 刻意用**结构化类型**入参而不是 `import type { SectionSettings }`：本模块是纯几何层，
 * 不该反向依赖 docx 引擎（否则靶场/单测都要拖起整个引擎的 import 链，冷启动 9–15s）。
 *
 * 返回 `Partial<PageGeometry>` ⇒ 直接喂给 `setPageGeometry`；缺项/异常值一律不返回，
 * 由 `DEFAULT_GEOMETRY` 兜底（绝不写出 0 高纸这种会把分页算成 1 页的值）。
 */
export function geometryFromSection(s: {
  pageWidth?: number
  pageHeight?: number
  marginTop?: number
  marginBottom?: number
  marginLeft?: number
  marginRight?: number
  footerDist?: number
}): Partial<PageGeometry> {
  const px = (twips: number | undefined): number | null =>
    typeof twips === 'number' && Number.isFinite(twips) && twips > 0
      ? Math.round(twips / TWIPS_PER_PX)
      : null
  const out: Partial<PageGeometry> = {}
  const w = px(s.pageWidth)
  const h = px(s.pageHeight)
  if (w) out.w = w
  if (h) out.h = h
  const mt = px(s.marginTop)
  const mb = px(s.marginBottom)
  // 取上下均值：2·均值 = 上下之和 ⇒ `h − 2·marginY` 精确等于真实可用高
  if (mt != null && mb != null) out.marginY = Math.round((mt + mb) / 2)
  else if (mt != null || mb != null) out.marginY = (mt ?? mb) as number
  const ml = px(s.marginLeft)
  const mr = px(s.marginRight)
  if (ml != null && mr != null) out.marginX = Math.round((ml + mr) / 2)
  else if (ml != null || mr != null) out.marginX = (ml ?? mr) as number
  const fd = px(s.footerDist)
  if (fd) out.footerDist = fd
  return out
}

/**
 * 按**文档顺序**排列断点：先按顶层块下标；同块内「块级断点」在前（-1），段内断点按位置升序。
 * 页码 / 页脚序号必须按这个顺序递增，否则页号会错位（P1 实测：2 个断点全被算成「第 3 页」）。
 */
export function orderedBreaks(breaks: readonly PaginationBreak[]): PaginationBreak[] {
  return [...breaks].sort((a, b) =>
    a.index !== b.index ? a.index - b.index : (a.inlinePos ?? -1) - (b.inlinePos ?? -1),
  )
}

/**
 * 纸面（`.docx-paper`）的盒模型样式 —— **数值**形态。
 *
 * 刻意返回 4 个 padding 长写而不是 `padding: "96px"` 字符串：宿主（React）与靶场
 * （原生 DOM）都能直接用，两边因此**不可能**各写一份 794 / 96。P1 的靶场就是
 * 手抄 CSS 常量、与产品实现各有一份，才需要靠「同源」注释互相提醒。
 */
export function paperBoxStyle(g: PageGeometry = currentGeometry): {
  width: number
  minHeight: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
} {
  return {
    width: g.w,
    minHeight: g.h,
    paddingTop: g.marginY,
    paddingRight: g.marginX,
    paddingBottom: g.marginY,
    paddingLeft: g.marginX,
  }
}

/** px → mm（打印 `@page size` 用；A4 的 794px 会算成 210.06mm，与 210mm 等价） */
function px2mm(px: number): string {
  return ((px / 96) * 25.4).toFixed(2)
}

/**
 * 纸面 / 分页间隙 / 页脚 / 打印 的样式表（**产品唯一真源**）。
 *
 * 为什么住在几何层而不是宿主组件里：① 这些类名由 `makePageSpacer`、宿主纸面、
 * 页脚渲染三处按约定产出，规则与产出方同住才不会漂移；② 打印规则（`@media print`）
 * 必须在**真实打印**时才生效，而验证它只能靠 Electron 靶场 —— 靶场直接 import 本函数，
 * 就不必手抄一份会在几次改动后与产品不一致的副本（P1/P2 靶场吃过这个亏）。
 *
 * 打印三条要点：
 *   ① 灰缝不占高：spacer 内联 height = padTop + 2·marginY + gap，打印期要扣掉 gap，
 *      否则第 k 页整体下移 (k−1)·gap。内联 height 只能用 `!important` + `calc()` 覆盖，
 *      故 `makePageSpacer` 把两个量写成 CSS 变量 `--docx-h` / `--docx-page-gap`。
 *   ② 纸面 `min-height`（内联 = paperHeightOf(pages) = pages·h + (pages−1)·gap）必须归零，
 *      否则元素比 `pages × 纸高` 高出一条 gap ⇒ 多打一张空白纸。
 *   ③ `@page` 是**全局单例**，无法用选择器限定作用域。docx 要 `margin: 0`（版面由纸内边距
 *      负责），而 MD 编辑器依赖全局 `@page` 的 25.4/25/25.4/30mm 版心 —— 两者共用一份规则
 *      会互相破坏，故给 docx 起**命名页** `docx-page`（Chromium ≥110 支持），并让纸尺寸
 *      跟着节几何走（非 A4 文档也能按自己的纸型打印）。
 */
export function docxPaperCss(g: PageGeometry = currentGeometry): string {
  return `
/* 打印命名页：纸型与节几何同源 */
@page docx-page { size: ${px2mm(g.w)}mm ${px2mm(g.h)}mm; margin: 0; }
.docx-paper { page: docx-page; }

/* 视觉分页：间隙外层是白（页底留白 + 上页下边距 + 下页上边距），只在中间挖一条灰缝
   —— 这样每一页都是完整的纸，而不是「一整块画布灰把纸切断」。
   左右用负 margin 顶到纸张边缘，让白带与灰缝铺满整张纸（此前只铺正文列 602px）。 */
.docx-page-spacer { position: relative; background: #fff; margin-left: -${g.marginX}px; margin-right: -${g.marginX}px; }
/* 段内（行级）断点专用：必须 display:block 才能断行（inline-block 实测无效：只撑高当前行）；
   line-height/font-size 归零，避免 display:block 的匿名行盒再额外撑高一行 */
.docx-page-spacer-inline { display: block; line-height: 0; font-size: 0; padding: 0; border: 0; }
.docx-page-gap { position: absolute; left: 0; right: 0; background: var(--canvas-bg, #e4e4ea); box-shadow: inset 0 7px 6px -7px rgba(0,0,0,0.22), inset 0 -7px 6px -7px rgba(0,0,0,0.22); }

/* 每页页脚（P4）：页码 / 文档自带页脚文本。绝对定位在纸的下边距带里
   —— 不参与文档流，因此既不进 getJSON，也不影响分页累加。
   ⚠️ 旧版把页码画在页间灰缝正中（.docx-page-num），末页没有尾随灰缝 ⇒ 末页永远没页码。 */
.docx-page-footer {
  position: absolute;
  text-align: center;
  font-size: 11px;
  white-space: pre-wrap;
  user-select: none;
  pointer-events: none;
  color: var(--ink-faint, #71717a);
}

@media print {
  /* 编辑器 chrome（标题栏 / 工具条 / 标尺 / 状态栏 / 修订栏 / 查找栏） */
  .docx-print-hide { display: none !important; }
  /* 最外层 flex 竖排 + overflow:hidden 会把长文档裁掉 */
  .docx-print-frame { display: block !important; height: auto !important; overflow: visible !important; background: #fff !important; }
  .docx-print-area { display: block !important; position: static !important; overflow: visible !important; min-height: 0 !important; padding: 0 !important; background: #fff !important; }
  .docx-print-col { width: auto !important; margin: 0 !important; }
  /* 缩放沙盒：绝对定位 + 定高 + scale 都是屏幕上的观感，打印时全部拆掉 */
  .docx-paper-scaler { position: static !important; width: auto !important; height: auto !important; margin: 0 !important; }
  .docx-paper-wrap { position: static !important; display: block !important; transform: none !important; width: auto !important; height: auto !important; }
  .docx-paper { min-height: 0 !important; margin: 0 !important; box-shadow: none !important; border-radius: 0 !important; }
  /* ① 灰缝不占高（spacer 的 height 是内联的 ⇒ 必须 !important + calc） */
  .docx-page-spacer { height: calc(var(--docx-h) - var(--docx-page-gap)) !important; }
  .docx-page-gap { background: transparent !important; box-shadow: none !important; }
  .docx-page-footer { color: #000 !important; }
}
`.trim()
}

/**
 * 换页间隙总高。
 * @param padTop 把上一页补足到满页所需的白高（内容已超出可用区时传 0）
 */
export function pageSpacerHeight(padTop: number, g: PageGeometry = currentGeometry): number {
  return Math.max(0, padTop) + 2 * g.marginY + g.gap
}

/**
 * 段内断点的**额外撑高**校正量（px）。
 *
 * 段内断点必须用 `display:block` 的元素插进行内才能产生断行（`inline-block` 实测**无效**：
 * 它只把当前那一行撑高，后续文字仍留在同一行）。而 `display:block` 插进行内会让浏览器
 * 多生成一个匿名行盒 ⇒ 实际推进量 = 设定高度 + 一个行距碎屑，实测恒定 +3~4px，且**与设定高度无关**。
 *
 * 数值来源（两套环境互证，见 docx分页Word化改造工单_20261003.md §9.1 / §十）：
 *   独立几何探针：15px → +3.0 / 17px → +3.2 / 19px → +3.9
 *   真实编辑器靶场：15px → +3.0（H=216 → 219，H=600 → 603）
 *
 * ⚠️ 字号档位会变（`html[data-fontscale]`，见 globals.css 的 `--fs-md`），
 * 所以不能写死一个常数 —— 必须按实测点做分段线性插值。
 */
export function inlineBreakExtra(fontSizePx: number): number {
  const pts: ReadonlyArray<readonly [number, number]> = [
    [15, 3.0],
    [17, 3.2],
    [19, 3.9],
  ]
  if (fontSizePx <= pts[0][0]) return pts[0][1]
  const last = pts[pts.length - 1]
  if (fontSizePx >= last[0]) return last[1]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    if (fontSizePx <= x1) return y0 + ((fontSizePx - x0) / (x1 - x0)) * (y1 - y0)
  }
  return last[1]
}

/** React 侧测得的换页位置 */
export interface PaginationBreak {
  /** 该断点所属的顶层块下标 */
  index: number
  /** 是否手动分页符（段落级 `w:pageBreakBefore`） */
  manual: boolean
  /** 上一页内容不足满页时，需要补的白高（px）；页内溢出时为 0 */
  padTop: number
  /**
   * 段内断点：间隙插在该**文档位置**（必须落在这个块内部），而不是块之前。
   * 未设置 ⇒ 块级断点（整块下移）。
   */
  inlinePos?: number
  /** 计算段内断点时使用的字号（px），用于抵消 `inlineBreakExtra` */
  fontSize?: number
}

export const paginationBreaksRef: { current: PaginationBreak[] } = { current: [] }

export const docxPaginationKey = new PluginKey('docxPagination')

export function setPaginationBreaks(breaks: PaginationBreak[]): void {
  paginationBreaksRef.current = breaks
}

/**
 * 构造一个页间间隙元素（三段式：白 → 灰缝 → 白）。
 *
 * P4（2026-10-04）：**不再在灰缝里画页码**（原 `.docx-page-num` 已移除）。
 *   两个原因：① 末页没有尾随 spacer ⇒ 页码**天然缺最后一页**；② 页码单调性此前依赖
 *   「闭包先取值 + widget key」这一对易错点。现改为宿主持有 `pageCount` 后按纯函数
 *   `pageFooterTopAt` 渲染每页页脚，整类缺陷消失。
 */
function makePageSpacer(b: PaginationBreak): HTMLElement {
  const g = pageGeometry()
  const inline = b.inlinePos != null
  // 段内断点走 display:block 的行内插入，浏览器会多出一个匿名行盒 ⇒ 扣掉实测的额外撑高
  const height = inline
    ? pageSpacerHeight(b.padTop) - inlineBreakExtra(b.fontSize ?? 15)
    : pageSpacerHeight(b.padTop)
  const h = Math.max(0, height)

  const el = document.createElement(inline ? 'span' : 'div')
  el.className = inline ? 'docx-page-spacer docx-page-spacer-inline' : 'docx-page-spacer'
  el.style.height = `${h}px`
  // 打印期要用 CSS 把灰缝这 24px 的高度扣掉（否则第 k 页整体下移 (k−1)·24），
  // 而高度是**内联**写的 → 打印规则必须 `!important` + `calc()`，故把两个量暴露成变量。
  el.style.setProperty('--docx-h', `${h}px`)
  el.style.setProperty('--docx-page-gap', `${g.gap}px`)
  el.setAttribute('contenteditable', 'false')

  const gap = document.createElement('div')
  gap.className = 'docx-page-gap'
  gap.style.top = `${b.padTop + g.marginY}px`
  gap.style.height = `${g.gap}px`
  el.appendChild(gap)
  return el
}

function pageSpacerKey(b: PaginationBreak, index: number): string {
  // ⚠️ key 必须涵盖**一切会影响 DOM 的量**：prosemirror-view 的 `WidgetType.eq` 在
  // `spec.key` 相同时直接判定为相等并**复用旧 DOM**（不会重新调用 toDOM），
  // 于是「padTop 变了但 spacer 高度不更新」这类陈旧 DOM 缺陷会静默发生。
  // 实测：key 只用下标时，同一位置改用不同形态/高度会拿到上一轮的 DOM（工单 §十）。
  // P4 起灰缝内不再有页码 ⇒ `manual` 已不影响 DOM，从 key 里去掉（少一次无谓重建）。
  return [
    'docx-page-spacer',
    index,
    b.inlinePos ?? 'block',
    Math.round(b.padTop),
    Math.round(b.fontSize ?? 0),
  ].join('-')
}

/** 一次分页测量的输入 */
export interface MeasureOptions {
  /** 顶层块的 DOM 元素，**按文档顺序**且与 `doc` 子节点一一对应；取不到传 null */
  blockEls: ReadonlyArray<HTMLElement | null>
  /** 根字号（px）—— 段内断点须按它抵消 `inlineBreakExtra` */
  fontSizePx: number
}

/** 一次分页测量的输出（纯数据，不含 DOM 副作用） */
export interface MeasureResult {
  breaks: PaginationBreak[]
  pages: number
  /** 每页页首相对滚动容器的纵坐标 */
  pageTops: number[]
  /** 纸面总高（用于撑开滚动容器） */
  paperHeightPx: number
  /** 所有顶层块高度之和；≤ 0 视为「布局未就绪」 */
  measuredTotal: number
}

/**
 * 取文本块的**行几何**（只用于定位「第几行是下页首行」，不用于高度累加）。
 *
 * 🔴 只走 `SHOW_TEXT` 遍历：段内 spacer 就住在段落内部，若用
 * `range.selectNodeContents(el).getClientRects()`，那条高达数百 px 的 spacer
 * 会被当成「一行」计进去。
 *
 * 落在段内 spacer 上的那条行间距，按**一个正常行距**计（`unit`）——
 * spacer 把段落切成多个匿名块，浏览器会在缝隙里额外生成匿名行盒，
 * 缝隙宽度 ≠ 正常行距 + spacer 高度（靶场实测 232px 的 spacer 造成 +121px 残留），
 * 所以这里**不按差值扣减**，直接归一为 `unit`。
 */
function textBlockLines(el: HTMLElement): { elTop: number; topsRel: number[]; lineH: number[] } | null {
  const topsAbs: number[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    const t = n as Text;
    if (t.length > 0) {
      const rr = document.createRange();
      rr.setStart(t, 0);
      rr.setEnd(t, t.length);
      for (const r of Array.from(rr.getClientRects())) {
        if (r.height <= 0) continue;
        if (!topsAbs.some((x) => Math.abs(x - r.top) <= 1)) topsAbs.push(r.top);
      }
    }
    n = walker.nextNode();
  }
  if (topsAbs.length < 2) return null;
  topsAbs.sort((a, b) => a - b);
  const elTop = el.getBoundingClientRect().top;
  const topsRel = topsAbs.map((t) => t - elTop);
  const lineH: number[] = [];
  for (let i = 0; i < topsRel.length; i++) {
    lineH.push(i + 1 < topsRel.length ? topsRel[i + 1] - topsRel[i] : topsRel[i] - topsRel[i - 1]);
  }

  // 落在段内 spacer 上的缝隙归一为一个正常行距
  const spacers = Array.from(el.querySelectorAll<HTMLElement>('.docx-page-spacer-inline'));
  if (spacers.length) {
    const plausible = lineH.filter((x) => x >= 8);
    const unit = plausible.length ? Math.min(...plausible) : lineH[0];
    for (const sp of spacers) {
      const rel = sp.getBoundingClientRect().top - elTop;
      for (let k = 0; k < topsRel.length - 1; k++) {
        if (rel >= topsRel[k] - 0.5 && rel < topsRel[k + 1] - 0.5) {
          lineH[k] = unit;
          break;
        }
      }
    }
  }
  return { elTop, topsRel, lineH };
}

/**
 * 测量换页点：遍历顶层块累加高度，超出单页可用区（`PAGE_USABLE_H`）时记一处换页，
 * 并给出把上一页补足到满页所需的 `padTop`。
 *
 * 块放不下时**优先在块内按行断页**（= Word 的段落跨页行为）：用 `view.coordsAtPos`
 * 二分定位「哪一行是下页首行」。只有「剩余空间不足 2 行」或「该块不是文本块（表格/图片/占位）」
 * 时才退化为整块下移。
 *
 * ⚠️ 本函数**只读**视图几何，不写任何状态；调用方负责「未就绪判定」与状态落盘。
 * 之所以抽成纯函数，是为了让靶场能驱动**同一份实现**验证收敛性（见工单 §十）。
 */
export function measurePageBreaks(view: EditorView, opts: MeasureOptions): MeasureResult {
  const { blockEls, fontSizePx } = opts;
  const doc = view.state.doc;
  // 当前节几何（P4）：可用高不再写死 A4，而是取自文档 sectPr（见 setPageGeometry）
  const g = pageGeometry();
  const usableH = usableHeight(g);

  /**
   * 在文本块内按行定位换页点；返回断点数组与该块**末段**高度（继续累加用）。
   * @param minLines 孤行控制要求的**最小行数**（页底与下页各需满足）——
   *   `w:widowControl` 缺省为开 ⇒ 2 行；显式 `false` ⇒ 1 行。
   */
  const breakInsideBlock = (
    nodeSize: number,
    offset: number,
    geo: { elTop: number; topsRel: number[]; lineH: number[] },
    budget0: number,
    blockIndex: number,
    minLines: number,
  ): { breaks: PaginationBreak[]; tail: number; segStart: number } | null => {
    const { elTop, topsRel, lineH } = geo;
    // 页底不足 minLines 行 ⇒ 不值得断在段内（Word 同样把整段推到下一页）
    if (budget0 < minLines * lineH[0]) return null;

    const blockStart = offset;
    const blockEnd = offset + nodeSize;
    /** 定位「某一行顶部」对应的文档位置（块内二分，O(log n) 次 coordsAtPos） */
    const posAtLineTop = (targetTop: number): number | null => {
      const topAt = (p: number): number | null => {
        try {
          return view.coordsAtPos(p).top;
        } catch {
          return null;
        }
      };
      let lo = blockStart + 1;
      let hi = Math.max(lo, blockEnd - 1);
      if (topAt(hi) == null) return null;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const t = topAt(mid);
        if (t == null) return null;
        if (t >= targetTop - 0.5) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };

    const out: PaginationBreak[] = [];
    let idx = 0;
    let budget = budget0;
    let segStart = 0;
    // 逐页推进：每轮取「当前页还能放下几行」，放不下就在下一行之前断页
    for (;;) {
      let used = 0;
      let m = 0;
      while (idx + m < lineH.length && used + lineH[idx + m] <= budget) {
        used += lineH[idx + m];
        m++;
      }
      if (m === 0) m = 1; // 极端：单行高于一页 —— 至少推进一行，避免死循环
      const next = idx + m;
      if (next >= lineH.length) break; // 余下全部放得下
      // 孤行控制的下半段：下页必须至少留下 minLines 行。留不下 ⇒ 不在此断，
      // 交给上层「整块下移」。（已找到的断点保留：out 非空时仍返回。）
      if (lineH.length - next < minLines) break;
      const pos = posAtLineTop(elTop + topsRel[next]);
      if (pos == null) break;
      out.push({
        index: blockIndex,
        manual: false,
        padTop: Math.max(0, budget - used),
        inlinePos: pos,
        fontSize: fontSizePx,
      });
      idx = next;
      segStart = next;
      budget = usableH;
    }
    if (!out.length) return null;
    let tail = 0;
    for (let i = segStart; i < lineH.length; i++) tail += lineH[i];
    return { breaks: out, tail, segStart };
  };

  // ── 阶段一：收集每个顶层块的高度、行几何与三项保真标志 ──
  // 之所以要「先收集再决策」：`keepNext` 需要**前瞻**（本块能否放下，取决于它与后续块组成的整组
  // 能否放下），单遍 forEach 拿不到后续块的高度。
  interface BlockInfo {
    di: number
    offset: number
    nodeSize: number
    h: number
    geo: { elTop: number; topsRel: number[]; lineH: number[] } | null
    /** w:pageBreakBefore —— 手动分页符 */
    manual: boolean
    /** w:keepNext —— 与下一块必须同页 */
    keepNext: boolean
    /** w:keepLines —— 段内不允许跨页 */
    keepLines: boolean
    /** 孤行控制要求的最小行数：widowControl 显式 false ⇒ 1，其余（含缺省）⇒ 2 */
    minLines: number
  }

  const blocks: BlockInfo[] = []
  /** 所有顶层块高度之和；仅作「布局是否就绪」守卫（见 MeasureResult.measuredTotal） */
  let measuredTotal = 0
  doc.forEach((node, offset, di) => {
    const el = blockEls[di] ?? null;
    const textblock = Boolean(el) && node.isTextblock;
    const geo = textblock && el ? textBlockLines(el) : null;
    // 块高一律用「盒高 − 块内 spacer 总高」：
    //   ① offsetHeight 是 border-box 高，天然含 padding/border，与旧口径的 `sum(lineH)+boxV` 等价；
    //   ② 段内 spacer 会把段落切成多个匿名块，行间距里混着**浏览器额外生成的匿名行盒开销**，
    //      靶场实测按「行间距减 spacer 高度」扣减只扣掉 232px 中的 111px（残留 +121px）。
    //      而 spacer 本身不贡献内容高，所以整块扣掉是唯一精确解。
    // 行几何只用于**定位断点行**，不参与高度累加 —— 两个职责必须分开。
    const spacerH = el
      ? Array.from(el.querySelectorAll<HTMLElement>('.docx-page-spacer')).reduce(
          (s, x) => s + (x.offsetHeight || 0),
          0,
        )
      : 0;
    const h = Math.max(0, (el ? el.offsetHeight || 0 : 0) - spacerH);
    measuredTotal += h;
    blocks.push({
      di,
      offset,
      nodeSize: node.nodeSize,
      h,
      geo,
      manual: node.attrs.pageBreakBefore === true,
      // 严格 === true：缺省 null 不等于「同页」（Word 缺省是「可断」）
      keepNext: node.attrs.keepNext === true,
      keepLines: node.attrs.keepLines === true,
      minLines: node.attrs.widowControl === false ? 1 : 2,
    });
  });

  /** keepNext 组的末尾下标（含）：由 keepNext 串起来，遇到手动分页符即止 */
  const keepGroupEnd = (i: number): number => {
    let j = i;
    while (j + 1 < blocks.length && blocks[j].keepNext && !blocks[j + 1].manual) j++;
    return j;
  };
  /** 组高：i..end 的块高之和（组内块的内边距/边框已含在各自 h 内） */
  const groupHeight = (i: number, end: number): number => {
    let s = 0;
    for (let k = i; k <= end; k++) s += blocks[k].h;
    return s;
  };

  // ── 阶段二：按页推进 ──
  let acc = 0;
  const breaks: PaginationBreak[] = [];

  /** 尝试在块内断页；`keepLines` 或非文本块直接放弃 */
  const tryInline = (b: BlockInfo, budget: number): { breaks: PaginationBreak[]; tail: number } | null => {
    if (!b.geo || b.keepLines) return null;
    return breakInsideBlock(b.nodeSize, b.offset, b.geo, budget, b.di, b.minLines);
  };

  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    const rest = usableH - acc;

    if (i === 0) {
      // 首块：**不能在其之前**断页（那会在文档最前面插一个空隙），但**块内跨页必须处理** ——
      // 否则「首段就超过一页」的开头文档会整段溢出首页（靶场场景 D 实测：pages=2、首块 4440px、
      // 块内断点数 0，首页白纸只装得下 931px）。
      const inner = tryInline(b, usableH);
      if (inner) {
        breaks.push(...inner.breaks);
        acc = inner.tail;
      } else {
        acc += b.h;
      }
      i++;
      continue;
    }

    if (b.manual) {
      // 手动分页符（段落级 w:pageBreakBefore）→ 块级断点，整块作为新页首块
      breaks.push({ index: b.di, manual: true, padTop: Math.max(0, rest) });
      acc = b.h;
      i++;
      continue;
    }

    // keepNext：把「本块 + 后续由 keepNext 串起的块」当作一个整体来判能否放下。
    // 例外：整组自身就超过一页 ⇒ keepNext 客观上无法满足（Word 同样放弃），退化为逐块判断。
    const end = keepGroupEnd(i);
    const need = groupHeight(i, end);
    const groupFitsPage = need <= usableH;

    if (end > i && groupFitsPage && acc + need > usableH) {
      // 整组下移：在组首块之前断页，组整体从新页顶开始
      breaks.push({ index: b.di, manual: false, padTop: Math.max(0, rest) });
      acc = need;
      i = end + 1;
      continue;
    }

    if (acc + b.h > usableH) {
      const inner = tryInline(b, rest);
      if (inner) {
        breaks.push(...inner.breaks);
        acc = inner.tail; // 末段从新页顶开始
      } else {
        breaks.push({ index: b.di, manual: false, padTop: Math.max(0, rest) });
        acc = b.h; // 整块下移到新页
      }
      i++;
      continue;
    }

    acc += b.h;
    i++;
  }

  const pages = breaks.length + 1;
  // 页起点只与页码有关：第 i 页（0-based）正文顶端 = marginY + i·stride（见 pageTopAt）。
  // 因为每页内容已被 padTop 补足成等高纸面，不再需要用实际内容高度累加（旧算法漏加 spacer
  // 占位，导致第 n 页的滚动定位/页码判定整整偏上 (n-1)*PAGE_SPACER）。
  const pageTops = Array.from({ length: pages }, (_, i) => pageTopAt(i, g));
  const paperHeightPx = paperHeightOf(pages, g);
  return { breaks, pages, pageTops, paperHeightPx, measuredTotal };
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

            // 文档顺序：见 `orderedBreaks`（同块内块级断点在前、段内断点按位置升序）。
            const ordered = orderedBreaks(breaks)

            const decos: Decoration[] = []
            let oi = 0
            state.doc.forEach((_node, offset, i) => {
              while (oi < ordered.length && ordered[oi].index === i) {
                const b = ordered[oi]
                oi++
                const pos = b.inlinePos ?? offset
                if (pos > state.doc.content.size) continue
                // P4：spacer 内已无页码 ⇒ 无需再维护「页码闭包取值」那套易错逻辑
                decos.push(
                  Decoration.widget(pos, () => makePageSpacer(b), {
                    side: -1,
                    key: pageSpacerKey(b, i),
                  }),
                )
              }
            })
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})
