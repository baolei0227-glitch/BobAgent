/**
 * 本地离线语音转写（sherpa-onnx）
 *
 * 定位：与云端 STT **互斥单选**的离线引擎——用户在设置里显式选定某个本地模型才生效，
 * 没有 Auto、也没有"云端失败自动回退本地"。
 * 全部产物落在 BOBWORK_HOME/.stt/ 下，随数据目录隔离、不随安装包分发：
 *
 *   .stt/bin/sherpa-onnx-offline       CLI 可执行文件（抓取 sherpa-onnx 官方 release 的 shared 包）
 *   .stt/bin/punct-server              常驻标点服务（本项目 native/punct_server.c 用 clang 现场编译而来）
 *   .stt/lib/*.dylib                   同包 dylib（shared 版运行时依赖，不可只保留 bin）
 *   .stt/models/<id>/...               本地模型（批量 SenseVoice-small · 实时 Streaming Zipformer · 标点 Punctuation）
 *   .stt/.downloads/                   断点续传中间产物（*.part 与引擎压缩包），进度即从磁盘读取
 *
 * 下载：hf-mirror.com 与 GitHub CDN 都会抖动中断，故统一走 Range 断点续传 + 多轮重试，
 * 中间态写入 `<file>.part`，完成后原子重命名——续传进度天然持久化（进程重启也能接着下）。
 *
 * 调用契约（实测 sherpa-onnx-offline v1.13.8）：
 *   - stdout：每个输入文件一行 JSON，取 `.text` 字段；无文件名字段，多文件按行序对应
 *   - 日志噪音全部走 stderr（config dump / 耗时 / RTF），不要依赖 stderr
 *   - 模型缺失时 exit 255、stdout 为空
 *   - **静音会输出幻觉文本**，故空判定必须看 `.text === ''`，不能看"有无输出"
 */
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveAppRoot } from '@/lib/app-root';
import { downloadFile, downloadProgress, extractTarBz2, fileSize } from '@/lib/net/download';
import { startStreamServer, stopStreamServer } from '@/lib/stt/stream-server';
import { punctuateViaServer, stopPunctServer } from '@/lib/stt/punct-server';
import { ARCH, IS_WIN, PLATFORM, exeName, sharedLibEnv } from '../platform';

const BINARY_VERSION = 'v1.13.8';
/**
 * 官方 shared 包体积，按 `${平台}-${架构}` 分键。
 *
 * 为什么必须带平台：arm64 与 x64 在 mac 上是两个数，而 mac-x64 与 win-x64 是**同名不同包**；
 * 只按架构分键会让 Windows 复用 macOS 的体积去校验，结果不是「下载中断」就是「装了个半包」。
 * 没有登记的键 ⇒ 该平台不受支持（Windows 只出 x64，与安装包 target 一致）。
 */
const BINARY_BYTES: Record<string, number> = {
  'darwin-arm64': 20_314_448,
  'darwin-x64': 22_846_038,
  'win32-x64': 24_805_859,
};
const engineKey = (): string => `${PLATFORM}-${ARCH}`;
const BINARY_ARCHIVE = 'sherpa-onnx-offline.tar.bz2';
const LOCAL_STT_TIMEOUT_MS = 120_000;

const HF = 'https://hf-mirror.com';

// ============================================================
// 目录布局
// ============================================================

function sttRoot(): string {
  return path.join(resolveAppRoot(), '.stt');
}
function binDir(): string {
  return path.join(sttRoot(), 'bin');
}
function libDir(): string {
  return path.join(sttRoot(), 'lib');
}
function binaryPath(): string {
  return path.join(binDir(), exeName('sherpa-onnx-offline'));
}
/** 同一 shared 包内的流式 WS 服务端（renderer 直连它做边说边出字） */
function streamServerBinaryPath(): string {
  return path.join(binDir(), exeName('sherpa-onnx-online-websocket-server'));
}
/** 同包内的 TTS CLI（与 STT CLI 同处 bin/，装一次两者都有）——供 lib/tts/sherpa-local 复用 */
export function sherpaTtsBinaryPath(): string {
  return path.join(binDir(), exeName('sherpa-onnx-offline-tts'));
}
/** 同包内的离线说话人分离 CLI（与 STT CLI 同处 bin/，装一次引擎就有）——供 lib/stt/diarize 复用 */
export function sherpaDiarizationBinaryPath(): string {
  return path.join(binDir(), exeName('sherpa-onnx-offline-speaker-diarization'));
}
/** 按需编译的声纹提取 CLI（本项目 native/spk_embed.c 用 clang 现场编译而来）——供 lib/stt/speaker-embed 复用 */
export function sherpaSpkEmbedBinaryPath(): string {
  return path.join(binDir(), exeName('spk-embed'));
}
/** shared 包的 lib 目录（子进程运行时靠 DYLD_LIBRARY_PATH 找 dylib）——供 lib/tts/sherpa-local 复用 */
export function sherpaLibDir(): string {
  return libDir();
}
function modelsDir(): string {
  return path.join(sttRoot(), 'models');
}
function modelDir(id: string): string {
  return path.join(modelsDir(), id);
}
/** 模型落盘目录（供 lib/stt/diarize 拼两个模型文件路径） */
export function sherpaModelDir(id: string): string {
  return modelDir(id);
}
function downloadsDir(): string {
  return path.join(sttRoot(), '.downloads');
}
/** 引擎压缩包落盘位置（稳定路径，便于 UI 读取下载进度） */
function binaryArchivePath(): string {
  return path.join(downloadsDir(), BINARY_ARCHIVE);
}

// ============================================================
// 模型清单（体积为实测值，用于完整性校验与进度换算）
// ============================================================

export interface LocalSttFile {
  name: string;
  url: string;
  bytes: number;
}

/** 模型能力：UI 分组与编排决策都据此判断，不再判 kind 字符串。
 *  前三者与旧的三种 kind 一一对应：batch=offline、realtime=streaming、punctuates=punctuation。 */
export interface SttCapabilities {
  /** 整段批量转写：可作为「转写引擎」单选（offline） */
  batch: boolean;
  /** 边说边出字：可承担实时 WS 链路（streaming） */
  realtime: boolean;
  /** 给裸文本补标点/断句：实时链路的可选增强（punctuation） */
  punctuates: boolean;
  /** 说话人分离：给整段音频标「谁在什么时候说」；不参与转写引擎单选，只在导入录音链路里前置跑一次 */
  diarizes: boolean;
}

interface LocalSttModelBase {
  id: string;
  capabilities: SttCapabilities;
  label: string;
  languages: string;
  description: string;
  totalBytes: number;
  files: LocalSttFile[];
}

// 四种能力组合（字面量类型保留，供联合类型收窄用）
const CAP_BATCH = { batch: true, realtime: false, punctuates: false, diarizes: false } as const;
const CAP_REALTIME = { batch: false, realtime: true, punctuates: false, diarizes: false } as const;
const CAP_PUNCTUATE = { batch: false, realtime: false, punctuates: true, diarizes: false } as const;
const CAP_DIARIZE = { batch: false, realtime: false, punctuates: false, diarizes: true } as const;

export interface OfflineSttModelDef extends LocalSttModelBase {
  capabilities: typeof CAP_BATCH;
  /**
   * 该模型只出裸字、需要外部补标点（如 Zipformer CTC）。
   * 批量链路会在每段转写后调 `punctuateText`（CT-Transformer）补句读；
   * SenseVoice 自带标点/ITN，故不设该位。
   */
  needsPunctuation?: boolean;
  /**
   * CLI 是否支持**一次传多个 wav**（批量转写）。
   * 默认 true；Zipformer CTC 实测传多个会报 `input x Got:3 Expected:1`，故显式 false ⇒
   * parseAudio 直接走逐段转写，不做一次注定失败的批量尝试（也避免留下误导性的错误日志）。
   */
  supportsBatchFiles?: boolean;
  /** 构造 sherpa-onnx-offline 的模型参数（dir = 该模型落盘目录） */
  buildArgs: (dir: string) => string[];
}

export interface StreamingSttModelDef extends LocalSttModelBase {
  capabilities: typeof CAP_REALTIME;
  /** 构造 sherpa-onnx-online-websocket-server 的模型参数 */
  buildStreamingArgs: (dir: string) => string[];
}

/** 标点模型：不构造引擎参数（只有 --ct-transformer 一个，固定取模型目录下的 model.int8.onnx；
 *  同目录的 tokens.json 由二进制自动加载），故只描述文件清单。 */
export interface PunctuationSttModelDef extends LocalSttModelBase {
  capabilities: typeof CAP_PUNCTUATE;
}

/** 说话人分离模型：由两个文件共同构成（pyannote 分段 + 声纹 embedding），缺一不可，
 *  故把两个文件名收进类型定义，调用方不再硬编码字符串。 */
export interface DiarizationSttModelDef extends LocalSttModelBase {
  capabilities: typeof CAP_DIARIZE;
  /** pyannote segmentation 模型文件名（落在该模型目录下） */
  segmentationFile: string;
  /** 说话人 embedding（声纹）模型文件名（落在该模型目录下） */
  embeddingFile: string;
}

export type LocalSttModelDef =
  | OfflineSttModelDef
  | StreamingSttModelDef
  | PunctuationSttModelDef
  | DiarizationSttModelDef;

/** 类型守卫：按能力把联合类型收窄到具体变体，以便取到该变体专属的构造参数。
 *  （能力字段嵌在 capabilities 里，TS 不会据此收窄 def 本身，故显式给出。） */
export function isBatchModel(def: LocalSttModelDef): def is OfflineSttModelDef {
  return def.capabilities.batch;
}
export function isRealtimeModel(def: LocalSttModelDef): def is StreamingSttModelDef {
  return def.capabilities.realtime;
}
export function isDiarizationModel(def: LocalSttModelDef): def is DiarizationSttModelDef {
  return def.capabilities.diarizes;
}

const SENSE_BASE = `${HF}/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main`;
// 中文专用、2025-07-03 的 Zipformer CTC（int8）：WER 1.74 / 5.92 / 7.75（aishell / wenetspeech net / meeting），
// 实测 RTF 0.062。模型只出裸字，标点由 CT-Transformer 补（见 needsPunctuation）。
const ZIPFORMER_CTC_ZH_BASE = `${HF}/csukuangfj/sherpa-onnx-zipformer-ctc-zh-int8-2025-07-03/resolve/main`;
const ZIPFORMER_STREAM_BASE = `${HF}/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main`;
// 标点 CT-Transformer（中英）：GitHub 官方 int8 包本机带宽拉不动，改用 hf-mirror 上的等价 int8 镜像
const PUNCT_CT_BASE = `${HF}/ranger810/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/resolve/main`;
// 说话人分离：pyannote 分段 + 3D-Speaker 声纹（中英通用，体积见 files 里的实测字节数）
const DIARIZE_SEG_BASE = `${HF}/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main`;
const DIARIZE_EMBED_BASE = `${HF}/csukuangfj/speaker-embedding-models/resolve/main`;
const DIARIZE_EMBED_FILE = '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';

export const LOCAL_STT_MODELS: LocalSttModelDef[] = [
  {
    id: 'sensevoice-small',
    capabilities: CAP_BATCH,
    label: 'SenseVoice small',
    languages: 'zh · en · ja · ko · yue',
    description: 'Multilingual with punctuation (ITN enabled)',
    totalBytes: 239_233_841 + 315_894,
    files: [
      { name: 'model.int8.onnx', url: `${SENSE_BASE}/model.int8.onnx`, bytes: 239_233_841 },
      { name: 'tokens.txt', url: `${SENSE_BASE}/tokens.txt`, bytes: 315_894 },
    ],
    buildArgs: (dir) => [
      `--sense-voice-model=${path.join(dir, 'model.int8.onnx')}`,
      `--tokens=${path.join(dir, 'tokens.txt')}`,
      '--sense-voice-use-itn=true',
      // 语言默认 auto，短音频/带口音时会把中文误判成韩/日文（实测输出过 "그."），故锁定中文
      '--sense-voice-language=zh',
    ],
  },
  {
    // 2025-07-03 中文专用 Zipformer CTC：榜单 WER 1.74 / 5.92 / 7.75（aishell / wenetspeech net / meeting），
    // 速度很快；代价是**只出裸字**（批量链路补标点，见 needsPunctuation）。
    // 注意：8k 电话录音的 10 段 A/B 与 SenseVoice 互有胜负（会漏词/多出幻觉），故只作可选引擎，不设默认。
    id: 'zipformer-ctc-zh-2025-07-03',
    capabilities: CAP_BATCH,
    label: 'Zipformer CTC (zh, 2025)',
    languages: 'zh',
    description: 'Chinese-only, fast; punctuation added separately; phone-call A/B is mixed',
    totalBytes: 367_074_356 + 13_366,
    files: [
      { name: 'model.int8.onnx', url: `${ZIPFORMER_CTC_ZH_BASE}/model.int8.onnx`, bytes: 367_074_356 },
      { name: 'tokens.txt', url: `${ZIPFORMER_CTC_ZH_BASE}/tokens.txt`, bytes: 13_366 },
    ],
    needsPunctuation: true,
    supportsBatchFiles: false,
    buildArgs: (dir) => [
      `--zipformer-ctc-model=${path.join(dir, 'model.int8.onnx')}`,
      `--tokens=${path.join(dir, 'tokens.txt')}`,
    ],
  },
  {
    // 流式专用：只服务「边说边出字」的实时链路，不能当批量转写引擎选（故设置里的单选列表只列 batch 能力）
    id: 'streaming-zipformer-zh-en',
    capabilities: CAP_REALTIME,
    label: 'Streaming Zipformer (zh-en)',
    languages: 'zh · en',
    description: 'Real-time partial results while you speak',
    // decoder/joiner 用 fp32 而非 int8：实测 int8 量化的自回归 decoder 会把字吐两遍
    // （如「今天今天」「公公园」「下周三三」「评评」），换 fp32 后同样音频零复读；
    // encoder 保持 int8（占比最大、量化损失小），只多 ~10MB。
    totalBytes: 181_895_032 + 13_876_452 + 12_833_618 + 56_317,
    files: [
      { name: 'encoder-epoch-99-avg-1.int8.onnx', url: `${ZIPFORMER_STREAM_BASE}/encoder-epoch-99-avg-1.int8.onnx`, bytes: 181_895_032 },
      { name: 'decoder-epoch-99-avg-1.onnx', url: `${ZIPFORMER_STREAM_BASE}/decoder-epoch-99-avg-1.onnx`, bytes: 13_876_452 },
      { name: 'joiner-epoch-99-avg-1.onnx', url: `${ZIPFORMER_STREAM_BASE}/joiner-epoch-99-avg-1.onnx`, bytes: 12_833_618 },
      { name: 'tokens.txt', url: `${ZIPFORMER_STREAM_BASE}/tokens.txt`, bytes: 56_317 },
    ],
    buildStreamingArgs: (dir) => [
      `--tokens=${path.join(dir, 'tokens.txt')}`,
      `--encoder=${path.join(dir, 'encoder-epoch-99-avg-1.int8.onnx')}`,
      `--decoder=${path.join(dir, 'decoder-epoch-99-avg-1.onnx')}`,
      `--joiner=${path.join(dir, 'joiner-epoch-99-avg-1.onnx')}`,
      // 停顿判停（endpoint）：定稿太碎/太粗都难用——原先提到 3.0s 想让字幕成段，结果正常对话
      // 里几乎不会静默满 3 秒，一整段塞进好几个人（一句话里好几轮），而 rule3 的 20s 上限
      // 又会从句子中间硬切。实测（44.9s 真实会议录音）：3.0s + rule3=20s 只产出 3 段，
      // 切点正好落在 20.3s / 40.5s——全是 rule3 硬切。
      //
      // 现在：rule1 = rule2 = 1.5s（自然句末 / 轮次停顿），rule3 = 10s 且**要求 0.5s 停顿**才切。
      // 同一段录音 → 5~6 段，切点落在小停顿上而不是句子中间。
      //
      // rule1 必须与 rule2 同步——rule1 不强求先出字（--rule1-must-contain-nonsilence 默认 false），
      // 只改 rule2 的话仍会被 rule1 提前切断。
      '--rule1-min-trailing-silence=1.5',
      '--rule2-min-trailing-silence=1.5',
      '--rule3-min-utterance-length=10',
      '--rule3-min-trailing-silence=0.5',
    ],
  },
  {
    // 标点/断句：同样只服务实时语音输入（zipformer 出裸字，停顿处由它补标点），
    // 不参与设置里的引擎单选——就绪即自动生效，未下载则实时链路照常输出无标点文本。
    id: 'punct-ct-transformer-zh-en',
    capabilities: CAP_PUNCTUATE,
    label: 'Punctuation (zh · en)',
    languages: 'zh · en',
    description: 'Adds punctuation and sentence breaks to live voice input',
    totalBytes: 75_519_198 + 4_207_480,
    files: [
      { name: 'model.int8.onnx', url: `${PUNCT_CT_BASE}/model.int8.onnx`, bytes: 75_519_198 },
      { name: 'tokens.json', url: `${PUNCT_CT_BASE}/tokens.json`, bytes: 4_207_480 },
    ],
  },
  {
    // 说话人分离：不参与设置里的引擎单选，也不服务实时链路；只在「导入录音」链路里，
    // 对整段音频**前置跑一次**（result 缓存复用），再按轮次切块转写，给文稿贴 [说话人 N]。
    // 两个文件同下同删（pyannote 分段 + 3D-Speaker 声纹，缺一不可）。
    id: 'diarize-pyannote-3dspeaker',
    capabilities: CAP_DIARIZE,
    label: 'Speaker diarization (pyannote + 3D-Speaker)',
    languages: 'language-agnostic',
    description: 'Labels who spoke when in imported recordings — offline, on this Mac',
    totalBytes: 5_992_913 + 39_593_761,
    files: [
      { name: 'model.onnx', url: `${DIARIZE_SEG_BASE}/model.onnx`, bytes: 5_992_913 },
      { name: DIARIZE_EMBED_FILE, url: `${DIARIZE_EMBED_BASE}/${DIARIZE_EMBED_FILE}`, bytes: 39_593_761 },
    ],
    segmentationFile: 'model.onnx',
    embeddingFile: DIARIZE_EMBED_FILE,
  },
];

export function findLocalModel(id: string | undefined): LocalSttModelDef | undefined {
  if (!id) return undefined;
  return LOCAL_STT_MODELS.find((m) => m.id === id);
}

/**
 * 声纹 embedding 模型文件绝对路径（未下载时返回 null）。
 * 就是分离用的那一份 3dspeaker ERes2Net——**同一个文件**，故分离出的簇与跨录音的声纹库
 * 处在同一向量空间，余弦可直接比。放这里（而非 diarize）是为了让 lib/stt/speaker-embed
 * 不必回头依赖 diarize，避免二者互相 import。
 */
export function speakerEmbeddingModelPath(): string | null {
  const def = LOCAL_STT_MODELS.find((m) => m.capabilities.diarizes);
  if (!def || !isDiarizationModel(def)) return null;
  return path.join(modelDir(def.id), def.embeddingFile);
}

// ============================================================
// 平台 / 安装状态
// ============================================================

/** 当前平台是否有可用的官方 CLI 包（macOS arm64/x64、Windows x64 提供 shared 版） */
export function isLocalSttSupported(): boolean {
  return !!BINARY_BYTES[engineKey()];
}

function binaryUrl(): string {
  const base = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${BINARY_VERSION}`;
  // Windows 与 macOS 的归档命名完全不同：
  //   osx: sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2
  //   win: sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2
  // 后者还有 MD/MT × Release/Debug 多种变体：选 MT-Release（静态 CRT），
  // 免装 VC++ 运行库也能起；MD 版在干净的 Windows 上会缺 vcruntime140.dll。
  if (IS_WIN) {
    return `${base}/sherpa-onnx-${BINARY_VERSION}-win-${ARCH}-shared-MT-Release.tar.bz2`;
  }
  return `${base}/sherpa-onnx-${BINARY_VERSION}-osx-${ARCH}-shared.tar.bz2`;
}

export async function isLocalSttBinaryInstalled(): Promise<boolean> {
  if (!isLocalSttSupported()) return false;
  return (await fileSize(binaryPath())) > 0;
}

/** 共享引擎（sherpa-onnx shared 包）状态：本地 STT 与本地神经 TTS **复用同一份 bin/lib**，
 *  故 TTS 侧直接引用本函数，不重复实现下载入口与进度换算。 */
export async function getSherpaEngineStatus(): Promise<{
  installed: boolean;
  path: string;
  downloadedBytes: number;
  totalBytes: number;
}> {
  const installed = await isLocalSttBinaryInstalled();
  const totalBytes = BINARY_BYTES[engineKey()] ?? 0;
  const downloadedBytes = installed ? totalBytes : await downloadProgress(binaryArchivePath(), totalBytes);
  return { installed, path: binaryPath(), downloadedBytes, totalBytes };
}

export async function isLocalSttModelReady(id: string): Promise<boolean> {
  const def = findLocalModel(id);
  if (!def) return false;
  const dir = modelDir(id);
  for (const f of def.files) {
    if ((await fileSize(path.join(dir, f.name))) < f.bytes) return false;
  }
  return true;
}

// ============================================================
// 安装 / 卸载
// ============================================================

/** 下载并安装 CLI（shared 包解压后保留 bin/ 与 lib/ 同级结构，二进制靠 @executable_path/../lib 找 dylib） */
export async function installLocalSttBinary(): Promise<void> {
  if (!isLocalSttSupported()) {
    throw new Error(`Local STT engine is not supported on this platform (official builds exist for macOS arm64/x64 and Windows x64; current ${PLATFORM}-${ARCH}).`);
  }
  const archive = binaryArchivePath();
  await downloadFile(binaryUrl(), archive, BINARY_BYTES[engineKey()]);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-sherpa-'));
  try {
    const extractDir = path.join(tmp, 'x');
    await extractTarBz2(archive, extractDir);
    const top = (await fs.readdir(extractDir)).find((n) => n.startsWith('sherpa-onnx-'));
    if (!top) throw new Error('No sherpa-onnx directory in the extracted archive');

    const srcBin = path.join(extractDir, top, 'bin');
    const srcLib = path.join(extractDir, top, 'lib');
    await fs.rm(binDir(), { recursive: true, force: true });
    await fs.rm(libDir(), { recursive: true, force: true });
    await fs.mkdir(binDir(), { recursive: true });
    await fs.cp(srcBin, binDir(), { recursive: true });
    await fs.cp(srcLib, libDir(), { recursive: true });
    // Windows 没有可执行位概念（fs.chmod 只改只读位），跳过即可
    if (!IS_WIN) await fs.chmod(binaryPath(), 0o755);
    if ((await fileSize(binaryPath())) === 0) throw new Error('sherpa-onnx-offline executable missing after extraction');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  // 安装成功即清理压缩包，避免长期占 ~20MB
  await fs.rm(archive, { force: true }).catch(() => undefined);
}

export async function installLocalSttModel(id: string): Promise<void> {
  const def = findLocalModel(id);
  if (!def) throw new Error(`Unknown local STT model: ${id}`);
  const dir = modelDir(id);
  for (const f of def.files) {
    await downloadFile(f.url, path.join(dir, f.name), f.bytes);
  }
}

/** 删除已下载的本地模型（连同中断残留的 `.part`），释放磁盘；幂等，未下载时为空操作 */
export async function removeLocalSttModel(id: string): Promise<void> {
  if (!findLocalModel(id)) throw new Error(`Unknown local STT model: ${id}`);
  // 常驻流式服务端可能正加载着这个模型：先回收，否则文件被删了它还在内存里跑
  stopStreamServer(id);
  // 常驻标点服务同理（按模型文件路径精确匹配，别误伤别的模型实例）
  stopPunctServer(path.join(modelDir(id), 'model.int8.onnx'));
  await fs.rm(modelDir(id), { recursive: true, force: true });
}

/** 卸载本地 STT 引擎（bin + lib + 压缩包及其 `.part` 中间态），释放磁盘；幂等 */
export async function uninstallLocalSttBinary(): Promise<void> {
  stopStreamServer(); // 引擎二进制要删了，常驻服务端必须先停
  stopPunctServer(); // 常驻标点服务也一起（它加载的 dylib 就在待删的 lib/ 下）
  await fs.rm(binDir(), { recursive: true, force: true });
  await fs.rm(libDir(), { recursive: true, force: true });
  const archive = binaryArchivePath();
  await fs.rm(archive, { force: true });
  await fs.rm(`${archive}.part`, { force: true });
}

// ============================================================
// 任务状态（globalThis 持久化，规避 Next.js dev 热重载丢状态；
// 进度本身从磁盘读取，故即使进程重启也能自愈）
// ============================================================

export interface LocalSttJob {
  key: string;
  kind: 'binary' | 'model';
  modelId?: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const JOB_STORE_KEY = '__bobLocalSttJobs';
function jobStore(): Map<string, LocalSttJob> {
  const g = globalThis as unknown as Record<string, Map<string, LocalSttJob> | undefined>;
  if (!g[JOB_STORE_KEY]) g[JOB_STORE_KEY] = new Map();
  return g[JOB_STORE_KEY]!;
}

/** 最近一次任务（进行中优先），供 UI 展示进度与错误 */
export function getLatestJob(): LocalSttJob | null {
  const all = [...jobStore().values()].sort((a, b) => b.startedAt - a.startedAt);
  return all.find((j) => j.status === 'running') ?? all[0] ?? null;
}

/** 启动后台下载任务（同一时刻只允许一个），立即返回供 UI 轮询 */
export function startLocalSttJob(kind: 'binary' | 'model', modelId?: string): LocalSttJob {
  const running = [...jobStore().values()].find((j) => j.status === 'running');
  if (running) throw new Error('Another local STT download is already running — wait for it to finish.');
  if (kind === 'model' && !findLocalModel(modelId)) throw new Error(`Unknown local STT model: ${modelId}`);

  const key = kind === 'binary' ? 'binary' : `model:${modelId}`;
  const job: LocalSttJob = { key, kind, modelId, status: 'running', startedAt: Date.now() };
  jobStore().set(key, job);

  void (async () => {
    try {
      if (kind === 'binary') await installLocalSttBinary();
      else await installLocalSttModel(modelId!);
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return job;
}

// ============================================================
// 状态汇总（GET /api/stt/local）
// ============================================================

export interface LocalSttStatus {
  supported: boolean;
  binary: { installed: boolean; path: string; downloadedBytes: number; totalBytes: number };
  models: Array<{
    id: string;
    capabilities: SttCapabilities;
    label: string;
    languages: string;
    description: string;
    ready: boolean;
    downloadedBytes: number;
    totalBytes: number;
  }>;
  job: LocalSttJob | null;
}

export async function getLocalSttStatus(): Promise<LocalSttStatus> {
  const supported = isLocalSttSupported();
  const binary = await getSherpaEngineStatus();

  const models = [];
  for (const def of LOCAL_STT_MODELS) {
    const dir = modelDir(def.id);
    let downloadedBytes = 0;
    let ready = true;
    for (const f of def.files) {
      const got = await downloadProgress(path.join(dir, f.name), f.bytes);
      downloadedBytes += got;
      if (got < f.bytes) ready = false;
    }
    models.push({
      id: def.id,
      capabilities: def.capabilities,
      label: def.label,
      languages: def.languages,
      description: def.description,
      ready,
      downloadedBytes,
      totalBytes: def.totalBytes,
    });
  }

  return {
    supported,
    binary,
    models,
    job: getLatestJob(),
  };
}

// ============================================================
// 转写
// ============================================================

/** 解析 stdout：逐行 JSON，抽取 `.text`（空 text = 静音幻觉，直接丢弃） */
function parseSherpaStdout(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as { text?: string };
      const text = typeof j.text === 'string' ? j.text.trim() : '';
      if (text) texts.push(text);
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  return texts.join('\n').trim();
}

/**
 * 逐行解析批量转写输出（**保留位置**：空文本也占一位）。
 * 契约：CLI 对每个输入文件输出一行 JSON、顺序与入参一致；行数不符时抛错——
 * 一旦错位就会把这一段的话贴到那一段的标题/说话人上，宁可让调用方退回逐段转写。
 */
export function parseSherpaStdoutLines(stdout: string, expected?: number): string[] {
  const texts: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as { text?: unknown };
      texts.push(typeof j.text === 'string' ? j.text.trim() : '');
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  if (expected !== undefined && texts.length !== expected) {
    throw new Error(`Local STT returned ${texts.length} results for ${expected} clips — refusing to misalign paragraphs.`);
  }
  return texts;
}

function runSherpa(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath(), args, {
      // shared 包运行时依赖同目录 dylib：@executable_path/../lib 之外再兜一层
      // （macOS 走 DYLD_LIBRARY_PATH，Windows 走 PATH —— 见 sharedLibEnv）
      env: {
        ...process.env,
        ...sharedLibEnv(libDir()),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`本地 STT 转写超时（${LOCAL_STT_TIMEOUT_MS / 1000}s）`));
    }, LOCAL_STT_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }); });
  });
}

/**
 * 本地离线转写单个 wav（16kHz 单声道，由 parseAudio 的 ffmpeg 环节保证）。
 * 静音/无语音返回空串，由调用方统一按"结果为空"处理。
 */
/** 批量转写前的公共前置校验：返回已收窄为「批量（offline）模型」的定义；不可用即抛，调用方决定降级 */
async function assertBatchModelReady(modelId: string): Promise<OfflineSttModelDef> {
  const def = findLocalModel(modelId);
  if (!def) throw new Error(`Unknown local STT model: ${modelId}`);
  if (!isBatchModel(def)) {
    throw new Error(`${def.label} cannot transcribe recordings — pick a batch (offline) model in Settings → Roles → Audio STT Model.`);
  }
  if (!(await isLocalSttBinaryInstalled())) {
    throw new Error('Local STT engine not installed. Download it in Settings → Roles → Audio STT Model.');
  }
  if (!(await isLocalSttModelReady(modelId))) {
    throw new Error(`Local STT model not fully downloaded: ${def.label}. Resume the download in Settings.`);
  }
  return def;
}

export async function sherpaTranscribe(
  wavPath: string,
  modelId: string,
  extraArgs: string[] = [],
): Promise<string> {
  const def = await assertBatchModelReady(modelId);
  const { stdout, stderr, code } = await runSherpa([...def.buildArgs(modelDir(modelId)), ...extraArgs, wavPath]);
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 400);
    throw new Error(`Local STT transcription failed (exit ${code}): ${tail}`);
  }
  return parseSherpaStdout(stdout);
}

/** 单次 CLI 调用最多带多少个文件（argv 长度与 stdout 体积双重考虑） */
const TRANSCRIBE_BATCH_SIZE = 32;

/**
 * 批量转写：**一次 CLI 调用转多个文件**，模型只加载一次。
 *
 * 为什么必须批量：无多说话人标签时现在按停顿把录音切成「句群」（见 lib/parse/audio-chunking），
 * 片段数从个位数涨到几十个；而 CLI 每次 spawn 都要重载模型。实测 SenseVoice small：
 * 1 个文件 1.68s、3 个文件 1.77s（每多一个文件只多 ~0.03s 推理）——逐段调用会把分钟级
 * 任务拖成十几分钟，还反复占住 CPU。
 *
 * 返回与入参**一一对应**的文本数组（该段没识别出内容则为空串）；行数不符即抛错（见
 * parseSherpaStdoutLines），由调用方决定退回逐段转写。
 */
export async function sherpaTranscribeMany(
  wavPaths: string[],
  modelId: string,
  extraArgs: string[] = [],
): Promise<string[]> {
  if (wavPaths.length === 0) return [];
  const def = await assertBatchModelReady(modelId);
  const out: string[] = [];
  for (let i = 0; i < wavPaths.length; i += TRANSCRIBE_BATCH_SIZE) {
    const batch = wavPaths.slice(i, i + TRANSCRIBE_BATCH_SIZE);
    const { stdout, stderr, code } = await runSherpa([...def.buildArgs(modelDir(modelId)), ...extraArgs, ...batch]);
    if (code !== 0) {
      const tail = stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 400);
      throw new Error(`Local STT batch transcription failed (exit ${code}): ${tail}`);
    }
    out.push(...parseSherpaStdoutLines(stdout, batch.length));
  }
  return out;
}

// ============================================================
// 流式服务端（sherpa-onnx-online-websocket-server）
//
// 与离线 CLI 的根本差别：它是**常驻 WS 服务**，不是一次性命令——起一次、多个连接复用。
// 进程生命周期（端口分配 / 健康检查 / 空闲回收 / 孤儿清理）已收进 lib/stt/stream-server；
// 这里只负责挑出就绪的 realtime 模型，把二进制与模型参数交给进程管理器。
//
// 为什么 renderer 直连 ws://127.0.0.1:<port> 而不经 Next 中转：音频是 100ms 一帧的连续流，
// 中转要多一次 WS→HTTP 的转发与背压处理，且会把首字延迟抬高一跳；直连是 sherpa 官方设计用法。
//
// 实测协议（本机 v1.13.8 + 官方 client 对照验证，由 renderer 的 realtime provider 消费）：
//   - 上行：二进制帧 = Float32Array（16kHz 单声道，即 [-1,1] 浮点采样）；结束发文本帧 "Done"
//   - 下行：文本帧 JSON { text, segment, is_final, is_eof }
//       is_final && !is_eof → 该段定稿，服务端随即 Reset、下一段从空文本重新累积
//       is_eof              → "Done" 之后的收尾结果
//     "Done" 之后还会补一帧非 JSON 文本 "Done!"（照抄官方行为），客户端必须忽略
// ============================================================

/** renderer 直连所需的连接信息 */
export interface LocalSttStreamServer {
  port: number;
  modelId: string;
}

/** 服务端日志文件（进程管理器按此路径写日志、并在就绪失败时回读尾巴） */
function streamLogPath(): string {
  return path.join(sttRoot(), 'logs', 'streaming-server.log');
}

const execFileAsync = promisify(execFile);

/**
 * 当前可用的 streaming 模型 id（引擎已装 + 模型文件齐全）；无则 null。
 * renderer 据此决定麦克风是否走「边说边出字」的实时链路——没下载就退回原来的录制后转写。
 */
export async function resolveStreamingSttModel(): Promise<string | null> {
  if (!(await isLocalSttBinaryInstalled())) return null;
  for (const def of LOCAL_STT_MODELS) {
    if (!def.capabilities.realtime) continue;
    if (await isLocalSttModelReady(def.id)) return def.id;
  }
  return null;
}

/**
 * 启动（或复用）流式服务端，返回 renderer 的直连端口。
 * 校验与模型参数在这里；进程生命周期（端口/健康检查/空闲回收/孤儿清理）在 stream-server。
 */
export async function startLocalSttStreamServer(modelId: string): Promise<LocalSttStreamServer> {
  const def = findLocalModel(modelId);
  if (!def) throw new Error(`Unknown local STT model: ${modelId}`);
  if (!isRealtimeModel(def)) {
    throw new Error(`${def.label} is not a real-time model — live transcription needs a realtime (streaming) model.`);
  }
  if (!(await isLocalSttBinaryInstalled())) {
    throw new Error('Local STT engine not installed. Download it in Settings → Roles → Audio STT Model.');
  }
  if (!(await isLocalSttModelReady(modelId))) {
    throw new Error(`Local STT model not fully downloaded: ${def.label}. Resume the download in Settings.`);
  }
  return startStreamServer({
    modelId,
    binaryPath: streamServerBinaryPath(),
    libDir: libDir(),
    args: def.buildStreamingArgs(modelDir(modelId)),
    logPath: streamLogPath(),
  });
}

// ============================================================
// 标点整理（sherpa-onnx-offline-punctuation + CT-Transformer）
//
// 为什么需要它：流式 zipformer 只出**裸字**（无标点、不断句），而 SenseVoice small 在 sherpa-onnx
// 里只有 offline 形态，挂不上流式链路。于是实时文本的「停顿处断句 + 加标点」由这个独立模型补：
// 每段定稿（is_final）跑一次，按 ✓ 时对整段（含尾巴）再跑一次。
//
// 两条实现，调用方只认 punctuateText：
//   ① 常驻服务（首选）：native/punct_server.c 直接调 C API，模型加载一次、逐段复用，实测 ~3ms/段；
//   ② 单次 CLI（回退）：sherpa-onnx-offline-punctuation，每次 spawn 都要重加载 75MB 模型（~135ms/段）。
// 为什么必须常驻：会议实时字幕每段定稿都要补句读，135ms/段会把字幕拖慢且白烧 CPU。
//
// CLI 实测调用契约（v1.13.8）：
//   - 参数：--ct-transformer=<model.int8.onnx>，同目录的 tokens.json 自动加载（**没有 --tokens**）
//   - 待整理文本作为**最后一个位置参数**（不是文件，是纯文本）
//   - stdout 只有一行 = 标点后的文本；`Input text:` / `Output text:` 等日志全走 stderr，不要信 stderr
// ============================================================

/** 标点 CLI：与 STT CLI 同处 shared 包的 bin/，装一次引擎就有（常驻服务不可用时的回退） */
function punctuationBinaryPath(): string {
  return path.join(binDir(), exeName('sherpa-onnx-offline-punctuation'));
}

/** 常驻标点服务可执行文件：对应 native/punct_server.c，首次使用时由 clang 按需编译落位 */
function punctServerBinaryPath(): string {
  return path.join(binDir(), exeName('punct-server'));
}

/** 当前可用的标点模型 id；无则 null（引擎未装 / 模型未下载齐） */
export async function resolvePunctuationModel(): Promise<string | null> {
  if (!(await isLocalSttBinaryInstalled())) return null;
  for (const def of LOCAL_STT_MODELS) {
    if (!def.capabilities.punctuates) continue;
    if (await isLocalSttModelReady(def.id)) return def.id;
  }
  return null;
}

/**
 * 给一段裸文本补标点/断句。
 * 首选常驻服务（~3ms/段），不可用（clang 缺失 / 未就绪 / 超时）时回退单次 CLI（~135ms/段）。
 * 未就绪、空文本或两条路都失败 → **原样返回**（标点是可选增强，绝不能因此打断语音输入）。
 */
export async function punctuateText(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const modelId = await resolvePunctuationModel();
  if (!modelId) return text;
  const modelPath = path.join(modelDir(modelId), 'model.int8.onnx');
  try {
    const out = await punctuateViaServer(
      { binaryPath: punctServerBinaryPath(), libDir: libDir(), modelPath },
      trimmed,
    );
    if (out.trim()) return out;
  } catch (e) {
    console.warn('常驻标点服务不可用，回退单次 CLI:', e);
  }
  try {
    const { stdout } = await execFileAsync(
      punctuationBinaryPath(),
      [`--ct-transformer=${modelPath}`, '--num-threads=2', trimmed],
      {
        timeout: LOCAL_STT_TIMEOUT_MS,
        env: {
          ...process.env,
          ...sharedLibEnv(libDir()),
        },
      },
    );
    const line = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
    return line || text;
  } catch (e) {
    console.warn('标点整理失败，返回原文本:', e);
    return text;
  }
}