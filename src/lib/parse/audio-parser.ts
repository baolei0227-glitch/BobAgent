import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { ParseResult } from './types';
import { getCache, setCache } from './cache';
import type { SttSettings as SettingsStt } from '@/lib/settings';
import { clipChunks, DIAR_VERSION, ensureDiarization, type DiarChunk, type DiarMode } from '@/lib/stt/diarize';
import {
  PAUSE_MIN_SEC,
  SILENCE_NOISE_DB,
  parseSilenceDetect,
  planChunkCuts,
  type SilenceSpan,
} from './audio-chunking';

const execFileAsync = promisify(execFile);

// ws 动态加载：仅在豆包流式 provider 需要时引入（ws 为运行时依赖）
let _WsCtor: typeof import('ws').default | null = null;
async function getWs(): Promise<typeof import('ws').default> {
  if (!_WsCtor) {
    const mod = await import('ws');
    _WsCtor = mod.default;
  }
  return _WsCtor;
}

// ============================================================
// 音频转写（STT）解析器
//
// 云端 STT（多厂商，用户设置自由选择）：
//   - 火山豆包 doubao  ：https://ark.cn-beijing.volces.com/api/v3
//   - 阿里 DashScope   ：https://dashscope.aliyuncs.com/compatible-mode/v1
//   - SiliconFlow      ：https://api.siliconflow.cn/v1
//   - OpenAI 兼容      ：https://api.openai.com/v1
// 均为 OpenAI 兼容的 POST /audio/transcriptions（multipart），统一适配。
//
// 流程：ffmpeg 转 16kHz 单声道 wav → 按 60s 切片 → 逐段转写（带时间戳）→ hash 缓存
//
// 引擎单选（与设置面板一致）：provider = 'sherpa-local' → 本地离线转写（localModel 明确指定的那一个）；
// 否则走云端（需 provider + API Key）。二者互斥，不做自动回退；都没选则明确报错。
// ============================================================

const CHUNK_SEC = 60; // 单段时长上限（秒）
/**
 * 切块口径版本：并进缓存键。**改切块规则（如 60s 固定网格 → 按停顿分句）必须 +1**，
 * 否则老录音会一直命中旧缓存，用户改了也看不到段落变化。
 * v1 = 无多说话人标签时按停顿切句群（见 audio-chunking.ts）
 */
const CHUNK_VERSION = 1;
const MAX_DURATION_SEC = 30 * 60; // 音频时长上限：30 分钟
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 文件大小上限：100MB
const PROBE_TIMEOUT_MS = 15000;
const CONVERT_TIMEOUT_MS = 120000;
const STT_TIMEOUT_MS = 120000;

/** 静音门限（dB）：峰值低于此值视为没有有效人声。实测纯数字静音 -91 dB、
 *  正常说话峰值 -2 ~ -20 dB，故 -50 dB 对轻声说话仍留足余量。 */
const SILENCE_MAX_VOLUME_DB = -50;

/** 微碎片切片下限（字节）。说话人分离的边界抖动会切出几十毫秒的空块（实测 34ms =
 *  1166 字节），云端 STT 对这类空音频直接返回 HTTP 422（"转写结果为空"），
 *  **一块碎片就足以让整段转写全部失败**（76s 音频只剩这一处报错）。碎片不含可转写
 *  内容，故直接丢弃不送 STT。按 16k 单声道 s16le WAV 的 32000 B/s 折算 0.2s。 */
const MIN_CHUNK_WAV_BYTES = Math.round(0.2 * 16000 * 2);

const AUDIO_MIME_MAP: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wma': 'audio/x-ms-wma',
  '.opus': 'audio/opus',
  '.amr': 'audio/amr',
};

/**
 * 模型名 -> openspeech Resource ID 映射。
 *
 * 火山引擎 openspeech WebSocket 协议的 X-Api-Resource-Id 头需要 Resource ID
 * （如 volc.seedasr.sauc.duration），而非模型名（如 doubao-seed-asr-2.0）。
 * 用户在 Model Pool 中选的是模型名，此处做转换。
 *
 * 参考：https://www.volcengine.com/docs/6561/1354869
 *   doubao-seed-asr-2.0 流式 -> volc.seedasr.sauc.duration（小时版）/ .concurrent（并发版）
 *   doubao-seed-asr-1.0 流式 -> volc.bigasr.sauc.duration / .concurrent
 */
function asrModelToResourceId(model: string | undefined): string | null {
  if (!model) return null;
  // 已经是 Resource ID 格式（volc.*），直接返回
  if (/^volc\./.test(model)) return model;
  const id = model.toLowerCase();
  // 2.0 系列
  if (/seed.?asr.?2|asr.?2\.0/.test(id)) return 'volc.seedasr.sauc.duration';
  // 1.0 系列 / bigasr
  if (/seed.?asr.?1|asr.?1\.0|bigasr/.test(id)) return 'volc.bigasr.sauc.duration';
  // 其他 asr 模型默认按 2.0 走
  if (/asr/.test(id)) return 'volc.seedasr.sauc.duration';
  return null;
}

/** 云端 STT 厂商默认配置 */
const STT_PROVIDERS: Record<string, { label: string; baseUrl: string; model: string }> = {
  doubao: {
    label: 'Doubao',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-asr',
  },
  'doubao-stream': {
    label: 'Doubao Streaming',
    baseUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
    // model 字段存 Resource ID（doubao-seed-asr-2.0 流式语音识别）
    model: 'volc.seedasr.sauc.duration',
  },
  agentplan: {
    label: 'Volcano Ark Agent Plan',
    // Agent Plan 订阅制语音识别走 openspeech.bytedance.com 网关（WebSocket 协议），
    // 端点：/api/v3/plan/sauc/bigmodel_nostream（单流）/ bigmodel_async（双流），路径前缀 /plan/ 表示订阅计费
    baseUrl: 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream',
    model: 'volc.seedasr.sauc.duration',
  },
  codingplan: {
    label: 'Volcano Ark Coding Plan',
    baseUrl: 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream',
    model: 'volc.seedasr.sauc.duration',
  },
  dashscope: {
    label: 'DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'sensevoice-v1',
  },
  siliconflow: {
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
  },
  // 本地 MLX 多模态服务（OpenAI 兼容 /audio/transcriptions，无鉴权）：Qwen3-ASR 离线转写
  bobmultimodal: {
    label: 'BobMultimodal (local MLX)',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'Qwen/Qwen3-ASR-0.6B',
  },
  // 离线本地引擎（sherpa-onnx CLI + 按需下载的模型，见 lib/stt/sherpa）；
  // 不走网络、无需 API Key；与云端互斥单选，由用户在设置里显式指定，不做自动回退
  'sherpa-local': {
    label: 'Local (sherpa-onnx)',
    baseUrl: '',
    model: '',
  },
};

/** 本地无鉴权厂商：baseUrl 指向本机服务，不要求 API Key（与 TTS 侧 NO_AUTH_LOCAL_PROVIDERS 对齐） */
const NO_AUTH_STT_PROVIDERS = new Set(['bobmultimodal']);

function audioMimeType(filePath: string): string {
  return AUDIO_MIME_MAP[path.extname(filePath).toLowerCase()] ?? 'audio/mpeg';
}

/** 解析 ffmpeg -i 输出的 Duration，返回秒数；失败返回 null */
function parseDurationSec(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return h * 3600 + min * 60 + s + ms / 1000;
}

/** 定位 ffmpeg 可执行文件路径（与 video-parser 同策略）；导出供 TTS 参考音转码复用，避免再写一份 */
export async function resolveFfmpegPath(): Promise<string | null> {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath) {
    try {
      await fs.access(envPath);
      return envPath;
    } catch {
      /* 继续 */
    }
  }
  try {
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    const mod = req('@ffmpeg-installer/ffmpeg') as { path?: string };
    if (mod?.path) {
      try {
        await fs.access(mod.path);
        return mod.path;
      } catch {
        /* 继续 */
      }
    }
  } catch {
    /* @ffmpeg-installer 未安装 */
  }
  return null;
}

/** 探测音频时长（秒），失败返回 null */
async function probeDuration(ffmpegPath: string, audioPath: string): Promise<number | null> {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ['-i', audioPath], { timeout: PROBE_TIMEOUT_MS });
    return parseDurationSec(stderr);
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr;
    return stderr ? parseDurationSec(stderr) : null;
  }
}

/** ffmpeg 转 16kHz 单声道 wav，输出到目标路径；range 存在时只转写 [start, end) 秒范围（-ss 快速 seek） */
async function convertToWav(
  ffmpegPath: string,
  src: string,
  out: string,
  range?: { start: number; end: number },
): Promise<void> {
  const args = ['-y'];
  if (range) {
    args.push('-ss', String(range.start), '-i', src, '-t', String(range.end - range.start));
  } else {
    args.push('-i', src);
  }
  args.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out);
  await execFileAsync(ffmpegPath, args, { timeout: CONVERT_TIMEOUT_MS });
}

/** 解析 volumedetect 报告里的 max_volume（dB）；解析失败返回 null */
function parseMaxVolumeDb(stderr: string): number | null {
  const m = stderr.match(/max_volume:\s*(-?inf|[\d.-]+)\s*dB/i);
  if (!m) return null;
  if (/inf/i.test(m[1])) return Number.NEGATIVE_INFINITY;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

/** 用 ffmpeg volumedetect 量整段峰值音量（dB）；测不出来时返回 null（不拦截） */
async function measureMaxVolumeDb(ffmpegPath: string, wavPath: string): Promise<number | null> {
  try {
    const { stderr } = await execFileAsync(
      ffmpegPath,
      ['-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-'],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return parseMaxVolumeDb(stderr);
  } catch (e) {
    // volumedetect 的报告走 stderr，异常退出时也尝试解析
    const stderr = (e as { stderr?: string }).stderr;
    return stderr ? parseMaxVolumeDb(stderr) : null;
  }
}

/** 按 60s 切片 wav（ffmpeg -f segment），返回切片文件列表 */
async function splitWav(ffmpegPath: string, wavPath: string, tmpDir: string): Promise<string[]> {
  const pattern = path.join(tmpDir, 'chunk-%03d.wav');
  await execFileAsync(
    ffmpegPath,
    ['-i', wavPath, '-f', 'segment', '-segment_time', String(CHUNK_SEC), '-c', 'copy', pattern],
    { timeout: CONVERT_TIMEOUT_MS },
  );
  const files = (await fs.readdir(tmpDir)).filter((f) => f.startsWith('chunk-') && f.endsWith('.wav')).sort();
  return files.map((f) => path.join(tmpDir, f));
}

/**
 * 按**指定切点**切片（说话人切块用），一次 ffmpeg 出全部块。
 * cuts = 各切点相对输入起点的秒数（递增）；返回的块数应等于 cuts.length + 1
 * （块 0 = [0, cuts[0])，依此类推，最后一块到输入末尾）。cuts 为空 = 整段就是一块，无需切片。
 */
async function splitWavAt(
  ffmpegPath: string,
  wavPath: string,
  tmpDir: string,
  cuts: number[],
): Promise<string[]> {
  if (cuts.length === 0) return [wavPath];
  const pattern = path.join(tmpDir, 'part-%03d.wav');
  await execFileAsync(
    ffmpegPath,
    [
      '-i', wavPath,
      '-f', 'segment',
      '-segment_times', cuts.map((t) => t.toFixed(3)).join(','),
      '-c', 'copy',
      pattern,
    ],
    { timeout: CONVERT_TIMEOUT_MS },
  );
  const files = (await fs.readdir(tmpDir)).filter((f) => f.startsWith('part-') && f.endsWith('.wav')).sort();
  return files.map((f) => path.join(tmpDir, f));
}

/**
 * 用 ffmpeg silencedetect 找「句间停顿」（结果写在 stderr 上，一次解码遍即可，无模型开销）。
 * 失败 / 一条都没测到都返回空数组：调用方退回固定网格，绝不能因为这一步让转写失败。
 */
async function detectSilences(ffmpegPath: string, wavPath: string): Promise<SilenceSpan[]> {
  const filter = `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${PAUSE_MIN_SEC}`;
  try {
    const { stderr } = await execFileAsync(
      ffmpegPath,
      ['-i', wavPath, '-af', filter, '-f', 'null', '-'],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseSilenceDetect(stderr);
  } catch (e) {
    // 报告走 stderr：异常退出（如 null muxer 的告警）也尽量捞出来
    const stderr = (e as { stderr?: string }).stderr;
    const spans = stderr ? parseSilenceDetect(stderr) : [];
    if (spans.length > 0) return spans;
    console.warn('[audio-parser] 静音检测失败，退回固定切片:', e instanceof Error ? e.message : e);
    return [];
  }
}

async function computeFileHash(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ============================================================
// 云端 STT：OpenAI 兼容 multipart 转写
// ============================================================

/** OpenAI 兼容转写响应（未经校验，字段可能缺失） */
interface TranscriptResponse {
  text?: string;
  result?: string;
  transcription?: Array<{ text?: string }>;
}

/** 解析 OpenAI 兼容转写响应：优先 text，其次 transcription 数组 */
function extractTranscript(json: TranscriptResponse): string {
  if (typeof json?.text === 'string') return json.text;
  if (Array.isArray(json?.transcription)) {
    return json.transcription.map((t) => t?.text || '').join('\n');
  }
  if (typeof json?.result === 'string') return json.result;
  throw new Error('Unparseable transcription response');
}

// ============================================================
// 豆包流式 ASR（openspeech WebSocket 分包协议）
// ============================================================

/** 从 wav 文件字节中提取 PCM 裸流（定位 data chunk；兜底剥标准 44 字节头） */
function extractWavPcm(buf: Buffer): Buffer {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
      off += 8 + size + (size % 2);
    }
  }
  return buf.subarray(44);
}

/**
 * openspeech WebSocket ASR 单段转写（豆包流式 / Agent Plan / Coding Plan 共用）。
 *  - doubao-stream: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel（独立计费）
 *  - agentplan:     wss://openspeech.bytedance.com/api/v3/plan/asr/bidirection（订阅计费）
 *  - codingplan:    同 agentplan
 */
async function wsTranscribeChunk(stt: SettingsStt, wavChunk: string): Promise<string> {
  const Ws = await getWs();
  const provider = stt.provider || 'doubao-stream';
  const preset = STT_PROVIDERS[provider] || STT_PROVIDERS['doubao-stream'];
  // stt.model 可能是模型名（如 doubao-seed-asr-2.0），需转为 Resource ID
  const resourceId = asrModelToResourceId(stt.model) || preset.model;
  const wsUrl = stt.baseUrl || preset.baseUrl;
  if (!stt.apiKey) {
    throw new Error(`No API key for ${preset.label} — set one in Settings → Roles → Audio STT Model.`);
  }
  const audioData = extractWavPcm(await fs.readFile(wavChunk));
  if (audioData.length === 0) throw new Error('Empty audio chunk — nothing to transcribe');

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    // openspeech 鉴权（Agent Plan / Coding Plan / doubao-stream 均用 X-Api-Key，
    // 方舟控制台 API Key 通用；订阅制额外要求 X-Api-Request-Id 与 X-Api-Sequence 头）
    const isPlan = provider === 'agentplan' || provider === 'codingplan';
    const wsHeaders: Record<string, string> = {
      'X-Api-Key': stt.apiKey!,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': randomUUID(),
      ...(isPlan ? { 'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1' } : {}),
    };
    let ws: InstanceType<typeof Ws>;
    try {
      ws = new Ws(wsUrl, { headers: wsHeaders });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      done(() => reject(new Error(`${preset.label} transcription timed out (${STT_TIMEOUT_MS / 1000}s)`)));
    }, STT_TIMEOUT_MS);

    const frameHeader = (msgType: number, flags: number) => Buffer.from([0x11, ((msgType << 4) | flags) & 0xff, 0x10, 0x00]);
    const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
    const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };

    const fullTexts: string[] = [];

    ws.on('open', () => {
      try {
        // 1) full client request（1.0 协议字段）
        const config = {
          user: { uid: 'bob-work' },
          audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1, language: 'zh-CN' },
          request: { model_name: 'bigmodel', reqid: randomUUID(), sequence: -1, nbest: 1, result_type: 'full' },
        };
        const payload = Buffer.from(JSON.stringify(config), 'utf-8');
        ws.send(Buffer.concat([frameHeader(0x01, 0x00), u32(payload.length), payload]));

        // 2) 音频帧：200ms = 6400B（16k×2B×0.2s），seq 从 2 开始（full request 占用 seq=1）
        const FRAME = 6400;
        let seq = 2;
        let lastSeq = 0;
        for (let off = 0; off < audioData.length; off += FRAME, seq++) {
          lastSeq = seq;
          ws.send(Buffer.concat([
            frameHeader(0x02, 0x01),
            u32(seq),
            u32(Math.min(FRAME, audioData.length - off)),
            audioData.subarray(off, off + FRAME),
          ]));
        }
        // 3) 负包：seq = -(最后音频帧 seq + 1)
        ws.send(Buffer.concat([frameHeader(0x02, 0x03), i32(-(lastSeq + 1)), u32(0)]));
      } catch (e) {
        clearTimeout(timer);
        done(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });

    ws.on('message', (data: unknown) => {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (b.length < 12) return;
      const msgType = (b[1] >> 4) & 0x0f;
      const size = b.readUInt32BE(8); // 响应帧：header(4) + seq(4) + size(4) + payload
      let payload = b.subarray(12, 12 + size).toString('utf-8');
      const brace = payload.indexOf('{');
      if (brace > 0) payload = payload.slice(brace);
      if (msgType === 0x09) {
        try {
          const j = JSON.parse(payload);
          if (typeof j?.result?.text === 'string' && j.result.text.trim()) {
            fullTexts.push(j.result.text);
          }
        } catch { /* 单帧解析失败忽略 */ }
      } else if (msgType === 0x0f) {
        clearTimeout(timer);
        done(() => reject(new Error(`${preset.label} error: ${payload.slice(0, 300)}`)));
      }
    });

    ws.on('error', (e: Error) => {
      clearTimeout(timer);
      done(() => reject(new Error(`${preset.label} connection failed: ${e?.message || String(e)}`)));
    });

    ws.on('close', () => {
      clearTimeout(timer);
      const text = (fullTexts[fullTexts.length - 1] || '').trim();
      done(() => (text ? resolve(text) : reject(new Error(`${preset.label} returned an empty transcript`))));
    });
  });
}

async function cloudTranscribe(
  stt: SettingsStt,
  wavChunk: string,
  segmentIndex: number,
  totalSegments: number,
  startOffsetSec: number,
): Promise<string> {
  const provider = stt.provider || 'doubao';
  const preset = STT_PROVIDERS[provider];
  // 未知 provider 明确报错，而不是静默回落到豆包（否则会拿别家 Key 打到火山端点 → 莫名 401）
  if (!preset) {
    throw new Error(`Unknown STT provider: ${provider}. Re-select an engine in Settings → Roles → Audio STT Model.`);
  }
  // 豆包流式 / Agent Plan / Coding Plan 均走 openspeech WebSocket 协议
  //  - doubao-stream: /api/v3/sauc/bigmodel（独立计费）
  //  - agentplan / codingplan: /api/v3/plan/asr/bidirection（订阅计费）
  if (provider === 'doubao-stream' || provider === 'agentplan' || provider === 'codingplan') {
    return wsTranscribeChunk(stt, wavChunk);
  }
  const endpoint = `${stt.baseUrl || preset.baseUrl}/audio/transcriptions`;
  const model = stt.model || preset.model;
  // 本地无鉴权厂商不需要 Key（下方 fetch 已按「有 Key 才带 Authorization」处理）
  if (!stt.apiKey && !NO_AUTH_STT_PROVIDERS.has(provider)) {
    throw new Error(`No API key for ${preset.label} — set one in Settings → Roles → Audio STT Model.`);
  }

  const audioData = await fs.readFile(wavChunk);
  const form = new FormData();
  // 统一命名为 wav，兼容各厂商 multipart 解析
  form.append('file', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  // SenseVoice 等小模型无需额外参数；OpenAI 兼容端点忽略未知字段

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      // 有 Key 才携带 Authorization 头
      headers: stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : undefined,
      body: form,
      signal: controller.signal,
    });
    const raw = await resp.text();
    // 422 = 服务端认得这条请求，但这段音频没有可转写内容（BobMultimodal 对空音频返回
    // 「转写结果为空」/「Cannot compute mel spectrogram of empty audio」）。
    // 按「本段无语音」处理并继续转写其余段——绝不能因为一段空白丢掉整段录音。
    // 全段皆空由下方 `!extracted` 兜底报错；401/403 等鉴权类错误仍按致命处理。
    if (resp.status === 422) return '';
    if (!resp.ok) {
      throw new Error(`${preset.label} returned HTTP ${resp.status}: ${raw.slice(0, 500)}`);
    }
    let json: TranscriptResponse;
    try {
      json = JSON.parse(raw) as TranscriptResponse;
    } catch {
      throw new Error(`${preset.label} returned non-JSON: ${raw.slice(0, 200)}`);
    }
    const text = extractTranscript(json).trim();
    if (!text) {
      throw new Error(`${preset.label} returned an empty transcript (model ${model})`);
    }
    // 多段时给每段加起始时间戳
    if (totalSegments > 1) {
      const mm = String(Math.floor(startOffsetSec / 60)).padStart(2, '0');
      const ss = String(Math.floor(startOffsetSec % 60)).padStart(2, '0');
      return `[${mm}:${ss}]\n${text}`;
    }
    return text;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${preset.label} transcription timed out (${STT_TIMEOUT_MS / 1000}s)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 主入口
// ============================================================

export interface AudioParseOptions {
  /** 云端 STT 配置（未配置时给出明确报错） */
  stt?: SettingsStt;
  /** 转写范围（秒，含 start 不含 end）；缺省转写整个音频。供长音频按块转写使用 */
  rangeStartSec?: number;
  rangeEndSec?: number;
  /** 说话人分离模式（缺省 = 不分离）。开启后按说话人切块转写、每段行头加 `[说话人 N]`。
   *  分离不可用或失败会自动退回固定 60s 的无标签链路——分离是增强项，绝不阻断转写。 */
  diarize?: DiarMode;
}

/** 探测音频时长（秒），ffmpeg 不可用时返回 null */
export async function probeAudioDurationSec(audioPath: string): Promise<number | null> {
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) return null;
  return probeDuration(ffmpegPath, audioPath);
}

/**
 * 转写音频：按设置的引擎单选走云端厂商或本地离线模型。
 * 结果按音频内容 hash 缓存（.cache/parse/）。传入 rangeStartSec/rangeEndSec 时只转写该时间范围（缓存键含范围）。
 */
export async function parseAudio(
  audioPath: string,
  projectPath: string,
  options: AudioParseOptions = {},
): Promise<ParseResult> {
  const fileName = path.basename(audioPath);
  const mimeType = audioMimeType(audioPath);
  const fileHash = await computeFileHash(audioPath);

  // 转写范围（秒）：供长音频按块转写；缓存键并入范围，同一文件不同块互不串扰
  const range =
    typeof options.rangeStartSec === 'number' && typeof options.rangeEndSec === 'number'
      ? { start: Math.max(0, options.rangeStartSec), end: Math.max(options.rangeStartSec, options.rangeEndSec) }
      : null;
  // 缓存键：范围 + 分离参数 + 切块口径都要并入。分离键带 DIAR_VERSION，模型/切块参数一变旧结果自然失效；
  // 未开分离的旧键与分离键天然隔离（降级结果**不**写分离键，否则模型下载好会一直命中无标签旧缓存）
  const diarKey = options.diarize ? `-d${DIAR_VERSION}-${options.diarize}` : '';
  const cacheKey = `${range ? `${fileHash}-r${range.start}-${range.end}` : fileHash}${diarKey}-c${CHUNK_VERSION}`;

  const cached = await getCache(cacheKey, projectPath);
  if (cached) {
    return {
      ...cached.result,
      file_name: fileName,
      mime_type: mimeType,
      parsed_at: cached.result.parsed_at,
    };
  }

  const fileStat = await fs.stat(audioPath);
  // 空文件先拦下：ffmpeg 对它只会吐一段 "Format mp3 detected only with low score / Invalid argument" 的原始报错，
  // 看不出根因（历史：用户拿到 0 字节录音后，整条链路报错被误判成「格式不支持」）
  if (fileStat.size === 0) {
    throw new Error(`This audio file is empty (0 bytes) — nothing to transcribe. Re-record it or upload a valid audio file: ${fileName}`);
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`Audio file exceeds the ${MAX_FILE_BYTES / 1024 / 1024}MB limit — transcription refused.`);
  }

  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg unavailable: no bundled binary found and none on PATH — cannot transcribe audio.');
  }

  const sttRaw = options.stt;
  // 凭据继承 Model Pool 同名厂商（显式覆盖优先）：stt.apiKey/baseUrl 留空时自动复用
  // Model Pool 中同一厂商（doubao/dashscope→qwen/siliconflow/openai）已配置的 Key
  let stt = sttRaw;
  // 只对「已知云端厂商」做凭据继承：未知 provider（如已下线的 bobmultimodal）不再回落到豆包，
  // 否则会拿着别家的 Key 打到火山端点、抛一个看不出根因的 401
  const sttPreset = sttRaw?.provider && sttRaw.provider !== 'sherpa-local' ? STT_PROVIDERS[sttRaw.provider] : undefined;
  if (sttRaw && sttPreset) {
    try {
      const { readSettingsFromFile } = await import('@/lib/settings-server');
      const { resolveRoleCredential } = await import('@/lib/models/role-credential');
      const s = await readSettingsFromFile();
      const cred = resolveRoleCredential(s, {
        roleProvider: sttRaw.provider,
        explicitApiKey: sttRaw.apiKey,
        explicitBaseUrl: sttRaw.baseUrl,
        presetBaseUrl: sttPreset.baseUrl,
      });
      // 有 key：继承 Model Pool 同名厂商凭据；无 key 时也补上 baseUrl（后续缺 Key 会给出明确报错）
      stt = { ...sttRaw, baseUrl: sttRaw.baseUrl || cred.baseUrl || sttPreset.baseUrl };
      if (cred.apiKey) {
        stt = { ...stt, apiKey: cred.apiKey };
      }
    } catch { /* 读取失败时保持原始 stt，cloudTranscribe 会给出明确未配置提示 */ }
  }
  // 云端可用 = 已知云端厂商 + 有 Key（本地无鉴权厂商免 Key；sherpa-local 走本地离线引擎，不在此列）
  const cloudAvailable = !!sttPreset && (!!stt?.apiKey || NO_AUTH_STT_PROVIDERS.has(stt?.provider || ''));

  // 引擎单选：provider='sherpa-local' → 本地离线（localModel 明确指定的那一个），否则必须云端已配 Key。
  // 二者互斥、不做自动回退：设置面板里选了哪个就用哪个，没选就明确报错。
  const sherpaMod = stt?.provider === 'sherpa-local' ? await import('@/lib/stt/sherpa') : null;
  const localModelId = sherpaMod ? (stt?.localModel || '') : '';
  if (sherpaMod) {
    if (!localModelId) {
      throw new Error('No local offline model selected. Pick one in Settings → Roles → Audio STT Model.');
    }
    if (!(await sherpaMod.isLocalSttModelReady(localModelId))) {
      throw new Error(`Local STT model not ready: ${localModelId}. Download it in Settings → Roles → Audio STT Model.`);
    }
  } else if (!cloudAvailable) {
    throw new Error('No STT engine configured. Pick one in Settings → Roles → Audio STT Model: a cloud model (API key required) or a local offline model.');
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-audio-'));
  const wavPath = path.join(tmpDir, 'audio.wav');
  const startTime = Date.now();
  try {
    await convertToWav(ffmpegPath, audioPath, wavPath, range ?? undefined);
    // 静音门限：离线模型对静音会硬造文本（实测 SenseVoice 在 1s 纯静音上输出 "그."），
    // 故先量峰值音量，过低直接判空——绝不把静音喂给模型。
    const maxVolumeDb = await measureMaxVolumeDb(ffmpegPath, wavPath);
    if (maxVolumeDb !== null && maxVolumeDb < SILENCE_MAX_VOLUME_DB) {
      throw new Error('No speech detected — the recording is silent (input level too low).');
    }
    // 探测实际转写时长：range 块取切好的 wav，整段取原音频
    const duration = range
      ? await probeDuration(ffmpegPath, wavPath)
      : await probeDuration(ffmpegPath, audioPath);
    if (duration !== null && duration > MAX_DURATION_SEC) {
      throw new Error(`Audio is ${Math.round(duration)}s — over the ${MAX_DURATION_SEC}s (30 min) limit, transcription refused.`);
    }

    // 说话人分离（可选增强）：对**整段**音频只跑一次（结果按文件哈希缓存、跨窗口/跨次复用），
    // 再按当前转写范围切片——分窗口各跑一次会让「第 2 个窗口的说话人 1」变成另一个人。
    const diarChunks: DiarChunk[] | null = options.diarize
      ? await ensureDiarization(audioPath, projectPath, options.diarize, { ffmpegPath })
      : null;
    const clipped = diarChunks ? clipChunks(diarChunks, range) : [];
    // 只有出现 ≥2 位说话人才贴标签：全场一个人还逐段标「说话人 1」纯属噪音
    const speakers = new Set(clipped.map((c) => c.speaker).filter((s): s is number => s !== null));
    const multiSpeaker = speakers.size >= 2;
    if (options.diarize && !multiSpeaker) {
      console.warn(`[audio-parser] 未取得多说话人标签（${fileName}），退回固定 ${CHUNK_SEC}s 无标签链路`);
    }

    const baseOffset = range ? range.start : 0;
    // 切块：有说话人标签就按分离切点一次切完；否则按**停顿**切句群（本地批量引擎），
    // 再不行才退回固定 60s 网格。
    //
    // 为什么不再无条件用固定 60s 网格：那会让「短于 60s 的录音」只有一块 → 连 `[mm:ss]` 都不输出
    // （下面 `segCount > 1` 才写戳）→ 会议记录变成一整坨没有段落、没有时间轴的正文，回放也丢掉
    // 「点一句跳到那一刻」。按停顿切句群后，段首时间戳落在下一句开口处，段落与朗读节奏一致。
    // 云端 STT 仍走固定网格：那边是**按段计费/计延迟**的，切碎得不偿失（本地批量引擎一次调用
    // 能转多个文件，切碎几乎不加成本，见 sherpaTranscribeMany）。
    let parts: string[];
    let starts: number[];
    let labeled = false;
    if (multiSpeaker) {
      const cuts = clipped.slice(0, -1).map((c) => c.end - baseOffset);
      const bySpeaker = await splitWavAt(ffmpegPath, wavPath, tmpDir, cuts);
      if (bySpeaker.length === clipped.length) {
        parts = bySpeaker;
        starts = clipped.map((c) => c.start); // 真实块起点（不是 i × 60s 的网格）
        labeled = true;
      } else {
        // 切点数与块数不吻合（异常边界）：退回固定网格——宁可不贴标签，也绝不错位贴错误的说话人
        console.warn(`[audio-parser] 说话人切块数与切片数不符（${clipped.length} vs ${bySpeaker.length}），退回固定 ${CHUNK_SEC}s`);
        parts = await splitWav(ffmpegPath, wavPath, tmpDir);
        starts = parts.map((_, i) => baseOffset + i * CHUNK_SEC);
      }
    } else {
      const durationForCuts = duration ?? (await probeDuration(ffmpegPath, wavPath));
      const cuts = sherpaMod && durationForCuts
        ? planChunkCuts(await detectSilences(ffmpegPath, wavPath), durationForCuts)
        : [];
      if (cuts.length > 0) {
        parts = await splitWavAt(ffmpegPath, wavPath, tmpDir, cuts);
        // 块起点 = 上一个切点（块 0 从 0 起），块数应等于 cuts.length + 1
        starts = [0, ...cuts].map((t) => baseOffset + t);
      } else {
        parts = await splitWav(ffmpegPath, wavPath, tmpDir);
        starts = parts.map((_, i) => baseOffset + i * CHUNK_SEC);
      }
    }
    if (parts.length === 0) {
      throw new Error('Audio splitting failed: no audio stream could be extracted (corrupt file or unsupported codec).');
    }

    // 丢弃微碎片切片（见 MIN_CHUNK_WAV_BYTES）：保留原下标，说话人标签仍按原下标取
    const keepIdx: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const stat = await fs.stat(parts[i]).catch(() => null);
      if ((stat?.size ?? 0) >= MIN_CHUNK_WAV_BYTES) keepIdx.push(i);
    }
    const segCount = keepIdx.length;

    const transcripts: string[] = [];

    // 本地批量引擎：**一次调用转多个片段**（模型只加载一次）。
    // 按停顿切句后片段数会到几十个，而 CLI 每次 spawn 都要重载模型（实测 1 个文件 1.68s、
    // 3 个文件 1.77s）——逐段调用会把分钟级任务拖成十几分钟。
    // 批量失败（行数不符等）不致命：退回逐段转写，结果口径完全一致。
    let batchTexts: string[] | null = null;
    if (sherpaMod && keepIdx.length > 1) {
      try {
        batchTexts = await sherpaMod.sherpaTranscribeMany(keepIdx.map((i) => parts[i]), localModelId);
      } catch (e) {
        console.warn('[audio-parser] 批量转写失败，退回逐段转写:', e instanceof Error ? e.message : e);
        batchTexts = null;
      }
    }

    for (let k = 0; k < keepIdx.length; k++) {
      const i = keepIdx[k];
      const startOffset = starts[i];
      // 引擎单选：要么本地离线，要么云端，二者互斥（无回退）
      let segText = batchTexts
        ? batchTexts[k] ?? ''
        : sherpaMod
          ? await sherpaMod.sherpaTranscribe(parts[i], localModelId)
          : await cloudTranscribe(stt!, parts[i], i, segCount, startOffset);

      if (segText) {
        // 多段时统一带时间戳前缀（便于定位音频位置）。
        // 说话人标签必须**另起一行**：回放的段起点正则要求 `[mm:ss]` 独占一行（MeetingReplay.parseSegments）
        if (segCount > 1) {
          const mm = String(Math.floor(startOffset / 60)).padStart(2, '0');
          const ss = String(Math.floor(startOffset % 60)).padStart(2, '0');
          const speaker = labeled ? clipped[i].speaker : null;
          const head = speaker === null ? `[${mm}:${ss}]` : `[${mm}:${ss}]\n[说话人 ${speaker + 1}]`;
          segText = `${head}\n${segText}`;
        }
        transcripts.push(segText);
      }
    }

    const extracted = transcripts.join('\n\n').trim();
    if (!extracted) {
      throw new Error('Empty transcript — no speech detected.');
    }

    // 标签即选定的引擎（云端 / 本地互斥单选）
    const providerLabel = sherpaMod
      ? `${STT_PROVIDERS['sherpa-local'].label} · ${localModelId}`
      : STT_PROVIDERS[stt?.provider || 'doubao']?.label || 'Cloud STT';
    // 分离是增强项：开了但没贴成标签时在抬头留痕，避免用户以为「下载了却没生效」而无从排查
    const diarNote = options.diarize ? (labeled ? `，按说话人分块（${speakers.size} 人）` : '，未分说话人') : '';

    const result: ParseResult = {
      file_name: fileName,
      file_type: 'audio',
      mime_type: mimeType,
      extracted_text: `音频转写（${providerLabel}${duration !== null ? `，时长 ${Math.round(duration)}s` : ''}${range ? `，范围 ${range.start}s-${range.end}s` : ''}${segCount > 1 ? `，${segCount} 段拼接` : ''}${diarNote}）:\n\n${extracted}`,
      // 纯正文（不含抬头与 [mm:ss] 时间戳）：录音回填输入框等场景直接使用
      plain_text: extracted,
      parse_method: 'stt',
      parsed_at: new Date().toISOString(),
      stats: { duration_ms: Date.now() - startTime, input_tokens: 0, output_tokens: 0 },
      file_hash: fileHash,
    };

    await setCache(cacheKey, result, projectPath);
    return result;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
