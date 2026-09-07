'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { toPng } from 'html-to-image';
import {
  Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardCopy, Copy, FileDown, Loader2, Shuffle, Sparkles, Upload, Wand2, X,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { loadSettings, saveSettings, getImageModelCandidates, findProviderForModel } from '@/lib/settings';

/**
 * XhsPanel — 3:4 竖版小红书风格分享卡。
 *  - 封面：胶囊标签 + 大标题(Question) + 编号要点/引言 + 标签 + AI 漫画插画（仅封面，走 /api/ai-generate/image）+ 水印
 *  - 正文：内容自动分页（按段落/行测量高度，句末标点切断）
 *  - 主题：6 预设色 + 自定义取色器，持久化到 settings.xhsThemeColor
 *  - 导出：下载当前页 / 全部页、复制当前页；输出 1242×1656（pixelRatio 3）
 */

/* ============ 主题 ============ */
export interface XhsTheme {
  key: string;
  label: string;
  brand: string;
  soft: string;
  softStrong: string;
  text: string;
}

export const XHS_THEMES: XhsTheme[] = [
  { key: 'red', label: 'Red', brand: '#FF2442', soft: '#FFF0F2', softStrong: '#FFD8DE', text: '#8C1022' },
  { key: 'orange', label: 'Orange', brand: '#FF7A1A', soft: '#FFF3E8', softStrong: '#FFDFC2', text: '#7A3A05' },
  { key: 'green', label: 'Green', brand: '#00B87C', soft: '#E9F9F2', softStrong: '#C9F0E0', text: '#065F46' },
  { key: 'blue', label: 'Blue', brand: '#3D8BFF', soft: '#EAF3FF', softStrong: '#CFE3FF', text: '#1E4E9E' },
  { key: 'pink', label: 'Pink', brand: '#FF5C8A', soft: '#FFF0F4', softStrong: '#FFD9E3', text: '#9E1D3F' },
  { key: 'amber', label: 'Amber', brand: '#F59E0B', soft: '#FEF4E2', softStrong: '#FCE3B3', text: '#7A4D00' },
];

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 36, 66];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(hex: string, pct: number, towardWhite: boolean): string {
  const [r, g, b] = hexToRgb(hex);
  const t = towardWhite ? 255 : 0;
  const c = (v: number) => Math.round(v + (t - v) * pct).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** 解析主题：预设 key 或自定义 hex（自动推导浅底 / 深字色） */
export function resolveTheme(value: string | undefined): XhsTheme {
  if (!value) return XHS_THEMES[0];
  const preset = XHS_THEMES.find((t) => t.key === value);
  if (preset) return preset;
  if (/^#?[0-9a-f]{6}$/i.test(value.trim())) {
    return {
      key: 'custom',
      label: 'Custom',
      brand: value,
      soft: mix(value, 0.08, true),
      softStrong: mix(value, 0.2, true),
      text: mix(value, 0.72, false),
    };
  }
  return XHS_THEMES[0];
}

/** 主题 CSS 变量，内联到卡片根节点（子元素用 var(--x-*) 引用，导出时按计算值序列化） */
function themeVars(t: XhsTheme, paper: XhsPaper): CSSProperties {
  return {
    '--x-brand': t.brand,
    '--x-soft': t.soft,
    '--x-soft-strong': t.softStrong,
    '--x-text': t.text,
    '--x-paper': paper.bg,
  } as CSSProperties;
}

/* ============ 纸张背景 ============ */
export interface XhsPaper {
  key: string;
  label: string;
  bg: string;
}

export const PAPER_STYLES: XhsPaper[] = [
  { key: 'cream', label: 'Cream', bg: '#FFF8F3' },
  { key: 'white', label: 'White', bg: '#FFFFFF' },
  { key: 'kraft', label: 'Kraft', bg: '#F6ECDD' },
  { key: 'blush', label: 'Blush', bg: '#FFF2F3' },
  { key: 'sky', label: 'Sky', bg: '#F0F6FB' },
  { key: 'mint', label: 'Mint', bg: '#F0F8F3' },
  { key: 'lemon', label: 'Lemon', bg: '#FFF9E8' },
];

export function resolvePaper(key: string | undefined): XhsPaper {
  return PAPER_STYLES.find((p) => p.key === key) ?? PAPER_STYLES[0];
}

/** hex → rgba（用于插画底部手写渐变，随纸张色自适应） */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(255, 248, 243, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/* ============ 内容处理与分页 ============ */
const XHS_W = 414; // 3:4 设计宽度；导出 pixelRatio 3 → 1242×1656
const XHS_H = 552;
const EXPORT_RATIO = 3;
const PAD = 24;
const CAP_BODY = 420; // 正文页内容区高度预算（px，含首尾留白余量）
const FONT = "ui-sans-serif, system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** XHS 正文页内 Markdown 表格的渲染/测量共用几何常量（颜色可随主题，但尺寸必须一致，
 *  否则分页测高与实际渲染高度不一致 → 表格跨页/溢出）。 */
const XHS_TABLE = {
  fontSize: '0.8rem',
  lineHeight: 1.6,
  pad: '5px 8px',
  marginY: 8, // 表格上下外边距（px），测高与渲染同用
  border: 'rgba(60, 60, 60, 0.18)',
} as const;

/** 编辑表单输入框统一样式 */
const fieldStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  backgroundColor: 'var(--paper)',
  border: '1px solid color-mix(in oklab, var(--line) 70%, transparent)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: '0.866667rem',
  color: 'var(--ink)',
  outline: 'none',
  resize: 'vertical',
  fontFamily: FONT,
};

function mdToLines(md: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const s = raw
      .replace(/^\s*(#{1,6})\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '• ')
      .replace(/^\s*(\d+)[.、)]\s+/, '$1. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
      .trim();
    // 保留段间空行（''）→ 卡片正文以此产生段落间距
    out.push(s);
  }
  // 去首尾空行
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  // 折叠连续空行为单个空行，避免超大段落间距
  const folded: string[] = [];
  for (const l of out) {
    if (l === '' && folded[folded.length - 1] === '') continue;
    folded.push(l);
  }
  if (folded.some(Boolean)) return folded;
  return [md.replace(/\s+/g, ' ').trim()].filter(Boolean);
}

/** 提取回答中的列表项作为封面编号要点；不足 2 项返回 null（封面退回引言模式） */
function extractCoverItems(lines: string[]): string[] | null {
  const items: string[] = [];
  for (const l of lines) {
    const m = /^(?:(\d+)[.、)]|[①②③④⑤]|•)\s*(.*)$/.exec(l);
    if (m && m[2].trim()) {
      if (items.length < 3) items.push(m[2].trim());
    } else if (items.length > 0) break;
  }
  return items.length >= 2 ? items : null;
}

/** 正文页块：文本段（可含内部换行）或整块表格（原子块，分页不拆行） */
type XhsBodyBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

interface XhsPageData {
  kind: 'cover' | 'content';
  mode?: 'points' | 'intro';
  /** cover 页的封面要点行 */
  lines: string[];
  /** content 页的正文块列表（文本段 / 表格） */
  blocks?: XhsBodyBlock[];
}

/** 二分查找：text 前缀在剩余空间内能容纳的最大长度，并回退到句末标点避免句中切断 */
function fitPrefix(text: string, space: number, measure: (t: string) => number): string {
  if (space <= 0 || !text) return '';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid)) <= space) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0) return '';
  const punct = /[。！？；.!?]/;
  let cut = lo;
  for (let i = lo; i > Math.max(1, lo - 20); i--) {
    if (punct.test(text[i - 1])) { cut = i; break; }
  }
  return text.slice(0, cut);
}

/* ---------- Markdown 表格 → XHS 正文块 ---------- */

/** 剥掉表格行的首尾竖线，按 | 拆单元格（不做宽度对齐） */
function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** 是否为 markdown 表格分隔行（--- / :--: / --: 等） */
function isTableSepRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/** 连续管道行是否为合法表格（首行表头 + 第二行分隔行 + 至少一行数据） */
function parseMdTable(lines: string[]): { header: string[]; rows: string[][] } | null {
  if (lines.length < 3 || !isTableSepRow(lines[1])) return null;
  const header = splitTableRow(lines[0]);
  if (!header.length) return null;
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return null;
  // 数据行单元格数补齐到表头列数（不足补空，保证渲染时列数一致）
  for (const r of rows) {
    while (r.length < header.length) r.push('');
    r.length = header.length;
  }
  return { header, rows };
}

const isPipeRow = (line: string) => {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|');
};

/** 把正文文本（可能含 markdown 表格行）解析为顺序块列表：文本段 / 表格原子块 */
function splitBodyToBlocks(body: string): XhsBodyBlock[] {
  const lines = body.split('\n');
  const out: XhsBodyBlock[] = [];
  const textBuf: string[] = [];
  const flushText = () => {
    while (textBuf.length && textBuf[0].trim() === '') textBuf.shift();
    while (textBuf.length && textBuf[textBuf.length - 1].trim() === '') textBuf.pop();
    if (textBuf.length) {
      out.push({ kind: 'text', text: textBuf.join('\n') });
      textBuf.length = 0;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === '') {
      flushText();
      i++;
      continue;
    }
    if (isPipeRow(raw)) {
      const block: string[] = [];
      while (i < lines.length && isPipeRow(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      const t = parseMdTable(block);
      if (t) {
        flushText();
        out.push({ kind: 'table', header: t.header, rows: t.rows });
        continue;
      }
      // 不是合法表格（如正文里恰好首尾带 | 的行）：退回文本段继续
      textBuf.push(...block);
      continue;
    }
    textBuf.push(raw);
    i++;
  }
  flushText();
  return out;
}

/** 块级分页：文本段/表格均为原子块不跨页；超长文本段按行切分（沿用旧兜底），超长表格整表独占一页 */
function paginateBlocks(
  blocks: XhsBodyBlock[],
  cap: number,
  measureText: (t: string) => number,
  measureTable: (header: string[], rows: string[][]) => number,
): XhsBodyBlock[][] {
  const pages: XhsBodyBlock[][] = [];
  let cur: XhsBodyBlock[] = [];
  let curH = 0;
  const flush = () => {
    if (cur.length) {
      pages.push(cur);
      cur = [];
      curH = 0;
    }
  };

  for (const b of blocks) {
    if (b.kind === 'table') {
      const h = measureTable(b.header, b.rows);
      if (h > cap) {
        // 超大表格：独占一页（仍超高则允许渲染端裁剪，保底不拆行）
        flush();
        cur.push(b);
        curH = h;
        flush();
        continue;
      }
      if (cur.length && curH + h > cap) flush();
      cur.push(b);
      curH += h;
      continue;
    }

    const h = measureText(b.text);
    if (h <= cap) {
      if (cur.length && curH + h > cap) flush();
      cur.push(b);
      curH += h;
      continue;
    }
    // 单文本段超高 → 按行切分（兼容旧分页兜底）
    for (const line of b.text.split('\n')) {
      let lh = measureText(line);
      if (cur.length && curH + lh > cap) flush();
      if (lh <= cap) {
        cur.push({ kind: 'text', text: line });
        curH += lh;
        continue;
      }
      // 超长单行：按句末标点逐段放入独立页
      flush();
      let rest = line;
      while (rest) {
        const fit = fitPrefix(rest, cap, measureText);
        if (!fit) {
          rest = rest.slice(1);
          continue;
        }
        cur.push({ kind: 'text', text: fit });
        curH = cap + 1; // 占满单页容量，强制后续换页
        rest = rest.slice(fit.length);
        if (rest) flush();
      }
    }
  }
  flush();
  return pages;
}

/** 标题栏标签自动生成：按问题关键词匹配一个主题标签（可手动修改） */
function autoTag(question: string): string {
  const q = question || '';
  const map: Array<[RegExp, string]> = [
    [/合同|合约|签署|违约/, '合同'],
    [/劳动|工伤|赔偿|裁员|辞退/, '劳动'],
    [/离婚|婚姻|彩礼|抚养/, '婚姻'],
    [/借款|借贷|欠款|还款|民间借贷/, '借贷'],
    [/侵权|名誉|肖像|骚扰/, '侵权'],
    [/刑事|犯罪|量刑|取保/, '刑事'],
    [/房产|房屋|买房|卖房/, '房产'],
    [/租赁|房东|租金/, '租赁'],
    [/公司|股权|股东|合伙|法定代表人/, '公司'],
    [/交通|事故|车祸|碰撞/, '交通'],
    [/继承|遗嘱|遗产/, '继承'],
  ];
  for (const [re, tag] of map) {
    if (re.test(q)) return tag;
  }
  return '干货';
}

/** 可编辑内容态：标题 / 封面要点 / 标题栏标签（AI 自动 1 个 + 用户 2 个）/ 正文（正文改动后重新分页） */
interface EditableContent {
  title: string;
  points: string[];
  tags: string[];
  body: string;
}

/** 草稿存储键：按问题内容哈希隔离（不同问答互不覆盖） */
function draftKey(question: string): string {
  let h = 0;
  for (let i = 0; i < question.length; i++) h = (h * 31 + question.charCodeAt(i)) | 0;
  return `bobwork-xhs-draft-${Math.abs(h).toString(36)}`;
}

/** 由 Q+A 自动推导初始内容，供编辑态初始化与"重置"回滚 */
function computeAuto(question: string, answer: string): EditableContent {
  const lines = mdToLines(answer);
  const items = extractCoverItems(lines);
  // 封面兜底要点排除表格行（|...| 原始 markdown 不适合做封面编号要点）
  const clean = lines.filter((l) => l.trim() !== '' && !isPipeRow(l));
  return {
    title: question.trim() || 'AI 问答',
    points: items ?? clean.slice(0, 3).map((l) => l.slice(0, 40)),
    tags: [autoTag(question), '', ''],
    body: lines.join('\n'),
  };
}

/* ============ 页面渲染 ============ */
const chip = (bg: string, fg: string): CSSProperties => ({
  borderRadius: 999, padding: '4px 12px', fontSize: '0.866667rem', fontWeight: 600, backgroundColor: bg, color: fg,
});

/* ============ 内置装饰（无模型兜底） ============ */
/** 手绘风 SVG 简笔画（120×90，居中构图，免模型、零等待） */
const DOODLE_BODIES: ReactNode[] = [
  // 1 治愈云朵 · 清单 · 星
  <>
    <circle cx="96" cy="16" r="11" fill="#FFC24B" />
    <circle cx="26" cy="22" r="7" fill="#FFFFFF" stroke="#EAD9C6" strokeWidth="2" />
    <circle cx="37" cy="17" r="9" fill="#FFFFFF" stroke="#EAD9C6" strokeWidth="2" />
    <circle cx="48" cy="22" r="7" fill="#FFFFFF" stroke="#EAD9C6" strokeWidth="2" />
    <rect x="54" y="40" width="34" height="42" rx="6" fill="#FFFFFF" stroke="#EAD9C6" strokeWidth="2" />
    <rect x="62" y="49" width="18" height="3" rx="1.5" fill="#D9C4AE" />
    <rect x="62" y="56" width="18" height="3" rx="1.5" fill="#D9C4AE" />
    <rect x="62" y="63" width="12" height="3" rx="1.5" fill="#D9C4AE" />
    <circle cx="80" cy="64" r="7" fill="#FF6B6B" />
    <path d="M76.6 64.2l2.2 2.2 4.4-4.6" stroke="#FFFFFF" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14 76q2-6 4 0 2-6 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M104 42l1.6 3.4 3.6.5-2.6 2.6.6 3.7-3.2-1.8-3.2 1.8.6-3.7-2.6-2.6 3.6-.5z" fill="#FF8FA3" />
  </>,
  // 2 爱心 · 花草 · 气泡
  <>
    <circle cx="60" cy="20" r="9" fill="#FFD9E3" />
    <path d="M60 24c-2-3.4-8-2.6-8 1.6 0 3 4.2 5.8 8 8.4 3.8-2.6 8-5.4 8-8.4 0-4.2-6-5-8-1.6z" fill="#FF5C8A" />
    <path d="M24 60q2-6 4 0 2-6 4 0 2-6 4 0 2-6 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <circle cx="96" cy="58" r="10" fill="#FFE0B8" />
    <path d="M96 50l1.4 3 3.2.4-2.3 2.3.5 3.2-2.8-1.5-2.8 1.5.5-3.2-2.3-2.3 3.2-.4z" fill="#FF8FA3" />
    <path d="M70 78c-6-8-18-5-18 3 0 6 10 9 18 9s18-3 18-9c0-8-12-11-18-3z" fill="#FFD9E3" />
  </>,
  // 3 清单打勾 · 铅笔 · 便签
  <>
    <rect x="40" y="12" width="40" height="56" rx="7" fill="#FFFFFF" stroke="#C9B8A6" strokeWidth="2" />
    <rect x="48" y="22" width="12" height="3" rx="1.5" fill="#D9C4AE" />
    <rect x="48" y="30" width="12" height="3" rx="1.5" fill="#D9C4AE" />
    <circle cx="52" cy="42" r="7" fill="#FF6B6B" />
    <path d="M49 42.4l2 2 4-4.4" stroke="#FFFFFF" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="66" y="52" width="14" height="4" rx="2" fill="#FFC24B" transform="rotate(20 73 54)" />
    <path d="M20 76c-4-4-8-3-8 1 0 3 4 5 8 5s8-2 8-5c0-4-4-5-8-1z" fill="#A9D8C8" />
    <path d="M104 70l-1 4-4 1 4 1 1 4 1-4 4-1-4-1z" fill="#FFC24B" />
  </>,
  // 4 月亮 · 星星 · 夜云
  <>
    <path d="M84 16a16 16 0 1 0 12 27 13 13 0 1 1-12-27z" fill="#FFD98A" />
    <path d="M22 22q2-5 4 0 2-5 4 0 2-5 4 0" stroke="#B9C8E8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <circle cx="18" cy="52" r="9" fill="#FFFFFF" stroke="#D8CFE8" strokeWidth="2" />
    <circle cx="30" cy="48" r="11" fill="#FFFFFF" stroke="#D8CFE8" strokeWidth="2" />
    <circle cx="42" cy="52" r="9" fill="#FFFFFF" stroke="#D8CFE8" strokeWidth="2" />
    <path d="M58 70l1.4 3 3.2.5-2.3 2.3.5 3.2-2.8-1.5-2.8 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FF8FA3" />
    <path d="M104 58q2-6 4 0" stroke="#B9C8E8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
  </>,
  // 5 书本 · 放大镜 · 星
  <>
    <path d="M34 26h40c4 0 7 3 7 7v34c0-4-3-7-7-7H34z" fill="#FFFFFF" stroke="#C9B8A6" strokeWidth="2" />
    <path d="M34 26h-8c-4 0-7 3-7 7v34c0-4 3-7 7-7h8z" fill="#FFF0F2" stroke="#C9B8A6" strokeWidth="2" />
    <rect x="42" y="38" width="24" height="3" rx="1.5" fill="#D9C4AE" />
    <rect x="42" y="46" width="18" height="3" rx="1.5" fill="#D9C4AE" />
    <circle cx="86" cy="52" r="14" fill="none" stroke="#7FB8A6" strokeWidth="4" />
    <path d="M96 62l10 10" stroke="#7FB8A6" strokeWidth="4" strokeLinecap="round" />
    <path d="M100 30l1.4 3 3.2.5-2.3 2.3.5 3.2-2.8-1.5-2.8 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFC24B" />
  </>,
  // 6 花瓶 · 绿植
  <>
    <path d="M60 62c-10-14-26-9-26 4 0 9 12 14 26 14s26-5 26-14c0-13-16-18-26-4z" fill="#FFE0B8" />
    <path d="M52 30c0-8 8-8 8-8s8 0 8 8-8 10-8 10-8-2-8-10z" fill="#A9D8C8" />
    <path d="M52 30c-8-4-14-2-14 6 0 6 8 10 14 8z" fill="#7FB8A6" />
    <path d="M68 30c8-4 14-2 14 6 0 6-8 10-14 8z" fill="#7FB8A6" />
    <path d="M60 40v22" stroke="#E8B48A" strokeWidth="3" strokeLinecap="round" />
    <circle cx="30" cy="22" r="6" fill="#FFD98A" />
    <path d="M104 68l1.4 3 3.2.5-2.3 2.3.5 3.2-2.8-1.5-2.8 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FF8FA3" />
  </>,
  // 7 咖啡杯 · 蒸汽
  <>
    <path d="M40 34h42c0 18-8 30-21 30S40 52 40 34z" fill="#FFF7E8" stroke="#D9C4AE" strokeWidth="2.5" />
    <path d="M40 34c-2-6-8-10-14-10-8 0-14 6-14 14 0 6 4 11 9 13 6-2 15-8 19-17z" fill="#F6E8D8" stroke="#D9C4AE" strokeWidth="2" />
    <path d="M38 40q2-5 4 0 2-5 4 0" stroke="#C9A67A" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M92 30q2-6 4 0 2-6 4 0" stroke="#E8B48A" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M70 74c-4-3-8-2-8 1 0 2 4 3 8 3s8-1 8-3c0-3-4-4-8-1z" fill="#A9D8C8" />
  </>,
  // 8 信封 · 邮件
  <>
    <rect x="30" y="30" width="60" height="40" rx="6" fill="#FFFFFF" stroke="#E8B48A" strokeWidth="2.5" />
    <path d="M30 34l30 20 30-20" stroke="#E8B48A" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="96" cy="22" r="6" fill="#FFD98A" />
    <path d="M52 56c-3-4-7-3-7 1 0 2 3 3 7 3s7-1 7-3c0-4-4-5-7-1z" fill="#FF8FA3" />
    <path d="M104 66l-1 4-4 1 4 1 1 4 1-4 4-1-4-1z" fill="#FFC24B" />
  </>,
  // 9 灯泡 · 灵感
  <>
    <path d="M60 18c-13 0-22 9-22 20 0 8 4 13 9 17v8c0 3 2 5 5 5h16c3 0 5-2 5-5v-8c5-4 9-9 9-17 0-11-9-20-22-20z" fill="#FFE0B8" stroke="#E8B48A" strokeWidth="2.5" />
    <path d="M52 60h16" stroke="#E8B48A" strokeWidth="3" strokeLinecap="round" />
    <path d="M54 70h12" stroke="#E8B48A" strokeWidth="3" strokeLinecap="round" />
    <path d="M24 40l2.5 1 1 2.5 1-2.5 2.5-1-2.5-1-1-2.5-1 2.5z" fill="#FFC24B" />
    <path d="M98 38l2 1 1 2 1-2 2-1-2-1-1-2-1 2z" fill="#FF8FA3" />
  </>,
  // 10 天平 · 法律
  <>
    <path d="M60 26v40" stroke="#C9A67A" strokeWidth="4" strokeLinecap="round" />
    <circle cx="60" cy="20" r="6" fill="#E8B48A" />
    <path d="M30 40h60" stroke="#C9A67A" strokeWidth="4" strokeLinecap="round" />
    <path d="M30 40l-12 18M90 40l12 18" stroke="#C9A67A" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 60h36M72 60h36" stroke="#E8B48A" strokeWidth="4" strokeLinecap="round" />
    <path d="M30 66c-3-4-7-3-7 1 0 2 3 3 7 3s7-1 7-3c0-4-4-5-7-1z" fill="#FFD98A" />
    <path d="M90 66c-3-4-7-3-7 1 0 2 3 3 7 3s7-1 7-3c0-4-4-5-7-1z" fill="#FFD98A" />
    <path d="M24 34q2-6 4 0 2-6 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
  </>,
  // 11 指南针
  <>
    <circle cx="60" cy="44" r="26" fill="#FFF7E8" stroke="#D9C4AE" strokeWidth="2.5" />
    <circle cx="60" cy="44" r="18" fill="none" stroke="#E8D9C8" strokeWidth="1.5" />
    <path d="M60 32l7 18-7 6-7-6z" fill="#FF5C8A" />
    <path d="M60 32l-7 18 7-6z" fill="#FF8FA3" />
    <path d="M34 14q2-5 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M104 58l1.4 3 3.2.5-2.3 2.3.5 3.2-2.8-1.5-2.8 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFC24B" />
  </>,
  // 12 小猫
  <>
    <path d="M42 24 L46 8 L56 16 Z" fill="#FFFFFF" stroke="#C9B8A6" strokeWidth="2" strokeLinejoin="round" />
    <path d="M74 24 L70 8 L60 16 Z" fill="#FFFFFF" stroke="#C9B8A6" strokeWidth="2" strokeLinejoin="round" />
    <path d="M46 21 L48 13 L54 18 Z" fill="#FFD9E3" />
    <path d="M70 21 L68 13 L62 18 Z" fill="#FFD9E3" />
    <circle cx="58" cy="36" r="20" fill="#FFFFFF" stroke="#C9B8A6" strokeWidth="2.5" />
    <circle cx="51" cy="36" r="2.6" fill="#5B4A3A" />
    <circle cx="65" cy="36" r="2.6" fill="#5B4A3A" />
    <path d="M56 43 l2 2.4 2-2.4" stroke="#FF8A8A" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M36 38 h-8 M36 44 h-8 M80 38 h8 M80 44 h8" stroke="#D9C4AE" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="58" cy="70" r="13" fill="#FFF0F2" stroke="#C9B8A6" strokeWidth="2.5" />
    <path d="M71 74 q10-4 8-14" stroke="#C9B8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M104 16l1.3 3 3.2.5-2.3 2.3.5 3.2-2.7-1.5-2.7 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFC24B" />
  </>,
  // 13 小狗
  <>
    <path d="M44 22 q-10 8 -6 20 q4 8 12 4 z" fill="#E8D5C0" stroke="#C9B8A6" strokeWidth="2" strokeLinejoin="round" />
    <path d="M76 22 q10 8 6 20 q-4 8 -12 4 z" fill="#E8D5C0" stroke="#C9B8A6" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="60" cy="34" r="18" fill="#FFFFFF" stroke="#C9B8A6" strokeWidth="2.5" />
    <circle cx="53" cy="34" r="2.6" fill="#5B4A3A" />
    <circle cx="67" cy="34" r="2.6" fill="#5B4A3A" />
    <ellipse cx="60" cy="41" rx="4" ry="3" fill="#5B4A3A" />
    <path d="M58 47 q0 6 4 4 q2 5 -2 5 q-6 0 -4-6 z" fill="#FF8FA3" />
    <circle cx="60" cy="70" r="12" fill="#FFF6EF" stroke="#C9B8A6" strokeWidth="2.5" />
    <path d="M72 70 q10-2 8-12" stroke="#C9B8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M14 20q2-5 4 0 2-5 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
  </>,
  // 14 兔子
  <>
    <path d="M50 32 Q46 8 40 6 Q36 22 44 32" fill="#FFFFFF" stroke="#D8CFE8" strokeWidth="2.5" />
    <path d="M62 32 Q66 8 72 6 Q76 22 68 32" fill="#FFFFFF" stroke="#D8CFE8" strokeWidth="2.5" />
    <path d="M48 25 Q45 13 42 12 Q41 20 46 27" fill="#FFD9E3" />
    <path d="M64 25 Q67 13 70 12 Q71 20 66 27" fill="#FFD9E3" />
    <ellipse cx="56" cy="40" rx="17" ry="15" fill="#FFFFFF" stroke="#D8CFE8" strokeWidth="2.5" />
    <circle cx="50" cy="38" r="2.4" fill="#5B4A3A" />
    <circle cx="63" cy="38" r="2.4" fill="#5B4A3A" />
    <circle cx="44" cy="44" r="3" fill="#FFD9E3" />
    <circle cx="69" cy="44" r="3" fill="#FFD9E3" />
    <path d="M56 42 l1.5 2 1.5-2" stroke="#FF8A8A" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <ellipse cx="56" cy="70" rx="13" ry="10" fill="#FFF0F2" stroke="#D8CFE8" strokeWidth="2.5" />
    <path d="M100 58l1.3 3 3.2.5-2.3 2.3.5 3.2-2.7-1.5-2.7 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFC24B" />
  </>,
  // 15 小熊
  <>
    <circle cx="40" cy="20" r="8" fill="#E8D5C0" stroke="#C9B8A6" strokeWidth="2.5" />
    <circle cx="72" cy="20" r="8" fill="#E8D5C0" stroke="#C9B8A6" strokeWidth="2.5" />
    <circle cx="56" cy="38" r="20" fill="#F6EAD9" stroke="#C9B8A6" strokeWidth="2.5" />
    <ellipse cx="56" cy="44" rx="9" ry="7" fill="#F0E0CB" />
    <circle cx="48" cy="35" r="2.4" fill="#5B4A3A" />
    <circle cx="64" cy="35" r="2.4" fill="#5B4A3A" />
    <ellipse cx="56" cy="41" rx="3" ry="2.4" fill="#5B4A3A" />
    <path d="M56 44 v4 m-3-2 h6" stroke="#5B4A3A" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <ellipse cx="56" cy="72" rx="15" ry="11" fill="#F6EAD9" stroke="#C9B8A6" strokeWidth="2.5" />
    <path d="M14 66q2-5 4 0 2-5 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
  </>,
  // 16 足球
  <>
    <circle cx="56" cy="44" r="26" fill="#FFFFFF" stroke="#3D3D3D" strokeWidth="2.5" />
    <path d="M56 30 l9 6 -3 10 h-12 l-3-10 z" fill="#3D3D3D" />
    <path d="M36 38 l10-1 4 9 -7 8 -8-5 z" fill="#3D3D3D" opacity=".85" />
    <path d="M76 38 l-10-1 -4 9 7 8 8-5 z" fill="#3D3D3D" opacity=".85" />
    <path d="M48 64 l7-6 8 4 -2 9 -9 2 z" fill="#3D3D3D" opacity=".7" />
    <path d="M12 20q2-5 4 0 2-5 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M104 66l1.3 3 3.2.5-2.3 2.3.5 3.2-2.7-1.5-2.7 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFC24B" />
  </>,
  // 17 篮球
  <>
    <circle cx="58" cy="46" r="26" fill="#FF8A4C" />
    <path d="M58 20 q-8 13 0 26 q8 13 0 26" stroke="#FFFFFF" strokeWidth="2.2" fill="none" />
    <path d="M38 28 q16 8 40 0 M38 64 q16-8 40 0" stroke="#FFFFFF" strokeWidth="2.2" fill="none" />
    <path d="M20 26q2-5 4 0 2-5 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M104 40l1.3 3 3.2.5-2.3 2.3.5 3.2-2.7-1.5-2.7 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFC24B" />
  </>,
  // 18 羽毛球
  <>
    <ellipse cx="44" cy="38" rx="16" ry="20" fill="none" stroke="#C9B8A6" strokeWidth="3" transform="rotate(-15 44 38)" />
    <ellipse cx="44" cy="38" rx="11" ry="15" fill="none" stroke="#E8D5C0" strokeWidth="1.5" transform="rotate(-15 44 38)" strokeDasharray="3 3" />
    <path d="M44 58 L54 78" stroke="#C9B8A6" strokeWidth="3.5" strokeLinecap="round" />
    <path d="M86 24 q6 0 8 8 l-10 2 z" fill="#FFFFFF" stroke="#C9B8A6" strokeWidth="2" />
    <path d="M86 24 q-6 0 -8 8 l10 2 z" fill="#FFFFFF" stroke="#C9B8A6" strokeWidth="2" />
    <path d="M80 32 h12 l-4 8 z" fill="#FFD98A" stroke="#E0B860" strokeWidth="1.5" />
    <circle cx="86" cy="34" r="3.5" fill="#FF8A4C" />
    <path d="M14 66q2-5 4 0 2-5 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M104 60l1.3 3 3.2.5-2.3 2.3.5 3.2-2.7-1.5-2.7 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFC24B" />
  </>,
  // 19 奖杯
  <>
    <path d="M40 22 h32 v8 q0 16 -16 16 q-16 0 -16-16 z" fill="#FFD98A" stroke="#E0B860" strokeWidth="2.5" />
    <rect x="46" y="48" width="20" height="6" rx="3" fill="#E0B860" />
    <rect x="50" y="54" width="12" height="8" rx="2" fill="#E0B860" />
    <path d="M40 26 q-12 6 -8 18 q6 8 12 4" stroke="#E0B860" strokeWidth="3" fill="none" strokeLinecap="round" />
    <path d="M72 26 q12 6 8 18 q-6 8 -12 4" stroke="#E0B860" strokeWidth="3" fill="none" strokeLinecap="round" />
    <path d="M60 32l1.4 3 3.2.5-2.3 2.3.5 3.2-2.8-1.5-2.8 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFFFFF" />
    <path d="M14 20q2-5 4 0 2-5 4 0" stroke="#7FB8A6" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M104 66l1.3 3 3.2.5-2.3 2.3.5 3.2-2.7-1.5-2.7 1.5.5-3.2-2.3-2.3 3.2-.5z" fill="#FFC24B" />
  </>,
];

/** 渲染内置装饰（循环取模，越界安全） */
function BuiltinDoodle({ index, style }: { index: number; style?: CSSProperties }) {
  const i = ((index % DOODLE_BODIES.length) + DOODLE_BODIES.length) % DOODLE_BODIES.length;
  return (
    <svg viewBox="0 0 120 90" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', ...style }}>
      {DOODLE_BODIES[i]}
    </svg>
  );
}

/* ============ AI 插画风格预设 ============ */
const ILLUST_STYLES: Array<{ key: string; label: string; prompt: string }> = [
  { key: 'watercolor', label: 'Watercolor', prompt: '治愈系手绘水彩风，柔和暖色调、细腻水彩笔触、温暖治愈的质感' },
  { key: 'flat', label: 'Flat cartoon', prompt: '扁平卡通漫画风，简洁线条、明快色块' },
  { key: '3d', label: '3D cute', prompt: '3D 卡通盲盒风，圆润立体、柔和质感、精致渲染' },
  { key: 'sticker', label: 'Sticker', prompt: '手账贴纸风，白色描边、贴纸质感、可爱简约' },
  { key: 'guochao', label: 'Guochao', prompt: '国潮新中式插画，传统纹样与现代扁平结合、辨识度高' },
  { key: 'line', label: 'Minimal line', prompt: '极简线条画，线条干净、留白充足、克制雅致' },
];

/** 由风格 + 自定义提示词（缺省取问题）拼出生成 prompt */
function buildIllustPrompt(styleKey: string, customPrompt: string, question: string): string {
  const style = ILLUST_STYLES.find((s) => s.key === styleKey) ?? ILLUST_STYLES[0];
  const topic = customPrompt.trim() || (question || 'AI 问答').slice(0, 60);
  return `一幅${style.prompt}的插画，横向构图，主题：${topic}。主体居中、四周留白充足，用作社交媒体知识卡片底部装饰，画面干净。`;
}

/* ============ 标签渲染 ============ */
/** 标签笔刷样式表：id → 中文名（灰色油墨系，笔触内透出纸色条纹/纹理） */
const BRUSH_STYLES: Array<{ id: string; label: string }> = [
  { id: 'oil', label: '油画干刷' },
  { id: 'calligraphy', label: '毛笔' },
  { id: 'marker', label: '马克笔' },
  { id: 'crayon', label: '蜡笔' },
  { id: 'watercolor', label: '水彩' },
  { id: 'paint', label: '油漆' },
  { id: 'bristle', label: '毛刷' },
];

/** 笔刷 SVG 内容：按样式渲染笔触（viewBox 120x46，纸色透出用 paper.bg） */
function BrushSvg({ style, paper }: { style: string; paper: XhsPaper }) {
  const paperColor = paper.bg;
  switch (style) {
    case 'calligraphy':
      return (
        <g>
          {/* 墨迹：藏锋起笔粗 → 行笔 → 收笔带锋 */}
          <path d="M2 24 C 10 8, 26 8, 40 12 C 62 18, 78 20, 116 12 L 116 22 C 96 28, 70 28, 44 24 C 26 21, 12 30, 2 32 Z" fill="#C9C0B5" />
          {/* 飞白 */}
          <path d="M14 13 C 26 11, 40 14, 54 16" stroke={paperColor} strokeWidth={1.8} strokeOpacity={0.7} fill="none" strokeLinecap="round" />
          <path d="M22 20 C 38 17, 58 19, 76 17" stroke={paperColor} strokeWidth={1.5} strokeOpacity={0.5} fill="none" strokeLinecap="round" />
        </g>
      );
    case 'marker':
      return (
        <g opacity={0.9}>
          {/* 双道半透明色带 */}
          <path d="M4 16 C 30 11, 70 10, 116 14 L 116 24 C 90 20, 50 22, 4 26 Z" fill="#CFC7BB" opacity={0.85} />
          <path d="M4 27 C 34 23, 66 25, 116 28 L 116 33 C 70 31, 36 33, 4 35 Z" fill="#C4BBAD" opacity={0.7} />
          {/* 笔刷分界透光 */}
          <path d="M6 24 C 40 20, 80 21, 114 24" stroke={paperColor} strokeWidth={1.2} strokeOpacity={0.8} fill="none" strokeLinecap="round" />
        </g>
      );
    case 'crayon':
      return (
        <g>
          {/* 蜡笔颗粒：多段深浅叠涂 */}
          <path d="M3 20 C 18 10, 40 12, 62 14 C 86 16, 104 12, 117 16 L 117 26 C 100 22, 80 28, 58 26 C 36 24, 18 30, 3 27 Z" fill="#D4CCC0" />
          <path d="M10 18 C 30 8, 56 10, 80 12" stroke="#DCD4C8" strokeWidth={2.2} strokeLinecap="round" fill="none" />
          <path d="M24 24 C 44 18, 70 20, 96 16" stroke="#C9C0B3" strokeWidth={2} strokeLinecap="round" fill="none" opacity={0.9} />
          <path d="M40 30 C 60 25, 84 26, 108 22" stroke="#BDB4A6" strokeWidth={1.8} strokeLinecap="round" fill="none" opacity={0.8} />
          {/* 颗粒小点 */}
          {[14, 38, 66, 92].map((x, i) => (
            <circle key={i} cx={x} cy={18 + i * 4} r={1.2} fill={paperColor} opacity={0.6} />
          ))}
        </g>
      );
    case 'watercolor':
      return (
        <g>
          {/* 水彩晕染：模糊边缘 */}
          <defs>
            <filter id="xhs-wc" x="-20%" y="-40%" width="140%" height="200%">
              <feGaussianBlur stdDeviation="4" />
            </filter>
          </defs>
          <path d="M6 26 C 16 8, 46 8, 68 12 C 92 16, 108 14, 114 20 C 116 24, 112 32, 94 34 C 70 38, 30 38, 12 32 Z" fill="#CFC6B8" filter="url(#xhs-wc)" opacity={0.9} />
          {/* 内层水痕 */}
          <path d="M16 24 C 30 14, 56 15, 74 18 C 88 20, 100 20, 106 23" stroke={paperColor} strokeWidth={2.4} strokeOpacity={0.75} fill="none" strokeLinecap="round" filter="url(#xhs-wc)" />
        </g>
      );
    case 'paint':
      return (
        <g>
          {/* 平滑漆面 */}
          <rect x="4" y="10" width="112" height="26" rx="8" fill="#CFC7BB" />
          {/* 顶部光泽高光 */}
          <path d="M10 13 L 110 13" stroke="#E9E4DC" strokeWidth={2} strokeLinecap="round" opacity={0.9} />
          {/* 刷毛水平纹理 */}
          <path d="M10 18 L 110 18" stroke={paperColor} strokeWidth={1} strokeOpacity={0.5} strokeLinecap="round" />
          <path d="M10 22 L 110 22" stroke={paperColor} strokeWidth={1} strokeOpacity={0.35} strokeLinecap="round" />
          {/* 底部漆滴 */}
          <circle cx="18" cy="38" r="2.4" fill="#C7BEB1" />
          <circle cx="92" cy="39" r="3" fill="#C2B8AA" />
          <circle cx="106" cy="37" r="1.6" fill="#CFC7BB" />
        </g>
      );
    case 'bristle':
      return (
        <g>
          {/* 细密刷毛丝线基底 */}
          <path d="M4 18 C 20 8, 60 8, 116 14 L 116 30 C 80 26, 40 32, 4 28 Z" fill="#CEC6B9" />
          {Array.from({ length: 9 }).map((_, i) => (
            <path
              key={i}
              d={`M${12 + i * 11} 12 C ${16 + i * 11} 20, ${14 + i * 11} 30, ${10 + i * 11} 36`}
              stroke="#E4DED4"
              strokeWidth={1.4}
              strokeLinecap="round"
              fill="none"
              opacity={0.85}
            />
          ))}
          {/* 毛束间透出纸色 */}
          <path d="M20 22 C 40 18, 70 20, 96 16" stroke={paperColor} strokeWidth={1.6} strokeOpacity={0.5} fill="none" strokeLinecap="round" />
        </g>
      );
    case 'oil':
    default:
      return (
        <g>
          {/* 油墨基底（中厚两端收） */}
          <path d="M5 27 C 15 9, 40 11, 62 10 C 82 9, 95 11, 99 13 L 99 21 C 91 25, 78 23, 60 23 C 40 23, 16 31, 6 30 Z" fill="#D8D2C9" />
          {/* 油墨不足：透出纸色条纹 */}
          <path d="M16 15 C 34 11, 56 13, 78 12" stroke={paperColor} strokeWidth={3.2} strokeOpacity={0.95} fill="none" strokeLinecap="round" />
          <path d="M26 21 C 44 17, 64 19, 84 17" stroke={paperColor} strokeWidth={2.4} strokeOpacity={0.8} fill="none" strokeLinecap="round" />
          <path d="M20 27 C 38 24, 60 25, 82 23" stroke={paperColor} strokeWidth={2} strokeOpacity={0.65} fill="none" strokeLinecap="round" />
          {/* 颜料残片 */}
          <path d="M10 25 C 18 21, 28 23, 36 21" stroke="#C2BBB1" strokeWidth={2.5} strokeLinecap="round" fill="none" />
          <path d="M68 25 C 78 23, 88 24, 98 21" stroke="#C2BBB1" strokeWidth={2.5} strokeLinecap="round" fill="none" />
          {/* 顶部高光 */}
          <path d="M44 13 C 58 11, 70 12, 84 11" stroke="#E8E3DB" strokeWidth={1.5} strokeOpacity={0.8} fill="none" strokeLinecap="round" />
        </g>
      );
  }
}

function BrushTag({ text, paper, brush }: { text: string; paper: XhsPaper; brush: string }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '6px 18px 8px' }}>
      <svg viewBox="0 0 120 46" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <BrushSvg style={brush} paper={paper} />
      </svg>
      <span style={{ position: 'relative', zIndex: 2, fontSize: '0.866667rem', fontWeight: 700, letterSpacing: 1, color: '#4A4038' }}>{text}</span>
    </span>
  );
}

type IllustState = 'idle' | 'loading' | 'done' | 'error';

interface PageViewProps {
  data: XhsPageData;
  idx: number;
  total: number;
  theme: XhsTheme;
  paper: XhsPaper;
  illust: string | null;
  illustState: IllustState;
  illustMode: 'ai' | 'builtin' | 'upload';
  doodleIdx: number;
  illustError?: string;
  title: string;
  tags: string[];
  brush: string;
  stamp: Date;
  brandLogo: string;
  customDoodles: Array<{ name: string; dataUrl: string }>;
  innerRef?: (el: HTMLDivElement | null) => void;
}

function CoverPage({ data, theme, paper, illust, illustState, illustMode, doodleIdx, illustError, title, tags, brush, stamp, brandLogo, customDoodles, innerRef }: PageViewProps) {
  // 自定义图库：doodleIdx 越过内置数量后循环自定义图片（越界安全）
  const customLen = customDoodles.length;
  const customDoodle =
    customLen > 0 ? customDoodles[(((doodleIdx - DOODLE_BODIES.length) % customLen) + customLen) % customLen] : null;
  return (
    <div
      ref={innerRef}
      style={{
        ...themeVars(theme, paper),
        width: XHS_W,
        height: XHS_H,
        boxSizing: 'border-box',
        padding: PAD,
        backgroundColor: 'var(--x-paper)',
        color: '#2A2A2A',
        fontFamily: FONT,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '4px 12px', backgroundColor: theme.soft, color: theme.text }}>
          <img src={brandLogo} alt="BobWork" style={{ width: 20, height: 20, borderRadius: 6, objectFit: 'contain', flexShrink: 0 }} />
          <span style={{ fontSize: '0.866667rem', fontWeight: 700 }}>BobWork</span>
        </span>
        {tags.filter(Boolean).map((t, i) => (
          <BrushTag key={i} text={t} paper={paper} brush={brush} />
        ))}
      </div>
      <div
        style={{
          marginTop: 22,
          fontSize: 26,
          fontWeight: 700,
          lineHeight: 1.4,
          color: '#2A2A2A',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {title || 'AI 问答'}
      </div>
      {/* 品牌色手绘感下划线，替代底部留白/插画空缺时的视觉落点 */}
      <div
        style={{
          marginTop: 10,
          width: 64,
          height: 6,
          borderRadius: 999,
          backgroundColor: theme.brand,
          transform: 'rotate(-2deg)',
        }}
      />
      {data.lines.length > 0 && (
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.lines.map((it, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: '1rem', lineHeight: 1.7, color: '#3A3A3A' }}>
              <span
                style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  backgroundColor: theme.brand,
                  color: '#fff',
                  fontSize: '0.866667rem',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {i + 1}
              </span>
              <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {it}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 12 }} />
      {/* 底部插画区：满宽横条（40% 高）+ cover 居中裁切，视觉饱满 */}
      <div
        style={{
          marginTop: 14,
          flex: '0 0 40%',
          minHeight: 120,
          borderRadius: 14,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {illustMode === 'builtin' ? (
          customDoodle ? (
            <>
              <img src={customDoodle.dataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: `linear-gradient(180deg, transparent 40%, ${hexToRgba(paper.bg, 0.55)} 100%)`,
                }}
              />
            </>
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'var(--x-paper)',
              }}
            >
              <div style={{ width: '74%', height: '94%' }}>
                <BuiltinDoodle index={doodleIdx} />
              </div>
            </div>
          )
        ) : illust ? (
          <>
            <img src={illust} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: `linear-gradient(180deg, transparent 40%, ${hexToRgba(paper.bg, 0.55)} 100%)`,
              }}
            />
          </>
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: theme.soft,
              color: theme.text,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: '0.866667rem',
              fontWeight: 500,
            }}
          >
            {illustState === 'loading' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : (
              <span style={{ fontSize: '0.8rem' }}>{illustError || 'AI generation unavailable'}</span>
            )}
          </div>
        )}
      </div>
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.8rem', color: '#9A8A8F' }}>
        <span>Share via BobWork</span>
        <span>
          {stamp.toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
          })}
        </span>
      </div>
    </div>
  );
}

/** 正文页内的可视化小表格（分页阶段已按原子块测高放入页面，此处只负责呈现） */
function XhsTableBlock({ header, rows, theme }: { header: string[]; rows: string[][]; theme: XhsTheme }) {
  return (
    <div style={{ margin: `${XHS_TABLE.marginY}px 0`, border: `1px solid ${XHS_TABLE.border}`, borderRadius: 6, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: XHS_TABLE.fontSize, lineHeight: XHS_TABLE.lineHeight, wordBreak: 'break-word' }}>
        <thead>
          <tr>
            {header.map((c, i) => (
              <th key={i} style={{ padding: XHS_TABLE.pad, textAlign: 'left', fontWeight: 600, color: theme.text, backgroundColor: theme.soft }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci} style={{ padding: XHS_TABLE.pad, borderTop: `1px solid ${XHS_TABLE.border}`, color: '#3A3A3A' }}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContentPage({ data, idx, total, theme, paper, stamp, innerRef }: PageViewProps) {
  const blocks = data.blocks ?? [];
  return (
    <div
      ref={innerRef}
      style={{
        ...themeVars(theme, paper),
        width: XHS_W,
        height: XHS_H,
        boxSizing: 'border-box',
        padding: PAD,
        backgroundColor: 'var(--x-paper)',
        color: '#2A2A2A',
        fontFamily: FONT,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={chip(theme.brand, '#FFFFFF')}>干货</span>
        <span style={{ fontSize: '0.866667rem', fontWeight: 600, color: theme.text }}>{idx} / {total}</span>
      </div>
      <div style={{ marginTop: 18, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {blocks.map((b, i) =>
          b.kind === 'text' ? (
            <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '1rem', lineHeight: 1.8, color: '#3A3A3A' }}>
              {b.text}
            </div>
          ) : (
            <XhsTableBlock key={i} header={b.header} rows={b.rows} theme={theme} />
          ),
        )}
      </div>
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.8rem', color: '#9A8A8F' }}>
        <span>Share via BobWork</span>
        <span>{idx} / {total}</span>
      </div>
    </div>
  );
}

function PageView(props: PageViewProps) {
  return props.data.kind === 'cover' ? <CoverPage {...props} /> : <ContentPage {...props} />;
}

/* ============ 面板 ============ */
export interface XhsPanelProps {
  question: string;
  answer: string;
  open: boolean;
  onClose: () => void;
}

const PREVIEW_W = 320; // 预览缩放宽度（320/414）——放大预览，配合右侧预览区 360px
const PREVIEW_SCALE = PREVIEW_W / XHS_W;

/** 配置区标签页项 */
const CONFIG_TABS = [
  { key: 'style', label: 'Style' },
  { key: 'content', label: 'Content' },
  { key: 'illust', label: 'Cover illustration' },
] as const;

/** 配置区标签页：横向排列，点击切换（替代原手风琴折叠） */
function ConfigTabs({ active, onSelect }: { active: string; onSelect: (k: string) => void }) {
  return (
    <div className="mb-3 flex items-center gap-0.5 rounded-lg p-0.5" style={{ backgroundColor: 'var(--paper-soft)' }}>
      {CONFIG_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          className="flex-1 rounded-md px-1 py-1.5 text-xs font-medium transition-colors"
          style={active === t.key
            ? { backgroundColor: 'var(--panel-bg)', color: 'var(--ink-strong)', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }
            : { color: 'var(--ink-muted)' }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function XhsPanel({ question, answer, open, onClose }: XhsPanelProps) {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('style');
  const [themeVal, setThemeVal] = useState<string | undefined>(undefined);
  const [paperVal, setPaperVal] = useState<string | undefined>(undefined);
  const [brushVal, setBrushVal] = useState<string>('oil');
  const [pageIdx, setPageIdx] = useState(0);
  const [pages, setPages] = useState<XhsPageData[]>([]);
  const [illust, setIllust] = useState<string | null>(null);
  const [illustState, setIllustState] = useState<IllustState>('idle');
  const [illustError, setIllustError] = useState('');
  const [illustMode, setIllustMode] = useState<'ai' | 'builtin' | 'upload'>('builtin');
  const [doodleIdx, setDoodleIdx] = useState(0);
  const [illustStyle, setIllustStyle] = useState(ILLUST_STYLES[0].key);
  const [illustPrompt, setIllustPrompt] = useState('');
  const [illustModels, setIllustModels] = useState<Array<{ modelId: string; provider: string }>>([]);
  const [illustModel, setIllustModel] = useState('');
  const [customDoodles, setCustomDoodles] = useState<Array<{ name: string; dataUrl: string }>>([]);
  /** 自动生成插画提示词：loading 中 / 错误信息 */
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptError, setPromptError] = useState('');
  /** 批量保存下拉菜单（Save as files / Save as ZIP） */
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  /** 导出溢出提示（自动检测，仅提示不阻断） */
  const [overflowMsg, setOverflowMsg] = useState('');
  const [busy, setBusy] = useState<'copy' | 'download' | 'all' | null>(null);
  const [flash, setFlash] = useState<'' | 'copy' | 'download'>('');
  const [stamp, setStamp] = useState(() => new Date());
  const [brandLogoSrc, setBrandLogoSrc] = useState('/bobwork-logo.png');
  const [editable, setEditable] = useState<EditableContent | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const doodleFileRef = useRef<HTMLInputElement>(null);
  const theme = useMemo(() => resolveTheme(themeVal), [themeVal]);
  const paper = useMemo(() => resolvePaper(paperVal), [paperVal]);
  const total = pages.length;

  useEffect(() => { setMounted(true); }, []);

  // 点击外部关闭批量保存下拉菜单
  useEffect(() => {
    if (!saveMenuOpen) return;
    const onDown = () => setSaveMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [saveMenuOpen]);

  // 品牌标识：默认 /bobwork-logo.png；设置自定义 brandLogo 时从头像池匹配 dataUrl（与 Sidebar 一致）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const api = (window as unknown as { api?: { settings?: { load: () => Promise<{ brandLogo?: string } | null> }; avatar?: { list: () => Promise<Array<{ id: string; dataUrl: string }>> } } }).api;
        const s = await api?.settings?.load();
        if (cancelled) return;
        const brandId = s?.brandLogo;
        if (!brandId) { setBrandLogoSrc('/bobwork-logo.png'); return; }
        if (api?.avatar?.list) {
          const list = await api.avatar.list();
          setBrandLogoSrc(list.find((x) => x.id === brandId)?.dataUrl ?? '/bobwork-logo.png');
          return;
        }
        setBrandLogoSrc('/bobwork-logo.png');
      } catch {
        if (!cancelled) setBrandLogoSrc('/bobwork-logo.png');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 读取已保存的主题色 + 图像模型候选（imageEdit 显式配置 + Model Pool 绑定图像模型）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await loadSettings();
        if (cancelled) return;
        if (s.xhsThemeColor) setThemeVal(s.xhsThemeColor);
        if (s.xhsPaper) setPaperVal(s.xhsPaper);
        if (s.xhsBrush) setBrushVal(s.xhsBrush);
        const cands = getImageModelCandidates(s).map((id) => {
          const pe = (s.imageEdit?.pool ?? []).find((p) => p.modelId === id);
          const provider = pe?.provider || s.imageEdit?.provider || findProviderForModel(s, id)?.type || '';
          return { modelId: id, provider };
        });
        setIllustModels(cands);
        setIllustModel((prev) => prev || cands[0]?.modelId || '');
      } catch { /* 读取失败走默认 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // 打开时初始化内容：优先恢复本问答的草稿（自动保存），无草稿则 Q+A 自动推导；默认 Built-in 装饰
  useEffect(() => {
    if (!open) return;
    let draft: EditableContent | null = null;
    try {
      const raw = localStorage.getItem(draftKey(question));
      if (raw) {
        const parsed = JSON.parse(raw) as EditableContent;
        if (parsed && typeof parsed.title === 'string' && Array.isArray(parsed.points)) draft = parsed;
      }
    } catch { /* 草稿损坏则忽略 */ }
    setEditable(draft ?? computeAuto(question, answer));
    setDoodleIdx(Math.floor(Math.random() * DOODLE_BODIES.length));
    setPageIdx(0);
    setIllustMode('builtin');
    setIllustError('');
    setIllustState('idle');
  }, [open, question, answer]);

  // 草稿自动保存（防抖 500ms）：编辑内容变化后写入 localStorage，重开面板自动恢复
  const draftTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !editable) return;
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      try { localStorage.setItem(draftKey(question), JSON.stringify(editable)); } catch { /* 存储失败不阻断 */ }
    }, 500);
    return () => { if (draftTimer.current) window.clearTimeout(draftTimer.current); };
  }, [open, editable, question]);

  // 内容/正文变化时重新分页（利用离屏测量节点按真实行高切分）
  useLayoutEffect(() => {
    if (!open || !measureRef.current || !editable) return;
    const measure = (t: string) => {
      const el = measureRef.current;
      if (!el) return 0;
      el.textContent = t;
      return el.scrollHeight;
    };
    // 表格测高：按 XhsTableBlock 的几何常量构造离屏 DOM（颜色无关，只算布局），返回含外框与上下外边距的高度
    const measureTable = (header: string[], rows: string[][]) => {
      const el = measureRef.current;
      if (!el) return 0;
      const wrapper = document.createElement('div');
      wrapper.style.width = '100%';
      wrapper.style.border = `1px solid ${XHS_TABLE.border}`;
      wrapper.style.borderRadius = '6px';
      wrapper.style.overflow = 'hidden';
      const table = document.createElement('table');
      const st = table.style;
      st.width = '100%';
      st.borderCollapse = 'collapse';
      st.tableLayout = 'fixed';
      st.fontSize = `${XHS_TABLE.fontSize}px`;
      st.lineHeight = String(XHS_TABLE.lineHeight);
      st.wordBreak = 'break-word';
      st.whiteSpace = 'normal';
      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      for (const c of header) {
        const th = document.createElement('th');
        th.style.padding = XHS_TABLE.pad;
        th.style.textAlign = 'left';
        th.style.fontWeight = '600';
        th.textContent = c;
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of rows) {
        const tr = document.createElement('tr');
        for (const c of row) {
          const td = document.createElement('td');
          td.style.padding = XHS_TABLE.pad;
          td.style.borderTop = `1px solid ${XHS_TABLE.border}`;
          td.textContent = c;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrapper.appendChild(table);
      el.textContent = '';
      el.appendChild(wrapper);
      const h = wrapper.offsetHeight;
      wrapper.remove();
      el.textContent = '';
      return h + XHS_TABLE.marginY * 2;
    };
    const blocks = splitBodyToBlocks(editable.body);
    const cover: XhsPageData = { kind: 'cover', mode: 'points', lines: editable.points.filter(Boolean) };
    const out: XhsPageData[] = [cover];
    for (const p of paginateBlocks(blocks, CAP_BODY, measure, measureTable)) {
      out.push({ kind: 'content', lines: [], blocks: p });
    }
    setPages(out);
    setPageIdx((v) => (v >= out.length ? 0 : v));
  }, [open, editable, measureRef]);

  /** 封面 AI 插画：手动触发即直接执行（不放在 useEffect 里——effect 内 setState 会触发
   *  自身依赖变化 → cleanup 执行 controller.abort() 把正在进行的请求取消 → 永远停在 loading） */
  const runGenerate = useCallback(async () => {
    if (illustState === 'loading') return;
    setIllustState('loading');
    setIllustMode('ai'); // 生成一开始即高亮 AI 按钮并显示加载占位，避免"点了没反应"
    setIllustError('');
    setIllust(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const resp = await fetch('/api/ai-generate/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: buildIllustPrompt(illustStyle, illustPrompt, question),
          size: '2688x2048',
          model: illustModel || undefined,
          provider: illustModels.find((m) => m.modelId === illustModel)?.provider || undefined,
          negative_prompt: '文字, 水印, logo, 复杂背景, 写实照片, 恐怖, 血腥',
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data?.success) {
        setIllustState('error');
        setIllustError(data?.error || 'Generation failed');
        return;
      }
      setIllust(data.image as string);
      setIllustState('done');
      setIllustError('');
    } catch {
      setIllustState('error');
      setIllustError('Generation failed (timeout or network)');
    } finally {
      clearTimeout(timer);
    }
  }, [illustState, illustStyle, illustPrompt, question, illustModel, illustModels]);

  const persistTheme = useCallback(async (v: string) => {
    setThemeVal(v);
    try {
      const s = await loadSettings();
      s.xhsThemeColor = v;
      await saveSettings(s);
    } catch { /* 保存失败不阻断本地生效 */ }
  }, []);

  const persistPaper = useCallback(async (key: string) => {
    setPaperVal(key);
    try {
      const s = await loadSettings();
      s.xhsPaper = key;
      await saveSettings(s);
    } catch { /* 保存失败不阻断本地生效 */ }
  }, []);

  const persistBrush = useCallback(async (key: string) => {
    setBrushVal(key);
    try {
      const s = await loadSettings();
      s.xhsBrush = key;
      await saveSettings(s);
    } catch { /* 保存失败不阻断本地生效 */ }
  }, []);

  /** 使用 AI 插画：切到 AI 模式并触发生成（手动触发；失败时停留在 AI 模式展示错误，不自动回退） */
  const genIllust = useCallback(() => {
    runGenerate();
  }, [runGenerate]);

  /** 切换到 AI 编辑页：只切界面，不自动生成；生成完全由 Generate / New 按钮手动触发 */
  const handleUseAi = useCallback(() => {
    setIllustMode('ai');
    setIllustError('');
  }, []);

  /** 选择 AI 插画风格：仅记录选择，需点 Generate 手动触发生成 */
  const handlePickStyle = useCallback((key: string) => {
    setIllustStyle(key);
  }, []);

  /** 选择生图模型：仅记录选择，需点 Generate 手动触发生成 */
  const handlePickModel = useCallback((modelId: string) => {
    setIllustModel(modelId);
  }, []);

  /** 根据卡片内容自动生成结构化插画提示词，填充到输入框（可继续编辑，需手动点 Generate 生图） */
  const handleAutoPrompt = useCallback(async () => {
    if (promptLoading) return;
    setPromptLoading(true);
    setPromptError('');
    try {
      const resp = await fetch('/api/ai-generate/illust-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          answer,
          title: editable?.title,
          points: editable?.points,
          tags: editable?.tags,
          body: editable?.body,
          styleLabel: ILLUST_STYLES.find((s) => s.key === illustStyle)?.label ?? '',
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data?.success) {
        setPromptError(data?.error || 'Failed to generate prompt');
        return;
      }
      setIllustPrompt(data.prompt);
      setPromptError('');
    } catch {
      setPromptError('Failed to generate prompt (network)');
    } finally {
      setPromptLoading(false);
    }
  }, [promptLoading, question, answer, editable, illustStyle]);

  /** 输入文字修改当前 AI/上传图（i2i 编辑，走 /api/ai-edit/image） */
  const handleModify = useCallback(async () => {
    if (!illust || illustState === 'loading' || busy) return;
    const instruction = illustPrompt.trim();
    if (!instruction) return; // 需要输入修改指令
    setIllustState('loading');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const resp = await fetch('/api/ai-edit/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          image: illust,
          instruction,
          width: 2688,
          height: 2048,
          model: illustModel || undefined,
          provider: illustModels.find((m) => m.modelId === illustModel)?.provider || undefined,
        }),
      });
      clearTimeout(timer);
      const data = await resp.json();
      if (!resp.ok || !data?.success) {
        setIllustState('error');
        setIllustError(data?.error || 'Edit failed');
        return;
      }
      setIllust(data.image as string);
      setIllustState('done');
      setIllustError('');
    } catch {
      clearTimeout(timer);
      setIllustState('error');
      setIllustError('Edit failed (timeout or network)');
    }
  }, [illust, illustPrompt, illustState, busy, illustModel, illustModels]);

  /** 使用内置装饰：切到 Built-in 模式并换一张 */
  const handleUseBuiltin = useCallback(() => {
    setIllustMode('builtin');
    setDoodleIdx((i) => i + 1);
  }, []);

  /** 使用上传图片：打开本地文件选择器；选中后切 Upload 模式 */
  const handleUseUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** 读取用户上传的图片（dataURL），作为封面插图 */
  const handleFileChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setIllustError('图片过大（限 10MB）');
      setIllustState('error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setIllust(reader.result as string);
      setIllustMode('upload');
      setIllustError('');
      setIllustState('done');
    };
    reader.onerror = () => {
      setIllustError('读取图片失败');
      setIllustState('error');
    };
    reader.readAsDataURL(file);
  }, []);

  // 打开时加载自定义图库
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('/api/xhs-doodles');
        const data = await resp.json();
        if (!cancelled && data?.success && Array.isArray(data.items)) setCustomDoodles(data.items);
      } catch { /* 忽略 */ }
    })();
    return () => { cancelled = true; };
  }, [open]);

  /** 导入自定义图库图片（多选，单张 ≤2MB，上限 12 张） */
  const handleImportDoodles = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许重复选择同一文件
    if (!files.length) return;
    const room = Math.max(0, 12 - customDoodles.length);
    for (const file of files.slice(0, room)) {
      if (file.size > 2 * 1024 * 1024) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        (async () => {
          try {
            const resp = await fetch('/api/xhs-doodles', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dataUrl, name: file.name || 'custom.png' }),
            });
            const data = await resp.json();
            if (data?.success && data.name) {
              setCustomDoodles((prev) => (prev.length >= 12 ? prev : [...prev, { name: data.name, dataUrl }]));
            }
          } catch { /* 忽略单张失败 */ }
        })();
      };
      reader.readAsDataURL(file);
    }
  }, [customDoodles.length]);

  /** 删除自定义图库中的一张 */
  const handleDeleteDoodle = useCallback(async (name: string) => {
    try {
      await fetch('/api/xhs-doodles', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch { /* 忽略 */ }
    setCustomDoodles((prev) => prev.filter((d) => d.name !== name));
  }, []);

  /** 捕获指定页 PNG：页面节点本身是静态（width/height 定尺寸），直接序列化即可——
   *  不能把克隆体覆盖成 position:fixed/absolute 定位根节点，foreignObject 里 positioned 根节点不绘制，
   *  会导致整张图空白；页面真实 DOM 始终留在离屏 portal（fixed left:-9999），无闪烁。 */
  const capturePage = useCallback(async (i: number): Promise<string | null> => {
    const node = pageRefs.current[i];
    if (!node) return null;
    setStamp(new Date());
    await new Promise((r) => setTimeout(r, 80));
    await (document.fonts?.ready ?? Promise.resolve());
    return await toPng(node, {
      pixelRatio: EXPORT_RATIO,
      cacheBust: true,
      backgroundColor: paper.bg,
    });
  }, [paper]);

  /** 检查离屏页面节点是否溢出（scrollHeight > clientHeight），返回溢出的页码 */
  const checkOverflow = useCallback((): number[] => {
    const bad: number[] = [];
    for (let i = 0; i < total; i++) {
      const node = pageRefs.current[i];
      if (node && node.scrollHeight > node.clientHeight + 1) bad.push(i + 1);
    }
    return bad;
  }, [total]);

  /** 导出前自动检测溢出并提示（仅提示不阻断） */
  const warnOverflow = useCallback((): void => {
    const bad = checkOverflow();
    if (bad.length) {
      setOverflowMsg(`Content overflows on page ${bad.join(', ')} — reduce text or illustration`);
      window.setTimeout(() => setOverflowMsg(''), 5000);
    }
  }, [checkOverflow]);

  const handleCopy = useCallback(async (i: number) => {
    if (busy) return;
    warnOverflow();
    setBusy('copy');
    try {
      const dataUrl = await capturePage(i);
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setFlash('copy');
      setTimeout(() => setFlash(''), 1500);
    } catch (e) {
      console.warn('[XhsPanel] copy failed:', e);
    } finally {
      setBusy(null);
    }
  }, [busy, capturePage, warnOverflow]);

  const handleDownload = useCallback(async (i: number) => {
    if (busy) return;
    warnOverflow();
    setBusy('download');
    try {
      const dataUrl = await capturePage(i);
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = `bobwork-xhs-${i + 1}-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
      setFlash('download');
      setTimeout(() => setFlash(''), 1500);
    } catch (e) {
      console.warn('[XhsPanel] download failed:', e);
    } finally {
      setBusy(null);
    }
  }, [busy, capturePage, warnOverflow]);

  /** 收集所有页 dataUrl（离屏 portal 全部渲染） */
  const collectPageImages = useCallback(async (): Promise<Array<{ name: string; dataUrl: string }>> => {
    const images: Array<{ name: string; dataUrl: string }> = [];
    for (let i = 0; i < total; i++) {
      const dataUrl = await capturePage(i);
      if (dataUrl) images.push({ name: `bobwork-xhs-${i + 1}`, dataUrl });
    }
    return images;
  }, [total, capturePage]);

  /** 批量保存全部页（files=逐张写盘 / zip=打包） */
  const saveAllPages = useCallback(async (format: 'files' | 'zip') => {
    if (busy || total <= 1) return;
    warnOverflow();
    setBusy('all');
    try {
      const images = await collectPageImages();
      if (images.length === 0) return;
      // Electron 壳：走主进程批量保存（弹目录/保存对话框，主进程写盘——浏览器连续 <a download> 会被拦截只放行第一张）
      const api = (window as unknown as {
        api?: {
          saveImages?: (payload: { format?: 'files' | 'zip'; name?: string; images: Array<{ name: string; dataUrl: string }> }) =>
            Promise<{ success: boolean; dir?: string; path?: string; count?: number; format?: string; error?: string; canceled?: boolean }>;
        };
      }).api;
      if (api?.saveImages) {
        const res = await api.saveImages({ format, name: 'bobwork-xhs', images });
        if (res.success) {
          setFlash('download');
          setTimeout(() => setFlash(''), 1500);
        } else if (!res.canceled) {
          console.warn('[XhsPanel] saveImages failed:', res.error);
        }
        return;
      }
      // 纯浏览器回退：逐个触发下载（带间隔，尽力而为）
      for (const img of images) {
        const link = document.createElement('a');
        link.download = `${img.name}-${Date.now()}.png`;
        link.href = img.dataUrl;
        link.click();
        await new Promise((r) => setTimeout(r, 300));
      }
      setFlash('download');
      setTimeout(() => setFlash(''), 1500);
    } catch (e) {
      console.warn('[XhsPanel] download all failed:', e);
    } finally {
      setBusy(null);
    }
  }, [busy, total, collectPageImages, warnOverflow]);

  /** 批量下载（逐张保存到文件夹） */
  const handleDownloadAll = useCallback(() => saveAllPages('files'), [saveAllPages]);

  /** 批量下载（打包 zip） */
  const handleDownloadZip = useCallback(() => saveAllPages('zip'), [saveAllPages]);

  /** 重置为 Q+A 自动推导的内容 */
  const handleReset = useCallback(() => {
    setEditable(computeAuto(question, answer));
  }, [question, answer]);

  const updateEditable = useCallback((patch: Partial<EditableContent>) => {
    setEditable((v) => (v ? { ...v, ...patch } : v));
  }, []);

  const renderPageNode = (data: XhsPageData, i: number) => (
    <PageView
      key={i}
      data={data}
      idx={i + 1}
      total={total}
      theme={theme}
      paper={paper}
      illust={illust}
      illustState={illustState}
      illustMode={illustMode}
      doodleIdx={doodleIdx}
      illustError={illustError}
      title={editable?.title || question || 'AI 问答'}
      tags={editable?.tags ?? []}
      brush={brushVal}
      stamp={stamp}
      brandLogo={brandLogoSrc}
      customDoodles={customDoodles}
    />
  );

  return (
    <>
      {/* 离屏测量节点：与正文同宽同字重，用于分页高度判定 */}
      {mounted && (
        <div
          ref={measureRef}
          aria-hidden
          style={{
            position: 'fixed',
            left: -9999,
            top: 0,
            width: XHS_W - 2 * PAD,
            fontSize: '1rem',
            lineHeight: 1.8,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: FONT,
            visibility: 'hidden',
          }}
        />
      )}

      {/* 导出用页面（portal 到 body 离屏渲染，截图时通过 style 选项覆盖克隆体定位，真实节点始终留在屏幕外，无闪烁） */}
      {mounted &&
        createPortal(
          <div style={{ position: 'fixed', left: -9999, top: 0, zIndex: 2147483647 }} aria-hidden>
            {pages.map((p, i) => (
              <div
                key={i}
                ref={(el) => { pageRefs.current[i] = el; }}
                style={{ width: XHS_W, height: XHS_H }}
              >
                {renderPageNode(p, i)}
              </div>
            ))}
          </div>,
          document.body,
        )}

      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-[960px] max-h-[85vh] p-0 flex flex-col" showCloseButton={false}>
          <DialogHeader
            className="px-5 py-3 flex flex-row items-center justify-between gap-2 shrink-0"
            style={{ borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Sparkles className="h-4 w-4 flex-shrink-0" style={{ color: theme.brand }} />
              <DialogTitle className="text-sm font-semibold leading-none" style={{ color: 'var(--ink-strong)' }}>
                Post card · 3:4
              </DialogTitle>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {/* 全部页保存：双层页图标 + 页数角标（与单页 Save 区分）；右侧 chevron 融合进按钮内，展开 files/zip 选项 */}
              {total > 1 && (
                <div className="relative">
                  {/* 页数角标：悬浮于整个拆分按钮右上角 */}
                  <span
                    className="absolute -right-0.5 -top-0.5 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-9 font-bold"
                    style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
                  >
                    {total}
                  </span>
                  <div className="flex h-7 items-stretch overflow-hidden rounded-md border transition-colors hover:bg-black/5" style={{ borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}>
                    <button
                      type="button"
                      onClick={handleDownloadAll}
                      disabled={!!busy}
                      title={`Save all pages as files (${total})`}
                      className="flex h-7 w-6 items-center justify-center disabled:opacity-50"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      {busy === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : flash === 'download' ? <Check className="h-4 w-4" style={{ color: 'var(--primary)' }} /> : <Copy className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSaveMenuOpen((v) => !v)}
                      disabled={!!busy}
                      title="Save all options"
                      className="flex h-7 w-4 items-center justify-center border-l transition-colors disabled:opacity-50"
                      style={{ color: 'var(--ink-muted)', borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </div>
                  {saveMenuOpen && (
                    <div
                      className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border shadow-lg"
                      style={{ borderColor: 'color-mix(in oklab, var(--line) 60%, transparent)', backgroundColor: 'var(--panel-bg)' }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => { setSaveMenuOpen(false); handleDownloadAll(); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium transition-colors hover:bg-black/5"
                        style={{ color: 'var(--ink-strong)' }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Save as files
                      </button>
                      <button
                        type="button"
                        onClick={() => { setSaveMenuOpen(false); handleDownloadZip(); }}
                        className="flex w-full items-center gap-2 border-t px-3 py-2 text-xs font-medium transition-colors hover:bg-black/5"
                        style={{ color: 'var(--ink-strong)', borderColor: 'color-mix(in oklab, var(--line) 40%, transparent)' }}
                      >
                        <FileDown className="h-3.5 w-3.5" />
                        Save as ZIP
                      </button>
                    </div>
                  )}
                </div>
              )}
              {/* 单页保存：单页文档 + 下载 */}
              <Button
                type="button"
                onClick={() => handleDownload(pageIdx)}
                disabled={!!busy}
                variant="ghost"
                tone="neutral"
                size="icon"
                title="Save this page"
                aria-label="Save this page"
              >
                {busy === 'download' ? <Loader2 className="h-4 w-4 animate-spin" /> : flash === 'download' ? <Check className="h-4 w-4" /> : <FileDown className="h-4 w-4" />}
              </Button>
              {/* 复制当前页：主色强调 */}
              <Button
                type="button"
                onClick={() => handleCopy(pageIdx)}
                disabled={!!busy}
                variant="solid"
                tone="brand"
                size="icon"
                title="Copy this page"
                aria-label="Copy this page"
              >
                {busy === 'copy' ? <Loader2 className="h-4 w-4 animate-spin" /> : flash === 'copy' ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                onClick={onClose}
                variant="ghost"
                tone="neutral"
                size="icon-sm"
                className="flex-shrink-0"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </DialogHeader>
          <DialogDescription className="sr-only">3:4 vertical post card preview and export</DialogDescription>

          {/* 导出溢出自动提示（一次性，不阻断导出） */}
          {overflowMsg && (
            <div className="shrink-0 px-5 py-1.5 text-xs font-medium" style={{ backgroundColor: '#FFF7E6', color: '#B45309', borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}>
              {overflowMsg}
            </div>
          )}

          {/* 主体：左右布局（左编辑区 / 右预览区，无缝贴合由右栏 borderLeft 竖线分隔） */}
          <div className="flex flex-1 min-h-0">

            {/* 左侧编辑区：可滚动 + 标签页（横向排列，点击切换） */}
            <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-4 pt-2" style={{ backgroundColor: 'var(--paper-soft)' }}>
              <ConfigTabs active={activeTab} onSelect={setActiveTab} />

            {/* 主题色 */}
            {activeTab === 'style' && (
              <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                {XHS_THEMES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => persistTheme(t.key)}
                    title={t.label}
                    className="h-7 w-7 rounded-full transition-transform hover:scale-110"
                    style={{
                      backgroundColor: t.brand,
                      boxShadow: theme.key === t.key ? `0 0 0 2px var(--panel-bg), 0 0 0 4px ${t.brand}` : '0 1px 3px rgba(0,0,0,0.2)',
                    }}
                  />
                ))}
                <label
                  title="Custom color"
                  className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full"
                  style={{
                    border: '1px dashed color-mix(in oklab, var(--line) 70%, transparent)',
                    background: 'conic-gradient(#ff2442,#ff7a1a,#f59e0b,#00b87c,#3d8bff,#ff5c8a,#ff2442)',
                    boxShadow: theme.key === 'custom' ? `0 0 0 2px var(--panel-bg), 0 0 0 4px ${theme.brand}` : '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                >
                  <input
                    type="color"
                    value={theme.key === 'custom' ? theme.brand : '#FF2442'}
                    onChange={(e) => persistTheme(e.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              </div>

              {/* 纸张背景 */}
              <div className="flex items-center gap-2">
                {PAPER_STYLES.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => persistPaper(p.key)}
                    title={p.label}
                    className="relative h-14 w-10 shrink-0 overflow-hidden rounded-md transition-transform hover:scale-105"
                    style={{
                      backgroundColor: p.bg,
                      border: '1px solid var(--line)',
                      boxShadow: paper.key === p.key ? `0 0 0 2px var(--panel-bg), 0 0 0 4px var(--primary)` : undefined,
                    }}
                  >
                    {/* 迷你标题品牌条 + 文字行 + 插画条 */}
                    <div style={{ position: 'absolute', top: 4, left: 4, width: 14, height: 3, borderRadius: 999, backgroundColor: theme.brand }} />
                    <div style={{ position: 'absolute', top: 10, left: 4, right: 4, height: 2, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.10)' }} />
                    <div style={{ position: 'absolute', top: 14, left: 4, width: '70%', height: 2, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.10)' }} />
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 4,
                        left: 4,
                        right: 4,
                        height: '42%',
                        borderRadius: 4,
                        background: 'linear-gradient(135deg, #FFD9E3, #FFE0B8)',
                      }}
                    />
                  </button>
                ))}
              </div>

              {/* 标签笔刷样式（随 Style 页） */}
              <div>
                <div className="mb-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Tag brush</div>
                <div className="flex flex-wrap gap-1">
                  {BRUSH_STYLES.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => persistBrush(b.id)}
                      className="rounded-md border px-2 py-0.5 text-xs transition-colors"
                      style={{
                        borderColor: brushVal === b.id ? 'var(--primary)' : 'color-mix(in oklab, var(--line) 70%, transparent)',
                        color: brushVal === b.id ? 'var(--primary)' : 'var(--ink-muted)',
                        background: brushVal === b.id ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
                      }}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>
              </div>
            )}

            {/* 内容编辑：标题 / 要点 / 标签 / 正文（正文改动后自动重新分页） */}
            {activeTab === 'content' && (
              <div>
              <div className="mb-2 flex items-center justify-end">
                <Button
                  type="button"
                  onClick={handleReset}
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  title="Restore auto content"
                >
                  Reset
                </Button>
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={editable?.title ?? ''}
                  onChange={(e) => updateEditable({ title: e.target.value })}
                  placeholder="Cover title"
                  style={fieldStyle}
                />
                <div>
                  <div className="mb-1 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Tags (3)</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[0, 1, 2].map((i) => (
                      <input
                        key={i}
                        value={(editable?.tags ?? [])[i] ?? ''}
                        onChange={(e) => {
                          const tags = [...(editable?.tags ?? ['', '', ''])];
                          tags[i] = e.target.value;
                          updateEditable({ tags });
                        }}
                        placeholder={i === 0 ? 'Auto #1' : `Tag ${i + 1}`}
                        style={fieldStyle}
                      />
                    ))}
                  </div>
                </div>
                <textarea
                  rows={3}
                  value={editable?.points.join('\n') ?? ''}
                  onChange={(e) => updateEditable({ points: e.target.value.split('\n') })}
                  placeholder="Points (one per line)"
                  style={fieldStyle}
                />
                <textarea
                  rows={6}
                  value={editable?.body ?? ''}
                  onChange={(e) => updateEditable({ body: e.target.value })}
                  placeholder="Body text — editing re-paginates automatically"
                  style={fieldStyle}
                />
              </div>
              </div>
            )}

            {/* 封面插画：AI 生成 或 内置装饰，用户手动切换；AI 失败自动兜底内置 */}
            {activeTab === 'illust' && (
              <div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ backgroundColor: 'var(--paper-soft)' }}>
                  <button
                    type="button"
                    onClick={handleUseAi}
                    className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                    style={illustMode === 'ai' ? { backgroundColor: 'var(--primary)', color: '#fff' } : { color: 'var(--ink-muted)' }}
                  >
                    AI
                  </button>
                  <button
                    type="button"
                    onClick={handleUseBuiltin}
                    className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                    style={illustMode === 'builtin' ? { backgroundColor: 'var(--primary)', color: '#fff' } : { color: 'var(--ink-muted)' }}
                  >
                    Built-in
                  </button>
                  <button
                    type="button"
                    onClick={handleUseUpload}
                    className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                    style={illustMode === 'upload' ? { backgroundColor: 'var(--primary)', color: '#fff' } : { color: 'var(--ink-muted)' }}
                  >
                    Upload
                  </button>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  {illustState === 'error' && (
                    <span className="truncate text-xs" style={{ color: 'var(--danger)' }} title={illustError}>
                      {illustError}
                    </span>
                  )}
                  {illustMode === 'builtin' ? (
                    <button
                      type="button"
                      onClick={handleUseBuiltin}
                      title="Next doodle"
                      className="flex items-center gap-1 rounded-md p-1.5 text-xs font-medium transition-colors hover:bg-black/5"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      <Shuffle className="h-3.5 w-3.5" />
                      <span>Next</span>
                    </button>
                  ) : illustMode === 'upload' ? (
                    <button
                      type="button"
                      onClick={handleUseUpload}
                      title="Replace image"
                      className="flex items-center gap-1 rounded-md p-1.5 text-xs font-medium transition-colors hover:bg-black/5"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      <span>Replace</span>
                    </button>
                  ) : null}
                </div>
              </div>
              {/* 内置装饰库（仅 Built-in 模式）：图库网格选择 + 导入自定义 + 删除 */}
              {illustMode === 'builtin' && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Library</span>
                    <button
                      type="button"
                      onClick={() => doodleFileRef.current?.click()}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-black/5"
                      style={{ border: '1px solid color-mix(in oklab, var(--line) 70%, transparent)', color: 'var(--ink-muted)' }}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      <span>Import</span>
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {DOODLE_BODIES.map((_, i) => (
                      <button
                        key={`builtin-${i}`}
                        type="button"
                        onClick={() => setDoodleIdx(i)}
                        title={`Built-in ${i + 1}`}
                        className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-md transition-colors"
                        style={{
                          border: doodleIdx === i ? '2px solid var(--primary)' : '1px solid var(--line)',
                          backgroundColor: '#FFF8F3',
                        }}
                      >
                        <div style={{ width: 28, height: 21 }}>
                          <BuiltinDoodle index={i} />
                        </div>
                      </button>
                    ))}
                    {customDoodles.map((d, ci) => {
                      const idx = DOODLE_BODIES.length + ci;
                      return (
                        <div
                          key={d.name}
                          className="relative h-10 w-10 overflow-hidden rounded-md"
                          style={{ border: doodleIdx === idx ? '2px solid var(--primary)' : '1px solid var(--line)' }}
                        >
                          <button
                            type="button"
                            onClick={() => setDoodleIdx(idx)}
                            title={d.name}
                            className="h-full w-full"
                          >
                            <img src={d.dataUrl} alt="" className="h-full w-full object-cover" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteDoodle(d.name)}
                            title="Remove"
                            className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl-md hover:bg-black/20"
                            style={{ backgroundColor: 'rgba(0,0,0,0.45)', color: '#fff' }}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {/* 自定义图库文件选择器（隐藏，多选） */}
                  <input
                    ref={doodleFileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleImportDoodles}
                    style={{ display: 'none' }}
                  />
                </div>
              )}
              {/* AI 风格/模型下拉 + 自定义提示词（仅 AI 模式） */}
              {illustMode === 'ai' && (
                <div className="mt-3">
                  <div className="flex items-center gap-2">
                    <select
                      value={illustStyle}
                      onChange={(e) => handlePickStyle(e.target.value)}
                      className="w-full"
                      style={{ ...fieldStyle, padding: '5px 8px', fontSize: '0.8rem' }}
                    >
                      {ILLUST_STYLES.map((s) => (
                        <option key={s.key} value={s.key}>{s.label}</option>
                      ))}
                    </select>
                    {illustModels.length > 0 && (
                      <select
                        value={illustModel}
                        onChange={(e) => handlePickModel(e.target.value)}
                        className="w-full"
                        style={{ ...fieldStyle, padding: '5px 8px', fontSize: '0.8rem' }}
                      >
                        {illustModels.map((m) => (
                          <option key={m.modelId} value={m.modelId}>{m.modelId}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      type="button"
                      onClick={handleAutoPrompt}
                      disabled={promptLoading}
                      loading={promptLoading}
                      variant="outline"
                      tone="brand"
                      size="sm"
                      className="shrink-0"
                      title="Auto-generate a structured illustration prompt from the card content"
                    >
                      {promptLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                      <span>Auto</span>
                    </Button>
                    <input
                      value={illustPrompt}
                      onChange={(e) => setIllustPrompt(e.target.value)}
                      placeholder={illust ? 'Describe the change…' : 'Custom prompt (optional) — uses the question if empty'}
                      style={{ ...fieldStyle, flex: 1 }}
                      onKeyDown={(e) => {
                         if (e.key === 'Enter' && !e.shiftKey && illustState !== 'loading') {
                           e.preventDefault();
                           if (illust) handleModify(); else genIllust();
                         }
                       }}
                    />
                    <Button
                      type="button"
                      onClick={illust ? handleModify : genIllust}
                      disabled={illustState === 'loading'}
                      loading={illustState === 'loading'}
                      variant="solid"
                      tone="brand"
                      size="sm"
                      className="shrink-0"
                    >
                      {illustState === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      <span>{illustState === 'loading' ? 'Working…' : illust ? 'Modify' : 'Generate'}</span>
                    </Button>
                    {illust && (
                      <Button
                        type="button"
                        onClick={genIllust}
                        disabled={illustState === 'loading'}
                        variant="outline"
                        tone="brand"
                        size="sm"
                        className="shrink-0"
                        title="Generate a brand new image"
                      >
                        New
                      </Button>
                    )}
                  </div>
                  {promptError && (
                    <div className="mt-1 text-11" style={{ color: '#e5484d' }}>{promptError}</div>
                  )}
                </div>
              )}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            </div>

            {/* 右侧预览区：固定宽度，垂直居中展示当前页 */}
            <div className="flex w-[360px] shrink-0 flex-col items-center justify-center overflow-y-auto px-4 py-4" style={{ backgroundColor: 'var(--panel-bg)', borderLeft: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}>
              <div
                style={{
                  width: PREVIEW_W,
                  height: XHS_H * PREVIEW_SCALE,
                  overflow: 'hidden',
                  borderRadius: 16,
                  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.10)',
                }}
              >
                <div style={{ width: XHS_W, height: XHS_H, transform: `scale(${PREVIEW_SCALE})`, transformOrigin: 'top left' }}>
                  {pages[pageIdx] ? renderPageNode(pages[pageIdx], pageIdx) : null}
                </div>
              </div>
              {/* 翻页（多页时） */}
              {total > 1 && (
                <div className="mt-3 flex items-center justify-center gap-3">
                  <Button
                    type="button"
                    onClick={() => setPageIdx((v) => Math.max(0, v - 1))}
                    disabled={pageIdx === 0}
                    variant="ghost"
                    tone="neutral"
                    size="icon-sm"
                    title="Previous page"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                    {pageIdx + 1} / {total}
                  </span>
                  <Button
                    type="button"
                    onClick={() => setPageIdx((v) => Math.min(total - 1, v + 1))}
                    disabled={pageIdx >= total - 1}
                    variant="ghost"
                    tone="neutral"
                    size="icon-sm"
                    title="Next page"
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
