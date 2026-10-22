/**
 * Web 访问服务 —— provider seam（对齐 DSH `ctx.web` 的最小实现）。
 *
 * 职责边界：
 *   - 本服务只做 provider 选择、执行与错误归一；不发网络请求、不认识厂商。
 *   - 模型面工具（web_search / web_fetch）与 Daily News 只依赖本服务。
 *   - provider 的可用性是廉价的本地检查（如密钥是否存在），每次调用时解析，
 *     因此换 Key / 换 provider 不需要重启，也不依赖注册顺序。
 */
import {
  WebError,
  WEB_PROVIDER_AUTO,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
  type WebProviderSelection,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from './types';

export interface WebServiceOptions {
  /** 每次调用读取 provider 选择（通常来自 settings）；读取失败按空选择处理 */
  loadSelection?: () => Promise<WebProviderSelection>;
  /** 未显式配置时的搜索默认 provider */
  defaultSearchProvider?: string;
  /** 未显式配置时的抓取默认 provider */
  defaultFetchProvider?: string;
}

type AnyProvider = { readonly id: string; isAvailable(): Promise<boolean> };

export class WebService {
  private readonly searchProviders = new Map<string, WebSearchProvider>();
  private readonly fetchProviders = new Map<string, WebFetchProvider>();

  constructor(private readonly options: WebServiceOptions = {}) {}

  registerSearchProvider(provider: WebSearchProvider): void {
    if (this.searchProviders.has(provider.id)) {
      throw new Error(`Duplicate web search provider id: ${provider.id}`);
    }
    this.searchProviders.set(provider.id, provider);
  }

  registerFetchProvider(provider: WebFetchProvider): void {
    if (this.fetchProviders.has(provider.id)) {
      throw new Error(`Duplicate web fetch provider id: ${provider.id}`);
    }
    this.fetchProviders.set(provider.id, provider);
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult> {
    const selection = await this.loadSelection();
    const provider = await this.pick(
      'search',
      this.searchProviders,
      selection.searchProvider,
      this.options.defaultSearchProvider ?? 'deepseek-api',
    );
    try {
      return await provider.search(request);
    } catch (e) {
      throw this.normalizeError(e, provider.id, 'search');
    }
  }

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const selection = await this.loadSelection();
    const provider = await this.pick(
      'fetch',
      this.fetchProviders,
      selection.fetchProvider,
      this.options.defaultFetchProvider ?? 'deepseek-api',
    );
    try {
      return await provider.fetch(request);
    } catch (e) {
      throw this.normalizeError(e, provider.id, 'fetch');
    }
  }

  private async loadSelection(): Promise<WebProviderSelection> {
    try {
      return (await this.options.loadSelection?.()) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * 选择规则：
   *   1. 显式 provider id（非 auto）：必须已注册且可用，否则给出可路由的 code；
   *   2. 未配置：使用该操作的默认 provider（默认 deepseek-api）；
   *   3. auto：按默认 provider → 其余可用 provider 的顺序取第一个；
   *      若默认不可用且仍有多个可用 provider，则明确报 AMBIGUOUS，不猜。
   */
  private async pick<T extends AnyProvider>(
    kind: 'search' | 'fetch',
    providers: Map<string, T>,
    configured: string | undefined,
    defaultId: string,
  ): Promise<T> {
    const wanted = (configured || defaultId).trim();

    if (wanted !== WEB_PROVIDER_AUTO) {
      const provider = providers.get(wanted);
      if (!provider) {
        throw new WebError(
          'WEB_PROVIDER_CONFIGURED_MISSING',
          `Configured web ${kind} provider "${wanted}" is not registered.`,
          wanted,
        );
      }
      if (!(await this.isAvailable(provider))) {
        throw new WebError(
          'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
          `Configured web ${kind} provider "${wanted}" is unavailable (check its credentials / settings).`,
          wanted,
        );
      }
      return provider;
    }

    const available: T[] = [];
    for (const provider of providers.values()) {
      if (await this.isAvailable(provider)) available.push(provider);
    }
    if (available.length === 0) {
      throw new WebError(
        'WEB_PROVIDER_UNAVAILABLE',
        `No web ${kind} provider is available. Configure DeepSeek credentials or choose another provider in Settings → Web.`,
      );
    }

    const preferred = available.find((provider) => provider.id === defaultId);
    if (preferred) return preferred;

    if (available.length > 1) {
      throw new WebError(
        'WEB_PROVIDER_AMBIGUOUS',
        `Multiple web ${kind} providers are available (${available.map((p) => p.id).join(', ')}); set an explicit provider in Settings → Web.`,
      );
    }
    return available[0];
  }

  private async isAvailable(provider: AnyProvider): Promise<boolean> {
    try {
      return await provider.isAvailable();
    } catch {
      // 可用性检查的异常按“不可用”处理；真正执行时由 provider 给出具体错误
      return false;
    }
  }

  private normalizeError(error: unknown, providerId: string, kind: 'search' | 'fetch'): WebError {
    if (error instanceof WebError) return error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return new WebError('WEB_ABORTED', `Web ${kind} aborted.`, providerId);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new WebError('WEB_PROVIDER_ERROR', `${providerId} web ${kind} failed: ${detail}`, providerId);
  }
}

/** 工具层/新闻层统一的错误展示（code 保留给 UI 或调用方路由） */
export function formatWebError(error: unknown): string {
  if (error instanceof WebError) return `Error: [${error.code}] ${error.message}`;
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
