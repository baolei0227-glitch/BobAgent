/**
 * 音频产物的命名（**纯字符串**，不碰 fs / 子进程）。
 *
 * 为什么单独一个文件：这套命名客户端也要用（点 Clip 时预填默认名），
 * 而 marks.ts 里有 sidecar 的 `node:fs` 动态导入 —— 那是服务端专属，
 * 一旦被客户端组件值引入（不是 `import type`）就会把 node 内置模块拖进浏览器包。
 * 因此「纯命名」与「持久化」分开：本文件两侧都能引，marks.ts 只给服务端用。
 */

/** 秒 → 文件名安全的时间戳（`01-23`；文件名里不能用 `:`），片段产物命名用 */
export function clipStamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}-${String(s % 60).padStart(2, '0')}`;
}

/**
 * 片段产物的**主名**（不含扩展名）：`片段 - <标题> - <起-止>`。
 * 起止都在名里，同一场录音截多段也不会互相覆盖。
 * 扩展名由导出时按**源容器**决定（见 lib/audio/clip.ts），故这里不写死 `.webm`。
 */
export function clipBaseName(title: string, startSec: number, endSec: number): string {
  return `片段 - ${title} - ${clipStamp(startSec)}-${clipStamp(endSec)}`;
}

/** 已知音频扩展名（用户自定义名里若自带扩展名则剥掉，避免出现 `x.mp3.mp3`） */
const AUDIO_EXT_RE = /\.(webm|mp3|m4a|wav|aac|ogg|opus|flac|aiff?|mp4)$/i;

/**
 * 编辑器可处理的音频扩展名白名单（**带点、小写**）。
 * 后端只认这些扩展名（打点/截取/导入的收窄口子），前端用它拼 file input 的 `accept`。
 */
export const AUDIO_EXTS = ['.webm', '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.opus', '.flac', '.aiff', '.aif'];

/**
 * 用户自定义的片段主名 → 文件名安全。
 * - 剥掉自带扩展名（最终扩展名由容器决定）
 * - 替换文件系统非法字符与换行
 * - 去掉开头的点（防止生成隐藏文件）
 * 空串返回 ''，由调用方回退默认名。
 */
export function safeBaseName(input: string): string {
  const noExt = String(input || '').replace(AUDIO_EXT_RE, '');
  const cleaned = noExt
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 80);
}

/** 从音频文件名推一个标题（去掉扩展名与路径，用于片段产物命名） */
export function audioTitle(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  return base || 'Audio';
}