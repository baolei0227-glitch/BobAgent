/**
 * AI 文生图接口：纯文本提示生成新图片（OpenAI 兼容 images.generations 多厂商）
 *
 * 模型配置与图像编辑共用「设置 → 角色派发 → 图像编辑模型」（imageEdit），
 * 该模型若同时支持文生图（如 doubao seedream、gpt-image-1、qwen-image、siliconflow 等）即可直接使用。
 *
 * 响应为非流式 JSON（轻量单轮调用）。
 */
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { readSettingsFromFile } from '@/lib/settings-server';
import { IMAGE_EDIT_PRESETS, NO_AUTH_IMAGE_PROVIDERS, resolveImageConfig } from '@/lib/models/image-config';

interface ImageGenerateRequest {
  /** 生成提示（自然语言描述目标图片内容） */
  prompt: string;
  /** 输出尺寸（如 "1024x1024"）；缺省按 clampDim 归一化后的默认值 */
  size?: string;
  /** 反向提示：描述应避免生成的内容（拼入 prompt 尾部） */
  negative_prompt?: string;
  /** 可选覆盖配置：未提供时从 settings.imageEdit 读取 */
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** 尺寸归一化：限制在常见支持范围（多数生成模型支持 768/1024/1536/2048/2688/4096）。
 *  注意必须保留 768：RATIO_PRESETS 的 4:3(1024x768)/3:4(768x1024) 依赖它，
 *  否则短边 768 会被夹到 1024，比例静默变成 1:1。 */
function clampDim(v: number): number {
  const candidates = [768, 1024, 1536, 2048, 2688, 4096];
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - v) < Math.abs(best - v)) best = c;
  }
  return best;
}

/** SDXL 系本地模型（BobMultimodal/Stable Diffusion/FLUX）不支持云端超大尺寸：
 *  RATIO_PRESETS 里的 3:2(1536x1024)/2:3(1024x1536)/16:9(2688x1536)/9:16(1536x2688)
 *  超出 SDXL 单边 1536 / 总像素 ~1.5MP 限制，映射到 SDXL 原生桶尺寸
 *  （64 倍数、总像素 ~1.0-1.2MP、单边 ≤1536，比例尽量贴近原预设）；
 *  1:1/4:3/3:4 已在支持范围，原样保留。 */
const SDXL_SIZE_MAP: Record<string, string> = {
  '1024x1024': '1024x1024', // 1:1（1.0MP）
  '1024x768': '1024x768',   // 4:3（0.79MP）
  '768x1024': '768x1024',   // 3:4
  '1536x1024': '1216x832',  // 3:2 → SDXL 宽幅桶（1.46 最接近 1.5）
  '1024x1536': '832x1216',  // 2:3 → SDXL 竖幅桶
  '2688x1536': '1344x768',  // 16:9 → SDXL 超宽桶（1.75 最接近 1.78）
  '1536x2688': '768x1344',  // 9:16 → SDXL 超竖桶
};

/** 负向提示规范化：绝大多数图像生成模型没有独立 negative 参数，统一拼入 prompt 尾部 */
function applyNegativePrompt(prompt: string, negative?: string): string {
  const n = negative?.trim();
  if (!n) return prompt;
  if (/Negative guidance:\s*AVOID/i.test(prompt)) return prompt;
  return `${prompt.replace(/\s+$/u, '')}\n\nNegative guidance: AVOID the following — ${n}.`;
}

/** 火山方舟（doubao）文生图：POST /images/generations，JSON body 不带 image 字段即为文生图 */
async function generateImageDoubao(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  size: string,
): Promise<string | undefined> {
  const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      response_format: 'b64_json',
      watermark: false,
    }),
  });
  const text = await resp.text();
  const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
  if (!resp.ok) {
    const err = new Error(data?.error?.message || `HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    (err as Error & { status?: number }).status = resp.status;
    throw err;
  }
  return data?.data?.[0]?.b64_json as string | undefined;
}

/** 把 DashScope 返回的 image 字段规范化为完整 data URL：
 *  - 已是 data URL → 原样返回；
 *  - http(s) URL → 服务端下载并转成 data:image/...;base64（qwen-image-3.0 返回的是图片 URL，不是 base64）；
 *  - 纯 base64 → 按 PNG 拼 data URL。 */
async function toDataUrl(image: string): Promise<string | undefined> {
  if (!image) return undefined;
  if (/^data:/i.test(image)) return image;
  if (/^https?:\/\//i.test(image)) {
    try {
      const resp = await fetch(image);
      if (!resp.ok) return undefined;
      const blob = await resp.blob();
      const mime = blob.type || 'image/png';
      const buf = Buffer.from(await blob.arrayBuffer());
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return undefined;
    }
  }
  return `data:image/png;base64,${image}`;
}

/** 千问图像 3.0 的最小像素下限（服务端校验：image size must be at least 3686400 pixels）。
 *  RATIO_PRESETS 里 1:1/4:3/3:4/3:2/2:3 等尺寸像素数不足，需保持宽高比放大到满足下限。 */
const QWEN_MIN_PIXELS = 3686400;
const SIZE_STEP = 64;

/** 保持宽高比把 size 放大到总像素 >= QWEN_MIN_PIXELS，且每边为 64 的倍数（常见生成模型步长）。 */
function ensureQwenMinSize(size: string): string {
  const [w, h] = size.split('x').map((n) => parseInt(n, 10));
  if (!w || !h || w * h >= QWEN_MIN_PIXELS) return size;
  const scale = Math.sqrt(QWEN_MIN_PIXELS / (w * h));
  let nw = Math.ceil((w * scale) / SIZE_STEP) * SIZE_STEP;
  let nh = Math.ceil((h * scale) / SIZE_STEP) * SIZE_STEP;
  // 取整后若仍不足，则逐步加大短边直到满足下限
  while (nw * nh < QWEN_MIN_PIXELS) {
    if (nw <= nh) nw += SIZE_STEP; else nh += SIZE_STEP;
  }
  return `${nw}x${nh}`;
}

/** 千问图像 3.0 文生图：DashScope 原生 multimodal-generation/generation 端点。
 *  qwen-image-3.0 / qwen-image-3.0-pro 不兼容 OpenAI /images/generations，
 *  需用 messages[{content:[{text}]}] 格式调用原生 API。
 *  size 用星号分隔（1024*1024），总像素须在 512*512 ~ 2048*2048 之间。
 *  返回完整 data URL（响应中 image 字段可能是 URL / data URL / base64 三种形态）。 */
async function generateImageQwen3(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  size: string,
): Promise<string | undefined> {
  // compatible-mode/v1 → api/v1（DashScope 原生 API 基址）
  const nativeBase = baseUrl
    .replace('/compatible-mode/v1', '/api/v1')
    .replace(/\/+$/, '');
  // qwen-image-3.0 最小像素下限 3686400：不足时保持宽高比放大（如 1024x1024 → 1920x1920）
  const qwenSize = ensureQwenMinSize(size).replace('x', '*');  // 1024*1024 星号分隔
  const resp = await fetch(`${nativeBase}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: prompt }],
          },
        ],
      },
      parameters: { size: qwenSize },
    }),
  });
  const text = await resp.text();
  const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
  if (!resp.ok) {
    const errMsg = data?.message || data?.error?.message || `HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    const err = new Error(errMsg);
    (err as Error & { status?: number }).status = resp.status;
    throw err;
  }
  // 响应格式：output.choices[0].message.content[0].image（可能是 URL / data URL / base64）
  const content = data?.output?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item?.image === 'string' && item.image) {
        const url = await toDataUrl(item.image);
        if (url) return url;
      }
    }
  }
  return undefined;
}

/** 本地无鉴权厂商（BobMultimodal/Ollama）：走 OpenAI 兼容 images/generations，不携带 Authorization 头 */
async function generateImageNoAuth(
  baseUrl: string,
  model: string,
  prompt: string,
  size: string,
): Promise<string | undefined> {
  const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, n: 1, response_format: 'b64_json' }),
  });
  const text = await resp.text();
  const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
  if (!resp.ok) {
    throw new Error(`本地生图 HTTP ${resp.status}: ${(data?.error?.message || text).slice(0, 300)}`);
  }
  return data?.data?.[0]?.b64_json as string | undefined;
}

/** 用指定模型执行一次文生图，返回 b64（失败抛错）。
 *  doubao：/images/generations（JSON body 无 image = 文生图）；
 *  qwen-image-3.0：DashScope 原生 multimodal-generation/generation（不兼容 OpenAI images API）；
 *  本地无鉴权厂商（bobmultimodal/ollama）：OpenAI 兼容 images/generations，无 Authorization 头；
 *  其他厂商：OpenAI 兼容 images.generate。 */
async function tryGenerateWithModel(
  config: { provider: string; apiKey: string; baseUrl: string; model: string },
  body: ImageGenerateRequest,
  finalPrompt: string,
  size: string,
): Promise<string | undefined> {
  if (config.provider === 'doubao') {
    return generateImageDoubao(config.baseUrl, config.apiKey, config.model, finalPrompt, size);
  }

  // qwen-image-3.0 / qwen-image-3.0-pro：走 DashScope 原生 multimodal-generation 端点
  if (/qwen-image-3/i.test(config.model)) {
    return generateImageQwen3(config.baseUrl, config.apiKey, config.model, finalPrompt, size);
  }

  // 本地无鉴权厂商：不携带 Authorization 头（与 STT 的本地转写策略一致）
  if (NO_AUTH_IMAGE_PROVIDERS.has(config.provider)) {
    return generateImageNoAuth(config.baseUrl, config.model, finalPrompt, size);
  }

  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  const resp = await client.images.generate({
    model: config.model,
    prompt: finalPrompt,
    size,
    n: 1,
    response_format: 'b64_json',
  });
  return resp.data?.[0]?.b64_json;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as ImageGenerateRequest;
    const { prompt } = body;

    if (!prompt?.trim()) {
      return Response.json({ success: false, error: 'prompt is required' }, { status: 400 });
    }

    const settings = await readSettingsFromFile();
    const config = await resolveImageConfig(settings, body);
    if (!config) {
      return Response.json(
        { success: false, error: '未配置图像模型，请先在 设置 → 角色派发 → 图像编辑模型 中配置模型与 API Key' },
        { status: 400 },
      );
    }

    // 尺寸归一化：默认 1024x1024；若前端传了 "WxH" 则按各自维度夹紧
    let size = '1024x1024';
    if (body.size && /^\d+x\d+$/i.test(body.size)) {
      const [w, h] = body.size.split('x').map((n) => parseInt(n, 10));
      size = `${clampDim(w || 1024)}x${clampDim(h || 1024)}`;
    }

    // 本地 SDXL 系模型（BobMultimodal / sdxl / stable-diffusion / flux）不支持云端超大尺寸
    // （如 2688x1536），映射到 SDXL 原生桶尺寸（64 倍数、总像素 ≤ ~1.5MP）
    const isSdxlLocal =
      NO_AUTH_IMAGE_PROVIDERS.has(config.provider) || /sdxl|stable-diffusion|flux/i.test(config.model);
    if (isSdxlLocal) {
      size = SDXL_SIZE_MAP[size] || size;
    }

    const finalPrompt = applyNegativePrompt(prompt, body.negative_prompt);

    // 模型执行顺序：默认模型 → settings 候选池逐个 fallback（同 Key 下多模型）
    const candidates = [config.model, ...config.pool];
    let b64: string | undefined;
    let usedModel = config.model;
    let lastError: unknown = null;
    for (const model of candidates) {
      try {
        b64 = await tryGenerateWithModel(
          { provider: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl, model },
          body,
          finalPrompt,
          size,
        );
        usedModel = model;
        if (b64) break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!b64) {
      throw lastError ?? new Error('模型未返回图像数据');
    }

    // 兼容两种返回形态：qwen 已返回完整 data URL；其他厂商返回纯 base64
    const image = /^data:/i.test(b64) ? b64 : `data:image/png;base64,${b64}`;

    return Response.json({
      success: true,
      image,
      size,
      model: usedModel,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const is404 = /404|not found|no such endpoint|unsupported/i.test(msg);
    const hint = is404
      ? ` 接口返回 404：当前模型不支持文生图接口（images/generations，可能只支持图像编辑）。请在 设置 → 角色派发 → 图像编辑模型 中改用支持文生图的模型（doubao seedream / gpt-image-1 / qwen-image-3.0 / siliconflow 等）。`
      : '';
    return Response.json({ success: false, error: msg + hint }, { status: 500 });
  }
}