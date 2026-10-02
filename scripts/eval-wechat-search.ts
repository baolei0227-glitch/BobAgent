/**
 * Butler 公众号检索 · 评测 CLI
 *
 * 目标：把「这条链路到底准不准」从感觉变成数字。四个子命令对应四个阶段：
 *
 *   stats          现状体检（零配置、零成本）：读落库账本，出结构性统计 + 误杀复查队列
 *   export-labels  建 golden set 骨架：生产看到的 12 篇 + **只有 pool 看到的那些**（后者是召回率的分母）
 *   capture        抓一轮真实检索（**要花钱、要桌面端、会写进"小微"会话**，见下方警告）
 *   score          用人工标注给一轮/多轮打分（通道召回 / precision@3 / 误杀率 / nDCG）
 *
 * 典型用法：
 *   pnpm tsx scripts/eval-wechat-search.ts stats
 *   pnpm tsx scripts/eval-wechat-search.ts capture --via bridge --query "<原句>" --also "<方向2>" --also "<方向3>"
 *   pnpm tsx scripts/eval-wechat-search.ts export-labels --runs .eval/runs --item <条目id>
 *   # 人工编辑 scripts/eval/golden.wechat-search.json，填 grade / asserted
 *   pnpm tsx scripts/eval-wechat-search.ts score --runs .eval/runs
 *
 * ⚠ capture --via server 的副作用（不是 bug，是链路设计）：
 *   服务端会把这一轮「提问 + 综述 + 卡片」**落库进常驻"小微"会话**（见
 *   src/lib/core/butler-search.ts 的 recordSearchExchange），并且会真实调用模型。
 *   所以：评测轮次会出现在用户的聊天记录里、并按模型价目表计费。批量跑之前先想清楚。
 *
 * ⚠ capture --via bridge 只调主进程的搜狗通道（不经过模型、不落库），用于**建 pool**：
 *   口径 ① 要求召回率只能在 pool 内测，而生产链路一轮只留 12 篇，
 *   所以要用多个检索方向各抓一次、并起来当 pool（搜狗单查询上限 10 条）。
 */
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { mergeUniqueByTitle } from '../src/lib/butler/wechat-dedupe';
import { dirname, join, resolve } from 'path';
import { resolveAppRoot } from '../src/lib/app-root';
import {
  candidateKey,
  charBigrams,
  evaluate,
  jaccard,
  poolCandidates,
  renderReport,
  roundFromTrace,
  triageDropped,
  type EvalCandidate,
  type EvalGoldenItem,
  type EvalGoldenSet,
  type EvalLabel,
  type EvalRound,
} from '../src/lib/butler/search-eval';
import type { WechatSearchTrace } from '../src/lib/bus';

/** 落库账本的默认位置（常驻"小微"线程） */
const DEFAULT_THREAD = join(resolveAppRoot(), 'butler', '.state', 'threads', 'butler-search.json');
/** golden set 默认位置（**要提交**：人工标注是最贵的资产） */
const DEFAULT_GOLDEN = resolve(__dirname, 'eval', 'golden.wechat-search.json');
/** 产物默认位置（报告 / capture 出来的 run，**不提交**） */
const DEFAULT_OUT = resolve(__dirname, '..', '.eval');
/** 桥文件（主进程写，含搜狗通道的 url + token） */
const BRIDGE_FILE = join(resolveAppRoot(), '.runtime', 'hippo-bridge.json');

// ==================== 参数解析（无依赖，够用就行） ====================

interface Args {
  cmd: string;
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? 'stats';
  const flags = new Map<string, string[]>();
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      const k = a.slice(2, eq);
      flags.set(k, [...(flags.get(k) ?? []), a.slice(eq + 1)]);
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(k, [...(flags.get(k) ?? []), next]);
      i += 1;
    } else {
      flags.set(k, [...(flags.get(k) ?? []), 'true']);
    }
  }
  return { cmd, flags };
}

function flag(args: Args, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}
function flagAll(args: Args, name: string): string[] {
  return args.flags.get(name) ?? [];
}
function has(args: Args, name: string): boolean {
  return args.flags.has(name);
}

// ==================== 读取落库账本 ====================

/** 从线程文件里抽出所有带 searchTrace 的轮次（按消息顺序；**只读，不改文件**） */
async function loadRoundsFromThread(file: string): Promise<EvalRound[]> {
  if (!existsSync(file)) throw new Error(`找不到线程文件：${file}`);
  const raw = await readFile(file, 'utf-8');
  const parsed = JSON.parse(raw) as {
    messages?: Array<{ role?: string; /** 逐条消息时间（老文件可能没有） */ t?: number; searchTrace?: WechatSearchTrace }>;
  };
  const msgs = parsed.messages ?? [];
  const rounds: EvalRound[] = [];
  msgs.forEach((m, i) => {
    if (!m.searchTrace || !Array.isArray(m.searchTrace.items) || m.searchTrace.items.length === 0) return;
    // 该条 assistant 消息之前的最后一条 user 消息就是原问题；取不到就用账本自带的 query
    let runAt: number | undefined;
    const prevUser = [...msgs.slice(0, i)].reverse().find((x) => x.role === 'user');
    if (prevUser && typeof prevUser.t === 'number') runAt = prevUser.t;
    rounds.push(
      roundFromTrace(`stored-${i}`, m.searchTrace, runAt),
    );
  });
  return rounds;
}

/** 从目录里读 capture 产出的 run 文件 */
async function loadRoundsFromDir(dir: string): Promise<EvalRound[]> {
  if (!existsSync(dir)) throw new Error(`找不到 run 目录：${dir}`);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out: EvalRound[] = [];
  for (const n of names) {
    const raw = await readFile(join(dir, n), 'utf-8');
    out.push(JSON.parse(raw) as EvalRound);
  }
  return out;
}

// ==================== stats：现状体检 ====================

function pct(num: number, den: number): string {
  if (den <= 0) return 'N/A';
  return `${((num / den) * 100).toFixed(1)}%`;
}

async function cmdStats(args: Args): Promise<void> {
  const thread = flag(args, 'thread') ?? DEFAULT_THREAD;
  const rounds = await loadRoundsFromThread(thread);
  if (rounds.length === 0) {
    console.log(`没有找到任何带账本的检索轮次（${thread}）。`);
    console.log('提示：先用 Butler 联系人列的搜索栏跑一次「Search WeChat Articles」。');
    return;
  }

  if (has(args, 'json')) {
    console.log(JSON.stringify(rounds, null, 2));
    return;
  }

  let totalCand = 0;
  let totalKept = 0;
  let totalRead = 0;
  let totalReadDen = 0;

  console.log(`账本：${thread}`);
  console.log(`轮次：${rounds.length}`);
  console.log('');

  for (const r of rounds) {
    const kept = r.candidates.filter((c) => c.verdict === 'kept');
    const dropped = r.candidates.filter((c) => c.verdict === 'dropped');
    const pending = r.candidates.filter((c) => c.verdict === 'pending');
    const readOk = kept.filter((c) => c.readOk === true).length;
    const readDen = kept.filter((c) => typeof c.readOk === 'boolean').length;
    totalCand += r.candidates.length;
    totalKept += kept.length;
    totalRead += readOk;
    totalReadDen += readDen;

    console.log(`── ${r.roundId} ──`);
    console.log(`检索词：${r.query}`);
    console.log(
      `召回 ${r.candidates.length} · 留下 ${kept.length} · 判掉 ${dropped.length}${pending.length ? ` · 未判定 ${pending.length}` : ''}` +
        ` · 留下率 ${pct(kept.length, r.candidates.length)}`,
    );
    console.log(`正文读到：${readOk}/${readDen}${readDen === 0 ? '（本轮没读正文）' : ''}`);
    console.log(`模型排序：${r.ranked ? '有（nDCG 可算）' : '无（账本按召回序，nDCG 不可算）'}`);
    // 检索方向：2026-10-01 起才落库；没有它就是老轮次（无法归因"规划 vs 通道"）
    if (r.planQueries?.length) {
      console.log(`检索方向（${r.planQueries.length}）：${r.planQueries.join(' / ')}${r.intent ? `  ← ${r.intent}` : ''}`);
    } else {
      console.log('检索方向：账本未记录（本轮落库早于该字段）');
    }

    // 误杀复查队列：字面同域的 dropped 排前面。这是**给人读的**，不是判定
    const triage = triageDropped(r).slice(0, 5);
    if (triage.length > 0) {
      console.log('');
      console.log('  被判掉的候选（按与原句的字面同域度排序，仅供人工复查）：');
      for (const t of triage) {
        console.log(`   ${t.score.toFixed(3)}  ${t.candidate.title.slice(0, 52)}  [${t.candidate.account || '未知公众号'}]`);
        if (t.candidate.snippet) console.log(`          ${t.candidate.snippet.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    console.log('');
  }

  console.log('== 汇总 ==');
  console.log(
    `轮次 ${rounds.length} · 候选 ${totalCand} · 留下 ${totalKept}（${pct(totalKept, totalCand)}）· 正文读到 ${totalRead}/${totalReadDen}`,
  );
  console.log('');
  console.log('注意：以上全部是**描述性统计**，不是精度。');
  console.log('要测召回 / 误杀，必须有人工标注：先 export-labels，填完 grade / asserted 再 score。');
}

// ==================== export-labels：建 golden 骨架 ====================

/** 标题过长时截断为可读的匹配键（保持唯一，避免一条标注命中两篇） */
function labelKey(c: EvalCandidate): string {
  return c.title.trim().slice(0, 60);
}

async function cmdExportLabels(args: Args): Promise<void> {
  const thread = flag(args, 'thread') ?? DEFAULT_THREAD;
  const out = flag(args, 'out') ?? DEFAULT_GOLDEN;
  const runsDir = flag(args, 'runs');
  const threadRounds = has(args, 'no-thread') ? [] : await loadRoundsFromThread(thread);
  const poolRounds = runsDir ? await loadRoundsFromDir(runsDir) : [];
  const allRounds = [...threadRounds, ...poolRounds];
  if (allRounds.length === 0) throw new Error(`没有可用的 run（线程 ${thread}${runsDir ? ` / 目录 ${runsDir}` : ''}）`);

  // 已存在的人工标注绝不能被静默覆盖；但一条都没填时允许直接重建（别逼人 --force）
  if (existsSync(out) && !has(args, 'force')) {
    const existing = JSON.parse(await readFile(out, 'utf-8')) as EvalGoldenSet;
    const graded = existing.items.flatMap((it) => it.labels).filter((l) => l.grade !== null).length;
    if (graded > 0) {
      throw new Error(
        `${out} 已有 ${graded} 条标注。人工标注是最贵的资产，不覆盖；确实要重来请加 --force（会丢标注）。`,
      );
    }
    console.log(`（${out} 已存在但一条都没标注 → 直接重建）`);
  }

  // --round / --query 用来**选轮次**，--item 只用来**给 golden 条目命名**（两件事，别混）
  const roundFilter = flag(args, 'round') ?? flag(args, 'query');
  const itemId = flag(args, 'item');
  // 只从**落库账本**里选条目：它才是"生产那一轮"（有 kept/dropped 判定）
  const picked = (roundFilter
    ? threadRounds.filter((r) => r.roundId === roundFilter || r.query.includes(roundFilter))
    : threadRounds);
  if (picked.length === 0) {
    throw new Error(
      threadRounds.length === 0
        ? `线程里没有带账本的轮次：${thread}`
        : '没有轮次命中 --round / --query 过滤条件',
    );
  }
  if (picked.length > 1 && itemId) {
    throw new Error(`--item 只在导出单个轮次时可用（当前命中 ${picked.length} 个轮次）`);
  }

  /** 归属键：pool run 的 query 是子方向，靠 itemQuery 归到原句 */
  const alignKey = (r: EvalRound) => (r.itemQuery || r.query).trim();

  const items: EvalGoldenItem[] = [];
  const triageSections: string[][] = [];

  for (const [i, r] of picked.entries()) {
    const poolRoundsForItem = allRounds.filter((x) => alignKey(x) === alignKey(r));
    const pool = poolCandidates(poolRoundsForItem);
    const recalled = new Set(r.candidates.map((c) => candidateKey(c)));
    const missed = pool.filter((c) => !recalled.has(candidateKey(c)));

    // 生产没召回的那些，按"字面同域度"排序 —— 人工优先标前几篇就够
    const q = charBigrams([r.query, ...(r.planQueries ?? [])].join(' '));
    const scoredMissed = missed
      .map((c) => ({ c, score: jaccard(charBigrams(`${c.title} ${c.snippet ?? ''}`), q) }))
      .sort((a, b) => b.score - a.score);

    const labels: EvalLabel[] = [
      // ① 生产那一轮看到的（判定信息最全，先标这些）
      ...r.candidates.map((c) => ({
        value: labelKey(c),
        grade: null,
        note: `${c.verdict === 'kept' ? 'AI 留下' : c.verdict === 'dropped' ? 'AI 判掉' : '未判定'}` +
          `${c.account ? ` · ${c.account}` : ''}${c.reason ? ` · 理由：${c.reason}` : ''}`,
      })),
      // ② 只有 pool 看到、生产 12 篇预算没吃下的（这 39 篇才是"召回窄"的代价，必须能标）
      ...scoredMissed.map(({ c, score }) => ({
        value: labelKey(c),
        grade: null,
        note: `仅 pool（生产未召回） · 同域度 ${score.toFixed(3)}${c.account ? ` · ${c.account}` : ''}`,
      })),
    ];

    items.push({
      id: picked.length === 1 && itemId ? itemId : `round-${i + 1}`,
      query: r.query,
      note:
        `来源 ${r.roundId}（${r.source}）；生产召回 ${r.candidates.length} 篇，` +
        `pool ${pool.length} 篇（${poolRoundsForItem.length} 个 run），其中 ${missed.length} 篇生产未召回`,
      labels,
    });

    // ---- 复查清单 ----
    const triageMap = new Map(triageDropped(r).map((t) => [t.candidate.url, t.score]));
    const row = (verdict: string, score: string, c: EvalCandidate): string =>
      `| ${verdict} | ${score} | ${c.title.replace(/\|/g, '\\|')} | ` +
      `${(c.account ?? '—').replace(/\|/g, '\\|')} | ${(c.snippet ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 70)} | ` +
      `${(c.reason ?? '—').replace(/\|/g, '\\|').slice(0, 50)} |`;

    const sec: string[] = [];
    sec.push(`**${r.query}**`);
    sec.push('');
    sec.push(`> 生产召回 ${r.candidates.length} 篇 · pool ${pool.length} 篇 · **生产未召回 ${missed.length} 篇**`);
    sec.push('');
    sec.push('### ① 生产那一轮看到的（先标这些：它们同时决定 precision 与误杀率）');
    sec.push('');
    sec.push('| 判定 | 同域度 | 标题 | 公众号 | 摘要 | AI 理由 |');
    sec.push('|---|---|---|---|---|---|');
    for (const c of r.candidates) {
      const s = triageMap.get(c.url);
      sec.push(row(c.verdict, s === undefined ? '—' : s.toFixed(3), c));
    }
    sec.push('');
    if (scoredMissed.length > 0) {
      sec.push('### ② 只有 pool 看到、生产没召回的（标出"本该被搜到"的 → 这才是召回率的分母）');
      sec.push('');
      sec.push('> 按同域度降序。**不用全标**：至少把前 10–15 篇里有价值的标上 `asserted: true`，');
      sec.push('> 剩下的留 null（留空 = 不进任何分母，不会污染指标）。');
      sec.push('');
      sec.push('| 同域度 | 标题 | 公众号 | 摘要 |');
      sec.push('|---|---|---|---|');
      for (const { c, score } of scoredMissed) {
        sec.push(
          `| ${score.toFixed(3)} | ${c.title.replace(/\|/g, '\\|')} | ${(c.account ?? '—').replace(/\|/g, '\\|')} | ` +
            `${(c.snippet ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 70)} |`,
        );
      }
      sec.push('');
    }
    sec.push('> "同域度"只是标题/摘要与原句的字符 bigram Jaccard —— **谁看起来像**，不是**谁相关**。');
    sec.push('');
    triageSections.push(sec);
  }

  const golden: EvalGoldenSet = {
    version: 1,
    description:
      'Butler 公众号检索的 golden set。grade：3=必找（一手/权威）2=相关 1=边缘 0=无关；' +
      'asserted=true 表示"人工确认真实存在且应当被搜到"，只有它进通道召回的分母（口径 ①）。' +
      '注意 note 里区分"AI 留下/AI 判掉/仅 pool（生产未召回）"三类。',
    items,
  };

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(golden, null, 2)}\n`, 'utf-8');

  const triagePath = out.replace(/\.json$/, '.triage.md');
  const lines: string[] = ['# 待标注清单（人工填 golden JSON 里的 grade）', ''];
  for (const [i, sec] of triageSections.entries()) {
    lines.push(`## ${items[i].id}`);
    lines.push('');
    lines.push(...sec);
  }
  await writeFile(triagePath, `${lines.join('\n')}\n`, 'utf-8');

  const totalLabels = items.reduce((n, it) => n + it.labels.length, 0);
  console.log(`已写出 golden 骨架：${out}（${totalLabels} 条待标注）`);
  console.log(`已写出复查清单：${triagePath}`);
  console.log('');
  console.log('下一步（人工）：');
  console.log('  1. 打开复查清单：① 生产看到的 12 篇 → 给 grade（决定 precision 与误杀率）；');
  console.log('  2. ② 只有 pool 看到的那些 → 把"本该被搜到"的补上 "asserted": true（决定召回率）；');
  console.log('     不用全标，前 10–15 篇里有价值的标掉即可，其余留 null（不进分母）。');
  console.log('  3. 然后跑：pnpm tsx scripts/eval-wechat-search.ts score --runs .eval/runs');
}

// ==================== directions：按检索方向归因 ====================

/**
 * 每个 capture run = **一个检索方向**（见 capture 的 --also）。本命令回答：
 * 「12 篇预算被哪个方向占掉了？哪个方向白跑？相关文章分别是谁捞到的？」
 *
 * 这是 `WechatSearchTrace.queries` 那个字段的用武之地：没有它，
 * "召回差"只能笼统归因到"搜狗不行"，分不清是**规划器给错方向**还是**预算被先到的方向吃满**。
 */
async function cmdDirections(args: Args): Promise<void> {
  const runsDir = flag(args, 'runs');
  if (!runsDir) throw new Error('directions 需要 --runs <dir>');
  const runs = await loadRoundsFromDir(runsDir);
  if (runs.length === 0) throw new Error(`目录里没有 run：${runsDir}`);

  const gradesPath = flag(args, 'grades');
  const grades = gradesPath
    ? (JSON.parse(await readFile(gradesPath, 'utf-8')) as { grades: number[] }).grades
    : null;
  const budgetRaw = Number(flag(args, 'budget'));
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 12;

  const pool = poolCandidates(runs);
  const poolIndex = new Map(pool.map((c, i) => [candidateKey(c), i]));
  const gradeOf = (key: string): number | null => {
    const i = poolIndex.get(key);
    return grades && i !== undefined ? (grades[i] ?? null) : null;
  };
  /** 每个 pool 候选是**哪个方向**首次带来的（归因的关键：谁捞到的） */
  const firstBy = new Map<string, string>();
  for (const r of runs) {
    for (const c of r.candidates) {
      const k = candidateKey(c);
      if (!firstBy.has(k)) firstBy.set(k, r.roundId);
    }
  }

  console.log(`目录：${runsDir}`);
  console.log(`pool：${pool.length} 篇唯一（${runs.length} 个方向）· 预算 ${budget} 篇${grades ? '' : ' · ⚠ 没给 --grades，无法算相关数'}\n`);
  // 预算集合必须按**生产真实的合并规则**算（轮转 + 标题去重 + 上限卡唯一），
  // 不能按 pool 原序取前 N —— 后者是修复前的"顺序取"，两者差别极大（见下方对比）。
  const rrBudget = mergeUniqueByTitle(runs.map((r) => r.candidates), budget).merged;
  const rrKeys = new Set(rrBudget.map(candidateKey));
  const seqKeys = new Set(pool.slice(0, budget).map(candidateKey));
  const stat = (keys: Set<string>) =>
    grades
      ? `${[...keys].filter((k) => (gradeOf(k) ?? -1) >= 2).length} 相关 / ${[...keys].filter((k) => gradeOf(k) === 3).length} 必找`
      : '—';

  console.log('| 方向 | 返回 | 净新增 | 其中相关 | 其中必找 | 进预算(轮转) |');
  console.log('|---|---|---|---|---|---|');
  for (const r of runs) {
    const keys = [...new Set(r.candidates.map(candidateKey))];
    const fresh = keys.filter((k) => firstBy.get(k) === r.roundId);
    const rel = grades ? fresh.filter((k) => (gradeOf(k) ?? -1) >= 2).length : null;
    const must = grades ? fresh.filter((k) => gradeOf(k) === 3).length : null;
    const inBudget = fresh.filter((k) => rrKeys.has(k)).length;
    const label = r.query.slice(0, 34);
    console.log(
      `| ${label} | ${r.candidates.length} | ${fresh.length} | ${rel ?? '—'} | ${must ?? '—'} | ${inBudget}/${budget} |`,
    );
  }

  // 预算构成：谁把名额吃掉了
  const byDir = (keys: Set<string>) => {
    const m = new Map<string, number>();
    for (const k of keys) {
      const d = firstBy.get(k) ?? '?';
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return [...m.entries()].map(([d, n]) => `${d}×${n}`).join(' · ');
  };
  console.log(`\n| 取法 | 构成 | 内容 |`);
  console.log(`|---|---|---|`);
  console.log(`| 轮转（当前生产实现） | ${byDir(rrKeys)} | ${stat(rrKeys)} |`);
  console.log(`| 顺序取（修复前） | ${byDir(seqKeys)} | ${stat(seqKeys)} |`);

  if (grades) {
    // 相关文章的归属：谁捞到的（这是"方向选得好不好"的正面证据）
    const relAll = pool.filter((_, i) => grades[i] >= 2);
    const relBy = new Map<string, number>();
    for (const c of relAll) {
      const d = firstBy.get(candidateKey(c)) ?? '?';
      relBy.set(d, (relBy.get(d) ?? 0) + 1);
    }
    console.log(`相关文章（${relAll.length} 篇）的方向归属：${[...relBy.entries()].map(([d, n]) => `${d}×${n}`).join(' · ')}`);
    const blank = runs.filter((r) => ![...new Set(r.candidates.map(candidateKey))].some((k) => firstBy.get(k) === r.roundId && (gradeOf(k) ?? -1) >= 2));
    if (blank.length > 0) {
      console.log(`\n⚠ 白跑的方向（净新增里一篇相关都没有）：${blank.map((r) => `${r.roundId}「${r.query.slice(0, 24)}」`).join(' · ')}`);
    }
  }
}

// ==================== score：打分 ====================

async function cmdScore(args: Args): Promise<void> {
  const goldenPath = flag(args, 'golden') ?? DEFAULT_GOLDEN;
  if (!existsSync(goldenPath)) {
    throw new Error(`找不到 golden set：${goldenPath}（先跑 export-labels）`);
  }
  const golden = JSON.parse(await readFile(goldenPath, 'utf-8')) as EvalGoldenSet;
  if (!Array.isArray(golden.items) || golden.items.length === 0) throw new Error('golden set 为空');

  // 评分同时吃两类 run：**生产那一轮**（落库账本，测 precision / 误杀）+
  // capture 出来的 pool run（扩 pool，测召回）。只给 --runs 会让 pool 里没有"被评的那一轮"，
  // precision 全是 N/A —— 所以默认把落库账本一起读进来，--no-thread 才关掉。
  const runsDir = flag(args, 'runs');
  const threadPath = flag(args, 'thread') ?? DEFAULT_THREAD;
  const rounds: EvalRound[] = [];
  if (runsDir) rounds.push(...(await loadRoundsFromDir(runsDir)));
  if (!has(args, 'no-thread')) rounds.push(...(await loadRoundsFromThread(threadPath)));
  // 同 roundId 去重（重复跑 score --runs 同一目录不会把 pool 算两遍）
  const seenIds = new Set<string>();
  const deduped = rounds.filter((r) => (seenIds.has(r.roundId) ? false : (seenIds.add(r.roundId), true)));
  if (deduped.length === 0) throw new Error('没有可评分的 run');

  const report = evaluate(deduped, golden);
  const md = renderReport(report);
  console.log(md);

  const out = flag(args, 'out');
  if (out !== 'false') {
    const path = out ?? join(DEFAULT_OUT, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, md, 'utf-8');
    console.log('');
    console.log(`报告已写出：${path}`);

    // 同一份数据也留 JSON，方便以后做趋势（改了 prompt 之后对比同一 golden）
    const jsonPath = path.replace(/\.md$/, '.json');
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    console.log(`原始指标：${jsonPath}`);
  }

  // 有 run 没对上 golden → 非零退出，方便接 CI
  const graded = golden.items.flatMap((it) => it.labels).filter((l) => l.grade !== null).length;
  if (graded === 0) {
    console.log('');
    console.log('⚠ golden set 里一条 grade 都没填：以上所有指标都是 N/A。');
    process.exitCode = 2;
  }
}

// ==================== capture：抓一轮真实检索 ====================

interface ThreadsFrames {
  curated: Array<{ id: number; reason: string }>;
  readOk: Map<number, boolean>;
  error?: string;
  captcha: boolean;
}

/** 消费 enrich 的 SSE，只挑评测需要的帧（curated 给排序、article 给 readOk、error 给失败） */
async function consumeEnrich(resp: Response, into: ThreadsFrames): Promise<void> {
  const reader = resp.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i = buf.indexOf('\n\n');
    while (i !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (ev.type === 'curated') {
          const items = Array.isArray(ev.items) ? (ev.items as Array<{ id?: number; reason?: string }>) : [];
          // flatMap 而不是 filter+as：不动用类型断言也能把 id 收窄成 number
          into.curated = items.flatMap((x) =>
            typeof x.id === 'number' ? [{ id: x.id, reason: x.reason ?? '' }] : [],
          );
        } else if (ev.type === 'article') {
          if (typeof ev.id === 'number') into.readOk.set(ev.id, !!ev.ok);
        } else if (ev.type === 'captcha') {
          into.captcha = true;
        } else if (ev.type === 'error') {
          into.error = String(ev.error ?? 'unknown');
        }
      }
      i = buf.indexOf('\n\n');
    }
  }
}

async function cmdCapture(args: Args): Promise<void> {
  const q = flag(args, 'query');
  if (!q) throw new Error('capture 需要 --query（原句，越接近真实提问越好）');
  const via = flag(args, 'via') ?? 'bridge';
  const outDir = flag(args, 'out') ?? join(DEFAULT_OUT, 'runs');
  const dry = has(args, 'dry-run');
  await mkdir(outDir, { recursive: true });

  if (via === 'bridge') {
    // ---- 只调搜狗通道：不经过模型、不落库。用于建 pool（口径 ①）----
    const bridge = JSON.parse(await readFile(BRIDGE_FILE, 'utf-8')) as { url?: string; token?: string };
    if (!bridge.url) throw new Error(`桥文件里没有 url：${BRIDGE_FILE}（桌面端没启动？）`);
    const base = bridge.url.replace(/\/+$/, '');
    const queries = [q, ...flagAll(args, 'also')];
    console.log(`经桥建 pool：${queries.length} 个检索方向`);
    for (const [i, qq] of queries.entries()) {
      if (dry) {
        console.log(`[dry-run] POST ${base}/wechat-mp  query=${qq}`);
        continue;
      }
      const res = await fetch(`${base}/wechat-mp?token=${encodeURIComponent(bridge.token ?? '')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: qq, maxResults: 10 }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        captcha?: boolean;
        results?: Array<{ title: string; url: string; account?: string; snippet?: string }>;
      };
      const candidates: EvalCandidate[] = (data.results ?? []).map((h, idx) => {
        const c: EvalCandidate = { id: idx, title: h.title, url: h.url, verdict: 'pending' };
        if (h.account) c.account = h.account;
        if (h.snippet) c.snippet = h.snippet;
        return c;
      });
      const round: EvalRound = {
        roundId: `pool-${i + 1}`,
        query: qq,
        // 子方向归属于原句：否则这条 run 会因为 query 对不上 golden 条目被算成孤儿，pool 白建
        itemQuery: q,
        intent: null,
        planQueries: queries,
        candidates,
        ranked: false,
        source: 'capture-bridge',
        runAt: Date.now(),
        meta: { captcha: !!data.captcha, via: 'bridge' },
      };
      const path = join(outDir, `pool-${i + 1}.json`);
      await writeFile(path, `${JSON.stringify(round, null, 2)}\n`, 'utf-8');
      console.log(`  [${i + 1}] ${qq} → ${candidates.length} 篇${data.captcha ? '（⚠ 验证码：本轮不完整）' : ''} → ${path}`);
    }
    console.log('');
    console.log('pool run 的 verdict 一律 pending（桥不做精选，只负责"见过哪些文章"）。');
    console.log(`打分：pnpm tsx scripts/eval-wechat-search.ts score --runs ${outDir}`);
    return;
  }

  if (via !== 'server') throw new Error(`--via 只支持 bridge / server，收到：${via}`);
  const baseUrl = (flag(args, 'base-url') ?? process.env.BOBWORK_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  console.log('⚠ 走服务端会：① 真实调用模型（计费）② 把这一轮落库进"小微"会话（会出现在聊天记录里）');
  if (dry) {
    console.log(`[dry-run] GET ${baseUrl}/api/butler/wechat-search?q=${q}`);
    console.log(`[dry-run] POST ${baseUrl}/api/butler/wechat-search/enrich`);
    return;
  }

  const searchRes = await fetch(`${baseUrl}/api/butler/wechat-search?q=${encodeURIComponent(q)}`);
  const search = (await searchRes.json().catch(() => ({}))) as {
    ok?: boolean;
    captcha?: boolean;
    results?: Array<{ title: string; url: string; account?: string; snippet?: string }>;
    intent?: string;
    queries?: string[];
    error?: string;
  };
  if (!search.ok) throw new Error(`检索失败（桥离线 / 非桌面端？）：${search.error ?? 'unknown'}`);
  const hits = (search.results ?? []).filter((h) => h.url && h.title);
  if (hits.length === 0) throw new Error('通道返回 0 篇：本轮没有可评测的候选');

  const frames: ThreadsFrames = { curated: [], readOk: new Map(), captcha: !!search.captcha };
  const enrichRes = await fetch(`${baseUrl}/api/butler/wechat-search/enrich`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q, hits, intent: search.intent ?? '', queries: search.queries ?? [] }),
  });
  if (enrichRes.ok && enrichRes.body) await consumeEnrich(enrichRes, frames);

  const keptIds = new Map(frames.curated.map((c, i) => [c.id, { rank: i, reason: c.reason }]));
  const candidates: EvalCandidate[] = hits.map((h, idx) => {
    const picked = keptIds.get(idx);
    const c: EvalCandidate = {
      id: idx,
      title: h.title,
      url: h.url,
      // 与落库账本同口径：curated 里的置 kept，其余一律 dropped
      verdict: picked ? 'kept' : 'dropped',
    };
    if (h.account) c.account = h.account;
    if (h.snippet) c.snippet = h.snippet;
    if (picked) {
      // 与落库账本同口径：rank = curated 帧里的位置（0 = 最相关）
      c.rank = picked.rank;
      if (picked.reason) c.reason = picked.reason;
    }
    if (frames.readOk.has(idx)) c.readOk = frames.readOk.get(idx);
    return c;
  });
  // curated 帧本身是有序的（模型按相关度排过）→ 重排 kept 到最前面，nDCG 才有意义
  candidates.sort((a, b) => {
    const ra = keptIds.get(a.id)?.rank ?? Number.MAX_SAFE_INTEGER;
    const rb = keptIds.get(b.id)?.rank ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });

  const round: EvalRound = {
    roundId: `server-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    query: q,
    intent: search.intent ?? null,
    planQueries: search.queries ?? null,
    candidates,
    ranked: true,
    source: 'capture-server',
    runAt: Date.now(),
    meta: { captcha: frames.captcha, error: frames.error ?? null, via: 'server', baseUrl },
  };
  const path = join(outDir, `${round.roundId}.json`);
  await writeFile(path, `${JSON.stringify(round, null, 2)}\n`, 'utf-8');
  console.log(`召回 ${candidates.length} · 留下 ${frames.curated.length}${frames.captcha ? ' · ⚠ 验证码' : ''}${frames.error ? ` · ⚠ ${frames.error}` : ''}`);
  console.log(`已写出：${path}`);
  console.log(`打分：pnpm tsx scripts/eval-wechat-search.ts score --runs ${outDir}`);
}

// ==================== 入口 ====================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case 'stats':
      await cmdStats(args);
      break;
    case 'export-labels':
      await cmdExportLabels(args);
      break;
    case 'score':
      await cmdScore(args);
      break;
    case 'directions':
      await cmdDirections(args);
      break;
    case 'capture':
      await cmdCapture(args);
      break;
    default:
      console.log('用法：pnpm tsx scripts/eval-wechat-search.ts <stats|export-labels|score|capture> [选项]');
      console.log('');
      console.log('  stats          [--thread <file>] [--json]');
      console.log('  export-labels  [--thread <file>] [--runs <dir>] [--round <id|关键词>] [--item <golden 条目 id>] [--out <file>] [--force]');
      console.log('  score          [--golden <file>] [--runs <dir>] [--thread <file>] [--no-thread] [--out <file|false>]');
      console.log('  directions     --runs <dir> [--grades <file>] [--budget <N>]   # 按检索方向归因');
      console.log('  capture        --query <原句> [--via bridge|server] [--also <检索方向>]... [--base-url <url>] [--out <dir>] [--dry-run]');
      process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
