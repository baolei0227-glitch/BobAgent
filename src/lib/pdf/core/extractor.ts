/**
 * PDF 文本层提取器
 *
 *   1. Python pypdf/pdfplumber（毫秒级，零成本）→ 原生文本 PDF
 *   2. pdf-parse 兜底（Node.js，零成本）
 *
 * 扫描件 OCR 已完全收敛到 bob-ocr-mcp 插件（见 core/ocr-service.ts），本文件不再承载任何本地识别引擎。
 */

import { promises as fs, accessSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import type { PageRoute } from '../shared/types';

const execAsync = promisify(exec);

export interface ExtractResult {
  text: string;
  pageCount: number;
  method: 'pypdf' | 'pdfplumber' | 'vision-ocr' | 'pdf-parse' | 'empty' | 'scanned' | 'hybrid';
  quality?: number;
  /** 逐页路由（P0-6 PageRoute：coordinate_text / hybrid / ocr / failed） */
  pageRoutes?: PageRoute[];
  /** 逐页文本（逐页路由为 coordinate_text / hybrid 时可直接取用；ocr 页由上层再走 OCR 填回） */
  pageTexts?: string[];
  /** 逐页单页质量（TS quality-scorer 同维度） */
  pageQualities?: number[];
  /** 有任何一页需要 OCR（route=ocr|hybrid），旧消费者可直接用 needs_ocr 判断整体 */
  hasScannedPages?: boolean;
  /** 文本提取失败/异常时的具体原因（脚本报错/超时/依赖缺失），供上层区分损坏 vs 环境 */
  error?: string;
}

/** 脚本目录：兼容 dev（src/lib/pdf/core）和 standalone（scripts）两种运行模式
 *  2026-08：脚本从 src/lib/pdf/ 下移到 src/lib/pdf/core/，先尝试新路径，再保留旧路径兼容。 */
function getScriptsDir(): string {
  const devDir = join(process.cwd(), 'src', 'lib', 'pdf', 'core');
  const devDirLegacy = join(process.cwd(), 'src', 'lib', 'pdf');
  const standaloneDir = join(process.cwd(), 'scripts');
  // standalone 模式下 scripts/ 包含 Python 脚本副本（由 build-electron.sh 复制）
  try {
    accessSync(join(standaloneDir, 'pdf_extractor.py'));
    return standaloneDir;
  } catch {}
  try {
    accessSync(join(devDir, 'pdf_extractor.py'));
    return devDir;
  } catch {}
  try {
    accessSync(join(devDirLegacy, 'pdf_extractor.py'));
    return devDirLegacy;
  } catch {}
  return standaloneDir; // 兜底
}

/**
 * 第1+2级：调用 Python 脚本（pypdf → pdfplumber → 逐页融合 hybrid）。
 * 返回逐页 pageRoutes / pageTexts（P0-6），整份仍保留 method / success / needs_ocr 兼容旧消费者。
 */
export async function extractWithPython(
  pdfPath: string,
  maxPages = 500,
): Promise<ExtractResult> {
  try {
    const { stdout } = await execAsync(
      `python3 "${join(getScriptsDir(), 'pdf_extractor.py')}" "${pdfPath}" --max-pages ${maxPages}`,
      { timeout: 30000 },
    );

    const result = JSON.parse(stdout.trim()) as {
      success: boolean;
      result?: string;
      total?: number;
      pages?: number;
      method?: string;
      quality?: number;
      needs_ocr?: boolean;
      has_scanned_pages?: boolean;
      page_routes?: unknown[];
      page_qualities?: unknown[];
      page_texts?: unknown[];
    };

    const toPageRoutes = (raw: unknown[] | undefined): PageRoute[] | undefined => {
      if (!Array.isArray(raw)) return undefined;
      const valid = new Set(['coordinate_text', 'hybrid', 'ocr', 'failed']);
      return raw.filter((r): r is PageRoute => typeof r === 'string' && valid.has(r));
    };
    const toNumArr = (raw: unknown[] | undefined): number[] | undefined =>
      Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : undefined;
    const toStrArr = (raw: unknown[] | undefined): string[] | undefined =>
      Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : undefined;

    const pageRoutes = toPageRoutes(result.page_routes);
    const pageTexts = toStrArr(result.page_texts);
    const pageQualities = toNumArr(result.page_qualities);
    const method = (() => {
      switch (result.method) {
        case 'pypdf':
        case 'pdfplumber':
        case 'hybrid':
          return result.method;
        default:
          return 'scanned';
      }
    })() as ExtractResult['method'];

    if (result.success && result.result) {
      return {
        text: result.result,
        pageCount: result.total || result.pages || 0,
        method,
        quality: result.quality,
        pageRoutes,
        pageTexts,
        pageQualities,
        hasScannedPages: !!result.has_scanned_pages,
      };
    }

    if (result.needs_ocr) {
      return {
        text: '',
        pageCount: result.total || 0,
        method: 'scanned',
        pageRoutes,
        pageTexts,
        pageQualities,
        hasScannedPages: true,
      };
    }

    return { text: '', pageCount: 0, method: 'empty' };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { text: '', pageCount: 0, method: 'empty', error: detail.slice(0, 400) };
  }
}

/**
 * 兜底：使用 pdf-parse 提取文本
 */
export async function extractWithPdfParse(pdfPath: string): Promise<ExtractResult> {
  try {
    const dataBuffer = await fs.readFile(pdfPath);
    // pdf-parse 是按需加载的兜底依赖：仅在 Python 提取失败时动态引入
    const pdfParseMod = await import('pdf-parse');
    type PdfParseFn = (buffer: Buffer) => Promise<{ text?: string; numpages?: number }>;
    const candidate: unknown = (pdfParseMod as { default?: unknown }).default;
    if (typeof candidate !== 'function') {
      return { text: '', pageCount: 0, method: 'empty' };
    }
    const data = await (candidate as PdfParseFn)(dataBuffer);

    return {
      text: data.text || '',
      pageCount: data.numpages || 0,
      method: 'pdf-parse',
    };
  } catch {
    return { text: '', pageCount: 0, method: 'empty' };
  }
}
