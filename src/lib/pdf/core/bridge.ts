/**
 * PDF Bridge
 *
 * 自动提取 PDF 内容并注入到用户消息中。
 *
 * 提取策略：
 *   1. Python pypdf/pdfplumber（毫秒级，零成本）→ 原生文本 PDF
 *   2. 质量评分 ≥ 0.1 → 注入文本
 *   3. 扫描件 → 标记 needs_ocr，由 read_attachment 工具中 sips+Vision 处理
 */

import { extractWithPython, extractWithPdfParse, type ExtractResult } from './extractor';
import { qualityScore } from './quality-scorer';
import type { PageRoute } from '../shared/types';

const QUALITY_THRESHOLD = 0.1;
/** PDF 桥文本返回上限：与 1M 上下文工具输出上限对齐（15 万字符） */
const MAX_TEXT_LENGTH = 150000;
/** A2 后台预热阈值：≤ 该页数的扫描件在请求入口处异步预识别写缓存；更多页走强制委派按页段分片并行 */
export const PREWARM_MAX_PAGES = 8;

export interface PdfExtractResult {
  path: string;
  text: string;
  method: string;
  pageCount: number;
  quality: number;
  /** 逐页路由（P0-6：coordinate_text / hybrid / ocr / failed） */
  pageRoutes?: PageRoute[];
  /** 路由分布摘要（"total_pages=12, coordinate_text=8, hybrid=2, ocr=2" 形式），用于注入文本给模型看 */
  routeSummary?: string;
  /** 是否含扫描页（ocr 或 hybrid）；纯 coordinate_text 才会 false */
  hasScannedPages?: boolean;
}

/**
 * 从用户消息中提取 PDF 附件路径列表
 * 匹配格式: 路径: {attachments|assets}/{nodeId}/{filename}.pdf
 */
function extractPdfPaths(content: string): string[] {
  const paths: string[] = [];
  const regex = /路径:\s*((?:attachments|assets)\/[^\s\n]*\.pdf)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  return [...new Set(paths)];
}

/**
 * 提取单个 PDF 的内容
 */
async function extractOnePdf(
  projectPath: string,
  relativePath: string,
): Promise<PdfExtractResult> {
  const { join } = await import('path');
  const fullPath = join(projectPath, relativePath);

  // 第1+2级：Python pypdf → pdfplumber（返回逐页 pageRoutes）
  const pyResult = await extractWithPython(fullPath);

  const summarize = (routes?: PageRoute[]) => {
    if (!routes || routes.length === 0) return null as string | null;
    const count = (s: PageRoute) => routes.filter((r) => r === s).length;
    const parts: string[] = [];
    const ct = count('coordinate_text');
    const hy = count('hybrid');
    const oc = count('ocr');
    const fa = count('failed');
    if (ct) parts.push(`coordinate_text=${ct}`);
    if (hy) parts.push(`hybrid=${hy}`);
    if (oc) parts.push(`ocr=${oc}`);
    if (fa) parts.push(`failed=${fa}`);
    return `total_pages=${routes.length}, ${parts.join(', ')}`;
  };

  // P0-6：是否为「扫描件」不再只看整份 needs_ocr（method=scanned），而是逐页判断：
  //   - 全页都 = ocr → 纯扫描件，text 不注入，让 AI 调 read_attachment
  //   - 否则：即使有 ocr/hybrid 页，也把 coordinate_text/hybrid 的文本先注入，并在 summary 里告诉模型哪些页需要读附件
  const pageRoutes = (pyResult.pageRoutes?.length ?? 0) > 0 ? pyResult.pageRoutes : undefined;
  const allOcr = !!pageRoutes && pageRoutes.length > 0 && pageRoutes.every((r) => r === 'ocr');
  const hasScanned = !!pyResult.hasScannedPages || !!pageRoutes?.some((r) => r === 'ocr' || r === 'hybrid');

  if (pyResult.text && pyResult.text.length > 20) {
    const q = pyResult.quality ?? qualityScore(pyResult.text);
    if (q >= QUALITY_THRESHOLD) {
      return {
        path: relativePath,
        text: pyResult.text,
        method: pyResult.method,
        pageCount: pyResult.pageCount,
        quality: q,
        pageRoutes,
        routeSummary: summarize(pageRoutes) ?? undefined,
        hasScannedPages: hasScanned,
      };
    }
  }

  // Python 失败/扫描件 → 兜底 pdf-parse
  const fallback = await extractWithPdfParse(fullPath);
  if (fallback.text && fallback.text.length > 20) {
    const q = qualityScore(fallback.text);
    if (q >= QUALITY_THRESHOLD) {
      return {
        path: relativePath,
        text: fallback.text,
        method: 'pdf-parse',
        pageCount: fallback.pageCount,
        quality: q,
        hasScannedPages: hasScanned,
      };
    }
  }

  // 扫描件 / 无法提取文本
  return {
    path: relativePath,
    text: '',
    method: 'scanned',
    pageCount: pyResult.pageCount || fallback.pageCount,
    quality: 0,
    pageRoutes,
    routeSummary: summarize(pageRoutes) ?? undefined,
    hasScannedPages: true,
  };
}

/**
 * PDF Bridge 主入口
 *
 * 检测用户消息中的 PDF 附件，提取文本内容并注入到消息末尾。
 * 文本 PDF 直接注入内容，扫描件提示 AI 使用 read_attachment 工具。
 */
export async function applyPdfBridge<T extends { role: string; content?: string }>(
  messages: T[],
  projectPath: string,
): Promise<T[]> {
  // 1. 检测是否有 PDF 附件
  let hasPdf = false;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const content = m.content ?? '';
    if (content.includes('.pdf') && (content.includes('attachments/') || content.includes('assets/'))) {
      hasPdf = true;
      break;
    }
  }
  if (!hasPdf) return messages;

  // 2. 收集所有 PDF 路径
  const allPdfPaths: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    allPdfPaths.push(...extractPdfPaths(m.content ?? ''));
  }
  if (allPdfPaths.length === 0) return messages;

  // 3. 提取每个 PDF
  const results = await Promise.all(allPdfPaths.map((p) => extractOnePdf(projectPath, p)));

  // 4. 分类结果
  //    P0-6 新分类：
  //     - textResults：有可注入文本（method !== scanned 且 text 存在）；
  //        即使含少量 ocr/hybrid 页也先注入 coordinate_text 可信部分，并在 header 里提醒缺失页。
  //     - scannedResults：method === scanned（全页 ocr 或 Python / pdf-parse 都失败）→ 完全没文本，
  //        提示 AI 调 read_attachment，并在后台 prewarm ocrFile 写缓存。
  const textResults = results.filter((r) => r.method !== 'scanned' && r.text);
  const scannedResults = results.filter((r) => r.method === 'scanned');

  // 5. 构建注入文本
  const parts: string[] = [];

  for (const r of textResults) {
    const truncated = r.text.length > MAX_TEXT_LENGTH
      ? r.text.slice(0, MAX_TEXT_LENGTH) + `\n... (${r.pageCount} pages, truncated to ${MAX_TEXT_LENGTH} chars)`
      : r.text;
    const header = [`Method: ${r.method} | Quality: ${r.quality.toFixed(2)} | Pages: ${r.pageCount}`];
    if (r.routeSummary) header.push(`Per-page route: ${r.routeSummary}`);
    if (r.hasScannedPages) {
      const onlyOcr = r.pageRoutes && r.pageRoutes.length > 0 && r.pageRoutes.every((x) => x === 'ocr');
      if (onlyOcr) {
        // 理论上 onlyOcr 且有非空 text 的分支不会命中（onlyOcr 会被 extractOnePdf 归到 scannedResults），这里兜底写
        header.push('⚠️  All pages are image-based (scanned). 已注入内容不完整，请对本 PDF 调用 read_attachment 工具做 OCR 识别。');
      } else {
        header.push('ℹ️  Some pages (ocr/hybrid) are image-based or partially text-covered. 已先注入 coordinate_text 页内容，ocr/hybrid 缺失页请对本 PDF 调用 read_attachment 工具补识别。');
      }
    }
    parts.push(`[PDF: ${r.path}]\n${header.join('\n')}\n\n${truncated}`);
  }

  for (const r of scannedResults) {
    parts.push(`[PDF: ${r.path}]\nScanned PDF (${r.pageCount || '?'} pages)${r.routeSummary ? ` · ${r.routeSummary}` : ''}. This PDF appears to be scanned or image-based. Use read_attachment tool to OCR via vision model.`);
    // A2 后台预热：≤8 页扫描件 fire-and-forget 预识别并写入 PDF 缓存（复用 read_attachment 同款缓存），
    // 模型随后调用 read_attachment 直接命中缓存，感知延迟≈0；预热失败/未完成不影响主流程（走正常工具链路）。
    if (r.pageCount > 0 && r.pageCount <= PREWARM_MAX_PAGES) {
      void (async () => {
        const t0 = Date.now();
        try {
          const { join, basename } = await import('path');
          const fullPath = join(projectPath, r.path);
          const { computeFileHash } = await import('@/lib/parse/image-parser');
          const { getCache, setCache, markPdfWarming, isPdfWarming } = await import('@/lib/parse/cache');
          const hash = await computeFileHash(fullPath);
          const cacheKey = `${projectPath}::${hash}`;
          const existing = await getCache(hash, projectPath);
          if (existing?.result?.extracted_text) {
            console.log(`[pdf-bridge-prewarm] ${basename(fullPath)} (${r.pageCount}p) cache-hit, skip warm (${Date.now() - t0}ms)`);
            return;
          }
          if (isPdfWarming(cacheKey)) {
            console.log(`[pdf-bridge-prewarm] ${basename(fullPath)} warming-in-progress, skip duplicate`);
            return;
          }
          markPdfWarming(cacheKey, true);
          console.log(`[pdf-bridge-prewarm] ${basename(fullPath)} (${r.pageCount}p) start warming…`);
          const { ocrFile } = await import('@/lib/pdf/ocr-service');
          const res = await ocrFile(fullPath, { projectPath });
          if (res.success && res.text.trim()) {
            await setCache(hash, {
              file_name: basename(fullPath),
              file_type: 'pdf',
              mime_type: 'application/pdf',
              extracted_text: res.text,
              parse_method: 'text_extract',
              parsed_at: new Date().toISOString(),
              file_hash: hash,
            }, projectPath);
            console.log(`[pdf-bridge-prewarm] ${basename(fullPath)} cache-written in ${Date.now() - t0}ms, ${res.text.length} chars, upgraded=${res.upgradedCount}/${res.pageCount}p`);
          } else {
            console.log(`[pdf-bridge-prewarm] ${basename(fullPath)} ocrFile returned empty in ${Date.now() - t0}ms`);
          }
        } catch (e) {
          console.log(`[pdf-bridge-prewarm] failed after ${Date.now() - t0}ms:`, e instanceof Error ? e.message : String(e));
        } finally {
          try {
            const { join, basename } = await import('path');
            const fullPath = join(projectPath, r.path);
            const { computeFileHash } = await import('@/lib/parse/image-parser');
            const { markPdfWarming } = await import('@/lib/parse/cache');
            const hash = await computeFileHash(fullPath);
            markPdfWarming(`${projectPath}::${hash}`, false);
          } catch { /* cleanup ignore */ }
        }
      })();
    }
  }

  if (parts.length === 0) return messages;

  // 6. 注入到 user 消息末尾
  const injection = '\n\n[PDF document content auto-extracted below]\n\n' + parts.join('\n\n---\n\n');

  return messages.map((m) => {
    if (m.role !== 'user') return m;
    return { ...m, role: m.role, content: (m.content ?? '') + injection };
  });
}
