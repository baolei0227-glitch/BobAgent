/**
 * 首页正文抽取 —— 只读「第一个信息单位」，把单文件 token 成本压到 ~1.5k。
 *
 * 各类型策略：
 *   txt/md/csv/json/log   前 1500 字
 *   docx                  mammoth 抽纯文本 → 前 1500 字
 *   xlsx                  首个工作表：表头 + 前 20 行
 *   pdf（有文字层）         仅第 1 页
 *   pdf（扫描件）           渲染第 1 页交视觉模型
 *   图片                   原图交视觉模型
 *
 * 设计取舍：日期以「执行命名日期」为准，所以不必为了拿签署日去读末页，
 * 只读首页即可，成本再降一半。
 */
import { promises as fs } from 'fs';
import { extname } from 'path';

/** 送入模型的正文上限（字符） */
const TEXT_LIMIT = 1500;
/** 文本文件的有界读取上限（字节），避免大日志撑爆内存 */
const HEAD_BYTES = 64 * 1024;
/** 电子表格送入模型的行数上限 */
const SPREADSHEET_ROWS = 20;
/** PDF 判定为「有文字层」的最少字符数，低于此视为扫描件 */
const PDF_TEXT_MIN = 20;

export type ExtractResult =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'unsupported'; reason: string };

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

/** PDF：先取第 1 页文字；无文字层（扫描件）则渲染第 1 页转视觉识别 */
async function extractPdf(filePath: string): Promise<ExtractResult> {
  const { PDFParse } = pickDefault(await import('pdf-parse'));
  const data = new Uint8Array(await fs.readFile(filePath));
  const parser = new PDFParse({ data });
  try {
    const page1 = (await parser.getText({ first: 1 })).text || '';
    if (page1.trim().length >= PDF_TEXT_MIN) return { kind: 'text', text: clip(page1) };
    try {
      const shot = await parser.getScreenshot({ partial: [1], desiredWidth: 1400, imageDataUrl: true });
      const dataUrl = shot.pages?.[0]?.dataUrl;
      if (dataUrl) return { kind: 'image', dataUrl };
    } catch {
      /* 渲染失败（缺少原生 canvas 等）→ 落到不支持 */
    }
    return { kind: 'unsupported', reason: 'PDF 无文字层且无法渲染首页' };
  } finally {
    await parser.destroy();
  }
}

/** docx：mammoth 抽纯文本 */
async function extractDocx(filePath: string): Promise<ExtractResult> {
  const mammoth = pickDefault(await import('mammoth')) as unknown as {
    extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const res = await mammoth.extractRawText({ buffer: await fs.readFile(filePath) });
  const text = (res.value || '').trim();
  return text ? { kind: 'text', text: clip(text) } : { kind: 'unsupported', reason: 'docx 无文本内容' };
}

/** 电子表格：首个工作表的表头 + 前 N 行 */
async function extractSheet(filePath: string): Promise<ExtractResult> {
  const XLSX = pickDefault(await import('xlsx')) as unknown as {
    read: (b: Buffer, o: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> };
    utils: { sheet_to_json: (s: unknown, o: { header: number; blankrows: boolean }) => unknown[][] };
  };
  const wb = XLSX.read(await fs.readFile(filePath), { type: 'buffer' });
  const first = wb.SheetNames[0];
  if (!first) return { kind: 'unsupported', reason: '工作簿无工作表' };
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[first], { header: 1, blankrows: false });
  const body = rows
    .slice(0, SPREADSHEET_ROWS)
    .map((r) => (Array.isArray(r) ? r.join(' | ') : String(r)))
    .join('\n');
  return body.trim()
    ? { kind: 'text', text: clip(`工作表：${first}\n${body}`) }
    : { kind: 'unsupported', reason: '工作表为空' };
}

/** 图片：转 data URL 交视觉模型 */
async function extractImage(filePath: string, ext: string): Promise<ExtractResult> {
  const buf = await fs.readFile(filePath);
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return { kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

/** 按扩展名抽取「首页」内容 */
export async function extract(filePath: string): Promise<ExtractResult> {
  const ext = extname(filePath).toLowerCase();
  try {
    if (TEXT_EXT.has(ext)) {
      const text = clip(await readHead(filePath));
      return text ? { kind: 'text', text } : { kind: 'unsupported', reason: '文件为空' };
    }
    if (ext === '.pdf') return await extractPdf(filePath);
    if (ext === '.docx') return await extractDocx(filePath);
    if (SHEET_EXT.has(ext)) return await extractSheet(filePath);
    if (IMAGE_EXT.has(ext)) return await extractImage(filePath, ext);
    return { kind: 'unsupported', reason: `暂不支持的格式 ${ext || '(无扩展名)'}` };
  } catch (e) {
    return { kind: 'unsupported', reason: `解析失败：${(e as Error)?.message || e}` };
  }
}
