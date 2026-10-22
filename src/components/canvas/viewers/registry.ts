'use client';

/**
 * 渲染器注册表：预览界面的统一分发平台。
 *
 * 数组顺序即匹配优先级（text 兜底必须最后）。
 * 新增文件类型 = 新增一个渲染器组件 + 在数组里注册一行，主组件（UnifiedViewer）零改动。
 *
 * 视频（2026-10-18 新增）：mp4 / m4v / mov 走 VideoViewer，在 audio 之后、binary 之前
 *   （binary 是 type==='binary' 的兜底，必须最后于各扩展名分支）。
 *   - 只注册 Chromium 真能解码的容器：mkv / avi / wmv 不解复用，注册了也只是空壳，仍归 binary；
 *   - `.webm` **不在视频表内**：audio 分支已先命中它（既有行为：webm 音频进音频编辑器），
 *     若要改归属，须同步确认音频编辑器入口不被挪走（见 lib/files/mime.ts 的口径注释）。
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
  { id: 'xlsx',   test: (e) => ['xlsx', 'xls'].includes(e),    load: () => import('./XlsxViewer').then((m) => m.XlsxViewer) },
  // 音频必须先于 binary：音频文件同样 type === 'binary'，靠扩展名抢先匹配
  { id: 'audio',  test: (e) => ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'aiff', 'aif', 'webm'].includes(e), load: () => import('./AudioHippoLauncher').then((m) => m.AudioHippoLauncher) },
  // 视频：只含 Chromium 可解码的容器（mkv/avi/wmv 不在内，仍走 binary 兜底）
  { id: 'video',  test: (e) => ['mp4', 'm4v', 'mov'].includes(e), load: () => import('./VideoViewer').then((m) => m.VideoViewer) },
  // docx 必须先于 binary：docx/doc 的 type 同样是 'binary'，靠扩展名抢先匹配
  // 2026-09-30 变更（推翻 2026-09-28 的「docx 全部走 Hippo 整页」）：docx/doc 改为在预览面板内编辑。
  //   原因：① Hippo guest 无 preload ⇒ 「外部打开」「转 MD 后自动打开」静默失败（预览面板内 deb 适配器/bus 都在，自动恢复）；
  //         ② 整页要占浏览器标签栏 + 地址栏，正文垂直空间被挤压。
  { id: 'docx',   test: (e) => ['docx', 'doc'].includes(e),    load: () => import('./DocxEditorViewer').then((m) => m.DocxEditorViewer), ownsZoom: true },
  { id: 'binary', test: (_e, i) => i.type === 'binary',        load: () => import('./BinaryViewer').then((m) => m.BinaryViewer) },
  { id: 'md',     test: (e) => e === 'md',                     load: () => import('./MdViewer').then((m) => m.MdViewer) },
  { id: 'code',   test: (e, i) => !!i.content && CODE_EXTS.has(`.${e}`), load: () => import('./CodeViewer').then((m) => m.CodeViewer) },
  { id: 'text',   test: () => true,                            load: () => import('./TextViewer').then((m) => m.TextViewer) },
];

/** 按扩展名 + 文件信息匹配渲染器（找不到返回 null，由调度层兜底） */
export function matchRenderer(ext: string, fileInfo: FileInfo): ViewerRenderer | null {
  return viewerRegistry.find((r) => r.test(ext, fileInfo)) ?? null;
}

/**
 * 文档类（浏览器处理）：html / pdf / 图片 —— 不走预览面板/系统默认应用，
 * file.open → Hippo Browser（主进程 localFileToViewerUrl 重定向到对应内置查看页）。
 *
 * ⚠️ 此处是「能否交 Hippo」判定的唯一真源，与 CanvasFlow 的 file.open 分发共用；
 *    新增成员时勿在调用点另抄一份正则（历史上 CanvasFlow 曾硬编码同义白名单，已收敛）。
 * ⚠️ docx/doc 不在本表（2026-09-30 起）：它们注册进 viewerRegistry，在预览面板内编辑；
 *    内置整页 /docx-editor 已随之下线。二者互斥——命中 isBrowserDoc 就交 Hippo，
 *    否则由 viewerRegistry 决定能否在面板内预览。
 */
const BROWSER_DOC_RE = /\.(html?|pdf|png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export function isBrowserDoc(name?: string): boolean {
  return name ? BROWSER_DOC_RE.test(name) : false;
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
