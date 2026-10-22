/**
 * 长音频的**窗口化转写**骨架（纯逻辑 + 注入式调用，无 fs / 无 ffmpeg / 无网络 ⇒ 可单测）。
 *
 * ## 为什么需要它
 * `parseAudio` 对**整段**时长有 30 分钟硬上限（`audio-parser.ts` 的 `MAX_DURATION_SEC`），
 * 而用户实际会打开 57 分钟（3401s）的录音 —— 直接报
 * `Audio is 3401s — over the 1800s (30 min) limit, transcription refused.`，
 * 界面上等于"这段音频转不了"。但按范围转写只校验**所选范围**的长度（`:720-726`），
 * 所以正解是：把整段切成若干个合法窗口，逐窗调用，再把结果按全局时间轴拼起来。
 *
 * ## 三条设计约束（改这个文件前先读）
 *   1. **窗口必须严格小于 parse 层的上限**：取 20 分钟（`DEFAULT_WINDOW_SEC`），
 *      对上 30 分钟上限留 10 分钟余量；同时给单次请求的耗时兜住（云端 STT 是分钟级的活）。
 *   2. **必须能增量落盘 + 断点续跑**：57 分钟的转写可能要几分钟，一次 HTTP 未必跑得完。
 *      每完成一窗就回调 `onProgress`（由调用方写 sidecar），下次从 `coveredUntilSec` 继续，
 *      已经转过的窗口靠 parse 层的内容哈希缓存（`,cache/parse/`，键含范围）**不再付费**。
 *   3. **"这一窗没语音"不是错误**：长录音里整段静音是常态，跳过去继续下一窗
 *      （类型化由 `NoSpeechError` 承担，适配器把它转成空数组）。
 */
import type { TranscriptSegment } from './transcript';

/** 默认窗口长度（秒）：20 分钟。必须显著小于 parse 层的 30 分钟上限 */
export const DEFAULT_WINDOW_SEC = 20 * 60;
/** 窗口下限（秒）：比这更小的窗口只会把请求数拉爆 */
export const MIN_WINDOW_SEC = 60;
/** 窗口上限（秒）：parse 层上限是 1800，这里刻意留 5 分钟余量 */
export const MAX_WINDOW_SEC = 25 * 60;
/**
 * 末窗合并阈值（秒）：最后一窗短于它就并进前一窗。
 * 否则一个 3 秒的尾巴也要独立付一次 STT 调用（窗口数 +1 而收益为零）。
 */
export const TAIL_MERGE_SEC = 2 * 60;

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface ParseWindow {
  /** 窗口起点（秒，源音频全局时间轴） */
  start: number;
  /** 窗口终点（秒，不含） */
  end: number;
}

/** 窗口长度夹到 [MIN_WINDOW_SEC, MAX_WINDOW_SEC]（非法输入取默认值） */
export function clampWindowSec(sec: unknown): number {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_SEC;
  return Math.min(MAX_WINDOW_SEC, Math.max(MIN_WINDOW_SEC, Math.round(n)));
}

/**
 * 把 `[startSec, durationSec)` 切成若干窗口（**无缝无重叠**）。
 *
 * - `durationSec ≤ 0` 或 `startSec ≥ durationSec` → `[]`（没有可转的东西）
 * - 总长 ≤ 一窗 → 单个窗口（**短音频与老路径完全一致**，不引入额外行为）
 * - 末窗不足 `TAIL_MERGE_SEC` → 并入前一窗（保证 offset 落在窗口内，不影响时间轴正确性）
 * - `startSec` 用于**断点续跑**：已覆盖到哪，就从哪继续；窗口边界与上次不同也没关系 ——
 *   段的时间戳来自 parse 层写的全局 `[mm:ss]`（`audio-parser.ts` 的 `baseOffset` 已并入），
 *   与窗口怎么切无关。
 */
export function planWindows(
  durationSec: number,
  windowSec: number = DEFAULT_WINDOW_SEC,
  startSec = 0,
): ParseWindow[] {
  const total = Number(durationSec);
  const from = Math.max(0, Number(startSec) || 0);
  if (!Number.isFinite(total) || total <= 0 || from >= total) return [];
  const win = clampWindowSec(windowSec);

  const out: ParseWindow[] = [];
  for (let s = from; s < total; s += win) out.push({ start: round1(s), end: round1(Math.min(s + win, total)) });
  /**
   * 末窗合并阈值**必须随窗口缩放**：`TAIL_MERGE_SEC`(120s) 是给默认 20 分钟窗口定的，
   * 若窗口被调到 100s（测试/将来更细的切分），「不足 120s 就合并」会把**每个**末窗都并掉、
   * 甚至把已经合法的窗口结构改掉（首版就是这里被 unit test 抓到的：预期 3 窗实得 2 窗）。
   * 语义统一成"末窗不足**半窗**就并进前一窗"。
   */
  const tailMerge = Math.min(TAIL_MERGE_SEC, win / 2);
  if (out.length >= 2 && out[out.length - 1].end - out[out.length - 1].start < tailMerge) {
    const last = out.pop() as ParseWindow;
    out[out.length - 1] = { start: out[out.length - 1].start, end: last.end };
  }
  return out;
}

/** 合并两批段：按 `t` 升序，`t` 相同（0.1s 精度）只留一条（重复窗口/重叠时的幂等保护） */
export function mergeSegments(a: TranscriptSegment[], b: TranscriptSegment[]): TranscriptSegment[] {
  const byKey = new Map<number, TranscriptSegment>();
  for (const s of [...a, ...b]) {
    if (!s.text.trim()) continue;
    byKey.set(Math.round(s.t * 10), s);
  }
  return [...byKey.values()].sort((x, y) => x.t - y.t);
}

export interface WindowedProgress {
  /** 累积段（全局时间轴） */
  segments: TranscriptSegment[];
  /** 已覆盖到的秒数（下一窗从这里继续） */
  coveredUntilSec: number;
  /** 本次已完成的窗口数 / 本次计划窗口数（仅供 UI 说明进度） */
  done: number;
  total: number;
}

/**
 * `runWindows` 的返回值。**刻意没有 `complete` 字段**：真错误是**抛出**的（不是返回值），
 * 半途失败时的进度已经通过 `onProgress` 落盘；在返回值里再放一个"是否完整"的布尔，
 * 只会多出一个"恒为 true"的字段（那种字段最容易让判据退化成平凡为真）。
 */
export type WindowedResult = WindowedProgress;

export interface RunWindowsOptions {
  plan: ParseWindow[];
  /** 此前已累积的段（断点续跑时传入） */
  existing?: TranscriptSegment[];
  /**
   * 转写**一个**窗口 → 段列表。**空数组 = 这一窗没有语音**（调用方应把
   * `NoSpeechError` 转成 `[]`，而不是让异常冒出来 —— 否则整段会卡在这一窗）。
   * 真错误（未配引擎 / 网络 / 鉴权）照常抛出，由本函数向上抛。
   */
  transcribeWindow: (w: ParseWindow) => Promise<TranscriptSegment[]>;
  /** 每完成一窗回调一次（**由调用方落盘**，用于增量持久化与进度展示） */
  onProgress?: (p: WindowedProgress) => Promise<void> | void;
}

/**
 * 逐窗跑完 `plan`。
 *
 * 语义要点：
 *   - **串行**（不并发）：云端 STT 按段计费/限流，并发只会更容易触发限流，且进度也没法算清；
 *   - 某一窗抛真错误 ⇒ **立即停止并向上抛**，但**已完成窗口的结果不会丢** ——
 *     它们在 `onProgress` 里已经落盘（这是"断点续跑"的全部依据）；
 *   - 空窗口**照常推进** `coveredUntilSec`（否则续跑会在同一个静音窗上无限重试）。
 */
export async function runWindows(opts: RunWindowsOptions): Promise<WindowedResult> {
  const { plan, transcribeWindow, onProgress } = opts;
  let segments = opts.existing ? [...opts.existing] : [];
  let covered = plan.length > 0 ? plan[0].start : 0;
  let done = 0;
  for (const w of plan) {
    const got = await transcribeWindow(w);
    segments = mergeSegments(segments, got);
    covered = w.end;
    done += 1;
    await onProgress?.({ segments, coveredUntilSec: covered, done, total: plan.length });
  }
  return { segments, coveredUntilSec: covered, done, total: plan.length };
}
