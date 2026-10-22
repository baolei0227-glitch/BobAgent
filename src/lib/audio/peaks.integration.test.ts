import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { generatePeaks, PEAKS_BUCKETS, PEAKS_SAMPLE_RATE } from '@/lib/audio/peaks';
import { FINE_HZ, decodeFine, sliceFineWindow } from '@/lib/audio/peaks-codec';

/**
 * **真值对照**（不是拿模型校验模型）：
 *   - 合成信号有**已知包络**（300Hz 载波 × 23s 周期、0.15→1.0 的振幅调制），
 *     于是「波形该长什么样」有独立答案，可以直接断言；
 *   - 再用「整份 PCM 落盘后朴素全量分桶」作为**第二个实现**，与流式微桶合并逐桶对账 ——
 *     这是微桶合并步骤唯一的外部见证。
 *
 * 覆盖的风险点（纯单测覆盖不到的）：
 *   - `-ac 1 -ar 8000 -f s16le -` 是否真的产出 2 字节/样本的单声道 8kHz（用字节数钉死）；
 *   - ffmpeg 真实管道分块是否被正确拼接（失真会立刻体现在包络上）。
 */
const run = promisify(execFile);
const require_ = createRequire(join(process.cwd(), 'package.json'));

/** 打包内置的 ffmpeg（与运行时 resolveFfmpegPath 同源） */
function ffmpegPath(): string {
  return (require_('@ffmpeg-installer/ffmpeg') as { path: string }).path;
}

/** 合成参数：320s 恰好让「每桶样本数」是微桶的整数倍（2000 桶 × 1280 样本，1280 = 16×80） */
const DUR = 320;
const CARRIER_HZ = 300;
const ENV_PERIOD_S = 23;
const PEAK = 0.9;

/** 独立实现（第二见证）：整份 PCM → 按总数等宽分桶取 abs-max */
function naiveBucket(pcm: Buffer, buckets: number): number[] {
  const total = Math.floor(pcm.length / 2);
  const per = total / buckets;
  const out: number[] = [];
  for (let j = 0; j < buckets; j++) {
    const from = Math.floor(j * per);
    const to = Math.max(from + 1, Math.ceil((j + 1) * per));
    let best = 0;
    for (let k = from; k < to && k < total; k++) {
      const s = pcm.readInt16LE(k * 2);
      if (Math.abs(s) > Math.abs(best)) best = s;
    }
    out.push(Math.round((best / 32768) * 10000) / 10000);
  }
  return out;
}

describe('generatePeaks（真值对照）', () => {
  it('字节数、桶数、时长、包络与朴素全量分桶逐桶一致', async () => {
    const ff = ffmpegPath();
    const dir = await fs.mkdtemp(join(tmpdir(), 'peaks-probe-'));
    const src = join(dir, 'probe.flac');
    const pcmFile = join(dir, 'probe.pcm');
    const expr = `${PEAK}*sin(2*PI*${CARRIER_HZ}*t)*(0.15+0.85*abs(sin(2*PI*t/${ENV_PERIOD_S})))`;

    try {
      // 无损容器：A/B 两侧解的是同一批样本，任何差异都只可能来自我们的代码
      await run(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${DUR}`, '-c:a', 'flac', src]);

      const result = await generatePeaks(ff, src);
      expect(result).not.toBeNull();
      const { peaks, duration } = result!;

      // ① 时长：8kHz 解出的样本数应与合成时长一致（容差 1 个样本）
      expect(Math.abs(duration - DUR)).toBeLessThan(1 / PEAKS_SAMPLE_RATE + 1e-9);

      // ② 桶数
      expect(peaks).toHaveLength(PEAKS_BUCKETS);

      // ③ 把同一份 PCM 落到文件：用字节数钉死「单声道 / 8kHz / s16le」的口径
      await run(ff, [
        '-v', 'error', '-y', '-i', src,
        '-vn', '-map', 'a:0', '-ac', '1', '-ar', String(PEAKS_SAMPLE_RATE), '-f', 's16le', pcmFile,
      ]);
      const pcm = await fs.readFile(pcmFile);
      expect(pcm.length).toBe(Math.round(DUR * PEAKS_SAMPLE_RATE) * 2);

      // ④ 第二见证：朴素全量分桶必须与流式微桶合并**逐桶相同**
      const expected = naiveBucket(pcm, PEAKS_BUCKETS);
      expect(peaks).toEqual(expected);

      // ⑤ 整体幅值上限 ≈ 载波峰值（验证没有增益漂移）
      const mags = peaks.map(Math.abs);
      expect(Math.max(...mags)).toBeCloseTo(PEAK, 2);

      // ⑥ 逐桶贴合已知包络（独立公式，不依赖上面的分桶实现）。
      // 注意判据是**桶窗口内的包络峰值**而非桶中心值：abs-max 天然取到窗口里的最高点，
      // 拿中心值对账会在包络过零处系统性误判（首版就踩了这个）。
      const envAt = (t: number) => PEAK * (0.15 + 0.85 * Math.abs(Math.sin((2 * Math.PI * t) / ENV_PERIOD_S)));
      const oddCeil = (x: number) => (Math.ceil(x) % 2 === 0 ? Math.ceil(x) + 1 : Math.ceil(x));
      const oddFloor = (x: number) => (Math.floor(x) % 2 === 0 ? Math.floor(x) - 1 : Math.floor(x));
      /** 窗口 [t0,t1) 内包络的最大值：顶点出现在 t=(2k+1)T/4，否则取两端较大者 */
      const envMaxIn = (t0: number, t1: number) => {
        const k0 = oddCeil((4 * t0) / ENV_PERIOD_S);
        const k1 = oddFloor((4 * t1) / ENV_PERIOD_S);
        return k1 >= k0 ? PEAK : Math.max(envAt(t0), envAt(t1));
      };
      for (let j = 0; j < mags.length; j++) {
        const t0 = (j * DUR) / mags.length;
        const t1 = ((j + 1) * DUR) / mags.length;
        const expectedEnv = envMaxIn(t0, t1);
        // 下限留 5%：8kHz 采样未必正落在载波波峰上（300Hz 时最大偏差 ≈0.7%），加上包络在窗口内的变化
        expect(mags[j]).toBeGreaterThan(expectedEnv * 0.95);
        expect(mags[j]).toBeLessThan(expectedEnv * 1.02);
      }

      // ⑦ **细分辨率（v2 新增）与粗桶对账**：两者同源（同一个 10ms 微桶数组），
      //    最容易静默漂开的正是"合并口径不一致"，所以拿粗桶当外部见证。
      if (!result) throw new Error('generatePeaks 返回 null');
      expect(typeof result.fine).toBe('string');
      expect(result.fineHz).toBe(FINE_HZ);
      const fineArr = decodeFine(result.fine as string);
      // 桶数 = 时长 × 50Hz（允许 ±1 个桶的边界误差）
      expect(Math.abs(fineArr.length - DUR * FINE_HZ)).toBeLessThanOrEqual(1);

      // 每个粗桶区间内取细桶 abs-max，应与该粗桶值一致（量化误差 ≤ 1/127 + 8kHz 采样差异）
      for (let j = 0; j < result.peaks.length; j += 37) {
        const t0 = (j * DUR) / result.peaks.length;
        const t1 = ((j + 1) * DUR) / result.peaks.length;
        const sub = sliceFineWindow(fineArr, FINE_HZ, t0, t1 - t0, 1);
        expect(sub.length).toBe(1);
        expect(Math.abs(Math.abs(sub[0]) - Math.abs(result.peaks[j]))).toBeLessThan(0.02);
      }

      // ⑧ 窗口切片：取 [10s, 12s) 的 100 个点，逐点贴合已知包络（与 ⑥ 同款独立公式）
      const win = sliceFineWindow(fineArr, FINE_HZ, 10, 2, 100);
      expect(win.length).toBe(100);
      for (let j = 0; j < win.length; j++) {
        const t0 = 10 + (j * 2) / win.length;
        const t1 = 10 + ((j + 1) * 2) / win.length;
        const expectedEnv = envMaxIn(t0, t1);
        expect(Math.abs(win[j])).toBeGreaterThan(expectedEnv * 0.94);
        expect(Math.abs(win[j])).toBeLessThan(expectedEnv * 1.03);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
