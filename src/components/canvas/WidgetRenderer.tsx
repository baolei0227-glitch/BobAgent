'use client';

import { Component, useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import DOMPurify from 'dompurify';
import { renderMermaidSVG } from '@ktrysmt/beautiful-mermaid';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import {
  buildMermaidTheme,
  buildWidgetHtmlCss,
  getMermaidRenderColors,
  getWidgetTokens,
  scopeCss,
} from '@/lib/widget-theme';
import type { WidgetBlock } from '@/lib/widget-blocks';

// ============================================================
// WidgetRenderer — 在聊天气泡中渲染 AI 生成的可视化内容
//
// 支持三种类型：
//   1. svg     — 直接 dangerouslySetInnerHTML 渲染（安全：SVG 无脚本执行能力）
//   2. html    — 通过 iframe srcdoc 沙箱渲染（支持 JS，隔离安全）
//   3. mermaid — 本地 mermaid 库渲染为 SVG（flowchart/sequence/class 等）
//
// 点击 widget 可放大查看（浮层展示，支持 ESC / 点击遮罩关闭）。
//
// AI 在回答中用代码块语法输出：
//   ```widget:svg
//   <svg>...</svg>
//   ```
//   ```widget:html
//   <div>...</div>
//   ```
//   ```widget:mermaid
//   flowchart TD
//     A[开始] --> B[结束]
//   ```
// ============================================================

/** v3: 亮度阈值判定 — 对所有主题采样背景色，计算相对亮度 L，L < 0.25 判定深色 */
export function detectHostDark(): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;

  // 优先：采样 --background 计算亮度（覆盖所有主题，不按主题名匹配）
  try {
    const bg = getComputedStyle(root).getPropertyValue('--background').trim();
    if (bg) {
      // oklch(L C H) — L 即感知明度
      const oklchMatch = bg.match(/oklch\(\s*([\d.]+)/);
      if (oklchMatch) return parseFloat(oklchMatch[1]) < 0.25;
      // hex
      const hexMatch = bg.match(/#([0-9a-f]{3,8})/i);
      if (hexMatch) return hexToLuminance(hexMatch[1]) < 0.25;
      // rgb/rgba
      const rgbMatch = bg.match(/rgba?\(\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)/);
      if (rgbMatch) return relativeLuminance(+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]) < 0.25;
    }
  } catch {
    // 采样失败，回退到主题名 + 系统偏好
  }

  // 回退 1：统一主题（dynamic-ui Purple）为浅色；无深色预设主题名
  const themeId = root.dataset.theme || '';

  // 回退 2：无主题时跟随系统偏好
  if (!themeId && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return false;
}

/** 计算 hex 色值的相对亮度（WCAG） */
function hexToLuminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return relativeLuminance(r, g, b);
}

/** WCAG 相对亮度 */
function relativeLuminance(r: number, g: number, b: number): number {
  const toLin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

/** 订阅宿主主题变化（data-theme 属性或系统偏好） */
export function useWidgetTheme(): boolean {
  const [dark, setDark] = useState<boolean>(() => detectHostDark());
  useEffect(() => {
    const update = () => setDark(detectHostDark());
    update();
    const root = document.documentElement;
    const mo = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(update)
      : null;
    mo?.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    mq?.addEventListener('change', update);
    return () => {
      mo?.disconnect();
      mq?.removeEventListener('change', update);
    };
  }, []);
  return dark;
}

/** 骨架屏：widget 正在流式生成时的占位卡片（token 配色，随宿主深浅色） */
export function WidgetSkeleton() {
  const dark = useWidgetTheme();
  const t = getWidgetTokens(dark);
  return (
    <div
      className="widget-renderer w-full"
      data-widget-theme={dark ? 'dark' : 'light'}
    >
      <div className="flex items-center gap-2">
        <div
          className="h-3 w-3 animate-pulse rounded-full"
          style={{ backgroundColor: t.bgAlt, border: `1px solid ${t.border}` }}
        />
        <div
          className="h-2.5 w-24 animate-pulse rounded"
          style={{ backgroundColor: t.bgAlt }}
        />
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <div className="h-2.5 w-3/4 animate-pulse rounded" style={{ backgroundColor: t.bgAlt }} />
        <div className="h-2.5 w-1/2 animate-pulse rounded" style={{ backgroundColor: t.bgAlt }} />
        <div className="h-2.5 w-2/3 animate-pulse rounded" style={{ backgroundColor: t.bgAlt }} />
      </div>
    </div>
  );
}

// ============================================================
// SVG 渲染器 — 直接内联渲染
// ============================================================

function SvgWidget({ code, title, onRendered }: { code: string; title?: string; onRendered?: () => void }) {
  const dark = useWidgetTheme();
  const t = getWidgetTokens(dark);
  // 简单清理：移除可能的 <script> 标签（SVG 规范不允许，但防御性处理）
  const safeCode = useMemo(() => {
    return code.replace(/<script[\s\S]*?<\/script>/gi, '');
  }, [code]);

  // 同步渲染完成信号（供分享截图测量宽度使用）
  useLayoutEffect(() => {
    onRendered?.();
  }, [onRendered]);

  return (
    <div
      className="widget-renderer w-full"
      data-widget-theme={dark ? 'dark' : 'light'}
    >
      {title && (
        <div
          className="mb-1.5 text-xs font-medium"
          style={{ color: 'var(--ink-muted)' }}
        >
          {title}
        </div>
      )}
      <div
        className="flex justify-center"
        dangerouslySetInnerHTML={{ __html: safeCode }}
      />
    </div>
  );
}

// ============================================================
// HTML 渲染器 — 净化 + 内联渲染（对齐 Trae dynamic-ui）
// 不再使用 iframe 沙箱：widget:html 经 DOMPurify 净化后直接内联进正文流，
// 无边框容器、无高度测量、无内部滚动条；主题变量通过作用域类隔离，不污染全局。
// ============================================================

function HtmlWidget({ code, title, onRendered }: { code: string; title?: string; onRendered?: () => void }) {
  const dark = useWidgetTheme();
  const t = getWidgetTokens(dark);
  const scopeId = useMemo(() => `ws-${Math.random().toString(36).slice(2, 9)}`, []);

  const { scopedStyles, safeHtml } = useMemo(() => {
    // ① 提取 widget 自带的 <style> 块（模型按协议写的首行主题变量），其余内容进入净化
    const styleBlocks: string[] = [];
    const content = code.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (m) => {
      styleBlocks.push(m.replace(/<\/?style[^>]*>/gi, ''));
      return '';
    });
    // ② 渲染器注入的组件 CSS（.w-* 类）+ widget 自身 style，全部作用域化到本容器
    const componentCss = scopeCss(buildWidgetHtmlCss(t), scopeId);
    const widgetCss = styleBlocks.map((s) => scopeCss(s, scopeId)).join('\n');
    // ③ DOMPurify 净化：保留常用标签与 style 属性，剥 script/iframe/object/embed 与事件处理器
    const safe = DOMPurify.sanitize(content, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'ondblclick', 'onchange', 'onsubmit', 'onmouseover', 'onmouseout', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'onfocus', 'onblur', 'oninput', 'onwheel', 'ontouchstart', 'ontouchend', 'ondrag', 'ondrop'],
    });
    return { scopedStyles: `${componentCss}\n${widgetCss}`, safeHtml: safe };
  }, [code, t, scopeId]);

  // 内联渲染为同步 DOM，挂载即就绪（供分享截图等外部等待）
  useLayoutEffect(() => {
    onRendered?.();
  }, [onRendered]);

  if (!safeHtml.trim()) return null;
  return (
    <div className={`widget-renderer w-full ${scopeId}`} data-widget-theme={dark ? 'dark' : 'light'}>
      {title && (
        <div className="mb-1 text-xs font-medium" style={{ color: t.textMuted }}>
          {title}
        </div>
      )}
      {/* 作用域主题 CSS（组件类 + widget 自身变量），随容器注入 */}
      <style>{scopedStyles}</style>
      {/* 净化后内联渲染：无 iframe、无边框容器、无滚动条，随正文自然流动 */}
      <div dangerouslySetInnerHTML={{ __html: safeHtml }} />
    </div>
  );
}

// ============================================================
// Mermaid 渲染器 — 双引擎：
//   1. beautiful-mermaid（同步渲染、精美主题）：flowchart/state/sequence/class/ER/xychart
//   2. mermaid.js（异步渲染、全类型兜底）：gantt/pie/mindmap 等不支持的类型自动回退
// ============================================================

/**
 * 修复 Mermaid timeline 图表文字溢出问题
 * 将 timeline 节点中的 SVG <text> 元素替换为 <foreignObject> + HTML div，
 * 利用 CSS word-wrap / white-space: pre-wrap 实现可靠的文字自动换行。
 * 仅处理包含 timeline 相关 class 的 SVG，其他类型保持不变。
 */
export function fixTimelineTextOverflow(svgString: string): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svgEl = doc.documentElement;

    if (!svgEl || svgEl.nodeName.toLowerCase() !== 'svg') return svgString;

    // 判断是否为 timeline 图表（section class 或 tText class 或 .tick class）
    const isTimeline =
      svgEl.querySelector('g.section') !== null ||
      svgEl.querySelector('g.tText') !== null ||
      svgEl.querySelector('.tick') !== null;

    if (!isTimeline) return svgString;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const XLINK_NS = 'http://www.w3.org/1999/xlink';

    // 处理函数：将 SVG <text> 元素替换为 <foreignObject>
    const processTextElement = (textEl: Element) => {
      const parent = textEl.parentElement;
      if (!parent) return;

      const svgText = textEl as SVGTextElement;
      const bbox = svgText.getBBox();
      if (bbox.width <= 0 || bbox.height <= 0) return;

      const transform = textEl.getAttribute('transform') || '';
      const svgStyle = (textEl as HTMLElement).style as CSSStyleDeclaration;
      const fontSize = svgStyle.fontSize || '14px';
      const color =
        svgStyle.fill ||
        textEl.getAttribute('fill') ||
        'currentColor';
      const fontWeight = svgStyle.fontWeight || 'normal';
      const textAnchor = textEl.getAttribute('text-anchor') || 'start';

      // 提取所有 tspan 文本
      const tspans = textEl.querySelectorAll('tspan');
      let textContent = '';
      if (tspans.length > 0) {
        tspans.forEach((tspan) => {
          textContent += tspan.textContent + '\n';
        });
        textContent = textContent.trimEnd();
      } else {
        textContent = textEl.textContent || '';
      }

      if (!textContent.trim()) return;

      const x = parseFloat(textEl.getAttribute('x') || '0');
      const y = parseFloat(textEl.getAttribute('y') || '0');

      // 估算换行宽度：基于 bounding box 和字体大小
      const estimatedWidth = Math.max(bbox.width + 8, 60);

      const foreignObject = doc.createElementNS(SVG_NS, 'foreignObject');
      foreignObject.setAttribute('x', String(x));
      foreignObject.setAttribute('y', String(y - bbox.height - 2));
      foreignObject.setAttribute('width', String(estimatedWidth));
      foreignObject.setAttribute('height', String(bbox.height * 3 + 8));
      foreignObject.setAttribute('color', color);

      if (transform) foreignObject.setAttribute('transform', transform);

      const div = document.createElement('div');
      div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      div.style.width = '100%';
      div.style.height = '100%';
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.justifyContent =
        textAnchor === 'middle'
          ? 'center'
          : textAnchor === 'end'
            ? 'flex-end'
            : 'flex-start';
      div.style.fontSize = fontSize;
      div.style.fontWeight = fontWeight;
      div.style.color = color;
      div.style.lineHeight = '1.3';
      div.style.wordWrap = 'break-word';
      div.style.whiteSpace = 'pre-wrap';
      div.style.overflowWrap = 'break-word';
      div.style.fontFamily = svgStyle.fontFamily || 'inherit';
      div.textContent = textContent;

      foreignObject.appendChild(div);
      parent.replaceChild(foreignObject, textEl);
    };

    // 优先处理 timeline 中的 section label 和 tText 文字
    const sectionLabels = svgEl.querySelectorAll('g.section > text, g.tText > text');
    sectionLabels.forEach(processTextElement);

    // 处理 timeline tick（时间刻度）文字
    const tickTexts = svgEl.querySelectorAll('g.tick text');
    tickTexts.forEach(processTextElement);

    // 处理剩余的 .timeline text（兜底）
    const otherTexts = svgEl.querySelectorAll('.timeline text');
    otherTexts.forEach(processTextElement);

    // 处理 timeline title
    const titleTexts = svgEl.querySelectorAll('.timeline-title text, text.title');
    titleTexts.forEach(processTextElement);

    return svgEl.outerHTML;
  } catch {
    return svgString;
  }
}

// ============================================================
// Apple 语义分区 tint — subgraph 后处理
// beautiful-mermaid 的 subgraph（<g class="subgraph">）底色由 CSS 变量统一驱动，
// 无法按分区区分。这里在渲染完成后对 SVG 做后处理：按文档顺序给每个 subgraph
// 的背景 rect 与头条 rect 覆盖 Apple 系统淡 tint（蓝/绿/橙/紫/青/粉轮换），
// 多个板块各一色，结构分区一眼可辨。节点保持中性白卡，色彩只做"分区"、克制不花哨
// （Apple 式分层：色块只出现在结构层，内容层保持中性）。
// 仅处理 flowchart 的 subgraph；其他图类型无 g.subgraph 匹配，原样返回。
// ============================================================
const APPLE_SUBGRAPH_TINTS = {
  light: {
    fills: ['#E9F2FF', '#EBF8EE', '#FFF3E6', '#F3EFFF', '#E9F7FB', '#FDF0F6'],
    headers: ['#D9E8FF', '#DDF1E3', '#FFEBD1', '#E9E0FF', '#D9F1F8', '#FBDCEF'],
  },
  dark: {
    fills: ['#1E2A3A', '#1D2B23', '#32291E', '#2B2440', '#1C2B30', '#33222E'],
    headers: ['#2A3A52', '#2B4235', '#4A3D28', '#3F3560', '#29404A', '#4B2F43'],
  },
};

export function applyAppleSemanticTints(svgString: string, dark: boolean): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (!svgEl || svgEl.nodeName.toLowerCase() !== 'svg') return svgString;
    const groups = Array.from(svgEl.querySelectorAll('g.subgraph'));
    if (!groups.length) return svgString;
    const t = dark ? APPLE_SUBGRAPH_TINTS.dark : APPLE_SUBGRAPH_TINTS.light;
    groups.forEach((g, i) => {
      const rects = Array.from(g.querySelectorAll(':scope > rect'));
      if (!rects.length) return;
      const fill = t.fills[i % t.fills.length];
      const header = t.headers[i % t.headers.length];
      const stroke = dark ? 'rgba(229, 229, 229, 0.22)' : 'rgba(23, 23, 23, 0.16)';
      rects[0].setAttribute('fill', fill); // 分区背景
      rects[0].setAttribute('stroke', stroke);
      if (rects[1]) {
        rects[1].setAttribute('fill', header); // 分区头条（深一档）
        rects[1].setAttribute('stroke', stroke);
      }
    });
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return svgString;
  }
}

function MermaidWidget({ code, title, onRendered }: { code: string; title?: string; onRendered?: () => void }) {
  const dark = useWidgetTheme();
  const t = getWidgetTokens(dark);
  // 优先 beautiful-mermaid 同步渲染（无闪屏，暖纸感主题）
  const { svg: bmSvg, error: bmError } = useMemo(() => {
    try {
      const raw = renderMermaidSVG(code, { ...getMermaidRenderColors(t), transparent: true, padding: 16 });
      const fixed = fixTimelineTextOverflow(raw);
      return { svg: applyAppleSemanticTints(fixed, dark), error: '' };
    } catch (e) {
      return { svg: '', error: e instanceof Error ? e.message : String(e) };
    }
  }, [code, t, dark]);

  // beautiful-mermaid 不支持的图类型 → 回退 mermaid.js 异步渲染
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const renderSeq = useRef(0);

  useEffect(() => {
    if (bmSvg || !bmError) return; // 已由 beautiful-mermaid 渲染，或内容为空
    let cancelled = false;
    setLoading(true);
    setError('');
    renderSeq.current += 1;
    const id = `wm-${Date.now()}-${renderSeq.current}`;

    (async () => {
      try {
        const mermaidMod = await import('mermaid');
        const mermaid = mermaidMod.default ?? mermaidMod;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'loose',
          fontFamily: t.sansFont,
          themeVariables: { ...buildMermaidTheme(t) },
          flowchart: { useMaxWidth: true, htmlLabels: true, wrappingWidth: 180 },
          sequence: { useMaxWidth: true, mirrorActors: false },
          gantt: { useMaxWidth: true },
          timeline: { useMaxWidth: true },
        });
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(applyAppleSemanticTints(fixTimelineTextOverflow(rendered), dark));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [bmSvg, bmError, code, t, dark]);

  const displaySvg = bmSvg || svg;
  const displayError = bmSvg ? '' : error;

  // 渲染完成信号（同步 beautiful-mermaid 直接触发；异步回退引擎在 loading 结束后触发）
  useEffect(() => {
    if (displaySvg || !loading) {
      onRendered?.();
    }
  }, [displaySvg, loading, onRendered]);

  return (
    <div
      className="widget-renderer w-full"
      data-widget-theme={dark ? 'dark' : 'light'}
    >
      {title && (
        <div
          className="mb-1.5 text-xs font-medium"
          style={{ color: 'var(--ink-muted)' }}
        >
          {title}
        </div>
      )}
      {!displaySvg && loading ? (
        <div className="py-4 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
          Rendering diagram...
        </div>
      ) : displayError && !displaySvg ? (
        <div className="py-2 text-xs" style={{ color: t.danger }}>
          Diagram rendering failed: {displayError}
        </div>
      ) : (
        <div
          className="flex justify-center"
          dangerouslySetInnerHTML={{ __html: displaySvg }}
        />
      )}
    </div>
  );
}

// ============================================================
// ECharts 渲染器 — 数据图表（柱/折线/饼/散点/雷达/树/关系/桑基等）
// AI 输出 JSON option → echarts.init + setOption 渲染
// 安全：JSON.parse 无脚本执行能力，无需 iframe 沙箱
// ============================================================

function ChartWidget({ code, title, onRendered }: { code: string; title?: string; onRendered?: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const dark = useWidgetTheme();
  const t = getWidgetTokens(dark);
  // 图表渲染完成标记（分享截图等外部等待用）
  const [ready, setReady] = useState(false);

  // 解析 AI 输出的 JSON（顶层 { option: {...} } 或直接 option 对象）
  const parsed = useMemo<{ ok: boolean; option?: EChartsOption; message?: string }>(() => {
    try {
      const raw = JSON.parse(code);
      const option = (raw && typeof raw === 'object' && 'option' in raw) ? raw.option : raw;
      if (!option || typeof option !== 'object') {
        return { ok: false, message: 'option 字段缺失或不是对象' };
      }
      return { ok: true, option: option as EChartsOption };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [code]);

  // 渲染图表
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !parsed.ok) return;

    // v3: 注入默认样式（grid/tooltip/legend/splitLine/axisLabel/animation）
    // 用户 option 可覆盖任一默认值（浅合并：用户提供的 key 整体替换默认）
    const splitLineColor = dark ? 'rgba(229,229,229,.06)' : 'rgba(23,23,23,.06)';
    const baseOption: EChartsOption = {
      color: t.chartPalette,
      backgroundColor: 'transparent',
      textStyle: { color: t.text, fontFamily: t.sansFont, fontSize: '0.8rem' },
      animationDuration: 300,
      grid: { left: '8%', right: '8%', top: 48, bottom: '8%', containLabel: true },
      tooltip: {
        backgroundColor: t.bgAlt,
        borderColor: t.border,
        borderRadius: 8,
        borderWidth: 0.5,
        textStyle: { color: t.text, fontSize: '0.8rem' },
        extraCssText: 'box-shadow: none;',
      },
      legend: {
        top: 4,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { color: t.textMuted, fontSize: '0.8rem' },
      },
      xAxis: {
        axisLabel: { color: t.textMuted, fontSize: '0.8rem' },
        splitLine: { lineStyle: { color: splitLineColor } },
      },
      yAxis: {
        axisLabel: { color: t.textMuted, fontSize: '0.8rem' },
        splitLine: { lineStyle: { color: splitLineColor } },
      },
      // 用户 option 覆盖以上默认值
      ...(parsed.option || {}),
    };

    const chart = echarts.init(el);
    chartRef.current = chart;
    chart.setOption(baseOption);
    setReady(true);

    // 容器尺寸变化（展开卡片、窗口 resize）时自动重绘
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => chart.resize())
      : null;
    if (ro) ro.observe(el);

    return () => {
      if (ro) ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [parsed.ok, parsed.option, t, dark]);

  // 渲染完成信号（渲染成功或解析失败都通知，避免外部无限等待）
  useEffect(() => {
    if (ready || !parsed.ok) {
      onRendered?.();
    }
  }, [ready, parsed.ok, onRendered]);

  return (
    <div
      className="widget-renderer w-full"
      data-widget-theme={dark ? 'dark' : 'light'}
    >
      {title && (
        <div
          className="mb-1.5 text-xs font-medium"
          style={{ color: 'var(--ink-muted)' }}
        >
          {title}
        </div>
      )}
      {!parsed.ok ? (
        <div className="py-2 text-xs" style={{ color: t.danger }}>
          Chart parse failed: {parsed.message}
        </div>
      ) : (
        <div ref={containerRef} style={{ width: '100%', height: '320px', minHeight: '220px' }} />
      )}
    </div>
  );
}

// ============================================================
// AntV 渲染器 — 数据图表走 AntV Studio 云端引擎（审美最优）
// 代码块为 JSON spec（{ tool, args }），前端请求 /api/antv-chart 代理，
// 返回图片 URL 后 <img> 展示；失败提示可回退本地 widget:chart。
// ============================================================

function AntvWidget({ code, title, onRendered }: { code: string; title?: string; onRendered?: () => void }) {
  const dark = useWidgetTheme();
  const t = getWidgetTokens(dark);
  const [url, setUrl] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setUrl('');
    (async () => {
      try {
        const spec = JSON.parse(code);
        const res = await fetch('/api/antv-chart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(spec),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (data.success && typeof data.url === 'string' && data.url) {
          setUrl(data.url);
        } else {
          setError(typeof data.error === 'string' ? data.error : 'AntV generation failed');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  // 渲染完成信号（图片生成成功或失败都通知）
  useEffect(() => {
    if (!loading) {
      onRendered?.();
    }
  }, [loading, onRendered]);

  return (
    <div
      className="widget-renderer w-full"
      data-widget-theme={dark ? 'dark' : 'light'}
    >
      {title && (
        <div
          className="mb-1.5 text-xs font-medium"
          style={{ color: t.textMuted }}
        >
          {title}
        </div>
      )}
      {loading ? (
        <div className="py-4 text-center text-xs" style={{ color: t.textMuted }}>
          Generating chart…
        </div>
      ) : error ? (
        <div className="px-3 py-2 text-xs" style={{ color: t.danger }}>
          Chart generation failed: {error}（可改用 widget:chart 本地渲染）
        </div>
      ) : (
        <img
          src={url}
          alt={title || 'chart'}
          className="w-full"
          style={{ display: 'block', maxHeight: '45vh', objectFit: 'contain' }}
        />
      )}
    </div>
  );
}

// ============================================================
// 分享占位卡 — 非交互模式下 widget:html 的替代展示
// iframe 无法被 html-to-image 序列化（foreignObject 不渲染 iframe 内容），
// 分享卡片中渲染占位说明，避免出现空白/代码。
// ============================================================

// ============================================================
// 分享静态渲染 — widget:html 无法被 html-to-image 序列化 iframe，
// 分享模式降级为"剥脚本 + 注入主题 CSS"的静态 DOM 渲染，使分享卡片能看到实际内容
// ============================================================

// ============================================================
// 放大浮层 — 点击 widget 后全屏展示大尺寸内容
// ============================================================

function WidgetModal({
  widget,
  title,
  onClose,
}: {
  widget: WidgetBlock;
  title?: string;
  onClose: () => void;
}) {
  // 客户端挂载后渲染 portal（避免 SSR document undefined；同时脱离 ReactFlow 节点的 transform 坐标系）
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = useWidgetTheme();
  const t = getWidgetTokens(dark);

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-6"
      style={{ backgroundColor: 'rgba(20, 18, 12, 0.45)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[86vh] w-full max-w-[900px] flex-col overflow-hidden rounded-xl"
        data-widget-theme={dark ? 'dark' : 'light'}
        style={{
          backgroundColor: t.bg,
          boxShadow: dark
            ? '0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08)'
            : '0 24px 64px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.08)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div
          className="flex shrink-0 items-center justify-between px-4 py-2.5"
          style={{ borderBottom: `1px solid ${t.border}`, backgroundColor: t.bgAlt }}
        >
          <div className="flex items-center gap-2">
            <ZoomIn className="h-3.5 w-3.5" style={{ color: t.textMuted }} />
            <span className="text-sm font-medium" style={{ color: t.text }}>
              {title || (widget.type === 'svg' ? 'SVG Visualization' : widget.type === 'mermaid' ? 'Mermaid Diagram' : widget.type === 'chart' ? 'Data Chart' : widget.type === 'antv' ? 'AntV Chart' : 'HTML Component')}
            </span>
          </div>
          <Button
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭"
            style={{ color: t.textMuted }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {/* 内容 */}
        <div className="flex-1 overflow-auto ai-canvas-scroll">
          <div className="p-4">
            {widget.type === 'svg' ? (
              <SvgWidget code={widget.code} />
            ) : widget.type === 'mermaid' ? (
              <MermaidWidget code={widget.code} />
            ) : widget.type === 'chart' ? (
              <ChartWidget code={widget.code} />
            ) : widget.type === 'antv' ? (
              <AntvWidget code={widget.code} />
            ) : (
              <HtmlWidget code={widget.code} />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================
// 主组件
// ============================================================

export interface WidgetRendererProps {
  widget: WidgetBlock;
  title?: string;
  /** 交互模式（默认 true）：可点击放大、显示 Enlarge 按钮；false 为纯展示（分享截图用） */
  interactive?: boolean;
  /** 内容渲染完成信号（异步 widget 渲染完后触发，供分享截图等待/测量宽度） */
  onRendered?: () => void;
}

/**
 * 单个 widget 的渲染错误边界：某一 widget（如 SVG 内容异常、antv 图表初始化失败等）
 * 渲染抛错时只降级该 widget 为占位卡，不影响整轮对话消息及其余 widget 的展示。
 * 此前无任何边界，任意 widget 渲染异常会导致整棵组件树崩溃 → 该轮消息整体空白/消失。
 */
class WidgetErrorBoundary extends Component<{ children: ReactNode; onRendered?: () => void }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[WidgetRenderer] widget 渲染异常，已降级为占位卡:', error instanceof Error ? error.message : String(error));
  }

  componentDidUpdate(prevProps: { children: ReactNode }, prevState: { hasError: boolean }) {
    // widget 内容变化（如流式补全/重试）时重置错误态，给渲染器再次机会
    if (prevProps.children !== this.props.children && this.state.hasError) {
      this.setState({ hasError: false });
    }
    // 渲染成功（含降级完成）后仍通知外层"已渲染"，避免分享截图/流式骨架屏卡住
    if (!this.state.hasError && prevState.hasError && this.props.onRendered) {
      this.props.onRendered();
    }
  }

  render() {
    if (this.state.hasError) {
      return <WidgetFallback onRendered={this.props.onRendered} />;
    }
    return this.props.children;
  }
}

/** 降级占位卡：widget 渲染失败时展示，保持消息结构稳定 */
function WidgetFallback({ onRendered }: { onRendered?: () => void }) {
  useLayoutEffect(() => {
    onRendered?.();
  }, [onRendered]);
  return (
    <div className="widget-renderer w-full rounded-lg border border-dashed p-4 text-center text-xs" style={{ borderColor: 'color-mix(in oklab, var(--ink-muted) 25%, transparent)', color: 'var(--ink-muted)' }}>
      Preview unavailable for this widget
    </div>
  );
}

export function WidgetRenderer({ widget, title, interactive = true, onRendered }: WidgetRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const open = useCallback(() => {
    if (interactive) setExpanded(true);
  }, [interactive]);
  const close = useCallback(() => setExpanded(false), []);

  // HtmlWidget 已内联渲染（无 iframe），交互与非交互（分享截图）共用同一渲染路径，无需占位卡

  return (
    <>
      <div
        className="group/widget relative"
        onClick={interactive ? open : undefined}
        title={interactive ? 'Click to enlarge' : undefined}
      >
        <WidgetErrorBoundary onRendered={onRendered}>
          {widget.type === 'svg' ? (
            <SvgWidget code={widget.code} title={title} onRendered={onRendered} />
          ) : widget.type === 'mermaid' ? (
            <MermaidWidget code={widget.code} title={title} onRendered={onRendered} />
          ) : widget.type === 'chart' ? (
            <ChartWidget code={widget.code} title={title} onRendered={onRendered} />
          ) : widget.type === 'antv' ? (
            <AntvWidget code={widget.code} title={title} onRendered={onRendered} />
          ) : (
            <HtmlWidget code={widget.code} title={title} onRendered={onRendered} />
          )}
        </WidgetErrorBoundary>
        {/* 放大按钮：iframe 会吞掉点击事件且不冒泡，必须用真实按钮浮在内容之上触发 */}
        {interactive && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            className="absolute right-1.5 top-1.5 z-10 flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 border-0 opacity-0 transition-opacity group-hover/widget:opacity-100"
            style={{ backgroundColor: 'rgba(0,0,0,0.55)', color: '#fff' }}
            title="Enlarge"
          >
            <ZoomIn className="h-3 w-3" />
            <span className="text-xs">Enlarge</span>
          </button>
        )}
      </div>
      {interactive && expanded && (
        <WidgetModal widget={widget} title={title} onClose={close} />
      )}
    </>
  );
}
