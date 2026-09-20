/**
 * 分享页 widget 预处理（服务端 SSR，无客户端脚本）
 *
 * 分享阅读页是纯 SSR 的静态 HTML，没有编辑器的客户端渲染管线，因此
 * ```mermaid / ```widget:svg / ```widget:html / ```widget:chart 代码块
 * 会在渲染前被本模块替换为等价的静态 HTML/SVG：
 *
 *   mermaid → @ktrysmt/beautiful-mermaid 同步出 SVG（与编辑器同一套配色）
 *   svg     → 剥 <script> 后按白名单净化，内联
 *   html    → 自带 <style> 作用域化 + 组件 CSS 注入 + 白名单净化，内联
 *   chart   → echarts SSR（renderer: 'svg'）出静态 SVG
 *
 * 两个已知服务端限制：
 *   1. 不跑 fixTimelineTextOverflow / applyAppleSemanticTints（依赖 DOMParser / getBBox）；
 *   2. 剥离产物里的远程 @import（避免离线/局域网环境卡在外部字体请求）。
 */
import { renderMermaidSVG } from '@ktrysmt/beautiful-mermaid';
import { renderHtmlSync } from 'unified-renderer';
import type { EChartsOption } from 'echarts';
import { parseWidgetBlocks, type WidgetBlock } from './widget-blocks';
import { buildWidgetHtmlCss, getMermaidRenderColors, getWidgetTokens, scopeCss } from './widget-theme';
import { SHARE_WIDGET_SANITIZE_WHITELIST } from './sanitize-whitelist';

/** widget 容器的公共作用域类名（页面注入的组件 CSS 挂在这个类上） */
export const SHARE_WIDGET_SCOPE = 'bw-widget';

/** 分享页注入的 widget 组件 CSS（已作用域化到 .bw-widget，不污染正文） */
export function buildShareWidgetCss(): string {
  return scopeCss(buildWidgetHtmlCss(getWidgetTokens(false)), SHARE_WIDGET_SCOPE);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 剥离产物中的远程字体 @import（局域网/离线环境下会阻塞渲染） */
function stripRemoteFontImports(css: string): string {
  return css.replace(/@import\s+url\(\s*['"]?https?:\/\/[^)]*\)\s*;?/gi, '');
}

/**
 * 还原 sanitize 的 id 前缀（hast-util-sanitize clobberPrefix `user-content-`）。
 * 前缀会让 `marker-end="url(#arrow)"` 之类的内部引用断裂，这里成对还原。
 */
function unclobberIds(html: string): string {
  return html
    .replace(/url\(#user-content-/g, 'url(#')
    .replace(/(\s(?:id|name|for|aria-describedby|aria-labelledby))="user-content-/g, '$1="');
}

/** 按分享页白名单净化一段 HTML 片段（放行 style / data-* / 内联 SVG） */
function sanitizeFragment(html: string): string {
  const { html: clean } = renderHtmlSync(html, {
    sanitize: true,
    allowDangerousHtml: true,
    sanitizeWhitelist: SHARE_WIDGET_SANITIZE_WHITELIST,
  });
  return unclobberIds(clean);
}

/** 渲染失败时的兜底：原样展示源码（不吞掉内容） */
function renderSourceFallback(code: string, lang: string): string {
  return `<pre class="bw-widget-source"><code class="language-${lang}">${escapeHtml(code)}</code></pre>`;
}

/** mermaid → 静态 SVG（与编辑器 MermaidCodeBlock 同一套配色） */
function renderMermaid(code: string): string {
  const t = getWidgetTokens(false);
  const raw = renderMermaidSVG(code, {
    ...getMermaidRenderColors(t),
    transparent: true,
    padding: 16,
  });
  return sanitizeFragment(stripRemoteFontImports(raw));
}

/** widget:svg → 剥 <script> 后按白名单净化（保留 marker/渐变等内部 id 引用） */
function renderSvgWidget(code: string): string {
  const safe = code.replace(/<script[\s\S]*?<\/script>/gi, '');
  return `<div class="${SHARE_WIDGET_SCOPE} bw-svg">${sanitizeFragment(safe)}</div>`;
}

/** widget:html → 自带 <style> 作用域化 + 白名单净化，内联进正文流 */
function renderHtmlWidget(code: string, index: number): string {
  const scope = `bw-ws-${index}`;
  // ① 取出 widget 自带的 <style>（模型按协议写的主题变量），其余内容进入净化
  const styleBlocks: string[] = [];
  const body = code.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (m) => {
    styleBlocks.push(m.replace(/<\/?style[^>]*>/gi, ''));
    return '';
  });
  // ② 作用域化到本 widget 容器，避免污染正文
  const widgetCss = stripRemoteFontImports(styleBlocks.map((s) => scopeCss(s, scope)).join('\n'));
  const clean = sanitizeFragment(body);
  return `<div class="${SHARE_WIDGET_SCOPE} ${scope}">${
    widgetCss ? `<style>${widgetCss}</style>` : ''
  }${clean}</div>`;
}

/** widget:chart → echarts SSR 出静态 SVG（尺寸与编辑器容器一致） */
async function renderChartWidget(code: string): Promise<string> {
  const echarts = await import('echarts');
  const raw: unknown = JSON.parse(code);
  const option =
    raw && typeof raw === 'object' && 'option' in raw
      ? (raw as { option: unknown }).option
      : raw;
  if (!option || typeof option !== 'object') {
    throw new Error('option 字段缺失或不是对象');
  }

  const t = getWidgetTokens(false);
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
      splitLine: { lineStyle: { color: 'rgba(23,23,23,.06)' } },
    },
    yAxis: {
      axisLabel: { color: t.textMuted, fontSize: '0.8rem' },
      splitLine: { lineStyle: { color: 'rgba(23,23,23,.06)' } },
    },
    // 用户 option 覆盖以上默认值
    ...(option as EChartsOption),
  };

  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 700, height: 320 });
  try {
    chart.setOption(baseOption);
    return `<div class="${SHARE_WIDGET_SCOPE} bw-chart">${stripRemoteFontImports(chart.renderToSVGString())}</div>`;
  } finally {
    chart.dispose();
  }
}

/** 单个 widget 块 → 静态 HTML（失败时回退为源码展示） */
async function renderWidget(widget: WidgetBlock, index: number): Promise<string> {
  try {
    switch (widget.type) {
      case 'mermaid':
        return `<div class="${SHARE_WIDGET_SCOPE} bw-mermaid">${renderMermaid(widget.code)}</div>`;
      case 'svg':
        return renderSvgWidget(widget.code);
      case 'html':
        return renderHtmlWidget(widget.code, index);
      case 'chart':
        return await renderChartWidget(widget.code);
      case 'antv':
        // AntV 依赖云端渲染代理，分享页离线不适用 → 原样展示源码
        return renderSourceFallback(widget.code, 'json');
    }
  } catch {
    return renderSourceFallback(widget.code, widget.type === 'chart' || widget.type === 'antv' ? 'json' : widget.type);
  }
}

export interface PreprocessedShareMarkdown {
  /** 用占位符替换了 widget 围栏的 Markdown（交给 markdown 渲染器） */
  markdown: string;
  /** 与占位符一一对应的静态 HTML 片段 */
  blocks: string[];
}

/**
 * 把文档里的 widget / mermaid 围栏预处理为静态 HTML 片段。
 *
 * 产物以占位符（纯文本）留在 Markdown 中，渲染完成后再由 injectShareWidgets 回填——
 * 这样 SVG/HTML 不会经过 markdown 解析（避免空行被当作 HTML 块边界截断）。
 */
export async function preprocessShareMarkdown(md: string): Promise<PreprocessedShareMarkdown> {
  const parts = parseWidgetBlocks(md);
  if (!parts.some((p) => p.kind === 'widget')) return { markdown: md, blocks: [] };

  const blocks: string[] = [];
  let markdown = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      markdown += part.content;
      continue;
    }
    markdown += `\n\nBW-WIDGET-SLOT-${blocks.length}\n\n`;
    blocks.push(await renderWidget(part.widget, blocks.length));
  }
  return { markdown, blocks };
}

/** 渲染完成后回填占位符（<p>占位符</p> 与裸占位符两种形态都处理） */
export function injectShareWidgets(html: string, blocks: string[]): string {
  if (!blocks.length) return html;
  let out = html;
  blocks.forEach((block, i) => {
    const token = `BW-WIDGET-SLOT-${i}`;
    out = out.split(`<p>${token}</p>`).join(block);
    out = out.split(token).join(block);
  });
  return out;
}
