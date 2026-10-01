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

/** 单次调用的输出上限：思考型模型的 reasoning 也吃这个额度，
 *  给太小（如 300）会出现正文被挤空、JSON 解析失败而静默落 _待处理 */
const MAX_TOKENS = 2000;

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
}

/** 系统提示词按当前分类清单、自创开关、人工纠正与「是否复核」动态拼装 */
function buildSystemPrompt(
  categories: readonly string[],
  autoCreate: boolean,
  review: boolean,
  corrections: readonly CorrectionHint[],
): string {
  const categoryRule = autoCreate
    ? `分类优先从以下枚举中选择其一：
${categories.join(' / ')}
若上述枚举都不合适，可自创一个分类名（2~6 字中文名词短语，不得与枚举重复，不含标点）。`
    : `分类必须从以下枚举中严格选择其一（不得自创）：
${categories.join(' / ')}`;
  const categorySample = autoCreate ? '上述枚举之一，或自创的分类名' : '上述枚举之一';
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

${categoryRule}${correctionBlock}${reviewBlock}
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

/** 分类归一：清单内直接采纳；允许自创时清理非法字符后采纳，否则落清单末位（约定的兜底项） */
function normalizeCategory(raw: string, categories: readonly string[], autoCreate: boolean): string {
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
): FileInsight {
  const rawCategory = typeof obj.category === 'string' ? obj.category.trim() : '';
  const category = normalizeCategory(rawCategory, categories, autoCreate);
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

/** 单轮调用：超时上限 30s */
async function callModel(
  cfg: ResolvedModel,
  content: unknown,
  opts: ClassifyOptions,
  review = false,
  timeoutMs = 30000,
): Promise<FileInsight | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt(opts.categories, opts.autoCreate, review, opts.corrections ?? []),
          },
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
    };
    const choice = data?.choices?.[0];
    // 正文被思考过程挤空（额度用尽）→ 明确报错，避免静默落入 _待处理
    if (choice?.finish_reason === 'length' && !choice.message?.content) {
      throw new Error(`模型输出被截断（max_tokens=${MAX_TOKENS} 被思考过程占满）`);
    }
    const raw = choice?.message?.content || '';
    const obj = extractJson(raw);
    return obj ? normalizeInsight(obj, opts.categories, opts.autoCreate) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** 首轮判定：文本与图片同一入口 */
export function classifyPage(
  cfg: ResolvedModel,
  fileName: string,
  page: PageContent,
  opts: ClassifyOptions,
): Promise<FileInsight | null> {
  return callModel(cfg, userContent(fileName, page), opts);
}

/** 第二轮复核：仅在首轮 verdict === 'unsure' 时调用，带上首页内容与初判再判一次 */
export function reviewPage(
  cfg: ResolvedModel,
  fileName: string,
  page: PageContent,
  first: FileInsight,
  opts: ClassifyOptions,
): Promise<FileInsight | null> {
  return callModel(cfg, userContent(fileName, page, first), opts, true);
}
