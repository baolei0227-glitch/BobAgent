/**
 * Wanted 模型解析：优先用设置中的 Wanted 小模型，否则降级到已配置的聊天模型。
 * 供 tasks/summarize 与 notebook 等 Wanted 系列 API 共用。
 *
 * 分层回退（依次尝试，命中即用）：
 *   1) chatModel.pool 内第一个可用条目（历史 defaultModel 优先已移除，与 Auto 一致）
 *   2) chatModel 旧式直配（defaultModel + apiKey，无 pool 的旧配置兼容）
 *   3) taskModel（设置 → Wanted 小模型，旧配置仍可能残留）
 *   4) 扫描 providers：第一个 apiKey 非空且勾选了模型的厂商，取其首个勾选模型
 */
import { PROVIDER_PRESETS, type ProviderConfig } from '@/lib/types';
import { readSettingsFromFile } from '@/lib/settings-server';

export interface ResolvedModel {
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** 解析厂商 baseUrl：自定义优先，否则 preset 默认 */
function baseUrlFor(providerType: string, customBaseUrl?: string): string {
  return customBaseUrl
    || PROVIDER_PRESETS.find((p) => p.type === providerType)?.baseUrl
    || '';
}

/** 从 provider 配置解析出一个可用模型（apiKey + 勾选模型 + baseUrl） */
function fromProvider(cfg: ProviderConfig, modelId?: string): ResolvedModel | null {
  if (!cfg.apiKey) return null;
  const selected = cfg.selectedModels ?? [];
  if (selected.length === 0) return null;
  const id = modelId && selected.some((m) => (typeof m === 'string' ? m : m.modelId) === modelId)
    ? modelId
    : (typeof selected[0] === 'string' ? selected[0] : selected[0].modelId);
  return {
    model: id,
    apiKey: cfg.apiKey,
    baseUrl: baseUrlFor(cfg.type, cfg.baseUrl),
  };
}

/**
 * 按 "provider:modelId" 显式指定模型：从已配置 providers 解析该供应商的 apiKey/baseUrl。
 * 供外部 HTTP 客户端（如 Bob WebBridge AI 侧边栏）显式选模型时使用；
 * 目标供应商未配置 / 无 API Key 时返回 null（调用方应给出明确错误而非悄悄降级默认模型）。
 */
export async function resolveProviderModel(providerModelId: string): Promise<ResolvedModel | null> {
  const sep = providerModelId.indexOf(':');
  if (sep <= 0) return null;
  const providerType = providerModelId.slice(0, sep).trim();
  const modelId = providerModelId.slice(sep + 1).trim();
  if (!providerType || !modelId) return null;
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = Array.isArray(settings.providers) ? settings.providers : [];
  const cfg = providers.find((p) => p.type === providerType && !!p.apiKey);
  if (!cfg) return null;
  return { model: modelId, apiKey: cfg.apiKey, baseUrl: baseUrlFor(cfg.type, cfg.baseUrl) };
}

export async function resolveTaskModel(): Promise<ResolvedModel | null> {
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = Array.isArray(settings.providers) ? settings.providers : [];
  const cm = settings.chatModel || {};

  // 1) 主对话候选池 pool（优先）：按条目显式的 provider 匹配正确网关，
  //    与主对话 Auto 选模型路径一致。历史 defaultModel 优先（星标语义）已移除，
  //    直接取 pool 里第一个可用条目。
  //    关键：不能直接信 defaultModel + defaultProvider，因为保存时 defaultProvider 可能
  //    被 resolveRoleFromChat 误判（同名模型出现在多个厂商时取第一个），而 pool 的
  //    provider 才是用户真实选择的网关。
  const pool = Array.isArray(cm.pool) ? cm.pool : [];
  if (pool.length > 0) {
    for (const item of pool) {
      const cfg = providers.find((p) => p.type === item.provider);
      const resolved = cfg ? fromProvider(cfg, item.modelId) : null;
      if (resolved) return resolved;
    }
  }

  // 2) 回退：chatModel 旧式直配（defaultModel + apiKey + baseUrl，无 pool 的旧配置）
  if (cm.apiKey && cm.defaultModel) {
    const providerType =
      (cm.defaultProvider as string) ||
      (cm.defaultModel.includes('deepseek') ? 'deepseek'
        : cm.defaultModel.includes('glm') ? 'glm'
        : cm.defaultModel.includes('moonshot') ? 'moonshot'
        : cm.defaultModel.includes('qwen') ? 'qwen'
        : cm.defaultModel.includes('doubao') ? 'doubao'
        : 'openai');
    return {
      model: cm.defaultModel,
      apiKey: cm.apiKey,
      baseUrl: baseUrlFor(providerType, cm.baseUrl),
    };
  }

  // 3) taskModel（设置 → Wanted 小模型；SettingsModal 保存时已置 undefined，旧配置残留仍可兜底）
  const tm = settings.taskModel || {};
  if (tm.apiKey && tm.defaultModel) {
    const providerType =
      (tm.defaultProvider as string) ||
      (tm.defaultModel.includes('deepseek') ? 'deepseek'
        : tm.defaultModel.includes('glm') ? 'glm'
        : tm.defaultModel.includes('moonshot') ? 'moonshot'
        : tm.defaultModel.includes('qwen') ? 'qwen'
        : tm.defaultModel.includes('doubao') ? 'doubao'
        : 'openai');
    return {
      model: tm.defaultModel,
      apiKey: tm.apiKey,
      baseUrl: baseUrlFor(providerType, tm.baseUrl),
    };
  }

  // 4) 兜底：第一个 apiKey 非空且勾选了模型的厂商
  for (const cfg of providers) {
    const resolved = fromProvider(cfg);
    if (resolved) return resolved;
  }

  return null;
}
