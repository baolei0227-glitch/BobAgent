/**
 * lib/parse/audio-chunking.ts — 无说话人标签时的「按停顿分句」规划（纯函数，便于单测）
 *
 * 为什么需要它：整段录音转写原先在没有多说话人标签时退回**固定 60 秒网格**。
 * 后果有两个，用户都能直接看到：
 *   ① 录音短于 60 秒 → 只有一块 → 连 `[mm:ss]` 时间戳都不输出（audio-parser 里
 *      `segCount > 1` 才写戳）→ 文稿变成**一整坨没有段落、也没有时间轴的正文**，
 *      回放也失去「点一句跳到那一刻」的能力；
 *   ② 录音长于 60 秒 → 每 60 秒一刀，段落是 60 秒的巨块，且切点与说话内容毫无关系。
 *
 * 现在改成按**静音停顿**切成「句群」：段首时间戳落在下一句开口处（不是停顿中间），
 * 段落因此与朗读节奏一致。切碎不会成倍加载模型——本地批量引擎支持一次调用转多个文件
 * （见 sherpa.sherpaTranscribeMany 的实测：1 个文件 1.68s、3 个文件 1.77s）。
 *
 * 全部参数都留了兜底：停顿太少（长独白）按 maxChunkSec 硬切；碎得离谱（超过 maxCuts）
 * 返回空数组让调用方退回固定网格——宁可段落粗一点，也不要产出几百个片段。
 */

/** 一段静音（秒，相对当前待转写音频） */
export interface SilenceSpan {
  start: number;
  end: number;
}

/**
 * 停顿短于此值不算「句间停顿」。
 * 0.5s 会把换气、语气词停顿也当句界（实测同一段 44.9s 录音：0.5s → 17 处停顿，切口落在词中间，
 * 转写出来的句子被拦腰截断成「这个会议识别功能我。/ 也做了好久」）；0.8s → 7 处，切口都落在
 * 真正的句末/换人处。正常会议里的轮次停顿本来就 ≥0.8s，故这个值是两侧余量最均衡的。
 */
export const PAUSE_MIN_SEC = 0.8;
/** 单段上限：没有停顿的长独白按它兜底切（远小于原来的固定 60s 网格） */
export const PAUSE_CHUNK_MAX_SEC = 20;
/** 单段下限：比它短就不切——碎片会让段落比句子还碎，反而更难读 */
export const PAUSE_CHUNK_MIN_SEC = 3;
/** 切点上限：超过说明这段录音异常碎（或静音检测被噪声骗了），交回固定网格 */
export const PAUSE_MAX_CUTS = 400;
/** 静音判定门限：比 -35dB 更轻的持续段才按静音处理（宁少切：漏切只是段落粗一点，误切会截断句子） */
export const SILENCE_NOISE_DB = -35;

/**
 * 解析 ffmpeg silencedetect 的输出（写在 stderr 上）。
 * 行形如：`[silencedetect @ 0x…] silence_start: 12.345` / `… silence_end: 13.456 | silence_duration: 1.1`。
 * 只有 start 没有 end 的（录音末尾的静音）直接丢掉：末尾不需要切点。
 */
export function parseSilenceDetect(stderr: string): SilenceSpan[] {
  const out: SilenceSpan[] = [];
  let start: number | null = null;
  for (const raw of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(raw);
    if (s) {
      start = Number(s[1]);
      continue;
    }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(raw);
    if (e && start !== null) {
      const end = Number(e[1]);
      if (Number.isFinite(end) && Number.isFinite(start) && end > start) out.push({ start: Math.max(0, start), end });
      start = null;
    }
  }
  return out;
}

/**
 * 静音列表 + 总时长 → 切点（秒，升序；**不含** 0 与音频末尾）。
 *
 * 口径：
 *   1. 切在**停顿中点**：停顿本身就是词与词之间的静音，切在中点两侧都留了余量，
 *      不会因为落在音节边缘而让模型吞掉一个字（实测切在 `silence_end` 时出现
 *      「这个会议识别功能我。/ 做了好久」——「也」被边界吃掉；切中点后不再出现）；
 *   2. 与上一个切点相距 < minChunkSec 的候选一律跳过（避免碎片）；
 *   3. 相邻切点间隔超过 maxChunkSec 时按 maxChunkSec 兜底补切（长独白没有停顿也能分段）；
 *   4. 候选人离音频末尾不足 minChunkSec 的也跳过——切出来只是一条尾巴碎片；
 *   5. 切点数超过 maxCuts → 返回 `[]`（调用方退回固定网格）。
 */
export function planChunkCuts(
  silences: SilenceSpan[],
  durationSec: number,
  opts: { maxChunkSec?: number; minChunkSec?: number; maxCuts?: number } = {},
): number[] {
  const maxChunkSec = opts.maxChunkSec ?? PAUSE_CHUNK_MAX_SEC;
  const minChunkSec = opts.minChunkSec ?? PAUSE_CHUNK_MIN_SEC;
  const maxCuts = opts.maxCuts ?? PAUSE_MAX_CUTS;
  if (!(durationSec > minChunkSec)) return [];

  // 1) 先按停顿切：升序去重 → 太近的（会切出碎片）与尾巴碎片一并跳过
  const pauses = [...new Set(silences.map((s) => (s.start + s.end) / 2))]
    .filter((t) => Number.isFinite(t) && t > 0 && t < durationSec)
    .sort((a, b) => a - b);
  const cuts: number[] = [];
  let last = 0;
  for (const t of pauses) {
    if (t - last < minChunkSec) continue;
    if (durationSec - t < minChunkSec) continue;
    cuts.push(t);
    last = t;
  }

  // 2) 兜底：任何仍然超过 maxChunkSec 的段，从**段首**起按 maxChunkSec 补切
  //    （长独白没有停顿；末段不足 minChunkSec 就并进上一段）
  const bounds = [0, ...cuts, durationSec];
  for (let i = 1; i < bounds.length; i++) {
    for (let t = bounds[i - 1] + maxChunkSec; bounds[i] - t >= minChunkSec; t += maxChunkSec) {
      cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  return cuts.length > maxCuts ? [] : cuts;
}
