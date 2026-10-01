import { describe, expect, it } from 'vitest';
import {
  MATCH_THRESHOLD,
  emptyLibrary,
  libraryPath,
  matchCluster,
  parseLibrary,
  upsertSpeaker,
  type SpeakerLibrary,
} from '@/lib/stt/speaker-lib';
import { EMBEDDING_DIM } from '@/lib/stt/speaker-embed';

/** 造一个「第 i 维为 v」的基向量（512 维，用于构造已知余弦） */
const vec = (i: number, v = 1): number[] => {
  const a = new Array<number>(EMBEDDING_DIM).fill(0);
  a[i] = v;
  return a;
};

const libOf = (speakers: Array<{ name: string; centroid: number[] }>): SpeakerLibrary => ({
  version: 1,
  speakers: speakers.map((s, i) => ({
    id: `id-${i}`,
    name: s.name,
    centroid: s.centroid,
    count: 1,
    updatedAt: new Date(0).toISOString(),
  })),
});

describe('parseLibrary', () => {
  it('非 JSON / 空 → 空库', () => {
    expect(parseLibrary('not json').speakers).toEqual([]);
    expect(parseLibrary('{}').speakers).toEqual([]);
    expect(parseLibrary('{"speakers":null}').speakers).toEqual([]);
  });

  it('坏记录逐条跳过，好记录保留（坏一条不连坐整库）', () => {
    const text = JSON.stringify({
      speakers: [
        { name: 'Alice', centroid: vec(0), count: 2, id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' },
        { name: '   ', centroid: vec(1) }, // 名字空
        { name: 'Bob', centroid: [1, 2, 3] }, // 维度不对
        { name: 'Cara', centroid: ['abc', ...new Array(511).fill(0)] }, // 非数值 → NaN
      ],
    });
    const lib = parseLibrary(text);
    expect(lib.speakers.map((s) => s.name)).toEqual(['Alice']);
    expect(lib.speakers[0].count).toBe(2);
  });

  it('缺省字段补默认（id 生成、count=1、updatedAt 有值）', () => {
    const lib = parseLibrary(JSON.stringify({ speakers: [{ name: 'Alice', centroid: vec(0) }] }));
    expect(lib.speakers[0].id).toBeTruthy();
    expect(lib.speakers[0].count).toBe(1);
    expect(Number.isFinite(Date.parse(lib.speakers[0].updatedAt))).toBe(true);
  });
});

describe('libraryPath', () => {
  it('落在 <project>/.speakers/lib.json', () => {
    expect(libraryPath('/p/x')).toBe('/p/x/.speakers/lib.json');
  });
});

describe('matchCluster', () => {
  it('同向（余弦 1）命中最近的那位', () => {
    const lib = libOf([{ name: 'Alice', centroid: vec(0) }, { name: 'Bob', centroid: vec(1) }]);
    expect(matchCluster(vec(0), lib)).toMatchObject({ name: 'Alice' });
    expect(matchCluster(vec(1), lib)).toMatchObject({ name: 'Bob' });
  });

  it('高于阈值即命中（0.9 左右）', () => {
    const lib = libOf([{ name: 'Alice', centroid: vec(0) }]);
    const near = vec(0);
    near[1] = 0.436; // 与 e0 的余弦 ≈ 0.916
    const hit = matchCluster(near, lib);
    expect(hit?.name).toBe('Alice');
    expect(hit!.similarity).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it('全低于阈值 → null（不硬认）', () => {
    const lib = libOf([{ name: 'Alice', centroid: vec(0) }]);
    expect(matchCluster(vec(5), lib)).toBeNull(); // 正交，余弦 0
  });

  it('维度不符 / 空库 → null', () => {
    const lib = libOf([{ name: 'Alice', centroid: vec(0) }]);
    expect(matchCluster([1, 2, 3], lib)).toBeNull();
    expect(matchCluster(vec(0), emptyLibrary())).toBeNull();
  });

  it('阈值可调：调高到 0.99 则 0.9 的近似不中', () => {
    const lib = libOf([{ name: 'Alice', centroid: vec(0) }]);
    const near = vec(0);
    near[1] = 0.436;
    expect(matchCluster(near, lib, 0.99)).toBeNull();
  });
});

describe('upsertSpeaker', () => {
  it('新名字 → 追加一条，质心归一化、count=1', () => {
    const lib = upsertSpeaker(emptyLibrary(), 'Alice', vec(0, 5));
    expect(lib.speakers).toHaveLength(1);
    expect(lib.speakers[0].name).toBe('Alice');
    expect(lib.speakers[0].count).toBe(1);
    expect(lib.speakers[0].centroid[0]).toBeCloseTo(1, 6); // 归一化后单位长度
    expect(lib.speakers[0].centroid[1]).toBeCloseTo(0, 6);
  });

  it('同名 → 按 count 加权并进旧质心，id 不变、count 递增', () => {
    const first = upsertSpeaker(emptyLibrary(), 'Alice', vec(0));
    const id = first.speakers[0].id;
    const second = upsertSpeaker(first, 'Alice', vec(1));
    expect(second.speakers).toHaveLength(1);
    expect(second.speakers[0].id).toBe(id);
    expect(second.speakers[0].count).toBe(2);
    // (e0 + e1)/2 归一化 → 两维各 0.707
    expect(second.speakers[0].centroid[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(second.speakers[0].centroid[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('名字前后空白裁掉；纯空白名 → 原库不变', () => {
    const lib = upsertSpeaker(emptyLibrary(), '  Alice  ', vec(0));
    expect(lib.speakers[0].name).toBe('Alice');
    const before = lib;
    expect(upsertSpeaker(before, '   ', vec(1))).toBe(before);
  });

  it('维度不符的质心 → 原库不变', () => {
    const lib = upsertSpeaker(emptyLibrary(), 'Alice', vec(0));
    expect(upsertSpeaker(lib, 'Bob', [1, 2, 3])).toBe(lib);
  });

  it('不改原对象（返回新库）', () => {
    const before = emptyLibrary();
    upsertSpeaker(before, 'Alice', vec(0));
    expect(before.speakers).toHaveLength(0);
  });
});

describe('阈值常量', () => {
  it('落在实测分离区间 (0.22, 0.63) 内', () => {
    expect(MATCH_THRESHOLD).toBeGreaterThan(0.22);
    expect(MATCH_THRESHOLD).toBeLessThan(0.63);
  });
});