'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRenderer } from 'unified-renderer';
import { createPortal } from 'react-dom';
import 'highlight.js/styles/github.css';
import { MARKDOWN_SANITIZE_WHITELIST } from '@/lib/sanitize-whitelist';
import { normalizeSourceUrl } from '@/lib/materials/source-url';
import { isLikelyQuestionnaire, JSON_CODE_FENCE } from './QuestionnairePanel';
import { bus, BusEvents } from '@/lib/bus';
// 正文图片点击放大预览（共享 ImagePreviewLightbox：图片撑满视口，小图也会明显放大）
import { ImagePreviewLightbox } from './ImagePreviewLightbox';

interface HtmlRendererProps {
  content: string;
  /** 正文链接标注：键为归一化 URL（normalizeSourceUrl）→ 弹窗内容。
   *  只在「本轮真的读过这些页面」的研究档传入；缺省时渲染管线与今日完全一致。 */
  readSources?: Map<string, ReadSourceInfo>;
  /**
   * 正文文件链接（.file-mention / 项目相对路径的 md 链接）的接管回调。
   * 返回 true = 调用方已处理，不再发 file.open 事件。
   *
   * Butler 抽屉用它把正文里的文件链接开在**抽屉自己的右栏**：抽屉是覆盖式浮层，
   * 走 file.open 只会开在被它遮住的画布右侧面板，表现为「点了没反应」。
   */
  onOpenDoc?: (path: string) => boolean;
}

/** 正文链接 hover 弹窗的内容（由调用方算好，渲染器不碰业务） */
export interface ReadSourceInfo {
  /** 页面标题 */
  title: string;
  /** 去 www 的域名 */
  host: string;
  /** 正文首段摘要 */
  excerpt: string;
}

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
  sanitizeWhitelist: MARKDOWN_SANITIZE_WHITELIST,
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
 * （materials/xxx、homework/xxx、attachments/xxx）包成可点击的 .file-mention 链接。
 * materials 是账本条目的「出处」所在层（原件层），必须一并可点，否则档案员引用的路径点了没反应。
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

/** 中文/半角收尾括号 → 对应开括号 */
const CLOSER_TO_OPENER: Record<string, string> = {
  '）': '（', '】': '【', '》': '《', '〕': '〔', '」': '「', '』': '『', ')': '(',
};

/**
 * 剔除**不配对的收尾括号**，配对则保留。
 *
 * 走两个方向都会错，只能按配对判：
 *   - 全排除中文括号 → 「xx（孵化模式）条款大纲.md」被截断成「xx」→ 点到不存在的路径（本次修复的 bug）；
 *   - 全不排除       → 「（见 materials/x.pdf）」会把句读的 `）` 吃进路径。
 * 逐字符剥离末尾收尾括号，只要该括号在本串里已有配对开括号（说明括号属于文件名）就停手。
 */
function trimUnbalancedClosers(s: string): string {
  let out = s;
  for (;;) {
    const last = out[out.length - 1];
    const opener = CLOSER_TO_OPENER[last];
    if (!opener) return out;
    const opens = out.split(opener).length - 1;
    const closes = out.split(last).length - 1;
    if (closes <= opens) return out; // 已配对（括号在文件名内）→ 保留
    out = out.slice(0, -1);          // 多余的收尾括号（句读）→ 剔除
  }
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
    // 排除 [] # 的原因：账本引用标记形如 `[来源: 材料:materials/x.pdf#p3]`，
    // 若把 `]` / `#p3` 吃进路径，点开的就是一个不存在的文件（静默失败）。
    // 括号（中英文）**不在排除类里**：它们是合法文件名字符，靠 trimUnbalancedClosers 处理句读。
    /(materials|homework|attachments)\/(?!\.{1,2}(?:\/|$))[^\s<>"'`，。；：、！？\[\]#\uE000]+/g,
    (m) => {
      const path = trimUnbalancedClosers(m);
      const trailing = m.slice(path.length); // 被剔除的句读要原样还回正文，不能吞掉
      return `<a class="file-mention" data-path="${path}" title="Open ${path}">${path}</a>${trailing}`;
    },
  );
  return wrapped.replace(/\uE000(\d+)\uE000/g, (_, i) => guards[Number(i)] ?? '');
}

/**
 * 正文链接标注：把「本轮真的读过」的页面链接打上 data-read-src 标记。
 *
 * 后处理（而非 markdown 前处理）：markdown 渲染出的 <a> 才是最终 href，且只动真链接，
 * 代码块里的 URL 是转义文本（无 <a>），天然不受影响。
 * 属性在 sanitize **之后**注入，故不依赖白名单放行 data-*。
 */
function markReadSources(html: string, readSources: Map<string, ReadSourceInfo> | undefined): string {
  if (!readSources || readSources.size === 0) return html;
  return html.replace(/<a\b([^>]*)>/g, (whole, attrs: string) => {
    const href = /href="([^"]*)"/.exec(attrs)?.[1];
    if (!href) return whole;
    const raw = href.trim();
    if (!/^https?:\/\//i.test(raw)) return whole;
    // 属性值里的实体（& → &amp;）必须先还原：否则带查询串的 URL 会被解析成
    // ?x=1&amp;y=2，与清单键对不上，链接静默不标注
    const unescaped = raw
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    // 渲染层可能已做百分号编码，还原后再归一化
    let decoded = unescaped;
    try { decoded = decodeURI(unescaped); } catch { /* 非法编码：按原样归一化 */ }
    const key = normalizeSourceUrl(decoded);
    if (!key || !readSources.has(key)) return whole;
    return `<a${attrs} data-read-src="1" data-read-url="${key.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
  });
}

/** 已读来源链接的胶囊样式（仅在传入 readSources 时注入，其他渲染面 HTML 保持逐字节不变） */
const READ_SRC_CSS = `<style data-read-src-css="true">
a[data-read-src]{text-decoration:none;border-radius:4px;padding:0 4px;margin:0 1px;background:color-mix(in oklab,var(--success,#3a9d5d) 10%,transparent);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--success,#3a9d5d) 26%,transparent);color:color-mix(in oklab,var(--success,#3a9d5d) 72%,var(--ink,#1a1a1a));transition:background .12s ease}
a[data-read-src]:hover{background:color-mix(in oklab,var(--success,#3a9d5d) 20%,transparent)}
a[data-read-src]::after{content:'✓';margin-left:3px;font-size:9px;vertical-align:1px;opacity:.75}
</style>`;

/** 项目内相对路径（materials/… homework/… attachments/…）：可点开原件，而非外链跳转 */
export function isProjectRelPath(value: string): boolean {
  return /^(?:materials|homework|attachments)\//.test(value);
}

/** 打开正文引用的文件（materials/… 等项目相对路径，或 ~ / 绝对路径）。
 *  统一走 file.open 事件——与侧栏、产物卡同一口径：HTML/PDF/图片由 CanvasFlow 交给
 *  Hippo Browser，其余进预览面板。不再直接调系统默认程序，避免与侧栏行为分裂。
 *  导出给账本文稿面板等其它渲染面复用，保证「点路径开原件」只有一套口径。 */
export function openFileByProjectRelPath(relPath: string): void {
  const p = relPath.replace(/\\/g, '/').trim();
  if (!p) return;
  const isAbsolute = p.startsWith('~/') || p.startsWith('/');
  const name = p.split('/').pop() || 'file';
  bus.publish(BusEvents.fileOpen, { source: isAbsolute ? 'local' : 'project', path: p, name });
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
function HtmlRendererImpl({ content, readSources, onOpenDoc }: HtmlRendererProps) {
  const html = useMemo(() => {
    if (!content) return '';

    try {
      const result = renderer.markdownSync(maskQuestionnaireBlocks(content));
      const marked = markReadSources(result.html, readSources);
      let out = AI_CARD_CSS + fixFootnoteAnchors(wrapFileMentions(wrapCodeBlocks(wrapTables(marked))));
      if (readSources && readSources.size > 0) out = READ_SRC_CSS + out;
      // 图片延迟解码：流式期间 innerHTML 整块替换会重建 <img>，
      // loading=lazy + decoding=async 降低重复解码造成的闪烁与卡顿
      out = out.replace(/<img(?![^>]*loading=)/g, '<img loading="lazy" decoding="async"');
      return out;
    } catch {
      // 渲染失败时回退为纯文本
      return `<p>${escapeHtml(content.slice(0, 500))}</p>`;
    }
  }, [content, readSources]);

  // 正文图片点击放大预览：记录当前预览的图片，渲染 yarl lightbox
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);

  // 已读来源链接的 hover 弹窗。位置在 hover 时取一次 rect（fixed 定位，不受祖先滚动裁剪）；
  // 相等则复用旧 state，避免鼠标在链接内移动子元素时反复重渲染。
  const [hover, setHover] = useState<{ key: string; left: number; top: number; bottom: number } | null>(null);

  const handleMouseOver = (e: React.MouseEvent) => {
    if (!readSources || readSources.size === 0) return;
    const el = (e.target as HTMLElement).closest?.('a[data-read-src]');
    if (!el) return;
    const key = el.getAttribute('data-read-url') || '';
    if (!key || !readSources.has(key)) return;
    const r = el.getBoundingClientRect();
    setHover((prev) =>
      prev && prev.key === key && Math.abs(prev.top - r.top) < 1 && Math.abs(prev.left - r.left) < 1
        ? prev
        : { key, left: r.left, top: r.top, bottom: r.bottom },
    );
  };

  const handleMouseOut = (e: React.MouseEvent) => {
    if (!hover) return;
    const el = (e.target as HTMLElement).closest?.('a[data-read-src]');
    if (el) setHover(null);
  };

  const hoverInfo = hover ? readSources?.get(hover.key) : undefined;

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
      if (rel && !onOpenDoc?.(rel)) void openFileByProjectRelPath(rel);
      return;
    }
    // 正文图片：点击放大预览（代码块内的图片不触发，属代码展示）
    const img = (e.target as HTMLElement).closest('img');
    if (img && !img.closest('pre')) {
      const src = img.getAttribute('src');
      if (src) setPreview({ src, alt: img.getAttribute('alt') || '' });
      return;
    }
    // 普通外链（http/https）：新窗口打开（Electron 中由 setWindowOpenHandler 收编到内置 Hippo Browser，
    // 不可用才退回系统默认浏览器；浏览器 dev 中开新标签），避免整个应用窗口被导航到外部站点。
    // 锚点（#…）/ mailto: 等非 http(s) 链接不拦截，保留原位跳转等默认行为。
    const link = (e.target as HTMLElement).closest('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        window.open(href, '_blank', 'noopener');
        return;
      }
      // markdown 链接形态的项目相对路径（[x](materials/x.pdf)）：wrapFileMentions 会跳过既有 <a>，
      // 这里按 .file-mention 同一口径补拦截，否则相对 href 会把整个应用窗口导航到坏地址
      let rel = href;
      try { rel = decodeURI(href); } catch { /* 非法编码：按原样判定 */ }
      rel = rel.replace(/^\.\//, '').replace(/\\/g, '/');
      if (isProjectRelPath(rel)) {
        e.preventDefault();
        if (!onOpenDoc?.(rel)) openFileByProjectRelPath(rel);
      }
    }
  };

  return (
    <>
      <div
        className="html-renderer"
        onClick={handleClick}
        onMouseOver={handleMouseOver}
        onMouseOut={handleMouseOut}
        onWheelCapture={() => { if (hover) setHover(null); }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {/* 弹窗挂 portal：fixed 定位若留在节点树内，祖先的 transform/filter 会成为新的包含块，
          画布节点上会把弹窗定位算歪 */}
      {hover && hoverInfo && typeof document !== 'undefined' && createPortal(
        <div
          className="pointer-events-none fixed z-[400] rounded-lg border px-2.5 py-2 shadow-lg"
          style={{
            left: Math.min(Math.max(8, hover.left), Math.max(8, window.innerWidth - 428)),
            ...(hover.top > READ_SRC_POPUP_MAX_H + 12
              ? { bottom: window.innerHeight - hover.top + 8 }
              : { top: hover.bottom + 8 }),
            width: 'max-content',
            maxWidth: 420,
            borderColor: 'color-mix(in oklab, var(--success) 30%, transparent)',
            backgroundColor: 'var(--popover)',
          }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wider"
              style={{
                backgroundColor: 'color-mix(in oklab, var(--success) 14%, transparent)',
                color: 'color-mix(in oklab, var(--success) 80%, transparent)',
              }}
            >
              Read this turn
            </span>
            <span className="truncate text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}>
              {hoverInfo.host}
            </span>
          </div>
          <div className="mt-1 line-clamp-2 text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>
            {hoverInfo.title}
          </div>
          {hoverInfo.excerpt && (
            <div className="mt-1 line-clamp-4 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              {hoverInfo.excerpt}
            </div>
          )}
        </div>,
        document.body,
      )}
      {preview && (
        <ImagePreviewLightbox
          open
          slides={[{ src: preview.src, alt: preview.alt || undefined }]}
          onClose={() => setPreview(null)}
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

/** 已读来源弹窗的估算高度（px）：只用来判断向上弹还是向下弹，不需要精确测量 */
const READ_SRC_POPUP_MAX_H = 180;

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

export function StreamingMarkdown({
  content,
  streaming,
  readSources,
  onOpenDoc,
}: {
  content: string;
  streaming: boolean;
  /** 正文链接标注（研究档传入）；流式期间调用方通常不传，见 ChatNodeKernel 的 isAssistantDone 门 */
  readSources?: Map<string, ReadSourceInfo>;
  /** 正文文件链接接管回调（见 HtmlRendererProps.onOpenDoc） */
  onOpenDoc?: (path: string) => boolean;
}) {
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
        <HtmlRenderer content={stable} readSources={readSources} onOpenDoc={onOpenDoc} />
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
  return <HtmlRenderer content={rendered} readSources={readSources} onOpenDoc={onOpenDoc} />;
}
