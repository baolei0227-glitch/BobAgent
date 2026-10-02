/**
 * 合并去重口径的单测。
 *
 * 这些断言对应 2026-10-01 的实测事实（加密跳转链导致 url 去重失效），
 * 以及"上限必须卡唯一条数、且跨方向轮转"这两条容易被改回去的行为 ——
 * 谁把 `merged.length >= cap` 改回按原始条数计，这里必须响。
 */
import { describe, expect, it } from 'vitest';
import {
  candidateDedupeKey,
  mergeUniqueByTitle,
  normalizeTitleForDedupe,
  type DedupeableHit,
} from './wechat-dedupe';

/** 造候选：同标题 + 每次调用都不同的 url（模拟"同一篇每次 token 都不同"）。用计数器而非随机，保证可复现 */
let tokenSeq = 0;
function hit(title: string, url?: string): DedupeableHit {
  tokenSeq += 1;
  return { title, url: url ?? `https://weixin.sogou.com/link?url=dn9a_-token-${tokenSeq}` };
}

describe('去重键', () => {
  it('剥掉标点与空白后取前 40 字（转载标题的差异多在标点）', () => {
    expect(normalizeTitleForDedupe('【破产圆桌】破产衍生诉讼费用相关规定汇总')).toBe('破产圆桌破产衍生诉讼费用相关规定汇总');
    expect(normalizeTitleForDedupe('高院发布:关于破产衍生诉讼案件诉讼费缓交相关问题的通知')).toBe(
      normalizeTitleForDedupe('高院发布：关于破产衍生诉讼案件诉讼费缓交相关问题的通知'),
    );
  });

  it('标题优先，标题为空才用 url', () => {
    expect(candidateDedupeKey({ title: '某文', url: 'https://a' })).toBe('t:某文');
    expect(candidateDedupeKey({ title: '  ', url: 'https://a' })).toBe('u:https://a');
    expect(candidateDedupeKey({ title: '', url: '' })).toBe('');
  });
});

describe('多路合并（轮转 + 去重 + 上限卡唯一）', () => {
  it('同一篇文章拿到不同 token 时只保留一条', () => {
    const groups = [
      [hit('高院发布:关于破产衍生诉讼案件诉讼费缓交相关问题的通知')],
      [hit('高院发布:关于破产衍生诉讼案件诉讼费缓交相关问题的通知')],
    ];
    const r = mergeUniqueByTitle(groups, 12);
    expect(r.merged).toHaveLength(1);
    expect(r.rawCount).toBe(2);
    expect(r.duplicatesDropped).toBe(1);
  });

  it('跨方向轮转取用：不让第一个方向独吞名额', () => {
    const groups = [
      [hit('a1'), hit('a2'), hit('a3')],
      [hit('b1'), hit('b2')],
    ];
    expect(mergeUniqueByTitle(groups, 3).merged.map((h) => h.title)).toEqual(['a1', 'b1', 'a2']);
    expect(mergeUniqueByTitle(groups, 5).merged.map((h) => h.title)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('上限数的是唯一新文章，不是原始条数（旧实现白丢 3 个名额的根因）', () => {
    // 3 个方向各 4 条，其中 3 对是同一篇文章（不同 token）
    const dup = '高院发布:关于破产衍生诉讼案件诉讼费缓交相关问题的通知';
    const groups = [
      [hit(dup), hit('x1'), hit('x2'), hit('x3')],
      [hit(dup), hit('y1'), hit('y2'), hit('y3')],
      [hit(dup), hit('z1'), hit('z2'), hit('z3')],
    ];
    const r = mergeUniqueByTitle(groups, 12);
    // 旧逻辑会在这里只得到 9 条唯一（12 原始被 3 条副本占掉名额）
    expect(r.merged).toHaveLength(10);
    expect(new Set(r.merged.map((h) => h.title)).size).toBe(10);
    expect(r.rawCount).toBe(12);
    expect(r.duplicatesDropped).toBe(2);
  });

  it('没有可用键的候选被跳过并计数，不绕过去重', () => {
    const r = mergeUniqueByTitle([[hit('a'), { title: '', url: '' }, hit('b')]], 12);
    expect(r.merged.map((h) => h.title)).toEqual(['a', 'b']);
    expect(r.skipped).toBe(1);
    expect(r.duplicatesDropped).toBe(0);
  });

  it('cap <= 0 / 空输入时不炸', () => {
    expect(mergeUniqueByTitle([[hit('a')]], 0).merged).toHaveLength(0);
    expect(mergeUniqueByTitle([], 12).merged).toHaveLength(0);
    expect(mergeUniqueByTitle([[], []], 12).rawCount).toBe(0);
  });

  it('某个方向先耗尽时，剩下的名额给其它方向（不空转）', () => {
    const groups = [[hit('a1')], [hit('b1'), hit('b2'), hit('b3')]];
    expect(mergeUniqueByTitle(groups, 3).merged.map((h) => h.title)).toEqual(['a1', 'b1', 'b2']);
  });
});
