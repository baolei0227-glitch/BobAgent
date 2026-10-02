/**
 * 重排（rerank）客户端 —— 第二段精排用，服务端 only。
 *
 * ⚠ **模型 id 的坑（2026-10-01 实测）**：`lib/providers/presets.ts` 里 glm 的两个条目
 * `rerank-3` / `rerank-plus` **在智谱侧不存在**，直接调用会返回
 * `HTTP 400 {"code":"1211","message":"模型不存在，请检查模型代码。"}`。
 * 实测唯一可用的是 **`rerank`**。所以这里默认用 `rerank`，不跟随 preset 的 modelId；
 * preset 本身要不要改是产品决定（那个 id 会显示在设置界面里）。
 *
 * ⚠ **分数不可当阈值用**：实测给明显无关的文档（"如何选购跑步鞋"）打 **0.9964**，
 * 给相关文档打 1.0 —— 分数被压得很扁，只有**排序**有意义，
 * 不要写 `score > 0.5 就保留` 这类判断。
 *
 * ⚠⚠ **更要紧的是：这个模型的分数几乎没有区分度，实测不能用**（2026-10-01）：
 *   - 51 篇候选：**全部 1.0000**（极差 0.0000）；
 *   - 8 篇（4 相关 + 4 无关）：7 篇 1.0000、1 篇 0.9964（极差 0.0036）；
 *   - 4 篇：同上（极差 0.0036）—— 它只能把"跑步鞋"这种彻底跑题的挑出来，
 *     同一领域内（都属法律/破产）**不区分**。
 *   直接后果：拿它的分数排序 = 拿输入原序当排序，任何"rerank 提升了 X%"都是假象
 *   （本仓库的 scripts/eval-rerank-ab.ts 第一版就撞上这个，见那里的告警）。
 *   所以调用方**必须**先过 `isDegenerateScores()`，退化就当"没有重排能力"处理。
 *
 * 端点契约（智谱 `/api/paas/v4/rerank`）：
 *   POST { model, query, documents: string[], top_n? } → { results: [{ index, relevance_score }] }
 * `index` 是 **documents 数组里的下标**（服务端会按分数降序返回）。
 */
import { readSettingsFromFile } from '@/lib/settings-server';
import { getProviderPreset } from '@/lib/types';

export interface RerankConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 来自哪个 provider（便于日志与排错） */
  provider: string;
}

/** 默认走 glm（智谱）：目前仓库 preset 里唯一提供了 rerank 条目的 provider */
const DEFAULT_PROVIDER = 'glm';
/** 实测唯一存在的 rerank 模型 id（**不是** preset 里写的 rerank-3） */
const DEFAULT_MODEL = 'rerank';

/**
 * 解析 rerank 配置。`readSettingsFromFile()` 返回的 apiKey **已解密**（应用由此可用），
 * 所以这里不碰 secrets 模块。
 */
export async function resolveRerankConfig(opts?: {
  provider?: string;
  model?: string;
}): Promise<RerankConfig | null> {
  const provider = opts?.provider ?? DEFAULT_PROVIDER;
  const settings = await readSettingsFromFile();
  const p = (settings.providers ?? []).find((x) => x.type === provider && x.apiKey);
  if (!p?.apiKey) return null;
  // 用 p.type（已收窄为 ProviderType）而不是入参的 string，避免为一个查表做类型断言
  const baseUrl = (p.baseUrl || getProviderPreset(p.type)?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  return { baseUrl, apiKey: p.apiKey, model: opts?.model ?? DEFAULT_MODEL, provider: p.type };
}

/**
 * 分数是否退化（几乎没有区分度）。
 *
 * 实测这个模型会给出"全是 1.0"的分数 —— 那种情况下排序等于原序，
 * **静默使用会得出完全错误的结论**（"rerank 把召回从 5 篇提到 7 篇"其实是 pool 原序的功劳）。
 * 阈值取 0.01：正常重排的分数极差通常在 0.1 量级以上。
 */
export function isDegenerateScores(results: RerankResult[]): boolean {
  if (results.length < 2) return true;
  const scores = results.map((r) => r.score);
  return Math.max(...scores) - Math.min(...scores) < 0.01;
}

export interface RerankResult {
  /** documents 里的下标 */
  index: number;
  score: number;
}

/**
 * 对一批文档重排，返回**全部**命中的相关性分数（不一定只有 top_n 条）。
 *
 * 为什么返回全部而不是只回 top_n：上游要自己决定"取几条"（例如先取 12 篇做召回、
 * 再从中挑 3 篇精读），只回 3 条就没法做这个决策。
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  opts?: { topN?: number; config?: RerankConfig },
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];
  const cfg = opts?.config ?? (await resolveRerankConfig());
  if (!cfg) throw new Error('没有可用的 rerank 配置（provider 未配置 apiKey？）');

  const res = await fetch(`${cfg.baseUrl}/rerank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      query,
      documents,
      // 不传 top_n 就拿全量（服务端仍按分数降序返回）
      ...(opts?.topN ? { top_n: opts.topN } : {}),
    }),
  });
  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`rerank 调用失败 (HTTP ${res.status}): ${txt}`);
  }
  const data = (await res.json()) as { results?: Array<{ index?: number; relevance_score?: number }> };
  return (data.results ?? [])
    .filter((r): r is { index: number; relevance_score: number } => typeof r.index === 'number')
    .map((r) => ({ index: r.index, score: typeof r.relevance_score === 'number' ? r.relevance_score : 0 }))
    .sort((a, b) => b.score - a.score);
}
