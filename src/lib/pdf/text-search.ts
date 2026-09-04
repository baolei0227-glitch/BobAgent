/**
 * PDF 预览内关键词检索的纯函数集（无外部依赖，供 PdfViewer 与单元测试共用）
 *
 * 两类数据源：
 * - 原生文本层：pdfjs 的 getTextContent() 返回的文字块 → 构建页文本 + 字符偏移映射 →
 *   关键词命中的字符区间回投到页面归一化矩形（0~1），复用批注层的绘制管线做高亮
 * - OCR 文本：页级纯文本（带 [Page N] 或 pages[].index 结构）→ 仅支持页级定位；
 *   本地 Vision 引擎附带行级坐标骨架（pages[].blocks）时同样支持精确高亮：
 *   从 blocks 自建检索文本（与坐标同源，天然对齐），命中区间按字符长度比例切分行框
 */

/** pdfjs TextItem 的几何信息子集 */
export interface TextItemGeom {
  /** 文字内容 */
  str: string;
  /** PDF 用户空间变换矩阵（getTextContent 返回的 transform） */
  transform: number[];
  /** 该文字块在用户空间的宽度 */
  width: number;
  /** 该文字块在用户空间的高度 */
  height: number;
}

/** 视口信息：transform 为 pdfjs viewport.transform，w/h 为 CSS 像素尺寸，scale 为渲染缩放 */
export interface ViewportMeta {
  transform: number[];
  scale: number;
  w: number;
  h: number;
}

/** 页面归一化坐标矩形（0~1 相对页面宽高），与 PdfViewer 批注坐标系一致 */
export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 单条搜索命中 */
export interface SearchHit {
  /** 页码（1-based） */
  page: number;
  /** 高亮矩形；OCR 页级命中时为空数组 */
  rects: HitRect[];
  /** 命中处上下文摘录（供侧栏列表展示） */
  context: string;
  /** 长上下文摘录（侧栏 hover 预览；含命中词在摘录内的精确定位） */
  excerpt?: HitExcerpt;
  /** 精确匹配下标：全局倒序 array 中从起点计（native），ocr 为 -1 */
  matchPos: number;
  matchLen: number;
}

/** 带命中定位的摘录文本 */
export interface HitExcerpt {
  /** 摘录全文（连续空白折叠为单空格，截断处以 … 标注） */
  text: string;
  /** 命中词起止下标（不含）：slice(matchStart, matchEnd) 即命中词 */
  matchStart: number;
  matchEnd: number;
}

interface CharSegment {
  /** 在拼接文本中的起始偏移 */
  start: number;
  /** 结束偏移（不含） */
  end: number;
  itemIdx: number;
}

/** 一页的文本索引：拼接文本 + 每个文字块的字符区间 */
export interface PageTextIndexEntry {
  text: string;
  segments: CharSegment[];
  items: TextItemGeom[];
}

function concatTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * 将一页的 getTextContent 输出构建成可检索文本。
 * 直接拼接各文字块（不加分隔符）：中文场景天然连续；
 * 若文字块自带前后空格会原样保留，搜索时大小写不敏感。
 */
export function buildPageText(items: TextItemGeom[]): PageTextIndexEntry {
  let text = '';
  const segments: CharSegment[] = [];
  const valid: TextItemGeom[] = [];
  for (const it of items || []) {
    const s = typeof it.str === 'string' ? it.str : '';
    if (!s) continue;
    segments.push({ start: text.length, end: text.length + s.length, itemIdx: valid.length });
    text += s;
    valid.push(it);
  }
  return { text, segments, items: valid };
}

/** 大小写不敏感地找出全部匹配区间 [start, end) */
export function findMatches(text: string, query: string, maxHits = 999): Array<[number, number]> {
  const q = query.trim();
  if (!q) return [];
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: Array<[number, number]> = [];
  let from = 0;
  while (out.length < maxHits) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    out.push([idx, idx + needle.length]);
    from = idx + needle.length;
  }
  return out;
}

/** 计算单个文字块在视口中的归一化基线框（left/top/width/fontHeight，CSS 像素） */
function itemViewportBox(item: TextItemGeom, vp: ViewportMeta) {
  const tx = concatTransform(vp.transform, item.transform);
  const fontHeight = Math.hypot(tx[2], tx[3]);
  const left = tx[4];
  const top = tx[5] - fontHeight;
  const width = item.width * vp.scale;
  return { left, top, width, fontHeight };
}

/**
 * 把一个命中的字符区间展开为若干「文字块内片段」，再换算成归一化矩形。
 * 同一行上相邻片段（top 接近）合并为一个矩形，避免高亮碎裂。
 */
export function matchToRects(
  entry: PageTextIndexEntry,
  start: number,
  end: number,
  vp: ViewportMeta,
): HitRect[] {
  if (!vp.w || !vp.h) return [];
  const frags = entry.segments
    .map((seg) => {
      const s = Math.max(seg.start, start);
      const e = Math.min(seg.end, end);
      return { seg, s, e };
    })
    .filter((f) => f.e > f.s);
  if (frags.length === 0) return [];

  const boxes = frags.map(({ seg, s, e }) => {
    const item = entry.items[seg.itemIdx];
    const box = itemViewportBox(item, vp);
    const len = e - s;
    const ratio = len / Math.max(1, seg.end - seg.start);
    const offsetRatio = (s - seg.start) / Math.max(1, seg.end - seg.start);
    return {
      left: box.left + box.width * offsetRatio,
      top: box.top,
      // 最小可视宽度随视口尺度走（约 0.3% 页宽）：防零宽退化，
      // 又不会在大视口下无形放大（600px 页 ≈ 1.8px），单位视口（OCR 骨架）下为 0.003
      w: Math.max(box.width * ratio, vp.w * 0.003),
      h: Math.max(box.fontHeight, vp.h * 0.003),
    };
  });

  // 合并同行相邻片段（top 差小于半行高视为同一行）
  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: Array<typeof boxes[number]> = [];
  for (const b of boxes) {
    const last = merged[merged.length - 1];
    const mergeTol = last ? Math.max(last.h, b.h) * 1.2 : 0;
    if (last && Math.abs(last.top - b.top) < mergeTol && b.left - (last.left + last.w) < mergeTol) {
      const right = Math.max(last.left + last.w, b.left + b.w);
      const bottom = Math.max(last.top + last.h, b.top + b.h);
      last.h = bottom - last.top;
      last.w = right - last.left;
      last.left = Math.min(last.left, b.left);
      continue;
    }
    merged.push({ ...b });
  }

  // 与页面边界求交（避免高亮溢出纸面），退化到不可见的片段直接丢弃
  return merged
    .map((b) => {
      const left = clamp01(b.left / vp.w);
      const top = clamp01(b.top / vp.h);
      const right = Math.min(1, (b.left + b.w) / vp.w);
      const bottom = Math.min(1, (b.top + b.h) / vp.h);
      return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
    })
    .filter((r) => r.w > 0.001 && r.h > 0.001);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 截取命中处上下文摘录（两侧各 pad 字符，省略号标注截断） */
export function contextAround(text: string, start: number, end: number, pad = 28): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, end + pad);
  const head = s > 0 ? '…' : '';
  const tail = e < text.length ? '…' : '';
  return `${head}${text.slice(s, e).replace(/\s+/g, ' ').trim()}${tail}`;
}

/** hover 长预览摘录的单侧字符数 */
export const EXCERPT_PAD = 160;

/**
 * 截取带命中定位的长摘录：逻辑同 contextAround，但额外保留命中词在输出文本中的
 * 精确区间，供 hover 预览加粗高亮。逐字折叠空白（连续空白→单空格）并同步平移下标，
 * 行首/行尾空白自然被吞掉，不依赖 trim 以免二次偏移。
 */
export function excerptAround(text: string, start: number, end: number, pad = EXCERPT_PAD): HitExcerpt {
  const from = Math.max(0, start - pad);
  const to = Math.min(text.length, end + pad);
  let out = '';
  let pendingWs = false;
  let ms = -1;
  let me = -1;
  for (let i = from; i < to; i++) {
    if (/\s/.test(text[i])) { pendingWs = true; continue; }
    if (pendingWs && out) out += ' ';
    pendingWs = false;
    if (i === start) ms = out.length;
    if (i === end - 1) me = out.length + 1;
    out += text[i];
  }
  const head = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  return {
    text: `${head}${out}${tail}`,
    matchStart: head.length + Math.max(ms, 0),
    matchEnd: head.length + (me > 0 ? me : out.length),
  };
}

/**
 * 全文搜索原生文本索引，返回带高亮矩形的命中列表。
 *
 * rect 用每个字段的 scale=1 视口计算：归一化坐标对均匀缩放不变，
 * 因此组件在任意缩放档位都能直接复用这些矩形（与批注层同一坐标系）。
 */
export function searchPageIndexes(
  entries: PageTextIndexEntry[],
  query: string,
  opts?: {
    /** 与 entries 一一对应的 scale=1 视口信息；缺省则只做页级命中 */
    viewports?: Array<ViewportMeta | undefined>;
    maxHitsPerPage?: number;
    totalHitsLimit?: number;
  },
): SearchHit[] {
  const maxPer = opts?.maxHitsPerPage ?? 100;
  const totalLimit = opts?.totalHitsLimit ?? 999;
  const vps = opts?.viewports;
  const hits: SearchHit[] = [];
  for (let pi = 0; pi < entries.length && hits.length < totalLimit; pi++) {
    const entry = entries[pi];
    if (!entry) continue;
    const matches = findMatches(entry.text, query, maxPer);
    if (matches.length === 0) continue;
    const vp = vps?.[pi];
    for (const [s, e] of matches) {
      const rects = vp ? matchToRects(entry, s, e, vp) : [];
      hits.push({
        page: pi + 1,
        rects,
        context: contextAround(entry.text, s, e),
        excerpt: excerptAround(entry.text, s, e),
        matchPos: s,
        matchLen: e - s,
      });
    }
  }
  return hits.slice(0, totalLimit);
}

/**
 * 判断是否缺少可用文本层（典型：扫描件）。阈值经验值：平均每页低于 8 个可视字符
 * 即认为文本层无效（生成器常会埋空白字符或页眉水印）。
 */
export function looksLikeScannedPdf(entries: Array<Pick<PageTextIndexEntry, 'text'>>, minAvgChars = 8): boolean {
  const total = entries.reduce((sum, e) => sum + e.text.replace(/\s/g, '').length, 0);
  const pages = Math.max(1, entries.length);
  return total < pages * minAvgChars;
}

/** bob-ocr-mcp 本地 Vision 引擎输出的行级几何骨架（归一化 0~1，左下原点 y 向上） */
export interface OcrBlockGeom {
  text: string;
  confidence?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** OCR 页级检索条目；blocks 存在时可计算命中高亮矩形 */
export interface OcrPageText {
  page: number;
  text: string;
  blocks?: OcrBlockGeom[];
}

/**
 * 将 OCR 行级骨架构建为可检索索引。
 * 检索文本直接从 blocks 拼接（与坐标同源 → 命中区间永远能正确回投），
 * 不消费替换过的 page.text（区域级云修复页两者已脱钩）。
 * 行间隔 '\n' 只在视觉上不同行（y 差超半行高）时插入：既阻止跨行假命中，
 * 又保留同一条视觉线被切成多框时的连续检索能力（Swift 已按阅读序聚行排序）。
 */
export function buildOcrPageIndex(blocks: OcrBlockGeom[] | undefined | null): PageTextIndexEntry | null {
  if (!blocks || blocks.length === 0) return null;
  const items: TextItemGeom[] = [];
  const segments: CharSegment[] = [];
  let text = '';
  let prevY = NaN;
  let prevH = 0;
  for (const b of blocks) {
    const s = typeof b.text === 'string' ? b.text : '';
    const w = Number.isFinite(b.w) ? Math.abs(b.w) : 0;
    const h = Number.isFinite(b.h) ? Math.abs(b.h) : 0;
    if (!s.trim() || w <= 0 || h <= 0 || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    if (text) {
      // 同行判定：top 差小于 0.6 行高（与 matchToRects 合并阈值同数量级）
      if (!(Math.abs(b.y - prevY) < Math.max(h, prevH) * 0.6)) text += '\n';
    }
    // transform 把 Vision 左下原点 (x,y) 映射为单位视口 [1,0,0,-1,0,1] 下
    // matchToRects 所需的几何：fontHeight=h、left=x、top=1-y-h、width=w
    items.push({ str: s, transform: [1, 0, 0, -h, b.x, b.y], width: w, height: h });
    segments.push({ start: text.length, end: text.length + s.length, itemIdx: items.length - 1 });
    text += s;
    prevY = b.y;
    prevH = h;
  }
  if (items.length === 0) return null;
  return { text, segments, items };
}

/** OCR 骨架专用单位视口：w=h=1 的归一化页面 + y 翻转（Vision 左下原点 → 左上原点） */
const OCR_UNIT_VIEWPORT: ViewportMeta = { transform: [1, 0, 0, -1, 0, 1], scale: 1, w: 1, h: 1 };

/**
 * 将 OCR 服务返回的整合文本（含 `[Page N]` 标记）反解为逐页结构，
 * 兜底用于服务端未提供 pages[] 时。
 */
export function splitOcrPagesFromText(text: string): OcrPageText[] {
  const re = /\[Page\s+(\d+)\]/gi;
  const out: OcrPageText[] = [];
  let m: RegExpExecArray | null;
  let last: { page: number; start: number } | null = null;
  while ((m = re.exec(text))) {
    if (last) out.push({ page: last.page, text: text.slice(last.start, m.index).trim() });
    last = { page: Number(m[1]) || out.length + 1, start: m.index + m[0].length };
  }
  if (last) out.push({ page: last.page, text: text.slice(last.start).trim() });
  return out.filter((p) => p.text.length > 0);
}

/** OCR 结果文本内的命中（有 blocks 骨架 → 精确高亮；否则页级无矩形兜底） */
export function searchOcrPages(
  pages: OcrPageText[],
  query: string,
  opts?: { totalHitsLimit?: number },
): SearchHit[] {
  const limit = opts?.totalHitsLimit ?? 999;
  const hits: SearchHit[] = [];
  for (const p of pages) {
    const entry = buildOcrPageIndex(p.blocks);
    if (entry) {
      // 带行级几何：检索与上下文均取自 blocks 拼接文本（与矩形同源自洽）
      for (const [s, e] of findMatches(entry.text, query, 20)) {
        if (hits.length >= limit) return hits;
        hits.push({
          page: p.page,
          rects: matchToRects(entry, s, e, OCR_UNIT_VIEWPORT),
          context: contextAround(entry.text, s, e),
          excerpt: excerptAround(entry.text, s, e),
          matchPos: s,
          matchLen: e - s,
        });
      }
      continue;
    }
    for (const [s, e] of findMatches(p.text, query, 20)) {
      if (hits.length >= limit) return hits;
      hits.push({
        page: p.page,
        rects: [],
        context: contextAround(p.text, s, e),
        excerpt: excerptAround(p.text, s, e),
        matchPos: s,
        matchLen: e - s,
      });
    }
  }
  return hits;
}
