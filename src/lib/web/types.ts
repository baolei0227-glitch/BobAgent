/**
 * Web 访问词汇 —— 模型面工具、Daily News 与 provider 之间的稳定契约。
 *
 * 设计对齐 DSH 的 web seam：调用方只依赖这里的请求/结果类型与 `WebError`，
 * 不依赖任何具体厂商；provider 负责鉴权、传输与结果归一。
 */

/** 计费归属（可选）：按次计费的 provider 用它把费用记到对应项目 / 节点；缺省记为无项目归属（全局） */
export interface WebBillingContext {
  projectRoot?: string;
  projectId?: string | null;
  nodeId?: string;
}

/** 单次搜索请求 */
export interface WebSearchRequest {
  query: string;
  /** 期望条数（provider 可自行设默认/上限） */
  count?: number;
  /** 是否在同一请求里带回网页正文（DeepSeek Search 支持；HTTP 搜索 provider 可忽略） */
  needContent?: boolean;
  signal?: AbortSignal;
  /** 计费归属（仅按次计费的 provider 使用） */
  billing?: WebBillingContext;
}

/** 一条搜索来源 */
export interface WebSearchSource {
  title: string;
  url: string;
  /** 前端短摘要（用于卡片） */
  snippet: string;
  /** 长摘要（用于模型阅读） */
  summary: string;
  /** 网页正文；未请求或不可用时为空串 */
  content: string;
  siteName: string | null;
  /** RFC 3339；未知为 null */
  publishedAt: string | null;
  /** 0–4；-1 表示未知 */
  authority: number;
}

export interface WebSearchResult {
  provider: string;
  sources: WebSearchSource[];
}

export interface WebFetchRequest {
  url: string;
  signal?: AbortSignal;
  /** 计费归属（仅按次计费的 provider 使用） */
  billing?: WebBillingContext;
}

export interface WebFetchResult {
  provider: string;
  requestedUrl: string;
  /** 跟随重定向后的最终 URL */
  finalUrl: string;
  /** HTTP 状态码；非 2xx 也作为结果返回（页面状态属于数据） */
  statusCode: number;
  title: string;
  markdown: string;
  truncated: boolean;
}

export interface WebSearchProvider {
  readonly id: string;
  /** 廉价的本地检查（如密钥是否存在），不应发起网络请求 */
  isAvailable(): Promise<boolean>;
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}

export interface WebFetchProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  fetch(request: WebFetchRequest): Promise<WebFetchResult>;
}

/**
 * 稳定的错误码 —— 调用方按 code 路由，不解析 message。
 * 命名与 DSH web seam 对齐，额外保留 provider 专有失败的兜底值。
 */
export type WebErrorCode =
  | 'WEB_PROVIDER_UNAVAILABLE'
  | 'WEB_PROVIDER_CONFIGURED_MISSING'
  | 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'WEB_PROVIDER_AMBIGUOUS'
  | 'WEB_PROVIDER_CREDENTIAL_MISSING'
  | 'WEB_PROVIDER_ERROR'
  | 'WEB_INVALID_URL'
  | 'WEB_BLOCKED_URL'
  | 'WEB_FETCH_TOO_LARGE'
  | 'WEB_FETCH_TIMEOUT'
  | 'WEB_REDIRECT_BLOCKED'
  | 'WEB_UNSUPPORTED_CONTENT_TYPE'
  | 'WEB_ABORTED';

export class WebError extends Error {
  readonly code: WebErrorCode;
  readonly provider?: string;

  constructor(code: WebErrorCode, message: string, provider?: string) {
    super(message);
    this.name = 'WebError';
    this.code = code;
    this.provider = provider;
  }
}

/** 设置里的 provider 选择值；`auto` = 按服务默认优先级挑第一个可用 provider */
export const WEB_PROVIDER_AUTO = 'auto';

export interface WebProviderSelection {
  searchProvider?: string;
  fetchProvider?: string;
}
