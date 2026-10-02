/**
 * 通用 A/B：**换一个真实法律问题，再验一遍「一手优先」prompt 是否普遍有效**
 *
 * 与 `eval-width-ab.ts`（q1，基于落库账本）的区别：这里不依赖任何落库轮次，
 * 直接吃一份 capture 出来的 pool + 一份**先于实验写好**的 grade 文件，
 * 所以可以用来复现"这套 prompt 改动是不是只在那一题上碰巧有效"。
 *
 * 关键的方法学约束（这个脚本本身不管，靠调用顺序保证）：
 *   `--grades` 必须在跑任何精选臂**之前**写好 —— 否则标注会被 prompt 的口味带偏。
 *
 * 四个臂：
 *   current@12   = 现状 prompt，取 pool 前 12 篇（无生产轮次时的近似）
 *   authority@12 = 一手优先 prompt，同样前 12 篇（**与上一臂同候选，只换 prompt**）
 *   current@all / authority@all = 给全 pool，看视野放开后两者差距
 *
 * 用法：
 *   pnpm tsx scripts/eval-runs-ab.ts --runs .eval/runs-q2 --grades .eval/grades-q2.json
 */
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { evaluate, renderReport } from '../src/lib/butler/search-eval';
import {
  EVAL_DIR,
  armFromPicks,
  buildGolden,
  fmtRatio,
  llmCurateCached,
  loadPoolFromDir,
  mustIn,
  relevantIn,
  type CurateVariant,
} from './eval/ab-lib';

/** 生产当前的候选宽度（MERGE_CAP） */
const PROD_WIDTH = 12;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const runsDir = resolve(arg('runs') ?? `${EVAL_DIR}/runs`);
  const gradesFile = resolve(arg('grades') ?? `${EVAL_DIR}/grades.json`);
  const gradesDoc = JSON.parse(await readFile(gradesFile, 'utf-8')) as { query: string; grades: number[] };
  const { query, grades } = gradesDoc;

  const pool = await loadPoolFromDir(runsDir);
  const golden = buildGolden(query, pool, grades, 'runs-ab');
  const relAll = relevantIn(pool, grades, pool);
  console.log(`pool：${pool.length} 篇；相关(≥2) ${relAll} 篇；必找(=3) ${mustIn(pool, grades, pool)} 篇`);
  console.log(`查询：${query.slice(0, 60)}…\n`);

  const near = pool.slice(0, PROD_WIDTH);
  const arms = [];
  for (const variant of ['current', 'authority'] as CurateVariant[]) {
    for (const [tag, cands] of [
      [`@${PROD_WIDTH}`, near],
      ['@全部', pool],
    ] as Array<[string, typeof pool]>) {
      const picks = await llmCurateCached(`q2-${variant}${tag}`, query, cands, variant);
      arms.push(armFromPicks(`${variant}${tag}`, query, cands, picks));
    }
  }

  const report = evaluate(arms, golden);
  const out = resolve(EVAL_DIR, `runs-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  await writeFile(out, renderReport(report, '第二个查询 · prompt A/B（暂定标注）'), 'utf-8');

  console.log('| 臂 | 候选数 | 该臂视野内相关 | 该臂视野内必找 | precision@3 | 必找命中 | nDCG |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of report.items[0].runs) {
    const cands = arms.find((a) => a.roundId === r.roundId)?.candidates ?? [];
    const kept = cands.filter((c) => c.verdict === 'kept');
    console.log(
      `| ${r.roundId} | ${r.counts.recalled} | ${relevantIn(pool, grades, cands)} | ${mustIn(pool, grades, cands)} | ` +
        `${fmtRatio(r.metrics.precisionAtK)} | ${mustIn(pool, grades, kept)}/${kept.length} | ${fmtRatio(r.metrics.ndcgAtK)} |`,
    );
  }

  console.log('\n各臂选出的 3 篇（括号内为暂定 grade）：\n');
  for (const round of arms) {
    const kept = round.candidates.filter((c) => c.verdict === 'kept').sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const show = kept.map((c) => {
      const i = pool.findIndex((x) => x.title === c.title);
      return `${c.title.slice(0, 26)}(${i === -1 ? '?' : grades[i]})`;
    });
    console.log(`- ${round.roundId}: ${show.join(' | ')}`);
  }
  console.log(`\n报告：${out}`);
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
