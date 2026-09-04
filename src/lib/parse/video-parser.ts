import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ParseResult, VisionConfig } from './types';
import { parseImage } from './image-parser';
import { getCache, setCache, getCacheDir } from './cache';

const execFileAsync = promisify(execFile);

// ============================================================
// 视频解析：ffmpeg 抽帧 → 复用 image-parser 逐帧调视觉模型 → 合并描述
// ffmpeg 二进制来源（按优先级）：
//   1. 打包环境：Electron main 注入 FFMPEG_PATH（Resources/bin/ffmpeg）
//   2. dev/standalone：@ffmpeg-installer/ffmpeg（npm 依赖自带平台二进制）
//   3. PATH 兜底：系统已安装 ffmpeg
//
// 2026-08 优化（按实施顺序落地）：
//   ① 抽帧缓存持久化：帧文件按视频 hash 落盘到 {project}/.cache/parse/video-frames/{hash}/，
//      二次分析 / 附件重读命中后零 ffmpeg 抽帧（manifest.json 记录时间点以校验一致性）
//   ② 抽帧策略：均匀采样 → ffmpeg scdet 场景感知（scene > 阈值的关键帧），覆盖更多信息量
//   ③ 帧级粗筛：纯色 / 黑场 / 过小文件标记为低信息帧，跳过 VLM（避免幻觉描述 + 省调用）
//   ④ 逐帧串行 → 批次并发（FRAME_CONCURRENCY=3，仿 ledger 行切片转录）
// ============================================================

const DEFAULT_MAX_FRAMES = 4; // 默认抽 4 帧
const MAX_DURATION_SEC = 300; // 视频时长上限：5 分钟
const PROBE_TIMEOUT_MS = 15000;
const EXTRACT_TIMEOUT_MS = 60000;
/** ④ 帧级 VLM 并发数（与 ledger 行切片转录一致，控制 API 压力） */
const FRAME_CONCURRENCY = 3;
/** ② ffmpeg scene 检测阈值（0-1，越高越敏感；0.4 平衡：忽略微动、捕获明显切换） */
const SCENE_THRESHOLD = 0.4;
/** ③ 低信息帧粗筛：文件字节数小于此值视为纯色/黑场/过小帧，跳过 VLM */
const LOW_INFO_MIN_BYTES = 8 * 1024;
/** 抽帧缓存 manifest 文件名 */
const FRAME_MANIFEST = 'manifest.json';

const VIDEO_MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webp',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
};

function videoMimeType(filePath: string): string {
  return VIDEO_MIME_MAP[path.extname(filePath).toLowerCase()] ?? 'video/mp4';
}

/** 解析 ffmpeg -i 输出的 Duration，返回秒数；失败返回 null */
function parseDurationSec(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return h * 3600 + min * 60 + s + ms / 1000;
}

/** 定位 ffmpeg 可执行文件路径 */
async function resolveFfmpegPath(): Promise<string | null> {
  // 1) 打包环境：Electron main 注入 FFMPEG_PATH（指向 Resources/bin/ffmpeg）
  const envPath = process.env.FFMPEG_PATH;
  if (envPath) {
    try {
      await fs.access(envPath);
      return envPath;
    } catch {
      /* 继续尝试下一来源 */
    }
  }
  // 2) dev/standalone：@ffmpeg-installer/ffmpeg 自带平台二进制。
  //    用 createRequire 运行时解析，绕过 webpack 静态打包——
  //    该包 index.js 含 require(运行时路径变量)，直接 import 会导致 next build 失败。
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    const mod = req('@ffmpeg-installer/ffmpeg') as { path?: string };
    if (mod?.path) {
      try {
        await fs.access(mod.path);
        return mod.path;
      } catch {
        /* 二进制缺失，继续 */
      }
    }
  } catch {
    /* @ffmpeg-installer 未安装，继续 */
  }
  // 3) PATH 兜底：系统已安装 ffmpeg
  return null;
}

/** 探测视频时长（秒），失败返回 null */
async function probeDuration(ffmpegPath: string, videoPath: string): Promise<number | null> {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ['-i', videoPath], { timeout: PROBE_TIMEOUT_MS });
    return parseDurationSec(stderr);
  } catch (e) {
    // ffmpeg -i 无输出文件时会以非零退出，但 stderr 中仍包含 Duration 信息
    const stderr = (e as { stderr?: string }).stderr;
    return stderr ? parseDurationSec(stderr) : null;
  }
}

/** 抽取视频指定时间点的一帧为 jpg */
async function extractFrame(
  ffmpegPath: string,
  videoPath: string,
  timeSec: number,
  outPath: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      ffmpegPath,
      ['-ss', timeSec.toFixed(2), '-i', videoPath, '-frames:v', '1', '-q:v', '2', '-y', outPath],
      { timeout: EXTRACT_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

async function computeFileHash(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** ① 抽帧缓存目录：{project}/.cache/parse/video-frames/{videoHash}/ */
function getVideoFramesDir(fileHash: string, projectPath: string): string {
  return path.join(getCacheDir(projectPath), 'video-frames', fileHash);
}

/** ① 抽帧缓存 manifest 内容 */
interface FrameCacheMeta {
  /** 已抽帧的时间点（秒），与 files 一一对应 */
  times: number[];
  /** 帧文件名（相对缓存目录），与 times 一一对应 */
  files: string[];
}

/** 读取帧缓存元数据；不存在或损坏返回 null */
async function readFrameCache(fileHash: string, projectPath: string): Promise<FrameCacheMeta | null> {
  try {
    const raw = await fs.readFile(path.join(getVideoFramesDir(fileHash, projectPath), FRAME_MANIFEST), 'utf-8');
    const meta = JSON.parse(raw) as FrameCacheMeta;
    if (Array.isArray(meta.times) && Array.isArray(meta.files)) return meta;
    return null;
  } catch {
    return null;
  }
}

/** ② ffmpeg scene 检测：解析 stderr 中 showinfo 输出的场景变化时间点（秒）。
 *  返回按时间升序、去重（相邻间距 > 0.5s）的时间点数组；失败返回 null。 */
async function detectSceneChangeTimes(ffmpegPath: string, videoPath: string): Promise<number[] | null> {
  try {
    const { stderr } = await execFileAsync(
      ffmpegPath,
      ['-i', videoPath, '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, '-f', 'null', '-'],
      { timeout: EXTRACT_TIMEOUT_MS * 2 },
    );
    const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => parseFloat(m[1]));
    const dedup: number[] = [];
    for (const t of times) {
      if (!Number.isFinite(t) || t <= 0) continue;
      if (dedup.length === 0 || t - dedup[dedup.length - 1] > 0.5) dedup.push(t);
    }
    return dedup.length > 0 ? dedup : null;
  } catch {
    return null;
  }
}

/** ② 计算抽帧时间点：场景感知优先（覆盖不同场景），失败/场景点过少回退均匀采样。
 *  结果确定：同一视频同一 maxFrames 每次返回相同时间点（保证帧缓存命中）。 */
async function computeFrameTimes(
  ffmpegPath: string,
  videoPath: string,
  duration: number | null,
  maxFrames: number,
): Promise<number[]> {
  // 时长未知：退化按 1s/2s/3s/4s 取帧（保持原行为）
  if (duration === null) {
    return Array.from({ length: maxFrames }, (_, i) => i + 1);
  }
  if (duration <= 2) return [Math.max(0.1, duration / 2)];

  // 场景感知：候选场景点充足（>= 2）且能被均匀挑选时才采用
  try {
    const sceneTimes = await detectSceneChangeTimes(ffmpegPath, videoPath);
    if (sceneTimes && sceneTimes.length >= 2) {
      const inRange = sceneTimes.filter((t) => t > 0.1 && t < duration - 0.1);
      if (inRange.length >= maxFrames) {
        // 场景点足够多 → 均匀挑 maxFrames 个（覆盖全程不同场景）
        const step = (inRange.length - 1) / Math.max(1, maxFrames - 1);
        const picked = Array.from({ length: maxFrames }, (_, i) => inRange[Math.round(i * step)]);
        return picked;
      }
      if (inRange.length >= 2) return inRange; // 场景点不足但可用 → 直接用（帧少但覆盖场景变化）
    }
  } catch {
    /* 场景检测失败 → 回退均匀 */
  }

  // 均匀采样（原行为兜底）
  const step = duration / (maxFrames + 1);
  return Array.from({ length: maxFrames }, (_, i) => step * (i + 1));
}

/** ① 抽帧并持久化缓存；命中时直接复用（零 ffmpeg）。返回帧文件绝对路径数组（与 times 对齐，抽帧失败的帧会缺失）。 */
async function extractFramesCached(
  ffmpegPath: string,
  videoPath: string,
  times: number[],
  fileHash: string,
  projectPath: string,
): Promise<{ files: string[]; fromCache: boolean }> {
  const dir = getVideoFramesDir(fileHash, projectPath);

  // 命中：manifest 时间点与本次一致 + 帧文件全部存在
  const meta = await readFrameCache(fileHash, projectPath);
  if (meta && meta.times.length === times.length && meta.files.length === times.length) {
    const same = meta.times.every((t, i) => Math.abs(t - times[i]) < 0.05);
    if (same) {
      const files = meta.files.map((f) => path.join(dir, f));
      const exists = await Promise.all(files.map((f) => fs.access(f).then(() => true).catch(() => false)));
      if (exists.every(Boolean)) return { files, fromCache: true };
    }
  }

  // 未命中 → 抽帧
  await fs.mkdir(dir, { recursive: true });
  const files: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const name = `frame-${String(i).padStart(2, '0')}.jpg`;
    const outPath = path.join(dir, name);
    const ok = await extractFrame(ffmpegPath, videoPath, times[i], outPath);
    if (ok) {
      files.push(outPath);
      names.push(name);
    }
  }
  if (files.length === 0) {
    throw new Error('视频抽帧失败：无法从视频中提取任何帧（文件可能已损坏或编码不受支持）。');
  }
  await fs.writeFile(
    path.join(dir, FRAME_MANIFEST),
    JSON.stringify({ times, files: names } satisfies FrameCacheMeta, null, 2),
    'utf-8',
  );
  return { files, fromCache: false };
}

/** ③ 帧级粗筛：文件过小（纯色/黑场/损坏）标记为低信息帧（跳过 VLM）。返回与 files 等长的布尔数组。 */
async function markLowInfoFrames(files: string[]): Promise<boolean[]> {
  return Promise.all(
    files.map(async (f) => {
      try {
        const st = await fs.stat(f);
        return st.size < LOW_INFO_MIN_BYTES;
      } catch {
        return true; // 读取失败视为低信息
      }
    }),
  );
}

export interface VideoParseOptions {
  /** 抽帧数量上限，默认 4 */
  maxFrames?: number;
  /** 视频时长上限（秒），默认 300 */
  maxDurationSec?: number;
  /** ⑤ 只分析这些帧索引（0-based，对应抽帧缓存文件顺序）；缺省分析全部帧 */
  frameRange?: number[];
  /** 帧分析器注入：默认逐帧走 parseImage（内置视觉模型）；可注入 MCP 版（bob-ocr-mcp image_understand 优先） */
  frameAnalyzer?: FrameAnalyzer;
}

/** 帧分析上下文 */
export interface FrameAnalyzerCtx {
  /** 帧序号（1-based 展示用） */
  fi: number;
  /** 总帧数 */
  total: number;
  /** 时间标签（如 "（t≈1.5s）"，可为空串） */
  timeLabel: string;
}

/** 单帧分析器：返回帧描述文本与 token 用量 */
export type FrameAnalyzer = (
  framePath: string,
  projectPath: string,
  ctx: FrameAnalyzerCtx,
) => Promise<{ text: string; tin: number; tout: number }>;

/** 默认帧分析器：内置视觉模型（parseImage + 视频帧专用 prompt） */
function defaultFrameAnalyzer(
  framePath: string,
  projectPath: string,
  config: VisionConfig,
  ctx: FrameAnalyzerCtx,
): Promise<{ text: string; tin: number; tout: number }> {
  return parseImage(framePath, projectPath, {
    ...config,
    custom_prompt: `这是一段视频的第 ${ctx.fi}/${ctx.total} 帧${ctx.timeLabel}。请详细描述画面内容：主体、场景、人物动作、可见文字、字幕、颜色与布局等关键信息，尽量具体。`,
  }).then((frameResult) => ({
    text: `[帧 ${ctx.fi}/${ctx.total}${ctx.timeLabel}]\n${frameResult.extracted_text}`,
    tin: frameResult.stats?.input_tokens ?? 0,
    tout: frameResult.stats?.output_tokens ?? 0,
  }));
}

/** ⑤ 识别前预热：仅抽帧写缓存（不调 VLM），供后续 read_attachment 命中帧缓存后各自做 VLM。
 *  返回抽帧信息；若整视频结果缓存已存在则直接标记 fromCache=true（无需再预热）。 */
export async function prewarmVideoFrames(
  videoPath: string,
  projectPath: string,
): Promise<{ fileHash: string; times: number[]; files: string[]; fromCache: boolean }> {
  const fileHash = await computeFileHash(videoPath);
  const cached = await getCache(fileHash, projectPath);
  if (cached?.result?.extracted_text) {
    return { fileHash, times: [], files: [], fromCache: true };
  }
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg 不可用：未找到内置二进制（打包版应位于 Resources/bin/ffmpeg），且系统 PATH 中无 ffmpeg。');
  }
  const duration = await probeDuration(ffmpegPath, videoPath);
  const times = await computeFrameTimes(ffmpegPath, videoPath, duration, DEFAULT_MAX_FRAMES);
  const { files, fromCache } = await extractFramesCached(ffmpegPath, videoPath, times, fileHash, projectPath);
  return { fileHash, times, files, fromCache };
}

/**
 * 解析视频：场景感知/均匀抽帧（帧缓存持久化）→ 帧级粗筛 → 逐帧视觉模型识别（批次并发）→ 合并为结构化描述。
 * 结果按视频内容 hash 缓存（.cache/parse/）。
 */
export async function parseVideo(
  videoPath: string,
  projectPath: string,
  config: VisionConfig,
  options: VideoParseOptions = {},
): Promise<ParseResult> {
  const maxFrames = Math.max(1, Math.min(8, options.maxFrames ?? DEFAULT_MAX_FRAMES));
  const maxDurationSec = options.maxDurationSec ?? MAX_DURATION_SEC;
  const frameRange = options.frameRange;

  const fileName = path.basename(videoPath);
  const mimeType = videoMimeType(videoPath);
  const fileHash = await computeFileHash(videoPath);

  // 整视频结果缓存：未指定帧段时可命中（帧段场景由 ⑤ 委派走帧缓存 + 各自 VLM）
  if (!frameRange || frameRange.length === 0) {
    const cached = await getCache(fileHash, projectPath);
    if (cached) {
      return {
        ...cached.result,
        file_name: fileName,
        mime_type: mimeType,
        parsed_at: cached.result.parsed_at,
      };
    }
  }

  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg 不可用：未找到内置二进制（打包版应位于 Resources/bin/ffmpeg），且系统 PATH 中无 ffmpeg。');
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-video-'));
  try {
    const duration = await probeDuration(ffmpegPath, videoPath);
    if (duration !== null && duration > maxDurationSec) {
      throw new Error(`视频时长 ${Math.round(duration)}s 超过上限 ${maxDurationSec}s（5 分钟），拒绝分析。`);
    }

    // ① 抽帧（持久化缓存；二次分析/附件重读命中后零 ffmpeg）
    const times = await computeFrameTimes(ffmpegPath, videoPath, duration, maxFrames);
    const { files } = await extractFramesCached(ffmpegPath, videoPath, times, fileHash, projectPath);

    // ⑤ 帧段选择（frameRange 缺省 = 全部帧）
    const selected = (frameRange && frameRange.length > 0 ? frameRange : files.map((_, i) => i))
      .filter((i) => Number.isInteger(i) && i >= 0 && i < files.length);

    // ③ 帧级粗筛：低信息帧跳过 VLM
    const lowInfo = await markLowInfoFrames(files);

    // ④ 批次并发逐帧调视觉模型识别（复用 parseImage：base64 + vision-adapter + 帧级缓存）
    const startTime = Date.now();
    const descriptions: string[] = [];
    let totalIn = 0;
    let totalOut = 0;
    for (let i = 0; i < selected.length; i += FRAME_CONCURRENCY) {
      const batch = selected.slice(i, i + FRAME_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (fi) => {
          const timeLabel = times[fi] != null ? `（t≈${times[fi].toFixed(1)}s）` : '';
          if (lowInfo[fi]) {
            // ③ 低信息帧：不调 VLM，给占位说明（避免幻觉描述 + 省调用）
            return {
              text: `[帧 ${fi + 1}/${files.length}${timeLabel}]（画面单一/模糊，信息量低，跳过详细描述）`,
              tin: 0,
              tout: 0,
            };
          }
          const frameResult = options.frameAnalyzer
            ? await options.frameAnalyzer(files[fi], projectPath, {
                fi: fi + 1,
                total: files.length,
                timeLabel,
              })
            : await defaultFrameAnalyzer(files[fi], projectPath, config, {
                fi: fi + 1,
                total: files.length,
                timeLabel,
              });
          return {
            text: frameResult.text,
            tin: frameResult.tin,
            tout: frameResult.tout,
          };
        }),
      );
      for (const r of results) {
        descriptions.push(r.text);
        totalIn += r.tin;
        totalOut += r.tout;
      }
    }

    const result: ParseResult = {
      file_name: fileName,
      file_type: 'video',
      mime_type: mimeType,
      extracted_text: `视频抽帧分析（${files.length} 帧采样，时长 ${
        duration !== null ? `${Math.round(duration)}s` : '未知'
      }）:\n\n${descriptions.join('\n\n')}`,
      frame_count: files.length,
      parse_method: 'frame_extract',
      parsed_at: new Date().toISOString(),
      stats: {
        duration_ms: Date.now() - startTime,
        input_tokens: totalIn,
        output_tokens: totalOut,
      },
      file_hash: fileHash,
    };

    // 整视频结果缓存（仅在非帧段场景写入，避免帧段结果污染全量缓存）
    if (!frameRange || frameRange.length === 0) {
      await setCache(fileHash, result, projectPath);
    }
    return result;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
