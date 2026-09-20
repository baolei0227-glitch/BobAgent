import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { resolve, dirname, extname, sep } from 'path';

/**
 * PDF OCR 状态 sidecar API
 *
 * OCR 结果不写入 PDF 原文件，而是存到同目录独立 JSON：<pdf绝对路径>.ocr.json
 * 持久化「已识别」标记 + 逐页识别结果（text + 行级坐标骨架），使：
 *   - 重新打开同一扫描件 → 直接显示「已识别」，可检索、可看文本层，无需二次 OCR
 *   - 完成浮层可展示识别页数 / 升级页数 / 耗时
 *
 * - GET  ?path=<pdf绝对路径>  读取「已解析」状态，两级：
 *   ① sidecar（<pdf>.ocr.json）：手动 OCR 的产物，按路径精确命中；
 *   ② 统一兜底 resolveOcrState()：算出 PDF 内容 hash，去项目内两处**内容寻址**存储里找
 *      已解析结果（.materials-index/<hash>/ 与 .cache/parse/<hash>.json）→ 预览直接复用，免二次 OCR。
 *      判据只有「内容 hash」，与文件放在 materials / attachments 哪个目录无关。
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

/**
 * 由 PDF 绝对路径定位其所属项目根。
 *
 * 项目根在 ~/.projects.json 中登记（config.projects[].path），故用「最长前缀匹配」精确反查。
 * 这样读取侧与写入侧（getCurrentProject）对齐到同一坐标系，不再依赖路径里是否出现
 * materials / attachments 目录名——那种猜法会让「上传到 materials 的文件」与
 * 「对话附件」各自只走通一半兜底。
 */
async function resolveProjectRootFor(pdfAbsPath: string): Promise<string | null> {
  try {
    const { readConfig } = await import('@/lib/project/project-manager');
    const config = await readConfig();
    const abs = resolve(pdfAbsPath);
    let best: string | null = null;
    for (const p of config.projects) {
      if (!p.path) continue;
      const root = resolve(p.path);
      if ((abs === root || abs.startsWith(root + sep)) && (!best || root.length > best.length)) {
        best = root;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 统一解析「这份 PDF 是否已解析过」——内容 hash 直达项目内两处**内容寻址**存储：
 *   ① <项目>/.materials-index/<hash>/   索引阶段（上传 / 首次读取）产出的本地 OCR 结果
 *   ② <项目>/.cache/parse/<hash>.json   对话解析缓存
 * 判据只有「内容 hash」，与文件放在哪个目录无关；命中任一即返回「已识别 + 逐页文本」，
 * 供预览直接复用，免二次 OCR。不在任何已登记项目内 / 未解析过 → null。
 */
async function resolveOcrState(
  pdfAbsPath: string,
): Promise<{ meta: OcrStatusMeta; pages: OcrSidecarPage[] } | null> {
  const abs = resolve(pdfAbsPath);
  const projectPath = await resolveProjectRootFor(abs);
  if (!projectPath) return null;

  let hash: string;
  try {
    const { computeFileHash } = await import('@/lib/parse/image-parser');
    hash = await computeFileHash(abs);
  } catch {
    return null;
  }

  const [{ getIndexedOcrPagesByHash }, { getCache }, { splitOcrPagesFromText }] = await Promise.all([
    import('@/lib/materials/indexer'),
    import('@/lib/parse/cache'),
    import('@/lib/pdf/text-search'),
  ]);

  // ① 内容索引：项目资产，优先复用
  const indexed = await getIndexedOcrPagesByHash(projectPath, hash).catch(() => null);
  if (indexed && indexed.length > 0) {
    return {
      meta: {
        done: true,
        pageCount: indexed.length,
        upgradedCount: 0, // 索引留存的是最终正文，不记录逐页升级数
        elapsedMs: 0,
        ocrAt: '',
      },
      pages: indexed.map((p) => ({ page: p.page, text: p.text, blocks: p.blocks })),
    };
  }

  // ② 对话解析缓存：只存聚合正文、无行级 blocks → 反解为逐页文本（无高亮框）
  const record = await getCache(hash, projectPath).catch(() => null);
  const text = record?.result?.extracted_text;
  if (!text) return null;
  const parsed = splitOcrPagesFromText(text);
  // 正文无 [Page N] 标记（单页 / 非分页格式）时，退化为整篇一页
  const pages: OcrSidecarPage[] =
    parsed.length > 0
      ? parsed.map((p) => ({ page: p.page, text: p.text }))
      : [{ page: 1, text: text.trim() }].filter((p) => p.text.length > 0);
  if (pages.length === 0) return null;
  return {
    meta: {
      done: true,
      pageCount: record?.result?.page_count ?? pages.length,
      upgradedCount: 0, // 解析缓存只留聚合正文，不记录逐页升级数
      elapsedMs: 0,
      ocrAt: record?.result?.parsed_at ?? '',
    },
    pages,
  };
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
    if (isValidMeta(data.meta)) {
      return NextResponse.json({
        success: true,
        exists: true,
        meta: data.meta,
        pages: Array.isArray(data.pages) ? data.pages.filter(isValidPage) : [],
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 非 ENOENT（sidecar 存在但损坏）仍按「无 sidecar」继续尝试索引兜底
    if (!msg.includes('ENOENT')) {
      return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
  }
  // sidecar 不存在 / 无效 → 统一兜底：由 PDF 内容 hash 去两处内容寻址存储（项目索引 + 对话解析缓存）取已解析结果
  const state = await resolveOcrState(path);
  if (state) {
    return NextResponse.json({
      success: true,
      exists: true,
      meta: state.meta,
      pages: state.pages,
    });
  }
  return NextResponse.json({ success: true, exists: false, meta: null, pages: [] });
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
