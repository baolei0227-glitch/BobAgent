/**
 * lib/tts/sherpa-local.ts — 本地神经语音合成（sherpa-onnx offline TTS）
 *
 * 定位：与云端 TTS **互斥单选**的本地档——离线、无 Key、音质优于系统内置音。
 * 与 lib/stt/sherpa 对称：模型按需下载到 BOBWORK_HOME 下，不随安装包分发。
 *
 * 引擎复用：`sherpa-onnx-offline-tts` 与 STT 的 `sherpa-onnx-offline` **同处 .stt/bin**
 * （同一个官方 shared 包），故引擎的下载/安装/状态一律复用 lib/stt/sherpa，本模块不重复实现。
 *
 * 目录布局（TTS 专属，与 STT 模型分开）：
 *   .tts/models/<id>/<解压顶层目录>/...   模型本体（含引擎压缩包解压产物）
 *   .tts/models/<id>/<顶层目录>/<extra>   额外文件（zipvoice 的 vocoder 落此处）
 *   .tts/.downloads/                      预留：中间产物（当前压缩包直接落模型目录，进度照读 .part）
 *
 * 下载：GitHub 被墙、官方 release 走代理链（见 GH_PROXIES），Range 断点续传跨镜像有效。
 *
 * 调用契约（实测 sherpa-onnx-offline-tts v1.13.8）：
 *   - 参数：`--output-filename=<wav>`、`--num-threads`、`--tts-silence-scale`、各模型参数；
 *     **待合成文本是位置参数**（没有 `--text` 开关，传了会打印 usage 并以 255 退出）
 *   - 语速：VITS 用 `--vits-length-scale`（Larger→Slower，与 settings 的 speed 互为倒数）
 *   - 零样本克隆（ZipVoice）：必须给 `--reference-audio`（24kHz 单声道 wav）+ `--reference-text`（逐字一致）；
 *     该分支无音色/语速参数（`--speed` 亦无效），音色完全由参考音决定
 *   - 输出固定 WAV（vits-zh-ll 16000Hz / zipvoice 24000Hz），无 mp3
 *   - 失败非 0 退出，日志走 stderr
 */
import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolveAppRoot } from '@/lib/app-root';
import { resolveFfmpegPath } from '@/lib/parse/audio-parser';
import { downloadFile, downloadProgress, extractTarBz2 } from '@/lib/net/download';
import {
  getLatestJob as getLatestSttJob,
  getSherpaEngineStatus,
  installLocalSttBinary,
  isLocalSttSupported,
  sherpaLibDir,
  sherpaTtsBinaryPath,
} from '@/lib/stt/sherpa';

/** 本地神经 TTS 厂商标识（无需 API Key / model） */
export const SHERPA_LOCAL_PROVIDER = 'sherpa-local';

const MAX_TEXT_CHARS = 2000;
const TTS_TIMEOUT_MS = 300_000;
const NUM_THREADS = 4;
/** 句间静音缩放（默认 0.2，实测自然） */
const SILENCE_SCALE = 0.2;

/** GitHub 代理链：逐个尝试，末位空串 = 直连 github（官方 release 单文件 tarball） */
const GH_PROXIES = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/', ''];
function mirrorUrls(githubUrl: string): string[] {
  return GH_PROXIES.map((p) => (p ? `${p}${githubUrl}` : githubUrl));
}

// ============================================================
// 目录布局
// ============================================================

function ttsRoot(): string {
  return path.join(resolveAppRoot(), '.tts');
}
function modelsDir(): string {
  return path.join(ttsRoot(), 'models');
}
function modelDir(id: string): string {
  return path.join(modelsDir(), id);
}

// ============================================================
// 模型清单（体积为实测值，用于完整性校验与进度换算）
// ============================================================

interface DownloadRef {
  /** GitHub 官方 release 上的完整 URL（下载时展开为代理链） */
  url: string;
  bytes: number;
}

interface ExtraFile extends DownloadRef {
  /** 落盘路径（相对模型内容目录） */
  name: string;
}

interface RequiredPath {
  /** 相对模型内容目录 */
  name: string;
  /** 期望字节数；省略 = 只要存在且非空 */
  bytes?: number;
  /** 该路径是目录（如 zipvoice 的 espeak-ng-data），只校验存在 */
  dir?: boolean;
}

/** 音色性别：播客双主播据此配对成「一男一女」（未知则不参与配对） */
export type LocalVoiceGender = 'male' | 'female';

/** 多音色预置模型的一条音色（preset 专用）：UI 渲染下拉，合成时映射为 sherpa 的 `--sid` */
export interface LocalTtsVoice {
  /** 稳定标识：落盘用（`--sid` 若随模型版本重排，用户已配的音色仍可按 id 命中） */
  id: string;
  /** UI 展示名（英文，与仓内既有标签风格一致） */
  label: string;
  /** sherpa-onnx `--sid` 取值 */
  sid: number;
  /** 性别（播客配对用）；可缺省，缺省时回落到模型级 gender */
  gender?: LocalVoiceGender;
}

export interface LocalTtsModelDef {
  id: string;
  label: string;
  description: string;
  /** 引擎类型：preset = 固定音色库（vits-zh-ll）；zero-shot = 零样本音色克隆（ZipVoice，需参考音）。
   *  缺省视为 preset，UI 与校验据此分支。 */
  kind?: 'preset' | 'zero-shot';
  /** 多音色预置模型的音色表；空/缺省 = 单音色模型（无 `--sid` 概念） */
  voices?: LocalTtsVoice[];
  /** 单音色预置模型的性别（播客配对用）；多音色模型下看各音色的 gender */
  gender?: LocalVoiceGender;
  /** 压缩包（解压后顶层目录固定为 dirName） */
  archive: DownloadRef & { name: string };
  /** 解压顶层目录名（sherpa 官方包内固定） */
  dirName: string;
  /** 需另行下载的附加文件（zipvoice 的 vocoder） */
  extraFiles: ExtraFile[];
  /** 就绪校验项（相对内容目录） */
  required: RequiredPath[];
  totalBytes: number;
  /** 构造 sherpa-onnx-offline-tts 的模型参数（dir = 模型内容目录）。
   *  sid 仅多音色预置模型（vits-zh-ll）使用；reference 仅 zero-shot 模型使用；
   *  单音色模型的实现忽略这两个字段即可。 */
  buildArgs: (
    dir: string,
    opts: { speed?: number; sid?: number; reference?: { audio: string; text: string } },
  ) => string[];
}

const VITS_LL_DIR = 'sherpa-onnx-vits-zh-ll';
const ZIPVOICE_DIR = 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia';
const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

/** 预置模型 id（GENERIC_REFS 的合成源等处引用，避免字面量散落） */
const VITS_LL_MODEL_ID = 'vits-zh-ll';
// 实测 Content-Length（2026-09-28 curl -sIL 复核），勿估算
const VITS_LL_ARCHIVE_BYTES = 118_810_709;
// 实测 Content-Length（2026-09-27 curl -sIL 复核），勿估算
const ZIPVOICE_ARCHIVE_BYTES = 109_162_785;
const ZIPVOICE_VOCODER_BYTES = 54_157_409;
/** ZipVoice 官方示例的采样步数（`--num-steps`，实测 --help 默认 5，示例用 4） */
const ZIPVOICE_NUM_STEPS = 4;

/** 公共参数（两句模型共有）：线程数 / 句间静音 */
function commonArgs(): string[] {
  return [`--num-threads=${NUM_THREADS}`, `--tts-silence-scale=${SILENCE_SCALE}`];
}

/** 语速：用模型自身的 length-scale（Larger→Slower），与 settings 的 speed 倍率互为倒数
 *  （CLI 的 `--speed` 只对部分模型生效，统一走 length-scale 更稳）。 */
function lengthScaleArgs(flag: string, speed?: number): string[] {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return [];
  return [`${flag}=${1 / speed}`];
}

export const LOCAL_TTS_MODELS: LocalTtsModelDef[] = [
  {
    // 中文男女声（社区模型 VITS-fast-fine-tuning，5 说话人，16kHz）：播客双主播的默认音色来源。
    // 暴露实测最好的一男一女——sid=1 gunian ≈93Hz、sid=2 fushiyu ≈222Hz。两位主播取自**同一模型**，
    // 采样率与响度天然一致（跨模型混拼会把两个模型的差异直接暴露给听众）。
    // 说话人名表在包内 G_multisperaker_latest.json，其余 3 条（suyingxue 女、bingjiao/bazong 男）
    // 需要时在数组里加一条即可；数组首项是未知音色 id 的兜底。
    id: VITS_LL_MODEL_ID,
    label: 'VITS zh-ll',
    description: 'Chinese · fast · male + female voices',
    voices: [
      { id: 'gunian', label: 'Male · gunian', sid: 1, gender: 'male' },
      { id: 'fushiyu', label: 'Female · fushiyu', sid: 2, gender: 'female' },
    ],
    archive: {
      name: `${VITS_LL_DIR}.tar.bz2`,
      url: `${RELEASE}/tts-models/${VITS_LL_DIR}.tar.bz2`,
      bytes: VITS_LL_ARCHIVE_BYTES,
    },
    dirName: VITS_LL_DIR,
    // 音色库随包分发，无需额外文件
    extraFiles: [],
    required: [{ name: 'model.onnx' }, { name: 'lexicon.txt' }, { name: 'tokens.txt' }],
    totalBytes: VITS_LL_ARCHIVE_BYTES,
    buildArgs: (dir, opts) => [
      `--vits-model=${path.join(dir, 'model.onnx')}`,
      `--vits-lexicon=${path.join(dir, 'lexicon.txt')}`,
      `--vits-tokens=${path.join(dir, 'tokens.txt')}`,
      // 规则 FST：日期/数字/多音字/电话号码按中文读法（缺一则 "2026" 可能逐位念）
      `--tts-rule-fsts=${[
        path.join(dir, 'date.fst'),
        path.join(dir, 'number.fst'),
        path.join(dir, 'new_heteronym.fst'),
        path.join(dir, 'phone.fst'),
      ].join(',')}`,
      ...(typeof opts.sid === 'number' ? [`--sid=${opts.sid}`] : []),
      ...lengthScaleArgs('--vits-length-scale', opts.speed),
      ...commonArgs(),
    ],
  },
  {
    // 零样本音色克隆（比预置音色更接近真人的一档）：给定一段真人参考录音 + 其逐字文本，
    // 即可用该真人音色朗读任意中英文本；24kHz，音色完全由参考音决定。
    id: 'zipvoice-zh-en-distill',
    label: 'ZipVoice zh-en',
    description: 'Zero-shot voice cloning · 24 kHz · zh+en',
    kind: 'zero-shot',
    archive: {
      name: `${ZIPVOICE_DIR}.tar.bz2`,
      url: `${RELEASE}/tts-models/${ZIPVOICE_DIR}.tar.bz2`,
      bytes: ZIPVOICE_ARCHIVE_BYTES,
    },
    dirName: ZIPVOICE_DIR,
    // zipvoice 不带 vocoder，需单独补一个通用 24kHz vocos（与 reference 一起决定音色）
    extraFiles: [
      { name: 'vocos_24khz.onnx', url: `${RELEASE}/vocoder-models/vocos_24khz.onnx`, bytes: ZIPVOICE_VOCODER_BYTES },
    ],
    required: [
      { name: 'encoder.int8.onnx' },
      { name: 'decoder.int8.onnx' },
      { name: 'tokens.txt' },
      { name: 'lexicon.txt' },
      { name: 'espeak-ng-data', dir: true },
      { name: 'vocos_24khz.onnx', bytes: ZIPVOICE_VOCODER_BYTES },
    ],
    totalBytes: ZIPVOICE_ARCHIVE_BYTES + ZIPVOICE_VOCODER_BYTES,
    buildArgs: (dir, opts) => [
      `--zipvoice-encoder=${path.join(dir, 'encoder.int8.onnx')}`,
      `--zipvoice-decoder=${path.join(dir, 'decoder.int8.onnx')}`,
      `--zipvoice-data-dir=${path.join(dir, 'espeak-ng-data')}`,
      `--zipvoice-lexicon=${path.join(dir, 'lexicon.txt')}`,
      `--zipvoice-tokens=${path.join(dir, 'tokens.txt')}`,
      `--zipvoice-vocoder=${path.join(dir, 'vocos_24khz.onnx')}`,
      `--num-steps=${ZIPVOICE_NUM_STEPS}`,
      // 参考音（音色来源）：缺一不可；无 length-scale —— `--speed` 对 ZipVoice 无效，勿传
      ...(opts.reference
        ? [`--reference-audio=${opts.reference.audio}`, `--reference-text=${opts.reference.text}`]
        : []),
      ...commonArgs(),
    ],
  },
];

export function findLocalTtsModel(id: string | undefined): LocalTtsModelDef | undefined {
  if (!id) return undefined;
  return LOCAL_TTS_MODELS.find((m) => m.id === id);
}

/** 模型内容目录（压缩包解压后的顶层目录） */
function contentDir(def: LocalTtsModelDef): string {
  return path.join(modelDir(def.id), def.dirName);
}

/** 零样本模型的内置参考音（UI 的"内置真人参考音"候选） */
export interface LocalTtsBuiltinRef {
  id: string;
  label: string;
  /** 参考音绝对路径 */
  wavPath: string;
  /** 与音频逐字一致的文本；prompt.txt 未收录时为空串 */
  text: string;
  /** 文本是否已知（false 时 UI 需提示用户手填） */
  textKnown: boolean;
}

/** 解析 test_wavs/prompt.txt：每行 `<文件名> <与音频逐字一致的文本>`；缺失/解析失败返回空表 */
async function readPromptTexts(promptPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(promptPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^(\S+\.wav)\s+(.+)$/i);
      if (m) map.set(m[1].toLowerCase(), m[2].trim());
    }
  } catch {
    /* prompt.txt 缺失或不可读：文本全部退化为用户手填 */
  }
  return map;
}

/** 扫描模型自带的参考音：<contentDir>/test_wavs/*.wav，
 *  文本取同目录 prompt.txt（官方包随音频配套，无需用户手打），未收录的留空由用户填。 */
async function listModelRefs(def: LocalTtsModelDef): Promise<LocalTtsBuiltinRef[]> {
  const testDir = path.join(contentDir(def), 'test_wavs');
  let files: string[];
  try {
    files = (await fs.readdir(testDir)).filter((f) => /\.wav$/i.test(f)).sort();
  } catch {
    return [];
  }
  const texts = await readPromptTexts(path.join(testDir, 'prompt.txt'));
  return files.map((f) => {
    const text = texts.get(f.toLowerCase()) ?? '';
    return {
      id: f.replace(/\.wav$/i, ''),
      label: f,
      wavPath: path.join(testDir, f),
      text,
      textKnown: !!text,
    };
  });
}

// ============================================================
// 通用男/女声（内置参考音）
// ============================================================

/**
 * 零样本克隆的「通用男声 / 通用女声」：一次性合成后缓存在 <APP_ROOT>/.tts/refs/builtin/，
 * 让 ZipVoice 开箱就有**一个女声、一个男声**可选，用户不必自己录音或上传。
 *
 * 合成源（都是本地已有资产，不额外下载）：
 *   - female：vits-zh-ll 的女声（fushiyu）合成，再转码为 ZipVoice 要求的 24kHz 单声道；
 *   - male：用 ZipVoice 自己克隆模型自带的男声参考音合成（同模型内部自举）。
 * text 与音频逐字一致——音频本就是用这段 text 合成的。
 */
type GenericRefSource =
  | { kind: 'preset'; modelId: string; voice: string }
  | { kind: 'clone' };

interface GenericRef {
  id: string;
  label: string;
  text: string;
  source: GenericRefSource;
}

const GENERIC_REFS: GenericRef[] = [
  {
    id: 'generic-female',
    label: 'Generic female',
    text: '你好，我是通用女声，下面由我来为你朗读。',
    source: { kind: 'preset', modelId: VITS_LL_MODEL_ID, voice: 'fushiyu' },
  },
  {
    id: 'generic-male',
    label: 'Generic male',
    text: '你好，我是通用男声，很高兴为你朗读这段内容。',
    source: { kind: 'clone' },
  },
];

const execFileAsync = promisify(execFile);
const TRANSCODE_TIMEOUT_MS = 60_000;

/** 通用参考音缓存目录（与用户上传的 .tts/refs/*.wav 分开，便于区分内置资产） */
function builtinRefsDir(): string {
  return path.join(ttsRoot(), 'refs', 'builtin');
}

/** 生成中的单例 promise：面板轮询会并发打 GET，避免重复合成同一批参考音 */
let genericRefsInflight: Promise<void> | null = null;

/** 仍缺文件的通用参考音（已完成的不重做） */
async function missingGenericRefs(): Promise<Array<(typeof GENERIC_REFS)[number]>> {
  const dir = builtinRefsDir();
  const out: Array<(typeof GENERIC_REFS)[number]> = [];
  for (const g of GENERIC_REFS) {
    if (!(await pathExists(path.join(dir, `${g.id}.wav`)))) out.push(g);
  }
  return out;
}

/** 自举源：ZipVoice 官方 test_wavs 里的男声（文件名不含 female 的第一条） */
function pickBootstrapMale(refs: LocalTtsBuiltinRef[]): LocalTtsBuiltinRef | undefined {
  return refs.find((r) => r.textKnown && !/female/i.test(r.id));
}

/** 转码为 24kHz 单声道 16-bit PCM wav；ffmpeg 缺失或失败返回 false（调用方放弃本次，不留半个文件） */
async function transcodeTo24k(src: string, dest: string): Promise<boolean> {
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) return false;
  try {
    await execFileAsync(
      ffmpegPath,
      ['-y', '-i', src, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', dest],
      { timeout: TRANSCODE_TIMEOUT_MS },
    );
  } catch {
    return false;
  }
  const size = await fs.stat(dest).then((s) => s.size).catch(() => 0);
  return size > 0;
}

/** 确保通用男/女声已生成（幂等；单条失败只跳过该条，不阻断参考音列表） */
async function ensureGenericRefs(def: LocalTtsModelDef): Promise<void> {
  if ((await missingGenericRefs()).length === 0) return;
  if (!genericRefsInflight) {
    genericRefsInflight = (async () => {
      const dir = builtinRefsDir();
      await fs.mkdir(dir, { recursive: true });
      // 自举源取模型自带参考音（不走 listBuiltinRefs，避免递归）
      const male = pickBootstrapMale(await listModelRefs(def));
      for (const g of await missingGenericRefs()) {
        const dest = path.join(dir, `${g.id}.wav`);
        try {
          if (g.source.kind === 'preset') {
            const { modelId, voice } = g.source;
            if (!(await isLocalTtsModelReady(modelId))) continue;
            const tmp = await synthesizeWithSherpa(g.text, { modelId, voice });
            const ok = await transcodeTo24k(tmp.filePath, dest);
            await fs.rm(tmp.filePath, { force: true }).catch(() => undefined);
            if (!ok) await fs.rm(dest, { force: true }).catch(() => undefined);
          } else {
            if (!male) continue;
            const tmp = await synthesizeWithSherpa(g.text, {
              modelId: def.id,
              reference: { audio: male.wavPath, text: male.text },
            });
            await fs.rename(tmp.filePath, dest);
          }
        } catch {
          /* 单条失败：列表里少一条通用声，下次打开设置再重试 */
        }
      }
    })().finally(() => {
      genericRefsInflight = null;
    });
  }
  await genericRefsInflight.catch(() => undefined);
}

/** 列出零样本模型可选的参考音：通用男/女声在前（开箱即用），模型自带样例在后 */
export async function listBuiltinRefs(id: string): Promise<LocalTtsBuiltinRef[]> {
  const def = findLocalTtsModel(id);
  if (!def || def.kind !== 'zero-shot') return [];
  await ensureGenericRefs(def);
  const dir = builtinRefsDir();
  const generics: LocalTtsBuiltinRef[] = [];
  for (const g of GENERIC_REFS) {
    const wavPath = path.join(dir, `${g.id}.wav`);
    if (await pathExists(wavPath)) {
      generics.push({ id: g.id, label: g.label, wavPath, text: g.text, textKnown: true });
    }
  }
  return [...generics, ...(await listModelRefs(def))];
}

// ============================================================
// 平台 / 安装状态
// ============================================================

/** 当前平台是否可用（与 STT 同：仅 macOS arm64 / x64 有官方 shared 包） */
export function isLocalTtsSupported(): boolean {
  return isLocalSttSupported();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 引擎（`sherpa-onnx-offline-tts`）是否就绪：shared 包装好后同 bin 目录下即有该可执行文件 */
export async function isLocalTtsBinaryInstalled(): Promise<boolean> {
  if (!isLocalTtsSupported()) return false;
  try {
    return (await fs.stat(sherpaTtsBinaryPath())).size > 0;
  } catch {
    return false;
  }
}

export async function isLocalTtsModelReady(id: string): Promise<boolean> {
  const def = findLocalTtsModel(id);
  if (!def) return false;
  if (!(await isLocalTtsBinaryInstalled())) return false;
  const dir = contentDir(def);
  for (const r of def.required) {
    const p = path.join(dir, r.name);
    if (r.dir) {
      if (!(await pathExists(p))) return false;
      continue;
    }
    let size = 0;
    try {
      size = (await fs.stat(p)).size;
    } catch {
      return false;
    }
    if (size < (r.bytes ?? 1)) return false;
  }
  return true;
}

/** 播客跨模型配对的一条本地预置音色（preset 专用） */
export interface LocalPresetVoice {
  /** 覆盖用 id：单音色模型 = 模型 id；多音色模型 = `<模型 id>:<音色 id>` */
  id: string;
  /** UI 展示名（英文） */
  label: string;
  /** 所属模型 id（= 合成时的 localModel） */
  modelId: string;
  /** 多音色模型内的音色 id（= 合成时的 localVoice）；单音色模型为 undefined */
  voiceId?: string;
  /** 性别（播客据此配「一男一女」）；两处都未标注时为 undefined */
  gender?: LocalVoiceGender;
}

/**
 * 列举全部**已就绪**的本地预置音色（可跨模型），供播客双主播配对：
 *   - 单音色模型 = 一条，性别取模型级 `gender`；
 *   - 多音色模型（vits-zh-ll）= 逐条，性别取音色级 `gender`（缺省回落到模型级）；
 *   - 未下载 / 未就绪的模型不列出（配了也合成不出来）；零样本模型不参与（走参考音那一支）。
 */
export async function listLocalPresetVoices(): Promise<LocalPresetVoice[]> {
  const out: LocalPresetVoice[] = [];
  for (const def of LOCAL_TTS_MODELS) {
    if ((def.kind ?? 'preset') !== 'preset') continue;
    if (!(await isLocalTtsModelReady(def.id))) continue;
    const voices = def.voices ?? [];
    if (voices.length > 0) {
      for (const v of voices) {
        out.push({
          id: `${def.id}:${v.id}`,
          label: `${def.label} · ${v.label}`,
          modelId: def.id,
          voiceId: v.id,
          gender: v.gender ?? def.gender,
        });
      }
    } else {
      const tag = def.gender === 'female' ? 'Female' : def.gender === 'male' ? 'Male' : '';
      out.push({ id: def.id, label: tag ? `${def.label} · ${tag}` : def.label, modelId: def.id, gender: def.gender });
    }
  }
  return out;
}

// ============================================================
// 安装 / 卸载
// ============================================================

/** 安装共享引擎（复用 STT 的 shared 包安装：同包内含 TTS CLI） */
export async function installLocalTtsBinary(): Promise<void> {
  await installLocalSttBinary();
}

export async function installLocalTtsModel(id: string): Promise<void> {
  const def = findLocalTtsModel(id);
  if (!def) throw new Error(`Unknown local TTS model: ${id}`);
  const dir = modelDir(id);
  const archivePath = path.join(dir, def.archive.name);
  await downloadFile(mirrorUrls(def.archive.url), archivePath, def.archive.bytes);

  // 解压到模型目录 → 产出 <dir>/<dirName>/（tar 幂等覆盖；压缩包本身在解压范围内但无害）
  await extractTarBz2(archivePath, dir);
  if (!(await pathExists(contentDir(def)))) {
    throw new Error(`Archive did not contain the expected "${def.dirName}" directory`);
  }

  for (const f of def.extraFiles) {
    await downloadFile(mirrorUrls(f.url), path.join(contentDir(def), f.name), f.bytes);
  }

  // 安装成功即清理压缩包（模型包动辄数百 MB，长期占用不划算）
  await fs.rm(archivePath, { force: true }).catch(() => undefined);
}

/** 删除已下载的本地模型（连同中断残留的 `.part`/压缩包），释放磁盘；幂等 */
export async function removeLocalTtsModel(id: string): Promise<void> {
  if (!findLocalTtsModel(id)) throw new Error(`Unknown local TTS model: ${id}`);
  await fs.rm(modelDir(id), { recursive: true, force: true });
}

// ============================================================
// 任务状态（globalThis 持久化，规避 Next.js dev 热重载丢状态）
// ============================================================

export interface LocalTtsJob {
  key: string;
  kind: 'binary' | 'model';
  modelId?: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const JOB_STORE_KEY = '__bobLocalTtsJobs';
function jobStore(): Map<string, LocalTtsJob> {
  const g = globalThis as unknown as Record<string, Map<string, LocalTtsJob> | undefined>;
  if (!g[JOB_STORE_KEY]) g[JOB_STORE_KEY] = new Map();
  return g[JOB_STORE_KEY]!;
}

/** 最近一次任务（进行中优先），供 UI 展示进度与错误 */
export function getLatestTtsJob(): LocalTtsJob | null {
  const all = [...jobStore().values()].sort((a, b) => b.startedAt - a.startedAt);
  return all.find((j) => j.status === 'running') ?? all[0] ?? null;
}

/** 启动后台下载任务（同一时刻只允许一个），立即返回供 UI 轮询 */
export function startLocalTtsJob(kind: 'binary' | 'model', modelId?: string): LocalTtsJob {
  const running = [...jobStore().values()].find((j) => j.status === 'running');
  if (running) throw new Error('Another local TTS download is already running — wait for it to finish.');
  if (kind === 'model' && !findLocalTtsModel(modelId)) throw new Error(`Unknown local TTS model: ${modelId}`);
  // 引擎与 STT 共享同一份 shared 包：STT 侧正在下载时不得并发重复安装
  if (kind === 'binary' && getLatestSttJob()?.status === 'running') {
    throw new Error('The offline engine is already being downloaded (from Audio STT) — wait for it to finish.');
  }

  const key = kind === 'binary' ? 'binary' : `model:${modelId}`;
  const job: LocalTtsJob = { key, kind, modelId, status: 'running', startedAt: Date.now() };
  jobStore().set(key, job);

  void (async () => {
    try {
      if (kind === 'binary') await installLocalTtsBinary();
      else await installLocalTtsModel(modelId!);
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
// 状态汇总（GET /api/tts/local）
// ============================================================

export interface LocalTtsModelStatus {
  id: string;
  label: string;
  description: string;
  /** preset = 固定音色库；zero-shot = 需参考音的克隆模型（UI 据此渲染参考音配置） */
  kind: 'preset' | 'zero-shot';
  /** 多音色预置模型的音色表；空 = 单音色模型（UI 不渲染音色下拉） */
  voices: LocalTtsVoice[];
  ready: boolean;
  downloadedBytes: number;
  totalBytes: number;
  /** 内置参考音（仅 zero-shot 且就绪时非空；文本来自官方 prompt.txt） */
  builtinRefs: LocalTtsBuiltinRef[];
}

export interface LocalTtsStatus {
  supported: boolean;
  engine: { installed: boolean; path: string; downloadedBytes: number; totalBytes: number };
  models: LocalTtsModelStatus[];
  job: LocalTtsJob | null;
}

export async function getLocalTtsStatus(): Promise<LocalTtsStatus> {
  const supported = isLocalTtsSupported();
  const engine = await getSherpaEngineStatus();

  const models: LocalTtsModelStatus[] = [];
  for (const def of LOCAL_TTS_MODELS) {
    const dir = modelDir(def.id);
    let downloadedBytes = await downloadProgress(path.join(dir, def.archive.name), def.archive.bytes);
    for (const f of def.extraFiles) {
      downloadedBytes += await downloadProgress(path.join(contentDir(def), f.name), f.bytes);
    }
    downloadedBytes = Math.min(downloadedBytes, def.totalBytes);
    const ready = await isLocalTtsModelReady(def.id);
    const kind = def.kind ?? 'preset';
    models.push({
      id: def.id,
      label: def.label,
      description: def.description,
      kind,
      voices: def.voices ?? [],
      ready,
      // 装好后压缩包已清理，逐文件读进度会偏小 → 就绪即按满额上报
      downloadedBytes: ready ? def.totalBytes : downloadedBytes,
      totalBytes: def.totalBytes,
      // 内置参考音：仅克隆模型需要，且只在就绪后扫描（未下载时必然为空）
      builtinRefs: kind === 'zero-shot' && ready ? await listBuiltinRefs(def.id) : [],
    });
  }

  return { supported, engine, models, job: getLatestTtsJob() };
}

// ============================================================
// 合成
// ============================================================

function runSherpaTts(args: string[]): Promise<{ stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (!isLocalTtsBinaryInstalled()) {
      reject(new Error('Offline TTS engine not installed. Download it in Settings → Roles → Audio TTS Model.'));
      return;
    }
    const child = spawn(sherpaTtsBinaryPath(), args, {
      // 与 STT 同款：shared 包运行时依赖同目录 dylib
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: [sherpaLibDir(), process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':'),
      },
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`本地 TTS 合成超时（${TTS_TIMEOUT_MS / 1000}s）`));
    }, TTS_TIMEOUT_MS);

    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stderr, code: code ?? -1 }); });
  });
}

export interface SherpaSynthesizeResult {
  filePath: string;
  bytes: number;
  /** 固定 wav */
  format: string;
  durationMs: number;
}

/**
 * 用 sherpa-onnx-offline-tts 合成并落盘。
 * @param opts.modelId 已下载的本地模型 id（见 LOCAL_TTS_MODELS）
 * @param opts.speed   语速倍率（与云端同口径）；**对 zero-shot（ZipVoice）无效，会被忽略**
 * @param opts.voice   多音色预置模型的音色 id（见 LocalTtsVoice.id）；未知/缺省回落到模型首条
 * @param opts.reference 零样本克隆的参考音（绝对路径优先；相对路径按模型内容目录解析）+ 逐字文本，必填
 */
export async function synthesizeWithSherpa(
  text: string,
  opts: {
    modelId: string;
    speed?: number;
    voice?: string;
    reference?: { audio?: string; text?: string };
  },
): Promise<SherpaSynthesizeResult> {
  const def = findLocalTtsModel(opts.modelId);
  if (!def) throw new Error(`Unknown local TTS model: ${opts.modelId}`);
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty TTS input — nothing to synthesize');
  if (trimmed.length > MAX_TEXT_CHARS) {
    throw new Error(`TTS text too long (${trimmed.length} > ${MAX_TEXT_CHARS} chars) — split it into smaller parts`);
  }
  if (!(await isLocalTtsModelReady(def.id))) {
    throw new Error(`Local TTS model not fully downloaded: ${def.label}. Resume the download in Settings.`);
  }

  // 零样本克隆：需要参考音 + 与之一致的文本，否则模型无音色可复刻
  let reference: { audio: string; text: string } | undefined;
  if (def.kind === 'zero-shot') {
    const rawAudio = opts.reference?.audio?.trim();
    const refText = (opts.reference?.text ?? '').trim();
    if (rawAudio) {
      // 内置参考音与自定义上传统一按绝对路径传入；相对路径按模型内容目录解析（兼容手填）
      const audio = path.isAbsolute(rawAudio) ? rawAudio : path.join(contentDir(def), rawAudio);
      if (!(await pathExists(audio))) {
        throw new Error(`Reference audio not found: ${audio} — re-select or re-upload it in Settings.`);
      }
      if (!refText) {
        throw new Error(
          'Reference transcript is required for voice cloning — type exactly what is said in the reference audio.',
        );
      }
      reference = { audio, text: refText };
    } else {
      // 未选参考音 → 回落到模型内置的真人参考音（装完即可用，不必先手动挑一个），
      // 避免"选中了却没声音"这种看起来像没生效的失败
      const builtin = await listBuiltinRefs(def.id);
      const first = builtin.find((r) => r.textKnown) ?? builtin[0];
      if (!first) {
        throw new Error(
          `"${def.label}" clones a voice — upload a reference audio in Settings → Roles → Audio TTS Model first.`,
        );
      }
      if (!first.text) {
        throw new Error(
          `Reference transcript is missing for ${first.label} — type it in Settings → Roles → Audio TTS Model.`,
        );
      }
      reference = { audio: first.wavPath, text: first.text };
    }
  }

  // 多音色预置：音色 id → sherpa `--sid`；未知/未选一律回落首条，避免"选了却没声音"
  const sid = def.voices?.length
    ? (def.voices.find((v) => v.id === opts.voice) ?? def.voices[0]).sid
    : undefined;

  const dir = path.join(resolveAppRoot(), 'butler', 'tts');
  await fs.mkdir(dir, { recursive: true });
  const hash = createHash('sha256').update(trimmed).digest('hex').slice(0, 8);
  const filePath = path.join(dir, `${Date.now()}-${hash}.wav`);

  const args = [
    ...def.buildArgs(contentDir(def), { speed: opts.speed, sid, reference }),
    `--output-filename=${filePath}`,
    // 待合成文本是**位置参数**（CLI 无 --text 开关：传 --text= 会打印 usage 并 exit 255）
    trimmed,
  ];

  const t0 = Date.now();
  const { stderr, code } = await runSherpaTts(args);
  if (code !== 0) {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    const tail = stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 400);
    throw new Error(`Local TTS synthesis failed (exit ${code}): ${tail}`);
  }
  const bytes = await fs.stat(filePath).then((s) => s.size).catch(() => 0);
  if (bytes === 0) {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    throw new Error('Local TTS synthesis produced an empty file — retry or pick another voice');
  }
  return { filePath, bytes, format: 'wav', durationMs: Date.now() - t0 };
}