import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIM,
  centroidOf,
  cosineSimilarity,
  embedWavs,
  normalizeEmbedding,
  parseEmbeddingLine,
  parseEmbeddingOutput,
} from '@/lib/stt/speaker-embed';

/**
 * 声纹向量的纯逻辑不变量（不需要 clang / 模型 / 引擎）。
 *
 * 锁住四条口径：
 *   1. 输出解析必须**按行一一对应**且维度自洽——错位会把某人的声纹算到另一个人头上；
 *   2. 行数不等于输入数时必须报错，而不是静默补齐（宁可没有身份，也不要错的身份）；
 *   3. 余弦只认方向（尺度无关）、维度不符/零向量返回 0（退化为「无法判定」）；
 *   4. 质心先各自归一化再平均——否则音量大的段会主导质心。
 */

describe('parseEmbeddingLine', () => {
  it('OK 行 → 向量', () => {
    expect(parseEmbeddingLine('OK 3 0.5 -1 2')).toEqual([0.5, -1, 2]);
    expect(parseEmbeddingLine('  OK 1 0.25  ')).toEqual([0.25]);
  });

  it('ERR 行 / 引擎噪音 / 空行 → null', () => {
    expect(parseEmbeddingLine('ERR cannot read wave')).toBeNull();
    expect(parseEmbeddingLine('Started')).toBeNull();
    expect(parseEmbeddingLine('')).toBeNull();
  });

  it('维度声明与实际个数不符 → null（坏行不猜）', () => {
    expect(parseEmbeddingLine('OK 3 0.5 -1')).toBeNull();
    expect(parseEmbeddingLine('OK 2 0.5 -1 2')).toBeNull();
    expect(parseEmbeddingLine('OK 0')).toBeNull();
    expect(parseEmbeddingLine('OK x 1')).toBeNull();
  });

  it('数值不可解析（non-finite）→ null', () => {
    expect(parseEmbeddingLine('OK 2 0.5 nan')).toBeNull();
    expect(parseEmbeddingLine('OK 2 0.5 abc')).toBeNull();
  });
});

describe('parseEmbeddingOutput', () => {
  it('与输入一一对应，失败位置为 null', () => {
    const stdout = ['OK 2 0.1 0.2', 'ERR cannot read wave', 'OK 2 0.3 0.4'].join('\n');
    expect(parseEmbeddingOutput(stdout, 3)).toEqual([[0.1, 0.2], null, [0.3, 0.4]]);
  });

  it('忽略非 OK/ERR 的行（引擎日志冒到 stdout 也不打乱配对）', () => {
    const stdout = ['some log line', 'OK 1 0.5', 'progress 100%', 'OK 1 0.7'].join('\n');
    expect(parseEmbeddingOutput(stdout, 2)).toEqual([[0.5], [0.7]]);
  });

  it('行数与输入数不符 → 报错（错位比缺失更危险）', () => {
    expect(() => parseEmbeddingOutput('OK 1 0.5', 2)).toThrow();
    expect(() => parseEmbeddingOutput(['OK 1 0.5', 'OK 1 0.6'].join('\n'), 1)).toThrow();
  });
});

describe('cosineSimilarity', () => {
  it('同向 = 1、正交 = 0、反向 = -1；尺度无关', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
  });

  it('维度不符 / 零向量 → 0（退化为「无法判定」，不抛错）', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe('normalizeEmbedding', () => {
  it('归一化到单位长度；零向量原样返回（不除零）', () => {
    const n = normalizeEmbedding([3, 4]);
    expect(n).toEqual([0.6, 0.8]);
    expect(normalizeEmbedding([0, 0])).toEqual([0, 0]);
  });
});

describe('centroidOf', () => {
  it('先各自归一化再平均：同向但模长悬殊的两段，质心仍是该方向', () => {
    const big = [100, 0];
    const small = [1, 0];
    const c = centroidOf([big, small]);
    expect(c).not.toBeNull();
    expect(cosineSimilarity(c!, [1, 0])).toBeCloseTo(1, 10);
  });

  it('方向不同的两段，质心落在中间', () => {
    const c = centroidOf([[1, 0], [0, 1]]);
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(c![1], 10);
    expect(cosineSimilarity(c!, [1, 0])).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('空输入 / 维度不一致 → null（放弃该说话人的身份，而不是猜）', () => {
    expect(centroidOf([])).toBeNull();
    expect(centroidOf([[1, 2], [1, 2, 3]])).toBeNull();
    expect(centroidOf([[1, 2], []])).toEqual(centroidOf([[1, 2]]));
  });
});

describe('embedWavs', () => {
  it('空输入直接返回空数组（不拉起二进制）', async () => {
    await expect(embedWavs([])).resolves.toEqual([]);
  });
});

describe('EMBEDDING_DIM', () => {
  it('与 3dspeaker ERes2Net 实测维度一致', () => {
    expect(EMBEDDING_DIM).toBe(512);
  });
});