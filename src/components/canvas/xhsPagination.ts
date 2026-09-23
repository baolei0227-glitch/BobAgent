/**
 * 小红书卡片内容分页（纯函数，从 XhsCard.tsx 抽离，T2-1 / Phase A 式零行为变更迁移）
 *  - mdToLines / extractCoverItems：Markdown → 卡片行 / 封面要点
 *  - splitBodyToBlocks：正文 → 语义块（标题 / 列表整组 / 段落 / 表格原子块）
 *  - paginateBlocks：块级分页（语义块边界，方案 §7.2）——measure 回调由调用方注入，
 *    生产环境为离屏 DOM 测量，单测注入纯函数即可
 */
/** Markdown → 卡片文本行。
 *  keepHeadings=false（封面要点用）：标题剥掉 `#`，只留文字；
 *  keepHeadings=true（正文用）：保留 `#` 语义标记，分页时据此做「标题与后块同页」。 */
export function mdToLines(md: string, keepHeadings = false): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const heading = keepHeadings ? /^\s*(#{1,6})\s+/.exec(raw) : null;
    let s = raw
      .replace(/^\s*(#{1,6})\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '• ')
      .replace(/^\s*(\d+)[.、)]\s+/, '$1. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      // 图片必须先于链接处理：否则 ![alt](url) 的 [alt](url) 部分先被链接规则替换，图片残留 '!'（T2-1 测试发现）
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // 带尺寸的图片在分享卡里是 <img … width> 形式（见 ShareCard 的 ShareImage 序列化），一并忽略
      .replace(/<img\b[^>]*>/gi, '')
      .trim();
    if (heading && s) s = `${heading[1]} ${s}`;
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
export function extractCoverItems(lines: string[]): string[] | null {
  const items: string[] = [];
  for (const l of lines) {
    const m = /^(?:(\d+)[.、)]|[①②③④⑤]|•)\s*(.*)$/.exec(l);
    if (m && m[2].trim()) {
      if (items.length < 3) items.push(m[2].trim());
    } else if (items.length > 0) break;
  }
  return items.length >= 2 ? items : null;
}

/** 正文页块（语义块 = 分页最小单位，块内不拆）：
 *  text 段落 / heading 标题 / list 列表（整组）/ table 表格（整块） */
export type XhsBodyBlock =
  | { kind: 'text'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] };

/** 块的展示文本：渲染与测高共用同一份，保证「测出来的高度」= 「渲染出来的高度」 */
export function blockText(b: XhsBodyBlock): string {
  if (b.kind === 'table') return '';
  if (b.kind === 'list') return b.items.map((it) => `• ${it}`).join('\n');
  return b.text;
}

export interface XhsPageData {
  kind: 'cover' | 'content';
  mode?: 'points' | 'intro';
  /** cover 页的封面要点行 */
  lines: string[];
  /** content 页的正文块列表（文本段 / 表格） */
  blocks?: XhsBodyBlock[];
}

/** 二分查找：text 前缀在剩余空间内能容纳的最大长度，并回退到句末标点避免句中切断 */
export function fitPrefix(text: string, space: number, measure: (t: string) => number): string {
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
export function parseMdTable(lines: string[]): { header: string[]; rows: string[][] } | null {
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

export const isPipeRow = (line: string) => {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|');
};

/** 保留语义标记的标题行（正文里 `## 标题`） */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/** 列表项行（mdToLines 已把 -/*/+/1. 统一为 `• `） */
const BULLET_RE = /^•\s?(.*)$/;

/** 把正文文本解析为顺序的语义块：标题 / 列表整组 / 段落 / 表格原子块 */
export function splitBodyToBlocks(body: string): XhsBodyBlock[] {
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
    const h = HEADING_RE.exec(raw.trim());
    if (h) {
      flushText();
      out.push({ kind: 'heading', text: h[2].trim() });
      i++;
      continue;
    }
    if (BULLET_RE.test(raw.trim())) {
      flushText();
      const items: string[] = [];
      while (i < lines.length && BULLET_RE.test(lines[i].trim())) {
        items.push(BULLET_RE.exec(lines[i].trim())![1].trim());
        i++;
      }
      out.push({ kind: 'list', items });
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

/** 块级分页（语义块边界，见方案 §7.2）：
 *  - 语义块为最小单位，块内不拆；剩余空间不足整块下移；
 *  - 标题与其后首个块必须同页（放不下则整组下移）；
 *  - table / list 整块不跨页；
 *  - 仅当单块自身超高时，才回退到 fitPrefix 行内切（保留兜底）。 */
export function paginateBlocks(
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
  const heightOf = (b: XhsBodyBlock) =>
    b.kind === 'table' ? measureTable(b.header, b.rows) : measureText(blockText(b));

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    // 标题 keep-with-next：与其后首个块同页，放不下整组下移（连续标题逐个链式判断）
    if (b.kind === 'heading' && i + 1 < blocks.length) {
      const need = heightOf(b) + heightOf(blocks[i + 1]);
      if (cur.length && curH + need > cap) flush();
    }

    const h = heightOf(b);
    if (b.kind === 'table') {
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

    if (h <= cap) {
      if (cur.length && curH + h > cap) flush();
      cur.push(b);
      curH += h;
      continue;
    }
    // 单块自身超高 → 按行切分（保留旧兜底）
    for (const line of blockText(b).split('\n')) {
      const lh = measureText(line);
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
