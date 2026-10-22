/**
 * lib/stt/speaker-embed.ts — 声纹向量提取（跨录音认出同一个人）
 *
 * 定位：说话人分离只给出「这次录音里有几个声音」，编号每次重排、不可命名、不能跨录音对齐。
 * 要给它接上身份，必须能比较两段语音「是不是同一个人」——本模块负责这一步：把一段 16k 单声道 wav
 * 变成定长的声纹向量（embedding），此后「同不同人」就退化成一次余弦比较（纯函数，可单测）。
 *
 * 为什么自己写二进制：shared 包里**没有**读文件的声纹识别 CLI（只有麦克风版），
 * 故用本项目 native/spk_embed.c 直接调 sherpa-onnx 的 C API，与 punct-server 同款做法：
 * 首次使用时用 clang 编成 `.stt/bin/spk-embed`，以 mtime 比对做幂等缓存（源码未改就不重编）。
 *
 * 为什么是**批量一次性**而不是常驻服务：调用方天然是「一次录音 → 若干语音段」，一批一起算
 * 只加载一次 39MB 模型；没有请求/响应配对与空闲回收的必要，比常驻服务简单得多。
 *
 * 模型：与分离用的是**同一个** 3dspeaker ERes2Net（见 sherpa.speakerEmbeddingModelPath），
 * 故分离出的簇与声纹库处在同一向量空间，余弦可直接比。实测同一人 0.63~0.87、不同人 0.08~0.22。
 *
 * 失败口径：本模块**不吞错**——不可用（引擎/模型缺失、clang 编译失败、进程非 0 退出）即抛，
 * 由调用方决定降级（身份层是增强项，绝不能因此阻断转写）；单个 wav 读不了/算不出只影响它那一行，
 * 对应位置返回 null。
 */
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { sherpaLibDir, sherpaSpkEmbedBinaryPath, speakerEmbeddingModelPath } from '@/lib/stt/sherpa';
import { IS_WIN, sharedLibEnv } from '../platform';

const execFileAsync = promisify(execFile);

/** 3dspeaker ERes2Net 的向量维度；解析结果与它不符说明换了模型，声纹库不再可比，直接报错 */
export const EMBEDDING_DIM = 512;

/** 单次调用的最大文件数：防止 argv 过长；正常一次录音远小于此（故实际只加载一次模型） */
const MAX_BATCH = 128;
/** 推理线程数（与 diarize 一致，导入流程里是同步等待） */
const NUM_THREADS = 2;
const BUILD_TIMEOUT_MS = 120_000;
/** 单批上限：模型加载 + 每段一次推理，实测毫秒级；给足余量应对长音频的多个段 */
const EMBED_TIMEOUT_MS = 10 * 60 * 1000;
/** stdout 上限：512 个 %.7g 约 5KB/行，128 个一批 ≈ 0.7MB，给足余量 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

// ============================================================
// 按需构建（C 源码 → .stt/bin/spk-embed）
// ============================================================

/** 构建失败在进程内只记一次（编译失败是确定性的：没装 clang / 源码有错），避免每次请求都重试 clang */
let buildError: string | null = null;

/**
 * C 源码候选路径（按存在性取第一个），与 pdf/docx 脚本同口径（见 app/api/docx/revise/route.ts）：
 *   1. `cwd/scripts/spk_embed.c` —— 打包版：由 package-release.sh 复制进 next-standalone/scripts/
 *      （打包版 cwd = <Resources>/next-standalone）。**不能靠 outputFileTracingIncludes**：
 *      它会把源码放进 next-standalone/src/，而打包收尾会整棵删掉 src，源码随之丢失。
 *   2. `cwd/src/lib/stt/native/spk_embed.c` —— dev 下 cwd = projects 根
 *   3. `__dirname/native/spk_embed.c` —— CJS/tsup 产物内的相对位置
 */
function sourceCandidates(): string[] {
  const list = [
    path.join(process.cwd(), 'scripts/spk_embed.c'),
    path.join(process.cwd(), 'src/lib/stt/native/spk_embed.c'),
  ];
  if (typeof __dirname !== 'undefined') list.push(path.join(__dirname, 'native/spk_embed.c'));
  return list;
}

async function resolveSourcePath(): Promise<string> {
  for (const c of sourceCandidates()) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error(`spk-embed source not found (tried: ${sourceCandidates().join(', ')})`);
}

/** 幂等构建：二进制比源码新就直接复用；否则 clang 编译后原子落位 */
async function ensureBuilt(binaryPath: string): Promise<void> {
  if (buildError) throw new Error(buildError);
  // 与 punct-server 同因：spk_embed.c 依赖 POSIX clang，Windows 需预编译 DLL（阶段 G，尚未做）。
  if (IS_WIN) {
    buildError =
      'spk-embed is not built for Windows yet (native/spk_embed.c needs a POSIX clang toolchain); speaker identification is unavailable.';
    throw new Error(buildError);
  }
  const src = await resolveSourcePath();
  const [srcStat, binStat] = await Promise.all([
    fs.stat(src),
    fs.stat(binaryPath).catch(() => null),
  ]);
  if (binStat && binStat.size > 0 && binStat.mtimeMs >= srcStat.mtimeMs) return;
  const tmp = `${binaryPath}.tmp-${process.pid}`;
  try {
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await execFileAsync('/usr/bin/clang', ['-O2', '-o', tmp, src], { timeout: BUILD_TIMEOUT_MS });
    await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, binaryPath);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    buildError = `could not build spk-embed: ${e instanceof Error ? e.message : String(e)}`;
    throw new Error(buildError);
  }
}

// ============================================================
// 输出解析（纯函数，便于单测）
// ============================================================

/**
 * 解析一行：`OK <dim> <f0> ... <f_{dim-1}>` → 向量；其余（`ERR ...` / 引擎噪音）→ null。
 * 维度自洽性在这层校验：声明的 dim 必须与实际数值个数一致，否则视为坏行。
 */
export function parseEmbeddingLine(line: string): number[] | null {
  const t = line.trim();
  if (!t.startsWith('OK ')) return null;
  const parts = t.slice(3).trim().split(/\s+/);
  const dim = Number(parts[0]);
  if (!Number.isInteger(dim) || dim <= 0 || parts.length !== dim + 1) return null;
  const vec = parts.slice(1).map(Number);
  if (vec.some((v) => !Number.isFinite(v))) return null;
  return vec;
}

/**
 * 整段 stdout → 与输入一一对应的向量数组（失败位置为 null）。
 * 只认 `OK`/`ERR` 两开头的行（引擎日志若冒到 stdout 一律忽略，不影响配对）；
 * 有效行数必须等于输入数——不等说明契约被破坏，此时**宁可报错也不能错位**：
 * 一旦错位就会把某个人的声纹算到另一个人头上。
 */
export function parseEmbeddingOutput(stdout: string, expected: number): (number[] | null)[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('OK ') || l.startsWith('ERR'));
  if (lines.length !== expected) {
    throw new Error(`spk-embed returned ${lines.length} result lines for ${expected} inputs`);
  }
  return lines.map(parseEmbeddingLine);
}

// ============================================================
// 向量运算（纯函数，便于单测）
// ============================================================

/** 余弦相似度；维度不符或零向量返回 0 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** L2 归一化；零向量原样返回（避免除零） */
export function normalizeEmbedding(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!(norm > 0)) return [...v];
  return v.map((x) => x / norm);
}

/**
 * 多段向量 → 质心（逐维均值）。
 * 先各自归一化再平均：否则「音量大的段」会因为模长更大而主导质心。
 * 空输入、维度不一致返回 null（调用方据此放弃该说话人的身份）。
 */
export function centroidOf(vecs: number[][]): number[] | null {
  const use = vecs.filter((v) => v.length > 0);
  if (use.length === 0) return null;
  const dim = use[0].length;
  if (use.some((v) => v.length !== dim)) return null;
  const out = new Array<number>(dim).fill(0);
  for (const v of use) {
    const u = normalizeEmbedding(v);
    for (let i = 0; i < dim; i++) out[i] += u[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= use.length;
  return out;
}

// ============================================================
// 调用
// ============================================================

/** 跑一批 wav（内部按 MAX_BATCH 分批，正常情况只有一批）；返回与入参一一对应的向量 */
async function runBatch(wavPaths: string[]): Promise<(number[] | null)[]> {
  const binaryPath = sherpaSpkEmbedBinaryPath();
  await ensureBuilt(binaryPath);
  const model = speakerEmbeddingModelPath();
  if (!model) {
    throw new Error('Speaker embedding model is not available — download the speaker diarization model in Settings.');
  }
  const { stdout } = await execFileAsync(
    binaryPath,
    [model, sherpaLibDir(), String(NUM_THREADS), ...wavPaths],
    {
      timeout: EMBED_TIMEOUT_MS,
      maxBuffer: MAX_STDOUT_BYTES,
      env: {
        ...process.env,
        ...sharedLibEnv(sherpaLibDir()),
      },
    },
  );
  const vecs = parseEmbeddingOutput(stdout, wavPaths.length);
  // 维度守卫：模型换了维度就说明声纹库不再可比，早报错胜过静默给出错误的匹配
  for (const v of vecs) {
    if (v && v.length !== EMBEDDING_DIM) {
      throw new Error(`Unexpected speaker embedding dimension ${v.length} (expected ${EMBEDDING_DIM}) — the embedding model changed.`);
    }
  }
  return vecs;
}

/**
 * 批量提取声纹向量；返回与入参一一对应（读不了/算不出的位置为 null）。
 * 不可用（引擎/模型缺失、cwd 里找不到 C 源码、clang 编译失败、进程非 0 退出）即抛错，调用方降级。
 */
export async function embedWavs(wavPaths: string[]): Promise<(number[] | null)[]> {
  if (wavPaths.length === 0) return [];
  const out: (number[] | null)[] = [];
  for (let i = 0; i < wavPaths.length; i += MAX_BATCH) {
    const batch = wavPaths.slice(i, i + MAX_BATCH);
    out.push(...(await runBatch(batch)));
  }
  return out;
}