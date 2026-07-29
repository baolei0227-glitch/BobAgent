export type ModelCategory = 'llm' | 'vision' | 'embedding';

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  category: ModelCategory;
  baseUrl?: string;
  apiKey?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  defaultBaseUrl?: string;
  requireApiKey: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', requireApiKey: true },
  { id: 'qwen', name: '阿里通义千问', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', requireApiKey: true },
  { id: 'anthropic', name: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', requireApiKey: true },
  { id: 'openrouter', name: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api/v1', requireApiKey: true },
];

export const BUILT_IN_MODELS: ModelConfig[] = [
  { id: 'qwen-vl-max', name: '通义千问 VL Max', provider: 'qwen', category: 'vision' },
  { id: 'qwen-vl-plus', name: '通义千问 VL Plus', provider: 'qwen', category: 'vision' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', category: 'vision' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', category: 'vision' },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'anthropic', category: 'vision' },

  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', category: 'llm' },
  { id: 'qwen-turbo', name: '通义千问 Turbo', provider: 'qwen', category: 'llm' },
  { id: 'qwen-max', name: '通义千问 Max', provider: 'qwen', category: 'llm' },
];

export function getVisionModels(): ModelConfig[] {
  return BUILT_IN_MODELS.filter((m) => m.category === 'vision');
}

export function getModelById(id: string): ModelConfig | undefined {
  return BUILT_IN_MODELS.find((m) => m.id === id);
}

export function getDefaultBaseUrl(providerId: string): string | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === providerId)?.defaultBaseUrl;
}