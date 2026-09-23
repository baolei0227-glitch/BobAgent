/**
 * 模型配置解析（服务端共用）。
 *
 * 由 /api/ai-edit/markdown 原样抽出，供 /api/md-navigate、/api/md-consistency 等
 * 非流式 AI 路由共用 —— 避免各路由各写一份解析逻辑，导致「Auto 到底解析成哪个模型」口径漂移。
 *
 * 优先级：请求显式 apiKey+baseUrl+providerModelId → 请求 modelId 解析 → chatModel.defaultModel
 *        → chat 池首个 → 首个可用 provider。
 */
import { readSettingsFromFile } from '@/lib/settings-server';
import { getProviderPreset, parseCustomModel, isCustomModel, type ProviderConfig } from '@/lib/types';

/** 请求侧可携带的模型引用字段（各 AI 路由请求体的公共子集） */
export interface ModelRefRequest {
  /** modelId = '' 表示 Auto（走 chatModel.defaultModel，再兜底首个可用）；否则用 isCustomModel('qwen:xxx') 解析 */
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  providerModelId?: string;
}

export interface ResolvedModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 从 settings 解析配置：优先请求自定义，其次按 modelId 解析，兜底首个可用或 chatModel.defaultModel */
export async function resolveModelConfig(req: ModelRefRequest): Promise<ResolvedModelConfig | null> {
  if (req.apiKey && req.baseUrl && req.providerModelId) {
    return { apiKey: req.apiKey, baseUrl: req.baseUrl, model: req.providerModelId };
  }
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = settings.providers || [];
  const chatDefaultPool = settings.chatModel?.pool ?? [];
  const chatDefaultModel = settings.chatModel?.defaultModel;
  // 第一个可用的 provider（兜底用）
  const firstProvider = providers.find((p) => p.apiKey && p.selectedModels?.length);
  const resolveByRef = (ref: string): ResolvedModelConfig | null => {
    if (isCustomModel(ref)) {
      const parsed = parseCustomModel(ref);
      if (!parsed) return null;
      const p = providers.find((c) => c.type === parsed.provider && c.apiKey);
      if (!p) return null;
      const preset = getProviderPreset(p.type);
      return {
        apiKey: p.apiKey,
        baseUrl: p.baseUrl || preset?.baseUrl || '',
        model: parsed.modelId,
      };
    }
    // 非 custom：把 modelId 当 provider+model 的引用名，优先匹配 chat pool 的 (provider,modelId) 组合
    const poolMatch = chatDefaultPool.find((c) => c.modelId === ref);
    if (poolMatch) {
      const p = providers.find((c) => c.type === poolMatch.provider && c.apiKey);
      if (p) {
        const preset = getProviderPreset(p.type);
        return {
          apiKey: p.apiKey,
          baseUrl: p.baseUrl || preset?.baseUrl || '',
          model: poolMatch.modelId,
        };
      }
    }
    // 退化为 firstProvider（provider 类型本身不暴露 provider/modelId 字段）
    if (firstProvider?.apiKey) {
      const preset = getProviderPreset(firstProvider.type);
      return {
        apiKey: firstProvider.apiKey,
        baseUrl: firstProvider.baseUrl || preset?.baseUrl || '',
        model: firstProvider.selectedModels?.[0]?.modelId || ref,
      };
    }
    return null;
  };
  if (req.modelId) {
    const r = resolveByRef(req.modelId);
    if (r) return r;
  }
  // Auto 模式：优先 chatModel.defaultModel，否则 chat 池首个，否则首个 provider
  if (chatDefaultModel) {
    const r = resolveByRef(chatDefaultModel);
    if (r) return r;
  }
  if (chatDefaultPool.length) {
    const p = providers.find((c) => c.type === chatDefaultPool[0].provider && c.apiKey);
    if (p) {
      const preset = getProviderPreset(p.type);
      return {
        apiKey: p.apiKey,
        baseUrl: p.baseUrl || preset?.baseUrl || '',
        model: chatDefaultPool[0].modelId,
      };
    }
  }
  if (firstProvider?.apiKey) {
    const preset = getProviderPreset(firstProvider.type);
    return {
      apiKey: firstProvider.apiKey,
      baseUrl: firstProvider.baseUrl || preset?.baseUrl || '',
      model: firstProvider.selectedModels?.[0]?.modelId || '',
    };
  }
  return null;
}
