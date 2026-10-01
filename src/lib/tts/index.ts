/**
 * lib/tts/index.ts — 语音合成（TTS）引擎
 *
 * 与 STT（audio-parser）对称：云端多厂商，统一适配 **OpenAI 兼容 POST /audio/speech**
 * （JSON 请求体：model / input / voice / response_format / speed，返回音频二进制）。
 *
 * 已验证该协议的厂商（其余厂商接入前先确认兼容性，勿凭猜加）：
 *   - openai       ：https://api.openai.com/v1/audio/speech（tts-1 / tts-1-hd / gpt-4o-mini-tts）
 *   - siliconflow  ：https://api.siliconflow.cn/v1/audio/speech（fishaudio 系音色）
 *   - bobmultimodal：本地 MLX 服务的 OpenAI 兼容端点（Qwen3-TTS）；
 *                    注意 voice 是固定枚举（缺省 vivian）、response_format 被忽略恒返 WAV，见下方两个 Set
 *   - 自定义兼容端点：TtsSettings.baseUrl 覆盖
 *   - sherpa-local ：**本地神经 TTS**（sherpa-onnx offline，离线，见 ./sherpa-local），不走 HTTP
 *
 * 设计约束：
 *   - 未配置任何引擎（provider 非本地引擎 且无 model）→ 抛带明确指引的 TtsNotConfiguredError，
 *     调用方转成 "请先在设置里配置 TTS"，不静默失败（合成失败假装成功比报错更糟）；
 *   - 本地引擎（sherpa-local）：仅当 provider 显式等于对应标识时使用，不做自动兜底；
 *   - 单次合成文本上限 2000 字符（超长请分次）；
 *   - 产物落 <APP_ROOT>/butler/tts/<时间戳>-<hash>.<ext>，由调用方决定进附件/微信/面板播放。
 */
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import type { TtsSettings } from '@/lib/settings';
import { resolveAppRoot } from '@/lib/app-root';
import { synthesizeWithSherpa, SHERPA_LOCAL_PROVIDER } from './sherpa-local';

/** 本地神经 TTS（sherpa-onnx）厂商标识——定义在 ./sherpa-local，原样对外转出 */
export { SHERPA_LOCAL_PROVIDER };

/** 本地引擎厂商标识（无 model 概念，须绕过"无 model 即未配置"判定） */
export function isLocalTtsProvider(provider: string | undefined): boolean {
  return provider === SHERPA_LOCAL_PROVIDER;
}

/** TTS 未配置（调用方可据此转为用户可读指引） */
export class TtsNotConfiguredError extends Error {
  constructor() {
    super(
      'TTS is not configured. Pick one engine in Settings → Roles → Audio TTS Model: ' +
        'a cloud model (API key required) or the offline neural model.',
    );
    this.name = 'TtsNotConfiguredError';
  }
}

/** 厂商默认端点（OpenAI 兼容 /audio/speech） */
const TTS_PROVIDER_PRESETS: Record<string, { baseUrl: string; model: string; voice: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'fishaudio/fish-speech-1.5', voice: 'fishaudio/fish-speech-1.5:alex' },
  // BobMultimodal：本地 MLX（无鉴权）。voice 必须是固定枚举之一，缺省发 'alloy' 会 500，故预设为服务端默认 'vivian'
  bobmultimodal: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', voice: 'vivian' },
};

/** 忽略 response_format、恒返 WAV 的厂商：强制按 wav 落盘，否则 WAV 字节会被写成 .mp3 导致播放失败 */
const WAV_ONLY_TTS_PROVIDERS = new Set(['bobmultimodal']);

/** 额外支持 `language` 参数的厂商（BobMultimodal / Qwen3-TTS）；OpenAI 兼容端点不带该字段 */
const LANGUAGE_AWARE_TTS_PROVIDERS = new Set(['bobmultimodal']);

/** 粗判合成语言：含 CJK 汉字按中文，其余按英文（仅上述 LANGUAGE_AWARE 厂商使用） */
function detectSpeechLanguage(text: string): string {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text) ? 'Chinese' : 'English';
}

const MAX_TEXT_CHARS = 2000;

export interface SynthesizeResult {
  /** 产物绝对路径 */
  filePath: string;
  /** 音频字节长度 */
  bytes: number;
  /** 实际使用的格式 */
  format: string;
  /** 合成耗时 ms */
  durationMs: number;
}

/**
 * 凭据继承（与 STT 的 audio-parser 同款）：tts.apiKey/baseUrl 留空时，
 * 从 Model Pool 同名厂商（openai/siliconflow）继承已配置的 Key/BaseUrl。
 * 这样设置面板只需选模型，不必为 TTS 单独填 Key。
 */
async function resolveCredentials(settings: TtsSettings): Promise<TtsSettings> {
  if (settings.apiKey && settings.baseUrl) return settings;
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const { resolveRoleCredential } = await import('@/lib/models/role-credential');
    const s = await readSettingsFromFile();
    const provider = (settings.provider || 'openai').toLowerCase();
    const preset = TTS_PROVIDER_PRESETS[provider];
    const cred = resolveRoleCredential(s, {
      roleProvider: provider,
      explicitApiKey: settings.apiKey,
      explicitBaseUrl: settings.baseUrl,
      presetBaseUrl: preset?.baseUrl,
    });
    return {
      ...settings,
      apiKey: settings.apiKey || cred.apiKey || undefined,
      baseUrl: settings.baseUrl || cred.baseUrl || undefined,
    };
  } catch {
    return settings; // 读取失败保持原样，下方合成时给出明确报错
  }
}

/**
 * 合成语音并落盘（本地神经引擎或云端 OpenAI 兼容端点）。
 * @throws TtsNotConfiguredError 云端未配置 model 且本地引擎不可用
 * @throws Error 合成失败（含厂商响应体摘要，便于定位 Key/模型/音色问题）
 */
export async function synthesizeSpeech(text: string, rawSettings?: TtsSettings): Promise<SynthesizeResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty TTS input — nothing to synthesize');
  if (trimmed.length > MAX_TEXT_CHARS) {
    throw new Error(`TTS text too long (${trimmed.length} > ${MAX_TEXT_CHARS} chars) — split it into smaller parts`);
  }

  // 本地神经 TTS（sherpa-onnx）：仅当 provider='sherpa-local' 时使用，无 model 概念，
  // 须绕过下方 "无 model 即未配置" 判定；模型 id 从 localModel 取。
  if (rawSettings?.provider === SHERPA_LOCAL_PROVIDER) {
    return synthesizeWithSherpa(trimmed, {
      modelId: rawSettings?.localModel ?? '',
      speed: rawSettings?.speed,
      // 多音色预置的音色 id；未知/缺省由合成层回落到模型首条
      voice: rawSettings?.localVoice,
      // 零样本克隆（ZipVoice）的参考音：内置/自定义统一为绝对路径；缺失时合成阶段会给明确错误
      reference: rawSettings?.localRefAudio
        ? { audio: rawSettings.localRefAudio, text: rawSettings.localRefText ?? '' }
        : undefined,
    });
  }

  if (!rawSettings?.model) throw new TtsNotConfiguredError();

  // 凭据继承 Model Pool 同名厂商（显式覆盖优先）——设置面板只选模型不填 Key 也能用
  const settings = await resolveCredentials(rawSettings);

  const provider = (settings.provider || 'openai').toLowerCase();
  const preset = TTS_PROVIDER_PRESETS[provider];
  const baseUrl = settings.baseUrl?.trim() || preset?.baseUrl;
  if (!baseUrl) throw new Error(`TTS provider "${provider}" has no preset endpoint and no baseUrl is set`);

  const model = settings.model;
  const voice = settings.voice?.trim() || preset?.voice || 'alloy';
  // 恒返 WAV 的厂商无视 response_format，须按 wav 落盘（否则 .mp3 里装的是 WAV 字节）
  const format = WAV_ONLY_TTS_PROVIDERS.has(provider) ? 'wav' : settings.format ?? 'mp3';

  const t0 = Date.now();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 本地无鉴权端点（baseUrl 指向本机）允许无 Key；云端必须带 Key
      ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      input: trimmed,
      voice,
      response_format: format,
      ...(typeof settings.speed === 'number' ? { speed: settings.speed } : {}),
      // 支持 language 的厂商按文本粗判语种（缺省 English，中文文本会被当英文合成）
      ...(LANGUAGE_AWARE_TTS_PROVIDERS.has(provider) ? { language: detectSpeechLanguage(trimmed) } : {}),
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(
      `TTS synthesis failed (HTTP ${res.status}): ${errBody.slice(0, 300) || '(empty body)'} — check that apiKey / model / voice match the provider docs`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('TTS returned empty audio (provider error) — retry or switch model');

  // 落盘：<APP_ROOT>/butler/tts/<时间戳>-<hash8>.<format>
  const dir = join(resolveAppRoot(), 'butler', 'tts');
  await mkdir(dir, { recursive: true });
  const hash = createHash('sha256').update(trimmed).digest('hex').slice(0, 8);
  const filePath = join(dir, `${Date.now()}-${hash}.${format}`);
  await writeFile(filePath, buf);

  return { filePath, bytes: buf.length, format, durationMs: Date.now() - t0 };
}
