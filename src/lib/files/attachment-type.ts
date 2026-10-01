/**
 * 附件类型判定（mime + 扩展名 → 6 类之一）
 *
 * 两个上传端点共用同一份判定，避免同一份文件在「节点对话附件」与「Butler 附件」两侧
 * 被判成不同类型（该值会写进回传的 attachment.type，并被前端 chip 与「--- 资料列表 ---」
 * 的 kind 字段直接展示）。
 *   - POST /api/attachments        （节点对话附件：文件夹键 = nodeId）
 *   - POST /api/butler/attachments （Butler 附件：按角色 + 日期归档，落 butler/<角色>/<日期>/attachments/）
 */
import { extname } from 'path';

/** 按 mime 前缀判定，回退到扩展名白名单（text 类含常见源码后缀） */
export function getAttachmentType(
  mimeType: string,
  filename: string,
): 'image' | 'text' | 'file' | 'video' | 'audio' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (
    mimeType.startsWith('text/') ||
    [
      '.md',
      '.txt',
      '.json',
      '.csv',
      '.xml',
      '.html',
      '.css',
      '.js',
      '.ts',
      '.py',
      '.java',
      '.cpp',
      '.c',
      '.go',
      '.rs',
      '.yaml',
      '.yml',
    ].includes(extname(filename).toLowerCase())
  ) {
    return 'text';
  }
  return 'file';
}