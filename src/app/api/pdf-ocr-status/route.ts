import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { resolve, dirname, extname } from 'path';

/**
 * PDF OCR 状态 sidecar API
 *
 * OCR 结果不写入 PDF 原文件，而是存到同目录独立 JSON：<pdf绝对路径>.ocr.json
 * 持久化「已识别」标记 + 逐页识别结果（text + 行级坐标骨架），使：
 *   - 重新打开同一扫描件 → 直接显示「已识别」，可检索、可看文本层，无需二次 OCR
 *   - 完成浮层可展示识别页数 / 升级页数 / 耗时
 *
 * - GET  ?path=<pdf绝对路径>  读取 sidecar（不存在返回 exists:false）
 * - POST body { path, meta, pages }  原子写入（tmp + rename）
 */

/** OCR 持久化元数据 */
export interface OcrStatusMeta {
  done: boolean;
  pageCount: number;
  upgradedCount: number;
  elapsedMs: number;
  ocrAt: string;
}

/** sidecar 中的逐页识别结果（与 lib/pdf/text-search OcrPageText 对齐） */
interface OcrSidecarPage {
  page: number;
  text: string;
  blocks?: Array<{ text: string; x: number; y: number; w: number; h: number }>;
}

/** 由 PDF 绝对路径推导 sidecar 路径 */
function sidecarPathFor(pdfPath: string): string {
  return pdfPath + '.ocr.json';
}

function isValidMeta(m: unknown): m is OcrStatusMeta {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return o.done === true && typeof o.pageCount === 'number';
}

function isValidPage(p: unknown): p is OcrSidecarPage {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.page === 'number' && typeof o.text === 'string';
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get('path');
  if (!path) {
    return NextResponse.json({ success: false, error: 'path is required' }, { status: 400 });
  }
  if (extname(path).toLowerCase() !== '.pdf') {
    return NextResponse.json({ success: false, error: 'path must be a PDF file' }, { status: 400 });
  }
  const sidecar = sidecarPathFor(resolve(path));
  try {
    const content = await fs.readFile(sidecar, 'utf-8');
    const data = JSON.parse(content) as { meta?: unknown; pages?: unknown[] };
    if (!isValidMeta(data.meta)) {
      return NextResponse.json({ success: true, exists: false, meta: null, pages: [] });
    }
    return NextResponse.json({
      success: true,
      exists: true,
      meta: data.meta,
      pages: Array.isArray(data.pages) ? data.pages.filter(isValidPage) : [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) {
      return NextResponse.json({ success: true, exists: false, meta: null, pages: [] });
    }
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { path?: string; meta?: unknown; pages?: unknown[] };
    const path = body.path;
    if (!path) {
      return NextResponse.json({ success: false, error: 'path is required' }, { status: 400 });
    }
    if (extname(path).toLowerCase() !== '.pdf') {
      return NextResponse.json({ success: false, error: 'path must be a PDF file' }, { status: 400 });
    }
    if (!isValidMeta(body.meta)) {
      return NextResponse.json({ success: false, error: 'meta must be a valid OCR status object' }, { status: 400 });
    }
    const pages = Array.isArray(body.pages) ? body.pages.filter(isValidPage) : [];
    const sidecar = sidecarPathFor(resolve(path));
    const payload = {
      version: 1,
      pdfPath: resolve(path),
      updatedAt: new Date().toISOString(),
      meta: body.meta,
      pages,
    };
    // 原子写入：先写临时文件再 rename，避免进程中断导致 sidecar 损坏
    await fs.mkdir(dirname(sidecar), { recursive: true });
    const tmp = sidecar + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf-8');
    await fs.rename(tmp, sidecar);
    return NextResponse.json({ success: true, updatedAt: payload.updatedAt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
