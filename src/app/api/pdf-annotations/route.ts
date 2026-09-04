import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { resolve, dirname, extname } from 'path';

/**
 * PDF 批注 sidecar API（方案 A）
 *
 * 批注不写入 PDF 原文件，而是存到同目录独立 JSON 文件：<pdf绝对路径>.annotations.json
 *
 * - GET  ?path=<pdf绝对路径>  读取 sidecar（不存在返回空列表 + exists:false）
 * - POST body { path, annotations }  原子写入（tmp + rename，避免写一半损坏）
 *
 * 批注坐标一律使用「页面归一化坐标」（0~1 相对页面宽高），
 * 渲染时乘以当前 viewport 尺寸即可，任意缩放/翻页均能正确定位。
 */

export interface PdfAnnotation {
  id: string;
  type: 'highlight' | 'textbox';
  /** 页码（从 1 开始，与 PDF.js 一致） */
  page: number;
  /** 归一化坐标：0~1，相对页面（viewport scale=1 时的页面宽高） */
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  /** textbox 的文本内容 */
  text?: string;
  /** textbox 文字字号（px，缺省 12） */
  fontSize?: number;
  createdAt: string;
  updatedAt: string;
}

/** 由 PDF 绝对路径推导 sidecar 路径 */
function sidecarPathFor(pdfPath: string): string {
  return pdfPath + '.annotations.json';
}

function isValidAnnotation(a: unknown): a is PdfAnnotation {
  if (!a || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    (o.type === 'highlight' || o.type === 'textbox') &&
    typeof o.page === 'number' &&
    typeof o.x === 'number' &&
    typeof o.y === 'number' &&
    typeof o.width === 'number' &&
    typeof o.height === 'number' &&
    typeof o.color === 'string' &&
    (o.fontSize === undefined || typeof o.fontSize === 'number')
  );
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
    const data = JSON.parse(content) as {
      annotations?: unknown[];
      updatedAt?: string;
    };
    return NextResponse.json({
      success: true,
      exists: true,
      annotations: Array.isArray(data.annotations) ? data.annotations.filter(isValidAnnotation) : [],
      updatedAt: data.updatedAt || '',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) {
      return NextResponse.json({ success: true, exists: false, annotations: [] });
    }
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { path?: string; annotations?: unknown[] };
    const path = body.path;
    if (!path) {
      return NextResponse.json({ success: false, error: 'path is required' }, { status: 400 });
    }
    if (extname(path).toLowerCase() !== '.pdf') {
      return NextResponse.json({ success: false, error: 'path must be a PDF file' }, { status: 400 });
    }
    if (!Array.isArray(body.annotations) || !body.annotations.every(isValidAnnotation)) {
      return NextResponse.json({ success: false, error: 'annotations must be a valid array' }, { status: 400 });
    }
    const sidecar = sidecarPathFor(resolve(path));
    const payload = {
      version: 1,
      pdfPath: resolve(path),
      updatedAt: new Date().toISOString(),
      annotations: body.annotations,
    };
    // 原子写入：先写临时文件再 rename，避免进程中断导致 sidecar 损坏
    await fs.mkdir(dirname(sidecar), { recursive: true });
    const tmp = sidecar + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    await fs.rename(tmp, sidecar);
    return NextResponse.json({ success: true, updatedAt: payload.updatedAt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
