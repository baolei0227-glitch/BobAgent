import { describe, expect, it } from 'vitest';
import { rankPoolForTaskType, type PoolItem } from './task-model';

const pool = [
  { provider: 'moonshot', modelId: 'kimi-k2' },
  { provider: 'zhipu', modelId: 'glm-4.5' },
  { provider: 'deepseek', modelId: 'deepseek-flash' },
];

describe('task-model rankPoolForTaskType (P3-3b2)', () => {
  it('推理/分析类任务 → 思考标志模型前置（稳定序）', () => {
    const ranked = rankPoolForTaskType(pool, '请分析这份合同的法律风险与违约责任');
    expect(ranked[0].modelId).toMatch(/k2|v4|reason|think/i);
    const iK2 = ranked.findIndex((x) => x.modelId === 'kimi-k2');
    const iV4 = ranked.findIndex((x) => x.modelId === 'deepseek-flash');
    const iGlm = ranked.findIndex((x) => x.modelId === 'glm-4.5');
    // 同分保持池序；思考模型应在 glm（无 hint）之前
    expect(Math.min(iK2, iV4)).toBeLessThan(iGlm);
  });

  it('常规对话/代码任务 → 保持用户池序（静态首选语义）', () => {
    const ranked = rankPoolForTaskType(pool, '你好');
    expect(ranked.map((x) => x.modelId)).toEqual(pool.map((x) => x.modelId));
    const ranked2 = rankPoolForTaskType(pool, '用 python 写一个读取 csv 的脚本');
    expect(ranked2.map((x) => x.modelId)).toEqual(pool.map((x) => x.modelId));
  });

  it('空文本/单元素/非法池 → 保序不抛错', () => {
    expect(rankPoolForTaskType(pool, '  ').map((x) => x.modelId)).toEqual(pool.map((x) => x.modelId));
    expect(rankPoolForTaskType([{ modelId: 'a' }], '分析')).toHaveLength(1);
    expect(rankPoolForTaskType([], '分析')).toEqual([]);
    expect(rankPoolForTaskType(null as unknown as PoolItem[], '分析')).toEqual(null as unknown as PoolItem[]);
  });
});
