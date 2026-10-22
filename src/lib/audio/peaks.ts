/**
 * 波形峰值（peaks）生成：服务端把音频解码成**低采样率单声道 PCM**，流式按桶取绝对值最大，
 * 得到 WaveSurfer 可直接渲染的波形数据（带缓存）。
 *
 * ## 为什么需要它
 * WaveSurfer 在「没有 peaks」时有两条昂贵的隐藏路径（见 node_modules/wavesurfer.js/dist）：
 *   1. `:471` `if (!blob && !channelData)` → 把**整份音频** fetch 成 Blob 进内存；
 *   2. `:539-548` 用 `decodeAudioData` **全量解码**成 AudioBuffer —— PCM 常驻**原生内存**
 *      （不在 JS 堆里，`performance.memory` 看不到），实测 20 分钟单声道 mp3 净增 RSS ≈ 500MB。
 * 只要喂上 `peaks` + `duration`，两条路径**同时消失**：
 *   - `:147-151` 构造时（或 `:494` `setSrc`）播放交给 `<audio src=url>`，走 HTTP Range 按需拉取；
 *   - `:536-538` 有 channelData 就 `Decoder.createBuffer(peaks, duration)`，不再解码。
 *
 * ## 数值口径（必须与上游一致，否则波形形状会变）
 * 与 WaveSurfer 自带 `exportPeaks` 同款：桶内取**绝对值最大**的那个原始样本值（**保号**，可正可负），
 * 再归一化到 [-1, 1]。渲染侧只消费 `Math.abs`（`renderer-utils.js:100-105`），故保号不影响显示，
 * 但保持同口径便于两边对照。
 *
 * ## 为什么解码到 8kHz 单声道
 * 峰值包络只用来画图。8kHz 已覆盖语音/音乐的主要能量，且固定采样率让管道流量可预测
 * （16KB/s；2 小时 ≈ 115MB，**全程流式、不驻留**）。代价是 4kHz 以上被低通、极端瞬态包络略平，
 * 对波形观感无影响。
 *
 * ## 为什么先聚「微桶」再合并
 * 想把整段音频均匀切成 N 个桶，必须先知道总样本数，而流式解码时并不知道。
 * 两种做法都不能接受：① 攒下全部样本（2 小时 ≈ 115MB 常驻）；② 先跑一趟 ffmpeg 读时长（解码两遍）。
 * 于是分两级：解码途中按固定 10ms 聚成一个「微桶」（abs-max 可结合，且体积极小），
 * 收尾时再按总样本数把微桶合并成 N 个等宽桶——**单趟、恒定小内存、且合并结果与等宽切分等价**。
 *
 * **只服务端可用**（子进程 + Buffer）。
 *
 * ## 实测（本机 M 系列，判据可回溯）
 * | 输入 | 体积 | 时长 | 生成耗时 | 进程 RSS 增量 |
 * |---|---|---|---|---|
 * | 合成 mp3 64k | 9.16MB | 1200s | 1.08s | 16.0MB（复跑 0.3MB） |
 * | 真实会议录音 m4a 64k | 27.36MB | 3401s | 3.15s | — |
 * 即解码速度约 1100× 实时。**因此同步生成即可**（无需后台任务/轮询）：本机最坏情况
 * （2 小时录音）约 7s，且首次之后一直命中缓存。作为对照，同一条 3401s 的录音走旧路径
 * 会解码出 ≈600MB PCM（3401 × 44100 × 4B）常驻原生内存 —— 现在换成硬盘上一个几 KB 的缓存。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { peaksFileFor, sourceDir } from './library';
import { FINE_HZ, decodeFine, encodeFine, mergeMicrosPairs } from './peaks-codec';

/** 解码采样率（单声道 s16le；固定值 ⇒ 管道流量可预测） */
export const PEAKS_SAMPLE_RATE = 8000;
/** 最终桶数：需 ≥ 波形可绘制的柱子数（≈ 画布宽 / (barWidth+barGap)，4K 宽屏上限 ≈ 900），留足余量 */
export const PEAKS_BUCKETS = 2000;
/**
 * 允许的最小**缩放窗口**（秒）。2s 是"够精确切句/切词"的下限：
 * 细分辨率是 20ms/桶 ⇒ 2s 窗口仍有 **100 个点**（屏宽 ≈370px 时相当于 3.7px/点），
 * 再往下放（比如 0.5s）就只有 25 个点，波形会显得失真 —— 峰值源是 8kHz，看不到更细的东西。
 */
export const PEAKS_MIN_WINDOW_SEC = 2;
/**
 * 微桶样本数（80 ≈ 10ms @8kHz）。
 * 选 10ms 是为了让**最短的大文件**也能凑满 2000 个微桶：1MB 的 320kbps mp3 ≈ 25s ≈ 2500 微桶。
 * 更小的文件本来就走 Blob 回放（见 PEAKS_MIN_BYTES），不需要靠它撑分辨率。
 */
const MICRO_SAMPLES = 80;
/**
 * 小于此体积的文件**不生成 peaks**，前端退回 Blob 回放：
 * 小文件整份下载与解码的开销本来就小，而 peaks 的桶数有限、短音频会显得粗糙。
 * 1MB ≈ 语音 mp3 的 60–80s，此时全量解码的 PCM 峰值约 30MB —— 仍在可接受范围。
 */
export const PEAKS_MIN_BYTES = 1_000_000;
/** 缓存格式版本：改动上面任一常量或聚合口径时必须 +1，否则旧缓存（形状已变）会被继续使用 */
/**
 * 缓存版本。**2** = 多了一段**细分辨率**（20ms/50Hz，int8+base64），供时间轴缩放取窗口切片。
 *
 * 兼容口径：`readPeaksCache` **仍接受 v1**（只有粗桶）—— 这样老缓存不会被判失效而被迫重建；
 * 需要细分辨率时（首次真正缩放）再由 `ensureFinePeaks` 补建并写回 v2。
 */
export const PEAKS_VERSION = 2;
/** v1 = 只有粗桶（历史缓存，仍可读） */
const PEAKS_VERSION_COARSE_ONLY = 1;

/** 生成超时（解码 2 小时音频在 M 系列上约 20–40s，留足余量） */
const PEAKS_TIMEOUT_MS = 300_000;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** 生成结果（peaks 长度 = 桶数；duration 秒，由总样本数换算） */
export interface PeaksResult {
  peaks: number[];
  duration: number;
  /**
   * **细分辨率**（20ms/50Hz）的量化数据（int8 + base64）。生成时顺手产出（微桶本来就算过），
   * 供时间轴缩放按窗口取切片。缺省 = 这条缓存只有粗桶（v1 老缓存），需要时由 `ensureFinePeaks` 补建。
   */
  fine?: string;
  /** 细分辨率的采样频率（Hz）；与 `fine` 成对出现 */
  fineHz?: number;
}

/**
 * 流式累积器：吃 s16le 单声道 PCM 分块，产出定长峰值桶。
 *
 * 纯内存计算、不碰 fs —— 单测直接喂 Buffer 即可覆盖聚合口径。
 */
export class PeaksAccumulator {
  /** 已完成的微桶：桶内绝对值最大的**原始 s16 值**（保号，未归一化） */
  private micros: number[] = [];
  /**
   * 跨块残留的**低字节**。
   * 管道分块的边界是任意的，一个 16 位样本可能被切成两半 —— 不接住就会把每块边界处的
   * 样本读错（振幅随机跳变），且在长音频上表现为规律的毛刺。
   */
  private carry: number | null = null;
  /** 当前微桶内的 abs-max（原始 s16）与该桶已收样本数 */
  private cur = 0;
  private curCount = 0;
  /** 累计样本数（用于换算时长与等宽合并） */
  private total = 0;

  push(chunk: Buffer): void {
    let i = 0;
    if (this.carry !== null) {
      if (chunk.length === 0) return;
      // 上一块留下的低字节 + 这一块的首字节（高字节）→ 拼回一个样本
      this.feed(((chunk[0] << 8) | this.carry) & 0xffff);
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.feed(chunk.readUInt16LE(i));
    if (i < chunk.length) this.carry = chunk[i]; // 末尾剩 1 字节，等下一块
  }

  /** 喂入一个有符号 16 位样本（入参按无符号 16 位传入，这里转回有符号） */
  private feed(u16: number): void {
    const s = u16 >= 0x8000 ? u16 - 0x10000 : u16;
    if (Math.abs(s) > Math.abs(this.cur)) this.cur = s;
    this.total += 1;
    if (++this.curCount >= MICRO_SAMPLES) {
      this.micros.push(this.cur);
      this.cur = 0;
      this.curCount = 0;
    }
  }

  /**
   * 收尾：把微桶按总样本数合并成 `buckets` 个等宽桶并归一化到 [-1, 1]。
   * 无样本（空文件 / 无音轨）→ null，由调用方转成降级。
   */
  finish(buckets = PEAKS_BUCKETS): PeaksResult | null {
    if (this.total === 0) return null;
    // 末尾未满的微桶也要收进来，否则最后 10ms 的波形会被吞掉
    if (this.curCount > 0) {
      this.micros.push(this.cur);
      this.cur = 0;
      this.curCount = 0;
    }
    const micros = this.micros;
    const microCount = micros.length;
    // 微桶不够时用实际数量（短音频），避免出现大量重复值
    const outLen = Math.max(1, Math.min(buckets, microCount));
    const perBucket = this.total / outLen;
    const peaks: number[] = [];
    for (let j = 0; j < outLen; j++) {
      // 桶 j 覆盖的样本区间 → 微桶下标区间（边界可能落在微桶内部，取整会多含 ≤10ms，
      // 对波形显示无影响，换来的是「不必在每个桶里重扫原始样本」）
      const from = Math.floor((j * perBucket) / MICRO_SAMPLES);
      const to = Math.max(from + 1, Math.ceil(((j + 1) * perBucket) / MICRO_SAMPLES));
      let best = 0;
      for (let m = from; m < to && m < microCount; m++) {
        if (Math.abs(micros[m]) > Math.abs(best)) best = micros[m];
      }
      peaks.push(round4(best / 32768));
    }
    // 细分辨率：把 10ms 微桶两两合并成 20ms（与粗桶同为"桶内 abs-max"口径），量化后随缓存落盘。
    // 微桶**本来就在算**（feed() 里 push），不额外解码、不额外扫描原始样本 ⇒ 几乎零成本。
    const fine = encodeFine(mergeMicrosPairs(micros.map((m) => m / 32768)));
    return { peaks, duration: this.total / PEAKS_SAMPLE_RATE, fine, fineHz: FINE_HZ };
  }
}

/**
 * 用 ffmpeg 解码 `srcAbs` 并生成峰值。
 * 失败（无音轨 / 文件损坏 / 超时 / ffmpeg 不可用）一律返回 null，由调用方决定降级
 * —— 波形画不出来不该让整块回放报错。
 */
export async function generatePeaks(
  ffmpegPath: string,
  srcAbs: string,
  buckets = PEAKS_BUCKETS,
): Promise<PeaksResult | null> {
  const args = [
    '-v', 'error',
    '-i', srcAbs,
    '-vn', // 丢掉封面图/视频流（m4a 常见封面）
    '-map', 'a:0', // 只取第一条音轨
    '-ac', '1',
    '-ar', String(PEAKS_SAMPLE_RATE),
    '-f', 's16le',
    '-', // 写到 stdout
  ];
  const acc = new PeaksAccumulator();
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c: Buffer) => acc.push(c));
  // stderr 只用来判断失败原因；不抽干管道会让 ffmpeg 在缓冲写满时卡死
  child.stderr.on('data', () => { /* 丢弃，仅在退出码非 0 时整体判失败 */ });

  const code = await new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (v: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 进程可能已退出 */
      }
      settle(null);
    }, PEAKS_TIMEOUT_MS);
    child.on('error', () => settle(null));
    // close 在 stdout 读完之后才触发，此时 acc 已吃满全部数据
    child.on('close', (c) => settle(c));
  });

  if (code !== 0) return null;
  return acc.finish(buckets);
}

// ──────────────────────────────────────────────────────────────
// 缓存（sidecar，与打点同居一目录：库内就放、库外进影子目录）
// ──────────────────────────────────────────────────────────────

/** 磁盘上的缓存结构（`srcMtimeMs`/`srcSize` 是失效判据：源被换掉/截补过就重算） */
interface PeaksCacheFile {
  v: number;
  srcMtimeMs: number;
  srcSize: number;
  buckets: number;
  duration: number;
  peaks: number[];
  /** v2 起：细分辨率（int8+base64）。v1 老缓存没有这一项 ⇒ 读回 fine 为 undefined */
  fine?: string;
  fineHz?: number;
}

/**
 * 读缓存。任一判据不符（版本 / 源 mtime / 源体积 / 桶数）都当**未命中**返回 null，
 * 由调用方重新生成并覆盖 —— 不在这里删文件，避免读路径带副作用。
 */
export async function readPeaksCache(
  srcAbs: string,
  stat: { mtimeMs: number; size: number },
  buckets = PEAKS_BUCKETS,
): Promise<PeaksResult | null> {
  try {
    const raw = JSON.parse(await fs.readFile(await peaksFileFor(srcAbs), 'utf-8')) as PeaksCacheFile;
    // v1（只有粗桶）与 v2（含细分辨率）都接受：老缓存不因升版被判失效
    if (raw.v !== PEAKS_VERSION && raw.v !== PEAKS_VERSION_COARSE_ONLY) return null;
    if (raw.srcMtimeMs !== stat.mtimeMs || raw.srcSize !== stat.size) return null;
    if (raw.buckets !== buckets) return null;
    if (!Array.isArray(raw.peaks) || raw.peaks.length === 0) return null;
    if (!Number.isFinite(raw.duration) || raw.duration <= 0) return null;
    const fine = typeof raw.fine === 'string' && raw.fine.length > 0 ? raw.fine : undefined;
    const fineHz = Number.isFinite(raw.fineHz) && (raw.fineHz as number) > 0 ? (raw.fineHz as number) : undefined;
    return fine && fineHz
      ? { peaks: raw.peaks, duration: raw.duration, fine, fineHz }
      : { peaks: raw.peaks, duration: raw.duration };
  } catch {
    return null;
  }
}

/**
 * **确保拿到细分辨率**（时间轴缩放要按窗口取切片用）。
 *
 * 三种情况：
 *   1. 缓存已是 v2 且有 `fine` ⇒ 直接用（零成本）；
 *   2. 缓存是 v1（只有粗桶）⇒ **重新生成一次**（顺带写出 v2），代价与首次生成同量级
 *      （实测 3401s / 27MB m4a ≈ 3.15s，且此后一直命中缓存）；
 *   3. 没缓存 ⇒ 生成。
 *
 * 为什么不为"只有粗桶"单独存一套：细分辨率与粗桶**同源同一次解码**，分成两条路径反而更容易漂。
 * 返回 null = 生成失败（调用方降级为"本次缩放不可用"，而不是报错）。
 */
export async function ensureFinePeaks(
  ffmpegPath: string,
  srcAbs: string,
  stat: { mtimeMs: number; size: number },
  buckets = PEAKS_BUCKETS,
): Promise<{ fine: Int8Array; fineHz: number; duration: number } | null> {
  const cached = await readPeaksCache(srcAbs, stat, buckets);
  if (cached?.fine && cached.fineHz) {
    return { fine: decodeFine(cached.fine), fineHz: cached.fineHz, duration: cached.duration };
  }
  const fresh = await generatePeaks(ffmpegPath, srcAbs, buckets);
  if (!fresh?.fine || !fresh.fineHz) return null;
  await writePeaksCache(srcAbs, stat, fresh, buckets);
  return { fine: decodeFine(fresh.fine), fineHz: fresh.fineHz, duration: fresh.duration };
}

/**
 * 写缓存。失败静默（缓存只是加速，不该让本次请求失败）。
 *
 * 自己 `mkdir -p` 一次：库外音频（项目 materials / 任意本地路径）的**影子目录**
 * 可能还没被创建过（只有导出过片段才会建），不像库内音频那样源文件目录必然存在。
 */
export async function writePeaksCache(
  srcAbs: string,
  stat: { mtimeMs: number; size: number },
  result: PeaksResult,
  buckets = PEAKS_BUCKETS,
): Promise<void> {
  const payload: PeaksCacheFile = {
    v: PEAKS_VERSION,
    srcMtimeMs: stat.mtimeMs,
    srcSize: stat.size,
    buckets,
    duration: result.duration,
    peaks: result.peaks,
    ...(result.fine && result.fineHz ? { fine: result.fine, fineHz: result.fineHz } : {}),
  };
  try {
    const file = await peaksFileFor(srcAbs);
    // 走 sourceDir(..., ensure=true)：既建目录，也顺手在**影子目录**里记下"这份产物属于哪个源"
    // （用于「清理无主影子目录」判断源是否还在；库内音频此调用是无副作用的）
    await sourceDir(srcAbs, true);
    await fs.writeFile(file, JSON.stringify(payload), 'utf-8');
  } catch {
    /* 目录不可写等：忽略 */
  }
}
