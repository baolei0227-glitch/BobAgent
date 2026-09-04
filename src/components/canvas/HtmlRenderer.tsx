'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRenderer } from 'unified-renderer';
import type { SanitizeWhitelist } from 'unified-renderer';
import 'highlight.js/styles/github.css';
import { isLikelyQuestionnaire, JSON_CODE_FENCE } from './QuestionnairePanel';
import { desktop } from '@/lib/desktop-adapter';
// 正文图片点击放大预览（与 UnifiedViewer 图片查看器同源 yarl lightbox）
import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';

interface HtmlRendererProps {
  content: string;
}

/** sanitize 白名单扩展：允许 AI 输出的交互元素和标注
 *  注意：属性名使用 hast property 名（className 而非 class）——rehype-sanitize 按此匹配。 */
const whitelist: SanitizeWhitelist = {
  tags: [
    'details', 'summary', 'mark', 'button',
    // SVG 标签（内联 <svg> 插图/信息图被 sanitize 剥掉时只残留文字，这里放行）
    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop',
    'use', 'clipPath', 'mask', 'pattern', 'image', 'marker', 'filter', 'title',
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
    img: ['className'],
    svg: ['viewBox', 'width', 'height', 'xmlns', 'preserveAspectRatio', 'role', 'aria-label'],
    path: ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'transform', 'opacity', 'fill-opacity', 'stroke-opacity'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'transform', 'opacity'],
    circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'transform'],
    ellipse: ['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'stroke-dasharray'],
    polyline: ['points', 'fill', 'stroke', 'stroke-width'],
    polygon: ['points', 'fill', 'stroke', 'stroke-width'],
    text: ['x', 'y', 'dx', 'dy', 'text-anchor', 'fill', 'stroke', 'font-size', 'font-weight', 'font-family', 'transform'],
    tspan: ['x', 'y', 'dx', 'dy', 'text-anchor', 'fill', 'font-size', 'font-weight'],
    defs: [],
    linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits'],
    radialGradient: ['id', 'cx', 'cy', 'r', 'gradientUnits'],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    use: ['href', 'xlink:href', 'x', 'y', 'width', 'height'],
    clipPath: ['id'],
    mask: ['id'],
    image: ['href', 'xlink:href', 'x', 'y', 'width', 'height', 'preserveAspectRatio'],
    marker: ['id', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits'],
  },
};

/**
 * AI 卡片样式层（宿主注入，仅供 AI 输出用 class 引用）：
 * 所有样式走主题 CSS 变量，深浅色自动适配；禁内联 style（sanitize 会剥离）。
 * 约定：.ai-card-list 列表容器 / .ai-card 卡片 / .ai-card-title / .ai-card-meta /
 * .ai-card-body / .ai-badge 标签 / .ai-status 状态点 / .ai-btn 按钮 / .ai-grid 网格。
 */
const AI_CARD_CSS = `<style data-ai-card-css="true">
.ai-card-list{display:flex;flex-direction:column;gap:8px;margin:10px 0}
.ai-card{border:1px solid var(--line,#e5e5e5);border-radius:10px;padding:10px 12px;background:var(--paper-soft,#fafafa);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.ai-card + .ai-card{margin-top:0}
.ai-card-title{font-weight:600;font-size:13px;color:var(--ink,#1a1a1a);margin-bottom:3px}
.ai-card-title .ai-badge{vertical-align:2px;margin-left:6px}
.ai-card-meta{font-size:11px;color:var(--ink-muted,#8a8a8a);margin-bottom:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ai-card-body{font-size:12.5px;color:var(--ink,#1a1a1a);line-height:1.6;word-break:break-word}
.ai-badge{display:inline-block;font-size:10px;line-height:1;padding:3px 7px;border-radius:999px;background:color-mix(in oklab,var(--primary,oklch(.55 .2 265)) 14%,transparent);color:var(--primary-strong,oklch(.45 .19 265));font-weight:600;white-space:nowrap}
.ai-badge.green{background:color-mix(in oklab,var(--success,oklch(.58 .18 150)) 14%,transparent);color:color-mix(in oklab,var(--success,oklch(.58 .18 150)) 80%,transparent)}
.ai-badge.red{background:color-mix(in oklab,var(--danger,oklch(.55 .21 25)) 12%,transparent);color:var(--danger,oklch(.5 .21 25))}
.ai-status{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ink-muted,#9a9a9a);flex-shrink:0}
.ai-status.ok{background:var(--success,oklch(.58 .18 150))}
.ai-status.err{background:var(--danger,oklch(.55 .21 25))}
.ai-status.run{background:var(--primary,oklch(.55 .2 265))}
.ai-btn{display:inline-block;font-size:11px;font-weight:600;line-height:1;padding:6px 12px;border-radius:999px;border:1px solid var(--line,#e5e5e5);background:var(--paper,#fff);color:var(--ink,#1a1a1a);cursor:default;text-decoration:none}
a.ai-btn{text-decoration:none}
.ai-btn:hover{filter:brightness(.96)}
.ai-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:10px 0}
.ai-grid .ai-card{margin:0}
.file-mention{display:inline-block;padding:0 5px;margin:0 1px;border-radius:6px;background:color-mix(in oklab,var(--info,oklch(.6 .13 250)) 10%,transparent);color:var(--info,oklch(.5 .13 250));border:1px solid color-mix(in oklab,var(--info,oklch(.6 .13 250)) 25%,transparent);font-family:var(--font-mono,monospace);font-size:12px;line-height:1.6;cursor:pointer;text-decoration:none;white-space:nowrap}
.file-mention:hover{filter:brightness(.96)}
</style>`;

const renderer = createRenderer({
  format: 'markdown',
  gfm: true,
  sanitize: true,
  slug: true,
  highlight: true,
  allowDangerousHtml: true,
  sanitizeWhitelist: whitelist,
});

/** 为表格包裹横向滚动容器，避免宽表格溢出气泡 */
function wrapTables(html: string): string {
  return html.replace(/<table([\s\S]*?)<\/table>/g, (match) => {
    return `<div class="table-wrapper">${match}</div>`;
  });
}

/** 为 pre 代码块包裹容器 + 复制按钮 */
function wrapCodeBlocks(html: string): string {
  return html.replace(
    /<pre(\s[^>]*)?>([\s\S]*?)<\/pre>/g,
    (_, attrs, inner) =>
      `<div class="code-block-wrapper"><button class="code-copy-btn">Copy</button><pre${attrs || ''}>${inner}</pre></div>`,
  );
}

/**
 * 正文文件 Mentions（dsh 正文文件提及）：把渲染后 HTML 中的项目相对路径
 * （homework/xxx、attachments/xxx）包成可点击的 .file-mention 链接。
 *
 * 后处理（而非 markdown 前处理）以跳过代码块/内联代码/既有链接：
 * 用占位符把 pre/code/a 整块和所有单标签（含自闭合）先保护起来，路径只匹配纯文本区间。
 */
/**
 * 修复 sanitize 造成的脚注锚点 id 双重前缀：
 * remark-gfm 输出 href="#user-content-fn-1"，而 rehype-sanitize 的 clobber 机制
 * 会给 id 再加一层 "user-content-" 前缀 → id="user-content-user-content-fn-1"，
 * 导致锚点跳转失效。这里把 id 回退一层，恢复与 href 的匹配。
 */
function fixFootnoteAnchors(html: string): string {
  return html.replace(/id="user-content-user-content-([^"]+)"/g, 'id="user-content-$1"');
}

function wrapFileMentions(html: string): string {
  const guards: string[] = [];
  const guarded = html.replace(
    /<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>/g,
    (m) => {
      guards.push(m);
      return `\uE000${guards.length - 1}\uE000`;
    },
  );
  const wrapped = guarded.replace(
    /(homework|attachments)\/(?!\.{1,2}(?:\/|$))[^\s<>"'`，。；：、！？（）【】《》〔〕「」『』\uE000]+/g,
    (m) => `<a class="file-mention" data-path="${m}" title="Open ${m}">${m}</a>`,
  );
  return wrapped.replace(/\uE000(\d+)\uE000/g, (_, i) => guards[Number(i)] ?? '');
}

/** 打开项目相对路径（homework/xxx、attachments/xxx → 项目根 + 相对路径 → 系统默认程序） */
async function openFileByProjectRelPath(relPath: string): Promise<void> {
  try {
    const resp = await fetch('/api/projects?action=current');
    const data = await resp.json();
    const projectPath = data?.project?.path || '';
    const p = relPath.replace(/\\/g, '/');
    const homeDir = desktop.getHomeDir();
    const abs = p.startsWith('~/')
      ? p.replace('~', homeDir)
      : p.startsWith('/')
        ? p
        : projectPath
          ? `${projectPath}/${p}`
          : '';
    if (abs) await desktop.openFile(abs);
  } catch { /* 打开失败静默：不影响正文阅读 */ }
}

/**
 * 渲染前屏蔽"疑似问卷"的 ```json 代码块（以 [ 开头且含 question 键）：
 * 只读场景（消息气泡/预览）不渲染问卷交互面板，统一替换为占位提示，
 * 避免裸 JSON 大段展示（流式生成期间尤其明显）。
 */
function maskQuestionnaireBlocks(md: string): string {
  // 1) 已闭合的问卷块
  let out = md.replace(new RegExp(JSON_CODE_FENCE.source, 'g'), (whole, inner: string) =>
    isLikelyQuestionnaire(inner) ? '> 📋 问卷（请在节点文档中作答）' : whole,
  );
  // 2) 未闭合的 ```json 块（流式输出中，最后一段无闭合 ```）：疑似问卷 → 占位
  const idx = out.lastIndexOf('```json');
  if (idx !== -1) {
    const after = out.slice(idx + '```json'.length);
    if (after.indexOf('```') === -1) {
      const content = after.replace(/^[ \t]*\r?\n/, '');
      if (isLikelyQuestionnaire(content)) {
        out = out.slice(0, idx) + '> 📋 问卷（生成中，请在节点文档中作答）';
      }
    }
  }
  return out;
}

/** 基于 unified.js 生态的 Markdown/HTML 统一渲染器 */
function HtmlRendererImpl({ content }: HtmlRendererProps) {
  const html = useMemo(() => {
    if (!content) return '';

    try {
      const result = renderer.markdownSync(maskQuestionnaireBlocks(content));
      let out = AI_CARD_CSS + fixFootnoteAnchors(wrapFileMentions(wrapCodeBlocks(wrapTables(result.html))));
      // 图片延迟解码：流式期间 innerHTML 整块替换会重建 <img>，
      // loading=lazy + decoding=async 降低重复解码造成的闪烁与卡顿
      out = out.replace(/<img(?![^>]*loading=)/g, '<img loading="lazy" decoding="async"');
      return out;
    } catch {
      // 渲染失败时回退为纯文本
      return `<p>${escapeHtml(content.slice(0, 500))}</p>`;
    }
  }, [content]);

  // 正文图片点击放大预览：记录当前预览的图片，渲染 yarl lightbox
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);

  const handleClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.code-copy-btn');
    if (btn) {
      const code = btn.parentElement?.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.textContent || '');
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }
      return;
    }
    // 正文文件 Mentions：点击路径胶囊 → 系统默认程序打开项目内文件
    const mention = (e.target as HTMLElement).closest('.file-mention');
    if (mention) {
      e.preventDefault();
      const rel = mention.getAttribute('data-path');
      if (rel) void openFileByProjectRelPath(rel);
      return;
    }
    // 正文图片：点击放大预览（代码块内的图片不触发，属代码展示）
    const img = (e.target as HTMLElement).closest('img');
    if (img && !img.closest('pre')) {
      const src = img.getAttribute('src');
      if (src) setPreview({ src, alt: img.getAttribute('alt') || '' });
      return;
    }
    // 普通外链（http/https）：新窗口打开（Electron 中由 setWindowOpenHandler 转系统默认浏览器；
    // 浏览器 dev 中开新标签），避免整个应用窗口被导航到外部站点。
    // 锚点（#…）/ mailto: 等非 http(s) 链接不拦截，保留原位跳转等默认行为。
    const link = (e.target as HTMLElement).closest('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        window.open(href, '_blank', 'noopener');
      }
    }
  };

  return (
    <>
      <div
        className="html-renderer"
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {preview && (
        <Lightbox
          open
          close={() => setPreview(null)}
          slides={[{ src: preview.src, alt: preview.alt || undefined }]}
          plugins={[Zoom]}
          controller={{ closeOnBackdropClick: true }}
        />
      )}
    </>
  );
}

// React 19 提交路径对 dangerouslySetInnerHTML 仅比较对象身份（updateProperties 内联 { __html } 字面量每次渲染都是新对象），
// 若不 memo，弹窗打开等无关重渲染会以相同字符串重写 innerHTML，浏览器整体重解析销毁子节点，划词选区被收缩到父容器（高亮消失）。
// memo 后 content 不变即 bail out，host fiber 不更新，innerHTML 不被重写。
export const HtmlRenderer = React.memo(HtmlRendererImpl);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 流式 Markdown 渲染器（Trae 风格）：
 *
 * 流式生成期间即用 markdown 渲染（而非纯文本 span），完成时不切换渲染引擎，
 * 消除"先纯文本 → 再富文本"的割裂感。
 *
 * 节流策略：
 *   · 流式中：每 100ms 最多重新解析一次（unified.js 管线 ~5-20ms，100ms 间隔足够流畅）
 *   · 非流式（已完成）：立即渲染最新内容
 *   · 流式→完成切换瞬间：立即 flush 最后一帧，保证不丢内容
 */
const STREAM_THROTTLE_MS = 200;

/**
 * 流式结构稳定化：流式中若存在"未闭合的代码围栏"（``` 未配对），
 * 把未闭合部分从 markdown 输入中拆出、以纯文本追加显示。
 *
 * 原因：unified 会把不断增长的未闭合代码块整体渲染为 <pre>，且 StreamingMarkdown
 * 每次整块替换 innerHTML → 代码块每帧重建 DOM，行数持续增长 → 内容区布局反复变化（抖动/闪烁）。
 * 拆出后：已闭合部分照常走 markdown 渲染器（结构稳定不再变），未闭合尾部只是纯文本增长
 * （文本节点更新不重建结构，无抖动）；围栏闭合瞬间尾部并入代码块（外层有 fade 过渡）。
 */
function stabilizeStreamingMarkdown(md: string): { stable: string; tail: string } {
  if (!md || !md.includes('```')) return { stable: md, tail: '' };
  const fenceCount = md.split('```').length - 1;
  if (fenceCount % 2 === 0) return { stable: md, tail: '' }; // 围栏均已闭合
  // 未闭合围栏：最后一个 ``` 之后的原文作为纯文本尾部（去掉 ``` 本身）
  const lastIdx = md.lastIndexOf('```');
  return { stable: md.slice(0, lastIdx), tail: md.slice(lastIdx + 3) };
}

export function StreamingMarkdown({ content, streaming }: { content: string; streaming: boolean }) {
  const [rendered, setRendered] = useState(content);
  const lastRenderRef = useRef(0);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  // rAF 合并：渲染放到帧边界执行，避免流式高频 chunk 同步替换 DOM 阻塞主线程造成掉帧/撕裂
  const flush = (next: string) => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setRendered(next);
    });
  };

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastRenderRef.current;

    // 非流式：立即渲染
    if (!streaming) {
      flush(content);
      lastRenderRef.current = now;
      pendingRef.current = null;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }

    // 流式中：节流
    if (elapsed >= STREAM_THROTTLE_MS) {
      flush(content);
      lastRenderRef.current = now;
      pendingRef.current = null;
    } else {
      // 存为 pending，等节流窗口结束后 flush
      pendingRef.current = content;
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          if (pendingRef.current !== null) {
            flush(pendingRef.current);
            lastRenderRef.current = Date.now();
            pendingRef.current = null;
          }
          timerRef.current = null;
        }, STREAM_THROTTLE_MS - elapsed);
      }
    }
  }, [content, streaming]);

  // 卸载时清理 timer 与 rAF
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // 流式期间：稳定化渲染（未闭合代码围栏拆为纯文本尾部）。
  // 关键：必须用节流后的 rendered（而非最新 content）——直接渲染 content 会每帧整块替换 innerHTML，
  // 导致内容区持续重排闪烁；rendered 按节流间隔更新，重建频率被压到 ~5次/秒
  if (streaming) {
    const { stable, tail } = stabilizeStreamingMarkdown(rendered);
    return (
      <>
        <HtmlRenderer content={stable} />
        {tail && (
          <div
            className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--ink-muted)', opacity: 0.9 }}
          >
            {tail}
          </div>
        )}
      </>
    );
  }
  return <HtmlRenderer content={rendered} />;
}
