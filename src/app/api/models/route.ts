import { NextRequest, NextResponse } from 'next/server';
import { VISION_MODEL_PATTERN, OCR_MODEL_PATTERN, MODEL_VENDOR_PATTERNS, normalizeVendorName } from '@/lib/model-tags';
import { PROVIDER_PRESETS, sanitizeBaseUrl } from '@/lib/types';

interface ModelsRequest {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  /** chat = 完整模型列表（含 thinking 探测，默认）；image = 过滤图像生成/编辑模型；stt = 过滤语音转写模型 */
  kind?: 'chat' | 'image' | 'stt';
}

interface ProviderModelInfo {
  id: string;
  owned_by?: string;
  /** 能力元数据（可选）：部分厂商/网关在 /models 返回，用于权威分类，避免依赖命名 */
  modalities?: unknown;
  input_modalities?: unknown;
  supports_vision?: unknown;
  vision?: unknown;
  /** 当模型来自 PROVIDER_PRESETS 手动维护（官方 /models 没返回的视觉/OCR/嵌入/图像生成等）：
   *  - _fromPreset / _presetOwnedBy 用于透传预置厂商信息
   *  - thinking 一律按产品要求默认 true，不再依赖预置或探测
   */
  _fromPreset?: boolean;
  _presetOwnedBy?: string;
}

/** 提取厂商声明的"图像输入"能力（L1 权威信号，优先于命名正则）：
 *  - input_modalities 含 image → 明确输入能力（最可靠）
 *  - supports_vision / vision === true → 明确支持视觉
 *  - modalities 同时含 image 与 text → DashScope/部分网关惯例（视觉模型输入 [image,text]）
 *  说明：纯图像生成模型（dall-e/wan 等）即使列出 modalities 也不会声明"图像输入"，
 *  且命名分类（image-gen）会兜底，此处只做"声明即信"的视觉判定。 */
function extractDeclaredVision(m: ProviderModelInfo): boolean {
  const toStrList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  if (toStrList(m.input_modalities).some((x) => x.toLowerCase().includes('image'))) return true;
  if (m.supports_vision === true || m.vision === true) return true;
  const mods = toStrList(m.modalities).map((x) => x.toLowerCase());
  return mods.includes('image') && mods.includes('text');
}

export async function POST(request: NextRequest) {
  let body: ModelsRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { provider, apiKey, baseUrl, kind } = body;

  if (!provider) {
    return NextResponse.json({ error: 'Missing provider' }, { status: 400 });
  }
  // 本地无鉴权厂商（BobMultimodal/Ollama，OpenAI 兼容 /models）：无需 API Key 即可拉取模型列表
  const NO_AUTH_PROVIDERS = new Set(['bobmultimodal', 'ollama']);
  if (!apiKey && !NO_AUTH_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: 'Missing apiKey' }, { status: 400 });
  }

  // 根据提供商确定 baseUrl
  const providerBaseUrls: Record<string, string> = {
    deepseek: 'https://api.deepseek.com',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    moonshot: 'https://api.moonshot.cn/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    openai: 'https://api.openai.com/v1',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    agentplan: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    codingplan: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    siliconflow: 'https://api.siliconflow.cn/v1',
  };

  const finalBaseUrl = sanitizeBaseUrl(baseUrl || providerBaseUrls[provider] || '');

  if (!finalBaseUrl) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  }

  // Base URL 必须为 ASCII 合法 URL：含中文等非 ASCII 字符会让 fetch 报 ByteString 转换错误
  if (/[\u0080-\uFFFF]/.test(finalBaseUrl)) {
    return NextResponse.json(
      { error: 'Base URL 包含非法字符（如中文）。请检查请求地址 / Base URL 中不要包含中文或特殊字符。' },
      { status: 400 }
    );
  }

  // 整体绝对超时 25s：含 /models + thinking 探测，确保前端 30s 超时不会先触发而释放按钮
    // 声明在 try 外，finally 可可靠 clearTimeout
    const overallCtrl = new AbortController();
    let overallT: ReturnType<typeof setTimeout> | undefined;
    try {
      overallT = setTimeout(() => overallCtrl.abort(new DOMException('Aborted', 'AbortError')), 25000);

      // --- 分页循环拉取 /models（OpenAI 兼容 cursor 分页） ---
      // 经验教训：
      //   requestCursor = 本次请求要发的 cursor（首页为空/不传）
      //   nextCursor    = 响应体里 next_page_token（用于下一页）
      // 终止条件：!has_more || nextCursor 为空 || 页数上限 20 || 条数上限 800
      const allModels: ProviderModelInfo[] = [];
      let requestCursor: string | undefined = undefined;
      let page = 0;
      const PAGE_LIMIT = 20;
      const MODEL_LIMIT = 800;
      const SINGLE_PAGE_TIMEOUT = 10000;

      // 订阅制产品（Agent Plan / Coding Plan）不支持 OpenAI 兼容的 GET /models 接口，
      // 模型列表需从控制台抄录或通过火山引擎 OpenAPI（ListArkAgentPlanModel）查询。
      // 这里跳过 /models 请求，直接走下方的预置模型合并逻辑返回预置列表，避免 fetch 报错。
      const isSubscriptionPlan = provider === 'agentplan' || provider === 'codingplan';

      while (!isSubscriptionPlan && page < PAGE_LIMIT && allModels.length < MODEL_LIMIT) {
        page++;
        const url = new URL(`${finalBaseUrl}/models`);
        if (requestCursor) url.searchParams.set('cursor', requestCursor);

        const pageResponse = await fetch(url.toString(), {
          method: 'GET',
          headers: apiKey
            ? {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              }
            : { 'Content-Type': 'application/json' }, // 本地无鉴权厂商不携带 Authorization 头
          signal: AbortSignal.any([AbortSignal.timeout(SINGLE_PAGE_TIMEOUT), overallCtrl.signal]),
        });

        if (!pageResponse.ok) {
          const errText = await pageResponse.text().catch(() => '');
          // 首页失败：直接返回错误；后续页失败：给出部分结果 + warning，不整体失败（避免某一页坏导致全列表空）
          if (page === 1) {
            return NextResponse.json(
              { error: `API 返回 ${pageResponse.status}: ${errText.slice(0, 200)}` },
              { status: pageResponse.status }
            );
          }
          (allModels as ProviderModelInfo[] & { _fetchWarning?: string })._fetchWarning =
            `分页中断：第 ${page} 页返回 ${pageResponse.status}，已返回前 ${page - 1} 页 ${allModels.length} 条。`;
          break;
        }

        const pageData = await pageResponse.json();
        const pageItems: ProviderModelInfo[] = pageData.data || pageData.models || [];
        allModels.push(...pageItems);

        // OpenAI 兼容分页字段：has_more + next_page_token；部分厂商别名 next_cursor / page_token
        const hasMore: boolean | undefined = pageData.has_more ?? pageData.hasMore;
        const nextCursorRaw: string | undefined =
          pageData.next_page_token ?? pageData.nextPageToken ?? pageData.next_cursor ?? pageData.nextCursor;
        const nextCursor: string | undefined =
          nextCursorRaw && String(nextCursorRaw).trim().length > 0 ? String(nextCursorRaw) : undefined;

        // 终止：厂商声明没更多
        if (hasMore === false) break;
        // 终止：没声明 has_more，但 nextCursor 为空（大多数 OpenAI 兼容平台的信号）
        if (!nextCursor) break;
        // 终止安全：下一页 token 与上一页相同（防死循环），或下一页空
        if (nextCursor === requestCursor || pageItems.length === 0) break;

        requestCursor = nextCursor;
      }

      // --- BobMultimodal 专用补充：/v1/models 不暴露部分已加载模型 ---
      // 本地 MLX 服务（BobMultimodal）的 /v1/models 只列出声明的模型（如 VL/ASR/SDXL），
      // 实际已加载的 translate_model（如 mlx-community/Qwen2.5-7B-Instruct-4bit）只在
      // /api/status 里可见，若不补充用户将无法在模型池中选到这些模型。
      if (provider === 'bobmultimodal') {
        try {
          const statusUrl = `${finalBaseUrl.replace(/\/v1\/?$/, '')}/api/status`;
          const statusRes = await fetch(statusUrl, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.any([AbortSignal.timeout(5000), overallCtrl.signal]),
          });
          if (statusRes.ok) {
            const status = await statusRes.json().catch(() => null);
            if (status && typeof status === 'object') {
              const loadedModelIds = [
                status.translate_model,
                status.vision_model,
                status.asr_model,
                status.generate_model,
              ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
              const known = new Set(allModels.map((m) => (m.id || '').toLowerCase()));
              for (const id of loadedModelIds) {
                if (known.has(id.toLowerCase())) continue;
                known.add(id.toLowerCase());
                allModels.push({ id, owned_by: 'mlx' });
              }
            }
          }
        } catch { /* 本地 status 拉取失败不阻塞列表，仅跳过补充 */ }
      }

      // 若有部分成功 warning，挂在数组上在 return 前打印日志；对外返回结果优先
      const fetchWarning =
        (allModels as ProviderModelInfo[] & { _fetchWarning?: string })._fetchWarning;
      if (fetchWarning && typeof console !== 'undefined') {
        console.warn('[api/models]', fetchWarning);
      }

      // --- 合并：API 返回结果 ∪ provider 预置（手动维护）模型 ---
      // 根因：智谱等厂商 /v1/models 并不返回视觉、OCR、嵌入、图像生成、音频、rerank 等所有模型，
      // 官方文档有、可正常调用，但就是不会出现在列表接口里。因此将 PROVIDER_PRESETS 本 provider
      // 下的所有模型作为"权威手动补充"，并集后返回。API 返回结果优先，预置只补 API 没覆盖的 id。
      const apiIdSet = new Set(allModels.map((m) => (m.id || '').toLowerCase()));
      const preset = PROVIDER_PRESETS.find((p) => p.type === provider);
      const presetAdditions: ProviderModelInfo[] = [];
      if (preset) {
        for (const pm of preset.models) {
          if (!pm.modelId) continue;
          if (apiIdSet.has(pm.modelId.toLowerCase())) continue; // API 已返回 → 以 API 为准，跳过
          presetAdditions.push({
            id: pm.modelId,
            owned_by: preset.label,
            _fromPreset: true,
            _presetOwnedBy: preset.label,
          });
        }
      }
      if (presetAdditions.length > 0) {
        allModels.push(...presetAdditions);
      }

    // 客观返回 API 提供的所有模型，不做主观过滤
    // 对非对话类模型标注 type 字段，让前端展示时可区分
    const NON_CHAT_PATTERNS = [
      { pattern: /embedding|bge-/i, type: 'embedding' },
      // ocr：OCR 专用模型（qwen-vl-ocr / deepseek-ocr 等）只能转录文字，不能作通用视觉模型，
      // 必须放在 vision 之前匹配（qwen-vl-ocr 同时含 vl 与 ocr）
      { pattern: OCR_MODEL_PATTERN, type: 'ocr' },
      // vision：判定规则统一引用 model-tags（多模态系列：OpenAI 4o/4.1/4.5/o、Claude 3/4、Gemini、千问 VL/Omni、GLM-4v/4.5v、Kimi K3、Gemma 3/4、Llama 4、Grok 等）
      { pattern: VISION_MODEL_PATTERN, type: 'vision' },
      // audio：tts/asr/whisper/speech + qwen-audio（实时语音对话）
      { pattern: /tts|asr|whisper|speech|qwen-audio/i, type: 'audio' },
      // image-gen：dall-e / qwen-image / wan 万相 / z-image / cogview 智谱 / flux 等图像生成模型
      { pattern: /dall-?e|qwen-image|wan[.\-]?2|wan[.\-]?3|z-image|flux|sdxl|stable-diffusion|image-2[.\-]|image-3[.\-]|cogview|kolors|imagen|midjourney|recraft|seedream|seededit|hunyuan-image|sensecog/i, type: 'image-gen' },
      { pattern: /moderation/i, type: 'moderation' },
      { pattern: /rerank/i, type: 'rerank' },
    ];

    // 厂商推断：千问（DashScope）是模型大融合聚合平台，返回的 owned_by 常为 "system"，
    // 需按模型 id 前缀/关键词识别真实来源厂商，前端据此打厂商标签（规则见 model-tags）
    const inferVendor = (id: string, ownedBy: string): string => {
      // 命名正则（英文标准名）优先：聚合平台 owned_by 常为 "system" 或中文，
      // 统一以 id 推断打英文标签；正则未命中时再取 owned_by，并归一化中文厂商名
      const hit = MODEL_VENDOR_PATTERNS.find((p) => p.pattern.test(id));
      if (hit) return hit.vendor;
      if (ownedBy && ownedBy !== 'system' && !/^unknown$/i.test(ownedBy)) return normalizeVendorName(ownedBy);
      return '';
    };

    const chatModels = allModels.map((m) => {
      const id = (m.id || '').toLowerCase();
      const ownedBy = m._presetOwnedBy || m.owned_by || '';

      // 产品要求：BobWork 上添加的模型默认支持 Extended thinking（扩展思考），thinking 一律默认 true
      // 不再依赖命名正则或运行时探测——所有模型在模型池中均标记为支持思考
      // 1) OCR 专用模型（名字含 ocr）——最具体，优先（即便元数据声明了 image 输入，也只做转录）
      if (OCR_MODEL_PATTERN.test(id)) {
        return {
          modelId: m.id,
          ownedBy,
          vendor: inferVendor(id, ownedBy),
          thinking: true,
          type: 'ocr',
        };
      }
      // 2) 厂商声明的能力元数据（L1 权威分类，不依赖命名——
      //    解决"模型名不含视觉关键词（vl/vision/4v…）却被误判为 chat"的核心场景）
      if (extractDeclaredVision(m)) {
        return {
          modelId: m.id,
          ownedBy,
          vendor: inferVendor(id, ownedBy),
          thinking: true,
          type: 'vision',
        };
      }
      // 3) 命名正则兜底（embedding/vision/audio/image-gen/moderation/rerank…）
      const nonChat = NON_CHAT_PATTERNS.find((p) => p.pattern.test(id));
      return {
        modelId: m.id,
        ownedBy,
        vendor: inferVendor(id, ownedBy),
        thinking: true,
        type: nonChat ? nonChat.type : 'chat',
      };
    });

    // kind 过滤：image = 图像生成/编辑模型；stt = 语音转写模型（含补充关键词，覆盖 SeedEdit/Seedream/gpt-image/SenseVoice 等命名）
    let resultModels = chatModels;
    if (kind === 'image') {
      const IMAGE_EXTRA = /seededit|seedream|gpt-image|image-edit|image-editor|kolors|imagen|cogview|midjourney|recraft|hunyuan-image|sensecog/i;
      resultModels = chatModels.filter((m) => m.type === 'image-gen' || IMAGE_EXTRA.test(m.modelId));
    } else if (kind === 'stt') {
      const STT_PATTERN = /whisper|asr|sensevoice|transcri|speech|qwen-audio/i;
      resultModels = chatModels.filter((m) => m.type === 'audio' && STT_PATTERN.test(m.modelId));
    }

    return NextResponse.json({ models: resultModels, total: resultModels.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `连接失败: ${message}` },
      { status: 500 }
    );
  } finally {
    if (overallT) clearTimeout(overallT);
  }
}
