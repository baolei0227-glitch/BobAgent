/**
 * 统一角色凭据解析器
 *
 * 收敛 STT / ImageEdit / OnlineOCR 三个"漏网之鱼"角色的凭据来源：
 *   - 这些角色走非 chat 协议（audio / images / vision），但同一厂商的 API Key 通用；
 *   - 因此 apiKey / baseUrl 不再各自单独配置，而是优先从 Model Pool 同名厂商继承；
 *   - 显式覆盖（角色内高级折叠）仍优先于继承。
 *
 * 解析优先级：
 *   Key:      显式 > Model Pool 对应厂商 > 兜底（如 vision）
 *   BaseUrl:  显式 > Model Pool 对应厂商自定义 > 角色预设 > 兜底（如 vision）
 */

import type { AppSettings } from '../settings';
import type { ProviderType } from '../types';

/** 角色厂商 → Model Pool 厂商映射（角色厂商名与 Model Pool 的 ProviderType 不完全一致） */
const ROLE_TO_POOL: Record<string, ProviderType> = {
  'doubao-stream': 'doubao',
  'doubao': 'doubao',
  'dashscope': 'qwen',
  'qwen': 'qwen',
  'openai': 'openai',
  'siliconflow': 'siliconflow',
  'glm': 'glm',
  'deepseek': 'deepseek',
  'moonshot': 'moonshot',
  'agentplan': 'agentplan',
  'codingplan': 'codingplan',
  // 本地无鉴权厂商：直接映射到同名 Model Pool 厂商（继承自定义 baseUrl / 可选 apiKey）
  'bobmultimodal': 'bobmultimodal',
  'ollama': 'ollama',
};

export interface RoleCredentialInput {
  roleProvider?: string;
  explicitApiKey?: string;
  explicitBaseUrl?: string;
  /** 角色自身的预设地址（如 STT_PROVIDERS[provider].baseUrl） */
  presetBaseUrl?: string;
  /** 兜底 Key（如 vision.apiKey） */
  fallbackApiKey?: string;
  /** 兜底 BaseUrl（如 vision.baseUrl） */
  fallbackBaseUrl?: string;
}

export interface ResolvedRoleCredential {
  apiKey: string;
  baseUrl: string;
  keySource: 'explicit' | 'provider' | 'fallback' | 'missing';
  baseUrlSource: 'explicit' | 'provider' | 'preset' | 'fallback' | 'missing';
  /** 命中的 Model Pool 厂商 */
  poolProvider?: ProviderType;
}

/** 解析单个角色的有效凭据（不读文件，输入 settings 对象即可） */
export function resolveRoleCredential(
  settings: AppSettings,
  input: RoleCredentialInput,
): ResolvedRoleCredential {
  const poolType = input.roleProvider ? ROLE_TO_POOL[input.roleProvider] : undefined;
  const pool = poolType ? (settings.providers ?? []).find((p) => p.type === poolType) : undefined;

  const explicitKey = input.explicitApiKey?.trim();
  const poolKey = pool?.apiKey?.trim();
  const key = explicitKey || poolKey || input.fallbackApiKey?.trim() || '';

  const explicitUrl = input.explicitBaseUrl?.trim();
  const poolUrl = pool?.baseUrl?.trim();
  const url =
    explicitUrl ||
    poolUrl ||
    input.presetBaseUrl?.trim() ||
    input.fallbackBaseUrl?.trim() ||
    '';

  return {
    apiKey: key,
    baseUrl: url,
    keySource: explicitKey ? 'explicit' : poolKey ? 'provider' : input.fallbackApiKey?.trim() ? 'fallback' : 'missing',
    baseUrlSource: explicitUrl
      ? 'explicit'
      : poolUrl
        ? 'provider'
        : input.presetBaseUrl?.trim()
          ? 'preset'
          : input.fallbackBaseUrl?.trim()
            ? 'fallback'
            : 'missing',
    poolProvider: poolType,
  };
}