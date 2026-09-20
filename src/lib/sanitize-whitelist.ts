/**
 * sanitize 白名单（rehype-sanitize schema 扩展）
 *
 * 两个用途：
 *   - MARKDOWN_SANITIZE_WHITELIST：正文 Markdown 渲染（编辑器 HtmlRenderer / 分享页共享），
 *     放行 AI 输出的交互元素与内联 SVG 插图。
 *   - SHARE_WIDGET_SANITIZE_WHITELIST：分享页 widget 片段净化（在上一套基础上额外放行
 *     内联 style / data-* 属性，与客户端 HtmlWidget 的 DOMPurify 行为对齐）。
 *
 * 注意：属性名必须使用 hast property 名（camelCase，如 className / strokeWidth / textAnchor）——
 * rehype-sanitize 按此匹配，写成 kebab-case（stroke-width）会被静默丢弃。
 * 另注意易错的合成词命名：stroke-linecap/stroke-linejoin 对应 strokeLineCap / strokeLineJoin（大写 C/J），
 * 而非 strokeLinecap / strokeLinejoin。
 */
import type { SanitizeWhitelist } from 'unified-renderer';

export const MARKDOWN_SANITIZE_WHITELIST: SanitizeWhitelist = {
  tags: [
    'details', 'summary', 'mark', 'button',
    // SVG 标签（内联 <svg> 插图/信息图被 sanitize 剥掉时只残留文字，这里放行）
    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop',
    'use', 'clipPath', 'mask', 'pattern', 'image', 'marker', 'filter', 'title',
    'foreignObject',
  ],
  attributes: {
    '*': ['className'],
    mark: ['data-note', 'className'],
    a: ['target', 'rel'],
    button: ['className', 'type'],
    code: ['className'],
    pre: ['className'],
    span: ['className'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    table: ['className'],
    // width：分享卡拖拽调整图片大小后，尺寸以 <img width> 写入正文，需放行（其余场景由 CSS 压制）
    img: ['className', 'src', 'alt', 'width'],
    svg: ['id', 'viewBox', 'width', 'height', 'xmlns', 'preserveAspectRatio', 'role', 'aria-label'],
    g: ['id', 'className', 'transform', 'opacity', 'fill', 'stroke', 'strokeWidth'],
    path: ['id', 'className', 'd', 'fill', 'stroke', 'strokeWidth', 'strokeLineCap', 'strokeLineJoin', 'strokeDasharray', 'markerEnd', 'markerStart', 'transform', 'opacity', 'fillOpacity', 'strokeOpacity'],
    rect: ['id', 'className', 'x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'strokeWidth', 'transform', 'opacity'],
    circle: ['id', 'className', 'cx', 'cy', 'r', 'fill', 'stroke', 'strokeWidth', 'transform'],
    ellipse: ['id', 'className', 'cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'strokeWidth'],
    line: ['id', 'className', 'x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth', 'strokeDasharray', 'markerEnd'],
    polyline: ['id', 'className', 'points', 'fill', 'stroke', 'strokeWidth', 'strokeLineCap', 'strokeLineJoin'],
    polygon: ['id', 'className', 'points', 'fill', 'stroke', 'strokeWidth', 'strokeLineCap', 'strokeLineJoin'],
    text: ['id', 'className', 'x', 'y', 'dx', 'dy', 'textAnchor', 'dominantBaseline', 'fill', 'stroke', 'fontSize', 'fontWeight', 'fontFamily', 'transform'],
    tspan: ['id', 'className', 'x', 'y', 'dx', 'dy', 'textAnchor', 'dominantBaseline', 'fill', 'fontSize', 'fontWeight'],
    defs: [],
    linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits'],
    radialGradient: ['id', 'cx', 'cy', 'r', 'gradientUnits'],
    stop: ['offset', 'stopColor', 'stopOpacity'],
    use: ['href', 'xLinkHref', 'x', 'y', 'width', 'height'],
    clipPath: ['id'],
    mask: ['id'],
    image: ['href', 'xLinkHref', 'x', 'y', 'width', 'height', 'preserveAspectRatio'],
    marker: ['id', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits'],
    foreignObject: ['x', 'y', 'width', 'height', 'className'],
  },
  /** 放行 data: 协议：粘贴截图以 base64 内联嵌入 Markdown，需允许 img/src 用 data: URL */
  protocols: {
    src: ['data'],
  },
};

/**
 * 分享页 widget 净化白名单：在正文白名单基础上，
 * 放行 widget 组件依赖的内联 style 与 data-* 属性，并补充常用排版标签。
 */
export const SHARE_WIDGET_SANITIZE_WHITELIST: SanitizeWhitelist = {
  tags: [
    ...(MARKDOWN_SANITIZE_WHITELIST.tags ?? []),
    // 样式表：mermaid / widget 产物自带 <style>（主题变量与字体）
    'style',
    'section', 'article', 'header', 'footer', 'aside', 'figure', 'figcaption',
    'dl', 'dt', 'dd', 'small', 'label', 'time', 'kbd', 'sub', 'sup', 'progress', 'meter',
  ],
  attributes: {
    ...MARKDOWN_SANITIZE_WHITELIST.attributes,
    // 通配：组件类名 + 内联样式 + data-* 属性（widget 卡片布局依赖）
    '*': ['className', 'style', 'data*'],
  },
};
