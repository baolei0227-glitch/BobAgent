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
// ============================================================

const CHUNK_SEC = 60; // 单段时长上限（秒）
const MAX_DURATION_SEC = 30 * 60; // 音频时长上限：30 分钟
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 文件大小上限：100MB
const PROBE_TIMEOUT_MS = 15000;
const CONVERT_TIMEOUT_MS = 120000;
const STT_TIMEOUT_MS = 120000;

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
    label: '火山豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-asr',
  },
  'doubao-stream': {
    label: '豆包流式',
    baseUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
    // model 字段存 Resource ID（doubao-seed-asr-2.0 流式语音识别）
    model: 'volc.seedasr.sauc.duration',
  },
  agentplan: {
    label: '火山方舟 Agent Plan',
    // Agent Plan 订阅制语音识别走 openspeech.bytedance.com 网关（WebSocket 协议），
    // 端点：/api/v3/plan/sauc/bigmodel_nostream（单流）/ bigmodel_async（双流），路径前缀 /plan/ 表示订阅计费
    baseUrl: 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream',
    model: 'volc.seedasr.sauc.duration',
  },
  codingplan: {
    label: '火山方舟 Coding Plan',
    baseUrl: 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream',
    model: 'volc.seedasr.sauc.duration',
  },
  dashscope: {
    label: '阿里 DashScope',
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
  bobmultimodal: {
    label: 'BobMultimodal (本地)',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'Qwen/Qwen3-ASR-0.6B',
  },
};

/** 本地无鉴权 STT 厂商（无需 API Key，走 OpenAI 兼容 /audio/transcriptions，如 BobMultimodal） */
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

/** 定位 ffmpeg 可执行文件路径（与 video-parser 同策略） */
async function resolveFfmpegPath(): Promise<string | null> {
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
  throw new Error('转写响应格式无法解析');
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
    throw new Error(`未配置 ${preset.label} 的 API Key（设置 → 角色派发 → 音频转写模型）`);
  }
  const audioData = extractWavPcm(await fs.readFile(wavChunk));
  if (audioData.length === 0) throw new Error('音频切片为空，无法转写');

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
      done(() => reject(new Error(`${preset.label} 转写超时（${STT_TIMEOUT_MS / 1000}s）`)));
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
        done(() => reject(new Error(`${preset.label} 错误: ${payload.slice(0, 300)}`)));
      }
    });

    ws.on('error', (e: Error) => {
      clearTimeout(timer);
      done(() => reject(new Error(`${preset.label} 连接失败: ${e?.message || String(e)}`)));
    });

    ws.on('close', () => {
      clearTimeout(timer);
      const text = (fullTexts[fullTexts.length - 1] || '').trim();
      done(() => (text ? resolve(text) : reject(new Error(`${preset.label} 转写结果为空`))));
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
  const preset = STT_PROVIDERS[provider] || STT_PROVIDERS.doubao;
  // 豆包流式 / Agent Plan / Coding Plan 均走 openspeech WebSocket 协议
  //  - doubao-stream: /api/v3/sauc/bigmodel（独立计费）
  //  - agentplan / codingplan: /api/v3/plan/asr/bidirection（订阅计费）
  if (provider === 'doubao-stream' || provider === 'agentplan' || provider === 'codingplan') {
    return wsTranscribeChunk(stt, wavChunk);
  }
  const endpoint = `${stt.baseUrl || preset.baseUrl}/audio/transcriptions`;
  const model = stt.model || preset.model;
  const noAuth = NO_AUTH_STT_PROVIDERS.has(provider);
  if (!stt.apiKey && !noAuth) {
    throw new Error(`未配置 ${preset.label} 的 API Key（设置 → 角色派发 → 音频转写模型）`);
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
      // 本地无鉴权厂商（BobMultimodal）不携带 Authorization 头
      headers: stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : undefined,
      body: form,
      signal: controller.signal,
    });
    const raw = await resp.text();
    if (!resp.ok) {
      throw new Error(`${preset.label} HTTP ${resp.status}: ${raw.slice(0, 500)}`);
    }
    let json: TranscriptResponse;
    try {
      json = JSON.parse(raw) as TranscriptResponse;
    } catch {
      throw new Error(`${preset.label} 返回非 JSON: ${raw.slice(0, 200)}`);
    }
    const text = extractTranscript(json).trim();
    if (!text) {
      throw new Error(`${preset.label} 转写结果为空（模型 ${model}）`);
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
      throw new Error(`${preset.label} 转写超时（${STT_TIMEOUT_MS / 1000}s）`);
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
}

/** 探测音频时长（秒），ffmpeg 不可用时返回 null */
export async function probeAudioDurationSec(audioPath: string): Promise<number | null> {
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) return null;
  return probeDuration(ffmpegPath, audioPath);
}

/**
 * 转写音频：仅云端 STT（用户配置的厂商）。
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
  const cacheKey = range ? `${fileHash}-r${range.start}-${range.end}` : fileHash;

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
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`音频文件超过大小上限（${MAX_FILE_BYTES / 1024 / 1024}MB），拒绝转写。`);
  }

  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg 不可用：未找到内置二进制且系统 PATH 中无 ffmpeg，无法转写音频。');
  }

  const sttRaw = options.stt;
  // 凭据继承 Model Pool 同名厂商（显式覆盖优先）：stt.apiKey/baseUrl 留空时自动复用
  // Model Pool 中同一厂商（doubao/dashscope→qwen/siliconflow/openai）已配置的 Key
  let stt = sttRaw;
  if (sttRaw?.provider) {
    try {
      const { readSettingsFromFile } = await import('@/lib/settings-server');
      const { resolveRoleCredential } = await import('@/lib/models/role-credential');
      const s = await readSettingsFromFile();
      const preset = STT_PROVIDERS[sttRaw.provider] || STT_PROVIDERS.doubao;
      const cred = resolveRoleCredential(s, {
        roleProvider: sttRaw.provider,
        explicitApiKey: sttRaw.apiKey,
        explicitBaseUrl: sttRaw.baseUrl,
        presetBaseUrl: preset.baseUrl,
      });
      // 有 key：继承 Model Pool 同名厂商凭据；无 key 的本地厂商（BobMultimodal）也补上 baseUrl
      stt = { ...sttRaw, baseUrl: sttRaw.baseUrl || cred.baseUrl || preset.baseUrl };
      if (cred.apiKey) {
        stt = { ...stt, apiKey: cred.apiKey };
      }
    } catch { /* 读取失败时保持原始 stt，cloudTranscribe 会给出明确未配置提示 */ }
  }
  // 云端厂商必须有 provider + apiKey；本地无鉴权厂商（bobmultimodal）无需 key
  const cloudAvailable =
    !!stt?.provider && (!!stt?.apiKey || NO_AUTH_STT_PROVIDERS.has(stt.provider));

  if (!cloudAvailable) {
    throw new Error('未配置音频转写引擎：请先在 设置 → 角色派发 → 音频转写模型 配置云端厂商（豆包/DashScope/SiliconFlow，需 API Key）或本地服务（BobMultimodal）。');
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-audio-'));
  const wavPath = path.join(tmpDir, 'audio.wav');
  const startTime = Date.now();
  try {
    await convertToWav(ffmpegPath, audioPath, wavPath, range ?? undefined);
    // 探测实际转写时长：range 块取切好的 wav，整段取原音频
    const duration = range
      ? await probeDuration(ffmpegPath, wavPath)
      : await probeDuration(ffmpegPath, audioPath);
    if (duration !== null && duration > MAX_DURATION_SEC) {
      throw new Error(`音频时长 ${Math.round(duration)}s 超过上限 ${MAX_DURATION_SEC}s（30 分钟），拒绝转写。`);
    }

    const chunks = await splitWav(ffmpegPath, wavPath, tmpDir);
    if (chunks.length === 0) {
      throw new Error('音频切片失败：无法从文件中提取音频流（文件可能损坏或编码不受支持）。');
    }

    const transcripts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const startOffset = (range ? range.start : 0) + i * CHUNK_SEC;
      let segText = '';

      // 云端转写：失败即抛错
      segText = await cloudTranscribe(stt!, chunks[i], i, chunks.length, startOffset);

      if (segText) {
        // 多段时统一带时间戳前缀（便于定位音频位置）
        if (chunks.length > 1) {
          const mm = String(Math.floor(startOffset / 60)).padStart(2, '0');
          const ss = String(Math.floor(startOffset % 60)).padStart(2, '0');
          segText = `[${mm}:${ss}]\n${segText}`;
        }
        transcripts.push(segText);
      }
    }

    const extracted = transcripts.join('\n\n').trim();
    if (!extracted) {
      throw new Error('转写结果为空（未识别到有效语音内容）');
    }

    const providerLabel = STT_PROVIDERS[stt?.provider || 'doubao']?.label || '云端 STT';

    const result: ParseResult = {
      file_name: fileName,
      file_type: 'audio',
      mime_type: mimeType,
      extracted_text: `音频转写（${providerLabel}${duration !== null ? `，时长 ${Math.round(duration)}s` : ''}${range ? `，范围 ${range.start}s-${range.end}s` : ''}${chunks.length > 1 ? `，${chunks.length} 段拼接` : ''}）:\n\n${extracted}`,
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
