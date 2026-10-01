/**
 * 模型标注共用规则（单一来源）
 *
 * API 标注（/api/models）、前端分类恢复（SettingsModal）、能力推断（model-matcher）
 * 三处统一引用本文件的规则，避免正则各自维护导致漂移（如 kimi-k3 曾只有后端识别、
 * OpenAI/Claude 新版多模态全部漏标）。
 */

/** 视觉（多模态）模型判定：模型名包含这些关键词/系列名时视为支持图像输入理解。
 *  覆盖：vision/vl/visual 关键词系列、OpenAI 4o/4-turbo/4.1/4.5/5/o 系列、
 *  Claude 3/4 全系、Gemini 全系（原生多模态）、千问 VL/Omni、智谱 GLM-4v/4.5v/5v 全系、
 *  阶跃 step-1v/1o、Janus、Gemma 3/4、Kimi K3、Llama 4、Grok 2/3/4、Ovis 等
 *  注意：OCR 专用模型（见 OCR_MODEL_PATTERN）不在此列——它们只能转录文字，
 *  不支持通用视觉理解，不能作为视觉模型/角色使用。 */
export const VISION_MODEL_PATTERN =
  /vision|vl|multimodal|多模态|visual|gpt-4[.\-]?(?:o|turbo|[15])|gpt-5|\bo[1-4](?:[.\-]|mini|preview|$)|claude-[34]|gemini|qvq|qwen.*(?:vl|omni|vision)|qwen[34](?:\.[\d]+)?-?max|glm-\d+(?:[.\-]\d+)?[.\-]?v|step-1[vo]|janus|gemma-[34]|kimi.*k3|llama-4|grok-[234]|ovis|minicpm[.\-]?[vo]|llava|bakllava|moondream|paligemma|smolvlm|intern[.\-]?vl|deepseek[.\-]?vl/i;

/** OCR 专用模型判定：这些模型仅做文档/表格文字转录（qwen-vl-ocr、qwen3.5-ocr、
 *  deepseek-ocr、vanchin/*-ocr 等），不适用于通用视觉理解/看图对话。
 *  优先级必须高于 VISION_MODEL_PATTERN（如 qwen-vl-ocr 同时含 vl 与 ocr）。 */
export const OCR_MODEL_PATTERN = /ocr/i;

/** 是否 OCR 专用模型 */
export const isOcrModel = (id: string): boolean => OCR_MODEL_PATTERN.test((id || '').toLowerCase());

/** 是否通用视觉模型：排除 OCR 专用模型（它们在视觉角色/候选池中无法正常工作） */
export const isVisionModel = (id: string): boolean =>
  VISION_MODEL_PATTERN.test((id || '').toLowerCase()) && !isOcrModel(id);

/** 语音合成（TTS）模型判定：用于把 audio 分类再分成「合成」与「识别」。
 *  /api/models 的 audio 正则（tts|asr|whisper|speech|qwen-audio）把两类混在一起，
 *  导致 TTS 模型会混进 STT 角色候选池（反之亦然）。命中本规则视为 TTS，否则视为 STT。 */
export const TTS_MODEL_PATTERN = /tts|fishaudio|speech-1\.5|cosyvoice|chattts|melotts|vits|kokoro|zipvoice|f5-tts|index-tts/i;

/** 是否语音合成模型（audio 分类内与语音识别区分） */
export const isTtsModel = (id: string): boolean => TTS_MODEL_PATTERN.test((id || '').toLowerCase());

/** 非对话模型排除正则（Butler 会话选型用）：视觉 / 向量 / 重排 / 音频（含 TTS、ASR）不参与对话。
 *  单一来源：服务端自动选型（lib/butler/entry.ts）与抽屉模型下拉共用，两处不会漂移。 */
export const NON_CHAT_MODEL_PATTERN = /vision|vl|embedding|rerank|audio/i;

/** 是否可用作**对话**模型（自动选型 / 模型下拉的过滤判据） */
export const isChatModel = (id: string): boolean => !NON_CHAT_MODEL_PATTERN.test((id || '').toLowerCase());

/** 厂商推断（按模型 id 前缀/关键词，兼容聚合平台的 "system" 占位 owned_by） */
export const MODEL_VENDOR_PATTERNS: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /^(?:qwen|qvq|qwq|tongyi|wan|z-image|gui-|fun-asr|codeqwen|florence)/i, vendor: 'Qwen' },
  { pattern: /^kimi\//i, vendor: 'Kimi' },
  { pattern: /^moonshotai\//i, vendor: 'Kimi' },
  { pattern: /^minimax\//i, vendor: 'MiniMax' },
  { pattern: /^zhipu\//i, vendor: 'Zhipu GLM' },
  { pattern: /^xiaomi\//i, vendor: 'Xiaomi' },
  { pattern: /^vanchin\//i, vendor: 'Vanchin' },
  { pattern: /^siliconflow\//i, vendor: 'SiliconFlow' },
  { pattern: /^deepseek/i, vendor: 'DeepSeek' },
  { pattern: /^glm/i, vendor: 'Zhipu GLM' },
  { pattern: /^kimi/i, vendor: 'Kimi' },
  { pattern: /^minimax/i, vendor: 'MiniMax' },
  { pattern: /^mimo/i, vendor: 'Xiaomi' },
];

/** 厂商中文名/别名 → 标准英文名（聚合平台 owned_by 常返回中文，前端打标签需统一为英文） */
const VENDOR_NAME_ALIASES: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /智谱|zhipu|bigmodel/i, vendor: 'Zhipu GLM' },
  { pattern: /月之暗面|moonshot/i, vendor: 'Kimi' },
  { pattern: /稀宇|minimax/i, vendor: 'MiniMax' },
  { pattern: /深度求索|deepseek/i, vendor: 'DeepSeek' },
  { pattern: /阿里|千问|通义|dashscope|qwen/i, vendor: 'Qwen' },
  { pattern: /字节|豆包|火山|doubao/i, vendor: 'Doubao' },
  { pattern: /硅基流动|siliconflow/i, vendor: 'SiliconFlow' },
  { pattern: /小米|xiaomi/i, vendor: 'Xiaomi' },
  { pattern: /万链|vanchin/i, vendor: 'Vanchin' },
  { pattern: /openai/i, vendor: 'OpenAI' },
  { pattern: /百度|文心|ernie/i, vendor: 'Baidu' },
  { pattern: /腾讯|混元|hunyuan/i, vendor: 'Tencent' },
];

/** 厂商名统一为英文：命中别名表返回标准英文名，否则返回原值（trim 后） */
export const normalizeVendorName = (v: string): string => {
  const raw = (v || '').trim();
  if (!raw) return raw;
  const hit = VENDOR_NAME_ALIASES.find((a) => a.pattern.test(raw));
  return hit ? hit.vendor : raw;
};
