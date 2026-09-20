/**
 * 微博 target —— DocIR → 微博文案（≤140 字钩子 + 自动 `#话题#`）与方形配图几何。
 *
 * 硬约束（方案 §5.4）：
 * - 信息流按 4:3 / 1:1 裁切，**3:4 竖图两边会被裁** → 微博用独立方形模板，不复用小红书卡片；
 * - 文案降级形态：`hook` + `stats` + 首 1–2 段 → 压到 **≤140 字**；
 * - `#话题#` 从标题/关键词抽取（复用 keywords.ts 的关键词表，与小红书同源）；
 * - 图片上限 9 张；完整内容走"头条文章"（正文上限按 2000 字体检）。
 *
 * 卡片渲染在 components/canvas/WeiboDialog.tsx，这里只放「平台规则 + 几何 + 文案序列化」。
 */

import type { DocBlock, DocIR } from '../ir';
import { inlineText } from '../ir';
import { extractTopics } from '../keywords';
import type { ExportArtifact, PlatformSpec } from '../types';

/** 微博平台约束：正文 2000 字、图 ≤9 张；信息流安全比例 4:3 / 1:1；不支持代码高亮 */
export const WEIBO_SPEC: PlatformSpec = {
  id: 'weibo',
  label: 'Weibo',
  limits: {
    // 微博无标题字段（首句即钩子），故不设 titleMax
    bodyMax: 2000,
    imageMax: 9,
    ratios: ['4:3', '1:1'],
    unsupported: ['code'],
  },
  formats: ['text', 'png'],
};

/** 钩子文案上限（微博正文 140 字，超出须走头条文章） */
export const WEIBO_HOOK_MAX = 140;

/** 文案里最多带几条关键数字 / 首几段正文 */
const STATS_MAX = 3;
const PARA_MAX = 2;

/** ir.hook 缺失时的兜底截断长度（与 ir.ts 的 HOOK_MAX 一致） */
const HOOK_FALLBACK_MAX = 40;

/**
 * 方形模板几何：设计宽 420，导出 pixelRatio 3 → 1260px 宽。
 * 两个规格都落在信息流安全比例内；规格只影响容器尺寸与字号刻度。
 */
export const WEIBO_SIZES = {
  '1:1': { w: 420, h: 420, pad: 26, scale: 1, hookLines: 3, paras: 2, paraLines: 2 },
  '4:3': { w: 420, h: 315, pad: 22, scale: 0.9, hookLines: 2, paras: 1, paraLines: 3 },
} as const;

export type WeiboSizeKey = keyof typeof WEIBO_SIZES;

export const WEIBO_EXPORT_RATIO = 3;

// ---------------------------------------------------------------------------
// 内容抽取
// ---------------------------------------------------------------------------

export interface WeiboCardContent {
  title: string;
  /** 封面钩子（≤40 字） */
  hook: string;
  /** 关键数字（最多 3 条，已带单位） */
  stats: string[];
  /** 首 1–2 段（已剔除与 hook 重复的首段） */
  paras: string[];
}

/** 段落纯文本（引用块递归展开，按文档顺序） */
function collectParas(blocks: DocBlock[], out: string[]): void {
  for (const b of blocks) {
    if (b.t === 'paragraph') {
      const text = inlineText(b.inline).replace(/\s+/g, ' ').trim();
      if (text) out.push(text);
    } else if (b.t === 'quote') {
      collectParas(b.blocks, out);
    }
  }
}

/** 断句点（优先在这些字符后收尾，避免只剩半句话） */
const BREAK_AFTER = '。！？；，、\n';

/** 截断到 max 字：优先在断句点收尾，断点过于靠前则硬截 */
function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/[ \t]+/g, ' ').trim();
  if (t.length <= max) return t;
  const win = t.slice(0, Math.max(1, max - 1));
  let cut = -1;
  for (let i = win.length - 1; i >= 0; i--) {
    if (BREAK_AFTER.includes(win[i])) {
      cut = i;
      break;
    }
  }
  const body = cut >= Math.floor(max / 2) ? win.slice(0, cut + 1) : win;
  return `${body.replace(/[\s，、]+$/, '')}…`;
}

/** 封面/方形卡所需内容：标题 + 钩子 + 关键数字 + 首 1–2 段 */
export function weiboCardContent(ir: DocIR): WeiboCardContent {
  const all: string[] = [];
  collectParas(ir.blocks ?? [], all);
  const hook = ir.hook || (all[0] ? clip(all[0], HOOK_FALLBACK_MAX) : '');
  // hook 本身由首段截断而来（ir.pickHook）→ 前缀命中的段落即为同源，跳过避免重复
  const rest = all.filter((p) => !(hook && p.startsWith(hook)));
  return {
    title: (ir.title ?? '').trim(),
    hook,
    stats: (ir.stats ?? []).slice(0, STATS_MAX),
    paras: rest.slice(0, PARA_MAX),
  };
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/** 微博文案产物：`text` 可直接发布（正文 + `#话题#`），hook/topics 供预览与计数 */
export type WeiboPost = Extract<ExportArtifact, { kind: 'text' }> & {
  /** ≤140 字正文（不含话题） */
  hook: string;
  /** 自动生成的话题标签（不含 `#`） */
  topics: string[];
};

/**
 * DocIR → 微博文案：`hook` + `stats` + 首 1–2 段 压到 ≤140 字，尾部拼 `#话题#`。
 * 超长内容不丢：正文上限内的完整内容仍需走"头条文章"（由体检提示）。
 */
export function renderWeiboSummary(ir: DocIR): WeiboPost {
  const c = weiboCardContent(ir);
  const statsLine = c.stats.length ? `关键数据：${c.stats.join(' / ')}` : '';
  const body = clip([c.hook, statsLine, ...c.paras].filter(Boolean).join('\n'), WEIBO_HOOK_MAX);
  const topics = extractTopics([c.title, c.hook, ...c.paras].join(' '));
  const text = [body, topics.map((t) => `#${t}#`).join(' ')].filter(Boolean).join('\n');
  return { kind: 'text', text, hook: body, topics };
}
