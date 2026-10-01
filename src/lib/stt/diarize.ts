/**
 * lib/stt/diarize.ts — 本地离线说话人分离（sherpa-onnx-offline-speaker-diarization）
 *
 * 定位：给「导入录音」的整段音频标出「谁在什么时候说」，供 parseAudio 按说话人切块转写，
 * 从而在会议记录里产出 `[说话人 N]` 分块。全程本地、音频不出网。
 *
 * 为什么对**整段**音频只分离一次（而不是每 25 分钟窗口各跑一次）：
 * 声纹聚类是全局的——分窗口独立聚类会让「第 2 个窗口的说话人 1」与「第 1 个窗口的说话人 1」
 * 变成两个人，编号必须全局一致。故整段跑一次、结果缓存、各窗口从缓存里切片。
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
import { centroidOf, embedWavs } from '@/lib/stt/speaker-embed';

const execFileAsync = promisify(execFile);

/** 分离模型固定用注册表里这一条（能力位 diarizes） */
const MODEL_ID = 'diarize-pyannote-3dspeaker';

/** 切块/聚类参数一变就 +1：缓存键带着它，旧结果自动失效（不需要用户手动清缓存） */
// v3：开启 compute-confidence 并缓存每簇声纹质心（跨录音认人的身份层）；旧缓存缺这两项，故 +1
export const DIAR_VERSION = 3;

// 聚类阈值（CLI help：larger → fewer clusters）
// 实测（本机两段真实录音 76.5s / 166.1s）：0.6 会把 2-3 人的对话切成 17 / 19 簇，
// 0.9 起「只说了零点几秒」的假簇基本消失（→ 4 / 3 簇），再往上 0.95/0.97 不再变化。
const THRESHOLD_AUTO = 0.9; // auto：默认口径，压掉假簇又不至于把真人并掉
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
): Promise<{ stdout: string; stderr: string }> {
  const def = findLocalModel(MODEL_ID);
  if (!def || !isDiarizationModel(def)) {
    throw new Error(`Speaker diarization model is missing from the registry: ${MODEL_ID}`);
  }
  const dir = sherpaModelDir(def.id);
  const args = [
    `--segmentation.pyannote-model=${path.join(dir, def.segmentationFile)}`,
    `--embedding.model=${path.join(dir, def.embeddingFile)}`,
    // 两个模型默认都只用 1 线程，显式提到 2：这一步在导入流程里是同步等待，别白白翻倍
    '--segmentation.num-threads=2',
    '--embedding.num-threads=2',
    '--min-duration-on=0.3',
    '--min-duration-off=0.5',
    ...clusteringArgs(mode),
    wavPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(sherpaDiarizationBinaryPath(), args, {
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: [sherpaLibDir(), process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':'),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Speaker diarization timed out (${Math.round(timeoutMs / 1000)}s).`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
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
// 缓存（.cache/diar/，与 .cache/parse/ 独立）
// ============================================================

function diarCacheDir(projectPath: string): string {
  return path.join(projectPath, '.cache', DIAR_CACHE_DIR);
}

function cacheKeyOf(hash: string, mode: DiarMode): string {
  return `diar-${hash}-D${DIAR_VERSION}-${mode}`;
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
 */
export async function ensureDiarization(
  audioPath: string,
  projectPath: string,
  mode: DiarMode,
  deps: { ffmpegPath: string },
): Promise<DiarChunk[] | null> {
  if (!(await isDiarizationAvailable())) return null;

  const hash = await sha256File(audioPath);
  const key = cacheKeyOf(hash, mode);
  const file = path.join(diarCacheDir(projectPath), `${key}.json`);

  const cached = await readDiarCache(file, key);
  if (cached) return cached;

  const running = inFlight.get(key);
  if (running) return running;

  const task = (async (): Promise<DiarChunk[] | null> => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-diar-'));
    const wavPath = path.join(tmpDir, 'audio.wav');
    try {
      await execFileAsync(
        deps.ffmpegPath,
        ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
        { timeout: 5 * 60 * 1000 },
      );
      const durationSec = await probeWavDurationSec(deps.ffmpegPath, wavPath);
      const { stdout, stderr } = await runDiarization(wavPath, mode, timeoutFor(durationSec));
      const turns = parseDiarizationOutput(stdout, stderr);
      if (turns.length === 0) {
        console.warn('[diarize] 分离未产出任何段，退回无标签链路');
        return null;
      }
      const chunks = buildSpeakerChunks(turns, durationSec ?? turns[turns.length - 1].end, {
        tinyClusterShare: mode === 'auto' ? TINY_CLUSTER_SHARE_AUTO : 0,
      });
      if (chunks.length === 0) return null;
      console.info(
        `[diarize] mode=${mode} clusters=${new Set(turns.map((t) => t.speaker)).size} turns=${turns.length} chunks=${chunks.length}`,
      );
      // 每簇声纹质心（身份层）：同在这一步算好，回放/认人时只读缓存，不再回头重跑分离
      const clusters = await computeClusterCentroids(wavPath, chunks, turns, deps.ffmpegPath);
      await writeDiarCache(file, {
        key,
        duration_sec: durationSec ?? 0,
        chunks,
        clusters,
        cached_at: new Date().toISOString(),
      });
      return chunks;
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
