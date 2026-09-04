/**
 * AI 图片编辑接口：自然语言指令修改图片（OpenAI 兼容 images.edits 多厂商）
 *
 * 模型配置来自「设置 → 角色派发 → 图像编辑模型」（imageEdit），
 * 与聊天模型独立——图像编辑走 images API（multipart：原图 + 指令），不兼容 chat completions。
 *
 * 响应为非流式 JSON（轻量单轮调用，不走工具循环）。
 */
import { NextRequest } from 'next/server';
import OpenAI, { toFile } from 'openai';
import { readSettingsFromFile } from '@/lib/settings-server';
import { resolveImageConfig } from '@/lib/models/image-config';

interface ImageEditRequest {
  /** 原图 dataUrl（data:image/xxx;base64,...） */
  image: string;
  /** 编辑指令（自然语言，如「把背景换成夜晚」「去掉左边的人」） */
  instruction: string;
  /** 原图宽高（用于 size 参数） */
  width?: number;
  height?: number;
  /** 可选局部编辑 mask：选区内透明 = 重绘区（要修改的位置），选区外白色 = 保留区（不传 = 整图编辑）。
   *  符合 OpenAI images.edits 语义：mask 透明区域指示应编辑的位置 */
  mask?: string;
  /** 反向提示：描述应避免生成的内容（如 "blurry text, altered signature"）。
   *  由于 OpenAI images.edits 接口无单独 negative 参数，这里会以规范化句式拼入 prompt 尾部让模型感知。 */
  negative_prompt?: string;
  /** 参考图片 dataUrl 列表（@ 从当前文件夹引用的图片）。多数 edits 接口仅接受单张目标图，
   *  因此参考图以提示语形式注入，提示模型参考这些图片的风格/内容 */
  references?: string[];
  /** 选中区域的坐标与描述（Detect All #chip 引用）。有 mask 通道的模型（OpenAI edits）用 mask；
   *  无 mask 通道的模型（doubao SeedEdit/Seedream i2i）把坐标注入 prompt 提示模型按区域编辑 */
  regions?: Array<{
    bbox: [number, number, number, number];
    object?: string;
    attributes?: string;
  }>;
  /** 可选覆盖配置：未提供时从 settings.imageEdit 读取 */
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** 把（可选的）负向提示规范化拼入用户 prompt。绝大多数图像编辑模型的 edits/i2i 接口
 *  没有独立 negative 参数，因此统一转成「Negative guidance: AVOID xxx」句式追加在末尾让模型遵守。 */
function applyNegativePrompt(prompt: string, negative?: string): string {
  const n = negative?.trim();
  if (!n) return prompt;
  // 避免重复追加
  if (/Negative guidance:\s*AVOID/i.test(prompt)) return prompt;
  return `${prompt.replace(/\s+$/u, '')}\n\nNegative guidance: AVOID the following — ${n}.`;
}

/** 参考图片提示：edits 接口不接受多图，仅能在 prompt 中声明参考图存在，提示模型按参考图风格/内容执行 */
function applyReferences(prompt: string, references?: string[]): string {
  const refs = (references ?? []).filter((r) => typeof r === 'string' && r.length > 0);
  if (refs.length === 0) return prompt;
  return `${prompt.replace(/\s+$/u, '')}\n\nReference images provided (${refs.length}): follow their style, object layout and content as guidance while editing the target image.`;
}

/** doubao 无 mask 通道的坐标注入模板（设计文档 §8.4）：把选中区域的像素 bbox + 语义描述拼入 prompt，
 *  提示 SeedEdit/Seedream 等 i2i 模型「只在坐标框内编辑，框外保持原样」——替代 mask 的定位能力。 */
function applyRegionBoxes(
  prompt: string,
  regions?: ImageEditRequest['regions'],
): string {
  const rs = (regions ?? []).filter(
    (r) => Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((n) => typeof n === 'number' && Number.isFinite(n)),
  );
  if (rs.length === 0) return prompt;
  const lines = rs.map((r, i) => {
    const [x1, y1, x2, y2] = r.bbox;
    const desc = [r.object, r.attributes].filter((s) => typeof s === 'string' && s.trim()).join(', ');
    return `${i + 1}. bbox [${Math.round(x1)}, ${Math.round(y1)}, ${Math.round(x2)}, ${Math.round(y2)}]${desc ? ` — ${desc}` : ''}`;
  });
  return (
    `${prompt.replace(/\s+$/u, '')}\n\n` +
    `Regional edit guidance: modify ONLY inside the following bounding box(es) ` +
    `(pixel coordinates [x1, y1, x2, y2], top-left origin, relative to the original image):\n` +
    `${lines.join('\n')}\n` +
    `Keep all pixels outside these boxes identical to the source image.`
  );
}

/** 图像编辑厂商 baseUrl 预设（与聊天模型同域，走 OpenAI 兼容 images 接口） */

/** 从 dataUrl 提取原始字节（返回 Blob：新版 OpenAI SDK 的 Uploadable 仅接受 Blob/File 等，不接受 Buffer） */
function extractImageBuffer(image: string): Blob {
  const m = image.match(/^data:(image\/[^;]+);base64,(.+)$/i);
  if (m) {
    const buf = Buffer.from(m[2], 'base64');
    return new Blob([new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)], { type: m[1] });
  }
  // 也接受裸 base64
  const buf = Buffer.from(image, 'base64');
  return new Blob([new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)]);
}

/**
 * 火山方舟（doubao）图片编辑：走 POST /images/generations（i2i：generate 请求中带 image 字段），
 * 不是 OpenAI 的 /images/edits 端点——方舟对 edits 返回 404。
 * SeedEdit / Seedream 系列模型均通过该端点实现图像编辑（JSON body，image 传 dataUrl 或 URL）。
 * size 差异：seededit 仅支持 'adaptive'；seedream 要求像素下限（'2k' 通用可用）。
 * watermark 关闭避免输出带"AI生成"水印。
 */
async function editImageDoubao(
  baseUrl: string,
  apiKey: string,
  model: string,
  imageDataUrl: string,
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
      image: imageDataUrl,
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

/** 千问图像 3.0 图片编辑（I2I）：DashScope 原生 multimodal-generation/generation 端点。
 *  与文生图共用同一端点，区别在于 content 中先传 image 再传 text 指令。
 *  支持 1-3 张参考图（image 对象按顺序排列在 content 数组中）。
 *  返回完整 data URL（响应中 image 字段可能是 URL / data URL / base64 三种形态）。 */
async function editImageQwen3(
  baseUrl: string,
  apiKey: string,
  model: string,
  imageDataUrl: string,
  prompt: string,
): Promise<string | undefined> {
  const nativeBase = baseUrl
    .replace('/compatible-mode/v1', '/api/v1')
    .replace(/\/+$/, '');
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
            content: [
              { image: imageDataUrl },
              { text: prompt },
            ],
          },
        ],
      },
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

/** 用指定模型执行一次图像编辑，返回 b64（失败抛错）。
 *  doubao / agentplan / codingplan：火山方舟，走 /images/generations（i2i，JSON body 直接传 dataUrl）；
 *  qwen-image-3.0：DashScope 原生 multimodal-generation/generation（content 中先 image 后 text）；
 *  其他厂商：OpenAI 兼容 images.edits（带 mask 失败时自动回退整图编辑）。 */
async function tryEditWithModel(
  config: { provider: string; apiKey: string; baseUrl: string; model: string },
  body: ImageEditRequest,
  imageFile: File,
  finalPrompt: string,
  size: string,
): Promise<string | undefined> {
  // 火山方舟（doubao 普通 / agentplan 订阅 / codingplan 订阅共用同一套网关协议）：
  // SeedEdit / Seedream 走 /images/generations（i2i），JSON body 直接传原图 dataUrl，整图编辑（无 mask 通道）
  if (config.provider === 'doubao' || config.provider === 'agentplan' || config.provider === 'codingplan') {
    // size：seededit 仅支持 adaptive；seedream 系列要求像素下限，'2k' 通用
    const doubaoSize = /seededit/i.test(config.model) ? 'adaptive' : '2k';
    // 无 mask 通道 → 有选中区域时把 bbox 坐标注入 prompt，提示模型按坐标区域局部编辑
    const promptWithRegions = applyRegionBoxes(finalPrompt, body.regions);
    return editImageDoubao(config.baseUrl, config.apiKey, config.model, body.image, promptWithRegions, doubaoSize);
  }

  // qwen-image-3.0 / qwen-image-3.0-pro：走 DashScope 原生 multimodal-generation 端点（I2I 模式）
  if (/qwen-image-3/i.test(config.model)) {
    return editImageQwen3(config.baseUrl, config.apiKey, config.model, body.image, finalPrompt);
  }

  // OpenAI 兼容 edits 端点（gpt-image-1 / qwen-image-edit / siliconflow 等）
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  // 局部编辑：带 mask 调用；mask 参数不受支持时自动回退整图编辑
  const hasMask = !!body.mask;
  const maskFile = hasMask ? await toFile(extractImageBuffer(body.mask!), 'mask.png', { type: 'image/png' }) : undefined;
  let resp;
  if (hasMask && maskFile) {
    try {
      resp = await client.images.edit({
        model: config.model,
        image: imageFile,
        mask: maskFile,
        prompt: finalPrompt,
        size,
        response_format: 'b64_json',
      });
    } catch (e) {
      // mask 不可用（部分厂商仅支持整图编辑）→ 回退不带 mask 重试
      const msg = e instanceof Error ? e.message : String(e);
      if (!/mask|edits|edit image|image edit/i.test(msg)) throw e;
      resp = await client.images.edit({
        model: config.model,
        image: imageFile,
        prompt: finalPrompt,
        size,
        response_format: 'b64_json',
      });
    }
  } else {
    resp = await client.images.edit({
      model: config.model,
      image: imageFile,
      prompt: finalPrompt,
      size,
      response_format: 'b64_json',
    });
  }
  return resp.data?.[0]?.b64_json;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as ImageEditRequest;
    const { image, instruction } = body;

    if (!image || !instruction) {
      return Response.json({ success: false, error: 'image and instruction are required' }, { status: 400 });
    }

    const settings = await readSettingsFromFile();
    const config = await resolveImageConfig(settings, body);
    if (!config) {
      return Response.json(
        { success: false, error: '未配置图像编辑模型，请先在 设置 → 角色派发 → 图像编辑模型 中配置模型与 API Key' },
        { status: 400 },
      );
    }

    // 原图尺寸归一化：限制在常见支持范围（多数编辑模型支持 768/1024/1536/2048）
    const rawW = body.width || 1024;
    const rawH = body.height || 1024;
    const clampDim = (v: number) => {
      // 必须保留 768：4:3/3:4 原图短边为 768，缺失会把比例静默夹成 1:1
      const candidates = [768, 1024, 1536, 2048, 2688, 4096];
      let best = candidates[0];
      for (const c of candidates) {
        if (Math.abs(c - v) < Math.abs(best - v)) best = c;
      }
      return best;
    };
    const size = `${clampDim(rawW)}x${clampDim(rawH)}`;

    // 原图 → multipart 文件（各模型共用同一文件，只换 model 重试）
    const imageFile = await toFile(extractImageBuffer(image), 'image.png', { type: 'image/png' });

    // 负向提示规范化：绝大多数图像编辑模型没有独立 negative 参数，
    // 统一转成「Negative guidance: AVOID xxx」句式追加在 prompt 末尾
    let finalPrompt = applyNegativePrompt(instruction, body.negative_prompt);
    // 参考图片提示：edits 接口不接受多图，改为在 prompt 中声明参考图存在
    finalPrompt = applyReferences(finalPrompt, body.references);

    // 模型执行顺序：默认模型 → settings 候选池逐个 fallback（同 Key 下多模型）
    const candidates = [config.model, ...config.pool];
    let b64: string | undefined;
    let usedModel = config.model;
    let lastError: unknown = null;
    for (const model of candidates) {
      try {
        b64 = await tryEditWithModel(
          { provider: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl, model },
          body,
          imageFile,
          finalPrompt,
          size,
        );
        usedModel = model;
        if (b64) break;
      } catch (e) {
        lastError = e;
        // 继续尝试候选池中的下一个模型
      }
    }

    if (!b64) {
      // 全部候选失败：抛最后一个错误（保留 404 / no edits 判定以给出友好提示）
      throw lastError ?? new Error('模型未返回图像数据');
    }

    // 兼容两种返回形态：qwen 已返回完整 data URL；其他厂商返回纯 base64
    const outImage = /^data:/i.test(b64) ? b64 : `data:image/png;base64,${b64}`;

    return Response.json({
      success: true,
      image: outImage,
      size,
      model: usedModel,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 常见失败：模型只支持文生图（无 edits 端点）→ 提示换成图像编辑模型
    // 404 是 OpenAI 兼容网关对「不支持的端点/模型」的典型返回（如把文生图 seedream 模型用于图像编辑）
    const is404 = /404|not found|no such endpoint|unsupported/i.test(msg);
    const noEdits = /edits|edit image|image edit/i.test(msg);
    const hint = is404
      ? ` 接口返回 404：当前模型不支持图像编辑接口（images/edits，可能只支持文生图）。请在 设置 → 角色派发 → 图像编辑模型 中改用支持图像编辑的模型（Doubao SeedEdit / gpt-image-1 / qwen-image-3.0）。`
      : noEdits
        ? ` 该模型可能不支持图像编辑（只支持文生图），请配置图像编辑模型（如 doubao SeedEdit / gpt-image-1 / qwen-image-3.0）。`
        : '';
    return Response.json({ success: false, error: msg + hint }, { status: 500 });
  }
}
