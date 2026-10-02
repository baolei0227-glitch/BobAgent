/**
 * 检索宽度 A/B：**多给 LLM 精选一些候选，precision 会掉吗？**
 *
 * 由来（上一轮实测）：生产那轮的 12 篇候选，人工判相关的只占 41.7%，而同一个 pool 的相关率是 62.7%
 * —— 也就是**"选出哪 12 篇"比"从 12 篇里挑 3 篇"更成问题**（LLM 精选那步 precision 是 100%）。
 * 而 MERGE_CAP = 12 这个数字没有依据（enrich 路由的注释只写"留余量即可"）。
 *
 * 本实验就是把候选宽度 N 从 12 加到 20 / 32 / 51，看同一套 prompt、同一个模型下：
 *   - precision@3 会不会掉（会不会被更多候选分散注意）
 *   - 必找保持（grade=3）会不会升（更多必找文章进入视野）
 *   - 选出来的 3 篇具体是谁
 *
 * 关键：**代价几乎为零** —— 候选只多喂几十行文字（每篇一行标题+120 字摘要），
 * 桥那边还是同样几次页面加载（perQuery 上限 10，本来就没吃满）。
 *
 * 用法：pnpm tsx scripts/eval-width-ab.ts [--refresh]
 */
import { evaluate, renderReport } from '../src/lib/butler/search-eval';
import {
  EVAL_DIR,
  armFromPicks,
  fmtRatio,
  gradeOf,
  llmCurateCached,
  loadFixtures,
} from './eval/ab-lib';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

/** 生产当前的候选宽度（wechat-search 路由的 MERGE_CAP） */
const CURRENT_CAP = 12;
/** enrich 路由的入参上限（slice(0, 20)）——再宽就得改那一行 */
const ENRICH_CAP = 20;

async function main(): Promise<void> {
  const { baseline, pool, golden } = await loadFixtures();
  console.log(`pool：${pool.length} 篇唯一；相关 ${pool.filter((c) => (gradeOf(pool, c.title) ?? 0) >= 2).length} 篇`);
  console.log(`生产当前：候选宽度 ${CURRENT_CAP}（MERGE_CAP）；enrich 入参上限 ${ENRICH_CAP}\n`);

  // 宽度臂：同一顺序下取前 N 篇喂给精选（顺序不变，只变"给多少"）
  const widths = [CURRENT_CAP, ENRICH_CAP, 32, pool.length].filter(
    (n, i, a) => n <= pool.length && a.indexOf(n) === i,
  );
  const arms = [baseline];
  for (const n of widths) {
    const cands = pool.slice(0, n);
    const picks = await llmCurateCached(`n${n}`, baseline.query, cands);
    arms.push(armFromPicks(`N=${n}`, baseline.query, cands, picks));
  }

  const report = evaluate(arms, golden);
  const out = resolve(EVAL_DIR, `width-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  await writeFile(out, renderReport(report, '候选宽度 A/B（暂定标注）'), 'utf-8');

  console.log('## 各臂（同一套暂定标注；stored-0 是生产真实那一轮，作参照不作对比）\n');
  console.log('| 臂 | 候选数 | 该臂视野内相关 | precision@3 | 必找保持 | nDCG |');
  console.log('|---|---|---|---|---|---|');
  for (const r of report.items[0].runs) {
    const cands = arms.find((a) => a.roundId === r.roundId)?.candidates ?? [];
    const rel = cands.filter((c) => (gradeOf(pool, c.title) ?? 0) >= 2).length;
    console.log(
      `| ${r.roundId} | ${r.counts.recalled} | ${rel} | ${fmtRatio(r.metrics.precisionAtK)} | ` +
        `${fmtRatio(r.metrics.mustKeepRecall)} | ${fmtRatio(r.metrics.ndcgAtK)} |`,
    );
  }

  console.log('\n## 各臂选出的 3 篇（括号内为暂定 grade）\n');
  for (const round of arms) {
    const kept = round.candidates
      .filter((c) => c.verdict === 'kept')
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    console.log(`- ${round.roundId}: ${kept.map((c) => `${c.title.slice(0, 26)}(${gradeOf(pool, c.title) ?? '?'})`).join(' | ')}`);
  }
  // ---- 实验二：精选 prompt 的口味能不能被校准（一手优先） ----
  // 动机：实验一里 4 个宽度下"必找命中的 grade=3"恒为 2，而精选每次都选那篇 grade=2 的实务随笔
  // —— 像是"口味"问题而不是"视野"问题。这里固定给最丰富的候选集（全 pool），只换 prompt。
  console.log('\n## 实验二：prompt 变体（固定 N=pool 全量，只换判据）\n');
  const wide = pool;
  const promptArms = [baseline];
  // 最关键的一臂：**完全用生产那一轮的 12 篇候选**，只换 prompt
  //（若它也拿到 3/3，那这次修复就是一行 prompt、零成本、不必动 MERGE_CAP）
  {
    const prodCands = baseline.candidates;
    const picks = await llmCurateCached('authority-on-prod12', baseline.query, prodCands, 'authority');
    promptArms.push(armFromPicks('P·authority@生产12', baseline.query, prodCands, picks));
  }
  for (const variant of ['current', 'authority'] as const) {
    const picks = await llmCurateCached(`variants-${variant}`, baseline.query, wide, variant);
    promptArms.push(armFromPicks(`P·${variant}`, baseline.query, wide, picks));
  }
  const rep2 = evaluate(promptArms, golden);
  const out2 = resolve(EVAL_DIR, `prompt-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  await writeFile(out2, renderReport(rep2, '精选 prompt 变体 A/B（暂定标注）'), 'utf-8');

  console.log('| 臂 | 候选数 | precision@3 | 必找命中(grade3) | nDCG |');
  console.log('|---|---|---|---|---|');
  for (const r of rep2.items[0].runs) {
    const round = promptArms.find((a) => a.roundId === r.roundId);
    const kept = (round?.candidates ?? []).filter((c) => c.verdict === 'kept');
    const g3 = kept.filter((c) => (gradeOf(pool, c.title) ?? -1) === 3).length;
    console.log(
      `| ${r.roundId} | ${r.counts.recalled} | ${fmtRatio(r.metrics.precisionAtK)} | ${g3}/${kept.length} | ${fmtRatio(r.metrics.ndcgAtK)} |`,
    );
  }
  for (const round of promptArms) {
    const kept = round.candidates.filter((c) => c.verdict === 'kept').sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    console.log(`- ${round.roundId}: ${kept.map((c) => `${c.title.slice(0, 24)}(${gradeOf(pool, c.title) ?? '?'})`).join(' | ')}`);
  }
  console.log(`\n报告：${out2}`);
  console.log(`\n报告（宽度）：${out}`);
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
