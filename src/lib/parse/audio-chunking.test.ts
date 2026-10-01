import { describe, expect, it } from 'vitest';
import { parseSilenceDetect, planChunkCuts } from '@/lib/parse/audio-chunking';

/**
 * 「按停顿分句」的规划不变量：段落要跟着朗读节奏走，且绝不能切出碎片。
 * 这些口径直接决定会议记录有没有 `[mm:ss]` 段落与回放能不能定位。
 */

describe('parseSilenceDetect', () => {
  // 实测 ffmpeg 输出样式
  const stderr = [
    '[silencedetect @ 0x7f8] silence_start: 3.456',
    '[silencedetect @ 0x7f8] silence_end: 4.789 | silence_duration: 1.333',
    'size=N/A time=00:00:12.00 bitrate=N/A speed= 800x',
    '[silencedetect @ 0x7f8] silence_start: 10.0',
    '[silencedetect @ 0x7f8] silence_end: 11.5 | silence_duration: 1.5',
  ].join('\n');

  it('抽出静音区间，忽略其它日志行', () => {
    expect(parseSilenceDetect(stderr)).toEqual([
      { start: 3.456, end: 4.789 },
      { start: 10, end: 11.5 },
    ]);
  });

  it('只有 start 没有 end（录音末尾的静音）被丢掉', () => {
    expect(parseSilenceDetect('[silencedetect @ 0x1] silence_start: 20.5')).toEqual([]);
  });

  it('乱序 / 坏行不影响结果，不抛错', () => {
    expect(parseSilenceDetect('')).toEqual([]);
    expect(parseSilenceDetect('silence_end: 5.0')).toEqual([]);
  });
});

describe('planChunkCuts', () => {
  it('切在停顿中点（两侧都留余量，避免边界吃掉一个字）', () => {
    // 停顿 5.0~5.8 → 切 5.4；5.4→30 有 24.6s 超过 maxChunkSec → 从段首补一刀（5.4+20）
    expect(planChunkCuts([{ start: 5, end: 5.8 }], 30)).toEqual([5.4, 25.4]);
  });

  it('停顿已经够密时不再按网格补切（段落跟着朗读节奏，而不是钟表）', () => {
    // 三个停顿中点 5.4 / 6.7 / 13.6：6.7 距 5.4 只有 1.3s → 跳过；
    // 5.4 与 13.6 把音频分成 5.4 / 8.2 / 16.4 三段，都 ≤ maxChunkSec → 不再补切
    expect(planChunkCuts([{ start: 5, end: 5.8 }, { start: 6.4, end: 7.0 }, { start: 13.2, end: 14.0 }], 30)).toEqual([5.4, 13.6]);
  });

  it('长独白没有停顿 → 按 maxChunkSec 兜底切', () => {
    expect(planChunkCuts([], 55)).toEqual([20, 40]);
  });

  it('超长间隔在停顿基础上补切，保证没有超过 maxChunkSec 的巨块', () => {
    // 唯一停顿在 44~45s（中点 44.5），前半段 0~44.5 必须被兜底切开
    const cuts = planChunkCuts([{ start: 44, end: 45 }], 60);
    expect(cuts).toEqual([20, 40, 44.5]);
    // 每个间隔都不超过 maxChunkSec（末段到音频末尾同样）
    const bounds = [0, ...cuts, 60];
    for (let i = 1; i < bounds.length; i++) expect(bounds[i] - bounds[i - 1]).toBeLessThanOrEqual(20);
  });

  it('末尾的小尾巴不切（切出来也是碎片）', () => {
    // 停顿 28~28.6 的中点距末尾只有 1.7s → 不切；但 0→28.6 超过 maxChunkSec，20s 处仍要兜底一刀
    expect(planChunkCuts([{ start: 28, end: 28.6 }], 30)).toEqual([20]);
  });

  it('碎得离谱（超过 maxCuts）返回空数组，交回固定网格', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ start: i * 4, end: i * 4 + 1 }));
    expect(planChunkCuts(many, 200, { maxCuts: 5 })).toEqual([]);
  });

  it('音频比 minChunkSec 还短 → 不切', () => {
    expect(planChunkCuts([{ start: 1, end: 2 }], 2)).toEqual([]);
  });
});
