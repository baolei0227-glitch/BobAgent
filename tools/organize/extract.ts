/**
 * 首页内容抽取 —— 只读「第一个信息单位」，把单文件 token 成本压到 ~1.5k。
 *
 * 各类型策略：
 *   txt/md/csv/json/log   前 1500 字
 *   docx                  mammoth 抽纯文本 → 前 1500 字
 *   xlsx                  首个工作表：表头 + 前 20 行
 *   pdf（有文字层）         Python pypdf/pdfplumber 取第 1 页
 *   pdf（扫描件）           同一套管线判定扫不出字 → 交 bob-ocr-mcp 识别第 1 页
 *   图片                   先 bob-ocr-mcp 取字；取不到再交视觉模型（原图 data URL）
 *
 * 设计取舍：
 *   1) 日期以「执行命名日期」为准，不必为了拿签署日去读末页，只读首页即可。
 *   2) PDF **不再自建 pdf-parse 渲染链路**：那条链路依赖 @napi-rs/canvas 的
 *      DOMMatrix 补丁，打包版（next-standalone）里既没有该包也没有原生 .node，
 *      补丁静默失败后 getScreenshot() 必抛，全部扫描件直接被判「无法整理」。
 *      改为复用项目既有的 Python 提取器（打包版随包分发 pdf_extractor.py）
 *      + bob-ocr-mcp 识别链路，与 read_attachment / 资料索引同口径。
 */
import { promises as fs } from 'fs';
import { extname } from 'path';

import { extractWithPdfParse, extractWithPython } from '@/lib/pdf/extractor';

/** 送入模型的正文上限（字符） */
const TEXT_LIMIT = 1500;
/** 文本文件的有界读取上限（字节），避免大日志撑爆内存 */
const HEAD_BYTES = 64 * 1024;
/** 电子表格送入模型的行数上限 */
const SPREADSHEET_ROWS = 20;
/** PDF 判定为「有文字层」的最少字符数，低于此视为扫描件 */
const PDF_TEXT_MIN = 20;
/** PDF 文字层质量下限：低于此即便有字也当扫描件走 OCR（质量分来自 Python 提取器） */
const PDF_QUALITY_MIN = 0.35;
/** 有文字层时先看几页；首页稀疏（目录页/封面）时再看几页拼起来 */
const PDF_FIRST_PAGES = 1;
const PDF_MORE_PAGES = 3;

export type ExtractResult =
  | { kind: 'text'; text: string; method?: string }
  | { kind: 'image'; dataUrl: string; method?: string }
  | { kind: 'unsupported'; reason: string; method?: string };

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.yml', '.yaml', '.xml', '.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const SHEET_EXT = new Set(['.xlsx', '.xls']);

/** 有界读取文件头部（不会因超大文件撑爆内存） */
async function readHead(filePath: string, bytes = HEAD_BYTES): Promise<string> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await fh.close();
  }
}

/** 归一空白 + 截断 */
function clip(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, TEXT_LIMIT);
}

/** ESM/CJS 双态取默认导出 */
function pickDefault<T>(mod: T): T {
  return ((mod as unknown as { default?: T }).default ?? mod) as T;
}

/** 判断一段文字是否「够判断」：去掉页码/水印这类噪音后仍有一定信息量 */
function informative(text: string): boolean {
  const core = text
    .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '')
    .replace(/-?\s*\d+\s*-/g, '')
    .replace(/\s+/g, '');
  return core.length >= PDF_TEXT_MIN;
}

/** OCR 一条链路：走 bob-ocr-mcp（与 read_attachment / 资料索引同一出口）。不可用时返回 null。 */
async function ocrText(filePath: string): Promise<string | null> {
  try {
    const { tryOcrViaMcp } = await import('@/lib/mcp/ocr-client');
    // upgrade='off'：批量整理不做 VLM 升级，避免逐页产生视觉模型费用
    const res = await tryOcrViaMcp(filePath, 'off');
    if (!res?.success) return null;
    const first = res.pages?.[0]?.text?.trim();
    const text = (first && informative(first) ? first : res.text) || '';
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * PDF：复用项目既有管线。
 *   1) Python（pypdf → pdfplumber → 逐页 hybrid）取第 1 页；
 *   2) 首页稀疏时再看 3 页拼起来（封面/目录页常见）；
 *   3) 扫不出字 / 质量分过低 → bob-ocr-mcp 识别；
 *   4) OCR 也不可用 → 明确报错（不再尝试渲染成图，那条链路在打包版必坏）。
 */
async function extractPdf(filePath: string): Promise<ExtractResult> {
  // ---- 1) 文字层：先只取第 1 页（省成本），不够用再多取几页兜一次 ----
  let pageText = '';
  let method = '';
  let quality = 0;
  const take = (res: { text?: string; pageTexts?: string[]; quality?: number; method?: string }) => {
    const first = res.pageTexts?.[0] || '';
    const all = res.text || '';
    // 多取几页时用全文（首页可能只是封面），单页时用首页
    pageText = informative(all) && all.length > first.length ? all : (first || all);
    quality = res.quality ?? 0;
    method = res.method || '';
  };
  try {
    take(await extractWithPython(filePath, PDF_FIRST_PAGES));
  } catch {
    /* 落到 pdf-parse */
  }
  if (!informative(pageText) || quality < PDF_QUALITY_MIN) {
    try {
      // 首页是封面/目录页，或文字层质量偏低 → 再取几页拼起来判断
      const more = await extractWithPython(filePath, PDF_MORE_PAGES);
      if (informative(more.text || '') || !pageText.trim()) take(more);
      else if ((more.quality ?? 0) > quality) quality = more.quality ?? quality;
    } catch {
      /* 保持首页结果 */
    }
  }
  if (!pageText.trim()) {
    try {
      take(await extractWithPdfParse(filePath));
    } catch {
      /* 落到 OCR */
    }
  }
  if (informative(pageText) && quality >= PDF_QUALITY_MIN) {
    return { kind: 'text', text: clip(pageText), method: `pdf-text:${method || 'unknown'}` };
  }

  // ---- 2) 扫描件：走 OCR ----
  const ocr = await ocrText(filePath);
  if (ocr) return { kind: 'text', text: clip(ocr), method: 'pdf-ocr' };

  if (pageText.trim()) {
    // 有字但质量偏低，OCR 又不可用：宁可交低质量文本，也不要白丢文件
    return { kind: 'text', text: clip(pageText), method: `pdf-lowq:${method || 'unknown'}` };
  }
  return {
    kind: 'unsupported',
    reason: `PDF 无文字层且 OCR 不可用（提取方式 ${method || '未知'}）`,
    method: 'pdf-empty',
  };
}

/** docx：mammoth 抽纯文本 */
async function extractDocx(filePath: string): Promise<ExtractResult> {
  const mammoth = pickDefault(await import('mammoth')) as unknown as {
    extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const res = await mammoth.extractRawText({ buffer: await fs.readFile(filePath) });
  const text = (res.value || '').trim();
  return text
    ? { kind: 'text', text: clip(text), method: 'docx-mammoth' }
    : { kind: 'unsupported', reason: 'docx 无文本内容', method: 'docx-empty' };
}

/** 旧版 .doc：走系统 textutil（macOS 自带，无第三方依赖）；失败则明确报错，不硬撑 */
async function extractLegacyDoc(filePath: string): Promise<ExtractResult> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  try {
    const { stdout } = await promisify(execFile)(
      'textutil', ['-convert', 'txt', '-stdout', filePath],
      { timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
    );
    const text = String(stdout || '').trim();
    return text
      ? { kind: 'text', text: clip(text), method: 'doc-textutil' }
      : { kind: 'unsupported', reason: 'doc 无文本内容', method: 'doc-empty' };
  } catch (e) {
    return { kind: 'unsupported', reason: `doc 转换失败：${(e as Error)?.message || e}`, method: 'doc-failed' };
  }
}

/** 电子表格：首个工作表的表头 + 前 N 行 */
async function extractSheet(filePath: string): Promise<ExtractResult> {
  const XLSX = pickDefault(await import('xlsx')) as unknown as {
    read: (b: Buffer, o: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> };
    utils: { sheet_to_json: (s: unknown, o: { header: number; blankrows: boolean }) => unknown[][] };
  };
  const wb = XLSX.read(await fs.readFile(filePath), { type: 'buffer' });
  const first = wb.SheetNames[0];
  if (!first) return { kind: 'unsupported', reason: '工作簿无工作表', method: 'sheet-empty' };
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[first], { header: 1, blankrows: false });
  const body = rows
    .slice(0, SPREADSHEET_ROWS)
    .map((r) => (Array.isArray(r) ? r.join(' | ') : String(r)))
    .join('\n');
  return body.trim()
    ? { kind: 'text', text: clip(`工作表：${first}\n${body}`), method: 'sheet-first' }
    : { kind: 'unsupported', reason: '工作表为空', method: 'sheet-empty' };
}

/** 图片：先 OCR 取字（可判类型），取不到再转 data URL 交视觉模型 */
async function extractImage(filePath: string, ext: string): Promise<ExtractResult> {
  const ocr = await ocrText(filePath);
  if (ocr) return { kind: 'text', text: clip(ocr), method: 'image-ocr' };
  const buf = await fs.readFile(filePath);
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return { kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, method: 'image-vision' };
}

/** 按扩展名抽取「首页」内容 */
export async function extract(filePath: string): Promise<ExtractResult> {
  const ext = extname(filePath).toLowerCase();
  try {
    if (TEXT_EXT.has(ext)) {
      const text = clip(await readHead(filePath));
      return text ? { kind: 'text', text, method: 'text-head' } : { kind: 'unsupported', reason: '文件为空', method: 'text-empty' };
    }
    if (ext === '.pdf') return await extractPdf(filePath);
    if (ext === '.docx') return await extractDocx(filePath);
    if (ext === '.doc') return await extractLegacyDoc(filePath);
    if (SHEET_EXT.has(ext)) return await extractSheet(filePath);
    if (IMAGE_EXT.has(ext)) return await extractImage(filePath, ext);
    return { kind: 'unsupported', reason: `暂不支持的格式 ${ext || '(无扩展名)'}`, method: 'unsupported-ext' };
  } catch (e) {
    return { kind: 'unsupported', reason: `解析失败：${(e as Error)?.message || e}`, method: 'extract-error' };
  }
}
