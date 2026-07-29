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

import { extractWithPython, extractWithPdfParse } from './extractor';
import { qualityScore } from './quality-scorer';

const QUALITY_THRESHOLD = 0.1;
const MAX_TEXT_LENGTH = 50000;

export interface PdfExtractResult {
  path: string;
  text: string;
  method: string;
  pageCount: number;
  quality: number;
}

/**
 * 从用户消息中提取 PDF 附件路径列表
 * 匹配格式: 路径: assets/{nodeId}/{filename}.pdf
 */
function extractPdfPaths(content: string): string[] {
  const paths: string[] = [];
  const regex = /路径:\s*(assets\/[^\s\n]*\.pdf)/gi;
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

  // 第1+2级：Python pypdf → pdfplumber
  const pyResult = await extractWithPython(fullPath);

  if (pyResult.text && pyResult.text.length > 20) {
    const q = pyResult.quality ?? qualityScore(pyResult.text);
    if (q >= QUALITY_THRESHOLD) {
      return {
        path: relativePath,
        text: pyResult.text,
        method: pyResult.method,
        pageCount: pyResult.pageCount,
        quality: q,
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
  };
}

/**
 * PDF Bridge 主入口
 *
 * 检测用户消息中的 PDF 附件，提取文本内容并注入到消息末尾。
 * 文本 PDF 直接注入内容，扫描件提示 AI 使用 read_attachment 工具。
 */
export async function applyPdfBridge<T extends { role: string; content: string }>(
  messages: T[],
  projectPath: string,
): Promise<T[]> {
  // 1. 检测是否有 PDF 附件
  let hasPdf = false;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (m.content.includes('.pdf') && m.content.includes('assets/')) {
      hasPdf = true;
      break;
    }
  }
  if (!hasPdf) return messages;

  // 2. 收集所有 PDF 路径
  const allPdfPaths: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    allPdfPaths.push(...extractPdfPaths(m.content));
  }
  if (allPdfPaths.length === 0) return messages;

  // 3. 提取每个 PDF
  const results = await Promise.all(allPdfPaths.map((p) => extractOnePdf(projectPath, p)));

  // 4. 分类结果
  const textResults = results.filter((r) => r.method !== 'scanned' && r.text);
  const scannedResults = results.filter((r) => r.method === 'scanned');

  // 5. 构建注入文本
  const parts: string[] = [];

  for (const r of textResults) {
    const truncated = r.text.length > MAX_TEXT_LENGTH
      ? r.text.slice(0, MAX_TEXT_LENGTH) + `\n... (${r.pageCount} pages, truncated to ${MAX_TEXT_LENGTH} chars)`
      : r.text;
    parts.push(`[PDF: ${r.path}]\nMethod: ${r.method} | Quality: ${r.quality.toFixed(2)} | Pages: ${r.pageCount}\n\n${truncated}`);
  }

  for (const r of scannedResults) {
    parts.push(`[PDF: ${r.path}]\nThis PDF appears to be scanned or image-based. Use read_attachment tool to OCR via vision model.`);
  }

  if (parts.length === 0) return messages;

  // 6. 注入到 user 消息末尾
  const injection = '\n\n[PDF document content auto-extracted below]\n\n' + parts.join('\n\n---\n\n');

  return messages.map((m) => {
    if (m.role !== 'user') return m;
    return { ...m, role: m.role, content: m.content + injection };
  });
}
