/**
 * Web 服务单例 —— 注册内置 provider，并在每次调用时从 settings 读取选择。
 *
 * 新增 provider 只需在这里注册（搜索/抓取各自独立），模型面工具与 Daily News 不用改。
 */
import { WebService } from './service';
import { deepSeekFetchProvider, deepSeekSearchProvider } from './providers/deepseek-api';
import { httpFetchProvider } from './providers/http-fetch';
import type { WebProviderSelection } from './types';

async function loadSelection(): Promise<WebProviderSelection> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    return {
      searchProvider: settings.webSearch?.searchProvider,
      fetchProvider: settings.webSearch?.fetchProvider,
    };
  } catch {
    return {};
  }
}

export const webService = new WebService({
  loadSelection,
  defaultSearchProvider: 'deepseek-search-api',
  defaultFetchProvider: 'deepseek-fetch-api',
});

webService.registerSearchProvider(deepSeekSearchProvider);
webService.registerFetchProvider(deepSeekFetchProvider);
webService.registerFetchProvider(httpFetchProvider);

export { webService as web };
