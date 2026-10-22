/**
 * 原生视觉截图解读（Coding 小程序自检用）。
 *
 * 背景：capture_preview 的截图原先统一走 bob-ocr-mcp 的 vision 模型描述，
 * 多一次插件往返、多一个失败点；而 V4.1-Flash 等 coding 模型本身声明了 vision。
 * 这里提供一条「用当前 coding 模型直接看图」的路径，失败时由调用方回退 OCR。
 *
 * 仅服务端使用（OpenAI 兼容 chat.completions + image_url）。
 */
import OpenAI from 'openai';

export interface VisionModelConfig {
  /** 当前请求实际使用的模型 id（providerModelId，如 deepseek-flash） */
  providerModelId: string;
  apiKey: string;
  baseUrl: string;
}

/** 截图自检提示：只描述可验证的视觉事实，不做代码建议（代码建议由主模型自己判断） */
export const PREVIEW_VISION_PROMPT = `You are the visual self-check for a mini-app preview. Look at the screenshot and describe only what is visibly rendered:
1) Overall layout and first-screen composition (header/body/footer, card vs full-width, alignment).
2) Spacing/overflow problems (content cut off, horizontal scroll, cramped inputs, buttons off-screen, text overlapping).
3) Colors/typography consistency (contrast, theme variables, font sizes, numbers not aligned).
4) Visible controls/states (buttons, inputs, empty state, loading/error text).
5) Any obvious rendering defect (blank area, broken image, unstyled native control).
Be concrete and concise (<= 8 short lines). Do not invent functionality you cannot see. If the page is blank or clearly broken, say exactly that first.`;

/**
 * 用当前 coding 模型直接解读截图。成功返回文本；不可用/失败返回 null（调用方回退 OCR）。
 */
export async function describeImageWithVisionModel(
  dataUrl: string,
  prompt: string,
  cfg: VisionModelConfig,
): Promise<string | null> {
  if (!cfg.apiKey || !cfg.providerModelId || !dataUrl) return null;
  try {
    const client = new OpenAI({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      timeout: 60_000,
      maxRetries: 0,
    });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
    const resp = await client.chat.completions.create({
      model: cfg.providerModelId,
      messages: [{ role: 'user', content }],
      max_tokens: 800,
    });
    const text = resp.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}
