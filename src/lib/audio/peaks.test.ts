import { describe, expect, it } from 'vitest';
import { PeaksAccumulator, PEAKS_BUCKETS, PEAKS_SAMPLE_RATE } from '@/lib/audio/peaks';

/**
 * 峰值累积器是**流式**的，它的正确性完全取决于两件事：
 *   1. 管道分块边界不能改变结果（16 位样本可能被切成两半）；
 *   2. 「先微桶、后合并」必须与「按总数等宽切分」等价，且**保号取 abs-max**。
 * 这两条一旦错，波形会是「看起来差不多但毛刺/相位不对」——肉眼很难发现，
 * 所以必须用独立构造的输入把判据钉死（而不是拿模型校验模型）。
 */

/** 样本数组 → s16le PCM Buffer */
function pcm(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

/** 把同一段 PCM 按 `size` 字节切成多块喂进累积器（与管道分块等价） */
function feedChunked(acc: PeaksAccumulator, buf: Buffer, size: number): void {
  for (let i = 0; i < buf.length; i += size) acc.push(buf.subarray(i, Math.min(i + size, buf.length)));
}

/** 2000 个样本的正弦波：相邻值不同，任何字节错位都会改变结果 */
const wave = () => pcm(Array.from({ length: 2000 }, (_, i) => Math.round(Math.sin(i / 13) * 30000)));

describe('PeaksAccumulator', () => {
  it('块边界切在样本中间时结果不变（跨块半样本必须拼回）', () => {
    const buf = wave();

    const ref = new PeaksAccumulator();
    ref.push(buf); // 整块：不存在跨块半样本
    const expected = ref.finish(10)!.peaks;
    expect(expected).toHaveLength(10);

    // 奇数块长必然把某个 16 位样本切成两半
    for (const size of [1, 3, 5, 7, 9, 101]) {
      const acc = new PeaksAccumulator();
      feedChunked(acc, buf, size);
      expect(acc.finish(10)!.peaks).toEqual(expected);
    }
  });

  it('取桶内绝对值最大的样本（保号，而不是取 abs）', () => {
    // 前 80 个样本里绝对值最大的是 -20000；后 80 个里是 +30000
    const samples = [0, 100, -20000, ...Array(77).fill(50), ...Array(79).fill(0), 30000];
    expect(samples).toHaveLength(160);
    const acc = new PeaksAccumulator();
    acc.push(pcm(samples));
    const { peaks } = acc.finish(2)!; // 160 样本 / 2 桶 = 80 样本一桶，恰好对上两个微桶
    expect(peaks).toEqual([-20000 / 32768, 30000 / 32768].map((v) => Math.round(v * 10000) / 10000));
  });

  it('全静音 → 全 0；满量程 → ±1', () => {
    const quiet = new PeaksAccumulator();
    quiet.push(pcm(Array(300).fill(0)));
    expect(quiet.finish(4)!.peaks).toEqual([0, 0, 0, 0]);

    // -32768 的绝对值比 +32767 大，故取到 -1
    const loud = new PeaksAccumulator();
    loud.push(pcm([0, -32768, 0, 32767]));
    expect(loud.finish(1)!.peaks).toEqual([-1]);
  });

  it('无样本 / 凑不出一个样本 → null（由调用方降级）', () => {
    expect(new PeaksAccumulator().finish()).toBeNull();
    const half = new PeaksAccumulator();
    half.push(Buffer.from([7])); // 只有低字节，凑不出样本
    expect(half.finish()).toBeNull();
  });

  it('时长由总样本数换算，与桶数无关', () => {
    const oneSecond = () => {
      const acc = new PeaksAccumulator();
      acc.push(pcm(Array(PEAKS_SAMPLE_RATE).fill(0)));
      return acc;
    };
    expect(oneSecond().finish(7)!.duration).toBe(1);
    expect(oneSecond().finish(PEAKS_BUCKETS)!.duration).toBe(1);
  });

  it('桶数符合请求，且等宽切分覆盖到最后一个样本', () => {
    const acc = new PeaksAccumulator();
    // 2000 桶 × 80 样本/微桶 = 160000 样本，末尾再补一个满量程样本
    acc.push(pcm([...Array(160000).fill(1), 32767]));
    const { peaks, duration } = acc.finish(PEAKS_BUCKETS)!;
    expect(peaks).toHaveLength(PEAKS_BUCKETS);
    expect(peaks[PEAKS_BUCKETS - 1]).toBe(1); // 末尾那个样本必须落在最后一桶里
    expect(duration).toBeCloseTo(160001 / PEAKS_SAMPLE_RATE, 6);
  });

  it('桶数超过微桶数时按实际数量产出（短音频不产出重复桶）', () => {
    const acc = new PeaksAccumulator();
    acc.push(pcm(Array(160).fill(0))); // 只有 2 个微桶
    expect(acc.finish(PEAKS_BUCKETS)!.peaks).toHaveLength(2);
  });
});
