/**
 * docx → markdown 转换（Word 多级编号注入版）
 *
 * 在 mammoth 默认管线之上补回真实多级编号。背景：mammoth 解析 numbering.xml 时
 * 只保留「有序/无序」二值（numFmt !== "bullet"），编号格式（1. / 1.1 / 一、 / （一） / a. / i.）
 * 与层级编号全部丢失，有序列表被统一输出为 `1. 2. 3.`。
 *
 * 本模块的处理流程（全部在浏览器端完成）：
 * 1. 用原生 DecompressionStream 写的最小 zip reader 解压 docx，读取
 *    word/numbering.xml（编号定义）、word/document.xml（段落 numPr 顺序）、word/styles.xml（样式携带的编号）；
 * 2. 按文档顺序收集每段的 (numId, ilvl) 队列，并用编号状态机算出真实编号文本
 *    （计数按 numId 独立、深层级随浅层级重置、支持 lvlOverride/startOverride/numStyleLink）；
 * 3. 通过 mammoth.transforms.paragraph 把编号作为文本前缀写入段落，并把有序列表降级为普通段落
 *    （避免 mammoth 再输出 `1. 2. 3.` 造成双重编号；markdown-writer 会对 . ( ) 等转义，
 *    `1\.1` 不会被 markdown 误解析为列表，渲染后显示原样编号）。
 * 任何一步失败都静默回退为 mammoth 原始转换，不影响基础功能。
 *
 * 已知边界：纯手工敲编号的「假列表」（段落无 numPr）不在处理范围；个别被 mammoth
 * 丢弃的编号段落（删除修订/文本框）通过 ilvl 匹配窗口容错。
 */

/** 编号级别定义（numbering.xml 的 w:lvl，经 num 覆盖与样式链接解析后） */
export interface NumberingLevel {
  numFmt: string;
  lvlText: string;
  start: number;
}

/** numId → ilvl → 级别定义 */
export type NumberingModel = Map<number, Map<number, NumberingLevel>>;

interface NumberingQueueEntry {
  numId: number;
  ilvl: number;
}

interface MammothParagraph {
  type: string;
  children: unknown[];
  numbering: { isOrdered: boolean; level: string | number } | null;
}

interface MammothTransforms {
  paragraph: (
    transform: (element: MammothParagraph) => MammothParagraph
  ) => (element: unknown) => unknown;
}

interface MammothModule {
  transforms: MammothTransforms;
  convertToMarkdown: (
    input: { arrayBuffer: ArrayBuffer },
    options?: { transformDocument?: (element: unknown) => unknown }
  ) => Promise<{ value: string }>;
}

// ===== 序号格式化 =====

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_LEGAL_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];

/** 中文编号（1-9999）：1→一 10→十 11→十一 20→二十 105→一百零五；legal 为大写（10→壹拾） */
export function chineseNumbering(n: number, legal = false): string {
  if (n <= 0 || n >= 10000) return String(n);
  const digits = legal ? CN_LEGAL_DIGITS : CN_DIGITS;
  const units = legal ? ['', '拾', '佰', '仟'] : ['', '十', '百', '千'];
  const list = Array.from(String(n), Number);
  let out = '';
  list.forEach((d, i) => {
    const unit = units[list.length - 1 - i];
    if (d === 0) {
      if (list.slice(i + 1).some((x) => x !== 0) && !out.endsWith('零')) out += '零';
      return;
    }
    if (!legal && d === 1 && unit === '十' && out === '') {
      out += '十';
      return;
    }
    out += digits[d] + unit;
  });
  return out;
}

/** 字母编号（1→a … 26→z 27→aa，同 Excel 列号进位） */
export function letterNumbering(n: number, upper = false): string {
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return upper ? s.toUpperCase() : s;
}

const ROMAN_PAIRS: Array<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function romanNumbering(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  let out = '';
  for (const [value, sym] of ROMAN_PAIRS) {
    while (n >= value) {
      out += sym;
      n -= value;
    }
  }
  return out;
}

/** 按 w:numFmt 把序号格式化为文本（未识别格式回退十进制） */
export function formatCount(fmt: string, n: number): string {
  switch (fmt) {
    case 'decimal':
      return String(n);
    case 'decimalZero':
      return String(n).padStart(2, '0');
    case 'lowerLetter':
      return letterNumbering(n);
    case 'upperLetter':
      return letterNumbering(n, true);
    case 'lowerRoman':
      return romanNumbering(n).toLowerCase();
    case 'upperRoman':
      return romanNumbering(n);
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'ideographDigital':
      return chineseNumbering(n);
    case 'chineseLegalSimplified':
      return chineseNumbering(n, true);
    case 'none':
      return '';
    default:
      return String(n);
  }
}

/** lvlText 模板替换：%N → 第 N 级编号（该级缺计数时用其 start 兜底） */
export function substituteLvlText(
  lvlText: string,
  counts: readonly (number | undefined)[],
  levels: Map<number, NumberingLevel>
): string {
  return lvlText.replace(/%(\d)/g, (_match, digit: string) => {
    const idx = Number(digit) - 1;
    const level = levels.get(idx);
    const n = counts[idx] ?? level?.start ?? 1;
    return formatCount(level?.numFmt ?? 'decimal', n);
  });
}

// ===== 编号状态机 =====

/**
 * Word 编号计数器：计数按 numId 独立。
 * 推进第 ilvl 级时该级 +1（首次取该级 start），并清空所有更深级别；
 * 返回按该级 lvlText 渲染的编号文本；bullet/none/未知定义返回 null（不注入）。
 */
export class NumberingCounter {
  private readonly model: NumberingModel;
  private readonly counters = new Map<number, (number | undefined)[]>();

  constructor(model: NumberingModel) {
    this.model = model;
  }

  advance(numId: number, ilvl: number): string | null {
    const levels = this.model.get(numId);
    if (!levels) return null;
    const level = levels.get(ilvl);
    if (!level) return null;
    if (level.numFmt === 'bullet' || level.numFmt === 'none') return null;

    const counts = this.counters.get(numId) ?? [];
    const current = counts[ilvl];
    counts[ilvl] = current == null ? level.start : current + 1;
    counts.length = ilvl + 1;
    this.counters.set(numId, counts);

    return substituteLvlText(level.lvlText, counts, levels);
  }
}

// ===== docx zip 最小读取（浏览器原生 DecompressionStream，零依赖） =====

/** 读取 zip 中指定条目并解码为 UTF-8 文本（支持 store/deflate，docx 足够） */
async function readZipTextFiles(
  buffer: ArrayBuffer,
  wanted: readonly string[]
): Promise<Map<string, string>> {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const decoder = new TextDecoder();

  // 从尾部向前定位 EOCD（兼容最长 64KB 的 zip 注释区）
  let eocd = -1;
  const minEocd = Math.max(0, buffer.byteLength - 22 - 65536);
  for (let i = buffer.byteLength - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('docx zip: EOCD not found');

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new Error('docx zip: zip64 not supported');

  const wantedSet = new Set(wanted);
  const results = new Map<string, string>();
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(u8.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (!wantedSet.has(name) || view.getUint32(localOffset, true) !== 0x04034b50) continue;

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = u8.subarray(dataStart, dataStart + compressedSize);

    let bytes: Uint8Array;
    if (method === 0) {
      bytes = data;
    } else if (method === 8) {
      bytes = await inflateRaw(data);
    } else {
      continue;
    }
    results.set(name, decoder.decode(bytes));
  }
  return results;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ===== numbering.xml / styles.xml / document.xml 解析 =====

function parseXml(text: string): XMLDocument | null {
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    return doc.getElementsByTagName('parsererror').length > 0 ? null : doc;
  } catch {
    return null;
  }
}

function firstByTag(root: Element | XMLDocument, tag: string): Element | null {
  return root.getElementsByTagName(tag)[0] ?? null;
}

function xmlAttr(el: Element | null, name: string): string | null {
  return el?.getAttribute(name) ?? null;
}

function toInt(value: string | null, fallback: number): number {
  const n = value == null ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

interface AbstractNum {
  levels: Map<number, NumberingLevel>;
  numStyleLink: string | null;
}

interface NumEntry {
  abstractNumId: number;
  overrides: Map<number, Partial<NumberingLevel>>;
}

function parseAbstractNums(doc: XMLDocument): Map<number, AbstractNum> {
  const map = new Map<number, AbstractNum>();
  for (const el of Array.from(doc.getElementsByTagName('w:abstractNum'))) {
    const id = toInt(xmlAttr(el, 'w:abstractNumId'), -1);
    if (id < 0) continue;
    const levels = new Map<number, NumberingLevel>();
    for (const lvl of Array.from(el.getElementsByTagName('w:lvl'))) {
      const ilvl = toInt(xmlAttr(lvl, 'w:ilvl'), -1);
      if (ilvl < 0) continue;
      levels.set(ilvl, {
        numFmt: xmlAttr(firstByTag(lvl, 'w:numFmt'), 'w:val') ?? 'decimal',
        lvlText: xmlAttr(firstByTag(lvl, 'w:lvlText'), 'w:val') ?? '%1.',
        start: toInt(xmlAttr(firstByTag(lvl, 'w:start'), 'w:val'), 1),
      });
    }
    map.set(id, {
      levels,
      numStyleLink: xmlAttr(firstByTag(el, 'w:numStyleLink'), 'w:val'),
    });
  }
  return map;
}

function parseNums(doc: XMLDocument): Map<number, NumEntry> {
  const map = new Map<number, NumEntry>();
  for (const num of Array.from(doc.getElementsByTagName('w:num'))) {
    const numId = toInt(xmlAttr(num, 'w:numId'), -1);
    if (numId < 0) continue;
    const overrides = new Map<number, Partial<NumberingLevel>>();
    for (const override of Array.from(num.getElementsByTagName('w:lvlOverride'))) {
      const ilvl = toInt(xmlAttr(override, 'w:ilvl'), -1);
      if (ilvl < 0) continue;
      const patch: Partial<NumberingLevel> = {};
      const startOverride = xmlAttr(firstByTag(override, 'w:startOverride'), 'w:val');
      if (startOverride != null) patch.start = toInt(startOverride, 1);
      const nested = firstByTag(override, 'w:lvl');
      if (nested) {
        const fmt = xmlAttr(firstByTag(nested, 'w:numFmt'), 'w:val');
        const text = xmlAttr(firstByTag(nested, 'w:lvlText'), 'w:val');
        const start = xmlAttr(firstByTag(nested, 'w:start'), 'w:val');
        if (fmt != null) patch.numFmt = fmt;
        if (text != null) patch.lvlText = text;
        if (start != null) patch.start = toInt(start, 1);
      }
      overrides.set(ilvl, patch);
    }
    map.set(numId, {
      abstractNumId: toInt(xmlAttr(firstByTag(num, 'w:abstractNumId'), 'w:val'), -1),
      overrides,
    });
  }
  return map;
}

/** styles.xml：段落样式携带的编号（styleId → numId/ilvl），覆盖「样式编号」型文档 */
function parseStyleNumbering(stylesXml: string | undefined): Map<string, { numId: number; ilvl: number }> {
  const map = new Map<string, { numId: number; ilvl: number }>();
  if (!stylesXml) return map;
  const doc = parseXml(stylesXml);
  if (!doc) return map;
  for (const style of Array.from(doc.getElementsByTagName('w:style'))) {
    const styleId = xmlAttr(style, 'w:styleId');
    if (styleId == null) continue;
    const pPr = firstByTag(style, 'w:pPr');
    const numPr = pPr ? firstByTag(pPr, 'w:numPr') : null;
    if (!numPr) continue;
    const numId = toInt(xmlAttr(firstByTag(numPr, 'w:numId'), 'w:val'), 0);
    if (numId <= 0) continue;
    map.set(styleId, { numId, ilvl: toInt(xmlAttr(firstByTag(numPr, 'w:ilvl'), 'w:val'), 0) });
  }
  return map;
}

/** numId → 级别表：跟随 numStyleLink（styleId → 样式携带的 numId，带环检测）并应用 lvlOverride */
function resolveLevelsForNum(
  numId: number,
  abstractNums: Map<number, AbstractNum>,
  nums: Map<number, NumEntry>,
  styleNumbering: Map<string, { numId: number; ilvl: number }>,
  visited: Set<number>
): Map<number, NumberingLevel> | null {
  if (visited.has(numId)) return null;
  visited.add(numId);
  const num = nums.get(numId);
  if (!num) return null;
  const abstract = abstractNums.get(num.abstractNumId);
  if (!abstract) return null;

  let base: Map<number, NumberingLevel>;
  if (abstract.numStyleLink != null) {
    const linked = styleNumbering.get(abstract.numStyleLink);
    const resolved = linked
      ? resolveLevelsForNum(linked.numId, abstractNums, nums, styleNumbering, visited)
      : null;
    if (!resolved || resolved.size === 0) return null;
    base = resolved;
  } else {
    base = abstract.levels;
  }

  const levels = new Map(base);
  for (const [ilvl, patch] of num.overrides) {
    const merged = levels.get(ilvl) ?? { numFmt: 'decimal', lvlText: '%1.', start: 1 };
    levels.set(ilvl, { ...merged, ...patch });
  }
  return levels;
}

function resolveNumberingModel(
  abstractNums: Map<number, AbstractNum>,
  nums: Map<number, NumEntry>,
  styleNumbering: Map<string, { numId: number; ilvl: number }>
): NumberingModel {
  const model: NumberingModel = new Map();
  for (const numId of nums.keys()) {
    const levels = resolveLevelsForNum(numId, abstractNums, nums, styleNumbering, new Set());
    if (levels && levels.size > 0) model.set(numId, levels);
  }
  return model;
}

/** document.xml 按文档顺序收集带编号段落（直接 numPr 优先，其次段落样式携带的 numPr） */
function collectNumberingQueue(
  documentXml: string,
  styleNumbering: Map<string, { numId: number; ilvl: number }>
): NumberingQueueEntry[] {
  const doc = parseXml(documentXml);
  if (!doc) return [];
  const queue: NumberingQueueEntry[] = [];
  for (const p of Array.from(doc.getElementsByTagName('w:p'))) {
    const pPr = firstByTag(p, 'w:pPr');
    if (!pPr) continue;
    let numId = 0;
    let ilvl = 0;
    const numPr = firstByTag(pPr, 'w:numPr');
    if (numPr) {
      numId = toInt(xmlAttr(firstByTag(numPr, 'w:numId'), 'w:val'), 0);
      ilvl = toInt(xmlAttr(firstByTag(numPr, 'w:ilvl'), 'w:val'), 0);
    }
    if (numId <= 0) {
      const styleId = xmlAttr(firstByTag(pPr, 'w:pStyle'), 'w:val');
      const fromStyle = styleId != null ? styleNumbering.get(styleId) : undefined;
      if (!fromStyle) continue;
      numId = fromStyle.numId;
      ilvl = fromStyle.ilvl;
    }
    queue.push({ numId, ilvl });
  }
  return queue;
}

// ===== 编号注入 transform =====

/**
 * 生成 mammoth transformDocument：
 * - 有序列表项：注入真实编号文本前缀，并降级为普通段落（numbering 置 null，
 *   避免 mammoth 输出 1. 2. 3. 与真实编号叠加）；
 * - 无序列表项：保持原样（仍输出 `- `），仅消耗队列项维持与 document.xml 的对齐。
 */
function makeNumberingTransform(
  queue: NumberingQueueEntry[],
  counter: NumberingCounter,
  transforms: MammothTransforms
): (element: unknown) => unknown {
  let cursor = 0;
  return transforms.paragraph((p) => {
    const numbering = p.numbering;
    if (!numbering) return p;

    const entry = queue[cursor++];
    if (numbering.isOrdered) {
      const level = Number(numbering.level);
      let matched = entry && entry.ilvl === level ? entry : null;
      if (!matched) {
        // 容错：mammoth 可能丢弃个别编号段落（删除修订/文本框等），向后小窗口找 ilvl 匹配项
        let lookahead = cursor;
        while (lookahead < queue.length && lookahead - cursor < 4) {
          const candidate = queue[lookahead++];
          if (candidate.ilvl === level) {
            matched = candidate;
            cursor = lookahead;
            break;
          }
        }
      }
      if (matched) {
        const text = counter.advance(matched.numId, matched.ilvl);
        if (text) p.children.unshift({ type: 'text', value: `${text} ` });
      }
      p.numbering = null;
    }
    return p;
  });
}

async function buildNumberingTransform(
  arrayBuffer: ArrayBuffer,
  transforms: MammothTransforms
): Promise<((element: unknown) => unknown) | null> {
  try {
    const files = await readZipTextFiles(arrayBuffer, [
      'word/document.xml',
      'word/numbering.xml',
      'word/styles.xml',
    ]);
    const numberingXml = files.get('word/numbering.xml');
    const documentXml = files.get('word/document.xml');
    if (!numberingXml || !documentXml) return null;

    const numberingDoc = parseXml(numberingXml);
    if (!numberingDoc) return null;
    const styleNumbering = parseStyleNumbering(files.get('word/styles.xml'));
    const model = resolveNumberingModel(parseAbstractNums(numberingDoc), parseNums(numberingDoc), styleNumbering);
    const queue = collectNumberingQueue(documentXml, styleNumbering);
    if (model.size === 0 || queue.length === 0) return null;

    return makeNumberingTransform(queue, new NumberingCounter(model), transforms);
  } catch {
    return null;
  }
}

/** docx → markdown：mammoth 转换 + Word 真实多级编号注入（失败自动回退原始转换） */
export async function convertDocxToMarkdown(arrayBuffer: ArrayBuffer): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as MammothModule;
  try {
    const transformDocument = await buildNumberingTransform(arrayBuffer, mammoth.transforms);
    const res = await mammoth.convertToMarkdown(
      { arrayBuffer },
      transformDocument ? { transformDocument } : undefined
    );
    return res.value;
  } catch {
    const res = await mammoth.convertToMarkdown({ arrayBuffer });
    return res.value;
  }
}
