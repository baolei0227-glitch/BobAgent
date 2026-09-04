import {
  Document,
  Paragraph,
  TextRun,
  SymbolRun,
  ImageRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  AlignmentType,
  Footer,
  Header,
  PageNumber,
  ExternalHyperlink,
  TabStopType,
  TabStopPosition,
  Packer,
  LevelFormat,
} from 'docx';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

// ---------------------------------------------------------------------------
// Public types & defaults
// ---------------------------------------------------------------------------

export interface DocxExportConfig {
  bodyFont: string;
  bodySize: number;
  lineHeight: number;
  margin: 'narrow' | 'standard' | 'wide';
  headingColor: string;
  codeFont: string;
  pageNumber: 'off' | 'center' | 'right';
  header: {
    type: 'off' | 'text' | 'image';
    text: string;
    /** Base64 Data URL for header image (e.g. data:image/png;base64,xxxxx) */
    imageDataUrl: string;
    align: 'left' | 'center' | 'right';
  };
}

export const DEFAULT_DOCX_CONFIG: DocxExportConfig = {
  bodyFont: '宋体',
  bodySize: 12,
  lineHeight: 1.5,
  margin: 'standard',
  headingColor: '1a1a1a',
  codeFont: 'Consolas',
  pageNumber: 'center',
  header: {
    type: 'off',
    text: '',
    imageDataUrl: '',
    align: 'center',
  },
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal mdast node representation – loose enough for tree walking. */
interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean | null;
  lang?: string;
  url?: string;
  alt?: string;
  title?: string | null;
  align?: string[];
}

/** Formatting carried through inline recursion so nested marks compose. */
interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  color?: string;
  /** docx style-id, e.g. "Hyperlink" */
  style?: string;
  /** when true the run omits an explicit size (headings rely on style) */
  skipSize?: boolean;
}

/** Paragraph-level options that propagate into blockquotes / lists. */
interface ParaOpts {
  indent?: { left: number };
  border?: {
    left: {
      style: (typeof BorderStyle)[keyof typeof BorderStyle];
      size: number;
      color: string;
      space: number;
    };
  };
}

type InlineElement = TextRun | ExternalHyperlink | SymbolRun | ImageRun;
type BlockElement = Paragraph | Table;

/** 已加载的图片（预扫描 md 后统一 fetch/解码，同步遍历时直接取用） */
interface LoadedImage {
  bytes: Uint8Array;
  mime: 'png' | 'jpg' | 'gif' | 'bmp';
  width: number;
  height: number;
}

/** 图片超限缩放阈值（像素，docx 以 96dpi 逻辑像素排版） */
const IMG_MAX_WIDTH = 500;
const IMG_MAX_HEIGHT = 650;

/** 列表编号实例计数器（顶层有序列表每次 +1 → 编号自动重启） */
interface NumRef {
  n: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function headingLevelFor(
  depth: number | undefined,
): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (depth) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    default:
      return HeadingLevel.HEADING_6;
  }
}

function marginsFor(margin: DocxExportConfig['margin']) {
  switch (margin) {
    case 'narrow':
      return { top: 1440, bottom: 1440, left: 1440, right: 1440 };
    case 'wide':
      return { top: 1800, bottom: 1800, left: 1800, right: 1800 };
    case 'standard':
    default:
      return { top: 1440, bottom: 1440, left: 1800, right: 1800 };
  }
}

/** pt → half-points (docx size unit) */
function halfPt(config: DocxExportConfig): number {
  return config.bodySize * 2;
}

/** line spacing in 240ths (240 = single line) */
function lineSpacing(config: DocxExportConfig): number {
  return 240 * config.lineHeight;
}

/**
 * 中文字体双字体：中文（eastAsia）用用户选的正文字体（宋体/仿宋…），
 * 英文与数字（ascii/hAnsi）统一用 Times New Roman —— 法律/公文标准搭配。
 * docx 中 `font: string` 只写 w:ascii，中文字符不生效，必须对象形式。
 */
function cnFont(config: DocxExportConfig): { ascii: string; eastAsia: string; hAnsi: string; cs: string } {
  return {
    ascii: 'Times New Roman',
    eastAsia: config.bodyFont,
    hAnsi: 'Times New Roman',
    cs: config.bodyFont,
  };
}

/** 行内代码字体：代码用 codeFont（ascii），中文注释回退正文字体（eastAsia） */
function codeFont(config: DocxExportConfig): { ascii: string; eastAsia: string; hAnsi: string; cs: string } {
  return {
    ascii: config.codeFont,
    eastAsia: config.bodyFont,
    hAnsi: config.codeFont,
    cs: config.bodyFont,
  };
}

/**
 * 代码块专用等宽字体：所有字符区间（含 eastAsia/cs）统一用 codeFont，
 * 确保 box-drawing 字符（│ ▼ └ ─ 等）与 ASCII 列对齐，不因中文字体回退错位。
 */
function codeBlockFont(config: DocxExportConfig): { ascii: string; eastAsia: string; hAnsi: string; cs: string } {
  return {
    ascii: config.codeFont,
    eastAsia: config.codeFont,
    hAnsi: config.codeFont,
    cs: config.codeFont,
  };
}

// ---------------------------------------------------------------------------
// Document styles (styles.xml)：Normal + 覆盖内置标题样式
// ---------------------------------------------------------------------------

function buildStyles(config: DocxExportConfig) {
  const body = cnFont(config);
  const heading = (size: number, before: number, after: number) => ({
    run: { font: body, size, bold: true, color: config.headingColor },
    paragraph: { spacing: { before, after, line: lineSpacing(config) } },
  });
  return {
    default: {
      document: {
        run: { font: body, size: halfPt(config) },
        paragraph: {
          spacing: { line: lineSpacing(config) },
          autoSpaceEastAsianText: true,
        },
      },
      // 标题统一黑体加粗思路：加粗 + 正文字体 + 递增字号 + 段前段后距（中文排版层次感）
      heading1: heading(44, 480, 240),
      heading2: heading(32, 360, 200),
      heading3: heading(28, 280, 160),
      heading4: heading(24, 240, 120),
      heading5: heading(22, 200, 100),
      heading6: heading(20, 160, 80),
      hyperlink: { run: { color: '0563C1' } },
    },
  };
}

// ---------------------------------------------------------------------------
// Numbering (真编号列表)：替换手工 "1. " 文本前缀
// ---------------------------------------------------------------------------

function buildNumbering() {
  const orderedLevels = [0, 1, 2].map((level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: '%1.',
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
    },
  }));
  const bulletLevels = [0, 1, 2].map((level) => ({
    level,
    format: LevelFormat.BULLET,
    text: '•',
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
    },
  }));
  return {
    config: [
      { reference: 'ordered', levels: orderedLevels },
      { reference: 'bullet', levels: bulletLevels },
    ],
  };
}

// ---------------------------------------------------------------------------
// Inline conversion  (mdast phrasing → TextRun / ExternalHyperlink / ImageRun)
// ---------------------------------------------------------------------------

function convertInline(
  nodes: MdastNode[],
  config: DocxExportConfig,
  imageMap: Map<string, LoadedImage>,
  style: RunStyle = {},
): InlineElement[] {
  const out: InlineElement[] = [];
  for (const node of nodes) {
    out.push(...convertInlineNode(node, config, imageMap, style));
  }
  return out;
}

function convertInlineNode(
  node: MdastNode,
  config: DocxExportConfig,
  imageMap: Map<string, LoadedImage>,
  style: RunStyle,
): InlineElement[] {
  switch (node.type) {
    case 'text':
      return [makeTextRun(node.value || '', config, style)];

    case 'strong':
      return convertInline(node.children || [], config, imageMap, {
        ...style,
        bold: true,
      });

    case 'emphasis':
      return convertInline(node.children || [], config, imageMap, {
        ...style,
        italics: true,
      });

    case 'delete':
      return convertInline(node.children || [], config, imageMap, {
        ...style,
        strike: true,
      });

    case 'inlineCode':
      return [
        new TextRun({
          text: node.value || '',
          font: codeFont(config),
          size: halfPt(config),
          shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' },
          ...stripRunStyle(style),
        }),
      ];

    case 'link': {
      const linkChildren = convertInline(node.children || [], config, imageMap, {
        ...style,
        style: 'Hyperlink',
      });
      return [
        new ExternalHyperlink({
          link: node.url || '',
          children: linkChildren,
        }),
      ];
    }

    case 'image': {
      const img = node.url ? imageMap.get(node.url) : undefined;
      if (img) {
        // 按内容等比例缩放，超限时压缩到阈值内
        let w = img.width;
        let h = img.height;
        if (w > IMG_MAX_WIDTH) {
          h = Math.round((h * IMG_MAX_WIDTH) / w);
          w = IMG_MAX_WIDTH;
        }
        if (h > IMG_MAX_HEIGHT) {
          w = Math.round((w * IMG_MAX_HEIGHT) / h);
          h = IMG_MAX_HEIGHT;
        }
        return [
          new ImageRun({
            type: img.mime,
            data: img.bytes,
            transformation: { width: w, height: h },
            altText: { name: node.alt || 'image', title: node.alt || 'image', description: node.alt || 'image' },
          }),
        ];
      }
      // 图片加载失败（外链跨域 / 非浏览器环境）→ 降级为 alt 文本
      return [makeTextRun(`[${node.alt || 'image'}]`, config, style)];
    }

    case 'break':
      return [new TextRun({ break: 1 })];

    default:
      return convertInline(node.children || [], config, imageMap, style);
  }
}

function makeTextRun(
  text: string,
  config: DocxExportConfig,
  style: RunStyle,
): TextRun {
  const { skipSize, ...runProps } = style;
  return new TextRun({
    text,
    font: cnFont(config),
    ...(skipSize ? {} : { size: halfPt(config) }),
    ...runProps,
  });
}

/** Remove the internal-only `skipSize` flag before spreading into TextRun. */
function stripRunStyle(style: RunStyle): Omit<RunStyle, 'skipSize'> {
  const { skipSize: _skip, ...rest } = style;
  return rest;
}

// ---------------------------------------------------------------------------
// Block conversion  (mdast block → Paragraph / Table)
// ---------------------------------------------------------------------------

function convertBlock(
  node: MdastNode,
  config: DocxExportConfig,
  imageMap: Map<string, LoadedImage>,
  paraOpts: ParaOpts = {},
  listLevel = 0,
  numRef: NumRef,
): BlockElement[] {
  switch (node.type) {
    case 'heading':
      return [
        new Paragraph({
          heading: headingLevelFor(node.depth),
          children: convertInline(node.children || [], config, imageMap, {
            color: config.headingColor,
            skipSize: true,
          }),
          spacing: { line: lineSpacing(config) },
          ...paraOpts,
        }),
      ];

    case 'paragraph':
      return [
        new Paragraph({
          children: convertInline(node.children || [], config, imageMap),
          spacing: { line: lineSpacing(config) },
          // 正文不首行缩进（引用块等继承的 indent 保留）
          indent: { ...(paraOpts.indent ?? {}) },
          ...paraOpts,
        }),
      ];

    case 'code':
      return [convertCodeBlock(node, config, paraOpts)];

    case 'blockquote':
      return convertBlockquote(node, config, imageMap, paraOpts, listLevel, numRef);

    case 'list':
      // 顶层有序列表分配新编号实例（每次重启）；无序/嵌套继承 0
      if (node.ordered) numRef.n++;
      return convertList(node, config, imageMap, listLevel, node.ordered ? numRef.n : 0);

    case 'table':
      return [convertTable(node, config, imageMap)];

    case 'thematicBreak':
      return [
        new Paragraph({
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: 'CCCCCC',
              space: 1,
            },
          },
          spacing: { line: lineSpacing(config) },
        }),
      ];

    case 'html':
      // raw HTML is intentionally skipped
      return [];

    default:
      return convertBlocks(node.children || [], config, imageMap, paraOpts, listLevel, numRef);
  }
}

function convertBlocks(
  nodes: MdastNode[],
  config: DocxExportConfig,
  imageMap: Map<string, LoadedImage>,
  paraOpts: ParaOpts = {},
  listLevel = 0,
  numRef: NumRef,
): BlockElement[] {
  const out: BlockElement[] = [];
  for (const node of nodes) {
    out.push(...convertBlock(node, config, imageMap, paraOpts, listLevel, numRef));
  }
  return out;
}

function convertCodeBlock(
  node: MdastNode,
  config: DocxExportConfig,
  paraOpts: ParaOpts,
): Paragraph {
  const lines = (node.value || '').split('\n');
  const runs: TextRun[] = [];
  const cf = codeBlockFont(config);

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      runs.push(new TextRun({ break: 1 }));
    }
    runs.push(
      new TextRun({
        text: lines[i],
        font: cf,
        size: halfPt(config),
      }),
    );
  }

  return new Paragraph({
    children: runs,
    shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD', space: 2 },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD', space: 2 },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD', space: 2 },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD', space: 2 },
    },
    // 代码块强制单倍行距：box-drawing 竖线（│）在 1.5 倍行距下会断裂
    spacing: { line: 240 },
    ...paraOpts,
  });
}

function convertBlockquote(
  node: MdastNode,
  config: DocxExportConfig,
  imageMap: Map<string, LoadedImage>,
  paraOpts: ParaOpts,
  listLevel: number,
  numRef: NumRef,
): BlockElement[] {
  const quoteOpts: ParaOpts = {
    ...paraOpts,
    indent: { left: (paraOpts.indent?.left || 0) + 360 },
    border: {
      left: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 10 },
    },
  };
  return convertBlocks(node.children || [], config, imageMap, quoteOpts, listLevel, numRef);
}

function convertList(
  node: MdastNode,
  config: DocxExportConfig,
  imageMap: Map<string, LoadedImage>,
  level: number,
  instance: number,
): BlockElement[] {
  const items = node.children || [];
  const out: BlockElement[] = [];
  const currentLevel = Math.min(level, 2); // cap at 3 levels (0, 1, 2)
  const ordered = node.ordered || false;

  for (const item of items) {
    if (item.type !== 'listItem') continue;

    const isTask = item.checked === true || item.checked === false;

    for (const child of item.children || []) {
      if (child.type === 'list') {
        // nested list – recurse one level deeper（继承同一编号实例，level 递进）
        out.push(...convertList(child, config, imageMap, level + 1, instance));
      } else if (child.type === 'paragraph') {
        const runs: InlineElement[] = [];

        // 任务清单：Wingdings 符号（☑/☐ 在宋体下可能变方框，Wingdings 字符集稳定）
        if (isTask) {
          runs.push(
            new SymbolRun({
              char: item.checked ? '\u00FE' : '\u00A8',
              symbolfont: 'Wingdings',
              size: halfPt(config),
            }),
            new TextRun({ text: ' ', font: cnFont(config), size: halfPt(config) }),
          );
        }

        runs.push(...convertInline(child.children || [], config, imageMap));

        out.push(
          new Paragraph({
            children: runs,
            spacing: { line: lineSpacing(config) },
            // 真 numbering（自动编号/悬挂缩进），替代手工 "1. " 前缀
            numbering: ordered
              ? { reference: 'ordered', level: currentLevel, instance }
              : { reference: 'bullet', level: currentLevel },
            indent: { left: 720 * (currentLevel + 1) },
          }),
        );
      } else {
        // any other block content inside a list item
        out.push(...convertBlock(child, config, imageMap, {}, level, { n: instance }));
      }
    }
  }

  return out;
}

function convertTable(
  node: MdastNode,
  config: DocxExportConfig,
  imageMap: Map<string, LoadedImage>,
): Table {
  const rows = (node.children || []).map((row, rowIdx) => {
    const isHeader = rowIdx === 0;
    const cells = (row.children || []).map((cell) => {
      const cellChildren = convertInline(
        cell.children || [],
        config,
        imageMap,
        isHeader ? { bold: true } : {},
      );
      return new TableCell({
        children: [
          new Paragraph({
            children: cellChildren,
            spacing: { line: lineSpacing(config) },
            // 单元格内首行不缩进（表格排版惯例）
            indent: { left: 100, right: 100 },
          }),
        ],
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        ...(isHeader
          ? { shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' } }
          : {}),
      });
    });
    return new TableRow({ children: cells, tableHeader: isHeader });
  });

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    // 显式细边框，避免不同 Word 版本默认无边框
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
      left: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
      right: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
    },
  });
}

// ---------------------------------------------------------------------------
// Footer (page numbers) + Header (text / image)
// ---------------------------------------------------------------------------

function alignFor(align: 'left' | 'center' | 'right'): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (align) {
    case 'left':
      return AlignmentType.LEFT;
    case 'right':
      return AlignmentType.RIGHT;
    case 'center':
    default:
      return AlignmentType.CENTER;
  }
}

/** Decode a base64 Data URL (data:image/png;base64,xxxxx) → Uint8Array + mime */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx < 0) return null;
    const meta = dataUrl.slice(5, commaIdx); // e.g. "image/png;base64"
    const payload = dataUrl.slice(commaIdx + 1);
    const isBase64 = /;\s*base64\s*$/i.test(meta);
    const mime = meta.split(';')[0] || 'image/png';
    const bytesStr = isBase64
      ? (typeof atob === 'function' ? atob(payload) : Buffer.from(payload, 'base64').toString('binary'))
      : decodeURIComponent(payload);
    const len = bytesStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bytesStr.charCodeAt(i) & 0xff;
    return { bytes, mime };
  } catch {
    return null;
  }
}

function createHeader(config: DocxExportConfig): Header | undefined {
  const h = config.header;
  if (!h || h.type === 'off') return undefined;
  const alignment = alignFor(h.align);

  if (h.type === 'text') {
    const text = (h.text || '').trim();
    if (!text) return undefined;
    return new Header({
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text,
              font: cnFont(config),
              size: halfPt(config),
            }),
          ],
          alignment,
          spacing: { line: lineSpacing(config) },
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB', space: 4 },
          },
        }),
      ],
    });
  }

  // image
  const decoded = decodeDataUrl(h.imageDataUrl);
  if (!decoded) return undefined;
  // Default image dimensions in EMUs: ~2 inches height, preserve aspect roughly.
  // docx ImageRun uses pixels as input with default 96dpi; we cap height at ~80px (~0.83 inch)
  const MAX_HEIGHT_PX = 80;
  const MAX_WIDTH_PX = 500;
  return new Header({
    children: [
      new Paragraph({
        children: [
          new ImageRun({
            data: decoded.bytes,
            transformation: {
              width: MAX_WIDTH_PX,
              height: MAX_HEIGHT_PX,
            },
            type: 'png',
          }),
        ],
        alignment,
        spacing: { line: lineSpacing(config) },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB', space: 4 },
        },
      }),
    ],
  });
}

function createFooter(config: DocxExportConfig): Footer {
  const font = cnFont(config);
  const pageRuns = [
    new TextRun({ children: [PageNumber.CURRENT], font, size: halfPt(config) }),
    new TextRun({ text: ' / ', font, size: halfPt(config) }),
    new TextRun({ children: [PageNumber.TOTAL_PAGES], font, size: halfPt(config) }),
  ];

  if (config.pageNumber === 'right') {
    return new Footer({
      children: [
        new Paragraph({
          children: [new TextRun({ text: '\t', font, size: halfPt(config) }), ...pageRuns],
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        }),
      ],
    });
  }

  return new Footer({
    children: [
      new Paragraph({
        children: pageRuns,
        alignment: AlignmentType.CENTER,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Image preloading（md 图片 → 二进制 + 尺寸）
// ---------------------------------------------------------------------------

/** 从 URL 扩展名推断 mime（fetch 无 content-type 头时兜底） */
function guessMimeFromExt(src: string): string {
  const m = src.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
  const ext = (m?.[1] || '').toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
  };
  return map[ext] || '';
}

/** 取图片原始二进制 + mime（dataURL 直接解码；API 路径/同源 URL fetch；跨域失败返回 null） */
async function fetchImageBytes(src: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    if (src.startsWith('data:')) {
      const decoded = decodeDataUrl(src);
      return decoded ? { bytes: decoded.bytes, mime: decoded.mime } : null;
    }
    const resp = await fetch(src, { cache: 'no-store' });
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    const mime =
      resp.headers.get('content-type')?.split(';')[0] ||
      guessMimeFromExt(src) ||
      'image/png';
    return { bytes: buf, mime };
  } catch {
    return null;
  }
}

/** canvas 重绘 → PNG（webp/svg 等 docx 不支持的格式） */
async function canvasToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  try {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('img load failed'));
      img.src = url;
    });
    URL.revokeObjectURL(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1;
    canvas.height = img.naturalHeight || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** 测量图片像素尺寸（createImageBitmap 优先，<img> 兜底） */
async function measureImage(
  bytes: Uint8Array,
  mime: string,
): Promise<{ width: number; height: number } | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      const dims = { width: bmp.width, height: bmp.height };
      bmp.close();
      if (dims.width > 0 && dims.height > 0) return dims;
    }
  } catch { /* fallthrough to <img> */ }
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

/** mime → docx ImageRun type */
function normalizeImageType(mime: string): 'png' | 'jpg' | 'gif' | 'bmp' {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('gif')) return 'gif';
  if (m.includes('bmp')) return 'bmp';
  return 'jpg';
}

/** 单张图片 → LoadedImage（webp/svg 转 png，超限缩放，失败返回 null） */
async function ensureDocxImage(
  bytes: Uint8Array,
  mime: string,
): Promise<LoadedImage | null> {
  let data = bytes;
  let finalMime = mime;
  // webp/svg/未知 → canvas 重绘为 png
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(mime)) {
    const converted = await canvasToPng(bytes, mime);
    if (!converted) return null;
    data = converted;
    finalMime = 'image/png';
  }
  const dims = await measureImage(data, finalMime);
  if (!dims) return null;
  return { bytes: data, mime: normalizeImageType(finalMime), width: dims.width, height: dims.height };
}

/** 预扫描 markdown 中的全部图片并加载（失败项静默跳过，同步遍历时降级 alt 文本） */
async function preloadImages(markdown: string): Promise<Map<string, LoadedImage>> {
  const srcs = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const unique = [...new Set(srcs)].filter(Boolean);
  const map = new Map<string, LoadedImage>();
  await Promise.all(
    unique.map(async (src) => {
      try {
        const raw = await fetchImageBytes(src);
        if (!raw) return;
        const img = await ensureDocxImage(raw.bytes, raw.mime);
        if (img) map.set(src, img);
      } catch { /* ignore */ }
    }),
  );
  return map;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function convertMarkdownToDocx(
  markdown: string,
  config: DocxExportConfig,
  title?: string,
): Promise<Blob> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const root = tree as unknown as MdastNode;

  // 预加载文档图片（Node/无网络环境下全部失败 → 降级为 alt 文本，不阻塞导出）
  const imageMap = await preloadImages(markdown);

  const children: BlockElement[] = [];
  const numRef: NumRef = { n: 0 };

  if (title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({
            text: title,
            color: config.headingColor,
            font: cnFont(config),
            bold: true,
          }),
        ],
        spacing: { line: lineSpacing(config) },
      }),
    );
  }

  for (const node of root.children || []) {
    children.push(...convertBlock(node, config, imageMap, {}, 0, numRef));
  }

  // guard against empty markdown
  if (children.length === 0) {
    children.push(new Paragraph({ children: [] }));
  }

  const header = createHeader(config);

  const doc = new Document({
    styles: buildStyles(config),
    numbering: buildNumbering(),
    sections: [
      {
        properties: {
          page: {
            margin: marginsFor(config.margin),
            size: { width: 11906, height: 16838 }, // A4
          },
        },
        headers: header ? { default: header } : undefined,
        footers:
          config.pageNumber !== 'off'
            ? { default: createFooter(config) }
            : undefined,
        children,
      },
    ],
  });

  return await Packer.toBlob(doc);
}
