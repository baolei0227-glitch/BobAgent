/**
 * Daily News —— 采集 + 归纳 + 缓存 + 降级（server-only）
 *
 * 管线（四段；两头复用、中间两段为本模块）：
 *   ① 采集：主题有策展新闻源（RSS）时优先 `searchNewsRss` 拉最新条目，无源 / 无结果则回退
 *      `searchLocalProviders`（web.ts 的多源降级搜索）；正文一律 `fetchReadableText` 抓取
 *   ② 归纳：把**抓到的正文**喂给任务模型，产出「今日看点」+ 每条的一句话总结 / why
 *      —— 禁止只拿 search snippet 脑补；标题 / 链接 / 来源一律由代码从检索结果带过来，
 *      模型只回 id + summary + why，**不产生 URL**（防幻觉链接）。
 *      **方案 A（2026-10-04）**：读者长期记忆（`butler/preferences.md`）只喂给这一步，用来在
 *      **既定主题范围内**挑更贴读者的条目并说明 why；**不参与检索** —— 候选集合仍完全由 topics
 *      决定。记忆为空 / 读失败即整段略去，prompt 与加记忆前逐字一致。故**记忆变化不触发当日
 *      重算**（当天那份仍由「缓存即标记 + Refresh now」决定，与改主题同口径）。
 *   ③ 缓存：落 `butler/.state/news/briefing-YYYY-MM-DD.json`；非 force 时当日已存在即直接读
 *   ④ 降级：模型不可用 / 超时 / 解析失败 → 退成纯链接列表并置 `summarized=false`（界面标注
 *      "Not summarized"），**绝不留半截空壳**。
 *
 * 「每日一次」由**当日缓存文件是否存在**判定（与 daily-tasks 的 digest 同口径）；
 * 改主题当天不重写，界面上的 Refresh now 走 force=true 强制重算。
 */
import { resolveTaskModel, type ResolvedModel } from '@/lib/core/task-model';
import { listPreferences } from '@/lib/core/preferences';
import { dateStamp } from '@/lib/butler/storage';
import { searchLocalProviders, fetchReadableText } from '@/app/api/chat/tools/web';
import { readNewsBriefing, readNewsConfig, writeNewsBriefing } from './store';
import { searchNewsRss } from './feed';
import {
  NEWS_ITEM_CAP,
  feedsForTopic,
  type NewsBriefing,
  type NewsItem,
  type NewsTopic,
} from './types';

/** 模型调用超时：新闻是后台每日任务，宁可用链接列表兜底也不要挂住 */
const MODEL_TIMEOUT_MS = 40_000;
/** 全局抓正文数量上限（每主题 limit 条，合计仍可能很多；抓取是外部网络，必须封顶） */
const MAX_FETCH_TOTAL = 14;
/** 抓正文并发度 */
const FETCH_CONCURRENCY = 4;
/** 单条喂给模型的正文摘录长度 */
const BODY_EXCERPT = 900;
/** 降级时 summary 用检索摘要的截断长度 */
const SNIPPET_EXCERPT = 160;
/** 喂给模型的读者记忆：条数上限 / 单条摘录长度（条数口径与 advice-ai 的 30 条一致） */
const MEMORY_MAX = 30;
const MEMORY_EXCERPT = 120;

/** 一个候选（检索结果 + 抓到的正文） */
interface Candidate {
  id: string;
  topicId: string;
  topicLabel: string;
  title: string;
  url: string;
  source: string;
  snippet: string;
  /** 抓到的正文；抓取失败 / 未抓为空串 */
  body: string;
}

/** 域名提取（无效 URL → 空串） */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 有界并发 map（保持结果顺序与入参一致） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 抓到的正文是否可用（fetchReadableText 失败返回 `Error: …`） */
function usableBody(text: string): string {
  if (!text || /^\s*Error:/i.test(text)) return '';
  // 去掉 `URL: …\n标题: …\n\n` 头部，只留正文
  const idx = text.indexOf('\n\n');
  return (idx >= 0 ? text.slice(idx + 2) : text).trim();
}

/** 单行截断（记忆摘录用；不引 advice-ai 的 snippet，避免跨模块拉入它的依赖） */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 读读者的长期记忆（`butler/preferences.md` 的结构化条目），格式化成 prompt 用的行。
 *
 * **方案 A 的边界**：这份记忆只影响「在既定主题范围内挑哪几条 + why 怎么说」，**不参与检索** ——
 * 候选集合完全由 topics 决定，模型无权据此新增条目。检索层保持显式可控、可解释。
 *
 * 读取失败（文件不存在 / 解析异常）一律当作「没有记忆」返回空数组：prompt 退回纯归纳形态，
 * 行为与加记忆前完全一致 —— 绝不让记忆读取连累整条简报生成。
 */
async function readMemoryLines(): Promise<string[]> {
  try {
    const memories = await listPreferences();
    return memories.slice(-MEMORY_MAX).map((m) => `- [${m.type}] ${clip(m.content, MEMORY_EXCERPT)}`);
  } catch {
    return [];
  }
}

/** 采集命中（RSS 命中与搜索命中的结构一致，可互换） */
type TopicHit = { title: string; url: string; snippet: string };

/**
 * 采集单个主题：优先走策展新闻源（RSS，`feedsForTopic` 决定有没有源），
 * 无源 / RSS 无结果时回退关键词搜索 —— 法律类主题没有可用 feed，就自然走这条回退。
 */
async function collectTopicHits(topic: NewsTopic): Promise<TopicHit[]> {
  const feeds = feedsForTopic(topic);
  if (feeds.length > 0) {
    const { hits } = await searchNewsRss(feeds, topic.limit);
    if (hits.length > 0) return hits;
  }
  const { hits } = await searchLocalProviders(topic.query, topic.limit);
  return hits;
}

/** 采集：每个主题取 topic.limit 条（RSS 优先 / 关键词回退），再抓正文（全局封顶 + 有界并发） */
async function collect(topics: NewsTopic[]): Promise<{ candidates: Candidate[]; failed: string[] }> {
  const failed: string[] = [];
  const perTopic = await Promise.all(
    topics.map(async (t) => {
      try {
        const hits = await collectTopicHits(t);
        if (hits.length === 0) {
          failed.push(t.label);
          return [] as Candidate[];
        }
        return hits.slice(0, t.limit).map((h, i) => ({
          id: `t${t.id}-${i}`,
          topicId: t.id,
          topicLabel: t.label,
          title: h.title || 'Untitled',
          url: h.url,
          source: hostOf(h.url),
          snippet: h.snippet || '',
          body: '',
        }));
      } catch {
        failed.push(t.label);
        return [] as Candidate[];
      }
    }),
  );

  // 展平后按顺序抓正文，全局封顶 MAX_FETCH_TOTAL —— 封顶之外的候选保持无正文（只会进降级链路）
  const flat = perTopic.flat();
  const toFetch = flat.slice(0, MAX_FETCH_TOTAL);
  await mapLimit(toFetch, FETCH_CONCURRENCY, async (c) => {
    try {
      c.body = usableBody(await fetchReadableText(c.url));
    } catch {
      c.body = '';
    }
  });

  return { candidates: flat, failed };
}

/**
 * 归纳提示词：只给编号 + 标题 + 正文摘录；模型回 id + summary + why，不回 URL（防幻觉链接）。
 *
 * `memoryLines` 是读者长期记忆（**方案 A**）—— 它只落在「挑选」与「why 的说法」两处，
 * **不参与检索**：候选集合由 topics 决定，prompt 里明确禁止据此新增条目或编造 id。
 * 记忆为空（读取失败 / 用户没写过）时整段略去，prompt 与加记忆前逐字一致。
 */
function buildPrompt(candidates: Candidate[], lang: 'zh' | 'en', memoryLines: string[]): string {
  const blocks = candidates.map((c) => {
    const body = c.body.slice(0, BODY_EXCERPT) || c.snippet.slice(0, SNIPPET_EXCERPT);
    return `[${c.id}] ${c.title}（${c.source}）\n${body}`;
  });
  const langWord = lang === 'zh' ? '中文' : 'English';
  const memorySection = memoryLines.length
    ? `
读者长期关注点（**仅供挑选与措辞参考，不是候选来源**）：
${memoryLines.join('\n')}

在**候选范围内**优先挑与上述关注点相关的条目，并在 "why" 里说明为什么这位读者值得看 ——
可自然呼应其关注领域，但不要复述记忆原文、不要写出具体隐私措辞。
候选集合是**固定**的：不得因此新增条目或编造 id。
`
    : '';
  return `以下是从各主题搜索并抓取到的新闻正文摘录，请为每一条给出可读的归纳，并写一段总述。
请用${langWord}输出。
${memorySection}
要求：
1. 先写 "overview"：2–3 句话的「今日看点」总述，跨条目给出整体判断（趋势 / 值得注意的事），像简报开场那样；不要复述单条内容。
2. 再写 "items"：从下面的候选中挑出最值得看的至多 ${NEWS_ITEM_CAP} 条，每条给出：
   - "id"：候选的编号（方括号里的那个，必须原样返回，不要编造）；
   - "summary"：一句话总结该条（基于给出的正文，不要脑补正文里没有的事实）；
   - "why"：一句话说明为什么值得看 / 对读者意味着什么。
3. 只依据给出的正文摘录归纳；信息不足的候选就跳过，不要硬凑。
4. **只输出 JSON**，不要代码块围栏、不要额外说明，格式：
{"overview":"…","items":[{"id":"t…-0","summary":"…","why":"…"}]}

--- 候选开始 ---
${blocks.join('\n\n')}
--- 候选结束 ---`;
}

/** 调任务模型做一次 JSON 归纳；失败抛出，由调用方降级 */
async function summarizeWithModel(cfg: ResolvedModel, prompt: string): Promise<string> {
  const endpoint = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: '你是新闻简报编辑，为一位有明确长期关注点的读者工作，擅长把零散的新闻正文归纳成简洁、克制、有判断的要点。' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content || '';
  return content.replace(/^```(?:json|markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
}

interface ModelResult {
  overview: string;
  items: { id: string; summary: string; why: string }[];
}

/** 从模型输出里抠出 JSON 对象（容忍前后多余文字） */
function parseModelResult(text: string): ModelResult | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items: ModelResult['items'] = [];
    for (const it of rawItems) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      if (!id) continue;
      items.push({
        id,
        summary: typeof o.summary === 'string' ? o.summary.trim() : '',
        why: typeof o.why === 'string' ? o.why.trim() : '',
      });
    }
    if (!overview && items.length === 0) return null;
    return { overview, items };
  } catch {
    return null;
  }
}

/** 降级：候选 → 纯链接条目（summary 用检索摘要片段，why 为空） */
function fallbackItems(candidates: Candidate[]): NewsItem[] {
  return candidates.slice(0, NEWS_ITEM_CAP).map((c) => ({
    id: c.id,
    topicId: c.topicId,
    topicLabel: c.topicLabel,
    title: c.title,
    summary: c.snippet.slice(0, SNIPPET_EXCERPT),
    why: '',
    source: c.source,
    url: c.url,
  }));
}

/** 归一化：把模型挑出的 id 映射回真实候选（标题 / 链接 / 来源以代码为准），封顶 NEWS_ITEM_CAP */
function mapModelItems(result: ModelResult, byId: Map<string, Candidate>): NewsItem[] {
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const it of result.items) {
    if (items.length >= NEWS_ITEM_CAP) break;
    const c = byId.get(it.id);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    items.push({
      id: c.id,
      topicId: c.topicId,
      topicLabel: c.topicLabel,
      title: c.title,
      summary: it.summary,
      why: it.why,
      source: c.source,
      url: c.url,
    });
  }
  return items;
}

/**
 * 生成（或读取）当日新闻简报。
 *
 * @param opts.force false=每日一次（当日缓存命中即直接返回）；true=界面 Refresh now，强制重算
 */
export async function generateNewsBriefing(opts?: { force?: boolean }): Promise<NewsBriefing> {
  const force = opts?.force === true;
  const date = dateStamp(new Date());

  if (!force) {
    const cached = await readNewsBriefing(date);
    if (cached) return cached;
  }

  const cfg = await readNewsConfig();
  const topics = cfg.topics;
  const { candidates, failed } = await collect(topics);

  // 采集全空：也落一份缓存（避免同日反复打外部网络），界面显示空态
  if (candidates.length === 0) {
    const empty: NewsBriefing = {
      date,
      generatedAt: new Date().toISOString(),
      overview: '',
      items: [],
      summarized: false,
      degradedTopics: failed,
    };
    await writeNewsBriefing(empty);
    return empty;
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const withBody = candidates.filter((c) => c.body);
  const lang: 'zh' | 'en' = topics.some((t) => t.lang === 'zh') ? 'zh' : 'en';

  let briefing: NewsBriefing;
  let result: ModelResult | null = null;
  // 只有「有正文」的候选才配得上归纳；一条正文都没抓到 → 直接降级
  if (withBody.length > 0) {
    try {
      const model = await resolveTaskModel();
      if (model) {
        // 读者记忆只在归纳这一步进场（方案 A）：读不到就是空数组，prompt 退回纯归纳形态
        const memoryLines = await readMemoryLines();
        result = parseModelResult(await summarizeWithModel(model, buildPrompt(withBody, lang, memoryLines)));
      }
    } catch (e) {
      console.warn('[news] 归纳失败，改用链接列表兜底:', e);
    }
  }

  const summarizedItems = result ? mapModelItems(result, byId) : [];
  if (result && summarizedItems.length > 0) {
    briefing = {
      date,
      generatedAt: new Date().toISOString(),
      overview: result.overview,
      items: summarizedItems,
      summarized: true,
      degradedTopics: failed,
    };
  } else {
    // 降级：纯链接列表 + 明确标注（绝不半截空壳）
    briefing = {
      date,
      generatedAt: new Date().toISOString(),
      overview: '',
      items: fallbackItems(candidates),
      summarized: false,
      degradedTopics: failed,
    };
  }

  await writeNewsBriefing(briefing);
  return briefing;
}
