/**
 * 提供商解析运行时函数 —— 从 types.ts 抽离
 *
 * 原先与类型声明、厂商数据混杂在 types.ts，
 * 抽离后类型消费者不再因 import 类型而拉入这些函数及依赖（inferModelSpec 等）。
 */
import type { ProviderType, ProviderConfig, AvailableModel, ProviderPreset } from '../types';
import { PROVIDER_PRESETS, PROVIDER_VENDOR } from './presets';
import { inferModelSpec } from '../model-matcher';

/** 常见的 OpenAI 兼容端点后缀（Base URL 输入框只应存网关根，不应含端点路径） */
const ENDPOINT_SUFFIX_RE = /\/(chat\/completions|completions|responses|embeddings|models|images\/generations|audio\/transcriptions|services\/tts)\/?$/i;

/** 清理 Base URL：去掉误存的 API 端点后缀（用户粘贴完整 URL / 历史版本自动填充），
 * 只保留网关根地址（如 https://ark.cn-beijing.volces.com/api/plan/v3）。
 * 空值返回 ''；无后缀时按原样 trim + 去尾部斜杠。 */
export function sanitizeBaseUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(ENDPOINT_SUFFIX_RE, '');
}

/** 获取所有可用模型（已配置提供商的勾选模型），用于模型选择器 */
export function getAvailableModels(
  providerConfigs: ProviderConfig[],
): AvailableModel[] {
  const result: AvailableModel[] = [];

  for (const preset of PROVIDER_PRESETS) {
    const config = providerConfigs.find((c) => c.type === preset.type);
    if (!config) continue;
    const selected = config.selectedModels ?? [];
    for (const sel of selected) {
      const modelId = typeof sel === 'string' ? sel : sel.modelId;
      if (!modelId) continue;
      const isThinking = typeof sel === 'string' ? true : sel.thinking;
      const presetModel = preset.models.find((m) => m.modelId === modelId);
      if (presetModel) {
        result.push({
          group: preset.label,
          modelId: `${preset.type}:${presetModel.modelId}`,
          label: presetModel.label,
          description: presetModel.description,
          thinking: isThinking,
          temperature: presetModel.temperature,
          spec: presetModel.spec,
          vendor: PROVIDER_VENDOR[preset.type],
        });
      } else {
        const spec = inferModelSpec(modelId, isThinking);
        result.push({
          group: preset.label,
          modelId: `${preset.type}:${modelId}`,
          label: modelId,
          description: isThinking ? '推理模型' : '对话模型',
          thinking: isThinking,
          temperature: isThinking ? 1.0 : 0.7,
          spec,
          vendor: PROVIDER_VENDOR[preset.type],
        });
      }
    }
  }

  return result;
}

/** 判断模型 ID 是否为自定义提供商模型 */
export function isCustomModel(modelId: string): boolean {
  return modelId.includes(':');
}

/** 从模型 ID 解析提供商类型和实际模型 ID */
export function parseCustomModel(modelId: string): { provider: ProviderType; modelId: string } | null {
  const idx = modelId.indexOf(':');
  if (idx === -1) return null;
  const provider = modelId.slice(0, idx) as ProviderType;
  const id = modelId.slice(idx + 1);
  return { provider, modelId: id };
}

/** 根据提供商类型获取预设信息 */
export function getProviderPreset(type: ProviderType): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.type === type);
}
