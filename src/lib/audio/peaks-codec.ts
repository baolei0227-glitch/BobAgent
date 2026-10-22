/**
 * 峰值**细分辨率**的量化与窗口切片（纯函数）。
 *
 * ## 为什么需要它
 * 现在的缓存只有 `PEAKS_BUCKETS = 2000` 个桶（整段均分）⇒ 3401s 的录音是 **1.70s/点**，
 * 一旦把视图放大到 20s 窗口，屏上只剩 **12 个点**（12 根粗柱）—— "能缩放"但看不出任何东西。
 *
 * 而生成时**已经算出 10ms 微桶**（`peaks.ts` 的 `PeaksAccumulator.feed()`），只是在
 * `finish()` 合并成 2000 桶后**被丢掉**。本模块把这条细分辨率**留下来并压到很小**：
 * 20ms 一桶（50Hz）+ int8 量化 + base64 ≈ **160KB/小时**（3401s ≈ 160KB）。
 * 20s 窗口在 50Hz 下有 **1000 个点**，是屏宽（≈370px）的 2.7 倍 ⇒ 足够清晰。
 *
 * ## 数值口径
 * 与粗桶**完全同款**：桶内取绝对值最大、归一化到 [-1, 1]（保号；渲染侧只取 `Math.abs`）。
 * 量化到 int8（-127..127）后回放时除以 127 ⇒ 误差 ≤ 1/127 ≈ 0.8%，肉眼不可见。
 *
 * ⚠️ **服务端专用**（base64 走 `Buffer`）。切片时**不重采样原始音频**，只在这条数组上取桶。
 */

/** 细分辨率：每 20ms 一个桶（50Hz）。选 20ms 而不是保留 10ms 微桶：体积减半，仍是屏宽的 2.7 倍余量 */
export const FINE_HZ = 50;
/** 10ms 微桶的采样数（8kHz × 10ms）—— 与 `peaks.ts` 的 `MICRO_SAMPLES` 同值，合并两个即 20ms */
export const MICRO_SAMPLES_10MS = 80;
/** int8 量化的最大值（保号） */
const Q_MAX = 127;

/** 把 [-1,1] 的样本序列量化为 int8 + base64（体积约为 JSON 浮点的 1/8） */
export function encodeFine(samples: readonly number[]): string {
  const buf = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Number(samples[i]);
    const clamped = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    buf[i] = Math.round(clamped * Q_MAX) & 0xff;
  }
  return buf.toString('base64');
}

/** base64 → int8 序列（读回缓存用；越界的量化值按 clamp 处理） */
export function decodeFine(b64: string): Int8Array {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    // Buffer 读到的是无符号字节；写回时用 & 0xff，故读回也要按有符号解释
    const u = buf[i];
    out[i] = u >= 0x80 ? u - 0x100 : u;
  }
  return out;
}

/**
 * 10ms 微桶 → 20ms 细桶：**两个相邻微桶取绝对值最大者**（与"桶内 abs-max"同口径）。
 * 奇数长度时最后一个微桶单独成桶（尾部 10ms 不丢）。
 */
export function mergeMicrosPairs(micros: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < micros.length; i += 2) {
    const a = micros[i];
    const b = i + 1 < micros.length ? micros[i + 1] : 0;
    out.push(Math.abs(a) >= Math.abs(b) ? a : b);
  }
  return out;
}

/**
 * 取**窗口切片**并降采样到 `points` 个点（每个点 = 该区间内 abs-max）。
 *
 * 语义（都有单测）：
 *   - 越界的取值一律夹回 `[0, fine.length-1]`：窗口只有部分落在数据里时，**宁可少画不画错**；
 *   - `points <= 0` / 非有限 ⇒ 返回空数组（调用方降级）；
 *   - 每个输出点至少覆盖 1 个细桶（`from < to`），避免出现空桶导致的"0 值深谷"；
 *   - 输入是 int8 量化值 ⇒ 输出除以 127 还原到 [-1,1]（与粗桶同量纲）。
 */
export function sliceFineWindow(
  fine: Int8Array,
  fineHz: number,
  startSec: number,
  sec: number,
  points: number,
): number[] {
  const hz = Number(fineHz);
  const n = fine.length;
  if (!Number.isFinite(hz) || hz <= 0 || n === 0) return [];
  const want = Math.floor(Number(points));
  if (!Number.isFinite(want) || want <= 0) return [];
  const start = Number(startSec);
  const len = Number(sec);
  if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0) return [];

  const from = Math.max(0, Math.floor(start * hz));
  const to = Math.min(n, Math.ceil((start + len) * hz));
  if (to <= from) return [];
  const span = to - from;
  const outLen = Math.max(1, Math.min(want, span));
  const out: number[] = [];
  for (let j = 0; j < outLen; j++) {
    const a = from + Math.floor((j * span) / outLen);
    const b = Math.max(a + 1, from + Math.ceil(((j + 1) * span) / outLen));
    let best = 0;
    for (let k = a; k < b && k < n; k++) {
      if (Math.abs(fine[k]) > Math.abs(best)) best = fine[k];
    }
    out.push(best / Q_MAX);
  }
  return out;
}
