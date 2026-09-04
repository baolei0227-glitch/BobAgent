/**
 * 图像 AI 通用配置：图生图（编辑）与文生图（生成）共用同一套模型配置解析。
 *
 * 模型配置来自「设置 → 角色派发 → 图像编辑模型」（imageEdit），与聊天模型独立。
 * 图生图走 images API（multipart / i2i），文生图走 images.generations，二者共享厂商地址与凭据继承逻辑。
 */
import type { AppSettings } from '../settings';
import { findProviderForModel, getImageModelCandidates } from '../settings';
import { resolveRoleCredential } from './role-credential';

/** 图像 AI 厂商 baseUrl 预设（与聊天模型同域，走 OpenAI 兼容 images 接口） */
export const IMAGE_EDIT_PRESETS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  agentplan: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  codingplan: 'https://ark.cn-beijing.volces.com/api/coding/v3',
  // 本地无鉴权多模态服务（MLX，OpenAI 兼容 images API）
  bobmultimodal: 'http://127.0.0.1:8080/v1',
};

/** 本地无鉴权图像厂商（无需 API Key，OpenAI 兼容 images API，如 BobMultimodal / Ollama） */
export const NO_AUTH_IMAGE_PROVIDERS = new Set(['bobmultimodal', 'ollama']);

/** 解析出的图像 AI 配置（含同 Key 下多模型候选池） */
export interface ResolvedImageConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  pool: string[];
}

/**
 * 解析图像 AI 模型配置（含同 Key 下多模型候选池）：
 *  1. 请求内联 model（前端切换模型）：仅换 model，Key/BaseUrl 仍用 settings（或请求内联覆盖）；
 *     模型所属厂商从 imageEdit.pool → Model Pool（providers）→ 请求/设置 provider 依次反查；
 *  2. 否则 settings.imageEdit 默认模型 + 全部图像候选（pool/selectedModels/Model Pool 绑定）作为 fallback 候选池。
 */
export async function resolveImageConfig(
  settings: AppSettings,
  req: { provider?: string; model?: string; apiKey?: string; baseUrl?: string },
): Promise<ResolvedImageConfig | null> {
  const cfg = settings.imageEdit;

  // 请求内联 model：前端切换模型 → 从角色池 / Model Pool 反查 provider，按实际厂商解析凭据
  if (req.model) {
    const hasOwnKey = !!req.apiKey;

    // 从 imageEdit 角色池查找模型所属厂商；未进角色池时再查 Model Pool（providers）绑定
    const poolEntry = (cfg?.pool ?? []).find((p) => p.modelId === req.model);
    const providerEntry = findProviderForModel(settings, req.model);
    const modelProvider = poolEntry?.provider || providerEntry?.type || req.provider || cfg?.provider || '';

    // 按模型实际厂商解析凭据（若与 settings.provider 不同，不用 settings 的 key）
    const cred = resolveRoleCredential(settings, {
      roleProvider: modelProvider,
      explicitApiKey: cfg?.apiKey,
      explicitBaseUrl: cfg?.baseUrl,
      presetBaseUrl: IMAGE_EDIT_PRESETS[modelProvider] || '',
    });

    // 本地无鉴权厂商（bobmultimodal/ollama）无需 API Key 即可使用
    if (hasOwnKey || cred.apiKey || NO_AUTH_IMAGE_PROVIDERS.has(modelProvider)) {
      return {
        provider: modelProvider,
        apiKey: hasOwnKey ? req.apiKey! : cred.apiKey,
        baseUrl: req.baseUrl || (hasOwnKey ? '' : cred.baseUrl) || IMAGE_EDIT_PRESETS[modelProvider] || '',
        model: req.model,
        pool: [],
      };
    }
  }

  // 默认模型：settings.imageEdit.model；为空时从全部图像候选（角色池 / Model Pool 绑定）兜底取首个
  const allCandidates = getImageModelCandidates(settings);
  const model = cfg?.model?.trim() || allCandidates[0] || '';
  if (!model) return null;

  // 厂商：settings.provider → 角色池内该模型所属厂商 → Model Pool 绑定厂商
  const providerKey = cfg?.provider
    || cfg?.pool?.find((p) => p.modelId === model)?.provider
    || findProviderForModel(settings, model)?.type
    || '';

  const cred = resolveRoleCredential(settings, {
    roleProvider: providerKey,
    explicitApiKey: cfg?.apiKey,
    explicitBaseUrl: cfg?.baseUrl,
    presetBaseUrl: IMAGE_EDIT_PRESETS[providerKey] || '',
  });
  // 本地无鉴权厂商无需 API Key；云端厂商必须有 Key
  if (!cred.apiKey && !NO_AUTH_IMAGE_PROVIDERS.has(providerKey)) return null;

  // 同厂商候选池（同一 provider/Key/BaseUrl 才能共享凭据做 fallback），排除默认模型本身
  const pool = allCandidates.filter((s) => {
    if (s === model) return false;
    const p = cfg?.pool?.find((x) => x.modelId === s)?.provider || findProviderForModel(settings, s)?.type || '';
    return p === providerKey;
  });

  return {
    provider: providerKey,
    apiKey: cred.apiKey,
    baseUrl: cred.baseUrl || IMAGE_EDIT_PRESETS[providerKey] || '',
    model,
    pool,
  };
}