/**
 * 音频截取（服务端专属：子进程 + ffmpeg）。
 *
 * 与会议路由的 concat / retranscribe 同款思路：**流拷贝优先，失败才重编码**。
 * 但输出容器改成**跟随源**：以前无论源是什么都写 `.webm` —— webm 源能直接 copy（快、无损），
 * 可 mp3/m4a 源往 webm 容器 copy 一定会失败，于是每次都落到 opus 重编码，
 * 等于把已经有损的音频再压一遍（更慢、更糊）。现在输出扩展名与源一致，copy 直接成功。
 */
import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 单次截取的超时：seek + copy 很快，重编码留足余量（与 concat 同量级） */
const CLIP_TIMEOUT_MS = 120_000;

/**
 * 源扩展名 → 输出容器（ext）+ 「流拷贝不可用时」的重编码参数（codec）。
 * 组合原则：输出容器必须装得下 copy 过来的原编码，否则 copy 必失败。
 */
const CONTAINER: Record<string, { ext: string; codec: string[] }> = {
  '.webm': { ext: '.webm', codec: ['-c:a', 'libopus', '-b:a', '96k', '-vn'] },
  '.ogg': { ext: '.ogg', codec: ['-c:a', 'libopus', '-b:a', '96k', '-vn'] },
  '.opus': { ext: '.ogg', codec: ['-c:a', 'libopus', '-b:a', '96k', '-vn'] },
  '.mp3': { ext: '.mp3', codec: ['-c:a', 'libmp3lame', '-q:a', '3', '-vn'] },
  '.m4a': { ext: '.m4a', codec: ['-c:a', 'aac', '-b:a', '128k', '-vn'] },
  '.aac': { ext: '.m4a', codec: ['-c:a', 'aac', '-b:a', '128k', '-vn'] },
  '.wav': { ext: '.wav', codec: ['-c:a', 'pcm_s16le', '-vn'] },
  '.flac': { ext: '.flac', codec: ['-c:a', 'flac', '-vn'] },
  '.aiff': { ext: '.aiff', codec: ['-c:a', 'pcm_s16be', '-vn'] },
  '.aif': { ext: '.aiff', codec: ['-c:a', 'pcm_s16be', '-vn'] },
};

/** 未知扩展名的兜底容器（装 opus，最稳） */
const FALLBACK = CONTAINER['.webm'];

/**
 * 截取 [startSec, endSec) 到 `outBaseAbs`（**不含扩展名** —— 扩展名由源容器决定）。
 * 返回真正落盘的绝对路径；ffmpeg 失败抛错，由调用方转成用户可读提示。
 */
export async function clipAudio(
  ffmpegPath: string,
  srcAbs: string,
  startSec: number,
  endSec: number,
  outBaseAbs: string,
): Promise<string> {
  const start = Math.max(0, Math.min(startSec, endSec));
  const dur = Math.max(0.1, Math.abs(endSec - startSec));
  const spec = CONTAINER[extname(srcAbs).toLowerCase()] ?? FALLBACK;
  const outAbs = `${outBaseAbs}${spec.ext}`;
  // -ss 放在 -i 前做输入定位（音频无关键帧问题，定位足够准，且比输出定位快）
  const head = ['-y', '-ss', start.toFixed(2), '-i', srcAbs, '-t', dur.toFixed(2)];
  try {
    await execFileAsync(ffmpegPath, [...head, '-c', 'copy', outAbs], { timeout: CLIP_TIMEOUT_MS });
  } catch {
    // 容器装不下原编码（或源本身有问题）→ 按容器重编码
    await execFileAsync(ffmpegPath, [...head, ...spec.codec, outAbs], { timeout: CLIP_TIMEOUT_MS });
  }
  return outAbs;
}