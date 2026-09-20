/**
 * 平台约束体检（见《md阅读器多端分发方案》§6）。
 *
 * 导出前对 DocIR × PlatformSpec 做一次静态体检：字数/图片数超限记 fail，
 * 平台不支持的块类型与排版噪音记 warn。**仅提示不硬阻断**——与既有的卡片溢出提示策略一致。
 *
 * 阈值全部来自 PlatformSpec.limits（不硬编码平台规则），改规则只改 target 的 spec。
 */

import type { DocBlock, DocIR } from './ir';
import { inlineText } from './ir';
import type { PlatformSpec } from './types';

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface CheckItem {
  key: string;
  level: CheckLevel;
  msg: string;
  /** 可操作建议 */
  fix?: string;
}

/** 手机端一屏约 5 行（15–16px 正文约 22 字/行）→ 单段超过该字数视为大段文字 */
export const PARA_CHAR_WARN = 110;
/** 超短段（不足 12 字）占比超过该阈值 → 排版噪音 */
const SHORT_PARA_RATIO = 0.4;
const SHORT_PARA_CHARS = 12;

/** 正文里 `<table>` 超过该列数在移动端会被压缩到不可读（建议转图） */
const TABLE_COL_WARN = 4;

interface DocStats {
  chars: number;
  images: number;
  hasCode: boolean;
  maxTableCols: number;
  /** 段落纯文本（含引用内段落） */
  paras: string[];
}

function blockChars(b: DocBlock): number {
  switch (b.t) {
    case 'heading':
      return b.text.length;
    case 'paragraph':
      return inlineText(b.inline).length;
    case 'list':
      return b.items.reduce((n, it) => n + inlineText(it).length, 0);
    case 'quote':
      return b.blocks.reduce((n, x) => n + blockChars(x), 0);
    case 'table':
      return [...b.header, ...b.rows.flat()].reduce((n, c) => n + c.length, 0);
    case 'code':
      return b.lines.reduce((n, l) => n + l.length, 0);
    case 'image':
      return b.alt.length;
    case 'hr':
      return 0;
  }
}

/** 段落文本收集：引用块递归展开，标题/表格/代码不计入段落统计 */
function collectParas(b: DocBlock, out: string[]): void {
  if (b.t === 'paragraph') out.push(inlineText(b.inline).replace(/\s+/g, ' ').trim());
  else if (b.t === 'quote') b.blocks.forEach((x) => collectParas(x, out));
}

function collectStats(ir: DocIR): DocStats {
  const blocks = ir.blocks ?? [];
  const paras: string[] = [];
  let chars = 0;
  let images = 0;
  let hasCode = false;
  let maxTableCols = 0;
  for (const b of blocks) {
    chars += blockChars(b);
    if (b.t === 'image') images++;
    if (b.t === 'code') hasCode = true;
    if (b.t === 'table') maxTableCols = Math.max(maxTableCols, b.header.length);
    collectParas(b, paras);
  }
  return { chars, images, hasCode, maxTableCols, paras: paras.filter(Boolean) };
}

/**
 * 体检：返回全部检查项（pass 项也返回，便于面板展示"通过 N 项"）。
 * 规则顺序与方案 §6 表格一致。
 */
export function checkDoc(ir: DocIR, spec: PlatformSpec): CheckItem[] {
  const items: CheckItem[] = [];
  const { limits } = spec;
  const stats = collectStats(ir);

  // 标题长度
  if (limits.titleMax != null) {
    const max = limits.titleMax;
    const len = (ir.title ?? '').length;
    if (len > max) {
      items.push({
        key: 'title',
        level: 'fail',
        msg: `标题 ${len} 字，超出 ${max} 字上限（${spec.label} 会截断）`,
        fix: `把标题压到 ${max} 字以内，长尾信息移到首段`,
      });
    } else {
      items.push({ key: 'title', level: 'pass', msg: `标题长度 ${len}/${max} 字` });
    }
  }

  // 正文总量
  if (limits.bodyMax != null) {
    const max = limits.bodyMax;
    if (stats.chars > max) {
      items.push({
        key: 'body',
        level: 'fail',
        msg: `正文约 ${stats.chars} 字，超出 ${max} 字上限`,
        fix: '拆成多篇，或删减次要段落',
      });
    } else {
      items.push({ key: 'body', level: 'pass', msg: `正文约 ${stats.chars}/${max} 字` });
    }
  }

  // 图片数量
  if (limits.imageMax != null) {
    if (stats.images > limits.imageMax) {
      items.push({
        key: 'image',
        level: 'fail',
        msg: `图片 ${stats.images} 张，超出 ${limits.imageMax} 张上限`,
        fix: '合并或删除部分配图',
      });
    } else {
      items.push({ key: 'image', level: 'pass', msg: `图片 ${stats.images}/${limits.imageMax} 张` });
    }
  }
  if (limits.imageMin != null && stats.images < limits.imageMin) {
    items.push({
      key: 'image-min',
      level: 'fail',
      msg: `图片 ${stats.images} 张，少于要求的 ${limits.imageMin} 张`,
      fix: '至少补一张配图再导出',
    });
  }

  // 平台不支持的块类型（渲染端已有降级策略，这里只提示）
  const unsupported = limits.unsupported ?? [];
  if (unsupported.includes('table') && stats.maxTableCols > 0) {
    items.push({
      key: 'unsupported-table',
      level: 'warn',
      msg: '该平台不直接支持表格，导出时会降级为纯文本键值行',
      fix: '列数较多时建议截图转成图片',
    });
  } else if (stats.maxTableCols > TABLE_COL_WARN) {
    items.push({
      key: 'wide-table',
      level: 'warn',
      msg: `表格有 ${stats.maxTableCols} 列，手机上会被压缩到难读`,
      fix: '精简到 4 列以内，或把表格转成图片',
    });
  }
  if (unsupported.includes('code') && stats.hasCode) {
    items.push({
      key: 'unsupported-code',
      level: 'warn',
      msg: '该平台不支持代码高亮，导出时会折叠为灰底说明',
      fix: '关键代码可改写为步骤说明',
    });
  }

  // 大段文字
  const longParas = stats.paras.filter((p) => p.length > PARA_CHAR_WARN);
  if (longParas.length) {
    items.push({
      key: 'long-paragraph',
      level: 'warn',
      msg: `${longParas.length} 段超过 ${PARA_CHAR_WARN} 字（手机端约 5 行）`,
      fix: '按语义拆成更短的段落，阅读节奏更好',
    });
  }

  // 排版噪音：超短段占比过高
  if (stats.paras.length >= 3) {
    const short = stats.paras.filter((p) => p.length < SHORT_PARA_CHARS).length;
    if (short / stats.paras.length > SHORT_PARA_RATIO) {
      items.push({
        key: 'short-paragraph',
        level: 'warn',
        msg: `${short}/${stats.paras.length} 段过短（不足 ${SHORT_PARA_CHARS} 字），排版偏碎`,
        fix: '把零碎行合并成完整段落',
      });
    }
  }

  return items;
}

/** 体检汇总：fail/warn 计数（面板标题用） */
export function summarizeChecks(items: CheckItem[]): { fail: number; warn: number; pass: number } {
  return {
    fail: items.filter((i) => i.level === 'fail').length,
    warn: items.filter((i) => i.level === 'warn').length,
    pass: items.filter((i) => i.level === 'pass').length,
  };
}
