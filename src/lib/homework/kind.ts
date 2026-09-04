/** homework/ 产出文件类别（与 OutputFileItem.kind 一致） */
export type HomeworkKind = 'doc' | 'sheet' | 'slide' | 'pdf' | 'image' | 'text' | 'code' | 'other';

/**
 * 扩展名 → kind 判定。homework/ 产物按 kind 打标签，侧边栏按类别分组展示（存储平铺，不建子目录）。
 * 判定口径与 chat/route.ts 原 classifyOutputKind 完全一致。
 */
export function classifyOutputKind(name: string): HomeworkKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'doc', 'docx', 'rtf', 'txt'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv', 'tsv', 'numbers'].includes(ext)) return 'sheet';
  if (['ppt', 'pptx', 'key'].includes(ext)) return 'slide';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(ext)) return 'image';
  if (['txt', 'log', 'md', 'markdown'].includes(ext)) return 'text';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'rb', 'php', 'swift', 'kt', 'css', 'html', 'json', 'yml', 'yaml', 'sh', 'zsh'].includes(ext)) return 'code';
  return 'other';
}

/** kind → 侧边栏分组展示标签（英文） */
export const HOMEWORK_KIND_LABEL: Record<HomeworkKind, string> = {
  doc: 'Documents',
  sheet: 'Spreadsheets',
  slide: 'Slides',
  pdf: 'PDF',
  image: 'Images',
  text: 'Text',
  code: 'Code',
  other: 'Other',
};

/** kind 分组展示顺序 */
export const HOMEWORK_KIND_ORDER: HomeworkKind[] = ['doc', 'sheet', 'slide', 'pdf', 'image', 'text', 'code', 'other'];

