import type { VisionConfig, VisionResult, ImageInput, ParseMode } from './types';

export const DEFAULT_VISION_MODEL = 'qwen-vl-max';

export const DEFAULT_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export const VISION_PROMPTS: Record<ParseMode, string> = {
  general:
    '请详细描述这张图片的内容，包括画面主体、场景、文字、颜色、布局等关键信息。',
  document:
    '请识别并转录这张文档图片中的所有文字，保持原始段落和格式，不要遗漏任何可见文字。\n' +
    '若图片包含手写笔迹（签名、手填日期、手写姓名/数字等），请特别遵守：\n' +
    '1. 手写内容严格逐字转写，禁止凭印象补全、推断或美化；看不清的笔画宁可标「[?]」也不要编造。\n' +
    '2. 长数字串（身份证号、手机号、银行账号、日期）逐位核对，禁止跳位或同音替代。\n' +
    '3. 圆形印章文字按顺时针逐字转写；印章与正文重叠处，印章文字与正文分开标注。\n' +
    '4. 涂改、划痕、污渍处标注「[涂改]」，不猜测原值。',
  screenshot:
    '请描述这张截图中显示的内容，包括窗口标题、按钮、输入框、菜单、文字区域等 UI 元素及其状态。',
  chart:
    '请描述这张图表中展示的数据和趋势，包括坐标轴标签、图例、数值、单位以及关键结论。',
  casual: '请简单描述这张图片里有什么。',
  ledger:
    '你是银行流水/账单表格的逐行转录器。图片是打印版的流水/账单表格（可能包含页眉、表头、多行交易记录、页脚汇总）。\n' +
    '请严格遵守：\n' +
    '1. 逐行精确转录每一笔交易，禁止概括、禁止使用范围描述（如"金额 1000~5000 不等"）、禁止省略任何行。\n' +
    '2. 只输出一个 Markdown 表格，表头固定为：| 日期 | 摘要 | 收入 | 支出 | 余额 |\n' +
    '3. 金额必须精确到分（两位小数），没有金额的列填 0.00；不要留空，不要用"-"。\n' +
    '4. 收入、支出互斥：收入列有值则支出列填 0.00，反之亦然；如原始表中以负数表示支出，请归入支出列并按正数填写。\n' +
    '5. 日期格式统一为 YYYY-MM-DD；无法辨认时填「[识别不清]」。\n' +
    '6. 个别单元格确实无法辨认时，该单元格填「[识别不清]」，严禁编造数字或凭印象补齐。\n' +
    '7. 表头、页脚汇总行（如"第 1 页/共 3 页"、"期末余额"）也请作为表格行转录，摘要列如实写明。\n' +
    '8. 不要输出任何前言、解释或总结，只输出 Markdown 表格。',
  detectAll:
    '你是图像目标检测器。请识别这张图片中所有显著、可独立编辑的目标区域，输出归一化坐标框（bounding box）。\n' +
    '请严格遵守：\n' +
    '1. 只输出一个 JSON 对象，不要任何前言、解释或 markdown 代码块标记。\n' +
    '2. 格式严格为：{"regions":[{"object":"目标英文名","attributes":"视觉特征","bbox":[x1,y1,x2,y2],"confidence":0.9}]}\n' +
    '3. bbox 使用 0~1000 归一化坐标：图片左上角为 (0,0)，右下角为 (1000,1000)，x1 < x2, y1 < y2，取值必须落在 0~1000 范围内。' +
    '（归一化比例与图片实际像素尺寸无关，无论图片被如何缩放都保持位置正确。）\n' +
    '4. 覆盖范围：人物、物体、文字块，以及明显的背景区域（如天空、地面、墙壁、桌面）。\n' +
    '5. object 用简短英文短语（如 "car"、"person"、"background"）；attributes 描述视觉特征（如 "red body, chrome bumper"）。\n' +
    '6. 按视觉显著性从高到低排列，最多返回 15 个区域；过小（小于原图面积约 0.5%）或模糊的目标忽略。\n' +
    '7. 若图片过于简单没有可编辑目标，返回 {"regions":[]}。',
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

/**
 * 视觉模型 failover：按候选列表依次尝试，第一个成功即返回。
 * 单个候选失败（抛错 / 返回空描述）自动尝试下一个；全部失败抛出最后一个错误。
 */
export async function describeImageWithFallback(
  input: ImageInput,
  candidates: VisionConfig[],
): Promise<VisionResult> {
  if (candidates.length === 0) {
    throw new VisionError('NO_VISION_MODEL', '[vision-failover] 没有可用的视觉模型候选');
  }
  let lastError: unknown = null;
  for (const cfg of candidates) {
    try {
      const result = await describeImage(input, cfg);
      if (result.success && result.description.trim().length > 0) {
        return result;
      }
      lastError = new VisionError('EMPTY_DESCRIPTION', `[vision-failover] 模型 ${cfg.model} 返回空描述`);
    } catch (e) {
      lastError = e;
      console.warn(`[vision-failover] 模型 ${cfg.model} 失败，尝试下一个候选:`, e instanceof Error ? e.message : String(e));
    }
  }
  throw lastError instanceof Error ? lastError : new VisionError('ALL_FAILED', '[vision-failover] 所有视觉模型均失败');
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
    // 超时：视觉模型不可用/挂起时快速失败，由上层 failover 换候选模型，避免长时间空等。
    // 默认 30s；detectAll 等重识别任务可通过 config.timeout 放宽（部分模型响应需 60s+）
    timeout: config.timeout ?? 30000,
    // 关键：禁用 SDK 内置重试。SDK 默认 maxRetries=2，超时（30s）后自动重试 2 次，
    // 单次调用实际最长 30s×3=90s+，击穿前端 90s 空闲超时（dispatch 日志中大量 91s
    // "Request timed out." 均由此产生）。超时重试应交由上层 failover 机制（多候选降级），
    // 而不是让 SDK 静默把单次调用拖到近 100s。
    maxRetries: 0,
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
    // max_tokens 8192：单页 OCR 上限从 4096 提升到 8192，避免银行流水等密集表格页
    // 在转录中途被强制截断（4096 token 约 3000-4000 中文字符，只够覆盖 20-30 行表格）
    max_tokens: 8192,
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