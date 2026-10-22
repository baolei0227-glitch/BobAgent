/**
 * Hippo AI Search —— Perplexity 式「检索 + 合成作答」专用 SSE 路由。
 *
 * 与 /api/chat 的 agent 工具循环刻意分开：一次请求内完成
 *   拆题（1-3 个检索词）→ 首轮搜索/抓正文 → 证据缺口检查 → 必要时补搜一轮
 *   → 段落级重排 → 带编号来源流式作答
 * 延迟与成本可预期，引用结构稳定（来源由服务端下发，模型无权生成 URL）。
 *
 * 事件序列：
 *   status  { phase: 'searching' | 'reading' | 'writing' }
 *   sources { sources: ClientSource[] }        // 来源变化即下发，前端整体替换
 *   delta   { text }                           // 正文增量
 *   audit   { invalid: number[] }              // 引用编号越界（可选事件）
 *   done    { ok: true, model }                // 正常结束
 *   error   { message }                        // 任何阶段失败（终止）
 */
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { resolveModelConfig, type ModelRefRequest } from '@/lib/ai/resolve-model-config';
import { modelOutputTokenMaxForModel } from '@/lib/context-limits';
import { webService } from '@/lib/web';
import { httpFetchProvider } from '@/lib/web/providers/http-fetch';
import { WebError, type WebSearchSource } from '@/lib/web/types';

export const runtime = 'nodejs';

/** 每个检索词取回的候选条数（多取一些，再按需抓正文） */
const SEARCH_COUNT = 8;
/** 首轮抓正文的来源数 */
const FIRST_ROUND_SOURCES = 6;
/** 补搜后最多保留的来源数 */
const MAX_SOURCES = 8;
/** 同一站点最多保留的来源数（避免同文多语言/同站刷屏） */
const MAX_PER_DOMAIN = 2;
/** 合并去重后的候选来源上限 */
const MAX_CANDIDATES = 18;
/** 拆题后首轮最多执行的检索词数量 */
const MAX_QUERIES = 3;
/** 补搜最多追加的检索词数量 */
const MAX_FOLLOWUP_QUERIES = 2;
/** 携带的历史轮数上限（多轮追问时只带最近几轮，避免上下文膨胀） */
const MAX_HISTORY = 4;
/** 整次请求上限：拆题 + 两轮检索/抓取 + 重排 + 生成 */
const TIMEOUT_MS = 240_000;

/** 单条来源参与切块的正文上限（超长页面只取前段） */
const DOC_CHARS = 24_000;
/** 单条来源最多切出的段落数 */
const CHUNKS_PER_DOC = 24;
/** 段落目标长度与重叠 */
const PASSAGE_CHARS = 900;
const PASSAGE_OVERLAP = 120;
/** 送入重排的候选段落数 */
const PREFILTER_PASSAGES = 24;
/** 最终送入答案模型的段落数 */
const MAX_PASSAGES = 10;
/** 单一来源最多入选段落数（保证来源多样性） */
const MAX_PASSAGES_PER_DOC = 3;

interface SearchBody extends ModelRefRequest {
  query?: string;
  history?: Array<{ role?: string; content?: string }>;
}

interface ClientSource {
  index: number;
  title: string;
  url: string;
  siteName: string | null;
  snippet: string;
}

interface Doc {
  source: WebSearchSource;
  text: string;
  /** 正文抓取失败、退回搜索摘要时为 true */
  degraded: boolean;
}

interface Passage {
  /** docs 下标 */
  doc: number;
  text: string;
  score: number;
}

type SseController = ReadableStreamDefaultController<Uint8Array>;
const encoder = new TextEncoder();

function send(ctrl: SseController, event: string, data: unknown): void {
  ctrl.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

/** 追踪参数：去重时忽略，避免同一页面因渠道参数被当成多条来源 */
const TRACKING_PARAMS = /^(utm_|spm|ref|ref_src|source|from|share_|fbclid|gclid|yclid|mc_cid|mc_eid|igshid)/i;

/** URL 去重键：去掉追踪参数、hash、末尾斜杠与 www 前缀 */
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const search = u.searchParams.toString();
    return `${host}${path}${search ? `?${search}` : ''}`;
  } catch {
    return url;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 从模型输出里提取 JSON（容忍 ```json 包裹与前后说明文字） */
function parseJson(text: string): unknown {
  const raw = text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // 继续尝试截取
  }
  const objStart = raw.indexOf('{');
  const objEnd = raw.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    try {
      return JSON.parse(raw.slice(objStart, objEnd + 1));
    } catch {
      // 继续尝试数组
    }
  }
  const arrStart = raw.indexOf('[');
  const arrEnd = raw.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(raw.slice(arrStart, arrEnd + 1));
    } catch {
      // 放弃
    }
  }
  return null;
}

/** 清洗模型给出的检索词：去空、去重、限长，失败时退回原问题 */
function cleanQueries(value: unknown, fallback: string, max: number): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const q = item.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!q) continue;
      if (out.some((x) => x.toLowerCase() === q.toLowerCase())) continue;
      out.push(q);
      if (out.length >= max) break;
    }
  }
  return out.length > 0 ? out : [fallback];
}

/** 原始问题始终保留：即使拆题跑偏，也保证有一次精确检索 */
function withOriginal(queries: string[], original: string): string[] {
  const has = queries.some((q) => q.trim().toLowerCase() === original.trim().toLowerCase());
  return has ? queries.slice(0, MAX_QUERIES) : [original, ...queries].slice(0, MAX_QUERIES);
}

const PLANNER_SYSTEM = `You turn a user question into focused web search queries.
Return strict JSON only, with this shape: {"queries":["..."]}
Rules:
- 1-3 queries, each a short keyword-rich phrase (max ~12 words).
- Resolve pronouns and follow-up context from the conversation.
- For comparison questions, search each side separately.
- Never introduce entities (products, companies, people) that are not in the question.
- If the question asks for latest/news, include a recency word.
- Keep the user's language.
- Never answer the question.`;

/** 拆题：复杂问题拆成多个检索词；失败时退回原始问题 */
async function planQueries(
  client: OpenAI,
  model: string,
  query: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM },
          ...history.slice(-2).map((m) =>
            m.role === 'assistant'
              ? { role: 'assistant' as const, content: m.content.slice(0, 800) }
              : { role: 'user' as const, content: m.content.slice(0, 800) },
          ),
          { role: 'user', content: `Question: ${query}` },
        ],
      },
      { signal },
    );
    const parsed = parseJson(completion.choices?.[0]?.message?.content ?? '') as { queries?: unknown } | null;
    return cleanQueries(parsed?.queries, query, MAX_QUERIES);
  } catch {
    return [query];
  }
}

/**
 * 并行检索多个词，按规范化 URL 去重、按站点限额合并。
 * 单条检索失败不影响其他词。
 */
async function searchMany(queries: string[], signal: AbortSignal): Promise<WebSearchSource[]> {
  const batches = await Promise.all(
    queries.map((q) =>
      webService.search({ query: q, count: SEARCH_COUNT, signal }).catch(() => ({ sources: [] as WebSearchSource[] })),
    ),
  );
  const seen = new Set<string>();
  const perDomain = new Map<string, number>();
  const merged: WebSearchSource[] = [];
  for (const batch of batches) {
    for (const source of batch.sources) {
      if (!source.url) continue;
      const key = urlKey(source.url);
      if (seen.has(key)) continue;
      const domain = domainOf(source.url);
      const used = perDomain.get(domain) ?? 0;
      if (domain && used >= MAX_PER_DOMAIN) continue;
      seen.add(key);
      if (domain) perDomain.set(domain, used + 1);
      merged.push(source);
      if (merged.length >= MAX_CANDIDATES) return merged;
    }
  }
  return merged;
}

/** 单页抓取：DeepSeek Fetch → 本地 HTTP 抓取；都失败则退回搜索摘要 */
async function fetchText(url: string, signal: AbortSignal): Promise<{ text: string; degraded: boolean }> {
  try {
    const page = await webService.fetch({ url, signal });
    if (page.markdown.trim()) return { text: page.markdown, degraded: false };
  } catch {
    if (signal.aborted) return { text: '', degraded: true };
  }
  try {
    const page = await httpFetchProvider.fetch({ url, signal });
    if (page.markdown.trim()) return { text: page.markdown, degraded: false };
  } catch {
    // 退回摘要
  }
  return { text: '', degraded: true };
}

async function fetchDocs(sources: WebSearchSource[], signal: AbortSignal): Promise<Doc[]> {
  return Promise.all(
    sources.map(async (source) => {
      const { text, degraded } = await fetchText(source.url, signal);
      const fallback = source.content || source.summary || source.snippet || '';
      return {
        source,
        text: (text || fallback).slice(0, DOC_CHARS).trim(),
        degraded,
      };
    }),
  );
}

/** 按段落边界切块（优先空行/句号，带少量重叠，避免答案句被切断） */
function chunkDoc(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= PASSAGE_CHARS) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length && out.length < CHUNKS_PER_DOC) {
    let end = Math.min(clean.length, start + PASSAGE_CHARS);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('。'), window.lastIndexOf('. '));
      if (cut > PASSAGE_CHARS * 0.55) end = start + cut + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - PASSAGE_OVERLAP, start + 1);
  }
  return out;
}

/** 检索词拆成英文词 + 中文二元组，用于廉价的相关性预筛 */
function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  const lower = query.toLowerCase();
  for (const word of lower.match(/[a-z0-9][a-z0-9.+#_-]{1,}/g) ?? []) {
    if (word.length >= 2) terms.add(word);
  }
  for (const run of lower.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
    if (run.length < 2) continue;
    if (run.length <= 6) terms.add(run);
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms].slice(0, 48);
}

function lexicalScore(terms: string[], text: string, title: string): number {
  const hay = `${title}\n${text}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let hits = 0;
    let at = hay.indexOf(term);
    while (at !== -1 && hits < 4) {
      hits += 1;
      at = hay.indexOf(term, at + term.length);
    }
    if (hits > 0) score += hits * (term.length >= 4 ? 2 : 1);
  }
  return score / Math.sqrt(Math.max(1, hay.length / 600));
}

const FRESH_RE = /最新|今天|今日|本周|本月|最近|近期|目前|现在|latest|today|this week|this month|current|news|2026/i;

function recencyBoost(publishedAt: string | null): number {
  if (!publishedAt) return 0;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / 86_400_000;
  if (days < 0) return 2;
  if (days <= 30) return 12;
  if (days <= 180) return 6;
  if (days <= 365) return 2;
  return 0;
}

/** 切块 + 词面预筛：权威度和时效只影响排序，不改变证据内容 */
function rankPassages(docs: Doc[], terms: string[], query: string): Passage[] {
  const freshWeight = FRESH_RE.test(query) ? 1 : 0.25;
  const all: Passage[] = [];
  docs.forEach((doc, di) => {
    const authority = doc.source.authority > 0 ? doc.source.authority : 0;
    for (const text of chunkDoc(doc.text)) {
      all.push({
        doc: di,
        text,
        score:
          lexicalScore(terms, text, doc.source.title) +
          authority * 2 +
          recencyBoost(doc.source.publishedAt) * freshWeight,
      });
    }
  });
  return all.sort((a, b) => b.score - a.score).slice(0, PREFILTER_PASSAGES);
}

const RERANK_SYSTEM = `You rank web passages by how directly they help answer the question.
Return strict JSON only, with this shape: {"top":[1,2,3]}
Rules:
- Choose at most ${MAX_PASSAGES} passage ids, most useful first.
- Prefer concrete facts, numbers, dates, and direct comparisons.
- Ignore navigation, ads, cookie notices, and off-topic text.
- Only use ids that exist. Never answer the question.`;

/** 模型重排候选段落；失败时退回词面排序 */
async function rerankPassages(
  client: OpenAI,
  model: string,
  query: string,
  queries: string[],
  passages: Passage[],
  signal: AbortSignal,
): Promise<number[]> {
  const fallback = passages.slice(0, MAX_PASSAGES).map((_, i) => i);
  if (passages.length <= 3) return passages.map((_, i) => i);
  try {
    const list = passages
      .map((p, i) => `[${i + 1}] (source ${p.doc + 1}) ${p.text.replace(/\s+/g, ' ').slice(0, 420)}`)
      .join('\n');
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        max_tokens: 120,
        messages: [
          { role: 'system', content: RERANK_SYSTEM },
          { role: 'user', content: `Question: ${query}\nSearch queries: ${queries.join(' | ')}\n\nPassages:\n${list}` },
        ],
      },
      { signal },
    );
    const parsed = parseJson(completion.choices?.[0]?.message?.content ?? '') as { top?: unknown } | null;
    const ids = Array.isArray(parsed?.top)
      ? parsed.top.filter(
          (n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= passages.length,
        )
      : [];
    const unique = [...new Set(ids)].slice(0, MAX_PASSAGES).map((n) => n - 1);
    return unique.length > 0 ? unique : fallback;
  } catch {
    return fallback;
  }
}

/** 限制单条来源的入选段落数，不足时按预筛顺序补齐 */
function enforceDiversity(ids: number[], passages: Passage[]): number[] {
  const out: number[] = [];
  const perDoc = new Map<number, number>();
  const take = (id: number): boolean => {
    const doc = passages[id].doc;
    const used = perDoc.get(doc) ?? 0;
    if (used >= MAX_PASSAGES_PER_DOC) return false;
    perDoc.set(doc, used + 1);
    out.push(id);
    return true;
  };
  for (const id of ids) {
    if (out.length >= MAX_PASSAGES) break;
    if (!out.includes(id)) take(id);
  }
  for (let i = 0; i < passages.length && out.length < MAX_PASSAGES; i++) {
    if (!out.includes(i)) take(i);
  }
  return out;
}

/** 只保留有入选段落的来源，并重排编号 */
function compactDocs(docs: Doc[], selected: Passage[]): { docs: Doc[]; passages: Passage[] } {
  const used = [...new Set(selected.map((p) => p.doc))].sort((a, b) => a - b);
  const map = new Map(used.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  return {
    docs: used.map((i) => docs[i]),
    passages: selected.map((p) => ({ ...p, doc: map.get(p.doc) ?? 0 })),
  };
}

/** 来源序号在补搜/剪枝后会整体重排，正文引用 [n] 始终对应最终列表 */
function toClientSources(docs: Doc[]): ClientSource[] {
  return docs.map((d, i) => ({
    index: i + 1,
    title: d.source.title,
    url: d.source.url,
    siteName: d.source.siteName,
    snippet: d.source.snippet || d.source.summary || '',
  }));
}

const GAP_SYSTEM = `You judge whether the provided passages are enough to answer the question.
Return strict JSON only, with this shape: {"enough":true|false,"queries":["..."]}
Rules:
- enough=true only if the passages cover the key facts, including every side of a comparison.
- Otherwise enough=false and give 1-2 short search queries that fill the missing gaps.
- Keep the user's language. Never answer the question.`;

/** 证据缺口检查：喂入选段落，而不是搜索摘要 */
async function findGaps(
  client: OpenAI,
  model: string,
  query: string,
  passages: Passage[],
  signal: AbortSignal,
): Promise<{ enough: boolean; queries: string[] }> {
  try {
    const outline = passages
      .slice(0, 6)
      .map((p, i) => `[${i + 1}] ${p.text.replace(/\s+/g, ' ').slice(0, 380)}`)
      .join('\n');
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        max_tokens: 250,
        messages: [
          { role: 'system', content: GAP_SYSTEM },
          { role: 'user', content: `Question: ${query}\n\nPassages:\n${outline}` },
        ],
      },
      { signal },
    );
    const parsed = parseJson(completion.choices?.[0]?.message?.content ?? '') as
      | { enough?: unknown; queries?: unknown }
      | null;
    return {
      enough: parsed?.enough === true,
      queries: cleanQueries(parsed?.queries, query, MAX_FOLLOWUP_QUERIES),
    };
  } catch {
    // 缺口判断失败时不补搜，避免额外等待
    return { enough: true, queries: [] };
  }
}

function buildMessages(
  query: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  docs: Doc[],
  passages: Passage[],
) {
  const today = new Date().toISOString().slice(0, 10);
  const system = `You are Hippo Search, a research assistant that answers with evidence from live web results.

Rules:
1. Answer using ONLY the numbered sources provided. Every factual claim must carry an inline citation like [1] or [2][3].
2. Never invent URLs, titles, quotes, numbers, or sources. Do not add a "Sources" list at the end — the UI renders it.
3. If the sources do not answer the question, say so plainly and state what is missing.
4. If sources conflict, point out the disagreement instead of silently picking one.
5. Write in the same language as the user's question.
6. Lead with a direct answer in 1–2 sentences, then supporting detail. Use short paragraphs, headings, and bullet lists where they help. Stay concise.
7. Today's date is ${today}; prefer recent information and mention dates when they matter.
8. Each source contains selected excerpts, not the full page. Do not assume facts that are absent from the excerpts.`;

  const byDoc = new Map<number, string[]>();
  for (const p of passages) {
    const list = byDoc.get(p.doc) ?? [];
    list.push(p.text);
    byDoc.set(p.doc, list);
  }

  const sourceBlock = docs
    .map(({ source }, i) => {
      const meta = [
        source.siteName ? `Site: ${source.siteName}` : '',
        source.publishedAt ? `Published: ${source.publishedAt}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
      const excerpts = byDoc.get(i) ?? [];
      const body =
        excerpts.length > 0
          ? excerpts.map((text, n) => `--- excerpt ${n + 1} ---\n${text}`).join('\n\n')
          : '(no relevant excerpt)';
      return `[${i + 1}] ${source.title}\nURL: ${source.url}${meta ? `\n${meta}` : ''}\n${body}`;
    })
    .join('\n\n---\n\n');

  return [
    { role: 'system' as const, content: system },
    ...history,
    {
      role: 'user' as const,
      content: `Question: ${query}\n\nSources:\n\n${sourceBlock}`,
    },
  ];
}

/** 引用编号越界检查：模型偶尔会写出不存在的来源号 */
function invalidCitations(answer: string, sourceCount: number): number[] {
  const cited = new Set<number>();
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) cited.add(Number(match[1]));
  return [...cited].filter((n) => n < 1 || n > sourceCount).sort((a, b) => a - b);
}

export async function POST(request: NextRequest) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const ctrl = {
    enqueue: (chunk: Uint8Array) => {
      writer.write(chunk).catch(() => {
        // 客户端已断开：忽略后续写入
      });
    },
  } as unknown as SseController;

  const abort = new AbortController();
  const onClientAbort = () => abort.abort();
  request.signal.addEventListener('abort', onClientAbort);
  const timeout = setTimeout(() => abort.abort(), TIMEOUT_MS);

  const run = async () => {
    try {
      const body = (await request.json()) as SearchBody;
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query) {
        send(ctrl, 'error', { message: 'Query is required' });
        return;
      }

      const history = (Array.isArray(body.history) ? body.history : [])
        .filter(
          (m): m is { role: 'user' | 'assistant'; content: string } =>
            (m?.role === 'user' || m?.role === 'assistant') &&
            typeof m?.content === 'string' &&
            m.content.trim().length > 0,
        )
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

      const config = await resolveModelConfig(body);
      if (!config) {
        send(ctrl, 'error', { message: 'No model is configured. Add an API key in Settings → Models.' });
        return;
      }

      const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });

      send(ctrl, 'status', { phase: 'searching' });
      // 1) 拆题：把复杂问题拆成 1-3 个检索词（原始问题始终保留，失败自动退回）
      const planned = await planQueries(client, config.model, query, history, abort.signal);
      const queries = withOriginal(planned, query);
      if (abort.signal.aborted) return;

      // 2) 首轮并行检索 + 规范化 URL 去重 + 站点限额
      const candidates = await searchMany(queries, abort.signal);
      if (abort.signal.aborted) return;
      if (candidates.length === 0) {
        send(ctrl, 'error', { message: `No web results for "${query}". Try different keywords.` });
        return;
      }

      // 3) 抓正文（多级兜底），先发一版来源卡
      send(ctrl, 'status', { phase: 'reading' });
      let docs = await fetchDocs(candidates.slice(0, FIRST_ROUND_SOURCES), abort.signal);
      if (abort.signal.aborted) return;
      send(ctrl, 'sources', { sources: toClientSources(docs) });

      const terms = queryTerms(`${query} ${queries.join(' ')}`);

      // 4) 缺口检查：基于已抓正文的入选段落，而不是搜索摘要
      const gapPassages = rankPassages(docs, terms, query);
      const gap = await findGaps(client, config.model, query, gapPassages, abort.signal);
      if (!abort.signal.aborted && !gap.enough && gap.queries.length > 0 && docs.length < MAX_SOURCES) {
        const known = new Set(docs.map((d) => urlKey(d.source.url)));
        send(ctrl, 'status', { phase: 'searching' });
        const extraCandidates = (await searchMany(gap.queries, abort.signal)).filter(
          (s) => !known.has(urlKey(s.url)),
        );
        if (abort.signal.aborted) return;
        const room = MAX_SOURCES - docs.length;
        if (extraCandidates.length > 0 && room > 0) {
          send(ctrl, 'status', { phase: 'reading' });
          const extraDocs = await fetchDocs(extraCandidates.slice(0, room), abort.signal);
          if (abort.signal.aborted) return;
          docs = [...docs, ...extraDocs].slice(0, MAX_SOURCES);
          // 序号在补搜后整体重排；正文尚未开始，前端整体替换来源列表即可
          send(ctrl, 'sources', { sources: toClientSources(docs) });
        }
      }
      if (abort.signal.aborted) return;

      // 5) 段落级重排：只把高相关段落送进答案模型
      const ranked = rankPassages(docs, terms, query);
      let selected: Passage[];
      if (ranked.length === 0) {
        selected = docs
          .map((d, i) => ({ doc: i, text: d.text.slice(0, PASSAGE_CHARS), score: 0 }))
          .filter((p) => p.text.trim().length > 0)
          .slice(0, MAX_PASSAGES);
      } else {
        const picked = await rerankPassages(client, config.model, query, queries, ranked, abort.signal);
        if (abort.signal.aborted) return;
        selected = enforceDiversity(picked, ranked).map((i) => ranked[i]);
      }
      if (selected.length === 0) {
        send(ctrl, 'error', { message: 'No readable content found for the top results. Try another query.' });
        return;
      }

      const final = compactDocs(docs, selected);
      send(ctrl, 'sources', { sources: toClientSources(final.docs) });

      send(ctrl, 'status', { phase: 'writing' });
      const stream = await client.chat.completions.create(
        {
          model: config.model,
          messages: buildMessages(query, history, final.docs, final.passages),
          temperature: 0.2,
          max_tokens: modelOutputTokenMaxForModel(config.model),
          stream: true,
        },
        { signal: abort.signal },
      );

      let answer = '';
      for await (const chunk of stream) {
        if (abort.signal.aborted) break;
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) {
          answer += text;
          send(ctrl, 'delta', { text });
        }
      }

      if (!abort.signal.aborted) {
        const invalid = invalidCitations(answer, final.docs.length);
        if (invalid.length > 0) send(ctrl, 'audit', { invalid });
        send(ctrl, 'done', { ok: true, model: config.model });
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      const message =
        e instanceof WebError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      try {
        send(ctrl, 'error', { message });
      } catch {
        // 客户端已断开，丢弃
      }
    } finally {
      request.signal.removeEventListener('abort', onClientAbort);
      clearTimeout(timeout);
      try {
        await writer.close();
      } catch {
        // 流已关闭
      }
    }
  };

  void run();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
