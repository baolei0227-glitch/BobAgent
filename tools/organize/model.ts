/**
 * 模型调用层：把「读懂的活」压成一次单轮调用。
 *
 * 分工：
 *   代码   → 判类型、抽取首页、拼文件名、决定放哪、版本号累加（全部确定性）
 *   模型   → 只回答 4 个字段：category / topic / version / confidence
 *
 * 模型解析复用设置里的「任务模型」（taskModel，统管 AI 字段抽取等轻量任务），
 * 不新增任何配置项；文本走 taskModel，图片/扫描件另找视觉模型。
 */
import { readSettingsFromFile } from '@/lib/settings-server';
import { PROVIDER_PRESETS, type ProviderConfig } from '@/lib/types';
import { resolveTaskModel, resolveProviderModel, type ResolvedModel } from '@/lib/wanted/task-model';

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

/** 低于此置信度不猜，落 _待处理 */
export const LOW_CONFIDENCE = 0.6;

/** 推荐放置目录：低置信度/解析失败时的兜底 */
export const PENDING_DIR = '_待处理';

export interface FileInsight {
  category: string;
  topic: string;
  version: string | null;
  confidence: number;
}

/** 系统提示词按当前分类清单动态拼装（清单来自设置或内置默认） */
function buildSystemPrompt(categories: readonly string[]): string {
  return `你是文件归档助手。根据文件首页内容和原文件名，输出归档所需的字段。

分类必须从以下枚举中严格选择其一（不得自创）：
${categories.join(' / ')}

只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块：
{
  "category": "上述枚举之一",
  "topic": "主题，6~20字中文名词短语，不含日期/版本号/扩展名",
  "version": "文档内出现的版本标识归一化为 v01 形式（如 V2→v02、第三版→v03）；没有则 null",
  "confidence": 0.0 到 1.0 之间的数字
}

规则：
- topic 要能一眼看出这是什么文件，例如「房屋租赁合同」「7月差旅发票」「Q2销售报表」；
- topic 使用中文，不写公司名后缀、不写"扫描件""副本""最终版"等噪音词；
- 不要输出扩展名，不要输出日期；
- 内容太少或无法判断时，confidence 给 0.4 以下。`;
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

/** 归一模型返回的字段：分类越界落清单末位（约定的兜底项），主题清理，置信度夹取 */
function normalizeInsight(obj: Record<string, unknown>, categories: readonly string[]): FileInsight {
  const rawCategory = typeof obj.category === 'string' ? obj.category.trim() : '';
  const fallback = categories[categories.length - 1] ?? '其他';
  const category = categories.includes(rawCategory) ? rawCategory : fallback;
  const topic = (typeof obj.topic === 'string' ? obj.topic : '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '') // 去掉文件名非法字符
    .replace(/\.(pdf|docx?|xlsx?|png|jpe?g|txt|md)$/i, '')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 40);
  const conf = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence) ? obj.confidence : 0.5;
  return {
    category,
    topic,
    version: normalizeVersionLabel(obj.version),
    confidence: Math.min(1, Math.max(0, conf)),
  };
}

/** 单轮调用：文本 or 图片，超时上限 30s */
async function callModel(
  cfg: ResolvedModel,
  userContent: unknown,
  categories: readonly string[],
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
          { role: 'system', content: buildSystemPrompt(categories) },
          { role: 'user', content: userContent },
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
    const content = choice?.message?.content || '';
    const obj = extractJson(content);
    return obj ? normalizeInsight(obj, categories) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** 识别文本类文件（pdf/docx/xlsx/纯文本） */
export function classifyText(
  cfg: ResolvedModel,
  fileName: string,
  text: string,
  categories: readonly string[],
): Promise<FileInsight | null> {
  return callModel(cfg, `原文件名：${fileName}\n\n首页内容：\n${text}`, categories);
}

/** 识别图片 / 扫描件 */
export function classifyImage(
  cfg: ResolvedModel,
  fileName: string,
  dataUrl: string,
  categories: readonly string[],
): Promise<FileInsight | null> {
  return callModel(cfg, [
    { type: 'text', text: `原文件名：${fileName}\n\n这是文件首页的图像，请识别并归档。` },
    { type: 'image_url', image_url: { url: dataUrl } },
  ], categories);
}
