/**
 * Today 建议的 AI 判断层（lib/butler/advice-ai.ts，server-only）
 *
 * 与 advice.ts 的分工（务必别越界）：
 *   - advice.ts 是**规则引擎**：产出卡片与其中的可点击条目（id / items / count 全由它定），
 *     确定性、可解释、可点击、零 I/O；
 *   - 本模块只做**一件事**：给已经产出的卡片各写一句 `reason`（判断依据）。
 *
 * 硬边界（用户明确要求）：
 *   - **AI 不产出、不增删卡片与条目**。id 必须来自输入卡片，多出的 id 一律丢弃；
 *     这样即使模型幻觉，也伤不到“可点、可勾、可跳”的结构。
 *   - 模型不可用 / 超时 / 输出无法解析 → 返回 null，调用方保留规则文案（**绝不半截覆盖**）。
 *   - 输入必须带 Memory / Rules —— 否则只会产出“建议你优先处理重要的事”这类正确的废话。
 *
 * 缓存：以**条目集合的 hash** 为键（集合变了才重算，例如勾掉一条 → hash 变 → 重算），
 * 落在 `butler/.state/advice/<YYYY-MM-DD>-<hash>.json`。跨天自然失效（文件名含日期）。
 *
 * 触发不在这里：GET /api/butler/today 只读缓存（秒开），未命中标 `adviceStale`，
 * 由前端后台打 POST /api/butler/advice/refresh 生成并落缓存。
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { UserPreference } from '@/lib/core/preferences-shared';
import { listPreferences } from '@/lib/core/preferences';
import { resolveTaskModel, type ResolvedModel } from '@/lib/core/task-model';
import type { AdviceCard } from './advice';
import { listRules } from './rules';
import type { RuleRecord } from './rules-shared';
import { STATE_DIR, dateStamp } from './storage';
import { atomicWriteFile } from './fs-atomic';

/** cardId → 一句判断（reason）。只覆盖输入卡片里出现过的 id。 */
export type AdviceReasons = Record<string, string>;

/** 模型调用超时：建议是首屏旁的附属信息，宁可用规则文案也不要挂住 */
const MODEL_TIMEOUT_MS = 15_000;
/** 记忆注入上限（取最近 N 条，避免 prompt 膨胀） */
const MAX_MEMORIES = 30;
/** 规则注入上限 */
const MAX_RULES = 20;
/** 规则原话在 prompt 里的截断长度（只要一句摘要，不搬全文） */
const RULE_SNIPPET_LEN = 80;
/** 单条 reason 的字符上限（与“一句判断”的定位一致） */
const REASON_MAX_LEN = 40;

/** 只对**非 clear** 卡写 reason：「今天很空」这类无需模型再判断，写反而容易说空话 */
function reasonTargets(cards: AdviceCard[]): AdviceCard[] {
  return cards.filter((c) => c.kind !== 'clear');
}

/**
 * 条目集合 hash：卡片 id + 类型 + 数量 + 各卡 items 的 key（排序后）拼接后取短 sha1。
 * 集合（条目/数量）变了就变 —— 这正是“勾掉一条即重算”的判据。
 */
export function adviceHash(cards: AdviceCard[]): string {
  const parts = cards
    .map((c) => {
      const keys = c.items.map((i) => i.key).sort().join(',');
      return `${c.id}|${c.kind}|${c.count}|${keys}`;
    })
    .sort()
    .join(';');
  return createHash('sha1').update(parts).digest('hex').slice(0, 12);
}

/** 一句摘要：压掉换行、截断，供规则注入 prompt */
function snippet(s: string, max = RULE_SNIPPET_LEN): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 构造提示词：记忆 / 规则给“你懂我”的上下文，卡片给“要写什么”。
 * 只要求模型为每张卡回一句 reason，并强调 id 必须来自输入。
 */
export function buildAdvicePrompt(
  cards: AdviceCard[],
  memories: UserPreference[],
  rules: RuleRecord[],
): string {
  const memBlock = memories.length
    ? memories.map((m) => `- [${m.type}] ${snippet(m.content, 120)}`).join('\n')
    : '（暂无）';
  const ruleBlock = rules.length
    ? rules.map((r) => `- ${snippet(r.name, 40)}：${snippet(r.intentRaw)}`).join('\n')
    : '（暂无）';
  const cardBlock = cards
    .map((c) => {
      const items = c.items.map((i) => i.title).join('、') || '（无关联条目）';
      return `- id=${c.id}｜类型=${c.kind}｜标题=${c.title}｜数量=${c.count}｜关联条目=${items}`;
    })
    .join('\n');

  return `下面是用户的三部分信息。请为「待写理由的建议卡」里的**每一张卡**写一句 reason（判断依据）。

【用户记忆】
${memBlock}

【既有规则】
${ruleBlock}

【待写理由的建议卡】
${cardBlock}

要求：
1. reason 是**中文的一句话**（不超过 ${REASON_MAX_LEN} 字），说明“为什么这条现在值得处理”，
   像熟悉用户的助理那样给出**具体判断**，可结合上面的记忆与规则；
2. **不要复述卡片的标题或条目名**，也不要空泛说教（例如「建议优先处理重要的事」）。
   要有信息量：点出用户的偏好、习惯、既有规则，或这条与其它事项的取舍关系；
3. 只能为上面列出的卡片写 reason，**id 必须原样取自输入**；不要新增、删除或改动任何卡片与条目；
4. 只输出 JSON，不要解释、不要代码块围栏，格式为：
{"reasons":[{"id":"卡片id","reason":"一句话"}]}`;
}

/** 去掉 ```json ... ``` 围栏；无围栏时原样返回 */
function stripFence(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

/** 从任意形状的模型输出里取出 [{id, reason}] 列表（容错：数组 / {reasons:[]} / {id: reason} 映射） */
function extractEntries(parsed: unknown): Array<{ id: string; reason: string }> {
  const normalize = (v: unknown): Array<{ id: string; reason: string }> =>
    Array.isArray(v)
      ? v
          .map((e) => {
            if (!e || typeof e !== 'object') return null;
            const o = e as Record<string, unknown>;
            const id = typeof o.id === 'string' ? o.id.trim() : '';
            const reason = typeof o.reason === 'string' ? o.reason : '';
            return id ? { id, reason } : null;
          })
          .filter((x): x is { id: string; reason: string } => !!x)
      : [];

  if (Array.isArray(parsed)) return normalize(parsed);
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.reasons)) return normalize(o.reasons);
    // 也接受直接映射 { "overdue": "…" }
    const mapped = Object.entries(o)
      .filter(([, v]) => typeof v === 'string')
      .map(([id, reason]) => ({ id, reason: reason as string }));
    if (mapped.length > 0) return mapped;
  }
  return [];
}

/**
 * 解析模型输出为 reasons。容错：围栏、夹带说明（截取首个 `{` 到末个 `}`）、三种 JSON 形状。
 * 丢弃 id 不在 allowedIds 的条目（防模型新增卡片）；空结果 → null。
 */
export function parseAdviceReasons(raw: string, allowedIds: Set<string>): AdviceReasons | null {
  const text = stripFence(raw || '');
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      parsed = JSON.parse(text.slice(a, b + 1));
    } catch {
      return null;
    }
  }

  const out: AdviceReasons = {};
  for (const { id, reason } of extractEntries(parsed)) {
    if (!allowedIds.has(id)) continue; // 只认输入卡片
    const r = reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX_LEN);
    if (r) out[id] = r;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 缓存目录：butler/.state/advice */
function adviceCacheDir(): string {
  return join(STATE_DIR, 'advice');
}

/** 缓存文件名：<YYYY-MM-DD>-<hash>.json（含日期 → 跨天自然失效） */
function cacheFileName(cards: AdviceCard[]): string {
  return `${dateStamp(new Date())}-${adviceHash(cards)}.json`;
}

/** 读缓存：文件不存在 / 损坏 / 与当前集合不符（文件名即 hash）→ null */
export async function readAdviceReasons(cards: AdviceCard[]): Promise<AdviceReasons | null> {
  const targets = reasonTargets(cards);
  if (targets.length === 0) return null;
  try {
    const raw = await fs.readFile(join(adviceCacheDir(), cacheFileName(targets)), 'utf-8');
    const parsed = JSON.parse(raw) as { reasons?: unknown };
    const r = parsed?.reasons;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const out: AdviceReasons = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 写缓存（原子写）；无目标卡（全是 clear）时不写 */
export async function writeAdviceCache(cards: AdviceCard[], reasons: AdviceReasons): Promise<void> {
  const targets = reasonTargets(cards);
  if (targets.length === 0) return;
  await fs.mkdir(adviceCacheDir(), { recursive: true });
  await atomicWriteFile(
    join(adviceCacheDir(), cacheFileName(targets)),
    JSON.stringify({ at: new Date().toISOString(), reasons }, null, 2),
  );
}

/** 就地把缓存/AI 的 reason 覆盖到卡片上（id 命中才覆盖，不动顺序、不动 items） */
export function applyAdviceReasons(cards: AdviceCard[], reasons: AdviceReasons | null): AdviceCard[] {
  if (!reasons) return cards;
  return cards.map((c) => (reasons[c.id] ? { ...c, reason: reasons[c.id] } : c));
}

/** 当前卡片集合是否已全部被 AI reason 覆盖（决定 adviceStale）；全是 clear 卡时视为已覆盖 */
export function adviceCovered(cards: AdviceCard[], reasons: AdviceReasons | null): boolean {
  const targets = reasonTargets(cards);
  if (targets.length === 0) return true;
  return !!reasons && targets.every((c) => !!reasons[c.id]);
}

/** 调任务模型；失败抛出，由调用方降级 */
async function callModel(cfg: ResolvedModel, prompt: string): Promise<string> {
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
        {
          role: 'system',
          content:
            '你是 Butler 的今日建议助手。你只为给定的每张建议卡各写一句判断依据（reason），'
            + '帮助用户理解为什么这条值得现在处理。严禁新增、删除或改写卡片与其中的待办条目。',
        },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * 生成 reasons 并落缓存。任一环节不可用（无模型 / 超时 / 解析失败）→ null，调用方保留规则文案。
 * 只在成功时写缓存，避免把半截结果固化。
 */
export async function generateAdviceReasons(cards: AdviceCard[]): Promise<AdviceReasons | null> {
  const targets = reasonTargets(cards);
  if (targets.length === 0) return null;

  let cfg: ResolvedModel | null = null;
  try {
    cfg = await resolveTaskModel();
  } catch {
    cfg = null;
  }
  if (!cfg) return null;

  const [memories, rules] = await Promise.all([
    listPreferences().catch(() => [] as UserPreference[]),
    listRules().catch(() => [] as RuleRecord[]),
  ]);
  const prompt = buildAdvicePrompt(
    targets,
    memories.slice(-MAX_MEMORIES),
    rules.slice(0, MAX_RULES),
  );

  let content = '';
  try {
    content = await callModel(cfg, prompt);
  } catch (e) {
    console.warn('[advice-ai] 模型调用失败，保留规则文案:', e instanceof Error ? e.message : String(e));
    return null;
  }

  const reasons = parseAdviceReasons(content, new Set(targets.map((c) => c.id)));
  if (!reasons) {
    console.warn('[advice-ai] 模型输出解析失败，保留规则文案');
    return null;
  }
  await writeAdviceCache(targets, reasons).catch((e) => {
    console.warn('[advice-ai] 缓存写入失败（不影响本次返回）:', e instanceof Error ? e.message : String(e));
  });
  return reasons;
}
