/**
 * 公众号检索 · rerank 二阶段精排的**离线 A/B**
 *
 * 回答的问题：把「LLM 用 120 字 snippet 精选 12→3」换成
 * 「rerank 模型对候选打分 → 取 12 做召回、再取 3 做精读」，到底有没有提升？
 *
 * 三条臂在**同一套标注、同一个 pool** 上比：
 *   A 基线    = 生产那一轮真实的 12 篇召回 + LLM 精选的 3 篇（落库账本）
 *   B rerank  = 对 pool 全部候选打分 → 取 12 篇当召回、取前 3 篇当精选
 *   C 全量上限 = 直接对 pool 全部候选打分取前 3（不设 12 篇预算，看"召回不设限"的天花板）
 *
 * ⚠ 标注是**代打的暂定判断**（见 PROVISIONAL_GOLDEN），只用于看**臂与臂之间的相对差**；
 * 绝对数字要等你把 scripts/eval/golden.wechat-search.json 的 grade 填完才作数。
 *
 * 用法：pnpm tsx scripts/eval-rerank-ab.ts
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { resolveAppRoot } from '../src/lib/app-root';
import {
  evaluate,
  poolCandidates,
  renderReport,
  roundFromTrace,
  type EvalCandidate,
  type EvalGoldenItem,
  type EvalGoldenSet,
  type EvalRound,
} from '../src/lib/butler/search-eval';
import { isDegenerateScores, rerankDocuments, resolveRerankConfig } from '../src/lib/ai/rerank';
import { resolveModelConfig } from '../src/lib/ai/resolve-model-config';
import type { WechatSearchTrace } from '../src/lib/bus';

const THREAD = join(resolveAppRoot(), 'butler', '.state', 'threads', 'butler-search.json');
const RUNS_DIR = resolve(__dirname, '..', '.eval', 'runs');
/** 暂定标注写这里（.eval/ 已 gitignore）——**绝不写进要提交的 golden 文件** */
const PROVISIONAL_GOLDEN = resolve(__dirname, '..', '.eval', 'golden.PROVISIONAL.json');

// ==================== 暂定标注（我代打，等你复核） ====================
// 按 pool 里的候选下标（0-based，按"生产那轮优先"的标题去重顺序）给 grade。
// 判据：3 = 直接回答查询的某个侧面且属一手/权威/深度；2 = 切题；1 = 同域但答别的；0 = 无关。
// 查询的四个侧面：① 衍生诉讼费由谁垫付/预交 ② 缓交（官方文件）③ 劣后债权 ④ 债权人会议决议与垫付
const PROVISIONAL_GRADES: number[] = [
  3, // 0  浅析破产衍生诉讼的诉讼费实务处理（生产 kept）
  3, // 1  管理人视角下破产申请受理前申请人垫付费用的性质确认与清偿
  1, // 2  破产清算程序中管理人处理债务人对外债权问题探析
  2, // 3  破产法的原则和属性（同时讲劣后债权与垫付议案表决）
  1, // 4  债务人无产可破,债权人可否启动破产清算
  1, // 5  单个债权人诉请未缴出资股东清偿
  2, // 6  追收股东抽逃出资纠纷的思考（申砖案）
  2, // 7  企业破产法修订草案二次审议稿修改意见
  2, // 8  终结破产后衍生诉讼提起的可能性探讨(下)
  1, // 9  无产可破案件中对外追收诉讼相关法律适用
  1, // 10 破产衍生诉讼典型案例丨管理人撤销权
  3, // 11 破产衍生诉讼费用相关规定汇总（生产 kept）
  3, // 12 高院发布:诉讼费缓交相关问题的通知（生产判掉 —— 权威一手来源）
  3, // 13 浅析破产衍生诉讼的诉讼费实务处理（生产 kept，与 0 同文不同转载）
  1, // 14 管理人未勤勉尽责的判断标准
  3, // 15 破产程序中衍生诉讼类型及规定（直接答"垫付的诉讼费性质"+法条）
  1, // 16 认缴制股东出资加速到期实务研究
  3, // 17 破产企业对外追偿诉讼是否需要债权人会议表决（垫付/缓交减交）
  1, // 18 破产程序终结后债权人能否诉请股东补足出资
  3, // 19 银川中院诉讼费用缓交办法（试行）—— 法院规范性文件
  2, // 20 上海高院新规解读
  3, // 21 上海市高级人民法院通知（原文）
  2, // 22 "您好,这家破产企业的诉讼费可以缓交"
  1, // 23 黄梅法院"0"收费改革（新闻）
  2, // 24 破产衍生诉讼案件诉讼费用的缓减免
  3, // 25 破产法实务操作105问丨诉讼费如何收取
  1, // 26 银川中院出台两项破产案件审理制度（新闻）
  2, // 27 关于破产衍生诉讼相关问题的梳理(上)
  3, // 28 最高法:论破产程序中劣后债权的清偿
  3, // 29 劣后债权的范围及清偿顺序
  2, // 30 股东债权劣后清偿的实务认定
  2, // 31 股东债权劣后清偿问题研究(下)
  2, // 32 股东债权劣后清偿问题研究(上)
  1, // 33 房地产企业破产债权清偿顺序
  3, // 34 人民法院报丨破产劣后债权的类型及其顺位区分
  2, // 35 破产债权清偿顺序那么乱
  2, // 36 深石原则的司法适用
  2, // 37 一文读懂破产债权的清偿顺序
  2, // 38 关于对浙江龙禧投资集团提起诉讼的议案（垫付诉讼费真实样本）
  2, // 39 破产企业股东出资瑕疵责任的追索与债权人救济
  2, // 40 破产企业股东出资不足的追缴与债权人救济方案探讨（生产 kept）
  1, // 41 关于企业破产处置实务困境的几点思考（生产判掉）
  1, // 42 无产可破案件股东未实缴出资处理实务研究
  1, // 43 清算程序中的股东出资义务问题探析
  0, // 44 新冠肺炎疫情防控期间破产重整30问（无关）
  2, // 45 追收股东抽逃出资纠纷的思考（与 6 同文）
  1, // 46 债权人申请债务人企业破产有什么好处（生产判掉）
  1, // 47 债务人在无可供执行财产时法院应否受理（生产判掉）
  1, // 48 破产清算终结后不能以账册灭失起诉股东（生产判掉）
  2, // 49 破产案件中追缴股东出资相关问题（生产判掉：明确提到垫付诉讼费议案）
  1, // 50 泰州中院丨个别债权人能否追收未缴出资（生产判掉）
];

/** 该候选的暂定等级（按标题在 pool 里的下标查） */
let poolTitleIndex = new Map<string, number>();
function isRelevant(title: string): boolean {
  const i = poolTitleIndex.get(title);
  return i !== undefined && PROVISIONAL_GRADES[i] >= 2;
}

async function loadRounds(): Promise<EvalRound[]> {
  const raw = await readFile(THREAD, 'utf-8');
  const parsed = JSON.parse(raw) as { messages?: Array<{ searchTrace?: WechatSearchTrace }> };
  return (parsed.messages ?? [])
    .filter((m): m is { searchTrace: WechatSearchTrace } => !!m.searchTrace?.items?.length)
    .map((m, i) => roundFromTrace(`stored-${i}`, m.searchTrace));
}

/** 候选的可重排文本：标题 + 公众号 + 摘要（摘要截短，避免超上下文） */
function docText(c: EvalCandidate): string {
  return `${c.title}${c.account ? `（${c.account}）` : ''}${c.snippet ? `\n${c.snippet.slice(0, 200)}` : ''}`;
}

/**
 * ⚠ 这份 prompt 是 `app/api/butler/wechat-search/enrich/route.ts` 里 `CURATE_SYSTEM` 的**副本**
 * （那边是模块私有常量）。实验要的是"用生产同一套判据"，所以刻意逐字复制；
 * 一旦那边改了判据，这里必须跟着改，否则 A/B 比的就不是同一件事。
 */
const CURATE_SYSTEM = `你是微信公众号文章的检索精选助手。用户给出一个检索关键词和一组候选文章（含序号、标题、摘要、公众号）。
请从中精选最多 3 篇：优先「与关键词高度相关」「信息量或权威性高（知名公众号、原创、深度分析）」「时效较新」的文章。
明显无关、软文广告、标题党、纯营销导流一律不选；宁可少选，也不要凑数。
只返回严格 JSON，不要 markdown：
{"picks":[{"index":0,"reason":"一句话说明入选理由"}]}
index 为候选文章序号（从 0 开始）。按相关度从高到低排序。`;

/** 用生产同款 prompt + 应用默认 chat 模型做一次精选（Arm D 用） */
async function llmCurate(
  query: string,
  cands: EvalCandidate[],
): Promise<Array<{ index: number; reason: string }>> {
  const cfg = await resolveModelConfig({});
  if (!cfg) throw new Error('没有可用的 chat 模型配置');
  const candidateList = cands
    .map((c, i) => `[${i}] ${c.title} | ${c.account || '未知公众号'} | ${(c.snippet || '').slice(0, 120)}`)
    .join('\n');
  const payload: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: CURATE_SYSTEM },
      { role: 'user', content: `检索关键词：${query}\n\n候选文章：\n${candidateList}` },
    ],
    response_format: { type: 'json_object' },
  };
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (res.status === 400 || res.status === 404) {
    delete payload.response_format;
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  }
  if (!res.ok) throw new Error(`精选调用失败 (HTTP ${res.status})`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  const s = content.indexOf('{');
  const e = content.lastIndexOf('}');
  let parsed: { picks?: Array<{ index?: number; reason?: string }> } = {};
  try {
    parsed = JSON.parse(s !== -1 && e > s ? content.slice(s, e + 1) : content) as typeof parsed;
  } catch {
    /* 解析失败 → 走兜底 */
  }
  const seen = new Set<number>();
  const picks: Array<{ index: number; reason: string }> = [];
  for (const p of parsed.picks ?? []) {
    const idx = Number(p?.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < cands.length && !seen.has(idx)) {
      seen.add(idx);
      picks.push({ index: idx, reason: (p?.reason || '').trim() });
    }
    if (picks.length >= 3) break;
  }
  // 与生产一致：模型没给出可用 picks 就兜底取前 3
  return picks.length > 0 ? picks : cands.slice(0, 3).map((_, i) => ({ index: i, reason: '' }));
}

async function main(): Promise<void> {
  const cfg = await resolveRerankConfig();
  if (!cfg) throw new Error('没有可用的 rerank 配置');
  console.log(`rerank：provider=${cfg.provider} model=${cfg.model}`);

  const stored = await loadRounds();
  if (stored.length === 0) throw new Error('线程里没有落库账本');
  const baseline = stored[0];

  // pool：所有 capture 出来的 run + 生产那一轮，按标题去重
  const poolRounds: EvalRound[] = [];
  const names = existsSync(RUNS_DIR) ? (await import('fs/promises')).readdir(RUNS_DIR) : null;
  if (names) {
    for (const n of (await names).filter((x) => x.endsWith('.json')).sort()) {
      poolRounds.push(JSON.parse(await readFile(join(RUNS_DIR, n), 'utf-8')) as EvalRound);
    }
  }
  const pool = poolCandidates([...poolRounds, baseline]);
  console.log(`pool：${pool.length} 篇唯一（${poolRounds.length} 个 capture run + 生产那一轮）`);

  // ---- 暂定标注：一条候选一条标签（value 用其标题前 40 字，保证只命中它自己/同文转载） ----
  if (pool.length !== PROVISIONAL_GRADES.length) {
    throw new Error(`暂定标注条数(${PROVISIONAL_GRADES.length})与 pool(${pool.length})不一致 —— pool 变了，需要重新核对`);
  }
  const labels = pool.map((c, i) => ({
    value: c.title.trim().slice(0, 40),
    grade: PROVISIONAL_GRADES[i],
    // 所有相关文章都标 asserted：它们都由通道真实返回过（确实存在），且理应被搜到
    ...(PROVISIONAL_GRADES[i] >= 2 ? { asserted: true } : {}),
  }));
  const item: EvalGoldenItem = {
    id: 'bankruptcy-fee-advance',
    query: baseline.query,
    note: '【暂定标注】AI 按标题+摘要代打，仅供臂间对比，不是 ground truth',
    labels,
  };
  const golden: EvalGoldenSet = {
    version: 1,
    description: '【暂定标注·非 ground truth】由 AI 按标题+摘要代打，仅用于 rerank A/B 的相对比较。',
    items: [item],
  };
  await (await import('fs/promises')).writeFile(PROVISIONAL_GOLDEN, `${JSON.stringify(golden, null, 2)}\n`, 'utf-8');
  console.log(`暂定标注已写出：${PROVISIONAL_GOLDEN}`);

  // ---- rerank：对 pool 全部候选打一次分（结果缓存，重跑不再计费） ----
  const cacheFile = resolve(__dirname, '..', '.eval', 'rerank-scores.json');
  let ranked: Array<{ index: number; score: number }>;
  const cached = existsSync(cacheFile) && !process.argv.includes('--refresh')
    ? (JSON.parse(await readFile(cacheFile, 'utf-8')) as { query: string; docCount: number; ranked: Array<{ index: number; score: number }> })
    : null;
  if (cached && cached.query === baseline.query && cached.docCount === pool.length) {
    ranked = cached.ranked;
    console.log(`rerank：用缓存（${cacheFile}），跳过调用\n`);
  } else {
    const t0 = Date.now();
    ranked = await rerankDocuments(baseline.query, pool.map(docText), { config: cfg });
    await (await import('fs/promises')).writeFile(
      cacheFile,
      `${JSON.stringify({ query: baseline.query, docCount: pool.length, ranked }, null, 2)}\n`,
      'utf-8',
    );
    console.log(`rerank 完成：${ranked.length} 条打分，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  }

  poolTitleIndex = new Map(pool.map((c, i) => [c.title, i]));
  const byRelevance = ranked.map((r) => pool[r.index]);
  /** 用 rerank 分数把一批候选重建成一轮（kept = 前 keepN） */
  const armFromRanked = (roundId: string, cands: EvalCandidate[], keepN: number): EvalRound => ({
    roundId,
    query: baseline.query,
    candidates: cands.map((c, i) => ({
      ...c,
      verdict: i < keepN ? 'kept' : 'dropped',
      ...(i < keepN ? { rank: i } : {}),
    })),
    ranked: true,
    source: 'capture-server',
  });

  const top12 = byRelevance.slice(0, 12);
  const armB = armFromRanked('B·rerank 12→rerank 取3', top12, 3);
  const armC = armFromRanked('C·rerank 全量取3', byRelevance, 3);

  // ---- Arm D（本轮真正要验的设计）：rerank 选 12 篇 → 仍由 LLM 挑 3 篇 ----
  // 假设：rerank 的强项是"从大池子里捞得更全"（召回），LLM 的强项是"在 12 篇里挑得准"（精排）。
  const llmCacheFile = resolve(__dirname, '..', '.eval', 'llm-picks.json');
  let llmPicks: Array<{ index: number; reason: string }>;
  const llmCached = existsSync(llmCacheFile) && !process.argv.includes('--refresh')
    ? (JSON.parse(await readFile(llmCacheFile, 'utf-8')) as { query: string; docCount: number; picks: Array<{ index: number; reason: string }> })
    : null;
  if (llmCached && llmCached.query === baseline.query && llmCached.docCount === top12.length) {
    llmPicks = llmCached.picks;
    console.log('LLM 精选：用缓存，跳过调用');
  } else {
    llmPicks = await llmCurate(baseline.query, top12);
    await (await import('fs/promises')).writeFile(
      llmCacheFile,
      `${JSON.stringify({ query: baseline.query, docCount: top12.length, picks: llmPicks }, null, 2)}\n`,
      'utf-8',
    );
  }
  const armD: EvalRound = {
    roundId: 'D·rerank 12→LLM 取3',
    query: baseline.query,
    candidates: top12.map((c, i) => {
      const rank = llmPicks.findIndex((p) => p.index === i);
      const kept = rank !== -1;
      return { ...c, verdict: kept ? 'kept' : 'dropped', ...(kept ? { rank } : {}) };
    }),
    ranked: true,
    source: 'capture-server',
  };

  const report = evaluate([baseline, armB, armD, armC], golden);
  const md = renderReport(report, 'rerank 二阶段精排 · 离线 A/B（暂定标注）');
  console.log(md);

  // ---- 一眼可读的对比 ----
  const fmt = (r: { num: number; den: number; value: number } | null): string =>
    r ? `${(r.value * 100).toFixed(1)}%（${r.num}/${r.den}）` : 'N/A';
  const degenerate = isDegenerateScores(ranked);
  if (degenerate) {
    console.log('\n' + '='.repeat(72));
    console.log('⚠⚠ rerank 分数退化（几乎无区分度）—— 下面 B / C / D 臂的"rerank 排序"');
    console.log('   **等于 pool 的原始顺序**，不是模型排出来的。这几行数字不能用来评价 rerank：');
    console.log('   第一版实验就是这样得出"rerank 把相关召回从 5/32 提到 7/32"的，那是假象。');
    console.log('   本次结论只能是：**这个 rerank 模型不可用**（详见 src/lib/ai/rerank.ts 头注释）。');
    console.log('='.repeat(72) + '\n');
  }
  console.log('## 四条臂对比（同一套暂定标注）' + (degenerate ? '【rerank 臂无效】' : '') + '\n');
  console.log('| 臂 | 相关召回 | precision@3 | 必找保持 | 误杀率 | nDCG |');
  console.log('|---|---|---|---|---|---|');
  for (const r of report.items[0].runs) {
    console.log(
      `| ${r.roundId} | ${fmt(r.metrics.relevantPoolRecall)} | ${fmt(r.metrics.precisionAtK)} | ` +
        `${fmt(r.metrics.mustKeepRecall)} | ${fmt(r.metrics.falseDropRate)} | ${fmt(r.metrics.ndcgAtK)} |`,
    );
  }
  // 各臂选出来的 3 篇（配暂定 grade）—— 数字之外，具体选了谁最能说明问题
  console.log('\n## 各臂选出的 3 篇（括号内为暂定 grade）\n');
  for (const round of [baseline, armB, armD, armC]) {
    const kept = round.candidates.filter((c) => c.verdict === 'kept').sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const shown = kept.map((c) => {
      const g = PROVISIONAL_GRADES[pool.findIndex((p) => p.title === c.title)];
      return `${c.title.slice(0, 30)}(${g ?? '?'})`;
    });
    console.log(`- ${round.roundId}: ${shown.join(' | ')}`);
  }

  // ---- 对照：从同一个 pool 里"随机抽 12 篇"能拿到多少相关文章 ----
  // 这是判定"rerank 到底有没有在选"的关键对照：若 rerank top-12 的相关篇数 ≈ 随机期望，
  // 那它的排序几乎没带信号，召回提升其实来自"pool 变大了"，不是来自 rerank。
  const relCount = (cs: EvalCandidate[]): number =>
    cs.filter((c) => isRelevant(c.title)).length;
  const poolRate = pool.length > 0 ? relCount(pool) / pool.length : 0;
  const randomExpect = 12 * poolRate;
  console.log('\n## 对照：随机抽 12 篇会怎样（同一 pool）\n');
  console.log(`- pool 相关率：${(poolRate * 100).toFixed(1)}%（${relCount(pool)}/${pool.length}）`);
  console.log(`- **随机抽 12 篇的期望相关数：${randomExpect.toFixed(2)} 篇**（超几何均值）`);
  console.log(`- 生产那一轮 12 篇：${relCount(baseline.candidates)} 篇（相关率 ${((relCount(baseline.candidates) / baseline.candidates.length) * 100).toFixed(1)}%）`);
  console.log(`- rerank 前 12 篇：${relCount(top12)} 篇（相关率 ${((relCount(top12) / top12.length) * 100).toFixed(1)}%）`);
  console.log('\nrerank 分数分布（分数被压得越扁，排序越像噪声）：');
  const scores = ranked.map((r) => r.score);
  const sMin = Math.min(...scores), sMax = Math.max(...scores);
  console.log(`- min=${sMin.toFixed(4)} median=${scores[Math.floor(scores.length / 2)].toFixed(4)} max=${sMax.toFixed(4)}`);
  console.log(`- 前 10 名分数：${scores.slice(0, 10).map((x) => x.toFixed(4)).join(', ')}`);
  console.log(`- **极差只有 ${(sMax - sMin).toFixed(4)}**：51 篇候选被压在这么窄的区间里，前 3 与第 30 名的差别微不足道`);

  const out = resolve(__dirname, '..', '.eval', `rerank-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  await (await import('fs/promises')).writeFile(out, md, 'utf-8');
  console.log(`\n报告：${out}`);
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
