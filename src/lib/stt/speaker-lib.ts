/**
 * lib/stt/speaker-lib.ts — 声纹库（跨录音认出同一个人）
 *
 * 定位：说话人分离只给「这一场里有几个声音」，编号每场重排、无法命名、跨录音对不上。
 * 本模块把「用户给某个声音起的名字 + 那个声音的声纹质心」攒成一份**项目级**的小库，
 * 于是下一场录音里，同一个人的一段语音就能被认出来、直接显示成人名。
 *
 * 落盘 `<project>/.speakers/lib.json`（**不放** `.cache/`：cache 有 LRU 与 30 天 TTL 清理，
 * 会把库当普通缓存删掉；库是用户资产，必须与缓存解耦）。
 *
 * 作用域是项目：只在本项目的录音之间认人。换个项目 = 换个库，互不串味。
 *
 * 为什么不直接存多段向量：一次命名只贡献一个质心——质心已经是「这个声音」的代表，
 * 存多段既膨胀又无必要。同名再次命名时按段数加权平均，用得越多越准（见 upsertSpeaker）。
 *
 * 匹配：余弦相似度，阈值见 MATCH_THRESHOLD（实测同一人 0.63~0.87、不同人 0.08~0.22）。
 * 认不出（低于阈值 / 库里没有）就返回 null——调用方退回匿名「Speaker N」，绝不硬认。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EMBEDDING_DIM, cosineSimilarity, normalizeEmbedding } from '@/lib/stt/speaker-embed';

/** 库格式版本：结构变化时 +1，读到不认识的版本按空库处理（宁可重来也不误认） */
export const LIB_VERSION = 1;

/**
 * 认人阈值：实测同一人 ≥0.63、不同人 ≤0.22，取区间中点 0.5，两侧余量最均衡。
 * 调高（更严）→ 更少误认、更容易认不出；调低反之。
 */
export const MATCH_THRESHOLD = 0.5;

/** 库里的一位说话人：名字 + 声纹质心 + 出现次数（用于加权平均） */
export interface SpeakerRecord {
  id: string;
  name: string;
  centroid: number[];
  count: number;
  updatedAt: string;
}

export interface SpeakerLibrary {
  version: number;
  speakers: SpeakerRecord[];
}

/** 匹配结果：命中的库成员 + 相似度 */
export interface ClusterMatch {
  id: string;
  name: string;
  similarity: number;
}

export function emptyLibrary(): SpeakerLibrary {
  return { version: LIB_VERSION, speakers: [] };
}

/**
 * 解析库文件：**容错**——任何一条坏记录（名字空 / 维度不对 / 数值非有限）都跳过，
 * 而不是让整库作废。坏一条顶多少认一个人，坏整库会让用户所有命名消失。
 */
export function parseLibrary(text: string): SpeakerLibrary {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyLibrary();
  }
  const rec = raw as { speakers?: unknown };
  const list = Array.isArray(rec?.speakers) ? rec.speakers : [];
  const speakers: SpeakerRecord[] = [];
  for (const s of list) {
    const r = s as Partial<SpeakerRecord>;
    if (typeof r?.name !== 'string' || !r.name.trim()) continue;
    if (!Array.isArray(r.centroid) || r.centroid.length !== EMBEDDING_DIM) continue;
    const centroid = r.centroid.map(Number);
    if (centroid.some((x) => !Number.isFinite(x))) continue;
    speakers.push({
      id: typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID(),
      name: r.name.trim(),
      centroid,
      count: Number.isInteger(r.count) && (r.count as number) > 0 ? (r.count as number) : 1,
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
    });
  }
  return { version: LIB_VERSION, speakers };
}

/** 项目级库文件路径 */
export function libraryPath(projectPath: string): string {
  return path.join(projectPath, '.speakers', 'lib.json');
}

/** 读库；文件不存在或读坏一律当空库（认人失败是软失败，不该抛给调用方） */
export async function readSpeakerLibrary(projectPath: string): Promise<SpeakerLibrary> {
  try {
    return parseLibrary(await fs.readFile(libraryPath(projectPath), 'utf-8'));
  } catch {
    return emptyLibrary();
  }
}

/** 写库（原子落位：先写临时文件再 rename，避免半截 JSON 覆盖掉好库） */
export async function writeSpeakerLibrary(projectPath: string, lib: SpeakerLibrary): Promise<void> {
  const file = libraryPath(projectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(lib, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/**
 * 在一簇声纹里找最像的库成员。都低于阈值 → null（调用方退回匿名）。
 * 维度不符的输入直接判不中，避免拿错模型的向量去比。
 */
export function matchCluster(
  centroid: number[],
  lib: SpeakerLibrary,
  threshold: number = MATCH_THRESHOLD,
): ClusterMatch | null {
  if (!Array.isArray(centroid) || centroid.length !== EMBEDDING_DIM) return null;
  let best: ClusterMatch | null = null;
  for (const s of lib.speakers) {
    const sim = cosineSimilarity(centroid, s.centroid);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { id: s.id, name: s.name, similarity: sim };
    }
  }
  return best;
}

/**
 * 给某个簇命名：库里已有同名 → 把新质心按段数加权并进旧质心（用得越多越准）；
 * 否则新增一条。名字前后空白一律裁掉。返回新库（不改原对象）。
 */
export function upsertSpeaker(lib: SpeakerLibrary, name: string, centroid: number[]): SpeakerLibrary {
  const clean = name.trim();
  if (!clean || centroid.length !== EMBEDDING_DIM) return lib;
  const unit = normalizeEmbedding(centroid);
  const now = new Date().toISOString();
  const speakers = [...lib.speakers];
  const idx = speakers.findIndex((s) => s.name === clean);
  if (idx >= 0) {
    const prev = speakers[idx];
    const total = prev.count + 1;
    const merged = prev.centroid.map((x, i) => (x * prev.count + unit[i]) / total);
    speakers[idx] = { ...prev, centroid: normalizeEmbedding(merged), count: total, updatedAt: now };
  } else {
    speakers.push({ id: crypto.randomUUID(), name: clean, centroid: unit, count: 1, updatedAt: now });
  }
  return { version: LIB_VERSION, speakers };
}