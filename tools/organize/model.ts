/**
 * 模型调用层：把「读懂的活」压成单轮调用，必要时再复核一轮。
 *
 * 分工：
 *   代码   → 判类型、抽取首页、拼文件名、决定放哪、版本号累加（全部确定性）
 *   模型   → 只回答 category / topic / version / verdict（+ 依据与次选分类）
 *
 * 判定档用语义三档（confident / unsure / unknown）取代模型自报的浮点置信度：
 * 模型对「0.7 还是 0.8」没有稳定区分能力，但对「确定 / 存疑 / 判不出」可靠得多。
 * 首轮 unsure 时带首页内容再复核一次（reviewPage），仍判不出才落 _待处理。
 *
 * 模型解析复用设置里的「任务模型」（taskModel，统管 AI 字段抽取等轻量任务），
 * 不新增任何配置项；文本走 taskModel，图片/扫描件另找视觉模型。
 */
import { readSettingsFromFile } from '@/lib/settings-server';
import { PROVIDER_PRESETS, type ProviderConfig } from '@/lib/types';
import { resolveTaskModel, resolveProviderModel, type ResolvedModel } from '@/lib/core/task-model';

export type { ResolvedModel };

/** 内置默认分类枚举：模型只能选，不能自创，否则文件夹会失控。
 *  设置里配了自定义分类清单时以自定义清单为准（见 normalizeCategories）。 */
export const CATEGORIES = ['合同协议', '票据凭证', '证件资质', '报表数据', '学习资料', '项目文档', '其他'] as const;

/** 归一自定义分类清单：去非法字符、去空、去重、保序；结果为空则回退内置默认分类。
 *  约定清单最后一项为兜底分类（模型输出越界时落这里）。 */
export function normalizeCategories(raw?: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw ?? []) {
    const v = (item ?? '').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.length > 0 ? out : [...CATEGORIES];
}

/** 单次调用的输出上限：思考型模型的 reasoning 也吃这个额度。
 *  实测 deepseek-flash 判定一份合同 reasoning 可达 1200+ tokens，
 *  给 2000 会出现「思考占满 → 正文为空 → 静默落 _待处理」的概率性失败，
 *  因此基线抬到 6000，并在 finish_reason=length 时用紧凑提示词再试一次。 */
const MAX_TOKENS = 6000;
/** 截断重试时给的上限（思考型模型偶发超长 reasoning，翻倍留余量） */
const RETRY_MAX_TOKENS = 12000;

/** 推荐放置目录：判定为「无法判断」或解析失败时的兜底 */
export const PENDING_DIR = '_待处理';

/** 判定档：确定 / 存疑 / 无法判断 */
export type Verdict = 'confident' | 'unsure' | 'unknown';

/** 判定档的中文标签（CLI 表格、运行日志、日志留痕共用） */
export const VERDICT_LABEL: Record<Verdict, string> = {
  confident: '确定',
  unsure: '存疑',
  unknown: '无法判断',
};

/** 人工纠正 few-shot：模型提示词只需要「主题 → 人工归入的分类」两列 */
export interface CorrectionHint {
  topic: string;
  category: string;
}

export interface FileInsight {
  category: string;
  topic: string;
  version: string | null;
  /** 模型自评的判定档 */
  verdict: Verdict;
  /** 一句话判定依据（写入日志，供人工复核） */
  reason: string;
  /** 存疑时模型给出的次选分类（最多 2 个，不含已选分类） */
  alternatives: string[];
}

/** 首页内容：文本正文 or 图像 data URL（复核时原样重发） */
export type PageContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string };

export interface ClassifyOptions {
  categories: readonly string[];
  /** 允许模型自创分类 */
  autoCreate: boolean;
  /** 人工纠正 few-shot（最近若干条），缺省不注入 */
  corrections?: readonly CorrectionHint[];
  /** 投递箱里已有的分类目录名：注入提示词，要求优先复用、不要为同一事物新建同义目录 */
  existing?: readonly string[];
  /** 各分类目录里已用过的主题：注入提示词，要求同类内容沿用既有措辞（主题稳定才能正确累加版本） */
  topics?: readonly string[];
}

/** 系统提示词按当前分类清单、自创开关、人工纠正与「是否复核」动态拼装 */
function buildSystemPrompt(
  categories: readonly string[],
  autoCreate: boolean,
  review: boolean,
  corrections: readonly CorrectionHint[],
  existing: readonly string[] = [],
  topics: readonly string[] = [],
): string {
  // 归档目录是长期资产：先把「既有目录」摆出来并要求优先复用，
  // 否则模型每次都从零发明分类体系，最终长出「法律文书/法律文件/法律资料」这类同义目录。
  const existingBlock = existing.length > 0
    ? `
既有目录（这是历史上已经建好的归档结构，优先级最高）：
${existing.map((e) => `- ${e}`).join('\n')}
分类时先判断能否归入上面任一目录；能归入就必须沿用它的名字（哪怕措辞与你的习惯不同），
绝不要为同一类事物新建同义目录（如已有「法律文书」就不要再建「法律文件」「法律资料」）。
`
    : '';
  const categoryRule = autoCreate
    ? `上述既有目录都不匹配时，才从以下枚举中选择其一：
${categories.join(' / ')}
若枚举也不合适，就自创一个更贴切的分类名（2~6 字中文名词短语，不得与既有目录或枚举重复或同义，不含标点）。
特别注意：像「法律文书 / 规章制度」这类专业类别，枚举里通常没有对口项 —— 此时**优先自创具体类别**，
不要因为「拿不准」就退到兜底项（清单末位的那个泛化分类），那会让同类文件全挤在一起、看不出结构。`
    : existing.length > 0
      ? `分类只能从「既有目录 + 以下枚举」中择一（不得自创）：
${categories.join(' / ')}`
      : `分类必须从以下枚举中严格选择其一（不得自创）：
${categories.join(' / ')}`;
  const categorySample = autoCreate ? '既有目录名，或上述枚举之一，或自创的分类名' : '上述目录/枚举之一';
  const topicBlock = topics.length > 0
    ? `
已用过的主题（若本次文件与其中某条是同类内容，topic 必须逐字沿用该条，不要换一种说法）：
${topics.map((t) => `- ${t}`).join('\n')}
`
    : '';
  const correctionBlock = corrections.length > 0
    ? `
历史人工纠正（同类内容当时落入了待处理，人工最终归入右边分类，请优先沿用）：
${corrections.map((c) => `- 「${c.topic}」→ ${c.category}`).join('\n')}
`
    : '';
  const reviewBlock = review
    ? `
这是第二次复核：第一次判定为「存疑」，下方给出了初判依据与次选分类。
请独立重判，不要因为初判存在就直接沿用；能确定给 confident，仍无法确定给 unknown。
`
    : '';
  return `你是文件归档助手。根据文件首页内容和原文件名，输出归档所需的字段。
${existingBlock}
${categoryRule}${topicBlock}${correctionBlock}${reviewBlock}
只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块：
{
  "category": "${categorySample}",
  "topic": "主题，6~20字中文名词短语，不含日期/版本号/扩展名",
  "version": "文档内出现的版本标识归一化为 v01 形式（如 V2→v02、第三版→v03）；没有则 null",
  "verdict": "confident | unsure | unknown",
  "reason": "一句话说明判定依据，不超过 40 字",
  "alternatives": ["次选分类1", "次选分类2"]
}

规则：
- topic 要能一眼看出这是什么文件，例如「房屋租赁合同」「7月差旅发票」「Q2销售报表」；
- topic 使用中文，不写公司名后缀、不写"扫描件""副本""最终版"等噪音词；
- topic 必须稳定：同类文件要用同一套措辞，不要这次写「律师函催办投诉」下次写「催办投诉处理律师函」，
  因为文件名与版本号累加依赖主题逐字一致；
- 不要输出扩展名，不要输出日期；
- verdict 只用三档：confident = 有把握；unsure = 倾向某一类但没把握，此时必须给出 1~2 个次选分类；
  unknown = 内容太少或无法判断，此时 alternatives 给空数组；
- 不要输出 0~1 的小数置信度，系统只认 verdict 三档。`;
}

/** 视觉模型名启发：仅用于挑选，挑不到则图片走兜底 */
const VISION_HINT = /(vision|vl|omni|multimodal|gpt-4o|gpt-4\.1|glm-4v|gemini|qwen.*vl)/i;

function baseUrlFor(cfg: ProviderConfig): string {
  return cfg.baseUrl || PROVIDER_PRESETS.find((p) => p.type === cfg.type)?.baseUrl || '';
}

/** 挑一个视觉模型（无专用配置时的启发式查找） */
async function resolveVisionModel(): Promise<ResolvedModel | null> {
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = Array.isArray(settings.providers) ? settings.providers : [];
  for (const cfg of providers) {
    if (!cfg.apiKey) continue;
    const hit = (cfg.selectedModels ?? []).find((m) =>
      VISION_HINT.test(typeof m === 'string' ? m : m.modelId),
    );
    if (!hit) continue;
    return {
      model: typeof hit === 'string' ? hit : hit.modelId,
      apiKey: cfg.apiKey,
      baseUrl: baseUrlFor(cfg),
    };
  }
  return null;
}

/** 解析本次运行要用的模型：显式指定 > 任务模型 > 视觉模型（仅图片需要） */
export async function resolveModel(needVision: boolean, override?: string): Promise<ResolvedModel | null> {
  if (override) return resolveProviderModel(override);
  if (needVision) return (await resolveVisionModel()) ?? (await resolveTaskModel());
  return resolveTaskModel();
}

/** 从模型输出里抠出 JSON 对象（容忍代码块/前后废话） */
function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = (raw || '').replace(/```[a-z]*|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 版本标识归一到 v01 形式；候选来自模型输出，非法则视为无版本 */
export function normalizeVersionLabel(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const arabic = /v?\s*0*(\d{1,2})/i.exec(s);
  if (arabic) return `v${String(Number(arabic[1])).padStart(2, '0')}`;
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const m = /第?([一二三四五六七八九十]+)\s*版/.exec(s);
  if (m) {
    const digit = cn[m[1]];
    if (digit) return `v${String(digit).padStart(2, '0')}`;
  }
  return null;
}

/** 分类名里不承载语义的尾部通用词：归一化时剥掉，用于同义判定（「法律文件」≈「法律」） */
const CATEGORY_NOISE = /(文件|文档|资料|材料|信息|记录|相关|类|表)$/;

/** 归一分类名用于比对：去空白/标点、去尾部通用词 */
function categoryKey(name: string): string {
  const s = name.replace(/[\s·・\-_（）()【】\[\]]/g, '');
  const stripped = s.replace(CATEGORY_NOISE, '');
  return stripped.length >= 2 ? stripped : s;
}

/**
 * 在既有目录里找同义项：完全同名、或归一化后互相包含。
 * 「法律文件」→「法律」，「法律文书」→「法律」，互为包含 → 复用既有目录，
 * 避免模型每次换一个近义词就长出一个新目录。
 */
export function matchExistingCategory(raw: string, existing: readonly string[]): string | null {
  if (!raw) return null;
  if (existing.includes(raw)) return raw;
  const key = categoryKey(raw);
  if (key.length < 2) return null;
  for (const dir of existing) {
    const dirKey = categoryKey(dir);
    if (dirKey.length < 2) continue;
    if (dirKey === key || dirKey.includes(key) || key.includes(dirKey)) return dir;
  }
  return null;
}

/**
 * 分类归一：既有目录优先（含同义合并）→ 清单 → 自创（允许时）。
 * 既有目录的分量最重：它代表用户已经认可的归档结构。
 */
function normalizeCategory(
  raw: string,
  categories: readonly string[],
  autoCreate: boolean,
  existing: readonly string[] = [],
): string {
  const hit = matchExistingCategory(raw, existing);
  if (hit) return hit;
  if (categories.includes(raw)) return raw;
  const fallback = categories[categories.length - 1] ?? '其他';
  if (!autoCreate || !raw) return fallback;
  const clean = raw
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 12);
  return clean || fallback;
}

/** 判定档归一：认三档字面量；缺省时按「有主题 = 存疑（会触发复核）、无主题 = 判不出」处理 */
function normalizeVerdict(raw: unknown, topic: string): Verdict {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'confident' || v === 'unsure' || v === 'unknown') return v;
  }
  return topic ? 'unsure' : 'unknown';
}

/** 次选分类归一：清理非法字符、去重、去掉与已选分类重复的项，最多保留 2 个 */
function normalizeAlternatives(raw: unknown, chosen: string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const v = (typeof item === 'string' ? item : '')
      .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, '')
      .trim()
      .slice(0, 20);
    if (!v || v === chosen || out.includes(v)) continue;
    out.push(v);
    if (out.length >= 2) break;
  }
  return out;
}

/** 归一模型返回的字段：分类越界落清单末位（约定的兜底项），主题清理，判定档与依据归一 */
function normalizeInsight(
  obj: Record<string, unknown>,
  categories: readonly string[],
  autoCreate: boolean,
  existing: readonly string[] = [],
): FileInsight {
  const rawCategory = typeof obj.category === 'string' ? obj.category.trim() : '';
  const category = normalizeCategory(rawCategory, categories, autoCreate, existing);
  const topic = (typeof obj.topic === 'string' ? obj.topic : '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '') // 去掉文件名非法字符
    .replace(/\.(pdf|docx?|xlsx?|png|jpe?g|txt|md)$/i, '')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 40);
  const reason = (typeof obj.reason === 'string' ? obj.reason : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return {
    category,
    topic,
    version: normalizeVersionLabel(obj.version),
    verdict: normalizeVerdict(obj.verdict, topic),
    reason,
    alternatives: normalizeAlternatives(obj.alternatives, category),
  };
}

/** 组装用户消息：原文件名 + 首页内容；（复核时）附上初判依据与次选分类 */
function userContent(fileName: string, page: PageContent, prior?: FileInsight): unknown {
  const head = prior
    ? `原文件名：${fileName}

第一次判定：分类「${prior.category}」、主题「${prior.topic}」；
初判依据：${prior.reason || '（未给出）'}
次选分类：${prior.alternatives.join('、') || '（无）'}
请复核后重新判定。

`
    : `原文件名：${fileName}

`;
  if (page.kind === 'text') return `${head}首页内容：
${page.text}`;
  return [
    { type: 'text', text: `${head}这是文件首页的图像，请识别并归档。` },
    { type: 'image_url', image_url: { url: page.dataUrl } },
  ];
}

/** 一次判定的调用痕迹（写日志用：模型、token、是否重试过） */
export interface ClassifyMeta {
  /** 实际使用的模型名 */
  model: string;
  /** 累计 token（多轮相加） */
  tokens: { prompt: number; completion: number; reasoning: number };
  /** 因为截断而重试的次数 */
  retries: number;
  /** 过程说明（截断/重试等），写入整理日志的 note */
  note: string;
}

/** 空痕迹工厂（调用方先备好，失败时也有模型名可记） */
export function emptyMeta(model = ''): ClassifyMeta {
  return { model, tokens: { prompt: 0, completion: 0, reasoning: 0 }, retries: 0, note: '' };
}

/**
 * 紧凑提示词：截断重试时用。
 * 首轮被 reasoning 吃满额度，往往是因为完整规则段落引发过度推理；
 * 重试只留最必要的约束，缩短思考链路，同时保留 JSON 契约。
 */
function buildCompactPrompt(
  categories: readonly string[],
  autoCreate: boolean,
  existing: readonly string[],
  topics: readonly string[] = [],
): string {
  const list = existing.length > 0 ? `既有目录（优先复用，不要为同一事物新建同义目录）：${existing.join(' / ')}\n` : '';
  const topicList = topics.length > 0 ? `已用主题（同类内容逐字沿用其中一条）：${topics.slice(0, 20).join(' / ')}\n` : '';
  const rule = autoCreate
    ? `分类优先用既有目录；其次用清单：${categories.join(' / ')}；确属新领域才自创（2~6 字中文名词）。`
    : `分类必须从以下清单中严格择一：${categories.join(' / ')}。`;
  return `归档判定。${list}${topicList}${rule}
只输出一行 JSON，不要解释、不要 markdown：
{"category":"...","topic":"6~20字中文主题，不含日期/版本/扩展名","version":"v01 或 null","verdict":"confident|unsure|unknown","reason":"不超过40字","alternatives":[]}`;
}

/** 单轮调用（内部）：逐次记录 usage，预算与超时可配 */
async function callOnce(
  cfg: ResolvedModel,
  content: unknown,
  system: string,
  categories: readonly string[],
  autoCreate: boolean,
  existing: readonly string[],
  maxTokens: number,
  meta: ClassifyMeta,
  timeoutMs: number,
): Promise<{ insight: FileInsight | null; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${err.slice(0, 160)}`);
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const u = data.usage;
    if (u) {
      meta.tokens.prompt += u.prompt_tokens ?? 0;
      meta.tokens.completion += u.completion_tokens ?? 0;
      meta.tokens.reasoning += u.completion_tokens_details?.reasoning_tokens ?? 0;
    }
    const choice = data?.choices?.[0];
    const raw = choice?.message?.content || '';
    const obj = extractJson(raw);
    // 正文被思考过程挤空（额度用尽）→ 标记截断，交上层决定重试
    const truncated = choice?.finish_reason === 'length' && !obj;
    return {
      insight: obj ? normalizeInsight(obj, categories, autoCreate, existing) : null,
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带重试的判定：正常额度跑一次；被思考挤空（finish_reason=length）时
 * 用「紧凑提示词 + 更大额度」再跑一次。两次都截断才算失败。
 */
async function callWithRetry(
  cfg: ResolvedModel,
  content: unknown,
  opts: ClassifyOptions,
  existing: readonly string[],
  meta: ClassifyMeta,
  review: boolean,
  timeoutMs = 45000,
): Promise<FileInsight | null> {
  const topics = opts.topics ?? [];
  const full = buildSystemPrompt(opts.categories, opts.autoCreate, review, opts.corrections ?? [], existing, topics);
  const first = await callOnce(cfg, content, full, opts.categories, opts.autoCreate, existing, MAX_TOKENS, meta, timeoutMs);
  if (first.insight) return first.insight;
  if (!first.truncated) return null;

  meta.retries += 1;
  meta.note = meta.note ? `${meta.note}；截断后重试成功` : '首轮被思考占满，重试';
  const compact = buildCompactPrompt(opts.categories, opts.autoCreate, existing, topics);
  const second = await callOnce(cfg, content, compact, opts.categories, opts.autoCreate, existing, RETRY_MAX_TOKENS, meta, timeoutMs);
  if (second.insight) return second.insight;
  if (second.truncated) {
    meta.note = `两轮均被思考占满（max_tokens=${MAX_TOKENS}→${RETRY_MAX_TOKENS}）`;
  }
  return null;
}

/** 首轮判定：文本与图片同一入口。meta 用于回收 token/重试痕迹（写日志） */
export function classifyPage(
  cfg: ResolvedModel,
  fileName: string,
  page: PageContent,
  opts: ClassifyOptions,
  meta: ClassifyMeta = emptyMeta(cfg.model),
): Promise<FileInsight | null> {
  const existing = opts.existing ?? [];
  return callWithRetry(cfg, userContent(fileName, page), opts, existing, meta, false);
}

/** 第二轮复核：仅在首轮 verdict === 'unsure' 时调用，带上首页内容与初判再判一次 */
export function reviewPage(
  cfg: ResolvedModel,
  fileName: string,
  page: PageContent,
  first: FileInsight,
  opts: ClassifyOptions,
  meta: ClassifyMeta = emptyMeta(cfg.model),
): Promise<FileInsight | null> {
  const existing = opts.existing ?? [];
  return callWithRetry(cfg, userContent(fileName, page, first), opts, existing, meta, true);
}
