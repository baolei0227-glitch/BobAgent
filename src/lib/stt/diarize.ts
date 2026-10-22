/**
 * lib/stt/diarize.ts — 本地离线说话人分离（sherpa-onnx-offline-speaker-diarization）
 *
 * 定位：给「导入录音」的整段音频标出「谁在什么时候说」，供 parseAudio 按说话人切块转写，
 * 从而在会议记录里产出 `[说话人 N]` 分块。全程本地、音频不出网。
 *
 * 为什么长音频要分段、又不能各段独立编号：
 * 整段 pyannote 在 1 小时以上会逼近 30 分钟超时，也没有中间进度；但各段独立聚类会让
 * 「第 2 段的说话人 1」与「第 1 段的说话人 1」变成两个人。故 >20 分钟的音频按 10 分钟分段，
 * 段内聚类、段间用声纹质心对齐到同一套全局 speaker id，最后合并、缓存、各窗口从缓存切片。
 * 短音频仍整段跑一次（更稳，也少一次切段开销）。
 *
 * 簇的总量由 CLI 聚类阈值决定，但阈值只是一个标量：长录音里同一个人会因远近场/音量差异被切成
 * 好几簇（实测 300s 两人录音在 0.9 下切出 10 簇）。故拿到每簇声纹质心后，再按质心余弦做一次
 * 「同一个人合并」（planClusterMerge）——这是压掉假说话人的主力，阈值只负责把量级压到可控。
 *
 * 结果落 `<project>/.cache/diar/`，刻意**不放** `.cache/parse/`：parse 缓存有 2000 条 LRU
 * （写后按 mtime 删最旧）与归档 30 天整目录清理，会把体积大得多的分离结果当普通条目挤掉。
 *
 * 实测调用契约（v1.13.8，本机跑通 0-four-speakers-zh.wav）：
 *   - stdout：先一行 config dump，再逐段一行 `0.318 -- 6.865 speaker_00`（编号两位补零）
 *   - stderr：`progress xx%` 与耗时/RTF（噪音；解析仍同时扫它做兜底）
 *   - `--min-duration-on` = 「短于此时长的语音段直接丢弃」；曾设 0 以免丢短句，但实测几十毫秒的
 *     抖动会全变成假换人，故回调到 0.3。丢掉的只是「标签」不是音频：切块以段起点为界，
 *     被丢段与静音都会并入相邻块，文稿不会出现空洞
 *   - 聚类阈值方向：larger threshold → fewer clusters（smaller → more），不要写反
 *   - **输出的段会互相重叠**（一条长段 + 若干嵌套短段），不是分区；切块前必须自己还原成
 *     互不重叠的分区，否则按「下一段的起点」切会把别人的话算到当前说话人头上
 */
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import {
  findLocalModel,
  isDiarizationModel,
  isLocalSttBinaryInstalled,
  isLocalSttModelReady,
  sherpaDiarizationBinaryPath,
  sherpaLibDir,
  sherpaModelDir,
} from '@/lib/stt/sherpa';
import { centroidOf, cosineSimilarity, embedWavs, normalizeEmbedding } from '@/lib/stt/speaker-embed';
import { sharedLibEnv } from '../platform';

const execFileAsync = promisify(execFile);

/** 分离模型固定用注册表里这一条（能力位 diarizes） */
const MODEL_ID = 'diarize-pyannote-3dspeaker';

/** 切块/聚类参数一变就 +1：缓存键带着它，旧结果自动失效（不需要用户手动清缓存） */
// v3：开启 compute-confidence 并缓存每簇声纹质心（跨录音认人的身份层）；旧缓存缺这两项，故 +1
// v4：auto 聚类阈值 0.9→0.95，并按声纹质心把「同一人被拆出的多个簇」并回一个人（切块口径变了）
// v5：duo/group 不再做声纹合并（用户已声明人数时，CLI 聚类就是权威；0.5 的余弦阈值会把
//     同性别/同电话音色的两位真人并成一个，正是"选了 2 人却仍没有标签"的来源）
export const DIAR_VERSION = 5;

// 聚类阈值（CLI help：larger → fewer clusters）
// 实测（本机两段真实录音 76.5s / 166.1s）：0.6 会把 2-3 人的对话切成 17 / 19 簇；
// 本机 300s 双人录音复核：0.5 → 35 簇、0.9 → 10 簇、0.95 → 6 簇、0.97 与 0.95 持平。
// 0.9 对长录音明显偏松（同一个人因远近场/音量差异被切成几簇），故抬到 0.95 那个平台上。
const THRESHOLD_AUTO = 0.95; // auto：压掉假簇，又不至于把两位真人并成一个
const THRESHOLD_GROUP = 0.8; // group：用户已声明 3 人以上，放宽一点留住小角色

// 切块参数
const MERGE_GAP_SEC = 1.0; // 同人相邻段间隔小于此值即合并
const ABSORB_SHORT_SEC = 1.5; // 短于此时长的换人段才可能被当作「插入语」（嗯/对）吸收
const ABSORB_MIN_NEIGHBOR_SEC = 5; // 且前后两块**合计**要够长，否则是快速对话，宁可按轮切

// 极小簇归并：auto 模式下，总说话时长不到「主说话人时长 × 此比例」的簇判为假人，并进最近的簇。
// 实测 5% 恰好吃掉 76.5s 录音里只说了 3.0s 的假簇（→ 3 簇）与 166.1s 录音里只说了 1.2s 的假簇（→ 2 簇），
// 而真人（都 ≥ 主说话人的 5%）都留着。group 模式不启用：用户已声明 3 人以上，不该再替他裁人。
const TINY_CLUSTER_SHARE_AUTO = 0.05;
const MAX_CHUNK_SEC = 60; // 单块上限（与旧固定切片一致，避免单次转写过长）
const MAX_CHUNKS = 300; // 切块数上限：超了就退回固定 60s 网格
const MIN_AVG_CHUNK_SEC = 3; // 平均块长下限：太碎就退回固定网格

/**
 * 长音频分段分离：整段跑 pyannote 在 1 小时以上会逼近 30 分钟超时，而且没有中间进度。
 * 超过阈值就按 10 分钟一段切开、两段并行；每段内部照常聚类，段与段之间用声纹质心对齐
 * （同一人跨段保持同一个全局 speaker id），最后再合并成一份 turns。
 */
const LONG_DIAR_THRESHOLD_SEC = 20 * 60;
const LONG_DIAR_CHUNK_SEC = 10 * 60;
const LONG_DIAR_THREADS = 2; // 4 段并行 × 2 线程 = 8 核；比 2 段 × 4 线程更快
const LONG_DIAR_CONCURRENCY = 4;
const LONG_DIAR_MATCH_SIM = 0.5;
const LONG_DIAR_MAX_SPEAKERS = 8; // auto 模式跨段允许的全局人数上限；duo 另有 2 人硬上限

// 每簇声纹质心（跨录音认人的身份层）
const MAX_CENTROID_SLICES = 3; // 每簇最多取几段来算质心（多取只是更稳，边际收益递减）
const MIN_CENTROID_SEC = 1.0; // 短于此的段不参与：声纹噪声大，会污染质心

// 缓存
const DIAR_CACHE_DIR = 'diar';
const DIAR_CACHE_MAX_ENTRIES = 200;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
/** 分离耗时预算：实测 RTF ≈ 0.15（2 线程），按音频时长 ×3 给足余量，下限 5 分钟、上限 30 分钟 */
function timeoutFor(durationSec: number | null): number {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(5 * 60 * 1000, Math.round(durationSec * 3 * 1000)));
}

/** 参会人数口径 → 分离模式；solo 返回 null = 不做分离 */
export type DiarMode = 'auto' | 'duo' | 'group';
export function diarModeOf(speakers: string | undefined | null): DiarMode | null {
  if (speakers === 'solo') return null;
  if (speakers === 'duo') return 'duo';
  if (speakers === 'group') return 'group';
  return 'auto';
}

/** CLI 给出的一段（秒 + 0 基说话人编号） */
export interface DiarTurn {
  start: number;
  end: number;
  speaker: number;
  /** CLI 的聚类置信度（compute-confidence 开启时才有；缺失表示未提供） */
  confidence?: number;
}

/** 切块后的一段（单一说话人；speaker = null 表示该段没有语音重叠、归不到人） */
export interface DiarChunk {
  start: number;
  end: number;
  speaker: number | null;
}

/**
 * 一个说话人簇的声纹质心（身份层用）：跨录音比较「是不是同一个人」。
 * speaker 与 DiarChunk.speaker 同口径（0 基）；confidence 是该簇各段聚类置信度的均值（无则 null）。
 */
export interface ClusterCentroid {
  speaker: number;
  centroid: number[];
  confidence: number | null;
}

// ============================================================
// 可用性
// ============================================================

/** 引擎已装 + 分离模型（两个文件）齐全 */
export async function isDiarizationAvailable(): Promise<boolean> {
  if (!(await isLocalSttBinaryInstalled())) return false;
  return isLocalSttModelReady(MODEL_ID);
}

// ============================================================
// CLI 调用与解析
// ============================================================

/**
 * 解析 CLI 输出 → 段列表。
 * 同时扫 stdout 与 stderr（上游未文档化打印流，双流兜底避免踩空），按 (start,end,speaker) 去重后按时间排序。
 * 行尾可选 ` confidence=0.642`（compute-confidence 开启时；也可能是 `confidence=n/a`，一律当缺失）。
 */
export function parseDiarizationOutput(stdout: string, stderr = ''): DiarTurn[] {
  const re = /^\s*([\d.]+)\s*--\s*([\d.]+)\s+speaker_(\d+)(?:\s+confidence=(\S+))?\s*$/;
  const out: DiarTurn[] = [];
  const seen = new Set<string>();
  for (const src of [stdout, stderr]) {
    for (const raw of src.split(/\r?\n/)) {
      const m = re.exec(raw);
      if (!m) continue;
      const start = Number(m[1]);
      const end = Number(m[2]);
      const speaker = Number(m[3]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const key = `${start}-${end}-${speaker}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const conf = m[4] === undefined ? NaN : Number(m[4]);
      const turn: DiarTurn = { start, end, speaker };
      if (Number.isFinite(conf)) turn.confidence = conf;
      out.push(turn);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function clusteringArgs(mode: DiarMode): string[] {
  // compute-confidence：每段追加一个聚类置信度（身份层的展示用；实测对分离结果无影响）
  const common = ['--clustering.compute-confidence=true'];
  if (mode === 'duo') return [...common, '--clustering.num-clusters=2'];
  return [...common, `--clustering.cluster-threshold=${mode === 'group' ? THRESHOLD_GROUP : THRESHOLD_AUTO}`];
}

/** 跑一次 CLI（16k 单声道 wav 输入）；失败即抛，由调用方决定降级 */
async function runDiarization(
  wavPath: string,
  mode: DiarMode,
  timeoutMs: number,
  onProgress?: (pct: number) => void,
  threadsOverride?: number,
): Promise<{ stdout: string; stderr: string }> {
  const def = findLocalModel(MODEL_ID);
  if (!def || !isDiarizationModel(def)) {
    throw new Error(`Speaker diarization model is missing from the registry: ${MODEL_ID}`);
  }
  const dir = sherpaModelDir(def.id);
  // 两个子模型默认都只用 1 线程，而这一步是导入流程里的同步等待：按 CPU 核数给足线程
  // （封顶 4、且留一核给界面/别的活；核少时退回 2，别把机器抢死）
  const threads = Math.max(1, Math.min(4, threadsOverride ?? Math.max(2, (os.cpus()?.length ?? 4) - 1)));
  const args = [
    `--segmentation.pyannote-model=${path.join(dir, def.segmentationFile)}`,
    `--embedding.model=${path.join(dir, def.embeddingFile)}`,
    `--segmentation.num-threads=${threads}`,
    `--embedding.num-threads=${threads}`,
    '--min-duration-on=0.3',
    '--min-duration-off=0.5',
    ...clusteringArgs(mode),
    wavPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(sherpaDiarizationBinaryPath(), args, {
      env: {
        ...process.env,
        ...sharedLibEnv(sherpaLibDir()),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Speaker diarization timed out (${Math.round(timeoutMs / 1000)}s).`));
    }, timeoutMs);

    // CLI 把进度打到 **stderr**（strings 已确认格式：`progress %.2f%%`）。管道分块可能把一行
    // 截断在两块之间，故留一个行缓冲，只在遇到换行时才解析——否则会漏掉半行、进度看起来停住。
    let errBuf = '';
    const noteProgress = (chunk: string) => {
      if (!onProgress) return;
      errBuf += chunk;
      const lines = errBuf.split(/\r?\n/);
      errBuf = lines.pop() ?? '';
      for (const line of lines) {
        const m = /progress\s+(\d+(?:\.\d+)?)%/.exec(line);
        if (!m) continue;
        const pct = Number(m[1]);
        if (Number.isFinite(pct)) onProgress(pct);
      }
    };
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      noteProgress(s);
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 300);
        reject(new Error(`Speaker diarization failed (exit ${code}): ${tail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ============================================================
// 切块（纯函数，便于单测）
// ============================================================

/**
 * 段列表 → 单一说话人的切块列表。
 * 规则：把可能重叠的段还原成互不重叠的分区 → 同人相邻合并（含 < MERGE_GAP_SEC 的间隙）→
 * 短促换人插入并进前一块 → 极小簇并进邻块 → 按段起点切 → 超长再切 →
 * 太碎则退回固定 60s 网格（按重叠时长取主导说话人）。
 * 切块以「段起点」为界，故块 0 的时间戳就是该说话人开口的时刻（而不是上一段结束的静音）。
 *
 * @param opts.tinyClusterShare 极小簇阈值（占主说话人时长的比例）；0 = 不启用
 */
export function buildSpeakerChunks(
  turns: DiarTurn[],
  durationSec: number,
  opts: { tinyClusterShare?: number } = {},
): DiarChunk[] {
  if (turns.length === 0) return [];

  // 1) 先还原成互不重叠的分区，再合并同人相邻段（顺手把短间隙吸收）
  const from = Math.max(0, Math.min(...turns.map((t) => t.start)));
  const tail = Math.max(durationSec, ...turns.map((t) => t.end));
  let seq = mergeSameSpeaker(partitionBySpeaker(turns, from, tail));

  // 2) 短促「插入语」（嗯/对）并进前一块：**只在前后同人、且前后合计够长时**才吸收。
  //    否则快速你来我往的对话（每轮都 < 1.5s）会被一路吞成一个人，这里宁可逐轮切、由下面的兜底收场。
  const kept: DiarTurn[] = [];
  for (let i = 0; i < seq.length; i++) {
    const t = seq[i];
    const prev = kept[kept.length - 1];
    const next = seq[i + 1];
    const interjection =
      t.end - t.start < ABSORB_SHORT_SEC &&
      !!prev &&
      !!next &&
      next.speaker === prev.speaker &&
      prev.end - prev.start + (next.end - next.start) >= ABSORB_MIN_NEIGHBOR_SEC;
    if (interjection) {
      prev.end = Math.max(prev.end, t.end);
      continue;
    }
    kept.push({ ...t });
  }
  // 吸收后可能出现同人相邻（前一块跨过了插入段），再合并一次，别白切一段
  seq = mergeSameSpeaker(kept);
  if (seq.length === 0) return [];

  // 3) 极小簇并进邻块（auto 模式：见 TINY_CLUSTER_SHARE_AUTO 注释）
  const share = opts.tinyClusterShare ?? 0;
  if (share > 0) seq = mergeTinyClusters(seq, share);

  // 4) 以段起点为界切块（块 k = [start_k, start_{k+1})，末块到音频末尾）
  const chunks: DiarChunk[] = [];
  for (let i = 0; i < seq.length; i++) {
    const start = seq[i].start;
    const end = i + 1 < seq.length ? Math.max(start, seq[i + 1].start) : tail;
    if (end <= start) continue;
    // 5) 超长块再切一刀（同一说话人，切开不损失归属）
    for (let s = start; s < end; s += MAX_CHUNK_SEC) {
      chunks.push({ start: s, end: Math.min(s + MAX_CHUNK_SEC, end), speaker: seq[i].speaker });
    }
  }

  // 6) 兜底：切得太碎就退回固定 60s 网格，避免几百次 STT 调用
  const total = chunks.reduce((acc, c) => acc + (c.end - c.start), 0);
  if (chunks.length > MAX_CHUNKS || (chunks.length > 0 && total / chunks.length < MIN_AVG_CHUNK_SEC)) {
    return fixedGridChunksWithSpeakers(turns, durationSec);
  }
  return chunks;
}

/**
 * 把可能重叠的说话人段还原成互不重叠的分区 [from, to)。
 * 为什么「最短覆盖优先」而不是「最长」：CLI 对真实录音会输出「一条长背景段 + 若干嵌套短段」，
 * 按最长取会把所有人并进那条背景段；取最短才回到「这段时间里谁说得更具体」。
 * 切点取所有段的起止，故边界天然落在真正的换人处。
 */
function partitionBySpeaker(turns: DiarTurn[], from: number, to: number): DiarTurn[] {
  const cuts = new Set<number>([from, to]);
  for (const t of turns) {
    if (t.end <= from || t.start >= to) continue;
    cuts.add(Math.max(t.start, from));
    cuts.add(Math.min(t.end, to));
  }
  const times = [...cuts].sort((a, b) => a - b);
  const out: DiarTurn[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const start = times[i];
    const end = times[i + 1];
    if (end - start <= 1e-6) continue;
    let best: DiarTurn | null = null;
    for (const t of turns) {
      if (t.start <= start + 1e-6 && t.end >= end - 1e-6) {
        if (!best || t.end - t.start < best.end - best.start) best = t;
      }
    }
    // 没有段覆盖 = 那段是静音，沿用前一段的说话人（与「按段起点切块、无空隙」的口径一致）
    const speaker = best ? best.speaker : out.length > 0 ? out[out.length - 1].speaker : turns[0].speaker;
    const last = out[out.length - 1];
    if (last && last.speaker === speaker && Math.abs(last.end - start) <= 1e-6) last.end = end;
    else out.push({ start, end, speaker });
  }
  return out;
}

/** 总时长不到主说话人 `share` 比例的簇判为假人，并进时间上最近的「够长」的簇 */
function mergeTinyClusters(seg: DiarTurn[], share: number): DiarTurn[] {
  const total = new Map<number, number>();
  for (const s of seg) total.set(s.speaker, (total.get(s.speaker) ?? 0) + (s.end - s.start));
  if (total.size <= 1) return seg;
  const floor = Math.max(...total.values()) * share;
  const survivors = seg.filter((s) => (total.get(s.speaker) ?? 0) >= floor);
  if (survivors.length === 0) return seg;
  return mergeSameSpeaker(
    seg.map((s) => {
      if ((total.get(s.speaker) ?? 0) >= floor) return s;
      let best = survivors[0];
      let bestDist = Infinity;
      for (const v of survivors) {
        const gap = Math.max(s.start, v.start) - Math.min(s.end, v.end);
        const dist = gap > 0 ? gap : 0;
        if (dist < bestDist) {
          bestDist = dist;
          best = v;
        }
      }
      return { ...s, speaker: best.speaker };
    }),
  );
}

/** 相邻同一说话人且间隔 < MERGE_GAP_SEC 的段合并（重叠一并吸收） */
function mergeSameSpeaker(turns: DiarTurn[]): DiarTurn[] {
  const out: DiarTurn[] = [];
  for (const t of turns) {
    const start = Math.max(0, t.start);
    const end = Math.max(start, t.end);
    const last = out[out.length - 1];
    if (last && last.speaker === t.speaker && start - last.end <= MERGE_GAP_SEC) {
      last.end = Math.max(last.end, end);
    } else {
      out.push({ start, end, speaker: t.speaker });
    }
  }
  return out;
}

/** 兜底：固定 60s 网格（与旧行为一致），每格按重叠时长取主导说话人 */
function fixedGridChunksWithSpeakers(turns: DiarTurn[], durationSec: number): DiarChunk[] {
  if (!(durationSec > 0)) return [];
  const out: DiarChunk[] = [];
  for (let s = 0; s < durationSec; s += MAX_CHUNK_SEC) {
    const end = Math.min(s + MAX_CHUNK_SEC, durationSec);
    out.push({ start: s, end, speaker: dominantSpeaker(turns, s, end) });
  }
  return out;
}

/** 与 [start,end) 重叠时长最长的那位说话人；无重叠返回 null */
function dominantSpeaker(turns: DiarTurn[], start: number, end: number): number | null {
  const overlap = new Map<number, number>();
  for (const t of turns) {
    const o = Math.min(t.end, end) - Math.max(t.start, start);
    if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
  }
  let best: number | null = null;
  let bestMs = 0;
  for (const [speaker, ms] of overlap) {
    if (ms > bestMs) { bestMs = ms; best = speaker; }
  }
  return best;
}

/**
 * 把整段切块裁剪到转写范围 [start,end)（秒）。
 * 首块回拉到窗口起点、末块拉到窗口终点，保证窗口内**无空隙**（裁剪掉的只是边界静音）。
 * range 为 null 时原样返回。
 */
/** 取与 [start, end) 重叠最长的切块说话人；完全没重叠（静音/语气词）返回 null。 */
export function speakerForRange(chunks: DiarChunk[], start: number, end: number): number | null {
  let best: number | null = null;
  let bestOverlap = 0;
  for (const c of chunks) {
    const overlap = Math.min(end, c.end) - Math.max(start, c.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = c.speaker;
    }
  }
  return bestOverlap > 0 ? best : null;
}

export function clipChunks(chunks: DiarChunk[], range: { start: number; end: number } | null): DiarChunk[] {
  if (!range) return chunks.map((c) => ({ ...c }));
  const inside = chunks
    .filter((c) => c.end > range.start && c.start < range.end)
    .map((c) => ({
      start: Math.max(c.start, range.start),
      end: Math.min(c.end, range.end),
      speaker: c.speaker,
    }));
  if (inside.length === 0) return [];
  inside[0].start = range.start;
  inside[inside.length - 1].end = range.end;
  return inside;
}

// ============================================================
// 声纹簇合并（纯函数，便于单测）
// ============================================================

/**
 * 两个簇的质心余弦比到多少就判为「同一个人」。
 *
 * 实测（本机 300s 双人录音，阈值 0.95 分出 6 簇）：
 *   - 两位真人之间 0.05~0.22（不同人）；
 *   - 被拆出来的假簇对真人 0.63~0.64（同一人）。
 * 与 speaker-lib.MATCH_THRESHOLD 同口径（同一个 3dspeaker 向量空间），且那边实测同一人 0.63~0.87、
 * 不同人 0.08~0.22，取区间中点 0.5，两侧余量最均衡。
 */
const VOICEPRINT_MERGE_SIM = 0.5;

export interface ClusterMergePlan {
  /** 原簇号 → 合并后簇号（覆盖传入的**全部**簇号，含无质心的簇） */
  remap: Map<number, number>;
  /** 合并后的簇（新簇号）；**无质心**的簇（段太短、算不出声纹）不在此列 */
  clusters: ClusterCentroid[];
  /** 是否真的发生过合并；false = remap 是恒等映射、clusters 原样，调用方无需重建切块 */
  merged: boolean;
}

/** 合并过程中的一组：成员簇号 + 各自质心/权重/置信度 */
interface MergeGroup {
  members: number[];
  entries: { vec: number[]; w: number; conf: number | null }[];
}

/** 组的代表质心 = 成员质心按说话时长加权求和后归一化（与 speaker-embed.centroidOf 同一口径） */
function groupCentroid(g: MergeGroup): number[] {
  const dim = g.entries[0]?.vec.length ?? 0;
  const out = new Array<number>(dim).fill(0);
  for (const e of g.entries) {
    if (e.vec.length !== dim) continue; // 维度不一致的成员不参与（模型换过就别硬凑）
    for (let i = 0; i < dim; i++) out[i] += e.vec[i] * e.w;
  }
  return normalizeEmbedding(out);
}

/**
 * 按声纹质心把「同一个人被拆出的多个簇」并回一个人。
 *
 * 为什么需要它：CLI 的聚类阈值只是一个标量，长录音里同一个人会因远近场/音量差异被切成几簇
 * （实测 300s 两人录音在阈值 0.9 下切出 10 簇）。而质心是「这个声音」的代表——两簇质心余弦够近
 * 就是同一个人，这比「时长占比」更直接、也更不容易误伤真人。
 *
 * 合并用**平均连接**（两组的代表质心做余弦），不用单连接：单连接会被中间桥接的簇「链式」并成一大坨。
 * 只在**真的发生合并**时重排簇号；否则原样返回（保持既有编号，不动旧口径）。
 * 无质心的簇（段太短算不出声纹）各自成组——它留给时长占比兜底清理，不在这里替它认人。
 */
export function planClusterMerge(
  clusters: ClusterCentroid[],
  allSpeakers: number[],
  durationOf: (speaker: number) => number,
  threshold = VOICEPRINT_MERGE_SIM,
): ClusterMergePlan {
  const ids = [...new Set(allSpeakers)].sort((a, b) => a - b);
  const identity = (): ClusterMergePlan => ({
    remap: new Map(ids.map((s) => [s, s])),
    clusters,
    merged: false,
  });
  if (clusters.length < 2 || !(threshold > 0)) return identity();

  let groups: MergeGroup[] = clusters.map((c) => ({
    members: [c.speaker],
    entries: [{ vec: normalizeEmbedding(c.centroid), w: Math.max(0, durationOf(c.speaker)) || 1, conf: c.confidence ?? null }],
  }));

  let merged = false;
  for (;;) {
    // 找代表质心最相近、且超过阈值的两组（平均连接）
    let bi = -1;
    let bj = -1;
    let best = -Infinity;
    for (let i = 0; i < groups.length; i++) {
      const ci = groupCentroid(groups[i]);
      for (let j = i + 1; j < groups.length; j++) {
        const sim = cosineSimilarity(ci, groupCentroid(groups[j]));
        if (sim > best) {
          best = sim;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0 || best < threshold) break;
    const a = groups[bi];
    const b = groups[bj];
    groups = groups.filter((_, i) => i !== bi && i !== bj);
    groups.push({ members: [...a.members, ...b.members], entries: [...a.entries, ...b.entries] });
    merged = true;
  }
  if (!merged) return identity();

  // 重排簇号：合并组 + 无质心簇（自成一组），按「最小成员簇号」排序后依次编号 0..n-1。
  // 无质心簇**必须**一起编号，否则它们会与重排后的新簇号撞号（两簇共用一个 id）。
  const grouped = new Set(groups.flatMap((g) => g.members));
  const unassigned = ids.filter((s) => !grouped.has(s));
  const final: { members: number[]; centroid: number[] | null; conf: number[] }[] = [
    ...groups.map((g) => ({
      members: g.members,
      centroid: groupCentroid(g),
      conf: g.entries.map((e) => e.conf).filter((c): c is number => c !== null),
    })),
    ...unassigned.map((s) => ({ members: [s], centroid: null, conf: [] as number[] })),
  ];
  final.sort((a, b) => Math.min(...a.members) - Math.min(...b.members));

  const remap = new Map<number, number>();
  final.forEach((g, i) => g.members.forEach((s) => remap.set(s, i)));

  const out: ClusterCentroid[] = [];
  final.forEach((g, i) => {
    if (!g.centroid) return; // 无质心的簇不写身份层（与 computeClusterCentroids 的口径一致）
    out.push({
      speaker: i,
      centroid: g.centroid,
      confidence: g.conf.length ? g.conf.reduce((a, b) => a + b, 0) / g.conf.length : null,
    });
  });
  return { remap, clusters: out, merged: true };
}

// ============================================================
// 缓存（.cache/diar/，与 .cache/parse/ 独立）
// ============================================================

function diarCacheDir(projectPath: string): string {
  return path.join(projectPath, '.cache', DIAR_CACHE_DIR);
}

function cacheKeyOf(hash: string, mode: DiarMode, range?: { start: number; end: number }): string {
  const suffix = range ? `-r${Math.round(range.start)}-${Math.round(range.end)}` : '';
  return `diar-${hash}-D${DIAR_VERSION}-${mode}${suffix}`;
}

interface DiarCacheRecord {
  key: string;
  duration_sec: number;
  chunks: DiarChunk[];
  /** 每簇声纹质心（身份层）；缺失/为空 = 本次没算出（如 clang 缺失），不影响切块与转写 */
  clusters?: ClusterCentroid[];
  cached_at: string;
}

async function readDiarRecord(file: string, key: string): Promise<DiarCacheRecord | null> {
  try {
    const rec = JSON.parse(await fs.readFile(file, 'utf-8')) as DiarCacheRecord;
    if (rec.key !== key || !Array.isArray(rec.chunks)) return null;
    return rec;
  } catch {
    return null;
  }
}

async function readDiarCache(file: string, key: string): Promise<DiarChunk[] | null> {
  return (await readDiarRecord(file, key))?.chunks ?? null;
}

async function writeDiarCache(file: string, rec: DiarCacheRecord): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(rec, null, 2), 'utf-8');
  void enforceDiarCacheLimit(path.dirname(file)).catch(() => {});
}

/** 容量上限：超过即按 mtime 删最旧（与 parse 缓存同思路，但独立目录、独立配额） */
async function enforceDiarCacheLimit(dir: string): Promise<void> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  if (files.length <= DIAR_CACHE_MAX_ENTRIES) return;
  const stats = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await fs.stat(path.join(dir, f))).mtimeMs })),
  );
  stats.sort((a, b) => a.mtime - b.mtime);
  await Promise.all(
    stats.slice(0, files.length - DIAR_CACHE_MAX_ENTRIES).map((s) => fs.unlink(path.join(dir, s.f)).catch(() => {})),
  );
}

/**
 * 读某录音**已缓存**的每簇声纹质心（不触发分离）——回放/认人时用：有就认人，没有就退回匿名。
 * 无缓存返回 null（区别于「缓存里有但没算出」，后者是空数组）。
 */
export async function readDiarClusters(
  audioPath: string,
  projectPath: string,
  mode: DiarMode,
): Promise<ClusterCentroid[] | null> {
  const hash = await sha256File(audioPath).catch(() => null);
  if (!hash) return null;
  const key = cacheKeyOf(hash, mode);
  const rec = await readDiarRecord(path.join(diarCacheDir(projectPath), `${key}.json`), key);
  return rec ? rec.clusters ?? [] : null;
}

// ============================================================
// 主入口
// ============================================================

// ============================================================
// 长音频分段分离（超过 LONG_DIAR_THRESHOLD_SEC 才走）
// ============================================================

interface ChunkDiarResult {
  start: number;
  end: number;
  turns: DiarTurn[];
  clusters: ClusterCentroid[];
}

/** 从已转好的 16k 单声道 wav 切一段（PCM 直接切，快且无损） */
async function sliceWav(
  ffmpegPath: string,
  srcWav: string,
  outWav: string,
  start: number,
  duration: number,
): Promise<void> {
  await execFileAsync(
    ffmpegPath,
    ['-y', '-ss', String(start), '-t', String(duration), '-i', srcWav, '-c:a', 'pcm_s16le', outWav],
    { timeout: 5 * 60 * 1000 },
  );
}

/** 单段分离：turns 用段内相对时间；clusters 的 speaker 也是段内编号 */
async function diarizeOneChunk(
  ffmpegPath: string,
  srcWav: string,
  chunkPath: string,
  start: number,
  end: number,
  mode: DiarMode,
): Promise<ChunkDiarResult> {
  const dur = end - start;
  await sliceWav(ffmpegPath, srcWav, chunkPath, start, dur);
  const { stdout, stderr } = await runDiarization(chunkPath, mode, timeoutFor(dur), undefined, LONG_DIAR_THREADS);
  const turns = parseDiarizationOutput(stdout, stderr);
  if (turns.length === 0) return { start, end, turns: [], clusters: [] };
  const chunks = buildSpeakerChunks(turns, dur, {
    tinyClusterShare: mode === 'auto' ? TINY_CLUSTER_SHARE_AUTO : 0,
  });
  const clusters = await computeClusterCentroids(chunkPath, chunks, turns, ffmpegPath);
  return { start, end, turns, clusters };
}

/** 段内簇 → 全局 speaker 号（按声纹质心做跨段对齐；duo 最多 2 人） */
function mapChunkClusters(
  local: ClusterCentroid[],
  globals: ClusterCentroid[],
  globalWeights: Map<number, number>,
  localWeights: Map<number, number>,
  mode: DiarMode,
): Map<number, number> {
  const out = new Map<number, number>();
  const sorted = [...local].sort((a, b) => a.speaker - b.speaker);
  const addGlobal = (c: ClusterCentroid): number => {
    const id = globals.length;
    globals.push({ speaker: id, centroid: c.centroid, confidence: c.confidence });
    globalWeights.set(id, localWeights.get(c.speaker) ?? 1);
    return id;
  };
  const mergeInto = (id: number, c: ClusterCentroid) => {
    const old = globals.find((g) => g.speaker === id);
    if (!old) return;
    const wOld = globalWeights.get(id) ?? 1;
    const wNew = localWeights.get(c.speaker) ?? 1;
    const total = wOld + wNew;
    old.centroid = normalizeEmbedding(old.centroid.map((v, i) => (v * wOld + c.centroid[i] * wNew) / total));
    globalWeights.set(id, total);
  };

  if (sorted.length === 0) return out;
  if (globals.length === 0) {
    sorted.forEach((c) => out.set(c.speaker, addGlobal(c)));
    return out;
  }

  const cap = mode === 'duo' ? 2 : LONG_DIAR_MAX_SPEAKERS;
  // duo 且已有两个全局人：直接比较「直配 / 交换」两种分配，取相似度和更大的那种。
  if (mode === 'duo' && globals.length >= 2 && sorted.length >= 2) {
    const a = sorted[0];
    const b = sorted[1];
    const g0 = globals[0];
    const g1 = globals[1];
    const straight = cosineSimilarity(a.centroid, g0.centroid) + cosineSimilarity(b.centroid, g1.centroid);
    const swapped = cosineSimilarity(a.centroid, g1.centroid) + cosineSimilarity(b.centroid, g0.centroid);
    const [ia, ib] = straight >= swapped ? [g0.speaker, g1.speaker] : [g1.speaker, g0.speaker];
    out.set(a.speaker, ia);
    out.set(b.speaker, ib);
    mergeInto(ia, a);
    mergeInto(ib, b);
    // duo 理论只有 2 簇；万一段内多出簇，归到最像的那个，不新增第三个人。
    for (const c of sorted.slice(2)) {
      const best = globals
        .map((g) => ({ id: g.speaker, sim: cosineSimilarity(c.centroid, g.centroid) }))
        .sort((x, y) => y.sim - x.sim)[0];
      if (best) {
        out.set(c.speaker, best.id);
        mergeInto(best.id, c);
      }
    }
    return out;
  }

  const used = new Set<number>();
  for (const c of sorted) {
    const candidates = globals
      .map((g) => ({ id: g.speaker, sim: cosineSimilarity(c.centroid, g.centroid) }))
      .sort((x, y) => y.sim - x.sim);
    const best = candidates.find((x) => !used.has(x.id)) ?? candidates[0];
    const shouldCreate =
      globals.length < cap &&
      (!best || best.sim < LONG_DIAR_MATCH_SIM) &&
      // duo 已有一个全局人、段里出现第二个不同声音：允许创建第二个；
      // 但 duo 达到 2 人后不再创建。
      !(mode === 'duo' && globals.length >= 2);
    if (shouldCreate) {
      const id = addGlobal(c);
      out.set(c.speaker, id);
      used.add(id);
    } else if (best) {
      out.set(c.speaker, best.id);
      used.add(best.id);
      mergeInto(best.id, c);
    }
  }
  return out;
}

/**
 * 长音频分段分离：返回全局 speaker 切块 + 每簇质心。
 * 每段最多重试一次；单段失败不拖垮整条（记 console.warn 后跳过），但全空则返回 null。
 */
async function runDiarizationChunked(
  wavPath: string,
  durationSec: number,
  mode: DiarMode,
  ffmpegPath: string,
  onProgress?: (pct: number) => void,
): Promise<{ chunks: DiarChunk[]; clusters: ClusterCentroid[] } | null> {
  const total = Math.max(1, Math.ceil(durationSec / LONG_DIAR_CHUNK_SEC));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-diar-long-'));
  const results: (ChunkDiarResult | null)[] = new Array(total).fill(null);
  let completed = 0;
  try {
    for (let base = 0; base < total; base += LONG_DIAR_CONCURRENCY) {
      const batch = Array.from(
        { length: Math.min(LONG_DIAR_CONCURRENCY, total - base) },
        (_, k) => base + k,
      );
      const batchResults = await Promise.all(
        batch.map(async (i) => {
          const start = i * LONG_DIAR_CHUNK_SEC;
          const end = Math.min(durationSec, start + LONG_DIAR_CHUNK_SEC);
          if (end - start < 1) return null;
          const chunkPath = path.join(tmpDir, `chunk-${i}.wav`);
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              return await diarizeOneChunk(ffmpegPath, wavPath, chunkPath, start, end, mode);
            } catch (e) {
              if (attempt === 0) continue;
              console.warn(
                `[diarize] 长音频第 ${i + 1}/${total} 段失败，跳过:`,
                e instanceof Error ? e.message : e,
              );
            }
          }
          return null;
        }),
      );
      batchResults.forEach((r, k) => { results[batch[k]] = r; });
      completed += batch.length;
      onProgress?.(Math.min(99, (completed / total) * 100));
    }

    const globals: ClusterCentroid[] = [];
    const globalWeights = new Map<number, number>();
    const turns: DiarTurn[] = [];
    for (const r of results) {
      if (!r || r.turns.length === 0 || r.clusters.length === 0) continue;
      const localWeights = new Map<number, number>();
      for (const c of r.clusters) {
        const weight = r.turns
          .filter((t) => t.speaker === c.speaker)
          .reduce((acc, t) => acc + Math.max(0, t.end - t.start), 0);
        localWeights.set(c.speaker, Math.max(weight, 1));
      }
      const map = mapChunkClusters(r.clusters, globals, globalWeights, localWeights, mode);
      for (const t of r.turns) {
        const speaker = map.get(t.speaker);
        if (speaker === undefined) continue;
        turns.push({ ...t, start: t.start + r.start, end: t.end + r.start, speaker });
      }
    }
    if (turns.length === 0) return null;

    const chunkOpts = { tinyClusterShare: mode === 'auto' ? TINY_CLUSTER_SHARE_AUTO : 0 };
    let chunks = buildSpeakerChunks(turns, durationSec, chunkOpts);
    if (chunks.length === 0) return null;
    let clusters = globals;
    if (mode === 'auto') {
      const durationBySpeaker = new Map<number, number>();
      for (const c of chunks) {
        if (c.speaker === null) continue;
        durationBySpeaker.set(c.speaker, (durationBySpeaker.get(c.speaker) ?? 0) + (c.end - c.start));
      }
      const plan = planClusterMerge(clusters, [...new Set(turns.map((t) => t.speaker))], (s) => durationBySpeaker.get(s) ?? 0);
      if (plan.merged) {
        for (const t of turns) t.speaker = plan.remap.get(t.speaker) ?? t.speaker;
        chunks = buildSpeakerChunks(turns, durationSec, chunkOpts);
        if (chunks.length === 0) return null;
        const kept = new Set(chunks.map((c) => c.speaker).filter((s): s is number => s !== null));
        clusters = plan.clusters.filter((c) => kept.has(c.speaker));
      }
    }
    return { chunks, clusters };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 同 key 的分离只跑一次：import_probe 与紧随其后的首个 import_segment 会并发到达 */
const inFlight = new Map<string, Promise<DiarChunk[] | null>>();

async function sha256File(filePath: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

/**
 * 每个说话人簇的声纹质心：挑该簇几段最长的块，切出来提声纹向量再平均。
 * 为什么挑「最长」而不是全部：一段录音可能有几百块，全算既慢又没必要；短段声纹噪声大，故设最短时长门槛。
 * **失败不抛**（返回 []）：身份层是增强项，clang 缺失/模型未就绪都不该让整场转写失败。
 */
async function computeClusterCentroids(
  wavPath: string,
  chunks: DiarChunk[],
  turns: DiarTurn[],
  ffmpegPath: string,
): Promise<ClusterCentroid[]> {
  const bySpeaker = new Map<number, DiarChunk[]>();
  for (const c of chunks) {
    if (c.speaker === null) continue;
    const list = bySpeaker.get(c.speaker);
    if (list) list.push(c);
    else bySpeaker.set(c.speaker, [c]);
  }
  if (bySpeaker.size === 0) return [];

  // 每簇的聚类置信度均值（本轮不展示也要存着，回放时才有数可给）
  const confBySpeaker = new Map<number, number[]>();
  for (const t of turns) {
    if (t.confidence === undefined) continue;
    const list = confBySpeaker.get(t.speaker);
    if (list) list.push(t.confidence);
    else confBySpeaker.set(t.speaker, [t.confidence]);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-spk-'));
  try {
    const jobs: { speaker: number; wav: string }[] = [];
    for (const [speaker, list] of bySpeaker) {
      const picked = list
        .map((c) => ({ c, dur: c.end - c.start }))
        .filter((x) => x.dur >= MIN_CENTROID_SEC)
        .sort((a, b) => b.dur - a.dur)
        .slice(0, MAX_CENTROID_SLICES);
      for (let i = 0; i < picked.length; i++) {
        const out = path.join(tmpDir, `s${speaker}-${i}.wav`);
        const { c } = picked[i];
        try {
          await execFileAsync(
            ffmpegPath,
            ['-y', '-ss', String(c.start), '-t', String(c.end - c.start), '-i', wavPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out],
            { timeout: 60_000 },
          );
          jobs.push({ speaker, wav: out });
        } catch {
          /* 单段切失败就跳过，别的段仍可撑起质心 */
        }
      }
    }
    if (jobs.length === 0) return [];

    const vecs = await embedWavs(jobs.map((j) => j.wav));
    const grouped = new Map<number, number[][]>();
    for (let i = 0; i < jobs.length; i++) {
      const v = vecs[i];
      if (!v) continue;
      const list = grouped.get(jobs[i].speaker);
      if (list) list.push(v);
      else grouped.set(jobs[i].speaker, [v]);
    }
    const out: ClusterCentroid[] = [];
    for (const [speaker, list] of grouped) {
      const centroid = centroidOf(list);
      if (!centroid) continue;
      const confs = confBySpeaker.get(speaker) ?? [];
      const confidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
      out.push({ speaker, centroid, confidence });
    }
    return out.sort((a, b) => a.speaker - b.speaker);
  } catch (e) {
    console.warn('[diarize] 声纹质心提取失败（仅影响跨录音认人）:', e instanceof Error ? e.message : e);
    return [];
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 整段音频做一次说话人分离（带缓存与并发去重）。
 * 返回整段切块列表；**不可用或失败一律返回 null**（调用方据此退回固定 60s 无标签链路，绝不阻断转写）。
 *
 * @param deps.onProgress CLI 报的 `progress xx%`（0~100）。长录音这一步要跑几分钟到二十几分钟，
 *   HTTP 侧据此把进度推给客户端；命中缓存时不回调（缓存即秒回，没有等待可言）。
 */
export async function ensureDiarization(
  audioPath: string,
  projectPath: string,
  mode: DiarMode,
  deps: {
    ffmpegPath: string;
    onProgress?: (pct: number) => void;
    /** 只分离这一段（源时间轴秒）；不传 = 整段。用于「稿子只覆盖前 62 分钟」时避免分离 3.6 小时 */
    range?: { start: number; end: number };
  },
): Promise<DiarChunk[] | null> {
  if (!(await isDiarizationAvailable())) return null;

  const hash = await sha256File(audioPath);
  const range = deps.range && deps.range.end - deps.range.start >= 1 ? deps.range : undefined;
  const key = cacheKeyOf(hash, mode, range);
  const file = path.join(diarCacheDir(projectPath), `${key}.json`);

  const cached = await readDiarCache(file, key);
  if (cached) return cached;

  const running = inFlight.get(key);
  if (running) return running;

  const task = (async (): Promise<DiarChunk[] | null> => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-diar-'));
    const wavPath = path.join(tmpDir, 'audio.wav');
    const offset = range?.start ?? 0;
    const shiftChunks = (list: DiarChunk[]): DiarChunk[] =>
      offset === 0 ? list : list.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }));
    try {
      const ffArgs = ['-y'];
      if (range) ffArgs.push('-ss', String(range.start), '-t', String(range.end - range.start));
      ffArgs.push('-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath);
      await execFileAsync(deps.ffmpegPath, ffArgs, { timeout: 5 * 60 * 1000 });
      const durationSec = await probeWavDurationSec(deps.ffmpegPath, wavPath);
      // 长音频：分段跑 + 跨段声纹对齐。整段 pyannote 在 1h+ 会逼近 30min 超时且没有进度；
      // 分段后每段独立聚类，再用质心把同一人接回同一个全局 speaker id。
      if (durationSec !== null && durationSec >= LONG_DIAR_THRESHOLD_SEC) {
        const long = await runDiarizationChunked(
          wavPath,
          durationSec,
          mode,
          deps.ffmpegPath,
          deps.onProgress,
        );
        if (!long) return null;
        const shifted = shiftChunks(long.chunks);
        await writeDiarCache(file, {
          key,
          duration_sec: durationSec,
          chunks: shifted,
          clusters: long.clusters,
          cached_at: new Date().toISOString(),
        });
        console.info(
          `[diarize] 长音频分段完成：${Math.ceil(durationSec / LONG_DIAR_CHUNK_SEC)} 段，` +
            `clusters=${long.clusters.length} chunks=${shifted.length} mode=${mode}` +
            (range ? ` range=${Math.round(range.start)}-${Math.round(range.end)}` : ''),
        );
        return shifted;
      }
      const { stdout, stderr } = await runDiarization(wavPath, mode, timeoutFor(durationSec), deps.onProgress);
      let turns = parseDiarizationOutput(stdout, stderr);
      if (turns.length === 0) {
        console.warn('[diarize] 分离未产出任何段，退回无标签链路');
        return null;
      }
      const duration = durationSec ?? turns[turns.length - 1].end;
      const chunkOpts = { tinyClusterShare: mode === 'auto' ? TINY_CLUSTER_SHARE_AUTO : 0 };
      let chunks = buildSpeakerChunks(turns, duration, chunkOpts);
      if (chunks.length === 0) return null;

      // 每簇声纹质心（身份层）：回放/认人时只读缓存，不再回头重跑分离。
      // 顺带用它做「同一人被拆出的多个簇」的合并（比时长占比更直接，见 planClusterMerge）。
      let clusters = await computeClusterCentroids(wavPath, chunks, turns, deps.ffmpegPath);
      const allSpeakers = [...new Set(turns.map((t) => t.speaker))];
      const durationBySpeaker = new Map<number, number>();
      for (const c of chunks) {
        if (c.speaker === null) continue;
        durationBySpeaker.set(c.speaker, (durationBySpeaker.get(c.speaker) ?? 0) + (c.end - c.start));
      }
      /**
       * 声纹合并只在 auto 下做。duo / group 是用户**明确声明人数**的模式：
       * CLI 已按 `--clustering.num-clusters=2`（duo）或更松的阈值（group）给出簇，
       * 这里再按 0.5 的余弦合并，会把同性别、同电话音色的两位真人并回一个人 ——
       * 用户选了「2 人」却还是拿到一份无标签稿，就是这么来的。
       */
      const plan =
        mode === 'auto'
          ? planClusterMerge(clusters, allSpeakers, (s) => durationBySpeaker.get(s) ?? 0)
          : {
              merged: false,
              remap: new Map(allSpeakers.map((s) => [s, s])),
              clusters,
            };
      if (plan.merged) {
        turns = turns.map((t) => ({ ...t, speaker: plan.remap.get(t.speaker) ?? t.speaker }));
        chunks = buildSpeakerChunks(turns, duration, chunkOpts);
        if (chunks.length === 0) return null;
        // 重建时极小簇兜底可能又并掉几簇 → 身份层只保留最终切块里真实存在的簇（避免名单出现幽灵 Speaker）
        const kept = new Set(chunks.map((c) => c.speaker).filter((s): s is number => s !== null));
        clusters = plan.clusters.filter((c) => kept.has(c.speaker));
        console.info(
          `[diarize] 声纹合并后：簇 ${allSpeakers.length} → ${new Set(turns.map((t) => t.speaker)).size}`,
        );
      }
      console.info(
        `[diarize] mode=${mode} clusters=${new Set(turns.map((t) => t.speaker)).size} turns=${turns.length} chunks=${chunks.length}`,
      );
      const shifted = shiftChunks(chunks);
      await writeDiarCache(file, {
        key,
        duration_sec: durationSec ?? 0,
        chunks: shifted,
        clusters,
        cached_at: new Date().toISOString(),
      });
      return shifted;
    } catch (e) {
      // 分离是增强项：失败只留痕，不写缓存（否则模型就绪后会一直命中失败态）
      console.warn('[diarize] 说话人分离失败，退回无标签链路:', e instanceof Error ? e.message : e);
      return null;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

/** 探测 wav 时长（秒）；失败返回 null */
async function probeWavDurationSec(ffmpegPath: string, wavPath: string): Promise<number | null> {
  const parse = (stderr: string): number | null => {
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms / 1000;
  };
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ['-i', wavPath], { timeout: 15_000 });
    return parse(stderr);
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr;
    return stderr ? parse(stderr) : null;
  }
}
