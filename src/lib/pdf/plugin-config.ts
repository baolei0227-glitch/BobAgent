/**
 * bob-ocr-mcp 插件配置读取器（BobWork 回退引擎用）
 *
 * 识别配置（GLM-OCR / Online OCR）以插件数据根 config.json 为单一来源
 * （BobWork 托管时位于 <APP_ROOT>/extensions/bob-ocr-mcp/config.json）。
 * BobWork 本地回退引擎（MCP 不可用时的兜底链路）读取本模块，保证与插件配置一致，
 * 不再读取 BobWork settings 中已弃用的 glmOcr / onlineOcr 字段。
 *
 * 兼容说明：apiKey 可能是明文或 enc::v1:: 密文（BobWork 机器指纹 AES-GCM），
 * 统一经 decryptSecret 解密为明文后返回。
 */

import { join } from 'path';
import { promises as fs } from 'fs';
import { pluginDataHome } from '@/lib/extensions/data-home';
import { decryptSecret } from '@/lib/secrets';

// OCR 插件数据统一在 ~/BobWork/extensions/bob-ocr-mcp（旧 ~/.bob-ocr-mcp 已废弃）
const OCR_MCP_CONFIG_PATH = join(pluginDataHome('bob-ocr-mcp'), 'config.json');

export interface PluginGlmOcrCfg {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  strategy?: 'fallback' | 'always';
  priority?: 'glm-first' | 'glm-force';
}

export interface PluginOnlineOcrCfg {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
  strategy?: 'fallback' | 'always';
}

export interface PluginProviderCfg {
  type: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface PluginOcrConfig {
  glmOcr?: PluginGlmOcrCfg;
  onlineOcr?: PluginOnlineOcrCfg;
  providers?: PluginProviderCfg[];
}

/** 读取插件配置并解密 apiKey；文件不存在/损坏返回 null（调用方回退 BobWork settings） */
export async function loadPluginOcrConfig(): Promise<PluginOcrConfig | null> {
  try {
    const raw = JSON.parse(await fs.readFile(OCR_MCP_CONFIG_PATH, 'utf8')) as {
      glmOcr?: Partial<PluginGlmOcrCfg>;
      onlineOcr?: Partial<PluginOnlineOcrCfg>;
      providers?: Array<Partial<PluginProviderCfg>>;
    };
    const out: PluginOcrConfig = {};
    if (raw.glmOcr && typeof raw.glmOcr === 'object') {
      out.glmOcr = {
        enabled: raw.glmOcr.enabled === true,
        apiKey: decryptSecret(raw.glmOcr.apiKey) ?? raw.glmOcr.apiKey,
        baseUrl: raw.glmOcr.baseUrl,
        strategy: raw.glmOcr.strategy === 'always' ? 'always' : 'fallback',
        priority: raw.glmOcr.priority === 'glm-force' ? 'glm-force' : 'glm-first',
      };
    }
    if (raw.onlineOcr && typeof raw.onlineOcr === 'object') {
      out.onlineOcr = {
        model: raw.onlineOcr.model,
        apiKey: decryptSecret(raw.onlineOcr.apiKey) ?? raw.onlineOcr.apiKey,
        baseUrl: raw.onlineOcr.baseUrl,
        provider: raw.onlineOcr.provider,
        strategy: raw.onlineOcr.strategy === 'always' ? 'always' : 'fallback',
      };
    }
    if (Array.isArray(raw.providers)) {
      out.providers = raw.providers
        .filter((p): p is Partial<PluginProviderCfg> => !!p && typeof p === 'object' && typeof p.type === 'string')
        .map((p) => ({
          type: p.type as string,
          apiKey: decryptSecret(p.apiKey) ?? p.apiKey,
          baseUrl: p.baseUrl,
        }));
    }
    return out;
  } catch {
    return null;
  }
}
