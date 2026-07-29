import type { VisionConfig, VisionResult, ImageInput, ParseMode } from './types';

export const DEFAULT_VISION_MODEL = 'qwen-vl-max';

export const DEFAULT_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export const VISION_PROMPTS: Record<ParseMode, string> = {
  general:
    '请详细描述这张图片的内容，包括画面主体、场景、文字、颜色、布局等关键信息。',
  document:
    '请识别并转录这张文档图片中的所有文字，保持原始段落和格式，不要遗漏任何可见文字。',
  screenshot:
    '请描述这张截图中显示的内容，包括窗口标题、按钮、输入框、菜单、文字区域等 UI 元素及其状态。',
  chart:
    '请描述这张图表中展示的数据和趋势，包括坐标轴标签、图例、数值、单位以及关键结论。',
  casual: '请简单描述这张图片里有什么。',
};

export function resolvePrompt(config: VisionConfig): string {
  if (config.custom_prompt && config.custom_prompt.trim().length > 0) {
    return config.custom_prompt.trim();
  }
  return VISION_PROMPTS[config.mode] ?? VISION_PROMPTS.general;
}

function resolveImageContent(
  input: ImageInput,
  detailLevel?: VisionConfig['detail_level']
): { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } } {
  if (input.type === 'file') {
    throw new Error(
      '[vision-adapter] 不直接处理文件路径，请在使用前将文件读取为 base64 后传入。'
    );
  }

  const prefix = input.mimeType ? `data:${input.mimeType};base64,` : 'data:image/png;base64,';
  return {
    type: 'image_url',
    image_url: {
      url: `${prefix}${input.data}`,
      detail: detailLevel === 'low' || detailLevel === 'high' ? detailLevel : undefined,
    },
  };
}

export function resolveBaseUrl(config: VisionConfig): string {
  if (config.baseUrl) return config.baseUrl;

  const model = config.model.toLowerCase();
  if (model.startsWith('qwen') || model.includes('vl')) {
    return DEFAULT_QWEN_BASE_URL;
  }
  return undefined as unknown as string;
}

function resolveProvider(model: string): 'openai-compatible' {
  const lower = model.toLowerCase();
  if (
    lower.startsWith('qwen') ||
    lower.startsWith('gpt') ||
    lower.includes('claude') ||
    lower.includes('gemini')
  ) {
    return 'openai-compatible';
  }
  return 'openai-compatible';
}

function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function describeImage(
  input: ImageInput,
  config: VisionConfig
): Promise<VisionResult> {
  const startTime = Date.now();
  const prompt = resolvePrompt(config);
  const provider = resolveProvider(config.model);

  if (provider === 'openai-compatible') {
    return await callOpenAICompatible(input, config, prompt, startTime);
  }

  throw new VisionError(
    'UNSUPPORTED_MODEL',
    `[vision-adapter] 暂不支持的模型: ${config.model}`
  );
}

export class VisionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'VisionError';
  }
}

async function callOpenAICompatible(
  input: ImageInput,
  config: VisionConfig,
  prompt: string,
  startTime: number
): Promise<VisionResult> {
  const { default: OpenAI } = await import('openai');
  const baseUrl = resolveBaseUrl(config);
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: baseUrl,
    dangerouslyAllowBrowser: false,
  });

  const imageContent = resolveImageContent(input, config.detail_level);

  const response = await client.chat.completions.create({
    model: config.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          imageContent,
        ],
      },
    ],
    max_tokens: 4096,
  });

  const choice = response.choices[0];
  const description = choice?.message?.content?.trim() ?? '';
  const duration_ms = Date.now() - startTime;
  const usage = response.usage;

  return {
    description,
    success: description.length > 0,
    duration_ms,
    input_tokens: usage?.prompt_tokens ?? estimateInputTokens(prompt),
    output_tokens: usage?.completion_tokens ?? estimateInputTokens(description),
  };
}

export function createMockVisionResult(
  description: string,
  overrides: Partial<VisionResult> = {}
): VisionResult {
  return {
    description,
    success: true,
    duration_ms: 120,
    input_tokens: 100,
    output_tokens: 50,
    ...overrides,
  };
}