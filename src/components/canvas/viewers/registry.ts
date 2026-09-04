'use client';

/**
 * 渲染器注册表：预览界面的统一分发平台。
 *
 * 数组顺序即匹配优先级（text 兜底必须最后）。
 * 新增文件类型 = 新增一个渲染器组件 + 在数组里注册一行，主组件（UnifiedViewer）零改动。
 *
 * 未来扩展示例：
 *   { id: 'video', test: (e) => ['mp4', 'webm', 'mov'].includes(e), load: () => import('./VideoViewer').then((m) => m.VideoViewer) },
 *   { id: 'audio', test: (e) => ['mp3', 'wav', 'flac', 'aac'].includes(e), load: () => import('./AudioViewer').then((m) => m.AudioViewer) },
 */
import type { FileInfo } from '@/lib/files/types';
import type { ViewerRenderer } from './types';

/** 代码文件扩展名（带点号） */
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h',
  '.go', '.rs', '.css', '.json', '.xml', '.yaml', '.yml',
  '.sh', '.bash', '.zsh', '.sql',
]);

export const viewerRegistry: ViewerRenderer[] = [
  { id: 'image',  test: (_e, i) => i.type === 'image',         load: () => import('./ImageViewer').then((m) => m.ImageViewer) },
  { id: 'pdf',    test: (e) => e === 'pdf',                    load: () => import('./PdfCanvasViewer').then((m) => m.PdfCanvasViewer) },
  { id: 'docx',   test: (e) => ['docx', 'doc'].includes(e),    load: () => import('./DocxViewer').then((m) => m.DocxViewer) },
  { id: 'xlsx',   test: (e) => ['xlsx', 'xls'].includes(e),    load: () => import('./XlsxViewer').then((m) => m.XlsxViewer) },
  { id: 'binary', test: (_e, i) => i.type === 'binary',        load: () => import('./BinaryViewer').then((m) => m.BinaryViewer) },
  { id: 'md',     test: (e) => e === 'md',                     load: () => import('./MdViewer').then((m) => m.MdViewer) },
  { id: 'html',   test: (e) => e === 'html',                   load: () => import('./HtmlViewer').then((m) => m.HtmlViewer) },
  { id: 'code',   test: (e, i) => !!i.content && CODE_EXTS.has(`.${e}`), load: () => import('./CodeViewer').then((m) => m.CodeViewer) },
  { id: 'text',   test: () => true,                            load: () => import('./TextViewer').then((m) => m.TextViewer) },
];

/** 按扩展名 + 文件信息匹配渲染器（找不到返回 null，由调度层兜底） */
export function matchRenderer(ext: string, fileInfo: FileInfo): ViewerRenderer | null {
  return viewerRegistry.find((r) => r.test(ext, fileInfo)) ?? null;
}

/**
 * 判断扩展名是否可预览（供 LocalFileExplorer 等复用，避免白名单双写）。
 * 用最小 FileInfo 模拟：text 类有 content，二进制类无 content。
 */
export function isPreviewable(ext?: string): boolean {
  if (!ext) return false;
  const e = ext.toLowerCase().replace(/^\./, '');
  // 先按二进制（无 content）试探，再按文本（有 content）试探
  const binaryInfo: FileInfo = { name: `mock.${e}`, extension: `.${e}`, type: 'binary', content: '', size: 0 };
  if (viewerRegistry.some((r) => r.test(e, binaryInfo))) return true;
  const textInfo: FileInfo = { name: `mock.${e}`, extension: `.${e}`, type: 'text', content: 'x', size: 1 };
  return viewerRegistry.some((r) => r.test(e, textInfo));
}
