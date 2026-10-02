/**
 * 搜狗微信候选的**合并去重口径**（生产链路与评测共用同一份实现）
 *
 * 为什么独立成模块：同一份口径必须只有一个真源。之前评测工具自己写了一份按标题去重的键，
 * 而生产链路（`app/api/butler/wechat-search/route.ts`）用 url 去重 —— 两边口径一分叉，
 * "评测说修好了、线上还是重复"这种事就会发生。
 *
 * ⚠ 为什么**不能按 url 去重**（2026-10-01 实测）：
 *   搜狗返回的是 `/link?url=dn9a_-gY295K0Rci…` **加密跳转链接**，同一篇文章每次检索
 *   （哪怕同一会话、相隔几分钟）都会拿到**不同的 token**。实测：
 *     - 5 个检索方向共 62 条候选 → 唯一 url 62 个、唯一标题 51 个；
 *     - 其中 4 组"同一篇文章出现在两个方向"，**4 组的 url 全都不同**；
 *     - 落库那一轮的 12 篇里有 7 篇标题也在 pool 里，两边 url 交集 = **0**。
 *   所以按 url 去重等于没去重：重复副本会白占 12 篇候选预算里的名额，
 *   并让模型把同一篇文章当成两篇来比较。
 *
 * 代价（已知并接受）：标题相同但确实是两篇不同文章的，会被并成一篇。
 * 对这个通道（大量转载、重发、多号同文）这是划算的取舍；
 * 真正的根治是**读正文后记 canonical URL**（`mp.weixin.qq.com/s?...`），
 * 但那只有读过正文才拿得到（读正文在精选之后，见 enrich 路由）。
 */

/** 去重只需要这两个字段（生产链路的 Hit 与评测的 EvalCandidate 都满足） */
export interface DedupeableHit {
  title?: string;
  url?: string;
}

/**
 * 标题归一化：剥掉空白与常见中英标点，取前 40 字。
 * 微信里同一篇文章被转载时标题往往逐字相同，差异多在标点 / 全半角 —— 所以先剥标点再比。
 */
export function normalizeTitleForDedupe(title: string): string {
  return (title || '')
    .replace(/[\s|丨:：,，。、!！?？\-—【】[\]()（）"'"'「」《》]+/g, '')
    .slice(0, 40);
}

/**
 * 去重键：**标题优先**，标题为空才退回 url。
 * 返回空串表示这条没有可用的键（调用方应跳过它，而不是让它绕过去重）。
 */
export function candidateDedupeKey(hit: DedupeableHit): string {
  const t = normalizeTitleForDedupe(hit.title ?? '');
  if (t) return `t:${t}`;
  return hit.url ? `u:${hit.url.trim()}` : '';
}

export interface MergeResult<T> {
  merged: T[];
  /** 参与合并的原始条数（含重复） */
  rawCount: number;
  /** 被判定为重复而丢弃的条数 */
  duplicatesDropped: number;
  /** 没有可用去重键而被丢弃的条数 */
  skipped: number;
}

/**
 * 多路结果合并：**跨方向轮转（round-robin）取用 + 按标题去重 + 上限卡在"唯一条数"**。
 *
 * 为什么必须轮转：上限是 12 条，若按方向顺序取满（旧行为），第一个检索方向会独吞
 * 大部分名额 —— 对"一个问题拆成几个侧面"的场景，等于把其它侧面挤掉。
 * 轮转保证每个方向都有机会先贡献一条，再回头取第二条。
 *
 * 为什么上限卡唯一而不是原始：旧实现 `if (merged.length >= MERGE_CAP) break` 数的是
 * **原始条数**，于是 3 方向 × 4 条 = 12 原始、去重后只有 9 条唯一 ——
 * 3 个名额被同一篇文章的副本吃掉了。现在只有"新文章"才消耗名额。
 *
 * @param groups 每个检索方向一组的候选（顺序即该方向的检索排序）
 * @param cap    合并后的**唯一**条数上限
 */
export function mergeUniqueByTitle<T extends DedupeableHit>(groups: T[][], cap: number): MergeResult<T> {
  const seen = new Set<string>();
  const cursors = groups.map(() => 0);
  const merged: T[] = [];
  let rawCount = 0;
  let skipped = 0;

  for (const g of groups) rawCount += g.length;
  if (cap <= 0) return { merged, rawCount, duplicatesDropped: 0, skipped: 0 };

  for (;;) {
    let progressed = false;
    for (let gi = 0; gi < groups.length; gi += 1) {
      const arr = groups[gi];
      // 在该方向内继续往后找，跳过重复项，最多取 1 条新的
      while (cursors[gi] < arr.length) {
        const hit = arr[cursors[gi]];
        cursors[gi] += 1;
        progressed = true;
        const k = candidateDedupeKey(hit);
        if (!k) {
          skipped += 1;
          continue;
        }
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(hit);
        break;
      }
      if (merged.length >= cap) break;
    }
    // 所有方向的游标都走到头 → 没有新材料了
    if (!progressed || merged.length >= cap) break;
  }

  return { merged, rawCount, duplicatesDropped: rawCount - skipped - merged.length, skipped };
}
