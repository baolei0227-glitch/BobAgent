/**
 * DeepSeek Search / Fetch API provider —— `deepseek-search-api` / `deepseek-fetch-api`。
 *
 * 直连官方 `POST /v1/tools/search` 与 `POST /v1/tools/fetch`：
 *   - 一次操作一次请求，不消耗辅助模型轮次；
 *   - Search 一次可带回摘要 / 正文（`need_content`），正文用于 Daily News；
 *   - 凭据优先取设置里的 DeepSeek 厂商 Key，其次 `DEEPSEEK_API_KEY`；
 *   - 鉴权、QPS 排队、超时与错误映射都收在本 provider，调用方只看到 WebError。
 */
import { recordWebToolUsage } from '@/lib/usage';
import {
  WebError,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from '../types';

const DEEPSEEK_DEFAULT_BASE = 'https://api.deepseek.com';
const DEEPSEEK_TIMEOUT_MS = 25_000;
/** 账号级 Search / Fetch 各 5 QPS —— 本进程按 210ms 间隔排队，避免多 Agent / 新闻并发时自己打自己 429 */
const DEEPSEEK_MIN_INTERVAL_MS = 210;
const DEFAULT_SEARCH_COUNT = 5;

let nextSearchSlotAt = 0;
let nextFetchSlotAt = 0;

interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
}

interface RawSearchItem {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string | null;
  date?: string | null;
  authority?: number;
  rerank_score?: number;
}

/** 从设置读取 DeepSeek 厂商 Key（Search / Fetch 与聊天共用同一个 Key）；未配置回退到环境变量 */
async function resolveConfig(): Promise<DeepSeekConfig | null> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    const provider = settings.providers?.find((p) => p.type === 'deepseek' && p.apiKey?.trim());
    if (provider) {
      return {
        apiKey: provider.apiKey.trim(),
        baseUrl: (provider.baseUrl?.trim() || DEEPSEEK_DEFAULT_BASE).replace(/\/+$/, ''),
      };
    }
  } catch {
    /* 设置读取失败时回退到环境变量 */
  }
  const envKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!envKey) return null;
  const envBase = (process.env.DEEPSEEK_SEARCH_BASE_URL || DEEPSEEK_DEFAULT_BASE).trim();
  return { apiKey: envKey, baseUrl: envBase.replace(/\/+$/, '') };
}

/** 端点拼接：兼容 baseUrl 填 `https://api.deepseek.com`、`.../v1`、`.../v1/tools` 三种写法 */
function toolsEndpoint(baseUrl: string, tool: 'search' | 'fetch'): string {
  const root = baseUrl.replace(/\/+$/, '');
  const tools = /\/tools$/i.test(root)
    ? root
    : /\/v1$/i.test(root)
      ? `${root}/tools`
      : `${root}/v1/tools`;
  return `${tools}/${tool}`;
}

/**
 * 账号级 QPS 排队：**同步**占用下一个时间槽再 await，保证并发调用拿到互不重叠的槽位。
 * Search 与 Fetch 是两条独立限速，分别计数。
 */
async function waitForSlot(kind: 'search' | 'fetch'): Promise<void> {
  const now = Date.now();
  if (kind === 'search') {
    const slot = Math.max(now, nextSearchSlotAt);
    nextSearchSlotAt = slot + DEEPSEEK_MIN_INTERVAL_MS;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  } else {
    const slot = Math.max(now, nextFetchSlotAt);
    nextFetchSlotAt = slot + DEEPSEEK_MIN_INTERVAL_MS;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

/** HTTP 状态码 → 可执行的中文错误（4xx 不重试；429/5xx 提示稍后重试） */
function httpErrorMessage(kind: 'search' | 'fetch', status: number, detail?: string): string {
  const label = kind === 'search' ? 'Search' : 'Fetch';
  const suffix = detail ? `（${detail.slice(0, 200)}）` : '';
  switch (status) {
    case 400:
      return `DeepSeek ${label} 请求参数不合法${suffix}`;
    case 401:
      return `DeepSeek API Key 缺失或无效，请在 设置 → 模型 中检查 DeepSeek Key${suffix}`;
    case 402:
      return `DeepSeek 账号余额不足，${label} 按成功请求计费，请充值后重试${suffix}`;
    case 403:
      return kind === 'fetch'
        ? `DeepSeek Fetch 被目标站点安全策略拒绝（可改用本地 HTTP 抓取或浏览器工具）${suffix}`
        : `DeepSeek Search 请求被拒绝${suffix}`;
    case 404:
      return kind === 'fetch'
        ? `DeepSeek 未取到该网页的可用正文（URL 不可用 / 被站点拦截 / 无可提取内容）${suffix}`
        : `DeepSeek Search 未返回可用结果${suffix}`;
    case 408:
      return 'DeepSeek 读取请求体超时，请稍后重试';
    case 413:
      return '请求体超过 DeepSeek 大小限制';
    case 429:
      return `DeepSeek ${label} 触发限速（账号级 5 QPS），请稍后重试${suffix}`;
    default:
      if (status >= 500) return `DeepSeek 服务临时不可用（HTTP ${status}），请稍后重试${suffix}`;
      return `DeepSeek ${label} 请求失败（HTTP ${status}）${suffix}`;
  }
}

/** 统一调用 DeepSeek 工具接口：排队 → 25s 超时 → 错误映射；异常一律转 WebError */
async function postTool<T>(
  kind: 'search' | 'fetch',
  config: DeepSeekConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  await waitForSlot(kind);

  const timeout = AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let resp: Response;
  try {
    resp = await fetch(toolsEndpoint(config.baseUrl, kind), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (e) {
    if (signal?.aborted) throw new WebError('WEB_ABORTED', `DeepSeek ${kind} aborted.`);
    if (combined.aborted) {
      throw new WebError('WEB_PROVIDER_ERROR', `DeepSeek ${kind} 请求超时（${DEEPSEEK_TIMEOUT_MS / 1000}s）`);
    }
    throw new WebError(
      'WEB_PROVIDER_ERROR',
      `DeepSeek ${kind} 网络请求失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const payload = (await resp.json()) as { error?: { message?: string } };
      detail = payload?.error?.message || '';
    } catch {
      /* 错误体不是 JSON，忽略详情 */
    }
    throw new WebError('WEB_PROVIDER_ERROR', httpErrorMessage(kind, resp.status, detail));
  }

  try {
    return (await resp.json()) as T;
  } catch {
    throw new WebError('WEB_PROVIDER_ERROR', `DeepSeek ${kind} 返回了非 JSON 响应`);
  }
}

function normalizeSource(item: RawSearchItem): WebSearchSource {
  return {
    title: (item.title || '').trim() || 'Untitled',
    url: (item.url || '').trim(),
    snippet: (item.snippet || '').trim(),
    summary: (item.summary || '').trim(),
    content: (item.content || '').trim(),
    siteName: item.site_name ?? null,
    publishedAt: item.date ?? null,
    authority: typeof item.authority === 'number' ? item.authority : -1,
  };
}

export const deepSeekSearchProvider: WebSearchProvider = {
  id: 'deepseek-search-api',

  async isAvailable(): Promise<boolean> {
    return (await resolveConfig()) !== null;
  },

  async search(request: WebSearchRequest): Promise<WebSearchResult> {
    const query = request.query.trim();
    if (!query) throw new WebError('WEB_PROVIDER_ERROR', 'Search query 不能为空');

    const config = await resolveConfig();
    if (!config) {
      throw new WebError('WEB_PROVIDER_CREDENTIAL_MISSING', '未配置 DeepSeek API Key（设置 → 模型，或 DEEPSEEK_API_KEY）。');
    }

    const count = Math.min(50, Math.max(1, Math.trunc(request.count ?? DEFAULT_SEARCH_COUNT)));
    const data = await postTool<{ results?: RawSearchItem[] }>(
      'search',
      config,
      { query, count, need_content: request.needContent === true },
      request.signal,
    );
    const raw = data.results ?? [];

    // 按次计费：仅「200 且 results 非空」计费，空结果 / 失败 / 超时都不计费
    if (raw.length > 0) {
      recordWebToolUsage({ tool: 'search', provider: 'deepseek-search-api', ...request.billing }).catch(() => {});
    }

    return {
      provider: 'deepseek-search-api',
      sources: raw.filter((item): item is RawSearchItem => !!item?.url).map(normalizeSource),
    };
  },
};

export const deepSeekFetchProvider: WebFetchProvider = {
  id: 'deepseek-fetch-api',

  async isAvailable(): Promise<boolean> {
    return (await resolveConfig()) !== null;
  },

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const target = request.url.trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new WebError('WEB_INVALID_URL', '请输入合法的 http(s):// URL');
    }

    const config = await resolveConfig();
    if (!config) {
      throw new WebError('WEB_PROVIDER_CREDENTIAL_MISSING', '未配置 DeepSeek API Key（设置 → 模型，或 DEEPSEEK_API_KEY）。');
    }

    const data = await postTool<{ title?: string; content?: string }>(
      'fetch',
      config,
      { url: target },
      request.signal,
    );
    const title = (data.title || '').trim();
    const content = (data.content || '').trim();
    if (!content) {
      throw new WebError('WEB_PROVIDER_ERROR', `DeepSeek 未返回该网页的 Markdown 正文${title ? `（标题：${title}）` : ''}`);
    }

    // 按次计费：Fetch 只有取到正文（HTTP 200 + content 非空）才计费
    recordWebToolUsage({ tool: 'fetch', provider: 'deepseek-fetch-api', ...request.billing }).catch(() => {});

    return {
      provider: 'deepseek-fetch-api',
      requestedUrl: target,
      finalUrl: target,
      statusCode: 200,
      title,
      markdown: content,
      truncated: false,
    };
  },
};
