import { describe, expect, it } from 'vitest';
import {
  buildSpeakerChunks,
  clipChunks,
  speakerForRange,
  diarModeOf,
  parseDiarizationOutput,
  planClusterMerge,
  type ClusterCentroid,
  type DiarChunk,
} from '@/lib/stt/diarize';

/**
 * 说话人分离的纯逻辑不变量（不需要二进制与模型）。
 *
 * 锁住五条口径：
 *   1. CLI 输出解析容错（config dump / progress 噪音不能混进结果；stdout+stderr 双流兜底）；
 *   2. 切块必须**单一说话人 + 无空隙**——空隙意味着那段时间没人转写（文稿出现空洞）；
 *   3. 窗口裁剪后仍首尾相接、首块回拉到窗口起点（否则回放时间轴会与录音错位）；
 *   4. 参会人数口径 → 分离参数：solo 不分离；
 *   5. 重叠段先还原成分区、极小簇并进邻块（假换人的两个来源，见 diarize.ts 头注释）。
 */

describe('parseDiarizationOutput', () => {
  // 实测 v1.13.8 的 stdout 原样片段
  const stdout = [
    'OfflineSpeakerDiarizationConfig(segmentation=..., num_threads=2, min_duration_on=0)',
    'Started',
    '0.318 -- 6.865 speaker_00',
    '7.017 -- 10.747 speaker_01',
    '11.455 -- 13.632 speaker_01',
  ].join('\n');

  it('从 stdout 抽出段，忽略 config dump 与 Started', () => {
    expect(parseDiarizationOutput(stdout)).toEqual([
      { start: 0.318, end: 6.865, speaker: 0 },
      { start: 7.017, end: 10.747, speaker: 1 },
      { start: 11.455, end: 13.632, speaker: 1 },
    ]);
  });

  it('结果可能在 stderr（上游未文档化）：双流都能扫到', () => {
    const stderr = ['progress 10.00%', '1.000 -- 2.000 speaker_03'].join('\n');
    expect(parseDiarizationOutput('', stderr)).toEqual([{ start: 1, end: 2, speaker: 3 }]);
  });

  it('双流重复行去重、乱序按时间排序、非法段（end<=start）丢弃', () => {
    const dup = ['5.000 -- 6.000 speaker_00', '5.000 -- 6.000 speaker_00'].join('\n');
    expect(parseDiarizationOutput(dup, dup)).toEqual([{ start: 5, end: 6, speaker: 0 }]);

    const messy = ['9.000 -- 10.000 speaker_00', '1.000 -- 2.000 speaker_01', '3.000 -- 3.000 speaker_00'].join('\n');
    expect(parseDiarizationOutput(messy).map((t) => t.start)).toEqual([1, 9]);
  });

  it('无匹配返回空数组', () => {
    expect(parseDiarizationOutput('Started\nprogress 100.00%')).toEqual([]);
  });

  it('行尾 confidence= 被解析（compute-confidence 开启时）', () => {
    const withConf = ['0.031 -- 1.246 speaker_00 confidence=0.788', '2.000 -- 3.000 speaker_01 confidence=n/a'].join('\n');
    expect(parseDiarizationOutput(withConf)).toEqual([
      { start: 0.031, end: 1.246, speaker: 0, confidence: 0.788 },
      { start: 2, end: 3, speaker: 1 }, // n/a = 缺失，不带 confidence 字段
    ]);
  });
});

describe('buildSpeakerChunks', () => {
  it('相邻同人（间隔 < 1s）合并成一块', () => {
    const chunks = buildSpeakerChunks(
      [
        { start: 0, end: 5, speaker: 0 },
        { start: 5.5, end: 10, speaker: 0 },
      ],
      10,
    );
    expect(chunks).toEqual([{ start: 0, end: 10, speaker: 0 }]);
  });

  it('换人切成两块，且块间首尾相接（块 k 的 end = 块 k+1 的 start）', () => {
    const chunks = buildSpeakerChunks(
      [
        { start: 0, end: 5, speaker: 0 },
        { start: 5, end: 10, speaker: 1 },
      ],
      10,
    );
    expect(chunks).toEqual([
      { start: 0, end: 5, speaker: 0 },
      { start: 5, end: 10, speaker: 1 },
    ]);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
  });

  it('短促「插入语」（< 1.5s，前后同人且接回来的那段够长）并进前一块，不白切一段', () => {
    const chunks = buildSpeakerChunks(
      [
        { start: 0, end: 6, speaker: 0 },
        { start: 6.2, end: 7, speaker: 1 },
        { start: 7.2, end: 20, speaker: 0 },
      ],
      20,
    );
    expect(chunks).toEqual([{ start: 0, end: 20, speaker: 0 }]);
  });

  it('快速你来我往（每轮都短）**不**吸收，否则会整场吞成一个人', () => {
    // 320 轮 × 4s，两人交替：吸收规则若只判「前后同人」，这里会全部并到说话人 0
    const turns = Array.from({ length: 320 }, (_, i) => ({
      start: i * 4,
      end: i * 4 + 4,
      speaker: i % 2,
    }));
    const chunks = buildSpeakerChunks(turns, 1280);
    // 320 块 > 上限 → 退回固定 60s 网格
    expect(chunks.length).toBe(Math.ceil(1280 / 60));
    expect(chunks[0]).toEqual({ start: 0, end: 60, speaker: 0 });
    // 两个人都在（回归守卫：不能退化成一个人）
    expect(new Set(chunks.map((c) => c.speaker)).size).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
  });

  it('超长块（> 60s）再切一刀，且都归属同一说话人', () => {
    const chunks = buildSpeakerChunks([{ start: 0, end: 150, speaker: 2 }], 150);
    expect(chunks).toEqual([
      { start: 0, end: 60, speaker: 2 },
      { start: 60, end: 120, speaker: 2 },
      { start: 120, end: 150, speaker: 2 },
    ]);
  });

  it('兜底网格里没有语音的格子 speaker 为 null（末尾只剩静音）', () => {
    const turns = Array.from({ length: 320 }, (_, i) => ({
      start: i * 4,
      end: i * 4 + 4,
      speaker: i % 2,
    }));
    // 音频比实际语音长很多 → 末尾若干个 60s 网格落不到任何语音上
    const chunks = buildSpeakerChunks(turns, 3000);
    expect(chunks[chunks.length - 1].speaker).toBeNull();
  });

  it('空输入返回空数组', () => {
    expect(buildSpeakerChunks([], 100)).toEqual([]);
  });

  it('重叠段（长背景段 + 嵌套短段）还原成分区：取最短覆盖，不把别人的话算到长段头上', () => {
    const chunks = buildSpeakerChunks(
      [
        { start: 0, end: 20, speaker: 0 }, // 长背景段（实测 CLI 会输出这种「一条长段罩住大家」的段）
        { start: 5, end: 8, speaker: 1 }, // 嵌套短段
      ],
      20,
    );
    expect(chunks).toEqual([
      { start: 0, end: 5, speaker: 0 },
      { start: 5, end: 8, speaker: 1 },
      { start: 8, end: 20, speaker: 0 },
    ]);
  });

  it('极小簇（不足主说话人 5%）并进最近的大簇；给足时长就不并', () => {
    const turns = [
      { start: 0, end: 60, speaker: 0 }, // 主说话人 50s
      { start: 20, end: 22, speaker: 1 }, // 2s 假簇
      { start: 40, end: 48, speaker: 2 }, // 8s，真角色
    ];
    expect(new Set(buildSpeakerChunks(turns, 60).map((c) => c.speaker)).size).toBe(3);
    expect(buildSpeakerChunks(turns, 60, { tinyClusterShare: 0.05 })).toEqual([
      { start: 0, end: 40, speaker: 0 },
      { start: 40, end: 48, speaker: 2 },
      { start: 48, end: 60, speaker: 0 },
    ]);
  });

  it('短换人但前后合计不够长 → 不吸收（快速你来我往不被吞成一个人）', () => {
    // 交替短轮（每个 1.4s），前后邻居合计 2.8s < 5s，故不该被吸收
    const chunks = buildSpeakerChunks(
      [
        { start: 0, end: 1.4, speaker: 0 },
        { start: 1.4, end: 2.8, speaker: 1 },
        { start: 2.8, end: 4.2, speaker: 0 },
        { start: 4.2, end: 5.6, speaker: 1 },
        { start: 5.6, end: 40, speaker: 0 },
      ],
      40,
    );
    expect(chunks.some((c) => c.speaker === 1 && c.start === 1.4 && c.end === 2.8)).toBe(true);
  });
});

describe('clipChunks', () => {
  const chunks: DiarChunk[] = [
    { start: 0, end: 5, speaker: 0 },
    { start: 5, end: 10, speaker: 1 },
    { start: 10, end: 20, speaker: 0 },
  ];

  it('裁剪到窗口并回拉首尾（首块起点 = 窗口起点，末块终点 = 窗口终点）', () => {
    expect(clipChunks(chunks, { start: 3, end: 12 })).toEqual([
      { start: 3, end: 5, speaker: 0 },
      { start: 5, end: 10, speaker: 1 },
      { start: 10, end: 12, speaker: 0 },
    ]);
  });

  it('窗口起点落在静音里也回拉到窗口起点，保证无空隙', () => {
    const out = clipChunks(chunks, { start: 2, end: 11 });
    expect(out[0].start).toBe(2);
    expect(out[out.length - 1].end).toBe(11);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBe(out[i - 1].end);
  });

  it('完全不相交 → 空数组', () => {
    expect(clipChunks(chunks, { start: 30, end: 40 })).toEqual([]);
  });

  it('range 为 null 时原样返回（且是副本，不改动入参）', () => {
    const out = clipChunks(chunks, null);
    expect(out).toEqual(chunks);
    expect(out[0]).not.toBe(chunks[0]);
  });
});

describe('speakerForRange', () => {
  const chunks = [
    { start: 0, end: 5, speaker: 0 },
    { start: 5, end: 10, speaker: 1 },
  ];
  it('取重叠最长的切块', () => {
    expect(speakerForRange(chunks, 1, 3)).toBe(0);
    expect(speakerForRange(chunks, 6, 9)).toBe(1);
  });
  it('完全没重叠 → null（不硬塞说话人）', () => {
    expect(speakerForRange(chunks, 20, 21)).toBeNull();
  });
});

describe('diarModeOf', () => {
  it('参会人数口径 → 分离模式（solo 不分离）', () => {
    expect(diarModeOf('solo')).toBeNull();
    expect(diarModeOf('duo')).toBe('duo');
    expect(diarModeOf('group')).toBe('group');
    expect(diarModeOf('auto')).toBe('auto');
    expect(diarModeOf(undefined)).toBe('auto');
    expect(diarModeOf('bogus')).toBe('auto');
  });
});

describe('planClusterMerge', () => {
  const c = (speaker: number, centroid: number[], confidence: number | null = null): ClusterCentroid => ({
    speaker,
    centroid,
    confidence,
  });
  // 时长权重：默认按「说话越多的簇越重」给
  const dur = (map: Record<number, number>) => (s: number) => map[s] ?? 0;

  it('两位真人（余弦远低于阈值）不合并，且 remap 是恒等映射', () => {
    const clusters = [c(0, [1, 0]), c(1, [0, 1])];
    const plan = planClusterMerge(clusters, [0, 1], dur({ 0: 60, 1: 50 }));
    expect(plan.merged).toBe(false);
    expect(plan.clusters).toBe(clusters); // 原样返回，不动旧口径
    expect([...plan.remap.entries()]).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('同一人被拆成多簇（余弦 ≥ 阈值）→ 并回一个人、簇号重排、质心按说话时长加权', () => {
    // 0 与 2 余弦 ≈ 0.90（同一人），2 只说了 5s
    const clusters = [c(0, [1, 0], 0.9), c(2, [0.9, 0.44], 0.7)];
    const plan = planClusterMerge(clusters, [0, 2], dur({ 0: 60, 2: 5 }));
    expect(plan.merged).toBe(true);
    expect(plan.clusters).toHaveLength(1);
    expect(plan.clusters[0].speaker).toBe(0);
    expect(plan.clusters[0].confidence).toBeCloseTo(0.8); // (0.9 + 0.7) / 2
    // 合并质心仍与主簇同向（被 5s 那簇轻微带偏，但余弦仍 > 0.99）
    expect(plan.clusters[0].centroid[0]).toBeGreaterThan(0.99);
    expect(plan.clusters[0].centroid[1]).toBeGreaterThan(0);
    expect(plan.remap.get(0)).toBe(0);
    expect(plan.remap.get(2)).toBe(0);
  });

  it('无质心的簇也一起编号，不与重排后的新簇号撞号', () => {
    // 0 与 3 是同一人（有质心）；1、2 段太短没算出声纹
    const plan = planClusterMerge([c(0, [1, 0]), c(3, [0.95, 0.31])], [0, 1, 2, 3], dur({ 0: 40, 3: 6, 1: 2, 2: 1 }));
    expect(plan.merged).toBe(true);
    expect(plan.remap.get(0)).toBe(plan.remap.get(3));
    expect(plan.remap.get(1)).toBe(1);
    expect(plan.remap.get(2)).toBe(2);
    // 4 个原簇号 → 3 个新簇号，且互不相同
    expect(new Set(plan.remap.values()).size).toBe(3);
    // 身份层只写有质心的簇（合并组），无质心簇不写
    expect(plan.clusters.map((x) => x.speaker)).toEqual([0]);
  });

  it('用平均连接而非单连接：不被中间桥接簇链式并成一大坨', () => {
    // A~B = 0.70，B~C = 0.70（都过 0.6），但 A~C = 0，桥接后的质心与 C 只有 0.39 → 不连坐
    const clusters = [c(0, [1, 0]), c(1, [0.7, 0.71]), c(2, [0, 1])];
    const plan = planClusterMerge(clusters, [0, 1, 2], dur({ 0: 10, 1: 10, 2: 10 }), 0.6);
    expect(plan.merged).toBe(true);
    expect(new Set(plan.remap.values()).size).toBe(2); // 只并掉 A、B，C 独立
  });

  it('阈值可调（阈值高于任何一对余弦 → 不合并）；少于 2 簇无从合并', () => {
    const clusters = [c(0, [1, 0]), c(1, [0.7, 0.71])];
    expect(planClusterMerge(clusters, [0, 1], dur({ 0: 10, 1: 10 }), 0.95).merged).toBe(false);
    expect(planClusterMerge([c(0, [1, 0])], [0], dur({ 0: 10 })).merged).toBe(false);
    expect(planClusterMerge([], [0, 1], dur({ 0: 1, 1: 1 })).merged).toBe(false);
  });
});
