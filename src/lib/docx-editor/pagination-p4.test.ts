/**
 * P4（页码归位 + 打印保真）的**纯函数**单测：页脚几何 + 节几何切换。
 *
 * 为什么单独一个文件、且只测纯函数：
 *   · P1–P3 的分页消费侧已由 Electron 靶场（`pagination-p0-probe`）驱动产品函数验证；
 *     但 P4 新增的「页脚应该画在哪」是一个**坐标计算**问题 —— 它能、也应该用断言直接钉死，
 *     不必再拉靶场。靶场留给「几何切换后断点数随之变化」这类需要真实布局的判据。
 *   · 本文件**不 import docx 引擎**（`docx-pagination.ts` 刻意用结构化类型入参），
 *     因此不受「冷 import 引擎 9–15s」影响，默认 5s 超时足够。
 *
 * 🔴 口径修正（相对工单 §十四.5 的草案）：草案写的是
 *     `pageFooterTopAt(i) = pageTopAt(i) + h − footerDist − lineH`，
 *   但 `pageTopAt(i)` 含 `marginY`（**正文区**偏移），而页脚要贴的是**纸的物理底边**。
 *   照草案算 i=0 会得到 1171（> 纸高 1123，掉到纸外）。故实现改为
 *     `i·stride + h − footerDist − lineH`
 *   并把「页脚必须落在正文区之下」写成断言 —— 让这条口径由测试守住，而不是靠注释。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GEOMETRY,
  PAGE_GAP,
  PAGE_H,
  PAGE_MARGIN_Y,
  PAGE_STRIDE,
  PAGE_USABLE_H,
  PAGE_W,
  geometryFromSection,
  orderedBreaks,
  pageFooterTopAt,
  pageGeometry,
  pageSpacerHeight,
  pageStride,
  pageTopAt,
  paperHeightOf,
  setPageGeometry,
  usableHeight,
  type PaginationBreak,
} from '@/components/canvas/docx-editor/docx-pagination'

/** 几何住在模块级单例里 ⇒ 每个用例结束都要复位，否则用例之间互相串味 */
afterEach(() => setPageGeometry(null))

describe('P4 · 节几何默认值必须与 P1/P2 的既有不变量逐值一致（不回归）', () => {
  it('默认几何 = A4 + 1in 边距 + 24px 灰缝 + 48px 页脚距', () => {
    expect(pageGeometry()).toEqual(DEFAULT_GEOMETRY)
    expect(DEFAULT_GEOMETRY).toEqual({
      w: PAGE_W,
      h: PAGE_H,
      marginX: 96,
      marginY: PAGE_MARGIN_Y,
      gap: PAGE_GAP,
      footerDist: 48,
    })
  })

  it('usableHeight / pageStride / pageTopAt 与旧常量逐值相等', () => {
    expect(usableHeight()).toBe(PAGE_USABLE_H)
    expect(pageStride()).toBe(PAGE_STRIDE)
    expect(pageTopAt(0)).toBe(PAGE_MARGIN_Y)
    expect(pageTopAt(3)).toBe(PAGE_MARGIN_Y + 3 * PAGE_STRIDE)
  })

  it('paperHeightOf 与旧公式 pages·H + (pages−1)·GAP 相等', () => {
    for (const pages of [1, 2, 3, 7]) {
      expect(paperHeightOf(pages)).toBe(pages * PAGE_H + (pages - 1) * PAGE_GAP)
    }
    // 0 页时不得出现负的灰缝贡献
    expect(paperHeightOf(0)).toBe(0)
  })
})

describe('P4 · 页脚坐标（探针 ①）', () => {
  const LINE_H = 16

  it('与 i·stride + h − footerDist − lineH 逐值相等（1 / 2 / 5 页）', () => {
    for (const i of [0, 1, 4]) {
      expect(pageFooterTopAt(i, LINE_H)).toBe(
        i * PAGE_STRIDE + PAGE_H - DEFAULT_GEOMETRY.footerDist - LINE_H,
      )
    }
    // 具体值（默认几何）：i=0 → 1075 − 16 = 1059
    expect(pageFooterTopAt(0, LINE_H)).toBe(1059)
    expect(pageFooterTopAt(1, LINE_H)).toBe(1059 + PAGE_STRIDE)
  })

  it('页脚落在正文区**之外**（正文底 ≤ 页脚顶 ≤ 纸底）', () => {
    for (const i of [0, 1, 2, 9]) {
      const textBottom = pageTopAt(i) + usableHeight()
      const footTop = pageFooterTopAt(i, LINE_H)
      const paperBottom = i * pageStride() + PAGE_H
      expect(footTop).toBeGreaterThanOrEqual(textBottom) // 不压正文
      expect(footTop + LINE_H).toBeLessThanOrEqual(paperBottom) // 不出纸
    }
  })

  it('横向（纸宽 > 纸高）时竖坐标只随纸高走，与纸宽无关', () => {
    setPageGeometry({ w: 1123, h: 794 })
    expect(pageFooterTopAt(0, LINE_H)).toBe(794 - 48 - LINE_H)
    expect(pageFooterTopAt(2, LINE_H)).toBe(2 * (794 + PAGE_GAP) + 794 - 48 - LINE_H)
  })

  it('非默认 footerDist（如 0.5in = 720twips→48px vs 360twips→24px）只平移页脚', () => {
    const base = pageFooterTopAt(0, LINE_H)
    setPageGeometry({ footerDist: 24 })
    expect(pageFooterTopAt(0, LINE_H)).toBe(base + 24)
    setPageGeometry({ footerDist: 96 })
    expect(pageFooterTopAt(0, LINE_H)).toBe(base - 48)
  })

  it('行高变化只平移页脚（页脚底边距纸底恒为 footerDist）', () => {
    for (const lineH of [14, 16, 20]) {
      const top = pageFooterTopAt(0, lineH)
      expect(top + lineH).toBe(PAGE_H - DEFAULT_GEOMETRY.footerDist)
    }
  })
})

describe('P4 · 几何切换（探针 ② 的纯函数部分）', () => {
  it('切换 marginY / h 后可用高随之变化，复位后与默认一致', () => {
    expect(usableHeight()).toBe(931)

    setPageGeometry({ marginY: 72, h: 1684 })
    expect(usableHeight()).toBe(1684 - 144)
    expect(pageStride()).toBe(1684 + PAGE_GAP)
    expect(pageTopAt(1)).toBe(72 + 1684 + PAGE_GAP)

    setPageGeometry(null)
    expect(pageGeometry()).toEqual(DEFAULT_GEOMETRY)
    expect(usableHeight()).toBe(931)
    expect(pageTopAt(1)).toBe(PAGE_MARGIN_Y + PAGE_STRIDE)
  })

  it('部分覆盖只改指定字段，其余继承默认', () => {
    setPageGeometry({ marginY: 72 })
    expect(pageGeometry()).toEqual({ ...DEFAULT_GEOMETRY, marginY: 72 })
  })

  it('pageSpacerHeight 随几何变化（= padTop + 2·marginY + gap）', () => {
    expect(pageSpacerHeight(100)).toBe(100 + 2 * 96 + PAGE_GAP)
    setPageGeometry({ marginY: 72, gap: 12 })
    expect(pageSpacerHeight(100)).toBe(100 + 144 + 12)
    // 负 padTop 视为 0
    expect(pageSpacerHeight(-50)).toBe(144 + 12)
  })
})

describe('P4 · geometryFromSection：twips → px 换算与兜底', () => {
  it('A4 节属性（11906×16838 twips、1440 边距、720 页脚距）→ 默认几何', () => {
    const g = geometryFromSection({
      pageWidth: 11906,
      pageHeight: 16838,
      marginTop: 1440,
      marginBottom: 1440,
      marginLeft: 1440,
      marginRight: 1440,
      footerDist: 720,
    })
    // 16838/15 = 1122.5 → 1123；11906/15 = 793.7 → 794（与 PAGE_W/PAGE_H 一致，故 A4 文档零漂移）
    expect(g).toEqual({ w: PAGE_W, h: PAGE_H, marginX: 96, marginY: 96, footerDist: 48 })
  })

  it('非对称上下边距取均值 ⇒ h − 2·marginY 精确等于真实可用高', () => {
    const g = geometryFromSection({ pageHeight: 16838, marginTop: 1440, marginBottom: 2880 })
    // (96 + 192)/2 = 144
    expect(g.marginY).toBe(144)
    setPageGeometry(g)
    expect(usableHeight()).toBe(Math.round(16838 / 15) - 96 - 192)
  })

  it('缺项 / 0 / NaN 一律不落进几何（由默认值兜底，避免 0 高纸把分页算成 1 页）', () => {
    expect(geometryFromSection({})).toEqual({})
    expect(geometryFromSection({ pageWidth: 0, pageHeight: NaN, marginTop: -5 })).toEqual({})
    // 只有一侧有值时单边生效，而不是丢掉整项
    expect(geometryFromSection({ marginTop: 1440 })).toEqual({ marginY: 96 })
  })
})

describe('P4 · orderedBreaks：页脚序号必须按文档顺序递增', () => {
  const mk = (index: number, inlinePos?: number): PaginationBreak => ({
    index,
    manual: false,
    padTop: 0,
    ...(inlinePos == null ? {} : { inlinePos }),
  })

  it('先按块下标；同块内块级断点（无 inlinePos）在前，段内断点按位置升序', () => {
    const out = orderedBreaks([mk(1, 40), mk(0), mk(1), mk(0, 90), mk(0, 20)])
    expect(out.map((b) => [b.index, b.inlinePos ?? -1])).toEqual([
      [0, -1],
      [0, 20],
      [0, 90],
      [1, -1],
      [1, 40],
    ])
  })

  it('不改动入参（纯函数）', () => {
    const input = [mk(2), mk(1)]
    const snapshot = input.map((b) => b.index)
    orderedBreaks(input)
    expect(input.map((b) => b.index)).toEqual(snapshot)
  })
})
