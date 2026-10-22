/**
 * 扩展名 → MIME（**纯函数**：不碰 fs / 不碰 HTTP）。
 *
 * 为什么单独一个文件：`/api/local-files` 与 `/api/projects` 两个 `file_proxy` 各自维护过
 * 一份**逐字相同**的 mimeMap（典型漂移温床），且两份都**完全没有音频/视频**——
 * 于是 `.m4a` 一律以 `application/octet-stream` 下发。
 *
 * ⚠️ 曾经以为这会影响播放，**实测证明不会**（2026-10-11，Electron 43.2.0 / Chromium）：
 * `<audio src=…>` 与 `AudioContext.decodeAudioData()` 都**忽略 Content-Type、纯靠内容嗅探**。
 * 反向对照（用来证明判据不平凡）：把 FLAC 字节标成 `text/plain`、甚至再叠加
 * `X-Content-Type-Options: nosniff`，仍然解码成功且 `currentTime` 正常前进；
 * 同源 + `webSecurity: true` 与跨源 + `webSecurity: false` 结果一致。
 * ⇒ 所以本文件存在的理由是：① 消掉两张逐字重复的表；② 语义正确（此前 `.flac` / `.aiff`
 * 不在 `MeetingReplay` 的客户端纠正表里，会被回落成 `audio/webm`，属于**错标**）；
 * ③ 让代理 URL 被浏览器/外部工具直接打开时按类型渲染而非下载。**不是**为了修播放。
 *
 * 口径：
 *   - 只列「浏览器会直接渲染/播放」的几类，其余一律 `application/octet-stream`
 *     （保持既有行为，不顺手改其他类型的下载/预览语义）；
 *   - `.webm` 取 `video/webm` —— WebM 本就是容器，音频轨是它的子集；且仓库内其余 4 处
 *     （`api/project-files/[projectId]/[...path]`、`api/sandbox/preview/[id]/[...path]`、
 *     `api/attachments` 两处）都按容器口径映射，与它们对齐。历史上客户端曾单独用
 *     `audio/webm` 纠正（`components/butler/MeetingReplay.tsx:103-126`，注释说「否则
 *     `<audio>` 可能直接拒绝播放」）——该注释的机理未能复现，但**本轮不动它**，仅记录。
 *   - 音频键 = `lib/audio/naming.ts` 的 `AUDIO_EXTS` 去掉 `.webm`（`.webm` 按容器归视频）。
 */

/** 扩展名（带点、大小写不敏感）→ MIME；未收录 → undefined */
const MIME_BY_EXT: Record<string, string> = {
  // 网页 / 文档
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  // 图片
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // 音频（= lib/audio/naming.ts 的 AUDIO_EXTS 去掉 `.webm`；`.webm` 按容器归下方视频）
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  // 视频（.webm 兼作音频容器，按容器口径归类）
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** 默认类型（保持既有行为：不认识的一律二进制流） */
export const DEFAULT_MIME = 'application/octet-stream';

/**
 * 取 MIME。`ext` 用 `node:path` 的 `extname()` 结果（带点）或任意带点后缀均可。
 */
export function fileMime(ext: string): string {
  if (!ext) return DEFAULT_MIME;
  const key = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return MIME_BY_EXT[key] ?? DEFAULT_MIME;
}
