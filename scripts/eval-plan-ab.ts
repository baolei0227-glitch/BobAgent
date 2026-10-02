/**
 * 规划器 prompt 的离线 A/B：**能不能让规划器产出"文书名/发布机关"型方向？**
 *
 * 由来（q3 实测）：真实生产链路召回的 12 篇里 **0 篇一手/权威来源**，而同一 pool 里 9 篇必找文章中
 * 有 **7 篇来自同一个"文书名型"方向**（`最高人民法院 夫妻债务纠纷 解释`）。
 * 规划器把问题改写成主题词 → 只能捞到主题词的公众号普法文 → 一手来源结构性缺失。
 *
 * 本脚本用**完全相同的下游**（搜狗扇出 + 轮转合并 + 12 篇预算）比两种规划 prompt：
 *   base  = 生产现状（逐字副本）
 *   doc   = 现状 + 一条硬规则：至少有一个方向按发布机关/文书名组织
 * 数的是同一件事：**这 12 篇里有多少"必找"（一手/权威）**，用 `.eval/grades-q3-map.json` 判定。
 *
 * ⚠ 副本漂移：`PLAN_SYSTEM` 是 route.ts 里的逐字副本；那边改了这里必须跟着改，否则比的不是同一件事。
 * ⚠ 搜狗结果随时间波动：所以两种 plan 各跑 `--rounds` 轮，看差距是否稳定。
 *
 * 用法：pnpm tsx scripts/eval-plan-ab.ts [--rounds 2] [--query "<换一个问题>"]
 */
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { resolveAppRoot } from '../src/lib/app-root';
import { resolveModelConfig } from '../src/lib/ai/resolve-model-config';
import { mergeUniqueByTitle } from '../src/lib/butler/wechat-dedupe';

const BRIDGE = join(resolveAppRoot(), '.runtime', 'hippo-bridge.json');
const GRADE_MAP = resolve(__dirname, '..', '.eval', 'grades-q3-map.json');
const MERGE_CAP = 12;
const DEFAULT_QUERY = '夫妻一方以个人名义对外借款，出借人能否要求另一方共同偿还？举证责任如何分配？';

/** 生产 PLAN_SYSTEM 的逐字副本（`app/api/butler/wechat-search/route.ts`） */
const PLAN_SYSTEM = `你是检索词规划助手，服务于「搜狗微信」公众号文章检索。用户会给出一个检索输入，可能是自然语言问题，也可能是关键词。
请把它规划成 1–3 个最适合搜狗微信的关键词检索串：
- 若输入是完整问题：先拆成若干子问题（最多 3 个，覆盖问题的主要侧面、避免重复），再把每个子问题改写成 2–8 个词的关键词串——去掉「怎么/为什么/有哪些/区别」等疑问词与连词，保留核心实体与概念；
- 若输入已是较好的关键词：微调或保持，不必硬拆；
- 关键词串要像真人会搜的那样简短自然，不要整句，不要堆砌标点；
- 不同检索串之间尽量互补而非重复。
只返回严格 JSON，不要 markdown：
{"isQuestion":true,"intent":"一句话概括用户真实意图","queries":["关键词串1","关键词串2"]}`;

/** 变体：额外要求至少一个"文书名/发布机关"型方向 */
const PLAN_SYSTEM_DOC = `${PLAN_SYSTEM.split('只返回严格 JSON')[0]}
补充要求（**必须含一个"文书名/发布机关"型方向**）：在 1–3 个方向里，至少有一个要按**发布机关或文书名**组织，
用来找权威一手文件，例如「最高人民法院 夫妻债务纠纷 解释」「上海高院 竞业限制 解答」「人社部 竞业限制 通知」；
这类方向带上机关名 + 文书体裁（解释/规定/通知/纪要/解答/批复），不要带疑问词。
其余方向再按主题词组织，两者互补。
只返回严格 JSON，不要 markdown：
{"isQuestion":true,"intent":"一句话概括用户真实意图","queries":["关键词串1","关键词串2"]}`;

/** 变体二：要求规划器**写出文书的正式名称**（不是"XX 司法解释"这种泛称） */
const PLAN_SYSTEM_DOCNAME = `${PLAN_SYSTEM.split('只返回严格 JSON')[0]}
补充要求（**必须按核心法律文书的正式名称检索**）：在 1–3 个方向里，至少有一个要写出与该问题直接相关的
**司法解释 / 部门规章 / 地方高院解答的正式名称**（名称主干即可），用它去搜，例如
「最高人民法院 关于审理涉及夫妻债务纠纷案件适用法律有关问题的解释」。
**不要**写「XX 司法解释」「XX 规定」这类泛称——泛称搜回来的都是律师解读，只有文书名称本身才能捞到原文。
其余方向再按主题词组织。
只返回严格 JSON，不要 markdown：
{"isQuestion":true,"intent":"一句话概括用户真实意图","queries":["关键词串1","关键词串2"]}`;

/** 变体三：**生产当前源码里的原文**（从 route.ts 自动抽取，验证"线上到底生效没有"） */
const PLAN_SYSTEM_PROD = `你是检索词规划助手，服务于「搜狗微信」公众号文章检索。用户会给出一个检索输入，可能是自然语言问题，也可能是关键词。
请把它规划成 1–3 个最适合搜狗微信的关键词检索串：
- 若输入是完整问题：先拆成若干子问题（最多 3 个，覆盖问题的主要侧面、避免重复），再把每个子问题改写成 2–8 个词的关键词串——去掉「怎么/为什么/有哪些/区别」等疑问词与连词，保留核心实体与概念；
- 若输入已是较好的关键词：微调或保持，不必硬拆；
- 关键词串要像真人会搜的那样简短自然，不要整句，不要堆砌标点；
- 不同检索串之间尽量互补而非重复。
- **至少留一个方向按「核心法律文书的正式名称」来搜**（2026-10-01 实测新增）：写出与该问题直接相关的
  司法解释 / 部门规章 / 地方高院解答的**正式名称**（名称主干即可，如
  「最高人民法院 关于审理涉及夫妻债务纠纷案件适用法律有关问题的解释」）。
  为什么必须这样：按主题词搜只能搜到律师/公众号的解读，**权威原文只有按文书名称才捞得到**；
  实测同一问题「主题词方向」12 篇里 0 篇一手来源，「文书名方向」能直接带回 2–3 篇。
  注意：不要用「XX 司法解释」这类泛称（泛称搜回来仍是解读），也**不要编造不存在的文书名** ——
  若确实想不起具体名称，就把这个方向退回主题词，宁可少一个方向也不要瞎编。
只返回严格 JSON，不要 markdown：
{"isQuestion":true,"intent":"一句话概括用户真实意图","queries":["关键词串1","关键词串2"]}`;

interface Hit {
  title: string;
  url: string;
  account?: string;
  snippet?: string;
}

async function chatJson(system: string, user: string): Promise<{ queries?: string[]; intent?: string } | null> {
  const cfg = await resolveModelConfig({});
  if (!cfg) throw new Error('没有可用的 chat 模型配置');
  const payload: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
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
  if (!res.ok) throw new Error(`规划调用失败 (HTTP ${res.status})`);
  const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const c = d.choices?.[0]?.message?.content ?? '';
  const s = c.indexOf('{');
  const e = c.lastIndexOf('}');
  try {
    return JSON.parse(s !== -1 && e > s ? c.slice(s, e + 1) : c) as { queries?: string[]; intent?: string };
  } catch {
    return null;
  }
}

/** 与生产同口径的扇出：每方向 perQuery 条，顺序调用，然后轮转合并 + 上限卡唯一 */
async function fanOutAndMerge(queries: string[]): Promise<Hit[]> {
  const bridge = JSON.parse(readFileSync(BRIDGE, 'utf-8')) as { url?: string; token?: string };
  if (!bridge.url) throw new Error('桥文件缺 url（Hippo 浏览器没开？）');
  const base = bridge.url.replace(/\/+$/, '');
  const perQuery = Math.min(10, Math.max(6, Math.ceil(MERGE_CAP / Math.max(1, queries.length)) + 2));
  const groups: Hit[][] = [];
  for (const q of queries) {
    try {
      const res = await fetch(`${base}/wechat-mp?token=${encodeURIComponent(bridge.token ?? '')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, maxResults: perQuery }),
        signal: AbortSignal.timeout(60000),
      });
      const data = (await res.json().catch(() => ({}))) as { results?: Hit[] };
      groups.push((data.results ?? []).filter((h) => h.url && h.title));
    } catch {
      groups.push([]); // 单方向失败不拖垮整轮
    }
  }
  return mergeUniqueByTitle(groups, MERGE_CAP).merged;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const rounds = Math.max(1, Number(arg('rounds')) || 2);
  const query = arg('query') ?? DEFAULT_QUERY;
  if (!existsSync(GRADE_MAP)) throw new Error(`找不到 grade 表：${GRADE_MAP}`);
  const map = JSON.parse(readFileSync(GRADE_MAP, 'utf-8')) as { gradesByTitle: Record<string, number> };
  const keys = Object.keys(map.gradesByTitle).sort((a, b) => b.length - a.length);
  const gradeOf = (title: string): number => {
    for (const k of keys) if (title.includes(k)) return map.gradesByTitle[k];
    return -1; // 未在标注表里（本轮新捞到的文章）→ 不计入，但单独报数
  };

  console.log(`问题：${query.slice(0, 52)}…`);
  console.log(`轮数：${rounds}（搜狗结果随时间波动，两轮看稳定性）\n`);

  const variants = [
    ['base（现状）', PLAN_SYSTEM],
    ['doc（含文书名方向）', PLAN_SYSTEM_DOC],
    ['docname（按文书正式名称）', PLAN_SYSTEM_DOCNAME],
    ['PROD（生产源码原文）', PLAN_SYSTEM_PROD],
  ] as const;
  for (const [tag, system] of variants) {
    console.log(`── ${tag} ──`);
    for (let r = 1; r <= rounds; r += 1) {
      const plan = await chatJson(system, `检索输入：${query}`);
      const queries = (plan?.queries ?? []).map((s) => (s || '').trim()).filter(Boolean).slice(0, 3);
      if (queries.length === 0) {
        console.log(`  第 ${r} 轮：规划失败`);
        continue;
      }
      const merged = await fanOutAndMerge(queries);
      const grades = merged.map((h) => gradeOf(h.title));
      const must = grades.filter((g) => g === 3).length;
      const rel = grades.filter((g) => g >= 2).length;
      const unknown = grades.filter((g) => g === -1).length;
      console.log(`  第 ${r} 轮：方向 = ${queries.join(' / ')}`);
      console.log(
        `         → ${merged.length} 篇 · 相关 ${rel} · **必找 ${must}**${unknown ? ` · 未标注 ${unknown}` : ''}`,
      );
      for (const [i, h] of merged.entries()) {
        if (grades[i] === 3) console.log(`         ★ ${h.title.slice(0, 46)}`);
        else if (grades[i] === -1) console.log(`         ? ${h.title.slice(0, 46)}（未标注）`);
      }
    }
    console.log('');
  }
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
