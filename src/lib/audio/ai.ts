/**
 * 音频编辑器的 AI 增强（**服务端专属**：要模型配置 + `fetch`，客户端组件不得值引入本文件）。
 *
 * 三个能力，都服务于"打点 / 截取 / 读稿"这条手：
 *   1. `generateHighlights` —— 读转写，挑出"值得留的区间"（AI 精选片段）；
 *   2. `suggestClipName`    —— 给一个区间起个 ≤12 字的标题（截取时的命名）；
 *   3. `polishTurns`        —— 用 DSH 任务模型把 ASR 原文整理成可读对话（只改 text）。
 *
 * 设计纪律（三条，改这个文件前先读）：
 *   - **纯函数与副作用分离**：解析/清洗/钳位全在导出的纯函数里（`extractJsonArray` /
 *     `cleanClipName` / `normalizeHighlights`），可单测；网络调用只在 `callModel` 里。
 *     仓库没有 jsdom，组件测不了，所以"能被单测覆盖多少"直接决定这层能不能守住。
 *   - **模型输出一律当不可信输入**：越界/倒置/NaN 的区间**直接丢弃**（不钳到边界 ——
 *     钳位会把模型的胡说变成一段看着合法的片段，与"本来就想截到结尾"无法区分）。
 *   - **失败不抛给路由**：返回 `{ ok:false, error }`，由路由转成 `{success:false,error}` 的 200。
 *     模型没配 / 超时 / 返回垃圾都不该让用户看到 500。
 */
import { resolveTaskModel, type ResolvedModel } from '@/lib/core/task-model';
import { validRange, type HighlightSuggestion, type TranscriptSegment } from './transcript';
import { markLabelFromText } from './mark-ops';

/** 精选建议的形状定义在 `./transcript`（纯函数层，客户端也能引类型），此处只做转发方便调用方 */
export type { HighlightSuggestion };

/** 单次精选的条数上限（再多用户也挑不过来，且会稀释质量） */
export const MAX_HIGHLIGHTS = 8;
/** 精选区间的最短跨度（秒）：比这还短的"高光"没有剪辑价值 */
export const MIN_HIGHLIGHT_SPAN_SEC = 1;
/** 送进模型的转写正文上限（字符）：超长截断，避免 prompt 失控 */
export const MAX_PROMPT_CHARS = 12000;
/** 片段名长度上限（与 suggest-title 的 20 不同：文件名要能一眼扫过） */
export const MAX_CLIP_NAME_CHARS = 12;

const HIGHLIGHT_TIMEOUT_MS = 20000;
const NAME_TIMEOUT_MS = 10000;

export type AiResult<T> = { ok: true; value: T; model: string } | { ok: false; error: string };

// ──────────────────────────────────────────────────────────────
// 纯函数：解析模型输出
// ──────────────────────────────────────────────────────────────

/**
 * 从模型输出里抠出 JSON 数组。
 *
 * 要处理的真实形态（都是实测常见）：
 *   - 包在 ```json ``` 代码块里；
 *   - 前面带一句"好的，以下是我挑选的片段："；
 *   - 外面套一层对象 `{"highlights":[...]}`；
 *   - 直接就是数组。
 * 抠不出来返回 null（调用方据此报"模型返回的内容没法解析"，而不是崩掉）。
 */
export function extractJsonArray(raw: string): unknown[] | null {
  const text = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').replace(/```/g, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) {
    // 退一步：可能是 {"highlights": [...]} 这类对象包一层
    const os = text.indexOf('{');
    const oe = text.lastIndexOf('}');
    if (os < 0 || oe <= os) return null;
    try {
      const obj = JSON.parse(text.slice(os, oe + 1)) as Record<string, unknown>;
      for (const key of ['highlights', 'items', 'segments', 'clips', 'result']) {
        if (Array.isArray(obj?.[key])) return obj[key] as unknown[];
      }
    } catch {
      return null;
    }
    return null;
  }
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * 模型输出 → 文件名安全且简短的标题。
 *
 * 比 `api/nodes/suggest-title` 的 `cleanTitle` 多做两件事：**剥掉文件名非法字符**
 * （`/ \ : * ? " < > |`）与**去掉结尾标点** —— 这个结果会直接成为磁盘文件名的一部分
 * （服务端之后还会过一道 `safeBaseName`，但让模型输出先在客户端就干净，
 * 用户在输入框里看到的才是"最终会落盘的样子"）。
 */
export function cleanClipName(raw: string, max = MAX_CLIP_NAME_CHARS): string {
  let t = String(raw ?? '').replace(/```[a-zA-Z]*/g, '').replace(/```/g, '');
  t = t.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  t = t.replace(/[\\/:*?"<>|]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  // 交替剥「结尾标点」与「首尾引号/括号」，**反复到稳定**：
  // 模型常写 `“预算分配方案”。` —— 只剥一遍会先去掉句号、留下一个孤零零的右引号
  // （unit test 抓到的就是这个：得到 `预算分配方案”`）。三轮足够，且必然收敛。
  const EDGE = /^["'“”‘’《》【】\[\]\s]+|["'“”‘’《》【】\[\]\s]+$/g;
  const TAIL_PUNCT = /[。．.，,、；;：:！!？?~～]+$/g;
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(EDGE, '').replace(TAIL_PUNCT, '').trim();
    if (t === before) break;
  }
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join('').trim() : t;
}

/**
 * 模型给的数组 → 合法建议列表。
 *
 * 逐条：取 start/end/title/reason → `validRange` 硬校验（含 0.5s 上界容差，
 * 理由见 transcript.ts 的 validRange 注释）→ 越界/倒置/NaN **丢弃**；
 * 标题为空时用理由的前 12 字兜底（宁可有个名字，也不要一个只有时间的卡片）；
 * 同 start 的建议去重；最后截到 `max` 条。
 */
export function normalizeHighlights(
  raw: unknown,
  durationSec: number | null | undefined,
  max = MAX_HIGHLIGHTS,
): HighlightSuggestion[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { highlights?: unknown }).highlights)
      ? ((raw as { highlights: unknown[] }).highlights)
      : [];
  const out: HighlightSuggestion[] = [];
  const seen = new Set<number>();
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as { start?: unknown; end?: unknown; title?: unknown; reason?: unknown };
    const range = validRange(o.start, o.end, durationSec, MIN_HIGHLIGHT_SPAN_SEC);
    if (!range) continue;
    const key = Math.round(range.start * 10);
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = typeof o.reason === 'string' ? o.reason.trim().slice(0, 200) : '';
    const title =
      (typeof o.title === 'string' ? cleanClipName(o.title) : '') || markLabelFromText(reason, MAX_CLIP_NAME_CHARS) || '';
    out.push({ start: range.start, end: range.end, title, reason });
    if (out.length >= max) break;
  }
  return out;
}

/** 段列表 → 送进模型的转写正文（`[mm:ss] 文本` 每行一段；超长截断并留痕） */
export function transcriptForPrompt(segments: TranscriptSegment[], maxChars = MAX_PROMPT_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const s of segments) {
    const mm = String(Math.floor(s.t / 60)).padStart(2, '0');
    const ss = String(Math.floor(s.t % 60)).padStart(2, '0');
    const speaker = s.speaker === null ? '' : `[说话人 ${s.speaker + 1}] `;
    const line = `[${mm}:${ss}] ${speaker}${s.text.replace(/\s+/g, ' ').trim()}`;
    if (used + line.length > maxChars) {
      lines.push('…（转写过长，后续内容已省略）');
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
// 副作用：调任务模型
// ──────────────────────────────────────────────────────────────

const HIGHLIGHT_SYSTEM_PROMPT = `你是音频剪辑助手。用户给你一份带时间戳的音频转写，你要挑出**最值得单独剪出来的片段**。
规则：
- 选语义完整、能独立成篇的片段（一个话题、一个结论、一个故事、一处关键交代）；
- 每条 20~120 秒为宜，不要互相重叠，不要选纯寒暄/纯语气词；
- 时间戳必须来自转写里出现过的时刻，且不得超出音频总时长；
- 标题 6~12 个汉字，是主题名词短语，不要照抄原句、不要以"这段/关于/讲述"开头、结尾不加标点；
- 理由一句话，20 字以内，说明为什么值得留；
- 最多输出 8 条，宁缺毋滥。
只输出一个 JSON 数组，形如：
[{"start":12.5,"end":75.0,"title":"预算分配方案","reason":"给出了三个可选口径"}]
不要输出任何解释、不要用代码块包裹。`;

const NAME_SYSTEM_PROMPT = `你给一段音频片段起标题。规则：
- 6~12 个汉字，主题名词短语，概括这段内容在说什么；
- 禁止照抄原句、禁止以"这段/关于/讲述/讨论"开头、结尾不加标点符号；
- 只输出标题本身，不要引号、不要解释、不要输出任何其他内容。`;

async function callModel(
  cfg: ResolvedModel,
  system: string,
  user: string,
  timeoutMs: number,
): Promise<string> {
  const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data?.choices?.[0]?.message?.content ?? '';
}

/** 拿任务模型；没配就明确说清楚去哪儿配（照 `nodes/suggest-title` 的口径） */
async function requireModel(): Promise<AiResult<ResolvedModel>> {
  let cfg: ResolvedModel | null = null;
  try {
    cfg = await resolveTaskModel();
  } catch {
    cfg = null;
  }
  if (!cfg) {
    return { ok: false, error: '尚未配置任何模型，请在【设置 → Models】中配置后再使用 AI 功能。' };
  }
  return { ok: true, value: cfg, model: cfg.model };
}

/**
 * AI 精选：转写 → 建议区间。
 *
 * 转写为空、时长未知、模型不可用、模型返回解析不出来 —— 一律 `{ok:false,error}`，
 * 调用方据此提示并回退到"按说话人切换/按打点切分"的纯规则路径（不把用户堵死）。
 */
export async function generateHighlights(
  segments: TranscriptSegment[],
  durationSec: number | null | undefined,
  max = MAX_HIGHLIGHTS,
): Promise<AiResult<HighlightSuggestion[]>> {
  if (segments.length === 0) return { ok: false, error: '还没有转写文本，无法精选片段。' };
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: '拿不到音频总时长，无法校验精选区间（可先播放一次让波形就绪）。' };
  }
  const cfgRes = await requireModel();
  if (!cfgRes.ok) return cfgRes;

  const user = [
    `音频总时长：${duration.toFixed(1)} 秒。`,
    '转写如下：',
    transcriptForPrompt(segments),
  ].join('\n');

  let raw = '';
  try {
    raw = await callModel(cfgRes.value, HIGHLIGHT_SYSTEM_PROMPT, user, HIGHLIGHT_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const arr = extractJsonArray(raw);
  if (!arr) return { ok: false, error: '模型返回的内容无法解析成片段列表，请重试。' };
  const items = normalizeHighlights(arr, duration, max);
  if (items.length === 0) return { ok: false, error: '模型给出的区间都不在音频范围内，请重试。' };
  return { ok: true, value: items, model: cfgRes.model };
}

/** 给一个区间起名（区间内的转写文本作输入） */
export async function suggestClipName(text: string): Promise<AiResult<string>> {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '这段区间里没有转写文本，无法生成标题。' };
  const cfgRes = await requireModel();
  if (!cfgRes.ok) return cfgRes;

  let raw = '';
  try {
    raw = await callModel(cfgRes.value, NAME_SYSTEM_PROMPT, body.slice(0, 2000), NAME_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const name = cleanClipName(raw);
  if (!name) return { ok: false, error: '模型没有给出可用的标题。' };
  return { ok: true, value: name, model: cfgRes.model };
}

// ============================================================
// 转写润色（DeepSeek 任务模型）：把 ASR 原文整理成可读对话
// ============================================================

/** 单次润色的轮数上限（客户端按批调用；40 轮 ≈ 2–4k 字，远小于 60s 路由时限） */
export const MAX_POLISH_TURNS = 40;
/** 润色超时：任务模型通常 3–10s；给足余量 */
const POLISH_TIMEOUT_MS = 40_000;

export interface PolishInputTurn {
  id: number;
  speaker: number | null;
  text: string;
}

export interface PolishOutputTurn {
  id: number;
  text: string;
}

const POLISH_SYSTEM_PROMPT = `你是中文录音转写编辑。用户给你若干轮对话，每行以 [id] 开头，后面是 ASR 原文。
只做这些修改：
- 补全标点、合理断句；
- 修正明显的同音字/人名/术语（不确定就不要改）；
- 去掉无意义口头词（嗯/呃/啊/那个/就是）和重复结巴；
- 保持原意与事实，不增删信息。
禁止：改变说话人、合并或拆分轮次、修改 id、输出任何解释；
也不要在 text 里写“[说话人 N]”或任何说话人前缀 —— 说话人由系统单独显示。
只输出一个 JSON 数组，形如：
[{"id":0,"text":"整理后的这一轮文本"}]
不要用代码块包裹。`;

/**
 * 批量润色若干轮对话。
 *
 * 为什么按“轮”而不是按“段”：段的粒度太碎（563 段会变成 563 次调用），且模型看不到上下文；
 * 按轮喂能保留对话顺序，又能把调用数压到可接受范围。
 * 失败口径与 highlights 一致：返回 `{ok:false,error}`，由路由转成 200 + 可读原因。
 */
export async function polishTurns(turns: PolishInputTurn[]): Promise<AiResult<PolishOutputTurn[]>> {
  const items = turns
    .filter((t) => typeof t?.text === 'string' && t.text.trim().length > 0)
    .slice(0, MAX_POLISH_TURNS);
  if (items.length === 0) return { ok: false, error: '没有可润色的转写文本。' };

  const cfgRes = await requireModel();
  if (!cfgRes.ok) return cfgRes;

  const user = items
    .map((t) => `[${t.id}]${t.speaker === null ? '' : ` [说话人 ${t.speaker + 1}]`} ${t.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
    .slice(0, 12000);

  let raw = '';
  try {
    raw = await callModel(cfgRes.value, POLISH_SYSTEM_PROMPT, user, POLISH_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const arr = extractJsonArray(raw);
  if (!arr) return { ok: false, error: '模型返回的内容无法解析成润色文本，请重试。' };

  const byId = new Map<number, string>();
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as { id?: unknown; text?: unknown };
    const id = Number(o.id);
    const rawText = typeof o.text === 'string' ? o.text.trim() : '';
    // 防御：模型偶尔会自己加说话人前缀（实测 deepseek-flash 会），会在 UI 里与轮首重复
    const text = rawText.replace(/^\[?说话人\s*\d+\]?[:：]?\s*/, '').trim();
    if (!Number.isInteger(id) || !text) continue;
    byId.set(id, text);
  }
  const out: PolishOutputTurn[] = [];
  for (const t of items) {
    const text = byId.get(t.id);
    if (text) out.push({ id: t.id, text });
  }
  if (out.length === 0) return { ok: false, error: '模型没有返回可用的润色文本，请重试。' };
  return { ok: true, value: out, model: cfgRes.model };
}
