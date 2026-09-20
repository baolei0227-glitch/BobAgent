/**
 * 设计稿海报 target —— DocIR → 海报区块（保留完整排版）+ 多规格几何。
 *
 * 与小红书卡片的定位差异（方案 §5.1）：
 * - 小红书卡片是"切图化"（短句、大留白、逐块分页）；
 * - 设计稿海报是**保留完整排版**的单页/长图——一份 md 一次成图，不切块。
 *
 * 多规格：1:1 / 3:4 / 9:16 / 长图。规格只影响容器尺寸与字号刻度，
 * 定高规格由渲染端做「等比缩放到容器内」（字号刻度），长图高度自适应。
 *
 * 内容降噪规则（方案 §5.1）：
 * - `h1` → 提到封面标题，正文不再重复；
 * - `h2` → 章节标题；`h3`/`h4` 及以下 → 降级为加粗小标题；
 * - 宽表（列数 > 3）→ 转键值对列表并标注"完整表格见原文档"；
 * - 代码块 → 折叠为一段说明；
 * - 段落 → 每块最多 3 行（渲染端 line-clamp）。
 *
 * 封面抽取：`title` + `hook` + 前 3 条 `stats`。
 */

import type { DocBlock, DocIR, DocInline } from '../ir';
import { inlineText } from '../ir';
import type { PlatformSpec } from '../types';

/** 海报平台约束：四种规格；不支持代码高亮（折叠为说明） */
export const POSTER_SPEC: PlatformSpec = {
  id: 'poster',
  label: 'Poster',
  limits: {
    ratios: ['1:1', '3:4', '9:16', 'long'],
    unsupported: ['code'],
  },
  formats: ['png'],
};

/** 设计宽 640，导出 pixelRatio 2 → 1280px 宽；`h <= 0` 表示长图（高度自适应） */
export const POSTER_SIZES = {
  '1:1': { w: 640, h: 640, pad: 40 },
  '3:4': { w: 640, h: 853, pad: 40 },
  '9:16': { w: 640, h: 1138, pad: 40 },
  long: { w: 640, h: 0, pad: 40 },
} as const;

export type PosterSizeKey = keyof typeof POSTER_SIZES;

export const POSTER_EXPORT_RATIO = 2;

/** 封面最多展示几条关键数字 */
const POSTER_STATS_MAX = 3;
/** 表格列数上限：超过则降级为键值对列表 */
const POSTER_TABLE_COLS = 3;
/** 列表项上限：超出截断并提示（避免长图被清单淹没） */
const POSTER_LIST_MAX = 12;

// ---------------------------------------------------------------------------
// 区块模型（渲染端只消费这个，不再自己剥 markdown）
// ---------------------------------------------------------------------------

export type PosterBlock =
  | { t: 'section'; text: string }
  | { t: 'sub'; text: string }
  | { t: 'para'; inline: DocInline[] }
  | { t: 'list'; ordered: boolean; items: DocInline[][]; truncated: number }
  | { t: 'quote'; lines: string[] }
  | { t: 'kv'; pairs: Array<[string, string]>; note: string }
  | { t: 'table'; header: string[]; rows: string[][] }
  | { t: 'code'; lines: number; summary: string }
  | { t: 'image'; src: string; alt: string }
  | { t: 'hr' };

export interface PosterCover {
  title: string;
  hook: string;
  stats: string[];
}

// ---------------------------------------------------------------------------
// 降噪转换
// ---------------------------------------------------------------------------

/** 去掉内联前缀 n 个字符（封面 hook 已覆盖首段开头时，正文不重复） */
function trimInlinePrefix(inline: DocInline[], n: number): DocInline[] {
  let rest = n;
  const out: DocInline[] = [];
  for (const item of inline) {
    if (rest <= 0) {
      out.push(item);
      continue;
    }
    if (item.value.length <= rest) {
      rest -= item.value.length;
      continue;
    }
    const value = item.value.slice(rest);
    rest = 0;
    if (value) out.push({ ...item, value });
  }
  // 截断处残留的标点/空白一并去掉
  const head = out[0];
  if (head) {
    const value = head.value.replace(/^[\s，,。、；;：:]+/, '');
    if (value) out[0] = { ...head, value };
    else out.shift();
  }
  return out;
}

function quoteLines(blocks: DocBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.t === 'paragraph') {
      const text = inlineText(b.inline).replace(/\s+/g, ' ').trim();
      if (text) out.push(text);
    } else if (b.t === 'list') {
      out.push(...b.items.map((it) => inlineText(it).trim()).filter(Boolean));
    } else if (b.t === 'quote') {
      out.push(...quoteLines(b.blocks));
    }
  }
  return out;
}

function tableBlock(b: Extract<DocBlock, { t: 'table' }>): PosterBlock {
  if (b.header.length <= POSTER_TABLE_COLS) return { t: 'table', header: b.header, rows: b.rows };
  const pairs: Array<[string, string]> = b.rows.map((row, i) => [
    row[0]?.trim() || `第 ${i + 1} 行`,
    row.slice(1).map((c) => c.trim()).filter(Boolean).join(' · '),
  ]);
  return { t: 'kv', pairs, note: '完整表格见原文档' };
}

function codeBlock(b: Extract<DocBlock, { t: 'code' }>): PosterBlock {
  const lines = b.lines.filter((l) => l.trim()).length;
  return { t: 'code', lines, summary: `代码块 ${lines} 行（${b.lang || 'plain'}）—— 完整内容见原文档` };
}

/**
 * DocIR → 海报区块（降噪后的完整排版）。
 * 首段若与封面 `hook` 同源，只保留 hook 之外的部分，避免封面与正文重复。
 */
export function posterBlocks(ir: DocIR): PosterBlock[] {
  const hook = (ir.hook ?? '').trim();
  let hookPending = !!hook;
  const out: PosterBlock[] = [];

  for (const b of ir.blocks ?? []) {
    switch (b.t) {
      case 'heading':
        if (b.level === 1) break; // h1 已提到封面标题
        out.push(b.level === 2 ? { t: 'section', text: b.text } : { t: 'sub', text: b.text });
        break;
      case 'paragraph': {
        let inline = b.inline;
        if (hookPending) {
          hookPending = false;
          const text = inlineText(inline);
          if (text.startsWith(hook)) inline = trimInlinePrefix(inline, hook.length);
        }
        if (inline.length) out.push({ t: 'para', inline });
        break;
      }
      case 'list': {
        const items = b.items.slice(0, POSTER_LIST_MAX);
        if (items.length) {
          out.push({ t: 'list', ordered: b.ordered, items, truncated: b.items.length - items.length });
        }
        break;
      }
      case 'quote': {
        const lines = quoteLines(b.blocks);
        if (lines.length) out.push({ t: 'quote', lines });
        break;
      }
      case 'table':
        out.push(tableBlock(b));
        break;
      case 'code':
        out.push(codeBlock(b));
        break;
      case 'image':
        out.push({ t: 'image', src: b.src, alt: b.alt });
        break;
      case 'hr':
        out.push({ t: 'hr' });
        break;
    }
  }
  return out;
}

/** 封面抽取：title + hook + 前 3 条 stats（方案 §5.1） */
export function posterCover(ir: DocIR): PosterCover {
  return {
    title: (ir.title ?? '').trim(),
    hook: (ir.hook ?? '').trim(),
    stats: (ir.stats ?? []).slice(0, POSTER_STATS_MAX),
  };
}

/** 降噪统计（面板提示用）：有多少块被折叠/降级 */
export function posterNoise(blocks: PosterBlock[]): { folded: number; section: number; sub: number } {
  return {
    folded: blocks.filter((b) => b.t === 'code' || b.t === 'kv').length,
    section: blocks.filter((b) => b.t === 'section').length,
    sub: blocks.filter((b) => b.t === 'sub').length,
  };
}
