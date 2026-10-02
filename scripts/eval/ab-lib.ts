/**
 * 检索 A/B 实验的公共部分（pool / 暂定标注 / LLM 精选），供各实验脚本复用。
 *
 * ⚠ 这里的 grade 是 **AI 按标题+摘要代打的暂定标注**，只用于**臂与臂之间的相对比较**；
 * 绝对数字必须等 `scripts/eval/golden.wechat-search.json` 的人工 grade 填完才作数。
 * 放在 `.eval/`（gitignored）而不是要提交的 golden 文件里 —— 它不能被当成 ground truth。
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { readdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { resolveAppRoot } from '../../src/lib/app-root';
import {
  poolCandidates,
  roundFromTrace,
  type EvalCandidate,
  type EvalGoldenItem,
  type EvalGoldenSet,
  type EvalRound,
} from '../../src/lib/butler/search-eval';
import { resolveModelConfig } from '../../src/lib/ai/resolve-model-config';
import type { WechatSearchTrace } from '../../src/lib/bus';

export const EVAL_DIR = resolve(__dirname, '..', '..', '.eval');
export const RUNS_DIR = join(EVAL_DIR, 'runs');
export const THREAD = join(resolveAppRoot(), 'butler', '.state', 'threads', 'butler-search.json');
/** 暂定标注（自动写出，便于人工核对我的每一票） */
export const PROVISIONAL_GOLDEN = join(EVAL_DIR, 'golden.PROVISIONAL.json');

/**
 * 暂定等级，按 pool 里的候选下标（0-based，"生产那轮优先"的标题去重顺序）。
 * 判据：3 = 直接回答查询的某个侧面且属一手/权威/深度；2 = 切题；1 = 同域但答别的；0 = 无关。
 * 查询的四个侧面：① 衍生诉讼费由谁垫付/预交 ② 缓交（官方文件）③ 劣后债权 ④ 债权人会议决议与垫付
 */
export const PROVISIONAL_GRADES: number[] = [
  3, 3, 1, 2, 1, 1, 2, 2, 2, 1, 1, 3, 3, 3, 1, 3, 1, 3, 1, 3, 2, 3, 2, 1, 2, 3, 1, 2, 3, 3, 2, 2, 2, 1, 3, 2, 2, 2, 2, 2,
  2, 1, 1, 1, 0, 2, 1, 1, 1, 2, 1,
];

/** 生产那一轮（落库账本） */
export async function loadBaselineRound(): Promise<EvalRound> {
  const parsed = JSON.parse(await readFile(THREAD, 'utf-8')) as {
    messages?: Array<{ searchTrace?: WechatSearchTrace }>;
  };
  const withTrace = (parsed.messages ?? []).filter(
    (m): m is { searchTrace: WechatSearchTrace } => !!m.searchTrace?.items?.length,
  );
  if (withTrace.length === 0) throw new Error('线程里没有落库账本');
  return roundFromTrace('stored-0', withTrace[0].searchTrace);
}

/** capture 出来的 pool run（`.eval/runs/*.json`） */
export async function loadPoolRounds(): Promise<EvalRound[]> {
  if (!existsSync(RUNS_DIR)) return [];
  const names = (await readdir(RUNS_DIR)).filter((n) => n.endsWith('.json')).sort();
  const out: EvalRound[] = [];
  for (const n of names) out.push(JSON.parse(await readFile(join(RUNS_DIR, n), 'utf-8')) as EvalRound);
  return out;
}

/**
 * 从**任意** runs 目录装配 pool（供"换一个查询再验一遍"用）。
 * q1 那条用的是落库账本 + `.eval/runs`；这里不依赖线程文件。
 */
export async function loadPoolFromDir(runsDir: string): Promise<EvalCandidate[]> {
  if (!existsSync(runsDir)) throw new Error(`找不到 runs 目录：${runsDir}`);
  const names = (await readdir(runsDir)).filter((n) => n.endsWith('.json')).sort();
  const rounds: EvalRound[] = [];
  for (const n of names) rounds.push(JSON.parse(await readFile(join(runsDir, n), 'utf-8')) as EvalRound);
  return poolCandidates(rounds);
}

/** 由「pool + 一份 grade 数组」构造 golden（grade 文件由人/AI 先写好，任何精选臂都跑在它之后） */
export function buildGolden(query: string, pool: EvalCandidate[], grades: number[], id = 'q'): EvalGoldenSet {
  if (pool.length !== grades.length) {
    throw new Error(`grade 条数 ${grades.length} 与 pool ${pool.length} 篇不一致 —— pool 变了，需要重新核对`);
  }
  return {
    version: 1,
    description: '【暂定标注·非 ground truth】AI 按标题+摘要代打，仅用于 A/B 的相对比较。',
    items: [
      {
        id,
        query,
        note: '【暂定标注】先定标注、后跑实验；仅供臂间对比',
        labels: pool.map((c, i) => ({
          value: c.title.trim().slice(0, 40),
          grade: grades[i],
          ...(grades[i] >= 2 ? { asserted: true } : {}),
        })),
      },
    ],
  };
}

/** 某批候选里相关（≥2）的篇数（按标题在 pool 里查） */
export function relevantIn(pool: EvalCandidate[], grades: number[], cands: EvalCandidate[]): number {
  return cands.filter((c) => {
    const i = pool.findIndex((x) => x.title === c.title);
    return i !== -1 && grades[i] >= 2;
  }).length;
}

/** 该批候选里 grade=3 的篇数 */
export function mustIn(pool: EvalCandidate[], grades: number[], cands: EvalCandidate[]): number {
  return cands.filter((c) => {
    const i = pool.findIndex((x) => x.title === c.title);
    return i !== -1 && grades[i] === 3;
  }).length;
}

export interface Fixtures {
  baseline: EvalRound;
  /** pool：capture runs + 生产那一轮，按标题去重 */
  pool: EvalCandidate[];
  golden: EvalGoldenSet;
}

/** 装配实验所需的一切，并把暂定标注写盘（供人工核对） */
export async function loadFixtures(): Promise<Fixtures> {
  const baseline = await loadBaselineRound();
  const pool = poolCandidates([...(await loadPoolRounds()), baseline]);
  if (pool.length !== PROVISIONAL_GRADES.length) {
    throw new Error(
      `暂定标注 ${PROVISIONAL_GRADES.length} 条与 pool ${pool.length} 篇不一致 —— pool 变了，需要重新核对每一票`,
    );
  }
  const item: EvalGoldenItem = {
    id: 'bankruptcy-fee-advance',
    query: baseline.query,
    note: '【暂定标注】AI 按标题+摘要代打，仅供臂间对比，不是 ground truth',
    labels: pool.map((c, i) => ({
      value: c.title.trim().slice(0, 40),
      grade: PROVISIONAL_GRADES[i],
      // 所有相关文章都标 asserted：它们都由通道真实返回过（确实存在），且理应被搜到
      ...(PROVISIONAL_GRADES[i] >= 2 ? { asserted: true } : {}),
    })),
  };
  const golden: EvalGoldenSet = {
    version: 1,
    description: '【暂定标注·非 ground truth】AI 按标题+摘要代打，仅用于 A/B 的相对比较。',
    items: [item],
  };
  await writeFile(PROVISIONAL_GOLDEN, `${JSON.stringify(golden, null, 2)}\n`, 'utf-8');
  return { baseline, pool, golden };
}

/** 某篇候选的暂定等级（按标题查） */
export function gradeOf(pool: EvalCandidate[], title: string): number | null {
  const i = pool.findIndex((c) => c.title === title);
  return i === -1 ? null : PROVISIONAL_GRADES[i];
}

/** 一批候选里相关（≥2）的篇数 */
export function relevantCount(pool: EvalCandidate[], cands: EvalCandidate[]): number {
  return cands.filter((c) => (gradeOf(pool, c.title) ?? 0) >= 2).length;
}

/**
 * ⚠ 这份 prompt 是 `app/api/butler/wechat-search/enrich/route.ts` 里 `CURATE_SYSTEM` 的**副本**
 * （那边是模块私有常量）。实验要的是"用生产同一套判据"，所以刻意逐字复制；
 * 一旦那边改了判据，这里必须跟着改，否则 A/B 比的就不是同一件事。
 */
export type CurateVariant = 'current' | 'authority';

/** 变体 `authority`：额外要求优先一手来源 —— 用来测"精选的口味能不能被 prompt 校准" */
const AUTHORITY_CLAUSE = `
补充要求（一手优先）：在这 3 篇里，**只要候选里存在**「法院/政府部门发布的原文或规范性文件（通知、办法、纪要）」
「最高人民法院或人民法院报等权威解读」「对法条本身的梳理」，就必须优先选它们，
而不是选律师/公众号的实务随笔或二手解读；同一主题有一手与二手时，选一手。
入选理由里请点明它属于哪一类（一手文件 / 权威解读 / 法条梳理 / 实务经验）。`;

export function curateSystem(variant: CurateVariant = 'current'): string {
  const base = `你是微信公众号文章的检索精选助手。用户给出一个检索关键词和一组候选文章（含序号、标题、摘要、公众号）。
请从中精选最多 3 篇：优先「与关键词高度相关」「信息量或权威性高（知名公众号、原创、深度分析）」「时效较新」的文章。
明显无关、软文广告、标题党、纯营销导流一律不选；宁可少选，也不要凑数。`;
  const tail = `
只返回严格 JSON，不要 markdown：
{"picks":[{"index":0,"reason":"一句话说明入选理由"}]}
index 为候选文章序号（从 0 开始）。按相关度从高到低排序。`;
  return base + (variant === 'authority' ? AUTHORITY_CLAUSE : '') + tail;
}

/** 用生产同款 prompt + 应用默认 chat 模型做一次精选，返回按相关度降序的 index */
export async function llmCurate(
  query: string,
  cands: EvalCandidate[],
  variant: CurateVariant = 'current',
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
      { role: 'system', content: curateSystem(variant) },
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

/** 精选结果 → 评测用的一轮（kept = picks，带 rank） */
export function armFromPicks(roundId: string, query: string, cands: EvalCandidate[], picks: Array<{ index: number }>): EvalRound {
  return {
    roundId,
    query,
    candidates: cands.map((c, i) => {
      const rank = picks.findIndex((p) => p.index === i);
      const kept = rank !== -1;
      return { ...c, verdict: kept ? 'kept' : 'dropped', ...(kept ? { rank } : {}) };
    }),
    ranked: true,
    source: 'capture-server',
  };
}

/** 带缓存的 LLM 精选（同一批候选只调一次；`--refresh` 强制重调） */
export async function llmCurateCached(
  label: string,
  query: string,
  cands: EvalCandidate[],
  variant: CurateVariant = 'current',
): Promise<Array<{ index: number; reason: string }>> {
  const file = join(EVAL_DIR, `llm-picks-${label}.json`);
  const cached = existsSync(file) && !process.argv.includes('--refresh')
    ? (JSON.parse(await readFile(file, 'utf-8')) as {
        query: string;
        docCount: number;
        picks: Array<{ index: number; reason: string }>;
      })
    : null;
  if (cached && cached.query === query && cached.docCount === cands.length) {
    console.log(`精选（${label}）：用缓存，跳过调用`);
    return cached.picks;
  }
  const picks = await llmCurate(query, cands, variant);
  await writeFile(file, `${JSON.stringify({ query, docCount: cands.length, picks }, null, 2)}\n`, 'utf-8');
  return picks;
}

export function fmtRatio(r: { num: number; den: number; value: number } | null): string {
  return r ? `${(r.value * 100).toFixed(1)}%（${r.num}/${r.den}）` : 'N/A';
}
