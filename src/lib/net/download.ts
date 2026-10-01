/**
 * lib/net/download.ts — 大文件断点续传下载（curl）与 tar.bz2 解压
 *
 * 由来：本地 STT（见 lib/stt/sherpa）与本地神经 TTS（见 lib/tts/sherpa-local）都要
 * 从境外源拉几十~几百 MB 的模型包；hf-mirror / GitHub CDN 都会抖动中断，故把下载逻辑
 * 抽到这里共享，行为与 STT 原先完全一致，只是**新增了多 URL（镜像链）支持**。
 *
 * 下载策略（与原先 STT 单文件一致）：
 *   - 统一走系统 curl（macOS 自带；Node fetch 对 github.com 有 10s 连接超时，curl 不会）；
 *   - 中间态写 `<dest>.part`：进程重启能续传，UI 直接读磁盘即得真实进度；
 *   - 每轮从 `.part` 已有字节 `-C -` 续传，多轮重试，完成后原子重命名。
 *
 * 多 URL（镜像链）：传入 `string[]` 时按序轮换尝试（第 n 轮用第 n 个 URL），
 * 因 Range 续传跨镜像有效，任一镜像通了都能接着下；全都不通才最终报错。
 */
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** 系统 curl（macOS 自带）：原生支持 `-C -` 断点续传 */
const CURL_BIN = '/usr/bin/curl';
/** 单次 curl 调用的硬超时（curl 自身的 --speed-limit 会先兜住"假死"） */
const CURL_TIMEOUT_MS = 15 * 60 * 1000;
/** 单文件下载最大尝试轮数（每轮都会从 .part 已有字节续传） */
const DOWNLOAD_ATTEMPTS = 10;
/** 单文件下载的总时长上限：超时即报错并保留 .part，避免 UI 无限转圈 */
const DOWNLOAD_DEADLINE_MS = 30 * 60 * 1000;
/** 单轮无进展时的等待，避免打爆对端 */
const RETRY_DELAY_MS = 1500;

export async function fileSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

/** 下载进度（字节）：正式文件与 `<file>.part` 中较大的那个，封顶 expected。
 *  下载中只有 .part 存在，完成后才重命名为正式名——两种情况都要能读到真实进度。 */
export async function downloadProgress(dest: string, expected: number): Promise<number> {
  const done = await fileSize(dest);
  if (done >= expected) return expected;
  return Math.min(Math.max(done, await fileSize(`${dest}.part`)), expected);
}

/**
 * 下载单个文件到 dest（带断点续传 + 多轮重试）。
 * @param urls 单个 URL，或镜像链（按序轮换尝试；任一可通即可）
 * @param expectedBytes 期望体积（用于完整性校验与进度换算）
 */
export async function downloadFile(
  urls: string | string[],
  dest: string,
  expectedBytes: number,
): Promise<void> {
  const list = (typeof urls === 'string' ? [urls] : urls).filter((u) => typeof u === 'string' && u.length > 0);
  if (list.length === 0) throw new Error('No download URL provided');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if ((await fileSize(dest)) >= expectedBytes) return;
  await fs.rm(dest, { force: true });
  const part = `${dest}.part`;

  let lastError = '';
  const deadline = Date.now() + DOWNLOAD_DEADLINE_MS;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if ((await fileSize(part)) >= expectedBytes) break;
    if (Date.now() > deadline) {
      lastError = `超过 ${Math.round(DOWNLOAD_DEADLINE_MS / 60000)} 分钟仍未下载完成`;
      break;
    }
    // 镜像链：每轮顺延一个 URL；单 URL 时恒为首个（与原先行为一致）
    const url = list[(attempt - 1) % list.length];
    try {
      await curlDownload(url, part);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // 对端不支持 Range 续传 → 丢弃分片，下一轮从头下载
      if (/byte range|cannot resume/i.test(lastError)) await fs.rm(part, { force: true });
    }
    if ((await fileSize(part)) >= expectedBytes) break;
    if (attempt < DOWNLOAD_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }

  const finalSize = await fileSize(part);
  if (finalSize < expectedBytes) {
    throw new Error(`Download incomplete (${finalSize}/${expectedBytes} bytes): ${lastError || 'connection lost'}`);
  }
  await fs.rename(part, dest);
}

/**
 * 用系统 curl 下载到 outPath（`-C -` 自动从已有字节续传）。
 * `--speed-limit` 兜住"连上但假死"的连接：30s 内低于 1KB/s 即主动断开，
 * 交由外层重试（curl 自身也带 --retry 处理偶发断流）。
 */
function curlDownload(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-L', // 跟随 302（hf-mirror / GitHub CDN / 代理 均重定向）
      '--fail', // HTTP 错误直接非 0 退出，避免把错误页写进文件
      '--silent', '--show-error',
      '-C', '-', // 断点续传：偏移量取 outPath 现有字节数
      '--retry', '5', '--retry-delay', '2', '--retry-all-errors',
      '--connect-timeout', '30',
      '--speed-time', '30', '--speed-limit', '1024',
      '-A', 'BobWork',
      '-o', outPath,
      url,
    ];
    execFile(CURL_BIN, args, { timeout: CURL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = String(stderr || (err as Error).message).trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`curl 失败：${detail.slice(0, 300)}`));
        return;
      }
      resolve();
    });
  });
}

/** 用系统 tar 解压 .tar.bz2 到 destDir（调用方自行读取顶层目录名） */
export async function extractTarBz2(archive: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  await execFileAsync('/usr/bin/tar', ['-xjf', archive, '-C', destDir], { timeout: 300_000 });
}