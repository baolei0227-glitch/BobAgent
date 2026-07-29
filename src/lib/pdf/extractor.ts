/**
 * PDF 文本提取器
 *
 * 三级降级：
 *   1. Python pypdf/pdfplumber（毫秒级，零成本）→ 原生文本 PDF
 *   2. pypdf 分页 + sips 高分辨率渲染 + Vision model（秒级，API 成本）→ 扫描件 OCR
 *   3. pdf-parse 兜底（Node.js，零成本）
 */

import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execAsync = promisify(exec);

export interface ExtractResult {
  text: string;
  pageCount: number;
  method: 'pypdf' | 'pdfplumber' | 'vision-ocr' | 'pdf-parse' | 'empty' | 'scanned';
  quality?: number;
}

export interface PdfImageResult {
  success: boolean;
  images: string[];
  totalPages: number;
  rendered: number;
  dpi: number;
  tmpDir: string;
}

/** 脚本目录 */
function getScriptsDir(): string {
  return join(process.cwd(), 'scripts');
}

/**
 * 第1+2级：调用 Python 脚本（pypdf → pdfplumber）
 */
export async function extractWithPython(
  pdfPath: string,
  maxPages = 50,
): Promise<ExtractResult> {
  try {
    const { stdout } = await execAsync(
      `python3 "${join(getScriptsDir(), 'pdf_extractor.py')}" "${pdfPath}" --max-pages ${maxPages}`,
      { timeout: 30000 },
    );

    const result = JSON.parse(stdout.trim());

    if (result.success && result.result) {
      return {
        text: result.result,
        pageCount: result.total || result.pages || 0,
        method: result.method as 'pypdf' | 'pdfplumber',
        quality: result.quality,
      };
    }

    if (result.needs_ocr) {
      return {
        text: '',
        pageCount: result.total || 0,
        method: 'scanned',
      };
    }

    return { text: '', pageCount: 0, method: 'empty' };
  } catch {
    return { text: '', pageCount: 0, method: 'empty' };
  }
}

/**
 * 扫描件 OCR：pypdf 分页 + sips 高分辨率渲染 + Vision model
 * 默认 200 DPI，最多 5 页
 */
export async function renderPdfToImages(
  pdfPath: string,
  dpi = 200,
  maxPages = 50,
): Promise<PdfImageResult> {
  try {
    const { stdout } = await execAsync(
      `python3 "${join(getScriptsDir(), 'pdf_to_images.py')}" "${pdfPath}" --dpi ${dpi} --max-pages ${maxPages}`,
      { timeout: 60000 },
    );
    return JSON.parse(stdout.trim());
  } catch {
    return { success: false, images: [], totalPages: 0, rendered: 0, dpi, tmpDir: '' };
  }
}

/**
 * 兜底：使用 pdf-parse 提取文本
 */
export async function extractWithPdfParse(pdfPath: string): Promise<ExtractResult> {
  try {
    const dataBuffer = await fs.readFile(pdfPath);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(dataBuffer);

    return {
      text: data.text || '',
      pageCount: data.numpages || 0,
      method: 'pdf-parse',
    };
  } catch {
    return { text: '', pageCount: 0, method: 'empty' };
  }
}
